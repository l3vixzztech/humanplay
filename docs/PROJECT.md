# humanplay — Project

Human-like chess move assistant: a Chrome MV3 extension that reads the live
**chess.com** game state from the page DOM and asks a **local** Maia-3 helper
server for the move a strong human (~2400 Elo) would play. Not Stockfish, not
any top engine — the point is to play like (and be predicted by) a strong human.

## Architecture

```
┌───────────────────────────────┐        ┌──────────────────────────────────────┐
│ Chrome MV3 extension          │  HTTP  │ Local Python helper server           │
│                               │  JSON  │ 127.0.0.1:8765 (FastAPI)             │
│ content script on chess.com   │        │                                      │
│  └─ DOM adapter               │ ─────► │  POST /analyze {fen, moves?, …}      │
│     pieces → board field      │        │        │                             │
│     move list → SAN → UCI     │        │        ▼                             │
│     → GameState message       │ ◄───── │  maia_engine.py                      │
│ side panel: suggestion card   │        │   └─ Maia3-5M (torch, CPU)           │
│  (M4: top-3 + WDL + Elo)      │        │        AGPL-3.0, separate venv       │
│ arrow overlay (M5) · TTS (M6) │        │                                      │
│ debug: capture + PNG recorder │        │                                      │
└───────────────────────────────┘        └──────────────────────────────────────┘
     DOM only (chess.com only)                 separate process / venv boundary
```

## Locked decisions

- **Scope: chess.com only** (`https://www.chess.com/*` and `https://chess.com/*`).
  The extension reads the game state **from the DOM** via a content script
  (`extension/src/content/chesscom-adapter.js`, registered `document_idle`).
  The content script reports state only — it never analyses.
- **Pixels are parked.** The pixel board locator (and the planned classifier /
  tracker milestones) are cancelled as product work: chess.com's DOM gives the
  exact position *and* the full move list, which the pixel pipeline would only
  have approximated. The stopped work lives in `parked/image-recognition/`
  (documented, revivable); the **capture-source abstraction and the PNG
  recorder stay as debug tools**. Neither is on the product path.
- **Source-of-truth rules.** The board DOM is the source of truth for the
  **position**; chess.com's move list is the source of truth for the
  **history**. The history is replayed SAN-by-SAN with the vendored chess.js
  from the initial position, which reconstructs *exactly* what the board alone
  cannot: castling rights, the en-passant square, the halfmove clock and the
  fullmove number — and it validates every move. If board and history disagree,
  the adapter sets a `mismatch` flag and falls back to board + no history.
  Nothing is guessed silently (degraded states are flagged in `warnings`).
- **Full move history comes from chess.com's own move list.** This is a free
  upgrade over the pixel plan: the `/analyze` request can carry the exact UCI
  history, so Maia's history planes see the real game, not a reconstruction.
- **Model**: Maia-3 5M params — repo <https://github.com/CSSLab/maia3>, weights
  `UofTCSSLab/Maia3-5M` on Hugging Face. **AGPL-3.0**: it runs as a separate
  local process/venv; its code is never copied into the extension.
- **Server**: FastAPI on `127.0.0.1:8765`; the extension talks to it over HTTP.
- **Default Elo**: self 2400, opponent 2400 ("strong human" preset), adjustable
  0–5000 (Maia-3's Elo range).
- **Permissions stay narrow**: no `<all_urls>` anywhere in the shipped manifest.
  `content_scripts`/`web_accessible_resources` match only chess.com; the only
  host permission is `http://127.0.0.1:8765/*` (`/health`, later `/analyze`);
  tab capture stays on `activeTab` (the toolbar click is what grants it —
  Chromium `CanCaptureVisiblePage`, `kActiveTabOrAllUrls`).
- **Vendored chess.js** (BSD-2-Clause, pinned **1.4.0**,
  `extension/vendor/chess.js`) — the only third-party runtime dependency, used
  for SAN → UCI/Castling/En-passant replay. See `extension/vendor/README.md`.
- **UI** (roadmap): arrow overlay drawn on the real board (M5) + side panel with
  top-3 moves and probabilities; TTS via `chrome.tts` (Piper-ready interface)
  announcing "just the move" (M6).
- **Fair play**: the user accepts the ban risk for live play. We do **not**
  build any anti-detection features.
- **No Stockfish / top engines anywhere** in this project.

## Roadmap

| # | Milestone | Content | Status |
|---|-----------|---------|--------|
| 1 | Scaffold + Maia-3 helper server | repo scaffold, docs, venv, `maia_engine.predict`, FastAPI `/analyze` + `/health`, tests incl. `maia3-uci` golden check | ✅ done |
| 2 | Extension skeleton + tab capture + offline fixtures | MV3 manifest, capture-source interface (locked), side panel (toggle/capture/recorder/chip), offline fixture pages + captured PNG evidence | ✅ done |
| 3 | chess.com DOM adapter + state protocol + fixtures | content script (board detection, multi-strategy position reading, move-list SAN → UCI replay, flip/color detection, mismatch policy), GameState protocol, panel state card, snapshot recorder, adapter proof harness + unit tests | ✅ done |
| 4 | End-to-end analysis loop | `src/analysis/analyze-client.js` (timeout, single network retry, position-key LRU cache + dedupe, stale guard, request builder, gating), panel "Maia suggestion" card (top-3 + bar + % + WDL + perspective + meta) and "Elo" card, canned `/analyze` in the fixture server, unit tests + stub/real CDP proofs | ✅ done |
| 5 | Arrow overlay on the real board | draw the best move on the chess.com board using `boardRect` + devicePixelRatio (overlay lives in the content script or as an extension overlay page) | ⬜ |
| 6 | TTS | `chrome.tts` announcements (Piper-ready interface), "just the move" | ⬜ |
| 7 | Premove planner | precompute replies for the opponent's likely moves (from Maia's distribution) while they think | ⬜ |
| 8 | Live commentary / explain mode | short natural-language "why this move" from the model's probabilities | ⬜ |
| 9 | Continuous mode + robustness + polish + packaging | state-driven auto-analysis loop, failure recovery (page variants), UX, store-ready packaging | ⬜ |

## The GameState protocol (M3)

The content script computes the state and broadcasts it on every change
(debounced 150 ms; also once on load, and on request from the panel):

| Direction | Message | Payload |
|---|---|---|
| content → extension | `humanplay:chesscom-state` | `{ type, state: GameState }` (broadcast; `sender.tab` tells which tab) |
| panel → content | `humanplay:get-state` | `{ ok, state }` |
| panel → content | `humanplay:record-snapshot` | `{ ok, name, snapshot }` (sanitized JSON for the fixture corpus) |

```js
GameState = {
  ok, fen, movesUci: [uci], userColor: "white"|"black"|null, flipped,
  boardRect: {x, y, w, h},     // 8x8 play area, viewport CSS pixels + devicePixelRatio
  devicePixelRatio, gameUrl, gameId, ts, mismatch?,   // contract fields
  boardId, boardTag, boardInViewport, turn, moveCount,      // adapter detail
  positionSource, historySource, historyStatus,             // which strategy won
  flippedSource, userColorSource, warnings[], strategyLog[],
  boardStateAgrees, sessionSeq, resetDetected, adapterVersion,
}
```

Reading rules (implemented in `chesscom-adapter.js`, verified against live
chess.com on 2026-10-16 — probes documented in `test/fixtures/chesscom/README.md`):

- **Board**: largest displayed candidate among `wc-chess-board`, `#board-single`,
  `#board-play-computer`, `#board-analysis-board`, `.board`.
- **Position**: (1) `.piece` elements carrying `square-XY` classes (X = file
  digit, Y = rank digit, absolute under flipping), (2) per-square containers
  with piece children, (3) the FEN the board element exposes
  (`<wc-chess-board>.game.getFEN()`, validated, fallback/cross-check only).
  Every strategy is verified by a placement plausibility check (one king per
  side, pawns not on rank 1/8, no duplicates, piece counts).
- **History**: move-list nodes (`.node` in `wc-simple-move-list` /
  `wc-vertical-move-list` variants), timestamps excluded, ordered by
  `data-node` ply; SAN tokens are cleaned and replayed with chess.js (also the
  last-resort fallback `board.game.getHistorySANs()`).
- **Flip / color**: `wc-chess-board.flipped` class (verified) and
  `board.state.isFlipped`; user color = bottom player's
  `clock-white`/`clock-black` token, then `getPlayingAs()`, then the panel
  setting (`settings.userColor`), then flipped inference. The cosmetic
  `cc-user-block-white` theme class is explicitly ignored (it appears on both
  players on the real site).
- **New game/reset** is detected (move list back to start / URL change) and
  reported via `sessionSeq` + `resetDetected`.

## The analysis loop (M4)

`extension/src/analysis/analyze-client.js` is the extension's only HTTP client
for the helper server (clean-room, no maia3 code). The side panel renders what
it returns; the unit tests exercise it with an injected `fetch`.

**Request mapping.** The adapter's `fen` is the *current* position and
`movesUci` the *full* history, but `/analyze` takes a BASE position plus moves
on top of it (`position fen <base> moves …` semantics). So:

| Adapter state | Request |
|---|---|
| `historyStatus: "replayed"`, ≥ 1 move, no mismatch | `{fen: <standard start position>, moves: <full UCI history>}` → Maia's history planes see the real game |
| adapter `mismatch` (board ≠ move list) | `{fen: <board FEN>, moves: []}` + the mismatch warning in the card |
| no usable history (absent/unreliable/empty) | `{fen: <board FEN>, moves: []}` |
| always | `elo_self`/`elo_oppo` (settings, 0–5000, default 2400, clamped), `top_k: 3` |

**Fetch semantics.** 4 s timeout via `AbortController`; **exactly one retry on
a network failure** (connection refused/dropped); never a retry on 4xx/5xx or on
a timeout. Every outcome is a result object
`{ok, status, data, roundTripMs, error, errorClass, attempts, attemptLog}` with
the error classes `offline` / `timeout` / `invalid_input` (400, 422) /
`engine_unavailable` (503) / `http` / `bad_response`.

**Cache + stale guard.** Position key =
`fen|moves|elo_self|elo_oppo|top_k`. Identical keys are answered from a small
LRU (24) — re-emitted states never re-request — and concurrent identical
requests are shared (in-flight dedupe). Failures are never cached. A new game
(`sessionSeq` change) clears the cache. Every request carries its key and the
client tracks the current one (also via `expectKey()` when the policy does not
request, e.g. on the opponent's turn): a response whose key is no longer
current comes back `stale: true` and the panel **discards it silently** — a new
position always wins over an older, slower response.

**Gating policy** (`analysisGate`): auto-analyze iff assistant toggle on **and**
adapter state ok **and** `userColor` known **and** `turn === userColor`;
otherwise `waiting` / `no-color` / `off` / `no-state`. "Analyze now" works
whenever a state is known and forces a fresh request.

**Panel states**: `idle`, `analyzing…`, `suggestion ready` (top-3 rows + WDL),
`waiting`, `game over` (server answers `moves: []` + rules-decided WDL),
`server offline` (actionable: the uvicorn command), `invalid input` (server
detail), `engine unavailable`. The meta line carries the model, engine
`elapsed_ms`, round-trip ms, the history used (`14 moves · replayed`), the
UI latency and `cached` when applicable. WDL is the server's side-to-move
quantity: labelled "(you)" for auto analyses, flipped win↔loss and labelled
"opponent's perspective" for manual analyses on the opponent's turn, with a
tooltip that it is Maia's human value head and **not** an engine evaluation.

**Proving it.** `test/tools/analyze-proof.mjs` (CDP, manifest-variant like the
M3 proof) runs STUB mode against `test/tools/fixture_server.py` (canned
responses recorded from the real server — `test/tools/collect-canned.py`) and
REAL mode against the running Maia server, where the panel's top-3 must equal a
direct `curl /analyze` for the same FEN + history. Evidence:
`test/fixtures/captures/analyze/`.

## Repository layout

```
server/     FastAPI helper + Maia-3 engine wrapper + tests  (this repo's engine lives here)
extension/  Chrome MV3 extension (content script, capture source, service worker, side panel, vendor/)
docs/       PROJECT.md (this file), HANDOFF.md (state log)
test/       offline fixtures (test/fixtures/) + dev/test tools (test/tools/)
parked/     stopped work kept for revival (parked/image-recognition/)
```

## Key interfaces (server)

- `POST http://127.0.0.1:8765/analyze`
  body `{fen, moves?, elo_self?, elo_oppo?, top_k?}` →
  `{moves: [{uci, san, prob}], wdl: {win, draw, loss}, model, elapsed_ms}`.
  `wdl` is from the **side-to-move** perspective of the analyzed position.
  `moves` is the exact UCI history (what M3's move-list replay provides).
  A finished game answers `moves: []` + a rules-decided WDL.
- `GET /health` → `{status, model}`.

Details, semantics (history planes, temperature, WDL perspective) and exact
commands: `server/README.md`. Extension-side details (adapter architecture, the
analysis client, the snapshot recorder, the proofs): `extension/README.md`.
Test tooling (fixture server with canned `/analyze` + `/debug/*` test routes,
proof harnesses): `test/README.md`.

## Licensing / boundaries

- `server/` imports the AGPL-3.0 `maia3` package (installed from GitHub into
  `server/.venv`); no maia3 source is vendored or copied.
- The extension must never contain maia3 code or any code from `server/`; it is
  a clean-room HTTP client. This keeps the AGPL boundary at the process level.
- The extension vendors exactly one third-party runtime file: chess.js
  (BSD-2-Clause, pinned 1.4.0) for rules-accurate SAN replay — see
  `extension/vendor/README.md`.

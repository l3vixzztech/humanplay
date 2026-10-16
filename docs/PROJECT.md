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
│ arrow overlay (M5)            │        │                                      │
│ voice "just the move" (M6)    │        │  POST /premove {fen, moves?, …}      │
│ premove planner (M7)          │ ─────► │   └─ criteria engine (same Maia)     │
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
  host permission is `http://127.0.0.1:8765/*` (`/health`, `/analyze`,
  `/premove`, …); tab capture stays on
  `activeTab` (the toolbar click is what grants it —
  Chromium `CanCaptureVisiblePage`, `kActiveTabOrAllUrls`). M6 added exactly
  two things: the `tts` permission and the `toggle-tts` command (Ctrl+Shift+Y).
  **M7 added none** (the premove planner reuses the existing host permission and
  the M6 speaker).
- **Vendored chess.js** (BSD-2-Clause, pinned **1.4.0**,
  `extension/vendor/chess.js`) — the only third-party runtime dependency, used
  for SAN → UCI/Castling/En-passant replay. See `extension/vendor/README.md`.
- **UI**: the top-1 move is drawn as an **arrow on the real board** (M5; top-3
  alternatives optional, thinner) next to the side panel's top-3 moves and
  probabilities; the suggested move is **spoken** ("just the move", M6) through
  `chrome.tts` from the **service worker** (Piper-ready speaker interface) — see
  "The voice announcements (M6)". On the opponent's turn the **premove planner**
  (M7) checks whether ONE of our replies is safe to queue, draws it as a
  **dashed blue arrow** and speaks "premove …" — see "The premove planner (M7)".
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
| 5 | Arrow overlay on the real board | `src/content/board-overlay.js` (one fixed, click-transparent, DPR-crisp canvas) + `overlay-geometry.js` (pure: square centres normal/flipped, shaft + arrowhead, thickness scaling) + the shared `board-locate.js`; panel→SW→content routing (`humanplay:suggestion`/`clear-suggestion`) keyed by the M4 position key; "Show arrows" / "Show alternatives" settings; unit tests + CDP proof incl. a real chess.com page | ✅ done |
| 6 | TTS | `chrome.tts` announcements (Piper-ready interface), "just the move" — service-worker speaker, dedupe + stale guard, toggle/hotkey/rate/badge, actionable no-voice note, CDP proof incl. the panel-closed case | ✅ done |
| 7 | Premove planner | `POST /premove` criteria engine (opponent candidates from Maia, our reply must be safe or illegal), "Premove" panel card, dashed blue arrow, "premove …" speech, unit + stub/real CDP proofs | ✅ done |
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

The overlay adds a second pair (M5) that never touches the page directly: the
panel sends `humanplay:suggestion` `{moves, topN, key}` / `humanplay:clear-suggestion`
`{reason, key}` and the **service worker forwards them** to the tab that most
recently sent a GameState (see "The board overlay (M5)").

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

## The board overlay (M5)

The suggested move is drawn **on the real board** by a second content script
(`extension/src/content/board-overlay.js`), which adds exactly one element to the
page: a `position: fixed`, full-viewport, `pointer-events: none` canvas above the
board (`z-index = max(40, board stack z + 1)`) and below chess.com's modals.
Bitmap = viewport × `devicePixelRatio` (drawn under `ctx.scale(dpr, dpr)`, so all
geometry is viewport CSS pixels); no rAF loop — rendering is on demand.

- **Routing**: panel → service worker → content script
  (`humanplay:suggestion` `{moves, topN, key}` / `humanplay:clear-suggestion`).
  The worker forwards to the tab that most recently reported a GameState
  (mirrored to `chrome.storage.session` so MV3 restarts do not lose it);
  multi-tab rule: **last game tab wins** — documented behaviour.
- **Never stale**: the panel publishes only results whose M4 position key is
  still current and clears on every state without a current suggestion (new
  position analyzing, their turn, assistant off, no color, game over, error,
  stale result, "Show arrows" off). The overlay independently clears when a
  *different* GameState signature (fen · history · board · flipped · session)
  arrives, so an old arrow cannot survive a move.
- **Geometry** (pure, zero-dep, unit-tested): `squareSize = min(w,h)/8`;
  normal `col=file, row=7-rank`, flipped `col=7-file, row=rank`; endpoints are
  the square centres; arrowhead = tip + two base corners perpendicular to the
  direction; thickness = 16 % of a square (alternatives 9.5 %) clamped to
  [2, 42] px and ≤ half a square; tiny boards (< 4 px squares) and preview
  thumbnails (< 24 px squares) are not drawn. Partially offscreen rects stay
  exact (the canvas is clipped by the viewport); DPR never changes geometry.
- **Anchor sources**: `GameState.boardRect` is a convenience, but the overlay
  always re-reads the **live** `getBoundingClientRect()` of the board element the
  adapter picked (the shared `extension/src/content/board-locate.js` — same
  selectors, display test, tier rule and largest-board choice) on every new
  state, resize, scroll (passive), board `ResizeObserver`, and a bounded
  re-attach window after SPA navigation; no site DOM is modified otherwise.
- **Tests**: `test/tools/overlay-unit.mjs` (13 zero-dep geometry tests) and
  `test/tools/overlay-proof.mjs` (CDP, manifest variant): canvas hygiene,
  endpoints ≤ 2 px vs DOM-derived square centres on normal/flipped/scroll/resize
  boards, painted-pixel sampling, position-following, alternatives on/off,
  clear cases, multi-tab routing, board disappears/returns — plus the
  best-effort `--real-page` case on a real chess.com game. Evidence:
  `test/fixtures/captures/overlay/`.

## The voice announcements (M6)

The suggested move is spoken — **"just the move"**, no probabilities:
`Nf3` → "Knight to f3", `exd5` → "e-pawn takes d5", `O-O` → "Castle kingside",
`e8=Q+` → "Promote to queen on e8, check", `gxh8=N#` → "g-pawn takes h8,
promote to knight, mate", `Nbd2` → "b-knight to d2", `R1e2` → "rook one to
e2", `Bxh7+` → "Bishop takes h7, check". Anything unparseable falls back to the
UCI style ("move e2 to e4"). The formatter lives in
`extension/src/tts/move-speech.js` (pure, zero-dep, unit-tested).

**Wording and policy vs execution.** The side panel owns *what* to say (the
formatter) and *when* (`src/tts/tts-policy.js`); the **service worker** owns the
actual speech (`src/tts/speaker.js` + `src/tts/tts-service.js`). The panel sends
`humanplay:tts-speak` / `:tts-stop` / `:tts-voices`; the speaker never lives in
the panel document, so speech keeps working when the panel is closed
(architecture-critical; proven by the panel-closed proof case).

**Why the service worker won the speaker** (empirically verified on Chrome for
Testing 155.0.8059.84, see `test/fixtures/captures/tts/`): `chrome.tts` **is**
exposed in an MV3 service worker (speak/stop/getVoices/isSpeaking/onEvent all
present, events fire, audio synthesizes) — no offscreen document is needed, and
the manifest stays at one new permission (`tts`). An offscreen document does
**not** even expose `chrome.tts` (only the Web Speech `speechSynthesis`), and
the `offscreen` permission is not in the M6 budget; the fallback is therefore
recorded as unnecessary, not shipped. On Linux Chrome only synthesizes when it
has a speech backend and was started with `--enable-speech-dispatcher`
(speech-dispatcher + espeak-ng installed); without it every utterance ends in a
`{type:"error"}` event — the speak *path* still executes and is recorded.

**Speak iff, all of:** TTS enabled (default OFF) + assistant on + adapter state
ok and your color known + it is **your** turn + a suggestion is ready for the
**current** position key (the M4 stale guard runs first) + that key was not
spoken before (dedupe; a re-emitted state never repeats). Never on: the
opponent's turn (auto or manual), assistant off, errors (offline / invalid
input / any error class), game over, stale results. Enabling TTS (checkbox or
hotkey) speaks the current suggestion once; disabling stops mid-sentence.
Interruption: the worker calls `stop()` before **every** `speak(enqueue:false)`,
so a new position interrupts the old sentence by construction.

**Controls.** "Voice (TTS)" card: **Speak suggestion** (default OFF, persisted
in `settings`), **rate** (0.8 / 1.0 / 1.2 · clamped 0.5–2), **Speak test**
(always speaks "Knight to f3" — it tests the voice, not the policy) and a
**voices** availability line: `chrome.tts.getVoices()` plus — when it reports
none — an actionable note (install speech-dispatcher + start Chrome with
`--enable-speech-dispatcher`). The voice list loads asynchronously on Linux (0
right after a cold start, then thousands of espeak-ng voices), so the panel
retries once and the worker listens to `chrome.tts.onVoicesChanged`.
**Ctrl+Shift+Y** (`commands.toggle-tts`) toggles TTS from the worker (panel
closed included) and flips the toolbar badge: **"TTS"** on a green
(`#2f6f4f`) background while on, cleared while off (3 characters is the legible
maximum for a Chrome badge; documented and API-asserted).

**Recording.** `globalThis.__humanplayTts` (service worker) records every
speak/stop call — text, options (`enqueue:false`, rate), engine, SAN/UCI, reason,
source, key, timestamps — plus `chrome.tts` lifecycle events
(start/end/error/interrupted), counters, the last GameState the worker saw and
the badge state, mirrored to `chrome.storage.session` so it survives MV3 worker
restarts. `__humanplayTtsTest` is the documented callable seam the proof uses
for the hotkey handler (real key presses cannot be dispatched through CDP).

**Proving it.** `test/tools/tts-unit.mjs` (zero-dep: the formatter matrix +
policy/dedupe/rate helpers) and `test/tools/tts-proof.mjs` (CDP, manifest
variant, stub server): exactly 1 speak per position, dedupe on re-emit,
stop-then-speak on a position change, toggle off/on mid-flow, stale/assistant-off/
server-error/game-over silence, hotkey + badge, voices note, and the
panel-closed case (the SW tracks the new position and still performs + records a
speak with no panel document). Evidence: `test/fixtures/captures/tts/`.

## The premove planner (M7)

While the opponent thinks, the assistant may **premove** (chess.com plays the
queued move automatically as soon as it is legal). A premove only helps when
the opponent plays into it, and it hurts when it fires in a position we did not
foresee — so the planner's honest value is **refusing mispredicted premoves**.
It is same-Maia end to end (no second model, no Stockfish): the opponent's
candidates come from Maia(elo_oppo) at the current position and our replies from
Maia(elo_self) after each candidate (the Elo pair is swapped for the opponent
query because Maia conditions the policy on the **side to move**).

**Server** (`server/premove_engine.py` + `POST /premove`; `/analyze` is
untouched — `maia_engine.predict` was not modified, a new
`move_probabilities()` returns the full legal-move softmax). Request
`{fen, moves?, elo_self, elo_oppo, top_n=5, min_safety=0.90, mode="top"|"all"}`;
numeric knobs are **clamped** (`top_n` 1..12, `min_safety` 0.5..1.0, Elo
0..5000) rather than rejected. Response `{fen, side_to_move, opponent[…],
recommended|null, candidates[…], excluded[…], reason, params, timings_ms,
model, elapsed_ms}`.

The criteria (deterministic, thresholds documented):

- `C` — the considered opponent candidates. `mode="top"`: Maia(elo_oppo)'s
  top-`top_n` moves with probabilities **renormalised over them** (fast path).
  `mode="all"`: every legal move with its raw legal-masked softmax probability.
- For each `c ∈ C`: `r_c` = argmax of Maia(elo_self)'s reply distribution after
  `c`, `q_c` its probability (temperature-0 argmax, the same path `/analyze`
  uses).
- Candidates whose after-position is terminal (they mate us, stalemate, …) have
  no reply: **excluded** from every sum and reported in `excluded[]` with the
  reason — a premove cannot matter in a finished game, and a mate is never
  counted as "safe".
- `safe_mass(R)  = Σ p_c  over c with r_c == R`
- `guard_mass(R) = Σ p_c  over c where R is ILLEGAL after c` — "safe by
  inaction": the premove never fires there, so it cannot backfire.
- `safety(R) = safe_mass(R) + guard_mass(R)` — the share of the considered
  opponent mass after which queuing `R` cannot mispredict. The residual
  `1 − safety` is exactly where the premove WOULD fire although Maia's best
  reply differs.
- `min_response_prob(R)` = the smallest `q_c` among the c's with `r_c == R`
  (guard-only candidates are not counted — the reply is not used there).
- Recommend the best `R` iff `safety ≥ min_safety` **and** `safe_mass > 0`
  **and** `min_response_prob ≥ floor` (default 0.15, a module constant — the
  endpoint does not expose it — protecting against a "safety" that only holds
  because Maia barely prefers our move). Best = highest `(safety, safe_mass,
  min_response_prob, uci)`; deterministic.
- `criterion`: `forced` (exactly one legal opponent move → our argmax, the floor
  is waived — there is nothing to mispredict), `safe_vs_all` (`safety == 1.0`:
  every considered reply is either met by R or cannot fire it) or `robust`.
- Every candidate carries `verdict` (`recommended` / `not_safe` /
  `below_floor`) and a `why` string so the panel can say *why not*; a null plan
  carries a `reason` ("no safe premove: the best reply d3 covers only 67% …").

**Panel**: the "Premove" card is active on the opponent's turn (assistant on):
computed move + criterion chip (`forced` / `robust vs 94%` / `safe vs all
replies`), safety %, min response prob, their top-3 likely moves with %, a
`computing…` state, the honest "no safe premove" state with the reason, and —
for `mode="top"` — the mandated caveat line *"safe only over their top-N; a
premove still fires whenever it is legal"*. On our turn: "waiting for your
move". Excluded (mating) candidates are marked in the list.

**Client** (`src/analysis/premove-client.js`): the M4 analyze-client patterns —
position key `fen|moves|elo_self|elo_oppo|top_n|min_safety|mode`, LRU(24) +
in-flight dedupe, stale guard (`expectKey`/`stale`, the new position always
wins), 4–5 s timeout, exactly one retry on a network failure, injectable
`fetch`, the same error classes; the request mapping (replayed history →
startpos + UCI, mismatch → board FEN) is shared with `/analyze`.

**Trigger**: after our move lands (the opponent's turn begins) the panel plans;
a plan is ready ≤ ~600 ms (real mode: engine 87 ms, round-trip 91 ms,
state→render 113–260 ms; stub: mutation→render ~157 ms). If the opponent moves
while the plan is in flight the result is discarded silently — no render, no
arrow, no speech (the *newer* position's policy has already published; a stale
result never touches it).

**Overlay**: the premove is drawn through the existing canvas + geometry as a
**dashed** arrow in premove blue (`rgba(64,150,255,0.95)`, solid head, no square
highlight), on top of the suggestion arrows; the suggestion and premove sets are
independent (a manual analysis on their turn may show both). New setting
**"Show premove arrow"** (default ON, effective only while "Show arrows" is on).
No new DOM element, no click interception, still one canvas.

**Speech**: when Voice is on and **"Speak premoves"** (default ON) is on, the
recommendation is spoken as **"premove knight takes d5"** (M6 formatter with a
`premove ` prefix, `src/tts/move-speech.js` `premoveSpeech`) through the M6
service-worker speaker (stop-before-speak, `enqueue:false`, rate), with the M7
policy (`tts-policy.js` `premoveSpeakDecision`: TTS on + speak-premoves on +
assistant on + state ok + color known + **their** turn + a recommendation + the
plan's key still current + a new-position dedupe key `premove:<key>:<uci>`).

**Proving it**: `server/tests/test_premove.py` (24 tests: forced recapture,
guard recapture, strict null, safe-vs-all endgame, mate exclusion, the floor,
floats/clamps/contracts, determinism, perf), `test/tools/premove-unit.mjs`
(12 zero-dep tests: client key/dedupe/stale/errors + speech policy/text) and
`test/tools/premove-proof.mjs` (CDP, stub + real): the card renders every
criterion and the no-safe state, dashed arrow endpoints ≤ 2 px vs DOM ground
truth (normal **and** flipped), exactly one "premove …" speak per position
(deduped), gating (our turn / assistant off / TTS off), and the stale race.
Evidence: `test/fixtures/captures/premove/`.

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
- `POST http://127.0.0.1:8765/premove` (M7)
  body `{fen, moves?, elo_self?, elo_oppo?, top_n?, min_safety?, mode?}` →
  `{fen, side_to_move, opponent: [{uci, san, prob}], recommended: null |
  {uci, san, criterion, safety, min_response_prob, detail}, candidates: [{uci,
  san, safe_mass, guard_mass, min_response_prob, verdict, why}], excluded:
  [{uci, san, prob, reason}], reason, params, timings_ms, model, elapsed_ms}`.
  The criteria engine is documented in "The premove planner (M7)" above and in
  `server/premove_engine.py`. Numeric knobs clamp; invalid FEN/history is 400.
- `GET /health` → `{status, model}`.

Details, semantics (history planes, temperature, WDL perspective, the premove
criteria) and exact commands: `server/README.md`. Extension-side details
(adapter architecture, the analysis/premove clients, the snapshot recorder, the
proofs): `extension/README.md`. Test tooling (fixture server with canned
`/analyze` + `/premove` + `/debug/*` test routes, proof harnesses):
`test/README.md`.

## Licensing / boundaries

- `server/` imports the AGPL-3.0 `maia3` package (installed from GitHub into
  `server/.venv`); no maia3 source is vendored or copied.
- The extension must never contain maia3 code or any code from `server/`; it is
  a clean-room HTTP client. This keeps the AGPL boundary at the process level.
- The extension vendors exactly one third-party runtime file: chess.js
  (BSD-2-Clause, pinned 1.4.0) for rules-accurate SAN replay — see
  `extension/vendor/README.md`.

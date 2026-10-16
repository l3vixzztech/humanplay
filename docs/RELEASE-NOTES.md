# humanplay — Release Notes

## v1.0.2 — 2026-10-17 — long-game fix: board tracking + highlight turn

- **Fixes the long-game lockout**: chess.com renders only a sliver of the move list in long games,
  which can never reconcile against the board — history died, the turn degraded and no suggestions
  appeared. The adapter now **tracks the game by diffing board placements**: every position change
  is matched to the unique legal move that explains it, so the FEN — and the side to move — stay
  exact. Suggestions, premove and commentary keep working (history planes unavailable in this mode).
- **Side to move from the last-move highlight** (clock → highlight → parity): correct turn even when
  the move list is unusable.
- `you play: unknown` now points at the fallback-color select; mismatch diagnostics report the most
  complete candidate list instead of a small artifact.
- Evidence: `adapter-unit` **32 tests**; `adapter-proof` **ALL PASSED** including the new
  `board-tracking` case + `highlight-turn` fixture; full acceptance re-run against the live server
  (all cases passed).

## v1.0.1 — 2026-10-17 — live-game move-list fix

- **Fixes** a live-game failure where the adapter could latch onto the wrong move list (pages with
  several lists — previews, analysis panels, stale SPA content) or choke on a stray/duplicated
  move-list node, dropping the history and degrading side-to-move on every update. The adapter now
  reconciles **all** move-list candidates against the board (exact replay first, then a
  continue-on-error repair that must still match the board) and keeps the exact FEN + history.
- The panel's mismatch message now includes the failing token, ply and list selector — any future
  breakage is self-diagnosing (plus the one-click snapshot protocol).
- Evidence: `test/fixtures/captures/adapter/` (new `multi-list` + `artifact-token` traps, 8 fixtures,
  `ALL ADAPTER CASES PASSED`), `test/tools/adapter-unit.mjs` (27 tests), acceptance re-run
  (all cases passed). Extension reload required; the server does **not** need a restart.

## v1.0.0 (personal build) — 2026-10-17

The first complete build: a Chrome MV3 extension for chess.com plus a local
Maia-3 helper server, covering analysis, board overlay, voice, premove
planning, live commentary, robustness, documentation and packaging.

### What's in the box

| Area | Feature | Evidence |
|---|---|---|
| Adapter | Reads the live chess.com position, full move history, colour and board geometry from the DOM (multi-strategy, mismatch-safe) | `test/fixtures/captures/adapter/` (`adapter-proof`), `test/tools/adapter-unit.mjs` (22 tests), live chess.com check recorded in the M3 session log |
| Analysis | Maia-3 top-3 + human win/draw/loss prediction per position, Elo-conditioned (0–5000) | `server/tests/` (pytest), `test/fixtures/captures/analyze/` (stub + real, panel == `curl`) |
| Overlay | One click-transparent canvas draws the suggested move on the real board; endpoints within 2 px of the DOM-derived square centres on normal/flipped/scrolled/resized boards | `test/fixtures/captures/overlay/` (13 geometry unit tests + CDP proof + a real chess.com page) |
| Voice | `chrome.tts` speaks **just the move** from the service worker (works with the panel closed); `Ctrl+Shift+Y`; toolbar badge | `test/fixtures/captures/tts/` (12 unit tests + CDP proof incl. the panel-closed case, and a no-speech-backend run) |
| Premove | One safe queued reply per opponent turn with documented criteria (`forced` / `safe_vs_all` / `robust`), dashed blue arrow, “premove …” speech, honest refusal | `server/tests/test_premove.py` (24 tests), `test/fixtures/captures/premove/` (unit + stub/real proofs) |
| Commentary | One factual sentence per ply, both colours, from rules + Maia's distribution; optional Groq/Gemini rephrasing of the same facts with a local-only key | `server/tests/test_explain.py` (27 tests), `test/fixtures/captures/commentary/` (unit + stub/real proofs, feed cap, stale race, LLM fallbacks) |
| Robustness (M9) | One retry with a short backoff on HTTP 503 (cold model load); identical actionable offline state + **Copy start command** on every card; auto-recovery when the server returns; full rematch reset of every layer | unit suites (`analyze-unit`, `premove-unit`, `commentary-unit`) + `test/fixtures/captures/acceptance/acceptance-proof.json` (segments `offlineUx`, `rematch`) |
| Packaging (M9) | `scripts/setup-server.sh`, `scripts/run-server.sh`, `scripts/package-extension.sh` → `dist/humanplay-1.0.0.zip`, verified by unpacking it and loading it in Chrome (service worker must register) | `test/fixtures/captures/package/package-verify.json` |
| Docs (M9) | `README.md`, `docs/USER-GUIDE.md`, these notes, `docs/PROJECT.md` | this repository |

### The M9 acceptance proof

`test/tools/acceptance-proof.mjs` is the capstone: it loads the real extension
in Chrome for Testing and asserts everything below in ONE pass per mode (stub /
real), producing a single machine-readable report:

- **adapter** — the fixture game's start position is read from the DOM;
- **replay** — the full 14-ply fixture game (both castlings, captures) replayed
  ply by ply through DOM mutations: suggestions on every user turn equal a
  direct server request for the same position, overlay arrows within ≤ 2 px of
  DOM ground truth, TTS speak calls recorded for suggestions **and** premoves
  with per-position dedupe, premove cards with criteria (or the honest refusal)
  on every opponent turn, and one commentary entry per ply for both colours;
- **rematch** — a rematch clears the analyze/premove/explain caches, the TTS
  dedupe keys, the arrows and the commentary feed, while the fresh game comes
  alive again with the first move;
- **soak** — a **104-ply** replay leaves exactly one overlay canvas, the
  commentary feed pinned at its 50-entry cap, and every cache bounded
  (analyze/premove/explain ≤ 24, spoken keys ≤ 64). The soak runs silent (TTS
  off) on purpose: 100+ spoken knight shuffles would flood the speech backend;
  the dedupe-store bound itself is covered by the TTS unit tests and the
  rematch reset. Not measurable in a headless run: long-run *memory* — use a
  DevTools memory profile on a real session (documented, not asserted);
- **offline UX** — HTTP 503 is retried exactly once (server-side arrival
  counters prove it), every card shows the same actionable offline wording with
  the start command, the **Copy start command** button works, and the panel
  recovers by itself when the server returns;
- **real page** (best-effort) — one suggestion routed to a real chess.com game
  page through the real service-worker path, with a screenshot.

Evidence: `test/fixtures/captures/acceptance/` — `stub/` (the deterministic
fixture-server run: adapter, replay, rematch, offline UX/503/recovery, soak) and
`real/` (the same replay/soak/rematch against the real Maia server with every
user-turn suggestion cross-checked against real `curl /analyze`, plus the
best-effort real chess.com page segment). The canned server bodies the stub mode
replays are recorded from the real Maia server by
`test/tools/collect-acceptance-canned.py`
(`test/fixtures/captures/acceptance/canned-acceptance.json`); the folder README
explains the layout and the deliberate choices (silent soak, synthetic soak
bodies, memory profiling left to a manual session).

### How to run everything

```bash
# server + engine (correctness of the criteria engine and fact engine)
cd server && .venv/bin/python -m pytest tests -q

# zero-dependency unit suites (plain Node)
node test/tools/adapter-unit.mjs
node test/tools/analyze-unit.mjs
node test/tools/overlay-unit.mjs
node test/tools/tts-unit.mjs
node test/tools/premove-unit.mjs
node test/tools/commentary-unit.mjs

# browser proofs (Chrome for Testing; stub modes spawn the fixture server)
CHROME="$HOME/.cache/humanplay-chrome/chrome/linux-155.0.8059.84/chrome-linux64/chrome"
node test/tools/adapter-proof.mjs      --chrome "$CHROME"
node test/tools/analyze-proof.mjs      --chrome "$CHROME"
node test/tools/overlay-proof.mjs      --chrome "$CHROME"
node test/tools/tts-proof.mjs          --chrome "$CHROME"
node test/tools/premove-proof.mjs      --chrome "$CHROME"
node test/tools/commentary-proof.mjs   --chrome "$CHROME"
node test/tools/acceptance-proof.mjs   --chrome "$CHROME" --stub
node test/tools/acceptance-proof.mjs   --chrome "$CHROME" --real   # real Maia server + real curl

# packaging (builds dist/humanplay-1.0.0.zip and verifies it in Chrome)
scripts/package-extension.sh
```

Final counts for this build and the exact commands are recorded in
`docs/HANDOFF.md` (session 9).

### Known limitations / by design

- **chess.com only**, DOM reading — a chess.com markup change can degrade the
  reader to flagged warnings instead of guessing; **Record chess.com snapshot**
  makes that reproducible (fast-fix protocol).
- **Premove planner refuses often** — a quiet card is the honest answer when no
  reply is safe against the opponent's likely moves.
- **Commentary starts with the next move** it observes; it never retro-explains
  a game it did not witness.
- **Custom LLM provider endpoints** are not supported (fixed Groq/Gemini); **no
  TTS for commentary** (out of scope for v1.0.0).
- **No anti-detection features** — using the assistant in live rated games is a
  ban risk the user accepts.
- Linux voice output needs `speech-dispatcher` + `--enable-speech-dispatcher`;
  the panel says so when no voices are found.

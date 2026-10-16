# HANDOFF — session state log

> Update at the end of every session. Keep under one page. Newest entry on top.

## Session 5 — Milestone 5: board arrow overlay (top-1 suggestion on the real board) ✅

**What works**
- `extension/` **0.4.0**; adapter **m3.1**; overlay **m5.0**. No new permissions.
- **`src/content/board-locate.js` (new, shared)**: board selectors, display
  test, `<wc-chess-board>` tier rule, largest-displayed-board pick, `rectOf`,
  `isBoardFlipped`, `stackingZIndex` — extracted from the M3 adapter so the
  adapter and the overlay **cannot disagree** about the live board. Pure parts
  are Node-testable.
- **`src/content/overlay-geometry.js` (new, pure)**: `uciToSquares`,
  `squareToViewport` (normal `col=file,row=7-rank`; flipped `col=7-file,row=rank`),
  `computeArrow`/`computeArrows` (square-centre endpoints, shaft, 3-point
  arrowhead polygon, thickness 16 % of a square / 9.5 % for alternatives clamped
  to [2,42] px and ≤ ½ square, head never longer than 80 % of the move/diagonal),
  `deviceCanvasSize`, `intersectsViewport`, `overlayZIndex`. Zero-dep, exactly
  the file the content script imports.
- **`src/content/board-overlay.js` (new content script)**: one `<canvas
  id="humanplay-overlay-canvas">` appended to `body` — fixed, full-viewport,
  `pointer-events:none`, `aria-hidden`, `display:none` while idle, DPR-crisp
  (bitmap = clientSize × dpr, drawn under `ctx.setTransform(dpr,0,0,dpr,0,0)`),
  `z-index = max(40, boardStackingZ+1)` (40 on every page tested). Orange
  outlined top-1 + subtle from/to square highlight, thin translucent blue
  alternatives; **no rAF loop**. Dumb renderer: `humanplay:suggestion`
  `{moves,topN,key}` / `humanplay:clear-suggestion`. Re-anchors on every
  suggestion/clear, every new GameState (via `__humanplayContentHook` set by the
  adapter in the same isolated world), `resize`, `scroll` (passive), board
  `ResizeObserver`, and a bounded retry when the board element disappears. Its
  own stale guard: clears when the live GameState signature (fen · history ·
  board · flipped · session) no longer matches the accepted suggestion.
  Refuses to draw when the board is smaller than 24 px per square (preview
  thumbnails).
- **Router**: `service-worker.js` remembers the tab of the most recent
  `humanplay:chesscom-state` (memory + `storage.session` mirror for MV3 worker
  restarts) and forwards panel suggestions/clears there. Multi-tab: **last game
  tab wins**; a suggestion published in the instant a second tab becomes the
  sender can land on it briefly — the next clear/suggestion replaces it.
- **Panel**: "Show arrows on board" (default **ON**) + "Show alternatives"
  (default **OFF**, top-3) persisted in `settings`; toggling clears/re-renders
  immediately from the still-current suggestion. The panel publishes only
  non-stale results (M4 guard) and clears on: new position analyzing, their
  turn, assistant off, no color, no state, game over, error, stale result,
  arrows off. Read-only test hook: `__humanplayAnalysis.overlay`.

**Results (evidence: `test/fixtures/captures/overlay/`, 26 files)**
- `overlay-unit.mjs`: **13/13 passed** — 8-direction arrowheads, flipped
  mapping, offscreen rects, DPR, thickness scaling, clamps, degenerate inputs.
- `overlay-proof.mjs` (CDP, stub driving canned suggestions; manifest variant
  `codeIdentical: true`, 21 files): **ALL OVERLAY CASES PASSED** — canvas
  exists/`pointer-events:none`/fixed/DPR rect/z 40; **endpoint errors vs
  DOM-derived ground truth 0.00 px in every case** (startpos, scroll, resize,
  middlegame, flipped, after a move, real page); painted-orange pixel sampling;
  move → previous arrows cleared in **188 ms** and new arrows in 868 ms (the
  first request was artificially delayed 700 ms by the stub — real engine path
  156–173 ms in M4); alternatives 3 arrows (top-1 thicker, persisted);
  opponent's turn/assistant-off/game-over/400-error → 0 arrows (clear reasons
  `opponent-turn` / `assistant-off` / `game-over` / `error:invalid_input`);
  toggle off/on clears/redraws; multi-tab last-wins; board removed → hidden,
  re-inserted → re-anchored.
- **BONUS real chess.com page** (`--real-page`, finished public game
  `https://www.chess.com/game/live/186394589423`, headless Chrome for Testing):
  adapter read the real position (`2r5/8/8/7k/8/5N2/6P1/5nK1 w - - 0 1`), the SW
  routed a suggestion to the real tab through the real message path, canvas
  `fixed/none/z40`, **endpoints 0.00 px vs the real board's painted pieces** →
  `real-chesscom-arrows.png`. Third-party tracker noise (rlcdn 451) recorded,
  not our failure.
- Regressions all green: `adapter-proof` ALL PASSED (adapter refactor kept),
  `analyze-proof` STUB ALL PASSED (10 cases), `adapter-unit` 22, server
  **`55 passed`**.
- Screenshots (the money shots, `captures/overlay/`): `startpos-arrows.png`,
  `middlegame-arrows.png`, `middlegame-alternatives.png`,
  `middlegame-arrows-after-move.png`, `flipped-black-arrows.png`,
  `ruy-lopez-arrows.png`, `startpos-arrows-scrolled/resized.png`,
  `real-chesscom-arrows.png`, plus no-arrow clear-case shots and panel shots.

**Exact commands**
```bash
CHROME="$HOME/.cache/humanplay-chrome/chrome/linux-155.0.8059.84/chrome-linux64/chrome"
node test/tools/overlay-unit.mjs                          # 13 passed
node test/tools/overlay-proof.mjs --chrome "$CHROME"      # 9 cases (spawns the stub)
node test/tools/overlay-proof.mjs --chrome "$CHROME" --real-page   # + real chess.com bonus
node test/tools/adapter-proof.mjs --chrome "$CHROME"      # M3 regression
node test/tools/analyze-proof.mjs --chrome "$CHROME"      # M4 stub regression
cd server && .venv/bin/python -m pytest tests -q          # 55 passed (server untouched)
```

**Tuning values (change these, not behaviour)**
- `board-overlay.js`: `RENDER_DEBOUNCE_MS 80`, retry 5×700 ms, white-listed
  board min **24 px/square**; `COLORS.primary rgba(255,176,32,0.95)` + border
  `rgba(26,20,8,0.88)`, `COLORS.alternative rgba(76,160,255,0.60)`, highlight
  fill/stroke 0.14/0.32; z-index formula `max(40, boardZ+1)`.
- `overlay-geometry.js` `DEFAULTS`: thickness 0.16/0.095, clamp [2,42],
  head ×2.8/×3.0 of thickness, min square 4 px.

**Automatic vs manual**
- Delivered by tests: geometry maths; canvas hygiene; endpoint alignment on
  fixtures + one real page; clear/redraw transitions; settings persistence;
  routing path incl. the SW.
- **A human must verify (not automatable here)**:
  1. **Real game (your turn)**: load unpacked 0.4.0, start the server, open a
     chess.com bot game, click the toolbar icon → the orange arrow must appear on
     the board with the suggestion (≤ ~1.5 s after the board updates) and change
     after every move.
  2. **As black** (flipped board) → arrow still on the right squares
     (automated on the fixture; confirm on the live board).
  3. **Premove/pre-move move**: arrows must clear the moment a move lands.
  4. **Window resize** while arrows are visible → alignment kept.
  5. **"Show arrows" off/on** and **"Show alternatives"** → immediate hide/show
     (1 ↔ 3 arrows).
  6. **Dialogs**: open a chess.com modal (e.g. Game Review / settings) → the
     arrow must stay BELOW it (z-index 40 was below every site layer seen in the
     real-page shot; confirm against dialogs, tune the formula if needed).
  7. Two game tabs: the last one that changed receives the arrows (documented).

**Deviations / notes**
- Content scripts from one manifest entry share the isolated-world global scope:
  a top-level `const` name collision (`moduleUrls` in both files) is a fatal
  SyntaxError that the proof's console check caught → `board-overlay.js` is
  wrapped in an IIFE; keep new content-script globals inside it.
- The overlay uses the adapter's local hook instead of a second document
  MutationObserver; its own observers are only resize/scroll/ResizeObserver +
  a bounded re-attach retry.
- Preview-thumbnail trap: with the main board removed the fixture's 160 px
  preview becomes the "largest board" — the overlay's 24 px/square floor keeps
  arrows off it (this is also why the O9 case shows `hidden/board-too-small`).
- z-index is computed from the board's stacking context (`max(40, z+1)`), so it
  follows weird page variants; dialogs on chess.com sit higher.
- The real-page case is best-effort (`--real-page [url]`): it retries once and
  records `blocked` instead of failing when the page cannot be driven (network/
  Cloudflare); it ran successfully this session.

**Next — Milestone 6**: TTS via `chrome.tts` announcing just the move
(Piper-ready interface). M7: premove planner off Maia's distribution.

---

## Session 4 — Milestone 4: end-to-end analysis loop (game state → Maia → panel) ✅

**What works**
- `extension/` **0.3.0**: new `src/analysis/analyze-client.js` (pure, no chrome.*)
  = the only `/analyze` client. `analyze()`: 4 s AbortController timeout,
  **exactly one retry on a network failure** (never on 4xx/5xx, never on a
  timeout), result objects only, error classes `offline` / `timeout` /
  `invalid_input` (400, 422) / `engine_unavailable` (503) / `http` /
  `bad_response`; `fetchImpl` injectable. `createAnalyzeClient()`: position key
  `fen|moves|elos|top_k`, small LRU (24; failures never cached), in-flight
  dedupe, `noteSessionSeq()` clears the cache on a new game, stale guard
  (`expectKey()` + `result.stale`) so an older slower response can never
  overwrite a newer position. `buildAnalyzeRequest()`: replayed history →
  `{fen: startpos, moves: full UCI history}`; adapter `mismatch` (or no usable
  history) → `{fen: board FEN, moves: []}` + card warning. `analysisGate()`:
  auto only when assistant ON + state ok + `userColor` known + `turn === userColor`.
- Panel: **"Maia suggestion"** card (status chip, top-3 rows with rank/SAN/UCI/
  probability bar/1-decimal %, top-1 highlighted, WDL chips + perspective label
  + "not an engine evaluation" tooltip, mismatch warning, meta line
  `model · engine ms · round-trip ms · 14 moves · replayed · ui ms [· cached]`,
  **Analyze now**) and **"Elo"** card (`elo_self`/`elo_oppo` 0–5000 clamped,
  default 2400, persisted, "reset to 2400", changing them re-analyzes). Opponent
  turn → "their turn — waiting" (M7); game over → message instead of rows;
  manual analysis on the opponent's turn flips win↔loss + "opponent's
  perspective". M2/M3 cards kept. Panel debug hook `__humanplayAnalysis`
  (read-only) for the proof.
- Fixtures: `ruy-lopez.html` (Elo demo position) + `gameover-checkmate.html`
  (scholar's mate) added to `generate_chesscom.py`; the other three regenerate
  byte-identical.
- `test/tools/fixture_server.py`: `POST /analyze` with **canned real-server
  responses** (9 keys; schema identical by construction — verified equal to a
  fresh real run) + `/debug/stats|delay|mode|reset|canned` (test-only routes).
  `test/tools/collect-canned.py` re-records them; the full record is
  `captures/analyze/canned-report.json`.
- `test/tools/analyze-unit.mjs` (20 zero-dep tests, injected fetch) and
  `test/tools/analyze-proof.mjs` (CDP, manifest-variant, stub + `--real`).

**Results (evidence: `test/fixtures/captures/analyze/`)**
- analyze-unit: **20 passed** (`analyze-unit.json`).
- analyze-proof **STUB** (10 cases, `analyze-proof-stub.json`) — all PASS:
  top-3 + bar + 1-decimal % + WDL chips + tooltip + meta; **3 state renders →
  1 HTTP request** (dedupe, second was `fromCache`); **stale guard**: P2 (delayed
  900 ms) discarded (`staleDiscards: 1`), P3's rows kept, no overwrite after the
  slow response landed; assistant OFF → 0 requests, ON → analyzed again (400
  detail shown); 400 UI shows the server detail; **server offline**: 2 fetch
  attempts (1 retry; 4 server-side connection attempts — Chrome retries a
  dropped keep-alive connection internally) + actionable uvicorn command;
  opponent turn: waiting → manual `d4` with WDL flipped 44.6/49.1 %
  (opponent's perspective); game over message; Elo 1200→`d4` 83.6 %,
  2600→`h3` 86.2 %, reset→2400; mismatch → board-only request
  (`… 2NP1N2/… w - - 0 8||2400|2400|3`, no `e2e4`) + warning + successful
  board-only suggestion.
- analyze-proof **REAL** (`--real`, uvicorn up, `analyze-proof-real.json`):
  **panel top-3 == `curl /analyze`** for `{fen: startpos, moves: 14 UCI}`
  (Nc3 0.585868 / h3 0.16039 / c3 0.129875), real game-over checkmate, and Elo
  1200→`d4` 83.6 % vs 2600→`h3` 86.2 % (panel AND curl).
- **Latencies (target ≤ 1500 ms)**: real engine **18.75 ms**, round-trip
  **22 ms**, state→render **23 ms**, **position change (DOM mutation)→suggestion
  173 ms** (includes the 150 ms adapter debounce); stub: 2–4 ms state→render,
  157 ms mutation→render. Canned model output is deterministic (canned == fresh
  real run, value-identical).
- Regressions: `adapter-proof` **ALL ADAPTER CASES PASSED** (now incl.
  ruy-lopez + gameover fixtures; snapshot recorder + replay; console clean);
  `adapter-unit` 22 passed; `capture-proof` exit 0 (codeIdentical, capture
  1100×757, byte-identical recorded PNG, toggle persistence, console clean);
  `cd server && .venv/bin/python -m pytest tests -q` → **55 passed, 3.00 s**
  (server untouched).

**Exact commands**
```bash
CHROME="$HOME/.cache/humanplay-chrome/chrome/linux-155.0.8059.84/chrome-linux64/chrome"
node test/tools/analyze-unit.mjs                        # 20 passed
node test/tools/analyze-proof.mjs --chrome "$CHROME"    # STUB, 10 cases (spawns the stub itself)
cd server && .venv/bin/python -m uvicorn app:app --host 127.0.0.1 --port 8765   # for REAL mode
node test/tools/analyze-proof.mjs --chrome "$CHROME" --real
node test/tools/adapter-proof.mjs --chrome "$CHROME"    # M3 regression
python3 test/tools/fixture_server.py --port 8765 &      # M2 regression
node test/tools/capture-proof.mjs --chrome "$CHROME" --extension extension --manifest-all-urls \
  --page-url http://127.0.0.1:8765/pages/startpos.html --expect-chip online
# re-record the stub's canned /analyze data (real server must be running):
server/.venv/bin/python test/fixtures/generate_chesscom.py && python3 test/tools/collect-canned.py
```

**A human must verify (not automatable here) — manual checklist**
1. **Real chess.com bot game**: load unpacked (0.3.0), start the server, open a
   game, click the toolbar icon. On your move the suggestion card must appear
   (≤ ~1.5 s after the board updates) and change after the opponent moves;
   the FEN in the state card must still match the board (M3 regression).
2. **Elo effect**: in some middlegame, set 1200/1200 vs 2600/2600 — the top
   move (or at least the probabilities) must change and a new request must be
   fired. (Automated proof: Ruy Lopez `d4`@1200 vs `h3`@2600.)
3. **Server offline**: stop uvicorn → the card must show "server offline" with
   the start command (after one retry), and recover on the next position once
   the server is back.
4. **Game over**: finish a game (or get mated) → the card must show the
   "game over — checkmate — …" message instead of move rows.
5. Optional: press **Analyze now** on the opponent's turn → rows appear with
   the "opponent's perspective" WDL label.

**Deviations / notes**
- The delayed-request test surfaced a stub bug (the artificial delay leaked onto
  the *next* request); fixed in `fixture_server.py` (only the request that
  consumes a delay slot sleeps).
- `/analyze` requests use the **standard start position** as the base for
  replayed histories; a chess.com analysis board with a custom setup would
  therefore show a mismatch and fall back to board-only (correct, but the
  history planes are then empty).
- Chrome internally retried the deliberately dropped keep-alive connection in
  the offline case (4 server-side attempts for 2 fetch attempts); the panel's
  "retried once, 2 attempts" text comes from the client's own attempt log
  (unit-tested exactly).
- Stub mode's canned responses are real-server recordings; stub screenshots
  therefore show "maia3-5m" — the proof records the server identity
  (`fixture-static-server`) separately.
- Finding (not fixed, by design): the M3 adapter's MutationObserver watches
  childList/characterData, not attributes — a class-only piece mutation does not
  trigger a refresh. Real chess.com repaints the move list with every move, so
  the live path is unaffected; the mismatch proof repaints the move list too.
- `/debug/*` routes live only in the test fixture server; the shipped extension
  never calls them (only `/health`, `/analyze`, `/snapshot`).

**Next — Milestone 5**: draw the suggested move on the real board using
`boardRect` + `devicePixelRatio` from the GameState (and the top-1 UCI the panel
already has from `/analyze`). M6: TTS.

---

## Session 3 — Milestone 3 (pivot): chess.com DOM adapter + state protocol + fixtures ✅

**The pivot** (why this differs from the "Next" note at the end of session 2)
Product scope is now **chess.com only, DOM-based** reading. The pixel board
locator was stopped mid-M3 and **parked, not deleted**: `parked/image-recognition/`
(locator + proof tool + pruned evidence + README explaining state/revival);
classifier/tracker milestones are cancelled. The capture-source abstraction and
PNG recorder stay in the extension as **debug tools** only. The move history now
comes from chess.com's own move list (exact Maia history planes for M4).

**What works**
- `extension/` **0.2.0**: content script `src/content/chesscom-adapter.js` on
  `https://www.chess.com/*` + `https://chess.com/*` (`document_idle`); shipped
  manifest has **no `<all_urls>`**. Reads: largest visible board
  (`wc-chess-board`/`#board-single`/`#board-play-computer`/`#board-analysis-board`/`.board`);
  position via `.piece` `square-XY` classes (primary, live-verified) → per-square
  containers → board-exposed FEN (`board.game.getFEN()`, fallback/cross-check);
  move list → SAN → chess.js replay → **exact FEN + UCI history**; flipped (board
  class) / userColor (bottom clock token → getPlayingAs → panel setting → flipped
  inference); `boardRect` (viewport CSS px) + devicePixelRatio; mismatch policy
  (board = position, list = history; disagreement → `mismatch` + board only, no
  guessing). Broadcasts `humanplay:chesscom-state` on change (150 ms debounce),
  on load and on request; new game/reset → `sessionSeq`/`resetDetected`.
- Pure modules `board-dom.js` + `move-history.js` (identical files in browser and
  Node), vendored `vendor/chess.js` **1.4.0** (BSD-2-Clause — plan said MIT;
  pre-1.0 was MIT) + LICENSE + README with hash/update procedure.
- Panel (M3): "chess.com game state" card (listening chip, board id, exact FEN,
  moves + history status, turn, "you play" + source, mismatch/warnings,
  source/strategy line, fallback-color select, Refresh) +
  **Record chess.com snapshot** (sanitized JSON: usernames→`user`, no avatar
  upload/member URLs; always downloads, and writes straight into
  `test/fixtures/chesscom-snapshots/` when `fixture_server.py` runs). M2 debug
  cards kept (capture, PNG recorder, health chip).
- `test/fixtures/chesscom/`: 3 fixtures replicating the **live-verified 2026-10
  markup** (startpos, middlegame with castling+captures, flipped playing black)
  with traps (smaller preview board, hidden board, both piece class orders,
  cosmetic theme color classes on both players, timestamp cells) + `replay.html`
  + `reference/` raw excerpts recorded from live chess.com +
  `generate_chesscom.py` (python-chess ground truth).
- `test/tools/adapter-proof.mjs` (CDP): own static server; manifest variant adds
  content-script + WAR matches for the fixture origin (all 17 code files
  hash-identical, `codeIdentical: true`); asserts exact FEN/UCI/color/flip/rect
  (≤0.5 px vs DOM), panel UI + screenshots, DOM-mutation change detection,
  snapshot recorder, snapshot replays, clean console.
- `test/tools/adapter-unit.mjs`: 22 zero-dep unit tests (SAN tokenizing, replay,
  castling/en-passant/promotion, class parsing, placement sanity, gameIdFromUrl).
- `test/tools/fixture_server.py` also serves the chesscom fixtures and accepts
  `POST /snapshot` (dev-tool route only; the Maia server is untouched).

**Results (machine-readable: `test/fixtures/captures/adapter/`)**
- adapter-proof: **ALL ADAPTER CASES PASSED** — startpos exact (0 moves);
  middlegame `r1b2rk1/ppp2ppp/2np1q2/2b1p3/2B1P3/3P1N2/PPP2PPP/RN1Q1RK1 w - - 0 8`
  + 14 UCI; flipped-black `rnbqkbnr/pp2pppp/3p4/2p5/4P3/5N2/PPPP1PPP/RNBQKB1R w KQkq - 0 3`,
  userColor black, flipped true; rect 560×560 ±0 px; dom-change Nf3 mutation →
  `…/RNBQKB1R b KQkq - 1 1`; snapshot recorder sanitized (0 usernames) + replay
  self-test ok; panel/SW/page console clean; 13 adapter strategy debug lines.
- unit: 22 passed. M2 regression `capture-proof.mjs` (fixture server,
  `--manifest-all-urls`): chip online, capture 1100×757, recorded PNG
  byte-identical, toggle persistence, console clean, codeIdentical 17/17.
- M1: `cd server && .venv/bin/python -m pytest tests -q` → **55 passed, 2.98 s**
  (server untouched).
- **Live chess.com check** (one-off, SHIPPED manifest, headless Chrome; evidence
  `test/fixtures/captures/adapter/live-chesscom-check.json`): on a real finished
  game page the adapter's FEN **and all 142 UCI moves match the game's official
  PGN replayed with python-chess**; sequence observed: skeleton board
  (ok:false) → real board with degraded metadata (warning, clock-inferred side
  to move) → full replayed state. chess.com keeps a visible same-sized
  `#board.board` skeleton div → the adapter prefers `wc-chess-board` (tier rule,
  regression-trapped in the fixtures).

**Exact commands**
```bash
CHROME="$HOME/.cache/humanplay-chrome/chrome/linux-155.0.8059.84/chrome-linux64/chrome"
node test/tools/adapter-unit.mjs                        # 22 passed
node test/tools/adapter-proof.mjs --chrome "$CHROME"    # ALL ADAPTER CASES PASSED
server/.venv/bin/python test/fixtures/generate_chesscom.py
python3 test/tools/fixture_server.py                    # http://127.0.0.1:8765/chesscom/index.html
cd server && .venv/bin/python -m pytest tests -q        # 55 passed
# M2 regression (fixture server running):
node test/tools/capture-proof.mjs --chrome "$CHROME" --extension extension --manifest-all-urls \
  --page-url http://127.0.0.1:8765/pages/startpos.html --expect-chip online
```
Live reference probes that fixed the fixture markup (one-off, recipe in
`test/fixtures/chesscom/README.md`): headless Chrome for Testing + CDP against
chess.com/play/computer (startpos), a public finished game page (URL via
`https://api.chess.com/pub/player/<user>/games/<yyyy>/<mm>`), the play-computer
side selector "black" (flipped class), and chess.com/analysis
(`board.game.getFEN()`/`getHistorySANs()`).

**A human must verify (not automatable here)**
1. **Real chess.com game, live panel**: load unpacked (`chrome://extensions` →
   Load unpacked → `extension/`), open a bot game, click the toolbar icon →
   panel card FEN/moves/turn/"you play" must match the visible board; make a
   move → card updates (≤~1 s); press **Refresh state**.
2. Repeat **as black**: card must show `flipped: true` / "you play black".
3. **Failure protocol**: if a real page breaks detection (wrong FEN / "no game
   detected"), press **Record chess.com snapshot**, move the JSON into
   `test/fixtures/chesscom-snapshots/`, run adapter-proof → the replay test
   shows exactly what the adapter parses (fast-fix protocol,
   `test/fixtures/chesscom/README.md`).
4. Debug capture flow (unchanged from M2, still manual): toolbar-click →
   activeTab grant → **Capture now**/**Record fixture (PNG)**.

The automated adapter proof runs the panel document as a *tab* and injects the
content script through a **test-only manifest variant** for the fixture origin;
the real side-panel container, the real chess.com origin and the toolbar click
are the manual steps above.

**Deviations / notes**
- Live 2026 chess.com uses `wc-simple-move-list` (task text mentioned
  `wc-vertical-move-list`); both supported, the live one is primary.
- chess.js is BSD-2-Clause (not MIT as planned) — license vendored.
- CDP-redirected downloads get a GUID filename (M2 quirk); the proof records
  the panel's *requested* name separately.
- `board.game.*` are chess.com internals — never the primary source; a rename
  degrades to warnings/fallbacks instead of failures.
- Snapshots are safe to commit (sanitized); the folder is empty until someone
  records from a real game.

**Next — Milestone 4**: panel sends `POST /analyze {fen, moves}` (the UCI history
from the adapter) for the live state, gated by the assistant toggle, rendering
top-3 + WDL in the card. Then M5 draws the arrow on the real board using
`boardRect` + `devicePixelRatio`.

---

## Session 2 — Milestone 2: extension skeleton + tab capture + offline fixtures ✅

**What works**
- `extension/` MV3 **0.1.0**: `manifest.json` (action, ES-module service worker, `side_panel`, permissions `activeTab/storage/sidePanel/downloads`, `host_permissions` `http://127.0.0.1:8765/*`, 4 generated icons — no content scripts, no `<all_urls>`); `src/capture/capture-source.js` = the LOCKED contract `async getFrame() -> {dataUrl,width,height,capturedAt,source,tabUrl,tabTitle}` with `BrowserTabCaptureSource` (`chrome.tabs.captureVisibleTab`, self-throttled to 550 ms because Chrome caps the API at ~2/s), a `DesktopCaptureSource` stub that throws `not implemented`, and the `getCaptureSource()` factory; `src/background/service-worker.js` (toolbar action → side panel via `setPanelBehavior({openPanelOnActionClick:true})`, no other state); `src/ui/sidepanel.{html,css,js}` (assistant toggle persisted, **Capture now** → preview + dims + time + tab info, **Record fixture (PNG)** → `chrome.downloads.download` as `humanplay-<YYYYMMDD-HHMMSS>.png`, `/health` chip online/offline with 2.5 s timeout + Refresh). Screenshot data URLs are never stored (`chrome.storage.local` holds only `settings`).
- `test/fixtures/`: 4 self-contained offline pages (startpos, middlegame/Najdorf, castling-black-to-move, promotion) + index, built with python-chess SVG, knowledge in a hidden `<div id="fen" data-fen=… data-moves=…>`, `generate.py`, `render_pages.sh`, `pages-png/*.png`, `captures/` (extension-captured PNGs + proof JSON).
- `test/tools/fixture_server.py` (fixtures + stub `/health` on 127.0.0.1:8765) and `test/tools/capture-proof.mjs` (CDP driver for Chrome for Testing).
- Server (Task 0): 3 black-to-move golden cases added to `server/tests/positions.py`. **`55 passed` (~3.5 s)**; observed top-1: after 1.e4 → `c7c5 c5 0.3749`, Ruy Lopez → `a7a6 0.6722`, black castling → `e8c8 O-O-O 0.3188` (matches the external check; the golden test re-verifies ordering against `maia3-uci`).

**Exact commands**
```bash
cd server && .venv/bin/python -m pytest tests -q                              # 55 passed
server/.venv/bin/python test/fixtures/generate.py                            # regenerate pages
test/fixtures/render_pages.sh "$HOME/.cache/humanplay-chrome/chrome/linux-155.0.8059.84/chrome-linux64/chrome"
python3 test/tools/fixture_server.py --port 8765                             # fixtures + stub /health (conflicts with the Maia server)
CHROME="$HOME/.cache/humanplay-chrome/chrome/linux-155.0.8059.84/chrome-linux64/chrome"
# 3 evidence runs (each writes a proof JSON + panel screenshot):
node test/tools/capture-proof.mjs --chrome "$CHROME" --extension extension --expect-chip offline \
  --panel-shot test/fixtures/captures/panel-offline.png      > test/fixtures/captures/panel-offline-proof.json
node test/tools/capture-proof.mjs --chrome "$CHROME" --extension extension --manifest-all-urls \
  --page-url http://127.0.0.1:8765/pages/startpos.html --expect-chip online \
  --out test/fixtures/captures/startpos-capture.png \
  --copy-download-to test/fixtures/captures/downloaded-by-extension.png \
  --panel-shot test/fixtures/captures/panel-fixture-online.png > test/fixtures/captures/startpos-proof.json
# with the real server up (uvicorn): chip evidence
node test/tools/capture-proof.mjs --chrome "$CHROME" --extension extension --expect-chip online \
  --panel-shot test/fixtures/captures/panel-online-maia3.png > test/fixtures/captures/panel-online-maia3-proof.json
```
Load unpacked (manual): `chrome://extensions` → Developer mode ON → **Load unpacked** → `/home/l3vixzz/Desktop/humanplay/extension` → pin the icon; click it on the tab you want, then **Capture now**.
Chromium on this machine: **snap is broken** (`chromium --version` → `snap-confine is packaged without necessary permissions … required permitted capability cap_dac_override not found`), so all browser runs used **Chrome for Testing 155.0.8059.84** (`npx --yes @puppeteer/browsers install chrome@stable --path "$HOME/.cache/humanplay-chrome"`), launched with `--load-extension=<repo>/extension --disable-extensions-except=<repo>/extension` and `--headless=new` (plus `--user-data-dir` in `/tmp`).

**Evidence (machine-readable in `test/fixtures/captures/*.json`)**
- Extension registers: service worker target `chrome-extension://ddjimhmdcidjnimeenkbcjjneamablej/src/background/service-worker.js` (id = path-derived shasum of `/home/l3vixzz/Desktop/humanplay/extension`; production-manifest runs).
- `chrome.sidePanel.getPanelBehavior()` → `{openPanelOnActionClick: true}`; browser profile also has `open_side_panel_on_icon_click: true`.
- UI: all five elements present, one external script, **0 inline scripts** (no CSP/mV3 violations). Panel console + worker: **0 errors/warnings** in every run (offline run has only the expected `net::ERR_CONNECTION_REFUSED` network log for `/health`).
- Chip: `online · maia3-5m` against the real uvicorn server, `online · fixture-static-server` against the fixture server, `server offline` with nothing listening (screenshots `panel-online-maia3.png`, `panel-fixture-online.png`, `panel-offline.png`).
- Capture through the extension: **1100 × 757 px, 63 320 bytes**, `source: browser-tab`, meta shows tab title+URL (`captures/startpos-capture.png` = `pages/startpos.html`).
- Fixture recorder: the frame was downloaded by the panel to the **real Downloads folder** as `~/Downloads/humanplay-20261016-222823.png`, `state: complete`, `mime: image/png`, **byte-identical** to the captured frame (`matchesCapturedFrame: true`); copy in `captures/downloaded-by-extension.png`.
- Toggle: click → `{settings:{assistantEnabled:false}}`; survives a page reload; storage keys = `["settings"]` only.
- Hashes for the capture proof: `manifest.json` `c6703417…6d3da`, `capture-source.js` `aeff4f2a…4007`; the `--manifest-all-urls` test variant compared **11/11 code files identical** (`codeIdentical: true`).

**Verified automatically vs needs a manual click — no invented results**
- Automatic: extension loads with no console/CSP errors; action→panel wiring; panel UI, chip online/offline, toggle persistence; capture via `chrome.tabs.captureVisibleTab`; fixture download; fixture pages render offline; server suite green.
- **Not** automatic (must be checked by hand): the real **toolbar-icon click** on a real site — that click is what grants `activeTab`, so the capture above ran with `<all_urls>` added by the test harness. With the shipped manifest, `Capture now` works only after clicking the icon on that tab; pressing it without a grant shows the documented error. The true `chrome.sidePanel` container was not automated either (the identical panel document was loaded as a tab; panel behavior only asserted via the API/profile).
- Chrome quirk found (now in `docs/PROJECT.md`): `captureVisibleTab` requires `activeTab` **or `<all_urls>`**; a matching narrow host permission is *not* enough (`permissions_data.cc`, `CanCaptureVisiblePage`/`kActiveTabOrAllUrls`). Hence the test variant; the shipped manifest stays narrow on purpose.

**Deviations / leftovers**
- snap Chromium blocked → Chrome for Testing (documented above and in `extension/README.md`).
- `test/tools/capture-proof.mjs --download-dir` redirects downloads via CDP, which makes Chrome write a generic `download.png`; the harness now prefers the real download folder and copies into the repo (see `copyDownloadTo` in the proof JSON).
- Panel screenshots are CDP screenshots with an emulated 380×760 viewport (real-ish side-panel width) — they are harness captures, not extension captures.
- Icons are simple generated checkerboard PNGs (`extension/tools/make_icons.py`), not designed artwork.
- `~/Downloads/humanplay-20261016-222823.png` was left behind by the recorder test.
- `test/tools/fixture_server.py` occupies port 8765 (same as the Maia server) — run one at a time.

**Next — Milestone 3**: board locator on the captured frames (site-agnostic, e.g. 8×8 grid hypothesis + gradient/square detection), tested against `test/fixtures/pages-png/` and real-site fixtures recorded with the panel's Record-fixture button; first step also confirms the toolbar-click/`activeTab` flow on a real chess site.

---

## Session 1 — Milestone 1: scaffold + Maia-3 helper server ✅

**What works**
- Repo scaffold: `git init`, `server/`, `extension/` (README placeholder only), `docs/`, `test/` (README placeholder), `.gitignore`.
- `server/.venv` (Python 3.12.14 via `uv`; torch 2.14.1+cpu, maia3 0.1.0 pinned @`1e13597`, fastapi 0.143.3, uvicorn 0.54, python-chess 1.11.2, pytest, httpx). Setup commands: `server/README.md`.
- `server/maia_engine.py` — loads Maia3-5M once; `predict(fen, moves=None, elo_self=2400, elo_oppo=2400, top_k=3)`; legal-masked softmax, argmax top-1 (temperature-0 path), `--use-uci-history` reconstruction; ~10–15 ms/position on CPU.
- `server/app.py` — FastAPI on `127.0.0.1:8765`: `GET /health`, `POST /analyze`; dev CORS for localhost + `chrome-extension://` origins.
- Checkpoint cached at `~/.cache/huggingface` (`UofTCSSLab/Maia3-5M`, ~20 MB; first load downloads it).

**Run**
```bash
cd server
.venv/bin/python -m uvicorn app:app --host 127.0.0.1 --port 8765
curl -s http://127.0.0.1:8765/health
curl -s http://127.0.0.1:8765/analyze -H 'Content-Type: application/json' \
  -d '{"fen":"rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1"}'
```

**Test**
```bash
cd server && .venv/bin/python -m pytest tests -q     # 52 passed (~3 s)
.venv/bin/python tests/golden_report.py              # full table: docs/golden-report-m1.txt
```

**Observed outputs** (full detail incl. top-5 + golden table: `docs/golden-report-m1.txt`)
- `/analyze` startpos: e2e4 0.4649 · d2d4 0.3390 · g1f3 0.0818; wdl win 0.476 / draw 0.068 / loss 0.456; 13.8 ms.
- History `{"moves":["e2e4","e7e5"]}` → Nf3 0.7835 · Nc3 0.0826 · f4 0.0504.
- Golden vs real `maia3-uci` subprocess (temperature 0, Elo 2400, `--use-uci-history`): **6/6 positions match top-1 AND top-3 ordering** — startpos→e2e4, castling→e1g1, promotion→b7b8q, endgame→e1e2, middlegame→c1g5, history(1.e4 e5)→g1f3.
- WDL perspective check: two probes where the side to move is up a queen both return win≈0.98 ⇒ value head is side-to-move perspective (as documented in `maia3/uci.py`).
- Errors: bad FEN → 400 `{"detail":"invalid FEN: ..."}`, illegal history move → 400, out-of-range params → 422.

**Known issues / notes**
- First-ever load prints an unauthenticated-HF-hub warning; harmless. Pre-fetch with `.venv/bin/maia3-cache --model maia3-5m`.
- `/analyze` `wdl` is the value head for the *current* position (side-to-move perspective), not the per-candidate WDL printed on the CLI's MultiPV lines (different quantity; see `server/README.md`).
- No clock/time info is fed to the model (matches `maia3-uci` defaults; the 5M checkpoint uses `include_time_info=False`).
- `top_k` clamped 1..20 (Maia-3 MultiPV cap); Elo clamped 0..5000 by the model.

**Next — Milestone 2**: extension skeleton (MV3) + capture-source interface + browser-tab capture + offline fixtures in `test/` (screenshots + optional DOM ground truth). Contract is frozen: `POST /analyze {fen, moves?, elo_self?, elo_oppo?, top_k?} → {moves[{uci,san,prob}], wdl{win,draw,loss}, model, elapsed_ms}`.

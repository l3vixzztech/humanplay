# test/ — cross-cutting test assets

Server unit tests live in `../server/tests/`; everything here is shared by the
extension milestones.

```
fixtures/       offline fixture corpus (pages/, chesscom/, pages-png/, captures/)
                — see fixtures/README.md and fixtures/chesscom/README.md;
                chesscom/premove-takeback.html is the M7 take-back fixture
                (Benoni: their exd5 -> our cxd5 premove)
tools/          dev/test drivers
  fixture_server.py    serves test/fixtures/ on 127.0.0.1:8765: stub /health,
                       the side panel's snapshot intake, canned /analyze (M4),
                       canned /premove (M7) AND canned /explain (M8) responses
                       + test-only canned /llm/groq + /llm/gemini provider
                       stand-ins, with /debug/* control routes
                       (mode/delay/premove-delay/explain-delay/llm-mode/canned/
                       canned-premove/canned-explain/reset/stats)
  collect-canned.py    re-records those canned /analyze + /premove + /explain
                       responses from the REAL server into fixture_server.py +
                       captures/analyze/canned-report.json +
                       captures/premove/canned-premove-report.json +
                       captures/commentary/canned-explain-report.json
  adapter-unit.mjs     zero-dep unit tests for the M3 adapter's pure logic
  adapter-proof.mjs    CDP end-to-end proof of the M3 DOM adapter (manifest variant)
  analyze-unit.mjs     zero-dep unit tests for the M4 analysis client (injected fetch)
  analyze-proof.mjs    CDP end-to-end proof of the M4 analysis loop:
                       --stub (against fixture_server.py) and --real (real Maia server)
  overlay-unit.mjs     zero-dep unit tests for the M5 overlay geometry (square
                       centres, flipped mapping, offscreen rects, DPR, arrowheads)
  overlay-proof.mjs    CDP end-to-end proof of the M5 board overlay: canvas hygiene,
                       endpoints vs DOM ground truth (normal/flipped/scroll/resize),
                       clear cases, alternatives, multi-tab routing; optional
                       --real-page bonus on a real chess.com page
  tts-unit.mjs         zero-dep unit tests for the M6 TTS wording (SAN/UCI -> speech
                       matrix) + policy helpers (speak decision, dedupe, rate clamp)
  tts-proof.mjs        CDP end-to-end proof of the M6 voice announcements: 1 speak
                       per position + dedupe, stop->speak on a move, toggle off/on,
                       stale/assistant-off/error/game-over silence, hotkey + badge,
                       chrome.tts voices + the actionable note, and the
                       PANEL-CLOSED case (speaker lives in the service worker);
                       --no-speech-backend reruns it without
                       --enable-speech-dispatcher (the no-voice branch)
  premove-unit.mjs     zero-dep unit tests for the M7 premove client (injected
                       fetch: key/dedupe/stale/error mapping) + the premove speech
                       policy/text (premoveSpeakDecision, premoveSpeech)
  premove-proof.mjs    CDP end-to-end proof of the M7 premove planner:
                       --stub (fixture_server.py canned plans + DOM mutations for
                       the forced/robust/no-safe/stale cases) and --real (panel ==
                       curl /premove on the new premove-takeback fixture)
  commentary-unit.mjs  zero-dep unit tests for the M8 commentary: the /explain
                       client + feed driver (new-ply detection, cap, reset,
                       dedupe, suppression), the template matrix, the LLM prompt
                       builder/sanitizer and every LLM fallback (injected fetch,
                       injected chrome.permissions)
  commentary-proof.mjs CDP end-to-end proof of the M8 live commentary:
                       --stub (a 7-ply Italian replay through the production
                       adapter with the real-recorded canned facts, the canned
                       Groq/Gemini rephrasing, the 500/timeout fallbacks, the
                       toggle off, the new-game reset, the 52-ply cap, the stale
                       race) and --real (the 14-ply montage replayed, every entry
                       hand-verified, the last entry == curl /explain)
  acceptance-proof.mjs M9 CAPSTONE: one end-to-end run (real browser + real
                       extension + one fixture game) asserting the adapter, the
                       per-turn suggestions vs a direct request (curl in --real),
                       arrow endpoints ≤ 2 px, TTS speaks for suggestions AND
                       premoves with dedupe, premove cards with criteria, one
                       commentary entry per ply (both colours), the rematch
                       reset, the 104-ply soak, the 503/offline/recovery flow and
                       clean consoles, plus a best-effort real chess.com page
                       segment. --stub (fixture server + recorded canned bodies)
                       or --real (real Maia server + real curl)
  package-verify.mjs   proves a built zip loads: unzips it, checks every file is
                       byte-identical to extension/, loads it in Chrome and
                       asserts the MV3 service worker registers (called by
                       scripts/package-extension.sh)
  collect-acceptance-canned.py
                       records the acceptance game's /analyze + /premove +
                       /explain bodies from the REAL server into
                       captures/acceptance/canned-acceptance.json (stub mode)
  capture-proof.mjs    CDP proof of the M2 capture/recorder pipeline
groundtruth/    (planned, M3+) per-fixture known FENs, test-only ground truth
manual/         (planned, M6+) manual end-to-end scripts
```

## Rules

- **Offline only.** No network, no CDN: fixture pages embed their SVG board.
- **DOM ground truth is test-only.** Fixture pages expose their FEN in a hidden
  `#fen[data-fen]` element; the runtime pipeline never reads a real site's DOM
  (`../docs/PROJECT.md`).
- Nothing here may import or bundle Maia-3 code (AGPL boundary).
- The `/debug/*` routes of `fixture_server.py` are **test-only**; the shipped
  extension never calls them (the panel only uses `/health`, `/analyze`,
  `/premove`, `/snapshot`).

## Quick start

```bash
CHROME="$HOME/.cache/humanplay-chrome/chrome/linux-155.0.8059.84/chrome-linux64/chrome"

server/.venv/bin/python test/fixtures/generate.py        # regenerate M2 fixture pages
server/.venv/bin/python test/fixtures/generate_chesscom.py  # regenerate M3/M4 chess.com fixtures
python3 test/tools/fixture_server.py --port 8765         # browse the fixtures over HTTP
test/fixtures/render_pages.sh "$CHROME"                  # rasterize pages -> PNG

node test/tools/adapter-unit.mjs                         # 22 passed
node test/tools/analyze-unit.mjs                         # 22 passed (injected fetch)
node test/tools/overlay-unit.mjs                         # 13 passed (pure geometry)
node test/tools/tts-unit.mjs                             # 12 passed (formatter + policy)
node test/tools/premove-unit.mjs                         # 13 passed (client + premove policy/text)
node test/tools/commentary-unit.mjs                      # 18 passed (client + feed + phrase + LLM)
node test/tools/adapter-proof.mjs --chrome "$CHROME"
node test/tools/analyze-proof.mjs --chrome "$CHROME"     # stub mode (spawns the stub)
node test/tools/analyze-proof.mjs --chrome "$CHROME" --real   # needs the Maia server on 8765
node test/tools/overlay-proof.mjs --chrome "$CHROME"     # stub mode (spawns the stub)
node test/tools/overlay-proof.mjs --chrome "$CHROME" --real-page   # + real chess.com bonus
node test/tools/tts-proof.mjs --chrome "$CHROME"         # stub mode, speech backend flag on
node test/tools/tts-proof.mjs --chrome "$CHROME" --no-speech-backend --out-dir test/fixtures/captures/tts/no-backend
node test/tools/premove-proof.mjs --chrome "$CHROME"     # stub mode (spawns the stub)
node test/tools/premove-proof.mjs --chrome "$CHROME" --real   # needs the Maia server on 8765
node test/tools/commentary-proof.mjs --chrome "$CHROME"  # stub mode (spawns the stub)
node test/tools/commentary-proof.mjs --chrome "$CHROME" --real   # needs the Maia server on 8765

# M9 capstone (stub spawns the fixture stub; --real needs the Maia server)
server/.venv/bin/python test/tools/collect-acceptance-canned.py   # re-record the stub's acceptance bodies
node test/tools/acceptance-proof.mjs --chrome "$CHROME" --stub
node test/tools/acceptance-proof.mjs --chrome "$CHROME" --real
# packaging (builds + verifies dist/humanplay-1.0.0.zip in Chrome)
scripts/package-extension.sh
```

The proofs never touch the shipped manifest: they load a temporary copy whose
`content_scripts` / `web_accessible_resources` also match the fixture origin,
hash-compare every code file (`codeIdentical`) and report console cleanliness.

## Evidence

```
fixtures/captures/            M2: extension-captured PNGs + proofs
fixtures/captures/adapter/    M3: per-fixture proof JSONs + panel screenshots
fixtures/captures/analyze/    M4: unit results, stub/real proofs, per-case JSONs,
                              panel screenshots, canned-report.json (how the stub's
                              canned /analyze data was recorded from the real server)
fixtures/captures/overlay/    M5: unit results, overlay-proof.json + per-case JSONs,
                              screenshots of every board WITH arrows (incl. the
                              real-chess.com bonus shot real-chesscom-arrows.png)
fixtures/captures/premove/    M7: unit results, premove-proof-stub.json + per-case
                              JSONs (card per criterion, arrow endpoints, speech,
                              stale race), premove-proof-real.json +
                              real-takeback-equals-curl.json (panel == curl),
                              panel cards (stub-takeback-card.png, …) and the
                              dashed-arrow board shots (stub-takeback-arrow.png,
                              stub-flipped-arrow.png, real-takeback-arrow.png),
                              canned-premove-report.json (how the stub data was recorded)
fixtures/captures/commentary/ M8: commentary-unit.json, commentary-proof-stub.json +
                              per-case JSONs (the 7-ply Italian replay with exact
                              texts, the canned LLM rephrasing, the 500/timeout
                              fallbacks, the toggle off, the new-game reset, the
                              52-ply cap, the stale race), commentary-proof-real.json
                              + real-montage-replay.json (14 plies, entry == curl),
                              feed screenshots (stub-italian-feed.png,
                              stub-feed-cap-50.png, real-montage-feed.png, …) and
                              canned-explain-report.json (how the stub data was recorded)
fixtures/captures/tts/        M6: unit results, tts-proof.json + per-case JSONs,
                              panel screenshots (TTS card on/off, voices line,
                              opponent's turn, game over, panel-closed board) and
                              no-backend/ — the same proof run without
                              --enable-speech-dispatcher (0 voices -> the
                              actionable note + the speak path still recorded)
fixtures/captures/acceptance/ M9: acceptance-proof.json (the capstone: adapter,
                              replay with spot-checks + arrow geometry + TTS +
                              premove criteria + commentary, rematch reset,
                              104-ply soak, offline/recovery, real-page segment),
                              canned-acceptance.json (the recorded server bodies
                              the stub mode replays) and screenshots
                              (01-adapter-startpos.png … 06-real-chesscom-arrow.png)
fixtures/captures/package/    M9: package-verify.json — the built
                              dist/humanplay-<version>.zip was unzipped, loaded
                              in Chrome and its service worker registered
```

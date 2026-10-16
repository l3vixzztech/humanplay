# HANDOFF — session state log

> Update at the end of every session. Keep under one page. Newest entry on top.

## Hotfix v1.0.2 — M9.2: board-diff move tracking + highlight turn (long-game lockout) 🚑

**Reported live (after v1.0.1):** in a long bot game the card showed `0 moves · dropped`, a
`board-history-disagreement` mentioning a **2-move** list, `you play: unknown` and turn from
history-parity — no suggestions at all. Diagnosis from the reported FEN/late position: chess.com
renders only a **sliver** of the move list in long games (2 readable nodes) — replaying those from
the start position can never reconcile, so history died and the pipeline went idle.

**Fix (extension only):**
- **Board-diff move tracking (`historyStatus: "tracked"`)**: when no move-list candidate reconciles
  but the board is readable, the adapter follows the game by diffing placements — the unique legal
  move whose result equals the observed board (`findMovesToBoardField`, vendored chess.js). Seeds
  from the exact board-exposed FEN when available, else placement + the side-to-move ladder + a
  castling-rights heuristic (`seedCastlingRights`: a colour keeps its rights only while king + rook
  sit home — safe: a game without rights never castles). Castling/en-passant surprises against a
  heuristic seed re-seed the tracker at the observed position. The FEN **turn stays exact** after
  the first tracked move and suggestions/premove/commentary keep working (clients send the board
  FEN alone; Maia history planes are unavailable in tracked mode — documented).
- **Highlight-based side to move**: `detectSideToMoveFromHighlight` reads the last-move highlight
  (the piece colour on the highlighted squares = who just moved) and slots into the ladder
  clock → highlight → parity. This fixes "shows black's move when it is my turn".
- `you play: unknown` now points at the fallback-color select; the setting drives the gate when
  auto-detection fails.
- Mismatch diagnostics report the MOST COMPLETE candidate list (previously a 2-node artifact could
  be quoted in the banner).

**Verified:** adapter-unit **32/32** (+5: highlight turn, castling heuristic, explaining-move diff
incl. en passant, applyUciToFen); adapter-proof **ALL PASSED** with a new dedicated
`board-tracking` case on the new `highlight-turn` fixture (no move list at all → highlight turn
`w` → tracked Nf3 → turn `b`, `historyTracking.moves` 1); acceptance `--real` against the live
server **ALL PASSED** (rematch + 104-ply soak). **Extension reload required; server unchanged.**

## Hotfix v1.0.1 — M9.1: move-list reconciliation + resilient replay (live-game mismatch) 🚑

**Reported in live play:** the panel repeatedly showed `mismatch: history-unreliable … (move list
had N moves)` plus `side to move inferred from history-parity` — history dropped on every update,
side-to-move possibly wrong. Root-cause class: `findMoveList()` accepted the **first** list element
with nodes; on a page with several move lists (previews, analysis panels, stale SPA content) or with
a stray/duplicated SAN-shaped node, the single replay failed forever → board-only fallback.

**Fix (extension only — server untouched):**
- `readHistoryCandidates()` collects **every** readable history candidate (all move-list containers,
  de-duplicated, verified structure first; then chess.com's own SAN history as a last resort).
- `computeState` reconciles EVERY candidate against the board — exact replay first, then the new
  `replaySanListResilient()` (continue-on-error) for stray/duplicated DOM tokens — and accepts only
  the candidate whose **end position matches the board**. The list that belongs to the board wins.
- `history-unreliable` mismatches now carry `reason` + `failedAt` + `failedToken` (previously the
  panel showed only the generic note) — the next occurrence is self-diagnosing.
- Regression traps: fixtures `multi-list` (decoy list first) and `artifact-token` (duplicated
  SAN-shaped node); adapter-unit +5 resilient-replay tests; acceptance tool version pin made
  semver-generic.

**Verified:** adapter-unit **27/27**; adapter-proof **ALL PASSED** (8 fixtures incl. both traps);
acceptance `--real` against the live server **ALL PASSED** (rematch + 104-ply soak included).
**Extension reload required** (`chrome://extensions` → Reload); the server does not need a restart.

## Post-release audit — 2026-10-17 (reviewing session, outside the session loop)

- Full regression rerun on `a8460bf` (+ the README screenshot commit): **package-verify,
  capture-proof, adapter-proof, analyze-proof, tts-proof, premove-proof, commentary-proof,
  acceptance stub + acceptance real (+real-page) all PASSED**; pytest **106** + **100** unit
  tests green; zip sha256 `5d3f7c6c…` re-verified by loading the unzipped package in Chrome.
- `overlay-proof.mjs` flaked ONCE inside the long sequential batch (`overlay-startpos`: SW routed
  to tab `undefined` — tab-id race under load) and **PASSED 9/9 when rerun standalone** →
  harness flake, not a product regression. If it flakes again, rerun it standalone before
  investigating the adapter/SW.
- Release: v1.0.0 published on GitHub with `dist/humanplay-1.0.0.zip` attached; repo pushed
  (private) at github.com/l3vixzztech/humanplay.

## Session 9 — Milestone 9: robustness, docs, packaging, v1.0.0 ✅ (final milestone of the initial scope)

**What works**
- **`extension/` 1.0.0**, server `/health` v1.0.0 (additive `version` + `uptime_s`;
  the panel shows `online · maia3-5m · v1.0.0`). No new permissions anywhere
  (`activeTab`, `storage`, `sidePanel`, `downloads`, `tts` + the two optional LLM
  origins); no `<all_urls>`; endpoint contracts unchanged except the additive
  `/health` fields.
- **Robustness (deliverable 1)**
  - all three clients (`analyze-client.js`, `premove-client.js`,
    `explain-client.js`) now retry **once on HTTP 503 after a 300 ms backoff**
    (`RETRY_503_DELAY_MS`, injectable `delayImpl`, `attemptLog` outcome
    `engine-503`) in addition to the existing single network retry; never on 4xx,
    never a third attempt, never on a timeout. Unit-tested in all three suites and
    proven end-to-end (fixture-server arrival counters = 2/request).
  - **one offline UX**: `offlineCardMessage()` is the single wording every card
    uses (exact URL + retry count + start command) and the Server card has a
    **Copy start command** button (`navigator.clipboard` with an
    `execCommand` fallback; the click is recorded in
    `__humanplayAnalysis.clipboard`). **Auto-recovery**:
    `scheduleServerRecovery()` polls `/health` (3 s, ≤60 attempts) whenever a card
    is offline and re-runs all three policies for the current position when the
    server returns (failures are never cached).
  - **the rematch reset** is complete and proven: `resetLayersForNewGame()` runs
    once per new `sessionSeq` (idempotent, called by whichever policy sees it
    first) and the record `gameReset.last.cleared` documents exactly what was
    cleared — caches (analyze/premove/explain), **spoken TTS keys**, the premove
    plan, the commentary entry snapshot — plus `clear-suggestion`/`clear-premove`
    with reason `new-game`. The fresh game then re-analyzes normally.
  - the **soak** (104 plies) runs silent (TTS off on purpose) and asserts:
    exactly one overlay canvas, feed pinned at 50/50 (newest = last ply,
    evictions counted), caches ≤ 24/24/24, spoken keys ≤ 64, **zero new**
    commentary errors (delta — the offline segment's earlier errors stay
    counted), zero speaks.
  - adapter warnings now append the **fast-fix snapshot protocol** line
    ("Record chess.com snapshot" + the replay README); the acceptance proof
    forces a real warning and asserts the line reaches the panel.
- **Packaging (deliverable 2)**: `scripts/setup-server.sh` (idempotent; verified
  by re-running it against the existing venv), `scripts/run-server.sh`,
  `scripts/package-extension.sh` → `dist/humanplay-1.0.0.zip`
  (159085 bytes, sha256 `5d3f7c6c…`) which is then **verified**: unzipped into a
  temp dir (all 29 code files hash-identical to `extension/`), loaded in Chrome
  for Testing, **MV3 service worker registered** — `test/tools/package-verify.mjs`
  → `test/fixtures/captures/package/package-verify.json`.
- **Docs (deliverables 3+5)**: top-level `README.md` (what/quick start/features/
  controls/troubleshooting/fair-play/l licensing/evidence), `docs/USER-GUIDE.md`
  (plain language: install → first run → controls → settings reference →
  troubleshooting incl. the Linux speech flag and the snapshot fast-fix → FAQ),
  `docs/RELEASE-NOTES.md` (feature→evidence map), `docs/PROJECT.md` M9 section +
  "Status: v1.0.0 (personal build)" + **Future ideas**.
- **The acceptance proof (`test/tools/acceptance-proof.mjs`)** — one run, real
  browser, real extension, one fixture game replayed ply by ply via DOM
  mutations; one machine-readable report (`acceptance/stub|real/`):
  adapter FEN + warning fast-fix line; per-user-turn suggestions **equal to a
  direct server request** (`curl /analyze` in real mode); arrow endpoints ≤ 2 px
  vs DOM ground truth; **TTS speaks recorded for suggestions AND premoves**
  (7+3) with 3 re-emit dedupes; premove cards with criteria / honest refusals;
  one commentary entry per ply (both colours, `you`/`opponent`); the rematch
  reset (record equality per layer); the **104-ply soak**; the **503 retry +
  offline cards + Copy button + auto-recovery** (stub); clean consoles; plus a
  best-effort real chess.com page segment (routed e2e4 arrow + screenshot).

**Results (evidence: `test/fixtures/captures/acceptance/`, `package/`)**
- `server` **`106 passed`** (79 + 27 explain + the M9 health fields test updated;
  `/analyze` + `/premove` untouched).
- units: `adapter-unit` **22**, `analyze-unit` **22** (+2: 503 retry matrix),
  `overlay-unit` **13**, `tts-unit` **12**, `premove-unit` **13** (+1),
  `commentary-unit` **18** (+1) — **100 unit tests**, all green.
- **acceptance --stub: ALL ACCEPTANCE CASES PASSED** — adapter ✓ (card FEN +
  the forced warning carrying the fast-fix line), replay ✓ (14 plies, 7/7
  spot-checks equal, endpoints 0.00 px, 7 suggestion + 3 premove speaks,
  3 re-emit dedupes), rematch ✓ (cleared analyze 8 / premove 7 / explain 14 /
  spoken keys 11 / premove plan 1; feed 0; fresh game live), offline ✓ (503
  arrivals 2/2; every card actionable; copy ok; recovered after 1 health check),
  soak ✓ (104 plies in **103.4 s**, feed **50/50**, caches **24/24/24**, spoken
  keys 1, **1 canvas**, 0 new errors, 0 speaks).
- **acceptance --real --real-page: ALL ACCEPTANCE CASES PASSED** — real Maia
  server (`version 1.0.0`), every user turn cross-checked against real
  `curl /analyze` (7/7 equal), same rematch + soak (104 plies in **22.0 s**,
  feed 50/50, caches 24/24/24, 1 canvas), and the **real chess.com page segment
  PASSED**: one suggestion routed through the real SW → content-script path onto
  a live game page (`2r5/8/8/7k/8/5N2/6P1/5nK1 w - - 0 1`), arrow endpoints
  **≤ 0.00 px** vs the page's painted pieces, screenshot
  `real/06-real-chesscom-arrow.png`.
- regressions all green: `adapter-proof` ALL PASSED, `analyze-proof --stub` ALL
  PASSED, `overlay-proof` ALL PASSED, `tts-proof` ALL PASSED (all 9 cases;
  14805 voices), `premove-proof --stub` ALL PASSED, `commentary-proof --stub`
  ALL PASSED, plus the M2 `capture-proof` exit 0.
- M9 screenshots: `stub/01-adapter-startpos.png` … `stub/05-soak-feed-capped.png`
  (including `04-offline-cards.png` + `04-recovered.png`), `real/…` and
  `06-real-chesscom-arrow.png`.

**Exact commands**
```bash
CHROME="$HOME/.cache/humanplay-chrome/chrome/linux-155.0.8059.84/chrome-linux64/chrome"

# server + units
cd server && .venv/bin/python -m pytest tests -q            # 106 passed
node test/tools/adapter-unit.mjs                            # 22 passed
node test/tools/analyze-unit.mjs                            # 22 passed
node test/tools/overlay-unit.mjs                            # 13 passed
node test/tools/tts-unit.mjs                                # 12 passed
node test/tools/premove-unit.mjs                            # 13 passed
node test/tools/commentary-unit.mjs                         # 18 passed

# M9 capstone (stub spawns the fixture server; --real needs the Maia server)
server/.venv/bin/python test/tools/collect-acceptance-canned.py      # re-record canned bodies
node test/tools/acceptance-proof.mjs --chrome "$CHROME" --stub --out-dir test/fixtures/captures/acceptance/stub
server/.venv/bin/python -m uvicorn app:app --host 127.0.0.1 --port 8765 --app-dir server
node test/tools/acceptance-proof.mjs --chrome "$CHROME" --real --real-page --out-dir test/fixtures/captures/acceptance/real

# packaging (builds + verifies dist/humanplay-1.0.0.zip in Chrome)
scripts/package-extension.sh
scripts/setup-server.sh          # idempotent (verified by re-running)

# regressions (stub modes; each spawns its own stub)
node test/tools/adapter-proof.mjs    --chrome "$CHROME"
node test/tools/analyze-proof.mjs    --chrome "$CHROME"
node test/tools/overlay-proof.mjs    --chrome "$CHROME"
node test/tools/tts-proof.mjs        --chrome "$CHROME"
node test/tools/premove-proof.mjs    --chrome "$CHROME"
node test/tools/commentary-proof.mjs --chrome "$CHROME"
# M2 capture regression (fixture server up):
python3 test/tools/fixture_server.py & \
node test/tools/capture-proof.mjs --chrome "$CHROME" --extension extension --manifest-all-urls \
  --page-url http://127.0.0.1:8765/pages/startpos.html --expect-chip online
```

**MANUAL CHECKLIST (the point of M9 — state honestly what only a human can verify)**
1. **Fresh install following ONLY `docs/USER-GUIDE.md`** on a clean profile:
   `scripts/setup-server.sh` → Load unpacked → bot game → suggestion + arrow.
   Report any step the guide does not cover.
2. **Real game with everything on**: arrow + Voice (TTS) + premove + commentary
   in one live bot game; check the arrow aligns with the board, speech is
   intelligible ("Knight to f3" / "premove …"), the premove card appears on
   their turn, and every move gets a commentary sentence within ~1 s.
3. **Rematch**: the feed clears, the arrows go, the first move of the new game
   starts a fresh suggestion/premove/entry (the panel message is brief by
   design: the fresh analysis replaces it immediately).
4. **Kill the server mid-game** (Ctrl+C in the server terminal): all cards show
   the offline state with the start command within ~1 s; restart it with
   **Copy start command** → within a few seconds the cards recover by
   themselves (no clicking).
5. **TTS audio with `--enable-speech-dispatcher` in a real Chrome** (not
   Chrome for Testing): audibility/quality on this box's espeak-ng; the
   automated proof only asserts the speak *path* + recorded calls.

**Deviations / notes**
- the proof's soak is **silent by design** (TTS off; the earlier draft spoke 50+
  synthetic "premove knight…"/"knight to c3" lines out loud — poor UX, changed):
  the TTS dedupe bound is covered by `tts-unit.mjs` and the rematch-reset record.
- the soak's canned bodies are **deterministic synthetic** (leak-freedom, not
  fact correctness); the replay's bodies are real-server recordings.
- the rematch reset's transient UI (message / clear reasons) is overwritten in
  the same event-loop turn by the fresh analysis, so the proof asserts the
  **reset record** (exact cleared counts per layer) + the message counters +
  the sampler's first post-reset snapshot (feed 0, plan null) instead.
- the **real-page** segment is best-effort: it collects the state in the panel
  filtered by `chess.com` sender URL and re-installs its main-world helper after
  SPA navigations; a blocked attempt is recorded, not failed.
- **memory** over a long session is not measured headlessly (documented; use a
  DevTools memory profile manually).
- the fixture server now mirrors the additive `/health` fields
  (`version: "fixture-1.0.0"`, `uptime_s`).
- `collect-acceptance-canned.py` records exactly the panel's request keys
  (8 analyze + 7 premove + 14 explain for the 14-ply acceptance game).

**Next (if this project continues)** — see "Future ideas" in `docs/PROJECT.md`:
Piper voice upgrade, commentary TTS, desktop-capture revival, parked pixel
recognition, custom LLM endpoints, premove `mode=all` tuning, opening
transpositions, distribution packaging. The M9 scope is complete; nothing is
blocked.

## Session 8 — Milestone 8: live commentary (facts engine + templates + optional LLM phrasing) ✅

**What works**
- `extension/` **0.7.0**. Manifest: **no new required permissions** (`tts`,
  `activeTab`, `storage`, `sidePanel`, `downloads` unchanged), no `<all_urls>`;
  the only addition is `optional_host_permissions` for the two LLM providers
  (`https://api.groq.com/*`, `https://generativelanguage.googleapis.com/*`),
  requested at enable-time (`chrome.permissions.request`), never required.
- **Server: `POST /explain` (additive; `/analyze` + `/premove` untouched,
  `predict` unmodified, the 79 old tests still pass)** —
  `server/explain_engine.py` explains the **LAST ply** of `moves`:
  `{fen, moves, elo_self, elo_oppo}` (Elos clamp 0–5000) →
  `{move{san,uci,by,ply,moveNumber}, flags{capture,check,mate,castle,
  promotion,enPassant,recapture}, material{delta,captured}, maia{playedProb,
  rank,totalLegal,top[3],moverElo}, wdl{before,after}(mover's perspective),
  opening{eco,name}|null, classification, model, elapsed_ms}`.
  Documented bands: **mainline = rank 1**, **common p ≥ 10 %**,
  **uncommon 3–10 %**, **rare < 3 %** (probability bands, never judgement
  words). `recapture` is the M8 flag: the previous ply captured on the same
  square. Invalid FEN / illegal or unparseable history moves / engine-level
  empty `moves` → **400**; a missing/shape-broken `moves` list → 422 (pydantic).
  **Timings: engine 21–31 ms/article (pytest) — target ≤ 100 ms for 2 Maia
  forward passes; real-proof round-trips 37–76 ms typical (one 128 ms outlier
  under replay load, documented).**
- **ECO/opening names**: bundled `server/data/openings_eco.json` from
  **lichess-org/chess-openings**, license **verified clean (CC0-1.0, public
  domain dedication)** before bundling — provenance, upstream SHA-256s and the
  regeneration script (`server/tools/generate_openings.py`, 3865 openings) in
  `server/data/README.md`. Longest SAN **prefix** match; `opening` is **always
  null when the base FEN is not the standard start position** (honest: the
  pre-base moves are unknowable); transpositions via a different move order are
  not recognized (documented). No new runtime deps.
- **`src/analysis/explain-client.js` (new, pure)**: the `/explain` client
  (key `fen|moves|elo_self|elo_oppo`, LRU(24), in-flight dedupe, stale guard,
  4 s timeout, exactly one network retry, injectable fetch, same error classes)
  + **the feed driver `createCommentaryFeed()`**: request iff the adapter's
  `movesUci` grew by **exactly one ply** (both colors); first state seeds the
  baseline; a jump > 1 ply is skipped; re-emits are no-ops; **dedupe by ply**;
  `sessionSeq` change clears + re-seeds; toggle off ⇒ `suppressed` (no request,
  no retro-explain); entries newest-first, cap **50**. `buildExplainRequest()`
  returns **null** without a usable history (mismatch never guesses).
- **`src/commentary/phrase.js` (new, pure, zero-dep)**: one sentence per move —
  `<SAN> — <event from flags>; <maia clause from the band>.` Event: capture on
  `<sq>` / recapture / castling side / promotion to a piece / en passant /
  check|checkmate. Maia clause always carries numbers: mainline → "the most
  common move at 2400 (46 %)" (castle → "the main line"; recapture → "98 % of
  2400s take back"), common → "a common choice at 2400 (17 %); Maia's pick was
  c5 (37 %)", uncommon → same with "uncommon at", rare → "only 0.2 % play this;
  Maia's pick was Nc3 (43 %)". Chips: `main line` / `common` / `uncommon` /
  `rare` (documented).
- **Panel "Commentary" card (M8)**: toggle **Explain moves** (default **ON**,
  persisted; **not** gated by the assistant switch — it never suggests a move);
  feed newest-first with move header (SAN + `you`/`opponent`), chip, text, meta
  (`engine template | <provider> rephrasing · llm … ms · engine … ms ·
  round-trip … ms · ECO name · ply N`); **Phrasing** select
  [Templates (default) | Groq | Gemini]; **API key** input (masked, cleared
  after storing, placeholder `•••••• stored`); **Test connection**; the
  mandated privacy line "positions are sent to `<host>`" when a provider is
  selected; feed meta (`N of the last 50 plies explained · phrasing …`).
- **`src/commentary/llm.js` (new, pure)**: fixed providers (Groq OpenAI chat /
  Gemini generateContent), the **mandated system prompt verbatim** + facts JSON,
  sanitizer (fences/backticks/quotes/chatty lead-in, whitespace, **cap 220
  chars**), **2.5 s timeout → template fallback**, every failure (no key, no
  permission, HTTP, provider error, empty body) keeps the template text and the
  meta notes the fallback. The entry renders with the template **immediately**;
  the provider text is swapped in place. **Key hygiene:** `chrome.storage.local`
  only (never `sync`), never logged, never in the DOM, sent as a **header**
  (Groq `Authorization`, Gemini `x-goog-api-key` — never a URL). Test-only seam
  `__humanplayAnalysis.commentaryTest.setLlmEndpoint(engine, url)` (documented,
  like `__humanplayTtsTest`); custom provider URLs are **out of scope (future)**.
- **No TTS for commentary** — explicitly out of scope (noted as future work).

**Results (evidence: `test/fixtures/captures/commentary/`)**
- `server` **`106 passed`** (79 old + 27 new `tests/test_explain.py`):
  hand-verified cases — 1.e4 (mainline, B00 King's Pawn Game), 4.Bxc6 (capture,
  common rank 2, C68), 5.cxd5 (recapture, A60), 4.O-O / 5.O-O-O (both castles),
  a8=Q+ (promotion + check, 89 %), Re7+ (rare, rank 11/17, plain check),
  4.Qxf7# (mate, WDL after = win 1), 3.exd6 e.p. (captured pawn on d5),
  1.Nh3 (rare 0.027 %, rank 18/20 — Maia's pick e4 46 % surfaced), 2...d6 /
  2...Nf6 (black-to-move parity), Qg6 stalemate (rules draw 1.0), the bands,
  the ECO lookup, contract 400s/422s, Elo clamps, determinism, perf.
- `commentary-unit.mjs` **17/17** (client contract/retry/errors, cache/dedupe/
  stale, the feed driver incl. cap/reset/dedupe/suppression, the full template
  matrix against recorded facts, the prompt builder, the sanitizer + 220-char
  cap, every LLM fallback, permissions, display helpers).
- `commentary-proof.mjs` **stub — ALL 7 CASES PASSED** (fixture server spawned
  by the proof; the canned /explain bodies are **recorded from the real
  server**, `canned-explain-report.json`):
  - **S1 Italian replay**: the 7-ply game replayed move-by-move via DOM
    mutations — 7 entries, **both colors** (playerLabel you/opponent), exact
    texts + chips (recorded facts), newest first, **1 /explain request per ply**,
    0 canned misses, mutation→entry **155–200 ms**, engine 21–33 ms;
  - **S2 LLM rephrasing**: canned Groq + Gemini text replaces the template
    (`source` groq/gemini, meta `groq llama-3.1-8b-instant · llm … ms`), the
    API key appears in **no DOM node**, the input is empty after storing,
    `chrome.storage.sync` untouched (0 keys);
  - **S3 fallbacks**: provider 500 and a 3 s delay (> 2.5 s timeout) both keep
    the template text and the meta notes `llm http|timeout: fallback to template`;
  - **S4 toggle off**: 0 /explain attempts for the next ply, no entry, and no
    retro-explaining when it goes back on (the following ply is explained);
  - **S5 new-game reset**: move list back to start → `sessionSeq` 0→1, feed
    cleared, baseline re-seeded, next move explained again;
  - **S6 52-ply cap**: a knight shuffle replayed move-by-move (runtime-canned
    bodies, documented) → **52 explained, feed holds 50 (plies 52..3)**, all
    four chips present, ~10 s replay;
  - **S7 stale race**: a 900 ms-delayed ply-53 article superseded by ply 54 is
    discarded (`staleDiscards 0→1`, no ply 53 in the feed, no out-of-order).
- `commentary-proof.mjs` **real — ALL PASSED**: the 14-ply fixture montage
  (both castlings + captures) replayed move-by-move through the production
  adapter; **every entry's text equals the hand-verified recorded facts**
  (e.g. ply 7 `O-O — castling kingside; a common choice at 2400 (22 %); Maia's
  pick was c3 (39 %).`, ply 12 black `O-O … only 3 % play this; Maia's pick
  was h6 (81 %)`, ply 13 `Bxf6 — a capture on f6; only 0.2 % play this; …`,
  ply 14 `Qxf6 — a recapture; 99 % of 2400s take back.`) and **ply 14 EQUALS a
  direct `curl /explain`** phrased by the panel's own module (text +
  classification + opening + `playedProb` 0.992488 value-identical);
  mutation→entry **193–287 ms**, engine 38–76 ms typical (one 128 ms outlier),
  console clean.
- Regressions all green: `premove-proof` ALL PASSED, `tts-proof` ALL PASSED
  (14805 voices), `overlay-proof` ALL PASSED, `adapter-proof` ALL PASSED,
  `analyze-proof --stub` ALL PASSED, server `106 passed`.
- Screenshots: `stub-italian-feed.png` (the feed: newest O-O on top),
  `stub-llm-rephrasing.png`, `stub-llm-fallback.png`, `stub-toggle-off.png`,
  `stub-new-game-reset.png`, `stub-feed-cap-50.png`, `stub-stale-race.png`,
  `real-montage-feed.png`.

**Exact commands**
```bash
CHROME="$HOME/.cache/humanplay-chrome/chrome/linux-155.0.8059.84/chrome-linux64/chrome"
cd server && .venv/bin/python -m pytest tests -q           # 106 passed
node test/tools/commentary-unit.mjs                        # 17 passed
node test/tools/commentary-proof.mjs --chrome "$CHROME"    # stub: 7 cases, ALL PASSED (spawns the stub)
cd server && .venv/bin/python -m uvicorn app:app --host 127.0.0.1 --port 8765
node test/tools/commentary-proof.mjs --chrome "$CHROME" --real   # 14-ply replay, entry == curl
# regressions (all ALL PASSED)
node test/tools/premove-proof.mjs --chrome "$CHROME"
node test/tools/tts-proof.mjs --chrome "$CHROME"
node test/tools/overlay-proof.mjs --chrome "$CHROME"
node test/tools/adapter-proof.mjs --chrome "$CHROME"
node test/tools/analyze-proof.mjs --chrome "$CHROME"
# re-record the stub's canned data (real server must be running):
server/.venv/bin/python test/fixtures/generate_chesscom.py   # unchanged by M8
python3 test/tools/collect-canned.py                         # now also CANNED_EXPLAIN
# regenerate the bundled ECO table (provenance: server/data/README.md):
server/.venv/bin/python server/tools/generate_openings.py
```

**Automatic vs manual**
- Delivered by tests: the fact engine (recorded model values + hand-checked
  rules), the bands + ECO lookup, the contract/clamps, the client
  key/dedupe/stale/error mapping, the feed driver (trigger/cap/reset/dedupe/
  suppression), the template matrix, the LLM prompt/sanitizer/timeout/fallbacks,
  the key hygiene, the card + chips + meta, the stub replay (both colors, exact
  texts), the new-game reset, the 50-ply cap, the stale race, and the real-mode
  panel == curl equality.
- **Only a human can verify (below)**: the live commentary in a real game
  (timing + phrasing feel), the toggle behaviour in practice, and **real LLM
  calls** (they need a real user key + the provider host-permission grant —
  the automated proof uses the fixture server's canned provider stand-ins).

**MANUAL CHECKLIST (what only a human can verify — the point of M8)**
1. **Real game with uvicorn + Chrome loaded (0.7.0, templates)**: load unpacked,
   open a chess.com bot game — after **your** move and after **the opponent's**
   move a new Commentary entry must appear within ~1 s, with the move header
   (`you`/`opponent`), a classification chip and one factual sentence. No key,
   no network needed.
2. **Toggle off stops it**: untick **Explain moves** → make a move: no new entry
   and no `/explain` request; tick it back on → the *next* move is explained
   (the missed one is not retro-explained).
3. **Groq/Gemini with a real key**: pick a provider, grant the host permission
   when Chrome asks, paste a key, press **Test connection** (expect "OK in …
   ms"), then move: the sentence should be rephrased conversationally (same
   facts, no new tactics). **The key must stay local** — reload the panel: the
   input is empty and the placeholder says "stored"; `chrome.storage.local`
   holds `settings.llmApiKey`; `chrome.storage.sync` stays empty; the DOM never
   contains it. Compare Groq vs Gemini vs Templates phrasing.
4. **Templates with no key/network**: pick Templates (or stop uvicorn — the card
   shows "server offline" with the start command and recovers) — templates are
   the default and need neither.
5. **New game**: start a rematch → the feed clears (message "new game —
   commentary feed cleared (N entries)") and the next move starts a fresh feed.

**Deviations / notes**
- The commentary **ignores the assistant master switch** (its own toggle is the
  control): it never suggests a move, so it stays useful with the assistant off;
  documented in the card hint + PROJECT.md.
- The **first observed state of a session only seeds the baseline** — a panel
  opened mid-game does not explain the moves it never witnessed (commentary
  starts with the next move). A mismatch (board ≠ move list) consumes the ply:
  no guessed article, no retro-explain.
- The **stale guard discards an article whose ply was superseded** while it was
  in flight (consistent with M4/M7; in a real game answers land in ~50 ms). The
  synthetic `inactive:<session>:<ply>` key invalidates in-flight articles when
  the observed position cannot be explained at all.
- **Perf**: target ≤ 100 ms/article met in isolation (pytest 21–31 ms); the
  real-mode replay measured 38–76 ms typical with one **128 ms** outlier while
  Chrome + Node + the server shared the CPU (recorded, not hidden).
- The **50-ply cap case** registers deterministic **synthetic** canned bodies at
  runtime (`/debug/canned-explain`) because recording 54 real articles would pin
  a meaningless shuffle; the cap/order logic under test does not depend on the
  facts (fact correctness is covered by S1 + the real mode). Documented in the
  case JSON + the proof comment.
- The **provider host permission grant is manual** (a real user gesture cannot
  be produced headlessly); the proof asserts the manifest's
  `optional_host_permissions` + the request path is exercised against the
  fixture server, whose localhost origin is already permitted. **Custom provider
  URLs are out of scope** (future work).
- The card's "Test connection" sends one minimal call; the key is never part of
  any error string (asserted in the unit tests).
- `collect-canned.py` now also records `CANNED_EXPLAIN` (14 unique per-ply keys:
  the 7-ply Italian prefixes coincide with the montage's first 7); the fixture
  server grew `/explain`, `/llm/groq`, `/llm/gemini`, `/debug/explain-delay`,
  `/debug/canned-explain`, `/debug/llm-mode` and the matching counters.

**Next — Milestone 9**: continuous mode + robustness + polish + packaging
(state-driven auto-analysis loop, failure recovery for page variants, UX,
store-ready packaging). Commentary TTS and custom LLM endpoints stay listed as
future work.

---

## Session 7 — Milestone 7: premove planner (server criteria engine + panel + dashed arrow + speech) ✅

**What works**
- `extension/` **0.6.0** (overlay m7.0). **No new permissions** (checked by the
  proof), manifest still chess.com-only, one host permission, one `tts`.
- **Server (Task 0 of the milestone): `POST /premove`** — `server/premove_engine.py`
  (criteria engine, formulas documented in the module + PROJECT.md) +
  `maia_engine.move_probabilities()` (full legal-move softmax; **`predict` was
  not modified** and `/analyze` is byte-identical — the 55 old tests still
  pass). Request `{fen, moves?, elo_self, elo_oppo, top_n=5 (clamp 1..12),
  min_safety=0.90 (clamp 0.5..1.0), mode="top"|"all"}`; the response carries
  `opponent`, `recommended|null`, `candidates` (safe/guard masses + verdict +
  why), `excluded` (terminal replies), `reason`, `params`, `timings_ms`.
  Criteria: `safety = safe_mass + guard_mass` (guard = the premove is illegal
  after their move → safe by inaction); recommend iff `safety ≥ min_safety` ∧
  `safe_mass > 0` ∧ `min_response_prob ≥ 0.15` (server constant, not a request
  field); criterion `forced` / `safe_vs_all` / `robust`; the opponent's
  candidates come from Maia(elo_oppo), our replies from Maia(elo_self) — the Elo
  pair is swapped because Maia conditions on the side to move. **Timings: top
  mode ≈ 90 ms engine (target ≤300 ms), all mode 0.45–0.8 s for 20–31 legal
  moves (target ≤1.5 s), single forward pass ~14 ms.**
- **`src/analysis/premove-client.js` (new, pure)**: the analyze-client patterns
  — position key `fen|moves|elos|top_n|min_safety|mode`, LRU(24), in-flight
  dedupe, stale guard, 5 s timeout, exactly one retry on a network failure,
  injectable fetch, same error classes; `buildPremoveRequest` reuses the M4
  mapping (replayed history → startpos+moves; mismatch → board FEN);
  `premoveGate` = assistant on + state ok + color known + **their** turn;
  `criterionLabel`/`premoveCaveat` for the panel wording.
- **Panel "Premove" card (M7)**: active on the opponent's turn — recommendation +
  criterion chip (`forced` / `robust vs 94%` / `safe vs all replies`), safety %,
  min response prob, the `detail` line, their top-3 likely moves with % (mating
  ones marked), `planning…`, the honest `no safe premove` + reason state, the
  mandated mode-"top" caveat, meta line; **"waiting for your move"** on our turn;
  settings **Show premove arrow** (default ON, effective only under "Show
  arrows") + **Speak premoves** (default ON), both persisted.
- **Overlay**: the premove is a **dashed blue arrow** (`rgba(64,150,255,0.95)`,
  solid head) drawn through the existing canvas + geometry
  (`humanplay:premove` / `:clear-premove` via the SW); independent from the
  suggestion set (a manual analysis on their turn shows both — recorded);
  a stale result never touches what the newer position published.
- **TTS**: "premove knight takes d5" — `premoveSpeech()` (M6 formatter) +
  `premoveSpeakDecision()` (Voice on + Speak premoves on + assistant on +
  **their** turn + recommendation + current key + dedupe key
  `premove:<key>:<uci>`), executed by the M6 service-worker speaker
  (stop-before-speak, `enqueue:false`, rate). Toggling Voice / "Speak premoves"
  on speaks the current premove once (forced = dedupe bypass only).
- **Trigger**: after our move lands; ready ≤ ~600 ms. **Stale race**: if the
  opponent moves while the plan is in flight, `stale` discards everything (no
  render, no arrow, no speech).
- Task 0: the stale `speaker.js` comment about `getVoices()` was corrected
  (0 at cold start → enumerates 14805 with `--enable-speech-dispatcher`; 0 with
  utterances erroring without it).

**Results (evidence: `test/fixtures/captures/premove/`)**
- `server` **`79 passed`** (55 old + 24 new `tests/test_premove.py`): forced
  recapture (`8/1n4b1/4K3/5N2/4R3/3k4/1R1Qr1Q1/8 b` → only Rxd2, premove Qxd2+
  31.1%); guard recapture (Benoni 4...exd5 76.6% → 5.cxd5 recapture, quiet moves
  leave our pawn on d5 so cxd5 is illegal → guard 23.4%, safe_vs_all); strict
  null (Italian, Nf6 67% / Bc5 23% → `d3` covers only 67% < 90%); safe_vs_all
  endgame (4 legal king replies all met by **b8=Q+**, min 97%); mate exclusion
  (after 1.f3 e5 2.g4, Qh4# 33.4% excluded + `reason`, strict → null, bar 0.5 →
  gxh5 recommended *and still excluded*); the response floor; clamps; contract;
  mode "all" = every legal move; determinism; perf recorded.
- `premove-unit.mjs` **12/12** (client key/dedupe/stale/errors + request builder
  + gate + criterion label/caveat + `premoveSpeech` matrix + the
  `premoveSpeakDecision` never-speak matrix).
- `premove-proof.mjs **stub` — ALL 9 CASES PASSED**: take-back card (cxd5,
  safe_vs_all, safety 100%, min-prob 98.4%, exd5 96.3% top row, caveat) + dashed
  arrow **0.00 px** vs DOM ground truth; exactly one speak `"premove c-pawn
  takes d5"` (stop-before-speak, 4 ms after the toggle) and a re-emit deduped;
  the robust mutation (9 plies) → `robust vs 99%` + `"premove e-pawn to e4"`,
  mutation→render **157 ms**; the forced mismatch mutation → criterion `forced`
  from the board-only key + `"premove queen takes d2, check"`; the no-safe state
  (startpos + 1.e4) → 0 arrows, 0 speaks; the stale race (900 ms delayed plan
  superseded) → `staleDiscards 1`, the newer plan kept, no stale arrow/speech;
  gating (our turn 0 requests, assistant off 0 requests, TTS off 0 speaks);
  flipped board cxd4 dashed **0.00 px**. Console clean, `codeIdentical` 26/26.
- `premove-proof.mjs **real` — ALL PASSED: the panel for
  `chesscom/premove-takeback.html` **equals `curl /premove`** (cxd5,
  safe_vs_all, safety 1, min_response_prob 0.983822, their exd5 96.3476%),
  engine **87 ms**, round-trip **91 ms**, state→render **113–260 ms**
  (`real-takeback-equals-curl.json`).
- Regressions all green: `tts-proof` ALL PASSED (14805 voices, hotkey/badge,
  panel-closed), `overlay-proof` ALL PASSED, `adapter-proof` ALL PASSED (now
  also covering the new `premove-takeback.html` fixture: FEN/7 moves/white),
  `analyze-proof --stub` 10/10, server **`79 passed`**.
- Screenshots: `stub-takeback-card.png`, `stub-takeback-arrow.png` (dashed blue
  c4→d5 on the real board), `stub-robust.png`, `stub-forced.png`,
  `stub-no-safe.png`, `stub-gating-assistant-off.png`, `stub-stale-race.png`,
  `stub-flipped.png`/`stub-flipped-arrow.png`, `real-takeback-card.png`,
  `real-takeback-arrow.png`.

**Exact commands**
```bash
CHROME="$HOME/.cache/humanplay-chrome/chrome/linux-155.0.8059.84/chrome-linux64/chrome"
node test/tools/premove-unit.mjs                          # 12 passed
node test/tools/premove-proof.mjs --chrome "$CHROME"      # 9 cases, ALL PASSED (spawns the stub)
cd server && .venv/bin/python -m uvicorn app:app --host 127.0.0.1 --port 8765
node test/tools/premove-proof.mjs --chrome "$CHROME" --real          # panel == curl, ALL PASSED
node test/tools/tts-proof.mjs --chrome "$CHROME"          # M6 regression
node test/tools/overlay-proof.mjs --chrome "$CHROME"      # M5 regression
node test/tools/adapter-proof.mjs --chrome "$CHROME"      # M3 regression
node test/tools/analyze-proof.mjs --chrome "$CHROME"      # M4 stub regression
cd server && .venv/bin/python -m pytest tests -q          # 79 passed
# re-record the stub's canned /premove data (real server must be running):
server/.venv/bin/python test/fixtures/generate_chesscom.py
python3 test/tools/collect-canned.py
```

**Automatic vs manual**
- Delivered by tests: the criteria engine (hand-verified expectations), the
  `/premove` contract + clamps, the client key/dedupe/stale/error mapping, the
  card per criterion + no-safe state, dashed-arrow endpoints on normal/flipped
  fixtures (0.00 px), the "premove …" text/policy/dedupe, gating (our turn /
  assistant off / TTS off), the master-switch interaction, the stale race, and
  the real-mode panel==curl equality.
- **Only a human can verify**: the live chess.com flow (the premove actually
  firing on the site after they move), audible voice quality (espeak is
  robotic), the toolbar badge by eye, and the safety claim over a real game —
  never losing material to a mispredicted premove.

**MANUAL CHECKLIST (what only a human can verify — the point of M7)**
1. **Real game with uvicorn + Chrome loaded**: after YOUR move the Premove card
   must fill within ~1 s — their likely moves + one recommendation (or "no safe
   premove"). On an **obvious take-back** (e.g. they can capture a piece and your
   recapture is natural) a **dashed blue arrow** must appear on the board and,
   with Voice on, you must hear **"premove …"**.
2. **It must stay silent when unsafe**: positions where their two likely moves
   need different answers must show "no safe premove" — no arrow, no speech.
3. **Legality guard**: make the premove, let them play an unexpected move — the
   premove either fires (it was legal) or simply does not; you must **never
   lose material to a mispredicted premove** in your testing (that is the whole
   criteria point; report any counterexample with the FEN + their move).
4. Settings: **Show premove arrow** off/on (effective only while "Show arrows"
   is on) and **Speak premoves** off/on; both persist across reloads.
5. On your turn the card must say **"waiting for your move"**; with the
   assistant off it must say "assistant off" (and plan nothing).

**Deviations / notes**
- The take-back fixture is a position on the **opponent's** turn where their
  capture (`4...exd5`, 96.3%) is the obvious continuation and our **take-back**
  (`5.cxd5`) is the premove — i.e. "the opponent has just captured" is realised
  as "their capture is the trigger and our recapture is queued" (ply parity:
  the fixture must end on our move for it to be their turn).
- Verified tuning observation: in `mode="all"` a premove whose mass is almost
  all **guard** (e.g. the en-passant-only `exd5` after 1.e4 e5 2.Nf3 Nc6 3.Bc4:
  safe_mass 0.006%) can pass the documented criteria — harmless (it can never
  backfire) but useless. The panel ships `mode="top"` where safe_mass is the
  dominant case; a "minimum useful safe mass" knob is the obvious future tweak.
- A **stale** result no longer clears the overlay (a newer position's policy
  may already have published its arrow); documented in `runPremove`.
- `overlay-proof.mjs` now filters **premove** arrows out of its M5 count/geometry
  assertions and records the coexistence (`o6.waiting.allArrows`,
  `o6.premoveCoexistence`) — a manual analysis on their turn legitimately shows
  both sets.
- The fixture server grew `/premove` canned responses (recorded from the real
  server; `collect-canned.py` re-records them) + `/debug/premove-delay` and
  `/debug/canned-premove`; the M7 proof's "forced" and "stale-race" cases use
  the **mismatch mutation** (replace the board, keep the move list) so they stay
  position-provable through the production adapter path.
- `premove-proof.mjs` writes `premove-proof-real.json` (summary) and
  `real-takeback-equals-curl.json` (case) in real mode; `--stub` writes
  `premove-proof-stub.json` + one JSON per case.
- `TTS` remains **default OFF**; "Speak premoves" is default ON but can only
  speak when Voice is on (documented in the card).

**Next — Milestone 8**: live commentary / explain mode (short natural-language
"why this move" from the model's probabilities).

---

## Session 6 — Milestone 6: TTS move announcements (chrome.tts, toggle + hotkey + dedupe) ✅

**What works**
- `extension/` **0.5.0** (adapter m3.1, overlay m5.0 unchanged). New manifest
  bits: permission **`tts`** + command **`toggle-tts`** (Ctrl+Shift+Y) — no
  other new permissions, no `<all_urls>` (checked by the proof).
- **`src/tts/move-speech.js` (new, pure)**: SAN/UCI → spoken text: `Nf3` →
  "Knight to f3", `exd5` → "e-pawn takes d5", `O-O` → "Castle kingside",
  `O-O-O` → "Castle queenside", `e8=Q+` → "Promote to queen on e8, check",
  `gxh8=N#` → "g-pawn takes h8, promote to knight, mate", `Nbd2` →
  "b-knight to d2", `R1e2` → "rook one to e2", `Bxh7+` → "Bishop takes h7,
  check"; unparseable SAN → UCI fallback "move e2 to e4" (+ ", promote to
  queen"); `null` when nothing parses (callers stay silent).
- **`src/tts/tts-policy.js` (new, pure)**: `speakDecision` (the never-speak
  matrix), `createSpokenKeyStore` (bounded dedupe), `clampRate` (0.5–2,
  `TTS_RATES` 0.8/1.0/1.2), `normalizeTtsSettings` (default OFF).
- **`src/tts/speaker.js` + `src/tts/tts-service.js` (new)**: the speaker seam
  (`speak(text,{rate})`, `stop()`, `available()`) with `createSpeaker()` as the
  single construction point (Piper/cloud would slot in there); the service runs
  in the **service worker** and records every call in `__humanplayTts`
  (text/options/engine/timestamp/reason/source/key + chrome.tts events +
  counters + last GameState + badge, mirrored to `storage.session` so MV3
  restarts keep it). `__humanplayTtsTest.invokeToggle/speak/stop` is the
  documented callable test seam.
- **Panel "Voice (TTS)" card**: Speak suggestion (default OFF, persisted), rate
  select, **Speak test** ("Knight to f3"), voices line + actionable note,
  Ctrl+Shift+Y/badge hint; panel debug view `__humanplayAnalysis.tts`
  (decision + decision history). Policy: speak iff TTS on + assistant on +
  your turn + non-stale suggestion for the current key + key not spoken yet;
  enabling speaks the current suggestion once, disabling stops mid-sentence;
  never on errors/game over/opponent/assistant-off/stale. Interruption: the SW
  stops before **every** `speak(enqueue:false)`.
- **Badge**: "TTS" on green `#2f6f4f` while on (white text), cleared while off —
  set by the service worker from `settings` (works with the panel closed).

**Which TTS path won (verified empirically, Chrome for Testing 155.0.8059.84)**
- **`chrome.tts` from the MV3 service worker** — no offscreen document.
  `speak/stop/getVoices/isSpeaking/onEvent/onVoicesChanged` are all present in
  the SW, calls execute and events fire. The offscreen fallback was **not
  needed** and is not viable: an offscreen document does **not** expose
  `chrome.tts` (only Web Speech `speechSynthesis`), and the `offscreen`
  permission was out of budget anyway. The SW also never dies with the panel —
  that is what the panel-closed proof case asserts.
- **Speech backend on this machine**: speech-dispatcher + espeak-ng are
  installed. Chrome only synthesizes with `--enable-speech-dispatcher`: then
  `chrome.tts.getVoices()` enumerates **14805 espeak-ng voices** (asynchronously
  — 0 right after a cold SW start; the panel retries once, the SW listens to
  `onVoicesChanged`) and utterances fire start/end/interrupted. Without the flag:
  0 voices and every utterance ends in `{type:"error", errorMessage:""}` — the
  speak path still executes and is recorded (secondary evidence run:
  `captures/tts/no-backend/`). Real Chrome (not CfT) needs that flag or a
  speech backend too — worth confirming by hand.

**Results (evidence: `test/fixtures/captures/tts/` — 21 files main + 20 no-backend)**
- `tts-unit.mjs`: **12/12 passed** — full formatter matrix (incl. disambiguation,
  promotions, en passant marker, annotations, castling, invalid/empty input),
  UCI fallback, rate clamp, dedupe-store LRU, the entire `speakDecision` matrix.
- `tts-proof.mjs` (CDP, stub server, manifest variant `codeIdentical: true`,
  `--enable-speech-dispatcher`, 9 cases): **ALL TTS CASES PASSED**
  - **1 speak** per position with the exact text ("e-pawn to e4"), engine
    chrome.tts, `{enqueue:false, rate:1}`, stop("before-speak") recorded first;
  - re-emit → renderCount 3→9, **still 1 speak** (decision "duplicate" ×3+);
  - new position → **stop + new speak** ("Knight to d5") **858–881 ms** after the
    mutation (700 ms artificial delay included, across runs);
  - toggle off → stop("toggle-off") + a whole new position analyzed silently;
    toggle on → speaks the current suggestion ("toggle-on" forced);
  - **stale**: delayed response superseded → `staleDiscards 0→1`, never spoken;
  - opponent's turn (auto + manual "Analyze now"), assistant off (+recovery
    "a-rook to d1"), 400 error (+recovery "Queen to d2"), game over → 0 speaks;
  - hotkey: `toggle-tts` registered with **Ctrl+Shift+Y**; handler flips
    storage + badge "TTS" ↔ "" + panel checkbox (storage.onChanged) + speaks;
  - voices: 14805 recorded, line "voices: 14805 · chrome.tts", no note; the
    no-backend run asserts the note text + the speak path still executes;
  - **PANEL CLOSED**: panel target closed (contexts left: only BACKGROUND), SW
    still tracked the new FEN (`1.e4`), a speak routed through the production
    runtime-message path (sent from the content-script isolated world, the only
    sender left) was performed + recorded (`chrome.tts`, rate 1.2), badge still
    flapped. Analysis-loop caveat documented in the case: no new suggestions
    exist without the panel (M4 lives there) — the *execution* path is what is
    guaranteed panel-independent.
- Regressions all green: `overlay-proof` ALL OVERLAY CASES PASSED,
  `adapter-proof` ALL ADAPTER CASES PASSED, `analyze-proof --stub` 10/10 PASSED,
  `tts-unit` 12, server **`55 passed`** (server untouched).
- Screenshots: `tts-card-on.png`, `tts-card-off.png`, `tts-card-off-hotkey.png`,
  `tts-middlegame-on.png`, `tts-middlegame-on-again.png`,
  `tts-startpos-suggestion.png`, `tts-opponent-turn.png`, `tts-gameover.png`,
  `tts-voices.png` (14805 voices visible), `tts-panel-closed-board.png`.
  **The toolbar badge is NOT screenshot-able** (browser UI; no CDP path, and
  this machine has no screen-capture tool — GNOME screenshot D-Bus is denied,
  no import/xwd/ffmpeg/grim). Asserted via `chrome.action.getBadgeText/
  getBadgeBackgroundColor/getBadgeTextColor`; **verify the green "TTS" chip by
  eye**.

**Exact commands**
```bash
CHROME="$HOME/.cache/humanplay-chrome/chrome/linux-155.0.8059.84/chrome-linux64/chrome"
node test/tools/tts-unit.mjs                               # 12 passed
node test/tools/tts-proof.mjs --chrome "$CHROME"           # 9 cases, ALL PASSED
node test/tools/tts-proof.mjs --chrome "$CHROME" --no-speech-backend \
  --out-dir test/fixtures/captures/tts/no-backend          # no-voice branch evidence
node test/tools/overlay-proof.mjs --chrome "$CHROME"       # M5 regression
node test/tools/adapter-proof.mjs --chrome "$CHROME"       # M3 regression
node test/tools/analyze-proof.mjs --chrome "$CHROME"       # M4 stub regression
cd server && .venv/bin/python -m pytest tests -q           # 55 passed (server untouched)
```

**MANUAL CHECKLIST (what only a human can verify — the point of M6)**
1. **Real game with sound**: load unpacked 0.5.0, start uvicorn, open a
   chess.com bot game, click the icon, tick **Speak suggestion** → you must HEAR
   "Knight to f3"-style text **within ~1.5 s** of the suggestion appearing
   (automated: 858–881 ms with a 700 ms artificial stub delay; the real engine
   is ~20 ms). If Chrome is silent, start it with `--enable-speech-dispatcher`
   (the panel's voices line will say either way).
2. **Hotkey**: press **Ctrl+Shift+Y** → TTS toggles, the toolbar badge shows a
   green **"TTS"** while on (cleared while off), and the panel checkbox follows.
3. **Toggle off mid-sentence** → speech must stop immediately (the SW stop is
   recorded; hear it).
4. **Rate**: switch 0.8 / 1.2 → the next announcement is clearly slower/faster
   (persisted across reloads).
5. **Voice quality**: Ubuntu espeak-ng via speech-dispatcher is **robotic** —
   judge whether it is usable in a real game. If not, the planned optional
   upgrade is a Piper speaker behind the existing `createSpeaker()` seam.
6. Badge/chip visibility by eye (see the screenshot note above).

**Deviations / notes**
- The voice list loads **asynchronously**: Chrome reports 0 voices for the
  first moment after a cold start even with a backend (then 14805 espeak-ng
  voices on this box); the panel retries once (2 s) and the SW refreshes on
  `chrome.tts.onVoicesChanged`, so the actionable note is not shown spuriously.
- `overlay-proof.mjs` O7(c) had an intermittent harness flake (its precondition
  re-activated the middlegame tab and trusted arrows that could still be shown
  from an earlier episode, so the error step could run before the panel had
  picked the middlegame state up). Fixed by waiting for the CARD's FEN
  (`refreshPanelState`) first; the assertions are unchanged, plus a diagnostic
  dump on failure. Verified 5 consecutive clean runs.
- The offscreen speaker from the M6 sketch was **dropped** (SW path works;
  offscreen documents don't get `chrome.tts`; `offscreen` permission not
  allowed by the brief) — documented in `src/tts/speaker.js`.
- `npm`-free as always; the proof still spawns the stub itself and leaves the
  shipped manifest chess.com-only (test-only variant, hash-compared).
- Adapter/overlay/analysis behaviour unchanged; the answer to "what would be
  spoken" is machine-readable in `tts-proof.json` (`.checks.finalTtsHook`).

**Next — Milestone 7**: premove planner (precompute replies for the opponent's
likely moves from Maia's distribution while they think). M8: commentary.

---

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

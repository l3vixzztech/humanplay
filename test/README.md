# test/ — cross-cutting test assets

Server unit tests live in `../server/tests/`; everything here is shared by the
extension milestones.

```
fixtures/       offline fixture corpus (pages/, chesscom/, pages-png/, captures/)
                — see fixtures/README.md and fixtures/chesscom/README.md
tools/          dev/test drivers
  fixture_server.py    serves test/fixtures/ on 127.0.0.1:8765: stub /health,
                       the side panel's snapshot intake AND canned /analyze
                       responses + /debug/* control routes (M4)
  collect-canned.py    re-records those canned /analyze responses from the REAL
                       server into fixture_server.py + captures/analyze/
  adapter-unit.mjs     zero-dep unit tests for the M3 adapter's pure logic
  adapter-proof.mjs    CDP end-to-end proof of the M3 DOM adapter (manifest variant)
  analyze-unit.mjs     zero-dep unit tests for the M4 analysis client (injected fetch)
  analyze-proof.mjs    CDP end-to-end proof of the M4 analysis loop:
                       --stub (against fixture_server.py) and --real (real Maia server)
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
  `/snapshot`).

## Quick start

```bash
CHROME="$HOME/.cache/humanplay-chrome/chrome/linux-155.0.8059.84/chrome-linux64/chrome"

server/.venv/bin/python test/fixtures/generate.py        # regenerate M2 fixture pages
server/.venv/bin/python test/fixtures/generate_chesscom.py  # regenerate M3/M4 chess.com fixtures
python3 test/tools/fixture_server.py --port 8765         # browse the fixtures over HTTP
test/fixtures/render_pages.sh "$CHROME"                  # rasterize pages -> PNG

node test/tools/adapter-unit.mjs                         # 22 passed
node test/tools/analyze-unit.mjs                         # 20 passed (injected fetch)
node test/tools/adapter-proof.mjs --chrome "$CHROME"
node test/tools/analyze-proof.mjs --chrome "$CHROME"     # stub mode (spawns the stub)
node test/tools/analyze-proof.mjs --chrome "$CHROME" --real   # needs the Maia server on 8765
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
```

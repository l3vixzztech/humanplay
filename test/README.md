# test/ — cross-cutting test assets

Server unit tests live in `../server/tests/`; everything here is shared by the
extension milestones.

```
fixtures/   offline fixture corpus (generated board pages, rasterized PNGs,
            extension-captured PNGs + proof JSON) — see fixtures/README.md
tools/      dev/test drivers
  fixture_server.py    serves test/fixtures/ (+ stub /health) on 127.0.0.1:8765
  capture-proof.mjs    drives the extension in Chrome via CDP and reports evidence
groundtruth/    (planned, M3+) per-fixture known FENs, test-only ground truth
manual/         (planned, M6+) manual end-to-end scripts
```

## Rules

- **Offline only.** No network, no CDN: fixture pages embed their SVG board.
- **DOM ground truth is test-only.** Fixture pages expose their FEN in a hidden
  `#fen[data-fen]` element; the runtime pipeline is pixel-based and must never
  read a real site's DOM (`../docs/PROJECT.md`).
- Nothing here may import or bundle Maia-3 code (AGPL boundary).

## Quick start

```bash
server/.venv/bin/python test/fixtures/generate.py      # regenerate fixture pages
python3 test/tools/fixture_server.py --port 8765       # browse them over HTTP
test/fixtures/render_pages.sh <chrome-binary>          # rasterize pages -> PNG
node test/tools/capture-proof.mjs --help               # see the file header
```

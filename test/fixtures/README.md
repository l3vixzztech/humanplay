# test/fixtures — offline fixture corpus

Everything here is **offline and self-contained** (no network, no CDN).

| Path | What it is | Used by |
|---|---|---|
| `chesscom/*.html` | replicas of the **real chess.com game-page DOM** (board, move list, players) + hidden ground-truth FEN/UCI/color | `test/tools/adapter-proof.mjs` (M3 adapter proof), `fixture_server.py` for manual browsing |
| `chesscom/replay.html` | rebuilds a page from a sanitized snapshot (`?name=`/`?url=`) | adapter-proof snapshot replay |
| `chesscom/reference/` | raw markup excerpts recorded from **live chess.com** (2026-10-16, usernames stripped) that the fixtures are built from | documentation / future re-verification |
| `chesscom-snapshots/` | real, user-recorded sanitized snapshots (empty until someone records one) | adapter-proof snapshot replay |
| `generate_chesscom.py` | regenerates `chesscom/` (python-chess computes the ground truth) | — |
| `pages/*.html` | offline pages rendering known positions as python-chess SVG boards | parked board locator + the M2 capture debug tool |
| `pages-png/*.png` | headless screenshots of those pages | parked locator |
| `captures/*.png` + `*.json` | frames captured **through the extension** (M2) and the machine-readable proofs | evidence |
| `captures/adapter/` | M3 adapter proof JSONs, panel screenshots, recorded snapshot evidence | evidence |
| `captures/analyze/`, `captures/overlay/`, `captures/premove/`, `captures/commentary/`, `captures/tts/` | per-milestone proof JSONs + screenshots | evidence |
| `captures/acceptance/` | **M9 capstone**: `stub/` + `real/` acceptance reports and screenshots + the recorded `canned-acceptance.json` | `test/tools/acceptance-proof.mjs` |
| `captures/package/` | M9 packaging verification (`package-verify.json`) | `scripts/package-extension.sh` |
| `generate.py`, `render_pages.sh` | regenerate `pages/` and `pages-png/` | — |

Ground truth is **test-only**: the runtime adapter reads the visible chess.com
DOM the same way it does on the real site; only the harnesses may read the
hidden ground-truth elements.

## chess.com fixtures (M3)

See **`chesscom/README.md`** for the full story (verified DOM facts, the traps
each page contains, the probe evidence, the fast-fix protocol when a real page
breaks the adapter).

```bash
server/.venv/bin/python test/fixtures/generate_chesscom.py   # regenerate pages
python3 test/tools/fixture_server.py                         # browse them over HTTP
#   http://127.0.0.1:8765/chesscom/index.html
```

## Record real snapshots from chess.com (the M3/M4 workflow)

1. Load the extension (`extension/README.md`) and open a real chess.com game.
2. Panel → **Record chess.com snapshot** → sanitized JSON (no usernames).
3. Put it into `chesscom-snapshots/` (or run `fixture_server.py` first and the
   panel writes it straight there), then run `node test/tools/adapter-proof.mjs
   --chrome …` — the snapshot is replayed and asserted automatically.

## Legacy pixel fixtures (`pages/`, `pages-png/`)

These pages render positions as `python-chess` SVG boards with a hidden
ground-truth element (`<div id="fen" data-fen=… data-moves=… hidden></div>`).
They were built for the pixel board locator, which is **parked**
(`../parked/image-recognition/`), and remain useful for the M2 capture debug
tool (`capture-proof.mjs`).

```bash
server/.venv/bin/python test/fixtures/generate.py          # board size 480 px
server/.venv/bin/python test/fixtures/generate.py --size 640
test/fixtures/render_pages.sh <path-to-chrome>             # rasterize to pages-png/
```

## M2 evidence in `captures/`

| File | Meaning |
|---|---|
| `startpos-capture.png` | real frame captured through the extension (1100×757) of `pages/startpos.html` |
| `downloaded-by-extension.png` | the same frame, byte-identical copy of what the panel's **Record fixture** button downloaded |
| `panel-fixture-online.png` | side panel UI with chip `online · fixture-static-server` |
| `panel-online-maia3.png` | side panel UI with the real Maia server: `online · maia3-5m` |
| `panel-offline.png` | side panel UI with no server listening: `server offline` |
| `*-proof.json` | the full machine-readable report of each run |

How they were produced: `test/tools/capture-proof.mjs` (see the header of that
file and `docs/HANDOFF.md`). M3 evidence lives in `captures/adapter/`.

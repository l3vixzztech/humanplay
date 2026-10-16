# test/fixtures — offline fixture corpus

Everything here is **offline and self-contained** (no network, no CDN). Two kinds
of material:

| Path | What it is |
|---|---|
| `pages/*.html` | generated offline pages, each rendering one known chess position |
| `pages-png/*.png` | headless-Chromium screenshots of those pages (stable, checked in) |
| `captures/*.png` + `*.json` | frames captured **through the extension** and the machine-readable proof that produced them |
| `generate.py` | regenerates `pages/` |
| `render_pages.sh` | rasterizes `pages/` to `pages-png/` |

## The pages

| Page | Position | FEN |
|---|---|---|
| `startpos.html` | initial position, White to move | `rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1` |
| `middlegame.html` | Sicilian Najdorf after 5…a6, White to move | `rnbqkb1r/1p2pppp/p2p1n2/8/3NP3/2N5/PPP2PPP/R1BQKB1R w KQkq - 0 6` |
| `castling-black-to-move.html` | both sides can castle, Black to move | `r3k2r/pppppppp/8/8/8/8/PPPPPPPP/R3K2R b KQkq - 0 1` |
| `promotion.html` | White pawn on b7 can promote | `6k1/1P6/8/8/8/8/8/6K1 w - - 0 1` |
| `index.html` | links to all of the above | — |

The board images are `python-chess` SVG output (`chess.svg.board`, coordinates
on) embedded directly in the HTML. The pages use a fixed page background and a
fixed board size so screenshots are deterministic.

**Ground truth is test-only.** Every page exposes its position in a hidden
element:

```html
<div id="fen" data-fen="…" data-moves="…" data-name="…" hidden></div>
```

`data-moves` is the UCI move list when the position was built from one (the
middlegame page), empty otherwise. Only automated tests may read this; the
runtime pipeline is pixel-based and must never scrape a real site's DOM
(`../docs/PROJECT.md`, locked decisions).

## Regenerate the pages

`python-chess` lives in the server venv:

```bash
server/.venv/bin/python test/fixtures/generate.py          # board size 480 px
server/.venv/bin/python test/fixtures/generate.py --size 640
```

## Rasterize the pages (optional)

```bash
test/fixtures/render_pages.sh <path-to-chrome>
# e.g. on this machine (snap Chromium cannot run here — see below):
test/fixtures/render_pages.sh \
  "$HOME/.cache/humanplay-chrome/chrome/linux-155.0.8059.84/chrome-linux64/chrome"
```

This runs `chrome --headless=new --screenshot=… --window-size=1000,900
file://…/pages/<page>.html` for every page and writes `pages-png/<page>.png`.

If Chromium is not available the manual alternative is: open the page in any
browser and take a screenshot with the fixture filling the visible area at a
known size — or run the one-liner above by hand.

## Open the pages by hand

```bash
# direct file:// (no server needed)
xdg-open test/fixtures/pages/index.html

# or over HTTP (also answers /health, so the extension's status chip is "online")
python3 test/tools/fixture_server.py --port 8765
# then browse http://127.0.0.1:8765/pages/index.html
```

`test/tools/fixture_server.py` uses port 8765 on purpose: it is the only origin
the extension currently has a host permission for. **It conflicts with the Maia
server** (same port) — run one at a time.

## Record fixtures from real sites (the M3/M4 workflow)

1. Load the extension (`extension/README.md`) in Chromium.
2. Open the chess site and position the board.
3. **Click the humanplay toolbar icon** — this opens the side panel *and* gives
   the extension access to that tab (Chrome's `activeTab` grant). Without this
   click `chrome.tabs.captureVisibleTab` refuses to run; a narrow host
   permission is not enough.
4. Press **Capture now** → the frame appears in the panel (dimensions + time).
5. Press **Record fixture (PNG)** → Chrome saves it to the normal download
   folder as `humanplay-<YYYYMMDD-HHMMSS>.png`.
6. Move/copy the PNG here (e.g. `captures/` or a new `real-sites/` folder) and,
   when possible, save the known FEN next to it as ground truth
   (`../groundtruth/<name>.json`, DOM- or manually-derived — test-only).

## M2 evidence in `captures/`

| File | Meaning |
|---|---|
| `startpos-capture.png` | real frame captured through the extension (1100×757) of `pages/startpos.html` |
| `downloaded-by-extension.png` | the same frame, byte-identical copy of what the panel's **Record fixture** button downloaded (`~/Downloads/humanplay-20261016-222823.png`) |
| `panel-fixture-online.png` | side panel UI with chip `online · fixture-static-server` |
| `panel-online-maia3.png` | side panel UI with the real Maia server: `online · maia3-5m` |
| `panel-offline.png` | side panel UI with no server listening: `server offline` |
| `*-proof.json` | the full machine-readable report of each run (extension id, manifest hashes, permissions, console log, toggle persistence, capture/download results) |

How they were produced: `test/tools/capture-proof.mjs` (see the header of that
file and `docs/HANDOFF.md`, session 2).

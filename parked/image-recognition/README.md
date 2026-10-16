# parked/image-recognition — the stopped pixel-recognition work

**Status: parked, complete for what it was meant to do, not abandoned.**
This directory preserves the pixel-based board-locator work that was being built
for the *original* Milestone 3 ("find the 8×8 board in a screenshot, any site").
The project pivoted to **chess.com only + DOM-based state reading** (see
`../../docs/PROJECT.md`, locked decisions), which makes a pixel pipeline
unnecessary for the product: chess.com's own DOM gives the exact position *and*
the full move history. The pixel pipeline would have needed a second milestone
(piece classifier) and a third (game tracker) to reconstruct exactly that.

## What is in here

| Path | What it is |
|---|---|
| `extension/src/board/locator.js` | the board locator, ~1100 lines, zero dependencies, no DOM/chrome APIs. Finds the 8×8 *play area* in one captured frame: gradient projections → 9/10-line lattice hypotheses → two-tone parity verification → full-resolution sub-pixel refit. Deterministic, returns the rect + confidence + method. |
| `test/tools/locator-proof.mjs` | CDP proof harness (Chrome for Testing): renders the offline fixture pages at several viewport/DPR combinations, screenshots them, runs the **identical** locator file (hash recorded) on the pixels and compares against the DOM ground truth (`getScreenCTM()` of the python-chess SVG). Writes overlay PNGs (detected grid red, ground truth green) + proof JSONs. |
| `test/fixtures/captures/locator/` | the evidence that was produced by the last full run: per-fixture overlay PNGs + proof JSONs (primary viewport `1100x757@1` kept as samples), the extension-capture check, and the complete `locator-proof.json` run summary. |

## State at parking time (2026-10-16)

- **Locator: done and verified.** Last full run: all fixture cases at
  `1100x757@1`, `800x900@2`, `640x700@1`, `900x700@0.75` plus the real
  extension capture passed with sub-pixel accuracy (max edge error ≈ 1 px at
  DPR 1, ≤ 2 px at DPR 2/0.75); results and overlays are in the proof JSONs
  kept here.
- **Piece classifier: not started.** **Game tracker: not started.** The tracker
  was the milestone that would have reconstructed FEN/history from pixels —
  exactly the job the chess.com DOM adapter (M3, done) now does with 100%
  exactness instead of best effort.
- The locator was **untracked** when stopped; it is committed here for the
  first time so it cannot be lost.

## Evidence pruning

The full original evidence contained 4 viewport/DPR runs × 4 fixture pages
(overlay + frame + proof each) + extension-capture + the run summary: ~50
files. Only the primary-viewport overlays (one sample per fixture page) and
all proof JSONs are kept; the `-frame.png` files (regenerable screenshots of
the fixture pages) and the non-primary-viewport overlays were deleted. The
`locator-proof.json` summary still lists every case of the last full run.

## How to revive it

Nothing here depends on the parking location. To bring it back:

```bash
mkdir -p extension/src/board test/tools test/fixtures/captures/locator
mv parked/image-recognition/extension/src/board/locator.js extension/src/board/
mv parked/image-recognition/test/tools/locator-proof.mjs test/tools/
mv parked/image-recognition/test/fixtures/captures/locator/* test/fixtures/captures/locator/

# regenerate fixture pages (python-chess SVG boards) and run the proof
server/.venv/bin/python test/fixtures/generate.py
test/fixtures/render_pages.sh "$HOME/.cache/humanplay-chrome/chrome/linux-155.0.8059.84/chrome-linux64/chrome"
node test/tools/locator-proof.mjs --chrome "$HOME/.cache/humanplay-chrome/chrome/linux-155.0.8059.84/chrome-linux64/chrome"
```

The tool's paths are all repo-root-relative, so they keep working after the
move back. The locator itself is also useful *without* the full pipeline, e.g.
as a sanity check for the M5 overlay (does `boardRect` from the DOM match the
pixels?) or if pixel support for other sites is ever added.

## Related

- `test/fixtures/pages/` (offline SVG fixture pages) and
  `test/fixtures/captures/` (M2 extension captures) are **not** parked: the
  fixture corpus remains useful, and the capture-source abstraction + PNG
  recorder stay in the extension as debug tools (see `../../docs/PROJECT.md`).
- The chess.com DOM adapter that replaced this work lives in
  `extension/src/content/` with its proof at `test/tools/adapter-proof.mjs`.

#!/usr/bin/env bash
# Rasterize the offline fixture pages to PNG with headless Chromium.
#
#   test/fixtures/render_pages.sh [/path/to/chrome]
#
# Default browser is `chromium`. On this machine snap Chromium cannot run
# (snap-confine error), so pass Chrome for Testing explicitly, e.g.:
#
#   test/fixtures/render_pages.sh \
#     "$HOME/.cache/humanplay-chrome/chrome/linux-155.0.8059.84/chrome-linux64/chrome"
#
# Output: test/fixtures/pages-png/<page>.png (checked into the repo as evidence).
set -euo pipefail

BROWSER="${1:-chromium}"
FIXTURES_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PAGES_DIR="$FIXTURES_DIR/pages"
OUT_DIR="$FIXTURES_DIR/pages-png"
WINDOW_SIZE="${WINDOW_SIZE:-1000,900}"

mkdir -p "$OUT_DIR"

for page in "$PAGES_DIR"/*.html; do
  name="$(basename "$page" .html)"
  "$BROWSER" \
    --headless=new \
    --disable-gpu \
    --hide-scrollbars \
    --force-device-scale-factor=1 \
    --window-size="$WINDOW_SIZE" \
    --screenshot="$OUT_DIR/$name.png" \
    "file://$page" 2>/dev/null
  echo "wrote $OUT_DIR/$name.png"
done

#!/usr/bin/env bash
# humanplay — package extension/ into dist/humanplay-<version>.zip, then VERIFY
# the zip: unpack it into a temp dir and load it in Chrome (for Testing),
# asserting that the MV3 service worker registers.
#
# Usage:
#   scripts/package-extension.sh
#   CHROME=/path/to/chrome scripts/package-extension.sh   # explicit browser
#
# The zip contains the *contents* of extension/ (manifest.json at the root), so
# it is exactly what "Load unpacked" needs after unzipping.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
EXT_DIR="$REPO_ROOT/extension"
DIST_DIR="$REPO_ROOT/dist"

for tool in zip unzip python3; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    echo "humanplay package: '$tool' is required" >&2
    exit 1
  fi
done

VERSION="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["version"])' "$EXT_DIR/manifest.json")"
OUT="$DIST_DIR/humanplay-$VERSION.zip"

mkdir -p "$DIST_DIR"
rm -f "$OUT" "$OUT.sha256"

echo "[1/3] zipping extension/ -> $OUT (version $VERSION)"
(
  cd "$EXT_DIR"
  zip -r -q "$OUT" . \
    -x '*.DS_Store' -x '__MACOSX*' -x '*.map' -x '*.zip'
)

BYTES="$(wc -c < "$OUT" | tr -d ' ')"
echo "      $BYTES bytes, $(unzip -l "$OUT" | tail -1 | awk '{print $2}') files"
sha256sum "$OUT" | tee "$OUT.sha256"

echo "[2/3] locating a Chrome/Chromium binary for the load check"
CHROME_BIN="${CHROME:-}"
if [ -z "$CHROME_BIN" ]; then
  for candidate in \
    "$HOME/.cache/humanplay-chrome/chrome/linux-155.0.8059.84/chrome-linux64/chrome" \
    "$(command -v google-chrome || true)" \
    "$(command -v google-chrome-stable || true)" \
    "$(command -v chromium || true)";
  do
    if [ -n "$candidate" ] && [ -x "$candidate" ]; then
      CHROME_BIN="$candidate"
      break
    fi
  done
fi

if [ -z "$CHROME_BIN" ]; then
  echo "      no Chrome found — skipping the load check (set CHROME=<path> to run it)" >&2
  echo "done (zip only)."
  exit 0
fi
echo "      $CHROME_BIN"

echo "[3/3] verifying the zip: unzip -> temp dir -> load in Chrome -> service worker must register"
node "$REPO_ROOT/test/tools/package-verify.mjs" --chrome "$CHROME_BIN" --zip "$OUT"

echo "done."

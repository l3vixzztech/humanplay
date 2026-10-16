#!/usr/bin/env bash
# humanplay — server setup (Milestone 9, idempotent).
#
# Creates server/.venv with Python 3.12 (uv), installs the CPU-only PyTorch
# wheel, the pinned Maia-3 package + the FastAPI stack, and pre-fetches the
# Maia-3 checkpoints into the Hugging Face cache so the first server start needs
# no network: Maia3-5M (~20 MB, used by the test suite / fast option) and
# Maia3-79M (~300 MB, the default runtime model — most accurate in the family).
#
# Safe to run again: uv reuses the existing venv and skips satisfied deps.
#
# Usage:
#   scripts/setup-server.sh
#   HUMANPLAY_VENV=/some/venv scripts/setup-server.sh
#
# Requires: uv (https://docs.astral.sh/uv/).

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SERVER_DIR="$REPO_ROOT/server"
VENV_DIR="${HUMANPLAY_VENV:-$SERVER_DIR/.venv}"
PYTHON_BIN="$VENV_DIR/bin/python"
MAIA3_COMMIT="1e13597c42d4858b7cfd7cfdae01e297263364b2"

if ! command -v uv >/dev/null 2>&1; then
  echo "humanplay setup: 'uv' is required — install it from https://docs.astral.sh/uv/" >&2
  exit 1
fi

echo "[1/4] venv (Python 3.12) at $VENV_DIR"
if [ -x "$PYTHON_BIN" ]; then
  # Idempotent: an existing venv is reused as-is (uv venv refuses to touch it
  # without --allow-existing). A 3.12 check keeps the pin honest.
  if "$PYTHON_BIN" -c 'import sys; raise SystemExit(0 if sys.version_info[:2] == (3, 12) else 1)'; then
    echo "      reusing existing venv ($("$PYTHON_BIN" --version))"
  else
    echo "      existing venv is not Python 3.12 — replacing its interpreter"
    uv venv --python 3.12 --allow-existing "$VENV_DIR"
  fi
else
  uv venv --python 3.12 "$VENV_DIR"
fi

echo "[2/4] CPU-only PyTorch (the CUDA wheel is multi-GB and unused here)"
uv pip install --python "$PYTHON_BIN" torch --index-url https://download.pytorch.org/whl/cpu

echo "[3/4] Maia-3 (pinned @$MAIA3_COMMIT) + server/test dependencies"
uv pip install --python "$PYTHON_BIN" \
  "maia3 @ git+https://github.com/CSSLab/maia3@$MAIA3_COMMIT" \
  fastapi "uvicorn[standard]" python-chess pytest httpx

echo "[4/4] pre-fetching the Maia3 checkpoints (Hugging Face cache)"
"$VENV_DIR/bin/maia3-cache" --model maia3-5m   # test suite / fast option
"$VENV_DIR/bin/maia3-cache" --model maia3-79m  # default runtime model (~300 MB)

echo
echo "setup complete. start the server with:"
echo "    scripts/run-server.sh"
echo "then load the extension (chrome://extensions -> Load unpacked -> $REPO_ROOT/extension)"

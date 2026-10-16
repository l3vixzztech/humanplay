#!/usr/bin/env bash
# humanplay — run the local Maia-3 helper server (127.0.0.1:8765).
#
# Usage:
#   scripts/run-server.sh
#   HUMANPLAY_PORT=9000 scripts/run-server.sh
#   HUMANPLAY_MODEL=maia3-5m scripts/run-server.sh   # smaller/faster model
#
# Default model: maia3-79m (most accurate in the family, ~300 MB; CPU inference
# is still comfortably fast: ~50–150 ms per analysis). Set HUMANPLAY_MODEL to
# one of maia3-5m / maia3-23m / maia3-79m to switch.
#
# Run scripts/setup-server.sh first if server/.venv does not exist.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SERVER_DIR="$REPO_ROOT/server"
VENV_DIR="${HUMANPLAY_VENV:-$SERVER_DIR/.venv}"
HOST="${HUMANPLAY_HOST:-127.0.0.1}"
PORT="${HUMANPLAY_PORT:-8765}"
MODEL="${HUMANPLAY_MODEL:-maia3-79m}"

if [ ! -x "$VENV_DIR/bin/python" ]; then
  echo "humanplay run-server: no venv at $VENV_DIR — run scripts/setup-server.sh first" >&2
  exit 1
fi

cd "$SERVER_DIR"
echo "humanplay server: http://$HOST:$PORT  (model $MODEL, Ctrl+C to stop)"
export HUMANPLAY_MODEL="$MODEL"
exec "$VENV_DIR/bin/python" -m uvicorn app:app --host "$HOST" --port "$PORT"

#!/usr/bin/env bash
# humanplay — run the local Maia-3 helper server (127.0.0.1:8765).
#
# Usage:
#   scripts/run-server.sh
#   HUMANPLAY_PORT=9000 scripts/run-server.sh
#
# Run scripts/setup-server.sh first if server/.venv does not exist.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SERVER_DIR="$REPO_ROOT/server"
VENV_DIR="${HUMANPLAY_VENV:-$SERVER_DIR/.venv}"
HOST="${HUMANPLAY_HOST:-127.0.0.1}"
PORT="${HUMANPLAY_PORT:-8765}"

if [ ! -x "$VENV_DIR/bin/python" ]; then
  echo "humanplay run-server: no venv at $VENV_DIR — run scripts/setup-server.sh first" >&2
  exit 1
fi

cd "$SERVER_DIR"
echo "humanplay server: http://$HOST:$PORT  (Ctrl+C to stop)"
exec "$VENV_DIR/bin/python" -m uvicorn app:app --host "$HOST" --port "$PORT"

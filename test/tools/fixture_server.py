#!/usr/bin/env python3
"""Static server for test/fixtures + a stub /health + snapshot intake, on port 8765.

Why 8765? The extension manifest only has a host permission for
`http://127.0.0.1:8765/*`. chrome.tabs.captureVisibleTab requires either that
host permission or an activeTab grant, and an activeTab grant needs a real click
on the toolbar icon — which a headless test cannot produce. Serving the fixture
pages from 8765 therefore lets the automated test drive a capture through the
UNMODIFIED extension (test/tools/capture-proof.mjs). The stub /health lets the
side panel's status chip show "online" without the Maia server.

It also serves the chess.com DOM fixtures (test/fixtures/chesscom/) and accepts
the panel's *chess.com snapshots*:

    POST /snapshot  {"name": "chesscom-snapshot-….json", "snapshot": {…}}
        -> writes test/fixtures/chesscom-snapshots/<name> (sanitized JSON
           recorded from a real chess.com page by the side panel's
           "Record chess.com snapshot" button)

The real Maia server uses the same port, so run only one of them at a time.

    python3 test/tools/fixture_server.py [--port 8765]
    # browse: http://127.0.0.1:8765/pages/index.html
    #         http://127.0.0.1:8765/chesscom/index.html
"""

from __future__ import annotations

import argparse
import functools
import json
import re
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

FIXTURES_DIR = Path(__file__).resolve().parent.parent / "fixtures"
SNAPSHOT_DIR = FIXTURES_DIR / "chesscom-snapshots"
SNAPSHOT_NAME = re.compile(r"^[A-Za-z0-9._-]+\.json$")


class FixtureHandler(SimpleHTTPRequestHandler):
    def __init__(self, *args, directory: str, model: str, **kwargs):
        self.model = model
        super().__init__(*args, directory=directory, **kwargs)

    def _send_json(self, payload: dict, status: int = 200) -> None:
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Access-Control-Allow-Origin", "*")  # dev/test only
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):  # noqa: N802 (http.server API)
        if self.path.split("?")[0] == "/health":
            self._send_json({"status": "ok", "model": self.model})
            return
        super().do_GET()

    def do_POST(self):  # noqa: N802 (http.server API)
        """Snapshot intake for the side panel's "Record chess.com snapshot" button."""
        if self.path.split("?")[0] != "/snapshot":
            self._send_json({"ok": False, "error": f"unknown path {self.path}"}, status=404)
            return
        try:
            length = int(self.headers.get("Content-Length") or 0)
            payload = json.loads(self.rfile.read(length).decode("utf-8"))
            name = str(payload.get("name") or "")
            if not SNAPSHOT_NAME.fullmatch(name):
                raise ValueError("name must match [A-Za-z0-9._-]+\\.json")
            snapshot = payload.get("snapshot")
            if not isinstance(snapshot, dict) or not snapshot.get("schema"):
                raise ValueError("snapshot must be an object with a schema field")
            SNAPSHOT_DIR.mkdir(parents=True, exist_ok=True)
            target = SNAPSHOT_DIR / name
            target.write_text(json.dumps(snapshot, indent=2) + "\n", encoding="utf-8")
            repo_root = FIXTURES_DIR.parent.parent
            self._send_json(
                {
                    "ok": True,
                    "path": str(target.relative_to(repo_root)),
                    "bytes": target.stat().st_size,
                }
            )
        except Exception as error:  # noqa: BLE001 - report everything to the caller
            self._send_json({"ok": False, "error": str(error)}, status=400)

    def do_OPTIONS(self):  # noqa: N802
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "*")
        self.end_headers()

    def log_message(self, fmt, *args):  # keep the test log readable
        print(f"[fixture-server] {self.address_string()} {fmt % args}", flush=True)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--model", default="fixture-static-server")
    args = parser.parse_args()

    handler = functools.partial(FixtureHandler, directory=str(FIXTURES_DIR), model=args.model)
    server = ThreadingHTTPServer((args.host, args.port), handler)
    print(f"[fixture-server] serving {FIXTURES_DIR} on http://{args.host}:{args.port}", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()

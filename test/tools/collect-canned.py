#!/usr/bin/env python3
"""Record the CANNED /analyze responses for test/tools/fixture_server.py.

The M4 proof (test/tools/analyze-proof.mjs) runs in two modes: STUB (against
test/tools/fixture_server.py) and REAL (against the actual Maia server). The stub
answers with responses **recorded from the real server**, so the stub schema is
identical by construction and the two modes can be compared value-by-value.

This script re-records those responses. Run it whenever the fixtures change (a
new position, a new Elo case) — the real server must be running:

    cd server && .venv/bin/python -m uvicorn app:app --host 127.0.0.1 --port 8765
    python3 test/tools/collect-canned.py

It prints the `CANNED = {...}` block for test/tools/fixture_server.py (replace
the dict body) and writes the full record (requests + responses + wall times) to
test/fixtures/captures/analyze/canned-report.json. Keys are
`<fen>|<uci moves>|<elo_self>|<elo_oppo>|<top_k>` — exactly what the panel sends.
"""

from __future__ import annotations

import json
import time
import urllib.request
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent.parent
REPORT = REPO_ROOT / "test/fixtures/captures/analyze/canned-report.json"

URL = "http://127.0.0.1:8765/analyze"
START = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1"

# Fixture move lists (UCI, the adapter's replay output — see
# test/fixtures/chesscom/*.html ground truth / generate_chesscom.py).
MG14 = ["e2e4", "e7e5", "g1f3", "b8c6", "f1c4", "f8c5", "e1g1", "g8f6", "d2d3", "d7d6", "c1g5", "e8g8", "g5f6", "d8f6"]
MG16 = MG14 + ["b1c3", "h7h6"]
MG18 = MG16 + ["h2h3", "f8e8"]
FLIPPED_INITIAL = ["e2e4", "c7c5", "g1f3", "d7d6"]
RUY = ["e2e4", "e7e5", "g1f3", "b8c6", "f1b5", "a7a6", "b5a4", "g8f6", "e1g1", "f8e7", "f1e1", "b7b5", "a4b3", "d7d6", "c2c3", "e8g8"]
GAMEOVER = ["e2e4", "e7e5", "f1c4", "b8c6", "d1h5", "g8f6", "h5f7"]

# (comment, fen, moves, elo_self, elo_oppo, top_k)
CASES = [
    ("startpos.html — no moves, default Elo", START, [], 2400, 2400, 3),
    ("middlegame-castling.html — 14 plies (stale-proof P1 / the real-mode case)", START, MG14, 2400, 2400, 3),
    ("middlegame + 15.b1c3 15...h7h6 — stale-proof P2 (delayed)", START, MG16, 2400, 2400, 3),
    ("middlegame + 16.h2h3 16...f8e8 — stale-proof P3 (fast, must win)", START, MG18, 2400, 2400, 3),
    ("flipped-black.html — 4 plies (manual analysis on the opponent's turn)", START, FLIPPED_INITIAL, 2400, 2400, 3),
    ("ruy-lopez.html — 16 plies, default Elo (top-1 h3)", START, RUY, 2400, 2400, 3),
    ("ruy-lopez @ 1200/1200 — top-1 d4 (the Elo proof)", START, RUY, 1200, 1200, 3),
    ("ruy-lopez @ 2600/2600 — top-1 h3 with different probabilities", START, RUY, 2600, 2600, 3),
    ("gameover-checkmate.html — scholar's mate: moves[] + rules-decided WDL", START, GAMEOVER, 2400, 2400, 3),
]


def main() -> None:
    entries = []
    for name, fen, moves, elo_self, elo_oppo, top_k in CASES:
        body = json.dumps({"fen": fen, "moves": moves, "elo_self": elo_self, "elo_oppo": elo_oppo, "top_k": top_k}).encode()
        request = urllib.request.Request(URL, data=body, headers={"Content-Type": "application/json"})
        started = time.perf_counter()
        with urllib.request.urlopen(request) as response:
            payload = json.loads(response.read())
        wall_ms = round((time.perf_counter() - started) * 1000, 1)
        key = f"{fen}|{' '.join(moves)}|{elo_self}|{elo_oppo}|{top_k}"
        entries.append({"name": name, "key": key, "request": json.loads(body), "wall_ms": wall_ms, "response": payload})
        tops = " ".join(f"{move['san']}:{move['prob']:.3f}" for move in payload["moves"]) or "(no moves)"
        print(f"{name:70s} {tops}")

    REPORT.parent.mkdir(parents=True, exist_ok=True)
    REPORT.write_text(
        json.dumps(
            {
                "generatedWith": "cd server && .venv/bin/python -m uvicorn app:app --host 127.0.0.1 --port 8765",
                "generatedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                "generator": "test/tools/collect-canned.py",
                "consumedBy": "test/tools/fixture_server.py CANNED + test/tools/analyze-proof.mjs (stub mode)",
                "entries": entries,
            },
            indent=2,
        )
        + "\n",
        encoding="utf-8",
    )
    print(f"\nreport: {REPORT.relative_to(REPO_ROOT)}")
    print("\n# ---- paste into test/tools/fixture_server.py (CANNED) ----")
    for entry in entries:
        print(f"    # {entry['name']}")
        print(f"    {json.dumps(entry['key'])}:")
        print(f"    {json.dumps(entry['response'], sort_keys=True)},")


if __name__ == "__main__":
    main()

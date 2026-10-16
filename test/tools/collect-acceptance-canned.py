#!/usr/bin/env python3
"""Record the acceptance-proof canned bodies from the REAL Maia server.

Milestone 9's capstone proof (`test/tools/acceptance-proof.mjs`) replays one
full fixture game ply by ply through the live extension. Run in stub mode the
extension must not depend on the real engine, so this script asks the running
server for exactly the requests the panel will send during that replay and
stores the responses verbatim:

    /analyze   white-to-move prefixes of the game (0, 2, 4 … 14 plies)
    /premove   black-to-move prefixes of the game (1, 3, 5 … 13 plies)
    /explain   every ply prefix (1 … 14)

Output: `test/fixtures/captures/acceptance/canned-acceptance.json` — the proof
loads it and registers every entry with the fixture server's `/debug/canned*`
routes. The soak segment (a 104-ply knight shuffle) uses deterministic
*synthetic* bodies instead: it asserts leak-freedom (caches / feed / canvas),
not fact correctness, and recording 100+ throwaway articles would pin
meaningless values (same reasoning as commentary-proof's 52-ply cap case).

Usage (the real server must be running on 127.0.0.1:8765):

    server/.venv/bin/python test/tools/collect-acceptance-canned.py
"""

from __future__ import annotations

import argparse
import json
import sys
import time
import urllib.request
from pathlib import Path

try:
    import chess
except ImportError:  # pragma: no cover - guidance, not logic
    sys.exit("python-chess is required: run with the server venv")

REPO_ROOT = Path(__file__).resolve().parent.parent.parent
OUT = REPO_ROOT / "test/fixtures/captures/acceptance/canned-acceptance.json"
SERVER = "http://127.0.0.1:8765"
STARTPOS = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1"

# The acceptance game: the 14-ply middlegame fixture (both castlings, captures),
# replayed from the standard start position — same game as
# test/fixtures/chesscom/middlegame-castling.html.
GAME_SAN = ["e4", "e5", "Nf3", "Nc6", "Bc4", "Bc5", "O-O", "Nf6", "d3", "d6", "Bg5", "O-O", "Bxf6", "Qxf6"]


def uci_prefixes() -> list[list[str]]:
    """uci[i] = the first i plies of the game in UCI."""
    board = chess.Board()
    moves: list[str] = []
    prefixes = [[]]
    for san in GAME_SAN:
        move = board.parse_san(san)
        board.push(move)
        moves.append(board.uci(move))
        prefixes.append(list(moves))
    return prefixes


def post(path: str, payload: dict) -> dict:
    request = urllib.request.Request(
        f"{SERVER}{path}",
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(request, timeout=60) as response:
        return json.loads(response.read().decode("utf-8"))


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--out", type=Path, default=OUT)
    args = parser.parse_args()

    try:
        with urllib.request.urlopen(f"{SERVER}/health", timeout=5) as response:
            health = json.loads(response.read().decode("utf-8"))
    except OSError as error:
        sys.exit(f"the real server is not reachable on {SERVER} ({error}). Start it first: scripts/run-server.sh")
    if "maia" not in str(health.get("model", "")):
        sys.exit(f"unexpected /health from {SERVER}: {health}")

    prefixes = uci_prefixes()
    report: dict = {
        "schema": "humanplay-acceptance-canned/1",
        "generatedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "server": {"model": health.get("model"), "version": health.get("version")},
        "game": {"san": GAME_SAN, "uci": prefixes[-1], "plies": len(GAME_SAN)},
        "analyze": {},
        "premove": {},
        "explain": {},
    }

    for ply in range(0, len(GAME_SAN) + 1, 2):
        payload = {"fen": STARTPOS, "moves": prefixes[ply], "elo_self": 2400, "elo_oppo": 2400, "top_k": 3}
        key = f"{STARTPOS}|{' '.join(prefixes[ply])}|2400|2400|3"
        report["analyze"][key] = post("/analyze", payload)
        print(f"analyze  ply {ply:2d}: {report['analyze'][key]['moves'][0]['san'] if report['analyze'][key]['moves'] else '(none)'}")

    for ply in range(1, len(GAME_SAN), 2):
        payload = {
            "fen": STARTPOS,
            "moves": prefixes[ply],
            "elo_self": 2400,
            "elo_oppo": 2400,
            "top_n": 5,
            "min_safety": 0.9,
            "mode": "top",
        }
        key = f"{STARTPOS}|{' '.join(prefixes[ply])}|2400|2400|5|0.9|top"
        report["premove"][key] = post("/premove", payload)
        recommended = report["premove"][key].get("recommended")
        print(f"premove  ply {ply:2d}: {recommended['san'] if recommended else '(no safe premove)'}")

    for ply in range(1, len(GAME_SAN) + 1):
        payload = {"fen": STARTPOS, "moves": prefixes[ply], "elo_self": 2400, "elo_oppo": 2400}
        key = f"{STARTPOS}|{' '.join(prefixes[ply])}|2400|2400"
        report["explain"][key] = post("/explain", payload)
        print(f"explain  ply {ply:2d}: {report['explain'][key]['move']['san']} ({report['explain'][key]['classification']})")

    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    print(f"\nwrote {args.out.relative_to(REPO_ROOT)}")
    print(
        f"  {len(report['analyze'])} /analyze + {len(report['premove'])} /premove + "
        f"{len(report['explain'])} /explain bodies"
    )


if __name__ == "__main__":
    main()

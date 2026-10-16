#!/usr/bin/env python3
"""Record the CANNED /analyze + /premove + /explain responses for test/tools/fixture_server.py.

The M4/M7/M8 proofs (test/tools/analyze-proof.mjs, premove-proof.mjs,
commentary-proof.mjs) run
in two modes: STUB (against test/tools/fixture_server.py) and REAL (against the
actual Maia server). The stub answers with responses **recorded from the real
server**, so the stub schema is identical by construction and the two modes can
be compared value-by-value.

This script re-records those responses. Run it whenever the fixtures change (a
new position, a new Elo case, a new premove case, a new commentary replay) — the real server must be
running:

    cd server && .venv/bin/python -m uvicorn app:app --host 127.0.0.1 --port 8765
    python3 test/tools/collect-canned.py

It prints the `CANNED = {...}` / `CANNED_PREMOVE = {...}` / `CANNED_EXPLAIN = {...}`
blocks for
test/tools/fixture_server.py (replace the dict bodies) and writes the full
records (requests + responses + wall times) to
test/fixtures/captures/analyze/canned-report.json (analyze),
test/fixtures/captures/premove/canned-premove-report.json (premove) and
test/fixtures/captures/commentary/canned-explain-report.json (explain).
/analyze keys are `<fen>|<uci moves>|<elo_self>|<elo_oppo>|<top_k>`;
/premove keys append `<top_n>|<min_safety>|<mode>` — exactly what the panel sends;
/explain keys append `<elo_self>|<elo_oppo>`.
"""

from __future__ import annotations

import json
import time
import urllib.request
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent.parent
REPORT = REPO_ROOT / "test/fixtures/captures/analyze/canned-report.json"
PREMOVE_REPORT = REPO_ROOT / "test/fixtures/captures/premove/canned-premove-report.json"
EXPLAIN_REPORT = REPO_ROOT / "test/fixtures/captures/commentary/canned-explain-report.json"

URL = "http://127.0.0.1:8765/analyze"
PREMOVE_URL = "http://127.0.0.1:8765/premove"
EXPLAIN_URL = "http://127.0.0.1:8765/explain"
START = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1"

# Fixture move lists (UCI, the adapter's replay output — see
# test/fixtures/chesscom/*.html ground truth / generate_chesscom.py).
MG14 = ["e2e4", "e7e5", "g1f3", "b8c6", "f1c4", "f8c5", "e1g1", "g8f6", "d2d3", "d7d6", "c1g5", "e8g8", "g5f6", "d8f6"]
MG16 = MG14 + ["b1c3", "h7h6"]
MG18 = MG16 + ["h2h3", "f8e8"]
FLIPPED_INITIAL = ["e2e4", "c7c5", "g1f3", "d7d6"]
RUY = ["e2e4", "e7e5", "g1f3", "b8c6", "f1b5", "a7a6", "b5a4", "g8f6", "e1g1", "f8e7", "f1e1", "b7b5", "a4b3", "d7d6", "c2c3", "e8g8"]
GAMEOVER = ["e2e4", "e7e5", "f1c4", "b8c6", "d1h5", "g8f6", "h5f7"]
# M7 premove-takeback.html: Benoni, 7 plies, black to move (the user plays white).
PREMOVE_TAKEBACK = ["d2d4", "g8f6", "c2c4", "c7c5", "d4d5", "e7e6", "b1c3"]
# The forced-recapture position of the M7 tests (board-only request; the panel
# reaches it through the mismatch mutation of the take-back fixture page).
PREMOVE_FORCED_FEN = "8/1n4b1/4K3/5N2/4R3/3k4/1R1Qr1Q1/8 b - - 0 1"

# M8 commentary: the move list the stub proof replays move-by-move on
# startpos.html (Italian Game through 4.O-O — both colors, a castle, mixed
# classification bands). One /explain response per PLY PREFIX, keyed
# `<START>|<prefix>|<elo_self>|<elo_oppo>`.
ITALIAN7 = ["e2e4", "e7e5", "g1f3", "b8c6", "f1c4", "f8c5", "e1g1"]
# The M4/M5 fixture montage (14 plies, both castlings + captures) — the REAL
# mode commentary replay.
MG14_EXPLAIN = MG14

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
    # M7: positions the premove proof mutates into (the Maia card must not 400).
    ("M7 forced-recapture position (mismatch mutation; user to move)", PREMOVE_FORCED_FEN, [], 2400, 2400, 3),
    ("M7 take-back fixture + 4...exd5 (stale-race mutation; user to move)", START, PREMOVE_TAKEBACK + ["e6d5"], 2400, 2400, 3),
]

# (comment, fen, moves, top_n, min_safety, mode) — the panel always sends
# top_n=5, min_safety=0.9, mode="top".
PREMOVE_CASES = [
    ("premove-takeback.html — Benoni, black to move: their exd5 -> our take-back cxd5 (safe_vs_all)", START, PREMOVE_TAKEBACK, 5, 0.9, "top"),
    ("flipped-black.html — white to move (user black): their d4 -> our take-back cxd4 (safe_vs_all, flipped)", START, FLIPPED_INITIAL, 5, 0.9, "top"),
    ("startpos + 1.e4 — c5/e5/c6/e6 need different answers -> no safe premove", START, ["e2e4"], 5, 0.9, "top"),
    ("take-back fixture + 4...exd5 5.cxd5 (9 plies, black to move) — robust", START, PREMOVE_TAKEBACK + ["e6d5", "c4d5"], 5, 0.9, "top"),
    ("forced-recapture position (board-only; the mismatch mutation) — forced", PREMOVE_FORCED_FEN, [], 5, 0.9, "top"),
]

# (comment, moves) — one /explain response per ply prefix, default Elo 2400.
EXPLAIN_CASES = [
    (f"Italian {index + 1}/{len(ITALIAN7)}: {ITALIAN7[:index + 1][-1]} (ply {index + 1}), both colors, chips + a castle", ITALIAN7[: index + 1])
    for index in range(len(ITALIAN7))
] + [
    (f"middlegame montage ply {index + 1}/{len(MG14_EXPLAIN)}: {MG14_EXPLAIN[:index + 1][-1]} (the real-mode replay)", MG14_EXPLAIN[: index + 1])
    for index in range(len(MG14_EXPLAIN))
]


def post(url: str, payload: dict) -> tuple[dict, float]:
    body = json.dumps(payload).encode()
    request = urllib.request.Request(url, data=body, headers={"Content-Type": "application/json"})
    started = time.perf_counter()
    with urllib.request.urlopen(request) as response:
        data = json.loads(response.read())
    return data, round((time.perf_counter() - started) * 1000, 1)


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

    premove_entries = []
    print("\n# ---- M7 premove cases ----")
    for name, fen, moves, top_n, min_safety, mode in PREMOVE_CASES:
        payload = {
            "fen": fen,
            "moves": moves,
            "elo_self": 2400,
            "elo_oppo": 2400,
            "top_n": top_n,
            "min_safety": min_safety,
            "mode": mode,
        }
        data, wall_ms = post(PREMOVE_URL, payload)
        key = f"{fen}|{' '.join(moves)}|2400|2400|{top_n}|{min_safety}|{mode}"
        recommended = data["recommended"]
        summary = "(none)" if recommended is None else f"{recommended['san']}:{recommended['criterion']}:{recommended['safety']}"
        print(f"{name:100s} {summary} ({data['elapsed_ms']:.0f} ms engine, {wall_ms:.0f} ms wall)")
        premove_entries.append({"name": name, "key": key, "request": payload, "wall_ms": wall_ms, "response": data})

    PREMOVE_REPORT.parent.mkdir(parents=True, exist_ok=True)
    PREMOVE_REPORT.write_text(
        json.dumps(
            {
                "generatedWith": "cd server && .venv/bin/python -m uvicorn app:app --host 127.0.0.1 --port 8765",
                "generatedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                "generator": "test/tools/collect-canned.py",
                "consumedBy": "test/tools/fixture_server.py CANNED_PREMOVE + test/tools/premove-proof.mjs (stub mode)",
                "entries": premove_entries,
            },
            indent=2,
        )
        + "\n",
        encoding="utf-8",
    )
    print(f"\nreport: {PREMOVE_REPORT.relative_to(REPO_ROOT)}")
    print("\n# ---- paste into test/tools/fixture_server.py (CANNED_PREMOVE) ----")
    for entry in premove_entries:
        print(f"    # {entry['name']}")
        print(f"    {json.dumps(entry['key'])}:")
        print(f"    {json.dumps(entry['response'], sort_keys=True)},")

    explain_entries = []
    print("\n# ---- M8 explain cases (per-ply prefixes) ----")
    for name, moves in EXPLAIN_CASES:
        payload = {"fen": START, "moves": moves, "elo_self": 2400, "elo_oppo": 2400}
        data, wall_ms = post(EXPLAIN_URL, payload)
        key = f"{START}|{' '.join(moves)}|2400|2400"
        move = data["move"]
        print(
            f"{name:112s} {move['san']:8s} {data['classification']:9s} p={data['maia']['playedProb']:.4f}"
            f" rank={data['maia']['rank']} opening={data['opening']['name'] if data['opening'] else '-'}"
            f" ({data['elapsed_ms']:.0f} ms engine, {wall_ms:.0f} ms wall)"
        )
        explain_entries.append({"name": name, "key": key, "request": payload, "wall_ms": wall_ms, "response": data})

    EXPLAIN_REPORT.parent.mkdir(parents=True, exist_ok=True)
    EXPLAIN_REPORT.write_text(
        json.dumps(
            {
                "generatedWith": "cd server && .venv/bin/python -m uvicorn app:app --host 127.0.0.1 --port 8765",
                "generatedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                "generator": "test/tools/collect-canned.py",
                "consumedBy": "test/tools/fixture_server.py CANNED_EXPLAIN + test/tools/commentary-proof.mjs (stub/real modes)",
                "entries": explain_entries,
            },
            indent=2,
        )
        + "\n",
        encoding="utf-8",
    )
    print(f"\nreport: {EXPLAIN_REPORT.relative_to(REPO_ROOT)}")
    print("\n# ---- paste into test/tools/fixture_server.py (CANNED_EXPLAIN) ----")
    for entry in explain_entries:
        print(f"    # {entry['name']}")
        print(f"    {json.dumps(entry['key'])}:")
        print(f"    {json.dumps(entry['response'], sort_keys=True)},")


if __name__ == "__main__":
    main()

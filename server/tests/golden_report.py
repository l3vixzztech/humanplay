"""Print the golden comparison table (predict() vs real maia3-uci) as Markdown.

Run from the server directory:

    .venv/bin/python tests/golden_report.py

Paste the output into docs/HANDOFF.md for the session record.
"""

from __future__ import annotations

import pathlib
import sys

SERVER_DIR = pathlib.Path(__file__).resolve().parents[1]
if str(SERVER_DIR) not in sys.path:
    sys.path.insert(0, str(SERVER_DIR))
sys.path.insert(0, str(SERVER_DIR / "tests"))

import positions as pos  # noqa: E402
from maia_engine import get_engine  # noqa: E402
from uci_harness import UciReferenceEngine, reference_top_moves  # noqa: E402


def main() -> int:
    engine = get_engine()
    with UciReferenceEngine(verbose=True) as reference:
        reference.ready()

        print()
        print("| case | UCI command | our predict() top-3 (uci:prob) | maia3-uci MultiPV top-3 (pv; cp; wdl win/draw/loss permille) | top-1 / top-3 match |")
        print("|---|---|---|---|---|")

        for case in pos.GOLDEN_CASES:
            fen = case["fen"] or pos.START
            moves = case["moves"] or ()

            ours = engine.predict(
                fen, moves=list(moves) or None, elo_self=2400, elo_oppo=2400, top_k=3
            )
            ref_result = reference.analyze(fen=case["fen"], moves=moves)

            our_top = [m["uci"] for m in ours["moves"]]
            ref_top = reference_top_moves(ref_result, n=3)

            command = "position " + (
                "startpos" if case["fen"] is None else "fen " + case["fen"]
            )
            if moves:
                command += " moves " + " ".join(moves)

            ours_col = ", ".join(f"{m['uci']}:{m['prob']:.4f}" for m in ours["moves"])
            ref_col = ", ".join(
                f"{e['pv']} (cp {e['cp']}; wdl {e['wdl'][0]}/{e['wdl'][1]}/{e['wdl'][2]})"
                for e in ref_result["multipv"][:3]
            )
            top1_ok = ref_result["bestmove"] == our_top[0]
            top3_ok = ref_top == our_top[: len(ref_top)]
            mark = "yes" if (top1_ok and top3_ok) else ("top-1 only" if top1_ok else "NO")
            print(f"| {case['name']} | `{command}` | {ours_col} | {ref_col} | {mark} |")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())

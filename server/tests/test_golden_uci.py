"""Golden check: our in-process predict() vs the real `maia3-uci` CLI (temperature 0).

Both sides run the same Maia3-5M checkpoint at Elo 2400/2400 with history
reconstruction (--use-uci-history). move ordering from the CLI's MultiPV lines
reflects the policy softmax ranking, so top-1 and top-3 ordering must match.
"""

from __future__ import annotations

import pytest

import positions as pos
from uci_harness import UciReferenceEngine, reference_top_moves


@pytest.fixture(scope="module")
def reference():
    with UciReferenceEngine() as ref:
        ref.ready()
        yield ref


@pytest.mark.parametrize("case", pos.GOLDEN_CASES, ids=[c["name"] for c in pos.GOLDEN_CASES])
def test_top_moves_match_maia3_uci(engine, reference, case):
    fen = case["fen"] or pos.START
    moves = case["moves"] or ()

    ref_result = reference.analyze(fen=case["fen"], moves=moves)
    ours = engine.predict(fen, moves=list(moves) or None, elo_self=2400, elo_oppo=2400, top_k=3)

    our_top = [m["uci"] for m in ours["moves"]]
    ref_top = reference_top_moves(ref_result, n=3)

    assert ref_result["bestmove"] == our_top[0], (
        f"{case['name']}: bestmove mismatch: maia3-uci={ref_result['bestmove']} "
        f"ours={our_top[0]} (ours top3={our_top}, ref multipv={ref_result['multipv']})"
    )
    assert ref_top == our_top[: len(ref_top)], (
        f"{case['name']}: top-{len(ref_top)} ordering mismatch: "
        f"maia3-uci={ref_top} ours={our_top}"
    )


def test_reference_engine_reports_wdl(engine, reference):
    """Smoke: the CLI emits WDL info lines (candidate WDL, inverted) as documented."""
    result = reference.analyze(fen=pos.START)
    assert result["multipv"], "no MultiPV info lines received"
    win, draw, loss = result["multipv"][0]["wdl"]  # type: ignore[index]
    assert win + draw + loss == 1000

"""M8 live-commentary tests: the /explain fact engine + the endpoint contract.

Every expected number below was **observed from the real Maia3-5M model** (CPU,
temperature-1 legal-masked softmax, deterministic — the same values a fresh run
produces; the probe output is summarised here so the expectations are readable).
The rules facts (flags/material/opening) are pure python-chess and were
hand-checked; the model probabilities are recordings, exactly like the M1/M4/M7
golden data.

Positions (see docs/PROJECT.md "Live commentary (M8)"):

* E4      — 1.e4: the opening move; `opening` = B00 King's Pawn Game, mainline.
* BXC6    — 1.e4 e5 2.Nf3 Nc6 3.Bb5 a6 4.Bxc6: a capture (knight on c6),
  Maia's top-1 is 4.Ba4 (84.7%) so the played move ranks 2 -> "common".
* CXD5    — Benoni …4...exd5 5.cxd5: a recapture, mainline 98.4%,
  opening A60 Benoni Defense: Modern Variation.
* O-O     — 1.e4 e5 2.Nf3 Nc6 3.Bc4 Bc5 4.O-O: castling kingside, common.
* O-O-O   — 1.d4 d5 2.Nc3 Nf6 3.Bf4 e6 4.Qd2 Be7 5.O-O-O: queenside castle,
  mainline, opening D01 Rapport-Jobava System.
* MATE    — scholar's mate 4.Qxf7#: mate (and check), mainline 96.2%,
  WDL after = {win 1}.
* EP      — 1.e4 a6 2.e5 d5 3.exd6 e.p.: en passant, captured pawn on d5.
* PROMO   — a K+P endgame base with a8=Q+: promotion + check, no opening
  (base FEN is not the standard start -> honest null).
* RE7     — a K+R endgame: Re7+ (check), rank 11/17, 1.2% -> "rare"; a plain
  check, not mate.
* NH3     — 1.Nh3: rare (0.027%), rank 18/20, Maia's pick e4 (46.5%) is
  surfaced in `maia.top` — the "rank>1 / Maia-preferred" case.
* D6/Nf6  — black-to-move parity: 2...d6 (mainline, B50) and 2...Nf6
  (uncommon 3.4%, B02 Alekhine Defense).
* STALEMATE — a move that stalemates: WDL after is rules-decided draw 1.0.
"""

from __future__ import annotations

import time

import pytest
from fastapi.testclient import TestClient

from app import app
from explain_engine import (
    CLASSIFICATION_COMMON_MIN,
    CLASSIFICATION_UNCOMMON_MIN,
    classify,
    explain_move,
    load_openings,
    opening_for_san,
)
from maia_engine import EngineInputError, get_engine

STARTPOS = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1"

E4_MOVES = ["e2e4"]
BXC6_MOVES = ["e2e4", "e7e5", "g1f3", "b8c6", "f1b5", "a7a6", "b5c6"]
CXD5_MOVES = ["d2d4", "g8f6", "c2c4", "c7c5", "d4d5", "e7e6", "b1c3", "e6d5", "c4d5"]
OO_MOVES = ["e2e4", "e7e5", "g1f3", "b8c6", "f1c4", "f8c5", "e1g1"]
OOO_MOVES = ["d2d4", "d7d5", "b1c3", "g8f6", "c1f4", "e7e6", "d1d2", "f8e7", "e1c1"]
MATE_MOVES = ["e2e4", "e7e5", "f1c4", "b8c6", "d1h5", "g8f6", "h5f7"]
EP_MOVES = ["e2e4", "a7a6", "e4e5", "d7d5", "e5d6"]
D6_MOVES = ["e2e4", "c7c5", "g1f3", "d7d6"]
NF6_MOVES = ["e2e4", "g8f6"]

RE7_FEN = "4k3/8/8/8/8/8/4R3/4K3 w - - 0 1"
PROMO_FEN = "7k/P7/8/8/8/8/8/K7 w - - 0 1"
STALEMATE_FEN = "7k/8/Q7/8/8/8/8/5K2 w - - 0 1"


@pytest.fixture(scope="module")
def client():
    # Context manager runs the lifespan (a no-op here: the engine is warm).
    with TestClient(app) as test_client:
        yield test_client


def _explain(fen: str, moves: list[str], **kwargs):
    return explain_move(get_engine(), fen, moves, **kwargs)


# --------------------------------------------------------------- the facts


def test_opening_move_is_mainline_with_eco_name(engine):
    """1.e4: Maia's own top move, the ECO name of the line, WDL both sides."""
    out = _explain(STARTPOS, E4_MOVES)

    assert out["move"] == {"san": "e4", "uci": "e2e4", "by": "white", "ply": 1, "moveNumber": 1}
    assert out["flags"] == {
        "capture": False,
        "check": False,
        "mate": False,
        "castle": None,
        "promotion": None,
        "enPassant": False,
        "recapture": False,
    }
    assert out["material"] == {"delta": 0, "captured": None}
    assert out["classification"] == "mainline"
    assert out["model"] == "maia3-5m"

    maia = out["maia"]
    assert maia["playedProb"] == pytest.approx(0.464864, abs=1e-6)
    assert maia["rank"] == 1
    assert maia["totalLegal"] == 20
    assert maia["moverElo"] == 2400
    assert [move["san"] for move in maia["top"]] == ["e4", "d4", "Nf3"]
    assert maia["top"][0]["prob"] == pytest.approx(0.464864, abs=1e-6)

    # The startpos value head (same numbers as the M1 golden data) and the value
    # head after 1.e4 flipped to the MOVER's perspective (black's after-WDL was
    # win 0.419506 / draw 0.064554 / loss 0.51594 -> white wins 0.51594).
    assert out["wdl"]["before"] == {"win": 0.476414, "draw": 0.067579, "loss": 0.456007}
    assert out["wdl"]["after"] == {"win": 0.51594, "draw": 0.064554, "loss": 0.419506}
    assert out["opening"] == {"eco": "B00", "name": "King's Pawn Game"}


def test_capture_common_rank2_and_exchange_opening(engine):
    """4.Bxc6: a capture fact + material delta; Maia prefers 4.Ba4 (rank 2)."""
    out = _explain(STARTPOS, BXC6_MOVES)

    assert out["move"]["san"] == "Bxc6"
    assert out["move"]["by"] == "white"
    assert out["move"]["ply"] == 7
    assert out["flags"]["capture"] is True
    assert out["flags"]["recapture"] is False  # ...a6 was not a capture on c6
    assert out["material"] == {"delta": 3, "captured": {"piece": "knight", "square": "c6", "value": 3}}
    assert out["classification"] == "common"
    assert out["maia"]["playedProb"] == pytest.approx(0.150492, abs=1e-6)
    assert out["maia"]["rank"] == 2
    assert out["maia"]["top"][0]["san"] == "Ba4"
    assert out["maia"]["top"][0]["prob"] == pytest.approx(0.847302, abs=1e-6)
    assert out["opening"] == {"eco": "C68", "name": "Ruy Lopez: Exchange Variation"}


def test_recapture_is_flagged(engine):
    """5.cxd5 after 4...exd5: the previous ply captured on the same square."""
    out = _explain(STARTPOS, CXD5_MOVES)

    assert out["move"]["san"] == "cxd5"
    assert out["flags"]["capture"] is True
    assert out["flags"]["recapture"] is True
    assert out["material"] == {"delta": 1, "captured": {"piece": "pawn", "square": "d5", "value": 1}}
    assert out["classification"] == "mainline"
    assert out["maia"]["playedProb"] == pytest.approx(0.983822, abs=1e-6)
    assert out["maia"]["rank"] == 1
    assert out["opening"] == {"eco": "A60", "name": "Benoni Defense: Modern Variation"}


def test_castling_kingside_common(engine):
    """4.O-O: castle kingside; Maia prefers 4.c3."""
    out = _explain(STARTPOS, OO_MOVES)

    assert out["move"]["san"] == "O-O"
    assert out["flags"]["castle"] == "kingside"
    assert out["flags"]["capture"] is False
    assert out["classification"] == "common"
    assert out["maia"]["rank"] == 2
    assert out["maia"]["top"][0]["san"] == "c3"
    assert out["opening"] == {"eco": "C50", "name": "Italian Game: Giuoco Piano"}


def test_castling_queenside_mainline(engine):
    out = _explain(STARTPOS, OOO_MOVES)

    assert out["move"]["san"] == "O-O-O"
    assert out["flags"]["castle"] == "queenside"
    assert out["classification"] == "mainline"
    assert out["maia"]["playedProb"] == pytest.approx(0.479826, abs=1e-6)
    assert out["opening"] == {"eco": "D01", "name": "Rapport-Jobava System"}


def test_promotion_with_check(engine):
    """a8=Q+: promotion (queen) + check; the base FEN is not the start -> no opening."""
    out = _explain(PROMO_FEN, ["a7a8q"])

    assert out["move"]["san"] == "a8=Q+"
    assert out["flags"]["promotion"] == "queen"
    assert out["flags"]["check"] is True
    assert out["flags"]["mate"] is False
    assert out["material"] == {"delta": 0, "captured": None}
    assert out["classification"] == "mainline"
    assert out["maia"]["playedProb"] == pytest.approx(0.890339, abs=1e-6)
    assert out["maia"]["totalLegal"] == 7
    assert [move["san"] for move in out["maia"]["top"]] == ["a8=Q+", "a8=R+", "a8=B"]
    assert out["opening"] is None
    assert out["wdl"]["after"] == {"win": 0.829945, "draw": 0.169285, "loss": 0.000769}


def test_check_rare_surfaces_maia_pick(engine):
    """Re7+: a plain check, rank 11/17, 1.2% -> rare; Maia's pick is surfaced."""
    out = _explain(RE7_FEN, ["e2e7"])

    assert out["move"]["san"] == "Re7+"
    assert out["flags"]["check"] is True
    assert out["flags"]["mate"] is False
    assert out["classification"] == "rare"
    assert out["maia"]["playedProb"] == pytest.approx(0.012146, abs=1e-6)
    assert out["maia"]["rank"] == 11
    assert out["maia"]["totalLegal"] == 17
    # The Maia-preferred move the panel phrases "Maia's pick was …".
    assert out["maia"]["top"][0] == {"uci": "e2d2", "san": "Rd2", "prob": 0.171872}
    assert out["opening"] is None  # base FEN is not the standard start


def test_mate_final_ply_wdl_and_flags(engine):
    """Scholar's mate 4.Qxf7#: mate implies check; WDL after is a rules win."""
    out = _explain(STARTPOS, MATE_MOVES)

    assert out["move"]["san"] == "Qxf7#"
    assert out["move"]["ply"] == 7
    assert out["flags"]["mate"] is True
    assert out["flags"]["check"] is True
    assert out["flags"]["capture"] is True
    assert out["material"]["delta"] == 1
    assert out["classification"] == "mainline"
    assert out["maia"]["playedProb"] == pytest.approx(0.962409, abs=1e-6)
    assert out["wdl"]["after"] == {"win": 1.0, "draw": 0.0, "loss": 0.0}
    assert out["wdl"]["before"] == {"win": 0.815198, "draw": 0.021716, "loss": 0.163086}
    assert out["opening"] == {"eco": "C23", "name": "Bishop's Opening"}


def test_en_passant_material_square(engine):
    """3.exd6 e.p.: the captured pawn is on d5 (behind the target square)."""
    out = _explain(STARTPOS, EP_MOVES)

    assert out["move"]["san"] == "exd6"
    assert out["flags"]["enPassant"] is True
    assert out["flags"]["capture"] is True
    assert out["material"] == {"delta": 1, "captured": {"piece": "pawn", "square": "d5", "value": 1}}
    assert out["classification"] == "mainline"
    assert out["maia"]["playedProb"] == pytest.approx(0.505366, abs=1e-6)
    assert out["opening"] == {"eco": "B00", "name": "St. George Defense"}


def test_rare_move_rank_gt_1_surfaces_maia_preference(engine):
    """1.Nh3: 0.027% -> rare, rank 18/20; Maia's pick (e4, 46.5%) is in `top`."""
    out = _explain(STARTPOS, ["g1h3"])

    assert out["move"]["san"] == "Nh3"
    assert out["classification"] == "rare"
    assert out["maia"]["playedProb"] == pytest.approx(0.000274, abs=1e-6)
    assert out["maia"]["rank"] == 18
    assert out["maia"]["totalLegal"] == 20
    assert out["maia"]["top"][0]["san"] == "e4"
    assert out["maia"]["top"][0]["prob"] == pytest.approx(0.464864, abs=1e-6)
    assert out["opening"] == {"eco": "A00", "name": "Amar Opening"}


def test_stalemate_after_is_a_rules_draw(engine):
    """A move that stalemates: WDL after is the rules-decided draw (mover's view)."""
    out = _explain(STALEMATE_FEN, ["a6g6"])

    assert out["move"]["san"] == "Qg6"
    assert out["flags"]["mate"] is False
    assert out["classification"] == "uncommon"  # 3.58% is inside the 3–10% band
    assert out["wdl"]["after"] == {"win": 0.0, "draw": 1.0, "loss": 0.0}


# -------------------------------------------------------- black-to-move parity


def test_black_to_move_parity(engine):
    """2...d6 (mainline, B50) and 2...Nf6 (uncommon, B02) — by == black."""
    out = _explain(STARTPOS, D6_MOVES)
    assert out["move"] == {"san": "d6", "uci": "d7d6", "by": "black", "ply": 4, "moveNumber": 2}
    assert out["classification"] == "mainline"
    assert out["maia"]["playedProb"] == pytest.approx(0.394606, abs=1e-6)
    assert out["maia"]["moverElo"] == 2400
    assert out["opening"] == {"eco": "B50", "name": "Sicilian Defense: Modern Variations"}

    out2 = _explain(STARTPOS, NF6_MOVES)
    assert out2["move"]["san"] == "Nf6"
    assert out2["move"]["by"] == "black"
    assert out2["classification"] == "uncommon"
    assert out2["maia"]["playedProb"] == pytest.approx(0.034256, abs=1e-6)
    assert out2["maia"]["rank"] == 8
    assert [move["san"] for move in out2["maia"]["top"]] == ["c5", "e5", "c6"]
    assert out2["opening"] == {"eco": "B02", "name": "Alekhine Defense"}


# ---------------------------------------------------- pure helpers / bands


def test_classification_bands_are_the_documented_thresholds():
    assert classify(1, 0.001) == "mainline"  # rank 1 is mainline at ANY probability
    assert classify(2, CLASSIFICATION_COMMON_MIN) == "common"
    assert classify(2, 0.10) == "common"
    assert classify(2, 0.099) == "uncommon"
    assert classify(2, CLASSIFICATION_UNCOMMON_MIN) == "uncommon"
    assert classify(2, 0.029) == "rare"
    assert classify(18, 0.000274) == "rare"
    # the shipped constants are the documented ones
    assert (CLASSIFICATION_COMMON_MIN, CLASSIFICATION_UNCOMMON_MIN) == (0.10, 0.03)


def test_opening_lookup_longest_prefix_and_normalization():
    table = load_openings()
    assert table and len(table) > 3000  # the bundled CC0 table is present

    # longest prefix wins (Ruy Lopez -> Morphy Defense with the ...a6 move)
    assert opening_for_san(["e4", "e5", "Nf3", "Nc6", "Bb5", "a6"]) == {
        "eco": "C70",
        "name": "Ruy Lopez: Morphy Defense",
    }
    # trailing check/mate markers are ignored on the query side too
    assert opening_for_san(["e4", "e5", "Nf3", "Nc6", "Bb5+"]) == {
        "eco": "C60",
        "name": "Ruy Lopez",
    }
    assert opening_for_san(["e4", "e5", "Nf3", "Nc6"]) == {
        "eco": "C44",
        "name": "King's Knight Opening: Normal Variation",
    }
    assert opening_for_san(["e4"]) == {"eco": "B00", "name": "King's Pawn Game"}
    assert opening_for_san(["h3"]) == {"eco": "A00", "name": "Clemenz Opening"}
    assert opening_for_san([]) is None
    assert opening_for_san(["zzz"]) is None  # not a dataset line


# ---------------------------------------------------------------- contract


def test_explain_contract_shape(client):
    response = client.post("/explain", json={"fen": STARTPOS, "moves": E4_MOVES})
    assert response.status_code == 200, response.text
    body = response.json()

    assert set(body) == {
        "move", "flags", "material", "maia", "wdl", "opening", "classification", "model", "elapsed_ms",
    }
    assert body["model"] == "maia3-5m"
    assert isinstance(body["elapsed_ms"], (int, float)) and body["elapsed_ms"] >= 0
    assert set(body["move"]) == {"san", "uci", "by", "ply", "moveNumber"}
    assert set(body["flags"]) == {"capture", "check", "mate", "castle", "promotion", "enPassant", "recapture"}
    assert set(body["material"]) == {"delta", "captured"}
    assert set(body["maia"]) == {"playedProb", "rank", "totalLegal", "top", "moverElo"}
    for move in body["maia"]["top"]:
        assert set(move) == {"uci", "san", "prob"}
        assert 0.0 < move["prob"] <= 1.0
    assert set(body["wdl"]) == {"before", "after"}
    for wdl in body["wdl"].values():
        assert set(wdl) == {"win", "draw", "loss"}
        assert wdl["win"] + wdl["draw"] + wdl["loss"] == pytest.approx(1.0, abs=1e-5)
    assert body["classification"] in {"mainline", "common", "uncommon", "rare"}
    assert body["opening"] == {"eco": "B00", "name": "King's Pawn Game"}
    # `top` is probability-descending and `playedProb` is one of the legal moves.
    probs = [move["prob"] for move in body["maia"]["top"]]
    assert probs == sorted(probs, reverse=True)
    assert 0.0 < body["maia"]["playedProb"] <= 1.0
    assert body["maia"]["rank"] <= body["maia"]["totalLegal"]


def test_explain_history_request_resolves_like_analyze(client):
    """`fen` + `moves` semantics are identical to /analyze (base + UCI on top)."""
    body = client.post("/explain", json={"fen": STARTPOS, "moves": CXD5_MOVES}).json()
    assert body["move"]["san"] == "cxd5"
    # the /analyze distribution at the before position is exactly what /explain used
    analyzed = client.post("/analyze", json={"fen": STARTPOS, "moves": CXD5_MOVES[:-1], "top_k": 3}).json()
    assert analyzed["moves"][0]["uci"] == body["maia"]["top"][0]["uci"]
    assert analyzed["moves"][0]["prob"] == pytest.approx(body["maia"]["top"][0]["prob"], abs=1e-6)
    assert analyzed["wdl"] == body["wdl"]["before"]
    # and the after-WDL is the /analyze value head at the after position, flipped
    after = client.post("/analyze", json={"fen": STARTPOS, "moves": CXD5_MOVES}).json()
    assert after["wdl"]["win"] == pytest.approx(body["wdl"]["after"]["loss"], abs=1e-6)
    assert after["wdl"]["loss"] == pytest.approx(body["wdl"]["after"]["win"], abs=1e-6)


@pytest.mark.parametrize(
    "payload,status,detail_part",
    [
        ({"fen": "definitely-not-a-fen", "moves": ["e2e4"]}, 400, "invalid FEN"),
        ({"fen": STARTPOS, "moves": ["e2e4", "e2e4"]}, 400, "illegal move in history"),
        ({"fen": STARTPOS, "moves": ["e2e4", "zzzz"]}, 400, "invalid UCI move"),
        ({"fen": STARTPOS, "moves": []}, 422, None),  # pydantic min_length=1 (shape error)
        ({"fen": STARTPOS}, 422, None),  # moves is required
    ],
)
def test_explain_contract_errors(client, payload, status, detail_part):
    response = client.post("/explain", json=payload)
    assert response.status_code == status, response.text
    if detail_part is not None:
        assert detail_part in response.json()["detail"]


def test_explain_engine_rejects_empty_moves_directly(engine):
    """The route rejects an empty list first (422); the engine itself says 400-worthy."""
    with pytest.raises(EngineInputError, match="at least one ply"):
        explain_move(engine, STARTPOS, [])


@pytest.mark.parametrize(
    "payload,expected",
    [
        ({"elo_self": 99999}, {"moverElo": 5000}),  # clamped, not rejected
        ({"elo_self": -42}, {"moverElo": 0}),
        ({"elo_oppo": 99999}, {"moverElo": 2400}),  # the opponent's Elo does not leak
    ],
)
def test_explain_numeric_clamps(client, payload, expected):
    response = client.post("/explain", json={"fen": STARTPOS, "moves": E4_MOVES, **payload})
    assert response.status_code == 200, response.text
    for key, value in expected.items():
        assert response.json()["maia"][key] == value


def test_explain_is_deterministic(engine):
    first = _explain(STARTPOS, CXD5_MOVES)
    second = _explain(STARTPOS, CXD5_MOVES)
    for key in ("move", "flags", "material", "maia", "wdl", "opening", "classification"):
        assert first[key] == second[key], key


def test_explain_perf_target(client):
    """Record the fact-engine timings; assert generous bounds (hard fail = bug).

    The M8 target is <= 100 ms per article (2 Maia forward passes). The first call
    after a cold start pages in the model — warm up first, then measure two runs.
    """
    client.post("/explain", json={"fen": STARTPOS, "moves": E4_MOVES})  # warm-up

    samples = []
    for _ in range(2):
        started = time.perf_counter()
        body = client.post("/explain", json={"fen": STARTPOS, "moves": CXD5_MOVES}).json()
        samples.append(((time.perf_counter() - started) * 1000.0, body["elapsed_ms"]))

    print(
        "\nexplain perf: "
        + " | ".join(f"wall {wall:.1f} ms (engine {engine_ms} ms)" for wall, engine_ms in samples)
    )
    for wall, _engine_ms in samples:
        assert wall <= 500, f"explain too slow: {wall:.1f} ms"
    assert min(engine_ms for _wall, engine_ms in samples) <= 100

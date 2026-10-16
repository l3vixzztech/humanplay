"""Engine tests: position coverage, probability invariants, history, WDL, errors."""

from __future__ import annotations

import chess
import pytest

import positions as pos
from maia_engine import EngineInputError, MAX_TOP_K


def _board_after(fen: str, moves=()) -> chess.Board:
    board = chess.Board(fen)
    for uci in moves:
        board.push(chess.Move.from_uci(uci))
    return board


def test_positions_are_legal():
    for name, fen in {**pos.BASIC, "WINNING_BLACK": pos.WINNING_BLACK_TO_MOVE,
                      "WINNING_WHITE": pos.WINNING_WHITE_TO_MOVE}.items():
        board = chess.Board(fen)  # raises if illegal
        assert board.is_valid(), name


@pytest.mark.parametrize("name", list(pos.BASIC))
def test_top_move_is_reasonable(engine, name):
    fen = pos.BASIC[name]
    result = engine.predict(fen, top_k=5)

    assert result["model"] == "maia3-5m"
    assert result["fen"] == chess.Board(fen).fen()

    top1 = result["moves"][0]
    assert top1["uci"] in pos.EXPECTED_TOP1[name], (
        f"{name}: unexpected top move {top1!r}; expected one of {sorted(pos.EXPECTED_TOP1[name])}"
    )
    assert top1["prob"] > 0.1

    board = _board_after(fen)
    for move in result["moves"]:
        mv = chess.Move.from_uci(move["uci"])
        assert mv in board.legal_moves, f"{name}: illegal move returned: {move}"
        assert move["san"] == board.san(mv)
        assert 0.0 < move["prob"] <= 1.0

    probs = [m["prob"] for m in result["moves"]]
    assert probs == sorted(probs, reverse=True)


def test_startpos_probs_sum_to_one(engine):
    result = engine.predict(pos.START, top_k=20)
    assert result["moves"][0]["uci"] in pos.EXPECTED_TOP1["START"]
    # The start position has exactly 20 legal moves, so top-20 covers everything.
    assert len(result["moves"]) == 20
    assert sum(m["prob"] for m in result["moves"]) == pytest.approx(1.0, abs=1e-3)


def test_endgame_probs_sum_to_one(engine):
    legal = chess.Board(pos.ENDGAME).legal_moves.count()
    assert legal <= MAX_TOP_K  # precondition for full coverage
    result = engine.predict(pos.ENDGAME, top_k=MAX_TOP_K)
    assert len(result["moves"]) == legal
    assert sum(m["prob"] for m in result["moves"]) == pytest.approx(1.0, abs=1e-3)


def test_castling_is_offered_as_candidate(engine):
    board = chess.Board(pos.CASTLING)
    assert board.has_castling_rights(chess.WHITE)
    assert chess.Move.from_uci("e1g1") in board.legal_moves

    result = engine.predict(pos.CASTLING, top_k=MAX_TOP_K)
    ucis = [m["uci"] for m in result["moves"]]
    assert "e1g1" in ucis
    assert result["moves"][0]["uci"] in pos.EXPECTED_TOP1["CASTLING"]


def test_promotion_all_four_options_offered_and_queen_preferred(engine):
    board = chess.Board(pos.PROMOTION)
    result = engine.predict(pos.PROMOTION, top_k=MAX_TOP_K)
    ucis = [m["uci"] for m in result["moves"]]

    promotions = {"b7b8q", "b7b8r", "b7b8b", "b7b8n"}
    assert promotions <= set(ucis)
    assert all(chess.Move.from_uci(u) in board.legal_moves for u in ucis)

    assert result["moves"][0]["uci"] in pos.EXPECTED_TOP1["PROMOTION"]
    assert result["moves"][0]["san"].startswith("b8=Q")


@pytest.mark.parametrize("top_k,expected_len", [(1, 1), (3, 3), (20, 20), (100, 20)])
def test_top_k_is_respected_and_clamped(engine, top_k, expected_len):
    result = engine.predict(pos.START, top_k=top_k)
    assert len(result["moves"]) == expected_len


def test_predict_is_deterministic(engine):
    first = engine.predict(pos.MIDDLEGAME, elo_self=2400, elo_oppo=2400)
    second = engine.predict(pos.MIDDLEGAME, elo_self=2400, elo_oppo=2400)
    assert first == second


@pytest.mark.parametrize("elo_self,elo_oppo", [(0, 0), (5000, 5000), (500, 2800), (2800, 500)])
def test_elo_range_accepted(engine, elo_self, elo_oppo):
    result = engine.predict(pos.START, elo_self=elo_self, elo_oppo=elo_oppo)
    assert result["moves"]
    assert sum(m["prob"] for m in result["moves"]) <= 1.0 + 1e-6


@pytest.mark.parametrize("kwargs", [{"elo_self": -1}, {"elo_oppo": 5001}, {"elo_self": "strong"}])
def test_bad_elo_rejected(engine, kwargs):
    with pytest.raises(EngineInputError):
        engine.predict(pos.START, **kwargs)


def test_bad_fen_rejected(engine):
    with pytest.raises(EngineInputError):
        engine.predict("this is not a fen")
    with pytest.raises(EngineInputError):
        engine.predict("")


def test_illegal_history_move_rejected(engine):
    with pytest.raises(EngineInputError, match="illegal move in history"):
        engine.predict(pos.START, moves=["e2e4", "e2e4"])  # second one is illegal
    with pytest.raises(EngineInputError, match="invalid UCI move"):
        engine.predict(pos.START, moves=["not-a-move"])


@pytest.mark.parametrize("name", ["WINNING_BLACK_TO_MOVE", "WINNING_WHITE_TO_MOVE"])
def test_wdl_is_side_to_move_perspective(engine, name):
    fen = getattr(pos, name)
    result = engine.predict(fen, top_k=3)
    wdl = result["wdl"]

    assert sum(wdl.values()) == pytest.approx(1.0, abs=1e-4)
    # The side to move is up a queen in both probe positions.
    assert wdl["win"] > 0.8, f"{name}: value head does not look side-to-move: {wdl}"
    assert wdl["win"] > wdl["loss"]


def test_history_reconstructs_position_and_keeps_quality(engine):
    result = engine.predict(pos.HISTORY_BASE, moves=pos.HISTORY_MOVES, top_k=3)

    assert result["fen"] == pos.HISTORY_RESOLVED_FEN

    board = _board_after(pos.HISTORY_BASE, pos.HISTORY_MOVES)
    assert result["moves"][0]["uci"] in pos.EXPECTED_TOP1_HISTORY
    for move in result["moves"]:
        mv = chess.Move.from_uci(move["uci"])
        assert mv in board.legal_moves
        assert move["san"] == board.san(mv)


def test_history_planes_change_distribution(engine):
    """Same position, different history: the model input must actually differ."""
    fen_after = pos.HISTORY_RESOLVED_FEN

    no_history = engine.predict(fen_after, top_k=3)
    with_history = engine.predict(pos.START, moves=["e2e4", "e7e5"], top_k=3)

    assert no_history["fen"] == with_history["fen"] == fen_after
    assert no_history["moves"] != with_history["moves"], (
        "history planes had no effect: --use-uci-history reconstruction is broken"
    )


def test_checkmate_returns_empty_moves_and_loss_wdl(engine):
    result = engine.predict(pos.FOOLS_MATE_WHITE_MATED)
    assert result["moves"] == []
    assert result["wdl"] == {"win": 0.0, "draw": 0.0, "loss": 1.0}


def test_stalemate_returns_empty_moves_and_draw_wdl(engine):
    result = engine.predict(pos.STALEMATE_BLACK_TO_MOVE)
    assert result["moves"] == []
    assert result["wdl"] == {"win": 0.0, "draw": 1.0, "loss": 0.0}

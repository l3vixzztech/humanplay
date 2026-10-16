"""M7 premove-planner tests: the criteria engine + the /premove contract.

Every expected number below was **observed from the real Maia3-5M model**
(CPU, temperature-0 argmax, deterministic — the same values a fresh run
produces; re-record with the probe in docs/HANDOFF.md if the model changes).
The positions are documented so the expectations are readable by hand:

* FORCED  — black to move, in check, the white queen on d2 is the only checker
  and Kxd2 is impossible: black's ONLY legal move is the recapture Rxd2. The
  planner answers criterion "forced" with our argmax reply Qxd2 (a recapture).
* GUARD   — Benoni (1.d4 Nf6 2.c4 c5 3.d5 e6 4.Nc3), black to move. Their
  obvious move is 4...exd5 (76.6%), and our take-back is 5.cxd5 (Maia's argmax
  after it, 93.2%). Their quiet moves (d6/g6/a6/e5) leave OUR pawn on d5, so
  5.cxd5 is ILLEGAL after them -> that mass is "guard" (safe by inaction).
* NULL    — Italian (1.e4 e5 2.Nf3 Nc6 3.Bc4), black to move. Nf6 (67%) and
  Bc5 (23%) need different white replies -> no single premove clears the bar.
* SAFE_ALL— endgame: black king + a5 pawn vs white king h3 + b7 pawn, black to
  move. Every legal black move is met by b8=Q+ (min 97%): "safe vs all".
* MATE    — after 1.f3 e5 2.g4, black has Qh4# (33.4%). Mating candidates are
  excluded from the masses and reported — never counted as safe. With the
  default bar this yields null; with min_safety 0.5 the gxh5 premove is
  recommended *and the mate is still excluded* (the strictness knob works).
"""

from __future__ import annotations

import time

import pytest
from fastapi.testclient import TestClient

from app import app
from maia_engine import get_engine
from premove_engine import (
    PREMOVE_DEFAULT_MIN_RESPONSE_PROB,
    PREMOVE_DEFAULT_MIN_SAFETY,
    PREMOVE_DEFAULT_TOP_N,
    PREMOVE_MAX_TOP_N,
    plan_premove,
)

# --------------------------------------------------------------------------
# positions (all legal in python-chess; see the module docstring for the story)
# --------------------------------------------------------------------------

FORCED = "8/1n4b1/4K3/5N2/4R3/3k4/1R1Qr1Q1/8 b - - 0 1"
GUARD = "rnbqkb1r/pp1p1ppp/4pn2/2pP4/2P5/2N5/PP2PPPP/R1BQKBNR b KQkq - 1 4"
NULL = "r1bqkbnr/pppp1ppp/2n5/4p3/2B1P3/5N2/PPPP1PPP/RNBQK2R b KQkq - 3 3"
SAFE_ALL = "8/1P6/8/p7/k7/7K/8/8 b - - 0 1"
MATE = "rnbqkbnr/pppp1ppp/8/4p3/6P1/5P2/PPPPP2P/RNBQKBNR b KQkq g3 0 2"
TERMINAL = "7k/5Q2/6K1/8/8/8/8/8 b - - 0 1"  # stalemate (positions.STALEMATE_BLACK_TO_MOVE)


@pytest.fixture(scope="module")
def client():
    # Context manager runs the lifespan (a no-op here: the engine is warm).
    with TestClient(app) as test_client:
        yield test_client


def _plan(fen: str, **kwargs):
    return plan_premove(get_engine(), fen, None, 2400, 2400, **kwargs)


# ---------------------------------------------------------------- criterion 1


def test_forced_recapture(engine):
    """Exactly one legal opponent move -> criterion "forced", recommended = argmax."""
    out = _plan(FORCED, top_n=5, min_safety=0.9, mode="top")

    # Their single legal move is the recapture Rxd2 (the white queen is the checker).
    assert out["opponent"] == [{"uci": "e2d2", "san": "Rxd2", "prob": 1.0}]
    assert out["excluded"] == []
    assert out["reason"] is None

    recommended = out["recommended"]
    assert recommended is not None
    assert recommended["criterion"] == "forced"
    assert (recommended["uci"], recommended["san"]) == ("g2d2", "Qxd2+")  # our recapture, argmax
    assert recommended["safety"] == 1.0
    assert recommended["min_response_prob"] == pytest.approx(0.311407, abs=1e-6)
    assert "forced" in recommended["detail"].lower()

    assert out["candidates"][0]["uci"] == "g2d2"
    assert out["candidates"][0]["verdict"] == "recommended"
    assert "forced" in out["candidates"][0]["why"]

    # The forced answer is exactly /analyze's top-1 for the position after Rxd2.
    after = engine.predict(FORCED, moves=["e2d2"], elo_self=2400, elo_oppo=2400, top_k=1)
    assert after["moves"][0]["uci"] == recommended["uci"]
    assert after["moves"][0]["prob"] == recommended["min_response_prob"]


# ---------------------------------------------------------------- criterion 2


def test_guard_recapture_with_guard_mass(engine):
    """Take-back premove where the quiet moves make it illegal (guard mass).

    Their 4...exd5 (76.6%) is met by our 5.cxd5 (argmax, 93.2%). After ANY other
    candidate (d6/g6/a6/e5) our own pawn still occupies d5, so the premove is
    illegal -> guard mass (safe by inaction), which is exactly what makes the
    recommendation safe while it fires on the capture.
    """
    out = _plan(GUARD, top_n=5, min_safety=0.9, mode="top")

    recommended = out["recommended"]
    assert recommended is not None
    assert (recommended["uci"], recommended["san"]) == ("c4d5", "cxd5")
    assert recommended["criterion"] == "safe_vs_all"

    # Their exd5 is the top candidate (renormalised over the top-5).
    assert out["opponent"][0]["uci"] == "e6d5"
    assert out["opponent"][0]["san"] == "exd5"
    assert out["opponent"][0]["prob"] == pytest.approx(0.765868, abs=1e-6)
    assert sum(m["prob"] for m in out["opponent"]) == pytest.approx(
        1.0, abs=1e-6
    )  # mode "top" renormalises: the five probabilities sum to 1

    top = out["candidates"][0]
    assert top["uci"] == "c4d5"
    assert top["safe_mass"] == pytest.approx(0.765868, abs=1e-6)   # r_c == cxd5 after exd5
    assert top["guard_mass"] == pytest.approx(0.234132, abs=1e-6)  # illegal after the quiet moves
    assert top["guard_mass"] > 0
    assert top["min_response_prob"] == pytest.approx(0.932023, abs=1e-6)
    assert top["verdict"] == "recommended"
    assert "guard" in top["why"]
    # safety = safe_mass + guard_mass, exactly as documented
    assert recommended["safety"] == pytest.approx(1.0, abs=1e-6)

    # 5.cxd5 really is illegal after one of the quiet guard candidates and legal
    # (and best) after exd5 — the mechanism the numbers assert.
    import chess

    board = chess.Board(GUARD)
    after_quiet = board.copy()
    after_quiet.push(chess.Move.from_uci("d7d6"))
    assert chess.Move.from_uci("c4d5") not in after_quiet.legal_moves
    after_capture = board.copy()
    after_capture.push(chess.Move.from_uci("e6d5"))
    assert chess.Move.from_uci("c4d5") in after_capture.legal_moves


# ---------------------------------------------------------------- criterion 3


def test_strict_case_needs_two_replies_is_null(engine):
    """Nf6 (67%) and Bc5 (23%) need different replies -> no premove at all."""
    out = _plan(NULL, top_n=5, min_safety=0.9, mode="top")

    assert out["recommended"] is None
    assert out["excluded"] == []
    assert out["reason"] is not None and out["reason"].startswith("no safe premove:")
    assert "d3" in out["reason"] and "67%" in out["reason"]

    # Every candidate explains itself with a verdict + why (panel transparency).
    assert out["candidates"], "the planner must still report what it considered"
    for candidate in out["candidates"]:
        assert candidate["verdict"] == "not_safe"
        assert "safety" in candidate["why"]
    best = out["candidates"][0]
    assert best["san"] == "d3"
    assert best["safe_mass"] == pytest.approx(0.672787, abs=1e-6)
    assert best["guard_mass"] == 0.0


# ---------------------------------------------------------------- criterion 4


def test_safe_vs_all_endgame(engine):
    """Every legal reply is met by the same move -> criterion "safe_vs_all"."""
    out = _plan(SAFE_ALL, top_n=5, min_safety=0.9, mode="all")

    # mode "all": every legal black move is a candidate (4 king moves).
    assert [m["san"] for m in out["opponent"]] == ["Kb3", "Ka3", "Kb4", "Kb5"]
    assert len(out["candidates"]) == 1

    recommended = out["recommended"]
    assert recommended is not None
    assert (recommended["uci"], recommended["san"]) == ("b7b8q", "b8=Q+")
    assert recommended["criterion"] == "safe_vs_all"
    assert recommended["safety"] == 1.0
    assert recommended["min_response_prob"] == pytest.approx(0.970762, abs=1e-6)

    top = out["candidates"][0]
    assert top["safe_mass"] == 1.0
    assert top["guard_mass"] == 0.0
    assert "100%" in top["why"]


# ---------------------------------------------------------------- criterion 5


def test_opponent_mate_candidate_is_excluded(engine):
    """A mating candidate is excluded + reported, never counted as safe.

    Default bar (0.90): the 33.4% mate makes the recommendation impossible ->
    null with the honest reason. Looser bar (0.50): gxh5 is recommended while
    the mate stays excluded (excluded mass is not part of the safety sum).
    """
    strict = _plan(MATE, top_n=5, min_safety=0.9, mode="top")

    assert strict["recommended"] is None
    assert strict["reason"] is not None and "no safe premove" in strict["reason"]
    assert strict["excluded"] == [
        {"uci": "d8h4", "san": "Qh4#", "prob": pytest.approx(0.333389, abs=1e-6), "reason": "checkmate"}
    ]
    # The mate is still one of the opponent's candidates in the top-N list.
    assert any(m["uci"] == "d8h4" for m in strict["opponent"])
    # ... and it appears in NO candidate's masses (safe + guard <= 1 - mate mass).
    for candidate in strict["candidates"]:
        assert candidate["safe_mass"] + candidate["guard_mass"] <= 1.0 - 0.333389 + 1e-6

    loose = _plan(MATE, top_n=5, min_safety=0.5, mode="top")
    recommended = loose["recommended"]
    assert recommended is not None
    assert (recommended["uci"], recommended["san"]) == ("g4h5", "gxh5")
    assert recommended["criterion"] == "robust"
    assert recommended["safety"] == pytest.approx(0.666611, abs=1e-6)
    assert loose["excluded"] == strict["excluded"]  # still excluded at the looser bar
    top = loose["candidates"][0]
    assert top["safe_mass"] == pytest.approx(0.125783, abs=1e-6)
    assert top["guard_mass"] == pytest.approx(0.540828, abs=1e-6)


def test_min_response_prob_floor_is_documented_and_effective(engine):
    """A candidate can pass min_safety but be refused by the response floor."""
    # gxh5 covers 66.7% >= 0.5 and min response prob 61.6%; with a floor ABOVE
    # that confidence the same position must return null with the floor reason.
    out = plan_premove(
        get_engine(), MATE, None, 2400, 2400, 5, 0.5, "top", min_response_prob=0.8
    )
    assert out["recommended"] is None
    assert out["reason"] is not None and "floor" in out["reason"]
    assert PREMOVE_DEFAULT_MIN_RESPONSE_PROB == 0.15  # the shipped default is documented
    verdicts = {c["uci"]: c["verdict"] for c in out["candidates"]}
    assert verdicts["g4h5"] == "below_floor"


# ----------------------------------------------------------------- contract


def test_premove_contract_shape(client):
    response = client.post("/premove", json={"fen": GUARD, "top_n": 3, "min_safety": 0.9, "mode": "top"})
    assert response.status_code == 200
    body = response.json()

    assert set(body) == {
        "fen", "side_to_move", "opponent", "recommended", "candidates",
        "excluded", "reason", "params", "timings_ms", "model", "elapsed_ms",
    }
    assert body["model"] == "maia3-5m"
    assert body["side_to_move"] == "black"
    assert body["fen"] == GUARD
    assert isinstance(body["elapsed_ms"], (int, float)) and body["elapsed_ms"] >= 0
    assert set(body["timings_ms"]) == {"root", "responses", "total"}
    assert body["timings_ms"]["total"] == pytest.approx(body["elapsed_ms"], abs=0.01)

    assert body["params"] == {
        "elo_self": 2400, "elo_oppo": 2400, "top_n": 3, "min_safety": 0.9,
        "min_response_prob": PREMOVE_DEFAULT_MIN_RESPONSE_PROB, "mode": "top",
    }
    assert len(body["opponent"]) == 3  # top_n requested
    for move in body["opponent"]:
        assert set(move) == {"uci", "san", "prob"}
        assert 0.0 < move["prob"] <= 1.0
    assert sum(m["prob"] for m in body["opponent"]) == pytest.approx(1.0, abs=1e-6)
    assert sorted((m["prob"] for m in body["opponent"]), reverse=True) == [
        m["prob"] for m in body["opponent"]
    ]

    recommended = body["recommended"]
    assert set(recommended) == {"uci", "san", "criterion", "safety", "min_response_prob", "detail"}
    assert recommended["criterion"] in {"forced", "safe_vs_all", "robust"}
    assert 0.0 <= recommended["safety"] <= 1.0

    for candidate in body["candidates"]:
        assert set(candidate) == {"uci", "san", "safe_mass", "guard_mass", "min_response_prob", "verdict", "why"}
        assert candidate["verdict"] in {"recommended", "not_safe", "below_floor", "no_safe_mass"}
        assert 0.0 <= candidate["safe_mass"] <= 1.0
        assert 0.0 <= candidate["guard_mass"] <= 1.0
        assert candidate["safe_mass"] + candidate["guard_mass"] <= 1.0 + 1e-9

    # The recommended candidate's masses agree with the recommendation's safety.
    chosen = next(c for c in body["candidates"] if c["verdict"] == "recommended")
    assert chosen["uci"] == recommended["uci"]
    assert chosen["safe_mass"] + chosen["guard_mass"] == pytest.approx(recommended["safety"], abs=1e-6)


def test_premove_defaults(client):
    body = client.post("/premove", json={"fen": GUARD}).json()
    assert body["params"]["top_n"] == PREMOVE_DEFAULT_TOP_N == 5
    assert body["params"]["min_safety"] == PREMOVE_DEFAULT_MIN_SAFETY == 0.90
    assert body["params"]["mode"] == "top"
    assert len(body["opponent"]) == 5


@pytest.mark.parametrize(
    "payload,expected",
    [
        ({"fen": GUARD, "top_n": 99}, {"top_n": PREMOVE_MAX_TOP_N}),   # clamped high
        ({"fen": GUARD, "top_n": 0}, {"top_n": 1}),                     # clamped low
        ({"fen": GUARD, "top_n": -3}, {"top_n": 1}),
        ({"fen": GUARD, "min_safety": 0.1}, {"min_safety": 0.5}),       # clamped low
        ({"fen": GUARD, "min_safety": 2.0}, {"min_safety": 1.0}),       # clamped high
        ({"fen": GUARD, "elo_self": 99999}, {"elo_self": 5000}),        # clamped, not rejected
        ({"fen": GUARD, "elo_oppo": -42}, {"elo_oppo": 0}),
    ],
)
def test_premove_numeric_clamps(client, payload, expected):
    response = client.post("/premove", json=payload)
    assert response.status_code == 200, response.text
    for key, value in expected.items():
        assert response.json()["params"][key] == value


def test_premove_top_n_clamp_limits_candidates(client):
    body = client.post("/premove", json={"fen": GUARD, "top_n": 99}).json()
    assert body["params"]["top_n"] == PREMOVE_MAX_TOP_N
    assert len(body["opponent"]) == PREMOVE_MAX_TOP_N  # 26 legal moves in GUARD > 12


def test_premove_bad_fen_is_400(client):
    response = client.post("/premove", json={"fen": "definitely-not-a-fen"})
    assert response.status_code == 400
    assert "invalid FEN" in response.json()["detail"]


def test_premove_illegal_history_move_is_400(client):
    response = client.post("/premove", json={"fen": "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1", "moves": ["e2e4", "e2e4"]})
    assert response.status_code == 400
    assert "illegal move in history" in response.json()["detail"]


def test_premove_invalid_mode_is_422(client):
    response = client.post("/premove", json={"fen": GUARD, "mode": "sometimes"})
    assert response.status_code == 422


def test_premove_terminal_position_is_null_with_reason(client):
    response = client.post("/premove", json={"fen": TERMINAL})
    assert response.status_code == 200
    body = response.json()
    assert body["recommended"] is None
    assert body["opponent"] == [] and body["candidates"] == []
    assert "game over" in body["reason"] and "stalemate" in body["reason"]


def test_premove_mode_all_covers_every_legal_move(client):
    body = client.post("/premove", json={"fen": GUARD, "mode": "all"}).json()
    import chess

    legal = {m.uci() for m in chess.Board(GUARD).legal_moves}
    assert {m["uci"] for m in body["opponent"]} == legal
    assert sum(m["prob"] for m in body["opponent"]) == pytest.approx(1.0, abs=1e-5)


def test_premove_history_MOVES_and_elo_are_forwarded(client):
    """A history request resolves like /analyze (base FEN + UCI moves)."""
    body = client.post(
        "/premove",
        json={
            "fen": "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
            "moves": ["d2d4", "g8f6", "c2c4", "c7c5", "d4d5", "e7e6", "b1c3"],
            "top_n": 5,
        },
    ).json()
    assert body["fen"] == GUARD  # exactly the GUARD position
    assert body["side_to_move"] == "black"
    assert body["recommended"]["uci"] == "c4d5"  # same recommendation as the FEN form


def test_premove_perf_targets(client):
    """Record the planner's timings; assert generous bounds (hard fail = bug).

    Targets documented in the M7 brief: mode "top" <= 300 ms, mode "all" <= 1.5 s.
    The assertions are looser (machine load / CI) — the measured numbers are the
    deliverable and are printed + recorded in the proof/handoff.
    """
    # warm-up (first call after a server start may page in the model)
    client.post("/premove", json={"fen": GUARD})

    top_started = time.perf_counter()
    top = client.post("/premove", json={"fen": GUARD, "mode": "top"}).json()
    top_ms = (time.perf_counter() - top_started) * 1000.0

    all_started = time.perf_counter()
    all_ = client.post("/premove", json={"fen": GUARD, "mode": "all"}).json()
    all_ms = (time.perf_counter() - all_started) * 1000.0

    print(
        f"\npremove perf: top {top_ms:.1f} ms (engine {top['elapsed_ms']} ms, "
        f"{len(top['opponent'])} candidates) | all {all_ms:.1f} ms "
        f"(engine {all_['elapsed_ms']} ms, {len(all_['opponent'])} candidates)"
    )
    assert top_ms <= 1500, f"top mode too slow: {top_ms:.1f} ms"
    assert all_ms <= 5000, f"all mode too slow: {all_ms:.1f} ms"


def test_premove_is_deterministic(engine):
    first = _plan(GUARD, top_n=5, min_safety=0.9, mode="top")
    second = _plan(GUARD, top_n=5, min_safety=0.9, mode="top")
    for key in ("opponent", "recommended", "candidates", "excluded", "reason"):
        assert first[key] == second[key], key

"""API contract tests for the FastAPI layer (httpx TestClient)."""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

import positions as pos
from app import app


@pytest.fixture(scope="session")
def client():
    # Context manager runs the lifespan (model warm-up) like a real server start.
    with TestClient(app) as test_client:
        yield test_client


def test_health(client):
    response = client.get("/health")
    assert response.status_code == 200
    body = response.json()
    # M9: version + uptime are additive (the extension shows version).
    assert body["status"] == "ok"
    assert body["model"] == "maia3-5m"
    assert body["version"] == "1.0.0"
    assert isinstance(body["uptime_s"], (int, float)) and body["uptime_s"] >= 0


def test_analyze_contract(client):
    response = client.post("/analyze", json={"fen": pos.START})
    assert response.status_code == 200

    body = response.json()
    assert set(body) == {"moves", "wdl", "model", "elapsed_ms"}
    assert body["model"] == "maia3-5m"
    assert isinstance(body["elapsed_ms"], (int, float)) and body["elapsed_ms"] >= 0

    assert len(body["moves"]) == 3  # default top_k
    for move in body["moves"]:
        assert set(move) == {"uci", "san", "prob"}
        assert isinstance(move["uci"], str) and move["uci"]
        assert isinstance(move["san"], str) and move["san"]
        assert 0.0 < move["prob"] <= 1.0
    probs = [m["prob"] for m in body["moves"]]
    assert probs == sorted(probs, reverse=True)
    assert body["moves"][0]["uci"] in pos.EXPECTED_TOP1["START"]

    assert set(body["wdl"]) == {"win", "draw", "loss"}
    assert sum(body["wdl"].values()) == pytest.approx(1.0, abs=1e-4)


def test_analyze_with_moves_elos_and_top_k(client):
    response = client.post(
        "/analyze",
        json={
            "fen": pos.HISTORY_BASE,
            "moves": pos.HISTORY_MOVES,
            "elo_self": 2400,
            "elo_oppo": 2200,
            "top_k": 5,
        },
    )
    assert response.status_code == 200
    body = response.json()
    assert len(body["moves"]) == 5
    assert body["moves"][0]["uci"] in pos.EXPECTED_TOP1_HISTORY


def test_analyze_checkmate_position(client):
    response = client.post("/analyze", json={"fen": pos.FOOLS_MATE_WHITE_MATED})
    assert response.status_code == 200
    body = response.json()
    assert body["moves"] == []
    assert body["wdl"] == {"win": 0.0, "draw": 0.0, "loss": 1.0}


def test_analyze_invalid_fen_is_400(client):
    response = client.post("/analyze", json={"fen": "definitely-not-a-fen"})
    assert response.status_code == 400
    assert "invalid FEN" in response.json()["detail"]


def test_analyze_illegal_history_move_is_400(client):
    response = client.post("/analyze", json={"fen": pos.START, "moves": ["e2e4", "e2e4"]})
    assert response.status_code == 400
    assert "illegal move in history" in response.json()["detail"]


@pytest.mark.parametrize(
    "payload",
    [
        {"fen": pos.START, "elo_self": 5001},
        {"fen": pos.START, "elo_oppo": -1},
        {"fen": pos.START, "top_k": 0},
        {"fen": pos.START, "top_k": 21},
        {},  # missing fen
    ],
)
def test_analyze_validation_errors_are_422(client, payload):
    response = client.post("/analyze", json=payload)
    assert response.status_code == 422


@pytest.mark.parametrize(
    "origin",
    ["chrome-extension://abcdefghijklmnopabcdefghijklmnop", "http://localhost:3000", "http://127.0.0.1:5173"],
)
def test_cors_allows_local_and_extension_origins(client, origin):
    response = client.get("/health", headers={"Origin": origin})
    assert response.status_code == 200
    assert response.headers.get("access-control-allow-origin") == origin


def test_cors_blocks_foreign_origin(client):
    response = client.get("/health", headers={"Origin": "https://evil.example.com"})
    assert response.status_code == 200
    assert "access-control-allow-origin" not in response.headers

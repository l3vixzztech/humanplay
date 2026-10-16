"""FastAPI app for the humanplay Maia-3 helper server.

Endpoints
---------
GET  /health   -> {"status", "model"}
POST /analyze  -> {"moves": [{"uci", "san", "prob"}], "wdl": {"win", "draw", "loss"},
                   "model", "elapsed_ms"}

Binds 127.0.0.1:8765 by default (see README / run instructions). CORS is
permissive for local dev only: localhost/127.0.0.1 origins and
chrome-extension:// origins are allowed.

Run:
    cd server
    .venv/bin/python -m uvicorn app:app --host 127.0.0.1 --port 8765
"""

from __future__ import annotations

import logging
import time
from contextlib import asynccontextmanager
from typing import List, Optional

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

from maia_engine import (
    DEFAULT_ELO_OPPO,
    DEFAULT_ELO_SELF,
    DEFAULT_TOP_K,
    ELO_MAX,
    ELO_MIN,
    MAX_TOP_K,
    EngineInputError,
    get_engine,
)

log = logging.getLogger("humanplay.server")


class AnalyzeRequest(BaseModel):
    fen: str = Field(
        ...,
        min_length=1,
        description=(
            "Base position FEN. When 'moves' is given they are applied on top of it "
            "(UCI 'position fen <fen> moves ...' semantics); the resulting position is analysed."
        ),
        examples=["rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1"],
    )
    moves: Optional[List[str]] = Field(
        None,
        description=(
            "Optional UCI move history applied to 'fen'. Reconstructs the model history planes "
            "(--use-uci-history semantics). Omit for the no-history default."
        ),
        examples=[["e2e4", "e7e5"]],
    )
    elo_self: int = Field(
        DEFAULT_ELO_SELF,
        ge=ELO_MIN,
        le=ELO_MAX,
        description="Elo of the side to move (the player we pick a move for). Default 2400.",
    )
    elo_oppo: int = Field(
        DEFAULT_ELO_OPPO,
        ge=ELO_MIN,
        le=ELO_MAX,
        description="Elo of the opponent. Default 2400.",
    )
    top_k: int = Field(
        DEFAULT_TOP_K,
        ge=1,
        le=MAX_TOP_K,
        description=f"Number of candidate moves to return (1..{MAX_TOP_K}). Default {DEFAULT_TOP_K}.",
    )


class MoveOut(BaseModel):
    uci: str
    san: str
    prob: float


class WdlOut(BaseModel):
    win: float
    draw: float
    loss: float


class AnalyzeResponse(BaseModel):
    moves: List[MoveOut]
    wdl: WdlOut
    model: str
    elapsed_ms: float


class HealthResponse(BaseModel):
    status: str
    model: str


@asynccontextmanager
async def lifespan(_app: FastAPI):
    # Warm up the model so the first /analyze is fast. A failure here (e.g. no
    # network for the first checkpoint download) is not fatal: the server still
    # answers /health and /analyze retries the load on demand.
    try:
        get_engine().ensure_loaded()
        log.info("Maia-3 model '%s' loaded", get_engine().model_alias)
    except Exception:
        log.exception("Maia-3 warm-up failed; /analyze will retry on first request")
    yield


app = FastAPI(
    title="humanplay Maia-3 helper",
    description="Local Maia-3 (human-move model) helper for the humanplay Chrome extension.",
    version="0.1.0",
    lifespan=lifespan,
)

# Dev-only permissive CORS: localhost + chrome-extension origins.
app.add_middleware(
    CORSMiddleware,
    allow_origin_regex=r"^(chrome-extension://.*|http://(localhost|127\.0\.0\.1)(:\d+)?)$",
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/health", response_model=HealthResponse)
def health() -> HealthResponse:
    engine = get_engine()
    return HealthResponse(
        status="ok" if engine.is_loaded else "not_loaded",
        model=engine.model_alias,
    )


@app.post("/analyze", response_model=AnalyzeResponse)
def analyze(request: AnalyzeRequest) -> AnalyzeResponse:
    engine = get_engine()
    started = time.perf_counter()
    try:
        result = engine.predict(
            request.fen,
            moves=request.moves,
            elo_self=request.elo_self,
            elo_oppo=request.elo_oppo,
            top_k=request.top_k,
        )
    except EngineInputError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:  # model download/load/backend failure
        log.exception("analyze failed")
        raise HTTPException(status_code=503, detail=f"engine unavailable: {exc}") from exc

    elapsed_ms = round((time.perf_counter() - started) * 1000.0, 2)
    return AnalyzeResponse(
        moves=[MoveOut(**move) for move in result["moves"]],
        wdl=WdlOut(**result["wdl"]),
        model=result["model"],
        elapsed_ms=elapsed_ms,
    )


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="127.0.0.1", port=8765)

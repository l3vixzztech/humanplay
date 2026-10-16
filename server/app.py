"""FastAPI app for the humanplay Maia-3 helper server.

Endpoints
---------
GET  /health   -> {"status", "model"}
POST /analyze  -> {"moves": [{"uci", "san", "prob"}], "wdl": {"win", "draw", "loss"},
                   "model", "elapsed_ms"}
POST /premove  -> {"opponent": [...], "recommended": null | {...}, "candidates": [...],
                   "excluded": [...], "reason", "params", "timings_ms", "model",
                   "elapsed_ms"}   (M7 premove planner — see premove_engine.py)
POST /explain  -> {"move": {...}, "flags": {...}, "material": {...}, "maia": {...},
                   "wdl": {"before", "after"}, "opening": null | {"eco", "name"},
                   "classification", "model", "elapsed_ms"}
                  (M8 live commentary facts — see explain_engine.py; explains the
                   LAST ply of `moves`)

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
from typing import List, Literal, Optional

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
from premove_engine import (
    PREMOVE_DEFAULT_MIN_SAFETY,
    PREMOVE_DEFAULT_MODE,
    PREMOVE_DEFAULT_TOP_N,
    PREMOVE_MAX_TOP_N,
    PREMOVE_MIN_TOP_N,
    PREMOVE_MODES,
    plan_premove,
)
from explain_engine import (  # M8: live commentary facts (additive; /analyze + /premove untouched)
    CLASSIFICATIONS,
    explain_move,
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


# --------------------------------------------------------------- M7 /premove


class PremoveRequest(BaseModel):
    fen: str = Field(
        ...,
        min_length=1,
        description=(
            "Base position FEN. When 'moves' is given they are applied on top of it "
            "(UCI 'position fen <fen> moves ...' semantics). The resolved position must "
            "have the OPPONENT to move (the planner predicts their moves and our premove)."
        ),
        examples=["rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 2"],
    )
    moves: Optional[List[str]] = Field(
        None,
        description="Optional UCI move history applied to 'fen' (same semantics as /analyze).",
        examples=[["e2e4", "e7e5"]],
    )
    elo_self: int = Field(
        DEFAULT_ELO_SELF,
        description=(
            "Elo of YOU (the premover) — used for the reply predictions after each candidate. "
            "Clamped to 0..5000 (the model's trained range), not rejected."
        ),
    )
    elo_oppo: int = Field(
        DEFAULT_ELO_OPPO,
        description=(
            "Elo of the OPPONENT — used for the candidate distribution of their moves. "
            "Clamped to 0..5000, not rejected."
        ),
    )
    top_n: int = Field(
        PREMOVE_DEFAULT_TOP_N,
        description=(
            f"mode='top': how many of the opponent's most likely moves are considered "
            f"(clamped {PREMOVE_MIN_TOP_N}..{PREMOVE_MAX_TOP_N}). Default {PREMOVE_DEFAULT_TOP_N}. "
            "mode='all' ignores it (every legal move is evaluated)."
        ),
    )
    min_safety: float = Field(
        PREMOVE_DEFAULT_MIN_SAFETY,
        description=(
            "Required fraction of the considered opponent probability mass that must be "
            "safe (our planned reply is also Maia's argmax, or the premove cannot fire). "
            "Clamped 0.5..1.0. Default 0.90."
        ),
    )
    mode: Literal["top", "all"] = Field(
        PREMOVE_DEFAULT_MODE,
        description=(
            "'top' (default) evaluates Maia(elo_oppo)'s top_n moves with probabilities "
            "renormalised over them (fast, ≤300 ms); 'all' evaluates every legal opponent move "
            "(full Maia sweep, ≤1.5 s on this machine)."
        ),
    )


class PremoveMoveOut(BaseModel):
    uci: str
    san: str
    prob: float


class PremoveRecommendedOut(BaseModel):
    uci: str
    san: str
    criterion: Literal["forced", "safe_vs_all", "robust"]
    safety: float
    min_response_prob: float
    detail: str


class PremoveCandidateOut(BaseModel):
    uci: str
    san: str
    safe_mass: float
    guard_mass: float
    min_response_prob: float
    verdict: Literal["recommended", "not_safe", "below_floor", "no_safe_mass"]
    why: str


class PremoveExcludedOut(BaseModel):
    uci: str
    san: str
    prob: float
    reason: str


class PremoveParamsOut(BaseModel):
    elo_self: int
    elo_oppo: int
    top_n: int
    min_safety: float
    min_response_prob: float
    mode: str


class PremoveResponse(BaseModel):
    fen: str
    side_to_move: str
    opponent: List[PremoveMoveOut]
    recommended: Optional[PremoveRecommendedOut]
    candidates: List[PremoveCandidateOut]
    excluded: List[PremoveExcludedOut]
    reason: Optional[str]
    params: PremoveParamsOut
    timings_ms: dict
    model: str
    elapsed_ms: float


# --------------------------------------------------------------- M8 /explain


class ExplainRequest(BaseModel):
    fen: str = Field(
        ...,
        min_length=1,
        description=(
            "Base position FEN. When 'moves' is given they are applied on top of it "
            "(UCI 'position fen <fen> moves ...' semantics); the LAST ply of 'moves' is "
            "the move to explain. The extension sends the standard start position + the "
            "full replayed UCI history."
        ),
        examples=["rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1"],
    )
    moves: List[str] = Field(
        ...,
        min_length=1,
        description=(
            "UCI move history whose LAST element is the move to explain (the history "
            "before it fills Maia's history planes). Empty is a 400: there is no move "
            "to explain without at least one ply."
        ),
        examples=[["e2e4", "e7e5", "g1f3"]],
    )
    elo_self: int = Field(
        DEFAULT_ELO_SELF,
        description=(
            "Elo of the MOVER (well — of the side to move of the position before the "
            "explained move; Maia conditions on the side to move, and that is the mover). "
            "Clamped to 0..5000 (the model's trained range), not rejected."
        ),
    )
    elo_oppo: int = Field(
        DEFAULT_ELO_OPPO,
        description="Elo of the other player. Clamped to 0..5000, not rejected.",
    )


class ExplainMoveOut(BaseModel):
    san: str
    uci: str
    by: Literal["white", "black"]
    ply: int
    moveNumber: int


class ExplainFlagsOut(BaseModel):
    capture: bool
    check: bool
    mate: bool
    castle: Optional[Literal["kingside", "queenside"]]
    promotion: Optional[Literal["queen", "rook", "bishop", "knight"]]
    enPassant: bool
    recapture: bool


class ExplainCapturedOut(BaseModel):
    piece: Literal["pawn", "knight", "bishop", "rook", "queen", "king"]
    square: str
    value: int


class ExplainMaterialOut(BaseModel):
    delta: int
    captured: Optional[ExplainCapturedOut]


class ExplainTopMoveOut(BaseModel):
    uci: str
    san: str
    prob: float


class ExplainMaiaOut(BaseModel):
    playedProb: float
    rank: int
    totalLegal: int
    top: List[ExplainTopMoveOut]
    moverElo: int


class ExplainWdlOut(BaseModel):
    before: WdlOut
    after: WdlOut


class ExplainOpeningOut(BaseModel):
    eco: str
    name: str


class ExplainResponse(BaseModel):
    move: ExplainMoveOut
    flags: ExplainFlagsOut
    material: ExplainMaterialOut
    maia: ExplainMaiaOut
    wdl: ExplainWdlOut
    opening: Optional[ExplainOpeningOut]
    classification: Literal["mainline", "common", "uncommon", "rare"]
    model: str
    elapsed_ms: float


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


@app.post("/premove", response_model=PremoveResponse)
def premove(request: PremoveRequest) -> PremoveResponse:
    """Premove planner (M7): one safe reply to premove, or an honest null.

    Deterministic criteria engine in `premove_engine.py` (reuses the same Maia-3
    engine as /analyze; /analyze itself is untouched). Numeric request knobs are
    clamped, so a stray value can never break the opponent's turn.
    """
    engine = get_engine()
    try:
        result = plan_premove(
            engine,
            request.fen,
            moves=request.moves,
            elo_self=request.elo_self,
            elo_oppo=request.elo_oppo,
            top_n=request.top_n,
            min_safety=request.min_safety,
            mode=request.mode,
        )
    except EngineInputError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:  # model download/load/backend failure
        log.exception("premove failed")
        raise HTTPException(status_code=503, detail=f"engine unavailable: {exc}") from exc

    return PremoveResponse(**result)


@app.post("/explain", response_model=ExplainResponse)
def explain(request: ExplainRequest) -> ExplainResponse:
    """Live commentary facts for the LAST ply of `moves` (M8).

    Deterministic python-chess + Maia-3 facts (see `explain_engine.py`): rules
    flags, material, the mover's own probability distribution, the mover's WDL
    before/after, the opening name and a documented probability band. No engine
    claims, no judgement words. Numeric knobs clamp; invalid input is 400.
    """
    engine = get_engine()
    try:
        result = explain_move(
            engine,
            request.fen,
            request.moves,
            elo_self=request.elo_self,
            elo_oppo=request.elo_oppo,
        )
    except EngineInputError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:  # model download/load/backend failure
        log.exception("explain failed")
        raise HTTPException(status_code=503, detail=f"engine unavailable: {exc}") from exc

    return ExplainResponse(**result)


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="127.0.0.1", port=8765)

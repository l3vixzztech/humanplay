"""Maia-3 live-commentary fact engine (Milestone 8) — the honest facts for `/explain`.

WHY this exists
---------------
The M8 commentary must be **factual, fast and never invent chess claims**: every
sentence the panel shows is derived from (a) python-chess rules on the exact
move, and (b) Maia-3's own probability distribution at the position *before* the
move. Nothing here evaluates the move with an engine; there is no "best move",
no tactics, no judgement words — the classification is a probability band, not a
quality label.

The engine explains ONE move: the **last ply** of `moves` (the request carries
`fen` = base position + `moves` = the UCI history ending with the move to
explain, exactly like ``position fen <fen> moves ...``).

What it computes (all deterministic)
------------------------------------
* **move** — SAN/UCI of the explained move, the mover's color, its 1-based ply
  index in the supplied history and the full-move number from the position
  before the move.
* **flags** — capture / check / mate / castling side / promotion piece / en
  passant, straight from python-chess (`mate` implies `check`). `recapture` is
  the M8 addition: the previous ply captured **on the same square** this move
  captures on (that is what makes the panel phrase "a recapture" — a fact about
  the move order, not a claim about quality).
* **material** — the captured piece (name, square, pawn-unit value) and
  ``delta`` = the material the mover gained (0 for a quiet move). Values are the
  standard P=1, N/B=3, R=5, Q=9, K=0.
* **maia** — the mover's own move distribution before the move
  (``move_probabilities``: the full legal-masked softmax, Elos as sent — Maia is
  conditioned on the **side to move**, and the side to move of the before
  position IS the mover): ``playedProb``, 1-based ``rank`` in the deterministic
  order (probability descending, UCI tie-break), ``totalLegal``, the top-3
  alternatives and the ``moverElo`` used.
* **wdl** — the human value head, **from the mover's perspective**, before and
  after the move. ``before`` is the model's value head at the before position
  (side to move = the mover). ``after`` is the value head at the after position
  (side to move = the opponent) with win/loss flipped; a terminal after position
  (mate, stalemate, …) is answered by the rules exactly like ``/analyze``.
* **opening** — ``{eco, name}`` of the longest prefix of the game's SAN
  sequence present in the bundled lichess chess-openings table (CC0-1.0; see
  ``server/data/README.md`` and ``server/tools/generate_openings.py``), or
  ``null`` when nothing matches — and **always null when the base FEN is not the
  standard start position** (the pre-base moves are unknowable, so no honest
  name can be given). Transpositions via a move order that is not a prefix of a
  dataset line are not recognized (documented in docs/PROJECT.md).
* **classification** — a **probability band**, with exactly these documented
  thresholds on the played move's probability ``p`` in the mover's distribution:
  ``mainline`` = rank 1 (Maia's most likely move, whatever its probability);
  ``common`` = ``p >= 0.10``; ``uncommon`` = ``0.03 <= p < 0.10``;
  ``rare`` = ``p < 0.03``. These are bands about how often humans play the move
  at this Elo — not a judgement.

Cost: two Maia forward passes (the full distribution before + the value head
after) — measured ≈40 ms on CPU, target ≤100 ms. The module reuses the same
:class:`MaiaEngine` as ``/analyze``/``/premove``; neither of those paths is
touched. Numerical request knobs (``elo_*``) are **clamped** to Maia's trained
range 0..5000 (like ``/premove``): a stray value can never break the feed.
Invalid FEN, an illegal history move or an empty ``moves`` list raise
:class:`EngineInputError` → HTTP 400.
"""

from __future__ import annotations

import json
import threading
import time
from pathlib import Path
from typing import Any, Dict, List, Optional, Sequence

import chess

from maia_engine import (
    DEFAULT_ELO_OPPO,
    DEFAULT_ELO_SELF,
    ELO_MAX,
    ELO_MIN,
    EngineInputError,
    MaiaEngine,
)

# -- documented classification bands ----------------------------------------

CLASSIFICATION_MAINLINE = "mainline"
CLASSIFICATION_COMMON = "common"
CLASSIFICATION_UNCOMMON = "uncommon"
CLASSIFICATION_RARE = "rare"
CLASSIFICATIONS = (
    CLASSIFICATION_MAINLINE,
    CLASSIFICATION_COMMON,
    CLASSIFICATION_UNCOMMON,
    CLASSIFICATION_RARE,
)

#: ``p >= 0.10`` → common (see the module docstring).
CLASSIFICATION_COMMON_MIN = 0.10
#: ``0.03 <= p < 0.10`` → uncommon; below → rare.
CLASSIFICATION_UNCOMMON_MIN = 0.03

#: The top-N alternatives returned in ``maia.top`` (the panel shows top-3).
MAIA_TOP_N = 3

PIECE_VALUES = {
    chess.PAWN: 1,
    chess.KNIGHT: 3,
    chess.BISHOP: 3,
    chess.ROOK: 5,
    chess.QUEEN: 9,
    chess.KING: 0,
}

PIECE_NAMES = {
    chess.PAWN: "pawn",
    chess.KNIGHT: "knight",
    chess.BISHOP: "bishop",
    chess.ROOK: "rook",
    chess.QUEEN: "queen",
    chess.KING: "king",
}

OPENINGS_PATH = Path(__file__).resolve().parent / "data" / "openings_eco.json"

_openings: Optional[Dict[str, List[str]]] = None
_openings_lock = threading.Lock()
_openings_loaded = False


def _clamp_elo(value: Any, fallback: int) -> int:
    """Same clamping contract as /premove: out-of-range knobs clamp, never 4xx."""
    try:
        elo = int(value)
    except (TypeError, ValueError):
        return fallback
    return max(ELO_MIN, min(ELO_MAX, elo))


def _round6(value: float) -> float:
    return round(float(value), 6)


def _normalize_san(token: str) -> str:
    """The dataset keys and the runtime sequence are both marker-free."""
    return token.rstrip("+#")


def load_openings() -> Optional[Dict[str, List[str]]]:
    """Load the bundled ECO table once; a missing file degrades to ``null``."""
    global _openings, _openings_loaded  # noqa: PLW0603 - process-wide cache
    if _openings_loaded:
        return _openings
    with _openings_lock:
        if _openings_loaded:
            return _openings
        try:
            payload = json.loads(OPENINGS_PATH.read_text(encoding="utf-8"))
            table = payload.get("openings")
            _openings = table if isinstance(table, dict) else {}
        except (OSError, ValueError):  # pragma: no cover - guidance, not logic
            _openings = {}
        _openings_loaded = True
        return _openings


def classify(rank: int, probability: float) -> str:
    """The documented probability bands (pure, unit-friendly)."""
    if rank == 1:
        return CLASSIFICATION_MAINLINE
    if probability >= CLASSIFICATION_COMMON_MIN:
        return CLASSIFICATION_COMMON
    if probability >= CLASSIFICATION_UNCOMMON_MIN:
        return CLASSIFICATION_UNCOMMON
    return CLASSIFICATION_RARE


def opening_for_san(moves_san: Sequence[str]) -> Optional[Dict[str, str]]:
    """Longest-prefix match of a SAN game sequence against the ECO table."""
    table = load_openings()
    if not table or not moves_san:
        return None
    tokens = [_normalize_san(str(san)) for san in moves_san]
    for length in range(len(tokens), 0, -1):
        entry = table.get(" ".join(tokens[:length]))
        if entry:
            return {"eco": str(entry[0]), "name": str(entry[1])}
    return None


def _replay_san_from_start(moves: Sequence[str]) -> Optional[List[str]]:
    """SAN list of ``moves`` applied to the standard start position (None if illegal)."""
    board = chess.Board()
    sans: List[str] = []
    for raw in moves:
        try:
            move = chess.Move.from_uci(str(raw))
        except ValueError:
            return None
        if move not in board.legal_moves:
            return None
        sans.append(board.san(move))
        board.push(move)
    return sans


def _is_standard_start(fen: str) -> bool:
    """True when ``fen`` is the standard start position (move counters ignored).

    ECO names describe move sequences from the game start, so they are only
    reported when the base FEN really is that start — otherwise the pre-base
    moves are unknowable and the honest answer is ``null``.
    """
    try:
        board = chess.Board(fen)
    except ValueError:
        return False
    start = chess.Board()
    return (
        board.board_fen() == start.board_fen()
        and board.turn == start.turn
        and board.castling_rights == start.castling_rights
        and board.ep_square == start.ep_square
    )


def _terminal_after_wdl(board_after: chess.Board) -> Dict[str, float]:
    """Rules-decided WDL for a finished after-position, **side-to-move** view."""
    if board_after.is_checkmate():
        return {"win": 0.0, "draw": 0.0, "loss": 1.0}
    return {"win": 0.0, "draw": 1.0, "loss": 0.0}


def _flip_wdl(wdl: Dict[str, float]) -> Dict[str, float]:
    return {"win": _round6(wdl["loss"]), "draw": _round6(wdl["draw"]), "loss": _round6(wdl["win"])}


def explain_move(
    engine: MaiaEngine,
    fen: str,
    moves: Sequence[str],
    elo_self: Any = DEFAULT_ELO_SELF,
    elo_oppo: Any = DEFAULT_ELO_OPPO,
) -> Dict[str, Any]:
    """Explain the LAST move of ``moves`` (see the module docstring).

    Raises :class:`EngineInputError` for invalid FEN, an illegal history move,
    an unparseable last move or an empty ``moves`` list.
    """
    started = time.perf_counter()
    if not moves:
        raise EngineInputError(
            "moves must contain at least one ply — the LAST ply is the move to explain"
        )
    elo_self = _clamp_elo(elo_self, DEFAULT_ELO_SELF)
    elo_oppo = _clamp_elo(elo_oppo, DEFAULT_ELO_OPPO)
    history: List[str] = [str(move) for move in moves]

    # -- the move and the two boards (python-chess validates everything) -----
    before = engine.resolve_position(fen, history[:-1])
    try:
        move = chess.Move.from_uci(history[-1])
    except ValueError as exc:
        raise EngineInputError(f"invalid UCI move: {history[-1]!r}") from exc
    if move not in before.legal_moves:
        raise EngineInputError(
            f"illegal move in history: {history[-1]!r} for position {before.fen()!r}"
        )
    san = before.san(move)
    after = before.copy()
    after.push(move)

    mover_is_white = before.turn == chess.WHITE
    by = "white" if mover_is_white else "black"

    # -- flags ---------------------------------------------------------------
    capture = before.is_capture(move)
    en_passant = before.is_en_passant(move)
    castle = (
        "kingside"
        if before.is_kingside_castling(move)
        else "queenside"
        if before.is_queenside_castling(move)
        else None
    )
    promotion_type = move.promotion
    promotion = PIECE_NAMES[promotion_type] if promotion_type is not None else None
    mate = after.is_checkmate()
    check = after.is_check()

    # recapture: the previous ply captured on the square this move captures on.
    recapture = False
    captured_square: Optional[int] = None
    if capture:
        captured_square = (
            move.to_square + (-8 if mover_is_white else 8) if en_passant else move.to_square
        )
        if len(history) >= 2:
            try:
                previous = chess.Move.from_uci(history[-2])
            except ValueError:
                previous = None
            if previous is not None:
                previous_board = engine.resolve_position(fen, history[:-2])
                recapture = (
                    previous_board.is_capture(previous) and previous.to_square == move.to_square
                )

    # -- material ------------------------------------------------------------
    captured_out: Optional[Dict[str, Any]] = None
    delta = 0
    if capture and captured_square is not None:
        captured_piece = before.piece_at(captured_square)
        if captured_piece is not None:  # pragma: no branch - legal captures always have one
            value = PIECE_VALUES[captured_piece.piece_type]
            delta = value
            captured_out = {
                "piece": PIECE_NAMES[captured_piece.piece_type],
                "square": chess.square_name(captured_square),
                "value": value,
            }

    # -- Maia distribution BEFORE the move (mover to move) -------------------
    distribution = engine.move_probabilities(
        fen,
        moves=history[:-1] or None,
        elo_self=elo_self,
        elo_oppo=elo_oppo,
    )
    ordered = sorted(distribution["moves"], key=lambda entry: (-entry["prob"], entry["uci"]))
    played = next((entry for entry in ordered if entry["uci"] == move.uci()), None)
    played_prob = float(played["prob"]) if played is not None else 0.0
    rank = ordered.index(played) + 1 if played is not None else len(ordered) + 1
    top = [
        {"uci": entry["uci"], "san": entry["san"], "prob": _round6(entry["prob"])}
        for entry in ordered[:MAIA_TOP_N]
    ]

    wdl_before = {
        key: _round6(value) for key, value in distribution["wdl"].items()
    }

    # -- WDL AFTER the move, flipped to the mover's perspective --------------
    after_wdl = engine.predict(
        fen,
        moves=history,
        elo_self=elo_self,
        elo_oppo=elo_oppo,
        top_k=1,
    )["wdl"]
    if after.is_game_over():
        # `predict` answers the rules-decided WDL from the side to move (the
        # opponent) — same convention as /analyze; flip for the mover.
        after_wdl = _terminal_after_wdl(after)
    wdl_after = _flip_wdl(after_wdl)

    # -- opening (only from a standard start position) -----------------------
    opening = None
    if _is_standard_start(fen):
        sans = _replay_san_from_start(history)
        if sans is not None:
            opening = opening_for_san(sans)

    elapsed_ms = _round6((time.perf_counter() - started) * 1000.0)
    return {
        "move": {
            "san": san,
            "uci": move.uci(),
            "by": by,
            "ply": len(history),
            "moveNumber": before.fullmove_number,
        },
        "flags": {
            "capture": capture,
            "check": check,
            "mate": mate,
            "castle": castle,
            "promotion": promotion,
            "enPassant": en_passant,
            "recapture": recapture,
        },
        "material": {"delta": delta, "captured": captured_out},
        "maia": {
            "playedProb": _round6(played_prob),
            "rank": rank,
            "totalLegal": before.legal_moves.count(),
            "top": top,
            "moverElo": int(elo_self),
        },
        "wdl": {"before": wdl_before, "after": wdl_after},
        "opening": opening,
        "classification": classify(rank, played_prob),
        "model": engine.model_alias,
        "elapsed_ms": elapsed_ms,
    }

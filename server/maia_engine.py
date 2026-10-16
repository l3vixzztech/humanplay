"""Maia-3 inference wrapper for the humanplay local helper server.

Loads one Maia-3 checkpoint (Maia3-5M by default) and exposes a small,
site-agnostic API on top of it:

    predict(fen, moves=None, elo_self=2400, elo_oppo=2400, top_k=3)

Semantics mirror ``maia3-uci`` (the reference implementation shipped with the
Maia-3 repo, https://github.com/CSSLab/maia3), which is the source of truth:

* ``fen`` is the BASE position. When ``moves`` is given, the UCI moves are
  applied to that base position in order — exactly like
  ``position fen <fen> moves <m1> ...`` in the UCI protocol. The resulting
  position is the one that is analysed.
* ``moves`` (optional) are reconstructed into the model's history planes,
  mirroring ``maia3-uci --use-uci-history``: the history deque holds
  ``[base position, after m1, after m2, ...]`` (newest last, capped at the
  model's ``history`` length, default 8). When ``moves`` is ``None`` the
  no-history default is used: the deque holds only the current position and
  Maia-3's ``get_historical_tokens`` left-pads all missing history slots with
  the earliest available position (i.e. the current position is repeated).
* Probabilities are a softmax at temperature 1 over LEGAL moves only (illegal
  vocabulary indices are masked to -inf), matching the MultiPV probabilities
  printed by ``maia3-uci``. The top-1 move is the argmax, i.e. the
  deterministic temperature-0 path.
* ``wdl`` comes from the 3-class value head. Per ``maia3/uci.py``
  (``wdl_from_value_logits``) the value labels are ``[loss, draw, win]``
  **from the perspective of the side to move** of the position that was fed to
  the model. We report ``{"win", "draw", "loss"}`` for the side to move of the
  analysed position.

AGPL note: this module imports the AGPL-3.0 ``maia3`` package installed into
the server venv from GitHub (or PyPI-equivalent source); no maia3 code is
copied or vendored. The Chrome extension never imports this module or anything
from ``maia3`` — it only talks HTTP to this server.
"""

from __future__ import annotations

import os
import threading
from collections import deque
from typing import Any, Deque, Dict, Iterable, List, Optional, Sequence, Tuple

import chess
import torch

from maia3.dataset import get_historical_tokens, get_legal_moves_mask, tokenize_board
from maia3.model_registry import resolve_checkpoint_path
from maia3.uci import load_model, parse_args
from maia3.utils import get_all_possible_moves, mirror_move

# Locked defaults ("strong human" preset).
DEFAULT_MODEL_ALIAS = "maia3-5m"
DEFAULT_ELO_SELF = 2400
DEFAULT_ELO_OPPO = 2400
DEFAULT_TOP_K = 3

# Maia-3's trained Elo range and MultiPV cap (see maia3/uci.py).
ELO_MIN = 0
ELO_MAX = 5000
MAX_TOP_K = 20


class EngineInputError(ValueError):
    """Bad request input: invalid FEN, illegal history move, out-of-range Elo."""


def _check_elo(name: str, value: Any) -> int:
    try:
        elo = int(value)
    except (TypeError, ValueError) as exc:
        raise EngineInputError(f"{name} must be an integer in [{ELO_MIN}, {ELO_MAX}]") from exc
    if not (ELO_MIN <= elo <= ELO_MAX):
        raise EngineInputError(f"{name}={elo} is out of range [{ELO_MIN}, {ELO_MAX}]")
    return elo


def _clamp_top_k(value: Any) -> int:
    try:
        top_k = int(value)
    except (TypeError, ValueError) as exc:
        raise EngineInputError("top_k must be an integer >= 1") from exc
    return max(1, min(MAX_TOP_K, top_k))


def wdl_from_value_logits(logits: torch.Tensor) -> Dict[str, float]:
    """3-class value head -> {"win", "draw", "loss"} for the SIDE TO MOVE.

    Mirrors ``maia3.uci.wdl_from_value_logits``: the value labels are
    ``[loss, draw, win]`` from the side-to-move perspective.
    """
    p_loss, p_draw, p_win = torch.softmax(logits.float(), dim=-1).tolist()
    return {
        "win": round(float(p_win), 6),
        "draw": round(float(p_draw), 6),
        "loss": round(float(p_loss), 6),
    }


class MaiaEngine:
    """Loads Maia-3 once and answers ``predict`` queries (thread-safe)."""

    def __init__(
        self,
        model_alias: Optional[str] = None,
        device: Optional[str] = None,
        cache_dir: Optional[str] = None,
    ) -> None:
        self.model_alias = model_alias or os.environ.get("HUMANPLAY_MODEL", DEFAULT_MODEL_ALIAS)
        self.device = device or os.environ.get("HUMANPLAY_DEVICE", "cpu")
        self.cache_dir = cache_dir if cache_dir is not None else os.environ.get("HUMANPLAY_HF_CACHE_DIR")

        self._lock = threading.Lock()
        self._cfg: Optional[Any] = None
        self._model = None
        self._all_moves: List[str] = []
        self._all_moves_dict: Dict[str, int] = {}
        self._idx_to_move: Dict[int, str] = {}

    # -- loading -----------------------------------------------------------

    @property
    def is_loaded(self) -> bool:
        return self._model is not None

    def ensure_loaded(self) -> None:
        if self._model is not None:
            return
        with self._lock:
            if self._model is not None:
                return
            self._load()

    def _load(self) -> None:
        # Reuse maia3-uci's own argument parsing + loader so architecture flags
        # and checkpoint resolution stay in lockstep with the reference CLI.
        argv = ["--model", self.model_alias, "--device", self.device]
        if self.cache_dir:
            argv += ["--cache-dir", self.cache_dir]
        cfg = parse_args(argv)
        cfg.checkpoint_path = resolve_checkpoint_path(cfg.model_spec, cache_dir=self.cache_dir)
        model = load_model(cfg)

        self._cfg = cfg
        self._model = model
        self._all_moves = get_all_possible_moves()
        self._all_moves_dict = {move: i for i, move in enumerate(self._all_moves)}
        self._idx_to_move = {i: move for move, i in self._all_moves_dict.items()}

    # -- inference ---------------------------------------------------------

    def _build_position(
        self, fen: str, moves: Optional[Iterable[str]]
    ) -> Tuple[chess.Board, Deque[torch.Tensor]]:
        if not isinstance(fen, str) or not fen.strip():
            raise EngineInputError("fen is required and must be a non-empty string")
        try:
            board = chess.Board(fen)
        except ValueError as exc:
            raise EngineInputError(f"invalid FEN: {fen!r}") from exc

        history: Deque[torch.Tensor] = deque(maxlen=self._cfg.history)
        history.append(tokenize_board(board))
        if moves:
            for raw in moves:
                try:
                    move = chess.Move.from_uci(str(raw))
                except ValueError as exc:
                    raise EngineInputError(f"invalid UCI move in history: {raw!r}") from exc
                if move not in board.legal_moves:
                    raise EngineInputError(
                        f"illegal move in history: {raw!r} for position {board.fen()!r}"
                    )
                board.push(move)
                history.append(tokenize_board(board))
        return board, history

    def _index_to_move(self, board: chess.Board, idx: int) -> Optional[chess.Move]:
        move_uci = self._idx_to_move.get(int(idx))
        if move_uci is None:
            return None
        # Predictions are in the side-to-move's perspective (board mirrored when black).
        if board.turn == chess.BLACK:
            move_uci = mirror_move(move_uci)
        try:
            move = chess.Move.from_uci(move_uci)
        except ValueError:
            return None
        if move not in board.legal_moves:
            return None
        return move

    def _terminal_wdl(self, board: chess.Board) -> Dict[str, float]:
        if board.is_checkmate():
            # The side to move is mated.
            return {"win": 0.0, "draw": 0.0, "loss": 1.0}
        # Stalemate / insufficient material / 75-move / fivefold.
        return {"win": 0.0, "draw": 1.0, "loss": 0.0}

    def _evaluate(
        self,
        board: chess.Board,
        history: Deque[torch.Tensor],
        elo_self: int,
        elo_oppo: int,
        top_k: int,
    ) -> Tuple[List[Dict[str, Any]], Dict[str, float]]:
        if board.is_game_over():
            return [], self._terminal_wdl(board)

        legal_mask = get_legal_moves_mask(board, self._all_moves_dict)
        legal_count = int(legal_mask.sum().item())
        if legal_count == 0:  # pragma: no cover - python-chess guarantees otherwise
            return [], self._terminal_wdl(board)

        tokens = get_historical_tokens(
            history, self._cfg, base=0.0, inc=0.0, clk_left_before=0.0, clk_ponder=0.0
        )
        tokens = tokens.unsqueeze(0).to(self.device)
        self_elos = torch.tensor([elo_self], dtype=torch.long, device=self.device)
        oppo_elos = torch.tensor([elo_oppo], dtype=torch.long, device=self.device)

        with torch.inference_mode():
            logits_move, logits_value, _logits_ponder = self._model(tokens, self_elos, oppo_elos)

        logits = logits_move[0].float().masked_fill(~legal_mask.to(self.device), float("-inf"))
        probs = torch.softmax(logits, dim=-1)

        k = min(top_k, legal_count)
        top_probs, top_indices = torch.topk(probs, k=k)

        out: List[Dict[str, Any]] = []
        for prob, idx in zip(top_probs.tolist(), top_indices.tolist()):
            move = self._index_to_move(board, idx)
            if move is None:  # pragma: no cover - legal mask makes this unreachable
                continue
            out.append({"uci": move.uci(), "san": board.san(move), "prob": round(float(prob), 6)})

        return out, wdl_from_value_logits(logits_value[0])

    # -- M7 premove support (new methods; `predict` above is untouched) -----

    def resolve_position(self, fen: str, moves: Optional[Sequence[str]] = None) -> chess.Board:
        """The position ``predict`` would analyse (same validation, same errors).

        M7's planner needs the exact board (legal-move enumeration, terminal
        checks) *and* the same input errors as ``predict`` (invalid FEN /
        illegal history move -> :class:`EngineInputError` -> HTTP 400).
        """
        self.ensure_loaded()
        board, _history = self._build_position(fen, moves)
        return board

    def move_probabilities(
        self,
        fen: str,
        moves: Optional[Sequence[str]] = None,
        elo_self: int = DEFAULT_ELO_SELF,
        elo_oppo: int = DEFAULT_ELO_OPPO,
    ) -> Dict[str, Any]:
        """The FULL softmax distribution over ALL legal moves (no MultiPV cap).

        Identical semantics to ``predict`` (base FEN + UCI history planes,
        side-to-move perspective, legal-masked temperature-1 softmax, rounded to
        6 decimals) except that **every** legal move is returned instead of the
        top-``top_k``. Added for the M7 premove planner, where the opponent's
        full move distribution is the prior over their candidate moves.

        Returns ``{"fen", "moves", "wdl", "model"}``; ``moves`` is sorted by
        probability (descending, ties broken by UCI inside the planner).
        """
        self.ensure_loaded()
        elo_self = _check_elo("elo_self", elo_self)
        elo_oppo = _check_elo("elo_oppo", elo_oppo)
        board, history = self._build_position(fen, moves)
        legal_count = board.legal_moves.count()
        with self._lock:
            moves_out, wdl = self._evaluate(board, history, elo_self, elo_oppo, top_k=legal_count)

        return {
            "fen": board.fen(),
            "moves": moves_out,
            "wdl": wdl,
            "model": self.model_alias,
        }

    def predict(
        self,
        fen: str,
        moves: Optional[Sequence[str]] = None,
        elo_self: int = DEFAULT_ELO_SELF,
        elo_oppo: int = DEFAULT_ELO_OPPO,
        top_k: int = DEFAULT_TOP_K,
    ) -> Dict[str, Any]:
        """Top-k human moves for the position, plus the side-to-move WDL.

        ``fen`` is the base position; ``moves`` (optional UCI list) is applied
        on top of it and reconstructs the model history planes
        (``--use-uci-history`` semantics). Without ``moves`` the model's
        no-history default is used (current position repeated to fill the
        history planes).

        Returns ``{"fen", "moves": [{uci, san, prob}], "wdl": {win, draw,
        loss}, "model"}``. ``wdl`` is from the side-to-move perspective of the
        resolved position. For finished games ``moves`` is empty and ``wdl``
        is decided by the rules (checkmate/stalemate), not the value head.
        """
        self.ensure_loaded()
        top_k = _clamp_top_k(top_k)
        elo_self = _check_elo("elo_self", elo_self)
        elo_oppo = _check_elo("elo_oppo", elo_oppo)

        board, history = self._build_position(fen, moves)
        with self._lock:
            moves_out, wdl = self._evaluate(board, history, elo_self, elo_oppo, top_k)

        return {
            "fen": board.fen(),
            "moves": moves_out,
            "wdl": wdl,
            "model": self.model_alias,
        }


_ENGINE: Optional[MaiaEngine] = None
_ENGINE_LOCK = threading.Lock()


def get_engine() -> MaiaEngine:
    """Process-wide singleton engine (model loaded lazily, once)."""
    global _ENGINE
    if _ENGINE is None:
        with _ENGINE_LOCK:
            if _ENGINE is None:
                _ENGINE = MaiaEngine()
    return _ENGINE

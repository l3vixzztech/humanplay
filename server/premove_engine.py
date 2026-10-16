"""Maia-3 premove planner (Milestone 7) — the criteria engine.

WHY this exists
---------------
While the opponent thinks, the assistant can *premove* (chess.com plays our
queued move automatically as soon as it is legal). A premove only helps when
the opponent is likely to play into it, and it can hurt when it fires in a
position we did not foresee — so the planner's honest value is **not** finding
clever premoves, it is *refusing* mispredicted ones. This module decides:

    "is exactly ONE of our replies safe to queue against the opponent's
     *predicted* distribution, or should we stay silent?"

Same Maia-3 model everywhere (no Stockfish, no second model): the opponent's
candidate moves come from Maia(elo_oppo) at the current position, and our
replies come from Maia(elo_self) after each candidate. Because the model is
conditioned on the Elo of the **side to move** (see ``maia3/uci.py``: candidate
boards "are after our move, so the side to move is the current opponent" and
the Elos are swapped), the two queries swap the Elo pair:

    opponent candidates:  move_probabilities(self_elo=elo_oppo, oppo_elo=elo_self)
    our replies:          predict(self_elo=elo_self, oppo_elo=elo_oppo)

Definitions (exact, deterministic)
----------------------------------
* ``C`` — the considered opponent candidates. ``mode="top"``: Maia(elo_oppo)'s
  top ``top_n`` moves, probabilities **renormalised over them** (the honest
  reading: "safe over the mass we actually looked at"). ``mode="all"``: every
  legal opponent move with its raw legal-masked softmax probability (sums to 1).
* For each ``c ∈ C``: ``r_c`` = argmax of Maia(elo_self)'s reply distribution
  after ``c`` and ``q_c`` its probability (``top_k=1`` on the real engine, i.e.
  the same temperature-0 argmax as ``/analyze``).
* Candidates whose after-position is terminal (they mate us, stalemate, …) have
  no reply: they are **excluded** (never counted in any mass) and reported with
  a reason — a premove cannot matter in a finished game.
* ``safe_mass(R)  = Σ p_c            over c with r_c == R``
* ``guard_mass(R) = Σ p_c            over c where R is ILLEGAL after c``
  ("safe by inaction": the premove never fires there, so it cannot backfire).
* ``safety(R) = safe_mass(R) + guard_mass(R)`` — the fraction of the *considered*
  opponent mass after which queuing ``R`` cannot mispredict (it is our best
  reply, or it cannot fire). The residual ``1 - safety`` is exactly where the
  premove WOULD fire although Maia's best reply differs — the danger zone.
* ``min_response_prob(R)`` = the smallest ``q_c`` among the c's with
  ``r_c == R``. Guard-only candidates are not counted: the planned reply is not
  used where it cannot fire.

Recommend ``R`` iff ALL of:

    1. ``safety(R) >= min_safety``               (default 0.90; clamped 0.5..1.0)
    2. ``safe_mass(R) > 0``                      (guard-only "never fires" is no plan)
    3. ``min_response_prob(R) >= min_response_prob`` floor (default 0.15, see below)

and pick the eligible ``R`` with the highest ``(safety, safe_mass,
min_response_prob, uci)`` (documented, deterministic tie-break). The criterion
label is ``forced`` (exactly one legal opponent move — no prediction needed),
``safe_vs_all`` (``safety == 1.0``: every considered reply is either met by R or
cannot fire it) or ``robust`` (a real prediction with ``safety < 1``).

The floor (default 0.15, ``PREMOVE_DEFAULT_MIN_RESPONSE_PROB``) is protection
against a "safety" that only holds because Maia predicts our planned move with
a negligible probability — everywhere it fires, it is technically the argmax
but barely preferred. It is a module constant (not a request field) so a client
cannot lower it; tests may pass it explicitly. A *forced* premove is exempt:
with exactly one legal opponent move there is no misprediction risk at all and
the spec is "recommended = our argmax response".

Terminal root positions answer ``recommended: null`` with a ``reason`` instead
of a plan. Everything is computed in-process with python-chess + the same
``MaiaEngine`` used by ``/analyze``; nothing here touches ``predict``. All
numeric knobs (``top_n``, ``min_safety``, ``elo_*``) are **clamped** rather
than rejected — a stray value from a client must never break the opponent's
turn (invalid FEN/history still raises :class:`EngineInputError` -> HTTP 400).
"""

from __future__ import annotations

import time
from typing import Any, Dict, List, Optional, Sequence, Tuple

import chess

from maia_engine import (
    DEFAULT_ELO_OPPO,
    DEFAULT_ELO_SELF,
    ELO_MAX,
    ELO_MIN,
    EngineInputError,
    MaiaEngine,
)

# -- request knobs (clamped, documented) ------------------------------------

PREMOVE_DEFAULT_TOP_N = 5
PREMOVE_MAX_TOP_N = 12
PREMOVE_MIN_TOP_N = 1

PREMOVE_DEFAULT_MIN_SAFETY = 0.90
PREMOVE_MIN_SAFETY = 0.5
PREMOVE_MAX_SAFETY = 1.0

#: The "min response prob" floor — see the module docstring. Deliberately a
#: module constant: the endpoint does not expose it, tests override it by
#: calling ``plan_premove`` directly.
PREMOVE_DEFAULT_MIN_RESPONSE_PROB = 0.15

PREMOVE_MODES = ("top", "all")
PREMOVE_DEFAULT_MODE = "top"

#: Comparisons on rounded probabilities; one ulp of the 6-decimal round-off.
_EPS = 1e-9


def clamp_top_n(value: Any) -> int:
    try:
        top_n = int(value)
    except (TypeError, ValueError):
        return PREMOVE_DEFAULT_TOP_N
    return max(PREMOVE_MIN_TOP_N, min(PREMOVE_MAX_TOP_N, top_n))


def clamp_min_safety(value: Any) -> float:
    try:
        safety = float(value)
    except (TypeError, ValueError):
        return PREMOVE_DEFAULT_MIN_SAFETY
    if safety != safety:  # NaN
        return PREMOVE_DEFAULT_MIN_SAFETY
    return max(PREMOVE_MIN_SAFETY, min(PREMOVE_MAX_SAFETY, safety))


def clamp_elo(value: Any, fallback: int) -> int:
    """All numeric /premove knobs clamp instead of rejecting (documented).

    A stray Elo from a client must never break the opponent's turn; the same
    range the model was trained on (0..5000) is enforced.
    """
    try:
        elo = int(value)
    except (TypeError, ValueError):
        return fallback
    return max(ELO_MIN, min(ELO_MAX, elo))


def _terminal_reason(board: chess.Board) -> str:
    if board.is_checkmate():
        return "checkmate"
    if board.is_stalemate():
        return "stalemate"
    if board.is_insufficient_material():
        return "insufficient material"
    if board.is_seventyfive_moves():
        return "75-move rule"
    if board.is_fivefold_repetition():
        return "fivefold repetition"
    return "game over"


def _round6(value: float) -> float:
    return round(float(value), 6)


def _pct(value: float) -> str:
    return f"{value * 100:.0f}%"


def _criterion_and_why(
    *,
    safety: float,
    safe_mass: float,
    guard_mass: float,
    min_response_prob: float,
    min_safety: float,
    floor: float,
) -> Tuple[str, str]:
    """verdict + human explanation for one candidate reply (pure)."""
    if safety + _EPS < min_safety:
        return (
            "not_safe",
            f"safety {_pct(safety)} < required {_pct(min_safety)} "
            f"(safe {_pct(safe_mass)} + guard {_pct(guard_mass)}) — "
            "a mispredicted reply would leave the premove firing while it is not our best move",
        )
    if safe_mass <= 0:
        return (
            "no_safe_mass",
            "the premove could only ever be illegal after their moves (never fires) — no plan",
        )
    if min_response_prob + _EPS < floor:
        return (
            "below_floor",
            f"coverage {_pct(safety)} ok, but Maia's confidence in this reply drops to "
            f"{_pct(min_response_prob)} after some of their moves (< floor {_pct(floor)})",
        )
    return (
        "recommended",
        f"safety {_pct(safety)} >= {_pct(min_safety)}; safe mass {_pct(safe_mass)}, "
        f"guard mass {_pct(guard_mass)}; min response prob {_pct(min_response_prob)} >= {_pct(floor)}",
    )


def _recommended_detail(
    *,
    san: str,
    safety: float,
    safe_mass: float,
    guard_mass: float,
    min_response_prob: float,
    safe_count: int,
    considered: int,
) -> str:
    return (
        f"{safe_count}/{considered} considered replies are met by {san} "
        f"(safe mass {_pct(safe_mass)}); {_pct(guard_mass)} of their mass cannot fire the "
        f"premove (illegal after their move -> safe by inaction); overall safety "
        f"{_pct(safety)}; min best-response probability {_pct(min_response_prob)}"
    )


def plan_premove(
    engine: MaiaEngine,
    fen: str,
    moves: Optional[Sequence[str]] = None,
    elo_self: int = DEFAULT_ELO_SELF,
    elo_oppo: int = DEFAULT_ELO_OPPO,
    top_n: int = PREMOVE_DEFAULT_TOP_N,
    min_safety: float = PREMOVE_DEFAULT_MIN_SAFETY,
    mode: str = PREMOVE_DEFAULT_MODE,
    min_response_prob: float = PREMOVE_DEFAULT_MIN_RESPONSE_PROB,
) -> Dict[str, Any]:
    """Run the criteria engine for one position (see the module docstring).

    ``fen`` is the base position and ``moves`` (UCI) is applied on top of it
    exactly like ``/analyze`` — the resolved position is the one on the board
    (opponent to move). Raises :class:`EngineInputError` for invalid input.
    """
    started = time.perf_counter()
    top_n = clamp_top_n(top_n)
    min_safety = clamp_min_safety(min_safety)
    elo_self = clamp_elo(elo_self, DEFAULT_ELO_SELF)
    elo_oppo = clamp_elo(elo_oppo, DEFAULT_ELO_OPPO)
    if mode not in PREMOVE_MODES:
        raise EngineInputError(f"mode must be one of {PREMOVE_MODES}, got {mode!r}")

    board = engine.resolve_position(fen, moves)  # validates FEN + history
    move_history: List[str] = [str(m) for m in (moves or [])]

    base: Dict[str, Any] = {
        "fen": board.fen(),
        "side_to_move": "white" if board.turn == chess.WHITE else "black",
        "opponent": [],
        "recommended": None,
        "candidates": [],
        "excluded": [],
        "reason": None,
        "params": {
            "elo_self": int(elo_self),
            "elo_oppo": int(elo_oppo),
            "top_n": top_n,
            "min_safety": min_safety,
            "min_response_prob": float(min_response_prob),
            "mode": mode,
        },
        "timings_ms": {},
        "model": engine.model_alias,
    }

    # -- terminal root: nothing to plan ------------------------------------
    if board.is_game_over():
        base["reason"] = f"game over ({_terminal_reason(board)}) — no premove to plan"
        base["elapsed_ms"] = _round6((time.perf_counter() - started) * 1000.0)
        base["timings_ms"] = {"root": 0.0, "responses": 0.0, "total": base["elapsed_ms"]}
        return base

    # -- opponent candidates (Maia(elo_oppo), Elos swapped: they are to move) --
    root_started = time.perf_counter()
    distribution = engine.move_probabilities(
        fen,
        moves=move_history or None,
        elo_self=elo_oppo,
        elo_oppo=elo_self,
    )
    ordered = sorted(distribution["moves"], key=lambda move: (-move["prob"], move["uci"]))

    if len(ordered) == 1:
        # Exactly one legal move: prediction is unnecessary (criterion "forced").
        candidates = [{"uci": ordered[0]["uci"], "san": ordered[0]["san"], "prob": 1.0}]
        forced = True
    elif mode == "all":
        candidates = [dict(move) for move in ordered]
        forced = False
    else:  # "top": keep top_n, renormalise over them (documented)
        kept = ordered[:top_n]
        total = sum(move["prob"] for move in kept) or 1.0
        candidates = [
            {"uci": move["uci"], "san": move["san"], "prob": move["prob"] / total} for move in kept
        ]
        forced = False

    base["opponent"] = [dict(move) for move in candidates]
    root_ms = (time.perf_counter() - root_started) * 1000.0

    # -- one reply prediction per candidate (reuses predict, Elos back home) --
    responses_started = time.perf_counter()
    groups: Dict[str, Dict[str, Any]] = {}
    rows: List[Tuple[Dict[str, Any], chess.Board, Dict[str, Any]]] = []
    for candidate in candidates:
        move = chess.Move.from_uci(candidate["uci"])
        after = board.copy()
        after.push(move)
        if after.is_game_over():
            base["excluded"].append(
                {
                    "uci": candidate["uci"],
                    "san": candidate["san"],
                    "prob": _round6(candidate["prob"]),
                    "reason": _terminal_reason(after),
                }
            )
            continue
        reply = engine.predict(
            fen,
            moves=[*move_history, candidate["uci"]],
            elo_self=elo_self,
            elo_oppo=elo_oppo,
            top_k=1,
        )["moves"][0]
        group = groups.setdefault(
            reply["uci"],
            {
                "uci": reply["uci"],
                "san": reply["san"],
                "safe_mass": 0.0,
                "guard_mass": 0.0,
                "_members": 0,
                "_safe_probs": [],
            },
        )
        group["safe_mass"] += candidate["prob"]
        group["_members"] += 1
        group["_safe_probs"].append(reply["prob"])
        rows.append((candidate, after, reply))
    responses_ms = (time.perf_counter() - responses_started) * 1000.0

    # -- guard pass: where is a candidate reply illegal after their move? ----
    for candidate, after, _reply in rows:
        for group in groups.values():
            premove = chess.Move.from_uci(group["uci"])
            if premove not in after.legal_moves:
                group["guard_mass"] += candidate["prob"]

    # -- forced / eligibility / recommendation ------------------------------
    out_candidates: List[Dict[str, Any]] = []
    eligible: List[Dict[str, Any]] = []
    for group in groups.values():
        safety = group["safe_mass"] + group["guard_mass"]
        min_prob = min(group["_safe_probs"])
        verdict, why = _criterion_and_why(
            safety=safety,
            safe_mass=group["safe_mass"],
            guard_mass=group["guard_mass"],
            min_response_prob=min_prob,
            min_safety=min_safety,
            floor=min_response_prob,
        )
        entry = {
            "uci": group["uci"],
            "san": group["san"],
            "safe_mass": _round6(group["safe_mass"]),
            "guard_mass": _round6(group["guard_mass"]),
            "min_response_prob": _round6(min_prob),
            "verdict": verdict,
            "why": why,
        }
        if verdict == "recommended":
            eligible.append({"group": group, "entry": entry, "safety": safety, "min_prob": min_prob})
        out_candidates.append(entry)

    forced_group: Optional[Dict[str, Any]] = groups[rows[0][2]["uci"]] if (forced and rows) else None
    if forced_group is not None:
        # Documented exemption: with exactly one legal opponent move there is no
        # misprediction to guard against — the spec is "recommended = our
        # argmax response", so the floor does not apply here.
        for entry in out_candidates:
            if entry["uci"] == forced_group["uci"]:
                entry["verdict"] = "recommended"
                entry["why"] = (
                    f"forced: their only legal move is {base['opponent'][0]['san']}; "
                    f"Maia's best answer is {forced_group['san']} "
                    f"({_pct(min(forced_group['_safe_probs']))})"
                )
        best = {
            "group": forced_group,
            "entry": next(entry for entry in out_candidates if entry["uci"] == forced_group["uci"]),
            "safety": forced_group["safe_mass"] + forced_group["guard_mass"],
            "min_prob": min(forced_group["_safe_probs"]),
        }
    elif eligible:
        best = max(
            eligible,
            key=lambda item: (item["safety"], item["group"]["safe_mass"], item["min_prob"], item["group"]["uci"]),
        )
    else:
        best = None

    if best is not None:
        safety = best["safety"]
        criterion = "forced" if forced else ("safe_vs_all" if safety >= 1.0 - _EPS else "robust")
        best["entry"]["verdict"] = "recommended"
        if criterion == "forced":
            detail = (
                f"forced premove: their only legal move is {base['opponent'][0]['san']}; "
                f"Maia's best answer is {best['group']['san']} "
                f"({_pct(best['min_prob'])} of the reply distribution)"
            )
        else:
            detail = _recommended_detail(
                san=best["group"]["san"],
                safety=safety,
                safe_mass=best["group"]["safe_mass"],
                guard_mass=best["group"]["guard_mass"],
                min_response_prob=best["min_prob"],
                safe_count=best["group"]["_members"],
                considered=len(base["opponent"]) - len(base["excluded"]),
            )
        base["recommended"] = {
            "uci": best["group"]["uci"],
            "san": best["group"]["san"],
            "criterion": criterion,
            "safety": _round6(safety),
            "min_response_prob": _round6(best["min_prob"]),
            "detail": detail,
        }
    elif base["excluded"] and not out_candidates:
        base["reason"] = (
            "every considered reply ends the game "
            f"({len(base['excluded'])} terminal move(s)) — a premove cannot be used"
        )
    else:
        # Explain the best failed candidate so the panel can say *why*.
        ranked = sorted(
            (
                (
                    group["safe_mass"] + group["guard_mass"],
                    group["safe_mass"],
                    group["san"],
                    min(group["_safe_probs"]),
                )
                for group in groups.values()
            ),
            reverse=True,
        )
        if ranked:
            safety, safe_mass, san, min_prob = ranked[0]
            if safety + _EPS >= min_safety and min_prob + _EPS < min_response_prob:
                base["reason"] = (
                    f"no safe premove: {san} covers {_pct(safety)} of their considered moves, "
                    f"but Maia's confidence in it drops to {_pct(min_prob)} (< floor {_pct(min_response_prob)})"
                )
            else:
                base["reason"] = (
                    f"no safe premove: the best reply {san} covers only {_pct(safety)} of their "
                    f"considered moves (safe {_pct(safe_mass)}, required {_pct(min_safety)})"
                )
        else:
            base["reason"] = "no reply candidate survived the criteria"

    # -- deterministic candidate order: best first --------------------------
    out_candidates.sort(
        key=lambda entry: (
            -(entry["safe_mass"] + entry["guard_mass"]),
            -entry["safe_mass"],
            entry["uci"],
        )
    )
    base["candidates"] = out_candidates

    total_ms = (time.perf_counter() - started) * 1000.0
    base["elapsed_ms"] = _round6(total_ms)
    base["timings_ms"] = {
        "root": _round6(root_ms),
        "responses": _round6(responses_ms),
        "total": _round6(total_ms),
    }
    return base

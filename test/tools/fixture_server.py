#!/usr/bin/env python3
"""Static server for test/fixtures + a stub /health + canned /analyze + /premove, on port 8765.

Why 8765? The extension manifest only has a host permission for
`http://127.0.0.1:8765/*`. chrome.tabs.captureVisibleTab requires either that
host permission or an activeTab grant, and an activeTab grant needs a real click
on the toolbar icon — which a headless test cannot produce. Serving the fixture
pages from 8765 therefore lets the automated test drive a capture through the
UNMODIFIED extension (test/tools/capture-proof.mjs). The stub /health lets the
side panel's status chip show "online" without the Maia server.

Routes
------

    GET  /health                     -> {"status": "ok", "model": "<--model>",
                                         "version": "fixture-1.0.0", "uptime_s": …}
                                         (M9: mirrors the real server's additive fields)
    POST /snapshot                   -> writes test/fixtures/chesscom-snapshots/<name>
                                        (the panel's "Record chess.com snapshot")

    POST /analyze                    -> CANNED Maia responses, byte-identical in
                                        schema to the real server:
                                        {moves:[{uci,san,prob}], wdl:{win,draw,loss},
                                         model, elapsed_ms}
                                        The canned bodies were RECORDED FROM THE
                                        REAL SERVER (real mode proof cross-checks
                                        the same values, see CANNED below).

    POST /premove                    -> CANNED Maia premove-planner responses (M7),
                                        recorded from the real server the same way
                                        (key: fen|moves|elo_self|elo_oppo|top_n|
                                        min_safety|mode — see CANNED_PREMOVE).

    POST /explain                    -> CANNED live-commentary facts (M8), recorded
                                        from the real server (key: fen|moves|
                                        elo_self|elo_oppo — the same per-ply prefixes
                                        the panel sends; see CANNED_EXPLAIN).

    POST /llm/groq, /llm/gemini      -> CANNED rephrasing answers in the two provider
                                        response shapes (OpenAI chat / Gemini
                                        generateContent). TEST-ONLY provider stand-ins:
                                        commentary-proof.mjs points the extension's
                                        endpoint override here so the whole LLM layer
                                        runs offline (success, HTTP 500 and a
                                        >timeout delay via /debug/llm-mode).

Dev/test-only control routes (NOT part of the real server contract; only the
proof harnesses use them):

    GET  /debug/stats                -> {analyzeRequests, …, premoveRequests,
                                         premoveAttempts, premoveByKey,
                                         premoveCannedMisses, premoveDelaysApplied,
                                         explainRequests, explainAttempts,
                                         explainByKey, explainCannedMisses,
                                         explainDelaysApplied, llmRequests,
                                         llmMode, mode, delaysApplied,
                                         cannedMisses, …}
    POST /debug/delay  {"ms", "count"}
                                     -> delay the next <count> /analyze responses
                                        by <ms> (the stale-guard proof)
    POST /debug/premove-delay {"ms", "count"}
                                     -> delay the next <count> /premove responses
                                        (the M7 stale-race proof)
    POST /debug/explain-delay {"ms", "count"}
                                     -> delay the next <count> /explain responses
                                        (the M8 stale-race proof)
    POST /debug/llm-mode {"mode": "ok"|"error"|"timeout"}
                                     -> /llm/* answers 500 / sleeps 3 s (beyond the
                                        extension's 2.5 s LLM timeout) on demand
    POST /debug/mode   {"mode": "ok"|"offline"|"bad_request"|"engine_unavailable"}
                                     -> applies to /analyze, /premove AND /explain;
                                        "offline" drops the connection before any
                                        answer, "bad_request" answers HTTP 400,
                                        "engine_unavailable" answers HTTP 503
    POST /debug/reset                -> reset the counters/mode/delays
    POST /debug/canned / /debug/canned-premove / /debug/canned-explain
                                     -> register a canned response for an exact key
                                        at runtime (used when a key is only known
                                        once the test mutated the page, e.g. the
                                        52-ply commentary cap replay and the M9
                                        acceptance proof's replay + 104-ply soak)

The real Maia server uses the same port, so run only one of them at a time.

    python3 test/tools/fixture_server.py [--port 8765]
    # browse: http://127.0.0.1:8765/pages/index.html
    #         http://127.0.0.1:8765/chesscom/index.html
"""

from __future__ import annotations

import argparse
import functools
import json
import re
import socket
import threading
import time
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

FIXTURES_DIR = Path(__file__).resolve().parent.parent / "fixtures"
SNAPSHOT_DIR = FIXTURES_DIR / "chesscom-snapshots"
SNAPSHOT_NAME = re.compile(r"^[A-Za-z0-9._-]+\.json$")

DEFAULT_ELO = 2400
DEFAULT_TOP_K = 3
DEFAULT_TOP_N = 5
DEFAULT_MIN_SAFETY = 0.9
DEFAULT_PREMOVE_MODE = "top"

# ---------------------------------------------------------------------------
# CANNED /analyze responses — recorded from the REAL server
# (`cd server && .venv/bin/python -m uvicorn app:app --host 127.0.0.1 --port 8765`,
# probe script + full report: test/fixtures/captures/analyze/canned-report.json).
# Key: "<fen>|<uci moves joined by space>|<elo_self>|<elo_oppo>|<top_k>".
# Values are the server's responses verbatim (schema identical by construction).
# ---------------------------------------------------------------------------
CANNED: dict[str, dict] = {
    # startpos.html — no moves, default Elo
    "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1||2400|2400|3":
    {"elapsed_ms": 15.36, "model": "maia3-5m", "moves": [{"prob": 0.464864, "san": "e4", "uci": "e2e4"}, {"prob": 0.339048, "san": "d4", "uci": "d2d4"}, {"prob": 0.081763, "san": "Nf3", "uci": "g1f3"}], "wdl": {"draw": 0.067579, "loss": 0.456007, "win": 0.476414}},
    # middlegame-castling.html — 14 plies (the stale-proof P1 / real-mode case)
    "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1|e2e4 e7e5 g1f3 b8c6 f1c4 f8c5 e1g1 g8f6 d2d3 d7d6 c1g5 e8g8 g5f6 d8f6|2400|2400|3":
    {"elapsed_ms": 10.63, "model": "maia3-5m", "moves": [{"prob": 0.585868, "san": "Nc3", "uci": "b1c3"}, {"prob": 0.16039, "san": "h3", "uci": "h2h3"}, {"prob": 0.129875, "san": "c3", "uci": "c2c3"}], "wdl": {"draw": 0.073429, "loss": 0.540358, "win": 0.386213}},
    # middlegame (from #2) + 15.b1c3 15...h7h6 — stale-proof P2 (delayed)
    "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1|e2e4 e7e5 g1f3 b8c6 f1c4 f8c5 e1g1 g8f6 d2d3 d7d6 c1g5 e8g8 g5f6 d8f6 b1c3 h7h6|2400|2400|3":
    {"elapsed_ms": 10.43, "model": "maia3-5m", "moves": [{"prob": 0.794386, "san": "Nd5", "uci": "c3d5"}, {"prob": 0.151575, "san": "h3", "uci": "h2h3"}, {"prob": 0.016804, "san": "a3", "uci": "a2a3"}], "wdl": {"draw": 0.065454, "loss": 0.5278, "win": 0.406747}},
    # middlegame (from #3) + 16.h2h3 16...f8e8 — stale-proof P3 (fast, must win)
    "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1|e2e4 e7e5 g1f3 b8c6 f1c4 f8c5 e1g1 g8f6 d2d3 d7d6 c1g5 e8g8 g5f6 d8f6 b1c3 h7h6 h2h3 f8e8|2400|2400|3":
    {"elapsed_ms": 15.11, "model": "maia3-5m", "moves": [{"prob": 0.767718, "san": "Nd5", "uci": "c3d5"}, {"prob": 0.094755, "san": "a3", "uci": "a2a3"}, {"prob": 0.057927, "san": "Nh2", "uci": "f3h2"}], "wdl": {"draw": 0.07612, "loss": 0.523696, "win": 0.400184}},
    # flipped-black.html — 4 plies, white to move (manual analysis on the opponent's turn)
    "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1|e2e4 c7c5 g1f3 d7d6|2400|2400|3":
    {"elapsed_ms": 10.07, "model": "maia3-5m", "moves": [{"prob": 0.709055, "san": "d4", "uci": "d2d4"}, {"prob": 0.139307, "san": "Bb5+", "uci": "f1b5"}, {"prob": 0.065148, "san": "c3", "uci": "c2c3"}], "wdl": {"draw": 0.062721, "loss": 0.44602, "win": 0.491259}},
    # ruy-lopez.html — 16 plies, default Elo (top-1 h3)
    "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1|e2e4 e7e5 g1f3 b8c6 f1b5 a7a6 b5a4 g8f6 e1g1 f8e7 f1e1 b7b5 a4b3 d7d6 c2c3 e8g8|2400|2400|3":
    {"elapsed_ms": 12.25, "model": "maia3-5m", "moves": [{"prob": 0.805269, "san": "h3", "uci": "h2h3"}, {"prob": 0.132964, "san": "d4", "uci": "d2d4"}, {"prob": 0.03005, "san": "d3", "uci": "d2d3"}], "wdl": {"draw": 0.069823, "loss": 0.439256, "win": 0.490922}},
    # ruy-lopez @ 1200/1200 — top-1 d4 (the Elo proof)
    "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1|e2e4 e7e5 g1f3 b8c6 f1b5 a7a6 b5a4 g8f6 e1g1 f8e7 f1e1 b7b5 a4b3 d7d6 c2c3 e8g8|1200|1200|3":
    {"elapsed_ms": 11.72, "model": "maia3-5m", "moves": [{"prob": 0.835798, "san": "d4", "uci": "d2d4"}, {"prob": 0.106114, "san": "h3", "uci": "h2h3"}, {"prob": 0.021596, "san": "d3", "uci": "d2d3"}], "wdl": {"draw": 0.021242, "loss": 0.382135, "win": 0.596622}},
    # ruy-lopez @ 2600/2600 — top-1 h3 with different probabilities
    "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1|e2e4 e7e5 g1f3 b8c6 f1b5 a7a6 b5a4 g8f6 e1g1 f8e7 f1e1 b7b5 a4b3 d7d6 c2c3 e8g8|2600|2600|3":
    {"elapsed_ms": 11.8, "model": "maia3-5m", "moves": [{"prob": 0.861733, "san": "h3", "uci": "h2h3"}, {"prob": 0.094848, "san": "d4", "uci": "d2d4"}, {"prob": 0.023123, "san": "a4", "uci": "a2a4"}], "wdl": {"draw": 0.095935, "loss": 0.424486, "win": 0.479579}},
    # gameover-checkmate.html — scholar's mate: moves[] + rules-decided WDL
    "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1|e2e4 e7e5 f1c4 b8c6 d1h5 g8f6 h5f7|2400|2400|3":
    {"elapsed_ms": 1.01, "model": "maia3-5m", "moves": [], "wdl": {"draw": 0.0, "loss": 1.0, "win": 0.0}},
    # M7 premove proof: startpos + 1.e4 — the panel refreshes this position on
    # OUR turn (after their capture in the stale-race case / the gating case).
    "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1|e2e4|2400|2400|3":
    {"elapsed_ms": 11.2, "model": "maia3-5m", "moves": [{"prob": 0.374898, "san": "c5", "uci": "c7c5"}, {"prob": 0.171366, "san": "e5", "uci": "e7e5"}, {"prob": 0.128604, "san": "c6", "uci": "c7c6"}], "wdl": {"draw": 0.064554, "loss": 0.51594, "win": 0.419506}},
}


def canned_lookup(payload: dict) -> tuple[dict | None, bool, str]:
    """Find a canned response for an /analyze payload.

    Returns (response, elo_fallback, key). Exact key first; for a KNOWN position
    with an unknown Elo pair the default 2400/2400 body is reused (flagged), so a
    test that nudges the Elo sliders never depends on extra canned data.
    """
    fen = str(payload.get("fen", ""))
    moves = " ".join(str(move) for move in (payload.get("moves") or []))
    elo_self = int(payload.get("elo_self", DEFAULT_ELO))
    elo_oppo = int(payload.get("elo_oppo", DEFAULT_ELO))
    top_k = int(payload.get("top_k", DEFAULT_TOP_K))
    key = f"{fen}|{moves}|{elo_self}|{elo_oppo}|{top_k}"
    if key in CANNED:
        return CANNED[key], False, key
    fallback_key = f"{fen}|{moves}|{DEFAULT_ELO}|{DEFAULT_ELO}|{top_k}"
    if fallback_key in CANNED:
        return CANNED[fallback_key], True, key
    return None, False, key


# ---------------------------------------------------------------------------
# CANNED /premove responses (M7) — recorded from the REAL server, same rules:
# key = "<fen>|<uci moves>|<elo_self>|<elo_oppo>|<top_n>|<min_safety>|<mode>".
# The position mapping is identical to /analyze (base FEN + UCI history).
# ---------------------------------------------------------------------------
CANNED_PREMOVE: dict[str, dict] = {
    # premove-takeback.html — Benoni, black to move (user white). Their obvious
    # continuation is 4...exd5 (96.3%) and the natural take-back 5.cxd5 is the
    # recommended premove (safe_vs_all; the quiet moves leave our d5 pawn so the
    # premove cannot fire = guard). This is the real-mode ground truth too.
    "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1|d2d4 g8f6 c2c4 c7c5 d4d5 e7e6 b1c3|2400|2400|5|0.9|top":
    {"candidates": [{"guard_mass": 0.036524, "min_response_prob": 0.983822, "safe_mass": 0.963476, "san": "cxd5", "uci": "c4d5", "verdict": "recommended", "why": "safety 100% >= 90%; safe mass 96%, guard mass 4%; min response prob 98% >= 15%"}, {"guard_mass": 0.99149, "min_response_prob": 0.369842, "safe_mass": 0.00851, "san": "cxb5", "uci": "c4b5", "verdict": "recommended", "why": "safety 100% >= 90%; safe mass 1%, guard mass 99%; min response prob 37% >= 15%"}, {"guard_mass": 0.0, "min_response_prob": 0.727735, "safe_mass": 0.025437, "san": "e4", "uci": "e2e4", "verdict": "not_safe", "why": "safety 3% < required 90% (safe 3% + guard 0%)"}, {"guard_mass": 0.0, "min_response_prob": 0.57489, "safe_mass": 0.002577, "san": "a4", "uci": "a2a4", "verdict": "not_safe", "why": "safety 0% < required 90% (safe 0% + guard 0%)"}], "elapsed_ms": 69.14, "excluded": [], "fen": "rnbqkb1r/pp1p1ppp/4pn2/2pP4/2P5/2N5/PP2PPPP/R1BQKBNR b KQkq - 1 4", "model": "maia3-5m", "opponent": [{"prob": 0.963476, "san": "exd5", "uci": "e6d5"}, {"prob": 0.021384, "san": "d6", "uci": "d7d6"}, {"prob": 0.00851, "san": "b5", "uci": "b7b5"}, {"prob": 0.004053, "san": "g6", "uci": "g7g6"}, {"prob": 0.002577, "san": "a6", "uci": "a7a6"}], "params": {"elo_oppo": 2400, "elo_self": 2400, "min_response_prob": 0.15, "min_safety": 0.9, "mode": "top", "top_n": 5}, "reason": None, "recommended": {"criterion": "safe_vs_all", "detail": "1/5 considered replies are met by cxd5 (safe mass 96%); 4% of their mass cannot fire the premove (illegal after their move -> safe by inaction); overall safety 100%; min best-response probability 98%", "min_response_prob": 0.983822, "safety": 1.0, "san": "cxd5", "uci": "c4d5"}, "side_to_move": "black", "timings_ms": {"responses": 50.99, "root": 15.05, "total": 69.14}},
    # flipped-black.html — white to move (user black). Their d4 (73.7%) is met by
    # our take-back cxd4 (98.1%); everything else cannot fire it (guard).
    "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1|e2e4 c7c5 g1f3 d7d6|2400|2400|5|0.9|top":
    {"candidates": [{"guard_mass": 0.26346, "min_response_prob": 0.980774, "safe_mass": 0.73654, "san": "cxd4", "uci": "c5d4", "verdict": "recommended", "why": "safety 100% >= 90%; safe mass 74%, guard mass 26%; min response prob 98% >= 15%"}, {"guard_mass": 0.144707, "min_response_prob": 0.499573, "safe_mass": 0.118753, "san": "Nf6", "uci": "g8f6", "verdict": "not_safe", "why": "safety 26% < required 90% (safe 12% + guard 14%)"}, {"guard_mass": 0.0, "min_response_prob": 0.489529, "safe_mass": 0.144707, "san": "Bd7", "uci": "c8d7", "verdict": "not_safe", "why": "safety 14% < required 90% (safe 14% + guard 0%)"}], "elapsed_ms": 70.61, "excluded": [], "fen": "rnbqkbnr/pp2pppp/3p4/2p5/4P3/5N2/PPPP1PPP/RNBQKB1R w KQkq - 0 3", "model": "maia3-5m", "opponent": [{"prob": 0.73654, "san": "d4", "uci": "d2d4"}, {"prob": 0.144707, "san": "Bb5+", "uci": "f1b5"}, {"prob": 0.067673, "san": "c3", "uci": "c2c3"}, {"prob": 0.032075, "san": "Nc3", "uci": "b1c3"}, {"prob": 0.019005, "san": "Bc4", "uci": "f1c4"}], "params": {"elo_oppo": 2400, "elo_self": 2400, "min_response_prob": 0.15, "min_safety": 0.9, "mode": "top", "top_n": 5}, "reason": None, "recommended": {"criterion": "safe_vs_all", "detail": "1/5 considered replies are met by cxd4 (safe mass 74%); 26% of their mass cannot fire the premove (illegal after their move -> safe by inaction); overall safety 100%; min best-response probability 98%", "min_response_prob": 0.980774, "safety": 1.0, "san": "cxd4", "uci": "c5d4"}, "side_to_move": "white", "timings_ms": {"responses": 57.82, "root": 11.98, "total": 70.61}},
    # startpos + 1.e4 (black to move): c5/e5/c6/e6 need different answers -> the
    # honest "no safe premove" state.
    "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1|e2e4|2400|2400|5|0.9|top":
    {"candidates": [{"guard_mass": 0.0, "min_response_prob": 0.669597, "safe_mass": 0.639619, "san": "Nf3", "uci": "g1f3", "verdict": "not_safe", "why": "safety 64% < required 90% (safe 64% + guard 0%)"}, {"guard_mass": 0.0, "min_response_prob": 0.682793, "safe_mass": 0.360381, "san": "d4", "uci": "d2d4", "verdict": "not_safe", "why": "safety 36% < required 90% (safe 36% + guard 0%)"}], "elapsed_ms": 57.29, "excluded": [], "fen": "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1", "model": "maia3-5m", "opponent": [{"prob": 0.438967, "san": "c5", "uci": "c7c5"}, {"prob": 0.200652, "san": "e5", "uci": "e7e5"}, {"prob": 0.150582, "san": "c6", "uci": "c7c6"}, {"prob": 0.147298, "san": "e6", "uci": "e7e6"}, {"prob": 0.062501, "san": "d6", "uci": "d7d6"}], "params": {"elo_oppo": 2400, "elo_self": 2400, "min_response_prob": 0.15, "min_safety": 0.9, "mode": "top", "top_n": 5}, "reason": "no safe premove: the best reply Nf3 covers only 64% of their considered moves (safe 64%, required 90%)", "recommended": None, "side_to_move": "black", "timings_ms": {"responses": 48.17, "root": 8.71, "total": 57.29}},
    # take-back fixture + 4...exd5 5.cxd5 (9 plies, black to move): criterion
    # "robust" — their d6 (92%) is met by our e4 (99.3%); the rest is unsafe mass.
    "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1|d2d4 g8f6 c2c4 c7c5 d4d5 e7e6 b1c3 e6d5 c4d5|2400|2400|5|0.9|top":
    {"candidates": [{"guard_mass": 0.0, "min_response_prob": 0.579885, "safe_mass": 0.993231, "san": "e4", "uci": "e2e4", "verdict": "recommended", "why": "safety 99% >= 90%; safe mass 99%, guard mass 0%; min response prob 58% >= 15%"}, {"guard_mass": 0.0, "min_response_prob": 0.671206, "safe_mass": 0.004762, "san": "a4", "uci": "a2a4", "verdict": "not_safe", "why": "safety 0% < required 90% (safe 0% + guard 0%)"}, {"guard_mass": 0.0, "min_response_prob": 0.695113, "safe_mass": 0.002007, "san": "Nxb5", "uci": "c3b5", "verdict": "not_safe", "why": "safety 0% < required 90% (safe 0% + guard 0%)"}], "elapsed_ms": 73.14, "excluded": [], "fen": "rnbqkb1r/pp1p1ppp/5n2/2pP4/8/2N5/PP2PPPP/R1BQKBNR b KQkq - 0 5", "model": "maia3-5m", "opponent": [{"prob": 0.920385, "san": "d6", "uci": "d7d6"}, {"prob": 0.044669, "san": "Bd6", "uci": "f8d6"}, {"prob": 0.028177, "san": "g6", "uci": "g7g6"}, {"prob": 0.004762, "san": "a6", "uci": "a7a6"}, {"prob": 0.002007, "san": "b5", "uci": "b7b5"}], "params": {"elo_oppo": 2400, "elo_self": 2400, "min_response_prob": 0.15, "min_safety": 0.9, "mode": "top", "top_n": 5}, "reason": None, "recommended": {"criterion": "robust", "detail": "3/5 considered replies are met by e4 (safe mass 99%); 0% of their mass cannot fire the premove (illegal after their move -> safe by inaction); overall safety 99%; min best-response probability 58%", "min_response_prob": 0.579885, "safety": 0.993231, "san": "e4", "uci": "e2e4"}, "side_to_move": "black", "timings_ms": {"responses": 58.51, "root": 13.34, "total": 73.14}},
    # The forced-recapture position (used by the mismatch mutation: board-only
    # request, opponent has exactly one legal move). Criterion "forced".
    # The key carries the adapter's board-only FEN (7-ply parity: b - - 0 4).
    "8/1n4b1/4K3/5N2/4R3/3k4/1R1Qr1Q1/8 b - - 0 5||2400|2400|5|0.9|top":
    {"candidates": [{"guard_mass": 0.0, "min_response_prob": 0.311407, "safe_mass": 1.0, "san": "Qxd2+", "uci": "g2d2", "verdict": "recommended", "why": "forced: their only legal move is Rxd2; Maia's best answer is Qxd2+ (31%)"}], "elapsed_ms": 18.03, "excluded": [], "fen": "8/1n4b1/4K3/5N2/4R3/3k4/1R1Qr1Q1/8 b - - 0 5", "model": "maia3-5m", "opponent": [{"prob": 1.0, "san": "Rxd2", "uci": "e2d2"}], "params": {"elo_oppo": 2400, "elo_self": 2400, "min_response_prob": 0.15, "min_safety": 0.9, "mode": "top", "top_n": 5}, "reason": None, "recommended": {"criterion": "forced", "detail": "forced premove: their only legal move is Rxd2; Maia's best answer is Qxd2+ (31% of the reply distribution)", "min_response_prob": 0.311407, "safety": 1.0, "san": "Qxd2+", "uci": "g2d2"}, "side_to_move": "black", "timings_ms": {"responses": 8.47, "root": 9.26, "total": 18.03}},
    # The stale-race position: the same board-only mutation machinery with the
    # K+P endgame (black to move, every reply met by b8=Q+) — a DIFFERENT
    # recommendation than the forced one, so a stale render would be visible.
    "8/1P6/8/p7/k7/7K/8/8 b - - 0 5||2400|2400|5|0.9|top":
    {"candidates": [{"guard_mass": 0.0, "min_response_prob": 0.970762, "safe_mass": 1.0, "san": "b8=Q+", "uci": "b7b8q", "verdict": "recommended", "why": "safety 100% >= 90%; safe mass 100%, guard mass 0%; min response prob 97% >= 15%"}], "elapsed_ms": 61.2, "excluded": [], "fen": "8/1P6/8/p7/k7/7K/8/8 b - - 0 5", "model": "maia3-5m", "opponent": [{"prob": 0.601143, "san": "Kb3", "uci": "a4b3"}, {"prob": 0.221372, "san": "Ka3", "uci": "a4a3"}, {"prob": 0.109565, "san": "Kb4", "uci": "a4b4"}, {"prob": 0.06792, "san": "Kb5", "uci": "a4b5"}], "params": {"elo_oppo": 2400, "elo_self": 2400, "min_response_prob": 0.15, "min_safety": 0.9, "mode": "top", "top_n": 5}, "reason": None, "recommended": {"criterion": "safe_vs_all", "detail": "4/4 considered replies are met by b8=Q+ (safe mass 100%); 0% of their mass cannot fire the premove (illegal after their move -> safe by inaction); overall safety 100%; min best-response probability 97%", "min_response_prob": 0.970762, "safety": 1.0, "san": "b8=Q+", "uci": "b7b8q"}, "side_to_move": "black", "timings_ms": {"responses": 45.6, "root": 15.6, "total": 61.2}},
}


def premove_canned_lookup(payload: dict) -> tuple[dict | None, str]:
    """Find a canned response for a /premove payload (exact key only)."""
    fen = str(payload.get("fen", ""))
    moves = " ".join(str(move) for move in (payload.get("moves") or []))
    elo_self = int(payload.get("elo_self", DEFAULT_ELO))
    elo_oppo = int(payload.get("elo_oppo", DEFAULT_ELO))
    top_n = int(payload.get("top_n", DEFAULT_TOP_N))
    min_safety = float(payload.get("min_safety", DEFAULT_MIN_SAFETY))
    mode = str(payload.get("mode", DEFAULT_PREMOVE_MODE))
    key = f"{fen}|{moves}|{elo_self}|{elo_oppo}|{top_n}|{min_safety}|{mode}"
    return CANNED_PREMOVE.get(key), key


# ---------------------------------------------------------------------------
# CANNED /explain responses (M8) — recorded from the REAL server, same rules:
# key = "<fen>|<uci moves incl. the move to explain>|<elo_self>|<elo_oppo>".
# The panel sends the standard start position + the full per-ply prefix, so the
# stub replay of the Italian Game (7 plies) and of the 14-ply fixture montage is
# covered (the first 7 prefixes coincide — 14 unique keys).
# ---------------------------------------------------------------------------
CANNED_EXPLAIN: dict[str, dict] = {
    # Italian 1/7: e2e4 (ply 1), both colors, chips + a castle
    'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1|e2e4|2400|2400':
    {'classification': 'mainline',
 'elapsed_ms': 33.45064,
 'flags': {'capture': False, 'castle': None, 'check': False, 'enPassant': False, 'mate': False, 'promotion': None, 'recapture': False},
 'maia': {'moverElo': 2400,
          'playedProb': 0.464864,
          'rank': 1,
          'top': [{'prob': 0.464864, 'san': 'e4', 'uci': 'e2e4'},
                  {'prob': 0.339048, 'san': 'd4', 'uci': 'd2d4'},
                  {'prob': 0.081763, 'san': 'Nf3', 'uci': 'g1f3'}],
          'totalLegal': 20},
 'material': {'captured': None, 'delta': 0},
 'model': 'maia3-5m',
 'move': {'by': 'white', 'moveNumber': 1, 'ply': 1, 'san': 'e4', 'uci': 'e2e4'},
 'opening': {'eco': 'B00', 'name': "King's Pawn Game"},
 'wdl': {'after': {'draw': 0.064554, 'loss': 0.419506, 'win': 0.51594}, 'before': {'draw': 0.067579, 'loss': 0.456007, 'win': 0.476414}}},
    # Italian 2/7: e7e5 (ply 2), both colors, chips + a castle
    'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1|e2e4 e7e5|2400|2400':
    {'classification': 'common',
 'elapsed_ms': 28.680847,
 'flags': {'capture': False, 'castle': None, 'check': False, 'enPassant': False, 'mate': False, 'promotion': None, 'recapture': False},
 'maia': {'moverElo': 2400,
          'playedProb': 0.171366,
          'rank': 2,
          'top': [{'prob': 0.374898, 'san': 'c5', 'uci': 'c7c5'},
                  {'prob': 0.171366, 'san': 'e5', 'uci': 'e7e5'},
                  {'prob': 0.128604, 'san': 'c6', 'uci': 'c7c6'}],
          'totalLegal': 20},
 'material': {'captured': None, 'delta': 0},
 'model': 'maia3-5m',
 'move': {'by': 'black', 'moveNumber': 1, 'ply': 2, 'san': 'e5', 'uci': 'e7e5'},
 'opening': {'eco': 'C20', 'name': "King's Pawn Game"},
 'wdl': {'after': {'draw': 0.070189, 'loss': 0.479429, 'win': 0.450382}, 'before': {'draw': 0.064554, 'loss': 0.51594, 'win': 0.419506}}},
    # Italian 3/7: g1f3 (ply 3), both colors, chips + a castle
    'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1|e2e4 e7e5 g1f3|2400|2400':
    {'classification': 'mainline',
 'elapsed_ms': 29.363983,
 'flags': {'capture': False, 'castle': None, 'check': False, 'enPassant': False, 'mate': False, 'promotion': None, 'recapture': False},
 'maia': {'moverElo': 2400,
          'playedProb': 0.783514,
          'rank': 1,
          'top': [{'prob': 0.783514, 'san': 'Nf3', 'uci': 'g1f3'},
                  {'prob': 0.082608, 'san': 'Nc3', 'uci': 'b1c3'},
                  {'prob': 0.050448, 'san': 'f4', 'uci': 'f2f4'}],
          'totalLegal': 29},
 'material': {'captured': None, 'delta': 0},
 'model': 'maia3-5m',
 'move': {'by': 'white', 'moveNumber': 2, 'ply': 3, 'san': 'Nf3', 'uci': 'g1f3'},
 'opening': {'eco': 'C40', 'name': "King's Knight Opening"},
 'wdl': {'after': {'draw': 0.068684, 'loss': 0.424534, 'win': 0.506782}, 'before': {'draw': 0.070189, 'loss': 0.450382, 'win': 0.479429}}},
    # Italian 4/7: b8c6 (ply 4), both colors, chips + a castle
    'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1|e2e4 e7e5 g1f3 b8c6|2400|2400':
    {'classification': 'mainline',
 'elapsed_ms': 21.33167,
 'flags': {'capture': False, 'castle': None, 'check': False, 'enPassant': False, 'mate': False, 'promotion': None, 'recapture': False},
 'maia': {'moverElo': 2400,
          'playedProb': 0.789386,
          'rank': 1,
          'top': [{'prob': 0.789386, 'san': 'Nc6', 'uci': 'b8c6'},
                  {'prob': 0.128772, 'san': 'Nf6', 'uci': 'g8f6'},
                  {'prob': 0.039803, 'san': 'd6', 'uci': 'd7d6'}],
          'totalLegal': 29},
 'material': {'captured': None, 'delta': 0},
 'model': 'maia3-5m',
 'move': {'by': 'black', 'moveNumber': 2, 'ply': 4, 'san': 'Nc6', 'uci': 'b8c6'},
 'opening': {'eco': 'C44', 'name': "King's Knight Opening: Normal Variation"},
 'wdl': {'after': {'draw': 0.069245, 'loss': 0.477108, 'win': 0.453647}, 'before': {'draw': 0.068684, 'loss': 0.506782, 'win': 0.424534}}},
    # Italian 5/7: f1c4 (ply 5), both colors, chips + a castle
    'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1|e2e4 e7e5 g1f3 b8c6 f1c4|2400|2400':
    {'classification': 'common',
 'elapsed_ms': 21.791062,
 'flags': {'capture': False, 'castle': None, 'check': False, 'enPassant': False, 'mate': False, 'promotion': None, 'recapture': False},
 'maia': {'moverElo': 2400,
          'playedProb': 0.32033,
          'rank': 2,
          'top': [{'prob': 0.433423, 'san': 'Bb5', 'uci': 'f1b5'},
                  {'prob': 0.32033, 'san': 'Bc4', 'uci': 'f1c4'},
                  {'prob': 0.134536, 'san': 'd4', 'uci': 'd2d4'}],
          'totalLegal': 27},
 'material': {'captured': None, 'delta': 0},
 'model': 'maia3-5m',
 'move': {'by': 'white', 'moveNumber': 3, 'ply': 5, 'san': 'Bc4', 'uci': 'f1c4'},
 'opening': {'eco': 'C50', 'name': 'Italian Game'},
 'wdl': {'after': {'draw': 0.068238, 'loss': 0.424128, 'win': 0.507633}, 'before': {'draw': 0.069245, 'loss': 0.453647, 'win': 0.477108}}},
    # Italian 6/7: f8c5 (ply 6), both colors, chips + a castle
    'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1|e2e4 e7e5 g1f3 b8c6 f1c4 f8c5|2400|2400':
    {'classification': 'common',
 'elapsed_ms': 24.553115,
 'flags': {'capture': False, 'castle': None, 'check': False, 'enPassant': False, 'mate': False, 'promotion': None, 'recapture': False},
 'maia': {'moverElo': 2400,
          'playedProb': 0.448502,
          'rank': 2,
          'top': [{'prob': 0.47118, 'san': 'Nf6', 'uci': 'g8f6'},
                  {'prob': 0.448502, 'san': 'Bc5', 'uci': 'f8c5'},
                  {'prob': 0.037204, 'san': 'Be7', 'uci': 'f8e7'}],
          'totalLegal': 31},
 'material': {'captured': None, 'delta': 0},
 'model': 'maia3-5m',
 'move': {'by': 'black', 'moveNumber': 3, 'ply': 6, 'san': 'Bc5', 'uci': 'f8c5'},
 'opening': {'eco': 'C50', 'name': 'Italian Game: Giuoco Piano'},
 'wdl': {'after': {'draw': 0.05606, 'loss': 0.478543, 'win': 0.465397}, 'before': {'draw': 0.068238, 'loss': 0.507633, 'win': 0.424128}}},
    # Italian 7/7: e1g1 (ply 7), both colors, chips + a castle
    'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1|e2e4 e7e5 g1f3 b8c6 f1c4 f8c5 e1g1|2400|2400':
    {'classification': 'common',
 'elapsed_ms': 29.450549,
 'flags': {'capture': False, 'castle': 'kingside', 'check': False, 'enPassant': False, 'mate': False, 'promotion': None, 'recapture': False},
 'maia': {'moverElo': 2400,
          'playedProb': 0.224414,
          'rank': 2,
          'top': [{'prob': 0.387351, 'san': 'c3', 'uci': 'c2c3'},
                  {'prob': 0.224414, 'san': 'O-O', 'uci': 'e1g1'},
                  {'prob': 0.20589, 'san': 'd3', 'uci': 'd2d3'}],
          'totalLegal': 33},
 'material': {'captured': None, 'delta': 0},
 'model': 'maia3-5m',
 'move': {'by': 'white', 'moveNumber': 4, 'ply': 7, 'san': 'O-O', 'uci': 'e1g1'},
 'opening': {'eco': 'C50', 'name': 'Italian Game: Giuoco Piano'},
 'wdl': {'after': {'draw': 0.065992, 'loss': 0.419748, 'win': 0.51426}, 'before': {'draw': 0.05606, 'loss': 0.465397, 'win': 0.478543}}},
    # middlegame montage ply 8/14: g8f6 (the real-mode replay)
    'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1|e2e4 e7e5 g1f3 b8c6 f1c4 f8c5 e1g1 g8f6|2400|2400':
    {'classification': 'mainline',
 'elapsed_ms': 20.475834,
 'flags': {'capture': False, 'castle': None, 'check': False, 'enPassant': False, 'mate': False, 'promotion': None, 'recapture': False},
 'maia': {'moverElo': 2400,
          'playedProb': 0.783456,
          'rank': 1,
          'top': [{'prob': 0.783456, 'san': 'Nf6', 'uci': 'g8f6'},
                  {'prob': 0.1874, 'san': 'd6', 'uci': 'd7d6'},
                  {'prob': 0.009349, 'san': 'Nge7', 'uci': 'g8e7'}],
          'totalLegal': 36},
 'material': {'captured': None, 'delta': 0},
 'model': 'maia3-5m',
 'move': {'by': 'black', 'moveNumber': 4, 'ply': 8, 'san': 'Nf6', 'uci': 'g8f6'},
 'opening': {'eco': 'C50', 'name': 'Italian Game: Giuoco Piano'},
 'wdl': {'after': {'draw': 0.061186, 'loss': 0.466588, 'win': 0.472225}, 'before': {'draw': 0.065992, 'loss': 0.51426, 'win': 0.419748}}},
    # middlegame montage ply 9/14: d2d3 (the real-mode replay)
    'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1|e2e4 e7e5 g1f3 b8c6 f1c4 f8c5 e1g1 g8f6 d2d3|2400|2400':
    {'classification': 'mainline',
 'elapsed_ms': 27.415566,
 'flags': {'capture': False, 'castle': None, 'check': False, 'enPassant': False, 'mate': False, 'promotion': None, 'recapture': False},
 'maia': {'moverElo': 2400,
          'playedProb': 0.416865,
          'rank': 1,
          'top': [{'prob': 0.416865, 'san': 'd3', 'uci': 'd2d3'},
                  {'prob': 0.402343, 'san': 'd4', 'uci': 'd2d4'},
                  {'prob': 0.086015, 'san': 'c3', 'uci': 'c2c3'}],
          'totalLegal': 30},
 'material': {'captured': None, 'delta': 0},
 'model': 'maia3-5m',
 'move': {'by': 'white', 'moveNumber': 5, 'ply': 9, 'san': 'd3', 'uci': 'd2d3'},
 'opening': {'eco': 'C50', 'name': 'Italian Game: Giuoco Piano'},
 'wdl': {'after': {'draw': 0.073142, 'loss': 0.449133, 'win': 0.477725}, 'before': {'draw': 0.061186, 'loss': 0.472225, 'win': 0.466588}}},
    # middlegame montage ply 10/14: d7d6 (the real-mode replay)
    'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1|e2e4 e7e5 g1f3 b8c6 f1c4 f8c5 e1g1 g8f6 d2d3 d7d6|2400|2400':
    {'classification': 'mainline',
 'elapsed_ms': 28.812932,
 'flags': {'capture': False, 'castle': None, 'check': False, 'enPassant': False, 'mate': False, 'promotion': None, 'recapture': False},
 'maia': {'moverElo': 2400,
          'playedProb': 0.626179,
          'rank': 1,
          'top': [{'prob': 0.626179, 'san': 'd6', 'uci': 'd7d6'},
                  {'prob': 0.216105, 'san': 'O-O', 'uci': 'e8g8'},
                  {'prob': 0.077143, 'san': 'h6', 'uci': 'h7h6'}],
          'totalLegal': 36},
 'material': {'captured': None, 'delta': 0},
 'model': 'maia3-5m',
 'move': {'by': 'black', 'moveNumber': 5, 'ply': 10, 'san': 'd6', 'uci': 'd7d6'},
 'opening': {'eco': 'C50', 'name': 'Italian Game: Giuoco Piano'},
 'wdl': {'after': {'draw': 0.06919, 'loss': 0.47167, 'win': 0.45914}, 'before': {'draw': 0.073142, 'loss': 0.477725, 'win': 0.449133}}},
    # middlegame montage ply 11/14: c1g5 (the real-mode replay)
    'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1|e2e4 e7e5 g1f3 b8c6 f1c4 f8c5 e1g1 g8f6 d2d3 d7d6 c1g5|2400|2400':
    {'classification': 'uncommon',
 'elapsed_ms': 23.97644,
 'flags': {'capture': False, 'castle': None, 'check': False, 'enPassant': False, 'mate': False, 'promotion': None, 'recapture': False},
 'maia': {'moverElo': 2400,
          'playedProb': 0.078825,
          'rank': 4,
          'top': [{'prob': 0.48707, 'san': 'c3', 'uci': 'c2c3'},
                  {'prob': 0.187593, 'san': 'h3', 'uci': 'h2h3'},
                  {'prob': 0.085354, 'san': 'a4', 'uci': 'a2a4'}],
          'totalLegal': 35},
 'material': {'captured': None, 'delta': 0},
 'model': 'maia3-5m',
 'move': {'by': 'white', 'moveNumber': 6, 'ply': 11, 'san': 'Bg5', 'uci': 'c1g5'},
 'opening': {'eco': 'C50', 'name': 'Italian Game: Giuoco Piano'},
 'wdl': {'after': {'draw': 0.069496, 'loss': 0.450294, 'win': 0.480211}, 'before': {'draw': 0.06919, 'loss': 0.45914, 'win': 0.47167}}},
    # middlegame montage ply 12/14: e8g8 (the real-mode replay)
    'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1|e2e4 e7e5 g1f3 b8c6 f1c4 f8c5 e1g1 g8f6 d2d3 d7d6 c1g5 e8g8|2400|2400':
    {'classification': 'rare',
 'elapsed_ms': 26.513202,
 'flags': {'capture': False, 'castle': 'kingside', 'check': False, 'enPassant': False, 'mate': False, 'promotion': None, 'recapture': False},
 'maia': {'moverElo': 2400,
          'playedProb': 0.026258,
          'rank': 5,
          'top': [{'prob': 0.81232, 'san': 'h6', 'uci': 'h7h6'},
                  {'prob': 0.064873, 'san': 'Bg4', 'uci': 'c8g4'},
                  {'prob': 0.03313, 'san': 'Be6', 'uci': 'c8e6'}],
          'totalLegal': 39},
 'material': {'captured': None, 'delta': 0},
 'model': 'maia3-5m',
 'move': {'by': 'black', 'moveNumber': 6, 'ply': 12, 'san': 'O-O', 'uci': 'e8g8'},
 'opening': {'eco': 'C50', 'name': 'Italian Game: Giuoco Piano'},
 'wdl': {'after': {'draw': 0.072136, 'loss': 0.476836, 'win': 0.451028}, 'before': {'draw': 0.069496, 'loss': 0.480211, 'win': 0.450294}}},
    # middlegame montage ply 13/14: g5f6 (the real-mode replay)
    'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1|e2e4 e7e5 g1f3 b8c6 f1c4 f8c5 e1g1 g8f6 d2d3 d7d6 c1g5 e8g8 g5f6|2400|2400':
    {'classification': 'rare',
 'elapsed_ms': 24.92337,
 'flags': {'capture': True, 'castle': None, 'check': False, 'enPassant': False, 'mate': False, 'promotion': None, 'recapture': False},
 'maia': {'moverElo': 2400,
          'playedProb': 0.001926,
          'rank': 10,
          'top': [{'prob': 0.433965, 'san': 'Nc3', 'uci': 'b1c3'},
                  {'prob': 0.257085, 'san': 'c3', 'uci': 'c2c3'},
                  {'prob': 0.147975, 'san': 'h3', 'uci': 'h2h3'}],
          'totalLegal': 37},
 'material': {'captured': {'piece': 'knight', 'square': 'f6', 'value': 3}, 'delta': 3},
 'model': 'maia3-5m',
 'move': {'by': 'white', 'moveNumber': 7, 'ply': 13, 'san': 'Bxf6', 'uci': 'g5f6'},
 'opening': {'eco': 'C50', 'name': 'Italian Game: Giuoco Piano'},
 'wdl': {'after': {'draw': 0.069125, 'loss': 0.456494, 'win': 0.474381}, 'before': {'draw': 0.072136, 'loss': 0.451028, 'win': 0.476836}}},
    # middlegame montage ply 14/14: d8f6 (the real-mode replay)
    'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1|e2e4 e7e5 g1f3 b8c6 f1c4 f8c5 e1g1 g8f6 d2d3 d7d6 c1g5 e8g8 g5f6 d8f6|2400|2400':
    {'classification': 'mainline',
 'elapsed_ms': 29.708335,
 'flags': {'capture': True, 'castle': None, 'check': False, 'enPassant': False, 'mate': False, 'promotion': None, 'recapture': True},
 'maia': {'moverElo': 2400,
          'playedProb': 0.992488,
          'rank': 1,
          'top': [{'prob': 0.992488, 'san': 'Qxf6', 'uci': 'd8f6'},
                  {'prob': 0.007251, 'san': 'gxf6', 'uci': 'g7f6'},
                  {'prob': 7e-05, 'san': 'h6', 'uci': 'h7h6'}],
          'totalLegal': 33},
 'material': {'captured': {'piece': 'bishop', 'square': 'f6', 'value': 3}, 'delta': 3},
 'model': 'maia3-5m',
 'move': {'by': 'black', 'moveNumber': 7, 'ply': 14, 'san': 'Qxf6', 'uci': 'd8f6'},
 'opening': {'eco': 'C50', 'name': 'Italian Game: Giuoco Piano'},
 'wdl': {'after': {'draw': 0.073429, 'loss': 0.386213, 'win': 0.540358}, 'before': {'draw': 0.069125, 'loss': 0.474381, 'win': 0.456494}}},
}

# ---------------------------------------------------------------------------
# CANNED /llm answers (M8, test-only provider stand-ins). The commentary proof
# overrides the extension's provider endpoint with these routes, so the LLM
# layer (prompt, sanitizer, response parsing, fallback) runs fully offline.
# ---------------------------------------------------------------------------
CANNED_LLM_TEXT = {
    "groq": "Nice — that is the main line here, and plenty of 2400s play it too.",
    "gemini": "A natural move for this position: most 2400s choose it as well.",
}


def explain_canned_lookup(payload: dict) -> tuple[dict | None, str]:
    """Find a canned response for an /explain payload (exact key only)."""
    fen = str(payload.get("fen", ""))
    moves = " ".join(str(move) for move in (payload.get("moves") or []))
    elo_self = int(payload.get("elo_self", DEFAULT_ELO))
    elo_oppo = int(payload.get("elo_oppo", DEFAULT_ELO))
    key = f"{fen}|{moves}|{elo_self}|{elo_oppo}"
    return CANNED_EXPLAIN.get(key), key


class FixtureHandler(SimpleHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def __init__(self, *args, directory: str, model: str, **kwargs):
        self.model = model
        super().__init__(*args, directory=directory, **kwargs)

    # -- helpers -----------------------------------------------------------

    @property
    def control(self):
        return self.server.control  # type: ignore[attr-defined]

    def _send_json(self, payload: dict, status: int = 200) -> None:
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Access-Control-Allow-Origin", "*")  # dev/test only
        self.end_headers()
        self.wfile.write(body)

    def _read_json_body(self) -> dict:
        length = int(self.headers.get("Content-Length") or 0)
        if length <= 0:
            return {}
        return json.loads(self.rfile.read(length).decode("utf-8"))

    # -- GET ---------------------------------------------------------------

    def do_GET(self):  # noqa: N802 (http.server API)
        path = self.path.split("?")[0]
        if path == "/health":
            # M9: version + uptime mirror the real server's additive fields.
            self._send_json({"status": "ok", "model": self.model, "version": "fixture-1.0.0", "uptime_s": round(time.time() - self.server.started_at, 3)})
            return
        if path == "/debug/stats":
            with self.control["lock"]:
                stats = {
                    "analyzeRequests": self.control["analyzeRequests"],
                    "analyzeAttempts": self.control["analyzeAttempts"],
                    "analyzeArrivals": self.control["analyzeArrivals"],
                    "lastArrivalKey": self.control["lastArrivalKey"],
                    "byKey": dict(self.control["byKey"]),
                    "lastKey": self.control["lastKey"],
                    "mode": self.control["mode"],
                    "delaysApplied": self.control["delaysApplied"],
                    "cannedMisses": self.control["cannedMisses"],
                    "eloFallbacks": self.control["eloFallbacks"],
                    "premoveRequests": self.control["premoveRequests"],
                    "premoveAttempts": self.control["premoveAttempts"],
                    "premoveByKey": dict(self.control["premoveByKey"]),
                    "premoveLastKey": self.control["premoveLastKey"],
                    "premoveCannedMisses": self.control["premoveCannedMisses"],
                    "premoveDelaysApplied": self.control["premoveDelaysApplied"],
                    "explainRequests": self.control["explainRequests"],
                    "explainAttempts": self.control["explainAttempts"],
                    "explainByKey": dict(self.control["explainByKey"]),
                    "explainLastKey": self.control["explainLastKey"],
                    "explainCannedMisses": self.control["explainCannedMisses"],
                    "explainDelaysApplied": self.control["explainDelaysApplied"],
                    "llmRequests": self.control["llmRequests"],
                    "llmByProvider": dict(self.control["llmByProvider"]),
                    "llmMode": self.control["llmMode"],
                }
            self._send_json(stats)
            return
        super().do_GET()

    # -- POST --------------------------------------------------------------

    def do_POST(self):  # noqa: N802 (http.server API)
        path = self.path.split("?")[0]
        try:
            if path == "/analyze":
                self._handle_analyze()
                return
            if path == "/premove":
                self._handle_premove()
                return
            if path == "/explain":
                self._handle_explain()
                return
            if path == "/llm/groq":
                self._handle_llm("groq")
                return
            if path == "/llm/gemini":
                self._handle_llm("gemini")
                return
            if path == "/snapshot":
                self._handle_snapshot()
                return
            if path == "/debug/delay":
                payload = self._read_json_body()
                with self.control["lock"]:
                    self.control["delay"] = {
                        "ms": max(0, int(payload.get("ms", 0))),
                        "remaining": max(0, int(payload.get("count", 1))),
                    }
                self._send_json({"ok": True, "delay": self.control["delay"]})
                return
            if path == "/debug/premove-delay":
                payload = self._read_json_body()
                with self.control["lock"]:
                    self.control["premoveDelay"] = {
                        "ms": max(0, int(payload.get("ms", 0))),
                        "remaining": max(0, int(payload.get("count", 1))),
                    }
                self._send_json({"ok": True, "premoveDelay": self.control["premoveDelay"]})
                return
            if path == "/debug/explain-delay":
                payload = self._read_json_body()
                with self.control["lock"]:
                    self.control["explainDelay"] = {
                        "ms": max(0, int(payload.get("ms", 0))),
                        "remaining": max(0, int(payload.get("count", 1))),
                    }
                self._send_json({"ok": True, "explainDelay": self.control["explainDelay"]})
                return
            if path == "/debug/llm-mode":
                payload = self._read_json_body()
                mode = str(payload.get("mode", "ok"))
                if mode not in {"ok", "error", "timeout"}:
                    self._send_json({"ok": False, "error": f"unknown llm mode {mode!r}"}, status=400)
                    return
                with self.control["lock"]:
                    self.control["llmMode"] = mode
                self._send_json({"ok": True, "llmMode": mode})
                return
            if path == "/debug/mode":
                payload = self._read_json_body()
                mode = str(payload.get("mode", "ok"))
                if mode not in {"ok", "offline", "bad_request", "engine_unavailable"}:
                    self._send_json({"ok": False, "error": f"unknown mode {mode!r}"}, status=400)
                    return
                with self.control["lock"]:
                    self.control["mode"] = mode
                self._send_json({"ok": True, "mode": mode})
                return
            if path == "/debug/reset":
                with self.control["lock"]:
                    self.control["mode"] = "ok"
                    self.control["delay"] = {"ms": 0, "remaining": 0}
                    self.control["premoveDelay"] = {"ms": 0, "remaining": 0}
                    self.control["explainDelay"] = {"ms": 0, "remaining": 0}
                    self.control["llmMode"] = "ok"
                    self.control["analyzeRequests"] = 0
                    self.control["analyzeAttempts"] = 0
                    self.control["analyzeArrivals"] = 0
                    self.control["lastArrivalKey"] = None
                    self.control["byKey"] = {}
                    self.control["lastKey"] = None
                    self.control["delaysApplied"] = 0
                    self.control["cannedMisses"] = 0
                    self.control["eloFallbacks"] = 0
                    self.control["runtimeCanned"] = 0
                    self.control["premoveRequests"] = 0
                    self.control["premoveAttempts"] = 0
                    self.control["premoveByKey"] = {}
                    self.control["premoveLastKey"] = None
                    self.control["premoveCannedMisses"] = 0
                    self.control["premoveDelaysApplied"] = 0
                    self.control["explainRequests"] = 0
                    self.control["explainAttempts"] = 0
                    self.control["explainByKey"] = {}
                    self.control["explainLastKey"] = None
                    self.control["explainCannedMisses"] = 0
                    self.control["explainDelaysApplied"] = 0
                    self.control["llmRequests"] = 0
                    self.control["llmByProvider"] = {}
                self._send_json({"ok": True})
                return
            if path == "/debug/canned":
                # Test-only: register a canned response for an exact key at
                # runtime (used by the mismatch case, whose board-only FEN is
                # only known once the adapter has parsed the mutated page).
                payload = self._read_json_body()
                key = payload.get("key")
                response = payload.get("response")
                if not isinstance(key, str) or not isinstance(response, dict):
                    self._send_json({"ok": False, "error": "need {key: str, response: dict}"}, status=400)
                    return
                with self.control["lock"]:
                    CANNED[key] = response
                    self.control["runtimeCanned"] = self.control["runtimeCanned"] + 1
                self._send_json({"ok": True, "key": key})
                return
            if path == "/debug/canned-premove":
                # M7 twin of /debug/canned for the premove planner keys.
                payload = self._read_json_body()
                key = payload.get("key")
                response = payload.get("response")
                if not isinstance(key, str) or not isinstance(response, dict):
                    self._send_json({"ok": False, "error": "need {key: str, response: dict}"}, status=400)
                    return
                with self.control["lock"]:
                    CANNED_PREMOVE[key] = response
                    self.control["runtimeCanned"] = self.control["runtimeCanned"] + 1
                self._send_json({"ok": True, "key": key})
                return
            if path == "/debug/canned-explain":
                # M8 twin for the commentary keys (the 52-ply cap replay).
                payload = self._read_json_body()
                key = payload.get("key")
                response = payload.get("response")
                if not isinstance(key, str) or not isinstance(response, dict):
                    self._send_json({"ok": False, "error": "need {key: str, response: dict}"}, status=400)
                    return
                with self.control["lock"]:
                    CANNED_EXPLAIN[key] = response
                    self.control["runtimeCanned"] = self.control["runtimeCanned"] + 1
                self._send_json({"ok": True, "key": key})
                return
            self._send_json({"ok": False, "error": f"unknown path {self.path}"}, status=404)
        except Exception as error:  # noqa: BLE001 - report everything to the caller
            self._send_json({"ok": False, "error": str(error)}, status=400)

    def _handle_analyze(self) -> None:
        payload = self._read_json_body()
        this_delay_ms = 0
        with self.control["lock"]:
            mode = self.control["mode"]
            if self.control["delay"]["remaining"] > 0:
                self.control["delay"]["remaining"] -= 1
                self.control["delaysApplied"] += 1
                this_delay_ms = self.control["delay"]["ms"]  # only THIS request sleeps
            self.control["analyzeAttempts"] += 1
            self.control["analyzeArrivals"] += 1
            self.control["lastArrivalKey"] = f"{payload.get('fen', '')}|{' '.join(str(m) for m in (payload.get('moves') or []))}"

        if mode == "offline":
            # Simulate "no server listening": close the socket before sending a
            # single response byte (Chrome reports net::ERR_EMPTY_RESPONSE, the
            # panel's fetch rejects => network failure => the retry path).
            self.close_connection = True
            try:
                self.connection.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass
            self.connection.close()
            return

        if this_delay_ms > 0:
            time.sleep(this_delay_ms / 1000.0)

        with self.control["lock"]:
            self.control["analyzeRequests"] += 1

        if mode == "bad_request":
            self._send_json({"detail": "fixture server (test mode): simulated invalid input — the FEN was rejected"}, status=400)
            return
        if mode == "engine_unavailable":
            self._send_json({"detail": "engine unavailable: simulated (test mode)"}, status=503)
            return

        response, elo_fallback, key = canned_lookup(payload)
        with self.control["lock"]:
            self.control["lastKey"] = key
            if response is None:
                self.control["cannedMisses"] += 1
            else:
                self.control["byKey"][key] = self.control["byKey"].get(key, 0) + 1
                if elo_fallback:
                    self.control["eloFallbacks"] += 1
        if response is None:
            self._send_json(
                {"detail": f"fixture server: no canned response for {key!r} (record one with the real server)"},
                status=400,
            )
            return
        self._send_json(response)

    def _handle_premove(self) -> None:
        """M7: canned premove plans (same server semantics, canned bodies)."""
        payload = self._read_json_body()
        this_delay_ms = 0
        with self.control["lock"]:
            mode = self.control["mode"]
            if self.control["premoveDelay"]["remaining"] > 0:
                self.control["premoveDelay"]["remaining"] -= 1
                self.control["premoveDelaysApplied"] += 1
                this_delay_ms = self.control["premoveDelay"]["ms"]  # only THIS request sleeps
            self.control["premoveAttempts"] += 1

        if mode == "offline":
            self.close_connection = True
            try:
                self.connection.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass
            self.connection.close()
            return

        if this_delay_ms > 0:
            time.sleep(this_delay_ms / 1000.0)

        with self.control["lock"]:
            self.control["premoveRequests"] += 1

        if mode == "bad_request":
            self._send_json({"detail": "fixture server (test mode): simulated invalid input — the FEN was rejected"}, status=400)
            return
        if mode == "engine_unavailable":
            self._send_json({"detail": "engine unavailable: simulated (test mode)"}, status=503)
            return

        response, key = premove_canned_lookup(payload)
        with self.control["lock"]:
            self.control["premoveLastKey"] = key
            if response is None:
                self.control["premoveCannedMisses"] += 1
            else:
                self.control["premoveByKey"][key] = self.control["premoveByKey"].get(key, 0) + 1
        if response is None:
            self._send_json(
                {"detail": f"fixture server: no canned /premove response for {key!r} (record one with the real server)"},
                status=400,
            )
            return
        self._send_json(response)

    def _handle_explain(self) -> None:
        """M8: canned live-commentary facts (same server semantics, canned bodies)."""
        payload = self._read_json_body()
        this_delay_ms = 0
        with self.control["lock"]:
            mode = self.control["mode"]
            if self.control["explainDelay"]["remaining"] > 0:
                self.control["explainDelay"]["remaining"] -= 1
                self.control["explainDelaysApplied"] += 1
                this_delay_ms = self.control["explainDelay"]["ms"]  # only THIS request sleeps
            self.control["explainAttempts"] += 1

        if mode == "offline":
            self.close_connection = True
            try:
                self.connection.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass
            self.connection.close()
            return

        if this_delay_ms > 0:
            time.sleep(this_delay_ms / 1000.0)

        with self.control["lock"]:
            self.control["explainRequests"] += 1

        if mode == "bad_request":
            self._send_json({"detail": "fixture server (test mode): simulated invalid input — the FEN was rejected"}, status=400)
            return
        if mode == "engine_unavailable":
            self._send_json({"detail": "engine unavailable: simulated (test mode)"}, status=503)
            return

        response, key = explain_canned_lookup(payload)
        with self.control["lock"]:
            self.control["explainLastKey"] = key
            if response is None:
                self.control["explainCannedMisses"] += 1
            else:
                self.control["explainByKey"][key] = self.control["explainByKey"].get(key, 0) + 1
        if response is None:
            self._send_json(
                {"detail": f"fixture server: no canned /explain response for {key!r} (record one with the real server)"},
                status=400,
            )
            return
        self._send_json(response)

    def _handle_llm(self, provider: str) -> None:
        """M8 (test-only): canned provider responses for the LLM rephrasing layer.

        `/debug/llm-mode` switches between ok / HTTP 500 / a 3 s sleep (beyond the
        extension's 2.5 s timeout) so the fallback-to-template path is provable.
        """
        self._read_json_body()  # drain
        with self.control["lock"]:
            mode = self.control["llmMode"]
            self.control["llmRequests"] += 1
            self.control["llmByProvider"][provider] = self.control["llmByProvider"].get(provider, 0) + 1

        if mode == "error":
            self._send_json({"error": {"message": f"fixture server (test mode): simulated {provider} outage"}}, status=500)
            return
        if mode == "timeout":
            # Far beyond the extension's 2.5 s LLM timeout. The 10 s margin makes
            # the abort deterministic even when the panel document is a hidden
            # tab (its setTimeout callbacks can be coalesced ~1/s); the client
            # aborts, this handler wakes up later and its write to the closed
            # socket is ignored.
            time.sleep(10.0)

        text = CANNED_LLM_TEXT[provider]
        if provider == "groq":
            self._send_json({"choices": [{"message": {"role": "assistant", "content": text}}]})
        else:
            self._send_json({"candidates": [{"content": {"parts": [{"text": text}]}}]})

    def _handle_snapshot(self) -> None:
        """Snapshot intake for the side panel's "Record chess.com snapshot" button."""
        payload = self._read_json_body()
        name = str(payload.get("name") or "")
        if not SNAPSHOT_NAME.fullmatch(name):
            raise ValueError("name must match [A-Za-z0-9._-]+\\.json")
        snapshot = payload.get("snapshot")
        if not isinstance(snapshot, dict) or not snapshot.get("schema"):
            raise ValueError("snapshot must be an object with a schema field")
        SNAPSHOT_DIR.mkdir(parents=True, exist_ok=True)
        target = SNAPSHOT_DIR / name
        target.write_text(json.dumps(snapshot, indent=2) + "\n", encoding="utf-8")
        repo_root = FIXTURES_DIR.parent.parent
        self._send_json(
            {
                "ok": True,
                "path": str(target.relative_to(repo_root)),
                "bytes": target.stat().st_size,
            }
        )

    def do_OPTIONS(self):  # noqa: N802
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "*")
        self.end_headers()

    def log_message(self, fmt, *args):  # keep the test log readable
        print(f"[fixture-server] {self.address_string()} {fmt % args}", flush=True)

    def handle_one_request(self):
        # The /debug/mode "offline" case closes the socket mid-request on
        # purpose; the final flush in the base class would raise there.
        try:
            super().handle_one_request()
        except (ConnectionError, OSError):
            self.close_connection = True


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--model", default="fixture-static-server")
    args = parser.parse_args()

    handler = functools.partial(FixtureHandler, directory=str(FIXTURES_DIR), model=args.model)
    server = ThreadingHTTPServer((args.host, args.port), handler)
    server.daemon_threads = True
    server.started_at = time.time()  # type: ignore[attr-defined]
    server.control = {  # type: ignore[attr-defined]
        "lock": threading.Lock(),
        "mode": "ok",
        "delay": {"ms": 0, "remaining": 0},
        "premoveDelay": {"ms": 0, "remaining": 0},
        "explainDelay": {"ms": 0, "remaining": 0},
        "llmMode": "ok",
        "analyzeRequests": 0,
        "analyzeAttempts": 0,
        "analyzeArrivals": 0,
        "lastArrivalKey": None,
        "byKey": {},
        "lastKey": None,
        "delaysApplied": 0,
        "cannedMisses": 0,
        "eloFallbacks": 0,
        "runtimeCanned": 0,
        "premoveRequests": 0,
        "premoveAttempts": 0,
        "premoveByKey": {},
        "premoveLastKey": None,
        "premoveCannedMisses": 0,
        "premoveDelaysApplied": 0,
        "explainRequests": 0,
        "explainAttempts": 0,
        "explainByKey": {},
        "explainLastKey": None,
        "explainCannedMisses": 0,
        "explainDelaysApplied": 0,
        "llmRequests": 0,
        "llmByProvider": {},
    }
    print(
        f"[fixture-server] serving {FIXTURES_DIR} on http://{args.host}:{args.port} "
        f"({len(CANNED)} canned /analyze responses, {len(set(key.split('|')[0] for key in CANNED))} positions; "
        f"{len(CANNED_PREMOVE)} canned /premove responses; "
        f"{len(CANNED_EXPLAIN)} canned /explain responses + canned /llm/*)",
        flush=True,
    )
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()

"""Shared test positions for the humanplay server tests and the maia3-uci golden check.

Every FEN is validated by python-chess in ``test_positions_are_legal``.
``EXPECTED_TOP1`` was observed from the real Maia3-5M model (temperature 0) and
recorded in docs/HANDOFF.md; sets list the plausible mainstream human moves the
top-1 is asserted to fall into.
"""

START = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1"

# Italian game (1.e4 e5 2.Nf3 Nc6 3.Bc4 Bc5 4th move): castling is legal/available.
CASTLING = "r1bqk1nr/pppp1ppp/2n5/2b1p3/2B1P3/5N2/PPPP1PPP/RNBQK2R w KQkq - 4 4"

# White pawn on b7 can promote (b8=Q/R/B/N); black king g8, white king g1.
PROMOTION = "6k1/1P6/8/8/8/8/8/6K1 w - - 0 1"

# K+P vs K endgame: white Ke1, pawn g2 vs black Kc3. Few legal moves (<= 20).
ENDGAME = "8/8/8/8/8/2k5/6P1/4K3 w - - 0 1"

# Sicilian Najdorf-style middlegame (1.e4 c5 2.Nf3 d6 3.d4 cxd4 4.Nxd4 Nf6 5.Nc3 a6).
MIDDLEGAME = "rnbqkb1r/1p2pppp/p2p1n2/8/3NP3/2N5/PPP2PPP/R1BQKB1R w KQkq - 0 6"

# WDL perspective probes: same material, but the *side to move* is up a queen.
# If the value head were White-perspective these two would disagree; they agree,
# so it is side-to-move perspective (as documented in maia3/uci.py).
WINNING_BLACK_TO_MOVE = "4k3/8/8/8/8/8/q7/4K3 b - - 0 1"
WINNING_WHITE_TO_MOVE = "4k3/8/8/8/8/8/Q7/4K3 w - - 0 1"

# History reconstruction case (--use-uci-history semantics).
HISTORY_BASE = START
HISTORY_MOVES = ["e2e4", "e7e5"]
HISTORY_RESOLVED_FEN = "rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2"

# Terminal positions.
FOOLS_MATE_WHITE_MATED = "rnb1kbnr/pppp1ppp/8/4p3/6Pq/5P2/PPPPP2P/RNBQKBNR w KQkq - 1 3"
STALEMATE_BLACK_TO_MOVE = "7k/5Q2/6K1/8/8/8/8/8 b - - 0 1"

BASIC = {
    "START": START,
    "CASTLING": CASTLING,
    "PROMOTION": PROMOTION,
    "ENDGAME": ENDGAME,
    "MIDDLEGAME": MIDDLEGAME,
}

# Observed top-1 for Maia3-5M @2400/2400, temperature 0 (see docs/HANDOFF.md).
EXPECTED_TOP1 = {
    "START": {"e2e4", "d2d4", "g1f3", "c2c4"},
    "CASTLING": {"e1g1", "d2d3", "c2c3", "b1c3"},
    "PROMOTION": {"b7b8q"},
    "ENDGAME": {"e1e2", "e1f2", "g2g4", "g2g3"},
    "MIDDLEGAME": {"c1g5", "c1e3", "f1c4", "f1e2", "f2f3"},
}
EXPECTED_TOP1_HISTORY = {"g1f3", "b1c3"}

# Cases compared against the real `maia3-uci` CLI (golden test + golden_report).
GOLDEN_CASES = (
    {"name": "startpos", "fen": None, "moves": None},
    {"name": "castling", "fen": CASTLING, "moves": None},
    {"name": "promotion", "fen": PROMOTION, "moves": None},
    {"name": "endgame", "fen": ENDGAME, "moves": None},
    {"name": "middlegame", "fen": MIDDLEGAME, "moves": None},
    {"name": "history: startpos + e2e4 e7e5", "fen": None, "moves": ["e2e4", "e7e5"]},
)

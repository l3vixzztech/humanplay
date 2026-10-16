/**
 * Pure move-history logic for the chess.com DOM adapter (M3).
 * ==========================================================
 *
 * chess.com's own move list is the source of truth for the *history* of a game
 * (the board DOM is the source of truth for the *position*; see
 * `chesscom-adapter.js` for the reconciliation). This module turns the SAN
 * tokens found in the move-list DOM into the two things the rest of the
 * pipeline needs, using the vendored chess.js rules engine:
 *
 *   replaySanList(sanList) -> {
 *     ok, movesUci: ["e2e4", "e7e8q", …], fen: "<exact FEN after the last move>"
 *   }
 *
 * Replaying from the initial position is what reconstructs castling rights,
 * the en-passant square, the halfmove clock and the fullmove number exactly —
 * the board DOM alone cannot provide them. It also *validates* the history:
 * every SAN token must be legal in the position it appears in, otherwise the
 * caller reports a mismatch instead of guessing.
 *
 * The module is PURE (no DOM, no `chrome.*`) and imports only the vendored
 * chess.js ES module, so the content script and Node (`test/tools/adapter-unit.mjs`)
 * run the identical code.
 */

import { Chess, validateFen } from "../../vendor/chess.js";

export const INITIAL_FEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

export { validateFen };

/** Leading move numbers: "1." / "12..." / "3.." (attached or standalone). */
const NUMBER_PREFIX = /^\d+\.{1,3}/;
/** Move-list timestamps such as "0.8s" (chess.com renders these per ply). */
const TIME_TOKEN = /^\d+(?:\.\d+)?s$/i;
/**
 * SAN-ish token shape. Deliberately a *shape* filter (what to look at), not a
 * validator — legality is decided by the rules engine during replay. Covers
 * pawn moves, captures, pieces with file/rank disambiguation, castling with
 * 'O' or '0', and promotions with or without '='.
 */
const SAN_SHAPE =
  /^(?:[KQRBN][a-h1-8]{0,2}x?[a-h][1-8]|[a-h](?:x[a-h])?[1-8]=?[QRBN]?|O-O(?:-O)?)$/;

/**
 * One raw DOM text fragment → SAN token, or null when it is not a move.
 * Handles move numbers ("1.", "12...e5"), decorations ("Nf3+", "exd5!?"),
 * castling written with zeros ("0-0"), the "e.p." suffix and timestamp text.
 */
export function normalizeSanToken(raw) {
  if (typeof raw !== "string") return null;
  let token = raw.trim();
  if (!token) return null;
  token = token.replace(NUMBER_PREFIX, "").trim();
  if (!token) return null;
  if (TIME_TOKEN.test(token)) return null;
  token = token.replace(/[+#?!]+$/g, ""); // decorations + check/mate markers
  token = token.replace(/e\.p\.?$/i, ""); // "exd6 e.p."
  if (token === "0-0") token = "O-O";
  else if (token === "0-0-0") token = "O-O-O";
  if (!SAN_SHAPE.test(token)) return null;
  return token;
}

/**
 * SAN tokens from the text contents of the move-list nodes, in order.
 * Node text is what chess.com puts in `.node-highlight-content`
 * (e.g. "d4 ") or, for older layouts, the whole node ("1. d4").
 * @param {string[]} texts
 * @returns {string[]}
 */
export function sanTokensFromNodeTexts(texts) {
  const tokens = [];
  for (const text of texts ?? []) {
    for (const raw of String(text ?? "").split(/\s+/)) {
      const token = normalizeSanToken(raw);
      if (token) tokens.push(token);
    }
  }
  return tokens;
}

/**
 * Replay a SAN list from `startFen` (standard initial position by default).
 *
 * @param {string[]} sanList
 * @param {{startFen?: string}} [options]
 * @returns {{ok:true, movesUci:string[], sans:string[], fen:string, failedAt:null}
 *         | {ok:false, error:string, movesUci:string[], sans:string[],
 *            fen:string, failedAt:number}}
 */
export function replaySanList(sanList, { startFen = INITIAL_FEN } = {}) {
  const startCheck = validateFen(startFen);
  if (!startCheck.ok) {
    return { ok: false, error: `invalid start FEN: ${startCheck.error}`, movesUci: [], sans: [], fen: startFen, failedAt: 0 };
  }
  const chess = new Chess(startFen);
  const movesUci = [];
  const sans = [];
  for (let index = 0; index < (sanList?.length ?? 0); index += 1) {
    const san = sanList[index];
    let move = null;
    try {
      move = chess.move(san); // throws (or returns null) on illegal/unparsable SAN
    } catch {
      move = null;
    }
    if (!move) {
      return {
        ok: false,
        error: `history is not legal: "${san}" cannot be played at ply ${index + 1} of "${chess.fen()}"`,
        movesUci,
        sans,
        fen: chess.fen(),
        failedAt: index + 1,
      };
    }
    movesUci.push(`${move.from}${move.to}${move.promotion ?? ""}`);
    sans.push(move.san);
  }
  return { ok: true, movesUci, sans, fen: chess.fen(), failedAt: null };
}

/** Split a FEN into its six fields (missing trailing fields stay undefined). */
export function fenFields(fen) {
  const [board = "", turn = "", castling = "", enPassant = "", halfmove = "", fullmove = ""] =
    String(fen ?? "").trim().split(/\s+/);
  return { board, turn, castling, enPassant, halfmove, fullmove };
}

/** Board field (piece placement, rank 8 first) of a FEN. */
export function fenBoardField(fen) {
  return fenFields(fen).board;
}

/**
 * Build a FEN from fields, with sane defaults. Used when the adapter can read
 * the board placement but NOT the full game state (no move list, no board-exposed
 * FEN): the metadata fields are then unknown and the caller flags that state as
 * degraded instead of pretending it is exact.
 */
export function buildFen({ board, turn = "w", castling = "-", enPassant = "-", halfmove = "0", fullmove = "1" }) {
  return `${board} ${turn} ${castling} ${enPassant} ${halfmove} ${fullmove}`;
}

/** Side to move ("w"/"b") after `ply` half-moves from the initial position. */
export function sideToMoveFromPly(ply) {
  return Number(ply) % 2 === 0 ? "w" : "b";
}

/** Fullmove number after `ply` half-moves from the initial position. */
export function fullmoveFromPly(ply) {
  return String(Math.floor(Number(ply) / 2) + 1);
}

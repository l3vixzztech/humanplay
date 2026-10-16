/**
 * Pure parsing helpers for the chess.com DOM adapter (M3).
 * =======================================================
 *
 * Everything in this file is a PURE function over plain data (class-token
 * arrays, square records, URLs) — no DOM, no `chrome.*`, no imports. That lets
 * the browser content script and the zero-dep Node unit test
 * (`test/tools/adapter-unit.mjs`) run the exact same code.
 *
 * Encoding verified against live chess.com (2026-10, Chrome for Testing, see
 * `test/fixtures/chesscom/README.md` for the probe evidence):
 *
 *   <div class="piece wp square-52"></div>
 *   \___________/  \/ \________/
 *     class      piece  square
 *
 * - piece code: `wp wn wb wr wq wk bp bn bb br bq bk` (any class-token order;
 *   observed both `piece wp square-52` and `piece square-38 br`),
 * - square: `square-XY` with **X = file** (a=1 … h=8) and **Y = rank**
 *   (1 … 8), so `square-52` is e2 and `square-88` is h8. The encoding does NOT
 *   depend on board orientation — a flipped board keeps absolute squares
 *   (verified: `wc-chess-board.board.flipped` still has `piece br square-88`).
 */

/** chess.com piece codes → FEN letter (white uppercase, black lowercase). */
const PIECE_CODES = Object.freeze({
  wp: "P", wn: "N", wb: "B", wr: "R", wq: "Q", wk: "K",
  bp: "p", bn: "n", bb: "b", br: "r", bq: "q", bk: "k",
});

/** Descriptive fallback codes ("white-pawn") seen in other board renderers. */
const PIECE_WORDS = Object.freeze({
  pawn: "p", knight: "n", bishop: "b", rook: "r", queen: "q", king: "k",
});

const FILE_CHARS = "abcdefgh";

/**
 * FEN letter of the first class token that encodes a piece, or null.
 * @param {string[]} tokens class tokens (or any candidate strings)
 */
export function pieceCodeFromTokens(tokens) {
  if (!Array.isArray(tokens)) return null;
  for (const token of tokens) {
    const direct = PIECE_CODES[token];
    if (direct) return direct;
  }
  for (const token of tokens) {
    const match = /^(white|black)[-_](pawn|knight|bishop|rook|queen|king)$/.exec(token);
    if (match) {
      const code = PIECE_WORDS[match[2]];
      return match[1] === "white" ? code.toUpperCase() : code;
    }
  }
  return null;
}

/**
 * {file, rank} (both 0-based, file a=0, rank 1=0) of the first class token
 * that encodes a square, or null. Accepts the chess.com `square-XY` digit form
 * and the generic `square-e4` form.
 * @param {string[]} tokens
 */
export function squareFromTokens(tokens) {
  if (!Array.isArray(tokens)) return null;
  for (const token of tokens) {
    const digits = /^square-([1-8])([1-8])$/.exec(token);
    if (digits) return { file: Number(digits[1]) - 1, rank: Number(digits[2]) - 1, raw: token };
    const alnum = /^square-([a-h])([1-8])$/.exec(token);
    if (alnum) return { file: alnum[1].charCodeAt(0) - 97, rank: Number(alnum[2]) - 1, raw: token };
  }
  return null;
}

/** "e2" for file 4 / rank 1 (0-based inputs). */
export function squareName(file, rank) {
  return `${FILE_CHARS[file] ?? "?"}${rank + 1}`;
}

/**
 * FEN board field (rank 8 first) for a list of {code, file, rank} records.
 * @param {{code:string, file:number, rank:number}[]} squares
 */
export function boardFieldFromSquares(squares) {
  // grid[rank][file], rank 0 = chess rank 1 (FEN writes rank 8 first).
  const grid = Array.from({ length: 8 }, () => Array(8).fill(""));
  for (const square of squares ?? []) {
    if (!square?.code) continue;
    if (square.file < 0 || square.file > 7 || square.rank < 0 || square.rank > 7) continue;
    grid[square.rank][square.file] = square.code;
  }
  const ranks = [];
  for (let rank = 7; rank >= 0; rank--) {
    let out = "";
    let empty = 0;
    for (let file = 0; file < 8; file++) {
      const code = grid[rank][file];
      if (!code) {
        empty += 1;
        continue;
      }
      if (empty > 0) {
        out += empty;
        empty = 0;
      }
      out += code;
    }
    if (empty > 0) out += empty;
    ranks.push(out);
  }
  return ranks.join("/");
}

/**
 * Plausibility check of a piece placement read from the DOM. This is the
 * adapter's *empirical verification*: a strategy that parses cleanly but
 * produces an impossible position (duplicate squares, missing kings, pawns on
 * rank 1/8, …) is rejected and the next strategy is tried.
 *
 * @param {{code:string, file:number, rank:number}[]} squares
 * @returns {{ok:boolean, problems:string[]}}
 */
export function checkPlacement(squares) {
  const problems = [];
  const list = Array.isArray(squares) ? squares : [];
  if (list.length === 0) return { ok: false, problems: ["no pieces found"] };
  if (list.length > 32) problems.push(`${list.length} pieces is more than a chess game can hold`);

  const occupied = new Map();
  for (const square of list) {
    if (!square?.code) {
      problems.push("piece without a FEN code");
      continue;
    }
    if (square.file < 0 || square.file > 7 || square.rank < 0 || square.rank > 7) {
      problems.push(`piece ${square.code} outside the board (${square.file},${square.rank})`);
      continue;
    }
    const key = `${square.file},${square.rank}`;
    if (occupied.has(key)) problems.push(`two pieces on ${squareName(square.file, square.rank)}`);
    else occupied.set(key, square);
    if ((square.code === "P" || square.code === "p") && (square.rank === 0 || square.rank === 7)) {
      problems.push(`pawn on ${squareName(square.file, square.rank)} (rank ${square.rank + 1})`);
    }
  }

  const codes = list.map((square) => square?.code ?? "").join("");
  const count = (source, re) => (source.match(re) ?? []).length;
  const whiteKings = count(codes, /K/g);
  const blackKings = count(codes, /k/g);
  if (whiteKings !== 1) problems.push(`expected exactly one white king, found ${whiteKings}`);
  if (blackKings !== 1) problems.push(`expected exactly one black king, found ${blackKings}`);
  const whitePieces = count(codes, /[PNBRQK]/g);
  const blackPieces = count(codes, /[pnbrqk]/g);
  if (whitePieces > 16) problems.push(`${whitePieces} white pieces (max 16)`);
  if (blackPieces > 16) problems.push(`${blackPieces} black pieces (max 16)`);

  return { ok: problems.length === 0, problems };
}

/**
 * gameId for the state protocol, derived from the URL path. Known forms
 * (verified 2026-10):
 *   /game/live/186394589423      -> "live/186394589423"
 *   /game/daily/12345            -> "daily/12345"
 *   /play/computer               -> "play/computer"
 *   /play/online                 -> "play/online"
 * Anything else (home, analysis, fixture pages…) -> null.
 */
export function gameIdFromUrl(url) {
  let pathname;
  try {
    pathname = new URL(String(url), "https://www.chess.com/").pathname;
  } catch {
    return null;
  }
  let match = /^\/game\/(live|daily)\/(\d+)/.exec(pathname);
  if (match) return `${match[1]}/${match[2]}`;
  match = /^\/play\/(computer|online)/.exec(pathname);
  if (match) return `play/${match[1]}`;
  return null;
}

/** Normalise "white"/"w"/"WHITE" → "white"; anything else → null. */
export function normalizeColor(value) {
  const text = String(value ?? "").trim().toLowerCase();
  if (text === "white" || text === "w") return "white";
  if (text === "black" || text === "b") return "black";
  return null;
}

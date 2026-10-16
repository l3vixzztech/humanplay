#!/usr/bin/env node
/**
 * adapter-unit.mjs — zero-dep unit tests for the chess.com adapter's pure logic.
 *
 * Runs in plain Node (no test framework, no packages): it imports the **exact
 * files** the content script loads at runtime —
 *
 *     extension/src/content/move-history.js   (SAN list -> UCI + exact FEN)
 *     extension/src/content/board-dom.js      (chess.com class parsing)
 *     extension/vendor/chess.js               (BSD-2-Clause, pinned 1.4.0)
 *
 * The FEN expectations are hardcoded from python-chess (server venv), i.e. a
 * second, independent rules implementation — the same values also live in the
 * offline fixtures' ground truth (test/fixtures/chesscom/). If the two engines
 * ever disagree about a convention, this test must decide which is right first.
 *
 * Usage:
 *   node test/tools/adapter-unit.mjs          # exit code 0 = all passed
 */

import {
  normalizeSanToken,
  sanTokensFromNodeTexts,
  replaySanList,
  replaySanListResilient,
  turnFromHighlightPieces,
  findMovesToBoardField,
  applyUciToFen,
  seedCastlingRights,
  fenFields,
  fenBoardField,
  sideToMoveFromPly,
  fullmoveFromPly,
} from "../../extension/src/content/move-history.js";
import {
  pieceCodeFromTokens,
  squareFromTokens,
  boardFieldFromSquares,
  checkPlacement,
  gameIdFromUrl,
  normalizeColor,
} from "../../extension/src/content/board-dom.js";

/* --------------------------------------------------------------- harness */

let passed = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`ok   ${name}`);
  } catch (error) {
    failures.push({ name, message: error?.message ?? String(error) });
    console.log(`FAIL ${name}\n     ${error?.message ?? error}`);
  }
}

function eq(actual, expected, label = "") {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) throw new Error(`${label}${label ? ": " : ""}expected ${b}, got ${a}`);
}

function ok(value, label = "value") {
  if (!value) throw new Error(`${label} should be truthy, got ${JSON.stringify(value)}`);
}

/* ---------------------------------------------------------------- helpers */

const FEN_PIECES = { P: "P", N: "N", B: "B", R: "R", Q: "Q", K: "K", p: "p", n: "n", b: "b", r: "r", q: "q", k: "k" };

/** Parse a FEN board field into the adapter's {code, file, rank} records. */
function squaresFromFenBoard(boardField) {
  const squares = [];
  const ranks = boardField.split("/");
  ranks.forEach((rankText, rowIndex) => {
    let file = 0;
    for (const char of rankText) {
      if (/\d/.test(char)) {
        file += Number(char);
        continue;
      }
      if (FEN_PIECES[char]) squares.push({ code: char, file, rank: 7 - rowIndex });
      file += 1;
    }
  });
  return squares;
}

const STARTPOS_BOARD = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR";
const MIDDLEGAME_FEN = "r1b2rk1/ppp2ppp/2np1q2/2b1p3/2B1P3/3P1N2/PPP2PPP/RN1Q1RK1 w - - 0 8";
const MIDDLEGAME_UCI = ["e2e4", "e7e5", "g1f3", "b8c6", "f1c4", "f8c5", "e1g1", "g8f6", "d2d3", "d7d6", "c1g5", "e8g8", "g5f6", "d8f6"];
const FLIPPED_FEN = "rnbqkbnr/pp2pppp/3p4/2p5/4P3/5N2/PPPP1PPP/RNBQKB1R w KQkq - 0 3";
const FLIPPED_UCI = ["e2e4", "c7c5", "g1f3", "d7d6"];

/* ------------------------------------------------------- SAN tokenizing */

test("normalizeSanToken: plain moves, decorations, numbers, timestamps", () => {
  eq(normalizeSanToken("d4"), "d4");
  eq(normalizeSanToken("Nf3+"), "Nf3");
  eq(normalizeSanToken("exd5!?"), "exd5");
  eq(normalizeSanToken("Qh4#"), "Qh4");
  eq(normalizeSanToken("Nbd2"), "Nbd2");
  eq(normalizeSanToken("R1e2"), "R1e2");
  eq(normalizeSanToken("Qh4e1"), "Qh4e1");
  eq(normalizeSanToken("e8=Q#"), "e8=Q");
  eq(normalizeSanToken("e8Q"), "e8Q");
  eq(normalizeSanToken("1.e4"), "e4");
  eq(normalizeSanToken("1...e5"), "e5");
  eq(normalizeSanToken("12."), null);
  eq(normalizeSanToken("1..."), null);
  eq(normalizeSanToken("..."), null);
  eq(normalizeSanToken("0.8s"), null);
  eq(normalizeSanToken(""), null);
  eq(normalizeSanToken(undefined), null);
  eq(normalizeSanToken("Game"), null);
  eq(normalizeSanToken("resigned"), null);
});

test("normalizeSanToken: castling variants", () => {
  eq(normalizeSanToken("O-O"), "O-O");
  eq(normalizeSanToken("O-O-O"), "O-O-O");
  eq(normalizeSanToken("0-0"), "O-O");
  eq(normalizeSanToken("0-0-0+"), "O-O-O");
});

test("sanTokensFromNodeTexts: real 2026 chess.com node spans", () => {
  eq(sanTokensFromNodeTexts(["d4 ", "Nf6 ", "Nf3 ", "e6 "]), ["d4", "Nf6", "Nf3", "e6"]);
});

test("sanTokensFromNodeTexts: whole-row text with numbers and timestamps", () => {
  eq(sanTokensFromNodeTexts(["1. d4 Nf6 0.1s 0.8s 2. Nf3 e6 0.7s 4.7s"]), ["d4", "Nf6", "Nf3", "e6"]);
});

test("sanTokensFromNodeTexts: older vertical-list node texts", () => {
  eq(sanTokensFromNodeTexts(["1...", "e5", "2.", "Nf3", "O-O"]), ["e5", "Nf3", "O-O"]);
});

test("sanTokensFromNodeTexts: junk is dropped, not guessed", () => {
  eq(sanTokensFromNodeTexts(["Game over", "White resigned", ""]), []);
});

/* ----------------------------------------------------- SAN list -> UCI/FEN */

test("replaySanList: empty list -> exact start position", () => {
  const result = replaySanList([]);
  eq(result.ok, true);
  eq(result.fen, "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1");
  eq(result.movesUci, []);
});

test("replaySanList: middlegame with castling + captures (fixture expectation)", () => {
  const san = ["e4", "e5", "Nf3", "Nc6", "Bc4", "Bc5", "O-O", "Nf6", "d3", "d6", "Bg5", "O-O", "Bxf6", "Qxf6"];
  const result = replaySanList(san);
  eq(result.ok, true, "replay ok");
  eq(result.fen, MIDDLEGAME_FEN, "fen");
  eq(result.movesUci, MIDDLEGAME_UCI, "uci");
});

test("replaySanList: flipped-black fixture (Sicilian) expectation", () => {
  const result = replaySanList(["e4", "c5", "Nf3", "d6"]);
  eq(result.ok, true);
  eq(result.fen, FLIPPED_FEN);
  eq(result.movesUci, FLIPPED_UCI);
});

test("replaySanList: castling written with zeros is accepted", () => {
  const sans = ["e4", "e5", "Nf3", "Nc6", "Bc4", "Bc5", "0-0", "Nf6", "d3", "0-0"];
  const result = replaySanList(sans.map(normalizeSanToken));
  eq(result.ok, true);
  eq(result.fen, "r1bq1rk1/pppp1ppp/2n2n2/2b1p3/2B1P3/3P1N2/PPP2PPP/RNBQ1RK1 w - - 1 6");
  eq(result.movesUci[6], "e1g1");
  eq(result.movesUci[9], "e8g8");
});

test("replaySanList: en passant (exact ep square + UCI)", () => {
  const result = replaySanList(["e4", "a6", "e5", "d5", "exd6"]);
  eq(result.ok, true);
  eq(result.fen, "rnbqkbnr/1pp1pppp/p2P4/8/8/8/PPPP1PPP/RNBQKBNR b KQkq - 0 3");
  eq(result.movesUci[4], "e5d6");
});

test("replaySanList: promotion, '=Q' and bare 'Q' notation", () => {
  const startFen = "8/2P5/8/8/8/8/8/K6k w - - 0 1";
  for (const san of ["c8=Q", "c8Q"]) {
    const result = replaySanList([san], { startFen });
    eq(result.ok, true, san);
    eq(result.movesUci, ["c7c8q"], san);
    eq(result.fen, "2Q5/8/8/8/8/8/8/K6k b - - 0 1", san);
  }
});

test("replaySanList: illegal history fails loudly (board becomes source of truth)", () => {
  const result = replaySanList(["e4", "e5", "Qd5"]);
  eq(result.ok, false);
  eq(result.failedAt, 3);
  ok(/cannot be played at ply 3/.test(result.error), "error text");
  eq(result.movesUci, ["e2e4", "e7e5"]);
});

test("replaySanList: invalid start FEN is rejected", () => {
  const result = replaySanList(["e4"], { startFen: "not a fen" });
  eq(result.ok, false);
  eq(result.failedAt, 0);
});

/* ------------------------------------------------------------ FEN helpers */

test("fenFields / fenBoardField / ply helpers", () => {
  eq(fenFields(MIDDLEGAME_FEN).turn, "w");
  eq(fenFields(MIDDLEGAME_FEN).fullmove, "8");
  eq(fenBoardField(MIDDLEGAME_FEN), "r1b2rk1/ppp2ppp/2np1q2/2b1p3/2B1P3/3P1N2/PPP2PPP/RN1Q1RK1");
  eq(sideToMoveFromPly(0), "w");
  eq(sideToMoveFromPly(1), "b");
  eq(sideToMoveFromPly(14), "w");
  eq(fullmoveFromPly(0), "1");
  eq(fullmoveFromPly(13), "7");
});

/* --------------------------------------------------------- board parsing */

test("pieceCodeFromTokens: both observed class orders", () => {
  eq(pieceCodeFromTokens(["piece", "wp", "square-52"]), "P");
  eq(pieceCodeFromTokens(["piece", "square-38", "br"]), "r");
  eq(pieceCodeFromTokens(["piece", "bk", "square-58"]), "k");
  eq(pieceCodeFromTokens(["piece"]), null);
  eq(pieceCodeFromTokens([]), null);
  eq(pieceCodeFromTokens(["white-knight"]), "N");
  eq(pieceCodeFromTokens(["black-rook"]), "r");
});

test("squareFromTokens: chess.com file-first encoding + generic form", () => {
  eq(squareFromTokens(["piece", "wp", "square-52"]), { file: 4, rank: 1, raw: "square-52" }); // e2
  eq(squareFromTokens(["piece", "square-88"]), { file: 7, rank: 7, raw: "square-88" }); // h8
  eq(squareFromTokens(["square-11"]), { file: 0, rank: 0, raw: "square-11" }); // a1
  eq(squareFromTokens(["square-e4"]), { file: 4, rank: 3, raw: "square-e4" });
  eq(squareFromTokens(["square-99"]), null);
  eq(squareFromTokens(["piece", "wp"]), null);
});

test("boardFieldFromSquares: start position round-trips", () => {
  const squares = squaresFromFenBoard(STARTPOS_BOARD);
  eq(squares.length, 32);
  eq(boardFieldFromSquares(squares), STARTPOS_BOARD);
  eq(boardFieldFromSquares([]), "8/8/8/8/8/8/8/8");
});

test("boardFieldFromSquares: middlegame + flipped fixtures round-trip", () => {
  eq(boardFieldFromSquares(squaresFromFenBoard(fenBoardField(MIDDLEGAME_FEN))), fenBoardField(MIDDLEGAME_FEN));
  eq(boardFieldFromSquares(squaresFromFenBoard(fenBoardField(FLIPPED_FEN))), fenBoardField(FLIPPED_FEN));
});

test("checkPlacement: accepts real positions, rejects impossible ones", () => {
  eq(checkPlacement(squaresFromFenBoard(STARTPOS_BOARD)).ok, true);
  eq(checkPlacement(squaresFromFenBoard(fenBoardField(MIDDLEGAME_FEN))).ok, true);

  const duplicate = [...squaresFromFenBoard(STARTPOS_BOARD), { code: "P", file: 4, rank: 1 }];
  eq(checkPlacement(duplicate).ok, false, "duplicate square");

  const missingKing = squaresFromFenBoard(STARTPOS_BOARD).filter((square) => square.code !== "K");
  eq(checkPlacement(missingKing).ok, false, "missing king");

  const pawnOnFirst = [...squaresFromFenBoard(STARTPOS_BOARD).filter((square) => square.code !== "P"), { code: "P", file: 4, rank: 0 }];
  eq(checkPlacement(pawnOnFirst).ok, false, "pawn on rank 1");

  const pawnOnEighth = [...squaresFromFenBoard(STARTPOS_BOARD).filter((square) => square.code !== "P"), { code: "p", file: 4, rank: 7 }];
  eq(checkPlacement(pawnOnEighth).ok, false, "pawn on rank 8");

  const tooMany = squaresFromFenBoard("QQQQKQQQ/QQQQQQQQ/8/8/8/8/8/QQQQkQQQ");
  eq(checkPlacement(tooMany).ok, false, "17+ white pieces");

  eq(checkPlacement([]).ok, false, "empty board");
});

/* ------------------------------------------------------------- URL/color */

test("gameIdFromUrl: real chess.com URL forms", () => {
  eq(gameIdFromUrl("https://www.chess.com/game/live/186394589423"), "live/186394589423");
  eq(gameIdFromUrl("https://www.chess.com/game/live/186394589423?ref=home"), "live/186394589423");
  eq(gameIdFromUrl("https://www.chess.com/game/daily/12345"), "daily/12345");
  eq(gameIdFromUrl("https://www.chess.com/play/computer"), "play/computer");
  eq(gameIdFromUrl("https://chess.com/play/online"), "play/online");
  eq(gameIdFromUrl("https://www.chess.com/analysis"), null);
  eq(gameIdFromUrl("https://www.chess.com/"), null);
  eq(gameIdFromUrl("http://127.0.0.1:8765/chesscom/startpos.html"), null);
  eq(gameIdFromUrl("not a url"), null);
});

test("normalizeColor", () => {
  eq(normalizeColor("white"), "white");
  eq(normalizeColor("W"), "white");
  eq(normalizeColor("BLACK"), "black");
  eq(normalizeColor("b"), "black");
  eq(normalizeColor("red"), null);
  eq(normalizeColor(undefined), null);
});

/* ------------------------------------- M9.1: resilient replay (DOM repair) */

test("replaySanListResilient: skips a duplicated SAN token, keeps the rest exact", () => {
  const result = replaySanListResilient(["e4", "e5", "Nf3", "Nc6", "Bc4", "Bc5", "Bc5"]);
  eq(result.ok, true, "ok");
  eq(result.movesUci, ["e2e4", "e7e5", "g1f3", "b8c6", "f1c4", "f8c5"], "movesUci");
  eq(result.skipped.map((entry) => entry.san), ["Bc5"], "skipped tokens");
  eq(result.skipped[0].index, 6, "skipped index");
  // The repaired end position must equal the clean 6-move replay exactly.
  const clean = replaySanList(["e4", "e5", "Nf3", "Nc6", "Bc4", "Bc5"]);
  eq(result.fen, clean.fen, "repaired fen equals the clean replay");
});

test("replaySanListResilient: a clean list equals replaySanList exactly", () => {
  const list = ["e4", "e5", "Nf3", "Nc6"];
  const resilient = replaySanListResilient(list);
  const exact = replaySanList(list);
  eq(resilient.ok, true, "ok");
  eq(resilient.skipped, [], "no skips");
  eq(resilient.movesUci, exact.movesUci, "movesUci");
  eq(resilient.fen, exact.fen, "fen");
});

test("replaySanListResilient: a mid-list artifact keeps the tail playable", () => {
  const result = replaySanListResilient(["e4", "e5", "Nf9", "Nf3", "Nc6"]);
  eq(result.ok, true, "ok");
  eq(result.skipped.map((entry) => entry.san), ["Nf9"], "skipped tokens");
  eq(result.movesUci, ["e2e4", "e7e5", "g1f3", "b8c6"], "tail kept after the artifact");
});

test("replaySanListResilient: all tokens unreadable -> not ok", () => {
  const result = replaySanListResilient(["Nf9", "Qz9"]);
  eq(result.ok, false, "ok");
  eq(result.movesUci, [], "no moves");
  eq(result.skipped.length, 2, "both skipped");
  ok(result.error, "error present");
});

test("replaySanListResilient: an empty list is a valid startpos", () => {
  const result = replaySanListResilient([]);
  eq(result.ok, true, "ok");
  eq(result.fen, "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1", "startpos fen");
});

/* ------------------------------------ M9.2: highlight turn + board tracking */

test("turnFromHighlightPieces: exactly one colour on the highlight -> other side moves", () => {
  eq(turnFromHighlightPieces(["white"]), "b", "white just moved");
  eq(turnFromHighlightPieces(["black"]), "w", "black just moved");
  eq(turnFromHighlightPieces([null, "white"]), "b", "nulls ignored");
  eq(turnFromHighlightPieces(["white", "black"]), null, "two colours -> ambiguous");
  eq(turnFromHighlightPieces([]), null, "no pieces -> unknown");
  eq(turnFromHighlightPieces(undefined), null, "missing -> unknown");
});

test("seedCastlingRights: granted only while king + rook are home", () => {
  eq(seedCastlingRights("rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR"), "KQkq", "startpos");
  eq(
    seedCastlingRights("r1bq1knr/pppp1ppp/2n5/2b1p3/2B1P3/5N2/PPPP1PPP/RNBQK2R"),
    "KQ",
    "castling position: white keeps both, black king has left e8",
  );
  eq(seedCastlingRights("r1b2rk1/ppp2ppp/2np1q2/2b1p3/2B1P3/3P1N2/PPP2PPP/RN1Q1RK1"), "-", "both kings moved");
  eq(seedCastlingRights("garbage"), "-", "malformed board field");
});

test("findMovesToBoardField: unique explaining move from the placement diff", () => {
  const start = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
  eq(findMovesToBoardField(start, "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR"), ["e2e4"], "1.e4 unique");
  eq(findMovesToBoardField("not a fen", "8/8/8/8/8/8/8/8"), null, "invalid fen -> null");
});

test("findMovesToBoardField: en passant needs the ep square in the FEN", () => {
  const withEp = "rnbqkbnr/ppp1p1pp/8/3pPp2/8/8/PPPP1PPP/RNBQKBNR w KQkq f6 0 3";
  const withoutEp = "rnbqkbnr/ppp1p1pp/8/3pPp2/8/8/PPPP1PPP/RNBQKBNR w KQkq - 0 3";
  const target = "rnbqkbnr/ppp1p1pp/5P2/3p4/8/8/PPPP1PPP/RNBQKBNR";
  eq(findMovesToBoardField(withEp, target), ["e5f6"], "ep capture found when the ep square is set");
  eq(findMovesToBoardField(withoutEp, target), [], "no match without the ep square (tracker re-seeds)");
});

test("applyUciToFen: legal move applies, illegal is rejected", () => {
  const start = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
  const applied = applyUciToFen(start, "e2e4");
  eq(applied.ok, true, "ok");
  eq(applied.fen, "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1", "fen after 1.e4");
  eq(applyUciToFen(start, "e2e5").ok, false, "illegal move rejected");
});

/* ------------------------------------------------------------------ done */

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length > 0) {
  console.log("failures:");
  for (const failure of failures) console.log(` - ${failure.name}: ${failure.message}`);
  process.exitCode = 1;
}

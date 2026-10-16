/**
 * humanplay — SAN/UCI -> spoken move text (Milestone 6, deliverable 1)
 * =====================================================================
 *
 * Pure, zero-dependency, Node-testable: the same file runs in the side panel
 * (ES module) and in the zero-dep unit tests (test/tools/tts-unit.mjs).
 *
 * Target phrasing ("just the move" — no probabilities, no commentary):
 *
 *   Nf3      -> "Knight to f3"
 *   exd5     -> "e-pawn takes d5"
 *   O-O      -> "Castle kingside"
 *   O-O-O    -> "Castle queenside"
 *   e8=Q+    -> "Promote to queen on e8, check"
 *   gxh8=N#  -> "g-pawn takes h8, promote to knight, mate"
 *   Nbd2     -> "b-knight to d2"            (file disambiguation)
 *   R1e2     -> "rook one to e2"            (rank disambiguation)
 *   Bxh7+    -> "Bishop takes h7, check"
 *   (unparseable SAN, UCI available) -> "move e2 to e4" / "move e7 to e8, promote to queen"
 *
 * Rules
 * -----
 * - `+` -> ", check", `#` -> ", mate"; both are appended as the last clause.
 * - Annotation glyphs (`!`, `?`) and an en-passant marker (` e.p.` / ` e.p`) are
 *   stripped. En passant reads exactly like a pawn capture ("e-pawn takes d6") —
 *   SAN does not distinguish it and a spoken "en passant" would add nothing.
 * - Castling accepts `O-O`/`0-0` (and odd dash variants) with the check/mate
 *   suffixes.
 * - Piece names are Capitalized when they start the sentence ("Knight to f3")
 *   and lowercase behind a disambiguator ("b-knight to d2", "rook one to e2") —
 *   that is the phrasing agreed for M6.
 * - A pawn capture always carries the from-file in SAN ("exd5"), spoken
 *   "e-pawn takes d5"; quiet pawn moves are "e-pawn to e4".
 * - Promotion: "Promote to queen on e8" (quiet) or "<x>-pawn takes <sq>,
 *   promote to <piece>" (capture). A promoted knight is "knight" (lowercase)
 *   because it never starts the sentence in the capture form.
 * - `sanToSpeech()` returns `null` for anything it cannot parse (including
 *   UCI-looking strings — those are handled by `uciToSpeech()`), so callers can
 *   fall back safely and never speak garbage.
 * - `sanToSpeech` is a *formatter*, not a legality checker: it validates the
 *   notation shape, not the position.
 */

/** Sentence-leading piece names. */
export const PIECE_NAMES = Object.freeze({
  K: "King",
  Q: "Queen",
  R: "Rook",
  B: "Bishop",
  N: "Knight",
  P: "Pawn",
});

/** Rank disambiguation, e.g. "R1e2" -> "rook one to e2". */
export const RANK_WORDS = Object.freeze(["one", "two", "three", "four", "five", "six", "seven", "eight"]);

/** Promotions are always spelled lowercase ("promote to queen"). */
export const PROMOTION_NAMES = Object.freeze({
  q: "queen",
  r: "rook",
  b: "bishop",
  n: "knight",
  k: "king",
});

/** "e2e4" / "e7e8q" — UCI-looking input (never treated as SAN). */
const UCI_LIKE = /^[a-h][1-8][a-h][1-8][qrbnkQRBNK]?$/;

/** Castling: O-O / 0-0 / O–O / O—O (with check/mate suffixes already stripped). */
const CASTLE_RE = /^[o0][-\u2013\u2014][o0]([-\u2013\u2014][o0])?$/i;

function isPieceLetter(char) {
  return typeof char === "string" && /^[KQRBN]$/i.test(char);
}

function pieceLabel(piece, file, rank) {
  const leading = PIECE_NAMES[piece]; // "Knight"
  const lower = leading.toLowerCase(); // "knight"
  if (file && rank) return `${lower} ${file}${rank}`; // "queen h4" (rare)
  if (file) return `${file}-${lower}`; // "b-knight"
  if (rank) return `${lower} ${RANK_WORDS[Number(rank) - 1]}`; // "rook one"
  return leading; // "Knight"
}

function compose(parts) {
  return parts.filter((part) => typeof part === "string" && part.length > 0).join(", ");
}

/**
 * SAN -> spoken text, or `null` when the input is not parseable SAN.
 *
 * @param {unknown} san e.g. "Nf3", "exd5", "O-O", "e8=Q+", "gxh8=N#", "R1e2"
 * @returns {string|null}
 */
export function sanToSpeech(san) {
  if (typeof san !== "string") return null;
  let text = san.replace(/\u00a0/g, " ").trim();
  if (!text) return null;

  text = text.replace(/[!?]+$/g, ""); // annotations: Nf3!, e4??
  text = text.replace(/\s*e\.?\s?p\.?$/i, ""); // en-passant marker
  if (!text) return null;

  let suffix = null;
  if (text.endsWith("#") || text.endsWith("\u2021")) {
    suffix = "mate";
    text = text.slice(0, -1);
  } else if (text.endsWith("++")) {
    suffix = "check";
    text = text.slice(0, -2);
  } else if (text.endsWith("+")) {
    suffix = "check";
    text = text.slice(0, -1);
  }
  if (!text) return null;

  const castle = CASTLE_RE.exec(text);
  if (castle) {
    return compose([castle[1] ? "Castle queenside" : "Castle kingside", suffix]);
  }

  // Promotion: "=Q" or (tolerantly) the piece letter right after the rank digit.
  let promotion = null;
  const promo = /(\d)\s*[=:]?\s*([qrbnQRBN])$/.exec(text);
  if (promo) {
    promotion = promo[2].toLowerCase();
    text = text.slice(0, promo.index + 1); // keep the rank digit
  }

  const destination = /([a-h][1-8])$/i.exec(text);
  if (!destination) return null;
  const dest = destination[1].toLowerCase();
  let head = text.slice(0, destination.index);

  let piece = null;
  if (head && isPieceLetter(head[0])) {
    piece = head[0].toUpperCase();
    head = head.slice(1);
  }
  let capture = false;
  if (/[x:\u00d7]/i.test(head)) {
    capture = true;
    head = head.replace(/[x:\u00d7]/gi, "");
  }
  let file = null;
  let rank = null;
  if (head) {
    const disambiguation = /^([a-h])?([1-8])?$/i.exec(head);
    if (!disambiguation || (!disambiguation[1] && !disambiguation[2])) return null;
    file = disambiguation[1] ? disambiguation[1].toLowerCase() : null;
    rank = disambiguation[2] ? disambiguation[2] : null;
  }

  if (!piece) {
    // Pawn notation: a file may only appear on a capture (the from-file), and a
    // rank never appears. "exd5" ok, "xd5"/"1d5"/"ed5" are not SAN.
    if (rank) return null;
    if (capture && !file) return null;
    if (file && !capture) return null;
  } else if (promotion) {
    return null; // promotions are pawn moves only
  }

  if (piece) {
    const label = pieceLabel(piece, file, rank);
    return compose([capture ? `${label} takes ${dest}` : `${label} to ${dest}`, suffix]);
  }

  // Pawn. On a quiet move the SAN file *is* the destination file, so "e4"
  // reads "e-pawn to e4"; on a capture the file is the from-file ("exd5").
  const label = `${file ?? dest[0]}-pawn`;
  if (promotion) {
    const promotionName = PROMOTION_NAMES[promotion];
    if (capture) {
      return compose([`${label} takes ${dest}`, `promote to ${promotionName}`, suffix]);
    }
    return compose([`Promote to ${promotionName} on ${dest}`, suffix]);
  }
  return compose([capture ? `${label} takes ${dest}` : `${label} to ${dest}`, suffix]);
}

/**
 * UCI -> spoken text, or `null`. The fallback style: "move e2 to e4"
 * (+ ", promote to queen" for "e7e8q").
 */
export function uciToSpeech(uci) {
  if (typeof uci !== "string") return null;
  const match = /^([a-h][1-8])\s*([a-h][1-8])([qrbnkQRBNK])?$/i.exec(uci.trim());
  if (!match) return null;
  const from = match[1].toLowerCase();
  const to = match[2].toLowerCase();
  const promotionName = match[3] ? PROMOTION_NAMES[match[3].toLowerCase()] : null;
  return `move ${from} to ${to}` + (promotionName ? `, promote to ${promotionName}` : "");
}

/**
 * The entry point used by the panel and the proof:
 * prefer the SAN phrasing; fall back to the UCI style ("move e2 to e4") when the
 * SAN is missing/unparseable; `null` when neither is usable (callers then stay
 * silent — never speak garbage).
 *
 * @param {string|{san?: string, uci?: string}|null} move a SAN string, a UCI
 *        string, or a `{san, uci}` object (e.g. a /analyze move).
 * @param {{san?: string|null, uci?: string|null, preferUci?: boolean}} [options]
 */
export function moveToSpeech(move, options = {}) {
  let sanValue = typeof options.san === "string" ? options.san : null;
  let uciValue = typeof options.uci === "string" ? options.uci : null;

  if (typeof move === "string") {
    const trimmed = move.trim();
    if (sanValue === null && uciValue === null) {
      if (UCI_LIKE.test(trimmed)) uciValue = trimmed;
      else sanValue = trimmed;
    }
  } else if (move && typeof move === "object") {
    if (sanValue === null && typeof move.san === "string") sanValue = move.san;
    if (uciValue === null && typeof move.uci === "string") uciValue = move.uci;
  }

  if (sanValue && UCI_LIKE.test(sanValue.trim())) {
    // A UCI string that arrived in the san field is not SAN.
    uciValue = uciValue ?? sanValue;
    sanValue = null;
  }

  const fromSan = sanToSpeech(sanValue);
  if (fromSan && options.preferUci !== true) return fromSan;
  return uciToSpeech(uciValue) ?? fromSan;
}

/**
 * M7: the premove phrasing — the M6 formatter with a "premove" prefix and a
 * lowercase verb: `Nxd5` -> "premove knight takes d5", `Nf3` -> "premove
 * knight to f3". `null` when nothing parses (the caller stays silent).
 *
 * @param {string|{san?: string, uci?: string}|null} move
 */
export function premoveSpeech(move, options = {}) {
  const text = moveToSpeech(move, options);
  if (!text) return null;
  return `premove ${text.charAt(0).toLowerCase()}${text.slice(1)}`;
}

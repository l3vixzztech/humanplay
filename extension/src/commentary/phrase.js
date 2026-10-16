/**
 * humanplay — commentary phrasing templates (Milestone 8, pure, zero-dep)
 * =======================================================================
 *
 * Turns one `/explain` fact object into ONE short, factual sentence. There is
 * **no invented chess**: every word comes from the rules flags (`capture`,
 * `check`, `mate`, `castle`, `promotion`, `enPassant`, `recapture`) and from
 * Maia's own probability numbers (`playedProb`, `rank`, `top`). No tactics, no
 * "good/bad", no engine evaluations — the classification is a probability band,
 * never a quality label. The same file runs in the side panel and in the zero-dep
 * unit tests (test/tools/commentary-unit.mjs).
 *
 * Grammar (documented; tests assert every branch)
 * -----------------------------------------------
 *
 *     <SAN> — <event clause>; <maia clause>.
 *
 * The event clause is the first applicable of (check/mate are a trailing
 * suffix: "<event>, check" / "<event>, checkmate"; `mate` implies `check`):
 *
 *     promotion to a <piece>   e.g. "e8=Q — promotion to a queen, check; …"
 *     an en passant capture
 *     a recapture / a capture on <square>
 *     castling kingside / castling queenside
 *     check / checkmate         (alone when nothing else applies)
 *     ""                        (a quiet move — no event clause)
 *
 * The Maia clause depends on the classification band (always carries Maia's
 * numbers; `<elo>` is `maia.moverElo`):
 *
 *     mainline   "the most common move at <elo> (<p>%)"
 *                — castling: "the main line"
 *                — recapture: "<p>% of <elo>s take back"
 *     common     "a common choice at <elo> (<p>%); Maia's pick was <topSan> (<topP>%)"
 *     uncommon   "uncommon at <elo> (<p>%); Maia's pick was <topSan> (<topP>%)"
 *     rare       "only <p>% play this; Maia's pick was <topSan> (<topP>%)"
 *
 * Percent format: `>= 1%` rounds to the nearest integer ("96%"), below 1% keeps
 * one decimal ("0.3%") so a rare move never reads as "0%".
 *
 * The classification chip text is `classificationChip()` (main line / common /
 * uncommon / rare — `extension/src/analysis/explain-client.js`).
 */

import { classificationChip } from "../analysis/explain-client.js";

/** A missing top[] entry must never crash the phrasing. */
const UNKNOWN_PICK = { san: "?", prob: null };

function formatPercent(probability) {
  const number = Number(probability);
  if (!Number.isFinite(number)) return "?%";
  const percent = number * 100;
  if (percent < 1) return `${percent.toFixed(1)}%`;
  return `${Math.round(percent)}%`;
}

/** `<SAN> — promotion to a queen, check; the main line.` */
export function eventClause(flags = {}, material = {}) {
  const suffix = flags.mate ? "checkmate" : flags.check ? "check" : null;
  let base = null;
  if (flags.promotion) {
    base = `promotion to a ${flags.promotion}`;
  } else if (flags.enPassant) {
    base = "an en passant capture";
  } else if (flags.capture && flags.recapture) {
    base = "a recapture";
  } else if (flags.capture) {
    base = material?.captured?.square ? `a capture on ${material.captured.square}` : "a capture";
  } else if (flags.castle === "kingside") {
    base = "castling kingside";
  } else if (flags.castle === "queenside") {
    base = "castling queenside";
  }
  if (base && suffix) return `${base}, ${suffix}`;
  if (base) return base;
  return suffix ?? "";
}

/** The classification-specific clause (always includes Maia's numbers). */
export function maiaClause(explain = {}) {
  const classification = explain.classification ?? null;
  const flags = explain.flags ?? {};
  const maia = explain.maia ?? {};
  const elo = Number.isFinite(maia.moverElo) ? maia.moverElo : "?";
  const played = formatPercent(maia.playedProb);
  const pick = Array.isArray(maia.top) && maia.top.length > 0 ? maia.top[0] : UNKNOWN_PICK;
  const pickText = `${pick.san ?? "?"} (${formatPercent(pick.prob)})`;

  if (classification === "mainline") {
    if (flags.castle === "kingside" || flags.castle === "queenside") return "the main line";
    if (flags.capture && flags.recapture) return `${played} of ${elo}s take back`;
    return `the most common move at ${elo} (${played})`;
  }
  if (classification === "common") {
    return `a common choice at ${elo} (${played}); Maia's pick was ${pickText}`;
  }
  if (classification === "uncommon") {
    return `uncommon at ${elo} (${played}); Maia's pick was ${pickText}`;
  }
  if (classification === "rare") {
    return `only ${played} play this; Maia's pick was ${pickText}`;
  }
  // Unknown band (future server field): still factual, still Maia's numbers.
  return `Maia gives it ${played} here; her pick was ${pickText}`;
}

/**
 * The one entry point: `/explain` data -> `{text, chip, classification, san, by,
 * ply, elo}`. `text` is the exact sentence the panel shows for the template
 * engine, and the base text the optional LLM layer may rephrase (llm.js).
 */
export function phraseCommentary(explain = {}) {
  const move = explain.move ?? {};
  const san = move.san ?? move.uci ?? "?";
  const event = eventClause(explain.flags, explain.material);
  const maia = maiaClause(explain);
  const clauses = [event, maia].filter((clause) => clause && clause.length > 0);
  return {
    text: `${san} — ${clauses.join("; ")}.`,
    chip: classificationChip(explain.classification),
    classification: explain.classification ?? null,
    san,
    uci: move.uci ?? null,
    by: move.by ?? null,
    ply: Number.isFinite(move.ply) ? move.ply : null,
    moveNumber: Number.isFinite(move.moveNumber) ? move.moveNumber : null,
    opening: explain.opening ?? null,
    elo: Number.isFinite(explain.maia?.moverElo) ? explain.maia.moverElo : null,
  };
}

/**
 * A compact, JSON-safe facts object for the optional LLM layer: exactly the
 * facts the template sentence is made of (plus the template itself as the
 * canonical phrasing). No hidden information, no history, no engine output.
 */
export function commentaryFacts(explain = {}, templateText = null) {
  const maia = explain.maia ?? {};
  const pick = Array.isArray(maia.top) && maia.top.length > 0 ? maia.top[0] : null;
  return {
    move: explain.move?.san ?? explain.move?.uci ?? "?",
    by: explain.move?.by ?? null,
    flags: {
      capture: explain.flags?.capture === true,
      recapture: explain.flags?.recapture === true,
      check: explain.flags?.check === true,
      mate: explain.flags?.mate === true,
      castle: explain.flags?.castle ?? null,
      promotion: explain.flags?.promotion ?? null,
      enPassant: explain.flags?.enPassant === true,
    },
    classification: explain.classification ?? null,
    maia: {
      playedProb: Number.isFinite(maia.playedProb) ? maia.playedProb : null,
      rank: Number.isFinite(maia.rank) ? maia.rank : null,
      moverElo: Number.isFinite(maia.moverElo) ? maia.moverElo : null,
      top: pick ? { san: pick.san ?? null, prob: Number.isFinite(pick.prob) ? pick.prob : null } : null,
    },
    opening: explain.opening ?? null,
    wdl: explain.wdl ?? null,
    template: templateText,
  };
}

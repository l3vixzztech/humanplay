/**
 * humanplay — shared board location (M5)
 * ======================================
 *
 * The ONE place that answers "which element is the live chess.com board and
 * where is it on screen". Extracted from the M3 adapter so the M5 arrow
 * overlay anchors to exactly the same element the state protocol reports
 * (`chesscom-adapter.js` and `board-overlay.js` both dynamic-import this file
 * from the content script's isolated world — no duplicated selector logic).
 *
 * Rules (unchanged since M3, verified against live chess.com 2026-10; see
 * `test/fixtures/chesscom/README.md` for the probes):
 *
 *   - candidates: `wc-chess-board`, `#board-single`, `#board-play-computer`,
 *     `#board-analysis-board`, `.board` (first match of each selector);
 *   - a candidate must be displayed (display/visibility/opacity, ≥ 64×64 px);
 *   - **two tiers**: an interactive `<wc-chess-board>` always beats the
 *     legacy/pre-JS skeleton `<div id="board" class="board">` even when both
 *     are displayed at the same size;
 *   - the largest candidate (by area) wins;
 *   - `boardRect` is the element's `getBoundingClientRect()` in **viewport CSS
 *     pixels** — the coordinate space the fixed overlay canvas draws in.
 *
 * Everything except the three DOM wrappers (`findBoardElement`, `rectOf`,
 * `stackingZIndex`) is a pure function over plain data and runs in Node
 * (test/tools/overlay-unit.mjs).
 */

export const BOARD_SELECTORS = Object.freeze([
  "wc-chess-board",
  "#board-single",
  "#board-play-computer",
  "#board-analysis-board",
  ".board",
]);

/** Below this the candidate is not a playable board (icons, thumbnails). */
export const MIN_DISPLAY_PX = 64;

/**
 * Is this candidate a real, visible board?
 * @param {{display?:string, visibility?:string, opacity?:string|number}} computed output of getComputedStyle (or a plain equivalent)
 * @param {{width:number, height:number}} rect
 */
export function displayStateOf(computed, rect) {
  if (!computed || !rect) return false;
  if (computed.display === "none" || computed.visibility === "hidden") return false;
  if (Number(computed.opacity) === 0) return false;
  return rect.width >= MIN_DISPLAY_PX && rect.height >= MIN_DISPLAY_PX;
}

/**
 * Choose the board among already-displayed candidates (pure).
 *
 * @param {{el:any, tagNameLower:string, rect:{x:number,y:number,width:number,height:number}}[]} entries
 *        in document order; `tagNameLower` is used for the tier rule
 * @param {{w:number, h:number}} viewport `window.innerWidth/innerHeight`
 * @returns {{el:any, rect:DOMRect|any, inViewport:boolean, partlyVisible:boolean}|null}
 */
export function pickBoardCandidate(entries, viewport) {
  const tiers = [[], []];
  for (const entry of entries ?? []) {
    tiers[entry.tagNameLower === "wc-chess-board" ? 0 : 1].push(entry);
  }
  const candidates = tiers[0].length > 0 ? tiers[0] : tiers[1];
  if (candidates.length === 0) return null;

  // Largest wins; ties keep document order (Array.sort is stable).
  const sorted = [...candidates].sort((a, b) => b.rect.width * b.rect.height - a.rect.width * a.rect.height);
  const best = sorted[0];
  const rect = best.rect;
  const left = rect.x ?? rect.left ?? 0;
  const top = rect.y ?? rect.top ?? 0;
  const width = rect.width;
  const height = rect.height;
  const inViewport =
    left >= 0 && top >= 0 && left + width <= (viewport?.w ?? Infinity) && top + height <= (viewport?.h ?? Infinity);
  const partlyVisible =
    left + width > 0 && top + height > 0 && left < (viewport?.w ?? Infinity) && top < (viewport?.h ?? Infinity);
  return { el: best.el, rect: best.rect, inViewport, partlyVisible };
}

/**
 * The live board element of the current page, or null.
 * DOM wrapper used by the adapter and the overlay in the content script.
 */
export function findBoardElement({ document: doc = document, window: win = window } = {}) {
  const seen = new Set();
  const entries = [];
  for (const selector of BOARD_SELECTORS) {
    for (const el of doc.querySelectorAll(selector)) {
      if (seen.has(el)) continue;
      seen.add(el);
      const rect = el.getBoundingClientRect();
      if (!displayStateOf(win.getComputedStyle(el), rect)) continue;
      entries.push({ el, tagNameLower: el.tagName.toLowerCase(), rect });
    }
  }
  return pickBoardCandidate(entries, { w: win.innerWidth, h: win.innerHeight });
}

/** `{x, y, w, h}` in viewport CSS pixels — the GameState.boardRect shape. */
export function rectOf(element) {
  const rect = element.getBoundingClientRect();
  return { x: rect.left, y: rect.top, w: rect.width, h: rect.height };
}

/**
 * Board orientation read from the live element (same signals as the adapter's
 * detectFlipped, without the adapter's warnings): the `flipped` class wins,
 * then `<wc-chess-board>.state.isFlipped`.
 */
export function isBoardFlipped(boardEl) {
  if (!boardEl) return false;
  if (boardEl.classList?.contains("flipped")) return true;
  try {
    const state = boardEl.state;
    if (typeof state?.isFlipped === "boolean") return state.isFlipped;
  } catch {
    // chess.com internals — treat an inaccessible state as "not flipped"
  }
  return false;
}

/**
 * Highest numeric z-index on the board element and its ancestors (0 when all
 * are `auto`/static). The overlay canvas sits just above this so it is above
 * the board (and any board-local popups) but stays below site modals, which
 * chess.com renders in much higher stacking contexts.
 */
export function stackingZIndex(element, { view = element?.ownerDocument?.defaultView ?? globalThis } = {}) {
  let max = 0;
  let current = element;
  while (current && current.nodeType === 1) {
    const style = view.getComputedStyle(current);
    if (style.position !== "static" && style.zIndex !== "auto") {
      const value = Number(style.zIndex);
      if (Number.isFinite(value) && value > max) max = value;
    }
    current = current.parentElement;
  }
  return max;
}

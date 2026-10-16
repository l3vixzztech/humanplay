/**
 * humanplay — board overlay geometry (M5)
 * =======================================
 *
 * PURE functions that turn "a board rectangle + a UCI move" into everything an
 * overlay needs to paint an arrow **in viewport CSS pixels**: endpoints (square
 * centres), the shortened shaft, the arrowhead polygon, thicknesses scaled to
 * the square size, and viewport checks. No DOM, no `chrome.*`, no imports —
 * the exact same file runs in the content script (`board-overlay.js`, dynamic
 * import from the isolated world) and in the zero-dep Node unit test
 * (`test/tools/overlay-unit.mjs`).
 *
 * Coordinate system (locked):
 *
 *   - everything is **viewport CSS pixels**, origin = top-left of the viewport,
 *     exactly what `element.getBoundingClientRect()` returns and what a
 *     `position:fixed` canvas draws in;
 *   - the caller passes the board rect `{x, y, w, h}` of the 8×8 play area
 *     (`GameState.boardRect` / a live `getBoundingClientRect()`);
 *   - device pixels are only involved when sizing the canvas bitmap
 *     (`deviceCanvasSize`) — drawing happens under `ctx.scale(dpr, dpr)`, so the
 *     geometry never changes with DPR.
 *
 * Square mapping (verified chess.com encoding: `square-XY`, X = file a=1…h=8,
 * Y = rank 1…8, absolute under flipping — see `board-dom.js`):
 *
 *   - normal: col = file,        row = 7 - rank
 *   - flipped: col = 7 - file,   row = rank
 *
 * Degenerate inputs (zero-size rect, unknown UCI, from == to) return `null`;
 * tiny or huge boards stay numerically valid and are flagged (`drawable`) with
 * thickness clamped into a sane device-independent range.
 */

export const FILES = 8;
export const RANKS = 8;

/** Tuning knobs. All thicknesses are fractions of ONE square unless named px. */
export const DEFAULTS = Object.freeze({
  /** top-1 shaft thickness as a fraction of the square size */
  thicknessRatio: 0.16,
  /** alternative arrows: thinner so the ranking is visible at a glance */
  altThicknessRatio: 0.095,
  /** absolute thickness bounds (CSS px) — tiny/huge boards stay sane */
  minThickness: 2,
  maxThickness: 42,
  /** arrowhead length/width as multiples of the shaft thickness */
  headLengthRatio: 2.8,
  headWidthRatio: 3.0,
  /** below this square size (CSS px) arrows are not worth drawing */
  minSquarePx: 4,
  /** an arrowhead never eats more of the shaft than this fraction */
  headLengthShaftFraction: 0.8,
});

const UCI_RE = /^([a-h][1-8])([a-h][1-8])([qrbn])?$/;

/* --------------------------------------------------------------- squares */

/**
 * Parse a UCI move ("e2e4", "e7e8q", "e1g1" for castling) into square records.
 * @param {string} uci
 * @returns {{from:{file:number,rank:number}, to:{file:number,rank:number}, promotion:string|null}|null}
 */
export function uciToSquares(uci) {
  const match = UCI_RE.exec(String(uci ?? "").trim().toLowerCase());
  if (!match) return null;
  return {
    from: squareFromName(match[1]),
    to: squareFromName(match[2]),
    promotion: match[3] ?? null,
  };
}

/** "e2" -> {file: 4, rank: 1} (0-based, file a=0, rank 1=0). */
export function squareFromName(name) {
  const text = String(name ?? "").toLowerCase();
  if (!/^[a-h][1-8]$/.test(text)) return null;
  return { file: text.charCodeAt(0) - 97, rank: Number(text[1]) - 1 };
}

/**
 * Size of one square in CSS px for a board rect. Non-square rects use the
 * smaller side (the grid stays square and centred — see `boardGridOf`).
 */
export function squareSize(rect) {
  if (!rect || !(rect.w > 0) || !(rect.h > 0)) return 0;
  return Math.min(rect.w, rect.h) / FILES;
}

/**
 * Grid origin/size for a board rect: an 8×8 grid of `size` px, centred inside
 * the rect (identical to the raw rect for the square boards of a real game).
 */
export function boardGridOf(rect) {
  const size = squareSize(rect);
  const x = rect.x + (rect.w - size * FILES) / 2;
  const y = rect.y + (rect.h - size * RANKS) / 2;
  return { x, y, size };
}

/**
 * Centre of a square in viewport CSS px.
 * @param {number} file 0-based (a = 0)
 * @param {number} rank 0-based (rank 1 = 0)
 * @param {{x,y,w,h}} rect board rect
 * @param {boolean} flipped board orientation (true = black at the bottom)
 */
export function squareToViewport(file, rank, rect, flipped = false) {
  const grid = boardGridOf(rect);
  const col = flipped ? FILES - 1 - file : file;
  const row = flipped ? rank : RANKS - 1 - rank;
  return { x: grid.x + (col + 0.5) * grid.size, y: grid.y + (row + 0.5) * grid.size };
}

/** Square name of a 0-based file/rank ("e2"). */
export function squareName(file, rank) {
  return `${"abcdefgh"[file] ?? "?"}${rank + 1}`;
}

/* ---------------------------------------------------------------- arrows */

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

/**
 * Geometry of ONE arrow. Returns `null` for unknown moves, degenerate rects
 * and zero-length arrows; everything else is a complete drawable description.
 *
 * @param {object} input
 * @param {string} input.uci
 * @param {{x:number,y:number,w:number,h:number}} input.rect board rect (viewport CSS px)
 * @param {boolean} [input.flipped]
 * @param {number} [input.rank] 0 = top-1 (solid), > 0 = alternative (thin)
 * @param {object} [input.viewport] `{w, h}` — enables `intersectsViewport`
 * @param {object} [input.tunables] overrides of `DEFAULTS` (unit tests)
 * @returns {object|null}
 */
export function computeArrow({ uci, rect, flipped = false, rank = 0, viewport = null, tunables = {} } = {}) {
  const options = { ...DEFAULTS, ...tunables };
  const squares = uciToSquares(uci);
  if (!squares) return null;
  const size = squareSize(rect);
  if (size <= 0) return null;

  const fromPt = squareToViewport(squares.from.file, squares.from.rank, rect, flipped);
  const tip = squareToViewport(squares.to.file, squares.to.rank, rect, flipped);
  const dx = tip.x - fromPt.x;
  const dy = tip.y - fromPt.y;
  const length = Math.hypot(dx, dy);
  if (!(length > 0)) return null; // from == to (or non-finite rect)

  const unit = { x: dx / length, y: dy / length };
  const perp = { x: -unit.y, y: unit.x };

  // Thickness: scaled to the square, clamped for tiny/huge boards and never
  // wider than half a square (a fat line must not swallow the target square).
  const ratio = rank === 0 ? options.thicknessRatio : options.altThicknessRatio;
  const upper = Math.max(options.minThickness, Math.min(options.maxThickness, size * 0.5));
  const thickness = clamp(size * ratio, options.minThickness, upper);

  const headLength = Math.min(
    thickness * options.headLengthRatio,
    length * options.headLengthShaftFraction,
    size * 1.25,
  );
  const headWidth = Math.min(thickness * options.headWidthRatio, size * 1.6);

  const base = { x: tip.x - unit.x * headLength, y: tip.y - unit.y * headLength };
  const halfWidth = headWidth / 2;
  const head = [
    { x: tip.x, y: tip.y },
    { x: base.x + perp.x * halfWidth, y: base.y + perp.y * halfWidth },
    { x: base.x - perp.x * halfWidth, y: base.y - perp.y * halfWidth },
  ];

  const bounds = boundsOfPoints([fromPt, tip, ...head]);
  const inflate = thickness / 2; // stroke half-width
  const inflated = {
    minX: bounds.minX - inflate,
    minY: bounds.minY - inflate,
    maxX: bounds.maxX + inflate,
    maxY: bounds.maxY + inflate,
  };

  return {
    uci: String(uci).toLowerCase(),
    promotion: squares.promotion,
    rank,
    flipped: Boolean(flipped),
    from: squares.from,
    to: squares.to,
    squareSize: size,
    thickness,
    headLength,
    headWidth,
    fromPt,
    tip,
    base,
    unit,
    perp,
    /** shaft as drawn: source centre -> head base */
    shaft: { from: fromPt, to: base },
    /** arrowhead polygon (tip first, then the two base corners) */
    head,
    length,
    bounds: inflated,
    /** tiny boards: geometry is valid but painting is pointless */
    drawable: size >= options.minSquarePx,
    intersectsViewport: viewport ? intersectsViewport({ bounds: inflated }, viewport) : null,
  };
}

/**
 * Geometries for a suggestion: the first `topN` moves (rank 0 = top-1 solid,
 * rank 1+ = alternatives). Unknown/invalid entries are skipped, never fatal.
 *
 * @param {object} input
 * @param {{uci:string, san?:string, prob?:number}[]} input.moves
 * @param {{x:number,y:number,w:number,h:number}} input.rect
 * @param {boolean} [input.flipped]
 * @param {number} [input.topN] how many to draw (defaults to all given moves)
 * @param {{w:number,h:number}} [input.viewport]
 * @param {object} [input.tunables]
 */
export function computeArrows({ moves, rect, flipped = false, topN = undefined, viewport = null, tunables = {} } = {}) {
  const list = Array.isArray(moves) ? moves : [];
  const limit = Number.isFinite(topN) ? Math.max(0, Math.floor(topN)) : list.length;
  const arrows = [];
  for (let index = 0; index < Math.min(limit, list.length); index += 1) {
    const move = list[index];
    if (!move || typeof move.uci !== "string") continue;
    const geometry = computeArrow({ uci: move.uci, rect, flipped, rank: index, viewport, tunables });
    if (!geometry) continue;
    arrows.push({ ...geometry, san: move.san ?? null, prob: Number.isFinite(move.prob) ? move.prob : null, index });
  }
  return arrows;
}

/* ------------------------------------------------------------- viewport */

/**
 * Does the arrow's bounding box (stroke included) overlap the viewport?
 * @param {{bounds:{minX,minY,maxX,maxY}}} geometry
 * @param {{w:number,h:number}} viewport origin = (0, 0)
 */
export function intersectsViewport(geometry, viewport) {
  if (!geometry?.bounds || !viewport) return false;
  const { minX, minY, maxX, maxY } = geometry.bounds;
  return maxX > 0 && maxY > 0 && minX < viewport.w && minY < viewport.h;
}

/** Bounding box of a point list. */
export function boundsOfPoints(points) {
  const list = Array.isArray(points) ? points.filter((point) => point && Number.isFinite(point.x) && Number.isFinite(point.y)) : [];
  if (list.length === 0) return { minX: 0, minY: 0, maxX: 0, maxY: 0 };
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const point of list) {
    if (point.x < minX) minX = point.x;
    if (point.y < minY) minY = point.y;
    if (point.x > maxX) maxX = point.x;
    if (point.y > maxY) maxY = point.y;
  }
  return { minX, minY, maxX, maxY };
}

/* ------------------------------------------------------------------ DPR */

/**
 * Backing-store size for a full-viewport canvas (CSS px * devicePixelRatio),
 * integer and at least 1×1. Draw with `ctx.setTransform(dpr, 0, 0, dpr, 0, 0)`
 * so all geometry stays in CSS px.
 * @param {{w:number,h:number}} viewport
 * @param {number} dpr
 */
export function deviceCanvasSize(viewport, dpr = 1) {
  const scale = Number.isFinite(dpr) && dpr > 0 ? dpr : 1;
  return {
    width: Math.max(1, Math.round((viewport?.w ?? 0) * scale)),
    height: Math.max(1, Math.round((viewport?.h ?? 0) * scale)),
    dpr: scale,
  };
}

/** CSS px point -> device px point (diagnostics/tests; drawing uses ctx.scale). */
export function scalePoint(point, dpr = 1) {
  const scale = Number.isFinite(dpr) && dpr > 0 ? dpr : 1;
  return { x: (point?.x ?? 0) * scale, y: (point?.y ?? 0) * scale };
}

/**
 * z-index for the overlay canvas: one above the highest numeric z-index of the
 * board and its ancestors, and never below `min` (so it is above a z-index:auto
 * board). chess.com renders its modals in much higher stacking contexts, which
 * keeps the overlay below dialogs.
 */
export function overlayZIndex(boardZ = 0, { min = 40 } = {}) {
  const base = Number.isFinite(Number(boardZ)) ? Math.floor(Number(boardZ)) : 0;
  return Math.max(min, base + 1);
}

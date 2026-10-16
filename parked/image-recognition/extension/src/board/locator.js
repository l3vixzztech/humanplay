/**
 * humanplay — board locator (Milestone 3)
 * =======================================
 *
 * Finds the 8x8 chess board inside ONE captured frame. This module is PURE:
 * no DOM, no `chrome.*`, no timers, no randomness, no imports — so the side
 * panel, this repo's test harnesses and plain Node can all run the same code.
 *
 * Frame pixels vs CSS pixels
 * --------------------------
 * `locateBoard()` takes the RGBA pixels of the captured PNG. `chrome.tabs.
 * captureVisibleTab` renders at the *device* pixel ratio of the captured tab,
 * so on a HiDPI screen the PNG is larger than the tab's CSS size. Every
 * coordinate this module returns is in **frame (PNG/device) pixels**,
 * row-major, origin at the top-left of the image. The returned rect covers the
 * 8x8 PLAY AREA (the squares only) — coordinate labels, board borders/frames
 * and page chrome stay outside of it.
 *
 * Algorithm (axis-aligned digital boards only — no photo/perspective support)
 * ---------------------------------------------------------------------------
 * 1. Luminance + downscale: the frame is sampled on a grid (`maxAnalysisDim`,
 *    usually 1:1) for the coarse pass; no full-resolution copy is materialised.
 * 2. Gradient projections: for every analysis column x, the mean over all rows
 *    of the local horizontal edge magnitude |L(x+1)-L(x-1)| (symmetric for
 *    rows). Long straight edges — square boundaries — dominate the short edges
 *    of piece art, text, arrows and dithering.
 * 3. Lattice search, *9-line hypothesis*: chess square boundaries form 9 evenly
 *    spaced lines per axis (8 cells). For every spacing in
 *    `[minSquare/scale, min(w,h)/8]` and every offset (0.5 px steps) the 9 lines
 *    are scored against the projections, normalised per frame:
 *        score(line) = clamp01( peak(p) / max(REF_FLOOR, REF_MULTIPLIER * p85) )
 *    i.e. a line counts when it clearly stands out from the frame's typical
 *    gradient level (p85 is robust against a few very strong page borders).
 *    The hypothesis score is 0.7*mean + 0.3*min — all 9 lines must align, not
 *    just a lucky subset.
 *    The *10-line hypothesis* is evaluated on the same lattice: some boards
 *    draw an extra evenly spaced outer border line one cell outside the play
 *    area (top/left or bottom/right); if that line is stronger than the average
 *    line, the 10-line variant wins. The reported rect is the play area either
 *    way.
 * 4. Candidate selection: per axis, near-duplicate lattices are suppressed and
 *    the best `maxCandidatesPerAxis` survive.
 * 5. Two-tone parity check: for every candidate rect the 64 square centres are
 *    sampled (median of a small inset grid per square — robust against the
 *    piece covering the centre, coordinate glyphs at square edges and
 *    anti-aliasing). Chess square colours alternate, so the best even/odd split
 *    of the 64 medians should agree with the checkerboard parity: agreement
 *    fraction plus the luminance separation of the two classes. Last-move
 *    highlights, arrows and piece colours are outliers that cost a few votes —
 *    the split is optimised globally, so a small fraction of outliers is fine.
 * 6. Combined confidence = 0.45*line + 0.55*parity with hard gates on parity
 *    fraction and separation. Below `minConfidence` the frame is rejected with
 *    a human-readable `reason`.
 * 7. Full-resolution refit: around the winning lattice the gradients are
 *    recomputed on the original pixels; each of the 9 lines is snapped to its
 *    local gradient peak (sub-pixel, parabolic interpolation) and a robust
 *    weighted least-squares fit gives the final start/spacing. Lines hidden by
 *    pieces are dropped by the residual/strength checks. When both axes agree
 *    on the square size within 5% they are averaged (digital boards are square).
 *
 * Everything is deterministic: iteration order is fixed and ties keep the first
 * candidate. All tunables are the constants below and can be overridden through
 * `options` without touching the module.
 */

export const LOCATOR_VERSION = "m3.0";

/** Tunable defaults (see the header for what each one means). */
export const LOCATOR_DEFAULTS = Object.freeze({
  /** Smallest plausible square size, in frame px (96 px board). */
  minSquare: 12,
  /**
   * Coarse pass: downscale so that max(width, height) <= this. Kept high on
   * purpose — the projections are much better behaved when the square
   * boundaries are not aliased away (a 1100 px frame is analysed 1:1), and the
   * search below is cheap enough to afford it. Only very large frames
   * (4K-ish, DPR-2 1920x1080) get downscaled.
   */
  maxAnalysisDim: 1100,
  /** Combined score (line+parity) below which the board is rejected. */
  minConfidence: 0.5,
  /** Hard gate: fraction of the 64 squares whose parity must be consistent. */
  minParityFraction: 0.65,
  /** Hard gate: luminance separation (0..255) of the two square colours. */
  minParitySeparation: 6,
  /** Lattice hypotheses kept per axis before the parity check. */
  maxCandidatesPerAxis: 14,
  /** Offset/spacing step of the coarse lattice search, in analysis px. */
  coarseStep: 0.5,
});

/* ------------------------------------------------------------------ tuning */

const CELLS = 8;
const LINE_COUNT = CELLS + 1; // 9 evenly spaced lines == 8 cells

const REF_QUANTILE = 0.85; // projection reference quantile (robust vs outliers)
const REF_MULTIPLIER = 4; // a line saturates at REF_MULTIPLIER * p85(projection)
const REF_FLOOR = 6; // ... but never below this absolute level (luma units)
// Line scores keep headroom above 1 so that a lattice where every line is
// strong still outranks one that merely *reaches* the reference on 8 of 9
// lines (that is exactly the one-square-shifted-board ambiguity: shifting the
// 8x8 lattice by one cell keeps the parity of all 64 sampled centres intact,
// so only the strength of the ninth line can tell them apart).
const LINE_SCORE_CAP = 2.5;
const MIN_LINE_WEIGHT = 0.3; // weight of the "weakest of the 9 lines" term

const PARITY_BASE = 0.6; // agreement fraction where the parity score leaves 0
const PARITY_FULL = 0.85; // agreement fraction where it saturates
const PARITY_SEP_FULL = 10; // class separation (luma units) where it saturates
// Per-cell probe pattern (fractions of the cell): centre, 4 corners and 4 edge
// midpoints at the 1/4 and 3/4 lines. Single-point probes keep the check cheap
// and make "probe falls into the neighbouring square" detectable.
const PROBE_OFFSETS = [
  [0.5, 0.5],
  [0.25, 0.25],
  [0.75, 0.25],
  [0.25, 0.75],
  [0.75, 0.75],
  [0.5, 0.25],
  [0.5, 0.75],
  [0.25, 0.5],
  [0.75, 0.5],
];
const PROBE_COUNT = PROBE_OFFSETS.length;
const PROBE_BAND = 0.4; // probe agrees when within 40% of the class separation
const PROBE_MIN_AGREE = 5; // of 9 probes per cell

const WEIGHT_LINE = 0.45;
const WEIGHT_PARITY = 0.55;
// Digital chess boards are square: a candidate whose two axes disagree on the
// square size is penalised (both axes are searched independently, and a
// stretched lattice can look plausible on one axis alone).
const SQUARE_MISMATCH_OK = 0.03; // free below 3% mismatch
const SQUARE_MISMATCH_SPAN = 0.12; // penalty ramps to 0 at 15% mismatch

const REFIT_MARGIN = 0.22; // full-res refit region: play area + this fraction
const REFIT_WINDOW = 0.09; // local peak search window, ± fraction of a square
const REFIT_MIN_STRENGTH = 0.35; // drop lines weaker than 35% of the best line
const REFIT_MAX_RESIDUAL = 0.07; // drop lines further than 7% of a square
const REFIT_MIN_LINES = 5; // fewer accepted lines -> keep the coarse fit
const SQUARE_TOLERANCE = 0.05; // axes averaged when within 5% of each other

// Coarse lattice search: the global pass uses `coarseStep` (0.5 analysis px),
// which over 8 cells accumulates up to ~4 frame px of drift — too coarse to
// rank the true lattice reliably. Its best seeds are therefore refined with a
// fine local (start, spacing) search before the parity stage.
const SEED_KEEP = 32; // coarse candidates kept as seeds for the fine pass
const FINE_START_SPAN = 2.5; // ± analysis px around a seed start
const FINE_START_STEP = 0.25;
const FINE_SPACING_SPAN = 1.25; // ± analysis px around a seed spacing
const FINE_SPACING_STEP = 0.125;

/* ------------------------------------------------------------------ helpers */

function clamp(value, lo, hi) {
  return value < lo ? lo : value > hi ? hi : value;
}

function clamp01(value) {
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

/** Rec.601 luminance — cheap and good enough for edge detection. */
function luma(r, g, b) {
  return 0.299 * r + 0.587 * g + 0.114 * b;
}

/** Linear-interpolated quantile of an unsorted float array (sorts a copy). */
function quantile(values, q) {
  const sorted = Float64Array.from(values).sort();
  if (sorted.length === 0) return 0;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return lo === hi ? sorted[lo] : sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

/**
 * Quantile of a large plane without sorting all of it: deterministic strided
 * subsample (<= `maxSamples` values). Used for whole-frame contrast only.
 */
function sampledQuantile(values, q, maxSamples = 4096) {
  const stride = Math.max(1, Math.floor(values.length / maxSamples));
  const count = Math.floor((values.length + stride - 1) / stride);
  const sample = new Float64Array(count);
  for (let i = 0, j = 0; i < values.length; i += stride, j++) sample[j] = values[i];
  return quantile(sample, q);
}

/** Local-max array: peak[i] = max(g[i-1], g[i], g[i+1]) (mirrored edges). */
function peakify(g) {
  const n = g.length;
  const peak = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const a = g[i > 0 ? i - 1 : 0];
    const b = g[i];
    const c = g[i < n - 1 ? i + 1 : n - 1];
    peak[i] = a > b ? (a > c ? a : c) : b > c ? b : c;
  }
  return peak;
}

/** Bilinear luminance sampler over a row-major luminance plane. */
function makeSampler(lum, w, h) {
  const last = w - 1;
  const lastRow = h - 1;
  return (x, y) => {
    let x0 = Math.floor(x);
    let y0 = Math.floor(y);
    if (x0 < 0) x0 = 0;
    else if (x0 > last) x0 = last;
    if (y0 < 0) y0 = 0;
    else if (y0 > lastRow) y0 = lastRow;
    const x1 = x0 < last ? x0 + 1 : last;
    const y1 = y0 < lastRow ? y0 + 1 : lastRow;
    const fx = clamp(x - x0, 0, 1);
    const fy = clamp(y - y0, 0, 1);
    const row0 = y0 * w;
    const row1 = y1 * w;
    const v00 = lum[row0 + x0];
    const v10 = lum[row0 + x1];
    const v01 = lum[row1 + x0];
    const v11 = lum[row1 + x1];
    const top = v00 + (v10 - v00) * fx;
    const bottom = v01 + (v11 - v01) * fx;
    return top + (bottom - top) * fy;
  };
}

/* ------------------------------------------------------- analysis downscale */

/**
 * Luminance plane of the frame, sampled every `scale` pixels (block centre).
 * `analysisIndex * scale` maps back to frame pixels within one `scale`.
 */
function analysisLuminance(data, width, height, scale) {
  const aw = Math.floor((width - 1) / scale) + 1;
  const ah = Math.floor((height - 1) / scale) + 1;
  const offset = scale >> 1;
  const lum = new Float32Array(aw * ah);
  for (let j = 0; j < ah; j++) {
    const y = Math.min(height - 1, j * scale + offset);
    const rowBase = j * aw;
    for (let i = 0; i < aw; i++) {
      const x = Math.min(width - 1, i * scale + offset);
      const p = (y * width + x) * 4;
      lum[rowBase + i] = luma(data[p], data[p + 1], data[p + 2]);
    }
  }
  return { lum, aw, ah };
}

/**
 * Per-column / per-row mean edge magnitude over a luminance plane:
 *   grad[x] = mean over y of |L(x+1,y) - L(x-1,y)|
 * The central difference spans two pixels, so a 1-2 px square boundary still
 * produces a full-amplitude value while the mean over the whole axis keeps
 * long straight lines far above piece art, text, arrows and dithering.
 */
function projections(lum, aw, ah) {
  const col = new Float32Array(aw);
  const row = new Float32Array(ah);
  // One row-major pass: sequential reads for the column gradients, and the
  // two strided reads of the row gradients reuse every cache line along x.
  for (let y = 0; y < ah; y++) {
    const base = y * aw;
    if (y > 0 && y < ah - 1) {
      const up = base - aw;
      const down = base + aw;
      let acc = 0;
      for (let x = 0; x < aw; x++) {
        const d = lum[down + x] - lum[up + x];
        acc += d < 0 ? -d : d;
      }
      row[y] = acc / aw;
    }
    if (y > 0) {
      for (let x = 1; x < aw - 1; x++) {
        const d = lum[base + x + 1] - lum[base + x - 1];
        col[x] += d < 0 ? -d : d;
      }
    }
  }
  const invRows = 1 / (ah - 2);
  for (let x = 0; x < aw; x++) col[x] *= invRows;
  col[0] = col[1];
  col[aw - 1] = col[aw - 2];
  row[0] = row[1];
  row[ah - 1] = row[ah - 2];
  return { col, row };
}

/* ----------------------------------------------------------- lattice search */

/**
 * One axis of the coarse lattice search.
 *
 * @returns {{start:number, spacing:number, score:number, lines:9|10}[]} the
 *   surviving lattice hypotheses, best first, near-duplicates suppressed.
 */
function searchAxis(g, { minSpacing, maxSpacing, step, keep }) {
  const len = g.length;
  const peak = peakify(g);
  const ref = Math.max(REF_FLOOR, REF_MULTIPLIER * quantile(g, REF_QUANTILE));
  const invRef = 1 / ref;

  const candidates = [];
  const scoreLine = (p) => {
    const idx = (p + 0.5) | 0;
    if (idx < 0 || idx >= len) return -1;
    const v = peak[idx] * invRef;
    return v > LINE_SCORE_CAP ? LINE_SCORE_CAP : v;
  };

  /** Score one full lattice: mean + weakest of the 9 lines, plus the 10-line variant. */
  const scoreLattice = (start, spacing) => {
    if (spacing <= 2) return null;
    if (start < 0 || start + CELLS * spacing > len - 1) return null;
    let total = 0;
    let weakest = Infinity;
    for (let k = 0; k < LINE_COUNT; k++) {
      const idx = (start + k * spacing + 0.5) | 0;
      if (idx >= len) return null;
      const v = peak[idx] * invRef;
      const s = v > LINE_SCORE_CAP ? LINE_SCORE_CAP : v;
      total += s;
      if (s < weakest) weakest = s;
    }
    // 10-line hypothesis: one extra evenly spaced line just outside the play
    // area (an outer board border sitting on the lattice).
    let extra = -1;
    if (start - spacing >= 0) extra = scoreLine(start - spacing);
    const after = start + CELLS * spacing + spacing;
    if (after <= len - 1) {
      const v = scoreLine(after);
      if (v > extra) extra = v;
    }
    let lines = LINE_COUNT;
    let score = (1 - MIN_LINE_WEIGHT) * (total / LINE_COUNT) + MIN_LINE_WEIGHT * weakest;
    if (extra > 0) {
      const score10 =
        (1 - MIN_LINE_WEIGHT) * ((total + extra) / (LINE_COUNT + 1)) +
        MIN_LINE_WEIGHT * Math.min(weakest, extra);
      if (score10 > score) {
        score = score10;
        lines = LINE_COUNT + 1;
      }
    }
    return { start, spacing, score, lines };
  };

  const insert = (candidate, radiusStart = 2, radiusSpacing = 1) => {
    let absorbed = false;
    for (const other of candidates) {
      if (
        Math.abs(other.start - candidate.start) <= radiusStart &&
        Math.abs(other.spacing - candidate.spacing) <= radiusSpacing
      ) {
        if (candidate.score > other.score) {
          other.start = candidate.start;
          other.spacing = candidate.spacing;
          other.score = candidate.score;
          other.lines = candidate.lines;
        }
        absorbed = true;
        break;
      }
    }
    if (absorbed) {
      candidates.sort((a, b) => b.score - a.score);
      return;
    }
    if (candidates.length < SEED_KEEP) {
      candidates.push(candidate);
    } else if (candidate.score > candidates[candidates.length - 1].score) {
      candidates[candidates.length - 1] = candidate;
    } else {
      return;
    }
    candidates.sort((a, b) => b.score - a.score);
  };

  // Pass 1 — global search on the coarse grid; keeps SEED_KEEP seeds.
  for (let spacing = minSpacing; spacing <= maxSpacing; spacing += step) {
    const span = CELLS * spacing;
    if (span > len - 1) continue;
    const maxStart = len - 1 - span;
    for (let start = 0; start <= maxStart; start += step) {
      let total = 0;
      let weakest = Infinity;
      let ok = true;
      for (let k = 0; k < LINE_COUNT; k++) {
        const idx = (start + k * spacing + 0.5) | 0;
        if (idx >= len) {
          ok = false;
          break;
        }
        const v = peak[idx] * invRef;
        const s = v > LINE_SCORE_CAP ? LINE_SCORE_CAP : v;
        total += s;
        if (s < weakest) weakest = s;
      }
      if (!ok) continue;
      let extra = -1;
      const before = start - spacing;
      const after = start + CELLS * spacing + spacing;
      if (before >= 0) extra = scoreLine(before);
      if (after <= len - 1) {
        const v = scoreLine(after);
        if (v > extra) extra = v;
      }
      let lines = LINE_COUNT;
      let score = (1 - MIN_LINE_WEIGHT) * (total / LINE_COUNT) + MIN_LINE_WEIGHT * weakest;
      if (extra > 0) {
        const score10 =
          (1 - MIN_LINE_WEIGHT) * ((total + extra) / (LINE_COUNT + 1)) +
          MIN_LINE_WEIGHT * Math.min(weakest, extra);
        if (score10 > score) {
          score = score10;
          lines = LINE_COUNT + 1;
        }
      }
      insert({ start, spacing, score, lines });
    }
  }

  // Pass 2 — fine local refinement of the seeds. The coarse grid can only
  // resolve the spacing to `step`; over 8 cells that accumulates enough drift
  // to miss the true lattice entirely, so each seed gets a small (start,
  // spacing) sweep on a 0.25/0.125 px grid before the parity stage.
  //
  // The score is flat over a small plateau around the true lattice (the line
  // lookup rounds to the nearest projection sample), so *equal* candidates are
  // averaged: the plateau centre is the unbiased estimate, picking its first
  // element would bias every lattice in one direction.
  const fine = [];
  for (const seed of candidates) {
    let bestScore = -Infinity;
    let sumStart = 0;
    let sumSpacing = 0;
    let count = 0;
    let lines = LINE_COUNT;
    for (
      let spacing = seed.spacing - FINE_SPACING_SPAN;
      spacing <= seed.spacing + FINE_SPACING_SPAN + 1e-9;
      spacing += FINE_SPACING_STEP
    ) {
      for (
        let start = seed.start - FINE_START_SPAN;
        start <= seed.start + FINE_START_SPAN + 1e-9;
        start += FINE_START_STEP
      ) {
        const candidate = scoreLattice(start, spacing);
        if (!candidate) continue;
        if (candidate.score > bestScore + 1e-9) {
          bestScore = candidate.score;
          sumStart = candidate.start;
          sumSpacing = candidate.spacing;
          count = 1;
          lines = candidate.lines;
        } else if (candidate.score >= bestScore - 1e-9) {
          sumStart += candidate.start;
          sumSpacing += candidate.spacing;
          count += 1;
          if (candidate.lines > lines) lines = candidate.lines;
        }
      }
    }
    if (count > 0) {
      fine.push({
        start: sumStart / count,
        spacing: sumSpacing / count,
        score: bestScore,
        lines,
      });
    }
  }

  // Merge: refined candidates replace their coarse seeds, keeping the best of
  // each fine cluster; then truncate to `keep` for the parity stage.
  const merged = [];
  const push = (candidate) => {
    for (const other of merged) {
      if (
        Math.abs(other.start - candidate.start) <= 1 &&
        Math.abs(other.spacing - candidate.spacing) <= 0.5
      ) {
        if (candidate.score > other.score) {
          other.start = candidate.start;
          other.spacing = candidate.spacing;
          other.score = candidate.score;
          other.lines = candidate.lines;
        }
        return;
      }
    }
    merged.push(candidate);
  };
  for (const candidate of fine) push(candidate);
  for (const candidate of candidates) push(candidate);
  merged.sort((a, b) => b.score - a.score);
  return merged.slice(0, keep);
}

/* ------------------------------------------------------------ parity check */

/**
 * Two-tone parity statistics of a candidate rect (per-axis spacings allowed).
 *
 * Each square is probed at 9 points (centre, 4 corners, 4 edge midpoints at
 * 1/4 .. 3/4 of the cell) and reduced to their median — robust against the
 * piece covering the centre and against coordinate glyphs at the cell edges.
 *
 * Two independent signals come out of this:
 *  - `fraction`: agreement of the best even/odd luminance split with the
 *    checkerboard parity of the 64 cell medians (0.5 = no signal, 1 = perfect);
 *  - `uniform`: fraction of cells that are NOT "split", i.e. do not contain
 *    probes matching *both* class medians at once. A single square has one
 *    colour, so a cell touching both tones is straddling a real square
 *    boundary — that is what catches a lattice shifted or stretched by a
 *    quarter square while its cell medians still land on square colours.
 *    (Piece art is white/black with dark outlines, i.e. *outside* both square
 *    tones, so a rook's base over a light square does not register as "both".)
 *
 * @returns {{fraction:number, uniform:number, separation:number}}
 */
function parityStats(sample, x0, y0, sx, sy) {
  const values = new Float64Array(CELLS * CELLS);
  const probes = new Float64Array(CELLS * CELLS * PROBE_COUNT);
  const scratch = new Float64Array(PROBE_COUNT);
  for (let row = 0; row < CELLS; row++) {
    for (let col = 0; col < CELLS; col++) {
      const cell = row * CELLS + col;
      const left = x0 + col * sx;
      const top = y0 + row * sy;
      for (let p = 0; p < PROBE_COUNT; p++) {
        const [fx, fy] = PROBE_OFFSETS[p];
        const value = sample(left + fx * sx, top + fy * sy);
        probes[cell * PROBE_COUNT + p] = value;
        scratch[p] = value;
      }
      scratch.sort();
      values[cell] = scratch[PROBE_COUNT >> 1];
    }
  }

  // Best split of the sorted cell medians into "low" and "high": every cell has
  // a fixed parity (row+col)&1 and the optimal orientation is chosen, not assumed.
  const order = Array.from({ length: CELLS * CELLS }, (_, i) => i).sort(
    (a, b) => values[a] - values[b],
  );
  let bestAgree = 0;
  let evensLow = 0;
  for (let j = 0; j <= CELLS * CELLS; j++) {
    if (j > 0) {
      const idx = order[j - 1];
      if ((((idx / CELLS) | 0) + (idx % CELLS)) % 2 === 0) evensLow += 1;
    }
    const oddsLow = j - evensLow;
    const evensHigh = (CELLS * CELLS) / 2 - evensLow;
    const oddsHigh = (CELLS * CELLS) / 2 - oddsLow;
    const agree = Math.max(evensHigh + oddsLow, evensLow + oddsHigh);
    if (agree > bestAgree) bestAgree = agree;
  }

  const evenValues = [];
  const oddValues = [];
  for (let row = 0; row < CELLS; row++) {
    for (let col = 0; col < CELLS; col++) {
      const v = values[row * CELLS + col];
      if ((row + col) % 2 === 0) evenValues.push(v);
      else oddValues.push(v);
    }
  }
  const median = (list) => {
    list.sort((a, b) => a - b);
    const mid = list.length >> 1;
    return (list[mid - 1] + list[mid]) / 2;
  };
  const evenMedian = median(evenValues);
  const oddMedian = median(oddValues);
  const separation = Math.abs(evenMedian - oddMedian);
  const band = Math.max(2, PROBE_BAND * separation);
  const lightMedian = Math.max(evenMedian, oddMedian);
  const darkMedian = Math.min(evenMedian, oddMedian);

  // A cell is "split" when its probes match both square tones: a single square
  // has one colour, so the only way to see both is to straddle a real boundary.
  let splitCells = 0;
  for (let cell = 0; cell < CELLS * CELLS; cell++) {
    let matchesLight = false;
    let matchesDark = false;
    for (let p = 0; p < PROBE_COUNT; p++) {
      const value = probes[cell * PROBE_COUNT + p];
      if (Math.abs(value - lightMedian) <= band) matchesLight = true;
      else if (Math.abs(value - darkMedian) <= band) matchesDark = true;
      if (matchesLight && matchesDark) break;
    }
    if (matchesLight && matchesDark) splitCells += 1;
  }

  return {
    fraction: bestAgree / (CELLS * CELLS),
    uniform: 1 - splitCells / (CELLS * CELLS),
    separation,
  };
}

function parityScoreOf(stats) {
  const effective = Math.min(stats.fraction, stats.uniform);
  return (
    clamp01((effective - PARITY_BASE) / (PARITY_FULL - PARITY_BASE)) *
    clamp01(stats.separation / PARITY_SEP_FULL)
  );
}

/* ------------------------------------------------------- full-res refinement */

/**
 * Recompute one axis' projection on the original pixels around the coarse
 * winner and snap the 9 lines to their local gradient peaks (parabolic
 * sub-pixel refinement), then fit start/spacing by robust weighted least
 * squares. Returns null when the region is unusable.
 */
function refineAxis(frame, axis, start, spacing, otherStart, otherSpacing) {
  const { data, width, height } = frame;
  const margin = REFIT_MARGIN * spacing;
  const alongLimit = (axis === "x" ? width : height) - 2;
  const otherLimit = (axis === "x" ? height : width) - 2;
  const alongLo = Math.max(1, Math.floor(start - margin));
  const alongHi = Math.min(alongLimit, Math.ceil(start + CELLS * spacing + margin));
  const otherLo = Math.max(1, Math.floor(otherStart - margin));
  const otherHi = Math.min(otherLimit, Math.ceil(otherStart + CELLS * otherSpacing + margin));
  if (alongHi - alongLo < CELLS * spacing * 0.5) return null;
  if (otherHi - otherLo < CELLS * otherSpacing * 0.5) return null;

  const xLo = (axis === "x" ? alongLo : otherLo) - 1;
  const xHi = (axis === "x" ? alongHi : otherHi) + 1;
  const yLo = (axis === "x" ? otherLo : alongLo) - 1;
  const yHi = (axis === "x" ? otherHi : alongHi) + 1;
  const regionW = xHi - xLo + 1;
  const regionH = yHi - yLo + 1;

  // Luminance plane of the region, one pixel of padding for the differences.
  const lum = new Float32Array(regionW * regionH);
  for (let y = 0; y < regionH; y++) {
    const rowBase = clamp(yLo + y, 0, height - 1) * width;
    const outBase = y * regionW;
    for (let x = 0; x < regionW; x++) {
      const p = (rowBase + clamp(xLo + x, 0, width - 1)) * 4;
      lum[outBase + x] = luma(data[p], data[p + 1], data[p + 2]);
    }
  }

  // Projection along the axis: mean edge magnitude across the region.
  const n = alongHi - alongLo + 1;
  const grad = new Float64Array(n);
  if (axis === "x") {
    for (let x = alongLo; x <= alongHi; x++) {
      const i = x - xLo;
      let acc = 0;
      for (let j = 1; j < regionH - 1; j++) {
        const base = j * regionW;
        const d = lum[base + i + 1] - lum[base + i - 1];
        acc += d < 0 ? -d : d;
      }
      grad[x - alongLo] = acc / (regionH - 2);
    }
  } else {
    for (let y = alongLo; y <= alongHi; y++) {
      const j = y - yLo;
      let acc = 0;
      for (let i = 1; i < regionW - 1; i++) {
        const d = lum[(j + 1) * regionW + i] - lum[(j - 1) * regionW + i];
        acc += d < 0 ? -d : d;
      }
      grad[y - alongLo] = acc / (regionW - 2);
    }
  }

  const peak = peakify(grad);
  const ref = Math.max(REF_FLOOR, REF_MULTIPLIER * quantile(grad, REF_QUANTILE));
  const invRef = 1 / ref;
  const lineScoreAt = (p) => {
    const idx = (p + 0.5) | 0;
    if (idx < 0 || idx >= n) return -1;
    const v = peak[idx];
    return v >= ref ? 1 : v * invRef;
  };

  // Local joint (start, spacing) search at full resolution. The coarse pass can
  // be off by a pixel or two (and its spacing by a little more), and snapping
  // by strength alone would happily lock onto a row of aligned piece bases —
  // so first re-find the *whole lattice* here, scoring all 9 lines at once.
  const startWindow = Math.max(2, spacing * 0.08);
  const startStep = Math.max(0.25, spacing * 0.008);
  const spacingSpan = 0.04; // ±4%
  const spacingStep = 0.0025; // 0.25%
  const startCount = Math.ceil(startWindow / startStep);
  const spacingCount = Math.ceil(spacingSpan / spacingStep);
  let localStart = start;
  let localSpacing = spacing;
  let localScore = -1;
  for (let i = -spacingCount; i <= spacingCount; i++) {
    const candidateSpacing = spacing * (1 + spacingStep * i);
    if (candidateSpacing <= 2) continue;
    for (let j = -startCount; j <= startCount; j++) {
      const candidateStart = start + startStep * j;
      let total = 0;
      let weakest = Infinity;
      let ok = true;
      for (let k = 0; k < LINE_COUNT; k++) {
        const v = lineScoreAt(candidateStart + k * candidateSpacing - alongLo);
        if (v < 0) {
          ok = false;
          break;
        }
        total += v;
        if (v < weakest) weakest = v;
      }
      if (!ok) continue;
      const score = (1 - MIN_LINE_WEIGHT) * (total / LINE_COUNT) + MIN_LINE_WEIGHT * weakest;
      if (score > localScore) {
        localScore = score;
        localStart = candidateStart;
        localSpacing = candidateSpacing;
      }
    }
  }

  const window = Math.max(1.2, REFIT_WINDOW * localSpacing);
  const points = [];
  let strongest = 0;
  for (let k = 0; k < LINE_COUNT; k++) {
    const expected = localStart + k * localSpacing - alongLo;
    const from = Math.max(0, Math.round(expected - window));
    const to = Math.min(n - 1, Math.round(expected + window));
    let bestIdx = -1;
    let bestVal = -1;
    for (let i = from; i <= to; i++) {
      if (peak[i] > bestVal) {
        bestVal = peak[i];
        bestIdx = i;
      }
    }
    if (bestIdx < 0) continue;
    // Sub-pixel position: centroid of the gradient profile over a narrow
    // window around the peak. A 1-2 px edge produces a 2-tap plateau; the
    // centroid lands between the taps, while a parabolic fit would snap to one
    // side (systematic half-pixel bias).
    let pos = bestIdx;
    let num = 0;
    let den = 0;
    const cFrom = Math.max(0, bestIdx - 2);
    const cTo = Math.min(n - 1, bestIdx + 2);
    for (let i = cFrom; i <= cTo; i++) {
      const w = grad[i];
      num += i * w;
      den += w;
    }
    if (den > 0) pos = num / den;
    points.push({ k, pos: pos + alongLo, strength: bestVal });
    if (bestVal > strongest) strongest = bestVal;
  }
  if (points.length < LINE_COUNT || strongest <= 0) return null;

  const fitOnce = (pts) => {
    let sw = 0;
    let swk = 0;
    let swkk = 0;
    let swp = 0;
    let swkp = 0;
    for (const p of pts) {
      const w = Math.max(0, p.strength);
      sw += w;
      swk += w * p.k;
      swkk += w * p.k * p.k;
      swp += w * p.pos;
      swkp += w * p.k * p.pos;
    }
    const denom = sw * swkk - swk * swk;
    if (!(sw > 0) || Math.abs(denom) < 1e-9) return null;
    const slope = (sw * swkp - swk * swp) / denom;
    const intercept = (swp - slope * swk) / sw;
    return { start: intercept, spacing: slope };
  };

  let fit = fitOnce(points);
  if (!fit || !(fit.spacing > localSpacing * 0.5) || !(fit.spacing < localSpacing * 2)) return null;
  let accepted = points;
  for (let round = 0; round < 3; round++) {
    const kept = points.filter(
      (p) =>
        p.strength >= REFIT_MIN_STRENGTH * strongest &&
        Math.abs(p.pos - (fit.start + fit.spacing * p.k)) <= REFIT_MAX_RESIDUAL * localSpacing,
    );
    if (kept.length < REFIT_MIN_LINES) break;
    const next = fitOnce(kept);
    if (!next) break;
    fit = next;
    accepted = kept;
  }
  return {
    start: fit.start,
    spacing: fit.spacing,
    acceptedLines: accepted.map((p) => ({ k: p.k, pos: p.pos, strength: p.strength })),
    strongest,
  };
}

/* --------------------------------------------------------------- main entry */

/**
 * Locate the 8x8 board in one captured frame.
 *
 * @param {{data: Uint8ClampedArray|Uint8Array, width: number, height: number}} frame
 *   RGBA pixels, row-major — exactly what `ImageData` holds.
 * @param {object} [options] overrides for {@link LOCATOR_DEFAULTS}.
 * @returns {{ok: true, rect: {x:number,y:number,w:number,h:number},
 *   squareSize:number, confidence:number, method:string, diagnostics?:object}}
 *   or `{ok:false, reason:string, diagnostics?:object}`. `rect` is the 8x8 play
 *   area in frame (device) pixels, sub-pixel precise.
 */
export function locateBoard(frame, options = {}) {
  const opts = { ...LOCATOR_DEFAULTS, ...options };
  const { data, width, height } = frame ?? {};
  if (!data || !Number.isFinite(width) || !Number.isFinite(height)) {
    return { ok: false, reason: "invalid frame: expected {data, width, height}" };
  }
  if (width < 64 || height < 64) {
    return { ok: false, reason: `frame too small (${width}x${height}); need at least 64x64` };
  }
  if (data.length !== width * height * 4) {
    return {
      ok: false,
      reason: `invalid frame: ${data.length} bytes do not match ${width}x${height} RGBA (${width * height * 4})`,
    };
  }

  const scale = Math.max(1, Math.ceil(Math.max(width, height) / opts.maxAnalysisDim));
  const { lum, aw, ah } = analysisLuminance(data, width, height, scale);
  const sampleCoarse = makeSampler(lum, aw, ah);

  // Blank / uniform frame early-out.
  const contrast = sampledQuantile(lum, 0.95) - sampledQuantile(lum, 0.05);
  if (contrast < 6) {
    return {
      ok: false,
      reason: `frame has too little contrast (p95-p05 = ${contrast.toFixed(1)} luma); no board`,
    };
  }

  const { col, row } = projections(lum, aw, ah);
  const minSpacing = Math.max(2.5, opts.minSquare / scale);
  const maxSpacing = Math.min(aw, ah) / CELLS;
  if (maxSpacing < minSpacing) {
    return {
      ok: false,
      reason: `frame too small for a board: max square ${maxSpacing.toFixed(1)}px < minimum ${minSpacing.toFixed(1)}px`,
    };
  }

  const xCandidates = searchAxis(col, {
    minSpacing,
    maxSpacing,
    step: opts.coarseStep,
    keep: opts.maxCandidatesPerAxis,
  });
  const yCandidates = searchAxis(row, {
    minSpacing,
    maxSpacing,
    step: opts.coarseStep,
    keep: opts.maxCandidatesPerAxis,
  });
  if (xCandidates.length === 0 || yCandidates.length === 0) {
    return { ok: false, reason: "no evenly spaced grid lines found in either axis" };
  }

  // Rank x/y combinations by line evidence + two-tone parity. Ties on the
  // combined confidence are broken by the sharper line evidence (rawLine).
  let best = null;
  for (const cx of xCandidates) {
    for (const cy of yCandidates) {
      const stats = parityStats(sampleCoarse, cx.start, cy.start, cx.spacing, cy.spacing);
      const rawLine = (cx.score + cy.score) / 2;
      const midSpacing = (cx.spacing + cy.spacing) / 2;
      const mismatch = Math.abs(cx.spacing - cy.spacing) / midSpacing;
      const squareness = clamp01(
        1 - (mismatch - SQUARE_MISMATCH_OK) / (SQUARE_MISMATCH_SPAN - SQUARE_MISMATCH_OK),
      );
      const confidence =
        (WEIGHT_LINE * clamp01(rawLine / LINE_SCORE_CAP) + WEIGHT_PARITY * parityScoreOf(stats)) *
        squareness;
      if (
        !best ||
        confidence > best.confidence ||
        (Math.abs(confidence - best.confidence) < 1e-9 && rawLine > best.rawLine)
      ) {
        best = { confidence, rawLine, lineComponent: clamp01(rawLine / LINE_SCORE_CAP), cx, cy, stats };
      }
    }
  }

  // Full-resolution refit of the winner, then the authoritative parity check.
  // Analysis index i maps to frame pixel i*scale + (scale>>1) (block centre).
  const frameRef = { data, width, height };
  const coarseOffset = scale >> 1;
  const x0 = best.cx.start * scale + coarseOffset;
  const y0 = best.cy.start * scale + coarseOffset;
  const sx0 = best.cx.spacing * scale;
  const sy0 = best.cy.spacing * scale;
  const refinedX = refineAxis(frameRef, "x", x0, sx0, y0, sy0);
  const refinedY = refineAxis(frameRef, "y", y0, sy0, x0, sx0);
  let rx = refinedX ? refinedX.start : x0;
  let ry = refinedY ? refinedY.start : y0;
  let sx = refinedX ? refinedX.spacing : sx0;
  let sy = refinedY ? refinedY.spacing : sy0;
  if (Math.abs(sx - sy) <= SQUARE_TOLERANCE * Math.max(sx, sy)) {
    const mean = (sx + sy) / 2;
    sx = mean;
    sy = mean;
  }

  // The authoritative parity check runs on the *analysis* plane: its slight
  // blur makes the per-cell probes robust against thin piece outlines while
  // staying sharp enough to notice probes that fall into a neighbouring square.
  const fineStats = parityStats(
    sampleCoarse,
    (rx - coarseOffset) / scale,
    (ry - coarseOffset) / scale,
    sx / scale,
    sy / scale,
  );
  const fineParity = parityScoreOf(fineStats);
  const refinement = refinedLineScore(col, row, rx, ry, sx, sy, scale);
  const rawLine = Math.max(best.rawLine, refinement.score);
  const lineComponent = clamp01(rawLine / LINE_SCORE_CAP);
  const confidence = WEIGHT_LINE * lineComponent + WEIGHT_PARITY * fineParity;
  const method = `gradient-lattice-${refinement.lines === LINE_COUNT + 1 ? "10" : "9"}`;

  const diagnostics = opts.debug
    ? {
        scale,
        analysis: { width: aw, height: ah },
        xCandidates: xCandidates.slice(0, 5),
        yCandidates: yCandidates.slice(0, 5),
        coarse: {
          confidence: best.confidence,
          rawLine: best.rawLine,
          cx: best.cx,
          cy: best.cy,
          stats: best.stats,
        },
        refined: {
          x: refinedX,
          y: refinedY,
          stats: fineStats,
          rawLine,
        },
      }
    : undefined;

  const reasons = [];
  const effectiveParity = Math.min(fineStats.fraction, fineStats.uniform);
  if (effectiveParity < opts.minParityFraction) {
    reasons.push(
      `square colours only ${(fineStats.fraction * 100).toFixed(0)}% parity-consistent / ` +
        `${(fineStats.uniform * 100).toFixed(0)}% internally consistent (need ` +
        `${(opts.minParityFraction * 100).toFixed(0)}%)`,
    );
  }
  if (fineStats.separation < opts.minParitySeparation) {
    reasons.push(
      `alternating colours differ by only ${fineStats.separation.toFixed(1)} luma (need ${opts.minParitySeparation})`,
    );
  }
  if (confidence < opts.minConfidence) {
    reasons.push(
      `confidence ${confidence.toFixed(2)} < ${opts.minConfidence} (line ${lineComponent.toFixed(2)}, ` +
        `parity ${fineParity.toFixed(2)})`,
    );
  }
  if (reasons.length > 0) {
    return { ok: false, reason: `no 8x8 board found: ${reasons.join("; ")}`, diagnostics };
  }

  return {
    ok: true,
    rect: {
      x: clamp(rx, 0, width),
      y: clamp(ry, 0, height),
      w: CELLS * sx,
      h: CELLS * sy,
    },
    squareSize: (sx + sy) / 2,
    confidence,
    method,
    ...(diagnostics ? { diagnostics } : {}),
  };
}

/**
 * Line score of a refined (sub-pixel) lattice against the coarse analysis
 * projections, including the 10-line variant check — used for the reported
 * confidence; accept/reject is parity-driven.
 */
function refinedLineScore(col, row, rx, ry, sx, sy, scale) {
  const axisScore = (g, start, spacing) => {
    const peak = peakify(g);
    const ref = Math.max(REF_FLOOR, REF_MULTIPLIER * quantile(g, REF_QUANTILE));
    const scoreAt = (p) => {
      const idx = Math.round(p);
      if (idx < 0 || idx >= g.length) return -1;
      const v = peak[idx] / ref;
      return v > LINE_SCORE_CAP ? LINE_SCORE_CAP : v;
    };
    let total = 0;
    let weakest = Infinity;
    for (let k = 0; k < LINE_COUNT; k++) {
      const v = scoreAt((start + k * spacing) / scale);
      if (v < 0) return { score: 0, lines: LINE_COUNT };
      total += v;
      if (v < weakest) weakest = v;
    }
    let score = (1 - MIN_LINE_WEIGHT) * (total / LINE_COUNT) + MIN_LINE_WEIGHT * weakest;
    let lines = LINE_COUNT;
    for (const extra of [
      (start - spacing) / scale,
      (start + (CELLS + 1) * spacing) / scale,
    ]) {
      const v = scoreAt(extra);
      if (v <= 0) continue;
      const score10 =
        (1 - MIN_LINE_WEIGHT) * ((total + v) / (LINE_COUNT + 1)) +
        MIN_LINE_WEIGHT * Math.min(weakest, v);
      if (score10 > score) {
        score = score10;
        lines = LINE_COUNT + 1;
      }
    }
    return { score, lines };
  };
  const xs = axisScore(col, rx, sx);
  const ys = axisScore(row, ry, sy);
  return {
    score: (xs.score + ys.score) / 2,
    lines:
      xs.lines === LINE_COUNT + 1 || ys.lines === LINE_COUNT + 1 ? LINE_COUNT + 1 : LINE_COUNT,
  };
}

/* ------------------------------------------------------------- public utils */

/**
 * The 64 square rects of an 8x8 play-area rect, row-major with row 0 at the
 * TOP of the image (screen orientation; on a normally oriented board White
 * plays from the bottom). Coordinates are in the same space as the input rect.
 *
 * @param {{x:number, y:number, w:number, h:number}} rect
 * @returns {{x:number, y:number, w:number, h:number, row:number, col:number, index:number}[]}
 */
export function squaresForRect(rect) {
  const cw = rect.w / CELLS;
  const ch = rect.h / CELLS;
  const squares = [];
  for (let row = 0; row < CELLS; row++) {
    for (let col = 0; col < CELLS; col++) {
      squares.push({
        x: rect.x + col * cw,
        y: rect.y + row * ch,
        w: cw,
        h: ch,
        row,
        col,
        index: row * CELLS + col,
      });
    }
  }
  return squares;
}

/**
 * Normalise a frame-pixel rect to 0..1 fractions of the frame — the form
 * calibrations are stored in (`chrome.storage.local`, `settings.calibrations`,
 * keyed by hostname).
 */
export function toNormalizedRect(rect, frameWidth, frameHeight) {
  return {
    x: rect.x / frameWidth,
    y: rect.y / frameHeight,
    w: rect.w / frameWidth,
    h: rect.h / frameHeight,
  };
}

/** Inverse of {@link toNormalizedRect}. */
export function fromNormalizedRect(normalized, frameWidth, frameHeight) {
  return {
    x: normalized.x * frameWidth,
    y: normalized.y * frameHeight,
    w: normalized.w * frameWidth,
    h: normalized.h * frameHeight,
  };
}

/** Human-readable status fragment shared by the panel and the test tools. */
export function describeResult(result) {
  if (!result?.ok) return `board: not found — ${result?.reason ?? "unknown reason"}`;
  const { x, y } = result.rect;
  return (
    `board: ${result.squareSize.toFixed(1)}px squares at (${Math.round(x)}, ${Math.round(y)})` +
    ` · ${result.rect.w.toFixed(0)}x${result.rect.h.toFixed(0)}px` +
    ` · confidence ${result.confidence.toFixed(2)} · ${result.method}`
  );
}

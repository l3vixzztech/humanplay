#!/usr/bin/env node
/**
 * overlay-unit.mjs — zero-dep unit tests for
 * extension/src/content/overlay-geometry.js (Milestone 5: board arrow overlay).
 *
 * Runs in plain Node (no test framework, no packages) against the same file the
 * content script imports. Everything here is pure geometry: endpoints (square
 * centres) for normal + flipped boards, partially offscreen rects, DPR, the
 * thickness scaling, and the arrowhead orientation for all 8 directions.
 *
 * Usage:
 *   node test/tools/overlay-unit.mjs      # exit code 0 = all passed
 * Writes machine-readable results to
 *   test/fixtures/captures/overlay/overlay-unit.json
 */

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import {
  DEFAULTS,
  boardGridOf,
  boundsOfPoints,
  computeArrow,
  computeArrows,
  deviceCanvasSize,
  intersectsViewport,
  overlayZIndex,
  scalePoint,
  squareFromName,
  squareName,
  squareSize,
  squareToViewport,
  uciToSquares,
} from "../../extension/src/content/overlay-geometry.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const OUT_DIR = path.join(REPO_ROOT, "test/fixtures/captures/overlay");

/* --------------------------------------------------------------- harness */

const results = [];
let passed = 0;

async function test(name, fn) {
  const record = { name, pass: true, message: null, details: null };
  try {
    const details = await fn();
    if (details !== undefined) record.details = details;
    passed += 1;
    console.log(`ok   ${name}`);
  } catch (error) {
    record.pass = false;
    record.message = error?.message ?? String(error);
    console.log(`FAIL ${name}\n     ${record.message}`);
  }
  results.push(record);
}

function eq(actual, expected, label = "") {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) throw new Error(`${label}${label ? ": " : ""}expected ${b}, got ${a}`);
}

function ok(value, label = "value") {
  if (!value) throw new Error(`${label} should be truthy, got ${JSON.stringify(value)}`);
}

function near(actual, expected, tolerance = 1e-9, label = "") {
  if (!Number.isFinite(actual) || Math.abs(actual - expected) > tolerance) {
    throw new Error(`${label}${label ? ": " : ""}expected ${expected} ±${tolerance}, got ${actual}`);
  }
}

function nearPoint(actual, expected, tolerance = 1e-9, label = "") {
  near(actual?.x, expected.x, tolerance, `${label}.x`);
  near(actual?.y, expected.y, tolerance, `${label}.y`);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

/* -------------------------------------------------------------- fixtures */

/** A chess.com-like 560×560 board at (100, 100): 70 px squares. */
const RECT = { x: 100, y: 100, w: 560, h: 560 };
const RECT_FLIPPED = { x: 100, y: 100, w: 560, h: 560 };

/** Expected centre of e2/e4 etc. on the normal board (hand-computed). */
const EXPECTED = {
  normal: {
    // col = file, row = 7 - rank
    e2: { x: 415, y: 555 },
    e4: { x: 415, y: 415 },
    d2: { x: 345, y: 555 },
    d4: { x: 345, y: 415 },
    e5: { x: 415, y: 345 },
    f5: { x: 485, y: 345 },
    f3: { x: 485, y: 485 },
    e3: { x: 415, y: 485 },
    d3: { x: 345, y: 485 },
    d5: { x: 345, y: 345 },
    f4: { x: 485, y: 415 },
    a1: { x: 135, y: 625 },
    h8: { x: 625, y: 135 },
    b1: { x: 205, y: 625 },
    c3: { x: 275, y: 485 },
  },
};

/* ------------------------------------------------------------------ tests */

await test("uci: parses normal, castling and promotion moves; rejects garbage", () => {
  eq(uciToSquares("e2e4"), { from: { file: 4, rank: 1 }, to: { file: 4, rank: 3 }, promotion: null });
  eq(uciToSquares("e1g1"), { from: { file: 4, rank: 0 }, to: { file: 6, rank: 0 }, promotion: null });
  eq(uciToSquares("E7E8Q"), { from: { file: 4, rank: 6 }, to: { file: 4, rank: 7 }, promotion: "q" });
  eq(uciToSquares("b7b8n"), { from: { file: 1, rank: 6 }, to: { file: 1, rank: 7 }, promotion: "n" });
  eq(uciToSquares("e2e4x"), null, "trailing garbage");
  eq(uciToSquares("i2i4"), null, "off-board file");
  eq(uciToSquares(""), null, "empty");
  eq(uciToSquares(undefined), null, "undefined");
  eq(squareFromName("a1"), { file: 0, rank: 0 });
  eq(squareFromName("h8"), { file: 7, rank: 7 });
  eq(squareFromName("z9"), null);
  eq(squareName(4, 1), "e2");
});

await test("squares: size + centred grid for square and non-square rects", () => {
  eq(squareSize(RECT), 70);
  eq(boardGridOf(RECT), { x: 100, y: 100, size: 70 });
  // Non-square rect: the 8×8 grid stays square and is centred.
  eq(squareSize({ x: 0, y: 0, w: 700, h: 560 }), 70);
  eq(boardGridOf({ x: 0, y: 0, w: 700, h: 560 }), { x: 70, y: 0, size: 70 });
  eq(squareToViewport(4, 1, { x: 0, y: 0, w: 700, h: 560 }, false), { x: 70 + 4.5 * 70, y: 6.5 * 70 });
  eq(squareSize({ x: 0, y: 0, w: 0, h: 0 }), 0);
});

await test("normal board: endpoints are the exact square centres (e2e4)", () => {
  const arrow = computeArrow({ uci: "e2e4", rect: RECT, flipped: false });
  ok(arrow, "arrow");
  nearPoint(arrow.fromPt, EXPECTED.normal.e2, 1e-9, "fromPt");
  nearPoint(arrow.tip, EXPECTED.normal.e4, 1e-9, "tip");
  near(arrow.from.file, 4, 0, "from.file");
  near(arrow.from.rank, 1, 0, "from.rank");
  near(arrow.to.rank, 3, 0, "to.rank");
  near(arrow.squareSize, 70, 0, "squareSize");
  // a straight-line move: unit vector is exactly up (0, -1) in CSS px
  nearPoint(arrow.unit, { x: 0, y: -1 }, 1e-12, "unit");
  near(arrow.length, 140, 1e-9, "length");
  eq(arrow.drawable, true);
  // corners: a1 bottom-left, h8 top-right on a normal board
  nearPoint(squareToViewport(0, 0, RECT, false), EXPECTED.normal.a1, 1e-9, "a1");
  nearPoint(squareToViewport(7, 7, RECT, false), EXPECTED.normal.h8, 1e-9, "h8");
  eq(arrow.promotion, null);
  return { fromPt: arrow.fromPt, tip: arrow.tip, thickness: arrow.thickness, headLength: arrow.headLength, headWidth: arrow.headWidth };
});

await test("flipped board: screen mapping mirrors file and rank (e2e4)", () => {
  const arrow = computeArrow({ uci: "e2e4", rect: RECT_FLIPPED, flipped: true });
  ok(arrow, "arrow");
  // flipped: col = 7 - file, row = rank
  nearPoint(arrow.fromPt, { x: 100 + 3.5 * 70, y: 100 + 1.5 * 70 }, 1e-9, "fromPt");
  nearPoint(arrow.tip, { x: 100 + 3.5 * 70, y: 100 + 3.5 * 70 }, 1e-9, "tip");
  nearPoint(arrow.unit, { x: 0, y: 1 }, 1e-12, "unit (the e-pawn now advances DOWN the screen)");
  // a1 flips to the bottom-right, h8 to the top-left
  nearPoint(squareToViewport(0, 0, RECT, true), { x: 100 + 7.5 * 70, y: 100 + 0.5 * 70 }, 1e-9, "a1 flipped");
  nearPoint(squareToViewport(7, 7, RECT, true), { x: 100 + 0.5 * 70, y: 100 + 7.5 * 70 }, 1e-9, "h8 flipped");
  return { fromPt: arrow.fromPt, tip: arrow.tip };
});

await test("flipped: knight move b1c3 maps to the mirrored columns", () => {
  const normal = computeArrow({ uci: "b1c3", rect: RECT, flipped: false });
  const flipped = computeArrow({ uci: "b1c3", rect: RECT, flipped: true });
  nearPoint(normal.fromPt, EXPECTED.normal.b1, 1e-9, "b1 normal");
  nearPoint(normal.tip, EXPECTED.normal.c3, 1e-9, "c3 normal");
  // b1 file 1 -> col 6; c3 file 2 -> col 5
  nearPoint(flipped.fromPt, { x: 100 + 6.5 * 70, y: 100 + 0.5 * 70 }, 1e-9, "b1 flipped");
  nearPoint(flipped.tip, { x: 100 + 5.5 * 70, y: 100 + 2.5 * 70 }, 1e-9, "c3 flipped");
});

await test("arrowhead points along the move for all 8 directions", () => {
  const DIRS = [
    ["e4e5", { x: 0, y: -1 }, "N"],
    ["e4f5", { x: Math.SQRT1_2, y: -Math.SQRT1_2 }, "NE"],
    ["e4f4", { x: 1, y: 0 }, "E"],
    ["e4f3", { x: Math.SQRT1_2, y: Math.SQRT1_2 }, "SE"],
    ["e4e3", { x: 0, y: 1 }, "S"],
    ["e4d3", { x: -Math.SQRT1_2, y: Math.SQRT1_2 }, "SW"],
    ["e4d4", { x: -1, y: 0 }, "W"],
    ["e4d5", { x: -Math.SQRT1_2, y: -Math.SQRT1_2 }, "NW"],
  ];
  const summary = [];
  for (const [uci, expectedUnit, label] of DIRS) {
    const arrow = computeArrow({ uci, rect: RECT, flipped: false });
    ok(arrow, `${label} arrow`);
    nearPoint(arrow.unit, expectedUnit, 1e-12, `${label} unit`);
    // tip is the target centre; the head polygon starts at the tip
    nearPoint(arrow.tip, squareToViewport(arrow.to.file, arrow.to.rank, RECT, false), 1e-9, `${label} tip`);
    eq(arrow.head.length, 3, `${label} head points`);
    nearPoint(arrow.head[0], arrow.tip, 1e-9, `${label} head[0] == tip`);
    // base is headLength behind the tip along the direction
    nearPoint(arrow.base, { x: arrow.tip.x - arrow.unit.x * arrow.headLength, y: arrow.tip.y - arrow.unit.y * arrow.headLength }, 1e-9, `${label} base`);
    // the two base corners are symmetric around the shaft axis at headWidth/2
    const arm1 = { x: arrow.head[1].x - arrow.base.x, y: arrow.head[1].y - arrow.base.y };
    const arm2 = { x: arrow.head[2].x - arrow.base.x, y: arrow.head[2].y - arrow.base.y };
    near(Math.hypot(arm1.x, arm1.y), arrow.headWidth / 2, 1e-9, `${label} arm1 length`);
    near(Math.hypot(arm2.x, arm2.y), arrow.headWidth / 2, 1e-9, `${label} arm2 length`);
    // arms are perpendicular to the direction (dot ~ 0)
    near(arm1.x * arrow.unit.x + arm1.y * arrow.unit.y, 0, 1e-9, `${label} arm1 ⊥ unit`);
    near(arm2.x * arrow.unit.x + arm2.y * arrow.unit.y, 0, 1e-9, `${label} arm2 ⊥ unit`);
    // and opposite to each other
    near(arm1.x + arm2.x, 0, 1e-9, `${label} arms cancel x`);
    near(arm1.y + arm2.y, 0, 1e-9, `${label} arms cancel y`);
    // the whole head lies behind the tip (never in front of it)
    for (const point of arrow.head) {
      const along = (point.x - arrow.tip.x) * arrow.unit.x + (point.y - arrow.tip.y) * arrow.unit.y;
      assert(along <= 1e-9, `${label}: head point ${JSON.stringify(point)} is in front of the tip`);
    }
    // shaft: from the source centre to the head base, never longer than the span
    nearPoint(arrow.shaft.from, arrow.fromPt, 1e-9, `${label} shaft.from`);
    nearPoint(arrow.shaft.to, arrow.base, 1e-9, `${label} shaft.to`);
    assert(arrow.headLength > 0 && arrow.headLength <= arrow.length * 0.8 + 1e-9, `${label} headLength vs length`);
    summary.push({ uci, unit: arrow.unit, tip: arrow.tip, headLength: Number(arrow.headLength.toFixed(3)) });
  }
  eq(summary.length, 8);
  return summary;
});

await test("partially offscreen rects: endpoints stay exact, viewport flag is computed", () => {
  const viewport = { w: 1280, h: 800 };
  const rect = { x: -150, y: -80, w: 560, h: 560 };
  const arrow = computeArrow({ uci: "e2e4", rect, flipped: false, viewport });
  // hand-computed: -150 + 4.5*70 = 165 ; -80 + 6.5*70 = 375
  nearPoint(arrow.fromPt, { x: 165, y: 375 }, 1e-9, "fromPt");
  nearPoint(arrow.tip, { x: 165, y: 235 }, 1e-9, "tip");
  eq(arrow.intersectsViewport, true, "overlapping arrow intersects the viewport");
  eq(intersectsViewport(arrow, viewport), true, "helper agrees");

  const far = computeArrow({ uci: "e2e4", rect: { x: -3000, y: 0, w: 560, h: 560 }, flipped: false, viewport });
  eq(far.intersectsViewport, false, "fully offscreen arrow");
  eq(intersectsViewport(far, viewport), false, "helper agrees");
  // partially below/right of the viewport is still a valid, finite geometry
  const corner = computeArrow({ uci: "a1h8", rect: { x: 900, y: 600, w: 560, h: 560 }, flipped: false, viewport });
  ok(Number.isFinite(corner.tip.x) && Number.isFinite(corner.tip.y), "finite tip");
  eq(corner.intersectsViewport, true, "corner arrow intersects");
  return { overlapping: arrow.fromPt, offscreenIntersects: far.intersectsViewport };
});

await test("DPR: canvas bitmap scales, geometry stays in CSS pixels", () => {
  eq(deviceCanvasSize({ w: 1280, h: 800 }, 2), { width: 2560, height: 1600, dpr: 2 });
  eq(deviceCanvasSize({ w: 1100, h: 757 }, 1), { width: 1100, height: 757, dpr: 1 });
  eq(deviceCanvasSize({ w: 1001, h: 999 }, 1.25), { width: 1251, height: 1249, dpr: 1.25 });
  eq(deviceCanvasSize({ w: 0, h: 0 }, 2), { width: 1, height: 1, dpr: 2 }, "never 0-sized");
  nearPoint(scalePoint({ x: 415, y: 555 }, 2), { x: 830, y: 1110 }, 1e-9, "scalePoint");
  const at1 = computeArrow({ uci: "e2e4", rect: RECT });
  const at2 = computeArrow({ uci: "e2e4", rect: RECT });
  eq(at1, at2, "geometry is DPR-independent (identical inputs)");
  return { device: deviceCanvasSize({ w: 1280, h: 800 }, 2) };
});

await test("thickness scales with the square size and is clamped for tiny/huge boards", () => {
  const normal = computeArrow({ uci: "e2e4", rect: RECT });
  const half = computeArrow({ uci: "e2e4", rect: { x: 0, y: 0, w: 280, h: 280 } });
  const mini = computeArrow({ uci: "e2e4", rect: { x: 0, y: 0, w: 160, h: 160 } });
  const huge = computeArrow({ uci: "e2e4", rect: { x: 0, y: 0, w: 4000, h: 4000 } });
  near(normal.thickness, 70 * DEFAULTS.thicknessRatio, 1e-9, "70 px square");
  near(half.thickness, 35 * DEFAULTS.thicknessRatio, 1e-9, "35 px square");
  near(mini.thickness, 20 * DEFAULTS.thicknessRatio, 1e-9, "20 px square");
  eq(huge.thickness, DEFAULTS.maxThickness, "huge board clamps to maxThickness");
  assert(huge.thickness <= 500 * 0.5 + 1e-9, "never wider than half a square");
  assert(normal.thickness > half.thickness && half.thickness > mini.thickness, "monotonic scaling");

  const tiny = computeArrow({ uci: "e2e4", rect: { x: 0, y: 0, w: 40, h: 40 } });
  near(tiny.thickness, DEFAULTS.minThickness, 1e-9, "5 px square -> minThickness");
  eq(tiny.drawable, true, "5 px squares are still drawable");
  const absurd = computeArrow({ uci: "e2e4", rect: { x: 0, y: 0, w: 24, h: 24 } });
  eq(absurd.drawable, false, "3 px squares are not drawable");
  // a 3 px board is not painted at all; the thickness stays at the visible floor
  assert(absurd.thickness <= DEFAULTS.minThickness + 1e-9, "tiny board keeps minThickness");
  return { thicknesses: { normal: normal.thickness, half: half.thickness, mini: mini.thickness, huge: huge.thickness, tiny: tiny.thickness } };
});

await test("alternatives are thinner than the top-1 arrow", () => {
  const rect = RECT;
  const top = computeArrow({ uci: "b1c3", rect, rank: 0 });
  const alt = computeArrow({ uci: "h2h3", rect, rank: 1 });
  assert(alt.thickness < top.thickness, `alt ${alt.thickness} vs top ${top.thickness}`);
  near(top.thickness, 70 * DEFAULTS.thicknessRatio, 1e-9, "top thickness");
  near(alt.thickness, 70 * DEFAULTS.altThicknessRatio, 1e-9, "alt thickness");
  eq(top.rank, 0);
  eq(alt.rank, 1);
});

await test("computeArrows: topN limits the list, ranks are ordered, bad entries skipped", () => {
  const moves = [
    { uci: "b1c3", san: "Nc3", prob: 0.585868 },
    { uci: "h2h3", san: "h3", prob: 0.16039 },
    { uci: "c2c3", san: "c3", prob: 0.129875 },
  ];
  const one = computeArrows({ moves, rect: RECT, topN: 1 });
  eq(one.length, 1);
  eq(one[0].uci, "b1c3");
  eq(one[0].san, "Nc3");
  near(one[0].prob, 0.585868, 1e-9, "prob copied");

  const three = computeArrows({ moves, rect: RECT, topN: 3 });
  eq(three.map((arrow) => arrow.uci), ["b1c3", "h2h3", "c2c3"]);
  eq(three.map((arrow) => arrow.rank), [0, 1, 2]);
  assert(three[0].thickness > three[1].thickness && three[1].thickness >= three[2].thickness, "ranking visible in thickness");

  const skip = computeArrows({ moves: [{ uci: "bogus" }, { uci: "e2e4" }], rect: RECT, topN: 5 });
  eq(skip.map((arrow) => arrow.uci), ["e2e4"], "invalid entries are skipped");
  eq(computeArrows({ moves: [], rect: RECT }).length, 0, "no moves -> no arrows");
  eq(computeArrows({ moves, rect: RECT, topN: 0 }).length, 0, "topN 0 -> no arrows");
});

await test("degenerate inputs return null instead of NaN geometry", () => {
  eq(computeArrow({ uci: "e2e4", rect: { x: 0, y: 0, w: 0, h: 560 } }), null, "zero width");
  eq(computeArrow({ uci: "e2e4", rect: { x: 0, y: 0, w: 560, h: 0 } }), null, "zero height");
  eq(computeArrow({ uci: "not-a-move", rect: RECT }), null, "bad uci");
  eq(computeArrow({ uci: "e2e2", rect: RECT }), null, "same square");
  eq(computeArrow({}), null, "empty input");
});

await test("bounds + z-index helpers", () => {
  const arrow = computeArrow({ uci: "e2e4", rect: RECT });
  const bounds = boundsOfPoints([arrow.head[1], arrow.head[2], arrow.tip, arrow.fromPt]);
  assert(bounds.minX <= arrow.fromPt.x + 1e-9 && bounds.maxX >= arrow.fromPt.x, "bounds span the shaft");
  assert(arrow.bounds.minX < arrow.fromPt.x && arrow.bounds.maxY > arrow.fromPt.y, "stroke inflated bounds");
  eq(boundsOfPoints([]), { minX: 0, minY: 0, maxX: 0, maxY: 0 });
  eq(overlayZIndex(0), 40);
  eq(overlayZIndex(12), 40);
  eq(overlayZIndex(80), 81);
  eq(overlayZIndex(null), 40);
  eq(overlayZIndex(undefined, { min: 10 }), 10);
  return { bounds: arrow.bounds };
});

/* ----------------------------------------------------------------- report */

await mkdir(OUT_DIR, { recursive: true });
const summary = {
  tool: "overlay-unit.mjs",
  generatedAt: new Date().toISOString(),
  module: "extension/src/content/overlay-geometry.js",
  passed,
  failed: results.length - passed,
  total: results.length,
  results,
};
await writeFile(path.join(OUT_DIR, "overlay-unit.json"), `${JSON.stringify(summary, null, 2)}\n`);
console.log(`\n${passed}/${results.length} passed (overlay-unit.json)`);
if (failed()) process.exitCode = 1;
function failed() {
  return results.some((record) => !record.pass);
}

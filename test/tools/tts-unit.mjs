#!/usr/bin/env node
/**
 * tts-unit.mjs — zero-dep unit tests for the M6 TTS modules
 * (extension/src/tts/move-speech.js + extension/src/tts/tts-policy.js).
 *
 * Runs in plain Node (no test framework, no packages) against the exact files
 * the panel imports. Covers the SAN -> speech matrix from the M6 spec plus the
 * pure speak-policy helpers (decision truth table, dedupe store, rate clamp).
 *
 * Usage:
 *   node test/tools/tts-unit.mjs          # exit code 0 = all passed
 * Writes machine-readable results to
 *   test/fixtures/captures/tts/tts-unit.json
 */

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { moveToSpeech, sanToSpeech, uciToSpeech } from "../../extension/src/tts/move-speech.js";
import {
  DEFAULT_SPOKEN_KEY_LIMIT,
  DEFAULT_TTS_RATE,
  TTS_RATES,
  clampRate,
  createSpokenKeyStore,
  normalizeTtsSettings,
  speakDecision,
} from "../../extension/src/tts/tts-policy.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const OUT_DIR = path.join(REPO_ROOT, "test/fixtures/captures/tts");

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

/* ------------------------------------------- the M6 spec matrix (verbatim) */

await test("formatter: the M6 spec matrix", () => {
  const matrix = [
    ["Nf3", "Knight to f3"],
    ["exd5", "e-pawn takes d5"],
    ["O-O", "Castle kingside"],
    ["O-O-O", "Castle queenside"],
    ["e8=Q+", "Promote to queen on e8, check"],
    ["gxh8=N#", "g-pawn takes h8, promote to knight, mate"],
    ["Nbd2", "b-knight to d2"],
    ["R1e2", "rook one to e2"],
    ["Bxh7+", "Bishop takes h7, check"],
  ];
  for (const [san, spoken] of matrix) eq(sanToSpeech(san), spoken, san);
  eq(moveToSpeech({ san: "??unparseable", uci: "e2e4" }), "move e2 to e4", "UCI fallback");
  return matrix;
});

await test("formatter: every piece, quiet and capturing", () => {
  eq(sanToSpeech("e4"), "e-pawn to e4", "pawn push");
  eq(sanToSpeech("d5"), "d-pawn to d5", "pawn push d");
  eq(sanToSpeech("h3"), "h-pawn to h3", "pawn push h");
  eq(sanToSpeech("Nf3"), "Knight to f3", "knight");
  eq(sanToSpeech("Nxf3"), "Knight takes f3", "knight capture");
  eq(sanToSpeech("Bbd7"), "b-bishop to d7", "file-disambiguated bishop");
  eq(sanToSpeech("Bxd7"), "Bishop takes d7", "bishop capture");
  eq(sanToSpeech("Rd1"), "Rook to d1", "rook");
  eq(sanToSpeech("R2a3"), "rook two to a3", "rank-disambiguated rook");
  eq(sanToSpeech("Qxd5"), "Queen takes d5", "queen capture");
  eq(sanToSpeech("Qh4xe1"), "queen h4 takes e1", "fully disambiguated queen");
  eq(sanToSpeech("Kxe2"), "King takes e2", "king capture");
  eq(sanToSpeech("Ngxf3"), "g-knight takes f3", "file-disambiguated knight capture");
  return true;
});

await test("formatter: check/mate suffixes and annotations", () => {
  eq(sanToSpeech("Qh5+"), "Queen to h5, check", "check");
  eq(sanToSpeech("Qh5#"), "Queen to h5, mate", "mate");
  eq(sanToSpeech("O-O+"), "Castle kingside, check", "castling check");
  eq(sanToSpeech("O-O-O#"), "Castle queenside, mate", "castling mate");
  eq(sanToSpeech("Qh5++"), "Queen to h5, check", "double check");
  eq(sanToSpeech("Nf3!"), "Knight to f3", "annotation !");
  eq(sanToSpeech("e4?!"), "e-pawn to e4", "annotation ?!");
  eq(sanToSpeech("Qh5#!"), "Queen to h5, mate", "mate + annotation");
  eq(sanToSpeech("0-0"), "Castle kingside", "zero castling");
  eq(sanToSpeech("0-0-0"), "Castle queenside", "zero castling long");
  return true;
});

await test("formatter: promotions (quiet, capture, checks) and en passant", () => {
  eq(sanToSpeech("e8=Q"), "Promote to queen on e8", "quiet promotion");
  eq(sanToSpeech("d8=Q"), "Promote to queen on d8", "quiet promotion d");
  eq(sanToSpeech("d8Q"), "Promote to queen on d8", "promotion without =");
  eq(sanToSpeech("b8=N#"), "Promote to knight on b8, mate", "promotion to knight, mate");
  eq(sanToSpeech("exd8=Q"), "e-pawn takes d8, promote to queen", "capture promotion");
  eq(sanToSpeech("exd8=Q+"), "e-pawn takes d8, promote to queen, check", "capture promotion check");
  eq(sanToSpeech("gxh8=R#"), "g-pawn takes h8, promote to rook, mate", "capture promotion mate");
  // En passant reads exactly like a pawn capture; the marker is stripped.
  eq(sanToSpeech("exd6"), "e-pawn takes d6", "en passant");
  eq(sanToSpeech("exd6 e.p."), "e-pawn takes d6", "en passant marker");
  eq(sanToSpeech("exd6e.p."), "e-pawn takes d6", "en passant marker without space");
  return true;
});

await test("formatter: empty/invalid input -> null (never speak garbage)", () => {
  const invalid = [
    "",
    "   ",
    null,
    undefined,
    42,
    {},
    "zzz",
    "1234",
    "Nf9",
    "e9",
    "O-O-O-O",
    "-",
    "+",
    "#",
    "x",
    "xd5",
    "1d5",
    "ed5",
    "d5=Q=Q",
    "Nxf3q",
    "castles",
    "e2e4", // UCI-looking strings are not SAN
  ];
  for (const value of invalid) eq(sanToSpeech(value), null, JSON.stringify(value));
  return invalid.length;
});

await test("uciToSpeech: fallback phrasing + promotion + invalid", () => {
  eq(uciToSpeech("e2e4"), "move e2 to e4", "e2e4");
  eq(uciToSpeech("e1g1"), "move e1 to g1", "castling UCI (no board: coordinates only)");
  eq(uciToSpeech("a7a8q"), "move a7 to a8, promote to queen", "promotion");
  eq(uciToSpeech("E7E8Q"), "move e7 to e8, promote to queen", "uppercase");
  eq(uciToSpeech("b7b8n+"), null, "suffix is not UCI");
  eq(uciToSpeech("e2"), null, "too short");
  eq(uciToSpeech("e2e9"), null, "bad rank");
  eq(uciToSpeech(""), null, "empty");
  eq(uciToSpeech(null), null, "null");
  return true;
});

await test("moveToSpeech: string / object forms and fallback precedence", () => {
  eq(moveToSpeech("Nf3"), "Knight to f3", "SAN string");
  eq(moveToSpeech("e2e4"), "move e2 to e4", "UCI string");
  eq(moveToSpeech({ san: "Nf3", uci: "g1f3" }), "Knight to f3", "object prefers SAN");
  eq(moveToSpeech({ san: null, uci: "e2e4" }), "move e2 to e4", "object UCI only");
  eq(moveToSpeech({ san: "Nf3" }), "Knight to f3", "object SAN only");
  eq(moveToSpeech({ san: "??", uci: "g1f3" }), "move g1 to f3", "unparseable SAN falls back");
  eq(moveToSpeech({ san: "e2e4", uci: "e2e4" }), "move e2 to e4", "UCI in the san field");
  eq(moveToSpeech({ san: "", uci: "" }), null, "empty object");
  eq(moveToSpeech(null), null, "null");
  eq(moveToSpeech(""), null, "empty string");
  eq(moveToSpeech({ san: "??", uci: "??" }), null, "nothing parseable");
  eq(moveToSpeech({ san: "Nf3", uci: "g1f3" }, { preferUci: true }), "move g1 to f3", "preferUci");
  return true;
});

/* ------------------------------------------------------ pure policy helpers */

await test("clampRate: 0.5..2, 2 decimals, fallback on garbage", () => {
  eq(clampRate(1), 1, "1");
  eq(clampRate("1.2"), 1.2, "string");
  eq(clampRate(0.3), 0.5, "low clamp");
  eq(clampRate(9), 2, "high clamp");
  eq(clampRate(0.855), 0.86, "rounds to 2 decimals");
  eq(clampRate(NaN), DEFAULT_TTS_RATE, "NaN");
  eq(clampRate(undefined), DEFAULT_TTS_RATE, "undefined");
  eq(clampRate(null, 1.2), 1.2, "custom fallback");
  eq(TTS_RATES, [0.8, 1, 1.2], "offered rates");
  return true;
});

await test("createSpokenKeyStore: dedupe with bounded LRU eviction", () => {
  const store = createSpokenKeyStore(3);
  eq(store.size(), 0, "empty");
  eq(store.mark("a"), true, "a new");
  eq(store.mark("a"), false, "a again");
  eq(store.mark("b"), true, "b new");
  eq(store.mark("c"), true, "c new");
  eq(store.mark("d"), true, "d new -> evicts a");
  eq(store.has("a"), false, "a evicted");
  eq(store.has("b"), true, "b kept");
  eq(store.size(), 3, "bounded");
  eq(store.keys(), ["b", "c", "d"], "insertion order");
  eq(store.mark("b"), false, "re-mark keeps membership");
  eq(store.keys(), ["c", "d", "b"], "re-mark moves to the end");
  eq(store.forget("c"), true, "forget");
  eq(store.clear(), 2, "clear returns the count");
  eq(store.size(), 0, "cleared");
  const big = createSpokenKeyStore();
  for (let i = 0; i < DEFAULT_SPOKEN_KEY_LIMIT + 5; i += 1) big.mark(`k${i}`);
  eq(big.size(), DEFAULT_SPOKEN_KEY_LIMIT, "default bound");
  return true;
});

await test("speakDecision: speak iff enabled + assistant + your turn + current key + new key", () => {
  const state = { ok: true, turn: "w", userColor: "white" };
  const suggestion = { key: "fen|e2e4|2400|2400|3", moves: [{ uci: "e2e4", san: "e4" }] };
  const base = { ttsEnabled: true, assistantEnabled: true, state, suggestion, currentKey: suggestion.key, spokenKeys: createSpokenKeyStore() };
  eq(speakDecision(base), { speak: true, reason: "speak", key: suggestion.key }, "all good");
  return true;
});

await test("speakDecision: the never-speak cases", () => {
  const state = { ok: true, turn: "w", userColor: "white" };
  const suggestion = { key: "k1", moves: [{ san: "e4" }] };
  const spoken = createSpokenKeyStore();
  const call = (patch) =>
    speakDecision({
      ttsEnabled: true,
      assistantEnabled: true,
      state,
      suggestion,
      currentKey: "k1",
      spokenKeys: spoken,
      ...patch,
    });

  eq(call({ ttsEnabled: false }).reason, "tts-off", "TTS off (the default)");
  eq(call({ assistantEnabled: false }).reason, "assistant-off", "assistant off");
  eq(call({ state: null }).reason, "no-state", "no state");
  eq(call({ state: { ok: false, reason: "no board" } }).reason, "no-state", "state not ok");
  eq(call({ state: { ...state, userColor: null } }).reason, "no-color", "color unknown");
  eq(call({ state: { ok: true, turn: "b", userColor: "white" } }).reason, "not-your-turn", "their turn");
  eq(call({ state: { ok: true, turn: "black", userColor: "black" } }).speak, true, "turn/color string forms");
  eq(call({ state: { ok: true, turn: "w", userColor: "black" } }).reason, "not-your-turn", "their turn (black user)");
  eq(call({ suggestion: null }).reason, "no-suggestion", "no suggestion");
  eq(call({ suggestion: { key: "k1", moves: [] } }).reason, "no-suggestion", "game over (moves:[])");
  eq(call({ suggestion: { key: null, moves: [{ san: "e4" }] } }).reason, "no-key", "no key");
  eq(call({ currentKey: "k2" }).reason, "stale", "stale result");
  eq(call({ currentKey: null }).speak, true, "no current key given -> stale check skipped");

  spoken.mark("k1");
  eq(call({}).reason, "duplicate", "already spoken");
  eq(call({ ignoreDuplicate: true }), { speak: true, reason: "forced", key: "k1" }, "force bypasses only the dedupe");
  eq(call({ ignoreDuplicate: true, ttsEnabled: false }).reason, "tts-off", "force does not bypass the toggle");
  eq(call({ ignoreDuplicate: true, state: { ok: true, turn: "b", userColor: "white" } }).reason, "not-your-turn", "force does not bypass the turn");
  eq(call({ ignoreDuplicate: true, suggestion: { key: "k1", moves: [] } }).reason, "no-suggestion", "force needs a suggestion");
  return true;
});

await test("normalizeTtsSettings: defaults + clamping", () => {
  eq(normalizeTtsSettings(undefined), { enabled: false, rate: 1 }, "defaults: OFF");
  eq(normalizeTtsSettings({}), { enabled: false, rate: 1 }, "empty settings");
  eq(normalizeTtsSettings({ ttsEnabled: true }), { enabled: true, rate: 1 }, "enabled");
  eq(normalizeTtsSettings({ ttsEnabled: "yes" }), { enabled: false, rate: 1 }, "truthy strings do not count");
  eq(normalizeTtsSettings({ ttsEnabled: true, ttsRate: "1.2" }), { enabled: true, rate: 1.2 }, "rate");
  eq(normalizeTtsSettings({ ttsRate: 99 }), { enabled: false, rate: 2 }, "rate clamped");
  return true;
});

/* ------------------------------------------------------------------ done */

const failed = results.filter((record) => !record.pass);
const summary = {
  tool: "tts-unit.mjs",
  generatedAt: new Date().toISOString(),
  node: process.version,
  modules: ["extension/src/tts/move-speech.js", "extension/src/tts/tts-policy.js"],
  passed,
  failed: failed.length,
  total: results.length,
  cases: results,
};
await mkdir(OUT_DIR, { recursive: true });
await writeFile(path.join(OUT_DIR, "tts-unit.json"), `${JSON.stringify(summary, null, 2)}\n`);

console.log(`\n${passed} passed, ${failed.length} failed`);
console.log(`results: ${path.relative(REPO_ROOT, path.join(OUT_DIR, "tts-unit.json"))}`);
if (failed.length > 0) {
  console.log("failures:");
  for (const failure of failed) console.log(` - ${failure.name}: ${failure.message}`);
  process.exitCode = 1;
}

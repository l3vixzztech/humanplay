#!/usr/bin/env node
/**
 * premove-unit.mjs — zero-dep unit tests for the M7 premove client
 * (extension/src/analysis/premove-client.js) + the premove speech seam
 * (move-speech.js `premoveSpeech`, tts-policy.js `premoveSpeakDecision`).
 *
 * Runs in plain Node (no test framework, no packages) with an **injected
 * fetch**, so no server is needed and every failure mode (timeout, connection
 * refused, 4xx/5xx, malformed body, out-of-order responses) is deterministic.
 *
 * The canned premove bodies mirror the frozen server contract — the same shape
 * test/tools/fixture_server.py serves (recorded from the real server) and
 * test/tools/premove-proof.mjs cross-checks against it.
 *
 * Usage:
 *   node test/tools/premove-unit.mjs          # exit code 0 = all passed
 * Writes machine-readable results to
 *   test/fixtures/captures/premove/premove-unit.json
 */

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import {
  ERROR_CLASSES,
  PREMOVE_DEFAULT_MIN_SAFETY,
  PREMOVE_DEFAULT_MODE,
  PREMOVE_DEFAULT_TOP_N,
  PREMOVE_URL,
  buildPremoveRequest,
  clampMinSafety,
  clampTopN,
  createPremoveClient,
  criterionLabel,
  normalizePremoveMode,
  premove,
  premoveCaveat,
  premoveGate,
  premovePositionKey,
} from "../../extension/src/analysis/premove-client.js";
import { premoveSpeech, moveToSpeech } from "../../extension/src/tts/move-speech.js";
import { createSpokenKeyStore, premoveSpeakDecision, premoveSpokenKey } from "../../extension/src/tts/tts-policy.js";
import { STARTPOS_FEN } from "../../extension/src/analysis/analyze-client.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const OUT_DIR = path.join(REPO_ROOT, "test/fixtures/captures/premove");

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

function includes(haystack, needle, label = "text") {
  if (!String(haystack).includes(needle)) {
    throw new Error(`${label} should include ${JSON.stringify(needle)}, got ${JSON.stringify(haystack)}`);
  }
}

/* ------------------------------------------------------- injected fetches */

const BENONI_UCI = ["d2d4", "g8f6", "c2c4", "c7c5", "d4d5", "e7e6", "b1c3"];

/** A Response-like object good enough for the client (only .ok/.status/.text used). */
function jsonResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
    json: async () => (typeof body === "string" ? JSON.parse(body) : body),
  };
}

/** The canned body recorded from the real server (fixture_server CANNED_PREMOVE). */
function cannedPlan({ recommended = { uci: "c4d5", san: "cxd5", criterion: "safe_vs_all", safety: 1.0, min_response_prob: 0.983822, detail: "…" } } = {}) {
  return {
    fen: "rnbqkb1r/pp1p1ppp/4pn2/2pP4/2P5/2N5/PP2PPPP/R1BQKBNR b KQkq - 1 4",
    side_to_move: "black",
    opponent: [
      { uci: "e6d5", san: "exd5", prob: 0.963476 },
      { uci: "d7d6", san: "d6", prob: 0.021384 },
    ],
    recommended,
    candidates: [
      { uci: "c4d5", san: "cxd5", safe_mass: 0.963476, guard_mass: 0.036524, min_response_prob: 0.983822, verdict: "recommended", why: "safety 100% >= 90%" },
      { uci: "e2e4", san: "e4", safe_mass: 0.025437, guard_mass: 0, min_response_prob: 0.727735, verdict: "not_safe", why: "safety 3% < required 90%" },
    ],
    excluded: [],
    reason: null,
    params: { elo_self: 2400, elo_oppo: 2400, top_n: 5, min_safety: 0.9, min_response_prob: 0.15, mode: "top" },
    timings_ms: { root: 15.05, responses: 50.99, total: 69.14 },
    model: "maia3-5m",
    elapsed_ms: 69.14,
  };
}

const REQUEST = {
  fen: STARTPOS_FEN,
  moves: BENONI_UCI,
  elo_self: 2400,
  elo_oppo: 2400,
  top_n: 5,
  min_safety: 0.9,
  mode: "top",
};

const STATE_THEIR_TURN = {
  ok: true,
  fen: "rnbqkb1r/pp1p1ppp/4pn2/2pP4/2P5/2N5/PP2PPPP/R1BQKBNR b KQkq - 1 4",
  movesUci: BENONI_UCI,
  historyStatus: "replayed",
  turn: "b",
  userColor: "white",
};

function parseBody(options) {
  return JSON.parse(options.body);
}

/** fetch that never answers until its AbortSignal fires (a hung connection). */
function hangingFetch() {
  return (url, { signal } = {}) =>
    new Promise((resolve, reject) => {
      const abort = () => reject(Object.assign(new Error("This operation was aborted"), { name: "AbortError" }));
      if (signal?.aborted) abort();
      else signal?.addEventListener("abort", abort);
    });
}

/* ------------------------------------------------------------------ tests */

await test("premove: success -> {ok, status, data, roundTripMs} (1 attempt, exact payload)", async () => {
  let calls = 0;
  const result = await premove({
    ...REQUEST,
    fetchImpl: async (url, options) => {
      calls += 1;
      eq(url, PREMOVE_URL, "url");
      eq(options.method, "POST", "method");
      const body = parseBody(options);
      eq(body.fen, STARTPOS_FEN, "payload fen");
      eq(body.moves, BENONI_UCI, "payload moves");
      eq(body.elo_self, 2400, "payload elo_self");
      eq(body.elo_oppo, 2400, "payload elo_oppo");
      eq(body.top_n, 5, "payload top_n");
      eq(body.min_safety, 0.9, "payload min_safety");
      eq(body.mode, "top", "payload mode");
      return jsonResponse(200, cannedPlan());
    },
  });
  eq(calls, 1, "attempts");
  eq(result.ok, true, "ok");
  eq(result.status, 200, "status");
  eq(result.attempts, 1, "attempt count");
  eq(result.error, null, "error");
  eq(result.errorClass, null, "errorClass");
  eq(result.data.recommended.san, "cxd5", "recommended san");
  ok(result.roundTripMs >= 0, "roundTripMs");
  ok(PREMOVE_URL.endsWith(":8765/premove"), "url constant");
});

await test("premove: exactly one retry on a network failure (never on 4xx/5xx, never on timeout)", async () => {
  let network = 0;
  const retried = await premove({
    ...REQUEST,
    fetchImpl: async () => {
      network += 1;
      throw new TypeError("fetch failed: ECONNREFUSED");
    },
  });
  eq(network, 2, "network attempts");
  eq(retried.ok, false, "ok");
  eq(retried.errorClass, ERROR_CLASSES.OFFLINE, "class");
  eq(retried.attempts, 2, "attempt count");
  eq(retried.attemptLog.map((attempt) => attempt.outcome), ["network-error", "network-error"], "attempt log");

  let http = 0;
  const bad = await premove({ ...REQUEST, fetchImpl: async () => { http += 1; return jsonResponse(400, { detail: "invalid FEN" }); } });
  eq(http, 1, "4xx is not retried");
  eq(bad.errorClass, ERROR_CLASSES.INVALID_INPUT, "invalid_input class");
  eq(bad.error.detail, "invalid FEN", "server detail surfaced");

  let slow = 0;
  const timedOut = await premove({
    ...REQUEST,
    timeoutMs: 30,
    fetchImpl: (url, options) => {
      slow += 1;
      return hangingFetch()(url, options);
    },
  });
  eq(slow, 1, "timeout is not retried");
  eq(timedOut.errorClass, ERROR_CLASSES.TIMEOUT, "timeout class");
});

await test("premove: error classes (422 invalid, 503 engine, 500 http, 2xx bad body)", async () => {
  const cases = [
    [422, { detail: "mode must be one of ('top', 'all')" }, ERROR_CLASSES.INVALID_INPUT],
    [503, { detail: "engine unavailable" }, ERROR_CLASSES.ENGINE_UNAVAILABLE],
    [500, { detail: "boom" }, ERROR_CLASSES.HTTP],
    [200, { nope: true }, ERROR_CLASSES.BAD_RESPONSE],
  ];
  const seen = [];
  for (const [status, body, expected] of cases) {
    const result = await premove({
      ...REQUEST,
      delayImpl: async () => {}, // 503 is retried once — keep the test instant
      fetchImpl: async () => jsonResponse(status, body),
    });
    eq(result.errorClass, expected, `status ${status}`);
    eq(result.ok, false, `status ${status} ok`);
    seen.push(result.errorClass);
  }
  return { seen };
});

await test("premove: HTTP 503 -> exactly ONE retry after a short backoff (cold model load)", async () => {
  const delays = [];
  let calls = 0;
  const result = await premove({
    ...REQUEST,
    retry503DelayMs: 250,
    delayImpl: async (ms) => { delays.push(ms); },
    fetchImpl: async () => {
      calls += 1;
      return calls === 1
        ? jsonResponse(503, { detail: "engine unavailable: loading" })
        : jsonResponse(200, cannedPlan());
    },
  });
  eq(calls, 2, "fetch calls");
  eq(result.ok, true, "ok after the retry");
  eq(result.attempts, 2, "attempts");
  eq(delays, [250], "one backoff");
  eq(result.attemptLog.map((entry) => entry.outcome), ["engine-503", "ok"], "attempt log");

  let persistent = 0;
  const failed = await premove({
    ...REQUEST,
    delayImpl: async () => {},
    fetchImpl: async () => { persistent += 1; return jsonResponse(503, { detail: "engine unavailable" }); },
  });
  eq(persistent, 2, "persistent 503 -> one retry, never more");
  eq(failed.errorClass, ERROR_CLASSES.ENGINE_UNAVAILABLE, "class");
  return { retried: delays };
});

await test("clamps + mode normalization (server clamps again)", () => {
  eq(clampTopN(99), 12, "top_n high");
  eq(clampTopN(0), 1, "top_n low");
  eq(clampTopN("7"), 7, "top_n string");
  eq(clampTopN(undefined), PREMOVE_DEFAULT_TOP_N, "top_n default");
  eq(clampTopN(NaN), PREMOVE_DEFAULT_TOP_N, "top_n NaN");

  eq(clampMinSafety(0.1), 0.5, "min_safety low");
  eq(clampMinSafety(2), 1.0, "min_safety high");
  eq(clampMinSafety(0.95), 0.95, "min_safety in range");
  eq(clampMinSafety(undefined), PREMOVE_DEFAULT_MIN_SAFETY, "min_safety default");

  eq(normalizePremoveMode("all"), "all", "all");
  eq(normalizePremoveMode("sometimes"), PREMOVE_DEFAULT_MODE, "garbage -> default");
});

await test("premovePositionKey: fen|moves|elos|top_n|min_safety|mode (every input matters)", () => {
  const base = { fen: STARTPOS_FEN, moves: ["e2e4"], elo_self: 2400, elo_oppo: 2400, top_n: 5, min_safety: 0.9, mode: "top" };
  const key = premovePositionKey(base);
  eq(key, `${STARTPOS_FEN}|e2e4|2400|2400|5|0.9|top`, "key format");
  eq(premovePositionKey(base) === key, true, "stable");
  eq(premovePositionKey({ ...base, top_n: 6 }) === key, false, "top_n matters");
  eq(premovePositionKey({ ...base, min_safety: 0.95 }) === key, false, "min_safety matters");
  eq(premovePositionKey({ ...base, mode: "all" }) === key, false, "mode matters");
  eq(premovePositionKey({ ...base, elo_oppo: 1200 }) === key, false, "elo_oppo matters");
});

await test("buildPremoveRequest: replayed history -> startpos + moves; mismatch -> board only + warning", () => {
  const request = buildPremoveRequest(STATE_THEIR_TURN, { eloSelf: 2400, eloOppo: 2400 });
  eq(request.fen, STARTPOS_FEN, "history base = startpos");
  eq(request.moves, BENONI_UCI, "full UCI history");
  eq(request.positionMode, "history", "mapping mode");
  eq(request.historyUsed, 7, "history used");
  eq(request.key, `${STARTPOS_FEN}|${BENONI_UCI.join(" ")}|2400|2400|5|0.9|top`, "key");
  eq(request.mode, "top", "planner mode");

  const mismatch = buildPremoveRequest({ ...STATE_THEIR_TURN, mismatch: { kind: "board-history-disagreement" } });
  eq(mismatch.fen, STATE_THEIR_TURN.fen, "board fen");
  eq(mismatch.moves, [], "no moves on mismatch");
  eq(mismatch.positionMode, "board-only", "board-only mapping");
  ok(/mismatch/.test(mismatch.warning), "warning present");

  const noHistory = buildPremoveRequest({ ok: true, fen: "8/8/8/8/8/8/8/K6k b - - 0 1", movesUci: [], historyStatus: "absent" });
  eq(noHistory.moves, [], "no history moves");
  eq(noHistory.fen, "8/8/8/8/8/8/8/K6k b - - 0 1", "board fen only");
});

await test("premoveGate: auto only on the opponent's turn with everything known", () => {
  const base = { ok: true, turn: "w", userColor: "black" };
  eq(premoveGate(base, { assistantEnabled: true }).mode, "auto", "their turn (white)");
  eq(premoveGate({ ...base, turn: "b" }, { assistantEnabled: true }).mode, "waiting", "your turn");
  eq(premoveGate(base, { assistantEnabled: false }).mode, "off", "assistant off");
  eq(premoveGate({ ...base, userColor: null }, { assistantEnabled: true }).mode, "no-color", "no color");
  eq(premoveGate({ ok: false, reason: "no board" }, { assistantEnabled: true }).mode, "no-state", "no state");
  eq(premoveGate({ ...base, turn: "b" }, { assistantEnabled: true }).reason, "waiting for your move", "waiting reason");
  eq(premoveGate(base, { assistantEnabled: true }).reason, "their turn", "auto reason");
});

await test("client: cache hit, in-flight dedupe, failures never cached, force bypasses the cache", async () => {
  let calls = 0;
  const client = createPremoveClient({
    fetchImpl: async () => {
      calls += 1;
      await new Promise((resolve) => setTimeout(resolve, 20));
      return jsonResponse(200, cannedPlan());
    },
  });

  const first = await client.plan(REQUEST);
  eq(first.ok, true, "first ok");
  eq(first.stale, false, "first not stale");
  eq(calls, 1, "one request");

  const cached = await client.plan(REQUEST);
  eq(cached.fromCache, true, "from cache");
  eq(calls, 1, "still one request");
  eq(client.getStats().cacheHits, 1, "cacheHits");

  // In-flight dedupe needs a key that is NOT cached yet: two concurrent calls
  // must share the same promise (one network request, one `dedupes` count).
  let dedupeCalls = 0;
  const dedupeClient = createPremoveClient({
    fetchImpl: async () => {
      dedupeCalls += 1;
      await new Promise((resolve) => setTimeout(resolve, 25));
      return jsonResponse(200, cannedPlan());
    },
  });
  const [a, b] = await Promise.all([dedupeClient.plan(REQUEST), dedupeClient.plan(REQUEST)]);
  eq(dedupeCalls, 1, "deduped while in flight");
  eq(a.ok && b.ok, true, "both ok");
  eq(a.deduped || b.deduped, true, "dedupe flagged");
  eq(dedupeClient.getStats().dedupes, 1, "dedupe counted");

  const forced = await client.plan(REQUEST, { force: true });
  eq(forced.fromCache === false, true, "force skipped the cache");
  eq(calls, 2, "force re-requested");

  const failing = createPremoveClient({ fetchImpl: async () => jsonResponse(503, { detail: "loading" }) });
  await failing.plan(REQUEST);
  await failing.plan(REQUEST);
  eq(failing.getStats().requests, 2, "a failure is not cached");
  eq(failing.cacheSize(), 0, "failure not stored");
});

await test("client: stale guard — a newer position always wins over an older, slower plan", async () => {
  const resolvers = [];
  const client = createPremoveClient({
    fetchImpl: () => new Promise((resolve) => resolvers.push(resolve)),
  });

  const slower = client.plan(REQUEST);           // key A (their position)
  const newerKey = premovePositionKey({ ...REQUEST, moves: [...BENONI_UCI, "e6d5"] });
  client.expectKey(newerKey);                     // the opponent moved
  const newer = client.plan({ ...REQUEST, moves: [...BENONI_UCI, "e6d5"], key: newerKey });

  resolvers[0](jsonResponse(200, cannedPlan()));
  resolvers[1](jsonResponse(200, cannedPlan({ recommended: null })));

  const staleResult = await slower;
  const fresh = await newer;
  eq(staleResult.stale, true, "older result is stale");
  eq(fresh.stale, false, "newest result is current");
  eq(client.getStats().staleDiscards, 1, "staleDiscards");
  eq(client.isCurrent(newerKey), true, "current key");

  // A new game clears the cache.
  client.noteSessionSeq(1);
  eq(client.noteSessionSeq(1).changed, false, "same session");
  eq(client.noteSessionSeq(2).changed, true, "new session cleared");
  eq(client.cacheSize(), 0, "cache cleared on a new game");
});

await test("criterionLabel + premoveCaveat: the panel's chip/caveat wording", () => {
  eq(criterionLabel({ criterion: "forced", safety: 1 }), "forced", "forced");
  eq(criterionLabel({ criterion: "safe_vs_all", safety: 1 }), "safe vs all replies", "safe_vs_all");
  eq(criterionLabel({ criterion: "robust", safety: 0.942 }), "robust vs 94%", "robust rounds");
  eq(criterionLabel(null), null, "null");
  eq(
    premoveCaveat("top", 5),
    "safe only over their top-5; a premove still fires whenever it is legal",
    "mandated top-mode caveat",
  );
  includes(premoveCaveat("all", 5), "every legal reply", "all-mode caveat");
});

await test("premoveSpeech: 'premove ' + the M6 phrasing (lowercased first letter)", () => {
  eq(premoveSpeech({ san: "Nxd5", uci: "c3d5" }), "premove knight takes d5", "Nxd5");
  eq(premoveSpeech({ san: "Nf3" }), "premove knight to f3", "Nf3");
  eq(premoveSpeech({ san: "exd5", uci: "e4d5" }), "premove e-pawn takes d5", "exd5");
  eq(premoveSpeech({ san: "O-O" }), "premove castle kingside", "O-O");
  eq(premoveSpeech({ san: "gxh8=N#" }), "premove g-pawn takes h8, promote to knight, mate", "promotion");
  eq(premoveSpeech({ uci: "b7b8q" }), "premove move b7 to b8, promote to queen", "UCI fallback");
  eq(premoveSpeech({ san: "??" }), null, "unparseable -> null");
  eq(premoveSpeech(null), null, "null input");
  // the M6 formatter is untouched
  eq(moveToSpeech({ san: "Nxd5" }), "Knight takes d5", "M6 phrasing unchanged");
});

await test("premoveSpeakDecision: the never-speak matrix + dedupe", () => {
  const base = {
    ttsEnabled: true,
    speakPremoves: true,
    assistantEnabled: true,
    state: STATE_THEIR_TURN,
    plan: { key: "k1", recommended: { uci: "c4d5", san: "cxd5" } },
    currentKey: "k1",
  };
  eq(premoveSpeakDecision(base).speak, true, "speaks on their turn");
  eq(premoveSpeakDecision(base).reason, "speak", "reason");

  const no = (patch, reason) => eq(premoveSpeakDecision({ ...base, ...patch }).reason, reason, reason);
  no({ ttsEnabled: false }, "tts-off");
  no({ speakPremoves: false }, "premove-speech-off");
  no({ assistantEnabled: false }, "assistant-off");
  no({ state: null }, "no-state");
  no({ state: { ...STATE_THEIR_TURN, userColor: "black" } }, "your-turn");
  no({ plan: { key: "k1", recommended: null } }, "no-premove");
  no({ plan: null }, "no-premove");
  no({ currentKey: "k2" }, "stale");
  eq(premoveSpeakDecision({ ...base, spokenKeys: { has: (key) => key === premoveSpokenKey("k1", "c4d5") } }).reason, "duplicate", "duplicate");
  eq(premoveSpeakDecision({ ...base, currentKey: null }).speak, true, "no current key = no stale check");

  // Explicit user intent (toggle on) speaks once and returns the dedupe key.
  const store = createSpokenKeyStore();
  const forced = premoveSpeakDecision({ ...base, spokenKeys: store, ignoreDuplicate: true });
  eq(forced.speak, true, "forced speaks");
  eq(forced.reason, "forced", "forced reason");
  eq(forced.spokenKey, premoveSpokenKey("k1", "c4d5"), "dedupe key");
  store.mark(forced.spokenKey);
  eq(premoveSpeakDecision({ ...base, spokenKeys: store, ignoreDuplicate: true }).speak, true, "force ignores dedupe");
  eq(premoveSpeakDecision({ ...base, spokenKeys: store }).reason, "duplicate", "and only force");
});

/* ------------------------------------------------------------------ done */

const failed = results.filter((record) => !record.pass);
const summary = {
  tool: "premove-unit.mjs",
  generatedAt: new Date().toISOString(),
  node: process.version,
  modules: [
    "extension/src/analysis/premove-client.js",
    "extension/src/tts/move-speech.js (premoveSpeech)",
    "extension/src/tts/tts-policy.js (premoveSpeakDecision)",
  ],
  passed,
  failed: failed.length,
  total: results.length,
  cases: results,
};
await mkdir(OUT_DIR, { recursive: true });
await writeFile(path.join(OUT_DIR, "premove-unit.json"), `${JSON.stringify(summary, null, 2)}\n`);

console.log(`\n${passed} passed, ${failed.length} failed`);
console.log(`results: ${path.relative(REPO_ROOT, path.join(OUT_DIR, "premove-unit.json"))}`);
if (failed.length > 0) {
  console.log("failures:");
  for (const failure of failed) console.log(` - ${failure.name}: ${failure.message}`);
  process.exitCode = 1;
}

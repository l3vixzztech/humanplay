#!/usr/bin/env node
/**
 * analyze-unit.mjs — zero-dep unit tests for extension/src/analysis/analyze-client.js
 * (Milestone 4: the /analyze client + cache + stale guard).
 *
 * Runs in plain Node (no test framework, no packages) with an **injected
 * fetch**, so no server is needed and every failure mode (timeout, connection
 * refused, 4xx/5xx, malformed body, out-of-order responses) is deterministic.
 *
 * The canned bodies mirror the frozen server contract
 * (`{moves:[{uci,san,prob}], wdl:{win,draw,loss}, model, elapsed_ms}`) — the
 * stub server in test/tools/fixture_server.py serves the same shape, and
 * analyze-proof.mjs cross-checks it against the real server.
 *
 * Usage:
 *   node test/tools/analyze-unit.mjs          # exit code 0 = all passed
 * Writes machine-readable results to
 *   test/fixtures/captures/analyze/analyze-unit.json
 */

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import {
  ANALYZE_URL,
  DEFAULT_ELO,
  DEFAULT_TIMEOUT_MS,
  ERROR_CLASSES,
  STARTPOS_FEN,
  analysisGate,
  analyze,
  buildAnalyzeRequest,
  clampElo,
  createAnalyzeClient,
  positionKey,
} from "../../extension/src/analysis/analyze-client.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const OUT_DIR = path.join(REPO_ROOT, "test/fixtures/captures/analyze");

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

/* ------------------------------------------------------- injected fetches */

const MIDDLEGAME_UCI = ["e2e4", "e7e5", "g1f3", "b8c6", "f1c4", "f8c5", "e1g1", "g8f6", "d2d3", "d7d6", "c1g5", "e8g8", "g5f6", "d8f6"];

/** A Response-like object good enough for the client (only .ok/.status/.text used). */
function jsonResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
    json: async () => (typeof body === "string" ? JSON.parse(body) : body),
  };
}

function canned({ moves = [{ uci: "b1c3", san: "Nc3", prob: 0.585868 }], wdl = { win: 0.386213, draw: 0.073429, loss: 0.540358 } } = {}) {
  return { moves, wdl, model: "maia3-5m", elapsed_ms: 11.48 };
}

const REQUEST = { fen: STARTPOS_FEN, moves: MIDDLEGAME_UCI, elo_self: 2400, elo_oppo: 2400, top_k: 3 };

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

await test("analyze: success -> {ok, status, data, roundTripMs} (1 attempt)", async () => {
  let calls = 0;
  const result = await analyze({
    ...REQUEST,
    fetchImpl: async (url, options) => {
      calls += 1;
      eq(url, ANALYZE_URL, "url");
      eq(options.method, "POST", "method");
      const body = parseBody(options);
      eq(body.fen, STARTPOS_FEN, "payload fen");
      eq(body.moves, MIDDLEGAME_UCI, "payload moves");
      eq(body.elo_self, 2400, "payload elo_self");
      eq(body.top_k, 3, "payload top_k");
      return jsonResponse(200, canned());
    },
  });
  eq(result.ok, true, "ok");
  eq(result.status, 200, "status");
  eq(result.data.moves[0].san, "Nc3", "top san");
  eq(result.error, null, "error");
  eq(result.errorClass, null, "errorClass");
  eq(result.attempts, 1, "attempts");
  eq(calls, 1, "fetch calls");
  ok(Number.isFinite(result.roundTripMs) && result.roundTripMs >= 0, "roundTripMs");
  return { roundTripMs: result.roundTripMs, attempts: result.attempts };
});

await test("analyze: game over body (moves: [] + rules-decided wdl) is a SUCCESS", async () => {
  const result = await analyze({
    ...REQUEST,
    fetchImpl: async () => jsonResponse(200, { moves: [], wdl: { win: 0, draw: 0, loss: 1 }, model: "maia3-5m", elapsed_ms: 1.03 }),
  });
  eq(result.ok, true, "ok");
  eq(result.data.moves, [], "moves");
  eq(result.data.wdl, { win: 0, draw: 0, loss: 1 }, "wdl");
});

await test("analyze: timeout -> class \"timeout\", NOT retried", async () => {
  let calls = 0;
  const result = await analyze({
    ...REQUEST,
    timeoutMs: 25,
    fetchImpl: (...args) => {
      calls += 1;
      return hangingFetch()(...args);
    },
  });
  eq(result.ok, false, "ok");
  eq(result.errorClass, ERROR_CLASSES.TIMEOUT, "errorClass");
  eq(result.attempts, 1, "attempts (no retry on timeout)");
  eq(calls, 1, "fetch calls");
  eq(result.status, null, "status");
  ok(/25 ms/.test(result.error.message), "message mentions the timeout");
});

await test("analyze: network error -> exactly one retry, then succeeds", async () => {
  let calls = 0;
  const result = await analyze({
    ...REQUEST,
    fetchImpl: async () => {
      calls += 1;
      if (calls === 1) throw new TypeError("fetch failed");
      return jsonResponse(200, canned());
    },
  });
  eq(result.ok, true, "ok");
  eq(result.attempts, 2, "attempts");
  eq(calls, 2, "fetch calls");
  eq(result.attemptLog.map((entry) => entry.outcome), ["network-error", "ok"], "attempt log");
  return { attempts: result.attempts };
});

await test("analyze: permanent network error -> class \"offline\" after 2 attempts", async () => {
  let calls = 0;
  const result = await analyze({
    ...REQUEST,
    fetchImpl: async () => {
      calls += 1;
      throw new TypeError("fetch failed");
    },
  });
  eq(result.ok, false, "ok");
  eq(result.errorClass, ERROR_CLASSES.OFFLINE, "errorClass");
  eq(result.attempts, 2, "attempts");
  eq(calls, 2, "fetch calls (server offline = exactly one retry)");
  eq(result.error.detail, "fetch failed", "detail keeps the transport message");
});

await test("analyze: HTTP 400 -> invalid_input, detail shown, NEVER retried", async () => {
  let calls = 0;
  const result = await analyze({
    ...REQUEST,
    fetchImpl: async () => {
      calls += 1;
      return jsonResponse(400, { detail: "illegal move in history: 'e2e4' for position …" });
    },
  });
  eq(result.ok, false, "ok");
  eq(result.status, 400, "status");
  eq(result.errorClass, ERROR_CLASSES.INVALID_INPUT, "errorClass");
  eq(result.attempts, 1, "attempts");
  eq(calls, 1, "fetch calls");
  ok(/illegal move in history/.test(result.error.detail), "detail from the server body");
});

await test("analyze: HTTP 422 -> invalid_input, HTTP 500 -> http (never retried)", async () => {
  const statuses = [
    [422, ERROR_CLASSES.INVALID_INPUT],
    [500, ERROR_CLASSES.HTTP],
  ];
  const seen = {};
  for (const [status, expected] of statuses) {
    let calls = 0;
    const result = await analyze({
      ...REQUEST,
      fetchImpl: async () => {
        calls += 1;
        return jsonResponse(status, { detail: `simulated ${status}` });
      },
    });
    eq(result.errorClass, expected, `status ${status}`);
    eq(result.attempts, 1, `status ${status} attempts`);
    eq(calls, 1, `status ${status} fetch calls`);
    seen[status] = result.errorClass;
  }
  return seen;
});

await test("analyze: HTTP 503 -> exactly ONE retry after a short backoff (cold model load)", async () => {
  const delays = [];
  let calls = 0;
  const result = await analyze({
    ...REQUEST,
    retry503DelayMs: 300,
    delayImpl: async (ms) => { delays.push(ms); },
    fetchImpl: async () => {
      calls += 1;
      return calls === 1
        ? jsonResponse(503, { detail: "engine unavailable: model is loading" })
        : jsonResponse(200, canned());
    },
  });
  eq(calls, 2, "fetch calls");
  eq(result.ok, true, "ok after the retry");
  eq(result.attempts, 2, "attempts");
  eq(delays, [300], "one backoff of 300 ms");
  eq(result.attemptLog.map((entry) => entry.outcome), ["engine-503", "ok"], "attempt log");
  eq(result.data.moves[0].uci, "b1c3", "the second attempt's body is the result");
  return { delays, attemptLog: result.attemptLog };
});

await test("analyze: persistent 503 -> engine_unavailable after exactly one retry (never more, never on 4xx)", async () => {
  const delays = [];
  let calls = 0;
  const result = await analyze({
    ...REQUEST,
    delayImpl: async (ms) => { delays.push(ms); },
    fetchImpl: async () => {
      calls += 1;
      return jsonResponse(503, { detail: "engine unavailable: model failed to load" });
    },
  });
  eq(calls, 2, "fetch calls (1 + exactly 1 retry)");
  eq(result.ok, false, "ok");
  eq(result.errorClass, ERROR_CLASSES.ENGINE_UNAVAILABLE, "class");
  eq(result.status, 503, "status");
  eq(result.attempts, 2, "attempts");
  eq(delays.length, 1, "backoff slept once");
  ok(result.error.detail.includes("model failed to load"), "server detail kept");
  return { attempts: result.attempts, errorClass: result.errorClass };
});

await test("analyze: 2xx with a malformed body -> bad_response (no retry)", async () => {
  let calls = 0;
  const result = await analyze({
    ...REQUEST,
    fetchImpl: async () => {
      calls += 1;
      return jsonResponse(200, "<html>proxy error</html>");
    },
  });
  eq(result.errorClass, ERROR_CLASSES.BAD_RESPONSE, "errorClass");
  eq(result.attempts, 1, "attempts");
  eq(calls, 1, "fetch calls");
  ok(result.error.detail.includes("proxy error"), "detail keeps a body excerpt");
});

await test("client: identical key re-emits -> cache hit, no re-request", async () => {
  let calls = 0;
  const client = createAnalyzeClient({
    fetchImpl: async () => {
      calls += 1;
      return jsonResponse(200, canned());
    },
  });
  const first = await client.analyze(REQUEST);
  const second = await client.analyze({ ...REQUEST, moves: [...MIDDLEGAME_UCI] });
  eq(first.ok, true, "first ok");
  eq(first.fromCache, false, "first fromCache");
  eq(second.ok, true, "second ok");
  eq(second.fromCache, true, "second fromCache");
  eq(calls, 1, "fetch calls after two identical analyses");
  eq(client.getStats().cacheHits, 1, "cacheHits");
  eq(client.getStats().requests, 1, "requests");
  return { requests: client.getStats().requests, cacheHits: client.getStats().cacheHits };
});

await test("client: concurrent identical key -> one request (in-flight dedupe)", async () => {
  let calls = 0;
  let resolveFetch = null;
  const client = createAnalyzeClient({
    fetchImpl: () => {
      calls += 1;
      return new Promise((resolve) => {
        resolveFetch = () => resolve(jsonResponse(200, canned()));
      });
    },
  });
  const a = client.analyze(REQUEST);
  const b = client.analyze(REQUEST);
  eq(calls, 1, "fetch calls while the first is in flight");
  resolveFetch();
  const [ra, rb] = await Promise.all([a, b]);
  eq(ra.ok && rb.ok, true, "both ok");
  eq(rb.deduped, true, "second was deduped");
  eq(ra.deduped, false, "first was not");
  eq(calls, 1, "still one fetch");
  eq(client.getStats().dedupes, 1, "dedupes");
});

await test("client: out-of-order responses -> the older key is stale and discarded", async () => {
  const resolvers = new Map();
  const client = createAnalyzeClient({
    fetchImpl: (url, options) => {
      const body = parseBody(options);
      return new Promise((resolve) => resolvers.set(body.moves.join(","), resolve));
    },
  });
  const older = { ...REQUEST, moves: MIDDLEGAME_UCI.slice(0, 13) };
  const newer = { ...REQUEST, moves: MIDDLEGAME_UCI };

  const olderPromise = client.analyze(older); // slow request for the old position
  const newerPromise = client.analyze(newer); // the position changed -> new key wins
  eq(client.getCurrentKey(), positionKey(newer), "current key tracks the newest request");

  resolvers.get(newer.moves.join(","))(jsonResponse(200, canned({ moves: [{ uci: "c8d7", san: "Bd7", prob: 0.659 }] })));
  const newerResult = await newerPromise;
  eq(newerResult.stale, false, "newer result is current");
  eq(newerResult.data.moves[0].san, "Bd7", "newer san");

  resolvers.get(older.moves.join(","))(jsonResponse(200, canned({ moves: [{ uci: "g8f6", san: "Nf6", prob: 0.41 }] })));
  const olderResult = await olderPromise;
  eq(olderResult.stale, true, "older result is stale (must not be rendered)");
  eq(olderResult.ok, true, "stale result still carries its data");
  eq(client.getStats().staleDiscards, 1, "staleDiscards");
  return { staleDiscards: client.getStats().staleDiscards, currentKey: client.getCurrentKey() };
});

await test("client: expectKey() makes an in-flight result stale without a new request", async () => {
  let resolveFetch = null;
  const client = createAnalyzeClient({
    fetchImpl: () => new Promise((resolve) => { resolveFetch = resolve; }),
  });
  const promise = client.analyze(REQUEST);
  client.expectKey("other-position"); // e.g. it is now the opponent's turn
  resolveFetch(jsonResponse(200, canned()));
  const result = await promise;
  eq(result.stale, true, "stale after expectKey");
  eq(client.getStats().requests, 1, "expectKey did not request");
});

await test("client: Elo change -> different key -> new request (key includes elos)", async () => {
  let calls = 0;
  const client = createAnalyzeClient({
    fetchImpl: async () => {
      calls += 1;
      return jsonResponse(200, canned());
    },
  });
  await client.analyze({ ...REQUEST, elo_self: 1200, elo_oppo: 1200 });
  await client.analyze({ ...REQUEST, elo_self: 2600, elo_oppo: 2600 });
  await client.analyze({ ...REQUEST, elo_self: 1200, elo_oppo: 1200 });
  eq(calls, 2, "two positions requested (the 1200 one came from cache)");
  eq(positionKey({ ...REQUEST, elo_self: 1200, elo_oppo: 1200 }) === positionKey({ ...REQUEST, elo_self: 2600, elo_oppo: 2600 }), false, "keys differ");
  eq(client.getStats().cacheHits, 1, "cacheHits");
  return { requests: client.getStats().requests, cacheHits: client.getStats().cacheHits };
});

await test("client: sessionSeq change (new game) clears the cache", async () => {
  let calls = 0;
  const client = createAnalyzeClient({
    fetchImpl: async () => {
      calls += 1;
      return jsonResponse(200, canned());
    },
  });
  eq(client.noteSessionSeq(0).first, true, "first sessionSeq is remembered without clearing");
  await client.analyze(REQUEST);
  eq(client.cacheSize(), 1, "cached");
  eq(client.noteSessionSeq(0).changed, false, "same session");
  const reset = client.noteSessionSeq(1);
  eq(reset.changed, true, "new session detected");
  eq(reset.cleared, 1, "one entry cleared");
  eq(client.cacheSize(), 0, "cache empty");
  await client.analyze(REQUEST);
  eq(calls, 2, "same state re-requested after the reset");
  return { cleared: reset.cleared, requests: client.getStats().requests };
});

await test("client: cache is a small LRU, failures are never cached", async () => {
  let calls = 0;
  const client = createAnalyzeClient({
    maxCacheEntries: 2,
    fetchImpl: async (url, options) => {
      calls += 1;
      const body = parseBody(options);
      if (body.moves.includes("a2a3")) return jsonResponse(400, { detail: "simulated invalid input" });
      return jsonResponse(200, canned());
    },
  });
  await client.analyze({ ...REQUEST, moves: ["e2e4"] });
  await client.analyze({ ...REQUEST, moves: ["d2d4"] });
  await client.analyze({ ...REQUEST, moves: ["c2c4"] }); // evicts the first
  eq(client.cacheSize(), 2, "cache bounded");
  eq(client.cacheKeys().includes(positionKey({ ...REQUEST, moves: ["e2e4"] })), false, "oldest evicted");
  const failed = await client.analyze({ ...REQUEST, moves: ["a2a3"] });
  eq(failed.ok, false, "400");
  eq(client.cacheSize(), 2, "failure not cached");
  const before = calls;
  await client.analyze({ ...REQUEST, moves: ["a2a3"] }, { force: true });
  eq(calls, before + 1, "force bypasses the (empty) cache entry and retries");
  return { cacheSize: client.cacheSize(), calls };
});

/* --------------------------------------------- request building + gating */

await test("buildAnalyzeRequest: replayed history -> startpos + full UCI history", () => {
  const state = {
    ok: true,
    fen: "r1b2rk1/ppp2ppp/2np1q2/2b1p3/2B1P3/3P1N2/PPP2PPP/RN1Q1RK1 w - - 0 8",
    movesUci: MIDDLEGAME_UCI,
    historyStatus: "replayed",
    turn: "w",
    userColor: "white",
  };
  const request = buildAnalyzeRequest(state, { eloSelf: 2400, eloOppo: 2600, topK: 3 });
  eq(request.mode, "history", "mode");
  eq(request.fen, STARTPOS_FEN, "base fen");
  eq(request.moves, MIDDLEGAME_UCI, "moves");
  eq(request.historyUsed, 14, "historyUsed");
  eq(request.elo_oppo, 2600, "elo_oppo");
  eq(request.warning, null, "no warning");
  eq(request.key, positionKey(request), "key");
});

await test("buildAnalyzeRequest: mismatch -> board FEN WITHOUT moves + warning", () => {
  const state = {
    ok: true,
    fen: "r1b2rk1/ppp2ppp/2np1q2/2b1p3/2B1P3/3P1N2/PPP2PPP/RN1Q1RK1 w - - 0 8",
    movesUci: MIDDLEGAME_UCI,
    historyStatus: "dropped",
    mismatch: { kind: "board-history-disagreement", note: "…" },
  };
  const request = buildAnalyzeRequest(state);
  eq(request.mode, "board-only", "mode");
  eq(request.fen, state.fen, "board fen kept");
  eq(request.moves, [], "no moves");
  eq(request.historyUsed, 0, "historyUsed");
  ok(/mismatch/.test(request.warning), "mismatch warning");
});

await test("buildAnalyzeRequest: empty history / no usable history / no state", () => {
  const startpos = { ok: true, fen: STARTPOS_FEN, movesUci: [], historyStatus: "startpos" };
  const start = buildAnalyzeRequest(startpos);
  eq(start.mode, "board-only", "startpos mode");
  eq(start.fen, STARTPOS_FEN, "startpos fen");
  eq(start.warning, null, "startpos has no warning");

  const absent = buildAnalyzeRequest({ ok: true, fen: "8/8/8/8/8/8/8/K6k w - - 0 1", movesUci: [], historyStatus: "absent" });
  eq(absent.fen, "8/8/8/8/8/8/8/K6k w - - 0 1", "board fen");

  const unreliable = buildAnalyzeRequest({ ok: true, fen: "x", movesUci: ["e2e4"], historyStatus: "unreliable", mismatch: { kind: "history-unreliable" } });
  eq(unreliable.moves, [], "unreliable moves dropped");
  ok(/mismatch/.test(unreliable.warning), "warning present");
});

await test("analysisGate: auto only on your turn with everything known", () => {
  const base = { ok: true, turn: "w", userColor: "white" };
  eq(analysisGate(base, { assistantEnabled: true }).mode, "auto", "your turn");
  eq(analysisGate({ ...base, turn: "b" }, { assistantEnabled: true }).mode, "waiting", "their turn");
  eq(analysisGate(base, { assistantEnabled: false }).mode, "off", "assistant off");
  eq(analysisGate({ ...base, userColor: null }, { assistantEnabled: true }).mode, "no-color", "no color");
  eq(analysisGate({ ok: false, reason: "no board" }, { assistantEnabled: true }).mode, "no-state", "no state");
  eq(analysisGate({ ok: false }, { assistantEnabled: false }).canManual, false, "manual needs a state");
  eq(analysisGate({ ...base, turn: "b" }, { assistantEnabled: true }).canManual, true, "manual works on their turn");
});

await test("clampElo / positionKey", () => {
  eq(clampElo(1200), 1200, "1200");
  eq(clampElo(-50), 0, "clamp low");
  eq(clampElo(99999), 5000, "clamp high");
  eq(clampElo("2700"), 2700, "string");
  eq(clampElo(undefined), DEFAULT_ELO, "default");
  eq(clampElo(NaN), DEFAULT_ELO, "NaN");
  const a = positionKey({ fen: STARTPOS_FEN, moves: ["e2e4"], elo_self: 2400, elo_oppo: 2400, top_k: 3 });
  const b = positionKey({ fen: STARTPOS_FEN, moves: ["e2e4"], elo_self: 2400, elo_oppo: 2400, top_k: 3 });
  const c = positionKey({ fen: STARTPOS_FEN, moves: ["e2e4"], elo_self: 2401, elo_oppo: 2400, top_k: 3 });
  const d = positionKey({ fen: STARTPOS_FEN, moves: ["e2e4"], elo_self: 2400, elo_oppo: 2400, top_k: 1 });
  eq(a === b, true, "stable");
  eq(a === c, false, "elo matters");
  eq(a === d, false, "top_k matters");
  eq(positionKey(), "undefined||2400|2400|3", "defaults");
  ok(ANALYZE_URL.endsWith(":8765/analyze"), "url");
  ok(DEFAULT_TIMEOUT_MS >= 1000, "timeout default");
});

/* ------------------------------------------------------------------ done */

const failed = results.filter((record) => !record.pass);
const summary = {
  tool: "analyze-unit.mjs",
  generatedAt: new Date().toISOString(),
  node: process.version,
  module: "extension/src/analysis/analyze-client.js",
  passed,
  failed: failed.length,
  total: results.length,
  cases: results,
};
await mkdir(OUT_DIR, { recursive: true });
await writeFile(path.join(OUT_DIR, "analyze-unit.json"), `${JSON.stringify(summary, null, 2)}\n`);

console.log(`\n${passed} passed, ${failed.length} failed`);
console.log(`results: ${path.relative(REPO_ROOT, path.join(OUT_DIR, "analyze-unit.json"))}`);
if (failed.length > 0) {
  console.log("failures:");
  for (const failure of failed) console.log(` - ${failure.name}: ${failure.message}`);
  process.exitCode = 1;
}

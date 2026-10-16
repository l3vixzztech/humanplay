#!/usr/bin/env node
/**
 * commentary-unit.mjs — zero-dep unit tests for the M8 live commentary:
 *
 *   extension/src/analysis/explain-client.js   (/explain client + feed driver)
 *   extension/src/commentary/phrase.js         (facts -> template sentence)
 *   extension/src/commentary/llm.js            (optional rephrasing: prompt,
 *                                               sanitizer, providers, fallback)
 *
 * Runs in plain Node (no test framework, no packages) with injected `fetch` and
 * injected `chrome.permissions`, so every failure mode (timeout, HTTP error,
 * provider error, no key, denied permission) is deterministic and no network is
 * needed.
 *
 * Usage:
 *   node test/tools/commentary-unit.mjs       # exit code 0 = all passed
 * Writes machine-readable results to
 *   test/fixtures/captures/commentary/commentary-unit.json
 */

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { STARTPOS_FEN } from "../../extension/src/analysis/analyze-client.js";
import {
  COMMENTARY_MAX_ENTRIES,
  ERROR_CLASSES,
  EXPLAIN_URL,
  buildExplainRequest,
  classificationChip,
  createCommentaryFeed,
  createExplainClient,
  explain,
  explainPositionKey,
  moverLabel,
} from "../../extension/src/analysis/explain-client.js";
import { commentaryFacts, eventClause, maiaClause, phraseCommentary } from "../../extension/src/commentary/phrase.js";
import {
  LLM_DEFAULT_ENGINE,
  LLM_ERRORS,
  LLM_MAX_CHARS,
  LLM_PROVIDERS,
  LLM_SYSTEM_PROMPT,
  buildLlmPrompt,
  buildLlmRequest,
  llmPermissionState,
  llmPhrase,
  llmProvider,
  normalizeLlmEngine,
  parseLlmResponse,
  providerPrivacyLine,
  requestLlmPermission,
  sanitizeLlmText,
  testLlmConnection,
} from "../../extension/src/commentary/llm.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const OUT_DIR = path.join(REPO_ROOT, "test/fixtures/captures/commentary");

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

/* ----------------------------------------------------- fixtures / fetches */

/** A Response-like object good enough for the clients (only .ok/.status/.text used). */
function jsonResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
    json: async () => (typeof body === "string" ? JSON.parse(body) : body),
  };
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

/**
 * A full /explain body. Defaults are the REAL recorded facts of the Benoni
 * take-back 5.cxd5 (server/explain_engine probe, 2026-10-17) so the tests also
 * pin the contract shape.
 */
function explainBody(overrides = {}) {
  const defaults = {
    move: { san: "cxd5", uci: "c4d5", by: "white", ply: 9, moveNumber: 5 },
    flags: {
      capture: true,
      check: false,
      mate: false,
      castle: null,
      promotion: null,
      enPassant: false,
      recapture: true,
    },
    material: { delta: 1, captured: { piece: "pawn", square: "d5", value: 1 } },
    maia: {
      playedProb: 0.983822,
      rank: 1,
      totalLegal: 34,
      top: [
        { uci: "c4d5", san: "cxd5", prob: 0.983822 },
        { uci: "c3d5", san: "Nxd5", prob: 0.014418 },
        { uci: "e2e4", san: "e4", prob: 0.000714 },
      ],
      moverElo: 2400,
    },
    wdl: {
      before: { win: 0.458563, draw: 0.070594, loss: 0.470843 },
      after: { win: 0.51648, draw: 0.055046, loss: 0.428474 },
    },
    opening: { eco: "A60", name: "Benoni Defense: Modern Variation" },
    classification: "mainline",
    model: "maia3-5m",
    elapsed_ms: 61.01,
  };
  return { ...defaults, ...overrides };
}

const EXPLAIN_REQUEST = {
  fen: STARTPOS_FEN,
  moves: ["d2d4", "g8f6", "c2c4", "c7c5", "d4d5", "e7e6", "b1c3", "e6d5", "c4d5"],
  elo_self: 2400,
  elo_oppo: 2400,
};

function stateWith(movesUci, extra = {}) {
  return {
    ok: true,
    fen: "irrelevant-for-the-driver",
    movesUci,
    historyStatus: "replayed",
    turn: movesUci.length % 2 === 0 ? "w" : "b",
    userColor: "white",
    sessionSeq: 1,
    ...extra,
  };
}

/* ------------------------------------------------------------------ tests */

await test("explain: success -> {ok, status, data, roundTripMs} (1 attempt, exact payload)", async () => {
  let calls = 0;
  const result = await explain({
    ...EXPLAIN_REQUEST,
    fetchImpl: async (url, options) => {
      calls += 1;
      eq(url, EXPLAIN_URL, "url");
      eq(options.method, "POST", "method");
      const body = JSON.parse(options.body);
      eq(body.fen, STARTPOS_FEN, "payload fen");
      eq(body.moves, EXPLAIN_REQUEST.moves, "payload moves");
      eq(body.elo_self, 2400, "payload elo_self");
      eq(body.elo_oppo, 2400, "payload elo_oppo");
      eq(Object.keys(body).sort(), ["elo_oppo", "elo_self", "fen", "moves"], "payload shape");
      return jsonResponse(200, explainBody());
    },
  });
  eq(calls, 1, "attempts");
  eq(result.ok, true, "ok");
  eq(result.status, 200, "status");
  eq(result.attempts, 1, "attempt count");
  eq(result.errorClass, null, "errorClass");
  eq(result.data.move.san, "cxd5", "san");
  eq(result.data.classification, "mainline", "classification");
  ok(result.roundTripMs >= 0, "roundTripMs");
  ok(EXPLAIN_URL.endsWith(":8765/explain"), "url constant");
});

await test("explain: exactly one retry on a network failure (never 4xx/5xx, never timeout)", async () => {
  let network = 0;
  const retried = await explain({
    ...EXPLAIN_REQUEST,
    fetchImpl: async () => {
      network += 1;
      throw new TypeError("fetch failed: ECONNREFUSED");
    },
  });
  eq(network, 2, "network attempts");
  eq(retried.ok, false, "ok");
  eq(retried.errorClass, ERROR_CLASSES.OFFLINE, "class");
  eq(retried.attempts, 2, "attempt count");

  let http = 0;
  const bad = await explain({ ...EXPLAIN_REQUEST, fetchImpl: async () => { http += 1; return jsonResponse(400, { detail: "illegal move in history: 'zzzz'" }); } });
  eq(http, 1, "4xx is not retried");
  eq(bad.errorClass, ERROR_CLASSES.INVALID_INPUT, "invalid_input class");
  eq(bad.error.detail, "illegal move in history: 'zzzz'", "server detail surfaced");

  let slow = 0;
  const timedOut = await explain({
    ...EXPLAIN_REQUEST,
    timeoutMs: 30,
    fetchImpl: (url, options) => {
      slow += 1;
      return hangingFetch()(url, options);
    },
  });
  eq(slow, 1, "timeout is not retried");
  eq(timedOut.errorClass, ERROR_CLASSES.TIMEOUT, "timeout class");
});

await test("explain: error classes (422 invalid, 503 engine, 500 http, 2xx bad body)", async () => {
  const cases = [
    [422, { detail: "moves must contain at least one ply" }, ERROR_CLASSES.INVALID_INPUT],
    [503, { detail: "engine unavailable" }, ERROR_CLASSES.ENGINE_UNAVAILABLE],
    [500, { detail: "boom" }, ERROR_CLASSES.HTTP],
    [200, { nope: true }, ERROR_CLASSES.BAD_RESPONSE],
  ];
  const seen = [];
  for (const [status, body, expected] of cases) {
    const result = await explain({
      ...EXPLAIN_REQUEST,
      delayImpl: async () => {}, // 503 is retried once — keep the test instant
      fetchImpl: async () => jsonResponse(status, body),
    });
    eq(result.errorClass, expected, `status ${status}`);
    eq(result.ok, false, `status ${status} ok`);
    seen.push(result.errorClass);
  }
  return { seen };
});

await test("explain: HTTP 503 -> exactly ONE retry after a short backoff (cold model load)", async () => {
  const delays = [];
  let calls = 0;
  const result = await explain({
    ...EXPLAIN_REQUEST,
    retry503DelayMs: 300,
    delayImpl: async (ms) => { delays.push(ms); },
    fetchImpl: async () => {
      calls += 1;
      return calls === 1 ? jsonResponse(503, { detail: "loading" }) : jsonResponse(200, explainBody());
    },
  });
  eq(calls, 2, "fetch calls");
  eq(result.ok, true, "ok");
  eq(result.attempts, 2, "attempts");
  eq(delays, [300], "one backoff");
  eq(result.attemptLog.map((entry) => entry.outcome), ["engine-503", "ok"], "attempt log");

  let persistent = 0;
  const failed = await explain({
    ...EXPLAIN_REQUEST,
    delayImpl: async () => {},
    fetchImpl: async () => { persistent += 1; return jsonResponse(503, { detail: "engine unavailable" }); },
  });
  eq(persistent, 2, "persistent 503 -> one retry, never more");
  eq(failed.errorClass, ERROR_CLASSES.ENGINE_UNAVAILABLE, "class");
  return { delays };
});

await test("explainPositionKey: fen|moves|elos (every input matters)", () => {
  const base = { fen: STARTPOS_FEN, moves: ["e2e4"], elo_self: 2400, elo_oppo: 2400 };
  const key = explainPositionKey(base);
  eq(key, `${STARTPOS_FEN}|e2e4|2400|2400`, "key format");
  eq(explainPositionKey(base) === key, true, "stable");
  eq(explainPositionKey({ ...base, elo_self: 1200 }) === key, false, "elo_self matters");
  eq(explainPositionKey({ ...base, elo_oppo: 2600 }) === key, false, "elo_oppo matters");
  eq(explainPositionKey({ ...base, moves: ["e2e4", "e7e5"] }) === key, false, "moves matter");
});

await test("buildExplainRequest: replayed history only; mismatch/absent -> null", () => {
  const request = buildExplainRequest(stateWith(["e2e4", "e7e5", "g1f3"]), { eloSelf: 2400, eloOppo: 2400 });
  eq(request.fen, STARTPOS_FEN, "base = startpos");
  eq(request.moves, ["e2e4", "e7e5", "g1f3"], "full UCI history");
  eq(request.positionMode, "history", "mapping mode");
  eq(request.historyUsed, 3, "history used");
  eq(request.key, `${STARTPOS_FEN}|e2e4 e7e5 g1f3|2400|2400`, "key");

  eq(buildExplainRequest(stateWith(["e2e4"], { mismatch: { kind: "board-history-disagreement" } })), null, "mismatch -> null");
  eq(buildExplainRequest(stateWith(["e2e4"], { historyStatus: "absent" })), null, "absent history -> null");
  eq(buildExplainRequest(stateWith(["e2e4"], { historyStatus: "unreliable" })), null, "unreliable history -> null");
  eq(buildExplainRequest(stateWith([])), null, "empty history -> nothing to explain");
  eq(buildExplainRequest({ ok: false }), null, "no state -> null");
});

await test("client: cache hit, in-flight dedupe, failures never cached, force bypasses", async () => {
  let calls = 0;
  const client = createExplainClient({
    fetchImpl: async () => {
      calls += 1;
      await new Promise((resolve) => setTimeout(resolve, 20));
      return jsonResponse(200, explainBody());
    },
  });

  const first = await client.load(EXPLAIN_REQUEST);
  eq(first.ok, true, "first ok");
  eq(first.stale, false, "first not stale");
  eq(calls, 1, "one request");

  const cached = await client.load(EXPLAIN_REQUEST);
  eq(cached.fromCache, true, "from cache");
  eq(calls, 1, "still one request");
  eq(client.getStats().cacheHits, 1, "cacheHits");

  let dedupeCalls = 0;
  const dedupeClient = createExplainClient({
    fetchImpl: async () => {
      dedupeCalls += 1;
      await new Promise((resolve) => setTimeout(resolve, 25));
      return jsonResponse(200, explainBody());
    },
  });
  const [a, b] = await Promise.all([dedupeClient.load(EXPLAIN_REQUEST), dedupeClient.load(EXPLAIN_REQUEST)]);
  eq(dedupeCalls, 1, "deduped while in flight");
  eq(a.ok && b.ok, true, "both ok");
  eq(a.deduped || b.deduped, true, "dedupe flagged");

  const forced = await client.load(EXPLAIN_REQUEST, { force: true });
  eq(forced.fromCache === false, true, "force skipped the cache");
  eq(calls, 2, "force re-requested");

  const failing = createExplainClient({ fetchImpl: async () => jsonResponse(503, { detail: "loading" }) });
  await failing.load(EXPLAIN_REQUEST);
  await failing.load(EXPLAIN_REQUEST);
  eq(failing.getStats().requests, 2, "a failure is not cached");
  eq(failing.cacheSize(), 0, "failure not stored");
});

await test("client: stale guard — a newer ply always wins over an older, slower article", async () => {
  const resolvers = [];
  const client = createExplainClient({ fetchImpl: () => new Promise((resolve) => resolvers.push(resolve)) });

  const slower = client.load(EXPLAIN_REQUEST);
  const newerKey = explainPositionKey({ ...EXPLAIN_REQUEST, moves: [...EXPLAIN_REQUEST.moves, "e7e6"] });
  client.expectKey(newerKey);
  const newer = client.load({ ...EXPLAIN_REQUEST, moves: [...EXPLAIN_REQUEST.moves, "e7e6"], key: newerKey });

  resolvers[0](jsonResponse(200, explainBody()));
  resolvers[1](jsonResponse(200, explainBody({ move: { san: "e6", uci: "e7e6" } })));

  const staleResult = await slower;
  const fresh = await newer;
  eq(staleResult.stale, true, "older result is stale");
  eq(fresh.stale, false, "newest result is current");
  eq(client.getStats().staleDiscards, 1, "staleDiscards");

  client.noteSessionSeq(1);
  eq(client.noteSessionSeq(1).changed, false, "same session");
  eq(client.noteSessionSeq(2).changed, true, "new session cleared");
  eq(client.cacheSize(), 0, "cache cleared on a new game");
});

await test("feed driver: seeds the baseline, requests on growth by exactly one ply (both colors)", () => {
  const feed = createCommentaryFeed();
  const g1 = feed.observe(stateWith(["e2e4"]), { eloSelf: 2400, eloOppo: 2400 });
  eq(g1.action, "seeded", "first state seeds");
  eq(feed.getStats().requested, 0, "no request while seeding");

  const g2 = feed.observe(stateWith(["e2e4", "e7e5"])); // opponent's move
  eq(g2.action, "explain", "opponent ply explains");
  eq(g2.ply, 2, "ply");
  eq(g2.request.moves, ["e2e4", "e7e5"], "prefix = base + full history");
  eq(g2.key, `${STARTPOS_FEN}|e2e4 e7e5|2400|2400`, "key = base + prefix");

  const g3 = feed.observe(stateWith(["e2e4", "e7e5", "g1f3"])); // our move
  eq(g3.action, "explain", "our ply explains too");
  eq(g3.request.moves.length, 3, "three plies");

  eq(feed.observe(stateWith(["e2e4", "e7e5", "g1f3"])).action, "none", "re-emit is a no-op");

  const jump = feed.observe(stateWith(["e2e4", "e7e5", "g1f3", "b8c6", "f1b5"]));
  eq(jump.action, "skipped", "a jump is skipped");
  eq([jump.from, jump.to], [3, 5], "jump bounds");

  const next = feed.observe(stateWith(["e2e4", "e7e5", "g1f3", "b8c6", "f1b5", "a7a6"]));
  eq(next.action, "explain", "growth continues after a skip");

  eq(feed.getStats().requested, 3, "requested count");
  eq(feed.getStats().seeded, 1, "seeded count");
  eq(feed.getStats().skipped, 1, "skipped count");
});

await test("feed driver: mismatch growth -> no request; dedupe by ply; suppressed when off", () => {
  const feed = createCommentaryFeed();
  feed.observe(stateWith(["e2e4"]));

  const mismatch = feed.observe(stateWith(["e2e4", "e7e5"], { mismatch: { kind: "board-history-disagreement" } }));
  eq(mismatch.action, "none", "mismatch never explains");
  eq(mismatch.reason, "no-usable-history", "reason");
  eq(feed.getStats().noHistory, 1, "counted");
  // The ply is consumed: a later re-read of the same ply is not retro-explained.
  eq(feed.observe(stateWith(["e2e4", "e7e5"])).action, "none", "consumed ply is unchanged");

  const feed2 = createCommentaryFeed();
  feed2.observe(stateWith(["e2e4"]));
  const off = feed2.observe(stateWith(["e2e4", "e7e5"]), { enabled: false });
  eq(off.action, "suppressed", "toggle off suppresses");
  eq(feed2.getStats().requested, 0, "no request while off");
  eq(feed2.getStats().suppressed, 1, "suppressed counted");
  const on2 = feed2.observe(stateWith(["e2e4", "e7e5", "g1f3"]));
  eq(on2.action, "explain", "re-enabling explains the NEXT ply, never retroactively");
});

await test("feed driver: reset on a new game (sessionSeq) + the ~50-ply cap (newest first)", () => {
  const feed = createCommentaryFeed();
  feed.observe(stateWith(["e2e4"], { sessionSeq: 1 }));
  feed.observe(stateWith(["e2e4", "e7e5"], { sessionSeq: 1 }));
  feed.addEntry({ ply: 2, san: "e5" });
  feed.addEntry({ ply: 1, san: "e4" });
  eq(feed.size(), 2, "entries stored");

  const reset = feed.observe(stateWith(["d2d4"], { sessionSeq: 2 }));
  eq(reset.action, "reset", "new game resets");
  eq(reset.cleared, 2, "cleared entries");
  eq(feed.size(), 0, "feed emptied");
  eq(feed.getStats().reset, 1, "reset counted");
  const afterReset = feed.observe(stateWith(["d2d4", "g8f6"], { sessionSeq: 2 }));
  eq(afterReset.action, "explain", "the new session explains its own moves");

  const cap = createCommentaryFeed({ maxEntries: 5 });
  for (let ply = 1; ply <= 8; ply += 1) cap.addEntry({ ply, san: `m${ply}` });
  eq(cap.size(), 5, "capped");
  eq(cap.getEntries()[0].ply, 8, "newest first");
  eq(cap.getEntries().at(-1).ply, 4, "oldest evicted");
  eq(cap.getStats().capEvictions, 3, "evictions counted");
  eq(COMMENTARY_MAX_ENTRIES, 50, "the shipped cap is 50");

  const cleared = feed.clear();
  eq(cleared, 0, "clear returns the count (the reset already emptied it)");
  eq(feed.getLastPly(), null, "baseline forgotten on clear");
});

await test("phrase: mainline + capture + recapture + castle + quiet (recorded facts)", () => {
  // quiet mainline (1.e4: e2e4 0.464864, B00 King's Pawn Game)
  const e4 = phraseCommentary(explainBody({
    move: { san: "e4", uci: "e2e4", by: "white", ply: 1, moveNumber: 1 },
    flags: { capture: false, check: false, mate: false, castle: null, promotion: null, enPassant: false, recapture: false },
    material: { delta: 0, captured: null },
    maia: { playedProb: 0.464864, rank: 1, totalLegal: 20, top: [{ uci: "e2e4", san: "e4", prob: 0.464864 }, { uci: "d2d4", san: "d4", prob: 0.339048 }], moverElo: 2400 },
    opening: { eco: "B00", name: "King's Pawn Game" },
  }));
  eq(e4.text, "e4 — the most common move at 2400 (46%).", "quiet mainline");
  eq(e4.chip, "main line", "chip");
  eq(e4.classification, "mainline", "classification");
  eq(e4.opening.name, "King's Pawn Game", "opening carried");

  // capture (not a recapture): Bxc6, common 15%
  const bxc6 = phraseCommentary(explainBody({
    move: { san: "Bxc6", uci: "b5c6", by: "white", ply: 7, moveNumber: 4 },
    flags: { capture: true, check: false, mate: false, castle: null, promotion: null, enPassant: false, recapture: false },
    material: { delta: 3, captured: { piece: "knight", square: "c6", value: 3 } },
    maia: { playedProb: 0.150492, rank: 2, totalLegal: 32, top: [{ uci: "b5a4", san: "Ba4", prob: 0.847302 }], moverElo: 2400 },
    classification: "common",
  }));
  eq(bxc6.text, "Bxc6 — a capture on c6; a common choice at 2400 (15%); Maia's pick was Ba4 (85%).", "common capture");

  // recapture mainline: the brief's "exd5 — a recapture; 96% of 2400s take back."
  const cxd5 = phraseCommentary(explainBody());
  eq(cxd5.text, "cxd5 — a recapture; 98% of 2400s take back.", "recapture mainline");

  // castle mainline: "the main line"
  const ooo = phraseCommentary(explainBody({
    move: { san: "O-O-O", uci: "e1c1", by: "white", ply: 9, moveNumber: 5 },
    flags: { capture: false, check: false, mate: false, castle: "queenside", promotion: null, enPassant: false, recapture: false },
    material: { delta: 0, captured: null },
    maia: { playedProb: 0.479826, rank: 1, totalLegal: 35, top: [{ uci: "e1c1", san: "O-O-O", prob: 0.479826 }], moverElo: 2400 },
    classification: "mainline",
  }));
  eq(ooo.text, "O-O-O — castling queenside; the main line.", "castle mainline");
});

await test("phrase: uncommon, rare (rank>1 surfaces Maia's pick), promotion, ep, check, mate", () => {
  // uncommon: 2...Nf6 3.43%, rank 8, Maia picks c5 (37%)
  const nf6 = phraseCommentary(explainBody({
    move: { san: "Nf6", uci: "g8f6", by: "black", ply: 2, moveNumber: 1 },
    flags: { capture: false, check: false, mate: false, castle: null, promotion: null, enPassant: false, recapture: false },
    material: { delta: 0, captured: null },
    maia: { playedProb: 0.034256, rank: 8, totalLegal: 20, top: [{ uci: "c7c5", san: "c5", prob: 0.374898 }], moverElo: 2400 },
    classification: "uncommon",
    opening: { eco: "B02", name: "Alekhine Defense" },
  }));
  eq(nf6.text, "Nf6 — uncommon at 2400 (3%); Maia's pick was c5 (37%).", "uncommon");

  // rare: 1.Nh3 0.0274%, rank 18; Maia picks e4 (46%)
  const nh3 = phraseCommentary(explainBody({
    move: { san: "Nh3", uci: "g1h3", by: "white", ply: 1, moveNumber: 1 },
    flags: { capture: false, check: false, mate: false, castle: null, promotion: null, enPassant: false, recapture: false },
    material: { delta: 0, captured: null },
    maia: { playedProb: 0.000274, rank: 18, totalLegal: 20, top: [{ uci: "e2e4", san: "e4", prob: 0.464864 }], moverElo: 2400 },
    classification: "rare",
    opening: { eco: "A00", name: "Amar Opening" },
  }));
  eq(nh3.text, "Nh3 — only 0.0% play this; Maia's pick was e4 (46%).", "rare with sub-0.1% probability");

  // rare at 2% (the brief's example shape): "only 2% play this"
  const rare2 = phraseCommentary(explainBody({
    move: { san: "Nxe5", uci: "f3e5", by: "white", ply: 5, moveNumber: 3 },
    flags: { capture: true, check: false, mate: false, castle: null, promotion: null, enPassant: false, recapture: false },
    material: { delta: 1, captured: { piece: "pawn", square: "e5", value: 1 } },
    maia: { playedProb: 0.02, rank: 6, totalLegal: 30, top: [{ uci: "d2d4", san: "d4", prob: 0.61 }], moverElo: 2400 },
    classification: "rare",
  }));
  eq(rare2.text, "Nxe5 — a capture on e5; only 2% play this; Maia's pick was d4 (61%).", "rare capture");

  // promotion + check (mainline): a8=Q+ recorded facts
  const promo = phraseCommentary(explainBody({
    move: { san: "a8=Q+", uci: "a7a8q", by: "white", ply: 1, moveNumber: 1 },
    flags: { capture: false, check: true, mate: false, castle: null, promotion: "queen", enPassant: false, recapture: false },
    material: { delta: 0, captured: null },
    maia: { playedProb: 0.890339, rank: 1, totalLegal: 7, top: [{ uci: "a7a8q", san: "a8=Q+", prob: 0.890339 }], moverElo: 2400 },
    classification: "mainline",
    opening: null,
  }));
  eq(promo.text, "a8=Q+ — promotion to a queen, check; the most common move at 2400 (89%).", "promotion + check");
  eq(promo.opening, null, "no opening on a non-start base");

  // en passant (mainline 50.5%)
  const ep = phraseCommentary(explainBody({
    move: { san: "exd6", uci: "e5d6", by: "white", ply: 5, moveNumber: 3 },
    flags: { capture: true, check: false, mate: false, castle: null, promotion: null, enPassant: true, recapture: false },
    material: { delta: 1, captured: { piece: "pawn", square: "d5", value: 1 } },
    maia: { playedProb: 0.505366, rank: 1, totalLegal: 31, top: [{ uci: "e5d6", san: "exd6", prob: 0.505366 }], moverElo: 2400 },
    classification: "mainline",
  }));
  eq(ep.text, "exd6 — an en passant capture; the most common move at 2400 (51%).", "en passant");

  // mate (mainline 96.2%): Qxf7#
  const mate = phraseCommentary(explainBody({
    move: { san: "Qxf7#", uci: "h5f7", by: "white", ply: 7, moveNumber: 4 },
    flags: { capture: true, check: true, mate: true, castle: null, promotion: null, enPassant: false, recapture: false },
    material: { delta: 1, captured: { piece: "pawn", square: "f7", value: 1 } },
    maia: { playedProb: 0.962409, rank: 1, totalLegal: 43, top: [{ uci: "h5f7", san: "Qxf7#", prob: 0.962409 }], moverElo: 2400 },
    classification: "mainline",
  }));
  eq(mate.text, "Qxf7# — a capture on f7, checkmate; the most common move at 2400 (96%).", "mate");

  // a plain check, rare (Re7+ 1.2%, rank 11, Maia's pick Rd2 17.2%)
  const check = phraseCommentary(explainBody({
    move: { san: "Re7+", uci: "e2e7", by: "white", ply: 1, moveNumber: 1 },
    flags: { capture: false, check: true, mate: false, castle: null, promotion: null, enPassant: false, recapture: false },
    material: { delta: 0, captured: null },
    maia: { playedProb: 0.012146, rank: 11, totalLegal: 17, top: [{ uci: "e2d2", san: "Rd2", prob: 0.171872 }], moverElo: 2400 },
    classification: "rare",
    opening: null,
  }));
  eq(check.text, "Re7+ — check; only 1% play this; Maia's pick was Rd2 (17%).", "check + rare");

  // unknown classification (future server field) still carries Maia's numbers
  const unknown = maiaClause({ classification: "?", flags: {}, maia: { playedProb: 0.5, top: [{ san: "Nf3", prob: 0.6 }], moverElo: 2400 } });
  includes(unknown, "Nf3", "unknown band clause");
  eq(eventClause({}, {}), "", "quiet move has no event clause");
  eq(eventClause({ check: true }, {}), "check", "bare check");
});

await test("commentaryFacts + buildLlmPrompt: the facts JSON, no hidden info, constraint text present", () => {
  const facts = commentaryFacts(explainBody(), "cxd5 — a recapture; 98% of 2400s take back.");
  eq(facts.move, "cxd5", "move");
  eq(facts.by, "white", "by");
  eq(facts.flags.recapture, true, "recapture fact");
  eq(facts.classification, "mainline", "classification");
  eq(facts.maia.playedProb, 0.983822, "probability");
  eq(facts.maia.top.san, "cxd5", "top pick");
  eq(facts.opening.eco, "A60", "opening");
  eq(facts.template, "cxd5 — a recapture; 98% of 2400s take back.", "template included");
  eq(facts.wdl.before.win, 0.458563, "wdl included");

  const prompt = buildLlmPrompt({ explain: explainBody(), template: "tpl" });
  eq(prompt.system, LLM_SYSTEM_PROMPT, "exact mandated system prompt");
  includes(prompt.system, "Never add chess analysis, tactics, or claims not in the facts", "constraint text");
  includes(prompt.system, "No engine evaluations", "engine-evaluation ban");
  includes(prompt.system, "Plain text", "plain text");
  includes(prompt.user, '"move": "cxd5"', "facts JSON embedded");
  includes(prompt.user, '"playedProb": 0.983822', "numbers embedded");
  includes(prompt.user, "A60", "opening embedded");

  eq(llmProvider("groq").origin, LLM_PROVIDERS.groq.origin, "provider origin");
  eq(llmProvider("templates"), null, "templates have no provider");
  eq(normalizeLlmEngine("nonsense"), LLM_DEFAULT_ENGINE, "engine normalization");
  eq(normalizeLlmEngine(undefined), "templates", "default engine is templates");
  eq(providerPrivacyLine("groq"), "positions are sent to api.groq.com", "privacy line (groq)");
  eq(providerPrivacyLine("gemini"), "positions are sent to generativelanguage.googleapis.com", "privacy line (gemini)");
  eq(providerPrivacyLine("templates"), null, "no privacy line for templates");
});

await test("sanitizeLlmText: fences/backticks/quotes/chatty prefix/whitespace + the 220-char cap", () => {
  eq(sanitizeLlmText("That is the main line here."), "That is the main line here.", "plain");
  eq(sanitizeLlmText("```text\nThat is the main line here.\n```"), "That is the main line here.", "code fence");
  eq(sanitizeLlmText("Sure! `cxd5` takes back the pawn."), "cxd5 takes back the pawn.", "chatty prefix + backticks");
  eq(sanitizeLlmText('"A solid recapture."'), "A solid recapture.", "quotes");
  eq(sanitizeLlmText("Line one.\n\nLine   two."), "Line one. Line two.", "whitespace collapse");
  eq(sanitizeLlmText("**Bold** and _emphasis_."), "Bold and emphasis.", "markdown emphasis");
  eq(sanitizeLlmText("   "), null, "empty -> null");
  eq(sanitizeLlmText(null), null, "non-string -> null");
  eq(sanitizeLlmText("one two three four five", { maxChars: 12 }), "one two thre…", "small cap cuts at the limit");

  const long = `${"cxd5 is the natural recapture here. ".repeat(20)}end`;
  const capped = sanitizeLlmText(long);
  ok(capped.length <= LLM_MAX_CHARS + 1, `capped length ${capped.length}`);
  ok(capped.endsWith("…"), "ellipsis marks the cap");
  eq(LLM_MAX_CHARS, 220, "documented cap");
});

await test("llmPhrase: groq + gemini shapes, and every failure -> {ok:false} (fallback signal)", async () => {
  const requestSeen = {};
  const groqOk = await llmPhrase({
    engine: "groq",
    apiKey: "test-key-123",
    explain: explainBody(),
    template: "tpl",
    fetchImpl: async (url, options) => {
      requestSeen.groq = { url, options, body: JSON.parse(options.body) };
      return jsonResponse(200, { choices: [{ message: { content: "```\nNice take-back — that pawn comes straight back.\n```" } }] });
    },
  });
  eq(groqOk.ok, true, "groq ok");
  eq(groqOk.text, "Nice take-back — that pawn comes straight back.", "groq text sanitized");
  eq(groqOk.provider, "groq", "provider");
  eq(groqOk.model, LLM_PROVIDERS.groq.model, "model");
  eq(requestSeen.groq.url, LLM_PROVIDERS.groq.endpoint, "groq endpoint");
  eq(requestSeen.groq.options.headers.Authorization, "Bearer test-key-123", "key in the header");
  includes(requestSeen.groq.body.messages[0].content, "Rephrase ONLY these facts", "system message");
  eq(requestSeen.groq.body.messages[1].content.includes("cxd5"), true, "facts in the user message");
  eq(JSON.stringify(groqOk).includes("test-key-123"), false, "the key is never echoed by the result");

  const geminiOk = await llmPhrase({
    engine: "gemini",
    apiKey: "gemini-key",
    explain: explainBody(),
    template: "tpl",
    fetchImpl: async (url, options) => {
      eq(url, LLM_PROVIDERS.gemini.endpoint, "gemini endpoint");
      eq(options.headers["x-goog-api-key"], "gemini-key", "key in the header (never the URL)");
      eq(url.includes("gemini-key"), false, "no key in the URL");
      const body = JSON.parse(options.body);
      eq(body.contents[0].parts[0].text.includes("cxd5"), true, "gemini facts");
      eq(body.systemInstruction.parts[0].text, LLM_SYSTEM_PROMPT, "gemini system prompt");
      return jsonResponse(200, { candidates: [{ content: { parts: [{ text: "Straight back with the pawn." }] } }] });
    },
  });
  eq(geminiOk.ok, true, "gemini ok");
  eq(geminiOk.text, "Straight back with the pawn.", "gemini text");

  // no key / no provider — the panel keeps the template
  eq((await llmPhrase({ engine: "groq", apiKey: "", explain: explainBody() })).errorClass, LLM_ERRORS.NO_KEY, "no key");
  eq((await llmPhrase({ engine: "templates", apiKey: "x", explain: explainBody() })).errorClass, LLM_ERRORS.NO_PROVIDER, "templates");

  // provider HTTP error, provider-shaped error, empty body, timeout, offline
  const http = await llmPhrase({
    engine: "groq", apiKey: "k", explain: explainBody(),
    fetchImpl: async () => jsonResponse(500, { error: { message: "internal error" } }),
  });
  eq(http.errorClass, LLM_ERRORS.HTTP, "500");
  includes(http.error, "internal error", "provider message surfaced");
  eq(JSON.stringify(http).includes("Bearer k"), false, "no auth material in errors");

  const providerError = await llmPhrase({
    engine: "gemini", apiKey: "k", explain: explainBody(),
    fetchImpl: async () => jsonResponse(200, { error: { message: "API key not valid" } }),
  });
  eq(providerError.errorClass, LLM_ERRORS.PROVIDER_ERROR, "provider error body");
  eq(providerError.text, null, "no text on a provider error");

  const empty = await llmPhrase({
    engine: "groq", apiKey: "k", explain: explainBody(),
    fetchImpl: async () => jsonResponse(200, { choices: [{ message: { content: "  " } }] }),
  });
  eq(empty.errorClass, LLM_ERRORS.EMPTY, "empty completion");

  let slow = 0;
  const timedOut = await llmPhrase({
    engine: "groq", apiKey: "k", explain: explainBody(), timeoutMs: 25,
    fetchImpl: (url, options) => { slow += 1; return hangingFetch()(url, options); },
  });
  eq(slow, 1, "one attempt only (the panel falls back)");
  eq(timedOut.errorClass, LLM_ERRORS.TIMEOUT, "timeout");
  eq(timedOut.text, null, "no text on timeout");

  const offline = await llmPhrase({
    engine: "groq", apiKey: "k", explain: explainBody(),
    fetchImpl: async () => { throw new TypeError("fetch failed"); },
  });
  eq(offline.errorClass, LLM_ERRORS.OFFLINE, "offline");

  // the test seam (the proof's canned endpoint) is just an endpoint override
  const canned = await llmPhrase({
    engine: "groq", apiKey: "k", explain: explainBody(), endpoint: "http://127.0.0.1:8765/llm/groq",
    fetchImpl: async (url) => {
      eq(url, "http://127.0.0.1:8765/llm/groq", "override url");
      return jsonResponse(200, { choices: [{ message: { content: "canned text" } }] });
    },
  });
  eq(canned.text, "canned text", "canned endpoint");

  eq(parseLlmResponse(LLM_PROVIDERS.groq, { choices: [] }), null, "empty choices -> null");
  eq(parseLlmResponse(LLM_PROVIDERS.gemini, { candidates: [] }), null, "empty candidates -> null");
  eq(buildLlmRequest(LLM_PROVIDERS.groq, { system: "s", user: "u" }, "key").body.max_tokens, 120, "token cap");
});

await test("testLlmConnection + permissions: status without ever exposing the key", async () => {
  const noKey = await testLlmConnection({ engine: "groq", apiKey: "" });
  eq(noKey.ok, false, "no key fails");
  eq(noKey.errorClass, LLM_ERRORS.NO_KEY, "no_key class");

  const okTest = await testLlmConnection({
    engine: "gemini",
    apiKey: "k",
    fetchImpl: async (_url, options) => {
      const body = JSON.parse(options.body);
      const facts = JSON.parse(body.contents[0].parts[0].text);
      eq(facts.check, "connection test", "connection-test facts");
      return jsonResponse(200, { candidates: [{ content: { parts: [{ text: "OK" }] } }] });
    },
  });
  eq(okTest.ok, true, "test ok");
  eq(okTest.sample, "OK", "sample");

  const permissionsImpl = {
    async request({ origins }) { return origins[0] === LLM_PROVIDERS.groq.origin; },
    async contains({ origins }) { return origins[0] === LLM_PROVIDERS.groq.origin; },
  };
  const granted = await requestLlmPermission("groq", { permissionsImpl });
  eq(granted.status, "granted", "granted");
  const declined = await requestLlmPermission("gemini", { permissionsImpl });
  eq(declined.status, "declined", "declined for the other origin");
  const templates = await requestLlmPermission("templates", { permissionsImpl });
  eq(templates.status, "templates", "templates need no permission");
  const unavailable = await requestLlmPermission("groq", { permissionsImpl: {} });
  eq(unavailable.status, "unavailable", "no chrome.permissions");

  eq(await llmPermissionState("groq", { permissionsImpl }), "granted", "state granted");
  eq(await llmPermissionState("templates", { permissionsImpl }), "templates", "state templates");

  // the requested origin is exactly the manifest's optional host permission
  eq(LLM_PROVIDERS.groq.origin, "https://api.groq.com/*", "groq origin pattern");
  eq(LLM_PROVIDERS.gemini.origin, "https://generativelanguage.googleapis.com/*", "gemini origin pattern");
});

await test("display helpers: classification chips + you/opponent labels", () => {
  eq(classificationChip("mainline"), "main line", "mainline");
  eq(classificationChip("common"), "common", "common");
  eq(classificationChip("uncommon"), "uncommon", "uncommon");
  eq(classificationChip("rare"), "rare", "rare");
  eq(classificationChip(null), "—", "unknown");

  eq(moverLabel("white", "white"), "you", "our move");
  eq(moverLabel("black", "white"), "opponent", "their move");
  eq(moverLabel("black", null), "black", "unknown color");
  eq(moverLabel("?", "white"), "?", "unknown mover");
});

/* ------------------------------------------------------------------ done */

const failed = results.filter((record) => !record.pass);
const summary = {
  tool: "commentary-unit.mjs",
  generatedAt: new Date().toISOString(),
  node: process.version,
  modules: [
    "extension/src/analysis/explain-client.js",
    "extension/src/commentary/phrase.js",
    "extension/src/commentary/llm.js",
  ],
  passed,
  failed: failed.length,
  total: results.length,
  cases: results,
};
await mkdir(OUT_DIR, { recursive: true });
await writeFile(path.join(OUT_DIR, "commentary-unit.json"), `${JSON.stringify(summary, null, 2)}\n`);

console.log(`\n${passed} passed, ${failed.length} failed`);
console.log(`results: ${path.relative(REPO_ROOT, path.join(OUT_DIR, "commentary-unit.json"))}`);
if (failed.length > 0) {
  console.log("failures:");
  for (const failure of failed) console.log(` - ${failure.name}: ${failure.message}`);
  process.exitCode = 1;
}

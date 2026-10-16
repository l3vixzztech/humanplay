/**
 * humanplay — /premove client (Milestone 7)
 * =========================================
 *
 * The M4 analysis client's twin: the single place that talks to the local
 * Maia-3 helper server's premove planner. Pure-ish (no chrome.*, no DOM): the
 * same file runs in the side panel and in plain Node for the zero-dep unit
 * tests (test/tools/premove-unit.mjs). `fetch` is injectable.
 *
 * Contract with the server (docs/PROJECT.md, server/premove_engine.py):
 *
 *   POST http://127.0.0.1:8765/premove
 *   {fen, moves?, elo_self?, elo_oppo?, top_n?, min_safety?, mode?}
 *   -> {fen, side_to_move, opponent: [{uci, san, prob}],
 *       recommended: null | {uci, san, criterion, safety, min_response_prob, detail},
 *       candidates: [{uci, san, safe_mass, guard_mass, min_response_prob, verdict, why}],
 *       excluded: [{uci, san, prob, reason}], reason, params, timings_ms, model, elapsed_ms}
 *
 * `fen` is the BASE position and `moves` (UCI) are applied on top of it — the
 * same mapping `buildAnalyzeRequest` performs for /analyze (replayed history ->
 * startpos + moves; adapter mismatch -> board FEN only). The resolved position
 * is the one on the board with the OPPONENT to move: the planner predicts their
 * candidates from Maia(elo_oppo) and our replies from Maia(elo_self).
 *
 * What this module provides:
 *
 *   premove({…})                  one request (AbortController timeout,
 *                                 **exactly one retry on a network failure**,
 *                                 never on 4xx/5xx or a timeout) -> result object
 *                                 {ok, status, data, roundTripMs, error,
 *                                  errorClass, attempts, attemptLog}
 *   createPremoveClient({…})      stateful wrapper: premove position-key LRU
 *                                 cache + in-flight dedupe + stale guard
 *                                 (`expectKey()` / `result.stale`), exactly like
 *                                 the M4 analyze client. `noteSessionSeq()`
 *                                 clears the cache on a new game.
 *   buildPremoveRequest(state, …) GameState -> /premove payload (reuses the M4
 *                                 request mapping) + key + history metadata.
 *   premoveGate(state, …)         auto-plan policy: assistant on + state ok +
 *                                 userColor known + the OPPONENT to move.
 *
 * Errors are the same classes as the analyze client (`ERROR_CLASSES`): offline /
 * timeout / invalid_input / engine_unavailable / http / bad_response.
 */

import { ERROR_CLASSES, buildAnalyzeRequest } from "./analyze-client.js";

/** Must match `host_permissions` in manifest.json. */
export const PREMOVE_URL = "http://127.0.0.1:8765/premove";

export const PREMOVE_DEFAULT_TOP_N = 5;
export const PREMOVE_MIN_TOP_N = 1;
export const PREMOVE_MAX_TOP_N = 12;
export const PREMOVE_DEFAULT_MIN_SAFETY = 0.9;
export const PREMOVE_MIN_SAFETY_MIN = 0.5;
export const PREMOVE_MIN_SAFETY_MAX = 1.0;
export const PREMOVE_MODES = Object.freeze(["top", "all"]);
export const PREMOVE_DEFAULT_MODE = "top";

/** top mode is ~90 ms server-side; 5 s is generous even for a cold model load. */
export const PREMOVE_DEFAULT_TIMEOUT_MS = 5000;
/** Same small LRU rationale as M4 (one position per ply). */
export const PREMOVE_DEFAULT_MAX_CACHE_ENTRIES = 24;

export { ERROR_CLASSES };

/* ----------------------------------------------------------------- helpers */

export function clampTopN(value, fallback = PREMOVE_DEFAULT_TOP_N) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(PREMOVE_MIN_TOP_N, Math.min(PREMOVE_MAX_TOP_N, Math.round(number)));
}

export function clampMinSafety(value, fallback = PREMOVE_DEFAULT_MIN_SAFETY) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(PREMOVE_MIN_SAFETY_MIN, Math.min(PREMOVE_MIN_SAFETY_MAX, number));
}

export function normalizePremoveMode(value, fallback = PREMOVE_DEFAULT_MODE) {
  return PREMOVE_MODES.includes(value) ? value : fallback;
}

/**
 * Canonical premove position key: every input the planner result depends on.
 * Identical keys => identical plan => safe to cache / never re-request.
 */
export function premovePositionKey({
  fen,
  moves = [],
  elo_self = 2400,
  elo_oppo = 2400,
  top_n = PREMOVE_DEFAULT_TOP_N,
  min_safety = PREMOVE_DEFAULT_MIN_SAFETY,
  mode = PREMOVE_DEFAULT_MODE,
} = {}) {
  const list = Array.isArray(moves) ? moves : [];
  return `${fen}|${list.join(" ")}|${elo_self}|${elo_oppo}|${top_n}|${min_safety}|${mode}`;
}

/**
 * GameState -> /premove payload. The position mapping is **shared** with /analyze
 * (`buildAnalyzeRequest`): replayed history is sent as `startpos + moves` so
 * Maia's history planes see the real game; an adapter mismatch (or unusable
 * history) falls back to the board FEN with a warning. The premove-specific
 * fields (top_n / min_safety / mode) are appended.
 */
export function buildPremoveRequest(
  state,
  {
    eloSelf = 2400,
    eloOppo = 2400,
    topN = PREMOVE_DEFAULT_TOP_N,
    minSafety = PREMOVE_DEFAULT_MIN_SAFETY,
    mode = PREMOVE_DEFAULT_MODE,
  } = {},
) {
  const base = buildAnalyzeRequest(state, { eloSelf, eloOppo });
  const request = {
    fen: base.fen,
    moves: base.moves,
    elo_self: base.elo_self,
    elo_oppo: base.elo_oppo,
    top_n: clampTopN(topN),
    min_safety: clampMinSafety(minSafety),
    mode: normalizePremoveMode(mode),
  };
  return {
    ...request,
    positionMode: base.mode, // "history" | "board-only" (the adapter mapping, not the planner mode)
    historyUsed: base.historyUsed,
    warning: base.warning,
    key: premovePositionKey(request),
  };
}

/**
 * Auto-plan policy.
 *
 *   mode "auto"     -> plan now (assistant on, state ok, color known, THEIR turn)
 *   mode "waiting"  -> your turn; the premove card shows "waiting for your move"
 *   mode "no-color" -> userColor unknown
 *   mode "off"      -> assistant toggle off
 *   mode "no-state" -> nothing to plan
 */
export function premoveGate(state, { assistantEnabled = true } = {}) {
  if (!state?.ok) return { mode: "no-state", canAuto: false, reason: "no game state" };
  if (!assistantEnabled) return { mode: "off", canAuto: false, reason: "assistant off" };
  if (state.userColor !== "white" && state.userColor !== "black") {
    return { mode: "no-color", canAuto: false, reason: "your color is unknown" };
  }
  const turnColor = state.turn === "b" || state.turn === "black" ? "black" : "white";
  if (turnColor === state.userColor) {
    return { mode: "waiting", canAuto: false, reason: "waiting for your move" };
  }
  return { mode: "auto", canAuto: true, reason: "their turn" };
}

/* --------------------------------------------------------------- one call */

function classifyHttpError(status) {
  if (status === 400 || status === 422) return ERROR_CLASSES.INVALID_INPUT;
  if (status === 503) return ERROR_CLASSES.ENGINE_UNAVAILABLE;
  return ERROR_CLASSES.HTTP;
}

function isPremoveResponse(parsed) {
  return Boolean(
    parsed &&
      typeof parsed === "object" &&
      Array.isArray(parsed.opponent) &&
      Array.isArray(parsed.candidates) &&
      "recommended" in parsed &&
      typeof parsed.params === "object" &&
      parsed.params !== null,
  );
}

/**
 * One /premove request (with the exactly-once network retry, same as M4).
 * Never throws for transport/server problems — everything becomes a result
 * object, so the panel and the tests handle one shape only.
 */
export async function premove({
  fen,
  moves = [],
  elo_self = 2400,
  elo_oppo = 2400,
  top_n = PREMOVE_DEFAULT_TOP_N,
  min_safety = PREMOVE_DEFAULT_MIN_SAFETY,
  mode = PREMOVE_DEFAULT_MODE,
  timeoutMs = PREMOVE_DEFAULT_TIMEOUT_MS,
  fetchImpl = globalThis.fetch,
  url = PREMOVE_URL,
  now = () => Date.now(),
} = {}) {
  const body = JSON.stringify({ fen, moves, elo_self, elo_oppo, top_n, min_safety, mode });
  const startedAtTotal = now();
  const attemptLog = [];
  let lastError = null;
  let parsed = null;

  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const startedAt = now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response = null;
    let rawText = null;
    parsed = null;
    try {
      response = await fetchImpl(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
        signal: controller.signal,
        cache: "no-store",
      });
      const text = await response.text();
      rawText = text;
      try {
        parsed = text ? JSON.parse(text) : null;
      } catch {
        parsed = null;
      }
      attemptLog.push({ attempt, outcome: response.ok ? "ok" : "http", status: response.status, durationMs: now() - startedAt });
    } catch (error) {
      const aborted = error?.name === "AbortError";
      attemptLog.push({
        attempt,
        outcome: aborted ? "timeout" : "network-error",
        status: null,
        durationMs: now() - startedAt,
      });
      if (aborted) {
        lastError = {
          class: ERROR_CLASSES.TIMEOUT,
          message: `no response within ${timeoutMs} ms`,
          detail: `${url} did not answer in ${timeoutMs} ms`,
        };
        break; // a timeout is not a network failure: never retried
      }
      lastError = {
        class: ERROR_CLASSES.OFFLINE,
        message: `could not reach ${url}`,
        detail: error?.message ?? String(error),
      };
      continue; // exactly one retry, only for network failures
    } finally {
      clearTimeout(timer);
    }

    if (response.ok) {
      if (isPremoveResponse(parsed)) {
        return {
          ok: true,
          status: response.status,
          data: parsed,
          roundTripMs: now() - startedAtTotal,
          error: null,
          errorClass: null,
          attempts: attemptLog.length,
          attemptLog,
        };
      }
      lastError = {
        class: ERROR_CLASSES.BAD_RESPONSE,
        message: "server answered 2xx but the body is not a /premove response",
        detail: (rawText ?? "").slice(0, 300) || null,
      };
      break;
    }

    const detail =
      (parsed && typeof parsed.detail === "string" && parsed.detail) ||
      (parsed && parsed.detail !== undefined ? JSON.stringify(parsed.detail) : null);
    lastError = {
      class: classifyHttpError(response.status),
      message: `HTTP ${response.status}`,
      detail,
      status: response.status,
    };
    break; // never retry 4xx/5xx
  }

  return {
    ok: false,
    status: lastError?.status ?? null,
    data: parsed,
    roundTripMs: now() - startedAtTotal,
    error: lastError,
    errorClass: lastError?.class ?? ERROR_CLASSES.OFFLINE,
    attempts: attemptLog.length,
    attemptLog,
  };
}

/* ------------------------------------------------------- stateful client */

/**
 * Panel-facing client: LRU cache + in-flight dedupe + stale guard (identical
 * semantics to `createAnalyzeClient`, separate cache/key because the request
 * shape and therefore the result differ).
 *
 * The stale guard is the M7 trigger's safety net: the panel asks for a plan the
 * moment the opponent's turn begins; if the opponent moves while the request is
 * in flight, the key is no longer current and the result resolves
 * `stale: true` — the panel (and therefore the overlay and the speaker) must
 * discard it silently.
 */
export function createPremoveClient({
  fetchImpl = globalThis.fetch,
  url = PREMOVE_URL,
  timeoutMs = PREMOVE_DEFAULT_TIMEOUT_MS,
  maxCacheEntries = PREMOVE_DEFAULT_MAX_CACHE_ENTRIES,
  now = () => Date.now(),
} = {}) {
  const cache = new Map();
  const inflight = new Map();
  const stats = {
    requests: 0,
    retries: 0,
    cacheHits: 0,
    dedupes: 0,
    staleDiscards: 0,
    sessionResets: 0,
  };
  let currentKey = null;
  let sessionSeq = null;

  function remember(key, result) {
    if (!result.ok) return; // failures are never cached
    if (cache.has(key)) cache.delete(key);
    cache.set(key, result);
    while (cache.size > maxCacheEntries) cache.delete(cache.keys().next().value);
  }

  function withStaleness(result, key, extra) {
    const stale = key !== currentKey;
    if (stale) stats.staleDiscards += 1;
    return { ...result, key, ...extra, stale };
  }

  async function request(key, payload, force) {
    if (!force) {
      const cached = cache.get(key);
      if (cached) {
        stats.cacheHits += 1;
        remember(key, cached);
        return withStaleness(cached, key, { fromCache: true, deduped: false });
      }
      const pending = inflight.get(key);
      if (pending) {
        stats.dedupes += 1;
        const shared = await pending;
        return withStaleness(shared, key, { fromCache: false, deduped: true });
      }
    }

    const requestedAt = now();
    stats.requests += 1;
    const promise = premove({ ...payload, timeoutMs, fetchImpl, url, now }).then((result) => ({
      ...result,
      resolvedAt: now(),
    }));
    inflight.set(key, promise);
    let result;
    try {
      result = await promise;
    } finally {
      inflight.delete(key);
    }
    if (result.attempts > 1) stats.retries += 1;
    remember(key, result);
    return withStaleness({ ...result, requestedAt }, key, { fromCache: false, deduped: false });
  }

  return {
    url,
    timeoutMs,

    /** @param {{fen, moves?, elo_self?, elo_oppo?, top_n?, min_safety?, mode?, key?}} payload */
    async plan(payload, { force = false } = {}) {
      const key = payload.key ?? premovePositionKey(payload);
      currentKey = key; // the newest position always wins
      return request(key, payload, force);
    },

    /** Declare the position on the board without requesting a plan. */
    expectKey(key) {
      currentKey = key;
      return currentKey;
    },

    /** New game (adapter sessionSeq changed) -> the whole cache is void. */
    noteSessionSeq(seq) {
      const first = sessionSeq === null;
      if (first) {
        sessionSeq = seq;
        return { changed: false, first: true, cleared: 0 };
      }
      if (seq === sessionSeq) return { changed: false, first: false, cleared: 0 };
      const cleared = cache.size;
      cache.clear();
      inflight.clear();
      sessionSeq = seq;
      stats.sessionResets += 1;
      return { changed: true, first: false, cleared };
    },

    getCurrentKey: () => currentKey,
    isCurrent: (key) => key === currentKey,
    cacheSize: () => cache.size,
    cacheKeys: () => [...cache.keys()],
    hasInflight: (key) => inflight.has(key),
    getStats: () => ({ ...stats }),
    clearCache: () => {
      const cleared = cache.size;
      cache.clear();
      return cleared;
    },
  };
}

/* ----------------------------------------------------------------- display */

/** Criterion chip text for the panel ("robust vs 94%" / "safe vs all replies"). */
export function criterionLabel(recommended) {
  if (!recommended || !recommended.criterion) return null;
  if (recommended.criterion === "forced") return "forced";
  if (recommended.criterion === "safe_vs_all") return "safe vs all replies";
  const safety = Number(recommended.safety);
  return Number.isFinite(safety) ? `robust vs ${Math.round(safety * 100)}%` : "robust";
}

/** The honest caveat line for mode "top" (mandated wording, docs/PROJECT.md). */
export function premoveCaveat(mode, topN) {
  if (mode === "top") {
    return `safe only over their top-${topN}; a premove still fires whenever it is legal`;
  }
  return "every legal reply considered; a premove still fires whenever it is legal";
}

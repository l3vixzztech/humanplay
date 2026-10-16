/**
 * humanplay — /analyze client (Milestone 4)
 * =========================================
 *
 * The single place that talks to the local Maia-3 helper server over HTTP.
 * Pure-ish (no chrome.*, no DOM): the same file runs in the side panel, in
 * Chrome's extension context and in plain Node for the zero-dep unit tests
 * (test/tools/analyze-unit.mjs). `fetch` is injectable for tests.
 *
 * Contract with the server (frozen, docs/PROJECT.md / server/README.md):
 *
 *   POST http://127.0.0.1:8765/analyze
 *   {fen, moves?, elo_self?, elo_oppo?, top_k?}
 *   -> {moves: [{uci, san, prob}], wdl: {win, draw, loss}, model, elapsed_ms}
 *
 * `fen` is the BASE position; `moves` (UCI) are applied on top of it and fill
 * Maia's history planes. `wdl` is from the **side-to-move** perspective of the
 * analyzed position. For a finished game the server answers
 * `moves: []` + a rules-decided WDL (checkmate/stalemate) instead of engine
 * output — no error.
 *
 * What this module provides:
 *
 *   analyze({fen, moves, elo_self, elo_oppo, top_k, timeoutMs, fetchImpl})
 *       one request. Timeout via AbortController; **exactly one retry on a
 *       network failure** (connection refused/dropped) and **exactly one retry
 *       on HTTP 503** (the engine refuses while the model is cold-loading)
 *       after a short backoff; never on a 4xx/5xx response or on a timeout.
 *       Error classes: offline / timeout / invalid_input / engine_unavailable /
 *       http / bad_response.
 *       -> {ok, status, data, roundTripMs, error, errorClass, attempts, …}
 *
 *   createAnalyzeClient({fetchImpl, …})
 *       stateful wrapper used by the panel: position-key LRU cache (identical
 *       state re-emits never re-request), in-flight dedupe (a repeated key
 *       while a request is running reuses that request), and the **stale
 *       guard**: every request carries its position key and a result whose key
 *       is not the current key is discarded (`result.stale === true`, new
 *       position always wins). `noteSessionSeq()` clears the cache on a new
 *       game.
 *
 *   buildAnalyzeRequest(state, {eloSelf, eloOppo, topK})
 *       GameState -> /analyze payload. With a replayed history the request is
 *       `{fen: <standard start position>, moves: <full UCI history>}` so Maia's
 *       history planes see the real game; when the adapter reports a mismatch
 *       (or no usable history) it falls back to `{fen: <board FEN>, moves: []}`.
 *
 *   analysisGate(state, {assistantEnabled})
 *       auto-analyze policy: assistant on + adapter state ok + userColor known +
 *       your turn. Everything else is an explicit manual action.
 */

/** Must match `host_permissions` in manifest.json. */
export const ANALYZE_URL = "http://127.0.0.1:8765/analyze";

/** Standard start position — the base for replayed chess.com histories. */
export const STARTPOS_FEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

export const DEFAULT_ELO = 2400; // "strong human" preset (docs/PROJECT.md)
export const ELO_MIN = 0;
export const ELO_MAX = 5000;
export const DEFAULT_TOP_K = 3;
export const MAX_TOP_K = 20;

/** Engine inference is ~10–15 ms; 4 s is generous even for a cold model load. */
export const DEFAULT_TIMEOUT_MS = 4000;
/** Small LRU: a real game has one position per ply; 24 covers a long game. */
export const DEFAULT_MAX_CACHE_ENTRIES = 24;
/**
 * M9: a cold Maia-3 load answers HTTP 503 for the first requests. One retry
 * after this short backoff is worth it (the second request usually succeeds);
 * the delay is injectable so the unit tests stay instant.
 */
export const RETRY_503_DELAY_MS = 300;

/** Error classes surfaced to the panel and the tests. */
export const ERROR_CLASSES = Object.freeze({
  OFFLINE: "offline", // connection refused / dropped (server not running)
  TIMEOUT: "timeout", // no response within timeoutMs
  INVALID_INPUT: "invalid_input", // HTTP 400/422 — server rejected the position
  ENGINE_UNAVAILABLE: "engine_unavailable", // HTTP 503 — model failed to load
  HTTP: "http", // any other non-2xx status
  BAD_RESPONSE: "bad_response", // 2xx body that is not the expected schema
});

/* ----------------------------------------------------------------- helpers */

export function clampElo(value, fallback = DEFAULT_ELO) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(ELO_MIN, Math.min(ELO_MAX, Math.round(number)));
}

export function clampTopK(value, fallback = DEFAULT_TOP_K) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(1, Math.min(MAX_TOP_K, Math.round(number)));
}

/**
 * Canonical position key: every input the server result depends on.
 * Identical keys => identical analysis => safe to cache / never re-request.
 */
export function positionKey({ fen, moves = [], elo_self = DEFAULT_ELO, elo_oppo = DEFAULT_ELO, top_k = DEFAULT_TOP_K } = {}) {
  const list = Array.isArray(moves) ? moves : [];
  return `${fen}|${list.join(" ")}|${elo_self}|${elo_oppo}|${top_k}`;
}

/**
 * GameState -> /analyze payload (+ how the request was built).
 *
 * The adapter's `fen` is the CURRENT position and `movesUci` the FULL history
 * (both exact, from chess.com's own DOM). The server wants the BASE position
 * plus the moves on top of it, so a replayed history is sent as
 * `startpos + movesUci` — which the replay guarantees to be the current
 * position. Only when the adapter flags a mismatch (or has no usable history)
 * do we send the board FEN alone and say so.
 */
export function buildAnalyzeRequest(state, { eloSelf = DEFAULT_ELO, eloOppo = DEFAULT_ELO, topK = DEFAULT_TOP_K } = {}) {
  const moves = Array.isArray(state?.movesUci) ? state.movesUci.slice() : [];
  const mismatch = state?.mismatch ?? null;
  const historyStatus = state?.historyStatus ?? null;
  const useHistory = !mismatch && historyStatus === "replayed" && moves.length > 0;

  const request = {
    fen: useHistory ? STARTPOS_FEN : (typeof state?.fen === "string" && state.fen ? state.fen : STARTPOS_FEN),
    moves: useHistory ? moves : [],
    elo_self: clampElo(eloSelf),
    elo_oppo: clampElo(eloOppo),
    top_k: clampTopK(topK),
  };

  let warning = null;
  if (mismatch) {
    warning =
      `adapter mismatch (${mismatch.kind ?? "unknown"}): the move list and the board disagree — ` +
      "analyzing the board position WITHOUT the move history";
  } else if (!useHistory && moves.length > 0) {
    warning =
      `move history not usable (historyStatus: ${historyStatus ?? "?"}) — ` +
      "analyzing the board position only";
  }

  return {
    ...request,
    mode: useHistory ? "history" : "board-only",
    historyUsed: useHistory ? moves.length : 0,
    warning,
    key: positionKey(request),
  };
}

/**
 * Auto-analyze policy.
 *
 *   mode "auto"     -> analyze now (assistant on, state ok, color known, your turn)
 *   mode "waiting"  -> opponent's turn (opponent prediction = M7); manual still works
 *   mode "no-color" -> userColor unknown; manual still works
 *   mode "off"      -> assistant toggle off; manual still works
 *   mode "no-state" -> nothing to analyze; manual disabled
 */
export function analysisGate(state, { assistantEnabled = true } = {}) {
  if (!state?.ok) return { mode: "no-state", canAuto: false, canManual: false, reason: "no game state" };
  if (!assistantEnabled) return { mode: "off", canAuto: false, canManual: true, reason: "assistant off" };
  if (state.userColor !== "white" && state.userColor !== "black") {
    return { mode: "no-color", canAuto: false, canManual: true, reason: "your color is unknown" };
  }
  // GameState.turn is the FEN field ("w"/"b"); userColor is "white"/"black".
  const turnColor = state.turn === "b" || state.turn === "black" ? "black" : "white";
  if (turnColor !== state.userColor) {
    return { mode: "waiting", canAuto: false, canManual: true, reason: "their turn — waiting" };
  }
  return { mode: "auto", canAuto: true, canManual: true, reason: "your turn" };
}

/* --------------------------------------------------------------- one call */

/** The injectable backoff sleep (unit tests pass a no-op). */
export const defaultDelay = (ms) => new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));

function classifyHttpError(status, detail) {
  if (status === 400 || status === 422) return ERROR_CLASSES.INVALID_INPUT;
  if (status === 503) return ERROR_CLASSES.ENGINE_UNAVAILABLE;
  return ERROR_CLASSES.HTTP;
}

/**
 * One /analyze request (with the exactly-once network retry and the
 * exactly-once HTTP-503 retry after a short backoff).
 * Never throws for transport/server problems — everything becomes a result
 * object, so the panel and the tests handle one shape only.
 */
export async function analyze({
  fen,
  moves = [],
  elo_self = DEFAULT_ELO,
  elo_oppo = DEFAULT_ELO,
  top_k = DEFAULT_TOP_K,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  retry503DelayMs = RETRY_503_DELAY_MS,
  delayImpl = defaultDelay,
  fetchImpl = globalThis.fetch,
  url = ANALYZE_URL,
  now = () => Date.now(),
} = {}) {
  const body = JSON.stringify({ fen, moves, elo_self, elo_oppo, top_k });
  const startedAtTotal = now();
  const attemptLog = [];
  let lastError = null;
  let parsed = null;
  let rawText = null;

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
      attemptLog.push({
        attempt,
        outcome: response.ok ? "ok" : response.status === 503 && attempt === 1 ? "engine-503" : "http",
        status: response.status,
        durationMs: now() - startedAt,
      });
    } catch (error) {
      const aborted = error?.name === "AbortError";
      attemptLog.push({
        attempt,
        outcome: aborted ? "timeout" : "network-error",
        status: null,
        durationMs: now() - startedAt,
      });
      if (aborted) {
        // A timeout is not a network failure: the server is reachable, it just
        // did not answer in time. Retrying the same slow request helps nobody.
        lastError = {
          class: ERROR_CLASSES.TIMEOUT,
          message: `no response within ${timeoutMs} ms`,
          detail: `${url} did not answer in ${timeoutMs} ms`,
        };
        break;
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
      const wellFormed = parsed && Array.isArray(parsed.moves) && parsed.wdl && typeof parsed.wdl === "object";
      if (wellFormed) {
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
        message: "server answered 2xx but the body is not an /analyze response",
        detail: (rawText ?? "").slice(0, 300) || null,
      };
      break;
    }

    const detail =
      (parsed && typeof parsed.detail === "string" && parsed.detail) ||
      (parsed && parsed.detail !== undefined ? JSON.stringify(parsed.detail) : null);

    if (response.status === 503 && attempt === 1) {
      // The engine refused while the model was cold-loading. One retry after a
      // short backoff — the server usually answers the second request. Never
      // on 4xx, never a third attempt.
      lastError = {
        class: ERROR_CLASSES.ENGINE_UNAVAILABLE,
        message: `HTTP ${response.status}`,
        detail,
        status: response.status,
      };
      attemptLog[attemptLog.length - 1].backoffMs = retry503DelayMs;
      await delayImpl(retry503DelayMs);
      continue; // exactly one retry, only for 503
    }

    lastError = {
      class: classifyHttpError(response.status, detail),
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

/* ----------------------------------------------------------- stateful client */

/**
 * Panel-facing client: LRU cache + in-flight dedupe + stale guard.
 *
 * Life of a request:
 *   1. `analyze(request)` sets `currentKey` to the request's key (latest wins),
 *      answers from the cache when the exact key was measured before, joins
 *      an in-flight request for the same key, else performs the network call;
 *   2. when a response resolves, `result.stale` says whether its key is still
 *      the current one. Stale results MUST be discarded (`new position always
 *      wins`); `stats.staleDiscards` counts them;
 *   3. `noteSessionSeq(adapterSeq)` clears the cache on a new game, and
 *      `expectKey(key)` lets the panel declare "this is the position on the
 *      board now" even when it does not request an analysis (e.g. opponent's
 *      turn) — an older in-flight result for the previous position then
 *      resolves as stale instead of overwriting the panel.
 */
export function createAnalyzeClient({
  fetchImpl = globalThis.fetch,
  url = ANALYZE_URL,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  retry503DelayMs = RETRY_503_DELAY_MS,
  delayImpl = defaultDelay,
  maxCacheEntries = DEFAULT_MAX_CACHE_ENTRIES,
  now = () => Date.now(),
} = {}) {
  const cache = new Map(); // positionKey -> successful result (LRU order)
  const inflight = new Map(); // positionKey -> Promise<result>
  const stats = {
    requests: 0, // logical requests that reached the network
    retries: 0,
    cacheHits: 0,
    dedupes: 0, // calls served by an in-flight request
    staleDiscards: 0,
    sessionResets: 0,
  };
  let currentKey = null;
  let sessionSeq = null;

  function remember(key, result) {
    if (!result.ok) return; // never cache failures: the user may fix the server and retry
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
        remember(key, cached); // refresh LRU position
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
    const promise = analyze({ ...payload, timeoutMs, retry503DelayMs, delayImpl, fetchImpl, url, now }).then((result) => ({
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

    /**
     * @param {{fen, moves?, elo_self?, elo_oppo?, top_k?}} payload
     * @param {{force?: boolean}} options force = manual action, skip the cache
     * @returns {Promise<{ok, status, data, roundTripMs, error, errorClass,
     *                    attempts, key, fromCache, deduped, stale}>}
     */
    async analyze(payload, { force = false } = {}) {
      const key = payload.key ?? positionKey(payload);
      currentKey = key; // the newest position always wins
      return request(key, payload, force);
    },

    /** Declare the position on the board without requesting an analysis. */
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

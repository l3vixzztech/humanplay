/**
 * humanplay — /explain client + commentary feed driver (Milestone 8)
 * ==================================================================
 *
 * The M4/M7 client's third sibling: the single place that talks to the local
 * Maia-3 helper server's live-commentary fact engine. Pure-ish (no chrome.*, no
 * DOM): the same file runs in the side panel and in plain Node for the zero-dep
 * unit tests (test/tools/commentary-unit.mjs). `fetch` is injectable.
 *
 * Contract with the server (docs/PROJECT.md, server/explain_engine.py):
 *
 *   POST http://127.0.0.1:8765/explain
 *   {fen, moves (LAST ply = the move to explain), elo_self, elo_oppo}
 *   -> {move: {san, uci, by, ply, moveNumber},
 *       flags: {capture, check, mate, castle, promotion, enPassant, recapture},
 *       material: {delta, captured: null | {piece, square, value}},
 *       maia: {playedProb, rank, totalLegal, top: [{uci, san, prob} x3], moverElo},
 *       wdl: {before, after} (mover's perspective),
 *       opening: null | {eco, name}, classification, model, elapsed_ms}
 *
 * `fen` is the BASE position and `moves` (UCI) are applied on top of it — the
 * same mapping `buildAnalyzeRequest` performs (replayed history -> startpos +
 * moves). Unlike /analyze, /explain **needs** the move that was played as the
 * last ply: without a usable history there is nothing to explain, so
 * `buildExplainRequest` returns `null` (with a reason) instead of a payload.
 *
 * What this module provides:
 *
 *   explain({…})                 one request (AbortController timeout,
 *                                **exactly one retry on a network failure**,
 *                                never on 4xx/5xx or a timeout) -> result object
 *                                {ok, status, data, roundTripMs, error,
 *                                 errorClass, attempts, attemptLog}
 *   createExplainClient({…})     stateful wrapper: explain-key LRU cache +
 *                                in-flight dedupe + stale guard (`expectKey()` /
 *                                `result.stale`), like the M4/M7 clients.
 *                                `noteSessionSeq()` clears the cache on a new game.
 *   buildExplainRequest(state, {…})
 *                                GameState -> /explain payload + key, or `null`
 *                                when the history is not usable (mismatch /
 *                                not replayed / empty).
 *   createCommentaryFeed({…})    the feed driver: detects "movesUci grew by
 *                                exactly one ply", dedupes by ply, keeps the last
 *                                ~50 entries (newest first) and clears on a new
 *                                game (`sessionSeq` change).
 *
 * Errors use the same classes as the analyze/premove clients (`ERROR_CLASSES`):
 * offline / timeout / invalid_input / engine_unavailable / http / bad_response.
 */

import { ERROR_CLASSES, STARTPOS_FEN } from "./analyze-client.js";

/** Must match `host_permissions` in manifest.json. */
export const EXPLAIN_URL = "http://127.0.0.1:8765/explain";

/** Two Maia forward passes ≈ 20–70 ms; 4 s is generous even for a cold start. */
export const EXPLAIN_DEFAULT_TIMEOUT_MS = 4000;
/** Same small-LRU rationale as M4/M7 (one article per ply). */
export const EXPLAIN_DEFAULT_MAX_CACHE_ENTRIES = 24;
/** The commentary feed keeps the last ~50 plies (documented, newest first). */
export const COMMENTARY_MAX_ENTRIES = 50;

/** The server's documented classification bands (chips in the panel). */
export const EXPLAIN_CLASSIFICATIONS = Object.freeze(["mainline", "common", "uncommon", "rare"]);

export { ERROR_CLASSES };

/* ----------------------------------------------------------------- helpers */

/**
 * Canonical explain key: every input the fact engine depends on.
 * Identical keys => identical article => safe to cache / never re-request.
 */
export function explainPositionKey({
  fen,
  moves = [],
  elo_self = 2400,
  elo_oppo = 2400,
} = {}) {
  const list = Array.isArray(moves) ? moves : [];
  return `${fen}|${list.join(" ")}|${elo_self}|${elo_oppo}`;
}

/**
 * GameState -> /explain payload, or `null` when there is no move to explain.
 *
 * /explain explains the LAST ply of `moves`, so it can only work when the
 * adapter replayed a real history: a mismatch (board ≠ move list) or an
 * absent/unreliable history is honest "no commentary for this move", never a
 * guessed article. The base is the standard start position + the full UCI
 * history, exactly like `buildAnalyzeRequest` does for /analyze.
 */
export function buildExplainRequest(state, { eloSelf = 2400, eloOppo = 2400 } = {}) {
  const moves = Array.isArray(state?.movesUci) ? state.movesUci.slice() : [];
  const mismatch = state?.mismatch ?? null;
  const historyStatus = state?.historyStatus ?? null;
  const useHistory = !mismatch && historyStatus === "replayed" && moves.length >= 1;
  if (!useHistory) {
    return null;
  }
  const request = {
    fen: STARTPOS_FEN,
    moves,
    elo_self: eloSelf,
    elo_oppo: eloOppo,
  };
  return {
    ...request,
    positionMode: "history",
    historyUsed: moves.length,
    key: explainPositionKey(request),
  };
}

/* --------------------------------------------------------------- one call */

function classifyHttpError(status) {
  if (status === 400 || status === 422) return ERROR_CLASSES.INVALID_INPUT;
  if (status === 503) return ERROR_CLASSES.ENGINE_UNAVAILABLE;
  return ERROR_CLASSES.HTTP;
}

function isExplainResponse(parsed) {
  return Boolean(
    parsed &&
      typeof parsed === "object" &&
      parsed.move &&
      typeof parsed.move === "object" &&
      typeof parsed.move.san === "string" &&
      typeof parsed.move.uci === "string" &&
      parsed.flags &&
      typeof parsed.flags === "object" &&
      parsed.maia &&
      typeof parsed.maia === "object" &&
      Array.isArray(parsed.maia.top) &&
      typeof parsed.classification === "string",
  );
}

/**
 * One /explain request (with the exactly-once network retry, like M4/M7).
 * Never throws for transport/server problems — everything becomes a result
 * object, so the panel and the tests handle one shape only.
 */
export async function explain({
  fen,
  moves = [],
  elo_self = 2400,
  elo_oppo = 2400,
  timeoutMs = EXPLAIN_DEFAULT_TIMEOUT_MS,
  fetchImpl = globalThis.fetch,
  url = EXPLAIN_URL,
  now = () => Date.now(),
} = {}) {
  const body = JSON.stringify({ fen, moves, elo_self, elo_oppo });
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
      attemptLog.push({
        attempt,
        outcome: response.ok ? "ok" : "http",
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
      if (isExplainResponse(parsed)) {
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
        message: "server answered 2xx but the body is not an /explain response",
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
 * semantics to the M4/M7 clients; a separate cache because the request/result
 * shape differs).
 *
 * The stale guard matters here too: the feed requests the article for ply N the
 * moment it appears; if ply N+1 arrives before the answer does, ply N's article
 * is *history* — but its position key is no longer current, so the result
 * resolves `stale: true` and the feed discards it silently (never an
 * out-of-order article). In a real game the request resolves in ~50 ms, long
 * before the next ply.
 */
export function createExplainClient({
  fetchImpl = globalThis.fetch,
  url = EXPLAIN_URL,
  timeoutMs = EXPLAIN_DEFAULT_TIMEOUT_MS,
  maxCacheEntries = EXPLAIN_DEFAULT_MAX_CACHE_ENTRIES,
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
    const promise = explain({ ...payload, timeoutMs, fetchImpl, url, now }).then((result) => ({
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

    /** @param {{fen, moves, elo_self, elo_oppo, key?}} payload */
    async load(payload, { force = false } = {}) {
      const key = payload.key ?? explainPositionKey(payload);
      currentKey = key; // the newest position always wins
      return request(key, payload, force);
    },

    /** Declare the position on the board without requesting an article. */
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

/* ------------------------------------------------------- the feed driver */

/**
 * The commentary feed driver (pure, unit-tested).
 *
 * Trigger rule (documented): an article is requested **iff** the adapter's
 * `movesUci` grew by **exactly one ply** since the last state the feed saw,
 * for BOTH colors, and only when the history is usable (`buildExplainRequest`
 * works — a mismatch is never guessed). Everything else is a no-op:
 *
 *   * the first state of a session **seeds the baseline** — a panel opened
 *     mid-game does not spam articles for plies it never witnessed; commentary
 *     starts with the next move;
 *   * a jump of more than one ply (page reload, bulk move-list repaint) is
 *     `skipped`, not replayed ply-by-ply;
 *   * a repeated state (re-emit) is a no-op; the dedupe set also refuses the
 *     same ply twice within a session;
 *   * a `sessionSeq` change (new game) clears the feed + the dedupe set and
 *     re-seeds.
 *
 * Entries are kept **newest first** and capped at `maxEntries` (default 50).
 * Each entry is whatever the caller stores; the panel uses
 * `{ply, key, san, by, chip, text, source, meta…}`.
 */
export function createCommentaryFeed({ maxEntries = COMMENTARY_MAX_ENTRIES } = {}) {
  const entries = [];
  const explainedPlies = new Set();
  const stats = {
    observed: 0,
    requested: 0,
    seeded: 0,
    reset: 0,
    skipped: 0, // jumps of more than one ply
    deduped: 0,
    suppressed: 0, // new ply arrived while the commentary toggle was off
    noHistory: 0,
    capEvictions: 0,
  };
  let sessionSeq = null;
  let lastPly = null;

  function clear() {
    const cleared = entries.length;
    entries.length = 0;
    explainedPlies.clear();
    lastPly = null;
    return cleared;
  }

  return {
    maxEntries,

    /**
     * Observe a GameState. Returns what the panel should do:
     *   {action: "none", reason}                      nothing new
     *   {action: "seeded", ply}                       baseline established
     *   {action: "reset", cleared, ply}               new game — clear the feed
     *   {action: "skipped", from, to}                 jump > 1 ply
     *   {action: "explain", ply, request, key}        request /explain for `request`
     *   {action: "suppressed", ply}                   new ply while the toggle was off
     *   {action: "deduped", ply}                      this ply was already explained
     *
     * `enabled: false` (the Commentary toggle off) consumes the ply but does not
     * mark it explained and does not request anything — "toggle off -> 0
     * requests"; re-enabling never re-explains moves from the past.
     */
    observe(state, { eloSelf = 2400, eloOppo = 2400, enabled = true } = {}) {
      stats.observed += 1;
      if (!state?.ok) return { action: "none", reason: "no-state" };

      const plyNow = Array.isArray(state.movesUci) ? state.movesUci.length : 0;
      const seq = state.sessionSeq ?? 0;
      const request = buildExplainRequest(state, { eloSelf, eloOppo });

      if (sessionSeq === null) {
        sessionSeq = seq;
        lastPly = plyNow;
        stats.seeded += 1;
        return { action: "seeded", ply: plyNow };
      }
      if (seq !== sessionSeq) {
        const cleared = clear();
        sessionSeq = seq;
        lastPly = plyNow;
        stats.reset += 1;
        return { action: "reset", cleared, ply: plyNow };
      }
      if (plyNow === lastPly) return { action: "none", reason: "unchanged" };

      const from = lastPly;
      lastPly = plyNow;

      if (plyNow !== from + 1) {
        stats.skipped += 1;
        return { action: "skipped", from, to: plyNow };
      }
      if (!enabled) {
        stats.suppressed += 1;
        return { action: "suppressed", ply: plyNow };
      }
      if (explainedPlies.has(plyNow)) {
        stats.deduped += 1;
        return { action: "deduped", ply: plyNow };
      }
      if (!request) {
        stats.noHistory += 1;
        return { action: "none", reason: "no-usable-history" };
      }
      explainedPlies.add(plyNow);
      stats.requested += 1;
      return { action: "explain", ply: plyNow, request, key: request.key };
    },

    /** Prepend an entry (newest first) and enforce the cap. Returns the list. */
    addEntry(entry) {
      entries.unshift(entry);
      while (entries.length > maxEntries) {
        entries.pop();
        stats.capEvictions += 1;
      }
      return entries;
    },

    /** Entries, newest first (live array — callers must not mutate it). */
    getEntries: () => entries,
    size: () => entries.length,
    hasPly: (ply) => explainedPlies.has(ply),
    explainedPlies: () => [...explainedPlies],
    getSessionSeq: () => sessionSeq,
    getLastPly: () => lastPly,
    getStats: () => ({ ...stats }),
    clear,
  };
}

/* ----------------------------------------------------------------- display */

/** Chip text for a classification (documented in docs/PROJECT.md). */
export function classificationChip(classification) {
  if (classification === "mainline") return "main line";
  if (classification === "common") return "common";
  if (classification === "uncommon") return "uncommon";
  if (classification === "rare") return "rare";
  return classification ?? "—";
}

/** "you" / "opponent" label for an article's mover (both colors are covered). */
export function moverLabel(by, userColor) {
  if (by !== "white" && by !== "black") return "?";
  if (userColor !== "white" && userColor !== "black") return by;
  return by === userColor ? "you" : "opponent";
}

/**
 * humanplay — optional free-API LLM phrasing (Milestone 8, deliverable 3)
 * ======================================================================
 *
 * The commentary **rephrasing** layer: it takes the exact facts JSON the
 * template sentence is built from and asks a free-tier provider to phrase it
 * conversationally. It can never add chess content: the system prompt forbids
 * analysis/tactics/engine claims, the output is sanitized and capped, and any
 * failure (no key, permission missing, HTTP error, timeout, empty/garbage body)
 * **falls back to the template text** with a meta note. With no key/network the
 * templates work exactly as before (the default engine is `templates`).
 *
 * Providers (fixed URLs; custom endpoints are out of scope — future work):
 *
 *   groq    https://api.groq.com/openai/v1/chat/completions      (OpenAI shape)
 *   gemini  https://generativelanguage.googleapis.com/v1beta/models/
 *           gemini-2.0-flash:generateContent                     (Gemini shape)
 *
 * Both origins are declared in `manifest.json` under `optional_host_permissions`
 * (never `<all_urls>`); the panel asks for the origin at enable-time with
 * `chrome.permissions.request` (a real user gesture is required by Chrome, so
 * that grant is a manual flow — the test proof drives the request path against
 * the fixture server, which is allowed by the *required* localhost permission).
 *
 * Key handling (privacy, documented):
 *   * stored in `chrome.storage.local` ONLY (`settings.llmApiKey`) — never
 *     `chrome.storage.sync`, never in a log line, never in an error message,
 *     never returned by this module (only `hasKey`);
 *   * masked in the UI (`<input type="password">`);
 *   * sent to the provider as the request's auth material only — Groq via the
 *     `Authorization` header, Gemini via the `x-goog-api-key` header (a header,
 *     not a query string, so the key cannot leak into provider access logs);
 *   * the request body contains ONLY the facts JSON.
 *
 * The `endpoint` parameter is the **test seam** (like `__humanplayTtsTest`): the
 * proof overrides it with `http://127.0.0.1:8765/llm/…`, which needs no extra
 * host permission. Production code paths never set it.
 */

import { commentaryFacts } from "./phrase.js";

export const LLM_ENGINES = Object.freeze(["templates", "groq", "gemini"]);
export const LLM_DEFAULT_ENGINE = "templates";
export const LLM_DEFAULT_TIMEOUT_MS = 2500;
export const LLM_MAX_CHARS = 220;

/** The mandated system prompt — rephrase, never analyse. */
export const LLM_SYSTEM_PROMPT =
  "Rephrase ONLY these facts into 1-2 short sentences, conversational tone. " +
  "Never add chess analysis, tactics, or claims not in the facts. " +
  "No engine evaluations. Plain text.";

/** Fixed provider metadata. `shape` selects request/response translation. */
export const LLM_PROVIDERS = Object.freeze({
  groq: Object.freeze({
    id: "groq",
    label: "Groq",
    origin: "https://api.groq.com/*",
    host: "api.groq.com",
    endpoint: "https://api.groq.com/openai/v1/chat/completions",
    model: "llama-3.1-8b-instant",
    shape: "openai",
  }),
  gemini: Object.freeze({
    id: "gemini",
    label: "Gemini",
    origin: "https://generativelanguage.googleapis.com/*",
    host: "generativelanguage.googleapis.com",
    endpoint:
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent",
    model: "gemini-2.0-flash",
    shape: "gemini",
  }),
});

/** Documented error classes of this module (not the Maia client classes). */
export const LLM_ERRORS = Object.freeze({
  NO_KEY: "no_key",
  NO_PROVIDER: "no_provider",
  TIMEOUT: "timeout",
  OFFLINE: "offline",
  HTTP: "http",
  PROVIDER_ERROR: "provider_error",
  BAD_RESPONSE: "bad_response",
  EMPTY: "empty",
});

export function normalizeLlmEngine(value, fallback = LLM_DEFAULT_ENGINE) {
  return LLM_ENGINES.includes(value) ? value : fallback;
}

/** The provider descriptor for a real engine, or null for templates/unknown. */
export function llmProvider(engine) {
  return LLM_PROVIDERS[normalizeLlmEngine(engine, null)] ?? null;
}

/** "positions are sent to api.groq.com" — the mandated privacy line input. */
export function providerPrivacyLine(engine) {
  const provider = llmProvider(engine);
  return provider ? `positions are sent to ${provider.host}` : null;
}

/**
 * The facts JSON handed to the provider (`commentaryFacts` from phrase.js) —
 * the exact same facts the template sentence uses, plus the template itself.
 */
export function buildLlmFacts(explain, templateText) {
  return commentaryFacts(explain, templateText);
}

/** `{system, user, facts}` — the user content is the facts JSON (pretty). */
export function buildLlmPrompt({ explain, template, facts = null } = {}) {
  const payload = facts ?? buildLlmFacts(explain, template);
  return {
    system: LLM_SYSTEM_PROMPT,
    user: JSON.stringify(payload, null, 2),
    facts: payload,
  };
}

/**
 * Strip what a chatty model adds around the sentence: code fences, backticks,
 * a leading "Sure!"/"Here is…" line, surrounding quotes, markdown emphasis.
 * Collapse all whitespace to single spaces, cap at `maxChars` on a word
 * boundary (with an ellipsis) and reject an empty result.
 */
export function sanitizeLlmText(raw, { maxChars = LLM_MAX_CHARS } = {}) {
  if (typeof raw !== "string") return null;
  let text = raw;

  // code fences: keep the content, drop the fences themselves
  text = text.replace(/```[a-zA-Z0-9]*\n?/g, " ").replace(/```/g, " ");
  text = text.replace(/`+/g, "");
  text = text.replace(/\*\*|__|\*|_/g, "");
  // a leading chatty line ("Sure! ...", "Here is the rephrased sentence:")
  text = text.replace(/^\s*sure\b[^.!?\n]{0,40}?[.!:]\s*/i, " ");
  text = text.replace(/^\s*of course\b[^.!?\n]{0,40}?[.!:]\s*/i, " ");
  text = text.replace(/^\s*here(?:'s| is)\b[^.!?\n]{0,80}?[.!:]\s*/i, " ");
  text = text.replace(/\s+/g, " ").trim();
  // surrounding quotes
  text = text.replace(/^["'“”„«»]+/, "").replace(/["'“”„«»]+$/, "").trim();
  if (!text) return null;

  if (text.length > maxChars) {
    let cut = text.slice(0, maxChars);
    const lastSpace = cut.lastIndexOf(" ");
    if (lastSpace > maxChars * 0.6) cut = cut.slice(0, lastSpace);
    text = `${cut.replace(/[,;:.\s]+$/, "")}…`;
  }
  return text || null;
}

/** Provider → request `{url, headers, body}` (the key is in a header only). */
export function buildLlmRequest(provider, prompt, apiKey, { endpoint = null } = {}) {
  const url = endpoint ?? provider.endpoint;
  if (provider.shape === "openai") {
    return {
      url,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: {
        model: provider.model,
        messages: [
          { role: "system", content: prompt.system },
          { role: "user", content: prompt.user },
        ],
        temperature: 0.2,
        max_tokens: 120,
      },
    };
  }
  // gemini
  return {
    url,
    headers: {
      "Content-Type": "application/json",
      "x-goog-api-key": apiKey,
    },
    body: {
      systemInstruction: { parts: [{ text: prompt.system }] },
      contents: [{ role: "user", parts: [{ text: prompt.user }] }],
      generationConfig: { temperature: 0.2, maxOutputTokens: 120 },
    },
  };
}

/** Provider response body -> the raw text (or null). */
export function parseLlmResponse(provider, parsed) {
  if (!parsed || typeof parsed !== "object") return null;
  if (provider.shape === "openai") {
    const content = parsed.choices?.[0]?.message?.content;
    return typeof content === "string" ? content : null;
  }
  const parts = parsed.candidates?.[0]?.content?.parts;
  if (!Array.isArray(parts)) return null;
  const text = parts.map((part) => (typeof part?.text === "string" ? part.text : "")).join("");
  return text || null;
}

function providerErrorDetail(parsed) {
  if (parsed && typeof parsed === "object" && parsed.error) {
    const error = parsed.error;
    if (typeof error === "string") return error;
    if (typeof error.message === "string") return error.message;
  }
  return null;
}

/**
 * ONE rephrasing call. Never throws; every failure is a result object and the
 * caller keeps the template text. `apiKey` and `headers` are never echoed.
 *
 * @returns {Promise<{ok, text, provider, model, latencyMs, errorClass, error, request, timeoutMs}>}
 */
export async function llmPhrase({
  engine,
  apiKey,
  explain = null,
  template = null,
  facts = null,
  fetchImpl = globalThis.fetch,
  timeoutMs = LLM_DEFAULT_TIMEOUT_MS,
  endpoint = null, // test seam only (see the header)
  now = () => Date.now(),
} = {}) {
  const provider = llmProvider(engine);
  const startedAt = now();
  const fail = (errorClass, error = null, request = null) => ({
    ok: false,
    text: null,
    provider: provider?.id ?? null,
    model: provider?.model ?? null,
    latencyMs: now() - startedAt,
    errorClass,
    error,
    request,
    timeoutMs,
  });

  if (!provider) return fail(LLM_ERRORS.NO_PROVIDER, "no real provider selected");
  if (!apiKey) return fail(LLM_ERRORS.NO_KEY, "no API key stored");

  const prompt = buildLlmPrompt({ explain, template, facts });
  const request = buildLlmRequest(provider, prompt, apiKey, { endpoint });
  const body = JSON.stringify(request.body);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response = null;
  let rawText = null;
  let parsed = null;
  try {
    response = await fetchImpl(request.url, {
      method: "POST",
      headers: request.headers,
      body,
      signal: controller.signal,
      cache: "no-store",
    });
    rawText = await response.text();
    try {
      parsed = rawText ? JSON.parse(rawText) : null;
    } catch {
      parsed = null;
    }
  } catch (error) {
    const aborted = error?.name === "AbortError";
    return fail(
      aborted ? LLM_ERRORS.TIMEOUT : LLM_ERRORS.OFFLINE,
      aborted ? `no answer within ${timeoutMs} ms` : (error?.message ?? String(error)),
    );
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    return fail(
      LLM_ERRORS.HTTP,
      `provider answered HTTP ${response.status}${providerErrorDetail(parsed) ? `: ${providerErrorDetail(parsed)}` : ""}`,
    );
  }
  if (providerErrorDetail(parsed) && !parseLlmResponse(provider, parsed)) {
    return fail(LLM_ERRORS.PROVIDER_ERROR, providerErrorDetail(parsed));
  }

  const text = sanitizeLlmText(parseLlmResponse(provider, parsed));
  if (!text) return fail(LLM_ERRORS.EMPTY, "the provider returned no usable text");

  return {
    ok: true,
    text,
    provider: provider.id,
    model: provider.model,
    latencyMs: now() - startedAt,
    errorClass: null,
    error: null,
    request: { url: request.url, model: provider.model },
    timeoutMs,
    raw: (rawText ?? "").slice(0, 2000),
  };
}

/**
 * "Test connection": one minimal call with the stored key (the same plumbing as
 * a real rephrase, including the timeout and sanitizer). Never returns the key.
 */
export async function testLlmConnection({
  engine,
  apiKey,
  fetchImpl = globalThis.fetch,
  timeoutMs = LLM_DEFAULT_TIMEOUT_MS,
  endpoint = null,
  now = () => Date.now(),
} = {}) {
  const provider = llmProvider(engine);
  if (!provider) {
    return { ok: false, provider: null, model: null, latencyMs: 0, errorClass: LLM_ERRORS.NO_PROVIDER, error: "no real provider selected", sample: null };
  }
  if (!apiKey) {
    return { ok: false, provider: provider.id, model: provider.model, latencyMs: 0, errorClass: LLM_ERRORS.NO_KEY, error: "no API key stored", sample: null };
  }
  const echo = {
    check: "connection test",
    instruction: "Reply with the single word OK.",
  };
  const result = await llmPhrase({
    engine,
    apiKey,
    facts: echo,
    fetchImpl,
    timeoutMs,
    endpoint,
    now,
  });
  return { ...result, sample: result.text };
}

/**
 * Ask for the provider's origin permission (called at enable-time from a user
 * gesture). Uses `chrome.permissions` when present; in plain Node the API is
 * unavailable and the result says so. Never throws.
 */
export async function requestLlmPermission(engine, { permissionsImpl = null } = {}) {
  const provider = llmProvider(engine);
  if (!provider) return { ok: true, status: "templates", provider: null, error: null };
  const permissions = permissionsImpl ?? globalThis.chrome?.permissions ?? null;
  if (!permissions?.request) {
    return { ok: false, status: "unavailable", provider: provider.id, error: "chrome.permissions is unavailable" };
  }
  try {
    const granted = await permissions.request({ origins: [provider.origin] });
    return {
      ok: Boolean(granted),
      status: granted ? "granted" : "declined",
      provider: provider.id,
      error: granted ? null : `the ${provider.label} host permission was not granted`,
    };
  } catch (error) {
    return { ok: false, status: "error", provider: provider.id, error: error?.message ?? String(error) };
  }
}

/** Never prompts: just asks whether the origin is already granted. */
export async function llmPermissionState(engine, { permissionsImpl = null } = {}) {
  const provider = llmProvider(engine);
  if (!provider) return "templates";
  const permissions = permissionsImpl ?? globalThis.chrome?.permissions ?? null;
  if (!permissions?.contains) return "unavailable";
  try {
    return (await permissions.contains({ origins: [provider.origin] })) ? "granted" : "missing";
  } catch {
    return "error";
  }
}

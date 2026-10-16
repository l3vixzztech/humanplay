/**
 * humanplay — the speaker seam (Milestone 6, deliverable 2)
 * =========================================================
 *
 * One small interface, several possible engines:
 *
 *     speaker.name                       "chrome.tts" | "unavailable" | "piper" | …
 *     await speaker.available()          {ok, engine, voices[], note}
 *     await speaker.speak(text, {rate})  {ok, engine, text, options, issuedAt, error?}
 *     await speaker.stop()               {ok, engine, stoppedAt, error?}
 *
 * `createSpeaker()` is the **only** construction point. Today it returns
 * `createChromeTtsSpeaker()` — a thin wrapper over `chrome.tts` — or an
 * "unavailable" speaker when `chrome.tts` is not exposed in the calling context;
 * a future Piper/cloud implementation is added here and callers (`src/tts/
 * tts-service.js`, the panel) do not change.
 *
 * Where it runs (empirically verified on Chrome for Testing 155.0.8059.84,
 * 2026-10-17 — see test/fixtures/captures/tts/tts-proof.json):
 *
 *   - `chrome.tts` **is exposed in an MV3 service worker** (`speak`, `stop`,
 *     `getVoices`, `isSpeaking`, `onEvent` all present; calls execute and fire
 *     `start`/`end`/`interrupted` events when Chrome has a speech backend).
 *     The speaker therefore lives in the **service worker**, which is why TTS
 *     keeps working when the side panel is closed — the panel only *asks* for
 *     speech (`humanplay:tts-speak`), it never owns the audio.
 *   - an **offscreen document does NOT get `chrome.tts`** (`typeof chrome.tts`
 *     === "undefined" there; only the Web Speech `speechSynthesis` global is
 *     available, which exposes no voices on this Linux box). The offscreen
 *     fallback sketched in the M6 plan is therefore both unnecessary (the SW
 *     path works) and worse, and it would additionally require the "offscreen"
 *     permission, which M6 forbids. Not shipped — recorded as evidence.
 *   - Linux audio detail: Chrome for Testing needs `--enable-speech-dispatcher`
 *     to actually synthesize. With the flag, `chrome.tts.getVoices()` is **0
 *     right after a cold start** and then enumerates the espeak-ng voices
 *     (14805 on this machine) once the backend loads — the panel retries once
 *     (see `VOICES_NOTE` / the panel's voices line). Without the flag it stays
 *     0 and every utterance fires `{type:"error", errorMessage:""}` — the speak
 *     path still executes and is recorded (evidence:
 *     test/fixtures/captures/tts/no-backend/).
 */

import { clampRate } from "./tts-policy.js";

export const CHROME_TTS_ENGINE = "chrome.tts";
export const UNAVAILABLE_ENGINE = "unavailable";

/** Shown by the panel when chrome.tts reports no voices. */
export const VOICES_NOTE =
  "chrome.tts reports no voices on this system. On Linux, Chrome speaks through " +
  "speech-dispatcher: install it (sudo apt install speech-dispatcher) and start " +
  "Chrome with --enable-speech-dispatcher. The speak path still executes — audio " +
  "needs a voice backend.";

function lastErrorText() {
  try {
    return globalThis.chrome?.runtime?.lastError?.message ?? null;
  } catch {
    return null;
  }
}

/** Normalize the `chrome.tts.Voice[]` shape to plain records for the hook/proof. */
export function normalizeVoices(voices) {
  if (!Array.isArray(voices)) return [];
  return voices.map((voice) => ({
    name: voice?.voiceName ?? voice?.name ?? "(unnamed)",
    lang: voice?.lang ?? voice?.language ?? null,
    remote: Boolean(voice?.remote),
    gender: voice?.gender ?? null,
    eventTypes: Array.isArray(voice?.eventTypes) ? voice.eventTypes : null,
  }));
}

function unavailableSpeaker({ engine = UNAVAILABLE_ENGINE, reason = "no speaker engine available" } = {}) {
  const now = () => Date.now();
  return {
    name: engine,
    available: async () => ({ ok: false, engine, voices: [], note: reason }),
    speak: async (text, { rate } = {}) => ({
      ok: false,
      engine,
      text: String(text ?? ""),
      options: { enqueue: false, rate: clampRate(rate) },
      issuedAt: now(),
      error: reason,
    }),
    stop: async () => ({ ok: false, engine, stoppedAt: now(), error: reason }),
  };
}

/**
 * `chrome.tts` speaker. Deliberately thin: interruption policy (stop() before
 * every new speak), recording and policy live one level up (`tts-service.js`) so
 * the seam stays engine-shaped.
 *
 * @param {object} [options]
 * @param {object|null} [options.tts] chrome.tts (injectable for tests)
 * @param {() => number} [options.now]
 */
export function createChromeTtsSpeaker({ tts = globalThis.chrome?.tts ?? null, now = () => Date.now() } = {}) {
  const usable = () => Boolean(tts) && typeof tts.speak === "function";

  return {
    name: CHROME_TTS_ENGINE,

    async available() {
      if (!usable()) {
        return { ok: false, engine: CHROME_TTS_ENGINE, voices: [], note: "chrome.tts is not available in this context" };
      }
      if (typeof tts.getVoices !== "function") {
        return { ok: true, engine: CHROME_TTS_ENGINE, voices: [], note: "chrome.tts has no getVoices in this browser" };
      }
      try {
        const { voices, lastError } = await new Promise((resolve) => {
          let settled = false;
          let timer = null;
          const done = (value) => {
            if (settled) return;
            settled = true;
            if (timer) clearTimeout(timer);
            resolve(value);
          };
          try {
            tts.getVoices((list) => done({ voices: list ?? [], lastError: lastErrorText() }));
          } catch (error) {
            done({ voices: [], lastError: String(error?.message ?? error) });
          }
          // getVoices is asynchronous and may never call back in a broken
          // browser build; a bounded wait keeps the panel's voices line honest.
          timer = setTimeout(() => done({ voices: [], lastError: "getVoices timed out" }), 2000);
        });
        const normalized = normalizeVoices(voices);
        return {
          ok: true,
          engine: CHROME_TTS_ENGINE,
          voices: normalized,
          lastError,
          note: normalized.length === 0 ? VOICES_NOTE : null,
        };
      } catch (error) {
        return { ok: false, engine: CHROME_TTS_ENGINE, voices: [], note: String(error?.message ?? error) };
      }
    },

    /**
     * Issue one utterance. `chrome.tts` plays through the browser process, so
     * this resolves as soon as the call is issued — the (possibly long) utterance
     * lifecycle is reported through `onEvent` (`start`/`end`/`error`/
     * `interrupted`) and does not block the caller (the MV3 worker may be
     * reclaimed between events; the record stays usable).
     */
    async speak(text, { rate = undefined, onEvent = null } = {}) {
      const cleanText = String(text ?? "").trim();
      const options = { enqueue: false, rate: clampRate(rate) };
      if (!cleanText) {
        return { ok: false, engine: CHROME_TTS_ENGINE, text: "", options, issuedAt: now(), error: "empty text" };
      }
      if (!usable()) {
        return { ok: false, engine: CHROME_TTS_ENGINE, text: cleanText, options, issuedAt: now(), error: "chrome.tts is not available in this context" };
      }
      try {
        tts.speak(
          cleanText,
          {
            ...options,
            onEvent(event) {
              try {
                onEvent?.(event);
              } catch {
                /* a listener must never break TTS */
              }
            },
          },
          () => {
            /* completion callback — events carry the lifecycle detail */
          },
        );
        return { ok: true, engine: CHROME_TTS_ENGINE, text: cleanText, options, issuedAt: now() };
      } catch (error) {
        return { ok: false, engine: CHROME_TTS_ENGINE, text: cleanText, options, issuedAt: now(), error: String(error?.message ?? error) };
      }
    },

    async stop() {
      if (!usable() || typeof tts.stop !== "function") {
        return { ok: false, engine: CHROME_TTS_ENGINE, stoppedAt: now(), error: "chrome.tts.stop is not available in this context" };
      }
      try {
        tts.stop();
        return { ok: true, engine: CHROME_TTS_ENGINE, stoppedAt: now() };
      } catch (error) {
        return { ok: false, engine: CHROME_TTS_ENGINE, stoppedAt: now(), error: String(error?.message ?? error) };
      }
    },
  };
}

/**
 * The single construction point (Piper/cloud speakers will be selected here).
 */
export function createSpeaker(options = {}) {
  const tts = options.tts ?? globalThis.chrome?.tts ?? null;
  if (tts && typeof tts.speak === "function") {
    return createChromeTtsSpeaker({ tts, now: options.now });
  }
  return unavailableSpeaker({
    reason: "chrome.tts is not available in this context (no offscreen fallback: it would need " +
      "the offscreen permission and offscreen documents do not expose chrome.tts)",
  });
}

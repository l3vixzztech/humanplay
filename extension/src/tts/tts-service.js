/**
 * humanplay — the service-worker TTS service (Milestone 6, deliverable 2+3)
 * ========================================================================
 *
 * Owns the speaker, the debug record and the toolbar badge. It runs in the MV3
 * **service worker**, not in the side panel, so speech does not depend on the
 * panel document existing:
 *
 *   panel (policy: when to speak, what to say — M6 spec)
 *     └─ chrome.runtime.sendMessage("humanplay:tts-speak" | ":tts-stop" | ":tts-voices")
 *          └─ service worker: stop-before-speak + speaker (chrome.tts) + the
 *             `__humanplayTts` debug hook (what would be spoken)
 *
 * Messages (all answered by the worker):
 *
 *   humanplay:tts-speak   {text, key?, san?, uci?, reason?, source?, options:{rate}}
 *       -> {ok, engine, text, issuedAt, stopBefore:{ok, stoppedAt}}
 *   humanplay:tts-stop    {reason?, source?} -> {ok, engine, stoppedAt}
 *   humanplay:tts-voices  {}                  -> {ok, engine, count, voices, note}
 *
 * Interruption policy: **every** speak stops the current utterance first
 * (`stop()` with reason "before-speak") and speaks with `enqueue:false`; the
 * panel additionally sends an explicit stop when TTS is switched off.
 *
 * Debug hook `globalThis.__humanplayTts` (read-only diagnostics, same style as
 * `__humanplayAnalysis`): settings, engine/voices, every speak/stop call with
 * text/options/engine/timestamp/reason/source/key, chrome.tts lifecycle events
 * (start/end/error/interrupted), counters, the last GameState the worker saw
 * (proof that the worker keeps tracking states with the panel closed) and the
 * badge state. The call log is mirrored into `chrome.storage.session`, so it
 * survives an MV3 worker restart and the CDP proof can still assert it.
 *
 * `globalThis.__humanplayTtsTest` is the explicit, documented test seam used by
 * test/tools/tts-proof.mjs: `invokeToggle()` (what chrome.commands.onCommand
 * calls — real key presses are manual-only), `speak("...")` and `stop()`.
 * Product code never reads it.
 */

import { createSpeaker } from "./speaker.js";
import { normalizeTtsSettings } from "./tts-policy.js";

export const MSG_TTS_SPEAK = "humanplay:tts-speak";
export const MSG_TTS_STOP = "humanplay:tts-stop";
export const MSG_TTS_VOICES = "humanplay:tts-voices";

/** chrome.commands name (manifest `commands.toggle-tts`). */
export const TTS_COMMAND_NAME = "toggle-tts";
/** Toolbar badge while TTS is on: 3 characters is the legible maximum. */
export const TTS_BADGE_TEXT = "TTS";
export const TTS_BADGE_BACKGROUND = "#2f6f4f"; // the panel accent green
export const TTS_BADGE_TEXT_COLOR = "#ffffff";

const SESSION_DEBUG_KEY = "humanplay.ttsDebug";
const MAX_CALLS = 60;
const MAX_EVENTS = 60;
const SETTINGS_KEY = "settings";

export function createTtsService({
  chromeApi = globalThis.chrome,
  speaker = null,
  now = () => Date.now(),
} = {}) {
  const api = chromeApi ?? null;
  const activeSpeaker = speaker ?? createSpeaker({ tts: api?.tts ?? null, now });

  const debug = {
    /** Where the speaker runs — the architecture answer this milestone proves. */
    scope: "service-worker",
    engine: activeSpeaker.name,
    available: activeSpeaker.name !== "unavailable",
    voices: { engine: activeSpeaker.name, count: null, voices: [], note: null, at: null, ok: null },
    settings: { enabled: false, rate: 1 },
    calls: [], // {kind: "speak"|"speak-failed"|"stop", at, atEpochMs, text, options, engine, reason, source, key, ok, error}
    events: [], // chrome.tts lifecycle events: {type, at, text}
    speakCount: 0,
    speakFailCount: 0,
    stopCount: 0,
    lastSpeak: null,
    lastStop: null,
    lastState: null,
    stateCount: 0,
    hotkey: { command: TTS_COMMAND_NAME, shortcut: null, invocations: 0, lastAt: null, lastValue: null },
    badge: { text: "", backgroundColor: null, textColor: null, updatedAt: null, error: null },
    restoredFromSession: false,
    restoredAt: null,
  };

  /* ------------------------------------------------------------ recording */

  function iso(at = now()) {
    return new Date(at).toISOString();
  }

  function recordCall(entry) {
    const record = { at: iso(entry.at), atEpochMs: entry.at ?? now(), ...entry };
    debug.calls.push(record);
    while (debug.calls.length > MAX_CALLS) debug.calls.shift();
    if (record.kind === "speak") {
      debug.speakCount += 1;
      debug.lastSpeak = record;
    } else if (record.kind === "speak-failed") {
      debug.speakFailCount += 1;
      debug.lastSpeak = record;
    } else if (record.kind === "stop") {
      debug.stopCount += 1;
      debug.lastStop = record;
    }
    persist();
    return record;
  }

  function recordEvent(event, text) {
    debug.events.push({ type: event?.type ?? "unknown", at: iso(), atEpochMs: now(), text: text ?? null, errorMessage: event?.errorMessage ?? null });
    while (debug.events.length > MAX_EVENTS) debug.events.shift();
    persist();
  }

  function persist() {
    if (!api?.storage?.session) return;
    try {
      Promise.resolve(
        api.storage.session.set({
          [SESSION_DEBUG_KEY]: {
            calls: debug.calls,
            events: debug.events,
            speakCount: debug.speakCount,
            speakFailCount: debug.speakFailCount,
            stopCount: debug.stopCount,
            lastState: debug.lastState,
            stateCount: debug.stateCount,
            hotkey: debug.hotkey,
            badge: debug.badge,
            settings: debug.settings,
            voices: debug.voices,
            engine: debug.engine,
          },
        }),
      ).catch(() => {});
    } catch {
      /* storage.session unavailable — the in-memory record still works */
    }
  }

  async function restoreFromSession() {
    if (!api?.storage?.session) return;
    try {
      const stored = await api.storage.session.get(SESSION_DEBUG_KEY);
      const saved = stored?.[SESSION_DEBUG_KEY];
      if (!saved) return;
      debug.calls = Array.isArray(saved.calls) ? saved.calls.slice(-MAX_CALLS) : [];
      debug.events = Array.isArray(saved.events) ? saved.events.slice(-MAX_EVENTS) : [];
      debug.speakCount = saved.speakCount ?? debug.calls.filter((c) => c.kind === "speak").length;
      debug.speakFailCount = saved.speakFailCount ?? 0;
      debug.stopCount = saved.stopCount ?? debug.calls.filter((c) => c.kind === "stop").length;
      debug.lastSpeak = [...debug.calls].reverse().find((c) => c.kind === "speak" || c.kind === "speak-failed") ?? null;
      debug.lastStop = [...debug.calls].reverse().find((c) => c.kind === "stop") ?? null;
      debug.lastState = saved.lastState ?? debug.lastState;
      debug.stateCount = saved.stateCount ?? 0;
      debug.hotkey = { ...debug.hotkey, ...(saved.hotkey ?? {}) };
      debug.badge = { ...debug.badge, ...(saved.badge ?? {}) };
      debug.voices = { ...debug.voices, ...(saved.voices ?? {}) };
      debug.restoredFromSession = true;
      debug.restoredAt = iso();
    } catch {
      /* ignore: a fresh record is fine */
    }
  }

  /* -------------------------------------------------------------- settings */

  async function readSettings() {
    if (!api?.storage?.local) return { enabled: false, rate: 1 };
    try {
      const stored = await api.storage.local.get(SETTINGS_KEY);
      return normalizeTtsSettings(stored?.[SETTINGS_KEY]);
    } catch {
      return { enabled: false, rate: 1 };
    }
  }

  async function refreshBadge(enabled) {
    const text = enabled ? TTS_BADGE_TEXT : "";
    const record = {
      text,
      backgroundColor: enabled ? TTS_BADGE_BACKGROUND : null,
      textColor: enabled ? TTS_BADGE_TEXT_COLOR : null,
      updatedAt: iso(),
      error: null,
    };
    try {
      if (api?.action?.setBadgeText) {
        await api.action.setBadgeText({ text });
        if (enabled) {
          await api.action.setBadgeBackgroundColor?.({ color: TTS_BADGE_BACKGROUND });
          await api.action.setBadgeTextColor?.({ color: TTS_BADGE_TEXT_COLOR });
        }
      } else {
        record.error = "chrome.action is not available in this context";
      }
    } catch (error) {
      record.error = String(error?.message ?? error);
    }
    debug.badge = record;
    persist();
    return record;
  }

  /** Called from `chrome.storage.onChanged` and from `init()`. */
  async function applySettings(settings) {
    debug.settings = normalizeTtsSettings(settings);
    return refreshBadge(debug.settings.enabled);
  }

  /* ----------------------------------------------------------------- calls */

  /**
   * Stop the current utterance (always) and speak `text` (enqueue:false).
   * The stop-before-speak pair is recorded in order, with timestamps.
   */
  async function speak({ text, key = null, san = null, uci = null, reason = "suggestion", source = "message", rate = undefined } = {}) {
    const rateValue = rate === undefined ? debug.settings.rate : rate;
    const stopBefore = await stop({ reason: "before-speak", source });
    const result = await activeSpeaker.speak(text, {
      rate: rateValue,
      onEvent: (event) => recordEvent(event, text),
    });
    const record = recordCall({
      kind: result.ok ? "speak" : "speak-failed",
      text: result.text ?? String(text ?? ""),
      san,
      uci,
      key,
      reason,
      source,
      engine: result.engine ?? activeSpeaker.name,
      options: result.options ?? { enqueue: false, rate: rateValue },
      ok: result.ok,
      error: result.error ?? null,
    });
    return {
      ok: result.ok,
      engine: record.engine,
      text: record.text,
      issuedAt: record.at,
      issuedAtEpochMs: record.atEpochMs,
      stopBefore: { ok: stopBefore.ok, stoppedAt: stopBefore.stoppedAt, reason: stopBefore.reason },
      error: record.error,
    };
  }

  async function stop({ reason = "manual", source = "message" } = {}) {
    const result = await activeSpeaker.stop();
    const record = recordCall({
      kind: "stop",
      reason,
      source,
      engine: result.engine ?? activeSpeaker.name,
      ok: result.ok,
      error: result.error ?? null,
      stoppedAt: result.stoppedAt ?? now(),
    });
    return { ok: record.ok, engine: record.engine, reason, stoppedAt: record.at, error: record.error };
  }

  async function voices() {
    const info = await activeSpeaker.available();
    const record = {
      engine: info.engine ?? activeSpeaker.name,
      count: Array.isArray(info.voices) ? info.voices.length : null,
      voices: Array.isArray(info.voices) ? info.voices.slice(0, 8) : [],
      note: info.note ?? null,
      ok: Boolean(info.ok),
      at: iso(),
      lastError: info.lastError ?? null,
    };
    debug.voices = record;
    persist();
    return record;
  }

  /** Snapshot of the GameState stream — proof the worker lives without the panel. */
  function noteState(state, tabId) {
    debug.stateCount += 1;
    debug.lastState = {
      fen: state?.fen ?? null,
      ok: Boolean(state?.ok),
      turn: state?.turn ?? null,
      moves: Array.isArray(state?.movesUci) ? state.movesUci.length : null,
      tabId: typeof tabId === "number" ? tabId : null,
      at: iso(),
      atEpochMs: now(),
    };
    persist();
  }

  /* --------------------------------------------------------- message + init */

  /** @returns {Promise<object|null>} null when the message is not ours. */
  async function handleMessage(message, sender) {
    switch (message?.type) {
      case MSG_TTS_SPEAK:
        return speak({
          text: message.text,
          key: message.key ?? null,
          san: message.san ?? null,
          uci: message.uci ?? null,
          reason: message.reason ?? "suggestion",
          source: message.source ?? (sender?.tab ? "content-script" : "extension-page"),
          rate: message.options?.rate,
        });
      case MSG_TTS_STOP:
        return stop({ reason: message.reason ?? "manual", source: message.source ?? "message" });
      case MSG_TTS_VOICES:
        return voices();
      default:
        return null;
    }
  }

  /** chrome.commands.onCommand("toggle-tts"): flip settings.ttsEnabled + badge. */
  async function toggleFromHotkey() {
    const current = await readSettings();
    const next = !current.enabled;
    try {
      const stored = await api.storage.local.get(SETTINGS_KEY);
      await api.storage.local.set({ [SETTINGS_KEY]: { ...(stored?.[SETTINGS_KEY] ?? {}), ttsEnabled: next } });
    } catch (error) {
      debug.hotkey.lastError = String(error?.message ?? error);
    }
    debug.hotkey.invocations += 1;
    debug.hotkey.lastAt = iso();
    debug.hotkey.lastValue = next;
    debug.settings = { ...debug.settings, enabled: next };
    await refreshBadge(next);
    persist();
    return { enabled: next, rate: current.rate };
  }

  /** Startup: restore the record, sync settings + badge, note voices. */
  async function init() {
    await restoreFromSession();
    await applySettings(await readSettings());
    try {
      await voices();
    } catch {
      /* availability is diagnostics only */
    }
    // Chrome enumerates speech voices asynchronously (the first getVoices() can
    // be empty); keep the recorded availability current so the panel's next
    // request sees the loaded voices.
    try {
      api?.tts?.onVoicesChanged?.addListener?.(() => {
        voices();
      });
    } catch {
      /* the event is optional */
    }
    return debug;
  }

  const testApi = {
    /** What chrome.commands.onCommand calls (real key presses are manual-only). */
    invokeToggle: () => toggleFromHotkey(),
    speak: (text, options = {}) =>
      speak({
        text,
        key: options.key ?? null,
        reason: options.reason ?? "test-hook",
        source: "test-hook",
        rate: options.rate,
      }),
    stop: (reason = "test-hook") => stop({ reason, source: "test-hook" }),
    reset: () => {
      debug.calls = [];
      debug.events = [];
      debug.speakCount = 0;
      debug.speakFailCount = 0;
      debug.stopCount = 0;
      debug.lastSpeak = null;
      debug.lastStop = null;
      persist();
      return true;
    },
  };

  return {
    debug,
    testApi,
    handleMessage,
    speak,
    stop,
    voices,
    noteState,
    applySettings,
    refreshBadge,
    toggleFromHotkey,
    init,
    speakerName: activeSpeaker.name,
  };
}

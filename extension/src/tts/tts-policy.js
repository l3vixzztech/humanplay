/**
 * humanplay — TTS policy (Milestone 6, deliverable 3, pure part)
 * ==============================================================
 *
 * The wording and the "should this position be spoken?" decision, with zero
 * dependencies — the same file runs in the side panel and in the zero-dep unit
 * tests (test/tools/tts-unit.mjs). The *execution* (chrome.tts, the debug
 * record) lives in the service worker (`src/tts/tts-service.js`); this module
 * only answers "speak this text / do not speak, because …".
 *
 * Speak iff, all of:
 *   1. TTS is enabled in settings (default OFF);
 *   2. the assistant is on;
 *   3. the adapter state is ok and the user's color is known;
 *   4. it is the user's turn (auto analysis is gated the same way);
 *   5. a suggestion with at least one move is ready;
 *   6. the suggestion's position key is the *current* key (the M4 stale guard —
 *      a stale suggestion is never spoken);
 *   7. that position key has not been spoken before (dedupe). Re-emitted states
 *      and repeated renders of the same position stay silent.
 *
 * "Never speak" cases are the complement: assistant off, opponent's turn,
 * game over (no moves), server offline / invalid input / any error (no
 * suggestion is ever rendered for those), stale results, duplicates.
 *
 * `ignoreDuplicate` is for explicit user intent only ("Speak suggestion" was
 * just switched on / the hotkey toggled TTS on): the *other* gates still apply,
 * so enabling TTS on the opponent's turn still says nothing.
 */

export const TTS_RATES = Object.freeze([0.8, 1, 1.2]);
export const DEFAULT_TTS_RATE = 1;
export const RATE_MIN = 0.5;
export const RATE_MAX = 2;
/** How many spoken position keys are remembered (bounded, insertion-ordered). */
export const DEFAULT_SPOKEN_KEY_LIMIT = 64;

/** Clamp a rate to [0.5, 2], 2 decimals; missing/garbage -> fallback. */
export function clampRate(value, fallback = DEFAULT_TTS_RATE) {
  if (value === null || value === undefined || value === "") return fallback;
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.round(Math.max(RATE_MIN, Math.min(RATE_MAX, number)) * 100) / 100;
}

/**
 * Bounded set of position keys that were already spoken. Insertion-ordered
 * (re-marking moves a key to the end) so the oldest key is evicted first.
 */
export function createSpokenKeyStore(maxEntries = DEFAULT_SPOKEN_KEY_LIMIT) {
  const keys = new Set();
  return {
    has: (key) => key != null && keys.has(key),
    /** @returns {boolean} true when the key was new. */
    mark(key) {
      if (key == null) return false;
      const existed = keys.delete(key);
      keys.add(key);
      while (keys.size > maxEntries) keys.delete(keys.values().next().value);
      return !existed;
    },
    forget(key) {
      return keys.delete(key);
    },
    size: () => keys.size,
    keys: () => [...keys],
    clear: () => {
      const cleared = keys.size;
      keys.clear();
      return cleared;
    },
  };
}

/**
 * The speak decision.
 *
 * @param {object} input
 * @param {boolean} input.ttsEnabled       settings.ttsEnabled (default OFF)
 * @param {boolean} [input.assistantEnabled]
 * @param {object|null} input.state        the GameState the suggestion belongs to
 * @param {{key?: string|null, moves?: Array}|null} input.suggestion
 * @param {string|null} [input.currentKey] the M4 client's current position key
 * @param {{has: (key: string) => boolean}|null} [input.spokenKeys]
 * @param {boolean} [input.ignoreDuplicate] explicit user intent (toggle on)
 * @returns {{speak: boolean, reason: string, key?: string|null}}
 */
export function speakDecision({
  ttsEnabled = false,
  assistantEnabled = true,
  state = null,
  suggestion = null,
  currentKey = null,
  spokenKeys = null,
  ignoreDuplicate = false,
} = {}) {
  const no = (reason) => ({ speak: false, reason, key: suggestion?.key ?? null });

  if (!ttsEnabled) return no("tts-off");
  if (!assistantEnabled) return no("assistant-off");
  if (!state?.ok) return no("no-state");
  if (state.userColor !== "white" && state.userColor !== "black") return no("no-color");
  const turnColor = state.turn === "b" || state.turn === "black" ? "black" : "white";
  if (turnColor !== state.userColor) return no("not-your-turn");
  if (!suggestion || !Array.isArray(suggestion.moves) || suggestion.moves.length === 0) return no("no-suggestion");
  if (!suggestion.key) return no("no-key");
  if (currentKey !== null && suggestion.key !== currentKey) return no("stale");
  if (!ignoreDuplicate && spokenKeys && spokenKeys.has(suggestion.key)) return no("duplicate");
  return { speak: true, reason: ignoreDuplicate ? "forced" : "speak", key: suggestion.key };
}

/**
 * Normalize the persisted TTS settings slice (used by the panel and the SW).
 */
export function normalizeTtsSettings(settings) {
  return {
    enabled: settings?.ttsEnabled === true, // default OFF
    rate: clampRate(settings?.ttsRate, DEFAULT_TTS_RATE),
  };
}

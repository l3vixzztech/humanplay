/**
 * humanplay side panel (M4 + M5 + M6 + M7 + M8): game state card + Maia
 * suggestion + Elo + board overlay controls + voice (TTS) + premove + commentary.
 *
 * What it does:
 * - listens for `humanplay:chesscom-state` messages broadcast by the content
 *   script (extension/src/content/chesscom-adapter.js) and renders the live
 *   state: board id, FEN, move count, side to move, user color, listening
 *   indicator, mismatch warning (M3 card, kept);
 * - **M4: the analysis loop.** When the assistant is on, the adapter state is
 *   ok, the user's color is known and it is the user's turn, the position is
 *   sent to the local Maia-3 server (`extension/src/analysis/analyze-client.js`)
 *   and the top-3 moves + Maia's human outcome prediction (WDL) are rendered.
 *   "Analyze now" always works when a state is known; the opponent's turn shows
 *   "their turn — waiting" (opponent prediction is M7);
 * - **M5: the board overlay.** The panel owns the overlay policy: whenever the
 *   suggestion card shows a *current* (non-stale) suggestion, the move is sent
 *   to the service worker (`humanplay:suggestion` {moves, topN, key} — forwarded
 *   to the tab that most recently reported a GameState) and rendered as arrows
 *   on the real board. Whenever the card clears (new position analyzing, their
 *   turn, assistant off, error, game over, stale result) the panel sends
 *   `humanplay:clear-suggestion`. "Show arrows on board" (default ON) and
 *   "Show alternatives" (default OFF) persist in settings and re-render/clear
 *   immediately. The panel also waits for the content script's acknowledgement
 *   only asynchronously — the UI never blocks on it;
 * - **M6: voice (TTS).** The panel decides *when* and *what* to say
 *   (`src/tts/move-speech.js`, `src/tts/tts-policy.js`) and the **service
 *   worker** performs it (`src/tts/tts-service.js`, `chrome.tts`) — the panel
 *   only sends `humanplay:tts-speak` / `:tts-stop` / `:tts-voices`, so speech
 *   does not depend on this document being open. Speak iff: TTS enabled +
 *   assistant on + it is your turn + a non-stale suggestion is ready for the
 *   *current* position key + that key was not spoken before (dedupe). Enabling
 *   TTS (checkbox or the Ctrl+Shift+Y hotkey, which arrives via
 *   `chrome.storage.onChanged`) speaks the current suggestion once; disabling
 *   sends an immediate stop. The "Speak test" button speaks "Knight to f3"
 *   regardless of the toggle (it tests the voice, not the policy);
 * - **M8: live commentary ("explain mode").** Every move that lands — yours
 *   and the opponent's — is explained by one factual sentence built from
 *   `POST /explain` (rules flags + Maia's own distribution, both from the local
 *   server; see `src/analysis/explain-client.js` and `src/commentary/phrase.js`).
 *   The **feed driver** requests an article exactly when the adapter's
 *   `movesUci` grew by one ply, dedupes by ply, keeps the last ~50 entries
 *   (newest first) and clears on a new game. The optional LLM layer
 *   (`src/commentary/llm.js`) only *rephrases* the same facts with a free
 *   provider (Groq/Gemini) — the template engine stays the default and works
 *   with no key and no network. No TTS for commentary (explicitly out of scope;
 *   future work). The commentary card has its own toggle; the assistant master
 *   switch does not gate it (commentary never suggests a move).
 * - keeps the M2 debug features: one-frame capture through the locked
 *   capture-source abstraction and PNG fixture recording (pixel recognition is
 *   parked — see docs/PROJECT.md).
 *
 * Analysis behaviour (contract in extension/src/analysis/analyze-client.js):
 * - request building: replayed history -> `startpos + full UCI history` (Maia's
 *   history planes see the real game); adapter `mismatch` -> board FEN WITHOUT
 *   moves + a warning in the card;
 * - identical position re-emits hit the client cache (dedupe): never a second
 *   HTTP request; a new game (`sessionSeq` change) clears the cache;
 * - stale guard: results whose position key is not current are discarded
 *   silently (a new position always wins over an older, slower response);
 * - WDL is from the side-to-move perspective of the analyzed position. Auto
 *   analysis runs on the user's turn, so it is labelled "(you)"; a manual
 *   analysis on the opponent's turn is labelled "opponent's perspective" with
 *   win<->loss flipped. The tooltip says it is Maia's human value head and NOT
 *   an engine evaluation;
 * - game over: the server answers `moves: []` + a rules-decided WDL -> the card
 *   shows the outcome instead of move rows.
 *
 * Test hook: `globalThis.__humanplayAnalysis` mirrors the analysis state
 * (gate/status/keys/counters/latency + `tts`, the M6 policy view) for
 * test/tools/analyze-proof.mjs and test/tools/tts-proof.mjs. It is read-only
 * diagnostics — nothing in the panel reads it back (the speak policy reads its
 * own state, not the hook).
 *
 * Persistence rules (docs/PROJECT.md):
 * - settings (assistant on/off, fallback user color, Elo pair) live in
 *   chrome.storage.local under "settings";
 * - screenshot data URLs and game snapshots are NEVER written to
 *   chrome.storage (they are large and may contain page content).
 */

import { getCaptureSource } from "../capture/capture-source.js";
import {
  DEFAULT_ELO,
  DEFAULT_TOP_K,
  analysisGate,
  buildAnalyzeRequest,
  clampElo,
  createAnalyzeClient,
} from "../analysis/analyze-client.js";
import {
  PREMOVE_DEFAULT_MIN_SAFETY,
  PREMOVE_DEFAULT_MODE,
  PREMOVE_DEFAULT_TOP_N,
  buildPremoveRequest,
  createPremoveClient,
  criterionLabel,
  premoveCaveat,
  premoveGate,
} from "../analysis/premove-client.js";
import {
  createCommentaryFeed,
  createExplainClient,
  moverLabel,
} from "../analysis/explain-client.js";
import { phraseCommentary } from "../commentary/phrase.js";
import {
  LLM_DEFAULT_ENGINE,
  llmPermissionState,
  llmPhrase,
  llmProvider,
  normalizeLlmEngine,
  providerPrivacyLine,
  requestLlmPermission,
  testLlmConnection,
} from "../commentary/llm.js";
import { moveToSpeech, premoveSpeech } from "../tts/move-speech.js";
import {
  DEFAULT_TTS_RATE,
  TTS_RATES,
  clampRate,
  createSpokenKeyStore,
  premoveSpeakDecision,
  premoveSpokenKey,
  speakDecision,
} from "../tts/tts-policy.js";

const HEALTH_URL = "http://127.0.0.1:8765/health";
const HEALTH_TIMEOUT_MS = 2500;
const SNAPSHOT_UPLOAD_URL = "http://127.0.0.1:8765/snapshot";
const SNAPSHOT_UPLOAD_TIMEOUT_MS = 1500;
const STORAGE_KEY = "settings";
const MSG_CHESSCOM_STATE = "humanplay:chesscom-state";
const MSG_GET_STATE = "humanplay:get-state";
const MSG_RECORD_SNAPSHOT = "humanplay:record-snapshot";
/** M5: routed to the content script through the service worker. */
const MSG_SUGGESTION = "humanplay:suggestion";
const MSG_CLEAR_SUGGESTION = "humanplay:clear-suggestion";
/** M6: voice — routed to the service worker, which owns chrome.tts. */
const MSG_TTS_SPEAK = "humanplay:tts-speak";
const MSG_TTS_STOP = "humanplay:tts-stop";
const MSG_TTS_VOICES = "humanplay:tts-voices";
/** M7: the premove arrow / speech — routed like the M5 suggestion. */
const MSG_PREMOVE = "humanplay:premove";
const MSG_CLEAR_PREMOVE = "humanplay:clear-premove";
/** The "Speak test" button text — the M6 canonical example phrasing. */
const TTS_TEST_TEXT = "Knight to f3";
const OVERLAY_ALTERNATIVES_MAX = 3;
/** M7 planning knobs the panel always sends (server clamps again). */
const PREMOVE_OPTS = Object.freeze({
  topN: PREMOVE_DEFAULT_TOP_N,
  minSafety: PREMOVE_DEFAULT_MIN_SAFETY,
  mode: PREMOVE_DEFAULT_MODE,
});
/** How many of their likely moves the premove card lists. */
const PREMOVE_OPPO_MAX = 3;
/** The "listening" chip drops back to idle after this long without a state. */
const LISTENING_STALE_MS = 6000;
/** M8: how many commentary entries the feed keeps (documented; newest first). */
const COMMENTARY_MAX_ENTRIES = 50;
const SERVER_START_COMMAND = "cd server && .venv/bin/python -m uvicorn app:app --host 127.0.0.1 --port 8765";

const els = {
  toggle: document.getElementById("assistant-toggle"),
  toggleState: document.getElementById("toggle-state"),
  capture: document.getElementById("capture-button"),
  record: document.getElementById("record-button"),
  frameMeta: document.getElementById("frame-meta"),
  previewWrap: document.getElementById("frame-preview-wrap"),
  preview: document.getElementById("frame-preview"),
  chip: document.getElementById("server-chip"),
  refresh: document.getElementById("refresh-health"),
  error: document.getElementById("error"),
  ccChip: document.getElementById("cc-chip"),
  ccBoard: document.getElementById("cc-board"),
  ccFen: document.getElementById("cc-fen"),
  ccMoves: document.getElementById("cc-moves"),
  ccTurn: document.getElementById("cc-turn"),
  ccColor: document.getElementById("cc-color"),
  ccMismatch: document.getElementById("cc-mismatch"),
  ccWarning: document.getElementById("cc-warning"),
  ccHint: document.getElementById("cc-hint"),
  ccSnapshotStatus: document.getElementById("cc-snapshot-status"),
  ccRefresh: document.getElementById("cc-refresh"),
  ccSnapshot: document.getElementById("cc-snapshot"),
  ccColorSetting: document.getElementById("cc-color-setting"),
  mxStatus: document.getElementById("mx-status"),
  mxMessage: document.getElementById("mx-message"),
  mxMoves: document.getElementById("mx-moves"),
  mxWdlBox: document.getElementById("mx-wdl-box"),
  mxWdlLabel: document.getElementById("mx-wdl-label"),
  mxWdlInfo: document.getElementById("mx-wdl-info"),
  mxWdlWin: document.getElementById("mx-wdl-win"),
  mxWdlDraw: document.getElementById("mx-wdl-draw"),
  mxWdlLoss: document.getElementById("mx-wdl-loss"),
  mxWarn: document.getElementById("mx-warn"),
  mxMeta: document.getElementById("mx-meta"),
  mxAnalyze: document.getElementById("mx-analyze"),
  eloSelf: document.getElementById("elo-self"),
  eloOppo: document.getElementById("elo-oppo"),
  eloReset: document.getElementById("elo-reset"),
  ovArrows: document.getElementById("ov-arrows"),
  ovAlternatives: document.getElementById("ov-alternatives"),
  ttsEnabled: document.getElementById("tts-enabled"),
  ttsRate: document.getElementById("tts-rate"),
  ttsTest: document.getElementById("tts-test"),
  ttsVoices: document.getElementById("tts-voices"),
  ttsNote: document.getElementById("tts-note"),
  ttsStatus: document.getElementById("tts-status"),
  pmStatus: document.getElementById("pm-status"),
  pmMessage: document.getElementById("pm-message"),
  pmRec: document.getElementById("pm-rec"),
  pmSan: document.getElementById("pm-san"),
  pmCriterion: document.getElementById("pm-criterion"),
  pmSafety: document.getElementById("pm-safety"),
  pmMinProb: document.getElementById("pm-minprob"),
  pmDetail: document.getElementById("pm-detail"),
  pmOppoBox: document.getElementById("pm-oppo-box"),
  pmOppoTitle: document.getElementById("pm-oppo-title"),
  pmOppo: document.getElementById("pm-oppo"),
  pmCaveat: document.getElementById("pm-caveat"),
  pmArrow: document.getElementById("pm-arrow"),
  pmSpeak: document.getElementById("pm-speak"),
  pmMeta: document.getElementById("pm-meta"),
  cmStatus: document.getElementById("cm-status"),
  cmEnabled: document.getElementById("cm-enabled"),
  cmMessage: document.getElementById("cm-message"),
  cmFeed: document.getElementById("cm-feed"),
  cmEngine: document.getElementById("cm-engine"),
  cmKey: document.getElementById("cm-key"),
  cmTest: document.getElementById("cm-test"),
  cmLlmStatus: document.getElementById("cm-llm-status"),
  cmPrivacy: document.getElementById("cm-privacy"),
  cmMeta: document.getElementById("cm-meta"),
  /** M9: the shared "copy start command" affordance (Server card). */
  copyStart: document.getElementById("copy-start-command"),
  serverCopied: document.getElementById("server-copied"),
};

/** Last frame, in memory only (never persisted — see header comment). */
let lastFrame = null;
/** Last chess.com state seen (for the panel's own reporting only). */
let lastChesscomState = null;
let lastChesscomAt = 0;
/** Elo pair, mirrored from settings (the analyze client takes it per request). */
let elo = { self: DEFAULT_ELO, oppo: DEFAULT_ELO };
/** Newest state the suggestion card was rendered for (UI bookkeeping). */
let analysisState = { stateReceivedAt: 0 };

/**
 * M5 overlay policy + bookkeeping. The panel is the only source of overlay
 * messages; `sentMode`/`sentKey`/`lastClearReason` keep them idempotent.
 */
const overlay = {
  showArrows: true,
  showAlternatives: false,
  sentMode: "idle", // "idle" | "suggestion" | "cleared"
  sentKey: null,
  lastClearReason: null,
  messageCount: 0,
  lastMessage: null,
  lastResponse: null,
  lastError: null,
};

/**
 * M6 voice (TTS) state. The panel owns *what* to say and *when*; the service
 * worker owns the actual chrome.tts call (see `src/tts/tts-service.js`).
 */
const tts = {
  enabled: false, // settings.ttsEnabled (default OFF)
  rate: DEFAULT_TTS_RATE,
  decision: null, // last speakDecision() outcome (why/why not)
  decisions: [], // bounded history of decisions (proof: "duplicate" etc. do not get lost)
  lastRequest: null, // last humanplay:tts-speak we sent
  lastStop: null, // last humanplay:tts-stop we sent
  voices: null, // last humanplay:tts-voices answer
  errors: 0,
  lastError: null,
};
const TTS_DECISION_HISTORY = 40;
/** Position keys already spoken — the dedupe (bounded, see tts-policy). */
const spokenKeys = createSpokenKeyStore();

/**
 * M9: consistent offline UX.
 *
 *  - `offlineCardMessage()` is the ONE wording every card uses when the local
 *    server is unreachable (the actionable command + where the copy button is);
 *  - the "Copy start command" button copies `SERVER_START_COMMAND`;
 *  - `recovery` auto-rechecks `/health` while any card is offline and re-runs
 *    the three policies for the position on the board as soon as it is back
 *    (failures are never cached, so real requests go out again).
 */
const clipboardState = { count: 0, last: null, command: SERVER_START_COMMAND };
const recovery = {
  active: false,
  attempts: 0,
  startedAt: null,
  lastReason: null,
  lastCheck: null,
  recoveredAt: null,
  timer: null,
};
const RECOVERY_INTERVAL_MS = 3000;
const RECOVERY_MAX_ATTEMPTS = 60; // bounded: ~3 minutes of polling per episode

/** M9: what the last full new-game reset cleared (proof + diagnostics). */
const gameReset = { lastSeq: null, count: 0, last: null };

/** Last /health outcome ("online"/"offline") for recovery + diagnostics. */
let healthState = { online: null, at: null, health: null, error: null };

/**
 * M7 premove state: settings, policy decisions, the last plan, and the overlay
 * bookkeeping for the dashed premove arrow (kept separate from the M5
 * suggestion so clearing one never clears the other).
 */
const premove = {
  showArrow: true, // settings.showPremoveArrow (effective only with showArrows)
  speak: true, // settings.speakPremoves (default ON; requires TTS on)
  gate: "idle",
  status: "idle",
  planCount: 0,
  planStaleDiscards: 0,
  lastPlan: null, // diagnostics for the proof (key/plan/status/timings)
  decision: null,
  decisions: [],
  lastRequest: null,
  lastStop: null,
  sentMode: "idle", // "idle" | "premove" | "cleared"
  sentKey: null,
  lastClearReason: null,
  messageCount: 0,
  lastMessage: null,
  lastResponse: null,
  lastError: null,
};

/**
 * M8 commentary state: the feed driver, the explain client, the settings and
 * the optional LLM rephrasing bookkeeping. `llmApiKey` lives here and in
 * `chrome.storage.local` only — never logged, never mirrored anywhere.
 */
const commentary = {
  enabled: true, // settings.commentaryEnabled (default ON)
  llmEngine: LLM_DEFAULT_ENGINE, // settings.llmEngine ("templates"|"groq"|"gemini")
  llmApiKey: "", // settings.llmApiKey — masked in the UI, never logged
  gate: "idle",
  status: "idle",
  lastObservation: null,
  lastResult: null,
  lastEntry: null,
  llmPermission: "unknown", // granted|missing|unavailable|templates|error|unknown
  llmStatus: null, // last "Test connection" outcome (never the key)
  llmCalls: [], // bounded history of llmPhrase outcomes (provider/meta only)
  staleDiscards: 0,
  errors: 0,
  lastError: null,
};
const COMMENTARY_LLM_HISTORY = 20;
const commentaryFeed = createCommentaryFeed({ maxEntries: COMMENTARY_MAX_ENTRIES });
const explainClient = createExplainClient();

/**
 * M8 test-only seam (documented like `__humanplayTtsTest`): the proof overrides
 * the provider endpoints with the fixture server's canned routes — no network,
 * no real key, and the shipped code path (llm.js) is still the one exercised.
 * Production code never calls `setLlmEndpoint`.
 */
const commentaryTest = {
  endpoints: {},
  setLlmEndpoint(engine, url) {
    commentaryTest.endpoints[engine] = url;
  },
  clearLlmEndpoints() {
    commentaryTest.endpoints = {};
  },
  requestPermission(engine) {
    return requestLlmPermission(engine);
  },
  permissionState(engine) {
    return llmPermissionState(engine);
  },
  feedStats() {
    return commentaryFeed.getStats();
  },
};

/**
 * Read-only diagnostics for test/tools/analyze-proof.mjs and
 * test/tools/tts-proof.mjs (see header). Never read back by the panel itself.
 */
const analysisDebug = {
  gate: "idle",
  status: "idle",
  currentKey: null,
  lastRenderKey: null,
  lastResult: null,
  requestCount: 0,
  renderCount: 0,
  staleDiscardCount: 0,
  lastStateToRenderMs: null,
  lastRoundTripMs: null,
  lastEngineMs: null,
  lastRenderAtEpochMs: null,
  lastError: null,
  client: null,
  /** M5: live view of the overlay policy/messages (read-only for the proof). */
  overlay,
  /** M6: live view of the TTS policy (read-only for the proof). */
  tts,
  /** M7: live view of the premove policy/plan (read-only for the proof). */
  premove,
  premoveClient: null,
  /** M8: live view of the commentary feed/policy (read-only for the proof). */
  commentary,
  commentaryFeed,
  commentaryTest,
  /** M9: the TTS dedupe store, the offline recovery, the clipboard button + resets. */
  spokenKeyStore: spokenKeys,
  recovery,
  clipboard: clipboardState,
  gameReset,
  getHealth: () => healthState,
};
globalThis.__humanplayAnalysis = analysisDebug;

const analyzeClient = createAnalyzeClient();
analysisDebug.client = analyzeClient;
const premoveClient = createPremoveClient();
analysisDebug.premoveClient = premoveClient;
analysisDebug.explainClient = explainClient;

init();

async function init() {
  els.toggle.addEventListener("change", onToggleChanged);
  els.capture.addEventListener("click", onCaptureClicked);
  els.record.addEventListener("click", onRecordClicked);
  els.refresh.addEventListener("click", refreshHealth);
  els.copyStart.addEventListener("click", onCopyStartCommand);
  els.preview.addEventListener("error", () => showError("preview image failed to render"));
  els.ccRefresh.addEventListener("click", () => refreshChesscomState({ announce: true }));
  els.ccSnapshot.addEventListener("click", onRecordSnapshot);
  els.ccColorSetting.addEventListener("change", onColorSettingChanged);
  els.mxAnalyze.addEventListener("click", onAnalyzeNowClicked);
  els.eloSelf.addEventListener("change", onEloChanged);
  els.eloOppo.addEventListener("change", onEloChanged);
  els.eloReset.addEventListener("click", onEloReset);
  els.ovArrows.addEventListener("change", onOverlaySettingChanged);
  els.ovAlternatives.addEventListener("change", onOverlaySettingChanged);
  els.pmArrow.addEventListener("change", onPremoveSettingChanged);
  els.pmSpeak.addEventListener("change", onPremoveSettingChanged);
  els.ttsEnabled.addEventListener("change", () => onTtsEnabledChanged({ source: "panel" }));
  els.ttsRate.addEventListener("change", onTtsRateChanged);
  els.ttsTest.addEventListener("click", onTtsTestClicked);
  els.cmEnabled.addEventListener("change", onCommentaryEnabledChanged);
  els.cmEngine.addEventListener("change", onLlmEngineChanged);
  els.cmKey.addEventListener("change", onLlmKeyChanged);
  els.cmTest.addEventListener("click", onLlmTestClicked);

  chrome.runtime.onMessage.addListener(onRuntimeMessage);
  // The Ctrl+Shift+Y hotkey is handled by the service worker; it flips
  // settings.ttsEnabled there, so the panel syncs through storage changes.
  chrome.storage.onChanged.addListener(onSettingsChanged);
  setInterval(renderChesscomChip, 2000);

  const settings = await loadSettings();
  els.toggle.checked = settings.assistantEnabled;
  renderToggle(settings.assistantEnabled);
  els.ccColorSetting.value = settings.userColor ?? "auto";
  elo = { self: settings.eloSelf, oppo: settings.eloOppo };
  els.eloSelf.value = String(elo.self);
  els.eloOppo.value = String(elo.oppo);
  overlay.showArrows = settings.showArrows;
  overlay.showAlternatives = settings.showAlternatives;
  els.ovArrows.checked = settings.showArrows;
  els.ovAlternatives.checked = settings.showAlternatives;
  tts.enabled = settings.ttsEnabled;
  tts.rate = TTS_RATES.includes(settings.ttsRate) ? settings.ttsRate : DEFAULT_TTS_RATE;
  els.ttsEnabled.checked = settings.ttsEnabled;
  els.ttsRate.value = String(tts.rate);
  renderTtsStatus();
  premove.showArrow = settings.showPremoveArrow;
  premove.speak = settings.speakPremoves;
  els.pmArrow.checked = settings.showPremoveArrow;
  els.pmSpeak.checked = settings.speakPremoves;
  renderPremoveIdle("open a chess.com game — the premove plan appears while the opponent thinks.", "no-state");

  commentary.enabled = settings.commentaryEnabled;
  commentary.llmEngine = settings.llmEngine;
  commentary.llmApiKey = settings.llmApiKey;
  els.cmEnabled.checked = settings.commentaryEnabled;
  els.cmEngine.value = settings.llmEngine;
  renderCommentaryIdle("open a chess.com game — every move that lands is explained here.");
  renderCommentaryLlmStatus();

  await refreshHealth();
  refreshTtsVoices(); // async, never blocks the panel
  // The content script emits on load; panel-initiated refresh covers the case
  // where the panel opened after the game page finished loading.
  await refreshChesscomState();
}

/* ---------------------------------------------------------------- settings */

async function loadSettings() {
  try {
    const stored = await chrome.storage.local.get(STORAGE_KEY);
    const settings = stored?.[STORAGE_KEY] ?? {};
    return {
      assistantEnabled: settings.assistantEnabled !== false,
      userColor: settings.userColor === "white" || settings.userColor === "black" ? settings.userColor : null,
      eloSelf: clampElo(settings.eloSelf, DEFAULT_ELO),
      eloOppo: clampElo(settings.eloOppo, DEFAULT_ELO),
      showArrows: settings.showArrows !== false, // default ON
      showAlternatives: settings.showAlternatives === true, // default OFF
      ttsEnabled: settings.ttsEnabled === true, // default OFF (M6)
      ttsRate: clampRate(settings.ttsRate, DEFAULT_TTS_RATE),
      showPremoveArrow: settings.showPremoveArrow !== false, // default ON (M7)
      speakPremoves: settings.speakPremoves !== false, // default ON (M7)
      commentaryEnabled: settings.commentaryEnabled !== false, // default ON (M8)
      llmEngine: normalizeLlmEngine(settings.llmEngine, LLM_DEFAULT_ENGINE), // default "templates"
      llmApiKey: typeof settings.llmApiKey === "string" ? settings.llmApiKey : "",
    };
  } catch {
    return {
      assistantEnabled: true,
      userColor: null,
      eloSelf: DEFAULT_ELO,
      eloOppo: DEFAULT_ELO,
      showArrows: true,
      showAlternatives: false,
      ttsEnabled: false,
      ttsRate: DEFAULT_TTS_RATE,
      showPremoveArrow: true,
      speakPremoves: true,
      commentaryEnabled: true,
      llmEngine: LLM_DEFAULT_ENGINE,
      llmApiKey: "",
    };
  }
}

async function onToggleChanged() {
  const enabled = els.toggle.checked;
  renderToggle(enabled);
  await saveSettings({ assistantEnabled: enabled });
  // Re-evaluate the policy for the position on the board: on -> analyze now,
  // off -> idle (the gate is recomputed in either direction).
  await onGameState(lastChesscomState);
}

async function onColorSettingChanged() {
  const value = els.ccColorSetting.value;
  await saveSettings({ userColor: value === "auto" ? null : value });
  // Re-ask the content script — the fallback only matters when detection failed.
  await refreshChesscomState();
}

async function onEloChanged() {
  clearError();
  elo = {
    self: clampElo(els.eloSelf.value, DEFAULT_ELO),
    oppo: clampElo(els.eloOppo.value, DEFAULT_ELO),
  };
  els.eloSelf.value = String(elo.self);
  els.eloOppo.value = String(elo.oppo);
  await saveSettings({ eloSelf: elo.self, eloOppo: elo.oppo });
  // The Elo pair is part of the position key: this re-analyzes the current
  // position (on the user's turn) with the new Elo conditioning.
  if (lastChesscomState?.ok) await onGameState(lastChesscomState);
}

async function onEloReset() {
  els.eloSelf.value = String(DEFAULT_ELO);
  els.eloOppo.value = String(DEFAULT_ELO);
  await onEloChanged();
}

async function saveSettings(patch) {
  try {
    const stored = await chrome.storage.local.get(STORAGE_KEY);
    await chrome.storage.local.set({ [STORAGE_KEY]: { ...stored?.[STORAGE_KEY], ...patch } });
  } catch (error) {
    showError(`could not persist settings: ${error?.message ?? error}`);
  }
}

function renderToggle(enabled) {
  els.toggleState.textContent = enabled ? "on" : "off";
}

/* ------------------------------------------------------- board overlay (M5) */

/**
 * The two overlay settings. Persisted in settings; toggling takes effect
 * immediately: arrows off -> clear; alternatives switched -> re-send the
 * currently displayed (still current) suggestion with the new move count.
 */
async function onOverlaySettingChanged() {
  clearError();
  overlay.showArrows = els.ovArrows.checked;
  overlay.showAlternatives = els.ovAlternatives.checked;
  await saveSettings({ showArrows: overlay.showArrows, showAlternatives: overlay.showAlternatives });

  if (!overlay.showArrows) {
    clearOverlay("arrows-off");
    clearPremoveOverlay("arrows-off");
    return;
  }
  // Show arrows again / change the alternatives flag for what is on the card —
  // only if that suggestion is still the current position (never stale).
  const last = analysisDebug.lastResult;
  if (last && Array.isArray(last.moves) && last.moves.length > 0 && analyzeClient.isCurrent(last.key)) {
    publishOverlaySuggestion({ key: last.key }, last.moves);
  }
  // Same for the premove: only a plan whose key is still current may be redrawn.
  const plan = premove.lastPlan;
  if (plan?.recommended && plan.key && premoveClient.isCurrent(plan.key)) {
    publishPremoveOverlay({ key: plan.key }, plan.recommended);
  }
}

/** M7: "Show premove arrow" / "Speak premoves" (persisted; immediate effect). */
async function onPremoveSettingChanged() {
  clearError();
  const arrowWas = premove.showArrow;
  const speakWas = premove.speak;
  premove.showArrow = els.pmArrow.checked;
  premove.speak = els.pmSpeak.checked;
  await saveSettings({ showPremoveArrow: premove.showArrow, speakPremoves: premove.speak });

  if (!premove.showArrow) {
    clearPremoveOverlay("premove-arrow-off");
  } else if (!arrowWas) {
    const plan = premove.lastPlan;
    if (overlay.showArrows && plan?.recommended && plan.key && premoveClient.isCurrent(plan.key)) {
      publishPremoveOverlay({ key: plan.key }, plan.recommended);
    }
  }
  if (premove.speak && !speakWas) {
    // Explicit user intent: speak the premove that is already on the card once.
    await speakCurrentPremove({ force: true, reason: "speak-premoves-on", source: "panel" });
  }
}

/** The moves actually drawn: top-1 always, alternatives when enabled. */
function overlayVisibleMoves(moves) {
  const list = Array.isArray(moves) ? moves.filter((move) => move?.uci) : [];
  if (!overlay.showAlternatives) return list.slice(0, 1);
  return list.slice(0, OVERLAY_ALTERNATIVES_MAX);
}

/**
 * Send the current suggestion to the overlay (via the service worker, which
 * forwards to the tab that most recently reported a GameState). Only ever
 * called for a result whose position key is current — the stale guard runs
 * before this in `runAnalysis`.
 */
function publishOverlaySuggestion(result, moves) {
  if (!overlay.showArrows) return;
  const visible = overlayVisibleMoves(moves);
  if (visible.length === 0) {
    clearOverlay("no-moves");
    return;
  }
  overlay.sentMode = "suggestion";
  overlay.sentKey = result.key ?? null;
  overlay.lastClearReason = null;
  overlaySend({
    type: MSG_SUGGESTION,
    moves: visible.map((move) => ({
      uci: move.uci,
      san: move.san ?? null,
      prob: Number.isFinite(move.prob) ? move.prob : null,
    })),
    topN: visible.length,
    key: result.key ?? null,
  });
}

/**
 * Clear the arrows. Called for every state where the card does not show a
 * current suggestion: a new position is analyzing, their turn, assistant off,
 * game over, any analysis error, a stale result arrived. Idempotent.
 */
function clearOverlay(reason) {
  const key = analysisDebug.currentKey ?? null;
  if (overlay.sentMode === "cleared" && overlay.lastClearReason === reason) return;
  overlay.sentMode = "cleared";
  overlay.sentKey = null;
  overlay.lastClearReason = reason;
  overlaySend({ type: MSG_CLEAR_SUGGESTION, reason, key });
}

function overlaySend(message) {
  overlay.messageCount += 1;
  overlay.lastMessage = { ...message, at: new Date().toISOString() };
  overlay.lastResponse = null;
  overlay.lastError = null;
  try {
    Promise.resolve(chrome.runtime.sendMessage(message)).then(
      (response) => {
        overlay.lastResponse = response ?? null;
      },
      (error) => {
        overlay.lastError = error?.message ?? String(error);
      },
    );
  } catch (error) {
    overlay.lastError = error?.message ?? String(error);
  }
}

/* -------------------------------------------------------------- voice (M6) */
function renderTtsStatus() {
  els.ttsStatus.textContent = tts.enabled ? "on" : "off";
  els.ttsStatus.className = `chip ${tts.enabled ? "chip-online" : "chip-idle"}`;
}

/** Keep the last N decisions (the proof asserts on history, not just the last). */
function recordTtsDecision(decision) {
  tts.decision = decision;
  tts.decisions.push(decision);
  while (tts.decisions.length > TTS_DECISION_HISTORY) tts.decisions.shift();
  return decision;
}

/**
 * `chrome.storage.onChanged`: the service worker's Ctrl+Shift+Y handler writes
 * settings.ttsEnabled; this keeps the checkbox + side effects in sync without
 * writing the setting back.
 */
function onSettingsChanged(changes, area) {
  if (area !== "local" || !changes.settings) return;
  const next = changes.settings.newValue ?? {};
  const enabled = next.ttsEnabled === true;
  if (enabled !== tts.enabled) {
    onTtsEnabledChanged({ source: "hotkey", persist: false }).catch((error) =>
      showError(`TTS toggle failed: ${error?.message ?? error}`),
    );
  }
  const rate = clampRate(next.ttsRate, DEFAULT_TTS_RATE);
  if (rate !== tts.rate) {
    tts.rate = rate;
    els.ttsRate.value = String(rate);
  }
  // M8: the commentary toggle / LLM engine may also change elsewhere (another
  // panel instance, a future options page) — sync without writing back.
  const commentaryEnabled = next.commentaryEnabled !== false;
  if (commentaryEnabled !== commentary.enabled) {
    commentary.enabled = commentaryEnabled;
    els.cmEnabled.checked = commentaryEnabled;
    renderCommentaryStatus();
  }
  const engine = normalizeLlmEngine(next.llmEngine, LLM_DEFAULT_ENGINE);
  if (engine !== commentary.llmEngine) {
    commentary.llmEngine = engine;
    els.cmEngine.value = engine;
    renderCommentaryLlmStatus();
  }
  if (typeof next.llmApiKey === "string" && next.llmApiKey !== commentary.llmApiKey) {
    commentary.llmApiKey = next.llmApiKey;
    renderCommentaryLlmStatus();
  }
}

async function onTtsEnabledChanged({ source = "panel", persist = true } = {}) {
  clearError();
  const enabled = persist ? els.ttsEnabled.checked : !tts.enabled;
  tts.enabled = enabled;
  els.ttsEnabled.checked = enabled;
  renderTtsStatus();
  if (persist) await saveSettings({ ttsEnabled: enabled });

  if (!enabled) {
    // Toggling TTS off stops mid-sentence, and nothing may be spoken until it
    // is switched on again.
    recordTtsDecision({ speak: false, reason: "tts-off", trigger: "toggle-off", source, force: false, key: null });
    await requestTtsStop("toggle-off", source);
    return;
  }
  // Toggling on speaks the suggestion that is already on the card (if it is
  // still the current position and it is your turn) — otherwise nothing is
  // spoken until the next suggestion arrives.
  await speakCurrentSuggestion({ force: true, reason: "toggle-on", source });
  // M7: on their turn the card may hold a premove instead — same explicit intent.
  await speakCurrentPremove({ force: true, reason: "toggle-on", source });
}

async function onTtsRateChanged() {
  clearError();
  tts.rate = clampRate(els.ttsRate.value, DEFAULT_TTS_RATE);
  els.ttsRate.value = String(tts.rate);
  await saveSettings({ ttsRate: tts.rate });
}

async function onTtsTestClicked() {
  clearError();
  // Tests the voice, not the policy: speaks regardless of the toggle state.
  await ttsSend({ type: MSG_TTS_SPEAK, text: TTS_TEST_TEXT, reason: "test", source: "panel-test", options: { rate: tts.rate } });
  refreshTtsVoices();
}

async function refreshTtsVoices({ retry = true } = {}) {
  try {
    const response = await chrome.runtime.sendMessage({ type: MSG_TTS_VOICES });
    tts.voices = response ?? null;
  } catch (error) {
    tts.voices = { ok: false, count: null, error: error?.message ?? String(error) };
  }
  renderTtsVoices();
  // Chrome enumerates the speech voices asynchronously: the very first
  // getVoices() after a cold start can be empty even though a backend exists
  // (observed on this machine: 0 -> 14805 espeak-ng voices). One delayed retry
  // avoids showing the "no voices" note spuriously.
  if (retry && tts.voices?.count === 0) {
    setTimeout(() => refreshTtsVoices({ retry: false }), 2000);
  }
}

function renderTtsVoices() {
  const info = tts.voices;
  if (!info) {
    els.ttsVoices.textContent = "voices: —";
    return;
  }
  const count = Number.isFinite(info.count) ? info.count : "?";
  els.ttsVoices.textContent = `voices: ${count} · ${info.engine ?? "?"}`;
  if (info.note) {
    els.ttsNote.hidden = false;
    els.ttsNote.textContent = info.note;
  } else {
    els.ttsNote.hidden = true;
    els.ttsNote.textContent = "";
  }
}

function requestTtsStop(reason, source) {
  return ttsSend({ type: MSG_TTS_STOP, reason, source });
}

/** One runtime message to the service worker + the panel-side record. */
async function ttsSend(message) {
  try {
    const response = await chrome.runtime.sendMessage(message);
    if (message.type === MSG_TTS_SPEAK) tts.lastRequest = { ...message, response: response ?? null, at: Date.now() };
    if (message.type === MSG_TTS_STOP) tts.lastStop = { ...message, response: response ?? null, at: Date.now() };
    if (message?.type === MSG_TTS_SPEAK && response?.ok === false) {
      tts.errors += 1;
      tts.lastError = response.error ?? "speak failed";
      showError(`TTS: ${tts.lastError}`);
    }
    return response;
  } catch (error) {
    tts.errors += 1;
    tts.lastError = error?.message ?? String(error);
    showError(`TTS request failed: ${tts.lastError}`);
    return null;
  }
}

/**
 * The single place that decides + sends a spoken suggestion. Called for every
 * non-stale suggestion render, and from the toggle-on paths with `force`
 * (explicit user intent: `force` bypasses only the dedupe — the other gates
 * still apply, so enabling TTS on the opponent's turn says nothing).
 */
async function speakSuggestion({ state, key, moves, force = false, trigger = "suggestion", source = "panel" }) {
  const decision = speakDecision({
    ttsEnabled: tts.enabled,
    assistantEnabled: els.toggle.checked,
    state,
    suggestion: { key, moves },
    currentKey: analyzeClient.getCurrentKey(),
    spokenKeys,
    ignoreDuplicate: force,
  });
  recordTtsDecision({
    ...decision,
    at: Date.now(),
    trigger,
    source,
    force: Boolean(force),
    key: key ?? null,
    move: moves?.[0]?.san ?? moves?.[0]?.uci ?? null,
    text: null,
  });
  if (!decision.speak) return { spoke: false, ...decision };

  const move = moves[0];
  const text = moveToSpeech(move); // SAN phrasing, UCI fallback ("move e2 to e4")
  if (!text) {
    recordTtsDecision({ ...tts.decision, speak: false, reason: "unparseable" });
    return { spoke: false, reason: "unparseable" };
  }
  spokenKeys.mark(key); // dedupe before the send: one attempt per position key
  recordTtsDecision({ ...tts.decision, text });
  await ttsSend({
    type: MSG_TTS_SPEAK,
    text,
    key,
    san: move?.san ?? null,
    uci: move?.uci ?? null,
    reason: trigger,
    source,
    options: { rate: tts.rate },
  });
  return { spoke: true, text, key, reason: decision.reason };
}

/** Speak whatever the card currently shows (only when it is still current). */
async function speakCurrentSuggestion({ force = false, reason = "manual", source = "panel" } = {}) {
  const last = analysisDebug.lastResult;
  if (!last || !last.key || !Array.isArray(last.moves) || last.moves.length === 0) {
    recordTtsDecision({ speak: false, reason: "no-suggestion", at: Date.now(), trigger: reason, source, force: Boolean(force), key: null });
    return { spoke: false, reason: "no-suggestion" };
  }
  if (!analyzeClient.isCurrent(last.key)) {
    recordTtsDecision({ speak: false, reason: "stale", at: Date.now(), trigger: reason, source, force: Boolean(force), key: last.key });
    return { spoke: false, reason: "stale" };
  }
  return speakSuggestion({ state: lastChesscomState, key: last.key, moves: last.moves, force, trigger: reason, source });
}

/* -------------------------------------------------------------- premove (M7) */

/**
 * The premove policy for one GameState, run next to the M4 analysis policy.
 * Trigger: after our move lands (the opponent's turn begins) — every state
 * render re-evaluates it, and the client's cache/dedupe/stale logic makes
 * repeated calls free. On our own turn the card says "waiting for your move".
 */
async function onPremovePolicy(state) {
  if (state?.ok) {
    // New game? Same rule as M4 (the reset itself happens in whichever policy
    // sees the new sessionSeq first — resetLayersForNewGame is idempotent).
    const seq = premoveClient.noteSessionSeq(state.sessionSeq ?? 0);
    if (seq.changed) {
      resetLayersForNewGame({
        seq: state.sessionSeq ?? 0,
        source: "premove",
        cleared: { premoveCache: seq.cleared },
      });
    }
  }

  const gate = premoveGate(state, { assistantEnabled: els.toggle.checked });
  premove.gate = gate.mode;

  if (!state?.ok) {
    renderPremoveIdle(
      state?.reason
        ? `no premove plan: ${state.reason}`
        : "open a chess.com game — the premove plan appears while the opponent thinks.",
      "no-state",
    );
    return;
  }

  const request = buildPremoveRequest(state, { eloSelf: elo.self, eloOppo: elo.oppo, ...PREMOVE_OPTS });
  // Declare the position even when we do not request a plan: an in-flight plan
  // for the previous position then resolves as stale (never rendered/spoken).
  premoveClient.expectKey(request.key);
  premove.currentKey = request.key;

  if (gate.mode === "off") {
    renderPremoveIdle("assistant off — premove planning is part of the assistant.", "assistant-off");
    return;
  }
  if (gate.mode === "no-color") {
    renderPremoveIdle("your color is unknown — set the fallback color in the game-state card.", "no-color");
    return;
  }
  if (gate.mode === "waiting") {
    renderPremoveWaiting();
    return;
  }
  await runPremove({ state, request });
}

async function runPremove({ state, request }) {
  const startedAt = performance.now();
  premove.planCount += 1;
  premove.status = "planning";
  setPmStatus("planning…", "chip-checking");
  els.pmMessage.hidden = false;
  els.pmMessage.className = "mx-message";
  els.pmMessage.textContent = `predicting their moves — ${describePremoveRequest(state, request)}…`;
  hidePremoveRecommendation();
  hidePremoveOpponent();
  hidePremoveCaveat();
  els.pmMeta.hidden = true;
  clearPremoveOverlay("planning"); // never keep the previous position's arrow

  const result = await premoveClient.plan(request, { force: false });
  premove.lastRoundTripMs = result.roundTripMs;

  if (result.stale) {
    // The position moved on while the planner was computing: discard silently —
    // no render, no speech. The overlay is NOT touched here: the newer
    // position's policy has already published its own arrow (or cleared it), and
    // a stale result must never overwrite that.
    premove.planStaleDiscards += 1;
    premove.lastStaleDiscard = { key: result.key, at: Date.now() };
    return;
  }
  if (!result.ok) {
    renderPremoveError(result);
    return;
  }
  renderPremovePlan(result, request, state, performance.now() - startedAt);
}

function describePremoveRequest(state, request) {
  if (request?.positionMode === "history") {
    return `${request.historyUsed} move${request.historyUsed === 1 ? "" : "s"} of history`;
  }
  return `board position${state?.mismatch ? " (no history: mismatch)" : ""}`;
}

function renderPremovePlan(result, request, state, latencyMs) {
  const data = result.data;
  const recommended = data.recommended ?? null;
  const opponent = Array.isArray(data.opponent) ? data.opponent : [];
  const excluded = Array.isArray(data.excluded) ? data.excluded : [];

  premove.lastPlan = {
    key: result.key,
    status: recommended ? "ready" : "no-safe-premove",
    mode: data.params?.mode ?? null,
    top_n: data.params?.top_n ?? null,
    min_safety: data.params?.min_safety ?? null,
    min_response_prob: data.params?.min_response_prob ?? null,
    side_to_move: data.side_to_move ?? null,
    opponent: opponent.map((move) => ({ uci: move.uci, san: move.san, prob: move.prob })),
    recommended: recommended
      ? {
          uci: recommended.uci,
          san: recommended.san,
          criterion: recommended.criterion,
          safety: recommended.safety,
          min_response_prob: recommended.min_response_prob,
          detail: recommended.detail,
        }
      : null,
    candidates: Array.isArray(data.candidates) ? data.candidates : [],
    excluded,
    reason: data.reason ?? null,
    model: data.model ?? null,
    engineMs: data.elapsed_ms ?? null,
    roundTripMs: result.roundTripMs,
    fromCache: Boolean(result.fromCache),
    renderMs: latencyMs,
    atEpochMs: Date.now(),
  };
  premove.status = premove.lastPlan.status;

  renderPremoveOpponent(opponent, excluded);
  renderPremoveCaveat(data.params?.mode, data.params?.top_n);

  if (recommended) {
    setPmStatus("premove ready", "chip-online");
    els.pmMessage.hidden = true;
    els.pmRec.hidden = false;
    els.pmSan.textContent = recommended.san ?? recommended.uci ?? "—";
    els.pmCriterion.textContent = criterionLabel(recommended) ?? "—";
    els.pmCriterion.title = recommended.detail ?? "";
    els.pmSafety.textContent = formatPercent(recommended.safety);
    els.pmMinProb.textContent = formatPercent(recommended.min_response_prob);
    els.pmDetail.textContent = recommended.detail ?? "";
    publishPremoveOverlay(result, recommended);
  } else {
    setPmStatus("no safe premove", "chip-idle");
    els.pmMessage.hidden = false;
    els.pmMessage.className = "mx-message is-warn";
    els.pmMessage.textContent = data.reason ?? "no safe premove — play manually.";
    hidePremoveRecommendation();
    clearPremoveOverlay("no-premove");
  }

  // M7 speech: "premove knight takes d5" — the M6 formatter + policy, the M7
  // dedupe key, the shared service-worker speaker. A null plan never speaks.
  speakPremove({
    state,
    key: result.key,
    recommended,
    trigger: "plan",
    source: "panel",
  }).catch((error) => showError(`TTS: ${error?.message ?? error}`));

  const parts = [
    `model ${data.model ?? "?"}`,
    `engine ${formatMs(data.elapsed_ms)} ms`,
    `round-trip ${formatMs(result.roundTripMs)} ms`,
    `${opponent.length - excluded.length} considered of ${opponent.length} likely ${opponent.length === 1 ? "reply" : "replies"}`,
    `ui ${formatMs(latencyMs)} ms`,
  ];
  if (excluded.length > 0) parts.push(`${excluded.length} terminal (excluded)`);
  if (result.fromCache) parts.push("cached");
  els.pmMeta.hidden = false;
  els.pmMeta.textContent = parts.join(" · ");
  els.pmMeta.title = `position key: ${result.key}`;
}

/** Their likely moves, top-3 with %, terminal ones marked (never counted safe). */
function renderPremoveOpponent(opponent, excluded) {
  if (opponent.length === 0) {
    hidePremoveOpponent();
    return;
  }
  const terminal = new Map(excluded.map((move) => [move.uci, move.reason]));
  els.pmOppo.innerHTML = "";
  opponent.slice(0, PREMOVE_OPPO_MAX).forEach((move) => {
    const percent = Number.isFinite(move.prob) ? move.prob * 100 : 0;
    const item = document.createElement("li");
    item.className = "pm-oppo-row";
    const reason = terminal.get(move.uci) ?? null;
    if (reason) item.classList.add("pm-oppo-terminal");
    item.dataset.uci = move.uci ?? "";
    item.dataset.san = move.san ?? "";
    item.dataset.prob = Number.isFinite(move.prob) ? String(move.prob) : "";
    item.dataset.terminal = reason ?? "";

    const san = document.createElement("span");
    san.className = "pm-oppo-san";
    san.textContent = move.san ?? move.uci ?? "?";

    const bar = document.createElement("span");
    bar.className = "pm-oppo-bar";
    const fill = document.createElement("span");
    fill.style.width = `${Math.max(0, Math.min(100, percent))}%`;
    bar.append(fill);

    const prob = document.createElement("span");
    prob.className = "pm-oppo-prob";
    prob.textContent = formatPercent(move.prob);

    const mark = document.createElement("span");
    mark.className = "pm-oppo-mark";
    mark.textContent = reason ? `(${reason} — excluded)` : "";

    item.append(san, bar, prob, mark);
    els.pmOppo.append(item);
  });
  els.pmOppoBox.hidden = false;
}

/** The honest caveat (mandated for mode "top", see docs/PROJECT.md). */
function renderPremoveCaveat(mode, topN) {
  els.pmCaveat.hidden = false;
  els.pmCaveat.textContent = premoveCaveat(mode ?? PREMOVE_OPTS.mode, topN ?? PREMOVE_OPTS.topN);
}

function renderPremoveWaiting() {
  setPmStatus("waiting", "chip-idle");
  els.pmMessage.hidden = false;
  els.pmMessage.className = "mx-message";
  els.pmMessage.textContent = "waiting for your move — the premove plan appears while they think.";
  hidePremoveRecommendation();
  hidePremoveOpponent();
  hidePremoveCaveat();
  els.pmMeta.hidden = true;
  clearPremoveOverlay("your-turn");
}

function renderPremoveIdle(message, clearReason = "idle") {
  setPmStatus("idle", "chip-idle");
  els.pmMessage.hidden = false;
  els.pmMessage.className = "mx-message";
  els.pmMessage.textContent = message;
  hidePremoveRecommendation();
  hidePremoveOpponent();
  hidePremoveCaveat();
  els.pmMeta.hidden = true;
  premove.status = clearReason;
  clearPremoveOverlay(clearReason);
}

function renderPremoveError(result) {
  const error = result.error ?? {};
  const attempts = result.attempts > 1 ? ` (retried once, ${result.attempts} attempts)` : "";
  setPmStatus(
    result.errorClass === "offline" ? "server offline" : result.errorClass === "timeout" ? "timeout" : "error",
    "chip-offline",
  );
  els.pmMessage.hidden = false;
  els.pmMessage.className = "mx-message is-error";
  els.pmMessage.textContent =
    result.errorClass === "offline"
      ? offlineCardMessage("premove planning", premoveClient.url, attempts)
      : result.errorClass === "invalid_input"
        ? `invalid input (HTTP ${result.status}): ${error.detail ?? "the server rejected this position"}${attempts}`
        : `premove planning failed: ${error.message ?? result.errorClass}${error.detail ? ` — ${error.detail}` : ""}${attempts}`;
  premove.status = `error:${result.errorClass}`;
  premove.lastPlan = null;
  hidePremoveRecommendation();
  hidePremoveOpponent();
  hidePremoveCaveat();
  els.pmMeta.hidden = true;
  clearPremoveOverlay(`error:${result.errorClass}`);
  if (result.errorClass === "offline") scheduleServerRecovery("premove");
}

function hidePremoveRecommendation() {
  els.pmRec.hidden = true;
  els.pmSan.textContent = "—";
  els.pmCriterion.textContent = "—";
  els.pmSafety.textContent = "—";
  els.pmMinProb.textContent = "—";
  els.pmDetail.textContent = "";
}

function hidePremoveOpponent() {
  els.pmOppoBox.hidden = true;
  els.pmOppo.innerHTML = "";
}

function hidePremoveCaveat() {
  els.pmCaveat.hidden = true;
  els.pmCaveat.textContent = "";
}

function setPmStatus(text, className) {
  els.pmStatus.textContent = text;
  els.pmStatus.className = `chip ${className}`;
}

/* ---------------------------------------- premove overlay + speech plumbing */

function publishPremoveOverlay(result, recommended) {
  // The M7 setting is only effective while the M5 master switch is on.
  if (!overlay.showArrows || !premove.showArrow) {
    clearPremoveOverlay("premove-arrow-off");
    return;
  }
  if (!recommended?.uci) {
    clearPremoveOverlay("no-premove");
    return;
  }
  premove.sentMode = "premove";
  premove.sentKey = result.key ?? null;
  premove.lastClearReason = null;
  premoveOverlaySend({
    type: MSG_PREMOVE,
    move: { uci: recommended.uci, san: recommended.san ?? null },
    key: result.key ?? null,
  });
}

function clearPremoveOverlay(reason) {
  const key = premoveClient.getCurrentKey();
  if (premove.sentMode === "cleared" && premove.lastClearReason === reason) return;
  premove.sentMode = "cleared";
  premove.sentKey = null;
  premove.lastClearReason = reason;
  premoveOverlaySend({ type: MSG_CLEAR_PREMOVE, reason, key });
}

function premoveOverlaySend(message) {
  premove.messageCount += 1;
  premove.lastMessage = { ...message, at: new Date().toISOString() };
  premove.lastResponse = null;
  premove.lastError = null;
  try {
    Promise.resolve(chrome.runtime.sendMessage(message)).then(
      (response) => {
        premove.lastResponse = response ?? null;
      },
      (error) => {
        premove.lastError = error?.message ?? String(error);
      },
    );
  } catch (error) {
    premove.lastError = error?.message ?? String(error);
  }
}

function recordPremoveDecision(decision) {
  premove.decision = decision;
  premove.decisions.push(decision);
  while (premove.decisions.length > TTS_DECISION_HISTORY) premove.decisions.shift();
  return decision;
}

/**
 * The single place that decides + sends a spoken premove. Same shape as the M6
 * `speakSuggestion`; the decision comes from `premoveSpeakDecision` (TTS on +
 * "Speak premoves" on + assistant on + THEIR turn + non-stale plan + dedupe).
 */
async function speakPremove({ state, key, recommended, force = false, trigger = "plan", source = "panel" }) {
  const decision = premoveSpeakDecision({
    ttsEnabled: tts.enabled,
    speakPremoves: premove.speak,
    assistantEnabled: els.toggle.checked,
    state,
    plan: { key, recommended },
    currentKey: premoveClient.getCurrentKey(),
    spokenKeys,
    ignoreDuplicate: force,
  });
  recordPremoveDecision({
    ...decision,
    at: Date.now(),
    trigger,
    source,
    force: Boolean(force),
    key: key ?? null,
    move: recommended?.san ?? recommended?.uci ?? null,
    text: null,
  });
  if (!decision.speak) return { spoke: false, ...decision };

  const text = premoveSpeech(recommended); // "premove knight takes d5"
  if (!text) {
    recordPremoveDecision({ ...premove.decision, speak: false, reason: "unparseable" });
    return { spoke: false, reason: "unparseable" };
  }
  spokenKeys.mark(decision.spokenKey ?? premoveSpokenKey(key, recommended?.uci));
  recordPremoveDecision({ ...premove.decision, text });
  await ttsSend({
    type: MSG_TTS_SPEAK,
    text,
    key,
    san: recommended?.san ?? null,
    uci: recommended?.uci ?? null,
    reason: "premove",
    source,
    options: { rate: tts.rate },
  });
  return { spoke: true, text, key, reason: decision.reason };
}

/** Speak the premove the card currently shows (only when it is still current). */
async function speakCurrentPremove({ force = false, reason = "manual", source = "panel" } = {}) {
  const plan = premove.lastPlan;
  if (!plan?.key || !plan.recommended) {
    recordPremoveDecision({ speak: false, reason: "no-premove", at: Date.now(), trigger: reason, source, force: Boolean(force), key: plan?.key ?? null });
    return { spoke: false, reason: "no-premove" };
  }
  if (!premoveClient.isCurrent(plan.key)) {
    recordPremoveDecision({ speak: false, reason: "stale", at: Date.now(), trigger: reason, source, force: Boolean(force), key: plan.key });
    return { spoke: false, reason: "stale" };
  }
  return speakPremove({ state: lastChesscomState, key: plan.key, recommended: plan.recommended, force, trigger: reason, source });
}

/* ----------------------------------------------------------- commentary (M8) */

/**
 * The M8 policy for one GameState: the feed driver observes EVERY state (both
 * colors) and the panel requests `/explain` for a ply the moment it appears.
 *
 *  - trigger: `movesUci` grew by exactly one ply (the driver's rule) and the
 *    history is usable — never on a jump, never on a re-emit, never on a
 *    mismatch (a guessed article is worse than none);
 *  - the entry is added the moment the server answers (templates, no waiting on
 *    the network for the LLM layer); an optional provider rephrasing replaces
 *    the text in place, and any provider failure keeps the template text;
 *  - stale guard: an article whose key is no longer current is discarded
 *    silently (the synthetic `inactive:` key invalidates anything in flight
 *    when the observed position cannot be explained);
 *  - a new game (`sessionSeq` change) clears the feed + the explain cache.
 */
async function onCommentary(state) {
  if (state?.ok) {
    const seq = explainClient.noteSessionSeq(state.sessionSeq ?? 0);
    if (seq.changed) {
      resetLayersForNewGame({
        seq: state.sessionSeq ?? 0,
        source: "commentary",
        cleared: { explainCache: seq.cleared },
      });
    }
  }
  const observation = commentaryFeed.observe(state, {
    eloSelf: elo.self,
    eloOppo: elo.oppo,
    enabled: commentary.enabled,
  });
  commentary.lastObservation = observation;

  if (!state?.ok) {
    commentary.gate = "no-state";
    renderCommentaryIdle(state?.reason ? `no commentary: ${state.reason}` : "open a chess.com game — every move that lands is explained here.");
    return;
  }
  commentary.gate = commentary.enabled ? "active" : "off";

  if (observation.action === "reset") {
    renderCommentaryIdle(`new game — commentary feed cleared (${observation.cleared} entries)`);
    return;
  }
  if (observation.action !== "explain") {
    // Anything in flight for an older position must never land on the feed.
    if (observation.ply !== undefined) {
      explainClient.expectKey(`inactive:${state.sessionSeq ?? 0}:${observation.ply}`);
    }
    if (observation.action === "suppressed") {
      renderCommentaryIdle("commentary off — moves are not explained.");
    } else {
      renderCommentaryIdle(null);
    }
    return;
  }

  await runCommentary({ state, observation });
}

async function runCommentary({ state, observation }) {
  commentary.status = "explaining";
  setCmStatus("explaining…", "chip-checking");
  setCommentaryMessage(
    `explaining ply ${observation.ply} — requesting /explain for the last move…`,
  );

  const result = await explainClient.load(observation.request);
  commentary.lastResult = result;

  if (result.stale) {
    // The position moved on while the article was in flight: discard silently
    // (never an out-of-order feed entry).
    commentary.staleDiscards += 1;
    return;
  }
  if (!result.ok) {
    renderCommentaryError(result);
    return;
  }

  const phrased = phraseCommentary(result.data);
  const entry = {
    key: result.key,
    ply: observation.ply,
    moveNumber: phrased.moveNumber,
    san: phrased.san,
    uci: phrased.uci,
    by: phrased.by,
    playerLabel: moverLabel(phrased.by, state.userColor),
    chip: phrased.chip,
    classification: phrased.classification,
    opening: phrased.opening,
    text: phrased.text, // the template sentence — the base the LLM rephrases
    template: phrased.text,
    source: "template",
    llm: null,
    engineMs: result.data.elapsed_ms ?? null,
    roundTripMs: result.roundTripMs,
    fromCache: Boolean(result.fromCache),
    atEpochMs: Date.now(),
    /** Read-only diagnostics for the proof (the raw /explain body). */
    data: result.data,
  };
  commentaryFeed.addEntry(entry);
  commentary.lastEntry = entry;
  commentary.status = "ready";
  renderCommentaryFeed();
  renderCommentaryIdle(null);

  // Optional LLM rephrasing: never blocks the feed; on failure the template
  // text stays and the entry meta notes the fallback.
  const provider = llmProvider(commentary.llmEngine);
  if (provider && commentary.llmApiKey) {
    runCommentaryLlm({ entry, explain: result.data, template: phrased.text }).catch((error) =>
      showError(`commentary LLM: ${error?.message ?? error}`),
    );
  }
}

/** One provider call for one entry; the text is replaced in place on success. */
async function runCommentaryLlm({ entry, explain, template }) {
  const engine = commentary.llmEngine;
  const result = await llmPhrase({
    engine,
    apiKey: commentary.llmApiKey,
    explain,
    template,
    endpoint: commentaryTest.endpoints[engine] ?? null, // null in production
  });
  recordCommentaryLlmCall({
    engine,
    provider: result.provider,
    model: result.model,
    ok: result.ok,
    errorClass: result.errorClass,
    latencyMs: result.latencyMs,
    text: result.ok ? result.text : null,
  });
  // The feed may have been cleared (new game) while the provider was thinking.
  if (!commentaryFeed.getEntries().includes(entry)) return;
  if (result.ok) {
    entry.text = result.text;
    entry.source = engine;
    entry.llm = {
      ok: true,
      provider: result.provider,
      model: result.model,
      latencyMs: result.latencyMs,
    };
  } else {
    // Fallback: the template text stays; the meta notes why.
    entry.llm = {
      ok: false,
      provider: result.provider,
      model: result.model,
      errorClass: result.errorClass,
      error: result.error ?? null,
      latencyMs: result.latencyMs,
    };
  }
  renderCommentaryFeed();
  renderCommentaryMeta();
}

/** Bounded history of provider outcomes (provider/meta only — never the key). */
function recordCommentaryLlmCall(call) {
  commentary.llmCalls.push({ ...call, at: Date.now() });
  while (commentary.llmCalls.length > COMMENTARY_LLM_HISTORY) commentary.llmCalls.shift();
}

/* ----------------------------------------------- commentary UI + settings */

function setCmStatus(text, className) {
  els.cmStatus.textContent = text;
  els.cmStatus.className = `chip ${className}`;
}

function setCommentaryMessage(text, className = "mx-message") {
  els.cmMessage.hidden = !text;
  els.cmMessage.className = className;
  els.cmMessage.textContent = text ?? "";
}

/**
 * One place that paints the card: status chip, message, feed (newest first) and
 * the meta line. `message` overrides the default message for this render.
 */
function renderCommentaryIdle(message = null) {
  if (!commentary.enabled) {
    setCmStatus("off", "chip-idle");
    setCommentaryMessage(message ?? "commentary off — moves are not explained.");
  } else if (commentary.gate === "active") {
    setCmStatus("listening", "chip-online");
    setCommentaryMessage(
      message ?? (commentaryFeed.size() > 0 ? null : "waiting for the next move…"),
    );
  } else {
    setCmStatus("idle", "chip-idle");
    setCommentaryMessage(
      message ?? "open a chess.com game — every move that lands is explained here.",
    );
  }
  renderCommentaryFeed();
  renderCommentaryMeta();
}

function renderCommentaryFeed() {
  const entries = commentaryFeed.getEntries();
  if (entries.length === 0) {
    els.cmFeed.hidden = true;
    els.cmFeed.innerHTML = "";
    return;
  }
  els.cmFeed.hidden = false;
  els.cmFeed.innerHTML = "";
  entries.forEach((entry, index) => {
    const item = document.createElement("li");
    item.className = index === 0 ? "cm-entry cm-newest" : "cm-entry";
    item.dataset.ply = entry.ply != null ? String(entry.ply) : "";
    item.dataset.by = entry.by ?? "";
    item.dataset.san = entry.san ?? "";
    item.dataset.classification = entry.classification ?? "";
    item.dataset.source = entry.source ?? "template";
    item.dataset.key = entry.key ?? "";

    const head = document.createElement("div");
    head.className = "row cm-entry-head";
    const san = document.createElement("span");
    san.className = "cm-san";
    san.textContent = entry.san ?? "?";
    const by = document.createElement("span");
    by.className = "cm-by";
    by.textContent = entry.playerLabel ?? entry.by ?? "";
    const chip = document.createElement("span");
    chip.className = "cm-chip";
    chip.textContent = entry.chip ?? "—";
    chip.title = `classification: ${entry.classification ?? "?"} (probability band, not a judgement)`;
    head.append(san, by, chip);

    const text = document.createElement("p");
    text.className = "cm-text";
    text.textContent = entry.text ?? "";

    const meta = document.createElement("p");
    meta.className = "cm-entry-meta";
    const metaParts = [
      entry.source === "template" ? "engine template" : `${entry.source} rephrasing`,
    ];
    if (entry.llm?.ok) {
      metaParts.push(`${entry.llm.provider} ${entry.llm.model} · llm ${formatMs(entry.llm.latencyMs)} ms`);
    } else if (entry.llm && !entry.llm.ok) {
      metaParts.push(`llm ${entry.llm.errorClass}: fallback to template`);
    }
    metaParts.push(`engine ${formatMs(entry.engineMs)} ms`, `round-trip ${formatMs(entry.roundTripMs)} ms`);
    if (entry.opening?.name) metaParts.push(`${entry.opening.eco} ${entry.opening.name}`);
    metaParts.push(`ply ${entry.ply}`);
    meta.textContent = metaParts.join(" · ");

    item.append(head, text, meta);
    els.cmFeed.append(item);
  });
}

function renderCommentaryMeta() {
  const stats = commentaryFeed.getStats();
  const parts = [`${commentaryFeed.size()} of the last ${COMMENTARY_MAX_ENTRIES} plies explained`];
  parts.push(commentary.llmEngine === "templates" ? "phrasing templates" : `phrasing ${commentary.llmEngine}`);
  if (stats.skipped > 0) parts.push(`${stats.skipped} jump(s) skipped`);
  if (stats.suppressed > 0) parts.push(`${stats.suppressed} suppressed (off)`);
  if (commentary.staleDiscards > 0) parts.push(`${commentary.staleDiscards} stale discarded`);
  if (commentary.errors > 0) parts.push(`${commentary.errors} error(s)`);
  els.cmMeta.hidden = false;
  els.cmMeta.textContent = parts.join(" · ");
  els.cmMeta.title = `explain client: ${explainClient.url}`;
}

function renderCommentaryError(result) {
  const error = result.error ?? {};
  const attempts = result.attempts > 1 ? ` (retried once, ${result.attempts} attempts)` : "";
  commentary.status = `error:${result.errorClass}`;
  commentary.errors += 1;
  commentary.lastError = {
    class: result.errorClass,
    status: result.status,
    detail: error.detail ?? null,
    at: Date.now(),
  };
  setCmStatus(result.errorClass === "offline" ? "server offline" : "error", "chip-offline");
  setCommentaryMessage(
    result.errorClass === "offline"
      ? offlineCardMessage("commentary", explainClient.url, attempts)
      : result.errorClass === "invalid_input"
        ? `commentary input rejected (HTTP ${result.status}): ${error.detail ?? "the server rejected this position"}${attempts}`
        : `commentary failed: ${error.message ?? result.errorClass}${error.detail ? ` — ${error.detail}` : ""}${attempts}`,
    "mx-message is-error",
  );
  renderCommentaryMeta();
  if (result.errorClass === "offline") scheduleServerRecovery("commentary");
}

/** The LLM status line: engine · model · key/permission state (never the key). */
function renderCommentaryLlmStatus() {
  const provider = llmProvider(commentary.llmEngine);
  const hasKey = commentary.llmApiKey.length > 0;
  const status = commentary.llmStatus;
  if (!provider) {
    els.cmLlmStatus.textContent = "templates · no key needed";
  } else if (status && status.engine === commentary.llmEngine && status.at) {
    els.cmLlmStatus.textContent = status.ok
      ? `${provider.id} · ${status.model} · OK in ${formatMs(status.latencyMs)} ms`
      : `${provider.id} · test failed: ${status.errorClass}${status.error ? ` (${status.error})` : ""}`;
  } else {
    const parts = [`${provider.id} · ${provider.model}`];
    parts.push(hasKey ? "key stored (local)" : "key needed");
    if (commentary.llmPermission === "declined") parts.push("host permission declined");
    else if (commentary.llmPermission === "error") parts.push("host permission error");
    els.cmLlmStatus.textContent = parts.join(" · ");
  }
  els.cmKey.placeholder = hasKey ? "•••••• stored (local only)" : "paste provider key";
  renderCommentaryPrivacy();
}

/** The mandated privacy line, shown whenever a real provider is selected. */
function renderCommentaryPrivacy() {
  const line = providerPrivacyLine(commentary.llmEngine);
  if (line) {
    els.cmPrivacy.hidden = false;
    els.cmPrivacy.textContent =
      `${line} when you explain a move. The key stays in chrome.storage.local and is never logged; ` +
      "the templates need neither.";
  } else {
    els.cmPrivacy.hidden = true;
    els.cmPrivacy.textContent = "";
  }
}

async function onCommentaryEnabledChanged() {
  clearError();
  commentary.enabled = els.cmEnabled.checked;
  await saveSettings({ commentaryEnabled: commentary.enabled });
  if (!commentary.enabled) {
    renderCommentaryIdle("commentary off — moves are not explained. The feed keeps what it already explained.");
  } else {
    renderCommentaryIdle(null);
  }
  // Re-evaluate the current state: a move that landed while the toggle was off
  // was consumed (`suppressed`) and is not retro-explained.
  if (lastChesscomState) await onCommentary(lastChesscomState);
}

async function onLlmEngineChanged() {
  clearError();
  const engine = normalizeLlmEngine(els.cmEngine.value, LLM_DEFAULT_ENGINE);
  commentary.llmEngine = engine;
  els.cmEngine.value = engine;
  await saveSettings({ llmEngine: engine });
  const provider = llmProvider(engine);
  if (provider) {
    // Enable-time host-permission request (this change handler is the user
    // gesture). A denial is reported; requests then fall back to templates.
    const permission = await requestLlmPermission(engine);
    commentary.llmPermission = permission.status;
  } else {
    commentary.llmPermission = "templates";
  }
  commentary.llmStatus = null;
  renderCommentaryLlmStatus();
}

async function onLlmKeyChanged() {
  clearError();
  const value = typeof els.cmKey.value === "string" ? els.cmKey.value.trim() : "";
  commentary.llmApiKey = value;
  els.cmKey.value = ""; // never keep the key in the DOM
  await saveSettings({ llmApiKey: value });
  commentary.llmStatus = null;
  renderCommentaryLlmStatus();
}

async function onLlmTestClicked() {
  clearError();
  const engine = commentary.llmEngine;
  const provider = llmProvider(engine);
  if (!provider) {
    commentary.llmStatus = { engine, ok: true, model: "templates", latencyMs: 0, errorClass: null, error: null, at: Date.now() };
    renderCommentaryLlmStatus();
    return;
  }
  els.cmTest.disabled = true;
  els.cmLlmStatus.textContent = `testing ${provider.id}…`;
  try {
    const result = await testLlmConnection({
      engine,
      apiKey: commentary.llmApiKey,
      endpoint: commentaryTest.endpoints[engine] ?? null, // null in production
    });
    commentary.llmStatus = {
      engine,
      ok: result.ok,
      model: result.model,
      latencyMs: result.latencyMs,
      errorClass: result.errorClass,
      error: result.error ?? null,
      sample: result.sample ?? null,
      at: Date.now(),
    };
  } catch (error) {
    commentary.llmStatus = { engine, ok: false, model: provider.model, latencyMs: 0, errorClass: "exception", error: error?.message ?? String(error), at: Date.now() };
  } finally {
    els.cmTest.disabled = false;
  }
  renderCommentaryLlmStatus();
}

/* ------------------------------------------------ chess.com game state card */

function onRuntimeMessage(message, sender) {
  if (message?.type !== MSG_CHESSCOM_STATE || !message.state) return undefined;
  renderChesscomState(message.state, sender?.tab?.id ?? null);
  return undefined;
}

async function activeTabId() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return typeof tab?.id === "number" ? tab.id : null;
}

async function refreshChesscomState({ announce = false } = {}) {
  if (announce) clearError();
  const tabId = await activeTabId();
  if (tabId === null) {
    setCcChip("no active tab", "chip-idle");
    return;
  }
  try {
    const response = await chrome.tabs.sendMessage(tabId, { type: MSG_GET_STATE });
    if (response?.ok && response.state) {
      renderChesscomState(response.state, tabId);
    } else {
      renderChesscomState({ ok: false, reason: response?.error ?? "no state" }, tabId);
    }
  } catch (error) {
    // No content script in the active tab (not chess.com, or the page was loaded
    // before the extension was installed/updated).
    lastChesscomState = null;
    setCcChip("no chess.com tab", "chip-idle");
    els.ccHint.textContent =
      "The active tab has no humanplay content script. Open/reload a chess.com tab " +
      "(https://www.chess.com/…), then press Refresh state.";
    if (announce) showError(`no chess.com content script in the active tab: ${error?.message ?? error}`);
  }
}

function renderChesscomState(state, tabId) {
  lastChesscomState = state;
  lastChesscomAt = Date.now();

  if (!state?.ok) {
    setCcChip("no game detected", "chip-offline");
    els.ccBoard.textContent = state?.boardId ? `${state.boardId}` : "—";
    els.ccFen.textContent = state?.reason ?? "—";
    els.ccMoves.textContent = "—";
    els.ccTurn.textContent = "—";
    els.ccColor.textContent = "—";
    els.ccMismatch.hidden = true;
    els.ccWarning.hidden = true;
  } else {
    setCcChip("listening", "chip-online");
    els.ccBoard.textContent =
      (state.boardId ? `#${state.boardId}` : "(board)") +
      (state.boardTag ? ` · ${state.boardTag}` : "") +
      (state.boardInViewport === false ? " · off-screen" : "");
    els.ccFen.textContent = state.fen;
    const moveCount = state.historyTracking?.active ? state.historyTracking.moves : state.movesUci.length;
    els.ccMoves.textContent =
      `${moveCount} move${moveCount === 1 ? "" : "s"}` +
      (state.historyStatus ? ` · ${state.historyStatus}` : "") +
      (state.historyTracking?.active ? " (tracked from the board)" : "") +
      (state.sessionSeq ? ` · session ${state.sessionSeq}` : "");
    els.ccTurn.textContent = `${state.turn === "b" ? "black" : "white"} to move`;
    els.ccColor.textContent = state.userColor
      ? `${state.userColor} (${state.userColorSource ?? "?"})`
      : `unknown (${state.userColorSource ?? "auto"}) — pick a fallback color below`;

    if (state.mismatch) {
      const mismatch = state.mismatch;
      let text = `mismatch: ${mismatch.kind}`;
      if (mismatch.note) text += ` — ${mismatch.note}`;
      if (mismatch.reason && mismatch.reason !== mismatch.note) text += ` — ${mismatch.reason}`;
      if (mismatch.failedAt) {
        text += ` (failed at ply ${mismatch.failedAt}`;
        if (mismatch.failedToken) text += `: "${mismatch.failedToken}"`;
        text += ")";
      }
      if (mismatch.sanCount !== undefined) text += ` (move list had ${mismatch.sanCount} moves)`;
      if (mismatch.container) text += ` [list: ${mismatch.container}]`;
      els.ccMismatch.hidden = false;
      els.ccMismatch.textContent = `${text}. Board kept as the source of truth; history dropped for this update.`;
    } else {
      els.ccMismatch.hidden = true;
    }

    const warnings = Array.isArray(state.warnings) ? state.warnings : [];
    if (warnings.length > 0) {
      els.ccWarning.hidden = false;
      els.ccWarning.textContent = `warnings: ${warnings.join(" · ")}`;
    } else {
      els.ccWarning.hidden = true;
    }

    els.ccHint.textContent =
      `source: position ${state.positionSource ?? "?"} · history ${state.historySource ?? "?"}` +
      (state.strategyLog?.length ? ` · strategy ${state.strategyLog.filter((entry) => entry.ok).map((entry) => entry.strategy).join(", ") || "none"}` : "") +
      ` · adapter ${state.adapterVersion ?? "?"}`;
  }
  void tabId;

  // M4: run the analysis policy for this state (async, never blocks the card).
  onGameState(state).catch((error) => showError(`analysis failed: ${error?.message ?? error}`));
}

function renderChesscomChip() {
  if (lastChesscomState && Date.now() - lastChesscomAt < LISTENING_STALE_MS) {
    setCcChip("listening", "chip-online");
    return;
  }
  if (lastChesscomState?.ok === false) {
    setCcChip("no game detected", "chip-offline");
    return;
  }
  setCcChip("waiting…", "chip-idle");
}

function setCcChip(text, className) {
  els.ccChip.textContent = text;
  els.ccChip.className = `chip ${className}`;
}

/* --------------------------------------------------------- Maia suggestion */

/**
 * The policy for one GameState: the M4 analysis loop, the M7 premove planner
 * and the M8 commentary feed, each with its own client, cache and stale guard.
 * Run concurrently — they share no state beyond the settings they read.
 * Called for every state render (message or Refresh state) — the clients'
 * cache/dedupe/stale logic makes repeated calls free.
 */
async function onGameState(state) {
  await Promise.all([onGameStateAnalysis(state), onPremovePolicy(state), onCommentary(state)]);
}

/**
 * The M4 analysis policy for one GameState: gate -> request -> render.
 */
async function onGameStateAnalysis(state) {
  analysisState = { stateReceivedAt: performance.now() };

  if (state?.ok) {
    // New game? Every layer resets (analysis/premove/explain caches, the TTS
    // dedupe keys, the cards, the arrows, the commentary feed) — see
    // resetLayersForNewGame().
    const seq = analyzeClient.noteSessionSeq(state.sessionSeq ?? 0);
    if (seq.changed) {
      const reset = resetLayersForNewGame({
        seq: state.sessionSeq ?? 0,
        source: "analysis",
        cleared: { analyzeCache: seq.cleared },
      });
      renderSuggestionIdle(
        `new game detected — all layers reset (analysis cache ${seq.cleared} entries, ` +
          `${reset?.cleared.spokenKeys ?? 0} spoken keys cleared)`,
        "new-game",
      );
    }
  }

  const request = state?.ok ? buildAnalyzeRequest(state, { eloSelf: elo.self, eloOppo: elo.oppo, topK: DEFAULT_TOP_K }) : null;
  if (request) {
    // Declare the position on the board even when we do not request it (gate
    // closed): an older in-flight result for the previous position then
    // resolves as stale instead of overwriting the panel.
    analyzeClient.expectKey(request.key);
    analysisDebug.currentKey = request.key;
  }

  const gate = analysisGate(state, { assistantEnabled: els.toggle.checked });
  analysisDebug.gate = gate.mode;

  if (!state?.ok) {
    renderSuggestionIdle(state?.reason ? `no game state: ${state.reason}` : "no chess.com game detected", "no-state");
    return;
  }

  renderAnalysisWarning(request?.warning ?? null);

  if (gate.mode === "off") {
    renderSuggestionIdle("assistant off — press Analyze now to analyze the current position", "assistant-off");
    return;
  }
  if (gate.mode === "no-color") {
    renderSuggestionIdle(
      "your color is unknown — set the fallback color in the game-state card (or press Analyze now)",
      "no-color",
    );
    return;
  }
  if (gate.mode === "waiting") {
    renderSuggestionWaiting(state);
    return;
  }

  await runAnalysis({ state, request, auto: true });
}

function renderSuggestionWaiting(state) {
  setMxStatus("waiting", "chip-idle");
  els.mxMessage.hidden = false;
  els.mxMessage.className = "mx-message";
  els.mxMessage.textContent =
    `their turn (${state.turn === "b" ? "black" : "white"} to move) — waiting. ` +
    "See the Premove card for their likely replies; Analyze now still works.";
  hideRows();
  hideWdl();
  clearOverlay("opponent-turn");
}

function renderSuggestionIdle(message, clearReason = "idle") {
  setMxStatus("idle", "chip-idle");
  els.mxMessage.hidden = false;
  els.mxMessage.className = "mx-message";
  els.mxMessage.textContent = message;
  hideRows();
  hideWdl();
  els.mxMeta.hidden = true;
  clearOverlay(clearReason);
}

async function runAnalysis({ state, request, auto }) {
  const startedAt = performance.now();
  analysisDebug.requestCount += 1;
  analysisDebug.status = "analyzing";
  setMxStatus("analyzing…", "chip-checking");
  els.mxMessage.hidden = false;
  els.mxMessage.className = "mx-message";
  els.mxMessage.textContent = `analyzing${auto ? "" : " (manual)"} — ${describeRequest(state, request)}…`;
  hideRows(); // a new position always wins: never show the previous suggestion
  hideWdl();
  clearOverlay("analyzing"); // and never keep the previous position's arrows

  const result = await analyzeClient.analyze(request, { force: !auto });
  analysisDebug.lastRoundTripMs = result.roundTripMs;

  if (result.stale) {
    // Silently discard: the position changed while this request was in flight.
    analysisDebug.staleDiscardCount += 1;
    analysisDebug.status = "stale-discarded";
    clearOverlay("stale");
    return;
  }

  if (!result.ok) {
    renderAnalysisError(result, request);
    return;
  }

  const latencyMs = performance.now() - startedAt;
  renderSuggestion(result, request, state, latencyMs);
}

function describeRequest(state, request) {
  if (request?.mode === "history") {
    return `${request.historyUsed} move${request.historyUsed === 1 ? "" : "s"} of history`;
  }
  return `board position${state?.mismatch ? " (no history: mismatch)" : ""}`;
}

function renderSuggestion(result, request, state, latencyMs) {
  const data = result.data;
  const moves = Array.isArray(data.moves) ? data.moves : [];
  const turnColor = state.turn === "b" ? "black" : "white";
  const opponentPerspective = state.userColor === "white" || state.userColor === "black"
    ? turnColor !== state.userColor
    : null;

  analysisDebug.status = moves.length === 0 ? "game-over" : "ready";
  analysisDebug.lastRenderKey = result.key;
  analysisDebug.lastEngineMs = data.elapsed_ms ?? null;
  analysisDebug.lastStateToRenderMs = analysisState.stateReceivedAt
    ? performance.now() - analysisState.stateReceivedAt
    : latencyMs;
  analysisDebug.lastRenderAtEpochMs = Date.now();
  analysisDebug.lastError = null;
  analysisDebug.lastResult = {
    key: result.key,
    mode: request.mode,
    historyUsed: request.historyUsed,
    model: data.model ?? null,
    elapsed_ms: data.elapsed_ms ?? null,
    roundTripMs: result.roundTripMs,
    attempts: result.attempts,
    fromCache: result.fromCache,
    moves: moves.map((move) => ({ uci: move.uci, san: move.san, prob: move.prob })),
    wdl: data.wdl ?? null,
    opponentPerspective,
  };
  analysisDebug.renderCount += 1;

  els.mxMessage.hidden = true;

  if (moves.length === 0) {
    // Game over: the server answers moves:[] + a rules-decided WDL.
    renderGameOver(data, state, turnColor, opponentPerspective);
    clearOverlay("game-over");
  } else {
    renderMoveRows(moves);
    renderWdl(data.wdl, { turnColor, opponentPerspective });
    // M5: draw the current suggestion on the real board (top-1 always,
    // alternatives only when enabled).
    publishOverlaySuggestion(result, moves);
  }
  // M6: speak the suggestion (the decision records why/why not — game over and
  // every other non-speak case end up in `analysisDebug.tts.decision`).
  speakSuggestion({ state, key: result.key, moves, trigger: "suggestion", source: "panel" }).catch((error) =>
    showError(`TTS: ${error?.message ?? error}`),
  );

  const parts = [
    `model ${data.model ?? "?"}`,
    `engine ${formatMs(data.elapsed_ms)} ms`,
    `round-trip ${formatMs(result.roundTripMs)} ms`,
    request.mode === "history" ? `${request.historyUsed} moves · replayed` : "board only · no history",
    `ui ${formatMs(analysisDebug.lastStateToRenderMs ?? latencyMs)} ms`,
  ];
  if (result.fromCache) parts.push("cached");
  els.mxMeta.hidden = false;
  els.mxMeta.textContent = parts.join(" · ");
  els.mxMeta.title = `position key: ${result.key}`;

  setMxStatus(
    moves.length === 0 ? "game over" : "suggestion ready",
    moves.length === 0 ? "chip-idle" : "chip-online",
  );
}

function renderGameOver(data, state, turnColor, opponentPerspective) {
  const wdl = normalizeWdl(data.wdl);
  const outcome = wdl.loss >= 0.999
    ? `checkmate — ${turnColor} is mated`
    : wdl.win >= 0.999
      ? `${turnColor} delivered checkmate`
      : "draw (stalemate or a drawn rule)";
  const who = opponentPerspective === null
    ? "side to move"
    : opponentPerspective
      ? "opponent's perspective"
      : "you";
  els.mxMessage.hidden = false;
  els.mxMessage.className = "mx-message is-gameover";
  els.mxMessage.textContent =
    `game over — ${outcome}. Rules-decided outcome (${who}): ` +
    `win ${formatPercent(displayWdl(wdl, "win", opponentPerspective))} · ` +
    `draw ${formatPercent(wdl.draw)} · ` +
    `loss ${formatPercent(displayWdl(wdl, "loss", opponentPerspective))}`;
  renderWdl(data.wdl, { turnColor, opponentPerspective });
  hideRows();
}

function renderMoveRows(moves) {
  els.mxMoves.innerHTML = "";
  moves.forEach((move, index) => {
    const percent = Number.isFinite(move.prob) ? move.prob * 100 : 0;
    const item = document.createElement("li");
    item.className = index === 0 ? "mx-move mx-top" : "mx-move";
    item.dataset.rank = String(index + 1);
    item.dataset.uci = move.uci ?? "";
    item.dataset.san = move.san ?? "";

    const rank = document.createElement("span");
    rank.className = "mx-rank";
    rank.textContent = String(index + 1);

    const sanBlock = document.createElement("span");
    sanBlock.className = "mx-san-block";
    const san = document.createElement("span");
    san.className = "mx-san";
    san.textContent = move.san ?? move.uci ?? "?";
    const uci = document.createElement("span");
    uci.className = "mx-uci";
    uci.textContent = move.uci ?? "";
    sanBlock.append(san, uci);

    const bar = document.createElement("span");
    bar.className = "mx-bar";
    const fill = document.createElement("span");
    fill.style.width = `${Math.max(0, Math.min(100, percent))}%`;
    bar.append(fill);

    const prob = document.createElement("span");
    prob.className = "mx-prob";
    prob.textContent = formatPercent(move.prob);

    item.append(rank, sanBlock, bar, prob);
    els.mxMoves.append(item);
  });
  els.mxMoves.hidden = false;
}

function renderWdl(wdlRaw, { turnColor, opponentPerspective }) {
  const wdl = normalizeWdl(wdlRaw);
  const label = opponentPerspective === null
    ? `human outcome prediction (${turnColor} to move)`
    : opponentPerspective
      ? "human outcome prediction (opponent's perspective)"
      : "human outcome prediction (you)";
  els.mxWdlLabel.textContent = label;
  els.mxWdlInfo.title =
    "Maia-3's human-model value head: the result distribution Maia predicts for " +
    `${opponentPerspective ? "the side to move (the opponent)" : "your side"} in this position, ` +
    `conditioned on human games at Elo ${elo.self} (you) / ${elo.oppo} (opponent). ` +
    "It is NOT an engine evaluation.";
  els.mxWdlWin.textContent = `win ${formatPercent(displayWdl(wdl, "win", opponentPerspective))}`;
  els.mxWdlDraw.textContent = `draw ${formatPercent(wdl.draw)}`;
  els.mxWdlLoss.textContent = `loss ${formatPercent(displayWdl(wdl, "loss", opponentPerspective))}`;
  els.mxWdlBox.hidden = false;
}

function displayWdl(wdl, which, opponentPerspective) {
  if (opponentPerspective !== true) return wdl[which];
  // Server perspective = side to move = the opponent: flip win <-> loss.
  return which === "win" ? wdl.loss : which === "loss" ? wdl.win : wdl.draw;
}

function normalizeWdl(wdl) {
  const value = (key) => {
    const number = Number(wdl?.[key]);
    return Number.isFinite(number) ? number : null;
  };
  return { win: value("win"), draw: value("draw"), loss: value("loss") };
}

function formatPercent(probability) {
  return Number.isFinite(probability) ? `${(probability * 100).toFixed(1)}%` : "—";
}

function formatMs(value) {
  return Number.isFinite(value) ? value.toFixed(1) : "?";
}

function renderAnalysisWarning(warning) {
  if (!warning) {
    els.mxWarn.hidden = true;
    els.mxWarn.textContent = "";
    return;
  }
  els.mxWarn.hidden = false;
  els.mxWarn.textContent = warning;
}

function renderAnalysisError(result, request) {
  const error = result.error ?? {};
  const attempts = result.attempts > 1 ? ` (retried once, ${result.attempts} attempts)` : "";
  let message;
  let className = "mx-message";
  switch (result.errorClass) {
    case "offline":
      setMxStatus("server offline", "chip-offline");
      className = "mx-message is-error";
      message = offlineCardMessage("the suggestion", analyzeClient.url, attempts);
      break;
    case "timeout":
      setMxStatus("timeout", "chip-offline");
      className = "mx-message is-error";
      message =
        `no answer within ${analyzeClient.timeoutMs} ms${attempts} — the server may still be loading ` +
        "the model (the first request after a start can take longer). It will answer on the next position.";
      break;
    case "invalid_input":
      setMxStatus("invalid input", "chip-offline");
      className = "mx-message is-error";
      message = `invalid input (HTTP ${result.status}): ${error.detail ?? "the server rejected this position"}${attempts}`;
      break;
    case "engine_unavailable":
      setMxStatus("engine unavailable", "chip-offline");
      className = "mx-message is-error";
      message = `engine unavailable (HTTP 503): ${error.detail ?? "the Maia-3 model failed to load"}${attempts}`;
      break;
    default:
      setMxStatus("error", "chip-offline");
      className = "mx-message is-error";
      message = `analysis failed: ${error.message ?? result.errorClass}${error.detail ? ` — ${error.detail}` : ""}${attempts}`;
  }
  analysisDebug.status = `error:${result.errorClass}`;
  analysisDebug.lastRenderKey = null;
  analysisDebug.lastResult = null;
  analysisDebug.lastError = {
    class: result.errorClass,
    status: result.status,
    attempts: result.attempts,
    roundTripMs: result.roundTripMs,
    detail: error.detail ?? null,
  };
  els.mxMessage.hidden = false;
  els.mxMessage.className = className;
  els.mxMessage.textContent = message;
  hideRows();
  hideWdl();
  els.mxMeta.hidden = true;
  clearOverlay(`error:${result.errorClass}`);
  if (result.errorClass === "offline") scheduleServerRecovery("analyze");
  void request;
}

function hideRows() {
  els.mxMoves.hidden = true;
  els.mxMoves.innerHTML = "";
}

function hideWdl() {
  els.mxWdlBox.hidden = true;
}

function setMxStatus(text, className) {
  els.mxStatus.textContent = text;
  els.mxStatus.className = `chip ${className}`;
}

async function onAnalyzeNowClicked() {
  clearError();
  const state = lastChesscomState;
  if (!state?.ok) {
    showError("no chess.com game state yet — open a game and press Refresh state");
    return;
  }
  const request = buildAnalyzeRequest(state, { eloSelf: elo.self, eloOppo: elo.oppo, topK: DEFAULT_TOP_K });
  analyzeClient.expectKey(request.key);
  analysisDebug.currentKey = request.key;
  analysisDebug.gate = "manual";
  renderAnalysisWarning(request.warning);
  await runAnalysis({ state, request, auto: false });
}

/* -------------------------------------------------------- snapshot recorder */

async function onRecordSnapshot() {
  clearError();
  const tabId = await activeTabId();
  if (tabId === null) {
    showError("no active tab");
    return;
  }
  els.ccSnapshot.disabled = true;
  els.ccSnapshot.textContent = "Recording…";
  els.ccSnapshotStatus.hidden = true;
  try {
    const response = await chrome.tabs.sendMessage(tabId, { type: MSG_RECORD_SNAPSHOT });
    if (!response?.ok || !response.snapshot) {
      throw new Error(response?.error ?? "the content script did not return a snapshot");
    }
    const json = `${JSON.stringify(response.snapshot, null, 2)}\n`;
    const blobUrl = URL.createObjectURL(new Blob([json], { type: "application/json" }));
    let downloadId = null;
    try {
      downloadId = await chrome.downloads.download({ url: blobUrl, filename: response.name, saveAs: false });
    } finally {
      setTimeout(() => URL.revokeObjectURL(blobUrl), 10000);
    }

    // Best effort: if the local fixture server is running (test/tools/fixture_server.py),
    // let it drop the snapshot straight into test/fixtures/chesscom-snapshots/ —
    // no manual moving. Chrome's downloads API alone cannot write into the repo.
    let serverPath = null;
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), SNAPSHOT_UPLOAD_TIMEOUT_MS);
      const upload = await fetch(SNAPSHOT_UPLOAD_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: response.name, snapshot: response.snapshot }),
        signal: controller.signal,
      });
      clearTimeout(timer);
      if (upload.ok) serverPath = (await upload.json())?.path ?? null;
    } catch {
      serverPath = null; // server not running — the download is the primary output
    }

    els.ccSnapshotStatus.hidden = false;
    els.ccSnapshotStatus.textContent = serverPath
      ? `snapshot saved to ${serverPath} (and downloaded as ${response.name}, id ${downloadId})`
      : `snapshot downloaded as ${response.name} — move it into test/fixtures/chesscom-snapshots/ ` +
        "(or start test/tools/fixture_server.py and record again to write it straight into the repo)";
  } catch (error) {
    showError(`snapshot recording failed: ${error?.message ?? error}`);
  } finally {
    els.ccSnapshot.disabled = false;
    els.ccSnapshot.textContent = "Record chess.com snapshot";
  }
}

/* ----------------------------------------------------------------- capture */

async function onCaptureClicked() {
  clearError();
  els.capture.disabled = true;
  els.capture.textContent = "Capturing…";
  try {
    const frame = await getCaptureSource().getFrame();
    lastFrame = frame;
    renderFrame(frame);
  } catch (error) {
    showError(error?.message ?? String(error));
  } finally {
    els.capture.disabled = false;
    els.capture.textContent = "Capture now";
  }
}

function renderFrame(frame) {
  els.preview.src = frame.dataUrl;
  els.previewWrap.hidden = false;
  els.record.disabled = false;

  const when = new Date(frame.capturedAt);
  const lines = [
    `${frame.width} × ${frame.height} px`,
    `captured ${when.toLocaleTimeString()} (${frame.capturedAt})`,
    `source: ${frame.source}`,
    `tab: ${frame.tabTitle || "(title unavailable)"} — ${frame.tabUrl || "(url unavailable)"}`,
  ];
  els.frameMeta.textContent = lines.join("\n");
  els.frameMeta.hidden = false;
}

/* ---------------------------------------------------------------- recorder */

async function onRecordClicked() {
  clearError();
  if (!lastFrame) {
    showError("capture a frame before recording a fixture");
    return;
  }
  const filename = `humanplay-${timestampSlug(new Date())}.png`;
  try {
    const downloadId = await chrome.downloads.download({
      url: lastFrame.dataUrl,
      filename,
      saveAs: false,
    });
    els.frameMeta.textContent +=
      `\nrecorded as ${filename} (Downloads, download id ${downloadId})`;
  } catch (error) {
    showError(`fixture download failed: ${error?.message ?? error}`);
  }
}

/** "2026-10-16T09:41:07.123Z" -> "20261016-094107" (filename-safe, local time). */
function timestampSlug(date) {
  const pad = (value) => String(value).padStart(2, "0");
  return (
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}` +
    `-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
  );
}

/* ------------------------------------------------------------ server health */

/**
 * One /health check. `quiet` skips the chip flicker (used by the recovery
 * poll). @returns {{online: boolean, health?: object, reason?: string}}
 */
async function refreshHealth({ quiet = false } = {}) {
  if (!quiet) clearError();
  if (!quiet) setChip("checking…", "chip-checking");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HEALTH_TIMEOUT_MS);
  try {
    const response = await fetch(HEALTH_URL, { signal: controller.signal, cache: "no-store" });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    const health = await response.json();
    const model = health?.model || "unknown model";
    const version = typeof health?.version === "string" && health.version ? ` · v${health.version}` : "";
    const label = health?.status === "ok" ? `online · ${model}${version}` : `online · ${model}${version} (loading)`;
    setChip(label, "chip-online");
    els.chip.title = JSON.stringify(health);
    healthState = { online: true, at: Date.now(), health, error: null };
    return { online: true, health };
  } catch (error) {
    const reason = error?.name === "AbortError" ? "timeout" : (error?.message ?? error);
    setChip("server offline", "chip-offline");
    els.chip.title = `GET ${HEALTH_URL} failed: ${reason}`;
    healthState = { online: false, at: Date.now(), health: null, error: String(reason) };
    return { online: false, reason: String(reason) };
  } finally {
    clearTimeout(timer);
  }
}

/** M9: the single offline wording shared by the suggestion/premove/commentary cards. */
function offlineCardMessage(label, url, attempts = "") {
  return (
    `server offline — ${label} needs the local Maia-3 server: could not reach ${url}${attempts}. ` +
    `Press “Copy start command” (Server card), paste it into a terminal, and this card recovers ` +
    `on its own: ${SERVER_START_COMMAND}`
  );
}

/**
 * M9: auto-recovery. Called whenever a card lands in the "server offline"
 * state; one interval polls /health (bounded, one episode at a time). When the
 * server answers again the current position is re-run through all three
 * policies — failures are never cached, so fresh requests go out.
 */
function scheduleServerRecovery(reason) {
  recovery.lastReason = reason;
  if (recovery.active) return;
  recovery.active = true;
  recovery.attempts = 0;
  recovery.startedAt = Date.now();
  recovery.recoveredAt = null;
  recovery.timer = setInterval(() => {
    recovery.attempts += 1;
    refreshHealth({ quiet: true }).then((result) => {
      recovery.lastCheck = { at: Date.now(), online: result.online, attempts: recovery.attempts };
      if (result.online) {
        stopServerRecovery();
        recovery.recoveredAt = Date.now();
        if (lastChesscomState) {
          onGameState(lastChesscomState).catch((error) => showError(`recovery failed: ${error?.message ?? error}`));
        }
      } else if (recovery.attempts >= RECOVERY_MAX_ATTEMPTS) {
        stopServerRecovery();
      }
    });
  }, RECOVERY_INTERVAL_MS);
}

function stopServerRecovery() {
  if (recovery.timer) clearInterval(recovery.timer);
  recovery.timer = null;
  recovery.active = false;
}

/** M9: the "Copy start command" button (Server card). */
async function onCopyStartCommand() {
  clearError();
  const record = { at: Date.now(), command: SERVER_START_COMMAND, ok: false, error: null, method: null };
  const legacyCopy = () => {
    // Fallback for a clipboard-less / permission-denied context: a temporary
    // textarea + execCommand("copy").
    const area = document.createElement("textarea");
    area.value = SERVER_START_COMMAND;
    area.setAttribute("readonly", "");
    area.style.position = "fixed";
    area.style.opacity = "0";
    document.body.append(area);
    area.select();
    const copied = document.execCommand("copy");
    area.remove();
    return copied;
  };
  try {
    if (navigator.clipboard?.writeText) {
      try {
        await navigator.clipboard.writeText(SERVER_START_COMMAND);
        record.method = "navigator.clipboard";
      } catch (error) {
        if (!legacyCopy()) throw error;
        record.method = "execCommand-fallback";
      }
    } else {
      if (!legacyCopy()) throw new Error("no clipboard API available");
      record.method = "execCommand-fallback";
    }
    record.ok = true;
    clipboardState.count += 1;
    clipboardState.last = record;
    els.copyStart.textContent = "Copied ✓";
    els.serverCopied.hidden = false;
    els.serverCopied.textContent = `copied: ${SERVER_START_COMMAND}`;
    setTimeout(() => {
      els.copyStart.textContent = "Copy start command";
    }, 1500);
  } catch (error) {
    record.error = error?.message ?? String(error);
    clipboardState.count += 1;
    clipboardState.last = record;
    showError(`could not copy the start command: ${record.error}`);
  }
  return record;
}

/* ------------------------------------------------- M9: the new-game reset */

/**
 * A rematch/new game must reset EVERY layer, not just the analysis cache:
 * adapter state arrives with a new `sessionSeq`; each client drops its cache
 * via `noteSessionSeq`; this helper clears what the clients do not own — the
 * spoken-key dedupe (so a fresh game may speak the same positions again), the
 * card-level plan/result snapshots, the arrows, and bookkeeping. The
 * commentary feed clears itself in the feed driver's `reset` action.
 *
 * Idempotent per session sequence: whichever policy notices the change first
 * performs the reset; the others merge their cleared-cache counts into the
 * same record.
 */
function resetLayersForNewGame({ seq, source, cleared = {} }) {
  if (gameReset.lastSeq === seq && gameReset.last) {
    Object.assign(gameReset.last.cleared, cleared);
    return gameReset.last;
  }
  const record = {
    at: Date.now(),
    seq,
    source,
    cleared: {
      analyzeCache: 0,
      premoveCache: 0,
      explainCache: 0,
      spokenKeys: spokenKeys.clear(),
      premovePlan: premove.lastPlan ? 1 : 0,
      commentaryEntry: commentary.lastEntry ? 1 : 0,
      ...cleared,
    },
  };
  // Never let the new session show the previous game's layers.
  premove.lastPlan = null;
  premove.status = "idle";
  commentary.lastResult = null;
  commentary.lastEntry = null;
  clearOverlay("new-game");
  clearPremoveOverlay("new-game");
  gameReset.lastSeq = seq;
  gameReset.count += 1;
  gameReset.last = record;
  return record;
}

function setChip(text, className) {
  els.chip.textContent = text;
  els.chip.className = `chip ${className}`;
}

/* ------------------------------------------------------------------- error */

function showError(message) {
  els.error.textContent = message;
  els.error.hidden = false;
}

function clearError() {
  els.error.hidden = true;
  els.error.textContent = "";
}

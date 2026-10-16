/**
 * humanplay MV3 service worker (M2 + M5 + M6).
 *
 * Jobs:
 *
 *   1. the toolbar action opens the side panel — via
 *      setPanelBehavior({openPanelOnActionClick:true}), which is also what
 *      grants the `activeTab` permission for the clicked tab (needed by
 *      BrowserTabCaptureSource, src/capture/capture-source.js);
 *
 *   2. **M5 suggestion routing**: the side panel sends
 *      `humanplay:suggestion` {moves, topN, key} / `humanplay:clear-suggestion`
 *      {reason, key} with `chrome.runtime.sendMessage`; content scripts cannot
 *      receive runtime messages directly, so the worker forwards them with
 *      `chrome.tabs.sendMessage` to **the tab that most recently reported a
 *      GameState** (`humanplay:chesscom-state`, tracked here).
 *
 *   3. **M6 TTS**: the speaker lives HERE, not in the side panel —
 *      `chrome.tts` is exposed in an MV3 service worker (verified on Chrome
 *      155), so speech survives the panel being closed. The panel keeps the
 *      wording/policy and asks over `humanplay:tts-speak` / `:tts-stop` /
 *      `:tts-voices` (see src/tts/tts-service.js; debug hook
 *      `globalThis.__humanplayTts`). Ctrl+Shift+Y (`commands.toggle-tts`) flips
 *      settings.ttsEnabled and the toolbar badge ("TTS") here, so both work
 *      with no panel open.
 *
 * Multi-tab behaviour (documented, intentional): the LAST chess.com tab that
 * broadcast a state wins. Opening a second game tab moves the arrows there; the
 * first tab keeps whatever it had until its next clear/suggestion episode (the
 * overlay's own position-change guard clears stale arrows there). If a tracked
 * tab is gone or has no content script, the forward fails and the id is
 * forgotten until the next state arrives.
 *
 * MV3 workers are killed and restarted at will, so the tracked id is mirrored
 * into `chrome.storage.session` (part of the already-granted `storage`
 * permission, not exposed to content scripts) and read back on demand; the TTS
 * call log is mirrored there too (`tts-service.js`).
 *
 * No analysis, no timers, no loops here.
 */

import { createTtsService, MSG_TTS_SPEAK, MSG_TTS_STOP, MSG_TTS_VOICES, TTS_COMMAND_NAME } from "../tts/tts-service.js";

const MSG_STATE = "humanplay:chesscom-state";
const MSG_SUGGESTION = "humanplay:suggestion";
const MSG_CLEAR_SUGGESTION = "humanplay:clear-suggestion";
const SESSION_KEY = "humanplay.lastStateTabId";

/**
 * The M6 TTS service. Exposed for tests exactly like the panel's
 * `__humanplayAnalysis`: `__humanplayTts` is read-only diagnostics, and
 * `__humanplayTtsTest` is the documented callable seam used by
 * test/tools/tts-proof.mjs (the hotkey handler cannot be dispatched
 * synthetically; real key presses are manual-only).
 */
const ttsService = createTtsService();
globalThis.__humanplayTts = ttsService.debug;
globalThis.__humanplayTtsTest = ttsService.testApi;

chrome.runtime.onInstalled.addListener(enableActionClickOpensPanel);
chrome.runtime.onStartup.addListener(enableActionClickOpensPanel);
chrome.runtime.onInstalled.addListener(() => void ttsService.init());
chrome.runtime.onStartup.addListener(() => void ttsService.init());

// Also run on plain worker start (e.g. after an update or a manual reload).
enableActionClickOpensPanel();
void ttsService.init();

chrome.commands.onCommand.addListener((command) => {
  if (command !== TTS_COMMAND_NAME) return;
  ttsService.toggleFromHotkey();
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local" || !changes.settings) return;
  ttsService.applySettings(changes.settings.newValue ?? {});
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === MSG_STATE && sender?.tab && typeof sender.tab.id === "number") {
    rememberStateTab(sender.tab.id);
    ttsService.noteState(message.state, sender.tab.id);
    return undefined; // the panel (and adapter) handle their own copy
  }
  if (message?.type === MSG_TTS_SPEAK || message?.type === MSG_TTS_STOP || message?.type === MSG_TTS_VOICES) {
    ttsService.handleMessage(message, sender).then(sendResponse, (error) =>
      sendResponse({ ok: false, error: error?.message ?? String(error) }),
    );
    return true; // async response
  }
  if (message?.type === MSG_SUGGESTION || message?.type === MSG_CLEAR_SUGGESTION) {
    forwardToStateTab(message).then(sendResponse);
    return true; // async response
  }
  return undefined;
});

chrome.tabs.onRemoved.addListener((tabId) => {
  if (lastStateTabId === tabId) lastStateTabId = null;
});

/** In-memory copy; `chrome.storage.session` survives worker restarts. */
let lastStateTabId = null;

function enableActionClickOpensPanel() {
  chrome.sidePanel
    .setPanelBehavior({ openPanelOnActionClick: true })
    .catch((error) => {
      // e.g. older Chrome than minimum_chrome_version; the side panel can still
      // be opened from the puzzle icon in the toolbar.
      console.warn("humanplay: could not enable side panel on action click:", error);
    });
}

async function rememberStateTab(tabId) {
  lastStateTabId = tabId;
  try {
    await chrome.storage.session.set({ [SESSION_KEY]: tabId });
  } catch {
    // storage.session unavailable (very old Chrome) — the in-memory copy works
    // until this worker instance is reclaimed.
  }
}

async function stateTabId() {
  if (lastStateTabId !== null) return lastStateTabId;
  try {
    const stored = await chrome.storage.session.get(SESSION_KEY);
    lastStateTabId = typeof stored?.[SESSION_KEY] === "number" ? stored[SESSION_KEY] : null;
  } catch {
    lastStateTabId = null;
  }
  return lastStateTabId;
}

async function forwardToStateTab(message) {
  const tabId = await stateTabId();
  if (tabId === null) {
    return { ok: false, error: "no chess.com tab has reported a game state yet" };
  }
  try {
    const response = await chrome.tabs.sendMessage(tabId, message);
    return { ok: true, tabId, response: response ?? null };
  } catch (error) {
    // Tab closed or the content script is not there (extension just
    // installed/updated): forget the tab so a later state re-registers it.
    if (lastStateTabId === tabId) lastStateTabId = null;
    return { ok: false, tabId, error: error?.message ?? String(error) };
  }
}

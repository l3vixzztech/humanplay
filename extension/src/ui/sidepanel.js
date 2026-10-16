/**
 * humanplay side panel (M3): chess.com game state card + debug capture/recorder.
 *
 * What it does:
 * - listens for `humanplay:chesscom-state` messages broadcast by the content
 *   script (extension/src/content/chesscom-adapter.js) and renders the live
 *   state: board id, FEN, move count, side to move, user color, listening
 *   indicator, mismatch warning;
 * - asks the active tab's content script for the current state ("Refresh state")
 *   and for a sanitized JSON snapshot ("Record chess.com snapshot" — the dev
 *   tool that produces test/fixtures/chesscom-snapshots/ fixtures);
 * - keeps the M2 debug features: one-frame capture through the locked
 *   capture-source abstraction and PNG fixture recording (pixel recognition is
 *   parked — see docs/PROJECT.md).
 *
 * There is deliberately NO analysis here yet: no /analyze call, no engine, no
 * overlay, no TTS (M4+).
 *
 * Persistence rules (docs/PROJECT.md):
 * - settings (assistant on/off, fallback user color) live in
 *   chrome.storage.local under "settings";
 * - screenshot data URLs and game snapshots are NEVER written to
 *   chrome.storage (they are large and may contain page content).
 */

import { getCaptureSource } from "../capture/capture-source.js";

const HEALTH_URL = "http://127.0.0.1:8765/health";
const HEALTH_TIMEOUT_MS = 2500;
const SNAPSHOT_UPLOAD_URL = "http://127.0.0.1:8765/snapshot";
const SNAPSHOT_UPLOAD_TIMEOUT_MS = 1500;
const STORAGE_KEY = "settings";
const MSG_CHESSCOM_STATE = "humanplay:chesscom-state";
const MSG_GET_STATE = "humanplay:get-state";
const MSG_RECORD_SNAPSHOT = "humanplay:record-snapshot";
/** The "listening" chip drops back to idle after this long without a state. */
const LISTENING_STALE_MS = 6000;

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
};

/** Last frame, in memory only (never persisted — see header comment). */
let lastFrame = null;
/** Last chess.com state seen (for the panel's own reporting only). */
let lastChesscomState = null;
let lastChesscomAt = 0;

init();

async function init() {
  els.toggle.addEventListener("change", onToggleChanged);
  els.capture.addEventListener("click", onCaptureClicked);
  els.record.addEventListener("click", onRecordClicked);
  els.refresh.addEventListener("click", refreshHealth);
  els.preview.addEventListener("error", () => showError("preview image failed to render"));
  els.ccRefresh.addEventListener("click", () => refreshChesscomState({ announce: true }));
  els.ccSnapshot.addEventListener("click", onRecordSnapshot);
  els.ccColorSetting.addEventListener("change", onColorSettingChanged);

  chrome.runtime.onMessage.addListener(onRuntimeMessage);
  setInterval(renderChesscomChip, 2000);

  const settings = await loadSettings();
  els.toggle.checked = settings.assistantEnabled;
  renderToggle(settings.assistantEnabled);
  els.ccColorSetting.value = settings.userColor ?? "auto";

  await refreshHealth();
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
    };
  } catch {
    return { assistantEnabled: true, userColor: null };
  }
}

async function onToggleChanged() {
  const enabled = els.toggle.checked;
  renderToggle(enabled);
  await saveSettings({ assistantEnabled: enabled });
}

async function onColorSettingChanged() {
  const value = els.ccColorSetting.value;
  await saveSettings({ userColor: value === "auto" ? null : value });
  // Re-ask the content script — the fallback only matters when detection failed.
  await refreshChesscomState();
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
    return;
  }

  setCcChip("listening", "chip-online");
  els.ccBoard.textContent =
    (state.boardId ? `#${state.boardId}` : "(board)") +
    (state.boardTag ? ` · ${state.boardTag}` : "") +
    (state.boardInViewport === false ? " · off-screen" : "");
  els.ccFen.textContent = state.fen;
  els.ccMoves.textContent =
    `${state.movesUci.length} move${state.movesUci.length === 1 ? "" : "s"}` +
    (state.historyStatus ? ` · ${state.historyStatus}` : "") +
    (state.sessionSeq ? ` · session ${state.sessionSeq}` : "");
  els.ccTurn.textContent = `${state.turn === "b" ? "black" : "white"} to move`;
  els.ccColor.textContent = state.userColor
    ? `${state.userColor} (${state.userColorSource ?? "?"})`
    : `unknown (${state.userColorSource ?? "?"})`;

  if (state.mismatch) {
    els.ccMismatch.hidden = false;
    els.ccMismatch.textContent =
      `mismatch: ${state.mismatch.kind} — ${state.mismatch.note ?? state.mismatch.reason ?? ""}` +
      (state.mismatch.sanCount !== undefined ? ` (move list had ${state.mismatch.sanCount} moves)` : "") +
      ". Board kept as the source of truth; history dropped for this update.";
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
  void tabId;
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

async function refreshHealth() {
  clearError();
  setChip("checking…", "chip-checking");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HEALTH_TIMEOUT_MS);
  try {
    const response = await fetch(HEALTH_URL, { signal: controller.signal, cache: "no-store" });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    const health = await response.json();
    const model = health?.model || "unknown model";
    const label = health?.status === "ok" ? `online · ${model}` : `online · ${model} (loading)`;
    setChip(label, "chip-online");
    els.chip.title = JSON.stringify(health);
  } catch (error) {
    const reason = error?.name === "AbortError" ? "timeout" : (error?.message ?? error);
    setChip("server offline", "chip-offline");
    els.chip.title = `GET ${HEALTH_URL} failed: ${reason}`;
  } finally {
    clearTimeout(timer);
  }
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

/**
 * humanplay side panel (M2): toggle, "Capture now", fixture recorder, server chip.
 *
 * Deliberately no analysis, no board detection, no overlay, no TTS — those are
 * M3+ / M6+. All capture goes through the locked capture-source abstraction.
 *
 * Persistence rules (docs/PROJECT.md):
 * - settings (assistant on/off) live in chrome.storage.local under "settings";
 * - screenshot data URLs are NEVER written to chrome.storage (they are large and
 *   may contain the user's page content) — the last frame is kept in memory only.
 */

import { getCaptureSource } from "../capture/capture-source.js";

const HEALTH_URL = "http://127.0.0.1:8765/health";
const HEALTH_TIMEOUT_MS = 2500;
const STORAGE_KEY = "settings";

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
};

/** Last frame, in memory only (never persisted — see header comment). */
let lastFrame = null;

init();

async function init() {
  els.toggle.addEventListener("change", onToggleChanged);
  els.capture.addEventListener("click", onCaptureClicked);
  els.record.addEventListener("click", onRecordClicked);
  els.refresh.addEventListener("click", refreshHealth);
  els.preview.addEventListener("error", () => showError("preview image failed to render"));

  const { assistantEnabled } = await loadSettings();
  els.toggle.checked = assistantEnabled;
  renderToggle(assistantEnabled);

  await refreshHealth();
}

/* ---------------------------------------------------------------- settings */

async function loadSettings() {
  try {
    const stored = await chrome.storage.local.get(STORAGE_KEY);
    return { assistantEnabled: stored?.[STORAGE_KEY]?.assistantEnabled !== false };
  } catch {
    return { assistantEnabled: true };
  }
}

async function onToggleChanged() {
  const enabled = els.toggle.checked;
  renderToggle(enabled);
  try {
    const stored = await chrome.storage.local.get(STORAGE_KEY);
    await chrome.storage.local.set({
      [STORAGE_KEY]: { ...stored?.[STORAGE_KEY], assistantEnabled: enabled },
    });
  } catch (error) {
    showError(`could not persist the toggle: ${error?.message ?? error}`);
  }
}

function renderToggle(enabled) {
  els.toggleState.textContent = enabled ? "on" : "off";
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

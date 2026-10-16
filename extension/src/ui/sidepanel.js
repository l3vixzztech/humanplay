/**
 * humanplay side panel (M4): game state card + Maia suggestion + Elo.
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
 * (gate/status/keys/counters/latency) for test/tools/analyze-proof.mjs. It is
 * read-only diagnostics — nothing in the panel reads it back.
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
 * Read-only diagnostics for test/tools/analyze-proof.mjs (see header).
 * Never read back by the panel itself.
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
};
globalThis.__humanplayAnalysis = analysisDebug;

const analyzeClient = createAnalyzeClient();
analysisDebug.client = analyzeClient;

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
  els.mxAnalyze.addEventListener("click", onAnalyzeNowClicked);
  els.eloSelf.addEventListener("change", onEloChanged);
  els.eloOppo.addEventListener("change", onEloChanged);
  els.eloReset.addEventListener("click", onEloReset);

  chrome.runtime.onMessage.addListener(onRuntimeMessage);
  setInterval(renderChesscomChip, 2000);

  const settings = await loadSettings();
  els.toggle.checked = settings.assistantEnabled;
  renderToggle(settings.assistantEnabled);
  els.ccColorSetting.value = settings.userColor ?? "auto";
  elo = { self: settings.eloSelf, oppo: settings.eloOppo };
  els.eloSelf.value = String(elo.self);
  els.eloOppo.value = String(elo.oppo);

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
      eloSelf: clampElo(settings.eloSelf, DEFAULT_ELO),
      eloOppo: clampElo(settings.eloOppo, DEFAULT_ELO),
    };
  } catch {
    return { assistantEnabled: true, userColor: null, eloSelf: DEFAULT_ELO, eloOppo: DEFAULT_ELO };
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
 * The analysis policy for one GameState: gate -> request -> render.
 * Called for every state render (message or Refresh state) — the client's
 * cache/dedupe/stale logic makes repeated calls free.
 */
async function onGameState(state) {
  analysisState = { stateReceivedAt: performance.now() };

  if (state?.ok) {
    // New game? The whole cache (previous game's positions) is void.
    const seq = analyzeClient.noteSessionSeq(state.sessionSeq ?? 0);
    if (seq.changed) {
      renderSuggestionIdle(`new game detected — analysis cache cleared (${seq.cleared} entries)`);
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
    renderSuggestionIdle(state?.reason ? `no game state: ${state.reason}` : "no chess.com game detected");
    return;
  }

  renderAnalysisWarning(request?.warning ?? null);

  if (gate.mode === "off") {
    renderSuggestionIdle("assistant off — press Analyze now to analyze the current position");
    return;
  }
  if (gate.mode === "no-color") {
    renderSuggestionIdle(
      "your color is unknown — set the fallback color in the game-state card (or press Analyze now)",
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
    "Opponent prediction arrives in M7; Analyze now still works.";
  hideRows();
  hideWdl();
}

function renderSuggestionIdle(message) {
  setMxStatus("idle", "chip-idle");
  els.mxMessage.hidden = false;
  els.mxMessage.className = "mx-message";
  els.mxMessage.textContent = message;
  hideRows();
  hideWdl();
  els.mxMeta.hidden = true;
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

  const result = await analyzeClient.analyze(request, { force: !auto });
  analysisDebug.lastRoundTripMs = result.roundTripMs;

  if (result.stale) {
    // Silently discard: the position changed while this request was in flight.
    analysisDebug.staleDiscardCount += 1;
    analysisDebug.status = "stale-discarded";
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
  } else {
    renderMoveRows(moves);
    renderWdl(data.wdl, { turnColor, opponentPerspective });
  }

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
      message =
        `server offline — could not reach ${analyzeClient.url}${attempts}. ` +
        `Start it: ${SERVER_START_COMMAND}`;
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

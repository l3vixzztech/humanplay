/**
 * humanplay — chess.com DOM adapter (content script, Milestone 3)
 * ===============================================================
 *
 * Reads the live game state of a chess.com board from the page DOM and emits it
 * as a `GameState` message on every change. It performs **no analysis**: no
 * /analyze calls, no engine. The arrow overlay (M5) lives in its own content
 * script (`board-overlay.js`) and re-anchors on every state published here. The
 * side panel consumes the state.
 *
 * Message protocol (all via `chrome.runtime`):
 *
 *   content -> extension   { type: "humanplay:chesscom-state", state: GameState }
 *       Broadcast after every *change* of the state (debounced ~150 ms) and once
 *       on load. `sender.tab` identifies the chess.com tab.
 *
 *   panel -> content       { type: "humanplay:get-state" }
 *       -> { ok: true, state } | { ok: false, error }
 *
 *   panel -> content       { type: "humanplay:record-snapshot" }
 *       -> { ok: true, name, snapshot }   sanitized JSON snapshot for the fixture
 *                                         corpus (see test/fixtures/chesscom-snapshots)
 *
 * GameState:
 *   {
 *     ok: true, fen, movesUci: [uci], userColor: "white"|"black"|null, flipped,
 *     boardRect: {x, y, w, h},      // 8x8 play area, viewport CSS pixels
 *     devicePixelRatio, gameUrl, gameId, ts, mismatch?: {…},
 *     // adapter detail fields, documented in docs/PROJECT.md:
 *     boardId, boardTag, boardInViewport, turn, moveCount, positionSource,
 *     historySource, historyStatus, flippedSource, userColorSource, warnings[],
 *     strategyLog[], boardStateAgrees, sessionSeq, resetDetected, adapterVersion
 *   }
 *   or { ok: false, reason, gameUrl, ts, … } when no credible position exists.
 *
 * Source-of-truth rules (locked in docs/PROJECT.md):
 *   - the board DOM is the source of truth for the POSITION,
 *   - chess.com's move list is the source of truth for the HISTORY (SAN -> UCI
 *     replay with the vendored chess.js reconstructs castling rights,
 *     en-passant, move counters and validates every move),
 *   - if the two disagree, `mismatch` is set and the update falls back to
 *     board + no history. Nothing is guessed silently.
 *
 * DOM facts verified against live chess.com on 2026-10-16 (Chrome for Testing,
 * see test/fixtures/chesscom/README.md for the probes and saved markup):
 *   board  : <wc-chess-board id="board-single|board-play-computer|board-analysis-board"
 *                            class="board[ flipped]">
 *   pieces : <div class="piece wp square-52"> — square-XY with file first
 *            (a=1..h=8), rank second (1..8); token order varies; absolute
 *            squares do not change when the board is flipped.
 *   moves  : <wc-simple-move-list class="move-list …"> rows .main-line-row >
 *            .node[data-node="line-ply"] > span.node-highlight-content; timestamps
 *            are [data-move-list-el="timestamp"] and are ignored. The older
 *            `wc-vertical-move-list` variant is supported defensively.
 *   players: #board-layout-player-top/-bottom with .clock-component.clock-top
 *            .clock-white|.clock-black — clock/color tokens are the reliable
 *            color signal (`cc-user-block-white` is a cosmetic theme class and
 *            also appears on black players).
 *   state  : <wc-chess-board>.game exposes chess.com's own game object
 *            (getFEN(), getHistorySANs(), getPlayingAs()) and `.state`
 *            (isFlipped). Used as a *fallback position source* and as a
 *            cross-check — never as the primary source.
 */

// NOTE: this file is a CLASSIC script (MV3 content scripts cannot be modules),
// so it has no static imports. board-dom.js / move-history.js / board-locate.js
// / chess.js are loaded with dynamic import() from the content script's isolated
// world; the entry files are listed in `web_accessible_resources` (manifest.json),
// and every helper is reached through `modules.*` so the exact same files run in
// Node (test/tools/adapter-unit.mjs, test/tools/overlay-unit.mjs).
//
// The board ELEMENT itself is picked by the shared `board-locate.js` (M5) — the
// arrow overlay uses the same module, so both scripts always agree which board
// (and which rect) is live.

const ADAPTER_VERSION = "m3.3";
const MSG_STATE = "humanplay:chesscom-state";
const MSG_GET_STATE = "humanplay:get-state";
const MSG_RECORD_SNAPSHOT = "humanplay:record-snapshot";
const DEBOUNCE_MS = 150;
const STORAGE_KEY = "settings";

const moduleUrls = {
  boardDom: chrome.runtime.getURL("src/content/board-dom.js"),
  history: chrome.runtime.getURL("src/content/move-history.js"),
  boardLocate: chrome.runtime.getURL("src/content/board-locate.js"),
};

/** Board candidates live in the shared `board-locate.js` module (M5) — the
 *  same picker the arrow overlay anchors to. Move-list candidates below. */
/** Move-list candidates: verified 2026 structure first, older variants after. */
const MOVE_LIST_SELECTORS = [
  "wc-simple-move-list",
  "wc-vertical-move-list",
  "wc-mode-swap-move-list",
  ".move-list",
  "[class*='move-list']",
  "#move-list",
];

/** Class tokens that identify a player color (clock/color only — see header). */
const COLOR_CLASS = /^(?:clock|color)[-_](white|black)$/;

const USERNAME_SELECTORS = [
  "[class*='username']",
  "[class*='user-tagline']",
  "[class*='player-name']",
  "[data-test-element='user-tagline-username']",
].join(", ");

/* --------------------------------------------------------------- lifecycle */

if (window.top === window.self) {
  start();
}

function start() {
  const runtime = { modules: null, modulesError: null, lastSignature: null, lastState: null, lastStrategyLine: null, sessionSeq: 0, userColorRaw: null, tracking: null };
  let timer = null;

  readUserColorSetting();
  chrome.storage?.onChanged?.addListener(onStorageChanged);
  chrome.runtime.onMessage.addListener(onRuntimeMessage);

  const observer = new MutationObserver(() => schedule("mutation"));
  observer.observe(document.documentElement ?? document, {
    subtree: true,
    childList: true,
    characterData: true,
  });

  // M9.3: chess.com moves pieces by changing their CLASS/STYLE attributes —
  // no childList mutation at all in long games (the move list is a sliver that
  // does not repaint), so the page-level observer above missed real moves and
  // the panel went stale until a manual Refresh. Watch the board element's
  // attributes too (attached per refresh; re-attached when the board changes).
  let boardObserver = null;
  let boardObserverTarget = null;
  function watchBoardAttributes(boardEl) {
    if (!boardEl || boardObserverTarget === boardEl) return;
    boardObserver?.disconnect();
    boardObserverTarget = boardEl;
    boardObserver = new MutationObserver(() => schedule("board-attribute"));
    boardObserver.observe(boardEl, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ["class", "style"],
    });
  }
  window.addEventListener("resize", () => schedule("resize"), { passive: true });
  window.addEventListener("scroll", () => schedule("scroll"), { passive: true, capture: true });

  schedule("load", 0);

  /* ------------------------------------------------------------ scheduling */

  function schedule(reason, delay = DEBOUNCE_MS) {
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      refresh(reason).catch((error) => {
        // Never let a refresh failure kill the observer chain.
        console.debug(`[humanplay] refresh failed (${reason}): ${describeError(error)}`);
      });
    }, delay);
  }

  /* -------------------------------------------------------------- modules */

  async function loadModules() {
    if (runtime.modules) return runtime.modules;
    if (runtime.modulesError) throw runtime.modulesError;
    try {
      const [boardDom, history, boardLocate] = await Promise.all([
        import(moduleUrls.boardDom),
        import(moduleUrls.history),
        import(moduleUrls.boardLocate),
      ]);
      runtime.modules = { boardDom, history, boardLocate };
      return runtime.modules;
    } catch (error) {
      runtime.modulesError = new Error(
        `adapter modules could not be loaded (chrome.runtime.getURL import): ${describeError(error)}`,
      );
      throw runtime.modulesError;
    }
  }

  /* ------------------------------------------------------------- settings */

  async function readUserColorSetting() {
    try {
      const stored = await chrome.storage.local.get(STORAGE_KEY);
      runtime.userColorRaw = stored?.[STORAGE_KEY]?.userColor ?? null;
    } catch {
      runtime.userColorRaw = null;
    }
  }

  function onStorageChanged(changes, area) {
    if (area !== "local" || !changes?.[STORAGE_KEY]) return;
    runtime.userColorRaw = changes[STORAGE_KEY].newValue?.userColor ?? null;
  }

  /* ------------------------------------------------------------ messaging */

  function onRuntimeMessage(message, sender, sendResponse) {
    if (message?.type === MSG_GET_STATE) {
      refresh("panel-request", { force: true })
        .then((state) => sendResponse({ ok: true, state }))
        .catch((error) => sendResponse({ ok: false, error: describeError(error) }));
      return true; // async response
    }
    if (message?.type === MSG_RECORD_SNAPSHOT) {
      refresh("snapshot-request", { force: true })
        .then((state) => {
          const snapshot = buildSnapshot(state);
          const name = `chesscom-snapshot-${fileTimestamp(new Date())}.json`;
          sendResponse({ ok: true, name, snapshot });
        })
        .catch((error) => sendResponse({ ok: false, error: describeError(error) }));
      return true;
    }
    return undefined;
  }

  /* -------------------------------------------------------------- refresh */

  async function refresh(reason, { force = false } = {}) {
    const state = await computeState();
    const signature = stateSignature(state);
    if (!force && signature === runtime.lastSignature) return runtime.lastState ?? state;

    // "Which strategy worked" logging (console.debug → visible in the page
    // console and captured as evidence by test/tools/adapter-proof.mjs).
    const strategyLine = state.ok
      ? `position=${state.positionSource} history=${state.historySource} (${
          state.historyStatus ?? "-"
        }) board=#${state.boardId} moves=${state.movesUci.length}`
      : `no state: ${state.reason}`;
    if (strategyLine !== runtime.lastStrategyLine) {
      runtime.lastStrategyLine = strategyLine;
      console.debug(`[humanplay] ${strategyLine}`);
    }

    runtime.lastSignature = signature;
    runtime.lastState = state;
    // Publish the state to other content scripts of this extension in the same
    // isolated world (M5: the arrow overlay re-anchors on every new state).
    // Order matters: the overlay records the position signature BEFORE the
    // panel (which may immediately ask for an analysis) sees the state.
    try {
      globalThis.__humanplayAdapterState = state;
      globalThis.__humanplayContentHook?.(state);
    } catch {
      // A misbehaving local consumer must never break the adapter.
    }
    try {
      await chrome.runtime.sendMessage({ type: MSG_STATE, state });
    } catch {
      // No listener (panel closed / worker asleep) — completely normal.
    }
    return state;
  }

  async function computeState() {
    const base = { gameUrl: location.href, ts: new Date().toISOString(), adapterVersion: ADAPTER_VERSION };
    let modules;
    try {
      modules = await loadModules();
    } catch (error) {
      return { ok: false, reason: describeError(error), ...base };
    }

    const board = modules.boardLocate.findBoardElement();
    if (!board) {
      return { ok: false, reason: "no visible chess.com board found on this page", ...base };
    }
    watchBoardAttributes(board.el);

    const boardRect = modules.boardLocate.rectOf(board.el);
    const boardState = readBoardState(board.el, modules);
    const position = readPosition(board.el, modules, boardState);
    const historyCandidates = readHistoryCandidates(modules, boardState);

    const warnings = [];
    const mismatch = { value: null };
    const positionField = position.boardField ?? null;

    // Cross-check: the board's own exposed FEN vs the DOM piece reading.
    let boardStateAgrees = null;
    if (positionField && boardState.fen) {
      boardStateAgrees = modules.history.fenBoardField(boardState.fen) === positionField;
      if (!boardStateAgrees) {
        warnings.push(
          `board-exposed FEN (${boardState.fenSource}) disagrees with the DOM piece reading — using the DOM, ` +
            `history check still applies`,
        );
      }
    }

    // Reconciliation (M9.1): every move-list candidate is replayed — exactly
    // first, then with the continue-on-error repair (stray/duplicated DOM
    // tokens) — and a candidate is accepted only when its END POSITION MATCHES
    // THE BOARD. That disambiguates pages with several lists (game previews,
    // analysis panels, stale SPA content) deterministically: the list that
    // belongs to the board wins. Disagreement/unreliable mismatches are only
    // reported after every candidate failed to reconcile.
    let chosen = null; // { candidate, replay, repaired }
    let bestDisagreement = null; // { candidate, replay } — replayed, board differs
    let firstFailure = null; // { candidate, replay } — replay itself failed
    let historyOnly = false; // board placement unreadable: history-only mode
    if (positionField) {
      for (const candidate of historyCandidates) {
        if (!Array.isArray(candidate.sans)) continue;
        const replay = modules.history.replaySanList(candidate.sans);
        if (!replay.ok) {
          if (!firstFailure || candidate.sans.length > firstFailure.candidate.sans.length) {
            firstFailure = { candidate, replay };
          }
          continue;
        }
        if (modules.history.fenBoardField(replay.fen) === positionField) {
          chosen = { candidate, replay, repaired: null };
          break;
        }
        if (!bestDisagreement || candidate.sans.length > bestDisagreement.candidate.sans.length) {
          bestDisagreement = { candidate, replay };
        }
      }
      if (!chosen) {
        for (const candidate of historyCandidates) {
          if (!Array.isArray(candidate.sans)) continue;
          const repaired = modules.history.replaySanListResilient(candidate.sans);
          if (
            repaired.ok &&
            repaired.skipped.length > 0 &&
            modules.history.fenBoardField(repaired.fen) === positionField
          ) {
            chosen = { candidate, replay: repaired, repaired };
            break;
          }
        }
      }
    } else {
      for (const candidate of historyCandidates) {
        if (!Array.isArray(candidate.sans)) continue;
        const replay = modules.history.replaySanList(candidate.sans);
        if (replay.ok) {
          chosen = { candidate, replay, repaired: null };
          break;
        }
        const repaired = modules.history.replaySanListResilient(candidate.sans);
        if (repaired.ok && repaired.skipped.length > 0) {
          chosen = { candidate, replay: repaired, repaired };
          break;
        }
        if (!firstFailure || candidate.sans.length > firstFailure.candidate.sans.length) {
          firstFailure = { candidate, replay };
        }
      }
      if (chosen) historyOnly = true;
    }

    // Fallback list for the degraded paths (side-to-move parity, fullmove):
    // the chosen list, else the most complete replay we saw, else the first
    // readable list, else "absent".
    const history =
      chosen?.candidate ??
      bestDisagreement?.candidate ??
      firstFailure?.candidate ??
      historyCandidates
        .filter((candidate) => Array.isArray(candidate.sans))
        .sort((a, b) => b.sans.length - a.sans.length)[0] ??
      historyCandidates[0] ??
      { source: "absent", sans: null, container: null, nodeCount: null };

    // Degraded metadata: when only the DOM placement is known, side-to-move has
    // to come from elsewhere (clock indicator / history parity) and castling /
    // en-passant / move counters stay unknown.
    let sideToMove = { turn: "w", source: "default" };
    /**
     * Plies played per the best history candidate: absolute node indices when
     * available (a sliver list still reports them — M9.3), else token count.
     */
    const playedPlies = () => {
      if (typeof history.lastPly === "number") return history.lastPly;
      if (Array.isArray(history.sans)) return history.sans.length;
      return null;
    };
    const inferSideToMove = () => {
      const fromClock = detectSideToMoveFromClock();
      if (fromClock) return fromClock;
      const fromHighlight = detectSideToMoveFromHighlight(board.el, modules);
      if (fromHighlight) return fromHighlight;
      const plies = playedPlies();
      if (plies !== null) {
        return {
          turn: modules.history.sideToMoveFromPly(plies),
          source: typeof history.lastPly === "number" ? "history-ply" : "history-parity",
        };
      }
      return { turn: "w", source: "default" };
    };
    const degradedFen = () => {
      if (position.fen) return position.fen; // board-exposed FEN is exact
      if (boardState.fen) return boardState.fen;
      sideToMove = inferSideToMove();
      if (sideToMove.source === "default") {
        warnings.push("side to move unknown (no move list, no active-clock marker) — assuming white");
      } else {
        warnings.push(`side to move inferred from ${sideToMove.source}; castling/en-passant/move counters unknown`);
      }
      const fullmove = modules.history.fullmoveFromPly(playedPlies() ?? 0);
      return modules.history.buildFen({ board: positionField ?? "8/8/8/8/8/8/8/8", turn: sideToMove.turn, fullmove });
    };

    let fen = null;
    let movesUci = [];
    let historyStatus;
    let positionSource = historyOnly ? "move-list-replay" : position.strategy;

    if (chosen) {
      anchorTracking(chosen.replay.fen, chosen.replay.movesUci);
      if (historyOnly) {
        warnings.push("board position could not be read from the DOM — using the move-list replay (history) only");
      }
      if (chosen.repaired && chosen.repaired.skipped.length > 0) {
        const shown = chosen.repaired.skipped
          .map((entry) => `"${entry.san}" (position ${Number(entry.index) + 1})`)
          .join(", ");
        warnings.push(
          `move list contained ${chosen.repaired.skipped.length} unreadable token(s) — skipped ${shown}; ` +
            "the position was verified against the board",
        );
      }
      fen = chosen.replay.fen;
      movesUci = chosen.replay.movesUci;
      historyStatus = chosen.replay.sans.length > 0 ? "replayed" : "startpos";
    } else if (positionField && bestDisagreement) {
      mismatch.value = {
        kind: "board-history-disagreement",
        boardField: positionField,
        replayField: modules.history.fenBoardField(bestDisagreement.replay.fen),
        boardFen: position.fen ?? null,
        replayFen: bestDisagreement.replay.fen,
        sanCount: bestDisagreement.candidate.sans.length,
        container: bestDisagreement.candidate.container,
        note: "board is the source of truth; the move-list history was dropped for this update",
      };
      fen = degradedFen();
      historyStatus = "dropped";
    } else if (positionField && firstFailure) {
      const failedAt = firstFailure.replay.failedAt;
      const failedToken =
        Array.isArray(firstFailure.candidate.sans) && Number.isInteger(failedAt) && failedAt > 0
          ? firstFailure.candidate.sans[failedAt - 1] ?? null
          : null;
      mismatch.value = {
        kind: "history-unreliable",
        reason: firstFailure.replay.error,
        failedAt: failedAt ?? null,
        failedToken,
        sanCount: firstFailure.candidate.sans.length,
        container: firstFailure.candidate.container,
        note: "board is the source of truth; the move-list history was dropped for this update",
      };
      fen = degradedFen();
      historyStatus = "unreliable";
    } else if (firstFailure) {
      mismatch.value = {
        kind: "history-unreliable",
        reason: firstFailure.replay.error,
        failedAt: firstFailure.replay.failedAt ?? null,
        sanCount: firstFailure.candidate.sans?.length ?? null,
        container: firstFailure.candidate.container,
      };
      historyStatus = "unreliable";
    } else if (positionField) {
      fen = degradedFen();
      historyStatus = "absent";
    }

    // M9.2: whenever no candidate reconciled but the board itself is readable,
    // follow the game by diffing placements. This keeps the turn exact and the
    // pipeline live (suggestions/premove/commentary work from the tracked FEN)
    // even when chess.com renders only a sliver of the move list (long games).
    if (!chosen && positionField) {
      const trackedState = continueTracking(
        modules,
        positionField,
        position.fen ?? boardState.fen ?? null,
        sideToMove.turn,
        modules.history.fullmoveFromPly(playedPlies() ?? 0),
      );
      if (trackedState) {
        const trackedTurn = modules.history.fenFields(trackedState.fen).turn;
        const seeded = trackedState.moves === 0;
        fen = trackedState.fen;
        sideToMove =
          seeded && sideToMove.source !== "default"
            ? { turn: trackedTurn, source: sideToMove.source }
            : { turn: trackedTurn, source: "board-tracking" };
        historyStatus = "tracked";
        const staleSideWarning = warnings.findIndex((entry) => entry.startsWith("side to move inferred from"));
        if (staleSideWarning >= 0) warnings.splice(staleSideWarning, 1);
        warnings.push(
          "move list unreliable here — tracking moves from the board (suggestions stay live; Maia history planes unavailable)",
        );
      }
    }

    if (!fen) {
      return {
        ok: false,
        reason: "board found but neither its position nor a move list could be read",
        boardId: board.el.id || null,
        boardRect,
        strategyLog: position.attempts,
        ...base,
      };
    }

    const userColor = detectUserColor(boardState, warnings);
    const flippedInfo = detectFlipped(board.el, boardState, warnings);

    // M9: one line pointing at the fast-fix protocol whenever anything degraded
    // (repeated warnings on a real game mean the markup changed — a recorded
    // snapshot makes the failure reproducible and replay-provable).
    if (warnings.length > 0) {
      warnings.push(
        "seeing these repeatedly? fast-fix protocol: press “Record chess.com snapshot” in the panel, " +
          "drop the JSON into test/fixtures/chesscom-snapshots/ and replay it (test/fixtures/chesscom/README.md)",
      );
    }

    // New game / reset detection: move list went back to the start, or the URL
    // changed (SPA navigation) — a fresh session for downstream consumers.
    const previous = runtime.lastState;
    let resetDetected = false;
    if (previous?.ok) {
      if (previous.gameUrl !== location.href) {
        runtime.sessionSeq += 1;
        runtime.tracking = null;
      } else if (previous.movesUci.length > 0 && movesUci.length === 0 && historyStatus === "startpos") {
        resetDetected = true;
        runtime.sessionSeq += 1;
        runtime.tracking = null;
      }
    }

    const fields = modules.history.fenFields(fen);
    return {
      ok: true,
      fen,
      movesUci,
      userColor: userColor.color,
      flipped: flippedInfo.flipped,
      boardRect,
      devicePixelRatio: window.devicePixelRatio,
      gameUrl: location.href,
      gameId: modules.boardDom.gameIdFromUrl(location.href),
      ts: new Date().toISOString(),
      ...(mismatch.value ? { mismatch: mismatch.value } : {}),
      boardId: board.el.id || null,
      boardTag: board.el.tagName.toLowerCase(),
      boardInViewport: board.inViewport,
      turn: fields.turn,
      moveCount: movesUci.length,
      moveListCount: history.sans ? history.sans.length : null,
      positionSource,
      historySource: historyStatus === "tracked" ? "board-tracking" : history.source,
      historyStatus,
      historyTracking: { active: historyStatus === "tracked", moves: runtime.tracking?.movesUci.length ?? 0 },
      flippedSource: flippedInfo.source,
      userColorSource: userColor.source,
      sideToMoveSource: sideToMove.source,
      boardStateAgrees,
      warnings,
      strategyLog: position.attempts,
      sessionSeq: runtime.sessionSeq,
      resetDetected,
      adapterVersion: ADAPTER_VERSION,
    };
  }

  /* ----------------------------------------------------- position reading */

  /**
   * Multiple strategies, each empirically verified by `checkPlacement`
   * (kings, pawn ranks, duplicates, piece counts). The first strategy that
   * yields a plausible position wins; `strategyLog` records every attempt.
   */
  function readPosition(boardEl, modules, boardState) {
    const attempts = [];
    const run = (name, fn) => {
      try {
        const result = fn();
        if (!result) {
          attempts.push({ strategy: name, ok: false, reason: "no pieces with readable squares" });
          return null;
        }
        if (!result.sanity.ok) {
          attempts.push({ strategy: name, ok: false, reason: `implausible position: ${result.sanity.problems.join("; ")}` });
          return null;
        }
        attempts.push({ strategy: name, ok: true, pieces: result.squares.length });
        return result;
      } catch (error) {
        attempts.push({ strategy: name, ok: false, reason: describeError(error) });
        return null;
      }
    };

    // Strategy 1 (verified primary): piece elements carrying square classes.
    const fromPieces = run("piece-square-class", () => placementFromPieceElements(boardEl, modules));
    if (fromPieces) {
      return {
        strategy: "piece-square-class",
        source: "dom-pieces",
        boardField: modules.boardDom.boardFieldFromSquares(fromPieces.squares),
        fen: null,
        attempts,
      };
    }

    // Strategy 2 (defensive): per-square containers with a piece child.
    const fromSquares = run("square-containers", () => placementFromSquareContainers(boardEl, modules));
    if (fromSquares) {
      return {
        strategy: "square-containers",
        source: "dom-pieces",
        boardField: modules.boardDom.boardFieldFromSquares(fromSquares.squares),
        fen: null,
        attempts,
      };
    }

    // Strategy 3 (fallback): state exposed by the board element itself.
    if (boardState.fen) {
      attempts.push({ strategy: "board-state-fen", ok: true, source: boardState.fenSource });
      return {
        strategy: "board-state-fen",
        source: "board-state",
        boardField: modules.history.fenBoardField(boardState.fen),
        fen: boardState.fen,
        attempts,
      };
    }
    attempts.push({ strategy: "board-state-fen", ok: false, reason: "board exposes no FEN" });

    return { strategy: null, source: null, boardField: null, fen: null, attempts };
  }

  function attributeTokens(element) {
    const tokens = [];
    for (const name of ["data-square", "square", "data-square-id"]) {
      const value = element.getAttribute?.(name);
      if (value) tokens.push(String(value), `square-${value}`);
    }
    return tokens;
  }

  function placementFromPieceElements(boardEl, modules) {
    const pieceElements = [...boardEl.querySelectorAll(".piece")];
    if (pieceElements.length < 2) return null;
    const squares = [];
    for (const element of pieceElements) {
      const tokens = [...element.classList];
      const code = modules.boardDom.pieceCodeFromTokens(tokens);
      const square = modules.boardDom.squareFromTokens(tokens) ?? modules.boardDom.squareFromTokens(attributeTokens(element));
      if (!code || !square) return null; // a piece we cannot place → do not guess
      squares.push({ code, file: square.file, rank: square.rank });
    }
    return { squares, sanity: modules.boardDom.checkPlacement(squares) };
  }

  function placementFromSquareContainers(boardEl, modules) {
    const containers = [...boardEl.querySelectorAll("[class*='square-']")].filter(
      (element) => !modules.boardDom.pieceCodeFromTokens([...element.classList]),
    );
    const squares = [];
    for (const container of containers) {
      const square = modules.boardDom.squareFromTokens([...container.classList]);
      if (!square) continue;
      const pieceElement = container.querySelector(".piece");
      if (!pieceElement) continue;
      const code =
        modules.boardDom.pieceCodeFromTokens([...pieceElement.classList]) ??
        modules.boardDom.pieceCodeFromTokens(attributeTokens(pieceElement));
      if (!code) continue;
      squares.push({ code, file: square.file, rank: square.rank });
    }
    if (squares.length < 2) return null;
    return { squares, sanity: modules.boardDom.checkPlacement(squares) };
  }

  /* -------------------------------------------- board-exposed state (fallback) */

  function readBoardState(boardEl, modules) {
    const out = { fen: null, fenSource: null, sanHistory: null, isFlipped: null, playingAs: null, errors: [] };
    try {
      const game = boardEl.game; // chess.com's own game object on <wc-chess-board>
      if (game && typeof game.getFEN === "function") {
        const fen = game.getFEN();
        if (typeof fen === "string" && modules.history.validateFen(fen).ok) {
          out.fen = fen;
          out.fenSource = "board.game.getFEN()";
        }
      }
      if (game && typeof game.getHistorySANs === "function") {
        const sans = game.getHistorySANs();
        if (Array.isArray(sans) && sans.every((san) => typeof san === "string")) out.sanHistory = sans;
      }
      if (game && typeof game.getPlayingAs === "function") {
        out.playingAs = modules.boardDom.normalizeColor(game.getPlayingAs());
      }
    } catch (error) {
      out.errors.push(`board.game: ${describeError(error)}`);
    }
    try {
      const state = boardEl.state;
      if (state && typeof state.isFlipped === "boolean") out.isFlipped = state.isFlipped;
    } catch (error) {
      out.errors.push(`board.state: ${describeError(error)}`);
    }
    if (!out.fen) {
      for (const attribute of ["fen", "data-fen"]) {
        const value = boardEl.getAttribute?.(attribute);
        if (value && modules.history.validateFen(value).ok) {
          out.fen = value;
          out.fenSource = `attribute ${attribute}`;
          break;
        }
      }
    }
    return out;
  }

  /* --------------------------------------------------------- history reading */

  /**
   * Every readable history candidate on the page, in DOM order: all move-list
   * containers (verified 2026 structure first, older variants after; duplicate
   * elements matched by several selectors are de-duplicated), then
   * chess.com's own board-exposed SAN history as the last resort. The
   * reconciliation in computeState picks the candidate that MATCHES THE BOARD —
   * the only reliable disambiguation when several lists are mounted (game
   * previews, analysis panels, stale SPA content, M9.1).
   */
  function readHistoryCandidates(modules, boardState) {
    const candidates = [];
    const seen = new Set();
    for (const selector of MOVE_LIST_SELECTORS) {
      for (const el of document.querySelectorAll(selector)) {
        if (seen.has(el)) continue;
        seen.add(el);
        const nodes = moveListNodes(el);
        const texts = nodes.length
          ? nodes.map(
              (node) => node.querySelector?.(".node-highlight-content")?.textContent ?? node.textContent ?? "",
            )
          : [el.textContent ?? ""];
        const sans = modules.history.sanTokensFromNodeTexts(texts);
        if (nodes.length > 0 || sans.length > 0) {
          const plies = nodes.map(nodePly).filter((ply) => ply !== null);
          const lastPly = plies.length > 0 ? Math.max(...plies) + 1 : null;
          candidates.push({ source: "move-list", sans, container: selector, nodeCount: nodes.length, lastPly });
        }
      }
    }
    if (boardState.sanHistory) {
      const sans = modules.history.sanTokensFromNodeTexts(boardState.sanHistory);
      if (sans.length > 0) {
        candidates.push({ source: "board-state", sans, container: null, nodeCount: sans.length, lastPly: sans.length });
      }
    }
    if (candidates.length === 0) {
      // Containers exist but nothing readable: zero moves played (or the list
      // has not rendered yet). Replaying "no moves" from the initial position
      // is the startpos — and the board reconciliation catches it if the game
      // did not actually start from there.
      const moveList = findMoveList();
      if (moveList) {
        candidates.push({ source: "move-list-empty", sans: [], container: moveList.selector, nodeCount: 0 });
      }
    }
    return candidates;
  }

  function findMoveList() {
    for (const selector of MOVE_LIST_SELECTORS) {
      for (const el of document.querySelectorAll(selector)) {
        const nodes = moveListNodes(el);
        if (nodes.length > 0) return { el, nodes, selector };
      }
    }
    for (const selector of MOVE_LIST_SELECTORS) {
      const el = document.querySelector(selector);
      if (el) return { el, nodes: [], selector };
    }
    return null;
  }

  /** Main-line move nodes in play order (timestamps excluded). */
  function moveListNodes(containerEl) {
    let nodes = [...containerEl.querySelectorAll(".node")].filter(
      (node) => !node.closest("[data-move-list-el='timestamp']"),
    );
    const mainLine = nodes.filter((node) => `${node.className}`.includes("main-line-ply"));
    if (mainLine.length > 0) nodes = mainLine;
    const plies = nodes.map(nodePly);
    if (plies.every((ply) => ply !== null)) {
      nodes = nodes
        .map((node, index) => ({ node, ply: plies[index], index }))
        .sort((a, b) => (a.ply !== b.ply ? a.ply - b.ply : a.index - b.index))
        .map((entry) => entry.node);
    }
    return nodes;
  }

  /** Ply index of a move node: data-node="line-ply" (verified) or data-ply. */
  function nodePly(node) {
    for (const attribute of ["data-node", "data-ply"]) {
      const value = node.getAttribute?.(attribute);
      if (value === null || value === undefined) continue;
      const match = /(\d+)\s*$/.exec(String(value));
      if (match) return Number(match[1]);
    }
    return null;
  }

  /* ------------------------------------------------------- flipped / color */

  function colorTokenOf(element) {
    for (const token of element?.classList ?? []) {
      const match = COLOR_CLASS.exec(token);
      if (match) return match[1];
    }
    return null;
  }

  function detectFlipped(boardEl, boardState, warnings) {
    const byClass = boardEl.classList.contains("flipped");
    if (byClass) {
      if (boardState.isFlipped === false) warnings.push("board class says flipped, board.state.isFlipped says not — using the class");
      return { flipped: true, source: "board-class" };
    }
    if (boardState.isFlipped === true) return { flipped: true, source: "board-state" };
    return { flipped: false, source: "board-class" };
  }

  /**
   * userColor = the color of the player at the BOTTOM of the board. chess.com
   * always orients your own games (bot games included) with you at the bottom,
   * so this is your color when playing; on spectator pages it is simply the
   * orientation color. Fallback order: bottom clock/color class -> board's
   * getPlayingAs() -> panel setting (storage) -> flipped inference.
   */
  function detectUserColor(boardState, warnings) {
    const setting = runtime.modules?.boardDom.normalizeColor(runtime.userColorRaw) ?? null;
    const fromDom = detectBottomColor();
    if (fromDom) {
      if (setting && setting !== fromDom.color) {
        warnings.push(`panel setting says you play ${setting} but the bottom player is ${fromDom.color}`);
      }
      return fromDom;
    }
    if (boardState.playingAs) return { color: boardState.playingAs, source: "board-state" };
    if (setting) return { color: setting, source: "panel-setting" };
    return { color: null, source: "unknown" };
  }

  function detectBottomColor() {
    const bottomSelectors = [
      "#board-layout-player-bottom",
      ".board-layout-bottom",
      ".player-row-bottom",
      ".player-bottom",
      "[class*='player-bottom']",
      "[class*='player-row-bottom']",
    ].join(", ");
    for (const container of document.querySelectorAll(bottomSelectors)) {
      const own = colorTokenOf(container);
      if (own) return { color: own, source: "player-bottom" };
      for (const clock of container.querySelectorAll(".clock-component, [class*='clock-']")) {
        const color = colorTokenOf(clock);
        if (color) return { color, source: "player-bottom-clock" };
      }
    }
    for (const clock of document.querySelectorAll(".clock-component, [class*='clock-']")) {
      const color = colorTokenOf(clock);
      if (color && [...clock.classList].some((token) => token === "clock-bottom" || token === "bottom")) {
        return { color, source: "clock-bottom" };
      }
    }
    return null;
  }

  /** Active clock marker — best-effort side-to-move fallback (move list is primary). */
  function detectSideToMoveFromClock() {
    for (const clock of document.querySelectorAll(".clock-component, [class*='clock-']")) {
      const color = colorTokenOf(clock);
      if (!color) continue;
      const active = [...clock.classList].some((token) => /active|running|turn|ticking/.test(token));
      if (active) return { turn: color === "white" ? "w" : "b", source: "active-clock" };
    }
    return null;
  }

  /**
   * Side to move from the last-move highlight (M9.2). chess.com marks the last
   * move's from/to squares with highlight elements that carry `square-XX`
   * classes (verified markup; see the fixtures). The DESTINATION square holds
   * the piece that just moved (a capture leaves the mover's piece there), so
   * exactly one piece colour on the highlighted squares → the other side moves.
   * This keeps the turn correct in long games where the move list is unusable.
   */
  function detectSideToMoveFromHighlight(boardEl, modules) {
    try {
      const marked = new Set();
      for (const el of boardEl.querySelectorAll("[class*='highlight']")) {
        const square = modules.boardDom.squareFromTokens([...el.classList]);
        if (square) marked.add(modules.boardDom.squareName(square.file, square.rank));
      }
      if (marked.size === 0) return null;
      const colors = [];
      for (const piece of boardEl.querySelectorAll(".piece")) {
        const square = modules.boardDom.squareFromTokens([...piece.classList]);
        if (!square) continue;
        if (!marked.has(modules.boardDom.squareName(square.file, square.rank))) continue;
        const code = modules.boardDom.pieceCodeFromTokens([...piece.classList]);
        if (!code) continue;
        colors.push(code === code.toUpperCase() ? "white" : "black");
      }
      const turn = modules.history.turnFromHighlightPieces(colors);
      return turn ? { turn, source: "highlight" } : null;
    } catch {
      return null;
    }
  }

  /* ------------------------------------------------------- board tracking */

  /**
   * Seed FEN for board-diff tracking (M9.2): exact when a board-exposed FEN is
   * available, otherwise board placement + the inferred side to move + the
   * castling-rights heuristic (counters are cosmetic; clients send this FEN
   * alone or replay tracked UCI on top of it).
   */
  function seedTrackingFen(exactFen, positionField, modules, fallbackTurn = "w", fallbackFullmove = "1") {
    if (exactFen) return exactFen;
    const turn = fallbackTurn === "b" ? "b" : "w";
    return modules.history.buildFen({
      board: positionField,
      turn,
      castling: modules.history.seedCastlingRights(positionField),
      fullmove: fallbackFullmove,
    });
  }

  /**
   * Follow the game by diffing board placements (M9.2). Anchored exactly
   * whenever a reconciled history / board-exposed FEN exists; otherwise seeded
   * from placement + the side-to-move ladder, then advanced one legal move at a
   * time (the unique move whose result equals the observed board). Castling /
   * en-passant surprises against a heuristic seed re-seed the tracker at the
   * observed position — the turn stays correct via the highlight ladder.
   */
  function continueTracking(modules, positionField, exactFen, fallbackTurn = "w", fallbackFullmove = "1") {
    let tracking = runtime.tracking;
    if (!tracking?.fen) {
      tracking = { fen: seedTrackingFen(exactFen, positionField, modules, fallbackTurn, fallbackFullmove), movesUci: [] };
    } else if (modules.history.fenBoardField(tracking.fen) !== positionField) {
      const matches = modules.history.findMovesToBoardField(tracking.fen, positionField);
      if (matches && matches.length === 1) {
        const applied = modules.history.applyUciToFen(tracking.fen, matches[0]);
        if (applied.ok) {
          tracking.fen = applied.fen;
          tracking.movesUci.push(applied.move);
          if (tracking.movesUci.length > 400) {
            tracking.movesUci.splice(0, tracking.movesUci.length - 400);
          }
        } else {
          tracking = { fen: seedTrackingFen(exactFen, positionField, modules, fallbackTurn, fallbackFullmove), movesUci: [] };
        }
      } else {
        tracking = { fen: seedTrackingFen(exactFen, positionField, modules, fallbackTurn, fallbackFullmove), movesUci: [] };
      }
    }
    runtime.tracking = tracking;
    return { fen: tracking.fen, moves: tracking.movesUci.length };
  }

  /** Anchor the tracker on an exact position + its full UCI history. */
  function anchorTracking(fen, movesUci) {
    runtime.tracking = { fen, movesUci: [...movesUci] };
  }

  /* -------------------------------------------------------------- snapshot */

  function buildSnapshot(state) {
    const locate = runtime.modules?.boardLocate ?? null;
    const board = locate ? locate.findBoardElement() : null;
    const moveList = findMoveList();
    const players = {
      top: { color: colorFromPlayerArea("top") },
      bottom: { color: colorFromPlayerArea("bottom") },
    };
    const playerAreaHtml = [
      document.querySelector(
        "#board-layout-player-top, .board-layout-top, .player-row-top, [class*='player-top']",
      ),
      document.querySelector(
        "#board-layout-player-bottom, .board-layout-bottom, .player-row-bottom, [class*='player-bottom']",
      ),
    ]
      .filter(Boolean)
      .map((element) => element.outerHTML)
      .join("\n");
    return {
      schema: "humanplay.chesscom.snapshot/1",
      recordedAt: new Date().toISOString(),
      adapterVersion: ADAPTER_VERSION,
      pageUrl: location.href,
      pageTitle: document.title,
      board: board
        ? { id: board.el.id || null, tag: board.el.tagName.toLowerCase(), rect: locate.rectOf(board.el) }
        : null,
      devicePixelRatio: window.devicePixelRatio,
      state,
      players,
      boardOuterHTML: board ? sanitizeHtml(board.el.outerHTML) : null,
      moveListOuterHTML: moveList ? sanitizeHtml(moveList.el.outerHTML) : null,
      playersOuterHTML: playerAreaHtml ? sanitizeHtml(playerAreaHtml) : null,
      sanitization: {
        usernames: "replaced with 'user'",
        userUploadUrls: "removed",
        memberLinks: "neutralised",
      },
    };
  }

  function colorFromPlayerArea(side) {
    const container = document.querySelector(
      side === "top"
        ? "#board-layout-player-top, .board-layout-top, .player-row-top, [class*='player-top']"
        : "#board-layout-player-bottom, .board-layout-bottom, .player-row-bottom, [class*='player-bottom']",
    );
    if (!container) return null;
    const own = colorTokenOf(container);
    if (own) return own;
    for (const clock of container.querySelectorAll(".clock-component, [class*='clock-']")) {
      const color = colorTokenOf(clock);
      if (color) return color;
    }
    return null;
  }

  /**
   * Serialize DOM markup without user-identifying data: usernames become
   * "user", member links are neutralised and URLs pointing at user uploads
   * (avatars) are stripped. Used by the snapshot recorder only — the live page
   * is never modified.
   */
  function sanitizeHtml(html) {
    const template = document.createElement("template");
    template.innerHTML = html;
    const root = template.content;

    for (const element of root.querySelectorAll(USERNAME_SELECTORS)) {
      element.textContent = "user";
      element.removeAttribute("title");
      element.removeAttribute("aria-label");
      element.removeAttribute("href");
    }
    for (const element of root.querySelectorAll("a[href*='/member/'], a[href*='/user/']")) {
      element.setAttribute("href", "#");
    }
    for (const element of root.querySelectorAll("*")) {
      for (const attribute of [...element.attributes]) {
        const value = attribute.value ?? "";
        if (value.includes("uploads/v1/user/") || value.includes("/member/")) {
          if (attribute.name === "href") element.setAttribute("href", "#");
          else if (attribute.name === "src") element.setAttribute("src", "about:blank");
          else element.removeAttribute(attribute.name);
        }
      }
    }
    return [...root.childNodes].map((node) => ("outerHTML" in node ? node.outerHTML : "")).join("");
  }

  /* ---------------------------------------------------------------- helpers */

  function stateSignature(state) {
    if (!state?.ok) return JSON.stringify([state?.ok, state?.reason, state?.boardId]);
    const rect = state.boardRect;
    return JSON.stringify([
      state.ok,
      state.fen,
      state.movesUci.length,
      state.movesUci.join(","),
      state.userColor,
      state.flipped,
      state.boardId,
      [rect?.x, rect?.y, rect?.w, rect?.h].map((value) => (typeof value === "number" ? Math.round(value * 100) / 100 : value)),
      state.mismatch?.kind ?? null,
      state.historyStatus,
      state.positionSource,
      state.sessionSeq,
    ]);
  }

  function describeError(error) {
    return error?.message ?? String(error);
  }

  function fileTimestamp(date) {
    const pad = (value) => String(value).padStart(2, "0");
    return (
      `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}` +
      `-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
    );
  }

  // Debug aid used by the proof harness and the panel ("which strategy won?").
  console.debug(`[humanplay] chess.com adapter ${ADAPTER_VERSION} loaded (${location.href})`);
}

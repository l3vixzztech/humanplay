/**
 * humanplay — board arrow overlay (Milestone 5, extended in M7)
 * =============================================================
 *
 * Content script that paints the suggested move ON the real chess.com board:
 * one full-viewport, click-transparent `<canvas>` added to `document.body`,
 * holding solid arrows for the top-1 suggestion and (when the panel enables
 * them) thinner alternatives.
 *
 * M7 adds a second, independent arrow set: the **premove** — the reply the
 * planner decided is safe to queue while the opponent thinks — drawn as a
 * **dashed** arrow in the premove blue via the very same geometry
 * (`overlay-geometry.js`) and canvas.
 *
 * Pipeline (M5/M7, locked):
 *
 *   panel  --runtime.sendMessage-->  service worker  --tabs.sendMessage-->
 *        this content script:  {type:"humanplay:suggestion", moves, topN, key}
 *                              {type:"humanplay:clear-suggestion", reason, key}
 *                              {type:"humanplay:premove", move, key}
 *                              {type:"humanplay:clear-premove", reason, key}
 *
 * The panel owns the policy (assistant toggle, gating, stale guard, the overlay
 * settings); this script is a **dumb renderer**: it draws exactly the arrows it
 * is told to draw, or clears. It never analyses, never talks to the server and
 * never reads `chrome.storage`.
 *
 * Anchoring: geometry is recomputed from the LIVE board element
 * (`board-locate.js` — the very same board-picking code the M3 adapter uses,
 * shared, not duplicated) at:
 *
 *   - every suggestion/clear message,
 *   - every new GameState (the adapter in the same isolated world calls
 *     `globalThis.__humanplayContentHook`),
 *   - window resize + scroll (passive listeners),
 *   - a ResizeObserver on the board element,
 *   - a best-effort re-attach window when the board element disappears
 *     (SPA navigation) while arrows are pending.
 *
 * No rAF loop: rendering happens on demand only.
 *
 * Staleness: the overlay remembers the GameState signature (fen, UCI history,
 * session, board, orientation) at the moment it accepted a suggestion; when a
 * *different* position arrives, the arrows are cleared immediately — the panel
 * then re-sends the new suggestion when its (cache/dedupe/stale-guarded)
 * analysis resolves. So out-of-date arrows cannot survive a position change
 * even if the panel goes away mid-game.
 *
 * Test hook (read-only, like the adapter's console lines): the drawn snapshot
 * is mirrored to `globalThis.__humanplayOverlay` and to
 * `canvas.dataset.humanplay` (JSON) so the CDP proof can assert exact
 * endpoints, and to `console.debug` lines.
 */

// Content scripts injected by ONE manifest entry share the same isolated
// world global scope: a top-level `const` name that also exists in
// chesscom-adapter.js (e.g. `moduleUrls`) is a fatal SyntaxError. Everything
// therefore lives in an IIFE — the only shared globals are the intentional
// `__humanplayOverlay` / `__humanplayContentHook` hooks.
(() => {
  const OVERLAY_VERSION = "m7.0";
  const MSG_SUGGESTION = "humanplay:suggestion";
  const MSG_CLEAR_SUGGESTION = "humanplay:clear-suggestion";
  const MSG_PREMOVE = "humanplay:premove";
  const MSG_CLEAR_PREMOVE = "humanplay:clear-premove";
  const CANVAS_ID = "humanplay-overlay-canvas";
  const RENDER_DEBOUNCE_MS = 80;
  const REDRAW_RETRY_MS = 700;
  const REDRAW_RETRY_LIMIT = 5;
  /**
   * Never paint on a thumbnail. chess.com pages can contain small preview
   * boards (`wc-chess-board.board-preview`); if the real board disappears for a
   * moment (SPA navigation) those become the "largest" board and an arrow on a
   * 160 px thumbnail is noise, not help. Real play areas are ≥ 300 px.
   */
  const MIN_OVERLAY_SQUARE_PX = 24;

  /** Readable on both light and dark chess.com boards (dark outline + vivid fill). */
  const COLORS = Object.freeze({
    primary: { fill: "rgba(255, 176, 32, 0.95)", border: "rgba(26, 20, 8, 0.88)" },
    alternative: { fill: "rgba(76, 160, 255, 0.60)", border: "rgba(8, 18, 34, 0.55)" },
    /** M7 premove: a distinct blue, drawn with a dashed shaft. */
    premove: { fill: "rgba(64, 150, 255, 0.95)", border: "rgba(6, 16, 34, 0.85)" },
    highlightFill: "rgba(255, 176, 32, 0.14)",
    highlightStroke: "rgba(255, 176, 32, 0.32)",
  });

  /** Dash pattern for the premove shaft (CSS px, scaled by nothing — intentional). */
  const PREMOVE_DASH = [10, 7];

  const moduleUrls = {
    geometry: chrome.runtime.getURL("src/content/overlay-geometry.js"),
    boardLocate: chrome.runtime.getURL("src/content/board-locate.js"),
  };

  if (window.top === window.self) {
    start();
  }

  function start() {
    const state = {
      modules: null,
      modulesError: null,
      /** the accepted suggestion: [{uci, san, prob}], topN, key */
      moves: [],
      topN: 0,
      key: null,
      /** the accepted premove (M7): {uci, san, key} or null */
      premove: null,
      /** GameState signature at the time a suggestion/premove was accepted */
      shownSignature: null,
      /** latest GameState signature seen (from the adapter hook) */
      lastStateSignature: null,
      canvas: null,
      canvasZ: null,
      observedBoard: null,
      resizeObserver: null,
      renderTimer: null,
      retryCount: 0,
      retryTimer: null,
      pendingRedraw: false,
      lastArrows: [],
      lastBoardRect: null,
      lastFlipped: false,
      renderCount: 0,
      clearCount: 0,
      lastReason: null,
      lastClearReason: null,
      lastRenderAtEpochMs: null,
    };

    /** Read-only mirror for test/tools/overlay-proof.mjs (never read back here). */
    const debug = {
      version: OVERLAY_VERSION,
      active: false,
      state: "idle",
      reason: null,
      clearReason: null,
      key: null,
      topN: 0,
      moves: [],
      premove: null,
      arrows: [],
      boardRect: null,
      flipped: false,
      dpr: null,
      viewport: null,
      canvas: null,
      renderCount: 0,
      clearCount: 0,
      lastRenderAtEpochMs: null,
    };
    globalThis.__humanplayOverlay = debug;

    chrome.runtime.onMessage.addListener(onRuntimeMessage);
    window.addEventListener("resize", () => scheduleRender("resize"), { passive: true });
    window.addEventListener("scroll", () => scheduleRender("scroll"), { passive: true, capture: true });

    // The adapter publishes its freshest GameState in this isolated world; every
    // broadcast (a *changed* state only) re-anchors the arrows.
    globalThis.__humanplayContentHook = (gameState) => onGameState(gameState);
    if (globalThis.__humanplayAdapterState) onGameState(globalThis.__humanplayAdapterState);

    /* ----------------------------------------------------------- messaging */

    function onRuntimeMessage(message, sender, sendResponse) {
      if (message?.type === MSG_SUGGESTION) {
        const moves = (Array.isArray(message.moves) ? message.moves : []).filter(
          (move) => move && typeof move.uci === "string",
        );
        show({
          moves,
          topN: Number.isFinite(message.topN) ? message.topN : moves.length,
          key: typeof message.key === "string" ? message.key : null,
        });
        // `drawn` lags on the very first message (modules/geometry load async);
        // `accepted` is the synchronous fact the service worker can report.
        if (typeof sendResponse === "function") {
          sendResponse({ ok: true, accepted: moves.length, topN: state.topN, key: state.key });
        }
        return undefined;
      }
      if (message?.type === MSG_CLEAR_SUGGESTION) {
        clearSuggestion(`panel:${message.reason ?? "clear"}`);
        if (typeof sendResponse === "function") sendResponse({ ok: true, cleared: true });
        return undefined;
      }
      if (message?.type === MSG_PREMOVE) {
        const move = message.move && typeof message.move.uci === "string" ? message.move : null;
        if (!move) {
          clearPremove("panel:premove-without-move");
          if (typeof sendResponse === "function") sendResponse({ ok: true, accepted: 0 });
          return undefined;
        }
        showPremove({
          move: { uci: move.uci, san: typeof move.san === "string" ? move.san : null },
          key: typeof message.key === "string" ? message.key : null,
        });
        if (typeof sendResponse === "function") {
          sendResponse({ ok: true, accepted: 1, uci: state.premove?.uci ?? null, key: state.premove?.key ?? null });
        }
        return undefined;
      }
      if (message?.type === MSG_CLEAR_PREMOVE) {
        clearPremove(`panel:${message.reason ?? "clear"}`);
        if (typeof sendResponse === "function") sendResponse({ ok: true, cleared: true });
        return undefined;
      }
      return undefined;
    }

    function show({ moves, topN, key }) {
      state.moves = moves;
      state.topN = Math.max(0, Math.floor(topN));
      state.key = key;
      // Accept-time signature: the state on the board when the panel produced
      // this suggestion (the hook fires before the panel, so this is that state).
      state.shownSignature = state.lastStateSignature;
      state.retryCount = 0;
      state.pendingRedraw = moves.length > 0 || state.premove !== null;
      log(`suggestion key=${key ?? "-"} moves=${moves.length} topN=${state.topN}`);
      render("suggestion");
    }

    function showPremove({ move, key }) {
      state.premove = { uci: move.uci, san: move.san ?? null, key };
      state.shownSignature = state.lastStateSignature;
      state.retryCount = 0;
      state.pendingRedraw = true;
      log(`premove key=${key ?? "-"} uci=${move.uci}`);
      render("premove");
    }

    function anyPending() {
      return state.moves.length > 0 || state.premove !== null;
    }

    function clearSuggestion(reason) {
      state.moves = [];
      state.topN = 0;
      state.key = null;
      if (state.premove === null) clearAll(reason);
      else render(`suggestion-cleared:${reason}`);
    }

    function clearPremove(reason) {
      state.premove = null;
      if (state.moves.length === 0) clearAll(reason);
      else render(`premove-cleared:${reason}`);
    }

    function clearAll(reason) {
      state.moves = [];
      state.topN = 0;
      state.key = null;
      state.premove = null;
      state.shownSignature = null;
      state.pendingRedraw = false;
      state.lastArrows = [];
      cancelRetry();
      state.clearCount += 1;
      state.lastClearReason = reason;
      // Create the (hidden) canvas even on a pure clear so the "no arrows"
      // state is objectively inspectable (display:none + an empty arrow list).
      ensureCanvas();
      hideCanvas("cleared");
      publish("cleared", reason);
      log(`clear reason=${reason}`);
    }

    /* ------------------------------------------------------------ GameState */

    function onGameState(gameState) {
      if (!gameState) return;
      if (!gameState.ok) {
        // No credible board/position (SPA navigation, board gone): hide, but
        // keep suggestion/premove so a returning board can be re-anchored.
        state.lastStateSignature = null;
        state.lastArrows = [];
        state.pendingRedraw = anyPending();
        state.clearCount += 1;
        state.lastClearReason = "no-state";
        hideCanvas("no-state");
        publish("hidden", "no-state");
        scheduleRetry();
        return;
      }
      const signature = stateSignatureOf(gameState);
      if (state.lastStateSignature !== null && signature !== state.lastStateSignature && anyPending()) {
        // The position moved on: those arrows belong to the previous position.
        // (The panel re-sends the new suggestion/premove when its analysis is current.)
        state.lastStateSignature = signature;
        clearAll("position-changed");
        return;
      }
      state.lastStateSignature = signature;
      if (anyPending()) render("state");
    }

    /** Same fields the adapter uses for change detection + session/board/orientation. */
    function stateSignatureOf(gameState) {
      return JSON.stringify([
        gameState.fen ?? null,
        (gameState.movesUci ?? []).join(","),
        gameState.boardId ?? null,
        Boolean(gameState.flipped),
        gameState.sessionSeq ?? 0,
      ]);
    }

    /* -------------------------------------------------------------- render */

    function scheduleRender(reason, delay = RENDER_DEBOUNCE_MS) {
      if (state.renderTimer !== null) return;
      state.renderTimer = setTimeout(() => {
        state.renderTimer = null;
        render(reason);
      }, delay);
    }

    function cancelRetry() {
      if (state.retryTimer !== null) clearTimeout(state.retryTimer);
      state.retryTimer = null;
    }

    /** Bounded re-check while arrows are pending and the board is missing. */
    function scheduleRetry() {
      if (!anyPending() || state.retryTimer !== null) return;
      if (state.retryCount >= REDRAW_RETRY_LIMIT) return;
      state.retryCount += 1;
      state.retryTimer = setTimeout(() => {
        state.retryTimer = null;
        render("re-attach-retry");
      }, REDRAW_RETRY_MS);
    }

    async function loadModules() {
      if (state.modules) return state.modules;
      if (state.modulesError) throw state.modulesError;
      try {
        const [geometry, boardLocate] = await Promise.all([
          import(moduleUrls.geometry),
          import(moduleUrls.boardLocate),
        ]);
        state.modules = { geometry, boardLocate };
        return state.modules;
      } catch (error) {
        state.modulesError = new Error(`overlay modules could not be loaded: ${describeError(error)}`);
        throw state.modulesError;
      }
    }

    function render(reason) {
      loadModules()
        .then((modules) => renderWith(modules, reason))
        .catch((error) => log(`render failed (${reason}): ${describeError(error)}`));
    }

    function renderWith(modules, reason) {
      const locate = modules.boardLocate;
      const geometry = modules.geometry;
      const board = locate.findBoardElement();
      if (!board) {
        state.lastArrows = [];
        hideCanvas("board-missing");
        publish("hidden", "board-missing");
        scheduleRetry();
        return;
      }
      if (!anyPending()) {
        state.lastArrows = [];
        hideCanvas("idle");
        publish("idle", reason);
        return;
      }

      const rect = locate.rectOf(board.el);
      // Never draw on previews/thumbnails (see MIN_OVERLAY_SQUARE_PX): a
      // temporarily "largest" preview board must not receive game arrows.
      if (geometry.squareSize(rect) < MIN_OVERLAY_SQUARE_PX) {
        state.lastArrows = [];
        hideCanvas("board-too-small");
        publish("hidden", "board-too-small");
        scheduleRetry();
        return;
      }
      // The live board element is the source of truth for orientation (same
      // signals the adapter uses: `flipped` class, then board.state.isFlipped).
      const flipped = locate.isBoardFlipped(board.el);
      const viewport = viewportSize();
      const suggestionArrows = state.moves.length
        ? geometry.computeArrows({
            moves: state.moves,
            rect,
            flipped,
            topN: state.topN,
            viewport,
          })
        : [];
      // M7: the premove uses the very same geometry; `premove: true` marks it
      // for the dashed blue rendering.
      const premoveArrows = state.premove
        ? geometry.computeArrows({
            moves: [{ uci: state.premove.uci, san: state.premove.san }],
            rect,
            flipped,
            topN: 1,
            viewport,
          }).map((arrow) => ({ ...arrow, premove: true }))
        : [];
      const arrows = [...suggestionArrows, ...premoveArrows];
      const drawable = arrows.filter((arrow) => arrow.drawable && arrow.intersectsViewport !== false);
      if (drawable.length === 0) {
        hideCanvas("nothing-to-draw");
        publish("hidden", "nothing-to-draw");
        return;
      }

      const z = geometry.overlayZIndex(locate.stackingZIndex(board.el));
      draw(modules, arrows, { z });
      observeBoard(board.el);

      state.lastArrows = arrows;
      state.lastBoardRect = rect;
      state.lastFlipped = flipped;
      state.renderCount += 1;
      state.lastReason = reason;
      state.lastRenderAtEpochMs = Date.now();
      state.retryCount = 0;
      publish("shown", reason);
      log(
        `draw suggestion=${state.moves.length} premove=${state.premove?.uci ?? "-"} ` +
          `arrows=${drawable.length} flipped=${flipped} rect=${fmtRect(rect)} reason=${reason}`,
      );
    }

    function viewportSize() {
      return {
        w: document.documentElement.clientWidth || window.innerWidth,
        h: document.documentElement.clientHeight || window.innerHeight,
      };
    }

    /* -------------------------------------------------------------- canvas */

    function ensureCanvas() {
      if (state.canvas && state.canvas.isConnected) return state.canvas;
      let canvas = document.getElementById(CANVAS_ID);
      if (!canvas) {
        canvas = document.createElement("canvas");
        canvas.id = CANVAS_ID;
        canvas.setAttribute("aria-hidden", "true");
        (document.body ?? document.documentElement).append(canvas);
      }
      state.canvas = canvas;
      state.canvasZ = null; // force the z-index/style pass below
      return canvas;
    }

    function applyCanvasStyle(canvas, z) {
      if (state.canvasZ === z) return;
      state.canvasZ = z;
      // Full viewport, never intercepts clicks, sits above the board's stacking
      // context (board z-index + 1, at least 40) and below chess.com's modals.
      canvas.style.cssText = [
        "position: fixed",
        "left: 0",
        "top: 0",
        "width: 100%",
        "height: 100%",
        "margin: 0",
        "padding: 0",
        "border: 0",
        `z-index: ${z}`,
        "pointer-events: none",
        "display: none",
      ].join(";");
    }

    function draw(modules, arrows, { z }) {
      const canvas = ensureCanvas();
      applyCanvasStyle(canvas, z);
      const dpr = window.devicePixelRatio || 1;
      const viewport = viewportSize();
      const size = modules.geometry.deviceCanvasSize(viewport, dpr);
      if (canvas.width !== size.width) canvas.width = size.width;
      if (canvas.height !== size.height) canvas.height = size.height;
      const ctx = canvas.getContext("2d");
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, viewport.w, viewport.h);

      // Alternatives first, top-1 last, premove on top of everything (the
      // dashed blue arrow is the newest, most actionable information).
      const ordered = [...arrows].sort((a, b) => {
        if (Boolean(a.premove) !== Boolean(b.premove)) return a.premove ? 1 : -1;
        return b.rank - a.rank;
      });
      for (const arrow of ordered) {
        if (!arrow.drawable) continue;
        const palette = arrow.premove
          ? COLORS.premove
          : arrow.rank === 0
            ? COLORS.primary
            : COLORS.alternative;
        if (!arrow.premove && arrow.rank === 0) {
          // subtle from/to square highlight (centre ± half a square)
          drawSquareHighlight(ctx, arrow.fromPt, arrow.squareSize);
          drawSquareHighlight(ctx, arrow.tip, arrow.squareSize);
        }
        drawArrow(ctx, arrow, palette, { dashed: Boolean(arrow.premove) });
      }
      canvas.style.display = "block";
    }

    function drawSquareHighlight(ctx, centre, size) {
      const inset = Math.max(1, size * 0.03);
      const x = centre.x - size / 2 + inset;
      const y = centre.y - size / 2 + inset;
      const side = size - inset * 2;
      ctx.fillStyle = COLORS.highlightFill;
      ctx.fillRect(x, y, side, side);
      ctx.strokeStyle = COLORS.highlightStroke;
      ctx.lineWidth = Math.max(1, size * 0.02);
      ctx.strokeRect(x, y, side, side);
    }

    function drawArrow(ctx, arrow, palette, { dashed = false } = {}) {
      const border = Math.max(1, arrow.thickness * 0.16);
      // head polygon: outline first, then fill (always solid — the dash marks
      // the shaft, and a dashed outline would look broken)
      ctx.beginPath();
      ctx.moveTo(arrow.head[0].x, arrow.head[0].y);
      for (let index = 1; index < arrow.head.length; index += 1) ctx.lineTo(arrow.head[index].x, arrow.head[index].y);
      ctx.closePath();
      ctx.lineJoin = "round";
      ctx.lineWidth = border * 2;
      ctx.strokeStyle = palette.border;
      ctx.stroke();
      ctx.fillStyle = palette.fill;
      ctx.fill();

      // shaft: dark outline under the coloured line; the premove's shaft is
      // dashed so it reads as "queued, not played" at a glance.
      ctx.lineCap = "butt";
      ctx.setLineDash(dashed ? PREMOVE_DASH : []);
      ctx.beginPath();
      ctx.moveTo(arrow.shaft.from.x, arrow.shaft.from.y);
      ctx.lineTo(arrow.shaft.to.x, arrow.shaft.to.y);
      ctx.lineWidth = arrow.thickness + border * 2;
      ctx.strokeStyle = palette.border;
      ctx.stroke();
      ctx.lineWidth = arrow.thickness;
      ctx.strokeStyle = palette.fill;
      ctx.stroke();
      ctx.setLineDash([]);
    }

    function hideCanvas(reason) {
      const canvas = state.canvas;
      if (!canvas || !canvas.isConnected) return;
      const ctx = canvas.getContext("2d");
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      canvas.style.display = "none";
      void reason;
    }

    /* ------------------------------------------------------------ observers */

    function observeBoard(boardEl) {
      if (state.observedBoard === boardEl) return;
      state.observedBoard = boardEl;
      if (!state.resizeObserver && typeof ResizeObserver === "function") {
        state.resizeObserver = new ResizeObserver(() => scheduleRender("board-resize"));
      }
      state.resizeObserver?.disconnect();
      try {
        state.resizeObserver?.observe(boardEl);
      } catch {
        /* element may already be gone */
      }
    }

    /* -------------------------------------------------------------- debug */

    function publish(kind, reason) {
      const canvas = state.canvas;
      const dpr = window.devicePixelRatio || 1;
      const shown = kind === "shown";
      debug.state = kind;
      debug.active = shown && anyPending();
      debug.reason = reason ?? null;
      debug.clearReason = shown ? null : (reason ?? null);
      debug.key = state.key;
      debug.topN = state.topN;
      debug.moves = state.moves.map((move, index) => ({
        uci: move.uci,
        san: move.san ?? null,
        prob: Number.isFinite(move.prob) ? move.prob : null,
        rank: index,
      }));
      debug.premove = state.premove
        ? { uci: state.premove.uci, san: state.premove.san, key: state.premove.key }
        : null;
      debug.arrows = state.lastArrows.map((arrow) => ({
        uci: arrow.uci,
        rank: arrow.rank,
        style: arrow.premove ? "dashed" : "solid",
        premove: Boolean(arrow.premove),
        from: [round3(arrow.fromPt.x), round3(arrow.fromPt.y)],
        tip: [round3(arrow.tip.x), round3(arrow.tip.y)],
        thickness: round3(arrow.thickness),
        headLength: round3(arrow.headLength),
        squareSize: round3(arrow.squareSize),
        drawable: arrow.drawable,
      }));
      debug.boardRect = state.lastBoardRect;
      debug.flipped = state.lastFlipped;
      debug.dpr = dpr;
      debug.viewport = viewportSize();
      debug.renderCount = state.renderCount;
      debug.clearCount = state.clearCount;
      debug.lastRenderAtEpochMs = state.lastRenderAtEpochMs;
      debug.canvas = canvas
        ? {
            id: canvas.id,
            attached: canvas.isConnected,
            display: canvas.style.display,
            pointerEvents: canvas.style.pointerEvents || "none",
            zIndex: canvas.style.zIndex,
            width: canvas.width,
            height: canvas.height,
            cssWidth: canvas.clientWidth,
            cssHeight: canvas.clientHeight,
          }
        : null;

      if (canvas) {
        canvas.dataset.humanplay = JSON.stringify({
          state: kind,
          reason: reason ?? null,
          key: state.key,
          topN: state.topN,
          premove: debug.premove,
          flipped: state.lastFlipped,
          dpr,
          rect: state.lastBoardRect ? [round3(state.lastBoardRect.x), round3(state.lastBoardRect.y), round3(state.lastBoardRect.w), round3(state.lastBoardRect.h)] : null,
          arrows: debug.arrows,
          renderCount: state.renderCount,
          clearCount: state.clearCount,
          atEpochMs: state.lastRenderAtEpochMs,
        });
      }
    }

    /* -------------------------------------------------------------- helpers */

    function log(text) {
      console.debug(`[humanplay] overlay ${text}`);
    }

    function describeError(error) {
      return error?.message ?? String(error);
    }

    function round3(value) {
      return Number.isFinite(value) ? Math.round(value * 1000) / 1000 : null;
    }

    function fmtRect(rect) {
      return `[${[rect.x, rect.y, rect.w, rect.h].map((value) => Math.round(value)).join(",")}]`;
    }

    log(`board overlay ${OVERLAY_VERSION} loaded (${location.href})`);
  }
})();

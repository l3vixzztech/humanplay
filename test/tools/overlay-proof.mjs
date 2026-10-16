#!/usr/bin/env node
/**
 * overlay-proof.mjs — objective end-to-end proof for the M5 board arrow overlay.
 *
 * What it proves (Chrome for Testing, CDP, zero deps — same harness pattern as
 * test/tools/analyze-proof.mjs / adapter-proof.mjs):
 *
 *   STUB mode (default; spawns test/tools/fixture_server.py with the canned
 *   real-server /analyze responses):
 *
 *     1. **panel -> service worker -> content script routing**: with the
 *        assistant on, a fixture suggestion is drawn on the real board and the
 *        SW reports the exact forwarded response (tab id + drawn count);
 *     2. **canvas hygiene**: exactly one canvas added to body, `position:fixed`,
 *        `pointer-events:none`, z-index above the board's stacking context,
 *        bitmap = viewport × devicePixelRatio;
 *     3. **endpoints == DOM ground truth within ≤ 2 px** — the expected square
 *        centres are derived from the fixture's painted `.piece` elements
 *        (affine map from real DOM geometry, not from the overlay's formula),
 *        on the normal board, the FLIPPED board, after scroll and after resize;
 *     4. **the arrow is really painted**: `getImageData` on the shaft midpoint
 *        is non-transparent orange; after a clear it is fully transparent;
 *     5. **follows the position**: a DOM mutation (a move) clears the arrows of
 *        the previous position and new arrows for the new top-1 appear;
 *     6. **alternatives**: the panel toggle re-sends top-3, drawn as 2–3 arrows
 *        with the top-1 distinct (rank 0 + thicker), and toggling off returns
 *        to a single arrow;
 *     7. **clear cases**: opponent's turn, assistant off, game over and a
 *        server error all end with zero arrows;
 *     8. **multi-tab behaviour**: the suggestion goes to the tab that most
 *        recently reported a GameState (documented last-wins rule);
 *     9. **board disappears / returns** (SPA navigation): the canvas hides and
 *        is re-anchored when the board element comes back.
 *
 *   BONUS `--real-page [url]` (opt-in, best-effort, retried once): the same
 *   canvas + endpoint assertions on a REAL chess.com game page, with a
 *   suggestion routed through the real SW -> content-script path. If the page
 *   cannot be loaded (network/login), the case is recorded as `blocked` and the
 *   run continues.
 *
 * Every run loads a temporary COPY of the extension whose manifest additionally
 * matches the fixture origin (content script + web-accessible modules) — the
 * shipped manifest stays chess.com-only; every code file is hash-compared and
 * the report carries `codeIdentical`.
 *
 * Usage:
 *   node test/tools/overlay-proof.mjs --chrome <path> [--out-dir test/fixtures/captures/overlay]
 *     [--extension extension] [--real-page [url]] [--headful] [--keep-profile] [--timeout-ms 45000]
 *
 * Exit code is non-zero when any assertion fails. Writes per-case proof JSONs
 * and screenshots of every board WITH arrows (the visual evidence) into
 * test/fixtures/captures/overlay/.
 */

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const SERVER_ORIGIN = "http://127.0.0.1:8765";
const CANVAS_ID = "humanplay-overlay-canvas";
/** M3 live-evidence URL (public finished game); override with --real-page <url>. */
const DEFAULT_REAL_PAGE = "https://www.chess.com/game/live/186394589423";
const ENDPOINT_TOLERANCE_PX = 2;
const RECT_TOLERANCE_PX = 1;

/* ------------------------------------------------------------------ args */

function parseArgs(argv) {
  const args = {
    chrome: null,
    extension: path.join(REPO_ROOT, "extension"),
    outDir: path.join(REPO_ROOT, "test/fixtures/captures/overlay"),
    realPage: null,
    headful: false,
    keepProfile: false,
    timeoutMs: 45000,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const next = () => argv[++i];
    switch (flag) {
      case "--chrome": args.chrome = next(); break;
      case "--extension": args.extension = path.resolve(next()); break;
      case "--out-dir": args.outDir = path.resolve(next()); break;
      case "--real-page": {
        const candidate = argv[i + 1];
        if (candidate && !candidate.startsWith("--")) {
          args.realPage = next();
        } else {
          args.realPage = DEFAULT_REAL_PAGE;
        }
        break;
      }
      case "--headful": args.headful = true; break;
      case "--keep-profile": args.keepProfile = true; break;
      case "--timeout-ms": args.timeoutMs = Number(next()); break;
      default: throw new Error(`unknown argument: ${flag}`);
    }
  }
  if (!args.chrome) throw new Error("--chrome <path to chrome binary> is required");
  return args;
}

/* -------------------------------------------------------------- CDP client */

class CDP {
  static async connect(url) {
    const ws = new WebSocket(url);
    await new Promise((resolve, reject) => {
      ws.onopen = resolve;
      ws.onerror = () => reject(new Error(`could not open websocket ${url}`));
    });
    return new CDP(ws);
  }

  constructor(ws) {
    this.ws = ws;
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = new Map();
    ws.onmessage = (event) => this.#dispatch(JSON.parse(event.data));
    ws.onclose = () => {
      for (const { reject } of this.pending.values()) reject(new Error("CDP connection closed"));
      this.pending.clear();
    };
  }

  #dispatch(message) {
    if (message.id) {
      const entry = this.pending.get(message.id);
      if (!entry) return;
      this.pending.delete(message.id);
      if (message.error) entry.reject(new Error(`${message.error.message} [${message.error.code}]`));
      else entry.resolve(message.result);
      return;
    }
    for (const listener of this.listeners.get(message.method) ?? []) {
      try {
        listener(message.params, message.sessionId);
      } catch (error) {
        console.error(`listener for ${message.method} failed:`, error);
      }
    }
  }

  send(method, params = {}, sessionId = undefined) {
    const id = this.nextId;
    this.nextId += 1;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }

  on(method, listener) {
    if (!this.listeners.has(method)) this.listeners.set(method, []);
    this.listeners.get(method).push(listener);
  }

  close() {
    try {
      this.ws.close();
    } catch {
      /* ignore */
    }
  }
}

/* --------------------------------------------------------------- helpers */

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(description, fn, { timeoutMs = 30000, intervalMs = 100 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  for (;;) {
    try {
      const value = await fn();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    if (Date.now() > deadline) {
      throw new Error(`timeout waiting for ${description}${lastError ? ` (${lastError.message})` : ""}`);
    }
    await sleep(intervalMs);
  }
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function walkFiles(root, prefix = "") {
  const entries = await readdir(path.join(root, prefix), { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const relative = path.join(prefix, entry.name);
    if (entry.isDirectory()) files.push(...(await walkFiles(root, relative)));
    else if (entry.isFile()) files.push(relative);
  }
  return files;
}

function unpackedExtensionId(absoluteDir) {
  return [...sha256(absoluteDir).slice(0, 32)]
    .map((digit) => String.fromCharCode(97 + parseInt(digit, 16)))
    .join("");
}

/** "e2e4" -> {from:"e2", to:"e4"} (the CDP-side re-implementation, module-free). */
function uciSquares(uci) {
  return { from: String(uci).slice(0, 2), to: String(uci).slice(2, 4) };
}

function maxPointError(actual, expected) {
  return Math.max(Math.abs(actual[0] - expected.x), Math.abs(actual[1] - expected.y));
}

/** Minimal zero-dep static file server (fixture pages). */
function startStaticServer(root) {
  const mimeTypes = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".png": "image/png",
  };
  const server = createServer((request, response) => {
    (async () => {
      const url = new URL(request.url, "http://127.0.0.1");
      const relative = decodeURIComponent(url.pathname).replace(/^\/+/, "");
      const filePath = path.resolve(root, relative);
      if (!filePath.startsWith(path.resolve(root))) {
        response.writeHead(403);
        response.end("forbidden");
        return;
      }
      const data = await readFile(filePath);
      response.writeHead(200, {
        "Content-Type": mimeTypes[path.extname(filePath)] ?? "application/octet-stream",
        "Cache-Control": "no-store",
      });
      response.end(data);
    })().catch(() => {
      response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      response.end("not found");
    });
  });
  return new Promise((resolve, reject) => {
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      resolve({ server, port: server.address().port });
    });
  });
}

/**
 * Page-side helpers (installed into the main world of every fixture/real page).
 * `groundTruth` derives the square-centre map from the DOM's painted pieces —
 * deliberately independent of overlay-geometry.js — so a mapping bug in the
 * overlay cannot hide behind a shared formula.
 */
const PAGE_HELPERS = String.raw`
globalThis.__humanplayProof = {
  uciSquares(uci) { return { from: uci.slice(0, 2), to: uci.slice(2, 4) }; },
  boardStackingZ(board) {
    let z = 0;
    let el = board;
    while (el && el.nodeType === 1) {
      const style = getComputedStyle(el);
      if (style.position !== "static" && style.zIndex !== "auto") {
        const value = Number(style.zIndex);
        if (Number.isFinite(value) && value > z) z = value;
      }
      el = el.parentElement;
    }
    return z;
  },
  groundTruth(boardId, squareNames) {
    const board = document.getElementById(boardId);
    if (!board) return null;
    const rect = board.getBoundingClientRect();
    const flipped = board.classList.contains("flipped");
    const pieces = [];
    for (const el of board.querySelectorAll(".piece")) {
      const token = [...el.classList].find((cls) => /^square-[1-8][1-8]$/.test(cls));
      if (!token) continue;
      const box = el.getBoundingClientRect();
      pieces.push({
        f: Number(token[7]) - 1,
        r: Number(token[8]) - 1,
        x: box.left + box.width / 2,
        y: box.top + box.height / 2,
      });
    }
    if (pieces.length < 2) return null;
    const estimates = { x: [], y: [] };
    for (const a of pieces) {
      for (const b of pieces) {
        if (a === b) continue;
        if (a.f !== b.f) estimates.x.push({ span: Math.abs(b.f - a.f), sq: (b.x - a.x) / (b.f - a.f), base: a });
        if (a.r !== b.r) estimates.y.push({ span: Math.abs(b.r - a.r), sq: (b.y - a.y) / (b.r - a.r), base: a });
      }
    }
    const pick = (axis) => estimates[axis].sort((p, q) => q.span - p.span)[0] ?? null;
    const ex = pick("x");
    const ey = pick("y");
    if (!ex && !ey) return null;
    const base = (ex ?? ey).base;
    const sqX = ex ? Math.abs(ex.sq) : Math.abs(ey.sq);
    const sqY = ey ? Math.abs(ey.sq) : Math.abs(ex.sq);
    // chess rule under test: file grows to the right and rank grows upward on
    // a normal board; both invert when the board is flipped.
    const xDir = flipped ? -1 : 1;
    const yDir = flipped ? 1 : -1;
    const centres = {};
    for (const name of squareNames) {
      const file = name.charCodeAt(0) - 97;
      const rank = Number(name[1]) - 1;
      centres[name] = {
        x: base.x + xDir * (file - base.f) * sqX,
        y: base.y + yDir * (rank - base.r) * sqY,
      };
    }
    return {
      flipped,
      rect: { x: rect.x, y: rect.y, w: rect.width, h: rect.height },
      boardStackingZ: globalThis.__humanplayProof.boardStackingZ(board),
      sqX, sqY,
      sqFromRect: rect.width / 8,
      piecesUsed: pieces.length,
      centres,
    };
  },
  overlay(boardId) {
    const canvas = document.getElementById("humanplay-overlay-canvas");
    const board = document.getElementById(boardId);
    const out = { boardExists: !!board, canvasExists: !!canvas, canvas: null, dataset: null, boardStackingZ: null };
    if (board) {
      const rect = board.getBoundingClientRect();
      out.board = { x: rect.x, y: rect.y, w: rect.width, h: rect.height, flipped: board.classList.contains("flipped") };
      out.boardStackingZ = globalThis.__humanplayProof.boardStackingZ(board);
    }
    if (!canvas) return out;
    const style = getComputedStyle(canvas);
    out.canvas = {
      display: style.display,
      position: style.position,
      pointerEvents: style.pointerEvents,
      visibility: style.visibility,
      zIndex: style.zIndex === "auto" ? null : Number(style.zIndex),
      parentIsBody: canvas.parentElement === document.body,
      ariaHidden: canvas.getAttribute("aria-hidden"),
      attached: canvas.isConnected,
      bitmapWidth: canvas.width,
      bitmapHeight: canvas.height,
      cssWidth: canvas.clientWidth,
      cssHeight: canvas.clientHeight,
      dpr: window.devicePixelRatio || 1,
      canvasCount: document.querySelectorAll("canvas").length,
      inlineZ: Number(canvas.style.zIndex) || null,
    };
    out.dataset = canvas.dataset.humanplay ? JSON.parse(canvas.dataset.humanplay) : null;
    return out;
  },
  samplePixel(x, y) {
    const canvas = document.getElementById("humanplay-overlay-canvas");
    if (!canvas) return null;
    const ctx = canvas.getContext("2d");
    const dpr = window.devicePixelRatio || 1;
    const px = Math.max(0, Math.min(canvas.width - 1, Math.round(x * dpr)));
    const py = Math.max(0, Math.min(canvas.height - 1, Math.round(y * dpr)));
    const data = ctx.getImageData(px, py, 1, 1).data;
    return [data[0], data[1], data[2], data[3]];
  },
  midShaft(arrow) {
    return { x: (arrow.from[0] + arrow.tip[0]) / 2, y: (arrow.from[1] + arrow.tip[1]) / 2 };
  },
};
true;
`;

/** DOM mutation helpers for the middlegame fixture (same as analyze-proof). */
const MUTATION_HELPERS = String.raw`
  function __humanplayMovePiece(element, from, to) {
    element.classList.remove(from);
    element.classList.add(to);
    const match = /^square-(\d)(\d)$/.exec(to);
    if (match) {
      const file = Number(match[1]) - 1;
      const rank = Number(match[2]) - 1;
      const board = element.closest("wc-chess-board");
      const flipped = board.classList.contains("flipped");
      const column = flipped ? 7 - file : file;
      const row = flipped ? rank : 7 - rank;
      element.style.left = (column * 12.5) + "%";
      element.style.top = (row * 12.5) + "%";
    }
  }
  function __humanplayMutate(mutation) {
    const board = document.getElementById("board-play-computer");
    for (const piece of mutation.pieces) {
      const element = board.querySelector(".piece." + piece.classes[0] + "." + piece.from)
        ?? board.querySelector(".piece." + piece.from + "." + piece.classes[0]);
      if (!element) throw new Error("piece not found: " + piece.classes[0] + " " + piece.from);
      __humanplayMovePiece(element, piece.from, piece.to);
    }
    __humanplaySetMoveList(mutation.sans);
    return true;
  }
  function __humanplaySetMoveList(sans) {
    const rows = [];
    for (let ply = 0; ply < sans.length; ply += 2) {
      const whole = ply / 2 + 1;
      const nodes = [];
      for (const offset of [0, 1]) {
        const index = ply + offset;
        if (index >= sans.length) continue;
        const player = offset === 0 ? "white-move" : "black-move";
        nodes.push('<div data-node="0-' + index + '" class="node ' + player + ' main-line-ply">'
          + ' <span class="node-highlight-content offset-for-annotation-icon">' + sans[index] + ' </span></div>');
      }
      rows.push('<div class="main-line-row move-list-row ' + (whole % 2 === 1 ? "light-row" : "dark-row")
        + '" data-whole-move-number="' + whole + '">' + whole + '.  ' + nodes.join("  ") + '</div>');
    }
    document.querySelector("wc-simple-move-list .timestamps-with-base-time").innerHTML = rows.join("\\n");
  }
`;

/** The middlegame history (14 plies) and its mutations (same as analyze-proof). */
const MIDDLEGAME_SANS = ["e4", "e5", "Nf3", "Nc6", "Bc4", "Bc5", "O-O", "Nf6", "d3", "d6", "Bg5", "O-O", "Bxf6", "Qxf6"];
const MIDDLEGAME_MUTATIONS = [
  {
    // 15.b1c3 15...h7h6 -> canned top-1 c3d5 (Nd5)
    sans: [...MIDDLEGAME_SANS, "Nc3", "h6"],
    pieces: [
      { classes: ["wn"], from: "square-21", to: "square-33" },
      { classes: ["bp"], from: "square-87", to: "square-86" },
    ],
  },
];

/* ------------------------------------------------------------------ main */

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const sourceExtensionDir = path.resolve(args.extension);
  const summary = {
    tool: "overlay-proof.mjs",
    generatedAt: new Date().toISOString(),
    chrome: args.chrome,
    extension: sourceExtensionDir,
    checks: {},
    cases: {},
    failures: [],
    console: {},
  };
  let chromeProcess = null;
  let cdp = null;
  let profileDir = null;
  let variantDir = null;
  let staticServer = null;
  let fixtureServerProcess = null;
  let fixtureServerLog = "";
  const logs = { panel: [], serviceWorker: [], pages: [] };
  const sessionRole = new Map();

  const fail = (message, caseName = null) => {
    summary.failures.push(caseName ? `${caseName}: ${message}` : message);
    console.error(`FAIL ${caseName ? `${caseName}: ` : ""}${message}`);
  };

  const openTargets = new Set();
  const closeTarget = async (targetId) => {
    openTargets.delete(targetId);
    try {
      await cdp.send("Target.closeTarget", { targetId });
    } catch {
      /* already gone */
    }
  };

  try {
    /* ------------------------------------------------ browser fixture server */

    const { server, port } = await startStaticServer(path.join(REPO_ROOT, "test/fixtures"));
    staticServer = server;
    const origin = `http://127.0.0.1:${port}`;
    summary.checks.staticServer = { origin, root: path.join(REPO_ROOT, "test/fixtures") };

    /* --------------------------------------------------- analysis server side */

    const serverHealth = () =>
      waitFor("the local /health", async () => {
        try {
          const response = await fetch(`${SERVER_ORIGIN}/health`, { cache: "no-store" });
          return response.ok ? response.json() : null;
        } catch {
          return null;
        }
      }, { timeoutMs: 15000 });

    const existing = await serverHealth().catch(() => null);
    if (existing?.model === "fixture-static-server") {
      summary.checks.analysisServer = { mode: "stub (already running)", health: existing };
    } else if (existing) {
      throw new Error(
        `port 8765 is serving ${JSON.stringify(existing)} — the overlay proof needs the fixture stub ` +
          "(test/tools/fixture_server.py). Stop the real server first.",
      );
    } else {
      fixtureServerProcess = spawn("python3", [path.join(REPO_ROOT, "test/tools/fixture_server.py"), "--port", "8765"], {
        stdio: ["ignore", "pipe", "pipe"],
      });
      fixtureServerProcess.stdout.on("data", (chunk) => { fixtureServerLog += chunk.toString(); });
      fixtureServerProcess.stderr.on("data", (chunk) => { fixtureServerLog += chunk.toString(); });
      const health = await serverHealth();
      if (health.model !== "fixture-static-server") {
        throw new Error(`unexpected /health from the fixture server: ${JSON.stringify(health)}`);
      }
      summary.checks.analysisServer = { mode: "stub (spawned by the proof)", health, pid: fixtureServerProcess.pid };
    }
    await fetch(`${SERVER_ORIGIN}/debug/reset`, { method: "POST" });
    const setMode = (mode) =>
      fetch(`${SERVER_ORIGIN}/debug/mode`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode }),
      });
    const serverStats = async () => {
      const response = await fetch(`${SERVER_ORIGIN}/debug/stats`, { cache: "no-store" });
      return response.ok ? response.json() : null;
    };

    /* ------------------------------------------------------ manifest variant */

    const manifestPath = path.join(sourceExtensionDir, "manifest.json");
    const sourceManifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    summary.checks.manifest = {
      path: path.relative(REPO_ROOT, manifestPath),
      sha256: sha256(readFileSync(manifestPath)),
      version: sourceManifest.version,
      permissions: sourceManifest.permissions,
      host_permissions: sourceManifest.host_permissions,
      content_scripts: sourceManifest.content_scripts,
      hasAllUrls: JSON.stringify(sourceManifest).includes("<all_urls>"),
    };
    summary.checks.overlayFiles = Object.fromEntries(
      [
        "src/content/board-overlay.js",
        "src/content/overlay-geometry.js",
        "src/content/board-locate.js",
        "src/content/chesscom-adapter.js",
        "src/ui/sidepanel.js",
        "src/background/service-worker.js",
      ].map((file) => [file, sha256(readFileSync(path.join(sourceExtensionDir, file)))]),
    );

    variantDir = await mkdtemp(path.join(tmpdir(), "humanplay-overlay-variant-"));
    await cp(sourceExtensionDir, variantDir, { recursive: true });
    const variantManifestPath = path.join(variantDir, "manifest.json");
    const variantManifest = JSON.parse(readFileSync(variantManifestPath, "utf8"));
    const originMatch = `${origin}/*`;
    variantManifest.content_scripts[0].matches = [...new Set([...variantManifest.content_scripts[0].matches, originMatch])];
    variantManifest.web_accessible_resources[0].matches = [
      ...new Set([...variantManifest.web_accessible_resources[0].matches, originMatch]),
    ];
    await writeFile(variantManifestPath, `${JSON.stringify(variantManifest, null, 2)}\n`);

    const sourceFiles = (await walkFiles(sourceExtensionDir)).filter((file) => file !== "manifest.json");
    const mismatches = [];
    for (const file of sourceFiles) {
      const sourceHash = sha256(readFileSync(path.join(sourceExtensionDir, file)));
      const variantHash = sha256(readFileSync(path.join(variantDir, file)));
      if (sourceHash !== variantHash) mismatches.push(file);
    }
    summary.checks.manifestVariant = {
      enabled: true,
      addedContentScriptMatch: originMatch,
      addedWebAccessibleMatch: originMatch,
      contentScriptFiles: variantManifest.content_scripts[0].js,
      codeFilesCompared: sourceFiles.length,
      codeFileMismatches: mismatches,
      codeIdentical: mismatches.length === 0,
    };
    if (mismatches.length) throw new Error(`manifest variant differs in code files: ${mismatches.join(", ")}`);

    const extensionId = unpackedExtensionId(variantDir);
    summary.checks.extensionId = extensionId;

    /* ------------------------------------------------------------- browser */

    profileDir = await mkdtemp(path.join(tmpdir(), "humanplay-overlay-proof-"));
    const launchArgs = [
      `--user-data-dir=${profileDir}`,
      "--remote-debugging-port=0",
      `--load-extension=${variantDir}`,
      `--disable-extensions-except=${variantDir}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-gpu",
      "--disable-dev-shm-usage",
      "--disable-features=Translate,MediaRouter",
      "--window-size=1440,900",
    ];
    if (!args.headful) launchArgs.unshift("--headless=new");
    launchArgs.push("about:blank");

    chromeProcess = spawn(args.chrome, launchArgs, { stdio: ["ignore", "pipe", "pipe"] });
    let chromeStderr = "";
    chromeProcess.stderr.on("data", (chunk) => { chromeStderr += chunk.toString(); });

    const portFile = path.join(profileDir, "DevToolsActivePort");
    const devtoolsPort = await waitFor(
      "Chrome DevTools port",
      async () => {
        if (!existsSync(portFile)) return null;
        const [line] = (await readFile(portFile, "utf8")).split("\n");
        return Number(line) || null;
      },
      { timeoutMs: args.timeoutMs },
    );
    const versionInfo = await waitFor(
      "DevTools HTTP endpoint",
      async () => {
        const response = await fetch(`http://127.0.0.1:${devtoolsPort}/json/version`);
        return response.ok ? response.json() : null;
      },
      { timeoutMs: args.timeoutMs },
    );
    summary.checks.browser = { version: versionInfo.Browser, protocolVersion: versionInfo["Protocol-Version"] };

    cdp = await CDP.connect(versionInfo.webSocketDebuggerUrl);
    const targets = new Map();
    cdp.on("Target.targetCreated", ({ targetInfo }) => targets.set(targetInfo.targetId, targetInfo));
    cdp.on("Target.targetInfoChanged", ({ targetInfo }) => targets.set(targetInfo.targetId, targetInfo));
    cdp.on("Target.targetDestroyed", ({ targetId }) => targets.delete(targetId));
    await cdp.send("Target.setDiscoverTargets", { discover: true });

    cdp.on("Runtime.exceptionThrown", (params, sessionId) => {
      const details = params.exceptionDetails;
      const text = details?.exception?.description ?? details?.text ?? "exception";
      const bucket = sessionRole.get(sessionId) ?? "pages";
      logs[bucket === "panel" ? "panel" : bucket === "service-worker" ? "serviceWorker" : "pages"].push({
        bucket: "error",
        source: "javascript",
        text,
      });
    });
    cdp.on("Runtime.consoleAPICalled", (params, sessionId) => {
      const text = (params.args ?? []).map((arg) => arg.value ?? arg.description ?? arg.type).join(" ");
      const bucket = sessionRole.get(sessionId) ?? "pages";
      logs[bucket === "panel" ? "panel" : bucket === "service-worker" ? "serviceWorker" : "pages"].push({
        bucket: params.type === "error" ? "error" : params.type === "warning" ? "warning" : "info",
        source: "console",
        text,
      });
    });
    cdp.on("Log.entryAdded", ({ entry }, sessionId) => {
      const bucket = sessionRole.get(sessionId) ?? "pages";
      logs[bucket === "panel" ? "panel" : bucket === "service-worker" ? "serviceWorker" : "pages"].push({
        bucket: entry.level === "error" ? "error" : entry.level === "warning" ? "warning" : "info",
        source: entry.source,
        text: entry.text + (entry.url ? ` (${entry.url})` : ""),
      });
    });

    /* --------------------------------------------- service worker + the panel */

    const serviceWorkerPath = sourceManifest.background?.service_worker;
    const expectedWorkerUrl = `chrome-extension://${extensionId}/${serviceWorkerPath}`;
    const serviceWorker = await waitFor(
      "our extension's service worker target",
      () => [...targets.values()].find((target) => target.type === "service_worker" && target.url === expectedWorkerUrl),
      { timeoutMs: args.timeoutMs },
    );
    summary.checks.serviceWorkerUrl = serviceWorker.url;
    const swSession = (await cdp.send("Target.attachToTarget", { targetId: serviceWorker.targetId, flatten: true })).sessionId;
    sessionRole.set(swSession, "service-worker");
    await cdp.send("Runtime.enable", {}, swSession);
    await cdp.send("Log.enable", {}, swSession);

    // The worker attachment can go stale when Chrome reclaims the MV3 worker;
    // re-attach on demand (used by the real-page bonus case).
    let workerSessionId = swSession;
    const evaluateInWorker = async (expression) => {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
          const result = await cdp.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, workerSessionId);
          if (result.exceptionDetails) {
            throw new Error(`worker evaluation failed: ${result.exceptionDetails.exception?.description ?? result.exceptionDetails.text}`);
          }
          return result.result.value;
        } catch (error) {
          if (attempt === 1) throw error;
          const worker = await waitFor(
            "our extension's service worker target",
            () => [...targets.values()].find((target) => target.type === "service_worker" && target.url === expectedWorkerUrl),
            { timeoutMs: args.timeoutMs },
          );
          workerSessionId = (await cdp.send("Target.attachToTarget", { targetId: worker.targetId, flatten: true })).sessionId;
          sessionRole.set(workerSessionId, "service-worker");
          await cdp.send("Runtime.enable", {}, workerSessionId);
        }
      }
      return null;
    };

    const panelTarget = await cdp.send("Target.createTarget", {
      url: `chrome-extension://${extensionId}/src/ui/sidepanel.html`,
    });
    const panelSession = (await cdp.send("Target.attachToTarget", { targetId: panelTarget.targetId, flatten: true })).sessionId;
    sessionRole.set(panelSession, "panel");
    await cdp.send("Page.enable", {}, panelSession);
    await cdp.send("Runtime.enable", {}, panelSession);
    await cdp.send("Log.enable", {}, panelSession);

    const evaluateInPanel = async (expression) => {
      const result = await cdp.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, panelSession);
      if (result.exceptionDetails) {
        throw new Error(`panel evaluation failed: ${result.exceptionDetails.exception?.description ?? result.exceptionDetails.text}`);
      }
      return result.result.value;
    };

    await waitFor("panel module init", async () => {
      const ready = await evaluateInPanel(
        'document.readyState === "complete" && !!document.getElementById("ov-arrows") && !!globalThis.__humanplayAnalysis',
      );
      return ready === true;
    }, { timeoutMs: args.timeoutMs });

    // Raw GameState collector (which tab reported what, and when).
    await evaluateInPanel(`(() => {
      globalThis.__humanplayProof = { states: [] };
      chrome.runtime.onMessage.addListener((message, sender) => {
        if (message?.type !== "humanplay:chesscom-state") return undefined;
        globalThis.__humanplayProof.states.push({
          fen: message.state?.fen ?? null,
          ok: Boolean(message.state?.ok),
          senderTabId: sender?.tab?.id ?? null,
          senderUrl: String(sender?.tab?.url ?? ""),
          at: Date.now(),
        });
        return undefined;
      });
      return true;
    })()`);

    summary.checks.panelUi = await evaluateInPanel(`(() => {
      const arrows = document.getElementById("ov-arrows");
      const alternatives = document.getElementById("ov-alternatives");
      return {
        arrowsPresent: !!arrows,
        alternativesPresent: !!alternatives,
        arrowsDefaultChecked: arrows?.checked ?? null,
        alternativesDefaultChecked: alternatives?.checked ?? null,
        inlineScripts: [...document.scripts].filter((script) => !script.src).length,
      };
    })()`);
    if (!summary.checks.panelUi.arrowsPresent) fail("panel is missing the ov-arrows checkbox");
    if (!summary.checks.panelUi.alternativesPresent) fail("panel is missing the ov-alternatives checkbox");
    summary.checks.settingsDefaults = await evaluateInPanel(
      `chrome.storage.local.get("settings").then((stored) => stored.settings ?? null)`,
    );

    const readSuggestion = () =>
      evaluateInPanel(`(() => {
        const debug = globalThis.__humanplayAnalysis;
        const rows = [...document.querySelectorAll("#mx-moves .mx-move")].map((li) => ({
          san: li.dataset.san, uci: li.dataset.uci, prob: li.querySelector(".mx-prob")?.textContent ?? null,
          top: li.classList.contains("mx-top"),
        }));
        return {
          status: document.getElementById("mx-status").textContent,
          message: document.getElementById("mx-message").hidden ? null : document.getElementById("mx-message").textContent,
          rows,
          gate: debug.gate,
          debugStatus: debug.status,
          currentKey: debug.currentKey,
          lastRenderKey: debug.lastRenderKey,
          lastResult: debug.lastResult,
          staleDiscardCount: debug.staleDiscardCount,
          overlayPolicy: {
            showArrows: debug.overlay.showArrows,
            showAlternatives: debug.overlay.showAlternatives,
            sentMode: debug.overlay.sentMode,
            sentKey: debug.overlay.sentKey,
            lastClearReason: debug.overlay.lastClearReason,
            messageCount: debug.overlay.messageCount,
            lastMessage: debug.overlay.lastMessage,
            lastResponse: debug.overlay.lastResponse,
            lastError: debug.overlay.lastError,
          },
        };
      })()`);

    const waitForSuggestion = (predicate, description, timeoutMs = args.timeoutMs) =>
      waitFor(description, async () => {
        const suggestion = await readSuggestion();
        return predicate(suggestion) ? suggestion : null;
      }, { timeoutMs, intervalMs: 60 });

    const panelScreenshot = async (name) => {
      await cdp.send("Emulation.setDeviceMetricsOverride", { width: 400, height: 950, deviceScaleFactor: 2, mobile: false }, panelSession);
      await sleep(250);
      const shot = await cdp.send("Page.captureScreenshot", { format: "png" }, panelSession);
      await cdp.send("Emulation.clearDeviceMetricsOverride", {}, panelSession);
      const target = path.join(args.outDir, name);
      await writeFile(target, Buffer.from(shot.data, "base64"));
      return path.relative(REPO_ROOT, target);
    };

    const openFixture = async (file) => {
      const target = await cdp.send("Target.createTarget", { url: `${origin}/chesscom/${file}` });
      openTargets.add(target.targetId);
      const session = (await cdp.send("Target.attachToTarget", { targetId: target.targetId, flatten: true })).sessionId;
      sessionRole.set(session, "page");
      await cdp.send("Page.enable", {}, session);
      await cdp.send("Runtime.enable", {}, session);
      await cdp.send("Log.enable", {}, session);
      await waitFor(`${file} load`, async () => {
        const result = await cdp.send("Runtime.evaluate", { expression: 'document.readyState === "complete"', returnByValue: true }, session);
        return result.result.value === true;
      }, { timeoutMs: args.timeoutMs });
      await evaluateInPage(session, PAGE_HELPERS);
      await cdp.send("Target.activateTarget", { targetId: target.targetId });
      return { targetId: target.targetId, session, url: `${origin}/chesscom/${file}` };
    };

    const evaluateInPage = async (session, expression) => {
      const result = await cdp.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, session);
      if (result.exceptionDetails) {
        throw new Error(`page evaluation failed: ${result.exceptionDetails.exception?.description ?? result.exceptionDetails.text}`);
      }
      return result.result.value;
    };

    /** Activate a fixture tab and make the panel re-read its state (Refresh state). */
    const refreshPanelState = async (targetId, expectedFen, description) => {
      await cdp.send("Target.activateTarget", { targetId });
      await evaluateInPanel('document.getElementById("cc-refresh").click(), true');
      await waitFor(`panel state ${description}`, async () => {
        const fen = await evaluateInPanel('document.getElementById("cc-fen").textContent');
        return fen === expectedFen;
      }, { timeoutMs: args.timeoutMs });
    };

    const pageScreenshot = async (session, name) => {
      const shot = await cdp.send("Page.captureScreenshot", { format: "png" }, session);
      const target = path.join(args.outDir, name);
      await writeFile(target, Buffer.from(shot.data, "base64"));
      return path.relative(REPO_ROOT, target);
    };

    const readOverlay = (session, boardId) =>
      evaluateInPage(session, `globalThis.__humanplayProof.overlay(${JSON.stringify(boardId)})`);

    const readGroundTruth = (session, boardId, squares) =>
      evaluateInPage(session, `globalThis.__humanplayProof.groundTruth(${JSON.stringify(boardId)}, ${JSON.stringify(squares)})`);

    const samplePixel = (session, point) =>
      evaluateInPage(session, `globalThis.__humanplayProof.samplePixel(${point.x}, ${point.y})`);

    /**
     * M7 note: while the opponent thinks the canvas may ALSO carry the dashed
     * PREMOVE arrow (`arrow.premove === true`, drawn by the M7 planner — proven
     * in test/tools/premove-proof.mjs). The M5 assertions below are about the
     * *suggestion* arrows, so every count/iteration filters the premove out.
     */
    const suggestionArrows = (dataset) => (dataset?.arrows ?? []).filter((arrow) => arrow.premove !== true);

    /** Wait until the overlay has drawn `expected` suggestion arrows (optionally for a UCI). */
    const waitForArrows = (session, boardId, { uci = null, count = 1, description = "arrows", timeoutMs = args.timeoutMs } = {}) =>
      waitFor(description, async () => {
        const overlay = await readOverlay(session, boardId);
        const dataset = overlay.dataset;
        if (!dataset || dataset.state !== "shown" || !Array.isArray(dataset.arrows)) return null;
        const arrows = suggestionArrows(dataset);
        if (arrows.length !== count) return null;
        if (uci && arrows[0]?.uci !== uci) return null;
        return overlay;
      }, { timeoutMs, intervalMs: 60 });

    /** Wait until no SUGGESTION arrow is drawn (a premove arrow may remain). */
    const waitForCleared = (session, boardId, { description = "cleared overlay", timeoutMs = args.timeoutMs } = {}) =>
      waitFor(description, async () => {
        const overlay = await readOverlay(session, boardId);
        // No canvas yet (never drawn/cleared) is the clearest "no arrows" state.
        if (!overlay.dataset) return overlay;
        return suggestionArrows(overlay.dataset).length === 0 ? overlay : null;
      }, { timeoutMs, intervalMs: 60 });

    /**
     * Assert the drawn arrows against the DOM ground truth.
     * Returns a record with per-arrow pixel errors + pixel samples.
     */
    const assertArrows = async (session, boardId, overlay, record) => {
      const dataset = overlay.dataset;
      const arrows = suggestionArrows(dataset);
      const squares = new Set();
      for (const arrow of arrows) {
        const { from, to } = uciSquares(arrow.uci);
        squares.add(from);
        squares.add(to);
      }
      const truth = await readGroundTruth(session, boardId, [...squares]);
      const checks = {
        truth,
        datassetFlipped: dataset.flipped,
        truthFlipped: truth?.flipped ?? null,
        sqX: truth?.sqX ?? null,
        sqFromRect: truth?.sqFromRect ?? null,
        arrows: [],
        maxEndpointErrorPx: 0,
        maxRectErrorPx: null,
        samples: {},
      };
      const assert = (condition, message) => {
        if (!condition) {
          record.pass = false;
          record.failures.push(message);
        }
      };
      assert(truth !== null, `ground truth could not be derived for ${boardId}`);
      if (!truth) return checks;
      assert(dataset.flipped === truth.flipped, `flipped mismatch: dataset ${dataset.flipped} vs DOM ${truth.flipped}`);
      assert(truth.sqX > 4, `square size derived from pieces is ${truth.sqX} px`);
      assert(Math.abs(truth.sqX - truth.sqFromRect) <= 0.75, `square size ${truth.sqX} vs rect/8 ${truth.sqFromRect}`);
      // dataset rect == live DOM rect
      const rectErr = Math.max(
        Math.abs(dataset.rect[0] - overlay.board.x),
        Math.abs(dataset.rect[1] - overlay.board.y),
        Math.abs(dataset.rect[2] - overlay.board.w),
        Math.abs(dataset.rect[3] - overlay.board.h),
      );
      checks.maxRectErrorPx = Number(rectErr.toFixed(3));
      assert(rectErr <= RECT_TOLERANCE_PX, `overlay boardRect differs from the live DOM rect by ${rectErr} px`);

      for (const arrow of arrows) {
        const { from, to } = uciSquares(arrow.uci);
        const fromErr = maxPointError(arrow.from, truth.centres[from]);
        const tipErr = maxPointError(arrow.tip, truth.centres[to]);
        checks.arrows.push({ uci: arrow.uci, rank: arrow.rank, fromErr: Number(fromErr.toFixed(3)), tipErr: Number(tipErr.toFixed(3)), thickness: arrow.thickness });
        checks.maxEndpointErrorPx = Math.max(checks.maxEndpointErrorPx, fromErr, tipErr);
        assert(fromErr <= ENDPOINT_TOLERANCE_PX, `${arrow.uci}: from endpoint off by ${fromErr.toFixed(2)} px (${JSON.stringify(arrow.from)} vs ${JSON.stringify(truth.centres[from])})`);
        assert(tipErr <= ENDPOINT_TOLERANCE_PX, `${arrow.uci}: tip endpoint off by ${tipErr.toFixed(2)} px (${JSON.stringify(arrow.tip)} vs ${JSON.stringify(truth.centres[to])})`);
      }
      return checks;
    };

    await mkdir(args.outDir, { recursive: true });

    /* ===================================================================== */
    /* CASE O1 — startpos: auto suggestion, top-1 arrow, style + routing     */
    /* ===================================================================== */

    const o1 = { pass: true, failures: [], url: null, canvas: null, geometry: null, pixel: null, routing: null, screenshots: [] };
    summary.cases["overlay-startpos"] = o1;
    let startpos = null;
    try {
      startpos = await openFixture("startpos.html");
      o1.url = startpos.url;
      const suggestion = await waitForSuggestion(
        (s) => s.debugStatus === "ready" && s.rows.length === 3 && s.rows[0]?.san === "e4",
        "the startpos suggestion (e4)",
      );
      o1.suggestionKey = suggestion.lastRenderKey;
      const overlay = await waitForArrows(startpos.session, "board-single", { uci: "e2e4", count: 1, description: "the e2e4 arrow" });
      o1.canvas = overlay.canvas;
      o1.dataset = overlay.dataset;

      const assert = (condition, message) => {
        if (!condition) {
          o1.pass = false;
          o1.failures.push(message);
        }
      };
      assert(overlay.canvasExists === true, "the overlay canvas does not exist");
      assert(overlay.canvas.parentIsBody === true, "the canvas is not a direct child of <body>");
      assert(overlay.canvas.position === "fixed", `canvas position is ${overlay.canvas.position}`);
      assert(overlay.canvas.pointerEvents === "none", `canvas pointer-events is ${overlay.canvas.pointerEvents}`);
      assert(overlay.canvas.attached === true && overlay.canvas.display !== "none", "canvas is not displayed");
      assert(overlay.canvas.ariaHidden === "true", "canvas is not aria-hidden");
      assert(overlay.canvas.canvasCount === 1, `the page has ${overlay.canvas.canvasCount} canvases (expected exactly the overlay's)`);
      assert(overlay.canvas.zIndex !== null && overlay.canvas.zIndex > (overlay.boardStackingZ ?? 0), `canvas z-index ${overlay.canvas.zIndex} vs board stacking z ${overlay.boardStackingZ}`);
      assert(overlay.canvas.zIndex >= 40, `canvas z-index ${overlay.canvas.zIndex} is below the documented floor (40)`);
      const expectedW = Math.round(overlay.canvas.cssWidth * overlay.canvas.dpr);
      const expectedH = Math.round(overlay.canvas.cssHeight * overlay.canvas.dpr);
      assert(Math.abs(overlay.canvas.bitmapWidth - expectedW) <= 1 && Math.abs(overlay.canvas.bitmapHeight - expectedH) <= 1, `DPR bitmap: ${overlay.canvas.bitmapWidth}x${overlay.canvas.bitmapHeight} vs expected ${expectedW}x${expectedH}`);
      assert(overlay.dataset.key === suggestion.lastRenderKey, `overlay key ${overlay.dataset.key} vs panel ${suggestion.lastRenderKey}`);
      assert(overlay.dataset.topN === 1, `topN ${overlay.dataset.topN}`);
      assert(overlay.dataset.arrows.length === 1 && overlay.dataset.arrows[0].rank === 0, "expected exactly one top-1 arrow");

      o1.geometry = await assertArrows(startpos.session, "board-single", overlay, o1);

      // The arrow must be really painted: orange pixels at the shaft midpoint.
      const mid = { x: (overlay.dataset.arrows[0].from[0] + overlay.dataset.arrows[0].tip[0]) / 2, y: (overlay.dataset.arrows[0].from[1] + overlay.dataset.arrows[0].tip[1]) / 2 };
      const pixel = await samplePixel(startpos.session, mid);
      o1.pixel = { at: mid, rgba: pixel };
      assert(pixel && pixel[3] > 0, `no painted pixels at the shaft midpoint (${JSON.stringify(pixel)})`);
      assert(pixel && pixel[0] > 140 && pixel[0] >= pixel[1] && pixel[1] > pixel[2], `shaft pixel is not the orange accent: ${JSON.stringify(pixel)}`);

      // Routing evidence: the panel's message went through the SW and the
      // content script answered with the drawn count for the right tab.
      const routing = suggestion.overlayPolicy;
      const stateEntry = await evaluateInPanel(
        `globalThis.__humanplayProof.states.filter((entry) => entry.senderUrl.includes("startpos")).at(-1) ?? null`,
      );
      o1.routing = {
        sentMode: routing.sentMode,
        messageType: routing.lastMessage?.type ?? null,
        response: routing.lastResponse,
        expectedTabId: stateEntry?.senderTabId ?? null,
        lastError: routing.lastError,
      };
      assert(routing.lastMessage?.type === "humanplay:suggestion", `panel sent ${routing.lastMessage?.type}`);
      assert(routing.lastResponse?.ok === true, `SW forward failed: ${JSON.stringify(routing.lastResponse)}`);
      assert(routing.lastResponse?.tabId === stateEntry?.senderTabId, `SW forwarded to tab ${routing.lastResponse?.tabId}, expected ${stateEntry?.senderTabId}`);
      assert(routing.lastResponse?.response?.accepted === 1, `content script accepted ${routing.lastResponse?.response?.accepted} moves`);

      o1.screenshots.push(await pageScreenshot(startpos.session, "startpos-arrows.png"));
      o1.screenshots.push(await panelScreenshot("startpos-panel-arrows.png"));
      console.log(o1.pass
        ? `PASS overlay-startpos: e2e4 arrow, endpoints ≤ ${o1.geometry.maxEndpointErrorPx.toFixed(2)} px vs DOM ground truth, canvas ${overlay.canvas.bitmapWidth}x${overlay.canvas.bitmapHeight} @dpr ${overlay.canvas.dpr}, z ${overlay.canvas.zIndex}`
        : `FAIL overlay-startpos: ${o1.failures.join("; ")}`);
    } catch (error) {
      o1.pass = false;
      o1.failures.push(String(error?.message ?? error));
    }
    if (!o1.pass) for (const failure of o1.failures) fail(failure, "overlay-startpos");
    await writeFile(path.join(args.outDir, "overlay-startpos.json"), `${JSON.stringify(o1, null, 2)}\n`);

    /* ===================================================================== */
    /* CASE O2 — scroll: arrows keep matching after a re-render              */
    /* ===================================================================== */

    const o2 = { pass: true, failures: [], before: null, after: null, geometry: null, screenshot: null };
    summary.cases["overlay-scroll"] = o2;
    if (!startpos) {
      o2.pass = false;
      o2.failures.push("the startpos tab is not available (O1 failed)");
    } else {
      try {
        // Make the page scrollable with a smaller viewport, then scroll.
        await cdp.send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 480, deviceScaleFactor: 1, mobile: false }, startpos.session);
        await sleep(300);
        const beforeOverlay = await readOverlay(startpos.session, "board-single");
        await evaluateInPage(startpos.session, "window.scrollTo(0, 220), true");
        const after = await waitFor("the overlay re-render after the scroll", async () => {
          const overlay = await readOverlay(startpos.session, "board-single");
          if (overlay.dataset?.state !== "shown") return null;
          if (overlay.dataset.renderCount <= (beforeOverlay.dataset?.renderCount ?? 0)) return null;
          if (Math.abs(overlay.board.y - beforeOverlay.board.y) < 50) return null; // actually scrolled
          return overlay;
        }, { timeoutMs: args.timeoutMs });
        o2.before = { boardY: beforeOverlay.board.y, renderCount: beforeOverlay.dataset?.renderCount ?? null };
        o2.after = { boardY: after.board.y, renderCount: after.dataset.renderCount, scrollY: await evaluateInPage(startpos.session, "window.scrollY") };
        o2.geometry = await assertArrows(startpos.session, "board-single", after, o2);
        o2.screenshot = await pageScreenshot(startpos.session, "startpos-arrows-scrolled.png");
        await cdp.send("Emulation.clearDeviceMetricsOverride", {}, startpos.session);
        await sleep(300);
        console.log(o2.pass
          ? `PASS overlay-scroll: board moved ${Math.round(o2.before.boardY - o2.after.boardY)} px (scrollY ${o2.after.scrollY}), endpoints ≤ ${o2.geometry.maxEndpointErrorPx.toFixed(2)} px`
          : `FAIL overlay-scroll: ${o2.failures.join("; ")}`);
      } catch (error) {
        o2.pass = false;
        o2.failures.push(String(error?.message ?? error));
        await cdp.send("Emulation.clearDeviceMetricsOverride", {}, startpos.session).catch(() => {});
      }
    }
    if (!o2.pass) for (const failure of o2.failures) fail(failure, "overlay-scroll");
    await writeFile(path.join(args.outDir, "overlay-scroll.json"), `${JSON.stringify(o2, null, 2)}\n`);

    /* ===================================================================== */
    /* CASE O3 — resize: arrows keep matching after a viewport change        */
    /* ===================================================================== */

    const o3 = { pass: true, failures: [], before: null, after: null, geometry: null, screenshot: null };
    summary.cases["overlay-resize"] = o3;
    if (!startpos) {
      o3.pass = false;
      o3.failures.push("the startpos tab is not available (O1 failed)");
    } else {
      try {
        const beforeOverlay = await readOverlay(startpos.session, "board-single");
        await cdp.send("Emulation.setDeviceMetricsOverride", { width: 900, height: 760, deviceScaleFactor: 1, mobile: false }, startpos.session);
        const after = await waitFor("the overlay re-render after the resize", async () => {
          const overlay = await readOverlay(startpos.session, "board-single");
          if (overlay.dataset?.state !== "shown") return null;
          if (overlay.dataset.renderCount <= (beforeOverlay.dataset?.renderCount ?? 0)) return null;
          return overlay;
        }, { timeoutMs: args.timeoutMs });
        o3.before = { viewport: beforeOverlay.canvas ? { w: beforeOverlay.canvas.cssWidth, h: beforeOverlay.canvas.cssHeight } : null, renderCount: beforeOverlay.dataset?.renderCount ?? null };
        o3.after = {
          viewport: { w: after.canvas.cssWidth, h: after.canvas.cssHeight },
          renderCount: after.dataset.renderCount,
          bitmap: { w: after.canvas.bitmapWidth, h: after.canvas.bitmapHeight },
        };
        o3.geometry = await assertArrows(startpos.session, "board-single", after, o3);
        const expectedW = Math.round(after.canvas.cssWidth * after.canvas.dpr);
        if (Math.abs(after.canvas.bitmapWidth - expectedW) > 1) {
          o3.pass = false;
          o3.failures.push(`bitmap not resized with the viewport: ${after.canvas.bitmapWidth} vs ${expectedW}`);
        }
        o3.screenshot = await pageScreenshot(startpos.session, "startpos-arrows-resized.png");
        await cdp.send("Emulation.clearDeviceMetricsOverride", {}, startpos.session);
        await sleep(300);
        console.log(o3.pass
          ? `PASS overlay-resize: viewport ${o3.before.viewport.w}x${o3.before.viewport.h} -> ${o3.after.viewport.w}x${o3.after.viewport.h}, endpoints ≤ ${o3.geometry.maxEndpointErrorPx.toFixed(2)} px`
          : `FAIL overlay-resize: ${o3.failures.join("; ")}`);
      } catch (error) {
        o3.pass = false;
        o3.failures.push(String(error?.message ?? error));
        await cdp.send("Emulation.clearDeviceMetricsOverride", {}, startpos.session).catch(() => {});
      }
    }
    if (!o3.pass) for (const failure of o3.failures) fail(failure, "overlay-resize");
    await writeFile(path.join(args.outDir, "overlay-resize.json"), `${JSON.stringify(o3, null, 2)}\n`);

    if (startpos) await closeTarget(startpos.targetId);

    /* ===================================================================== */
    /* CASE O4 — middlegame: arrows follow the position (clear + redraw)     */
    /* ===================================================================== */

    const o4 = { pass: true, failures: [], initial: null, afterMove: null, geometry: null, screenshots: [] };
    summary.cases["overlay-follows-position"] = o4;
    let middlegame = null;
    try {
      middlegame = await openFixture("middlegame-castling.html");
      await waitForSuggestion((s) => s.debugStatus === "ready" && String(s.lastRenderKey).includes("d8f6|2400|2400|3"), "the middlegame suggestion (Nc3)");
      const first = await waitForArrows(middlegame.session, "board-play-computer", { uci: "b1c3", count: 1, description: "the b1c3 arrow" });
      o4.initial = { uci: first.dataset.arrows[0].uci, key: first.dataset.key };
      o4.screenshots.push(await pageScreenshot(middlegame.session, "middlegame-arrows.png"));

      // Mutate the fixture (15.b1c3 15...h7h6): the position moves on, the
      // previous arrows must disappear immediately ...
      // The stub answers from its canned table in ms — delay THAT one response
      // so the cleared window is observably non-empty (not a test artefact: the
      // real engine path takes ~200 ms end to end).
      const delayMs = 700;
      await fetch(`${SERVER_ORIGIN}/debug/delay`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ms: delayMs, count: 1 }),
      });
      const mutationAt = await evaluateInPage(middlegame.session, `(() => {
        ${MUTATION_HELPERS}
        globalThis.__humanplayMutationAt = Date.now();
        __humanplayMutate(${JSON.stringify(MIDDLEGAME_MUTATIONS[0])});
        return globalThis.__humanplayMutationAt;
      })()`);
      const cleared = await waitForCleared(middlegame.session, "board-play-computer", { description: "the cleared previous-position arrows" });
      o4.clearedAfterMutationMs = Date.now() - mutationAt;
      o4.delayMs = delayMs;
      o4.clearedDataset = { state: cleared.dataset.state, reason: cleared.dataset.reason, key: cleared.dataset.key };

      // ... and the new position's top-1 (canned: Nd5 = c3d5) must arrive.
      const second = await waitForArrows(middlegame.session, "board-play-computer", { uci: "c3d5", count: 1, description: "the c3d5 arrow for the new position", timeoutMs: args.timeoutMs });
      o4.afterMove = { uci: second.dataset.arrows[0].uci, key: second.dataset.key };
      o4.mutationToArrowsMs = Date.now() - mutationAt;
      o4.geometry = await assertArrows(middlegame.session, "board-play-computer", second, o4);
      const assert = (condition, message) => {
        if (!condition) {
          o4.pass = false;
          o4.failures.push(message);
        }
      };
      assert(o4.initial.uci === "b1c3", `initial arrow ${o4.initial.uci}`);
      assert(o4.afterMove.uci === "c3d5", `post-move arrow ${o4.afterMove.uci}`);
      assert(o4.afterMove.key !== o4.initial.key, "the position key did not change with the move");
      assert(o4.clearedAfterMutationMs <= 1500, `clearing took ${o4.clearedAfterMutationMs} ms`);
      assert(o4.mutationToArrowsMs <= 2500, `mutation -> new arrows took ${o4.mutationToArrowsMs} ms`);
      o4.screenshots.push(await pageScreenshot(middlegame.session, "middlegame-arrows-after-move.png"));
      console.log(o4.pass
        ? `PASS overlay-follows-position: b1c3 cleared in ${o4.clearedAfterMutationMs} ms after the move, new c3d5 arrows in ${o4.mutationToArrowsMs} ms, endpoints ≤ ${o4.geometry.maxEndpointErrorPx.toFixed(2)} px`
        : `FAIL overlay-follows-position: ${o4.failures.join("; ")}`);
    } catch (error) {
      o4.pass = false;
      o4.failures.push(String(error?.message ?? error));
    }
    if (!o4.pass) for (const failure of o4.failures) fail(failure, "overlay-follows-position");
    await writeFile(path.join(args.outDir, "overlay-follows-position.json"), `${JSON.stringify(o4, null, 2)}\n`);

    /* ===================================================================== */
    /* CASE O5 — alternatives: toggle re-renders 1 <-> 3 arrows             */
    /* ===================================================================== */

    const o5 = { pass: true, failures: [], threeArrows: null, backToOne: null, settingsAfterOn: null, settingsAfterOff: null, geometry: null, screenshots: [] };
    summary.cases["overlay-alternatives"] = o5;
    if (!middlegame) {
      o5.pass = false;
      o5.failures.push("the middlegame tab is not available (O4 failed)");
    } else {
      try {
        const assert = (condition, message) => {
          if (!condition) {
            o5.pass = false;
            o5.failures.push(message);
          }
        };
        await evaluateInPanel('document.getElementById("ov-alternatives").click(), true');
        const three = await waitForArrows(middlegame.session, "board-play-computer", { count: 3, description: "three alternative arrows" });
        o5.threeArrows = three.dataset.arrows.map((arrow) => ({ uci: arrow.uci, rank: arrow.rank, thickness: arrow.thickness }));
        o5.geometry = await assertArrows(middlegame.session, "board-play-computer", three, o5);
        o5.settingsAfterOn = await evaluateInPanel('chrome.storage.local.get("settings").then((stored) => stored.settings ?? null)');
        o5.screenshots.push(await pageScreenshot(middlegame.session, "middlegame-alternatives.png"));
        o5.screenshots.push(await panelScreenshot("middlegame-panel-alternatives.png"));

        assert(o5.threeArrows.length === 3, `arrows ${o5.threeArrows.length}`);
        assert(o5.threeArrows[0].uci === "c3d5" && o5.threeArrows[0].rank === 0, `top-1 ${JSON.stringify(o5.threeArrows[0])}`);
        assert(o5.threeArrows[1].rank === 1 && o5.threeArrows[2].rank === 2, "ranks are not 0,1,2");
        assert(o5.threeArrows[0].thickness > o5.threeArrows[1].thickness, `top-1 is not thicker (${o5.threeArrows[0].thickness} vs ${o5.threeArrows[1].thickness})`);
        assert(o5.settingsAfterOn?.showAlternatives === true, `showAlternatives not persisted: ${JSON.stringify(o5.settingsAfterOn)}`);

        // Toggle back off -> exactly one arrow again.
        await evaluateInPanel('document.getElementById("ov-alternatives").click(), true');
        const one = await waitForArrows(middlegame.session, "board-play-computer", { count: 1, description: "back to a single arrow" });
        o5.backToOne = one.dataset.arrows.map((arrow) => arrow.uci);
        o5.settingsAfterOff = await evaluateInPanel('chrome.storage.local.get("settings").then((stored) => stored.settings ?? null)');
        assert(o5.backToOne.length === 1, `after toggling off: ${o5.backToOne.length} arrows`);
        assert(o5.settingsAfterOff?.showAlternatives === false, "showAlternatives=false not persisted");
        console.log(o5.pass
          ? `PASS overlay-alternatives: 3 arrows ${o5.threeArrows.map((a) => a.uci).join("/")} (top-1 thick), persisted, back to 1`
          : `FAIL overlay-alternatives: ${o5.failures.join("; ")}`);
      } catch (error) {
        o5.pass = false;
        o5.failures.push(String(error?.message ?? error));
      }
    }
    if (!o5.pass) for (const failure of o5.failures) fail(failure, "overlay-alternatives");
    await writeFile(path.join(args.outDir, "overlay-alternatives.json"), `${JSON.stringify(o5, null, 2)}\n`);

    /* ===================================================================== */
    /* CASE O6 — flipped board: opponent's turn clears; manual draws flipped */
    /* ===================================================================== */

    const o6 = { pass: true, failures: [], waiting: null, geometry: null, screenshots: [] };
    summary.cases["overlay-flipped-black"] = o6;
    let flipped = null;
    try {
      flipped = await openFixture("flipped-black.html");
      const flippedFen = "rnbqkbnr/pp2pppp/3p4/2p5/4P3/5N2/PPPP1PPP/RNBQKB1R w KQkq - 0 3";
      await refreshPanelState(flipped.targetId, flippedFen, "flipped-black");
      const waiting = await waitForSuggestion((s) => s.gate === "waiting", "the waiting state (opponent's turn)");
      const cleared = await waitForCleared(flipped.session, "board-single", { description: "no suggestion arrows on the opponent's turn" });
      o6.waiting = {
        gate: waiting.gate,
        overlayState: cleared.dataset.state,
        reason: cleared.dataset.reason,
        panelClearReason: waiting.overlayPolicy.lastClearReason,
        arrows: suggestionArrows(cleared.dataset).length,
        // M7: the dashed premove arrow may legitimately be on the board here.
        allArrows: (cleared.dataset.arrows ?? []).map((arrow) => ({ uci: arrow.uci, style: arrow.style ?? "solid", premove: Boolean(arrow.premove) })),
      };
      const assert = (condition, message) => {
        if (!condition) {
          o6.pass = false;
          o6.failures.push(message);
        }
      };
      assert(o6.waiting.arrows === 0, `opponent's turn still has ${o6.waiting.arrows} suggestion arrows`);
      assert(o6.waiting.panelClearReason === "opponent-turn", `panel clear reason ${o6.waiting.panelClearReason}`);
      o6.screenshots.push(await pageScreenshot(flipped.session, "flipped-black-no-arrows.png"));

      // Manual analysis on the opponent's turn -> arrows for d4, drawn flipped.
      // (M7 note: the premove arrow may share the canvas — the geometry checks
      // iterate the suggestion arrows only; the coexistence is recorded.)
      await evaluateInPanel('document.getElementById("mx-analyze").click(), true');
      const suggestion = await waitForSuggestion((s) => s.rows.length === 3 && s.rows[0]?.san === "d4", "the manual d4 suggestion");
      const overlay = await waitForArrows(flipped.session, "board-single", { uci: "d2d4", count: 1, description: "the flipped d2d4 arrow" });
      o6.keys = { panelKey: suggestion.lastRenderKey, overlayKey: overlay.dataset.key };
      o6.suggestionArrows = suggestionArrows(overlay.dataset).map((arrow) => ({ uci: arrow.uci, style: arrow.style ?? "solid" }));
      o6.premoveCoexistence = (overlay.dataset.arrows ?? []).filter((arrow) => arrow.premove).map((arrow) => ({ uci: arrow.uci, style: arrow.style }));
      assert(overlay.dataset.flipped === true, `overlay dataset flipped ${overlay.dataset.flipped}`);
      o6.geometry = await assertArrows(flipped.session, "board-single", overlay, o6);
      const suggestionArrow = suggestionArrows(overlay.dataset)[0];
      const mid = { x: (suggestionArrow.from[0] + suggestionArrow.tip[0]) / 2, y: (suggestionArrow.from[1] + suggestionArrow.tip[1]) / 2 };
      o6.pixel = await samplePixel(flipped.session, mid);
      assert(o6.pixel && o6.pixel[3] > 0, `no painted pixels on the flipped board: ${JSON.stringify(o6.pixel)}`);
      o6.screenshots.push(await pageScreenshot(flipped.session, "flipped-black-arrows.png"));
      console.log(o6.pass
        ? `PASS overlay-flipped-black: waiting -> 0 arrows; manual d4 -> d2d4 flipped arrow, endpoints ≤ ${o6.geometry.maxEndpointErrorPx.toFixed(2)} px`
        : `FAIL overlay-flipped-black: ${o6.failures.join("; ")}`);
    } catch (error) {
      o6.pass = false;
      o6.failures.push(String(error?.message ?? error));
    }
    if (!o6.pass) for (const failure of o6.failures) fail(failure, "overlay-flipped-black");
    await writeFile(path.join(args.outDir, "overlay-flipped-black.json"), `${JSON.stringify(o6, null, 2)}\n`);

    /* ===================================================================== */
    /* CASE O7 — clear cases: assistant off, game over, server error         */
    /* ===================================================================== */

    const o7 = { pass: true, failures: [], assistantOff: null, gameOver: null, serverError: null, screenshots: [] };
    summary.cases["overlay-clear-cases"] = o7;
    if (!flipped || !middlegame) {
      o7.pass = false;
      o7.failures.push("the flipped/middlegame fixture tabs are not available (O4/O6 failed)");
    } else {
    try {
      const assert = (condition, message) => {
        if (!condition) {
          o7.pass = false;
          o7.failures.push(message);
        }
      };

      // (a) assistant off on the flipped tab (arrows are showing: d2d4).
      await evaluateInPanel('document.getElementById("assistant-toggle").click(), true');
      const clearedOff = await waitForCleared(flipped.session, "board-single", { description: "arrows cleared by the assistant-off toggle" });
      const offSuggestion = await readSuggestion();
      o7.assistantOff = { overlayState: clearedOff.dataset.state, reason: clearedOff.dataset.reason, panelGate: offSuggestion.gate, clearReason: offSuggestion.overlayPolicy.lastClearReason };
      assert(clearedOff.dataset.state !== "shown", "arrows still shown with the assistant off");
      assert((clearedOff.dataset.arrows ?? []).length === 0, "arrow list not emptied with the assistant off");
      assert(offSuggestion.overlayPolicy.lastClearReason === "assistant-off", `assistant-off clear reason: ${offSuggestion.overlayPolicy.lastClearReason}`);
      await evaluateInPanel('document.getElementById("assistant-toggle").click(), true');
      await waitForSuggestion((s) => s.gate !== "off", "the assistant back on");

      // (b) game over (the fixture's final position -> server answers moves:[]).
      const gameover = await openFixture("gameover-checkmate.html");
      await refreshPanelState(gameover.targetId, "r1bqkb1r/pppp1Qpp/2n2n2/4p3/2B1P3/8/PPPP1PPP/RNB1K1NR b KQkq - 0 4", "gameover-checkmate");
      const gameoverSuggestion = await waitForSuggestion((s) => s.debugStatus === "game-over", "the game-over card");
      const gameoverOverlay = await waitForCleared(gameover.session, "board-single", { description: "no arrows at game over" });
      o7.gameOver = {
        cardStatus: gameoverSuggestion.status,
        message: gameoverSuggestion.message,
        overlayState: gameoverOverlay.dataset.state,
        reason: gameoverOverlay.dataset.reason,
        arrows: (gameoverOverlay.dataset.arrows ?? []).length,
        clearReason: gameoverSuggestion.overlayPolicy.lastClearReason,
      };
      assert(o7.gameOver.arrows === 0, `game over still shows ${o7.gameOver.arrows} arrows`);
      o7.screenshots.push(await pageScreenshot(gameover.session, "gameover-no-arrows.png"));
      await closeTarget(gameover.targetId);

      // (c) server error (stub mode: 400) on the middlegame tab.
      // Deterministic precondition: wait for the CARD to actually show the
      // middlegame position (the previous episode ended on the gameover tab, so
      // the overlay may still show stale arrows — trusting those would let the
      // case proceed without the panel having picked the middlegame state up).
      await refreshPanelState(middlegame.targetId, "r1b2rk1/ppp2pp1/2np1q1p/2b1p3/2B1P3/2NP1N2/PPP2PPP/R2Q1RK1 w - - 0 9", "middlegame before the error case");
      const arrowsBefore = await waitForArrows(middlegame.session, "board-play-computer", { count: 1, description: "the middlegame arrows before the error case" });
      await setMode("bad_request");
      await evaluateInPanel('document.getElementById("mx-analyze").click(), true');
      let errorSuggestion;
      try {
        errorSuggestion = await waitForSuggestion((s) => /invalid input/.test(s.message ?? ""), "the 400 error message");
      } catch (error) {
        // Diagnostic: capture the panel at the moment the wait gave up.
        o7.errorTimeoutDump = {
          suggestion: await readSuggestion(),
          panelStatus: await evaluateInPanel('document.getElementById("mx-status").textContent'),
          messageHidden: await evaluateInPanel('document.getElementById("mx-message").hidden'),
          message: await evaluateInPanel('document.getElementById("mx-message").textContent'),
          assistantChecked: await evaluateInPanel('document.getElementById("assistant-toggle").checked'),
          fenOnCard: await evaluateInPanel('document.getElementById("cc-fen").textContent'),
          ccChip: await evaluateInPanel('document.getElementById("cc-chip").textContent'),
          errorBanner: await evaluateInPanel('document.getElementById("error").hidden ? null : document.getElementById("error").textContent'),
          isCurrent: await evaluateInPanel("globalThis.__humanplayAnalysis?.client?.getCurrentKey?.() ?? null"),
          lastResult: await evaluateInPanel("globalThis.__humanplayAnalysis?.lastResult ?? null"),
          stub: await serverStats(),
          tts: await evaluateInPanel("JSON.stringify(globalThis.__humanplayAnalysis?.tts?.decision ?? null)"),
        };
        throw error;
      }
      const errorOverlay = await waitForCleared(middlegame.session, "board-play-computer", { description: "no arrows on the server error" });
      o7.serverError = {
        cardMessage: errorSuggestion.message,
        overlayState: errorOverlay.dataset.state,
        reason: errorOverlay.dataset.reason,
        arrows: (errorOverlay.dataset.arrows ?? []).length,
        clearReason: errorSuggestion.overlayPolicy.lastClearReason,
        arrowsBefore: arrowsBefore.dataset.arrows.length,
      };
      assert(o7.serverError.arrows !== undefined && o7.serverError.arrows === 0, `server error still shows arrows`);
      assert(String(o7.serverError.clearReason).startsWith("error"), `error clear reason: ${o7.serverError.clearReason}`);
      await setMode("ok");
      console.log(o7.pass
        ? `PASS overlay-clear-cases: assistant off (${o7.assistantOff.clearReason}), game over (${o7.gameOver.clearReason}), server error (${o7.serverError.clearReason}) -> 0 arrows`
        : `FAIL overlay-clear-cases: ${o7.failures.join("; ")}`);
    } catch (error) {
      o7.pass = false;
      o7.failures.push(String(error?.message ?? error));
      await setMode("ok").catch(() => {});
    }
    }
    if (!o7.pass) for (const failure of o7.failures) fail(failure, "overlay-clear-cases");
    await writeFile(path.join(args.outDir, "overlay-clear-cases.json"), `${JSON.stringify(o7, null, 2)}\n`);

    /* ===================================================================== */
    /* CASE O8 — "Show arrows" toggle + multi-tab routing                    */
    /* ===================================================================== */

    const o8 = { pass: true, failures: [], toggle: null, tabs: null, screenshots: [] };
    summary.cases["overlay-toggle-and-routing"] = o8;
    let tabA = null;
    let tabB = null;
    try {
      const assert = (condition, message) => {
        if (!condition) {
          o8.pass = false;
          o8.failures.push(message);
        }
      };

      // (a) "Show arrows on board" off -> clear immediately; on -> re-render.
      // The error case above ended without arrows: analyze manually first.
      await evaluateInPanel('document.getElementById("mx-analyze").click(), true');
      await waitForSuggestion((s) => s.debugStatus === "ready" && (s.rows?.length ?? 0) > 0, "the middlegame suggestion before the toggle");
      const arrowsNow = await waitForArrows(middlegame.session, "board-play-computer", { count: 1, description: "arrows before the toggle-off" });
      const beforeCount = arrowsNow.dataset.arrows.length;
      await evaluateInPanel('document.getElementById("ov-arrows").click(), true');
      const off = await waitForCleared(middlegame.session, "board-play-computer", { description: "arrows cleared by the Show-arrows toggle" });
      const offSettings = await evaluateInPanel('chrome.storage.local.get("settings").then((stored) => stored.settings ?? null)');
      o8.toggle = { beforeCount, offState: off.dataset.state, offReason: off.dataset.reason, showArrows: offSettings?.showArrows };
      assert(offSettings?.showArrows === false, "showArrows=false not persisted");
      assert((off.dataset.arrows ?? []).length === 0, "toggling arrows off did not clear them");

      await evaluateInPanel('document.getElementById("ov-arrows").click(), true');
      const backOn = await waitForArrows(middlegame.session, "board-play-computer", { count: 1, description: "arrows re-rendered after the toggle-on" });
      const onSettings = await evaluateInPanel('chrome.storage.local.get("settings").then((stored) => stored.settings ?? null)');
      o8.toggle.backState = backOn.dataset.state;
      o8.toggle.showArrowsAfterOn = onSettings?.showArrows;
      assert(onSettings?.showArrows === true, "showArrows=true not persisted");

      // (b) multi-tab: the LAST tab that reports a state receives the suggestion.
      tabA = await openFixture("startpos.html");
      const arrowsA = await waitForArrows(tabA.session, "board-single", { uci: "e2e4", count: 1, description: "startpos arrows in tab A" });
      o8.tabs = { aUci: arrowsA.dataset.arrows[0].uci, aRenderCount: arrowsA.dataset.renderCount };
      tabB = await openFixture("ruy-lopez.html");
      await refreshPanelState(tabB.targetId, "r1bq1rk1/2p1bppp/p1np1n2/1p2p3/4P3/1BP2N2/PP1P1PPP/RNBQR1K1 w - - 1 9", "ruy-lopez");
      const arrowsB = await waitForArrows(tabB.session, "board-single", { uci: "h2h3", count: 1, description: "ruy-lopez arrows in tab B" });
      const afterA = await readOverlay(tabA.session, "board-single");
      o8.tabs.bUci = arrowsB.dataset.arrows[0].uci;
      o8.tabs.bKey = arrowsB.dataset.key;
      o8.tabs.aAfterBUci = afterA.dataset?.arrows?.[0]?.uci ?? null;
      o8.tabs.aRenderCountAfterB = afterA.dataset?.renderCount ?? null;
      assert(arrowsB.dataset.arrows[0].uci === "h2h3", `tab B arrow ${arrowsB.dataset.arrows[0].uci}`);
      assert(String(arrowsB.dataset.key).endsWith("c2c3 e8g8|2400|2400|3"), `tab B suggestion key: ${arrowsB.dataset.key}`);
      assert(arrowsB.dataset.key !== arrowsA.dataset.key, "tab A and tab B received the same suggestion key");
      assert(afterA.dataset?.arrows?.[0]?.uci === "e2e4", `tab A should keep its own arrows until its next episode: ${afterA.dataset?.arrows?.[0]?.uci}`);
      assert(afterA.dataset?.key === arrowsA.dataset.key, `tab A's suggestion changed when tab B became the last-state tab (${afterA.dataset?.key})`);
      o8.screenshots.push(await pageScreenshot(tabB.session, "ruy-lopez-arrows.png"));
      console.log(o8.pass
        ? `PASS overlay-toggle-and-routing: toggle clears/re-renders; last-state tab (B: h2h3) wins, tab A keeps e2e4 untouched`
        : `FAIL overlay-toggle-and-routing: ${o8.failures.join("; ")}`);
    } catch (error) {
      o8.pass = false;
      o8.failures.push(String(error?.message ?? error));
    }
    if (!o8.pass) for (const failure of o8.failures) fail(failure, "overlay-toggle-and-routing");
    await writeFile(path.join(args.outDir, "overlay-toggle-and-routing.json"), `${JSON.stringify(o8, null, 2)}\n`);

    /* ===================================================================== */
    /* CASE O9 — board disappears (SPA-like) -> hide; returns -> re-anchor   */
    /* ===================================================================== */

    const o9 = { pass: true, failures: [], removed: null, returned: null, geometry: null, screenshots: [] };
    summary.cases["overlay-board-reappears"] = o9;
    if (!tabB) {
      o9.pass = false;
      o9.failures.push("tab B is not available (O8 failed)");
    } else {
      try {
        const assert = (condition, message) => {
          if (!condition) {
            o9.pass = false;
            o9.failures.push(message);
          }
        };
        await waitForArrows(tabB.session, "board-single", { uci: "h2h3", count: 1, description: "tab B arrows before the board removal" });
        await evaluateInPage(tabB.session, `(() => {
          const board = document.getElementById("board-single");
          globalThis.__humanplaySavedBoard = board;
          globalThis.__humanplaySavedParent = board.parentElement;
          board.remove();
          return true;
        })()`);
        const hidden = await waitForCleared(tabB.session, "board-single", { description: "the hidden overlay after the board disappeared", timeoutMs: 12000 });
        o9.removed = { state: hidden.dataset.state, reason: hidden.dataset.reason, boardExists: hidden.boardExists };
        o9.screenshots.push(await pageScreenshot(tabB.session, "ruy-lopez-board-gone.png"));
        assert(hidden.boardExists === false, "the board element is still in the DOM");

        // Bring the board back (the SPA re-render case) -> the overlay must
        // re-find it and the panel must re-send the (cached) suggestion.
        await evaluateInPage(tabB.session, `(() => {
          globalThis.__humanplaySavedParent.append(globalThis.__humanplaySavedBoard);
          return true;
        })()`);
        const returned = await waitFor("the overlay to re-anchor after the board returned", async () => {
          const overlay = await readOverlay(tabB.session, "board-single");
          return overlay.boardExists && overlay.dataset?.state === "shown" && (overlay.dataset.arrows ?? []).length === 1 ? overlay : null;
        }, { timeoutMs: args.timeoutMs });
        o9.returned = { state: returned.dataset.state, uci: returned.dataset.arrows[0].uci, renderCount: returned.dataset.renderCount };
        o9.geometry = await assertArrows(tabB.session, "board-single", returned, o9);
        assert(returned.dataset.arrows[0].uci === "h2h3", `after the board returned the arrow is ${returned.dataset.arrows[0].uci}`);
        o9.screenshots.push(await pageScreenshot(tabB.session, "ruy-lopez-arrows-again.png"));
        console.log(o9.pass
          ? `PASS overlay-board-reappears: hidden while the board was gone (${o9.removed.state}/${o9.removed.reason}), re-anchored h2h3 after it returned`
          : `FAIL overlay-board-reappears: ${o9.failures.join("; ")}`);
      } catch (error) {
        o9.pass = false;
        o9.failures.push(String(error?.message ?? error));
      }
    }
    if (!o9.pass) for (const failure of o9.failures) fail(failure, "overlay-board-reappears");
    await writeFile(path.join(args.outDir, "overlay-board-reappears.json"), `${JSON.stringify(o9, null, 2)}\n`);

    if (tabA) await closeTarget(tabA.targetId);
    if (tabB) await closeTarget(tabB.targetId);
    if (middlegame) await closeTarget(middlegame.targetId);
    if (flipped) await closeTarget(flipped.targetId);

    /* ===================================================================== */
    /* CASE O10 — BONUS: real chess.com page (best-effort, retried once)     */
    /* ===================================================================== */

    if (args.realPage) {
      const o10 = { pass: true, failures: [], status: "not-run", url: args.realPage, attempts: [], screenshot: null, geometry: null };
      summary.cases["overlay-real-page"] = o10;
      for (let attempt = 1; attempt <= 2; attempt += 1) {
        const attemptRecord = { attempt, ok: false, error: null, state: null };
        o10.attempts.push(attemptRecord);
        let realTarget = null;
        let realSession = null;
        try {
          realTarget = await cdp.send("Target.createTarget", { url: args.realPage });
          openTargets.add(realTarget.targetId);
          realSession = (await cdp.send("Target.attachToTarget", { targetId: realTarget.targetId, flatten: true })).sessionId;
          sessionRole.set(realSession, "page");
          await cdp.send("Page.enable", {}, realSession);
          await cdp.send("Runtime.enable", {}, realSession);
          await cdp.send("Log.enable", {}, realSession);

          // Wait for the adapter to report a real position from chess.com.
          const state = await waitFor("a real chess.com GameState", async () => {
            const states = await evaluateInPanel("globalThis.__humanplayProof.states");
            return states
              .filter((entry) => entry.senderUrl.includes("chess.com") && entry.ok && entry.fen)
              .at(-1) ?? null;
          }, { timeoutMs: 30000, intervalMs: 200 });
          attemptRecord.state = { fen: state.fen, senderTabId: state.senderTabId, senderUrl: state.senderUrl };
          await evaluateInPage(realSession, PAGE_HELPERS);
          // Let the panel's own analysis of the real position settle first (the
          // stub has no canned data for a real game, so it ends in an error +
          // a clear — after that nothing will overwrite our injected arrows).
          await waitFor("the panel's analysis of the real position to settle", async () => {
            const suggestion = await readSuggestion();
            return suggestion.debugStatus !== "analyzing" ? suggestion : null;
          }, { timeoutMs: 20000 });
          await sleep(400);

          // Route a canned suggestion through the REAL SW -> content-script path.
          const boardId = await evaluateInPage(realSession, `(() => {
            const board = [...document.querySelectorAll("wc-chess-board")].sort((a, b) => b.getBoundingClientRect().width - a.getBoundingClientRect().width)[0];
            if (!board) return null;
            if (!board.id) board.setAttribute("id", "humanplay-proof-board");
            return board.id;
          })()`);
          if (!boardId) throw new Error("no wc-chess-board on the real page");
          const forward = await evaluateInWorker(
            `chrome.tabs.sendMessage(${state.senderTabId}, ${JSON.stringify({
              type: "humanplay:suggestion",
              moves: [{ uci: "e2e4", san: "e4", prob: 0.464864 }],
              topN: 1,
              key: "real-page-proof-e2e4",
            })}).then((response) => ({ ok: true, response }), (error) => ({ ok: false, error: String(error?.message ?? error) }))`,
          );
          attemptRecord.routed = forward;
          const overlay = await waitForArrows(realSession, boardId, { uci: "e2e4", count: 1, description: "the routed arrow on the real page", timeoutMs: 15000 });
          attemptRecord.ok = true;
          o10.status = "passed";
          o10.dataset = { key: overlay.dataset.key, flipped: overlay.dataset.flipped, rect: overlay.dataset.rect };
          o10.canvas = { position: overlay.canvas.position, pointerEvents: overlay.canvas.pointerEvents, zIndex: overlay.canvas.zIndex, dpr: overlay.canvas.dpr };
          o10.geometry = await assertArrows(realSession, boardId, overlay, o10);
          o10.screenshot = await pageScreenshot(realSession, "real-chesscom-arrows.png");
          console.log(`PASS overlay-real-page: real chess.com page ${state.fen.slice(0, 24)}…, routed e2e4 arrow, endpoints ≤ ${o10.geometry.maxEndpointErrorPx.toFixed(2)} px`);
          break;
        } catch (error) {
          attemptRecord.error = String(error?.message ?? error);
          // The first failure may be a transient load problem -> retry once.
          if (attempt === 2 || !/timeout|ERR_|navigat|net::/i.test(attemptRecord.error)) {
            o10.pass = false;
            o10.status = "blocked";
            o10.note = "best-effort bonus case: the real chess.com page could not be loaded/asserted in this environment — see attempts";
            console.error(`SKIP overlay-real-page (blocked): ${attemptRecord.error}`);
          }
        } finally {
          if (realTarget) await closeTarget(realTarget.targetId);
        }
      }
      if (o10.status === "blocked") {
        // A blocked bonus case is documented, not a hard failure.
        o10.pass = true;
        summary.checks.realPageBlocked = true;
      }
      await writeFile(path.join(args.outDir, "overlay-real-page.json"), `${JSON.stringify(o10, null, 2)}\n`);
    }

    /* ------------------------------------------------------------- logs */

    await sleep(500);
    summary.console = {
      panel: logs.panel,
      serviceWorker: logs.serviceWorker,
      pages: logs.pages,
      panelErrors: logs.panel.filter((entry) => entry.bucket === "error" && entry.source !== "network"),
      serviceWorkerErrors: logs.serviceWorker.filter((entry) => entry.bucket === "error"),
      pageErrors: logs.pages.filter((entry) => entry.bucket === "error" && entry.source !== "network"),
      networkErrors: [...logs.panel, ...logs.pages, ...logs.serviceWorker].filter((entry) => entry.bucket === "error" && entry.source === "network"),
    };
    summary.checks.overlayDebugLines = summary.console.pages.filter((entry) => entry.text.includes("[humanplay] overlay")).length;
    summary.checks.extensionConsoleClean =
      summary.console.panelErrors.length === 0 &&
      summary.console.serviceWorkerErrors.length === 0 &&
      summary.console.pageErrors.length === 0;
    if (!summary.checks.extensionConsoleClean) fail("extension console reported errors — see summary.console");
    const harmlessNetworkLog = (text) => /ERR_UNKNOWN_URL_SCHEME|favicon\.ico|status of 40[04]|ERR_ABORTED/.test(text);
    // Our own requests (the helper server / the fixture origin) must stay clean.
    // With --real-page, anything else is chess.com's own third-party noise
    // (trackers, ads, Cloudflare) and is recorded, not treated as our failure.
    const ownNetworkRequest = (text) => /127\.0\.0\.1:8765/.test(text) || text.includes(origin);
    const unexpectedNetworkErrors = summary.console.networkErrors.filter(
      (entry) => ownNetworkRequest(entry.text) && !harmlessNetworkLog(entry.text),
    );
    summary.checks.expectedNetworkErrors = summary.console.networkErrors.map((entry) => entry.text);
    if (args.realPage) {
      summary.checks.realPageNetworkErrors = summary.console.networkErrors
        .filter((entry) => !ownNetworkRequest(entry.text) && !harmlessNetworkLog(entry.text))
        .map((entry) => entry.text);
    }
    if (unexpectedNetworkErrors.length) {
      fail(`unexpected network errors: ${unexpectedNetworkErrors.map((entry) => entry.text).join(" | ")}`);
    }

    summary.ok = summary.failures.length === 0;
    await writeFile(path.join(args.outDir, "overlay-proof.json"), `${JSON.stringify(summary, null, 2)}\n`);
    console.log(
      `\n${summary.ok ? "ALL OVERLAY CASES PASSED" : `FAILURES (${summary.failures.length}):\n - ` + summary.failures.join("\n - ")}` +
        `\nproof: ${path.relative(REPO_ROOT, path.join(args.outDir, "overlay-proof.json"))}`,
    );
    if (!summary.ok) process.exitCode = 1;
  } catch (error) {
    console.error(`overlay-proof failed: ${error.message}`);
    console.error(JSON.stringify({ logs, fixtureServerLog: fixtureServerLog.slice(0, 2000), partial: true }, null, 2));
    process.exitCode = 1;
  } finally {
    cdp?.close();
    chromeProcess?.kill("SIGTERM");
    await sleep(300);
    chromeProcess?.kill("SIGKILL");
    if (profileDir && !args.keepProfile) await rm(profileDir, { recursive: true, force: true });
    else if (profileDir) console.error(`profile kept at ${profileDir}`);
    if (variantDir) await rm(variantDir, { recursive: true, force: true });
    if (staticServer) staticServer.close();
    if (fixtureServerProcess) {
      fixtureServerProcess.kill("SIGTERM");
      await sleep(200);
      fixtureServerProcess.kill("SIGKILL");
    }
  }
}

main();

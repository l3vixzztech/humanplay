#!/usr/bin/env node
/**
 * tts-proof.mjs — objective end-to-end proof for the M6 TTS move announcements.
 *
 * Same harness pattern as test/tools/overlay-proof.mjs / analyze-proof.mjs
 * (Chrome for Testing + CDP, zero deps): the extension is loaded from a
 * temporary COPY whose manifest additionally matches the fixture origin, every
 * code file is hash-compared (`codeIdentical`), and the fixture stub server
 * (test/tools/fixture_server.py) provides the canned /analyze responses.
 *
 * What it proves:
 *
 *   1. **suggestion ready -> exactly 1 speak** with the expected text for the
 *      fixture's canned move ("e-pawn to e4"), engine chrome.tts, enqueue:false,
 *      the configured rate, and a recorded stop() immediately before it;
 *   2. **same position re-emitted -> NO second speak** (dedupe by position key,
 *      even though the card re-rendered several times);
 *   3. **new position -> stop() then a new speak** (order + timing asserted from
 *      the recorded timestamps: mutation -> spoken <= 2.5 s);
 *   4. **TTS toggle off mid-flow -> stop() and no further speaks** (a whole new
 *      position is analyzed while off and stays silent); **on again -> speaks**;
 *   5. **stale suggestion -> no speak** (a delayed response superseded by a
 *      newer position is discarded and never spoken — the M4 stale guard);
 *   6. **never speak on**: the opponent's turn (auto *and* manual analysis),
 *      assistant off, server error / invalid input, game over;
 *   7. **hotkey + badge**: `chrome.commands.getAll()` shows `toggle-tts`
 *      (Ctrl+Shift+Y); invoking the handler flips settings.ttsEnabled, the
 *      toolbar badge ("TTS" / cleared) and the panel checkbox (via
 *      chrome.storage.onChanged). Real key presses are manual-only (there is no
 *      CDP API for browser shortcuts);
 *   8. **voices**: `chrome.tts.getVoices()` is recorded from the test env; on
 *      this machine it is empty, so the panel's actionable note is asserted —
 *      and the speak path still executes (assertion 1);
 *   9. **PANEL CLOSED (architecture-critical)**: with the side-panel document
 *      gone, a position change still reaches the service worker, and a speak
 *      request routed through the production messaging path (sent from the
 *      content-script isolated world, since the panel document no longer
 *      exists) is still performed + recorded by the SW/`chrome.tts`. The
 *      speaker deliberately does not live in the panel document.
 *
 * Evidence: per-case JSONs + panel screenshots land in
 * test/fixtures/captures/tts/ (plus the aggregate tts-proof.json). The toolbar
 * badge cannot be captured through CDP (browser UI, no screenshot tool on this
 * machine) — it is asserted through `chrome.action.getBadgeText/
 * getBadgeBackgroundColor` and left as a manual check.
 *
 * Usage:
 *   node test/tools/tts-proof.mjs --chrome <path> [--out-dir test/fixtures/captures/tts]
 *     [--extension extension] [--headful] [--keep-profile] [--timeout-ms 45000]
 *     [--no-speech-backend]     # omit --enable-speech-dispatcher (see below)
 *
 * The browser is started with `--enable-speech-dispatcher`: without it every
 * utterance on Linux ends in a `{type:"error", errorMessage:""}` event (no
 * speech backend). With it, chrome.tts fires start/end/interrupted events —
 * recorded as `checks.synthesisBackend` (a soft check: the assertions are on
 * the SW hook records, which are deterministic on every platform).
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
const GAMEOVER_FEN = "r1bqkb1r/pppp1Qpp/2n2n2/4p3/2B1P3/8/PPPP1PPP/RNB1K1NR b KQkq - 0 4";
const FLIPPED_FEN = "rnbqkbnr/pp2pppp/3p4/2p5/4P3/5N2/PPPP1PPP/RNBQKB1R w KQkq - 0 3";
const STARTPOS_FEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
/** The middlegame fixture (14 plies) and the canned top-1 Nc3. */
const MIDDLEGAME_SANS = ["e4", "e5", "Nf3", "Nc6", "Bc4", "Bc5", "O-O", "Nf6", "d3", "d6", "Bg5", "O-O", "Bxf6", "Qxf6"];
const MIDDLEGAME_UCI = ["e2e4", "e7e5", "g1f3", "b8c6", "f1c4", "f8c5", "e1g1", "g8f6", "d2d3", "d7d6", "c1g5", "e8g8", "g5f6", "d8f6"];

/**
 * Cumulative DOM mutations of the middlegame fixture (board `board-play-computer`).
 * Each entry adds ONE white + ONE black ply, so it stays the user's turn. Every
 * plie must be legal chess.js SAN — the adapter replays the move list and would
 * flag a mismatch otherwise. P4..P9 have no canned data in the stub; the proof
 * registers responses for them at runtime via POST /debug/canned.
 * Square encoding: chess.com `square-<file><rank>` (a1 = square-11).
 */
const MIDDLEGAME_MUTATIONS = [
  {
    sid: "p2", // 15.b1c3 15...h7h6 -> canned top-1 Nd5 (c3d5)
    sans: [...MIDDLEGAME_SANS, "Nc3", "h6"],
    pieces: [
      { classes: ["wn"], from: "square-21", to: "square-33" },
      { classes: ["bp"], from: "square-87", to: "square-86" },
    ],
  },
  {
    sid: "p3", // 16.h2h3 16...f8e8 -> canned top-1 Nd5 (the DELAYED request in the stale case)
    sans: [...MIDDLEGAME_SANS, "Nc3", "h6", "h3", "Re8"],
    pieces: [
      { classes: ["wp"], from: "square-82", to: "square-83" },
      { classes: ["br"], from: "square-68", to: "square-58" },
    ],
  },
  {
    sid: "p4", // 17.a2a4 17...c8e6 -> registered canned Ng5 (the fast request that wins)
    sans: [...MIDDLEGAME_SANS, "Nc3", "h6", "h3", "Re8", "a4", "Be6"],
    pieces: [
      { classes: ["wp"], from: "square-12", to: "square-14" },
      { classes: ["bb"], from: "square-38", to: "square-56" },
    ],
  },
  {
    sid: "p5", // 18.Qd1e2 18...a7a6 -> registered canned Rad1 (TTS-off silence case)
    sans: [...MIDDLEGAME_SANS, "Nc3", "h6", "h3", "Re8", "a4", "Be6", "Qe2", "a6"],
    pieces: [
      { classes: ["wq"], from: "square-41", to: "square-52" },
      { classes: ["bp"], from: "square-17", to: "square-16" },
    ],
  },
  {
    sid: "p6", // 19.Ra1d1 19...Kg8h8 -> registered canned Qd2 (assistant-off + error recovery)
    sans: [...MIDDLEGAME_SANS, "Nc3", "h6", "h3", "Re8", "a4", "Be6", "Qe2", "a6", "Rad1", "Kh8"],
    pieces: [
      { classes: ["wr"], from: "square-11", to: "square-41" },
      { classes: ["bk"], from: "square-78", to: "square-88" },
    ],
  },
];

/** Canned /analyze responses registered at runtime (keys are computed per case). */
const REGISTERED_CANNED = {
  p4: { moves: [{ uci: "f3g5", san: "Ng5", prob: 0.51234 }, { uci: "f3d4", san: "Nd4", prob: 0.2 }, { uci: "h2h4", san: "h4", prob: 0.1 }], wdl: { win: 0.42, draw: 0.07, loss: 0.51 }, model: "maia3-5m", elapsed_ms: 9.9 },
  p5: { moves: [{ uci: "a1d1", san: "Rad1", prob: 0.6 }, { uci: "e2e1", san: "Qe1", prob: 0.2 }, { uci: "h2h4", san: "h4", prob: 0.1 }], wdl: { win: 0.4, draw: 0.08, loss: 0.52 }, model: "maia3-5m", elapsed_ms: 10.1 },
  p6: { moves: [{ uci: "e2d2", san: "Qd2", prob: 0.55 }, { uci: "e2d1", san: "Qd1", prob: 0.25 }, { uci: "h2h4", san: "h4", prob: 0.1 }], wdl: { win: 0.44, draw: 0.07, loss: 0.49 }, model: "maia3-5m", elapsed_ms: 9.7 },
};

/* ------------------------------------------------------------------ args */

function parseArgs(argv) {
  const args = {
    chrome: null,
    extension: path.join(REPO_ROOT, "extension"),
    outDir: path.join(REPO_ROOT, "test/fixtures/captures/tts"),
    headful: false,
    keepProfile: false,
    timeoutMs: 45000,
    speechBackend: true,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const next = () => argv[++i];
    switch (flag) {
      case "--chrome": args.chrome = next(); break;
      case "--extension": args.extension = path.resolve(next()); break;
      case "--out-dir": args.outDir = path.resolve(next()); break;
      case "--headful": args.headful = true; break;
      case "--keep-profile": args.keepProfile = true; break;
      case "--timeout-ms": args.timeoutMs = Number(next()); break;
      case "--no-speech-backend": args.speechBackend = false; break;
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
 * Injected into every fixture page. Mutations are parameterised by board id
 * (the helpers are the same ones analyze-proof/overlay-proof use).
 */
const PAGE_HELPERS = String.raw`
globalThis.__humanplayProof = {
  boardSummary(boardId) {
    const board = document.getElementById(boardId);
    if (!board) return null;
    const pieces = [];
    for (const el of board.querySelectorAll(".piece")) {
      const token = [...el.classList].find((cls) => /^square-[1-8][1-8]$/.test(cls));
      if (token) pieces.push(token);
    }
    return { boardId, pieces: pieces.sort(), count: pieces.length };
  },
  movePiece(element, from, to) {
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
  },
  mutate(mutation, boardId) {
    const board = document.getElementById(boardId);
    if (!board) throw new Error("board not found: " + boardId);
    for (const piece of mutation.pieces) {
      const element = board.querySelector(".piece." + piece.classes[0] + "." + piece.from)
        ?? board.querySelector(".piece." + piece.from + "." + piece.classes[0]);
      if (!element) throw new Error("piece not found: " + piece.classes[0] + " " + piece.from);
      globalThis.__humanplayProof.movePiece(element, piece.from, piece.to);
    }
    globalThis.__humanplayProof.setMoveList(mutation.sans);
    return true;
  },
  setMoveList(sans) {
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
    document.querySelector("wc-simple-move-list .timestamps-with-base-time").innerHTML = rows.join("\n");
  },
};
true;
`;

/* ------------------------------------------------------------------ main */

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const sourceExtensionDir = path.resolve(args.extension);
  const summary = {
    tool: "tts-proof.mjs",
    generatedAt: new Date().toISOString(),
    chrome: args.chrome,
    extension: sourceExtensionDir,
    launch: { headless: !args.headful, speechBackendFlag: args.speechBackend ? "--enable-speech-dispatcher" : null },
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
  const pageSessions = new Map(); // sessionId -> { targetId, isolatedContextIds: Set }

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
        `port 8765 is serving ${JSON.stringify(existing)} — the TTS proof needs the fixture stub ` +
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
    const setDelay = (ms, count = 1) =>
      fetch(`${SERVER_ORIGIN}/debug/delay`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ms, count }),
      });
    const registerCanned = (key, response) =>
      fetch(`${SERVER_ORIGIN}/debug/canned`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key, response }),
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
      commands: sourceManifest.commands ?? null,
      hasAllUrls: JSON.stringify(sourceManifest).includes("<all_urls>"),
    };
    summary.checks.ttsFiles = Object.fromEntries(
      [
        "src/tts/move-speech.js",
        "src/tts/tts-policy.js",
        "src/tts/speaker.js",
        "src/tts/tts-service.js",
        "src/background/service-worker.js",
        "src/ui/sidepanel.js",
        "src/ui/sidepanel.html",
      ].map((file) => [file, sha256(readFileSync(path.join(sourceExtensionDir, file)))]),
    );

    variantDir = await mkdtemp(path.join(tmpdir(), "humanplay-tts-variant-"));
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
      codeFilesCompared: sourceFiles.length,
      codeFileMismatches: mismatches,
      codeIdentical: mismatches.length === 0,
    };
    if (mismatches.length) throw new Error(`manifest variant differs in code files: ${mismatches.join(", ")}`);

    const extensionId = unpackedExtensionId(variantDir);
    summary.checks.extensionId = extensionId;

    /* ------------------------------------------------------------- browser */

    profileDir = await mkdtemp(path.join(tmpdir(), "humanplay-tts-proof-"));
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
    if (args.speechBackend) launchArgs.unshift("--enable-speech-dispatcher");
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
    // Content-script isolated worlds (needed for the panel-closed case).
    cdp.on("Runtime.executionContextCreated", ({ context }, sessionId) => {
      const entry = pageSessions.get(sessionId);
      if (!entry) return;
      if (context.auxData?.isDefault === false && String(context.origin).startsWith("chrome-extension://")) {
        entry.isolatedContextIds.add(context.id);
      }
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

    // The worker attachment can go stale when Chrome reclaims the MV3 worker.
    let workerSessionId = swSession;
    const evaluateInWorker = async (expression) => {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
          const result = await cdp.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, workerSessionId);
          if (result.exceptionDetails) {
            throw new Error(`worker evaluation failed: ${result.exceptionDetails.exception?.description ?? result.exceptionDetails.text}`);
          }
          return result.result.value;
        } catch (error) {
          if (attempt === 2) throw error;
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

    /** The M6 debug hook (sw/tts-service.js) — the what-would-be-spoken record. */
    const readTts = () =>
      evaluateInWorker(`(() => {
        const d = globalThis.__humanplayTts;
        if (!d) return null;
        return {
          scope: d.scope, engine: d.engine, available: d.available,
          voices: d.voices, settings: d.settings,
          calls: d.calls, events: d.events,
          speakCount: d.speakCount, speakFailCount: d.speakFailCount, stopCount: d.stopCount,
          lastSpeak: d.lastSpeak, lastStop: d.lastStop,
          hotkey: d.hotkey, badge: d.badge,
          lastState: d.lastState, stateCount: d.stateCount,
          restoredFromSession: d.restoredFromSession,
        };
      })()`);
    const readTtsTestApiPresence = () => evaluateInWorker("typeof globalThis.__humanplayTtsTest?.invokeToggle === 'function'");

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
        'document.readyState === "complete" && !!document.getElementById("tts-enabled") && !!globalThis.__humanplayAnalysis',
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
      const ids = ["tts-enabled", "tts-rate", "tts-test", "tts-voices", "tts-note", "tts-status"];
      return {
        elements: Object.fromEntries(ids.map((id) => [id, Boolean(document.getElementById(id))])),
        enabledDefaultChecked: document.getElementById("tts-enabled")?.checked ?? null,
        rateOptions: [...(document.getElementById("tts-rate")?.options ?? [])].map((option) => option.value),
        inlineScripts: [...document.scripts].filter((script) => !script.src).length,
      };
    })()`);
    for (const [id, present] of Object.entries(summary.checks.panelUi.elements)) {
      if (!present) fail(`panel is missing #${id}`);
    }

    const readTtsPanel = () =>
      evaluateInPanel(`(() => {
        const debug = globalThis.__humanplayAnalysis;
        const tts = debug.tts;
        return {
          enabled: tts.enabled,
          rate: tts.rate,
          decision: tts.decision,
          decisions: tts.decisions,
          lastRequest: tts.lastRequest ? { text: tts.lastRequest.text, key: tts.lastRequest.key, reason: tts.lastRequest.reason, source: tts.lastRequest.source, options: tts.lastRequest.options, response: tts.lastRequest.response } : null,
          lastStop: tts.lastStop ? { reason: tts.lastStop.reason, source: tts.lastStop.source, response: tts.lastStop.response } : null,
          voices: tts.voices ? { ok: tts.voices.ok, engine: tts.voices.engine, count: tts.voices.count, note: tts.voices.note } : null,
          errors: tts.errors,
          lastError: tts.lastError,
          checkbox: document.getElementById("tts-enabled").checked,
          statusChip: document.getElementById("tts-status").textContent,
          rateValue: document.getElementById("tts-rate").value,
          voicesLine: document.getElementById("tts-voices").textContent,
          noteVisible: !document.getElementById("tts-note").hidden,
          noteText: document.getElementById("tts-note").textContent,
          staleDiscardCount: debug.staleDiscardCount,
          renderCount: debug.renderCount,
          status: debug.status,
          gate: debug.gate,
          lastRenderKey: debug.lastRenderKey,
          lastResult: debug.lastResult,
        };
      })()`);

    const readSuggestion = () =>
      evaluateInPanel(`(() => {
        const debug = globalThis.__humanplayAnalysis;
        const rows = [...document.querySelectorAll("#mx-moves .mx-move")].map((li) => ({
          san: li.dataset.san, uci: li.dataset.uci, prob: li.querySelector(".mx-prob")?.textContent ?? null,
        }));
        return {
          status: document.getElementById("mx-status").textContent,
          message: document.getElementById("mx-message").hidden ? null : document.getElementById("mx-message").textContent,
          rows,
          gate: debug.gate,
          debugStatus: debug.status,
          currentKey: debug.currentKey,
          lastRenderKey: debug.lastRenderKey,
          staleDiscardCount: debug.staleDiscardCount,
          renderCount: debug.renderCount,
        };
      })()`);

    const waitForSuggestion = (predicate, description, timeoutMs = args.timeoutMs) =>
      waitFor(description, async () => {
        const suggestion = await readSuggestion();
        return predicate(suggestion) ? suggestion : null;
      }, { timeoutMs, intervalMs: 60 });

    const panelScreenshot = async (name, { width = 420, height = 1100, scrollTo = null } = {}) => {
      await cdp.send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 2, mobile: false }, panelSession);
      if (scrollTo) {
        await evaluateInPanel(`(() => { const el = document.getElementById(${JSON.stringify(scrollTo)}); el?.scrollIntoView({ block: "center" }); return true; })()`);
      }
      await sleep(280);
      const shot = await cdp.send("Page.captureScreenshot", { format: "png" }, panelSession);
      await cdp.send("Emulation.clearDeviceMetricsOverride", {}, panelSession);
      if (scrollTo) await evaluateInPanel("window.scrollTo(0, 0), true");
      const target = path.join(args.outDir, name);
      await writeFile(target, Buffer.from(shot.data, "base64"));
      return path.relative(REPO_ROOT, target);
    };

    const evaluateInPage = async (session, expression, contextId = undefined) => {
      const result = await cdp.send(
        "Runtime.evaluate",
        { expression, awaitPromise: true, returnByValue: true, ...(contextId ? { contextId } : {}) },
        session,
      );
      if (result.exceptionDetails) {
        throw new Error(`page evaluation failed: ${result.exceptionDetails.exception?.description ?? result.exceptionDetails.text}`);
      }
      return result.result.value;
    };

    const openFixture = async (file) => {
      const target = await cdp.send("Target.createTarget", { url: `${origin}/chesscom/${file}` });
      openTargets.add(target.targetId);
      const session = (await cdp.send("Target.attachToTarget", { targetId: target.targetId, flatten: true })).sessionId;
      sessionRole.set(session, "page");
      const entry = { targetId: target.targetId, isolatedContextIds: new Set() };
      pageSessions.set(session, entry);
      await cdp.send("Page.enable", {}, session);
      await cdp.send("Runtime.enable", {}, session);
      await cdp.send("Log.enable", {}, session);
      await waitFor(`${file} load`, async () => {
        const result = await cdp.send("Runtime.evaluate", { expression: 'document.readyState === "complete"', returnByValue: true }, session);
        return result.result.value === true;
      }, { timeoutMs: args.timeoutMs });
      await evaluateInPage(session, PAGE_HELPERS);
      await cdp.send("Target.activateTarget", { targetId: target.targetId });
      return { targetId: target.targetId, session, url: `${origin}/chesscom/${file}`, isolatedContextIds: entry.isolatedContextIds };
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

    const mutate = async (session, mutation, boardId = "board-play-computer") =>
      evaluateInPage(session, `(() => {
        globalThis.__humanplayProof.mutate(${JSON.stringify(mutation)}, ${JSON.stringify(boardId)});
        return Date.now();
      })()`);

    /** The strictest evidence: the SW hook (what was actually spoken). */
    const speakRecords = (tts) => (tts?.calls ?? []).filter((call) => call.kind === "speak");
    const stopRecords = (tts) => (tts?.calls ?? []).filter((call) => call.kind === "stop");
    const speaksWithText = (tts, text) => speakRecords(tts).filter((call) => call.text === text);
    const speaksWithKey = (tts, keySuffix) => speakRecords(tts).filter((call) => String(call.key ?? "").endsWith(keySuffix));
    const waitForSpeak = (predicate, description, timeoutMs = args.timeoutMs) =>
      waitFor(description, async () => {
        const tts = await readTts();
        const match = speakRecords(tts).find((call) => predicate(call, tts));
        return match ? { call: match, tts } : null;
      }, { timeoutMs, intervalMs: 80 });

    const keySuffixFor = (uciList) => `${uciList.join(" ")}|2400|2400|3`;
    /**
     * The startpos fixture has no history, so its /analyze request is
     * board-only: fen + EMPTY moves (the requested key is the start position).
     */
    const STARTPOS_KEY = `${STARTPOS_FEN}||2400|2400|3`;

    /* -------------------------------------------------------------------- */
    /* CASE T1 — suggestion ready -> exactly 1 speak (startpos, canned e4)  */
    /* -------------------------------------------------------------------- */

    await mkdir(args.outDir, { recursive: true });
    summary.checks.ttsTestApiPresent = await readTtsTestApiPresence();

    const t1 = { pass: true, failures: [], screenshots: [] };
    summary.cases["tts-startpos-speak"] = t1;
    let startpos = null;
    try {
      const assert = (condition, message) => {
        if (!condition) {
          t1.pass = false;
          t1.failures.push(message);
        }
      };

      // Enable TTS before any suggestion exists: nothing may be spoken yet.
      await evaluateInPanel('document.getElementById("tts-enabled").click(), true');
      await waitFor("settings.ttsEnabled persisted", async () =>
        (await evaluateInPanel('chrome.storage.local.get("settings").then((s) => s.settings?.ttsEnabled ?? null)')) === true);
      t1.beforeSuggestion = await readTtsPanel();
      assert(t1.beforeSuggestion.decision?.reason === "no-suggestion", `toggle-on with no suggestion: ${t1.beforeSuggestion.decision?.reason}`);

      startpos = await openFixture("startpos.html");
      await refreshPanelState(startpos.targetId, STARTPOS_FEN, "startpos");
      const suggestion = await waitForSuggestion((s) => s.debugStatus === "ready" && s.rows[0]?.san === "e4", "the startpos suggestion (e4)");
      const spoken = await waitForSpeak((call) => call.text === "e-pawn to e4", "the e->e4 speak");
      const tts = spoken.tts;
      t1.suggestion = { san: suggestion.rows[0].san, uci: suggestion.rows[0].uci, key: suggestion.lastRenderKey };
      t1.speak = spoken.call;
      t1.panel = await readTtsPanel();
      t1.voices = tts.voices;

      const key = STARTPOS_KEY;
      assert(speaksWithKey(tts, key).length === 1, `expected exactly 1 speak for the startpos key, got ${speaksWithKey(tts, key).length}`);
      assert(spoken.call.engine === "chrome.tts", `engine: ${spoken.call.engine}`);
      assert(spoken.call.options?.enqueue === false, `enqueue: ${JSON.stringify(spoken.call.options)}`);
      assert(spoken.call.options?.rate === 1, `rate: ${JSON.stringify(spoken.call.options)}`);
      assert(spoken.call.reason === "suggestion", `reason: ${spoken.call.reason}`);
      assert(String(spoken.call.key).endsWith(key), `key: ${spoken.call.key}`);
      assert(spoken.call.san === "e4" && spoken.call.uci === "e2e4", `san/uci: ${spoken.call.san}/${spoken.call.uci}`);

      // Interruption policy: a stop() immediately before every speak.
      const stopsBefore = stopRecords(tts).filter((stop) => stop.reason === "before-speak" && stop.atEpochMs <= spoken.call.atEpochMs);
      assert(stopsBefore.length >= 1, "no stop(before-speak) recorded before the speak");
      t1.stopBeforeSpeak = stopsBefore.at(-1) ?? null;
      t1.panelDecision = t1.panel.decision;
      const speakDecisions = (t1.panel.decisions ?? []).filter((decision) => decision.speak === true && decision.text === "e-pawn to e4");
      t1.panelSpeakDecisions = speakDecisions.length;
      assert(speakDecisions.length === 1, `panel speak decisions for the startpos move: ${speakDecisions.length}`);
      assert(speakDecisions[0]?.key === spoken.call.key, `panel decision key: ${speakDecisions[0]?.key}`);

      // chrome.tts lifecycle events (recorded; soft evidence, see the header).
      t1.ttsEvents = tts.events.filter((event) => event.text === "e-pawn to e4");

      t1.screenshots.push(await panelScreenshot("tts-card-on.png", { scrollTo: "tts-card" }));
      t1.screenshots.push(await panelScreenshot("tts-startpos-suggestion.png", { height: 1250 }));
      console.log(t1.pass
        ? `PASS tts-startpos-speak: 1 speak "${spoken.call.text}" (${spoken.call.engine}, rate ${spoken.call.options?.rate}, enqueue:false) for e2e4, stop(before-speak) recorded`
        : `FAIL tts-startpos-speak: ${t1.failures.join("; ")}`);
    } catch (error) {
      t1.pass = false;
      t1.failures.push(String(error?.message ?? error));
    }
    if (!t1.pass) for (const failure of t1.failures) fail(failure, "tts-startpos-speak");
    await writeFile(path.join(args.outDir, "tts-startpos-speak.json"), `${JSON.stringify(t1, null, 2)}\n`);

    /* -------------------------------------------------------------------- */
    /* CASE T2 — same position re-emitted -> NO second speak (dedupe)       */
    /* -------------------------------------------------------------------- */

    const t2 = { pass: true, failures: [], screenshots: [] };
    summary.cases["tts-dedupe"] = t2;
    if (!startpos) {
      t2.pass = false;
      t2.failures.push("the startpos tab is not available (T1 failed)");
    } else {
      try {
        const assert = (condition, message) => {
          if (!condition) {
            t2.pass = false;
            t2.failures.push(message);
          }
        };
        const before = await readSuggestion();
        for (let i = 0; i < 3; i += 1) {
          await evaluateInPanel('document.getElementById("cc-refresh").click(), true');
          await sleep(250);
        }
        const after = await readSuggestion();
        const tts = await readTts();
        const panel = await readTtsPanel();
        t2.renderCountBefore = before.renderCount;
        t2.renderCountAfter = after.renderCount;
        t2.speaksForStartpos = speaksWithKey(tts, STARTPOS_KEY).length;
        t2.speakCount = tts.speakCount;
        t2.lastDecision = panel.decision;
        t2.duplicateDecisions = (panel.decisions ?? []).filter((decision) => decision.reason === "duplicate").length;

        assert(after.renderCount > before.renderCount, `no re-render happened (${before.renderCount} -> ${after.renderCount})`);
        assert(t2.speaksForStartpos === 1, `expected still 1 speak for the startpos key, got ${t2.speaksForStartpos}`);
        assert(t2.lastDecision?.reason === "duplicate", `the re-render decision should be "duplicate": ${t2.lastDecision?.reason}`);
        assert(t2.duplicateDecisions >= 3, `expected >= 3 duplicate decisions, got ${t2.duplicateDecisions}`);
        console.log(t2.pass
          ? `PASS tts-dedupe: renderCount ${before.renderCount} -> ${after.renderCount}, still exactly 1 speak for the startpos key (decision "duplicate")`
          : `FAIL tts-dedupe: ${t2.failures.join("; ")}`);
      } catch (error) {
        t2.pass = false;
        t2.failures.push(String(error?.message ?? error));
      }
    }
    if (!t2.pass) for (const failure of t2.failures) fail(failure, "tts-dedupe");
    await writeFile(path.join(args.outDir, "tts-dedupe.json"), `${JSON.stringify(t2, null, 2)}\n`);

    /* -------------------------------------------------------------------- */
    /* CASE T3 — new position -> stop() then a new speak (order + timing)   */
    /* -------------------------------------------------------------------- */

    const t3 = { pass: true, failures: [], screenshots: [] };
    summary.cases["tts-new-position"] = t3;
    let middlegame = null;
    try {
      const assert = (condition, message) => {
        if (!condition) {
          t3.pass = false;
          t3.failures.push(message);
        }
      };
      middlegame = await openFixture("middlegame-castling.html");
      await refreshPanelState(middlegame.targetId, "r1b2rk1/ppp2ppp/2np1q2/2b1p3/2B1P3/3P1N2/PPP2PPP/RN1Q1RK1 w - - 0 8", "middlegame");
      await waitForSuggestion((s) => s.debugStatus === "ready" && s.rows[0]?.san === "Nc3", "the middlegame suggestion (Nc3)");
      const first = await waitForSpeak((call) => call.text === "Knight to c3", "the Nc3 speak");
      t3.initial = { text: first.call.text, key: first.call.key };
      assert(speaksWithKey(first.tts, keySuffixFor(MIDDLEGAME_UCI)).length === 1, "expected exactly 1 speak for the 14-ply middlegame key");

      // Delay the NEXT /analyze so the stop -> speak transition is observable.
      await setDelay(700, 1);
      const t0 = await mutate(middlegame.session, MIDDLEGAME_MUTATIONS[0]);
      const second = await waitForSpeak((call) => call.text === "Knight to d5", "the Nd5 speak for the new position");
      const p2Key = keySuffixFor([...MIDDLEGAME_UCI, "b1c3", "h7h6"]);
      t3.afterMove = { text: second.call.text, key: second.call.key };
      t3.mutationToSpeakMs = second.call.atEpochMs - t0;
      t3.delayMs = 700;
      const stopsBefore = stopRecords(second.tts).filter((stop) => stop.reason === "before-speak" && stop.atEpochMs <= second.call.atEpochMs && stop.atEpochMs >= t0);
      t3.stopBeforeSpeak = stopsBefore.at(-1) ?? null;
      t3.speaksForNewKey = speaksWithKey(second.tts, p2Key).length;
      const orderedPair = t3.stopBeforeSpeak && t3.stopBeforeSpeak.atEpochMs <= second.call.atEpochMs;

      assert(String(second.call.key).endsWith(p2Key), `new-position key: ${second.call.key}`);
      assert(t3.speaksForNewKey === 1, `expected 1 speak for the new key, got ${t3.speaksForNewKey}`);
      assert(Boolean(orderedPair), `stop(before-speak) not ordered before the speak: ${JSON.stringify(t3.stopBeforeSpeak)} vs ${second.call.atEpochMs}`);
      assert(t3.mutationToSpeakMs <= 2500, `mutation -> speak took ${t3.mutationToSpeakMs} ms`);
      assert(first.call.key !== second.call.key, "the position key did not change with the move");
      t3.screenshots.push(await panelScreenshot("tts-middlegame-on.png", { scrollTo: "tts-card" }));
      console.log(t3.pass
        ? `PASS tts-new-position: "${first.call.text}" -> stop(${t3.stopBeforeSpeak.atEpochMs}) + speak("${second.call.text}") in ${t3.mutationToSpeakMs} ms after the mutation`
        : `FAIL tts-new-position: ${t3.failures.join("; ")}`);
    } catch (error) {
      t3.pass = false;
      t3.failures.push(String(error?.message ?? error));
    }
    if (!t3.pass) for (const failure of t3.failures) fail(failure, "tts-new-position");
    await writeFile(path.join(args.outDir, "tts-new-position.json"), `${JSON.stringify(t3, null, 2)}\n`);

    /* -------------------------------------------------------------------- */
    /* CASE T4 — toggle off mid-flow -> stop + silence; on again -> speaks   */
    /* -------------------------------------------------------------------- */

    const t4 = { pass: true, failures: [], screenshots: [] };
    summary.cases["tts-toggle-midflow"] = t4;
    if (!middlegame) {
      t4.pass = false;
      t4.failures.push("the middlegame tab is not available (T3 failed)");
    } else {
      try {
        const assert = (condition, message) => {
          if (!condition) {
            t4.pass = false;
            t4.failures.push(message);
          }
        };
        const speaksBefore = (await readTts()).speakCount;

        // (a) toggle OFF mid-flow -> an immediate stop, no further speaks.
        await evaluateInPanel('document.getElementById("tts-enabled").click(), true');
        const stopped = await waitFor("the toggle-off stop record", async () => {
          const tts = await readTts();
          const stop = stopRecords(tts).filter((record) => record.reason === "toggle-off" && record.source === "panel").at(-1);
          return stop ? { stop, tts } : null;
        });
        t4.toggleOffStop = stopped.stop;
        const panelOff = await readTtsPanel();
        assert(panelOff.enabled === false, "panel TTS state still on");
        assert(panelOff.decision?.speak === false, `decision after toggle-off: ${JSON.stringify(panelOff.decision)}`);
        t4.screenshots.push(await panelScreenshot("tts-card-off.png", { scrollTo: "tts-card" }));

        // (b) toggle ON again -> speaks the current (still current!) suggestion.
        await evaluateInPanel('document.getElementById("tts-enabled").click(), true');
        const backOn = await waitForSpeak((call) => call.reason === "toggle-on", "the toggle-on speak");
        const panelOn = await readTtsPanel();
        t4.toggleOnSpeak = backOn.call;
        t4.panelAfterOn = { decision: panelOn.decision, statusChip: panelOn.statusChip, enabled: panelOn.enabled };
        t4.speakCountDelta = backOn.tts.speakCount - speaksBefore;
        t4.screenshots.push(await panelScreenshot("tts-middlegame-on-again.png", { scrollTo: "tts-card" }));

        assert(stopped.stop.source === "panel", `stop source: ${stopped.stop.source}`);
        assert(backOn.call.text === "Knight to d5", `toggle-on text: ${backOn.call.text}`);
        assert(backOn.call.key === t3.afterMove.key, `toggle-on key: ${backOn.call.key} vs ${t3.afterMove.key}`);
        assert(panelOn.decision?.force === true, "the toggle-on decision should be forced");
        assert(panelOn.enabled === true && panelOn.statusChip === "on", `panel state after re-enabling: ${JSON.stringify(t4.panelAfterOn)}`);
        console.log(t4.pass
          ? `PASS tts-toggle-midflow: off -> stop("toggle-off") + silence; on -> speak("${backOn.call.text}", reason toggle-on)`
          : `FAIL tts-toggle-midflow: ${t4.failures.join("; ")}`);
      } catch (error) {
        t4.pass = false;
        t4.failures.push(String(error?.message ?? error));
      }
    }
    if (!t4.pass) for (const failure of t4.failures) fail(failure, "tts-toggle-midflow");
    await writeFile(path.join(args.outDir, "tts-toggle-midflow.json"), `${JSON.stringify(t4, null, 2)}\n`);

    /* -------------------------------------------------------------------- */
    /* CASE T5 — stale suggestion -> no speak                               */
    /* -------------------------------------------------------------------- */

    const t5 = { pass: true, failures: [], screenshots: [] };
    summary.cases["tts-stale"] = t5;
    if (!middlegame) {
      t5.pass = false;
      t5.failures.push("the middlegame tab is not available (T3 failed)");
    } else {
      try {
        const assert = (condition, message) => {
          if (!condition) {
            t5.pass = false;
            t5.failures.push(message);
          }
        };
        // Register the canned response for P4 (its key is exact: 20 plies).
        const p4Uci = [...MIDDLEGAME_UCI, "b1c3", "h7h6", "h2h3", "f8e8", "a2a4", "c8e6"];
        await registerCanned(`${STARTPOS_FEN}|${p4Uci.join(" ")}|2400|2400|3`, REGISTERED_CANNED.p4);

        const before = await readSuggestion();
        // P3 -> P4: the P3 request gets the artificial delay; wait until it has
        // ARRIVED at the stub (it is sleeping) before the P4 mutation lands —
        // otherwise the adapter's 150 ms debounce collapses both mutations into
        // one state change and there is nothing stale to discard.
        await setDelay(900, 1);
        const t0 = await mutate(middlegame.session, MIDDLEGAME_MUTATIONS[1]);
        await waitFor("the delayed (P3) request to arrive at the server", async () => {
          const stats = await serverStats();
          return String(stats.lastArrivalKey ?? "").includes("h2h3 f8e8") ? stats : null;
        }, { timeoutMs: 10000, intervalMs: 40 });
        const t1m = await mutate(middlegame.session, MIDDLEGAME_MUTATIONS[2]);
        const fast = await waitForSpeak((call) => call.text === "Knight to g5", "the P4 speak (fast request)", 30000);
        // Let the delayed P3 response land and be discarded.
        await sleep(1200);
        const tts = await readTts();
        const after = await readSuggestion();
        const p3Key = keySuffixFor([...MIDDLEGAME_UCI, "b1c3", "h7h6", "h2h3", "f8e8"]);
        t5.staleKey = p3Key;
        t5.staleMutations = { p3At: t0, p4At: t1m };
        t5.fastSpeak = fast.call;
        t5.speaksForStaleKey = speaksWithKey(tts, p3Key).length;
        t5.staleDiscardsBefore = before.staleDiscardCount;
        t5.staleDiscardsAfter = after.staleDiscardCount;
        t5.speaksForFastKey = speaksWithKey(tts, keySuffixFor(p4Uci)).length;
        t5.lastSpeak = tts.lastSpeak;
        t5.fastLatencyMs = fast.call.atEpochMs - t1m;

        assert(t5.speaksForStaleKey === 0, `the stale position was spoken ${t5.speaksForStaleKey} time(s)`);
        assert(t5.speaksForFastKey === 1, `expected 1 speak for the fast position, got ${t5.speaksForFastKey}`);
        assert(after.staleDiscardCount > before.staleDiscardCount, `no stale discard happened (${before.staleDiscardCount} -> ${after.staleDiscardCount})`);
        assert(tts.lastSpeak?.text === "Knight to g5", `the last speak should be the fast position's: ${tts.lastSpeak?.text}`);
        console.log(t5.pass
          ? `PASS tts-stale: delayed response discarded (stale ${before.staleDiscardCount}->${after.staleDiscardCount}), spoken only "${fast.call.text}" for the winning position`
          : `FAIL tts-stale: ${t5.failures.join("; ")}`);
      } catch (error) {
        t5.pass = false;
        t5.failures.push(String(error?.message ?? error));
      }
    }
    if (!t5.pass) for (const failure of t5.failures) fail(failure, "tts-stale");
    await writeFile(path.join(args.outDir, "tts-stale.json"), `${JSON.stringify(t5, null, 2)}\n`);

    /* -------------------------------------------------------------------- */
    /* CASE T6 — clear cases: opponent's turn, assistant off, server error, */
    /*            game over -> no speak (with recoveries)                   */
    /* -------------------------------------------------------------------- */

    const t6 = { pass: true, failures: [], screenshots: [] };
    summary.cases["tts-clear-cases"] = t6;
    if (!middlegame) {
      t6.pass = false;
      t6.failures.push("the middlegame tab is not available (T3 failed)");
    } else {
      try {
        const assert = (condition, message) => {
          if (!condition) {
            t6.pass = false;
            t6.failures.push(message);
          }
        };

        /* (a) opponent's turn: auto silence + manual analysis silence. */
        const flipped = await openFixture("flipped-black.html");
        await refreshPanelState(flipped.targetId, FLIPPED_FEN, "flipped-black");
        const waiting = await waitForSuggestion((s) => s.gate === "waiting", "the waiting gate (opponent's turn)");
        await sleep(700); // give a wrong auto-speak time to appear
        const ttsWaiting = await readTts();
        const flippedKey = keySuffixFor(["e2e4", "c7c5", "g1f3", "d7d6"]);
        t6.opponentTurn = { gate: waiting.gate, speaksForFlippedKey: speaksWithKey(ttsWaiting, flippedKey).length };
        assert(t6.opponentTurn.speaksForFlippedKey === 0, `spoke on the opponent's turn (${t6.opponentTurn.speaksForFlippedKey})`);

        // Manual "Analyze now" on the opponent's turn also stays silent.
        await evaluateInPanel('document.getElementById("mx-analyze").click(), true');
        await waitForSuggestion((s) => s.debugStatus === "ready" && s.rows[0]?.san === "d4", "the manual d4 suggestion");
        await sleep(500);
        const ttsManual = await readTts();
        const panelManual = await readTtsPanel();
        t6.manualOnTheirTurn = { speaksForFlippedKey: speaksWithKey(ttsManual, flippedKey).length, decision: panelManual.decision };
        assert(t6.manualOnTheirTurn.speaksForFlippedKey === 0, "spoke after a manual analysis on the opponent's turn");
        assert(panelManual.decision?.reason === "not-your-turn", `manual decision: ${panelManual.decision?.reason}`);
        t6.screenshots.push(await panelScreenshot("tts-opponent-turn.png", { scrollTo: "tts-card" }));
        await closeTarget(flipped.targetId);

        /* (b) assistant off -> no analysis, no speak; back on -> speaks. */
        await cdp.send("Target.activateTarget", { targetId: middlegame.targetId });
        await evaluateInPanel('document.getElementById("cc-refresh").click(), true');
        await waitForSpeak((call) => call.text === "Knight to g5", "the middlegame P4 speak before the assistant-off case");

        const p5Uci = [...MIDDLEGAME_UCI, "b1c3", "h7h6", "h2h3", "f8e8", "a2a4", "c8e6", "d1e2", "a7a6"];
        await registerCanned(`${STARTPOS_FEN}|${p5Uci.join(" ")}|2400|2400|3`, REGISTERED_CANNED.p5);

        await evaluateInPanel('document.getElementById("assistant-toggle").click(), true');
        await waitFor("the assistant off gate", async () => (await readSuggestion()).gate === "off");
        const statsBefore = await serverStats();
        const tOff = await mutate(middlegame.session, MIDDLEGAME_MUTATIONS[3]);
        await sleep(900);
        const statsAfter = await serverStats();
        const ttsOff = await readTts();
        const p5Key = keySuffixFor(p5Uci);
        t6.assistantOff = {
          requestedKeys: { before: statsBefore?.byKey ?? null, after: statsAfter?.byKey ?? null },
          speaksForP5Key: speaksWithKey(ttsOff, p5Key).length,
        };
        assert(t6.assistantOff.speaksForP5Key === 0, "spoke with the assistant off");
        assert(!(statsAfter?.byKey?.[`${STARTPOS_FEN}|${p5Uci.join(" ")}|2400|2400|3`] > 0), "the assistant-off state still requested an analysis");

        await evaluateInPanel('document.getElementById("assistant-toggle").click(), true');
        const recovered = await waitForSpeak((call) => call.text === "a-rook to d1", "the recovery speak after the assistant came back on");
        t6.assistantOnRecovery = { text: recovered.call.text, reason: recovered.call.reason, key: recovered.call.key };
        assert(recovered.call.reason === "suggestion", `recovery reason: ${recovered.call.reason}`);

        /* (c) server error -> no speak; recovery after the server is ok again. */
        const p6Uci = [...p5Uci, "a1d1", "g8h8"];
        await registerCanned(`${STARTPOS_FEN}|${p6Uci.join(" ")}|2400|2400|3`, REGISTERED_CANNED.p6);
        await setMode("bad_request");
        await mutate(middlegame.session, MIDDLEGAME_MUTATIONS[4]);
        await waitForSuggestion((s) => /invalid input/.test(s.message ?? ""), "the invalid-input error card");
        await sleep(500);
        const ttsError = await readTts();
        const p6Key = keySuffixFor(p6Uci);
        t6.serverError = { speaksForP6Key: speaksWithKey(ttsError, p6Key).length, cardMessage: (await readSuggestion()).message };
        assert(t6.serverError.speaksForP6Key === 0, "spoke on a server error");
        await setMode("ok");
        await evaluateInPanel('document.getElementById("mx-analyze").click(), true');
        const afterError = await waitForSpeak((call) => call.text === "Queen to d2", "the post-error recovery speak");
        t6.serverErrorRecovery = { text: afterError.call.text, key: afterError.call.key };

        /* (d) game over -> no speak. */
        const gameover = await openFixture("gameover-checkmate.html");
        await refreshPanelState(gameover.targetId, GAMEOVER_FEN, "gameover-checkmate");
        const gameoverSuggestion = await waitForSuggestion((s) => s.debugStatus === "game-over", "the game-over card");
        await sleep(500);
        const ttsGameover = await readTts();
        const panelGameover = await readTtsPanel();
        const gameoverKey = keySuffixFor(["e2e4", "e7e5", "f1c4", "b8c6", "d1h5", "g8f6", "h5f7"]);
        t6.gameOver = {
          cardMessage: gameoverSuggestion.message,
          speaksForGameoverKey: speaksWithKey(ttsGameover, gameoverKey).length,
          decision: panelGameover.decision,
        };
        assert(t6.gameOver.speaksForGameoverKey === 0, "spoke at game over");
        assert(panelGameover.decision?.reason === "no-suggestion", `game-over decision: ${panelGameover.decision?.reason}`);
        t6.screenshots.push(await panelScreenshot("tts-gameover.png", { scrollTo: "maia-card" }));
        await closeTarget(gameover.targetId);

        console.log(t6.pass
          ? `PASS tts-clear-cases: opponent's turn (auto+manual), assistant off, 400 error, game over -> 0 speaks; recoveries spoke "a-rook to d1" + "Queen to d2"`
          : `FAIL tts-clear-cases: ${t6.failures.join("; ")}`);
      } catch (error) {
        t6.pass = false;
        t6.failures.push(String(error?.message ?? error));
        await setMode("ok").catch(() => {});
      }
    }
    if (!t6.pass) for (const failure of t6.failures) fail(failure, "tts-clear-cases");
    await writeFile(path.join(args.outDir, "tts-clear-cases.json"), `${JSON.stringify(t6, null, 2)}\n`);

    /* -------------------------------------------------------------------- */
    /* CASE T7 — hotkey (chrome.commands) + toolbar badge                   */
    /* -------------------------------------------------------------------- */

    const t7 = { pass: true, failures: [], screenshots: [], note: null };
    summary.cases["tts-hotkey-and-badge"] = t7;
    try {
      const assert = (condition, message) => {
        if (!condition) {
          t7.pass = false;
          t7.failures.push(message);
        }
      };
      const commands = await evaluateInWorker("chrome.commands.getAll().then((commands) => commands)");
      t7.commands = commands;
      const toggle = (commands ?? []).find((command) => command.name === "toggle-tts");
      assert(Boolean(toggle), "chrome.commands.getAll() has no toggle-tts command");
      assert(toggle && toggle.description.includes("TTS"), `command description: ${toggle?.description}`);
      t7.command = toggle ?? null;

      // Put the panel back on a live suggestion, so "toggling on speaks" has
      // something current to say (the game-over case above left none).
      if (middlegame) {
        await cdp.send("Target.activateTarget", { targetId: middlegame.targetId });
        await evaluateInPanel('document.getElementById("cc-refresh").click(), true');
        await waitFor("a current suggestion before the hotkey case", async () => {
          const panel = await readTtsPanel();
          return panel.lastResult?.moves?.length > 0 ? panel : null;
        });
      }

      const badgeOn = {
        text: await evaluateInWorker("chrome.action.getBadgeText({}).then((text) => text)"),
        background: await evaluateInWorker("chrome.action.getBadgeBackgroundColor({}).then((color) => color)"),
        textColor: await evaluateInWorker("chrome.action.getBadgeTextColor({}).then((color) => color)"),
      };
      t7.badgeWhileOn = badgeOn;
      assert(badgeOn.text === "TTS", `badge while TTS is on: ${JSON.stringify(badgeOn.text)}`);

      // Invoke the handler (off) — real key presses cannot be dispatched via CDP.
      const toggledOff = await evaluateInWorker("globalThis.__humanplayTtsTest.invokeToggle()");
      await sleep(400);
      const settingsOff = await evaluateInPanel('chrome.storage.local.get("settings").then((s) => s.settings ?? null)');
      const badgeOff = await evaluateInWorker("chrome.action.getBadgeText({}).then((text) => text)");
      const panelAfterHotkeyOff = await readTtsPanel();
      t7.toggleOff = { handler: toggledOff, settings: settingsOff, badgeText: badgeOff, panel: { enabled: panelAfterHotkeyOff.enabled, checkbox: panelAfterHotkeyOff.checkbox, statusChip: panelAfterHotkeyOff.statusChip, decision: panelAfterHotkeyOff.decision } };
      assert(settingsOff?.ttsEnabled === false, `hotkey did not disable TTS: ${JSON.stringify(settingsOff)}`);
      assert(badgeOff === "", `badge after toggling off: ${JSON.stringify(badgeOff)}`);
      assert(panelAfterHotkeyOff.enabled === false && panelAfterHotkeyOff.checkbox === false, "panel did not sync the hotkey toggle (chrome.storage.onChanged)");
      t7.screenshots.push(await panelScreenshot("tts-card-off-hotkey.png", { scrollTo: "tts-card" }));

      const toggledOn = await evaluateInWorker("globalThis.__humanplayTtsTest.invokeToggle()");
      await sleep(600);
      const settingsOn = await evaluateInPanel('chrome.storage.local.get("settings").then((s) => s.settings ?? null)');
      const badgeOnAgain = await evaluateInWorker("chrome.action.getBadgeText({}).then((text) => text)");
      const ttsAfterHotkeyOn = await readTts();
      const hotkeySpeak = speakRecords(ttsAfterHotkeyOn).filter((call) => call.reason === "toggle-on" && call.source === "hotkey").at(-1) ?? null;
      t7.toggleOn = { handler: toggledOn, settings: settingsOn, badgeText: badgeOnAgain, hotkeySpeak };
      assert(settingsOn?.ttsEnabled === true, `hotkey did not re-enable TTS: ${JSON.stringify(settingsOn)}`);
      assert(badgeOnAgain === "TTS", `badge after toggling on: ${JSON.stringify(badgeOnAgain)}`);
      assert(Boolean(hotkeySpeak), "toggling TTS on via the hotkey did not speak the current suggestion");

      t7.badge = await readTts().then((tts) => tts.badge);
      t7.note =
        "The toolbar badge is browser UI: CDP cannot screenshot it and this machine has no " +
        "screen-capture tool (GNOME screenshot D-Bus is denied, no import/xwd/ffmpeg). " +
        "Badge state is asserted through chrome.action.getBadgeText/getBadgeBackgroundColor/" +
        "getBadgeTextColor and left as a manual check (a green \"TTS\" chip on the toolbar icon). " +
        "Real Ctrl+Shift+Y key presses cannot be dispatched through CDP either — the handler " +
        "(__humanplayTtsTest.invokeToggle, the exact function chrome.commands.onCommand calls) " +
        "is invoked instead; pressing the physical shortcut is a manual check.";
      console.log(t7.pass
        ? `PASS tts-hotkey-and-badge: command "${toggle?.name}" (${toggle?.shortcut || "no shortcut assigned"}), badge "TTS" <-> "" asserted, hotkey toggle synced to the panel + spoke "${hotkeySpeak?.text}"`
        : `FAIL tts-hotkey-and-badge: ${t7.failures.join("; ")}`);
    } catch (error) {
      t7.pass = false;
      t7.failures.push(String(error?.message ?? error));
    }
    if (!t7.pass) for (const failure of t7.failures) fail(failure, "tts-hotkey-and-badge");
    await writeFile(path.join(args.outDir, "tts-hotkey-badge.json"), `${JSON.stringify(t7, null, 2)}\n`);

    /* -------------------------------------------------------------------- */
    /* CASE T8 — voices availability + the actionable note + Speak test     */
    /* -------------------------------------------------------------------- */

    const t8 = { pass: true, failures: [], screenshots: [] };
    summary.cases["tts-voices-and-test"] = t8;
    try {
      const assert = (condition, message) => {
        if (!condition) {
          t8.pass = false;
          t8.failures.push(message);
        }
      };
      const tts = await readTts();
      const panel = await readTtsPanel();
      t8.voices = tts.voices;
      t8.panelVoices = { line: panel.voicesLine, noteVisible: panel.noteVisible, noteText: panel.noteText };
      assert(tts.voices?.engine === "chrome.tts", `voices engine: ${tts.voices?.engine}`);
      if (tts.voices?.count === 0) {
        assert(panel.noteVisible === true, "no voices but the actionable note is hidden");
        assert(/speech-dispatcher/.test(panel.noteText) && /--enable-speech-dispatcher/.test(panel.noteText), `note text: ${panel.noteText}`);
        assert(/voices: 0/.test(panel.voicesLine), `voices line: ${panel.voicesLine}`);
        t8.actionableNote = panel.noteText;
      } else {
        assert(panel.noteVisible === false, `voices exist (${tts.voices?.count}) but a no-voice note is shown`);
        assert(new RegExp(`voices: ${tts.voices?.count}`).test(panel.voicesLine), `voices line: ${panel.voicesLine}`);
      }

      // The Speak test button must go through the same SW pipeline (and speak
      // even though getVoices() is empty — the audio backend is a separate
      // concern; recording the request is what this milestone guarantees).
      await evaluateInPanel('document.getElementById("tts-test").click(), true');
      const test = await waitForSpeak((call) => call.reason === "test" && call.text === "Knight to f3", "the Speak test utterance");
      t8.testSpeak = test.call;
      t8.screenshots.push(await panelScreenshot("tts-voices.png", { scrollTo: "tts-card" }));
      assert(test.call.options?.rate === 1, `test speak rate: ${JSON.stringify(test.call.options)}`);
      console.log(t8.pass
        ? `PASS tts-voices-and-test: chrome.tts voices=${tts.voices?.count}, ${tts.voices?.count === 0 ? "actionable note asserted" : "voices line asserted"}, Speak test -> "${test.call.text}"`
        : `FAIL tts-voices-and-test: ${t8.failures.join("; ")}`);
    } catch (error) {
      t8.pass = false;
      t8.failures.push(String(error?.message ?? error));
    }
    if (!t8.pass) for (const failure of t8.failures) fail(failure, "tts-voices-and-test");
    await writeFile(path.join(args.outDir, "tts-voices-and-test.json"), `${JSON.stringify(t8, null, 2)}\n`);

    /* -------------------------------------------------------------------- */
    /* CASE T9 — PANEL CLOSED (architecture-critical)                       */
    /* -------------------------------------------------------------------- */

    const t9 = { pass: true, failures: [], screenshots: [], note: null };
    summary.cases["tts-panel-closed"] = t9;
    if (!startpos) {
      t9.pass = false;
      t9.failures.push("the startpos tab is not available (T1 failed)");
    } else {
      try {
        const assert = (condition, message) => {
          if (!condition) {
            t9.pass = false;
            t9.failures.push(message);
          }
        };
        // Bring the startpos tab back and make it the "last state tab".
        await refreshPanelState(startpos.targetId, STARTPOS_FEN, "startpos before the panel closes");
        await sleep(400);
        const contextsBefore = await evaluateInWorker("chrome.runtime.getContexts({}).then((contexts) => contexts.map((c) => ({ type: c.contextType, url: c.documentUrl })))");
        t9.contextsBefore = contextsBefore;

        // Close the panel document — the analysis/policy document is gone now.
        const panelClosedAt = Date.now();
        await closeTarget(panelTarget.targetId);
        await sleep(700);
        const contextsClosed = await evaluateInWorker("chrome.runtime.getContexts({}).then((contexts) => contexts.map((c) => ({ type: c.contextType, url: c.documentUrl })))");
        t9.contextsAfterClose = contextsClosed;
        assert(
          !(contextsClosed ?? []).some((context) => String(context.url ?? "").includes("sidepanel.html")),
          `the panel document is still alive: ${JSON.stringify(contextsClosed)}`,
        );

        const ttsBeforeMutation = await readTts();
        const speaksBefore = ttsBeforeMutation.speakCount;

        // Drive a REAL position change (the fixture page mutates; the adapter
        // re-emits; the SW tracks states) with no panel document alive.
        const e4Fen = "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1";
        await mutate(startpos.session, { sans: ["e4"], pieces: [{ classes: ["wp"], from: "square-52", to: "square-54" }] }, "board-single");
        const state = await waitFor("the service worker to see the new GameState (panel closed)", async () => {
          const tts = await readTts();
          return tts?.lastState?.fen === e4Fen ? tts.lastState : null;
        });
        t9.stateWithPanelClosed = state;
        const ttsAfterMutation = await readTts();
        t9.speaksWhilePanelClosed = ttsAfterMutation.speakCount - speaksBefore;
        // No analysis loop exists without the panel document: no new suggestion
        // can appear, so nothing new may be spoken either.
        assert(t9.speaksWhilePanelClosed === 0, `spoke ${t9.speaksWhilePanelClosed} time(s) with no panel and no analysis`);

        // Now speak **through the production messaging path** with the panel
        // gone: send the runtime message from the content-script isolated world
        // of the fixture page (the real sender context available here).
        const isolated = [...(startpos.isolatedContextIds ?? [])].at(-1) ?? null;
        assert(isolated !== null, "no content-script isolated world found for the startpos page");
        const messageResult = await evaluateInPage(
          startpos.session,
          `chrome.runtime.sendMessage(${JSON.stringify({
            type: "humanplay:tts-speak",
            text: "Knight to f3",
            key: "panel-closed-proof",
            san: "Nf3",
            uci: "g1f3",
            reason: "panel-closed-proof",
            source: "content-script",
            options: { rate: 1.2 },
          })}).then((response) => JSON.stringify(response), (error) => JSON.stringify({ ok: false, error: String(error) }))`,
          isolated,
        );
        const panelClosedSpeak = await waitForSpeak((call) => call.reason === "panel-closed-proof", "the panel-closed speak record");
        t9.panelClosedSpeak = { response: JSON.parse(messageResult ?? "null"), call: panelClosedSpeak.call };
        assert(panelClosedSpeak.call.text === "Knight to f3", `panel-closed text: ${panelClosedSpeak.call.text}`);
        assert(panelClosedSpeak.call.engine === "chrome.tts", `panel-closed engine: ${panelClosedSpeak.call.engine}`);
        assert(panelClosedSpeak.call.options?.rate === 1.2, `panel-closed rate: ${JSON.stringify(panelClosedSpeak.call.options)}`);
        const stopAfterClose = stopRecords(panelClosedSpeak.tts)
          .filter((stop) => stop.reason === "before-speak" && stop.atEpochMs >= panelClosedAt && stop.atEpochMs <= panelClosedSpeak.call.atEpochMs)
          .at(-1) ?? null;
        t9.stopAfterPanelClosed = stopAfterClose;
        assert(Boolean(stopAfterClose), "the stop-before-speak policy did not run for the panel-closed speak");

        // The hotkey + badge keep working with no panel document.
        const hotkeyOff = await evaluateInWorker("globalThis.__humanplayTtsTest.invokeToggle()");
        await sleep(300);
        const badgeWithPanelClosed = await evaluateInWorker("chrome.action.getBadgeText({}).then((text) => text)");
        const hotkeyOn = await evaluateInWorker("globalThis.__humanplayTtsTest.invokeToggle()");
        await sleep(300);
        const badgeBackOn = await evaluateInWorker("chrome.action.getBadgeText({}).then((text) => text)");
        t9.hotkeyWithPanelClosed = { off: hotkeyOff, badgeOff: badgeWithPanelClosed, on: hotkeyOn, badgeOn: badgeBackOn };
        assert(badgeWithPanelClosed === "" && badgeBackOn === "TTS", `badge flapping with the panel closed: ${JSON.stringify(t9.hotkeyWithPanelClosed)}`);

        t9.screenshots.push(await pageScreenshot(startpos.session, "tts-panel-closed-board.png"));
        t9.note =
          "With the side panel closed the extension has no analysis loop (M4 lives in the panel document), " +
          "so no NEW suggestion can be produced — that is why no automatic speak may appear after the panel " +
          "closes. What this case proves — the architecture-critical property — is that the speak EXECUTION " +
          "path (service worker + chrome.tts + the debug record + the badge) is fully independent of the panel " +
          "document: the SW still tracks the GameState stream, and a speak routed through the production " +
          "runtime-message path (sent from the content-script isolated world, the only remaining sender with " +
          "the panel gone) is performed and recorded.";
        console.log(t9.pass
          ? `PASS tts-panel-closed: panel gone (${(contextsClosed ?? []).length} contexts left), SW tracked the new FEN, speak "${panelClosedSpeak.call.text}" recorded via ${JSON.parse(messageResult ?? "{}")?.engine ?? "chrome.tts"}, badge flapped "" <-> "TTS"`
          : `FAIL tts-panel-closed: ${t9.failures.join("; ")}`);
      } catch (error) {
        t9.pass = false;
        t9.failures.push(String(error?.message ?? error));
      }
    }
    if (!t9.pass) for (const failure of t9.failures) fail(failure, "tts-panel-closed");
    await writeFile(path.join(args.outDir, "tts-panel-closed.json"), `${JSON.stringify(t9, null, 2)}\n`);

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
    summary.checks.extensionConsoleClean =
      summary.console.panelErrors.length === 0 &&
      summary.console.serviceWorkerErrors.length === 0 &&
      summary.console.pageErrors.length === 0;
    if (!summary.checks.extensionConsoleClean) fail("extension console reported errors — see summary.console");

    const harmlessNetworkLog = (text) => /ERR_UNKNOWN_URL_SCHEME|favicon\.ico|status of 40[04]|ERR_ABORTED/.test(text);
    const ownNetworkRequest = (text) => /127\.0\.0\.1:8765/.test(text) || text.includes(origin);
    const unexpectedNetworkErrors = summary.console.networkErrors.filter(
      (entry) => ownNetworkRequest(entry.text) && !harmlessNetworkLog(entry.text),
    );
    summary.checks.expectedNetworkErrors = summary.console.networkErrors.map((entry) => entry.text);
    if (unexpectedNetworkErrors.length) {
      fail(`unexpected network errors: ${unexpectedNetworkErrors.map((entry) => entry.text).join(" | ")}`);
    }

    // Synthesis-backend evidence: did chrome.tts actually fire start/end for an
    // utterance (needs a speech backend; on this box --enable-speech-dispatcher)?
    const finalTts = await readTts();
    const eventTypes = [...new Set((finalTts?.events ?? []).map((event) => event.type))];
    summary.checks.synthesisBackend = {
      flag: args.speechBackend ? "--enable-speech-dispatcher" : null,
      eventTypes,
      synthesized: eventTypes.includes("start"),
      voices: finalTts?.voices ?? null,
      note: "start/end events mean Chrome reached a speech backend; without one every utterance " +
        "reports {type:\"error\"} and the record is still written (assertions do not depend on audio).",
    };
    summary.checks.finalTtsHook = {
      engine: finalTts?.engine,
      scope: finalTts?.scope,
      speakCount: finalTts?.speakCount,
      stopCount: finalTts?.stopCount,
      speakFailCount: finalTts?.speakFailCount,
      calls: finalTts?.calls,
    };

    summary.ok = summary.failures.length === 0;
    await writeFile(path.join(args.outDir, "tts-proof.json"), `${JSON.stringify(summary, null, 2)}\n`);
    console.log(
      `\n${summary.ok ? "ALL TTS CASES PASSED" : `FAILURES (${summary.failures.length}):\n - ` + summary.failures.join("\n - ")}` +
        `\nproof: ${path.relative(REPO_ROOT, path.join(args.outDir, "tts-proof.json"))}` +
        `\nspeaks recorded: ${finalTts?.speakCount ?? "?"}, stops: ${finalTts?.stopCount ?? "?"}, ` +
        `voices: ${finalTts?.voices?.count ?? "?"}, synthesis backend: ${summary.checks.synthesisBackend.synthesized ? "yes" : "no"}`,
    );
    if (!summary.ok) process.exitCode = 1;
  } catch (error) {
    console.error(`tts-proof failed: ${error.message}`);
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

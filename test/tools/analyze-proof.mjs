#!/usr/bin/env node
/**
 * analyze-proof.mjs — objective end-to-end proof for the M4 analysis loop
 * (game state -> Maia -> panel).
 *
 * Two modes, same harness (CDP against a real Chrome for Testing):
 *
 *   STUB mode (default)
 *     Spawns `test/tools/fixture_server.py` on 127.0.0.1:8765 and proves the whole
 *     panel pipeline against CANNED responses recorded from the real server
 *     (identical schema): top-3 + WDL rendering, position-key dedupe, the stale
 *     guard (a slow old response must not overwrite a newer position), assistant
 *     off gating, the server-offline retry + UI, HTTP 400 detail, the game-over
 *     message, opponent-turn manual analysis with flipped WDL, and the Elo
 *     change -> re-analyze behaviour (top move d4 @1200 vs h3 @2600).
 *
 *   REAL mode (`--real`)
 *     Expects the REAL Maia server (`cd server && .venv/bin/python -m uvicorn
 *     app:app --host 127.0.0.1 --port 8765`) and proves that the panel's top-3
 *     (SAN + probability) for the middlegame fixture EQUALS a direct
 *     `curl /analyze` for the same FEN + UCI history (within rounding), records
 *     engine/round-trip/state->render/mutation->render latencies, re-proves
 *     game-over, and shows Elo 1200 vs 2600 changing the top move on the Ruy
 *     Lopez fixture (panel AND curl).
 *
 * Every run loads a temporary COPY of the extension whose manifest additionally
 * matches the content script (and its web-accessible modules) on the fixture
 * origin — the shipped manifest stays chess.com-only; all code files are
 * hash-compared and the report carries `codeIdentical` (same technique as
 * test/tools/adapter-proof.mjs).
 *
 * Usage:
 *   node test/tools/analyze-proof.mjs --chrome <path> [--real|--stub]
 *     [--extension extension] [--out-dir test/fixtures/captures/analyze]
 *     [--headful] [--keep-profile] [--timeout-ms 45000]
 *
 * Exit code is non-zero when any assertion fails. Writes one proof JSON + panel
 * screenshots into test/fixtures/captures/analyze/.
 */

import { execFile, spawn } from "node:child_process";
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
const ANALYZE_URL = `${SERVER_ORIGIN}/analyze`;
const STARTPOS_FEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

/** Ground truth of the fixtures (test/fixtures/generate_chesscom.py). */
const MIDDLEGAME_FEN = "r1b2rk1/ppp2ppp/2np1q2/2b1p3/2B1P3/3P1N2/PPP2PPP/RN1Q1RK1 w - - 0 8";
const MIDDLEGAME_UCI = ["e2e4", "e7e5", "g1f3", "b8c6", "f1c4", "f8c5", "e1g1", "g8f6", "d2d3", "d7d6", "c1g5", "e8g8", "g5f6", "d8f6"];
const MIDDLEGAME_SANS = ["e4", "e5", "Nf3", "Nc6", "Bc4", "Bc5", "O-O", "Nf6", "d3", "d6", "Bg5", "O-O", "Bxf6", "Qxf6"];
const RUY_FEN = "r1bq1rk1/2p1bppp/p1np1n2/1p2p3/4P3/1BP2N2/PP1P1PPP/RNBQR1K1 w - - 1 9";
const RUY_UCI = ["e2e4", "e7e5", "g1f3", "b8c6", "f1b5", "a7a6", "b5a4", "g8f6", "e1g1", "f8e7", "f1e1", "b7b5", "a4b3", "d7d6", "c2c3", "e8g8"];
const GAMEOVER_FEN = "r1bqkb1r/pppp1Qpp/2n2n2/4p3/2B1P3/8/PPPP1PPP/RNB1K1NR b KQkq - 0 4";

/**
 * DOM mutations of the middlegame fixture (board id `board-play-computer`):
 * each entry adds ONE white + ONE black ply, so the side to move stays white
 * (= the user) and the panel auto-analyzes every time.
 * Square encoding = chess.com's `square-<file><rank>` (a1 = square-11).
 */
const MIDDLEGAME_MUTATIONS = [
  {
    // 15.b1c3 (wn square-21 -> square-33) 15...h7h6 (bp square-87 -> square-86)
    // -> the SLOW request in the stale-guard case; canned top-3 Nd5/h3/a3.
    sid: "p2",
    sans: [...MIDDLEGAME_SANS, "Nc3", "h6"],
    pieces: [
      { classes: ["wn"], from: "square-21", to: "square-33" },
      { classes: ["bp"], from: "square-87", to: "square-86" },
    ],
  },
  {
    // 16.h2h3 (wp square-82 -> square-83) 16...f8e8 (br square-68 -> square-58)
    // -> the FAST request that must win; canned top-3 Nd5/a3/Nh2 (no h3 row).
    sid: "p3",
    sans: [...MIDDLEGAME_SANS, "Nc3", "h6", "h3", "Re8"],
    pieces: [
      { classes: ["wp"], from: "square-82", to: "square-83" },
      { classes: ["br"], from: "square-68", to: "square-58" },
    ],
  },
  {
    // 17.a2a4 (wp square-12 -> square-14) 17...c8e6 (bb square-38 -> square-56)
    // -> a position the stub has NO canned data for (the 400 / gating case).
    sid: "p4",
    sans: [...MIDDLEGAME_SANS, "Nc3", "h6", "h3", "Re8", "a4", "Be6"],
    pieces: [
      { classes: ["wp"], from: "square-12", to: "square-14" },
      { classes: ["bb"], from: "square-38", to: "square-56" },
    ],
  },
];

/**
 * The middlegame 14-ply response recorded from the real server (identical to
 * fixture_server.py CANNED). The mismatch case registers it for the mutated
 * BOARD-ONLY key at runtime via POST /debug/canned.
 */
const MIDDLEGAME_CANNED_RESPONSE = {
  moves: [
    { uci: "b1c3", san: "Nc3", prob: 0.585868 },
    { uci: "h2h3", san: "h3", prob: 0.16039 },
    { uci: "c2c3", san: "c3", prob: 0.129875 },
  ],
  wdl: { win: 0.386213, draw: 0.073429, loss: 0.540358 },
  model: "maia3-5m",
  elapsed_ms: 10.63,
};

/** Injected page helpers: move a piece's square class + inline style, rebuild the move list. */
const MUTATION_HELPERS = `
  function __humanplayMovePiece(element, from, to) {
    element.classList.remove(from);
    element.classList.add(to);
    const match = /^square-(\\d)(\\d)$/.exec(to);
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

/* ------------------------------------------------------------------ args */

function parseArgs(argv) {
  const args = {
    chrome: null,
    extension: path.join(REPO_ROOT, "extension"),
    outDir: path.join(REPO_ROOT, "test/fixtures/captures/analyze"),
    mode: "stub",
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
      case "--real": args.mode = "real"; break;
      case "--stub": args.mode = "stub"; break;
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

/** Direct `curl /analyze` — the real-mode ground-truth comparison. */
function curlAnalyze(payload, { timeoutMs = 30000 } = {}) {
  const command = `curl -s ${ANALYZE_URL} -H 'Content-Type: application/json' -d '${JSON.stringify(payload)}'`;
  return new Promise((resolve) => {
    const startedAt = Date.now();
    execFile(
      "curl",
      ["-s", "-X", "POST", ANALYZE_URL, "-H", "Content-Type: application/json", "-d", JSON.stringify(payload)],
      { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 },
      (error, stdout, stderr) => {
        let parsed = null;
        try {
          parsed = JSON.parse(stdout);
        } catch {
          parsed = null;
        }
        resolve({
          command,
          wallMs: Date.now() - startedAt,
          ok: !error && parsed !== null,
          body: parsed,
          stdout: stdout.slice(0, 400),
          stderr: String(stderr).slice(0, 400),
          error: error ? String(error.message) : null,
        });
      },
    );
  });
}

/* ------------------------------------------------------------------ main */

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const stub = args.mode === "stub";
  const sourceExtensionDir = path.resolve(args.extension);
  const summary = {
    tool: "analyze-proof.mjs",
    mode: args.mode,
    generatedAt: new Date().toISOString(),
    chrome: args.chrome,
    extension: sourceExtensionDir,
    checks: {},
    cases: {},
    latencies: {},
    console: {},
    failures: [],
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

    if (stub) {
      const existing = await serverHealth().catch(() => null);
      if (existing?.model === "fixture-static-server") {
        summary.checks.analysisServer = { mode: "stub (already running)", health: existing };
      } else if (existing) {
        throw new Error(
          `port 8765 is serving ${JSON.stringify(existing)} — stub mode needs test/tools/fixture_server.py ` +
            "there. Stop the real server first (or pass --real).",
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
      summary.checks.canned = {
        source: "test/tools/fixture_server.py CANNED — responses recorded from the real Maia server (schema-identical)",
        keyFormat: "<fen>|<uci moves>|<elo_self>|<elo_oppo>|<top_k>",
      };
    } else {
      const health = await serverHealth();
      if (!String(health.model ?? "").includes("maia")) {
        throw new Error(
          `--real needs the Maia server on 127.0.0.1:8765 (got ${JSON.stringify(health)}). Start it: ` +
            "cd server && .venv/bin/python -m uvicorn app:app --host 127.0.0.1 --port 8765",
        );
      }
      summary.checks.analysisServer = { mode: "real", health };
    }

    const serverStats = async () => {
      const response = await fetch(`${SERVER_ORIGIN}/debug/stats`, { cache: "no-store" });
      return response.ok ? response.json() : null;
    };
    const setMode = async (mode) => {
      await fetch(`${SERVER_ORIGIN}/debug/mode`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode }),
      });
    };
    const setDelay = async (ms, count) => {
      await fetch(`${SERVER_ORIGIN}/debug/delay`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ms, count }),
      });
    };

    /* ------------------------------------------------------ manifest variant */

    const manifestPath = path.join(sourceExtensionDir, "manifest.json");
    const sourceManifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    summary.checks.manifest = {
      path: path.relative(REPO_ROOT, manifestPath),
      sha256: sha256(readFileSync(manifestPath)),
      version: sourceManifest.version,
      host_permissions: sourceManifest.host_permissions,
      content_scripts: sourceManifest.content_scripts,
      hasAllUrls: JSON.stringify(sourceManifest).includes("<all_urls>"),
    };
    summary.checks.analysisFiles = Object.fromEntries(
      ["src/analysis/analyze-client.js", "src/ui/sidepanel.js", "src/ui/sidepanel.html"].map(
        (file) => [file, sha256(readFileSync(path.join(sourceExtensionDir, file)))],
      ),
    );

    variantDir = await mkdtemp(path.join(tmpdir(), "humanplay-analyze-variant-"));
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
      reason:
        "the shipped manifest injects the content script on chess.com only; a headless fixture served from " +
        `${origin} can never match, so the test loads a copy whose content_scripts/web_accessible_resources ` +
        "also match that origin. Everything else, including every code file, is identical.",
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

    profileDir = await mkdtemp(path.join(tmpdir(), "humanplay-analyze-proof-"));
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
      const ready = await evaluateInPanel('document.readyState === "complete" && !!document.getElementById("mx-analyze") && !!globalThis.__humanplayAnalysis');
      return ready === true;
    }, { timeoutMs: args.timeoutMs });

    summary.checks.panelUi = await evaluateInPanel(`(() => {
      const ids = ["assistant-toggle", "mx-status", "mx-message", "mx-moves", "mx-wdl-box", "mx-wdl-label",
                   "mx-wdl-info", "mx-wdl-win", "mx-wdl-draw", "mx-wdl-loss", "mx-warn", "mx-meta", "mx-analyze",
                   "elo-self", "elo-oppo", "elo-reset", "cc-chip", "cc-fen", "cc-refresh", "cc-snapshot",
                   "cc-color-setting", "capture-button", "record-button", "server-chip", "refresh-health"];
      const present = {};
      for (const id of ids) present[id] = !!document.getElementById(id);
      return {
        present,
        missing: ids.filter((id) => !present[id]),
        inlineScripts: [...document.scripts].filter((script) => !script.src).length,
        eloSelf: document.getElementById("elo-self").value,
        eloOppo: document.getElementById("elo-oppo").value,
        toggleOn: document.getElementById("assistant-toggle").checked,
      };
    })()`);
    if (summary.checks.panelUi.missing.length) fail(`panel is missing elements: ${summary.checks.panelUi.missing.join(", ")}`);

    /** Everything the suggestion card shows + the debug hook (read-only mirror). */
    const readSuggestion = () =>
      evaluateInPanel(`(() => {
        const rows = [...document.querySelectorAll("#mx-moves .mx-move")].map((li) => ({
          rank: li.dataset.rank,
          san: li.dataset.san,
          uci: li.dataset.uci,
          prob: li.querySelector(".mx-prob")?.textContent ?? null,
          barWidth: li.querySelector(".mx-bar > span")?.style.width ?? null,
          top: li.classList.contains("mx-top"),
        }));
        const debug = globalThis.__humanplayAnalysis;
        return {
          status: document.getElementById("mx-status").textContent,
          statusClass: document.getElementById("mx-status").className,
          message: document.getElementById("mx-message").hidden ? null : document.getElementById("mx-message").textContent,
          messageClass: document.getElementById("mx-message").className,
          rowsHidden: document.getElementById("mx-moves").hidden,
          rows,
          wdlHidden: document.getElementById("mx-wdl-box").hidden,
          wdlLabel: document.getElementById("mx-wdl-label").textContent,
          wdlTitle: document.getElementById("mx-wdl-info").title,
          wdlWin: document.getElementById("mx-wdl-win").textContent,
          wdlDraw: document.getElementById("mx-wdl-draw").textContent,
          wdlLoss: document.getElementById("mx-wdl-loss").textContent,
          meta: document.getElementById("mx-meta").hidden ? null : document.getElementById("mx-meta").textContent,
          warn: document.getElementById("mx-warn").hidden ? null : document.getElementById("mx-warn").textContent,
          gate: debug.gate,
          debugStatus: debug.status,
          currentKey: debug.currentKey,
          lastRenderKey: debug.lastRenderKey,
          requestCount: debug.requestCount,
          renderCount: debug.renderCount,
          staleDiscardCount: debug.staleDiscardCount,
          lastStateToRenderMs: debug.lastStateToRenderMs,
          lastRoundTripMs: debug.lastRoundTripMs,
          lastEngineMs: debug.lastEngineMs,
          lastRenderAtEpochMs: debug.lastRenderAtEpochMs,
          lastResult: debug.lastResult,
          lastError: debug.lastError,
          toggleOn: document.getElementById("assistant-toggle").checked,
        };
      })()`);

    /** Wait for a suggestion state (evaluated in Node — the panel may be a background tab). */
    const waitForSuggestion = (predicate, description, timeoutMs = args.timeoutMs) =>
      waitFor(description, async () => {
        const suggestion = await readSuggestion();
        return predicate(suggestion) ? suggestion : null;
      }, { timeoutMs, intervalMs: 60 });

    const panelScreenshot = async (name) => {
      await cdp.send("Emulation.setDeviceMetricsOverride", { width: 400, height: 900, deviceScaleFactor: 2, mobile: false }, panelSession);
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
      await cdp.send("Target.activateTarget", { targetId: target.targetId });
      return { targetId: target.targetId, session };
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

    const mutateMiddlegame = (session, mutation) =>
      evaluateInPage(session, `(() => {
        ${MUTATION_HELPERS}
        globalThis.__humanplayMutationAt = Date.now();
        __humanplayMutate(${JSON.stringify(mutation)});
        return globalThis.__humanplayMutationAt;
      })()`);

    const expect = (record, condition, message) => {
      if (!condition) {
        record.pass = false;
        record.failures.push(message);
      }
    };

    await mkdir(args.outDir, { recursive: true });

    /* ===================================================================== */
    /* STUB MODE                                                             */
    /* ===================================================================== */

    if (stub) {
      /* ---------------------------------------------------------- case S1 */
      const s1 = { pass: true, failures: [], url: null, top3: null, wdl: null, meta: null, screenshot: null, latency: {}, requests: null };
      summary.cases["stub-startpos-auto"] = s1;
      try {
        await fetch(`${SERVER_ORIGIN}/debug/reset`, { method: "POST" });
        const before = await serverStats();
        const { targetId } = await openFixture("startpos.html");
        s1.url = `${origin}/chesscom/startpos.html`;

        const suggestion = await waitForSuggestion(
          (s) => s.debugStatus === "ready" && s.rows.length === 3 && s.rows[0]?.san === "e4",
          "the startpos suggestion (e4 top-1)",
        );
        s1.top3 = suggestion.rows;
        s1.wdl = { win: suggestion.wdlWin, draw: suggestion.wdlDraw, loss: suggestion.wdlLoss, label: suggestion.wdlLabel, tooltip: suggestion.wdlTitle };
        s1.meta = suggestion.meta;
        s1.latency = { stateToRenderMs: suggestion.lastStateToRenderMs, roundTripMs: suggestion.lastRoundTripMs, engineMs: suggestion.lastEngineMs };
        s1.debug = { gate: suggestion.gate, status: suggestion.debugStatus, lastResult: suggestion.lastResult };

        expect(s1, suggestion.rows[0].san === "e4" && suggestion.rows[1].san === "d4" && suggestion.rows[2].san === "Nf3", `SAN order: ${suggestion.rows.map((row) => row.san).join(", ")}`);
        expect(s1, suggestion.rows[0].uci === "e2e4" && suggestion.rows[1].uci === "d2d4" && suggestion.rows[2].uci === "g1f3", "UCI list");
        expect(s1, suggestion.rows[0].prob === "46.5%" && suggestion.rows[1].prob === "33.9%" && suggestion.rows[2].prob === "8.2%", `1-decimal probabilities: ${suggestion.rows.map((row) => row.prob).join(", ")}`);
        expect(s1, Math.abs(parseFloat(suggestion.rows[0].barWidth) - 46.4864) < 0.01, `top-1 bar width ${suggestion.rows[0].barWidth}`);
        expect(s1, parseFloat(suggestion.rows[0].barWidth) > parseFloat(suggestion.rows[1].barWidth), "bar order");
        expect(s1, suggestion.rows[0].top === true && suggestion.rows[1].top === false, "only rank 1 is highlighted");
        expect(s1, suggestion.rows[0].rank === "1" && suggestion.rows[2].rank === "3", "rank labels");
        expect(s1, suggestion.wdlWin === "win 47.6%" && suggestion.wdlDraw === "draw 6.8%" && suggestion.wdlLoss === "loss 45.6%", `WDL chips: ${suggestion.wdlWin} / ${suggestion.wdlDraw} / ${suggestion.wdlLoss}`);
        expect(s1, suggestion.wdlLabel === "human outcome prediction (you)", `WDL label: ${suggestion.wdlLabel}`);
        expect(s1, /NOT an engine evaluation/.test(suggestion.wdlTitle ?? ""), "WDL tooltip says it is not an engine evaluation");
        expect(s1, /Maia-3's human-model value head/.test(suggestion.wdlTitle ?? ""), "WDL tooltip explains the value head");
        expect(s1, /model maia3-5m/.test(suggestion.meta ?? ""), `meta model: ${suggestion.meta}`);
        expect(s1, /engine 15\.4 ms/.test(suggestion.meta ?? ""), `meta engine elapsed: ${suggestion.meta}`);
        expect(s1, /round-trip \d+\.\d ms/.test(suggestion.meta ?? ""), `meta round-trip: ${suggestion.meta}`);
        expect(s1, /board only · no history/.test(suggestion.meta ?? ""), `meta history for the start position: ${suggestion.meta}`);
        expect(s1, Number.isFinite(suggestion.lastStateToRenderMs) && suggestion.lastStateToRenderMs <= 1500, `state->render latency ${suggestion.lastStateToRenderMs} ms`);
        s1.screenshot = await panelScreenshot("stub-startpos-suggestion.png");

        // Dedupe: the exact same state again (Refresh state) must not re-request.
        for (let i = 0; i < 2; i += 1) {
          await refreshPanelState(targetId, STARTPOS_FEN, "startpos");
          await sleep(250);
        }
        const after = await serverStats();
        const refreshed = await readSuggestion();
        s1.requests = { before: before.analyzeRequests, after: after.analyzeRequests, delta: after.analyzeRequests - before.analyzeRequests, fromCache: refreshed.lastResult?.fromCache ?? null, lastRenderKey: refreshed.lastRenderKey };
        expect(s1, s1.requests.delta === 1, `identical state re-emits must not re-request (requests: ${s1.requests.delta})`);
        expect(s1, s1.requests.fromCache === true, "the re-emit was served from the cache");
        s1.dedupeScreenshot = await panelScreenshot("stub-startpos-dedupe.png");
        console.log(s1.pass
          ? `PASS stub-startpos-auto: e4 46.5% / d4 33.9% / Nf3 8.2%, WDL 47.6/6.8/45.6, 1 request for 3 state renders, state->render ${Math.round(suggestion.lastStateToRenderMs)} ms`
          : `FAIL stub-startpos-auto: ${s1.failures.join("; ")}`);
        await closeTarget(targetId);
      } catch (error) {
        s1.pass = false;
        s1.failures.push(String(error?.message ?? error));
      }
      if (!s1.pass) for (const failure of s1.failures) fail(failure, "stub-startpos-auto");
      await writeFile(path.join(args.outDir, "stub-startpos-auto.json"), `${JSON.stringify(s1, null, 2)}\n`);

      /* ---------------------------------------------------------- case S2 */
      const s2 = { pass: true, failures: [], top3: null, meta: null, screenshot: null };
      summary.cases["stub-middlegame-history"] = s2;
      let middlegame = null;
      try {
        const { targetId, session } = await openFixture("middlegame-castling.html");
        middlegame = { targetId, session };
        const suggestion = await waitForSuggestion(
          (s) => s.debugStatus === "ready" && s.rows.length === 3 && s.rows[0]?.san === "Nc3",
          "the middlegame suggestion (Nc3 top-1)",
        );
        s2.top3 = suggestion.rows;
        s2.meta = suggestion.meta;
        s2.wdl = { win: suggestion.wdlWin, draw: suggestion.wdlDraw, loss: suggestion.wdlLoss };
        s2.latency = { stateToRenderMs: suggestion.lastStateToRenderMs, roundTripMs: suggestion.lastRoundTripMs, engineMs: suggestion.lastEngineMs };
        s2.key = suggestion.lastRenderKey;
        expect(s2, suggestion.rows.map((row) => row.san).join(",") === "Nc3,h3,c3", `top-3 ${suggestion.rows.map((row) => row.san)}`);
        expect(s2, suggestion.rows.map((row) => row.prob).join(",") === "58.6%,16.0%,13.0%", `probs ${suggestion.rows.map((row) => row.prob)}`);
        expect(s2, suggestion.rows[0].top === true, "top-1 highlighted");
        expect(s2, /14 moves · replayed/.test(suggestion.meta ?? ""), `meta history: ${suggestion.meta}`);
        expect(s2, suggestion.wdlWin === "win 38.6%" && suggestion.wdlLoss === "loss 54.0%", "WDL chips");
        expect(s2, suggestion.lastStateToRenderMs <= 1500, `state->render ${suggestion.lastStateToRenderMs} ms`);
        s2.screenshot = await panelScreenshot("stub-middlegame-suggestion.png");
        console.log(s2.pass
          ? `PASS stub-middlegame-history: Nc3 58.6%, 14 moves replayed, state->render ${Math.round(suggestion.lastStateToRenderMs)} ms`
          : `FAIL stub-middlegame-history: ${s2.failures.join("; ")}`);
      } catch (error) {
        s2.pass = false;
        s2.failures.push(String(error?.message ?? error));
      }
      if (!s2.pass) for (const failure of s2.failures) fail(failure, "stub-middlegame-history");
      await writeFile(path.join(args.outDir, "stub-middlegame-history.json"), `${JSON.stringify(s2, null, 2)}\n`);

      /* ---------------------------------------------- case S3: stale guard */
      const s3 = { pass: true, failures: [], slowKey: null, fastKey: null, before: null, rendered: null, afterSlow: null, latency: {} };
      summary.cases["stub-stale-guard"] = s3;
      if (!middlegame) {
        s3.pass = false;
        s3.failures.push("the middlegame fixture tab is not available (S2 failed)");
      } else {
        try {
          const before = await serverStats();
          await setDelay(900, 1); // the NEXT /analyze (P2) sleeps 900 ms before answering
          const slowMutationAt = await mutateMiddlegame(middlegame.session, MIDDLEGAME_MUTATIONS[0]);
          // Wait until the SLOW request has ARRIVED at the server (it is sleeping).
          await waitFor("the delayed (old) request to arrive at the server", async () => {
            const stats = await serverStats();
            return String(stats.lastArrivalKey ?? "").includes("b1c3 h7h6") ? stats : null;
          }, { timeoutMs: 10000, intervalMs: 40 });
          s3.slowKey = (await serverStats()).lastArrivalKey;

          const fastMutationAt = await mutateMiddlegame(middlegame.session, MIDDLEGAME_MUTATIONS[1]);
          const rendered = await waitForSuggestion(
            (s) => s.debugStatus === "ready" && s.rows.length === 3 && s.rows[2]?.san === "Nh2",
            "the newer (fast) position's suggestion (Nd5/a3/Nh2)",
          );
          s3.fastKey = rendered.lastRenderKey;
          s3.rendered = { rows: rendered.rows.map((row) => row.san), probs: rendered.rows.map((row) => row.prob), meta: rendered.meta };
          s3.latency = {
            mutationToRenderMs: rendered.lastRenderAtEpochMs - fastMutationAt,
            slowMutationTriggeredMsBefore: fastMutationAt - slowMutationAt,
            stateToRenderMs: rendered.lastStateToRenderMs,
          };
          expect(s3, rendered.rows.map((row) => row.san).join(",") === "Nd5,a3,Nh2", `newer rows ${rendered.rows.map((row) => row.san)}`);
          expect(s3, !rendered.rows.some((row) => row.san === "h3"), "the slow (older) position's row must not be present");
          expect(s3, String(rendered.lastRenderKey).includes("h2h3 f8e8"), `lastRenderKey is the newer position: …${String(rendered.lastRenderKey).slice(-60)}`);
          expect(s3, s3.latency.mutationToRenderMs <= 1500, `mutation->render ${s3.latency.mutationToRenderMs} ms`);

          // Now let the SLOW response land — it must be discarded, not rendered.
          await sleep(1200);
          const afterSlow = await readSuggestion();
          s3.afterSlow = { rows: afterSlow.rows.map((row) => row.san), lastRenderKey: afterSlow.lastRenderKey, staleDiscardCount: afterSlow.staleDiscardCount, status: afterSlow.status };
          expect(s3, afterSlow.rows.map((row) => row.san).join(",") === "Nd5,a3,Nh2", `rows after the slow response landed: ${afterSlow.rows.map((row) => row.san)}`);
          expect(s3, afterSlow.lastRenderKey === s3.fastKey, "the slow response did not replace the rendered key");
          expect(s3, afterSlow.staleDiscardCount >= 1, `staleDiscardCount ${afterSlow.staleDiscardCount}`);

          const after = await serverStats();
          s3.before = before.analyzeRequests;
          s3.requests = { delta: after.analyzeRequests - before.analyzeRequests, byKey: after.byKey };
          expect(s3, s3.requests.delta === 2, `two position changes = two requests (delta ${s3.requests.delta})`);
          s3.screenshot = await panelScreenshot("stub-stale-newer-wins.png");
          console.log(s3.pass
            ? `PASS stub-stale-guard: slow P2 discarded (stale=${afterSlow.staleDiscardCount}), P3 kept, mutation->render ${Math.round(s3.latency.mutationToRenderMs)} ms`
            : `FAIL stub-stale-guard: ${s3.failures.join("; ")}`);
        } catch (error) {
          s3.pass = false;
          s3.failures.push(String(error?.message ?? error));
        }
      }
      if (!s3.pass) for (const failure of s3.failures) fail(failure, "stub-stale-guard");
      await writeFile(path.join(args.outDir, "stub-stale-guard.json"), `${JSON.stringify(s3, null, 2)}\n`);

      /* ---------------------------------------- case S4: assistant off/on */
      const s4 = { pass: true, failures: [], offState: null, onState: null, screenshot: null };
      summary.cases["stub-assistant-off-gating"] = s4;
      if (!middlegame) {
        s4.pass = false;
        s4.failures.push("the middlegame fixture tab is not available (S2 failed)");
      } else {
        try {
          const before = await serverStats();
          await evaluateInPanel('document.getElementById("assistant-toggle").click(), true');
          await waitForSuggestion((s) => s.gate === "off", "the assistant-off gate");
          await mutateMiddlegame(middlegame.session, MIDDLEGAME_MUTATIONS[2]); // no canned response for this one
          await sleep(700);
          const off = await readSuggestion();
          const offStats = await serverStats();
          s4.offState = { message: off.message, status: off.status, gate: off.gate, requests: offStats.analyzeRequests - before.analyzeRequests };
          expect(s4, off.gate === "off", `gate ${off.gate}`);
          expect(s4, /assistant off/.test(off.message ?? ""), `message ${off.message}`);
          expect(s4, off.rowsHidden === true, "no rows while the assistant is off");
          expect(s4, offStats.analyzeRequests - before.analyzeRequests === 0, `no request while the assistant is off (${offStats.analyzeRequests - before.analyzeRequests})`);
          s4.screenshot = await panelScreenshot("stub-assistant-off.png");

          // Turning it back on analyzes the current position — the stub has no
          // canned data for it, so a REAL 400 comes back and its detail is shown.
          await evaluateInPanel('document.getElementById("assistant-toggle").click(), true');
          const on = await waitForSuggestion(
            (s) => /invalid input/.test(s.message ?? ""),
            "the 400 message after the assistant is turned back on",
          );
          const onStats = await serverStats();
          s4.onState = { message: on.message, status: on.status, requests: onStats.analyzeRequests - before.analyzeRequests, debugStatus: on.debugStatus };
          expect(s4, onStats.analyzeRequests - before.analyzeRequests === 1, `one request after turning it back on (${onStats.analyzeRequests - before.analyzeRequests})`);
          expect(s4, /invalid input \(HTTP 400\)/.test(on.message ?? ""), `400 message: ${on.message}`);
          expect(s4, /no canned response/.test(on.message ?? ""), "the server's detail is shown");
          expect(s4, on.wdlHidden === true && on.rowsHidden === true, "no rows/WDL on an error");
          console.log(s4.pass
            ? `PASS stub-assistant-off-gating: 0 requests while off, analyzed again when turned on (400 detail shown)`
            : `FAIL stub-assistant-off-gating: ${s4.failures.join("; ")}`);
        } catch (error) {
          s4.pass = false;
          s4.failures.push(String(error?.message ?? error));
        }
      }
      if (!s4.pass) for (const failure of s4.failures) fail(failure, "stub-assistant-off-gating");
      await writeFile(path.join(args.outDir, "stub-assistant-off-gating.json"), `${JSON.stringify(s4, null, 2)}\n`);

      /* ------------------------------------------- case S5: 400 with detail */
      const s5 = { pass: true, failures: [], screenshot: null };
      summary.cases["stub-invalid-input-400"] = s5;
      try {
        await setMode("bad_request");
        await evaluateInPanel('document.getElementById("mx-analyze").click(), true');
        const suggestion = await waitForSuggestion(
          (s) => /invalid input/.test(s.message ?? ""),
          "the 400 detail message",
        );
        s5.message = suggestion.message;
        s5.status = suggestion.status;
        s5.statusClass = suggestion.statusClass;
        expect(s5, /invalid input \(HTTP 400\)/.test(suggestion.message ?? ""), `message: ${suggestion.message}`);
        expect(s5, /simulated invalid input/.test(suggestion.message ?? ""), "server detail text shown");
        expect(s5, suggestion.statusClass.includes("chip-offline"), `status chip: ${suggestion.statusClass}`);
        s5.screenshot = await panelScreenshot("stub-invalid-input-400.png");
        await setMode("ok");
        console.log(s5.pass ? `PASS stub-invalid-input-400: ${suggestion.message}` : `FAIL stub-invalid-input-400: ${s5.failures.join("; ")}`);
      } catch (error) {
        s5.pass = false;
        s5.failures.push(String(error?.message ?? error));
        await setMode("ok");
      }
      if (!s5.pass) for (const failure of s5.failures) fail(failure, "stub-invalid-input-400");
      await writeFile(path.join(args.outDir, "stub-invalid-input-400.json"), `${JSON.stringify(s5, null, 2)}\n`);

      /* -------------------------------------------- case S6: server offline */
      const s6 = { pass: true, failures: [], screenshot: null, attempts: null };
      summary.cases["stub-server-offline"] = s6;
      try {
        await setMode("offline");
        const before = await serverStats();
        await evaluateInPanel('document.getElementById("mx-analyze").click(), true');
        const suggestion = await waitForSuggestion(
          (s) => /server offline/.test(s.message ?? ""),
          "the server-offline message",
        );
        const after = await serverStats();
        s6.message = suggestion.message;
        s6.attempts = suggestion.lastError?.attempts ?? null;
        s6.serverAttempts = after.analyzeAttempts - before.analyzeAttempts;
        s6.latency = { roundTripMs: suggestion.lastRoundTripMs };
        expect(s6, /server offline/.test(suggestion.message ?? ""), `message: ${suggestion.message}`);
        expect(s6, /uvicorn app:app/.test(suggestion.message ?? ""), "actionable start command shown");
        expect(s6, s6.attempts === 2, `exactly one retry: ${s6.attempts} fetch attempts`);
        expect(s6, /retried once, 2 attempts/.test(suggestion.message ?? ""), "the message reports the single retry");
        expect(s6, suggestion.statusClass.includes("chip-offline"), "status chip is offline");
        s6.screenshot = await panelScreenshot("stub-server-offline.png");
        await setMode("ok");
        console.log(s6.pass
          ? `PASS stub-server-offline: "server offline" + start command, ${s6.attempts} fetch attempts (1 retry; ${s6.serverAttempts} server-side connection attempts), round-trip ${s6.latency.roundTripMs} ms`
          : `FAIL stub-server-offline: ${s6.failures.join("; ")}`);
      } catch (error) {
        s6.pass = false;
        s6.failures.push(String(error?.message ?? error));
        await setMode("ok");
      }
      if (!s6.pass) for (const failure of s6.failures) fail(failure, "stub-server-offline");
      await writeFile(path.join(args.outDir, "stub-server-offline.json"), `${JSON.stringify(s6, null, 2)}\n`);
      if (middlegame) await closeTarget(middlegame.targetId);

      /* ------------------------ case S7: opponent's turn + manual analysis */
      const s7 = { pass: true, failures: [], screenshot: null };
      summary.cases["stub-opponent-turn-manual"] = s7;
      try {
        const before = await serverStats();
        const { targetId } = await openFixture("flipped-black.html");
        const flippedFen = "rnbqkbnr/pp2pppp/3p4/2p5/4P3/5N2/PPPP1PPP/RNBQKB1R w KQkq - 0 3";
        await refreshPanelState(targetId, flippedFen, "flipped-black");
        const waiting = await waitForSuggestion((s) => s.gate === "waiting", "the waiting state");
        s7.waiting = { gate: waiting.gate, message: waiting.message, rowsHidden: waiting.rowsHidden, wdlHidden: waiting.wdlHidden };
        expect(s7, /their turn/.test(waiting.message ?? ""), `message: ${waiting.message}`);
        expect(s7, waiting.rowsHidden === true, "no move rows while waiting");
        const afterWaiting = await serverStats();
        expect(s7, afterWaiting.analyzeRequests === before.analyzeRequests, "no auto-request on the opponent's turn");

        await evaluateInPanel('document.getElementById("mx-analyze").click(), true');
        const suggestion = await waitForSuggestion(
          (s) => s.rows.length === 3 && s.rows[0]?.san === "d4",
          "the manual analysis of the opponent's turn",
        );
        s7.manual = {
          top3: suggestion.rows.map((row) => ({ san: row.san, prob: row.prob })),
          wdlLabel: suggestion.wdlLabel,
          wdl: [suggestion.wdlWin, suggestion.wdlDraw, suggestion.wdlLoss],
          meta: suggestion.meta,
        };
        expect(s7, suggestion.rows[0].san === "d4" && suggestion.rows[1].san === "Bb5+", `manual top-3 ${suggestion.rows.map((row) => row.san)}`);
        expect(s7, suggestion.wdlLabel === "human outcome prediction (opponent's perspective)", `WDL label: ${suggestion.wdlLabel}`);
        // Server (white to move): win 49.1 / draw 6.3 / loss 44.6 -> opponent (black): win 44.6 / loss 49.1
        expect(s7, suggestion.wdlWin === "win 44.6%" && suggestion.wdlLoss === "loss 49.1%", `flipped WDL: ${suggestion.wdlWin} / ${suggestion.wdlLoss}`);
        s7.screenshot = await panelScreenshot("stub-opponent-turn-manual.png");
        console.log(s7.pass
          ? `PASS stub-opponent-turn-manual: waiting -> manual d4 (opponent's perspective, WDL flipped 44.6/49.1)`
          : `FAIL stub-opponent-turn-manual: ${s7.failures.join("; ")}`);
        await closeTarget(targetId);
      } catch (error) {
        s7.pass = false;
        s7.failures.push(String(error?.message ?? error));
      }
      if (!s7.pass) for (const failure of s7.failures) fail(failure, "stub-opponent-turn-manual");
      await writeFile(path.join(args.outDir, "stub-opponent-turn-manual.json"), `${JSON.stringify(s7, null, 2)}\n`);

      /* ---------------------------------------------------- case S8: game over */
      const s8 = { pass: true, failures: [], screenshot: null };
      summary.cases["stub-game-over"] = s8;
      try {
        const { targetId } = await openFixture("gameover-checkmate.html");
        await refreshPanelState(targetId, GAMEOVER_FEN, "gameover-checkmate");
        const suggestion = await waitForSuggestion((s) => s.debugStatus === "game-over", "the game-over message");
        s8.message = suggestion.message;
        s8.status = suggestion.status;
        s8.wdl = [suggestion.wdlWin, suggestion.wdlDraw, suggestion.wdlLoss];
        s8.meta = suggestion.meta;
        s8.rowsHidden = suggestion.rowsHidden;
        expect(s8, /game over/.test(suggestion.message ?? ""), `message: ${suggestion.message}`);
        expect(s8, /checkmate — black is mated/.test(suggestion.message ?? ""), `checkmate text: ${suggestion.message}`);
        expect(s8, suggestion.rowsHidden === true, "no move rows at game over");
        expect(s8, suggestion.wdlHidden === false, "the rules-decided WDL is shown");
        expect(s8, s8.wdl[0] === "win 0.0%" && s8.wdl[2] === "loss 100.0%", `WDL chips: ${s8.wdl}`);
        expect(s8, suggestion.rows.length === 0, "zero rows");
        s8.screenshot = await panelScreenshot("stub-game-over.png");
        console.log(s8.pass ? `PASS stub-game-over: ${suggestion.message}` : `FAIL stub-game-over: ${s8.failures.join("; ")}`);
        await closeTarget(targetId);
      } catch (error) {
        s8.pass = false;
        s8.failures.push(String(error?.message ?? error));
      }
      if (!s8.pass) for (const failure of s8.failures) fail(failure, "stub-game-over");
      await writeFile(path.join(args.outDir, "stub-game-over.json"), `${JSON.stringify(s8, null, 2)}\n`);

      /* -------------------------------------------------------- case S9: Elo */
      const s9 = { pass: true, failures: [], at2400: null, at1200: null, at2600: null, back: null, screenshots: [] };
      summary.cases["stub-elo-change"] = s9;
      try {
        const { targetId } = await openFixture("ruy-lopez.html");
        await refreshPanelState(targetId, RUY_FEN, "ruy-lopez");
        const at2400 = await waitForSuggestion(
          (s) => s.rows.length === 3 && s.rows[0]?.san === "h3" && String(s.lastRenderKey).endsWith("|2400|2400|3"),
          "ruy-lopez @ default 2400",
        );
        s9.at2400 = { rows: at2400.rows.map((row) => row.san), probs: at2400.rows.map((row) => row.prob) };

        const setElo = async (self, oppo) => {
          await evaluateInPanel(`(() => {
             const self = document.getElementById("elo-self");
             const oppo = document.getElementById("elo-oppo");
             self.value = ${JSON.stringify(String(self))};
             oppo.value = ${JSON.stringify(String(oppo))};
             self.dispatchEvent(new Event("change"));
             return true;
           })()`);
        };

        const before = await serverStats();
        await setElo(1200, 1200);
        const at1200 = await waitForSuggestion(
          (s) => s.rows.length === 3 && String(s.lastRenderKey).endsWith("|1200|1200|3"),
          "ruy-lopez @ 1200 (top-1 d4)",
        );
        s9.at1200 = { rows: at1200.rows.map((row) => row.san), probs: at1200.rows.map((row) => row.prob), key: at1200.lastRenderKey };
        s9.screenshots.push(await panelScreenshot("stub-elo-1200.png"));

        await setElo(2600, 2600);
        const at2600 = await waitForSuggestion(
          (s) => s.rows.length === 3 && String(s.lastRenderKey).endsWith("|2600|2600|3"),
          "ruy-lopez @ 2600 (top-1 h3, prob ~86%)",
        );
        s9.at2600 = { rows: at2600.rows.map((row) => row.san), probs: at2600.rows.map((row) => row.prob), key: at2600.lastRenderKey };
        s9.screenshots.push(await panelScreenshot("stub-elo-2600.png"));

        const after = await serverStats();
        s9.requests = { delta: after.analyzeRequests - before.analyzeRequests };
        expect(s9, s9.requests.delta === 2, `an Elo change re-analyzes the position (requests: ${s9.requests.delta})`);
        expect(s9, s9.at1200.key !== s9.at2600.key, "the position key includes the Elo pair");
        expect(s9, s9.at1200.rows[0] === "d4" && s9.at2600.rows[0] === "h3", `top move changed with Elo: ${s9.at1200.rows[0]} -> ${s9.at2600.rows[0]}`);
        expect(s9, s9.at1200.probs[0] === "83.6%" && s9.at2600.probs[0] === "86.2%", `probabilities changed: ${s9.at1200.probs[0]} -> ${s9.at2600.probs[0]}`);
        expect(s9, s9.at2400.rows[0] === "h3", `default 2400 top-1 ${s9.at2400.rows[0]}`);

        // The reset link -> back to 2400.
        const beforeReset = await serverStats();
        await evaluateInPanel('document.getElementById("elo-reset").click(), true');
        const back = await waitForSuggestion(
          (s) => s.rows.length === 3 && String(s.lastRenderKey).endsWith("|2400|2400|3") && s.rows[0]?.san === "h3" && s.rows[0].prob === "80.5%",
          "ruy-lopez back at 2400 via the reset link",
        );
        const afterReset = await serverStats();
        s9.back = {
          self: await evaluateInPanel('document.getElementById("elo-self").value'),
          oppo: await evaluateInPanel('document.getElementById("elo-oppo").value'),
          rows: back.rows.map((row) => row.san),
          requests: afterReset.analyzeRequests - beforeReset.analyzeRequests,
        };
        expect(s9, s9.back.self === "2400" && s9.back.oppo === "2400", `reset link: ${s9.back.self}/${s9.back.oppo}`);
        expect(s9, s9.back.rows[0] === "h3", "top-1 back to the 2400 value");
        console.log(s9.pass
          ? `PASS stub-elo-change: 1200 -> d4 83.6%, 2600 -> h3 86.2% (2 requests), reset -> 2400 h3 80.5%`
          : `FAIL stub-elo-change: ${s9.failures.join("; ")}`);
        await closeTarget(targetId);
      } catch (error) {
        s9.pass = false;
        s9.failures.push(String(error?.message ?? error));
      }
      if (!s9.pass) for (const failure of s9.failures) fail(failure, "stub-elo-change");
      await writeFile(path.join(args.outDir, "stub-elo-change.json"), `${JSON.stringify(s9, null, 2)}\n`);

      /* ------------------------------------- case S10: adapter mismatch */
      const s10 = { pass: true, failures: [], screenshot: null };
      summary.cases["stub-mismatch-board-only"] = s10;
      try {
        const { targetId, session } = await openFixture("middlegame-castling.html");
        await waitForSuggestion(
          (s) => s.debugStatus === "ready" && String(s.lastRenderKey).includes("d8f6|2400|2400|3"),
          "the middlegame analysis before the mismatch",
        );
        // With the assistant off nothing is requested automatically, so the
        // board-only FEN can be registered before the manual analysis.
        await evaluateInPanel('document.getElementById("assistant-toggle").click(), true');
        await waitForSuggestion((s) => s.gate === "off", "the assistant-off gate");

        // Move ONE white piece and repaint the (unchanged) move list: the board
        // and the replayed history now disagree -> the adapter sets `mismatch`.
        // (The repaint matters: the M3 observer watches childList/characterData,
        // not attributes, and the real site repaints the move list with every
        // move — a class-only mutation would not trigger a refresh.)
        await evaluateInPage(session, `(() => {
          ${MUTATION_HELPERS}
          const board = document.getElementById("board-play-computer");
          const knight = board.querySelector(".piece.wn.square-21") ?? board.querySelector(".piece.square-21.wn");
          __humanplayMovePiece(knight, "square-21", "square-33");
          __humanplaySetMoveList(${JSON.stringify(MIDDLEGAME_SANS)});
          return true;
        })()`);

        const warned = await waitForSuggestion(
          (s) => s.warn !== null && !String(s.currentKey).includes("e2e4"),
          "the mismatch warning (board-only request key)",
        );
        s10.warning = warned.warn;
        s10.boardOnlyKey = warned.currentKey;
        s10.m3CardMismatch = await evaluateInPanel('document.getElementById("cc-mismatch").hidden ? null : document.getElementById("cc-mismatch").textContent');
        expect(s10, /mismatch/.test(warned.warn ?? ""), `warning: ${warned.warn}`);
        expect(s10, /WITHOUT the move history/.test(warned.warn ?? ""), "the warning says the history is dropped");
        expect(s10, !String(warned.currentKey).includes("e2e4"), `the request must NOT carry the history: ${warned.currentKey}`);
        expect(s10, / w - - 0 8\|\|2400\|2400\|3$/.test(String(warned.currentKey)), `board-only FEN: ${warned.currentKey}`);
        expect(s10, /board-history-disagreement|history-unreliable/.test(s10.m3CardMismatch ?? ""), `M3 card mismatch: ${s10.m3CardMismatch}`);

        // Register the canned response for exactly that board-only key, then
        // analyze manually: a successful suggestion WITH the mismatch warning.
        const registered = await fetch(`${SERVER_ORIGIN}/debug/canned`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ key: warned.currentKey, response: MIDDLEGAME_CANNED_RESPONSE }),
        });
        expect(s10, registered.ok, "registering the canned response for the board-only key");
        await evaluateInPanel('document.getElementById("mx-analyze").click(), true');
        const suggestion = await waitForSuggestion(
          (s) => s.debugStatus === "ready" && s.rows.length === 3 && s.warn !== null,
          "the board-only suggestion with the mismatch warning",
        );
        s10.rows = suggestion.rows.map((row) => row.san);
        s10.meta = suggestion.meta;
        s10.mode = suggestion.lastResult?.mode;
        s10.historyUsed = suggestion.lastResult?.historyUsed;
        expect(s10, suggestion.rows.map((row) => row.san).join(",") === "Nc3,h3,c3", `rows ${suggestion.rows.map((row) => row.san)}`);
        expect(s10, suggestion.lastResult?.mode === "board-only", `request mode ${suggestion.lastResult?.mode}`);
        expect(s10, suggestion.lastResult?.historyUsed === 0, `historyUsed ${suggestion.lastResult?.historyUsed}`);
        expect(s10, /board only · no history/.test(suggestion.meta ?? ""), `meta: ${suggestion.meta}`);
        expect(s10, suggestion.warn !== null, "the mismatch warning stays visible next to the suggestion");
        s10.screenshot = await panelScreenshot("stub-mismatch-board-only.png");
        await evaluateInPanel('document.getElementById("assistant-toggle").click(), true');
        console.log(s10.pass
          ? `PASS stub-mismatch-board-only: mismatch warning + board-only analysis (no history) -> ${s10.rows.join("/")}`
          : `FAIL stub-mismatch-board-only: ${s10.failures.join("; ")}`);
        await closeTarget(targetId);
      } catch (error) {
        s10.pass = false;
        s10.failures.push(String(error?.message ?? error));
      }
      if (!s10.pass) for (const failure of s10.failures) fail(failure, "stub-mismatch-board-only");
      await writeFile(path.join(args.outDir, "stub-mismatch-board-only.json"), `${JSON.stringify(s10, null, 2)}\n`);

      summary.latencies.stub = {
        stateToRender_startpos_ms: summary.cases["stub-startpos-auto"].latency?.stateToRenderMs ?? null,
        stateToRender_middlegame_ms: summary.cases["stub-middlegame-history"].latency?.stateToRenderMs ?? null,
        mutationToRender_newPosition_ms: summary.cases["stub-stale-guard"].latency?.mutationToRenderMs ?? null,
        roundTrip_startpos_ms: summary.cases["stub-startpos-auto"].latency?.roundTripMs ?? null,
        roundTrip_middlegame_ms: summary.cases["stub-middlegame-history"].latency?.roundTripMs ?? null,
        target_ms: 1500,
      };
    }

    /* ===================================================================== */
    /* REAL MODE                                                             */
    /* ===================================================================== */

    if (!stub) {
      /* -------------------------------------- case R1: panel top-3 == curl */
      const real = { pass: true, failures: [], panel: null, curl: null, comparison: null, screenshot: null };
      summary.cases["real-middlegame-equals-curl"] = real;
      let middlegame = null;
      try {
        const { targetId, session } = await openFixture("middlegame-castling.html");
        middlegame = { targetId, session };
        const suggestion = await waitForSuggestion(
          (s) => s.debugStatus === "ready" && s.rows.length === 3 && String(s.lastRenderKey).endsWith("|2400|2400|3"),
          "the real middlegame suggestion",
        );
        const panelRows = suggestion.rows.map((row) => ({ san: row.san, uci: row.uci, prob: parseFloat(row.prob) / 100 }));
        real.panel = { rows: suggestion.rows, meta: suggestion.meta, wdl: [suggestion.wdlWin, suggestion.wdlDraw, suggestion.wdlLoss], gate: suggestion.gate };
        real.latency = { stateToRenderMs: suggestion.lastStateToRenderMs, roundTripMs: suggestion.lastRoundTripMs, engineMs: suggestion.lastEngineMs };

        const payload = { fen: STARTPOS_FEN, moves: MIDDLEGAME_UCI, elo_self: 2400, elo_oppo: 2400, top_k: 3 };
        const curl = await curlAnalyze(payload);
        real.curl = {
          command: curl.command,
          wallMs: curl.wallMs,
          ok: curl.ok,
          moves: curl.body?.moves ?? null,
          wdl: curl.body?.wdl ?? null,
          model: curl.body?.model ?? null,
          elapsed_ms: curl.body?.elapsed_ms ?? null,
          error: curl.error,
        };
        real.comparison = { payload, tolerance: 0.0005 };
        expect(real, curl.ok === true, `curl failed: ${curl.error ?? curl.stdout}`);
        if (curl.ok) {
          expect(real, curl.body.model === suggestion.lastResult?.model, `model ${curl.body.model} vs panel ${suggestion.lastResult?.model}`);
          expect(real, panelRows.length === curl.body.moves.length, "same number of moves");
          curl.body.moves.forEach((move, index) => {
            const row = panelRows[index];
            expect(real, row?.san === move.san, `rank ${index + 1} SAN: panel ${row?.san} vs curl ${move.san}`);
            expect(real, row?.uci === move.uci, `rank ${index + 1} UCI: panel ${row?.uci} vs curl ${move.uci}`);
            expect(real, Math.abs((row?.prob ?? 0) - move.prob) < real.comparison.tolerance, `rank ${index + 1} prob: panel ${row?.prob} vs curl ${move.prob}`);
          });
          expect(real, /engine \d+\.\d ms/.test(suggestion.meta ?? ""), `engine latency in the meta line: ${suggestion.meta}`);
          expect(real, /round-trip \d+\.\d ms/.test(suggestion.meta ?? ""), `round-trip in the meta line: ${suggestion.meta}`);
          expect(real, /14 moves · replayed/.test(suggestion.meta ?? ""), `history in the meta line: ${suggestion.meta}`);
          expect(real, suggestion.lastStateToRenderMs <= 1500, `state->render ${suggestion.lastStateToRenderMs} ms`);
        }
        real.screenshot = await panelScreenshot("real-middlegame-suggestion.png");

        // Latency for a POSITION CHANGE with the real engine (mutation -> rows).
        const mutationAt = await mutateMiddlegame(session, MIDDLEGAME_MUTATIONS[0]);
        const changed = await waitForSuggestion(
          (s) => s.debugStatus === "ready" && String(s.lastRenderKey).includes("b1c3 h7h6"),
          "the real suggestion for the changed position",
        );
        real.positionChange = {
          mutationToRenderMs: changed.lastRenderAtEpochMs - mutationAt,
          stateToRenderMs: changed.lastStateToRenderMs,
          roundTripMs: changed.lastRoundTripMs,
          engineMs: changed.lastEngineMs,
          rows: changed.rows.map((row) => ({ san: row.san, prob: row.prob })),
          meta: changed.meta,
        };
        expect(real, real.positionChange.mutationToRenderMs <= 1500, `mutation->render after a position change ${real.positionChange.mutationToRenderMs} ms`);
        real.positionChangeScreenshot = await panelScreenshot("real-position-change.png");
        console.log(real.pass
          ? `PASS real-middlegame-equals-curl: panel = curl ${panelRows.map((row) => `${row.san} ${(row.prob * 100).toFixed(1)}%`).join(" / ")}; engine ${real.latency.engineMs} ms, round-trip ${real.latency.roundTripMs} ms, mutation->render ${real.positionChange.mutationToRenderMs} ms`
          : `FAIL real-middlegame-equals-curl: ${real.failures.join("; ")}`);
      } catch (error) {
        real.pass = false;
        real.failures.push(String(error?.message ?? error));
      }
      if (!real.pass) for (const failure of real.failures) fail(failure, "real-middlegame-equals-curl");
      await writeFile(path.join(args.outDir, "real-middlegame-equals-curl.json"), `${JSON.stringify(real, null, 2)}\n`);
      if (middlegame) await closeTarget(middlegame.targetId);

      /* --------------------------------------------- case R2: real game over */
      const realGo = { pass: true, failures: [], screenshot: null };
      summary.cases["real-game-over"] = realGo;
      try {
        const { targetId } = await openFixture("gameover-checkmate.html");
        await refreshPanelState(targetId, GAMEOVER_FEN, "gameover-checkmate");
        const suggestion = await waitForSuggestion((s) => s.debugStatus === "game-over", "the real game-over message");
        realGo.message = suggestion.message;
        realGo.wdl = [suggestion.wdlWin, suggestion.wdlDraw, suggestion.wdlLoss];
        realGo.rowsHidden = suggestion.rowsHidden;
        realGo.meta = suggestion.meta;
        expect(realGo, /checkmate — black is mated/.test(suggestion.message ?? ""), `message: ${suggestion.message}`);
        expect(realGo, suggestion.rowsHidden === true, "no rows at game over");
        expect(realGo, realGo.wdl[2] === "loss 100.0%", `rules-decided WDL: ${realGo.wdl}`);
        realGo.screenshot = await panelScreenshot("real-game-over.png");
        console.log(realGo.pass ? `PASS real-game-over: ${suggestion.message}` : `FAIL real-game-over: ${realGo.failures.join("; ")}`);
        await closeTarget(targetId);
      } catch (error) {
        realGo.pass = false;
        realGo.failures.push(String(error?.message ?? error));
      }
      if (!realGo.pass) for (const failure of realGo.failures) fail(failure, "real-game-over");
      await writeFile(path.join(args.outDir, "real-game-over.json"), `${JSON.stringify(realGo, null, 2)}\n`);

      /* --------------------------------------- case R3: real Elo top move */
      const realElo = { pass: true, failures: [], at1200: null, at2600: null, screenshots: [] };
      summary.cases["real-elo-changes-top-move"] = realElo;
      try {
        const { targetId } = await openFixture("ruy-lopez.html");
        await refreshPanelState(targetId, RUY_FEN, "ruy-lopez");
        await waitForSuggestion((s) => s.debugStatus === "ready" && String(s.lastRenderKey).endsWith("|2400|2400|3"), "the first real ruy-lopez analysis");

        const setElo = async (self, oppo) => {
          await evaluateInPanel(`(() => {
             const self = document.getElementById("elo-self");
             const oppo = document.getElementById("elo-oppo");
             self.value = ${JSON.stringify(String(self))};
             oppo.value = ${JSON.stringify(String(oppo))};
             self.dispatchEvent(new Event("change"));
             return true;
           })()`);
        };

        await setElo(1200, 1200);
        const low = await waitForSuggestion(
          (s) => s.rows.length === 3 && String(s.lastRenderKey).endsWith("|1200|1200|3"),
          "ruy-lopez @ 1200",
        );
        const lowCurl = await curlAnalyze({ fen: STARTPOS_FEN, moves: RUY_UCI, elo_self: 1200, elo_oppo: 1200, top_k: 3 });
        realElo.at1200 = { panelRows: low.rows, meta: low.meta, curlMoves: lowCurl.body?.moves ?? null, curlWallMs: lowCurl.wallMs, latency: { stateToRenderMs: low.lastStateToRenderMs, roundTripMs: low.lastRoundTripMs, engineMs: low.lastEngineMs } };
        realElo.screenshots.push(await panelScreenshot("real-elo-1200.png"));

        await setElo(2600, 2600);
        const high = await waitForSuggestion(
          (s) => s.rows.length === 3 && String(s.lastRenderKey).endsWith("|2600|2600|3"),
          "ruy-lopez @ 2600",
        );
        const highCurl = await curlAnalyze({ fen: STARTPOS_FEN, moves: RUY_UCI, elo_self: 2600, elo_oppo: 2600, top_k: 3 });
        realElo.at2600 = { panelRows: high.rows, meta: high.meta, curlMoves: highCurl.body?.moves ?? null, curlWallMs: highCurl.wallMs, latency: { stateToRenderMs: high.lastStateToRenderMs, roundTripMs: high.lastRoundTripMs, engineMs: high.lastEngineMs } };
        realElo.screenshots.push(await panelScreenshot("real-elo-2600.png"));

        const lowSan = low.rows[0]?.san;
        const highSan = high.rows[0]?.san;
        expect(realElo, lowSan === "d4" && highSan === "h3", `panel top move with Elo: ${lowSan} -> ${highSan}`);
        expect(realElo, lowCurl.body?.moves?.[0]?.san === lowSan, `curl @1200 ${lowCurl.body?.moves?.[0]?.san} vs panel ${lowSan}`);
        expect(realElo, highCurl.body?.moves?.[0]?.san === highSan, `curl @2600 ${highCurl.body?.moves?.[0]?.san} vs panel ${highSan}`);
        expect(realElo, Math.abs(parseFloat(low.rows[0]?.prob) / 100 - lowCurl.body.moves[0].prob) < 0.0005, "probabilities match curl @1200");
        expect(realElo, Math.abs(parseFloat(high.rows[0]?.prob) / 100 - highCurl.body.moves[0].prob) < 0.0005, "probabilities match curl @2600");
        await evaluateInPanel('document.getElementById("elo-reset").click(), true');
        console.log(realElo.pass
          ? `PASS real-elo-changes-top-move: 1200 -> ${lowSan} ${low.rows[0]?.prob}, 2600 -> ${highSan} ${high.rows[0]?.prob}`
          : `FAIL real-elo-changes-top-move: ${realElo.failures.join("; ")}`);
        await closeTarget(targetId);
      } catch (error) {
        realElo.pass = false;
        realElo.failures.push(String(error?.message ?? error));
      }
      if (!realElo.pass) for (const failure of realElo.failures) fail(failure, "real-elo-changes-top-move");
      await writeFile(path.join(args.outDir, "real-elo-changes-top-move.json"), `${JSON.stringify(realElo, null, 2)}\n`);

      summary.latencies.real = {
        stateToRender_ms: summary.cases["real-middlegame-equals-curl"].latency?.stateToRenderMs ?? null,
        engine_ms: summary.cases["real-middlegame-equals-curl"].latency?.engineMs ?? null,
        roundTrip_ms: summary.cases["real-middlegame-equals-curl"].latency?.roundTripMs ?? null,
        mutationToRender_ms: summary.cases["real-middlegame-equals-curl"].positionChange?.mutationToRenderMs ?? null,
        curlWall_ms: summary.cases["real-middlegame-equals-curl"].curl?.wallMs ?? null,
        target_ms: 1500,
      };
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
    summary.checks.adapterDebugLines = summary.console.pages.filter((entry) => entry.text.includes("[humanplay]")).length;
    summary.checks.extensionConsoleClean =
      summary.console.panelErrors.length === 0 &&
      summary.console.serviceWorkerErrors.length === 0 &&
      summary.console.pageErrors.length === 0;
    if (!summary.checks.extensionConsoleClean) fail("extension console reported errors — see summary.console");
    // Network log noise that every run produces: about:blank targets and the
    // fixture origin's missing favicon. Stub mode additionally drops the
    // connection on purpose in the offline case and answers 400 on purpose.
    const harmlessNetworkLog = (text) => /ERR_UNKNOWN_URL_SCHEME|favicon\.ico|status of 40[04]/.test(text);
    const expectedOfflineLog = (text) => /ERR_EMPTY_RESPONSE|ERR_CONNECTION_REFUSED|ERR_CONNECTION_RESET/.test(text);
    const unexpectedNetworkErrors = summary.console.networkErrors.filter(
      (entry) => !harmlessNetworkLog(entry.text) && !(stub && expectedOfflineLog(entry.text)),
    );
    summary.checks.expectedOfflineNetworkErrors = stub
      ? summary.console.networkErrors.filter((entry) => expectedOfflineLog(entry.text)).length
      : 0;
    if (unexpectedNetworkErrors.length) {
      fail(`unexpected network errors: ${unexpectedNetworkErrors.map((entry) => entry.text).join(" | ")}`);
    }

    summary.ok = summary.failures.length === 0;
    const proofName = stub ? "analyze-proof-stub.json" : "analyze-proof-real.json";
    await writeFile(path.join(args.outDir, proofName), `${JSON.stringify(summary, null, 2)}\n`);
    console.log(
      `\n${summary.ok ? "ALL ANALYZE CASES PASSED" : `FAILURES (${summary.failures.length}):\n - ` + summary.failures.join("\n - ")}` +
        `\nproof: ${path.relative(REPO_ROOT, path.join(args.outDir, proofName))}`,
    );
    if (!summary.ok) process.exitCode = 1;
  } catch (error) {
    console.error(`analyze-proof failed: ${error.message}`);
    console.error(JSON.stringify({ logs, partial: true }, null, 2));
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

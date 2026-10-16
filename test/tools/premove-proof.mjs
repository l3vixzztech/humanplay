#!/usr/bin/env node
/**
 * premove-proof.mjs — objective end-to-end proof for the M7 premove planner
 * (their turn -> /premove -> panel card + dashed arrow + speech).
 *
 * Two modes, same harness (CDP against a real Chrome for Testing):
 *
 *   STUB mode (default)
 *     Spawns `test/tools/fixture_server.py` on 127.0.0.1:8765 and proves the
 *     whole panel pipeline against CANNED /premove responses recorded from the
 *     real server (identical schema):
 *       S1  take-back fixture: card (criterion/safety/min-prob/their moves/
 *           caveat) + dashed arrow endpoints <= 2 px vs DOM ground truth;
 *       S2  TTS: exactly one "premove ..." per position, deduped on re-emit,
 *           stop-before-speak recorded;
 *       S3  the robust mutation (their capture + our recapture): "robust vs 99%"
 *           + the arrow follows the new position + a new speak;
 *       S4  the forced mutation (mismatch -> board-only): criterion "forced";
 *       S5  no-safe state: their two plausible replies need different answers
 *           -> "no safe premove", no arrow, no speech;
 *       S6  stale race: a delayed plan superseded by the opponent's move is
 *           discarded — no render, no arrow, no speech;
 *       S7  gating: our turn ("waiting for your move", no request), assistant
 *           off (no request), TTS off (no speech);
 *       S8  flipped board: dashed arrow endpoints <= 2 px on a flipped board.
 *
 *   REAL mode (`--real`)
 *     Expects the REAL Maia server (`cd server && .venv/bin/python -m uvicorn
 *     app:app --host 127.0.0.1 --port 8765`) and asserts that the panel's
 *     recommendation for the take-back fixture EQUALS a direct `curl /premove`
 *     (SAN/UCI/criterion/safety/min_response_prob + their top candidate), and
 *     records the planner latencies (target <= 300 ms engine, ready <= ~600 ms).
 *
 * Every run loads a temporary COPY of the extension whose manifest additionally
 * matches the content script (and its web-accessible modules) on the fixture
 * origin — the shipped manifest stays chess.com-only; all code files are
 * hash-compared and the report carries `codeIdentical`.
 *
 * Usage:
 *   node test/tools/premove-proof.mjs --chrome <path> [--real|--stub]
 *     [--extension extension] [--out-dir test/fixtures/captures/premove]
 *     [--headful] [--keep-profile] [--timeout-ms 45000]
 *
 * Exit code is non-zero when any assertion fails. Writes one proof JSON + panel
 * screenshots into test/fixtures/captures/premove/.
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
const PREMOVE_URL = `${SERVER_ORIGIN}/premove`;

const STARTPOS_FEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

/** Ground truth of test/fixtures/chesscom/ (generate_chesscom.py). */
const TAKEBACK_FEN = "rnbqkb1r/pp1p1ppp/4pn2/2pP4/2P5/2N5/PP2PPPP/R1BQKBNR b KQkq - 1 4";
const TAKEBACK_UCI = ["d2d4", "g8f6", "c2c4", "c7c5", "d4d5", "e7e6", "b1c3"];
const TAKEBACK_SANS = ["d4", "Nf6", "c4", "c5", "d5", "e6", "Nc3"];
const FLIPPED_FEN = "rnbqkbnr/pp2pppp/3p4/2p5/4P3/5N2/PPPP1PPP/RNBQKB1R w KQkq - 0 3";
const FLIPPED_UCI = ["e2e4", "c7c5", "g1f3", "d7d6"];

/**
 * The forced-recapture construction (the mismatch mutation): black's only legal
 * move is the recapture Rxd2, our premove is Qxd2+. The mutation keeps a 9-ply
 * move list (the robust mutation's plies + one more), so the adapter reports the
 * board-only FEN with side-to-move/fullmove from the parity: "8/1n4b1/... b - -
 * 0 5" — which is what the canned response is keyed by (the plan is identical to
 * the raw FEN; Maia does not condition on the move counters — verified).
 */
const FORCED_BOARD_FIELD = "8/1n4b1/4K3/5N2/4R3/3k4/1R1Qr1Q1/8";
const FORCED_FEN = `${FORCED_BOARD_FIELD} b - - 0 5`;
/** The move list both mismatch mutations keep (9 plies -> black to move, move 5). */
const MISMATCH_SANS = [...TAKEBACK_SANS, "exd5", "cxd5"];
const FORCED_PIECES = [
  { code: "bn", square: "27" },
  { code: "bb", square: "77" },
  { code: "bk", square: "43" },
  { code: "br", square: "52" },
  { code: "wk", square: "56" },
  { code: "wn", square: "65" },
  { code: "wr", square: "54" },
  { code: "wr", square: "22" },
  { code: "wq", square: "42" },
  { code: "wq", square: "72" },
];

/** The stale-race board (K+P endgame): black to move, every reply met by b8=Q+. */
const STALE_RACE_BOARD_FIELD = "8/1P6/8/p7/k7/7K/8/8";
const STALE_RACE_FEN = `${STALE_RACE_BOARD_FIELD} b - - 0 5`;
const STALE_RACE_PIECES = [
  { code: "bk", square: "14" },
  { code: "bp", square: "15" },
  { code: "wk", square: "83" },
  { code: "wp", square: "27" },
];

/* ------------------------------------------------------------------ args */

function parseArgs(argv) {
  const args = {
    chrome: null,
    extension: path.join(REPO_ROOT, "extension"),
    outDir: path.join(REPO_ROOT, "test/fixtures/captures/premove"),
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

/** Direct `curl /premove` — the real-mode ground-truth comparison. */
function curlPremove(payload, { timeoutMs = 30000 } = {}) {
  const command = `curl -s ${PREMOVE_URL} -H 'Content-Type: application/json' -d '${JSON.stringify(payload)}'`;
  return new Promise((resolve) => {
    const startedAt = Date.now();
    execFile(
      "curl",
      ["-s", "-X", "POST", PREMOVE_URL, "-H", "Content-Type: application/json", "-d", JSON.stringify(payload)],
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

/**
 * Page-side helpers (main world of every fixture page). `groundTruth` derives
 * the square-centre map from the DOM's painted pieces — deliberately
 * independent of overlay-geometry.js (same technique as overlay-proof.mjs) — so
 * a mapping bug in the overlay cannot hide behind a shared formula.
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
      sqX, sqY,
      centres,
    };
  },
  overlay() {
    const canvas = document.getElementById("humanplay-overlay-canvas");
    const data = canvas?.dataset?.humanplay ? JSON.parse(canvas.dataset.humanplay) : null;
    return {
      exists: Boolean(canvas),
      display: canvas?.style.display ?? null,
      pointerEvents: canvas?.style.pointerEvents ?? null,
      zIndex: canvas?.style.zIndex ?? null,
      data,
    };
  },
  movePiece(element, from, to) {
    const fromClass = String(from).startsWith("square-") ? String(from) : "square-" + from;
    const toClass = String(to).startsWith("square-") ? String(to) : "square-" + to;
    element.classList.remove(fromClass);
    element.classList.add(toClass);
    const match = /^square-(\d)(\d)$/.exec(toClass);
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
  findPiece(board, classes, square) {
    return board.querySelector(".piece." + classes.join(".") + "." + "square-" + square)
      ?? board.querySelector(".piece.square-" + square + "." + classes.join("."));
  },
  mutate(boardId, mutation) {
    const board = document.getElementById(boardId);
    for (const remove of mutation.remove ?? []) {
      const element = globalThis.__humanplayProof.findPiece(board, remove.classes, remove.from);
      if (!element) throw new Error("piece not found for removal: " + remove.classes.join(".") + " " + remove.from);
      element.remove();
    }
    for (const piece of mutation.pieces ?? []) {
      const element = globalThis.__humanplayProof.findPiece(board, piece.classes, piece.from);
      if (!element) throw new Error("piece not found: " + piece.classes.join(".") + " " + piece.from);
      globalThis.__humanplayProof.movePiece(element, piece.from, piece.to);
    }
    if (mutation.sans) globalThis.__humanplayProof.setMoveList(mutation.sans);
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
    return sans.length;
  },
  /** Replace every piece of a board (the mismatch mutation) — keeps the move list. */
  setBoard(boardId, pieces) {
    const board = document.getElementById(boardId);
    for (const element of [...board.querySelectorAll(".piece")]) element.remove();
    const flipped = board.classList.contains("flipped");
    for (const piece of pieces) {
      const element = document.createElement("div");
      element.className = "piece " + piece.code + " square-" + piece.square;
      const file = Number(piece.square[0]) - 1;
      const rank = Number(piece.square[1]) - 1;
      const column = flipped ? 7 - file : file;
      const row = flipped ? rank : 7 - rank;
      element.style.left = (column * 12.5) + "%";
      element.style.top = (row * 12.5) + "%";
      board.append(element);
    }
    return board.querySelectorAll(".piece").length;
  },
};
`;

/* ------------------------------------------------------------------ main */

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const stub = args.mode === "stub";
  const sourceExtensionDir = path.resolve(args.extension);
  const summary = {
    tool: "premove-proof.mjs",
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

    /* --------------------------------------------------- premove server side */

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
        summary.checks.premoveServer = { mode: "stub (already running)", health: existing };
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
        summary.checks.premoveServer = { mode: "stub (spawned by the proof)", health, pid: fixtureServerProcess.pid };
      }
      summary.checks.canned = {
        source: "test/tools/fixture_server.py CANNED_PREMOVE — recorded from the real Maia server (schema-identical)",
        keyFormat: "<fen>|<uci moves>|<elo_self>|<elo_oppo>|<top_n>|<min_safety>|<mode>",
      };
    } else {
      const health = await serverHealth();
      if (!String(health.model ?? "").includes("maia")) {
        throw new Error(
          `--real needs the Maia server on 127.0.0.1:8765 (got ${JSON.stringify(health)}). Start it: ` +
            "cd server && .venv/bin/python -m uvicorn app:app --host 127.0.0.1 --port 8765",
        );
      }
      summary.checks.premoveServer = { mode: "real", health };
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
    const setPremoveDelay = async (ms, count) => {
      await fetch(`${SERVER_ORIGIN}/debug/premove-delay`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ms, count }),
      });
    };
    const registerCannedPremove = async (key, response) => {
      await fetch(`${SERVER_ORIGIN}/debug/canned-premove`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key, response }),
      });
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
    summary.checks.premoveFiles = Object.fromEntries(
      [
        "src/analysis/premove-client.js",
        "src/analysis/analyze-client.js",
        "src/ui/sidepanel.js",
        "src/ui/sidepanel.html",
        "src/content/board-overlay.js",
        "src/tts/tts-policy.js",
        "src/tts/move-speech.js",
      ].map((file) => [file, sha256(readFileSync(path.join(sourceExtensionDir, file)))]),
    );
    if (summary.checks.manifest.hasAllUrls) fail("the manifest contains <all_urls>");
    const expectedPermissions = ["activeTab", "storage", "sidePanel", "downloads", "tts"];
    if (JSON.stringify(sourceManifest.permissions) !== JSON.stringify(expectedPermissions)) {
      fail(`unexpected permissions: ${JSON.stringify(sourceManifest.permissions)} (M7 adds none)`);
    }

    variantDir = await mkdtemp(path.join(tmpdir(), "humanplay-premove-variant-"));
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

    profileDir = await mkdtemp(path.join(tmpdir(), "humanplay-premove-proof-"));
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
      "--enable-speech-dispatcher", // TTS evidence needs a speech backend on Linux
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
      logs[bucket].push({ bucket: "error", source: "javascript", text });
    });
    cdp.on("Runtime.consoleAPICalled", (params, sessionId) => {
      const text = (params.args ?? []).map((arg) => arg.value ?? arg.description ?? arg.type).join(" ");
      const bucket = sessionRole.get(sessionId) ?? "pages";
      logs[bucket].push({
        bucket: params.type === "error" ? "error" : params.type === "warning" ? "warning" : "info",
        source: "console",
        text,
      });
    });
    cdp.on("Log.entryAdded", ({ entry }, sessionId) => {
      const bucket = sessionRole.get(sessionId) ?? "pages";
      logs[bucket].push({
        bucket: entry.level === "error" ? "error" : entry.level === "warning" ? "warning" : "info",
        source: entry.source,
        text: entry.text + (entry.url ? ` (${entry.url})` : ""),
      });
    });
    cdp.on("Runtime.executionContextCreated", ({ context }, sessionId) => {
      const entry = pageSessions.get(sessionId);
      if (entry && context.auxData?.isDefault === false) entry.isolatedContextIds.add(context.id);
    });

    /* --------------------------------------------- service worker + the panel */

    const serviceWorkerPath = sourceManifest.background?.service_worker;
    const expectedWorkerUrl = `chrome-extension://${extensionId}/${serviceWorkerPath}`;
    let worker = await waitFor(
      "our extension's service worker target",
      () => [...targets.values()].find((target) => target.type === "service_worker" && target.url === expectedWorkerUrl),
      { timeoutMs: args.timeoutMs },
    );
    let workerSessionId = (await cdp.send("Target.attachToTarget", { targetId: worker.targetId, flatten: true })).sessionId;
    sessionRole.set(workerSessionId, "serviceWorker");
    await cdp.send("Runtime.enable", {}, workerSessionId);
    await cdp.send("Log.enable", {}, workerSessionId);

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
          worker = await waitFor(
            "our extension's service worker target",
            () => [...targets.values()].find((target) => target.type === "service_worker" && target.url === expectedWorkerUrl),
            { timeoutMs: args.timeoutMs },
          );
          workerSessionId = (await cdp.send("Target.attachToTarget", { targetId: worker.targetId, flatten: true })).sessionId;
          sessionRole.set(workerSessionId, "serviceWorker");
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
        'document.readyState === "complete" && !!document.getElementById("pm-status") && !!globalThis.__humanplayAnalysis',
      );
      return ready === true;
    }, { timeoutMs: args.timeoutMs });

    summary.checks.panelUi = await evaluateInPanel(`(() => {
      const ids = ["pm-status", "pm-message", "pm-rec", "pm-san", "pm-criterion", "pm-safety", "pm-minprob",
                   "pm-detail", "pm-oppo-box", "pm-oppo-title", "pm-oppo", "pm-caveat", "pm-arrow", "pm-speak",
                   "pm-meta", "mx-status", "tts-enabled", "ov-arrows", "assistant-toggle"];
      const present = {};
      for (const id of ids) present[id] = !!document.getElementById(id);
      return {
        present,
        missing: ids.filter((id) => !present[id]),
        inlineScripts: [...document.scripts].filter((script) => !script.src).length,
        pmArrowChecked: document.getElementById("pm-arrow").checked,
        pmSpeakChecked: document.getElementById("pm-speak").checked,
      };
    })()`);
    if (summary.checks.panelUi.missing.length) fail(`panel is missing elements: ${summary.checks.panelUi.missing.join(", ")}`);
    if (summary.checks.panelUi.inlineScripts !== 0) fail("panel has inline scripts (CSP risk)");
    if (summary.checks.panelUi.pmArrowChecked !== true) fail("'Show premove arrow' must default ON");
    if (summary.checks.panelUi.pmSpeakChecked !== true) fail("'Speak premoves' must default ON");

    /** Everything the premove card shows + the premove debug hook (read-only). */
    const readPremove = () =>
      evaluateInPanel(`(() => {
        const debug = globalThis.__humanplayAnalysis;
        const pm = debug.premove;
        const rows = [...document.querySelectorAll("#pm-oppo .pm-oppo-row")].map((li) => ({
          san: li.dataset.san,
          uci: li.dataset.uci,
          prob: li.dataset.prob ? Number(li.dataset.prob) : null,
          terminal: li.dataset.terminal || null,
          probText: li.querySelector(".pm-oppo-prob")?.textContent ?? null,
          barWidth: li.querySelector(".pm-oppo-bar > span")?.style.width ?? null,
        }));
        return {
          status: document.getElementById("pm-status").textContent,
          statusClass: document.getElementById("pm-status").className,
          message: document.getElementById("pm-message").hidden ? null : document.getElementById("pm-message").textContent,
          messageClass: document.getElementById("pm-message").className,
          recHidden: document.getElementById("pm-rec").hidden,
          san: document.getElementById("pm-san").textContent,
          criterion: document.getElementById("pm-criterion").textContent,
          criterionTitle: document.getElementById("pm-criterion").title,
          safety: document.getElementById("pm-safety").textContent,
          minProb: document.getElementById("pm-minprob").textContent,
          detail: document.getElementById("pm-detail").textContent,
          oppoHidden: document.getElementById("pm-oppo-box").hidden,
          rows,
          caveat: document.getElementById("pm-caveat").hidden ? null : document.getElementById("pm-caveat").textContent,
          meta: document.getElementById("pm-meta").hidden ? null : document.getElementById("pm-meta").textContent,
          gate: pm.gate,
          premoveStatus: pm.status,
          planCount: pm.planCount,
          staleDiscards: pm.planStaleDiscards,
          lastPlan: pm.lastPlan,
          decision: pm.decision,
          decisions: pm.decisions,
          sentMode: pm.sentMode,
          sentKey: pm.sentKey,
          lastMessage: pm.lastMessage,
          lastResponse: pm.lastResponse,
          lastError: pm.lastError,
          currentKey: debug.premoveClient.getCurrentKey(),
          analyzeCurrentKey: debug.currentKey,
          analyzeStatus: debug.status,
        };
      })()`);

    const waitForPremove = (predicate, description, timeoutMs = args.timeoutMs) =>
      waitFor(description, async () => {
        const state = await readPremove();
        return predicate(state) ? state : null;
      }, { timeoutMs, intervalMs: 60 });

    /** The SW TTS record (what would be spoken) — same hook as tts-proof. */
    const readTts = () =>
      evaluateInWorker(`(() => {
        const d = globalThis.__humanplayTts;
        if (!d) return null;
        return {
          engine: d.engine,
          calls: d.calls,
          events: d.events,
          speakCount: d.speakCount,
          speakFailCount: d.speakFailCount,
          stopCount: d.stopCount,
          lastSpeak: d.lastSpeak,
          lastStop: d.lastStop,
        };
      })()`);

    const speakCalls = (tts, predicate = () => true) =>
      (tts?.calls ?? []).filter((call) => call.kind === "speak" && predicate(call));

    /** Only the premove speaks (the M4 suggestion speaks on our turn are separate). */
    const premoveSpeaks = (tts) => speakCalls(tts, (call) => call.reason === "premove");

    const waitForSpeak = (predicate, description, timeoutMs = args.timeoutMs) =>
      waitFor(description, async () => {
        const tts = await readTts();
        const call = speakCalls(tts, predicate).at(-1) ?? null;
        return call ? { call, tts } : null;
      }, { timeoutMs, intervalMs: 80 });

    const panelScreenshot = async (name) => {
      await cdp.send("Emulation.setDeviceMetricsOverride", { width: 400, height: 900, deviceScaleFactor: 2, mobile: false }, panelSession);
      await evaluateInPanel('document.getElementById("premove-card").scrollIntoView({ block: "start" }), true');
      await sleep(250);
      const shot = await cdp.send("Page.captureScreenshot", { format: "png" }, panelSession);
      await cdp.send("Emulation.clearDeviceMetricsOverride", {}, panelSession);
      const target = path.join(args.outDir, name);
      await writeFile(target, Buffer.from(shot.data, "base64"));
      return path.relative(REPO_ROOT, target);
    };

    const pageScreenshot = async (session, name) => {
      const shot = await cdp.send("Page.captureScreenshot", { format: "png" }, session);
      const target = path.join(args.outDir, name);
      await writeFile(target, Buffer.from(shot.data, "base64"));
      return path.relative(REPO_ROOT, target);
    };

    const openFixture = async (file) => {
      const target = await cdp.send("Target.createTarget", { url: `${origin}/chesscom/${file}` });
      openTargets.add(target.targetId);
      const session = (await cdp.send("Target.attachToTarget", { targetId: target.targetId, flatten: true })).sessionId;
      sessionRole.set(session, "pages");
      pageSessions.set(session, { targetId: target.targetId, isolatedContextIds: new Set() });
      await cdp.send("Page.enable", {}, session);
      await cdp.send("Runtime.enable", {}, session);
      await cdp.send("Log.enable", {}, session);
      await waitFor(`${file} load`, async () => {
        const result = await cdp.send("Runtime.evaluate", { expression: 'document.readyState === "complete"', returnByValue: true }, session);
        return result.result.value === true;
      }, { timeoutMs: args.timeoutMs });
      await evaluateInPage(session, `(() => { ${PAGE_HELPERS} return true; })()`);
      await cdp.send("Target.activateTarget", { targetId: target.targetId });
      return { targetId: target.targetId, session, isolatedContextIds: pageSessions.get(session).isolatedContextIds };
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

    const readOverlay = (session) => evaluateInPage(session, "globalThis.__humanplayProof.overlay()");

    const groundTruth = (session, boardId, squares) =>
      evaluateInPage(session, `globalThis.__humanplayProof.groundTruth(${JSON.stringify(boardId)}, ${JSON.stringify(squares)})`);

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
      const startpos = await openFixture("startpos.html");
      const takeback = await openFixture("premove-takeback.html");
      const flipped = await openFixture("flipped-black.html");

      const TAKEBACK_PREMOVE_KEY = `${STARTPOS_FEN}|${TAKEBACK_UCI.join(" ")}|2400|2400|5|0.9|top`;
      const statsAfterFixtures = await serverStats();

      /* ---------------------------------------------------------- case S0 */
      const s0 = { pass: true, failures: [], card: null };
      summary.cases["stub-our-turn"] = s0;
      try {
        // The startpos fixture is on OUR turn: the card waits, and the
        // our-turn position is NEVER requested (check by key: other tabs may
        // still be broadcasting their own states around us).
        const ourTurnKey = `${STARTPOS_FEN}||2400|2400|5|0.9|top`;
        await refreshPanelState(startpos.targetId, STARTPOS_FEN, "startpos (our turn)");
        const card = await waitForPremove((state) => state.gate === "waiting", "waiting for your move");
        await sleep(400);
        const statsNow = await serverStats();
        s0.card = { gate: card.gate, status: card.status, message: card.message, recHidden: card.recHidden };
        s0.ourTurnKey = ourTurnKey;
        s0.requested = statsNow.premoveByKey[ourTurnKey] ?? 0;
        expect(s0, card.status === "waiting", `status: ${card.status}`);
        expect(s0, /waiting for your move/.test(card.message ?? ""), `message: ${card.message}`);
        expect(s0, card.recHidden === true, "no recommendation on our turn");
        expect(s0, s0.requested === 0, `the our-turn position was requested ${s0.requested} times`);
        console.log(s0.pass
          ? `PASS stub-our-turn: "${card.message}" (0 /premove requests for it)`
          : `FAIL stub-our-turn: ${s0.failures.join("; ")}`);
      } catch (error) {
        s0.pass = false;
        s0.failures.push(String(error?.message ?? error));
      }
      if (!s0.pass) for (const failure of s0.failures) fail(failure, "stub-our-turn");
      await writeFile(path.join(args.outDir, "stub-our-turn.json"), `${JSON.stringify(s0, null, 2)}\n`);

      /* ---------------------------------------------------------- case S1 */
      const s1 = { pass: true, failures: [], card: null, overlay: null, endpoints: null, screenshot: null };
      summary.cases["stub-takeback-card"] = s1;
      try {
        const receivedAt = Date.now();
        await refreshPanelState(takeback.targetId, TAKEBACK_FEN, "premove-takeback");
        const card = await waitForPremove((state) => state.premoveStatus === "ready", "the take-back premove plan");
        s1.card = {
          status: card.status,
          san: card.san,
          criterion: card.criterion,
          safety: card.safety,
          minProb: card.minProb,
          detail: card.detail,
          rows: card.rows,
          caveat: card.caveat,
          meta: card.meta,
          gate: card.gate,
          key: card.currentKey,
          renderMs: card.lastPlan?.renderMs ?? null,
          engineMs: card.lastPlan?.engineMs ?? null,
          roundTripMs: card.lastPlan?.roundTripMs ?? null,
          stateToRenderMs: card.lastPlan?.atEpochMs ? card.lastPlan.atEpochMs - receivedAt : null,
        };

        expect(s1, card.status === "premove ready", `status: ${card.status}`);
        expect(s1, card.san === "cxd5", `recommended: ${card.san}`);
        expect(s1, card.criterion === "safe vs all replies", `criterion chip: ${card.criterion}`);
        expect(s1, card.safety === "100.0%", `safety: ${card.safety}`);
        expect(s1, card.minProb === "98.4%", `min response prob: ${card.minProb}`);
        expect(s1, card.recHidden === false, "the recommendation block is visible");
        expect(s1, /take-back|take back|recapture/i.test(card.detail) || card.detail.includes("cxd5"), `detail: ${card.detail}`);
        expect(s1, card.rows.length === 3, `their likely moves shown: ${card.rows.length}`);
        expect(s1, card.rows[0]?.san === "exd5" && card.rows[0]?.probText === "96.3%", `their top move: ${JSON.stringify(card.rows[0])}`);
        expect(s1, card.rows[1]?.san === "d6", `second likely move: ${card.rows[1]?.san}`);
        expect(
          s1,
          card.caveat === "safe only over their top-5; a premove still fires whenever it is legal",
          `caveat: ${card.caveat}`,
        );
        expect(s1, card.gate === "auto", `gate: ${card.gate}`);
        expect(s1, String(card.lastPlan?.key) === TAKEBACK_PREMOVE_KEY, `request key: ${card.lastPlan?.key}`);
        // Dedupe at the HTTP level: the plan for this key was requested exactly
        // once even though the card rendered it more than once.
        const statsNow = await serverStats();
        s1.requests = {
          totalAfterFixtures: statsAfterFixtures.premoveRequests,
          totalNow: statsNow.premoveRequests,
          byKey: statsNow.premoveByKey[TAKEBACK_PREMOVE_KEY] ?? 0,
          allKeys: Object.keys(statsNow.premoveByKey).length,
        };
        expect(s1, s1.requests.byKey === 1, `the plan was requested ${s1.requests.byKey} times (expected exactly 1)`);

        // The dashed arrow: one premove arrow, endpoints <= 2 px vs DOM ground truth.
        const overlay = await waitFor("the dashed premove arrow", async () => {
          const state = await readOverlay(takeback.session);
          const arrows = state.data?.arrows ?? [];
          return state.display === "block" && arrows.some((arrow) => arrow.premove) ? state : null;
        });
        const gt = await groundTruth(takeback.session, "board-single", ["c4", "d5"]);
        const premoveArrow = overlay.data.arrows.find((arrow) => arrow.premove) ?? null;
        s1.overlay = {
          display: overlay.display,
          pointerEvents: overlay.pointerEvents,
          state: overlay.data?.state,
          arrows: overlay.data?.arrows,
          premove: overlay.data?.premove,
        };
        s1.endpoints = premoveArrow
          ? {
              uci: premoveArrow.uci,
              style: premoveArrow.style,
              fromErrorPx: maxPointError(premoveArrow.from, gt.centres.c4),
              tipErrorPx: maxPointError(premoveArrow.tip, gt.centres.d5),
              groundTruth: gt.centres,
            }
          : null;
        expect(s1, premoveArrow !== null, "no premove arrow drawn");
        expect(s1, premoveArrow?.uci === "c4d5", `premove arrow uci: ${premoveArrow?.uci}`);
        expect(s1, premoveArrow?.style === "dashed", `premove arrow style: ${premoveArrow?.style}`);
        expect(s1, (overlay.data?.arrows ?? []).filter((arrow) => !arrow.premove).length === 0, "no solid suggestion arrows on their turn");
        expect(s1, s1.endpoints.fromErrorPx <= 2 && s1.endpoints.tipErrorPx <= 2, `endpoint error ${JSON.stringify(s1.endpoints)}`);
        expect(s1, overlay.display === "block" && overlay.pointerEvents === "none", `canvas hygiene: ${JSON.stringify(s1.overlay)}`);

        s1.screenshot = await panelScreenshot("stub-takeback-card.png");
        await pageScreenshot(takeback.session, "stub-takeback-arrow.png");
        console.log(s1.pass
          ? `PASS stub-takeback-card: ${card.san} (${card.criterion}, safety ${card.safety}) arrow dashed, endpoints ${s1.endpoints.fromErrorPx.toFixed(2)}/${s1.endpoints.tipErrorPx.toFixed(2)} px`
          : `FAIL stub-takeback-card: ${s1.failures.join("; ")}`);
      } catch (error) {
        s1.pass = false;
        s1.failures.push(String(error?.message ?? error));
      }
      if (!s1.pass) for (const failure of s1.failures) fail(failure, "stub-takeback-card");
      await writeFile(path.join(args.outDir, "stub-takeback-card.json"), `${JSON.stringify(s1, null, 2)}\n`);

      /* ---------------------------------------------------------- case S2 */
      const s2 = { pass: true, failures: [], beforeSpeak: null, speak: null, dedupe: null, screenshot: null };
      summary.cases["stub-speech"] = s2;
      try {
        // TTS off by default: the card is on screen and nothing was spoken.
        const ttsBefore = await readTts();
        s2.beforeSpeak = { speakCount: ttsBefore.speakCount, premoveSpeaks: premoveSpeaks(ttsBefore).length, decision: (await readPremove()).decision };
        expect(s2, premoveSpeaks(ttsBefore).length === 0, `spoke a premove with TTS off: ${premoveSpeaks(ttsBefore).length}`);
        expect(s2, (await readPremove()).decision?.reason === "tts-off", "the decision must record tts-off");

        // Toggle TTS on: explicit user intent speaks the current premove ONCE.
        const toggledAt = Date.now();
        await evaluateInPanel('document.getElementById("tts-enabled").click(), true');
        const spoken = await waitForSpeak((call) => call.reason === "premove", "the premove speak");
        s2.speak = {
          text: spoken.call.text,
          engine: spoken.call.engine,
          options: spoken.call.options,
          key: spoken.call.key,
          san: spoken.call.san,
          uci: spoken.call.uci,
          reason: spoken.call.reason,
          stopBefore: (spoken.tts.calls ?? []).filter((call) => call.kind === "stop" && call.reason === "before-speak").at(-1) ?? null,
          issuedAfterToggleMs: spoken.call.atEpochMs - toggledAt,
        };
        expect(s2, spoken.call.text === "premove c-pawn takes d5", `text: ${spoken.call.text}`);
        expect(s2, spoken.call.engine === "chrome.tts", `engine: ${spoken.call.engine}`);
        expect(s2, spoken.call.options?.enqueue === false && spoken.call.options?.rate === 1, `options: ${JSON.stringify(spoken.call.options)}`);
        expect(s2, Boolean(s2.speak.stopBefore), "stop-before-speak not recorded");
        expect(s2, premoveSpeaks(spoken.tts).length === 1, `premove speak count after toggle-on: ${premoveSpeaks(spoken.tts).length}`);
        expect(s2, s2.speak.issuedAfterToggleMs <= 1500, `toggle-on speak latency ${s2.speak.issuedAfterToggleMs} ms`);

        // Re-emit the same position: the cached plan re-renders, the dedupe silences it.
        await refreshPanelState(takeback.targetId, TAKEBACK_FEN, "premove-takeback re-emit");
        await sleep(400);
        const panelAfter = await readPremove();
        const ttsAfter = await readTts();
        s2.dedupe = {
          speakCount: ttsAfter.speakCount,
          premoveSpeakCount: premoveSpeaks(ttsAfter).length,
          decision: panelAfter.decision,
          duplicateDecisions: (panelAfter.decisions ?? []).filter((decision) => decision.reason === "duplicate").length,
          renderCount: panelAfter.planCount,
        };
        expect(s2, premoveSpeaks(ttsAfter).length === 1, `re-emit spoke again: ${premoveSpeaks(ttsAfter).length}`);
        expect(s2, s2.dedupe.duplicateDecisions >= 1, `no duplicate decision recorded: ${JSON.stringify(s2.dedupe)}`);
        s2.screenshot = await panelScreenshot("stub-speech-dedupe.png");
        console.log(s2.pass
          ? `PASS stub-speech: "${s2.speak.text}" once (${s2.speak.issuedAfterToggleMs} ms after toggle), re-emit deduped`
          : `FAIL stub-speech: ${s2.failures.join("; ")}`);
      } catch (error) {
        s2.pass = false;
        s2.failures.push(String(error?.message ?? error));
      }
      if (!s2.pass) for (const failure of s2.failures) fail(failure, "stub-speech");
      await writeFile(path.join(args.outDir, "stub-speech.json"), `${JSON.stringify(s2, null, 2)}\n`);

      /* ---------------------------------------------------------- case S3 */
      const s3 = { pass: true, failures: [], card: null, endpoints: null, speak: null, screenshot: null };
      summary.cases["stub-robust-mutation"] = s3;
      try {
        // 4...exd5 (bp e6 -> d5, wp d5 removed) 5.cxd5 (wp c4 -> d5).
        const mutationAt = await evaluateInPage(takeback.session, `(() => {
          globalThis.__humanplayMutationAt = Date.now();
          globalThis.__humanplayProof.mutate("board-single", ${JSON.stringify({
            remove: [{ classes: ["wp"], from: "45" }],
            pieces: [
              { classes: ["bp"], from: "56", to: "45" },
              { classes: ["wp"], from: "34", to: "45" },
            ],
            sans: [...TAKEBACK_SANS, "exd5", "cxd5"],
          })});
          return globalThis.__humanplayMutationAt;
        })()`);
        const card = await waitForPremove(
          (state) => state.premoveStatus === "ready" && state.san === "e4",
          "the robust plan after the take-back",
        );
        s3.card = {
          san: card.san,
          criterion: card.criterion,
          safety: card.safety,
          minProb: card.minProb,
          rows: card.rows.slice(0, 2),
          key: card.currentKey,
          renderMs: card.lastPlan?.renderMs ?? null,
          mutationToRenderMs: card.lastPlan?.atEpochMs ? card.lastPlan.atEpochMs - mutationAt : null,
        };
        expect(s3, card.criterion === "robust vs 99%", `criterion chip: ${card.criterion}`);
        expect(s3, card.safety === "99.3%", `safety: ${card.safety}`);
        expect(s3, card.rows[0]?.san === "d6" && card.rows[0]?.probText === "92.0%", `their top move: ${JSON.stringify(card.rows[0])}`);

        const overlay = await waitFor("the robust premove arrow", async () => {
          const state = await readOverlay(takeback.session);
          const arrows = state.data?.arrows ?? [];
          return arrows.some((arrow) => arrow.premove && arrow.uci === "e2e4") ? state : null;
        });
        const arrow = overlay.data.arrows.find((candidate) => candidate.premove) ?? null;
        const gt = await groundTruth(takeback.session, "board-single", ["e2", "e4"]);
        s3.endpoints = arrow
          ? {
              uci: arrow.uci,
              style: arrow.style,
              fromErrorPx: maxPointError(arrow.from, gt.centres.e2),
              tipErrorPx: maxPointError(arrow.tip, gt.centres.e4),
            }
          : null;
        expect(s3, arrow?.uci === "e2e4" && arrow?.style === "dashed", `arrow: ${JSON.stringify(arrow)}`);
        expect(s3, s3.endpoints.fromErrorPx <= 2 && s3.endpoints.tipErrorPx <= 2, `endpoint error ${JSON.stringify(s3.endpoints)}`);
        expect(s3, s3.card.mutationToRenderMs !== null && s3.card.mutationToRenderMs <= 600, `mutation->render ${s3.card.mutationToRenderMs} ms`);

        const spoken = await waitForSpeak((call) => call.text === "premove e-pawn to e4", "the new premove speak");
        s3.speak = { text: spoken.call.text, key: spoken.call.key };
        expect(s3, premoveSpeaks(spoken.tts).length === 2, `premove speak count: ${premoveSpeaks(spoken.tts).length}`);
        s3.screenshot = await panelScreenshot("stub-robust.png");
        await pageScreenshot(takeback.session, "stub-robust-arrow.png");
        console.log(s3.pass
          ? `PASS stub-robust-mutation: ${card.san} (${card.criterion}, safety ${card.safety}) mutation->render ${s3.card.mutationToRenderMs} ms, spoke "${s3.speak.text}"`
          : `FAIL stub-robust-mutation: ${s3.failures.join("; ")}`);
      } catch (error) {
        s3.pass = false;
        s3.failures.push(String(error?.message ?? error));
      }
      if (!s3.pass) for (const failure of s3.failures) fail(failure, "stub-robust-mutation");
      await writeFile(path.join(args.outDir, "stub-robust-mutation.json"), `${JSON.stringify(s3, null, 2)}\n`);

      /* ---------------------------------------------------------- case S4 */
      const s4 = { pass: true, failures: [], card: null, endpoints: null, speak: null, screenshot: null };
      summary.cases["stub-forced-mismatch"] = s4;
      try {
        // Replace the board with the forced-recapture position; the move list
        // stays at 7 plies -> board-history-disagreement -> board-only FEN
        // ("... b - - 0 4", black to move). The canned response is keyed by it.
        await evaluateInPage(takeback.session, `(() => {
          globalThis.__humanplayProof.setBoard("board-single", ${JSON.stringify(FORCED_PIECES)});
          globalThis.__humanplayProof.setMoveList(${JSON.stringify(MISMATCH_SANS)});
          return true;
        })()`);
        const card = await waitForPremove(
          (state) => state.premoveStatus === "ready" && state.san === "Qxd2+",
          "the forced plan after the mismatch mutation",
          12000,
        ).catch(async (error) => {
          const diag = await evaluateInPanel(`(() => ({
            pmStatus: globalThis.__humanplayAnalysis.premove.status,
            pmError: globalThis.__humanplayAnalysis.premove.lastError,
            currentKey: globalThis.__humanplayAnalysis.premoveClient.getCurrentKey(),
            ccFen: document.getElementById("cc-fen").textContent,
            ccMoves: document.getElementById("cc-moves").textContent,
            ccMismatch: document.getElementById("cc-mismatch").hidden ? null : document.getElementById("cc-mismatch").textContent,
            message: document.getElementById("pm-message").textContent,
          }))()`);
          throw new Error(`${error.message}; panel=${JSON.stringify(diag)}`);
        });
        s4.card = {
          san: card.san,
          criterion: card.criterion,
          safety: card.safety,
          minProb: card.minProb,
          rows: card.rows.slice(0, 1),
          key: card.currentKey,
          analyzeStatus: card.analyzeStatus,
        };
        expect(s4, card.criterion === "forced", `criterion chip: ${card.criterion}`);
        expect(s4, card.safety === "100.0%", `safety: ${card.safety}`);
        expect(s4, card.minProb === "31.1%", `min response prob: ${card.minProb}`);
        expect(s4, card.rows[0]?.san === "Rxd2", `their forced move: ${JSON.stringify(card.rows[0])}`);
        expect(s4, String(card.currentKey).startsWith(`${FORCED_BOARD_FIELD} b - - 0 5||`), `board-only key: ${card.currentKey}`);

        const overlay = await waitFor("the forced premove arrow", async () => {
          const state = await readOverlay(takeback.session);
          const arrows = state.data?.arrows ?? [];
          return arrows.some((arrow) => arrow.premove && arrow.uci === "g2d2") ? state : null;
        });
        const arrow = overlay.data.arrows.find((candidate) => candidate.premove) ?? null;
        const gt = await groundTruth(takeback.session, "board-single", ["g2", "d2"]);
        s4.endpoints = {
          uci: arrow?.uci,
          style: arrow?.style,
          fromErrorPx: maxPointError(arrow.from, gt.centres.g2),
          tipErrorPx: maxPointError(arrow.tip, gt.centres.d2),
        };
        expect(s4, s4.endpoints.fromErrorPx <= 2 && s4.endpoints.tipErrorPx <= 2, `endpoint error ${JSON.stringify(s4.endpoints)}`);
        const spoken = await waitForSpeak((call) => call.text === "premove queen takes d2, check", "the forced premove speak");
        s4.speak = { text: spoken.call.text };
        s4.screenshot = await panelScreenshot("stub-forced.png");
        console.log(s4.pass
          ? `PASS stub-forced-mismatch: ${card.san} (${card.criterion}) from the board-only key, spoke "${s4.speak.text}"`
          : `FAIL stub-forced-mismatch: ${s4.failures.join("; ")}`);
      } catch (error) {
        s4.pass = false;
        s4.failures.push(String(error?.message ?? error));
      }
      if (!s4.pass) for (const failure of s4.failures) fail(failure, "stub-forced-mismatch");
      await writeFile(path.join(args.outDir, "stub-forced-mismatch.json"), `${JSON.stringify(s4, null, 2)}\n`);

      /* ---------------------------------------------------------- case S5 */
      const s5 = { pass: true, failures: [], card: null, overlay: null, screenshot: null };
      summary.cases["stub-no-safe"] = s5;
      try {
        // startpos + 1.e4: their c5/e5/c6/e6 need different answers -> null.
        const requestsBefore = (await serverStats()).premoveRequests;
        const speaksBefore = premoveSpeaks(await readTts()).length;
        await refreshPanelState(startpos.targetId, STARTPOS_FEN, "startpos");
        await evaluateInPage(startpos.session, `(() => {
          globalThis.__humanplayProof.mutate("board-single", ${JSON.stringify({
            pieces: [{ classes: ["wp"], from: "52", to: "54" }],
            sans: ["e4"],
          })});
          return true;
        })()`);
        const card = await waitForPremove((state) => state.premoveStatus === "no-safe-premove", "the no-safe state", 12000).catch(async (error) => {
          // Diagnostics: what DID the panel show? (canned miss / mismatch / gate)
          const diag = await evaluateInPanel(`(() => ({
            pmStatus: globalThis.__humanplayAnalysis.premove.status,
            pmError: globalThis.__humanplayAnalysis.premove.lastError,
            pmLastPlan: globalThis.__humanplayAnalysis.premove.lastPlan,
            currentKey: globalThis.__humanplayAnalysis.premoveClient.getCurrentKey(),
            ccFen: document.getElementById("cc-fen").textContent,
            ccMoves: document.getElementById("cc-moves").textContent,
            ccMismatch: document.getElementById("cc-mismatch").hidden ? null : document.getElementById("cc-mismatch").textContent,
            message: document.getElementById("pm-message").textContent,
          }))()`);
          throw new Error(`${error.message}; panel=${JSON.stringify(diag)}`);
        });
        s5.card = {
          status: card.status,
          message: card.message,
          rows: card.rows,
          caveat: card.caveat,
          recHidden: card.recHidden,
          key: card.currentKey,
          reason: card.lastPlan?.reason ?? null,
          decision: card.decision,
        };
        const overlay = await readOverlay(startpos.session);
        s5.overlay = { display: overlay.display, arrows: overlay.data?.arrows ?? [] };
        const requestsAfter = (await serverStats()).premoveRequests;
        const tts = await readTts();
        expect(s5, card.status === "no safe premove", `status: ${card.status}`);
        expect(s5, /no safe premove:/.test(card.message ?? ""), `message: ${card.message}`);
        expect(s5, card.recHidden === true, "the recommendation block must be hidden");
        expect(s5, card.rows.length === 3 && card.rows[0]?.san === "c5", `their moves: ${JSON.stringify(card.rows)}`);
        expect(s5, card.rows[0]?.probText === "43.9%", `their top move prob: ${card.rows[0]?.probText}`);
        expect(s5, Boolean(card.caveat), "the caveat line must still show");
        expect(s5, s5.overlay.display === "none" || s5.overlay.arrows.length === 0, `arrows must be gone: ${JSON.stringify(s5.overlay)}`);
        expect(s5, card.decision?.reason === "no-premove", `speech decision: ${JSON.stringify(card.decision)}`);
        expect(s5, premoveSpeaks(tts).length === speaksBefore, `spoke for a null plan: ${premoveSpeaks(tts).length} vs ${speaksBefore}`);
        expect(s5, requestsAfter === requestsBefore + 1, `one /premove request (${requestsBefore} -> ${requestsAfter})`);
        s5.screenshot = await panelScreenshot("stub-no-safe.png");
        console.log(s5.pass
          ? `PASS stub-no-safe: "${card.message}" (no arrow, no speech)`
          : `FAIL stub-no-safe: ${s5.failures.join("; ")}`);
      } catch (error) {
        s5.pass = false;
        s5.failures.push(String(error?.message ?? error));
      }
      if (!s5.pass) for (const failure of s5.failures) fail(failure, "stub-no-safe");
      await writeFile(path.join(args.outDir, "stub-no-safe.json"), `${JSON.stringify(s5, null, 2)}\n`);

      /* ---------------------------------------------------------- case S6 */
      const s6 = { pass: true, failures: [], card: null, overlay: null, screenshot: null };
      summary.cases["stub-stale-race"] = s6;
      try {
        // The board is still the forced-recapture position (S4). Start a plan for
        // a DIFFERENT board-only position (the K+P endgame, "b8=Q+"), delay it
        // by 900 ms, then let the position change back to the forced one while
        // the plan is in flight: the delayed recommendation must be discarded
        // (no render, no arrow, no speech) — the newer position always wins.
        await refreshPanelState(takeback.targetId, FORCED_FEN, "forced position before the stale race");
        await waitForPremove((state) => state.premoveStatus === "ready" && state.san === "Qxd2+", "the forced plan (cached)");
        const staleBefore = (await readPremove()).staleDiscards;
        const speakCountBefore = premoveSpeaks(await readTts()).length;
        const attemptsBefore = (await serverStats()).premoveAttempts;
        await setPremoveDelay(900, 1); // only the next /premove sleeps

        // (1) a fresh position whose plan will be delayed.
        await evaluateInPage(takeback.session, `(() => {
          globalThis.__humanplayProof.setBoard("board-single", ${JSON.stringify(STALE_RACE_PIECES)});
          globalThis.__humanplayProof.setMoveList(${JSON.stringify(MISMATCH_SANS)});
          return true;
        })()`);
        await waitFor("the delayed /premove request to arrive", async () => {
          const stats = await serverStats();
          return stats.premoveAttempts > attemptsBefore;
        });
        const k1Key = `${STALE_RACE_FEN}||2400|2400|5|0.9|top`; // the delayed request's key

        // (2) the position changes back to the forced one WHILE the plan is in flight.
        await evaluateInPage(takeback.session, `(() => {
          globalThis.__humanplayProof.setBoard("board-single", ${JSON.stringify(FORCED_PIECES)});
          globalThis.__humanplayProof.setMoveList(${JSON.stringify(MISMATCH_SANS)});
          return true;
        })()`);
        await waitForPremove((state) => state.san === "Qxd2+" && state.premoveStatus === "ready", "the forced plan back on the card");

        // (3) the delayed response lands: it must resolve stale.
        await sleep(1200);
        const card = await readPremove();
        const overlay = await readOverlay(takeback.session);
        const tts = await readTts();
        s6.card = {
          status: card.status,
          san: card.san,
          criterion: card.criterion,
          staleDiscards: card.staleDiscards,
          staleBefore,
          lastPlanKey: card.lastPlan?.key ?? null,
          key: card.currentKey,
          decisions: (card.decisions ?? []).slice(-4),
          delayedKey: k1Key,
        };
        s6.overlay = { display: overlay.display, arrows: overlay.data?.arrows ?? [] };
        expect(s6, card.staleDiscards === staleBefore + 1, `stale discard not counted: ${card.staleDiscards} vs ${staleBefore}`);
        expect(s6, (card.lastPlan?.key ?? null) !== k1Key, "the stale plan must never be rendered");
        expect(s6, card.san === "Qxd2+", `the newer plan must stay on the card: ${card.san}`);
        expect(s6, (card.lastPlan?.key ?? null) === `${FORCED_FEN}||2400|2400|5|0.9|top`, `current key: ${card.lastPlan?.key}`);
        expect(s6, (overlay.data?.premove?.uci ?? null) === "g2d2", `stale arrow survived: ${JSON.stringify(overlay.data?.premove)}`);
        expect(s6, !(overlay.data?.arrows ?? []).some((arrow) => arrow.uci === "b7b8q"), "the stale b8=Q+ arrow was drawn");
        expect(s6, premoveSpeaks(tts).length === speakCountBefore, `the stale plan was spoken: ${premoveSpeaks(tts).length} vs ${speakCountBefore}`);
        expect(s6, ((await serverStats()).premoveByKey[k1Key] ?? 0) === 1, `the delayed plan was requested ${(await serverStats()).premoveByKey[k1Key] ?? 0} times`);
        expect(s6, (await serverStats()).premoveDelaysApplied >= 1, "the artificial delay was not applied");
        s6.screenshot = await panelScreenshot("stub-stale-race.png");
        console.log(s6.pass
          ? `PASS stub-stale-race: delayed plan for ${k1Key ?? "?"} discarded (staleDiscards ${card.staleDiscards}); card kept ${card.san}, no stale arrow, no speech`
          : `FAIL stub-stale-race: ${s6.failures.join("; ")}`);
      } catch (error) {
        s6.pass = false;
        s6.failures.push(String(error?.message ?? error));
      }
      if (!s6.pass) for (const failure of s6.failures) fail(failure, "stub-stale-race");
      await writeFile(path.join(args.outDir, "stub-stale-race.json"), `${JSON.stringify(s6, null, 2)}\n`);

      /* ---------------------------------------------------------- case S7 */
      const s7 = { pass: true, failures: [], cases: {}, screenshot: null };
      summary.cases["stub-gating"] = s7;
      try {
        // (a) our turn is covered by S0. Here: assistant off on their turn —
        // no new request, the recommendation clears; back on -> restored.
        await refreshPanelState(takeback.targetId, FORCED_FEN, "forced position before the gating case");
        await waitForPremove((state) => state.premoveStatus === "ready" && state.san === "Qxd2+", "the forced plan (gating)");
        const offAttempts = (await serverStats()).premoveAttempts;
        await evaluateInPanel('document.getElementById("assistant-toggle").click(), true');
        const off = await waitForPremove((state) => state.gate === "off", "assistant off");
        s7.cases.assistantOff = { gate: off.gate, status: off.status, message: off.message, sanHidden: off.recHidden };
        expect(s7, /assistant off/.test(off.message ?? ""), `assistant-off message: ${off.message}`);
        expect(s7, off.recHidden === true, "the recommendation must clear when the assistant goes off");
        expect(s7, (await serverStats()).premoveAttempts === offAttempts, "premove request while the assistant was off");
        await evaluateInPanel('document.getElementById("assistant-toggle").click(), true');
        const backOn = await waitForPremove((state) => state.premoveStatus === "ready" && state.san === "Qxd2+", "the plan restored after assistant on");
        s7.cases.assistantBackOn = { gate: backOn.gate, san: backOn.san, criterion: backOn.criterion, fromCache: backOn.lastPlan?.fromCache ?? null };

        // (b) the M5 master switch gates the M7 arrow: "Show arrows" off clears
        // the premove arrow even with "Show premove arrow" still on; back on it
        // re-publishes the still-current plan.
        const arrowShown = (state) => (state.data?.arrows ?? []).some((arrow) => arrow.premove);
        await waitFor("the premove arrow before the master-switch test", async () => {
          const state = await readOverlay(takeback.session);
          return arrowShown(state) ? state : null;
        });
        await evaluateInPanel('document.getElementById("ov-arrows").click(), true'); // master OFF
        const masterOff = await waitFor("the premove arrow cleared by the master switch", async () => {
          const state = await readOverlay(takeback.session);
          return !arrowShown(state) ? state : null;
        });
        await evaluateInPanel('document.getElementById("ov-arrows").click(), true'); // master ON
        const masterOn = await waitFor("the premove arrow back after the master switch", async () => {
          const state = await readOverlay(takeback.session);
          return arrowShown(state) ? state : null;
        });
        await evaluateInPanel('document.getElementById("pm-arrow").click(), true'); // premove arrow OFF
        const premoveOff = await waitFor("the premove arrow cleared by its own switch", async () => {
          const state = await readOverlay(takeback.session);
          return !arrowShown(state) ? state : null;
        });
        await evaluateInPanel('document.getElementById("pm-arrow").click(), true'); // premove arrow ON
        const premoveOn = await waitFor("the premove arrow back after its own switch", async () => {
          const state = await readOverlay(takeback.session);
          return arrowShown(state) ? state : null;
        });
        s7.cases.arrowMasterSwitch = {
          masterOffDisplay: masterOff.display,
          masterOnArrows: (masterOn.data?.arrows ?? []).map((arrow) => ({ uci: arrow.uci, premove: Boolean(arrow.premove) })),
          premoveOffDisplay: premoveOff.display,
          premoveOnArrows: (premoveOn.data?.arrows ?? []).map((arrow) => ({ uci: arrow.uci, premove: Boolean(arrow.premove) })),
        };
        expect(s7, masterOff.display === "none" || !arrowShown(masterOff), `master switch did not clear the premove arrow: ${JSON.stringify(s7.cases.arrowMasterSwitch)}`);
        expect(s7, arrowShown(masterOn), "master switch back on did not restore the premove arrow");
        expect(s7, !arrowShown(premoveOff), "the premove arrow switch did not clear the arrow");
        expect(s7, arrowShown(premoveOn), "the premove arrow switch back on did not restore the arrow");

        // (c) TTS off: the plan still renders, nothing is spoken.
        const speaksBefore = premoveSpeaks(await readTts()).length;
        await evaluateInPanel('document.getElementById("tts-enabled").click(), true'); // TTS OFF
        await refreshPanelState(takeback.targetId, FORCED_FEN, "forced position (TTS off)");
        await sleep(500);
        const muted = await readPremove();
        const tts = await readTts();
        s7.cases.ttsOff = { speakCount: tts.speakCount, premoveSpeaks: premoveSpeaks(tts).length, decision: muted.decision, status: muted.status, premoveStatus: muted.premoveStatus };
        expect(s7, muted.premoveStatus === "ready", `plan must still render with TTS off: ${muted.premoveStatus} (${muted.status})`);
        expect(s7, premoveSpeaks(tts).length === speaksBefore, `spoke with TTS off: ${premoveSpeaks(tts).length} vs ${speaksBefore}`);
        expect(s7, muted.decision?.reason === "tts-off", `decision: ${JSON.stringify(muted.decision)}`);
        s7.screenshot = await panelScreenshot("stub-gating-assistant-off.png");
        console.log(s7.pass
          ? `PASS stub-gating: assistant off (0 requests) -> restored; premove arrow gated by the master switch + its own switch; TTS off (0 speaks)`
          : `FAIL stub-gating: ${s7.failures.join("; ")}`);
      } catch (error) {
        s7.pass = false;
        s7.failures.push(String(error?.message ?? error));
      }
      if (!s7.pass) for (const failure of s7.failures) fail(failure, "stub-gating");
      await writeFile(path.join(args.outDir, "stub-gating.json"), `${JSON.stringify(s7, null, 2)}\n`);

      /* ---------------------------------------------------------- case S8 */
      const s8 = { pass: true, failures: [], card: null, endpoints: null, screenshot: null };
      summary.cases["stub-flipped-arrow"] = s8;
      try {
        // TTS back on: the explicit toggle speaks the premove that is on the card
        // once more (forced), then the flipped position brings its own plan.
        await evaluateInPanel('document.getElementById("tts-enabled").click(), true');
        await waitForSpeak((call) => call.text === "premove queen takes d2, check", "the toggle-on forced speak");
        await refreshPanelState(flipped.targetId, FLIPPED_FEN, "flipped-black");
        const card = await waitForPremove((state) => state.premoveStatus === "ready" && state.san === "cxd4", "the flipped plan");
        const overlay = await waitFor("the flipped premove arrow", async () => {
          const state = await readOverlay(flipped.session);
          const arrows = state.data?.arrows ?? [];
          return arrows.some((arrow) => arrow.premove && arrow.uci === "c5d4") ? state : null;
        });
        const arrow = overlay.data.arrows.find((candidate) => candidate.premove) ?? null;
        const gt = await groundTruth(flipped.session, "board-single", ["c5", "d4"]);
        s8.card = { san: card.san, criterion: card.criterion, safety: card.safety, key: card.currentKey };
        s8.endpoints = {
          uci: arrow?.uci,
          style: arrow?.style,
          flipped: overlay.data?.flipped,
          fromErrorPx: maxPointError(arrow.from, gt.centres.c5),
          tipErrorPx: maxPointError(arrow.tip, gt.centres.d4),
        };
        expect(s8, card.criterion === "safe vs all replies", `criterion: ${card.criterion}`);
        expect(s8, s8.endpoints.flipped === true, "the overlay must report a flipped board");
        expect(s8, s8.endpoints.fromErrorPx <= 2 && s8.endpoints.tipErrorPx <= 2, `endpoint error ${JSON.stringify(s8.endpoints)}`);
        const spoken = await waitForSpeak((call) => call.text === "premove c-pawn takes d4", "the flipped premove speak");
        s8.speak = { text: spoken.call.text };
        s8.screenshot = await panelScreenshot("stub-flipped.png");
        await pageScreenshot(flipped.session, "stub-flipped-arrow.png");
        console.log(s8.pass
          ? `PASS stub-flipped-arrow: cxd4 dashed, endpoints ${s8.endpoints.fromErrorPx.toFixed(2)}/${s8.endpoints.tipErrorPx.toFixed(2)} px on a flipped board`
          : `FAIL stub-flipped-arrow: ${s8.failures.join("; ")}`);
      } catch (error) {
        s8.pass = false;
        s8.failures.push(String(error?.message ?? error));
      }
      if (!s8.pass) for (const failure of s8.failures) fail(failure, "stub-flipped-arrow");
      await writeFile(path.join(args.outDir, "stub-flipped-arrow.json"), `${JSON.stringify(s8, null, 2)}\n`);

      summary.latencies.stub = {
        takebackPlanRender_ms: summary.cases["stub-takeback-card"]?.card?.renderMs ?? null,
        takebackStateToRender_ms: summary.cases["stub-takeback-card"]?.card?.stateToRenderMs ?? null,
        takebackRoundTrip_ms: summary.cases["stub-takeback-card"]?.card?.roundTripMs ?? null,
        takebackEngine_ms: summary.cases["stub-takeback-card"]?.card?.engineMs ?? null,
        robustMutationToRender_ms: summary.cases["stub-robust-mutation"]?.card?.mutationToRenderMs ?? null,
        speechAfterToggle_ms: summary.cases["stub-speech"]?.speak?.issuedAfterToggleMs ?? null,
        target_ms: 600,
      };

      for (const fixture of [takeback, flipped, startpos]) await closeTarget(fixture.targetId);
    }

    /* ===================================================================== */
    /* REAL MODE                                                             */
    /* ===================================================================== */

    if (!stub) {
      /* ---------------------------------------------------------- case R1 */
      const r1 = { pass: true, failures: [], card: null, curl: null, latency: {}, screenshots: [] };
      summary.cases["real-takeback-equals-curl"] = r1;
      let takeback = null;
      try {
        takeback = await openFixture("premove-takeback.html");
        const stateAt = Date.now();
        await refreshPanelState(takeback.targetId, TAKEBACK_FEN, "premove-takeback (real)");
        const card = await waitForPremove((s) => s.premoveStatus === "ready" || s.premoveStatus === "no-safe-premove", "the real premove plan");
        r1.card = {
          status: card.status,
          san: card.san,
          criterion: card.criterion,
          safety: card.safety,
          minProb: card.minProb,
          rows: card.rows,
          caveat: card.caveat,
          meta: card.meta,
          key: card.currentKey,
          plan: card.lastPlan,
        };

        const payload = {
          fen: STARTPOS_FEN,
          moves: TAKEBACK_UCI,
          elo_self: 2400,
          elo_oppo: 2400,
          top_n: 5,
          min_safety: 0.9,
          mode: "top",
        };
        const curl = await curlPremove(payload);
        r1.curl = { wallMs: curl.wallMs, ok: curl.ok, body: curl.body };
        expect(r1, curl.ok, `curl /premove failed: ${curl.error ?? curl.stdout}`);

        const recommended = curl.body?.recommended ?? null;
        r1.latency = {
          engineMs: card.lastPlan?.engineMs ?? null,
          roundTripMs: card.lastPlan?.roundTripMs ?? null,
          renderMs: card.lastPlan?.renderMs ?? null,
          stateToRenderMs: card.lastPlan?.atEpochMs ? card.lastPlan.atEpochMs - stateAt : null,
          curlWallMs: curl.wallMs,
        };
        expect(r1, recommended !== null, "the real planner must recommend the take-back on this position");
        expect(r1, card.san === recommended?.san, `panel ${card.san} vs curl ${recommended?.san}`);
        expect(r1, card.lastPlan?.recommended?.uci === recommended?.uci, `uci ${card.lastPlan?.recommended?.uci} vs ${recommended?.uci}`);
        expect(r1, card.lastPlan?.recommended?.criterion === recommended?.criterion, `criterion ${card.lastPlan?.recommended?.criterion} vs ${recommended?.criterion}`);
        expect(r1, Math.abs((card.lastPlan?.recommended?.safety ?? 0) - (recommended?.safety ?? 0)) < 1e-6, "safety must match curl");
        expect(r1, Math.abs((card.lastPlan?.recommended?.min_response_prob ?? 0) - (recommended?.min_response_prob ?? 0)) < 1e-6, "min_response_prob must match curl");
        expect(r1, Math.abs((card.lastPlan?.opponent?.[0]?.prob ?? 0) - (recommended ? curl.body.opponent[0].prob : 0)) < 1e-6, "their top candidate must match curl");
        expect(r1, /safe vs all replies/.test(card.criterion ?? ""), `criterion chip: ${card.criterion}`);
        expect(r1, card.rows[0]?.san === curl.body.opponent[0].san, "their top move row");
        expect(r1, card.lastPlan?.engineMs <= 300, `engine ${card.lastPlan?.engineMs} ms vs target 300 ms (recorded, not a hard fail policy)`);
        expect(r1, r1.latency.stateToRenderMs <= 600, `state->render ${r1.latency.stateToRenderMs} ms vs target 600 ms`);

        const overlay = await waitFor("the real premove arrow", async () => {
          const state = await readOverlay(takeback.session);
          const arrows = state.data?.arrows ?? [];
          return arrows.some((arrow) => arrow.premove) ? state : null;
        });
        const arrow = overlay.data.arrows.find((candidate) => candidate.premove) ?? null;
        const gt = await groundTruth(takeback.session, "board-single", ["c4", "d5"]);
        r1.endpoints = {
          uci: arrow?.uci,
          style: arrow?.style,
          fromErrorPx: maxPointError(arrow.from, gt.centres.c4),
          tipErrorPx: maxPointError(arrow.tip, gt.centres.d5),
        };
        expect(r1, arrow?.uci === "c4d5" && arrow?.style === "dashed", `arrow: ${JSON.stringify(arrow)}`);
        expect(r1, r1.endpoints.fromErrorPx <= 2 && r1.endpoints.tipErrorPx <= 2, `endpoint error ${JSON.stringify(r1.endpoints)}`);

        r1.screenshots.push(await panelScreenshot("real-takeback-card.png"));
        r1.screenshots.push(await pageScreenshot(takeback.session, "real-takeback-arrow.png"));
        console.log(r1.pass
          ? `PASS real-takeback-equals-curl: panel = curl ${recommended?.san} (${recommended?.criterion}, safety ${recommended?.safety}); engine ${r1.latency.engineMs} ms, round-trip ${r1.latency.roundTripMs} ms, state->render ${r1.latency.stateToRenderMs} ms`
          : `FAIL real-takeback-equals-curl: ${r1.failures.join("; ")}`);
      } catch (error) {
        r1.pass = false;
        r1.failures.push(String(error?.message ?? error));
      }
      if (!r1.pass) for (const failure of r1.failures) fail(failure, "real-takeback-equals-curl");
      await writeFile(path.join(args.outDir, "real-takeback-equals-curl.json"), `${JSON.stringify(r1, null, 2)}\n`);
      if (takeback) await closeTarget(takeback.targetId);

      summary.latencies.real = {
        engine_ms: r1.latency.engineMs,
        roundTrip_ms: r1.latency.roundTripMs,
        stateToRender_ms: r1.latency.stateToRenderMs,
        curlWall_ms: r1.latency.curlWallMs,
        target_engine_ms: 300,
        target_ready_ms: 600,
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
    summary.checks.overlayDebugLines = summary.console.pages.filter((entry) => entry.text.includes("[humanplay] overlay")).length;
    summary.checks.extensionConsoleClean =
      summary.console.panelErrors.length === 0 &&
      summary.console.serviceWorkerErrors.length === 0 &&
      summary.console.pageErrors.length === 0;
    if (!summary.checks.extensionConsoleClean) fail("extension console reported errors — see summary.console");
    const harmlessNetworkLog = (text) => /ERR_UNKNOWN_URL_SCHEME|favicon\.ico|status of 40[04]/.test(text);
    const expectedOfflineLog = (text) => /ERR_EMPTY_RESPONSE|ERR_CONNECTION_REFUSED|ERR_CONNECTION_RESET/.test(text);
    const unexpectedNetworkErrors = summary.console.networkErrors.filter(
      (entry) => !harmlessNetworkLog(entry.text) && !(stub && expectedOfflineLog(entry.text)),
    );
    if (unexpectedNetworkErrors.length) {
      fail(`unexpected network errors: ${unexpectedNetworkErrors.map((entry) => entry.text).join(" | ")}`);
    }

    summary.ok = summary.failures.length === 0;
    const proofName = stub ? "premove-proof-stub.json" : "premove-proof-real.json";
    await writeFile(path.join(args.outDir, proofName), `${JSON.stringify(summary, null, 2)}\n`);
    console.log(
      `\n${summary.ok ? "ALL PREMOVE CASES PASSED" : `FAILURES (${summary.failures.length}):\n - ` + summary.failures.join("\n - ")}` +
        `\nproof: ${path.relative(REPO_ROOT, path.join(args.outDir, proofName))}`,
    );
    if (!summary.ok) process.exitCode = 1;
  } catch (error) {
    console.error(`premove-proof failed: ${error.message}`);
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
    if (fixtureServerLog && summary.failures.length) {
      console.error("fixture server log (tail):\n" + fixtureServerLog.split("\n").slice(-25).join("\n"));
    }
  }
}

main();

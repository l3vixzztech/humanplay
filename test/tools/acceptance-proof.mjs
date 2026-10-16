#!/usr/bin/env node
/**
 * acceptance-proof.mjs — Milestone 9 capstone: ONE end-to-end run of the whole
 * product in a real browser (Chrome for Testing), against the fixture corpus
 * and the local server.
 *
 * What one run asserts (all in ONE machine-readable report):
 *
 *   A. adapter        the shipped content script reads the fixture board state
 *                     (FEN / move list / user colour / board rect) from the DOM;
 *   B. replay         the 14-ply acceptance game (both castlings + captures) is
 *                     replayed move by move through DOM mutations:
 *                       * every user turn: the suggestion card renders the
 *                         server's top-3 and the panel result EQUALS a direct
 *                         request for the same position (the stub twin of
 *                         `curl`; --real mode uses actual `curl`);
 *                       * overlay arrows exist and their endpoints are ≤ 2 px
 *                         from the DOM-derived square centres;
 *                       * TTS speak calls are recorded for every suggestion AND
 *                         every recommended premove, exactly once per position
 *                         (the Refresh-state re-emit adds no second speak);
 *                       * every opponent turn: the premove card carries a
 *                         recommendation (criterion + safety + min response) or
 *                         the honest "no safe premove" reason, and a
 *                         recommended premove is drawn as a dashed arrow;
 *                       * commentary: exactly one feed entry per ply, both
 *                         colours, newest first;
 *   C. rematch        a rematch resets every layer: analyze card + cache,
 *                     premove card + cache, arrows, TTS dedupe keys, feed;
 *   D. soak           a 104-ply replay leaks nothing measurable: exactly one
 *                     overlay canvas, the feed holds the newest 50, all three
 *                     client caches stay ≤ 24, the spoken-key store ≤ 64;
 *   E. real page      (best-effort, --real-page) one suggestion routed to a
 *                     real chess.com game page through the real SW path;
 *   F. offline UX     (stub mode) HTTP 503 -> one retry (arrivals = 2), the
 *                     consistent "server offline" wording on every card, the
 *                     Copy-start-command button, and auto-recovery when the
 *                     server returns;
 *   G. console        the panel, the service worker and the fixture pages are
 *                     free of console errors.
 *
 * Modes (both drive the production code; the shipped manifest is never edited —
 * a hash-compared temp copy adds the fixture origin to the content-script
 * matches, like every other proof):
 *
 *   --stub  (default)  spawns `test/tools/fixture_server.py` and registers the
 *                      canned bodies recorded from the real server by
 *                      `test/tools/collect-acceptance-canned.py`
 *                      (test/fixtures/captures/acceptance/canned-acceptance.json);
 *                      the soak uses deterministic synthetic bodies (documented:
 *                      it asserts leak-freedom, not fact correctness).
 *   --real             expects the real Maia server on 127.0.0.1:8765 and
 *                      cross-checks every user turn against real `curl /analyze`;
 *                      segment F is skipped (it needs the stub's /debug routes).
 *
 * Usage:
 *   node test/tools/acceptance-proof.mjs --chrome <path> [--stub|--real]
 *     [--extension extension] [--out-dir test/fixtures/captures/acceptance]
 *     [--real-page [url]] [--soak-plies 104] [--headful] [--keep-profile]
 *     [--timeout-ms 45000]
 *
 * Exit code is non-zero when any assertion fails. Evidence (summary JSON +
 * screenshots) lands in test/fixtures/captures/acceptance/.
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
const STARTPOS_FEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
const CANNED_FILE = path.join(REPO_ROOT, "test/fixtures/captures/acceptance/canned-acceptance.json");
const DEFAULT_REAL_PAGE = "https://www.chess.com/game/live/186394589423";
const ENDPOINT_TOLERANCE_PX = 2;
const CACHE_LRU = 24;
const FEED_CAP = 50;
const SPOKEN_KEYS_CAP = 64;
const BOARD_ID = "board-single";

/**
 * The acceptance game: the 14-ply middlegame fixture (both castlings,
 * captures) replayed from the standard start position on `startpos.html`.
 * `pieces` move in order; `remove` squares lose their piece (a capture); the
 * move list is then set to the SAN prefix — exactly the DOM mutations a real
 * game page performs when a move lands.
 */
const ACCEPTANCE_GAME = {
  name: "middlegame-castling",
  finalFen: "r1b2rk1/ppp2ppp/2np1q2/2b1p3/2B1P3/3P1N2/PPP2PPP/RN1Q1RK1 w - - 0 8",
  plies: [
    { san: "e4", pieces: [{ piece: "wp", from: "square-52", to: "square-54" }] },
    { san: "e5", pieces: [{ piece: "bp", from: "square-57", to: "square-55" }] },
    { san: "Nf3", pieces: [{ piece: "wn", from: "square-71", to: "square-63" }] },
    { san: "Nc6", pieces: [{ piece: "bn", from: "square-28", to: "square-36" }] },
    { san: "Bc4", pieces: [{ piece: "wb", from: "square-61", to: "square-34" }] },
    { san: "Bc5", pieces: [{ piece: "bb", from: "square-68", to: "square-35" }] },
    {
      san: "O-O",
      pieces: [
        { piece: "wk", from: "square-51", to: "square-71" },
        { piece: "wr", from: "square-81", to: "square-61" },
      ],
    },
    { san: "Nf6", pieces: [{ piece: "bn", from: "square-78", to: "square-66" }] },
    { san: "d3", pieces: [{ piece: "wp", from: "square-42", to: "square-43" }] },
    { san: "d6", pieces: [{ piece: "bp", from: "square-47", to: "square-46" }] },
    { san: "Bg5", pieces: [{ piece: "wb", from: "square-31", to: "square-37" }] },
    {
      san: "O-O",
      pieces: [
        { piece: "bk", from: "square-58", to: "square-78" },
        { piece: "br", from: "square-88", to: "square-68" },
      ],
    },
    { san: "Bxf6", pieces: [{ piece: "wb", from: "square-37", to: "square-66" }], remove: ["square-66"] },
    { san: "Qxf6", pieces: [{ piece: "bq", from: "square-48", to: "square-66" }], remove: ["square-66"] },
  ],
};

/** UCI of the acceptance game (the collector's python-chess replay). */
const ACCEPTANCE_UCI = [
  "e2e4", "e7e5", "g1f3", "b8c6", "f1c4", "f8c5", "e1g1", "g8f6",
  "d2d3", "d7d6", "c1g5", "e8g8", "g5f6", "d8f6",
];

/** The soak: a 104-ply knight shuffle (52 full moves), legal forever. */
function soakUci(index) {
  if (index % 2 === 0) return (index / 2) % 2 === 0 ? "g1f3" : "f3g1";
  return ((index - 1) / 2) % 2 === 0 ? "g8f6" : "f6g8";
}

function soakSan(index) {
  if (index % 2 === 0) return (index / 2) % 2 === 0 ? "Nf3" : "Ng1";
  return ((index - 1) / 2) % 2 === 0 ? "Nf6" : "Ng8";
}

function soakPieces(index) {
  if (index % 2 === 0) {
    const out = (index / 2) % 2 === 0;
    return [{ piece: "wn", from: out ? "square-71" : "square-63", to: out ? "square-63" : "square-71" }];
  }
  const out = ((index - 1) / 2) % 2 === 0;
  return [{ piece: "bn", from: out ? "square-78" : "square-66", to: out ? "square-66" : "square-78" }];
}

function soakPrefixUci(count) {
  const moves = [];
  for (let index = 0; index < count; index += 1) moves.push(soakUci(index));
  return moves;
}

function soakPrefixSan(count) {
  const sans = [];
  for (let index = 0; index < count; index += 1) sans.push(soakSan(index));
  return sans;
}

/* ------------------------------------------------------------------ args */

function parseArgs(argv) {
  const args = {
    chrome: null,
    extension: path.join(REPO_ROOT, "extension"),
    outDir: path.join(REPO_ROOT, "test/fixtures/captures/acceptance"),
    mode: "stub",
    realPage: null,
    soakPlies: 104,
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
      case "--real-page":
        args.realPage = argv[i + 1] && !argv[i + 1].startsWith("--") ? next() : DEFAULT_REAL_PAGE;
        break;
      case "--soak-plies": args.soakPlies = Math.max(100, Number(next())); break;
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

async function waitFor(description, fn, { timeoutMs = 30000, intervalMs = 60 } = {}) {
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
    server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port }));
  });
}

/** Direct POST to the server — the stub twin of `curl` (--real uses real curl). */
async function postJson(url, payload, { timeoutMs = 30000 } = {}) {
  const startedAt = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: controller.signal,
      cache: "no-store",
    });
    const body = await response.json().catch(() => null);
    return { ok: response.ok, status: response.status, body, wallMs: Date.now() - startedAt };
  } catch (error) {
    return { ok: false, status: null, body: null, error: String(error?.message ?? error), wallMs: Date.now() - startedAt };
  } finally {
    clearTimeout(timer);
  }
}

/** Real `curl` POST (used by --real: the panel's result must equal curl's). */
function curlJson(url, payload, { timeoutMs = 30000 } = {}) {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    execFile(
      "curl",
      ["-s", "-X", "POST", url, "-H", "Content-Type: application/json", "-d", JSON.stringify(payload)],
      { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 },
      (error, stdout) => {
        let body = null;
        try {
          body = JSON.parse(stdout);
        } catch {
          body = null;
        }
        resolve({
          ok: !error && body !== null,
          status: null,
          body,
          wallMs: Date.now() - startedAt,
          error: error ? String(error.message) : null,
        });
      },
    );
  });
}

function uciSquares(uci) {
  return { from: String(uci).slice(0, 2), to: String(uci).slice(2, 4) };
}

function maxPointError(actual, expected) {
  return Math.max(Math.abs(actual[0] - expected.x), Math.abs(actual[1] - expected.y));
}

/* ----------------------------------------------------------- page helpers */

/**
 * Page-side helpers (installed into the fixture pages' main world).
 * `groundTruth` derives the square-centre map from the DOM's painted pieces —
 * deliberately independent of overlay-geometry.js — so a mapping bug in the
 * overlay cannot hide behind a shared formula (same technique as the M5 proof).
 */
const PAGE_HELPERS = String.raw`
globalThis.__humanplayAcceptance = {
  movePiece(board, pieceClass, from, to) {
    const element = board.querySelector(".piece." + pieceClass + "." + from)
      ?? board.querySelector(".piece." + from + "." + pieceClass);
    if (!element) throw new Error("piece not found: " + pieceClass + " " + from);
    element.classList.remove(from);
    element.classList.add(to);
    const match = /^square-(\d)(\d)$/.exec(to);
    if (match) {
      const file = Number(match[1]) - 1;
      const rank = Number(match[2]) - 1;
      const flipped = board.classList.contains("flipped");
      const column = flipped ? 7 - file : file;
      const row = flipped ? rank : 7 - rank;
      element.style.left = (column * 12.5) + "%";
      element.style.top = (row * 12.5) + "%";
    }
  },
  applyPly(ply, sans) {
    const board = document.getElementById("board-single");
    if (!board) throw new Error("fixture board #board-single not found");
    for (const square of ply.remove ?? []) {
      const victim = board.querySelector(".piece." + square);
      if (!victim) throw new Error("captured piece not found on " + square);
      victim.remove();
    }
    for (const move of ply.pieces ?? []) this.movePiece(board, move.piece, move.from, move.to);
    this.setMoveList(sans);
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
    document.querySelector("wc-simple-move-list .timestamps-with-base-time").innerHTML = rows.join("\\n");
  },
  /** Rebuild the standard start position (a rematch) + an empty move list. */
  resetToStartpos() {
    const board = document.getElementById("board-single");
    if (!board) throw new Error("fixture board #board-single not found");
    for (const piece of [...board.querySelectorAll(".piece")]) piece.remove();
    const ranks = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR".split("/");
    const markup = [];
    for (let row = 0; row < 8; row += 1) {
      let file = 0;
      for (const symbol of ranks[row]) {
        if (/[1-8]/.test(symbol)) { file += Number(symbol); continue; }
        const code = (symbol === symbol.toUpperCase() ? "w" : "b") + symbol.toLowerCase();
        const square = "square-" + (file + 1) + (8 - row);
        markup.push('<div class="piece ' + code + ' ' + square + '" style="left:' + (file * 12.5) + '%;top:' + (row * 12.5) + '%"></div>');
        file += 1;
      }
    }
    board.insertAdjacentHTML("beforeend", markup.join(""));
    this.setMoveList([]);
    return true;
  },
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
      boardStackingZ: this.boardStackingZ(board),
      centres,
      piecesUsed: pieces.length,
    };
  },
  overlay() {
    const canvas = document.getElementById("humanplay-overlay-canvas");
    const out = { canvasExists: !!canvas, canvasCount: document.querySelectorAll("canvas").length };
    if (!canvas) return out;
    const style = getComputedStyle(canvas);
    out.canvas = {
      position: style.position,
      pointerEvents: style.pointerEvents,
      display: style.display,
      zIndex: Number(canvas.style.zIndex) || null,
      width: canvas.width,
      height: canvas.height,
      dpr: window.devicePixelRatio || 1,
    };
    out.dataset = canvas.dataset.humanplay ? JSON.parse(canvas.dataset.humanplay) : null;
    return out;
  },
  overlayWithTruth(boardId) {
    return { ...this.overlay(), truth: this.groundTruth(boardId, globalThis.THE_SQUARES ?? []) };
  },
};
true;
`;

/* ------------------------------------------------------------------ main */

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const stub = args.mode === "stub";
  const sourceExtensionDir = path.resolve(args.extension);
  const summary = {
    tool: "acceptance-proof.mjs",
    milestone: "M9",
    mode: args.mode,
    generatedAt: new Date().toISOString(),
    chrome: args.chrome,
    extension: sourceExtensionDir,
    checks: {},
    segments: {},
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
  const openTargets = new Set();

  const fail = (message, segment = null) => {
    summary.failures.push(segment ? `${segment}: ${message}` : message);
    console.error(`FAIL ${segment ? `${segment}: ` : ""}${message}`);
  };

  const closeTarget = async (targetId) => {
    openTargets.delete(targetId);
    try {
      await cdp.send("Target.closeTarget", { targetId });
    } catch {
      /* already gone */
    }
  };

  try {
    await mkdir(args.outDir, { recursive: true });

    /* ------------------------------------------------ browser fixture server */

    const { server, port } = await startStaticServer(path.join(REPO_ROOT, "test/fixtures"));
    staticServer = server;
    const origin = `http://127.0.0.1:${port}`;
    summary.checks.staticServer = { origin, root: "test/fixtures" };

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

    let cannedData = null;
    if (stub) {
      const existing = await serverHealth().catch(() => null);
      if (existing?.model === "fixture-static-server") {
        summary.checks.analysisServer = { mode: "stub (already running)", health: existing };
      } else if (existing) {
        throw new Error(
          `port 8765 is serving ${JSON.stringify(existing)} — stub mode needs test/tools/fixture_server.py there. ` +
            "Stop the real server first (or pass --real).",
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
      if (!existsSync(CANNED_FILE)) {
        throw new Error(
          `stub mode needs ${path.relative(REPO_ROOT, CANNED_FILE)} — record it from the real server with ` +
            "`server/.venv/bin/python test/tools/collect-acceptance-canned.py`",
        );
      }
      cannedData = JSON.parse(await readFile(CANNED_FILE, "utf8"));
      summary.checks.canned = {
        source: "test/fixtures/captures/acceptance/canned-acceptance.json (recorded from the real Maia server)",
        generatedAt: cannedData.generatedAt,
        server: cannedData.server,
        analyze: Object.keys(cannedData.analyze).length,
        premove: Object.keys(cannedData.premove).length,
        explain: Object.keys(cannedData.explain).length,
      };
      let registered = 0;
      const register = async (route, key, response) => {
        const result = await postJson(`${SERVER_ORIGIN}/debug/${route}`, { key, response });
        if (!result.ok) throw new Error(`could not register ${route} canned body for ${key}: ${JSON.stringify(result)}`);
        registered += 1;
      };
      for (const [key, response] of Object.entries(cannedData.analyze)) await register("canned", key, response);
      for (const [key, response] of Object.entries(cannedData.premove)) await register("canned-premove", key, response);
      for (const [key, response] of Object.entries(cannedData.explain)) await register("canned-explain", key, response);
      registered += await registerSyntheticSoakBodies(register, args.soakPlies);
      summary.checks.canned.registered = registered;
    } else {
      const health = await serverHealth();
      if (!String(health.model ?? "").includes("maia")) {
        throw new Error(
          `--real needs the Maia server on 127.0.0.1:8765 (got ${JSON.stringify(health)}). Start it: scripts/run-server.sh`,
        );
      }
      summary.checks.analysisServer = { mode: "real", health };
    }

    const serverStats = async () =>
      stub ? (await fetch(`${SERVER_ORIGIN}/debug/stats`, { cache: "no-store" })).json() : null;
    const setServerMode = async (mode) => {
      const result = await postJson(`${SERVER_ORIGIN}/debug/mode`, { mode });
      if (!result.ok) throw new Error(`could not set the fixture server mode to ${mode}`);
    };

    /* ------------------------------------------------------- manifest variant */

    const manifestPath = path.join(sourceExtensionDir, "manifest.json");
    const sourceManifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    summary.checks.manifest = {
      path: path.relative(REPO_ROOT, manifestPath),
      sha256: sha256(readFileSync(manifestPath)),
      version: sourceManifest.version,
      permissions: sourceManifest.permissions,
      host_permissions: sourceManifest.host_permissions,
      hasAllUrls: JSON.stringify(sourceManifest).includes("<all_urls>"),
    };
    if (!/^\d+\.\d+\.\d+$/.test(String(sourceManifest.version))) {
      fail(`the shipped manifest version is not a semver release version (found ${sourceManifest.version})`, "release");
    }

    variantDir = await mkdtemp(path.join(tmpdir(), "humanplay-acceptance-variant-"));
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
      addedContentScriptMatch: originMatch,
      codeFilesCompared: sourceFiles.length,
      codeFileMismatches: mismatches,
      codeIdentical: mismatches.length === 0,
    };
    if (mismatches.length) throw new Error(`manifest variant differs in code files: ${mismatches.join(", ")}`);

    const extensionId = unpackedExtensionId(variantDir);
    summary.checks.extensionId = extensionId;

    /* --------------------------------------------------------------- browser */

    profileDir = await mkdtemp(path.join(tmpdir(), "humanplay-acceptance-"));
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
      // The M6 proof's flag: without a speech backend every utterance errors on Linux.
      "--enable-speech-dispatcher",
    ];
    if (!args.headful) launchArgs.unshift("--headless=new");
    launchArgs.push("about:blank");

    chromeProcess = spawn(args.chrome, launchArgs, { stdio: ["ignore", "pipe", "pipe"] });
    chromeProcess.stderr.on("data", () => {});
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

    const recordLog = (text, sessionId, bucket, source) => {
      const role = sessionRole.get(sessionId) ?? "pages";
      logs[role === "panel" ? "panel" : role === "service-worker" ? "serviceWorker" : "pages"].push({ bucket, source, text });
    };
    cdp.on("Runtime.exceptionThrown", (params, sessionId) => {
      const details = params.exceptionDetails;
      recordLog(details?.exception?.description ?? details?.text ?? "exception", sessionId, "error", "javascript");
    });
    cdp.on("Runtime.consoleAPICalled", (params, sessionId) => {
      const text = (params.args ?? []).map((arg) => arg.value ?? arg.description ?? arg.type).join(" ");
      recordLog(text, sessionId, params.type === "error" ? "error" : params.type === "warning" ? "warning" : "info", "console");
    });
    cdp.on("Log.entryAdded", ({ entry }, sessionId) => {
      recordLog(entry.text + (entry.url ? ` (${entry.url})` : ""), sessionId, entry.level === "error" ? "error" : entry.level === "warning" ? "warning" : "info", entry.source);
    });

    /* ------------------------------------------------ service worker + panel */

    const serviceWorkerPath = sourceManifest.background?.service_worker;
    const expectedWorkerUrl = `chrome-extension://${extensionId}/${serviceWorkerPath}`;
    const serviceWorker = await waitFor(
      "our extension's service worker target",
      () => [...targets.values()].find((target) => target.type === "service_worker" && target.url === expectedWorkerUrl),
      { timeoutMs: args.timeoutMs },
    );
    summary.checks.serviceWorkerUrl = serviceWorker.url;
    let workerSessionId = (await cdp.send("Target.attachToTarget", { targetId: serviceWorker.targetId, flatten: true })).sessionId;
    sessionRole.set(workerSessionId, "service-worker");
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

    const panelTarget = await cdp.send("Target.createTarget", { url: `chrome-extension://${extensionId}/src/ui/sidepanel.html` });
    const panelSession = (await cdp.send("Target.attachToTarget", { targetId: panelTarget.targetId, flatten: true })).sessionId;
    sessionRole.set(panelSession, "panel");
    await cdp.send("Page.enable", {}, panelSession);
    await cdp.send("Runtime.enable", {}, panelSession);
    await cdp.send("Log.enable", {}, panelSession);

    const evaluateInPanel = async (expression, { userGesture = false } = {}) => {
      const result = await cdp.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true, userGesture }, panelSession);
      if (result.exceptionDetails) {
        throw new Error(`panel evaluation failed: ${result.exceptionDetails.exception?.description ?? result.exceptionDetails.text}`);
      }
      return result.result.value;
    };

    await waitFor("panel module init", async () => {
      const ready = await evaluateInPanel('document.readyState === "complete" && !!document.getElementById("mx-analyze") && !!globalThis.__humanplayAnalysis');
      return ready === true;
    }, { timeoutMs: args.timeoutMs });

    const evaluateInPage = async (session, expression) => {
      const result = await cdp.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, session);
      if (result.exceptionDetails) {
        throw new Error(`page evaluation failed: ${result.exceptionDetails.exception?.description ?? result.exceptionDetails.text}`);
      }
      return result.result.value;
    };

    const readPanel = () =>
      evaluateInPanel(`(() => {
        const debug = globalThis.__humanplayAnalysis;
        const text = (id) => document.getElementById(id)?.textContent ?? null;
        const hidden = (id) => document.getElementById(id)?.hidden ?? null;
        return {
          mx: {
            status: text("mx-status"), statusClass: document.getElementById("mx-status")?.className ?? null,
            message: hidden("mx-message") ? null : text("mx-message"),
            rows: [...document.querySelectorAll("#mx-moves .mx-move")].map((li) => ({
              rank: li.dataset.rank, san: li.dataset.san, uci: li.dataset.uci,
              prob: li.querySelector(".mx-prob")?.textContent ?? null, top: li.classList.contains("mx-top"),
            })),
            meta: hidden("mx-meta") ? null : text("mx-meta"),
            wdlLabel: text("mx-wdl-label"),
          },
          pm: {
            status: text("pm-status"), statusClass: document.getElementById("pm-status")?.className ?? null,
            message: hidden("pm-message") ? null : text("pm-message"),
            san: text("pm-san"), criterion: text("pm-criterion"), safety: text("pm-safety"),
            detail: text("pm-detail"), caveat: hidden("pm-caveat") ? null : text("pm-caveat"),
            oppo: [...document.querySelectorAll("#pm-oppo .pm-oppo-row")].map((li) => ({
              san: li.dataset.san, prob: li.dataset.prob, terminal: li.dataset.terminal || null,
            })),
          },
          cm: {
            status: text("cm-status"),
            message: hidden("cm-message") ? null : text("cm-message"),
            feedCount: document.querySelectorAll("#cm-feed .cm-entry").length,
            entries: [...document.querySelectorAll("#cm-feed .cm-entry")].map((li) => ({
              ply: Number(li.dataset.ply), san: li.dataset.san, by: li.dataset.by,
              classification: li.dataset.classification, source: li.dataset.source,
              playerLabel: li.querySelector(".cm-by")?.textContent ?? null,
              chip: li.querySelector(".cm-chip")?.textContent ?? null,
              text: li.querySelector(".cm-text")?.textContent ?? null,
            })),
            meta: hidden("cm-meta") ? null : text("cm-meta"),
          },
          cc: {
            fen: text("cc-fen"), moves: text("cc-moves"), turn: text("cc-turn"), color: text("cc-color"),
            mismatch: hidden("cc-mismatch") ? null : text("cc-mismatch"),
            warning: hidden("cc-warning") ? null : text("cc-warning"),
            hint: text("cc-hint"),
          },
          server: {
            chip: text("server-chip"), chipClass: document.getElementById("server-chip")?.className ?? null,
            copied: hidden("server-copied") ? null : text("server-copied"),
            copyButton: document.getElementById("copy-start-command")?.textContent ?? null,
          },
          debug: {
            gate: debug.gate, status: debug.status, currentKey: debug.currentKey, lastRenderKey: debug.lastRenderKey,
            lastResult: debug.lastResult, renderCount: debug.renderCount, requestCount: debug.requestCount,
            staleDiscardCount: debug.staleDiscardCount, lastRoundTripMs: debug.lastRoundTripMs,
            lastError: debug.lastError, ttsEnabled: debug.tts.enabled, ttsDecision: debug.tts.decision,
            ttsDecisions: debug.tts.decisions.length,
          },
          premove: {
            gate: debug.premove.gate, status: debug.premove.status, planCount: debug.premove.planCount,
            planStaleDiscards: debug.premove.planStaleDiscards, lastPlan: debug.premove.lastPlan,
            sentMode: debug.premove.sentMode, lastClearReason: debug.premove.lastClearReason,
          },
          commentary: {
            gate: debug.commentary.gate, status: debug.commentary.status, errors: debug.commentary.errors,
            lastError: debug.commentary.lastError,
          },
          caches: {
            analyze: debug.client.cacheSize(), analyzeStats: debug.client.getStats(),
            premove: debug.premoveClient.cacheSize(), explain: debug.explainClient.cacheSize(),
            spokenKeys: debug.spokenKeyStore.size(),
            feed: debug.commentaryFeed.size(), feedStats: debug.commentaryFeed.getStats(),
          },
          reset: debug.gameReset,
          recovery: { ...debug.recovery, timer: Boolean(debug.recovery.timer) },
          clipboard: debug.clipboard, health: debug.getHealth(),
        };
      })()`);

    /** A light per-ply tick (keeps the 104-ply soak polls cheap). */
    const readTick = (ply = null) =>
      evaluateInPanel(`(() => {
        const debug = globalThis.__humanplayAnalysis;
        return {
          renderKey: debug.lastRenderKey,
          status: debug.status,
          pmStatus: debug.premove.status,
          pmKey: debug.premove.lastPlan?.key ?? null,
          feedNewest: debug.commentaryFeed.getEntries()[0]?.ply ?? null,
          feedCount: debug.commentaryFeed.size(),
          hasPly: ${ply === null ? "false" : `debug.commentaryFeed.hasPly(${Number(ply)})`},
        };
      })()`);

    const readTts = () =>
      evaluateInWorker(`(() => {
        const d = globalThis.__humanplayTts;
        if (!d) return null;
        return {
          scope: d.scope, engine: d.engine, speakCount: d.speakCount, stopCount: d.stopCount,
          calls: d.calls.map((call) => ({ kind: call.kind, text: call.text, reason: call.reason, source: call.source, key: call.key, san: call.san, uci: call.uci, ok: call.ok })),
          lastState: d.lastState, badge: d.badge,
        };
      })()`);

    const pageScreenshot = async (session, name) => {
      const shot = await cdp.send("Page.captureScreenshot", { format: "png" }, session);
      const target = path.join(args.outDir, name);
      await writeFile(target, Buffer.from(shot.data, "base64"));
      return path.relative(REPO_ROOT, target);
    };

    const panelScreenshot = async (name) => {
      await cdp.send("Emulation.setDeviceMetricsOverride", { width: 420, height: 1500, deviceScaleFactor: 2, mobile: false }, panelSession);
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
      return { targetId: target.targetId, session };
    };

    const activate = (targetId) => cdp.send("Target.activateTarget", { targetId }).catch(() => {});

    const refreshPanelState = async () => {
      await activate(page.targetId);
      await evaluateInPanel(`document.getElementById("cc-refresh").click(); true`);
      await sleep(300);
    };

    /* ----------------------------------------------- protocol-level helpers */

    const analyzeKey = (uci) => `${STARTPOS_FEN}|${uci.join(" ")}|2400|2400|3`;
    const premoveKey = (uci) => `${STARTPOS_FEN}|${uci.join(" ")}|2400|2400|5|0.9|top`;
    const top3 = (body) => (body?.moves ?? []).map((move) => ({ san: move.san, uci: move.uci, prob: move.prob }));

    const assertTop3Equals = (panelRows, serverBody, label, segment) => {
      const expected = top3(serverBody);
      if (panelRows.length !== expected.length) {
        fail(`${label}: the panel shows ${panelRows.length} rows, the server returned ${expected.length}`, segment);
        return false;
      }
      let equal = true;
      expected.forEach((move, index) => {
        const row = panelRows[index];
        if (row.uci !== move.uci) {
          fail(`${label}: row ${index + 1} uci ${row.uci} != server ${move.uci}`, segment);
          equal = false;
        }
        const shown = Number(String(row.prob ?? "").replace("%", ""));
        if (!Number.isFinite(shown) || Math.abs(shown - move.prob * 100) > 0.05) {
          fail(`${label}: row ${index + 1} probability ${row.prob} != server ${(move.prob * 100).toFixed(1)}%`, segment);
          equal = false;
        }
      });
      return equal;
    };

    /** Endpoint check: every drawn arrow within ≤ 2 px of the DOM ground truth. */
    const assertArrows = async (session, boardId, overlay, record, segment) => {
      const arrows = overlay?.dataset?.arrows ?? [];
      const recordEntry = { count: arrows.length, maxEndpointErrorPx: null, arrows: [] };
      if (record) record.geometry = recordEntry;
      if (!overlay?.truth) {
        fail(`${segment}: no DOM ground truth for the board`, segment);
        return recordEntry;
      }
      let worst = 0;
      for (const arrow of arrows) {
        const { from, to } = uciSquares(arrow.uci);
        const truthFrom = overlay.truth.centres[from];
        const truthTo = overlay.truth.centres[to];
        if (!truthFrom || !truthTo) {
          fail(`${segment}: no ground-truth centre for ${arrow.uci}`, segment);
          continue;
        }
        const fromErr = maxPointError(arrow.from, truthFrom);
        const tipErr = maxPointError(arrow.tip, truthTo);
        worst = Math.max(worst, fromErr, tipErr);
        recordEntry.arrows.push({ uci: arrow.uci, premove: arrow.premove, fromErrorPx: fromErr, tipErrorPx: tipErr });
        if (fromErr > ENDPOINT_TOLERANCE_PX) fail(`${segment}: ${arrow.uci} from endpoint off by ${fromErr.toFixed(2)} px`, segment);
        if (tipErr > ENDPOINT_TOLERANCE_PX) fail(`${segment}: ${arrow.uci} tip endpoint off by ${tipErr.toFixed(2)} px`, segment);
      }
      recordEntry.maxEndpointErrorPx = worst;
      return recordEntry;
    };

    /* ====================================================================== */
    /* SETUP                                                                  */
    /* ====================================================================== */

    // Enable TTS through the real checkbox handler (persists settings; the
    // service worker picks the change up through chrome.storage.onChanged).
    await evaluateInPanel(`(() => { const box = document.getElementById("tts-enabled"); if (!box.checked) box.click(); return true; })()`);
    await waitFor("TTS to be enabled in the panel", async () => (await readPanel()).debug.ttsEnabled === true, { timeoutMs: 10000 });
    summary.checks.ttsEnabled = true;

    const page = await openFixture("startpos.html");
    await activate(page.targetId);
    await evaluateInPage(page.session, PAGE_HELPERS);
    // Ground truth for every square: the premove planner legitimately names
    // squares outside the played game (a reply to a move that never happened).
    const squares = [];
    for (const file of "abcdefgh") for (let rank = 1; rank <= 8; rank += 1) squares.push(`${file}${rank}`);
    await evaluateInPage(page.session, `globalThis.THE_SQUARES = ${JSON.stringify(squares)}; true`);
    summary.checks.groundTruthSquares = squares.length;

    /* ====================================================================== */
    /* SEGMENT A — adapter                                                   */
    /* ====================================================================== */

    const segA = { pass: true, failures: [] };
    summary.segments.adapter = segA;
    try {
      const adapterState = await waitFor("the adapter's first broadcast", async () => {
        const current = await readPanel();
        return current.debug.currentKey === analyzeKey([]) ? current : null;
      }, { timeoutMs: args.timeoutMs });
      segA.state = {
        panelKey: adapterState.debug.currentKey,
        ccFen: adapterState.cc.fen,
        ccMoves: adapterState.cc.moves,
        ccTurn: adapterState.cc.turn,
        ccColor: adapterState.cc.color,
        ccHint: adapterState.cc.hint,
      };
      if (adapterState.cc.fen !== STARTPOS_FEN) fail(`the game-state card shows FEN ${adapterState.cc.fen}`, "adapter");
      if (!String(adapterState.cc.moves ?? "").startsWith("0 moves")) fail(`the game-state card shows ${adapterState.cc.moves} moves`, "adapter");
      if (!String(adapterState.cc.color ?? "").startsWith("white")) fail(`the game-state card says you play ${adapterState.cc.color}`, "adapter");
      const overlay = await evaluateInPage(page.session, "globalThis.__humanplayAcceptance.overlay()");
      segA.canvas = { canvasExists: overlay.canvasExists, canvasCount: overlay.canvasCount };

      // The adapter's fast-fix protocol line: force a real warning by setting
      // the fallback colour to the wrong side, then restore it.
      await evaluateInPanel(`(() => {
        const select = document.getElementById("cc-color-setting");
        select.value = "black";
        select.dispatchEvent(new Event("change", { bubbles: true }));
        return true;
      })()`);
      const warned = await waitFor("the adapter warning to reach the panel", async () => {
        const current = await readPanel();
        return String(current.cc.warning ?? "").includes("panel setting says you play black") ? current : null;
      }, { timeoutMs: 15000, intervalMs: 60 });
      segA.warning = warned.cc.warning;
      if (!String(warned.cc.warning).includes("fast-fix protocol")) fail("the adapter warning does not reference the fast-fix snapshot protocol", "adapter");
      if (!String(warned.cc.warning).includes("Record chess.com snapshot")) fail("the adapter warning does not name the snapshot button", "adapter");
      await evaluateInPanel(`(() => {
        const select = document.getElementById("cc-color-setting");
        select.value = "auto";
        select.dispatchEvent(new Event("change", { bubbles: true }));
        return true;
      })()`);
      await waitFor("the warning to clear after restoring the fallback colour", async () => {
        const current = await readPanel();
        return !String(current.cc.warning ?? "").includes("panel setting says") ? current : null;
      }, { timeoutMs: 15000, intervalMs: 60 });

      segA.screenshot = await pageScreenshot(page.session, "01-adapter-startpos.png");
      console.log(`PASS acceptance-adapter: start position read from the DOM (card FEN), warning + fast-fix line verified, ${overlay.canvasCount} canvas`);
    } catch (error) {
      segA.pass = false;
      segA.failures.push(String(error?.message ?? error));
      fail(String(error?.message ?? error), "adapter");
    }

    /* ====================================================================== */
    /* SEGMENT B — the 14-ply replay                                         */
    /* ====================================================================== */

    const segB = {
      pass: true,
      failures: [],
      plies: [],
      screenshots: [],
      speaks: { suggestion: 0, premove: 0, dedupes: 0 },
      spotChecks: [],
      arrows: { suggestion: [], premove: [] },
      commentary: {},
      timings: { mutationToRenderMs: [] },
    };
    summary.segments.replay = segB;
    try {
      for (let ply = 1; ply <= ACCEPTANCE_GAME.plies.length; ply += 1) {
        const definition = ACCEPTANCE_GAME.plies[ply - 1];
        const sans = ACCEPTANCE_GAME.plies.slice(0, ply).map((entry) => entry.san);
        const uciPrefix = ACCEPTANCE_UCI.slice(0, ply);
        const ourTurn = ply % 2 === 0;
        const record = { ply, san: definition.san, ourTurn, checks: {} };
        segB.plies.push(record);

        await evaluateInPage(page.session, `globalThis.__humanplayAcceptance.applyPly(${JSON.stringify(definition)}, ${JSON.stringify(sans)})`);
        const mutationAt = Date.now();

        if (ourTurn) {
          const key = analyzeKey(uciPrefix);
          const panel = await waitFor(`the suggestion for ply ${ply}`, async () => {
            const current = await readPanel();
            return current.debug.lastRenderKey === key && current.debug.status !== "analyzing" ? current : null;
          }, { timeoutMs: args.timeoutMs, intervalMs: 40 });
          record.timingsMs = Date.now() - mutationAt;
          segB.timings.mutationToRenderMs.push(record.timingsMs);

          if (panel.mx.rows.length !== 3) fail(`ply ${ply}: ${panel.mx.rows.length} suggestion rows (expected 3)`, "replay");
          if (!panel.mx.rows[0]?.top) fail(`ply ${ply}: the top row is not highlighted`, "replay");

          const payload = { fen: STARTPOS_FEN, moves: uciPrefix, elo_self: 2400, elo_oppo: 2400, top_k: 3 };
          const direct = stub ? await postJson(`${SERVER_ORIGIN}/analyze`, payload) : await curlJson(`${SERVER_ORIGIN}/analyze`, payload);
          record.spotCheck = { tool: stub ? "POST /analyze (stub)" : "curl /analyze", ok: direct.ok, wallMs: direct.wallMs };
          if (!direct.ok) {
            fail(`ply ${ply}: the direct /analyze check failed (${direct.error ?? direct.status})`, "replay");
          } else {
            record.spotCheck.serverTop3 = top3(direct.body);
            record.spotCheck.panelTop3 = panel.mx.rows.map((row) => ({ uci: row.uci, prob: row.prob }));
            record.spotCheck.equal = assertTop3Equals(panel.mx.rows, direct.body, `ply ${ply} spot-check`, "replay");
            segB.spotChecks.push({ ply, equal: record.spotCheck.equal, tool: record.spotCheck.tool, top1: direct.body.moves?.[0]?.uci ?? null });
          }

          const overlay = await waitFor(`the suggestion arrow for ply ${ply}`, async () => {
            const current = await evaluateInPage(page.session, `globalThis.__humanplayAcceptance.overlayWithTruth(${JSON.stringify(BOARD_ID)})`);
            return (current.dataset?.arrows ?? []).some((arrow) => !arrow.premove) ? current : null;
          }, { timeoutMs: 10000, intervalMs: 50 });
          record.arrow = await assertArrows(page.session, BOARD_ID, overlay, record, `replay ply ${ply}`);
          if ((record.arrow.count ?? 0) === 0) fail(`ply ${ply}: no suggestion arrow drawn`, "replay");
          if (overlay.canvasCount !== 1) fail(`ply ${ply}: ${overlay.canvasCount} canvases on the page`, "replay");
          segB.arrows.suggestion.push({ ply, ...record.arrow });

          const tts = await waitFor(`the suggestion speak for ply ${ply}`, async () => {
            const current = await readTts();
            const matching = current.calls.filter((call) => call.kind === "speak" && call.reason === "suggestion" && call.key === key);
            return matching.length >= 1 ? current : null;
          }, { timeoutMs: 10000, intervalMs: 60 });
          const speak = tts.calls.filter((call) => call.reason === "suggestion" && call.key === key).at(-1);
          record.tts = { key, text: speak?.text ?? null, engine: speak?.engine ?? tts.engine };
          segB.speaks.suggestion += 1;

          // Dedupe: a Refresh-state re-render of the SAME key must not speak again.
          if (ply === 2 || ply === 14) {
            const before = await readPanel();
            const speakCountBefore = (await readTts()).speakCount;
            await refreshPanelState();
            const after = await waitFor(`the Refresh-state re-render (ply ${ply})`, async () => {
              const current = await readPanel();
              return current.debug.renderCount > before.debug.renderCount ? current : null;
            }, { timeoutMs: 15000, intervalMs: 60 });
            await sleep(400);
            const speakCountAfter = (await readTts()).speakCount;
            const decisions = await evaluateInPanel("globalThis.__humanplayAnalysis.tts.decisions.slice(-8)");
            record.dedupe = {
              speakCountBefore,
              speakCountAfter,
              lastDecision: after.debug.ttsDecision?.reason ?? null,
              duplicateDecision: decisions.some((decision) => decision.reason === "duplicate" && decision.key === key),
            };
            if (speakCountAfter !== speakCountBefore) fail(`ply ${ply}: the Refresh-state re-emit spoke again (${speakCountBefore} -> ${speakCountAfter})`, "replay");
            if (!record.dedupe.duplicateDecision) fail(`ply ${ply}: no "duplicate" decision recorded after the re-emit`, "replay");
            segB.speaks.dedupes += 1;
          }
        } else {
          const key = premoveKey(uciPrefix);
          const panel = await waitFor(`the premove plan for ply ${ply}`, async () => {
            const current = await readPanel();
            const plan = current.premove.lastPlan;
            return plan?.key === key && (current.premove.status === "ready" || current.premove.status === "no-safe-premove") ? current : null;
          }, { timeoutMs: args.timeoutMs, intervalMs: 40 });
          record.timingsMs = Date.now() - mutationAt;
          segB.timings.mutationToRenderMs.push(record.timingsMs);

          const plan = panel.premove.lastPlan;
          const recommended = plan.recommended;
          record.premove = {
            status: plan.status,
            recommended: recommended ? { san: recommended.san, uci: recommended.uci, criterion: recommended.criterion, safety: recommended.safety } : null,
            reason: plan.reason ?? null,
            cardCriterion: panel.pm.criterion,
            cardSafety: panel.pm.safety,
            opponent: panel.pm.oppo,
          };
          if (!recommended) {
            record.checks.honestNull = true;
            if (!plan.reason) fail(`ply ${ply}: the no-safe state carries no reason`, "replay");
            if (!String(panel.pm.message ?? "").includes("no safe premove")) fail(`ply ${ply}: the card does not say "no safe premove"`, "replay");
            const overlayNull = await evaluateInPage(page.session, "globalThis.__humanplayAcceptance.overlay()");
            if ((overlayNull.dataset?.arrows ?? []).some((arrow) => arrow.premove)) fail(`ply ${ply}: a premove arrow is drawn for a null plan`, "replay");
          } else {
            if (panel.pm.san !== recommended.san) fail(`ply ${ply}: the card shows ${panel.pm.san}, the plan says ${recommended.san}`, "replay");
            if (recommended.criterion === "forced" && panel.pm.criterion !== "forced") fail(`ply ${ply}: criterion chip ${panel.pm.criterion} != forced`, "replay");
            if (recommended.criterion === "safe_vs_all" && panel.pm.criterion !== "safe vs all replies") fail(`ply ${ply}: criterion chip ${panel.pm.criterion} != "safe vs all replies"`, "replay");
            const safety = Number(String(panel.pm.safety ?? "").replace("%", ""));
            if (!Number.isFinite(safety) || Math.abs(safety - recommended.safety * 100) > 0.2) fail(`ply ${ply}: safety ${panel.pm.safety} != ${(recommended.safety * 100).toFixed(1)}%`, "replay");
            if (!String(panel.pm.caveat ?? "").includes("premove still fires whenever it is legal")) fail(`ply ${ply}: the mandated caveat is missing`, "replay");
            if (panel.pm.oppo.length === 0) fail(`ply ${ply}: the opponent list is empty`, "replay");

            const overlay = await waitFor(`the dashed premove arrow for ply ${ply}`, async () => {
              const current = await evaluateInPage(page.session, `globalThis.__humanplayAcceptance.overlayWithTruth(${JSON.stringify(BOARD_ID)})`);
              return (current.dataset?.arrows ?? []).some((arrow) => arrow.premove) ? current : null;
            }, { timeoutMs: 10000, intervalMs: 50 });
            const dashed = (overlay.dataset.arrows ?? []).filter((arrow) => arrow.premove);
            record.premove.dashedStyle = dashed[0]?.style ?? null;
            if (dashed[0]?.style !== "dashed") fail(`ply ${ply}: the premove arrow style is ${dashed[0]?.style}`, "replay");
            record.arrow = await assertArrows(page.session, BOARD_ID, overlay, record, `replay ply ${ply}`);
            segB.arrows.premove.push({ ply, ...record.arrow });

            const tts = await waitFor(`the premove speak for ply ${ply}`, async () => {
              const current = await readTts();
              const matching = current.calls.filter((call) => call.kind === "speak" && call.reason === "premove" && call.key === key);
              return matching.length >= 1 ? current : null;
            }, { timeoutMs: 10000, intervalMs: 60 });
            const speak = tts.calls.filter((call) => call.reason === "premove" && call.key === key).at(-1);
            record.tts = { key, text: speak?.text ?? null };
            if (!String(speak?.text ?? "").startsWith("premove ")) fail(`ply ${ply}: premove speech ${JSON.stringify(speak?.text)} does not start with "premove "`, "replay");
            segB.speaks.premove += 1;

            if (ply === 3) {
              const speakCountBefore = (await readTts()).speakCount;
              const before = await readPanel();
              await refreshPanelState();
              // On their turn the analyze card does not render — the premove
              // planner's planCount is the "state was processed" signal.
              await waitFor(`the premove Refresh-state re-render (ply ${ply})`, async () => {
                const current = await readPanel();
                return current.premove.planCount > before.premove.planCount ? current : null;
              }, { timeoutMs: 15000, intervalMs: 60 });
              await sleep(400);
              const speakCountAfter = (await readTts()).speakCount;
              const decisions = await evaluateInPanel("globalThis.__humanplayAnalysis.premove.decisions.slice(-8)");
              record.dedupe = {
                speakCountBefore,
                speakCountAfter,
                duplicateDecision: decisions.some((decision) => decision.reason === "duplicate" && decision.key === key),
              };
              if (speakCountAfter !== speakCountBefore) fail(`ply ${ply}: the premove re-emit spoke again`, "replay");
              if (!record.dedupe.duplicateDecision) fail(`ply ${ply}: no "duplicate" premove decision recorded after the re-emit`, "replay");
              segB.speaks.dedupes += 1;
            }
          }
        }

        const cm = await waitFor(`the commentary entry for ply ${ply}`, async () => {
          const current = await readPanel();
          return current.cm.entries.some((entry) => entry.ply === ply) ? current : null;
        }, { timeoutMs: args.timeoutMs, intervalMs: 50 });
        const entry = cm.cm.entries.find((candidate) => candidate.ply === ply);
        const expectedBy = ply % 2 === 1 ? "white" : "black";
        record.commentary = { ply, san: entry.san, by: entry.by, chip: entry.chip, playerLabel: entry.playerLabel, text: entry.text };
        if (entry.san !== definition.san) fail(`ply ${ply}: the commentary shows ${entry.san}, expected ${definition.san}`, "replay");
        if (entry.by !== expectedBy) fail(`ply ${ply}: the commentary says by=${entry.by}, expected ${expectedBy}`, "replay");
        if (entry.playerLabel !== (expectedBy === "white" ? "you" : "opponent")) fail(`ply ${ply}: player label ${entry.playerLabel}`, "replay");
        if (!["main line", "common", "uncommon", "rare"].includes(entry.chip)) fail(`ply ${ply}: classification chip ${entry.chip}`, "replay");
        if (cm.cm.entries[0]?.ply !== ply) fail(`ply ${ply}: the feed is not newest-first (top is ply ${cm.cm.entries[0]?.ply})`, "replay");
      }

      const finalFen = (await readPanel()).cc.fen;
      segB.finalFen = finalFen;
      if (finalFen !== ACCEPTANCE_GAME.finalFen) fail(`the adapter's final FEN ${finalFen} != ${ACCEPTANCE_GAME.finalFen}`, "replay");

      const finalPanel = await readPanel();
      segB.commentary.feedSize = finalPanel.caches.feed;
      segB.commentary.feedStats = finalPanel.caches.feedStats;
      segB.commentary.order = finalPanel.cm.entries.map((entry) => entry.ply);
      const expectedOrder = [...Array(ACCEPTANCE_UCI.length)].map((_, index) => ACCEPTANCE_UCI.length - index);
      if (JSON.stringify(segB.commentary.order) !== JSON.stringify(expectedOrder)) {
        fail(`the feed order is ${segB.commentary.order.join(",")}, expected ${expectedOrder.join(",")}`, "replay");
      }
      if (finalPanel.caches.analyzeStats.staleDiscards !== 0) fail(`${finalPanel.caches.analyzeStats.staleDiscards} stale discards during the replay`, "replay");

      const finalOverlay = await evaluateInPage(page.session, "globalThis.__humanplayAcceptance.overlay()");
      segB.screenshots.push(await pageScreenshot(page.session, "02-replay-final-board.png"));
      segB.screenshots.push(await panelScreenshot("02-replay-panel.png"));
      segB.finalArrow = { uci: (finalOverlay.dataset?.arrows ?? []).find((arrow) => !arrow.premove)?.uci ?? null, state: finalOverlay.dataset?.state ?? null, canvasCount: finalOverlay.canvasCount };

      if (stub) {
        const stats = await serverStats();
        segB.requests = {
          analyze: stats.analyzeRequests,
          premove: stats.premoveRequests,
          explain: stats.explainRequests,
          cannedMisses: stats.cannedMisses,
          premoveCannedMisses: stats.premoveCannedMisses,
          explainCannedMisses: stats.explainCannedMisses,
        };
        if (stats.cannedMisses || stats.premoveCannedMisses || stats.explainCannedMisses) {
          fail(`stub canned misses: analyze ${stats.cannedMisses}, premove ${stats.premoveCannedMisses}, explain ${stats.explainCannedMisses}`, "replay");
        }
        if (stats.explainRequests !== ACCEPTANCE_UCI.length) fail(`${stats.explainRequests} /explain requests for ${ACCEPTANCE_UCI.length} plies`, "replay");
      }
      console.log(
        `PASS acceptance-replay: ${ACCEPTANCE_UCI.length} plies, ${segB.speaks.suggestion} suggestion + ${segB.speaks.premove} premove speaks ` +
          `(${segB.speaks.dedupes} re-emit dedupes), ${segB.spotChecks.filter((check) => check.equal).length}/${segB.spotChecks.length} spot-checks equal`,
      );
    } catch (error) {
      segB.pass = false;
      segB.failures.push(String(error?.message ?? error));
      fail(String(error?.message ?? error), "replay");
    }

    /* ====================================================================== */
    /* SEGMENT C — rematch resets everything                                 */
    /* ====================================================================== */

    const segC = { pass: true, failures: [] };
    summary.segments.rematch = segC;
    if (segB.plies.length < ACCEPTANCE_UCI.length) {
      segC.status = "skipped (the replay segment did not complete)";
      segC.pass = true;
    } else {
      try {
        // Sampling the transient reset renders must happen from Node: a hidden
        // panel tab has its timers coalesced to ~1/s, so a panel-side recorder
        // misses the window. This loop samples a light readout every ~25 ms.
        const sampling = { samples: [], stop: false };
        const samplerPromise = (async () => {
          while (!sampling.stop) {
            try {
              sampling.samples.push(await evaluateInPanel(`(() => {
                const d = globalThis.__humanplayAnalysis;
                return {
                  mxMessage: document.getElementById("mx-message").hidden ? null : document.getElementById("mx-message").textContent,
                  overlayClearReason: d.overlay.lastClearReason,
                  premoveClearReason: d.premove.lastClearReason,
                  overlayMessages: d.overlay.messageCount, premoveMessages: d.premove.messageCount,
                  spokenKeys: d.spokenKeyStore.size(), feed: d.commentaryFeed.size(),
                  analyzeCache: d.client.cacheSize(), premoveCache: d.premoveClient.cacheSize(), explainCache: d.explainClient.cacheSize(),
                  premovePlan: d.premove.lastPlan?.key ?? null,
                  resetCount: d.gameReset.count,
                };
              })()`));
            } catch {
              /* the panel is alive; transient evaluation errors are irrelevant here */
            }
            await sleep(25);
          }
        })();

        const before = await readPanel();
        const beforeOverlay = await evaluateInPage(page.session, "globalThis.__humanplayAcceptance.overlay()");
        segC.before = {
          arrows: (beforeOverlay.dataset?.arrows ?? []).length,
          feed: before.caches.feed,
          spokenKeys: before.caches.spokenKeys,
          analyzeCache: before.caches.analyze,
          premoveCache: before.caches.premove,
          explainCache: before.caches.explain,
          resetCount: before.reset.count,
          seq: before.reset.last?.seq ?? null,
        };
        if (segC.before.arrows === 0) fail("the pre-rematch board has no arrows (the reset would prove nothing)", "rematch");
        if (segC.before.feed !== ACCEPTANCE_UCI.length) fail(`the pre-rematch feed holds ${segC.before.feed} entries`, "rematch");
        if (segC.before.spokenKeys === 0) fail("no spoken keys before the rematch", "rematch");

        // A real rematch on the page: board back to the start, move list emptied.
        await evaluateInPage(page.session, "globalThis.__humanplayAcceptance.resetToStartpos()");

        const after = await waitFor("the new-game reset to reach every layer", async () => {
          const current = await readPanel();
          if (!current.reset.last) return null;
          if (current.reset.count <= segC.before.resetCount) return null;
          return current;
        }, { timeoutMs: 20000, intervalMs: 50 });
        segC.resetRecord = after.reset.last;
        segC.after = {
          seq: after.reset.last.seq,
          cleared: after.reset.last.cleared,
          sessionResets: after.caches.analyzeStats.sessionResets,
          // The fresh game re-analyzes the start position; that is correct.
          live: { mx: after.mx.status, analyzeCache: after.caches.analyze, premoveStatus: after.premove.status },
        };
        await sleep(600); // let the fresh-game render land in the samples
        sampling.stop = true;
        await samplerPromise;

        // The transient evidence, from the samples. Note: the reset renders
        // synchronously and the fresh analysis replaces the card message in the
        // same event-loop turn, so the assertions use the FIRST post-reset
        // sample (all counters at zero, clears sent) rather than a message that
        // is never observably painted.
        const samples = sampling.samples;
        const resetIndex = samples.findIndex((sample) => sample.resetCount > segC.before.resetCount);
        const beforeSample = resetIndex > 0 ? samples[resetIndex - 1] : null;
        segC.transient = {
          sampleCount: samples.length,
          resetIndex,
          firstAfterReset: resetIndex >= 0 ? samples[resetIndex] : null,
          overlayMessagesBefore: beforeSample?.overlayMessages ?? null,
          premoveMessagesBefore: beforeSample?.premoveMessages ?? null,
          messagesAfter: samples[resetIndex] ? { overlay: samples[resetIndex].overlayMessages, premove: samples[resetIndex].premoveMessages } : null,
        };

        if (after.reset.last.seq === segC.before.seq) fail(`the session sequence did not change (${after.reset.last.seq})`, "rematch");
        // The reset RECORD is the deterministic evidence: it must equal what the
        // layers held immediately before the rematch (the fresh game starts
        // re-populating right after, which is correct and therefore racy to
        // observe).
        const cleared = after.reset.last.cleared;
        if (cleared.spokenKeys !== segC.before.spokenKeys) fail(`the reset cleared ${cleared.spokenKeys} spoken keys, the replay had ${segC.before.spokenKeys}`, "rematch");
        if (cleared.analyzeCache !== segC.before.analyzeCache) fail(`the reset cleared ${cleared.analyzeCache} analyze cache entries, the replay had ${segC.before.analyzeCache}`, "rematch");
        if (cleared.premoveCache !== segC.before.premoveCache) fail(`the reset cleared ${cleared.premoveCache} premove cache entries, the replay had ${segC.before.premoveCache}`, "rematch");
        if (cleared.explainCache !== segC.before.explainCache) fail(`the reset cleared ${cleared.explainCache} explain cache entries, the replay had ${segC.before.explainCache}`, "rematch");
        if (cleared.premovePlan !== 1) fail("the reset did not record the cleared premove plan", "rematch");
        if (after.caches.analyzeStats.sessionResets < 1) fail("no session reset was counted by the analyze client", "rematch");
        if (segC.transient.firstAfterReset) {
          const first = segC.transient.firstAfterReset;
          if (first.feed !== 0) fail(`the commentary feed held ${first.feed} entries right after the reset`, "rematch");
          if (first.premovePlan !== null) fail("the premove plan survived the reset", "rematch");
          if (segC.transient.messagesAfter && segC.transient.overlayMessagesBefore !== null) {
            if (!(segC.transient.messagesAfter.overlay > segC.transient.overlayMessagesBefore)) fail("the panel sent no overlay message for the reset", "rematch");
            if (!(segC.transient.messagesAfter.premove > segC.transient.premoveMessagesBefore)) fail("the panel sent no premove message for the reset", "rematch");
          }
        } else {
          fail("the sampler never observed the post-reset sample", "rematch");
        }

        // The new game is live: one move re-populates every layer.
        await evaluateInPage(page.session, `globalThis.__humanplayAcceptance.applyPly(${JSON.stringify(ACCEPTANCE_GAME.plies[0])}, ${JSON.stringify(["e4"])})`);
        const live = await waitFor("the fresh game's first ply to be planned + explained", async () => {
          const current = await readPanel();
          return current.premove.lastPlan?.key === premoveKey(["e2e4"]) && current.cm.entries.some((entry) => entry.ply === 1) ? current : null;
        }, { timeoutMs: 20000, intervalMs: 60 });
        segC.live = { premovePlan: "ready", commentaryEntry: live.cm.entries.find((entry) => entry.ply === 1)?.san ?? null };
        const overlay = await evaluateInPage(page.session, "globalThis.__humanplayAcceptance.overlay()");
        segC.screenshot = await panelScreenshot("03-rematch-reset.png");
        console.log(
          `PASS acceptance-rematch: session ${segC.after.seq}, cleared ${JSON.stringify(segC.after.cleared)}, ` +
            `fresh game live (premove + commentary for the new ply)`,
        );
      } catch (error) {
        segC.pass = false;
        segC.failures.push(String(error?.message ?? error));
        fail(String(error?.message ?? error), "rematch");
      }
    }

    /* ====================================================================== */
    /* SEGMENT F — offline UX: 503 retry, offline wording, auto-recovery      */
    /* ====================================================================== */

    const segF = { pass: true, failures: [], status: stub ? "run" : "skipped (needs the stub /debug routes)" };
    summary.segments.offlineUx = segF;
    if (stub) {
      try {
        /* F1 — HTTP 503 -> exactly one retry (server-side arrivals = 2 / request). */
        // Board state on entry: ["e2e4"] (their turn). Play e5 so OUR turn
        // forces an /analyze request against the 503, and the ply's /explain.
        await setServerMode("engine_unavailable");
        const statsBefore503 = await serverStats();
        await evaluateInPage(page.session, `globalThis.__humanplayAcceptance.applyPly(${JSON.stringify(ACCEPTANCE_GAME.plies[1])}, ${JSON.stringify(["e4", "e5"])})`);
        const suggestionError = await waitFor("the suggestion card to show the 503 error", async () => {
          const current = await readPanel();
          return current.mx.status === "engine unavailable" ? current : null;
        }, { timeoutMs: 20000, intervalMs: 60 });
        const statsAfter503 = await serverStats();
        segF.retry503 = {
          analyzeAttempts: statsAfter503.analyzeAttempts - statsBefore503.analyzeAttempts,
          premoveAttempts: statsAfter503.premoveAttempts - statsBefore503.premoveAttempts,
          explainAttempts: statsAfter503.explainAttempts - statsBefore503.explainAttempts,
          message: suggestionError.mx.message,
        };
        // One state -> one /analyze request -> two HTTP arrivals (the retry),
        // and one /explain request -> two arrivals as well.
        if (segF.retry503.analyzeAttempts !== 2) fail(`the 503 retry made ${segF.retry503.analyzeAttempts} analyze arrivals (expected exactly 2)`, "offline");
        if (segF.retry503.explainAttempts !== 2) fail(`the 503 retry made ${segF.retry503.explainAttempts} explain arrivals (expected exactly 2)`, "offline");
        await setServerMode("ok");
        // The next position proves the pipeline recovers without any special step.
        await evaluateInPage(page.session, `globalThis.__humanplayAcceptance.applyPly(${JSON.stringify(ACCEPTANCE_GAME.plies[2])}, ${JSON.stringify(["e4", "e5", "Nf3"])})`);
        await waitFor("the premove plan after the 503 episode", async () => {
          const current = await readPanel();
          return current.premove.lastPlan?.key === premoveKey(["e2e4", "e7e5", "g1f3"]) ? current : null;
        }, { timeoutMs: 20000, intervalMs: 60 });

        /* F2 — offline wording + Copy start command + auto-recovery. */
        // Their turn on entry: play Nc6 (black) so OUR turn fails /analyze,
        // then Bc4 (ours) so THEIR turn fails /premove.
        await setServerMode("offline");
        await evaluateInPage(page.session, `globalThis.__humanplayAcceptance.applyPly(${JSON.stringify(ACCEPTANCE_GAME.plies[3])}, ${JSON.stringify(["e4", "e5", "Nf3", "Nc6"])})`);
        const suggestionOffline = await waitFor("the suggestion card to show the offline state", async () => {
          const current = await readPanel();
          return current.mx.status === "server offline" ? current : null;
        }, { timeoutMs: 25000, intervalMs: 80 });
        await evaluateInPage(page.session, `globalThis.__humanplayAcceptance.applyPly(${JSON.stringify(ACCEPTANCE_GAME.plies[4])}, ${JSON.stringify(["e4", "e5", "Nf3", "Nc6", "Bc4"])})`);
        const premoveOffline = await waitFor("the premove card to show the offline state", async () => {
          const current = await readPanel();
          return current.premove.status === "error:offline" ? current : null;
        }, { timeoutMs: 25000, intervalMs: 80 });
        const commentaryOffline = await waitFor("the commentary card to show the offline state", async () => {
          const current = await readPanel();
          return String(current.cm.message ?? "").includes("needs the local Maia-3 server") ? current : null;
        }, { timeoutMs: 15000, intervalMs: 80 });
        segF.offline = {
          suggestion: { status: suggestionOffline.mx.status, message: suggestionOffline.mx.message },
          premove: { status: premoveOffline.premove.status, message: premoveOffline.pm.message },
          commentary: { status: commentaryOffline.cm.status, message: commentaryOffline.cm.message },
          recoveryActive: commentaryOffline.recovery.active,
        };
        if (!String(suggestionOffline.mx.message ?? "").includes("Copy start command")) fail("the suggestion offline message does not point at the Copy button", "offline");
        if (!String(premoveOffline.pm.message ?? "").includes("Copy start command")) fail("the premove offline message does not point at the Copy button", "offline");
        if (!String(commentaryOffline.cm.message ?? "").includes("Copy start command")) fail("the commentary offline message does not point at the Copy button", "offline");
        if (!String(premoveOffline.pm.message ?? "").includes("uvicorn")) fail("the premove offline message does not carry the start command", "offline");

        // The Copy start command button.
        await activate(panelTarget.targetId);
        const copied = await evaluateInPanel(`document.getElementById("copy-start-command").click(); true`, { userGesture: true });
        const clipboard = await waitFor("the clipboard record", async () => {
          const current = await readPanel();
          return current.clipboard.count >= 1 ? current : null;
        }, { timeoutMs: 5000, intervalMs: 50 });
        segF.clipboard = { clicked: copied === true, record: clipboard.clipboard, buttonText: clipboard.server.copyButton, copiedLine: clipboard.server.copied };
        if (clipboard.clipboard.last?.ok !== true) fail(`the copy button failed: ${JSON.stringify(clipboard.clipboard.last)}`, "offline");
        if (!String(clipboard.clipboard.last?.command ?? "").includes("uvicorn")) fail("the copied command is not the uvicorn start command", "offline");
        segF.screenshot = await panelScreenshot("04-offline-cards.png");

        // The server returns -> the recovery poll re-runs the policies. The
        // premove plan for the current (their-turn) position is the fresh
        // request proving the recovery ran end to end.
        segF.recoveryBeforeOk = (await readPanel()).recovery;
        await setServerMode("ok");
        let recovered = null;
        try {
          recovered = await waitFor("auto-recovery after the server returned", async () => {
            const current = await readPanel();
            return current.recovery.recoveredAt && current.premove.lastPlan?.key === premoveKey(["e2e4", "e7e5", "g1f3", "b8c6", "f1c4"]) ? current : null;
          }, { timeoutMs: 30000, intervalMs: 200 });
        } catch (error) {
          const diagnostic = await readPanel();
          segF.recoveryDiagnostics = {
            recovery: diagnostic.recovery,
            premove: { status: diagnostic.premove.status, key: diagnostic.premove.lastPlan?.key ?? null, message: diagnostic.pm.message },
            health: diagnostic.health,
            chip: diagnostic.server.chip,
          };
          throw error;
        }
        segF.recovery = {
          active: recovered.recovery.active,
          attempts: recovered.recovery.attempts,
          recoveredAt: recovered.recovery.recoveredAt,
          lastCheck: recovered.recovery.lastCheck,
          premoveStatus: recovered.premove.status,
          premoveKey: recovered.premove.lastPlan?.key ?? null,
        };
        if (recovered.recovery.active !== false) fail("the recovery poll did not stop after it succeeded", "offline");
        if (recovered.recovery.attempts < 1) fail("the recovery poll never checked /health", "offline");
        if (recovered.premove.status !== "ready" && recovered.premove.status !== "no-safe-premove") fail(`the premove card did not recover (${recovered.premove.status})`, "offline");
        if (!String(recovered.server.chip ?? "").includes("online")) fail(`the server chip says ${recovered.server.chip}`, "offline");
        segF.screenshotRecovered = await panelScreenshot("04-recovered.png");
        console.log(
          `PASS acceptance-offline: 503 retried once (analyze arrivals ${segF.retry503.analyzeAttempts}, explain ${segF.retry503.explainAttempts}), ` +
            `every card offline-actionable, copied the command, recovered after ${recovered.recovery.attempts} health check(s)`,
        );
      } catch (error) {
        segF.pass = false;
        segF.failures.push(String(error?.message ?? error));
        fail(String(error?.message ?? error), "offline");
      } finally {
        // Never leave the stub in a fault mode — the soak depends on it.
        await setServerMode("ok").catch(() => {});
      }
    }

    /* ====================================================================== */
    /* SEGMENT D — the soak (>= 100 plies)                                   */
    /* ====================================================================== */

    const segD = { pass: true, failures: [], plies: args.soakPlies, canvasChecks: [] };
    summary.segments.soak = segD;
    try {
      // Back to a clean start position for the soak (the offline segment left
      // two plies on the board).
      await evaluateInPage(page.session, "globalThis.__humanplayAcceptance.resetToStartpos()");
      await waitFor("the soak's fresh session", async () => {
        const current = await readPanel();
        return current.debug.currentKey === analyzeKey([]) && current.caches.analyzeStats.sessionResets >= 2 ? current : null;
      }, { timeoutMs: 20000, intervalMs: 60 });
      // Let the fresh start-position analysis finish (it speaks once, before we
      // mute) so the "no speaks during the soak" assertion starts from a clean
      // counter.
      await waitFor("the fresh analysis to settle", async () => {
        const tick = await readTick();
        return tick.renderKey === analyzeKey([]) && tick.status !== "analyzing" ? tick : null;
      }, { timeoutMs: 15000, intervalMs: 40 });
      await sleep(600);

      // The soak runs SILENT: 100+ utterances of synthetic knight shuffles
      // would flood the speech backend (and the room). TTS is switched off
      // through the real checkbox; the speak policy still runs on every ply
      // (decision "tts-off"), and the dedupe store must stay bounded.
      await evaluateInPanel(`(() => { const box = document.getElementById("tts-enabled"); if (box.checked) box.click(); return true; })()`);
      await waitFor("TTS to be off for the soak", async () => (await readPanel()).debug.ttsEnabled === false, { timeoutMs: 10000 });
      const speakCountBeforeSoak = (await readTts()).speakCount;
      const commentaryErrorsBeforeSoak = (await readPanel()).commentary.errors;

      segD.startedAt = Date.now();
      for (let index = 0; index < args.soakPlies; index += 1) {
        const ply = index + 1;
        const definition = { san: soakSan(index), pieces: soakPieces(index) };
        await evaluateInPage(page.session, `globalThis.__humanplayAcceptance.applyPly(${JSON.stringify(definition)}, ${JSON.stringify(soakPrefixSan(ply))})`);
        const uciPrefix = soakPrefixUci(ply);
        const ourTurn = ply % 2 === 0; // after their move it is white (the user) to move
        if (ourTurn) {
          const key = analyzeKey(uciPrefix);
          await waitFor(`soak ply ${ply} (suggestion)`, async () => {
            const tick = await readTick(ply);
            return tick.renderKey === key && tick.status !== "analyzing" ? tick : null;
          }, { timeoutMs: 20000, intervalMs: 30 });
        } else {
          const key = premoveKey(uciPrefix);
          await waitFor(`soak ply ${ply} (premove plan)`, async () => {
            const tick = await readTick(ply);
            return (tick.pmKey === key && (tick.pmStatus === "ready" || tick.pmStatus === "no-safe-premove")) ? tick : null;
          }, { timeoutMs: 20000, intervalMs: 30 });
        }
        await waitFor(`soak ply ${ply} (commentary)`, async () => {
          const tick = await readTick(ply);
          return tick.hasPly ? tick : null;
        }, { timeoutMs: 20000, intervalMs: 30 });
        if (ply % 10 === 0 || ply === args.soakPlies) {
          const overlay = await evaluateInPage(page.session, "globalThis.__humanplayAcceptance.overlay()");
          segD.canvasChecks.push({ ply, canvasCount: overlay.canvasCount });
          if (overlay.canvasCount !== 1) fail(`soak ply ${ply}: ${overlay.canvasCount} canvases on the page`, "soak");
        }
      }
      // The per-ply wait above is satisfied when the article is *requested*; the
      // last entry must land in the feed before the cap assertions are read.
      await waitFor("the final soak entry to land in the feed", async () => {
        const current = await readPanel();
        return current.cm.entries[0]?.ply === args.soakPlies ? current : null;
      }, { timeoutMs: 20000, intervalMs: 60 });
      segD.endedAt = Date.now();
      segD.durationMs = segD.endedAt - segD.startedAt;

      const panel = await readPanel();
      const overlay = await evaluateInPage(page.session, "globalThis.__humanplayAcceptance.overlay()");
      segD.feed = {
        size: panel.caches.feed,
        domCount: panel.cm.feedCount,
        newestPly: panel.cm.entries[0]?.ply ?? null,
        oldestPly: panel.cm.entries.at(-1)?.ply ?? null,
        capEvictions: panel.caches.feedStats.capEvictions,
        feedMeta: panel.cm.meta,
      };
      segD.caches = {
        analyze: panel.caches.analyze,
        premove: panel.caches.premove,
        explain: panel.caches.explain,
        spokenKeys: panel.caches.spokenKeys,
        analyzeStats: panel.caches.analyzeStats,
      };
      segD.canvasFinal = { count: overlay.canvasCount, exists: overlay.canvasExists };
      segD.commentaryErrors = { before: commentaryErrorsBeforeSoak, after: panel.commentary.errors, delta: panel.commentary.errors - commentaryErrorsBeforeSoak };
      segD.speaks = { before: speakCountBeforeSoak, after: (await readTts()).speakCount };
      segD.speaks.delta = segD.speaks.after - segD.speaks.before;
      segD.screenshot = await panelScreenshot("05-soak-feed-capped.png");
      segD.boardScreenshot = await pageScreenshot(page.session, "05-soak-board.png");

      if (segD.feed.size !== FEED_CAP) fail(`the feed holds ${segD.feed.size} entries after ${args.soakPlies} plies (expected ${FEED_CAP})`, "soak");
      if (segD.feed.domCount !== FEED_CAP) fail(`the panel DOM shows ${segD.feed.domCount} feed entries (expected ${FEED_CAP})`, "soak");
      if (segD.feed.newestPly !== args.soakPlies) fail(`the newest feed entry is ply ${segD.feed.newestPly} (expected ${args.soakPlies})`, "soak");
      if (segD.feed.oldestPly !== args.soakPlies - FEED_CAP + 1) fail(`the oldest kept entry is ply ${segD.feed.oldestPly} (expected ${args.soakPlies - FEED_CAP + 1})`, "soak");
      if (segD.feed.capEvictions !== args.soakPlies - FEED_CAP) fail(`capEvictions ${segD.feed.capEvictions} != ${args.soakPlies - FEED_CAP}`, "soak");
      if (segD.caches.analyze > CACHE_LRU) fail(`the analyze cache grew to ${segD.caches.analyze} (LRU ${CACHE_LRU})`, "soak");
      if (segD.caches.premove > CACHE_LRU) fail(`the premove cache grew to ${segD.caches.premove} (LRU ${CACHE_LRU})`, "soak");
      if (segD.caches.explain > CACHE_LRU) fail(`the explain cache grew to ${segD.caches.explain} (LRU ${CACHE_LRU})`, "soak");
      if (segD.caches.spokenKeys > SPOKEN_KEYS_CAP) fail(`the spoken-key store grew to ${segD.caches.spokenKeys} (cap ${SPOKEN_KEYS_CAP})`, "soak");
      if (segD.canvasFinal.count !== 1) fail(`the page holds ${segD.canvasFinal.count} canvases after the soak`, "soak");
      if (segD.commentaryErrors.delta > 0) fail(`${segD.commentaryErrors.delta} commentary errors during the soak`, "soak");
      if (segD.speaks.delta !== 0) fail(`${segD.speaks.delta} TTS speaks during the silent soak`, "soak");
      if (stub) {
        const stats = await serverStats();
        segD.requests = {
          analyze: stats.analyzeRequests,
          premove: stats.premoveRequests,
          explain: stats.explainRequests,
          cannedMisses: stats.cannedMisses + stats.premoveCannedMisses + stats.explainCannedMisses,
        };
        if (segD.requests.cannedMisses > 0) fail(`soak canned misses: ${segD.requests.cannedMisses}`, "soak");
      }
      console.log(
        `PASS acceptance-soak: ${args.soakPlies} plies in ${(segD.durationMs / 1000).toFixed(1)} s — feed ${segD.feed.size}/${FEED_CAP}, ` +
          `caches ${segD.caches.analyze}/${segD.caches.premove}/${segD.caches.explain}, spoken keys ${segD.caches.spokenKeys}, ${segD.canvasFinal.count} canvas`,
      );
    } catch (error) {
      segD.pass = false;
      segD.failures.push(String(error?.message ?? error));
      fail(String(error?.message ?? error), "soak");
    }

    /* ====================================================================== */
    /* SEGMENT E — best-effort real chess.com page                           */
    /* ====================================================================== */

    const segE = { pass: true, status: "not-run", failures: [], attempts: [], url: args.realPage };
    summary.segments.realPage = segE;
    if (args.realPage) {
      // Collect every GameState broadcast in the panel once; the real-page
      // segments filter this list by sender URL (the SW's lastState belongs to
      // whichever tab reported latest — the fixture page during the soak).
      await evaluateInPanel(`(() => {
        if (!globalThis.__acceptanceStates) {
          globalThis.__acceptanceStates = [];
          chrome.runtime.onMessage.addListener((message, sender) => {
            if (message?.type !== "humanplay:chesscom-state") return undefined;
            globalThis.__acceptanceStates.push({
              fen: message.state?.fen ?? null,
              ok: Boolean(message.state?.ok),
              boardId: message.state?.boardId ?? null,
              tabId: sender?.tab?.id ?? null,
              url: String(sender?.tab?.url ?? ""),
            });
            return undefined;
          });
        }
        return true;
      })()`);
      for (let attempt = 1; attempt <= 2; attempt += 1) {
        const attemptRecord = { attempt, ok: false, error: null, state: null };
        segE.attempts.push(attemptRecord);
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
          await evaluateInPage(realSession, PAGE_HELPERS);
          await evaluateInPage(realSession, `globalThis.THE_SQUARES = ["e2","e4"]; true`);

          // Collect the real page's GameState broadcasts in the panel (the
          // service worker's lastState belongs to whichever tab was latest — the
          // fixture page during the soak — so filter by sender URL here). Only
          // states collected AFTER this attempt started count (retries).
          const collectorLength = await evaluateInPanel("(globalThis.__acceptanceStates ??= []).length");
          const realState = await waitFor("a real chess.com GameState", async () => {
            const state = await evaluateInPanel(
              `globalThis.__acceptanceStates.slice(${collectorLength}).filter((entry) => entry.url.includes('chess.com') && entry.ok && entry.fen).slice(-1)[0] ?? null`,
            );
            return state?.tabId ? state : null;
          }, { timeoutMs: 45000, intervalMs: 250 });
          attemptRecord.state = { fen: realState.fen, url: realState.url };
          await sleep(500);

          const boardId = await evaluateInPage(realSession, `(() => {
            const candidates = [document.getElementById("board-single"), ...document.querySelectorAll("wc-chess-board, chess-board, #board-single, .board")];
            const board = candidates.filter(Boolean).sort((a, b) => b.getBoundingClientRect().width - a.getBoundingClientRect().width)[0];
            if (!board) return null;
            if (!board.id) board.setAttribute("id", "humanplay-acceptance-board");
            return board.id;
          })()`);
          if (!boardId) throw new Error("no board element on the real page");
          const forward = await evaluateInWorker(
            `chrome.tabs.sendMessage(${realState.tabId}, ${JSON.stringify({
              type: "humanplay:suggestion",
              moves: [{ uci: "e2e4", san: "e4", prob: 0.464864 }],
              topN: 1,
              key: "acceptance-real-page-e2e4",
            })}).then((response) => ({ ok: true, response }), (error) => ({ ok: false, error: String(error?.message ?? error) }))`,
          );
          attemptRecord.routed = forward;
          const overlay = await waitFor("the routed arrow on the real page", async () => {
            const current = await evaluateInPage(realSession, `(() => {
              if (!globalThis.__humanplayAcceptance || !globalThis.THE_SQUARES) return { helpersMissing: true };
              return globalThis.__humanplayAcceptance.overlayWithTruth(${JSON.stringify(boardId)});
            })()`).catch(() => null);
            if (!current || current.helpersMissing) {
              // A chess.com SPA navigation wipes the injected main-world helper —
              // re-install it (idempotent) and try again on the next poll.
              await evaluateInPage(realSession, PAGE_HELPERS).catch(() => {});
              await evaluateInPage(realSession, `globalThis.THE_SQUARES = ["e2","e4"]; true`).catch(() => {});
              return null;
            }
            return (current.dataset?.arrows ?? []).some((arrow) => arrow.uci === "e2e4") ? current : null;
          }, { timeoutMs: 20000, intervalMs: 200 });
          attemptRecord.ok = true;
          segE.status = "passed";
          segE.dataset = { key: overlay.dataset.key, flipped: overlay.dataset.flipped, canvasCount: overlay.canvasCount };
          segE.geometry = await assertArrows(realSession, boardId, overlay, null, "real-page");
          segE.screenshot = await pageScreenshot(realSession, "06-real-chesscom-arrow.png");
          console.log(`PASS acceptance-real-page: routed e2e4 arrow on a real chess.com page, endpoints ≤ ${(segE.geometry.maxEndpointErrorPx ?? 0).toFixed(2)} px`);
          break;
        } catch (error) {
          attemptRecord.error = String(error?.message ?? error);
          if (attempt === 2 || !/timeout|ERR_|navigat|net::/i.test(attemptRecord.error)) {
            segE.status = "blocked";
            segE.note = "best-effort segment: the real chess.com page could not be loaded/asserted in this environment — see attempts";
            console.error(`SKIP acceptance-real-page (blocked): ${attemptRecord.error}`);
          }
        } finally {
          if (realTarget) await closeTarget(realTarget.targetId);
        }
      }
      if (segE.status === "blocked") summary.checks.realPageBlocked = true;
    }

    /* --------------------------------------------------------------- console */

    await sleep(500);
    summary.console = {
      panel: logs.panel.slice(-400),
      serviceWorker: logs.serviceWorker.slice(-400),
      pages: logs.pages.slice(-400),
      panelErrors: logs.panel.filter((entry) => entry.bucket === "error" && entry.source !== "network"),
      serviceWorkerErrors: logs.serviceWorker.filter((entry) => entry.bucket === "error"),
      pageErrors: logs.pages.filter((entry) => entry.bucket === "error" && entry.source !== "network"),
    };
    for (const entry of summary.console.panelErrors) fail(`panel console error: ${entry.text.slice(0, 300)}`, "console");
    for (const entry of summary.console.serviceWorkerErrors) fail(`service worker console error: ${entry.text.slice(0, 300)}`, "console");
    for (const entry of summary.console.pageErrors) fail(`fixture page console error: ${entry.text.slice(0, 300)}`, "console");
  } catch (error) {
    fail(`fatal: ${error?.stack ?? error}`);
  } finally {
    summary.segmentsSummary = Object.fromEntries(
      Object.entries(summary.segments)
        .filter(([, value]) => value && typeof value === "object" && "pass" in value)
        .map(([key, value]) => [key, { pass: value.pass, status: value.status ?? (value.pass ? "passed" : "failed") }]),
    );
    summary.pass = summary.failures.length === 0;
    if (staticServer) staticServer.close();
    if (fixtureServerProcess) fixtureServerProcess.kill("SIGTERM");
    for (const targetId of openTargets) {
      try { await cdp?.send("Target.closeTarget", { targetId }); } catch { /* ignore */ }
    }
    try { cdp?.close(); } catch { /* ignore */ }
    try { chromeProcess?.kill("SIGKILL"); } catch { /* ignore */ }
    if (args.keepProfile) {
      console.log(`kept: profile=${profileDir} variant=${variantDir}`);
    } else {
      for (const dir of [profileDir, variantDir]) {
        if (dir) await rm(dir, { recursive: true, force: true }).catch(() => {});
      }
    }
    summary.fixtureServerLogTail = fixtureServerLog.split("\n").filter(Boolean).slice(-6);

    await mkdir(args.outDir, { recursive: true });
    await writeFile(path.join(args.outDir, "acceptance-proof.json"), `${JSON.stringify(summary, null, 2)}\n`);
    console.log(`\n${summary.pass ? "ALL ACCEPTANCE CASES PASSED" : `ACCEPTANCE FAILURES: ${summary.failures.length}`}`);
    console.log(`evidence: ${path.relative(REPO_ROOT, path.join(args.outDir, "acceptance-proof.json"))}`);
  }
  process.exit(summary.pass ? 0 : 1);
}

/**
 * Deterministic synthetic canned bodies for the soak. The soak asserts
 * leak-freedom (caches / feed / canvas), not fact correctness: recording 200+
 * real articles for a throwaway knight shuffle would pin meaningless values —
 * same reasoning as commentary-proof's 52-ply cap case. Documented in
 * docs/RELEASE-NOTES.md.
 */
async function registerSyntheticSoakBodies(register, plies) {
  const startpos = STARTPOS_FEN;
  let count = 0;
  const analyzeBody = () => ({
    moves: [
      { uci: "b1c3", san: "Nc3", prob: 0.5 },
      { uci: "d2d4", san: "d4", prob: 0.3 },
      { uci: "e2e4", san: "e4", prob: 0.2 },
    ],
    wdl: { win: 0.44, draw: 0.12, loss: 0.44 },
    model: "fixture-synthetic-soak",
    elapsed_ms: 1.0,
  });
  const premoveBody = (fen) => ({
    fen,
    side_to_move: "black",
    opponent: [
      { uci: "g8f6", san: "Nf6", prob: 0.7 },
      { uci: "b8c6", san: "Nc6", prob: 0.2 },
      { uci: "e7e5", san: "e5", prob: 0.1 },
    ],
    recommended: {
      uci: "g1f3",
      san: "Nf3",
      criterion: "robust",
      safety: 0.95,
      min_response_prob: 0.7,
      detail: "synthetic soak body (deterministic; leak-freedom is the assertion)",
    },
    candidates: [
      { uci: "g1f3", san: "Nf3", safe_mass: 0.95, guard_mass: 0.0, min_response_prob: 0.7, verdict: "recommended", why: "synthetic" },
    ],
    excluded: [],
    reason: null,
    params: { elo_self: 2400, elo_oppo: 2400, top_n: 5, min_safety: 0.9, min_response_prob: 0.15, mode: "top" },
    timings_ms: { root: 1, response: 1, total: 2 },
    model: "fixture-synthetic-soak",
    elapsed_ms: 2.0,
  });
  const explainBody = (ply, uci) => ({
    move: { san: soakSan(ply - 1), uci, by: ply % 2 === 1 ? "white" : "black", ply, moveNumber: Math.ceil(ply / 2) },
    flags: { capture: false, check: false, mate: false, castle: null, promotion: null, enPassant: false, recapture: false },
    material: { delta: 0, captured: null },
    maia: {
      playedProb: 0.5,
      rank: 2,
      totalLegal: 20,
      top: [
        { uci: "a2a3", san: "a3", prob: 0.6 },
        { uci, san: soakSan(ply - 1), prob: 0.5 },
        { uci: "b2b3", san: "b3", prob: 0.1 },
      ],
      moverElo: 2400,
    },
    wdl: { before: { win: 0.44, draw: 0.12, loss: 0.44 }, after: { win: 0.44, draw: 0.12, loss: 0.44 } },
    opening: null,
    classification: "common",
    model: "fixture-synthetic-soak",
    elapsed_ms: 1.0,
  });
  for (let ply = 0; ply <= plies; ply += 1) {
    const prefix = soakPrefixUci(ply);
    if (ply % 2 === 0) {
      await register("canned", `${startpos}|${prefix.join(" ")}|2400|2400|3`, analyzeBody());
      count += 1;
    } else {
      await register("canned-premove", `${startpos}|${prefix.join(" ")}|2400|2400|5|0.9|top`, premoveBody(startpos));
      count += 1;
    }
    if (ply >= 1) {
      await register("canned-explain", `${startpos}|${prefix.join(" ")}|2400|2400`, explainBody(ply, prefix.at(-1)));
      count += 1;
    }
  }
  return count;
}

main();

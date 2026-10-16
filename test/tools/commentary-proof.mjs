#!/usr/bin/env node
/**
 * commentary-proof.mjs — objective end-to-end proof for the M8 live commentary
 * (adapter state -> /explain -> template sentence -> feed; optional LLM layer).
 *
 * Two modes, same harness (CDP against a real Chrome for Testing):
 *
 *   STUB mode (default)
 *     Spawns `test/tools/fixture_server.py` on 127.0.0.1:8765 and proves the
 *     whole panel pipeline against CANNED /explain responses **recorded from the
 *     real server** (schema-identical) + canned /llm/* provider stand-ins:
 *       S0  panel/manifest: commentary card, toggle default ON, engine select,
 *           masked key input, `optional_host_permissions`, no `<all_urls>`;
 *       S1  the 7-ply Italian Game replayed move-by-move via DOM mutations:
 *           one entry per ply for BOTH colors, newest first, exact texts +
 *           classification chips (hand-verified against the recordings), one
 *           /explain request per ply;
 *       S2  LLM mode: the canned Groq text replaces the template text in the
 *           feed (and Gemini works through its own shape); the API key never
 *           appears in the DOM/logs;
 *       S3  fallback: an LLM 500 and an LLM timeout keep the template text and
 *           note the fallback in the entry meta;
 *       S4  toggle off -> 0 /explain requests (and no retro-explaining when it
 *           goes back on);
 *       S5  new game (move list back to start) -> the feed clears, the session
 *           re-seeds and the next move is explained again;
 *       S6  the ~50-ply cap: a 52-ply knight shuffle replayed move-by-move ->
 *           the feed keeps the newest 50 entries (plies 52..3);
 *       S7  stale race: a delayed /explain superseded by the next ply is
 *           discarded — no out-of-order entry.
 *
 *   REAL mode (`--real`)
 *     Expects the REAL Maia server and replays the 14-ply fixture montage
 *     (both castlings + captures) move-by-move through the production adapter;
 *     asserts every feed entry against the hand-verified texts and that the
 *     last entry EQUALS a direct `curl /explain` phrased by the panel's own
 *     template module; records the latencies.
 *
 * Every run loads a temporary COPY of the extension whose manifest additionally
 * matches the content script (and its web-accessible modules) on the fixture
 * origin — the shipped manifest stays chess.com-only; all code files are
 * hash-compared and the report carries `codeIdentical`.
 *
 * Usage:
 *   node test/tools/commentary-proof.mjs --chrome <path> [--real|--stub]
 *     [--extension extension] [--out-dir test/fixtures/captures/commentary]
 *     [--headful] [--keep-profile] [--timeout-ms 45000]
 *
 * Exit code is non-zero when any assertion fails. Writes one proof JSON +
 * panel/board screenshots into test/fixtures/captures/commentary/.
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

import { phraseCommentary } from "../../extension/src/commentary/phrase.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const SERVER_ORIGIN = "http://127.0.0.1:8765";
const EXPLAIN_URL = `${SERVER_ORIGIN}/explain`;

const STARTPOS_FEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
const TEST_API_KEY = "test-key-not-real";

/* ------------------------------------------------- recorded ground truth */

/** The Italian Game replay (the stub case): UCI + SAN + board mutations. */
const ITALIAN7 = ["e2e4", "e7e5", "g1f3", "b8c6", "f1c4", "f8c5", "e1g1"];
const ITALIAN7_SAN = ["e4", "e5", "Nf3", "Nc6", "Bc4", "Bc5", "O-O"];
const ITALIAN_STEPS = [
  { uci: "e2e4", pieces: [{ classes: ["wp"], from: "52", to: "54" }] },
  { uci: "e7e5", pieces: [{ classes: ["bp"], from: "57", to: "55" }] },
  { uci: "g1f3", pieces: [{ classes: ["wn"], from: "71", to: "63" }] },
  { uci: "b8c6", pieces: [{ classes: ["bn"], from: "28", to: "36" }] },
  { uci: "f1c4", pieces: [{ classes: ["wb"], from: "61", to: "34" }] },
  { uci: "f8c5", pieces: [{ classes: ["bb"], from: "68", to: "35" }] },
  {
    uci: "e1g1",
    pieces: [
      { classes: ["wk"], from: "51", to: "71" },
      { classes: ["wr"], from: "81", to: "61" },
    ],
  },
];

/** The 14-ply fixture montage (the real-mode replay) — continuation of above. */
const MG14 = [
  "e2e4", "e7e5", "g1f3", "b8c6", "f1c4", "f8c5", "e1g1", "g8f6",
  "d2d3", "d7d6", "c1g5", "e8g8", "g5f6", "d8f6",
];
const MG14_SAN = [
  "e4", "e5", "Nf3", "Nc6", "Bc4", "Bc5", "O-O", "Nf6",
  "d3", "d6", "Bg5", "O-O", "Bxf6", "Qxf6",
];
const MG14_STEPS = [
  ...ITALIAN_STEPS,
  { uci: "g8f6", pieces: [{ classes: ["bn"], from: "78", to: "66" }] },
  { uci: "d2d3", pieces: [{ classes: ["wp"], from: "42", to: "43" }] },
  { uci: "d7d6", pieces: [{ classes: ["bp"], from: "47", to: "46" }] },
  { uci: "c1g5", pieces: [{ classes: ["wb"], from: "31", to: "75" }] },
  {
    uci: "e8g8",
    pieces: [
      { classes: ["bk"], from: "58", to: "78" },
      { classes: ["br"], from: "88", to: "68" },
    ],
  },
  {
    uci: "g5f6",
    remove: [{ classes: ["bn"], from: "66" }],
    pieces: [{ classes: ["wb"], from: "75", to: "66" }],
  },
  {
    uci: "d8f6",
    remove: [{ classes: ["wb"], from: "66" }],
    pieces: [{ classes: ["bq"], from: "48", to: "66" }],
  },
];

/** The knight shuffle for the map cap case (52 plies, 4 repeating steps). */
const SHUFFLE_STEPS = [
  { uci: "g1f3", san: "Nf3", pieces: [{ classes: ["wn"], from: "71", to: "63" }] },
  { uci: "g8f6", san: "Nf6", pieces: [{ classes: ["bn"], from: "78", to: "66" }] },
  { uci: "f3g1", san: "Ng1", pieces: [{ classes: ["wn"], from: "63", to: "71" }] },
  { uci: "f6g8", san: "Ng8", pieces: [{ classes: ["bn"], from: "66", to: "78" }] },
];
const CAP_PLIES = 52;
/** The shuffle plan (plies 1..54): UCI/SAN prefixes + the /explain keys. */
const SHUFFLE_PLAN = [];
{
  const uci = [];
  const sans = [];
  for (let ply = 1; ply <= CAP_PLIES + 2; ply += 1) {
    const step = SHUFFLE_STEPS[(ply - 1) % SHUFFLE_STEPS.length];
    uci.push(step.uci);
    sans.push(step.san);
    SHUFFLE_PLAN.push({ ply, step, uci: [...uci], sans: [...sans], key: `${STARTPOS_FEN}|${uci.join(" ")}|2400|2400` });
  }
}
/** Documented chip text per classification band. */
const CHIP_BY_CLASSIFICATION = { mainline: "main line", common: "common", uncommon: "uncommon", rare: "rare" };

/** Hand-verified expected texts (recorded from the real server 2026-10-17). */
const EXPECTED_TEXTS = {
  1: "e4 — the most common move at 2400 (46%).",
  2: "e5 — a common choice at 2400 (17%); Maia's pick was c5 (37%).",
  3: "Nf3 — the most common move at 2400 (78%).",
  4: "Nc6 — the most common move at 2400 (79%).",
  5: "Bc4 — a common choice at 2400 (32%); Maia's pick was Bb5 (43%).",
  6: "Bc5 — a common choice at 2400 (45%); Maia's pick was Nf6 (47%).",
  7: "O-O — castling kingside; a common choice at 2400 (22%); Maia's pick was c3 (39%).",
  8: "Nf6 — the most common move at 2400 (78%).",
  9: "d3 — the most common move at 2400 (42%).",
  10: "d6 — the most common move at 2400 (63%).",
  11: "Bg5 — uncommon at 2400 (8%); Maia's pick was c3 (49%).",
  12: "O-O — castling kingside; only 3% play this; Maia's pick was h6 (81%).",
  13: "Bxf6 — a capture on f6; only 0.2% play this; Maia's pick was Nc3 (43%).",
  14: "Qxf6 — a recapture; 99% of 2400s take back.",
};
const EXPECTED_CHIPS = {
  1: "main line", 2: "common", 3: "main line", 4: "main line", 5: "common", 6: "common", 7: "common",
  8: "main line", 9: "main line", 10: "main line", 11: "uncommon", 12: "rare", 13: "rare", 14: "main line",
};
/** The canned LLM texts (fixture_server.CANNED_LLM_TEXT). */
const CANNED_LLM_TEXT = {
  groq: "Nice — that is the main line here, and plenty of 2400s play it too.",
  gemini: "A natural move for this position: most 2400s choose it as well.",
};

/* ------------------------------------------------------------------ args */

function parseArgs(argv) {
  const args = {
    chrome: null,
    extension: path.join(REPO_ROOT, "extension"),
    outDir: path.join(REPO_ROOT, "test/fixtures/captures/commentary"),
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

/** Direct `curl /explain` — the real-mode ground-truth comparison. */
function curlExplain(payload, { timeoutMs = 30000 } = {}) {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    execFile(
      "curl",
      ["-s", "-X", "POST", EXPLAIN_URL, "-H", "Content-Type: application/json", "-d", JSON.stringify(payload)],
      { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 },
      (error, stdout, stderr) => {
        let parsed = null;
        try {
          parsed = JSON.parse(stdout);
        } catch {
          parsed = null;
        }
        resolve({
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
 * Page-side helpers (main world of every fixture page). Only what the
 * commentary replay needs: find/move pieces, replace the move list and the
 * board, and read the current piece list (the startpos snapshot for the
 * new-game reset case).
 */
const PAGE_HELPERS = String.raw`
globalThis.__humanplayProof = {
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
  readPieces(boardId) {
    const board = document.getElementById(boardId);
    return [...board.querySelectorAll(".piece")].map((el) => {
      const token = [...el.classList].find((cls) => /^square-[1-8][1-8]$/.test(cls));
      const code = [...el.classList].find((cls) => /^[wb][pnbrqk]$/.test(cls));
      return { code, square: token.slice(7) };
    }).filter((piece) => piece.code && piece.square);
  },
};
`;

/* ------------------------------------------------------------------ main */

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const stub = args.mode === "stub";
  const sourceExtensionDir = path.resolve(args.extension);
  const summary = {
    tool: "commentary-proof.mjs",
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
  let chromeStderr = "";
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

    /* --------------------------------------------------- helper server side */

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
        summary.checks.commentaryServer = { mode: "stub (already running)", health: existing };
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
        summary.checks.commentaryServer = { mode: "stub (spawned by the proof)", health, pid: fixtureServerProcess.pid };
      }
      summary.checks.canned = {
        source: "test/tools/fixture_server.py CANNED_EXPLAIN — recorded from the real Maia server (schema-identical)",
        keyFormat: "<fen>|<uci moves incl. the move to explain>|<elo_self>|<elo_oppo>",
      };
    } else {
      const health = await serverHealth();
      if (!String(health.model ?? "").includes("maia")) {
        throw new Error(
          `--real needs the Maia server on 127.0.0.1:8765 (got ${JSON.stringify(health)}). Start it: ` +
            "cd server && .venv/bin/python -m uvicorn app:app --host 127.0.0.1 --port 8765",
        );
      }
      summary.checks.commentaryServer = { mode: "real", health };
    }

    const serverStats = async () => {
      const response = await fetch(`${SERVER_ORIGIN}/debug/stats`, { cache: "no-store" });
      return response.ok ? response.json() : null;
    };
    const registerCannedExplain = async (key, response) => {
      const result = await fetch(`${SERVER_ORIGIN}/debug/canned-explain`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key, response }),
      });
      if (!result.ok) throw new Error(`/debug/canned-explain failed for ${key}: HTTP ${result.status}`);
    };
    const setExplainDelay = async (ms, count) => {
      await fetch(`${SERVER_ORIGIN}/debug/explain-delay`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ms, count }),
      });
    };
    const setLlmMode = async (mode) => {
      await fetch(`${SERVER_ORIGIN}/debug/llm-mode`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode }),
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
      optional_host_permissions: sourceManifest.optional_host_permissions,
      hasAllUrls: JSON.stringify(sourceManifest).includes("<all_urls>"),
    };
    summary.checks.commentaryFiles = Object.fromEntries(
      [
        "src/analysis/explain-client.js",
        "src/commentary/phrase.js",
        "src/commentary/llm.js",
        "src/ui/sidepanel.js",
        "src/ui/sidepanel.html",
        "src/analysis/analyze-client.js",
      ].map((file) => [file, sha256(readFileSync(path.join(sourceExtensionDir, file)))]),
    );
    if (summary.checks.manifest.hasAllUrls) fail("the manifest contains <all_urls>");
    const expectedPermissions = ["activeTab", "storage", "sidePanel", "downloads", "tts"];
    if (JSON.stringify(sourceManifest.permissions) !== JSON.stringify(expectedPermissions)) {
      fail(`unexpected required permissions: ${JSON.stringify(sourceManifest.permissions)} (M8 adds none)`);
    }
    const expectedOptional = ["https://api.groq.com/*", "https://generativelanguage.googleapis.com/*"];
    if (JSON.stringify(sourceManifest.optional_host_permissions) !== JSON.stringify(expectedOptional)) {
      fail(`optional_host_permissions must be exactly the two provider origins: ${JSON.stringify(sourceManifest.optional_host_permissions)}`);
    }

    variantDir = await mkdtemp(path.join(tmpdir(), "humanplay-commentary-variant-"));
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

    profileDir = await mkdtemp(path.join(tmpdir(), "humanplay-commentary-proof-"));
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
        'document.readyState === "complete" && !!document.getElementById("cm-status") && !!globalThis.__humanplayAnalysis',
      );
      return ready === true;
    }, { timeoutMs: args.timeoutMs });

    /* -------------------------------------------------------- S0: panel UI */

    summary.checks.panelUi = await evaluateInPanel(`(() => {
      const ids = ["cm-status", "cm-enabled", "cm-message", "cm-feed", "cm-engine", "cm-key",
                   "cm-test", "cm-llm-status", "cm-privacy", "cm-meta"];
      const present = {};
      for (const id of ids) present[id] = !!document.getElementById(id);
      return {
        present,
        missing: ids.filter((id) => !present[id]),
        inlineScripts: [...document.scripts].filter((script) => !script.src).length,
        enabledChecked: document.getElementById("cm-enabled").checked,
        engine: document.getElementById("cm-engine").value,
        keyInputType: document.getElementById("cm-key").type,
        keyInputValue: document.getElementById("cm-key").value,
        llmStatus: document.getElementById("cm-llm-status").textContent,
        privacyHidden: document.getElementById("cm-privacy").hidden,
      };
    })()`);
    if (summary.checks.panelUi.missing.length) fail(`panel is missing elements: ${summary.checks.panelUi.missing.join(", ")}`);
    if (summary.checks.panelUi.inlineScripts !== 0) fail("panel has inline scripts (CSP risk)");
    if (summary.checks.panelUi.enabledChecked !== true) fail("'Explain moves' must default ON");
    if (summary.checks.panelUi.engine !== "templates") fail(`engine select must default to templates: ${summary.checks.panelUi.engine}`);
    if (summary.checks.panelUi.keyInputType !== "password") fail("the API key input must be masked (type=password)");
    if (summary.checks.panelUi.keyInputValue !== "") fail("the API key input must never prefill the stored key");
    if (summary.checks.panelUi.privacyHidden !== true) fail("the privacy line must be hidden for templates");

    /* --------------------------------------------------- panel debug readers */

    const readCommentary = () =>
      evaluateInPanel(`(() => {
        const d = globalThis.__humanplayAnalysis;
        const feed = d.commentaryFeed;
        const entries = feed.getEntries().map((entry) => ({
          ply: entry.ply, by: entry.by, san: entry.san, uci: entry.uci,
          chip: entry.chip, classification: entry.classification, text: entry.text,
          template: entry.template, source: entry.source, llm: entry.llm,
          opening: entry.opening, playerLabel: entry.playerLabel,
          engineMs: entry.engineMs, roundTripMs: entry.roundTripMs, key: entry.key,
          atEpochMs: entry.atEpochMs,
        }));
        return {
          size: feed.size(),
          entries,
          stats: feed.getStats(),
          lastPly: feed.getLastPly(),
          sessionSeq: feed.getSessionSeq(),
          gate: d.commentary.gate,
          status: d.commentary.status,
          staleDiscards: d.commentary.staleDiscards,
          errors: d.commentary.errors,
          lastError: d.commentary.lastError,
          llmEngine: d.commentary.llmEngine,
          llmKeyPresent: d.commentary.llmApiKey.length > 0,
          llmCalls: d.commentary.llmCalls.map((call) => ({ provider: call.provider, model: call.model, ok: call.ok, errorClass: call.errorClass, latencyMs: call.latencyMs })),
          statusText: document.getElementById("cm-status").textContent,
          statusClass: document.getElementById("cm-status").className,
          message: document.getElementById("cm-message").hidden ? null : document.getElementById("cm-message").textContent,
          messageClass: document.getElementById("cm-message").className,
          meta: document.getElementById("cm-meta").textContent,
          domRows: [...document.querySelectorAll("#cm-feed .cm-entry")].map((li) => ({
            ply: li.dataset.ply, by: li.dataset.by, san: li.dataset.san,
            classification: li.dataset.classification, source: li.dataset.source,
            text: li.querySelector(".cm-text")?.textContent ?? null,
            chip: li.querySelector(".cm-chip")?.textContent ?? null,
            meta: li.querySelector(".cm-entry-meta")?.textContent ?? null,
            byLabel: li.querySelector(".cm-by")?.textContent ?? null,
          })),
          keyInDom: document.body.innerHTML.includes(${JSON.stringify(TEST_API_KEY)}),
        };
      })()`);

    const waitForEntry = (ply, description = `the feed entry for ply ${ply}`) =>
      waitFor(description, async () => {
        const state = await readCommentary();
        const entry = state.entries.find((candidate) => candidate.ply === ply);
        return entry ? { state, entry } : null;
      }, { timeoutMs: args.timeoutMs, intervalMs: 60 });

    const waitForFeed = (predicate, description) =>
      waitFor(description, async () => {
        const state = await readCommentary();
        return predicate(state) ? state : null;
      }, { timeoutMs: args.timeoutMs, intervalMs: 60 });

    const panelScreenshot = async (name) => {
      await cdp.send("Emulation.setDeviceMetricsOverride", { width: 400, height: 1200, deviceScaleFactor: 2, mobile: false }, panelSession);
      await evaluateInPanel('document.getElementById("commentary-card").scrollIntoView({ block: "start" }), true');
      await sleep(250);
      const shot = await cdp.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false }, panelSession);
      await cdp.send("Emulation.clearDeviceMetricsOverride", {}, panelSession);
      const target = path.join(args.outDir, name);
      await writeFile(target, Buffer.from(shot.data, "base64"));
      return path.relative(REPO_ROOT, target);
    };

    const evaluateInPage = async (session, expression) => {
      const result = await cdp.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, session);
      if (result.exceptionDetails) {
        throw new Error(`page evaluation failed: ${result.exceptionDetails.exception?.description ?? result.exceptionDetails.text}`);
      }
      return result.result.value;
    };

    const openFixture = async (file) => {
      const target = await cdp.send("Target.createTarget", { url: `${origin}/chesscom/${file}` });
      openTargets.add(target.targetId);
      const session = (await cdp.send("Target.attachToTarget", { targetId: target.targetId, flatten: true })).sessionId;
      sessionRole.set(session, "pages");
      await cdp.send("Page.enable", {}, session);
      await cdp.send("Runtime.enable", {}, session);
      await cdp.send("Log.enable", {}, session);
      await waitFor(`${file} load`, async () => {
        const result = await cdp.send("Runtime.evaluate", { expression: 'document.readyState === "complete"', returnByValue: true }, session);
        return result.result.value === true;
      }, { timeoutMs: args.timeoutMs });
      await evaluateInPage(session, `(() => { ${PAGE_HELPERS} return true; })()`);
      await cdp.send("Target.activateTarget", { targetId: target.targetId });
      return { targetId: target.targetId, session };
    };

    const refreshPanelState = async (targetId, expectedFen, description) => {
      await cdp.send("Target.activateTarget", { targetId });
      await evaluateInPanel('document.getElementById("cc-refresh").click(), true');
      await waitFor(`panel state ${description}`, async () => {
        const fen = await evaluateInPanel('document.getElementById("cc-fen").textContent');
        return fen === expectedFen;
      }, { timeoutMs: args.timeoutMs });
    };

    const expect = (record, condition, message) => {
      if (!condition) {
        record.pass = false;
        record.failures.push(message);
      }
    };

    /** Apply one replay step (board mutation + move list) and return its time. */
    const applyStep = (fixture, step, sans) =>
      evaluateInPage(fixture.session, `(() => {
        globalThis.__humanplayMutationAt = Date.now();
        globalThis.__humanplayProof.mutate("board-single", ${JSON.stringify({
          remove: step.remove ?? [],
          pieces: step.pieces,
          sans,
        })});
        return globalThis.__humanplayMutationAt;
      })()`);

    await mkdir(args.outDir, { recursive: true });

    /* ===================================================================== */
    /* STUB MODE                                                             */
    /* ===================================================================== */

    if (stub) {
      const startpos = await openFixture("startpos.html");
      const START_PIECES = await evaluateInPage(startpos.session, 'globalThis.__humanplayProof.readPieces("board-single")');
      summary.checks.startposPieces = START_PIECES.length;
      if (START_PIECES.length !== 32) fail(`the startpos fixture must have 32 pieces, got ${START_PIECES.length}`);

      /* ---------------------------------------------------------- case S1 */
      const s1 = { pass: true, failures: [], entries: [], requests: null, screenshot: null };
      summary.cases["stub-italian-replay"] = s1;
      try {
        await refreshPanelState(startpos.targetId, STARTPOS_FEN, "startpos (seed)");
        await waitForFeed((state) => state.lastPly === 0, "the commentary baseline at ply 0");
        const statsBefore = await serverStats();

        const sans = [];
        for (let index = 0; index < ITALIAN_STEPS.length; index += 1) {
          const ply = index + 1;
          const step = ITALIAN_STEPS[index];
          sans.push(ITALIAN7_SAN[index]);
          const mutatedAt = await applyStep(startpos, step, [...sans]);
          const { state, entry } = await waitForEntry(ply);
          s1.entries.push({
            ply,
            san: entry.san,
            by: entry.by,
            playerLabel: entry.playerLabel,
            chip: entry.chip,
            classification: entry.classification,
            text: entry.text,
            source: entry.source,
            opening: entry.opening,
            engineMs: entry.engineMs,
            roundTripMs: entry.roundTripMs,
            mutationToEntryMs: entry.atEpochMs ? entry.atEpochMs - mutatedAt : null,
          });
          void state;
        }

        const final = await readCommentary();
        s1.final = {
          size: final.size,
          newestFirst: final.entries.map((entry) => entry.ply),
          status: final.statusText,
          meta: final.meta,
          domRows: final.domRows.map((row) => ({ ply: row.ply, san: row.san, chip: row.chip, text: row.text, source: row.source, byLabel: row.byLabel })),
        };
        s1.screenshot = await panelScreenshot("stub-italian-feed.png");

        const statsAfter = await serverStats();
        s1.requests = {
          explainRequestsDelta: statsAfter.explainRequests - statsBefore.explainRequests,
          byKey: Object.fromEntries(
            ITALIAN7.map((move, index) => {
              const key = `${STARTPOS_FEN}|${ITALIAN7.slice(0, index + 1).join(" ")}|2400|2400`;
              return [key, statsAfter.explainByKey[key] ?? 0];
            }),
          ),
          cannedMisses: statsAfter.explainCannedMisses - statsBefore.explainCannedMisses,
        };

        for (const entry of s1.entries) {
          expect(s1, entry.text === EXPECTED_TEXTS[entry.ply], `ply ${entry.ply} text: ${entry.text}`);
          expect(s1, entry.chip === EXPECTED_CHIPS[entry.ply], `ply ${entry.ply} chip: ${entry.chip}`);
          expect(s1, entry.chip === CHIP_BY_CLASSIFICATION[entry.classification], `ply ${entry.ply} chip/classification: ${entry.chip}/${entry.classification}`);
          expect(s1, entry.source === "template", `ply ${entry.ply} source: ${entry.source}`);
          expect(s1, entry.by === (entry.ply % 2 === 1 ? "white" : "black"), `ply ${entry.ply} by: ${entry.by}`);
          expect(s1, entry.playerLabel === (entry.by === "white" ? "you" : "opponent"), `ply ${entry.ply} label: ${entry.playerLabel}`);
        }
        expect(s1, s1.final.size === 7, `feed size: ${s1.final.size}`);
        expect(s1, JSON.stringify(s1.final.newestFirst) === JSON.stringify([7, 6, 5, 4, 3, 2, 1]), `newest first: ${s1.final.newestFirst}`);
        expect(s1, s1.final.domRows.length === 7, `DOM rows: ${s1.final.domRows.length}`);
        expect(s1, s1.final.domRows.every((row, index) => row.text === EXPECTED_TEXTS[7 - index]), "DOM rows must mirror the entries");
        expect(s1, s1.requests.explainRequestsDelta === 7, `/explain requests: ${s1.requests.explainRequestsDelta} (expected 7 — one per ply)`);
        expect(s1, Object.values(s1.requests.byKey).every((count) => count === 1), `one request per ply key: ${JSON.stringify(s1.requests.byKey)}`);
        expect(s1, s1.requests.cannedMisses === 0, `canned misses: ${s1.requests.cannedMisses}`);
        expect(s1, /^7 of the last 50 plies explained · phrasing templates/.test(s1.final.meta), `meta: ${s1.final.meta}`);
        console.log(s1.pass
          ? `PASS stub-italian-replay: 7 plies, both colors, exact texts+chips, 1 request/ply, newest first`
          : `FAIL stub-italian-replay: ${s1.failures.join("; ")}`);
      } catch (error) {
        s1.pass = false;
        s1.failures.push(String(error?.message ?? error));
      }
      if (!s1.pass) for (const failure of s1.failures) fail(failure, "stub-italian-replay");
      await writeFile(path.join(args.outDir, "stub-italian-replay.json"), `${JSON.stringify(s1, null, 2)}\n`);

      /* ---------------------------------------------------------- case S2 */
      const s2 = { pass: true, failures: [], groq: null, gemini: null, screenshot: null };
      summary.cases["stub-llm-rephrasing"] = s2;
      try {
        // Test seam: point the providers at the fixture server's canned routes.
        await evaluateInPanel(`(() => {
          globalThis.__humanplayAnalysis.commentaryTest.setLlmEndpoint("groq", ${JSON.stringify(`${SERVER_ORIGIN}/llm/groq`)});
          globalThis.__humanplayAnalysis.commentaryTest.setLlmEndpoint("gemini", ${JSON.stringify(`${SERVER_ORIGIN}/llm/gemini`)});
          return true;
        })()`);
        // The engine + key via storage (the manual grant of the provider host
        // permission cannot happen headlessly — documented; the canned routes
        // live on the already-permitted localhost origin).
        await evaluateInPanel(`chrome.storage.local.get("settings").then((stored) =>
          chrome.storage.local.set({ settings: { ...(stored.settings ?? {}), llmEngine: "groq", llmApiKey: ${JSON.stringify(TEST_API_KEY)} } })
        )`);
        await waitForFeed((state) => state.llmEngine === "groq" && state.llmKeyPresent, "the groq engine setting");

        const statsBefore = await serverStats();
        const mutatedAt8 = await applyStep(startpos, MG14_STEPS[7], [...ITALIAN7_SAN, "Nf6"]);
        const { entry: groqEntry, state: groqState } = await waitForEntry(8);
        // The entry first shows the template; wait for the canned LLM text.
        const rephrased = await waitFor("the canned Groq rephrasing", async () => {
          const state = await readCommentary();
          const entry = state.entries.find((candidate) => candidate.ply === 8);
          return entry?.text === CANNED_LLM_TEXT.groq ? entry : null;
        });
        s2.groq = {
          template: groqEntry.template,
          text: rephrased.text,
          source: rephrased.source,
          llm: rephrased.llm,
          meta: (await readCommentary()).domRows.find((row) => row.ply === "8")?.meta ?? null,
          mutationToEntryMs: groqEntry.atEpochMs ? groqEntry.atEpochMs - mutatedAt8 : null,
          calls: (await readCommentary()).llmCalls,
        };
        expect(s2, groqEntry.template === EXPECTED_TEXTS[8], `template text: ${groqEntry.template}`);
        expect(s2, rephrased.text === CANNED_LLM_TEXT.groq, `groq text: ${rephrased.text}`);
        expect(s2, rephrased.source === "groq", `groq source: ${rephrased.source}`);
        expect(s2, rephrased.llm?.ok === true && rephrased.llm.provider === "groq", `groq llm meta: ${JSON.stringify(rephrased.llm)}`);
        includesText(s2, s2.groq.meta, "groq", "groq in the entry meta");
        includesText(s2, s2.groq.meta, "llm", "llm latency in the entry meta");

        // Gemini through its own response shape (next ply: 9.d3).
        await evaluateInPanel(`chrome.storage.local.get("settings").then((stored) =>
          chrome.storage.local.set({ settings: { ...(stored.settings ?? {}), llmEngine: "gemini" } })
        )`);
        await waitForFeed((state) => state.llmEngine === "gemini", "the gemini engine setting");
        await applyStep(startpos, MG14_STEPS[8], [...ITALIAN7_SAN, "Nf6", "d3"]);
        await waitForEntry(9);
        const geminiEntry = await waitFor("the canned Gemini rephrasing", async () => {
          const state = await readCommentary();
          const entry = state.entries.find((candidate) => candidate.ply === 9);
          return entry?.text === CANNED_LLM_TEXT.gemini ? entry : null;
        });
        s2.gemini = { text: geminiEntry.text, source: geminiEntry.source, llm: geminiEntry.llm };
        expect(s2, geminiEntry.text === CANNED_LLM_TEXT.gemini, `gemini text: ${geminiEntry.text}`);
        expect(s2, geminiEntry.source === "gemini", `gemini source: ${geminiEntry.source}`);

        const statsAfter = await serverStats();
        s2.requests = {
          llmDelta: statsAfter.llmRequests - statsBefore.llmRequests,
          byProvider: statsAfter.llmByProvider,
        };
        expect(s2, s2.requests.byProvider.groq >= 1 && s2.requests.byProvider.gemini >= 1, `provider requests: ${JSON.stringify(s2.requests.byProvider)}`);

        // The key stays local: never in the DOM, the input is empty, storage has it.
        const hygiene = await evaluateInPanel(`(async () => {
          const stored = await chrome.storage.local.get("settings");
          return {
            keyInDom: document.body.innerHTML.includes(${JSON.stringify(TEST_API_KEY)}),
            inputValue: document.getElementById("cm-key").value,
            inputPlaceholder: document.getElementById("cm-key").placeholder,
            storedKey: stored.settings?.llmApiKey === ${JSON.stringify(TEST_API_KEY)},
            syncUsage: await chrome.storage.sync.get(null).then((all) => Object.keys(all).length),
          };
        })()`);
        s2.hygiene = hygiene;
        expect(s2, hygiene.keyInDom === false, "the API key must never appear in the panel DOM");
        expect(s2, hygiene.inputValue === "", "the key input must stay empty after storing");
        expect(s2, hygiene.storedKey === true, "the key must be stored in chrome.storage.local");
        expect(s2, hygiene.syncUsage === 0, "chrome.storage.sync must stay unused");
        s2.screenshot = await panelScreenshot("stub-llm-rephrasing.png");
        console.log(s2.pass
          ? `PASS stub-llm-rephrasing: groq "${s2.groq.text.slice(0, 40)}…" + gemini canned text; key local-only`
          : `FAIL stub-llm-rephrasing: ${s2.failures.join("; ")}`);
      } catch (error) {
        s2.pass = false;
        s2.failures.push(String(error?.message ?? error));
      }
      if (!s2.pass) for (const failure of s2.failures) fail(failure, "stub-llm-rephrasing");
      await writeFile(path.join(args.outDir, "stub-llm-rephrasing.json"), `${JSON.stringify(s2, null, 2)}\n`);

      /* ---------------------------------------------------------- case S3 */
      const s3 = { pass: true, failures: [], http500: null, timeout: null, screenshot: null };
      summary.cases["stub-llm-fallback"] = s3;
      try {
        await evaluateInPanel(`chrome.storage.local.get("settings").then((stored) =>
          chrome.storage.local.set({ settings: { ...(stored.settings ?? {}), llmEngine: "groq" } })
        )`);
        await waitForFeed((state) => state.llmEngine === "groq", "groq again");

        // (a) provider 500 -> the template text stays, the meta notes the fallback
        await setLlmMode("error");
        await applyStep(startpos, MG14_STEPS[9], [...ITALIAN7_SAN, "Nf6", "d3", "d6"]);
        const { entry: entry10 } = await waitForEntry(10);
        const fallback500 = await waitFor("the 500 fallback note", async () => {
          const state = await readCommentary();
          const entry = state.entries.find((candidate) => candidate.ply === 10);
          return entry?.llm && entry.llm.ok === false ? entry : null;
        });
        const row10 = (await readCommentary()).domRows.find((row) => row.ply === "10");
        s3.http500 = { text: entry10.text, template: entry10.template, llm: fallback500.llm, meta: row10?.meta ?? null };
        expect(s3, entry10.text === EXPECTED_TEXTS[10], `the 500 must keep the template text: ${entry10.text}`);
        expect(s3, entry10.text === entry10.template, "template === text on fallback");
        expect(s3, fallback500.llm.errorClass === "http", `500 error class: ${JSON.stringify(fallback500.llm)}`);
        includesText(s3, row10?.meta ?? "", "fallback to template", "the meta must note the fallback");

        // (b) provider timeout (>2.5 s) -> same, errorClass timeout. The wait
        // accepts ANY settled llm outcome and asserts the class, so a wrong
        // outcome fails fast instead of looking like a hang.
        await setLlmMode("timeout");
        await applyStep(startpos, MG14_STEPS[10], [...ITALIAN7_SAN, "Nf6", "d3", "d6", "Bg5"]);
        const { entry: entry11 } = await waitForEntry(11);
        const settled11 = await waitFor("the settled LLM outcome for ply 11", async () => {
          const state = await readCommentary();
          const entry = state.entries.find((candidate) => candidate.ply === 11);
          return entry?.llm ? entry : null;
        }).catch(async (error) => {
          const diag = await readCommentary();
          const panelDiag = await evaluateInPanel(`(() => ({
            errorBanner: document.getElementById("error").hidden ? null : document.getElementById("error").textContent,
            llmStatus: document.getElementById("cm-llm-status").textContent,
            llmEngine: globalThis.__humanplayAnalysis.commentary.llmEngine,
            keyPresent: globalThis.__humanplayAnalysis.commentary.llmApiKey.length > 0,
            stale: globalThis.__humanplayAnalysis.commentary.staleDiscards,
            errors: globalThis.__humanplayAnalysis.commentary.errors,
            lastError: globalThis.__humanplayAnalysis.commentary.lastError,
          }))()`);
          throw new Error(
            `${error.message}; llmCalls=${JSON.stringify(diag.llmCalls)}; panel=${JSON.stringify(panelDiag)}`,
          );
        });
        const fallbackTimeout = settled11;
        const row11 = (await readCommentary()).domRows.find((row) => row.ply === "11");
        s3.timeout = { text: entry11.text, template: entry11.template, llm: fallbackTimeout.llm, meta: row11?.meta ?? null };
        expect(s3, entry11.text === EXPECTED_TEXTS[11], `the timeout must keep the template text: ${entry11.text}`);
        expect(s3, fallbackTimeout.llm.ok === false, `the timeout must be a fallback: ${JSON.stringify(fallbackTimeout.llm)}`);
        expect(s3, fallbackTimeout.llm.errorClass === "timeout", `timeout error class: ${JSON.stringify(fallbackTimeout.llm)}`);
        includesText(s3, row11?.meta ?? "", "timeout", "the meta must note the timeout");

        // the entry was visible with the template text from the start (no blocking)
        expect(s3, Boolean(entry11.atEpochMs), "the entry must exist before the LLM resolves");
        await setLlmMode("ok");
        s3.screenshot = await panelScreenshot("stub-llm-fallback.png");
        console.log(s3.pass
          ? `PASS stub-llm-fallback: 500 -> template + note; timeout -> template + note`
          : `FAIL stub-llm-fallback: ${s3.failures.join("; ")}`);
      } catch (error) {
        s3.pass = false;
        s3.failures.push(String(error?.message ?? error));
      }
      if (!s3.pass) for (const failure of s3.failures) fail(failure, "stub-llm-fallback");
      await writeFile(path.join(args.outDir, "stub-llm-fallback.json"), `${JSON.stringify(s3, null, 2)}\n`);

      /* ---------------------------------------------------------- case S4 */
      const s4 = { pass: true, failures: [], off: null, on: null, screenshot: null };
      summary.cases["stub-toggle-off"] = s4;
      try {
        // Back to templates: this case proves the toggle, not the LLM layer —
        // the entry text must be the deterministic template sentence.
        await evaluateInPanel(`chrome.storage.local.get("settings").then((stored) =>
          chrome.storage.local.set({ settings: { ...(stored.settings ?? {}), llmEngine: "templates" } })
        )`);
        await waitForFeed((state) => state.llmEngine === "templates", "templates again");
        const attemptsBefore = (await serverStats()).explainAttempts;
        await evaluateInPanel('document.getElementById("cm-enabled").click(), true');
        const offState = await waitForFeed((state) => state.gate === "off", "the commentary toggle off");
        s4.off = { gate: offState.gate, status: offState.statusText, message: offState.message, size: offState.size };
        expect(s4, /commentary off/.test(offState.message ?? ""), `off message: ${offState.message}`);

        // ply 12 (black O-O): the new ply is suppressed -> 0 requests, no entry
        await applyStep(startpos, MG14_STEPS[11], [...ITALIAN7_SAN, "Nf6", "d3", "d6", "Bg5", "O-O"]);
        await waitForFeed((state) => state.stats.suppressed >= 1, "the suppressed ply");
        await sleep(400);
        const afterOff = await readCommentary();
        const statsAfterOff = await serverStats();
        s4.off.afterPly12 = {
          size: afterOff.size,
          newestPly: afterOff.entries[0]?.ply ?? null,
          suppressed: afterOff.stats.suppressed,
          attemptsDelta: statsAfterOff.explainAttempts - attemptsBefore,
        };
        expect(s4, afterOff.size === 11, `feed must not grow while off: ${afterOff.size}`);
        expect(s4, afterOff.entries[0]?.ply === 11, `newest entry must stay ply 11: ${afterOff.entries[0]?.ply}`);
        expect(s4, s4.off.afterPly12.attemptsDelta === 0, `/explain attempts while off: ${s4.off.afterPly12.attemptsDelta}`);

        // back on -> the NEXT ply is explained; ply 12 is never retro-explained
        await evaluateInPanel('document.getElementById("cm-enabled").click(), true');
        await waitForFeed((state) => state.gate === "active", "the commentary toggle back on");
        await applyStep(startpos, MG14_STEPS[12], [...ITALIAN7_SAN, "Nf6", "d3", "d6", "Bg5", "O-O", "Bxf6"]);
        const { entry: entry13, state: onState } = await waitForEntry(13);
        s4.on = {
          newestPly: onState.entries[0].ply,
          plies: onState.entries.slice(0, 3).map((entry) => entry.ply),
          text: entry13.text,
          chip: entry13.chip,
        };
        expect(s4, entry13.text === EXPECTED_TEXTS[13], `ply 13 text: ${entry13.text}`);
        expect(s4, !onState.entries.some((entry) => entry.ply === 12), "ply 12 (while off) must never be retro-explained");
        s4.screenshot = await panelScreenshot("stub-toggle-off.png");
        console.log(s4.pass
          ? `PASS stub-toggle-off: 0 requests while off, no retro-explain, ply 13 after re-enabling`
          : `FAIL stub-toggle-off: ${s4.failures.join("; ")}`);
      } catch (error) {
        s4.pass = false;
        s4.failures.push(String(error?.message ?? error));
      }
      if (!s4.pass) for (const failure of s4.failures) fail(failure, "stub-toggle-off");
      await writeFile(path.join(args.outDir, "stub-toggle-off.json"), `${JSON.stringify(s4, null, 2)}\n`);

      /* ---------------------------------------------------------- case S5 */
      const s5 = { pass: true, failures: [], before: null, after: null, resumed: null, screenshot: null };
      summary.cases["stub-new-game-reset"] = s5;
      try {
        const before = await readCommentary();
        s5.before = { size: before.size, sessionSeq: before.sessionSeq, newestPly: before.entries[0]?.ply ?? null };

        // move list back to the start + the original pieces -> the adapter
        // reports a reset (sessionSeq+1) and the feed must clear.
        await evaluateInPage(startpos.session, `(() => {
          globalThis.__humanplayProof.setBoard("board-single", ${JSON.stringify(START_PIECES)});
          globalThis.__humanplayProof.setMoveList([]);
          return true;
        })()`);
        const resetState = await waitForFeed((state) => state.sessionSeq !== before.sessionSeq, "the new session");
        s5.after = {
          size: resetState.size,
          sessionSeq: resetState.sessionSeq,
          stats: resetState.stats,
          message: resetState.message,
          status: resetState.statusText,
        };
        expect(s5, resetState.size === 0, `feed must clear on a new game: ${resetState.size}`);
        expect(s5, resetState.sessionSeq > before.sessionSeq, `sessionSeq must advance: ${before.sessionSeq} -> ${resetState.sessionSeq}`);
        expect(s5, resetState.stats.reset >= 1, `reset counted: ${JSON.stringify(resetState.stats)}`);
        expect(s5, /new game/.test(resetState.message ?? ""), `message: ${resetState.message}`);
        expect(s5, resetState.lastPly === 0, `baseline re-seeded at ply 0: ${resetState.lastPly}`);

        // and the new session explains its own next move
        await applyStep(startpos, ITALIAN_STEPS[0], ["e4"]);
        const { entry: entry1, state: resumed } = await waitForEntry(1);
        s5.resumed = { size: resumed.size, newestPly: resumed.entries[0].ply, text: entry1.text };
        expect(s5, entry1.text === EXPECTED_TEXTS[1], `resumed ply 1 text: ${entry1.text}`);
        expect(s5, resumed.size === 1, `new session feed size: ${resumed.size}`);
        s5.screenshot = await panelScreenshot("stub-new-game-reset.png");
        console.log(s5.pass
          ? `PASS stub-new-game-reset: feed cleared (session ${before.sessionSeq} -> ${resetState.sessionSeq}), resumed with 1.e4`
          : `FAIL stub-new-game-reset: ${s5.failures.join("; ")}`);
      } catch (error) {
        s5.pass = false;
        s5.failures.push(String(error?.message ?? error));
      }
      if (!s5.pass) for (const failure of s5.failures) fail(failure, "stub-new-game-reset");
      await writeFile(path.join(args.outDir, "stub-new-game-reset.json"), `${JSON.stringify(s5, null, 2)}\n`);

      /* ---------------------------------------------------------- case S6 */
      const s6 = { pass: true, failures: [], registered: 0, final: null, screenshot: null };
      summary.cases["stub-feed-cap-50"] = s6;
      try {
        // Register deterministic canned bodies for the whole shuffle plan (54
        // keys: the 52 cap plies + the two stale-race plies). The feed
        // cap/order logic does not depend on the model facts; fact correctness
        // is covered by S1 + the real mode.
        for (const { ply, step, key } of SHUFFLE_PLAN) {
          const classifications = ["mainline", "common", "uncommon", "rare"];
          const probabilities = [0.46, 0.15, 0.05, 0.005];
          const classification = classifications[(ply - 1) % 4];
          await registerCannedExplain(key, {
            move: { san: step.san, uci: step.uci, by: ply % 2 === 1 ? "white" : "black", ply, moveNumber: Math.ceil(ply / 2) },
            flags: { capture: false, check: false, mate: false, castle: null, promotion: null, enPassant: false, recapture: false },
            material: { delta: 0, captured: null },
            maia: {
              playedProb: probabilities[(ply - 1) % 4],
              rank: classification === "mainline" ? 1 : 2,
              totalLegal: 20,
              top: [{ uci: "e2e4", san: "e4", prob: 0.46 }],
              moverElo: 2400,
            },
            wdl: { before: { win: 0.4, draw: 0.1, loss: 0.5 }, after: { win: 0.41, draw: 0.1, loss: 0.49 } },
            opening: { eco: "B00", name: "King's Pawn Game" },
            classification,
            model: "maia3-5m",
            elapsed_ms: 12.5,
          });
          s6.registered += 1;
        }

        // Fresh baseline (the previous case left 1.e4 replayed).
        await evaluateInPage(startpos.session, `(() => {
          globalThis.__humanplayProof.setBoard("board-single", ${JSON.stringify(START_PIECES)});
          globalThis.__humanplayProof.setMoveList([]);
          return true;
        })()`);
        const baseState = await waitForFeed((state) => state.lastPly === 0 && state.size === 0, "the fresh baseline");
        const statsBefore = {
          requested: baseState.stats.requested,
          capEvictions: baseState.stats.capEvictions,
        };

        const replayStartedAt = Date.now();
        for (let ply = 1; ply <= CAP_PLIES; ply += 1) {
          const plan = SHUFFLE_PLAN[ply - 1];
          await applyStep(startpos, plan.step, plan.sans);
          await waitForFeed((state) => state.lastPly === ply, `ply ${ply} observed`);
          await waitForFeed((state) => state.entries[0]?.ply === ply, `ply ${ply} entry`);
        }
        const final = await waitForFeed(
          (state) => state.stats.requested - statsBefore.requested === CAP_PLIES,
          "all 52 plies explained",
        );
        s6.final = {
          size: final.size,
          newestPly: final.entries[0]?.ply ?? null,
          oldestPly: final.entries[final.entries.length - 1]?.ply ?? null,
          requested: final.stats.requested - statsBefore.requested,
          capEvictions: final.stats.capEvictions - statsBefore.capEvictions,
          replayMs: Date.now() - replayStartedAt,
          chips: [...new Set(final.entries.map((entry) => entry.chip))].sort(),
        };
        expect(s6, final.size === 50, `feed size must cap at 50: ${final.size}`);
        expect(s6, final.entries[0]?.ply === CAP_PLIES, `newest entry: ${final.entries[0]?.ply}`);
        expect(s6, final.entries[final.entries.length - 1]?.ply === CAP_PLIES - 49, `oldest entry: ${final.entries[final.entries.length - 1]?.ply}`);
        expect(s6, s6.final.requested === CAP_PLIES, `requested: ${s6.final.requested}`);
        expect(s6, s6.final.capEvictions >= 2, `cap evictions: ${s6.final.capEvictions}`);
        expect(s6, s6.final.chips.length === 4, `all four classification chips in the capped feed: ${JSON.stringify(s6.final.chips)}`);
        s6.screenshot = await panelScreenshot("stub-feed-cap-50.png");
        console.log(s6.pass
          ? `PASS stub-feed-cap-50: 52 plies explained, feed holds ${s6.final.size} (plies 52..3), replay ${s6.final.replayMs} ms`
          : `FAIL stub-feed-cap-50: ${s6.failures.join("; ")}`);
      } catch (error) {
        s6.pass = false;
        s6.failures.push(String(error?.message ?? error));
      }
      if (!s6.pass) for (const failure of s6.failures) fail(failure, "stub-feed-cap-50");
      await writeFile(path.join(args.outDir, "stub-feed-cap-50.json"), `${JSON.stringify(s6, null, 2)}\n`);

      /* ---------------------------------------------------------- case S7 */
      const s7 = { pass: true, failures: [], stale: null, screenshot: null };
      summary.cases["stub-stale-race"] = s7;
      try {
        const before = await readCommentary();
        const staleBefore = before.staleDiscards;
        const attemptsBefore = (await serverStats()).explainAttempts;

        // ply 53 (Nf3) is delayed 900 ms; ply 54 (Nf6) lands while it is in flight.
        await setExplainDelay(900, 1);
        await applyStep(startpos, SHUFFLE_PLAN[CAP_PLIES].step, SHUFFLE_PLAN[CAP_PLIES].sans);
        await waitFor("the delayed /explain request to arrive", async () => {
          const stats = await serverStats();
          return stats.explainAttempts > attemptsBefore;
        });
        await applyStep(startpos, SHUFFLE_PLAN[CAP_PLIES + 1].step, SHUFFLE_PLAN[CAP_PLIES + 1].sans);
        const { entry: entry54 } = await waitForEntry(54);
        await sleep(1200); // let the delayed ply-53 response resolve
        const after = await readCommentary();
        s7.stale = {
          staleBefore,
          staleAfter: after.staleDiscards,
          has53: after.entries.some((entry) => entry.ply === 53),
          newestPly: after.entries[0]?.ply ?? null,
          newestText: entry54.text,
          size: after.size,
          stats: after.stats,
        };
        expect(s7, after.staleDiscards === staleBefore + 1, `staleDiscards: ${staleBefore} -> ${after.staleDiscards}`);
        expect(s7, !after.entries.some((entry) => entry.ply === 53), "the stale article must never enter the feed");
        expect(s7, after.entries[0]?.ply === 54, `newest entry after the race: ${after.entries[0]?.ply}`);
        expect(s7, after.size === 50, `feed size stays capped: ${after.size}`);
        s7.screenshot = await panelScreenshot("stub-stale-race.png");
        console.log(s7.pass
          ? `PASS stub-stale-race: delayed ply 53 discarded (staleDiscards ${staleBefore} -> ${after.staleDiscards}), ply 54 kept`
          : `FAIL stub-stale-race: ${s7.failures.join("; ")}`);
      } catch (error) {
        s7.pass = false;
        s7.failures.push(String(error?.message ?? error));
      }
      if (!s7.pass) for (const failure of s7.failures) fail(failure, "stub-stale-race");
      await writeFile(path.join(args.outDir, "stub-stale-race.json"), `${JSON.stringify(s7, null, 2)}\n`);

      summary.latencies.stub = {
        firstEntryMutationToRender_ms: summary.cases["stub-italian-replay"]?.entries?.[0]?.mutationToEntryMs ?? null,
        allEntriesMutationToRender_ms: summary.cases["stub-italian-replay"]?.entries?.map((entry) => entry.mutationToEntryMs) ?? [],
        engine_ms: summary.cases["stub-italian-replay"]?.entries?.map((entry) => entry.engineMs) ?? [],
        roundTrip_ms: summary.cases["stub-italian-replay"]?.entries?.map((entry) => entry.roundTripMs) ?? [],
        capReplay_ms: summary.cases["stub-feed-cap-50"]?.final?.replayMs ?? null,
        target_ms: 1000,
      };

      await closeTarget(startpos.targetId);
    }

    /* ===================================================================== */
    /* REAL MODE                                                             */
    /* ===================================================================== */

    if (!stub) {
      /* ---------------------------------------------------------- case R1 */
      const r1 = { pass: true, failures: [], entries: [], curl: null, latency: {}, screenshots: [] };
      summary.cases["real-montage-replay"] = r1;
      let startpos = null;
      try {
        startpos = await openFixture("startpos.html");
        await refreshPanelState(startpos.targetId, STARTPOS_FEN, "startpos (real)");
        await waitForFeed((state) => state.lastPly === 0, "the real commentary baseline");

        const sans = [];
        for (let index = 0; index < MG14_STEPS.length; index += 1) {
          const ply = index + 1;
          const step = MG14_STEPS[index];
          sans.push(MG14_SAN[index]);
          const mutatedAt = await applyStep(startpos, step, [...sans]);
          const { entry } = await waitForEntry(ply, `the real feed entry for ply ${ply}`);
          r1.entries.push({
            ply,
            san: entry.san,
            by: entry.by,
            chip: entry.chip,
            text: entry.text,
            source: entry.source,
            opening: entry.opening,
            engineMs: entry.engineMs,
            roundTripMs: entry.roundTripMs,
            mutationToEntryMs: entry.atEpochMs ? entry.atEpochMs - mutatedAt : null,
          });
        }

        for (const entry of r1.entries) {
          expect(r1, entry.text === EXPECTED_TEXTS[entry.ply], `ply ${entry.ply}: panel "${entry.text}" != recorded "${EXPECTED_TEXTS[entry.ply]}"`);
          expect(r1, entry.chip === EXPECTED_CHIPS[entry.ply], `ply ${entry.ply} chip: ${entry.chip}`);
          expect(r1, entry.source === "template", `ply ${entry.ply} source: ${entry.source}`);
        }

        // One entry equals a direct `curl /explain` (phrased by the panel's own module).
        const curl = await curlExplain({ fen: STARTPOS_FEN, moves: MG14, elo_self: 2400, elo_oppo: 2400 });
        r1.curl = { wallMs: curl.wallMs, ok: curl.ok, body: curl.body };
        expect(r1, curl.ok, `curl /explain failed: ${curl.error ?? curl.stdout}`);
        const phrased = phraseCommentary(curl.body);
        const lastEntry = r1.entries.at(-1);
        r1.equalsCurl = {
          curlText: phrased.text,
          panelText: lastEntry.text,
          curlClassification: curl.body?.classification,
          panelClassification: lastEntry.chip,
          curlOpening: curl.body?.opening,
          panelOpening: lastEntry.opening,
        };
        expect(r1, lastEntry.text === phrased.text, `ply 14 panel text must equal curl-phrased text`);
        expect(r1, lastEntry.text === `${lastEntry.san} — a recapture; 99% of 2400s take back.`, `ply 14 text: ${lastEntry.text}`);

        // The raw body of the LAST entry must equal the curl body (same facts).
        const raw = await evaluateInPanel(`(() => {
          const entry = globalThis.__humanplayAnalysis.commentaryFeed.getEntries().find((candidate) => candidate.ply === 14);
          return entry ? JSON.parse(JSON.stringify(entry.data)) : null;
        })()`);
        r1.rawEqualsCurl = {
          playedProb: raw?.maia?.playedProb,
          curlPlayedProb: curl.body?.maia?.playedProb,
          classification: raw?.classification,
          opening: raw?.opening?.eco ?? null,
          curlOpening: curl.body?.opening?.eco ?? null,
        };
        expect(r1, raw && Math.abs(raw.maia.playedProb - curl.body.maia.playedProb) < 1e-9, `raw playedProb ${r1.rawEqualsCurl.playedProb} vs curl ${r1.rawEqualsCurl.curlPlayedProb}`);
        expect(r1, raw?.classification === curl.body.classification, "raw classification vs curl");
        expect(r1, (raw?.opening?.eco ?? null) === (curl.body?.opening?.eco ?? null), "raw opening vs curl");

        const final = await readCommentary();
        r1.latency = {
          entries: r1.entries.length,
          engineMs: r1.entries.map((entry) => entry.engineMs),
          roundTripMs: r1.entries.map((entry) => entry.roundTripMs),
          mutationToEntryMs: r1.entries.map((entry) => entry.mutationToEntryMs),
          maxMutationToEntryMs: Math.max(...r1.entries.map((entry) => entry.mutationToEntryMs ?? 0)),
          curlWallMs: curl.wallMs,
          staleDiscards: final.staleDiscards,
          errors: final.errors,
        };
        expect(r1, r1.latency.maxMutationToEntryMs <= 3000, `mutation -> entry max ${r1.latency.maxMutationToEntryMs} ms`);
        expect(r1, r1.latency.errors === 0, `commentary errors: ${r1.latency.errors}`);
        expect(r1, final.size === 14, `feed size: ${final.size}`);

        r1.screenshots.push(await panelScreenshot("real-montage-feed.png"));
        console.log(r1.pass
          ? `PASS real-montage-replay: 14 plies, texts == recorded facts, ply 14 == curl ("${lastEntry.text}"); ` +
            `max mutation->entry ${r1.latency.maxMutationToEntryMs} ms, engine ${Math.max(...r1.latency.engineMs)} ms max`
          : `FAIL real-montage-replay: ${r1.failures.join("; ")}`);
      } catch (error) {
        r1.pass = false;
        r1.failures.push(String(error?.message ?? error));
      }
      if (!r1.pass) for (const failure of r1.failures) fail(failure, "real-montage-replay");
      await writeFile(path.join(args.outDir, "real-montage-replay.json"), `${JSON.stringify(r1, null, 2)}\n`);
      if (startpos) await closeTarget(startpos.targetId);

      summary.latencies.real = {
        entries: summary.cases["real-montage-replay"]?.latency?.entries ?? null,
        engineMax_ms: summary.cases["real-montage-replay"]?.latency?.engineMs ? Math.max(...summary.cases["real-montage-replay"].latency.engineMs) : null,
        engineAvg_ms: summary.cases["real-montage-replay"]?.latency?.engineMs
          ? summary.cases["real-montage-replay"].latency.engineMs.reduce((sum, value) => sum + value, 0) / summary.cases["real-montage-replay"].latency.engineMs.length
          : null,
        maxMutationToEntry_ms: summary.cases["real-montage-replay"]?.latency?.maxMutationToEntryMs ?? null,
        target_article_ms: 100,
        target_visible_ms: 1000,
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
    summary.checks.extensionConsoleClean =
      summary.console.panelErrors.length === 0 &&
      summary.console.serviceWorkerErrors.length === 0 &&
      summary.console.pageErrors.length === 0;
    if (!summary.checks.extensionConsoleClean) fail("extension console reported errors — see summary.console");
    if (summary.checks.panelUi?.keyInDom === true) fail("the test API key appeared in the panel DOM");
    const harmlessNetworkLog = (text) => /ERR_UNKNOWN_URL_SCHEME|favicon\.ico/.test(text);
    // Stub mode intentionally provokes canned-miss 400s (the M4/M7 cards have no
    // canned data for the replayed plies), the LLM 500 and the aborted LLM
    // timeout — all expected, all recorded in `summary.console.networkErrors`.
    const expectedStubNetworkLog = (text) => /status of (400|404|500)|ERR_ABORTED|ERR_EMPTY_RESPONSE|ERR_CONNECTION/.test(text);
    const unexpectedNetworkErrors = summary.console.networkErrors.filter(
      (entry) => !harmlessNetworkLog(entry.text) && !(stub && expectedStubNetworkLog(entry.text)),
    );
    if (unexpectedNetworkErrors.length) {
      fail(`unexpected network errors: ${unexpectedNetworkErrors.map((entry) => entry.text).join(" | ")}`);
    }

    summary.ok = summary.failures.length === 0;
    const proofName = stub ? "commentary-proof-stub.json" : "commentary-proof-real.json";
    await writeFile(path.join(args.outDir, proofName), `${JSON.stringify(summary, null, 2)}\n`);
    console.log(
      `\n${summary.ok ? "ALL COMMENTARY CASES PASSED" : `FAILURES (${summary.failures.length}):\n - ` + summary.failures.join("\n - ")}` +
        `\nproof: ${path.relative(REPO_ROOT, path.join(args.outDir, proofName))}`,
    );
    if (!summary.ok) process.exitCode = 1;
  } catch (error) {
    console.error(`commentary-proof failed: ${error.message}`);
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
    if (chromeStderr && summary.failures.length) {
      console.error("chrome stderr (tail):\n" + chromeStderr.split("\n").slice(-15).join("\n"));
    }
  }
}

/** Small helper so the assertions read the same way as the premove proof. */
function includesText(record, haystack, needle, label) {
  if (!String(haystack).includes(needle)) {
    record.pass = false;
    record.failures.push(`${label}: expected to include ${JSON.stringify(needle)}, got ${JSON.stringify(haystack)}`);
  }
}

main();

#!/usr/bin/env node
/**
 * adapter-proof.mjs — objective end-to-end proof for the chess.com DOM adapter.
 *
 * What it does (all against a real Chrome for Testing, via CDP):
 *
 *   1. serves test/fixtures/ from an ephemeral local HTTP port (node:http,
 *      zero deps) and loads a temporary COPY of the extension whose manifest
 *      additionally matches the content script (and its web-accessible modules)
 *      on that origin — the shipped manifest stays chess.com-only. Every code
 *      file is hash-compared against the source tree and the report shows
 *      `codeIdentical` (same technique as test/tools/capture-proof.mjs);
 *   2. opens the side panel document (the exact file the real side panel
 *      renders), installs a raw GameState collector in it and asserts, for each
 *      offline chess.com fixture page (test/fixtures/chesscom/*.html):
 *        - a GameState message arrives (the content script broadcasts it),
 *        - fen is EXACTLY the hidden ground-truth FEN (python-chess),
 *        - movesUci is exactly the ground-truth UCI history,
 *        - userColor / flipped match the page,
 *        - boardRect matches the DOM board's getBoundingClientRect() (the
 *          rectangle M5's overlay will draw on) and is sane,
 *        - mismatch is absent, the expected strategies were used,
 *        - the panel card renders the same FEN/turn/color (UI path), screenshot;
 *   3. proves the change pipeline: mutates the startpos fixture DOM (piece
 *      class + move-list node), expects a new state with the new exact FEN;
 *   4. proves the snapshot recorder: clicks "Record chess.com snapshot" in the
 *      panel, catches the chrome.downloads download, parses it and asserts it
 *      is sanitized (no usernames / user-upload URLs) and carries the state;
 *   5. replays every recorded snapshot in test/fixtures/chesscom-snapshots/
 *      through test/fixtures/chesscom/replay.html and asserts the adapter
 *      parses the rebuilt page into the same state ("skipped" when the folder
 *      is empty — it fills up when the user records real chess.com snapshots);
 *   6. reports console/exception logs of the panel, the service worker and the
 *      fixture pages (the "clean console" evidence).
 *
 * Exit code is non-zero when any assertion fails. Writes per-fixture proof
 * JSONs + panel screenshots and one summary into
 * test/fixtures/captures/adapter/.
 *
 * Usage:
 *   node test/tools/adapter-proof.mjs --chrome <path to chrome binary>
 *     [--extension extension] [--out-dir test/fixtures/captures/adapter]
 *     [--fixtures-dir test/fixtures/chesscom]
 *     [--snapshots-dir test/fixtures/chesscom-snapshots]
 *     [--headful] [--keep-profile] [--timeout-ms 45000]
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

/* ------------------------------------------------------------------ args */

function parseArgs(argv) {
  const args = {
    chrome: null,
    extension: path.join(REPO_ROOT, "extension"),
    outDir: path.join(REPO_ROOT, "test/fixtures/captures/adapter"),
    fixturesDir: path.join(REPO_ROOT, "test/fixtures/chesscom"),
    snapshotsDir: path.join(REPO_ROOT, "test/fixtures/chesscom-snapshots"),
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
      case "--fixtures-dir": args.fixturesDir = path.resolve(next()); break;
      case "--snapshots-dir": args.snapshotsDir = path.resolve(next()); break;
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

/** Minimal zero-dep static file server (fixture pages + snapshot JSONs). */
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

/* ------------------------------------------------------------------ main */

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const sourceExtensionDir = path.resolve(args.extension);
  const summary = {
    tool: "adapter-proof.mjs",
    generatedAt: new Date().toISOString(),
    chrome: args.chrome,
    extension: sourceExtensionDir,
    checks: {},
    cases: {},
    snapshotReplays: {},
    failures: [],
    console: {},
  };
  let chromeProcess = null;
  let cdp = null;
  let profileDir = null;
  let variantDir = null;
  let downloadDir = null;
  let staticServer = null;
  const logs = { panel: [], serviceWorker: [], pages: [] };
  let sessionRole = new Map();

  const fail = (message, caseName = null) => {
    summary.failures.push(caseName ? `${caseName}: ${message}` : message);
    console.error(`FAIL ${caseName ? `${caseName}: ` : ""}${message}`);
  };

  try {
    /* ------------------------------------------------ static fixture server */

    const { server, port } = await startStaticServer(path.join(REPO_ROOT, "test/fixtures"));
    staticServer = server;
    const origin = `http://127.0.0.1:${port}`;
    summary.checks.staticServer = { origin, root: path.join(REPO_ROOT, "test/fixtures") };

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
      web_accessible_resources: sourceManifest.web_accessible_resources,
      hasAllUrls: JSON.stringify(sourceManifest).includes("<all_urls>"),
    };
    summary.checks.adapterFiles = Object.fromEntries(
      ["src/content/chesscom-adapter.js", "src/content/board-dom.js", "src/content/move-history.js", "vendor/chess.js"].map(
        (file) => [file, sha256(readFileSync(path.join(sourceExtensionDir, file)))],
      ),
    );

    variantDir = await mkdtemp(path.join(tmpdir(), "humanplay-adapter-variant-"));
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
      contentScriptMatches: variantManifest.content_scripts[0].matches,
      webAccessibleMatches: variantManifest.web_accessible_resources[0].matches,
      codeFilesCompared: sourceFiles.length,
      codeFileMismatches: mismatches,
      codeIdentical: mismatches.length === 0,
    };
    if (mismatches.length) throw new Error(`manifest variant differs in code files: ${mismatches.join(", ")}`);

    const extensionId = unpackedExtensionId(variantDir);
    summary.checks.extensionId = extensionId;

    /* ------------------------------------------------------------- browser */

    profileDir = await mkdtemp(path.join(tmpdir(), "humanplay-adapter-proof-"));
    downloadDir = await mkdtemp(path.join(tmpdir(), "humanplay-adapter-downloads-"));
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
    chromeProcess.stderr.on("data", (chunk) => {
      chromeStderr += chunk.toString();
    });

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

    /* ------------------------------------------------- service worker (loads?) */

    const serviceWorkerPath = sourceManifest.background?.service_worker;
    const expectedWorkerUrl = `chrome-extension://${extensionId}/${serviceWorkerPath}`;
    const serviceWorker = await waitFor(
      "our extension's service worker target",
      () =>
        [...targets.values()].find(
          (target) => target.type === "service_worker" && target.url === expectedWorkerUrl,
        ),
      { timeoutMs: args.timeoutMs },
    );
    summary.checks.serviceWorkerUrl = serviceWorker.url;
    const swSession = (await cdp.send("Target.attachToTarget", { targetId: serviceWorker.targetId, flatten: true })).sessionId;
    sessionRole.set(swSession, "service-worker");
    await cdp.send("Runtime.enable", {}, swSession);
    await cdp.send("Log.enable", {}, swSession);

    /* ------------------------------------------------------------ the panel */

    const panelTarget = await cdp.send("Target.createTarget", {
      url: `chrome-extension://${extensionId}/src/ui/sidepanel.html`,
    });
    const panelSession = (await cdp.send("Target.attachToTarget", { targetId: panelTarget.targetId, flatten: true })).sessionId;
    sessionRole.set(panelSession, "panel");
    await cdp.send("Page.enable", {}, panelSession);
    await cdp.send("Runtime.enable", {}, panelSession);
    await cdp.send("Log.enable", {}, panelSession);

    const evaluateInPanel = async (expression) => {
      const result = await cdp.send(
        "Runtime.evaluate",
        { expression, awaitPromise: true, returnByValue: true },
        panelSession,
      );
      if (result.exceptionDetails) {
        throw new Error(
          `panel evaluation failed: ${result.exceptionDetails.exception?.description ?? result.exceptionDetails.text}`,
        );
      }
      return result.result.value;
    };

    const waitInPanel = (condition, description, timeoutMs = args.timeoutMs) =>
      evaluateInPanel(`new Promise((resolve, reject) => {
         const deadline = Date.now() + ${timeoutMs};
         const tick = () => {
           let value = null;
           try { value = (${condition}); } catch (error) { return reject(error); }
           if (value) return resolve(value);
           if (Date.now() > deadline) return reject(new Error(${JSON.stringify(`timeout: ${description}`)}));
           setTimeout(tick, 100);
         };
         tick();
       })`);

    await waitInPanel('document.readyState === "complete"', "panel load");
    await waitInPanel('!!document.getElementById("cc-refresh")', "panel module init");

    // Raw GameState collector (the panel is an extension context, so it sees the
    // same runtime messages the real side panel does).
    summary.checks.panelCollector = await evaluateInPanel(`(() => {
      globalThis.__humanplayProof = { states: [] };
      chrome.runtime.onMessage.addListener((message, sender) => {
        if (message?.type !== "humanplay:chesscom-state") return undefined;
        globalThis.__humanplayProof.states.push({
          state: message.state,
          senderUrl: String(sender?.url ?? sender?.tab?.url ?? ""),
          senderTabId: sender?.tab?.id ?? null,
          at: Date.now(),
        });
        return undefined;
      });
      return true;
    })()`);

    summary.checks.panelUi = await evaluateInPanel(`(() => {
      const ids = ["assistant-toggle", "capture-button", "record-button", "server-chip", "refresh-health",
                   "cc-chip", "cc-board", "cc-fen", "cc-moves", "cc-turn", "cc-color", "cc-mismatch",
                   "cc-refresh", "cc-snapshot", "cc-snapshot-status", "cc-color-setting"];
      const present = {};
      for (const id of ids) present[id] = !!document.getElementById(id);
      return { present, inlineScripts: [...document.scripts].filter((s) => !s.src).length };
    })()`);

    const stateCount = () => evaluateInPanel("globalThis.__humanplayProof.states.length");

    /* -------------------------------------------------- per-fixture checks */

    const fixtureFiles = (await readdir(args.fixturesDir))
      .filter((file) => file.endsWith(".html") && file !== "index.html" && file !== "replay.html")
      .sort();

    const openPage = async (url) => {
      const target = await cdp.send("Target.createTarget", { url: "about:blank" });
      const session = (await cdp.send("Target.attachToTarget", { targetId: target.targetId, flatten: true })).sessionId;
      sessionRole.set(session, "page");
      await cdp.send("Page.enable", {}, session);
      await cdp.send("Runtime.enable", {}, session);
      await cdp.send("Log.enable", {}, session);
      await cdp.send("Page.navigate", { url }, session);
      return { targetId: target.targetId, session };
    };

    const evaluateInPage = async (session, expression) => {
      const result = await cdp.send(
        "Runtime.evaluate",
        { expression, awaitPromise: true, returnByValue: true },
        session,
      );
      if (result.exceptionDetails) {
        throw new Error(
          `page evaluation failed: ${result.exceptionDetails.exception?.description ?? result.exceptionDetails.text}`,
        );
      }
      return result.result.value;
    };

    const latestStateFor = async (urlFragment, { minIndex = 0, expectedFen = null } = {}) =>
      waitFor(
        `GameState for ${urlFragment}`,
        async () => {
          const states = await evaluateInPanel("globalThis.__humanplayProof.states");
          return (
            states
              .slice(minIndex)
              .filter((entry) => entry.senderUrl.includes(urlFragment))
              .filter((entry) => (expectedFen === null ? true : entry.state?.fen === expectedFen))
              .at(-1) ?? null
          );
        },
        { timeoutMs: args.timeoutMs },
      );

    await mkdir(args.outDir, { recursive: true });

    for (const file of fixtureFiles) {
      const slug = path.basename(file, ".html");
      const url = `${origin}/chesscom/${file}`;
      const before = await stateCount();
      const { targetId, session } = await openPage(url);
      const record = { url, pass: true, failures: [], state: null, groundTruth: null, panel: null };
      summary.cases[slug] = record;

      try {
        await waitFor(
          "fixture page load",
          () => evaluateInPage(session, 'document.readyState === "complete"'),
          { timeoutMs: args.timeoutMs },
        );
        const groundTruth = await evaluateInPage(
          session,
          `(() => {
             const truth = document.getElementById("fen");
             const board = document.getElementById(truth.dataset.boardId);
             const rect = board.getBoundingClientRect();
             return {
               fen: truth.dataset.fen,
               movesUci: truth.dataset.moves ? truth.dataset.moves.split(" ").filter(Boolean) : [],
               userColor: truth.dataset.userColor,
               flipped: truth.dataset.flipped === "true",
               boardId: truth.dataset.boardId,
               rect: { x: rect.x, y: rect.y, w: rect.width, h: rect.height },
               devicePixelRatio: devicePixelRatio,
               viewport: { w: innerWidth, h: innerHeight },
               boardsOnPage: document.querySelectorAll("wc-chess-board").length,
             };
           })()`,
        );
        record.groundTruth = groundTruth;

        const entry = await latestStateFor(`/chesscom/${file}`, { minIndex: before });
        const state = entry.state;
        record.state = state;

        const assert = (condition, message) => {
          if (!condition) {
            record.pass = false;
            record.failures.push(message);
          }
        };
        assert(state.ok === true, `state.ok is ${state.ok} (${state.reason ?? "no reason"})`);
        assert(state.fen === groundTruth.fen, `fen mismatch: adapter ${state.fen} vs ground truth ${groundTruth.fen}`);
        assert(
          JSON.stringify(state.movesUci) === JSON.stringify(groundTruth.movesUci),
          `movesUci mismatch: ${JSON.stringify(state.movesUci)} vs ${JSON.stringify(groundTruth.movesUci)}`,
        );
        assert(state.userColor === groundTruth.userColor, `userColor ${state.userColor} vs ${groundTruth.userColor}`);
        assert(state.flipped === groundTruth.flipped, `flipped ${state.flipped} vs ${groundTruth.flipped}`);
        assert(state.boardId === groundTruth.boardId, `boardId ${state.boardId} vs ${groundTruth.boardId}`);
        assert(state.mismatch === undefined, `unexpected mismatch: ${JSON.stringify(state.mismatch)}`);
        assert(state.gameId === null, `gameId for a fixture URL should be null, got ${state.gameId}`);
        assert(state.positionSource === "piece-square-class", `positionSource ${state.positionSource}`);
        assert(
          state.historySource === "move-list" || state.historySource === "move-list-empty",
          `historySource ${state.historySource}`,
        );
        assert(state.devicePixelRatio === groundTruth.devicePixelRatio, "devicePixelRatio");

        const rect = state.boardRect;
        const rectErrors = {
          x: Number((rect.x - groundTruth.rect.x).toFixed(3)),
          y: Number((rect.y - groundTruth.rect.y).toFixed(3)),
          w: Number((rect.w - groundTruth.rect.w).toFixed(3)),
          h: Number((rect.h - groundTruth.rect.h).toFixed(3)),
        };
        record.rectErrors = rectErrors;
        const maxRectError = Math.max(...Object.values(rectErrors).map(Math.abs));
        assert(maxRectError <= 0.5, `boardRect differs from DOM ground truth by ${maxRectError}px`);
        assert(rect.w >= 200 && rect.h >= 200, `boardRect too small: ${rect.w}x${rect.h}`);
        assert(Math.abs(rect.w - rect.h) <= 2, `boardRect is not square: ${rect.w}x${rect.h}`);
        assert(
          rect.x >= -1 && rect.y >= -1 && rect.x + rect.w <= groundTruth.viewport.w + 1 && rect.y + rect.h <= groundTruth.viewport.h + 1,
          `boardRect outside the viewport: ${JSON.stringify(rect)} viewport ${JSON.stringify(groundTruth.viewport)}`,
        );
        // The fixture contains a smaller preview board and a hidden board: the
        // "largest visible board" rule must have picked the real one.
        assert(groundTruth.boardsOnPage === 3, `fixture should expose 3 boards, found ${groundTruth.boardsOnPage}`);
        record.trapBoards = groundTruth.boardsOnPage - 1;

        // Panel UI path: activate this tab, press "Refresh state", read the card.
        await cdp.send("Target.activateTarget", { targetId });
        const panelUi = await evaluateInPanel(`(async () => {
          document.getElementById("cc-refresh").click();
          await new Promise((resolve) => setTimeout(resolve, 400));
          return {
            chip: document.getElementById("cc-chip").textContent,
            chipClass: document.getElementById("cc-chip").className,
            board: document.getElementById("cc-board").textContent,
            fen: document.getElementById("cc-fen").textContent,
            moves: document.getElementById("cc-moves").textContent,
            turn: document.getElementById("cc-turn").textContent,
            color: document.getElementById("cc-color").textContent,
            mismatchHidden: document.getElementById("cc-mismatch").hidden,
          };
        })()`);
        record.panel = panelUi;
        assert(panelUi.chipClass.includes("chip-online"), `panel chip is not listening: ${JSON.stringify(panelUi)}`);
        assert(panelUi.fen === groundTruth.fen, `panel FEN ${panelUi.fen} vs ${groundTruth.fen}`);
        assert(panelUi.mismatchHidden === true, "panel shows a mismatch warning");

        // Panel screenshot (emulated side-panel viewport, like M2).
        await cdp.send("Emulation.setDeviceMetricsOverride", { width: 380, height: 860, deviceScaleFactor: 2, mobile: false }, panelSession);
        await sleep(250);
        const shot = await cdp.send("Page.captureScreenshot", { format: "png" }, panelSession);
        await cdp.send("Emulation.clearDeviceMetricsOverride", {}, panelSession);
        const shotPath = path.join(args.outDir, `${slug}-panel.png`);
        await writeFile(shotPath, Buffer.from(shot.data, "base64"));
        record.panelScreenshot = path.relative(REPO_ROOT, shotPath);

        console.log(
          record.pass
            ? `PASS ${slug}: fen ok, ${state.movesUci.length} moves, userColor ${state.userColor}, flipped ${state.flipped}, rect ${Math.round(rect.w)}x${Math.round(rect.h)}`
            : `FAIL ${slug}: ${record.failures.join("; ")}`,
        );
      } catch (error) {
        record.pass = false;
        record.failures.push(String(error?.message ?? error));
      }
      if (!record.pass) {
        for (const failure of record.failures) summary.failures.push(`${slug}: ${failure}`);
      }
      await writeFile(path.join(args.outDir, `${slug}-proof.json`), `${JSON.stringify({ slug, ...record }, null, 2)}\n`);
    }

    /* --------------------------------------------------- change detection */

    const changeCase = { pass: true, failures: [], before: null, after: null };
    summary.cases["dom-change"] = changeCase;
    try {
      const url = `${origin}/chesscom/startpos.html`;
      const before = await stateCount();
      const { session } = await openPage(url);
      await waitFor("startpos page load", () => evaluateInPage(session, 'document.readyState === "complete"'), {
        timeoutMs: args.timeoutMs,
      });
      const initial = await latestStateFor("/chesscom/startpos.html", { minIndex: before, expectedFen: "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1" });
      changeCase.before = initial.state.fen;

      await evaluateInPage(
        session,
        `(() => {
           const board = document.getElementById("board-single");
           const knight = board.querySelector(".piece.wn.square-71") ?? board.querySelector(".piece.square-71.wn");
           knight.classList.remove("square-71");
           knight.classList.add("square-63");
           knight.style.left = "62.5%";
           knight.style.top = "62.5%";
           const list = document.querySelector("wc-simple-move-list .timestamps-with-base-time");
           list.innerHTML = '<div class="main-line-row move-list-row light-row" data-whole-move-number="1">1.  '
             + '<div data-node="0-0" class="node white-move main-line-ply"> <span class="node-highlight-content offset-for-annotation-icon">Nf3 </span></div>  '
             + '<div data-move-list-el="timestamp" data-ply="1" class="time-white">0.4s</div></div>';
           return true;
         })()`,
      );

      const expectedFen = "rnbqkbnr/pppppppp/8/8/8/5N2/PPPPPPPP/RNBQKB1R b KQkq - 1 1";
      const after = await latestStateFor("/chesscom/startpos.html", { minIndex: before, expectedFen });
      changeCase.after = { fen: after.state.fen, movesUci: after.state.movesUci, historyStatus: after.state.historyStatus };
      if (after.state.fen !== expectedFen) changeCase.failures.push(`fen ${after.state.fen}`);
      if (JSON.stringify(after.state.movesUci) !== JSON.stringify(["g1f3"])) {
        changeCase.failures.push(`movesUci ${JSON.stringify(after.state.movesUci)}`);
      }
      if (after.state.historyStatus !== "replayed") changeCase.failures.push(`historyStatus ${after.state.historyStatus}`);
      changeCase.pass = changeCase.failures.length === 0;
      console.log(changeCase.pass ? `PASS dom-change: Nf3 picked up -> ${after.state.fen}` : `FAIL dom-change: ${changeCase.failures.join("; ")}`);
    } catch (error) {
      changeCase.pass = false;
      changeCase.failures.push(String(error?.message ?? error));
    }
    if (!changeCase.pass) for (const failure of changeCase.failures) fail(failure, "dom-change");

    /* ------------------------------------------------ snapshot recorder */

    const snapshotCase = { pass: true, failures: [], file: null, sanitized: null, state: null };
    summary.cases["snapshot-recorder"] = snapshotCase;
    try {
      await cdp.send("Browser.setDownloadBehavior", { behavior: "allow", downloadPath: downloadDir, eventsEnabled: true });
      const url = `${origin}/chesscom/middlegame-castling.html`;
      const { targetId, session } = await openPage(url);
      await waitFor("middlegame page load", () => evaluateInPage(session, 'document.readyState === "complete"'), {
        timeoutMs: args.timeoutMs,
      });
      await cdp.send("Target.activateTarget", { targetId });
      await sleep(300);

      await evaluateInPanel('document.getElementById("cc-snapshot").click(), true');
      const downloaded = await waitFor(
        "the snapshot download to finish",
        async () => {
          const files = (await readdir(downloadDir)).filter((name) => name.endsWith(".json"));
          if (files.length === 0) return null;
          const name = files[0];
          return { name, text: await readFile(path.join(downloadDir, name), "utf8") };
        },
        { timeoutMs: args.timeoutMs },
      );
      const snapshot = JSON.parse(downloaded.text);
      snapshotCase.file = downloaded.name;
      snapshotCase.state = {
        fen: snapshot.state?.fen,
        movesUci: snapshot.state?.movesUci,
        userColor: snapshot.state?.userColor,
        flipped: snapshot.state?.flipped,
      };
      const expected = summary.cases["middlegame-castling"]?.groundTruth;
      const assertSnap = (condition, message) => {
        if (!condition) {
          snapshotCase.pass = false;
          snapshotCase.failures.push(message);
        }
      };
      assertSnap(snapshot.schema === "humanplay.chesscom.snapshot/1", `schema ${snapshot.schema}`);
      assertSnap(typeof snapshot.boardOuterHTML === "string" && snapshot.boardOuterHTML.includes("wc-chess-board"), "boardOuterHTML");
      assertSnap(typeof snapshot.moveListOuterHTML === "string" && snapshot.moveListOuterHTML.includes("move-list"), "moveListOuterHTML");
      assertSnap(
        typeof snapshot.playersOuterHTML === "string" && snapshot.playersOuterHTML.includes("clock-white") && snapshot.playersOuterHTML.includes("clock-black"),
        "playersOuterHTML keeps the clock color classes",
      );
      assertSnap(expected ? snapshot.state?.fen === expected.fen : true, `snapshot fen ${snapshot.state?.fen} vs ${expected?.fen}`);
      assertSnap(
        expected ? JSON.stringify(snapshot.state?.movesUci) === JSON.stringify(expected.movesUci) : true,
        "snapshot movesUci",
      );
      snapshotCase.sanitized = {
        containsTopUsername: downloaded.text.includes("MaiaBot-2400"),
        containsBottomUsername: downloaded.text.includes("humanplay-session-user"),
        containsUserUploadUrl: downloaded.text.includes("uploads/v1/user/"),
        containsMemberLink: downloaded.text.includes("/member/"),
        usernamePlaceholders: (snapshot.playersOuterHTML.match(/>user</g) ?? []).length,
      };
      assertSnap(!snapshotCase.sanitized.containsTopUsername, "top username leaked into the snapshot");
      assertSnap(!snapshotCase.sanitized.containsBottomUsername, "bottom username leaked into the snapshot");
      assertSnap(!snapshotCase.sanitized.containsUserUploadUrl, "user upload URL leaked into the snapshot");
      assertSnap(!snapshotCase.sanitized.containsMemberLink, "member link leaked into the snapshot");
      assertSnap(snapshotCase.sanitized.usernamePlaceholders >= 2, "usernames should be replaced by 'user' placeholders");
      assertSnap(snapshot.players?.bottom?.color === "white", `players.bottom.color ${snapshot.players?.bottom?.color}`);

      // Evidence copy for the repo (also the input of the replay self-test below).
      const evidencePath = path.join(args.outDir, "snapshot-recorder.json");
      await writeFile(evidencePath, downloaded.text);
      snapshotCase.evidence = path.relative(REPO_ROOT, evidencePath);
      // Chrome names the file itself when the test redirects downloads (M2 quirk);
      // the *requested* name is what the panel reported.
      snapshotCase.requestedName = /snapshot downloaded as (\S+)/.exec(
        await evaluateInPanel('document.getElementById("cc-snapshot-status").textContent'),
      )?.[1] ?? null;
      console.log(
        snapshotCase.pass
          ? `PASS snapshot-recorder: ${snapshotCase.requestedName ?? "snapshot"} (${downloaded.text.length} bytes, sanitized, evidence ${snapshotCase.evidence})`
          : `FAIL snapshot-recorder: ${snapshotCase.failures.join("; ")}`,
      );
    } catch (error) {
      snapshotCase.pass = false;
      snapshotCase.failures.push(String(error?.message ?? error));
    }
    if (!snapshotCase.pass) for (const failure of snapshotCase.failures) fail(failure, "snapshot-recorder");

    /* -------------------------------------------------- snapshot replays */

    /**
     * Rebuild a snapshot's page (test/fixtures/chesscom/replay.html) and assert
     * the adapter parses it into the recorded state. Used for the replay
     * self-test (the fixture snapshot just recorded above) and for every real
     * user-recorded snapshot in test/fixtures/chesscom-snapshots/.
     */
    const runSnapshotReplay = async (key, { replayUrl, snapshotPath }) => {
      const replayCase = { pass: true, failures: [], recorded: null, parsed: null };
      summary.snapshotReplays[key] = replayCase;
      try {
        const snapshot = JSON.parse(await readFile(snapshotPath, "utf8"));
        const before = await stateCount();
        const { session } = await openPage(`${origin}/chesscom/replay.html?url=${encodeURIComponent(replayUrl)}`);
        await waitFor(
          "snapshot replay page",
          () => evaluateInPage(session, "globalThis.__humanplayReplay && globalThis.__humanplayReplay.ok"),
          { timeoutMs: args.timeoutMs },
        );
        const recorded = snapshot.state ?? {};
        replayCase.recorded = { fen: recorded.fen, movesUci: recorded.movesUci, userColor: recorded.userColor, flipped: recorded.flipped };
        const entry = await latestStateFor("/chesscom/replay.html", { minIndex: before });
        const parsed = entry.state;
        replayCase.parsed = { fen: parsed.fen, movesUci: parsed.movesUci, userColor: parsed.userColor, flipped: parsed.flipped, ok: parsed.ok };
        const assertReplay = (condition, message) => {
          if (!condition) {
            replayCase.pass = false;
            replayCase.failures.push(message);
          }
        };
        assertReplay(parsed.ok === true, `parsed.ok is ${parsed.ok} (${parsed.reason ?? ""})`);
        assertReplay(parsed.fen === recorded.fen, `fen ${parsed.fen} vs recorded ${recorded.fen}`);
        assertReplay(
          JSON.stringify(parsed.movesUci) === JSON.stringify(recorded.movesUci ?? []),
          `movesUci ${JSON.stringify(parsed.movesUci)} vs ${JSON.stringify(recorded.movesUci)}`,
        );
        assertReplay(parsed.userColor === recorded.userColor, `userColor ${parsed.userColor} vs ${recorded.userColor}`);
        assertReplay(parsed.flipped === recorded.flipped, `flipped ${parsed.flipped} vs ${recorded.flipped}`);
        console.log(replayCase.pass ? `PASS snapshot-replay ${key}` : `FAIL snapshot-replay ${key}: ${replayCase.failures.join("; ")}`);
      } catch (error) {
        replayCase.pass = false;
        replayCase.failures.push(String(error?.message ?? error));
        console.log(`FAIL snapshot-replay ${key}: ${error?.message ?? error}`);
      }
      if (!replayCase.pass) for (const failure of replayCase.failures) fail(failure, `snapshot-replay ${key}`);
    };

    // Self-test: the snapshot recorded from the fixture page above must replay
    // into the same state (proves the replay path even before the user records
    // a real chess.com snapshot).
    await runSnapshotReplay("self-test (fixture snapshot)", {
      replayUrl: `/captures/adapter/snapshot-recorder.json`,
      snapshotPath: path.join(args.outDir, "snapshot-recorder.json"),
    });

    const snapshotFiles = existsSync(args.snapshotsDir)
      ? (await readdir(args.snapshotsDir)).filter((name) => name.endsWith(".json") && !name.startsWith(".")).sort()
      : [];
    summary.checks.snapshotReplays = { dir: path.relative(REPO_ROOT, args.snapshotsDir), files: snapshotFiles };
    for (const name of snapshotFiles) {
      await runSnapshotReplay(name, {
        replayUrl: `/chesscom-snapshots/${encodeURIComponent(name)}`,
        snapshotPath: path.join(args.snapshotsDir, name),
      });
    }
    if (snapshotFiles.length === 0) {
      console.log("SKIP snapshot-replay (real): no files in test/fixtures/chesscom-snapshots/ (record one from a real chess.com game with the panel button)");
    }

    /* ------------------------------------------------------------- logs */

    await sleep(500);
    chromeStderrTail = chromeStderr.split("\n").filter(Boolean).slice(-15).join("\n");
    summary.console = {
      panel: logs.panel,
      serviceWorker: logs.serviceWorker,
      pages: logs.pages,
      panelErrors: logs.panel.filter((entry) => entry.bucket === "error" && entry.source !== "network"),
      serviceWorkerErrors: logs.serviceWorker.filter((entry) => entry.bucket === "error"),
      pageErrors: logs.pages.filter((entry) => entry.bucket === "error" && entry.source !== "network"),
      networkErrors: [...logs.panel, ...logs.pages].filter((entry) => entry.bucket === "error" && entry.source === "network"),
    };
    // The adapter's own strategy logging is console.debug and must be present.
    summary.checks.adapterDebugLines = summary.console.pages.filter((entry) => entry.text.includes("[humanplay]")).length;
    summary.checks.extensionConsoleClean =
      summary.console.panelErrors.length === 0 &&
      summary.console.serviceWorkerErrors.length === 0 &&
      summary.console.pageErrors.length === 0;
    if (!summary.checks.extensionConsoleClean) {
      fail("extension console reported errors — see summary.console");
    }

    summary.ok = summary.failures.length === 0;
    await writeFile(path.join(args.outDir, "adapter-proof.json"), `${JSON.stringify(summary, null, 2)}\n`);
    console.log(
      `\n${summary.ok ? "ALL ADAPTER CASES PASSED" : `FAILURES (${summary.failures.length}):\n - ` + summary.failures.join("\n - ")}` +
        `\nproof: ${path.relative(REPO_ROOT, path.join(args.outDir, "adapter-proof.json"))}`,
    );
    if (!summary.ok) process.exitCode = 1;
  } catch (error) {
    console.error(`adapter-proof failed: ${error.message}`);
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
    if (downloadDir) await rm(downloadDir, { recursive: true, force: true });
    if (staticServer) staticServer.close();
    if (chromeStderrTail) console.error(`chrome stderr (tail):\n${chromeStderrTail}`);
  }
}

// Declared outside try/finally use for the finally block; assigned in main's try.
let chromeStderrTail = null;

main();

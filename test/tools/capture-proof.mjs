#!/usr/bin/env node
/**
 * capture-proof.mjs — drive the UNMODIFIED humanplay extension in a real Chrome
 * via the DevTools protocol and report objective evidence.
 *
 * What it checks / produces (all printed as one JSON summary):
 *   - Chrome starts with --load-extension=<extension> and the extension's MV3
 *     service worker registers (target of type service_worker on chrome-extension://).
 *   - chrome.sidePanel.getPanelBehavior() reports openPanelOnActionClick: true
 *     (i.e. the toolbar action opens the side panel).
 *   - the side panel page loads, renders the toggle / capture button / server
 *     chip, and the chip reflects online vs offline.
 *   - the toggle round-trips through chrome.storage.local across a page reload,
 *     and chrome.storage.local contains nothing but settings (no data URLs).
 *   - with --page-url: "Capture now" produces a real PNG frame of that page
 *     (saved to --out) and "Record fixture (PNG)" downloads it through
 *     chrome.downloads into --download-dir.
 *   - console/exception log of the panel + service worker (for the "extension
 *     console is clean" evidence). Network log entries are reported separately
 *     because they are expected when the helper server is not running.
 *
 * IMPORTANT: this is a TEST harness. It never modifies the extension sources.
 *
 * The activeTab problem: chrome.tabs.captureVisibleTab refuses to run without
 * either the activeTab grant (created by a real click on the toolbar icon) or an
 * `<all_urls>` host permission — a narrow host permission such as
 * `http://127.0.0.1:8765/*` is explicitly not enough (see Chromium
 * extensions/common/permissions/permissions_data.cc, CanCaptureVisiblePage with
 * CaptureRequirement::kActiveTabOrAllUrls). A headless test cannot click the
 * toolbar icon, so with --manifest-all-urls the harness loads a temporary COPY of
 * the extension whose manifest adds `<all_urls>`; it then hash-compares every
 * code file against the source tree and reports the result
 * (checks.manifestVariant.codeIdentical). Use this only for automated evidence —
 * the shipped manifest stays narrow, and the real-world flow (click the toolbar
 * icon on the tab you want, which grants activeTab) is the manual check.
 *
 * Usage:
 *   node test/tools/capture-proof.mjs --chrome <path> --extension extension \
 *     [--page-url http://127.0.0.1:8765/pages/startpos.html] \
 *     [--out test/fixtures/captures/startpos-capture.png] \
 *     [--download-dir test/fixtures/captures] \
 *     [--copy-download-to test/fixtures/captures/downloaded-by-extension.png] \
 *     [--panel-shot test/fixtures/captures/panel.png] \
 *     [--expect-chip online|offline] [--manifest-all-urls] [--headful] \
 *     [--keep-profile] [--debug]
 */

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";

/* ------------------------------------------------------------- file walks */

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

/* ------------------------------------------------------------------ args */

function parseArgs(argv) {
  const args = {
    chrome: null,
    extension: "extension",
    pageUrl: null,
    out: null,
    downloadDir: null,
    copyDownloadTo: null,
    panelShot: null,
    expectChip: null,
    headful: false,
    keepProfile: false,
    debug: false,
    manifestAllUrls: false,
    timeoutMs: 45000,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const next = () => argv[++i];
    switch (flag) {
      case "--chrome": args.chrome = next(); break;
      case "--extension": args.extension = next(); break;
      case "--page-url": args.pageUrl = next(); break;
      case "--out": args.out = next(); break;
      case "--download-dir": args.downloadDir = next(); break;
      case "--copy-download-to": args.copyDownloadTo = next(); break;
      case "--panel-shot": args.panelShot = next(); break;
      case "--expect-chip": args.expectChip = next(); break;
      case "--timeout-ms": args.timeoutMs = Number(next()); break;
      case "--headful": args.headful = true; break;
      case "--keep-profile": args.keepProfile = true; break;
      case "--debug": args.debug = true; break;
      case "--manifest-all-urls": args.manifestAllUrls = true; break;
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
    this.closed = false;
    ws.onmessage = (event) => this.#dispatch(JSON.parse(event.data));
    ws.onclose = () => {
      this.closed = true;
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
      throw new Error(`timeout waiting for ${description}${lastError ? ` (last error: ${lastError.message})` : ""}`);
    }
    await sleep(intervalMs);
  }
}

function pngDimensions(buffer) {
  const signature = buffer.subarray(0, 8).toString("hex");
  if (signature !== "89504e470d0a1a0a") throw new Error("not a PNG (bad signature)");
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

function safePngDimensions(buffer) {
  try {
    return pngDimensions(buffer);
  } catch {
    return null;
  }
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

/**
 * Chrome derives the id of an unpacked extension loaded from a directory from
 * the absolute path: sha256(path) -> first 16 bytes hex -> digits 0-f mapped to
 * a-p. We compute it so we can identify OUR extension among the browser's
 * built-in component extensions.
 */
function unpackedExtensionId(absoluteDir) {
  return [...sha256(absoluteDir).slice(0, 32)]
    .map((digit) => String.fromCharCode(97 + parseInt(digit, 16)))
    .join("");
}

/* ------------------------------------------------------------------ main */

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const sourceExtensionDir = path.resolve(args.extension);
  const summary = { chrome: args.chrome, extension: sourceExtensionDir, checks: {}, console: {}, warnings: [] };
  let chromeProcess = null;
  let cdp = null;
  let profileDir = null;
  let variantDir = null;
  const logs = { panel: [], serviceWorker: [] };

  const note = (level, source, text, session) => {
    const bucket = level === "error" ? "errors" : level === "warning" ? "warnings" : "info";
    const target = session === "service-worker" ? logs.serviceWorker : logs.panel;
    target.push({ bucket, level, source, text });
  };

  try {
    const manifestPath = path.join(sourceExtensionDir, "manifest.json");
    const sourceManifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    summary.checks.manifest = {
      path: manifestPath,
      sha256: sha256(readFileSync(manifestPath)),
      version: sourceManifest.version,
      permissions: sourceManifest.permissions,
      host_permissions: sourceManifest.host_permissions,
      side_panel: sourceManifest.side_panel,
    };
    summary.checks.captureSourceSha256 = sha256(
      readFileSync(path.join(sourceExtensionDir, "src/capture/capture-source.js")),
    );

    // Chrome requires activeTab OR <all_urls> for chrome.tabs.captureVisibleTab
    // (extensions/common/permissions/permissions_data.cc, CanCaptureVisiblePage
    // with CaptureRequirement::kActiveTabOrAllUrls) — a narrow host permission is
    // NOT sufficient, and an activeTab grant needs a real toolbar click, which
    // headless automation cannot produce. With --manifest-all-urls we therefore
    // load a temp COPY of the extension whose manifest additionally declares
    // <all_urls>; every code file is hash-compared against the source tree so the
    // report can show that only the manifest differs.
    let extensionDir = sourceExtensionDir;
    let loadedManifest = sourceManifest;
    if (args.manifestAllUrls) {
      variantDir = await mkdtemp(path.join(tmpdir(), "humanplay-extvariant-"));
      await cp(sourceExtensionDir, variantDir, { recursive: true });
      const variantManifestPath = path.join(variantDir, "manifest.json");
      const variantManifest = JSON.parse(readFileSync(variantManifestPath, "utf8"));
      variantManifest.host_permissions = [
        ...new Set([...(variantManifest.host_permissions ?? []), "<all_urls>"]),
      ];
      await writeFile(variantManifestPath, `${JSON.stringify(variantManifest, null, 2)}\n`);
      loadedManifest = variantManifest;

      const sourceFiles = (await walkFiles(sourceExtensionDir)).filter((file) => file !== "manifest.json");
      const mismatches = [];
      for (const file of sourceFiles) {
        const sourceHash = sha256(readFileSync(path.join(sourceExtensionDir, file)));
        const variantHash = sha256(readFileSync(path.join(variantDir, file)));
        if (sourceHash !== variantHash) mismatches.push(file);
      }
      summary.checks.manifestVariant = {
        enabled: true,
        dir: variantDir,
        reason:
          "captureVisibleTab requires activeTab or <all_urls> (see Chromium permissions_data.cc); " +
          "headless cannot click the toolbar icon, so the test loads a copy with <all_urls> added",
        addedHostPermission: "<all_urls>",
        hostPermissions: variantManifest.host_permissions,
        codeFilesCompared: sourceFiles.length,
        codeFileMismatches: mismatches,
        codeIdentical: mismatches.length === 0,
      };
      if (mismatches.length) {
        throw new Error(`manifest variant differs in code files: ${mismatches.join(", ")}`);
      }
      extensionDir = variantDir;
    } else {
      summary.checks.manifestVariant = { enabled: false };
    }

    const extensionId = unpackedExtensionId(extensionDir);
    const serviceWorkerPath = loadedManifest.background?.service_worker;
    if (!serviceWorkerPath) throw new Error("manifest has no background.service_worker");
    summary.checks.extensionId = extensionId;
    summary.checks.expectedServiceWorkerUrl = `chrome-extension://${extensionId}/${serviceWorkerPath}`;

    profileDir = await mkdtemp(path.join(tmpdir(), "humanplay-cdp-"));
    const launchArgs = [
      `--user-data-dir=${profileDir}`,
      "--remote-debugging-port=0",
      `--load-extension=${extensionDir}`,
      `--disable-extensions-except=${extensionDir}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-gpu",
      "--disable-dev-shm-usage",
      "--disable-features=Translate,MediaRouter",
      "--window-size=1100,900",
    ];
    if (!args.headful) launchArgs.unshift("--headless=new");
    launchArgs.push("about:blank");

    chromeProcess = spawn(args.chrome, launchArgs, { stdio: ["ignore", "pipe", "pipe"] });
    let chromeStderr = "";
    chromeProcess.stderr.on("data", (chunk) => {
      chromeStderr += chunk.toString();
    });

    const portFile = path.join(profileDir, "DevToolsActivePort");
    const port = await waitFor(
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
        const response = await fetch(`http://127.0.0.1:${port}/json/version`);
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

    // 1. The extension's MV3 service worker must register. Match strictly on the
    //    path-derived id, otherwise we would pick up Chrome's built-in
    //    component-extension workers (thunk.js, background.js, …).
    const serviceWorker = await waitFor(
      "our extension's service worker target",
      () =>
        [...targets.values()].find(
          (target) =>
            target.type === "service_worker" && target.url === summary.checks.expectedServiceWorkerUrl,
        ),
      { timeoutMs: args.timeoutMs },
    );
    summary.checks.serviceWorkerUrl = serviceWorker.url;

    const swSession = (await cdp.send("Target.attachToTarget", { targetId: serviceWorker.targetId, flatten: true }))
      .sessionId;
    await cdp.send("Runtime.enable", {}, swSession);
    await cdp.send("Log.enable", {}, swSession);
    cdp.on("Runtime.exceptionThrown", (params, sessionId) => {
      const description = params.exceptionDetails?.exception?.description ?? params.exceptionDetails?.text ?? "exception";
      note("error", "javascript", description, sessionId === swSession ? "service-worker" : "panel");
    });
    cdp.on("Runtime.consoleAPICalled", (params, sessionId) => {
      const text = (params.args ?? []).map((arg) => arg.value ?? arg.description ?? arg.type).join(" ");
      note(params.type === "error" ? "error" : params.type === "warning" ? "warning" : "info", "console", text,
        sessionId === swSession ? "service-worker" : "panel");
    });
    cdp.on("Log.entryAdded", ({ entry }, sessionId) => {
      note(
        entry.level === "error" ? "error" : entry.level === "warning" ? "warning" : "info",
        entry.source,
        entry.text + (entry.url ? ` (${entry.url})` : ""),
        sessionId === swSession ? "service-worker" : "panel",
      );
    });

    // 2. Toolbar action opens the side panel (service worker behaviour).
    const panelBehavior = await cdp.send(
      "Runtime.evaluate",
      {
        expression: "(async () => await chrome.sidePanel.getPanelBehavior())()",
        awaitPromise: true,
        returnByValue: true,
      },
      swSession,
    );
    summary.checks.panelBehavior = panelBehavior.result.value;

    // 3. Open the side panel page (the exact document the side panel renders).
    const panelTarget = await cdp.send("Target.createTarget", {
      url: `chrome-extension://${extensionId}/src/ui/sidepanel.html`,
    });
    const panelSession = (await cdp.send("Target.attachToTarget", { targetId: panelTarget.targetId, flatten: true }))
      .sessionId;
    await cdp.send("Page.enable", {}, panelSession);
    await cdp.send("Runtime.enable", {}, panelSession);
    await cdp.send("Log.enable", {}, panelSession);
    if (args.debug) {
      cdp.on("Page.frameNavigated", ({ frame }, sessionId) => {
        if (sessionId === panelSession) console.error(`[debug] panel frameNavigated: ${frame.url}`);
      });
      await sleep(500);
      const early = await cdp.send(
        "Runtime.evaluate",
        { expression: "({href: location.href, ready: document.readyState, divs: document.querySelectorAll('div').length})", returnByValue: true },
        panelSession,
      );
      console.error(`[debug] panel early state: ${JSON.stringify(early.result?.value)}`);
      const info = await cdp.send("Target.getTargetInfo", { targetId: panelTarget.targetId });
      console.error(`[debug] panel targetInfo: ${JSON.stringify(info.targetInfo)}`);
    }

    const evaluate = (expression, opts = {}) =>
      cdp
        .send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true, ...opts }, panelSession)
        .then((result) => {
          if (result.exceptionDetails) {
            throw new Error(
              `page evaluation failed: ${result.exceptionDetails.exception?.description ?? result.exceptionDetails.text}`,
            );
          }
          return result.result.value;
        });

    const waitInPanel = (condition, description, timeoutMs = 15000) =>
      evaluate(
        `new Promise((resolve, reject) => {
           const deadline = Date.now() + ${timeoutMs};
           const tick = () => {
             let value = null;
             try { value = (${condition}); } catch (error) { return reject(error); }
             if (value) return resolve(value);
             if (Date.now() > deadline) return reject(new Error(${JSON.stringify(`timeout: ${description}`)}));
             setTimeout(tick, 100);
           };
           tick();
         })`,
      );

    await waitInPanel('document.readyState === "complete"', "panel load");
    await waitInPanel('!!document.getElementById("capture-button")', "panel module init");

    // 4. UI present: toggle, capture button, server chip.
    summary.checks.ui = await evaluate(`(() => {
      const ids = ["assistant-toggle", "capture-button", "record-button", "server-chip", "refresh-health"];
      const present = {};
      for (const id of ids) present[id] = !!document.getElementById(id);
      return {
        present,
        title: document.title,
        scripts: [...document.scripts].map((s) => s.src.split("/").pop()),
        inlineScripts: [...document.scripts].filter((s) => !s.src).length,
      };
    })()`);

    // 5. Server status chip (wait until it left the "checking…" state).
    const chip = await waitInPanel(
      `document.getElementById("server-chip").textContent !== "checking…" && {
         text: document.getElementById("server-chip").textContent,
         className: document.getElementById("server-chip").className,
         title: document.getElementById("server-chip").title,
       }`,
      "server chip to settle",
    );
    summary.checks.chip = chip;
    if (args.expectChip === "online" && !chip.className.includes("chip-online")) {
      throw new Error(`expected the chip to be online, got: ${JSON.stringify(chip)}`);
    }
    if (args.expectChip === "offline" && !chip.className.includes("chip-offline")) {
      throw new Error(`expected the chip to be offline, got: ${JSON.stringify(chip)}`);
    }

    // 6. Panel console / CSP errors so far.
    summary.checks.panelErrorsBeforeCapture = (logs.panel.filter((entry) => entry.bucket === "errors") ?? []).length;

    // 7. Optional: end-to-end capture of --page-url + fixture recording.
    if (args.pageUrl) {
      const pageTarget = await cdp.send("Target.createTarget", { url: args.pageUrl });
      const pageSession = (await cdp.send("Target.attachToTarget", { targetId: pageTarget.targetId, flatten: true }))
        .sessionId;
      await cdp.send("Runtime.enable", {}, pageSession);
      await waitFor(
        "fixture page load",
        async () => {
          const state = await cdp.send(
            "Runtime.evaluate",
            { expression: "document.readyState", returnByValue: true },
            pageSession,
          );
          return state.result.value === "complete";
        },
        { timeoutMs: args.timeoutMs },
      );
      await cdp.send("Target.activateTarget", { targetId: pageTarget.targetId });
      await sleep(400); // let the compositor paint the newly activated tab

      await evaluate('document.getElementById("capture-button").click(), true');
      const frame = await waitInPanel(
        `(() => {
           const img = document.getElementById("frame-preview");
           const error = document.getElementById("error");
           const errorText = error.hidden ? null : error.textContent;
           if (img.src.startsWith("data:image/png")) {
             return {
               dataUrl: img.src,
               meta: document.getElementById("frame-meta").textContent,
               error: errorText,
             };
           }
           return errorText ? { dataUrl: null, meta: null, error: errorText } : null;
         })()`,
        "captured frame preview",
        args.timeoutMs,
      );
      if (!frame.dataUrl) {
        throw new Error(`capture failed in the panel: ${frame.error}`);
      }
      summary.checks.captureError = frame.error;
      const png = Buffer.from(frame.dataUrl.split(",")[1], "base64");
      const dimensions = pngDimensions(png);
      summary.checks.capture = {
        meta: frame.meta,
        bytes: png.length,
        ...dimensions,
        loadedInPage: await evaluate(
          '(() => { const i = document.getElementById("frame-preview"); return { complete: i.complete, natural: [i.naturalWidth, i.naturalHeight] }; })()',
        ),
      };
      if (args.out) {
        await mkdir(path.dirname(path.resolve(args.out)), { recursive: true });
        await writeFile(path.resolve(args.out), png);
        summary.checks.capture.savedTo = path.resolve(args.out);
      }

      // Fixture recorder -> chrome.downloads.download. Without --download-dir the
      // download goes to Chrome's normal folder — the honest/real behaviour, where
      // the extension asks for "humanplay-<timestamp>.png". --download-dir
      // redirects downloads via CDP, which makes Chrome write a generic
      // "download.png" that the harness renames back to the requested name.
      const downloadDir = args.downloadDir ? path.resolve(args.downloadDir) : null;
      if (downloadDir) {
        await mkdir(downloadDir, { recursive: true });
        await cdp.send("Browser.setDownloadBehavior", {
          behavior: "allow",
          downloadPath: downloadDir,
          eventsEnabled: true,
        });
      }

      const listingExpression = `(async () => (await chrome.downloads.search({ orderBy: ["-startTime"], limit: 5 })).map((entry) => ({
         id: entry.id, filename: entry.filename, state: entry.state, error: entry.error, exists: entry.exists,
         bytesReceived: entry.bytesReceived, totalBytes: entry.totalBytes, mime: entry.mime,
         urlPrefix: (entry.url || "").slice(0, 32),
       })))()`;
      const beforeRecords = await evaluate(listingExpression);
      const beforeMaxId = Math.max(0, ...beforeRecords.map((entry) => entry.id));

      await evaluate('document.getElementById("record-button").click(), true');
      const record = await waitFor(
        "the fixture download to complete",
        async () => {
          const records = await evaluate(listingExpression);
          const newest = records
            .filter((entry) => entry.id > beforeMaxId)
            .sort((a, b) => b.id - a.id)[0];
          if (!newest || newest.state === "in_progress") return null;
          if (newest.state !== "complete") {
            throw new Error(`download ${newest.id} ended in state ${newest.state} (${newest.error})`);
          }
          return newest;
        },
        { timeoutMs: args.timeoutMs },
      );
      await sleep(300); // let Chrome flush the file to disk

      const recordState = await evaluate(
        `(() => ({
           meta: document.getElementById("frame-meta").textContent,
           error: document.getElementById("error").hidden ? null : document.getElementById("error").textContent,
         }))()`,
      );
      const requestedName = /recorded as (\S+\.png)/.exec(recordState.meta ?? "")?.[1] ?? null;

      let evidencePath = record.filename;
      let renamedFrom = null;
      let bytes = existsSync(record.filename) ? await readFile(record.filename) : null;
      if (downloadDir && requestedName && path.basename(record.filename) !== requestedName) {
        evidencePath = path.join(downloadDir, requestedName);
        await rm(evidencePath, { force: true });
        await rename(record.filename, evidencePath);
        renamedFrom = path.basename(record.filename);
        bytes = await readFile(evidencePath);
      }
      let copyTarget = null;
      if (args.copyDownloadTo && bytes) {
        copyTarget = path.resolve(args.copyDownloadTo);
        await mkdir(path.dirname(copyTarget), { recursive: true });
        await writeFile(copyTarget, bytes);
      }

      summary.checks.recordedFixture = {
        requestedName,
        chromeFilename: record.filename,
        file: evidencePath,
        renamedFrom,
        copiedTo: copyTarget,
        state: record.state,
        mime: record.mime,
        bytes: bytes ? bytes.length : null,
        dimensions: bytes ? safePngDimensions(bytes) : null,
        matchesCapturedFrame: bytes ? bytes.equals(png) : null,
        panelState: recordState,
      };
    }

    // 8. Toggle persistence across a reload + storage hygiene.
    const toggleClick = `document.getElementById("assistant-toggle").click(), true`;
    const toggleState = `(() => {
      const toggle = document.getElementById("assistant-toggle");
      const stored = globalThis.__stored;
      return { checked: toggle.checked, label: document.getElementById("toggle-state").textContent };
    })()`;
    const readStored = `(async () => await chrome.storage.local.get(null))()`;
    const beforeStored = await evaluate(readStored);
    await evaluate(toggleClick);
    const toggled = await evaluate(toggleState);
    const storedAfterToggle = await evaluate(readStored);
    await cdp.send("Page.reload", {}, panelSession);
    await waitInPanel('document.readyState === "complete" && !document.getElementById("capture-button").disabled', "panel reload");
    await sleep(250); // give init() a moment to read storage
    const afterReload = await evaluate(toggleState);
    await evaluate(toggleClick); // restore the previous value
    const restored = await evaluate(toggleState);
    summary.checks.toggle = {
      initial: beforeStored?.settings?.assistantEnabled,
      afterClick: toggled,
      storedAfterClick: storedAfterToggle,
      afterReload,
      restored,
      persistedAcrossReload: afterReload.checked === toggled.checked,
      storageKeys: Object.keys(storedAfterToggle ?? {}),
    };

    // 9. Panel visual (optional): size the emulated viewport like a real side
    //    panel and screenshot the page, then clear the override.
    if (args.panelShot) {
      await cdp.send(
        "Emulation.setDeviceMetricsOverride",
        { width: 380, height: 760, deviceScaleFactor: 2, mobile: false },
        panelSession,
      );
      await sleep(300);
      const shot = await cdp.send("Page.captureScreenshot", { format: "png" }, panelSession);
      await cdp.send("Emulation.clearDeviceMetricsOverride", {}, panelSession);
      await mkdir(path.dirname(path.resolve(args.panelShot)), { recursive: true });
      await writeFile(path.resolve(args.panelShot), Buffer.from(shot.data, "base64"));
      summary.checks.panelShot = path.resolve(args.panelShot);
    }

    await sleep(400); // collect trailing log entries

    summary.console = {
      panel: logs.panel,
      serviceWorker: logs.serviceWorker,
      panelErrors: logs.panel.filter((entry) => entry.bucket === "errors" && entry.source !== "network"),
      panelNetworkErrors: logs.panel.filter((entry) => entry.bucket === "errors" && entry.source === "network"),
      serviceWorkerErrors: logs.serviceWorker.filter((entry) => entry.bucket === "errors"),
    };
    summary.checks.extensionConsoleClean =
      summary.console.panelErrors.length === 0 && summary.console.serviceWorkerErrors.length === 0;

    if (!summary.checks.extensionConsoleClean) {
      summary.warnings.push("extension console reported errors — see summary.console");
    }

    console.log(JSON.stringify(summary, null, 2));
    if (!summary.checks.extensionConsoleClean) process.exitCode = 1;
  } catch (error) {
    console.error(`capture-proof failed: ${error.message}`);
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
  }
}

main();

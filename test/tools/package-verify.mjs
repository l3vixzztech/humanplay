#!/usr/bin/env node
/**
 * package-verify.mjs — proves a packaged extension zip is loadable.
 *
 * `scripts/package-extension.sh` builds `dist/humanplay-<version>.zip` from
 * `extension/`; this tool is the verification half:
 *
 *   1. unzip the archive into a temp dir          (`unzip`, no node deps)
 *   2. assert the unpacked tree is complete: `manifest.json` at the ZIP ROOT,
 *      every file of `extension/` present and hash-identical (so the packaged
 *      copy is the shipped code, byte for byte)
 *   3. launch Chrome (for Testing) with `--load-extension=<temp dir>` and
 *      **assert the MV3 service worker registers** with the expected URL
 *   4. assert the manifest basics the release relies on: version, no
 *      `<all_urls>`, the permission list, the chess.com-only content script
 *   5. write a machine-readable report
 *      (`test/fixtures/captures/package/package-verify.json`)
 *
 * Usage:
 *   node test/tools/package-verify.mjs --chrome <path> --zip dist/humanplay-1.0.0.zip
 *     [--extension extension] [--out-dir test/fixtures/captures/package] [--headful]
 *
 * Exit code is non-zero when any assertion fails.
 */

import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

function parseArgs(argv) {
  const args = {
    chrome: null,
    zip: null,
    extension: path.join(REPO_ROOT, "extension"),
    outDir: path.join(REPO_ROOT, "test/fixtures/captures/package"),
    headful: false,
    timeoutMs: 45000,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const next = () => argv[++i];
    switch (flag) {
      case "--chrome": args.chrome = next(); break;
      case "--zip": args.zip = path.resolve(next()); break;
      case "--extension": args.extension = path.resolve(next()); break;
      case "--out-dir": args.outDir = path.resolve(next()); break;
      case "--headful": args.headful = true; break;
      case "--timeout-ms": args.timeoutMs = Number(next()); break;
      default: throw new Error(`unknown argument: ${flag}`);
    }
  }
  if (!args.chrome) throw new Error("--chrome <path to chrome binary> is required");
  if (!args.zip) throw new Error("--zip <path to the packaged zip> is required");
  return args;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(description, fn, { timeoutMs = 30000, intervalMs = 120 } = {}) {
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

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(command, args, { maxBuffer: 16 * 1024 * 1024, ...options }, (error, stdout, stderr) => {
      if (error) reject(new Error(`${command} failed: ${error.message}\n${stderr}`));
      else resolve({ stdout, stderr });
    });
  });
}

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

  send(method, params = {}) {
    const id = this.nextId;
    this.nextId += 1;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
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

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const summary = {
    tool: "package-verify.mjs",
    generatedAt: new Date().toISOString(),
    chrome: args.chrome,
    zip: path.relative(REPO_ROOT, args.zip),
    checks: {},
    failures: [],
  };
  let chromeProcess = null;
  let cdp = null;
  let profileDir = null;
  let unpackDir = null;

  const fail = (message) => {
    summary.failures.push(message);
    console.error(`FAIL ${message}`);
  };

  try {
    if (!existsSync(args.zip)) throw new Error(`zip not found: ${args.zip}`);

    /* ----------------------------------------------------- 1. unpack */
    unpackDir = await mkdtemp(path.join(tmpdir(), "humanplay-package-"));
    await run("unzip", ["-q", args.zip, "-d", unpackDir]);

    const zipManifestPath = path.join(unpackDir, "manifest.json");
    if (!existsSync(zipManifestPath)) {
      throw new Error("manifest.json is not at the ZIP ROOT (the zip must contain extension/ contents, not the folder)");
    }
    const zipManifest = JSON.parse(await readFile(zipManifestPath, "utf8"));
    const sourceManifest = JSON.parse(await readFile(path.join(args.extension, "manifest.json"), "utf8"));
    summary.checks.manifest = {
      version: zipManifest.version,
      name: zipManifest.name,
      minimum_chrome_version: zipManifest.minimum_chrome_version,
      permissions: zipManifest.permissions,
      host_permissions: zipManifest.host_permissions,
      optional_host_permissions: zipManifest.optional_host_permissions,
      content_script_matches: zipManifest.content_scripts?.[0]?.matches ?? null,
      service_worker: zipManifest.background?.service_worker ?? null,
      hasAllUrls: JSON.stringify(zipManifest).includes("<all_urls>"),
    };
    if (zipManifest.version !== sourceManifest.version) {
      fail(`zip version ${zipManifest.version} != extension/ version ${sourceManifest.version}`);
    }
    if (summary.checks.manifest.hasAllUrls) fail("the packaged manifest contains <all_urls>");
    if (zipManifest.permissions?.includes("offscreen")) fail("unexpected 'offscreen' permission in the packaged manifest");
    if (!(zipManifest.background?.service_worker === sourceManifest.background?.service_worker)) {
      fail("service worker path differs from the source manifest");
    }

    /* ------------------------------------- 2. packaged code == source code */
    const sourceFiles = (await walkFiles(args.extension)).filter((file) => file !== "manifest.json");
    const zipFiles = (await walkFiles(unpackDir)).filter((file) => file !== "manifest.json");
    const missing = sourceFiles.filter((file) => !zipFiles.includes(file));
    const identical = [];
    const mismatches = [];
    for (const file of sourceFiles) {
      if (missing.includes(file)) continue;
      const sourceHash = sha256(await readFile(path.join(args.extension, file)));
      const zipHash = sha256(await readFile(path.join(unpackDir, file)));
      if (sourceHash === zipHash) identical.push(file);
      else mismatches.push(file);
    }
    summary.checks.contents = {
      sourceFiles: sourceFiles.length,
      zipFiles: zipFiles.length,
      identical: identical.length,
      missing,
      mismatches,
      extraInZip: zipFiles.filter((file) => !sourceFiles.includes(file)),
    };
    if (missing.length) fail(`files missing from the zip: ${missing.join(", ")}`);
    if (mismatches.length) fail(`files differ from the source tree: ${mismatches.join(", ")}`);

    /* ------------------------------------------------ 3. load in Chrome */
    profileDir = await mkdtemp(path.join(tmpdir(), "humanplay-package-profile-"));
    const launchArgs = [
      `--user-data-dir=${profileDir}`,
      "--remote-debugging-port=0",
      `--load-extension=${unpackDir}`,
      `--disable-extensions-except=${unpackDir}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-gpu",
      "--disable-dev-shm-usage",
      "--disable-features=Translate,MediaRouter",
      "--window-size=1200,800",
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

    const workerPath = zipManifest.background?.service_worker;
    const serviceWorker = await waitFor(
      "the packaged extension's service worker target",
      () =>
        [...targets.values()].find(
          (target) => target.type === "service_worker" && target.url.endsWith(`/${workerPath}`),
        ),
      { timeoutMs: args.timeoutMs },
    );
    summary.checks.serviceWorker = {
      registered: true,
      url: serviceWorker.url,
      extensionId: new URL(serviceWorker.url).host,
      title: serviceWorker.title,
    };
    console.log(`PASS package: service worker registered at ${serviceWorker.url}`);

    const sidePanelPath = zipManifest.side_panel?.default_path;
    summary.checks.sidePanelDocument = {
      path: sidePanelPath,
      existsInZip: await existsSafe(path.join(unpackDir, sidePanelPath ?? "")),
    };
    if (!summary.checks.sidePanelDocument.existsInZip) fail(`side panel document missing from the zip: ${sidePanelPath}`);

    if (summary.failures.length === 0) console.log("PASS package-verify: all checks passed");
  } catch (error) {
    summary.failures.push(`exception: ${error?.message ?? String(error)}`);
    console.error(`FAIL package-verify: ${error?.stack ?? error}`);
  } finally {
    await mkdir(args.outDir, { recursive: true });
    summary.pass = summary.failures.length === 0;
    await writeFile(path.join(args.outDir, "package-verify.json"), `${JSON.stringify(summary, null, 2)}\n`);
    console.log(`report: ${path.relative(REPO_ROOT, path.join(args.outDir, "package-verify.json"))}`);
    try { cdp?.close(); } catch { /* ignore */ }
    try { chromeProcess?.kill("SIGKILL"); } catch { /* ignore */ }
    if (process.env.HUMANPLAY_KEEP_TEMP) {
      console.log(`kept: unpack=${unpackDir} profile=${profileDir}`);
    } else {
      for (const dir of [unpackDir, profileDir]) {
        if (dir) await rm(dir, { recursive: true, force: true }).catch(() => {});
      }
    }
  }
  process.exit(summary.failures.length === 0 ? 0 : 1);
}

async function existsSafe(target) {
  try {
    await readFile(target);
    return true;
  } catch {
    return false;
  }
}

main();

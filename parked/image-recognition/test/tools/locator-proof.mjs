#!/usr/bin/env node
/**
 * locator-proof.mjs — objective proof for the M3 board locator.
 *
 * For every offline fixture page (test/fixtures/pages/*.html) at several
 * viewport/DPR combinations it:
 *   1. opens the page in Chrome for Testing (CDP),
 *   2. reads the board's DOM ground truth — the 8x8 play area derived from the
 *      python-chess SVG square rects via `getScreenCTM()` (allowed in tests
 *      only; the runtime pipeline never touches the DOM),
 *   3. screenshots the viewport, decodes it to RGBA **in the page**,
 *   4. runs the real `extension/src/board/locator.js` (injected as a data: URL
 *      module, identical file, hash recorded in the proof) on those pixels,
 *   5. asserts the detected rect against the ground truth (<=4 px; <=6 px at
 *      scaled viewports) and writes an overlay PNG (detected grid in red,
 *      ground truth in green) plus a proof JSON per case into
 *      test/fixtures/captures/locator/.
 *
 * `--image <png>` analyses a standalone capture instead (used for real-site
 * frames): no ground truth, no tolerance, just the result + overlay.
 *
 * Exit code is non-zero when any fixture case fails.
 *
 * Usage:
 *   node test/tools/locator-proof.mjs --chrome <path> \
 *     [--out-dir test/fixtures/captures/locator] [--pages-dir test/fixtures/pages] \
 *     [--image test/fixtures/captures/real/lichess.png] [--headful] [--keep-profile]
 */

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
    pagesDir: path.join(REPO_ROOT, "test/fixtures/pages"),
    outDir: path.join(REPO_ROOT, "test/fixtures/captures/locator"),
    images: [],
    saveFrames: false,
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
      case "--pages-dir": args.pagesDir = path.resolve(next()); break;
      case "--out-dir": args.outDir = path.resolve(next()); break;
      case "--image": args.images.push(path.resolve(next())); break;
      case "--save-frames": args.saveFrames = true; break;
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

/* ---------------------------------------------------------------- in-page */

/**
 * Expression run in the worker target: decode a PNG data URL into RGBA, run the
 * real locator module, optionally draw an overlay (detected grid + ground
 * truth), return everything the proof needs.
 */
function analysisExpression(moduleUrl, imageDataUrl, groundTruth) {
  return `(async () => {
    const locate = await import(${JSON.stringify(moduleUrl)});
    const img = new Image();
    await new Promise((resolve, reject) => {
      img.onload = resolve;
      img.onerror = () => reject(new Error("image decode failed"));
      img.src = ${JSON.stringify(imageDataUrl)};
    });
    const canvas = document.createElement("canvas");
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(img, 0, 0);
    const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const frame = { data: imageData.data, width: canvas.width, height: canvas.height };
    const t0 = performance.now();
    const result = locate.locateBoard(frame);
    const ms = performance.now() - t0;
    const result2 = locate.locateBoard(frame);
    const deterministic =
      JSON.stringify(result) === JSON.stringify(result2);
    const gt = ${JSON.stringify(groundTruth ?? null)};

    // Overlay: detected 8x8 grid in red, ground truth play area in green.
    const lineWidth = Math.max(2, Math.round(Math.min(canvas.width, canvas.height) / 400));
    ctx.lineWidth = lineWidth;
    ctx.strokeStyle = "rgba(255, 45, 85, 0.95)";
    const squares = result.ok ? locate.squaresForRect(result.rect) : [];
    for (const s of squares) {
      ctx.strokeRect(s.x + lineWidth / 2, s.y + lineWidth / 2, s.w - lineWidth, s.h - lineWidth);
    }
    if (result.ok) {
      ctx.strokeStyle = "#00e5ff";
      ctx.lineWidth = lineWidth;
      ctx.strokeRect(result.rect.x, result.rect.y, result.rect.w, result.rect.h);
    }
    if (gt) {
      ctx.strokeStyle = "rgba(0, 220, 90, 0.95)";
      ctx.lineWidth = lineWidth;
      ctx.strokeRect(gt.x, gt.y, gt.w, gt.h);
    }
    const label = result.ok
      ? "detected " + result.method + " conf " + result.confidence.toFixed(2)
      : "REJECTED";
    ctx.font = Math.max(14, Math.round(canvas.width / 45)) + "px monospace";
    ctx.fillStyle = "rgba(0,0,0,0.65)";
    const textWidth = ctx.measureText(label).width;
    ctx.fillRect(0, 0, textWidth + 16, ctx.font.match(/\\d+/)[0] * 1.7);
    ctx.fillStyle = "#fff";
    ctx.fillText(label, 8, ctx.font.match(/\\d+/)[0] * 1.25);
    const overlay = canvas.toDataURL("image/png");
    return {
      result,
      ms,
      deterministic,
      width: canvas.width,
      height: canvas.height,
      overlayBase64: overlay.split(",")[1],
    };
  })()`;
}

/* ------------------------------------------------------------------ main */

const VIEWPORTS = [
  { name: "1100x757@1", width: 1100, height: 757, dpr: 1, tolerance: 4 },
  { name: "800x900@2", width: 800, height: 900, dpr: 2, tolerance: 6 },
  { name: "640x700@1", width: 640, height: 700, dpr: 1, tolerance: 4 },
  { name: "900x700@0.75", width: 900, height: 700, dpr: 0.75, tolerance: 6 },
];

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const locatorPath = path.join(args.extension, "src/board/locator.js");
  const locatorSource = readFileSync(locatorPath, "utf8");
  const moduleUrl = `data:text/javascript;base64,${Buffer.from(locatorSource).toString("base64")}`;

  const summary = {
    tool: "locator-proof.mjs",
    generatedAt: new Date().toISOString(),
    chrome: args.chrome,
    locator: {
      path: path.relative(REPO_ROOT, locatorPath),
      sha256: sha256(locatorSource),
      bytes: Buffer.byteLength(locatorSource),
    },
    cases: {},
    failures: [],
    browser: null,
  };
  let chromeProcess = null;
  let cdp = null;
  let profileDir = null;
  const pages = existsSync(args.pagesDir)
    ? (await readdirSafe(args.pagesDir)).filter((f) => f.endsWith(".html") && f !== "index.html")
    : [];
  if (args.images.length === 0 && pages.length === 0) {
    throw new Error(`no fixture pages found in ${args.pagesDir}`);
  }

  try {
    profileDir = await mkdtemp(path.join(tmpdir(), "humanplay-locator-"));
    const launchArgs = [
      `--user-data-dir=${profileDir}`,
      "--remote-debugging-port=0",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-gpu",
      "--disable-dev-shm-usage",
      "--disable-features=Translate,MediaRouter",
      "--allow-file-access-from-files",
      "--hide-scrollbars",
    ];
    if (!args.headful) launchArgs.unshift("--headless=new");
    launchArgs.push("about:blank");
    chromeProcess = spawn(args.chrome, launchArgs, { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    chromeProcess.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
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
    summary.browser = { version: versionInfo.Browser, protocolVersion: versionInfo["Protocol-Version"] };
    cdp = await CDP.connect(versionInfo.webSocketDebuggerUrl);

    // Worker target: plain page used for decode + locate + overlay.
    const workerTarget = await cdp.send("Target.createTarget", { url: "about:blank" });
    const workerSession = (await cdp.send("Target.attachToTarget", {
      targetId: workerTarget.targetId,
      flatten: true,
    })).sessionId;
    await cdp.send("Runtime.enable", {}, workerSession);

    const evaluateInWorker = async (expression) => {
      const result = await cdp.send(
        "Runtime.evaluate",
        { expression, awaitPromise: true, returnByValue: true },
        workerSession,
      );
      if (result.exceptionDetails) {
        throw new Error(
          `worker evaluation failed: ${result.exceptionDetails.exception?.description ?? result.exceptionDetails.text}`,
        );
      }
      return result.result.value;
    };

    const runCase = async ({ name, imageDataUrl, groundTruth, tolerance, fileForOverlay, extra = {} }) => {
      const analysis = await evaluateInWorker(
        analysisExpression(moduleUrl, imageDataUrl, groundTruth),
      );
      const record = {
        image: { width: analysis.width, height: analysis.height },
        groundTruth: groundTruth ?? null,
        result: analysis.result,
        locateMs: Number(analysis.ms.toFixed(2)),
        deterministic: analysis.deterministic,
        overlay: null,
        errors: null,
        tolerance,
        pass: true,
        failure: null,
      };
      if (groundTruth) {
        const r = analysis.result.rect;
        const edges = {
          left: r.x - groundTruth.x,
          top: r.y - groundTruth.y,
          right: r.x + r.w - (groundTruth.x + groundTruth.w),
          bottom: r.y + r.h - (groundTruth.y + groundTruth.h),
          width: r.w - groundTruth.w,
          height: r.h - groundTruth.h,
        };
        record.errors = {
          ...Object.fromEntries(Object.entries(edges).map(([k, v]) => [k, Number(v.toFixed(2))])),
          maxEdge: Number(
            Math.max(...Object.values(edges).map((v) => Math.abs(v))).toFixed(2),
          ),
        };
        if (!analysis.result.ok) {
          record.pass = false;
          record.failure = `expected a board but the locator rejected the frame: ${analysis.result.reason}`;
        } else if (record.errors.maxEdge > tolerance) {
          record.pass = false;
          record.failure = `max edge error ${record.errors.maxEdge}px > ${tolerance}px tolerance`;
        }
      } else if (!analysis.result.ok) {
        // image mode: record the rejection but do not fail the run
        record.failure = analysis.result.reason;
      }
      const overlayName = fileForOverlay;
      const overlayPath = path.join(args.outDir, overlayName);
      await mkdir(args.outDir, { recursive: true });
      await writeFile(overlayPath, Buffer.from(analysis.overlayBase64, "base64"));
      record.overlay = path.relative(REPO_ROOT, overlayPath);
      if (args.saveFrames) {
        const framePath = overlayPath.replace(/\.png$/, "-frame.png");
        await writeFile(framePath, Buffer.from(imageDataUrl.split(",")[1], "base64"));
        record.frame = path.relative(REPO_ROOT, framePath);
      }
      Object.assign(record, extra);
      await writeFile(
        overlayPath.replace(/\.png$/, "-proof.json"),
        `${JSON.stringify({ name, ...record }, null, 2)}\n`,
      );
      return record;
    };

    if (args.images.length > 0) {
      for (const imagePath of args.images) {
        const bytes = await readFile(imagePath);
        const imageDataUrl = `data:image/png;base64,${bytes.toString("base64")}`;
        const slug = path.basename(imagePath, ".png");
        process.stdout.write(`${slug}: `);
        const record = await runCase({
          name: `image:${path.relative(REPO_ROOT, imagePath)}`,
          imageDataUrl,
          groundTruth: null,
          tolerance: null,
          fileForOverlay: `${slug}-locator-overlay.png`,
        });
        summary.cases[`image:${slug}`] = record;
        console.log(
          record.result.ok
            ? `found ${record.result.method} conf ${record.result.confidence.toFixed(2)} ` +
                `square ${record.result.squareSize.toFixed(1)}px at ` +
                `(${Math.round(record.result.rect.x)}, ${Math.round(record.result.rect.y)}) ` +
                `${record.locateMs}ms`
            : `REJECTED: ${record.result.reason}`,
        );
      }
      summary.failures = Object.entries(summary.cases)
        .filter(([, c]) => c.failure)
        .map(([k]) => k);
    } else {
      const pageTarget = await cdp.send("Target.createTarget", { url: "about:blank" });
      const pageSession = (await cdp.send("Target.attachToTarget", {
        targetId: pageTarget.targetId,
        flatten: true,
      })).sessionId;
      await cdp.send("Page.enable", {}, pageSession);
      await cdp.send("Runtime.enable", {}, pageSession);

      const evaluateInPage = async (expression) => {
        const result = await cdp.send(
          "Runtime.evaluate",
          { expression, awaitPromise: true, returnByValue: true },
          pageSession,
        );
        if (result.exceptionDetails) {
          throw new Error(
            `page evaluation failed: ${result.exceptionDetails.exception?.description ?? result.exceptionDetails.text}`,
          );
        }
        return result.result.value;
      };

      for (const page of pages) {
        const slug = path.basename(page, ".html");
        const pageUrl = `file://${path.join(args.pagesDir, page)}`;
        summary.cases[slug] = {};
        for (const viewport of VIEWPORTS) {
          const caseName = `${slug}@${viewport.name}`;
          await cdp.send("Page.navigate", { url: pageUrl }, pageSession);
          await waitFor(
            "page load",
            () => evaluateInPage('document.readyState === "complete"'),
            { timeoutMs: args.timeoutMs },
          );
          await cdp.send(
            "Emulation.setDeviceMetricsOverride",
            {
              width: viewport.width,
              height: viewport.height,
              deviceScaleFactor: viewport.dpr,
              mobile: false,
            },
            pageSession,
          );
          await evaluateInPage("window.scrollTo(0, 0), true");
          await sleep(150);

          const groundTruthCss = await evaluateInPage(`(() => {
            const svg = document.querySelector(".board svg");
            if (!svg) return null;
            const ctm = svg.getScreenCTM();
            const p0 = new DOMPoint(15, 15).matrixTransform(ctm);
            const p1 = new DOMPoint(375, 375).matrixTransform(ctm);
            const svgRect = svg.getBoundingClientRect();
            return {
              x: Math.min(p0.x, p1.x), y: Math.min(p0.y, p1.y),
              w: Math.abs(p1.x - p0.x), h: Math.abs(p1.y - p0.y),
              svg: { x: svgRect.x, y: svgRect.y, w: svgRect.width, h: svgRect.height },
              viewport: { w: innerWidth, h: innerHeight, dpr: devicePixelRatio },
            };
          })()`);
          if (!groundTruthCss) throw new Error(`${page} has no .board svg to ground-truth`);
          const dpr = viewport.dpr;
          const groundTruth = {
            x: groundTruthCss.x * dpr,
            y: groundTruthCss.y * dpr,
            w: groundTruthCss.w * dpr,
            h: groundTruthCss.h * dpr,
          };
          const inViewport =
            groundTruthCss.x >= 0 &&
            groundTruthCss.y >= 0 &&
            groundTruthCss.x + groundTruthCss.w <= groundTruthCss.viewport.w &&
            groundTruthCss.y + groundTruthCss.h <= groundTruthCss.viewport.h;

          const shot = await cdp.send(
            "Page.captureScreenshot",
            { format: "png", captureBeyondViewport: false },
            pageSession,
          );
          process.stdout.write(`${caseName}: `);
          const record = await runCase({
            name: caseName,
            imageDataUrl: `data:image/png;base64,${shot.data}`,
            groundTruth,
            tolerance: viewport.tolerance,
            fileForOverlay: `${caseName.replace("@", "-")}-overlay.png`,
            extra: {
              groundTruthCss,
              groundTruthVisible: inViewport,
              viewport: { width: viewport.width, height: viewport.height, dpr },
            },
          });
          if (groundTruthCss.viewport.w !== viewport.width || groundTruthCss.viewport.dpr !== dpr) {
            record.actualViewport = groundTruthCss.viewport;
          }
          if (!inViewport) {
            record.pass = false;
            record.failure = "ground truth board is not fully inside the screenshot";
          }
          summary.cases[slug][viewport.name] = record;
          console.log(
            record.pass
              ? `PASS  err ${record.errors?.maxEdge ?? "n/a"}px  ` +
                  `conf ${record.result.confidence?.toFixed(2)}  ${record.locateMs}ms`
              : `FAIL  ${record.failure}`,
          );
          if (!record.pass) summary.failures.push(caseName);
        }
      }
    }

    // The M2 extension capture (1100x757, DPR 1) is analysed as a sanity check
    // against the same ground truth the fixture page produces at that viewport.
    const extensionCapture = path.join(REPO_ROOT, "test/fixtures/captures/startpos-capture.png");
    if (args.images.length === 0 && existsSync(extensionCapture) && pages.includes("startpos.html")) {
      const gtFromCase = summary.cases.startpos["1100x757@1"]?.groundTruth;
      const bytes = await readFile(extensionCapture);
      process.stdout.write("extension-capture(startpos, 1100x757): ");
      const record = await runCase({
        name: "extension-capture startpos 1100x757",
        imageDataUrl: `data:image/png;base64,${bytes.toString("base64")}`,
        groundTruth: gtFromCase,
        tolerance: 4,
        fileForOverlay: "extension-capture-startpos-1100x757-overlay.png",
      });
      summary.cases["extension-capture"] = record;
      console.log(
        record.pass
          ? `PASS err ${record.errors?.maxEdge}px conf ${record.result.confidence?.toFixed(2)} ${record.locateMs}ms`
          : `FAIL ${record.failure}`,
      );
      if (!record.pass) summary.failures.push("extension-capture");
    }

    summary.ok = summary.failures.length === 0;
    await mkdir(args.outDir, { recursive: true });
    const proofPath = path.join(args.outDir, "locator-proof.json");
    await writeFile(proofPath, `${JSON.stringify(summary, null, 2)}\n`);
    console.log(
      `\n${summary.ok ? "ALL CASES PASSED" : `FAILURES: ${summary.failures.join(", ")}`}` +
        `\nproof: ${path.relative(REPO_ROOT, proofPath)}`,
    );
    if (!summary.ok) process.exitCode = 1;
  } catch (error) {
    console.error(`locator-proof failed: ${error.message}`);
    process.exitCode = 1;
  } finally {
    cdp?.close();
    chromeProcess?.kill("SIGTERM");
    await sleep(300);
    chromeProcess?.kill("SIGKILL");
    if (profileDir && !args.keepProfile) await rm(profileDir, { recursive: true, force: true });
    else if (profileDir) console.error(`profile kept at ${profileDir}`);
  }
}

async function readdirSafe(dir) {
  const { readdir } = await import("node:fs/promises");
  return readdir(dir);
}

main();

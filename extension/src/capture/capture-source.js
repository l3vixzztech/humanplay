/**
 * Capture-source abstraction — LOCKED interface (Milestone 2, docs/PROJECT.md).
 *
 * Every frame that the pipeline ever sees comes from a capture source. A source
 * captures ONE frame on demand:
 *
 *     async getFrame() -> {
 *       dataUrl:    "data:image/png;base64,..."  // raw screenshot, PNG
 *       width:      number                       // frame width in CSS pixels
 *       height:     number                       // frame height in CSS pixels
 *       capturedAt: string                       // ISO-8601, when captured
 *       source:     string                       // source id, e.g. "browser-tab"
 *       tabUrl:     string                       // best-effort, "" if unknown
 *       tabTitle:   string                       // best-effort, "" if unknown
 *     }
 *
 * Downstream code must consume frames ONLY through this interface, never by
 * calling chrome.tabs.captureVisibleTab (or any other capture API) directly.
 * That keeps a future desktop-capture source a drop-in addition.
 *
 * Milestone note (M3): the product path no longer uses frames at all — chess.com
 * game state is read from the DOM by the content script. This abstraction and
 * its screenshot frames remain as a DEBUG TOOL (panel "Capture now" + "Record
 * fixture (PNG)"), and as the seam a future desktop source would plug into
 * (docs/PROJECT.md, locked decisions; pixel recognition is parked under
 * parked/image-recognition/).
 *
 * Choose a source with `getCaptureSource(kind, options)`; the default kind is
 * "browser-tab". "desktop" exists as a seam only (out of scope for now): it
 * throws.
 */

export const SOURCE_BROWSER_TAB = "browser-tab";
export const SOURCE_DESKTOP = "desktop";

/**
 * chrome.tabs.captureVisibleTab is quota-limited to ~2 calls/second. Continuous
 * capture is out of scope until M9, so we only self-throttle on-demand frames
 * with a small safety margin.
 */
const MIN_CAPTURE_INTERVAL_MS = 550;
let lastCaptureAt = 0;

async function respectCaptureQuota() {
  const waitMs = lastCaptureAt + MIN_CAPTURE_INTERVAL_MS - Date.now();
  if (waitMs > 0) {
    await new Promise((resolve) => setTimeout(resolve, waitMs));
  }
  lastCaptureAt = Date.now();
}

/** Decode a data: URL into a Blob without any network access. */
export function dataUrlToBlob(dataUrl) {
  const comma = dataUrl.indexOf(",");
  if (!dataUrl.startsWith("data:") || comma < 0) {
    throw new Error("not a data: URL");
  }
  const header = dataUrl.slice(5, comma);
  const mime = /^([^;,]+)/.exec(header)?.[1] || "application/octet-stream";
  const isBase64 = /;base64/i.test(header);
  if (!isBase64) {
    return new Blob([decodeURIComponent(dataUrl.slice(comma + 1))], { type: mime });
  }
  const binary = atob(dataUrl.slice(comma + 1));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return new Blob([bytes], { type: mime });
}

/** Dimensions of an encoded image, in pixels. */
export async function imageDimensions(dataUrl) {
  const blob = dataUrlToBlob(dataUrl);
  if (typeof createImageBitmap === "function") {
    const bitmap = await createImageBitmap(blob);
    const dimensions = { width: bitmap.width, height: bitmap.height };
    bitmap.close?.();
    return dimensions;
  }
  return await new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve({ width: image.naturalWidth, height: image.naturalHeight });
    image.onerror = () => reject(new Error("captured frame could not be decoded"));
    image.src = dataUrl; // data: URLs are fine for <img> under the MV3 default CSP
  });
}

/** Best-effort URL/title of a tab we may not have host permission for. */
async function tabMetadata(tabId) {
  const query =
    typeof tabId === "number"
      ? { tabId }
      : { active: true, lastFocusedWindow: true };
  try {
    const [tab] = await chrome.tabs.query(query);
    return { tabId: tab?.id ?? null, tabUrl: tab?.url ?? "", tabTitle: tab?.title ?? "" };
  } catch {
    return { tabId: null, tabUrl: "", tabTitle: "" };
  }
}

/**
 * Captures the visible area of the active tab via chrome.tabs.captureVisibleTab.
 *
 * Permission notes (Milestone 2):
 * - chrome.tabs.captureVisibleTab needs either a host permission for the
 *   captured page, or the activeTab grant (given when the user clicks the
 *   extension's toolbar action on that tab — which is also how the side panel
 *   opens, see src/background/service-worker.js).
 * - `tabUrl`/`tabTitle` are best-effort: they are only populated when the
 *   extension actually has access to that tab (host permission or activeTab);
 *   otherwise Chrome redacts them and we report "".
 */
export class BrowserTabCaptureSource {
  /**
   * @param {{windowId?: number, tabId?: number|null}} [options]
   */
  constructor({ windowId = chrome.windows.WINDOW_ID_CURRENT, tabId = null } = {}) {
    this.windowId = windowId;
    this.tabId = tabId;
  }

  async getFrame() {
    await respectCaptureQuota();

    let dataUrl;
    try {
      dataUrl = await chrome.tabs.captureVisibleTab(this.windowId, { format: "png" });
    } catch (error) {
      throw new Error(
        "BrowserTabCaptureSource: captureVisibleTab failed (" +
          `${error?.message ?? error}). ` +
          "The side panel only gets site access when it is opened by clicking the " +
          "humanplay toolbar icon on the tab you want to capture: click the icon, then retry.",
      );
    }

    const { width, height } = await imageDimensions(dataUrl);
    const { tabId, tabUrl, tabTitle } = await tabMetadata(this.tabId);

    return {
      dataUrl,
      width,
      height,
      capturedAt: new Date().toISOString(),
      source: SOURCE_BROWSER_TAB,
      tabUrl,
      tabTitle,
      ...(tabId !== null ? { tabId } : {}),
    };
  }
}

/**
 * Desktop/whole-screen capture — OUT OF SCOPE for now (docs/PROJECT.md).
 *
 * Kept as a real class so the seam is visible and downstream code can already
 * switch on the source id. A future implementation would use
 * chrome.desktopCapture.getMediaStreamId + getUserMedia in an offscreen
 * document; nothing in the pipeline needs to change for that.
 */
export class DesktopCaptureSource {
  // eslint-disable-next-line class-methods-use-this
  async getFrame() {
    throw new Error(
      "DesktopCaptureSource: not implemented (desktop capture is out of scope; see docs/PROJECT.md)",
    );
  }
}

/**
 * Factory used by the rest of the extension.
 *
 * @param {string} [kind] one of SOURCE_BROWSER_TAB | SOURCE_DESKTOP
 * @param {object} [options] passed to the source constructor
 */
export function getCaptureSource(kind = SOURCE_BROWSER_TAB, options = {}) {
  switch (kind) {
    case SOURCE_BROWSER_TAB:
      return new BrowserTabCaptureSource(options);
    case SOURCE_DESKTOP:
      return new DesktopCaptureSource(options);
    default:
      throw new Error(`getCaptureSource: unknown capture source "${kind}"`);
  }
}

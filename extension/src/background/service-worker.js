/**
 * humanplay MV3 service worker — deliberately minimal (Milestone 2).
 *
 * The only job right now: the toolbar action opens the side panel. Doing it via
 * setPanelBehavior({openPanelOnActionClick:true}) is also what grants the
 * `activeTab` permission for the clicked tab, which is what lets
 * BrowserTabCaptureSource (src/capture/capture-source.js) capture the visible
 * tab on demand. No analysis, no timers, no loops — continuous capture is M9.
 *
 * Keep state out of the service worker: MV3 workers are killed and restarted at
 * will. Anything that must survive goes to chrome.storage (see src/ui).
 */

chrome.runtime.onInstalled.addListener(enableActionClickOpensPanel);
chrome.runtime.onStartup.addListener(enableActionClickOpensPanel);

// Also run on plain worker start (e.g. after an update or a manual reload).
enableActionClickOpensPanel();

function enableActionClickOpensPanel() {
  chrome.sidePanel
    .setPanelBehavior({ openPanelOnActionClick: true })
    .catch((error) => {
      // e.g. older Chrome than minimum_chrome_version; the side panel can still
      // be opened from the puzzle icon in the toolbar.
      console.warn("humanplay: could not enable side panel on action click:", error);
    });
}

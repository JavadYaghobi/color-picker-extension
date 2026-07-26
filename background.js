// Service worker: handles screenshot capture requests coming from the
// content script. captureVisibleTab must be called from the extension's
// privileged context, so the content script proxies through here.

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message && message.type === "CAPTURE_TAB") {
    const windowId = sender.tab ? sender.tab.windowId : chrome.windows.WINDOW_ID_CURRENT;

    chrome.tabs.captureVisibleTab(windowId, { format: "png" }, (dataUrl) => {
      if (chrome.runtime.lastError) {
        sendResponse({ error: chrome.runtime.lastError.message });
        return;
      }
      sendResponse({ dataUrl });
    });

    return true; // keep the message channel open for the async response
  }
});

chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.get({ pickerEnabled: undefined }, (res) => {
    if (res.pickerEnabled === undefined) {
      chrome.storage.local.set({ pickerEnabled: false });
    }
  });
});

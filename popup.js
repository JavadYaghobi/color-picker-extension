const toggleBtn = document.getElementById("toggleBtn");
const statusLabel = document.getElementById("statusLabel");
const lastColorBox = document.getElementById("lastColorBox");
const lastSwatch = document.getElementById("lastSwatch");
const lastHex = document.getElementById("lastHex");
const lastRgb = document.getElementById("lastRgb");

function renderStatus(enabled) {
  statusLabel.textContent = enabled ? "ON" : "OFF";
  statusLabel.classList.toggle("on", enabled);
}

function renderLastColor(lastColor) {
  if (!lastColor) return;
  lastColorBox.style.display = "flex";
  lastSwatch.style.background = lastColor.hex;
  lastHex.textContent = lastColor.hex.toUpperCase();
  lastRgb.textContent = lastColor.rgb;
}

chrome.storage.local.get({ pickerEnabled: false, lastColor: null }, (res) => {
  toggleBtn.checked = !!res.pickerEnabled;
  renderStatus(!!res.pickerEnabled);
  renderLastColor(res.lastColor);
});

toggleBtn.addEventListener("change", () => {
  const enabled = toggleBtn.checked;
  renderStatus(enabled);
  chrome.storage.local.set({ pickerEnabled: enabled });

  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    const tab = tabs[0];
    if (!tab || !tab.id) return;
    chrome.tabs.sendMessage(tab.id, { type: "TOGGLE_PICKER", enabled }, () => {
      // Swallow errors for pages where the content script can't run
      // (chrome:// pages, the Web Store, etc.)
      void chrome.runtime.lastError;
    });
  });
});

chrome.storage.onChanged.addListener((changes) => {
  if (changes.lastColor) {
    renderLastColor(changes.lastColor.newValue);
  }
});

// popup.js

const statTotalEl = document.getElementById("statTotal");
const statAiEl = document.getElementById("statAi");
const statUnsureEl = document.getElementById("statUnsure");
const statRealEl = document.getElementById("statReal");
const autoScanToggle = document.getElementById("autoScanToggle");
const manualUrlInput = document.getElementById("manualUrl");
const manualScanBtn = document.getElementById("manualScanBtn");
const manualResultEl = document.getElementById("manualResult");
const historyListEl = document.getElementById("historyList");

function sendMessageAsync(message) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, (response) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve(response);
    });
  });
}

function formatTime(timestamp) {
  const d = new Date(timestamp);
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function renderStats(stats) {
  statTotalEl.textContent = stats.total || 0;
  statAiEl.textContent = stats.ai || 0;
  statUnsureEl.textContent = stats.inconclusive || 0;
  statRealEl.textContent = stats.authentic || 0;
}

// Short text for a verdict, e.g. "Likely AI-generated, 82% AI".
function describe(verdict, label, confidence) {
  const pct = Math.round((confidence || 0) * 100);
  return `${label || verdict} · ${pct}% AI`;
}

function renderHistory(history) {
  if (!history || history.length === 0) {
    historyListEl.innerHTML = '<p class="dfd-empty">No scans yet.</p>';
    return;
  }

  historyListEl.innerHTML = "";
  history.forEach((entry) => {
    const item = document.createElement("div");
    item.className = "dfd-history-item";

    const thumb = document.createElement("img");
    thumb.className = "dfd-history-thumb";
    thumb.src = entry.url;
    thumb.referrerPolicy = "no-referrer";
    thumb.onerror = () => {
      thumb.style.visibility = "hidden";
    };

    const info = document.createElement("div");
    info.className = "dfd-history-info";

    const label = document.createElement("div");
    const verdict = entry.verdict || "authentic";
    label.className = "dfd-history-label " + verdict;
    label.textContent = describe(verdict, entry.label, entry.confidence);

    const time = document.createElement("div");
    time.className = "dfd-history-time";
    time.textContent = formatTime(entry.timestamp);

    info.appendChild(label);
    info.appendChild(time);
    item.appendChild(thumb);
    item.appendChild(info);
    historyListEl.appendChild(item);
  });
}

async function loadState() {
  try {
    const response = await sendMessageAsync({ type: "GET_STATE" });
    if (response && response.ok) {
      renderStats(response.stats);
      renderHistory(response.history);
      autoScanToggle.checked = !!response.autoScan;
    }
  } catch (err) {
    console.error("[Verisight] failed to load state:", err);
  }
}

autoScanToggle.addEventListener("change", async () => {
  await sendMessageAsync({ type: "SET_AUTOSCAN", value: autoScanToggle.checked });
});

manualScanBtn.addEventListener("click", async () => {
  const url = manualUrlInput.value.trim();
  if (!url) return;

  manualScanBtn.disabled = true;
  manualScanBtn.textContent = "Scanning...";
  manualResultEl.hidden = true;

  try {
    const response = await sendMessageAsync({ type: "MANUAL_SCAN", url });
    if (response && response.ok) {
      const result = response.result;
      const verdict = result.verdict || (result.is_fake ? "ai" : "authentic");
      const range =
        result.range_low !== undefined && result.range_low !== null
          ? ` (range ${result.range_low}% to ${result.range_high}%)`
          : "";
      manualResultEl.className = "dfd-manual-result dfd-result-" + verdict;
      manualResultEl.textContent =
        describe(verdict, result.label, result.confidence_score) +
        range +
        (result.cached ? " · cached" : "");
      manualResultEl.hidden = false;
      await loadState(); // refresh stats/history
    } else {
      manualResultEl.className = "dfd-manual-result dfd-result-error";
      manualResultEl.textContent = "Scan failed: " + (response && response.error);
      manualResultEl.hidden = false;
    }
  } catch (err) {
    manualResultEl.className = "dfd-manual-result dfd-result-error";
    manualResultEl.textContent = "Scan failed: " + err.message;
    manualResultEl.hidden = false;
  } finally {
    manualScanBtn.disabled = false;
    manualScanBtn.textContent = "Scan";
  }
});

manualUrlInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") manualScanBtn.click();
});

const clearCacheBtn = document.getElementById("clearCacheBtn");
clearCacheBtn.addEventListener("click", async () => {
  clearCacheBtn.disabled = true;
  const original = clearCacheBtn.textContent;
  clearCacheBtn.textContent = "Clearing...";
  try {
    await sendMessageAsync({ type: "CLEAR_CACHE" });
    await loadState();
  } finally {
    clearCacheBtn.disabled = false;
    clearCacheBtn.textContent = original;
  }
});

document.addEventListener("DOMContentLoaded", loadState);
loadState();
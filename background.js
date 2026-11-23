// background.js
// Service worker for the Verisight extension.
// Responsibilities:
//   1. Talk to the local ML backend (real_backend.py) to scan image URLs.
//   2. Cache scan results in chrome.storage.local, keyed by a hashed image URL,
//      so the same image is never re-scanned.
//   3. Keep running stats (total/fake/real) and a recent-scan history list.
//   4. Answer messages from content.js (auto-scan) and popup.js (manual scan / UI state).

const BACKEND_URL = "http://localhost:8000/";
// "_v2" keys: the stats/history shape changed when the extension moved to the
// Verisight engine (authentic / inconclusive / ai), so old numbers are ignored.
const STATS_KEY = "df_stats_v2";
const HISTORY_KEY = "df_history_v2";
const AUTOSCAN_KEY = "df_autoscan";
const HISTORY_LIMIT = 50;
const EMPTY_STATS = { total: 0, ai: 0, inconclusive: 0, authentic: 0 };

// Must match PIPELINE_VERSION in real_backend.py. A cached result from a
// different pipeline is ignored and re-scanned.
const PIPELINE_VERSION = "ext-verisight-v2";

// The main detector can take a minute or more per image on a CPU.
const REQUEST_TIMEOUT_MS = 4 * 60 * 1000;

// ---------- storage helpers (Promise wrappers around callback APIs) ----------

function storageGet(keys) {
  return new Promise((resolve) => {
    chrome.storage.local.get(keys, (result) => resolve(result));
  });
}

function storageSet(items) {
  return new Promise((resolve) => {
    chrome.storage.local.set(items, () => resolve());
  });
}

// ---------- url hashing for safe, compact storage keys ----------

function hashUrl(url) {
  // Base64-encode the URL, then strip characters that are awkward as storage
  // keys and truncate so extremely long URLs (e.g. with query strings full of
  // signed tokens) don't blow past any practical key-length limits.
  let encoded;
  try {
    encoded = btoa(unescape(encodeURIComponent(url)));
  } catch (e) {
    // Fallback for any string btoa can't handle.
    encoded = String(url.length) + "_" + url.slice(-120);
  }
  const safe = encoded.replace(/[^a-zA-Z0-9]/g, "");
  return "img_" + safe.substring(0, 120);
}

// ---------- stats / history ----------

async function getStats() {
  const data = await storageGet(STATS_KEY);
  return data[STATS_KEY] || { ...EMPTY_STATS };
}

async function getHistory() {
  const data = await storageGet(HISTORY_KEY);
  return data[HISTORY_KEY] || [];
}

async function getAutoScan() {
  const data = await storageGet(AUTOSCAN_KEY);
  // Default to ON if never set.
  return data[AUTOSCAN_KEY] === undefined ? true : data[AUTOSCAN_KEY];
}

async function recordResult(url, result) {
  const stats = await getStats();
  stats.total += 1;
  const verdict = result.verdict || (result.is_fake ? "ai" : "authentic");
  stats[verdict] = (stats[verdict] || 0) + 1;

  const history = await getHistory();
  history.unshift({
    url,
    verdict,
    label: result.label,
    confidence: result.confidence_score, // main detector's P(AI), 0 to 1
    timestamp: Date.now(),
  });
  const trimmed = history.slice(0, HISTORY_LIMIT);

  await storageSet({ [STATS_KEY]: stats, [HISTORY_KEY]: trimmed });
  return { stats, history: trimmed };
}

// ---------- backend call + cache ----------

async function scanImage(url, { useCache = true } = {}) {
  const cacheKey = hashUrl(url);

  if (useCache) {
    const cached = await storageGet(cacheKey);
    if (cached && cached[cacheKey] && cached[cacheKey].pipeline === PIPELINE_VERSION) {
      return { ...cached[cacheKey], cached: true };
    }
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  let response;
  try {
    response = await fetch(BACKEND_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url }),
      signal: controller.signal,
    });
  } catch (err) {
    if (err && err.name === "AbortError") {
      throw new Error("The backend took too long (over 4 minutes).");
    }
    throw new Error("Cannot reach the backend at " + BACKEND_URL + ". Is it running?");
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`Backend error ${response.status}: ${text}`);
  }

  const result = await response.json();
  result.cached = false;

  // Cache the raw result (without the transient "cached" flag mattering).
  await storageSet({ [cacheKey]: result });

  // Update running stats + history for every fresh (non-cached) scan.
  await recordResult(url, result);

  return result;
}

// ---------- video: a few frames grabbed by content.js are sent to /video ----------

// 4 frames at tens of seconds each on a CPU, plus waiting behind image scans.
const VIDEO_TIMEOUT_MS = 12 * 60 * 1000;

async function scanVideo(frames, thumb, url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), VIDEO_TIMEOUT_MS);
  let response;
  try {
    response = await fetch(BACKEND_URL + "video", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(url ? { url } : { frames }),
      signal: controller.signal,
    });
  } catch (err) {
    if (err && err.name === "AbortError") {
      throw new Error("The backend took too long (over 12 minutes) to check this video.");
    }
    throw new Error("Cannot reach the backend at " + BACKEND_URL + ". Is it running?");
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`Backend error ${response.status}: ${text}`);
  }

  const result = await response.json();
  result.cached = false;
  result.is_video = true;
  // Stats and history like images; the first frame (small) is the thumbnail.
  await recordResult(thumb || "", result);
  return result;
}

// ---------- message router ----------

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    try {
      switch (message.type) {
        case "SCAN_IMAGE": {
          // Auto-scan from content.js. Respects cache.
          const result = await scanImage(message.url, { useCache: true });
          sendResponse({ ok: true, result });
          break;
        }

        case "SCAN_VIDEO": {
          const result = await scanVideo(message.frames, message.thumb, message.url);
          sendResponse({ ok: true, result });
          break;
        }

        case "MANUAL_SCAN": {
          // From the popup's "paste a URL" box. Still respects cache so a
          // manually-pasted URL that was already auto-scanned doesn't hit
          // the backend twice.
          const result = await scanImage(message.url, { useCache: true });
          sendResponse({ ok: true, result });
          break;
        }

        case "GET_STATE": {
          const [stats, history, autoScan] = await Promise.all([
            getStats(),
            getHistory(),
            getAutoScan(),
          ]);
          sendResponse({ ok: true, stats, history, autoScan });
          break;
        }

        case "GET_AUTOSCAN": {
          const autoScan = await getAutoScan();
          sendResponse({ ok: true, autoScan });
          break;
        }

        case "SET_AUTOSCAN": {
          await storageSet({ [AUTOSCAN_KEY]: !!message.value });
          sendResponse({ ok: true });
          break;
        }

        case "GET_CACHED_RESULT": {
          const cacheKey = hashUrl(message.url);
          const cached = await storageGet(cacheKey);
          sendResponse({ ok: true, result: (cached && cached[cacheKey]) || null });
          break;
        }

        case "CLEAR_CACHE": {
          // Wipes every cached per-image result (keys prefixed "img_") plus
          // stats/history, so everything gets freshly re-scanned. Needed
          // whenever the backend's model/logic changes, since cached
          // results don't know the old answer is now stale.
          const all = await storageGet(null);
          const imgKeys = Object.keys(all).filter((k) => k.startsWith("img_"));
          if (imgKeys.length) {
            await new Promise((resolve) => chrome.storage.local.remove(imgKeys, resolve));
          }
          await storageSet({
            [STATS_KEY]: { ...EMPTY_STATS },
            [HISTORY_KEY]: [],
          });
          sendResponse({ ok: true, cleared: imgKeys.length });
          break;
        }

        default:
          sendResponse({ ok: false, error: `Unknown message type: ${message.type}` });
      }
    } catch (err) {
      console.error("[Verisight] background error:", err);
      sendResponse({ ok: false, error: err.message || String(err) });
    }
  })();

  // CRITICAL: must return true so Chrome keeps the message channel open for
  // the async sendResponse above. Without this, the response is dropped.
  return true;
});

// Initialize defaults on install.
chrome.runtime.onInstalled.addListener(async () => {
  const data = await storageGet([STATS_KEY, HISTORY_KEY, AUTOSCAN_KEY]);
  const updates = {};
  if (!data[STATS_KEY]) updates[STATS_KEY] = { ...EMPTY_STATS };
  if (!data[HISTORY_KEY]) updates[HISTORY_KEY] = [];
  if (data[AUTOSCAN_KEY] === undefined) updates[AUTOSCAN_KEY] = true;
  if (Object.keys(updates).length) await storageSet(updates);
});
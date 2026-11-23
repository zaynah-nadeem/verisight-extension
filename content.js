// content.js
// Runs on instagram.com / facebook.com.
// Finds images, scans the ones you can actually see (one at a time, nearest the
// middle of the screen first) through background.js, and overlays a small
// verdict badge on each one. Verdicts match the Verisight app:
//   green  = Likely authentic
//   amber  = Inconclusive
//   red    = Likely AI-generated

(() => {
  // The main detector is slow on a CPU (tens of seconds per image), so skip
  // avatars, icons and thumbnails: only images at least this big (CSS px) get scanned.
  const MIN_SIZE = 200;
  const INTERSECTION_THRESHOLD = 0.3;

  // img element -> badge state object { badgeEl, status, result }
  const badgeState = new Map();

  // Images already queued or scanned this session, so we don't queue twice.
  const seenImages = new WeakSet();

  // Images waiting for their turn. Only one scan runs at a time (the backend
  // does one at a time anyway, and a second request would just wait).
  const scanQueue = [];
  let isProcessingQueue = false;
  let processScheduled = false;

  let autoScanEnabled = true;
  let activeDetailPanel = null;

  // ---------------------------------------------------------------------
  // Styling (injected once, no wrapper divs around host-site images)
  // ---------------------------------------------------------------------

  function injectStyles() {
    if (document.getElementById("dfd-styles")) return;
    const style = document.createElement("style");
    style.id = "dfd-styles";
    style.textContent = `
      .dfd-badge {
        position: fixed;
        z-index: 2147483000;
        padding: 3px 8px;
        border-radius: 999px;
        font: 600 11px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
        color: #fff;
        cursor: pointer;
        box-shadow: 0 1px 4px rgba(0,0,0,0.35);
        user-select: none;
        pointer-events: auto;
        white-space: nowrap;
        transition: background-color 0.15s ease;
      }
      .dfd-badge-waiting { background-color: #4b5563; }
      .dfd-badge-scanning { background-color: #6b7280; }
      .dfd-badge-authentic { background-color: #3f7a57; }
      .dfd-badge-inconclusive { background-color: #b7791f; }
      .dfd-badge-ai { background-color: #c0392b; }
      .dfd-badge-error { background-color: #7f1d1d; }
      .dfd-badge-action { background-color: #8A3D28; }

      .dfd-panel {
        position: fixed;
        z-index: 2147483001;
        width: 280px;
        max-width: 80vw;
        max-height: 70vh;
        overflow-y: auto;
        background: #1f2937;
        color: #f3f4f6;
        border-radius: 10px;
        padding: 12px 14px;
        font: 400 12px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
        box-shadow: 0 8px 24px rgba(0,0,0,0.45);
      }
      .dfd-panel h4 {
        margin: 0 0 4px 0;
        font-size: 13px;
        font-weight: 700;
      }
      .dfd-panel .dfd-sub {
        color: #9ca3af;
        margin-bottom: 6px;
      }
      .dfd-panel .dfd-row {
        display: flex;
        justify-content: space-between;
        margin: 2px 0;
        gap: 8px;
      }
      .dfd-panel ul {
        margin: 6px 0 0 0;
        padding-left: 16px;
        color: #d1d5db;
      }
      .dfd-panel li { margin: 3px 0; }
      .dfd-panel .dfd-explain {
        margin-top: 8px;
        padding-top: 8px;
        border-top: 1px solid #374151;
        color: #9ca3af;
        font-style: italic;
      }
      .dfd-panel .dfd-close {
        position: absolute;
        top: 6px;
        right: 8px;
        cursor: pointer;
        color: #9ca3af;
        font-weight: 700;
      }
    `;
    document.head.appendChild(style);
  }

  // ---------------------------------------------------------------------
  // Badge creation / positioning
  // ---------------------------------------------------------------------

  function createBadge(img) {
    const badge = document.createElement("div");
    badge.className = "dfd-badge dfd-badge-waiting";
    badge.textContent = "Waiting...";
    badge.addEventListener("click", (e) => {
      e.stopPropagation();
      e.preventDefault();
      const state = badgeState.get(img);
      if (!state) return;
      // A "Scan this ..." button starts the scan; a badge that shows an error is a retry button.
      if (state.status === "idle" || (state.result && state.result.error)) {
        if (img instanceof HTMLVideoElement) startVideoScan(img);
        else startImageScan(img);
        return;
      }
      if (state.result) showDetailPanel(img, badge, state.result);
    });
    document.body.appendChild(badge);
    positionBadge(img, badge);
    return badge;
  }

  // The part of the image you can really see: the image box cut down by the
  // screen AND by every parent that hides overflow (carousels, grid tiles,
  // scroll boxes). A badge is only drawn inside this part, so it can never
  // drift onto a neighbouring post.
  function visibleRect(img) {
    const r = img.getBoundingClientRect();
    let top = Math.max(r.top, 0);
    let left = Math.max(r.left, 0);
    let right = Math.min(r.right, window.innerWidth);
    let bottom = Math.min(r.bottom, window.innerHeight);

    let el = img.parentElement;
    while (el && el !== document.documentElement) {
      const cs = getComputedStyle(el);
      if (cs.overflowX !== "visible" || cs.overflowY !== "visible") {
        const p = el.getBoundingClientRect();
        top = Math.max(top, p.top);
        left = Math.max(left, p.left);
        right = Math.min(right, p.right);
        bottom = Math.min(bottom, p.bottom);
      }
      el = el.parentElement;
    }
    return { top, left, right, bottom, width: right - left, height: bottom - top };
  }

  // True when something else (an opened post, a pop-up, a dark backdrop) is on
  // top of the image at this screen point. Our own badges are ignored.
  function isCovered(img, x, y) {
    const stack = document.elementsFromPoint(x, y);
    const top = stack.find(
      (e) => !(e.classList && (e.classList.contains("dfd-badge") || e.classList.contains("dfd-panel")))
    );
    if (!top) return false;
    // "Same post" = the post/dialog/tile that holds the image.
    const post = img.closest("article, [role='dialog']") || img.closest("a") || img.parentElement;
    return !(top === img || top.contains(img) || (post && post.contains(top)));
  }

  function positionBadge(img, badge) {
    if (!img.isConnected) {
      removeBadge(img);
      return;
    }
    const vis = visibleRect(img);
    // Hide the badge when too little of the post is visible to carry it.
    if (vis.width < 80 || vis.height < 40) {
      badge.style.display = "none";
      return;
    }
    badge.style.display = "block";
    const bw = badge.offsetWidth;
    // Top-right corner of the visible part of the image, nudged inward.
    // If the badge is wider than the visible part, anchor it to the left edge.
    const left = Math.max(vis.right - bw - 6, vis.left + 6);
    const top = vis.top + 6;
    // Hide the badge if another post or a pop-up is on top of this image.
    if (isCovered(img, left + bw / 2, top + 10)) {
      badge.style.display = "none";
      return;
    }
    badge.style.top = `${top}px`;
    badge.style.left = `${left}px`;
  }

  function removeBadge(img) {
    const state = badgeState.get(img);
    if (state && state.badgeEl) {
      state.badgeEl.remove();
    }
    badgeState.delete(img);
  }

  function repositionAllBadges() {
    for (const [img, state] of badgeState.entries()) {
      if (!img.isConnected) {
        removeBadge(img);
        continue;
      }
      positionBadge(img, state.badgeEl);
    }
  }

  // Throttle reposition via rAF so scroll doesn't flood layout work.
  let repositionScheduled = false;
  function scheduleReposition() {
    if (repositionScheduled) return;
    repositionScheduled = true;
    requestAnimationFrame(() => {
      repositionScheduled = false;
      repositionAllBadges();
    });
  }

  // Works for new results (result.verdict) and for any older cached result
  // that only has label "Real"/"Fake".
  function verdictOf(result) {
    if (result.verdict) return result.verdict;
    return result.label === "Fake" ? "ai" : "authentic";
  }

  // The same three wordings the Verisight app uses.
  function labelOf(result, verdict) {
    if (verdict === "ai") return "Likely AI-generated";
    if (verdict === "inconclusive") return "Inconclusive";
    return "Likely authentic";
  }

  function aiPercent(result) {
    return Math.round((result.confidence_score || 0) * 100);
  }

  function setBadgeResult(img, result) {
    const state = badgeState.get(img);
    if (!state) return;
    state.result = result;
    state.status = "done";
    const badge = state.badgeEl;

    if (result.error) {
      badge.className = "dfd-badge dfd-badge-error";
      badge.textContent = "Error";
      badge.title = result.message || "The scan failed. Is the backend running?";
    } else {
      const verdict = verdictOf(result);
      const pct = aiPercent(result);
      const label = labelOf(result, verdict);
      if (verdict === "ai") {
        badge.className = "dfd-badge dfd-badge-ai";
        badge.textContent = `${label} · ${pct}% AI`;
      } else if (verdict === "inconclusive") {
        badge.className = "dfd-badge dfd-badge-inconclusive";
        badge.textContent = result.too_small ? `${label} · too small` : `${label} · ${pct}% AI`;
      } else {
        badge.className = "dfd-badge dfd-badge-authentic";
        badge.textContent = `${label} · ${pct}% AI`;
      }
      badge.title = `${label}. Click for details.`;
    }
    positionBadge(img, badge);
  }

  // ---------------------------------------------------------------------
  // Detail panel
  // ---------------------------------------------------------------------

  function closeDetailPanel() {
    if (activeDetailPanel) {
      activeDetailPanel.remove();
      activeDetailPanel = null;
    }
  }

  function showDetailPanel(img, badge, result) {
    closeDetailPanel();
    const panel = document.createElement("div");
    panel.className = "dfd-panel";

    const hasRange = result.range_low !== undefined && result.range_low !== null;
    const rangeText = hasRange
      ? `AI likelihood: ${result.range_low}% to ${result.range_high}%`
      : result.too_small
        ? "Too small to judge"
        : `AI likelihood: about ${aiPercent(result)}%`;

    const scores = result.model_scores || {};
    const modelRows = Object.entries(scores)
      .map(
        ([name, score]) =>
          `<div class="dfd-row"><span>${escapeHtml(prettyModelName(name))}</span><span>${Math.round(score * 100)}% AI</span></div>`
      )
      .join("");

    const reasons = Array.isArray(result.reasons) && result.reasons.length
      ? result.reasons
      : result.explanation
        ? [result.explanation]
        : [];
    const reasonItems = reasons.map((r) => `<li>${escapeHtml(r)}</li>`).join("");

    panel.innerHTML = `
      <span class="dfd-close">&times;</span>
      <h4>${escapeHtml(result.label || "Result")}${result.is_video ? " (video)" : ""}</h4>
      <div class="dfd-sub">${escapeHtml(rangeText)}</div>
      ${modelRows}
      ${
        Array.isArray(result.frame_scores) && result.frame_scores.length
          ? `<div class="dfd-row"><span>Frames</span><span>${result.frame_scores
              .map((s) => Math.round(s * 100) + "%")
              .join(", ")}</span></div>`
          : ""
      }
      ${reasonItems ? `<ul>${reasonItems}</ul>` : ""}
      ${result.limitation ? `<div class="dfd-explain">${escapeHtml(result.limitation)}</div>` : ""}
    `;

    panel.querySelector(".dfd-close").addEventListener("click", (e) => {
      e.stopPropagation();
      closeDetailPanel();
    });
    panel.addEventListener("click", (e) => e.stopPropagation());

    document.body.appendChild(panel);
    const rect = badge.getBoundingClientRect();
    let top = rect.bottom + 6;
    let left = rect.left;
    const panelRect = panel.getBoundingClientRect();
    if (left + panelRect.width > window.innerWidth) {
      left = Math.max(window.innerWidth - panelRect.width - 8, 8);
    }
    if (top + panelRect.height > window.innerHeight) {
      top = Math.max(rect.top - panelRect.height - 6, 8);
    }
    panel.style.top = `${top}px`;
    panel.style.left = `${left}px`;

    activeDetailPanel = panel;
  }

  function prettyModelName(name) {
    if (name === "main_detector") return "Main detector (SigLIP+DINOv2)";
    if (name === "video_model") return "Video model (support only)";
    return `Face model: ${name}`;
  }

  function escapeHtml(str) {
    const div = document.createElement("div");
    div.textContent = str;
    return div.innerHTML;
  }

  document.addEventListener("click", () => closeDetailPanel());

  // ---------------------------------------------------------------------
  // Scan queue
  // ---------------------------------------------------------------------

  function isInViewport(img) {
    const r = img.getBoundingClientRect();
    return (
      r.width > 0 &&
      r.height > 0 &&
      r.bottom > 0 &&
      r.top < window.innerHeight &&
      r.right > 0 &&
      r.left < window.innerWidth
    );
  }

  function distanceFromScreenCentre(img) {
    const r = img.getBoundingClientRect();
    return Math.abs(r.top + r.height / 2 - window.innerHeight / 2);
  }

  // Puts an image that scrolled out of view back to "not scanned yet", so it
  // gets queued again if the user scrolls back to it.
  function releaseImage(img) {
    removeBadge(img);
    seenImages.delete(img);
    if (img.isConnected) intersectionObserver.observe(img);
  }

  // Takes the on-screen image nearest the middle of the screen out of the queue.
  // Anything that is no longer on screen is released (not scanned).
  function pickNext(queue = scanQueue) {
    let best = null;
    let bestDistance = Infinity;

    for (let i = queue.length - 1; i >= 0; i--) {
      const img = queue[i];
      if (!img.isConnected) {
        queue.splice(i, 1);
        removeBadge(img);
        continue;
      }
      if (!isInViewport(img)) {
        queue.splice(i, 1);
        releaseImage(img);
        continue;
      }
      // Hidden behind an opened post or pop-up: keep it waiting (don't waste
      // a scan on it); it is picked up again when the cover goes away.
      const vis = visibleRect(img);
      if (vis.width < 40 || vis.height < 40 || isCovered(img, vis.left + vis.width / 2, vis.top + vis.height / 2)) {
        continue;
      }
      const d = distanceFromScreenCentre(img);
      if (d < bestDistance) {
        best = img;
        bestDistance = d;
      }
    }

    if (best) queue.splice(queue.indexOf(best), 1);
    return best;
  }

  function enqueueScan(img) {
    if (seenImages.has(img)) return;
    seenImages.add(img);
    if (!badgeState.has(img)) {
      badgeState.set(img, { badgeEl: createBadge(img), status: "waiting", result: null });
    }
    scanQueue.push(img);
    // Short delay so images that appear together are all in the queue before we
    // choose which one to scan first (the one nearest the middle of the screen).
    if (!processScheduled) {
      processScheduled = true;
      setTimeout(() => {
        processScheduled = false;
        processQueue();
      }, 150);
    }
  }

  // ---------------------------------------------------------------------
  // Videos: every video gets a "Scan this video" button. When it is clicked we
  // take 4 frames (like the app) and send them to the backend's /video endpoint.
  // Instagram/Facebook videos are streamed, so there is no file to download;
  // the frames are read straight from the <video> element.
  // The 4 frames come from the middle of 4 equal parts of the video (the same
  // way the app picks them), by jumping to those moments and jumping back.
  // ---------------------------------------------------------------------

  const VIDEO_FRAMES = 4; // same as the app's default
  const FRAME_GAP_MS = 1500; // only used when the length is unknown (live video)
  const FRAME_MAX_SIDE = 1920; // bigger frames are shrunk to this; the backend then shrinks to 1024 like the app

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function setBadgeText(el, cls, text) {
    const state = badgeState.get(el);
    if (!state) return;
    state.badgeEl.className = "dfd-badge " + cls;
    state.badgeEl.textContent = text;
    positionBadge(el, state.badgeEl);
  }

  function waitForEvent(el, name, ms) {
    return new Promise((resolve) => {
      let done = false;
      const finish = (value) => {
        if (done) return;
        done = true;
        el.removeEventListener(name, onEvent);
        resolve(value);
      };
      const onEvent = () => finish(true);
      el.addEventListener(name, onEvent);
      setTimeout(() => finish(false), ms);
    });
  }

  // Waits until the browser has actually painted the frame we jumped to.
  function nextPaint(video) {
    return new Promise((resolve) => {
      let done = false;
      const finish = () => {
        if (!done) {
          done = true;
          resolve();
        }
      };
      if (typeof video.requestVideoFrameCallback === "function") {
        video.requestVideoFrameCallback(finish);
        setTimeout(finish, 700);
      } else {
        setTimeout(finish, 300);
      }
    });
  }

  // One frame from the video as a lossless PNG data URL.
  // Returns { png, thumb } (or { dark: true } for a near-black frame unless allowDark).
  // Throws a SecurityError if the page does not let us read the video's pixels.
  function frameFromVideo(video, allowDark) {
    const vw = video.videoWidth;
    const vh = video.videoHeight;
    if (!vw || !vh) return null;

    if (!allowDark) {
      const probe = document.createElement("canvas");
      probe.width = 16;
      probe.height = 16;
      const pctx = probe.getContext("2d", { willReadFrequently: true });
      pctx.drawImage(video, 0, 0, 16, 16);
      const px = pctx.getImageData(0, 0, 16, 16).data;
      let sum = 0;
      for (let i = 0; i < px.length; i += 4) sum += (px[i] + px[i + 1] + px[i + 2]) / 3;
      if (sum / 256 < 8) return { dark: true };
    }

    const scale = Math.min(1, FRAME_MAX_SIDE / Math.max(vw, vh));
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(vw * scale);
    canvas.height = Math.round(vh * scale);
    canvas.getContext("2d").drawImage(video, 0, 0, canvas.width, canvas.height);

    const th = document.createElement("canvas");
    th.width = 64;
    th.height = Math.max(1, Math.round((64 * vh) / vw));
    th.getContext("2d").drawImage(video, 0, 0, th.width, th.height);

    return { png: canvas.toDataURL("image/png"), thumb: th.toDataURL("image/jpeg", 0.7) };
  }

  // Jumps to the middle of each of 4 equal parts of the video and grabs a frame,
  // then puts the video back where it was (and playing again if it was playing).
  async function captureEvenFrames(video) {
    const duration = video.duration;
    const frames = [];
    let thumb = "";
    const startTime = video.currentTime;
    const wasPlaying = !video.paused;
    video.pause();
    try {
      for (let i = 0; i < VIDEO_FRAMES; i++) {
        const t = ((i + 0.5) / VIDEO_FRAMES) * duration;
        setBadgeText(video, "dfd-badge-scanning", `Grabbing frame ${i + 1}/${VIDEO_FRAMES}...`);
        if (Math.abs(video.currentTime - t) > 0.05) {
          const seeked = waitForEvent(video, "seeked", 8000);
          video.currentTime = t;
          await seeked;
        }
        // The jump did not happen (the site did not buffer that moment): skip it
        // rather than send the same picture twice.
        if (Math.abs(video.currentTime - t) > 1.0 || video.readyState < 2) continue;
        await nextPaint(video);
        const f = frameFromVideo(video, true);
        if (f && f.png) {
          frames.push(f.png);
          if (!thumb) thumb = f.thumb;
        }
      }
    } finally {
      try {
        video.currentTime = startTime;
        if (wasPlaying) video.play().catch(() => {});
      } catch (e) {
        /* the player may have changed the video meanwhile */
      }
    }
    return { frames, thumb };
  }

  // Fallback for videos with no known length (live video) or when jumping fails:
  // wait for the video to play and take frames FRAME_GAP_MS apart.
  async function collectFramesWhilePlaying(video) {
    const frames = [];
    let thumb = "";
    let lastAt = 0;
    const startedAt = Date.now();
    while (frames.length < VIDEO_FRAMES) {
      if (!video.isConnected || !isInViewport(video)) return { gone: true };
      if (Date.now() - startedAt > 90000) throw new Error("The video did not play, so no frames could be taken.");
      const playing = !video.paused && !video.ended && video.readyState >= 2;
      if (!playing) {
        setBadgeText(video, "dfd-badge-waiting", "Press play to scan");
      } else if (Date.now() - lastAt >= FRAME_GAP_MS) {
        const f = frameFromVideo(video, false);
        if (f && f.png) {
          frames.push(f.png);
          if (!thumb) thumb = f.thumb;
          lastAt = Date.now();
        } else {
          lastAt = Date.now() - FRAME_GAP_MS + 500; // black or not ready: try again soon
        }
        setBadgeText(video, "dfd-badge-scanning", `Watching video ${frames.length}/${VIDEO_FRAMES}`);
      }
      await sleep(300);
    }
    return { frames, thumb };
  }

  // Some videos (e.g. Instagram's Explore previews) come straight from the site's file
  // server, so Chrome marks their pictures as unreadable.
  function canReadPixels(video) {
    try {
      const c = document.createElement("canvas");
      c.width = 1;
      c.height = 1;
      const ctx = c.getContext("2d", { willReadFrequently: true });
      ctx.drawImage(video, 0, 0, 1, 1);
      ctx.getImageData(0, 0, 1, 1);
      return true;
    } catch (e) {
      return false;
    }
  }

  async function captureFrames(video) {
    if (!canReadPixels(video)) {
      const blocked = new Error("The site does not let the extension read this video's pictures.");
      blocked.name = "SecurityError";
      throw blocked;
    }
    if (Number.isFinite(video.duration) && video.duration >= 1) {
      const got = await captureEvenFrames(video);
      if (got.frames.length) return got;
    }
    return collectFramesWhilePlaying(video);
  }

  function resetVideoButton(video) {
    const state = badgeState.get(video);
    if (!state) return;
    state.status = "idle";
    state.result = null;
    state.src = "";
    state.badgeEl.className = "dfd-badge dfd-badge-action";
    state.badgeEl.textContent = "Scan this video";
    state.badgeEl.title = "Click to check this video (takes a few minutes).";
    positionBadge(video, state.badgeEl);
  }

  // Sends the frames (or, as a fallback, the video's address) and shows the result.
  async function sendVideoScan(video, payload) {
    const state = badgeState.get(video);
    if (state) state.status = "scanning";
    setBadgeText(video, "dfd-badge-scanning", "Scanning video (a few minutes)...");
    try {
      const response = await sendMessageAsync({ type: "SCAN_VIDEO", ...payload });
      if (response && response.ok) {
        setBadgeResult(video, response.result);
      } else {
        const message = response && response.error ? response.error : "Scan failed";
        setBadgeResult(video, { error: true, message, label: "Error", confidence_score: 0 });
        console.warn("[Verisight] video scan failed:", message);
      }
    } catch (err) {
      setBadgeResult(video, { error: true, message: String(err), label: "Error", confidence_score: 0 });
      console.warn("[Verisight] video scan error:", err);
    }
  }

  // The site blocks reading the pictures: let the backend download the video itself.
  async function scanVideoByAddress(video) {
    const url = video.currentSrc || video.src || "";
    if (!/^https?:/i.test(url)) {
      setBadgeResult(video, {
        error: true,
        message: "The site does not let the extension read this video's pictures, and it gives no download address either.",
        label: "Error",
        confidence_score: 0,
      });
      return;
    }
    await sendVideoScan(video, { url, thumb: video.poster || "" });
  }

  async function startVideoScan(video) {
    const state = badgeState.get(video);
    if (!state || state.status === "collecting" || state.status === "scanning") return;
    state.status = "collecting";
    state.result = null;
    state.src = video.currentSrc || video.src || "";
    closeDetailPanel();
    setBadgeText(video, "dfd-badge-scanning", "Grabbing frames...");

    let got;
    try {
      got = await captureFrames(video);
    } catch (err) {
      if (err && err.name === "SecurityError") {
        await scanVideoByAddress(video);
        return;
      }
      setBadgeResult(video, {
        error: true,
        message: String((err && err.message) || err),
        label: "Error",
        confidence_score: 0,
      });
      return;
    }
    if (got.gone) {
      resetVideoButton(video); // scrolled away: back to the button
      return;
    }

    await sendVideoScan(video, { frames: got.frames, thumb: got.thumb });
  }

  function addVideoButton(video) {
    if (badgeState.has(video)) return;
    seenImages.add(video);
    badgeState.set(video, { badgeEl: createBadge(video), status: "idle", result: null, kind: "video", src: "" });
    resetVideoButton(video);
  }

  // A site can reuse one <video> element for the next clip: then the old result
  // no longer belongs to it, so it goes back to a "Scan this video" button.
  function checkVideosForNewClip() {
    for (const [el, st] of badgeState.entries()) {
      if (st.kind !== "video" || st.status === "collecting" || st.status === "scanning") continue;
      const now = el.currentSrc || el.src || "";
      if (st.src && now && now !== st.src) resetVideoButton(el);
    }
  }

  // Scans one image (used by the automatic queue and by the "Scan this image" button).
  async function scanOneImage(img, src) {
    const state = badgeState.get(img);
    if (state) {
      state.status = "scanning";
      state.badgeEl.className = "dfd-badge dfd-badge-scanning";
      state.badgeEl.textContent = "Scanning...";
      positionBadge(img, state.badgeEl);
    }

    try {
      const response = await sendMessageAsync({ type: "SCAN_IMAGE", url: src });
      if (response && response.ok) {
        setBadgeResult(img, response.result);
      } else {
        const message = response && response.error ? response.error : "Scan failed";
        setBadgeResult(img, { error: true, message, label: "Error", confidence_score: 0 });
        console.warn("[Verisight] scan failed:", message);
      }
    } catch (err) {
      setBadgeResult(img, { error: true, message: String(err), label: "Error", confidence_score: 0 });
      console.warn("[Verisight] scan error:", err);
    }
  }

  async function processQueue() {
    if (isProcessingQueue) return;
    isProcessingQueue = true;

    let img;
    while ((img = pickNext())) {
      const src = img.currentSrc || img.src;
      if (!src) {
        removeBadge(img);
        continue;
      }
      await scanOneImage(img, src);
    }

    isProcessingQueue = false;
  }

  // ---------------------------------------------------------------------
  // "Scan this image" buttons: used while Auto-scan is OFF. Nothing is scanned
  // until the button is clicked (so the laptop is not busy with every image).
  // ---------------------------------------------------------------------

  function resetImageButton(img) {
    const state = badgeState.get(img);
    if (!state) return;
    state.kind = "image";
    state.status = "idle";
    state.result = null;
    state.badgeEl.className = "dfd-badge dfd-badge-action";
    state.badgeEl.textContent = "Scan this image";
    state.badgeEl.title = "Click to check this image.";
    positionBadge(img, state.badgeEl);
  }

  function addImageButton(img) {
    if (badgeState.has(img)) return;
    seenImages.add(img);
    badgeState.set(img, { badgeEl: createBadge(img), status: "idle", result: null, kind: "image" });
    resetImageButton(img);
  }

  async function startImageScan(img) {
    const state = badgeState.get(img);
    if (!state || state.status === "scanning") return;
    const src = img.currentSrc || img.src;
    if (!src) {
      setBadgeResult(img, { error: true, message: "This image has no address to scan.", label: "Error", confidence_score: 0 });
      return;
    }
    state.result = null;
    closeDetailPanel();
    await scanOneImage(img, src);
  }

  // Auto-scan switched on/off from the popup while the page is open.
  function applyAutoScanChange() {
    if (autoScanEnabled) {
      // Buttons that were never clicked now join the automatic queue.
      for (const [el, st] of badgeState.entries()) {
        if (st.kind === "image" && st.status === "idle" && el.isConnected) {
          st.kind = undefined;
          st.status = "waiting";
          st.badgeEl.className = "dfd-badge dfd-badge-waiting";
          st.badgeEl.textContent = "Waiting...";
          scanQueue.push(el);
        }
      }
    } else {
      // Images still waiting in the queue go back to buttons; running scans finish.
      for (let i = scanQueue.length - 1; i >= 0; i--) {
        const el = scanQueue[i];
        const st = badgeState.get(el);
        if (st && st.status === "waiting") {
          scanQueue.splice(i, 1);
          resetImageButton(el);
        }
      }
    }
  }

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

  // ---------------------------------------------------------------------
  // Image discovery
  // ---------------------------------------------------------------------

  function isEligibleImage(img) {
    const isVideo = img instanceof HTMLVideoElement;
    if (!(img instanceof HTMLImageElement) && !isVideo) return false;
    const rect = img.getBoundingClientRect();
    const w = rect.width || (isVideo ? img.videoWidth : img.naturalWidth);
    const h = rect.height || (isVideo ? img.videoHeight : img.naturalHeight);
    return w > MIN_SIZE && h > MIN_SIZE;
  }

  const intersectionObserver = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) {
          const img = entry.target;
          if (img instanceof HTMLVideoElement) {
            // Videos always get a "Scan this video" button (never scanned automatically).
            intersectionObserver.unobserve(img);
            addVideoButton(img);
          } else {
            intersectionObserver.unobserve(img); // only need to trigger once
            // Auto-scan on: scan it by itself. Auto-scan off: show a "Scan this image" button.
            if (autoScanEnabled) enqueueScan(img);
            else addImageButton(img);
          }
        }
      }
    },
    { threshold: INTERSECTION_THRESHOLD }
  );

  function observeImage(img) {
    if (!isEligibleImage(img)) return;
    if (badgeState.has(img) || seenImages.has(img)) return;
    intersectionObserver.observe(img);
  }

  function scanExistingImages() {
    document.querySelectorAll("img, video").forEach(observeImage);
  }

  const mutationObserver = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      mutation.addedNodes.forEach((node) => {
        if (!(node instanceof HTMLElement)) return;
        if (node.tagName === "IMG" || node.tagName === "VIDEO") {
          observeImage(node);
        } else {
          node.querySelectorAll && node.querySelectorAll("img, video").forEach(observeImage);
        }
      });
      // Clean up badges for removed images.
      mutation.removedNodes.forEach((node) => {
        if (!(node instanceof HTMLElement)) return;
        if ((node.tagName === "IMG" || node.tagName === "VIDEO") && badgeState.has(node)) {
          removeBadge(node);
        } else if (node.querySelectorAll) {
          node.querySelectorAll("img, video").forEach((img) => {
            if (badgeState.has(img)) removeBadge(img);
          });
        }
      });
    }
  });

  // ---------------------------------------------------------------------
  // Init
  // ---------------------------------------------------------------------

  async function init() {
    injectStyles();

    try {
      const state = await sendMessageAsync({ type: "GET_AUTOSCAN" });
      autoScanEnabled = state && state.ok ? state.autoScan : true;
    } catch (e) {
      autoScanEnabled = true;
    }

    scanExistingImages();

    mutationObserver.observe(document.body, { childList: true, subtree: true });

    // capture:true also catches scrolling inside carousels and other scroll boxes.
    window.addEventListener("scroll", scheduleReposition, { passive: true, capture: true });
    window.addEventListener("resize", scheduleReposition, { passive: true });

    // Periodically re-check for images the observer may have missed (lazy
    // src swaps, infinite-scroll feeds that reuse DOM nodes, etc.).
    setInterval(scanExistingImages, 4000);

    // Opening or closing a post doesn't scroll the page, so refresh the badges
    // (hide the covered ones, show the uncovered ones) twice a second, and
    // wake the queue in case images were waiting behind a pop-up.
    setInterval(() => {
      scheduleReposition();
      checkVideosForNewClip();
      if (scanQueue.length && !isProcessingQueue && !processScheduled) {
        processScheduled = true;
        setTimeout(() => {
          processScheduled = false;
          processQueue();
        }, 150);
      }
    }, 500);

    // React live to the auto-scan toggle changing from the popup.
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === "local" && changes.df_autoscan) {
        autoScanEnabled = changes.df_autoscan.newValue;
        applyAutoScanChange();
      }
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
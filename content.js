(() => {
  if (window.__pixelEyedropperInjected__) return;
  window.__pixelEyedropperInjected__ = true;

  // Geometry is kept in exact integers so the zoomed canvas maps whole
  // source pixels onto whole destination cells with zero rounding drift.
  // That is what guarantees the visual center cell and the sampled pixel
  // are always the exact same pixel, with no offset.
  const ZOOM = 10; // dest px per source (real screen) pixel — must be an integer
  const SAMPLE = 15; // odd number of source pixels captured across the lens
  const HALF = Math.floor(SAMPLE / 2); // index of the center pixel (0-based)
  const DIAMETER = ZOOM * SAMPLE; // magnifier circle diameter in CSS px (150)
  // Scrolling changes what's actually behind the cursor, invalidating the
  // single cached screenshot — and re-capturing mid-session means the
  // (already revealed) magnifier must hide/show itself again, which is
  // exactly the flicker this file exists to avoid. So instead of
  // recapturing, a real scroll just cancels the session outright — clean
  // and simple, with nothing left to keep in sync. A tiny threshold (in
  // CSS px) keeps trackpad/elastic-scroll jitter from canceling by
  // accident; anything past it is treated as an intentional scroll.
  const SCROLL_CANCEL_THRESHOLD = 4;

  const state = {
    enabled: false,
    active: false,
    mouse: { x: 0, y: 0 }, // latest known cursor position — written by
                            // onMouseMove ONLY, read by tick() ONLY.
    screenImg: null,
    scale: 1,
    revealed: false, // has the magnifier ever been shown this session?
    currentHex: "#FFFFFF",
    currentRgb: "rgb(255, 255, 255)",
    lastRenderedMx: null, // last cursor position tick() actually rendered
    lastRenderedMy: null, // — the single source of truth for "did anything change"
    frameScheduled: false, // true while a tick() is queued via rAF
    rafHandle: null,
    forceRender: false, // set once, right after the one-time capture lands
    capturing: false, // guards against a duplicate capture call
    startScrollX: 0, // scroll position when the session began — used only
    startScrollY: 0, // to detect a real scroll in onScroll
    host: null,
    shadow: null,
    els: {},
  };


  // ---------- init ----------
  chrome.storage.local.get({ pickerEnabled: false }, (res) => {
    state.enabled = !!res.pickerEnabled;
  });

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg && msg.type === "TOGGLE_PICKER") {
      state.enabled = !!msg.enabled;
      if (!state.enabled) exitPicker();
    }
  });

  document.addEventListener(
    "dblclick",
    (e) => {
      if (!state.enabled || state.active) return;
      e.preventDefault();
      e.stopPropagation();
      startPicker(e.clientX, e.clientY);
    },
    true
  );

  // ---------- UI construction ----------
  function buildUI() {
    const host = document.createElement("div");
    host.id = "__pixel_eyedropper_host__";
    host.style.all = "initial";
    // Hidden from the moment it's created. It is made visible exactly
    // once, in tick(), the instant the first real frame (correct
    // position + correct zoom content + correct color) is ready — so the
    // magnifier never has a "wrong" or empty state to be seen in, and is
    // never toggled hidden→visible→hidden again after that single reveal.
    host.style.visibility = "hidden";
    document.documentElement.appendChild(host);

    const shadow = host.attachShadow({ mode: "open" });
    shadow.innerHTML = `
      <style>
        * { box-sizing: border-box; }
        .overlay {
          position: fixed;
          inset: 0;
          z-index: 2147483647;
          cursor: none;
          font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Arial, sans-serif;
        }
        .magnifier {
          position: fixed;
          left: 0;
          top: 0;
          width: ${DIAMETER}px;
          height: ${DIAMETER}px;
          border-radius: 50%;
          overflow: hidden;
          border: 3px solid #ffffff;
          box-shadow:
            0 0 0 1px rgba(0,0,0,0.35),
            0 10px 30px rgba(0,0,0,0.45);
          pointer-events: none;
          background: #111;
          image-rendering: pixelated;
          will-change: transform;
        }
        .magnifier canvas {
          display: block;
          image-rendering: pixelated;
          image-rendering: crisp-edges;
        }
        .info {
          position: fixed;
          pointer-events: none;
          background: rgba(20, 20, 28, 0.92);
          backdrop-filter: blur(6px);
          border: 1px solid rgba(255,255,255,0.12);
          border-radius: 12px;
          padding: 8px 12px;
          color: #f2f2f5;
          font-size: 12px;
          display: flex;
          align-items: center;
          gap: 10px;
          box-shadow: 0 8px 24px rgba(0,0,0,0.4);
          white-space: nowrap;
        }
        .info .swatch {
          width: 22px;
          height: 22px;
          border-radius: 6px;
          border: 2px solid rgba(255,255,255,0.6);
          flex-shrink: 0;
        }
        .info .text {
          display: flex;
          flex-direction: column;
          gap: 2px;
          font-family: "SF Mono", Menlo, Consolas, monospace;
        }
        .info .hex {
          font-weight: 700;
          font-size: 13px;
          letter-spacing: 0.3px;
        }
        .info .rgb {
          font-size: 11px;
          color: #b3b3c2;
        }
        .badge {
          position: fixed;
          top: 18px;
          left: 50%;
          transform: translateX(-50%);
          background: rgba(20, 20, 28, 0.92);
          border: 1px solid rgba(255,255,255,0.12);
          color: #f2f2f5;
          padding: 8px 16px;
          border-radius: 999px;
          font-size: 12.5px;
          font-weight: 600;
          box-shadow: 0 8px 24px rgba(0,0,0,0.4);
          pointer-events: none;
        }
        .badge kbd {
          background: rgba(255,255,255,0.12);
          border-radius: 4px;
          padding: 1px 6px;
          margin: 0 2px;
          font-size: 11px;
        }
        .copied {
          position: fixed;
          pointer-events: none;
          background: linear-gradient(135deg, #46c878, #3c96ff);
          color: #0c0c12;
          font-weight: 700;
          font-size: 12px;
          padding: 6px 12px;
          border-radius: 999px;
          box-shadow: 0 8px 20px rgba(0,0,0,0.4);
          opacity: 0;
          transform: translate(-50%, -8px) scale(0.9);
          transition: opacity 0.18s ease, transform 0.18s ease;
        }
        .copied.show {
          opacity: 1;
          transform: translate(-50%, -18px) scale(1);
        }
      </style>
      <div class="overlay">
        <div class="badge">Move to inspect &middot; Click to copy &middot; <kbd>Esc</kbd> to cancel</div>
        <div class="magnifier"><canvas width="${DIAMETER}" height="${DIAMETER}"></canvas></div>
        <div class="info">
          <div class="swatch"></div>
          <div class="text">
            <div class="hex">#FFFFFF</div>
            <div class="rgb">rgb(255, 255, 255)</div>
          </div>
        </div>
        <div class="copied">Copied!</div>
      </div>
    `;

    state.host = host;
    state.shadow = shadow;
    state.els.overlay = shadow.querySelector(".overlay");
    state.els.magnifier = shadow.querySelector(".magnifier");
    state.els.canvas = shadow.querySelector(".magnifier canvas");
    state.els.ctx = state.els.canvas.getContext("2d", { willReadFrequently: true });
    state.els.ctx.imageSmoothingEnabled = false;
    state.els.info = shadow.querySelector(".info");
    state.els.swatch = shadow.querySelector(".info .swatch");
    state.els.hex = shadow.querySelector(".info .hex");
    state.els.rgb = shadow.querySelector(".info .rgb");
    state.els.copied = shadow.querySelector(".copied");
  }

  // ---------- picker lifecycle ----------
  function startPicker(x, y) {
    // Guard against re-entry: even though the dblclick handler already
    // checks state.active, this keeps startPicker itself safe against
    // ever being called twice in a row, which is what would cause
    // duplicate DOM/listeners.
    if (state.active) return;
    state.active = true;
    state.mouse = { x, y };
    buildUI(); // DOM (including the canvas) is created exactly once per
               // session and never touched again by movement, capture,
               // or rendering — only its transform/content are updated.

    // Listeners are attached exactly once per session (added here, removed
    // in exitPicker), so they can never stack even across repeated
    // start/stop cycles.
    document.addEventListener("mousemove", onMouseMove, true);
    state.els.overlay.addEventListener("click", onClick);
    document.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("blur", exitPicker);
    // capture: true so this also catches scrolling inside any nested
    // scrollable container, not just the main document — scroll events
    // don't bubble, but they do fire during the capture phase.
    state.startScrollX = window.scrollX;
    state.startScrollY = window.scrollY;
    window.addEventListener("scroll", onScroll, { capture: true, passive: true });

    // Position it correctly right away so that whenever it's revealed
    // (see tick()/buildUI()) it's already exactly where the cursor is —
    // never a jump, never a stale frame.
    positionAt(x, y);

    // The screen is captured exactly ONCE per session, right here. A real
    // scroll cancels the session instead of triggering a recapture (see
    // onScroll) — nothing ever recaptures, on a timer, on scroll, or
    // because of cursor movement alone. That's what guarantees the
    // magnifier never needs to hide/show itself again after this point.
    captureScreen();
  }

  // Schedules exactly one tick() if none is already pending. This is the
  // ONLY place a frame ever gets scheduled — called from onMouseMove
  // (real cursor movement) and once from the capture callback (so the
  // first frame gets painted even if the cursor hasn't moved since
  // startPicker). There is exactly one requestAnimationFrame pipeline in
  // this file; nothing else ever calls requestAnimationFrame for
  // rendering, and nothing uses setInterval.
  function requestRenderTick() {
    if (state.frameScheduled) return;
    state.frameScheduled = true;
    state.rafHandle = requestAnimationFrame(tick);
  }

  // The single per-frame rendering step:
  //   read the latest stored cursor position
  //     → if nothing changed and there's no fresh data, do nothing
  //     → otherwise update position, then update zoom content + center
  //       pixel color (inside render()), then (first time only) reveal
  // Never invoked directly — only ever via requestAnimationFrame from
  // requestRenderTick(), and only one is ever in flight at a time, so
  // there is no possibility of two renders overlapping or racing.
  function tick() {
    state.frameScheduled = false;
    state.rafHandle = null;
    if (!state.active) return;

    const { x: mx, y: my } = state.mouse;
    const moved = mx !== state.lastRenderedMx || my !== state.lastRenderedMy;

    // If nothing changes, do not render anything — no position write, no
    // canvas redraw, no re-sample, no DOM touch of any kind. This is what
    // keeps the magnifier perfectly still (zero CPU work) the instant the
    // cursor stops.
    if (!moved && !state.forceRender) return;

    if (moved) positionAt(mx, my);
    state.lastRenderedMx = mx;
    state.lastRenderedMy = my;
    state.forceRender = false;

    const ok = render(); // updates zoom preview + center pixel color

    // Reveal on the very first successful render, and never again after
    // that — the magnifier simply appears already correctly positioned
    // and colored. Nothing is ever hidden again once shown.
    if (ok && !state.revealed) {
      state.revealed = true;
      state.host.style.visibility = "visible";
    }
  }

  function exitPicker() {
    if (!state.active) return;
    state.active = false;

    document.removeEventListener("mousemove", onMouseMove, true);
    document.removeEventListener("keydown", onKeyDown, true);
    window.removeEventListener("blur", exitPicker);
    window.removeEventListener("scroll", onScroll, { capture: true });

    if (state.rafHandle) {
      cancelAnimationFrame(state.rafHandle);
      state.rafHandle = null;
    }
    state.frameScheduled = false;

    if (state.host && state.host.parentNode) {
      state.host.parentNode.removeChild(state.host);
    }
    state.host = null;
    state.shadow = null;
    state.screenImg = null;
    state.els = {};
    state.revealed = false;
    state.forceRender = false;
    state.capturing = false;
    state.lastRenderedMx = null;
    state.lastRenderedMy = null;
  }

  function onKeyDown(e) {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      exitPicker();
    }
  }

  function onMouseMove(e) {
    // The ENTIRE job of this handler: store the latest coordinates.
    // No DOM writes, no capture requests, no rendering — that is the
    // exact pipeline required (mouse movement → store latest coordinates
    // → requestAnimationFrame → update position → update zoom preview →
    // update center pixel). This can fire at native event rate with
    // negligible cost.
    state.mouse.x = e.clientX;
    state.mouse.y = e.clientY;
    requestRenderTick();
  }

  function onScroll(e) {
    if (!state.active) return;

    if (e.target === document) {
      // Main-page scroll: only cancel past a tiny threshold, so elastic
      // bounce / trackpad jitter at the top of the page doesn't cancel
      // the session by accident.
      const dx = Math.abs(window.scrollX - state.startScrollX);
      const dy = Math.abs(window.scrollY - state.startScrollY);
      if (dx <= SCROLL_CANCEL_THRESHOLD && dy <= SCROLL_CANCEL_THRESHOLD) return;
    }
    // Any scroll inside a nested scrollable container also invalidates
    // what's behind the cursor — cancel immediately rather than trying
    // to recapture and re-hide/show the magnifier mid-session.
    exitPicker();
  }

  function onClick(e) {
    e.preventDefault();
    e.stopPropagation();
    const hex = state.currentHex;
    const rgb = state.currentRgb;

    copyToClipboard(hex);
    chrome.storage.local.set({ lastColor: { hex, rgb } });
    showCopied(state.mouse.x, state.mouse.y);

    setTimeout(exitPicker, 650);
  }

  function copyToClipboard(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).catch(() => fallbackCopy(text));
    } else {
      fallbackCopy(text);
    }
  }

  function fallbackCopy(text) {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    try {
      document.execCommand("copy");
    } catch (err) {
      /* no-op */
    }
    document.body.removeChild(ta);
  }

  function showCopied(x, y) {
    const el = state.els.copied;
    if (!el) return;
    el.style.left = x + "px";
    el.style.top = y - DIAMETER / 2 - 30 + "px";
    el.classList.add("show");
    setTimeout(() => {
      if (el) el.classList.remove("show");
    }, 600);
  }

  // ---------- positioning ----------
  function positionAt(x, y) {
    const vh = window.innerHeight;

    // The lens is centered exactly on the real mouse coordinate — this is
    // the single source of truth for what pixel is being sampled. It is
    // never nudged or offset, so what's under the center of the ring is
    // always exactly what gets sampled and copied.
    const mx = x - DIAMETER / 2;
    const my = y - DIAMETER / 2;

    // transform: translate is compositor-only — it never triggers layout
    // or paint the way animating left/top does — so this is what keeps
    // the magnifier's motion smooth even on a busy page.
    state.els.magnifier.style.transform = `translate(${mx}px, ${my}px)`;

    // Only the (purely informational) info panel is nudged to stay
    // on-screen; this never affects sampling.
    let ix = mx;
    let iy = my + DIAMETER + 10;
    if (iy + 50 > vh) iy = my - DIAMETER / 2 - 44;
    state.els.info.style.left = ix + "px";
    state.els.info.style.top = iy + "px";
  }

  // ---------- capture (one-shot, never repeated) ----------
  // Captures the visible tab exactly once per session, called only from
  // startPicker(). There is no periodic recapture, no interval, and no
  // recapture-on-scroll — a real scroll cancels the session instead (see
  // onScroll) — so this function only ever runs once, while the host is
  // still hidden (see buildUI), which is what guarantees the magnifier
  // never needs to hide/show itself, ever, for the rest of the session.
  function captureScreen(attempt) {
    if (!state.active || state.capturing) return;
    state.capturing = true;

    try {
      chrome.runtime.sendMessage({ type: "CAPTURE_TAB" }, (res) => {
        state.capturing = false;
        if (!state.active) return;

        if (chrome.runtime.lastError || !res || res.error || !res.dataUrl) {
          // One quiet retry for a transient failure (e.g. the tab wasn't
          // fully painted yet) — capped so this can never become a loop.
          if ((attempt || 0) < 1) setTimeout(() => captureScreen(1), 150);
          return;
        }

        const img = new Image();
        img.onload = () => {
          if (!state.active) return;
          // Sanity-check the decoded bitmap before trusting it — a
          // corrupt/incomplete capture (blank, wrong size, etc.) is
          // discarded rather than used to paint a broken frame.
          if (!img.naturalWidth || !img.naturalHeight) return;
          state.screenImg = img;
          state.scale = img.width / window.innerWidth;
          // Force exactly one render even though the cursor may not have
          // moved since startPicker — this is what paints (and reveals)
          // the very first frame.
          state.forceRender = true;
          requestRenderTick();
        };
        img.onerror = () => {
          if ((attempt || 0) < 1) setTimeout(() => captureScreen(1), 150);
        };
        img.src = res.dataUrl;
      });
    } catch (err) {
      // e.g. "Extension context invalidated" if the service worker was
      // torn down mid-flight.
      state.capturing = false;
    }
  }

  // ---------- render ----------
  // Called at most once per animation frame, only from tick(), and only
  // when tick() has already determined a redraw is actually warranted
  // (movement or fresh capture data) — so there is never more than one
  // render in flight, and never a render for an unchanged frame.
  // Returns true iff the frame was fully drawn and the color fully
  // sampled — tick() uses this to know when it's safe to reveal the
  // magnifier for the first time.
  function render() {
    if (!state.active || !state.screenImg || !state.els.ctx) return false;

    const { x, y } = state.mouse;
    const scale = state.scale;

    // The exact source (screenshot) pixel under the real mouse cursor.
    // This single coordinate is the only thing ever used for the sampled
    // color — nothing is averaged and nothing else is read.
    const srcX = Math.round(x * scale);
    const srcY = Math.round(y * scale);

    // Because SAMPLE and ZOOM are both integers and DIAMETER = SAMPLE * ZOOM,
    // this crop always lands on exact pixel boundaries. Away from the
    // viewport edges, source pixel (srcX, srcY) sits at index HALF — the
    // middle of the SAMPLE x SAMPLE grid — which maps to the canvas
    // center. Near an edge the crop origin gets clamped so it never reads
    // past the bitmap, so the index is derived from the *actual* crop
    // origin instead of being assumed to always be HALF — this keeps the
    // highlighted/sampled cell exactly equal to the real cursor pixel in
    // every case, edges included.
    const sx = clamp(srcX - HALF, 0, state.screenImg.width - SAMPLE);
    const sy = clamp(srcY - HALF, 0, state.screenImg.height - SAMPLE);
    const indexX = srcX - sx;
    const indexY = srcY - sy;

    const ctx = state.els.ctx;
    ctx.imageSmoothingEnabled = false;
    ctx.clearRect(0, 0, DIAMETER, DIAMETER);

    try {
      ctx.drawImage(state.screenImg, sx, sy, SAMPLE, SAMPLE, 0, 0, DIAMETER, DIAMETER);
    } catch (err) {
      return false;
    }

    // Read the color immediately, straight off the freshly drawn image and
    // before any grid lines or highlight box are drawn on top — this is
    // the single source of truth for the selected color, read from the
    // exact cell that corresponds to source pixel (srcX, srcY).
    const cellSize = ZOOM; // one source pixel = exactly ZOOM canvas px
    const cellX = indexX * cellSize;
    const cellY = indexY * cellSize;
    const readX = Math.min(Math.max(Math.round(cellX + cellSize / 2), 0), DIAMETER - 1);
    const readY = Math.min(Math.max(Math.round(cellY + cellSize / 2), 0), DIAMETER - 1);

    let data;
    try {
      data = ctx.getImageData(readX, readY, 1, 1).data;
    } catch (err) {
      return false;
    }

    const [r, g, b] = data;
    const hex = rgbToHex(r, g, b);
    const rgbStr = `rgb(${r}, ${g}, ${b})`;

    // Skip the DOM writes entirely when the color hasn't changed since the
    // last frame — this is the common case while the cursor sits still or
    // glides across a single-color area, and avoids needless style/text
    // updates on every one of the 60 frames per second.
    if (hex !== state.currentHex) {
      state.currentHex = hex;
      state.currentRgb = rgbStr;

      state.els.hex.textContent = hex.toUpperCase();
      state.els.rgb.textContent = rgbStr;
      state.els.swatch.style.background = hex;
    }

    // ---- Everything below is purely visual and drawn AFTER the sample
    // ---- has already been read, so it can never affect the picked color.

    // subtle pixel grid for clarity
    ctx.strokeStyle = "rgba(0,0,0,0.12)";
    ctx.lineWidth = 1;
    for (let i = 1; i < SAMPLE; i++) {
      const p = i * cellSize + 0.5;
      ctx.beginPath();
      ctx.moveTo(p, 0);
      ctx.lineTo(p, DIAMETER);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(0, p);
      ctx.lineTo(DIAMETER, p);
      ctx.stroke();
    }

    // Highlight the center cell — it represents exactly one real screen
    // pixel (cellSize x cellSize canvas px), aligned pixel-perfectly to
    // the sampled pixel.
    ctx.save();
    ctx.shadowColor = "rgba(0,0,0,0.5)";
    ctx.shadowBlur = 4;
    ctx.lineWidth = 2;
    ctx.strokeStyle = "#ffffff";
    ctx.strokeRect(cellX + 1, cellY + 1, cellSize - 2, cellSize - 2);
    ctx.restore();

    ctx.lineWidth = 1;
    ctx.strokeStyle = "#000000";
    ctx.strokeRect(cellX + 0.5, cellY + 0.5, cellSize - 1, cellSize - 1);

    // small crosshair ticks radiating from the highlighted cell
    ctx.strokeStyle = "#ffffff";
    ctx.lineWidth = 1.5;
    const tick = 6;
    ctx.beginPath();
    ctx.moveTo(cellX + cellSize / 2, cellY - tick);
    ctx.lineTo(cellX + cellSize / 2, cellY - 1);
    ctx.moveTo(cellX + cellSize / 2, cellY + cellSize + 1);
    ctx.lineTo(cellX + cellSize / 2, cellY + cellSize + tick);
    ctx.moveTo(cellX - tick, cellY + cellSize / 2);
    ctx.lineTo(cellX - 1, cellY + cellSize / 2);
    ctx.moveTo(cellX + cellSize + 1, cellY + cellSize / 2);
    ctx.lineTo(cellX + cellSize + tick, cellY + cellSize / 2);
    ctx.stroke();

    return true;
  }

  function rgbToHex(r, g, b) {
    const h = (n) => n.toString(16).padStart(2, "0");
    return `#${h(r)}${h(g)}${h(b)}`;
  }

  function clamp(v, min, max) {
    return Math.min(Math.max(v, min), max);
  }
})();

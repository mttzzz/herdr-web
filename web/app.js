/*
 * herdr-web client. Mirrors the WS protocol implemented by server/server.ts:
 *   binary out : raw input bytes
 *   text out   : {"t":"resize","cols":N,"rows":M} | {"t":"metrics",…} | {"t":"miss","id":N}
 *                | {"t":"ack","n":N} (terminal bytes parsed on this socket: flow control)
 *   binary in  : 0x00 | terminal bytes            -> term.write
 *                0x01 | u32le jsonLen | ops json  -> kitty view (pixels: GET op.url)
 *   text in    : {"t":"hello","prefix":"ctrl+b","gen":G,"seq":N,"resumed":B,"missed":M} on
 *                open, {"t":"snapshot","seq":N,"frames":2} before a snapshot of the screen,
 *                {"t":"exit","code":N} at the end
 *
 * Image bytes never pass through xterm.js, nor through the WebSocket: the server cuts the
 * kitty APC out of the stream and the page fetches the pixels by URL.
 */
(() => {
  "use strict";

  /* ---------- token ---------- */

  const params = new URLSearchParams(location.search);
  const token = params.get("token") || "";
  if (token) {
    /* The server has planted the cookie by now; keep the address bar clean so the
     * token doesn't leak via screenshots/history. WS reconnects use the JS copy. */
    history.replaceState(null, "", location.pathname);
  }

  /* ---------- terminal ---------- */

  const FONT = '"JetBrainsMono Nerd Web", monospace';
  let fontSize = parseInt(localStorage.getItem("herdr-web-font-size") || "14", 10) || 14;

  const term = new Terminal({
    fontFamily: FONT,
    fontSize,
    allowProposedApi: true,
    scrollback: 0 /* herdr scrolls itself; xterm's own scrollback only fights it */,
    theme: { background: "#0d1117" },
  });

  const fit = new FitAddon.FitAddon();
  term.loadAddon(fit);

  const unicode11 = new Unicode11Addon.Unicode11Addon();
  term.loadAddon(unicode11);
  term.unicode.activeVersion = "11";

  /* OSC 52: herdr auto-copies its selections by emitting \x1b]52;c;<b64> to every
   * client. The stock provider uses navigator.clipboard, which only exists in
   * secure contexts (https / localhost) — over plain LAN HTTP fall back to the
   * hidden-textarea + execCommand("copy") trick (still allowed on user gesture,
   * and the copy always lands right after a selection mouseup). */
  const clipboardProvider = {
    async readText(sel) {
      if (sel !== "c" || !navigator.clipboard?.readText) return "";
      try {
        return await navigator.clipboard.readText();
      } catch {
        return "";
      }
    },
    async writeText(sel, text) {
      if (sel !== "c") return;
      if (navigator.clipboard?.writeText) {
        try {
          await navigator.clipboard.writeText(text);
          return;
        } catch {} /* permission denied -> try the legacy path */
      }
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.setAttribute("readonly", "");
      ta.style.cssText = "position:fixed;top:0;left:0;opacity:0;pointer-events:none";
      document.body.appendChild(ta);
      const prev = document.activeElement;
      ta.focus();
      ta.select();
      try {
        document.execCommand("copy");
      } catch {}
      ta.remove();
      if (prev && typeof prev.focus === "function") prev.focus();
    },
  };
  term.loadAddon(new ClipboardAddon.ClipboardAddon(undefined, clipboardProvider));

  /* Links in pane output are clickable. Through a browser that is the only way to reach an
   * address printed in the terminal: the server's clipboard belongs to the herdr machine, not
   * to this device, and herdr does not forward a pane's OSC 52. */
  if (window.WebLinksAddon?.WebLinksAddon) {
    term.loadAddon(new WebLinksAddon.WebLinksAddon((event, uri) => window.open(uri, "_blank", "noopener")));
  }

  const termEl = document.getElementById("term");
  term.open(termEl);

  /* Kitty graphics: the server hands over ready operations, this paints them on one canvas
   * over the cell grid (xterm.js never sees an image byte). */
  const kittyLayerHost = () => termEl.querySelector(".xterm-screen") ?? termEl;
  const cellSize = () => {
    /* No public API for the css cell size in xterm 6.0; @xterm/addon-fit reads the same
     * private field (src/FitAddon.ts:41). */
    const d = term._core?._renderService?.dimensions?.css?.cell;
    if (d?.width && d?.height) return { w: d.width, h: d.height };
    const screen = kittyLayerHost();
    if (screen && term.cols && term.rows) {
      return { w: screen.clientWidth / term.cols, h: screen.clientHeight / term.rows };
    }
    return { w: 8, h: 16 };
  };
  const kitty = HerdrKittyView.createKittyView({
    mount: kittyLayerHost(),
    getCell: cellSize,
    getGrid: () => ({ cols: term.cols, rows: term.rows }),
    onMiss: (id) => sendJson({ t: "miss", id }),
  });

  /* Geometry follows the grid: a repaint or a reflow moves every placement. */
  term.onRender(() => kitty.invalidate());
  term.onResize(() => {
    kitty.invalidate();
    sendMetrics();
  });

  window.__term = term; /* debug handle (page is token-gated anyway) */
  window.__kittyView = kitty;

  /* Right-click belongs to herdr (xterm reports button-3 to the PTY on mousedown);
   * without this the browser's own context menu opens on top of herdr's. */
  termEl.addEventListener("contextmenu", (e) => e.preventDefault());

  /* Touch gestures. herdr is a mouse-tracking alt-screen app: it scrolls on wheel
   * reports and opens its menus on button 3 — xterm.js turns neither touch drags nor
   * long presses into those. Vertical drags become synthetic line-wheel events at the
   * finger (herdr scrolls the pane under the pointer); a press held still becomes a
   * synthetic right click, since touch devices have no second mouse button. Plain
   * taps stay taps: the engine's own compat mouse events keep doing left click and
   * focus (that's what raises the iOS keyboard). */
  {
    const LONG_PRESS_MS = 450; /* under the ~500ms iOS/Android system recognizers */
    const LONG_PRESS_SLOP = 10; /* px of drift still counted as "held still" */

    let touchY = null;
    let startX = 0;
    let startY = 0;
    let wheelAcc = 0;
    let scrolled = false;
    let pressTimer = 0;
    let longPressed = false;

    const lineStep = () => Math.max(12, Math.round(fontSize * 1.4)); /* ~cell height px */
    const screenEl = () => termEl.querySelector(".xterm-screen") ?? termEl;

    /* xterm only reports button 3 off real mouse events, and it attaches its mouseup
     * listener to the document while handling the mousedown — so the pair has to go
     * out back to back. */
    function rightClick(x, y) {
      const at = { clientX: x, clientY: y, button: 2, bubbles: true, cancelable: true, view: window };
      const target = screenEl();
      target.dispatchEvent(new MouseEvent("mousedown", { ...at, buttons: 2 }));
      target.dispatchEvent(new MouseEvent("mouseup", { ...at, buttons: 0 }));
    }

    function cancelLongPress() {
      clearTimeout(pressTimer);
      pressTimer = 0;
    }

    termEl.addEventListener(
      "touchstart",
      (e) => {
        cancelLongPress();
        if (e.touches.length !== 1) {
          touchY = null;
          return;
        }
        const t = e.touches[0];
        startX = t.clientX;
        startY = t.clientY;
        touchY = t.clientY;
        wheelAcc = 0;
        scrolled = false;
        longPressed = false;
        pressTimer = setTimeout(() => {
          pressTimer = 0;
          longPressed = true;
          touchY = null; /* the rest of the gesture belongs to the menu, not to scrolling */
          navigator.vibrate?.(12); /* the only feedback that the press registered */
          rightClick(startX, startY);
        }, LONG_PRESS_MS);
      },
      { passive: true },
    );

    termEl.addEventListener(
      "touchmove",
      (e) => {
        if (e.touches.length !== 1) return;
        const t = e.touches[0];
        if (
          pressTimer &&
          (Math.abs(t.clientX - startX) > LONG_PRESS_SLOP || Math.abs(t.clientY - startY) > LONG_PRESS_SLOP)
        ) {
          cancelLongPress(); /* it's a scroll, not a press */
        }
        if (touchY === null) {
          if (longPressed) e.preventDefault();
          return;
        }
        wheelAcc += touchY - t.clientY; /* finger up -> positive deltaY -> scroll down */
        touchY = t.clientY;
        const step = lineStep();
        const target = screenEl();
        while (Math.abs(wheelAcc) >= step) {
          const dir = Math.sign(wheelAcc);
          wheelAcc -= dir * step;
          scrolled = true;
          target.dispatchEvent(
            new WheelEvent("wheel", {
              deltaY: dir,
              deltaMode: 1 /* DOM_DELTA_LINE: one report per step, independent of cell px */,
              clientX: t.clientX,
              clientY: t.clientY,
              bubbles: true,
              cancelable: true,
            }),
          );
        }
        e.preventDefault(); /* keep the browser from panning / pull-to-refresh */
      },
      { passive: false },
    );

    function endTouch(e) {
      cancelLongPress();
      /* A scroll gesture must not click-focus a pane, and the long press already sent
       * its click — cancelling the touch is what stops the engine from synthesizing a
       * left click on top of the menu that just opened. */
      if (scrolled || longPressed) e.preventDefault();
      touchY = null;
      longPressed = false;
    }

    termEl.addEventListener("touchend", endTouch, { passive: false });
    termEl.addEventListener("touchcancel", endTouch, { passive: false });
  }

  let webgl = null;
  try {
    webgl = new WebglAddon.WebglAddon();
    webgl.onContextLoss(() => {
      /* iPad Safari likes to drop GL contexts; fall back to the canvas renderer. */
      try { webgl.dispose(); } catch {}
      webgl = null;
    });
    term.loadAddon(webgl);
    window.__webgl = webgl; /* debug handle, like __term */
    /* addon-webgl 0.19.0 draws wrong letters after its glyph atlas merges pages a second time:
     * the merged page lands in a texture slot whose recorded version already matches, so it is
     * never uploaded and its glyphs sample the previous merged page — until a reload. Fixed
     * upstream (xterm.js PR 5883) only in the beta line. A merge removes pages; on the next
     * frame a theme change makes the renderer upload every page again: 162-434 wrong cells of
     * 2256 after 8 merges without this, 0 with it. */
    let reupload = 0;
    webgl.onRemoveTextureAtlasCanvas(() => {
      if (reupload) return;
      reupload = requestAnimationFrame(() => {
        reupload = 0;
        term.options.theme = { ...term.options.theme };
      });
    });
  } catch {
    webgl = null;
  }

  /* ---------- websocket ---------- */

  const overlay = document.getElementById("overlay");
  const overlayMsg = document.getElementById("overlay-msg");
  const encoder = new TextEncoder();
  let ws = null;

  /* Who this tab is, across reloads: sessionStorage belongs to the tab. The server keeps a
   * tab's herdr client for a few seconds after its socket closes and gives it back to the same
   * tab, so a reload or a dropped socket skips a new herdr attach (15–350 ms). A duplicated tab
   * inherits the id; the server then tells one of the two to pick another (close code 4000).
   * crypto.randomUUID is secure-context only, and the mirror is plain http on the LAN. */
  const TAB_KEY = "herdr-web-tab";
  const CLOSE_TAKEN_OVER = 4000;
  function newTabId() {
    const b = crypto.getRandomValues(new Uint8Array(16));
    return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
  }
  let tabId = "";
  try {
    tabId = sessionStorage.getItem(TAB_KEY) || "";
  } catch {} /* storage blocked: the id lives as long as the page */
  function setTabId(id) {
    tabId = id;
    try {
      sessionStorage.setItem(TAB_KEY, id);
    } catch {}
  }
  if (!/^[0-9a-f]{32}$/.test(tabId)) setTabId(newTabId());

  /* Where this page stands in its seat's stream, from the server's hello: the numbering (`gen`)
   * and the number of the next binary frame. A page that lost only its socket keeps its screen
   * and asks for the frames after it (`?resume=`), so herdr does not repaint; a reload starts
   * from nothing, so this lives in memory only. */
  let stream = null;

  function wsUrl() {
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    /* v=3 = "tagged frames, pixels by URL". A tab still running an older bundle (left open
     * across a deploy, or a stale PWA cache) sends v=2 or nothing, and the server keeps
     * speaking what that bundle expects instead of corrupting its grid. */
    const q = new URLSearchParams({ cols: String(term.cols), rows: String(term.rows), v: "3", tab: tabId });
    if (stream) q.set("resume", `${stream.gen}.${stream.seq}`);
    if (token) q.set("token", token);
    return `${proto}//${location.host}/ws?${q}`;
  }

  function send(bytes) {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(bytes);
  }

  function sendJson(obj) {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
  }

  function sendMetrics() {
    const cell = cellSize();
    sendJson({
      t: "metrics",
      cellW: Math.round(cell.w) || 8,
      cellH: Math.round(cell.h) || 16,
      cols: term.cols,
      rows: term.rows,
      dpr: window.devicePixelRatio || 1,
    });
  }

  const TAG_TERM = 0x00;
  const TAG_OPS = 0x01;

  /* Flow control: the server holds herdr back while this page has more than a few hundred KB
   * not parsed yet (server/server.ts, FLOW_HIGH), so it is told what the terminal has parsed,
   * per socket. `sock` keeps the previous socket's late callbacks out of the new count. */
  let sock = 0;
  let parsed = 0;
  let ackPending = false;
  function parsedBytes(s, n) {
    if (s !== sock) return;
    parsed += n;
    if (ackPending) return;
    ackPending = true;
    setTimeout(() => {
      ackPending = false;
      sendJson({ t: "ack", n: parsed });
    }, 0);
  }

  function handleFrame(buffer) {
    const tag = new Uint8Array(buffer, 0, 1)[0];
    if (tag === TAG_TERM) {
      const bytes = new Uint8Array(buffer, 1);
      const s = sock;
      try {
        term.write(bytes, () => parsedBytes(s, bytes.length));
      } catch (err) {
        /* xterm throws once its write buffer passes 50 MB of unparsed input, and after
         * that the terminal is dead until reload — resync instead. */
        console.error("[ws] terminal write failed, resyncing:", err);
        resync();
      }
      return;
    }
    if (tag !== TAG_OPS) return;
    const jsonLen = new DataView(buffer).getUint32(1, true);
    let ops;
    try {
      ops = JSON.parse(new TextDecoder().decode(new Uint8Array(buffer, 5, jsonLen))).ops;
    } catch (err) {
      console.error("[ws] bad image frame:", err);
      return;
    }
    kitty.applyOps(ops);
  }

  /* Backoff so a server restart does not turn into a reload-by-hand ritual, and a phone
   * waking up from sleep finds the pane on its own. The first retry goes at once: a dropped
   * socket (Wi-Fi blip, a mirror restart) is back in milliseconds instead of half a second.
   * Only a retry that has to wait shows the overlay, and the backoff resets only once herdr
   * has sent a frame, so a server that accepts and drops the socket cannot spin this loop. */
  const RECONNECT_STEPS = [0, 500, 1000, 2000, 4000, 8000];
  let reconnectAt = 0;
  let reconnectTimer = 0;
  let closing = false;

  function scheduleReconnect() {
    if (reconnectTimer) return;
    const delay = RECONNECT_STEPS[Math.min(reconnectAt, RECONNECT_STEPS.length - 1)];
    reconnectAt++;
    if (delay > 0) {
      overlayMsg.textContent = `reconnecting in ${Math.round(delay / 1000)}s — tap to retry now`;
      overlay.classList.add("show");
    }
    reconnectTimer = setTimeout(() => {
      reconnectTimer = 0;
      connect();
    }, delay);
  }

  function resync() {
    closing = true;
    try {
      ws?.close();
    } catch {}
    ws = null;
    stream = null; /* what broke is the terminal: a full repaint, not the frames it missed */
    kitty.clear();
    closing = false;
    scheduleReconnect();
  }

  function connect() {
    clearTimeout(reconnectTimer);
    reconnectTimer = 0;
    overlay.classList.remove("show");
    fit.fit();
    prefixPending = false; /* a freshly spawned herdr client starts outside prefix mode */
    ws = new WebSocket(wsUrl());
    ws.binaryType = "arraybuffer";
    sock++;
    parsed = 0;

    ws.onopen = () => {
      sendMetrics();
      sendJson({ t: "ack", n: 0 }); /* this page tells what it parsed: flow control on */
    };

    ws.onmessage = (ev) => {
      if (typeof ev.data === "string") {
        try {
          const ctl = JSON.parse(ev.data);
          if (ctl && ctl.t === "exit") {
            overlayMsg.textContent =
              ctl.code === -1
                ? "herdr failed to start — check server log, tap to retry"
                : "detached — reconnecting";
          }
          if (ctl && ctl.t === "hello") {
            if (typeof ctl.prefix === "string") prefixChord = parseChord(ctl.prefix);
            /* Not resumed: the whole screen follows, so the overlay state goes, or a stale image
             * would hang over the new grid. A server older than resume says nothing. */
            if (ctl.resumed !== true) kitty.clear();
            /* a resumed stream may have missed nothing, so no frame says herdr is up: this does */
            else reconnectAt = 0;
            stream = typeof ctl.gen === "string" && Number.isInteger(ctl.seq) ? { gen: ctl.gen, seq: ctl.seq } : null;
          }
          if (ctl && ctl.t === "snapshot" && stream && Number.isInteger(ctl.seq)) {
            /* the next `frames` binary frames show the screen as of frame `seq`: after them the
             * count goes on from there, whatever this page skipped */
            stream.seq = ctl.seq - (ctl.frames | 0);
          }
        } catch {}
        return;
      }
      reconnectAt = 0; /* herdr is up: the next drop gets an immediate retry again */
      if (stream) stream.seq++;
      handleFrame(ev.data);
    };

    ws.onclose = (ev) => {
      ws = null;
      if (closing) return;
      if (ev.code === CLOSE_TAKEN_OVER) {
        setTabId(newTabId());
        stream = null;
      }
      scheduleReconnect();
    };
  }

  overlay.addEventListener("click", () => {
    reconnectAt = 0;
    clearTimeout(reconnectTimer);
    reconnectTimer = 0;
    overlayMsg.textContent = "disconnected — tap to reconnect";
    if (!ws) connect();
    term.focus();
  });

  /* ---------- input ---------- */

  term.onData((s) => send(encoder.encode(s)));

  term.onBinary((s) => {
    const b = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i) & 0xff;
    send(b);
  });

  /* ---------- keyboard: commands travel by physical key ----------
   * herdr resolves its keybindings from the character the layout produced, so with a
   * Cyrillic (or any non-Latin) layout on, "prefix s" arrives as "prefix ы" and nothing
   * fires. Its own escape hatch (experimental.switch_ascii_input_source_in_prefix)
   * switches the *host* OS input source, which a browser client doesn't have; herdr does
   * ask the outer terminal for kitty alternate keys (CSI > 7 u), but it ignores the
   * base-layout field in the reply (measured on 0.8.0). So the mirror resolves the
   * position itself: KeyboardEvent.code says which character the key carries in the US
   * layout, and that is what herdr gets for commands. Typed text is never touched.
   */

  const US_BY_CODE = {
    Digit1: ["1", "!"], Digit2: ["2", "@"], Digit3: ["3", "#"], Digit4: ["4", "$"], Digit5: ["5", "%"],
    Digit6: ["6", "^"], Digit7: ["7", "&"], Digit8: ["8", "*"], Digit9: ["9", "("], Digit0: ["0", ")"],
    Minus: ["-", "_"], Equal: ["=", "+"], BracketLeft: ["[", "{"], BracketRight: ["]", "}"],
    Backslash: ["\\", "|"], Semicolon: [";", ":"], Quote: ["'", '"'], Backquote: ["`", "~"],
    Comma: [",", "<"], Period: [".", ">"], Slash: ["/", "?"],
  };
  for (let c = 65; c <= 90; c++) {
    US_BY_CODE["Key" + String.fromCharCode(c)] = [String.fromCharCode(c + 32), String.fromCharCode(c)];
  }

  /* Keys that can't be a command by themselves, so they don't consume prefix mode. */
  const MODIFIER_KEYS = { Shift: 1, Control: 1, Alt: 1, Meta: 1, CapsLock: 1, AltGraph: 1, NumLock: 1, Dead: 1 };

  /* herdr's binding syntax spells some punctuation out; everything else is a key name. */
  const NAMED_KEYS = { esc: "escape", minus: "-", plus: "+", comma: ",", ampersand: "&", backtick: "`" };

  function parseChord(spec) {
    const parts = String(spec).toLowerCase().split("+");
    const key = (parts.pop() ?? "").trim();
    return {
      ctrl: parts.includes("ctrl"),
      alt: parts.includes("alt"),
      shift: parts.includes("shift"),
      meta: parts.includes("cmd") || parts.includes("super") || parts.includes("meta"),
      key: NAMED_KEYS[key] ?? key,
    };
  }

  /* herdr's default; the server's hello frame carries the configured one. */
  let prefixChord = parseChord("ctrl+b");
  let prefixPending = false;

  term.attachCustomKeyEventHandler((e) => {
    if (e.type !== "keydown" || e.isComposing) return true;

    /* The character this physical key carries in the US layout. Soft keyboards and some
     * remote-desktop paths leave `code` empty; keyCode stays positional for letters. */
    const pair = US_BY_CODE[e.code];
    let us = pair ? (e.shiftKey ? pair[1] : pair[0]) : "";
    if (!us && e.keyCode >= 65 && e.keyCode <= 90) {
      us = String.fromCharCode(e.shiftKey ? e.keyCode : e.keyCode + 32);
    }

    /* Ctrl/Cmd+V must reach the browser as a native paste event (that's how the client
     * device's clipboard — iPad, phone, Mac — travels); everything else stays with xterm.
     * herdr keeps prefix mode in this case: it never sees the chord. */
    if ((e.ctrlKey || e.metaKey) && !e.altKey && us === "v") return false;

    const hadPrefix = prefixPending;
    if (!MODIFIER_KEYS[e.key]) {
      /* Prefix mode has no timeout — it ends with the next real key, and a second prefix
       * chord sends the literal chord to the pane instead of re-entering it. */
      prefixPending =
        !hadPrefix &&
        e.ctrlKey === prefixChord.ctrl &&
        e.altKey === prefixChord.alt &&
        e.metaKey === prefixChord.meta &&
        e.shiftKey === prefixChord.shift &&
        (us || e.key).toLowerCase() === prefixChord.key;
    }

    if (!us || us === e.key) return true; /* Latin layout, or a key with no character */

    if (e.ctrlKey || e.altKey || e.metaKey) {
      /* Chords are commands, never text: hand xterm the US-layout key and let its own
       * encoder turn it into the control byte / ESC-prefixed sequence. */
      Object.defineProperty(e, "key", { value: us, configurable: true });
      const upper = us.toUpperCase().charCodeAt(0);
      if (upper >= 65 && upper <= 90) {
        Object.defineProperty(e, "keyCode", { value: upper, configurable: true });
      }
      return true;
    }

    if (hadPrefix) {
      /* A prefix command. Sent from here rather than through xterm because xterm defers
       * A-Z keydowns to the keypress event (a macOS caps-lock workaround) and that event
       * still carries the original character. */
      send(encoder.encode(us));
      e.preventDefault();
      return false;
    }

    return true; /* plain typing: the user's own layout, byte for byte */
  });

  /* ---------- input bar (paste bridge) ----------
   * A real textarea outside the terminal: paste of text/images/files always works
   * natively there. Files are POSTed to /paste (bytes land on the herdr machine)
   * and come back as absolute paths inserted into the box; Enter pushes the whole
   * box into the focused pane via bracketed paste — omp auto-attaches image paths.
   * Pasting images straight into the terminal is also caught (document capture).
   */

  const ibox = document.getElementById("ibox");
  const fileInput = document.getElementById("file-input");

  function pasteQuery(name) {
    const q = new URLSearchParams();
    if (token) q.set("token", token);
    if (name) q.set("name", name);
    const s = q.toString();
    return s ? `/paste?${s}` : "/paste";
  }

  function iboxAutosize() {
    ibox.style.height = "auto";
    ibox.style.height = Math.min(ibox.scrollHeight, 120) + "px";
  }

  function insertIntoIbox(text) {
    const start = ibox.selectionStart ?? ibox.value.length;
    const end = ibox.selectionEnd ?? ibox.value.length;
    const before = ibox.value.slice(0, start);
    const after = ibox.value.slice(end);
    const sep = before && !/\s$/.test(before) ? " " : "";
    ibox.value = before + sep + text + after;
    const pos = (before + sep + text).length;
    ibox.setSelectionRange(pos, pos);
    iboxAutosize();
  }

  /* Upload files, return their host-side absolute paths (order preserved). */
  async function uploadFiles(files) {
    const paths = [];
    for (const f of files) {
      if (!f) continue;
      try {
        const res = await fetch(pasteQuery(f.name), {
          method: "POST",
          headers: { "content-type": f.type || "application/octet-stream" },
          body: f,
        });
        if (!res.ok) throw new Error(String(res.status));
        paths.push((await res.json()).path);
      } catch (err) {
        console.error("upload failed:", err);
        insertIntoIbox(`<upload failed: ${f.name}>`);
      }
    }
    return paths;
  }

  /* Files never sit in the box: they attach to the composer the moment the upload
   * finishes, so you can keep typing the message right in the terminal. */
  async function attachFiles(files) {
    const paths = await uploadFiles(files);
    if (paths.length) {
      pastePathsIntoPane(paths);
      term.focus();
    }
  }

  /* omp attaches a pasted path only when the paste is EXACTLY one absolute path on
   * one line (leading '@' or extra words turn it into plain text) — so files are
   * always forwarded as individual bracketed pastes. */
  function pastePathsIntoPane(paths) {
    for (const p of paths) term.paste(p);
  }

  function sendIbox() {
    const v = ibox.value.trim();
    if (v) {
      const tokens = v.split(/\s+/);
      if (tokens.every((t) => t.startsWith("/"))) {
        /* only file paths in the box: paste one by one so omp attaches each */
        pastePathsIntoPane(tokens);
      } else {
        term.paste(v);
      }
    }
    ibox.value = "";
    iboxAutosize();
    term.focus();
  }

  ibox.addEventListener("input", iboxAutosize);
  ibox.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendIbox();
    } else if (e.key === "Escape") {
      term.focus();
    }
  });
  ibox.addEventListener("paste", (e) => {
    /* files -> upload; plain text -> native textarea paste, untouched */
    const files = e.clipboardData ? [...e.clipboardData.files] : [];
    if (!files.length) return;
    e.preventDefault();
    attachFiles(files);
  });

  document.getElementById("send-btn").addEventListener("pointerdown", (e) => {
    e.preventDefault();
    sendIbox();
  });
  document.getElementById("file-btn").addEventListener("pointerdown", (e) => {
    e.preventDefault();
    fileInput.click();
  });
  fileInput.addEventListener("change", () => {
    attachFiles([...fileInput.files]);
    fileInput.value = "";
  });

  /* Drag & drop anywhere on the page */
  document.addEventListener("dragover", (e) => e.preventDefault());
  document.addEventListener("drop", (e) => {
    e.preventDefault();
    const files = e.dataTransfer ? [...e.dataTransfer.files] : [];
    if (files.length) attachFiles(files);
  });

  /* Pasting an image while focus is in the terminal itself still works. */
  document.addEventListener(
    "paste",
    (e) => {
      if (e.target === ibox) return; /* the box has its own handler */
      const items = e.clipboardData ? [...e.clipboardData.items] : [];
      const images = items.filter((it) => it.kind === "file" && it.type.startsWith("image/"));
      if (!images.length) return; /* plain text: xterm's own paste path */
      e.preventDefault();
      e.stopImmediatePropagation();
      attachFiles(images.map((it) => it.getAsFile()));
    },
    true,
  );

  /* ---------- resize ---------- */

  let resizeTimer = 0;
  function scheduleFit() {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      const { cols, rows } = term;
      fit.fit();
      /* term.onResize already repaints the overlay and re-reports metrics; a fit that
       * changed nothing still needs the cell size resent after a font-size change. */
      if (term.cols !== cols || term.rows !== rows) {
        sendJson({ t: "resize", cols: term.cols, rows: term.rows });
      } else {
        kitty.invalidate();
        sendMetrics();
      }
    }, 150);
  }

  new ResizeObserver(scheduleFit).observe(termEl);
  if (window.visualViewport) {
    /* iOS keyboard show/hide resizes the visual viewport, not the layout one. */
    visualViewport.addEventListener("resize", scheduleFit);
  }

  /* ---------- toolbar ---------- */

  const ESC_SEQS = { "\\x1b": "\x1b", "\\t": "\t", "\\x02": "\x02", "\\r": "\r", "\\x1b[A": "\x1b[A", "\\x1b[B": "\x1b[B", "\\x1b[C": "\x1b[C", "\\x1b[D": "\x1b[D" };

  for (const btn of document.querySelectorAll("#bar button[data-seq]")) {
    btn.addEventListener("pointerdown", (e) => {
      e.preventDefault(); /* keep focus (and the iOS keyboard) on the terminal */
      send(encoder.encode(ESC_SEQS[btn.dataset.seq] ?? ""));
      /* The C-b button opens prefix mode exactly like the chord does, so the command key
       * that follows has to be latinized too. */
      if ("prefix" in btn.dataset) prefixPending = !prefixPending;
    });
  }


  function bumpFont(delta) {
    fontSize = Math.min(24, Math.max(8, fontSize + delta));
    localStorage.setItem("herdr-web-font-size", String(fontSize));
    term.options.fontSize = fontSize;
    scheduleFit();
  }
  document.getElementById("font-dec").addEventListener("pointerdown", (e) => { e.preventDefault(); bumpFont(-1); });
  document.getElementById("font-inc").addEventListener("pointerdown", (e) => { e.preventDefault(); bumpFont(+1); });

  /* ---------- boot ---------- */

  /* Fit with the real font metrics: connect only after the woff2 faces are usable,
   * otherwise the first fit() measures a fallback font and the grid is wrong. */
  const faces = [`400 ${fontSize}px "JetBrainsMono Nerd Web"`, `700 ${fontSize}px "JetBrainsMono Nerd Web"`];
  Promise.race([
    Promise.all(faces.map((f) => document.fonts.load(f))),
    new Promise((r) => setTimeout(r, 3000)),
  ]).finally(() => {
    fit.fit();
    connect();
    term.focus();
  });
})();

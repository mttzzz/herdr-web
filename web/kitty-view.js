/*
 * Kitty image overlay for the herdr-web mirror — one canvas, one cached ImageBitmap per
 * image, one repaint per animation frame.
 *
 * The APC parsing lives on the server (server/kitty-stream.ts); this file only consumes
 * operations: `img` (new pixels, fetched from the op's `url` and stored under a page key),
 * `ref` (an image id now shows the pixels under a page key), `place`, `del`, `reset`. That
 * split is what makes the feed usable: herdr emits ~600 placements a second for a streaming
 * pane, and the old client re-decoded every image on every one of them.
 *
 * Pixels outlive the image id that showed them: herdr frees an image (`del img <id>`) as
 * soon as it leaves the screen and re-sends it when it comes back, and the server answers
 * that return trip with a `ref` to what is still here. The server also decides when pixels
 * go (`del img <page key>`), so the two sides never disagree about what the page holds.
 *
 * Image bytes never travel in the WebSocket: the `url` names the content, the fetch and the
 * decode (createImageBitmap) run off the main thread, and the browser's HTTP cache answers a
 * reload. Drawing is a single drawImage per placement, so a repaint costs the same whether the
 * image is 0.1 or 9 MB.
 */
(function (root) {
  "use strict";

  /* w*h*4 per bitmap. The server keeps the page within 96 MB on its own; this is only a
   * backstop for a server that does not (one not restarted since the page was loaded). */
  const BACKSTOP_BYTES = 192 * 1024 * 1024;

  function createKittyView(opts) {
    const mount = opts.mount;
    const getCell = opts.getCell || (() => ({ w: 8, h: 16 }));
    const getGrid = opts.getGrid || (() => ({ cols: 80, rows: 24 }));
    const onMiss = opts.onMiss || (() => {});

    /* page key -> { bitmap, w, h, bytes, lastUsed, ids:Set } — `ids` holds the key itself
     * plus every image id bound to it; the pixels go when the set is empty */
    const store = new Map();
    /* image id -> page key, for ids that show pixels stored under another key */
    const alias = new Map();
    /* "id:pid" -> place op */
    const placements = new Map();
    const missed = new Set();
    /* Placements a batch took off and gave their cells to an image still decoding: they stay on
     * the canvas, under everything else, until no image is decoding in those cells. One herdr
     * frame replaces an image this way (`del` + `img` + `place` over the same cells), and an svg
     * figure from omp 18.7+ does it every 200 ms while it streams. Drawn as the batch said, the
     * figure blinked out on almost every revision until the new bitmap was decoded.
     * [{ key, p, srcId, entry }] */
    let retiring = [];

    /* `decoded` counts bitmaps that became drawable; with `pending` (still fetching or decoding)
     * it lets a probe tell "the image is on the canvas" from "the image was announced" */
    const stats = { images: 0, bytes: 0, placements: 0, misses: 0, decodeErrors: 0, overBudget: 0, frames: 0, decoded: 0 };

    let canvas = null;
    let ctx = null;
    let cssW = 0;
    let cssH = 0;
    let dpr = 0;
    let frameHandle = 0;

    function ensureCanvas() {
      if (canvas || !mount) return canvas;
      canvas = document.createElement("canvas");
      canvas.id = "kitty-canvas";
      canvas.setAttribute("aria-hidden", "true");
      canvas.style.cssText = "position:absolute;inset:0;pointer-events:none;z-index:2";
      mount.appendChild(canvas);
      ctx = canvas.getContext("2d", { alpha: true });
      return canvas;
    }

    function resolve(id) {
      const src = alias.get(id);
      return src === undefined ? id : src;
    }

    function referenced(srcId) {
      for (const p of placements.values()) {
        if (resolve(p.id) === srcId) return true;
      }
      return false;
    }

    function release(srcId) {
      const entry = store.get(srcId);
      if (!entry) return;
      if (entry.bitmap) entry.bitmap.close();
      store.delete(srcId);
      stats.images = store.size;
      stats.bytes -= entry.bytes;
      for (const id of entry.ids) if (id !== srcId) alias.delete(id);
    }

    /* Backstop only (see BACKSTOP_BYTES): drop unreferenced bitmaps, oldest first, and tell
     * the server so it ships those pixels again next time. Referenced ones stay even over
     * budget: dropping pixels that are on screen would blank an image herdr will not
     * re-send. */
    function evict() {
      if (stats.bytes <= BACKSTOP_BYTES) return;
      const candidates = [...store.entries()]
        .filter(([srcId]) => !referenced(srcId))
        .sort((a, b) => a[1].lastUsed - b[1].lastUsed);
      for (const [srcId] of candidates) {
        release(srcId);
        onMiss(srcId);
        if (stats.bytes <= BACKSTOP_BYTES) return;
      }
      stats.overBudget++;
    }

    /* No URL means the server could not encode those pixels; failing here takes the same miss
     * path as a broken download. */
    async function decode(op) {
      if (!op.url) throw new Error("no url: the server could not serve these pixels");
      const res = await fetch(op.url);
      if (!res.ok) throw new Error(`HTTP ${res.status} for ${op.url}`);
      return createImageBitmap(await res.blob());
    }

    function addImage(op) {
      alias.delete(op.id);
      release(op.id);
      const entry = { bitmap: null, w: op.w, h: op.h, bytes: (op.w || 1) * (op.h || 1) * 4, lastUsed: performance.now(), ids: new Set([op.id]) };
      store.set(op.id, entry);
      stats.images = store.size;
      stats.bytes += entry.bytes;
      missed.delete(op.id);
      decode(op).then(
        (bitmap) => {
          if (store.get(op.id) !== entry) {
            bitmap.close(); /* replaced or evicted while decoding */
            return;
          }
          entry.bitmap = bitmap;
          stats.decoded++;
          entry.w = bitmap.width;
          entry.h = bitmap.height;
          schedule();
        },
        (err) => {
          stats.decodeErrors++;
          console.error("[kitty] decode failed for image", op.id, err);
          release(op.id);
          onMiss(op.id);
          schedule(); /* what it was to replace is not held for it any more */
        },
      );
    }

    /** "col:row" of every placement whose bitmap is still on its way */
    function decodingCells() {
      const cells = new Set();
      for (const p of placements.values()) {
        const entry = store.get(resolve(p.id));
        if (entry && !entry.bitmap) cells.add(p.col + ":" + p.row);
      }
      return cells;
    }

    /** `before`: the placements that were drawn when the batch came. Those it took off or bound
     * to other pixels are held while an image decodes where they start. */
    function retire(before) {
      const decoding = decodingCells();
      if (decoding.size === 0) return;
      for (const was of before) {
        const now = placements.get(was.key);
        if (now && store.get(resolve(now.id)) === was.entry) continue; /* same pixels, moved or not */
        if (store.get(was.srcId) === was.entry && decoding.has(was.p.col + ":" + was.p.row)) retiring.push(was);
      }
    }

    function applyOps(ops) {
      const before = [];
      for (const [key, p] of placements) {
        const srcId = resolve(p.id);
        const entry = store.get(srcId);
        if (entry && entry.bitmap) before.push({ key, p, srcId, entry });
      }
      for (const op of ops) {
        if (op.t === "img") {
          addImage(op);
        } else if (op.t === "ref") {
          const srcId = resolve(op.src);
          const entry = store.get(srcId);
          if (!entry) {
            /* The source is gone (evicted); ask for real pixels next time. */
            reportMiss(op.src);
            continue;
          }
          /* Rebinding: the id stops holding up whatever it showed before. */
          const prev = resolve(op.id);
          if (prev !== srcId) store.get(prev)?.ids.delete(op.id);
          if (op.id === srcId) alias.delete(op.id);
          else alias.set(op.id, srcId);
          entry.ids.add(op.id);
          missed.delete(op.id);
        } else if (op.t === "place") {
          placements.set(op.id + ":" + op.pid, op);
        } else if (op.t === "del") {
          if (op.scope === "all") placements.clear();
          else if (op.scope === "placement") placements.delete(op.id + ":" + op.pid);
          else if (op.scope === "img") {
            for (const [key, p] of placements) if (p.id === op.id) placements.delete(key);
            const srcId = resolve(op.id);
            alias.delete(op.id);
            const entry = store.get(srcId);
            if (entry) {
              entry.ids.delete(op.id);
              if (entry.ids.size === 0) release(srcId);
            }
          }
        } else if (op.t === "reset") {
          clear();
        }
      }
      stats.placements = placements.size;
      /* After the whole batch: a `ref` later in it may bind pixels an `img` pushed over. */
      evict();
      retire(before);
      schedule();
    }

    function reportMiss(id) {
      if (missed.has(id)) return;
      missed.add(id);
      stats.misses++;
      onMiss(id);
    }

    function schedule() {
      if (frameHandle || !mount) return;
      frameHandle = requestAnimationFrame(draw);
    }

    function draw() {
      frameHandle = 0;
      if (!ensureCanvas()) return;
      const ratio = window.devicePixelRatio || 1;
      const w = mount.clientWidth;
      const h = mount.clientHeight;
      if (w !== cssW || h !== cssH || ratio !== dpr) {
        cssW = w;
        cssH = h;
        dpr = ratio;
        canvas.width = Math.max(1, Math.round(w * ratio));
        canvas.height = Math.max(1, Math.round(h * ratio));
        canvas.style.width = w + "px";
        canvas.style.height = h + "px";
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, cssW, cssH);
      stats.frames++;
      if (retiring.length) {
        const decoding = decodingCells();
        retiring = retiring.filter((r) => store.get(r.srcId) === r.entry && decoding.has(r.p.col + ":" + r.p.row));
      }
      if (placements.size === 0 && retiring.length === 0) return;

      const cell = getCell();
      const cw = cell.w || 8;
      const ch = cell.h || 16;
      const now = performance.now();
      /* what is being replaced goes under the rest, and is gone the frame its replacement draws */
      for (const r of retiring) {
        r.entry.lastUsed = now;
        paint(r.entry, r.p, cw, ch);
      }
      const ordered = [...placements.values()].sort((a, b) => a.z - b.z || a.id - b.id);
      for (const p of ordered) {
        const entry = store.get(resolve(p.id));
        if (!entry) {
          reportMiss(p.id);
          continue;
        }
        if (!entry.bitmap) continue; /* still decoding — the next frame paints it */
        entry.lastUsed = now;
        paint(entry, p, cw, ch);
      }
    }

    function paint(entry, p, cw, ch) {
      const crop = p.crop;
      const sx = crop ? crop[0] : 0;
      const sy = crop ? crop[1] : 0;
      const sw = crop && crop[2] ? crop[2] : entry.w - sx;
      const sh = crop && crop[3] ? crop[3] : entry.h - sy;
      if (sw <= 0 || sh <= 0) return;
      const dx = (p.col - 1) * cw + (p.off ? p.off[0] : 0);
      const dy = (p.row - 1) * ch + (p.off ? p.off[1] : 0);
      ctx.drawImage(entry.bitmap, sx, sy, sw, sh, dx, dy, (p.cols || 1) * cw, (p.rows || 1) * ch);
    }

    function clear() {
      for (const srcId of [...store.keys()]) release(srcId);
      store.clear();
      alias.clear();
      placements.clear();
      retiring = [];
      missed.clear();
      stats.images = 0;
      stats.bytes = 0;
      stats.placements = 0;
      if (ctx) ctx.clearRect(0, 0, cssW, cssH);
    }

    return {
      applyOps,
      clear,
      invalidate: schedule,
      stats: () => {
        let pending = 0;
        for (const entry of store.values()) if (!entry.bitmap) pending++;
        return { ...stats, pending, grid: getGrid(), cell: getCell() };
      },
    };
  }

  root.HerdrKittyView = { createKittyView };
})(typeof globalThis !== "undefined" ? globalThis : window);

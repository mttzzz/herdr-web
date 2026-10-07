/*
 * Kitty graphics proxy: the byte stream herdr writes into the client PTY comes in here,
 * the terminal bytes (APC cut out) and image *operations* come out.
 *
 * Why this lives on the server and not in the browser:
 *   - the APC reassembly is a byte-level state machine, and Bun does base64 + hashing at
 *     memcpy speed (a 4 MB payload: Buffer.from ~0.3 ms, xxHash64 ~0.34 ms) while the same
 *     work in the page costs milliseconds per frame on the main thread;
 *   - the same pixels are re-transmitted per client, per reconnect and every time an image
 *     comes back on screen (herdr frees it with d=I when it leaves), so hashing them once
 *     here turns every repeat into a 30-byte `ref` op instead of megabytes over the wire;
 *   - xterm.js has to see the stream anyway, and feeding it the *whole* stream means every
 *     APC byte is decoded twice (its UTF-8 decoder allocates 4 bytes per input byte).
 *
 * Subset herdr actually emits (src/kitty_graphics.rs format strings):
 *   a=t/T/p/d/q, t=d/f, f=24/32/100, chunked m=, placement p/c/r/z/C, crop x/y/w/h,
 *   pixel offset X/Y, q=0/2, plus the XTWINOPS 14t/16t queries it uses to learn cell size.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const HOME = resolve(process.env.HOME ?? "/tmp");

export type ImgFmt = "png" | "rgb" | "rgba";

export type Op =
  /** new pixels the page stores under `id`, a page key: always negative, so it never
   * collides with a herdr image id; the payload follows in `payloads`, in op order.
   * `hash` names the pixel content (xxHash64, 16 hex digits): the same pixels always get
   * the same name, whichever client, connection or image id they arrive under. `url` is
   * set by the server when the page fetches the pixels over HTTP instead of the frame. */
  | { t: "img"; id: number; fmt: ImgFmt; w: number; h: number; len: number; hash: string; url?: string }
  /** herdr image `id` now shows the pixels the page holds under page key `src` — no bytes */
  | { t: "ref"; id: number; src: number }
  | {
      t: "place";
      id: number;
      pid: number;
      col: number;
      row: number;
      cols: number;
      rows: number;
      z: number;
      /** source crop [x,y,w,h]; 0 w/h means "to the edge" */
      crop: [number, number, number, number] | null;
      /** pixel offset inside the first cell [X,Y] */
      off: [number, number];
    }
  /** `img` with a herdr id: that id is gone, its pixels stay on the page; with a page key:
   * the page drops those pixels */
  | { t: "del"; scope: "all" | "img" | "placement"; id?: number; pid?: number }
  | { t: "reset" };

export interface KittyStreamStats {
  /** pixel sets the page holds (bound to an image id or kept for a return trip) */
  cached: number;
  uniqueBytes: number;
  dupeBytesSaved: number;
  payloadBytes: number;
  apcBytes: number;
  plainBytes: number;
  maxImageBytes: number;
  /** placements herdr repeated with identical geometry, never forwarded */
  placeDeduped: number;
  apc: { t: number; T: number; p: number; d: number; q: number; other: number };
  fmt: { f24: number; f32: number; f100: number };
  transportFile: number;
  transportDenied: number;
  forgotten: number;
  /** pixel sets dropped to keep the page within its budget */
  evicted: number;
}

export interface PushResult {
  /** terminal bytes for xterm.js, in order; views are only valid until the next push() */
  plain: Uint8Array[];
  ops: Op[];
  /** payloads for the `img` ops, in the same order */
  payloads: Uint8Array[];
}

/** What a page that starts from nothing, or skipped part of the stream, needs to show what
 * herdr's images and modes are now (server/screen.ts has the cells). */
export interface Snapshot {
  /** the terminal modes herdr switched on, as bytes for the page's terminal: herdr sends them
   * once, when its client starts (mouse reporting, bracketed paste, alternate screen, kitty
   * keyboard), and a repaint does not repeat them */
  modes: Uint8Array;
  /** `reset`, then `img` (fmt png, no payload: the server adds the URL) and `ref` for every
   * image a herdr id shows, and every placement on screen */
  ops: Op[];
}

export interface KittyStream {
  push(chunk: Uint8Array): PushResult;
  /** the page lost pixels — `id` is their page key or a herdr id showing them: forget them,
   * so the next transmit ships bytes again */
  forget(id: number): void;
  /** A page takes this stream over from now on: what it needs, see Snapshot. Pixels no image
   * shows are forgotten (the page will not have them, so their next transmit ships bytes);
   * placements stay known, since the page gets every one of them. */
  snapshot(): Snapshot;
  /** herdr is inside a frame: the ops it produced so far leave when the frame ends */
  inFrame(): boolean;
  reset(): void;
  stats(): KittyStreamStats;
}

export interface KittyStreamOpts {
  cellSize(): { w: number; h: number };
  grid(): { cols: number; rows: number };
  reply(bytes: Uint8Array): void;
  /** pixel bytes the page may hold before images nobody shows are dropped (default 96 MB) */
  budgetBytes?: number;
}

const ESC = 0x1b;
const B_ESC = new Uint8Array([0x1b]);
const B_ESC_BRACKET = new Uint8Array([0x1b, 0x5b]);
const B_ESC_7 = new Uint8Array([0x1b, 0x37]);
const B_ESC_8 = new Uint8Array([0x1b, 0x38]);
const B_ESC_C = new Uint8Array([0x1b, 0x63]);
const ENC = new TextEncoder();

const S_GROUND = 0;
const S_ESC = 1;
const S_CSI = 2;
const S_APC = 3;
const S_APC_ESC = 4;

type Keys = Record<string, string>;

export function parseKeys(header: string): Keys {
  const out: Keys = Object.create(null);
  let i = 0;
  while (i < header.length) {
    let end = header.indexOf(",", i);
    if (end < 0) end = header.length;
    const eq = header.indexOf("=", i);
    if (eq > i && eq < end) out[header.slice(i, eq)] = header.slice(eq + 1, end);
    i = end + 1;
  }
  return out;
}

function num(keys: Keys, name: string, fallback: number): number {
  const raw = keys[name];
  if (raw === undefined) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : fallback;
}

/** Zero-copy view -> string; APC headers and base64 are ASCII by protocol. */
function latin1(buf: Uint8Array, start: number, end: number): string {
  if (end <= start) return "";
  return Buffer.from(buf.buffer, buf.byteOffset + start, end - start).toString("latin1");
}

function fmtOf(f: number): ImgFmt {
  if (f === 100) return "png";
  if (f === 24) return "rgb";
  return "rgba";
}

/** Same image, same placement id, same geometry — nothing for the client to redraw. */
function samePlacement(a: Op & { t: "place" }, b: Op & { t: "place" }): boolean {
  return (
    a.col === b.col &&
    a.row === b.row &&
    a.cols === b.cols &&
    a.rows === b.rows &&
    a.z === b.z &&
    a.off[0] === b.off[0] &&
    a.off[1] === b.off[1] &&
    (a.crop === null
      ? b.crop === null
      : b.crop !== null &&
        a.crop[0] === b.crop[0] &&
        a.crop[1] === b.crop[1] &&
        a.crop[2] === b.crop[2] &&
        a.crop[3] === b.crop[3])
  );
}

/** A set of pixels the page holds, under a page key picked here. Keys are negative and never
 * reused: herdr does reuse image ids for new pixels, and a shared key would let those
 * overwrite an image another id still shows. */
interface Held {
  key: number;
  hash: bigint;
  /** as herdr declared them (s=/v=); 0 for PNG, which carries its own */
  w: number;
  h: number;
  /** what the page budgets for it: decoded w*h*4, the sum web/kitty-view.js keeps too */
  bytes: number;
  /** herdr image ids currently showing these pixels */
  ids: number;
}

/** the content hash as it travels: 16 hex digits, the name of `/img/<hash>` */
const hex = (hash: bigint) => hash.toString(16).padStart(16, "0");

/* A dozen full-screen screenshots — far more than herdr keeps on screen at once. */
const PAGE_BUDGET_BYTES = 96 * 1024 * 1024;

export function createKittyStream(opts: KittyStreamOpts): KittyStream {
  /* ---- parser state (survives across push() calls, never re-scans old bytes) ---- */
  let state = S_GROUND;
  let csi = "";
  let apcHead = "";
  let apcSep = false;
  let apcParts: string[] = [];
  let pending: { keys: Keys; parts: string[] } | null = null;

  let cursorCol = 1;
  let cursorRow = 1;
  let savedCol = 1;
  let savedRow = 1;

  /* ---- image bookkeeping ----
   * The server decides what the page keeps: `held` mirrors the page's pixel store (oldest
   * first), `bound` says which herdr id shows what. herdr frees an image (d=I) the moment it
   * leaves the screen and re-sends the full RGBA when it is back; holding the pixels past
   * that d=I is what turns the return trip into a `ref`. */
  const budget = opts.budgetBytes ?? PAGE_BUDGET_BYTES;
  const held = new Map<number, Held>();
  const heldByHash = new Map<bigint, Held>();
  const bound = new Map<number, Held>();
  let heldBytes = 0;
  let lastKey = 0;
  const placements = new Map<string, Op & { t: "place" }>();

  /* ---- terminal modes ----
   * herdr switches the outer terminal's modes once, when its client starts; a page that takes
   * over a running client (a reload) has none of them. Last state per DEC private mode, in the
   * order last set, and the kitty keyboard protocol's flag stack. */
  const decModes = new Map<number, boolean>();
  let keyboard: number[] = [];

  const st: KittyStreamStats = {
    cached: 0,
    uniqueBytes: 0,
    dupeBytesSaved: 0,
    payloadBytes: 0,
    apcBytes: 0,
    plainBytes: 0,
    maxImageBytes: 0,
    placeDeduped: 0,
    apc: { t: 0, T: 0, p: 0, d: 0, q: 0, other: 0 },
    fmt: { f24: 0, f32: 0, f100: 0 },
    transportFile: 0,
    transportDenied: 0,
    forgotten: 0,
    evicted: 0,
  };

  let plain: Uint8Array[] = [];
  let ops: Op[] = [];
  let payloads: Uint8Array[] = [];

  /* ---- herdr frames ----
   * herdr brackets every frame in synchronized output (CSI ? 2026 h … l), and a frame that
   * replaces an image spans dozens of PTY reads: the RGBA re-send is megabytes. The frame's
   * ops leave when it closes, as one batch. Sent as they were parsed, the old image's `del`
   * reached the page ~14 ms ahead of the new image's `place`, and the page drew no image in
   * between: an svg figure from omp 18.7+, replaced every 200 ms while it streams, blinked on
   * every revision. Terminal bytes are not held: the page's terminal waits for the frame's
   * end by itself. */
  let frameOpen = false;
  /* where the open frame starts in `ops` and `payloads`: what is before it may leave */
  let frameOps = 0;
  let framePayloads = 0;

  function emitPlain(view: Uint8Array): void {
    plain.push(view);
    st.plainBytes += view.length;
  }

  function reply(s: string): void {
    opts.reply(ENC.encode(s));
  }

  function replyOk(id: number): void {
    reply("\x1b_Gi=" + id + ";OK\x1b\\");
  }

  function cell(): { w: number; h: number } {
    const c = opts.cellSize();
    return { w: Math.max(1, Math.round(c.w) || 8), h: Math.max(1, Math.round(c.h) || 16) };
  }

  function winops(body: string): void {
    if (body === "16") {
      const c = cell();
      reply("\x1b[6;" + c.h + ";" + c.w + "t");
    } else if (body === "14") {
      const c = cell();
      const g = opts.grid();
      reply("\x1b[4;" + c.h * Math.max(1, g.rows) + ";" + c.w * Math.max(1, g.cols) + "t");
    }
  }

  function cup(body: string): void {
    if (!body) {
      cursorRow = 1;
      cursorCol = 1;
      return;
    }
    const semi = body.indexOf(";");
    const row = Number.parseInt(semi < 0 ? body : body.slice(0, semi), 10);
    const col = semi < 0 ? 1 : Number.parseInt(body.slice(semi + 1), 10);
    cursorRow = Math.max(1, Number.isFinite(row) ? row : 1);
    cursorCol = Math.max(1, Number.isFinite(col) ? col : 1);
  }

  function clearImages(): void {
    held.clear();
    heldByHash.clear();
    bound.clear();
    heldBytes = 0;
    placements.clear();
    st.cached = 0;
  }

  function hardReset(): void {
    pending = null;
    frameOpen = false;
    clearImages();
    decModes.clear();
    keyboard = [];
    ops.push({ t: "reset" });
  }

  /** CSI ? Pm h / CSI ? Pm l */
  function decMode(body: string, on: boolean): void {
    for (const p of body.slice(1).split(";")) {
      const n = Number.parseInt(p, 10);
      if (!Number.isFinite(n)) continue;
      /* synchronized output brackets a frame; it is not a state to hand a page over: replaying
       * one half of it would freeze the page's terminal until the other half */
      if (n === 2026) {
        if (on && !frameOpen) {
          frameOps = ops.length;
          framePayloads = payloads.length;
        }
        frameOpen = on;
        continue;
      }
      decModes.delete(n);
      decModes.set(n, on);
    }
  }

  /** kitty keyboard protocol: CSI > flags u pushes, CSI < n u pops n, CSI = flags ; mode u
   * sets the top (mode 1 replace, 2 add, 3 remove); CSI ? u is a query and changes nothing */
  function keyboardFlags(body: string): void {
    const kind = body.charAt(0);
    const [a, b] = body
      .slice(1)
      .split(";")
      .map((s) => Number.parseInt(s, 10));
    if (kind === ">") keyboard.push(Number.isFinite(a) ? a : 0);
    else if (kind === "<") keyboard.splice(Math.max(0, keyboard.length - (Number.isFinite(a) && a > 0 ? a : 1)));
    else if (kind === "=") {
      const flags = Number.isFinite(a) ? a : 0;
      const top = keyboard.length ? keyboard[keyboard.length - 1] : 0;
      const next = b === 2 ? top | flags : b === 3 ? top & ~flags : flags;
      if (keyboard.length) keyboard[keyboard.length - 1] = next;
      else keyboard.push(next);
    }
  }

  function modeBytes(): Uint8Array {
    let s = "";
    for (const [n, on] of decModes) s += `\x1b[?${n}${on ? "h" : "l"}`;
    for (const flags of keyboard) s += `\x1b[>${flags}u`;
    return ENC.encode(s);
  }

  /* ---- what the page holds ---- */

  /** Most recently shown last: `held` iterates oldest first, which is the eviction order. */
  function touch(pix: Held): void {
    held.delete(pix.key);
    held.set(pix.key, pix);
  }

  function bind(id: number, pix: Held): void {
    const prev = bound.get(id);
    if (prev === pix) return;
    if (prev) {
      prev.ids--;
      touch(prev);
    }
    bound.set(id, pix);
    pix.ids++;
    touch(pix);
  }

  function unbind(id: number): void {
    const pix = bound.get(id);
    if (!pix) return;
    bound.delete(id);
    pix.ids--;
    touch(pix);
  }

  function drop(pix: Held): void {
    held.delete(pix.key);
    if (heldByHash.get(pix.hash) === pix) heldByHash.delete(pix.hash);
    heldBytes -= pix.bytes;
    if (pix.ids) for (const [id, b] of bound) if (b === pix) bound.delete(id);
    pix.ids = 0;
    st.cached = held.size;
  }

  /** Room for `need` more bytes on the page: pixels no image shows go, longest unseen first,
   * and the page frees them before the new ones land. Pixels on screen are never dropped —
   * herdr would not send them again — so a screen full of images may overshoot. */
  function makeRoom(need: number): void {
    for (const pix of held.values()) {
      if (heldBytes + need <= budget) return;
      if (pix.ids) continue;
      drop(pix);
      st.evicted++;
      ops.push({ t: "del", scope: "img", id: pix.key });
    }
  }

  /* ---- graphics commands ---- */

  function payloadOf(keys: Keys, parts: string[]): Uint8Array | null {
    const b64 = parts.length === 1 ? parts[0] : parts.join("");
    const transport = keys.t ?? "d";
    if (transport === "d") return b64 ? Buffer.from(b64, "base64") : new Uint8Array(0);
    if (transport !== "f" && transport !== "t") {
      st.transportDenied++;
      return null;
    }
    /* File transport: the payload is a path on the herdr machine. A mirror must not become
     * an arbitrary file reader, so only $HOME is readable — that is where herdr's own
     * graphics scratch files live. */
    const path = resolve(Buffer.from(b64, "base64").toString("utf8"));
    if (path !== HOME && !path.startsWith(HOME + "/")) {
      st.transportDenied++;
      console.error("[kitty] refusing file transport outside $HOME:", path);
      return null;
    }
    try {
      const bytes = readFileSync(path) as Uint8Array;
      st.transportFile++;
      const off = num(keys, "O", 0);
      const size = num(keys, "S", 0);
      if (off || size) return bytes.subarray(off, size ? off + size : undefined);
      return bytes;
    } catch (err) {
      st.transportDenied++;
      console.error("[kitty] file transport unreadable:", path, String(err));
      return null;
    }
  }

  /** Returns the id the page now shows these pixels under, or 0 when unusable. */
  function transmit(keys: Keys, bytes: Uint8Array): number {
    const id = num(keys, "i", 0);
    if (!id) return 0;
    const f = num(keys, "f", 32);
    if (f === 24) st.fmt.f24++;
    else if (f === 100) st.fmt.f100++;
    else st.fmt.f32++;
    st.payloadBytes += bytes.length;
    if (bytes.length > st.maxImageBytes) st.maxImageBytes = bytes.length;

    const hash = Bun.hash.xxHash64(bytes);
    if (bound.get(id)?.hash === hash) {
      /* herdr re-sent the pixels this very id already shows */
      st.dupeBytesSaved += bytes.length;
      return id;
    }
    let pix = heldByHash.get(hash);
    if (pix) {
      /* still on the page — typically an image herdr freed when it left the screen */
      st.dupeBytesSaved += bytes.length;
    } else {
      const fmt = fmtOf(f);
      const w = num(keys, "s", 0);
      const h = num(keys, "v", 0);
      const size = (w || 1) * (h || 1) * 4;
      makeRoom(size);
      pix = { key: --lastKey, hash, w, h, bytes: size, ids: 0 };
      held.set(pix.key, pix);
      heldByHash.set(hash, pix);
      heldBytes += size;
      st.cached = held.size;
      st.uniqueBytes += bytes.length;
      ops.push({ t: "img", id: pix.key, fmt, w, h, len: bytes.length, hash: hex(hash) });
      payloads.push(bytes);
    }
    bind(id, pix);
    ops.push({ t: "ref", id, src: pix.key });
    return id;
  }

  function place(keys: Keys, id: number): void {
    const pid = num(keys, "p", 0);
    const x = num(keys, "x", 0);
    const y = num(keys, "y", 0);
    const w = num(keys, "w", 0);
    const h = num(keys, "h", 0);
    const op: Op & { t: "place" } = {
      t: "place",
      id,
      pid,
      col: cursorCol,
      row: cursorRow,
      cols: num(keys, "c", 0),
      rows: num(keys, "r", 0),
      z: num(keys, "z", 0),
      crop: x || y || w || h ? [x, y, w, h] : null,
      off: [num(keys, "X", 0), num(keys, "Y", 0)],
    };
    /* herdr re-places every visible image on every render pass — ~600 times a second for a
     * streaming pane. A placement with identical geometry is a no-op for a canvas that
     * already shows it, so it never leaves the server. */
    const prev = placements.get(id + ":" + pid);
    if (prev && samePlacement(prev, op)) {
      st.placeDeduped++;
      return;
    }
    placements.set(id + ":" + pid, op);
    ops.push(op);
  }

  function del(keys: Keys): void {
    const which = keys.d || "a";
    const id = num(keys, "i", 0);
    const pid = num(keys, "p", 0);
    if (which === "a" || which === "A") {
      /* All placements go; the pixels stay cached, because herdr keeps its own host cache
       * and will place the same ids again without re-transmitting them. */
      placements.clear();
      ops.push({ t: "del", scope: "all" });
      return;
    }
    if (which === "I" || which === "i") {
      if (!id) return;
      if (which === "I") {
        /* Only the id goes: the page keeps the pixels for when herdr re-sends them. */
        unbind(id);
        for (const [k, p] of placements) if (p.id === id) placements.delete(k);
        ops.push({ t: "del", scope: "img", id });
        return;
      }
      placements.delete(id + ":" + pid);
      ops.push({ t: "del", scope: "placement", id, pid });
      return;
    }
    if (which === "Z" || which === "z") {
      /* "newest at the cursor": resolve it here, the client only knows ids */
      for (const [k, p] of placements) {
        if (p.col === cursorCol && p.row === cursorRow) {
          placements.delete(k);
          ops.push({ t: "del", scope: "placement", id: p.id, pid: p.pid });
        }
      }
    }
  }

  function apply(keys: Keys, parts: string[]): void {
    const action = keys.a ?? "";
    if (action === "t" || action === "T" || action === "p" || action === "d" || action === "q") {
      st.apc[action as "t" | "T" | "p" | "d" | "q"]++;
    } else st.apc.other++;

    if (action === "d") {
      del(keys);
      return;
    }
    if (action === "q") {
      const id = num(keys, "i", 0);
      if (id && num(keys, "q", 0) !== 2) replyOk(id);
      return;
    }
    if (action === "t" || action === "T") {
      const bytes = payloadOf(keys, parts);
      if (!bytes) {
        const id = num(keys, "i", 0);
        if (id) {
          unbind(id);
          ops.push({ t: "del", scope: "img", id });
        }
        return;
      }
      const id = transmit(keys, bytes);
      if (action === "T" && id) place(keys, id);
      if (id && num(keys, "q", 2) === 0) replyOk(id);
      return;
    }
    if (action === "p") {
      const id = num(keys, "i", 0);
      if (!id) return;
      place(keys, id);
      if (num(keys, "q", 2) === 0) replyOk(id);
    }
  }

  function command(keys: Keys, parts: string[]): void {
    const more = keys.m === "1";
    if (pending) {
      /* A continuation chunk carries m= (and at most i=); anything with its own a= is a
       * fresh command, which means the chunked transfer was cut short. */
      if (keys.m !== undefined || keys.a === undefined) {
        Object.assign(pending.keys, keys);
        for (const p of parts) pending.parts.push(p);
        if (more) return;
        const done = pending;
        pending = null;
        apply(done.keys, done.parts);
        return;
      }
      const done = pending;
      pending = null;
      apply(done.keys, done.parts);
    }
    if (more) {
      pending = { keys: { ...keys }, parts };
      return;
    }
    apply(keys, parts);
  }

  function finishApc(): void {
    const head = apcHead;
    const parts = apcParts;
    apcHead = "";
    apcParts = [];
    apcSep = false;
    /* Graphics APCs are ESC _ G <keys> ; <payload> ESC \ — anything else is not ours
     * (xterm.js ignores APC too, so swallowing it costs nothing). */
    if (head.charCodeAt(0) !== 0x47 /* G */) return;
    command(parseKeys(head.slice(1)), parts);
  }

  function push(chunk: Uint8Array): PushResult {
    plain = [];
    /* an open frame's ops stay in `ops` until the frame ends */
    if (!frameOpen) {
      ops = [];
      payloads = [];
    }
    const len = chunk.length;
    let i = 0;
    while (i < len) {
      if (state === S_GROUND) {
        const e = chunk.indexOf(ESC, i);
        if (e < 0) {
          emitPlain(chunk.subarray(i));
          break;
        }
        if (e > i) emitPlain(chunk.subarray(i, e));
        i = e + 1;
        state = S_ESC;
        continue;
      }
      if (state === S_ESC) {
        const b = chunk[i];
        if (b === 0x5f /* _ */) {
          i++;
          state = S_APC;
          apcHead = "";
          apcParts = [];
          apcSep = false;
          st.apcBytes += 2;
        } else if (b === 0x5b /* [ */) {
          i++;
          csi = "";
          state = S_CSI;
          emitPlain(B_ESC_BRACKET);
        } else if (b === 0x37 /* 7 DECSC */) {
          i++;
          savedCol = cursorCol;
          savedRow = cursorRow;
          state = S_GROUND;
          emitPlain(B_ESC_7);
        } else if (b === 0x38 /* 8 DECRC */) {
          i++;
          cursorCol = savedCol;
          cursorRow = savedRow;
          state = S_GROUND;
          emitPlain(B_ESC_8);
        } else if (b === 0x63 /* c RIS */) {
          i++;
          state = S_GROUND;
          hardReset();
          emitPlain(B_ESC_C);
        } else {
          /* not ours: hand the ESC back to the plain stream, the byte follows in GROUND */
          state = S_GROUND;
          emitPlain(B_ESC);
        }
        continue;
      }
      if (state === S_CSI) {
        let j = i;
        while (j < len) {
          const b = chunk[j];
          if (b >= 0x40 && b <= 0x7e) break;
          j++;
        }
        if (j >= len) {
          emitPlain(chunk.subarray(i));
          if (csi.length < 128) csi += latin1(chunk, i, len);
          break;
        }
        emitPlain(chunk.subarray(i, j + 1));
        if (csi.length < 128) csi += latin1(chunk, i, j);
        const fin = chunk[j];
        i = j + 1;
        state = S_GROUND;
        if (fin === 0x48 /* H */ || fin === 0x66 /* f */) cup(csi);
        else if (fin === 0x74 /* t */) winops(csi);
        else if ((fin === 0x68 /* h */ || fin === 0x6c /* l */) && csi.charCodeAt(0) === 0x3f /* ? */) decMode(csi, fin === 0x68);
        else if (fin === 0x75 /* u */) keyboardFlags(csi);
        continue;
      }
      if (state === S_APC) {
        let e = chunk.indexOf(ESC, i);
        if (e < 0) e = len;
        st.apcBytes += e - i;
        if (!apcSep) {
          const s = chunk.indexOf(0x3b /* ; */, i);
          if (s >= 0 && s < e) {
            if (apcHead.length < 4096) apcHead += latin1(chunk, i, s);
            apcSep = true;
            if (e > s + 1) apcParts.push(latin1(chunk, s + 1, e));
          } else if (apcHead.length < 4096) apcHead += latin1(chunk, i, e);
        } else if (e > i) apcParts.push(latin1(chunk, i, e));
        i = e;
        if (i < len) {
          i++;
          st.apcBytes++;
          state = S_APC_ESC;
        }
        continue;
      }
      /* S_APC_ESC */
      if (chunk[i] === 0x5c /* \ */) {
        i++;
        st.apcBytes++;
        state = S_GROUND;
        finishApc();
      } else {
        /* a stray ESC inside the payload (not legal kitty, but do not lose a byte) */
        if (apcSep) apcParts.push("\x1b");
        else if (apcHead.length < 4096) apcHead += "\x1b";
        state = S_APC;
      }
    }
    if (!frameOpen) return { plain, ops, payloads };
    const done = { plain, ops: ops.slice(0, frameOps), payloads: payloads.slice(0, framePayloads) };
    ops = ops.slice(frameOps);
    payloads = payloads.slice(framePayloads);
    frameOps = 0;
    framePayloads = 0;
    return done;
  }

  return {
    push,
    forget(id: number): void {
      const pix = id < 0 ? held.get(id) : bound.get(id);
      if (!pix) return;
      drop(pix);
      st.forgotten++;
    },
    snapshot(): Snapshot {
      const out: Op[] = [{ t: "reset" }];
      for (const pix of [...held.values()]) {
        if (!pix.ids) {
          drop(pix);
          continue;
        }
        out.push({ t: "img", id: pix.key, fmt: "png", w: pix.w, h: pix.h, len: 0, hash: hex(pix.hash) });
      }
      for (const [id, pix] of bound) out.push({ t: "ref", id, src: pix.key });
      for (const p of placements.values()) out.push(p);
      return { modes: modeBytes(), ops: out };
    },
    inFrame: () => frameOpen,
    reset(): void {
      state = S_GROUND;
      csi = "";
      apcHead = "";
      apcParts = [];
      apcSep = false;
      pending = null;
      cursorCol = cursorRow = savedCol = savedRow = 1;
      frameOpen = false;
      ops = [];
      payloads = [];
      clearImages();
      decModes.clear();
      keyboard = [];
    },
    stats(): KittyStreamStats {
      return { ...st, apc: { ...st.apc }, fmt: { ...st.fmt } };
    },
  };
}

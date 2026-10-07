/*
 * herdr-web server: xterm.js in the browser <-> WebSocket <-> Bun PTY running a real
 * `herdr` client attached to the same session. Zero runtime deps beyond Bun >= 1.3.5
 * (native PTY via Bun.spawn({ terminal })).
 *
 * WS protocol (mirrored by web/app.js):
 *   binary client->server : raw input bytes            -> proc.terminal.write(bytes)
 *   text   client->server : {"t":"resize","cols":N,"rows":M}
 *                           {"t":"metrics","cellW":N,"cellH":N,"cols":N,"rows":N,"dpr":N}
 *                           {"t":"miss","id":N}   (client has no pixels for that image id)
 *   binary server->client : 0x00 | terminal bytes (kitty APC cut out)
 *                           0x01 | u32le jsonLen | {"ops":[…]} | payloads…  (payloads: v2 only)
 *   text   server->client : {"t":"hello","prefix":"ctrl+b"} on open, {"t":"exit","code":N} at the end
 *   GET /img/<hash>       : PNG of the pixels an `img` op names (v3)
 *
 * Kitty graphics never reach xterm.js: server/kitty-stream.ts parses the APC here, dedups
 * pixels by hash and hands the browser ready operations, so the page neither re-decodes
 * base64 nor walks every image byte twice. The pixels themselves travel beside the stream,
 * over HTTP (server/image-store.ts).
 */

import { timingSafeEqual, createHash, randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { createImageStore, workerEncoder } from "./image-store.ts";
import { createKittyStream, type KittyStream, type Op } from "./kitty-stream.ts";
import { createScreen, type Screen } from "./screen.ts";
import { encodePng } from "./png.ts";

/* ---------- version gate ---------- */

function versionAtLeast(v: string, want: [number, number, number]): boolean {
  const p = v.split(".").map((n) => parseInt(n, 10));
  const cur: [number, number, number] = [p[0] || 0, p[1] || 0, p[2] || 0];
  for (let i = 0; i < 3; i++) {
    if (cur[i] > want[i]) return true;
    if (cur[i] < want[i]) return false;
  }
  return true;
}

if (!versionAtLeast(Bun.version, [1, 3, 5])) {
  console.error(`bun >= 1.3.5 required for PTY support (have ${Bun.version})`);
  process.exit(1);
}

/* ---------- config ---------- */

const ROOT = dirname(import.meta.dir); // repo root (server/ -> ..)
const HOME = process.env.HOME ?? "/tmp";
const PORT = parseInt(process.env.HERDR_WEB_PORT ?? "8793", 10);
const HOST = process.env.HERDR_WEB_HOST ?? "127.0.0.1";
const SESSION = process.env.HERDR_WEB_SESSION ?? "";
const MAX_CLIENTS = parseInt(process.env.HERDR_WEB_MAX_CLIENTS ?? "6", 10);
/* How long a tab's herdr client waits for the tab to come back after its socket closed. */
const LINGER_MS = parseInt(process.env.HERDR_WEB_LINGER_MS ?? "15000", 10);
/* What a tab that lost only its socket gets back without a repaint: the newest frames of its
 * stream, up to this many bytes (a second or so of a log flood). */
const RESUME_BYTES = parseInt(process.env.HERDR_WEB_RESUME_BYTES ?? String(4 * 1024 * 1024), 10);
const STATE_DIR = process.env.HERDR_WEB_STATE_DIR ?? join(HOME, ".local/state/herdr/plugins/herdr-web");
const TOKEN_FILE = process.env.HERDR_WEB_TOKEN_FILE ?? join(STATE_DIR, "token");
/* token (default) | off. `off` is a deliberate mode for a network you control end to end:
 * no query token, no cookie, anyone who reaches the port is let in. */
const AUTH_OFF = (process.env.HERDR_WEB_AUTH ?? "token").toLowerCase() === "off";
/* Captured before the child-env filter strips HERDR_*. */
const HERDR_BIN = process.env.HERDR_BIN_PATH ?? "herdr";

/* ---------- herdr keybinding prefix ---------- */

/* The client reports the key after the prefix by physical position so herdr's prefix
 * commands survive a non-Latin keyboard layout (see web/app.js) — for that it has to know
 * which chord opens prefix mode. Only [keys].prefix matters, so a scan beats a TOML dep. */
const HERDR_CONFIG = process.env.HERDR_CONFIG_PATH ?? join(HOME, ".config/herdr/config.toml");

async function readHerdrPrefix(): Promise<string> {
  try {
    let inKeys = false;
    for (const raw of (await Bun.file(HERDR_CONFIG).text()).split("\n")) {
      const line = raw.trim();
      if (!line || line.startsWith("#")) continue;
      if (line.startsWith("[")) {
        inKeys = line === "[keys]";
        continue;
      }
      const match = inKeys ? /^prefix\s*=\s*"([^"]+)"/.exec(line) : null;
      if (match) return match[1].trim();
    }
  } catch {} /* no readable config -> herdr's own default */
  return "ctrl+b";
}

const HERDR_PREFIX = await readHerdrPrefix();

/* ---------- token ---------- */

mkdirSync(dirname(TOKEN_FILE), { recursive: true });
let token = "";
let tokenHash: Buffer | null = null;
if (!AUTH_OFF) {
  const tokenFile = Bun.file(TOKEN_FILE);
  if (await tokenFile.exists()) token = (await tokenFile.text()).trim();
  if (!token) {
    token = crypto.randomUUID().replace(/-/g, "");
    await Bun.write(TOKEN_FILE, token + "\n");
    chmodSync(TOKEN_FILE, 0o600);
  }
  tokenHash = createHash("sha256").update(token).digest();
}

function tokenOk(candidate: string | null | undefined): boolean {
  if (!candidate || tokenHash === null) return false;
  const h = createHash("sha256").update(candidate).digest();
  return timingSafeEqual(h, tokenHash);
}

function cookieToken(req: Request): string | null {
  const header = req.headers.get("cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === "herdr_web_token") return part.slice(eq + 1).trim();
  }
  return null;
}

/* Query token wins (first visit via shared URL), cookie covers everything after. */
function authed(req: Request, url: URL): { ok: boolean; viaQuery: boolean } {
  if (AUTH_OFF) return { ok: true, viaQuery: false };
  const q = url.searchParams.get("token");
  if (tokenOk(q)) return { ok: true, viaQuery: true };
  if (tokenOk(cookieToken(req))) return { ok: true, viaQuery: false };
  return { ok: false, viaQuery: false };
}

/* ---------- static routes (explicit map, no path traversal) ---------- */

const STATIC: Record<string, { path: string; type: string }> = {
  "/": { path: join(ROOT, "web/index.html"), type: "text/html; charset=utf-8" },
  "/app.js": { path: join(ROOT, "web/app.js"), type: "text/javascript" },
  "/kitty-view.js": { path: join(ROOT, "web/kitty-view.js"), type: "text/javascript" },
  "/fonts/JetBrainsMonoNFM-Regular.woff2": { path: join(ROOT, "web/fonts/JetBrainsMonoNFM-Regular.woff2"), type: "font/woff2" },
  "/fonts/JetBrainsMonoNFM-Bold.woff2": { path: join(ROOT, "web/fonts/JetBrainsMonoNFM-Bold.woff2"), type: "font/woff2" },
  "/icons/favicon.png": { path: join(ROOT, "web/icons/favicon.png"), type: "image/png" },
  "/icons/apple-touch-icon.png": { path: join(ROOT, "web/icons/apple-touch-icon.png"), type: "image/png" },
  "/vendor/xterm.js": { path: join(ROOT, "node_modules/@xterm/xterm/lib/xterm.js"), type: "text/javascript" },
  "/vendor/xterm.css": { path: join(ROOT, "node_modules/@xterm/xterm/css/xterm.css"), type: "text/css" },
  "/vendor/addon-fit.js": { path: join(ROOT, "node_modules/@xterm/addon-fit/lib/addon-fit.js"), type: "text/javascript" },
  "/vendor/addon-webgl.js": { path: join(ROOT, "node_modules/@xterm/addon-webgl/lib/addon-webgl.js"), type: "text/javascript" },
  "/vendor/addon-clipboard.js": { path: join(ROOT, "node_modules/@xterm/addon-clipboard/lib/addon-clipboard.js"), type: "text/javascript" },
  "/vendor/addon-unicode11.js": { path: join(ROOT, "node_modules/@xterm/addon-unicode11/lib/addon-unicode11.js"), type: "text/javascript" },
  "/vendor/addon-web-links.js": { path: join(ROOT, "node_modules/@xterm/addon-web-links/lib/addon-web-links.js"), type: "text/javascript" },
};

/* ---------- file paste (browser clipboard / picker / drop -> file -> path) ---------- */

const PASTE_DIR = join(STATE_DIR, "pastes");
const PASTE_MAX_BYTES = 25 * 1024 * 1024;
const PASTE_KEEP = 40;
/* Preferred extensions for clipboard images (their File.name is a generic "image.png"). */
const PASTE_EXT: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
};
let pasteSeq = 0;

function prunePastes(): void {
  try {
    const names = readdirSync(PASTE_DIR).filter((n) => n.startsWith("paste-")).sort();
    for (const n of names.slice(0, Math.max(0, names.length - PASTE_KEEP))) {
      rmSync(join(PASTE_DIR, n), { force: true });
    }
  } catch {}
}

/** "Screenshot 2026-08-04 (1).png" -> "Screenshot_2026-08-04_1_.png"; keeps unicode
 * letters and ALWAYS preserves the extension ("résumé.pdf" -> "résumé.pdf"). */
function sanitizeName(raw: string | null): string | null {
  if (!raw) return null;
  const base = raw.split(/[\\/]/).pop() ?? "";
  const dot = base.lastIndexOf(".");
  const stem = (dot > 0 ? base.slice(0, dot) : base)
    .replace(/[^\p{L}\p{N}._-]+/gu, "_")
    .replace(/^[._]+/, "")
    .slice(0, 48);
  const ext = (dot > 0 ? base.slice(dot + 1) : "").replace(/[^A-Za-z0-9]+/g, "").slice(0, 10).toLowerCase();
  if (!stem && !ext) return null;
  return (stem || "file") + (ext ? `.${ext}` : "");
}

async function handlePaste(req: Request, url: URL): Promise<Response> {
  const type = (req.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
  const bytes = await req.arrayBuffer();
  if (bytes.byteLength === 0) return new Response("empty body", { status: 400 });
  if (bytes.byteLength > PASTE_MAX_BYTES) return new Response("too large", { status: 413 });

  const given = sanitizeName(url.searchParams.get("name"));
  const imgExt = PASTE_EXT[type];
  /* Clipboard images get a stable ext from the MIME type; anything else keeps its
   * (sanitized) filename so the agent still sees "report.pdf", not "blob.bin". */
  const suffix = imgExt && (!given || /^image\.\w+$/i.test(given))
    ? `.${imgExt}`
    : `-${given ?? "file.bin"}`;

  mkdirSync(PASTE_DIR, { recursive: true });
  const path = join(PASTE_DIR, `paste-${Date.now()}-${(pasteSeq++).toString(36)}${suffix}`);
  await Bun.write(path, bytes);
  prunePastes();
  return Response.json({ ok: true, path });
}

/* ---------- PTY spawn ---------- */

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, Math.round(n)));

/** PTY handle exposed by Bun.spawn({ terminal }) — the part of the API we rely on. */
interface PtyHandle {
  write(data: string | Uint8Array): void;
  resize(cols: number, rows: number): void;
  close(): void;
}

/** Spawned herdr client: PTY plus lifecycle. Named so callers don't couple to Bun.spawn. */
interface HerdrClientProc {
  readonly pid: number;
  readonly terminal: PtyHandle | null;
  kill(signal?: number | NodeJS.Signals): void;
}

/** What the page said it understands (`?v=`):
 *   3 — tagged frames, pixels fetched over HTTP by content hash (the current page);
 *   2 — tagged frames with the pixels inside the ops frame (a tab loaded before v3);
 *   1 — nothing (a tab from before tagged frames, or a stale PWA cache): the raw PTY
 *       stream it expects, since framed bytes would land in its terminal as escape soup.
 * A tab left open across a deploy keeps the protocol it was built for; reloading it is
 * what upgrades it. */
type Proto = 1 | 2 | 3;

/** A herdr client and what its page has been sent. While a page is attached the output goes
 * there. When the page's socket closes, a seat whose tab said who it is (`?tab=`, kept in the
 * tab's sessionStorage) waits LINGER_MS for that tab to come back — a reload, a dropped socket —
 * and hands it the running client: a new attach costs 15–350 ms of waiting on the herdr
 * server. The seat's frames are numbered and the newest kept, so a tab that lost only its
 * socket gets back exactly what it missed (takeOver). */
interface Seat {
  tab: string | null;
  proto: Proto;
  proc: HerdrClientProc | null;
  /** per client, like the plain-frame buffer: herdr re-encodes and re-transmits every image
   * for every attached client */
  ks: KittyStream | null;
  cols: number;
  rows: number;
  /* css pixels per cell, reported by the page; 8x16 until it does */
  cellW: number;
  cellH: number;
  out: { buf: Uint8Array; len: number };
  ws: Ws | null;
  linger: ReturnType<typeof setTimeout> | null;
  /** names the numbering: a page resumes only the stream it counted */
  gen: string;
  /** frames made so far, which is also the number the next one gets */
  seq: number;
  /** the newest frames, `frames[head..]`, RESUME_BYTES of them at most (see keeps) */
  kept: { frames: Uint8Array[]; head: number; bytes: number };
  /** what herdr has drawn, for a page that starts from nothing or skips (kept seats only) */
  screen: Screen | null;
  /** frames are not sent to the page: it is behind, or waits for a snapshot (see FLOW_HIGH) */
  skipping: boolean;
  /** a snapshot is due once the stream is at rest ("wanted"), or on its way ("taking") */
  snap: "wanted" | "taking" | null;
}

/** Per connection: what the page asked for, and the seat it streams from. */
type WsData = {
  cols: number;
  rows: number;
  proto: Proto;
  tab: string | null;
  /** the page still shows seat `gen`'s stream up to frame `seq` (`?resume=gen.seq`): the tab
   * lost its socket, not its screen */
  resume: { gen: string; seq: number } | null;
  /** terminal bytes sent on this socket, and those the page says its terminal has parsed;
   * `acked` stays null for a page that does not say (one older than flow control) */
  flow: { sent: number; acked: number | null };
  seat: Seat | null;
};
type Ws = Bun.ServerWebSocket<WsData>;

let clients = 0;
let legacyClients = 0;
let sendDropped = 0;
let sendBackpressure = 0;
/* snapshots sent: a page that took a running client over, or skipped frames it was behind on */
let snapshotsSent = 0;
const seats = new Set<Seat>();
const seatsByTab = new Map<string, Seat>();

/* The page is told this when another page with its tab id (a duplicated tab copies
 * sessionStorage) took its seat; it picks a new id and reconnects (web/app.js). */
const CLOSE_TAKEN_OVER = 4000;

/* Shared by every connection: herdr sends each client the same pixels, and this encodes them
 * once. */
const images = createImageStore({ encode: workerEncoder() });

const TAG_TERM = 0x00;
const TAG_OPS = 0x01;
/* Terminal bytes leave at the end of every PTY read, as one frame. Batching reads (8 ms)
 * put those 8 ms on top of every keystroke echo and scroll step — half the measured echo —
 * while a 3 MB/s log flood cost neither more CPU nor long tasks without it. One read can
 * still yield several pieces (APC cut out between them); the buffer joins them into one
 * frame of at most: */
const PLAIN_FRAME_BYTES = 64 * 1024;
const ENC = new TextEncoder();

/* Pre-compression frame sizes: the only way to tell a steady-state text stream from a
 * re-transmitted image when reading /health. */
let sentTermBytes = 0;
let sentOpsBytes = 0;
/* herdr pixel bytes of seats that have ended (see /health, payloadBytesTotal) */
let endedPayloadBytes = 0;

/* Flow control. A page that parses slower than herdr writes (a phone under a log flood) used to
 * fall seconds behind, every keystroke's echo queued after megabytes of frames. The page tells
 * what its terminal has parsed (`{"t":"ack","n":bytes}`). Once more than FLOW_HIGH bytes wait
 * unparsed, its frames stop; once it is down to FLOW_LOW, it gets a snapshot of the screen as it
 * is now (server/screen.ts) and the frames from there on: what it skipped is drawn over anyway.
 * Stopping herdr's client (SIGSTOP) instead does not get there: herdr's server leaves ~200 KB
 * of stale frames in the client's socket, and those come first after every stop (echo p95
 * ~600 ms on a throttled phone profile). */
const FLOW_HIGH = parseInt(process.env.HERDR_WEB_FLOW_HIGH ?? String(64 * 1024), 10);
const FLOW_LOW = parseInt(process.env.HERDR_WEB_FLOW_LOW ?? String(16 * 1024), 10);

function checkFlow(ws: Ws): void {
  const seat = ws.data.seat;
  const { sent, acked } = ws.data.flow;
  if (!seat?.screen || seat.ws !== ws || acked === null) return;
  if (!seat.skipping && sent - acked > FLOW_HIGH) seat.skipping = true;
  else if (seat.skipping && !seat.snap && sent - acked <= FLOW_LOW) wantSnapshot(seat);
}

function wantSnapshot(seat: Seat): void {
  seat.snap = "wanted";
  trySnapshot(seat);
}

/** The page gets the screen and its images as they are at frame `at`, then the frames from
 * `at` on. Tried again after every PTY read until the stream is at rest (server/screen.ts) and
 * herdr is between frames: inside one, the images already parsed are in the stream's state
 * while their ops wait for the frame's end (server/kitty-stream.ts). */
function trySnapshot(seat: Seat): void {
  const ws = seat.ws;
  const screen = seat.screen;
  if (seat.snap !== "wanted" || !ws || !screen || !seat.ks || !screen.atRest || seat.ks.inFrame()) return;
  seat.snap = "taking";
  const at = seat.seq;
  const { modes, ops } = seat.ks.snapshot();
  for (const op of ops) if (op.t === "img" && images.has(op.hash)) op.url = "/img/" + op.hash;
  void screen.snapshot().then((cells) => {
    if (seat.ws !== ws || seat.snap !== "taking") return;
    seat.snap = null;
    const after = keptFrom(seat, at);
    if (!after) return wantSnapshot(seat); /* what came meanwhile is no longer all kept */
    /* for the page's count: these two frames are the snapshot, frame `at` comes next */
    ws.send(JSON.stringify({ t: "snapshot", seq: at, frames: 2 }));
    const term = new Uint8Array(1 + cells.length + modes.length);
    term[0] = TAG_TERM;
    term.set(cells, 1);
    term.set(modes, 1 + cells.length);
    seat.skipping = false;
    snapshotsSent++;
    sendFrame(ws, term, true);
    sendFrame(ws, opsFrame(ops, []), true);
    for (const frame of after) {
      if (seat.skipping) break; /* behind again already: the next snapshot covers the rest */
      sendFrame(ws, frame, frame[0] === TAG_OPS);
    }
  });
}

function sendFrame(ws: Ws, frame: Uint8Array, compress: boolean): void {
  if (ws.readyState !== 1) return;
  if (frame[0] === TAG_OPS) sentOpsBytes += frame.length;
  else sentTermBytes += frame.length;
  const res = ws.send(frame, compress);
  /* 0 = Bun dropped the message. Silently losing terminal bytes desynchronizes the grid
   * for good, so close instead and let the page reconnect (herdr repaints from scratch). */
  if (res === 0) {
    sendDropped++;
    console.error(`[ws] send dropped ${frame.length}B — closing so the client can resync`);
    try {
      ws.close(1013, "overloaded");
    } catch {}
    return;
  }
  if (res === -1) sendBackpressure++;
  if (frame[0] === TAG_TERM) {
    ws.data.flow.sent += frame.length - 1;
    checkFlow(ws);
  }
}

/** Only a v3 page that said which tab it is can come back for its stream. */
const keeps = (seat: Seat) => seat.tab !== null && seat.proto >= 3 && RESUME_BYTES > 0;

/** One frame of the seat's stream: numbered, kept for the tab in case its socket drops, and
 * sent to the page attached now, if any. */
function emit(seat: Seat, frame: Uint8Array, compress: boolean): void {
  seat.seq++;
  if (keeps(seat)) {
    const k = seat.kept;
    k.frames.push(frame);
    k.bytes += frame.length;
    while (k.bytes > RESUME_BYTES && k.frames.length - k.head > 1) k.bytes -= k.frames[k.head++].length;
    if (k.head >= 1024 && k.head * 2 >= k.frames.length) {
      k.frames = k.frames.slice(k.head);
      k.head = 0;
    }
  }
  if (seat.ws && !seat.skipping) sendFrame(seat.ws, frame, compress);
}

function flushPlain(seat: Seat): void {
  const c = seat.out;
  if (c.len <= 1) return;
  /* a kept frame outlives the buffer, which the next read refills */
  emit(seat, keeps(seat) ? c.buf.slice(0, c.len) : c.buf.subarray(0, c.len), false);
  c.len = 1;
}

function appendPlain(seat: Seat, view: Uint8Array): void {
  const c = seat.out;
  if (c.len + view.length > c.buf.length) flushPlain(seat);
  if (view.length + 1 > c.buf.length) {
    /* A single chunk bigger than the whole window: frame it on its own. */
    const frame = new Uint8Array(view.length + 1);
    frame[0] = TAG_TERM;
    frame.set(view, 1);
    emit(seat, frame, false);
    return;
  }
  c.buf.set(view, c.len);
  c.len += view.length;
  if (c.len >= PLAIN_FRAME_BYTES) flushPlain(seat);
}

function opsFrame(ops: Op[], payloads: Uint8Array[]): Uint8Array {
  const json = ENC.encode(JSON.stringify({ ops }));
  let total = 5 + json.length;
  for (const p of payloads) total += p.length;
  const frame = new Uint8Array(total);
  frame[0] = TAG_OPS;
  new DataView(frame.buffer).setUint32(1, json.length, true);
  frame.set(json, 5);
  let off = 5 + json.length;
  for (const p of payloads) {
    frame.set(p, off);
    off += p.length;
  }
  return frame;
}

/** v3: the pixels go to the shared store and the page fetches them by URL. Pixels that cannot
 * be served get no URL; the page reports the miss as it would a bad decode. */
function storePixels(ops: Op[], payloads: Uint8Array[]): void {
  let next = 0;
  for (const op of ops) {
    if (op.t !== "img") continue;
    if (images.put(op.hash, op.fmt, op.w, op.h, payloads[next++])) op.url = "/img/" + op.hash;
    op.fmt = "png";
    op.len = 0;
  }
}

function sendOps(seat: Seat, ops: Op[], payloads: Uint8Array[]): void {
  /* Terminal bytes first: ops carry resolved cell coordinates, but keeping the two streams
   * in submission order means an image never appears a frame before the text around it. */
  flushPlain(seat);
  if (seat.proto >= 3) {
    /* the frame stays a few hundred bytes however big the image, and nothing here waits for
     * an encode */
    storePixels(ops, payloads);
    emit(seat, opsFrame(ops, []), true);
    return;
  }
  /* v2 page: raw pixels leave as PNG (server/png.ts) inside the frame. */
  let raw = false;
  let next = 0;
  for (const op of ops) {
    if (op.t !== "img") continue;
    const i = next++;
    if (op.fmt === "png") continue;
    const channels = op.fmt === "rgba" ? 4 : 3;
    if (op.w > 0 && op.h > 0 && payloads[i].length >= op.w * op.h * channels) {
      payloads[i] = encodePng(payloads[i], op.w, op.h, channels);
      op.fmt = "png";
      op.len = payloads[i].length;
    } else raw = true;
  }
  /* PNG is deflated already; a frame of plain ops (or pixels that could not be encoded)
   * still shrinks a lot on the way to a phone. */
  emit(seat, opsFrame(ops, payloads), raw || payloads.length === 0);
}

/** One PTY read of a seat's herdr client. With no page attached the frames are made all the
 * same: they wait for the tab, and the image bookkeeping stays current. */
function pump(seat: Seat, bytes: Uint8Array): void {
  const ks = seat.ks;
  if (!ks) {
    /* Pre-protocol page: byte-for-byte what it was built against. */
    if (seat.ws?.readyState === 1) seat.ws.send(bytes);
    return;
  }
  const { plain, ops, payloads } = ks.push(bytes);
  for (const view of plain) {
    seat.screen?.write(view);
    appendPlain(seat, view);
  }
  if (ops.length) sendOps(seat, ops, payloads);
  flushPlain(seat);
  if (seat.snap === "wanted") trySnapshot(seat);
}

function newSeat(ws: Ws): Seat {
  const seat: Seat = {
    tab: ws.data.tab,
    proto: ws.data.proto,
    proc: null,
    ks: null,
    cols: ws.data.cols,
    rows: ws.data.rows,
    cellW: 8,
    cellH: 16,
    out: { buf: new Uint8Array(PLAIN_FRAME_BYTES + 1), len: 1 },
    ws,
    linger: null,
    gen: randomBytes(8).toString("hex"),
    seq: 0,
    kept: { frames: [], head: 0, bytes: 0 },
    screen: null,
    skipping: false,
    snap: null,
  };
  if (seat.proto >= 2) {
    seat.ks = createKittyStream({
      cellSize: () => ({ w: seat.cellW, h: seat.cellH }),
      grid: () => ({ cols: seat.cols, rows: seat.rows }),
      reply: (bytes) => seat.proc?.terminal?.write(bytes),
    });
  }
  if (keeps(seat)) seat.screen = createScreen(seat.cols, seat.rows);
  ws.data.seat = seat;
  seats.add(seat);
  if (seat.tab) {
    const prev = seatsByTab.get(seat.tab);
    if (prev) endSeat(prev);
    seatsByTab.set(seat.tab, seat);
  }
  return seat;
}

/** Killing the herdr client is a clean detach; the session lives on. */
function endSeat(seat: Seat): void {
  if (seat.linger) {
    clearTimeout(seat.linger);
    seat.linger = null;
  }
  if (!seats.delete(seat)) return; /* ended already */
  endedPayloadBytes += seat.ks?.stats().payloadBytes ?? 0;
  seat.screen?.dispose();
  seat.screen = null;
  if (seat.tab && seatsByTab.get(seat.tab) === seat) seatsByTab.delete(seat.tab);
  const proc = seat.proc;
  seat.proc = null;
  if (!proc) return;
  try {
    proc.kill();
  } catch {}
  try {
    proc.terminal?.close();
  } catch {}
}

/** The socket closed: a seat whose tab can come back waits for it, the rest end now. At most
 * MAX_CLIENTS seats wait; the oldest goes first. */
function park(seat: Seat): boolean {
  if (!seat.tab || !seat.proc || seat.proto < 3 || LINGER_MS <= 0) return false;
  seat.linger = setTimeout(() => endSeat(seat), LINGER_MS);
  let waiting = 0;
  for (const s of seats) if (!s.ws && s.proc) waiting++;
  for (const s of seats) {
    if (waiting <= MAX_CLIENTS) break;
    if (s.ws || !s.proc) continue;
    endSeat(s);
    waiting--;
  }
  return true;
}

/** The first message on every socket: herdr's prefix key, and where the page stands in the
 * seat's stream. `seq` numbers the next binary frame. `resumed`: the page keeps its screen and
 * gets the `missed` frames it lost; otherwise the whole screen follows: a snapshot for a running
 * herdr client (`{"t":"snapshot"}`, see trySnapshot), a first paint for a new one. */
function hello(ws: Ws, seat: Seat, missed: number | null): void {
  ws.send(
    JSON.stringify({
      t: "hello",
      prefix: HERDR_PREFIX,
      gen: seat.gen,
      seq: seat.seq - (missed ?? 0),
      resumed: missed !== null,
      missed: missed ?? 0,
    }),
  );
}

/** The kept frames from number `seq` on, when all of them are still kept. */
function keptFrom(seat: Seat, seq: number): Uint8Array[] | null {
  const k = seat.kept;
  const first = seat.seq - (k.frames.length - k.head);
  if (seq < first || seq > seat.seq) return null;
  return k.frames.slice(k.head + (seq - first));
}

/** The tab is back and gets its running herdr client; true when its stream was resumed. A
 * page that lost only its socket (`?resume=`) still shows the stream up to some frame: it gets
 * the frames after that one, and herdr is not asked for anything. A page that starts from
 * nothing (a reload), or whose frames are no longer all kept, gets a snapshot of the screen and
 * its images at once instead of waiting 5-90 ms for herdr's repaint, and SIGWINCH all the
 * same: herdr's own repaint has the last word on the screen (a resize to the same size would
 * not signal). */
function takeOver(seat: Seat, ws: Ws): boolean {
  if (seat.linger) {
    clearTimeout(seat.linger);
    seat.linger = null;
  }
  const prev = seat.ws;
  if (prev && prev !== ws) {
    /* Another page with this tab id holds the seat: the newcomer takes it, the other picks a
     * new id. A reload whose old socket has not closed yet lands here too, harmlessly. */
    prev.data.seat = null;
    try {
      prev.close(CLOSE_TAKEN_OVER, "tab id taken over");
    } catch {}
  }
  seat.ws = ws;
  ws.data.seat = seat;
  seat.skipping = false;
  seat.snap = null;
  const proc = seat.proc;
  const resized = ws.data.cols !== seat.cols || ws.data.rows !== seat.rows;
  if (resized) {
    seat.cols = ws.data.cols;
    seat.rows = ws.data.rows;
    seat.screen?.resize(seat.cols, seat.rows);
    proc?.terminal?.resize(seat.cols, seat.rows); /* the kernel signals, herdr repaints */
  }
  const resume = ws.data.resume;
  const missed = resume?.gen === seat.gen ? keptFrom(seat, resume.seq) : null;
  hello(ws, seat, missed ? missed.length : null);
  if (missed) {
    for (const frame of missed) sendFrame(ws, frame, frame[0] === TAG_OPS);
    return true;
  }
  seat.skipping = true;
  wantSnapshot(seat);
  if (proc && !resized) {
    try {
      process.kill(proc.pid, "SIGWINCH");
    } catch {}
  }
  return false;
}

/*
 * Spawning is deliberately isolated here: if Bun's native PTY ever misbehaves on this
 * machine, swapping to node-pty means replacing this one function (see plan).
 */
function startClient(seat: Seat): HerdrClientProc {
  /* HERDR_ENV=1 (and friends) in our env would make the client refuse to start
   * ("blocks nested launches by design"), so build a clean env. */
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined && !k.startsWith("HERDR_")) env[k] = v;
  }
  env.TERM = "xterm-256color";
  env.COLORTERM = "truecolor";

  const cmd = [HERDR_BIN];
  if (SESSION) cmd.push("--session", SESSION);

  const proc = Bun.spawn(cmd, {
    cwd: HOME,
    env,
    terminal: {
      cols: seat.cols,
      rows: seat.rows,
      data(_term, bytes: Uint8Array) {
        pump(seat, bytes);
      },
    },
    onExit(_proc, exitCode) {
      const ws = seat.ws;
      endSeat(seat);
      if (!ws) return;
      try {
        ws.send(JSON.stringify({ t: "exit", code: exitCode }));
      } catch {}
      try {
        ws.close();
      } catch {}
    },
  });
  return proc as unknown as HerdrClientProc;
}

/* The URL names the content, so what it returns never changes: the browser may keep it for
 * good, and a reloaded tab takes it from its cache instead of the network. A page that asks
 * while the worker is still encoding simply waits for it. */
async function serveImage(hash: string): Promise<Response> {
  const png = await images.get(hash);
  if (!png) return new Response("not found", { status: 404 });
  /* every PNG here sits on a plain ArrayBuffer (a worker transfer or a decoded payload); the
   * type only says ArrayBufferLike */
  return new Response(png as Uint8Array<ArrayBuffer>, {
    headers: { "content-type": "image/png", "cache-control": "private, max-age=31536000, immutable" },
  });
}

/* ---------- server ---------- */

/** The request carries the Origin of another site (see fetch). An unparsable Origin, such as
 * "null" from a sandboxed frame, counts as foreign. */
function foreignOrigin(req: Request, url: URL): boolean {
  const origin = req.headers.get("origin");
  if (origin === null) return false;
  try {
    return new URL(origin).host !== url.host;
  } catch {
    return true;
  }
}

const server = Bun.serve<WsData>({
  hostname: HOST,
  port: PORT,

  fetch(req, srv) {
    const url = new URL(req.url);

    /* A page of another site can open a WebSocket to this port, or POST to it, from the user's
     * own browser: neither is bound by the same-origin policy, and with HERDR_WEB_AUTH=off
     * nothing else would stop it from driving the terminal. The mirror's page is same-origin
     * and native clients send no Origin. A reverse proxy in front must pass the Host header on. */
    if ((url.pathname === "/ws" || url.pathname === "/paste") && foreignOrigin(req, url)) {
      return new Response("forbidden", { status: 403 });
    }

    if (url.pathname === "/health") {
      let cached = 0;
      let uniqueBytes = 0;
      let dupeBytesSaved = 0;
      let payloadBytes = 0;
      let placeDeduped = 0;
      let placeSent = 0;
      for (const seat of seats) {
        const s = seat.ks?.stats();
        if (!s) continue;
        cached += s.cached;
        uniqueBytes += s.uniqueBytes;
        dupeBytesSaved += s.dupeBytesSaved;
        payloadBytes += s.payloadBytes;
        placeDeduped += s.placeDeduped;
        placeSent += s.apc.p + s.apc.T - s.placeDeduped;
      }
      let parked = 0;
      for (const seat of seats) if (!seat.ws && seat.proc) parked++;
      return Response.json({
        ok: true,
        clients,
        parked,
        legacyClients,
        sendDropped,
        sendBackpressure,
        snapshots: snapshotsSent,
        sent: { termBytes: sentTermBytes, opsBytes: sentOpsBytes },
        /* payloadBytes: what the seats alive now were sent; the total also counts ended ones,
         * so it only grows, across reloads and reconnects too */
        images: { cached, uniqueBytes, dupeBytesSaved, payloadBytes, payloadBytesTotal: endedPayloadBytes + payloadBytes },
        placements: { sent: placeSent, deduped: placeDeduped },
        encoded: images.stats(),
      });
    }

    const auth = authed(req, url);

    if (url.pathname === "/ws") {
      if (!auth.ok) return new Response("forbidden", { status: 403 });
      if (clients >= MAX_CLIENTS) return new Response("too many clients", { status: 429 });
      const cols = clamp(parseInt(url.searchParams.get("cols") ?? "80", 10) || 80, 20, 500);
      const rows = clamp(parseInt(url.searchParams.get("rows") ?? "24", 10) || 24, 10, 200);
      const v = parseInt(url.searchParams.get("v") ?? "", 10);
      const tab = url.searchParams.get("tab") ?? "";
      const resume = /^([0-9a-f]{16})\.(\d{1,15})$/.exec(url.searchParams.get("resume") ?? "");
      if (
        srv.upgrade(req, {
          data: {
            cols,
            rows,
            proto: v >= 3 ? 3 : v === 2 ? 2 : 1,
            tab: /^[0-9a-f]{16,64}$/.test(tab) ? tab : null,
            resume: resume ? { gen: resume[1], seq: Number(resume[2]) } : null,
            flow: { sent: 0, acked: null },
            seat: null,
          },
        })
      ) {
        return;
      }
      return new Response("upgrade failed", { status: 400 });
    }

    if (url.pathname === "/paste" && req.method === "POST") {
      if (!auth.ok) return new Response("forbidden", { status: 403 });
      return handlePaste(req, url);
    }

    const img = /^\/img\/([0-9a-f]{16})$/.exec(url.pathname);
    if (img) {
      if (!auth.ok) return new Response("forbidden", { status: 403 });
      return serveImage(img[1]);
    }

    const entry = STATIC[url.pathname];
    if (!entry) return new Response("not found", { status: auth.ok ? 404 : 403 });
    if (!auth.ok) return new Response("forbidden", { status: 403 });

    const headers: Record<string, string> = {
      "content-type": entry.type,
      "cache-control": /^\/(fonts|vendor|icons)\//.test(url.pathname)
        ? "public, max-age=86400"
        : "no-cache",
    };
    /* Landing with ?token=... once plants the cookie; every later request rides it. */
    if (auth.viaQuery) {
      /* Persistent (1y): survives browser restarts, so a bookmarked bare URL keeps working. */
      headers["set-cookie"] = `herdr_web_token=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=31536000`;
    }
    return new Response(Bun.file(entry.path), { headers });
  },

  websocket: {
    /* 32 MiB matches herdr's own per-transaction wire limit; closing on that limit is the
     * whole point — a dropped message would desync the grid silently (see sendFrame). */
    perMessageDeflate: true,
    backpressureLimit: 32 * 1024 * 1024,
    closeOnBackpressureLimit: true,
    maxPayloadLength: 1024 * 1024 /* inbound is keystrokes and control frames only */,
    idleTimeout: 120,

    open(ws: Ws) {
      clients++;
      if (ws.data.proto < 3) {
        legacyClients++;
        console.log(`[ws] page on protocol v${ws.data.proto} (current v3): reload the tab to upgrade it`);
      }
      const back = ws.data.tab ? seatsByTab.get(ws.data.tab) : undefined;
      if (back?.proc && back.proto === ws.data.proto) {
        const resumed = takeOver(back, ws);
        console.log(
          `[ws] tab back (${clients} active, ${ws.data.cols}x${ws.data.rows}): its herdr client taken over, ` +
            (resumed ? "stream resumed" : "repainted"),
        );
        return;
      }
      const seat = newSeat(ws);
      hello(ws, seat, null);
      try {
        seat.proc = startClient(seat);
        console.log(
          `[ws] client attached (${clients} active, ${ws.data.cols}x${ws.data.rows}` +
            `${ws.data.proto < 3 ? `, legacy v${ws.data.proto}` : ""})`,
        );
      } catch (err) {
        console.error("[ws] spawn failed:", err);
        seat.ws = null;
        endSeat(seat);
        try {
          ws.send(JSON.stringify({ t: "exit", code: -1 }));
        } catch {}
        ws.close();
      }
    },

    message(ws: Ws, msg) {
      const seat = ws.data.seat;
      const proc = seat?.proc;
      if (!seat || !proc?.terminal) return;
      if (typeof msg === "string") {
        try {
          const ctl = JSON.parse(msg);
          if (ctl?.t === "resize") {
            seat.cols = clamp(+ctl.cols || 80, 20, 500);
            seat.rows = clamp(+ctl.rows || 24, 10, 200);
            seat.screen?.resize(seat.cols, seat.rows);
            proc.terminal.resize(seat.cols, seat.rows);
          } else if (ctl?.t === "metrics") {
            /* herdr asks the outer terminal for its cell size (XTWINOPS 16t) and places
             * images in cells; without the real numbers its crop maths is off by pixels. */
            seat.cellW = clamp(+ctl.cellW || 8, 1, 64);
            seat.cellH = clamp(+ctl.cellH || 16, 1, 128);
            if (+ctl.cols && +ctl.rows) {
              seat.cols = clamp(+ctl.cols, 20, 500);
              seat.rows = clamp(+ctl.rows, 10, 200);
            }
          } else if (ctl?.t === "ack" && Number.isFinite(+ctl.n)) {
            /* what the page's terminal has parsed of this socket's terminal bytes; the first
             * ack (0, on open) switches flow control on */
            ws.data.flow.acked = Math.max(ws.data.flow.acked ?? 0, +ctl.n);
            checkFlow(ws);
          } else if (ctl?.t === "miss" && Number.isFinite(+ctl.id)) {
            /* The page evicted those pixels: forget the id so the next transmit ships the
             * bytes again instead of a `ref` to a bitmap that no longer exists. */
            seat.ks?.forget(+ctl.id);
          }
        } catch {} /* invalid control frames are ignored */
        return;
      }
      proc.terminal.write(msg);
    },

    close(ws: Ws) {
      clients = Math.max(0, clients - 1);
      if (ws.data.proto < 3) legacyClients = Math.max(0, legacyClients - 1);
      const seat = ws.data.seat;
      ws.data.seat = null;
      /* no seat: another page with this tab id took it over */
      if (seat?.ws === ws) {
        seat.ws = null;
        if (park(seat)) {
          console.log(`[ws] client detached (${clients} active); herdr client kept ${LINGER_MS / 1000}s for its tab`);
          return;
        }
        endSeat(seat);
      }
      console.log(`[ws] client detached (${clients} active)`);
    },
  },
});

console.log(
  `herdr-web listening on http://${server.hostname}:${server.port} ` +
    `(session=${SESSION || "default"}, max_clients=${MAX_CLIENTS}, herdr=${HERDR_BIN})`,
);
if (AUTH_OFF) {
  console.log(
    "herdr-web: HERDR_WEB_AUTH=off — no authentication, the terminal is open to anyone who " +
      "reaches the port. Use only on a network you control.",
  );
}

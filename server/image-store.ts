/*
 * Pixels the pages fetch over HTTP (`GET /img/<hash>`), encoded once per content hash and
 * shared by every connection.
 *
 * Protocol v2 shipped new pixels inside the tagged WebSocket stream, so one new screenshot
 * cost the mirror's event loop the PNG encode (~50 ms for 1568x882), cost the page's main
 * thread a multi-megabyte message to take in before the next echo, and on a slow link queued
 * the terminal text behind the image bytes on the same TCP connection. In v3 the frame carries
 * only the URL: a worker encodes, the page fetches and decodes off its main thread, and since
 * the URL names the content, the browser's HTTP cache keeps it across reloads and reconnects.
 */

import type { ImgFmt } from "./kitty-stream.ts";

export type Encoder = (px: Uint8Array, w: number, h: number, channels: 3 | 4) => Promise<Uint8Array>;

export interface ImageStoreStats {
  entries: number;
  /** encoded bytes held (PNG) */
  bytes: number;
  /** encodes still running */
  pending: number;
  encoded: number;
  failed: number;
  evicted: number;
}

export interface ImageStore {
  /** Make `hash` fetchable: encodes at most once per hash. False for pixels that cannot be
   * served (raw pixels without dimensions, a payload shorter than they claim). */
  put(hash: string, fmt: ImgFmt, w: number, h: number, px: Uint8Array): boolean;
  /** The PNG for `hash`, after an encode in flight finishes; null when unknown or failed. */
  get(hash: string): Promise<Uint8Array | null>;
  /** Whether `hash` is fetchable (ready or encoding): a page taking a running herdr client
   * over is sent URLs only for pixels the store still has. */
  has(hash: string): boolean;
  stats(): ImageStoreStats;
}

interface Entry {
  bytes: Uint8Array | null;
  ready: Promise<Uint8Array | null>;
}

/* A few hundred screenshots as PNG. A page fetches right after the op that names the image, so
 * this only has to outlast that round trip; the rest saves re-encoding on reconnects. */
const BUDGET_BYTES = 128 * 1024 * 1024;

export function createImageStore(opts: { encode: Encoder; budgetBytes?: number }): ImageStore {
  const budget = opts.budgetBytes ?? BUDGET_BYTES;
  /* Map order is the eviction order: least recently used first. */
  const entries = new Map<string, Entry>();
  let held = 0;
  const st = { pending: 0, encoded: 0, failed: 0, evicted: 0 };

  function touch(hash: string, entry: Entry): void {
    entries.delete(hash);
    entries.set(hash, entry);
  }

  /* Encodes in flight and the image that just became ready are never dropped: the op naming
   * them is already on its way to a page. One image bigger than the whole budget stays too. */
  function trim(keep: Entry): void {
    for (const [hash, entry] of entries) {
      if (held <= budget) return;
      if (!entry.bytes || entry === keep) continue;
      entries.delete(hash);
      held -= entry.bytes.length;
      st.evicted++;
    }
  }

  return {
    put(hash, fmt, w, h, px) {
      const have = entries.get(hash);
      if (have) {
        touch(hash, have);
        return true;
      }
      let encoded: Promise<Uint8Array>;
      if (fmt === "png") {
        encoded = Promise.resolve(px);
      } else {
        const channels = fmt === "rgba" ? 4 : 3;
        if (!(w > 0 && h > 0 && px.length >= w * h * channels)) return false;
        encoded = opts.encode(px, w, h, channels);
      }
      const entry: Entry = { bytes: null, ready: Promise.resolve(null) };
      st.pending++;
      entry.ready = encoded.then(
        (png) => {
          st.pending--;
          st.encoded++;
          if (entries.get(hash) === entry) {
            entry.bytes = png;
            held += png.length;
            trim(entry);
          }
          return png;
        },
        (err) => {
          st.pending--;
          st.failed++;
          if (entries.get(hash) === entry) entries.delete(hash);
          console.error(`[img] encode failed for ${hash}:`, String(err));
          return null;
        },
      );
      entries.set(hash, entry);
      return true;
    },

    async get(hash) {
      const entry = entries.get(hash);
      if (!entry) return null;
      touch(hash, entry);
      return entry.ready;
    },

    has(hash) {
      return entries.has(hash);
    },

    stats() {
      return { entries: entries.size, bytes: held, ...st };
    },
  };
}

/** PNG encoding on one worker thread. A worker that dies fails the jobs it held; the next
 * encode starts a fresh one. */
export function workerEncoder(): Encoder {
  let worker: Worker | null = null;
  let seq = 0;
  const waiting = new Map<number, { resolve(png: Uint8Array): void; reject(err: Error): void }>();

  function spawn(): Worker {
    const w = new Worker(new URL("./png-worker.ts", import.meta.url).href);
    w.onmessage = ({ data }: MessageEvent<{ id: number; png?: Uint8Array; error?: string }>) => {
      const job = waiting.get(data.id);
      if (!job) return;
      waiting.delete(data.id);
      if (data.png) job.resolve(data.png);
      else job.reject(new Error(data.error ?? "no output"));
    };
    w.onerror = (ev: ErrorEvent) => {
      for (const job of waiting.values()) job.reject(new Error(`png worker died: ${ev.message}`));
      waiting.clear();
      w.terminate();
      if (worker === w) worker = null;
    };
    return w;
  }

  return (px, w, h, channels) => {
    const job = Promise.withResolvers<Uint8Array>();
    worker ??= spawn();
    const id = ++seq;
    waiting.set(id, job);
    /* Hand the pixels over rather than copy them, unless they share a buffer with others. */
    const own = px.byteOffset === 0 && px.byteLength === px.buffer.byteLength ? px : px.slice();
    worker.postMessage({ id, px: own.buffer, w, h, channels }, [own.buffer as ArrayBuffer]);
    return job.promise;
  };
}

/*
 * PNG encoding off the mirror's event loop (see server/image-store.ts): a 1568x882 game
 * screenshot is ~50 ms of filtering and deflate, and on the main thread that is 50 ms in which
 * no terminal byte reaches any tab.
 */

import { encodePng } from "./png.ts";

interface EncodeJob {
  id: number;
  px: ArrayBuffer;
  w: number;
  h: number;
  channels: 3 | 4;
}

/* The worker global; typed by hand because bun-types is not a dependency of this repo. */
const port = globalThis as unknown as {
  onmessage: ((event: { data: EncodeJob }) => void) | null;
  postMessage(message: unknown, transfer?: ArrayBuffer[]): void;
};

port.onmessage = ({ data }) => {
  try {
    const png = encodePng(new Uint8Array(data.px), data.w, data.h, data.channels);
    port.postMessage({ id: data.id, png }, [png.buffer as ArrayBuffer]);
  } catch (err) {
    port.postMessage({ id: data.id, error: String(err) });
  }
};

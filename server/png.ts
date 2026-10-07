/*
 * PNG encoder for the pixels the mirror ships to the page.
 *
 * herdr hands every client raw RGBA (f=32): a 1024x720 screenshot is 2.9 MB, and a
 * WebSocket message that size blocks the page's main thread for 70–90 ms just to take it in
 * (measured with decoding and drawing switched off, with and without permessage-deflate).
 * As PNG the same screenshot is ~340 KB, costs ~13 ms here, and the browser decodes it off
 * the main thread (createImageBitmap on a Blob).
 */

import { deflateSync } from "node:zlib";

const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const FILTER_UP = 2;

function chunk(out: Uint8Array, at: number, type: string, data: Uint8Array): number {
  const view = new DataView(out.buffer, out.byteOffset);
  view.setUint32(at, data.length);
  for (let i = 0; i < 4; i++) out[at + 4 + i] = type.charCodeAt(i);
  out.set(data, at + 8);
  view.setUint32(at + 8 + data.length, Bun.hash.crc32(out.subarray(at + 4, at + 8 + data.length)));
  return at + 12 + data.length;
}

/** `px`: w*h pixels of `channels` bytes each (4 = RGBA, 3 = RGB), rows top to bottom. */
export function encodePng(px: Uint8Array, w: number, h: number, channels: 3 | 4): Uint8Array {
  const stride = w * channels;
  /* Up filter on every row (each byte minus the one above it): UI screenshots repeat row to
   * row, so the filtered rows are mostly zeros. Measured on a real screenshot: 8.7x at zlib
   * level 3 in ~13 ms, against 6.5x unfiltered at level 1 and 8.6x for Sub at level 6. */
  const raw = new Uint8Array((stride + 1) * h);
  for (let y = 0, o = 0, row = 0; y < h; y++, o += stride + 1, row += stride) {
    raw[o] = FILTER_UP;
    if (y === 0) raw.set(px.subarray(0, stride), o + 1);
    else for (let i = 0; i < stride; i++) raw[o + 1 + i] = (px[row + i] - px[row - stride + i]) & 0xff;
  }
  const idat = deflateSync(raw, { level: 3 });

  const ihdr = new Uint8Array(13);
  const v = new DataView(ihdr.buffer);
  v.setUint32(0, w);
  v.setUint32(4, h);
  ihdr[8] = 8; /* bits per channel */
  ihdr[9] = channels === 4 ? 6 : 2; /* colour type: RGBA or RGB; compression/filter/interlace stay 0 */

  const out = new Uint8Array(SIGNATURE.length + (12 + 13) + (12 + idat.length) + 12);
  out.set(SIGNATURE, 0);
  let at = chunk(out, SIGNATURE.length, "IHDR", ihdr);
  at = chunk(out, at, "IDAT", idat);
  chunk(out, at, "IEND", new Uint8Array(0));
  return out;
}

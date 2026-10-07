import { describe, expect, test } from "bun:test";
import { crc32, inflateSync } from "node:zlib";
import { encodePng } from "./png.ts";

/* Reference decoder for exactly what encodePng writes (8-bit RGB/RGBA, filters None/Up). The
 * browser is the real consumer; this pins the chunk layout, the CRCs (checked with zlib's
 * crc32, not the encoder's) and the filter arithmetic. */
function decode(png) {
  const buf = Buffer.from(png);
  expect([...buf.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const chunks = [];
  for (let at = 8; at < buf.length; ) {
    const len = buf.readUInt32BE(at);
    const type = buf.toString("latin1", at + 4, at + 8);
    expect(buf.readUInt32BE(at + 8 + len)).toBe(crc32(buf.subarray(at + 4, at + 8 + len)));
    chunks.push({ type, data: buf.subarray(at + 8, at + 8 + len) });
    at += 12 + len;
  }
  expect(chunks.map((c) => c.type)).toEqual(["IHDR", "IDAT", "IEND"]);
  const ihdr = chunks[0].data;
  const w = ihdr.readUInt32BE(0);
  const h = ihdr.readUInt32BE(4);
  const channels = ihdr[9] === 6 ? 4 : ihdr[9] === 2 ? 3 : 0;
  expect([ihdr[8], ihdr[10], ihdr[11], ihdr[12]]).toEqual([8, 0, 0, 0]);
  const raw = inflateSync(chunks[1].data);
  const stride = w * channels;
  expect(raw.length).toBe((stride + 1) * h);
  const px = Buffer.alloc(stride * h);
  for (let y = 0; y < h; y++) {
    const filter = raw[y * (stride + 1)];
    expect([0, 2]).toContain(filter);
    for (let i = 0; i < stride; i++) {
      const v = raw[y * (stride + 1) + 1 + i];
      px[y * stride + i] = filter === 2 && y > 0 ? (v + px[(y - 1) * stride + i]) & 0xff : v;
    }
  }
  return { w, h, channels, px };
}

/* Gradients that wrap around 255 in both directions, so the Up filter sees negative and
 * overflowing differences; the odd width catches a stride off by a pixel. */
function pattern(w, h, channels) {
  const px = Buffer.alloc(w * h * channels);
  for (let i = 0; i < px.length; i++) px[i] = (i * 37 + Math.floor(i / (w * channels)) * 101) & 0xff;
  return px;
}

describe("png", () => {
  test("RGBA comes back pixel for pixel", () => {
    const px = pattern(7, 5, 4);
    const out = decode(encodePng(px, 7, 5, 4));
    expect([out.w, out.h, out.channels]).toEqual([7, 5, 4]);
    expect(out.px.equals(px)).toBe(true);
  });

  test("RGB comes back pixel for pixel", () => {
    const px = pattern(3, 4, 3);
    const out = decode(encodePng(px, 3, 4, 3));
    expect([out.w, out.h, out.channels]).toEqual([3, 4, 3]);
    expect(out.px.equals(px)).toBe(true);
  });

  test("a single row (no row above to filter against) survives", () => {
    const px = pattern(9, 1, 4);
    expect(decode(encodePng(px, 9, 1, 4)).px.equals(px)).toBe(true);
  });
});

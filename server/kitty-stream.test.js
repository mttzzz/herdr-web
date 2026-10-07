import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createKittyStream } from "./kitty-stream.ts";

const HOME = process.env.HOME ?? "/tmp";

function stream(opts = {}) {
  const replies = [];
  const ks = createKittyStream({
    cellSize: () => ({ w: 9, h: 18 }),
    grid: () => ({ cols: 80, rows: 24 }),
    reply: (bytes) => replies.push(Buffer.from(bytes).toString("latin1")),
    ...opts,
  });
  return { ks, replies };
}

/** Feed `text` in fixed-size chunks; returns everything the stream produced. */
function feed(ks, text, chunkSize = 4096) {
  const bytes = Buffer.from(text, "latin1");
  const ops = [];
  const payloads = [];
  const plain = [];
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const res = ks.push(bytes.subarray(i, Math.min(bytes.length, i + chunkSize)));
    ops.push(...res.ops);
    payloads.push(...res.payloads.map((p) => Buffer.from(p)));
    for (const view of res.plain) plain.push(Buffer.from(view));
  }
  return { ops, payloads, plain: Buffer.concat(plain).toString("latin1") };
}

function rgba(w, h, value) {
  return Buffer.alloc(w * h * 4, value);
}

function transmit(keys, payload, chunkChars = 0) {
  const b64 = payload.toString("base64");
  if (!chunkChars) return `\x1b_G${keys};${b64}\x1b\\`;
  const out = [];
  for (let off = 0; off < b64.length; off += chunkChars) {
    const piece = b64.slice(off, off + chunkChars);
    const more = off + chunkChars < b64.length ? 1 : 0;
    out.push(off === 0 ? `\x1b_G${keys},m=${more};${piece}\x1b\\` : `\x1b_Gm=${more};${piece}\x1b\\`);
  }
  return out.join("");
}

/** What one transmit hands the page: the pixels shipped and the binding of herdr id `id`. */
function shipped(ops, id) {
  return { img: ops.find((o) => o.t === "img"), ref: ops.find((o) => o.t === "ref" && o.id === id) };
}

describe("kitty-stream parsing", () => {
  test("reassembles chunked m= payloads at every stream split", () => {
    const px = rgba(8, 8, 0x5a);
    const text = transmit("a=t,f=32,s=8,v=8,i=7,q=2", px, 16);
    for (const size of [1, 2, 3, 5, 17, 64, 4096]) {
      const { ks } = stream();
      const { ops, payloads } = feed(ks, text, size);
      const { img, ref } = shipped(ops, 7);
      expect(img).toMatchObject({ fmt: "rgba", w: 8, h: 8, len: px.length });
      expect(ref).toEqual({ t: "ref", id: 7, src: img.id });
      expect(payloads).toHaveLength(1);
      expect(payloads[0].equals(px)).toBe(true);
    }
  });

  test("survives a split between ESC and the string terminator", () => {
    const px = rgba(4, 4, 1);
    const text = transmit("a=t,f=32,s=4,v=4,i=3,q=2", px);
    const bytes = Buffer.from(text, "latin1");
    const cut = bytes.length - 1; /* leaves ESC at the end of the first chunk */
    const { ks } = stream();
    const first = ks.push(bytes.subarray(0, cut));
    expect(first.ops).toEqual([]);
    const second = ks.push(bytes.subarray(cut));
    const { img, ref } = shipped(second.ops, 3);
    expect(img).toMatchObject({ fmt: "rgba", w: 4, h: 4, len: px.length });
    expect(ref).toEqual({ t: "ref", id: 3, src: img.id });
  });

  test("cuts APC out of the terminal stream and keeps positioning bytes", () => {
    const px = rgba(2, 2, 9);
    const { ks } = stream();
    const { plain, ops } = feed(
      ks,
      "before\x1b[9;4H" + transmit("a=t,f=32,s=2,v=2,i=5,q=2", px) + "\x1b_Ga=p,i=5,p=1,c=6,r=3,q=2\x1b\\after",
    );
    expect(plain).toBe("before\x1b[9;4Hafter");
    expect(ops.find((o) => o.t === "place")).toEqual({
      t: "place",
      id: 5,
      pid: 1,
      col: 4,
      row: 9,
      cols: 6,
      rows: 3,
      z: 0,
      crop: null,
      off: [0, 0],
    });
  });

  test("a=T transmits and places in one command", () => {
    const px = rgba(3, 3, 4);
    const { ks } = stream();
    const { ops } = feed(ks, "\x1b7\x1b[2;2H" + transmit("a=T,f=32,s=3,v=3,i=11,p=2,c=4,r=2,z=1,q=2", px) + "\x1b8");
    expect(ops.map((o) => o.t)).toEqual(["img", "ref", "place"]);
    expect(ops[2]).toMatchObject({ id: 11, pid: 2, col: 2, row: 2, cols: 4, rows: 2, z: 1 });
  });

  test("carries the source crop and the pixel offset", () => {
    const { ks } = stream();
    const { ops } = feed(ks, "\x1b[5;1H\x1b_Ga=p,i=9,p=1,c=10,r=4,x=12,y=7,w=100,h=50,X=3,Y=4,C=1,q=2\x1b\\");
    expect(ops).toEqual([
      { t: "place", id: 9, pid: 1, col: 1, row: 5, cols: 10, rows: 4, z: 0, crop: [12, 7, 100, 50], off: [3, 4] },
    ]);
  });

  test("DECRC restores the row a placement lands on", () => {
    const { ks } = stream();
    const { ops } = feed(
      ks,
      "\x1b[20;5H\x1b7\x1b[3;2H\x1b_Ga=p,i=1,p=1,c=2,r=2,q=2\x1b\\\x1b8\x1b_Ga=p,i=1,p=2,c=2,r=2,q=2\x1b\\",
    );
    expect(ops.map((o) => [o.row, o.col])).toEqual([
      [3, 2],
      [20, 5],
    ]);
  });
});

describe("kitty-stream image bookkeeping", () => {
  const imgOf = (res) => res.ops.find((o) => o.t === "img");

  test("pixels ship once under a page key; identical pixels under a new id are a ref", () => {
    const px = rgba(16, 16, 0x21);
    const { ks } = stream();
    const first = feed(ks, transmit("a=t,f=32,s=16,v=16,i=100,q=2", px));
    const key = imgOf(first).id;
    expect(key).toBeLessThan(0); /* a page key never collides with a herdr image id */
    expect(first.ops).toEqual([
      { t: "img", id: key, fmt: "rgba", w: 16, h: 16, len: px.length, hash: expect.stringMatching(/^[0-9a-f]{16}$/) },
      { t: "ref", id: 100, src: key },
    ]);
    const second = feed(ks, transmit("a=t,f=32,s=16,v=16,i=200,q=2", px));
    expect(second.ops).toEqual([{ t: "ref", id: 200, src: key }]);
    expect(second.payloads).toEqual([]);
    const st = ks.stats();
    expect(st.uniqueBytes).toBe(px.length);
    expect(st.dupeBytesSaved).toBe(px.length);
  });

  test("re-transmitting the same id with the same pixels sends nothing", () => {
    const px = rgba(8, 8, 3);
    const { ks } = stream();
    feed(ks, transmit("a=t,f=32,s=8,v=8,i=42,q=2", px));
    const again = feed(ks, transmit("a=t,f=32,s=8,v=8,i=42,q=2", px));
    expect(again.ops).toEqual([]);
    expect(again.payloads).toEqual([]);
  });

  test("pixels herdr frees on scroll-out (d=I) come back as a ref, not bytes", () => {
    /* herdr deletes an image with d=I as soon as it leaves the screen (scrolled away,
     * another workspace) and re-sends the whole RGBA when it is back: 3–10 MB a trip. */
    const px = rgba(16, 16, 0x5a);
    const { ks } = stream();
    const key = imgOf(feed(ks, transmit("a=t,f=32,s=16,v=16,i=7,q=2", px, 64))).id;
    feed(ks, "\x1b[3;3H\x1b_Ga=p,i=7,p=11,c=4,r=1,q=2\x1b\\");
    expect(feed(ks, "\x1b_Ga=d,d=I,i=7,q=2\x1b\\").ops).toEqual([{ t: "del", scope: "img", id: 7 }]);
    const back = feed(ks, transmit("a=t,f=32,s=16,v=16,i=7,q=2", px, 64));
    expect(back.ops).toEqual([{ t: "ref", id: 7, src: key }]);
    expect(back.payloads).toEqual([]);
    expect(ks.stats().dupeBytesSaved).toBe(px.length);
  });

  test("new pixels under a reused id leave the pixels another id shows alone", () => {
    const a = rgba(8, 8, 1);
    const { ks } = stream();
    const first = imgOf(feed(ks, transmit("a=t,f=32,s=8,v=8,i=1,q=2", a)));
    const keyA = first.id;
    feed(ks, transmit("a=t,f=32,s=8,v=8,i=2,q=2", a)); /* id 2 shows the same pixels */
    const reused = feed(ks, transmit("a=t,f=32,s=8,v=8,i=1,q=2", rgba(8, 8, 2)));
    const keyB = imgOf(reused).id;
    expect(keyB).not.toBe(keyA);
    /* the hash is the URL the page fetches: other pixels must never share it */
    expect(imgOf(reused).hash).not.toBe(first.hash);
    expect(reused.ops).toContainEqual({ t: "ref", id: 1, src: keyB });
    /* the first pixels are still on the page: one more id showing them costs no bytes */
    expect(feed(ks, transmit("a=t,f=32,s=8,v=8,i=3,q=2", a)).ops).toEqual([{ t: "ref", id: 3, src: keyA }]);
  });

  test("a client miss makes the next transmit carry pixels instead of a ref", () => {
    /* The page names a page key (a `ref` that found nothing, its own eviction) or an image
     * id (a placement with nothing to draw); either way those pixels are gone. */
    for (const missOf of [(key) => key, () => 1]) {
      const px = rgba(8, 8, 7);
      const { ks } = stream();
      const first = imgOf(feed(ks, transmit("a=t,f=32,s=8,v=8,i=1,q=2", px)));
      ks.forget(missOf(first.id));
      const after = feed(ks, transmit("a=t,f=32,s=8,v=8,i=2,q=2", px));
      expect(imgOf(after)).toMatchObject({ fmt: "rgba", w: 8, h: 8, len: px.length });
      /* same pixels, same name: the page's HTTP cache answers the second trip */
      expect(imgOf(after).hash).toBe(first.hash);
      expect(after.payloads).toHaveLength(1);
    }
  });

  test("past the page budget the pixels shown longest ago go first", () => {
    const { ks } = stream({ budgetBytes: 2 * 8 * 8 * 4 });
    const keyA = imgOf(feed(ks, transmit("a=t,f=32,s=8,v=8,i=1,q=2", rgba(8, 8, 1)))).id;
    const keyB = imgOf(feed(ks, transmit("a=t,f=32,s=8,v=8,i=2,q=2", rgba(8, 8, 2)))).id;
    feed(ks, "\x1b_Ga=d,d=I,i=1,q=2\x1b\\");
    feed(ks, "\x1b_Ga=d,d=I,i=2,q=2\x1b\\");
    const c = feed(ks, transmit("a=t,f=32,s=8,v=8,i=3,q=2", rgba(8, 8, 3)));
    /* freed before the new pixels land, so the page never holds more than the budget */
    expect(c.ops[0]).toEqual({ t: "del", scope: "img", id: keyA });
    expect(c.ops).not.toContainEqual({ t: "del", scope: "img", id: keyB });
    /* B is still on the page; A has to ship again */
    expect(feed(ks, transmit("a=t,f=32,s=8,v=8,i=2,q=2", rgba(8, 8, 2))).payloads).toEqual([]);
    expect(feed(ks, transmit("a=t,f=32,s=8,v=8,i=1,q=2", rgba(8, 8, 1))).payloads).toHaveLength(1);
  });

  test("pixels on screen stay even when that overshoots the budget", () => {
    const { ks } = stream({ budgetBytes: 8 * 8 * 4 });
    feed(ks, transmit("a=t,f=32,s=8,v=8,i=1,q=2", rgba(8, 8, 1)));
    const second = feed(ks, transmit("a=t,f=32,s=8,v=8,i=2,q=2", rgba(8, 8, 2)));
    expect(second.ops.filter((o) => o.t === "del")).toEqual([]);
    expect(second.payloads).toHaveLength(1);
    expect(ks.stats().cached).toBe(2);
  });

  test("f=24 and f=100 keep their formats", () => {
    const { ks } = stream();
    const rgb = feed(ks, transmit("a=t,f=24,s=2,v=2,i=1,q=2", Buffer.alloc(12, 6)));
    const png = feed(ks, transmit("a=t,f=100,i=2,q=2", Buffer.from("\x89PNG\r\n\x1a\nfake", "latin1")));
    expect(imgOf(rgb)).toMatchObject({ fmt: "rgb" });
    expect(imgOf(png)).toMatchObject({ fmt: "png" });
    expect(ks.stats().fmt).toEqual({ f24: 1, f32: 0, f100: 1 });
  });
});

describe("kitty-stream deletes and resets", () => {
  function placed() {
    const s = stream();
    feed(s.ks, transmit("a=t,f=32,s=4,v=4,i=1,q=2", rgba(4, 4, 1)));
    feed(s.ks, "\x1b[4;4H\x1b_Ga=p,i=1,p=1,c=2,r=2,q=2\x1b\\");
    return s;
  }

  test("d=a drops placements but keeps the pixels cached", () => {
    const { ks } = placed();
    const { ops } = feed(ks, "\x1b_Ga=d,d=a,q=2\x1b\\");
    expect(ops).toEqual([{ t: "del", scope: "all" }]);
    expect(ks.stats().cached).toBe(1);
  });

  test("d=I drops the id and its placements, the page keeps the pixels", () => {
    const { ks } = placed();
    const { ops } = feed(ks, "\x1b_Ga=d,d=I,i=1,q=2\x1b\\");
    expect(ops).toEqual([{ t: "del", scope: "img", id: 1 }]);
    expect(ks.stats().cached).toBe(1);
  });

  test("d=i drops one placement", () => {
    const { ks } = placed();
    const { ops } = feed(ks, "\x1b_Ga=d,d=i,i=1,p=1,q=2\x1b\\");
    expect(ops).toEqual([{ t: "del", scope: "placement", id: 1, pid: 1 }]);
    expect(ks.stats().cached).toBe(1);
  });

  test("d=Z resolves 'newest at the cursor' to concrete placements", () => {
    const { ks } = placed();
    const { ops } = feed(ks, "\x1b[4;4H\x1b_Ga=d,d=Z,q=2\x1b\\");
    expect(ops).toEqual([{ t: "del", scope: "placement", id: 1, pid: 1 }]);
  });

  test("RIS resets the overlay and forwards the byte to the terminal", () => {
    const { ks } = placed();
    const { ops, plain } = feed(ks, "\x1bc");
    expect(ops).toEqual([{ t: "reset" }]);
    expect(plain).toBe("\x1bc");
    expect(ks.stats().cached).toBe(0);
  });
});

describe("kitty-stream replies", () => {
  test("answers the cell-size and window-size queries", () => {
    const { ks, replies } = stream();
    feed(ks, "\x1b[16t\x1b[14t");
    expect(replies).toEqual(["\x1b[6;18;9t", "\x1b[4;432;720t"]);
  });

  test("acks q=0 transmits and queries, stays silent on q=2", () => {
    const { ks, replies } = stream();
    feed(ks, transmit("a=t,f=32,s=2,v=2,i=8,q=0", rgba(2, 2, 1)));
    feed(ks, "\x1b_Ga=q,i=9\x1b\\");
    feed(ks, transmit("a=t,f=32,s=2,v=2,i=10,q=2", rgba(2, 2, 2)));
    expect(replies).toEqual(["\x1b_Gi=8;OK\x1b\\", "\x1b_Gi=9;OK\x1b\\"]);
  });
});

describe("kitty-stream file transport", () => {
  const dir = mkdtempSync(join(HOME, ".kitty-stream-test-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  test("reads t=f payloads from inside $HOME", () => {
    const px = rgba(6, 6, 0x33);
    const path = join(dir, "frame.rgba");
    writeFileSync(path, px);
    const { ks } = stream();
    const { ops, payloads } = feed(ks, transmit("a=t,t=f,f=32,s=6,v=6,i=77,q=2", Buffer.from(path, "utf8")));
    const { img, ref } = shipped(ops, 77);
    expect(img).toMatchObject({ fmt: "rgba", w: 6, h: 6, len: px.length });
    expect(ref).toEqual({ t: "ref", id: 77, src: img.id });
    expect(payloads[0].equals(px)).toBe(true);
    expect(ks.stats().transportFile).toBe(1);
  });

  test("refuses a path outside $HOME and tells the client to drop the image", () => {
    const outside = "/etc/hostname";
    const { ks } = stream();
    const { ops, payloads } = feed(ks, transmit("a=t,t=f,f=32,s=1,v=1,i=78,q=2", Buffer.from(outside, "utf8")));
    expect(ops).toEqual([{ t: "del", scope: "img", id: 78 }]);
    expect(payloads).toEqual([]);
    expect(ks.stats().transportDenied).toBe(1);
  });
});

describe("kitty-stream placement dedup", () => {
  test("repeating the same geometry stops at the server", () => {
    const { ks } = stream();
    feed(ks, transmit("a=t,f=32,s=4,v=4,i=1,q=2", rgba(4, 4, 1)));
    const place = "\x1b7\x1b[6;2H\x1b_Ga=p,i=1,p=1,c=8,r=4,z=0,C=1,q=2\x1b\\\x1b8";
    const first = feed(ks, place);
    const repeats = feed(ks, place.repeat(30));
    expect(first.ops).toHaveLength(1);
    expect(repeats.ops).toEqual([]);
    expect(ks.stats().placeDeduped).toBe(30);
  });

  test("a moved placement is forwarded again", () => {
    const { ks } = stream();
    feed(ks, transmit("a=t,f=32,s=4,v=4,i=1,q=2", rgba(4, 4, 1)));
    feed(ks, "\x1b[6;2H\x1b_Ga=p,i=1,p=1,c=8,r=4,q=2\x1b\\");
    const moved = feed(ks, "\x1b[5;2H\x1b_Ga=p,i=1,p=1,c=8,r=4,q=2\x1b\\");
    expect(moved.ops).toEqual([
      { t: "place", id: 1, pid: 1, col: 2, row: 5, cols: 8, rows: 4, z: 0, crop: null, off: [0, 0] },
    ]);
  });

  test("re-placing after a delete is not swallowed", () => {
    const { ks } = stream();
    feed(ks, transmit("a=t,f=32,s=4,v=4,i=1,q=2", rgba(4, 4, 1)));
    const place = "\x1b[6;2H\x1b_Ga=p,i=1,p=1,c=8,r=4,q=2\x1b\\";
    feed(ks, place);
    feed(ks, "\x1b_Ga=d,d=a,q=2\x1b\\");
    expect(feed(ks, place).ops).toHaveLength(1);
  });
});

/* herdr brackets every frame in synchronized output, and a frame that replaces an image spans
 * dozens of PTY reads: the RGBA re-send is megabytes. An svg figure from omp 18.7+ is replaced
 * every 200 ms, and the page drew it blank for ~14 ms each time: the old image's `del` left
 * with the first read of the frame, the new image's `place` with the last one. */
describe("kitty-stream frames", () => {
  const del = (id) => `\x1b_Ga=d,d=I,i=${id},q=2\x1b\\`;

  test("a frame's ops leave together when it closes, however many reads it spans", () => {
    const { ks } = stream();
    feed(ks, transmit("a=t,f=32,s=8,v=8,i=1,q=2", rgba(8, 8, 1)) + "\x1b[3;1H\x1b_Ga=p,i=1,p=1,c=4,r=2,q=2\x1b\\");
    const frame =
      "\x1b[?2026h" + del(1) + transmit("a=t,f=32,s=8,v=8,i=2,q=2", rgba(8, 8, 2), 16) + "\x1b[3;1H\x1b_Ga=p,i=2,p=1,c=4,r=2,q=2\x1b\\" + "\x1b[?2026l";
    const bytes = Buffer.from(frame, "latin1");
    const reads = [];
    /* 7-byte reads cut both CSIs and every APC */
    for (let i = 0; i < bytes.length; i += 7) {
      const res = ks.push(bytes.subarray(i, i + 7));
      reads.push({ ops: res.ops.map((o) => o.t), payloads: res.payloads.length });
    }
    expect(reads.slice(0, -1).filter((r) => r.ops.length > 0)).toEqual([]);
    expect(reads.at(-1)).toEqual({ ops: ["del", "img", "ref", "place"], payloads: 1 });
  });

  test("ops before a frame and of a frame closed in the same read leave at once; the next, still open, waits", () => {
    const { ks } = stream();
    const first = ks.push(Buffer.from(del(5) + "\x1b[?2026h" + del(6) + "\x1b[?2026l" + "\x1b[?2026h" + del(7), "latin1"));
    expect(first.ops.map((o) => o.id)).toEqual([5, 6]);
    expect(ks.push(Buffer.from("\x1b[?2026l", "latin1")).ops.map((o) => o.id)).toEqual([7]);
  });
});

describe("kitty-stream snapshot for a page that takes over", () => {
  const modesOf = (ks) => Buffer.from(ks.snapshot().modes).toString("latin1");

  test("the last state of every mode herdr set comes back, split reads included", () => {
    const { ks } = stream();
    /* 3-byte chunks cut every CSI in two; 2026 brackets each frame and must not come back */
    feed(ks, "\x1b[?1000h\x1b[?1002h\x1b[?2026h\x1b[?1000l\x1b[>7u\x1b[>1u\x1b[<u\x1b[?1049h\x1b[?2026l", 3);
    expect(modesOf(ks)).toBe("\x1b[?1002h\x1b[?1000l\x1b[?1049h\x1b[>7u");
  });

  test("kitty keyboard: =flags;mode changes the top of the stack, ? is only a query", () => {
    const { ks } = stream();
    feed(ks, "\x1b[>1u\x1b[=4;2u\x1b[?u");
    expect(modesOf(ks)).toBe("\x1b[>5u");
    feed(ks, "\x1b[=1;3u");
    expect(modesOf(ks)).toBe("\x1b[>4u");
  });

  test("RIS forgets the modes", () => {
    const { ks } = stream();
    feed(ks, "\x1b[?1000h\x1b[>7u\x1bc");
    expect(modesOf(ks)).toBe("");
  });

  test("bound images and placements are handed over; pixels nothing shows are forgotten and ship again", () => {
    const a = rgba(4, 4, 1);
    const b = rgba(4, 4, 2);
    const { ks } = stream();
    const keyA = feed(ks, transmit("a=t,f=32,s=4,v=4,i=5,q=2", a)).ops.find((o) => o.t === "img").id;
    feed(ks, transmit("a=t,f=32,s=4,v=4,i=6,q=2", b));
    feed(ks, "\x1b_Ga=d,d=I,i=6,q=2\x1b\\"); /* herdr freed it; the server kept the pixels */
    const place = feed(ks, "\x1b[6;2H\x1b_Ga=p,i=5,p=1,c=8,r=4,q=2\x1b\\").ops[0];
    const { ops } = ks.snapshot();
    expect(ops).toEqual([
      { t: "reset" },
      { t: "img", id: keyA, fmt: "png", w: 4, h: 4, len: 0, hash: expect.stringMatching(/^[0-9a-f]{16}$/) },
      { t: "ref", id: 5, src: keyA },
      place,
    ]);
    /* the page never had B: its return trip carries the pixels, not a `ref` */
    expect(feed(ks, transmit("a=t,f=32,s=4,v=4,i=6,q=2", b)).payloads).toHaveLength(1);
  });

  test("a placement the page got in the snapshot is not sent again; a deleted one is not in it", () => {
    const { ks } = stream();
    feed(ks, transmit("a=t,f=32,s=4,v=4,i=1,q=2", rgba(4, 4, 1)));
    const place = "\x1b[6;2H\x1b_Ga=p,i=1,p=1,c=8,r=4,q=2\x1b\\";
    feed(ks, place);
    feed(ks, "\x1b[9;2H\x1b_Ga=p,i=1,p=2,c=8,r=4,q=2\x1b\\");
    feed(ks, "\x1b_Ga=d,d=i,i=1,p=2,q=2\x1b\\");
    expect(ks.snapshot().ops.filter((o) => o.t === "place").map((o) => o.pid)).toEqual([1]);
    expect(feed(ks, place).ops).toEqual([]);
  });
});

/*
 * What web/kitty-view.js draws on its canvas, frame by frame. The browser is faked down to what
 * the view touches: a canvas that records each frame's drawImage calls, animation frames the test
 * runs by hand, and fetch + createImageBitmap that land when the test says so. A test therefore
 * sees the frames a user would, decode gaps included.
 *
 * The regression behind it: an svg figure from omp 18.7+ is replaced by a new image every
 * 200 ms while it streams, and the canvas showed no figure at all from the moment the old image
 * went until the new one was decoded — a blink on almost every revision.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

const GLOBALS = ["window", "document", "requestAnimationFrame", "fetch", "createImageBitmap"];
const saved = new Map();

let callbacks = [];
/* url -> lands the decode of that url */
let decoding = new Map();
/* one entry per drawn frame: the urls of the bitmaps it drew, in order */
let drawn = [];

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeAll(async () => {
  for (const name of GLOBALS) saved.set(name, globalThis[name]);
  globalThis.window = { devicePixelRatio: 1 };
  globalThis.document = {
    createElement: () => ({
      style: {},
      setAttribute() {},
      getContext: () => ({
        setTransform() {},
        clearRect() {
          drawn.push([]);
        },
        drawImage(bitmap) {
          drawn.at(-1).push(bitmap.url);
        },
      }),
    }),
  };
  globalThis.requestAnimationFrame = (cb) => callbacks.push(cb);
  globalThis.fetch = async (url) => ({ ok: true, blob: async () => ({ url }) });
  globalThis.createImageBitmap = (blob) =>
    new Promise((resolve) => decoding.set(blob.url, () => resolve({ url: blob.url, width: 8, height: 32, close() {} })));
  await import("./kitty-view.js");
});

afterAll(() => {
  for (const [name, value] of saved) {
    if (value === undefined) delete globalThis[name];
    else globalThis[name] = value;
  }
});

function view() {
  callbacks = [];
  decoding = new Map();
  drawn = [];
  return globalThis.HerdrKittyView.createKittyView({
    mount: { clientWidth: 800, clientHeight: 640, appendChild() {} },
    getCell: () => ({ w: 8, h: 16 }),
    getGrid: () => ({ cols: 100, rows: 40 }),
  });
}

/** Runs the animation frame the view asked for; what it drew ([] is a blank canvas). */
function frame() {
  const pending = callbacks;
  callbacks = [];
  for (const cb of pending) cb();
  return drawn.at(-1);
}

/** The bitmap behind `url` is decoded now. */
async function land(url) {
  await tick();
  decoding.get(url)();
  await tick();
}

const img = (key, name) => ({ t: "img", id: key, fmt: "png", w: 8, h: 32, len: 0, hash: name, url: "/img/" + name });
const ref = (id, key) => ({ t: "ref", id, src: key });
const del = (id) => ({ t: "del", scope: "img", id });
/** herdr places a figure one row at a time, each row a slice of the image */
const rows = (id, top = 3) =>
  [0, 1].map((y) => ({ t: "place", id, pid: y + 1, col: 2, row: top + y, cols: 4, rows: 1, z: 0, crop: [0, y * 16, 8, 16], off: [0, 0] }));

async function shown(kv) {
  kv.applyOps([img(-1, "a"), ref(1, -1), ...rows(1)]);
  await land("/img/a");
  expect(frame()).toEqual(["/img/a", "/img/a"]);
}

describe("kitty-view: an image replaced in place", () => {
  test("the old pixels stay on the canvas until the new ones are decoded, revisions that never got drawn included", async () => {
    const kv = view();
    await shown(kv);

    /* one herdr frame: the old id goes, the new pixels and their rows come */
    kv.applyOps([del(1), img(-2, "b"), ref(2, -2), ...rows(2)]);
    expect(frame()).toEqual(["/img/a", "/img/a"]);

    /* the next revision comes before this one is decoded (a slow device) */
    kv.applyOps([del(2), img(-3, "c"), ref(3, -3), ...rows(3)]);
    await land("/img/b");
    expect(frame()).toEqual(["/img/a", "/img/a"]);

    await land("/img/c");
    expect(frame()).toEqual(["/img/c", "/img/c"]);
  });

  test("new pixels under the same id: the old ones stay until the new ones are decoded", async () => {
    const kv = view();
    await shown(kv);
    kv.applyOps([img(-2, "b"), ref(1, -2)]);
    expect(frame()).toEqual(["/img/a", "/img/a"]);
    await land("/img/b");
    expect(frame()).toEqual(["/img/b", "/img/b"]);
  });

  test("an image deleted with nothing in its place goes at once", async () => {
    const kv = view();
    await shown(kv);
    kv.applyOps([del(1)]);
    expect(frame()).toEqual([]);
  });

  test("a new image in other cells does not keep a deleted one on the canvas", async () => {
    const kv = view();
    await shown(kv);
    /* the transcript scrolled: the old screenshot left the screen, a new one comes in lower down */
    kv.applyOps([del(1), img(-2, "b"), ref(2, -2), ...rows(2, 20)]);
    expect(frame()).toEqual([]);
  });
});

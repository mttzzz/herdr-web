/*
 * Wire contract of the mirror: a page that announces `?v=3` gets tagged frames with the
 * kitty APC parsed out and fetches the pixels by URL; a tab still running an older bundle
 * (left open across a deploy, a stale PWA cache) keeps getting what it was built against —
 * pixels inside the frame for `?v=2`, the raw PTY stream for no version at all.
 *
 * The herdr client is replaced by a script that writes one image and some text, so the test
 * needs no herdr server and never touches the live session.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
/* Far from the mirror's default port (8793) and other common dev ports: a bind collision would
 * make /health answer from another server and attach a real client. */
const PORT = 18000 + Math.floor(Math.random() * 1000);
const dir = mkdtempSync(join(tmpdir(), "herdr-web-proto-"));
const IMG_ID = 4242;
const PIXELS = 4 * 4 * 4; /* 4x4 rgba */

let proc = null;

beforeAll(async () => {
  const b64 = Buffer.alloc(PIXELS, 0x40).toString("base64");
  const fake = join(dir, "fake-herdr.sh");
  writeFileSync(
    fake,
    `#!/bin/sh
trap 'printf "repaint-%s;" $$' WINCH
printf 'pid-%s;' $$
printf 'hello-from-pane'
printf '\\033[?1000h\\033[?2004h\\033[>7u'
printf '\\0337'
printf '\\033[5;3H'
printf '\\033_Ga=t,f=32,s=4,v=4,i=${IMG_ID},q=2;${b64}\\033\\\\'
printf '\\033_Ga=p,i=${IMG_ID},p=1,c=6,r=3,z=0,C=1,q=2\\033\\\\'
printf '\\0338'
printf 'tail-text'
while :; do
  sleep 0.1
  if [ -f "${dir}/say-$$" ]; then cat "${dir}/say-$$"; rm -f "${dir}/say-$$"; fi
done
`,
  );
  chmodSync(fake, 0o755);

  proc = Bun.spawn(["bun", join(ROOT, "server/server.ts")], {
    env: {
      ...process.env,
      HERDR_WEB_PORT: String(PORT),
      HERDR_WEB_HOST: "127.0.0.1",
      HERDR_WEB_AUTH: "off",
      HERDR_WEB_SESSION: "",
      HERDR_WEB_STATE_DIR: dir,
      HERDR_BIN_PATH: fake,
      HERDR_CONFIG_PATH: join(dir, "missing-config.toml"),
      /* short, so that "too late" fits in a test */
      HERDR_WEB_LINGER_MS: "1500",
      /* a page falls behind after a few KB, not after 64 */
      HERDR_WEB_FLOW_HIGH: "16384",
      HERDR_WEB_FLOW_LOW: "4096",
    },
    stdout: "pipe",
    stderr: "pipe",
  });

  const deadline = Date.now() + 15000;
  for (;;) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/health`);
      if (res.ok) break;
    } catch {}
    if (Date.now() > deadline) throw new Error("mirror did not start");
    await Bun.sleep(100);
  }
});

afterAll(() => {
  try {
    proc?.kill();
  } catch {}
  rmSync(dir, { recursive: true, force: true });
});

/** Collect binary messages until `ready(frames)` is happy or the timeout hits; `whileOpen`
 * runs before the socket closes. */
function collect(query, ready, whileOpen = async () => {}, timeoutMs = 8000) {
  const done = Promise.withResolvers();
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws?${query}`);
  ws.binaryType = "arraybuffer";
  const frames = [];
  const timer = setTimeout(() => {
    ws.close();
    done.reject(new Error(`timeout; got ${frames.length} frames`));
  }, timeoutMs);
  ws.onmessage = async (ev) => {
    if (typeof ev.data === "string") return;
    frames.push(new Uint8Array(ev.data));
    if (!ready(frames)) return;
    clearTimeout(timer);
    ws.onmessage = null;
    try {
      await whileOpen();
      done.resolve(frames);
    } catch (err) {
      done.reject(err);
    } finally {
      ws.close();
    }
  };
  ws.onerror = (err) => {
    clearTimeout(timer);
    done.reject(new Error(String(err)));
  };
  return done.promise;
}

const tagged = (fs) => fs.some((f) => f[0] === 0x01) && fs.some((f) => f[0] === 0x00);

function terminalText(frames) {
  return Buffer.concat(frames.filter((f) => f[0] === 0x00).map((f) => Buffer.from(f.subarray(1)))).toString(
    "latin1",
  );
}

function opsOf(frame) {
  const jsonLen = new DataView(frame.buffer, frame.byteOffset).getUint32(1, true);
  return { jsonLen, ops: JSON.parse(Buffer.from(frame.subarray(5, 5 + jsonLen)).toString("utf8")).ops };
}

/** Every op the page got, in order: herdr's writes reach the server in reads of any size, so
 * one image's transmit and placement may arrive in separate frames. */
const allOps = (frames) => frames.filter((f) => f[0] === 0x01).flatMap((f) => opsOf(f).ops);
const placed = (fs) => tagged(fs) && allOps(fs).some((o) => o.t === "place");

const health = async () => (await fetch(`http://127.0.0.1:${PORT}/health`)).json();

test("a v=3 page gets a URL instead of pixels, and the URL serves them as PNG", async () => {
  let during;
  const frames = await collect("cols=80&rows=24&v=3", placed, async () => {
    during = await health();
  });
  expect(during.clients).toBe(1);
  expect(during.legacyClients).toBe(0);

  const term = terminalText(frames);
  expect(term).toContain("hello-from-pane");
  expect(term).not.toContain("\x1b_G"); /* not one APC byte reaches xterm.js */

  /* nor one pixel byte the WebSocket */
  for (const f of frames.filter((f) => f[0] === 0x01)) expect(f.length).toBe(5 + opsOf(f).jsonLen);
  const ops = allOps(frames);
  const img = ops.find((o) => o.t === "img");
  expect(img).toMatchObject({ fmt: "png", w: 4, h: 4, len: 0, url: `/img/${img.hash}` });
  expect(ops.find((o) => o.t === "ref")).toEqual({ t: "ref", id: IMG_ID, src: img.id });
  expect(ops.find((o) => o.t === "place")).toMatchObject({ id: IMG_ID, pid: 1, col: 3, row: 5, cols: 6, rows: 3 });

  const res = await fetch(`http://127.0.0.1:${PORT}${img.url}`);
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toBe("image/png");
  expect(res.headers.get("cache-control")).toContain("immutable");
  const png = Buffer.from(await res.arrayBuffer());
  expect(png.toString("latin1", 1, 4)).toBe("PNG");
  expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([4, 4]);

  expect((await fetch(`http://127.0.0.1:${PORT}/img/0123456789abcdef`)).status).toBe(404);
});

test("a v=2 page gets the pixels as PNG inside the frame", async () => {
  let during;
  const frames = await collect("cols=80&rows=24&v=2", placed, async () => {
    during = await health();
  });
  expect(during.legacyClients).toBe(1); /* the tab runs a bundle from before v3 */

  const term = terminalText(frames);
  expect(term).toContain("hello-from-pane");
  expect(term).toContain("\x1b[5;3H"); /* positioning stays, the page needs it */
  expect(term).not.toContain("\x1b_G");

  const ops = allOps(frames);
  const opsFrame = frames.find((f) => f[0] === 0x01 && opsOf(f).ops.some((o) => o.t === "img"));
  const { jsonLen } = opsOf(opsFrame);
  const img = ops.find((o) => o.t === "img");
  const ref = ops.find((o) => o.t === "ref");
  const place = ops.find((o) => o.t === "place");
  expect(img).toMatchObject({ fmt: "png", w: 4, h: 4 });
  expect(img.url).toBeUndefined();
  expect(ref).toEqual({ t: "ref", id: IMG_ID, src: img.id });
  expect(place).toMatchObject({ id: IMG_ID, pid: 1, col: 3, row: 5, cols: 6, rows: 3 });
  /* the raw RGBA left as PNG, riding the same frame */
  const png = Buffer.from(opsFrame.subarray(5 + jsonLen));
  expect(png.length).toBe(img.len);
  expect(png.toString("latin1", 1, 4)).toBe("PNG");
  expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([4, 4]);
});

test("a page without a version keeps the raw PTY stream it was built against", async () => {
  const frames = await collect("cols=80&rows=24", (fs) =>
    Buffer.concat(fs.map((f) => Buffer.from(f)))
      .toString("latin1")
      .includes("\x1b_Ga=p"),
  );
  const raw = Buffer.concat(frames.map((f) => Buffer.from(f))).toString("latin1");
  expect(raw).toContain("hello-from-pane");
  expect(raw).toContain(`\x1b_Ga=t,f=32,s=4,v=4,i=${IMG_ID},q=2;`);
  expect(raw).toContain(`\x1b_Ga=p,i=${IMG_ID},p=1,c=6,r=3,z=0,C=1,q=2`);
  /* no frame tag was prepended: the stream starts with the pane's own first byte */
  expect(raw.startsWith("\x00")).toBe(false);
});

/** A socket that stays open: frames as they come, the hellos and snapshot notes (with the index
 * of the frame that follows each), and its close code. */
function openSocket(query) {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws?${query}`);
  ws.binaryType = "arraybuffer";
  const frames = [];
  const hellos = [];
  const snapshots = [];
  const closed = Promise.withResolvers();
  ws.onmessage = (ev) => {
    if (typeof ev.data !== "string") return frames.push(new Uint8Array(ev.data));
    const m = JSON.parse(ev.data);
    if (m.t === "hello") hellos.push(m);
    else if (m.t === "snapshot") snapshots.push({ ...m, at: frames.length });
  };
  ws.onclose = (ev) => closed.resolve(ev.code);
  return {
    frames,
    hellos,
    snapshots,
    closed: closed.promise,
    text: () => terminalText(frames),
    async until(pred, timeoutMs = 8000) {
      const end = Date.now() + timeoutMs;
      while (!pred()) {
        if (Date.now() > end) throw new Error(`timeout; text so far: ${JSON.stringify(terminalText(frames).slice(-200))}`);
        await Bun.sleep(10);
      }
    },
    send(obj) {
      ws.send(JSON.stringify(obj));
    },
    close() {
      ws.close();
      return closed.promise;
    },
  };
}

const pidOf = (text) => /pid-(\d+);/.exec(text)?.[1];
const pidsIn = (text) => new Set([...text.matchAll(/pid-(\d+);/g)].map((m) => m[1]));
const v3 = (tab) => `cols=80&rows=24&v=3&tab=${tab}`;
const termBytes = (frames) => frames.filter((f) => f[0] === 0x00).reduce((n, f) => n + f.length - 1, 0);
/** the snapshot's terminal frame, as text, and its image ops */
function snapshotOf(page, i = 0) {
  const { at } = page.snapshots[i];
  expect(page.frames[at][0]).toBe(0x00);
  return { screen: Buffer.from(page.frames[at].subarray(1)).toString("latin1"), ops: opsOf(page.frames[at + 1]).ops };
}

test("a tab that comes back gets its running herdr client: the screen, modes and images at once, then herdr's repaint", async () => {
  const tab = "a1".repeat(16);
  const first = openSocket(v3(tab));
  await first.until(() => first.text().includes("tail-text"));
  const pid = pidOf(first.text());
  expect(pid).toBeDefined();
  await first.close();
  await Bun.sleep(100);
  expect((await health()).parked).toBe(1);

  const back = openSocket(v3(tab));
  await back.until(() => back.text().includes(`repaint-${pid};`));
  expect(pidsIn(back.text())).toEqual(new Set([pid])); /* no new herdr client started */
  /* a reloaded page starts from nothing: a reset, the cells herdr drew, the modes it set */
  const { screen, ops } = snapshotOf(back);
  expect(screen.startsWith("\x1bc")).toBe(true);
  expect(screen).toContain("hello-from-panetail-text");
  for (const mode of ["\x1b[?1000h", "\x1b[?2004h", "\x1b[>7u"]) expect(screen).toContain(mode);
  expect(back.text().indexOf(screen)).toBeLessThan(back.text().indexOf("repaint-"));
  /* and the image herdr's id shows: by URL, where herdr placed it */
  expect(ops[0]).toEqual({ t: "reset" });
  const img = ops.find((o) => o.t === "img");
  expect(img).toMatchObject({ fmt: "png", url: `/img/${img.hash}` });
  expect(ops).toContainEqual({ t: "ref", id: IMG_ID, src: img.id });
  expect(ops).toContainEqual(expect.objectContaining({ t: "place", id: IMG_ID }));
  expect((await health()).parked).toBe(0);
  await back.close();
});

test("a tab that comes back too late gets a new herdr client", async () => {
  const tab = "b2".repeat(16);
  const first = openSocket(v3(tab));
  await first.until(() => first.text().includes("tail-text"));
  const pid = pidOf(first.text());
  await first.close();
  await Bun.sleep(2000); /* HERDR_WEB_LINGER_MS is 1.5 s here */
  const late = openSocket(v3(tab));
  await late.until(() => late.text().includes("tail-text"));
  expect(pidOf(late.text())).not.toBe(pid);
  await late.close();
});

test("a second page with the same tab id takes the seat; the first is told to pick another id", async () => {
  const tab = "c3".repeat(16);
  const one = openSocket(v3(tab));
  await one.until(() => one.text().includes("tail-text"));
  const pid = pidOf(one.text());
  const two = openSocket(v3(tab));
  expect(await one.closed).toBe(4000);
  await two.until(() => two.text().includes(`repaint-${pid};`));
  expect(pidsIn(two.text())).toEqual(new Set([pid]));
  await two.close();
});

test("a tab that lost only its socket gets the frames it missed, once, and no repaint", async () => {
  const tab = "d4".repeat(16);
  const first = openSocket(v3(tab));
  await first.until(() => first.text().includes("tail-text"));
  const pid = pidOf(first.text());
  const [hello] = first.hellos;
  expect(hello).toMatchObject({ resumed: false, seq: 0 });
  const seen = hello.seq + first.frames.length;
  await first.close();
  /* the pane writes while no page is attached */
  writeFileSync(join(dir, `say-${pid}`), "while-away;");
  await Bun.sleep(400);

  const back = openSocket(`${v3(tab)}&resume=${hello.gen}.${seen}`);
  await back.until(() => back.text().includes("while-away;"));
  await Bun.sleep(300); /* a repaint, had herdr been asked for one, lands by now */
  expect(back.hellos[0]).toMatchObject({ resumed: true, gen: hello.gen, seq: seen });
  expect(back.hellos[0].missed).toBe(back.frames.length);
  const text = back.text();
  expect(text.split("while-away;").length).toBe(2);
  expect(text).not.toContain("tail-text"); /* what the page had does not come again */
  expect(text).not.toContain("repaint-");
  await back.close();
});

test("a resume the seat cannot serve gets the whole screen", async () => {
  const tab = "e5".repeat(16);
  const first = openSocket(v3(tab));
  await first.until(() => first.text().includes("tail-text"));
  const pid = pidOf(first.text());
  await first.close();
  const back = openSocket(`${v3(tab)}&resume=${"0".repeat(16)}.1`);
  await back.until(() => back.text().includes(`repaint-${pid};`));
  expect(back.hellos[0]).toMatchObject({ resumed: false, missed: 0 });
  expect(snapshotOf(back).screen).toContain("hello-from-panetail-text");
  await back.close();
});

test("a page that falls behind skips to the screen as it is now, then gets the frames again", async () => {
  const tab = "f6".repeat(16);
  const page = openSocket(v3(tab));
  await page.until(() => page.text().includes("tail-text"));
  const pid = pidOf(page.text());
  page.send({ t: "ack", n: termBytes(page.frames) }); /* this page acks: flow control on */

  /* far more than the page may leave unparsed (16 KB here), then a line */
  writeFileSync(join(dir, `say-${pid}`), "x".repeat(1024 * 1024) + "\nafter-the-flood;");
  await Bun.sleep(1000);
  const parsed = termBytes(page.frames);
  /* frames stopped while the page had not acked them: it got a small part of the flood (one
   * PTY read may come as a single frame of 100+ KB, so where they stop is not exact) */
  expect(parsed).toBeLessThan(512 * 1024);
  expect(page.text()).not.toContain("after-the-flood;");

  page.send({ t: "ack", n: parsed }); /* caught up */
  await page.until(() => page.snapshots.length === 1 && page.frames.length > page.snapshots[0].at + 1);
  expect(snapshotOf(page).screen).toContain("after-the-flood;");
  expect(termBytes(page.frames)).toBeLessThan(parsed + 64 * 1024); /* the rest of the flood never came */

  /* the stream goes on from the snapshot */
  page.send({ t: "ack", n: termBytes(page.frames) });
  writeFileSync(join(dir, `say-${pid}`), "next-line;");
  await page.until(() => page.text().includes("next-line;"));
  await page.close();
});

/** Whether a WebSocket to the mirror opens with these request headers. */
function opens(headers) {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws?cols=80&rows=24&v=3`, { headers });
    ws.onopen = () => {
      ws.close();
      resolve(true);
    };
    ws.onerror = () => resolve(false);
  });
}

/* Auth is off here, as on a LAN that trusts itself. Then only the Origin check keeps a page of
 * another site, open in the user's own browser, from driving the terminal: browsers apply no
 * same-origin rule to a WebSocket or to a plain POST. */
test("a page of another site can neither open the terminal nor upload a file", async () => {
  const foreign = { Origin: "http://attacker.example" };
  expect(await opens(foreign)).toBe(false);
  const upload = await fetch(`http://127.0.0.1:${PORT}/paste?name=a.txt`, { method: "POST", headers: foreign, body: "x" });
  expect(upload.status).toBe(403);
});

test("the mirror's own page, same origin, gets in", async () => {
  expect(await opens({ Origin: `http://127.0.0.1:${PORT}` })).toBe(true);
});

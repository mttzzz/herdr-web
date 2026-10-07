# How it works

How herdr-web is put together, and the behaviour that is not obvious from using it. For installation, usage and configuration see the [README](../README.md).

- [The big picture](#the-big-picture)
- [One tab, one herdr client](#one-tab-one-herdr-client)
- [Layout and shared state](#layout-and-shared-state)
- [A tab keeps its client](#a-tab-keeps-its-client)
- [Snapshots: the screen, kept on the server](#snapshots-the-screen-kept-on-the-server)
- [Flow control: a slow page skips instead of falling behind](#flow-control-a-slow-page-skips-instead-of-falling-behind)
- [Keyboard layouts](#keyboard-layouts)
- [Clipboard and links](#clipboard-and-links)
- [Images](#images)
- [Rendering: the WebGL glyph-atlas workaround](#rendering-the-webgl-glyph-atlas-workaround)
- [Uploads](#uploads)
- [Authentication and cross-site requests](#authentication-and-cross-site-requests)
- [Wire protocol and versions](#wire-protocol-and-versions)
- [Defaults and limits](#defaults-and-limits)
- [Observability](#observability)
- [Source map](#source-map)

## The big picture

The mirror has three parts:

- **The page** (`web/`). xterm.js draws the terminal bytes the server sends, one canvas on top of it draws images, and everything the user does — keys, touch, paste, drops — goes back as bytes or small JSON messages.
- **The server** (`server/`, Bun). For every tab it starts a real `herdr` client in a PTY and pumps bytes both ways. Around that pump it does everything that makes a remote screen feel local: image handling, resume, snapshots, flow control.
- **herdr**, unmodified. The server never interprets herdr's interface. The client is just a terminal program: bytes in, bytes out.

```
+----------------------------------------------------------------+
| browser tab                                                    |
|   xterm.js (WebGL), image canvas, input bar, touch controls    |
+----------------------------------------------------------------+
      ^ |  WebSocket: terminal frames, image operations, keystrokes
      | v  HTTP: /img/<hash> pixels, /paste uploads
+----------------------------------------------------------------+
| herdr-web server (Bun), one "seat" per tab                     |
|   Kitty graphics parser, headless screen, frame buffer,        |
|   shared PNG store (worker thread)                             |
+----------------------------------------------------------------+
      ^ |  PTY
      | v
+----------------------------------------------------------------+
| herdr client: a real process, one per tab                      |
+----------------------------------------------------------------+
      ^ |
      | v
+----------------------------------------------------------------+
| herdr server: your session, shared by every client             |
+----------------------------------------------------------------+
```

Two things are taken out of the byte stream on its way to the page: Kitty graphics commands, which become image *operations*, and a copy of the plain terminal output, which is fed to a headless terminal so the server always knows what the screen looks like. Everything else — and every keystroke on the way back — passes through untouched.

There is no bundler and no build step. `bun install` fetches xterm.js and its addons, and the server serves their files, together with the page's own, from a fixed route table (no path traversal).

## One tab, one herdr client

The page opens `/ws?cols=…&rows=…&v=3&tab=…` (see [Wire protocol](#wire-protocol-and-versions)). For a new tab the server calls `Bun.spawn([herdr, "--session", name], { terminal })`, which gives the client a native PTY — the reason Bun 1.3.5 or newer is required. The client runs in a clean environment: every `HERDR_*` variable is removed (herdr refuses to start a client inside a herdr-launched process), `TERM=xterm-256color` and `COLORTERM=truecolor` are set, and the working directory is `$HOME`.

Per tab the server keeps one record, a *seat*: the client process, its size, the Kitty parser state, a buffer of recent frames and the headless screen. Ending a seat kills the client, which for herdr is a clean detach — the session and the other clients are untouched. If the client exits on its own, the page reconnects and gets a new one.

## Layout and shared state

- **Per-client layout.** The page reports its grid (columns × rows, from the fit addon) and, separately, its cell size in CSS pixels. The PTY gets the grid size, so herdr renders every client at its own size: a desktop tab and a phone tab side by side both show correctly reflowed chrome (sidebar, tabs, status bar), and opening a phone-sized tab does not reflow or garble the desktop one. When the window or the visual viewport changes — the iOS keyboard opening, for instance — the page re-fits (debounced) and sends the new size; the kernel signals the client and herdr redraws. (Observed with herdr 0.7.5.)
- **Shared session state.** Which workspace and tab are active, and overlays such as the `prefix ?` help, are session state in herdr, not per-client state: an overlay opened in one tab shows up in every client, and input from any tab lands in the same panes.
- **Cell size matters for images.** herdr asks its outer terminal for the cell size (XTWINOPS 16t, and 14t for the pixel size of the screen) and places images in cells. The server answers those queries with the numbers the page reported; without them herdr's crop arithmetic is off by pixels.

## A tab keeps its client

A new herdr attach costs 15–350 ms of waiting on the herdr server, so a tab does not give its client up when its socket closes.

- **Tab identity.** The page keeps a random id in `sessionStorage`, which belongs to the tab and survives reloads, and sends it as `?tab=`. (It is generated with `crypto.getRandomValues`: `crypto.randomUUID` exists only in secure contexts, and the mirror is usually plain HTTP on a LAN.) A duplicated browser tab copies `sessionStorage`, and so the id: the newcomer takes the seat, the older page is closed with code 4000 and picks a new id.
- **Grace period.** When the socket closes, a seat that knows its tab waits `HERDR_WEB_LINGER_MS` (15 s by default). During that time it keeps reading herdr's output, so its frame buffer and screen stay current. If the tab comes back, it gets the running client; otherwise the client is killed. At most `HERDR_WEB_MAX_CLIENTS` seats wait at once, the oldest ending first. Only pages on the current protocol version ([below](#wire-protocol-and-versions)) get this.
- **Resume.** The seat's output is split into numbered frames and the newest 4 MB are kept. The page counts the frames it has handled; after a dropped socket it reconnects with `?resume=<generation>.<count>`, and if every frame after that count is still kept, the server replays exactly those. The page keeps its screen and its images, and herdr is not asked to repaint — the tab is back in a couple of milliseconds.
- **Reload.** A reload has no frame count to resume from, and a resume whose frames have already been trimmed from the buffer cannot be replayed: both get a [snapshot](#snapshots-the-screen-kept-on-the-server) instead.

The page reconnects on its own: the first retry is immediate, the following ones wait 0.5, 1, 2, 4 and then 8 seconds, and only a retry that has to wait shows the "reconnecting" overlay. The backoff resets once herdr has sent a frame, so a server that accepts the socket and drops it cannot spin the loop.

## Snapshots: the screen, kept on the server

For every seat that can be resumed, the server feeds the plain terminal stream (Kitty commands already cut out) to `@xterm/headless` — the same engine and options as the page: no scrollback, Unicode 11 widths. At any moment it can produce the bytes that make a fresh terminal show the current screen:

- a reset, the serialized cells and an absolute cursor position;
- the terminal modes herdr switched on — mouse reporting, bracketed paste, the alternate screen, the Kitty keyboard flags. herdr sends them once, when its client starts, and a repaint does not repeat them, so the Kitty parser tracks them separately;
- then the image state: `reset`, an `img` for every image still shown (with its `/img/<hash>` URL), a `ref` for every herdr image id and every placement on screen.

A snapshot is exact only **at rest**: when no escape sequence or UTF-8 character is cut in half by a PTY read, and herdr is between frames. A sequence split across reads lives only in the parser, so a snapshot taken in the middle would lose it, and the bytes that finish it would land on the screen as text, leaving a few wrong cells. The server therefore retries after every PTY read until the stream is at rest.

After a snapshot for a reloaded tab the server also nudges the client (SIGWINCH, or a real resize if the size changed), because herdr's own repaint has the last word on the screen. The reloaded page has its screen at once, instead of after the 5–90 ms herdr takes to repaint. Keeping the headless screen costs about 2 % of a core at herdr's output rates; a snapshot is around 1 ms and 16–60 KB.

## Flow control: a slow page skips instead of falling behind

A page that parses slower than herdr writes — a phone under a log flood — used to fall seconds behind, with every keystroke's echo queued after megabytes of frames. Now:

1. The page acknowledges what its terminal has **parsed** (xterm.js's write callback, not what arrived): `{"t":"ack","n":<total bytes>}`, at most one per task. The first ack, `0`, sent when the socket opens, switches flow control on for that page.
2. The server counts the terminal bytes it has sent on the socket. Once more than 64 KB are unparsed, it stops sending frames to that page. They are still numbered, kept and fed to the headless screen.
3. When the page has caught up to 16 KB, it gets a snapshot at the next quiet moment, followed by the kept frames from that point on. What it skipped is drawn over by the snapshot anyway.

Pausing the herdr client (SIGSTOP) instead does not work: herdr's server leaves about 200 KB of stale frames in the client's socket, and those come out ahead of every echo after each pause.

Related delivery choices:

- Terminal output leaves at the end of every PTY read, with no batching timer: a timer would add its delay to every keystroke echo and scroll step, and doing without it costs neither CPU nor long tasks under a heavy flood. The pieces of one read (Kitty commands are cut out between them) are joined into a single frame of up to 64 KB.
- Terminal frames go out uncompressed; operation frames and snapshots use WebSocket per-message deflate.
- The WebSocket's backpressure limit is 32 MiB, matching herdr's own per-transaction limit, and the socket is closed when it is hit; a message Bun reports as dropped closes it too. Either way the page reconnects and gets a fresh screen, because a lost terminal frame would silently desynchronize the grid.

## Keyboard layouts

herdr resolves its keybindings from the character a key produced. With a non-Latin layout active, `prefix s` arrives as the non-Latin letter that sits on the S key, and nothing fires. herdr's own workaround, `experimental.switch_ascii_input_source_in_prefix`, switches the input source of the machine the herdr client runs on (macOS and Windows only) — for a browser tab that is the server, not the device you type on. herdr also asks its outer terminal for Kitty "alternate keys" (`CSI > 7 u`) but ignores the base-layout field of the reply (observed on herdr 0.8.0).

So the page resolves the position itself. `KeyboardEvent.code` says which character a physical key carries on a US layout, and for **commands** that is what herdr gets:

- chords (`Ctrl+…`, `Alt+…`, `Cmd+…`) are handed to xterm.js as the US key, so its own encoder produces the control byte or the ESC-prefixed sequence;
- the one key that follows the prefix is sent as the US character — the prefix followed by the non-Latin letter on the S key becomes `prefix s`;
- typed text is never touched: with a non-Latin layout you still type that script, byte for byte.

To know which key follows the prefix, the page tracks prefix mode. The server reads `[keys].prefix` from herdr's `config.toml` when it starts and sends it in its first message; a matching chord enters prefix mode and the next real key leaves it (herdr's prefix mode has no timeout); a second prefix chord sends the literal chord to the pane, as herdr does. The toolbar's `C-b` button counts as the prefix too. Restart the server after changing `[keys].prefix`.

`Ctrl+V` and `Cmd+V` are the exception: they are left to the browser as a native paste event, which is how clipboard text, images and files from the device arrive.

## Clipboard and links

- **Copy-on-select.** herdr copies its selections by emitting OSC 52 (`ESC ] 52 ; c ; <base64>`) to every client. xterm.js's clipboard addon receives it and the page writes it with `navigator.clipboard`. Plain-HTTP LAN origins are not secure contexts, so there that API does not exist; the page then falls back to a hidden textarea and `execCommand("copy")`, which browsers still allow during a user gesture — and the copy always lands right after a selection's mouse-up. The clipboard is the one of the device you are browsing from, not the herdr machine's. herdr does not forward OSC 52 written by programs inside panes, so only herdr's own selections arrive.
- **Links.** Because the herdr machine's clipboard is out of reach, URLs printed in panes are clickable (the web-links addon) and open in a new tab.

## Images

herdr draws pane images by writing the Kitty graphics protocol to its outer terminal — here, the PTY the server owns. xterm.js has no Kitty graphics support, and handing it that stream would not be practical anyway:

- herdr re-encodes every pane image for every attached client as classic Kitty APC, and does so as **raw RGBA** (`a=t,t=d,f=32,…`). A 1568×882 screenshot is 5.5 MB of pixels, 7.4 MB once base64-encoded — per client and per reconnect.
- When an image leaves the screen herdr frees it (`a=d,d=I`) and sends all the pixels again when it returns.
- herdr re-places every visible image on every render pass: about 600 `a=p` commands per second for a streaming pane. With Unicode placeholders, as omp uses them, that is one placement per image row, re-created with fresh placement ids whenever the feed moves.
- Feeding all of it to xterm.js would make every APC byte be decoded twice, and xterm.js's UTF-8 decoder allocates four bytes per input byte.

So the server turns the stream into **operations**, and the page only ever consumes operations.

### What the server does

`server/kitty-stream.ts` is a byte-level state machine that walks every PTY read. It tracks the cursor (placements are in cells), cuts graphics APCs out and reassembles chunked transfers; everything else goes on to the terminal byte for byte. It understands the subset herdr emits: transmit, put, delete and query (`a=t/T/p/d/q`), direct and file transport (`t=d/f/t`), RGB, RGBA and PNG pixels (`f=24/32/100`), chunking (`m=`), placement size and z-order (`c/r/z`), source crop (`x/y/w/h`) and pixel offset (`X/Y`).

Pixels are hashed with xxHash64 (16 hex digits). On Bun a 4 MB payload costs roughly 0.3 ms to base64-decode and 0.3 ms to hash; the same work in the page would cost milliseconds per frame on its main thread. The page then receives five kinds of operation:

| Operation | Meaning |
|---|---|
| `img` | New pixels, stored on the page under a *page key*. Page keys are always negative and never reused, so they cannot collide with a herdr image id (herdr does reuse ids for new pixels). |
| `ref` | herdr image `id` now shows the pixels held under page key `src` — no bytes. |
| `place` | Draw image `id` at a cell, `cols` × `rows` cells large, with z-order and an optional source crop and pixel offset. |
| `del` | Drop one placement, all placements, or a herdr image id; with a page key it drops those pixels. |
| `reset` | Forget everything. |

Three rules keep the traffic small:

- **Pixels outlive the herdr id that showed them.** Freeing an image (`d=I`) only unbinds its id. When herdr re-sends the same pixels, the server recognizes the hash and answers with a `ref` of a few dozen bytes instead of megabytes.
- **The hash is the identity.** The same pixels get the same name whichever client, connection or image id they arrive under, and re-sending the pixels an id already shows costs nothing.
- **Repeated placements never leave the server.** A `place` whose geometry is identical to the one on record is dropped.

The server decides what the page holds: up to 96 MB of decoded pixels (width × height × 4 bytes). Beyond that, pixels no image shows are dropped, longest unseen first. Pixels that are on screen are never dropped — herdr would not send them again — so a screen full of images can overshoot. The page has its own 192 MB backstop for a server that does not manage this; when it evicts something itself it reports a `miss`, and the server forgets those pixels so the next transmit ships the bytes again.

File transport (`t=f` and `t=t`, where the payload is a path on the herdr machine) is honoured only for files under `$HOME`, where herdr keeps its own scratch files, so the mirror cannot be turned into an arbitrary file reader.

### Pixels travel over HTTP, not the WebSocket

An `img` operation carries a URL named after the content hash: `/img/<hash>`. `server/image-store.ts` encodes each hash once, for every client, as a PNG on a worker thread (`server/png-worker.ts` and `server/png.ts`: the "Up" filter plus deflate, typically 4–9× smaller than RGBA). The page fetches the PNG and decodes it off its main thread with `createImageBitmap`.

Sending the pixels inline in the WebSocket used to cost twice: the PNG encode (about 50 ms for 1568×882) ran on the server's event loop, during which no terminal byte reached any tab, and a multi-megabyte message cost the page's main thread another 70–90 ms just to take in — a hitch of well over 100 ms on the grid. On a slow link the terminal text also queued behind the image bytes on the same connection.

The URL names the content, so what it returns never changes: it is served `Cache-Control: private, max-age=31536000, immutable`, and a reloaded tab takes its images from the browser cache. A page that asks while the worker is still encoding simply waits. The store keeps up to 128 MB of PNGs, least recently used first out; it only has to outlast the round trip between an operation and the fetch it triggers, and the rest saves re-encoding on reconnects.

### One herdr frame is one batch of operations

herdr brackets every frame in synchronized output (`CSI ? 2026 h … l`). A frame that replaces an image spans dozens of PTY reads, because the RGBA re-send is megabytes. The operations used to be sent as they were parsed: the old image's `del` reached the page about 14 ms before the new image's `place`, and for those 14 ms no image was drawn. An SVG figure that omp re-renders every 200 ms while it streams (a new image id each time) blinked on every revision.

Now the server holds a frame's operations until the frame closes and sends them as one batch. Terminal bytes are not held: xterm.js 6 implements synchronized output itself and paints nothing until the frame ends. The same rule keeps snapshots honest — none is taken in the middle of a frame, when the images parsed so far are already in the parser's state while their operations are still waiting.

The page adds a second guard. A placement that a batch removed or rebound stays on the canvas, under everything else, for as long as an image is still decoding in the same cells, and is dropped the frame its replacement can be drawn. A replaced figure is never replaced by a gap.

### On the page

`web/kitty-view.js` puts one `<canvas>` over xterm's screen element, sized to it and scaled by the device pixel ratio. It keeps one `ImageBitmap` per set of pixels, binds herdr image ids to them as `ref` operations arrive, and repaints once per animation frame with one `drawImage` per placement (crop, offset and cell scaling included). A repaint therefore costs the same whether the image is 0.1 or 9 MB, and xterm.js never sees an image byte.

Only the Kitty protocol is handled, because it is what herdr emits; SIXEL and iTerm2 images are not supported.

## Rendering: the WebGL glyph-atlas workaround

The page uses xterm.js's WebGL renderer when the browser can create a context, and drops back to xterm.js's default renderer when it cannot or when the context is lost (iPad Safari likes to drop GL contexts).

`@xterm/addon-webgl` 0.19.0 has a bug in its glyph atlas. From the second time it merges atlas pages, the merged page lands in a texture slot whose recorded version already matches, so it is never uploaded and its glyphs sample the previous page. After a lot of colourful output, letters come out as fragments of other letters, until the page is reloaded. The fix exists upstream only in xterm.js's beta line ([PR 5883](https://github.com/xtermjs/xterm.js/pull/5883)).

The page works around it: a merge removes pages, and on the next frame the page re-sets the terminal's theme, which makes the renderer upload every page again.

## Uploads

Pasting into a terminal canvas is unreliable across browsers, so the page has a real text box, and files travel over plain HTTP:

1. The page `POST`s the file's bytes (not multipart) to `/paste?name=<file name>`, with the file's own content type. The server rejects empty bodies and anything over 25 MB, writes the bytes into `pastes/` in the plugin state directory, keeps only the newest 40 files and answers with the absolute path.
2. Clipboard images, whose file name is a generic `image.png`, get an extension from their MIME type (`paste-<time>-<n>.png`); anything with a real name keeps its sanitized name — Unicode letters and the extension preserved — so an agent sees `report.pdf`, not `blob.bin`.
3. The page pastes each path into the focused pane as its own bracketed paste and puts focus back in the terminal.

One path per paste, because coding agents such as omp attach a pasted file only when the paste is exactly one absolute path: a leading `@` or surrounding words turn it into plain text. The text box follows the same rule — if everything in it is an absolute path, the paths are pasted one by one.

Nothing here needs clipboard tooling on the server, so it behaves the same on Linux, macOS and WSL hosts. The files land on the machine where herdr runs, which is where the agent can read them.

## Authentication and cross-site requests

- **Token.** On first start the server generates a random token (a UUID without dashes) and writes it to the token file with mode `600`. Candidates are compared in constant time, through SHA-256 digests. `HERDR_WEB_AUTH=off` skips all of this.
- **Query first, cookie after.** A request with `?token=…` is checked against the token, and the first page load is answered with a `herdr_web_token` cookie (HttpOnly, SameSite=Strict, one year). The page then removes the token from the address bar; its WebSocket and upload requests carry the token it was opened with, and after a reload the cookie takes over.
- **What needs it.** The page and its scripts, fonts and icons, `/ws`, `/paste` and `/img/<hash>`. `/health` does not: it is the liveness probe the control script uses, and it returns counters only. An unknown path answers 403 without a token and 404 with one.
- **Cross-site requests.** Browsers do not apply the same-origin policy to WebSocket connections, and let a page send simple POSTs to other sites, so a page on some other site could try to reach the mirror from your own browser. `/ws` and `/paste` therefore answer 403 to any request whose `Origin` names a different host than the request's `Host` (an unparsable `Origin`, such as `null`, counts as different). The mirror's own page is same-origin, and native clients send no `Origin`. Together with the token that makes two independent barriers; with `HERDR_WEB_AUTH=off` it is the only one besides network reachability. A reverse proxy in front of the mirror has to pass the original `Host` header through.

## Wire protocol and versions

| Direction | Kind | Content |
|---|---|---|
| page → server | binary | Raw input bytes, written to the PTY. |
| page → server | text (JSON) | `resize` (`cols`, `rows`); `metrics` (cell size, grid, device pixel ratio); `ack` (`n`, bytes parsed); `miss` (`id` of pixels the page does not have). |
| server → page | binary, tag `0x00` | Terminal bytes for xterm.js, Kitty commands already cut out. |
| server → page | binary, tag `0x01` | A little-endian `u32` length, then `{"ops":[…]}`. |
| server → page | text (JSON) | `hello` (`prefix`, `gen`, `seq`, `resumed`, `missed`), first on every socket; `snapshot` (`seq`, `frames`), announcing the two frames that make up a snapshot; `exit` (`code`). |
| HTTP | `GET /ws` | WebSocket upgrade. Query: `cols`, `rows`, `v`, `tab`, `resume`, and `token` when the page was opened with one. |
| HTTP | `GET /img/<hash>` | The PNG an `img` operation names. |
| HTTP | `POST /paste?name=…` | An upload; answers `{"ok":true,"path":"…"}`. |
| HTTP | `GET /health` | Counters; the only route that needs no token. |

The page announces its protocol with `v=` on the WebSocket URL. A tab that is still running an older bundle — left open across an update, or served from a stale cache — keeps what it was built for:

| `v` | Page | What the server sends |
|---|---|---|
| 3 | current | Tagged frames; pixels fetched from `/img/<hash>`; resume, snapshots and flow control. |
| 2 | loaded before v3 | Tagged frames with the PNG inside the operations frame. No resume, snapshots or flow control. |
| none | older still | The raw PTY stream, Kitty commands included. Framed bytes would land in that page's terminal as escape-sequence soup: 4.5 MB of RGBA pixels contain about 17 000 `ESC` bytes. |

Reloading the tab upgrades it. `/health` counts pages on an older protocol as `legacyClients`, and the server log marks them `legacy v2` (or `legacy v1`) when they attach.

## Defaults and limits

| What | Value | Notes |
|---|---|---|
| Simultaneous tabs | 6 | `HERDR_WEB_MAX_CLIENTS`; extra connections get HTTP 429. |
| Grace period after a socket closes | 15 s | `HERDR_WEB_LINGER_MS`; `0` ends the client at once. |
| Frames kept per tab for resume | 4 MB | `HERDR_WEB_RESUME_BYTES` (not in `.env.example`). |
| Flow control: stop / resume | 64 KB / 16 KB unparsed | `HERDR_WEB_FLOW_HIGH` and `HERDR_WEB_FLOW_LOW` (not in `.env.example`). |
| Terminal frame size | up to 64 KB | The pieces of one PTY read are joined up to this size; a single bigger read is framed on its own. |
| Grid size accepted | 20–500 columns, 10–200 rows | |
| Pixels the page holds | 96 MB, page-side backstop 192 MB | Decoded size, width × height × 4. |
| PNG store | 128 MB | |
| Upload | 25 MB per file, newest 40 kept | |
| WebSocket backpressure | 32 MiB | Past it the server closes the socket. |
| Inbound message | 1 MiB | Keystrokes and control frames only. |
| Reconnect backoff | 0, 0.5, 1, 2, 4, 8 s | |

## Observability

`GET /health` needs no token and returns only counters: `clients`, `parked` (lingering seats), `legacyClients`, `snapshots`, `sendDropped`, `sendBackpressure`, `sent.{termBytes,opsBytes}`, `images.{cached,uniqueBytes,dupeBytesSaved,payloadBytes,payloadBytesTotal}`, `placements.{sent,deduped}` and `encoded.{entries,bytes,pending,encoded,failed,evicted}` (the shared PNG store). It is the cheapest way to tell a steady text stream from a re-transmitted image: watch `sent.termBytes` against `sent.opsBytes`.

`server.log` has one line per attach, detach and tab return, for example:

```
[ws] client attached (2 active, 120x40)
[ws] client detached (1 active); herdr client kept 15s for its tab
[ws] tab back (2 active, 120x40): its herdr client taken over, stream resumed
```

## Source map

| Path | What is in it |
|---|---|
| `server/server.ts` | HTTP and WebSocket server; seats (the herdr clients); auth; resume; flow control; uploads; `/health`. |
| `server/kitty-stream.ts` | Kitty graphics parser: APC → operations, pixel hashing and deduplication, the page's memory budget, terminal-mode tracking. |
| `server/image-store.ts` | The shared PNG store behind `/img/<hash>`, and the worker-thread encoder. |
| `server/png.ts`, `server/png-worker.ts` | The PNG encoder and its worker entry point. |
| `server/screen.ts` | The headless terminal that keeps each tab's screen, and its snapshots. |
| `web/index.html` | Markup and styles: terminal, toolbar, input bar, reconnect overlay. |
| `web/app.js` | The page: terminal setup, reconnect and resume, flow-control acks, touch gestures, keyboard handling, input bar, toolbar. |
| `web/kitty-view.js` | The image canvas. |
| `web/fonts/`, `web/icons/` | The bundled font (with its OFL license), the favicon and the home-screen icon. |
| `scripts/web-ctl.sh` | The entry point behind every plugin action. |
| `herdr-plugin.toml` | The plugin manifest. |
| `server/*.test.js`, `web/*.test.js` | Tests: wire contract, Kitty parser, PNG encoder and store, image canvas. |

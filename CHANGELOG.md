# Changelog

All notable changes to this project are documented in this file. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## 1.0.0 — 2026-10-07

First public release.

### Added

- **Browser mirror of the herdr TUI.** Every browser tab runs a real `herdr` client in a PTY on the server (Bun 1.3.5 or newer) and shows it in xterm.js with the WebGL renderer and a bundled JetBrains Mono Nerd Font. Each tab has its own size and shares the session state; up to six tabs by default (`HERDR_WEB_MAX_CLIENTS`).
- **Phone and tablet support.** Touch drag scrolls the pane under the finger, a long press is a right-click, and a bottom toolbar offers `Esc`, `Tab`, `C-b`, `Enter`, the arrow keys and `A−` / `A+` font size. Optional LAN mode with `HERDR_WEB_HOST=0.0.0.0`; Apple touch icon for *Add to Home Screen*.
- **Images.** Kitty graphics from panes are parsed on the server and drawn on a canvas over the terminal grid. Pixels are hashed and deduplicated, an image that returns to the screen costs a small reference instead of a re-send, each image is PNG-encoded once on a worker thread and fetched by content hash over HTTP (immutable, browser-cached), and every herdr frame's image operations are delivered as one batch so streaming figures do not blink. Needs herdr 0.9.2 or newer.
- **Input bar.** Paste text, screenshots and files, pick files with the attach button, or drag and drop them anywhere. Files are uploaded to the herdr machine (25 MB each, newest 40 kept) and pasted into the focused pane as absolute paths, one per paste, so agents such as omp attach them.
- **Copy-on-select** reaches the clipboard of the device you browse from (OSC 52, with a fallback for plain-HTTP origins); links printed in panes are clickable.
- **Layout-independent keybindings.** Chords and the key after herdr's prefix are sent by physical key position, so shortcuts work with non-Latin keyboard layouts; typed text is untouched.
- **Reconnect without losing the screen.** A tab keeps its herdr client for a grace period (`HERDR_WEB_LINGER_MS`, 15 s by default). A tab that lost only its socket gets the frames it missed; a reloaded tab gets a snapshot of the screen and its images from a headless terminal kept on the server.
- **Flow control.** A page that parses slower than herdr writes skips frames and receives a snapshot instead of falling behind.
- **Authentication.** A random token (mode `600`) travels in the URL once, then in an HttpOnly cookie. The server listens on loopback by default; `HERDR_WEB_AUTH=off` disables authentication for networks you fully control.
- **herdr plugin integration.** Actions `open`, `start`, `stop` and `status`, a startup hook that starts the server with herdr, and `scripts/web-ctl.sh` as the single entry point for plugin actions and for the shell. Configuration through `.env` in the plugin config directory. Requires herdr 0.7.5 or newer on Linux or macOS.
- A workaround for a glyph-atlas bug in `@xterm/addon-webgl` 0.19.0 that drew wrong letters after heavy colourful output.
- Tests for the wire contract, the Kitty parser, the PNG encoder and store, and the image canvas (`bun run test`), with CI on Linux and macOS.

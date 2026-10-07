/*
 * The screen herdr has drawn for one seat, kept on the server in a headless xterm: the same
 * engine and options as the page's (web/app.js), so it holds what a page that parsed every
 * byte would show. A snapshot of it lets a page skip bytes it never parsed and go on from the
 * screen as it is now:
 *   - a reload taking over a running herdr client has the screen at once, instead of after
 *     the 5-90 ms herdr takes to repaint on SIGWINCH;
 *   - a page that fell behind (a phone under a log flood) drops what it could not parse.
 *
 * A snapshot is exact only at rest. A sequence or a UTF-8 character cut by a PTY read lives on
 * in the parser alone: the snapshot loses it, and the bytes that finish it land as text. On a
 * recorded herdr stream, a snapshot taken at rest plus the stream after it stayed identical to
 * the full stream for 1.5-4.3 MB; taken inside a sequence, 5-9 cells went wrong.
 * Parsing costs ~2 % of a core at herdr's 1.5 MB/s under a 3 MB/s log flood (75-85 MB/s), a
 * snapshot ~1 ms and 16-60 KB.
 */
import { SerializeAddon } from "@xterm/addon-serialize";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { Terminal } from "@xterm/headless";

export interface Screen {
  /** terminal bytes as the page gets them (the kitty APC cut out), in order */
  write(bytes: Uint8Array): void;
  /** the bytes written so far end between sequences and characters (see the header) */
  readonly atRest: boolean;
  resize(cols: number, rows: number): void;
  /** bytes that make any terminal show this screen, whatever it showed before: a reset, the
   * cells, the cursor. Covers everything written before the call. */
  snapshot(): Promise<Uint8Array>;
  dispose(): void;
}

const GROUND = 0;
const ESC = 1;
const CSI = 2;
/* OSC, DCS, SOS, PM, APC: a string up to ST (ESC \), or BEL for OSC */
const STR = 3;
const STR_ESC = 4;

const ENC = new TextEncoder();

export function createScreen(cols: number, rows: number): Screen {
  const term = new Terminal({ cols, rows, scrollback: 0, allowProposedApi: true });
  term.loadAddon(new Unicode11Addon());
  term.unicode.activeVersion = "11";
  const serializer = new SerializeAddon();
  term.loadAddon(serializer);

  let state = GROUND;
  /* continuation bytes the current UTF-8 character still needs */
  let utf8Left = 0;

  function scan(bytes: Uint8Array): void {
    for (let i = 0; i < bytes.length; i++) {
      const b = bytes[i];
      switch (state) {
        case GROUND:
          if (b === 0x1b) {
            state = ESC;
            utf8Left = 0;
          } else if (utf8Left > 0 && (b & 0xc0) === 0x80) utf8Left--;
          else if (b >= 0xc0) utf8Left = b >= 0xf0 ? 3 : b >= 0xe0 ? 2 : 1;
          else utf8Left = 0;
          break;
        case ESC:
          if (b === 0x5b /* [ */) state = CSI;
          else if (b === 0x5d /* ] */ || b === 0x50 /* P */ || b === 0x58 /* X */ || b === 0x5e /* ^ */ || b === 0x5f /* _ */) state = STR;
          else if (b < 0x20 || b > 0x2f) state = GROUND; /* past the intermediates: the final byte */
          break;
        case CSI:
          if (b >= 0x40 && b <= 0x7e) state = GROUND;
          break;
        case STR:
          if (b === 0x07) state = GROUND;
          else if (b === 0x1b) state = STR_ESC;
          break;
        case STR_ESC:
          state = b === 0x5c /* \ */ ? GROUND : STR;
          break;
      }
    }
  }

  return {
    write(bytes) {
      scan(bytes);
      term.write(bytes);
    },
    get atRest() {
      return state === GROUND && utf8Left === 0;
    },
    resize(c, r) {
      if (c !== term.cols || r !== term.rows) term.resize(c, r);
    },
    snapshot() {
      return new Promise((resolve) =>
        term.write("", () => {
          const b = term.buffer.active;
          /* the serializer's own cursor move lands a column off after some wide characters:
           * an absolute position settles it */
          resolve(ENC.encode(`\x1bc${serializer.serialize()}\x1b[${b.cursorY + 1};${b.cursorX + 1}H`));
        }),
      );
    },
    dispose() {
      term.dispose();
    },
  };
}

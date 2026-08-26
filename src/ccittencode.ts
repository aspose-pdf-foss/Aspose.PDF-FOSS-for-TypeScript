/**
 * CCITT Group 4 (ITU-T T.6) **encoder**, the counterpart to `ccitt.ts`'s
 * decoder. Pure: packed bits in, coded bytes out.
 *
 * G4 is what makes a bilevel scan small. A fax page stored as Deflate over
 * 8-bit gray is several times the size a fax toolchain produces, which is the
 * gap this closes.
 *
 * **Invariant:** the code TABLES are not transcribed here. `ccitt-tables.ts`
 * already owns T.4's run-length codes and T.6's mode codes for the decoder, and
 * this imports them — a second transcription is how the two halves come to
 * disagree about one code, which no round trip through our own pair would ever
 * reveal. The parity rule for finding `b1` is shared for the same reason:
 * `findB1Index` is exported from `ccitt.ts` rather than reimplemented, since
 * "which changing element is opposite in colour to a0" is one question.
 *
 * **Invariant:** input is packed 1-bpp MSB-first with **1 = black**, which is
 * exactly what `decodeCcitt` returns under `blackIs1: false`. Defining the
 * contract by round trip rather than by prose is deliberate: the polarity of
 * these formats is the single thing everyone gets backwards, and a mirrored
 * image decodes perfectly while showing the negative.
 *
 * **Note on the oracle, and it is stronger here than for our other writers:**
 * `decodeCcitt`'s G4 path is anchored by `test/fixtures/tiff/libtiff-g4-*.tif`,
 * real files written by libtiff with ground truth from a third decoder. A round
 * trip is therefore checked against a reader that agrees with libtiff, not
 * merely against ourselves — unlike `gifencode.ts`, whose reader we also wrote.
 */

import { WHITE_CODES, BLACK_CODES, EXT_MAKEUP, MODE_CODES } from './ccitt-tables.js';
import { findB1Index } from './ccitt.js';

/** run length -> bit string, per colour. Terminating and makeup together. */
function runMap(codes: { bits: string; run: number }[]): Map<number, string> {
  const m = new Map<number, string>();
  for (const c of codes) m.set(c.run, c.bits);
  for (const c of EXT_MAKEUP) m.set(c.run, c.bits);
  return m;
}
const WHITE_RUNS = runMap(WHITE_CODES);
const BLACK_RUNS = runMap(BLACK_CODES);

/** The longest makeup available: past this a run needs several. */
const MAX_MAKEUP = 2560;

class BitWriter {
  private bytes: number[] = [];
  private cur = 0;
  private nbits = 0;

  /** Append an MSB-first bit string. */
  put(bits: string): void {
    for (let i = 0; i < bits.length; i++) {
      this.cur = (this.cur << 1) | (bits.charCodeAt(i) === 49 ? 1 : 0);
      if (++this.nbits === 8) { this.bytes.push(this.cur & 0xff); this.cur = 0; this.nbits = 0; }
    }
  }

  /** Pad the final byte with zeros, as T.6 fill does. */
  finish(): Uint8Array {
    if (this.nbits > 0) {
      this.bytes.push((this.cur << (8 - this.nbits)) & 0xff);
      this.cur = 0; this.nbits = 0;
    }
    return Uint8Array.from(this.bytes);
  }
}

/** Emit a run of `color` (0 = white, 1 = black) as makeup codes plus one
 *  terminating code.
 *
 *  The loop is what handles a run past 2560: `Math.min(..., MAX_MAKEUP)` alone
 *  would leave a remainder of 64 or more, which has no terminating code. */
function putRun(w: BitWriter, color: number, run: number): void {
  const table = color === 0 ? WHITE_RUNS : BLACK_RUNS;
  let left = run;
  while (left >= 64) {
    const makeup = Math.min(Math.floor(left / 64) * 64, MAX_MAKEUP);
    const bits = table.get(makeup);
    if (bits === undefined) throw new Error(`ccitt: no makeup code for ${makeup}`);
    w.put(bits);
    left -= makeup;
  }
  const bits = table.get(left);
  if (bits === undefined) throw new Error(`ccitt: no terminating code for ${left}`);
  w.put(bits);
}

/** Positions where a row's colour changes, with an imaginary white pixel to the
 *  left of column 0. Index i begins a run of colour (i even ? black : white) —
 *  the same list shape `ccitt.ts` decodes into, which is what lets the two
 *  halves share `findB1Index`. */
function changingElements(bits: Uint8Array, off: number, columns: number): number[] {
  const out: number[] = [];
  let prev = 0;
  for (let x = 0; x < columns; x++) {
    const v = (bits[off + (x >> 3)] >> (7 - (x & 7))) & 1;
    if (v !== prev) { out.push(x); prev = v; }
  }
  return out;
}

/** Vertical-mode code for a1 - b1 in -3..3, or undefined when out of range. */
function verticalCode(delta: number): string | undefined {
  switch (delta) {
    case 0: return MODE_CODES.V0;
    case 1: return MODE_CODES.VR1;
    case 2: return MODE_CODES.VR2;
    case 3: return MODE_CODES.VR3;
    case -1: return MODE_CODES.VL1;
    case -2: return MODE_CODES.VL2;
    case -3: return MODE_CODES.VL3;
    default: return undefined;
  }
}

export interface G4EncodeOptions {
  /** Append the end-of-facsimile-block code (two EOLs). Default true, which is
   *  what T.6 specifies. TIFF strips commonly omit it and readers accept
   *  either, so it is an option rather than a rule. */
  eofb?: boolean;
}

/**
 * Encode packed 1-bpp rows as CCITT Group 4.
 *
 * @param bits    `ceil(columns/8) * rows` bytes, MSB-first, **1 = black**
 * @param columns pixels per row
 * @param rows    row count
 */
export function encodeG4(
  bits: Uint8Array, columns: number, rows: number, opts: G4EncodeOptions = {},
): Uint8Array {
  if (!Number.isInteger(columns) || !Number.isInteger(rows) || columns < 1 || rows < 1)
    throw new TypeError('encodeG4: columns and rows must be positive integers');
  const stride = (columns + 7) >> 3;
  if (bits.length < stride * rows)
    throw new TypeError(`encodeG4: expected at least ${stride * rows} bytes, got ${bits.length}`);

  const w = new BitWriter();
  // The reference line above row 0 is an imaginary all-white line, which has no
  // changing elements at all.
  let ref: number[] = [];

  for (let y = 0; y < rows; y++) {
    const cur = changingElements(bits, y * stride, columns);
    let a0 = -1;
    let color = 0;

    while (a0 < columns) {
      // a1 is the next change on the CODING line that leaves `color`, and it
      // takes the SAME colour argument as b1 — both want the first change right
      // of a0 that begins a run of the opposite colour to a0's. Passing the
      // flipped colour here selects the wrong parity and skips a1 entirely.
      const ai = findB1Index(cur, a0, color);
      const a1 = cur[ai] ?? columns;
      const a2 = cur[ai + 1] ?? columns;

      const bi = findB1Index(ref, a0, color);
      const b1 = ref[bi] ?? columns;
      const b2 = ref[bi + 1] ?? columns;

      if (b2 < a1) {
        w.put(MODE_CODES.P);
        a0 = b2;
        continue;
      }
      const v = verticalCode(a1 - b1);
      if (v !== undefined) {
        w.put(v);
        a0 = a1;
        color ^= 1;
        continue;
      }
      // Horizontal: two runs from a0 (clamped at 0 for the first row element),
      // leaving the colour unchanged.
      const start = a0 < 0 ? 0 : a0;
      w.put(MODE_CODES.H);
      putRun(w, color, a1 - start);
      putRun(w, color ^ 1, a2 - a1);
      a0 = a2;
    }
    ref = cur;
  }

  if (opts.eofb ?? true) { w.put('000000000001'); w.put('000000000001'); }
  return w.finish();
}

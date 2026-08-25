import { PdfParseError } from './errors.js';
import { WHITE_CODES, BLACK_CODES, EXT_MAKEUP, MODE_CODES, RunCode } from './ccitt-tables.js';

export interface CcittParams {
  /** < 0: pure 2D (G4); 0: pure 1D (G3); > 0: mixed 1D/2D (G3 2D). */
  k: number;
  columns: number;
  rows: number;
  blackIs1: boolean;
  byteAlign: boolean;
  /** EOL codes present before lines (PDF EndOfLine; default false). Advisory:
   *  EOL codes are detected defensively whether or not this is set. */
  endOfLine: boolean;
  /** Honor EOFB (two EOLs) to stop decoding (PDF EndOfBlock; default true). */
  endOfBlock: boolean;
}

// Per-colour prefix maps: bit string -> run length (terminating + makeup).
function buildMap(codes: RunCode[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const c of [...codes, ...EXT_MAKEUP]) m.set(c.bits, c.run);
  return m;
}
const WHITE = buildMap(WHITE_CODES);
const BLACK = buildMap(BLACK_CODES);

class BitReader {
  private pos = 0;
  constructor(private readonly data: Uint8Array) {}
  bit(): number {
    const byte = this.data[this.pos >> 3];
    if (byte === undefined) return -1;
    const b = (byte >> (7 - (this.pos & 7))) & 1;
    this.pos++;
    return b;
  }
  alignToByte(): void { if (this.pos & 7) this.pos = (this.pos & ~7) + 8; }
  eof(): boolean { return (this.pos >> 3) >= this.data.length; }
  tell(): number { return this.pos; }
  seek(p: number): void { this.pos = p; }
}

/** Read one run length for `map` (sum of makeup codes + a terminating code). */
function readRun(br: BitReader, map: Map<string, number>): number {
  let total = 0;
  for (;;) {
    let bits = '';
    let run = -1;
    while (bits.length <= 14) {
      const b = br.bit();
      if (b < 0) throw new PdfParseError('CCITT: unexpected end of data in run');
      bits += b ? '1' : '0';
      const r = map.get(bits);
      if (r !== undefined) { run = r; break; }
    }
    if (run < 0) throw new PdfParseError(`CCITT: bad run code "${bits}"`);
    total += run;
    if (run < 64) return total; // terminating code ends the run
  }
}

/** Read one 2D mode code; returns 'P', 'H', or a signed vertical offset (-3..3). */
function readMode(br: BitReader): 'P' | 'H' | number {
  let bits = '';
  while (bits.length <= 7) {
    const b = br.bit();
    if (b < 0) throw new PdfParseError('CCITT: unexpected end in mode code');
    bits += b ? '1' : '0';
    if (bits === MODE_CODES.V0) return 0;
    if (bits === MODE_CODES.H) return 'H';
    if (bits === MODE_CODES.VR1) return 1;
    if (bits === MODE_CODES.VL1) return -1;
    if (bits === MODE_CODES.P) return 'P';
    if (bits === MODE_CODES.VR2) return 2;
    if (bits === MODE_CODES.VL2) return -2;
    if (bits === MODE_CODES.VR3) return 3;
    if (bits === MODE_CODES.VL3) return -3;
  }
  throw new PdfParseError(`CCITT: bad mode code "${bits}"`);
}

/** Index of b1 in the reference changing-element list: first change strictly
 *  right of a0 whose colour is opposite to `color` (0=white, 1=black). The
 *  changing element at index i begins a run of colour (i even ? black : white),
 *  so opposite-to-white wants an even index and opposite-to-black an odd one. */
function findB1Index(ref: number[], a0: number, color: number): number {
  let i = 0;
  while (i < ref.length && ref[i] <= a0) i++;
  const wantEven = color === 0;
  if (((i % 2) === 0) !== wantEven) i++;
  return i;
}

/** Consume an EOL code (>=11 zero fill bits then a 1) if present; otherwise
 *  restore position and return false. Any real run/mode code has <11 leading
 *  zeros, so >=11 zeros followed by 1 is unambiguously an EOL. */
function tryEol(br: BitReader): boolean {
  const start = br.tell();
  let zeros = 0;
  for (;;) {
    const b = br.bit();
    if (b < 0) { br.seek(start); return false; }
    if (b === 0) { zeros++; continue; }
    if (zeros >= 11) return true;
    br.seek(start);
    return false;
  }
}

/** Decode one 2D row (T.6 / G3-2D) against reference changing-elements `ref`
 *  into current-line changing-element positions. */
function decode2DRow(br: BitReader, ref: number[], columns: number): number[] {
  const cur: number[] = [];
  let a0 = -1;
  let color = 0; // 0 = white, 1 = black
  while (a0 < columns) {
    const i = findB1Index(ref, a0, color);
    const b1 = ref[i] ?? columns;
    const b2 = ref[i + 1] ?? columns;
    const mode = readMode(br);
    if (mode === 'P') {
      a0 = b2;
    } else if (mode === 'H') {
      const start = a0 < 0 ? 0 : a0;
      const r1 = readRun(br, color === 0 ? WHITE : BLACK);
      const r2 = readRun(br, color === 0 ? BLACK : WHITE);
      const a1 = Math.min(start + r1, columns);
      const a2 = Math.min(a1 + r2, columns);
      cur.push(a1, a2);
      a0 = a2;
    } else {
      const a1 = Math.max(0, Math.min(b1 + mode, columns));
      cur.push(a1);
      a0 = a1;
      color ^= 1;
    }
  }
  return cur;
}

/** Decode one Group 3 1D (modified-Huffman) row into changing-element positions.
 *  Runs alternate white, black, ... starting white, until the row fills `columns`. */
function decode1DRow(br: BitReader, columns: number): number[] {
  const cur: number[] = [];
  let pos = 0;
  let color = 0; // 0 = white
  while (pos < columns) {
    const run = readRun(br, color === 0 ? WHITE : BLACK);
    pos = Math.min(pos + run, columns);
    cur.push(pos);
    color ^= 1;
    if (cur.length > columns + 2) throw new PdfParseError('CCITT: 1D row overrun');
  }
  return cur;
}

/** Consume an EOFB (two EOLs) if one is next, restoring position if not. Unlike
 *  `tryEol` this is all-or-nothing: a lone EOL is not an EOFB and must be left
 *  where it was for the caller to make sense of. */
function tryEofb(br: BitReader): boolean {
  const start = br.tell();
  if (tryEol(br) && tryEol(br)) return true;
  br.seek(start);
  return false;
}

/** A decode plus where in the input it stopped. */
export interface CcittResult {
  data: Uint8Array;
  /** Bytes of `data` consumed, terminating EOFB included, rounded up to a byte. */
  consumed: number;
}

/** Decode CCITT fax data, reporting how much of the input it took.
 *
 *  This entry exists for JBIG2: T.88 Annex C.5 packs every grayscale bitplane
 *  into ONE MMR datastream with an EOFB between them, and `decodeCcitt` takes a
 *  byte range and returns an image with no way to say where it stopped. It is
 *  the only change the JBIG2 completeness work makes outside `src/jbig2*.ts`,
 *  and `decodeCcitt` is a wrapper over it so the two cannot drift.
 *
 *  Note the next plane is taken to begin at the next BYTE. T.88 does not say so
 *  in as many words — it says only that the decoder must skip the EOFB — and no
 *  real-world fixture is available to settle it, so that is an assumption
 *  rather than a fact. Everything our own encoder produces is byte-aligned. */
export function decodeCcittConsumed(data: Uint8Array, p: CcittParams): CcittResult {
  const { k, columns, blackIs1, byteAlign, endOfBlock } = p;
  const rowBytes = (columns + 7) >> 3;
  const out: Uint8Array[] = [];
  const br = new BitReader(data);

  let ref: number[] = []; // reference line changing elements (initial line: all white)
  const maxRows = p.rows > 0 ? p.rows : Number.MAX_SAFE_INTEGER;

  for (let y = 0; y < maxRows; y++) {
    if (br.eof()) break;
    const eol = tryEol(br);
    if (eol && endOfBlock && tryEol(br)) break; // EOFB / RTC -> end of block
    if (br.eof()) break;

    let cur: number[];
    if (k < 0) {
      cur = decode2DRow(br, ref, columns);
    } else if (k === 0) {
      cur = decode1DRow(br, columns);
    } else {
      // G3 2D: a 1-bit tag selects 1D (1) or 2D (0) coding for this line.
      cur = br.bit() === 1 ? decode1DRow(br, columns) : decode2DRow(br, ref, columns);
    }

    const row = new Uint8Array(rowBytes);
    let pos = 0, col = 0;
    for (const change of [...cur, columns]) {
      if (col === 1) {
        for (let x = pos; x < change && x < columns; x++) row[x >> 3] |= 0x80 >> (x & 7);
      }
      pos = change;
      col ^= 1;
    }
    if (blackIs1) for (let b = 0; b < rowBytes; b++) row[b] ^= 0xff;
    out.push(row);

    ref = cur;
    if (byteAlign) br.alignToByte();
  }

  const merged = new Uint8Array(out.length * rowBytes);
  out.forEach((r, idx) => merged.set(r, idx * rowBytes));
  // Reached only when the row loop ended on `rows` — which is every JBIG2 call,
  // since they all pass an explicit height, and the loop's own `endOfBlock`
  // branch has already eaten the terminator otherwise.
  tryEofb(br);
  return { data: merged, consumed: Math.min(data.length, (br.tell() + 7) >> 3) };
}

/** Decode CCITT Group 4 (k<0) fax data into packed 1-bpp rows (MSB-first).
 *  Output bit 0 = white unless `blackIs1`. */
export function decodeCcitt(data: Uint8Array, p: CcittParams): Uint8Array {
  return decodeCcittConsumed(data, p).data;
}

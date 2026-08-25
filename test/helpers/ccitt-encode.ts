import { WHITE_CODES, BLACK_CODES, EXT_MAKEUP, MODE_CODES, type RunCode } from '../../src/ccitt-tables.js';

export type Bitmap = number[][];
export interface EncodeOpts { byteAlign?: boolean; endOfLine?: boolean; eofb?: boolean }

const EOL = '000000000001';

// run -> bits, split into terminating (<64) and makeup (>=64, incl. extended).
function buildEnc(codes: RunCode[]): { term: Map<number, string>; makeup: Map<number, string> } {
  const term = new Map<number, string>();
  const makeup = new Map<number, string>();
  for (const c of codes) (c.run < 64 ? term : makeup).set(c.run, c.bits);
  for (const c of EXT_MAKEUP) makeup.set(c.run, c.bits);
  return { term, makeup };
}
const WHITE_ENC = buildEnc(WHITE_CODES);
const BLACK_ENC = buildEnc(BLACK_CODES);

/** Encode one run length (>=0) for `color` (0=white,1=black) as makeup* + terminating. */
function encRun(len: number, color: number): string {
  const enc = color === 0 ? WHITE_ENC : BLACK_ENC;
  let n = len, bits = '';
  while (n >= 64) {
    const m = Math.min(Math.floor(n / 64) * 64, 2560); // largest multiple of 64 <= n, capped
    const code = enc.makeup.get(m);
    if (code === undefined) throw new Error(`ccitt-encode: no makeup code for ${m}`);
    bits += code;
    n -= m;
  }
  const t = enc.term.get(n);
  if (t === undefined) throw new Error(`ccitt-encode: no terminating code for ${n}`);
  return bits + t;
}

/** Changing elements of a pixel row: positions where colour flips, starting white. */
function changes(rowPixels: number[]): number[] {
  const out: number[] = [];
  let color = 0;
  for (let x = 0; x < rowPixels.length; x++) {
    if (rowPixels[x] !== color) { out.push(x); color = rowPixels[x]; }
  }
  return out;
}

/** First changing element strictly greater than x, or `columns` if none. */
function firstGt(list: number[], x: number, columns: number): number {
  for (const v of list) if (v > x) return v;
  return columns;
}

/** b1 index: first ref change strictly right of a0 with colour opposite to `color`. */
function b1Index(ref: number[], a0: number, color: number): number {
  let i = 0;
  while (i < ref.length && ref[i] <= a0) i++;
  const wantEven = color === 0;
  if (((i % 2) === 0) !== wantEven) i++;
  return i;
}

const V_CODE: Record<number, string> = {
  0: MODE_CODES.V0,
  1: MODE_CODES.VR1, 2: MODE_CODES.VR2, 3: MODE_CODES.VR3,
  [-1]: MODE_CODES.VL1, [-2]: MODE_CODES.VL2, [-3]: MODE_CODES.VL3,
};

/** Encode one 1D (modified-Huffman) row. */
function enc1DRow(rowPixels: number[], columns: number): string {
  const ch = changes(rowPixels);
  let bits = '', pos = 0, color = 0;
  for (const c of ch) { bits += encRun(c - pos, color); pos = c; color ^= 1; }
  bits += encRun(columns - pos, color); // final run to the row edge
  return bits;
}

/** Encode one 2D row against reference changing-elements `ref` (mirrors decode2DRow). */
function enc2DRow(rowPixels: number[], ref: number[], columns: number): string {
  const cur = changes(rowPixels);
  let bits = '', a0 = -1, color = 0;
  while (a0 < columns) {
    const a1 = firstGt(cur, a0, columns);
    const i = b1Index(ref, a0, color);
    const b1 = ref[i] ?? columns;
    const b2 = ref[i + 1] ?? columns;
    if (b2 < a1) { bits += MODE_CODES.P; a0 = b2; }               // pass
    else if (Math.abs(a1 - b1) <= 3) {                            // vertical
      bits += V_CODE[a1 - b1]; a0 = a1; color ^= 1;
    } else {                                                      // horizontal
      const a2 = firstGt(cur, a1, columns);
      const start = a0 < 0 ? 0 : a0;
      bits += MODE_CODES.H + encRun(a1 - start, color) + encRun(a2 - a1, color ^ 1);
      a0 = a2;
    }
  }
  return bits;
}

function bitsToBytes(bits: string): Uint8Array {
  const pad = (8 - (bits.length % 8)) % 8;
  const padded = bits + '0'.repeat(pad);
  const out = new Uint8Array(padded.length / 8);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(padded.slice(i * 8, i * 8 + 8), 2);
  return out;
}

type RowEncoder = (rowPixels: number[], ref: number[], columns: number) => { bits: string; tag?: string };

function assemble(bm: Bitmap, rowEnc: RowEncoder, opts: EncodeOpts): Uint8Array {
  const columns = bm.length ? bm[0].length : 0;
  let bits = '';
  let ref: number[] = [];
  for (const rowPixels of bm) {
    if (opts.endOfLine) bits += EOL;
    const { bits: rowBits, tag } = rowEnc(rowPixels, ref, columns);
    if (tag !== undefined) bits += tag;
    bits += rowBits;
    ref = changes(rowPixels);
    if (opts.byteAlign && bits.length % 8) bits += '0'.repeat(8 - (bits.length % 8));
  }
  if (opts.eofb) bits += EOL + EOL;
  return bitsToBytes(bits);
}

export function encodeG4(bm: Bitmap, opts: EncodeOpts = {}): Uint8Array {
  return assemble(bm, (r, ref, cols) => ({ bits: enc2DRow(r, ref, cols) }), opts);
}

export function encodeG3_1D(bm: Bitmap, opts: EncodeOpts = {}): Uint8Array {
  return assemble(bm, (r, _ref, cols) => ({ bits: enc1DRow(r, cols) }), opts);
}

/** G3 2D: first row 1D (tag 1), remaining rows 2D (tag 0). */
export function encodeG3_2D(bm: Bitmap, opts: EncodeOpts = {}): Uint8Array {
  let first = true;
  return assemble(bm, (r, ref, cols) => {
    if (first) { first = false; return { bits: enc1DRow(r, cols), tag: '1' }; }
    return { bits: enc2DRow(r, ref, cols), tag: '0' };
  }, opts);
}

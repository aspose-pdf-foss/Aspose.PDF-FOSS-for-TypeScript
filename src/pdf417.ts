// PDF417 (ISO/IEC 15438) encoding: high-level compaction, Reed-Solomon over
// GF(929), and the row layout. A pure leaf over pdf417data.js -- no Document,
// no PDF object -- so every rule is testable from numbers.
import type { MatrixBarcode } from './barcode.js';
import {
  PDF417_PATTERNS, PDF417_START, PDF417_STOP, PDF417_TEXT_MIXED, PDF417_TEXT_PUNCT,
} from './pdf417data.js';

export interface Pdf417Options {
  /** Error-correction level 0..8 (2^(level+1) codewords). Default: the level
   *  ISO/IEC 15438 Annex E recommends for the data length, lowered only as far
   *  as the data needs to fit. */
  ecLevel?: number;
  /** Data columns, 1..30. Default: the count giving the symbol a width of
   *  about three times its height. */
  columns?: number;
}

const LATCH_TEXT = 900;
const LATCH_BYTE = 901;
const LATCH_NUMERIC = 902;
const LATCH_BYTE6 = 924;
const ECI_CHARSET = 927;
const PAD = 900;
/** Module rows per symbol row: ISO/IEC 15438 asks for at least 3X. */
const ROW_HEIGHT = 3;
/** Quiet zone in modules on every side: the standard's minimum is 2X. */
const QUIET = 2;
/** Preferred width:height of the drawn symbol. */
const PREFERRED_RATIO = 3;

// --- Input as bytes -----------------------------------------------------------

/** The data as bytes plus the ECI it needs: Latin-1 when every character fits
 *  (the PDF417 default interpretation needs no ECI), UTF-8 under ECI 26 otherwise. */
export function pdf417Bytes(data: string): { bytes: Uint8Array; eci?: number } {
  let latin1 = true;
  for (let i = 0; i < data.length; i++) if (data.charCodeAt(i) > 0xff) { latin1 = false; break; }
  if (latin1) return { bytes: Uint8Array.from(data, (c) => c.charCodeAt(0)) };
  return { bytes: new TextEncoder().encode(data), eci: 26 };
}

// --- Text compaction ------------------------------------------------------------

const MIXED = new Map<number, number>();
PDF417_TEXT_MIXED.forEach((c, v) => { if (c !== 0 && !MIXED.has(c)) MIXED.set(c, v); });
const PUNCT = new Map<number, number>();
PDF417_TEXT_PUNCT.forEach((c, v) => { if (c !== 0 && !PUNCT.has(c)) PUNCT.set(c, v); });

const isUpper = (b: number) => (b >= 0x41 && b <= 0x5a) || b === 0x20;
const isLower = (b: number) => (b >= 0x61 && b <= 0x7a) || b === 0x20;
const isMixed = (b: number) => MIXED.has(b);
const isPunct = (b: number) => PUNCT.has(b);
const isText = (b: number) => isUpper(b) || isLower(b) || isMixed(b) || isPunct(b);
const isDigit = (b: number) => b >= 0x30 && b <= 0x39;

const ALPHA = 0, LOWER = 1, MIX = 2, PUN = 3;

/** Text compaction of `bytes[from, to)`, starting in the alpha sub-mode. */
function encodeText(bytes: Uint8Array, from: number, to: number, out: number[]): void {
  const v: number[] = [];
  let mode = ALPHA;
  for (let i = from; i < to;) {
    const b = bytes[i];
    switch (mode) {
      case ALPHA:
        if (isUpper(b)) { v.push(b === 0x20 ? 26 : b - 0x41); i++; }
        else if (isLower(b)) { v.push(27); mode = LOWER; }
        else if (isMixed(b)) { v.push(28); mode = MIX; }
        else { v.push(29, PUNCT.get(b)!); i++; }
        break;
      case LOWER:
        if (isLower(b)) { v.push(b === 0x20 ? 26 : b - 0x61); i++; }
        else if (isUpper(b)) { v.push(27, b - 0x41); i++; } // alpha shift
        else if (isMixed(b)) { v.push(28); mode = MIX; }
        else { v.push(29, PUNCT.get(b)!); i++; }
        break;
      case MIX:
        if (isMixed(b)) { v.push(MIXED.get(b)!); i++; }
        else if (isUpper(b)) { v.push(28); mode = ALPHA; }
        else if (isLower(b)) { v.push(27); mode = LOWER; }
        else if (i + 1 < to && isPunct(bytes[i + 1])) { v.push(25); mode = PUN; }
        else { v.push(29, PUNCT.get(b)!); i++; }
        break;
      default: // PUN
        if (isPunct(b)) { v.push(PUNCT.get(b)!); i++; }
        else { v.push(29); mode = ALPHA; }
    }
  }
  if (v.length % 2) v.push(29); // pad with a punctuation shift
  for (let i = 0; i < v.length; i += 2) out.push(v[i] * 30 + v[i + 1]);
}

// --- Byte and numeric compaction --------------------------------------------------

function encodeBytes(bytes: Uint8Array, from: number, to: number, out: number[]): void {
  const n = to - from;
  out.push(n % 6 === 0 ? LATCH_BYTE6 : LATCH_BYTE);
  let i = from;
  for (; i + 6 <= to; i += 6) {
    let t = 0;
    for (let k = 0; k < 6; k++) t = t * 256 + bytes[i + k]; // 48 bits: exact in a double
    const group: number[] = [];
    for (let k = 0; k < 5; k++) { group.unshift(t % 900); t = Math.floor(t / 900); }
    out.push(...group);
  }
  for (; i < to; i++) out.push(bytes[i]);
}

function encodeNumeric(bytes: Uint8Array, from: number, to: number, out: number[]): void {
  out.push(LATCH_NUMERIC);
  for (let i = from; i < to; i += 44) {
    let s = '1';
    for (let k = i; k < Math.min(to, i + 44); k++) s += String.fromCharCode(bytes[k]);
    let t = BigInt(s);
    const group: number[] = [];
    while (t > 0n) { group.unshift(Number(t % 900n)); t /= 900n; }
    out.push(...group);
  }
}

const NUMERIC_RUN = 13;
const TEXT_RUN = 5;

function digitRun(bytes: Uint8Array, at: number): number {
  let n = 0;
  while (at + n < bytes.length && isDigit(bytes[at + n])) n++;
  return n;
}

/** Text-compactable bytes from `at`, stopping where a numeric run would start. */
function textRun(bytes: Uint8Array, at: number): number {
  let i = at;
  while (i < bytes.length) {
    const d = digitRun(bytes, i);
    if (d >= NUMERIC_RUN) break;
    if (d > 0) { i += d; continue; }
    if (!isText(bytes[i])) break;
    i++;
  }
  return i - at;
}

/** Bytes from `at` best sent in byte compaction: up to where a numeric or a
 *  text run starts. Never 0. */
function byteRun(bytes: Uint8Array, at: number): number {
  let i = at;
  while (i < bytes.length) {
    if (i > at && (digitRun(bytes, i) >= NUMERIC_RUN || textRun(bytes, i) >= TEXT_RUN)) break;
    i++;
  }
  return i - at;
}

/** The high-level codewords for `data` -- everything but the symbol length
 *  descriptor, padding and error correction. Text compaction is the starting
 *  mode, so a leading text segment needs no latch. */
export function pdf417Codewords(data: string): number[] {
  const { bytes, eci } = pdf417Bytes(data);
  return pdf417CodewordsOf(bytes, eci);
}

/** {@link pdf417Codewords} over bytes already chosen, with the ECI they need. */
export function pdf417CodewordsOf(bytes: Uint8Array, eci: number | undefined): number[] {
  const out: number[] = [];
  if (eci !== undefined) out.push(ECI_CHARSET, eci);
  let inText = true;
  for (let at = 0; at < bytes.length;) {
    const d = digitRun(bytes, at);
    if (d >= NUMERIC_RUN) {
      encodeNumeric(bytes, at, at + d, out);
      inText = false; at += d; continue;
    }
    const t = textRun(bytes, at);
    // Already in text compaction a run of any length costs no latch.
    if (t >= TEXT_RUN || (inText && t > 0)) {
      if (!inText) out.push(LATCH_TEXT);
      encodeText(bytes, at, at + t, out);
      inText = true; at += t; continue;
    }
    const b = byteRun(bytes, at);
    encodeBytes(bytes, at, at + b, out);
    inText = false; at += b;
  }
  return out;
}

// --- Reed-Solomon over GF(929) -------------------------------------------------------

const P = 929;
const generators = new Map<number, number[]>();

/** g(x) = (x - 3)(x - 3^2)...(x - 3^k) mod 929, highest degree first. */
export function pdf417Generator(k: number): number[] {
  let g = generators.get(k);
  if (g) return g;
  g = [1];
  let root = 1;
  for (let i = 1; i <= k; i++) {
    root = (root * 3) % P;
    const next = new Array<number>(g.length + 1).fill(0);
    for (let j = 0; j < g.length; j++) {
      next[j] = (next[j] + g[j]) % P;
      next[j + 1] = (next[j + 1] + P - (g[j] * root) % P) % P;
    }
    g = next;
  }
  generators.set(k, g);
  return g;
}

/** The 2^(level+1) error-correction codewords for `data`: the remainder of
 *  d(x)·x^k by g(x), each coefficient negated mod 929 (ISO/IEC 15438 4.10). */
export function pdf417ErrorCorrection(data: readonly number[], level: number): number[] {
  const k = 1 << (level + 1);
  const g = pdf417Generator(k);
  const r = new Array<number>(k).fill(0);
  for (const d of data) {
    const f = (d + r[0]) % P;
    for (let j = 0; j < k; j++) {
      const next = j + 1 < k ? r[j + 1] : 0;
      r[j] = (next + P - (f * g[j + 1]) % P) % P;
    }
  }
  return r.map((c) => (P - c) % P);
}

// --- Symbol ------------------------------------------------------------------------

function recommendedLevel(n: number): number {
  if (n <= 40) return 2;
  if (n <= 160) return 3;
  if (n <= 320) return 4;
  return 5;
}

export interface Pdf417Layout { columns: number; rows: number; ecLevel: number; codewords: number[] }

/** Choose the EC level and shape and build the full codeword sequence: length
 *  descriptor, high-level codewords, pad, error correction. */
export function layoutPdf417(data: string, opts: Pdf417Options = {}): Pdf417Layout {
  return layoutCodewords(pdf417Codewords(data), opts);
}

function layoutCodewords(hl: readonly number[], opts: Pdf417Options): Pdf417Layout {
  if (opts.ecLevel !== undefined && !(Number.isInteger(opts.ecLevel) && opts.ecLevel >= 0 && opts.ecLevel <= 8))
    throw new RangeError('PDF417 ecLevel must be an integer 0..8');
  if (opts.columns !== undefined && !(Number.isInteger(opts.columns) && opts.columns >= 1 && opts.columns <= 30))
    throw new RangeError('PDF417 columns must be an integer 1..30');
  const m = hl.length + 1; // + the length descriptor
  let level = opts.ecLevel ?? recommendedLevel(m);
  if (opts.ecLevel === undefined) while (level > 0 && m + (1 << (level + 1)) > 928) level--;
  const k = 1 << (level + 1);
  if (m + k > 928)
    throw new RangeError(`PDF417: ${m} data codewords and ${k} error-correction codewords exceed the 928 a symbol holds`);

  let best: { c: number; r: number } | undefined;
  let bestScore = Infinity;
  const cols = opts.columns !== undefined ? [opts.columns] : Array.from({ length: 30 }, (_, i) => i + 1);
  for (const c of cols) {
    const r = Math.max(3, Math.ceil((m + k) / c));
    // The length descriptor counts data codewords padding included, and is
    // itself a codeword: the padded data may not pass 928.
    if (r > 90 || c * r - k > 928) continue;
    const score = Math.abs((17 * c + 69) / (r * ROW_HEIGHT) - PREFERRED_RATIO);
    if (score < bestScore) { bestScore = score; best = { c, r }; }
  }
  if (!best)
    throw new RangeError(`PDF417: ${m + k} codewords need more than 90 rows of ${opts.columns} columns`);
  const { c, r } = best;
  const pad = c * r - k - m;
  const dataCw = [m + pad, ...hl, ...new Array<number>(pad).fill(PAD)];
  return { columns: c, rows: r, ecLevel: level, codewords: [...dataCw, ...pdf417ErrorCorrection(dataCw, level)] };
}

function pushPattern(row: boolean[], pattern: number, len: number): void {
  for (let i = len - 1; i >= 0; i--) row.push(((pattern >> i) & 1) === 1);
}

/** Generate a PDF417 symbol for `data`. Strings of Latin-1 characters are
 *  encoded as-is; any other string as UTF-8 under ECI 26. */
export function makePdf417(data: string, opts: Pdf417Options = {}): MatrixBarcode {
  if (typeof data !== 'string' || data.length === 0)
    throw new TypeError('makePdf417: data must be a non-empty string');
  const { bytes, eci } = pdf417Bytes(data);
  return makePdf417Bytes(bytes, eci, opts);
}

/** {@link makePdf417} over bytes already chosen, with the ECI they need: the
 *  path a paper-barcode field draws through, whose content may be compressed.
 *  Not exported from index.ts. */
export function makePdf417Bytes(bytes: Uint8Array, eci: number | undefined, opts: Pdf417Options = {}): MatrixBarcode {
  if (bytes.length === 0) throw new TypeError('makePdf417Bytes: bytes must be non-empty');
  const { columns: c, rows: r, ecLevel, codewords } = layoutCodewords(pdf417CodewordsOf(bytes, eci), opts);
  const width = 17 * c + 69;
  const dark: boolean[] = [];
  for (let y = 0; y < r; y++) {
    const cluster = y % 3;
    const base = 30 * Math.floor(y / 3);
    const rowsInd = Math.floor((r - 1) / 3);
    const ecInd = ecLevel * 3 + ((r - 1) % 3);
    const left = base + (cluster === 0 ? rowsInd : cluster === 1 ? ecInd : c - 1);
    const right = base + (cluster === 0 ? c - 1 : cluster === 1 ? rowsInd : ecInd);
    const row: boolean[] = [];
    const table = PDF417_PATTERNS[cluster];
    pushPattern(row, PDF417_START, 17);
    pushPattern(row, table[left], 17);
    for (let x = 0; x < c; x++) pushPattern(row, table[codewords[y * c + x]], 17);
    pushPattern(row, table[right], 17);
    pushPattern(row, PDF417_STOP, 18);
    dark.push(...row);
  }
  return { kind: 'matrix', size: width, width, height: r, rowHeight: ROW_HEIGHT, quiet: QUIET, dark };
}

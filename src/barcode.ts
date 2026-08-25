import { PdfParseError } from './errors.js';
import { makeQr } from './qr.js';

export { makeQr };
export type { QrEcc, QrOptions } from './qr.js';

/** 1D barcode geometry: alternating bar/space run widths in unit modules.
 *  `modules[0]` is a bar (dark); runs alternate bar, space, bar, ...
 *  `quietLeft`/`quietRight` are the recommended quiet-zone widths in modules. */
export interface LinearBarcode {
  kind: 'linear';
  modules: number[];
  quietLeft: number;
  quietRight: number;
  /** Human-readable payload (for optional caption rendering). */
  text?: string;
}

/** 2D barcode geometry: a square matrix of dark/light modules, row-major. */
export interface MatrixBarcode {
  kind: 'matrix';
  size: number;
  dark: boolean[];
}

export type BarcodeModel = LinearBarcode | MatrixBarcode;

// ---------------------------------------------------------------------------
// Code128 (ISO/IEC 15417)
// ---------------------------------------------------------------------------

/** Bar/space width patterns for Code128 values 0..106. Values 0..102 are data
 *  symbols (6 elements, 11 modules), 103/104/105 are Start A/B/C, 106 is Stop
 *  (7 elements, 13 modules). From the canonical ISO/IEC 15417 table. */
export const CODE128_PATTERNS: readonly (readonly number[])[] = [
  [2, 1, 2, 2, 2, 2], [2, 2, 2, 1, 2, 2], [2, 2, 2, 2, 2, 1], [1, 2, 1, 2, 2, 3],
  [1, 2, 1, 3, 2, 2], [1, 3, 1, 2, 2, 2], [1, 2, 2, 2, 1, 3], [1, 2, 2, 3, 1, 2],
  [1, 3, 2, 2, 1, 2], [2, 2, 1, 2, 1, 3], [2, 2, 1, 3, 1, 2], [2, 3, 1, 2, 1, 2],
  [1, 1, 2, 2, 3, 2], [1, 2, 2, 1, 3, 2], [1, 2, 2, 2, 3, 1], [1, 1, 3, 2, 2, 2],
  [1, 2, 3, 1, 2, 2], [1, 2, 3, 2, 2, 1], [2, 2, 3, 2, 1, 1], [2, 2, 1, 1, 3, 2],
  [2, 2, 1, 2, 3, 1], [2, 1, 3, 2, 1, 2], [2, 2, 3, 1, 1, 2], [3, 1, 2, 1, 3, 1],
  [3, 1, 1, 2, 2, 2], [3, 2, 1, 1, 2, 2], [3, 2, 1, 2, 2, 1], [3, 1, 2, 2, 1, 2],
  [3, 2, 2, 1, 1, 2], [3, 2, 2, 2, 1, 1], [2, 1, 2, 1, 2, 3], [2, 1, 2, 3, 2, 1],
  [2, 3, 2, 1, 2, 1], [1, 1, 1, 3, 2, 3], [1, 3, 1, 1, 2, 3], [1, 3, 1, 3, 2, 1],
  [1, 1, 2, 3, 1, 3], [1, 3, 2, 1, 1, 3], [1, 3, 2, 3, 1, 1], [2, 1, 1, 3, 1, 3],
  [2, 3, 1, 1, 1, 3], [2, 3, 1, 3, 1, 1], [1, 1, 2, 1, 3, 3], [1, 1, 2, 3, 3, 1],
  [1, 3, 2, 1, 3, 1], [1, 1, 3, 1, 2, 3], [1, 1, 3, 3, 2, 1], [1, 3, 3, 1, 2, 1],
  [3, 1, 3, 1, 2, 1], [2, 1, 1, 3, 3, 1], [2, 3, 1, 1, 3, 1], [2, 1, 3, 1, 1, 3],
  [2, 1, 3, 3, 1, 1], [2, 1, 3, 1, 3, 1], [3, 1, 1, 1, 2, 3], [3, 1, 1, 3, 2, 1],
  [3, 3, 1, 1, 2, 1], [3, 1, 2, 1, 1, 3], [3, 1, 2, 3, 1, 1], [3, 3, 2, 1, 1, 1],
  [3, 1, 4, 1, 1, 1], [2, 2, 1, 4, 1, 1], [4, 3, 1, 1, 1, 1], [1, 1, 1, 2, 2, 4],
  [1, 1, 1, 4, 2, 2], [1, 2, 1, 1, 2, 4], [1, 2, 1, 4, 2, 1], [1, 4, 1, 1, 2, 2],
  [1, 4, 1, 2, 2, 1], [1, 1, 2, 2, 1, 4], [1, 1, 2, 4, 1, 2], [1, 2, 2, 1, 1, 4],
  [1, 2, 2, 4, 1, 1], [1, 4, 2, 1, 1, 2], [1, 4, 2, 2, 1, 1], [2, 4, 1, 2, 1, 1],
  [2, 2, 1, 1, 1, 4], [4, 1, 3, 1, 1, 1], [2, 4, 1, 1, 1, 2], [1, 3, 4, 1, 1, 1],
  [1, 1, 1, 2, 4, 2], [1, 2, 1, 1, 4, 2], [1, 2, 1, 2, 4, 1], [1, 1, 4, 2, 1, 2],
  [1, 2, 4, 1, 1, 2], [1, 2, 4, 2, 1, 1], [4, 1, 1, 2, 1, 2], [4, 2, 1, 1, 1, 2],
  [4, 2, 1, 2, 1, 1], [2, 1, 2, 1, 4, 1], [2, 1, 4, 1, 2, 1], [4, 1, 2, 1, 2, 1],
  [1, 1, 1, 1, 4, 3], [1, 1, 1, 3, 4, 1], [1, 3, 1, 1, 4, 1], [1, 1, 4, 1, 1, 3],
  [1, 1, 4, 3, 1, 1], [4, 1, 1, 1, 1, 3], [4, 1, 1, 3, 1, 1], [1, 1, 3, 1, 4, 1],
  [1, 1, 4, 1, 3, 1], [3, 1, 1, 1, 4, 1], [4, 1, 1, 1, 3, 1], [2, 1, 1, 4, 1, 2],
  [2, 1, 1, 2, 1, 4], [2, 1, 1, 2, 3, 2], [2, 3, 3, 1, 1, 1, 2],
];

const START_A = 103;
const START_B = 104;
const START_C = 105;
const STOP = 106;
const CODE_C = 99;  // switch-to-Code-C symbol (from Code A or B)
const CODE_B = 100; // switch-to-Code-B symbol (from Code A or C)
const CODE_A = 101; // switch-to-Code-A symbol (from Code B or C)
const SHIFT = 98;   // shift the next single symbol to the other of Code A/B

type CodeSet = 'A' | 'B' | 'C';

/** True when a run of `n` digits starts at `data[i]`. */
function digitsAt(data: string, i: number, n: number): boolean {
  if (i + n > data.length) return false;
  for (let k = 0; k < n; k++) {
    const c = data.charCodeAt(i + k);
    if (c < 48 || c > 57) return false;
  }
  return true;
}

/** The code set that can *exclusively* encode `c`: 'A' for control chars
 *  (0x00-0x1F), 'B' for the high range (0x60-0x7F), or null when both A and B
 *  can (0x20-0x5F). */
function exclusiveSet(c: number): CodeSet | null {
  if (c < 0x20) return 'A';
  if (c > 0x5f) return 'B';
  return null;
}

/** Pick the non-C start set (A or B) for a segment: A when the first character
 *  that only one of A/B can encode is a control char, otherwise B. */
function startAorB(data: string, i: number): CodeSet {
  for (let k = i; k < data.length; k++) {
    const only = exclusiveSet(data.charCodeAt(k));
    if (only) return only;
  }
  return 'B';
}

/** Encode char `c` as a data value in code set `set` (A or B). Callers ensure
 *  the character is representable in `set`. */
function charValue(c: number, set: CodeSet): number {
  if (set === 'A') return c < 0x20 ? c + 64 : c - 32; // 0x00-0x1F -> 64-95
  return c - 32;                                       // Code B: 0x20-0x7F -> 0-95
}

/** Encode a payload into Code128 symbol values (excluding Start/checksum/Stop),
 *  auto-selecting code sets A, B and C with greedy A/B switches and single-char
 *  shifts, and Code C for digit runs. Returns the chosen Start symbol too.
 *  Every character in 0x00-0x7F encodes; higher code points are rejected. */
function code128Values(data: string): { values: number[]; start: number } {
  for (let i = 0; i < data.length; i++) {
    if (data.charCodeAt(i) > 0x7f)
      throw new PdfParseError('Code128: only ASCII (0x00-0x7F) is supported');
  }
  // Start in Code C when the payload begins with >=4 digits, or is an even-length
  // run of >=2 digits that spans the whole string; otherwise A or B by content.
  const allDigits = /^\d+$/.test(data);
  const startC = digitsAt(data, 0, 4) ||
    (allDigits && data.length >= 2 && data.length % 2 === 0);
  let set: CodeSet = startC ? 'C' : startAorB(data, 0);
  const start = set === 'C' ? START_C : set === 'A' ? START_A : START_B;

  const values: number[] = [];
  let i = 0;
  while (i < data.length) {
    if (set === 'C') {
      // Stay in C only while an even count of digits (>=2) remains available.
      if (digitsAt(data, i, 2) && (digitsAt(data, i, 4) || i + 2 >= data.length)) {
        values.push((data.charCodeAt(i) - 48) * 10 + (data.charCodeAt(i + 1) - 48));
        i += 2;
        continue;
      }
      const next = startAorB(data, i);
      values.push(next === 'A' ? CODE_A : CODE_B);
      set = next;
      continue;
    }
    // Code A/B: switch to C for a run of >=4 digits, or >=2 trailing digits.
    const remaining = data.length - i;
    if (digitsAt(data, i, 4) || (digitsAt(data, i, 2) && remaining === 2)) {
      values.push(CODE_C);
      set = 'C';
      continue;
    }
    const c = data.charCodeAt(i);
    const only = exclusiveSet(c);
    if (only === null || only === set) {
      values.push(charValue(c, set));
      i += 1;
      continue;
    }
    // `c` needs the other set. Switch permanently if the next character also
    // requires it (a run); otherwise shift for this one character only.
    const nextOnly = i + 1 < data.length ? exclusiveSet(data.charCodeAt(i + 1)) : null;
    if (nextOnly === only) {
      values.push(only === 'A' ? CODE_A : CODE_B);
      set = only;
      continue;
    }
    values.push(SHIFT, charValue(c, only));
    i += 1;
  }
  return { values, start };
}

/** Generate a Code128 barcode for `data` with automatic A/B/C code-set selection
 *  (full ASCII 0x00-0x7F, including control characters), modulo-103 checksum,
 *  Start/Stop and Standard quiet zones. */
export function makeCode128(data: string): LinearBarcode {
  if (typeof data !== 'string' || data.length === 0)
    throw new TypeError('makeCode128: data must be a non-empty string');
  const { values, start } = code128Values(data);

  let checksum = start;
  values.forEach((v, idx) => { checksum += (idx + 1) * v; });
  checksum %= 103;

  const symbols = [start, ...values, checksum, STOP];
  const modules: number[] = [];
  for (const s of symbols) {
    for (const w of CODE128_PATTERNS[s]) modules.push(w);
  }
  return { kind: 'linear', modules, quietLeft: 10, quietRight: 10, text: data };
}

// ---------------------------------------------------------------------------
// EAN-13 / UPC-A / EAN-8 (ISO/IEC 15420)
// ---------------------------------------------------------------------------

/** Left-hand "odd" (L) digit patterns, 0..9 (7 modules each, MSB = leftmost). */
export const EAN_L: readonly string[] = [
  '0001101', '0011001', '0010011', '0111101', '0100011',
  '0110001', '0101111', '0111011', '0110111', '0001011',
];
/** Left-hand "even" (G) patterns: L reversed bit order. */
export const EAN_G: readonly string[] = EAN_L.map((s) => s.split('').reverse().join(''));
/** Right-hand (R) patterns: bitwise complement of L. */
export const EAN_R: readonly string[] =
  EAN_L.map((s) => s.replace(/[01]/g, (c) => (c === '0' ? '1' : '0')));
/** Left-half L/G parity selection by the first (implicit) digit, 0..9. */
export const EAN_PARITY: readonly string[] = [
  'LLLLLL', 'LLGLGG', 'LLGGLG', 'LLGGGL', 'LGLLGG',
  'LGGLLG', 'LGGGLL', 'LGLGLG', 'LGLGGL', 'LGGLGL',
];

/** EAN/UPC check digit for `digits` (weights 3,1,3,1,... from the right). */
function eanCheckDigit(digits: string): number {
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    // Rightmost data digit has weight 3; alternate. `digits` excludes the check.
    const weight = (digits.length - 1 - i) % 2 === 0 ? 3 : 1;
    sum += (digits.charCodeAt(i) - 48) * weight;
  }
  return (10 - (sum % 10)) % 10;
}

/** Validate `digits` is all-digits with length `full` (check present) or
 *  `full - 1` (check to be computed); return the full string with a valid check
 *  digit, throwing on charset/length/check mismatch. */
function normalizeEan(digits: string, full: number, label: string): string {
  if (typeof digits !== 'string' || !/^\d+$/.test(digits))
    throw new TypeError(`${label}: data must be a string of digits`);
  if (digits.length === full - 1) {
    return digits + eanCheckDigit(digits);
  }
  if (digits.length === full) {
    const body = digits.slice(0, full - 1);
    const expected = eanCheckDigit(body);
    if ((digits.charCodeAt(full - 1) - 48) !== expected)
      throw new PdfParseError(`${label}: incorrect check digit (expected ${expected})`);
    return digits;
  }
  throw new PdfParseError(`${label}: expected ${full - 1} or ${full} digits`);
}

/** Groups of L/G/R-encoded digit patterns → run-length modules (starts with a bar). */
function bitsToModules(bits: string): number[] {
  const modules: number[] = [];
  let run = 0, cur = bits[0];
  for (const c of bits) {
    if (c === cur) { run++; continue; }
    modules.push(run);
    cur = c; run = 1;
  }
  modules.push(run);
  return modules;
}

/** Generate an EAN-13 barcode. Accepts 12 digits (check computed) or 13 (check
 *  validated). */
export function makeEan13(digits: string): LinearBarcode {
  const full = normalizeEan(digits, 13, 'makeEan13');
  const parity = EAN_PARITY[full.charCodeAt(0) - 48];
  let bits = '101'; // start guard
  for (let i = 0; i < 6; i++) {
    const d = full.charCodeAt(1 + i) - 48;
    bits += parity[i] === 'L' ? EAN_L[d] : EAN_G[d];
  }
  bits += '01010'; // center guard
  for (let i = 0; i < 6; i++) bits += EAN_R[full.charCodeAt(7 + i) - 48];
  bits += '101'; // end guard
  return { kind: 'linear', modules: bitsToModules(bits), quietLeft: 11, quietRight: 7, text: full };
}

/** Generate a UPC-A barcode (encoded as a zero-prefixed EAN-13). Accepts 11
 *  digits (check computed) or 12 (check validated); `text` is the 12-digit form. */
export function makeUpcA(digits: string): LinearBarcode {
  const full = normalizeEan(digits, 12, 'makeUpcA');
  const bc = makeEan13('0' + full);
  return { ...bc, text: full };
}

/** Generate an EAN-8 barcode. Accepts 7 digits (check computed) or 8
 *  (check validated). */
export function makeEan8(digits: string): LinearBarcode {
  const full = normalizeEan(digits, 8, 'makeEan8');
  let bits = '101'; // start guard
  for (let i = 0; i < 4; i++) bits += EAN_L[full.charCodeAt(i) - 48];
  bits += '01010'; // center guard
  for (let i = 0; i < 4; i++) bits += EAN_R[full.charCodeAt(4 + i) - 48];
  bits += '101'; // end guard
  return { kind: 'linear', modules: bitsToModules(bits), quietLeft: 7, quietRight: 7, text: full };
}

import type { MatrixBarcode } from './barcode.js';
import { PdfParseError } from './errors.js';

export type QrEcc = 'L' | 'M' | 'Q' | 'H';

export interface QrOptions {
  ecc?: QrEcc;
  version?: number;
}

// ---------------------------------------------------------------------------
// GF(256) arithmetic (primitive polynomial 0x11d, generator 2)
// ---------------------------------------------------------------------------

const EXP = new Uint8Array(256);
const LOG = new Uint8Array(256);
(() => {
  let x = 1;
  for (let e = 0; e < 255; e++) {
    EXP[e] = x;
    LOG[x] = e;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  EXP[255] = EXP[0]; // convenience: alpha^255 == alpha^0 == 1
})();

/** Antilog in GF(256): alpha^e (e reduced mod 255). */
export function gfExp(e: number): number {
  return EXP[((e % 255) + 255) % 255];
}

/** GF(256) multiply (0 if either operand is 0). */
export function gfMul(a: number, b: number): number {
  if (a === 0 || b === 0) return 0;
  return EXP[(LOG[a] + LOG[b]) % 255];
}

/** Reed-Solomon generator polynomial coefficients (GF values, leading first),
 *  length `degree + 1`: Π (x - alpha^i) for i in 0..degree-1. */
export function rsGeneratorPoly(degree: number): number[] {
  let poly = [1];
  for (let i = 0; i < degree; i++) {
    // multiply poly by (x + alpha^i)
    const next = new Array(poly.length + 1).fill(0);
    for (let j = 0; j < poly.length; j++) {
      next[j] ^= poly[j];                       // x term
      next[j + 1] ^= gfMul(poly[j], gfExp(i));  // constant term
    }
    poly = next;
  }
  return poly;
}

/** The `ecLen` Reed-Solomon EC codewords for `data` (polynomial remainder). */
export function rsEncode(data: number[], ecLen: number): number[] {
  const gen = rsGeneratorPoly(ecLen);
  const rem = new Array(ecLen).fill(0);
  for (const d of data) {
    const factor = d ^ rem[0];
    rem.shift();
    rem.push(0);
    if (factor !== 0) {
      for (let i = 0; i < ecLen; i++) rem[i] ^= gfMul(gen[i + 1], factor);
    }
  }
  return rem;
}

// ---------------------------------------------------------------------------
// Version/ECC block structure (ISO/IEC 18004 Table 9)
// ---------------------------------------------------------------------------

/** Per (version, ecc) block layout: EC codewords per block, then two groups of
 *  (block count, data codewords per block). */
export interface EccBlocks {
  ecPerBlock: number;
  g1: number; g1Data: number;
  g2: number; g2Data: number;
}

const ECC_ORDER: QrEcc[] = ['L', 'M', 'Q', 'H'];

// Rows are versions 1..40; each row is [L, M, Q, H], each entry
// [ecPerBlock, g1Blocks, g1Data, g2Blocks, g2Data].
const BLOCK_TABLE: readonly (readonly (readonly number[])[])[] = [
  [[7,1,19,0,0],[10,1,16,0,0],[13,1,13,0,0],[17,1,9,0,0]],
  [[10,1,34,0,0],[16,1,28,0,0],[22,1,22,0,0],[28,1,16,0,0]],
  [[15,1,55,0,0],[26,1,44,0,0],[18,2,17,0,0],[22,2,13,0,0]],
  [[20,1,80,0,0],[18,2,32,0,0],[26,2,24,0,0],[16,4,9,0,0]],
  [[26,1,108,0,0],[24,2,43,0,0],[18,2,15,2,16],[22,2,11,2,12]],
  [[18,2,68,0,0],[16,4,27,0,0],[24,4,19,0,0],[28,4,15,0,0]],
  [[20,2,78,0,0],[18,4,31,0,0],[18,2,14,4,15],[26,4,13,1,14]],
  [[24,2,97,0,0],[22,2,38,2,39],[22,4,18,2,19],[26,4,14,2,15]],
  [[30,2,116,0,0],[22,3,36,2,37],[20,4,16,4,17],[24,4,12,4,13]],
  [[18,2,68,2,69],[26,4,43,1,44],[24,6,19,2,20],[28,6,15,2,16]],
  [[20,4,81,0,0],[30,1,50,4,51],[28,4,22,4,23],[24,3,12,8,13]],
  [[24,2,92,2,93],[22,6,36,2,37],[26,4,20,6,21],[28,7,14,4,15]],
  [[26,4,107,0,0],[22,8,37,1,38],[24,8,20,4,21],[22,12,11,4,12]],
  [[30,3,115,1,116],[24,4,40,5,41],[20,11,16,5,17],[24,11,12,5,13]],
  [[22,5,87,1,88],[24,5,41,5,42],[30,5,24,7,25],[24,11,12,7,13]],
  [[24,5,98,1,99],[28,7,45,3,46],[24,15,19,2,20],[30,3,15,13,16]],
  [[28,1,107,5,108],[28,10,46,1,47],[28,1,22,15,23],[28,2,14,17,15]],
  [[30,5,120,1,121],[26,9,43,4,44],[28,17,22,1,23],[28,2,14,19,15]],
  [[28,3,113,4,114],[26,3,44,11,45],[26,17,21,4,22],[26,9,13,16,14]],
  [[28,3,107,5,108],[26,3,41,13,42],[30,15,24,5,25],[28,15,15,10,16]],
  [[28,4,116,4,117],[26,17,42,0,0],[28,17,22,6,23],[30,19,16,6,17]],
  [[28,2,111,7,112],[28,17,46,0,0],[30,7,24,16,25],[24,34,13,0,0]],
  [[30,4,121,5,122],[28,4,47,14,48],[30,11,24,14,25],[30,16,15,14,16]],
  [[30,6,117,4,118],[28,6,45,14,46],[30,11,24,16,25],[30,30,16,2,17]],
  [[26,8,106,4,107],[28,8,47,13,48],[30,7,24,22,25],[30,22,15,13,16]],
  [[28,10,114,2,115],[28,19,46,4,47],[28,28,22,6,23],[30,33,16,4,17]],
  [[30,8,122,4,123],[28,22,45,3,46],[30,8,23,26,24],[30,12,15,28,16]],
  [[30,3,117,10,118],[28,3,45,23,46],[30,4,24,31,25],[30,11,15,31,16]],
  [[30,7,116,7,117],[28,21,45,7,46],[30,1,23,37,24],[30,19,15,26,16]],
  [[30,5,115,10,116],[28,19,47,10,48],[30,15,24,25,25],[30,23,15,25,16]],
  [[30,13,115,3,116],[28,2,46,29,47],[30,42,24,1,25],[30,23,15,28,16]],
  [[30,17,115,0,0],[28,10,46,23,47],[30,10,24,35,25],[30,19,15,35,16]],
  [[30,17,115,1,116],[28,14,46,21,47],[30,29,24,19,25],[30,11,15,46,16]],
  [[30,13,115,6,116],[28,14,46,23,47],[30,44,24,7,25],[30,59,16,1,17]],
  [[30,12,121,7,122],[28,12,47,26,48],[30,39,24,14,25],[30,22,15,41,16]],
  [[30,6,121,14,122],[28,6,47,34,48],[30,46,24,10,25],[30,2,15,64,16]],
  [[30,17,122,4,123],[28,29,46,14,47],[30,49,24,10,25],[30,24,15,46,16]],
  [[30,4,122,18,123],[28,13,46,32,47],[30,48,24,14,25],[30,42,15,32,16]],
  [[30,20,117,4,118],[28,40,47,7,48],[30,43,24,22,25],[30,10,15,67,16]],
  [[30,19,118,6,119],[28,18,47,31,48],[30,34,24,34,25],[30,20,15,61,16]],
];

/** Block layout for a version (1..40) and ECC level. */
export function eccBlocks(version: number, ecc: QrEcc): EccBlocks {
  const row = BLOCK_TABLE[version - 1][ECC_ORDER.indexOf(ecc)];
  return { ecPerBlock: row[0], g1: row[1], g1Data: row[2], g2: row[3], g2Data: row[4] };
}

/** Number of data codewords available for a version/ECC. */
export function dataCodewordCount(version: number, ecc: QrEcc): number {
  const b = eccBlocks(version, ecc);
  return b.g1 * b.g1Data + b.g2 * b.g2Data;
}

// ---------------------------------------------------------------------------
// Data encoding
// ---------------------------------------------------------------------------

export type QrMode = 'numeric' | 'alphanumeric' | 'byte';

const ALNUM = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ $%*+-./:';

/** Auto-select the tightest applicable encoding mode for `data`. */
export function qrMode(data: string): QrMode {
  if (/^\d+$/.test(data)) return 'numeric';
  if ([...data].every((c) => ALNUM.includes(c))) return 'alphanumeric';
  return 'byte';
}

/** Character-count-indicator bit width for a mode at a version. */
function countBits(mode: QrMode, version: number): number {
  if (version <= 9) return mode === 'numeric' ? 10 : mode === 'alphanumeric' ? 9 : 8;
  if (version <= 26) return mode === 'numeric' ? 12 : mode === 'alphanumeric' ? 11 : 16;
  return mode === 'numeric' ? 14 : mode === 'alphanumeric' ? 13 : 16;
}

const MODE_INDICATOR: Record<QrMode, number> = { numeric: 0b0001, alphanumeric: 0b0010, byte: 0b0100 };

class BitWriter {
  bits: number[] = [];
  put(value: number, len: number): void {
    for (let i = len - 1; i >= 0; i--) this.bits.push((value >> i) & 1);
  }
}

function utf8(data: string): number[] {
  return Array.from(new TextEncoder().encode(data));
}

/** Number of data-codeword bytes a payload needs (mode header + segment). */
function payloadBitLength(data: string, mode: QrMode, version: number): number {
  const header = 4 + countBits(mode, version);
  if (mode === 'numeric') {
    const groups = Math.floor(data.length / 3);
    const rem = data.length % 3;
    return header + groups * 10 + (rem === 2 ? 7 : rem === 1 ? 4 : 0);
  }
  if (mode === 'alphanumeric') {
    return header + Math.floor(data.length / 2) * 11 + (data.length % 2) * 6;
  }
  return header + utf8(data).length * 8;
}

/** Smallest version (1..40) whose data capacity fits `data` at `ecc`. */
export function chooseQrVersion(data: string, ecc: QrEcc): number {
  const mode = qrMode(data);
  for (let v = 1; v <= 40; v++) {
    if (payloadBitLength(data, mode, v) <= dataCodewordCount(v, ecc) * 8) return v;
  }
  throw new PdfParseError('QR: data too large for a single symbol');
}

/** Encode `data` into the version/ecc data codewords (mode header + segment +
 *  terminator + 0xEC/0x11 padding to capacity). */
export function encodeQrData(data: string, version: number, ecc: QrEcc): number[] {
  const mode = qrMode(data);
  const w = new BitWriter();
  w.put(MODE_INDICATOR[mode], 4);
  const count = mode === 'byte' ? utf8(data).length : data.length;
  w.put(count, countBits(mode, version));

  if (mode === 'numeric') {
    for (let i = 0; i < data.length; i += 3) {
      const chunk = data.slice(i, i + 3);
      w.put(parseInt(chunk, 10), chunk.length === 3 ? 10 : chunk.length === 2 ? 7 : 4);
    }
  } else if (mode === 'alphanumeric') {
    for (let i = 0; i < data.length; i += 2) {
      if (i + 1 < data.length) {
        w.put(ALNUM.indexOf(data[i]) * 45 + ALNUM.indexOf(data[i + 1]), 11);
      } else {
        w.put(ALNUM.indexOf(data[i]), 6);
      }
    }
  } else {
    for (const b of utf8(data)) w.put(b, 8);
  }

  const capacityBits = dataCodewordCount(version, ecc) * 8;
  if (w.bits.length > capacityBits)
    throw new PdfParseError('QR: data too large for the chosen version');
  // Terminator (up to 4 zero bits), then pad to a byte boundary.
  const term = Math.min(4, capacityBits - w.bits.length);
  w.put(0, term);
  while (w.bits.length % 8 !== 0) w.bits.push(0);

  const codewords: number[] = [];
  for (let i = 0; i < w.bits.length; i += 8) {
    let b = 0;
    for (let k = 0; k < 8; k++) b = (b << 1) | w.bits[i + k];
    codewords.push(b);
  }
  // Pad bytes alternate 0xEC, 0x11.
  const pad = [0xec, 0x11];
  for (let i = 0; codewords.length < capacityBits / 8; i++) codewords.push(pad[i % 2]);
  return codewords;
}

// ---------------------------------------------------------------------------
// Matrix layout + masking
// ---------------------------------------------------------------------------

/** Alignment-pattern center coordinates per version (1..40); combined pairwise. */
const ALIGN_POS: readonly (readonly number[])[] = [
  [], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34], [6, 22, 38], [6, 24, 42],
  [6, 26, 46], [6, 28, 50], [6, 30, 54], [6, 32, 58], [6, 34, 62], [6, 26, 46, 66],
  [6, 26, 48, 70], [6, 26, 50, 74], [6, 30, 54, 78], [6, 30, 56, 82], [6, 30, 58, 86],
  [6, 34, 62, 90], [6, 28, 50, 72, 94], [6, 26, 50, 74, 98], [6, 30, 54, 78, 102],
  [6, 28, 54, 80, 106], [6, 32, 58, 84, 110], [6, 30, 58, 86, 114], [6, 34, 62, 90, 118],
  [6, 26, 50, 74, 98, 122], [6, 30, 54, 78, 102, 126], [6, 26, 52, 78, 104, 130],
  [6, 30, 56, 82, 108, 134], [6, 34, 60, 86, 112, 138], [6, 30, 58, 86, 114, 142],
  [6, 34, 62, 90, 118, 146], [6, 30, 54, 78, 102, 126, 150], [6, 24, 50, 76, 102, 128, 154],
  [6, 28, 54, 80, 106, 132, 158], [6, 32, 58, 84, 110, 136, 162], [6, 26, 54, 82, 110, 138, 166],
  [6, 30, 58, 86, 114, 142, 170],
];

/** Format-info ECC-level indicator bits (ISO 18004 Table 12). */
const FORMAT_ECC_BITS: Record<QrEcc, number> = { L: 1, M: 0, Q: 3, H: 2 };

/** The 8 standard data-mask predicates; true means the module is inverted. */
export function qrMaskBit(mask: number, r: number, c: number): boolean {
  switch (mask) {
    case 0: return (r + c) % 2 === 0;
    case 1: return r % 2 === 0;
    case 2: return c % 3 === 0;
    case 3: return (r + c) % 3 === 0;
    case 4: return (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0;
    case 5: return ((r * c) % 2) + ((r * c) % 3) === 0;
    case 6: return (((r * c) % 2) + ((r * c) % 3)) % 2 === 0;
    case 7: return (((r + c) % 2) + ((r * c) % 3)) % 2 === 0;
    default: return false;
  }
}

/** Split data codewords into blocks and interleave data then EC (ISO 18004). */
function interleaveCodewords(dataCW: number[], version: number, ecc: QrEcc): number[] {
  const b = eccBlocks(version, ecc);
  const blocks: number[][] = [];
  const ecs: number[][] = [];
  let pos = 0;
  const addGroup = (count: number, len: number) => {
    for (let k = 0; k < count; k++) {
      const blk = dataCW.slice(pos, pos + len);
      pos += len;
      blocks.push(blk);
      ecs.push(rsEncode(blk, b.ecPerBlock));
    }
  };
  addGroup(b.g1, b.g1Data);
  addGroup(b.g2, b.g2Data);
  const out: number[] = [];
  const maxData = Math.max(b.g1Data, b.g2Data);
  for (let i = 0; i < maxData; i++)
    for (const blk of blocks) if (i < blk.length) out.push(blk[i]);
  for (let i = 0; i < b.ecPerBlock; i++)
    for (const e of ecs) out.push(e[i]);
  return out;
}

export interface QrEncodeResult {
  matrix: MatrixBarcode;
  version: number;
  ecc: QrEcc;
  mask: number;
  /** Final data+EC codeword stream in placement order. */
  codewords: number[];
  /** True where a module is a function/format/version module (not data). */
  reserved: boolean[];
}

/** Full QR encode: data → codewords → matrix with masking and format info. */
export function encodeQr(data: string, opts: QrOptions = {}): QrEncodeResult {
  const ecc = opts.ecc ?? 'M';
  if (!FORMAT_ECC_BITS.hasOwnProperty(ecc)) throw new TypeError(`QR: invalid ecc '${ecc}'`);
  const version = opts.version ?? chooseQrVersion(data, ecc);
  if (!Number.isInteger(version) || version < 1 || version > 40)
    throw new TypeError('QR: version must be an integer 1..40');

  const size = 17 + 4 * version;
  const dark = new Array<boolean>(size * size).fill(false);
  const reserved = new Array<boolean>(size * size).fill(false);
  const idx = (r: number, c: number) => r * size + c;
  const setFn = (r: number, c: number, v: boolean) => { dark[idx(r, c)] = v; reserved[idx(r, c)] = true; };

  // Timing patterns (drawn first; finders overwrite their overlap).
  for (let i = 0; i < size; i++) { setFn(6, i, i % 2 === 0); setFn(i, 6, i % 2 === 0); }

  // Finder patterns + separators (9x9 footprint each corner).
  const drawFinder = (cr: number, cc: number) => {
    for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) {
      const r = cr + dy, c = cc + dx;
      if (r < 0 || r >= size || c < 0 || c >= size) continue;
      const dist = Math.max(Math.abs(dx), Math.abs(dy));
      setFn(r, c, dist !== 2 && dist !== 4);
    }
  };
  drawFinder(3, 3); drawFinder(3, size - 4); drawFinder(size - 4, 3);

  // Alignment patterns (skip the three finder corners).
  const centers = ALIGN_POS[version - 1];
  for (const r of centers) for (const c of centers) {
    if ((r === 6 && c === 6) || (r === 6 && c === size - 7) || (r === size - 7 && c === 6)) continue;
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++)
      setFn(r + dy, c + dx, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
  }

  // Reserve the format-info area (values written after masking).
  const eachFormatModule = (cb: (r: number, c: number, bit: number) => void) => {
    for (let i = 0; i <= 5; i++) cb(i, 8, i);
    cb(7, 8, 6); cb(8, 8, 7); cb(8, 7, 8);
    for (let i = 9; i < 15; i++) cb(8, 14 - i, i);
    for (let i = 0; i < 8; i++) cb(8, size - 1 - i, i);
    for (let i = 8; i < 15; i++) cb(size - 15 + i, 8, i);
  };
  eachFormatModule((r, c) => { reserved[idx(r, c)] = true; });
  reserved[idx(size - 8, 8)] = true; // the always-dark module

  // Version info (v >= 7): static per version.
  if (version >= 7) {
    let rem = version;
    for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
    const vbits = (version << 12) | rem;
    for (let i = 0; i < 18; i++) {
      const bit = ((vbits >> i) & 1) === 1;
      const a = size - 11 + (i % 3), b = Math.floor(i / 3);
      setFn(b, a, bit); setFn(a, b, bit);
    }
  }

  // Codewords → bit stream → zigzag placement.
  const codewords = interleaveCodewords(encodeQrData(data, version, ecc), version, ecc);
  const allBits: number[] = [];
  for (const cw of codewords) for (let b = 7; b >= 0; b--) allBits.push((cw >> b) & 1);
  let bi = 0, col = size - 1, up = true;
  while (col > 0) {
    if (col === 6) col--;
    for (let i = 0; i < size; i++) {
      const row = up ? size - 1 - i : i;
      for (let c = 0; c < 2; c++) {
        const x = col - c;
        if (reserved[idx(row, x)]) continue;
        dark[idx(row, x)] = bi < allBits.length ? allBits[bi++] === 1 : false;
      }
    }
    col -= 2; up = !up;
  }

  const applyMask = (m: number) => {
    for (let r = 0; r < size; r++) for (let c = 0; c < size; c++)
      if (!reserved[idx(r, c)] && qrMaskBit(m, r, c)) dark[idx(r, c)] = !dark[idx(r, c)];
  };
  const drawFormat = (m: number) => {
    const dataBits = (FORMAT_ECC_BITS[ecc] << 3) | m;
    let rem = dataBits;
    for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
    const bits = ((dataBits << 10) | rem) ^ 0x5412;
    eachFormatModule((r, c, bit) => { dark[idx(r, c)] = ((bits >> bit) & 1) === 1; });
    dark[idx(size - 8, 8)] = true;
  };
  const penalty = () => scorePenalty(dark, size);

  // Choose the mask with the lowest penalty.
  let best = 0, bestScore = Infinity;
  for (let m = 0; m < 8; m++) {
    applyMask(m); drawFormat(m);
    const p = penalty();
    if (p < bestScore) { bestScore = p; best = m; }
    applyMask(m); // revert data modules
  }
  applyMask(best); drawFormat(best);

  return { matrix: { kind: 'matrix', size, dark }, version, ecc, mask: best, codewords, reserved };
}

/** Sum the four ISO 18004 mask-penalty rules over the whole symbol. */
function scorePenalty(dark: boolean[], size: number): number {
  const at = (r: number, c: number) => dark[r * size + c];
  let p = 0;
  // Rule 1: runs of >=5 same-color modules in each row/column.
  const runScore = (get: (i: number) => boolean) => {
    let s = 0, run = 1;
    for (let i = 1; i < size; i++) {
      if (get(i) === get(i - 1)) { run++; if (run === 5) s += 3; else if (run > 5) s += 1; }
      else run = 1;
    }
    return s;
  };
  for (let r = 0; r < size; r++) p += runScore((c) => at(r, c));
  for (let c = 0; c < size; c++) p += runScore((r) => at(r, c));
  // Rule 2: 2x2 blocks of one color.
  for (let r = 0; r < size - 1; r++) for (let c = 0; c < size - 1; c++) {
    const v = at(r, c);
    if (v === at(r, c + 1) && v === at(r + 1, c) && v === at(r + 1, c + 1)) p += 3;
  }
  // Rule 3: 1:1:3:1:1 finder-like pattern with 4 light modules on one side.
  const A = [true, false, true, true, true, false, true, false, false, false, false];
  const B = [false, false, false, false, true, false, true, true, true, false, true];
  const matches = (get: (i: number) => boolean, start: number, pat: boolean[]) => {
    for (let k = 0; k < 11; k++) if (get(start + k) !== pat[k]) return false;
    return true;
  };
  for (let r = 0; r < size; r++) for (let c = 0; c <= size - 11; c++) {
    if (matches((i) => at(r, i), c, A) || matches((i) => at(r, i), c, B)) p += 40;
  }
  for (let c = 0; c < size; c++) for (let r = 0; r <= size - 11; r++) {
    if (matches((i) => at(i, c), r, A) || matches((i) => at(i, c), r, B)) p += 40;
  }
  // Rule 4: deviation of dark-module proportion from 50%.
  let d = 0;
  for (const v of dark) if (v) d++;
  const ratio = (d / (size * size)) * 100;
  p += Math.floor(Math.abs(ratio - 50) / 5) * 10;
  return p;
}

/** Generate a QR barcode for `data`. `opts.ecc` defaults to 'M'; `opts.version`
 *  (1..40) forces a size, otherwise the smallest fitting version is chosen. */
export function makeQr(data: string, opts: QrOptions = {}): MatrixBarcode {
  if (typeof data !== 'string' || data.length === 0)
    throw new TypeError('makeQr: data must be a non-empty string');
  return encodeQr(data, opts).matrix;
}

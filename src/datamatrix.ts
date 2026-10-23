// Data Matrix ECC 200 (ISO/IEC 16022) encoding: ASCII and Base256
// encodation, Reed-Solomon over GF(256), the module placement of Annex F and
// the finder/clock borders. A pure leaf over datamatrixdata.js.
import type { MatrixBarcode } from './barcode.js';
import { DM_SYMBOLS, type DmSymbol } from './datamatrixdata.js';

export interface DataMatrixOptions {
  /** 'square' (default), 'rectangle', or 'any' -- the smallest symbol of
   *  either shape that holds the data. */
  shape?: 'square' | 'rectangle' | 'any';
}

const PAD = 129;
const UPPER_SHIFT = 235;
const LATCH_BASE256 = 231;
const ECI = 241;
const QUIET = 1;

// --- Encodation ----------------------------------------------------------------

/** The data as bytes plus the ECI it needs: Latin-1 when every character fits
 *  (the default interpretation), UTF-8 under ECI 26 otherwise. */
export function dataMatrixBytes(data: string): { bytes: Uint8Array; eci?: number } {
  let latin1 = true;
  for (let i = 0; i < data.length; i++) if (data.charCodeAt(i) > 0xff) { latin1 = false; break; }
  if (latin1) return { bytes: Uint8Array.from(data, (c) => c.charCodeAt(0)) };
  return { bytes: new TextEncoder().encode(data), eci: 26 };
}

const isDigit = (b: number) => b >= 0x30 && b <= 0x39;

/** ASCII encodation: a digit pair is one codeword (130 + value), a byte
 *  below 128 is value + 1, and one above is an upper shift and value - 127. */
function asciiCodewords(bytes: Uint8Array): number[] {
  const out: number[] = [];
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i];
    if (isDigit(b) && i + 1 < bytes.length && isDigit(bytes[i + 1])) {
      out.push(130 + (b - 0x30) * 10 + (bytes[i + 1] - 0x30));
      i++;
    } else if (b < 128) out.push(b + 1);
    else out.push(UPPER_SHIFT, b - 127);
  }
  return out;
}

/** Base 256 randomization: codeword at 1-based position `pos`. */
const rand255 = (value: number, pos: number) => (value + ((149 * pos) % 255) + 1) % 256;

/** Base256 encodation after `prefixLen` codewords: latch, a randomized length
 *  field of one or two codewords, then every byte randomized by position. */
function base256Codewords(bytes: Uint8Array, prefixLen: number): number[] {
  const n = bytes.length;
  const field = n <= 249 ? [n] : [Math.floor(n / 250) + 249, n % 250];
  const raw = [...field, ...bytes];
  const out = [LATCH_BASE256];
  raw.forEach((v, i) => out.push(rand255(v, prefixLen + 2 + i)));
  return out;
}

/** The data codewords before padding: an ECI if one is needed, then ASCII or
 *  Base256 encodation of the whole message, whichever is shorter. */
export function dataMatrixCodewords(data: string): number[] {
  const { bytes, eci } = dataMatrixBytes(data);
  return dataMatrixCodewordsOf(bytes, eci);
}

/** {@link dataMatrixCodewords} over bytes already chosen, with the ECI they need. */
export function dataMatrixCodewordsOf(bytes: Uint8Array, eci: number | undefined): number[] {
  const prefix = eci === undefined ? [] : [ECI, eci + 1];
  const ascii = asciiCodewords(bytes);
  const b256 = base256Codewords(bytes, prefix.length);
  return [...prefix, ...(b256.length < ascii.length ? b256 : ascii)];
}

/** Pad `cw` to `capacity`: one 129, then 253-state randomized pads. */
export function padDataMatrix(cw: number[], capacity: number): number[] {
  const out = cw.slice();
  if (out.length < capacity) out.push(PAD);
  while (out.length < capacity) {
    const pos = out.length + 1;
    let v = PAD + ((149 * pos) % 253) + 1;
    if (v > 254) v -= 254;
    out.push(v);
  }
  return out;
}

// --- Reed-Solomon over GF(256), polynomial 0x12D ----------------------------------

const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
{
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x12d;
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
}
const mul = (a: number, b: number) => (a === 0 || b === 0 ? 0 : EXP[LOG[a] + LOG[b]]);

/** g(x) = (x - a)(x - a^2)...(x - a^n), highest degree first. */
export function dataMatrixGenerator(n: number): number[] {
  let g = [1];
  for (let i = 1; i <= n; i++) {
    const next = new Array<number>(g.length + 1).fill(0);
    for (let j = 0; j < g.length; j++) {
      next[j] ^= g[j];
      next[j + 1] ^= mul(g[j], EXP[i]);
    }
    g = next;
  }
  return g;
}

/** The `n` error-correction codewords of one block. */
export function dataMatrixRs(data: readonly number[], n: number): number[] {
  const g = dataMatrixGenerator(n);
  const r = new Array<number>(n).fill(0);
  for (const d of data) {
    const f = d ^ r[0];
    for (let j = 0; j < n; j++) r[j] = (j + 1 < n ? r[j + 1] : 0) ^ mul(f, g[j + 1]);
  }
  return r;
}

/** The 144x144 symbol, the one size whose blocks differ in length. */
const SKEWED_DATA = 1558;
/** How far the 144x144 symbol rotates its error-correction blocks. */
const SKEW = 8;

/** Data plus interleaved error correction. Block b holds every `blocks`th
 *  codeword from b -- which also gives the 144x144 symbol its 8 blocks of 156
 *  and 2 of 155 -- and its EC codewords interleave the same way, except that
 *  the 144x144 symbol starts its EC run with block 8.
 *
 *  That rotation is NOT ISO/IEC 16022's literal order, and it is a decision:
 *  the readers in the field expect it. ZXing's decoder reads it
 *  (DataBlock.getDataBlocks' `specialVersion`) and fails the literal order
 *  with a checksum error; zint writes it by default and keeps the literal
 *  order behind an opt-in DM_ISO_144. libdmtx writes and reads the literal
 *  order, so it cannot read what we write at this one size. */
export function dataMatrixWithEc(data: readonly number[], sym: DmSymbol): number[] {
  const B = sym.blocks;
  const ecPer = sym.ec / B;
  const skew = sym.data === SKEWED_DATA ? SKEW : 0;
  const out = [...data, ...new Array<number>(sym.ec).fill(0)];
  for (let b = 0; b < B; b++) {
    const block: number[] = [];
    for (let i = b; i < data.length; i += B) block.push(data[i]);
    const column = (b + B - skew) % B;
    dataMatrixRs(block, ecPer).forEach((v, i) => { out[data.length + column + i * B] = v; });
  }
  return out;
}

// --- Placement (ISO/IEC 16022 Annex F) ------------------------------------------------

/** For each module of the nrow x ncol mapping matrix: codeword index * 8 +
 *  bit (0 = most significant), or -1 for a module the placement leaves to the
 *  fixed corner pattern. */
export function dataMatrixPlacement(nrow: number, ncol: number): Int32Array {
  const grid = new Int32Array(nrow * ncol).fill(-2); // -2: not yet placed
  const module = (row: number, col: number, cw: number, bit: number) => {
    if (row < 0) { row += nrow; col += 4 - ((nrow + 4) % 8); }
    if (col < 0) { col += ncol; row += 4 - ((ncol + 4) % 8); }
    grid[row * ncol + col] = cw * 8 + bit;
  };
  const utah = (row: number, col: number, cw: number) => {
    module(row - 2, col - 2, cw, 0); module(row - 2, col - 1, cw, 1);
    module(row - 1, col - 2, cw, 2); module(row - 1, col - 1, cw, 3);
    module(row - 1, col, cw, 4); module(row, col - 2, cw, 5);
    module(row, col - 1, cw, 6); module(row, col, cw, 7);
  };
  const corner = (cw: number, cells: readonly (readonly [number, number])[]) =>
    cells.forEach(([r, c], bit) => module(r, c, cw, bit));
  const unset = (row: number, col: number) => grid[row * ncol + col] === -2;

  let cw = 0;
  let row = 4, col = 0;
  do {
    if (row === nrow && col === 0)
      corner(cw++, [[nrow - 1, 0], [nrow - 1, 1], [nrow - 1, 2], [0, ncol - 2], [0, ncol - 1], [1, ncol - 1], [2, ncol - 1], [3, ncol - 1]]);
    if (row === nrow - 2 && col === 0 && ncol % 4 !== 0)
      corner(cw++, [[nrow - 3, 0], [nrow - 2, 0], [nrow - 1, 0], [0, ncol - 4], [0, ncol - 3], [0, ncol - 2], [0, ncol - 1], [1, ncol - 1]]);
    if (row === nrow - 2 && col === 0 && ncol % 8 === 4)
      corner(cw++, [[nrow - 3, 0], [nrow - 2, 0], [nrow - 1, 0], [0, ncol - 2], [0, ncol - 1], [1, ncol - 1], [2, ncol - 1], [3, ncol - 1]]);
    if (row === nrow + 4 && col === 2 && ncol % 8 === 0)
      corner(cw++, [[nrow - 1, 0], [nrow - 1, ncol - 1], [0, ncol - 3], [0, ncol - 2], [0, ncol - 1], [1, ncol - 3], [1, ncol - 2], [1, ncol - 1]]);
    do { // sweep up and to the right
      if (row < nrow && col >= 0 && unset(row, col)) utah(row, col, cw++);
      row -= 2; col += 2;
    } while (row >= 0 && col < ncol);
    row += 1; col += 3;
    do { // then down and to the left
      if (row >= 0 && col < ncol && unset(row, col)) utah(row, col, cw++);
      row += 2; col -= 2;
    } while (row < nrow && col >= 0);
    row += 3; col += 1;
  } while (row < nrow || col < ncol);
  for (let i = 0; i < grid.length; i++) if (grid[i] === -2) grid[i] = -1;
  return grid;
}

// --- Symbol ------------------------------------------------------------------------------

const hRegions = (s: DmSymbol) => (s.regions === 1 ? 1 : s.regions === 2 ? 2 : Math.sqrt(s.regions));
const vRegions = (s: DmSymbol) => (s.regions === 2 ? 1 : Math.sqrt(s.regions));

/** The smallest symbol of the requested shape holding `n` data codewords. */
export function chooseDataMatrixSymbol(n: number, shape: DataMatrixOptions['shape'] = 'square'): DmSymbol {
  for (const s of DM_SYMBOLS) {
    if (shape === 'square' && s.rect) continue;
    if (shape === 'rectangle' && !s.rect) continue;
    if (s.data >= n) return s;
  }
  throw new RangeError(`Data Matrix: ${n} data codewords exceed the largest ${shape === 'any' ? '' : `${shape} `}symbol`);
}

/** Generate a Data Matrix ECC 200 symbol for `data`. Strings of Latin-1
 *  characters are encoded as-is; any other string as UTF-8 under ECI 26. */
export function makeDataMatrix(data: string, opts: DataMatrixOptions = {}): MatrixBarcode {
  if (typeof data !== 'string' || data.length === 0)
    throw new TypeError('makeDataMatrix: data must be a non-empty string');
  const shape = opts.shape ?? 'square';
  if (shape !== 'square' && shape !== 'rectangle' && shape !== 'any')
    throw new RangeError(`Data Matrix shape must be 'square', 'rectangle' or 'any'`);
  const { bytes, eci } = dataMatrixBytes(data);
  return makeDataMatrixBytes(bytes, eci, opts);
}

/** {@link makeDataMatrix} over bytes already chosen, with the ECI they need:
 *  the path a paper-barcode field draws through, whose content may be
 *  compressed. Not exported from index.ts. */
export function makeDataMatrixBytes(bytes: Uint8Array, eci: number | undefined, opts: DataMatrixOptions = {}): MatrixBarcode {
  if (bytes.length === 0) throw new TypeError('makeDataMatrixBytes: bytes must be non-empty');
  const shape = opts.shape ?? 'square';
  if (shape !== 'square' && shape !== 'rectangle' && shape !== 'any')
    throw new RangeError(`Data Matrix shape must be 'square', 'rectangle' or 'any'`);
  const cw = dataMatrixCodewordsOf(bytes, eci);
  const sym = chooseDataMatrixSymbol(cw.length, shape);
  const all = dataMatrixWithEc(padDataMatrix(cw, sym.data), sym);

  const hr = hRegions(sym), vr = vRegions(sym);
  const nrow = sym.regionH * vr, ncol = sym.regionW * hr;
  const placement = dataMatrixPlacement(nrow, ncol);
  const bit = (r: number, c: number): boolean => {
    const p = placement[r * ncol + c];
    if (p < 0) // the fixed pattern in the unused bottom-right corner
      return (r === nrow - 1 && c === ncol - 1) || (r === nrow - 2 && c === ncol - 2);
    return ((all[p >> 3] >> (7 - (p & 7))) & 1) === 1;
  };

  const bw = sym.regionW + 2, bh = sym.regionH + 2;
  const width = hr * bw, height = vr * bh;
  const dark = new Array<boolean>(width * height).fill(false);
  for (let ry = 0; ry < vr; ry++) for (let rx = 0; rx < hr; rx++) {
    for (let i = 0; i < bh; i++) for (let j = 0; j < bw; j++) {
      let v: boolean;
      if (j === 0 || i === bh - 1) v = true; // solid L: left column and bottom row
      else if (i === 0) v = j % 2 === 0; // clock track along the top
      else if (j === bw - 1) v = i % 2 === 1; // clock track down the right
      else v = bit(ry * sym.regionH + i - 1, rx * sym.regionW + j - 1);
      dark[(ry * bh + i) * width + rx * bw + j] = v;
    }
  }
  return { kind: 'matrix', size: width, width, height, quiet: QUIET, dark };
}

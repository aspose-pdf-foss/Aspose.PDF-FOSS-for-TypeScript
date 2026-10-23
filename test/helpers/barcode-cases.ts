// The PDF417 and Data Matrix cases ZXing decoded (scripts/gen-barcode-goldens.ts)
// and test/barcode-zxing.test.ts re-encodes. Shared so the two cannot drift.
import { createHash } from 'node:crypto';
import type { MatrixBarcode } from '../../src/barcode.js';
import { makePdf417, type Pdf417Options } from '../../src/pdf417.js';
import { makeDataMatrix, type DataMatrixOptions } from '../../src/datamatrix.js';
import { DM_SYMBOLS } from '../../src/datamatrixdata.js';

export type BarcodeCase =
  | { name: string; kind: 'pdf417'; data: string; opts: Pdf417Options }
  | { name: string; kind: 'datamatrix'; data: string; opts: DataMatrixOptions };

/** Letters only: one ASCII codeword each, never a digit pair. */
const letters = (n: number) => Array.from({ length: n }, (_, i) => String.fromCharCode(97 + (i % 26))).join('');

const pdf = (name: string, data: string, opts: Pdf417Options = {}): BarcodeCase =>
  ({ name: `pdf417/${name}`, kind: 'pdf417', data, opts });
const dm = (name: string, data: string, opts: DataMatrixOptions = {}): BarcodeCase =>
  ({ name: `datamatrix/${name}`, kind: 'datamatrix', data, opts });

export const BARCODE_CASES: readonly BarcodeCase[] = [
  // PDF417 compaction paths.
  pdf('text-alpha', 'HELLO WORLD'),
  pdf('text-lower-and-shift', 'hello World again'),
  pdf('text-mixed', 'Order #42: 3+4=7 & 10%'),
  pdf('text-punct-shift', 'a{b}c[d]e;f<g>h?'),
  pdf('text-punct-latch', 'MIX 12;<>@[] then text'),
  pdf('text-odd-pad', 'ABC'),
  pdf('numeric-13', '1234567890123'),
  pdf('numeric-44-boundary', '9'.repeat(44) + '1'.repeat(45)),
  pdf('numeric-then-text', '00000000000000000000 then words'),
  pdf('byte-6-multiple', '\u0001\u0002\u0003\u0004\u0005\u0006\u0007\u0008\u000e\u000f\u0010\u0011'),
  pdf('byte-remainder', '\u0001\u0002\u0003\u0004\u0005\u0006\u0007'),
  pdf('byte-high-latin1', 'café naïve ÿ'),
  pdf('mixed-segments', 'ID\u0001\u0002\u0003 1234567890123456 name=Ann'),
  pdf('eci-utf8', 'Grüße Привет 你好'),
  pdf('one-column', 'NARROW SYMBOL', { columns: 1 }),
  pdf('thirty-columns', 'WIDE SYMBOL', { columns: 30 }),
  ...Array.from({ length: 9 }, (_, l) => pdf(`ec-level-${l}`, `EC LEVEL ${l} test payload`, { ecLevel: l })),
  pdf('large', letters(1200)),
  pdf('near-capacity', letters(1780)),
  // Data Matrix: every symbol size, filled exactly and with padding.
  ...DM_SYMBOLS.map((s) => dm(`full-${s.data}${s.rect ? 'r' : ''}`, letters(s.data),
    { shape: s.rect ? 'rectangle' : 'square' })),
  ...DM_SYMBOLS.filter((s) => s.data > 3).map((s) => dm(`padded-${s.data}${s.rect ? 'r' : ''}`,
    letters(s.data - 3), { shape: s.rect ? 'rectangle' : 'square' })),
  dm('digit-pairs', '0123456789012345'),
  dm('odd-digit', '12345'),
  dm('upper-shift', 'café ÿ'),
  dm('base256-short', 'éèêëöüä'),
  dm('base256-two-byte-length', Array.from({ length: 300 }, (_, i) => String.fromCharCode(0x80 + (i % 128))).join('')),
  dm('eci-utf8', 'Привет мир'),
  dm('any-shape', 'ANY', { shape: 'any' }),
];

/** Short ASCII inputs ZXing's own Data Matrix WRITER also encodes in ASCII,
 *  padding included, so its modules must equal ours bit for bit. ZXing's
 *  decoder stops at the first pad codeword and cannot see the randomized pads
 *  after it; these are what pin them. */
export const DM_WRITER_CASES: readonly string[] = [
  '1', '12', '123', '1234', '123456', '1234567', '12345678901', 'A', 'a', 'A1', '!', '1a2b',
  '9876543210123456789012345678',
];

/** SHA-256 of a module grid as matrixHash spells it. */
export function bitsHash(w: number, h: number, rowHeight: number, bits: string): string {
  return createHash('sha256').update(`${w}x${h}x${rowHeight}:`).update(bits).digest('hex');
}

export function matrixOf(c: BarcodeCase): MatrixBarcode {
  return c.kind === 'pdf417' ? makePdf417(c.data, c.opts) : makeDataMatrix(c.data, c.opts);
}

/** SHA-256 of a symbol's dimensions and modules: what ZXing was handed. */
export function matrixHash(m: MatrixBarcode): string {
  const w = m.width ?? m.size, h = m.height ?? m.size;
  return bitsHash(w, h, m.rowHeight ?? 1, m.dark.map((b) => (b ? '1' : '0')).join(''));
}

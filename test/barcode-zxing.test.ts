import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { BARCODE_CASES, DM_WRITER_CASES, matrixOf, matrixHash } from './helpers/barcode-cases.js';
import {
  makePdf417, pdf417Generator, pdf417Codewords, layoutPdf417,
} from '../src/pdf417.js';
import { PDF417_PATTERNS, PDF417_START, PDF417_STOP } from '../src/pdf417data.js';
import { makeDataMatrix, dataMatrixCodewords } from '../src/datamatrix.js';
import { DM_SYMBOLS } from '../src/datamatrixdata.js';

const goldens = JSON.parse(readFileSync(new URL('./fixtures/barcode-zxing/goldens.json', import.meta.url), 'utf8')) as {
  goldens: { name: string; sha256: string; text: string; errorsCorrected: number }[];
  writerGoldens: { data: string; sha256: string }[];
};
const ecJson = JSON.parse(readFileSync(new URL('./fixtures/barcode-zxing/pdf417-ec.json', import.meta.url), 'utf8')) as {
  coefficients: number[][];
};

describe('PDF417 and Data Matrix against ZXing 3.5.3', () => {
  it('has a golden for every case and a case for every golden', () => {
    expect(goldens.goldens.map((g) => g.name)).toEqual(BARCODE_CASES.map((c) => c.name));
  });

  // The goldens record what ZXing decoded from EXACTLY this matrix, with zero
  // errors corrected. A changed hash means the encoder changed and ZXing must
  // be asked again (npm run gen:barcode-goldens) -- this is a fence, not a
  // golden to refresh by hand.
  for (const c of BARCODE_CASES) {
    it(c.name, () => {
      const g = goldens.goldens.find((x) => x.name === c.name)!;
      expect(matrixHash(matrixOf(c))).toBe(g.sha256);
      expect(g.text).toBe(c.data);
      expect(g.errorsCorrected).toBe(0);
    });
  }

  // ZXing's decoder stops at the first pad codeword, so the randomized pads
  // after it are invisible to every decode golden above. ZXing's own WRITER
  // draws these inputs in ASCII too, so its modules must equal ours.
  it('draws the modules the ZXing Data Matrix writer draws', () => {
    expect(goldens.writerGoldens.map((g) => g.data)).toEqual([...DM_WRITER_CASES]);
    for (const g of goldens.writerGoldens) expect(matrixHash(makeDataMatrix(g.data)), g.data).toBe(g.sha256);
  });

  it('reaches every Data Matrix symbol size', () => {
    const sizes = new Set(BARCODE_CASES.filter((c) => c.kind === 'datamatrix').map((c) => {
      const m = matrixOf(c);
      return `${m.width}x${m.height}`;
    }));
    expect(sizes.size).toBe(DM_SYMBOLS.length);
  });
});

describe('PDF417 tables and arithmetic', () => {
  it('computes the generator ZXing tabulates, at every level', () => {
    for (let level = 0; level <= 8; level++) {
      const g = pdf417Generator(1 << (level + 1));
      expect(g[0]).toBe(1);
      expect(g.slice(1).reverse()).toEqual(ecJson.coefficients[level]);
    }
  });

  // ISO/IEC 15438 defines a codeword's cluster from its own bar widths:
  // (b1 - b2 + b3 - b4 + 9) mod 9 is 0, 3 or 6. That is a property of the
  // patterns that no table transcription supplies, so it checks the table.
  it('every pattern is 4 bars and 4 spaces in 17 modules, in its own cluster', () => {
    PDF417_PATTERNS.forEach((cluster, k) => {
      expect(cluster.length).toBe(929);
      expect(new Set(cluster).size).toBe(929);
      for (const p of cluster) {
        const runs: number[] = [];
        let prev = -1;
        for (let i = 16; i >= 0; i--) {
          const bit = (p >> i) & 1;
          if (bit === prev) runs[runs.length - 1]++;
          else { runs.push(1); prev = bit; }
        }
        expect(p >> 16).toBe(1); // starts with a bar
        expect(runs.length).toBe(8);
        expect(runs.every((r) => r <= 6)).toBe(true);
        expect((runs[0] - runs[2] + runs[4] - runs[6] + 9) % 9).toBe(k * 3);
      }
    });
    expect(PDF417_START >> 16).toBe(1);
    expect(PDF417_STOP >> 17).toBe(1);
  });

  it('a symbol row is 17 modules per codeword plus start, indicators and stop', () => {
    const m = makePdf417('ABC', { columns: 4 });
    expect(m.width).toBe(17 * 4 + 69);
    expect(m.rowHeight).toBe(3);
    expect(m.dark.length).toBe(m.width! * m.height!);
  });

  it('starts in text compaction and latches only where needed', () => {
    expect(pdf417Codewords('AB')).toEqual([1]); // A=0, B=1
    expect(pdf417Codewords('1234567890123')[0]).toBe(902);
    // 12 digits stay in text compaction: numeric costs a latch and a latch
    // back, so ISO/IEC 15438's run of 13 is where it starts paying. Every
    // threshold decodes, so no ZXing golden can see this one.
    expect(pdf417Codewords('123456789012')).not.toContain(902);
    expect(pdf417Codewords('\u0001\u0002')[0]).toBe(901);
    expect(pdf417Codewords('\u0001\u0002\u0003\u0004\u0005\u0006')[0]).toBe(924);
    expect(pdf417Codewords('Ж').slice(0, 2)).toEqual([927, 26]);
  });

  it('lowers the default EC level only as far as the data needs', () => {
    expect(layoutPdf417('HELLO').ecLevel).toBe(2);
    // 1780 letters are 891 text codewords: level 5's 64 would pass 928.
    const { ecLevel, codewords } = layoutPdf417('a'.repeat(1780));
    expect(ecLevel).toBe(4);
    expect(codewords[0]).toBeLessThanOrEqual(928); // the length descriptor
  });

  it('refuses what it cannot represent', () => {
    expect(() => makePdf417('')).toThrow(TypeError);
    expect(() => makePdf417('x', { ecLevel: 9 })).toThrow(RangeError);
    expect(() => makePdf417('x', { columns: 31 })).toThrow(RangeError);
    expect(() => makePdf417('\u0001'.repeat(1200), { ecLevel: 8 })).toThrow(RangeError);
  });
});

describe('Data Matrix tables and arithmetic', () => {
  // The published ECC 200 sizes, which ZXing's region-based table does not
  // state directly: a regression in deriving width and height from it is
  // visible here and nowhere else.
  it('derives the 24 square and 6 rectangular symbol sizes', () => {
    const got = DM_SYMBOLS.map((s) => {
      const m = makeDataMatrix('a'.repeat(s.data), { shape: s.rect ? 'rectangle' : 'square' });
      return `${m.height}x${m.width}`;
    });
    expect(got.sort()).toEqual([
      '10x10', '12x12', '14x14', '16x16', '18x18', '20x20', '22x22', '24x24', '26x26', '32x32',
      '36x36', '40x40', '44x44', '48x48', '52x52', '64x64', '72x72', '80x80', '88x88', '96x96',
      '104x104', '120x120', '132x132', '144x144',
      '8x18', '8x32', '12x26', '12x36', '16x36', '16x48',
    ].sort());
  });

  it('pairs digits and shifts bytes above 127', () => {
    expect(dataMatrixCodewords('12')).toEqual([142]);
    expect(dataMatrixCodewords('1')).toEqual([50]);
    expect(dataMatrixCodewords('é')).toEqual([235, 0xe9 - 127]);
  });

  it('refuses what it cannot represent', () => {
    expect(() => makeDataMatrix('')).toThrow(TypeError);
    expect(() => makeDataMatrix('x', { shape: 'round' as never })).toThrow(RangeError);
    expect(() => makeDataMatrix('a'.repeat(1559))).toThrow(RangeError);
    expect(() => makeDataMatrix('a'.repeat(50), { shape: 'rectangle' })).toThrow(RangeError);
  });
});

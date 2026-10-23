import { describe, expect, it } from 'vitest';
import { Document } from '../src/document.js';
import { PageFormat } from '../src/pageformat.js';
import { makePdf417 } from '../src/pdf417.js';
import { makeDataMatrix } from '../src/datamatrix.js';
import type { MatrixBarcode } from '../src/barcode.js';
import { decodePng } from './helpers/decode-png.js';

/** Render a page holding one symbol at 2pt a module, at scale 2, and
 *  read back, at every module's centre, whether it is dark. That checks the
 *  whole placement -- orientation, row height, quiet zone -- against the
 *  model, independently of how the content stream was spelled. */
function readBack(m: MatrixBarcode, render: 'vector' | 'raster'): boolean[] {
  const cols = m.width ?? m.size, rows = m.height ?? m.size, rh = m.rowHeight ?? 1, q = m.quiet ?? 4;
  const unit = 2; // points per module
  const w = (cols + 2 * q) * unit, h = (rows * rh + 2 * q) * unit;
  const doc = Document.New();
  const { page } = doc.AddPage(PageFormat.custom(w + 20, h + 20));
  page.AddBarcode(KIND.get(m)!, [10, 10, w, h], { render });
  const png = decodePng(page.ToImage({ scale: 2 }));
  const px = 2;
  const out: boolean[] = [];
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
    const x = Math.floor((10 + (q + c + 0.5) * unit) * px);
    const yTop = 10 + (q + (r + 0.5) * rh) * unit; // image y runs down from the page top
    const y = Math.floor(yTop * px);
    const i = (y * png.width + x) * png.channels;
    out.push(png.data[i] < 128);
  }
  return out;
}

const KIND = new Map<MatrixBarcode, Parameters<import('../src/page.js').Page['AddBarcode']>[0]>();

function pdf(data: string, opts = {}) {
  const m = makePdf417(data, opts);
  KIND.set(m, { type: 'pdf417', data, ...opts });
  return m;
}
function dm(data: string, opts = {}) {
  const m = makeDataMatrix(data, opts);
  KIND.set(m, { type: 'datamatrix', data, ...opts });
  return m;
}

describe('Page.AddBarcode: PDF417 and Data Matrix', () => {
  for (const render of ['vector', 'raster'] as const) {
    it(`draws a PDF417 module for module (${render})`, () => {
      const m = pdf('PDF417 placement check 0123456789', { columns: 4 });
      expect(readBack(m, render)).toEqual(m.dark);
    });
    it(`draws a square Data Matrix module for module (${render})`, () => {
      const m = dm('Data Matrix placement');
      expect(readBack(m, render)).toEqual(m.dark);
    });
    it(`draws a rectangular Data Matrix module for module (${render})`, () => {
      const m = dm('RECT 1234', { shape: 'rectangle' });
      expect(m.width).not.toBe(m.height);
      expect(readBack(m, render)).toEqual(m.dark);
    });
  }

  it('keeps a PDF417 row three modules tall in a rect of the wrong shape', () => {
    const doc = Document.New();
    const { page } = doc.AddPage(PageFormat.A4);
    page.AddBarcode({ type: 'pdf417', data: 'ROW HEIGHT', columns: 2 }, [50, 500, 400, 400], { quietZone: false });
    const content = new TextDecoder('latin1').decode(page.Contents);
    const rects = [...content.matchAll(/([\d.]+) ([\d.]+) ([\d.]+) ([\d.]+) re/g)].map((x) => [+x[3], +x[4]]);
    expect(rects.length).toBeGreaterThan(0);
    for (const [w, h] of rects) expect(h / w).toBeCloseTo(3, 6);
  });

  it('rejects bad options before drawing anything', () => {
    const doc = Document.New();
    const { page } = doc.AddPage(PageFormat.A4);
    const before = new TextDecoder('latin1').decode(page.Contents);
    expect(() => page.AddBarcode({ type: 'pdf417', data: 'x', ecLevel: 12 }, [0, 0, 100, 100])).toThrow(RangeError);
    expect(() => page.AddBarcode({ type: 'datamatrix', data: '' }, [0, 0, 100, 100])).toThrow(TypeError);
    expect(new TextDecoder('latin1').decode(page.Contents)).toBe(before);
  });
});

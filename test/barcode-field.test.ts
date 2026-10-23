import { describe, expect, it } from 'vitest';
import { Document } from '../src/document.js';
import { PageFormat } from '../src/pageformat.js';
import { isArray, isDict, isName, isRef, type PdfDict } from '../src/types.js';
import { parseBarcodeScript, readPmd } from '../src/pmd.js';
import { makePdf417, type Pdf417Options } from '../src/pdf417.js';
import { matrixLayout } from '../src/barcodeplace.js';
import { createSplitField } from '../src/formcreate.js';
import { drawBarcodeAppearance } from '../src/paperbarcode.js';
import type { MatrixBarcode } from '../src/barcode.js';
import type { TextField } from '../src/formfield.js';
import { decodePng } from './helpers/decode-png.js';

const RECT: [number, number, number, number] = [20, 20, 380, 180];

function form(): Document {
  const doc = Document.New();
  doc.AddPage(PageFormat.custom(400, 300));
  doc.Form.AddTextField({ name: 'a', page: 1, rect: [10, 260, 100, 280] });
  doc.Form.AddTextField({ name: 'b', page: 1, rect: [110, 260, 200, 280] });
  return doc;
}
const acroOf = (doc: Document) => doc.resolve(doc.catalog().get('AcroForm')) as PdfDict;
const coNums = (doc: Document) => {
  const co = doc.resolve(acroOf(doc).get('CO'));
  return isArray(co) ? co.filter(isRef).map((r) => r.num) : [];
};
const calc = (_doc: Document, f: TextField) => f.Actions.calculate;
const scriptOf = (f: TextField): string => { const c = f.Actions.calculate; if (c?.type !== 'javascript') throw new Error('no script'); return c.script; };

/** Render page 1 at scale 2 and read, at every module's centre, whether it is
 *  dark — the drawn symbol, checked against a model, independently of how the
 *  content stream spelled it. */
function readBack(doc: Document, m: MatrixBarcode, rect: [number, number, number, number]): boolean[] {
  const [x1, y1, x2, y2] = rect;
  const { q, cols, rows, rh, u, x0, yTop } = matrixLayout(m, x1, y1, x2 - x1, y2 - y1, true);
  const png = decodePng(doc.Pages[0].ToImage({ scale: 2 }));
  const pageH = doc.Pages[0].MediaBox[3];
  const out: boolean[] = [];
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
    const px = Math.floor((x0 + (q + c + 0.5) * u) * 2);
    const py = Math.floor((pageH - (yTop - (q + (r + 0.5) * rh) * u)) * 2);
    out.push(png.data[(py * png.width + px) * png.channels] < 128);
  }
  return out;
}

describe('Form.AddBarcodeField', () => {
  it('defaults to a PDF417 field carrying Acrobat\'s tab-delimited script over the fields that exist', () => {
    const doc = form();
    const bc = doc.Form.AddBarcodeField({ name: 'bc', page: 1, rect: RECT });
    expect(bc.Type).toBe('text');
    expect(readPmd(doc.resolve(bc.Dict.get('PMD')) as PdfDict, (o) => doc.resolve(o))?.symbology).toBe('PDF417');
    const c = calc(doc, bc);
    expect(c?.type).toBe('javascript');
    expect(parseBarcodeScript(scriptOf(bc)))
      .toEqual({ encoding: 'tab', params: { fields: ['a', 'b'], fieldNames: false } });
    const ref = (acroOf(doc).get('Fields') as unknown[]).at(-1);
    expect(isRef(ref as never) && coNums(doc).includes((ref as { num: number }).num)).toBe(true);
  });

  it('carries the fields named, with a header row when asked', () => {
    const doc = form();
    const bc = doc.Form.AddBarcodeField({ name: 'bc', page: 1, rect: RECT, fields: ['b'], fieldNames: true });
    expect(parseBarcodeScript(scriptOf(bc)))
      .toEqual({ encoding: 'tab', params: { fields: ['b'], fieldNames: true } });
  });

  for (const encoding of ['json', 'value'] as const) {
    it(`writes no script and no /CO entry for encoding '${encoding}'`, () => {
      const doc = form();
      const bc = doc.Form.AddBarcodeField({ name: 'bc', page: 1, rect: RECT, encoding });
      expect(calc(doc, bc)).toBeUndefined();
      expect(coNums(doc)).toEqual([]);
    });
  }

  it('names the symbology in /PMD', () => {
    const doc = form();
    const qr = doc.Form.AddBarcodeField({ name: 'q', page: 1, rect: RECT, symbology: 'qr', ecc: 'H' });
    const dm = doc.Form.AddBarcodeField({ name: 'd', page: 1, rect: RECT, symbology: 'datamatrix' });
    const r = (o: unknown) => doc.resolve(o as never);
    expect(readPmd(r(qr.Dict.get('PMD')) as PdfDict, r)).toMatchObject({ symbology: 'QRCode', ecc: 3 });
    expect(readPmd(r(dm.Dict.get('PMD')) as PdfDict, r)).toMatchObject({ symbology: 'DataMatrix' });
  });

  it('draws a value-encoded field\'s own value module for module', () => {
    const doc = form();
    const opts: Pdf417Options = { ecLevel: 2 };
    doc.Form.AddBarcodeField({ name: 'bc', page: 1, rect: RECT, encoding: 'value', value: 'ID-42', ...opts });
    const m = makePdf417('ID-42', opts);
    expect(readBack(doc, m, RECT)).toEqual(m.dark);
  });

  it('draws every widget of a field with /Kids', () => {
    const doc = form();
    const rects: [number, number, number, number][] = [[10, 10, 190, 120], [210, 10, 390, 120]];
    const c = createSplitField(doc, { name: 'k' }, rects.map((rect) => ({ page: 1, rect, shown: null })), { ft: 'Tx' });
    drawBarcodeAppearance(doc, c.dict, { symbology: 'PDF417', ecc: 2 }, 'KIDS');
    const kids = (c.dict.get('Kids') as unknown[]).map((k) => doc.resolve(k as never) as PdfDict);
    expect(kids).toHaveLength(2);
    const m = makePdf417('KIDS', { ecLevel: 2 });
    for (let i = 0; i < 2; i++) {
      const ap = doc.resolve(kids[i].get('AP') as never);
      expect(isDict(ap)).toBe(true);
      expect(readBack(doc, m, rects[i])).toEqual(m.dark);
    }
  });

  it('draws nothing for empty content', () => {
    const doc = form();
    const bc = doc.Form.AddBarcodeField({ name: 'bc', page: 1, rect: RECT });
    const ap = doc.resolve(bc.Dict.get('AP') as never) as PdfDict;
    const n = doc.resolve(ap.get('N') as never) as { raw: Uint8Array };
    expect(new TextDecoder().decode(n.raw)).not.toMatch(/ re/);
  });

  it('rejects a bad argument and leaves the document byte-identical', () => {
    const doc = form();
    const before = doc.Save();
    const bad: Record<string, unknown>[] = [
      { symbology: 'code39' }, { ecLevel: 9 }, { columns: 31 }, { ecc: 'X', symbology: 'qr' },
      { fields: ['nope'] }, { fieldNames: true, encoding: 'json' }, { value: 'x' },
      { encoding: 'csv' }, { compress: 'yes' },
    ];
    for (const b of bad)
      expect(() => doc.Form.AddBarcodeField({ name: 'bc', page: 1, rect: RECT, ...b } as never), JSON.stringify(b)).toThrow();
    expect(doc.Save()).toEqual(before);
  });

  it('Page.AddBarcodeField forwards with its own page', () => {
    const doc = form();
    const bc = doc.Pages[0].AddBarcodeField({ name: 'bc', rect: RECT, encoding: 'value', value: 'P' });
    expect(isName(doc.resolve(bc.Dict.get('FT') as never))).toBe(true);
  });
});

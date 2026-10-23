// The final whole-branch review of 2srz.4: one case per finding, each red
// before its fix.
import { describe, expect, it } from 'vitest';
import { Document } from '../src/document.js';
import { PageFormat } from '../src/pageformat.js';
import { LoadLimits } from '../src/loadlimits.js';
import { isDict, name, type PdfDict, type PdfObject } from '../src/types.js';
import { buildTabScript, encodePmd, parseBarcodeScript, readPmd } from '../src/pmd.js';
import { createSplitField } from '../src/formcreate.js';
import { drawBarcodeAppearance } from '../src/paperbarcode.js';
import { buildClassicPdf } from './helpers/build-pdf.js';
import { decodePng } from './helpers/decode-png.js';
import { buildSigner, type TestSigner } from './helpers/build-signer.js';
import type { CmsSigner } from '../src/cms.js';

const signerOf = (t: TestSigner): CmsSigner => ({ certificate: t.certificate, privateKey: t.privateKey });
const RECT: [number, number, number, number] = [200, 20, 590, 280];

function form(): Document {
  const doc = Document.New();
  doc.AddPage(PageFormat.custom(600, 300));
  doc.Form.AddTextField({ name: 'name', page: 1, rect: [10, 260, 100, 280], value: 'Ann' });
  doc.Form.AddTextField({ name: 'zip', page: 1, rect: [10, 230, 100, 250], value: '007' });
  return doc;
}
const valueOf = (doc: Document, n: string) => doc.Form.Get(n)!.Value;
const reopen = (doc: Document) => Document.Open(doc.Save());
/** Dark pixels of page 1 rendered with NO annotations: what flattening baked
 *  into the page content, the drawn modules of a baked symbol. */
function baked(doc: Document): number {
  const png = decodePng(doc.Pages[0].ToImage({ annotations: false }));
  let n = 0;
  for (let i = 0; i < png.width * png.height; i++) if (png.data[i * png.channels] < 128) n++;
  return n;
}
const pmdOf = (doc: Document, n: string) => readPmd(doc.resolve(doc.Form.Get(n)!.Dict.get('PMD')) as PdfDict, (o) => doc.resolve(o));

describe('C1: flatten and render show the current barcode', () => {
  it('FlattenForm before Save bakes the current content', () => {
    const doc = form();
    doc.Form.AddBarcodeField({ name: 'bc', page: 1, rect: RECT });
    doc.FlattenForm();
    const twin = form();
    twin.Form.AddBarcodeField({ name: 'bc', page: 1, rect: RECT });
    twin.Form.RefreshBarcodes();
    twin.FlattenForm();
    expect(baked(reopen(doc))).toBeGreaterThan(5000);
    expect(reopen(doc).Pages[0].ToImage()).toEqual(reopen(twin).Pages[0].ToImage());
  });

  it('Field.Flatten of the barcode bakes the current content', () => {
    const doc = form();
    doc.Form.AddBarcodeField({ name: 'bc', page: 1, rect: RECT });
    doc.Form.Get('bc')!.Flatten();
    expect(baked(reopen(doc))).toBeGreaterThan(5000);
  });

  it('page.FlattenAnnotations bakes the current content', () => {
    const doc = form();
    doc.Form.AddBarcodeField({ name: 'bc', page: 1, rect: RECT });
    doc.Pages[0].FlattenAnnotations();
    expect(baked(reopen(doc))).toBeGreaterThan(5000);
  });

  it('Annotation.Flatten of the barcode widget bakes the current content', () => {
    const doc = form();
    doc.Form.AddBarcodeField({ name: 'bc', page: 1, rect: RECT });
    const w = doc.Pages[0].Annotations.find((a) => a.Dict === doc.Form.Get('bc')!.Dict)!;
    w.Flatten();
    expect(baked(reopen(doc))).toBeGreaterThan(5000);
  });

  it('ToImage before Save draws what Save would write, and changes nothing', () => {
    const doc = form();
    doc.Form.AddBarcodeField({ name: 'bc', page: 1, rect: RECT });
    doc.Form.Get('name')!.Value = 'Bob';
    const twin = form();
    twin.Form.AddBarcodeField({ name: 'bc', page: 1, rect: RECT });
    twin.Form.Get('name')!.Value = 'Bob';
    const stale = doc.Pages[0].ToImage();
    twin.Form.RefreshBarcodes();
    expect(stale).toEqual(twin.Pages[0].ToImage());
    // Nothing was written: /V is still the stale one.
    expect(valueOf(doc, 'bc')).toBe('');
  });

  it('rendering an untouched reopened barcode leaves Sign appending', async () => {
    const doc = Document.Open(buildClassicPdf(1));
    doc.Form.AddTextField({ name: 't', page: 1, rect: [10, 10, 60, 20], value: 'one' });
    doc.Form.AddBarcodeField({ name: 'bc', page: 1, rect: [10, 30, 300, 120] });
    doc.Form.AddSignatureField({ page: 1, rect: [10, 160, 60, 190], name: 'S' });
    const saved = doc.Save();
    const again = Document.Open(saved);
    again.Pages[0].ToImage();
    again.Pages[0].ToSvg();
    await again.Sign(signerOf(buildSigner()), { fieldName: 'S' });
    expect(again.Save().subarray(0, saved.length)).toEqual(saved);
  });
});

describe('I1/I3: the default carried list', () => {
  it('leaves out a signature field, so the barcode still fills', () => {
    const doc = form();
    doc.Form.AddSignatureField({ page: 1, rect: [10, 160, 60, 190], name: 'S' });
    doc.Form.AddBarcodeField({ name: 'bc', page: 1, rect: RECT });
    expect(doc.Form.RefreshBarcodes().notRecomputed).toEqual([]);
    expect(valueOf(doc, 'bc')).toBe('Ann\t7');
  });

  it('still reports a signature field a script names explicitly', () => {
    const doc = form();
    doc.Form.AddSignatureField({ page: 1, rect: [10, 160, 60, 190], name: 'S' });
    doc.Form.AddBarcodeField({ name: 'bc', page: 1, rect: RECT, fields: ['name', 'S'] });
    expect(doc.Form.RefreshBarcodes().notRecomputed).toEqual([{ field: 'bc', reason: 'unprobed-value', detail: 'S' }]);
  });

  it('a second barcode does not carry the first', () => {
    const doc = form();
    doc.Form.AddBarcodeField({ name: 'bc1', page: 1, rect: [200, 20, 590, 140] });
    doc.Form.AddBarcodeField({ name: 'bc2', page: 1, rect: [200, 150, 590, 280], symbology: 'qr' });
    doc.Form.RefreshBarcodes();
    expect(valueOf(doc, 'bc1')).toBe('Ann\t7');
    expect(valueOf(doc, 'bc2')).toBe('Ann\t7');
  });
});

describe('I2: a value too large for the symbol', () => {
  it('Field.Value throws RangeError and leaves /V as it was', () => {
    const doc = form();
    const bc = doc.Form.AddBarcodeField({ name: 'bc', page: 1, rect: RECT, encoding: 'value', symbology: 'qr', value: 'hi' });
    expect(() => { bc.Value = 'x'.repeat(5000); }).toThrow(RangeError);
    expect(valueOf(doc, 'bc')).toBe('hi');
  });

  it('a /V the symbol cannot hold is reported too-large even when nothing else changed', () => {
    const doc = form();
    const bc = doc.Form.AddBarcodeField({ name: 'bc', page: 1, rect: RECT, encoding: 'value', symbology: 'qr', value: 'hi' });
    bc.Dict.set('V', { kind: 'string', bytes: new TextEncoder().encode('x'.repeat(5000)) });
    expect(doc.Form.RefreshBarcodes()).toEqual({ updated: [], notRecomputed: [{ field: 'bc', reason: 'too-large' }] });
  });
});

describe('Minor findings', () => {
  it('M1: a script carrying every field never carries the barcode itself', () => {
    const doc = form();
    const bc = doc.Form.AddBarcodeField({ name: 'bc', page: 1, rect: RECT });
    bc.SetActions({ calculate: { type: 'javascript', script: buildTabScript({ fields: null, fieldNames: false }) } });
    doc.Form.RefreshBarcodes();
    expect(valueOf(doc, 'bc')).toBe('Ann\t7');
    expect(doc.Form.RefreshBarcodes().updated).toEqual([]);
    expect(valueOf(doc, 'bc')).toBe('Ann\t7');
  });

  it('M2: readPmd drops an entry outside its range', () => {
    const r = (o: PdfObject | undefined) => o ?? null;
    const pmd = (sym: string, extra: [string, PdfObject][]) =>
      new Map<string, PdfObject>([['Symbology', name(sym)], ...extra]);
    expect(readPmd(pmd('PDF417', [['ECC', 9]]), r)?.ecc).toBeUndefined();
    expect(readPmd(pmd('PDF417', [['ECC', 8]]), r)?.ecc).toBe(8);
    expect(readPmd(pmd('QRCode', [['ECC', 4]]), r)?.ecc).toBeUndefined();
    expect(readPmd(pmd('DataMatrix', [['ECC', 1]]), r)?.ecc).toBeUndefined();
    expect(readPmd(pmd('PDF417', [['nCodeWordCol', 31]]), r)?.nCodeWordCol).toBeUndefined();
    expect(readPmd(pmd('PDF417', [['nCodeWordCol', 2.5]]), r)?.nCodeWordCol).toBeUndefined();
    expect(readPmd(pmd('PDF417', [['nCodeWordCol', 30]]), r)?.nCodeWordCol).toBe(30);
    expect(() => encodePmd({ symbology: 'PDF417', nCodeWordCol: 31 })).toThrow(RangeError);
  });

  it('M2: an out-of-range /ECC in a document is not reported too-large', () => {
    const doc = form();
    const bc = doc.Form.AddBarcodeField({ name: 'bc', page: 1, rect: RECT });
    (doc.resolve(bc.Dict.get('PMD')) as PdfDict).set('ECC', 9);
    expect(doc.Form.RefreshBarcodes()).toEqual({ updated: ['bc'], notRecomputed: [] });
    expect(pmdOf(doc, 'bc')?.ecc).toBeUndefined();
  });

  it('M3: a checkbox with /Opt is not read through its state name', () => {
    const doc = form();
    const cb = doc.Form.AddCheckbox({ name: 'ok', page: 1, rect: [10, 200, 30, 220], checked: true });
    cb.Dict.set('Opt', [{ kind: 'string', bytes: new TextEncoder().encode('Yes please') }]);
    doc.Form.AddBarcodeField({ name: 'bc', page: 1, rect: RECT });
    expect(doc.Form.RefreshBarcodes().notRecomputed).toEqual([{ field: 'bc', reason: 'unprobed-value', detail: 'ok' }]);
  });

  it('M4: Save of a form with no barcode does not build the field tree', () => {
    const doc = Document.New();
    doc.AddPage(PageFormat.custom(200, 200));
    doc.Form.AddTextField({ name: 'a.b.c.d.e.f.g', page: 1, rect: [10, 10, 60, 20] });
    const bytes = doc.Save();
    const tight = Document.Open(bytes, { limits: LoadLimits.defaults.with({ maxNestingDepth: 3 }) });
    expect(() => tight.Save()).not.toThrow();
  });

  it('M6: a newline after return, or spaced unary operators, is not the template', () => {
    const s = buildTabScript({ fields: ['a'], fieldNames: false });
    expect(parseBarcodeScript(s)?.encoding).toBe('tab');
    expect(s).toContain('return strNames');
    expect(parseBarcodeScript(s.replace('return strNames', 'return\n strNames'))).toBeUndefined();
    expect(parseBarcodeScript(s.replace('return strValues', 'return\n        strValues'))).toBeUndefined();
    expect(s).toContain('++i');
    expect(parseBarcodeScript(s.replace('++i', '+ +i'))).toBeUndefined();
  });

  it('M8: a barcode with /Kids where one widget lost its appearance is redrawn', () => {
    const doc = form();
    const rects: [number, number, number, number][] = [[200, 20, 390, 140], [400, 20, 590, 140]];
    const c = createSplitField(doc, { name: 'k' }, rects.map((rect) => ({ page: 1, rect, shown: null })), { ft: 'Tx' });
    const pmd = { symbology: 'PDF417' as const };
    c.dict.set('PMD', encodePmd(pmd));
    c.dict.set('V', { kind: 'string', bytes: new TextEncoder().encode('KIDS') });
    drawBarcodeAppearance(doc, c.dict, pmd, 'KIDS');
    expect(doc.Form.RefreshBarcodes()).toEqual({ updated: [], notRecomputed: [] });
    const kids = (c.dict.get('Kids') as unknown[]).map((k) => doc.resolve(k as never) as PdfDict);
    kids[1].delete('AP');
    expect(doc.Form.RefreshBarcodes()).toEqual({ updated: ['k'], notRecomputed: [] });
    expect(isDict(doc.resolve(kids[1].get('AP') as never))).toBe(true);
  });

  it('M8: a json barcode given a non-barcode calculate script is reported, not recomputed', () => {
    const doc = form();
    const bc = doc.Form.AddBarcodeField({ name: 'bc', page: 1, rect: RECT, encoding: 'json', fields: ['zip'] });
    doc.Form.RefreshBarcodes();
    const before = valueOf(doc, 'bc');
    bc.SetActions({ calculate: { type: 'javascript', script: 'event.value = 1;' } });
    doc.Form.Get('zip')!.Value = '9';
    expect(doc.Form.RefreshBarcodes().notRecomputed).toEqual([{ field: 'bc', reason: 'unrecognised-script' }]);
    expect(valueOf(doc, 'bc')).toBe(before);
  });
});

import { describe, expect, it } from 'vitest';
import { Document } from '../src/document.js';
import { PageFormat } from '../src/pageformat.js';
import { isDict, type PdfDict } from '../src/types.js';
import { buildTabScript } from '../src/pmd.js';
import { buildClassicPdf } from './helpers/build-pdf.js';
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

describe('paper barcode refresh', () => {
  it('fills a new tab barcode on Save, as Acrobat would', () => {
    const doc = form();
    doc.Form.AddBarcodeField({ name: 'bc', page: 1, rect: RECT });
    expect(valueOf(reopen(doc), 'bc')).toBe('Ann\t7');
  });

  it('follows a value change made after the barcode was created', () => {
    const doc = form();
    doc.Form.AddBarcodeField({ name: 'bc', page: 1, rect: RECT });
    doc.Form.Get('name')!.Value = 'Bob';
    const r = doc.Form.RefreshBarcodes();
    expect(r.updated).toEqual(['bc']);
    expect(valueOf(reopen(doc), 'bc')).toBe('Bob\t7');
  });

  it('changes nothing when the content already matches: byte-identical, and Sign still appends', async () => {
    const doc = Document.Open(buildClassicPdf(1));
    doc.Form.AddTextField({ name: 't', page: 1, rect: [10, 10, 60, 20], value: 'one' });
    doc.Form.AddBarcodeField({ name: 'bc', page: 1, rect: [10, 30, 300, 120] });
    doc.Form.AddSignatureField({ page: 1, rect: [10, 160, 60, 190], name: 'S' });
    const saved = doc.Save();
    const again = Document.Open(saved);
    expect(again.Form.RefreshBarcodes()).toEqual({ updated: [], notRecomputed: [] });
    expect(again.Save()).toEqual(saved);
    await again.Sign(signerOf(buildSigner()), { fieldName: 'S' });
    expect(again.Save().subarray(0, saved.length)).toEqual(saved);
  });

  it('carries the remaining fields when a listed one no longer exists', () => {
    const doc = form();
    doc.Form.AddBarcodeField({ name: 'bc', page: 1, rect: RECT, fields: ['name', 'zip'] });
    doc.Form.RemoveField('zip');
    const r = doc.Form.RefreshBarcodes();
    expect(r.notRecomputed).toEqual([]);
    expect(valueOf(doc, 'bc')).toBe('Ann');
  });

  it('keeps content too large for the symbol, reports it, and does not throw on Save', () => {
    const doc = form();
    doc.Form.AddBarcodeField({ name: 'bc', page: 1, rect: RECT, ecLevel: 8 });
    const before = valueOf(reopen(doc), 'bc');
    doc.Form.Get('name')!.Value = 'x'.repeat(5000);
    expect(() => doc.Save()).not.toThrow();
    const r = doc.Form.RefreshBarcodes();
    expect(r.notRecomputed).toEqual([{ field: 'bc', reason: 'too-large' }]);
    expect(valueOf(doc, 'bc')).toBe(before);
  });

  it('joins a value holding a tab or a newline raw, then folds the line break as the field does', () => {
    const doc = Document.New();
    doc.AddPage(PageFormat.custom(600, 300));
    doc.Form.AddTextField({ name: 'a', page: 1, rect: [10, 260, 100, 280], value: 'x\ty', multiline: true });
    doc.Form.AddTextField({ name: 'b', page: 1, rect: [10, 230, 100, 250], value: 'p\r\nq', multiline: true });
    const bc = doc.Form.AddBarcodeField({ name: 'bc', page: 1, rect: RECT, fieldNames: true });
    doc.Form.RefreshBarcodes();
    expect(bc.Value).toBe('a\tb x\ty\tp q');
    bc.Multiline = true;
    doc.Form.RefreshBarcodes();
    expect(bc.Value).toBe('a\tb\rx\ty\tp\rq');
  });

  it('reports Acrobat\'s XML encoding and an unrecognised script, keeping their content', () => {
    const doc = form();
    const x = doc.Form.AddBarcodeField({ name: 'x', page: 1, rect: RECT, encoding: 'value', value: 'kept-x' });
    x.SetActions({ calculate: { type: 'javascript', script: 'event.value = strXMLData({oDoc: this});' } });
    const u = doc.Form.AddBarcodeField({ name: 'u', page: 1, rect: RECT, encoding: 'value', value: 'kept-u' });
    u.SetActions({ calculate: { type: 'javascript', script: 'event.value = "hand written";' } });
    const r = doc.Form.RefreshBarcodes();
    expect(r.notRecomputed).toEqual([
      { field: 'u', reason: 'unrecognised-script' },
      { field: 'x', reason: 'xml-encoding' },
    ]);
    expect(valueOf(doc, 'x')).toBe('kept-x');
    expect(valueOf(doc, 'u')).toBe('kept-u');
  });

  it('reports a carried field whose value shape no probe settled', () => {
    const doc = form();
    doc.Form.AddSignatureField({ page: 1, rect: [10, 160, 60, 190], name: 'S' });
    const bc = doc.Form.AddBarcodeField({ name: 'bc', page: 1, rect: RECT, encoding: 'value', value: 'kept' });
    bc.SetActions({ calculate: { type: 'javascript', script: buildTabScript({ fields: ['name', 'S'], fieldNames: false }) } });
    expect(doc.Form.RefreshBarcodes().notRecomputed).toEqual([{ field: 'bc', reason: 'unprobed-value', detail: 'S' }]);
    expect(valueOf(doc, 'bc')).toBe('kept');
  });

  for (const [label, add] of [
    ['a multi-select list with one item selected', (d: Document) =>
      d.Form.AddListBox({ name: 'q', page: 1, rect: [10, 160, 100, 190], options: ['A', 'B'], value: 'A', multiSelect: true })],
    ['a choice whose display differs from its export', (d: Document) =>
      d.Form.AddComboBox({ name: 'q', page: 1, rect: [10, 160, 100, 190], options: [{ export: 'a', display: 'Apple' }], value: 'a' })],
    ['a radio group naming its exports in /Opt', (d: Document) => {
      d.Form.AddRadioGroup({ name: 'q', selected: 'x', options: [{ page: 1, rect: [10, 160, 30, 180], export: 'x' }] });
      d.Form.Get('q')!.Dict.set('Opt', [{ kind: 'string', bytes: new TextEncoder().encode('x') }]);
    }],
  ] as const) {
    it(`reports ${label}, which no probe settled`, () => {
      const doc = form();
      add(doc);
      doc.Form.AddBarcodeField({ name: 'bc', page: 1, rect: RECT });
      expect(doc.Form.RefreshBarcodes().notRecomputed).toEqual([{ field: 'bc', reason: 'unprobed-value', detail: 'q' }]);
    });
  }

  it('honours strXclField: every field (aFields null) but the excluded one', () => {
    const doc = form();
    const bc = doc.Form.AddBarcodeField({ name: 'bc', page: 1, rect: RECT, encoding: 'value', value: 'old' });
    bc.SetActions({ calculate: { type: 'javascript', script: buildTabScript({ fields: null, fieldNames: false, exclude: 'bc' }) } });
    doc.Form.RefreshBarcodes();
    expect(bc.Value).toBe('Ann\t7');
  });

  it('Sign refreshes a barcode changed since the last save, inside the signed bytes', async () => {
    const doc = Document.Open(buildClassicPdf(1));
    doc.Form.AddTextField({ name: 't', page: 1, rect: [10, 10, 60, 20], value: 'one' });
    doc.Form.AddBarcodeField({ name: 'bc', page: 1, rect: [10, 30, 300, 120] });
    doc.Form.AddSignatureField({ page: 1, rect: [10, 160, 60, 190], name: 'S' });
    const p = Document.Open(doc.Save());
    p.Form.Get('t')!.Value = 'two';
    await p.Sign(signerOf(buildSigner()), { fieldName: 'S' });
    const signed = Document.Open(p.Save());
    expect(valueOf(signed, 'bc')).toBe('two');
    expect((await signed.VerifySignatures())[0].integrity).toBe('valid');
  });

  it('does not rewrite a barcode a signature locks', async () => {
    const doc = Document.Open(buildClassicPdf(1));
    doc.Form.AddTextField({ name: 't', page: 1, rect: [10, 10, 60, 20], value: 'one' });
    doc.Form.AddBarcodeField({ name: 'bc', page: 1, rect: [10, 30, 300, 120] });
    doc.Form.AddSignatureField({ page: 1, rect: [10, 160, 60, 190], name: 'S', lock: { action: 'include', fields: ['bc'] } });
    const p = Document.Open(doc.Save());
    await p.Sign(signerOf(buildSigner()), { fieldName: 'S' });
    const signed = Document.Open(p.Save());
    signed.Form.Get('t')!.Value = 'two';
    expect(signed.Form.RefreshBarcodes().notRecomputed).toEqual([{ field: 'bc', reason: 'locked' }]);
    expect(valueOf(signed, 'bc')).toBe('one');
  });

  it('does not rewrite a barcode under a no-changes certification', async () => {
    const doc = Document.Open(buildClassicPdf(1));
    doc.Form.AddTextField({ name: 't', page: 1, rect: [10, 10, 60, 20], value: 'one' });
    doc.Form.AddBarcodeField({ name: 'bc', page: 1, rect: [10, 30, 300, 120] });
    doc.Form.AddSignatureField({ page: 1, rect: [10, 160, 60, 190], name: 'S' });
    const p = Document.Open(doc.Save());
    await p.Certify(signerOf(buildSigner()), { fieldName: 'S', permissions: 'no-changes' });
    const signed = Document.Open(p.Save());
    signed.Form.Get('t')!.Value = 'two';
    expect(signed.Form.RefreshBarcodes().notRecomputed).toEqual([{ field: 'bc', reason: 'locked' }]);
  });

  it('json encoding holds ExportJson of the carried fields and round-trips through ImportJson', () => {
    const doc = form();
    doc.Form.AddBarcodeField({ name: 'bc', page: 1, rect: RECT, encoding: 'json', fields: ['zip'] });
    doc.Form.Get('zip')!.Value = '42';
    const out = reopen(doc);
    const json = valueOf(out, 'bc') as string;
    expect(JSON.parse(json).fields.map((f: { name: string }) => f.name)).toEqual(['zip']);
    const target = form();
    target.ImportJson(json);
    expect(valueOf(target, 'zip')).toBe('42');
  });

  it('value encoding draws the field\'s own value as a barcode when it is set', () => {
    const doc = form();
    const bc = doc.Form.AddBarcodeField({ name: 'bc', page: 1, rect: RECT, encoding: 'value', value: 'A' });
    bc.Value = 'B';
    const ap = doc.resolve(bc.Dict.get('AP')!) as PdfDict;
    const n = doc.resolve(ap.get('N')!) as { raw: Uint8Array };
    expect(new TextDecoder().decode(n.raw)).toMatch(/ re\n/);
    expect(new TextDecoder().decode(n.raw)).not.toMatch(/Tj/);
  });

  it('Recalculate leaves a barcode script to the barcode refresh', () => {
    const doc = form();
    doc.Form.AddBarcodeField({ name: 'bc', page: 1, rect: RECT });
    expect(doc.Form.Recalculate().unrecognised).toEqual([]);
  });

  it('an untouched opened document reports nothing and has every widget drawn', () => {
    const doc = reopen((() => { const d = form(); d.Form.AddBarcodeField({ name: 'bc', page: 1, rect: RECT }); return d; })());
    expect(doc.Form.RefreshBarcodes()).toEqual({ updated: [], notRecomputed: [] });
    const w = doc.Form.Get('bc')!.Dict;
    expect(isDict(doc.resolve(w.get('AP')!))).toBe(true);
  });
});

import { describe, expect, it, vi } from 'vitest';
import { Document, LoadLimits, PageFormat, UnsupportedFeatureError } from '../src/index.js';
import { appendIncrementalUpdate } from '../src/incremental.js';
import { readDssCerts } from '../src/dss.js';
import { ref, type PdfObject } from '../src/types.js';
import { readXref } from '../src/xref.js';
import { buildClassicPdf, buildXrefStreamPdf } from './helpers/build-pdf.js';
import { prevChainPdf } from './helpers/build-hostile-pdf.js';
import { buildSigner } from './helpers/build-signer.js';

const graph = (doc: Document) => ({ trailer: doc.trailer, objects: [...doc.objectEntries()] });
const signer = buildSigner({ type: 'ec' });
const deepSections = LoadLimits.defaults.maxXrefSections! + 1;

describe('incremental save layout preflight', () => {
  it.each(['Save', 'SaveAsync'] as const)('%s appends under a relaxed xref limit', async (method) => {
    const limits = LoadLimits.defaults.with({ maxXrefSections: deepSections + 1 });
    const base = prevChainPdf(deepSections);
    const doc = Document.Open(base, { limits });
    doc.SetMetadata({ title: 'Incremental title' });

    const bytes = await doc[method]({ incremental: true });
    expect(bytes.subarray(0, base.length)).toEqual(base);
    const reopened = Document.Open(bytes, { limits });
    expect(reopened.Revisions).toHaveLength(deepSections + 1);
    expect(reopened.GetMetadata().title).toBe('Incremental title');
  });

  it.each(['Save', 'SaveAsync'] as const)('%s leaves the live graph untouched under a tightened xref limit', async (method) => {
    const draft = Document.New(PageFormat.A4);
    draft.Form.AddTextField({ name: 'text', page: 1, rect: [20, 200, 100, 240], value: 'before' });
    draft.Form.AddBarcodeField({ name: 'barcode', page: 1, rect: [20, 30, 300, 150] });
    const bytes = appendIncrementalUpdate(draft.Save(), { objects: new Map() });
    const doc = Document.Open(bytes);
    doc.Form.Get('text')!.Value = 'after';
    expect(doc.Form.Get('barcode')!.Value).toBe('before');
    doc.loadLimits = doc.loadLimits.with({ maxXrefSections: 1 });
    const before = structuredClone(graph(doc));

    await expect(async () => doc[method]({ incremental: true })).rejects.toMatchObject({
      name: 'ResourceLimitError', limit: 'maxXrefSections',
    });
    expect(doc.Form.Get('barcode')!.Value).toBe('before');
    expect(graph(doc)).toEqual(before);
  });

  it('reuses the checked xref stream and its decode budget for the baseline', () => {
    const doc = Document.Open(buildXrefStreamPdf(), {
      limits: LoadLimits.defaults.with({ maxTotalDecodedBytes: 24 }),
    });
    doc.SetMetadata({ title: 'Checked once' });
    expect(Document.Open(doc.Save({ incremental: true })).GetMetadata().title).toBe('Checked once');
  });

  it('preserves live Root and Info overrides, including their generations', () => {
    const source = new TextDecoder().decode(buildClassicPdf(1, { info: { Title: 'Stored title' } }));
    const bytes = new TextEncoder().encode(source
      .replace('5 0 obj', '5 3 obj')
      .replace(/(\d{10}) 00000 n (?=\ntrailer)/, '$1 00003 n ')
      .replace('/Info 5 0 R', '/Info 5 3 R'));
    const doc = Document.Open(bytes);
    const root = doc.allocObject(new Map(doc.catalog()));
    doc.trailer.set('Root', root);
    // The previous trailer's /Info was at generation 3. Use that same live
    // reference explicitly and update its object alongside the new catalog.
    doc.trailer.set('Info', ref(5, 3));
    doc.SetMetadata({ title: 'Live title' });

    const saved = doc.Save({ incremental: true });
    expect(saved.subarray(0, bytes.length)).toEqual(bytes);
    const { trailer } = readXref(saved);
    expect(trailer.get('Root')).toEqual(root);
    expect(trailer.get('Info')).toEqual(ref(5, 3));
    expect(Document.Open(saved).GetMetadata().title).toBe('Live title');
  });

  it('uses a live Info object that was absent from the stored layout', () => {
    const doc = Document.Open(buildClassicPdf(1));
    const title: PdfObject = { kind: 'string', bytes: new TextEncoder().encode('New info') };
    const info = doc.allocObject(new Map<string, PdfObject>([['Title', title]]));
    doc.trailer.set('Info', info);
    const saved = doc.Save({ incremental: true });
    expect(readXref(saved).trailer.get('Info')).toEqual(info);
    expect(Document.Open(saved).GetMetadata().title).toBe('New info');
  });

  it('can replace an inline stored catalog with its live indirect reference', () => {
    const source = new TextDecoder().decode(buildClassicPdf(1));
    const bytes = new TextEncoder().encode(source.replace('/Root 1 0 R', '/Root << /Type /Catalog /Pages 2 0 R >>'));
    const doc = Document.Open(bytes);
    expect(doc.recovery).toBeUndefined();
    expect(() => doc.Save({ incremental: true })).toThrow(/\/Root is not an indirect reference/);

    doc.trailer.set('Root', ref(1));
    const saved = doc.Save({ incremental: true });
    expect(saved.subarray(0, bytes.length)).toEqual(bytes);
    expect(readXref(saved).trailer.get('Root')).toEqual(ref(1));
    expect(Document.Open(saved).Pages).toHaveLength(1);
  });
});

describe('DSS append layout preflight', () => {
  it('appends under a relaxed xref limit and preserves the signed prefix', async () => {
    const limits = LoadLimits.defaults.with({ maxXrefSections: deepSections + 2 });
    const doc = Document.Open(prevChainPdf(deepSections), { limits });
    await doc.Sign(signer);
    const signed = doc.Save().slice();

    await doc.AddValidationData();

    const saved = doc.Save();
    expect(saved.subarray(0, signed.length)).toEqual(signed);
    const reopened = Document.Open(saved, { limits });
    expect(reopened.Revisions).toHaveLength(deepSections + 2);
    expect(readDssCerts(reopened)).toEqual([signer.certificate]);
    expect(await reopened.VerifySignatures()).toMatchObject([{ integrity: 'valid', signature: 'valid' }]);
  });

  it('keeps the graph and signed bytes when the active xref limit refuses the base', async () => {
    const doc = Document.Open(buildClassicPdf(1));
    await doc.Sign(signer);
    const signed = doc.Save().slice();
    doc.loadLimits = doc.loadLimits.with({ maxXrefSections: 1 });
    const before = structuredClone(graph(doc));
    const getOCSP = vi.fn(() => undefined);

    await expect(doc.AddValidationData({ getOCSP })).rejects.toMatchObject({
      name: 'ResourceLimitError', limit: 'maxXrefSections',
    });
    expect(getOCSP).not.toHaveBeenCalled();
    expect(graph(doc)).toEqual(before);
    expect(doc.Save()).toEqual(signed);
  });

  it('refuses a pending signing rewrite before allocating DSS objects', async () => {
    const doc = Document.New(PageFormat.A4);
    doc.allocObject(42); // An unreachable object discarded by the signing rewrite.
    await doc.Sign(signer);
    const signed = doc.Save().slice();
    const before = structuredClone(graph(doc));
    const getOCSP = vi.fn(() => undefined);

    await expect(doc.AddValidationData({ getOCSP })).rejects.toThrow(UnsupportedFeatureError);
    expect(getOCSP).not.toHaveBeenCalled();
    expect(graph(doc)).toEqual(before);
    expect(doc.Save()).toEqual(signed);

    const reopened = Document.Open(signed);
    await reopened.AddValidationData();
    expect(reopened.Save().subarray(0, signed.length)).toEqual(signed);
  });
});

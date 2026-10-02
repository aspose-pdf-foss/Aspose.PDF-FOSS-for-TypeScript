import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { PageFormat } from '../src/pageformat.js';
import { UnsupportedFeatureError } from '../src/errors.js';
import { isDict, isRef, type PdfObject } from '../src/types.js';
import { fakeOcr } from './helpers/fake-ocr.js';
import type { OcrSpan } from '../src/ocr.js';

const span = (text: string): OcrSpan[] => [{ text, box: [20, 30, 100, 50] }];
const blank = (pages = 1): Document => {
  const doc = Document.New(PageFormat.custom(200, 100));
  for (let i = 1; i < pages; i++) doc.AddPage(PageFormat.custom(200, 100));
  return doc;
};
const fontRefOf = (doc: Document, n: number): PdfObject | undefined => {
  const fonts = doc.resolve(doc.Pages[n - 1]!.Resources?.get('Font'));
  return isDict(fonts) ? [...fonts.values()][0] : undefined;
};

describe('MakeSearchable (3ywf.3)', () => {
  it('writes the recognized text so GetText and Search find it', async () => {
    const doc = blank();
    const r = await doc.MakeSearchable(fakeOcr(() => span('Hello world')));
    expect(r.pages).toEqual([{ page: 1, status: 'ocr', spans: 1, dropped: 0 }]);
    expect(doc.Pages[0]!.GetText()).toContain('Hello world');
    expect(doc.Pages[0]!.Search('world')).toHaveLength(1);
  });

  it('renders at dpi/72 and hands the engine the real pixel size', async () => {
    const doc = blank();
    const eng = fakeOcr(() => []);
    await doc.MakeSearchable(eng, { dpi: 144 });
    expect(eng.calls[0]).toMatchObject({ mediaType: 'image/png', width: 400, height: 200 });
  });

  it('skips a page that already has text, reports it, and does not call the engine', async () => {
    const doc = blank(2);
    doc.Pages[0]!.AddText('Existing', 50, 50);
    const eng = fakeOcr(() => span('New'));
    const r = await doc.MakeSearchable(eng);
    expect(r.pages[0]).toEqual({ page: 1, status: 'skipped', reason: 'has-text', spans: 0, dropped: 0 });
    expect(r.pages[1]!.status).toBe('ocr');
    expect(eng.calls).toHaveLength(1);
  });

  it('OCRs a page with text anyway under force', async () => {
    const doc = blank();
    doc.Pages[0]!.AddText('Existing', 50, 50);
    const r = await doc.MakeSearchable(fakeOcr(() => span('Added')), { force: true });
    expect(r.pages[0]!.status).toBe('ocr');
    expect(doc.Pages[0]!.GetText()).toContain('Added');
  });

  it('limits the run to the selected pages', async () => {
    const doc = blank(3);
    const eng = fakeOcr(() => span('x'));
    const r = await doc.MakeSearchable(eng, { pages: '2' });
    expect(r.pages.map((p) => p.page)).toEqual([2]);
    expect(eng.calls).toHaveLength(1);
  });

  it('records a failing page and carries on', async () => {
    const doc = blank(3);
    const eng = fakeOcr((n) => { if (n === 2) throw new Error('engine down'); return span(`p${n}`); });
    const r = await doc.MakeSearchable(eng);
    expect(r.pages.map((p) => p.status)).toEqual(['ocr', 'failed', 'ocr']);
    expect(r.pages[1]!.reason).toBe('engine down');
    expect(doc.Pages[2]!.GetText()).toContain('p3');
  });

  it('fails a page whose engine returns something that is not spans', async () => {
    const doc = blank();
    const r = await doc.MakeSearchable(fakeOcr(() => 'nope' as never));
    expect(r.pages[0]!.status).toBe('failed');
  });

  it('fails a page past 65,535 distinct characters and the next page still works (Review Focus 4)', async () => {
    const doc = blank(2);
    let big = '';
    // Plane-15 private use: NFC-stable. U+1xxxx is not — NFC decomposes the
    // musical symbols into characters already present, leaving 65,519 distinct.
    for (let cp = 0xF0000; cp < 0xF0000 + 65_536; cp++) big += String.fromCodePoint(cp);
    const r = await doc.MakeSearchable(fakeOcr((n) => (n === 1 ? span(big) : span('AB'))));
    expect(r.pages.map((p) => p.status)).toEqual(['failed', 'ocr']);
    expect(doc.Pages[1]!.GetText()).toContain('AB');
  });

  it('shares ONE font object across pages', async () => {
    const doc = blank(2);
    await doc.MakeSearchable(fakeOcr((n) => span(`page ${n}`)));
    const a = fontRefOf(doc, 1); const b = fontRefOf(doc, 2);
    expect(isRef(a) && isRef(b) && a.num === b.num).toBe(true);
  });

  it('allocates no font when nothing is written', async () => {
    const doc = blank();
    await doc.MakeSearchable(fakeOcr(() => []));
    expect(new TextDecoder('latin1').decode(doc.Save())).not.toContain('GlyphLessFont');
  });

  it('stops on abort, keeping the finished page and its complete /ToUnicode', async () => {
    const doc = blank(2);
    const ctrl = new AbortController();
    const eng = fakeOcr((n) => { if (n === 1) ctrl.abort(new Error('stop')); return span(`p${n}`); });
    await expect(doc.MakeSearchable(eng, { signal: ctrl.signal })).rejects.toThrow('stop');
    expect(eng.calls).toHaveLength(1);
    expect(doc.Pages[0]!.GetText()).toContain('p1');
  });

  it('reports progress after each page', async () => {
    const doc = blank(2);
    const seen: number[] = [];
    await doc.MakeSearchable(fakeOcr(() => span('x')), { onPage: (p) => seen.push(p.page) });
    expect(seen).toEqual([1, 2]);
  });

  it('refuses a document with signature fields', async () => {
    const doc = blank();
    doc.Form.AddSignatureField({ page: 1, rect: [10, 10, 60, 30], name: 'S' });
    await expect(doc.MakeSearchable(fakeOcr(() => span('x')))).rejects.toBeInstanceOf(UnsupportedFeatureError);
  });

  it('validates its arguments', async () => {
    const doc = blank();
    await expect(doc.MakeSearchable({} as never)).rejects.toThrow(TypeError);
    await expect(doc.MakeSearchable(fakeOcr(() => []), { dpi: 0 })).rejects.toThrow(RangeError);
    await expect(doc.MakeSearchable(fakeOcr(() => []), { dpi: 1201 })).rejects.toThrow(RangeError);
    await expect(doc.MakeSearchable(fakeOcr(() => []), { pages: [9] })).rejects.toThrow(RangeError);
  });
});

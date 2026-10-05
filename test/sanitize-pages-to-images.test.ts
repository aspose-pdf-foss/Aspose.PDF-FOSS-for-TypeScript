import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { PageFormat } from '../src/pageformat.js';
import { renderPageRgb } from '../src/raster.js';
import { isDict, isName, isStream, type PdfDict, type PdfObject } from '../src/types.js';
import type { OcrEngine } from '../src/ocr.js';

const latin1 = (b: Uint8Array) => new TextDecoder('latin1').decode(b);

/** Two pages of text, one rotated, with a white-on-white phrase that a reader
 *  never sees and every text extractor finds. */
function textDoc(): Document {
  const doc = Document.New();
  doc.AddPage(PageFormat.A4);
  doc.AddPage(PageFormat.A4);
  const [p1, p2] = doc.Pages;
  p1.AddText('VISIBLE-BODY', 72, 700, { fontSize: 24 });
  p1.AddText('WHITE-SECRET', 72, 600, { fontSize: 24, color: [1, 1, 1] });
  p2.AddText('SECOND-PAGE', 72, 700, { fontSize: 24 });
  p2.Rotate = 90;
  return doc;
}

/** Largest per-channel difference between two equal-size RGB renders. */
function maxDiff(a: Uint8Array, b: Uint8Array): number {
  expect(a.length).toBe(b.length);
  let m = 0;
  for (let i = 0; i < a.length; i++) m = Math.max(m, Math.abs(a[i] - b[i]));
  return m;
}

/** The page's /Resources /XObject entries, resolved. */
function xobjects(doc: Document, page: PdfDict): PdfObject[] {
  const res = doc.resolve(page.get('Resources'));
  const xo = isDict(res) ? doc.resolve(res.get('XObject')) : undefined;
  return isDict(xo) ? [...xo.values()].map((v) => doc.resolve(v)) : [];
}

const opts = { metadata: false, actions: false, attachments: false, annotations: false,
  forms: false, layers: false, privateData: false } as const;

describe('Sanitize pagesToImages (74mf.3)', () => {
  it('is off by default and leaves pages alone', () => {
    const doc = textDoc();
    expect(doc.Sanitize().pagesToImages).toBeUndefined();
    expect(doc.Pages[0].GetText()).toContain('VISIBLE-BODY');
  });

  it('replaces each page with one image, removing every glyph including hidden ones', () => {
    const doc = textDoc();
    const report = doc.Sanitize({ ...opts, pagesToImages: true });
    expect(report.pagesToImages).toEqual({ pages: 2, dpi: 150, structureRemoved: false });
    for (const p of doc.Pages) {
      expect(p.GetText().trim()).toBe('');
      const xo = xobjects(doc, p.Dict);
      expect(xo).toHaveLength(1);
      expect(isStream(xo[0]) && isName(xo[0].dict.get('Subtype')) && xo[0].dict.get('Subtype')).toEqual({ kind: 'name', name: 'Image' });
    }
    const bytes = latin1(doc.Save());
    for (const leak of ['VISIBLE-BODY', 'WHITE-SECRET', 'SECOND-PAGE', 'Helvetica']) expect(bytes, leak).not.toContain(leak);
  });

  // The image is drawn through the inverse of the render's own page-to-pixel
  // matrix, so the converted page renders as the original did — rotated pages
  // and CropBox origins included — and keeps its geometry.
  it('renders like the original page, rotated pages included', () => {
    const doc = textDoc();
    doc.Pages[0].Dict.set('CropBox', [20, 30, 500, 800]);
    doc.Pages[0].Dict.set('Group', new Map<string, PdfObject>([['S', { kind: 'name', name: 'Transparency' }]]));
    const before = doc.Pages.map((p) => renderPageRgb(doc, p, 1));
    doc.Sanitize({ ...opts, pagesToImages: { dpi: 72 } });
    doc.Pages.forEach((p, i) => {
      const after = renderPageRgb(doc, p, 1);
      expect([after.width, after.height]).toEqual([before[i].width, before[i].height]);
      expect(maxDiff(after.rgb, before[i].rgb), `page ${i + 1}`).toBeLessThanOrEqual(2);
    });
    expect(doc.Pages[1].Rotate).toBe(90);
    // the group described how the OLD content composited
    expect(doc.Pages[0].Dict.has('Group')).toBe(false);
  });

  it('writes DCTDecode with format jpeg', () => {
    const doc = textDoc();
    doc.Sanitize({ ...opts, pagesToImages: { format: 'jpeg', quality: 60, dpi: 100 } });
    const img = xobjects(doc, doc.Pages[0].Dict)[0];
    expect(isStream(img) && doc.resolve(img.dict.get('Filter'))).toEqual({ kind: 'name', name: 'DCTDecode' });
    expect(isStream(img) && img.dict.get('Width')).toBe(Math.round(595 * 100 / 72));
  });

  it('drops the structure tree, whose marked content no longer exists', () => {
    const doc = Document.New();
    doc.AddMarkdown('# Heading\n\nBody text.', { tagged: true });
    const note = doc.Pages[0].AddTextNote({ rect: [10, 10, 30, 30], contents: 'kept' });
    note.Dict.set('StructParent', 7);
    const report = doc.Sanitize({ ...opts, pagesToImages: true });
    expect(report.pagesToImages?.structureRemoved).toBe(true);
    expect(doc.GetStructTree()).toBeNull();
    expect(doc.catalog().has('MarkInfo')).toBe(false);
    for (const p of doc.Pages) expect(p.Dict.has('StructParents')).toBe(false);
    // a kept annotation stays an annotation, minus its link into the tree
    expect(doc.Pages[0].Annotations.map((a) => a.Subtype)).toEqual(['Text']);
    expect(note.Dict.has('StructParent')).toBe(false);
  });

  // Kept annotations still draw over the page, so the image must not ALSO
  // carry them or each is drawn twice.
  it('renders without annotations, which stay annotations when kept', () => {
    const doc = Document.New();
    doc.AddPage(PageFormat.A4);
    const page = doc.Pages[0];
    page.AddSquare({ rect: [100, 100, 300, 300], color: [1, 0, 0], fill: [1, 0, 0] });
    const bare = renderPageRgb(doc, page, 1, false);
    doc.Sanitize({ ...opts, pagesToImages: { dpi: 72 } });
    // with annotations OFF the converted page is the blank page: the square
    // was not baked into the image
    expect(maxDiff(renderPageRgb(doc, page, 1, false).rgb, bare.rgb)).toBeLessThanOrEqual(2);
    expect(page.Annotations.map((a) => a.Subtype)).toEqual(['Square']);
  });

  it('removes inherited /Resources from the page tree nodes', () => {
    const doc = textDoc();
    const pagesRoot = doc.resolve(doc.catalog().get('Pages')) as PdfDict;
    pagesRoot.set('Resources', new Map<string, PdfObject>([['ProcSet', [{ kind: 'name', name: 'PDF' }]]]));
    doc.Sanitize({ ...opts, pagesToImages: true });
    expect(pagesRoot.has('Resources')).toBe(false);
  });

  it('every converted page is then image-only, so MakeSearchable OCRs them all', async () => {
    const doc = textDoc();
    doc.Sanitize({ ...opts, pagesToImages: true });
    const engine: OcrEngine = { recognize: async () => [{ text: 'OCR', box: [10, 10, 100, 40] }] };
    const r = await doc.MakeSearchable(engine);
    expect(r.pages.map((p) => p.status)).toEqual(['ocr', 'ocr']);
    expect(doc.Pages[0].GetText()).toContain('OCR');
  });

  it('validates the option before changing anything', () => {
    const doc = textDoc();
    const before = doc.Save();
    expect(() => doc.Sanitize({ pagesToImages: 'yes' as never })).toThrow(TypeError);
    expect(() => doc.Sanitize({ pagesToImages: { dpi: 0 } })).toThrow(RangeError);
    expect(() => doc.Sanitize({ pagesToImages: { dpi: 2000 } })).toThrow(RangeError);
    expect(() => doc.Sanitize({ pagesToImages: { format: 'gif' as never } })).toThrow(RangeError);
    expect(() => doc.Sanitize({ pagesToImages: { quality: 80 } })).toThrow(TypeError);
    expect(() => doc.Sanitize({ pagesToImages: { format: 'jpeg', quality: 0 } })).toThrow(RangeError);
    expect(() => doc.Sanitize({ pagesToImages: { dpl: 72 } as never })).toThrow(TypeError);
    expect(doc.Save()).toEqual(before);
  });
});

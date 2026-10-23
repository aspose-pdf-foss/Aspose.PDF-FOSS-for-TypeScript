// 2srz.5: rendering a document holding a paper barcode never refuses and never
// mutates. The pending appearance (2srz.4) is a preview of what Save would
// write; a render that did not need it before must not start failing over it.
import { describe, expect, it } from 'vitest';
import { Document } from '../src/document.js';
import { PageFormat } from '../src/pageformat.js';
import { LoadLimits } from '../src/loadlimits.js';
import { fieldTreeWithinLimits } from '../src/form.js';

const RECT: [number, number, number, number] = [200, 20, 590, 280];
const text = (s: string) => ({ kind: 'string' as const, bytes: new TextEncoder().encode(s) });
const modified = (doc: Document) => (doc as unknown as { modified: boolean }).modified;
const objectCount = (doc: Document) => [...doc.objectEntries()].length;

/** A saved form whose barcode is current, plus a field seven levels deep. */
function saved(): Uint8Array {
  const doc = Document.New();
  doc.AddPage(PageFormat.custom(600, 300));
  doc.Form.AddTextField({ name: 'name', page: 1, rect: [10, 260, 100, 280], value: 'Ann' });
  doc.Form.AddTextField({ name: 'a.b.c.d.e.f.g', page: 1, rect: [10, 230, 100, 250], value: 'x' });
  doc.Form.AddBarcodeField({ name: 'bc', page: 1, rect: RECT, fields: ['name'] });
  return doc.Save();
}

describe('a field tree deeper than maxNestingDepth', () => {
  const tight = () => Document.Open(saved(), { limits: LoadLimits.defaults.with({ maxNestingDepth: 3 }) });

  it('still renders, through the stored appearances', () => {
    const doc = tight();
    const image = doc.Pages[0].ToImage();
    expect(image).toEqual(Document.Open(saved()).Pages[0].ToImage());
    expect(() => doc.Pages[0].ToSvg()).not.toThrow();
    expect(() => doc.ToHtml()).not.toThrow();
  });

  it('is still refused where the field tree is genuinely needed', () => {
    expect(() => tight().Form.Fields).toThrow(/maxNestingDepth/);
  });
});

describe('fieldTreeWithinLimits agrees with the Form walk', () => {
  it('answers false exactly where Form.Fields would refuse', () => {
    for (const depth of [6, 7, 8]) {
      const doc = Document.Open(saved(), { limits: LoadLimits.defaults.with({ maxNestingDepth: depth }) });
      let threw = false;
      try { void doc.Form.Fields; } catch { threw = true; }
      expect(fieldTreeWithinLimits(doc)).toBe(!threw);
      expect(threw).toBe(depth < 7);
    }
  });

  it('answers true for a document with no form', () => {
    const doc = Document.New();
    doc.AddPage(PageFormat.custom(100, 100));
    expect(fieldTreeWithinLimits(doc)).toBe(true);
  });
});

describe('rendering a stale barcode changes nothing', () => {
  it('ToImage, ToSvg and ToHtml leave the document unmodified', () => {
    const doc = Document.Open(saved());
    const before = doc.Pages[0].ToImage();
    const bc = doc.Form.Get('bc')!;
    const v = bc.Dict.get('V');
    const ap = bc.Dict.get('AP');
    // A live Dict edit reports nothing, so the barcode is stale and the
    // document still reads as untouched.
    doc.Form.Get('name')!.Dict.set('V', text('Bob'));
    expect(modified(doc)).toBe(false);
    const count = objectCount(doc);

    const after = doc.Pages[0].ToImage();
    doc.Pages[0].ToSvg();
    doc.ToHtml();

    // The pending appearance was drawn: the symbol changed on the page...
    expect(after).not.toEqual(before);
    // ...and nothing was written.
    expect(modified(doc)).toBe(false);
    expect(objectCount(doc)).toBe(count);
    expect(bc.Dict.get('V')).toBe(v);
    expect(bc.Dict.get('AP')).toBe(ap);
  });
});

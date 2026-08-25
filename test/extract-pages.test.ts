import { describe, it, expect } from 'vitest';
import { buildClassicPdf, buildSharedFontPdf } from './helpers/build-pdf.js';
import { Document } from '../src/document.js';
import { PdfObject, isDict, isName, isRef } from '../src/types.js';

/** Count live indirect objects in `doc` whose /Type is `typeName`. */
function countTypedObjects(doc: Document, typeName: string): number {
  const objects = (doc as unknown as { objects: Map<number, PdfObject> }).objects;
  let count = 0;
  for (const o of objects.values()) {
    if (isDict(o)) {
      const t = o.get('Type');
      if (isName(t) && t.name === typeName) count++;
    }
  }
  return count;
}

/** Decoded text of page `i` (0-based) of `doc`, for order assertions. */
const text = (doc: Document, i: number) =>
  new TextDecoder().decode(doc.Pages[i].Contents);

describe('Document.ExtractPages — core', () => {
  it('extracts the given pages into a new document in the given order', () => {
    const src = Document.Open(buildClassicPdf(5));
    const out = src.ExtractPages([2, 3, 5]);
    expect(out.Pages.length).toBe(3);
    expect(text(out, 0)).toContain('Page 2');
    expect(text(out, 1)).toContain('Page 3');
    expect(text(out, 2)).toContain('Page 5');
  });

  it('extracts a single page', () => {
    const src = Document.Open(buildClassicPdf(4));
    const out = src.ExtractPages([4]);
    expect(out.Pages.length).toBe(1);
    expect(text(out, 0)).toContain('Page 4');
  });

  it('allows repeats, producing distinct page objects', () => {
    const src = Document.Open(buildClassicPdf(3));
    const out = src.ExtractPages([2, 2]);
    expect(out.Pages.length).toBe(2);
    expect(text(out, 0)).toContain('Page 2');
    expect(text(out, 1)).toContain('Page 2');
    // Distinct objects: mutating one copy does not change the other.
    out.Pages[0].Dict.set('UserUnit', 2);
    expect(out.Pages[1].Dict.has('UserUnit')).toBe(false);
  });

  it('full-range extraction reproduces the whole document', () => {
    const src = Document.Open(buildClassicPdf(3));
    const out = src.ExtractPages([1, 2, 3]);
    expect(out.Pages.length).toBe(3);
    for (let i = 0; i < 3; i++) expect(text(out, i)).toContain(`Page ${i + 1}`);
  });

  it('throws RangeError on empty, out-of-range, and non-integer input', () => {
    const src = Document.Open(buildClassicPdf(5));
    for (const bad of [[], [0], [6], [1.5]] as number[][]) {
      expect(() => src.ExtractPages(bad)).toThrow(RangeError);
    }
    expect(src.Pages.length).toBe(5); // untouched after throws
  });

  it('does not mutate the source document', () => {
    const src = Document.Open(buildClassicPdf(3));
    const out = src.ExtractPages([1, 3]);
    expect(src.Pages.length).toBe(3);
    expect(text(src, 2)).toContain('Page 3');
    // Editing the extracted doc must not leak back into the source.
    out.Pages[0].Dict.set('UserUnit', 2);
    expect(src.Pages[0].Dict.has('UserUnit')).toBe(false);
  });

  it('round-trips through Save()/Open', () => {
    const src = Document.Open(buildClassicPdf(5));
    const reopened = Document.Open(src.ExtractPages([2, 5]).Save());
    expect(reopened.Pages.length).toBe(2);
    expect(new TextDecoder().decode(reopened.Pages[0].Contents)).toContain('Page 2');
    expect(new TextDecoder().decode(reopened.Pages[1].Contents)).toContain('Page 5');
  });
});

describe('Document.ExtractPages — importPages reuse benefits', () => {
  it('copies a resource shared across selected pages exactly once', () => {
    // buildSharedFontPdf: 2 pages sharing ONE indirect font object (/F1 -> 7 0 R).
    const src = Document.Open(buildSharedFontPdf());
    const out = src.ExtractPages([1, 2]);
    const f1Num = (i: number) => {
      const res = out.resolve(out.Pages[i].Dict.get('Resources'));
      const font = isDict(res) ? out.resolve(res.get('Font')) : null;
      const f1 = isDict(font) ? font.get('F1') : null;
      if (!isRef(f1)) throw new Error('F1 not a ref');
      return f1.num;
    };
    expect(f1Num(0)).toBe(f1Num(1)); // same object: copied once, not per page
    // Single-instance in the serialized output: exactly one /Type /Font object.
    const reopened = Document.Open(out.Save());
    expect(countTypedObjects(reopened, 'Font')).toBe(1);
  });

  it('flattens MediaBox inherited from the source /Pages root onto extracted pages', () => {
    // buildClassicPdf puts MediaBox on the /Pages ROOT; leaves inherit it.
    const src = Document.Open(buildClassicPdf(2, { mediaBox: [0, 0, 300, 400] }));
    const out = src.ExtractPages([2]);
    expect(out.Pages[0].MediaBox).toEqual([0, 0, 300, 400]);
    const reopened = Document.Open(out.Save());
    expect(reopened.Pages[0].MediaBox).toEqual([0, 0, 300, 400]);
  });

  it('flattens Rotate inherited from the source /Pages root onto extracted pages', () => {
    const src = Document.Open(buildClassicPdf(1, { rotate: 90 }));
    const out = src.ExtractPages([1]);
    expect(out.Pages[0].Rotate).toBe(90);
    const reopened = Document.Open(out.Save());
    expect(reopened.Pages[0].Rotate).toBe(90);
  });
});

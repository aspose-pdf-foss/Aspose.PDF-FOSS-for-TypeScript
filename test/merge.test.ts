import { describe, it, expect } from 'vitest';
import { buildClassicPdf, buildSharedFontPdf } from './helpers/build-pdf.js';
import { Document } from '../src/document.js';
import { isDict, isRef } from '../src/types.js';

/** Decoded text of page `i` (0-based) of `doc`, for order assertions. */
const text = (doc: Document, i: number) =>
  new TextDecoder().decode(doc.Pages[i].Contents);

describe('Document.Append', () => {
  it('appends every page of other in order and returns their 1-based numbers', () => {
    const target = Document.Open(buildClassicPdf(2));
    const other = Document.Open(buildClassicPdf(3));
    const nums = target.Append(other);
    expect(target.Pages.length).toBe(5);
    expect(nums).toEqual([3, 4, 5]);
    expect(text(target, 2)).toContain('Page 1'); // other's page 1
    expect(text(target, 4)).toContain('Page 3'); // other's page 3
  });

  it('does not mutate the source document', () => {
    const target = Document.Open(buildClassicPdf(1));
    const other = Document.Open(buildClassicPdf(2));
    target.Append(other);
    expect(other.Pages.length).toBe(2);
    expect(text(other, 0)).toContain('Page 1');
  });

  it('is a no-op for a zero-page source', () => {
    const target = Document.Open(buildClassicPdf(2));
    const nums = target.Append(Document.Open(buildClassicPdf(0)));
    expect(nums).toEqual([]);
    expect(target.Pages.length).toBe(2);
  });

  it('round-trips merged pages through Save()/Open', () => {
    const target = Document.Open(buildClassicPdf(2));
    target.Append(Document.Open(buildClassicPdf(2)));
    const reopened = Document.Open(target.Save());
    expect(reopened.Pages.length).toBe(4);
    expect(new TextDecoder().decode(reopened.Pages[3].Contents)).toContain('Page 2');
  });

  it('flattens inherited MediaBox onto merged pages', () => {
    const target = Document.Open(buildClassicPdf(1)); // root MediaBox [0 0 200 200]
    const other = Document.Open(buildClassicPdf(1, { mediaBox: [0, 0, 300, 400] }));
    target.Append(other);
    // The merged page must keep other's size, not inherit target's root or default Letter.
    expect(target.Pages[1].MediaBox).toEqual([0, 0, 300, 400]);
    const reopened = Document.Open(target.Save());
    expect(reopened.Pages[1].MediaBox).toEqual([0, 0, 300, 400]);
  });

  it('flattens inherited Rotate onto merged pages', () => {
    const target = Document.Open(buildClassicPdf(1)); // no Rotate -> 0
    const other = Document.Open(buildClassicPdf(1, { rotate: 90 }));
    target.Append(other);
    expect(target.Pages[0].Rotate).toBe(0);
    expect(target.Pages[1].Rotate).toBe(90);
  });

  it('copies a resource shared across the source pages exactly once', () => {
    const target = Document.Open(buildClassicPdf(1));
    target.Append(Document.Open(buildSharedFontPdf()));
    const f1Num = (i: number) => {
      const res = target.resolve(target.Pages[i].Dict.get('Resources'));
      const font = isDict(res) ? target.resolve(res.get('Font')) : null;
      const f1 = isDict(font) ? font.get('F1') : null;
      if (!isRef(f1)) throw new Error('F1 not a ref');
      return f1.num;
    };
    // Both merged pages (now pages 2 and 3) must reference the SAME font object.
    expect(f1Num(1)).toBe(f1Num(2));
  });
});

describe('Document.InsertPages', () => {
  it('prepends source pages at position 1, shifting originals down', () => {
    const target = Document.Open(buildClassicPdf(2)); // "Page 1","Page 2"
    const other = Document.Open(buildClassicPdf(1));  // "Page 1"
    const nums = target.InsertPages(1, other);
    expect(nums).toEqual([1]);
    expect(target.Pages.length).toBe(3);
    expect(new TextDecoder().decode(target.Pages[0].Contents)).toContain('Page 1'); // inserted
    expect(new TextDecoder().decode(target.Pages[2].Contents)).toContain('Page 2'); // shifted
  });

  it('splices source pages in the middle with contiguous numbers', () => {
    const target = Document.Open(buildClassicPdf(3));
    const nums = target.InsertPages(2, Document.Open(buildClassicPdf(2)));
    expect(nums).toEqual([2, 3]);
    expect(target.Pages.length).toBe(5);
  });

  it('at = Pages.length + 1 behaves like Append', () => {
    const target = Document.Open(buildClassicPdf(2));
    const nums = target.InsertPages(3, Document.Open(buildClassicPdf(1)));
    expect(nums).toEqual([3]);
    expect(target.Pages.length).toBe(3);
  });

  it('throws RangeError out of range / non-integer and leaves both docs unchanged', () => {
    const target = Document.Open(buildClassicPdf(2));
    const other = Document.Open(buildClassicPdf(1));
    for (const bad of [0, 4, 1.5]) {
      expect(() => target.InsertPages(bad, other)).toThrow(RangeError);
    }
    expect(target.Pages.length).toBe(2);
    expect(other.Pages.length).toBe(1);
  });
});

describe('Document.Merge', () => {
  it('builds a new document with all pages of all inputs in order', () => {
    const a = Document.Open(buildClassicPdf(1)); // "Page 1"
    const b = Document.Open(buildClassicPdf(2)); // "Page 1","Page 2"
    const merged = Document.Merge(a, b);
    expect(merged.Pages.length).toBe(3);
    expect(new TextDecoder().decode(merged.Pages[0].Contents)).toContain('Page 1');
    expect(new TextDecoder().decode(merged.Pages[2].Contents)).toContain('Page 2');
  });

  it('leaves every input document unmodified', () => {
    const a = Document.Open(buildClassicPdf(1));
    const b = Document.Open(buildClassicPdf(1));
    Document.Merge(a, b);
    expect(a.Pages.length).toBe(1);
    expect(b.Pages.length).toBe(1);
  });

  it('returns a valid empty document for no inputs or only-empty inputs', () => {
    expect(Document.Merge().Pages.length).toBe(0);
    expect(Document.Merge(Document.Open(buildClassicPdf(0))).Pages.length).toBe(0);
  });

  it('round-trips a merge result through Save()/Open', () => {
    const merged = Document.Merge(
      Document.Open(buildClassicPdf(1)),
      Document.Open(buildClassicPdf(1)),
    );
    const reopened = Document.Open(merged.Save());
    expect(reopened.Pages.length).toBe(2);
  });
});

describe('Document merge — composition', () => {
  it('doc.Append(doc) doubles pages with distinct copied objects', () => {
    const doc = Document.Open(buildClassicPdf(2));
    doc.Append(doc);
    expect(doc.Pages.length).toBe(4);
    // The copy is a distinct object: mutating it does not change the original.
    doc.Pages[2].Dict.set('UserUnit', 2);
    expect(doc.Pages[0].Dict.has('UserUnit')).toBe(false);
  });

  it('Merge then Reorder then RemovePage compose correctly', () => {
    const merged = Document.Merge(
      Document.Open(buildClassicPdf(2)), // pages "Page 1","Page 2"
      Document.Open(buildClassicPdf(1)), // page  "Page 1"
    );
    expect(merged.Pages.length).toBe(3);
    merged.Reorder([3, 1, 2]);
    expect(new TextDecoder().decode(merged.Pages[0].Contents)).toContain('Page 1'); // old page 3
    merged.RemovePage(1);
    expect(merged.Pages.length).toBe(2);
    const reopened = Document.Open(merged.Save());
    expect(reopened.Pages.length).toBe(2);
  });
});

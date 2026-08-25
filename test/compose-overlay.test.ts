import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import type { Page } from '../src/page.js';
import { isDict, isRef, type PdfDict, type PdfRef } from '../src/types.js';
import { buildClassicPdf } from './helpers/build-pdf.js';
import { buildComposeSource } from './helpers/build-compose-pdf.js';

const dec = (u: Uint8Array) => new TextDecoder('latin1').decode(u);

/** The Form-XObject ref placed on `page` by Overlay (its single /Fm entry), or undefined. */
function placedRef(doc: Document, page: Page): PdfRef | undefined {
  const res = doc.resolve(page.Dict.get('Resources'));
  if (!isDict(res)) return undefined;
  const xobjs = doc.resolve(res.get('XObject'));
  if (!isDict(xobjs)) return undefined;
  const entry = [...(xobjs as PdfDict).values()][0];
  return isRef(entry) ? entry : undefined;
}

describe('doc.Overlay', () => {
  it('stamps every page by default', () => {
    const doc = Document.Open(buildClassicPdf(3));
    const src = Document.Open(buildComposeSource());

    doc.Overlay(src.Pages[0]);

    for (const page of doc.Pages) {
      const ref = placedRef(doc, page);
      expect(ref).toBeDefined();
      expect(dec(page.Contents)).toContain(`/Fm`);
    }
  });

  it('imports the source once and shares the XObject across pages', () => {
    const doc = Document.Open(buildClassicPdf(3));
    const src = Document.Open(buildComposeSource());

    doc.Overlay(src.Pages[0]);

    const nums = doc.Pages.map((p) => placedRef(doc, p)!.num);
    expect(nums[0]).toBe(nums[1]);
    expect(nums[1]).toBe(nums[2]); // one shared object, not three copies
    // and that single object carries the imported "Hi"
    const shared = doc.resolve(placedRef(doc, doc.Pages[0])!);
    expect(dec((shared as { raw: Uint8Array }).raw)).toContain('(Hi) Tj');
  });

  it('restricts to the given 1-based pages', () => {
    const doc = Document.Open(buildClassicPdf(3));
    const src = Document.Open(buildComposeSource());

    doc.Overlay(src.Pages[0], { pages: [2] });

    expect(placedRef(doc, doc.Pages[0])).toBeUndefined();
    expect(placedRef(doc, doc.Pages[1])).toBeDefined();
    expect(placedRef(doc, doc.Pages[2])).toBeUndefined();
  });

  it('underlays before existing content when underlay is set', () => {
    const doc = Document.Open(buildClassicPdf(1));
    const src = Document.Open(buildComposeSource());

    doc.Overlay(src.Pages[0], { underlay: true });

    const c = dec(doc.Pages[0].Contents);
    expect(c.indexOf('/Fm')).toBeLessThan(c.indexOf('(Page 1)'));
  });

  it('accepts a Document source, using its first page', () => {
    const doc = Document.Open(buildClassicPdf(2));
    const src = Document.Open(buildComposeSource());

    doc.Overlay(src); // Document, not Page

    const shared = doc.resolve(placedRef(doc, doc.Pages[0])!);
    expect(dec((shared as { raw: Uint8Array }).raw)).toContain('(Hi) Tj');
  });

  it('leaves a cross-document source untouched', () => {
    const doc = Document.Open(buildClassicPdf(2));
    const src = Document.Open(buildComposeSource());
    const before = dec(src.Pages[0].Contents);

    doc.Overlay(src.Pages[0]);

    expect(dec(src.Pages[0].Contents)).toBe(before);
    expect(src.Pages[0].Dict.has('XObject')).toBe(false);
  });

  it('throws RangeError for an out-of-range page number', () => {
    const doc = Document.Open(buildClassicPdf(2));
    const src = Document.Open(buildComposeSource());
    expect(() => doc.Overlay(src.Pages[0], { pages: [3] })).toThrow(RangeError);
    expect(() => doc.Overlay(src.Pages[0], { pages: [0] })).toThrow(RangeError);
  });

  it('round-trips: overlaid pages survive Save/Open', () => {
    const doc = Document.Open(buildClassicPdf(2));
    const src = Document.Open(buildComposeSource());
    doc.Overlay(src.Pages[0], { opacity: 0.4 });

    const reopened = Document.Open(doc.Save());
    expect(reopened.Pages).toHaveLength(2);
    const shared = reopened.resolve(placedRef(reopened, reopened.Pages[1])!);
    expect(dec((shared as { raw: Uint8Array }).raw)).toContain('(Hi) Tj');
    // the same imported object is still shared across both pages
    expect(placedRef(reopened, reopened.Pages[0])!.num)
      .toBe(placedRef(reopened, reopened.Pages[1])!.num);
  });
});

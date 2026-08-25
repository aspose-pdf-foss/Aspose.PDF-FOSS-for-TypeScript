import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { buildInlineImagePdf, buildInlineInFormPdf } from './helpers/build-inline-image-pdf.js';

/**
 * page.InlineImages — enumerating and removing `BI … EI` images (issue 10u9.10).
 *
 * An inline image lives in no object, so `10u9.4`'s ImageInfo cannot represent
 * one: it has no /XObject entry and no resource name. The handle here is
 * addressed by ContentAddr instead, which brings a hazard ImageInfo does not
 * have — removing one shifts the op indices of every later one — so every
 * assertion about staleness below is load-bearing rather than defensive.
 */

const contentText = (doc: Document, i = 0) =>
  new TextDecoder('latin1').decode(doc.Pages[i].Contents);

describe('page.InlineImages — enumeration', () => {
  it('finds both inline images, in content order', () => {
    const doc = Document.Open(buildInlineImagePdf());
    const inl = doc.Pages[0].InlineImages;
    expect(inl.length).toBe(2);
    expect(inl.map((i) => [i.Width, i.Height])).toEqual([[2, 2], [1, 1]]);
  });

  it('stays separate from page.Images, which still sees only the XObject', () => {
    // The two accessors mean different things and neither may pick up the
    // other's entries: six modules consume page.Images and none expect inline.
    const doc = Document.Open(buildInlineImagePdf());
    expect(doc.Pages[0].Images.map((i) => i.Name)).toEqual(['Im0']);
    expect(doc.Pages[0].InlineImages.length).toBe(2);
  });

  it('reads through the NORMALIZED dict, not the abbreviated one', () => {
    // The file says /W /H /CS /BPC /F; inlineImageToStream expands those to
    // /Width /Height /ColorSpace /BitsPerComponent /Filter, so one rule serves
    // an inline image and an XObject alike.
    const doc = Document.Open(buildInlineImagePdf());
    const [rgb, gray] = doc.Pages[0].InlineImages;
    expect(rgb.ColorSpace).toBe('DeviceRGB');
    expect(gray.ColorSpace).toBe('DeviceGray');
    expect(rgb.Bits).toBe(8);
    expect(rgb.Dict.has('Width')).toBe(true);
    expect(rgb.Dict.has('W')).toBe(false);
  });

  it('decodes its samples', () => {
    const doc = Document.Open(buildInlineImagePdf());
    const [rgb] = doc.Pages[0].InlineImages;
    expect(rgb.Filter).toBe('ASCIIHexDecode');
    expect(Array.from(rgb.Decode())).toEqual([
      255, 0, 0, 0, 255, 0, 0, 0, 255, 255, 255, 0,
    ]);
  });

  it('finds one nested inside a Form XObject', () => {
    const doc = Document.Open(buildInlineInFormPdf());
    const inl = doc.Pages[0].InlineImages;
    expect(inl.length).toBe(1);
    expect([inl[0].Width, inl[0].Height]).toEqual([2, 2]);
  });
});

describe('page.InlineImages — Remove', () => {
  it('drops the BI…EI and its whole placement group', () => {
    const doc = Document.Open(buildInlineImagePdf());
    doc.Pages[0].InlineImages[0].Remove();

    const body = contentText(doc);
    expect(body).not.toContain('ff000000ff00');        // the 2x2 RGB data
    expect(body).not.toContain('40 0 0 20 10 10 cm');  // and its cm
    expect(doc.Pages[0].InlineImages.length).toBe(1);
  });

  it('removes exactly ONE draw, unlike ImageInfo.Remove', () => {
    // An inline image IS a single draw, so a handle names one occurrence. The
    // XObject rule -- every draw of the resource key -- has no counterpart.
    const doc = Document.Open(buildInlineImagePdf());
    doc.Pages[0].InlineImages[1].Remove();            // the 1x1 gray

    const left = doc.Pages[0].InlineImages;
    expect(left.length).toBe(1);
    expect([left[0].Width, left[0].Height]).toEqual([2, 2]); // the RGB survived
    expect(contentText(doc)).toContain('40 0 0 20 10 10 cm');
  });

  it('leaves the XObject image alone', () => {
    const doc = Document.Open(buildInlineImagePdf());
    doc.Pages[0].InlineImages[0].Remove();
    expect(doc.Pages[0].Images.map((i) => i.Name)).toEqual(['Im0']);
    expect(contentText(doc)).toContain('/Im0 Do');
  });

  it('survives a save/reopen round trip', () => {
    const doc = Document.Open(buildInlineImagePdf());
    doc.Pages[0].InlineImages[0].Remove();
    const back = Document.Open(doc.Save());
    expect(back.Pages[0].InlineImages.length).toBe(1);
    expect(back.Pages[0].Images.map((i) => i.Name)).toEqual(['Im0']);
  });

  it('removes one nested in a form, editing that form', () => {
    const doc = Document.Open(buildInlineInFormPdf());
    doc.Pages[0].InlineImages[0].Remove();
    expect(doc.Pages[0].InlineImages).toEqual([]);
    const back = Document.Open(doc.Save());
    expect(back.Pages[0].InlineImages).toEqual([]);
  });

  it('THROWS on a handle invalidated by an earlier removal', () => {
    // The hazard that shaped this design. Both handles come from one
    // enumeration; removing the first shifts the second's op index, so the
    // second must refuse rather than cut whatever now sits at that address.
    const doc = Document.Open(buildInlineImagePdf());
    const [first, second] = doc.Pages[0].InlineImages;
    first.Remove();
    expect(() => second.Remove()).toThrow(RangeError);
    // And nothing was destroyed by the refusal.
    expect(doc.Pages[0].InlineImages.length).toBe(1);
  });

  it('THROWS on a second Remove of the same handle', () => {
    const doc = Document.Open(buildInlineImagePdf());
    const h = doc.Pages[0].InlineImages[0];
    h.Remove();
    expect(() => h.Remove()).toThrow(RangeError);
  });

  it('re-enumerating after a removal gives usable handles', () => {
    // The documented way to remove several: enumerate, remove, re-enumerate.
    const doc = Document.Open(buildInlineImagePdf());
    doc.Pages[0].InlineImages[0].Remove();
    doc.Pages[0].InlineImages[0].Remove();
    expect(doc.Pages[0].InlineImages).toEqual([]);
    expect(contentText(doc)).not.toContain('BI');
    expect(contentText(doc)).toContain('/Im0 Do'); // the XObject still drawn
  });
});

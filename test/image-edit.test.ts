import { describe, it, expect } from 'vitest';
import { deflateSync } from 'node:zlib';
import { Document } from '../src/document.js';
import { ImageInfo } from '../src/image.js';
import { UnsupportedFeatureError } from '../src/errors.js';
import { imageScopes } from '../src/imageedit.js';
import { isDict, PdfDict } from '../src/types.js';
import { buildImagePdf, buildSingleImagePdfWithCm } from './helpers/build-image-pdf.js';
import { buildJpeg, buildPngRgb, buildPngRgba } from './helpers/build-embed-images.js';
import {
  buildSharedImagePdf, buildFormImagePdf, buildTwiceDrawnImagePdf, buildGsWrappedImagePdf,
} from './helpers/build-image-edit-pdf.js';

/** The page's own /Resources /XObject dict, resolved. */
function xobjectDict(doc: Document, pageIndex = 0): PdfDict {
  const res = doc.resolve(doc.Pages[pageIndex].Dict.get('Resources'));
  if (!isDict(res)) throw new Error('no /Resources');
  const x = doc.resolve(res.get('XObject'));
  if (!isDict(x)) throw new Error('no /XObject');
  return x;
}

describe('imageScopes', () => {
  it('finds a page-level image', () => {
    const doc = Document.Open(buildSharedImagePdf());
    const page = doc.Pages[0];
    const img = page.Images.find((i) => i.Name === 'Im0')!;
    expect(imageScopes(doc, page, img.Stream)).toEqual([{ path: [], key: 'Im0' }]);
  });

  it('finds an image nested in a Form XObject, with the form path', () => {
    const doc = Document.Open(buildFormImagePdf());
    const page = doc.Pages[0];
    const img = page.Images.find((i) => i.Name === 'ImF')!;
    expect(imageScopes(doc, page, img.Stream)).toEqual([{ path: ['Fm0'], key: 'ImF' }]);
  });

  it('matches on stream identity, not on the resource name', () => {
    // buildImagePdf's page holds Im0, Dct0, Fm0, Msk0, Jb0; ImF lives in Fm0.
    const doc = Document.Open(buildImagePdf().bytes);
    const page = doc.Pages[0];
    const im0 = page.Images.find((i) => i.Name === 'Im0')!;
    const imf = page.Images.find((i) => i.Name === 'ImF')!;
    expect(imageScopes(doc, page, im0.Stream)).toEqual([{ path: [], key: 'Im0' }]);
    expect(imageScopes(doc, page, imf.Stream)).toEqual([{ path: ['Fm0'], key: 'ImF' }]);
  });

  it('returns every key one stream is registered under', () => {
    const doc = Document.Open(buildSharedImagePdf());
    const page = doc.Pages[0];
    const img = page.Images[0];
    // Register the same object a second time under another name.
    const xobj = xobjectDict(doc);
    xobj.set('Im9', xobj.get('Im0')!);
    expect(imageScopes(doc, page, img.Stream).map((s) => s.key).sort())
      .toEqual(['Im0', 'Im9']);
  });

  it('returns [] for a stream the page does not reference', () => {
    const doc = Document.Open(buildSharedImagePdf());
    const other = Document.Open(buildFormImagePdf());
    const foreign = other.Pages[0].Images[0].Stream;
    expect(imageScopes(doc, doc.Pages[0], foreign)).toEqual([]);
  });
});

describe('ImageInfo is bound to the page it was enumerated from', () => {
  it('page.Images hands back handles that know their page', () => {
    const doc = Document.Open(buildTwiceDrawnImagePdf());
    // Not directly observable, so assert through the behaviour it enables:
    // a handle from page.Images can be removed, one built by hand cannot.
    expect(() => doc.Pages[0].Images[0].Remove()).not.toThrow();
  });
});

/** A 1-page PDF whose /Im0 is a 2x2 DeviceRGB image placed by `80 0 0 40 10 10 cm`. */
function placedPdf(): Uint8Array {
  const raw = new Uint8Array(deflateSync(Buffer.from(
    Uint8Array.from([255, 0, 0, 0, 255, 0, 0, 0, 255, 255, 255, 0]))));
  return buildSingleImagePdfWithCm({
    width: 2, height: 2, colorSpace: 'DeviceRGB', bits: 8,
    filter: 'FlateDecode', raw, cm: '80 0 0 40 10 10',
  });
}

const contentText = (doc: Document, i = 0) =>
  new TextDecoder('latin1').decode(doc.Pages[i].Contents);

describe('ImageInfo.Replace', () => {
  it('swaps the picture and leaves the placement alone', () => {
    const doc = Document.Open(placedPdf());
    doc.Pages[0].Images[0].Replace(buildPngRgb()); // 2x1 RGB

    const img = doc.Pages[0].Images[0];
    expect(img.Width).toBe(2);
    expect(img.Height).toBe(1);
    expect(img.ColorSpace).toBe('DeviceRGB');
    // The cm that sizes the image lives in the content stream and is untouched.
    expect(contentText(doc)).toContain('80 0 0 40 10 10 cm');
  });

  it('survives a save/reopen round trip', () => {
    const doc = Document.Open(placedPdf());
    doc.Pages[0].Images[0].Replace(buildPngRgb());
    const back = Document.Open(doc.Save());
    expect(back.Pages[0].Images[0].Height).toBe(1);
    expect(contentText(back)).toContain('80 0 0 40 10 10 cm');
  });

  it('is copy-on-write: replacing from one page leaves the other alone', () => {
    const doc = Document.Open(buildSharedImagePdf());
    const sharedBefore = doc.Pages[1].Images[0].Stream;

    doc.Pages[0].Images[0].Replace(buildPngRgb());

    expect(doc.Pages[0].Images[0].Height).toBe(1);   // replaced
    expect(doc.Pages[1].Images[0].Height).toBe(2);   // untouched
    expect(doc.Pages[1].Images[0].Stream).toBe(sharedBefore);
    expect(doc.Pages[0].Images[0].Stream).not.toBe(sharedBefore);
  });

  it('is copy-on-write for an image nested in a shared form', () => {
    const doc = Document.Open(buildFormImagePdf());
    const before = doc.Pages[1].Images.find((i) => i.Name === 'ImF')!.Stream;

    doc.Pages[0].Images.find((i) => i.Name === 'ImF')!.Replace(buildPngRgb());

    expect(doc.Pages[0].Images.find((i) => i.Name === 'ImF')!.Height).toBe(1);
    expect(doc.Pages[1].Images.find((i) => i.Name === 'ImF')!.Height).toBe(2);
    expect(doc.Pages[1].Images.find((i) => i.Name === 'ImF')!.Stream).toBe(before);
  });

  it('adds an /SMask for an alpha source and DROPS it for an opaque one', () => {
    const doc = Document.Open(placedPdf());

    doc.Pages[0].Images[0].Replace(buildPngRgba()); // 1x1 RGBA
    expect(doc.Pages[0].Images[0].Dict.has('SMask')).toBe(true);

    doc.Pages[0].Images[0].Replace(buildJpeg(4, 4, 3)); // opaque
    expect(doc.Pages[0].Images[0].Dict.has('SMask')).toBe(false);
    expect(doc.Pages[0].Images[0].Filter).toBe('DCTDecode');
  });

  it('carries /OC forward', () => {
    const doc = Document.Open(placedPdf());
    const layer = doc.OptionalContent.AddLayer('L1');
    doc.Pages[0].Images[0].Dict.set('OC', layer.Ref);

    doc.Pages[0].Images[0].Replace(buildPngRgb());

    expect(doc.Pages[0].Images[0].Dict.get('OC')).toEqual(layer.Ref);
  });

  it('validates before mutating: a rejected call leaves the bytes identical', () => {
    const doc = Document.Open(placedPdf());
    const before = doc.Save();
    expect(() => doc.Pages[0].Images[0].Replace(Uint8Array.from([1, 2, 3])))
      .toThrow(UnsupportedFeatureError);
    expect(Buffer.from(doc.Save()).equals(Buffer.from(before))).toBe(true);
  });

  it('rejects empty data', () => {
    const doc = Document.Open(placedPdf());
    expect(() => doc.Pages[0].Images[0].Replace(new Uint8Array(0)))
      .toThrow(UnsupportedFeatureError);
  });

  it('throws RangeError for a handle whose stream left the resource tree', () => {
    const doc = Document.Open(placedPdf());
    const stale = doc.Pages[0].Images[0];
    xobjectDict(doc).delete('Im0');
    expect(() => stale.Replace(buildPngRgb())).toThrow(RangeError);
  });

  it('refuses a page index for a format that has no pages', () => {
    const doc = Document.Open(placedPdf());
    expect(() => doc.Pages[0].Images[0].Replace(buildPngRgb(), { page: 1 }))
      .toThrow(UnsupportedFeatureError);
  });

  it('refuses a handle that is not bound to a page', () => {
    const doc = Document.Open(placedPdf());
    const stream = doc.Pages[0].Images[0].Stream;
    const unbound = new ImageInfo(doc, 'Im0', stream); // no page argument
    expect(() => unbound.Replace(buildPngRgb())).toThrow(UnsupportedFeatureError);
  });
});

/** Keys of a page's /Resources sub-dict (e.g. 'XObject'), or []. */
function resourceKeys(doc: Document, key: string, pageIndex = 0): string[] {
  const res = doc.resolve(doc.Pages[pageIndex].Dict.get('Resources'));
  const sub = isDict(res) ? doc.resolve(res.get(key)) : undefined;
  return isDict(sub) ? [...sub.keys()] : [];
}
const savedText = (doc: Document) => new TextDecoder('latin1').decode(doc.Save());

describe('ImageInfo.Remove', () => {
  it('drops the draw, the placement group and the resource entry', () => {
    const doc = Document.Open(placedPdf());
    doc.Pages[0].Images[0].Remove();

    const body = contentText(doc);
    expect(body).not.toContain('/Im0 Do');
    expect(body).not.toContain('80 0 0 40 10 10 cm'); // the whole q/cm/Do/Q went
    expect(body).not.toContain('q');
    expect(resourceKeys(doc, 'XObject')).not.toContain('Im0');
    expect(doc.Pages[0].Images).toEqual([]);
  });

  it('lets Save sweep the now-orphaned XObject', () => {
    const doc = Document.Open(placedPdf());
    doc.Pages[0].Images[0].Remove();
    expect(savedText(doc)).not.toContain('/Subtype /Image');
  });

  it('removes every draw of the image on the page', () => {
    const doc = Document.Open(buildTwiceDrawnImagePdf());
    doc.Pages[0].Images[0].Remove();
    const body = contentText(doc);
    expect(body).not.toContain('Do');
    expect(body).not.toContain('80 0 0 40 10 10 cm');
    expect(body).not.toContain('60 0 0 30 20 120 cm');
  });

  it('leaves the other page alone when the image is shared', () => {
    const doc = Document.Open(buildSharedImagePdf());
    doc.Pages[0].Images[0].Remove();

    expect(doc.Pages[0].Images).toEqual([]);
    expect(doc.Pages[1].Images.map((i) => i.Name)).toEqual(['Im0']);
    expect(contentText(doc, 1)).toContain('/Im0 Do');
    // Still reachable from page 2, so it must NOT be swept.
    expect(savedText(doc)).toContain('/Subtype /Image');
  });

  it('removes an image nested in a form, copy-on-writing that form', () => {
    const doc = Document.Open(buildFormImagePdf());
    doc.Pages[0].Images.find((i) => i.Name === 'ImF')!.Remove();

    expect(doc.Pages[0].Images.map((i) => i.Name)).toEqual([]);
    // The second page shares the form object and must keep its image.
    expect(doc.Pages[1].Images.map((i) => i.Name)).toEqual(['ImF']);

    const back = Document.Open(doc.Save());
    expect(back.Pages[0].Images.map((i) => i.Name)).toEqual([]);
    expect(back.Pages[1].Images.map((i) => i.Name)).toEqual(['ImF']);
  });

  it('leaves an unrelated unreferenced resource by default', () => {
    const doc = Document.Open(buildTwiceDrawnImagePdf());
    doc.Pages[0].Images[0].Remove();
    expect(resourceKeys(doc, 'ExtGState')).toEqual(['GS0']);
  });

  it('prunes it with { sanitize: true }', () => {
    const doc = Document.Open(buildTwiceDrawnImagePdf());
    doc.Pages[0].Images[0].Remove({ sanitize: true });
    expect(resourceKeys(doc, 'ExtGState')).toEqual([]);
    expect(resourceKeys(doc, 'XObject')).toEqual([]);
  });

  // 5ttj: the payoff of widening the group walk-back. The gs is the ONLY
  // reference to /GS0, so pruning it is possible exactly when the group cut
  // takes the gs with it. Before the fix the inert 'q /GS0 gs ... cm Q' kept
  // the reference alive and this entry survived a sanitizing Remove.
  it('prunes an ExtGState referenced only inside the removed group', () => {
    const doc = Document.Open(buildGsWrappedImagePdf());
    expect(resourceKeys(doc, 'ExtGState')).toEqual(['GS0']);   // the premise
    doc.Pages[0].Images[0].Remove({ sanitize: true });
    expect(resourceKeys(doc, 'ExtGState')).toEqual([]);
    expect(savedText(doc)).not.toContain('/GS0');
  });

  it('leaves that same ExtGState alone without sanitize', () => {
    // sanitize decides which /Resources entries survive and nothing else --
    // so the un-sanitized path must still keep it, or the flag means nothing.
    const doc = Document.Open(buildGsWrappedImagePdf());
    doc.Pages[0].Images[0].Remove();
    expect(resourceKeys(doc, 'ExtGState')).toEqual(['GS0']);
  });

  it('throws RangeError for a stale handle', () => {
    const doc = Document.Open(placedPdf());
    const stale = doc.Pages[0].Images[0];
    stale.Remove();
    expect(() => stale.Remove()).toThrow(RangeError);
  });

  it('refuses a handle that is not bound to a page', () => {
    const doc = Document.Open(placedPdf());
    const unbound = new ImageInfo(doc, 'Im0', doc.Pages[0].Images[0].Stream);
    expect(() => unbound.Remove()).toThrow(UnsupportedFeatureError);
  });
});

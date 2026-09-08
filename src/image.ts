import type { Document } from './document.js';
import type { Page } from './page.js';
import { PdfDict, PdfStream, PdfObject, isDict, isStream, isName, isArray } from './types.js';
import { decodeImageStream, filterName, numOf } from './imagedecode.js';
import {
  encodeImage, type EncodedImage, type SaveImageOptions,
} from './imagehref.js';
import { UnsupportedFeatureError } from './errors.js';
import {
  replaceImage, removeImage,
  type ReplaceImageOptions, type RemoveImageOptions,
} from './imageedit.js';

/** A single embedded image XObject: a live, read-only handle over its stream. */
export class ImageInfo {
  constructor(
    private readonly doc: Document,
    /** Resource key under which the image was found (e.g. 'Im0'). */
    readonly Name: string,
    /** The live image XObject stream. */
    private readonly stream: PdfStream,
    /** The page this handle was enumerated from. Absent for an internally
     *  constructed handle -- the JBIG2-globals recursion in `Decode` builds
     *  one -- which is why the edit methods guard rather than assume. */
    private readonly page?: Page,
  ) {}

  /** The live image XObject dict. */
  get Dict(): PdfDict { return this.stream.dict; }

  /** The live image XObject stream. */
  get Stream(): PdfStream { return this.stream; }

  /** /Width (0 when absent/invalid). */
  get Width(): number { return numOf(this.doc, this.Dict, 'Width', 0); }

  /** /Height (0 when absent/invalid). */
  get Height(): number { return numOf(this.doc, this.Dict, 'Height', 0); }

  /** /BitsPerComponent; defaults to 1 for an image mask, else 8. */
  get Bits(): number {
    const im = this.doc.resolve(this.Dict.get('ImageMask'));
    return numOf(this.doc, this.Dict, 'BitsPerComponent', im === true ? 1 : 8);
  }

  /** Colorspace label: a name as-is, an array's first element name, or ''. */
  get ColorSpace(): string {
    const cs = this.doc.resolve(this.Dict.get('ColorSpace'));
    if (isName(cs)) return cs.name;
    if (isArray(cs) && cs.length > 0) {
      const head = this.doc.resolve(cs[0]);
      if (isName(head)) return head.name;
    }
    return '';
  }

  /** Effective codec filter name (last in a filter chain), or undefined. */
  get Filter(): string | undefined { return filterName(this.doc, this.Dict); }

  /** Raw encoded stream bytes (still Flate/DCT-encoded). Never throws. */
  get RawData(): Uint8Array { return this.stream.raw; }

  /** Decoded bytes. JPEG passthrough for DCTDecode; decoded 8-bit samples for
   *  Flate/LZW/ASCII chains, CCITTFaxDecode, and JPXDecode (JPEG 2000); decoded
   *  1-bpp samples for JBIG2Decode (arithmetic generic/symbol/text + MMR). */
  Decode(): Uint8Array {
    return decodeImageStream(this.doc, this.stream);
  }

  /** This image as a FILE: its encoded bytes and their media type.
   *
   *  With no `format`, the encoding is FAITHFUL — an unmasked `DCTDecode` hands
   *  back the embedded JPEG bytes verbatim, with no re-encode and no generation
   *  loss, and anything else becomes a PNG (carrying alpha where the image has
   *  an `/SMask` or `/Mask`). Name a `format` to force one; a forced format the
   *  faithful encoding already satisfies changes nothing.
   *
   *  JPEG has no alpha channel, so `format: 'jpeg'` composites any transparency
   *  onto white — naming an opaque format is the request to flatten.
   *
   *  Pair it with {@link imageExtension} for the file name: the media type is
   *  what says whether the bytes are a `.jpg` or a `.png`, and writing JPEG
   *  bytes under `.png` gives a file no viewer opens.
   *
   *  Throws {@link UnsupportedFeatureError} for a format it cannot encode
   *  (checked before any decoding, so a rejected call costs nothing) and for an
   *  image it cannot decode. Note `encodeImage` returns `undefined` there
   *  instead: its other callers are rendering a whole document, where skipping
   *  one damaged picture is right, while a caller asking for THIS image wants
   *  to be told. */
  Save(opts: SaveImageOptions = {}): EncodedImage {
    const format = opts.format;
    if (format !== undefined && format !== 'png' && format !== 'jpeg') {
      throw new UnsupportedFeatureError(
        `unsupported image format ${JSON.stringify(format)}; supported: png, jpeg`);
    }
    // Black is the PDF initial fill, and it is what a stencil /ImageMask is
    // painted with when nobody has said otherwise.
    const enc = encodeImage(this.doc, this.stream, [0, 0, 0], opts);
    if (!enc) {
      throw new UnsupportedFeatureError(
        `image ${this.Name || '<unnamed>'} cannot be encoded: ` +
        `filter ${this.Filter ?? 'none'}, ${this.Bits} bits per component`);
    }
    return enc;
  }

  /** Swap this image's picture for `data` (JPEG, PNG, BMP or TIFF), keeping its
   *  placement on the page. The new image is stretched into the existing
   *  footprint whatever its proportions.
   *
   *  Scoped to the page this handle came from: an image shared with another page
   *  is copied rather than mutated, so that page is unaffected. Throws before
   *  changing anything when `data` cannot be decoded. */
  Replace(data: Uint8Array, opts: ReplaceImageOptions = {}): void {
    replaceImage(this.doc, this.requirePage('Replace'), this.stream, data, opts);
  }

  /** Drop this image from the page this handle came from: every draw of it in
   *  the page's content (including inside Form XObjects) and its /XObject
   *  resource entry. The image object itself is swept by `Save()` unless another
   *  page still draws it.
   *
   *  `{ sanitize: true }` additionally prunes every other now-unreferenced
   *  /Font, /XObject and /ExtGState name, as redaction does. */
  Remove(opts: RemoveImageOptions = {}): void {
    removeImage(this.doc, this.requirePage('Remove'), this.stream, opts);
  }

  /** The page this handle was enumerated from, or a clear throw. */
  private requirePage(what: string): Page {
    if (!this.page)
      throw new UnsupportedFeatureError(
        `ImageInfo.${what}: this handle is not bound to a page`);
    return this.page;
  }
}

/** Enumerate image XObjects reachable from a resource dict, descending into
 *  Form XObjects. Cycle-guarded by visited /XObject dicts. */
export function collectImages(
  doc: Document, resources: PdfDict | undefined, page?: Page,
): ImageInfo[] {
  const out: ImageInfo[] = [];
  const seen = new Set<PdfDict>();
  const walk = (res: PdfObject) => {
    const r = doc.resolve(res);
    if (!isDict(r)) return;
    const xobj = doc.resolve(r.get('XObject'));
    if (!isDict(xobj) || seen.has(xobj)) return;
    seen.add(xobj);
    for (const [key, val] of xobj) {
      const obj = doc.resolve(val);
      if (!isStream(obj)) continue;
      const sub = doc.resolve(obj.dict.get('Subtype'));
      const subName = isName(sub) ? sub.name : undefined;
      if (subName === 'Image') {
        out.push(new ImageInfo(doc, key, obj, page));
      } else if (subName === 'Form') {
        walk(obj.dict.get('Resources') ?? null);
      }
    }
  };
  walk(resources ?? null);
  return out;
}

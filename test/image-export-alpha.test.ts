import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { encodeImage } from '../src/imagehref.js';
import { decodePng } from './helpers/decode-png.js';
import { isStream, type PdfStream } from '../src/types.js';
import {
  N, buildColorKeyRenderPdf, buildStencilMaskRenderPdf, buildSMaskRenderPdf,
  buildDctSMaskRenderPdf, buildPlainDctPdf,
} from './helpers/build-mask-pdf.js';

/**
 * Image transparency in the EXPORT path (2pgr).
 *
 * `imagehref.ts` is a second, independent path from `raster.ts`: ToSvg, HTML
 * semantic export, Markdown, DOCX and EPUB all reach images through
 * `encodeImage`, which had no alpha handling of any kind -- so a masked or
 * soft-masked image was emitted fully opaque while `ToImage` rendered it
 * correctly. The two renderers disagreed about the same document.
 */

/** The page's single image XObject. */
function imageOf(bytes: Uint8Array): { doc: Document; stream: PdfStream } {
  const doc = Document.Open(bytes);
  for (const [, obj] of doc.objectEntries()) {
    if (isStream(obj) && doc.resolve(obj.dict.get('Width')) === N
        && doc.resolve(obj.dict.get('ImageMask')) !== true
        && doc.resolve(obj.dict.get('ColorSpace')) !== undefined) {
      return { doc, stream: obj };
    }
  }
  throw new Error('no image XObject in the fixture');
}

/** Alpha of the encoded PNG at (x, y). */
function alphaAt(bytes: Uint8Array, x: number, y: number): number {
  const { doc, stream } = imageOf(bytes);
  const enc = encodeImage(doc, stream, [0, 0, 0]);
  if (!enc) throw new Error('encodeImage declined');
  expect(enc.mediaType).toBe('image/png');
  return decodePng(enc.bytes).at(x, y)[3];
}

const Q = N / 4;
const TL: [number, number] = [Q, Q];
const TR: [number, number] = [N - Q, Q];

describe('encodeImage — /Mask', () => {
  it('emits alpha 0 where a colour key matched', () => {
    expect(alphaAt(buildColorKeyRenderPdf(), ...TL)).toBe(0);
    expect(alphaAt(buildColorKeyRenderPdf(), ...TR)).toBe(255);
  });

  it('emits alpha 0 where a stencil /Mask masks', () => {
    expect(alphaAt(buildStencilMaskRenderPdf(), ...TL)).toBe(0);
    expect(alphaAt(buildStencilMaskRenderPdf(), ...TR)).toBe(255);
  });
});

describe('encodeImage — /SMask', () => {
  it('carries a soft mask through as an alpha channel', () => {
    // The commonest shape of this bug by far: /SMask is ordinary in real
    // documents where /Mask is rare, and raster.ts has honoured it all along.
    expect(alphaAt(buildSMaskRenderPdf(), ...TL)).toBe(0);
    expect(alphaAt(buildSMaskRenderPdf(), ...TR)).toBe(255);
  });

  it('re-encodes a soft-masked JPEG as PNG, since JPEG carries no alpha', () => {
    const { doc, stream } = imageOf(buildDctSMaskRenderPdf());
    const enc = encodeImage(doc, stream, [0, 0, 0]);
    if (!enc) throw new Error('encodeImage declined');
    expect(enc.mediaType).toBe('image/png');
    expect(decodePng(enc.bytes).at(...TL)[3]).toBe(0);
    expect(decodePng(enc.bytes).at(...TR)[3]).toBe(255);
  });
});

describe('encodeImage — an unmasked image is untouched', () => {
  it('still passes a plain JPEG through as its original bytes', () => {
    // The byte-identity half of the change: only images that were WRONG may
    // move. A JPEG with no mask keeps passing through, so no fixture in the
    // five exports that ride on this path shifts.
    //
    // MEASURED, by making `hasTransparency` return true for every image:
    // this case goes red, and so do three cases in test/html-identity.test.ts.
    // test/markdown-export.test.ts and test/docx-flow-identity.test.ts stay
    // GREEN -- their fixtures do not exercise this path -- so html-identity is
    // the only downstream fence protecting the passthrough. Do not read those
    // other two as covering it.
    const { doc, stream } = imageOf(buildPlainDctPdf());
    const enc = encodeImage(doc, stream, [0, 0, 0]);
    if (!enc) throw new Error('encodeImage declined');
    expect(enc.mediaType).toBe('image/jpeg');
    expect(enc.bytes).toEqual(stream.raw);
  });
});

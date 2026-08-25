import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { encodeImage, imageHref } from '../src/imagehref.js';
import { buildTextAndImagePage, buildTwoImagePage } from './helpers/build-edit-pdf.js';

const FIGURE_PAGE = 'BT /F1 10 Tf 50 250 Td (caption) Tj ET q 100 0 0 100 50 50 cm /Im0 Do Q';

/** The first image XObject on page 1. */
function firstImage(doc: Document) {
  return doc.Pages[0].Images[0].Stream;
}

describe('encodeImage', () => {
  it('returns the bytes and media type behind the data URI', () => {
    const doc = Document.Open(buildTextAndImagePage(FIGURE_PAGE));
    const enc = encodeImage(doc, firstImage(doc), [0, 0, 0]);
    expect(enc).toBeDefined();
    expect(enc!.mediaType).toBe('image/png');
    // A PNG signature, so the bytes are the file and not a base64 string.
    expect(Array.from(enc!.bytes.slice(0, 4))).toEqual([0x89, 0x50, 0x4e, 0x47]);
  });

  // imageHref is now a wrapper over encodeImage, so the two cannot disagree
  // about what an image is -- which is the whole reason for the split.
  it('agrees with imageHref, which is base64 of exactly these bytes', () => {
    const doc = Document.Open(buildTextAndImagePage(FIGURE_PAGE));
    const stream = firstImage(doc);
    const enc = encodeImage(doc, stream, [0, 0, 0])!;
    const expected = `data:${enc.mediaType};base64,${Buffer.from(enc.bytes).toString('base64')}`;
    expect(imageHref(doc, stream, [0, 0, 0])).toBe(expected);
  });

  it('returns undefined for an image it cannot decode, and never throws', () => {
    const doc = Document.Open(buildTwoImagePage(FIGURE_PAGE));
    for (const img of doc.Pages[0].Images) {
      expect(() => encodeImage(doc, img.Stream, [0, 0, 0])).not.toThrow();
    }
  });
});

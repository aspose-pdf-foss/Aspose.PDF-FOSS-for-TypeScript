import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { isName, isStream, isDict } from '../src/types.js';
import { tiffPageCount } from '../src/tiff.js';
import { buildTiff, baseTags } from './helpers/build-tiff.js';

function soleImage(doc: Document) {
  const res = doc.resolve(doc.Pages[0].Dict.get('Resources'));
  if (!isDict(res)) throw new Error('no resources');
  const xo = doc.resolve(res.get('XObject'));
  if (!isDict(xo)) throw new Error('no xobjects');
  const first = doc.resolve([...xo.values()][0]);
  if (!isStream(first)) throw new Error('not a stream');
  return first;
}

function withImage(bytes: Uint8Array, opts?: { page?: number }): Document {
  const doc = Document.New();
  doc.AddPage();
  doc.Pages[0].AddImage(bytes, [0, 0, 100, 100], opts);
  return doc;
}

/** A 2x2 8-bit gray TIFF whose samples are `px`. */
function grayTiff(px: number[], le = true): Uint8Array {
  return buildTiff({
    le,
    pages: [{
      tags: baseTags(2, 2, 1, [
        { tag: 258, type: 3, values: [8] }, { tag: 277, type: 3, values: [1] },
        { tag: 278, type: 4, values: [2] },
      ]),
      blocks: [Uint8Array.from(px)],
    }],
  });
}

describe('AddImage — TIFF', () => {
  it('embeds a gray TIFF as DeviceGray', () => {
    const img = soleImage(withImage(grayTiff([1, 2, 3, 4])));
    expect(img.dict.get('Width')).toBe(2);
    expect(img.dict.get('Height')).toBe(2);
    expect(img.dict.get('BitsPerComponent')).toBe(8);
    const cs = img.dict.get('ColorSpace');
    expect(isName(cs) && cs.name).toBe('DeviceGray');
  });

  it('sniffs both byte orders', () => {
    for (const le of [true, false])
      expect(soleImage(withImage(grayTiff([1, 2, 3, 4], le))).dict.get('Width')).toBe(2);
  });

  it('embeds the page named by AddImageOptions.page', () => {
    const two = buildTiff({
      pages: [
        { tags: baseTags(2, 2, 1, [
            { tag: 258, type: 3, values: [8] }, { tag: 277, type: 3, values: [1] },
            { tag: 278, type: 4, values: [2] }]),
          blocks: [Uint8Array.from([1, 2, 3, 4])] },
        { tags: baseTags(4, 1, 1, [
            { tag: 258, type: 3, values: [8] }, { tag: 277, type: 3, values: [1] },
            { tag: 278, type: 4, values: [1] }]),
          blocks: [Uint8Array.from([5, 6, 7, 8])] },
      ],
    });
    expect(tiffPageCount(two)).toBe(2);
    expect(soleImage(withImage(two)).dict.get('Width')).toBe(2);
    expect(soleImage(withImage(two, { page: 1 })).dict.get('Width')).toBe(4);
  });

  it('throws rather than silently ignoring page on a format with no pages', () => {
    // Accepting an option and ignoring it is the trap textedit.ts's `region` is
    // documented against: a caller who thinks they selected page 3 and got page
    // 1 has no way to tell.
    const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const doc = Document.New();
    doc.AddPage();
    expect(() => doc.Pages[0].AddImage(png, [0, 0, 10, 10], { page: 1 }))
      .toThrow(/page/);
  });

  it('survives a Save round trip', () => {
    const reopened = Document.Open(withImage(grayTiff([1, 2, 3, 4])).Save());
    expect(soleImage(reopened).dict.get('Height')).toBe(2);
  });

  it('still refuses a format it does not know', () => {
    const doc = Document.New();
    doc.AddPage();
    expect(() => doc.Pages[0].AddImage(Uint8Array.from([1, 2, 3, 4]), [0, 0, 10, 10]))
      .toThrow(/JPEG, PNG, BMP or TIFF/);
  });
});

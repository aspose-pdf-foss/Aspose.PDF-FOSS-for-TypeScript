import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { isName, isStream, isArray, isDict } from '../src/types.js';
import { buildBmp } from './helpers/build-bmp.js';

/** The one image XObject on page 1 of a freshly built document. */
function soleImage(doc: Document) {
  const page = doc.Pages[0];
  const res = doc.resolve(page.Dict.get('Resources'));
  if (!isDict(res)) throw new Error('no resources');
  const xo = doc.resolve(res.get('XObject'));
  if (!isDict(xo)) throw new Error('no xobjects');
  const first = doc.resolve([...xo.values()][0]);
  if (!isStream(first)) throw new Error('not a stream');
  return first;
}

/** Build a one-page document with `bytes` drawn on it. */
function withImage(bytes: Uint8Array): Document {
  const doc = Document.New();
  doc.AddPage();
  doc.Pages[0].AddImage(bytes, [0, 0, 100, 100]);
  return doc;
}

describe('AddImage — BMP', () => {
  it('embeds a 24-bit BMP as DeviceRGB', () => {
    const bmp = buildBmp({
      width: 2, height: 2, bpp: 24,
      rows: [[0, 0, 0xff, 0, 0xff, 0, 0, 0], [0xff, 0, 0, 0xff, 0xff, 0xff, 0, 0]],
    });
    const img = soleImage(withImage(bmp));
    expect(img.dict.get('Width')).toBe(2);
    expect(img.dict.get('Height')).toBe(2);
    expect(img.dict.get('BitsPerComponent')).toBe(8);
    const cs = img.dict.get('ColorSpace');
    expect(isName(cs) && cs.name).toBe('DeviceRGB');
    expect(img.dict.has('SMask')).toBe(false);
  });

  it('embeds a palette BMP as /Indexed, keeping its 4-bit samples packed', () => {
    const bmp = buildBmp({
      width: 4, height: 2, bpp: 4,
      palette: [[0, 0, 0xff], [0, 0xff, 0], [0xff, 0, 0], [0xff, 0xff, 0xff]],
      rows: [[0x01, 0x23, 0, 0], [0x32, 0x10, 0, 0]],
    });
    const doc = withImage(bmp);
    const img = soleImage(doc);
    expect(img.dict.get('BitsPerComponent')).toBe(4);
    const cs = doc.resolve(img.dict.get('ColorSpace'));
    if (!isArray(cs)) throw new Error('expected an /Indexed array');
    expect(isName(cs[0]) && cs[0].name).toBe('Indexed');
    expect(cs[2]).toBe(3);   // hival: 4 palette entries
  });

  it('gives a declared-alpha BMP an /SMask and a BGRX one none', () => {
    const withAlpha = buildBmp({
      width: 2, height: 1, bpp: 32, dibSize: 108, compression: 3,
      masks: [0x00ff0000, 0x0000ff00, 0x000000ff, 0xff000000],
      rows: [[0xff, 0, 0, 0x80, 0, 0xff, 0, 0xff]],
    });
    const bgrx = buildBmp({
      width: 2, height: 1, bpp: 32,
      rows: [[0xff, 0, 0, 0, 0, 0xff, 0, 0]],
    });
    for (const [bytes, wantMask] of [[withAlpha, true], [bgrx, false]] as const) {
      expect(soleImage(withImage(bytes)).dict.has('SMask')).toBe(wantMask);
    }
  });

  it('unwraps a BMP wrapping a JPEG into a DCTDecode passthrough', () => {
    // A minimal baseline JPEG: SOI, SOF0 declaring 1x1 grayscale, EOI.
    const jpeg = Uint8Array.from([
      0xff, 0xd8,
      0xff, 0xc0, 0x00, 0x0b, 0x08, 0x00, 0x01, 0x00, 0x01, 0x01, 0x01, 0x11, 0x00,
      0xff, 0xd9,
    ]);
    const bmp = buildBmp({
      width: 1, height: 1, bpp: 24, compression: 4, rows: [], rawPixels: jpeg,
    });
    const img = soleImage(withImage(bmp));
    const f = img.dict.get('Filter');
    expect(isName(f) && f.name).toBe('DCTDecode');
    expect(Array.from(img.raw)).toEqual(Array.from(jpeg));
  });

  it('survives a Save round trip', () => {
    const bmp = buildBmp({
      width: 2, height: 2, bpp: 24,
      rows: [[0, 0, 0xff, 0, 0xff, 0, 0, 0], [0xff, 0, 0, 0xff, 0xff, 0xff, 0, 0]],
    });
    const reopened = Document.Open(withImage(bmp).Save());
    expect(soleImage(reopened).dict.get('Width')).toBe(2);
  });

  it('still refuses a format it does not know', () => {
    const doc = Document.New();
    doc.AddPage();
    // Anchored on the stable phrase, not on the list of accepted formats: that
    // list grows every time an input format is added, and it is pinned in
    // exactly one place (test/tiff-embed.test.ts) so it cannot rot unnoticed.
    expect(() => doc.Pages[0].AddImage(Uint8Array.from([1, 2, 3, 4]), [0, 0, 10, 10]))
      .toThrow(/unrecognized image format/);
  });

  it('does not claim a non-BMP file that happens to start with "BM"', () => {
    // "BM" is only two bytes of magic. Without the DIB-size check beside it,
    // this is claimed by the BMP path and fails deep inside the decoder with a
    // message about a header field instead of here.
    const impostor = new Uint8Array(64);
    impostor[0] = 0x42; impostor[1] = 0x4d;
    impostor[14] = 0x29;                        // DIB size 41: not one of the six
    const doc = Document.New();
    doc.AddPage();
    expect(() => doc.Pages[0].AddImage(impostor, [0, 0, 10, 10]))
      .toThrow(/unrecognized image format/);
  });
});

import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import * as F from './helpers/jbig2-fixtures.js';

function firstImage(bytes: Uint8Array) {
  const doc = Document.Open(bytes);
  return { doc, img: doc.Pages[0].Images[0] };
}

describe('JBIG2Decode end-to-end', () => {
  it('decodes a generic-region image to the expected 1-bpp samples', () => {
    const { img } = firstImage(F.generic_pdf);
    expect(Array.from(img.Decode())).toEqual(Array.from(F.generic_samples));
  });

  it('decodes a symbol-dictionary + text-region image', () => {
    const { img } = firstImage(F.symtext_pdf);
    expect(Array.from(img.Decode())).toEqual(Array.from(F.symtext_samples));
  });

  it('honors /JBIG2Globals shared symbol dictionaries', () => {
    const { img } = firstImage(F.globals_pdf);
    expect(Array.from(img.Decode())).toEqual(Array.from(F.globals_samples));
  });

  it('rasterizes a JBIG2 page (ToImage smoke)', () => {
    const doc = Document.Open(F.generic_pdf);
    const png = doc.Pages[0].ToImage({ scale: 1 });
    expect(png.length).toBeGreaterThan(8);
    expect(Array.from(png.subarray(0, 4))).toEqual([0x89, 0x50, 0x4e, 0x47]); // PNG signature
  });
});

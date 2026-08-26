import { createHash } from 'node:crypto';
import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { UnsupportedFeatureError } from '../src/errors.js';
import { IMAGE_FORMATS, type ImageOptions } from '../src/raster.js';
import { buildSvgPdf } from './helpers/build-svg-fixtures.js';

/** A page with vector fill, so the bytes compared below are a real render
 *  rather than a uniform field that would hash the same however it was made. */
const doc = () => Document.Open(buildSvgPdf({
  mediaBox: [0, 0, 120, 90],
  content: '1 0 0 rg 10 10 50 40 re f 0 0 1 rg 60 40 50 40 re f',
}));

describe('ImageOptions.format', () => {
  it('defaults to PNG, byte-identical to naming it explicitly', () => {
    const implicit = doc().Pages[0].ToImage();
    const explicit = doc().Pages[0].ToImage({ format: 'png' });

    expect(explicit).toEqual(implicit);
  });

  // THE FENCE for the whole raster-output epic. Every later encoder (JPEG,
  // TIFF, BMP, GIF) adds a case to the same dispatch point, and this is what
  // says the PNG path did not move when they did.
  //
  // It has to be a RECORDED hash rather than the comparison above. That one
  // puts both sides through `encodeCanvas`, so a change to the PNG encoding
  // moves them together and it stays green — the differential trap this repo
  // already records against `cff.ts`. Measured: swapping `toPng`'s opaque flag
  // reddens this assertion and leaves the comparison above passing.
  //
  // Never regenerate this literal to make a build pass. A red line here means
  // the PNG bytes changed; find out why before touching the number.
  it('emits the recorded PNG bytes for a known page', () => {
    const png = doc().Pages[0].ToImage({ format: 'png' });

    expect(png.length).toBe(314);
    expect(createHash('sha256').update(png).digest('hex'))
      .toBe('829b61f015ddd9ffc38ec26e096225830f5488023fa2c14bff69bde5d61c17e1');
  });

  it('leaves the other options working under an explicit format', () => {
    const scaled = doc().Pages[0].ToImage({ format: 'png', scale: 2 });
    const plain = doc().Pages[0].ToImage({ format: 'png' });

    // Same content, more pixels — so the option is read, not swallowed.
    expect(scaled.length).toBeGreaterThan(plain.length);
  });

  it('lists every encoding it can produce', () => {
    expect([...IMAGE_FORMATS]).toEqual(['png', 'jpeg', 'tiff', 'bmp', 'gif']);
  });

  // A JS caller has no compile-time union to stop them. Silently returning PNG
  // bytes for an unsupported format is the ".png holding JPEG bytes" hazard:
  // the file is written under the wrong extension and no viewer opens it.
  // The probe uses an encoding we do not plan to add, so this stays a test of
  // the guard rather than of which formats happen to be implemented today.
  it('refuses a format it cannot encode rather than returning PNG bytes', () => {
    const page = doc().Pages[0];
    const bad = { format: 'webp' } as unknown as ImageOptions;

    expect(() => page.ToImage(bad)).toThrow(UnsupportedFeatureError);
    expect(() => page.ToImage(bad)).toThrow(/webp/);
  });
});

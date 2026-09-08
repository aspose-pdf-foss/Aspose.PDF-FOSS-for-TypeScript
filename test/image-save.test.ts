import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { PageFormat } from '../src/pageformat.js';
import { UnsupportedFeatureError } from '../src/errors.js';
import { encodeJpeg } from '../src/jpegencode.js';
import { decodeJpeg } from '../src/jpeg.js';
import { imageExtension } from '../src/imagehref.js';
import type { ImageInfo } from '../src/image.js';
import { decodePng } from './helpers/decode-png.js';
import { buildPng, buildPngRgb, buildPngRgba, RGBA_PIXEL } from './helpers/build-embed-images.js';

/** Embed `data` as the only image of a one-page document and hand back its
 *  handle — the public route, so the fixtures are the shapes `AddImage`
 *  actually produces: a JPEG stays DCTDecode, a PNG becomes Flate (with an
 *  /SMask when it carries alpha). */
function embedded(data: Uint8Array): ImageInfo {
  const doc = Document.New();
  const { page } = doc.AddPage(PageFormat.A4);
  page.AddImage(data, [10, 10, 50, 50]);
  return page.Images[0];
}

/** JPEG codes 8x8 blocks and subsamples chroma, so a 2-pixel image round-trips
 *  to nothing like itself — measured, a 2x1 red/green pair comes back
 *  (89,90,0). Every fixture that has to survive a JPEG is therefore 16x16, and
 *  every pixel probe is a block INTERIOR, away from the edge ringing. */
const SIZE = 16;

/** A 16x16 image, red in its left half and blue in its right. */
function halves(channels: 3 | 4): number[] {
  const rows: number[] = [];
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const left = x < SIZE / 2;
      rows.push(left ? 255 : 0, 0, left ? 0 : 255);
      if (channels === 4) rows.push(255);
    }
  }
  return rows;
}

/** The same halves as a real, decodable JPEG. Hand-built JPEGs elsewhere in the
 *  suite carry no scan data — enough for passthrough, useless the moment
 *  something has to decode one. */
const realJpeg = () =>
  encodeJpeg(SIZE, SIZE, new Uint8Array(halves(3)), 'rgb', { quality: 95 });

/** The same halves as a Flate RGB image. */
const flatePng = () => buildPng(SIZE, SIZE, 2, halves(3));

/** 16x16 solid red at alpha 128, which AddImage embeds as Flate + /SMask. */
const alphaPng = () => {
  const rows: number[] = [];
  for (let i = 0; i < SIZE * SIZE; i++) rows.push(RGBA_PIXEL.r, RGBA_PIXEL.g, RGBA_PIXEL.b, RGBA_PIXEL.a);
  return buildPng(SIZE, SIZE, 6, rows);
};

describe('ImageInfo.Save (faithful, no format)', () => {
  it('hands back an unmasked JPEG byte for byte', () => {
    // The whole point of the faithful default: no re-encode, no generation
    // loss, and the extracted file is what the producer embedded.
    const img = embedded(realJpeg());
    const saved = img.Save();
    expect(saved.mediaType).toBe('image/jpeg');
    expect(saved.bytes).toEqual(img.RawData);
  });

  it('encodes a Flate image as PNG', () => {
    const saved = embedded(buildPngRgb()).Save();
    expect(saved.mediaType).toBe('image/png');
    const png = decodePng(saved.bytes);
    expect(png.width).toBe(2);
    expect(png.at(0, 0).slice(0, 3)).toEqual([255, 0, 0]);
    expect(png.at(1, 0).slice(0, 3)).toEqual([0, 255, 0]);
  });

  it('encodes an /ImageMask stencil as PNG', () => {
    const img = embedded(buildPngRgb());
    img.Dict.set('ImageMask', true);
    img.Dict.delete('ColorSpace');
    expect(img.Save().mediaType).toBe('image/png');
  });

  it('keeps an /SMask as PNG alpha', () => {
    const saved = embedded(alphaPng()).Save();
    expect(saved.mediaType).toBe('image/png');
    expect(decodePng(saved.bytes).at(0, 0)[3]).toBe(RGBA_PIXEL.a);
  });
});

describe("ImageInfo.Save({ format: 'png' })", () => {
  it('re-encodes a DCT image to PNG with the same picture', () => {
    const img = embedded(realJpeg());
    const saved = img.Save({ format: 'png' });
    expect(saved.mediaType).toBe('image/png');
    const png = decodePng(saved.bytes);
    expect(png.width).toBe(SIZE);
    expect(png.height).toBe(SIZE);
    // Against the JPEG's OWN decoded pixels rather than the source RGB, so the
    // comparison measures the re-encode and not the codec's loss. Probing both
    // halves is what makes it see a transposed or mirrored re-encode.
    const jpg = decodeJpeg(img.RawData);
    for (const x of [3, 12]) {
      const i = (4 * SIZE + x) * 3;
      const [r, g, b] = png.at(x, 4);
      expect(Math.abs(r - jpg.data[i])).toBeLessThanOrEqual(2);
      expect(Math.abs(g - jpg.data[i + 1])).toBeLessThanOrEqual(2);
      expect(Math.abs(b - jpg.data[i + 2])).toBeLessThanOrEqual(2);
    }
  });

  it('writes an opaque picture with no alpha channel', () => {
    // A third of the bytes. This is the branch a photo extraction takes, so the
    // saving is the common case rather than a corner.
    expect(decodePng(embedded(realJpeg()).Save({ format: 'png' }).bytes).channels).toBe(3);
  });

  it('leaves a Flate image on the PNG path it already took', () => {
    const img = embedded(buildPngRgb());
    expect(img.Save({ format: 'png' }).bytes).toEqual(img.Save().bytes);
  });

  it('keeps alpha', () => {
    const saved = embedded(alphaPng()).Save({ format: 'png' });
    expect(decodePng(saved.bytes).at(0, 0)[3]).toBe(RGBA_PIXEL.a);
  });
});

describe("ImageInfo.Save({ format: 'jpeg' })", () => {
  it('re-encodes a Flate image to JPEG', () => {
    const saved = embedded(flatePng()).Save({ format: 'jpeg' });
    expect(saved.mediaType).toBe('image/jpeg');
    const jpg = decodeJpeg(saved.bytes);
    expect(jpg.width).toBe(SIZE);
    const at = (x: number) => (4 * SIZE + x) * 3;
    expect(jpg.data[at(3)]).toBeGreaterThan(200);        // left half still red
    expect(jpg.data[at(3) + 2]).toBeLessThan(60);
    expect(jpg.data[at(12) + 2]).toBeGreaterThan(200);   // right half still blue
    expect(jpg.data[at(12)]).toBeLessThan(60);
  });

  it('composites alpha onto white, since JPEG has no alpha channel', () => {
    // RGBA_PIXEL is red at alpha 128, so over white it lands near (255,128,128)
    // — the green channel is what separates a composite from a bare drop of the
    // alpha, which would leave it 0.
    const saved = embedded(alphaPng()).Save({ format: 'jpeg' });
    const jpg = decodeJpeg(saved.bytes);
    const g = jpg.data[(4 * SIZE + 4) * 3 + 1];
    expect(g).toBeGreaterThan(100);
    expect(g).toBeLessThan(160);
  });

  it('still passes an unmasked JPEG through rather than re-encoding it', () => {
    const img = embedded(realJpeg());
    expect(img.Save({ format: 'jpeg' }).bytes).toEqual(img.RawData);
  });

  it('honours quality when it does re-encode', () => {
    const img = embedded(flatePng());
    const low = img.Save({ format: 'jpeg', quality: 10 }).bytes;
    const high = img.Save({ format: 'jpeg', quality: 95 }).bytes;
    expect(low.length).toBeLessThan(high.length);
  });
});

describe('ImageInfo.Save (refusals)', () => {
  it('throws for a format it cannot encode', () => {
    const img = embedded(buildPngRgb());
    expect(() => img.Save({ format: 'tiff' as 'png' })).toThrow(UnsupportedFeatureError);
  });

  it('throws for an image it cannot decode, naming the resource key', () => {
    const img = embedded(buildPngRgb());
    img.Dict.set('BitsPerComponent', 4);   // no longer a shape samplesToPng can encode
    expect(() => img.Save()).toThrow(UnsupportedFeatureError);
    expect(() => img.Save()).toThrow(/Im0/);
  });

  it('checks the format before decoding anything', () => {
    // A rejected format must cost nothing, so it is refused even for an image
    // that could not have been encoded either way.
    const img = embedded(buildPngRgb());
    img.Dict.set('BitsPerComponent', 4);
    expect(() => img.Save({ format: 'gif' as 'png' })).toThrow(/format/);
  });
});

describe('imageExtension', () => {
  it('names the file after the media type, not the other way round', () => {
    expect(imageExtension('image/jpeg')).toBe('jpg');
    expect(imageExtension('image/png')).toBe('png');
  });
});

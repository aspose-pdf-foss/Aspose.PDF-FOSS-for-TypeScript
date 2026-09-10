import { describe, it, expect } from 'vitest';
import { inflateSync } from 'node:zlib';
import { Document } from '../src/document.js';
import { decodeTiff, tiffPageCount } from '../src/tiff.js';
import { decodeBmp } from '../src/bmp.js';
import { decodeJpeg } from '../src/jpeg.js';
import { UnsupportedFeatureError } from '../src/errors.js';
import { buildSvgPdf } from './helpers/build-svg-fixtures.js';
import { decodePng } from './helpers/decode-png.js';
import { decodeGif } from './helpers/decode-gif.js';

/**
 * Greyscale and bilevel raster output (`4gtd.6`).
 *
 * **The fixture is SATURATED COLOUR on purpose.** A page that is already black
 * on white cannot tell `mode: 'gray'` from `mode: 'rgb'` at all — both give the
 * same bytes per pixel — so every case here paints pure red, whose Rec. 601
 * luma is 76. That number is also what discriminates the WEIGHTS: Rec. 709
 * would give 54 for the same red, and this library uses 601 because that is
 * what the rest of the PDF tooling emits and what a YCbCr JPEG's Y channel IS.
 */

const RED_LUMA = 76;      // round(0.299 * 255); Rec. 709 would say 54

/** Pure red on the left half, white on the right. */
const page = (w = 120, h = 90) => Document.Open(buildSvgPdf({
  mediaBox: [0, 0, w, h],
  content: `1 0 0 rg 0 0 ${w / 2} ${h} re f`,
})).Pages[0];

/** A page of one flat grey, stated as a DeviceGray fill. */
const greyPage = (g: number) => Document.Open(buildSvgPdf({
  mediaBox: [0, 0, 40, 20],
  content: `${g} g 0 0 40 20 re f`,
})).Pages[0];

/** One bit out of MSB-first rows padded to a byte — the packing TIFF bilevel
 *  and 1-bit PNG share, and the only thing that differs between them is what
 *  a set bit MEANS. */
const bitAt = (bytes: Uint8Array, width: number, x: number, y: number): number => {
  const stride = (width + 7) >> 3;
  return (bytes[y * stride + (x >> 3)] >> (7 - (x & 7))) & 1;
};

/** IHDR fields plus the unfiltered rows, read here rather than through
 *  `decode-png.ts`, which handles 8-bit only. Asserting the BITS is the point:
 *  a decoder that normalises polarity would hide the one rule most likely to
 *  be reversed. Every row here uses filter 0, which is what `encodePng` emits. */
function rawPng(bytes: Uint8Array) {
  const u32 = (o: number) => ((bytes[o] << 24) | (bytes[o + 1] << 16) | (bytes[o + 2] << 8) | bytes[o + 3]) >>> 0;
  let off = 8, width = 0, height = 0, bitDepth = 0, colorType = 0;
  const idat: Uint8Array[] = [];
  while (off + 8 <= bytes.length) {
    const len = u32(off);
    const type = String.fromCharCode(bytes[off + 4], bytes[off + 5], bytes[off + 6], bytes[off + 7]);
    const data = bytes.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR') {
      width = u32(off + 8); height = u32(off + 12);
      bitDepth = data[8]; colorType = data[9];
    } else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    off += 12 + len;
  }
  const raw = new Uint8Array(inflateSync(Buffer.concat(idat.map((d) => Buffer.from(d)))));
  const stride = Math.ceil((width * bitDepth) / 8);
  const rows = new Uint8Array(height * stride);
  for (let y = 0; y < height; y++) {
    expect(raw[y * (stride + 1)]).toBe(0);       // filter None
    rows.set(raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1)), y * stride);
  }
  return { width, height, bitDepth, colorType, rows };
}

describe('page.ToImage — mode: gray', () => {
  it('emits a single-channel PNG at Rec. 601 luma', () => {
    const p = decodePng(page().ToImage({ mode: 'gray' }));
    expect(p.colorType).toBe(0);                 // greyscale, not RGB with equal channels
    expect(p.channels).toBe(1);
    expect(p.data[0]).toBeGreaterThanOrEqual(RED_LUMA - 1);
    expect(p.data[0]).toBeLessThanOrEqual(RED_LUMA + 1);   // 54 (Rec. 709) fails here
    expect(p.data[119]).toBe(255);               // the white half
  });

  it('emits a single-channel TIFF', () => {
    const img = decodeTiff(page().ToImage({ format: 'tiff', mode: 'gray' }));
    expect(img.kind).toBe('gray');
    if (img.kind !== 'gray') throw new Error('unreachable');
    expect(img.bpc).toBe(8);
    expect(img.samples[0]).toBeGreaterThanOrEqual(RED_LUMA - 1);
    expect(img.samples[0]).toBeLessThanOrEqual(RED_LUMA + 1);
    expect(img.samples[119]).toBe(255);
  });

  it('emits a single-component JPEG', () => {
    const j = decodeJpeg(page().ToImage({ format: 'jpeg', mode: 'gray' }));
    expect(j.comps).toBe(1);
    // Lossy, so a band rather than a value — but one 54 and 255 both miss.
    expect(j.data[0]).toBeGreaterThan(RED_LUMA - 12);
    expect(j.data[0]).toBeLessThan(RED_LUMA + 12);
  });

  it('greys a GIF through its palette, exactly', () => {
    // <= 256 colours passes through `quantize` untouched, so this is lossless
    // even though GIF is a lossy format for a photograph.
    const g = decodeGif(page().ToImage({ format: 'gif', mode: 'gray' }));
    expect([g.rgb[0], g.rgb[1], g.rgb[2]]).toEqual([RED_LUMA, RED_LUMA, RED_LUMA]);
  });

  it('greys a BMP, which has no gray form here and so carries equal channels', () => {
    const img = decodeBmp(page().ToImage({ format: 'bmp', mode: 'gray' }));
    expect(img.kind).toBe('rgb');
    if (img.kind !== 'rgb') throw new Error('unreachable');
    // BMP rows are stored bottom-up; the decoder has already flipped them.
    expect([img.samples[0], img.samples[1], img.samples[2]])
      .toEqual([RED_LUMA, RED_LUMA, RED_LUMA]);
  });
});

describe('page.ToImage — mode: bilevel', () => {
  // THE acceptance criterion: G4 refuses anything but a bilevel frame rather
  // than thresholding, so before this the compression option could never
  // succeed for a rendered page at all.
  it('produces a G4 TIFF that reads back', () => {
    const img = decodeTiff(page().ToImage({ format: 'tiff', compression: 'g4', mode: 'bilevel' }));
    expect(img.kind).toBe('gray');
    if (img.kind !== 'gray') throw new Error('unreachable');
    expect(img.bpc).toBe(1);
    // `tiff.ts` normalises to the DeviceGray convention, 0 = BLACK — so red
    // (luma 76, under the default threshold) is 0 and the white half is 1.
    // Writing the bits the other way round round-trips as the NEGATIVE, which
    // is exactly what this asserts against.
    expect(bitAt(img.samples, img.width, 5, 5)).toBe(0);
    expect(bitAt(img.samples, img.width, 115, 5)).toBe(1);
  });

  it('produces a deflate TIFF too, not only G4', () => {
    const img = decodeTiff(page().ToImage({ format: 'tiff', mode: 'bilevel' }));
    if (img.kind !== 'gray') throw new Error('unreachable');
    expect(img.bpc).toBe(1);
    expect(bitAt(img.samples, img.width, 5, 5)).toBe(0);
  });

  it('emits a 1-bit PNG, whose polarity is the OPPOSITE of TIFF bilevel', () => {
    // PNG colour type 0 at depth 1: 0 is BLACK. TIFF bilevel here declares
    // PhotometricInterpretation 0 (WhiteIsZero) and carries 1 = BLACK. Same
    // packing, inverted meaning — one packer with an explicit polarity, or one
    // of the two comes out a perfect negative and reads as a deliberate effect.
    const p = rawPng(page().ToImage({ mode: 'bilevel' }));
    expect(p.bitDepth).toBe(1);
    expect(p.colorType).toBe(0);
    expect(bitAt(p.rows, p.width, 5, 5)).toBe(0);      // red -> black -> 0
    expect(bitAt(p.rows, p.width, 115, 5)).toBe(1);    // white -> 1
  });

  it('reduces a GIF to two palette entries', () => {
    const g = decodeGif(page().ToImage({ format: 'gif', mode: 'bilevel' }));
    expect([g.rgb[0], g.rgb[1], g.rgb[2]]).toEqual([0, 0, 0]);
    const p = (5 * g.width + 115) * 3;
    expect([g.rgb[p], g.rgb[p + 1], g.rgb[p + 2]]).toEqual([255, 255, 255]);
  });

  it('cuts at the threshold, which is a plain cut rather than a dither', () => {
    // 0.6 grey is 153. **A one-sided fixture measures nothing:** under the
    // default 128 it is white, and under a threshold of 200 it is black — the
    // same page, opposite answers, which is what pins the option rather than
    // the default.
    const grey = greyPage(0.6);
    const dflt = rawPng(grey.ToImage({ mode: 'bilevel' }));
    expect(bitAt(dflt.rows, dflt.width, 5, 5)).toBe(1);            // white
    const high = rawPng(grey.ToImage({ mode: 'bilevel', threshold: 200 }));
    expect(bitAt(high.rows, high.width, 5, 5)).toBe(0);            // black
    // ...and a threshold below it puts it back to white, so the comparison is
    // the stated direction rather than "any threshold flips it".
    const low = rawPng(grey.ToImage({ mode: 'bilevel', threshold: 100 }));
    expect(bitAt(low.rows, low.width, 5, 5)).toBe(1);
  });
});

describe('doc.ToTiff — the multi-page path honours the mode too', () => {
  // The case the issue actually names: multi-page G4 is what archival and fax
  // pipelines interchange, and `renderPageToTiffFrame` builds its frames
  // separately from `encodeCanvas`, so it needs the mode on its own account.
  it('writes a multi-page G4 TIFF', () => {
    const doc = Document.Open(buildSvgPdf({
      mediaBox: [0, 0, 60, 40],
      content: '1 0 0 rg 0 0 30 40 re f',
    }));
    doc.AddPage();
    const t = doc.ToTiff({ compression: 'g4', mode: 'bilevel' });
    const img = decodeTiff(t, 0);
    if (img.kind !== 'gray') throw new Error('unreachable');
    expect(img.bpc).toBe(1);
    expect(bitAt(img.samples, img.width, 5, 5)).toBe(0);
    // The second page too: `encodeTiff` refuses G4 unless EVERY frame is
    // bilevel, so a mode applied to only the first would not have produced a
    // file at all — and asserting the second's depth says which rule held.
    expect(tiffPageCount(t)).toBe(2);
    const second = decodeTiff(t, 1);
    if (second.kind !== 'gray') throw new Error('unreachable');
    expect(second.bpc).toBe(1);
  });
});

describe('page.ToImage — what a mode refuses', () => {
  const p = page();

  it('refuses bilevel for JPEG, which has no bilevel form', () => {
    // Refused rather than emitted as a grey JPEG: thresholded pixels through a
    // DCT come back with ringing round every edge, a plausible-looking file
    // that is not what was asked for. Same posture `format` already takes.
    expect(() => p.ToImage({ format: 'jpeg', mode: 'bilevel' })).toThrow(UnsupportedFeatureError);
  });

  it('accepts gray for JPEG, so the refusal is about bilevel alone', () => {
    expect(() => p.ToImage({ format: 'jpeg', mode: 'gray' })).not.toThrow();
  });

  it('refuses a non-rgb mode with a transparent background', () => {
    expect(() => p.ToImage({ mode: 'gray', background: 'transparent' }))
      .toThrow(UnsupportedFeatureError);
    expect(() => p.ToImage({ mode: 'bilevel', background: 'transparent' }))
      .toThrow(UnsupportedFeatureError);
    // ...and rgb with transparency still works, so this is about the mode.
    expect(() => p.ToImage({ mode: 'rgb', background: 'transparent' })).not.toThrow();
  });

  it('refuses an unrecognised mode rather than falling back to rgb', () => {
    // TypeScript stops it at the call site, but this ships as JavaScript too.
    expect(() => p.ToImage({ mode: 'grayscale' as 'gray' })).toThrow(UnsupportedFeatureError);
  });

  it('refuses a threshold outside 0..255', () => {
    for (const t of [-1, 256, 1.5, NaN]) {
      expect(() => p.ToImage({ mode: 'bilevel', threshold: t })).toThrow(TypeError);
    }
  });
});

describe('page.ToImage — the default path does not move', () => {
  it('gives byte-identical output for an unset mode and an explicit rgb', () => {
    const p = page();
    for (const format of ['png', 'tiff', 'bmp', 'gif', 'jpeg'] as const) {
      expect(p.ToImage({ format })).toEqual(p.ToImage({ format, mode: 'rgb' }));
    }
  });
});

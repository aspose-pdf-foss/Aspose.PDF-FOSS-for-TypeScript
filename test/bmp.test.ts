import { describe, it, expect } from 'vitest';
import { decodeBmp } from '../src/bmp.js';
import { PdfParseError, UnsupportedFeatureError } from '../src/errors.js';
import { buildBmp } from './helpers/build-bmp.js';

/**
 * WHAT THESE FIXTURES COVER, measured by mutation rather than assumed. Each
 * change below was applied to src/bmp.ts in turn and both BMP test files
 * re-run (38 cases total):
 *
 *   1 no row flip                    RED, 7 cases
 *   2 no BGR swap                    RED, 3
 *   3 file stride copied whole       RED, 6
 *   4 alpha honoured always          RED, 3
 *   5 pixel offset computed          RED, 8
 *   6 V2 masks read after header     RED, 4
 *   7 palette entry always 4         RED, 1
 *   8 truncate instead of round      RED, 1
 *
 * All eight redden, but two do so by a single case each and are worth knowing
 * about: mutation 7 is caught ONLY by the BITMAPCOREHEADER fixture and
 * mutation 8 ONLY by the 5-bit-3 channel value, since rounding, truncation and
 * bit replication agree at 0 and at full scale.
 *
 * Fixture traps this file is built around, all three of which make an
 * assertion pass whatever the code does: a vertically symmetric image cannot
 * see the row flip, a grey image cannot see the BGR swap, and a square image
 * cannot see a width/height transposition. Every fixture here is asymmetric,
 * non-grey and -- from ANCHOR_32 onward -- non-square.
 *
 * Since 10u9.8 there is a companion, test/bmp-real.test.ts, running BMPs from
 * GDI+ -- the format owner's own writer -- against bmp-js as an independent
 * reader. It corroborates the palette, 16-bit and 32-bit paths, which were
 * anchored here on our own builder alone. It does NOT subsume this file:
 * measured, nothing there catches a mutation this file misses, and mutation 8
 * below it does not catch AT ALL, because floor and round agree except where
 * the fraction crosses a half and its quantized source never lands on one.
 * The two published hex dumps below likewise remain the only anchor for the
 * BITMAPCOREHEADER 3-byte palette entry.
 *
 * One mutation was initially written wrong and is recorded so it is not
 * repeated: `out.set(src.subarray(0, Math.min(src.length, outStride)), ...)`
 * is a NO-OP, because the packed stride never exceeds the padded one. The
 * mutation that actually tests the restride is `out.set(src, ...)`.
 */

/**
 * Wikipedia's "BMP file format" Example 1: a 2x2, 24-bit, BITMAPINFOHEADER,
 * BI_RGB file, transcribed byte for byte.
 *
 * Rows are stored bottom-up, so the FIRST row in the file is the bottom one:
 *   file row 0 (bottom): red, white
 *   file row 1 (top):    blue, green
 * Decoded top-down, the raster must therefore read blue, green, red, white.
 *
 * This fixture is non-grey (so an unswapped BGR decode turns red into blue and
 * is visible) and vertically asymmetric (so a missing row flip is visible). It
 * is SQUARE, so it cannot see a width/height transposition -- ANCHOR_32 below
 * is 4x2 and covers that.
 */
const ANCHOR_24 = Uint8Array.from([
  0x42, 0x4d,                                     // "BM"
  0x46, 0x00, 0x00, 0x00,                         // bfSize = 70
  0x00, 0x00, 0x00, 0x00,                         // reserved
  0x36, 0x00, 0x00, 0x00,                         // bfOffBits = 54
  0x28, 0x00, 0x00, 0x00,                         // DIB size = 40
  0x02, 0x00, 0x00, 0x00,                         // width = 2
  0x02, 0x00, 0x00, 0x00,                         // height = 2 (bottom-up)
  0x01, 0x00,                                     // planes = 1
  0x18, 0x00,                                     // bpp = 24
  0x00, 0x00, 0x00, 0x00,                         // BI_RGB
  0x10, 0x00, 0x00, 0x00,                         // sizeImage = 16
  0x13, 0x0b, 0x00, 0x00,                         // 2835 px/m
  0x13, 0x0b, 0x00, 0x00,                         // 2835 px/m
  0x00, 0x00, 0x00, 0x00,                         // clrUsed = 0
  0x00, 0x00, 0x00, 0x00,                         // clrImportant = 0
  0x00, 0x00, 0xff, 0xff, 0xff, 0xff, 0x00, 0x00, // bottom row: red, white, pad
  0xff, 0x00, 0x00, 0x00, 0xff, 0x00, 0x00, 0x00, // top row: blue, green, pad
]);

describe('decodeBmp — 24-bit BI_RGB, anchored on the published dump', () => {
  it('decodes the published 2x2 file to top-down RGB', () => {
    expect(ANCHOR_24.length).toBe(70);   // the transcription is self-consistent
    const img = decodeBmp(ANCHOR_24);
    expect(img.kind).toBe('rgb');
    if (img.kind !== 'rgb') throw new Error('unreachable');
    expect(img.width).toBe(2);
    expect(img.height).toBe(2);
    expect(img.alpha).toBeUndefined();      // 24-bit carries no alpha
    expect(Array.from(img.samples)).toEqual([
      0x00, 0x00, 0xff, /* blue  */ 0x00, 0xff, 0x00, /* green */
      0xff, 0x00, 0x00, /* red   */ 0xff, 0xff, 0xff, /* white */
    ]);
  });

  it('reads a top-down file (negative height) without flipping', () => {
    const td = Uint8Array.from(ANCHOR_24);
    // height = -2, little-endian two's complement, at offset 0x16.
    td.set([0xfe, 0xff, 0xff, 0xff], 0x16);
    const img = decodeBmp(td);
    if (img.kind !== 'rgb') throw new Error('unreachable');
    expect(img.height).toBe(2);
    // Same bytes, opposite order: the file's first row is now the TOP row.
    expect(Array.from(img.samples)).toEqual([
      0xff, 0x00, 0x00, 0xff, 0xff, 0xff,
      0x00, 0x00, 0xff, 0x00, 0xff, 0x00,
    ]);
  });

  it('honours bfOffBits rather than computing it', () => {
    // Insert 4 gap bytes between the header and the pixels, and say so.
    const head = ANCHOR_24.subarray(0, 54);
    const pixels = ANCHOR_24.subarray(54);
    const gapped = new Uint8Array(head.length + 4 + pixels.length);
    gapped.set(head, 0);
    gapped.set([0xde, 0xad, 0xbe, 0xef], 54);
    gapped.set(pixels, 58);
    gapped.set([0x3a, 0x00, 0x00, 0x00], 0x0a);   // bfOffBits = 58
    gapped.set([0x4a, 0x00, 0x00, 0x00], 0x02);   // bfSize = 74
    const img = decodeBmp(gapped);
    if (img.kind !== 'rgb') throw new Error('unreachable');
    // Identical to the ungapped decode: the gap was skipped, not read as pixels.
    expect(Array.from(img.samples.subarray(0, 3))).toEqual([0x00, 0x00, 0xff]);
  });

  it('rejects a file that is not a BMP', () => {
    expect(() => decodeBmp(Uint8Array.from([0x89, 0x50, 0x4e, 0x47])))
      .toThrow(PdfParseError);
  });

  it('rejects a truncated pixel array', () => {
    expect(() => decodeBmp(ANCHOR_24.subarray(0, 60))).toThrow(PdfParseError);
  });

  it('rejects bfOffBits pointing outside the file', () => {
    const bad = Uint8Array.from(ANCHOR_24);
    bad.set([0xff, 0xff, 0x00, 0x00], 0x0a);
    expect(() => decodeBmp(bad)).toThrow(PdfParseError);
  });

  it('rejects an unknown DIB header size', () => {
    const bad = Uint8Array.from(ANCHOR_24);
    bad.set([0x29, 0x00, 0x00, 0x00], 0x0e);   // 41: not one of the six
    expect(() => decodeBmp(bad)).toThrow(PdfParseError);
  });

  it('declines a bit depth it does not implement', () => {
    const bad = Uint8Array.from(ANCHOR_24);
    bad.set([0x30, 0x00], 0x1c);               // 48 bpp
    expect(() => decodeBmp(bad)).toThrow(UnsupportedFeatureError);
  });
});

describe('decodeBmp — palette images', () => {
  // Deliberately non-grey, non-square and vertically asymmetric: a grey palette
  // cannot see the BGR swap, a square raster cannot see a transposition, and a
  // symmetric one cannot see the row flip.
  const PAL: Array<[number, number, number]> = [
    [0x00, 0x00, 0xff],   // BGR: red
    [0x00, 0xff, 0x00],   // green
    [0xff, 0x00, 0x00],   // blue
    [0xff, 0xff, 0xff],   // white
  ];

  it('keeps 8-bit indices packed and swaps only the palette', () => {
    const bmp = buildBmp({
      width: 3, height: 2, bpp: 8, palette: PAL,
      rows: [[0, 1, 2], [3, 2, 1]],     // top row, then bottom row
    });
    const img = decodeBmp(bmp);
    expect(img.kind).toBe('indexed');
    if (img.kind !== 'indexed') throw new Error('unreachable');
    expect(img.bpc).toBe(8);
    expect(img.width).toBe(3);
    expect(img.height).toBe(2);
    // Indices survive untouched, top-down.
    expect(Array.from(img.samples)).toEqual([0, 1, 2, 3, 2, 1]);
    // The palette is RGB now, not BGR.
    expect(Array.from(img.palette)).toEqual([
      0xff, 0x00, 0x00, 0x00, 0xff, 0x00, 0x00, 0x00, 0xff, 0xff, 0xff, 0xff,
    ]);
  });

  it('keeps 4-bit indices packed two to a byte and strips the 4-byte stride', () => {
    // width 3 at 4bpp is 2 bytes packed, padded to 4 in the file.
    const bmp = buildBmp({
      width: 3, height: 2, bpp: 4, palette: PAL,
      rows: [[0x01, 0x20, 0x00, 0x00], [0x32, 0x10, 0x00, 0x00]],
    });
    const img = decodeBmp(bmp);
    if (img.kind !== 'indexed') throw new Error('unreachable');
    expect(img.bpc).toBe(4);
    // Two bytes per row out, not four: the file's padding is gone.
    expect(Array.from(img.samples)).toEqual([0x01, 0x20, 0x32, 0x10]);
  });

  it('keeps 1-bit indices packed', () => {
    const bmp = buildBmp({
      width: 9, height: 2, bpp: 1, palette: [PAL[0], PAL[1]],
      rows: [[0b10110010, 0b10000000, 0, 0], [0b01001101, 0b00000000, 0, 0]],
    });
    const img = decodeBmp(bmp);
    if (img.kind !== 'indexed') throw new Error('unreachable');
    expect(img.bpc).toBe(1);
    expect(Array.from(img.samples)).toEqual([0b10110010, 0b10000000, 0b01001101, 0b00000000]);
  });

  it('reads a BITMAPCOREHEADER palette at 3 bytes per entry', () => {
    // A BITMAPCOREHEADER is 12 bytes and ends after the bit depth -- it has no
    // biClrUsed field AT ALL, so such a file always carries the full 1 << bpp
    // entries and there is no way for it to say otherwise. Only the first four
    // here mean anything.
    const full: Array<[number, number, number]> = [
      ...PAL, ...Array.from({ length: 12 }, () => [0, 0, 0] as [number, number, number]),
    ];
    const bmp = buildBmp({
      width: 2, height: 2, bpp: 4, dibSize: 12, palette: full,
      rows: [[0x01, 0, 0, 0], [0x23, 0, 0, 0]],
    });
    const img = decodeBmp(bmp);
    if (img.kind !== 'indexed') throw new Error('unreachable');
    // Reading 4-byte entries here would shift every colour after the first.
    expect(Array.from(img.palette.subarray(0, 6))).toEqual([0xff, 0, 0, 0, 0xff, 0]);
    expect(img.palette.length).toBe(16 * 3);
    expect(Array.from(img.samples)).toEqual([0x01, 0x23]);
  });

  it('defaults the palette length to 1 << bpp when biClrUsed is 0', () => {
    // The file must actually CONTAIN 16 entries -- biClrUsed 0 means "all of
    // them", not "none". Only the first four carry meaning here.
    const full: Array<[number, number, number]> = [
      ...PAL, ...Array.from({ length: 12 }, () => [0, 0, 0] as [number, number, number]),
    ];
    const bmp = buildBmp({
      width: 2, height: 1, bpp: 4, palette: full, clrUsed: 0,
      rows: [[0x01, 0x00, 0x00, 0x00]],
    });
    const img = decodeBmp(bmp);
    if (img.kind !== 'indexed') throw new Error('unreachable');
    expect(img.palette.length).toBe(16 * 3);   // 1 << 4 entries, RGB each
  });

  it('rejects a palette running past the pixel data', () => {
    const bmp = buildBmp({
      width: 2, height: 1, bpp: 8, palette: PAL, clrUsed: 200,
      rows: [[0, 1, 0, 0]],
    });
    expect(() => decodeBmp(bmp)).toThrow(PdfParseError);
  });
});

/**
 * Wikipedia's "BMP file format" Example 2: 4x2, 32-bit, BITMAPV4HEADER,
 * BI_BITFIELDS, alpha mask 0xFF000000, transcribed byte for byte.
 *
 * The V4 header runs 0x0E..0x79 and the pixel array starts at 0x7A, which is
 * exactly bfOffBits; total 122 + 32 = 154 = bfSize. (The article's own offset
 * column mislabels the three gamma fields as 0x86..0x91; they are at
 * 0x6E..0x79. The byte VALUES are all zero either way.)
 *
 * Bottom-up, so the file's first row is the bottom one. Non-square, so unlike
 * ANCHOR_24 this fixture also sees a width/height transposition.
 */
const ANCHOR_32 = Uint8Array.from([
  0x42, 0x4d,                                     // "BM"
  0x9a, 0x00, 0x00, 0x00,                         // bfSize = 154
  0x00, 0x00, 0x00, 0x00,                         // reserved
  0x7a, 0x00, 0x00, 0x00,                         // bfOffBits = 122
  0x6c, 0x00, 0x00, 0x00,                         // DIB size = 108 (V4)
  0x04, 0x00, 0x00, 0x00,                         // width = 4
  0x02, 0x00, 0x00, 0x00,                         // height = 2
  0x01, 0x00,                                     // planes
  0x20, 0x00,                                     // bpp = 32
  0x03, 0x00, 0x00, 0x00,                         // BI_BITFIELDS
  0x20, 0x00, 0x00, 0x00,                         // sizeImage = 32
  0x13, 0x0b, 0x00, 0x00, 0x13, 0x0b, 0x00, 0x00, // resolution
  0x00, 0x00, 0x00, 0x00,                         // clrUsed
  0x00, 0x00, 0x00, 0x00,                         // clrImportant
  0x00, 0x00, 0xff, 0x00,                         // red   mask 0x00FF0000
  0x00, 0xff, 0x00, 0x00,                         // green mask 0x0000FF00
  0xff, 0x00, 0x00, 0x00,                         // blue  mask 0x000000FF
  0x00, 0x00, 0x00, 0xff,                         // alpha mask 0xFF000000
  0x20, 0x6e, 0x69, 0x57,                         // "Win " colour space
  ...new Array<number>(36).fill(0),               // CIEXYZTRIPLE
  0x00, 0x00, 0x00, 0x00,                         // gamma red
  0x00, 0x00, 0x00, 0x00,                         // gamma green
  0x00, 0x00, 0x00, 0x00,                         // gamma blue
  // bottom row: blue, green, red, white at alpha 0x7F
  0xff, 0x00, 0x00, 0x7f, 0x00, 0xff, 0x00, 0x7f,
  0x00, 0x00, 0xff, 0x7f, 0xff, 0xff, 0xff, 0x7f,
  // top row: the same four, opaque
  0xff, 0x00, 0x00, 0xff, 0x00, 0xff, 0x00, 0xff,
  0x00, 0x00, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff,
]);

describe('decodeBmp — 16- and 32-bit', () => {
  it('decodes the published V4 bitfields file with its declared alpha', () => {
    expect(ANCHOR_32.length).toBe(154);   // the transcription is self-consistent
    const img = decodeBmp(ANCHOR_32);
    if (img.kind !== 'rgb') throw new Error('unreachable');
    expect(img.width).toBe(4);
    expect(img.height).toBe(2);
    expect(Array.from(img.samples.subarray(0, 12))).toEqual([
      0x00, 0x00, 0xff, 0x00, 0xff, 0x00, 0xff, 0x00, 0x00, 0xff, 0xff, 0xff,
    ]);                                    // top row: blue, green, red, white
    expect(img.alpha).toBeDefined();
    expect(Array.from(img.alpha!)).toEqual([
      0xff, 0xff, 0xff, 0xff,              // top row opaque
      0x7f, 0x7f, 0x7f, 0x7f,              // bottom row half
    ]);
  });

  it('treats a plain 32-bpp BI_RGB file as BGRX with no alpha', () => {
    // Every fourth byte is 0. Honouring it would render the image invisible.
    const bmp = buildBmp({
      width: 2, height: 1, bpp: 32,
      rows: [[0xff, 0x00, 0x00, 0x00, 0x00, 0xff, 0x00, 0x00]],
    });
    const img = decodeBmp(bmp);
    if (img.kind !== 'rgb') throw new Error('unreachable');
    expect(img.alpha).toBeUndefined();
    expect(Array.from(img.samples)).toEqual([0x00, 0x00, 0xff, 0x00, 0xff, 0x00]);
  });

  it('ignores a V4 alpha mask of zero', () => {
    const bmp = buildBmp({
      width: 2, height: 1, bpp: 32, dibSize: 108, compression: 3,
      masks: [0x00ff0000, 0x0000ff00, 0x000000ff, 0],
      rows: [[0xff, 0x00, 0x00, 0x11, 0x00, 0xff, 0x00, 0x22]],
    });
    const img = decodeBmp(bmp);
    if (img.kind !== 'rgb') throw new Error('unreachable');
    expect(img.alpha).toBeUndefined();
  });

  it('reads a 40-byte header bitfields mask from AFTER the header', () => {
    // 565, the everyday 16-bit layout. A V2 header would hold these INSIDE
    // itself; reading the wrong place consumes the first pixels as masks.
    const bmp = buildBmp({
      width: 2, height: 1, bpp: 16, compression: 3,
      masks: [0xf800, 0x07e0, 0x001f, 0],
      rows: [[0x00, 0xf8, 0xe0, 0x07]],   // pure red, pure green
    });
    const img = decodeBmp(bmp);
    if (img.kind !== 'rgb') throw new Error('unreachable');
    // round(v * 255 / max): 31 -> 255 and 63 -> 255 exactly.
    expect(Array.from(img.samples)).toEqual([0xff, 0x00, 0x00, 0x00, 0xff, 0x00]);
  });

  it('reads a V2 header bitfields mask from INSIDE the header', () => {
    const bmp = buildBmp({
      width: 2, height: 1, bpp: 16, dibSize: 52, compression: 3,
      masks: [0xf800, 0x07e0, 0x001f, 0],
      rows: [[0x00, 0xf8, 0xe0, 0x07]],
    });
    const img = decodeBmp(bmp);
    if (img.kind !== 'rgb') throw new Error('unreachable');
    expect(Array.from(img.samples)).toEqual([0xff, 0x00, 0x00, 0x00, 0xff, 0x00]);
  });

  it('defaults 16-bit BI_RGB to RGB555', () => {
    const bmp = buildBmp({
      width: 2, height: 1, bpp: 16,
      rows: [[0x00, 0x7c, 0xe0, 0x03]],   // 0x7C00 red, 0x03E0 green
    });
    const img = decodeBmp(bmp);
    if (img.kind !== 'rgb') throw new Error('unreachable');
    expect(Array.from(img.samples)).toEqual([0xff, 0x00, 0x00, 0x00, 0xff, 0x00]);
  });

  it('expands a channel by rounding, not truncation or bit replication', () => {
    // The value has to be chosen to separate the three rules, and most do not:
    // 5-bit 3 of 31 is round(3 * 255 / 31) = round(24.677) = 25, while BOTH
    // truncation and high-bit replication ((3 << 3) | (3 >> 2)) give 24. A
    // full-scale value cannot see this at all -- all three map 31 to 255.
    const bmp = buildBmp({
      width: 1, height: 1, bpp: 16, compression: 3,
      masks: [0xf800, 0x07e0, 0x001f, 0],
      rows: [[0x00, 0x18]],               // red = 3 << 11, green and blue 0
    });
    const img = decodeBmp(bmp);
    if (img.kind !== 'rgb') throw new Error('unreachable');
    expect(Array.from(img.samples)).toEqual([25, 0, 0]);
  });

  it('maps a full-scale channel to exactly 255 at every field width', () => {
    const bmp = buildBmp({
      width: 1, height: 1, bpp: 16, compression: 3,
      masks: [0xf800, 0x07e0, 0x001f, 0],
      rows: [[0xff, 0xff]],               // every channel at its maximum
    });
    const img = decodeBmp(bmp);
    if (img.kind !== 'rgb') throw new Error('unreachable');
    // The 6-bit green channel is the one that matters: a field width other than
    // 8 must still reach 255, or a white image comes out faintly off-white.
    expect(Array.from(img.samples)).toEqual([0xff, 0xff, 0xff]);
  });
});

describe('decodeBmp — RLE', () => {
  const PAL4: Array<[number, number, number]> = [
    [0x00, 0x00, 0xff], [0x00, 0xff, 0x00], [0xff, 0x00, 0x00], [0xff, 0xff, 0xff],
  ];

  it('decodes RLE8 encoded runs and absolute runs', () => {
    // RLE is always bottom-up, so the FIRST row encoded is the bottom one.
    //
    // Note the absolute run is THREE pixels, not two: `00 n` is absolute mode
    // only for n >= 3, because 0, 1 and 2 are the end-of-line, end-of-bitmap
    // and delta escapes. A two-pixel absolute run is not representable at all
    // -- `00 02` is a delta -- and writing one produces a stream that decodes
    // silently and wrongly. The run's data is padded to a 16-bit boundary.
    const rle = Uint8Array.from([
      0x05, 0x00,                         // bottom row: 5 x index 0
      0x00, 0x00,                         // end of line
      0x02, 0x01,                         // top row: 2 x index 1
      0x00, 0x03, 0x02, 0x03, 0x02, 0x00, // absolute run of 3: 2, 3, 2 + pad
      0x00, 0x01,                         // end of bitmap
    ]);
    const bmp = buildBmp({
      width: 5, height: 2, bpp: 8, compression: 1, palette: PAL4,
      rows: [], rawPixels: rle,
    });
    const img = decodeBmp(bmp);
    if (img.kind !== 'indexed') throw new Error('unreachable');
    expect(img.bpc).toBe(8);
    expect(Array.from(img.samples)).toEqual([
      1, 1, 2, 3, 2,        // top row
      0, 0, 0, 0, 0,        // bottom row
    ]);
  });

  it('leaves pixels a delta escape skipped at index 0', () => {
    // One row of 4: write index 3 twice, jump 2 right, write nothing more.
    const rle = Uint8Array.from([
      0x02, 0x03,                   // 2 x index 3
      0x00, 0x02, 0x02, 0x00,       // delta: dx = 2, dy = 0
      0x00, 0x01,                   // end of bitmap
    ]);
    const bmp = buildBmp({
      width: 4, height: 1, bpp: 8, compression: 1, palette: PAL4,
      rows: [], rawPixels: rle,
    });
    const img = decodeBmp(bmp);
    if (img.kind !== 'indexed') throw new Error('unreachable');
    expect(Array.from(img.samples)).toEqual([3, 3, 0, 0]);
  });

  it('decodes RLE4 alternating nibbles', () => {
    // 5 x the pair (1, 2) -> indices 1,2,1,2,1 across a 5-wide row.
    const rle = Uint8Array.from([0x05, 0x12, 0x00, 0x01]);
    const bmp = buildBmp({
      width: 5, height: 1, bpp: 4, compression: 2, palette: PAL4,
      rows: [], rawPixels: rle,
    });
    const img = decodeBmp(bmp);
    if (img.kind !== 'indexed') throw new Error('unreachable');
    expect(img.bpc).toBe(4);
    // Packed two to a byte: 0x12, 0x12, 0x10 -- 3 bytes for width 5.
    expect(Array.from(img.samples)).toEqual([0x12, 0x12, 0x10]);
  });

  it('refuses a top-down RLE image, which the format forbids', () => {
    const bmp = buildBmp({
      width: 2, height: 1, bpp: 8, compression: 1, topDown: true,
      palette: PAL4, rows: [], rawPixels: Uint8Array.from([0x02, 0x01, 0x00, 0x01]),
    });
    expect(() => decodeBmp(bmp)).toThrow(/top-down RLE/);
  });

  it('refuses RLE8 at a bit depth other than 8', () => {
    const bmp = buildBmp({
      width: 2, height: 1, bpp: 4, compression: 1, palette: PAL4,
      rows: [], rawPixels: Uint8Array.from([0x02, 0x01, 0x00, 0x01]),
    });
    expect(() => decodeBmp(bmp)).toThrow(/RLE8 at 4bpp/);
  });

  it('rejects a run overrunning its row', () => {
    const bmp = buildBmp({
      width: 2, height: 1, bpp: 8, compression: 1, palette: PAL4,
      rows: [], rawPixels: Uint8Array.from([0x40, 0x01, 0x00, 0x01]),
    });
    expect(() => decodeBmp(bmp)).toThrow(PdfParseError);
  });
});

describe('decodeBmp — embedded payloads', () => {
  it('returns a BI_JPEG payload without decoding it', () => {
    const jpeg = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]);
    const bmp = buildBmp({
      width: 4, height: 4, bpp: 24, compression: 4, rows: [], rawPixels: jpeg,
    });
    const img = decodeBmp(bmp);
    expect(img.kind).toBe('embedded');
    if (img.kind !== 'embedded') throw new Error('unreachable');
    expect(img.format).toBe('jpeg');
    expect(Array.from(img.payload)).toEqual(Array.from(jpeg));
  });

  it('returns a BI_PNG payload without decoding it', () => {
    const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const bmp = buildBmp({
      width: 4, height: 4, bpp: 24, compression: 5, rows: [], rawPixels: png,
    });
    const img = decodeBmp(bmp);
    if (img.kind !== 'embedded') throw new Error('unreachable');
    expect(img.format).toBe('png');
    expect(Array.from(img.payload)).toEqual(Array.from(png));
  });

  it('rejects an embedded payload with no bytes', () => {
    const bmp = buildBmp({
      width: 4, height: 4, bpp: 24, compression: 4,
      rows: [], rawPixels: new Uint8Array(0),
    });
    expect(() => decodeBmp(bmp)).toThrow(PdfParseError);
  });
});

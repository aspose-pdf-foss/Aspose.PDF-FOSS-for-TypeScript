import { describe, it, expect } from 'vitest';
import { decodeTiff, tiffPageCount } from '../src/tiff.js';
import { PdfParseError, UnsupportedFeatureError } from '../src/errors.js';
import { buildTiff, baseTags } from './helpers/build-tiff.js';
import { deflateSync } from 'node:zlib';
import { lzwEncode } from '../src/lzw.js';
import { runLengthEncode } from '../src/ascii.js';

/**
 * NOTE ON ANCHORING, recorded rather than papered over. Unlike BMP, which had
 * two published annotated hex dumps to transcribe (see test/bmp.test.ts), TIFF
 * has no equivalent, so this file's CONTAINER expectations are hand-computed
 * against our own builder -- encoder-versus-decoder inside one repo, which
 * proves less than it looks.
 *
 * Two things mitigate it. The payload codecs are all existing repo code with
 * their own suites and real-world fixtures (ccitt.ts, lzw.ts, flate, jpeg.ts,
 * PackBits); what is new here is only the container. And an `II` file and an
 * `MM` file encoding the same image must decode identically -- the two take
 * different paths through the reader, so a shared builder bug cannot make them
 * agree.
 *
 * Since 10u9.9 there is also a real anchor: test/tiff-real.test.ts runs files
 * from libtiff and utif2 against ground truth from libvips, none of which is
 * ours. It found a live bug in src/jpeg.ts on its first run. Read the two files
 * together -- this one covers the shapes no available encoder writes (palette,
 * WhiteIsZero, CCITT RLE and G3, FillOrder 2, 2- and 4-bit gray), and
 * test/fixtures/tiff/PROVENANCE.md lists that division explicitly.
 *
 * WHAT THESE FIXTURES COVER, measured by mutation rather than assumed. Each
 * change was applied to src/tiff.ts in turn and both TIFF test files re-run.
 * All ten redden -- but four of them ONLY AFTER the fixture was strengthened,
 * and those four are the interesting part of this list:
 *
 *    1 byte order forced little-endian   RED, 2 cases
 *    2 inline value read as an offset    RED, 41
 *    3 RowsPerStrip defaults to 1        RED, 1
 *    4 WhiteIsZero never inverted        RED, 5
 *    5 ColorMap read as triples          RED, 1
 *    6 ColorMap read as low bytes        RED, 1  -- green until fixed (a)
 *    7 edge tile treated as short        RED, 2  -- green until fixed (b)
 *    8 predictor uses the image width    RED, 1  -- green until fixed (c)
 *    9 premultiplied alpha not divided   RED, 1
 *   10 IFD cycle guard removed           RED, 1  -- green until fixed (d)
 *
 * (a) The ColorMap fixture used 0xffff and 0x0000, whose high and low bytes
 *     are IDENTICAL, so it could not see the 16-to-8-bit scaling at all. Every
 *     value now has a high byte differing from its low byte.
 * (b) The tile fixture asserted only ROW 0 of each tile -- the one row that
 *     reads identically whether an edge tile's stride is its full width or its
 *     visible width. Rows 1 and 2 are asserted now.
 * (c) The predictor fixture was a single STRIP, where the block width IS the
 *     image width, so the two were the same number. It is a tiled image now --
 *     and it asserts rows 1 and 3, not row 5: with a 16-wide tile in a 20-wide
 *     image the strides re-synchronise every LCM(16,20) = 80 bytes, which is
 *     exactly row 5, so a row-0-and-row-5 fixture passed the mutation too.
 * (d) MAX_PAGES is a REDUNDANT defence: it catches a cyclic chain after 4096
 *     iterations and throws PdfParseError as well, so a bare type assertion
 *     stayed green with the cycle guard deleted. That case now asserts the
 *     message. Two redundant defences mean breaking either alone proves
 *     nothing -- the same trap this repo records for scanDelimiterRow.
 *
 * The gap this file used to leave open is now CLOSED, elsewhere: `columns`
 * passed to decodeCcitt is the block width, and no fixture HERE separates it
 * from the image width, because every CCITT fixture in this file is a single
 * full-width strip where the two numbers coincide. test/tiff-real.test.ts pins
 * it with a tiled G4 image from libtiff, which our builder cannot produce.
 * Measured: that mutation reddens 2 cases there and 0 here.
 */

/** A 2x2 8-bit BlackIsZero gray image: one strip, four bytes. */
function grayTiff(le: boolean): Uint8Array {
  return buildTiff({
    le,
    pages: [{
      tags: baseTags(2, 2, 1, [
        { tag: 258, type: 3, values: [8] },     // BitsPerSample
        { tag: 277, type: 3, values: [1] },     // SamplesPerPixel
        { tag: 278, type: 4, values: [2] },     // RowsPerStrip
      ]),
      blocks: [Uint8Array.from([0x10, 0x20, 0x30, 0x40])],
    }],
  });
}

describe('tiff container', () => {
  it('decodes a little-endian file', () => {
    const img = decodeTiff(grayTiff(true));
    expect(img.kind).toBe('gray');
    if (img.kind !== 'gray') throw new Error('unreachable');
    expect(img.width).toBe(2);
    expect(img.height).toBe(2);
    expect(img.bpc).toBe(8);
    expect(Array.from(img.samples)).toEqual([0x10, 0x20, 0x30, 0x40]);
  });

  it('decodes a big-endian file to exactly the same raster', () => {
    // The differential: MM and II take different paths through the reader, so
    // a shared bug in the builder cannot make these agree.
    const a = decodeTiff(grayTiff(true));
    const b = decodeTiff(grayTiff(false));
    if (a.kind !== 'gray' || b.kind !== 'gray') throw new Error('unreachable');
    expect(Array.from(b.samples)).toEqual(Array.from(a.samples));
    expect([b.width, b.height, b.bpc]).toEqual([a.width, a.height, a.bpc]);
  });

  it('reads a value of four bytes or fewer inline, not as an offset', () => {
    // ImageWidth is one LONG = 4 bytes, so it is stored IN the entry. Reading
    // it as a file offset lands somewhere plausible and decodes garbage.
    const img = decodeTiff(grayTiff(true));
    if (img.kind === 'embedded') throw new Error('unreachable');
    expect(img.width).toBe(2);
  });

  it('reads a value of more than four bytes from its offset', () => {
    // Three SHORTs = 6 bytes, so BitsPerSample goes out of line.
    const t = buildTiff({
      pages: [{
        tags: baseTags(2, 1, 2, [
          { tag: 258, type: 3, values: [8, 8, 8] },
          { tag: 277, type: 3, values: [3] },
          { tag: 278, type: 4, values: [1] },
        ]),
        blocks: [Uint8Array.from([1, 2, 3, 4, 5, 6])],
      }],
    });
    const img = decodeTiff(t);
    expect(img.kind).toBe('rgb');
  });

  it('counts the images in a multi-page file', () => {
    const two = buildTiff({
      pages: [
        {
          tags: baseTags(2, 2, 1, [
            { tag: 258, type: 3, values: [8] }, { tag: 277, type: 3, values: [1] },
            { tag: 278, type: 4, values: [2] },
          ]),
          blocks: [Uint8Array.from([1, 2, 3, 4])],
        },
        {
          tags: baseTags(2, 2, 1, [
            { tag: 258, type: 3, values: [8] }, { tag: 277, type: 3, values: [1] },
            { tag: 278, type: 4, values: [2] },
          ]),
          blocks: [Uint8Array.from([9, 8, 7, 6])],
        },
      ],
    });
    expect(tiffPageCount(two)).toBe(2);
    const p1 = decodeTiff(two, 1);
    if (p1.kind !== 'gray') throw new Error('unreachable');
    expect(Array.from(p1.samples)).toEqual([9, 8, 7, 6]);
  });

  it('refuses a page index past the end', () => {
    expect(() => decodeTiff(grayTiff(true), 1)).toThrow(UnsupportedFeatureError);
  });

  it('rejects a file that is not a TIFF', () => {
    expect(() => decodeTiff(Uint8Array.from([0x89, 0x50, 0x4e, 0x47])))
      .toThrow(PdfParseError);
  });

  it('rejects BigTIFF', () => {
    const t = grayTiff(true);
    t[2] = 43; t[3] = 0;
    expect(() => decodeTiff(t)).toThrow(/BigTIFF/);
  });

  it('rejects a cyclic IFD chain rather than hanging', () => {
    // Point the first IFD's next-IFD pointer back at itself.
    const t = grayTiff(true);
    const ifdAt = t[4] | (t[5] << 8) | (t[6] << 16) | (t[7] << 24);
    const count = t[ifdAt] | (t[ifdAt + 1] << 8);
    const nextAt = ifdAt + 2 + count * 12;
    t[nextAt] = ifdAt & 0xff; t[nextAt + 1] = (ifdAt >> 8) & 0xff;
    t[nextAt + 2] = (ifdAt >> 16) & 0xff; t[nextAt + 3] = (ifdAt >> 24) & 0xff;
    // Asserted on the MESSAGE, not just the type. Measured: MAX_PAGES is a
    // redundant defence that catches this same file after 4096 iterations and
    // throws PdfParseError too, so a bare type assertion stays green with the
    // cycle guard deleted. The two are not interchangeable -- one says the
    // file is malformed, the other that it is implausibly large -- and a
    // cyclic two-page file should say cyclic.
    expect(() => tiffPageCount(t)).toThrow(/cyclic/);
  });

  it('rejects an IFD offset outside the file', () => {
    const t = grayTiff(true);
    t[4] = 0xff; t[5] = 0xff; t[6] = 0; t[7] = 0;
    expect(() => decodeTiff(t)).toThrow(PdfParseError);
  });

  it('rejects a file with no PhotometricInterpretation', () => {
    const t = buildTiff({
      pages: [{
        tags: [
          { tag: 256, type: 4, values: [2] }, { tag: 257, type: 4, values: [2] },
          { tag: 258, type: 3, values: [8] }, { tag: 277, type: 3, values: [1] },
          { tag: 278, type: 4, values: [2] },
        ],
        blocks: [Uint8Array.from([1, 2, 3, 4])],
      }],
    });
    expect(() => decodeTiff(t)).toThrow(/PhotometricInterpretation/);
  });

  it('treats a missing RowsPerStrip as one strip covering the image', () => {
    // The default is 2^32-1, i.e. the whole image. Defaulting it to 0 or 1
    // breaks every single-strip file, which is most of them.
    const t = buildTiff({
      pages: [{
        tags: baseTags(2, 2, 1, [
          { tag: 258, type: 3, values: [8] }, { tag: 277, type: 3, values: [1] },
        ]),
        blocks: [Uint8Array.from([0x10, 0x20, 0x30, 0x40])],
      }],
    });
    const img = decodeTiff(t);
    if (img.kind !== 'gray') throw new Error('unreachable');
    expect(Array.from(img.samples)).toEqual([0x10, 0x20, 0x30, 0x40]);
  });
});

describe('tiff photometric routes', () => {
  it('reads BlackIsZero gray as DeviceGray without inverting', () => {
    const t = buildTiff({
      pages: [{
        tags: baseTags(2, 2, 1, [
          { tag: 258, type: 3, values: [8] }, { tag: 277, type: 3, values: [1] },
          { tag: 278, type: 4, values: [1] },
        ]),
        blocks: [Uint8Array.from([0x00, 0x40]), Uint8Array.from([0x80, 0xff])],
      }],
    });
    const img = decodeTiff(t);
    if (img.kind !== 'gray') throw new Error('unreachable');
    expect(Array.from(img.samples)).toEqual([0x00, 0x40, 0x80, 0xff]);
  });

  it('inverts WhiteIsZero gray into DeviceGray', () => {
    // Photometric 0 says 0 is WHITE; DeviceGray says 0 is BLACK. Normalizing
    // in neither place, or in two, yields a photographic negative -- which
    // reads as a bad scan rather than as a decoder bug.
    const t = buildTiff({
      pages: [{
        tags: baseTags(2, 2, 0, [
          { tag: 258, type: 3, values: [8] }, { tag: 277, type: 3, values: [1] },
          { tag: 278, type: 4, values: [2] },
        ]),
        blocks: [Uint8Array.from([0x00, 0x40, 0x80, 0xff])],
      }],
    });
    const img = decodeTiff(t);
    if (img.kind !== 'gray') throw new Error('unreachable');
    expect(Array.from(img.samples)).toEqual([0xff, 0xbf, 0x7f, 0x00]);
  });

  it('reads RGB', () => {
    const t = buildTiff({
      pages: [{
        tags: baseTags(2, 1, 2, [
          { tag: 258, type: 3, values: [8, 8, 8] }, { tag: 277, type: 3, values: [3] },
          { tag: 278, type: 4, values: [1] },
        ]),
        blocks: [Uint8Array.from([0xff, 0, 0, 0, 0xff, 0])],
      }],
    });
    const img = decodeTiff(t);
    if (img.kind !== 'rgb') throw new Error('unreachable');
    expect(Array.from(img.samples)).toEqual([0xff, 0, 0, 0, 0xff, 0]);
    expect(img.alpha).toBeUndefined();
  });

  it('reads CMYK', () => {
    const t = buildTiff({
      pages: [{
        tags: baseTags(1, 1, 5, [
          { tag: 258, type: 3, values: [8, 8, 8, 8] }, { tag: 277, type: 3, values: [4] },
          { tag: 278, type: 4, values: [1] },
        ]),
        blocks: [Uint8Array.from([0x11, 0x22, 0x33, 0x44])],
      }],
    });
    const img = decodeTiff(t);
    if (img.kind !== 'cmyk') throw new Error('unreachable');
    expect(Array.from(img.samples)).toEqual([0x11, 0x22, 0x33, 0x44]);
  });

  it('reads a palette image, de-planarizing and scaling the ColorMap', () => {
    // ColorMap is three CONSECUTIVE PLANES -- all reds, then all greens, then
    // all blues -- of 16-bit values, NOT interleaved RGB triples and NOT 0..255.
    // Read as triples it gives a plausible wrong palette; read as low bytes it
    // gives a nearly black one.
    const t = buildTiff({
      pages: [{
        tags: baseTags(4, 1, 3, [
          { tag: 258, type: 3, values: [2] }, { tag: 277, type: 3, values: [1] },
          { tag: 278, type: 4, values: [1] },
          // Every value's HIGH byte differs from its low byte, which is what
          // makes this fixture able to see the 0..65535 -> 0..255 scaling at
          // all: with 0xffff and 0x0000 -- the obvious choice -- `>> 8` and
          // `& 0xff` produce identical bytes and the assertion proves nothing.
          { tag: 320, type: 3, values: [
            0xff00, 0x0000, 0x0000, 0x8000,
            0x0000, 0xff00, 0x0000, 0x8000,
            0x0000, 0x0000, 0xff00, 0x8000,
          ] },
        ]),
        blocks: [Uint8Array.from([0b00011011])],
      }],
    });
    const img = decodeTiff(t);
    if (img.kind !== 'indexed') throw new Error('unreachable');
    expect(img.bpc).toBe(2);
    expect(Array.from(img.samples)).toEqual([0b00011011]);
    expect(Array.from(img.palette)).toEqual([
      0xff, 0, 0, 0, 0xff, 0, 0, 0, 0xff, 0x80, 0x80, 0x80,
    ]);
  });

  it('assembles multiple strips in order', () => {
    const t = buildTiff({
      pages: [{
        tags: baseTags(2, 4, 1, [
          { tag: 258, type: 3, values: [8] }, { tag: 277, type: 3, values: [1] },
          { tag: 278, type: 4, values: [2] },
        ]),
        blocks: [Uint8Array.from([1, 2, 3, 4]), Uint8Array.from([5, 6, 7, 8])],
      }],
    });
    const img = decodeTiff(t);
    if (img.kind !== 'gray') throw new Error('unreachable');
    expect(Array.from(img.samples)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it('refuses RGB at a bit depth other than 8', () => {
    const t = buildTiff({
      pages: [{
        tags: baseTags(2, 1, 2, [
          { tag: 258, type: 3, values: [4, 4, 4] }, { tag: 277, type: 3, values: [3] },
          { tag: 278, type: 4, values: [1] },
        ]),
        blocks: [Uint8Array.from([0, 0, 0])],
      }],
    });
    expect(() => decodeTiff(t)).toThrow(UnsupportedFeatureError);
  });

  it('refuses PlanarConfiguration 2', () => {
    const t = buildTiff({
      pages: [{
        tags: baseTags(2, 1, 2, [
          { tag: 258, type: 3, values: [8, 8, 8] }, { tag: 277, type: 3, values: [3] },
          { tag: 278, type: 4, values: [1] }, { tag: 284, type: 3, values: [2] },
        ]),
        blocks: [Uint8Array.from([1, 2, 3, 4, 5, 6])],
      }],
    });
    expect(() => decodeTiff(t)).toThrow(/PlanarConfiguration/);
  });

  it('rejects a strip shorter than its geometry needs', () => {
    const t = buildTiff({
      pages: [{
        tags: baseTags(4, 2, 1, [
          { tag: 258, type: 3, values: [8] }, { tag: 277, type: 3, values: [1] },
          { tag: 278, type: 4, values: [2] },
        ]),
        blocks: [Uint8Array.from([1, 2, 3])],
      }],
    });
    expect(() => decodeTiff(t)).toThrow(PdfParseError);
  });
});

describe('tiff tiles', () => {
  /** A 20x20 gray image in 16x16 tiles: a 2x2 grid whose right and bottom
   *  tiles are partial. The width is deliberately NOT a multiple of the tile
   *  width -- an exactly dividing grid cannot see the edge-padding rule at all. */
  function tiledTiff(): Uint8Array {
    const tile = (fill: number) => {
      const b = new Uint8Array(16 * 16);
      b.fill(fill);
      // Mark each tile's first row so a misplacement is visible in the samples.
      for (let x = 0; x < 16; x++) b[x] = fill + x;
      return b;
    };
    return buildTiff({
      offsetsTag: 324, countsTag: 325,
      pages: [{
        tags: baseTags(20, 20, 1, [
          { tag: 258, type: 3, values: [8] }, { tag: 277, type: 3, values: [1] },
          { tag: 322, type: 4, values: [16] }, { tag: 323, type: 4, values: [16] },
        ]),
        blocks: [tile(0), tile(64), tile(128), tile(192)],
      }],
    });
  }

  it('places tiles on the grid, cropping the partial edge ones', () => {
    const img = decodeTiff(tiledTiff());
    if (img.kind !== 'gray') throw new Error('unreachable');
    expect(img.width).toBe(20);
    expect(img.height).toBe(20);
    expect(img.samples.length).toBe(400);
    // Row 0, column 0 comes from tile 0; column 16 from tile 1. An edge tile
    // holds a FULL 16 bytes per row, so tile 1's row 0 starts at its own 0 --
    // treating it as 4 bytes wide would read tile 1's later rows here instead.
    expect(img.samples[0]).toBe(0);
    expect(img.samples[15]).toBe(15);
    expect(img.samples[16]).toBe(64);
    expect(img.samples[19]).toBe(67);
    // Row 16 is the first row of the bottom tile pair.
    expect(img.samples[16 * 20]).toBe(128);
    expect(img.samples[16 * 20 + 16]).toBe(192);
    // ROW 1 of the partial right-hand tile, which is the assertion that
    // actually sees the padding rule -- row 0 reads identically whether the
    // tile's stride is its full 16 bytes or its visible 4, so every assertion
    // above passes even when the edge tile is treated as short. Rows 1..15 are
    // the tile's fill, so this is 64; at a 4-byte stride it would be 68.
    expect(img.samples[1 * 20 + 16]).toBe(64);
    expect(img.samples[2 * 20 + 16]).toBe(64);
  });

  it('rejects a tile dimension that is not a multiple of 16', () => {
    const t = buildTiff({
      offsetsTag: 324, countsTag: 325,
      pages: [{
        tags: baseTags(20, 20, 1, [
          { tag: 258, type: 3, values: [8] }, { tag: 277, type: 3, values: [1] },
          { tag: 322, type: 4, values: [20] }, { tag: 323, type: 4, values: [20] },
        ]),
        blocks: [new Uint8Array(400)],
      }],
    });
    expect(() => decodeTiff(t)).toThrow(/multiple of 16/);
  });

  it('rejects a tile count that does not match the grid', () => {
    const t = buildTiff({
      offsetsTag: 324, countsTag: 325,
      pages: [{
        tags: baseTags(20, 20, 1, [
          { tag: 258, type: 3, values: [8] }, { tag: 277, type: 3, values: [1] },
          { tag: 322, type: 4, values: [16] }, { tag: 323, type: 4, values: [16] },
        ]),
        blocks: [new Uint8Array(256)],
      }],
    });
    expect(() => decodeTiff(t)).toThrow(PdfParseError);
  });
});

describe('tiff compression', () => {
  const ROWS = [Uint8Array.from([1, 2, 3, 4]), Uint8Array.from([5, 6, 7, 8])];

  /** Two strips of a 4x2 gray image, each compressed independently. */
  function compressed(compression: number, enc: (b: Uint8Array) => Uint8Array): Uint8Array {
    return buildTiff({
      pages: [{
        tags: baseTags(4, 2, 1, [
          { tag: 258, type: 3, values: [8] }, { tag: 277, type: 3, values: [1] },
          { tag: 259, type: 3, values: [compression] },
          { tag: 278, type: 4, values: [1] },
        ]),
        blocks: ROWS.map(enc),
      }],
    });
  }

  // TWO strips, not one: a single-block image cannot see the per-block codec
  // reset at all, and LZW especially decodes the first block correctly and
  // everything after it as garbage when the state is carried over.
  it('decodes LZW, resetting the codec per strip', () => {
    const img = decodeTiff(compressed(5, (b) => lzwEncode(b, 1)));
    if (img.kind !== 'gray') throw new Error('unreachable');
    expect(Array.from(img.samples)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it('decodes Deflate (8) and Adobe Deflate (32946)', () => {
    for (const c of [8, 32946]) {
      const img = decodeTiff(compressed(c, (b) => new Uint8Array(deflateSync(Buffer.from(b)))));
      if (img.kind !== 'gray') throw new Error('unreachable');
      expect(Array.from(img.samples)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    }
  });

  it('decodes PackBits', () => {
    const img = decodeTiff(compressed(32773, (b) => runLengthEncode(b)));
    if (img.kind !== 'gray') throw new Error('unreachable');
    expect(Array.from(img.samples)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it('applies horizontal differencing (predictor 2) per row', () => {
    // Deltas 10,+1,+1,+1 per row reconstruct to 10,11,12,13.
    const t = buildTiff({
      pages: [{
        tags: baseTags(4, 2, 1, [
          { tag: 258, type: 3, values: [8] }, { tag: 277, type: 3, values: [1] },
          { tag: 278, type: 4, values: [2] }, { tag: 317, type: 3, values: [2] },
        ]),
        blocks: [Uint8Array.from([10, 1, 1, 1, 20, 1, 1, 1])],
      }],
    });
    const img = decodeTiff(t);
    if (img.kind !== 'gray') throw new Error('unreachable');
    expect(Array.from(img.samples)).toEqual([10, 11, 12, 13, 20, 21, 22, 23]);
  });

  it('applies the predictor with the BLOCK width, not the image width', () => {
    // A single strip cannot see this: there blockW IS the image width, so the
    // two are the same number and the assertion passes whatever the code does.
    // A 20-wide image in 16-wide tiles separates them.
    const tile = () => {
      const b = new Uint8Array(16 * 16);
      for (let y = 0; y < 16; y++) {
        b[y * 16] = 10;                       // each row restarts at 10
        for (let x = 1; x < 16; x++) b[y * 16 + x] = 1;
      }
      return b;
    };
    const t = buildTiff({
      offsetsTag: 324, countsTag: 325,
      pages: [{
        tags: baseTags(20, 16, 1, [
          { tag: 258, type: 3, values: [8] }, { tag: 277, type: 3, values: [1] },
          { tag: 317, type: 3, values: [2] },
          { tag: 322, type: 4, values: [16] }, { tag: 323, type: 4, values: [16] },
        ]),
        blocks: [tile(), tile()],
      }],
    });
    const img = decodeTiff(t);
    if (img.kind !== 'gray') throw new Error('unreachable');
    // Each tile reconstructs 10..25 across its own 16 columns; the right-hand
    // tile is cropped to its first four, so every row reads 10..25 then 10..13.
    const want = [...Array.from({ length: 16 }, (_, i) => 10 + i), 10, 11, 12, 13];
    expect(Array.from(img.samples.subarray(0, 20))).toEqual(want);
    // Rows 1 and 3, NOT row 5. Measured the hard way: with a 16-wide tile in a
    // 20-wide image the two stride systems re-synchronise every LCM(16, 20) =
    // 80 bytes, which is exactly row 5 -- so a fixture asserting row 0 and row
    // 5 passes even when the predictor is given the image width.
    expect(Array.from(img.samples.subarray(1 * 20, 2 * 20))).toEqual(want);
    expect(Array.from(img.samples.subarray(3 * 20, 4 * 20))).toEqual(want);
  });

  it('reverses the bits of every byte under FillOrder 2', () => {
    const t = buildTiff({
      pages: [{
        tags: baseTags(8, 1, 1, [
          { tag: 258, type: 3, values: [1] }, { tag: 277, type: 3, values: [1] },
          { tag: 266, type: 3, values: [2] }, { tag: 278, type: 4, values: [1] },
        ]),
        blocks: [Uint8Array.from([0b10110010])],
      }],
    });
    const img = decodeTiff(t);
    if (img.kind !== 'gray') throw new Error('unreachable');
    expect(Array.from(img.samples)).toEqual([0b01001101]);
  });

  it('refuses an unknown compression', () => {
    expect(() => decodeTiff(compressed(6, (b) => b))).toThrow(UnsupportedFeatureError);
  });

  it('refuses floating-point predictor 3', () => {
    const t = buildTiff({
      pages: [{
        tags: baseTags(4, 1, 1, [
          { tag: 258, type: 3, values: [8] }, { tag: 277, type: 3, values: [1] },
          { tag: 278, type: 4, values: [1] }, { tag: 317, type: 3, values: [3] },
        ]),
        blocks: [Uint8Array.from([1, 2, 3, 4])],
      }],
    });
    expect(() => decodeTiff(t)).toThrow(UnsupportedFeatureError);
  });
});

describe('tiff CCITT', () => {
  /**
   * This repo has no CCITT encoder, so these streams are hand-built from the
   * T.4 code tables and were confirmed against `decodeCcitt` directly before
   * being written down:
   *
   *   0xB6 = white-4 (1011) + black-4 (011), padded -> one row 00001111
   *   0xDB = a mixed-mode 1-bit tag (1) then the same             -> 00001111
   *   0xC0 = two G4 V0 codes (1, 1), padded          -> two all-white rows
   *
   * They assert the ROUTING, which is all this module decides -- the coding is
   * ccitt.ts's and is covered by its own suite and by real-world PDF fixtures.
   * The assertion is sensitive because a wrong `k` does not merely produce
   * different pixels, it THROWS ("bad mode code" / "bad run code"), and a wrong
   * `rows` yields the wrong row count.
   *
   * Every case uses photometric 0 (WhiteIsZero, what fax actually uses), so the
   * expected bytes are `decodeCcitt`'s output INVERTED -- which pins the
   * polarity normalization at the same time.
   */

  it('routes compression 4 to G4 (k = -1)', () => {
    const t = buildTiff({
      pages: [{
        tags: baseTags(8, 2, 0, [
          { tag: 258, type: 3, values: [1] }, { tag: 277, type: 3, values: [1] },
          { tag: 259, type: 3, values: [4] }, { tag: 278, type: 4, values: [2] },
        ]),
        blocks: [Uint8Array.from([0xc0, 0x00])],
      }],
    });
    const img = decodeTiff(t);
    if (img.kind !== 'gray') throw new Error('unreachable');
    expect(img.bpc).toBe(1);
    // decodeCcitt gives two all-white rows (0x00); WhiteIsZero inverts them.
    expect(Array.from(img.samples)).toEqual([0xff, 0xff]);
  });

  it('routes compression 2 to 1D with byte alignment', () => {
    const t = buildTiff({
      pages: [{
        tags: baseTags(8, 1, 0, [
          { tag: 258, type: 3, values: [1] }, { tag: 277, type: 3, values: [1] },
          { tag: 259, type: 3, values: [2] }, { tag: 278, type: 4, values: [1] },
        ]),
        blocks: [Uint8Array.from([0xb6, 0x00])],
      }],
    });
    const img = decodeTiff(t);
    if (img.kind !== 'gray') throw new Error('unreachable');
    // 00001111 inverted -> 11110000.
    expect(Array.from(img.samples)).toEqual([0b11110000]);
  });

  it('reads T4Options bit 0 to select 2D coding', () => {
    // Options 5 = bit 0 (2D) | bit 2 (EncodedByteAlign). In mixed mode a 1-bit
    // tag precedes each row, so the SAME run codes need a leading 1 -- which is
    // why 0xDB works here and 0xB6 does not. A decoder ignoring bit 0 reads the
    // tag bit as a run code and throws.
    const t = buildTiff({
      pages: [{
        tags: baseTags(8, 1, 0, [
          { tag: 258, type: 3, values: [1] }, { tag: 277, type: 3, values: [1] },
          { tag: 259, type: 3, values: [3] }, { tag: 292, type: 4, values: [5] },
          { tag: 278, type: 4, values: [1] },
        ]),
        blocks: [Uint8Array.from([0xdb, 0x00])],
      }],
    });
    const img = decodeTiff(t);
    if (img.kind !== 'gray') throw new Error('unreachable');
    expect(Array.from(img.samples)).toEqual([0b11110000]);
  });

  it('reads T4Options 0 as pure 1D', () => {
    const t = buildTiff({
      pages: [{
        tags: baseTags(8, 1, 0, [
          { tag: 258, type: 3, values: [1] }, { tag: 277, type: 3, values: [1] },
          { tag: 259, type: 3, values: [3] }, { tag: 292, type: 4, values: [0] },
          { tag: 278, type: 4, values: [1] },
        ]),
        blocks: [Uint8Array.from([0xb6, 0x00])],
      }],
    });
    const img = decodeTiff(t);
    if (img.kind !== 'gray') throw new Error('unreachable');
    expect(Array.from(img.samples)).toEqual([0b11110000]);
  });
});

describe('tiff JPEG', () => {
  /** A minimal baseline JPEG: SOI, SOF0 declaring 1x1 grayscale, EOI. */
  const JPEG = Uint8Array.from([
    0xff, 0xd8,
    0xff, 0xc0, 0x00, 0x0b, 0x08, 0x00, 0x01, 0x00, 0x01, 0x01, 0x01, 0x11, 0x00,
    0xff, 0xd9,
  ]);

  it('passes a single-strip JPEG through as an embedded payload', () => {
    // One block covering the whole image and no JPEGTables: hand the bytes on
    // untouched, so the PDF gets a DCTDecode passthrough with no re-encode.
    const t = buildTiff({
      pages: [{
        tags: baseTags(1, 1, 1, [
          { tag: 258, type: 3, values: [8] }, { tag: 277, type: 3, values: [1] },
          { tag: 259, type: 3, values: [7] }, { tag: 278, type: 4, values: [1] },
        ]),
        blocks: [JPEG],
      }],
    });
    const img = decodeTiff(t);
    expect(img.kind).toBe('embedded');
    if (img.kind !== 'embedded') throw new Error('unreachable');
    expect(img.format).toBe('jpeg');
    expect(Array.from(img.payload)).toEqual(Array.from(JPEG));
  });

  it('accepts YCbCr on the JPEG route although it refuses it elsewhere', () => {
    // A JPEG carries its own colour transform, so photometric 6 is fine here
    // and refused for raw samples. This reads as an inconsistency, so it is
    // asserted directly.
    const t = buildTiff({
      pages: [{
        tags: baseTags(1, 1, 6, [
          { tag: 258, type: 3, values: [8] }, { tag: 277, type: 3, values: [1] },
          { tag: 259, type: 3, values: [7] }, { tag: 278, type: 4, values: [1] },
        ]),
        blocks: [JPEG],
      }],
    });
    expect(decodeTiff(t).kind).toBe('embedded');
  });

  it('refuses YCbCr for a raw-sample route', () => {
    const t = buildTiff({
      pages: [{
        tags: baseTags(1, 1, 6, [
          { tag: 258, type: 3, values: [8, 8, 8] }, { tag: 277, type: 3, values: [3] },
          { tag: 278, type: 4, values: [1] },
        ]),
        blocks: [Uint8Array.from([1, 2, 3])],
      }],
    });
    expect(() => decodeTiff(t)).toThrow(UnsupportedFeatureError);
  });
});

describe('tiff alpha', () => {
  /** A 2x1 RGBA image; `extra` is the ExtraSamples value. */
  function rgba(extra: number, px: number[]): Uint8Array {
    return buildTiff({
      pages: [{
        tags: baseTags(2, 1, 2, [
          { tag: 258, type: 3, values: [8, 8, 8, 8] },
          { tag: 277, type: 3, values: [4] },
          { tag: 278, type: 4, values: [1] },
          { tag: 338, type: 3, values: [extra] },
        ]),
        blocks: [Uint8Array.from(px)],
      }],
    });
  }

  it('splits unassociated alpha straight out into an /SMask plane', () => {
    const img = decodeTiff(rgba(2, [0xff, 0x00, 0x00, 0x80, 0x00, 0xff, 0x00, 0xff]));
    if (img.kind !== 'rgb') throw new Error('unreachable');
    expect(Array.from(img.samples)).toEqual([0xff, 0, 0, 0, 0xff, 0]);
    expect(Array.from(img.alpha!)).toEqual([0x80, 0xff]);
  });

  it('divides out associated (premultiplied) alpha', () => {
    // ExtraSamples 1 is PREMULTIPLIED. PDF's /SMask composites colour x alpha,
    // so handing it premultiplied colour multiplies alpha in twice: the image
    // renders too dark, worst exactly where it is most transparent.
    const img = decodeTiff(rgba(1, [0x80, 0x00, 0x00, 0x80, 0x40, 0x40, 0x40, 0x40]));
    if (img.kind !== 'rgb') throw new Error('unreachable');
    expect(Array.from(img.alpha!)).toEqual([0x80, 0x40]);
    expect(img.samples[0]).toBe(0xff);
    expect(img.samples[3]).toBe(0xff);
  });

  it('emits 0 where premultiplied alpha is 0 rather than dividing by zero', () => {
    const img = decodeTiff(rgba(1, [0x00, 0x00, 0x00, 0x00, 0x40, 0x40, 0x40, 0x40]));
    if (img.kind !== 'rgb') throw new Error('unreachable');
    expect(Array.from(img.samples.subarray(0, 3))).toEqual([0, 0, 0]);
  });

  it('drops an unspecified extra sample and stays opaque', () => {
    // ExtraSamples 0 is "unspecified", which is NOT a claim of transparency.
    const img = decodeTiff(rgba(0, [0xff, 0x00, 0x00, 0x11, 0x00, 0xff, 0x00, 0x22]));
    if (img.kind !== 'rgb') throw new Error('unreachable');
    expect(img.alpha).toBeUndefined();
    expect(Array.from(img.samples)).toEqual([0xff, 0, 0, 0, 0xff, 0]);
  });

  it('splits gray plus alpha too', () => {
    const t = buildTiff({
      pages: [{
        tags: baseTags(2, 1, 1, [
          { tag: 258, type: 3, values: [8, 8] }, { tag: 277, type: 3, values: [2] },
          { tag: 278, type: 4, values: [1] }, { tag: 338, type: 3, values: [2] },
        ]),
        blocks: [Uint8Array.from([0x40, 0x80, 0xc0, 0xff])],
      }],
    });
    const img = decodeTiff(t);
    if (img.kind !== 'gray') throw new Error('unreachable');
    expect(Array.from(img.samples)).toEqual([0x40, 0xc0]);
    expect(Array.from(img.alpha!)).toEqual([0x80, 0xff]);
  });
});

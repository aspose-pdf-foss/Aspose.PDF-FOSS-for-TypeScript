import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodeTiff } from '../src/tiff.js';
import type { RasterImage } from '../src/rasterimage.js';

/**
 * TIFFs FROM REAL PRODUCERS — the anchor test/tiff.test.ts does not have.
 *
 * That file's container expectations are hand-computed against our own builder,
 * which is encoder-versus-decoder inside one repo: a bug both halves share
 * cancels out and the suite stays green. These fixtures come from two encoders
 * we did not write, and their ground truth comes from a decoder we did not
 * write either — libvips reading each file back at generation time, frozen as
 * `<name>.expected.raw`. So an assertion here compares our decoder against
 * libtiff's writer AND libvips's reader.
 *
 * See test/fixtures/tiff/PROVENANCE.md for producers, versions, per-file
 * coverage, and — as load-bearing as the rest — what these files still do NOT
 * anchor. Regenerate with `node scripts/gen-tiff-fixtures.mjs --modules <dir>`;
 * it is not run by `npm test` and its encoders are not dependencies.
 *
 * WHAT THESE FIXTURES PIN. Each mutation below was applied to src/tiff.ts in
 * turn and BOTH TIFF suites re-run, so the split says what this file adds over
 * the builder-anchored one rather than merely that something went red:
 *
 *                                                   here  tiff.test.ts
 *   1 decodeCcitt gets the IMAGE width, not the        2        0
 *     block width
 *   2 edge tile treated as short, not full-stride      3        2
 *   3 predictor un-differenced across the IMAGE        1        1
 *     width
 *   4 byte order forced little-endian                  2        1
 *
 * Row 1 is the whole reason this file exists, and its zero is the point: the
 * mutation was GREEN against the entire builder suite. Every CCITT case there
 * is a single full-width strip, where the block width IS the image width, so
 * the two numbers coincide and no assertion can separate them. Separating them
 * takes a TILED G4 image, which our builder cannot produce and libtiff can.
 *
 * Rows 2-4 were already pinned by the builder suite; the value they add is
 * independent corroboration from bytes we did not write, which is what makes a
 * shared encoder/decoder misreading visible.
 *
 * WHAT THIS FILE FOUND. The JPEG case below is a real bug these fixtures caught
 * on first run: libtiff writes a JPEG-compressed RGB TIFF whose embedded stream
 * carries SOF component ids 'R','G','B' and no Adobe APP14 marker, and
 * combinePlanes assumed any 3-component JPEG was YCbCr -- so the whole image
 * decoded with R and B pinned near zero. Fixed in src/jpeg.ts; nothing in the
 * builder suite could have seen it, because our builder never writes that shape.
 */

const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'tiff');
const read = (f: string) => new Uint8Array(fs.readFileSync(path.join(DIR, f)));

/** The frozen libvips decode of `<name>.tif`, its independent ground truth. */
const oracle = (name: string) => read(`${name}.expected.raw`);

const W = 20, H = 12;

/** Tag numbers in the file's first IFD. Little-endian only — every fixture that
 *  uses this is one libtiff wrote. */
function ifdTags(b: Uint8Array): number[] {
  const u16 = (o: number) => b[o] | (b[o + 1] << 8);
  const u32 = (o: number) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
  const off = u32(4);
  const out: number[] = [];
  for (let i = 0, n = u16(off); i < n; i++) out.push(u16(off + 2 + i * 12));
  return out;
}

/** Narrow away the `embedded` arm, which carries no dimensions, so a test can
 *  read width/height off the union. Fails loudly rather than casting blind. */
function sized(img: RasterImage): Extract<RasterImage, { width: number }> {
  if (img.kind === 'embedded') throw new Error(`expected samples, got ${img.kind}`);
  return img;
}

/** Interleaved `ch`-channel samples, as `decodeTiff` returns for rgb/cmyk. */
function expectSamples(img: RasterImage, ch: number, want: Uint8Array): void {
  const got = (img as { samples: Uint8Array }).samples;
  expect(got.length).toBe(W * H * ch);
  expect(want.length).toBe(W * H * ch);
  let firstBad = -1;
  for (let i = 0; i < want.length; i++) if (got[i] !== want[i]) { firstBad = i; break; }
  // Reporting the index rather than diffing 720 bytes: a wrong stride shows up
  // as a small index, a wrong final block as a large one.
  expect({ firstBad }).toEqual({ firstBad: -1 });
}

describe('real-producer TIFF — libtiff via libvips (little-endian)', () => {
  // The four lossless RGB organisations must all recover the same picture.
  for (const name of [
    'libtiff-lzw-tiled-pred', 'libtiff-lzw-strips',
    'libtiff-packbits', 'libtiff-deflate-pred',
  ]) {
    it(`${name} decodes to libvips's own reading of it`, () => {
      const img = sized(decodeTiff(read(`${name}.tif`)));
      expect(img.kind).toBe('rgb');
      expect([img.width, img.height]).toEqual([W, H]);
      expectSamples(img, 3, oracle(name));
    });
  }

  it('recovers the exact bytes handed to the encoder', () => {
    // Stronger than agreeing with libvips: these codecs are lossless, so the
    // round trip must return the source this repo designed, unchanged.
    const img = decodeTiff(read('libtiff-lzw-strips.tif'));
    expectSamples(img, 3, read('source-rgb.raw'));
  });

  it('libtiff-cmyk decodes as four-channel DeviceCMYK', () => {
    const img = decodeTiff(read('libtiff-cmyk.tif'));
    expect(img.kind).toBe('cmyk');
    // The oracle here is the encoder INPUT, not libvips's read-back. libvips
    // applies an ICC transform on the way out of a CMYK file, so its answer
    // differs from the stored bytes by a few counts per channel (measured:
    // 22,9,169,252 stored against 21,9,185,248 read back) -- close enough to
    // look like a rounding difference and far enough to fail an exact compare.
    // The file is uncompressed, so what went in must come back out unchanged.
    expectSamples(img, 4, read('libtiff-cmyk.source.raw'));
  });
});

describe('real-producer TIFF — tiled CCITT G4', () => {
  /** 1-bpp packed samples expanded to one byte per pixel, 0 or 255.
   *  Unambiguous for bilevel: at BitsPerSample 1 with DeviceGray polarity,
   *  sample 1 is white. (Unlike 2- and 4-bit, where expanding to 8 bits needs
   *  a scaling convention that would be our claim rather than the file's.) */
  function expand1bpp(img: RasterImage): Uint8Array {
    const { samples } = img as { samples: Uint8Array };
    const stride = (W + 7) >> 3;
    const out = new Uint8Array(W * H);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const bit = (samples[y * stride + (x >> 3)] >> (7 - (x & 7))) & 1;
        out[y * W + x] = bit ? 255 : 0;
      }
    }
    return out;
  }

  it('a TILED G4 image decodes correctly — the case a full-width strip cannot pin', () => {
    const img = sized(decodeTiff(read('libtiff-g4-tiled.tif')));
    expect(img.kind).toBe('gray');
    expect((img as { bpc: number }).bpc).toBe(1);
    expect([img.width, img.height]).toEqual([W, H]);
    // 20 wide against a 16px tile: the right-hand tile is 4 columns of picture
    // in a 16-column block, so decodeCcitt must be told 16, not 20.
    expect(expand1bpp(img)).toEqual(oracle('libtiff-g4-tiled'));
  });

  it('the same picture strip-organised decodes identically', () => {
    // The differential: tiles and strips assemble differently and hand
    // decodeCcitt different widths, so a bug in either shows as disagreement.
    const tiled = expand1bpp(decodeTiff(read('libtiff-g4-tiled.tif')));
    const strips = expand1bpp(decodeTiff(read('libtiff-g4-strips.tif')));
    expect(strips).toEqual(oracle('libtiff-g4-strips'));
    expect(strips).toEqual(tiled);
  });

  it('the two G4 files really are differently organised', () => {
    // Guards the differential above from passing vacuously on two files that
    // a regeneration accidentally made identical.
    expect(read('libtiff-g4-tiled.tif')).not.toEqual(read('libtiff-g4-strips.tif'));
  });
});

describe('real-producer TIFF — big-endian, from an unrelated encoder', () => {
  it('utif-rgba-mm is MM and decodes to libvips’s reading of it', () => {
    const bytes = read('utif-rgba-mm.tif');
    expect([bytes[0], bytes[1]]).toEqual([0x4d, 0x4d]); // "MM"

    const img = sized(decodeTiff(bytes));
    expect(img.kind).toBe('rgb');
    expect([img.width, img.height]).toEqual([W, H]);

    // The oracle is 4-channel interleaved RGBA; our model splits alpha out.
    const want = oracle('utif-rgba-mm');
    const rgb = new Uint8Array(W * H * 3);
    const alpha = new Uint8Array(W * H);
    for (let p = 0; p < W * H; p++) {
      rgb[p * 3] = want[p * 4];
      rgb[p * 3 + 1] = want[p * 4 + 1];
      rgb[p * 3 + 2] = want[p * 4 + 2];
      alpha[p] = want[p * 4 + 3];
    }
    expectSamples(img, 3, rgb);
    expect((img as { alpha?: Uint8Array }).alpha ?? new Uint8Array(0)).toEqual(alpha);
  });

  it('agrees with the little-endian file of the same picture', () => {
    // The II/MM differential test/tiff.test.ts makes with our own builder,
    // made here between two encoders neither of which is ours.
    const mm = decodeTiff(read('utif-rgba-mm.tif'));
    const ii = decodeTiff(read('libtiff-packbits.tif'));
    expectSamples(mm, 3, (ii as { samples: Uint8Array }).samples);
  });
});

describe('real-producer TIFF — JPEG-compressed', () => {
  it('decodes a JPEGTables file to the same picture libvips reads', () => {
    const bytes = read('libtiff-jpeg-rgb.tif');
    // Tag 347 (JPEGTables) is present: libtiff always writes shared tables, so
    // this file deliberately does NOT reach the DCTDecode passthrough route,
    // which requires their absence. Asserted rather than assumed, because the
    // two routes return different kinds and the difference is easy to misread
    // as a bug.
    expect(ifdTags(bytes)).toContain(347);

    const img = sized(decodeTiff(bytes));
    expect(img.kind).toBe('rgb');
    expect([img.width, img.height]).toEqual([W, H]);

    // Lossy on both sides, so a tolerance rather than equality: libvips and our
    // decoder run different IDCTs and different chroma upsampling. The bound is
    // measured, not guessed -- see the assertion below it.
    const want = oracle('libtiff-jpeg-rgb');
    const got = (img as { samples: Uint8Array }).samples;
    let maxErr = 0;
    for (let i = 0; i < want.length; i++) maxErr = Math.max(maxErr, Math.abs(got[i] - want[i]));
    expect(maxErr).toBeLessThanOrEqual(12);
    // A tolerance that admits anything proves nothing. This one is tight enough
    // that a channel swap or a stride error blows straight through it.
    expect(maxErr).toBeGreaterThan(0);
  });
});

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodeBmp } from '../src/bmp.js';
import type { RasterImage } from '../src/rasterimage.js';

/**
 * BMPs FROM A REAL PRODUCER — GDI+, the imaging stack Windows itself uses, and
 * the closest thing this format has to a reference implementation, BMP being
 * Microsoft's own.
 *
 * WHAT THIS ADDS OVER test/bmp.test.ts. That file is NOT unanchored: it
 * transcribes two published Wikipedia hex dumps byte for byte, which genuinely
 * pin the 24-bit BITMAPINFOHEADER and the BITMAPCOREHEADER cases. Everything
 * beyond those two dumps is built by test/helpers/build-bmp.ts, though —
 * encoder-versus-decoder inside one repo, where a misreading both halves share
 * cancels out. This file covers that remainder with bytes we did not write:
 * 1-, 4- and 8-bit palettes, 16-bit 555 and BI_BITFIELDS 565, and a 32-bit file
 * from the format's own owner.
 *
 * See test/fixtures/bmp/PROVENANCE.md for versions, checksums, per-file
 * coverage and — as load-bearing as the rest — what stays out of reach.
 *
 * WHAT THESE FIXTURES PIN, and WHAT THEY DO NOT. Each mutation was applied to
 * src/bmp.ts in turn and BOTH BMP suites re-run:
 *
 *                                                   here  bmp.test.ts
 *   1 no row flip                                     10        7
 *   2 palette size assumed full (clrUsed ignored)      2        5
 *   3 channel expansion truncates instead of rounds    0        1
 *
 * Read row 3 before trusting this file. Unlike test/tiff-real.test.ts, which
 * closed a gap its builder suite provably could not reach, NOTHING here catches
 * a mutation test/bmp.test.ts misses -- and row 3 it does not catch at all.
 * Math.floor and Math.round agree on most 5-bit inputs (v=5 gives 41.13 either
 * way); they diverge only where the fraction crosses a half, such as v=3 ->
 * 24.68. test/bmp.test.ts pins that with a purpose-chosen channel value, and
 * this file's quantized source never lands on one. Do not read these fixtures
 * as covering the rounding rule.
 *
 * So the value here is NOT closing a coverage hole. It is that the palette,
 * 16-bit and 32-bit paths were previously anchored only against our own
 * builder, and are now corroborated by bytes from the format's owner -- which
 * is what catches a misreading our writer and reader would share. Two
 * real-world shapes came along with it that a builder would not have thought to
 * emit: an 8-bit file whose palette holds 224 entries rather than 256, and a
 * Format32bppArgb save that declares NO alpha.
 *
 * It also found that bmp-js expands 5-bit channels wrongly and we do not; see
 * the 555 case below.
 */

const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'bmp');
const read = (f: string) => new Uint8Array(fs.readFileSync(path.join(DIR, f)));

/** bmp-js's reading of `<name>.bmp`, as interleaved RGB. */
const oracle = (name: string) => read(`${name}.expected.raw`);
const SOURCE = () => read('source-rgb.raw');

const W = 20, H = 12;

/** Narrow away the `embedded` arm, which carries no dimensions, so a test can
 *  read width/height off the union. `expect()` does not narrow, so without this
 *  the suite is green while `npm run typecheck` is not -- the same trap
 *  test/tiff-real.test.ts hit. */
function sized(img: RasterImage): Extract<RasterImage, { width: number }> {
  if (img.kind === 'embedded') throw new Error(`expected samples, got ${img.kind}`);
  return img;
}

/** Any decoded BMP as interleaved 8-bit RGB, whatever arm it came back on.
 *  An indexed image is expanded through its OWN palette, which involves no
 *  convention: the palette is already 8-bit RGB triples. */
function toRgb(img: RasterImage): Uint8Array {
  if (img.kind === 'rgb') return img.samples;
  if (img.kind !== 'indexed') throw new Error(`unexpected kind ${img.kind}`);
  const { bpc, palette, samples } = img;
  const perByte = 8 / bpc;
  const stride = Math.ceil(W / perByte);
  const out = new Uint8Array(W * H * 3);
  const mask = (1 << bpc) - 1;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const byte = samples[y * stride + ((x / perByte) | 0)];
      const shift = 8 - bpc - (x % perByte) * bpc;
      const idx = (byte >> shift) & mask;
      out[(y * W + x) * 3] = palette[idx * 3];
      out[(y * W + x) * 3 + 1] = palette[idx * 3 + 1];
      out[(y * W + x) * 3 + 2] = palette[idx * 3 + 2];
    }
  }
  return out;
}

/** First differing byte index, or -1. Reported rather than diffing 720 bytes:
 *  a wrong stride shows as a small index, a wrong last row as a large one. */
function firstDiff(a: Uint8Array, b: Uint8Array): number {
  if (a.length !== b.length) return -2;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return i;
  return -1;
}

/** Largest per-channel difference between two same-length rasters. */
function maxDiff(a: Uint8Array, b: Uint8Array): number {
  let m = 0;
  for (let i = 0; i < a.length; i++) m = Math.max(m, Math.abs(a[i] - b[i]));
  return m;
}

describe('real-producer BMP — lossless formats', () => {
  // 24- and 32-bit BI_RGB store the source exactly, so these assert against
  // the bytes GDI+ was handed, not merely against another decoder's opinion.
  for (const name of ['gdi-24bpp', 'gdi-32bpp']) {
    it(`${name} recovers the source exactly`, () => {
      const img = sized(decodeBmp(read(`${name}.bmp`)));
      expect(img.kind).toBe('rgb');
      expect([img.width, img.height]).toEqual([W, H]);
      expect(firstDiff(toRgb(img), SOURCE())).toBe(-1);
    });

    it(`${name} agrees with bmp-js, an unrelated decoder`, () => {
      expect(firstDiff(toRgb(decodeBmp(read(`${name}.bmp`))), oracle(name))).toBe(-1);
    });
  }

  it('gdi-32bpp carries NO alpha, because the header declares none', () => {
    // The rule 10u9.2 documented, now pinned by a file from the format's owner:
    // GDI+ saves Format32bppArgb as plain BI_RGB with a 40-byte header, so the
    // fourth byte of each pixel is padding and must NOT become an /SMask.
    // Honouring it unconditionally yields a picture that is drawn, structurally
    // correct, and completely invisible.
    const bytes = read('gdi-32bpp.bmp');
    expect(dib(bytes)).toBe(40);          // not V4/V5, so no alpha mask field
    expect(compression(bytes)).toBe(0);   // BI_RGB, not BI_ALPHABITFIELDS
    expect(bpp(bytes)).toBe(32);

    const img = decodeBmp(bytes);
    expect((img as { alpha?: Uint8Array }).alpha).toBeUndefined();
  });
});

describe('real-producer BMP — palette formats', () => {
  // The ground truth here CANNOT be the source: GDI+ chooses its own adaptive
  // palette, so only something that reads the file can say what it holds.
  for (const [name, bpc, entries] of [
    ['gdi-1bpp-indexed', 1, 2], ['gdi-4bpp-indexed', 4, 16], ['gdi-8bpp-indexed', 8, 224],
  ] as const) {
    it(`${name} decodes to bmp-js's reading of it`, () => {
      const img = sized(decodeBmp(read(`${name}.bmp`)));
      expect(img.kind).toBe('indexed');
      expect((img as { bpc: number }).bpc).toBe(bpc);
      expect([img.width, img.height]).toEqual([W, H]);
      expect(firstDiff(toRgb(img), oracle(name))).toBe(-1);
    });

    it(`${name} keeps the palette the file declares (${entries} entries)`, () => {
      const img = decodeBmp(read(`${name}.bmp`));
      expect((img as { palette: Uint8Array }).palette.length).toBe(entries * 3);
    });
  }

  it('the 8-bit file really does carry a PARTIAL palette', () => {
    // 224 entries, not 256 -- GDI+ emits only what its quantizer used. A
    // decoder that assumes a full palette reads pixel data as palette bytes and
    // every offset after it is wrong, so this is worth asserting outright
    // rather than leaving implied by the case above.
    expect(clrUsed(read('gdi-8bpp-indexed.bmp'))).toBe(224);
    expect(clrUsed(read('gdi-4bpp-indexed.bmp'))).toBe(16);
  });
});

describe('real-producer BMP — 16-bit', () => {
  it('gdi-16bpp-555 is BI_RGB, with the 555 masks implied rather than stored', () => {
    const bytes = read('gdi-16bpp-555.bmp');
    expect(compression(bytes)).toBe(0);
    expect(bpp(bytes)).toBe(16);
    expect(decodeBmp(bytes).kind).toBe('rgb');
  });

  it('gdi-16bpp-555 expands 5-bit channels UPWARD of bmp-js, which truncates', () => {
    // A deliberate, measured divergence rather than an equality. Expanding a
    // 5-bit channel to 8 bits must reach full scale: bit replication
    // (v << 3) | (v >> 2) and rounding v * 255 / 31 agree everywhere, and both
    // map 31 -> 255. bmp-js instead truncates to v << 3, which caps at 248, so
    // its whole raster is systematically dark. Measured on this file: our
    // largest sample is 214 against its 208, and there is NOT ONE channel where
    // ours reads lower.
    //
    // That direction is the assertion. An equality here would have to be
    // written against the wrong convention, and a bare tolerance would pass
    // just as happily if the two decoders swapped roles.
    const got = toRgb(decodeBmp(read('gdi-16bpp-555.bmp')));
    const theirs = oracle('gdi-16bpp-555');
    expect(got.length).toBe(theirs.length);
    let below = 0;
    for (let i = 0; i < got.length; i++) if (got[i] < theirs[i]) below++;
    expect(below).toBe(0);
    // (v >> 2) is at most 7 for a 5-bit channel, so the gap is bounded.
    expect(maxDiff(got, theirs)).toBeLessThanOrEqual(7);
    expect(maxDiff(got, theirs)).toBeGreaterThan(0); // they really do differ
  });

  it('gdi-16bpp-555 decodes within its own quantization bound', () => {
    // The anchor that does not depend on bmp-js at all: 5-bit R, G and B each
    // lose at most ~4 counts against the source GDI+ was handed.
    const got = toRgb(decodeBmp(read('gdi-16bpp-555.bmp')));
    expect(maxDiff(got, SOURCE())).toBeLessThanOrEqual(8);
    expect(maxDiff(got, SOURCE())).toBeGreaterThan(0);
  });

  it('gdi-16bpp-565 is BI_BITFIELDS with the masks stored in the file', () => {
    const bytes = read('gdi-16bpp-565.bmp');
    expect(compression(bytes)).toBe(3);
    expect(masks(bytes)).toEqual([0xf800, 0x07e0, 0x001f]);
  });

  it('gdi-16bpp-565 decodes within its own quantization bound', () => {
    // This file has NO .expected.raw: bmp-js cannot read BI_BITFIELDS at all
    // (it throws), so there is no independent decoder to compare against and
    // the honest anchor is the source plus the loss the format guarantees.
    // 5-bit R and B lose at most 255/31/2 ~ 4 counts, 6-bit G at most ~2. A
    // channel swap or a mask misread blows straight through 8.
    const img = decodeBmp(read('gdi-16bpp-565.bmp'));
    expect(img.kind).toBe('rgb');
    const got = toRgb(img);
    expect(maxDiff(got, SOURCE())).toBeLessThanOrEqual(8);
    // And it is genuinely lossy, so a fixture that somehow became lossless
    // would be reporting something other than a 565 round trip.
    expect(maxDiff(got, SOURCE())).toBeGreaterThan(0);
  });

  it('the two 16-bit files really are differently encoded', () => {
    // Guards the pair above from passing vacuously on a regeneration that made
    // them identical -- 555 stores no masks, 565 stores three.
    expect(compression(read('gdi-16bpp-555.bmp')))
      .not.toBe(compression(read('gdi-16bpp-565.bmp')));
  });
});

// --- little-endian header readers, so the tests can assert on the FILE ------
const u16 = (b: Uint8Array, o: number) => b[o] | (b[o + 1] << 8);
const u32 = (b: Uint8Array, o: number) =>
  (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
const dib = (b: Uint8Array) => u32(b, 14);
const bpp = (b: Uint8Array) => u16(b, 28);
const compression = (b: Uint8Array) => u32(b, 30);
const clrUsed = (b: Uint8Array) => u32(b, 46);
const masks = (b: Uint8Array) => [u32(b, 54), u32(b, 58), u32(b, 62)];

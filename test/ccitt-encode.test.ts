import { describe, it, expect } from 'vitest';
import { decodeCcitt } from '../src/ccitt.js';
import { encodeG4 } from '../src/ccittencode.js';

/**
 * The oracle here is unusually strong, and worth naming: `decodeCcitt`'s G4
 * path is anchored by `test/fixtures/tiff/libtiff-g4-strips.tif` and
 * `libtiff-g4-tiled.tif` — real files written by libtiff, with ground truth
 * from a third decoder. So a round trip through it is not the writer checking
 * itself; it is the writer checked against a reader that agrees with libtiff.
 */
const rowBytes = (columns: number) => (columns + 7) >> 3;

/** Pack a 0/1 pixel grid into MSB-first rows, 1 = black. */
function pack(grid: number[][], columns: number): Uint8Array {
  const rb = rowBytes(columns);
  const out = new Uint8Array(rb * grid.length);
  grid.forEach((row, y) => {
    for (let x = 0; x < columns; x++) if (row[x]) out[y * rb + (x >> 3)] |= 0x80 >> (x & 7);
  });
  return out;
}

/** Encode, decode, and require the bitmap back unchanged. */
function roundTrip(grid: number[][], columns: number): void {
  const src = pack(grid, columns);
  const enc = encodeG4(src, columns, grid.length);
  const back = decodeCcitt(enc, {
    k: -1, columns, rows: grid.length,
    blackIs1: false, byteAlign: false, endOfLine: false, endOfBlock: true,
  });
  expect([...back]).toEqual([...src]);
}

/** Deterministic pseudo-random bits, so a failure is reproducible. */
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 0x100000000; };
}

describe('encodeG4', () => {
  it('round-trips an all-white image', () => {
    roundTrip(Array.from({ length: 4 }, () => new Array(64).fill(0)), 64);
  });

  it('round-trips an all-black image', () => {
    roundTrip(Array.from({ length: 4 }, () => new Array(64).fill(1)), 64);
  });

  it('round-trips vertical stripes, which stay in vertical mode', () => {
    const grid = Array.from({ length: 8 }, () =>
      Array.from({ length: 40 }, (_, x) => (x >> 2) & 1));
    roundTrip(grid, 40);
  });

  // A row whose transitions sit far from the reference line's is what forces
  // HORIZONTAL mode; vertical mode only covers a shift of at most 3.
  it('round-trips content that forces horizontal mode', () => {
    const grid = [
      Array.from({ length: 64 }, (_, x) => (x < 8 ? 1 : 0)),
      Array.from({ length: 64 }, (_, x) => (x >= 40 && x < 56 ? 1 : 0)),
      Array.from({ length: 64 }, (_, x) => (x < 4 ? 1 : 0)),
    ];
    roundTrip(grid, 64);
  });

  // PASS mode fires when the reference line's run ends before the coding
  // line's next change — a black block on one row and none beneath it.
  it('round-trips content that forces pass mode', () => {
    const grid = [
      Array.from({ length: 64 }, (_, x) => (x >= 8 && x < 24 ? 1 : 0)),
      Array.from({ length: 64 }, (_, x) => (x >= 40 ? 1 : 0)),
    ];
    roundTrip(grid, 64);
  });

  // Runs past 63 need makeup codes, past 1728 the shared extended makeups, and
  // past 2560 several of them. A narrow fixture never leaves the terminating
  // codes at all, so it cannot see any of that.
  it('round-trips runs long enough to need makeup and extended makeup codes', () => {
    for (const columns of [100, 1800, 2700, 5300]) {
      const grid = [
        new Array(columns).fill(0),
        new Array(columns).fill(1),
        Array.from({ length: columns }, (_, x) => (x < columns - 1 ? 0 : 1)),
      ];
      roundTrip(grid, columns);
    }
  });

  it('round-trips a width that is not a multiple of 8', () => {
    for (const columns of [1, 7, 9, 23, 65]) {
      const grid = Array.from({ length: 3 }, (_, y) =>
        Array.from({ length: columns }, (_, x) => (x + y) % 3 === 0 ? 1 : 0));
      roundTrip(grid, columns);
    }
  });

  it('round-trips pseudo-random noise', () => {
    const rnd = lcg(20260826);
    for (const [columns, rows] of [[64, 16], [37, 11], [200, 30]] as const) {
      const grid = Array.from({ length: rows }, () =>
        Array.from({ length: columns }, () => (rnd() < 0.35 ? 1 : 0)));
      roundTrip(grid, columns);
    }
  });

  // What this asserts, and what it deliberately does NOT.
  //
  // It asserts that G4 compresses sparse bilevel content substantially against
  // the raw bitmap, which is measurable and is the reason to reach for it.
  //
  // It does NOT assert that G4 beats Deflate. That was the original claim here
  // and it did not survive measurement: on a synthetic page with independently
  // random rows Deflate wins outright (G4 is ~1.5x larger), and even with
  // realistic VERTICAL COHERENCE — a glyph stroke repeating down several rows,
  // which is what G4's 2D mode exists to exploit — the two come out within 2%
  // of each other. Real scans favour G4 more strongly than any fixture we can
  // synthesize, but no real fax TIFF is vendored here, so the comparison would
  // be an unbacked claim tuned until it passed. The reason to write G4 is what
  // fax and archival toolchains EXPECT to read, not a size win we can prove.
  it('compresses sparse bilevel content well against the raw bitmap', () => {
    const columns = 1728, rows = 200;
    const grid = Array.from({ length: rows }, (_, y) =>
      Array.from({ length: columns }, (_, x) =>
        (y % 20 < 12 && x % 64 < 28) ? 1 : 0));
    const src = pack(grid, columns);

    const g4 = encodeG4(src, columns, rows);

    expect(g4.length).toBeLessThan(src.length / 8);
    roundTrip(grid, columns);
  });

  // MODE SELECTION cannot be checked by round trip, and this is the one test
  // here that is not a round trip for that reason. Any mode choice that decodes
  // back to the same bitmap is *correct* G4 — dropping VR3 and falling through
  // to horizontal mode round-trips perfectly and costs only size. Measured:
  // deleting VR3 takes this fixture from 117 to 203 bytes, so a size bound is
  // the only thing that can see it. Every transition here is exactly +3 from
  // the row above, which is precisely what VR3 codes in 7 bits.
  it('stays in vertical mode on a +3 staircase, which only a size bound sees', () => {
    const columns = 400, rows = 60;
    const grid = Array.from({ length: rows }, (_, y) =>
      Array.from({ length: columns }, (_, x) => (x >= 10 + y * 3 && x < 50 + y * 3 ? 1 : 0)));
    const src = pack(grid, columns);

    expect(encodeG4(src, columns, rows).length).toBeLessThan(150);
    roundTrip(grid, columns);
  });

  it('rejects a buffer that is too small for the stated geometry', () => {
    expect(() => encodeG4(new Uint8Array(4), 64, 4)).toThrow(TypeError);
  });
});

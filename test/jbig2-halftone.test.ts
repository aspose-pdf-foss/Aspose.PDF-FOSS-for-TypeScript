import { describe, it, expect } from 'vitest';
import { decodeJbig2, newBitmap, type Bitmap } from '../src/jbig2.js';
import { PdfParseError } from '../src/errors.js';
import {
  cellOrigin, grayscaleValues, halftoneSkip, patternDictAt, grayscaleAt,
  decodePatternDict, decodeHalftoneRegion, type HalftoneParams,
} from '../src/jbig2halftone.js';
import * as F from './helpers/jbig2-halftone-vectors.js';
import * as E from './helpers/jbig2-fixtures.js';
import { encodeG4 } from './helpers/ccitt-encode.js';

function fromRows(r: readonly string[]): Bitmap {
  const bm = newBitmap(r[0].length, r.length);
  for (let y = 0; y < r.length; y++) for (let x = 0; x < r[y].length; x++) bm.data[y * bm.width + x] = r[y][x] === '1' ? 1 : 0;
  return bm;
}

// ---------------------------------------------------------------------------
// The anchors. Two of this feature's three risks are PUBLISHED transforms, so
// unlike the refinement work (utax.5) there is outside evidence available and
// it costs no bitstream at all. These tests are worth more than the round trip
// below them, which can only ever confirm that our encoder and our decoder read
// T.88 the same way.
// ---------------------------------------------------------------------------

describe('jbig2 halftone grid geometry', () => {
  // T.88 §6.6.5.2:  x = HGX + mg*HRY + ng*HRX,  y = HGY + mg*HRX - ng*HRY,
  // both >> 8 because the vectors are 8.8 fixed point. The CROSS TERMS are the
  // whole point: transposing the pair renders the screen rotated, which reads
  // as an unusual halftone rather than as a decode fault. So each axis is
  // pinned with the other zeroed, which no single grid could do.
  const grid = (vectorX: number, vectorY: number, gridX = 0, gridY = 0) => ({ gridX, gridY, vectorX, vectorY });

  it('lays an axis-aligned screen out row by row', () => {
    const g = grid(256, 0); // one pel per column step, no shear
    expect(cellOrigin(g, 0, 3)).toEqual({ x: 3, y: 0 });
    expect(cellOrigin(g, 2, 0)).toEqual({ x: 0, y: 2 });
  });

  it('rotates when the vector pair is swapped', () => {
    const g = grid(0, 256);
    expect(cellOrigin(g, 0, 3)).toEqual({ x: 0, y: -3 }); // ng drives -y
    expect(cellOrigin(g, 2, 0)).toEqual({ x: 2, y: 0 });  // mg drives +x
  });

  // `>>` floors toward negative infinity; `| 0` truncates toward zero. They
  // agree for every non-negative origin, so only a grid starting off the left
  // or top edge can tell them apart — and HGX/HGY are signed precisely so that
  // one can. Same trap utax.5 recorded for (RDW >> 1).
  it('floors a negative origin rather than truncating it', () => {
    expect(cellOrigin(grid(256, 0, -128, -128), 0, 0)).toEqual({ x: -1, y: -1 });
  });
});

describe('jbig2 grayscale plane assembly', () => {
  // Annex C.5 is Gray decoding, and the Gray sequence is published: 00 01 11 10
  // name 0 1 2 3. Hand-computed, no bitstream, none of our own encoder involved.
  it('folds two Gray-coded planes into the values they name', () => {
    const msb = fromRows(['0011']);
    const lsb = fromRows(['0110']);
    expect(Array.from(grayscaleValues([lsb, msb], 4, 1))).toEqual([0, 1, 2, 3]);
  });

  // Three planes, so the fold is genuinely a chain rather than one XOR: the
  // published Gray code for 0..7 is 0,1,3,2,6,7,5,4.
  it('folds a three-plane chain', () => {
    const b2 = fromRows(['00001111']);
    const b1 = fromRows(['00111100']);
    const b0 = fromRows(['01100110']);
    expect(Array.from(grayscaleValues([b0, b1, b2], 8, 1))).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
  });

  it('gives every cell pattern 0 when there are no planes at all', () => {
    // HNUMPATS == 1 gives ceil(log2(1)) == 0 planes, so the grid still has a
    // size and every cell names the only pattern there is.
    expect(Array.from(grayscaleValues([], 3, 1))).toEqual([0, 0, 0]);
  });
});

describe('jbig2 halftone adaptive-template pixels', () => {
  // T.88 §6.7.5 pins AT1 of the collective bitmap at (-HDPW, 0) — the same
  // column of the PREVIOUS pattern, which is the correlation the collective
  // layout exists to exploit. A transcription check against a published
  // constant, NOT an independent decode: our own encoder reads the same line of
  // the spec, so a round trip cannot see this at all.
  it('pins the collective bitmap AT1 to the previous pattern', () => {
    expect(patternDictAt(4, 0)).toEqual([{ x: -4, y: 0 }, { x: -3, y: -1 }, { x: 2, y: -2 }, { x: -2, y: -2 }]);
    expect(patternDictAt(7, 0)[0]).toEqual({ x: -7, y: 0 });
  });

  // T.88 §6.2.5.3: templates 1-3 have ONE adaptive pixel, not four. Handing
  // decodeGeneric four of them widens the context from 13 bits to 15 and
  // decodes noise, so the length is part of the answer.
  it('gives templates 1-3 a single adaptive pixel', () => {
    expect(patternDictAt(4, 1).length).toBe(1);
    expect(grayscaleAt(0).length).toBe(4);
    expect(grayscaleAt(2).length).toBe(1);
  });

  // T.88 §6.6.5.1: the grayscale bitplanes take the nominal set, whose AT1
  // moves with the template — +3 for templates 0 and 1, +2 for 2 and 3.
  it('moves the grayscale AT1 with the template', () => {
    expect(grayscaleAt(0)[0]).toEqual({ x: 3, y: -1 });
    expect(grayscaleAt(1)[0]).toEqual({ x: 3, y: -1 });
    expect(grayscaleAt(2)[0]).toEqual({ x: 2, y: -1 });
    expect(grayscaleAt(3)[0]).toEqual({ x: 2, y: -1 });
  });
});

describe('jbig2 halftone skip bitmap', () => {
  // T.88 §6.6.5.1: a cell is skipped only when its whole stamp misses the
  // region. A cell that merely hangs over the edge is decoded and clipped.
  it('marks only the cells whose whole stamp misses the region', () => {
    const skip = halftoneSkip({
      width: 8, height: 8, gridWidth: 4, gridHeight: 1,
      gridX: -512, gridY: 0, vectorX: 512, vectorY: 0,
      patternWidth: 2, patternHeight: 2,
    });
    // ng=0 -> x=-2 with a 2-wide pattern: entirely off, skipped.
    // ng=1 -> x=0, ng=2 -> x=2, ng=3 -> x=4: all inside.
    expect(Array.from(skip.data)).toEqual([1, 0, 0, 0]);
  });

  it('does not skip a cell that merely overhangs the edge', () => {
    const skip = halftoneSkip({
      width: 8, height: 8, gridWidth: 2, gridHeight: 1,
      gridX: -256, gridY: 0, vectorX: 512, vectorY: 0,
      patternWidth: 2, patternHeight: 2,
    });
    // ng=0 -> x=-1: one of its two columns is still on the region.
    expect(Array.from(skip.data)).toEqual([0, 0]);
  });

  it('marks cells past the bottom of the region', () => {
    const skip = halftoneSkip({
      width: 8, height: 4, gridWidth: 1, gridHeight: 3,
      gridX: 0, gridY: 0, vectorX: 512, vectorY: 0,
      patternWidth: 2, patternHeight: 2,
    });
    // mg drives +y here: rows at y = 0, 2, 4. The last is past height 4.
    expect(Array.from(skip.data)).toEqual([0, 0, 1]);
  });
});

// ---------------------------------------------------------------------------
// The round trip. Minted by scripts/mqenc.mjs and decoded here, so it runs
// between two independently written implementations — but it can only confirm
// that both read T.88 the same way, which is why the anchors above exist.
// ---------------------------------------------------------------------------

/** The expected region for a grid whose vectors TILE EXACTLY (HRX = 256*HDPW,
 *  HRY = 0, origin on a cell boundary): cell (m, n) is simply the pattern its
 *  value names, laid at (n*HDPW, m*HDPH). Stated in those terms on purpose —
 *  re-deriving it from T.88's placement formula would make this a second copy
 *  of the code under test. The cross terms are pinned by cellOrigin above. */
function tiled(v: {
  width: number; height: number; gridWidth: number; patternWidth: number; patternHeight: number;
  patterns: number[][]; values: number[]; skipped?: number[]; firstColumn?: number;
}): string[] {
  const out: string[] = [];
  const col0 = v.firstColumn ?? 0;
  for (let y = 0; y < v.height; y++) {
    let row = '';
    for (let x = 0; x < v.width; x++) {
      const ng = Math.floor(x / v.patternWidth) + col0;
      const mg = Math.floor(y / v.patternHeight);
      const p = v.patterns[v.values[mg * v.gridWidth + ng]];
      row += p[(y % v.patternHeight) * v.patternWidth + (x % v.patternWidth)] ? '1' : '0';
    }
    out.push(row);
  }
  return out;
}

function rows(bm: Bitmap): string[] {
  const o: string[] = [];
  for (let y = 0; y < bm.height; y++) o.push(Array.from(bm.data.subarray(y * bm.width, (y + 1) * bm.width)).join(''));
  return o;
}

const asBitmaps = (v: { patterns: number[][]; patternWidth: number; patternHeight: number }): Bitmap[] =>
  v.patterns.map((p) => ({ width: v.patternWidth, height: v.patternHeight, data: Uint8Array.from(p) }));

describe('jbig2 pattern dictionary', () => {
  it('slices one collective bitmap into its patterns', () => {
    const v = F.patterndict;
    const got = decodePatternDict(v.bytes, 0, v.bytes.length, {
      mmr: false, template: v.template,
      patternWidth: v.patternWidth, patternHeight: v.patternHeight, grayMax: v.grayMax,
    });
    expect(got.length).toBe(v.grayMax + 1);
    expect(got.map((p) => Array.from(p.data))).toEqual(v.patterns);
    // There is ONE bitmap on the wire, not one per pattern: (GRAYMAX+1)*HDPW
    // wide. A decoder that read four separate regions would desynchronise.
    expect(v.collectiveWidth).toBe((v.grayMax + 1) * v.patternWidth);
  });

  it('refuses a zero-size pattern rather than decoding a degenerate bitmap', () => {
    expect(() => decodePatternDict(new Uint8Array(4), 0, 4, {
      mmr: false, template: 0, patternWidth: 0, patternHeight: 4, grayMax: 3,
    })).toThrow(PdfParseError);
  });

  // (GRAYMAX+1)*HDPW*HDPH is the one place in JBIG2 where a product of three
  // header fields sizes an allocation, so a corrupt header must be refused
  // rather than left to blow up as a RangeError.
  it('refuses an absurd collective bitmap', () => {
    expect(() => decodePatternDict(new Uint8Array(4), 0, 4, {
      mmr: false, template: 0, patternWidth: 255, patternHeight: 255, grayMax: 0xffffffff,
    })).toThrow(/too large/);
  });
});

describe('jbig2 halftone region', () => {
  const paramsOf = (v: typeof F.halftone_plain, over: Partial<HalftoneParams> = {}): HalftoneParams => ({
    width: v.width, height: v.height, mmr: false, template: v.template,
    enableSkip: false, combOp: 0, defPixel: 0,
    gridWidth: v.gridWidth, gridHeight: v.gridHeight,
    gridX: v.gridX, gridY: v.gridY, vectorX: v.vectorX, vectorY: v.vectorY,
    patterns: asBitmaps(v), ...over,
  });

  it('decodes a grid of Gray-coded planes and stamps their patterns', () => {
    const v = F.halftone_plain;
    const bm = decodeHalftoneRegion(v.bytes, 0, v.bytes.length, paramsOf(v));
    expect(rows(bm)).toEqual(tiled(v));
  });

  it('skips the cells HENABLESKIP marks, consuming no decisions for them', () => {
    const v = F.halftone_skip;
    const bm = decodeHalftoneRegion(v.bytes, 0, v.bytes.length, paramsOf(v, { enableSkip: true }));
    // Column 0 of the grid lands at x = -2 and is off the region entirely, so
    // the visible 8x8 is columns 1..4.
    expect(rows(bm)).toEqual(tiled({ ...v, firstColumn: 1 }));
    expect(v.skipped.slice(0, 5)).toEqual([1, 0, 0, 0, 0]);
  });

  it('refuses a halftone region that refers to no pattern dictionary', () => {
    const v = F.halftone_plain;
    expect(() => decodeHalftoneRegion(v.bytes, 0, v.bytes.length, paramsOf(v, { patterns: [] })))
      .toThrow(/no pattern dictionary/);
  });
});

// ---------------------------------------------------------------------------
// HMMR. This fixture needs no arithmetic coder and therefore no minted vector:
// it is assembled here from test/helpers/ccitt-encode.ts, which already exists
// and is already pinned against golden bit strings by test/ccitt-encode.test.ts.
// A second G4 encoder in scripts/jbig2-codec.mjs would be a second reading of
// T.6 bought for nothing.
// ---------------------------------------------------------------------------

describe('jbig2 halftone under HMMR', () => {
  const HDPW = 2, HDPH = 2, GW = 4, GH = 4;
  const patterns = [[0, 0, 0, 0], [1, 0, 0, 0], [1, 0, 0, 1], [1, 1, 1, 1]];
  const values = [0, 1, 2, 3, 3, 2, 1, 0, 1, 3, 0, 2, 2, 0, 3, 1];

  /** Bitplane j of the Gray code of `values`, in encodeG4's row-of-pixels shape.
   *  `gray = v ^ (v >> 1)` is the inverse of the decoder's downward fold. */
  const planeRows = (j: number): number[][] => {
    const out: number[][] = [];
    for (let mg = 0; mg < GH; mg++) {
      const row: number[] = [];
      for (let ng = 0; ng < GW; ng++) { const v = values[mg * GW + ng]; row.push(((v ^ (v >> 1)) >> j) & 1); }
      out.push(row);
    }
    return out;
  };

  const asBm = (p: number[]): Bitmap => ({ width: HDPW, height: HDPH, data: Uint8Array.from(p) });
  const expected = tiled({
    width: 8, height: 8, gridWidth: GW, patternWidth: HDPW, patternHeight: HDPH, patterns, values,
  });

  it('decodes bitplanes that share ONE MMR datastream', () => {
    // Annex C.5: the planes are NOT separate streams. MSB first, each terminated
    // by its own EOFB, concatenated. The second plane is readable at all only
    // because decodeCcittConsumed reported where the first one stopped.
    const msb = encodeG4(planeRows(1), { eofb: true });
    const lsb = encodeG4(planeRows(0), { eofb: true });
    const stream = new Uint8Array(msb.length + lsb.length);
    stream.set(msb, 0); stream.set(lsb, msb.length);

    const bm = decodeHalftoneRegion(stream, 0, stream.length, {
      width: 8, height: 8, mmr: true, template: 0, enableSkip: false, combOp: 0, defPixel: 0,
      gridWidth: GW, gridHeight: GH, gridX: 0, gridY: 0, vectorX: 256 * HDPW, vectorY: 0,
      patterns: patterns.map(asBm),
    });
    expect(rows(bm)).toEqual(expected);
    // Two planes, not one: with a single plane the offset would never advance
    // and the test could not see the byte count at all.
    expect(msb.length).toBeGreaterThan(0);
  });

  it('decodes an MMR collective bitmap in the pattern dictionary', () => {
    // (GRAYMAX+1)*HDPW = 8 wide, HDPH = 2 tall, one bitmap for all four patterns.
    const collective: number[][] = [];
    for (let y = 0; y < HDPH; y++) {
      const row: number[] = [];
      for (const p of patterns) for (let x = 0; x < HDPW; x++) row.push(p[y * HDPW + x]);
      collective.push(row);
    }
    const bytes = encodeG4(collective, { eofb: true });
    const got = decodePatternDict(bytes, 0, bytes.length, {
      mmr: true, template: 0, patternWidth: HDPW, patternHeight: HDPH, grayMax: patterns.length - 1,
    });
    expect(got.map((p) => Array.from(p.data))).toEqual(patterns);
  });
});

// ---------------------------------------------------------------------------
// End to end, through decodeJbig2's segment loop.
// ---------------------------------------------------------------------------

describe('jbig2 halftone segments', () => {
  it('assembles a pattern dictionary and a halftone region onto the page', () => {
    const [w, h] = E.dims.halftone;
    expect(Array.from(decodeJbig2(E.halftone_stream, undefined, w, h)))
      .toEqual(Array.from(E.halftone_samples));
  });

  // utax.4's rule, unchanged: an intermediate region is held under its segment
  // number for a later segment to consume and is invisible to the page. Nothing
  // consumes this one, so the page stays blank — which under packBitmap's
  // inversion is all 0xff.
  it('holds an intermediate halftone region off the page', () => {
    const [w, h] = E.dims.halftone;
    const out = decodeJbig2(E.intermediate_halftone_stream, undefined, w, h);
    expect(Array.from(out).every((b) => b === 0xff)).toBe(true);
    // ...and the immediate form of the same body genuinely draws something, so
    // "blank" above is a decision rather than an empty fixture.
    expect(Array.from(decodeJbig2(E.halftone_stream, undefined, w, h)).some((b) => b !== 0xff)).toBe(true);
  });
});

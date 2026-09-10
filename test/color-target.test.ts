import { describe, it, expect } from 'vitest';
import { convertComps, type GraySpace, type TargetSpace } from '../src/colorrule.js';
import { rgbToCmyk } from '../src/pdfxcolor.js';
import type { ColorConverter } from '../src/colorspace.js';

const GRAY: GraySpace = { kind: 'gray' };
const RGB: GraySpace = { kind: 'rgb' };
const CMYK: GraySpace = { kind: 'cmyk' };

/**
 * `convertComps` -- the one conversion rule (85l8.1), generalizing `grayOf`.
 *
 * It pivots through RGB, which is what `grayOf` already did: its CMYK arm is
 * literally naive cmyk->rgb followed by luma, and its `other` arm goes via
 * `ColorConverter.toRgb`. What is NEW is that the far side is a target rather
 * than always luma.
 */
describe('convertComps — identity short-circuits', () => {
  // These are the byte-identity property, not an optimization. luma's weights
  // sum to 0.9999999999999999, so a gray source pivoted through RGB comes back
  // one ulp low and every grey operand in every document is re-rounded. The
  // same reasoning covers rgb->rgb and cmyk->cmyk, where a round trip through
  // the pivot is lossy in the last decimal for a different reason: rgbToCmyk
  // divides by (1 - k).
  it('returns a gray source unchanged for a gray target', () => {
    expect(convertComps([0.5], GRAY, 'gray')).toEqual([0.5]);
  });

  // Measured and NOT covered: this one holds whether or not the short-circuit
  // runs, because `rgbPivot` returns an rgb source raw and `clamp01` is the
  // identity in range. Disabling the short-circuit for rgb alone leaves the
  // whole suite green; disabling it outright reddens the two cases either side
  // of this. Asserted anyway so the rule reads as a rule.
  it('returns an rgb source unchanged for an rgb target', () => {
    expect(convertComps([0.1, 0.2, 0.3], RGB, 'rgb')).toEqual([0.1, 0.2, 0.3]);
  });

  it('returns a cmyk source unchanged for a cmyk target', () => {
    expect(convertComps([0.1, 0.2, 0.3, 0.4], CMYK, 'cmyk')).toEqual([0.1, 0.2, 0.3, 0.4]);
  });
});

describe('convertComps — to gray', () => {
  it('is Rec. 601 luma of the rgb pivot', () => {
    expect(convertComps([1, 0, 0], RGB, 'gray')[0]).toBeCloseTo(0.299, 10);
    // Pure cyan -> rgb(0,1,1) -> 0.587 + 0.114, `grayOf`'s own assertion.
    expect(convertComps([1, 0, 0, 0], CMYK, 'gray')[0]).toBeCloseTo(0.701, 10);
  });

  it('emits exactly one component', () => {
    expect(convertComps([1, 0, 0], RGB, 'gray')).toHaveLength(1);
  });
});

describe('convertComps — to rgb', () => {
  it('replicates a gray source across all three channels', () => {
    expect(convertComps([0.25], GRAY, 'rgb')).toEqual([0.25, 0.25, 0.25]);
  });

  it('converts cmyk through the same naive rule grayOf used', () => {
    // Pure cyan at k=0 -> (0, 1, 1).
    const out = convertComps([1, 0, 0, 0], CMYK, 'rgb');
    expect(out[0]).toBeCloseTo(0, 10);
    expect(out[1]).toBeCloseTo(1, 10);
    expect(out[2]).toBeCloseTo(1, 10);
  });
});

describe('convertComps — to cmyk', () => {
  // Reusing pdfxcolor.ts's transform rather than deriving a second one is the
  // epic's own rule: two conversions disagreeing about one document is exactly
  // what the single-owner rule exists to prevent.
  it('agrees with pdfxcolor.ts s rgbToCmyk on an rgb source', () => {
    expect(convertComps([0.2, 0.4, 0.6], RGB, 'cmyk')).toEqual(rgbToCmyk(0.2, 0.4, 0.6));
  });

  it('sends a gray source to pure K, leaving c, m and y at zero', () => {
    // A grey is neutral, so black generation takes all of it: anything else
    // would lay three inks where one will do, which is wrong on press.
    expect(convertComps([0.25], GRAY, 'cmyk')).toEqual([0, 0, 0, 0.75]);
  });

  it('emits exactly four components', () => {
    expect(convertComps([1, 0, 0], RGB, 'cmyk')).toHaveLength(4);
  });
});

describe('convertComps — non-device sources', () => {
  it('routes a non-device space through its ColorConverter for every target', () => {
    const converter: ColorConverter = {
      components: 1,
      family: 'separation',
      toRgb: () => [255, 0, 0],       // 0..255, as colorspace.ts emits
      initial: () => [0, 0, 0],
    };
    const space: GraySpace = { kind: 'other', converter };
    expect(convertComps([0.7], space, 'gray')[0]).toBeCloseTo(0.299, 10);
    expect(convertComps([0.7], space, 'rgb')).toEqual([1, 0, 0]);
    expect(convertComps([0.7], space, 'cmyk')).toEqual(rgbToCmyk(1, 0, 0));
  });

  it('reads a pattern space through its base', () => {
    expect(convertComps([1, 0, 0], { kind: 'pattern', base: RGB }, 'gray')[0])
      .toBeCloseTo(0.299, 10);
  });

  it('treats missing components as zero rather than NaN', () => {
    expect(convertComps([], RGB, 'gray')).toEqual([0]);
    expect(convertComps([], RGB, 'cmyk')).toEqual([0, 0, 0, 1]);
  });
});

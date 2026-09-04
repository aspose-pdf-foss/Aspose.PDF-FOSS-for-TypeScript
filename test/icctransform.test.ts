import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  srgbToXyzD50, xyzToLab, labToV2, iccCmykTransform,
} from '../src/icctransform.js';
import { srgbIcc } from '../src/srgb.js';
import { UnsupportedFeatureError, PdfParseError } from '../src/errors.js';

const fixture = (): Uint8Array =>
  new Uint8Array(readFileSync('test/fixtures/icc/synthetic-cmyk.icc'));

/**
 * The source leg: sRGB to the profile connection space (85l8.7.2).
 *
 * sRGB is defined by a specification rather than by a file, so this leg is
 * written out rather than parsed from `srgb.ts` — which keeps the whole
 * feature dependent on exactly one profile, the caller's destination.
 *
 * Every expectation is a published value, not one recorded from our own run.
 */
describe('srgbToXyzD50', () => {
  // White must land on the D50 illuminant, which is what "D50-adapted" means.
  it('maps white to the D50 illuminant', () => {
    const [x, y, z] = srgbToXyzD50(1, 1, 1);
    expect(x).toBeCloseTo(0.9642, 3);
    expect(y).toBeCloseTo(1.0000, 3);
    expect(z).toBeCloseTo(0.8249, 3);
  });

  it('maps black to zero', () => {
    expect(srgbToXyzD50(0, 0, 0)).toEqual([0, 0, 0]);
  });

  /**
   * The sRGB transfer function is a linear segment below 0.04045 and a
   * 2.4 power above it — NOT a plain 2.2 gamma. The two differ most in the
   * shadows, so mid grey is where a plain-gamma implementation looks nearly
   * right: sRGB 128/255 has L* 53.6, and a 2.2 gamma gives 53.0.
   */
  it('uses the piecewise transfer function, not a plain 2.2 gamma', () => {
    const [, y] = srgbToXyzD50(128 / 255, 128 / 255, 128 / 255);
    const [l] = xyzToLab(0, y, 0);
    expect(l).toBeCloseTo(53.6, 1);
  });
});

describe('xyzToLab', () => {
  it('maps the D50 white to L* 100', () => {
    const [l, a, b] = xyzToLab(0.9642, 1.0, 0.8249);
    expect(l).toBeCloseTo(100, 2);
    expect(a).toBeCloseTo(0, 2);
    expect(b).toBeCloseTo(0, 2);
  });

  it('maps zero to L* 0', () => {
    expect(xyzToLab(0, 0, 0)[0]).toBeCloseTo(0, 6);
  });
});

/**
 * How Lab reaches the LUT's input range — and BOTH halves were got wrong
 * first, which is why each is now solved from the goldens rather than
 * reasoned about.
 *
 * L* 100 maps to the FULL range, 1.0. The plausible wrong reading is
 * `× 65280/65535`, because ICC v2 stores Lab in a legacy encoding whose
 * L* 100 is 0xFF00 — that put every colour 0.383% low, proportional to L*,
 * zero at black and worst at white. A uniformly slightly-light document,
 * invisible without a reference.
 *
 * a* and b* go the OTHER way: the legacy `(v + 128) * 256` over 0..0xFFFF, so
 * a* 0 sits at 0x8000. The plausible wrong reading there is `(v + 128) / 255`,
 * which is off by 2e-3 where this one matches WCS to 1e-4.
 *
 * The asymmetry reads like an inconsistency and is what was measured.
 */
describe('labToV2', () => {
  it('encodes L* 100 as the full input range', () => {
    expect(labToV2(100, 0, 0)[0]).toBe(1);
  });

  it('encodes L* 0 as zero', () => {
    expect(labToV2(0, 0, 0)[0]).toBe(0);
  });

  it('encodes a* and b* 0 at the half-scale offset', () => {
    const [, a, b] = labToV2(50, 0, 0);
    expect(a).toBeCloseTo(32768 / 65535, 4);
    expect(b).toBeCloseTo(32768 / 65535, 4);
  });

  it('clamps an out-of-range value into the encoding', () => {
    expect(labToV2(200, 0, 0)[0]).toBeLessThanOrEqual(1);
    expect(labToV2(-50, 0, 0)[0]).toBeGreaterThanOrEqual(0);
  });
});

/**
 * The whole composition, against the fixture's own affine rule:
 *   C = 0.10 + 0.40·l, M = 0.20 + 0.30·a, Y = 0.30 + 0.20·b, K = 0.05 + 0.10·l
 * with l, a, b the v2-encoded Lab fractions. Every expectation is arithmetic
 * rather than a recorded number.
 */
describe('iccCmykTransform', () => {
  it('transforms black through the profile', () => {
    const t = iccCmykTransform(fixture());
    const [c, m, y, k] = t(0, 0, 0);
    expect(c).toBeCloseTo(0.10, 3);
    expect(m).toBeCloseTo(0.35, 3);
    expect(y).toBeCloseTo(0.40, 3);
    expect(k).toBeCloseTo(0.05, 3);
  });

  it('transforms white through the profile', () => {
    const t = iccCmykTransform(fixture());
    const [c, , , k] = t(1, 1, 1);
    // L* 100 encodes to the full input range, so l = 1.
    expect(c).toBeCloseTo(0.50, 3);
    expect(k).toBeCloseTo(0.15, 3);
  });

  // The value this whole feature exists for: a mid grey inks all four
  // channels, where the naive rgbToCmyk leaves three empty.
  it('inks a mid grey through the profile rather than leaving it to K', () => {
    const t = iccCmykTransform(fixture());
    const [c, m, y, k] = t(128 / 255, 128 / 255, 128 / 255);
    // L* 53.6 -> l = 0.536
    expect(c).toBeCloseTo(0.10 + 0.40 * 0.536, 2);
    expect(m).toBeCloseTo(0.35, 2);
    expect(y).toBeCloseTo(0.40, 2);
    expect(k).toBeCloseTo(0.05 + 0.10 * 0.536, 2);
  });

  it('returns four numbers in 0..1 for every corner of the cube', () => {
    const t = iccCmykTransform(fixture());
    for (const [r, g, b] of [[0, 0, 0], [1, 0, 0], [0, 1, 0], [0, 0, 1], [1, 1, 1]]) {
      const out = t(r as number, g as number, b as number);
      expect(out).toHaveLength(4);
      for (const v of out) {
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThanOrEqual(1);
      }
    }
  });

  it('selects the tag the intent names', () => {
    // Our fixture's three B2A tags hold identical data, so this asserts only
    // that a stated intent is accepted and resolves to a tag.
    expect(() => iccCmykTransform(fixture(), { intent: 1 })).not.toThrow();
    expect(() => iccCmykTransform(fixture(), { intent: 2 })).not.toThrow();
  });
});

/**
 * Every refusal happens in the FACTORY, before any conversion — so a profile
 * we decline leaves the document byte-identical, which is the rule
 * `checkTarget` and `checkTransform` already follow.
 */
describe('iccCmykTransform — refusals', () => {
  it('refuses a profile whose device space is not CMYK', () => {
    expect(() => iccCmykTransform(srgbIcc())).toThrow(UnsupportedFeatureError);
  });

  it('refuses bytes that are not a profile at all', () => {
    expect(() => iccCmykTransform(new Uint8Array(200))).toThrow(PdfParseError);
  });

  it('refuses absolute colorimetric, which has no B2A tag of its own', () => {
    expect(() => iccCmykTransform(fixture(), { intent: 3 as 0 }))
      .toThrow(UnsupportedFeatureError);
  });

  /**
   * A v4 profile is DECLINED, not mis-read. Its `B2A` is an `mBA ` lutBtoAType
   * with a different element order, so reading it as an `mft2` would produce
   * confident nonsense. Only the header version is changed here — enough to
   * reach the version check, which runs first.
   */
  it('refuses a v4 profile rather than reading its tags as v2', () => {
    const v4 = fixture();
    v4[8] = 4;
    expect(() => iccCmykTransform(v4)).toThrow(UnsupportedFeatureError);
  });
});

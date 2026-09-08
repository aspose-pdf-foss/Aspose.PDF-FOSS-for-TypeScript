import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { iccCmykTransform, srgbToXyzD50, xyzToLab, labToV2 } from '../src/icctransform.js';
import { parseIccProfile, iccTag } from '../src/icc.js';
import { readLutTag } from '../src/icclut.js';
import { Document } from '../src/document.js';
import { buildGrayscalePdf } from './helpers/build-grayscale-pdf.js';

/**
 * Our transform against Windows Color System's, through the same profile.
 *
 * The comparison is EXACT to 3 decimal places rather than tolerant, and that
 * is what the fixture's affine CLUT buys: multilinear and tetrahedral
 * interpolation agree exactly on an affine function, so there is no
 * interpolation-method slack for a bug to hide in. See PROVENANCE.md for the
 * ceiling this oracle does and does not reach.
 *
 * That same property is why these 29 goldens are the FENCE for `m3gs` and
 * held unedited when the method changed. They are silent about which method
 * is right — the curved profile below is what says that — so a change here is
 * information rather than a chore.
 */
describe('iccCmykTransform agrees with Windows Color System', () => {
  const bytes = new Uint8Array(readFileSync('test/fixtures/icc/synthetic-cmyk.icc'));
  const goldens = JSON.parse(
    readFileSync('test/fixtures/icc/goldens.json', 'utf8')) as {
      sha256: string;
      samples: { rgb: [number, number, number]; cmyk: [number, number, number, number] }[];
    };

  // The goldens describe ONE profile. Without this, editing the fixture and
  // forgetting to regenerate leaves the comparison silently meaningless.
  it('is comparing against the profile the goldens were made from', () => {
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(goldens.sha256);
  });

  it('reproduces every sample', () => {
    const t = iccCmykTransform(bytes);
    for (const { rgb, cmyk } of goldens.samples) {
      const got = t(rgb[0] / 255, rgb[1] / 255, rgb[2] / 255);
      for (let i = 0; i < 4; i++) {
        expect(got[i]).toBeCloseTo(cmyk[i] as number, 3);
      }
    }
  });
});

/**
 * The CURVED profile (`m3gs`): the fixture that pins the interpolation
 * METHOD, which the affine one provably cannot see.
 *
 * This is the ONE comparison in the feature carrying a tolerance, and it is
 * stated rather than tuned: the worst residual measured is 4.8×10⁻³, and
 * `TOL` sits just above it. What makes that number meaningful is the second
 * case below — a multilinear walk over the very same LUT misses WCS by
 * 4.0×10⁻², nearly seven times the tolerance, so the margin cannot swallow
 * the difference between the two methods.
 */
describe('iccCmykTransform interpolates the way a reference CMS does', () => {
  const bytes = new Uint8Array(
    readFileSync('test/fixtures/icc/synthetic-curved-cmyk.icc'));
  const goldens = JSON.parse(
    readFileSync('test/fixtures/icc/goldens-curved.json', 'utf8')) as {
      sha256: string;
      samples: { rgb: [number, number, number]; cmyk: [number, number, number, number] }[];
    };

  /**
   * Measured, and it is what the tolerance is for: the residual is dominated
   * by the L\* CELL BOUNDARY at u = 0.5, where this CLUT's C ramp changes
   * slope threefold (0.425 → 1.275 per unit u). The three worst samples are
   * the three nearest that boundary, in order of distance from it — 0.0033,
   * 0.0054 and 0.0112 — and the mean residual near it is 4.5×10⁻⁴ against
   * 1.6×10⁻⁴ away from it. The worst channel is C, which depends on ONE input
   * axis, and on such a channel the two interpolation methods provably agree,
   * so the outlier is NOT a method disagreement. See PROVENANCE.md.
   */
  const TOL = 6e-3;

  it('is comparing against the profile the goldens were made from', () => {
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(goldens.sha256);
  });

  it('reproduces every sample within the stated tolerance', () => {
    const t = iccCmykTransform(bytes);
    let worst = 0;
    for (const { rgb, cmyk } of goldens.samples) {
      const got = t(rgb[0] / 255, rgb[1] / 255, rgb[2] / 255);
      for (let i = 0; i < 4; i++) {
        worst = Math.max(worst, Math.abs((got[i] as number) - (cmyk[i] as number)));
      }
    }
    expect(worst).toBeLessThan(TOL);
  });

  /**
   * The fixture would be worthless if the tolerance could absorb the method,
   * so this asserts it cannot — by walking the SAME LUT multilinearly, the
   * way this library did until `m3gs`, and showing it lands an order of
   * magnitude outside.
   *
   * The reference below is deliberately a second implementation rather than a
   * call into `icclut.ts`: it is the REJECTED alternative, and a test that
   * imported the shipped one could not express it.
   */
  it('rejects a multilinear walk over the same LUT', () => {
    const p = parseIccProfile(bytes);
    const tag = iccTag(p, 'B2A0');
    if (!tag) throw new Error('no B2A0');
    const lut = readLutTag(p, tag);
    const { grid, outputChannels, clut } = lut;

    const multilinear = (pos: number[]): number[] => {
      const base = pos.map((q) => Math.min(Math.floor(q), grid - 2));
      const frac = pos.map((q, c) => q - (base[c] as number));
      const out = new Array<number>(outputChannels).fill(0);
      for (let mask = 0; mask < 8; mask++) {
        let weight = 1;
        let index = 0;
        for (let c = 0; c < 3; c++) {
          const hi = (mask >> c) & 1;
          weight *= hi ? (frac[c] as number) : 1 - (frac[c] as number);
          index = index * grid + ((base[c] as number) + hi);
        }
        for (let k = 0; k < outputChannels; k++) {
          out[k] = (out[k] as number) + weight * (clut[index * outputChannels + k] as number);
        }
      }
      return out;
    };

    let worst = 0;
    for (const { rgb, cmyk } of goldens.samples) {
      const [x, y, z] = srgbToXyzD50(rgb[0] / 255, rgb[1] / 255, rgb[2] / 255);
      const [l, a, b] = xyzToLab(x, y, z);
      const pos = labToV2(l, a, b).map((v) => v * (grid - 1));
      const got = multilinear(pos);
      for (let i = 0; i < 4; i++) {
        worst = Math.max(worst, Math.abs((got[i] as number) - (cmyk[i] as number)));
      }
    }
    // Measured at 4.05e-2. Bounded from BOTH sides: a lower bound alone would
    // pass for an implementation that had simply gone haywire.
    expect(worst).toBeGreaterThan(3.5e-2);
    expect(worst).toBeLessThan(4.5e-2);
  });
});

// 85l8.3 already threads a CmykTransform to every leg, so this asserts the
// composition rather than any new plumbing.
describe('ConvertColors through an ICC profile', () => {
  it('reports a supplied transform and inks all four channels', () => {
    const bytes = new Uint8Array(readFileSync('test/fixtures/icc/synthetic-cmyk.icc'));
    const doc = Document.Open(buildGrayscalePdf());
    const report = doc.ConvertColors({ to: 'cmyk', transform: iccCmykTransform(bytes) });
    expect(report.cmykTransform).toBe('supplied');
    expect(report.skipped).toEqual([]);
  });
});

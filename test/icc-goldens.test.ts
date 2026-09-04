import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { iccCmykTransform } from '../src/icctransform.js';
import { Document } from '../src/document.js';
import { buildGrayscalePdf } from './helpers/build-grayscale-pdf.js';

/**
 * Our transform against Windows Color System's, through the same profile.
 *
 * The comparison is EXACT to 3 decimal places rather than tolerant, and that
 * is what the fixture's affine CLUT buys: trilinear and tetrahedral
 * interpolation agree exactly on an affine function, so there is no
 * interpolation-method slack for a bug to hide in. See PROVENANCE.md for the
 * ceiling this oracle does and does not reach.
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

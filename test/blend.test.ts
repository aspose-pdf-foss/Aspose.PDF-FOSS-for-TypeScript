import { describe, it, expect } from 'vitest';
import { blendPixel, blendModeFromName, Rgb01 } from '../src/blend.js';

const close = (got: Rgb01, want: Rgb01, tol = 1e-6) => {
  for (let i = 0; i < 3; i++) expect(Math.abs(got[i] - want[i])).toBeLessThanOrEqual(tol);
};

describe('blendPixel — separable modes', () => {
  const cb: Rgb01 = [0.5, 0.5, 0.5];
  const cs: Rgb01 = [1, 0, 0];

  it('Multiply, Screen, Darken, Lighten, Difference, Exclusion', () => {
    close(blendPixel('Multiply', cb, cs), [0.5, 0, 0]);
    close(blendPixel('Screen', cb, cs), [1, 0.5, 0.5]);
    close(blendPixel('Darken', cb, cs), [0.5, 0, 0]);
    close(blendPixel('Lighten', cb, cs), [1, 0.5, 0.5]);
    close(blendPixel('Difference', cb, cs), [0.5, 0.5, 0.5]);
    close(blendPixel('Exclusion', cb, cs), [0.5, 0.5, 0.5]);
  });

  it('Overlay is HardLight with the operands swapped', () => {
    close(blendPixel('Overlay', cb, cs), blendPixel('HardLight', cs, cb));
  });

  it('ColorDodge and ColorBurn saturate at the endpoints', () => {
    close(blendPixel('ColorDodge', [0, 0, 0], [0.5, 0.5, 0.5]), [0, 0, 0]);
    close(blendPixel('ColorDodge', [0.5, 0.5, 0.5], [1, 1, 1]), [1, 1, 1]);
    close(blendPixel('ColorBurn', [1, 1, 1], [0.5, 0.5, 0.5]), [1, 1, 1]);
    close(blendPixel('ColorBurn', [0.5, 0.5, 0.5], [0, 0, 0]), [0, 0, 0]);
  });
});

describe('blendPixel — non-separable modes', () => {
  it('Luminosity clips only when the color leaves the gamut', () => {
    // cb lum = 0.362; shifting to cs lum 0.9 gives (0.738, 0.938, 1.138), whose
    // min is 0.738 — above 0, so ClipColor's first branch must NOT fire. Only
    // the max (1.138 > 1) is clipped, about L = 0.9.
    // Guards against testing `n < L` (nearly always true) instead of `n < 0`:
    // that would drive the red channel to 0 rather than 0.8319.
    close(blendPixel('Luminosity', [0.2, 0.4, 0.6], [0.9, 0.9, 0.9]),
      [0.8319327731, 0.9159663866, 1]);
  });

  it('Color takes the source hue at the backdrop luminosity', () => {
    // Pure red lifted to luminosity 0.5, then clipped back into gamut.
    const out = blendPixel('Color', [0.5, 0.5, 0.5], [1, 0, 0]);
    expect(Math.abs(0.3 * out[0] + 0.59 * out[1] + 0.11 * out[2] - 0.5)).toBeLessThanOrEqual(1e-6);
    expect(out[1]).toBeCloseTo(out[2], 9);   // red hue keeps G == B
    expect(out[0]).toBeGreaterThan(out[1]);
  });

  it('a fully desaturated operand does not divide by zero', () => {
    for (const m of ['Hue', 'Saturation', 'Color', 'Luminosity'] as const) {
      const out = blendPixel(m, [0.5, 0.5, 0.5], [0.5, 0.5, 0.5]);
      for (const v of out) expect(Number.isFinite(v)).toBe(true);
    }
  });
});

describe('blendModeFromName', () => {
  it('maps /Compatible to Normal and rejects unknown names', () => {
    expect(blendModeFromName('Compatible')).toBe('Normal');
    expect(blendModeFromName('Multiply')).toBe('Multiply');
    expect(blendModeFromName('NotAMode')).toBe('Normal');
  });
});

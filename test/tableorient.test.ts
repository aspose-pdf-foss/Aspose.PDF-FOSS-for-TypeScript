import { describe, it, expect } from 'vitest';
import { apply } from '../src/text.js';
import { dominantAngle, rot, ANGLE_EPS, type Seg } from '../src/tableorient.js';

describe('dominantAngle', () => {
  it('uses the modal glyph baseline angle when text is present', () => {
    const a = (30 * Math.PI) / 180;
    expect(dominantAngle([], [a, a, a, 0])).toBeCloseTo(a, 2);
  });

  it('resolves a 90° table from text even when rules look axis-aligned', () => {
    const axisSegs: Seg[] = [
      { x0: 0, y0: 0, x1: 10, y1: 0 }, { x0: 0, y0: 0, x1: 0, y1: 10 },
    ];
    const a = Math.PI / 2;
    expect(dominantAngle(axisSegs, [a, a, a])).toBeCloseTo(a, 2);
  });

  it('falls back to rule direction (mod 90°) when there is no text', () => {
    const t = (5 * Math.PI) / 180, c = Math.cos(t), s = Math.sin(t);
    const segs: Seg[] = [
      { x0: 0, y0: 0, x1: 10 * c, y1: 10 * s },     // ~5°
      { x0: 0, y0: 0, x1: -10 * s, y1: 10 * c },    // ~95° → 5° mod 90
    ];
    expect(dominantAngle(segs, [])).toBeCloseTo(t, 2);
  });

  it('returns 0 for empty input', () => {
    expect(dominantAngle([], [])).toBe(0);
    expect(Math.abs(dominantAngle([], [0.001]))).toBeLessThan(ANGLE_EPS);
  });
});

describe('rot', () => {
  it('rotates the unit x-vector by the angle', () => {
    const [x, y] = apply(rot(Math.PI / 2), 1, 0);
    expect(x).toBeCloseTo(0, 6);
    expect(y).toBeCloseTo(1, 6);
  });
});

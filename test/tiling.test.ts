import { describe, it, expect } from 'vitest';
import { patternMatrix, resolveTiling, tilingPatternDict } from '../src/tiling.js';
import { isName, type PdfDict } from '../src/types.js';

describe('patternMatrix', () => {
  it('is the identity with no placement', () => {
    // What makes the option provably free for a caller who ignores it.
    expect(patternMatrix(0, 0, 0)).toEqual([1, 0, 0, 1, 0, 0]);
  });

  it('carries x alone', () => {
    expect(patternMatrix(7, 0, 0)).toEqual([1, 0, 0, 1, 7, 0]);
  });

  it('carries y alone', () => {
    // One vector at a time: a single combined case cannot tell an x/y
    // transposition from a correct build, the same trap CLAUDE.md records for
    // the JBIG2 halftone grid's cross terms.
    expect(patternMatrix(0, 7, 0)).toEqual([1, 0, 0, 1, 0, 7]);
  });

  it('carries rotation alone, counter-clockwise in degrees', () => {
    const m = patternMatrix(0, 0, 90);
    // 90 deg CCW takes +x to +y: [a b c d] = [0 1 -1 0].
    expect(m[0]).toBeCloseTo(0, 12);
    expect(m[1]).toBeCloseTo(1, 12);
    expect(m[2]).toBeCloseTo(-1, 12);
    expect(m[3]).toBeCloseTo(0, 12);
    expect(m[4]).toBeCloseTo(0, 12);
    expect(m[5]).toBeCloseTo(0, 12);
  });

  it('rotates about the origin and THEN translates', () => {
    // The composition order is the thing that reads as plausible when wrong:
    // translate-then-rotate spins the offset too, putting the lattice
    // somewhere entirely different while still looking like a rotated hatch.
    const m = patternMatrix(10, 0, 90);
    expect(m[4]).toBeCloseTo(10, 12);
    expect(m[5]).toBeCloseTo(0, 12);
  });
});

describe('resolveTiling', () => {
  it('defaults each step to the tile size', () => {
    const r = resolveTiling(20, 30, {});
    expect(r.xStep).toBe(20);
    expect(r.yStep).toBe(30);
    expect(r.matrix).toEqual([1, 0, 0, 1, 0, 0]);
    expect(r.uncolored).toBe(false);
  });

  it('takes an explicit step that differs from the tile size', () => {
    // Larger than the tile leaves gaps; smaller makes cells overlap.
    const r = resolveTiling(20, 20, { xStep: 30, yStep: 10 });
    expect(r.xStep).toBe(30);
    expect(r.yStep).toBe(10);
  });

  it('rejects a non-positive size, and accepts the adjacent legal value', () => {
    expect(() => resolveTiling(0, 10, {})).toThrow(TypeError);
    expect(() => resolveTiling(-1, 10, {})).toThrow(TypeError);
    expect(() => resolveTiling(10, 0, {})).toThrow(TypeError);
    expect(() => resolveTiling(Number.NaN, 10, {})).toThrow(TypeError);
    expect(() => resolveTiling(0.5, 0.5, {})).not.toThrow();
  });

  it('rejects a non-positive step, and accepts the adjacent legal value', () => {
    expect(() => resolveTiling(10, 10, { xStep: 0 })).toThrow(TypeError);
    expect(() => resolveTiling(10, 10, { yStep: -5 })).toThrow(TypeError);
    expect(() => resolveTiling(10, 10, { xStep: 0.5, yStep: 0.5 })).not.toThrow();
  });

  it('rejects a non-finite placement', () => {
    expect(() => resolveTiling(10, 10, { x: Number.POSITIVE_INFINITY })).toThrow(TypeError);
    expect(() => resolveTiling(10, 10, { rotation: Number.NaN })).toThrow(TypeError);
  });
});

describe('tilingPatternDict', () => {
  const res: PdfDict = new Map();

  it('builds a colored tile', () => {
    const d = tilingPatternDict(resolveTiling(20, 30, {}), res);
    const t = d.get('Type');
    expect(isName(t) && t.name).toBe('Pattern');
    expect(d.get('PatternType')).toBe(1);
    expect(d.get('PaintType')).toBe(1);
    expect(d.get('TilingType')).toBe(1);
    expect(d.get('BBox')).toEqual([0, 0, 20, 30]);
    expect(d.get('XStep')).toBe(20);
    expect(d.get('YStep')).toBe(30);
    expect(d.get('Matrix')).toEqual([1, 0, 0, 1, 0, 0]);
  });

  it('marks an uncolored tile PaintType 2', () => {
    const d = tilingPatternDict(resolveTiling(20, 20, { uncolored: true }), res);
    expect(d.get('PaintType')).toBe(2);
  });

  it('always carries a /Resources, even an empty one', () => {
    // /Resources is required in a tiling pattern stream dict, not optional.
    const d = tilingPatternDict(resolveTiling(10, 10, {}), new Map());
    expect(d.has('Resources')).toBe(true);
  });
});

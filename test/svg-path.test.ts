import { describe, it, expect } from 'vitest';
import {
  parsePath, rectSegs, ellipseSegs, polySegs, parsePoints, segsBBox, type SvgSeg,
} from '../src/svgpath.js';

/** Evaluate one coordinate of a cubic Bezier at t. */
const bez = (p0: number, p1: number, p2: number, p3: number, t: number): number => {
  const u = 1 - t;
  return u * u * u * p0 + 3 * u * u * t * p1 + 3 * u * t * t * p2 + t * t * t * p3;
};

const ops = (segs: SvgSeg[]) => segs.map((s) => s.op).join('');

describe('parsePath — commands', () => {
  it('parses absolute moveto and lineto', () => {
    const { segs, truncated } = parsePath('M 10 20 L 30 40');
    expect(truncated).toBe(false);
    expect(segs).toEqual([
      { op: 'M', args: [10, 20] },
      { op: 'L', args: [30, 40] },
    ]);
  });

  it('treats relative commands as offsets from the current point', () => {
    const { segs } = parsePath('m 10 10 l 5 5 l 5 5');
    expect(segs).toEqual([
      { op: 'M', args: [10, 10] },
      { op: 'L', args: [15, 15] },
      { op: 'L', args: [20, 20] },
    ]);
  });

  it('repeats the previous command for extra argument groups', () => {
    const { segs } = parsePath('M0 0 L1 1 2 2 3 3');
    expect(ops(segs)).toBe('MLLL');
    expect(segs[3].args).toEqual([3, 3]);
  });

  it('promotes a repeated moveto to a lineto', () => {
    const { segs } = parsePath('M0 0 1 1 2 2');
    expect(ops(segs)).toBe('MLL');
    expect(segs[1].args).toEqual([1, 1]);
  });

  it('expands H and V against the current point', () => {
    const { segs } = parsePath('M10 20 H30 V40 h5 v5');
    expect(segs.slice(1)).toEqual([
      { op: 'L', args: [30, 20] },
      { op: 'L', args: [30, 40] },
      { op: 'L', args: [35, 40] },
      { op: 'L', args: [35, 45] },
    ]);
  });

  it('closes a subpath and returns the pen to its start', () => {
    const { segs } = parsePath('M10 10 L20 20 Z L30 30');
    expect(ops(segs)).toBe('MLZL');
    expect(segs[3].args).toEqual([30, 30]);
  });

  it('accepts exponent notation and omitted separators', () => {
    const { segs } = parsePath('M1e2 2E1L-.5.5');
    expect(segs[0].args).toEqual([100, 20]);
    expect(segs[1].args).toEqual([-0.5, 0.5]);
  });

  it('reflects the previous control point for S', () => {
    const { segs } = parsePath('M0 0 C1 1 2 2 3 3 S5 5 6 6');
    // Reflection of (2,2) about (3,3) is (4,4).
    expect(segs[2].args).toEqual([4, 4, 5, 5, 6, 6]);
  });

  it('uses the current point as the S control when no cubic preceded', () => {
    const { segs } = parsePath('M1 1 S5 5 6 6');
    expect(segs[1].args).toEqual([1, 1, 5, 5, 6, 6]);
  });

  it('converts a quadratic to its exact cubic equivalent', () => {
    const { segs } = parsePath('M0 0 Q3 3 6 0');
    // c1 = p0 + 2/3 (q - p0) = (2,2) ; c2 = p1 + 2/3 (q - p1) = (4,2)
    expect(segs[1].args).toEqual([2, 2, 4, 2, 6, 0]);
  });

  it('reflects the previous quadratic control point for T', () => {
    const { segs } = parsePath('M0 0 Q3 3 6 0 T12 0');
    // Reflected q = (9,-3); c1 = (6,0)+2/3((9,-3)-(6,0)) = (8,-2)
    expect(segs[2].args).toEqual([8, -2, 10, -2, 12, 0]);
  });
});

describe('parsePath — arcs', () => {
  it('converts a quarter arc to a cubic that lies on the circle', () => {
    // fa=0, fs=1 puts the centre at the origin (radius 100).
    const { segs } = parsePath('M100 0 A100 100 0 0 1 0 100');
    expect(ops(segs)).toBe('MC');
    const a = segs[1].args;
    expect(a.slice(4)).toEqual([0, 100]);              // exact endpoint
    // Independent check: sample the cubic and assert it is on x^2+y^2=100^2.
    // NOT compared against our own converter.
    for (const t of [0.25, 0.5, 0.75]) {
      const x = bez(100, a[0], a[2], a[4], t);
      const y = bez(0, a[1], a[3], a[5], t);
      expect(Math.hypot(x, y)).toBeCloseTo(100, 1);
    }
  });

  it('splits an arc larger than 90 degrees into several cubics', () => {
    const { segs } = parsePath('M100 0 A100 100 0 1 1 -100 0');   // 180 degrees
    expect(segs.filter((s) => s.op === 'C').length).toBeGreaterThan(1);
    const last = segs[segs.length - 1].args;
    expect(last.slice(4)).toEqual([-100, 0]);
  });

  it('honours all four large-arc / sweep combinations', () => {
    const ends = ['0 0', '0 1', '1 0', '1 1'].map((f) => {
      const { segs } = parsePath(`M0 0 A50 50 0 ${f} 50 50`);
      return segs[segs.length - 1].args.slice(4);
    });
    for (const e of ends) expect(e).toEqual([50, 50]);   // all reach the endpoint
    // Small and large arcs bow to opposite sides, so their midpoints differ.
    const mid = (f: string) => {
      const { segs } = parsePath(`M0 0 A50 50 0 ${f} 50 50`);
      const a = segs[1].args;
      return bez(0, a[0], a[2], a[4], 0.5);
    };
    expect(mid('0 0')).not.toBeCloseTo(mid('1 0'), 3);
  });

  it('reads unseparated arc flags', () => {
    // "a1 1 0 011 1" packs largeArc=0, sweep=1, x=1, y=1 with no separators.
    // A number reader would swallow "011" as one token and lose the arc.
    const { segs, truncated } = parsePath('M0 0a1 1 0 011 1');
    expect(truncated).toBe(false);
    expect(segs[segs.length - 1].args.slice(4)).toEqual([1, 1]);
  });

  it('degrades a zero-radius arc to a line', () => {
    const { segs } = parsePath('M0 0 A0 50 0 0 1 100 0');
    expect(segs).toEqual([
      { op: 'M', args: [0, 0] },
      { op: 'L', args: [100, 0] },
    ]);
  });

  it('scales up radii too small to span the endpoints', () => {
    const { segs } = parsePath('M0 0 A1 1 0 0 1 100 0');
    expect(segs[segs.length - 1].args.slice(4)).toEqual([100, 0]);
  });
});

describe('parsePath — malformed input', () => {
  it('renders the valid prefix and reports truncation', () => {
    const { segs, truncated } = parsePath('M10 10 L20 20 L30');
    expect(ops(segs)).toBe('ML');
    expect(truncated).toBe(true);
  });

  it('stops at an unknown command', () => {
    const { segs, truncated } = parsePath('M0 0 L1 1 X9 9');
    expect(ops(segs)).toBe('ML');
    expect(truncated).toBe(true);
  });

  it('returns nothing for empty or leading-garbage data', () => {
    expect(parsePath('')).toEqual({ segs: [], truncated: false });
    expect(parsePath('   ').segs).toEqual([]);
    expect(parsePath('5 5 L1 1').truncated).toBe(true);
  });
});

describe('shape segment builders', () => {
  it('builds a sharp rect as four lines and a close', () => {
    const segs = rectSegs(10, 20, 30, 40, 0, 0);
    expect(segs.map((s) => s.op).join('')).toBe('MLLLZ');
    expect(segs[0].args).toEqual([10, 20]);
    expect(segs[1].args).toEqual([40, 20]);
    expect(segs[2].args).toEqual([40, 60]);
    expect(segs[3].args).toEqual([10, 60]);
  });

  it('builds a rounded rect with four corner curves', () => {
    const segs = rectSegs(0, 0, 100, 50, 10, 10);
    expect(segs.filter((s) => s.op === 'C').length).toBe(4);
    expect(segs[segs.length - 1].op).toBe('Z');
    // The first point is the start of the top edge, past the corner radius.
    expect(segs[0].args).toEqual([10, 0]);
  });

  it('clamps corner radii to half the side', () => {
    const segs = rectSegs(0, 0, 20, 10, 50, 50);   // rx -> 10, ry -> 5
    expect(segs[0].args).toEqual([10, 0]);
  });

  it('defaults a missing ry to rx and vice versa', () => {
    expect(rectSegs(0, 0, 100, 50, 10, NaN)).toEqual(rectSegs(0, 0, 100, 50, 10, 10));
    expect(rectSegs(0, 0, 100, 50, NaN, 10)).toEqual(rectSegs(0, 0, 100, 50, 10, 10));
  });

  it('builds an ellipse from four cubics whose endpoints are the axis extremes', () => {
    const segs = ellipseSegs(0, 0, 100, 50);
    expect(segs.filter((s) => s.op === 'C').length).toBe(4);
    const ends = segs.filter((s) => s.op === 'C').map((s) => s.args.slice(4));
    expect(ends).toContainEqual([0, 50]);
    expect(ends).toContainEqual([-100, 0]);
    expect(ends).toContainEqual([0, -50]);
    expect(ends).toContainEqual([100, 0]);
  });

  it('builds an open polyline and a closed polygon', () => {
    expect(polySegs([0, 0, 10, 0, 10, 10], false).map((s) => s.op).join('')).toBe('MLL');
    expect(polySegs([0, 0, 10, 0, 10, 10], true).map((s) => s.op).join('')).toBe('MLLZ');
  });

  it('returns nothing for fewer than two points', () => {
    expect(polySegs([5], false)).toEqual([]);
    expect(polySegs([], true)).toEqual([]);
  });

  it('returns nothing for a degenerate rect or ellipse', () => {
    expect(rectSegs(0, 0, 0, 10, 0, 0)).toEqual([]);
    expect(ellipseSegs(0, 0, 0, 10)).toEqual([]);
  });

  it('parses point lists with commas, spaces or neither', () => {
    expect(parsePoints('0,0 10,0 10,10')).toEqual([0, 0, 10, 0, 10, 10]);
    expect(parsePoints('0 0 10 0')).toEqual([0, 0, 10, 0]);
    expect(parsePoints('1-2 3-4')).toEqual([1, -2, 3, -4]);
    expect(parsePoints('  ')).toEqual([]);
  });

  it('drops a trailing odd coordinate', () => {
    expect(parsePoints('0 0 10 0 5')).toEqual([0, 0, 10, 0]);
  });
});

describe('segsBBox', () => {
  it('returns null for no segments', () => {
    expect(segsBBox([])).toBeNull();
  });

  it('bounds a polyline by its points', () => {
    const segs: SvgSeg[] = [
      { op: 'M', args: [10, 20] },
      { op: 'L', args: [30, 5] },
      { op: 'L', args: [15, 40] },
      { op: 'Z', args: [] },
    ];
    expect(segsBBox(segs)).toEqual({ x: 10, y: 5, w: 20, h: 35 });
  });

  it('matches the analytic box of a circle', () => {
    // Independent formula: a circle of radius r at (cx, cy) is bounded by
    // [cx-r, cy-r, 2r, 2r]. Asserted against arithmetic, not against our own
    // arc converter, per the CLAUDE.md rule on differential tests.
    const b = segsBBox(ellipseSegs(10, 20, 5, 5))!;
    expect(b.x).toBeCloseTo(5, 9);
    expect(b.y).toBeCloseTo(15, 9);
    expect(b.w).toBeCloseTo(10, 9);
    expect(b.h).toBeCloseTo(10, 9);
  });

  it('uses the cubic extremum, not the control-point hull', () => {
    // B(0.5) in y = 7.5 for control values 0,10,10,0. A hull bbox would say 10.
    // This is the case that fails a hull implementation; the circle above does
    // NOT (its control points' per-axis extremes are exactly +/- r).
    const segs: SvgSeg[] = [
      { op: 'M', args: [0, 0] },
      { op: 'C', args: [0, 10, 10, 10, 10, 0] },
    ];
    const b = segsBBox(segs)!;
    expect(b.y).toBeCloseTo(0, 9);
    expect(b.h).toBeCloseTo(7.5, 9);
    expect(b.x).toBeCloseTo(0, 9);
    expect(b.w).toBeCloseTo(10, 9);
  });

  it('finds an extremum that lies outside the endpoint span on both axes', () => {
    // x control values 0,-6,16,10 -> the curve overshoots both ends.
    const segs: SvgSeg[] = [
      { op: 'M', args: [0, 0] },
      { op: 'C', args: [-6, 0, 16, 0, 10, 0] },
    ];
    const b = segsBBox(segs)!;
    expect(b.x).toBeLessThan(0);
    expect(b.x + b.w).toBeGreaterThan(10);
  });

  it('gives a zero-area box for a single point', () => {
    expect(segsBBox([{ op: 'M', args: [7, 8] }])).toEqual({ x: 7, y: 8, w: 0, h: 0 });
  });
});

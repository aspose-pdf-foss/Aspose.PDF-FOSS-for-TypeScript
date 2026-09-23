import { describe, expect, test } from 'vitest';
import { cloudPath, type CloudSegment } from '../src/cloudborder.js';

/** Evaluate a cubic Bézier at `t`. */
function bezier(
  x0: number, y0: number, s: CloudSegment, t: number,
): [number, number] {
  const u = 1 - t;
  const a = u * u * u, b = 3 * u * u * t, c = 3 * u * t * t, d = t * t * t;
  return [
    a * x0 + b * s.c1x + c * s.c2x + d * s.x,
    a * y0 + b * s.c1y + c * s.c2y + d * s.y,
  ];
}

/** The start point of segment `i` — the previous segment's end, or the path's. */
function startOf(path: { x: number; y: number; segments: CloudSegment[] }, i: number): [number, number] {
  return i === 0 ? [path.x, path.y] : [path.segments[i - 1].x, path.segments[i - 1].y];
}

/** A 100x60 rectangle, counter-clockwise (positive signed area). */
const CCW_RECT = [0, 0, 100, 0, 100, 60, 0, 60];

describe('cloudPath', () => {
  test('gives one scallop per 2h of edge length', () => {
    // A 100pt edge at h=5 wants 100/10 = 10 scallops; the 60pt edges want 6.
    const path = cloudPath(CCW_RECT, 5);
    expect(path.segments).toHaveLength(10 + 6 + 10 + 6);
  });

  test('rounds the scallop count to the nearest, not down', () => {
    // At h=9 the 100pt edges want 5.56 scallops and the 60pt ones 3.33. A
    // fixture whose edges divide exactly cannot tell rounding from flooring —
    // the case above is one, measured.
    expect(cloudPath(CCW_RECT, 9).segments).toHaveLength(6 + 3 + 6 + 3);
  });

  test('bulges each scallop exactly h outward at its midpoint', () => {
    const path = cloudPath(CCW_RECT, 5);
    // Segment 0 runs along the bottom edge (0,0)→(100,0) of a CCW rectangle,
    // so outward is -y. A 10pt-wide scallop peaks at x=5, y=-5.
    const [x, y] = bezier(path.x, path.y, path.segments[0], 0.5);
    expect(x).toBeCloseTo(5, 9);
    expect(y).toBeCloseTo(-5, 9);
  });

  test('bulges outward for a clockwise ring too, not inward', () => {
    // The same rectangle wound the other way. /Vertices may wind either way,
    // and an inward bulge renders perfectly well as the wrong picture.
    const cw = [0, 0, 0, 60, 100, 60, 100, 0];
    const path = cloudPath(cw, 5);
    // Segment 0 runs up the left edge (0,0)→(0,60), so outward is -x.
    const [x, y] = bezier(path.x, path.y, path.segments[0], 0.5);
    expect(x).toBeCloseTo(-5, 9);
    expect(y).toBeCloseTo(5, 9);
  });

  test('clamps an edge shorter than one scallop to a semicircle, not a spike', () => {
    // 4pt-tall box at h=5: the short edges take one scallop each, whose bulge
    // must shrink to half the edge (2) or it is taller than it is wide.
    const path = cloudPath([0, 0, 100, 0, 100, 4, 0, 4], 5);
    // Segment 10 is the first (and only) scallop of the right edge, outward +x.
    const [x, y] = bezier(...startOf(path, 10), path.segments[10], 0.5);
    expect(x).toBeCloseTo(102, 9);
    expect(y).toBeCloseTo(2, 9);
  });

  test('drops a zero-length edge rather than emitting NaN', () => {
    // A repeated vertex is a real shape in a /Vertices array. Its unit
    // direction is 0/0, and a NaN reaching a content stream is a corrupt
    // file rather than a wrong picture.
    const path = cloudPath([0, 0, 100, 0, 100, 0, 100, 60, 0, 60], 5);
    const all = path.segments.flatMap((s) => [s.c1x, s.c1y, s.c2x, s.c2y, s.x, s.y]);
    expect(all.every(Number.isFinite)).toBe(true);
  });

  test('closes the ring: the last segment ends where the path started', () => {
    const path = cloudPath(CCW_RECT, 5);
    const last = path.segments[path.segments.length - 1];
    expect(last.x).toBeCloseTo(path.x, 9);
    expect(last.y).toBeCloseTo(path.y, 9);
  });
});

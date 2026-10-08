// test/boxpaint-radius.test.ts
import { describe, it, expect } from 'vitest';
import {
  resolveRadii, hasRadius, sliceRadii, innerRadii, roundedRect, pathOps, edgeWedges, ZERO_RADII, type CornerSpec,
  type Radii, type Widths,
} from '../src/boxpaint.js';

const pt = (abs: number, frac = 0) => ({ abs, frac });
const all = (x: number, y = x): CornerSpec[] => Array.from({ length: 4 }, () => ({ x: pt(x), y: pt(y) }));

describe('resolveRadii', () => {
  it('resolves percentages against width (rx) and height (ry)', () => {
    const r = resolveRadii(Array.from({ length: 4 }, () => ({ x: pt(0, 0.5), y: pt(0, 0.5) })), 200, 100);
    expect(r[0]).toEqual({ rx: 100, ry: 50 });                       // 50% is an ellipse on a non-square box
  });
  it('scales EVERY radius by the smallest side factor when adjacent radii overlap', () => {
    const r = resolveRadii(all(9999), 100, 20);                      // a pill
    expect(r[0].rx).toBeCloseTo(10, 9); expect(r[0].ry).toBeCloseTo(10, 9);
    expect(r[1].rx).toBeCloseTo(10, 9);
  });
  it('leaves radii that fit alone', () => {
    expect(resolveRadii(all(10, 5), 100, 50)[2]).toEqual({ rx: 10, ry: 5 });
  });
  it('a spec that is not four corners is square (an absent radius)', () => {
    expect(resolveRadii([], 50, 50)).toEqual(ZERO_RADII);
  });
  it('a corner with a zero component is square', () => {
    expect(hasRadius(resolveRadii([{ x: pt(10), y: pt(0) }, ...all(0).slice(1)], 50, 50))).toBe(false);
  });
});

describe('slices and inner radii', () => {
  it('a first slice keeps only its top corners, a last only its bottom', () => {
    const r = resolveRadii(all(8), 100, 100);
    expect(sliceRadii(r, true, false).map((c) => c.rx)).toEqual([8, 8, 0, 0]);
    expect(sliceRadii(r, false, true).map((c) => c.rx)).toEqual([0, 0, 8, 8]);
    expect(sliceRadii(r, false, false)).toEqual(ZERO_RADII);
  });
  it('inner radii subtract the adjoining border widths, floored at 0', () => {
    const r = resolveRadii(all(10), 100, 100);
    const i = innerRadii(r, { top: 4, right: 12, bottom: 0, left: 2 });
    expect(i[0]).toEqual({ rx: 8, ry: 6 });                           // tl: left 2, top 4
    expect(i[1]).toEqual({ rx: 0, ry: 0 });                           // tr: right 12 floors rx, so the corner is square
  });
  it('given the box size, inner radii are scaled to fit the INNER box, as a rounded rect is (v9j3.4 Fixed)', () => {
    // A 44 x 197 box, left border 15, right 2: the BR outer radius 44 less 2
    // is 42 — wider than the 27pt inner box, a self-intersecting inner path.
    const r = resolveRadii([0, 0, 44, 0].map((v) => ({ x: { abs: v, frac: 0 }, y: { abs: v, frac: 0 } })), 44, 197);
    const b = { top: 3, right: 2, bottom: 6, left: 15 };
    const i = innerRadii(r, b, 44, 197);
    const iw = 44 - 15 - 2;
    expect(i[2].rx).toBeCloseTo(iw, 9);                               // scaled down to the inner width
    expect(i[2].ry / i[2].rx).toBeCloseTo((44 - 6) / (44 - 2), 9);    // aspect kept: both components scale
    expect(innerRadii(r, b)[2].rx).toBe(42);                          // without a size: unchanged rule
  });
});

describe('paths', () => {
  it('a square rect is four lines and a close', () => {
    expect(roundedRect(0, 0, 10, 5, ZERO_RADII).map((s) => s[0])).toEqual(['m', 'l', 'l', 'l', 'h']);
  });
  it('a rounded corner is one cubic whose control points sit 0.5523 r in', () => {
    const r = resolveRadii(all(10), 100, 100);
    const segs = roundedRect(0, 0, 100, 100, r);
    expect(segs.filter((s) => s[0] === 'c')).toHaveLength(4);
    // start at top-left after its corner, walk clockwise (top edge first)
    expect(segs[0]).toEqual(['m', 10, 100]);
    const [, a, b, c, d, e, f] = segs.find((s) => s[0] === 'c') as ['c', number, number, number, number, number, number];
    expect(a).toBeCloseTo(90 + 10 * 0.5522847498, 6); expect(b).toBeCloseTo(100, 6);
    expect(c).toBeCloseTo(100, 6); expect(d).toBeCloseTo(90 + 10 * 0.5522847498, 6);
    expect(e).toBeCloseTo(100, 6); expect(f).toBeCloseTo(90, 6);
  });
  it('pathOps writes m/l/c/h operators with the given number format', () => {
    expect(pathOps([['m', 1, 2], ['l', 3, 4], ['h']], String)).toBe('1 2 m\n3 4 l\nh\n');
  });
});

describe('edge wedges', () => {
  it('each edge is the quad from its two outer corners to the inner ones', () => {
    const w = edgeWedges(0, 0, 100, 50, { top: 4, right: 6, bottom: 2, left: 8 });
    expect(w.top).toEqual([[0, 50], [100, 50], [94, 46], [8, 46]]);
    expect(w.left).toEqual([[0, 0], [0, 50], [8, 46], [8, 2]]);
  });
  it('with inner radii, each join runs from the outer corner to where its diagonal meets the INNER arc (v9j3.4 Fixed)', () => {
    // Rounded, the ring reaches INSIDE the inner rectangle at a corner; a
    // join stopping at the inner rect corner leaves that part in no wedge.
    const r = { rx: 20, ry: 20 };
    const w = edgeWedges(0, 0, 200, 120, { top: 10, right: 10, bottom: 10, left: 10 }, [r, r, r, r]);
    // TL: outer (0,120), inner corner (10,110), diagonal (1,-1); the inner arc
    // is centred (30,90) with radius 20, met at s = 20 - 20/sqrt(2).
    const s = 20 - 20 / Math.SQRT2;
    expect(w.top[3][0]).toBeCloseTo(10 + s, 9);
    expect(w.top[3][1]).toBeCloseTo(110 - s, 9);
    expect(w.left[2]).toEqual(w.top[3]);
    expect(w.top[2][0]).toBeCloseTo(190 - s, 9);
  });
  it('a zero-width side meets the arc at its tangent end', () => {
    const w = edgeWedges(0, 0, 100, 60, { top: 6, right: 0, bottom: 0, left: 0 }, [{ rx: 0, ry: 0 }, { rx: 0, ry: 0 }, { rx: 0, ry: 0 }, { rx: 0, ry: 0 }]);
    expect(w.top[3]).toEqual([0, 54]);
    const v = edgeWedges(0, 0, 100, 60, { top: 6, right: 0, bottom: 0, left: 0 }, [{ rx: 10, ry: 8 }, { rx: 0, ry: 0 }, { rx: 0, ry: 0 }, { rx: 0, ry: 0 }]);
    expect(v.top[3][0]).toBeCloseTo(0, 9);
    expect(v.top[3][1]).toBeCloseTo(54 - 8, 9);
  });
  it('the four wedges cover the whole ring for any widths and radii (coverage fuzz)', () => {
    // A deterministic LCG, so a failure reproduces. Every sampled point of the
    // ring — inside the outer rounded box, outside the inner one — must fall in
    // at least one wedge; the old capped joins left up to 1.1% of it in none.
    let seed = 12345;
    const rnd = (): number => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
    const inRounded = (px: number, py: number, x: number, y: number, w: number, h: number, rr: Radii): boolean => {
      if (px < x || px > x + w || py < y || py > y + h) return false;
      const [tl, tr, br, bl] = rr;
      const corner = (c: { rx: number; ry: number }, cx: number, cy: number, sx: number, sy: number): boolean => {
        if (!(c.rx > 0 && c.ry > 0)) return true;
        const dx = (px - cx) * sx, dy = (py - cy) * sy;
        if (dx <= 0 || dy <= 0) return true;                 // not in this corner's box
        return (dx / c.rx) ** 2 + (dy / c.ry) ** 2 <= 1;
      };
      return corner(tl, x + tl.rx, y + h - tl.ry, -1, 1) && corner(tr, x + w - tr.rx, y + h - tr.ry, 1, 1)
        && corner(br, x + w - br.rx, y + br.ry, 1, -1) && corner(bl, x + bl.rx, y + bl.ry, -1, -1);
    };
    const inPoly = (px: number, py: number, poly: [number, number][]): boolean => {
      let inside = false;
      for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
        const [xi, yi] = poly[i], [xj, yj] = poly[j];
        if ((yi > py) !== (yj > py) && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) inside = !inside;
      }
      return inside;
    };
    let worst = 0;
    const cases: [number, number, Widths, number[]][] = [[150, 50, { top: 15, right: 5, bottom: 15, left: 5 }, [0, 0, 0, 48]]];
    for (let k = 0; k < 300; k++) {
      const w = 20 + rnd() * 200, h = 20 + rnd() * 200;
      const b: Widths = { top: rnd() < 0.2 ? 0 : rnd() * 20, right: rnd() < 0.2 ? 0 : rnd() * 20,
        bottom: rnd() < 0.2 ? 0 : rnd() * 20, left: rnd() < 0.2 ? 0 : rnd() * 20 };
      if (b.left + b.right >= w || b.top + b.bottom >= h) continue;
      cases.push([w, h, b, [0, 1, 2, 3].map(() => (rnd() < 0.15 ? 9999 : rnd() * 80))]);
    }
    for (const [w, h, b, rs] of cases) {
      const outer = resolveRadii(rs.map((v) => ({ x: { abs: v, frac: 0 }, y: { abs: v * (0.5 + rs[0] % 1), frac: 0 } })), w, h);
      const inner = innerRadii(outer, b, w, h);
      const wedges = edgeWedges(0, 0, w, h, b, inner);
      let ring = 0, miss = 0;
      for (let i = 0; i < 4000; i++) {
        const px = rnd() * w, py = rnd() * h;
        if (!inRounded(px, py, 0, 0, w, h, outer)) continue;
        if (inRounded(px, py, b.left, b.bottom, w - b.left - b.right, h - b.top - b.bottom, inner)) continue;
        ring++;
        const owner = (['top', 'right', 'bottom', 'left'] as const).filter((e) => b[e] > 0 && inPoly(px, py, wedges[e]));
        if (owner.length === 0) miss++;
      }
      if (ring > 0) worst = Math.max(worst, miss / ring);
    }
    expect(worst).toBeLessThan(0.002);
  });
  it('no radius leaves the joins at the inner rectangle corners', () => {
    const z = { rx: 0, ry: 0 };
    expect(edgeWedges(0, 0, 100, 50, { top: 4, right: 6, bottom: 2, left: 8 }, [z, z, z, z]).top)
      .toEqual([[0, 50], [100, 50], [94, 46], [8, 46]]);
  });
});

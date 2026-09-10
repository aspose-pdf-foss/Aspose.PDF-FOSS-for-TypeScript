import { describe, it, expect } from 'vitest';
import {
  type Pt, type PatchRecord, type Patch,
  completePatches, coonsInterior, patchGridSize, patchTriangles,
  NET_BOUNDARY, NET_INTERIOR, MAX_GRID,
} from '../src/meshpatch.js';

const pt = (x: number, y: number): Pt => ({ x, y });

/** The 12 boundary points of a UNIT-SQUARE patch with straight, evenly spaced
 *  edges: stream order 1..12 walks p[0][0] → p[0][3] → p[3][3] → p[3][0]. */
function flatBoundary(scale = 3): Pt[] {
  //          j →
  //  p00 p01 p02 p03      stream 1  2  3  4
  //  p10         p13             12        5
  //  p20         p23             11        6
  //  p30 p31 p32 p33             10  9  8  7
  const g = (i: number, j: number) => pt(j * scale, i * scale);
  return [
    g(0, 0), g(0, 1), g(0, 2), g(0, 3),
    g(1, 3), g(2, 3), g(3, 3),
    g(3, 2), g(3, 1), g(3, 0),
    g(2, 0), g(1, 0),
  ];
}

const RGB = [[1, 0, 0], [0, 1, 0], [0, 0, 1], [1, 1, 0]];

describe('meshpatch — the stream-order to tensor-net mapping', () => {
  // The 12 boundary points must walk the 4x4 net's border exactly once. Stated
  // wrongly, a patch still renders — as a different surface.
  it('walks the net border once, corners at stream points 1, 4, 7 and 10', () => {
    expect(NET_BOUNDARY).toHaveLength(12);
    expect(new Set(NET_BOUNDARY).size).toBe(12);
    expect([NET_BOUNDARY[0], NET_BOUNDARY[3], NET_BOUNDARY[6], NET_BOUNDARY[9]])
      .toEqual([0, 3, 15, 12]);                     // p00, p03, p33, p30
    // Every boundary index is on the border of the 4x4 grid; no interior one is.
    for (const k of NET_BOUNDARY) {
      const i = k >> 2, j = k & 3;
      expect(i === 0 || i === 3 || j === 0 || j === 3).toBe(true);
    }
  });

  it('places the four interior points off the border, in the same rotation', () => {
    expect(NET_INTERIOR).toEqual([5, 6, 10, 9]);    // p11, p12, p22, p21
    for (const k of NET_INTERIOR) {
      const i = k >> 2, j = k & 3;
      expect(i === 0 || i === 3 || j === 0 || j === 3).toBe(false);
    }
  });
});

describe('meshpatch — the Coons interior-point formula', () => {
  /**
   * ANCHORED OUTSIDE THE FORMULA ITSELF. On a regular affine lattice
   * `p[i][j] = A + i*U + j*V` a Coons patch IS that plane, so the formula must
   * return the lattice's own interior points — which is a property it has to
   * have rather than a number read off the same page it was transcribed from.
   * Measured: swapping its 6 and 3 coefficients yields 2U+2V where U+V is
   * right, so the check discriminates.
   */
  it('reproduces a regular affine lattice exactly', () => {
    for (const [A, U, V] of [
      [pt(0, 0), pt(1, 0), pt(0, 1)],
      [pt(7, -3), pt(2, 0.5), pt(-1, 4)],           // sheared and translated
    ] as const) {
      const net: Pt[] = new Array(16);
      for (let i = 0; i < 4; i++)
        for (let j = 0; j < 4; j++)
          net[i * 4 + j] = pt(A.x + i * U.x + j * V.x, A.y + i * U.y + j * V.y);
      const interior = NET_INTERIOR.map((k) => net[k]);
      for (const k of NET_INTERIOR) net[k] = pt(NaN, NaN);   // must be recomputed
      coonsInterior(net);
      NET_INTERIOR.forEach((k, n) => {
        expect(net[k].x).toBeCloseTo(interior[n].x, 9);
        expect(net[k].y).toBeCloseTo(interior[n].y, 9);
      });
    }
  });
});

describe('meshpatch — the shared-edge flags', () => {
  const prev: PatchRecord = { flag: 0, points: flatBoundary(), colors: RGB };

  /** The previous patch's four edges, in stream-point order (1-based ranges). */
  const edgeOf = (p: Patch, first: number): Pt[] =>
    [0, 1, 2, 3].map((n) => p.net[NET_BOUNDARY[(first - 1 + n) % 12]]);

  // Flags 1, 2 and 3 differ ONLY in which four points they keep, so a mesh
  // where two readings both produce a patch renders plausibly under either.
  // meshtri.ts records the same hazard for a type 4 mesh's flags 1 and 2, and
  // each is asserted alone for the same reason.
  for (const [flag, firstPoint, colorIdx] of [[1, 4, [1, 2]], [2, 7, [2, 3]], [3, 10, [3, 0]]] as const) {
    it(`flag ${flag} continues the previous patch at stream point ${firstPoint}`, () => {
      // Eight fresh boundary points (5..12) and two fresh colours.
      const fresh = Array.from({ length: 8 }, (_, n) => pt(100 + n, 200 + n));
      const rec: PatchRecord = { flag, points: fresh, colors: [[0.25, 0.25, 0.25], [0.5, 0.5, 0.5]] };
      const [a, b] = completePatches([prev, rec], 6);
      // The new patch's FIRST edge is the previous patch's shared one.
      expect(edgeOf(b, 1)).toEqual(edgeOf(a, firstPoint));
      // ...and the two carried colours are the ones at that edge's ends.
      expect(b.colors[0]).toEqual(a.colors[colorIdx[0]]);
      expect(b.colors[1]).toEqual(a.colors[colorIdx[1]]);
      // The stream's own eight points land at boundary 5..12, untouched.
      expect(edgeOf(b, 5)[0]).toEqual(fresh[0]);
      expect(b.net[NET_BOUNDARY[11]]).toEqual(fresh[7]);
      expect(b.colors[2]).toEqual([0.25, 0.25, 0.25]);
      expect(b.colors[3]).toEqual([0.5, 0.5, 0.5]);
    });
  }

  it('drops a continuation patch that has no predecessor', () => {
    const orphan: PatchRecord = { flag: 2, points: Array.from({ length: 8 }, () => pt(0, 0)), colors: [[0], [0]] };
    expect(completePatches([orphan], 6)).toHaveLength(0);
  });

  it('reads a type 7 patch its own four interior points rather than deriving them', () => {
    const interior = [pt(1, 9), pt(2, 9), pt(2, 8), pt(1, 8)];
    const [p] = completePatches([{ flag: 0, points: [...flatBoundary(), ...interior], colors: RGB }], 7);
    expect(NET_INTERIOR.map((k) => p.net[k])).toEqual(interior);
    // The same boundary as a type 6 gives the Coons-derived points instead, so
    // the two shapes are genuinely different surfaces.
    const [c] = completePatches([{ flag: 0, points: flatBoundary(), colors: RGB }], 6);
    expect(NET_INTERIOR.map((k) => c.net[k])).not.toEqual(interior);
  });
});

describe('meshpatch — how finely a patch subdivides', () => {
  const patchOf = (boundary: Pt[]): Patch =>
    completePatches([{ flag: 0, points: boundary, colors: [[0], [0], [0], [0]] }], 6)[0];

  it('does not subdivide a flat patch of one colour', () => {
    expect(patchGridSize(patchOf(flatBoundary(30)))).toBe(1);
  });

  it('subdivides more as the boundary curves harder', () => {
    // Bow the top edge (stream points 2 and 3) out by increasing amounts.
    const bowed = (d: number) => {
      const b = flatBoundary(30);
      b[1] = pt(b[1].x, b[1].y - d);
      b[2] = pt(b[2].x, b[2].y - d);
      return patchGridSize(patchOf(b));
    };
    expect(bowed(4)).toBeGreaterThan(1);
    expect(bowed(40)).toBeGreaterThan(bowed(4));
  });

  it('subdivides for a colour spread even when the geometry is flat', () => {
    const flat = flatBoundary(30);
    const oneColour = completePatches([{ flag: 0, points: flat, colors: [[0], [0], [0], [0]] }], 6)[0];
    const ramp = completePatches([{ flag: 0, points: flat, colors: [[0], [1], [1], [0]] }], 6)[0];
    expect(patchGridSize(oneColour)).toBe(1);
    expect(patchGridSize(ramp)).toBeGreaterThan(1);
  });

  // "Against the DEVICE scale" is the whole of the issue's wording: the same
  // patch shrunk costs fewer cells, because the error that matters is measured
  // in pixels rather than in the shading's own units.
  it('spends fewer cells on the same shape drawn smaller', () => {
    const bowed = (scale: number) => {
      const b = flatBoundary(scale);
      b[1] = pt(b[1].x, b[1].y - scale * 2);
      b[2] = pt(b[2].x, b[2].y - scale * 2);
      return patchGridSize(patchOf(b));
    };
    expect(bowed(2)).toBeLessThan(bowed(40));
  });

  // The cap is by the patch's own DEVICE SIZE, so a mesh of many tiny patches
  // costs its pixels rather than its patch count. Asserted from BOTH sides: the
  // same shape three times larger genuinely wants more than three cells, so the
  // small one is being held rather than simply not asking.
  it('never spends more cells across than a small patch is wide', () => {
    const zigzag = (s: number, amp: number) => {
      const b = flatBoundary(s);
      b[1] = pt(s, -amp);
      b[2] = pt(2 * s, amp);
      return patchGridSize(patchOf(b));
    };
    expect(zigzag(2 / 3, 1)).toBeLessThanOrEqual(3);   // ~3 device units across
    expect(zigzag(2, 3)).toBeGreaterThan(3);           // the same shape, 3x up
  });

  it('bounds the cell count however hard the patch curves', () => {
    const wild = flatBoundary(400);
    wild[1] = pt(wild[1].x, wild[1].y - 40000);
    wild[2] = pt(wild[2].x, wild[2].y + 40000);
    expect(patchGridSize(patchOf(wild))).toBeLessThanOrEqual(MAX_GRID);
  });

  it('terminates on a degenerate patch, painting nothing', () => {
    const collapsed = Array.from({ length: 12 }, () => pt(50, 50));
    const tris = patchTriangles(patchOf(collapsed));
    expect(tris.length).toBeGreaterThan(0);        // it still produces geometry
    for (const [a, b, c] of tris) {                // ...of zero area
      expect(Math.abs((b.x - a.x) * (c.y - a.y) - (c.x - a.x) * (b.y - a.y))).toBeLessThan(1e-9);
    }
  });
});

describe('meshpatch — the tessellated surface', () => {
  it('reproduces the flat quad its own control net spans', () => {
    const p = completePatches(
      [{ flag: 0, points: flatBoundary(30), colors: [[0], [1], [1], [0]] }], 6)[0];
    const tris = patchTriangles(p);
    for (const tri of tris) {
      for (const v of tri) {
        expect(v.x).toBeGreaterThanOrEqual(-1e-6);
        expect(v.x).toBeLessThanOrEqual(90 + 1e-6);
        expect(v.y).toBeGreaterThanOrEqual(-1e-6);
        expect(v.y).toBeLessThanOrEqual(90 + 1e-6);
      }
    }
    // Corner colours land at the corners: c1 at p00, c2 at p03, c3 at p33,
    // c4 at p30 — the mapping the bilinear colour rule turns on.
    const at = (x: number, y: number) => {
      for (const tri of tris)
        for (const v of tri)
          if (Math.abs(v.x - x) < 1e-6 && Math.abs(v.y - y) < 1e-6) return v.comps[0];
      throw new Error(`no vertex at ${x},${y}`);
    };
    expect(at(0, 0)).toBeCloseTo(0, 6);            // c1
    expect(at(90, 0)).toBeCloseTo(1, 6);           // c2, at p03 = (j=3, i=0)
    expect(at(90, 90)).toBeCloseTo(1, 6);          // c3
    expect(at(0, 90)).toBeCloseTo(0, 6);           // c4
  });

  // A bowed edge must push the surface OUTSIDE the box its four corners span —
  // that is the whole difference between a Coons patch and a bilinear quad, and
  // a flat fixture cannot see it.
  it('bulges outside the corners quad when an edge is bowed', () => {
    const b = flatBoundary(30);
    b[1] = pt(b[1].x, b[1].y - 60);
    b[2] = pt(b[2].x, b[2].y - 60);
    const p = completePatches([{ flag: 0, points: b, colors: [[0], [0], [0], [0]] }], 6)[0];
    const minY = Math.min(...patchTriangles(p).flatMap((t) => t.map((v) => v.y)));
    expect(minY).toBeLessThan(-10);
  });
});

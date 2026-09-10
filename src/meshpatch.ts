/**
 * Coons (type 6) and tensor (type 7) patch geometry: the shared-edge topology,
 * the Coons-to-tensor conversion, and the tessellation that turns one patch
 * into the triangles `meshtri.ts` already paints.
 *
 * A LEAF over `meshtri.js`'s types alone — no PDF object, no canvas, no colour
 * space, no `Document` — so every rule here is testable from plain numbers with
 * no file built. That is the split `meshtri.ts` itself makes, and for its
 * reason: this is geometry that is silently wrong when reversed rather than
 * loudly broken.
 *
 * **Note on the anchor, and it is weaker than this repo prefers:** there is no
 * second implementation to check against — no PDF rasterizer is available here,
 * so unlike `test/fixtures/tiff/` or `test/fixtures/xfa/` these rules are a
 * TRANSCRIPTION of ISO 32000-1 8.7.4.5.7 and 8.7.4.5.8 verified against
 * itself. Two things push back on that. The stream-to-net mapping is checked
 * STRUCTURALLY — the twelve boundary points must walk the 4x4 net's border
 * exactly once — and the interior-point formula is checked against a property
 * it must have rather than against the page it came from: on a regular affine
 * lattice a Coons patch IS that plane, so the formula must return the
 * lattice's own interior points. Do not read the green suite as conformance.
 */

import type { Triangle, TriVertex } from './meshtri.js';

/** A point in whatever space the caller works in. */
export interface Pt { x: number; y: number }

/**
 * One patch as the stream states it: the flag, the points it carries, and the
 * corner colours it carries. A flag of 0 states everything; 1, 2 and 3 omit the
 * four points and two colours the shared edge already fixed.
 */
export interface PatchRecord {
  flag: number;
  /** Stream order. 12 or 16 points for flag 0; four fewer otherwise. */
  points: readonly Pt[];
  /** Four colour tuples for flag 0, two otherwise. */
  colors: readonly (readonly number[])[];
}

/** A complete patch: the 4x4 tensor control net and the four corner colours. */
export interface Patch {
  /** Row-major, `net[i * 4 + j]` — so the corners are 0, 3, 15 and 12. */
  net: Pt[];
  /** `c1..c4`, at net indices 0, 3, 15 and 12 respectively. */
  colors: number[][];
}

/**
 * Stream point k (1-based) to its index in the 4x4 net.
 *
 * **Invariant:** these twelve walk the net's BORDER exactly once — j rising
 * along `i = 0`, then i rising along `j = 3`, then j falling along `i = 3`,
 * then i falling along `j = 0`. That closure is what makes the four edges
 * `[1..4]`, `[4..7]`, `[7..10]` and `[10..12, 1]`, which is in turn what makes
 * the shared-edge table below cyclically consistent. A mapping that does not
 * close still renders — as a different surface.
 */
export const NET_BOUNDARY: readonly number[] = [
  0, 1, 2, 3,      // p00 p01 p02 p03
  7, 11, 15,       // p13 p23 p33
  14, 13, 12,      // p32 p31 p30
  8, 4,            // p20 p10
];

/** Stream points 13..16 (type 7 only), in the same rotation as the boundary. */
export const NET_INTERIOR: readonly number[] = [5, 6, 10, 9];   // p11 p12 p22 p21

/**
 * Which four boundary points and which two corner colours a continuation patch
 * inherits, indexed by flag.
 *
 * **Invariant:** the shared edge always becomes the NEW patch's FIRST edge, and
 * the flag selects which of the previous patch's edges 2, 3 or 4 it was — so
 * the table is one rotation of the boundary loop and nothing else. The three
 * differ ONLY in which four they keep, so a mesh where two readings both
 * produce a patch renders plausibly under either; `meshtri.ts` records the same
 * hazard for a type 4 mesh's flags 1 and 2, and each is asserted alone.
 */
const SHARED: Record<number, { points: readonly number[]; colors: readonly number[] }> = {
  // Stream points 4,5,6,7 → the new 1,2,3,4. Colours c2,c3 → the new c1,c2.
  1: { points: [3, 4, 5, 6], colors: [1, 2] },
  2: { points: [6, 7, 8, 9], colors: [2, 3] },
  3: { points: [9, 10, 11, 0], colors: [3, 0] },
};

/** Never more than this many cells across, whatever the patch demands. */
export const MAX_GRID = 64;

/** Device-space chord error a tessellated edge may show, in pixels. */
const FLATNESS = 0.2;

/** Colour step a cell may span, as a fraction of the component range. */
const COLOR_TOL = 1 / 255;

/**
 * The four interior control points of a COONS patch, written into `net` at
 * `NET_INTERIOR` (32000-1 8.7.4.5.7). A Coons patch states only its boundary;
 * these are what make it a tensor patch, which is what lets ONE surface
 * evaluator serve both types rather than two that can disagree.
 */
export function coonsInterior(net: Pt[]): void {
  const p = (i: number, j: number) => net[i * 4 + j];
  const comb = (
    a: Pt, b1: Pt, b2: Pt, c1: Pt, c2: Pt, d1: Pt, d2: Pt, e: Pt,
  ): Pt => ({
    x: (-4 * a.x + 6 * (b1.x + b2.x) - 2 * (c1.x + c2.x) + 3 * (d1.x + d2.x) - e.x) / 9,
    y: (-4 * a.y + 6 * (b1.y + b2.y) - 2 * (c1.y + c2.y) + 3 * (d1.y + d2.y) - e.y) / 9,
  });
  const p11 = comb(p(0, 0), p(0, 1), p(1, 0), p(0, 3), p(3, 0), p(3, 1), p(1, 3), p(3, 3));
  const p12 = comb(p(0, 3), p(0, 2), p(1, 3), p(0, 0), p(3, 3), p(3, 2), p(1, 0), p(3, 0));
  const p21 = comb(p(3, 0), p(3, 1), p(2, 0), p(0, 0), p(3, 3), p(0, 1), p(2, 3), p(0, 3));
  const p22 = comb(p(3, 3), p(3, 2), p(2, 3), p(3, 0), p(0, 3), p(0, 2), p(2, 0), p(0, 0));
  net[5] = p11; net[6] = p12; net[10] = p22; net[9] = p21;
}

/**
 * Turn the stream's records into complete patches, resolving each continuation
 * against its predecessor and filling a Coons patch's interior.
 *
 * A continuation with no predecessor is DROPPED rather than guessed at: it
 * names four points and two colours that do not exist, and inventing them
 * paints a patch the document does not describe.
 */
export function completePatches(records: readonly PatchRecord[], type: number): Patch[] {
  const out: Patch[] = [];
  let prev: Patch | undefined;
  for (const rec of records) {
    const net: Pt[] = new Array(16);
    const colors: number[][] = [];
    let at = 0;                                    // next unread stream point

    if (rec.flag === 0) {
      if (rec.points.length < 12 || rec.colors.length < 4) continue;
      for (let k = 0; k < 12; k++) net[NET_BOUNDARY[k]] = rec.points[at++];
      for (let k = 0; k < 4; k++) colors.push([...rec.colors[k]]);
    } else {
      const share = SHARED[rec.flag];
      if (!share || !prev) continue;
      if (rec.points.length < 8 || rec.colors.length < 2) continue;
      // The shared edge becomes boundary points 1..4 of the new patch.
      share.points.forEach((k, n) => { net[NET_BOUNDARY[n]] = prev!.net[NET_BOUNDARY[k]]; });
      for (const k of share.colors) colors.push([...prev.colors[k]]);
      for (let k = 4; k < 12; k++) net[NET_BOUNDARY[k]] = rec.points[at++];
      for (let k = 0; k < 2; k++) colors.push([...rec.colors[k]]);
    }

    if (type === 7) {
      // A tensor patch always states its own four interior points, whatever the
      // flag says — the edge flag shares BOUNDARY geometry and nothing else.
      if (rec.points.length < at + 4) continue;
      for (const k of NET_INTERIOR) net[k] = rec.points[at++];
    } else {
      coonsInterior(net);
    }

    const patch: Patch = { net, colors };
    out.push(patch);
    prev = patch;
  }
  return out;
}

/** The four cubic Bernstein weights at `t`. */
function bernstein(t: number): [number, number, number, number] {
  const s = 1 - t;
  return [s * s * s, 3 * t * s * s, 3 * t * t * s, t * t * t];
}

/**
 * How many cells across to tessellate this patch, decided from the control net
 * in DEVICE space and from the corner-colour spread.
 *
 * Geometry uses the standard cubic-Bezier bound: a curve departs from its
 * N-segment chord approximation by at most `(3/4) * D / N²`, where `D` is the
 * largest second difference of its control points — so `N >= sqrt(3D / 4*tol)`.
 * Taking `D` over every row and column of the net covers both parameter
 * directions with one number.
 *
 * **Invariant:** it is decided from the CONTROL NET and never by evaluating the
 * surface, which is what keeps a quadtree's cost (and its T-junctions) out of
 * this. Neighbouring patches may land on different N, but their shared edge
 * lies on the SAME curve, so the gap between the two tessellations of it is
 * bounded by the coarser side's own tolerance — sub-pixel by construction,
 * which is why `FLATNESS` is below one device pixel rather than near it.
 */
export function patchGridSize(p: Patch): number {
  let d2 = 0;
  const second = (a: Pt, b: Pt, c: Pt) => {
    const x = a.x - 2 * b.x + c.x, y = a.y - 2 * b.y + c.y;
    const m = Math.hypot(x, y);
    if (Number.isFinite(m) && m > d2) d2 = m;
  };
  for (let i = 0; i < 4; i++) {
    for (let k = 0; k < 2; k++) {
      second(p.net[i * 4 + k], p.net[i * 4 + k + 1], p.net[i * 4 + k + 2]);        // row
      second(p.net[k * 4 + i], p.net[(k + 1) * 4 + i], p.net[(k + 2) * 4 + i]);    // column
    }
  }
  const nGeom = Math.sqrt((0.75 * d2) / FLATNESS);

  // Colour is interpolated within each triangle already, so what is left is the
  // bilinear-versus-linear residue, which falls as 1/N² like the geometry.
  let spread = 0;
  const comps = Math.min(...p.colors.map((c) => c.length));
  for (let k = 0; k < comps; k++) {
    const vs = p.colors.map((c) => c[k]);
    spread = Math.max(spread, Math.max(...vs) - Math.min(...vs));
  }
  const nColor = Math.sqrt(spread / COLOR_TOL);

  // Never more cells across than the patch is wide: a mesh of many small
  // patches must cost its pixels rather than its patch count.
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const q of p.net) {
    if (!Number.isFinite(q.x) || !Number.isFinite(q.y)) continue;
    if (q.x < minX) minX = q.x;
    if (q.x > maxX) maxX = q.x;
    if (q.y < minY) minY = q.y;
    if (q.y > maxY) maxY = q.y;
  }
  const span = Math.max(maxX - minX, maxY - minY);
  const cap = Number.isFinite(span) ? Math.max(1, Math.min(MAX_GRID, Math.ceil(span))) : 1;

  const want = Math.ceil(Math.max(nGeom, nColor));
  return Math.max(1, Math.min(cap, Number.isFinite(want) ? want : 1));
}

/**
 * Tessellate one patch — whose net must ALREADY be in device space — into
 * triangles carrying interpolated colour components.
 *
 * With a `/Function` a corner carries ONE parametric value rather than a
 * colour, and it interpolates exactly as a component does: the caller evaluates
 * the function afterwards, through the same LUT the axial and radial paths use.
 * That is `4gtd.4`'s rule for a Gouraud mesh, and it holds here unchanged.
 */
export function patchTriangles(p: Patch): Triangle[] {
  const n = patchGridSize(p);
  const comps = Math.min(...p.colors.map((c) => c.length));
  const [c1, c2, c3, c4] = p.colors;

  // Node grid: u indexes the net's rows (i), v its columns (j), so c1 sits at
  // (0,0), c2 at (0,1), c3 at (1,1) and c4 at (1,0) — the corners NET_BOUNDARY
  // puts at net indices 0, 3, 15 and 12.
  const nodes: TriVertex[] = new Array((n + 1) * (n + 1));
  for (let a = 0; a <= n; a++) {
    const u = a / n;
    const bu = bernstein(u);
    for (let b = 0; b <= n; b++) {
      const v = b / n;
      const bv = bernstein(v);
      let x = 0, y = 0;
      for (let i = 0; i < 4; i++) {
        for (let j = 0; j < 4; j++) {
          const w = bu[i] * bv[j];
          if (w === 0) continue;
          const q = p.net[i * 4 + j];
          x += w * q.x;
          y += w * q.y;
        }
      }
      const w1 = (1 - u) * (1 - v), w2 = (1 - u) * v, w3 = u * v, w4 = u * (1 - v);
      const cc: number[] = new Array(comps);
      for (let k = 0; k < comps; k++) {
        cc[k] = w1 * c1[k] + w2 * c2[k] + w3 * c3[k] + w4 * c4[k];
      }
      nodes[a * (n + 1) + b] = { x, y, comps: cc };
    }
  }

  const tris: Triangle[] = [];
  for (let a = 0; a < n; a++) {
    for (let b = 0; b < n; b++) {
      const q00 = nodes[a * (n + 1) + b];
      const q01 = nodes[a * (n + 1) + b + 1];
      const q10 = nodes[(a + 1) * (n + 1) + b];
      const q11 = nodes[(a + 1) * (n + 1) + b + 1];
      tris.push([q00, q01, q11], [q00, q11, q10]);
    }
  }
  return tris;
}

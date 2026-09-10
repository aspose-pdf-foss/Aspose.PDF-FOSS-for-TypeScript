/**
 * Gouraud triangle geometry: the topology rules of a type 4 or 5 mesh, and the
 * barycentric walk that paints one triangle.
 *
 * A LEAF importing nothing — no PDF object, no canvas, no colour space — so
 * every rule here is testable from plain numbers with no file built. That is the
 * split `floatstack.ts`, `tablespan.ts`, `linebox.ts` and `booklet.ts` each
 * already make, for the same reason: this is geometry that is silently wrong
 * when reversed rather than loudly broken.
 */

/** A mesh vertex in whatever space the caller works in. */
export interface TriVertex { x: number; y: number; comps: number[] }

/** Three vertices, ready to paint. */
export type Triangle = [TriVertex, TriVertex, TriVertex];

/**
 * Triangles of a FREE-FORM (type 4) mesh, from the per-vertex edge flag.
 *
 * 32000-1 8.7.4.5.5: a flag of 0 begins a new triangle and is followed by two
 * more vertices, whose own flags the reader ignores. A flag of 1 forms a
 * triangle with the previous two vertices (vb, vc); a flag of 2 with the FIRST
 * and LAST of the previous triangle (va, vc).
 *
 * **Invariant:** 1 and 2 differ only in WHICH two they keep, so a mesh where
 * both readings happen to produce a triangle renders plausibly under either —
 * which is why the two are asserted separately rather than together.
 */
export function freeFormTriangles(vertices: readonly TriVertex[], flags: readonly number[]): Triangle[] {
  const out: Triangle[] = [];
  let a: TriVertex | undefined;
  let b: TriVertex | undefined;
  let c: TriVertex | undefined;

  for (let i = 0; i < vertices.length; i++) {
    const flag = flags[i] ?? 0;
    if (flag === 0 || a === undefined || b === undefined || c === undefined) {
      // A new triangle takes the next three vertices outright. Their own flags
      // are not consulted, which is what the spec means by "must be 0".
      if (i + 2 >= vertices.length) break;
      a = vertices[i]; b = vertices[i + 1]; c = vertices[i + 2];
      i += 2;
    } else if (flag === 1) {
      a = b; b = c; c = vertices[i];
    } else {                       // flag 2 (and anything else, defensively)
      b = c; c = vertices[i];      // `a` is kept
    }
    out.push([a, b, c]);
  }
  return out;
}

/**
 * Triangles of a LATTICE-FORM (type 5) mesh: rows of `perRow` vertices, each
 * adjacent row pair giving two triangles per column step (8.7.4.5.6).
 *
 * **Invariant:** the two triangles of a cell SHARE the diagonal — (r0c0, r0c1,
 * r1c0) and (r0c1, r1c1, r1c0) — so the interpolation is continuous across it.
 * Emitting two triangles that do not share an edge leaves a visible seam
 * running the length of the mesh.
 */
export function latticeTriangles(vertices: readonly TriVertex[], perRow: number): Triangle[] {
  const out: Triangle[] = [];
  if (perRow < 2) return out;
  const rows = Math.floor(vertices.length / perRow);
  for (let r = 0; r + 1 < rows; r++) {
    for (let c = 0; c + 1 < perRow; c++) {
      const r0c0 = vertices[r * perRow + c];
      const r0c1 = vertices[r * perRow + c + 1];
      const r1c0 = vertices[(r + 1) * perRow + c];
      const r1c1 = vertices[(r + 1) * perRow + c + 1];
      out.push([r0c0, r0c1, r1c0], [r0c1, r1c1, r1c0]);
    }
  }
  return out;
}

/**
 * Walk the pixels a triangle covers, handing each its interpolated components.
 *
 * Vertices arrive in DEVICE space. The walk is over the triangle's own bounding
 * box rather than the whole clip region — a mesh is many small triangles, so
 * evaluating every pixel of the region against every triangle would be
 * O(pixels x triangles) where this is O(total triangle area).
 *
 * `comps` is reused between calls, so a consumer that keeps it must copy.
 */
export function eachTrianglePixel(
  t: Triangle,
  clip: { x0: number; y0: number; x1: number; y1: number },
  fn: (x: number, y: number, comps: number[]) => void,
): void {
  const [a, b, c] = t;
  // Signed area x2. A degenerate triangle covers nothing rather than dividing
  // by zero — a mesh legitimately carries them where a strip pinches.
  const det = (b.x - a.x) * (c.y - a.y) - (c.x - a.x) * (b.y - a.y);
  if (!Number.isFinite(det) || Math.abs(det) < 1e-12) return;

  const x0 = Math.max(clip.x0, Math.floor(Math.min(a.x, b.x, c.x)));
  const x1 = Math.min(clip.x1, Math.ceil(Math.max(a.x, b.x, c.x)));
  const y0 = Math.max(clip.y0, Math.floor(Math.min(a.y, b.y, c.y)));
  const y1 = Math.min(clip.y1, Math.ceil(Math.max(a.y, b.y, c.y)));
  if (x1 <= x0 || y1 <= y0) return;

  const n = Math.min(a.comps.length, b.comps.length, c.comps.length);
  const comps = new Array<number>(n);

  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const px = x + 0.5, py = y + 0.5;
      // Barycentric coordinates of the pixel centre.
      const wa = ((b.x - px) * (c.y - py) - (c.x - px) * (b.y - py)) / det;
      const wb = ((c.x - px) * (a.y - py) - (a.x - px) * (c.y - py)) / det;
      const wc = 1 - wa - wb;
      // A small negative tolerance keeps the shared edge of two triangles from
      // dropping a row of pixels to rounding — a hairline seam that reads as a
      // mesh fault rather than as arithmetic.
      if (wa < -1e-6 || wb < -1e-6 || wc < -1e-6) continue;
      for (let k = 0; k < n; k++) {
        comps[k] = wa * a.comps[k] + wb * b.comps[k] + wc * c.comps[k];
      }
      fn(x, y, comps);
    }
  }
}

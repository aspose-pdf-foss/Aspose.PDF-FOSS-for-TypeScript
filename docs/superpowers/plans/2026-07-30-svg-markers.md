# SVG Markers Implementation Plan (phase 2 of 5)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `page.AddSVGObject` honours `marker-start`, `marker-mid`, `marker-end` and the `marker` shorthand on `path`, `line`, `polyline` and `polygon`.

**Architecture:** Pure geometry plus one Form XObject. `svgmarker.ts` derives vertices and tangent angles from the already-flattened `SvgSeg[]` and builds a placement matrix per vertex; `svgdraw.ts` emits the `<marker>` subtree once as a Form XObject and `Do`s it at each vertex. No new PDF construct is involved and no rasterization — this phase is exact.

**Tech Stack:** TypeScript (ESM, NodeNext, `strict`), vitest. Zero runtime dependencies.

**Spec:** `docs/superpowers/specs/2026-07-30-svg-masks-filters-markers-design.md`, section "2. Markers".

**Issue:** `aspose-pdf-foss-for-ts-1gg0.10`, phase-2 child (filed in phase 1's Task 8).

**Depends on phase 1** only for `unitLength` being in `svgtransform.ts` and `shapeSegs` being in `svgpath.ts`. If phase 1 has not landed, do it first — this plan imports `shapeSegs` from `svgpath.js`.

## Global Constraints

- Zero runtime dependencies. Only `node:` built-ins. Do not add npm runtime deps.
- ESM + NodeNext: every relative import specifier carries the `.js` extension.
- `strict` TypeScript. `npm run typecheck` and `npm test` must both be green before any task is considered done.
- `src/svgdraw.ts` allocates **nothing**. Streams come from `SvgStreamSink`, implemented in `src/svgembed.ts` — the only module that may touch a `Document`. Every new module here is pure.
- SVG content is emitted in **viewBox units with y pointing DOWN**. The flip happens once, in `placementMatrix`. Never add a second flip — this matters for the marker viewport fit, which needs the y-down variant.
- `mul(m, n)` means "**m followed by n**". A point is transformed by `m` first. Getting this backwards is the single most likely bug in this phase.
- Angles are in **radians** internally; `orient` is authored in **degrees**.
- Errors: anything unrenderable degrades and is reported through `result.skipped`. Never throw for bad SVG.
- Commit messages end with `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`.
- Run a single test file with `npx vitest run test/<name>.test.ts`.

---

## File Structure

| File | Change | Responsibility |
|---|---|---|
| `src/svgtransform.ts` | modify | Gains `viewBoxFitDown` — the y-down viewBox fit, extracted from `tileMatrix`'s inline derivation. |
| `src/svgpattern.ts` | modify | `tileMatrix` uses `viewBoxFitDown`. |
| `src/svgmarker.ts` | **create** | `markerVertices` (vertices + tangent angles) and `resolveMarker`/`markerMatrix` (the `<marker>` viewport and per-vertex placement). Pure. |
| `src/svgstyle.ts` | modify | `markerStart`/`markerMid`/`markerEnd` on `Paint`, through the existing cascade. |
| `src/svgdraw.ts` | modify | `'marker'` in `DEFINITION`; build the marker form; emit one `Do` per vertex. |
| `test/svg-marker.test.ts` | **create** | `markerVertices`, `resolveMarker`, `markerMatrix`, and the emitted operators. |
| `test/svg-marker-render.test.ts` | **create** | End-to-end through `Save`/`Open`/`ToImage`. |
| `README.md` | modify | The SVG embedding bullet gains markers. |

---

## Task 1: Extract the y-down viewBox fit

`tileMatrix` derives the y-down viewBox fit by negating `placementMatrix`'s output
and rewriting `f` (`src/svgpattern.ts:111-127`, with the algebra in a comment).
Markers need the identical mapping. Extracting it means one derivation, tested
directly, rather than a second copy of a subtle negation.

**Files:**
- Modify: `src/svgtransform.ts` (append after `placementMatrix`)
- Modify: `src/svgpattern.ts:111-127`
- Test: `test/svg-marker.test.ts` (create — the marker tests join it in Tasks 2-3)

**Interfaces:**
- Consumes: `fitBox`, `ViewBox` (existing in `svgtransform.ts`).
- Produces: `viewBoxFitDown(vb: ViewBox, w: number, h: number, par: string | undefined): Matrix` from `src/svgtransform.ts`.

- [ ] **Step 1: Write the failing test**

Create `test/svg-marker.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { viewBoxFitDown } from '../src/svgtransform.js';

const near = (a: number, b: number) => expect(a).toBeCloseTo(b, 6);
/** Apply a matrix to a point, in mul()'s convention. */
const at = (m: readonly number[], x: number, y: number): [number, number] =>
  [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];

describe('viewBoxFitDown', () => {
  it('is identity for a viewBox matching the target exactly', () => {
    const m = viewBoxFitDown({ minX: 0, minY: 0, w: 10, h: 10 }, 10, 10, undefined);
    const [x, y] = at(m, 3, 4);
    near(x, 3); near(y, 4);
  });

  it('does NOT flip y — that is placementMatrix alone', () => {
    const m = viewBoxFitDown({ minX: 0, minY: 0, w: 10, h: 10 }, 10, 10, undefined);
    const [, y0] = at(m, 0, 0);
    const [, y1] = at(m, 0, 10);
    near(y0, 0); near(y1, 10);       // top stays top
  });

  it('scales a viewBox up to the target', () => {
    const m = viewBoxFitDown({ minX: 0, minY: 0, w: 10, h: 10 }, 30, 30, undefined);
    const [x, y] = at(m, 5, 5);
    near(x, 15); near(y, 15);
  });

  it('offsets by the viewBox origin', () => {
    const m = viewBoxFitDown({ minX: 4, minY: 6, w: 10, h: 10 }, 10, 10, undefined);
    const [x, y] = at(m, 4, 6);
    near(x, 0); near(y, 0);          // the viewBox corner lands at the origin
  });

  it('centres under the default xMidYMid meet', () => {
    // A 10x10 viewBox into a 30x10 target: uniform scale 1, centred on x.
    const m = viewBoxFitDown({ minX: 0, minY: 0, w: 10, h: 10 }, 30, 10, undefined);
    const [x, y] = at(m, 0, 0);
    near(x, 10); near(y, 0);
  });

  it('stretches each axis under preserveAspectRatio="none"', () => {
    const m = viewBoxFitDown({ minX: 0, minY: 0, w: 10, h: 10 }, 30, 10, 'none');
    const [x, y] = at(m, 10, 10);
    near(x, 30); near(y, 10);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/svg-marker.test.ts`
Expected: FAIL — `viewBoxFitDown` is not exported from `svgtransform.js`.

- [ ] **Step 3: Add `viewBoxFitDown` to `src/svgtransform.ts`**

Append after `placementMatrix`:

```ts
/** Map `vb` into a `w` x `h` box at the origin, in the y-DOWN frame svgdraw.ts
 *  emits in — the same fit as placementMatrix, without its y flip.
 *
 *  <pattern> tiles and <marker> viewports both need this. It is derived from
 *  fitBox directly rather than by negating placementMatrix, because `ty` is
 *  already measured downward: the mapping is simply
 *  x -> sx*(x - minX) + tx, y -> sy*(y - minY) + ty. */
export function viewBoxFitDown(
  vb: ViewBox, w: number, h: number, par: string | undefined,
): Matrix {
  const { sx, sy, tx, ty } = fitBox({ w: vb.w, h: vb.h }, { w, h }, par, undefined);
  return [sx, 0, 0, sy, tx - vb.minX * sx, ty - vb.minY * sy];
}
```

- [ ] **Step 4: Run the new test to verify it passes**

Run: `npx vitest run test/svg-marker.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Switch `tileMatrix` to the shared helper**

In `src/svgpattern.ts`, replace the `if (vb) { … }` block in `tileMatrix`
(lines 111-127) with:

```ts
  const vb = parseViewBox(attrs.get('viewBox'));
  if (vb) {
    // A viewBox overrides patternContentUnits entirely (SVG 1.1 §13.3).
    // /Matrix has already placed the tile, so fit into a box at the origin.
    return {
      matrix,
      content: viewBoxFitDown(vb, rect.w, rect.h, attrs.get('preserveAspectRatio')),
    };
  }
```

and update the import, dropping `placementMatrix` if nothing else in the file uses
it (check with `grep -n placementMatrix src/svgpattern.ts` first):

```ts
import {
  parseTransform, parseViewBox, unitLength, viewBoxFitDown, type ViewBox,
} from './svgtransform.js';
```

- [ ] **Step 6: Verify the refactor changed no behaviour**

Run: `npx vitest run test/svg-pattern.test.ts test/svg-pattern-render.test.ts && npm run typecheck`
Expected: PASS with no test edits. The unedited pattern suite is the proof — in
particular `svg-pattern.test.ts`'s `tileMatrix` viewBox cases, which pin the exact
matrix the old negation produced.

- [ ] **Step 7: Commit**

```bash
git add src/svgtransform.ts src/svgpattern.ts test/svg-marker.test.ts
git commit -m "$(cat <<'EOF'
refactor(svg): share the y-down viewBox fit

tileMatrix derived it by negating placementMatrix's flip and rewriting f;
markers need the same mapping, so it becomes viewBoxFitDown in
svgtransform.ts, derived from fitBox directly. The unedited pattern suite
pins the exact matrix the negation produced.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: `markerVertices` — vertices and tangent angles

The part most likely to be subtly wrong, so it is tested alone, against
hand-computed angles, before any PDF is involved.

**Files:**
- Create: `src/svgmarker.ts`
- Test: `test/svg-marker.test.ts` (append)

**Interfaces:**
- Consumes: `SvgSeg` from `./svgpath.js`.
- Produces, from `src/svgmarker.ts`:
  ```ts
  export interface MarkerVertex {
    x: number; y: number;
    /** Tangent direction in RADIANS, y-down frame. */
    angle: number;
    kind: 'start' | 'mid' | 'end';
  }
  export function markerVertices(segs: SvgSeg[]): MarkerVertex[];
  ```

**Semantics to implement exactly:**

- `kind` is positional over the **whole path**, not per subpath (SVG 1.1 §11.6.2):
  the very first vertex is `start`, the very last is `end`, everything between is
  `mid`. A two-subpath path gets exactly one `start`.
- `start` takes the **outgoing** tangent, `end` the **incoming**, `mid` the
  **bisector** — `atan2` of the two summed **unit** vectors, never the mean of two
  angles, which is discontinuous across ±180°. When the unit vectors cancel exactly
  (a perfect reversal), fall back to the incoming tangent.
- A cubic's tangent comes from its first (or last) **non-degenerate control leg**:
  `p0→p1`, else `p0→p2`, else `p0→p3` on the way in; the mirror on the way out.
- Zero-length segments are skipped when seeking a tangent.
- `Z` appends the subpath's start point as a further vertex; its angle is the
  bisector of the closing incoming tangent and the subpath's **initial outgoing**
  tangent.
- A single-point path (a lone `M`) yields one vertex, angle 0, kind `start`.

- [ ] **Step 1: Write the failing test**

Append to `test/svg-marker.test.ts`:

```ts
import { markerVertices } from '../src/svgmarker.js';
import { parsePath, shapeSegs } from '../src/svgpath.js';
import { parseXml } from '../src/xml.js';

const deg = (rad: number) => (rad * 180) / Math.PI;
const verts = (d: string) => markerVertices(parsePath(d).segs);

describe('markerVertices — kinds', () => {
  it('marks the first vertex start and the last end', () => {
    const v = verts('M 0 0 L 10 0 L 20 0');
    expect(v.map((p) => p.kind)).toEqual(['start', 'mid', 'end']);
  });

  it('gives the WHOLE path one start, not one per subpath', () => {
    // SVG 1.1 11.6.2: the first vertex of the path element. The second
    // subpath's opening vertex is a mid.
    const v = verts('M 0 0 L 10 0 M 50 0 L 60 0');
    expect(v.map((p) => p.kind)).toEqual(['start', 'mid', 'mid', 'end']);
  });

  it('yields one vertex for a lone moveto', () => {
    const v = verts('M 5 6');
    expect(v.length).toBe(1);
    expect(v[0].kind).toBe('start');
    expect(v[0].angle).toBe(0);
  });

  it('appends the closing vertex for Z', () => {
    // A closed triangle: start, mid, mid, and the closing vertex.
    const v = verts('M 0 0 L 10 0 L 10 10 Z');
    expect(v.length).toBe(4);
    expect(v.map((p) => p.kind)).toEqual(['start', 'mid', 'mid', 'end']);
    expect(v[3].x).toBe(0);
    expect(v[3].y).toBe(0);
  });
});

describe('markerVertices — angles', () => {
  it('takes the outgoing tangent at the start', () => {
    expect(deg(verts('M 0 0 L 10 0')[0].angle)).toBeCloseTo(0);
    expect(deg(verts('M 0 0 L 0 10')[0].angle)).toBeCloseTo(90);   // y-down
  });

  it('takes the incoming tangent at the end', () => {
    const v = verts('M 0 0 L 10 0 L 10 10');
    expect(deg(v[2].angle)).toBeCloseTo(90);
  });

  it('bisects at a mid vertex', () => {
    // In at 0 deg, out at 90 deg: the bisector is 45.
    const v = verts('M 0 0 L 10 0 L 10 10');
    expect(deg(v[1].angle)).toBeCloseTo(45);
  });

  it('bisects across the +-180 seam without averaging angles', () => {
    // In at 180 deg (leftward), out at -170. Averaging the two angles gives 5,
    // which points the WRONG WAY; the unit-vector sum gives 175.
    const v = markerVertices(parsePath(
      'M 100 0 L 0 0 L -98.48 -17.36').segs);
    expect(Math.abs(deg(v[1].angle))).toBeCloseTo(175, 0);
  });

  it('falls back to the incoming tangent on a perfect reversal', () => {
    // Out is exactly -in, so the unit vectors cancel and there is no bisector.
    const v = verts('M 0 0 L 10 0 L 0 0');
    expect(deg(v[1].angle)).toBeCloseTo(0);
  });

  it('takes a cubic tangent from its first control leg', () => {
    const v = verts('M 0 0 C 10 10 20 0 30 0');
    expect(deg(v[0].angle)).toBeCloseTo(45);
  });

  it('falls through a degenerate first control leg', () => {
    // p1 == p0, so the tangent must come from p0->p2.
    const v = verts('M 0 0 C 0 0 10 10 20 0');
    expect(deg(v[0].angle)).toBeCloseTo(45);
  });

  it('falls through to the chord when both control legs are degenerate', () => {
    const v = verts('M 0 0 C 0 0 0 0 10 10');
    expect(deg(v[0].angle)).toBeCloseTo(45);
  });

  it('skips a zero-length segment when seeking a tangent', () => {
    const v = verts('M 0 0 L 0 0 L 10 10');
    expect(deg(v[0].angle)).toBeCloseTo(45);
  });

  it('wraps the tangent round at a Z join', () => {
    // Closing leg comes in at 180 (from 10,0 back to 0,0); the subpath opens at
    // 0. The bisector of 180 and 0 is a reversal, so it falls back to incoming.
    const v = verts('M 0 0 L 10 0 Z');
    expect(deg(v[v.length - 1].angle)).toBeCloseTo(180);
  });

  it('bisects a square closing corner using the initial outgoing tangent', () => {
    // Closing leg arrives at 270 (upward, y-down); the subpath opens at 0.
    // Bisector of (0,-1) + (1,0) = 315 deg.
    const v = verts('M 0 0 L 10 0 L 10 10 L 0 10 Z');
    const a = deg(v[v.length - 1].angle);
    expect(a < 0 ? a + 360 : a).toBeCloseTo(315);
  });
});

describe('markerVertices — through basic shapes', () => {
  it('reaches a polyline via shapeSegs', () => {
    const root = parseXml(new TextEncoder().encode(
      '<svg><polyline points="0,0 10,0 10,10"/></svg>'));
    const v = markerVertices(shapeSegs(root.children[0]).segs);
    expect(v.map((p) => p.kind)).toEqual(['start', 'mid', 'end']);
    expect(deg(v[1].angle)).toBeCloseTo(45);
  });

  it('reaches a line via shapeSegs', () => {
    const root = parseXml(new TextEncoder().encode(
      '<svg><line x1="0" y1="0" x2="10" y2="10"/></svg>'));
    const v = markerVertices(shapeSegs(root.children[0]).segs);
    expect(v.length).toBe(2);
    expect(deg(v[0].angle)).toBeCloseTo(45);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/svg-marker.test.ts`
Expected: FAIL — `src/svgmarker.js` does not exist. The Task 1 block still passes.

- [ ] **Step 3: Create `src/svgmarker.ts` with `markerVertices`**

```ts
// SVG markers -> per-vertex Form XObject placements (issue 1gg0.10). Pure
// geometry: vertices and tangent angles from the flattened segment list, and the
// <marker> viewport mapping. Allocates nothing and knows no PDF — mirroring
// svgmask.ts's role for the other referenced definition.
import type { XmlNode } from './xml.js';
import type { SvgSeg, SegBBox } from './svgpath.js';
import {
  parseViewBox, viewBoxFitDown, type ViewBox,
} from './svgtransform.js';
import { IDENTITY, mul, type Matrix } from './text.js';

/** One marker position: where, which way, and which of the three properties
 *  paints there. `angle` is in RADIANS, in the y-DOWN frame svgdraw.ts emits. */
export interface MarkerVertex {
  x: number;
  y: number;
  angle: number;
  kind: 'start' | 'mid' | 'end';
}

type Pt = [number, number];

const EPS = 1e-9;

/** The direction from `a` to `b` as a unit vector, or null when they coincide. */
function unit(a: Pt, b: Pt): Pt | null {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const len = Math.hypot(dx, dy);
  return len < EPS ? null : [dx / len, dy / len];
}

/** A vertex with the tangents on either side, before kinds are assigned. */
interface Node {
  p: Pt;
  /** Direction arriving at `p`. Null at the very first vertex. */
  in: Pt | null;
  /** Direction leaving `p`. Null at the very last vertex. */
  out: Pt | null;
}

/** The vertices a path visits, with their in/out tangents.
 *
 *  A cubic's tangent comes from its first (or last) NON-DEGENERATE control leg —
 *  p0->p1, else p0->p2, else the chord — because a curve whose first control
 *  point coincides with its start point has no direction there. */
function nodes(segs: SvgSeg[]): Node[] {
  const out: Node[] = [];
  let cur: Pt | null = null;
  let subStart: Pt | null = null;
  let subStartIndex = -1;

  const push = (p: Pt): number => {
    out.push({ p, in: null, out: null });
    return out.length - 1;
  };
  /** Record a leg from the last vertex to `p`, whose direction leaving the last
   *  vertex is `dOut` and arriving at `p` is `dIn`. */
  const leg = (p: Pt, dOut: Pt | null, dIn: Pt | null): void => {
    const prev = out[out.length - 1];
    if (prev && prev.out === null) prev.out = dOut;
    const i = push(p);
    out[i].in = dIn;
  };

  for (const s of segs) {
    if (s.op === 'M') {
      cur = [s.args[0], s.args[1]];
      subStart = cur;
      subStartIndex = push(cur);
    } else if (s.op === 'L') {
      if (!cur) continue;
      const p: Pt = [s.args[0], s.args[1]];
      const d = unit(cur, p);
      leg(p, d, d);
      cur = p;
    } else if (s.op === 'C') {
      if (!cur) continue;
      const p1: Pt = [s.args[0], s.args[1]];
      const p2: Pt = [s.args[2], s.args[3]];
      const p3: Pt = [s.args[4], s.args[5]];
      const dOut = unit(cur, p1) ?? unit(cur, p2) ?? unit(cur, p3);
      const dIn = unit(p2, p3) ?? unit(p1, p3) ?? unit(cur, p3);
      leg(p3, dOut, dIn);
      cur = p3;
    } else {
      // Z: close back to the subpath start, appending it as a further vertex
      // whose outgoing tangent WRAPS to the subpath's initial direction.
      if (!cur || !subStart) continue;
      const d = unit(cur, subStart);
      leg([...subStart] as Pt, d, d);
      const opener = out[subStartIndex];
      out[out.length - 1].out = opener ? opener.out : null;
      cur = [...subStart] as Pt;
    }
  }
  return out;
}

/** The bisector of two unit directions, as an angle in radians.
 *
 *  atan2 of the SUM, never the mean of two angles: averaging is discontinuous
 *  across +-180, which points a marker the wrong way at an obtuse corner. When
 *  the two cancel exactly there is no bisector, so the incoming direction wins. */
function bisect(a: Pt, b: Pt): number {
  const sx = a[0] + b[0], sy = a[1] + b[1];
  if (Math.hypot(sx, sy) < EPS) return Math.atan2(a[1], a[0]);
  return Math.atan2(sy, sx);
}

/** Every marker position on a path, with tangent angles.
 *
 *  `kind` is positional over the WHOLE path, not per subpath: SVG 1.1 §11.6.2
 *  puts marker-start on "the first vertex of the given path element", so a
 *  two-subpath path gets exactly one start and the second subpath's opener is a
 *  mid. */
export function markerVertices(segs: SvgSeg[]): MarkerVertex[] {
  const ns = nodes(segs);
  return ns.map((n, i) => {
    const kind: MarkerVertex['kind'] =
      i === 0 ? 'start' : i === ns.length - 1 ? 'end' : 'mid';
    let angle = 0;
    if (n.in && n.out) angle = bisect(n.in, n.out);
    else if (n.out) angle = Math.atan2(n.out[1], n.out[0]);
    else if (n.in) angle = Math.atan2(n.in[1], n.in[0]);
    return { x: n.p[0], y: n.p[1], angle, kind };
  });
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/svg-marker.test.ts && npm run typecheck`
Expected: PASS.

If "bisects across the ±180 seam" fails, the implementation is averaging angles
somewhere — that is exactly the bug the test exists to catch. If "wraps the
tangent round at a Z join" fails, `out[subStartIndex]` is being read after the
opener's `out` was overwritten; check that `leg` only sets `prev.out` when it is
still `null`.

- [ ] **Step 5: Prove the bisector is load-bearing**

Temporarily replace `bisect`'s body with
`return (Math.atan2(a[1], a[0]) + Math.atan2(b[1], b[0])) / 2;` — the naive
angle average.
Run: `npx vitest run test/svg-marker.test.ts`
Expected: FAIL on "bisects across the ±180 seam" and "bisects a square closing
corner". Revert and re-run to green.

- [ ] **Step 6: Commit**

```bash
git add src/svgmarker.ts test/svg-marker.test.ts
git commit -m "$(cat <<'EOF'
feat(svg): markerVertices — marker positions and tangent angles

Pure geometry over the flattened SvgSeg list, so every shape and every
path command including arcs reaches it uniformly.

kind is positional over the WHOLE path (SVG 1.1 11.6.2), so a two-subpath
path gets one start. Mid angles bisect via the unit-vector SUM, not the
mean of two angles, which is discontinuous across +-180 and aims a marker
backwards at an obtuse corner. A cubic's tangent falls through degenerate
control legs; Z wraps the tangent to the subpath's opening direction.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: `resolveMarker` and `markerMatrix`

**Files:**
- Modify: `src/svgmarker.ts`
- Test: `test/svg-marker.test.ts` (append)

**Interfaces:**
- Consumes: `MarkerVertex` (Task 2); `viewBoxFitDown`, `parseViewBox` (Task 1).
- Produces, from `src/svgmarker.ts`:
  ```ts
  export interface MarkerSpec {
    /** markerWidth / markerHeight — the viewport the content is fitted into. */
    w: number; h: number;
    /** The viewBox -> viewport fit, applied to the content. Identity with no viewBox. */
    content: Matrix;
    /** The clip rect in VIEWPORT space, or null under overflow: visible. */
    clip: SegBBox | null;
    /** refX / refY, already mapped through `content` into viewport space. */
    refX: number; refY: number;
    /** markerUnits === 'strokeWidth' (the default). */
    scaleByStroke: boolean;
    /** A fixed angle in RADIANS, or one of the two auto modes. */
    orient: 'auto' | 'auto-start-reverse' | number;
  }
  export function resolveMarker(node: XmlNode): MarkerSpec | null;
  export function markerMatrix(
    spec: MarkerSpec, v: MarkerVertex, strokeWidth: number,
  ): Matrix;
  ```

**Semantics:** `markerWidth`/`markerHeight` default to 3; a non-positive value
means the marker is not rendered, so `resolveMarker` returns `null`. `refX`/`refY`
default to 0 and are authored in **viewBox** coordinates, so they are mapped
through `content` — including its translation — which is the detail
implementations most often get wrong. `overflow` defaults to hidden, clipping to
the viewport rect `(0, 0, w, h)`; `visible` yields `null`. `orient` accepts
`auto`, `auto-start-reverse`, or a number in degrees (default 0).

`markerMatrix` composes, in `mul`'s "m followed by n" order:

```
content  ->  translate(-refX, -refY)  ->  scale(sw)  ->  rotate(θ)  ->  translate(vertex)
```

with `sw` the element's `stroke-width` when `scaleByStroke`, else 1, and θ from
`orient` (plus 180° for `auto-start-reverse` on a `start` vertex only).

- [ ] **Step 1: Write the failing test**

Append to `test/svg-marker.test.ts`:

```ts
import { resolveMarker, markerMatrix, type MarkerVertex } from '../src/svgmarker.js';

function marker(src: string, id = 'm') {
  const root = parseXml(new TextEncoder().encode(src));
  let found: import('../src/xml.js').XmlNode | undefined;
  const walk = (n: import('../src/xml.js').XmlNode): void => {
    if (n.attrs.get('id') === id) found ??= n;
    for (const c of n.children) walk(c);
  };
  walk(root);
  return resolveMarker(found!);
}

const V = (over: Partial<MarkerVertex> = {}): MarkerVertex =>
  ({ x: 0, y: 0, angle: 0, kind: 'mid', ...over });

describe('resolveMarker', () => {
  it('defaults markerWidth and markerHeight to 3', () => {
    const s = marker('<svg><marker id="m"/></svg>')!;
    expect(s.w).toBe(3);
    expect(s.h).toBe(3);
  });

  it('returns null for a non-positive viewport', () => {
    expect(marker('<svg><marker id="m" markerWidth="0"/></svg>')).toBeNull();
    expect(marker('<svg><marker id="m" markerHeight="-1"/></svg>')).toBeNull();
  });

  it('defaults markerUnits to strokeWidth', () => {
    expect(marker('<svg><marker id="m"/></svg>')!.scaleByStroke).toBe(true);
    expect(marker('<svg><marker id="m" markerUnits="userSpaceOnUse"/></svg>')!.scaleByStroke)
      .toBe(false);
  });

  it('clips to the viewport by default and not under overflow visible', () => {
    const hidden = marker('<svg><marker id="m" markerWidth="4" markerHeight="6"/></svg>')!;
    expect(hidden.clip).toEqual({ x: 0, y: 0, w: 4, h: 6 });
    expect(marker('<svg><marker id="m" overflow="visible"/></svg>')!.clip).toBeNull();
  });

  it('parses orient', () => {
    expect(marker('<svg><marker id="m"/></svg>')!.orient).toBe(0);
    expect(marker('<svg><marker id="m" orient="auto"/></svg>')!.orient).toBe('auto');
    expect(marker('<svg><marker id="m" orient="auto-start-reverse"/></svg>')!.orient)
      .toBe('auto-start-reverse');
    expect(marker('<svg><marker id="m" orient="90"/></svg>')!.orient)
      .toBeCloseTo(Math.PI / 2);
  });

  it('maps refX and refY THROUGH the viewBox fit', () => {
    // viewBox 0 0 10 10 into a 20x20 viewport: scale 2. refX=5 is a viewBox
    // coordinate, so it lands at 10 in viewport space, not at 5.
    const s = marker(
      '<svg><marker id="m" viewBox="0 0 10 10" markerWidth="20" markerHeight="20" ' +
      'refX="5" refY="5"/></svg>')!;
    near(s.refX, 10);
    near(s.refY, 10);
  });

  it('includes the viewBox translation when mapping refX', () => {
    // viewBox minX=10: the fit shifts content by -10*scale, and refX must ride
    // along or the marker is offset by the viewBox origin.
    const s = marker(
      '<svg><marker id="m" viewBox="10 0 10 10" markerWidth="10" markerHeight="10" ' +
      'refX="10" refY="0"/></svg>')!;
    near(s.refX, 0);
  });

  it('takes refX literally with no viewBox', () => {
    const s = marker('<svg><marker id="m" refX="2" refY="3"/></svg>')!;
    near(s.refX, 2);
    near(s.refY, 3);
  });
});

describe('markerMatrix', () => {
  it('lands the reference point exactly on the vertex', () => {
    const s = marker('<svg><marker id="m" markerWidth="10" markerHeight="10" ' +
      'refX="5" refY="5" markerUnits="userSpaceOnUse"/></svg>')!;
    const m = markerMatrix(s, V({ x: 100, y: 200 }), 1);
    const [x, y] = at(m, 5, 5);      // the reference point in content space
    near(x, 100); near(y, 200);
  });

  it('scales by stroke-width under the default markerUnits', () => {
    const s = marker('<svg><marker id="m" markerWidth="10" markerHeight="10"/></svg>')!;
    const m = markerMatrix(s, V(), 4);
    const [x, y] = at(m, 1, 0);
    near(x, 4); near(y, 0);
  });

  it('ignores stroke-width under markerUnits="userSpaceOnUse"', () => {
    const s = marker('<svg><marker id="m" markerUnits="userSpaceOnUse"/></svg>')!;
    const m = markerMatrix(s, V(), 4);
    const [x] = at(m, 1, 0);
    near(x, 1);
  });

  it('rotates by a fixed orient angle', () => {
    const s = marker('<svg><marker id="m" orient="90" markerUnits="userSpaceOnUse"/></svg>')!;
    const m = markerMatrix(s, V(), 1);
    const [x, y] = at(m, 1, 0);
    near(x, 0); near(y, 1);          // y-down: +90 turns +x into +y
  });

  it('rotates to the tangent under orient="auto"', () => {
    const s = marker('<svg><marker id="m" orient="auto" markerUnits="userSpaceOnUse"/></svg>')!;
    const m = markerMatrix(s, V({ angle: Math.PI / 2 }), 1);
    const [x, y] = at(m, 1, 0);
    near(x, 0); near(y, 1);
  });

  it('reverses a START vertex under auto-start-reverse', () => {
    const s = marker(
      '<svg><marker id="m" orient="auto-start-reverse" markerUnits="userSpaceOnUse"/></svg>')!;
    const m = markerMatrix(s, V({ kind: 'start', angle: 0 }), 1);
    const [x, y] = at(m, 1, 0);
    near(x, -1); near(Math.abs(y), 0);
  });

  it('does NOT reverse a mid or end vertex under auto-start-reverse', () => {
    const s = marker(
      '<svg><marker id="m" orient="auto-start-reverse" markerUnits="userSpaceOnUse"/></svg>')!;
    for (const kind of ['mid', 'end'] as const) {
      const [x] = at(markerMatrix(s, V({ kind, angle: 0 }), 1), 1, 0);
      near(x, 1);
    }
  });

  it('applies rotation about the reference point, not the content origin', () => {
    // refX=5 with a 90 deg rotation: the reference point must stay on the vertex
    // no matter the angle. Composing rotate BEFORE the ref translate would swing
    // the marker away from it.
    const s = marker('<svg><marker id="m" markerWidth="10" markerHeight="10" ' +
      'refX="5" refY="5" orient="90" markerUnits="userSpaceOnUse"/></svg>')!;
    const m = markerMatrix(s, V({ x: 70, y: 80 }), 1);
    const [x, y] = at(m, 5, 5);
    near(x, 70); near(y, 80);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/svg-marker.test.ts`
Expected: FAIL — `resolveMarker` and `markerMatrix` are not exported.

- [ ] **Step 3: Implement both in `src/svgmarker.ts`**

Append:

```ts
/** A resolved <marker>: its viewport, content fit, reference point and orient. */
export interface MarkerSpec {
  w: number;
  h: number;
  /** The viewBox -> viewport fit applied to the content; identity with none. */
  content: Matrix;
  /** The clip rect in VIEWPORT space, or null under overflow: visible. */
  clip: SegBBox | null;
  /** refX / refY, already mapped through `content` into viewport space. */
  refX: number;
  refY: number;
  scaleByStroke: boolean;
  /** A fixed angle in RADIANS, or one of the two auto modes. */
  orient: 'auto' | 'auto-start-reverse' | number;
}

const attrNum = (n: XmlNode, k: string, dflt: number): number => {
  const v = n.attrs.get(k);
  if (v === undefined) return dflt;
  const f = parseFloat(v);
  return Number.isFinite(f) ? f : dflt;
};

/** Resolve one `<marker>`. Returns null when its viewport has no area, which SVG
 *  treats as "not rendered" rather than as an error. */
export function resolveMarker(node: XmlNode): MarkerSpec | null {
  const w = attrNum(node, 'markerWidth', 3);
  const h = attrNum(node, 'markerHeight', 3);
  if (!(w > 0) || !(h > 0)) return null;

  const vb = parseViewBox(node.attrs.get('viewBox'));
  const content: Matrix = vb
    ? viewBoxFitDown(vb, w, h, node.attrs.get('preserveAspectRatio'))
    : [...IDENTITY];

  // refX/refY are authored in VIEWBOX coordinates, so they ride through the fit
  // -- translation included. Mapping them in viewport units instead offsets
  // every marker by the viewBox origin, scaled.
  const rx = attrNum(node, 'refX', 0);
  const ry = attrNum(node, 'refY', 0);
  const refX = content[0] * rx + content[2] * ry + content[4];
  const refY = content[1] * rx + content[3] * ry + content[5];

  const ov = (node.attrs.get('overflow') ?? '').trim();
  const clip = ov === 'visible' || ov === 'auto' ? null : { x: 0, y: 0, w, h };

  const or = (node.attrs.get('orient') ?? '').trim();
  let orient: MarkerSpec['orient'];
  if (or === 'auto') orient = 'auto';
  else if (or === 'auto-start-reverse') orient = 'auto-start-reverse';
  else {
    const a = parseFloat(or);
    orient = Number.isFinite(a) ? (a * Math.PI) / 180 : 0;
  }

  return {
    w, h, content, clip, refX, refY,
    scaleByStroke: (node.attrs.get('markerUnits') ?? 'strokeWidth') !== 'userSpaceOnUse',
    orient,
  };
}

/** The placement for one vertex, composing (in mul's "m followed by n" order):
 *
 *    content -> translate(-ref) -> scale(sw) -> rotate(theta) -> translate(vertex)
 *
 *  The ref translate comes BEFORE the rotation, so the marker turns about its
 *  reference point and that point stays pinned to the vertex at every angle. */
export function markerMatrix(
  spec: MarkerSpec, v: MarkerVertex, strokeWidth: number,
): Matrix {
  let theta: number;
  if (spec.orient === 'auto') theta = v.angle;
  else if (spec.orient === 'auto-start-reverse')
    theta = v.kind === 'start' ? v.angle + Math.PI : v.angle;
  else theta = spec.orient;

  const sw = spec.scaleByStroke ? strokeWidth : 1;
  const c = Math.cos(theta), s = Math.sin(theta);

  let m = mul(spec.content, [1, 0, 0, 1, -spec.refX, -spec.refY]);
  if (sw !== 1) m = mul(m, [sw, 0, 0, sw, 0, 0]);
  m = mul(m, [c, s, -s, c, 0, 0]);
  return mul(m, [1, 0, 0, 1, v.x, v.y]);
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/svg-marker.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Prove the composition order is load-bearing**

Temporarily move the ref translate after the rotation — change the body to
`let m = mul(spec.content, [c, s, -s, c, 0, 0]); m = mul(m, [1,0,0,1,-spec.refX,-spec.refY]); …`.
Run: `npx vitest run test/svg-marker.test.ts`
Expected: FAIL on "applies rotation about the reference point". Revert and re-run
to green.

Then temporarily drop the translation terms from the `refX`/`refY` mapping
(`const refX = content[0] * rx + content[2] * ry;`).
Expected: FAIL on "includes the viewBox translation when mapping refX". Revert.

- [ ] **Step 6: Commit**

```bash
git add src/svgmarker.ts test/svg-marker.test.ts
git commit -m "$(cat <<'EOF'
feat(svg): resolveMarker and markerMatrix

The <marker> viewport, viewBox fit, overflow clip and orient, plus the
per-vertex placement.

refX/refY are authored in VIEWBOX coordinates, so they are mapped through
the fit including its translation -- the detail implementations most often
get wrong. The ref translate composes BEFORE the rotation, so a marker
turns about its reference point and that point stays pinned to the vertex
at every angle.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: The three properties on `Paint`

**Files:**
- Modify: `src/svgstyle.ts` — `Paint` (lines 9-27), `INITIAL` (31-45), `resolveStyle` (198-258)
- Test: `test/svg-style.test.ts` (append)

**Interfaces:**
- Consumes: the existing `styleGetter` cascade.
- Produces: `Paint.markerStart`, `Paint.markerMid`, `Paint.markerEnd`, each `string | null` (an element id, or null for none).

**Semantics:** all three are **inherited** properties, so they come along in
`{ ...parent }` for free and are only overwritten when the element sets them. The
`marker` shorthand sets all three, and a specific longhand on the same element
outranks it. `none` and an unparseable value both mean null.

- [ ] **Step 1: Write the failing test**

Append to `test/svg-style.test.ts` (match the file's existing helper for building
an attribute map — read the top of the file first and reuse it rather than adding
a second one):

```ts
describe('resolveStyle — marker properties', () => {
  const attrs = (o: Record<string, string>) => new Map(Object.entries(o));

  it('defaults to null', () => {
    const { paint } = resolveStyle(INITIAL, attrs({}));
    expect(paint.markerStart).toBeNull();
    expect(paint.markerMid).toBeNull();
    expect(paint.markerEnd).toBeNull();
  });

  it('reads the three longhands', () => {
    const { paint } = resolveStyle(INITIAL, attrs({
      'marker-start': 'url(#a)', 'marker-mid': 'url(#b)', 'marker-end': 'url(#c)',
    }));
    expect(paint.markerStart).toBe('a');
    expect(paint.markerMid).toBe('b');
    expect(paint.markerEnd).toBe('c');
  });

  it('sets all three from the marker shorthand', () => {
    const { paint } = resolveStyle(INITIAL, attrs({ marker: 'url(#a)' }));
    expect([paint.markerStart, paint.markerMid, paint.markerEnd]).toEqual(['a', 'a', 'a']);
  });

  it('lets a longhand outrank the shorthand on the same element', () => {
    const { paint } = resolveStyle(INITIAL, attrs({ marker: 'url(#a)', 'marker-end': 'url(#z)' }));
    expect(paint.markerStart).toBe('a');
    expect(paint.markerEnd).toBe('z');
  });

  it('inherits from the parent', () => {
    const { paint: parent } = resolveStyle(INITIAL, attrs({ 'marker-mid': 'url(#b)' }));
    const { paint } = resolveStyle(parent, attrs({}));
    expect(paint.markerMid).toBe('b');
  });

  it('lets none clear an inherited value', () => {
    const { paint: parent } = resolveStyle(INITIAL, attrs({ 'marker-mid': 'url(#b)' }));
    const { paint } = resolveStyle(parent, attrs({ 'marker-mid': 'none' }));
    expect(paint.markerMid).toBeNull();
  });

  it('honours an inline style over the attribute', () => {
    const { paint } = resolveStyle(INITIAL, attrs({
      'marker-end': 'url(#a)', style: 'marker-end:url(#z)',
    }));
    expect(paint.markerEnd).toBe('z');
  });

  it('does NOT add a marker id to refs — it is not a paint server', () => {
    const { refs } = resolveStyle(INITIAL, attrs({ 'marker-end': 'url(#a)' }));
    expect(refs).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/svg-style.test.ts`
Expected: FAIL — `markerStart` is not a property of `Paint`.

- [ ] **Step 3: Extend `Paint` and `INITIAL`**

In `src/svgstyle.ts`, add to the `Paint` interface:

```ts
  /** The id from `marker-start="url(#id)"`, else null. Inherited, like the
   *  paint properties, so it travels in `{ ...parent }`. Not in `refs`: a marker
   *  is not a paint server, and svgdraw.ts resolves it separately. */
  markerStart: string | null;
  markerMid: string | null;
  markerEnd: string | null;
```

and to `INITIAL`:

```ts
  markerStart: null,
  markerMid: null,
  markerEnd: null,
```

- [ ] **Step 4: Read them in `resolveStyle`**

Insert before the `return { paint: p, refs }`:

```ts
  // marker sets all three; a longhand on the same element outranks it. `none`
  // and an unparseable value both clear the inherited id.
  const markerId = (v: string | undefined): string | null | undefined => {
    if (v === undefined) return undefined;
    const m = /^url\(\s*#([^)\s]+)\s*\)$/.exec(v.trim());
    return m ? m[1] : null;
  };
  const all = markerId(get('marker'));
  if (all !== undefined) { p.markerStart = all; p.markerMid = all; p.markerEnd = all; }
  const ms = markerId(get('marker-start'));
  if (ms !== undefined) p.markerStart = ms;
  const mm = markerId(get('marker-mid'));
  if (mm !== undefined) p.markerMid = mm;
  const me = markerId(get('marker-end'));
  if (me !== undefined) p.markerEnd = me;
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run test/svg-style.test.ts && npm run typecheck`
Expected: PASS. TypeScript will flag any other object literal building a `Paint`
without the three new fields — `INITIAL` is the only one, since every other path
spreads an existing `Paint`.

- [ ] **Step 6: Commit**

```bash
git add src/svgstyle.ts test/svg-style.test.ts
git commit -m "$(cat <<'EOF'
feat(svg): marker-start/mid/end on Paint

Inherited properties, so they travel in { ...parent } and the existing
cascade gives attribute, inline-style and stylesheet spellings for free.
The marker shorthand sets all three; a longhand outranks it.

Kept out of `refs`: a marker is not a paint server, and reporting it there
would name it as an unsupported url() reference.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: Wire markers into the walker

**Files:**
- Modify: `src/svgdraw.ts` — `DEFINITION` (line 62), and `paintShape`'s call site inside `walk`'s `paintInto`
- Test: `test/svg-marker.test.ts` (append)

**Interfaces:**
- Consumes: `markerVertices`, `resolveMarker`, `markerMatrix`, `MarkerSpec` (Tasks 2-3); `Paint.markerStart`/`Mid`/`End` (Task 4); `groupForm`'s sibling machinery — but **not** `groupForm` itself: a marker form is not a transparency group.
- Produces: no new exports.

**Placement.** Markers paint **after** the path, in the same `q`/`Q` scope, so the
element's transform applies to them and they sit above its own ink. They apply to
`path`, `line`, `polyline`, `polygon` only.

**One form per (marker, element).** The `strokeWidth` scale is per element, not
per vertex, so one form serves every vertex of one element — but a different
element with a different stroke width needs its own. Key the cache on the marker
id plus the resolved stroke width.

**Marker content does not inherit** from the referencing element: it walks from
`INITIAL`, exactly as `tilingFor` does for a pattern tile.

- [ ] **Step 1: Write the failing test**

Append to `test/svg-marker.test.ts` (reuse the `draw`, `recordingSink`, `noFonts`
and `sub` helpers from `test/svg-mask.test.ts` — copy them in, as
`svg-mask.test.ts` exports nothing):

```ts
const ARROW =
  '<defs><marker id="mk" markerWidth="10" markerHeight="10" refX="5" refY="5" ' +
  'markerUnits="userSpaceOnUse"><rect width="10" height="10" fill="#0000ff"/>' +
  '</marker></defs>';

describe('svgdraw — marker wiring', () => {
  it('reports nothing and emits one Do per vertex', () => {
    const { content, skipped } = draw(
      `<svg viewBox="0 0 100 100">${ARROW}` +
      '<path d="M 10 10 L 50 10 L 90 10" stroke="#000" marker-mid="url(#mk)"/></svg>');
    expect(skipped).toEqual([]);
    // One mid vertex on a three-vertex path.
    expect((content.match(/\/Fm\d+ Do/g) ?? []).length).toBe(1);
  });

  it('emits a Do for each of start, mid and end', () => {
    const { content } = draw(
      `<svg viewBox="0 0 100 100">${ARROW}` +
      '<path d="M 10 10 L 50 10 L 90 10" stroke="#000" marker="url(#mk)"/></svg>');
    expect((content.match(/\/Fm\d+ Do/g) ?? []).length).toBe(3);
  });

  it('allocates ONE form for all of an element\'s vertices', () => {
    const { streams } = draw(
      `<svg viewBox="0 0 100 100">${ARROW}` +
      '<path d="M 10 10 L 50 10 L 90 10" stroke="#000" marker="url(#mk)"/></svg>');
    expect(streams.length).toBe(1);
  });

  it('places each Do at its vertex', () => {
    const { content } = draw(
      `<svg viewBox="0 0 100 100">${ARROW}` +
      '<path d="M 10 20 L 90 20" stroke="#000" marker-start="url(#mk)"/></svg>');
    // refX/refY 5,5 with userSpaceOnUse: the content shifts by -5,-5 then lands
    // on (10,20), so the cm translation is (5,15).
    expect(content).toMatch(/1 0 0 1 5 15 cm/);
  });

  it('does not paint a <marker> where it sits', () => {
    const { content, skipped } = draw(`<svg viewBox="0 0 100 100">${ARROW}</svg>`);
    expect(content.trim()).toBe('');
    expect(skipped).toEqual([]);
  });

  it('ignores markers on a shape they do not apply to', () => {
    const { content, skipped } = draw(
      `<svg viewBox="0 0 100 100">${ARROW}` +
      '<rect width="50" height="50" stroke="#000" marker="url(#mk)"/></svg>');
    expect(skipped).toEqual([]);
    expect(content).not.toMatch(/\/Fm\d+ Do/);
  });

  it('applies to line, polyline and polygon', () => {
    for (const shape of [
      '<line x1="0" y1="0" x2="10" y2="0" stroke="#000" marker-start="url(#mk)"/>',
      '<polyline points="0,0 10,0" stroke="#000" marker-start="url(#mk)"/>',
      '<polygon points="0,0 10,0 10,10" stroke="#000" marker-start="url(#mk)"/>',
    ]) {
      const { content } = draw(`<svg viewBox="0 0 100 100">${ARROW}${shape}</svg>`);
      expect(content).toMatch(/\/Fm\d+ Do/);
    }
  });

  it('reports url() for a missing marker target and still draws the path', () => {
    const { content, skipped } = draw(
      '<svg viewBox="0 0 100 100">' +
      '<path d="M 0 0 L 10 0" stroke="#000" marker-start="url(#gone)"/></svg>');
    expect(skipped).toEqual(['url()']);
    expect(content).toContain(' S');            // the stroke still happened
    expect(content).not.toMatch(/\/Fm\d+ Do/);
  });

  it('clips the form to the viewport by default', () => {
    const { streams } = draw(
      `<svg viewBox="0 0 100 100">${ARROW}` +
      '<path d="M 10 10 L 90 10" stroke="#000" marker-start="url(#mk)"/></svg>');
    expect(streams[0].dict.get('BBox')).toEqual([0, 0, 10, 10]);
  });

  it('does not inherit the referencing element\'s paint', () => {
    // The path is red; the marker rect specifies no fill, so it must be BLACK
    // (SVG's initial fill), not red.
    const { streams } = draw(
      '<svg viewBox="0 0 100 100"><defs>' +
      '<marker id="mk" markerWidth="10" markerHeight="10" markerUnits="userSpaceOnUse">' +
      '<rect width="10" height="10"/></marker></defs>' +
      '<path d="M 0 0 L 10 0" fill="#ff0000" stroke="#ff0000" marker-start="url(#mk)"/></svg>');
    expect(streams[0].content).toContain('0 0 0 rg');
    expect(streams[0].content).not.toContain('1 0 0 rg');
  });

  it('scales by stroke-width under the default markerUnits', () => {
    const { content } = draw(
      '<svg viewBox="0 0 100 100"><defs>' +
      '<marker id="mk" markerWidth="10" markerHeight="10"><rect width="10" height="10"/>' +
      '</marker></defs>' +
      '<path d="M 0 0 L 10 0" stroke="#000" stroke-width="3" marker-start="url(#mk)"/></svg>');
    expect(content).toMatch(/3 0 0 3 0 0 cm/);
  });

  it('breaks a marker reference cycle instead of recursing forever', () => {
    const { skipped } = draw(
      '<svg viewBox="0 0 100 100"><defs>' +
      '<marker id="mk" markerWidth="10" markerHeight="10">' +
      '<path d="M 0 0 L 5 0" stroke="#000" marker-start="url(#mk)"/></marker></defs>' +
      '<path d="M 0 0 L 10 0" stroke="#000" marker-start="url(#mk)"/></svg>');
    expect(skipped).toContain('marker');        // returns, does not hang
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/svg-marker.test.ts`
Expected: FAIL — `marker` is reported as an unsupported element and no `Do` is
emitted. Tasks 1-3 blocks still pass.

- [ ] **Step 3: Add `'marker'` to `DEFINITION` and a cycle guard**

In `src/svgdraw.ts`, line 62:

```ts
const DEFINITION = new Set([
  'clipPath', 'linearGradient', 'radialGradient', 'pattern', 'mask', 'marker',
]);
```

In `Emitter`, beside `activeMasks`:

```ts
  /** Marker ids currently being expanded, to break reference cycles — a marker
   *  whose own content carries the same marker. Mirrors activePatterns. */
  activeMarkers = new Set<string>();
  /** `${id}|${strokeWidth}` -> the marker form's ref. The stroke scale is baked
   *  into the placement, not the form, so one form serves every vertex of one
   *  element — but an element with a different stroke width needs its own. */
  markerForms = new Map<string, PdfObject>();
```

and in `child()`:

```ts
    c.activeMarkers = this.activeMarkers;
    c.markerForms = this.markerForms;
```

- [ ] **Step 4: Add `markerFormFor` and `paintMarkers`**

Insert after `paintShape`:

```ts
/** The Form XObject for one `<marker>`, built once per (marker, stroke width).
 *
 *  NOT a transparency group: a marker composites like any other content, so it
 *  needs none of groupForm's machinery. `/BBox` carries the overflow clip, which
 *  is why no `W n` is emitted inside.
 *
 *  Marker content does not inherit from the referencing element, so it walks from
 *  INITIAL — exactly as tilingFor does for a pattern tile. */
function markerFormFor(
  e: Emitter, node: XmlNode, spec: MarkerSpec, strokeWidth: number,
): PdfObject | null {
  const id = node.attrs.get('id') ?? '';
  if (id !== '' && e.activeMarkers.has(id)) return null;      // reference cycle
  const cacheKey = `${id}|${spec.scaleByStroke ? strokeWidth : 1}`;
  const hit = id === '' ? undefined : e.markerForms.get(cacheKey);
  if (hit !== undefined) return hit;

  const g = e.child();
  if (id !== '') g.activeMarkers.add(id);
  for (const c of node.children) walk(g, c, INITIAL, false, [...IDENTITY]);
  if (id !== '') g.activeMarkers.delete(id);
  if (g.out.length === 0) return null;

  const box = spec.clip ?? { x: 0, y: 0, w: spec.w, h: spec.h };
  const dict: PdfDict = new Map<string, PdfObject>([
    ['Type', name('XObject')],
    ['Subtype', name('Form')],
    ['FormType', 1],
    ['BBox', [box.x, box.y, box.x + box.w, box.y + box.h]],
    ['Matrix', [...IDENTITY]],
    ['Resources', buildResources(g)],
  ]);
  const r = e.streams.stream(dict, g.out.join('\n'));
  if (id !== '') e.markerForms.set(cacheKey, r);
  return r;
}

/** Paint the markers for one shape, after its own ink and in the same q/Q scope,
 *  so the element's transform applies and they sit above it. */
function paintMarkers(e: Emitter, segs: SvgSeg[], p: Paint, ctm: Matrix): void {
  if (p.markerStart === null && p.markerMid === null && p.markerEnd === null) return;
  if (segs.length === 0) return;

  const byKind = { start: p.markerStart, mid: p.markerMid, end: p.markerEnd };
  // Resolve each distinct id once, so a missing target is reported once.
  const forms = new Map<string, { spec: MarkerSpec; ref: PdfObject } | null>();
  const formFor = (id: string): { spec: MarkerSpec; ref: PdfObject } | null => {
    const seen = forms.get(id);
    if (seen !== undefined) return seen;
    let out: { spec: MarkerSpec; ref: PdfObject } | null = null;
    const node = e.ids.get(id);
    if (!node || node.name !== 'marker') {
      e.skipped.add('url()');
    } else {
      const spec = resolveMarker(node);
      const ref = spec ? markerFormFor(e, node, spec, p.strokeWidth) : null;
      if (spec && ref) out = { spec, ref };
      else e.skipped.add('marker');
    }
    forms.set(id, out);
    return out;
  };

  for (const v of markerVertices(segs)) {
    const id = byKind[v.kind];
    if (id === null) continue;
    const f = formFor(id);
    if (!f) continue;
    const m = markerMatrix(f.spec, v, p.strokeWidth);
    e.out.push('q');
    e.out.push(`${m.map(num).join(' ')} cm`);
    e.out.push(`/${e.xobjKey(f.ref)} Do`);
    e.out.push('Q');
    if (e.ctms) e.ctms.push(mul(m, ctm));
  }
}
```

Add the imports:

```ts
import {
  markerVertices, resolveMarker, markerMatrix, type MarkerSpec,
} from './svgmarker.js';
```

- [ ] **Step 5: Call it from the shape branch**

In `walk`'s `paintInto`, in the `SHAPES.has(n.name)` branch, after the
`paintShape(...)` call:

```ts
        // Markers apply to path, line, polyline and polygon only (SVG 1.1
        // §11.6.2) — never to rect, circle or ellipse, which have no vertices
        // an author can reason about.
        if (n.name === 'path' || n.name === 'line'
            || n.name === 'polyline' || n.name === 'polygon')
          paintMarkers(t, segs, paint, here);
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx vitest run test/svg-marker.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 7: Run the whole SVG suite for regressions**

Run: `npx vitest run test/svg-draw.test.ts test/svg-embed.test.ts test/svg-mask.test.ts test/svg-mask-render.test.ts test/svg-gradient.test.ts test/svg-pattern.test.ts test/svg-pattern-render.test.ts test/svg-text.test.ts test/svg-css.test.ts test/svg-style.test.ts test/svg-input-fixtures.test.ts`
Expected: PASS, unedited.

- [ ] **Step 8: Prove the wiring is load-bearing**

Temporarily change Step 5's guard to `if (n.name === 'path')`.
Run: `npx vitest run test/svg-marker.test.ts`
Expected: FAIL on "applies to line, polyline and polygon". Revert.

Then temporarily change `markerFormFor`'s walk to use `paint` instead of `INITIAL`
(you will need to pass it in).
Expected: FAIL on "does not inherit the referencing element's paint". Revert.

- [ ] **Step 9: Commit**

```bash
git add src/svgdraw.ts test/svg-marker.test.ts
git commit -m "$(cat <<'EOF'
feat(svg): paint marker-start/mid/end

The <marker> subtree becomes one Form XObject per (marker, stroke width),
Do'd once per vertex, so a 500-vertex polyline emits 500 short blocks
rather than 500 copies of the artwork. Markers paint after the path in the
same q/Q scope, so the element's transform applies and they sit above its
ink.

Applies to path/line/polyline/polygon only, per SVG 1.1 11.6.2. Marker
content walks from INITIAL: it does not inherit from the referencing
element, exactly as a pattern tile does not.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: End-to-end render tests

Everything so far checks our writer against our own reading of it. This checks it
through `raster.ts`, which resolves Form XObjects and their `/Matrix` and `/BBox`
with independent logic.

**Files:**
- Test: `test/svg-marker-render.test.ts` (create)

- [ ] **Step 1: Write the test**

Create `test/svg-marker-render.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { buildSvgPdf } from './helpers/build-svg-fixtures.js';
import { decodePng, type DecodedPng } from './helpers/decode-png.js';

const svg = (s: string) => new TextEncoder().encode(s);

/** Place `src` over a 200x200 page at 1 px per point, so an SVG unit in a
 *  200-unit viewBox is one device pixel and SVG y maps 1:1 onto device y.
 *
 *  raster.ts resolves a Form XObject's /Matrix and /BBox with its own logic, so
 *  these assertions do not round-trip through the code that produced them. */
function render(src: string) {
  const p = Document.Open(buildSvgPdf({ mediaBox: [0, 0, 200, 200], content: '' })).Pages[0];
  const r = p.AddSVGObject(svg(src), [0, 0, 200, 200], { fit: 'fill' });
  const rt = Document.Open(p.Document.Save());
  return { png: decodePng(rt.Pages[0].ToImage()), skipped: r.skipped };
}

const isBlue = (png: DecodedPng, x: number, y: number): boolean => {
  const [r, g, b] = png.at(x, y);
  return b > 200 && r < 80 && g < 80;
};

/** A 20x20 blue square, referenced at its centre. */
const SQUARE =
  '<defs><marker id="mk" markerWidth="20" markerHeight="20" refX="10" refY="10" ' +
  'markerUnits="userSpaceOnUse"><rect width="20" height="20" fill="#0000ff"/>' +
  '</marker></defs>';

/** A 20-wide right-pointing triangle, referenced at its tip. */
const ARROW =
  '<defs><marker id="mk" markerWidth="20" markerHeight="20" refX="20" refY="10" ' +
  'orient="auto" markerUnits="userSpaceOnUse">' +
  '<path d="M 0 0 L 20 10 L 0 20 Z" fill="#0000ff"/></marker></defs>';

describe('AddSVGObject — markers through Save/Open/ToImage', () => {
  it('centres a marker on each vertex', () => {
    const { png, skipped } = render(
      `<svg viewBox="0 0 200 200">${SQUARE}` +
      '<path d="M 50 100 L 150 100" stroke="#000000" marker="url(#mk)"/></svg>');
    expect(skipped).toEqual([]);
    expect(isBlue(png, 50, 100)).toBe(true);      // start
    expect(isBlue(png, 150, 100)).toBe(true);     // end
    expect(isBlue(png, 100, 100)).toBe(false);    // no mid vertex on a 2-point path
  });

  it('paints a mid marker at the interior vertex only', () => {
    const { png } = render(
      `<svg viewBox="0 0 200 200">${SQUARE}` +
      '<path d="M 20 100 L 100 100 L 180 100" stroke="#000000" marker-mid="url(#mk)"/></svg>');
    expect(isBlue(png, 100, 100)).toBe(true);
    expect(isBlue(png, 20, 100)).toBe(false);
    expect(isBlue(png, 180, 100)).toBe(false);
  });

  it('rotates to the tangent under orient="auto"', () => {
    // The arrow's tip is its reference point and sits on the end vertex; its
    // body trails BACK along the path. On a leftward path the body is to the
    // RIGHT of the tip.
    const { png, skipped } = render(
      `<svg viewBox="0 0 200 200">${ARROW}` +
      '<path d="M 150 100 L 50 100" stroke="#000000" marker-end="url(#mk)"/></svg>');
    expect(skipped).toEqual([]);
    expect(isBlue(png, 60, 100)).toBe(true);      // body, trailing to the right
    expect(isBlue(png, 40, 100)).toBe(false);     // nothing past the tip
  });

  it('reverses the start marker under auto-start-reverse', () => {
    const { png } = render(
      `<svg viewBox="0 0 200 200">${ARROW.replace('orient="auto"', 'orient="auto-start-reverse"')}` +
      '<path d="M 100 100 L 180 100" stroke="#000000" marker-start="url(#mk)"/></svg>');
    // Reversed, the arrow points back down the path, so its body is to the RIGHT
    // of the vertex. Without the reversal it would be to the left.
    expect(isBlue(png, 110, 100)).toBe(true);
    expect(isBlue(png, 90, 100)).toBe(false);
  });

  it('scales the marker by stroke-width under the default markerUnits', () => {
    // markerWidth 4 at stroke-width 10 covers 40 units; at stroke-width 1 it
    // would cover 4 and miss the sample point entirely.
    const { png } = render(
      '<svg viewBox="0 0 200 200"><defs>' +
      '<marker id="mk" markerWidth="4" markerHeight="4" refX="2" refY="2">' +
      '<rect width="4" height="4" fill="#0000ff"/></marker></defs>' +
      '<path d="M 100 100 L 180 100" stroke="#000000" stroke-width="10" ' +
      'marker-start="url(#mk)"/></svg>');
    expect(isBlue(png, 115, 100)).toBe(true);
  });

  it('maps content through the marker viewBox', () => {
    // A 10x10 viewBox into a 40x40 viewport scales 4x: the 5x5 rect covers 20x20
    // device units from the reference point.
    const { png, skipped } = render(
      '<svg viewBox="0 0 200 200"><defs>' +
      '<marker id="mk" viewBox="0 0 10 10" markerWidth="40" markerHeight="40" ' +
      'refX="0" refY="0" markerUnits="userSpaceOnUse">' +
      '<rect width="5" height="5" fill="#0000ff"/></marker></defs>' +
      '<path d="M 50 50 L 150 50" stroke="#000000" marker-start="url(#mk)"/></svg>');
    expect(skipped).toEqual([]);
    expect(isBlue(png, 65, 65)).toBe(true);       // inside the scaled 20x20
    expect(isBlue(png, 85, 85)).toBe(false);      // past it
  });

  it('clips content to the viewport by default', () => {
    // The rect is twice the viewport; overflow defaults to hidden, so the
    // overspill must not paint.
    const { png } = render(
      '<svg viewBox="0 0 200 200"><defs>' +
      '<marker id="mk" markerWidth="20" markerHeight="20" refX="0" refY="0" ' +
      'markerUnits="userSpaceOnUse"><rect width="40" height="40" fill="#0000ff"/>' +
      '</marker></defs>' +
      '<path d="M 50 50 L 150 50" stroke="#000000" marker-start="url(#mk)"/></svg>');
    expect(isBlue(png, 60, 60)).toBe(true);       // inside the 20x20 viewport
    expect(isBlue(png, 80, 80)).toBe(false);      // clipped away
  });

  it('lets overflow visible paint outside the viewport', () => {
    const { png } = render(
      '<svg viewBox="0 0 200 200"><defs>' +
      '<marker id="mk" markerWidth="20" markerHeight="20" refX="0" refY="0" ' +
      'overflow="visible" markerUnits="userSpaceOnUse">' +
      '<rect width="40" height="40" fill="#0000ff"/></marker></defs>' +
      '<path d="M 50 50 L 150 50" stroke="#000000" marker-start="url(#mk)"/></svg>');
    expect(isBlue(png, 80, 80)).toBe(true);
  });

  it('follows the element transform', () => {
    const { png } = render(
      `<svg viewBox="0 0 200 200">${SQUARE}` +
      '<g transform="translate(0,60)">' +
      '<path d="M 50 40 L 150 40" stroke="#000000" marker-start="url(#mk)"/></g></svg>');
    expect(isBlue(png, 50, 100)).toBe(true);
    expect(isBlue(png, 50, 40)).toBe(false);
  });

  it('marks every vertex of a closed polygon', () => {
    const { png, skipped } = render(
      `<svg viewBox="0 0 200 200">${SQUARE}` +
      '<polygon points="50,50 150,50 150,150" fill="none" stroke="#000000" ' +
      'marker="url(#mk)"/></svg>');
    expect(skipped).toEqual([]);
    for (const [x, y] of [[50, 50], [150, 50], [150, 150]])
      expect(isBlue(png, x, y)).toBe(true);
  });
});
```

- [ ] **Step 2: Run the test**

Run: `npx vitest run test/svg-marker-render.test.ts`
Expected: PASS. Any failure is a real bug in Task 5's wiring or Task 3's matrix —
debug rather than adjusting the expected pixel.

- [ ] **Step 3: Prove the render assertions are load-bearing**

Temporarily drop the `cm` line from `paintMarkers`, so every marker lands at the
origin.
Run: `npx vitest run test/svg-marker-render.test.ts`
Expected: FAIL on most cases, including "centres a marker on each vertex".
Revert and re-run to green.

Then temporarily force `spec.clip` to `null` in `markerFormFor`'s `box`.
Expected: FAIL on "clips content to the viewport by default". Revert.

- [ ] **Step 4: Run the full suite**

Run: `npm run typecheck && npm test`
Expected: all green.

- [ ] **Step 5: Commit**

```bash
git add test/svg-marker-render.test.ts
git commit -m "$(cat <<'EOF'
test(svg): render marker fixtures through Save/Open/ToImage

raster.ts resolves a Form XObject's /Matrix and /BBox with its own logic,
so these assertions do not round-trip through the code that produced them.
Covers vertex placement, mid-only vertices, orient auto and
auto-start-reverse, the stroke-width scale, the marker viewBox, the
overflow clip and its opt-out, the element transform, and a closed polygon.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 7: README and close-out

**Files:**
- Modify: `README.md` — the SVG embedding bullet

- [ ] **Step 1: Add a markers sentence in the bullet's voice**

After the masks sentence phase 1 added:

```markdown
**Markers** — `marker-start`, `marker-mid`, `marker-end` and the `marker`
shorthand on `path`, `line`, `polyline` and `polygon`, drawn as a shared Form
XObject placed at each vertex. `markerWidth`/`markerHeight`, `refX`/`refY` (in
viewBox coordinates), `markerUnits` (`strokeWidth` and `userSpaceOnUse`), the
marker's own `viewBox`/`preserveAspectRatio`, `overflow`, and `orient` (`auto`,
`auto-start-reverse`, or a fixed angle) are all handled; mid-vertex angles bisect
the adjoining tangents.
```

- [ ] **Step 2: Verify no stale claim remains**

Run: `grep -n -i "marker" README.md`
Expected: nothing saying markers are unsupported.

- [ ] **Step 3: Commit, close the issue, push**

```bash
git add README.md
git commit -m "$(cat <<'EOF'
docs: README covers SVG markers

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"

bd close <phase-2-id>
bd remember --key svg-marker-shipped "1gg0.10 phase 2. src/svgmarker.ts is pure: markerVertices(segs) -> {x,y,angle,kind} and resolveMarker/markerMatrix. kind is positional over the WHOLE path (SVG 1.1 11.6.2) -- one start per path, not per subpath. Mid angles bisect via the unit-vector SUM, never the mean of two angles (discontinuous across +-180, aims the marker backwards at an obtuse corner); a perfect reversal falls back to the incoming tangent. Cubic tangents fall through degenerate control legs; Z appends the subpath start as a vertex and wraps its outgoing tangent to the subpath's opener. refX/refY are VIEWBOX coordinates, mapped through the fit INCLUDING its translation, and the ref translate composes BEFORE the rotation so the marker turns about its reference point. One Form XObject per (marker id, stroke width) Do'd per vertex; markers paint after the path in the same q/Q scope; content walks from INITIAL (no inheritance from the referencing element), like a pattern tile. viewBoxFitDown was extracted to svgtransform.ts from tileMatrix's inline flip-negation."

git pull --rebase && git push && git status
```

Expected: suite green, `git status` up to date with `origin`. Per CLAUDE.md the
work is not complete until `push` succeeds.

---

## Self-Review

**Spec coverage.** Every claim in the spec's "2. Markers" section maps to a task:
the four applicable elements and both property spellings → Task 4 and Task 5;
`markerWidth`/`markerHeight`/`refX`/`refY`/`markerUnits`/`orient`/`viewBox`/`overflow`
→ Task 3; vertex kinds, bisectors, degenerate legs, zero-length segments, `Z` wrap
→ Task 2; the placement matrix and its ordering → Task 3; one form per (marker,
element) and the `Do` per vertex → Task 5; no inheritance from the referencing
element → Task 5; reporting `url()` for a missing target → Task 5; README → Task 7.

**Type consistency.** `MarkerVertex` and `MarkerSpec` are defined in Task 2 and
Task 3 and consumed under those exact names in Task 5. `Paint.markerStart` /
`markerMid` / `markerEnd` are defined in Task 4 and read in Task 5.
`viewBoxFitDown` is defined in Task 1 and consumed in Task 3.

**Plan-level addition beyond the spec:** `viewBoxFitDown` (Task 1). The spec says
markers take the standard viewport mapping but does not say where it comes from;
`tileMatrix` already had the y-down derivation inline, and a second copy of a
subtle negation was the wrong answer.

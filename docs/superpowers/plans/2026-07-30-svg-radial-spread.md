# SVG radial `reflect` / `repeat` spread Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Render `spreadMethod="reflect"` and `"repeat"` on a `radialGradient`
exactly, instead of falling back to `pad` and naming the element in
`result.skipped`.

**Architecture:** PDF extends a ShadingType 3 by interpolating both centre and
radius linearly, which is exactly SVG's radial model. So one shading suffices:
push the outer circle out to parameter `k` and pack `k` copies of the ramp into
its function. No stitched rings and no tiling pattern. The only new code computes
`k` — the smallest integer whose circle covers the shape's bbox — by solving, for
each bbox corner, the quadratic that gives its gradient parameter `t`.

**Tech Stack:** TypeScript (ESM, NodeNext, `strict`), vitest. Zero runtime
dependencies — `node:` built-ins only.

**Spec:** `docs/superpowers/specs/2026-07-30-svg-radial-spread-design.md`.
**Issue:** `aspose-pdf-foss-for-ts-1gg0.18` (epic `1gg0`).

## Global Constraints

- **Zero runtime dependencies.** Only `node:` built-ins. Do not add npm runtime deps.
- **ESM + NodeNext.** Every relative import specifier carries the `.js` extension.
- **`svggradient.ts` allocates nothing.** It imports no `Document` and builds only
  direct `PdfDict`s. Nothing in this plan changes that.
- **TDD.** Write the failing test, watch it fail, then implement.
- **Both gates must be green before a task is done:** `npm run typecheck` and
  `npm test`.
- **Task tracking is `bd`, never TodoWrite or markdown TODO lists.**
- Commit after every task. Do not push until the end (Task 6).
- **The repetition cap is 64**, shared with the linear path. Exceeding it degrades
  to `pad` and is **not** reported — the precedent the linear path set.

## File Structure

| File | Change | Responsibility |
|---|---|---|
| `src/svggradient.ts` | modify | `gradientSpaceCorners` helper, `radialSpreadRange`, the radial branch of `gradientPaint` |
| `test/svg-gradient.test.ts` | modify | Unit tests for the range function and the radial spread mapping |
| `test/svg-draw.test.ts` | modify | The stale "reports a radial reflect spread" expectation |
| `test/svg-gradient-render.test.ts` | modify | End-to-end `ToImage` ring checks |
| `README.md` | modify | Drop the last gradient limitation |

No new files. Everything extends a module that already owns the concern.

---

### Task 1: Extract `gradientSpaceCorners`

`spreadRange` opens by rejecting a null box, inverting `m`, and mapping the four
corners. `radialSpreadRange` needs exactly that preamble. Extract it first, as a
pure refactor with no behaviour change, so the shared CTM-cancellation reasoning
is written once.

**Files:**
- Modify: `src/svggradient.ts` — the `spreadRange` function and its doc comment
- Test: `test/svg-gradient.test.ts` (existing `describe('spreadRange', …)` is the
  characterization suite; no new tests)

**Interfaces:**
- Consumes: nothing new.
- Produces: module-private
  `gradientSpaceCorners(m: Matrix, bbox: SegBBox | null): [number, number][] | null`
  — the box's four corners in gradient space, or `null` when the box is absent or
  `m` is singular. `spreadRange` keeps its exact public signature
  `(p1, p2, m, bbox, cap?) => [number, number] | null`.

- [ ] **Step 1: Confirm the existing suite is the safety net**

Run: `npx vitest run test/svg-gradient.test.ts -t 'spreadRange'`
Expected: PASS (5 tests). These already cover the inverse projection, the
singular matrix, the null box, and the cap — everything the extracted helper is
responsible for. That is the characterization suite for this refactor; do not add
new tests here.

- [ ] **Step 2: Extract the helper**

In `src/svggradient.ts`, add immediately above `spreadRange`:

```ts
/** The bbox's four corners mapped into gradient space, or null when the box is
 *  absent or `m` is singular.
 *
 *  `m` is mul(gradientTransform, bboxMatrix) — WITHOUT the element CTM. The box
 *  is in element user space and the pattern /Matrix carries the same CTM factor,
 *  so the CTM cancels out of the projection. That cancellation is shared by both
 *  spread ranges, and it is the check that the /Matrix composition is right. */
function gradientSpaceCorners(m: Matrix, bbox: SegBBox | null): [number, number][] | null {
  if (!bbox) return null;
  let inv: Matrix;
  try { inv = invert(m); } catch { return null; }
  return ([
    [bbox.x, bbox.y], [bbox.x + bbox.w, bbox.y],
    [bbox.x, bbox.y + bbox.h], [bbox.x + bbox.w, bbox.y + bbox.h],
  ] as [number, number][]).map(([cx, cy]) => apply(inv, cx, cy));
}
```

- [ ] **Step 3: Rewrite `spreadRange` over it**

Replace the whole existing `spreadRange` (doc comment included) with:

```ts
/** The integer repetition range [k0, k1] a linear gradient's axis must span to
 *  cover `bbox`, in gradient space. The corners are projected onto the axis; see
 *  gradientSpaceCorners for why `m` carries no element CTM.
 *
 *  Returns null when the range cannot be computed or exceeds `cap` repetitions,
 *  in which case the caller falls back to pad rather than inflating the stream. */
export function spreadRange(
  p1: [number, number], p2: [number, number], m: Matrix, bbox: SegBBox | null,
  cap = 64,
): [number, number] | null {
  const corners = gradientSpaceCorners(m, bbox);
  if (!corners) return null;
  const dx = p2[0] - p1[0], dy = p2[1] - p1[1];
  const len2 = dx * dx + dy * dy;
  if (!(len2 > 0)) return null;
  let lo = Infinity, hi = -Infinity;
  for (const [gx, gy] of corners) {
    const t = ((gx - p1[0]) * dx + (gy - p1[1]) * dy) / len2;
    if (!Number.isFinite(t)) return null;
    if (t < lo) lo = t;
    if (t > hi) hi = t;
  }
  const k0 = Math.floor(lo);
  const k1 = Math.max(Math.ceil(hi), k0 + 1);
  if (k1 - k0 > cap) return null;
  return [k0, k1];
}
```

- [ ] **Step 4: Run the gates**

Run: `npx vitest run test/svg-gradient.test.ts` → PASS.
Run: `npm run typecheck` → clean.
Run: `npm test` → fully green. The `svg-golden` and `svg-input-fixtures` suites
compare whole content streams and are the real proof this changed no output.

- [ ] **Step 5: Commit**

```bash
git add src/svggradient.ts
git commit -m "refactor(svg): share the gradient-space corner projection (1gg0.18)"
```

---

### Task 2: `radialSpreadRange`

The one piece of genuinely new logic, and pure, so it is tested in isolation.

**Files:**
- Modify: `src/svggradient.ts` — new export beside `spreadRange`
- Test: `test/svg-gradient.test.ts` — a new `describe` block after the existing
  `describe('spreadRange', …)`

**Interfaces:**
- Consumes: `gradientSpaceCorners(m, bbox)` (Task 1).
- Produces:
  ```ts
  export function radialSpreadRange(
    f: [number, number], c: [number, number], r: number,
    m: Matrix, bbox: SegBBox | null, cap?: number,
  ): number | null
  ```
  A single `k ≥ 1`, not a `[k0, k1]` pair, because `k0` is always 0 for a radial
  gradient. `cap` defaults to 64. `null` means the caller keeps un-tiled coords,
  i.e. pad.

- [ ] **Step 1: Write the failing tests**

Add to `test/svg-gradient.test.ts`, immediately after the closing `});` of
`describe('spreadRange', …)`:

```ts
describe('radialSpreadRange', () => {
  const M: Matrix = [...IDENTITY];

  /** Does the circle at parameter `k` contain every corner of `b`?
   *
   *  Plain distance arithmetic, deliberately NOT the quadratic the function
   *  under test solves: a differential test cannot validate the interpreter it
   *  runs through (CLAUDE.md). This checks the PROPERTY k must have. */
  const coversAt = (
    k: number, f: [number, number], c: [number, number], r: number, b: SegBBox,
  ): boolean => {
    const cx = f[0] + k * (c[0] - f[0]);
    const cy = f[1] + k * (c[1] - f[1]);
    const R = k * r;
    return ([
      [b.x, b.y], [b.x + b.w, b.y], [b.x, b.y + b.h], [b.x + b.w, b.y + b.h],
    ] as [number, number][]).every(([px, py]) => Math.hypot(px - cx, py - cy) <= R + 1e-9);
  };

  it('matches ceil(L / r) when the focus is centred', () => {
    // Corners of a 30x40 box from the origin: the far one is at 50.
    expect(radialSpreadRange([0, 0], [0, 0], 10, M, { x: 0, y: 0, w: 30, h: 40 })).toBe(5);
  });

  it('returns the tightest covering k with an eccentric focus', () => {
    const f: [number, number] = [2, 0];
    const c: [number, number] = [0, 0];
    const b: SegBBox = { x: 0, y: 0, w: 30, h: 40 };
    const k = radialSpreadRange(f, c, 10, M, b)!;
    expect(k).not.toBeNull();
    expect(coversAt(k, f, c, 10, b)).toBe(true);
    // Tightness: without this, a function that always returned the cap passes.
    expect(coversAt(k - 1, f, c, 10, b)).toBe(false);
  });

  it('never returns zero, even for a box at the focal point', () => {
    expect(radialSpreadRange([0, 0], [0, 0], 10, M, { x: 0, y: 0, w: 0, h: 0 })).toBe(1);
  });

  it('projects through the inverse of the matrix', () => {
    // The obb map [10 0 0 10 0 0] puts a 0..10 box back on the unit square, whose
    // corners sit sqrt(0.5) = 0.7071 from the centre; over r = 0.5 that is 1.414.
    expect(radialSpreadRange([0.5, 0.5], [0.5, 0.5], 0.5, [10, 0, 0, 10, 0, 0],
      { x: 0, y: 0, w: 10, h: 10 })).toBe(2);
  });

  it('returns null past the cap, for a singular matrix, and with no box', () => {
    expect(radialSpreadRange([0, 0], [0, 0], 1, M, { x: 0, y: 0, w: 1000, h: 1000 }, 64))
      .toBeNull();
    expect(radialSpreadRange([0, 0], [0, 0], 1, [0, 0, 0, 0, 0, 0], { x: 0, y: 0, w: 1, h: 1 }))
      .toBeNull();
    expect(radialSpreadRange([0, 0], [0, 0], 1, M, null)).toBeNull();
  });

  it('returns null when the focus is not strictly inside the circle', () => {
    // gradientPaint's 0.999 clamp prevents this, but the guard keeps the
    // function total: with |d| >= r the quadratic's leading term is not negative
    // and the root analysis does not hold.
    expect(radialSpreadRange([20, 0], [0, 0], 10, M, { x: 0, y: 0, w: 1, h: 1 })).toBeNull();
  });
});
```

Extend the import at the top of the file to pull in `radialSpreadRange`:

```ts
import {
  resolveGradient, normalizeStops, stopsFunction, gradientPaint, spreadRange, tileStops,
  radialSpreadRange, ALPHA, type GradientStop,
} from '../src/svggradient.js';
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/svg-gradient.test.ts -t 'radialSpreadRange'`
Expected: FAIL — `radialSpreadRange is not a function`.

- [ ] **Step 3: Implement**

In `src/svggradient.ts`, add immediately after `spreadRange`:

```ts
/** The number of ramp repetitions `k` a radial gradient needs to cover `bbox`.
 *
 *  Unlike the linear case there is no lower bound to compute: r(t) = t*r is only
 *  meaningful for t >= 0, and SVG's spread applies outward from t = 1, so the
 *  range is always [0, k].
 *
 *  For each corner p, the parameter t whose circle passes through it solves
 *      t^2*(|d|^2 - r^2) - 2t*(d . (p - f)) + |p - f|^2 = 0,   d = c - f
 *  and the expression below is ALWAYS its non-negative root: disc = b^2 - 4ag
 *  is >= b^2 because -4ag >= 0, so sqrt(disc) >= |b| makes the numerator <= 0
 *  while the denominator is < 0. No root selection, and no branch to get wrong.
 *
 *  Four corners suffice: with the focus strictly inside the circle the family
 *  t -> (f + t*d, t*r) is strictly nested and expanding, so t(p)'s level sets are
 *  nested convex curves and the maximum over a convex polygon sits at a vertex.
 *
 *  Returns null when the range cannot be computed or exceeds `cap`, in which case
 *  the caller falls back to pad rather than inflating the stream. */
export function radialSpreadRange(
  f: [number, number], c: [number, number], r: number,
  m: Matrix, bbox: SegBBox | null, cap = 64,
): number | null {
  const corners = gradientSpaceCorners(m, bbox);
  if (!corners || !(r > 0)) return null;
  const dx = c[0] - f[0], dy = c[1] - f[1];
  const a = dx * dx + dy * dy - r * r;
  // The focus must be strictly inside the circle. gradientPaint's 0.999 clamp
  // guarantees it; the guard keeps this function total for any other caller.
  if (!(a < 0)) return null;
  let hi = 0;
  for (const [px, py] of corners) {
    const ex = px - f[0], ey = py - f[1];
    const b = -2 * (dx * ex + dy * ey);
    const g = ex * ex + ey * ey;
    const disc = b * b - 4 * a * g;
    if (!(disc >= 0)) return null;
    const t = (-b - Math.sqrt(disc)) / (2 * a);
    if (!Number.isFinite(t)) return null;
    if (t > hi) hi = t;
  }
  const k = Math.max(1, Math.ceil(hi));
  return k > cap ? null : k;
}
```

- [ ] **Step 4: Run the gates**

Run: `npx vitest run test/svg-gradient.test.ts` → PASS.
Run: `npm run typecheck` → clean.

- [ ] **Step 5: Commit**

```bash
git add src/svggradient.ts test/svg-gradient.test.ts
git commit -m "feat(svg): compute a radial gradient's repetition range (1gg0.18)"
```

---

### Task 3: Tile the radial shading

**Files:**
- Modify: `src/svggradient.ts` — the radial branch of `gradientPaint`
- Test: `test/svg-gradient.test.ts` — the `describe('gradientPaint — spreadMethod', …)` block
- Test: `test/svg-draw.test.ts` — the stale `'reports a radial reflect spread'` test

**Interfaces:**
- Consumes: `radialSpreadRange` (Task 2), plus `tileStops` and `pair` already in
  the module.
- Produces: no signature changes. `gradientPaint` on a radial gradient now
  returns `report: false` unconditionally, and its `/Coords` are scaled by `k`
  when a spread is requested.

- [ ] **Step 1: Write the failing tests**

In `test/svg-gradient.test.ts`, **replace** the test
`'reports a radial reflect/repeat and pads it'` inside
`describe('gradientPaint — spreadMethod', …)` with these six:

```ts
  it('extends the radial coords over the repetition range for repeat', () => {
    // Default obb radial: f = c = (0.5, 0.5), r = 0.5. The unit box's corners sit
    // at sqrt(0.5) = 0.7071, so t = 1.414 and k = 2 — outer radius 2 * 0.5 = 1.
    const p = paint(`<svg><radialGradient id="g" spreadMethod="repeat">${TWO}` +
      '</radialGradient></svg>', 'g');
    expect(p.report).toBe(false);
    const sh = shading(p);
    expect(sh.get('Coords')).toEqual([0.5, 0.5, 0, 0.5, 0.5, 1]);
    expect((sh.get('Function') as PdfDict).get('Bounds')).toEqual([0.5]);
    expect(sh.get('Extend')).toEqual([true, true]);
  });

  it('mirrors alternate radial copies for reflect', () => {
    const p = paint(`<svg><radialGradient id="g" spreadMethod="reflect">${TWO}` +
      '</radialGradient></svg>', 'g');
    const subs = ((shading(p).get('Function')) as PdfDict).get('Functions') as PdfDict[];
    expect(subs).toHaveLength(2);
    expect(subs[0].get('C0')).toEqual([1, 0, 0]);
    expect(subs[0].get('C1')).toEqual([0, 0, 1]);
    expect(subs[1].get('C0')).toEqual([0, 0, 1]);   // mirrored
    expect(subs[1].get('C1')).toEqual([1, 0, 0]);
  });

  it('scales an eccentric focal radial about the focus, not the centre', () => {
    // f = (2,0), c = (0,0), r = 10 over a 30x40 box gives k = 6: the inner circle
    // stays the focus at radius 0 and the outer moves to f + 6d = (-10, 0), r 60.
    const p = paint('<svg><radialGradient id="g" gradientUnits="userSpaceOnUse" ' +
      `cx="0" cy="0" r="10" fx="2" fy="0" spreadMethod="repeat">${TWO}` +
      '</radialGradient></svg>', 'g', { x: 0, y: 0, w: 30, h: 40 });
    expect(shading(p).get('Coords')).toEqual([2, 0, 0, -10, 0, 60]);
  });

  it('leaves a radial pad alone', () => {
    const p = paint(`<svg><radialGradient id="g" spreadMethod="pad">${TWO}` +
      '</radialGradient></svg>', 'g');
    expect(shading(p).get('Coords')).toEqual([0.5, 0.5, 0, 0.5, 0.5, 0.5]);
  });

  it('degrades a radial repeat to pad past the cap, without reporting', () => {
    const p = paint('<svg><radialGradient id="g" gradientUnits="userSpaceOnUse" ' +
      `cx="0" cy="0" r="1" spreadMethod="repeat">${TWO}</radialGradient></svg>`,
      'g', { x: 0, y: 0, w: 1000, h: 1000 });
    expect(shading(p).get('Coords')).toEqual([0, 0, 0, 0, 0, 1]);
    expect(p.report).toBe(false);
  });

  it('gives the alpha twin the same tiled radial coords and function', () => {
    const p = paint('<svg><radialGradient id="g" spreadMethod="repeat">' +
      '<stop offset="0" stop-color="red" stop-opacity="0"/>' +
      '<stop offset="1" stop-color="blue" stop-opacity="1"/></radialGradient></svg>', 'g');
    if (p.kind !== 'pattern' || p.alphaPattern === null) throw new Error('expected an alpha twin');
    const a = p.alphaPattern.get('Shading') as PdfDict;
    expect(a.get('Coords')).toEqual(shading(p).get('Coords'));
    expect((a.get('Function') as PdfDict).get('Bounds'))
      .toEqual((shading(p).get('Function') as PdfDict).get('Bounds'));
  });

  it('cancels the element CTM out of the radial range computation', () => {
    const svg = '<svg><radialGradient id="g" gradientUnits="userSpaceOnUse" ' +
      `cx="0" cy="0" r="10" spreadMethod="repeat">${TWO}</radialGradient></svg>`;
    const box = { x: 0, y: 0, w: 30, h: 40 };
    const a = shading(paint(svg, 'g', box));
    const b = shading(paint(svg, 'g', box, [3, 0, 0, 3, 7, 7]));
    expect(b.get('Coords')).toEqual(a.get('Coords'));
  });
```

In `test/svg-draw.test.ts`, **replace** the test `'reports a radial reflect spread'`
(in `describe('drawSvg — gradients', …)`) with:

```ts
  it('no longer reports a radial reflect spread', () => {
    expect(draw('<svg><defs><radialGradient id="g" spreadMethod="reflect">' +
      '<stop offset="0" stop-color="red"/><stop offset="1" stop-color="blue"/>' +
      '</radialGradient></defs><rect width="10" height="10" fill="url(#g)"/></svg>')
      .skipped).toEqual([]);
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/svg-gradient.test.ts test/svg-draw.test.ts`
Expected: FAIL — the radial coords are still un-tiled and `report` is still true
for a radial spread.

- [ ] **Step 3: Implement**

In `src/svggradient.ts`, in `gradientPaint`'s radial branch, replace the block
that currently begins `const spread = g.attrs.get('spreadMethod');` and ends with
the `return { kind: 'pattern', ... }` — that is everything after the focal-point
clamp — with:

```ts
    // AFTER the 0.999 focal clamp above, which is what guarantees |d| < r and so
    // makes the range math below valid.
    const spread = g.attrs.get('spreadMethod');
    let coords = [fx, fy, 0, cx, cy, r];
    let fnStops = stops;
    if (spread === 'reflect' || spread === 'repeat') {
      // PDF interpolates a ShadingType 3's centre AND radius linearly, exactly
      // as SVG's radial model does, so pushing the outer circle out to parameter
      // k and packing k ramp copies into the function IS the tiled gradient.
      // No stitched rings and no tiling pattern needed. k0 is always 0.
      const k = radialSpreadRange([fx, fy], [cx, cy], r,
        mul(gt, bboxMatrix(obb, bbox)), bbox);
      if (k !== null) {
        coords = [fx, fy, 0, fx + k * (cx - fx), fy + k * (cy - fy), k * r];
        fnStops = tileStops(stops, 0, k, spread === 'reflect');
      }
      // k === null: over the cap or uncomputable. /Extend [true true] pads, a
      // visible but bounded degradation — the same call the linear path makes.
    }
    return {
      kind: 'pattern',
      ...pair([['ShadingType', 3], ['Coords', coords]], fnStops),
      opacity,
      report: false,
    };
  }
```

- [ ] **Step 4: Run the gates**

Run: `npx vitest run test/svg-gradient.test.ts test/svg-draw.test.ts` → PASS.
Run: `npm run typecheck` → clean.
Run: `npm test` → fully green.

- [ ] **Step 5: Commit**

```bash
git add src/svggradient.ts test/svg-gradient.test.ts test/svg-draw.test.ts
git commit -m "feat(svg): tile a radial gradient for reflect/repeat (1gg0.18)"
```

---

### Task 4: End-to-end rings through `ToImage`

`raster.ts` is an independently written *reader* of shadings, so this is a real
cross-implementation check rather than a round trip through one body of code.

**Files:**
- Modify: `test/svg-gradient-render.test.ts` — append to the existing
  `describe('AddSVGObject — gradients through Save/Open/ToImage', …)` block

**Interfaces:**
- Consumes: the whole feature, through the public `page.AddSVGObject`.
- Produces: nothing. `render(src, content?)` and `near(v, target, tol?)` already
  exist at the top of that file.

- [ ] **Step 1: Write the test**

Append inside the first describe block (before its closing `});`):

```ts
  it('repeats a radial gradient outward in rings', () => {
    // userSpaceOnUse r = 12.5 over a 100-unit viewBox rendered at 2x, so a ring
    // is 25 device px. Sampling the centre row means the y flip cannot confuse
    // the reading: device (x, 100) is viewBox (x/2, 50), the gradient's centre row.
    // k works out to 6, which the 257-entry LUT in raster.ts resolves comfortably.
    const { png, skipped } = render(
      '<svg viewBox="0 0 100 100"><defs>' +
      '<radialGradient id="g" gradientUnits="userSpaceOnUse" spreadMethod="repeat" ' +
      'cx="50" cy="50" r="12.5">' +
      '<stop offset="0" stop-color="#f00"/><stop offset="1" stop-color="#00f"/>' +
      '</radialGradient></defs>' +
      '<rect width="100" height="100" fill="url(#g)"/></svg>');
    expect(skipped).toEqual([]);
    expect(png.at(100, 100)[0]).toBeGreaterThan(215);    // centre: red
    expect(png.at(124, 100)[2]).toBeGreaterThan(200);    // ring 0 end: blue
    expect(png.at(128, 100)[0]).toBeGreaterThan(200);    // ring 1 start: red again
    expect(png.at(152, 100)[0]).toBeGreaterThan(200);    // ring 2 start: red again
  });
```

- [ ] **Step 2: Run it**

Run: `npx vitest run test/svg-gradient-render.test.ts`
Expected: PASS. If the *ring-start* samples fail, that is a real bug — debug it,
do not loosen the thresholds. If only the ring-*end* sample is marginal, the
sample sits too close to a seam; move it one or two device pixels inward rather
than lowering the threshold.

- [ ] **Step 3: Prove the assertions are load-bearing**

Two mutations. Each must turn this test RED. Apply, run, confirm, revert.

1. **Scale the coords but not the function** — in `src/svggradient.ts`, change
   `fnStops = tileStops(stops, 0, k, spread === 'reflect');` to
   `fnStops = tileStops(stops, 0, 1, spread === 'reflect');`. One ramp then
   stretches over all six rings, so the `ring 0 end: blue` sample reads red.
2. **Tile the function but not the coords** — comment out the `coords = [...]`
   assignment inside the `if (k !== null)` block. The six packed copies then
   compress into the first ring and everything past it pads, so the
   `ring 1 start: red again` sample reads blue.

**Do not** use "`k0 = 1` instead of 0" as a mutation here, even though the spec
lists it: `tileStops` reads `k0` only for `reflect`'s parity, so under `repeat` it
changes nothing and the mutation would look falsely unnecessary. `reflect`'s
parity is pinned by the unit test `'mirrors alternate radial copies for reflect'`
in Task 3 — verify that one by flipping `spread === 'reflect'` to `false` in the
`tileStops` call and confirming it goes red.

- [ ] **Step 4: Run the full gates**

Run: `npm test` → green.
Run: `npm run typecheck` → clean.

- [ ] **Step 5: Commit**

```bash
git add test/svg-gradient-render.test.ts
git commit -m "test(svg): check radial ring repetition against the rasterizer (1gg0.18)"
```

---

### Task 5: Documentation

**Files:**
- Modify: `README.md:19` (two separate sentences in the same bullet)

**Interfaces:** none.

- [ ] **Step 1: Update the `spreadMethod` parenthetical**

Find, in the SVG embedding bullet:

> `spreadMethod` (`pad` everywhere, `reflect`/`repeat` on linear gradients)

Replace with:

> `spreadMethod` (`pad`, `reflect` and `repeat`, on linear and radial gradients alike)

- [ ] **Step 2: Remove the last gradient limitation**

In the same bullet, find the sentence 1gg0.17 left:

> One gradient limitation remains: `reflect`/`repeat` on a **radial** gradient falls back to `pad` and names the gradient element in `result.skipped`.

Delete that sentence entirely. Do **not** delete the sentence that follows it
about fill/stroke mask splitting — that limitation still stands.

- [ ] **Step 3: Check nothing else repeats the old claim**

Run: `grep -n "on linear gradients\|falls back to \`pad\`\|radialGradient" README.md`
Expected: no remaining claim that radial spread is unsupported. If the API
overview table near line 1376 mentions it, update it the same way.

- [ ] **Step 4: Commit**

```bash
git add README.md
git commit -m "docs(svg): radial gradients honour reflect and repeat (1gg0.18)"
```

---

### Task 6: Close the issue and push

Per `CLAUDE.md`, work is not complete until `git push` succeeds. Per the stored
`beads-dolt-push-required` memory, `git push` does **not** carry tracker state —
`bd dolt push` is a separate, mandatory step.

**Files:** none (bd state and git remote).

- [ ] **Step 1: Confirm both gates one final time**

```bash
npm run typecheck
npm test
```

Both must be green. Do not proceed otherwise.

- [ ] **Step 2: Record what shipped**

```bash
bd remember --key svg-radial-spread-shipped "svg-radial-spread-shipped (1gg0.18): radial reflect/repeat is exact; radialGradient no longer appears in skipped at all. KEY INSIGHT, against the issue's own premise: no stitched rings and no tiling pattern are needed. PDF interpolates a ShadingType 3's centre AND radius linearly (c0+s(c1-c0), r0+s(r1-r0)), which IS SVG's radial model (circle t = centre f+t(c-f), radius t*r), so pushing the outer circle to parameter k and packing k ramp copies into the function is the whole feature. svggradient.ts radialSpreadRange(f,c,r,m,bbox,cap=64) returns a single number, not a [k0,k1] pair, because k0 is ALWAYS 0 for a radial: r(t)=t*r is meaningful only for t>=0 and SVG's spread applies outward from t=1. It solves t^2(|d|^2-r^2) - 2t(d.(p-f)) + |p-f|^2 = 0 per bbox corner; (-b-sqrt(disc))/(2a) is always the non-negative root (disc>=b^2 since -4ag>=0), and four corners suffice because the circle family is strictly nested so t's level sets are nested convex curves. Requires |d|<r, which gradientPaint's 0.999 focal clamp guarantees — compute the range AFTER the clamp. tileStops(stops,0,k,reflect) is reused unchanged and the 1gg0.17 alpha twin comes along free via pair(). New module-private gradientSpaceCorners(m,bbox) now carries the CTM-cancellation reasoning for both spread ranges. GOTCHA for tests: tileStops reads k0 only for reflect's parity, so a 'k0=1' mutation is invisible under repeat."
```

- [ ] **Step 3: Close the issue**

```bash
bd close aspose-pdf-foss-for-ts-1gg0.18
```

- [ ] **Step 4: Push both git and the tracker**

`.beads/interactions.jsonl` is tracked and will have changed; commit it as
`chore(bd): session bookkeeping for 1gg0.18` before pulling.

```bash
git add .beads/interactions.jsonl
git commit -m "chore(bd): session bookkeeping for 1gg0.18"
git pull --rebase
git push
git status -sb                        # MUST show "## main...origin/main" with no ahead/behind
bd dolt push
git ls-remote origin 'refs/dolt/*'    # MUST print a refs/dolt/data line
```

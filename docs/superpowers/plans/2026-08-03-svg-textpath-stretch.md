# SVG textPath method="stretch" Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Render `<textPath method="stretch">` by warping glyph outlines along the curve, while keeping the run extractable and searchable.

**Architecture:** Glyph outlines are flattened to polylines by a shared module moved out of `raster.ts`, reached from the SVG stack through a new optional `outline` member on `SvgFace` that `svgembed.ts` fills in. A pure warp module maps every outline vertex onto the path with the same arc-length rule `mapGlyphsToPath` already uses, emits the result as `SvgSeg[]`, and hands it to the existing `paintShape` — so gradients, patterns and strokes need no new painting code. The same glyphs are additionally emitted as text in rendering mode 3 (invisible) at their `align` positions, so `GetText`, search and selection keep working.

**Tech Stack:** TypeScript (ESM, NodeNext, `strict`), vitest, zero runtime dependencies.

**Spec:** `docs/superpowers/specs/2026-08-03-svg-textpath-stretch-design.md`
**Issue:** `aspose-pdf-foss-for-ts-1gg0.25` (epic `1gg0`)

## Global Constraints

- **Zero runtime dependencies.** Only `node:` built-ins. Do not add npm runtime deps.
- **ESM + NodeNext.** Every import specifier carries the `.js` extension (`import { x } from './svgtext.js'`).
- `npm run typecheck` and `npm test` must both be green before any task is considered done.
- **TDD.** Write the failing test first, watch it fail for the stated reason, then implement.
- Fixture builders live in `test/helpers/`; mirror the existing builder/test style.
- Errors, if any are needed, are `PdfParseError` / `UnsupportedFeatureError` / `InvalidPasswordError` from `errors.ts`. This feature should need none — it degrades instead.
- Coordinates in the SVG stack are **y-down viewBox units**. A downward tangent is `+90` degrees.
- Do not reformat or "tidy" code you are only moving. Task 1 and Task 2 depend on moves being byte-faithful.

---

### Task 1: Move the two flatteners into shared modules

Pure moves, no behaviour change. `raster.ts` owns three private functions the SVG side now needs: `flattenPath` (cubic paths, also used for page fills and clips), and `flattenQuad` + `flattenGlyphContours` (TrueType quadratic glyph contours). One glyph flattener must exist, not two — the rule `flattenCubic` already embodies.

**Files:**
- Modify: `src/strokegeom.ts` (gains `flattenPath`)
- Create: `src/glyphoutline.ts`
- Modify: `src/raster.ts:318-347` (delete `flattenPath`), `src/raster.ts:684-732` (delete `flattenQuad` + `flattenGlyphContours`), and its import block
- Test: `test/glyphoutline.test.ts`

**Interfaces:**
- Consumes: `Poly`, `FLATTEN_TOL`, `MAX_SUBDIV`, `flattenCubic` from `strokegeom.ts`; `Path`, `Matrix`, `apply` as already imported there; `GlyphPoint` from `sfnt.ts`.
- Produces:
  - `strokegeom.ts`: `export function flattenPath(path: Path, ctm: Matrix, tol?: number): Poly[]`
  - `glyphoutline.ts`: `export function flattenGlyphContours(contours: GlyphPoint[][], m: Matrix, tol?: number): Poly[]`

- [ ] **Step 1: Write the failing test**

Create `test/glyphoutline.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { flattenGlyphContours } from '../src/glyphoutline.js';
import { flattenPath } from '../src/strokegeom.js';
import { IDENTITY } from '../src/text.js';
import type { GlyphPoint } from '../src/sfnt.js';

/** Bounding box of a set of flat [x,y,...] polylines. */
function bounds(polys: number[][]) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of polys) for (let i = 0; i + 1 < p.length; i += 2) {
    x0 = Math.min(x0, p[i]); x1 = Math.max(x1, p[i]);
    y0 = Math.min(y0, p[i + 1]); y1 = Math.max(y1, p[i + 1]);
  }
  return { x0, y0, x1, y1 };
}

describe('flattenGlyphContours', () => {
  it('walks an all-on-curve contour as a polygon', () => {
    const square: GlyphPoint[][] = [[
      { x: 0, y: 0, on: true }, { x: 10, y: 0, on: true },
      { x: 10, y: 10, on: true }, { x: 0, y: 10, on: true },
    ]];
    const polys = flattenGlyphContours(square, [...IDENTITY]);
    expect(polys).toHaveLength(1);
    expect(bounds(polys)).toEqual({ x0: 0, y0: 0, x1: 10, y1: 10 });
  });

  it('subdivides an off-curve point into a bulging arc', () => {
    // One off-curve control pulling the top edge up to y=10: the flattened
    // polyline must reach ABOVE the on-curve points (which cap at y=0) without
    // reaching the control point itself — that is what a quadratic does.
    const arc: GlyphPoint[][] = [[
      { x: 0, y: 0, on: true }, { x: 10, y: 10, on: false }, { x: 20, y: 0, on: true },
    ]];
    const b = bounds(flattenGlyphContours(arc, [...IDENTITY]));
    expect(b.y1).toBeGreaterThan(0);
    expect(b.y1).toBeLessThan(10);
  });

  it('maps every point through the matrix', () => {
    const square: GlyphPoint[][] = [[
      { x: 0, y: 0, on: true }, { x: 10, y: 0, on: true }, { x: 10, y: 10, on: true },
    ]];
    // Half scale, y flipped, shifted right by 100 — the em→user shape the SVG
    // stack passes in.
    const b = bounds(flattenGlyphContours(square, [0.5, 0, 0, -0.5, 100, 0]));
    expect(b).toEqual({ x0: 100, y0: -5, x1: 105, y1: 0 });
  });
});

describe('flattenPath', () => {
  it('flattens a cubic to a polyline under the ctm', () => {
    const polys = flattenPath(
      [{ op: 'M', x: 0, y: 0 }, { op: 'C', x1: 0, y1: 10, x2: 10, y2: 10, x: 10, y: 0 }],
      [...IDENTITY]);
    expect(polys).toHaveLength(1);
    expect(polys[0].length).toBeGreaterThan(4);       // subdivided, not a chord
    const b = bounds(polys);
    expect(b.y1).toBeGreaterThan(0);
    expect(b.y1).toBeLessThan(10);
  });

  it('closes a subpath back to its start on Z', () => {
    const polys = flattenPath(
      [{ op: 'M', x: 0, y: 0 }, { op: 'L', x: 10, y: 0 }, { op: 'Z' }], [...IDENTITY]);
    expect(polys[0]).toEqual([0, 0, 10, 0, 0, 0]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/glyphoutline.test.ts`
Expected: FAIL — `Cannot find module '../src/glyphoutline.js'`, and `flattenPath` is not exported from `strokegeom.js`.

- [ ] **Step 3: Move `flattenPath` into `strokegeom.ts`**

Cut lines 318-347 out of `src/raster.ts` (the `// ---------- Path flattening ----------` banner comment stays with the code) and paste them into `src/strokegeom.ts` immediately after `flattenCubic` (i.e. before the `// ---------- Stroking ----------` banner), exported and with the tolerance parameterised:

```ts
// ---------- Path flattening (user → device polylines) ----------

/** Flatten a structured path to device-space subpath polylines under `ctm`. */
export function flattenPath(path: Path, ctm: Matrix, tol = FLATTEN_TOL): Poly[] {
  const polys: Poly[] = [];
  let cur: Poly | undefined;
  let sx = 0, sy = 0;          // subpath start (device)
  let px = 0, py = 0;          // current point (device)
  const start = (dx: number, dy: number) => { cur = [dx, dy]; polys.push(cur); sx = px = dx; sy = py = dy; };
  for (const s of path) {
    if (s.op === 'M') {
      const [dx, dy] = apply(ctm, s.x, s.y);
      start(dx, dy);
    } else if (s.op === 'L') {
      if (!cur) start(...apply(ctm, s.x, s.y));
      else { const [dx, dy] = apply(ctm, s.x, s.y); cur.push(dx, dy); px = dx; py = dy; }
    } else if (s.op === 'C') {
      if (!cur) { const [dx, dy] = apply(ctm, s.x, s.y); start(dx, dy); continue; }
      const [c1x, c1y] = apply(ctm, s.x1, s.y1);
      const [c2x, c2y] = apply(ctm, s.x2, s.y2);
      const [ex, ey] = apply(ctm, s.x, s.y);
      flattenCubic(cur, px, py, c1x, c1y, c2x, c2y, ex, ey, 0, tol);
      px = ex; py = ey;
    } else {                    // Z
      if (cur) { cur.push(sx, sy); px = sx; py = sy; }
    }
  }
  return polys;
}
```

`strokegeom.ts` already imports `Matrix`, `apply` and `Path`, so no import changes are needed there.

- [ ] **Step 4: Create `src/glyphoutline.ts` with the glyph flatteners**

Cut `flattenQuad` and `flattenGlyphContours` out of `src/raster.ts` (lines 684-732, including their doc comments) and paste them into a new file:

```ts
// Glyph outlines to polylines. Shared: raster.ts fills them to paint text, and
// the SVG authoring stack warps them along a <textPath method="stretch">.
// Kept out of raster.ts so the authoring side needs no dependency on the
// rasterizer, and so one flattener serves both — the rule flattenCubic already
// embodies for cubics.
import { Matrix, apply } from './text.js';
import { Poly, MAX_SUBDIV, FLATTEN_TOL } from './strokegeom.js';
import type { GlyphPoint } from './sfnt.js';

/** Flatten a quadratic Bézier to `out` by adaptive subdivision. */
function flattenQuad(
  out: Poly, x0: number, y0: number, cx: number, cy: number,
  x1: number, y1: number, depth: number, tol: number,
): void {
  if (depth >= MAX_SUBDIV) { out.push(x1, y1); return; }
  const dx = x1 - x0, dy = y1 - y0;
  const dist = Math.abs((cx - x1) * dy - (cy - y1) * dx);
  if (dist * dist <= tol * tol * (dx * dx + dy * dy)) { out.push(x1, y1); return; }
  const x01 = (x0 + cx) / 2, y01 = (y0 + cy) / 2, x12 = (cx + x1) / 2, y12 = (cy + y1) / 2;
  const xm = (x01 + x12) / 2, ym = (y01 + y12) / 2;
  flattenQuad(out, x0, y0, x01, y01, xm, ym, depth + 1, tol);
  flattenQuad(out, xm, ym, x12, y12, x1, y1, depth + 1, tol);
}

/** Flatten TrueType quadratic contours to polylines under `m` (font→target).
 *  Reconstructs on/off-curve sequences (implied midpoints, off-curve starts). */
export function flattenGlyphContours(
  contours: GlyphPoint[][], m: Matrix, tol = FLATTEN_TOL,
): Poly[] {
  const polys: Poly[] = [];
  for (const contour of contours) {
    const n = contour.length;
    if (n < 2) continue;
    const dp = contour.map((pt) => { const [x, y] = apply(m, pt.x, pt.y); return { x, y, on: pt.on }; });
    let startIdx = dp.findIndex((p) => p.on);
    let start: { x: number; y: number };
    const seq: { x: number; y: number; on: boolean }[] = [];
    if (startIdx >= 0) {
      start = dp[startIdx];
      for (let k = 1; k <= n; k++) seq.push(dp[(startIdx + k) % n]);
    } else {
      start = { x: (dp[0].x + dp[n - 1].x) / 2, y: (dp[0].y + dp[n - 1].y) / 2 };
      for (const p of dp) seq.push(p);
      seq.push({ x: start.x, y: start.y, on: true });
    }
    const poly: Poly = [start.x, start.y];
    let curx = start.x, cury = start.y;
    let ctrl: { x: number; y: number } | undefined;
    for (const p of seq) {
      if (p.on) {
        if (ctrl) { flattenQuad(poly, curx, cury, ctrl.x, ctrl.y, p.x, p.y, 0, tol); ctrl = undefined; }
        else poly.push(p.x, p.y);
        curx = p.x; cury = p.y;
      } else if (ctrl) {
        const mx = (ctrl.x + p.x) / 2, my = (ctrl.y + p.y) / 2;
        flattenQuad(poly, curx, cury, ctrl.x, ctrl.y, mx, my, 0, tol);
        curx = mx; cury = my; ctrl = p;
      } else ctrl = p;
    }
    if (ctrl) flattenQuad(poly, curx, cury, ctrl.x, ctrl.y, start.x, start.y, 0, tol);
    if (poly.length >= 6) polys.push(poly);
  }
  return polys;
}
```

This is `raster.ts:698-732` verbatim; the only edits are the `tol` parameter and the trailing `tol` argument on the four `flattenQuad` calls. `let startIdx` stays `let` even though it is never reassigned — do not "fix" it here, so the move stays a move.

- [ ] **Step 5: Point `raster.ts` at the moved code**

In `src/raster.ts`, add `flattenPath` to the existing `strokegeom.js` import (which already brings in `Poly, FLATTEN_TOL, MAX_SUBDIV, flattenCubic, ctmScale, strokeOutlinePolys`), and add a new import:

```ts
import { flattenGlyphContours } from './glyphoutline.js';
```

Delete the three moved functions. `MAX_SUBDIV` and `flattenCubic` may now be unused in `raster.ts` — run the typecheck in Step 6 and remove any import that has become dead.

- [ ] **Step 6: Run the tests**

```bash
npx vitest run test/glyphoutline.test.ts
npm run typecheck
npm test
```

Expected: the new file passes; the **whole** suite passes with no golden churn. The raster and SVG goldens are the guard that the move changed nothing — if any golden test fails, the move was not faithful. Do not update a golden in this task.

- [ ] **Step 7: Commit**

```bash
git add src/strokegeom.ts src/glyphoutline.ts src/raster.ts test/glyphoutline.test.ts
git commit -m "refactor: share the glyph and path flatteners out of raster.ts

flattenPath moves to strokegeom.ts, whose charter is already backend-neutral
Bezier flattening; flattenQuad + flattenGlyphContours move to a new
glyphoutline.ts. Pure moves with the tolerance parameterised, so the raster and
SVG goldens staying byte-identical is the guard. Prepares the SVG authoring
stack to warp glyph outlines without a second flattener.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 2: `glyphPolys` — one call for glyf and CFF

`raster.ts` currently branches on `src.cff` vs `src.sfnt`, scales by `unitsPerEm` at each branch, and calls a different flattener in each. The SVG seam needs exactly the same dispatch, so it becomes one function and `raster.ts` adopts it.

**Files:**
- Modify: `src/glyphoutline.ts`
- Modify: `src/raster.ts:746-780` (`rasterizeGlyphRun`)
- Test: `test/glyphoutline.test.ts`

**Interfaces:**
- Consumes: `flattenGlyphContours` and `flattenPath` from Task 1; `SfntFont` from `sfnt.ts`; `CffFont` from `cff.ts`; `mul` from `text.ts`.
- Produces:
  - `export interface OutlineSource { sfnt?: SfntFont; cff?: CffFont }`
  - `export function glyphPolys(src: OutlineSource, gid: number, m: Matrix, tol?: number): Poly[]`
    — `m` maps **em units (1 unit = 1 em, y-up)** to the target space; the font's `unitsPerEm` scaling is applied inside.

- [ ] **Step 1: Write the failing test**

Append to `test/glyphoutline.test.ts`:

```ts
import { glyphPolys } from '../src/glyphoutline.js';
import { getStd14Sfnt } from '../src/std14fonts.js';

describe('glyphPolys', () => {
  it('scales a glyf outline out of font units into em units', () => {
    const sfnt = getStd14Sfnt('Helvetica')!;
    const gid = sfnt.cmapLookup('H'.codePointAt(0)!)!;
    // Identity matrix => the result is in EM units, so a capital H must be
    // about 0.7 em tall and sit on the baseline. Checked against typography,
    // not against our own parser — a cap height near 1.0 or 700 would mean the
    // unitsPerEm scaling was skipped.
    const b = bounds(glyphPolys({ sfnt }, gid, [...IDENTITY]));
    expect(b.y0).toBeCloseTo(0, 2);
    expect(b.y1).toBeGreaterThan(0.6);
    expect(b.y1).toBeLessThan(0.8);
    expect(b.x1 - b.x0).toBeGreaterThan(0.4);
  });

  it('returns an empty set for a blank glyph', () => {
    const sfnt = getStd14Sfnt('Helvetica')!;
    const gid = sfnt.cmapLookup(' '.codePointAt(0)!)!;
    expect(glyphPolys({ sfnt }, gid, [...IDENTITY])).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/glyphoutline.test.ts`
Expected: FAIL — `glyphPolys` is not exported.

- [ ] **Step 3: Implement `glyphPolys`**

In `src/glyphoutline.ts` (imports: add `mul` to the `./text.js` import, plus `flattenPath` from `./strokegeom.js`, `SfntFont` from `./sfnt.js`, `CffFont` from `./cff.js`):

```ts
/** Where a glyph's outline comes from. `cff` wins when both are present: an
 *  OpenType-CFF face has an sfnt wrapper whose glyf table is absent. */
export interface OutlineSource {
  sfnt?: SfntFont;
  cff?: CffFont;
}

/** Glyph `gid` as polylines under `m`, which maps EM units (y-up) to the target
 *  space — the font's own unitsPerEm is divided out here, so callers never see
 *  font units. Empty for a blank glyph, a missing one, or no source. */
export function glyphPolys(
  src: OutlineSource, gid: number, m: Matrix, tol = FLATTEN_TOL,
): Poly[] {
  if (src.cff) {
    const path = src.cff.glyphPath(gid);
    if (path.length === 0) return [];
    const upm = src.cff.unitsPerEm || 1000;
    return flattenPath(path, mul([1 / upm, 0, 0, 1 / upm, 0, 0], m), tol);
  }
  if (src.sfnt) {
    const contours = src.sfnt.glyphOutline(gid);
    if (contours.length === 0) return [];
    const upm = src.sfnt.unitsPerEm || 1000;
    return flattenGlyphContours(contours, mul([1 / upm, 0, 0, 1 / upm, 0, 0], m), tol);
  }
  return [];
}
```

- [ ] **Step 4: Adopt it in `raster.ts`**

Replace the two branches inside `rasterizeGlyphRun` (`src/raster.ts:756-776`) with one call. Before:

```ts
      if (gid !== undefined) {
        if (src.cff) {
          const path = src.cff.glyphPath(gid);
          ...
        } else if (src.sfnt) {
          const contours = src.sfnt.glyphOutline(gid);
          ...
        }
        drew = true;                                // gid resolved (empty glyph → no box)
      }
```

After:

```ts
      if (gid !== undefined) {
        const polys = glyphPolys(src, gid, emMatrix);
        if (polys.length) rasterizeFill(canvas, polys, info.color, false, paint);
        drew = true;                                // gid resolved (empty glyph → no box)
      }
```

Add `glyphPolys` to the `./glyphoutline.js` import. `GlyphSource` (raster's own interface) is structurally an `OutlineSource` plus `isType0`/`cidToGid`, so it passes without a cast. Note the arithmetic is unchanged: raster previously built `mul([1/upm,0,0,1/upm,0,0], emMatrix)` at each branch, which is now inside `glyphPolys`.

- [ ] **Step 5: Run the tests**

```bash
npx vitest run test/glyphoutline.test.ts
npm run typecheck
npm test
```

Expected: all pass, goldens unchanged — this is still a behaviour-preserving refactor.

- [ ] **Step 6: Commit**

```bash
git add src/glyphoutline.ts src/raster.ts test/glyphoutline.test.ts
git commit -m "refactor: one glyphPolys call for glyf and CFF outlines

Collapses rasterizeGlyphRun's two branches into glyphoutline.ts, which divides
out unitsPerEm so callers work in em units. Same arithmetic, so the goldens
guard it; the SVG stack needs the identical dispatch next.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 3: `faceOutline` — characters to outlines, with the CFF branch

The SVG stack has a character, not a gid, and its faces are either a bundled Standard-14 substitute or the caller's `EmbeddedFont` — both `SfntFont`s. This wraps the gid lookup and the OpenType-CFF unwrap into the closure `SvgFace.outline` will hold.

**Files:**
- Modify: `src/glyphoutline.ts`
- Test: `test/glyphoutline.test.ts`

**Interfaces:**
- Consumes: `glyphPolys` from Task 2; `SfntFont.cmapLookup`, `SfntFont.outlines`, `SfntFont.table` from `sfnt.ts`.
- Produces: `export function faceOutline(sfnt: SfntFont): (ch: string, m: Matrix, tol: number) => Poly[] | null`
  — returns `null` when the face cannot render `ch` at all (no cmap entry, or an unusable CFF table), and `[]` for a real but blank glyph. Task 5 relies on that distinction.

- [ ] **Step 1: Write the failing test**

Append to `test/glyphoutline.test.ts`:

```ts
import { readFileSync } from 'node:fs';
import { faceOutline } from '../src/glyphoutline.js';
import { parseSfnt } from '../src/sfnt.js';
import { FLATTEN_TOL } from '../src/strokegeom.js';

describe('faceOutline', () => {
  it('resolves a character through the cmap on a glyf face', () => {
    const out = faceOutline(getStd14Sfnt('Helvetica')!);
    const b = bounds(out('H', [...IDENTITY], FLATTEN_TOL)!);
    expect(b.y1).toBeGreaterThan(0.6);
    expect(b.y1).toBeLessThan(0.8);
  });

  it('returns null for a character the face has no glyph for', () => {
    const out = faceOutline(getStd14Sfnt('Helvetica')!);
    expect(out('中', [...IDENTITY], FLATTEN_TOL)).toBeNull();
  });

  it('unwraps the CFF table of an OpenType-CFF face', () => {
    // A real third-party OTTO font: our own builders never produce one, so this
    // is the only way to prove the CFF branch is wired. See
    // test/fixtures/fonts/PROVENANCE.md.
    const otf = parseSfnt(new Uint8Array(readFileSync('test/fixtures/fonts/NimbusSans-Regular.otf')));
    expect(otf.outlines).toBe('cff');
    const b = bounds(faceOutline(otf)('H', [...IDENTITY], FLATTEN_TOL)!);
    expect(b.y1).toBeGreaterThan(0.6);
    expect(b.y1).toBeLessThan(0.8);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/glyphoutline.test.ts`
Expected: FAIL — `faceOutline` is not exported.

- [ ] **Step 3: Implement `faceOutline`**

Append to `src/glyphoutline.ts`:

```ts
/** A per-character outline reader for one face, for SvgFace.outline.
 *
 *  The CFF table is parsed at most once, on the first character that needs it:
 *  an OpenType-CFF face carries its outlines there rather than in `glyf`, and
 *  parsing it eagerly would cost every face that never stretches. */
export function faceOutline(sfnt: SfntFont): (ch: string, m: Matrix, tol: number) => Poly[] | null {
  let src: OutlineSource | undefined;
  return (ch, m, tol) => {
    const cp = ch.codePointAt(0);
    if (cp === undefined) return null;
    const gid = sfnt.cmapLookup(cp);
    if (gid === undefined) return null;             // no glyph: caller falls back
    if (src === undefined) {
      if (sfnt.outlines === 'cff') {
        const raw = sfnt.table('CFF ', false);
        let cff: CffFont | undefined;
        // A malformed CFF is a broken font, not a broken document: report no
        // outline and let the caller degrade, exactly as a missing glyph does.
        if (raw) { try { cff = new CffFont(raw); } catch { cff = undefined; } }
        src = { cff };
      } else {
        src = { sfnt };
      }
    }
    if (src.cff === undefined && src.sfnt === undefined) return null;
    return glyphPolys(src, gid, m, tol);
  };
}
```

- [ ] **Step 4: Run the tests**

```bash
npx vitest run test/glyphoutline.test.ts
npm run typecheck
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/glyphoutline.ts test/glyphoutline.test.ts
git commit -m "feat(svg): faceOutline reads a character's outline off an sfnt

cmap lookup plus the OpenType-CFF unwrap, parsed lazily and cached per face.
null for a character the face has no glyph for, [] for a blank one - the
distinction the stretch fallback keys on. Covered against the NimbusSans OTTO
fixture, since our own builders never emit CFF-flavoured sfnt.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 4: `placeAt` — the shared arc-length placement

`mapGlyphsToPath` computes "a point at distance `d`, displaced `perp` along the normal" inline. The warp needs the identical computation per outline vertex, so it is extracted first and `mapGlyphsToPath` is rewritten on top of it — a refactor whose guard is the existing textPath suite.

**Files:**
- Modify: `src/svgtextpath.ts:115-150`
- Test: `test/svg-textpath.test.ts`

**Interfaces:**
- Consumes: `PathMetrics`, `pointAt` (already in `svgtextpath.ts`).
- Produces: `export function placeAt(m: PathMetrics, d: number, perp: number): { x: number; y: number; angle: number } | null`

- [ ] **Step 1: Write the failing test**

Add to `test/svg-textpath.test.ts` (inside the `describe` that covers `pointAt`, or a new one beside it):

```ts
describe('placeAt', () => {
  // A path running straight DOWN: the tangent is +90 degrees in y-down space,
  // so the normal (-sin, cos) is (-1, 0) — a positive perp moves LEFT, which is
  // the same "further down the page at angle 0" convention the layout uses.
  const down = measurePath(parsePath('M100 20 L100 120').segs);

  it('walks the distance along the path', () => {
    const p = placeAt(down, 30, 0)!;
    expect(p.x).toBeCloseTo(100, 6);
    expect(p.y).toBeCloseTo(50, 6);
    expect(p.angle).toBeCloseTo(90, 6);
  });

  it('displaces perpendicular to the tangent', () => {
    const p = placeAt(down, 30, 10)!;
    expect(p.x).toBeCloseTo(90, 6);        // +perp is left of a downward tangent
    expect(p.y).toBeCloseTo(50, 6);
  });

  it('is null past either end', () => {
    expect(placeAt(down, -1, 0)).toBeNull();
    expect(placeAt(down, 101, 0)).toBeNull();
  });
});
```

Import `placeAt` alongside the existing `svgtextpath.js` imports in that file, and `parsePath` from `../src/svgpath.js` if it is not already imported.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/svg-textpath.test.ts`
Expected: FAIL — `placeAt` is not exported.

- [ ] **Step 3: Implement `placeAt` and rewrite `mapGlyphsToPath` on it**

In `src/svgtextpath.ts`, insert after `reverseMetrics`:

```ts
/** The point at `d` along `m`, displaced `perp` along the normal — the whole of
 *  what "put something on this path" means here. `mapGlyphsToPath` places a
 *  glyph origin with it and svgtextstretch.ts places every outline vertex, so
 *  the two cannot drift apart. The normal is (-sin, cos), which at angle 0 is
 *  (0, 1): a positive `perp` still means "further down the page", exactly as in
 *  the unmapped layout. */
export function placeAt(
  m: PathMetrics, d: number, perp: number,
): { x: number; y: number; angle: number } | null {
  const p = pointAt(m, d);
  if (p === null) return null;
  const rad = (p.angle * Math.PI) / 180;
  return {
    x: p.x - Math.sin(rad) * perp,
    y: p.y + Math.cos(rad) * perp,
    angle: p.angle,
  };
}
```

Then replace the body of the loop in `mapGlyphsToPath` (`src/svgtextpath.ts:135-148`):

```ts
    // Distance at the MIDPOINT of the advance, then back off half the advance
    // along the tangent to recover the origin.
    const p = placeAt(m, startOffset + g.x + g.adv / 2, g.y);
    if (p === null) continue;                 // off the path: not rendered
    const rad = (p.angle * Math.PI) / 180;
    const half = g.adv / 2;
    g.x = p.x - Math.cos(rad) * half;
    g.y = p.y - Math.sin(rad) * half;
    g.rot += p.angle;
    out.push(g);
```

This is algebraically the previous expression: the old `g.x = p.x - cos*half - sin*gy` splits into `placeAt`'s `- sin*gy` and the `- cos*half` here.

- [ ] **Step 4: Run the tests**

```bash
npx vitest run test/svg-textpath.test.ts test/svg-textpath-render.test.ts
npm run typecheck
```

Expected: PASS, including every pre-existing textPath test — those are the guard that the rewrite is equivalent.

- [ ] **Step 5: Commit**

```bash
git add src/svgtextpath.ts test/svg-textpath.test.ts
git commit -m "refactor(svg): extract placeAt from mapGlyphsToPath

One arc-length placement rule - point at a distance, displaced along the
normal - so the coming outline warp cannot drift from the glyph placement.
mapGlyphsToPath keeps its half-advance backoff and its behaviour; the existing
textPath suite is the guard.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 5: `svgtextstretch.ts` — the warp

The pure core: laid-out glyphs plus their faces' outlines become warped `SvgSeg[]`, grouped by style. No PDF objects, no `Document`, no font parsing — like `svgtextpath.ts`.

**Files:**
- Create: `src/svgtextstretch.ts`
- Modify: `src/svgtext.ts` (the `SvgFace` interface only)
- Modify: `test/helpers/fake-svg-font.ts`
- Test: `test/svg-textstretch.test.ts`

**Interfaces:**
- Consumes: `PathMetrics`, `pointAt`, `placeAt` from `svgtextpath.ts`; `PlacedGlyph`, `SvgTextStyle`, `textMatrix` from `svgtext.ts`; `SvgSeg` from `svgpath.ts`; `Poly` from `strokegeom.ts`; `Matrix`, `mul` from `text.ts`.
- Produces:
  - `svgtext.ts`: `SvgFace.outline?: (ch: string, m: Matrix, tol: number) => Poly[] | null`
  - `export interface StretchedRun { segs: SvgSeg[]; style: SvgTextStyle }`
  - `export function canStretch(glyphs: PlacedGlyph[], onPath: (g: PlacedGlyph) => boolean): boolean`
  - `export function stretchGlyphs(glyphs: PlacedGlyph[], onPath: (g: PlacedGlyph) => boolean, m: PathMetrics, startOffset: number, tol: number): StretchedRun[]`

- [ ] **Step 1: Give the fake provider an outline, opt-in**

In `test/helpers/fake-svg-font.ts`, extend the factory. The existing `fakeProvider()` must keep returning faces with **no** `outline` — every current textPath test depends on that being the align-fallback path.

The whole file after the change:

```ts
import type { SvgFontProvider } from '../../src/svgtext.js';
import { vmetricsFor } from '../../src/textdecor.js';
import { name, type PdfObject } from '../../src/types.js';
import { apply, type Matrix } from '../../src/text.js';
import type { Poly } from '../../src/strokegeom.js';

/** A unit square sitting on the baseline, in em units: (0,0) to (1,1) y-up.
 *  Predictable geometry, so a warped result can be asserted in closed form
 *  rather than compared against a real face's contours. */
function squareOutline(ch: string, m: Matrix): Poly[] {
  if (ch === ' ') return [];                       // blank glyph: real, but no ink
  const poly: Poly = [];
  for (const [x, y] of [[0, 0], [1, 0], [1, 1], [0, 1]]) poly.push(...apply(m, x, y));
  return [poly];
}

/** A font provider whose every glyph is exactly 1 em wide, so expected
 *  positions in the layout tests are readable integers rather than AFM widths.
 *  It records the family lists it was asked for.
 *
 *  Shared by the svgtext and svgdraw suites: both need a provider, and neither
 *  is testing font metrics.
 *
 *  `outline` is OPT-IN and off by default: a face without it is what makes
 *  textPath method="stretch" fall back to align, so every existing test keeps
 *  exercising that path. */
export function fakeProvider(opts: { outline?: boolean } = {}):
  SvgFontProvider & { asks: string[][] } {
  const asks: string[][] = [];
  // Real entries, so buildResources can filter the used keys against them.
  const fonts = new Map<string, PdfObject>();
  return {
    asks,
    dict: () => fonts,
    face(families, bold, italic) {
      asks.push(families);
      const key = `F${bold ? 'B' : ''}${italic ? 'I' : ''}`;
      if (!fonts.has(key)) fonts.set(key, name(key));
      return {
        key,
        driver: {
          measure: (t: string, fs: number) => t.length * fs,
          encode: (t: string) => new TextEncoder().encode(t),
          probe: (t: string) => t.length,
        },
        vmetrics: vmetricsFor('Helvetica'),
        ...(opts.outline ? { outline: (ch: string, m: Matrix) => squareOutline(ch, m) } : {}),
      };
    },
  };
}
```

- [ ] **Step 2: Write the failing test**

Create `test/svg-textstretch.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { flattenText, layoutText } from '../src/svgtext.js';
import { measurePath } from '../src/svgtextpath.js';
import { canStretch, stretchGlyphs } from '../src/svgtextstretch.js';
import { parsePath } from '../src/svgpath.js';
import { parseXml } from '../src/xml.js';
import { INITIAL } from '../src/svgstyle.js';
import { FLATTEN_TOL } from '../src/strokegeom.js';
import { fakeProvider } from './helpers/fake-svg-font.js';

const xml = (s: string) => new TextEncoder().encode(s);
const lay = (src: string, outline = true) =>
  layoutText(flattenText(parseXml(xml(src)), INITIAL, fakeProvider({ outline }), 12));
const metrics = (d: string) => measurePath(parsePath(d).segs);
const all = () => true;

/** Bounds of one run's segs. */
function bounds(segs: { op: string; args: number[] }[]) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const s of segs) {
    if (s.args.length < 2) continue;
    x0 = Math.min(x0, s.args[0]); x1 = Math.max(x1, s.args[0]);
    y0 = Math.min(y0, s.args[1]); y1 = Math.max(y1, s.args[1]);
  }
  return { x0, y0, x1, y1 };
}

describe('canStretch', () => {
  it('is false when any face on the path has no outline', () => {
    expect(canStretch(lay('<text>ab</text>', false), all)).toBe(false);
  });

  it('is true when every face on the path has one', () => {
    expect(canStretch(lay('<text>ab</text>'), all)).toBe(true);
  });

  it('is false when no glyph is on the path at all', () => {
    expect(canStretch(lay('<text>ab</text>'), () => false)).toBe(false);
  });
});

describe('stretchGlyphs', () => {
  // Straight down from (100,20): the tangent is +90 degrees everywhere, so the
  // mapping is exact. A glyph's advance runs along +y and its own "up" (-y in
  // user space, an em box of height `size`) runs along +x.
  const DOWN = metrics('M100 20 L100 180');

  it('maps a run onto the path in closed form', () => {
    // Every glyph is 1 em wide at font-size 10, so glyph 0 spans run-distance
    // 0..10 and glyph 1 spans 10..20.
    const runs = stretchGlyphs(lay('<text font-size="10">ab</text>'), all, DOWN, 0, FLATTEN_TOL);
    expect(runs).toHaveLength(1);
    const b = bounds(runs[0].segs);
    expect(b.x0).toBeCloseTo(100, 6);
    expect(b.x1).toBeCloseTo(110, 6);      // one em of glyph height, mapped to +x
    expect(b.y0).toBeCloseTo(20, 6);
    expect(b.y1).toBeCloseTo(40, 6);       // two glyphs of advance, mapped to +y
  });

  it('honours startOffset along the path', () => {
    const runs = stretchGlyphs(lay('<text font-size="10">a</text>'), all, DOWN, 25, FLATTEN_TOL);
    const b = bounds(runs[0].segs);
    expect(b.y0).toBeCloseTo(45, 6);
    expect(b.y1).toBeCloseTo(55, 6);
  });

  it('keeps the perpendicular extent — the glyph is not collapsed to the curve', () => {
    // The assertion that fails if the perp term is dropped from the mapping:
    // without it every point lands ON the path and the box has zero width.
    const runs = stretchGlyphs(lay('<text font-size="10">a</text>'), all, DOWN, 0, FLATTEN_TOL);
    const b = bounds(runs[0].segs);
    expect(b.x1 - b.x0).toBeCloseTo(10, 6);
  });

  it('turns with the path: a semicircle reverses the glyph-up direction', () => {
    const arc = metrics('M20 100 A80 80 0 0 1 180 100');
    const runs = stretchGlyphs(lay('<text font-size="10">aaaaaaaaaaaa</text>'), all, arc, 0, FLATTEN_TOL);
    const segs = runs[0].segs;
    // Each glyph contributes M,L,L,L,Z. Within one glyph, args[0] is the
    // baseline-left corner and args[2] is the same corner one em UP, so their
    // difference is the glyph-up vector at that point on the arc.
    const upAt = (i: number) => {
      const o = i * 5;
      return [segs[o + 3].args[0] - segs[o].args[0], segs[o + 3].args[1] - segs[o].args[1]];
    };
    const [ax, ay] = upAt(0);
    const [bx, by] = upAt(11);
    const dot = (ax * bx + ay * by) / (Math.hypot(ax, ay) * Math.hypot(bx, by));
    expect(dot).toBeLessThan(-0.9);        // ~180 degrees apart
  });

  it('drops a glyph whose midpoint falls past the end of the path', () => {
    const short = metrics('M0 0 L0 12');   // room for one 10-unit glyph, not two
    const runs = stretchGlyphs(lay('<text font-size="10">ab</text>'), all, short, 0, FLATTEN_TOL);
    expect(runs[0].segs.filter((s) => s.op === 'M')).toHaveLength(1);
  });

  it('starts a new run at a style change', () => {
    const runs = stretchGlyphs(
      lay('<text font-size="10">a<tspan fill="red">b</tspan></text>'), all, DOWN, 0, FLATTEN_TOL);
    expect(runs).toHaveLength(2);
  });

  it('contributes no geometry for a blank glyph', () => {
    const runs = stretchGlyphs(
      lay('<text xml:space="preserve" font-size="10">a b</text>'), all, DOWN, 0, FLATTEN_TOL);
    expect(runs[0].segs.filter((s) => s.op === 'M')).toHaveLength(2);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run test/svg-textstretch.test.ts`
Expected: FAIL — `Cannot find module '../src/svgtextstretch.js'`.

- [ ] **Step 4: Add the `outline` member to `SvgFace`**

In `src/svgtext.ts`, extend the interface (add `Poly` to the imports from `./strokegeom.js`):

```ts
/** One resolved face, ready to measure, encode and reference. */
export interface SvgFace {
  /** Resource key within the Form XObject's /Font subdictionary. */
  key: string;
  driver: FontDriver;
  vmetrics: VMetrics;
  /** `ch`'s contours, flattened under `m` (em units, y-up → user space), or
   *  null when the face has no glyph for it. ABSENT on a face with no outline
   *  source at all, which is what makes textPath method="stretch" fall back to
   *  align — see svgtextstretch.ts. */
  outline?: (ch: string, m: Matrix, tol: number) => Poly[] | null;
}
```

- [ ] **Step 5: Implement `src/svgtextstretch.ts`**

```ts
// SVG <textPath method="stretch"> (issue 1gg0.25): warp glyph OUTLINES along
// the curve rather than placing upright glyphs at tangent angles. Pure — no
// Document, no PDF objects, no font parsing. Outlines arrive through
// SvgFace.outline, which svgembed.ts fills in, mirroring how fonts already
// arrive through SvgFontProvider.
import { mul, type Matrix } from './text.js';
import type { Poly } from './strokegeom.js';
import type { SvgSeg } from './svgpath.js';
import { textMatrix, type PlacedGlyph, type SvgTextStyle } from './svgtext.js';
import { pointAt, placeAt, type PathMetrics } from './svgtextpath.js';

/** One warped run: contours in the <text> element's user space, plus the style
 *  whose paint fills them. One per contiguous style, mirroring emitGlyphs' runs
 *  so a <tspan> inside a stretched <textPath> gets its own paint. */
export interface StretchedRun {
  segs: SvgSeg[];
  style: SvgTextStyle;
}

/** Whether every glyph `onPath` selects can supply an outline, and there is at
 *  least one.
 *
 *  All-or-nothing per textPath, deliberately: a run mixing a face that can
 *  stretch with one that cannot would render half its glyphs warped and half
 *  upright, which reads as a bug rather than as a degradation. */
export function canStretch(
  glyphs: PlacedGlyph[], onPath: (g: PlacedGlyph) => boolean,
): boolean {
  let any = false;
  for (const g of glyphs) {
    if (!onPath(g)) continue;
    if (g.style.face.outline === undefined) return false;
    any = true;
  }
  return any;
}

/** Warp every glyph `onPath` selects onto `m`.
 *
 *  MUST run before mapGlyphsToPath, which mutates g.x/g.y in place: the warp
 *  reads the chunk-local layout positions, where x is distance along the run.
 *
 *  Which glyphs render is the same midpoint rule mapGlyphsToPath applies, so
 *  the warped ink and the invisible text layer agree about what exists. Within
 *  a surviving glyph, per-point distances CLAMP to the path's extent: deciding
 *  per point instead would tear a glyph in half at the boundary. */
export function stretchGlyphs(
  glyphs: PlacedGlyph[], onPath: (g: PlacedGlyph) => boolean,
  m: PathMetrics, startOffset: number, tol: number,
): StretchedRun[] {
  const runs: StretchedRun[] = [];
  let cur: StretchedRun | undefined;

  for (const g of glyphs) {
    if (!onPath(g)) { cur = undefined; continue; }
    // The same midpoint test mapGlyphsToPath uses to drop a glyph.
    if (pointAt(m, startOffset + g.x + g.adv / 2) === null) continue;

    // Em units to the run's chunk-local user space: the SAME placement
    // emitGlyphs builds its Tm from, so rotate=, lengthAdjust's hscale, dy and
    // baseline-shift all reach the warp without a second implementation.
    const em = mul(
      [g.style.size * g.hscale, 0, 0, g.style.size, 0, 0],
      textMatrix(g.x, g.y, g.rot),
    );
    const polys = g.style.face.outline?.(g.ch, em, tol);
    if (!polys || polys.length === 0) continue;     // blank or missing glyph

    if (cur === undefined || cur.style !== g.style) {
      cur = { segs: [], style: g.style };
      runs.push(cur);
    }
    for (const poly of polys) {
      const warped = warpPoly(poly, m, startOffset);
      if (warped !== null) cur.segs.push(...warped);
    }
  }
  return runs;
}

/** One contour warped onto the path as an M/L/.../Z subpath, or null when the
 *  path has no extent (placeAt cannot answer). */
function warpPoly(poly: Poly, m: PathMetrics, startOffset: number): SvgSeg[] | null {
  const segs: SvgSeg[] = [];
  for (let i = 0; i + 1 < poly.length; i += 2) {
    const d = startOffset + poly[i];
    const p = placeAt(m, Math.min(Math.max(d, 0), m.total), poly[i + 1]);
    if (p === null) return null;
    segs.push({ op: segs.length === 0 ? 'M' : 'L', args: [p.x, p.y] });
  }
  if (segs.length < 2) return null;
  segs.push({ op: 'Z', args: [] });
  return segs;
}
```

- [ ] **Step 6: Run the tests**

```bash
npx vitest run test/svg-textstretch.test.ts
npm run typecheck
npm test
```

Expected: the new suite passes and nothing else changes — no face has an `outline` in production yet.

- [ ] **Step 7: Prove the tests load-bearing**

Two mutations, each of which must turn a specific test red. Revert each before continuing.

1. In `warpPoly`, pass `0` instead of `poly[i + 1]` as `placeAt`'s `perp`.
   Run: `npx vitest run test/svg-textstretch.test.ts`
   Expected: FAIL — "keeps the perpendicular extent" reports a width of 0.
2. In `stretchGlyphs`, drop the `pointAt(...) === null` guard.
   Run: `npx vitest run test/svg-textstretch.test.ts`
   Expected: FAIL — "drops a glyph whose midpoint falls past the end" sees two subpaths.

- [ ] **Step 8: Commit**

```bash
git add src/svgtextstretch.ts src/svgtext.ts test/svg-textstretch.test.ts test/helpers/fake-svg-font.ts
git commit -m "feat(svg): warp glyph outlines along a textPath

svgtextstretch.ts maps every outline vertex through placeAt, so the warp and
the glyph placement share one arc-length rule. Outlines arrive through a new
optional SvgFace.outline, absent by default - which is exactly the align
fallback. Pure module: no Document, no PDF objects, no font parsing.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 6: Invisible text runs

Text rendering mode 3 marks a run as drawn-but-not-painted (PDF 32000-1 §9.3.6). It is what lets the stretched run stay extractable behind its vector art.

**Files:**
- Modify: `src/svgtext.ts` (`PlacedGlyph`, `sameRun`, `emitGlyphs`)
- Test: `test/svg-text.test.ts`

**Interfaces:**
- Produces: `PlacedGlyph.invisible?: boolean` — set by `svgdraw.ts` in Task 7; `emitGlyphs` emits `3 Tr` and no paint for such a run.

- [ ] **Step 1: Write the failing test**

Add to the `describe('svgtext — emission', …)` block in `test/svg-text.test.ts`:

```ts
  it('emits an invisible run in rendering mode 3, with no paint at all', () => {
    // Mode 3 is what keeps a stretched textPath extractable behind its vector
    // outlines: the glyphs are shown, so GetText and search find them, but
    // nothing is painted — which is why the sink is never asked for a colour.
    const glyphs = lay('<text font-size="10">ab</text>');
    for (const g of glyphs) g.invisible = true;
    let asked = 0;
    const ops: string[] = [];
    const sink: TextSink = {
      push: (op) => ops.push(op),
      setPaint: () => { asked++; return { fill: true, stroke: false }; },
    };
    expect(emitGlyphs(glyphs, sink, [...IDENTITY])).toBe(true);
    const s = ops.join('\n');
    expect(s).toContain('3 Tr');
    expect(s).toContain('Tj');
    expect(asked).toBe(0);
  });

  it('draws an invisible run even when nothing would paint', () => {
    // recSink(false, false) means "neither fill nor stroke": a visible run would
    // emit nothing, but an invisible one has no paint to be missing.
    const glyphs = lay('<text>abc</text>');
    for (const g of glyphs) g.invisible = true;
    const sink = recSink(false, false);
    expect(emitGlyphs(glyphs, sink, [...IDENTITY])).toBe(true);
    expect(sink.ops.join('\n')).toContain('BT');
  });

  it('never merges a visible glyph with an invisible one', () => {
    const glyphs = lay('<text font-size="10">ab</text>');
    glyphs[1].invisible = true;
    const sink = recSink();
    emitGlyphs(glyphs, sink, [...IDENTITY]);
    expect(sink.ops.join('\n').match(/BT/g)).toHaveLength(2);
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/svg-text.test.ts -t invisible`
Expected: FAIL — `invisible` is not a property of `PlacedGlyph` (a typecheck error under vitest), and no `3 Tr` is emitted.

- [ ] **Step 3: Add the flag to `PlacedGlyph`**

In `src/svgtext.ts`, in the `PlacedGlyph` interface:

```ts
  /** Shown but not painted (Tr 3). Set for a stretched textPath run, whose ink
   *  is the warped outline svgtextstretch.ts produced: the text is emitted
   *  anyway so the run stays extractable and searchable. */
  invisible?: boolean;
```

- [ ] **Step 4: Split runs on it**

```ts
/** True when two glyphs can share one Tm and one show operator. */
function sameRun(a: PlacedGlyph, b: PlacedGlyph): boolean {
  return a.style === b.style && a.rot === b.rot && a.y === b.y && a.hscale === b.hscale
    && a.invisible === b.invisible;
}
```

- [ ] **Step 5: Emit mode 3 in `emitGlyphs`**

Replace the paint block inside the run loop:

```ts
    const st = run[0].style;
    if (st.face.driver.probe(run.map((g) => g.ch).join('')) === 0) continue;

    // q/Q per run so a pattern or colour cannot leak into the next one.
    sink.push('q');
    // An invisible run paints nothing, so it asks for nothing: running setPaint
    // would register a gradient or pattern that no operator ever uses.
    let mode = 3;
    if (run[0].invisible !== true) {
      const { fill, stroke } = sink.setPaint(st.paint, box, ctm);
      if (!fill && !stroke) { sink.push('Q'); continue; }
      mode = fill && stroke ? 2 : fill ? 0 : 1;
    }
    sink.push('BT');
    sink.push(`/${st.face.key} ${num(st.size)} Tf`);
    if (mode !== 0) sink.push(`${mode} Tr`);
```

The rest of the loop body is unchanged.

- [ ] **Step 6: Run the tests**

```bash
npx vitest run test/svg-text.test.ts
npm run typecheck
npm test
```

Expected: all pass. No production glyph sets `invisible` yet, so nothing else may change.

- [ ] **Step 7: Commit**

```bash
git add src/svgtext.ts test/svg-text.test.ts
git commit -m "feat(svg): emit a text run invisibly with Tr 3

PlacedGlyph.invisible, split by sameRun and honoured by emitGlyphs, which skips
setPaint entirely for such a run - there is no colour to set, and asking would
register a paint server nothing uses. The seam a stretched textPath needs to
stay extractable behind its outlines.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 7: Wire stretch into the walker

Everything meets here: `applyTextPaths` gains the warped geometry, `svgembed.ts` supplies real outlines, and `svgtext.ts` stops reporting `stretch` unconditionally.

**Files:**
- Modify: `src/svgdraw.ts:1369-1384` (`applyTextPaths`) and `src/svgdraw.ts:1461-1487` (the `text` branch of `walk`)
- Modify: `src/svgtext.ts:332` (drop the unconditional report)
- Modify: `src/svgembed.ts` (`fontProvider`)
- Test: `test/svg-textpath.test.ts`, `test/svg-textpath-render.test.ts`

**Interfaces:**
- Consumes: `canStretch`, `stretchGlyphs`, `StretchedRun` (Task 5); `faceOutline` (Task 3); `PlacedGlyph.invisible` (Task 6); the existing `paintShape`, `textPathSegs`, `startOffsetOf`, `measurePath`, `reverseMetrics`, `mapGlyphsToPath`, `ctmScale`, `FLATTEN_TOL`.
- Produces: `applyTextPaths(e, flat, glyphs): { glyphs: PlacedGlyph[]; stretched: StretchedRun[] }`

- [ ] **Step 1: Write the failing tests**

In `test/svg-textpath.test.ts`, replace the existing `it('reports method="stretch" and renders it as align', …)` — the behaviour it asserts is what this task changes — with:

```ts
  it('still reports method="stretch" when the face has no outlines', () => {
    // fakeProvider supplies no outline, which is the align fallback.
    const r = draw(
      '<svg><defs><path id="p" d="M0 0 L100 0"/></defs>' +
      '<text><textPath href="#p" method="stretch">a</textPath></text></svg>');
    expect(r.skipped).toContain('textPath');
  });
```

In `test/svg-textpath-render.test.ts`, add:

```ts
  it('warps the outlines when the face can supply them', () => {
    // Standard-14 faces resolve to the bundled substitutes, which have
    // outlines, so this path stretches for real and reports nothing.
    const { png, skipped } = render(
      '<svg viewBox="0 0 200 200">' +
      '<defs><path id="p" d="M100 20 L100 180"/></defs>' +
      '<text font-size="20" fill="#ff0000">' +
      '<textPath href="#p" method="stretch">HHHHHHHH</textPath></text></svg>');
    expect(skipped).toEqual([]);
    expect(anyRed(png, 90, 30, 120, 170)).toBe(true);
  });

  it('keeps a stretched run extractable', () => {
    // The whole point of the invisible overlay: vector art that is still text.
    const p = Document.Open(buildSvgPdf({ mediaBox: [0, 0, 200, 200], content: '' })).Pages[0];
    p.AddSVGObject(svg(
      '<svg viewBox="0 0 200 200">' +
      '<defs><path id="p" d="M20 100 L180 100"/></defs>' +
      '<text font-size="20"><textPath href="#p" method="stretch">STRETCH</textPath></text></svg>'),
      [0, 0, 200, 200], { fit: 'fill' });
    const rt = Document.Open(p.Document.Save());
    expect(rt.Pages[0].GetText().replace(/\s+/g, '')).toContain('STRETCH');
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/svg-textpath.test.ts test/svg-textpath-render.test.ts`
Expected: FAIL — the render test finds `skipped: ['textPath']`, and `GetText()` returns nothing for the stretched run.

- [ ] **Step 3: Stop reporting stretch in `svgtext.ts`**

Delete line 332 of `src/svgtext.ts`:

```ts
    if (spec.stretch) ctx.skipped.add('textPath');
```

The decision now depends on whether the faces have outlines, which only `svgdraw.ts` can weigh. Leave the `spec.href === null && spec.inline === null` report on the line above alone, and leave `TextPathSpec.stretch`'s doc comment describing it as "method=stretch" without the "rendered as align" claim:

```ts
  /** method="stretch": warp the glyph outlines instead of placing glyphs. */
  stretch: boolean;
```

- [ ] **Step 4: Return the warped geometry from `applyTextPaths`**

In `src/svgdraw.ts`, add to the imports:

```ts
import { canStretch, stretchGlyphs, type StretchedRun } from './svgtextstretch.js';
```

and add `FLATTEN_TOL` to the existing `./strokegeom.js` import. Then:

```ts
/** Map each textPath owner's glyphs onto its own geometry, and warp the owners
 *  that asked for method="stretch" and whose faces can supply outlines. */
function applyTextPaths(
  e: Emitter, flat: FlatText, glyphs: PlacedGlyph[], ctm: Matrix,
): { glyphs: PlacedGlyph[]; stretched: StretchedRun[] } {
  let out = glyphs;
  const stretched: StretchedRun[] = [];
  for (let o = 0; o < flat.owners.length; o++) {
    const spec = flat.owners[o].path;
    if (spec === undefined) continue;
    const segs = textPathSegs(e, spec);
    if (segs === null) { e.skipped.add('textPath'); continue; }
    let m = measurePath(segs);
    if (spec.side === 'right') m = reverseMetrics(m);
    const off = startOffsetOf(spec.startOffset, m.total);
    const mine = (g: PlacedGlyph): boolean => g.chain.includes(o);

    if (spec.stretch) {
      if (canStretch(out, mine)) {
        // BEFORE mapGlyphsToPath, which mutates g.x/g.y in place: the warp
        // reads the chunk-local layout, where x is distance along the run.
        // Flatness is device-relative, so an SVG placed into a large rect gets
        // finer subdivision rather than visible faceting.
        for (const r of stretchGlyphs(out, mine, m, off, FLATTEN_TOL / ctmScale(ctm)))
          stretched.push(r);
        // The glyphs still go through the mapping below: they become the
        // invisible layer that keeps the run extractable.
        for (const g of out) if (mine(g)) g.invisible = true;
      } else {
        e.skipped.add('textPath');       // no outlines: renders as align
      }
    }
    out = mapGlyphsToPath(out, mine, m, off);
  }
  return { glyphs: out, stretched };
}
```

- [ ] **Step 5: Paint the warped runs in the `text` branch**

In `walk`'s `n.name === 'text'` branch, replace

```ts
        glyphs = applyTextPaths(t, flat, glyphs);
```

with

```ts
        const mapped = applyTextPaths(t, flat, glyphs, here);
        glyphs = mapped.glyphs;
        // Warped outlines are ordinary path geometry, so paintShape gives them
        // gradients, patterns, stroke and the objectBoundingBox box for free.
        // fill-rule is forced to nonzero: SVG's fill-rule governs the author's
        // geometry, while glyph contours are font geometry defined under
        // nonzero winding, and evenodd would punch holes through the
        // overlapping contours some faces use.
        for (const r of mapped.stretched)
          paintShape(t, r.segs, { ...r.style.paint, fillRule: 'nonzero' }, here);
```

The `decorationOps`/`emitGlyphs` calls below it are unchanged: the invisible glyphs still drive decoration and still register their face in `usedFonts`.

- [ ] **Step 6: Supply real outlines from `svgembed.ts`**

In `fontProvider` (`src/svgembed.ts`), add `outline` to both faces. Import `faceOutline` from `./glyphoutline.js` and `getStd14Sfnt` from `./std14fonts.js`:

```ts
      if (useFallback) {
        const f = fallback!;
        if (f.objNum === undefined) f.objNum = doc.allocObject(new Map<string, PdfObject>()).num;
        fonts.set(key, ref(f.objNum));
        // The caller's own program, so a stretched outline is the drawn font.
        face = { key, driver: f.driver(), vmetrics: vmetricsFor(f), outline: faceOutline(f.sfnt) };
      } else {
        const std = id as StdFont;
        fonts.set(key, new Map<string, PdfObject>([
          ['Type', name('Font')],
          ['Subtype', name('Type1')],
          ['BaseFont', name(std)],
          ['Encoding', name('WinAnsiEncoding')],
        ]));
        // Outlines come from the bundled Liberation/URW substitute, which is
        // metric-compatible with the AFM widths winAnsiDriver laid the run out
        // with — the same approximation ToImage already makes. Absent when the
        // bundled data will not parse, which degrades stretch to align.
        const sub = getStd14Sfnt(std);
        face = {
          key, driver: winAnsiDriver(std), vmetrics: vmetricsFor(std),
          ...(sub ? { outline: faceOutline(sub) } : {}),
        };
      }
```

- [ ] **Step 7: Run the tests**

```bash
npx vitest run test/svg-textpath.test.ts test/svg-textpath-render.test.ts test/svg-textstretch.test.ts
npm run typecheck
npm test
```

Expected: all green, including the full suite. If an unrelated SVG golden moves, stop — no non-stretch document may change, since nothing else reads `outline`.

- [ ] **Step 8: Prove the tests load-bearing**

Two mutations, reverted after each check:

1. In `applyTextPaths`, replace the `canStretch(out, mine)` condition with `false`.
   Run: `npx vitest run test/svg-textpath-render.test.ts`
   Expected: FAIL — "warps the outlines" sees `skipped: ['textPath']`.
2. Delete the `g.invisible = true` loop.
   Run: `npx vitest run test/svg-textpath-render.test.ts`
   Expected: FAIL — the run is painted twice (visible text over the outlines); the extraction test still passes, which is the point of checking both.

Then a third, confirming the extraction test is not vacuous:

3. In `emitGlyphs`, `continue` instead of emitting when `run[0].invisible === true`.
   Run: `npx vitest run test/svg-textpath-render.test.ts`
   Expected: FAIL — "keeps a stretched run extractable" finds no text.

- [ ] **Step 9: Commit**

```bash
git add src/svgdraw.ts src/svgtext.ts src/svgembed.ts test/svg-textpath.test.ts test/svg-textpath-render.test.ts
git commit -m "feat(svg): render textPath method=stretch

applyTextPaths warps an owner whose faces can all supply outlines, paints the
result through paintShape (so gradients, patterns and strokes come free), and
marks its glyphs invisible so the run stays extractable. svgembed supplies
outlines from the bundled Standard-14 substitutes and from the caller's own
font. A face with no outline source still falls back to align and reports,
which is the previous behaviour unchanged.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 8: Documentation and issue close

**Files:**
- Modify: `README.md:19`
- Modify: `src/page.ts:497-505`
- Modify: `docs/superpowers/specs/2026-08-03-svg-textpath-design.md` (the **Out of scope** section)

- [ ] **Step 1: Update the README**

In the SVG embedding bullet, replace this sentence:

> `method="stretch"` would need the glyph outlines warped rather than the glyphs placed, so it renders as `align` and names `textPath` in `result.skipped`; a `href` that resolves to nothing does the same and draws the text on the baseline rather than dropping it.

with:

> `method="stretch"` warps the glyph outlines along the curve instead of placing upright glyphs: the run is painted as vector contours — gradients, patterns and strokes all still apply — with an invisible text layer behind it, so it stays extractable and searchable. Standard-14 outlines come from the bundled metric-compatible substitutes, so their shapes are approximate in the same way `ToImage` is; pass `opts.font` for the real face. A face with no outline source falls back to `align` and names `textPath` in `result.skipped`, as does a `href` that resolves to nothing, which draws the text on the baseline rather than dropping it.

- [ ] **Step 2: Update the `AddSVGObject` doc comment**

In `src/page.ts`, change

```
   *  paint, and text (including `textPath`); anything it cannot render is
```

to

```
   *  paint, and text (including `textPath`, `method="stretch"` included);
   *  anything it cannot render is
```

- [ ] **Step 3: Point the textPath spec at this one**

In `docs/superpowers/specs/2026-08-03-svg-textpath-design.md`, replace the **Out of scope** paragraph's opening sentence "`method="stretch"` gets its own child issue under `1gg0`." with "`method="stretch"` got its own child issue under `1gg0` (`1gg0.25`) and shipped; see `2026-08-03-svg-textpath-stretch-design.md`." Leave the rest of the paragraph, which records why it was deferred.

- [ ] **Step 4: Verify**

```bash
npm run typecheck
npm test
```

Expected: green.

- [ ] **Step 5: Commit, close the issue, push**

```bash
git add README.md src/page.ts docs/superpowers/specs/2026-08-03-svg-textpath-design.md
git commit -m "docs: textPath method=stretch ships

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
bd close 1gg0.25 --reason "Warped outlines through paintShape, outlines via SvgFace.outline from svgembed, invisible Tr 3 overlay keeps the run extractable. Falls back to align + reports when a face has no outline source."
git add .beads/
git commit -m "chore(bd): close 1gg0.25

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
git pull --rebase
git push
git status        # MUST show "up to date with origin"
```

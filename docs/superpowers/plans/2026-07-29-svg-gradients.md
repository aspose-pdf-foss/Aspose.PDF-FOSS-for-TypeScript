# SVG gradients → PDF shadings Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `page.AddSVGObject` render `linearGradient` / `radialGradient` fills and
strokes as PDF shading patterns instead of skipping them.

**Architecture:** A new pure module `src/svggradient.ts` maps a gradient `XmlNode` onto a
**PatternType 2** pattern dict (ShadingType 2 or 3, with a type 2 or type 3 stitching
function inside). Everything it builds is a *direct* dict, so `svgdraw.ts` keeps its
existing property: it imports no `Document` and allocates no indirect objects. `svgdraw.ts`
gains an accumulated CTM and a shape bounding box, both of which the pattern `/Matrix`
needs; `svgpath.ts` gains a tight `segsBBox`; `svgstyle.ts` carries the `url(#…)` id through
the cascade instead of discarding it.

**Tech Stack:** TypeScript (ESM, NodeNext, `strict`), vitest. No runtime dependencies.

**Design doc:** `docs/superpowers/specs/2026-07-28-svg-gradients-design.md`. Issue:
`aspose-pdf-foss-for-ts-1gg0.7`.

## Global Constraints

- **Zero runtime dependencies.** Only `node:` built-ins. Do not add npm runtime deps.
- **ESM + NodeNext.** Every relative import specifier carries the `.js` extension
  (`import { mul } from './text.js'`).
- `src/svggradient.ts`, `src/svgpath.ts`, `src/svgstyle.ts`, `src/svgtransform.ts` must
  **not** import `./document.js` or `./page.js`. `svgembed.ts` is the only SVG module that
  touches a `Document`.
- `svgdraw.ts` allocates **no indirect objects**: every resource it produces is a direct
  `PdfDict` placed into the Form XObject's own `/Resources`.
- Matrix convention: `mul(m, n)` from `src/text.ts` is "**m followed by n**" (row vectors,
  leftmost applied first). `Matrix` is `[a, b, c, d, e, f]`. `invert(m)` **throws** on a
  singular linear part — always guard it.
- Colour space is `/DeviceRGB` throughout. `Rgb` is `[number, number, number]` in 0..1.
- Run `npm run typecheck` and `npm test` before closing any task; both must be green.
- Target a single test file with `npx vitest run test/<name>.test.ts`.
- Commit after every task. Commit messages end with:
  `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`

## Deviations from the design doc

Two, both deliberate; note them in the commit messages.

1. **CTM threading, not a stack.** The design says "`Emitter` gains a CTM stack pushed and
   popped in lockstep with every `q` / `Q` it already emits." `svgdraw.ts` emits `q`/`Q` in
   four places and only one of them changes the CTM, so a lockstep stack would push
   duplicate entries in `paintShape` and `emitClip` purely to stay in step — a bug waiting
   to happen. This plan threads the accumulated matrix as a parameter of `walk` instead.
   Same information, no lockstep invariant to violate.
2. **The `segsBBox` discriminating fixture is not a circle.** The design says a
   control-point-hull bbox "would inset every `objectBoundingBox` gradient on any curved
   shape" and proposes a circle as the test. That is wrong in both halves: a hull bbox
   *expands*, never insets, and for an axis-aligned circle it does not even expand — the
   control points of `ellipseSegs` are at `(±r, ±kr)` and `(±kr, ±r)`, whose per-axis
   extremes are exactly `±r`. So a hull implementation passes the circle test. Task 1 keeps
   the circle (it is still a good independent-formula check) and **adds**
   `M0 0 C0 10 10 10 10 0`, whose tight height is 7.5 and whose hull height is 10. That
   second case is the one that fails a hull implementation.

## File structure

| File | Status | Responsibility |
|---|---|---|
| `src/svggradient.ts` | **new** | The whole SVG-gradient → PDF-pattern mapping. Pure: href resolution, stop parsing and normalization, function build, coords, spread synthesis, pattern matrix. Never imports `Document`. |
| `src/svgpath.ts` | modify | Add `segsBBox` — tight bbox of normalized segments via exact cubic extrema. |
| `src/svgstyle.ts` | modify | `Paint` gains `fillRef` / `strokeRef`; export the `style=`-over-attributes lookup so `svggradient.ts` can read `<stop>` properties through the same cascade. |
| `src/svgdraw.ts` | modify | Thread the accumulated CTM; compute the shape bbox when a gradient paint applies; own the `/Pattern` resource sub-dict and its dedupe; emit `scn` / `SCN`. |
| `src/svgembed.ts` | modify | Pass the resolved `ViewBox` into `drawSvg`. |
| `test/svg-path.test.ts` | modify | `segsBBox` tests. |
| `test/svg-style.test.ts` | modify | `fillRef` / `strokeRef` tests. |
| `test/svg-gradient.test.ts` | **new** | The pure mapping: stops, functions, coords, matrix, spread, href. |
| `test/svg-draw.test.ts` | modify | Emission: `/Pattern cs` + `scn`, dedupe, CTM in `/Matrix`, opacity folding, `skipped`. |
| `test/svg-gradient-render.test.ts` | **new** | End to end: `AddSVGObject` → `Save`/`Open` → `ToImage` → pixel assertions. |
| `README.md` | modify | Gradient support and the two limitations. |

---

### Task 1: `segsBBox` — the tight bounding box of a normalized path

**Files:**
- Modify: `src/svgpath.ts` (append at end of file)
- Test: `test/svg-path.test.ts` (append a new `describe`)

**Interfaces:**
- Consumes: `SvgSeg` (already exported from `src/svgpath.ts`).
- Produces:
  ```ts
  export interface SegBBox { x: number; y: number; w: number; h: number }
  export function segsBBox(segs: SvgSeg[]): SegBBox | null
  ```
  Returns `null` when `segs` contributes no points. Tasks 6, 7 and 8 consume it.

- [ ] **Step 1: Write the failing tests**

Append to `test/svg-path.test.ts`. Also extend the import at the top of that file from
`'../src/svgpath.js'` to include `segsBBox`.

```ts
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/svg-path.test.ts`
Expected: FAIL — `segsBBox is not a function` / TypeScript cannot resolve the import.

- [ ] **Step 3: Implement `segsBBox`**

Append to `src/svgpath.ts`:

```ts
/** An axis-aligned box in the coordinate system the segments are expressed in. */
export interface SegBBox { x: number; y: number; w: number; h: number }

/** The parameters in (0, 1) where a cubic's derivative vanishes on one axis.
 *  B'(t)/3 = a t^2 + b t + c with A = p1-p0, B = p2-p1, C = p3-p2:
 *  a = A - 2B + C, b = 2(B - A), c = A. */
function cubicExtrema(p0: number, p1: number, p2: number, p3: number): number[] {
  const A = p1 - p0, B = p2 - p1, C = p3 - p2;
  const a = A - 2 * B + C, b = 2 * (B - A), c = A;
  const ts: number[] = [];
  if (Math.abs(a) < 1e-12) {
    if (Math.abs(b) > 1e-12) ts.push(-c / b);
  } else {
    const disc = b * b - 4 * a * c;
    if (disc >= 0) {
      const s = Math.sqrt(disc);
      ts.push((-b + s) / (2 * a), (-b - s) / (2 * a));
    }
  }
  return ts.filter((t) => t > 0 && t < 1);
}

const cubicAt = (p0: number, p1: number, p2: number, p3: number, t: number): number => {
  const u = 1 - t;
  return u * u * u * p0 + 3 * u * u * t * p1 + 3 * u * t * t * p2 + t * t * t * p3;
};

/** The TIGHT bounding box of normalized segments, in their own coordinate system:
 *  endpoints plus each cubic's exact per-axis extrema. Returns null when the list
 *  contributes no points.
 *
 *  The control-point hull is NOT an acceptable substitute — it reports a larger
 *  box than the curve occupies, which would stretch every objectBoundingBox
 *  gradient on a curved shape. */
export function segsBBox(segs: SvgSeg[]): SegBBox | null {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const add = (x: number, y: number): void => {
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  };
  let cx = 0, cy = 0;
  for (const s of segs) {
    if (s.op === 'M' || s.op === 'L') {
      cx = s.args[0]; cy = s.args[1];
      add(cx, cy);
    } else if (s.op === 'C') {
      const [x1, y1, x2, y2, x3, y3] = s.args;
      add(x3, y3);
      for (const t of cubicExtrema(cx, x1, x2, x3)) add(cubicAt(cx, x1, x2, x3, t), cy);
      for (const t of cubicExtrema(cy, y1, y2, y3)) add(cx, cubicAt(cy, y1, y2, y3, t));
      cx = x3; cy = y3;
    }
    // Z closes back to a point already included by its subpath's M.
  }
  if (!Number.isFinite(minX)) return null;
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}
```

Note the two `add` calls inside the `C` branch each pass a *dummy* value for the other
axis (`cy` / `cx`), which are already-included points, so they cannot widen the box on the
axis they are not solving for.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/svg-path.test.ts`
Expected: PASS.

- [ ] **Step 5: Prove the extrema assertion is load-bearing**

Temporarily replace the two `cubicExtrema` loops in the `C` branch with hull points
(`add(x1, y1); add(x2, y2);`) and re-run.
Expected: the "uses the cubic extremum, not the control-point hull" test FAILS with
`h` = 10 instead of 7.5, and the circle test still passes. Revert the mutation.

- [ ] **Step 6: Typecheck and commit**

```bash
npm run typecheck
npx vitest run test/svg-path.test.ts
git add src/svgpath.ts test/svg-path.test.ts
git commit -m "feat(svg): tight segsBBox via exact cubic extrema (1gg0.7)"
```

---

### Task 2: carry `url(#…)` paint references through the style cascade

**Files:**
- Modify: `src/svgstyle.ts:7-19` (the `Paint` interface), `:23-35` (`INITIAL`),
  `:123-130` (`parsePaint`), `:139-148` (`parseInlineStyle`), `:154-208` (`resolveStyle`)
- Test: `test/svg-style.test.ts` (append a new `describe`)

**Interfaces:**
- Consumes: nothing new.
- Produces:
  ```ts
  // added to the existing Paint interface
  fillRef: string | null;      // the id from fill="url(#id)", else null
  strokeRef: string | null;    // likewise for stroke
  // new export
  export function styleGetter(attrs: Map<string, string>): (k: string) => string | undefined;
  ```
  Task 4 consumes `styleGetter`; Task 8 consumes `fillRef` / `strokeRef`.

- [ ] **Step 1: Write the failing tests**

Append to `test/svg-style.test.ts` (it already imports `resolveStyle` and `INITIAL`; add
`styleGetter` to that import):

```ts
describe('resolveStyle — paint references', () => {
  const attrs = (o: Record<string, string>) => new Map(Object.entries(o));

  it('records a url() fill id and leaves the fill unpainted with no fallback', () => {
    const { paint, refs } = resolveStyle(INITIAL, attrs({ fill: 'url(#g)' }));
    expect(paint.fillRef).toBe('g');
    expect(paint.fill).toBeNull();
    expect(refs).toEqual(['g']);
  });

  it('keeps the explicit fallback colour alongside the reference', () => {
    const { paint } = resolveStyle(INITIAL, attrs({ fill: 'url(#g) red' }));
    expect(paint.fillRef).toBe('g');
    expect(paint.fill).toEqual([1, 0, 0]);
  });

  it('records a url() stroke id independently of the fill', () => {
    const { paint } = resolveStyle(INITIAL, attrs({ stroke: 'url(#s)', fill: 'blue' }));
    expect(paint.strokeRef).toBe('s');
    expect(paint.fillRef).toBeNull();
    expect(paint.fill).toEqual([0, 0, 1]);
  });

  it('clears an inherited reference when the child names a solid colour', () => {
    const { paint: parent } = resolveStyle(INITIAL, attrs({ fill: 'url(#g)' }));
    const { paint } = resolveStyle(parent, attrs({ fill: 'green' }));
    expect(paint.fillRef).toBeNull();
    expect(paint.fill).toEqual([0, 0.5019607843137255, 0]);
  });

  it('inherits a reference when the child declares no fill at all', () => {
    const { paint: parent } = resolveStyle(INITIAL, attrs({ fill: 'url(#g)' }));
    const { paint } = resolveStyle(parent, attrs({ stroke: 'red' }));
    expect(paint.fillRef).toBe('g');
  });

  it('reads a reference out of inline style=, which beats the attribute', () => {
    const { paint } = resolveStyle(INITIAL,
      attrs({ fill: 'red', style: 'fill: url(#g)' }));
    expect(paint.fillRef).toBe('g');
  });

  it('INITIAL carries no references', () => {
    expect(INITIAL.fillRef).toBeNull();
    expect(INITIAL.strokeRef).toBeNull();
  });
});

describe('styleGetter', () => {
  it('prefers an inline style declaration over the presentation attribute', () => {
    const g = styleGetter(new Map([['stop-color', 'red'], ['style', 'stop-color: blue']]));
    expect(g('stop-color')).toBe('blue');
  });

  it('falls back to the attribute and returns undefined for an absent property', () => {
    const g = styleGetter(new Map([['offset', '50%']]));
    expect(g('offset')).toBe('50%');
    expect(g('stop-opacity')).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/svg-style.test.ts`
Expected: FAIL — `styleGetter` is not exported and `paint.fillRef` is `undefined`.

- [ ] **Step 3: Implement the change**

In `src/svgstyle.ts`, add the two fields to `Paint` (after `stroke`):

```ts
  /** The id from `fill="url(#id)"`, else null. Kept so a gradient reference
   *  survives the cascade; `fill` still holds the explicit fallback colour, or
   *  null when the paint gave none. */
  fillRef: string | null;
  /** Likewise for `stroke="url(#id)"`. */
  strokeRef: string | null;
```

Add them to `INITIAL`:

```ts
  fillRef: null,
  strokeRef: null,
```

Change `parsePaint` to report the id back to the caller. Replace its body:

```ts
/** A paint value, which may be a url() reference with an optional fallback.
 *  `out.ref` is set to the referenced id when there is one. */
function parsePaint(v: string, refs: string[], out: { ref: string | null }):
Rgb | null | undefined {
  const m = /^url\(\s*#([^)\s]+)\s*\)\s*(.*)$/.exec(v.trim());
  if (!m) { out.ref = null; return parseColor(v); }
  refs.push(m[1]);
  out.ref = m[1];
  // SVG: fall back to the colour after the reference, else to none. Never to
  // black — a silently wrong solid fill is worse than a visibly missing one.
  return m[2].trim() === '' ? null : parseColor(m[2]);
}
```

Extract the cascade lookup as a named export, replacing the inline `get` in
`resolveStyle`. Put it right after `parseInlineStyle`:

```ts
/** One element's property lookup: inline `style=` beats presentation attributes
 *  (CSS wins). Exported because <stop> children take stop-color / stop-opacity
 *  / offset through exactly the same cascade. */
export function styleGetter(attrs: Map<string, string>): (k: string) => string | undefined {
  const inline = parseInlineStyle(attrs.get('style'));
  return (k: string): string | undefined => inline.get(k) ?? attrs.get(k);
}
```

In `resolveStyle`, replace the first three lines of the body and the two paint blocks:

```ts
  const get = styleGetter(attrs);
  const refs: string[] = [];
  const p: Paint = { ...parent, dash: [...parent.dash] };

  const fill = get('fill');
  if (fill !== undefined) {
    const out = { ref: null as string | null };
    const c = parsePaint(fill, refs, out);
    p.fillRef = out.ref;
    if (c !== undefined) p.fill = c;
    else if (out.ref !== null) p.fill = null;
  }
  const stroke = get('stroke');
  if (stroke !== undefined) {
    const out = { ref: null as string | null };
    const c = parsePaint(stroke, refs, out);
    p.strokeRef = out.ref;
    if (c !== undefined) p.stroke = c;
    else if (out.ref !== null) p.stroke = null;
  }
```

(The `else if` arm covers `fill="url(#g) bogus"` — an unparseable fallback next to a
reference. Today that would leave the inherited colour in place; with a reference present
the reference is what should decide, so the fallback becomes "none".)

Delete the now-unused `const inline = parseInlineStyle(...)` line and the old inline
`const get = ...` arrow from `resolveStyle`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/svg-style.test.ts test/svg-draw.test.ts test/svg-embed.test.ts`
Expected: PASS. The existing `svg-draw` behaviour is unchanged — `refs` is still populated
identically, so the `skipped` list is still what it was.

- [ ] **Step 5: Typecheck and commit**

```bash
npm run typecheck
git add src/svgstyle.ts test/svg-style.test.ts
git commit -m "feat(svg): carry url(#id) paint references through the style cascade (1gg0.7)"
```

---

### Task 3: thread the accumulated CTM through the walker

**Files:**
- Modify: `src/svgdraw.ts:185-245` (`walk`), `:249-260` (`drawSvg`)
- Test: `test/svg-draw.test.ts` (append a `describe`; the assertion is indirect until
  Task 8, so this task ships a **temporary** export used only by the test)

**Interfaces:**
- Consumes: `mul`, `IDENTITY`, `type Matrix` from `src/text.js` (`IDENTITY` is already
  imported by `svgdraw.ts`; add `mul` and `Matrix`).
- Produces: `walk(e, n, parent, inDefs, ctm: Matrix)` — an internal signature change.
  Task 8 reads `ctm` inside `paintShape`. Also produces, for this task's test only:
  ```ts
  export function __ctmProbe(root: XmlNode): Matrix[];   // removed in Task 8
  ```

Rationale for threading rather than the design's `q`/`Q`-lockstep stack: see "Deviations"
above.

- [ ] **Step 1: Write the failing test**

Append to `test/svg-draw.test.ts` (add `__ctmProbe` to the `svgdraw.js` import):

```ts
describe('drawSvg — accumulated CTM', () => {
  const probe = (svg: string) => __ctmProbe(parseXml(new TextEncoder().encode(svg)));

  it('is identity for a shape at the root', () => {
    expect(probe('<svg><rect width="1" height="1"/></svg>')).toEqual([[1, 0, 0, 1, 0, 0]]);
  });

  it('carries an element transform', () => {
    expect(probe('<svg><rect transform="translate(3 4)" width="1" height="1"/></svg>'))
      .toEqual([[1, 0, 0, 1, 3, 4]]);
  });

  it('composes a nested group transform outermost-last', () => {
    // Inner scale(2) then outer translate(10,0): a point (1,1) in the rect's own
    // space lands at (12, 2).
    const [m] = probe('<svg><g transform="translate(10 0)">' +
      '<g transform="scale(2)"><rect width="1" height="1"/></g></g></svg>');
    expect(m).toEqual([2, 0, 0, 2, 10, 0]);
  });

  it('carries a <use> x/y shift into the target', () => {
    const [m] = probe('<svg><defs><rect id="r" width="1" height="1"/></defs>' +
      '<use href="#r" x="5" y="6"/></svg>');
    expect(m).toEqual([1, 0, 0, 1, 5, 6]);
  });

  it('pops back out of a group for a following sibling', () => {
    const ms = probe('<svg><g transform="translate(10 0)"><rect width="1" height="1"/></g>' +
      '<rect width="1" height="1"/></svg>');
    expect(ms).toEqual([[1, 0, 0, 1, 10, 0], [1, 0, 0, 1, 0, 0]]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/svg-draw.test.ts`
Expected: FAIL — `__ctmProbe` is not exported.

- [ ] **Step 3: Implement the threading**

In `src/svgdraw.ts`:

Extend the `text.js` import:

```ts
import { IDENTITY, mul, type Matrix } from './text.js';
```

Add a probe hook to `Emitter` (removed in Task 8):

```ts
  /** Test-only: the CTM in effect at each painted shape, in paint order. */
  ctms: Matrix[] | null = null;
```

Change `paintShape`'s signature to accept the CTM and record it (the body is otherwise
untouched for now):

```ts
function paintShape(e: Emitter, segs: SvgSeg[], p: Paint, ctm: Matrix): void {
  const doFill = p.fill !== null;
  const doStroke = p.stroke !== null && p.strokeWidth > 0;
  if (!doFill && !doStroke) return;
  if (segs.length === 0) return;
  if (e.ctms) e.ctms.push(ctm);
  // ... rest unchanged
```

Change `walk` to take and propagate the matrix:

```ts
function walk(e: Emitter, n: XmlNode, parent: Paint, inDefs: boolean, ctm: Matrix): void {
```

Inside it, after the existing `const tf = parseTransform(...)` / `hasTf` lines:

```ts
  const tf = parseTransform(n.attrs.get('transform'));
  const hasTf = tf.some((v, i) => v !== IDENTITY[i]);
  // The walker's own accumulated matrix, mirroring the `cm` it emits. PDF holds
  // the same value in its graphics state; a pattern /Matrix cannot read that
  // back, so it is tracked here too.
  const here = hasTf ? mul(tf, ctm) : ctm;
  if (hasTf) { e.out.push('q'); e.out.push(`${tf.map(num).join(' ')} cm`); }
```

Update the three recursion / paint sites inside `walk`:

```ts
      const shift = dx !== 0 || dy !== 0;
      if (shift) { e.out.push('q'); e.out.push(`1 0 0 1 ${num(dx)} ${num(dy)} cm`); }
      e.active.add(id);
      walk(e, target, paint, false, shift ? mul([1, 0, 0, 1, dx, dy], here) : here);
      e.active.delete(id);
```

```ts
      paintShape(e, segs, n.name === 'line' ? { ...paint, fill: null } : paint, here);
```

```ts
    const childrenInDefs = inDefs || n.name === 'defs' || n.name === 'symbol';
    for (const c of n.children) walk(e, c, paint, childrenInDefs, here);
```

Update `drawSvg`'s call and add the probe export:

```ts
export function drawSvg(root: XmlNode): DrawResult {
  const e = new Emitter();
  indexIds(root, e.ids);
  walk(e, root, INITIAL, false, [...IDENTITY]);
  // ... rest unchanged
}

/** Test-only (removed once the pattern /Matrix asserts this indirectly): the CTM
 *  in effect at each painted shape, in paint order. */
export function __ctmProbe(root: XmlNode): Matrix[] {
  const e = new Emitter();
  e.ctms = [];
  indexIds(root, e.ids);
  walk(e, root, INITIAL, false, [...IDENTITY]);
  return e.ctms;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/svg-draw.test.ts`
Expected: PASS, including every pre-existing test in the file — the emitted content stream
must be byte-identical to before, since nothing in the emission changed.

- [ ] **Step 5: Prove the composition order is load-bearing**

Temporarily change `mul(tf, ctm)` to `mul(ctm, tf)` and re-run.
Expected: "composes a nested group transform outermost-last" FAILS with
`[2, 0, 0, 2, 20, 0]` (the outer translation scaled by the inner scale). Revert.

- [ ] **Step 6: Typecheck and commit**

```bash
npm run typecheck
npx vitest run test/svg-draw.test.ts test/svg-embed.test.ts
git add src/svgdraw.ts test/svg-draw.test.ts
git commit -m "feat(svg): thread the accumulated CTM through the SVG walker (1gg0.7)"
```

---

### Task 4: `svggradient.ts` — href resolution and stop normalization

**Files:**
- Create: `src/svggradient.ts`
- Test: `test/svg-gradient.test.ts` (new)

**Interfaces:**
- Consumes: `XmlNode` from `src/xml.js`; `parseColor`, `styleGetter`, `type Rgb` from
  `src/svgstyle.js`.
- Produces:
  ```ts
  export interface GradientStop { offset: number; color: Rgb; opacity: number }

  export interface ResolvedGradient {
    kind: 'linear' | 'radial';
    /** Own attributes, with anything unset filled in from the href chain. */
    attrs: Map<string, string>;
    /** Raw stops in document order, before normalization. */
    stops: GradientStop[];
  }

  export function resolveGradient(node: XmlNode, ids: Map<string, XmlNode>): ResolvedGradient;
  export function normalizeStops(stops: GradientStop[]): GradientStop[];
  ```
  Tasks 5, 6 and 7 consume all three.

- [ ] **Step 1: Write the failing tests**

Create `test/svg-gradient.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { parseXml, type XmlNode } from '../src/xml.js';
import { resolveGradient, normalizeStops, type GradientStop } from '../src/svggradient.js';

/** Parse an <svg> body and index every element carrying an id. */
export function ids(svg: string): Map<string, XmlNode> {
  const root = parseXml(new TextEncoder().encode(svg));
  const m = new Map<string, XmlNode>();
  const visit = (n: XmlNode): void => {
    const id = n.attrs.get('id');
    if (id !== undefined && !m.has(id)) m.set(id, n);
    for (const c of n.children) visit(c);
  };
  visit(root);
  return m;
}

const grad = (svg: string, id: string) => {
  const map = ids(svg);
  return resolveGradient(map.get(id)!, map);
};

describe('resolveGradient — stops', () => {
  it('parses offsets, colours and opacities', () => {
    const g = grad('<svg><linearGradient id="g">' +
      '<stop offset="0" stop-color="red"/>' +
      '<stop offset="0.5" stop-color="#0f0" stop-opacity="0.5"/>' +
      '<stop offset="100%" stop-color="blue"/>' +
      '</linearGradient></svg>', 'g');
    expect(g.kind).toBe('linear');
    expect(g.stops).toEqual([
      { offset: 0, color: [1, 0, 0], opacity: 1 },
      { offset: 0.5, color: [0, 1, 0], opacity: 0.5 },
      { offset: 1, color: [0, 0, 1], opacity: 1 },
    ]);
  });

  it('takes stop properties through the style= cascade', () => {
    const g = grad('<svg><linearGradient id="g">' +
      '<stop offset="0" stop-color="red" style="stop-color: blue; stop-opacity: 0.25"/>' +
      '</linearGradient></svg>', 'g');
    expect(g.stops[0].color).toEqual([0, 0, 1]);
    expect(g.stops[0].opacity).toBe(0.25);
  });

  it('defaults a missing stop-color to black and resolves currentColor to black', () => {
    const g = grad('<svg><linearGradient id="g">' +
      '<stop offset="0"/>' +
      '<stop offset="1" stop-color="currentColor"/>' +
      '</linearGradient></svg>', 'g');
    expect(g.stops[0].color).toEqual([0, 0, 0]);
    expect(g.stops[1].color).toEqual([0, 0, 0]);
  });

  it('clamps offsets into [0, 1] and ignores non-stop children', () => {
    const g = grad('<svg><linearGradient id="g"><desc>x</desc>' +
      '<stop offset="-3" stop-color="red"/>' +
      '<stop offset="7" stop-color="blue"/>' +
      '</linearGradient></svg>', 'g');
    expect(g.stops.map((s) => s.offset)).toEqual([0, 1]);
  });

  it('reports a radial gradient as radial', () => {
    expect(grad('<svg><radialGradient id="g"/></svg>', 'g').kind).toBe('radial');
  });
});

describe('resolveGradient — href reuse', () => {
  const SVG =
    '<svg><defs>' +
    '<linearGradient id="base" gradientUnits="userSpaceOnUse" spreadMethod="reflect" x1="1">' +
    '<stop offset="0" stop-color="red"/><stop offset="1" stop-color="blue"/>' +
    '</linearGradient>' +
    '<linearGradient id="own" href="#base" x1="9">' +
    '<stop offset="0" stop-color="lime"/><stop offset="1" stop-color="black"/>' +
    '</linearGradient>' +
    '<linearGradient id="inherit" href="#base"/>' +
    '<linearGradient id="xlink" xlink:href="#base"/>' +
    '<radialGradient id="cross" href="#base" cx="3"/>' +
    '<linearGradient id="self" href="#self"/>' +
    '<linearGradient id="loopA" href="#loopB"/>' +
    '<linearGradient id="loopB" href="#loopA"/>' +
    '<linearGradient id="dangling" href="#nope" x1="4"/>' +
    '</defs></svg>';

  it('inherits stops when the child declares none', () => {
    expect(grad(SVG, 'inherit').stops.map((s) => s.color))
      .toEqual([[1, 0, 0], [0, 0, 1]]);
  });

  it('keeps its own stops when it declares any', () => {
    expect(grad(SVG, 'own').stops.map((s) => s.color))
      .toEqual([[0, 1, 0], [0, 0, 0]]);
  });

  it('inherits attributes that are unset and keeps those that are set', () => {
    const g = grad(SVG, 'own');
    expect(g.attrs.get('x1')).toBe('9');
    expect(g.attrs.get('gradientUnits')).toBe('userSpaceOnUse');
    expect(g.attrs.get('spreadMethod')).toBe('reflect');
  });

  it('accepts the legacy xlink:href spelling', () => {
    // xml.ts strips the namespace prefix from attribute names, so this arrives
    // as a plain `href` — the test pins that end-to-end behaviour, not a
    // separate code path.
    expect(grad(SVG, 'xlink').stops).toHaveLength(2);
  });

  it('inherits across gradient types, keeping the child kind', () => {
    const g = grad(SVG, 'cross');
    expect(g.kind).toBe('radial');
    expect(g.stops).toHaveLength(2);
    expect(g.attrs.get('cx')).toBe('3');
    expect(g.attrs.get('spreadMethod')).toBe('reflect');
  });

  it('terminates on a self reference and on a two-node cycle', () => {
    expect(grad(SVG, 'self').stops).toEqual([]);
    expect(grad(SVG, 'loopA').stops).toEqual([]);
  });

  it('ignores an href that does not resolve', () => {
    const g = grad(SVG, 'dangling');
    expect(g.stops).toEqual([]);
    expect(g.attrs.get('x1')).toBe('4');
  });
});

describe('normalizeStops', () => {
  const s = (offset: number, color: [number, number, number]): GradientStop =>
    ({ offset, color, opacity: 1 });

  it('extends the ends to 0 and 1, repeating the adjacent colour', () => {
    expect(normalizeStops([s(0.25, [1, 0, 0]), s(0.75, [0, 0, 1])])).toEqual([
      s(0, [1, 0, 0]), s(0.25, [1, 0, 0]), s(0.75, [0, 0, 1]), s(1, [0, 0, 1]),
    ]);
  });

  it('leaves a list that already spans 0..1 alone', () => {
    const list = [s(0, [1, 0, 0]), s(1, [0, 0, 1])];
    expect(normalizeStops(list)).toEqual(list);
  });

  it('forces an out-of-order offset up to its predecessor', () => {
    expect(normalizeStops([s(0, [1, 0, 0]), s(0.8, [0, 1, 0]), s(0.2, [0, 0, 1]), s(1, [0, 0, 0])])
      .map((x) => x.offset)).toEqual([0, 0.8, 0.8, 1]);
  });

  it('preserves a doubled offset, which is the hard colour edge', () => {
    const out = normalizeStops([s(0, [1, 0, 0]), s(0.5, [1, 0, 0]), s(0.5, [0, 0, 1]), s(1, [0, 0, 1])]);
    expect(out.map((x) => x.offset)).toEqual([0, 0.5, 0.5, 1]);
    expect(out[1].color).toEqual([1, 0, 0]);
    expect(out[2].color).toEqual([0, 0, 1]);
  });

  it('passes an empty and a single-stop list through untouched', () => {
    expect(normalizeStops([])).toEqual([]);
    expect(normalizeStops([s(0.4, [1, 0, 0])])).toEqual([s(0.4, [1, 0, 0])]);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/svg-gradient.test.ts`
Expected: FAIL — `Cannot find module '../src/svggradient.js'`.

- [ ] **Step 3: Implement**

Create `src/svggradient.ts`:

```ts
// SVG gradients -> PDF shading patterns (issue 1gg0.7). Pure: it builds DIRECT
// PdfDicts and touches no Document, so svgdraw.ts keeps allocating no indirect
// objects. Direction note: svgrender.ts is PDF->SVG and shares nothing with this.
import type { XmlNode } from './xml.js';
import { parseColor, styleGetter, type Rgb } from './svgstyle.js';

/** One gradient stop, offset already clamped into [0, 1]. */
export interface GradientStop {
  offset: number;
  color: Rgb;
  opacity: number;
}

/** A gradient element with its href chain already flattened. */
export interface ResolvedGradient {
  kind: 'linear' | 'radial';
  /** Own attributes, with anything unset filled in from the href chain. */
  attrs: Map<string, string>;
  /** Raw stops in document order, before normalization. */
  stops: GradientStop[];
}

const clamp01 = (n: number): number => (n < 0 ? 0 : n > 1 ? 1 : n);

const numOr = (v: string | undefined, dflt: number): number => {
  if (v === undefined) return dflt;
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : dflt;
};

/** An `offset`: a number, or a percentage. Clamped into [0, 1] per SVG. */
function parseOffset(v: string | undefined): number {
  if (v === undefined) return 0;
  const t = v.trim();
  const n = parseFloat(t);
  if (!Number.isFinite(n)) return 0;
  return clamp01(t.endsWith('%') ? n / 100 : n);
}

/** The stops declared directly on one gradient element. */
function ownStops(node: XmlNode): GradientStop[] {
  const out: GradientStop[] = [];
  for (const c of node.children) {
    if (c.name !== 'stop') continue;
    const get = styleGetter(c.attrs);
    const raw = get('stop-color');
    // `currentColor` resolves to black: the CSS default with no `color` property
    // in effect, and this stack does not track `color`. An unparseable or `none`
    // value is invalid for stop-color, which SVG also renders as black.
    const c0 = raw === undefined || raw.trim().toLowerCase() === 'currentcolor'
      ? undefined : parseColor(raw);
    out.push({
      offset: parseOffset(get('offset')),
      color: c0 ?? [0, 0, 0],
      opacity: clamp01(numOr(get('stop-opacity'), 1)),
    });
  }
  return out;
}

/** The attributes a gradient inherits through href, i.e. all of them: SVG lets a
 *  linearGradient inherit from a radialGradient, and the other type's geometry
 *  attributes are simply never read.
 *
 *  Note xml.ts strips namespace prefixes from ATTRIBUTE names as well as element
 *  names, so `xlink:href` has already arrived here as plain `href`. The explicit
 *  'xlink:href' lookups below are belt-and-braces and cost nothing. */
const NOT_INHERITED = new Set(['id', 'href', 'xlink:href']);

/** Flatten a gradient's `href` / `xlink:href` chain: stops are inherited when the
 *  child declares none, and each attribute when unset on the child. A visited set
 *  breaks reference cycles, matching the guard <use> already has. */
export function resolveGradient(node: XmlNode, ids: Map<string, XmlNode>): ResolvedGradient {
  const kind: 'linear' | 'radial' = node.name === 'radialGradient' ? 'radial' : 'linear';
  const attrs = new Map(node.attrs);
  let stops = ownStops(node);
  const seen = new Set<string>();
  const selfId = node.attrs.get('id');
  if (selfId !== undefined) seen.add(selfId);

  let cur: XmlNode | undefined = node;
  for (;;) {
    const href = cur.attrs.get('href') ?? cur.attrs.get('xlink:href');
    if (href === undefined || href[0] !== '#') break;
    const id = href.slice(1);
    if (id === '' || seen.has(id)) break;
    seen.add(id);
    const next = ids.get(id);
    if (!next || (next.name !== 'linearGradient' && next.name !== 'radialGradient')) break;
    for (const [k, v] of next.attrs) {
      if (!NOT_INHERITED.has(k) && !attrs.has(k)) attrs.set(k, v);
    }
    if (stops.length === 0) stops = ownStops(next);
    cur = next;
  }
  return { kind, attrs, stops };
}

/** Prepare stops for a PDF function: offsets forced non-decreasing, then a stop
 *  added at 0 and at 1 when the list does not already reach them (repeating the
 *  adjacent colour). That makes /Domain [0 1] exact.
 *
 *  Doubled offsets are KEPT — they are what turns into a hard colour edge. The
 *  zero-width interval they create is dropped later, in stopsFunction, which is
 *  also what satisfies PDF's requirement that /Bounds be strictly increasing. */
export function normalizeStops(stops: GradientStop[]): GradientStop[] {
  if (stops.length < 2) return stops.map((s) => ({ ...s }));
  const out = stops.map((s) => ({ ...s }));
  for (let i = 1; i < out.length; i++) {
    if (out[i].offset < out[i - 1].offset) out[i].offset = out[i - 1].offset;
  }
  if (out[0].offset > 0) out.unshift({ ...out[0], offset: 0 });
  const last = out[out.length - 1];
  if (last.offset < 1) out.push({ ...last, offset: 1 });
  return out;
}
```

Note the `for (;;)` loop reassigns `cur`, so declare it `let cur: XmlNode | undefined` —
TypeScript narrows it to `XmlNode` after the `if (!next …) break`, which is why the
assignment `cur = next` typechecks.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/svg-gradient.test.ts`
Expected: PASS.

- [ ] **Step 5: Prove the cycle guard is load-bearing**

Temporarily delete the `if (id === '' || seen.has(id)) break;` line and re-run.
Expected: "terminates on a self reference and on a two-node cycle" hangs or throws a
stack/timeout error. Revert.

- [ ] **Step 6: Typecheck and commit**

```bash
npm run typecheck
git add src/svggradient.ts test/svg-gradient.test.ts
git commit -m "feat(svg): gradient href resolution and stop normalization (1gg0.7)"
```

---

### Task 5: `svggradient.ts` — the PDF colour function

**Files:**
- Modify: `src/svggradient.ts` (append)
- Test: `test/svg-gradient.test.ts` (append a `describe`)

**Interfaces:**
- Consumes: `GradientStop`, `normalizeStops` (Task 4); `type PdfDict`, `type PdfObject`
  from `src/types.js`.
- Produces:
  ```ts
  /** Requires stops already through normalizeStops, with >= 1 positive-width
   *  interval. Returns a direct type 2 or type 3 function dict. */
  export function stopsFunction(stops: GradientStop[]): PdfDict;
  ```
  Tasks 6 and 7 consume it.

- [ ] **Step 1: Write the failing tests**

Append to `test/svg-gradient.test.ts` (extend the `svggradient.js` import with
`stopsFunction`, and add `import type { PdfDict } from '../src/types.js';`):

```ts
describe('stopsFunction', () => {
  const s = (offset: number, color: [number, number, number]): GradientStop =>
    ({ offset, color, opacity: 1 });
  const fn = (list: GradientStop[]) => stopsFunction(normalizeStops(list));

  it('emits one type 2 exponential for two stops', () => {
    const f = fn([s(0, [1, 0, 0]), s(1, [0, 0, 1])]);
    expect(f.get('FunctionType')).toBe(2);
    expect(f.get('Domain')).toEqual([0, 1]);
    expect(f.get('C0')).toEqual([1, 0, 0]);
    expect(f.get('C1')).toEqual([0, 0, 1]);
    expect(f.get('N')).toBe(1);
  });

  it('stitches type 2s for three stops, with the interior offset as the bound', () => {
    const f = fn([s(0, [1, 0, 0]), s(0.25, [0, 1, 0]), s(1, [0, 0, 1])]);
    expect(f.get('FunctionType')).toBe(3);
    expect(f.get('Domain')).toEqual([0, 1]);
    expect(f.get('Bounds')).toEqual([0.25]);
    expect(f.get('Encode')).toEqual([0, 1, 0, 1]);
    const subs = f.get('Functions') as PdfDict[];
    expect(subs).toHaveLength(2);
    expect(subs[0].get('C0')).toEqual([1, 0, 0]);
    expect(subs[0].get('C1')).toEqual([0, 1, 0]);
    expect(subs[1].get('C0')).toEqual([0, 1, 0]);
    expect(subs[1].get('C1')).toEqual([0, 0, 1]);
  });

  it('drops the zero-width interval of a hard stop, keeping /Bounds strictly increasing', () => {
    const f = fn([s(0, [1, 0, 0]), s(0.5, [1, 0, 0]), s(0.5, [0, 0, 1]), s(1, [0, 0, 1])]);
    expect(f.get('FunctionType')).toBe(3);
    expect(f.get('Bounds')).toEqual([0.5]);
    const subs = f.get('Functions') as PdfDict[];
    expect(subs).toHaveLength(2);
    expect(subs[0].get('C1')).toEqual([1, 0, 0]);   // flat red up to 0.5
    expect(subs[1].get('C0')).toEqual([0, 0, 1]);   // flat blue after 0.5
  });

  it('keeps /Bounds strictly increasing across two adjacent hard stops', () => {
    const f = fn([
      s(0, [1, 0, 0]), s(0.3, [1, 0, 0]), s(0.3, [0, 1, 0]),
      s(0.6, [0, 1, 0]), s(0.6, [0, 0, 1]), s(1, [0, 0, 1]),
    ]);
    const bounds = f.get('Bounds') as number[];
    expect(bounds).toEqual([0.3, 0.6]);
    for (let i = 1; i < bounds.length; i++) expect(bounds[i]).toBeGreaterThan(bounds[i - 1]);
    expect((f.get('Functions') as PdfDict[])).toHaveLength(3);
  });

  it('turns two stops at one offset into a flat-then-flat hard edge', () => {
    // normalizeStops pads to [red@0, red@.5, blue@.5, blue@1]; the two surviving
    // intervals are each a constant colour, so the whole thing is a step.
    const f = fn([s(0.5, [1, 0, 0]), s(0.5, [0, 0, 1])]);
    expect(f.get('FunctionType')).toBe(3);
    expect(f.get('Bounds')).toEqual([0.5]);
    const subs = f.get('Functions') as PdfDict[];
    expect(subs[0].get('C0')).toEqual([1, 0, 0]);
    expect(subs[0].get('C1')).toEqual([1, 0, 0]);
    expect(subs[1].get('C0')).toEqual([0, 0, 1]);
    expect(subs[1].get('C1')).toEqual([0, 0, 1]);
  });

  it('emits /Encode with one [0 1] pair per sub-function', () => {
    const f = fn([s(0, [1, 0, 0]), s(0.2, [0, 1, 0]), s(0.7, [0, 0, 1]), s(1, [0, 0, 0])]);
    expect(f.get('Encode')).toEqual([0, 1, 0, 1, 0, 1]);
    expect(f.get('Bounds')).toEqual([0.2, 0.7]);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/svg-gradient.test.ts`
Expected: FAIL — `stopsFunction is not a function`.

- [ ] **Step 3: Implement**

Add to `src/svggradient.ts` — first extend the imports:

```ts
import type { PdfDict, PdfObject } from './types.js';
```

then append:

```ts
const dict = (entries: [string, PdfObject][]): PdfDict => new Map<string, PdfObject>(entries);

/** A type 2 exponential over [0, 1], linear (/N 1) between two colours. */
function rampFunction(c0: Rgb, c1: Rgb): PdfDict {
  return dict([
    ['FunctionType', 2],
    ['Domain', [0, 1]],
    ['C0', [...c0]],
    ['C1', [...c1]],
    ['N', 1],
  ]);
}

/** The colour function for a normalized stop list, over /Domain [0 1].
 *
 *  One positive-width interval -> a bare type 2. More -> a type 3 stitching
 *  function over them. Zero-width intervals (a doubled offset, i.e. a hard colour
 *  edge) contribute NO sub-function, which is exactly what keeps /Bounds strictly
 *  increasing as PDF requires while still producing the edge.
 *
 *  Caller guarantees at least two stops and at least one positive-width interval;
 *  the degenerate cases are decided before this is reached. */
export function stopsFunction(stops: GradientStop[]): PdfDict {
  const subs: PdfDict[] = [];
  const bounds: number[] = [];
  for (let i = 0; i + 1 < stops.length; i++) {
    if (!(stops[i + 1].offset > stops[i].offset)) continue;
    if (subs.length > 0) bounds.push(stops[i].offset);
    subs.push(rampFunction(stops[i].color, stops[i + 1].color));
  }
  if (subs.length === 1) return subs[0];
  const encode: number[] = [];
  for (let i = 0; i < subs.length; i++) encode.push(0, 1);
  return dict([
    ['FunctionType', 3],
    ['Domain', [0, 1]],
    ['Functions', subs],
    ['Bounds', bounds],
    ['Encode', encode],
  ]);
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/svg-gradient.test.ts`
Expected: PASS.

- [ ] **Step 5: Prove the zero-width drop is load-bearing**

Temporarily remove the `if (!(stops[i + 1].offset > stops[i].offset)) continue;` guard and
re-run.
Expected: "drops the zero-width interval of a hard stop" FAILS with three sub-functions and
`Bounds` `[0.5, 0.5]` — a non-strictly-increasing array PDF viewers reject. Revert.

- [ ] **Step 6: Typecheck and commit**

```bash
npm run typecheck
git add src/svggradient.ts test/svg-gradient.test.ts
git commit -m "feat(svg): gradient stops -> PDF type 2/3 colour function (1gg0.7)"
```

---

### Task 6: `svggradient.ts` — geometry, pattern matrix, and the pad case

**Files:**
- Modify: `src/svggradient.ts` (append)
- Test: `test/svg-gradient.test.ts` (append two `describe`s)

**Interfaces:**
- Consumes: `resolveGradient`, `normalizeStops`, `stopsFunction` (Tasks 4–5); `segsBBox`'s
  `SegBBox` (Task 1) — imported as a *type only* from `src/svgpath.js`; `type ViewBox` from
  `src/svgtransform.js`; `mul`, `IDENTITY`, `type Matrix` from `src/text.js`;
  `parseTransform` from `src/svgtransform.js`; `name` from `src/types.js`.
- Produces:
  ```ts
  export type GradientPaint =
    | { kind: 'pattern'; pattern: PdfDict; opacity: number; report: boolean }
    | { kind: 'solid'; color: Rgb; opacity: number; report: boolean }
    | { kind: 'none'; report: boolean };

  /** Map one gradient element onto a paint for one shape.
   *  `bbox` is the shape's tight geometry box in its own user space (stroke
   *  excluded); `viewport` resolves percentages under userSpaceOnUse; `ctm` is the
   *  walker's accumulated matrix at that shape.
   *  `report` true means the caller should add the gradient element's name to its
   *  skipped list (varying stop-opacity, or a radial reflect/repeat). */
  export function gradientPaint(
    node: XmlNode, ids: Map<string, XmlNode>,
    bbox: SegBBox | null, viewport: ViewBox, ctm: Matrix,
  ): GradientPaint;
  ```
  Task 7 extends it with spread synthesis; Task 8 consumes it.

- [ ] **Step 1: Write the failing tests**

Append to `test/svg-gradient.test.ts` (extend the `svggradient.js` import with
`gradientPaint`; add `import type { SegBBox } from '../src/svgpath.js';` and
`import type { ViewBox } from '../src/svgtransform.js';` and
`import { IDENTITY } from '../src/text.js';`):

```ts
const VP: ViewBox = { minX: 0, minY: 0, w: 200, h: 100 };
/** A deliberately NON-SQUARE bbox: the only shape that distinguishes the two
 *  possible orderings of gradientTransform against the objectBoundingBox map. */
const BOX: SegBBox = { x: 10, y: 20, w: 40, h: 10 };

const paint = (svg: string, id: string, box: SegBBox | null = BOX,
               ctm = [...IDENTITY] as [number, number, number, number, number, number]) => {
  const map = ids(svg);
  return gradientPaint(map.get(id)!, map, box, VP, ctm);
};
const shading = (p: ReturnType<typeof paint>) => {
  if (p.kind !== 'pattern') throw new Error(`expected a pattern, got ${p.kind}`);
  return p.pattern.get('Shading') as PdfDict;
};

const TWO = '<stop offset="0" stop-color="red"/><stop offset="1" stop-color="blue"/>';

describe('gradientPaint — linear geometry', () => {
  it('builds a PatternType 2 pattern around a ShadingType 2', () => {
    const p = paint(`<svg><linearGradient id="g">${TWO}</linearGradient></svg>`, 'g');
    if (p.kind !== 'pattern') throw new Error('expected a pattern');
    expect(p.pattern.get('Type')).toMatchObject({ name: 'Pattern' });
    expect(p.pattern.get('PatternType')).toBe(2);
    const sh = shading(p);
    expect(sh.get('ShadingType')).toBe(2);
    expect(sh.get('ColorSpace')).toMatchObject({ name: 'DeviceRGB' });
    expect(sh.get('Extend')).toEqual([true, true]);
    expect((sh.get('Function') as PdfDict).get('FunctionType')).toBe(2);
  });

  it('applies the default axis x1=0% y1=0% x2=100% y2=0% in bbox units', () => {
    const p = paint(`<svg><linearGradient id="g">${TWO}</linearGradient></svg>`, 'g');
    expect(shading(p).get('Coords')).toEqual([0, 0, 1, 0]);
  });

  it('maps objectBoundingBox onto the shape box in the /Matrix', () => {
    const p = paint(`<svg><linearGradient id="g">${TWO}</linearGradient></svg>`, 'g');
    if (p.kind !== 'pattern') throw new Error('expected a pattern');
    expect(p.pattern.get('Matrix')).toEqual([40, 0, 0, 10, 10, 20]);
  });

  it('takes userSpaceOnUse coordinates verbatim and leaves the bbox out of /Matrix', () => {
    const p = paint('<svg><linearGradient id="g" gradientUnits="userSpaceOnUse" ' +
      `x1="5" y1="6" x2="7" y2="8">${TWO}</linearGradient></svg>`, 'g');
    expect(shading(p).get('Coords')).toEqual([5, 6, 7, 8]);
    if (p.kind !== 'pattern') throw new Error('expected a pattern');
    expect(p.pattern.get('Matrix')).toEqual([1, 0, 0, 1, 0, 0]);
  });

  it('resolves userSpaceOnUse percentages against the viewport', () => {
    const p = paint('<svg><linearGradient id="g" gradientUnits="userSpaceOnUse" ' +
      `x1="50%" y1="50%" x2="100%" y2="0%">${TWO}</linearGradient></svg>`, 'g');
    expect(shading(p).get('Coords')).toEqual([100, 50, 200, 0]);
  });

  it('composes gradientTransform INSIDE the bbox map, not outside it', () => {
    // rotate(90) about the gradient-space origin. Inside the obb map (correct) the
    // rotation happens in the unit square and is then stretched 40x10; outside it,
    // the whole 40x10 box would rotate about the element origin. The non-square
    // bbox is what separates them.
    const p = paint('<svg><linearGradient id="g" gradientTransform="rotate(90)">' +
      `${TWO}</linearGradient></svg>`, 'g');
    if (p.kind !== 'pattern') throw new Error('expected a pattern');
    const m = p.pattern.get('Matrix') as number[];
    // mul(rotate90, [40 0 0 10 10 20]) = [0*40, 1*10, -1*40, 0*10, 10, 20]
    m.forEach((v, i) => expect(v).toBeCloseTo([0, 10, -40, 0, 10, 20][i], 9));
  });

  it('bakes the element CTM into /Matrix as the outermost factor', () => {
    const p = paint(`<svg><linearGradient id="g">${TWO}</linearGradient></svg>`, 'g',
      BOX, [2, 0, 0, 2, 5, 5]);
    if (p.kind !== 'pattern') throw new Error('expected a pattern');
    // mul([40 0 0 10 10 20], [2 0 0 2 5 5]) = [80 0 0 20 25 45]
    expect(p.pattern.get('Matrix')).toEqual([80, 0, 0, 20, 25, 45]);
  });
});

describe('gradientPaint — radial geometry', () => {
  it('applies the defaults cx=cy=r=50% with the focus at the centre', () => {
    const p = paint(`<svg><radialGradient id="g">${TWO}</radialGradient></svg>`, 'g');
    const sh = shading(p);
    expect(sh.get('ShadingType')).toBe(3);
    expect(sh.get('Coords')).toEqual([0.5, 0.5, 0, 0.5, 0.5, 0.5]);
    expect(sh.get('Extend')).toEqual([true, true]);
  });

  it('puts fx/fy in the inner circle of radius 0', () => {
    const p = paint('<svg><radialGradient id="g" gradientUnits="userSpaceOnUse" ' +
      `cx="50" cy="50" r="20" fx="55" fy="45">${TWO}</radialGradient></svg>`, 'g');
    expect(shading(p).get('Coords')).toEqual([55, 45, 0, 50, 50, 20]);
  });

  it('pulls a focal point outside the circle back onto it (SVG 1.1)', () => {
    const p = paint('<svg><radialGradient id="g" gradientUnits="userSpaceOnUse" ' +
      `cx="0" cy="0" r="10" fx="100" fy="0">${TWO}</radialGradient></svg>`, 'g');
    const c = shading(p).get('Coords') as number[];
    expect(c[0]).toBeCloseTo(9.99, 6);   // 10 * 0.999, along +x
    expect(c[1]).toBeCloseTo(0, 9);
  });

  it('resolves a percentage r against the normalized diagonal', () => {
    // sqrt((200^2 + 100^2) / 2) = sqrt(25000) ~ 158.1139
    const p = paint('<svg><radialGradient id="g" gradientUnits="userSpaceOnUse" ' +
      `r="50%">${TWO}</radialGradient></svg>`, 'g');
    const c = shading(p).get('Coords') as number[];
    expect(c[5]).toBeCloseTo(Math.sqrt((200 * 200 + 100 * 100) / 2) / 2, 6);
  });
});

describe('gradientPaint — degenerate cases (all SVG-mandated, none reported)', () => {
  it('paints nothing when the gradient has no stops', () => {
    const p = paint('<svg><linearGradient id="g"/></svg>', 'g');
    expect(p.kind).toBe('none');
    expect(p.report).toBe(false);
  });

  it('paints a solid colour for exactly one stop', () => {
    const p = paint('<svg><linearGradient id="g"><stop offset="0.3" stop-color="lime"/>' +
      '</linearGradient></svg>', 'g');
    expect(p).toMatchObject({ kind: 'solid', color: [0, 1, 0], opacity: 1, report: false });
  });

  it('paints the LAST stop solid when a linear axis has zero length', () => {
    const p = paint('<svg><linearGradient id="g" x1="0.4" y1="0.4" x2="0.4" y2="0.4">' +
      `${TWO}</linearGradient></svg>`, 'g');
    expect(p).toMatchObject({ kind: 'solid', color: [0, 0, 1] });
  });

  it('paints the LAST stop solid when a radial radius is zero', () => {
    const p = paint(`<svg><radialGradient id="g" r="0">${TWO}</radialGradient></svg>`, 'g');
    expect(p).toMatchObject({ kind: 'solid', color: [0, 0, 1] });
  });

  it('suppresses the paint when objectBoundingBox meets a zero-area box', () => {
    expect(paint(`<svg><linearGradient id="g">${TWO}</linearGradient></svg>`, 'g',
      { x: 5, y: 5, w: 0, h: 30 }).kind).toBe('none');
    expect(paint(`<svg><linearGradient id="g">${TWO}</linearGradient></svg>`, 'g', null)
      .kind).toBe('none');
  });

  it('still paints a userSpaceOnUse gradient on a zero-area box', () => {
    const p = paint('<svg><linearGradient id="g" gradientUnits="userSpaceOnUse" ' +
      `x1="0" x2="10">${TWO}</linearGradient></svg>`, 'g', { x: 5, y: 5, w: 0, h: 30 });
    expect(p.kind).toBe('pattern');
  });
});

describe('gradientPaint — opacity', () => {
  it('folds a uniform stop-opacity into the paint opacity', () => {
    const p = paint('<svg><linearGradient id="g">' +
      '<stop offset="0" stop-color="red" stop-opacity="0.4"/>' +
      '<stop offset="1" stop-color="blue" stop-opacity="0.4"/></linearGradient></svg>', 'g');
    expect(p).toMatchObject({ kind: 'pattern', opacity: 0.4, report: false });
  });

  it('paints opaque and reports when stop-opacity varies', () => {
    const p = paint('<svg><linearGradient id="g">' +
      '<stop offset="0" stop-color="red" stop-opacity="1"/>' +
      '<stop offset="1" stop-color="blue" stop-opacity="0.2"/></linearGradient></svg>', 'g');
    expect(p).toMatchObject({ kind: 'pattern', opacity: 1, report: true });
  });

  it('carries a uniform stop-opacity onto a solid degenerate result too', () => {
    const p = paint('<svg><linearGradient id="g">' +
      '<stop offset="0.3" stop-color="lime" stop-opacity="0.5"/></linearGradient></svg>', 'g');
    expect(p).toMatchObject({ kind: 'solid', opacity: 0.5 });
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/svg-gradient.test.ts`
Expected: FAIL — `gradientPaint is not a function`.

- [ ] **Step 3: Implement**

Extend the imports at the top of `src/svggradient.ts`:

```ts
import { name, type PdfDict, type PdfObject } from './types.js';
import { IDENTITY, mul, type Matrix } from './text.js';
import { parseTransform, type ViewBox } from './svgtransform.js';
import type { SegBBox } from './svgpath.js';
```

Append:

```ts
/** What a gradient reference resolves to for one shape.
 *  `report` true asks the caller to add the gradient element's name to its
 *  skipped list — a fidelity loss, never an SVG-mandated degeneracy. */
export type GradientPaint =
  | { kind: 'pattern'; pattern: PdfDict; opacity: number; report: boolean }
  | { kind: 'solid'; color: Rgb; opacity: number; report: boolean }
  | { kind: 'none'; report: boolean };

/** How a length attribute resolves: as a fraction of the bounding box, or in the
 *  element's user space against the viewport. */
type Axis = 'x' | 'y' | 'd';

/** SVG's normalized diagonal, which a percentage `r` resolves against. */
const diagonal = (vp: ViewBox): number => Math.sqrt((vp.w * vp.w + vp.h * vp.h) / 2);

/** One gradient coordinate. Under objectBoundingBox a percentage is simply the
 *  fraction and a plain number is already one. Under userSpaceOnUse a percentage
 *  resolves against the viewport and a plain number is a user-space length. */
function coord(v: string | undefined, dflt: number, obb: boolean, axis: Axis,
               vp: ViewBox): number {
  if (v === undefined) return dflt;
  const t = v.trim();
  const n = parseFloat(t);
  if (!Number.isFinite(n)) return dflt;
  if (!t.endsWith('%')) return n;
  const f = n / 100;
  if (obb) return f;
  return f * (axis === 'x' ? vp.w : axis === 'y' ? vp.h : diagonal(vp));
}

/** Every stop carrying the same alpha, else null. Uniform alpha folds exactly
 *  into /ca + /CA; a varying one would need a luminosity /SMask (a follow-up). */
function uniformOpacity(stops: GradientStop[]): number | null {
  if (stops.length === 0) return 1;
  const a = stops[0].opacity;
  return stops.every((s) => Math.abs(s.opacity - a) < 1e-9) ? a : null;
}

/** The pattern /Matrix: gradient space -> the Form XObject's default space.
 *  gradientTransform applies INSIDE the objectBoundingBox coordinate system, so
 *  it is the leftmost (first-applied) factor. Swapping the first two makes a
 *  rotated gradient rotate about the wrong origin — visible only on a non-square
 *  bbox, which is why the tests use one. */
function patternMatrix(gt: Matrix, obb: boolean, bbox: SegBBox | null, ctm: Matrix): Matrix {
  const bm: Matrix = obb && bbox
    ? [bbox.w, 0, 0, bbox.h, bbox.x, bbox.y]
    : [...IDENTITY];
  return mul(mul(gt, bm), ctm);
}

/** Assemble the pattern dict around a shading dict. */
function patternOf(shadingEntries: [string, PdfObject][], matrix: Matrix): PdfDict {
  return dict([
    ['Type', name('Pattern')],
    ['PatternType', 2],
    ['Matrix', [...matrix]],
    ['Shading', dict([
      ['ColorSpace', name('DeviceRGB')],
      ...shadingEntries,
      ['Extend', [true, true]],
    ])],
  ]);
}

/** Map one gradient element onto a paint for one shape.
 *
 *  `bbox` is the shape's TIGHT geometry box in its own user space, stroke
 *  excluded (SVG's own rule); `viewport` resolves percentages under
 *  userSpaceOnUse; `ctm` is the walker's accumulated matrix at that shape. */
export function gradientPaint(
  node: XmlNode, ids: Map<string, XmlNode>,
  bbox: SegBBox | null, viewport: ViewBox, ctm: Matrix,
): GradientPaint {
  const g = resolveGradient(node, ids);
  if (g.stops.length === 0) return { kind: 'none', report: false };

  const alpha = uniformOpacity(g.stops);
  const opacity = alpha ?? 1;
  const report = alpha === null;
  const lastColor = g.stops[g.stops.length - 1].color;

  if (g.stops.length === 1)
    return { kind: 'solid', color: g.stops[0].color, opacity, report };

  const obb = (g.attrs.get('gradientUnits') ?? 'objectBoundingBox') !== 'userSpaceOnUse';
  // objectBoundingBox cannot position a gradient on a box with no area: SVG says
  // the element is not rendered by that paint. Its other paint still applies.
  if (obb && (!bbox || !(bbox.w > 0) || !(bbox.h > 0)))
    return { kind: 'none', report: false };

  const gt = parseTransform(g.attrs.get('gradientTransform'));
  const matrix = patternMatrix(gt, obb, bbox, ctm);
  const stops = normalizeStops(g.stops);

  if (g.kind === 'radial') {
    const cx = coord(g.attrs.get('cx'), obb ? 0.5 : 0.5 * viewport.w, obb, 'x', viewport);
    const cy = coord(g.attrs.get('cy'), obb ? 0.5 : 0.5 * viewport.h, obb, 'y', viewport);
    const r = coord(g.attrs.get('r'), obb ? 0.5 : 0.5 * diagonal(viewport), obb, 'd', viewport);
    if (!(r > 0)) return { kind: 'solid', color: lastColor, opacity, report };
    let fx = coord(g.attrs.get('fx'), cx, obb, 'x', viewport);
    let fy = coord(g.attrs.get('fy'), cy, obb, 'y', viewport);
    // SVG 1.1: a focus outside the circle moves onto it. Landing exactly on the
    // edge makes PDF's cone degenerate, so stop just inside — the same 0.1%
    // inset other renderers use.
    const d = Math.hypot(fx - cx, fy - cy);
    if (d > r) {
      const k = (r * 0.999) / d;
      fx = cx + (fx - cx) * k;
      fy = cy + (fy - cy) * k;
    }
    const spread = g.attrs.get('spreadMethod');
    // Radial reflect/repeat has no clean PDF equivalent (an annulus tiled
    // outward); pad and say so.
    const spreadReport = spread === 'reflect' || spread === 'repeat';
    return {
      kind: 'pattern',
      pattern: patternOf([
        ['ShadingType', 3],
        ['Coords', [fx, fy, 0, cx, cy, r]],
        ['Function', stopsFunction(stops)],
      ], matrix),
      opacity,
      report: report || spreadReport,
    };
  }

  const x1 = coord(g.attrs.get('x1'), 0, obb, 'x', viewport);
  const y1 = coord(g.attrs.get('y1'), 0, obb, 'y', viewport);
  const x2 = coord(g.attrs.get('x2'), obb ? 1 : viewport.w, obb, 'x', viewport);
  const y2 = coord(g.attrs.get('y2'), 0, obb, 'y', viewport);
  if (x1 === x2 && y1 === y2)
    return { kind: 'solid', color: lastColor, opacity, report };

  return {
    kind: 'pattern',
    pattern: patternOf([
      ['ShadingType', 2],
      ['Coords', [x1, y1, x2, y2]],
      ['Function', stopsFunction(stops)],
    ], matrix),
    opacity,
    report,
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/svg-gradient.test.ts`
Expected: PASS.

- [ ] **Step 5: Prove the matrix composition order is load-bearing**

Temporarily change `patternMatrix`'s return to `mul(mul(bm, gt), ctm)` and re-run.
Expected: "composes gradientTransform INSIDE the bbox map" FAILS — it reports
`[0, 40, -10, 0, -20, 10]` instead of `[0, 10, -40, 0, 10, 20]`. Note the translation
changes too, which is the "rotates about the wrong origin" symptom; on a *square* bbox the
linear part alone would still differ, but the non-square box is what makes the failure
unambiguous. Then change it to `mul(ctm, mul(gt, bm))` and re-run: "bakes the element CTM
into /Matrix" FAILS. Revert both.

- [ ] **Step 6: Typecheck and commit**

```bash
npm run typecheck
git add src/svggradient.ts test/svg-gradient.test.ts
git commit -m "feat(svg): gradient coords, pattern matrix and degenerate cases (1gg0.7)"
```

---

### Task 7: `spreadMethod` reflect / repeat on linear gradients

**Files:**
- Modify: `src/svggradient.ts` (append a helper; edit the linear branch of `gradientPaint`)
- Test: `test/svg-gradient.test.ts` (append a `describe`)

**Interfaces:**
- Consumes: `invert` from `src/text.js` (add to the existing import); `apply` likewise.
- Produces:
  ```ts
  /** The integer repetition range [k0, k1] of a linear gradient's axis over a
   *  shape box, in gradient space. Returns null when it cannot be computed or
   *  would exceed `cap` repetitions — the caller then falls back to pad. */
  export function spreadRange(
    p1: [number, number], p2: [number, number], m: Matrix, bbox: SegBBox | null,
    cap?: number,
  ): [number, number] | null;

  /** n copies of a normalized stop list packed into [0, 1], copy i mirrored when
   *  `reflect` and (k0 + i) is odd. */
  export function tileStops(
    stops: GradientStop[], k0: number, n: number, reflect: boolean,
  ): GradientStop[];
  ```

- [ ] **Step 1: Write the failing tests**

Append to `test/svg-gradient.test.ts` (extend the `svggradient.js` import with
`spreadRange` and `tileStops`):

```ts
describe('spreadRange', () => {
  const M = [...IDENTITY] as [number, number, number, number, number, number];

  it('covers exactly [0, 1] when the box matches the axis', () => {
    expect(spreadRange([0, 0], [1, 0], M, { x: 0, y: 0, w: 1, h: 1 })).toEqual([0, 1]);
  });

  it('floors and ceils the projected t interval', () => {
    // axis 0..10 in x; box spans x -5..25 -> t in [-0.5, 2.5] -> [-1, 3]
    expect(spreadRange([0, 0], [10, 0], M, { x: -5, y: 0, w: 30, h: 4 })).toEqual([-1, 3]);
  });

  it('never returns an empty range', () => {
    const r = spreadRange([0, 0], [10, 0], M, { x: 2, y: 0, w: 1, h: 1 })!;
    expect(r[1]).toBeGreaterThan(r[0]);
  });

  it('projects through the inverse of the matrix', () => {
    // The obb map [10 0 0 10 0 0] puts the unit box at 0..10; a 0..1 axis in
    // gradient space then covers it exactly once.
    expect(spreadRange([0, 0], [1, 0], [10, 0, 0, 10, 0, 0], { x: 0, y: 0, w: 10, h: 10 }))
      .toEqual([0, 1]);
  });

  it('returns null past the repetition cap and for a singular matrix', () => {
    expect(spreadRange([0, 0], [1, 0], M, { x: 0, y: 0, w: 1000, h: 1 }, 64)).toBeNull();
    expect(spreadRange([0, 0], [1, 0], [0, 0, 0, 0, 0, 0], { x: 0, y: 0, w: 1, h: 1 }))
      .toBeNull();
    expect(spreadRange([0, 0], [1, 0], M, null)).toBeNull();
  });
});

describe('tileStops', () => {
  const base = normalizeStops([
    { offset: 0, color: [1, 0, 0] as [number, number, number], opacity: 1 },
    { offset: 1, color: [0, 0, 1] as [number, number, number], opacity: 1 },
  ]);

  it('packs n forward copies for repeat', () => {
    const out = tileStops(base, 0, 2, false);
    expect(out.map((s) => s.offset)).toEqual([0, 0.5, 0.5, 1]);
    expect(out.map((s) => s.color)).toEqual([[1, 0, 0], [0, 0, 1], [1, 0, 0], [0, 0, 1]]);
  });

  it('mirrors the odd copies for reflect', () => {
    const out = tileStops(base, 0, 2, true);
    expect(out.map((s) => s.color)).toEqual([[1, 0, 0], [0, 0, 1], [0, 0, 1], [1, 0, 0]]);
  });

  it('uses k0 parity, so a range starting at an odd integer starts mirrored', () => {
    const out = tileStops(base, 1, 2, true);
    expect(out.map((s) => s.color)).toEqual([[0, 0, 1], [1, 0, 0], [1, 0, 0], [0, 0, 1]]);
  });

  it('handles a negative k0 parity without a negative modulo', () => {
    const out = tileStops(base, -1, 1, true);
    expect(out.map((s) => s.color)).toEqual([[0, 0, 1], [1, 0, 0]]);
  });

  it('returns the list unchanged for a single forward copy', () => {
    expect(tileStops(base, 0, 1, false)).toEqual(base);
  });
});

describe('gradientPaint — spreadMethod', () => {
  const two = `${TWO}`;

  it('extends the coords over the repetition range for repeat', () => {
    // userSpaceOnUse axis 0..10, box x 0..40 -> t in [0, 4] -> coords 0..40
    const p = paint('<svg><linearGradient id="g" gradientUnits="userSpaceOnUse" ' +
      `spreadMethod="repeat" x1="0" x2="10">${two}</linearGradient></svg>`, 'g',
      { x: 0, y: 0, w: 40, h: 10 });
    const sh = shading(p);
    expect(sh.get('Coords')).toEqual([0, 0, 40, 0]);
    expect((sh.get('Function') as PdfDict).get('Bounds')).toEqual([0.25, 0.5, 0.75]);
    expect(sh.get('Extend')).toEqual([true, true]);
  });

  it('mirrors alternate copies for reflect', () => {
    const p = paint('<svg><linearGradient id="g" gradientUnits="userSpaceOnUse" ' +
      `spreadMethod="reflect" x1="0" x2="10">${two}</linearGradient></svg>`, 'g',
      { x: 0, y: 0, w: 20, h: 10 });
    const subs = ((shading(p).get('Function')) as PdfDict).get('Functions') as PdfDict[];
    expect(subs).toHaveLength(2);
    expect(subs[0].get('C0')).toEqual([1, 0, 0]);
    expect(subs[0].get('C1')).toEqual([0, 0, 1]);
    expect(subs[1].get('C0')).toEqual([0, 0, 1]);   // mirrored
    expect(subs[1].get('C1')).toEqual([1, 0, 0]);
  });

  it('degrades to pad past the 64-repetition cap, without reporting', () => {
    const p = paint('<svg><linearGradient id="g" gradientUnits="userSpaceOnUse" ' +
      `spreadMethod="repeat" x1="0" x2="1">${two}</linearGradient></svg>`, 'g',
      { x: 0, y: 0, w: 1000, h: 10 });
    const sh = shading(p);
    expect(sh.get('Coords')).toEqual([0, 0, 1, 0]);
    expect(p.report).toBe(false);
  });

  it('leaves pad alone', () => {
    const p = paint('<svg><linearGradient id="g" gradientUnits="userSpaceOnUse" ' +
      `spreadMethod="pad" x1="0" x2="10">${two}</linearGradient></svg>`, 'g',
      { x: 0, y: 0, w: 40, h: 10 });
    expect(shading(p).get('Coords')).toEqual([0, 0, 10, 0]);
  });

  it('reports a radial reflect/repeat and pads it', () => {
    const p = paint(`<svg><radialGradient id="g" spreadMethod="repeat">${two}` +
      '</radialGradient></svg>', 'g');
    expect(p.kind).toBe('pattern');
    expect(p.report).toBe(true);
    expect(shading(p).get('Coords')).toEqual([0.5, 0.5, 0, 0.5, 0.5, 0.5]);
  });

  it('cancels the element CTM out of the range computation', () => {
    // The same gradient and the same shape under a 3x CTM must produce the same
    // repetition count — the shape is in element space and the pattern /Matrix
    // carries the same CTM factor, so it cancels.
    const svg = '<svg><linearGradient id="g" gradientUnits="userSpaceOnUse" ' +
      `spreadMethod="repeat" x1="0" x2="10">${two}</linearGradient></svg>`;
    const box = { x: 0, y: 0, w: 40, h: 10 };
    const a = shading(paint(svg, 'g', box));
    const b = shading(paint(svg, 'g', box, [3, 0, 0, 3, 7, 7]));
    expect(b.get('Coords')).toEqual(a.get('Coords'));
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/svg-gradient.test.ts`
Expected: FAIL — `spreadRange is not a function`.

- [ ] **Step 3: Implement**

Extend the `text.js` import in `src/svggradient.ts`:

```ts
import { IDENTITY, apply, invert, mul, type Matrix } from './text.js';
```

Append the two helpers:

```ts
/** The integer repetition range [k0, k1] a linear gradient's axis must span to
 *  cover `bbox`, in gradient space.
 *
 *  The box's corners are mapped through invert(m) — where m is
 *  mul(gradientTransform, bboxMatrix), i.e. WITHOUT the element CTM — and
 *  projected onto the axis. The CTM cancels: the box is in element user space
 *  and the pattern /Matrix carries the same CTM factor. That cancellation is the
 *  check that the /Matrix composition is right.
 *
 *  Returns null when the range cannot be computed or exceeds `cap` repetitions,
 *  in which case the caller falls back to pad rather than inflating the stream. */
export function spreadRange(
  p1: [number, number], p2: [number, number], m: Matrix, bbox: SegBBox | null,
  cap = 64,
): [number, number] | null {
  if (!bbox) return null;
  let inv: Matrix;
  try { inv = invert(m); } catch { return null; }
  const dx = p2[0] - p1[0], dy = p2[1] - p1[1];
  const len2 = dx * dx + dy * dy;
  if (!(len2 > 0)) return null;
  let lo = Infinity, hi = -Infinity;
  for (const [cx, cy] of [
    [bbox.x, bbox.y], [bbox.x + bbox.w, bbox.y],
    [bbox.x, bbox.y + bbox.h], [bbox.x + bbox.w, bbox.y + bbox.h],
  ] as [number, number][]) {
    const [gx, gy] = apply(inv, cx, cy);
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

/** n copies of a normalized stop list packed into [0, 1]. Copy i covers the
 *  gradient-space interval [k0+i, k0+i+1] and is mirrored when `reflect` and that
 *  integer is odd — reflect mirrors about every integer boundary and [0, 1] is
 *  forward. The seams produce duplicate offsets, which stopsFunction turns into
 *  the hard edge `repeat` needs and drops as a zero-width interval. */
export function tileStops(
  stops: GradientStop[], k0: number, n: number, reflect: boolean,
): GradientStop[] {
  if (n <= 1 && !(reflect && (((k0 % 2) + 2) % 2) === 1)) return stops.map((s) => ({ ...s }));
  const out: GradientStop[] = [];
  for (let i = 0; i < n; i++) {
    const mirror = reflect && ((((k0 + i) % 2) + 2) % 2) === 1;
    const src = mirror
      ? [...stops].reverse().map((s) => ({ ...s, offset: 1 - s.offset }))
      : stops;
    for (const s of src) out.push({ ...s, offset: (i + s.offset) / n });
  }
  return out;
}
```

Then edit the linear branch of `gradientPaint`. Replace everything from
`if (x1 === x2 && y1 === y2)` to the end of the function with:

```ts
  if (x1 === x2 && y1 === y2)
    return { kind: 'solid', color: lastColor, opacity, report };

  let coords = [x1, y1, x2, y2];
  let fnStops = stops;
  const spread = g.attrs.get('spreadMethod');
  if (spread === 'reflect' || spread === 'repeat') {
    // The pattern matrix without the element CTM: the box is in element space.
    const bm: Matrix = obb && bbox ? [bbox.w, 0, 0, bbox.h, bbox.x, bbox.y] : [...IDENTITY];
    const range = spreadRange([x1, y1], [x2, y2], mul(gt, bm), bbox);
    if (range) {
      const [k0, k1] = range;
      coords = [
        x1 + k0 * (x2 - x1), y1 + k0 * (y2 - y1),
        x1 + k1 * (x2 - x1), y1 + k1 * (y2 - y1),
      ];
      fnStops = tileStops(stops, k0, k1 - k0, spread === 'reflect');
    }
    // range === null: over the cap or uncomputable. /Extend [true true] pads,
    // which is a visible but bounded degradation and not worth reporting.
  }

  return {
    kind: 'pattern',
    pattern: patternOf([
      ['ShadingType', 2],
      ['Coords', coords],
      ['Function', stopsFunction(fnStops)],
    ], matrix),
    opacity,
    report,
  };
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/svg-gradient.test.ts`
Expected: PASS.

- [ ] **Step 5: Prove the CTM cancellation is load-bearing**

Temporarily change the `spreadRange` call to pass `mul(mul(gt, bm), ctm)` and re-run.
Expected: "cancels the element CTM out of the range computation" FAILS — the 3× CTM
shrinks the projected interval and yields a different `Coords`. Revert.

- [ ] **Step 6: Typecheck and commit**

```bash
npm run typecheck
git add src/svggradient.ts test/svg-gradient.test.ts
git commit -m "feat(svg): synthesize reflect/repeat spread for linear gradients (1gg0.7)"
```

---

### Task 8: wire gradients into the walker

**Files:**
- Modify: `src/svgdraw.ts` (imports; `Emitter`; `paintShape`; `walk`; `drawSvg`)
- Modify: `src/svgembed.ts:62` (pass the viewport)
- Test: `test/svg-draw.test.ts` (update the `draw` helper; drop the `__ctmProbe` describe's
  reliance on a removed export by keeping the export; append a `describe`)

**Interfaces:**
- Consumes: `gradientPaint`, `type GradientPaint` from `src/svggradient.js`; `segsBBox`
  from `src/svgpath.js`; `type ViewBox` from `src/svgtransform.js`.
- Produces:
  ```ts
  export function drawSvg(root: XmlNode, viewport: ViewBox): DrawResult;
  ```
  `DrawResult.resources` now also carries a `Pattern` sub-dict when any gradient painted.
  `__ctmProbe` stays exported (its tests still hold) but gains the same second parameter.

- [ ] **Step 1: Write the failing tests**

In `test/svg-draw.test.ts`, first update the two helpers at the top of the file and the
probe helper added in Task 3:

```ts
const VP = { minX: 0, minY: 0, w: 100, h: 100 };
const draw = (svg: string) => drawSvg(parseXml(new TextEncoder().encode(svg)), VP);
const body = (svg: string) => draw(svg).content;
```

and inside the "accumulated CTM" describe:

```ts
  const probe = (svg: string) => __ctmProbe(parseXml(new TextEncoder().encode(svg)), VP);
```

Then append:

```ts
describe('drawSvg — gradients', () => {
  const GRAD = '<linearGradient id="g"><stop offset="0" stop-color="red"/>' +
    '<stop offset="1" stop-color="blue"/></linearGradient>';
  const patterns = (svg: string) => {
    const res = draw(svg).resources.get('Pattern') as PdfDict | undefined;
    return res ?? new Map();
  };

  it('selects the pattern colour space and scn for a gradient fill', () => {
    const c = body(`<svg><defs>${GRAD}</defs>` +
      '<rect width="10" height="10" fill="url(#g)"/></svg>');
    expect(c).toContain('/Pattern cs');
    expect(c).toMatch(/\/P\d+ scn/);
    expect(c).toMatch(/\bf\b/);
    expect(c).not.toContain('rg');
  });

  it('selects the pattern colour space and SCN for a gradient stroke', () => {
    const c = body(`<svg><defs>${GRAD}</defs>` +
      '<rect width="10" height="10" fill="none" stroke="url(#g)"/></svg>');
    expect(c).toContain('/Pattern CS');
    expect(c).toMatch(/\/P\d+ SCN/);
    expect(c).toMatch(/\bS\b/);
  });

  it('registers the pattern as a direct dict in the walker resources', () => {
    const pats = patterns(`<svg><defs>${GRAD}</defs>` +
      '<rect width="10" height="10" fill="url(#g)"/></svg>');
    expect(pats.size).toBe(1);
    const p = [...pats.values()][0] as PdfDict;
    expect(isDict(p)).toBe(true);
    expect(p.get('PatternType')).toBe(2);
  });

  it('does not report a resolved gradient in skipped', () => {
    expect(draw(`<svg><defs>${GRAD}</defs>` +
      '<rect width="10" height="10" fill="url(#g)"/></svg>').skipped).toEqual([]);
  });

  it('still reports a url() paint that is not a gradient', () => {
    const r = draw('<svg><defs><pattern id="p"/></defs>' +
      '<rect width="10" height="10" fill="url(#p)"/></svg>');
    expect(r.skipped).toEqual(['pattern']);
  });

  it('dedupes one gradient shared by two identically-placed shapes', () => {
    const pats = patterns('<svg><defs>' +
      '<linearGradient id="g" gradientUnits="userSpaceOnUse" x1="0" x2="10">' +
      '<stop offset="0" stop-color="red"/><stop offset="1" stop-color="blue"/>' +
      '</linearGradient></defs>' +
      '<rect width="10" height="10" fill="url(#g)"/>' +
      '<rect width="10" height="10" fill="url(#g)"/></svg>');
    expect(pats.size).toBe(1);
  });

  it('emits two patterns when the same gradient meets two different boxes', () => {
    const pats = patterns(`<svg><defs>${GRAD}</defs>` +
      '<rect width="10" height="10" fill="url(#g)"/>' +
      '<rect width="20" height="4" fill="url(#g)"/></svg>');
    expect(pats.size).toBe(2);
  });

  it('bakes a nested group transform into the pattern /Matrix', () => {
    const pats = patterns(`<svg><defs>${GRAD}</defs>` +
      '<g transform="translate(5 6)"><rect width="10" height="10" fill="url(#g)"/></g></svg>');
    const p = [...pats.values()][0] as PdfDict;
    // obb map [10 0 0 10 0 0] then the group translate.
    expect(p.get('Matrix')).toEqual([10, 0, 0, 10, 5, 6]);
  });

  it('folds a uniform stop-opacity into the ExtGState alpha', () => {
    const svg = '<svg><defs><linearGradient id="g">' +
      '<stop offset="0" stop-color="red" stop-opacity="0.5"/>' +
      '<stop offset="1" stop-color="blue" stop-opacity="0.5"/></linearGradient></defs>' +
      '<rect width="10" height="10" fill="url(#g)"/></svg>';
    expect(body(svg)).toMatch(/\/GS\d+ gs/);
    const gs = draw(svg).resources.get('ExtGState') as PdfDict;
    expect([...gs.values()].some((v) => (v as PdfDict).get('ca') === 0.5)).toBe(true);
  });

  it('multiplies a uniform stop-opacity by the element fill-opacity', () => {
    const svg = '<svg><defs><linearGradient id="g">' +
      '<stop offset="0" stop-color="red" stop-opacity="0.5"/>' +
      '<stop offset="1" stop-color="blue" stop-opacity="0.5"/></linearGradient></defs>' +
      '<rect width="10" height="10" fill="url(#g)" fill-opacity="0.5"/></svg>';
    const gs = draw(svg).resources.get('ExtGState') as PdfDict;
    expect([...gs.values()].some((v) => (v as PdfDict).get('ca') === 0.25)).toBe(true);
  });

  it('reports a varying stop-opacity and paints opaque', () => {
    const r = draw('<svg><defs><linearGradient id="g">' +
      '<stop offset="0" stop-color="red" stop-opacity="1"/>' +
      '<stop offset="1" stop-color="blue" stop-opacity="0.2"/></linearGradient></defs>' +
      '<rect width="10" height="10" fill="url(#g)"/></svg>');
    expect(r.skipped).toEqual(['linearGradient']);
    expect(r.content).toMatch(/\/P\d+ scn/);
  });

  it('reports a radial reflect spread', () => {
    expect(draw('<svg><defs><radialGradient id="g" spreadMethod="reflect">' +
      '<stop offset="0" stop-color="red"/><stop offset="1" stop-color="blue"/>' +
      '</radialGradient></defs><rect width="10" height="10" fill="url(#g)"/></svg>')
      .skipped).toEqual(['radialGradient']);
  });

  it('paints a solid colour for a one-stop gradient, with no pattern at all', () => {
    const svg = '<svg><defs><linearGradient id="g">' +
      '<stop offset="0" stop-color="lime"/></linearGradient></defs>' +
      '<rect width="10" height="10" fill="url(#g)"/></svg>';
    expect(body(svg)).toContain('0 1 0 rg');
    expect(draw(svg).resources.get('Pattern')).toBeUndefined();
  });

  it('paints nothing for a stopless gradient and does not report it', () => {
    const r = draw('<svg><defs><linearGradient id="g"/></defs>' +
      '<rect width="10" height="10" fill="url(#g)"/></svg>');
    expect(r.content).not.toMatch(/\b[fB]\b/);
    expect(r.skipped).toEqual([]);
  });

  it('keeps a solid stroke when the gradient fill is suppressed', () => {
    const c = body('<svg><defs><linearGradient id="g"/></defs>' +
      '<rect width="10" height="10" fill="url(#g)" stroke="red"/></svg>');
    expect(c).toContain('1 0 0 RG');
    expect(c).toMatch(/\bS\b/);
  });

  it('never applies a gradient fill to a <line>', () => {
    const svg = `<svg><defs>${GRAD}</defs>` +
      '<line x1="0" y1="0" x2="10" y2="10" fill="url(#g)" stroke="red"/></svg>';
    expect(body(svg)).not.toContain('/Pattern cs');
    expect(draw(svg).resources.get('Pattern')).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/svg-draw.test.ts`
Expected: FAIL — `drawSvg` takes one argument (TypeScript error) and no pattern is emitted.

- [ ] **Step 3: Implement the wiring**

In `src/svgdraw.ts`, extend the imports:

```ts
import { parsePath, rectSegs, ellipseSegs, polySegs, parsePoints, segsBBox,
         type SvgSeg, type SegBBox } from './svgpath.js';
import { gradientPaint, type GradientPaint } from './svggradient.js';
import type { ViewBox } from './svgtransform.js';
```

Add the pattern registry to `Emitter`, alongside `extg`:

```ts
  readonly pat: PdfDict = new Map<string, PdfObject>();
  /** canonical pattern text -> resource key, so two shapes sharing one gradient
   *  under one placement register one pattern. Mirrors gsKey's intent, but the
   *  dicts are nested, so equality is taken on a canonical serialization. */
  private readonly patKeys = new Map<string, string>();
  /** The viewport, for userSpaceOnUse percentage resolution. */
  viewport: ViewBox = { minX: 0, minY: 0, w: 0, h: 0 };

  /** Register `d`, reusing an identical pattern; returns its resource key. */
  patKey(d: PdfDict): string {
    const k = canon(d);
    const hit = this.patKeys.get(k);
    if (hit !== undefined) return hit;
    const key = `P${this.pat.size}`;
    this.pat.set(key, d);
    this.patKeys.set(k, key);
    return key;
  }
```

Add the canonical serializer just above `class Emitter`:

```ts
/** A stable string for a direct PdfObject tree, used only for pattern equality.
 *  Patterns nest three dicts deep, so a field-by-field compare would be worse. */
function canon(v: PdfObject): string {
  if (v instanceof Map) {
    return `<${[...v].map(([k, x]) => `${k}:${canon(x)}`).join(',')}>`;
  }
  if (Array.isArray(v)) return `[${v.map(canon).join(',')}]`;
  if (v !== null && typeof v === 'object' && 'kind' in v && v.kind === 'name')
    return `/${(v as { name: string }).name}`;
  return String(v);
}
```

Add the gradient lookup, just above `paintShape`:

```ts
/** Resolve a `url(#id)` paint reference to a gradient paint, or null when it is
 *  not a gradient element (which the caller reports, as it does today). */
function gradientFor(
  e: Emitter, id: string | null, bbox: SegBBox | null, ctm: Matrix,
): GradientPaint | null {
  if (id === null) return null;
  const node = e.ids.get(id);
  if (!node || (node.name !== 'linearGradient' && node.name !== 'radialGradient')) return null;
  const gp = gradientPaint(node, e.ids, bbox, e.viewport, ctm);
  if (gp.report) e.skipped.add(node.name);
  return gp;
}
```

Rewrite `paintShape`:

```ts
function paintShape(e: Emitter, segs: SvgSeg[], p: Paint, ctm: Matrix): void {
  if (segs.length === 0) return;
  if (e.ctms) e.ctms.push(ctm);

  // The bbox is only ever needed by a gradient, so it is computed lazily even
  // though objectBoundingBox — the default — makes that the common path.
  let box: SegBBox | null | undefined;
  const bbox = (): SegBBox | null => (box === undefined ? (box = segsBBox(segs)) : box);

  const fg = p.fillRef !== null ? gradientFor(e, p.fillRef, bbox(), ctm) : null;
  const sg = p.strokeRef !== null ? gradientFor(e, p.strokeRef, bbox(), ctm) : null;

  const doFill = fg ? fg.kind !== 'none' : p.fill !== null;
  const doStroke = (sg ? sg.kind !== 'none' : p.stroke !== null) && p.strokeWidth > 0;
  if (!doFill && !doStroke) return;

  e.out.push('q');
  const ca = doFill ? p.fillOpacity * (fg ? fg.opacity : 1) : 1;
  const CA = doStroke ? p.strokeOpacity * (sg ? sg.opacity : 1) : 1;
  if (ca < 1 || CA < 1) e.out.push(`/${e.gsKey(ca, CA)} gs`);
  if (doFill) {
    if (fg && fg.kind === 'pattern')
      e.out.push('/Pattern cs', `/${e.patKey(fg.pattern)} scn`);
    else if (fg && fg.kind === 'solid') e.out.push(`${fg.color.map(num).join(' ')} rg`);
    else e.out.push(`${p.fill!.map(num).join(' ')} rg`);
  }
  if (doStroke) {
    if (sg && sg.kind === 'pattern')
      e.out.push('/Pattern CS', `/${e.patKey(sg.pattern)} SCN`);
    else if (sg && sg.kind === 'solid') e.out.push(`${sg.color.map(num).join(' ')} RG`);
    else e.out.push(`${p.stroke!.map(num).join(' ')} RG`);
    e.out.push(`${num(p.strokeWidth)} w`);
    if (p.lineCap !== 0) e.out.push(`${p.lineCap} J`);
    if (p.lineJoin !== 0) e.out.push(`${p.lineJoin} j`);
    if (p.miterLimit !== 4) e.out.push(`${num(p.miterLimit)} M`);
    if (p.dash.length > 0) e.out.push(`[${p.dash.map(num).join(' ')}] ${num(p.dashOffset)} d`);
  }
  emitSegs(segs, e.out);
  const eo = p.fillRule === 'evenodd' ? '*' : '';
  e.out.push(doFill && doStroke ? `B${eo}` : doFill ? `f${eo}` : 'S');
  e.out.push('Q');
}
```

Note the reordering: the `segs.length === 0` guard moves above the paint decision, because
the bbox needs the segments.

In `walk`, stop reporting a ref that resolves to a gradient:

```ts
  const { paint, refs } = resolveStyle(parent, n.attrs);
  for (const id of refs) {
    const target = e.ids.get(id);
    // A gradient reference is handled in paintShape, which reports its own
    // fidelity losses. Anything else is still unsupported.
    if (target && (target.name === 'linearGradient' || target.name === 'radialGradient'))
      continue;
    e.skipped.add(target ? target.name : 'url()');
  }
```

and drop the gradient fill from a `<line>` alongside its solid fill:

```ts
      paintShape(e, segs,
        n.name === 'line' ? { ...paint, fill: null, fillRef: null } : paint, here);
```

Finally, `drawSvg` and `__ctmProbe` take the viewport and export the patterns:

```ts
export function drawSvg(root: XmlNode, viewport: ViewBox): DrawResult {
  const e = new Emitter();
  e.viewport = viewport;
  indexIds(root, e.ids);
  walk(e, root, INITIAL, false, [...IDENTITY]);
  const resources: PdfDict = new Map<string, PdfObject>();
  if (e.extg.size > 0) resources.set('ExtGState', e.extg);
  if (e.pat.size > 0) resources.set('Pattern', e.pat);
  return {
    content: e.out.join('\n'),
    resources,
    skipped: [...e.skipped].sort(),
  };
}

export function __ctmProbe(root: XmlNode, viewport: ViewBox): Matrix[] {
  const e = new Emitter();
  e.viewport = viewport;
  e.ctms = [];
  indexIds(root, e.ids);
  walk(e, root, INITIAL, false, [...IDENTITY]);
  return e.ctms;
}
```

In `src/svgembed.ts:62`, pass the viewport that is already computed one line above:

```ts
  const { content, resources, skipped } = drawSvg(root, vb);
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/svg-draw.test.ts test/svg-embed.test.ts test/svg-style.test.ts`
Expected: PASS. `svg-embed`'s "surfaces the walker skipped list" still returns `['text']`.

- [ ] **Step 5: Prove the dedupe key is load-bearing**

Temporarily change `patKey` to always allocate a fresh key (drop the `hit` lookup) and
re-run.
Expected: "dedupes one gradient shared by two identically-placed shapes" FAILS with
`pats.size === 2`. Revert.

- [ ] **Step 6: Typecheck, run the whole suite, and commit**

```bash
npm run typecheck
npm test
git add src/svgdraw.ts src/svgembed.ts test/svg-draw.test.ts
git commit -m "feat(svg): paint gradients as shading patterns in the SVG walker (1gg0.7)"
```

---

### Task 9: end-to-end rasterization check

**Files:**
- Create: `test/svg-gradient-render.test.ts`
- Test helpers (already exist, do not modify): `test/helpers/decode-png.ts`
  (`decodePng(bytes).at(x, y)` → `[r, g, b, a]` 0..255) and
  `test/helpers/build-svg-fixtures.ts` (`buildSvgPdf({ mediaBox, content })`, which
  defaults to a 200×200 page). Note `buildBlankPage()` is **not** usable here: it takes no
  options and is a fixed 612×792 page, which would put every sampled pixel somewhere else.

**Interfaces:**
- Consumes: `Document.Open`, `page.AddSVGObject`, `page.ToImage` — all existing public API.
- Produces: nothing. This is the cross-implementation check the design calls the strongest
  one available: `raster.ts` is an independently written *reader* of shadings, so the
  assertion is not a round trip through one body of code.

- [ ] **Step 1: Write the failing tests**

Create `test/svg-gradient-render.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { buildSvgPdf } from './helpers/build-svg-fixtures.js';
import { decodePng } from './helpers/decode-png.js';

const svg = (s: string) => new TextEncoder().encode(s);
const near = (v: number, target: number, tol = 14) => Math.abs(v - target) <= tol;

/** Place `src` over the whole of an empty 200x200 page, save, reopen, rasterize
 *  at 1 px per point — so a device pixel (x, y) is user (x, 200 - y). */
function render(src: string) {
  const p = Document.Open(buildSvgPdf({ mediaBox: [0, 0, 200, 200], content: '' })).Pages[0];
  const r = p.AddSVGObject(svg(src), [0, 0, 200, 200], { fit: 'fill' });
  const rt = Document.Open(p.Document.Save());
  return { png: decodePng(rt.Pages[0].ToImage()), skipped: r.skipped };
}

describe('AddSVGObject — gradients through Save/Open/ToImage', () => {
  it('ramps a linear objectBoundingBox gradient red → blue across the shape', () => {
    const { png, skipped } = render(
      '<svg viewBox="0 0 100 100"><defs><linearGradient id="g">' +
      '<stop offset="0" stop-color="#f00"/><stop offset="1" stop-color="#00f"/>' +
      '</linearGradient></defs>' +
      '<rect width="100" height="100" fill="url(#g)"/></svg>');
    expect(skipped).toEqual([]);
    const [lr, , lb] = png.at(4, 100);
    expect(lr).toBeGreaterThan(215);
    expect(lb).toBeLessThan(45);
    const [rr, , rb] = png.at(196, 100);
    expect(rr).toBeLessThan(45);
    expect(rb).toBeGreaterThan(215);
    const [cr, cg, cb] = png.at(100, 100);          // the N=1 midpoint
    expect(near(cr, 128)).toBe(true);
    expect(near(cg, 0)).toBe(true);
    expect(near(cb, 128)).toBe(true);
  });

  it('runs a vertical gradient the right way up (the y flip is not applied twice)', () => {
    // y1=0 is the TOP of the SVG, which is the TOP of the page in device pixels.
    const { png } = render(
      '<svg viewBox="0 0 100 100"><defs>' +
      '<linearGradient id="g" x1="0" y1="0" x2="0" y2="1">' +
      '<stop offset="0" stop-color="#f00"/><stop offset="1" stop-color="#00f"/>' +
      '</linearGradient></defs>' +
      '<rect width="100" height="100" fill="url(#g)"/></svg>');
    expect(png.at(100, 4)[0]).toBeGreaterThan(215);     // top is red
    expect(png.at(100, 196)[2]).toBeGreaterThan(215);   // bottom is blue
  });

  it('centres a radial gradient on the shape and reaches the rim colour', () => {
    const { png, skipped } = render(
      '<svg viewBox="0 0 100 100"><defs><radialGradient id="g">' +
      '<stop offset="0" stop-color="#f00"/><stop offset="1" stop-color="#00f"/>' +
      '</radialGradient></defs>' +
      '<circle cx="50" cy="50" r="50" fill="url(#g)"/></svg>');
    expect(skipped).toEqual([]);
    const [cr, cg, cb] = png.at(100, 100);
    expect(cr).toBeGreaterThan(215);
    expect(cg).toBeLessThan(45);
    expect(cb).toBeLessThan(45);
    const [mr, , mb] = png.at(150, 100);              // half way to the rim
    expect(near(mr, 128)).toBe(true);
    expect(near(mb, 128)).toBe(true);
  });

  it('positions an objectBoundingBox gradient on the SHAPE, not the viewport', () => {
    // The rect occupies the right half only; the ramp must complete inside it.
    const { png } = render(
      '<svg viewBox="0 0 100 100"><defs><linearGradient id="g">' +
      '<stop offset="0" stop-color="#f00"/><stop offset="1" stop-color="#00f"/>' +
      '</linearGradient></defs>' +
      '<rect x="50" y="0" width="50" height="100" fill="url(#g)"/></svg>');
    expect(png.at(198, 100)[2]).toBeGreaterThan(215);   // right edge: blue
    expect(png.at(104, 100)[0]).toBeGreaterThan(215);   // left edge of the rect: red
    expect(png.at(10, 100)).toEqual([255, 255, 255, 255]);   // outside: untouched
  });

  it('strokes with a gradient', () => {
    const { png, skipped } = render(
      '<svg viewBox="0 0 100 100"><defs><linearGradient id="g">' +
      '<stop offset="0" stop-color="#f00"/><stop offset="1" stop-color="#00f"/>' +
      '</linearGradient></defs>' +
      '<rect x="10" y="10" width="80" height="80" fill="none" ' +
      'stroke="url(#g)" stroke-width="20"/></svg>');
    expect(skipped).toEqual([]);
    expect(png.at(24, 100)[0]).toBeGreaterThan(180);    // left band: mostly red
    expect(png.at(176, 100)[2]).toBeGreaterThan(180);   // right band: mostly blue
  });

  it('repeats a linear gradient across the shape', () => {
    // userSpaceOnUse axis 0..25 over a 100-wide viewBox: four bands. Sample the
    // start of the second band, which must be red again.
    const { png } = render(
      '<svg viewBox="0 0 100 100"><defs>' +
      '<linearGradient id="g" gradientUnits="userSpaceOnUse" spreadMethod="repeat" ' +
      'x1="0" y1="0" x2="25" y2="0">' +
      '<stop offset="0" stop-color="#f00"/><stop offset="1" stop-color="#00f"/>' +
      '</linearGradient></defs>' +
      '<rect width="100" height="100" fill="url(#g)"/></svg>');
    expect(png.at(4, 100)[0]).toBeGreaterThan(200);      // band 0 start: red
    expect(png.at(46, 100)[2]).toBeGreaterThan(200);     // band 0/1 end: blue
    expect(png.at(54, 100)[0]).toBeGreaterThan(200);     // band 2 start: red again
  });

  it('honours a uniform stop-opacity against the white page', () => {
    const { png } = render(
      '<svg viewBox="0 0 100 100"><defs><linearGradient id="g">' +
      '<stop offset="0" stop-color="#f00" stop-opacity="0.5"/>' +
      '<stop offset="1" stop-color="#f00" stop-opacity="0.5"/>' +
      '</linearGradient></defs>' +
      '<rect width="100" height="100" fill="url(#g)"/></svg>');
    // 50% red over white -> (255, 128, 128)
    const [r, g, b] = png.at(100, 100);
    expect(near(r, 255)).toBe(true);
    expect(near(g, 128)).toBe(true);
    expect(near(b, 128)).toBe(true);
  });
});
```

`buildSvgPdf` writes an empty `/Contents` stream for `content: ''`, so the page is blank
white and every non-white pixel comes from the SVG.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/svg-gradient-render.test.ts`
Expected: after Task 8 these may already PASS. That is not evidence — go to Step 3.

- [ ] **Step 3: Prove the pixel assertions are load-bearing**

Run three mutations, one at a time, re-running the file after each and reverting before
the next:

1. In `src/svggradient.ts`, `patternMatrix`: return `[...ctm]` (drop the bbox map).
   Expected: "positions an objectBoundingBox gradient on the SHAPE" FAILS.
2. In `src/svggradient.ts`, the linear branch: swap `y1` and `y2`.
   Expected: "runs a vertical gradient the right way up" FAILS.
3. In `src/svggradient.ts`, `tileStops`: return `stops` unchanged.
   Expected: "repeats a linear gradient across the shape" FAILS at x = 54.

If any mutation leaves the file green, the corresponding assertion is not testing what it
claims — fix the assertion before moving on.

- [ ] **Step 4: Run the whole suite**

Run: `npm run typecheck && npm test`
Expected: all green.

- [ ] **Step 5: Commit**

```bash
git add test/svg-gradient-render.test.ts
git commit -m "test(svg): rasterize embedded gradients end to end (1gg0.7)"
```

---

### Task 10: documentation, follow-up issues, and session close

**Files:**
- Modify: `README.md:19` (the SVG embedding feature bullet), `README.md:1373` (the API
  table row)
- Modify: `src/svgdraw.ts` (drop `__ctmProbe` if Task 8's pattern `/Matrix` tests fully
  cover it — see Step 1)

- [ ] **Step 1: Decide the fate of `__ctmProbe`**

The "bakes a nested group transform into the pattern /Matrix" test from Task 8 asserts the
CTM through the public output. The `__ctmProbe` describe additionally covers `<use>`
shifts and sibling pop-out, which the pattern tests do not. **Keep** `__ctmProbe` and its
tests, and change its doc comment to drop the "removed once …" note:

```ts
/** Test-only: the CTM in effect at each painted shape, in paint order. The
 *  pattern /Matrix covers the group case through the public output; this covers
 *  the <use> shift and the pop-out on a sibling, which it does not. */
```

- [ ] **Step 2: Update the README feature bullet**

In `README.md:19`, replace the two sentences beginning "Covers paths" and "Text, gradients"
with:

```markdown
Covers paths (all commands including arcs), `rect`/`circle`/`ellipse`/`line`/`polyline`/`polygon`, `g`/`defs`/`use`, `clipPath`, `transform` lists, and solid paint (`fill`, `stroke`, widths, caps, joins, dashes, `fill-rule`, opacities) from presentation attributes and inline `style=`. **Gradients** — `linearGradient` and `radialGradient` on a fill or a stroke — become PDF shading patterns: stops (`offset`, `stop-color`, `stop-opacity`, including hard colour edges), `gradientUnits` (`objectBoundingBox` and `userSpaceOnUse`), `gradientTransform`, `spreadMethod` (`pad` everywhere, `reflect`/`repeat` on linear gradients), and `href`/`xlink:href` reuse between gradient elements. Two gradient limitations: a **per-stop varying `stop-opacity`** paints opaque (uniform alpha is exact), and `reflect`/`repeat` on a **radial** gradient falls back to `pad` — both name the gradient element in `result.skipped`. Text, `<pattern>`, `<image>`, masks, filters, markers and CSS `<style>` selectors are **not** rendered — they are skipped and named in `result.skipped`, so a caller can detect the degradation. Group `opacity` is folded into child alphas, which is exact unless the children overlap.
```

- [ ] **Step 3: Update the API table row**

In `README.md:1373`, replace the `page.AddSVGObject` row's description with:

```markdown
| `page.AddSVGObject(data, rect, opts?)` | Parse an SVG and draw it into `[x, y, w, h]` as a Form XObject (`fit` overrides `preserveAspectRatio`); shapes, `clipPath`, `use`, solid paint and `linearGradient`/`radialGradient` (→ PDF shading patterns); returns `{ skipped }` naming anything it could not render |
```

- [ ] **Step 4: Verify the README claims against the code**

Read `README.md:19` back and confirm every capability it names has a passing test in
`test/svg-gradient.test.ts`, `test/svg-draw.test.ts` or `test/svg-gradient-render.test.ts`.
Any claim without one is either wrong or an untested feature; fix whichever it is.

- [ ] **Step 5: File the three follow-ups**

```bash
bd create "SVG gradients: luminosity /SMask for varying stop-opacity" \
  -t feature -p 3 --parent aspose-pdf-foss-for-ts-1gg0 \
  -d "AddSVGObject paints a gradient opaque when stop-opacity differs across stops, and reports the element in skipped (1gg0.7). Exact support needs a luminosity /SMask: a parallel grayscale shading of the alpha ramp, wrapped in a transparency-group Form XObject. See docs/superpowers/specs/2026-07-28-svg-gradients-design.md."

bd create "SVG gradients: reflect/repeat spread on radial gradients" \
  -t feature -p 3 --parent aspose-pdf-foss-for-ts-1gg0 \
  -d "1gg0.7 synthesizes reflect/repeat stops for LINEAR gradients only; a radial one falls back to pad and is reported in skipped. Tiling an annulus outward has no direct PDF equivalent — it needs either many stitched ShadingType 3 rings or a tiling pattern."

bd create "SVG embedding: the <pattern> element" \
  -t feature -p 3 --parent aspose-pdf-foss-for-ts-1gg0 \
  -d "AddSVGObject reports <pattern> in skipped. It maps onto a PatternType 1 (tiling) pattern, whose content stream is the pattern element's children through the same walker — which means svgdraw.ts must be able to emit a nested stream, unlike the flat one it emits today."
```

- [ ] **Step 6: Close the issue and push**

```bash
npm run typecheck
npm test
git add README.md src/svgdraw.ts
git commit -m "docs(svg): document gradient support and its two limitations (1gg0.7)"
bd close aspose-pdf-foss-for-ts-1gg0.7
git pull --rebase
git push
git status   # MUST show "up to date with origin"
```

---

## Self-review notes

Checked against `docs/superpowers/specs/2026-07-28-svg-gradients-design.md`:

| Design section | Task |
|---|---|
| Scope: linear + radial on fill/stroke | 6, 8 |
| `gradientUnits` both values | 6 |
| `gradientTransform` | 6 |
| `spreadMethod` pad / reflect / repeat | 6 (pad), 7 (reflect, repeat) |
| Stops: offset %, stop-color, stop-opacity, style cascade | 2 (`styleGetter`), 4 |
| `href` / `xlink:href` reuse + cycle guard | 4 |
| Mechanism: PatternType 2, direct dicts only | 6 |
| Pattern matrix + composition order | 6 |
| Bounding box, tight via cubic extrema | 1 |
| Stop normalization steps 1–4 | 4 (1–3), 5 (4) |
| Type 2 / type 3 function | 5 |
| `currentColor` → black | 4 |
| Degenerate cases table (5 rows, none reported) | 6 |
| Linear + radial defaults, focal clamp, percentages | 6 |
| Viewport passed into `drawSvg` | 8 |
| Spread range computed via `invert`, 64 cap, CTM cancellation | 7 |
| Radial reflect/repeat → pad + report | 6 |
| Uniform `stop-opacity` → `/ca` + `/CA`; varying → report | 6, 8 |
| Modules: svggradient / svgpath / svgstyle / svgdraw / svgembed | 4–8 |
| No new error conditions | — (nothing added) |
| Testing: pure modules, `segsBBox` vs an independent formula, `svgdraw` emission, `svgembed` end-to-end `ToImage`, mutation proofs | 1, 4–9 |
| Documentation | 10 |
| Follow-ups filed | 10 |

Type consistency: `SegBBox` (Task 1) is the box type everywhere; `GradientStop`,
`ResolvedGradient`, `GradientPaint`, `resolveGradient`, `normalizeStops`, `stopsFunction`,
`gradientPaint`, `spreadRange`, `tileStops` are the only `svggradient.ts` exports and each
is used with the signature it was defined with. `Paint.fillRef` / `Paint.strokeRef` are
named identically in Tasks 2 and 8. `drawSvg(root, viewport)` is the signature in Tasks 8
and its one caller in `svgembed.ts`.

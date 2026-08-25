# SVG `<filter>` FillPaint / StrokePaint Inputs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `FillPaint` and `StrokePaint` usable as filter graph inputs for solid paint, instead of refusing the whole chain.

**Architecture:** `runFilter` already seeds its `results` map with `SourceGraphic` and `SourceAlpha`; these are two more seeds, built as constant-colour planes. The element's resolved `Paint` is threaded into `resolveFilter`, which turns its `RUNNABLE_PSEUDO` set into a paint-dependent predicate and carries the two colours through on `FilterSpec`. Nothing rasterizes and `svgfilterfx.ts` stays pure.

**Tech Stack:** TypeScript (ESM, NodeNext, `strict`), vitest. Zero runtime dependencies — `node:` built-ins only.

**Spec:** `docs/superpowers/specs/2026-07-31-svg-filter-paint-inputs-design.md`

**Issue:** `aspose-pdf-foss-for-ts-1gg0.10.6`

## Global Constraints

- **Zero runtime dependencies.** Only `node:` built-ins. Do not add npm runtime deps.
- **ESM + NodeNext.** Every relative import specifier carries the `.js` extension (`./svgfilter.js`), even from a `.ts` file.
- **`src/svgfilter.ts` stays pure.** No pixels, no `Document`, no allocation.
- **`src/svgfilterfx.ts` rasterizes nothing.** Pixels it is handed, pixels it computes — never pixels it renders.
- **`fill-opacity` and `stroke-opacity` are never read** by any code in this plan. SVG 1.1 §15.7.3 defines the plane as the value of the *fill property*; the opacities are separate properties.
- **Both gates must be green before the issue closes:** `npm run typecheck` and `npm test`.
- **Target a single file while iterating:** `npx vitest run test/<name>.test.ts`.
- **Commit messages** end with `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`.

## File Structure

| File | Responsibility | Change |
|---|---|---|
| `src/svgfilter.ts` | Pure filter resolution: region, subregions, input wiring | `RUNNABLE_PSEUDO` set → `pseudoOk` predicate; `FilterSpec.paint`; `resolveFilter` gains a trailing `paint?: Paint`. ~25 lines. |
| `src/svgfilterfx.ts` | The kernels; owns pixels, renders none | `planeSurface` + lazy seeding into `results`/`windows`. ~25 lines. |
| `src/svgdraw.ts` | SVG → operators | One argument at the `resolveFilter` call site. |
| `test/svg-filter-paint.test.ts` | The whole phase: resolver acceptance, plane kernels, end-to-end | Create |
| `README.md` | User-facing feature list | The `FillPaint`-refuses sentence is now half false (Task 4) |

## Why the first task is not split

The obvious decomposition — resolver gate, then plane — is **wrong in both orders**, and the plan deliberately fuses them:

- **Gate first** leaves a commit where `resolveFilter` accepts `FillPaint` but `runFilter` has no seed for it. `results.get('FillPaint')` then returns `undefined` and falls back to a transparent surface, so the chain runs and quietly paints nothing. That is the exact failure the `SUPPORTED`-set invariant in `svgfilter.ts:58` warns about: plausible ink that is silently wrong, which is worse than a reported refusal.
- **Plane first** is safe but untestable through `resolveFilter`, because the resolver still refuses every chain that names the input. Testing it would mean hand-building `FilterPrim` objects, which duplicates the resolver rather than exercising it.

A reviewer cannot sensibly approve either half without the other, so they are one task. It stays safe at the commit boundary because `svgdraw.ts` does not yet pass `paint` — the capability exists and is unit-tested, but no public API can reach it until Task 2.

## Background an implementer needs

Read the spec first. Beyond it, four facts this code depends on:

1. **`results` holds LINEAR premultiplied surfaces.** `inSpace(key)` converts to sRGB on demand for a primitive that asked for it. So a seed must be linear. This is the **opposite** convention from `floodKernel`, which builds in the primitive's own space and lets `runFilter` convert back — because a flood is a primitive *output* and a plane is a graph *input*.
2. **A saturated primary cannot test the linearization.** `srgbToLinear` fixes both endpoints (`0 → 0`, `1 → 1`), so `#ff0000`, `#00ff00`, `#0000ff`, `#000000` and `#ffffff` all survive the conversion being deleted. Every fixture here uses the mid-tone `#996633`.
3. **`Paint.fill` is `Rgb | null`** (`null` = `none`) and **`Paint.fillRef` is `string | null`** (non-null = a gradient or pattern reference). `INITIAL` from `svgstyle.ts` has `fill: [0,0,0]`, `stroke: null` — SVG's initial stroke really is `none`.
4. **`windows` is read only by `feTile`**, which repeats its *input's* subregion. A plane has infinite extent, so its window is the whole region.

---

### Task 1: The paint planes and the resolver gate

**Files:**
- Modify: `src/svgfilter.ts` — replace `RUNNABLE_PSEUDO` (lines 71-79), extend `FilterSpec` (lines 34-44), extend `resolveFilter`'s signature and its input-validation loop
- Modify: `src/svgfilterfx.ts` — add `planeSurface`, seed in `runFilter` (after the `windows.set('SourceAlpha', whole)` line)
- Test: `test/svg-filter-paint.test.ts` (create)

**Interfaces:**
- Consumes: `type Paint`, `INITIAL`, `type Rgb` from `src/svgstyle.js`; `makeSurface(x, y, w, h): Surface` and `srgbToLinear(v: number): number` from `src/svgfilterfx.js`.
- Produces:
  - `resolveFilter(node: XmlNode, bbox: SegBBox | null, viewport: ViewBox, css?: CssDecls, paint?: Paint): FilterResolution` — the fifth parameter is new and optional; omitting it refuses both pseudo-inputs.
  - `FilterSpec.paint?: { fill: Rgb | null; stroke: Rgb | null }`
  - `function pseudoOk(v: string, paint: Paint | undefined): boolean` — module-private to `svgfilter.ts`
  - `function planeSurface(c: Rgb | null, w: number, h: number): Surface` — module-private to `svgfilterfx.ts`

- [ ] **Step 1: Write the failing tests**

Create `test/svg-filter-paint.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { parseXml, type XmlNode } from '../src/xml.js';
import { resolveFilter, type FilterResolution, type FilterSpec } from '../src/svgfilter.js';
import { makeSurface, runFilter, srgbToLinear, type Surface } from '../src/svgfilterfx.js';
import { INITIAL, type Paint } from '../src/svgstyle.js';

const xml = (s: string) => new TextEncoder().encode(s);
const near = (a: number, b: number, d = 5) => expect(a).toBeCloseTo(b, d);

/** A mid-tone, and it has to be. srgbToLinear fixes 0 and 1, so #ff0000,
 *  #ffffff and #000000 all survive the linearization being DELETED and cannot
 *  test the seed at all. #996633 = (0x99, 0x66, 0x33). */
const MID: [number, number, number] = [0x99 / 255, 0x66 / 255, 0x33 / 255];

const VP = { minX: 0, minY: 0, w: 100, h: 100 };

/** resolveFilter over a 10x10 user-space region, so at scale 1 one user unit is
 *  one pixel and every pixel expectation below reads directly. */
function resolve(prims: string, paint: Paint | undefined): FilterResolution {
  const root = parseXml(xml(
    '<svg><filter id="f" filterUnits="userSpaceOnUse" x="0" y="0" ' +
    `width="10" height="10">${prims}</filter></svg>`));
  let f: XmlNode | undefined;
  const walk = (n: XmlNode): void => {
    if (n.name === 'filter') f ??= n;
    for (const c of n.children) walk(c);
  };
  walk(root);
  return resolveFilter(f!, { x: 0, y: 0, w: 10, h: 10 }, VP, undefined, paint);
}

/** resolve(), asserting it resolved, with `p` overriding INITIAL. */
function specWith(prims: string, p: Partial<Paint>): FilterSpec {
  const r = resolve(prims, { ...INITIAL, ...p });
  if (r.kind !== 'draw') throw new Error(`expected draw, got ${r.kind}`);
  return r.spec;
}

/** A 10x10 source: opaque white in the top-left 2x2, transparent elsewhere. */
function source(): Surface {
  const s = makeSurface(0, 0, 10, 10);
  for (let y = 0; y < 2; y++) for (let x = 0; x < 2; x++) {
    const i = (y * 10 + x) * 4;
    s.data[i] = 1; s.data[i + 1] = 1; s.data[i + 2] = 1; s.data[i + 3] = 1;
  }
  return s;
}

const px = (s: Surface, x: number, y: number): number[] =>
  [...s.data.slice((y * s.w + x) * 4, (y * s.w + x) * 4 + 4)];

/** Keep the whole plane: feMerge of one node is a pass-through. */
const MERGE = (input: string) => `<feMerge><feMergeNode in="${input}"/></feMerge>`;
const TINT = '<feComposite in="FillPaint" in2="SourceAlpha" operator="in"/>';

describe('resolveFilter — FillPaint/StrokePaint acceptance', () => {
  const solid: Paint = { ...INITIAL, fill: [1, 0, 0], stroke: [0, 0, 1] };

  it('accepts FillPaint when the caller supplies solid paint', () => {
    expect(resolve(TINT, solid).kind).toBe('draw');
  });

  it('refuses FillPaint when no paint is supplied', () => {
    // Every caller before 1gg0.10.6 passed four arguments and must keep
    // refusing. Accepting here would seed nothing and paint a transparent
    // plane as if it were ink.
    expect(resolve(TINT, undefined)).toEqual({ kind: 'skip', report: ['filter'] });
  });

  it('refuses FillPaint for a gradient or pattern fill', () => {
    expect(resolve(TINT, { ...INITIAL, fillRef: 'g' }))
      .toEqual({ kind: 'skip', report: ['filter'] });
  });

  it('accepts fill="none": a transparent plane is well defined', () => {
    expect(resolve(TINT, { ...INITIAL, fill: null }).kind).toBe('draw');
  });

  it('accepts StrokePaint on an element that never set a stroke', () => {
    // SVG's initial stroke IS none, so this is the common case, not an edge
    // one. Refusing it would put StrokePaint out of reach of most elements.
    expect(resolve(MERGE('StrokePaint'), INITIAL).kind).toBe('draw');
  });

  it('refuses StrokePaint for a gradient stroke', () => {
    expect(resolve(MERGE('StrokePaint'), { ...INITIAL, strokeRef: 'g' }))
      .toEqual({ kind: 'skip', report: ['filter'] });
  });

  it('still refuses BackgroundImage, paint or no paint', () => {
    // It needs the accumulated page backdrop, which a single-pass walker does
    // not retain. Supplying paint must not widen the gate to everything.
    expect(resolve(MERGE('BackgroundImage'), solid))
      .toEqual({ kind: 'skip', report: ['filter'] });
  });

  it('carries only the two colours onto the spec', () => {
    const r = resolve(TINT, solid);
    if (r.kind !== 'draw') throw new Error('expected draw');
    expect(r.spec.paint).toEqual({ fill: [1, 0, 0], stroke: [0, 0, 1] });
  });

  it('leaves spec.paint absent when the caller supplied none', () => {
    const r = resolve(MERGE('SourceGraphic'), undefined);
    if (r.kind !== 'draw') throw new Error('expected draw');
    expect(r.spec.paint).toBeUndefined();
  });
});

describe('runFilter — the paint planes', () => {
  it('seeds FillPaint as an opaque LINEAR plane', () => {
    const out = runFilter(specWith(MERGE('FillPaint'), { fill: MID }), source(), 1);
    // Linear, not sRGB. With the conversion deleted these read MID directly —
    // 0.6 vs 0.318 at the red channel, nowhere near the tolerance.
    near(px(out, 5, 5)[0], srgbToLinear(MID[0]));
    near(px(out, 5, 5)[1], srgbToLinear(MID[1]));
    near(px(out, 5, 5)[2], srgbToLinear(MID[2]));
    near(px(out, 5, 5)[3], 1);
  });

  it('covers the whole region, not just where the source has ink', () => {
    const out = runFilter(specWith(MERGE('FillPaint'), { fill: MID }), source(), 1);
    // The far corner: the source is transparent there, the plane is not.
    near(px(out, 9, 9)[3], 1);
  });

  it('does not swap the fill and stroke planes', () => {
    const out = runFilter(
      specWith(MERGE('StrokePaint'), { fill: [1, 0, 0], stroke: MID }), source(), 1);
    near(px(out, 5, 5)[0], srgbToLinear(MID[0]));
    near(px(out, 5, 5)[1], srgbToLinear(MID[1]));
  });

  it('makes a `none` paint a fully transparent plane', () => {
    const out = runFilter(
      specWith(MERGE('StrokePaint'), { fill: MID, stroke: null }), source(), 1);
    near(px(out, 5, 5)[3], 0);
  });

  it('composites the plane through the source alpha', () => {
    const out = runFilter(specWith(TINT, { fill: MID }), source(), 1);
    near(px(out, 0, 0)[0], srgbToLinear(MID[0]));   // inside the 2x2 silhouette
    near(px(out, 0, 0)[3], 1);
    near(px(out, 5, 5)[3], 0);                      // outside it: operator="in"
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/svg-filter-paint.test.ts`
Expected: FAIL. TypeScript rejects the 5-argument `resolveFilter` call, so the file fails to load.

- [ ] **Step 3: Extend `src/svgfilter.ts`**

Add `Paint` to the existing `svgstyle.js` import at line 8:

```ts
import { parseColor, styleGetter, type Paint, type Rgb } from './svgstyle.js';
```

Add the field to `FilterSpec`, after `res`:

```ts
  /** The element's own paint, for the FillPaint/StrokePaint pseudo-inputs.
   *  `null` in either slot means that paint is `none`: a transparent plane.
   *  Absent when the caller supplied no paint, which refuses both. */
  paint?: { fill: Rgb | null; stroke: Rgb | null };
```

Replace `RUNNABLE_PSEUDO` (lines 71-79) entirely with:

```ts
/** Whether a pseudo-input can actually be produced for THIS element.
 *
 *  SourceGraphic and SourceAlpha always can. FillPaint and StrokePaint need the
 *  element's resolved paint, which reaches here only when the caller passes it
 *  -- so an absent `paint` refuses both, which is what every caller did before
 *  1gg0.10.6 and what leaves them unchanged. A gradient or pattern paint server
 *  (fillRef/strokeRef) cannot be flattened to one colour and refuses; `none` is
 *  fine, because a transparent plane is exactly what SVG defines it as, and
 *  stroke DEFAULTS to none.
 *
 *  BackgroundImage and BackgroundAlpha still fall through: they need the
 *  accumulated page backdrop, which a single-pass walker does not retain and
 *  which no shipping browser has ever implemented. */
function pseudoOk(v: string, paint: Paint | undefined): boolean {
  if (v === 'SourceGraphic' || v === 'SourceAlpha') return true;
  if (v === 'FillPaint') return paint !== undefined && paint.fillRef === null;
  if (v === 'StrokePaint') return paint !== undefined && paint.strokeRef === null;
  return false;
}
```

Extend `resolveFilter`'s signature:

```ts
export function resolveFilter(
  node: XmlNode, bbox: SegBBox | null, viewport: ViewBox,
  css?: CssDecls, paint?: Paint,
): FilterResolution {
```

In the input-validation loop, replace the `RUNNABLE_PSEUDO.has(v)` line:

```ts
      if (pseudoOk(v, paint)) continue;
```

And carry the colours in the returned spec:

```ts
  return {
    kind: 'draw',
    spec: {
      region, prims, obb: pobb, bbox, res: filterRes(node.attrs.get('filterRes')),
      paint: paint === undefined ? undefined : { fill: paint.fill, stroke: paint.stroke },
    },
  };
```

- [ ] **Step 4: Add the plane to `src/svgfilterfx.ts`**

Add `Rgb` to the existing `svgstyle.js` import at line 12:

```ts
import { parseColor, type Rgb } from './svgstyle.js';
```

Add `planeSurface` immediately above `runFilter`:

```ts
/** An infinite plane of one solid colour (SVG 1.1 15.7.3), as a full-region
 *  surface. `null` is the `none` paint: transparent black everywhere.
 *
 *  Seeded LINEAR and premultiplied, which is the OPPOSITE convention from
 *  floodKernel above. A flood is a primitive OUTPUT, built in that primitive's
 *  own working space and converted back by runFilter; a plane is a graph INPUT,
 *  and `results` holds linear surfaces that inSpace converts on demand.
 *  Building this one in sRGB would ship silently wrong gamma -- and no
 *  saturated primary could catch it, since srgbToLinear fixes 0 and 1. */
function planeSurface(c: Rgb | null, w: number, h: number): Surface {
  const s = makeSurface(0, 0, w, h);
  if (c === null) return s;
  const r = srgbToLinear(c[0]), g = srgbToLinear(c[1]), b = srgbToLinear(c[2]);
  // Opaque, so premultiplying by alpha = 1 is the identity.
  for (let i = 0; i < w * h; i++) s.data.set([r, g, b, 1], i * 4);
  return s;
}
```

In `runFilter`, immediately after `windows.set('SourceAlpha', whole);`:

```ts
  // FillPaint/StrokePaint: infinite planes of the element's own paint, so their
  // window is the whole region. Seeded only when the chain names one -- a plane
  // is W*H*4 floats, around 2.5 MB at 400x400, which is not worth allocating
  // for the chains that never ask.
  if (spec.paint !== undefined) {
    const named = new Set<string>();
    for (const p of spec.prims) { named.add(p.in1); named.add(p.in2); }
    if (named.has('FillPaint')) {
      results.set('FillPaint', planeSurface(spec.paint.fill, W, H));
      windows.set('FillPaint', whole);
    }
    if (named.has('StrokePaint')) {
      results.set('StrokePaint', planeSurface(spec.paint.stroke, W, H));
      windows.set('StrokePaint', whole);
    }
  }
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run test/svg-filter-paint.test.ts`
Expected: PASS, all 14 tests.

- [ ] **Step 6: Run the gates**

Run: `npm run typecheck && npm test`
Expected: both green. No existing test changes behaviour — `svgdraw.ts` still calls `resolveFilter` with four arguments, so both pseudo-inputs still refuse everywhere outside this new file.

- [ ] **Step 7: Commit**

```bash
git add src/svgfilter.ts src/svgfilterfx.ts test/svg-filter-paint.test.ts
git commit -m "feat(svg): FillPaint/StrokePaint planes and the resolver gate

runFilter seeds two more entries in its results map, built as constant
colour planes; resolveFilter takes the element's resolved Paint and turns
RUNNABLE_PSEUDO into a paint-dependent predicate.

The gate and the seed land together deliberately. Accepting the input
before runFilter can produce it would fall back to a transparent surface
and paint nothing while reporting success -- the same failure the
SUPPORTED-set invariant exists to prevent.

The plane is seeded LINEAR, the opposite convention from floodKernel: a
flood is a primitive output built in its own working space, a plane is a
graph input and results holds linear surfaces.

Not reachable from the public API yet: svgdraw still passes four
arguments.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 2: Wire it to the walker

One argument at one call site, plus the end-to-end coverage that proves the whole stack carries the colour.

**Files:**
- Modify: `src/svgdraw.ts` — the `resolveFilter` call inside `walk`'s filter block (~line 1145)
- Test: `test/svg-filter-paint.test.ts` (append)

**Interfaces:**
- Consumes: `resolveFilter(node, bbox, viewport, css?, paint?)` from Task 1. In `walk`, the local `paint` (from `resolveStyle` at line 1026) is already in scope at the filter block.
- Produces: nothing later tasks import.

- [ ] **Step 1: Write the failing tests**

Append to `test/svg-filter-paint.test.ts`, and add these imports at the top of the file:

```ts
import { Document } from '../src/document.js';
import { buildSvgPdf } from './helpers/build-svg-fixtures.js';
import { decodePng } from './helpers/decode-png.js';
```

```ts
/** Place `src` over a 200x200 page at 1 px per point and rasterize it. */
function render(src: string) {
  const p = Document.Open(buildSvgPdf({ mediaBox: [0, 0, 200, 200], content: '' })).Pages[0];
  const r = p.AddSVGObject(xml(src), [0, 0, 200, 200], { fit: 'fill' });
  const rt = Document.Open(p.Document.Save());
  return { png: decodePng(rt.Pages[0].ToImage()), result: r };
}

/** A shape carrying `style`, filtered by `prims`, over a user-space region
 *  covering the whole viewBox. */
const page = (prims: string, style: string) =>
  '<svg viewBox="0 0 200 200"><defs>' +
  '<linearGradient id="g"><stop offset="0" stop-color="#f00"/>' +
  '<stop offset="1" stop-color="#00f"/></linearGradient>' +
  '<filter id="f" filterUnits="userSpaceOnUse" x="0" y="0" width="200" height="200">' +
  prims + '</filter></defs>' +
  `<rect x="20" y="20" width="60" height="60" ${style} filter="url(#f)"/></svg>`;

describe('AddSVGObject — FillPaint through the whole stack', () => {
  it("floods the region with the element's own fill colour", () => {
    const { png, result } = render(page(MERGE('FillPaint'), 'fill="#996633"'));
    expect(result.skipped).toEqual([]);
    expect(result.rasterized).toEqual(['filter']);
    // A mid-tone, so a missing linearization anywhere in the stack shows up.
    // Well away from the rect, to prove the plane covers the whole region.
    const [r, g, b] = png.at(150, 150);
    expect(Math.abs(r - 0x99)).toBeLessThan(12);
    expect(Math.abs(g - 0x66)).toBeLessThan(12);
    expect(Math.abs(b - 0x33)).toBeLessThan(12);
  });

  it('ignores fill-opacity: the plane is the paint, not the painted result', () => {
    // SVG 15.7.3 defines FillPaint as the value of the FILL PROPERTY, and
    // fill-opacity is a separate property. Fold it in and this pixel washes
    // out toward the white page.
    const { png } = render(page(MERGE('FillPaint'), 'fill="#996633" fill-opacity="0.4"'));
    const [r, g, b] = png.at(150, 150);
    expect(Math.abs(r - 0x99)).toBeLessThan(12);
    expect(Math.abs(g - 0x66)).toBeLessThan(12);
    expect(Math.abs(b - 0x33)).toBeLessThan(12);
  });

  it("floods with the element's stroke colour for StrokePaint", () => {
    const { png } = render(page(MERGE('StrokePaint'), 'fill="#ff0000" stroke="#996633"'));
    const [r, g, b] = png.at(150, 150);
    expect(Math.abs(r - 0x99)).toBeLessThan(12);
    expect(Math.abs(g - 0x66)).toBeLessThan(12);
    expect(Math.abs(b - 0x33)).toBeLessThan(12);
  });

  it('draws unfiltered and reports for a gradient fill', () => {
    const { png, result } = render(page(MERGE('FillPaint'), 'fill="url(#g)"'));
    expect(result.skipped).toEqual(['filter']);
    expect(result.rasterized).toEqual([]);
    // The gradient itself, unfiltered: red at the rect's left edge.
    expect(png.at(25, 50)[0]).toBeGreaterThan(150);
    // And nothing flooded the region.
    expect(png.at(150, 150)[0]).toBeGreaterThan(240);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/svg-filter-paint.test.ts -t "whole stack"`
Expected: FAIL. `svgdraw.ts` still passes four arguments, so every `FillPaint` chain refuses: `skipped` is `['filter']` where the tests expect `[]`, and the page stays white where they expect the mid-tone.

- [ ] **Step 3: Pass the paint at the call site**

In `src/svgdraw.ts`, inside `walk`'s filter block, change:

```ts
      const r = complete
        ? resolveFilter(fnode, box, e.viewport, e.css.get(fnode))
        : { kind: 'skip' as const, report: ['filter'] };
```

to:

```ts
      const r = complete
        // `paint` is the element's own resolved paint, which is what
        // FillPaint/StrokePaint are planes of. For a <g> that is the group's
        // fill, which is also what its children inherit -- the same value SVG
        // means by "the fill property on the target element".
        ? resolveFilter(fnode, box, e.viewport, e.css.get(fnode), paint)
        : { kind: 'skip' as const, report: ['filter'] };
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/svg-filter-paint.test.ts`
Expected: PASS, all 18 tests.

- [ ] **Step 5: Run the gates**

Run: `npm run typecheck && npm test`
Expected: both green.

- [ ] **Step 6: Commit**

```bash
git add src/svgdraw.ts test/svg-filter-paint.test.ts
git commit -m "feat(svg): FillPaint/StrokePaint reach the walker

One argument at one call site. For a <g> the paint is the group's own
fill, which is what its children inherit and what SVG means by 'the fill
property on the target element'.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 3: Prove the tests are load-bearing

Every test so far passed on its first run after implementation. This task breaks each guarded path and confirms the suite goes red.

**This task writes no production code.** It adds fixtures only where a mutation survives.

**Files:**
- Modify: `test/svg-filter-paint.test.ts` (only if a mutation survives)

**Interfaces:**
- Consumes: everything from Tasks 1-2.
- Produces: nothing.

- [ ] **Step 1: Run each mutation and record the result**

For each row: make the edit, run `npx vitest run test/svg-filter-paint.test.ts`, record whether it went red, then **revert** with `git checkout -- src/` before the next row.

| # | Mutation | Must fail because |
|---|---|---|
| 1 | In `planeSurface`, drop the conversion: `const r = c[0], g = c[1], b = c[2];` | `'seeds FillPaint as an opaque LINEAR plane'` — this is the mutation the mid-tone exists for, and the one a primary would let through |
| 2 | In `planeSurface`, set alpha to 0 instead of 1 | `'covers the whole region'` and the end-to-end flood tests |
| 3 | In `planeSurface`, return the transparent surface for a non-null colour too (move the `return s` above the fill loop) | every plane test |
| 4 | In `runFilter`'s seeding, swap the two: seed `FillPaint` from `spec.paint.stroke` and vice versa | `'does not swap the fill and stroke planes'` |
| 5 | In `pseudoOk`, drop the `paint !== undefined` guard on `FillPaint` | `'refuses FillPaint when no paint is supplied'` |
| 6 | In `pseudoOk`, drop the `paint.fillRef === null` check | `'refuses FillPaint for a gradient or pattern fill'` |
| 7 | In `pseudoOk`, `return true` unconditionally at the end | `'still refuses BackgroundImage, paint or no paint'` |
| 8 | In `resolveFilter`'s return, set `paint: undefined` always | `'carries only the two colours onto the spec'`, plus every kernel test |
| 9 | In `runFilter`'s seeding, delete both `windows.set` lines | **Expected to SURVIVE** — see Step 2 |
| 10 | In `svgdraw.ts`, revert the call site to four arguments | all four end-to-end tests |

- [ ] **Step 2: Resolve mutation 9 — a survivor here is a decision, not a gap**

`windows` is read only by `feTile`, and no test drives `feTile` over a paint plane. Two honest resolutions; pick one and say which in the task report:

- **Add the test.** Append this, which pins the infinite-extent semantics — `feTile` repeats its input's subregion, and for a plane that is the whole region, so tiling is the identity:

```ts
  it('gives a plane the whole region as its tile window', () => {
    // feTile repeats its INPUT's subregion. A plane has infinite extent, so
    // its window is the whole region and tiling it is the identity. Without
    // the windows entry feTile has no subregion to repeat.
    const out = runFilter(
      specWith(`<feMerge><feMergeNode in="FillPaint"/></feMerge>` +
               `<feTile in="FillPaint"/>`, { fill: MID }), source(), 1);
    near(px(out, 5, 5)[0], srgbToLinear(MID[0]));
    near(px(out, 5, 5)[3], 1);
  });
```

  Then re-run mutation 9 and confirm it goes red. If it still survives, `feTile` is falling back to a default window that happens to be right — in which case take the second option.

- **Delete the two `windows.set` lines** as dead code, and note it. Untested code that no path reaches is worse than absent code.

Do **not** leave mutation 9 unresolved.

- [ ] **Step 3: Investigate any other survivor**

A surviving mutation means the guard it broke has no test. Add a fixture that fails under that mutation and passes without it, then re-run to confirm it goes red.

- [ ] **Step 4: Confirm the tree is clean**

Run: `git status --porcelain src/`
Expected: no output. Every mutation reverted.

- [ ] **Step 5: Run the gates**

Run: `npm run typecheck && npm test`
Expected: both green.

- [ ] **Step 6: Commit (only if Steps 2-3 changed the test file)**

```bash
git add test/svg-filter-paint.test.ts src/svgfilterfx.ts
git commit -m "test(svg): make the paint-plane guards load-bearing

Found by mutation, not by failure: <name what survived and what each
change pins>.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 4: Documentation, memory, and close

**Files:**
- Modify: `README.md:19` (the SVG embedding bullet, Filters portion)

**Interfaces:**
- Consumes: the shipped feature.
- Produces: nothing.

- [ ] **Step 1: Correct the README's refusal sentence**

Find this text in the **Filters** portion of the `README.md:19` bullet:

> An unresolvable `in`, a malformed `feConvolveMatrix` kernel, a lighting primitive with no light source, or the `BackgroundImage`/`FillPaint` pseudo-inputs make the element draw **unfiltered** and report

Replace it with:

> `FillPaint` and `StrokePaint` are supported for solid paint — infinite planes of the element's own `fill`/`stroke`, with `none` giving a transparent plane; per SVG 1.1 §15.7.3 these are the *paint*, so `fill-opacity`/`stroke-opacity` are deliberately not folded in, and a plane is the filter region rather than truly infinite. An unresolvable `in`, a malformed `feConvolveMatrix` kernel, a lighting primitive with no light source, a `FillPaint`/`StrokePaint` naming a gradient or pattern, or the `BackgroundImage`/`BackgroundAlpha` pseudo-inputs make the element draw **unfiltered** and report

- [ ] **Step 2: Run the gates one last time**

Run: `npm run typecheck && npm test`
Expected: both green.

- [ ] **Step 3: Commit the docs**

```bash
git add README.md
git commit -m "docs: FillPaint/StrokePaint are supported for solid paint

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

- [ ] **Step 4: Record what shipped and close the issue**

```bash
bd remember --key svg-filter-paint-inputs-shipped "1gg0.10.6 shipped. FillPaint/StrokePaint are graph INPUTS, not emissions: runFilter seeds two more entries in its results map beside SourceGraphic/SourceAlpha, built by planeSurface as constant-colour planes. resolveFilter gained a 5th optional param (paint?: Paint) and RUNNABLE_PSEUDO became the pseudoOk(v, paint) predicate. Nothing rasterizes.

THE GATE AND THE SEED MUST SHIP TOGETHER. Accepting the input before runFilter can produce it falls back to a transparent surface and paints nothing while reporting success -- the same failure the SUPPORTED-set invariant prevents. An ABSENT paint refuses both, which is what keeps every pre-existing caller unchanged.

SEEDED LINEAR, the OPPOSITE convention from floodKernel: a flood is a primitive OUTPUT built in its own working space and converted back, a plane is a graph INPUT and results holds linear surfaces. THE FIXTURE TRAP: srgbToLinear fixes 0 and 1, so #ff0000/#ffffff/#000000 all survive the conversion being DELETED -- every fixture uses the mid-tone #996633. Same shape as .10.4's all-red-PNG trap.

DECISIONS, do not re-litigate: fill-opacity is NOT read (15.7.3 defines the plane as the fill PROPERTY; the spec's own alpha note points at the paint server), so FillPaint composited against SourceAlpha is MORE opaque than the element -- intended, since SourceGraphic already has fill-opacity baked in. fill/stroke = none is a TRANSPARENT plane, not a refusal, because stroke DEFAULTS to none. Only fillRef/strokeRef refuse.

KNOWN DIVERGENCE, not reported: our plane is the filter region, not infinite, so feOffset/feGaussianBlur/feConvolveMatrix/feMorphology consuming a plane see transparent in a band at the region edge. The plane is constant, so the error is edge-confined.

No fast-path interaction: classify (1gg0.10.5) matches in1 === 'SourceGraphic' on every branch, so these always rasterize."

bd close aspose-pdf-foss-for-ts-1gg0.10.6
```

- [ ] **Step 5: Push**

```bash
git pull --rebase
git push
git status
```

Expected: `git status` reports the branch up to date with `origin`. Work is not complete until this succeeds.

---

## Self-review

**Spec coverage.** Every section maps to a task: the `pseudoOk` predicate, `FilterSpec.paint` and the `resolveFilter` signature (Task 1, Step 3); `planeSurface` with its linear seeding and the lazy allocation (Task 1, Step 4); the `svgdraw` call site (Task 2, Step 3); the `fill-opacity` decision (Task 2's `'ignores fill-opacity'` test, plus mutation coverage via the mid-tone); `none` as a transparent plane and `stroke` defaulting to `none` (Task 1's acceptance tests); the refusal keeping the `filter` report (asserted as `{ kind: 'skip', report: ['filter'] }` throughout); the gradient/pattern boundary (Task 1 and Task 2); `BackgroundImage` still refusing (Task 1, mutation 7); the "no fast-path interaction" note (no code, so no task — it is an invariant the existing `classify` already satisfies, and Task 2's end-to-end tests assert `rasterized: ['filter']`, which proves the chain took the raster path); the known divergence (documented in Task 4's README text, no code); the "not tested, deliberately" note on lazy seeding (honoured — no test asserts allocation).

The spec's Files table lists exactly the five files Tasks 1-4 touch.

**Placeholders.** None. Every code step carries real code. The one open decision — Task 3, Step 2 — is a genuine fork with both branches spelled out and an explicit instruction not to leave it unresolved.

**Type consistency.** `resolveFilter(node, bbox, viewport, css?, paint?)` has one signature across Tasks 1-3. `FilterSpec.paint` is `{ fill: Rgb | null; stroke: Rgb | null }` wherever it appears, matching what Task 1's `'carries only the two colours onto the spec'` asserts and what `runFilter`'s seeding reads. `pseudoOk(v: string, paint: Paint | undefined): boolean` and `planeSurface(c: Rgb | null, w: number, h: number): Surface` are each named and typed identically in their definition, their call site, and their mutation rows. `Paint.fill`/`Paint.fillRef` are used at their real types (`Rgb | null` and `string | null`), and `INITIAL`, `makeSurface`, `srgbToLinear`, `runFilter`, `buildSvgPdf` and `decodePng` are all quoted at their existing signatures.

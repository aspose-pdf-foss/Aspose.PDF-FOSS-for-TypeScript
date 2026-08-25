# SVG gradient per-stop alpha (luminosity `/SMask`) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Render an SVG gradient whose stops carry *differing* `stop-opacity`
values exactly, through a luminosity soft mask, instead of painting it opaque and
naming it in `result.skipped`.

**Architecture:** `svggradient.ts` already builds the colour shading from a
normalized stop list. It gains a grayscale *twin* of that shading — same coords,
same stops, `/DeviceGray`, `opacity` instead of `color` — carried on
`GradientPaint` as `alphaPattern`. `svgdraw.ts` wraps that twin in a
transparency-group Form XObject (a rectangle over the shape's box, painted with
the grey shading) and references it from an `ExtGState` `/SMask /S /Luminosity`.
Because one soft mask covers a whole painting operation, `resolvePaint` learns to
return *passes*, so a masked fill and an unmasked stroke go out as two `q`/`Q`
blocks.

**Tech Stack:** TypeScript (ESM, NodeNext, `strict`), vitest. Zero runtime
dependencies — `node:` built-ins only.

**Spec:** `docs/superpowers/specs/2026-07-30-svg-gradient-alpha-design.md`.
**Issue:** `aspose-pdf-foss-for-ts-1gg0.17` (epic `1gg0`).

## Global Constraints

- **Zero runtime dependencies.** Only `node:` built-ins. Do not add npm runtime deps.
- **ESM + NodeNext.** Every relative import specifier carries the `.js` extension.
- **`svgdraw.ts` and `svggradient.ts` allocate nothing.** They import no
  `Document` and create no indirect objects. Anything that must be a *stream* is
  allocated by `svgembed.ts` through a sink interface.
- **TDD.** Write the failing test, watch it fail, then implement.
- **Both gates must be green before a task is done:** `npm run typecheck` and
  `npm test`.
- **Task tracking is `bd`, never TodoWrite or markdown TODO lists.**
- Commit after every task. Do not push until the end (Task 8).

## File Structure

| File | Change | Responsibility |
|---|---|---|
| `src/svggradient.ts` | modify | Add the grayscale alpha twin to the pure gradient→PDF mapping |
| `src/svgdraw.ts` | modify | Mask group construction, `/SMask` ExtGState, fill/stroke passes |
| `src/svgembed.ts` | modify | Rename `tileSink` → `streamSink` (the mask group is a stream too) |
| `test/svg-gradient.test.ts` | modify | Unit tests for the alpha function, twin pattern, degenerate alphas |
| `test/svg-draw.test.ts` | modify | Content-stream tests: `/SMask`, the group, the split, reporting |
| `test/svg-gradient-render.test.ts` | modify | End-to-end `ToImage` pixel checks against a backdrop |
| `README.md` | modify | Drop the "varying `stop-opacity` paints opaque" limitation |

No new files. Every change extends a module that already owns the concern.

---

### Task 1: Project a stop onto an arbitrary colour vector

`stopsFunction` hard-codes RGB and `patternOf` hard-codes `/DeviceRGB`. The alpha
twin needs the same code with one component instead of three. Pure refactor plus
one new capability; no caller behaviour changes yet.

**Files:**
- Modify: `src/svggradient.ts:127-165` (`rampFunction`, `stopsFunction`), `src/svggradient.ts:220-232` (`patternOf`)
- Test: `test/svg-gradient.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces:
  - `export type StopPick = (s: GradientStop) => number[];`
  - `export const ALPHA: StopPick` — projects a stop onto `[s.opacity]`.
  - `stopsFunction(stops: GradientStop[], pick?: StopPick): PdfDict` — `pick`
    defaults to RGB, so every existing call site is unchanged.
  - `patternOf(shadingEntries: [string, PdfObject][], matrix: Matrix, cs?: string): PdfDict`
    — `cs` defaults to `'DeviceRGB'`. Stays module-private.

- [ ] **Step 1: Write the failing tests**

Add to `test/svg-gradient.test.ts`, inside the existing `describe('stopsFunction', …)`
block (after the last `it`). Note the existing block already defines
`s(offset, color)` and `fn(list)` helpers; add an alpha-aware stop helper next to
them rather than reusing `s`:

```ts
  const sa = (offset: number, opacity: number): GradientStop =>
    ({ offset, color: [0, 0, 0], opacity });

  it('projects a stop onto its alpha when asked for the ALPHA ramp', () => {
    const f = stopsFunction(normalizeStops([sa(0, 0), sa(1, 1)]), ALPHA);
    expect(f.get('FunctionType')).toBe(2);
    expect(f.get('C0')).toEqual([0]);
    expect(f.get('C1')).toEqual([1]);
  });

  it('gives the alpha ramp the same /Bounds and /Encode as the colour ramp', () => {
    // A hard stop at 0.5, so the shared "drop the zero-width interval" rule is
    // the thing under test: the two functions must stitch identically or the
    // mask will not line up with the colour it masks.
    const list = [
      { offset: 0, color: [1, 0, 0] as [number, number, number], opacity: 1 },
      { offset: 0.5, color: [1, 0, 0] as [number, number, number], opacity: 1 },
      { offset: 0.5, color: [0, 0, 1] as [number, number, number], opacity: 0.25 },
      { offset: 1, color: [0, 0, 1] as [number, number, number], opacity: 0 },
    ];
    const colour = stopsFunction(normalizeStops(list));
    const alpha = stopsFunction(normalizeStops(list), ALPHA);
    expect(alpha.get('FunctionType')).toBe(colour.get('FunctionType'));
    expect(alpha.get('Bounds')).toEqual(colour.get('Bounds'));
    expect(alpha.get('Encode')).toEqual(colour.get('Encode'));
    const subs = alpha.get('Functions') as PdfDict[];
    expect(subs[0].get('C0')).toEqual([1]);
    expect(subs[subs.length - 1].get('C1')).toEqual([0]);
  });
```

Extend the import at the top of the file to pull in `ALPHA`:

```ts
import {
  resolveGradient, normalizeStops, stopsFunction, gradientPaint, spreadRange, tileStops,
  ALPHA, type GradientStop,
} from '../src/svggradient.js';
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/svg-gradient.test.ts`
Expected: FAIL — `ALPHA` is not exported (TypeScript/import error).

- [ ] **Step 3: Implement**

In `src/svggradient.ts`, replace `rampFunction` and the head of `stopsFunction`:

```ts
/** How a stop projects onto a shading function's output vector. The colour
 *  shading and its grayscale alpha twin differ ONLY in this. */
export type StopPick = (s: GradientStop) => number[];

const RGB: StopPick = (s) => [...s.color];

/** The alpha ramp's projection: one /DeviceGray component, since luminosity of
 *  a gray value g is g. */
export const ALPHA: StopPick = (s) => [s.opacity];

/** A type 2 exponential over [0, 1], linear (/N 1) between two colour vectors. */
function rampFunction(c0: number[], c1: number[]): PdfDict {
  return dict([
    ['FunctionType', 2],
    ['Domain', [0, 1]],
    ['C0', [...c0]],
    ['C1', [...c1]],
    ['N', 1],
  ]);
}
```

Then change `stopsFunction`'s signature and its one `rampFunction` call:

```ts
export function stopsFunction(stops: GradientStop[], pick: StopPick = RGB): PdfDict {
  const subs: PdfDict[] = [];
  const bounds: number[] = [];
  for (let i = 0; i + 1 < stops.length; i++) {
    if (!(stops[i + 1].offset > stops[i].offset)) continue;
    if (subs.length > 0) bounds.push(stops[i].offset);
    subs.push(rampFunction(pick(stops[i]), pick(stops[i + 1])));
  }
  // ... unchanged from here
```

And parameterize `patternOf`:

```ts
/** Assemble the pattern dict around a shading dict. */
function patternOf(
  shadingEntries: [string, PdfObject][], matrix: Matrix, cs = 'DeviceRGB',
): PdfDict {
  return dict([
    ['Type', name('Pattern')],
    ['PatternType', 2],
    ['Matrix', [...matrix]],
    ['Shading', dict([
      ['ColorSpace', name(cs)],
      ...shadingEntries,
      ['Extend', [true, true]],
    ])],
  ]);
}
```

- [ ] **Step 4: Run the gates**

Run: `npx vitest run test/svg-gradient.test.ts` → PASS (all, including the
pre-existing RGB tests, which prove the default `pick` is right).
Run: `npm run typecheck` → clean.

- [ ] **Step 5: Commit**

```bash
git add src/svggradient.ts test/svg-gradient.test.ts
git commit -m "refactor(svg): project a gradient stop onto an arbitrary colour vector (1gg0.17)"
```

---

### Task 2: Build the grayscale alpha twin

`gradientPaint` gains `alphaPattern` on its pattern result, and the three
degenerate solid outcomes stop pretending a varying ramp is fully opaque.

**Files:**
- Modify: `src/svggradient.ts:167-173` (`GradientPaint`), `src/svggradient.ts:239-333` (`gradientPaint`)
- Test: `test/svg-gradient.test.ts`

**Interfaces:**
- Consumes: `ALPHA`, `StopPick`, the `cs` parameter on `patternOf` (Task 1).
- Produces:
  ```ts
  export type GradientPaint =
    | { kind: 'pattern'; pattern: PdfDict; alphaPattern: PdfDict | null;
        opacity: number; report: boolean }
    | { kind: 'solid'; color: Rgb; opacity: number; report: boolean }
    | { kind: 'none'; report: boolean };
  ```
  `alphaPattern` is `null` exactly when every stop shares one alpha. When
  non-null it is a full PatternType 2 dict with `/ColorSpace /DeviceGray` and a
  `/Matrix` **excluding** the element CTM. `report` is now `false` for a varying
  ramp; only radial `reflect`/`repeat` still reports.

- [ ] **Step 1: Write the failing tests**

In `test/svg-gradient.test.ts`, **replace** the existing test
`'paints opaque and reports when stop-opacity varies'` (in the
`describe('gradientPaint — opacity', …)` block) with the following, and add the
rest after it:

```ts
  it('builds a grayscale alpha twin, unreported, when stop-opacity varies', () => {
    const p = paint('<svg><linearGradient id="g">' +
      '<stop offset="0" stop-color="red" stop-opacity="1"/>' +
      '<stop offset="1" stop-color="blue" stop-opacity="0.2"/></linearGradient></svg>', 'g');
    expect(p).toMatchObject({ kind: 'pattern', opacity: 1, report: false });
    if (p.kind !== 'pattern' || p.alphaPattern === null) throw new Error('expected an alpha twin');
    const sh = p.alphaPattern.get('Shading') as PdfDict;
    expect(sh.get('ColorSpace')).toMatchObject({ name: 'DeviceGray' });
    expect(sh.get('ShadingType')).toBe(2);
    expect(sh.get('Coords')).toEqual(shading(p).get('Coords'));
    const f = sh.get('Function') as PdfDict;
    expect(f.get('C0')).toEqual([1]);
    expect(f.get('C1')).toEqual([0.2]);
  });

  it('leaves the alpha twin null when every stop shares one alpha', () => {
    const p = paint('<svg><linearGradient id="g">' +
      '<stop offset="0" stop-color="red" stop-opacity="0.4"/>' +
      '<stop offset="1" stop-color="blue" stop-opacity="0.4"/></linearGradient></svg>', 'g');
    expect(p).toMatchObject({ kind: 'pattern', alphaPattern: null });
  });

  it('omits the element CTM from the alpha twin /Matrix but keeps it on the colour', () => {
    // The mask group's space IS element user space, so the CTM must cancel.
    const ctm: Matrix = [2, 0, 0, 3, 7, 11];
    const p = paint('<svg><linearGradient id="g">' +
      '<stop offset="0" stop-color="red" stop-opacity="0"/>' +
      '<stop offset="1" stop-color="blue" stop-opacity="1"/></linearGradient></svg>',
      'g', { x: 5, y: 6, w: 10, h: 20 }, ctm);
    if (p.kind !== 'pattern' || p.alphaPattern === null) throw new Error('expected an alpha twin');
    expect(p.alphaPattern.get('Matrix')).toEqual([10, 0, 0, 20, 5, 6]);
    expect(p.pattern.get('Matrix')).toEqual([20, 0, 0, 60, 17, 29]);
  });

  it('builds an alpha twin for a radial gradient too', () => {
    const p = paint('<svg><radialGradient id="g">' +
      '<stop offset="0" stop-color="red" stop-opacity="0"/>' +
      '<stop offset="1" stop-color="blue" stop-opacity="1"/></radialGradient></svg>', 'g');
    if (p.kind !== 'pattern' || p.alphaPattern === null) throw new Error('expected an alpha twin');
    const sh = p.alphaPattern.get('Shading') as PdfDict;
    expect(sh.get('ShadingType')).toBe(3);
    expect(sh.get('Coords')).toEqual(shading(p).get('Coords'));
  });

  it('tiles the alpha ramp with the colour ramp under a repeat spread', () => {
    const p = paint('<svg><linearGradient id="g" gradientUnits="userSpaceOnUse" ' +
      'spreadMethod="repeat" x1="0" y1="0" x2="10" y2="0">' +
      '<stop offset="0" stop-color="red" stop-opacity="0"/>' +
      '<stop offset="1" stop-color="blue" stop-opacity="1"/></linearGradient></svg>',
      'g', { x: 0, y: 0, w: 30, h: 10 });
    if (p.kind !== 'pattern' || p.alphaPattern === null) throw new Error('expected an alpha twin');
    const a = (p.alphaPattern.get('Shading') as PdfDict).get('Function') as PdfDict;
    const c = (shading(p).get('Function')) as PdfDict;
    expect(a.get('Bounds')).toEqual(c.get('Bounds'));
    expect((a.get('Functions') as PdfDict[]).length)
      .toBe((c.get('Functions') as PdfDict[]).length);
  });
```

Then, in the `describe('gradientPaint — degenerate cases …')` block, add:

```ts
  it('takes the LAST stop alpha when a linear axis has zero length', () => {
    const p = paint('<svg><linearGradient id="g" x1="0.4" y1="0.4" x2="0.4" y2="0.4">' +
      '<stop offset="0" stop-color="red" stop-opacity="1"/>' +
      '<stop offset="1" stop-color="blue" stop-opacity="0.25"/></linearGradient></svg>', 'g');
    expect(p).toMatchObject({ kind: 'solid', color: [0, 0, 1], opacity: 0.25, report: false });
  });

  it('takes the LAST stop alpha when a radial radius is zero', () => {
    const p = paint('<svg><radialGradient id="g" r="0">' +
      '<stop offset="0" stop-color="red" stop-opacity="1"/>' +
      '<stop offset="1" stop-color="blue" stop-opacity="0.25"/></radialGradient></svg>', 'g');
    expect(p).toMatchObject({ kind: 'solid', color: [0, 0, 1], opacity: 0.25, report: false });
  });
```

These reuse the file's existing `paint` and `shading` helpers unchanged — `paint`
is already `(svg, id, box = BOX, ctm = [...IDENTITY])` feeding
`gradientPaint(node, map, box, VP, ctm)`, so no helper edits are needed.

The expected matrices in the third test follow from `mul(m, n)` being "m then n"
(row vectors, leftmost applied first): the alpha matrix is
`mul(IDENTITY, [10, 0, 0, 20, 5, 6])`, and the colour matrix composes that with
`ctm = [2, 0, 0, 3, 7, 11]` to give `[20, 0, 0, 60, 17, 29]`.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/svg-gradient.test.ts`
Expected: FAIL — `alphaPattern` does not exist on the pattern result, and the
degenerate cases still report `opacity: 1`.

- [ ] **Step 3: Implement**

In `src/svggradient.ts`, widen the type:

```ts
/** What a gradient reference resolves to for one shape.
 *  `report` true asks the caller to add the gradient element's name to its
 *  skipped list — a fidelity loss, never an SVG-mandated degeneracy.
 *
 *  `alphaPattern` is the grayscale twin of `pattern`, non-null exactly when the
 *  stops carry DIFFERING alphas: a uniform one folds into /ca + /CA instead. It
 *  is what the caller paints into a luminosity /SMask group. Its /Matrix omits
 *  the element CTM, because that group's space is element user space. */
export type GradientPaint =
  | { kind: 'pattern'; pattern: PdfDict; alphaPattern: PdfDict | null;
      opacity: number; report: boolean }
  | { kind: 'solid'; color: Rgb; opacity: number; report: boolean }
  | { kind: 'none'; report: boolean };
```

Then rework `gradientPaint`'s body. Replace from the `const alpha = …` line down
to the end of the function:

```ts
  const alpha = uniformOpacity(g.stops);
  const opacity = alpha ?? 1;
  const last = g.stops[g.stops.length - 1];

  // Every solid outcome below is exact, INCLUDING its alpha: it paints one
  // stop's colour, so it takes that stop's own opacity. Using `opacity` here
  // would silently paint a varying ramp's degenerate case fully opaque.
  if (g.stops.length === 1)
    return { kind: 'solid', color: g.stops[0].color, opacity: g.stops[0].opacity, report: false };

  const obb = (g.attrs.get('gradientUnits') ?? 'objectBoundingBox') !== 'userSpaceOnUse';
  if (obb && (!bbox || !(bbox.w > 0) || !(bbox.h > 0)))
    return { kind: 'none', report: false };

  const gt = parseTransform(g.attrs.get('gradientTransform'));
  const matrix = patternMatrix(gt, obb, bbox, ctm);
  // The mask group has an identity /Matrix and is rendered under the CTM that
  // was in force when its `gs` ran — the element CTM. So its pattern space is
  // element user space and the CTM factor must NOT appear here. Same
  // cancellation spreadRange relies on.
  const alphaMatrix = patternMatrix(gt, obb, bbox, [...IDENTITY]);
  const stops = normalizeStops(g.stops);

  /** The colour pattern plus, when the ramp varies, its grayscale twin. */
  const pair = (entries: [string, PdfObject][], fnStops: GradientStop[]) => ({
    pattern: patternOf([...entries, ['Function', stopsFunction(fnStops)]], matrix),
    alphaPattern: alpha !== null ? null
      : patternOf([...entries, ['Function', stopsFunction(fnStops, ALPHA)]],
                  alphaMatrix, 'DeviceGray'),
  });

  if (g.kind === 'radial') {
    const cx = coord(g.attrs.get('cx'), obb ? 0.5 : 0.5 * viewport.w, obb, 'x', viewport);
    const cy = coord(g.attrs.get('cy'), obb ? 0.5 : 0.5 * viewport.h, obb, 'y', viewport);
    const r = coord(g.attrs.get('r'), obb ? 0.5 : 0.5 * diagonal(viewport), obb, 'd', viewport);
    if (!(r > 0)) return { kind: 'solid', color: last.color, opacity: last.opacity, report: false };
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
    return {
      kind: 'pattern',
      ...pair([['ShadingType', 3], ['Coords', [fx, fy, 0, cx, cy, r]]], stops),
      opacity,
      report: spread === 'reflect' || spread === 'repeat',
    };
  }

  const x1 = coord(g.attrs.get('x1'), 0, obb, 'x', viewport);
  const y1 = coord(g.attrs.get('y1'), 0, obb, 'y', viewport);
  const x2 = coord(g.attrs.get('x2'), obb ? 1 : viewport.w, obb, 'x', viewport);
  const y2 = coord(g.attrs.get('y2'), 0, obb, 'y', viewport);
  if (x1 === x2 && y1 === y2)
    return { kind: 'solid', color: last.color, opacity: last.opacity, report: false };

  let coords = [x1, y1, x2, y2];
  let fnStops = stops;
  const spread = g.attrs.get('spreadMethod');
  if (spread === 'reflect' || spread === 'repeat') {
    // The pattern matrix WITHOUT the element CTM: the box is in element space,
    // so the CTM cancels out of the projection.
    const range = spreadRange([x1, y1], [x2, y2],
      mul(gt, bboxMatrix(obb, bbox)), bbox);
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
    ...pair([['ShadingType', 2], ['Coords', coords]], fnStops),
    opacity,
    report: false,
  };
}
```

Delete the now-unused `lastColor` and `report` locals from the top of the
function. Keep the `uniformOpacity` doc comment accurate by updating its second
sentence:

```ts
/** Every stop carrying the same alpha, else null. Uniform alpha folds exactly
 *  into /ca + /CA; a varying one becomes the grayscale twin in `alphaPattern`. */
```

- [ ] **Step 4: Run the gates**

Run: `npx vitest run test/svg-gradient.test.ts` → PASS.
Run: `npm run typecheck` → clean.

Run: `npm test` → `test/svg-draw.test.ts` is now expected to FAIL on
`'reports a varying stop-opacity and paints opaque'`, because `report` is gone.
Leave it failing; Task 5 replaces that test. Note the failure in the commit
message so a bisect reads cleanly.

- [ ] **Step 5: Commit**

```bash
git add src/svggradient.ts test/svg-gradient.test.ts
git commit -m "feat(svg): build a grayscale alpha twin for a varying stop-opacity (1gg0.17)

The svgdraw.ts test for the old opaque-and-report behaviour fails until the
mask group lands in a later commit."
```

---

### Task 3: Generalize the tile sink into a stream sink

The mask group is a Form XObject stream and `svgdraw.ts` allocates nothing, so it
needs the same sink `<pattern>` already uses. Nothing about that interface was
tile-specific. Pure rename, no behaviour change.

**Files:**
- Modify: `src/svgdraw.ts:31-37` (the interface), `:163`, `:230`, `:359`, `:659`, `:681`, and `drawSvg`/`__ctmProbe` bodies
- Modify: `src/svgembed.ts:11`, `:101-110`, `:113`, `:154`
- Test: `test/svg-draw.test.ts:8-12` (the `noTiles` fake)

**Interfaces:**
- Consumes: nothing.
- Produces: `export interface SvgStreamSink { stream(dict: PdfDict, content: string): PdfObject; }`
  replacing `SvgTileSink`. `Emitter.streams` replaces `Emitter.tiles`.
  `drawSvg(root, viewport, provider, streams, images)` and
  `__ctmProbe(root, viewport, provider, streams, images)` keep their positional
  order. Neither name is exported from `src/index.ts`, so this is internal only.

- [ ] **Step 1: Update the test fake first (it is the failing test)**

In `test/svg-draw.test.ts`, replace the `noTiles` helper and both call sites:

```ts
/** A sink that hands back a distinct reference per stream, so patKey and the
 *  mask-group cache can tell them apart without a Document. */
const noStreams = () => {
  let n = 0;
  return { stream: () => ref(++n) };
};
```

Then replace every `noTiles()` with `noStreams()` (there are two: the `draw`
helper near line 20 and the `__ctmProbe` call near line 284, plus one inline
object literal in the `'drawSvg — pattern overflow'` block near line 656 — that
one is written as `{ tile: … }` and becomes `{ stream: … }`).

Find them all with: `grep -n "noTiles\|tile:" test/svg-draw.test.ts`

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/svg-draw.test.ts`
Expected: FAIL — the sink object no longer has a `tile` method
(`e.tiles.tile is not a function`), or a TypeScript error on the argument type.

- [ ] **Step 3: Implement the rename**

In `src/svgdraw.ts`:

```ts
/** Allocates a content stream and returns its reference. svgembed.ts implements
 *  it, because a stream MUST be an indirect object — which this module,
 *  allocating nothing, cannot produce. Used for a PatternType 1 tile and for a
 *  luminosity mask group; mirrors SvgImageSink, for the same reason. */
export interface SvgStreamSink {
  stream(dict: PdfDict, content: string): PdfObject;
}
```

- `Emitter`: `tiles!: SvgTileSink;` → `streams!: SvgStreamSink;`, with the
  comment "Supplied by svgembed.ts: only it may allocate a stream."
- `child()`: `c.tiles = this.tiles;` → `c.streams = this.streams;`
- `tilingFor`'s last line: `return e.tiles.tile(dict, …)` → `return e.streams.stream(dict, …)`
- `drawSvg` and `__ctmProbe`: parameter `tiles: SvgTileSink` → `streams: SvgStreamSink`,
  and `e.tiles = tiles;` → `e.streams = streams;`
- Fix the `SvgImageSink` doc comment's "Mirrors SvgTileSink" → "Mirrors SvgStreamSink".

In `src/svgembed.ts`:

```ts
import { drawSvg, type SvgImageSink, type SvgStreamSink } from './svgdraw.js';
```

```ts
/** The sink svgdraw.ts uses to turn a built content stream into a PDF object.
 *  This module is the only one that may allocate, which is why the walker takes
 *  a sink rather than building the stream itself: a PatternType 1 pattern and a
 *  luminosity mask group are both streams, and streams must be indirect. */
function streamSink(doc: Document): SvgStreamSink {
  return {
    stream: (dict, content) =>
      doc.allocObject({ kind: 'stream', dict, raw: enc(content) }),
  };
}
```

- `imageSink`'s comment "mirrors tileSink" → "mirrors streamSink".
- The `drawSvg(root, vb, provider, tileSink(doc), imageSink(doc))` call →
  `drawSvg(root, vb, provider, streamSink(doc), imageSink(doc))`.

- [ ] **Step 4: Run the gates**

Run: `npm run typecheck` → clean (this is the real check for a rename).
Run: `npm test` → everything passes except the one known Task 2 failure,
`'reports a varying stop-opacity and paints opaque'`.

- [ ] **Step 5: Commit**

```bash
git add src/svgdraw.ts src/svgembed.ts test/svg-draw.test.ts
git commit -m "refactor(svg): generalize SvgTileSink into SvgStreamSink (1gg0.17)"
```

---

### Task 4: Turn `resolvePaint` into passes

A soft mask covers a whole painting operation, so a masked fill and an unmasked
stroke cannot share one `q`/`Q`. Restructure first, with no mask yet, so the
refactor's "output is unchanged" property is provable on its own.

**Files:**
- Modify: `src/svgdraw.ts:300-306` (`PaintOps`), `:240-244` (`Emitter.setPaint`), `:399-431` (`resolvePaint`), `:433-454` (`paintShape`)
- Test: `test/svg-draw.test.ts`

**Interfaces:**
- Consumes: `SvgStreamSink` (Task 3).
- Produces:
  ```ts
  export interface PaintPass { fill: boolean; stroke: boolean; ops: string[]; }
  export interface PaintOps { fill: boolean; stroke: boolean; passes: PaintPass[]; }
  export function resolvePaint(
    e: Emitter, p: Paint, bbox: SegBBox | null, ctm: Matrix, canSplit?: boolean,
  ): PaintOps;
  ```
  `canSplit` defaults to `false`. `passes` is empty when nothing paints, and has
  exactly one entry for every input this task handles. `Emitter.setPaint` keeps
  its `{ fill, stroke }` return.

- [ ] **Step 1: Write the failing test**

Add to `test/svg-draw.test.ts` in the `describe('drawSvg — paint', …)` block:

```ts
  it('paints a filled AND stroked shape in one pass with a single B', () => {
    const c = body('<svg><rect width="10" height="10" fill="red" stroke="blue"/></svg>');
    expect(c.match(/\bB\b/g)).toHaveLength(1);
    expect(c).not.toMatch(/\bf\b/);
    expect(c).not.toMatch(/\bS\b/);
    expect(c.match(/\bq\b/g)).toHaveLength(1);
  });
```

- [ ] **Step 2: Run it**

Run: `npx vitest run test/svg-draw.test.ts -t 'one pass with a single B'`
Expected: PASS already — this is a *characterization* test. Its job is to fail if
the Task 4 refactor changes existing output, so it must be committed before the
refactor. Confirm it passes now, then continue.

- [ ] **Step 3: Implement the pass structure**

In `src/svgdraw.ts`, replace the `PaintOps` interface:

```ts
/** One painting operation: the operators that set it up, and which of fill and
 *  stroke it performs. Normally there is exactly one. A luminosity /SMask
 *  applies to a whole painting operation, so a masked fill beside an unmasked
 *  stroke needs two. */
export interface PaintPass {
  fill: boolean;
  stroke: boolean;
  /** Colour, pattern, alpha and stroke-parameter operators, in order. */
  ops: string[];
}

/** The paint decision for one element: whether each of fill and stroke happens
 *  at all, and the passes that perform them. */
export interface PaintOps {
  fill: boolean;
  stroke: boolean;
  passes: PaintPass[];
}
```

Rewrite the tail of `resolvePaint` (keep the signature's new `canSplit`
parameter, unused for now — mark it so with a leading underscore is NOT needed;
Task 5 uses it, and `strict` does not complain about an unused parameter):

```ts
export function resolvePaint(
  e: Emitter, p: Paint, bbox: SegBBox | null, ctm: Matrix, canSplit = false,
): PaintOps {
  const fg = p.fillRef !== null ? paintServer(e, p.fillRef, bbox, ctm) : null;
  const sg = p.strokeRef !== null ? paintServer(e, p.strokeRef, bbox, ctm) : null;

  const doFill = fg ? fg.kind !== 'none' : p.fill !== null;
  const doStroke = (sg ? sg.kind !== 'none' : p.stroke !== null) && p.strokeWidth > 0;
  if (!doFill && !doStroke) return { fill: false, stroke: false, passes: [] };

  // A uniform stop-opacity multiplies into the alpha the element already had.
  const gAlpha = (g: ServerPaint | null): number => (g && g.kind !== 'none' ? g.opacity : 1);
  const ca = doFill ? p.fillOpacity * gAlpha(fg) : 1;
  const CA = doStroke ? p.strokeOpacity * gAlpha(sg) : 1;

  const fillPaint: string[] = [];
  if (doFill) {
    if (fg && fg.kind === 'pattern') fillPaint.push('/Pattern cs', `/${fg.key} scn`);
    else if (fg && fg.kind === 'solid') fillPaint.push(`${fg.color.map(num).join(' ')} rg`);
    else fillPaint.push(`${p.fill!.map(num).join(' ')} rg`);
  }
  const strokePaint: string[] = [];
  if (doStroke) {
    if (sg && sg.kind === 'pattern') strokePaint.push('/Pattern CS', `/${sg.key} SCN`);
    else if (sg && sg.kind === 'solid') strokePaint.push(`${sg.color.map(num).join(' ')} RG`);
    else strokePaint.push(`${p.stroke!.map(num).join(' ')} RG`);
    strokePaint.push(`${num(p.strokeWidth)} w`);
    if (p.lineCap !== 0) strokePaint.push(`${p.lineCap} J`);
    if (p.lineJoin !== 0) strokePaint.push(`${p.lineJoin} j`);
    if (p.miterLimit !== 4) strokePaint.push(`${num(p.miterLimit)} M`);
    if (p.dash.length > 0) strokePaint.push(`[${p.dash.map(num).join(' ')}] ${num(p.dashOffset)} d`);
  }

  const gs = ca < 1 || CA < 1 ? [`/${e.gsKey(ca, CA)} gs`] : [];
  return {
    fill: doFill,
    stroke: doStroke,
    passes: [{ fill: doFill, stroke: doStroke, ops: [...gs, ...fillPaint, ...strokePaint] }],
  };
}
```

Update `Emitter.setPaint`:

```ts
  setPaint(p: Paint, bbox: SegBBox | null, ctm: Matrix): { fill: boolean; stroke: boolean } {
    // canSplit stays false: emitGlyphs would have to show every run twice to
    // paint fill and stroke separately.
    const r = resolvePaint(this, p, bbox, ctm);
    const pass = r.passes[0];
    if (pass) for (const op of pass.ops) this.out.push(op);
    return { fill: r.fill, stroke: r.stroke };
  }
```

Update `paintShape`:

```ts
/** Paint a shape's segments with `p`, emitting only the operators it needs.
 *  One q/Q per pass: a luminosity /SMask covers a whole painting operation, so
 *  a masked fill and an unmasked stroke must not share one. `B` is defined as
 *  `f` then `S`, so splitting is visually identical. */
function paintShape(e: Emitter, segs: SvgSeg[], p: Paint, ctm: Matrix): void {
  if (segs.length === 0) return;

  // The bbox is only ever needed by a gradient, so it is computed lazily even
  // though objectBoundingBox — the default — makes that the common path.
  let box: SegBBox | null | undefined;
  const bbox = (): SegBBox | null => (box === undefined ? (box = segsBBox(segs)) : box);

  const { fill: doFill, stroke: doStroke, passes } =
    resolvePaint(e, p, p.fillRef !== null || p.strokeRef !== null ? bbox() : null, ctm, true);
  if (!doFill && !doStroke) return;
  if (e.ctms) e.ctms.push(ctm);
  e.addInk(bbox(), ctm);

  const eo = p.fillRule === 'evenodd' ? '*' : '';
  for (const pass of passes) {
    e.out.push('q');
    for (const op of pass.ops) e.out.push(op);
    emitSegs(segs, e.out);
    e.out.push(pass.fill && pass.stroke ? `B${eo}` : pass.fill ? `f${eo}` : 'S');
    e.out.push('Q');
  }
}
```

- [ ] **Step 4: Run the gates**

Run: `npm test` → everything passes except the one known Task 2 failure. In
particular the whole `svg-golden` and `svg-input-fixtures` suites must stay green:
they compare full content streams and are the real proof this refactor changed no
output.
Run: `npm run typecheck` → clean.

- [ ] **Step 5: Commit**

```bash
git add src/svgdraw.ts test/svg-draw.test.ts
git commit -m "refactor(svg): resolvePaint returns painting passes (1gg0.17)"
```

---

### Task 5: The luminosity mask group

**Files:**
- Modify: `src/svgdraw.ts` — `Emitter` (mask cache, `gsKey`), `ServerPaint`, `paintServer`, `resolvePaint`; add `maskGroup`
- Test: `test/svg-draw.test.ts`

**Interfaces:**
- Consumes: `alphaPattern` on `GradientPaint` (Task 2), `SvgStreamSink` (Task 3),
  `PaintPass`/`canSplit` (Task 4).
- Produces: no new exports. `Emitter.gsKey(ca, CA, smask?)` now takes an optional
  soft-mask group reference. `ServerPaint`'s pattern variant carries
  `alphaPattern: PdfDict | null` and `elem: string`.

- [ ] **Step 1: Write the failing tests**

In `test/svg-draw.test.ts`, **replace** the test
`'reports a varying stop-opacity and paints opaque'` in the
`describe('drawSvg — gradients', …)` block with a new block appended after that
describe:

```ts
describe('drawSvg — varying stop-opacity', () => {
  const FADE = '<linearGradient id="g">' +
    '<stop offset="0" stop-color="red" stop-opacity="0"/>' +
    '<stop offset="1" stop-color="blue" stop-opacity="1"/></linearGradient>';
  const gstates = (svg: string): PdfDict =>
    (draw(svg).resources.get('ExtGState') as PdfDict | undefined) ?? new Map();

  it('no longer reports a varying stop-opacity', () => {
    expect(draw(`<svg><defs>${FADE}</defs>` +
      '<rect width="10" height="10" fill="url(#g)"/></svg>').skipped).toEqual([]);
  });

  it('references a luminosity soft mask from the ExtGState', () => {
    const svg = `<svg><defs>${FADE}</defs>` +
      '<rect width="10" height="10" fill="url(#g)"/></svg>';
    expect(body(svg)).toMatch(/\/GS\d+ gs/);
    const gs = [...gstates(svg).values()][0] as PdfDict;
    const sm = gs.get('SMask') as PdfDict;
    expect(isDict(sm)).toBe(true);
    expect(sm.get('S')).toMatchObject({ name: 'Luminosity' });
    expect(sm.get('G')).toMatchObject({ kind: 'ref' });
    expect(gs.get('ca')).toBe(1);
  });

  it('keeps the element fill-opacity in /ca beside the mask', () => {
    const gs = [...gstates(`<svg><defs>${FADE}</defs>` +
      '<rect width="10" height="10" fill="url(#g)" fill-opacity="0.5"/></svg>')
      .values()][0] as PdfDict;
    expect(gs.get('ca')).toBe(0.5);
    expect(isDict(gs.get('SMask'))).toBe(true);
  });

  it('emits no soft mask for a uniform stop-opacity', () => {
    const gs = [...gstates('<svg><defs><linearGradient id="g">' +
      '<stop offset="0" stop-color="red" stop-opacity="0.5"/>' +
      '<stop offset="1" stop-color="blue" stop-opacity="0.5"/></linearGradient></defs>' +
      '<rect width="10" height="10" fill="url(#g)"/></svg>').values()][0] as PdfDict;
    expect(gs.get('SMask')).toBeUndefined();
  });

  it('splits a masked fill and a solid stroke into two passes', () => {
    const c = body(`<svg><defs>${FADE}</defs>` +
      '<rect width="10" height="10" fill="url(#g)" stroke="lime"/></svg>');
    expect(c).not.toMatch(/\bB\b/);
    expect(c.match(/\bf\b/g)).toHaveLength(1);
    expect(c.match(/\bS\b/g)).toHaveLength(1);
    expect(c.match(/\bq\b/g)).toHaveLength(2);
    // The mask is on the fill pass only: the stroke's own gs must not carry one.
    const [fillHalf, strokeHalf] = c.split(/\bf\b/);
    expect(fillHalf).toMatch(/\/GS\d+ gs/);
    expect(strokeHalf).toContain('0 1 0 RG');
  });

  it('paints one pass when fill and stroke share the same varying gradient', () => {
    const c = body(`<svg><defs>${FADE}</defs>` +
      '<rect width="10" height="10" fill="url(#g)" stroke="url(#g)"/></svg>');
    expect(c.match(/\bB\b/g)).toHaveLength(1);
  });

  it('reports the gradient when a text run cannot split fill from stroke', () => {
    const r = draw(`<svg viewBox="0 0 100 100"><defs>${FADE}</defs>` +
      '<text x="10" y="20" fill="url(#g)" stroke="lime">hi</text></svg>');
    expect(r.skipped).toEqual(['linearGradient']);
    expect(r.content).not.toContain('/SMask');
  });

  it('masks a text run whose fill alone carries the ramp', () => {
    const r = draw(`<svg viewBox="0 0 100 100"><defs>${FADE}</defs>` +
      '<text x="10" y="20" fill="url(#g)">hi</text></svg>');
    expect(r.skipped).toEqual([]);
    const gs = [...((r.resources.get('ExtGState') as PdfDict).values())][0] as PdfDict;
    expect(isDict(gs.get('SMask'))).toBe(true);
  });
});
```

The mask group's *own* dict is allocated through the sink, so the fake in
`svg-draw.test.ts` cannot inspect it. Cover it in `test/svg-embed.test.ts`,
following that file's existing idiom — reach the object through the form's
`/Resources`, exactly as the tile test at `test/svg-embed.test.ts:318` does.
`page()`, `svg()`, `theForm()`, `dec()` and `RECT` are already defined at the top
of that file; add this as a new `describe` block at the end:

```ts
describe('AddSVGObject — gradient alpha mask', () => {
  const FADE = '<svg viewBox="0 0 10 10"><defs><linearGradient id="g">' +
    '<stop offset="0" stop-color="red" stop-opacity="0"/>' +
    '<stop offset="1" stop-color="red" stop-opacity="1"/></linearGradient></defs>' +
    '<rect width="10" height="10" fill="url(#g)"/></svg>';

  it('allocates the mask group as an indirect DeviceGray transparency group', () => {
    const p = page();
    expect(p.AddSVGObject(svg(FADE), RECT).skipped).toEqual([]);
    const res = theForm(p.Document, p).dict.get('Resources') as PdfDict;
    const gss = res.get('ExtGState') as PdfDict;
    const gs = [...gss.values()][0] as PdfDict;
    const sm = gs.get('SMask') as PdfDict;
    expect(sm.get('S')).toMatchObject({ name: 'Luminosity' });

    const entry = sm.get('G');
    expect(isRef(entry)).toBe(true);
    const group = p.Document.resolve(entry);
    expect(isStream(group)).toBe(true);
    const gd = (group as PdfStream).dict;
    const grp = gd.get('Group') as PdfDict;
    expect(isDict(grp)).toBe(true);
    expect(grp.get('S')).toMatchObject({ name: 'Transparency' });
    expect(grp.get('CS')).toMatchObject({ name: 'DeviceGray' });
    expect(gd.get('Matrix')).toEqual([1, 0, 0, 1, 0, 0]);

    // The group paints one rect with the grayscale twin of the shading.
    expect(dec((group as PdfStream).raw)).toContain('/Pattern cs');
    expect(dec((group as PdfStream).raw)).toMatch(/re\nf$/);
    const gres = gd.get('Resources') as PdfDict;
    const gpat = (gres.get('Pattern') as PdfDict).get('P0') as PdfDict;
    expect(((gpat.get('Shading')) as PdfDict).get('ColorSpace'))
      .toMatchObject({ name: 'DeviceGray' });
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/svg-draw.test.ts test/svg-embed.test.ts`
Expected: FAIL — no `/SMask` anywhere, and the fill+stroke case still emits one `B`.

- [ ] **Step 3: Implement**

In `src/svgdraw.ts`, add the mask-group cache to `Emitter` (next to `images`,
which it mirrors):

```ts
  /** canonical (alpha pattern + box) -> the mask group's ref, walk-wide so two
   *  shapes sharing one ramp allocate one group. Shared with every child:
   *  /Resources are per-stream but refs are document-wide. Mirrors `images`. */
  masks = new Map<string, PdfObject>();
```

and share it in `child()`: `c.masks = this.masks;`

Replace `gsKey`, adding a canonical dedupe map beside `patKeys`:

```ts
  /** canonical ExtGState text -> resource key. A (ca, CA) pair no longer
   *  identifies a state on its own, now that one may carry a soft mask. */
  private readonly gsKeys = new Map<string, string>();

  /** Reuse one /ExtGState per (ca, CA, soft mask); returns its resource key. */
  gsKey(ca: number, CA: number, smask?: PdfObject): string {
    const d: PdfDict = new Map<string, PdfObject>([
      ['Type', name('ExtGState')], ['ca', ca], ['CA', CA],
    ]);
    if (smask !== undefined)
      d.set('SMask', new Map<string, PdfObject>([
        ['S', name('Luminosity')], ['G', smask],
      ]));
    const k = __canon(d);
    const hit = this.gsKeys.get(k);
    if (hit !== undefined) return hit;
    const key = `GS${this.extg.size}`;
    this.extg.set(key, d);
    this.gsKeys.set(k, key);
    return key;
  }
```

Add `maskGroup` just above `resolvePaint`:

```ts
/** The luminosity mask group for one alpha ramp: a transparency-group Form
 *  XObject painting `box` with the ramp's grayscale twin.
 *
 *  Its /Matrix is identity, so its content space is ELEMENT USER SPACE — the
 *  group is rendered under the CTM that was current when its `gs` ran, and
 *  `walk` emits the element's `cm` before the paint. That is exactly why
 *  `alphaPattern` carries no CTM factor.
 *
 *  A rectangle, not the shape's own geometry: the mask is never sampled outside
 *  the ink, so over-covering is free and the group needs no stroke parameters,
 *  no fill rule, and no fonts. For the same reason /BBox may be generous. */
function maskGroup(e: Emitter, alphaPattern: PdfDict, box: SegBBox): PdfObject {
  const dict: PdfDict = new Map<string, PdfObject>([
    ['Type', name('XObject')],
    ['Subtype', name('Form')],
    ['FormType', 1],
    ['BBox', [box.x, box.y, box.x + box.w, box.y + box.h]],
    ['Matrix', [...IDENTITY]],
    ['Group', new Map<string, PdfObject>([
      ['Type', name('Group')],
      ['S', name('Transparency')],
      ['CS', name('DeviceGray')],
    ])],
    ['Resources', new Map<string, PdfObject>([
      ['Pattern', new Map<string, PdfObject>([['P0', alphaPattern]])],
    ])],
  ]);
  const key = __canon(dict);
  const hit = e.masks.get(key);
  if (hit !== undefined) return hit;
  const content = [
    '/Pattern cs', '/P0 scn',
    `${num(box.x)} ${num(box.y)} ${num(box.w)} ${num(box.h)} re`, 'f',
  ].join('\n');
  const r = e.streams.stream(dict, content);
  e.masks.set(key, r);
  return r;
}
```

Widen `ServerPaint` and `paintServer`:

```ts
type ServerPaint =
  | { kind: 'none' }
  | { kind: 'solid'; color: Rgb; opacity: number }
  | { kind: 'pattern'; key: string; opacity: number;
      /** The grayscale alpha ramp, when the gradient's stop alphas differ. */
      alphaPattern: PdfDict | null;
      /** The element name to report if the ramp has to be dropped. */
      elem: string };
```

```ts
function paintServer(
  e: Emitter, id: string | null, bbox: SegBBox | null, ctm: Matrix,
): ServerPaint | null {
  if (id === null) return null;
  const node = e.ids.get(id);
  if (!node) return null;
  if (node.name === 'pattern') {
    const t = tilingFor(e, node, bbox, ctm);
    return t === null ? { kind: 'none' }
      : { kind: 'pattern', key: e.patKey(t), opacity: 1, alphaPattern: null, elem: 'pattern' };
  }
  const g = gradientFor(e, id, bbox, ctm);
  if (!g) return null;
  if (g.kind === 'pattern')
    return {
      kind: 'pattern', key: e.patKey(g.pattern), opacity: g.opacity,
      alphaPattern: g.alphaPattern, elem: node.name,
    };
  if (g.kind === 'solid')
    return { kind: 'solid', color: g.color, opacity: g.opacity };
  return { kind: 'none' };
}
```

Finally, replace the tail of `resolvePaint` — everything from the `const gs = …`
line — with the mask logic:

```ts
  const ramp = (g: ServerPaint | null): PdfDict | null =>
    (g !== null && g.kind === 'pattern' ? g.alphaPattern : null);
  const fillRamp = doFill ? ramp(fg) : null;
  const strokeRamp = doStroke ? ramp(sg) : null;
  // Two calls to gradientPaint build two distinct dicts for one gradient, so
  // sameness is structural, not identity.
  const same = fillRamp === strokeRamp
    || (fillRamp !== null && strokeRamp !== null && __canon(fillRamp) === __canon(strokeRamp));

  // A stroke reaches strokeWidth * miterLimit / 2 past the path at a miter tip;
  // inflating the mask box by that is an exact upper bound, and costs nothing.
  const grow = (p.strokeWidth * Math.max(1, p.miterLimit)) / 2;
  const gsOps = (a: number, A: number, r: PdfDict | null, by: number): string[] => {
    const sm = r !== null && bbox !== null
      ? maskGroup(e, r, { x: bbox.x - by, y: bbox.y - by, w: bbox.w + 2 * by, h: bbox.h + 2 * by })
      : undefined;
    if (a >= 1 && A >= 1 && sm === undefined) return [];
    return [`/${e.gsKey(a, A, sm)} gs`];
  };

  // One soft mask covers a whole painting operation, so a masked fill beside a
  // differently-masked (or unmasked) stroke needs two passes.
  if (canSplit && doFill && doStroke && !same)
    return {
      fill: true,
      stroke: true,
      passes: [
        { fill: true, stroke: false, ops: [...gsOps(ca, 1, fillRamp, 0), ...fillPaint] },
        { fill: false, stroke: true, ops: [...gsOps(1, CA, strokeRamp, grow), ...strokePaint] },
      ],
    };

  // Un-splittable — a text run, where splitting would show every glyph twice.
  // Applying either ramp would wrongly mask the other paint, so drop both and
  // report, exactly as every varying ramp did before the mask existed.
  let mask = fillRamp ?? strokeRamp;
  if (doFill && doStroke && !same) {
    mask = null;
    const src = fillRamp !== null ? fg : sg;
    if (src !== null && src.kind === 'pattern') e.skipped.add(src.elem);
  }
  return {
    fill: doFill,
    stroke: doStroke,
    passes: [{
      fill: doFill,
      stroke: doStroke,
      ops: [...gsOps(ca, CA, mask, doStroke ? grow : 0), ...fillPaint, ...strokePaint],
    }],
  };
}
```

- [ ] **Step 4: Run the gates**

Run: `npx vitest run test/svg-draw.test.ts test/svg-embed.test.ts test/svg-gradient.test.ts` → PASS.
Run: `npm test` → fully green, including the Task 2 failure, which this task fixes.
Run: `npm run typecheck` → clean.

- [ ] **Step 5: Prove the split assertion is load-bearing**

Temporarily change `if (canSplit && doFill && doStroke && !same)` to
`if (false && canSplit …)`. Run
`npx vitest run test/svg-draw.test.ts -t 'splits a masked fill'` and confirm it
goes RED. Revert.

- [ ] **Step 6: Commit**

```bash
git add src/svgdraw.ts test/svg-draw.test.ts test/svg-embed.test.ts
git commit -m "feat(svg): render a varying stop-opacity through a luminosity /SMask (1gg0.17)"
```

---

### Task 6: End-to-end pixels through `ToImage`

The load-bearing check. `raster.ts` is an independently written *reader* of both
shadings and luminosity masks, so these assertions are a genuine
cross-implementation test rather than a round trip through one body of code.

**Files:**
- Modify: `test/svg-gradient-render.test.ts:15-20` (the `render` helper), and append tests

**Interfaces:**
- Consumes: the whole feature, through the public `page.AddSVGObject`.
- Produces: nothing.

- [ ] **Step 1: Generalize the render helper**

In `test/svg-gradient-render.test.ts`, give `render` an optional page backdrop:

```ts
/** Place `src` over the whole of a 200x200 page whose existing content is
 *  `content`, save, reopen, rasterize at 1 px per point — so a device pixel
 *  (x, y) is user (x, 200 - y).
 *
 *  This is the cross-implementation check: raster.ts is an independently written
 *  READER of shadings and of luminosity soft masks, so these assertions are not
 *  a round trip through one body of code. */
function render(src: string, content = '') {
  const p = Document.Open(buildSvgPdf({ mediaBox: [0, 0, 200, 200], content })).Pages[0];
  const r = p.AddSVGObject(svg(src), [0, 0, 200, 200], { fit: 'fill' });
  const rt = Document.Open(p.Document.Save());
  return { png: decodePng(rt.Pages[0].ToImage()), skipped: r.skipped };
}

/** An opaque blue page, so a transparent pixel is distinguishable from a white
 *  one and from the gradient's own red. */
const BLUE_PAGE = '0 0 1 rg 0 0 200 200 re f';
```

- [ ] **Step 2: Write the failing tests**

Append a new describe block to the same file:

```ts
describe('AddSVGObject — varying stop-opacity through Save/Open/ToImage', () => {
  it('ramps alpha 0 → 1 over an opaque backdrop', () => {
    // Constant red, ramping alpha: the colour is held still so only the mask
    // can produce the change across the shape.
    const { png, skipped } = render(
      '<svg viewBox="0 0 100 100"><defs><linearGradient id="g">' +
      '<stop offset="0" stop-color="#f00" stop-opacity="0"/>' +
      '<stop offset="1" stop-color="#f00" stop-opacity="1"/>' +
      '</linearGradient></defs>' +
      '<rect width="100" height="100" fill="url(#g)"/></svg>', BLUE_PAGE);
    expect(skipped).toEqual([]);
    const [lr, , lb] = png.at(4, 100);
    expect(near(lr, 0)).toBe(true);        // fully transparent: pure backdrop
    expect(near(lb, 255)).toBe(true);
    const [rr, , rb] = png.at(196, 100);
    expect(near(rr, 255)).toBe(true);      // fully opaque: pure red
    expect(near(rb, 0)).toBe(true);
    const [mr, , mb] = png.at(100, 100);
    expect(near(mr, 128)).toBe(true);      // half: an even blend
    expect(near(mb, 128)).toBe(true);
  });

  it('places the alpha ramp under a nested transform (the CTM cancels once)', () => {
    // The rect covers element x 0..100 under translate(50)+scale(0.5), i.e.
    // viewBox x 50..100 and device x 100..200. Device x=150 is the ramp's
    // midpoint. If the mask pattern /Matrix wrongly kept the element CTM the
    // ramp compresses into device 150..200 and this pixel reads pure backdrop.
    const { png } = render(
      '<svg viewBox="0 0 100 100"><defs><linearGradient id="g">' +
      '<stop offset="0" stop-color="#f00" stop-opacity="0"/>' +
      '<stop offset="1" stop-color="#f00" stop-opacity="1"/>' +
      '</linearGradient></defs>' +
      '<g transform="translate(50 0) scale(0.5 1)">' +
      '<rect width="100" height="100" fill="url(#g)"/></g></svg>', BLUE_PAGE);
    const [mr, , mb] = png.at(150, 100);
    expect(near(mr, 128)).toBe(true);
    expect(near(mb, 128)).toBe(true);
  });

  it('leaves a solid stroke fully opaque beside a masked fill', () => {
    // The fill's ramp is ~0 at the left edge. A single mask over the whole
    // painting operation would make the green stroke nearly vanish there.
    const { png, skipped } = render(
      '<svg viewBox="0 0 100 100"><defs><linearGradient id="g">' +
      '<stop offset="0" stop-color="#f00" stop-opacity="0"/>' +
      '<stop offset="1" stop-color="#f00" stop-opacity="1"/>' +
      '</linearGradient></defs>' +
      '<rect x="10" y="10" width="80" height="80" fill="url(#g)" ' +
      'stroke="#0f0" stroke-width="20"/></svg>', BLUE_PAGE);
    expect(skipped).toEqual([]);
    const [sr, sg2, sb] = png.at(20, 100);     // centre of the left stroke band
    expect(near(sr, 0)).toBe(true);
    expect(near(sg2, 255)).toBe(true);
    expect(near(sb, 0)).toBe(true);
  });

  it('fades a radial gradient outward', () => {
    const { png, skipped } = render(
      '<svg viewBox="0 0 100 100"><defs><radialGradient id="g">' +
      '<stop offset="0" stop-color="#f00" stop-opacity="1"/>' +
      '<stop offset="1" stop-color="#f00" stop-opacity="0"/>' +
      '</radialGradient></defs>' +
      '<circle cx="50" cy="50" r="50" fill="url(#g)"/></svg>', BLUE_PAGE);
    expect(skipped).toEqual([]);
    expect(near(png.at(100, 100)[0], 255)).toBe(true);   // centre: opaque red
    const [er, , eb] = png.at(198, 100);                 // rim: transparent
    expect(near(er, 0)).toBe(true);
    expect(near(eb, 255)).toBe(true);
  });
});
```

- [ ] **Step 3: Run them**

Run: `npx vitest run test/svg-gradient-render.test.ts`
Expected: PASS. If the first test fails at the *midpoint* only, widen `near`'s
tolerance for that assertion rather than changing the implementation — the end
points are the load-bearing part and must be exact. If an *end point* fails,
that is a real bug: debug it, do not loosen the assertion.

- [ ] **Step 4: Prove the assertions are load-bearing**

Each mutation below must turn the named test RED. Apply, run, confirm, revert.

1. In `src/svggradient.ts`, change `patternMatrix(gt, obb, bbox, [...IDENTITY])` to
   `patternMatrix(gt, obb, bbox, ctm)` →
   `-t 'places the alpha ramp under a nested transform'` must fail.
2. In `src/svgdraw.ts`'s `maskGroup`, change `name('DeviceGray')` in the `/Group`
   dict to `name('DeviceRGB')` → `-t 'ramps alpha 0'` must fail.
3. In `src/svgdraw.ts`'s `resolvePaint`, disable the split (`if (false && canSplit …`)
   → `-t 'leaves a solid stroke fully opaque'` must fail.

Record the outcome of all three in the commit message.

- [ ] **Step 5: Run the full gates**

Run: `npm test` → green.
Run: `npm run typecheck` → clean.

- [ ] **Step 6: Commit**

```bash
git add test/svg-gradient-render.test.ts
git commit -m "test(svg): check per-stop alpha against the rasterizer (1gg0.17)

Mutation-verified: dropping the CTM cancellation from the mask pattern matrix,
switching the mask group to /DeviceRGB, and collapsing the two paint passes each
turn one of these tests red."
```

---

### Task 7: Documentation

**Files:**
- Modify: `README.md:19`

**Interfaces:** none.

- [ ] **Step 1: Edit the SVG embedding paragraph**

In `README.md` line 19, find this sentence:

> Two gradient limitations: a **per-stop varying `stop-opacity`** paints opaque (a uniform one is exact, folded into the constant alpha), and `reflect`/`repeat` on a **radial** gradient falls back to `pad` — both name the gradient element in `result.skipped`.

Replace it with:

> A **per-stop varying `stop-opacity`** is exact too, rendered through a luminosity `/SMask` — a grayscale twin of the shading in a transparency group — while a uniform one folds into the constant alpha. One gradient limitation remains: `reflect`/`repeat` on a **radial** gradient falls back to `pad` and names the gradient element in `result.skipped`. On a shape whose fill and stroke need *different* masks the two are painted as separate operations, which is exact; inside a `<text>` element, where that split is not available, the mask is dropped and the gradient named in `result.skipped`.

- [ ] **Step 2: Check no other README passage repeats the old claim**

Run: `grep -n "stop-opacity\|paints opaque" README.md`
Expected: only the sentence just edited. If the Limitations section (near line
1464) carries a matching bullet, update it the same way.

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs(svg): document per-stop alpha via a luminosity /SMask (1gg0.17)"
```

---

### Task 8: Close the issue and push

Per `CLAUDE.md`: work is not complete until `git push` succeeds.

**Files:** none (bd state and git remote).

- [ ] **Step 1: Confirm both gates one final time**

```bash
npm run typecheck
npm test
```

Both must be green. Do not proceed otherwise.

- [ ] **Step 2: File follow-ups for anything left**

One known gap is worth recording if you hit it: a `userSpaceOnUse` gradient with
a varying ramp on an element with a **null** bbox gets no mask and no report.
Nothing in the current walker can reach it (a shape always has a segment bbox and
a text run without glyphs paints nothing), so file it only if you find a path.

```bash
bd create "…" -p 4 --parent aspose-pdf-foss-for-ts-1gg0
```

- [ ] **Step 3: Close the issue**

```bash
bd close aspose-pdf-foss-for-ts-1gg0.17
```

- [ ] **Step 4: Push**

```bash
git pull --rebase
git push
git status        # MUST show "up to date with origin"
```

# SVG `<filter>` — graph, raster seam and core kernels (phase 3 of 5)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `page.AddSVGObject` honours the `filter` property for the eleven filter primitives that need no new machinery, by rasterizing the filtered subtree and running the primitive graph in pixel space.

**Architecture:** `svgfilter.ts` turns a `<filter>` element into a primitive graph with no pixels involved — region, per-primitive subregions, `in`/`result` wiring. `svgfilterfx.ts` owns the `Surface` type, the sRGB↔linear edges, the kernels, and the graph runner. The one new capability that needs a `Document` — rasterizing a Form XObject — crosses the same kind of seam as every other allocation in this stack: a new `SvgRasterSink`, implemented in `svgembed.ts` over one new export in `raster.ts`.

**Tech Stack:** TypeScript (ESM, NodeNext, `strict`), vitest. Zero runtime dependencies — `node:` built-ins only.

**Spec:** `docs/superpowers/specs/2026-07-30-svg-masks-filters-markers-design.md`, section "3. `<filter>`" (including "How the walker learns the device size", "Emitting the surface" and "Phase 3 staging").

**Issue:** `aspose-pdf-foss-for-ts-1gg0.10.3` (phase 3 child of `1gg0.10`).

## Global Constraints

- Zero runtime dependencies. Only `node:` built-ins. Do not add npm runtime deps.
- ESM + NodeNext: every relative import specifier carries the `.js` extension (`import { x } from './svgpath.js'`).
- `strict` TypeScript. `npm run typecheck` and `npm test` must both be green before any task is considered done.
- `src/svgdraw.ts` allocates **nothing**. Streams come from `SvgStreamSink`, images from `SvgImageSink`, fonts from `SvgFontProvider`, rasters from the new `SvgRasterSink` — all implemented in `src/svgembed.ts`, the only module in the SVG stack that may touch a `Document`. Every new module in this plan is pure.
- SVG content is emitted in **viewBox units with y pointing DOWN**. The flip to PDF's y-up happens once, in `svgtransform.ts`'s `placementMatrix`. Never add a second flip. A PDF image fills the unit square with its first row at `v = 1`, so an image placed in this space takes `cm = [w, 0, 0, -h, x, y + h]` — the local `-h` cancels the flip in `placementMatrix`. Emitting `+h` mirrors the image vertically.
- `PdfDict` is `Map<string, PdfObject>` keyed **without** the leading `/`. Names are tagged objects: `name('FlateDecode')`, not the string.
- Errors: `TypeError` for rejected public options (before any allocation); anything unrenderable degrades and is reported through `result.skipped`. Never throw for bad SVG.
- Commit messages end with `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`.
- Run a single test file with `npx vitest run test/<name>.test.ts`.

### Invariants this phase introduces

1. **`SUPPORTED` in `svgfilter.ts` equals the runner's kernel table in `svgfilterfx.ts`.** A primitive is listed as supported in the *same commit* that adds its kernel, never earlier. Listing it early makes an unimplemented primitive silently pass its input through — ink that looks plausible and is wrong, which is the failure mode this repo cares most about.
2. **A filter chain is all-or-nothing.** If any primitive is unsupported, or any `in` cannot be resolved, the element draws **unfiltered** and reports. Partial evaluation would produce confidently wrong ink; `emitClip` and the mask wiring already prefer visible-wrong-but-present over silently dropped, and a *reported* unfiltered draw is the honest version of that.
3. **Colour-space conversions are unpremultiply-aware.** A premultiplied value is not a colour; converting it through the sRGB transfer function directly is wrong wherever alpha < 1. Unpremultiply, convert, repremultiply.
4. **`feColorMatrix` and `feComponentTransfer` operate on non-premultiplied values** (SVG 1.1 §15.7.5, §15.7.7). Every other kernel here operates on premultiplied values.

### Scope: what this phase deliberately does not do

Deferred to `1gg0.10.4` (filed in Task 15, not implemented here):

- `feConvolveMatrix`, `feDisplacementMap`, `feImage`, `feTurbulence`, `feDiffuseLighting`, `feSpecularLighting` and the three light sources.
- The `FillPaint` / `StrokePaint` pseudo-inputs. The design lists them as "implemented for solid paint", but the element's resolved `Paint` is not available where `resolveFilter` runs, and threading it through for two rare inputs is not worth doing before the graph exists. Here they resolve as unsupported: the element draws unfiltered and reports `filter`.

`BackgroundImage` / `BackgroundAlpha` are reported, never implemented — see the spec.

Deferred to `1gg0.10.5`: the vector fast paths. Everything in this phase rasterizes, which is what makes those fast paths testable later against a reference.

---

## File Structure

| File | Change | Responsibility |
|---|---|---|
| `src/svgfilter.ts` | **create** | Parse `<filter>` into a primitive graph; filter region, per-primitive subregions, `primitiveUnits`, `in`/`result` wiring, the supported set. Pure, no pixels. |
| `src/svgfilterfx.ts` | **create** | `Surface`, the sRGB↔linear premultiplied edges, `surfaceImage`, the kernels, and `runFilter`. Pure. |
| `src/raster.ts` | modify | One new export: `rasterizeFormRgba`. |
| `src/imageembed.ts` | modify | Export the existing private `flate` and `imageStream` helpers. |
| `src/svgdraw.ts` | modify | `SvgRasterSink`; `SvgDrawOptions` on `drawSvg`; `rasterized` on `DrawResult`; the `filter` property wiring in `walk`; `'filter'` in `DEFINITION`. |
| `src/svgembed.ts` | modify | Implements `SvgRasterSink`; validates and forwards `filterScale`; surfaces `rasterized`. |
| `test/svg-filter.test.ts` | **create** | The graph: wiring, region, subregions, `primitiveUnits`, the resolution union, reporting. |
| `test/svg-filterfx.test.ts` | **create** | The `Surface` edges and every kernel, against external references. |
| `test/svg-filter-render.test.ts` | **create** | End-to-end through `Save` / `Open` / `ToImage`. |
| `README.md` | modify | The SVG embedding bullet gains filters, `filterScale` and `rasterized`. |

---

## Shared Interfaces

Every task below is written against these. They are introduced by Tasks 1–4; later tasks consume them unchanged.

```ts
// src/svgfilter.ts
export interface FilterPrim {
  /** Element name, e.g. 'feGaussianBlur'. */
  name: string;
  /** Resolved key of the first input: 'SourceGraphic', 'SourceAlpha', or a result name. */
  in1: string;
  /** Resolved key of the second input; '' for a one-input primitive. */
  in2: string;
  /** The key this primitive's output is stored under. */
  result: string;
  /** Subregion, in the element's user space (y-down). */
  sub: SegBBox;
  /** The primitive's own attributes. */
  attrs: Map<string, string>;
  /** The element itself, for primitives that read children (feMerge, feComponentTransfer). */
  node: XmlNode;
  /** color-interpolation-filters for THIS primitive. */
  space: 'linearRGB' | 'sRGB';
}

export interface FilterSpec {
  /** The filter region, in the element's user space (y-down). */
  region: SegBBox;
  prims: FilterPrim[];
  /** primitiveUnits === 'objectBoundingBox'. */
  obb: boolean;
  /** The element's bbox. Non-null whenever `obb` is true. */
  bbox: SegBBox | null;
  /** filterRes, when given: a hard cap on the raster in device pixels. */
  res?: [number, number];
}

export type FilterResolution =
  /** Run it. */
  | { kind: 'draw'; spec: FilterSpec }
  /** A zero-area filter region: SVG 1.1 §15.7.2 says the element renders
   *  nothing. The author asked for that, so it is NOT reported. */
  | { kind: 'empty' }
  /** Cannot run it: draw the element unfiltered and add `report` to skipped. */
  | { kind: 'skip'; report: string[] };

export function resolveFilter(
  node: XmlNode, bbox: SegBBox | null, viewport: ViewBox, css?: CssDecls,
): FilterResolution;

export function primLength(
  spec: FilterSpec, v: string | undefined, dflt: number, axis: 'x' | 'y',
): number;
```

```ts
// src/svgfilterfx.ts
export interface Surface {
  /** Pixel-space origin, relative to the filter region's top-left. Mirrors
   *  raster.ts's Canvas.originX/Y: a surface is a window onto the filter
   *  region, not its own coordinate system. */
  x: number; y: number;
  w: number; h: number;
  /** Premultiplied linear RGBA, 0..1, row-major. */
  data: Float32Array;
}

export function makeSurface(x: number, y: number, w: number, h: number): Surface;
export function toSurface(img: ImageRgba): Surface;
export function surfaceImage(s: Surface): BuiltImage;
export function srgbToLinear(v: number): number;
export function linearToSrgb(v: number): number;
export function convertSpace(s: Surface, to: 'linearRGB' | 'sRGB'): Surface;
export function runFilter(spec: FilterSpec, source: Surface, scale: number): Surface;
```

```ts
// src/svgdraw.ts
export interface SvgRasterSink {
  /** Render the Form XObject `dict`+`content` — whose /BBox defines the region —
   *  into exactly devW x devH pixels, top-down, transparent where unpainted.
   *  Returns null on any failure, which makes the element draw unfiltered. */
  rasterize(dict: PdfDict, content: string, devW: number, devH: number): ImageRgba | null;
}

export interface SvgDrawOptions {
  /** Points per user unit at the placement. Default 1. */
  deviceScale?: number;
  /** Resolution multiplier for a rasterized filter. Default 2. */
  filterScale?: number;
  /** Absent means <filter> cannot be rendered and is reported. */
  raster?: SvgRasterSink;
}

export interface DrawResult {
  content: string;
  resources: PdfDict;
  skipped: string[];
  /** Element names whose subtree was flattened to a bitmap, sorted. */
  rasterized: string[];
}

export function drawSvg(
  root: XmlNode, viewport: ViewBox, provider: SvgFontProvider,
  streams: SvgStreamSink, images: SvgImageSink, opts?: SvgDrawOptions,
): DrawResult;
```

```ts
// src/raster.ts
export function rasterizeFormRgba(
  doc: Document, form: PdfStream, devW: number, devH: number,
): ImageRgba;
```

---
---

# Commit A — the graph

Pure parsing. No pixels, no walker change, no public API change. `svgfilter.ts` and `test/svg-filter.test.ts` only.

---

## Task 1: The primitive graph

Parse a `<filter>`'s children into an ordered list of primitives with their inputs resolved. Region and subregions come in Tasks 2 and 3; this task fixes `region` to a placeholder the tests do not read.

**Files:**
- Create: `src/svgfilter.ts`
- Test: `test/svg-filter.test.ts` (create)

**Interfaces:**
- Consumes: `XmlNode` from `src/xml.js`; `SegBBox` from `src/svgpath.js`; `ViewBox` from `src/svgtransform.js`; `CssDecls` from `src/svgcss.js`; `styleGetter` from `src/svgstyle.js`.
- Produces: `FilterPrim`, `FilterSpec`, `FilterResolution`, `resolveFilter` from `src/svgfilter.ts`.

- [ ] **Step 1: Write the failing test**

Create `test/svg-filter.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { parseXml, type XmlNode } from '../src/xml.js';
import { resolveFilter, type FilterSpec } from '../src/svgfilter.js';

const xml = (s: string) => new TextEncoder().encode(s);

/** The element carrying `id`, from a document fragment. */
function nodeOf(src: string, id = 'f'): XmlNode {
  const root = parseXml(xml(src));
  let found: XmlNode | undefined;
  const walk = (n: XmlNode): void => {
    if (n.attrs.get('id') === id) found ??= n;
    for (const c of n.children) walk(c);
  };
  walk(root);
  return found!;
}

const VP = { minX: 0, minY: 0, w: 200, h: 100 };
const BOX = { x: 10, y: 20, w: 40, h: 80 };

/** resolveFilter, asserting it resolved to a runnable spec. */
function spec(src: string, bbox = BOX): FilterSpec {
  const r = resolveFilter(nodeOf(src), bbox, VP);
  if (r.kind !== 'draw') throw new Error(`expected draw, got ${r.kind}`);
  return r.spec;
}

describe('resolveFilter — graph wiring', () => {
  it('defaults the first input to SourceGraphic', () => {
    const s = spec('<svg><filter id="f"><feOffset dx="1"/></filter></svg>');
    expect(s.prims).toHaveLength(1);
    expect(s.prims[0].name).toBe('feOffset');
    expect(s.prims[0].in1).toBe('SourceGraphic');
  });

  it('chains an implicit input to the previous result', () => {
    const s = spec('<svg><filter id="f"><feOffset dx="1"/><feFlood/></filter></svg>');
    // Every primitive gets a result key, named or not; the second reads the first.
    expect(s.prims[1].in1).toBe(s.prims[0].result);
  });

  it('resolves a named result referenced later', () => {
    const s = spec(
      '<svg><filter id="f"><feOffset dx="1" result="shift"/>' +
      '<feFlood/><feComposite in="shift" in2="SourceGraphic"/></filter></svg>');
    expect(s.prims[2].in1).toBe('shift');
    expect(s.prims[2].in2).toBe('SourceGraphic');
    expect(s.prims[0].result).toBe('shift');
  });

  it('gives distinct result keys to unnamed primitives', () => {
    const s = spec('<svg><filter id="f"><feFlood/><feFlood/><feFlood/></filter></svg>');
    const keys = new Set(s.prims.map((p) => p.result));
    expect(keys.size).toBe(3);
  });

  it('carries SourceAlpha through as a pseudo-input', () => {
    const s = spec('<svg><filter id="f"><feOffset in="SourceAlpha" dx="1"/></filter></svg>');
    expect(s.prims[0].in1).toBe('SourceAlpha');
  });

  it('ignores non-primitive children', () => {
    const s = spec('<svg><filter id="f"><title>x</title><feOffset dx="1"/></filter></svg>');
    expect(s.prims).toHaveLength(1);
  });

  it('reads color-interpolation-filters per primitive, defaulting to linearRGB', () => {
    const s = spec(
      '<svg><filter id="f"><feFlood/>' +
      '<feFlood color-interpolation-filters="sRGB"/></filter></svg>');
    expect(s.prims[0].space).toBe('linearRGB');
    expect(s.prims[1].space).toBe('sRGB');
  });

  it('inherits color-interpolation-filters from the filter element', () => {
    const s = spec(
      '<svg><filter id="f" color-interpolation-filters="sRGB">' +
      '<feFlood/></filter></svg>');
    expect(s.prims[0].space).toBe('sRGB');
  });
});

describe('resolveFilter — refusals', () => {
  it('skips and reports an unsupported primitive', () => {
    const r = resolveFilter(
      nodeOf('<svg><filter id="f"><feTurbulence/></filter></svg>'), BOX, VP);
    expect(r.kind).toBe('skip');
    if (r.kind === 'skip') expect(r.report).toEqual(['feTurbulence']);
  });

  it('skips a chain whose `in` names nothing', () => {
    const r = resolveFilter(
      nodeOf('<svg><filter id="f"><feOffset in="ghost" dx="1"/></filter></svg>'), BOX, VP);
    expect(r.kind).toBe('skip');
    if (r.kind === 'skip') expect(r.report).toEqual(['filter']);
  });

  it('skips a forward reference: results are visible only to LATER primitives', () => {
    const r = resolveFilter(
      nodeOf('<svg><filter id="f"><feOffset in="later" dx="1"/>' +
             '<feFlood result="later"/></filter></svg>'), BOX, VP);
    expect(r.kind).toBe('skip');
  });

  it('reports BackgroundImage rather than pretending to have a backdrop', () => {
    const r = resolveFilter(
      nodeOf('<svg><filter id="f"><feOffset in="BackgroundImage" dx="1"/></filter></svg>'),
      BOX, VP);
    expect(r.kind).toBe('skip');
    if (r.kind === 'skip') expect(r.report).toEqual(['filter']);
  });

  it('skips an empty filter: no primitives means no defined result', () => {
    const r = resolveFilter(nodeOf('<svg><filter id="f"/></svg>'), BOX, VP);
    expect(r.kind).toBe('skip');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/svg-filter.test.ts`
Expected: FAIL — `Failed to resolve import "../src/svgfilter.js"`.

- [ ] **Step 3: Write the implementation**

Create `src/svgfilter.ts`:

```ts
// SVG <filter> -> a primitive graph (issue 1gg0.10.3). Pure: region, subregion
// and input resolution, with no pixels involved. Mirrors svgmask.ts's role —
// it decides geometry and hands back a descriptor, allocating nothing. The
// kernels that consume this live in svgfilterfx.ts.
import type { XmlNode } from './xml.js';
import type { SegBBox } from './svgpath.js';
import { unitLength, type ViewBox } from './svgtransform.js';
import { styleGetter } from './svgstyle.js';
import type { CssDecls } from './svgcss.js';

/** One filter primitive, with its inputs resolved to keys. */
export interface FilterPrim {
  name: string;
  in1: string;
  in2: string;
  result: string;
  sub: SegBBox;
  attrs: Map<string, string>;
  node: XmlNode;
  space: 'linearRGB' | 'sRGB';
}

/** A resolved <filter>: where it applies and what to run inside it. */
export interface FilterSpec {
  region: SegBBox;
  prims: FilterPrim[];
  obb: boolean;
  bbox: SegBBox | null;
  res?: [number, number];
}

export type FilterResolution =
  | { kind: 'draw'; spec: FilterSpec }
  | { kind: 'empty' }
  | { kind: 'skip'; report: string[] };

/** The primitives this build can actually run.
 *
 *  INVARIANT: this set equals the kernel table in svgfilterfx.ts's runFilter,
 *  and a name is added here in the SAME commit as its kernel. Listing a
 *  primitive early makes it pass its input through untouched — plausible ink
 *  that is silently wrong, which is worse than a reported refusal. */
const SUPPORTED = new Set(['feFlood', 'feOffset']);

/** The pseudo-inputs the rasterizer can actually produce.
 *
 *  SVG defines four more — BackgroundImage, BackgroundAlpha, FillPaint and
 *  StrokePaint. The first two need the accumulated page backdrop, which a
 *  single-pass walker does not retain and which no shipping browser has ever
 *  implemented; the second two need the element's resolved Paint, which does
 *  not reach here (issue filed under 1gg0.10). All four fall through to the
 *  same refusal as an unknown name. */
const RUNNABLE_PSEUDO = new Set(['SourceGraphic', 'SourceAlpha']);

/** Anything in the fe* namespace is a primitive; other children (title, desc,
 *  a stray <script>) are ignored rather than reported — they render nothing
 *  wherever they appear. */
const isPrimitive = (n: XmlNode): boolean => n.name.startsWith('fe');

export function resolveFilter(
  node: XmlNode, bbox: SegBBox | null, viewport: ViewBox, css?: CssDecls,
): FilterResolution {
  const kids = node.children.filter(isPrimitive);
  // No primitives means no result to draw. Not 'empty': an author writing an
  // empty <filter> has almost certainly lost the contents, so it is reported.
  if (kids.length === 0) return { kind: 'skip', report: ['filter'] };

  const filterSpace = styleGetter(node.attrs, css)('color-interpolation-filters');
  const prims: FilterPrim[] = [];
  const results = new Set<string>();
  let prev = '';

  for (let i = 0; i < kids.length; i++) {
    const k = kids[i];
    if (!SUPPORTED.has(k.name)) return { kind: 'skip', report: [k.name] };

    const named = k.attrs.get('result');
    // Unnamed results get a key an author cannot collide with: 'result' is a
    // CDATA attribute, so a literal '#' is legal in it, but no one writes one.
    const result = named !== undefined && named !== '' ? named : `#${i}`;

    const in1 = k.attrs.get('in') ?? (prev === '' ? 'SourceGraphic' : prev);
    const in2 = k.attrs.get('in2') ?? '';
    for (const v of [in1, in2]) {
      if (v === '') continue;
      // A result is visible only to LATER primitives (SVG 1.1 §15.7.2), so
      // `results` is consulted before this primitive's own key is added.
      if (results.has(v)) continue;
      if (RUNNABLE_PSEUDO.has(v)) continue;
      // Everything left is either a pseudo-input we cannot supply
      // (BackgroundImage, FillPaint) or a name nothing produced. Both report
      // 'filter': an author cannot act on the difference, and naming the
      // pseudo-input would read like a supported-primitive report.
      return { kind: 'skip', report: ['filter'] };
    }

    const cif = styleGetter(k.attrs, undefined)('color-interpolation-filters')
      ?? filterSpace;
    prims.push({
      name: k.name, in1, in2, result,
      sub: { x: 0, y: 0, w: 0, h: 0 },       // Task 3
      attrs: k.attrs, node: k,
      space: (cif ?? '').trim() === 'sRGB' ? 'sRGB' : 'linearRGB',
    });
    results.add(result);
    prev = result;
  }

  return {
    kind: 'draw',
    spec: {
      region: { x: 0, y: 0, w: 0, h: 0 },     // Task 2
      prims, obb: false, bbox,
    },
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/svg-filter.test.ts`
Expected: PASS (16 assertions across the two describes).

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: no output, exit 0.

---

## Task 2: The filter region

`filterUnits` (default `objectBoundingBox`) resolves `x`/`y`/`width`/`height`, which default to `-10%`, `-10%`, `120%`, `120%`. A zero-area region means the element renders nothing and is not a reported loss.

**Files:**
- Modify: `src/svgfilter.ts` (`resolveFilter`)
- Test: `test/svg-filter.test.ts` (append)

**Interfaces:**
- Consumes: `unitLength(v, dflt, obb, span)` from `src/svgtransform.js` — the shared objectBoundingBox/userSpaceOnUse length rule extracted in phase 1.
- Produces: a populated `FilterSpec.region` and `FilterSpec.res`.

- [ ] **Step 1: Write the failing test**

Append to `test/svg-filter.test.ts`:

```ts
const near = (a: number, b: number) => expect(a).toBeCloseTo(b, 6);
const OFF = '<feOffset dx="1"/>';

describe('resolveFilter — region', () => {
  it('defaults to a 10% bleed around the box under objectBoundingBox', () => {
    const s = spec(`<svg><filter id="f">${OFF}</filter></svg>`);
    near(s.region.x, 10 - 4);        // x - 0.1*w
    near(s.region.y, 20 - 8);        // y - 0.1*h
    near(s.region.w, 40 * 1.2);
    near(s.region.h, 80 * 1.2);
  });

  it('takes explicit fractions under objectBoundingBox', () => {
    const s = spec(
      `<svg><filter id="f" x="0" y="0" width="0.5" height="0.25">${OFF}</filter></svg>`);
    near(s.region.x, 10); near(s.region.y, 20);
    near(s.region.w, 20); near(s.region.h, 20);
  });

  it('takes literal user units under userSpaceOnUse', () => {
    const s = spec(
      '<svg><filter id="f" filterUnits="userSpaceOnUse" x="5" y="6" ' +
      `width="30" height="40">${OFF}</filter></svg>`);
    near(s.region.x, 5); near(s.region.y, 6);
    near(s.region.w, 30); near(s.region.h, 40);
  });

  it('resolves the percentage defaults against the VIEWPORT under userSpaceOnUse', () => {
    const s = spec(
      `<svg><filter id="f" filterUnits="userSpaceOnUse">${OFF}</filter></svg>`);
    near(s.region.x, -0.1 * VP.w);
    near(s.region.y, -0.1 * VP.h);
    near(s.region.w, 1.2 * VP.w);
    near(s.region.h, 1.2 * VP.h);
  });

  it('renders nothing, and reports nothing, for a zero-width region', () => {
    const r = resolveFilter(
      nodeOf(`<svg><filter id="f" width="0">${OFF}</filter></svg>`), BOX, VP);
    // SVG 1.1 15.7.2: the element is not rendered. The author asked for it.
    expect(r.kind).toBe('empty');
  });

  it('renders nothing for a negative height', () => {
    const r = resolveFilter(
      nodeOf(`<svg><filter id="f" height="-1">${OFF}</filter></svg>`), BOX, VP);
    expect(r.kind).toBe('empty');
  });

  it('skips when objectBoundingBox units meet a box with no area', () => {
    // Not 'empty': the element has ink, and dropping it would be a loss.
    const r = resolveFilter(
      nodeOf(`<svg><filter id="f">${OFF}</filter></svg>`),
      { x: 0, y: 0, w: 0, h: 10 }, VP);
    expect(r.kind).toBe('skip');
    if (r.kind === 'skip') expect(r.report).toEqual(['filter']);
  });

  it('skips when objectBoundingBox units meet no box at all', () => {
    const r = resolveFilter(
      nodeOf(`<svg><filter id="f">${OFF}</filter></svg>`), null, VP);
    expect(r.kind).toBe('skip');
  });

  it('does NOT need a box under userSpaceOnUse with userSpaceOnUse primitives', () => {
    const r = resolveFilter(
      nodeOf('<svg><filter id="f" filterUnits="userSpaceOnUse" x="0" y="0" ' +
             `width="10" height="10">${OFF}</filter></svg>`), null, VP);
    expect(r.kind).toBe('draw');
  });

  it('carries filterRes as a raster cap', () => {
    const s = spec(`<svg><filter id="f" filterRes="64 32">${OFF}</filter></svg>`);
    expect(s.res).toEqual([64, 32]);
  });

  it('ignores a malformed filterRes rather than capping to nonsense', () => {
    const s = spec(`<svg><filter id="f" filterRes="wide">${OFF}</filter></svg>`);
    expect(s.res).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/svg-filter.test.ts`
Expected: FAIL — the region assertions get `0` for every value.

- [ ] **Step 3: Write the implementation**

In `src/svgfilter.ts`, add above `resolveFilter`:

```ts
/** `filterRes`, when it parses to two positive numbers. Deprecated in SVG 1.1
 *  and dropped in SVG 2, but honoured: an author who wrote it wanted a cap. */
function filterRes(v: string | undefined): [number, number] | undefined {
  if (v === undefined) return undefined;
  const p = v.trim().split(/[\s,]+/).map(Number);
  const [w, h] = p.length === 1 ? [p[0], p[0]] : p;
  if (!Number.isFinite(w) || !Number.isFinite(h) || !(w > 0) || !(h > 0)) return undefined;
  return [Math.floor(w), Math.floor(h)];
}
```

Then, in `resolveFilter`, **before** the primitive loop (a rejected region should not depend on parsing the children):

```ts
  const obb = (node.attrs.get('filterUnits') ?? 'objectBoundingBox') !== 'userSpaceOnUse';
  // objectBoundingBox is the DEFAULT, so a missing or empty box is the common
  // failure, not an edge case. It cannot yield a region, and the element has
  // ink, so it degrades to unfiltered rather than to nothing.
  if (obb && (!bbox || !(bbox.w > 0) || !(bbox.h > 0)))
    return { kind: 'skip', report: ['filter'] };

  // The spec's defaults are the STRINGS -10%/-10%/120%/120%, so under
  // userSpaceOnUse they resolve against the viewport, not the box. Mirrors
  // resolveMask, which has the identical rule.
  const sx = obb ? bbox!.w : viewport.w;
  const sy = obb ? bbox!.h : viewport.h;
  const fx = unitLength(node.attrs.get('x'), obb ? -0.1 : -0.1 * sx, obb, sx);
  const fy = unitLength(node.attrs.get('y'), obb ? -0.1 : -0.1 * sy, obb, sy);
  const fw = unitLength(node.attrs.get('width'), obb ? 1.2 : 1.2 * sx, obb, sx);
  const fh = unitLength(node.attrs.get('height'), obb ? 1.2 : 1.2 * sy, obb, sy);
  // SVG 1.1 15.7.2: a zero or negative extent disables rendering of the
  // ELEMENT. That is what the author asked for, so it is not a loss.
  if (!(fw > 0) || !(fh > 0)) return { kind: 'empty' };

  const region: SegBBox = obb
    ? { x: bbox!.x + fx * bbox!.w, y: bbox!.y + fy * bbox!.h,
        w: fw * bbox!.w, h: fh * bbox!.h }
    : { x: fx, y: fy, w: fw, h: fh };
```

and replace the returned spec's placeholder region:

```ts
  return {
    kind: 'draw',
    spec: { region, prims, obb: false, bbox, res: filterRes(node.attrs.get('filterRes')) },
  };
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/svg-filter.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: no output, exit 0.

---

## Task 3: Primitive subregions and `primitiveUnits`

Each primitive may narrow its output to a subregion; `primitiveUnits` governs both those coordinates and every length-valued parameter a kernel later reads.

**Files:**
- Modify: `src/svgfilter.ts`
- Test: `test/svg-filter.test.ts` (append)

**Interfaces:**
- Produces: populated `FilterPrim.sub`, `FilterSpec.obb`, and `primLength(spec, v, dflt, axis)` from `src/svgfilter.ts`.

- [ ] **Step 1: Write the failing test**

Append to `test/svg-filter.test.ts`:

```ts
import { primLength } from '../src/svgfilter.js';   // add to the existing import

describe('resolveFilter — primitive subregions', () => {
  it('defaults a subregion to the whole filter region', () => {
    const s = spec(`<svg><filter id="f">${OFF}</filter></svg>`);
    expect(s.prims[0].sub).toEqual(s.region);
  });

  it('takes literal user units under the default primitiveUnits', () => {
    const s = spec(
      '<svg><filter id="f" filterUnits="userSpaceOnUse" x="0" y="0" width="100" height="100">' +
      '<feOffset dx="1" x="10" y="20" width="30" height="40"/></filter></svg>');
    const sub = s.prims[0].sub;
    near(sub.x, 10); near(sub.y, 20); near(sub.w, 30); near(sub.h, 40);
  });

  it('takes bbox fractions under primitiveUnits=objectBoundingBox', () => {
    const s = spec(
      '<svg><filter id="f" primitiveUnits="objectBoundingBox" ' +
      'filterUnits="userSpaceOnUse" x="0" y="0" width="100" height="100">' +
      '<feOffset dx="1" x="0" y="0" width="0.5" height="0.5"/></filter></svg>');
    const sub = s.prims[0].sub;
    // BOX is (10, 20, 40, 80).
    near(sub.x, 10); near(sub.y, 20); near(sub.w, 20); near(sub.h, 40);
  });

  it('clips a subregion to the filter region', () => {
    const s = spec(
      '<svg><filter id="f" filterUnits="userSpaceOnUse" x="0" y="0" width="50" height="50">' +
      '<feOffset dx="1" x="40" y="40" width="100" height="100"/></filter></svg>');
    const sub = s.prims[0].sub;
    near(sub.x, 40); near(sub.y, 40); near(sub.w, 10); near(sub.h, 10);
  });

  it('takes only the axes that are given, leaving the others at the region', () => {
    const s = spec(
      '<svg><filter id="f" filterUnits="userSpaceOnUse" x="0" y="0" width="50" height="50">' +
      '<feOffset dx="1" x="10"/></filter></svg>');
    const sub = s.prims[0].sub;
    near(sub.x, 10); near(sub.y, 0);
    near(sub.w, 40);                   // narrowed by the x shift, not reset
    near(sub.h, 50);
  });

  it('records primitiveUnits on the spec', () => {
    const a = spec(`<svg><filter id="f">${OFF}</filter></svg>`);
    const b = spec(
      `<svg><filter id="f" primitiveUnits="objectBoundingBox">${OFF}</filter></svg>`);
    expect(a.obb).toBe(false);
    expect(b.obb).toBe(true);
  });
});

describe('primLength', () => {
  it('is literal under userSpaceOnUse', () => {
    const s = spec(`<svg><filter id="f">${OFF}</filter></svg>`);
    near(primLength(s, '4', 0, 'x'), 4);
    near(primLength(s, '4', 0, 'y'), 4);
  });

  it('scales by the box axis under objectBoundingBox', () => {
    const s = spec(
      `<svg><filter id="f" primitiveUnits="objectBoundingBox">${OFF}</filter></svg>`);
    near(primLength(s, '0.5', 0, 'x'), 20);    // 0.5 * BOX.w
    near(primLength(s, '0.5', 0, 'y'), 40);    // 0.5 * BOX.h
  });

  it('returns the default for an absent or unparseable value', () => {
    const s = spec(`<svg><filter id="f">${OFF}</filter></svg>`);
    near(primLength(s, undefined, 7, 'x'), 7);
    near(primLength(s, 'thick', 7, 'x'), 7);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/svg-filter.test.ts`
Expected: FAIL — `primLength` is not exported, and every `sub` is the zero box.

- [ ] **Step 3: Write the implementation**

Add to `src/svgfilter.ts`:

```ts
/** Intersect a subregion with the filter region. A primitive may not paint
 *  outside the filter region (SVG 1.1 §15.7.5), so this is the real extent. */
function clipTo(a: SegBBox, r: SegBBox): SegBBox {
  const x0 = Math.max(a.x, r.x), y0 = Math.max(a.y, r.y);
  const x1 = Math.min(a.x + a.w, r.x + r.w), y1 = Math.min(a.y + a.h, r.y + r.h);
  return { x: x0, y: y0, w: Math.max(0, x1 - x0), h: Math.max(0, y1 - y0) };
}

/** The x/y/width/height subregion of one primitive. Each axis defaults
 *  INDEPENDENTLY to the filter region's, so `x` alone narrows the left edge and
 *  leaves the right one where the region put it. */
function subregion(
  attrs: Map<string, string>, region: SegBBox, obb: boolean, bbox: SegBBox | null,
): SegBBox {
  const sx = obb && bbox ? bbox.w : 1;
  const sy = obb && bbox ? bbox.h : 1;
  const ox = obb && bbox ? bbox.x : 0;
  const oy = obb && bbox ? bbox.y : 0;
  const has = (k: string): boolean => attrs.get(k) !== undefined;
  const at = (k: string, s: number, o: number): number => {
    const n = parseFloat(attrs.get(k) ?? '');
    return Number.isFinite(n) ? n * s + o : 0;
  };
  const x = has('x') ? at('x', sx, ox) : region.x;
  const y = has('y') ? at('y', sy, oy) : region.y;
  const w = has('width') ? at('width', sx, 0) : region.x + region.w - x;
  const h = has('height') ? at('height', sy, 0) : region.y + region.h - y;
  return clipTo({ x, y, w: Math.max(0, w), h: Math.max(0, h) }, region);
}

/** A length-valued primitive parameter — stdDeviation, dx, radius — under the
 *  filter's primitiveUnits. `axis` picks the bbox side an objectBoundingBox
 *  fraction scales by; the two differ on a non-square box. */
export function primLength(
  spec: FilterSpec, v: string | undefined, dflt: number, axis: 'x' | 'y',
): number {
  const n = parseFloat(v ?? '');
  if (!Number.isFinite(n)) return dflt;
  if (!spec.obb || !spec.bbox) return n;
  return n * (axis === 'x' ? spec.bbox.w : spec.bbox.h);
}
```

In `resolveFilter`, read `primitiveUnits` before the loop:

```ts
  const pobb = node.attrs.get('primitiveUnits') === 'objectBoundingBox';
```

set each primitive's `sub` in the loop:

```ts
      sub: subregion(k.attrs, region, pobb, bbox),
```

and carry `obb` on the returned spec:

```ts
    spec: { region, prims, obb: pobb, bbox, res: filterRes(node.attrs.get('filterRes')) },
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/svg-filter.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck and run the whole suite**

Run: `npm run typecheck && npm test`
Expected: both green. Nothing outside `svgfilter.ts` has changed yet.

- [ ] **Step 6: Prove the assertions are load-bearing**

Per CLAUDE.md, a test that passes first time is not evidence. Break each of these and confirm the suite goes red, then revert:

1. In `subregion`, drop the `clipTo` call (return the raw box) → "clips a subregion to the filter region" must fail.
2. In `resolveFilter`, move `results.add(result)` above the `in1`/`in2` check → "skips a forward reference" must fail.
3. In `primLength`, use `bbox.w` for both axes → "scales by the box axis" must fail.

- [ ] **Step 7: Commit**

```bash
git add src/svgfilter.ts test/svg-filter.test.ts
git commit -m "$(cat <<'EOF'
feat(svg): parse <filter> into a primitive graph

svgfilter.ts resolves a <filter> element into an ordered primitive list with
in/result wiring, the filter region under filterUnits, and per-primitive
subregions under primitiveUnits. Pure -- no pixels, and nothing calls it yet.

The resolution is a discriminated union so the walker cannot confuse the three
outcomes: a zero-area region renders the element as nothing and is NOT reported
(SVG 1.1 15.7.2, the author's choice), while an unsupported primitive or an
unresolvable `in` draws the element UNFILTERED and is.

SUPPORTED holds only feFlood and feOffset: it must equal the kernel table, and
a primitive listed before its kernel exists would pass its input through
untouched -- plausible ink that is silently wrong.

Refs: aspose-pdf-foss-for-ts-1gg0.10.3

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---
---

# Commit B — the raster seam

End-to-end ink, carrying only the two kernels that need no new machinery. At the end of this commit a `<filter>` with an `feFlood` or `feOffset` renders correctly through `ToImage`.

---

## Task 4: `Surface`, the colour-space edges, and the image emit

The pixel vocabulary, and both ends of the pipeline. Pure and directly testable without a `Document`.

**Files:**
- Create: `src/svgfilterfx.ts`
- Modify: `src/imageembed.ts` (export `flate` and `imageStream`)
- Test: `test/svg-filterfx.test.ts` (create)

**Interfaces:**
- Consumes: `ImageRgba` from `src/raster.js`; `BuiltImage` from `src/imageembed.js`.
- Produces: `Surface`, `makeSurface`, `toSurface`, `surfaceImage`, `srgbToLinear`, `linearToSrgb`, `convertSpace` from `src/svgfilterfx.ts`.

- [ ] **Step 1: Write the failing test**

Create `test/svg-filterfx.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { inflateSync } from 'node:zlib';
import {
  makeSurface, toSurface, surfaceImage, srgbToLinear, linearToSrgb, convertSpace,
} from '../src/svgfilterfx.js';
import { isName, isStream } from '../src/types.js';

const near = (a: number, b: number, d = 6) => expect(a).toBeCloseTo(b, d);

describe('sRGB <-> linear', () => {
  it('fixes the endpoints', () => {
    near(srgbToLinear(0), 0); near(srgbToLinear(1), 1);
    near(linearToSrgb(0), 0); near(linearToSrgb(1), 1);
  });

  it('matches the IEC 61966-2-1 piecewise curve at mid gray', () => {
    // 0.5 sRGB -> ((0.5 + 0.055)/1.055)^2.4, the published value.
    near(srgbToLinear(0.5), 0.21404114, 7);
  });

  it('uses the LINEAR segment below the 0.04045 knee', () => {
    // Below the knee the curve is v/12.92, not the power form.
    near(srgbToLinear(0.03), 0.03 / 12.92, 7);
    expect(srgbToLinear(0.03)).not.toBeCloseTo(Math.pow((0.03 + 0.055) / 1.055, 2.4), 5);
  });

  it('round-trips', () => {
    for (const v of [0.02, 0.1, 0.25, 0.5, 0.75, 0.99]) near(linearToSrgb(srgbToLinear(v)), v);
  });
});

describe('toSurface', () => {
  it('premultiplies and linearizes straight sRGB bytes', () => {
    // One pixel: mid-gray at half alpha.
    const img = { w: 1, h: 1, data: new Uint8Array([128, 128, 128, 128]) };
    const s = toSurface(img);
    expect(s.w).toBe(1); expect(s.h).toBe(1);
    expect(s.x).toBe(0); expect(s.y).toBe(0);
    const a = 128 / 255;
    near(s.data[3], a, 5);
    near(s.data[0], srgbToLinear(128 / 255) * a, 5);
  });

  it('leaves a transparent pixel at zero in every channel', () => {
    const img = { w: 1, h: 1, data: new Uint8Array([255, 0, 0, 0]) };
    const s = toSurface(img);
    for (let i = 0; i < 4; i++) near(s.data[i], 0);
  });
});

describe('surfaceImage', () => {
  it('emits a Flate DeviceRGB image with a DeviceGray /SMask', () => {
    const s = makeSurface(0, 0, 2, 1);
    // Opaque red, opaque white — premultiplied linear.
    s.data.set([1, 0, 0, 1, 1, 1, 1, 1]);
    const built = surfaceImage(s);
    const d = built.stream.dict;
    expect(d.get('Width')).toBe(2);
    expect(d.get('Height')).toBe(1);
    expect(d.get('BitsPerComponent')).toBe(8);
    const cs = d.get('ColorSpace');
    expect(isName(cs) && cs.name).toBe('DeviceRGB');
    const f = d.get('Filter');
    expect(isName(f) && f.name).toBe('FlateDecode');
    expect(built.smask).toBeDefined();
    const sm = built.smask!.dict.get('ColorSpace');
    expect(isName(sm) && sm.name).toBe('DeviceGray');
  });

  it('writes sRGB bytes, unpremultiplied', () => {
    const s = makeSurface(0, 0, 1, 1);
    // Linear 0.21404 at alpha 0.5, premultiplied: a mid-gray sRGB pixel.
    s.data.set([0.21404114 * 0.5, 0.21404114 * 0.5, 0.21404114 * 0.5, 0.5]);
    const built = surfaceImage(s);
    const rgb = inflateSync(Buffer.from(built.stream.raw!));
    expect(Math.abs(rgb[0] - 128)).toBeLessThanOrEqual(1);
    const alpha = inflateSync(Buffer.from(built.smask!.raw!));
    expect(Math.abs(alpha[0] - 128)).toBeLessThanOrEqual(1);
  });

  it('round-trips a rasterized image through both edges', () => {
    // The differential rule: this checks toSurface against surfaceImage, which
    // is only meaningful because the two are inverses by construction and the
    // curve itself is pinned against published values above.
    const img = { w: 1, h: 1, data: new Uint8Array([200, 100, 50, 255]) };
    const built = surfaceImage(toSurface(img));
    const rgb = inflateSync(Buffer.from(built.stream.raw!));
    expect(Math.abs(rgb[0] - 200)).toBeLessThanOrEqual(1);
    expect(Math.abs(rgb[1] - 100)).toBeLessThanOrEqual(1);
    expect(Math.abs(rgb[2] - 50)).toBeLessThanOrEqual(1);
  });
});

describe('convertSpace', () => {
  it('unpremultiplies before converting', () => {
    // Premultiplied linear mid-gray at half alpha. Converting the PREMULTIPLIED
    // value through the transfer function is the bug this guards: it would give
    // linearToSrgb(0.107) = 0.368, not 0.5*0.5 = 0.25.
    const s = makeSurface(0, 0, 1, 1);
    const lin = srgbToLinear(0.5);
    s.data.set([lin * 0.5, lin * 0.5, lin * 0.5, 0.5]);
    const out = convertSpace(s, 'sRGB');
    near(out.data[0], 0.5 * 0.5, 5);      // 0.5 sRGB, premultiplied by 0.5
    near(out.data[3], 0.5, 6);            // alpha is untouched
  });

  it('is a no-op on a transparent pixel', () => {
    const s = makeSurface(0, 0, 1, 1);
    const out = convertSpace(s, 'sRGB');
    for (let i = 0; i < 4; i++) near(out.data[i], 0);
  });

  it('round-trips linear -> sRGB -> linear', () => {
    const s = makeSurface(0, 0, 1, 1);
    s.data.set([0.3 * 0.8, 0.1 * 0.8, 0.9 * 0.8, 0.8]);
    const back = convertSpace(convertSpace(s, 'sRGB'), 'linearRGB');
    for (let i = 0; i < 4; i++) near(back.data[i], s.data[i], 4);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/svg-filterfx.test.ts`
Expected: FAIL — `Failed to resolve import "../src/svgfilterfx.js"`.

- [ ] **Step 3: Export the two stream helpers**

In `src/imageembed.ts`, change the two private helpers to exported ones (their bodies are unchanged):

```ts
/** Deflate `bytes` for a /FlateDecode stream. */
export function flate(bytes: Uint8Array): Uint8Array {
```

```ts
/** An 8-bit-per-component Image XObject over already-deflated bytes. */
export function imageStream(
```

- [ ] **Step 4: Write the implementation**

Create `src/svgfilterfx.ts`:

```ts
// SVG filter pixels (issue 1gg0.10.3): the Surface type, the colour-space edges
// of the pipeline, and the kernels. Pure -- no PDF, no SVG, no Document. Every
// kernel is a function from one or two Surfaces plus parameters to a new one.
//
// Surfaces hold PREMULTIPLIED LINEAR RGBA. SVG 1.1's
// color-interpolation-filters defaults to linearRGB, and a premultiplied value
// is not a colour: converting one through a transfer function directly is wrong
// wherever alpha < 1. convertSpace is the only place that conversion happens.
import { flate, imageStream, type BuiltImage } from './imageembed.js';
import { name } from './types.js';
import type { ImageRgba } from './raster.js';

/** A window onto the filter region, in device pixels. Mirrors raster.ts's
 *  Canvas.originX/Y: x/y are the origin relative to the region's top-left, so a
 *  subregion surface is addressed in the same coordinates as the whole. */
export interface Surface {
  x: number; y: number;
  w: number; h: number;
  /** Premultiplied linear RGBA, 0..1, row-major. */
  data: Float32Array;
}

export function makeSurface(x: number, y: number, w: number, h: number): Surface {
  const cw = Math.max(0, Math.floor(w)), ch = Math.max(0, Math.floor(h));
  return { x, y, w: cw, h: ch, data: new Float32Array(cw * ch * 4) };
}

/** IEC 61966-2-1. The piecewise form, not a bare 2.2 power: the linear segment
 *  below the knee is what keeps near-black from crushing. */
export function srgbToLinear(v: number): number {
  return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
}

export function linearToSrgb(v: number): number {
  return v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055;
}

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

/** A 256-entry table for the byte-in direction: the only conversion that runs
 *  once per source pixel per channel, and the only one whose inputs are
 *  quantized to begin with. */
const SRGB8 = new Float32Array(256);
for (let i = 0; i < 256; i++) SRGB8[i] = srgbToLinear(i / 255);

/** Straight-alpha sRGB bytes from the rasterizer -> premultiplied linear.
 *  The surface is placed at the region origin; the caller owns any offset. */
export function toSurface(img: ImageRgba): Surface {
  const s = makeSurface(0, 0, img.w, img.h);
  const n = img.w * img.h;
  for (let p = 0; p < n; p++) {
    const a = img.data[p * 4 + 3] / 255;
    s.data[p * 4]     = SRGB8[img.data[p * 4]] * a;
    s.data[p * 4 + 1] = SRGB8[img.data[p * 4 + 1]] * a;
    s.data[p * 4 + 2] = SRGB8[img.data[p * 4 + 2]] * a;
    s.data[p * 4 + 3] = a;
  }
  return s;
}

/** Reinterpret a surface's colour channels in the other transfer function.
 *  Alpha is untouched: it is not a colour and has no gamma. */
export function convertSpace(s: Surface, to: 'linearRGB' | 'sRGB'): Surface {
  const f = to === 'sRGB' ? linearToSrgb : srgbToLinear;
  const out = makeSurface(s.x, s.y, s.w, s.h);
  const n = s.w * s.h;
  for (let p = 0; p < n; p++) {
    const a = s.data[p * 4 + 3];
    out.data[p * 4 + 3] = a;
    if (a <= 0) continue;                 // fully transparent: nothing to convert
    for (let c = 0; c < 3; c++)
      out.data[p * 4 + c] = clamp01(f(clamp01(s.data[p * 4 + c] / a))) * a;
  }
  return out;
}

/** The pipeline's output end: premultiplied linear -> an Image XObject plus its
 *  /SMask, in sRGB straight-alpha bytes.
 *
 *  Built directly rather than PNG-encoded and re-parsed through
 *  buildImageXObject: imageembed.ts's decoders are for bytes we did not
 *  produce, and these are ours. */
export function surfaceImage(s: Surface): BuiltImage {
  const n = s.w * s.h;
  const rgb = new Uint8Array(n * 3);
  const alpha = new Uint8Array(n);
  for (let p = 0; p < n; p++) {
    const a = s.data[p * 4 + 3];
    alpha[p] = Math.round(clamp01(a) * 255);
    if (a <= 0) continue;                 // rgb stays 0: no colour to recover
    for (let c = 0; c < 3; c++)
      rgb[p * 3 + c] = Math.round(clamp01(linearToSrgb(clamp01(s.data[p * 4 + c] / a))) * 255);
  }
  return {
    stream: imageStream(s.w, s.h, 8, name('DeviceRGB'), flate(rgb)),
    smask: imageStream(s.w, s.h, 8, name('DeviceGray'), flate(alpha)),
  };
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run test/svg-filterfx.test.ts`
Expected: PASS.

- [ ] **Step 6: Typecheck**

Run: `npm run typecheck`
Expected: no output, exit 0.

---

## Task 5: `rasterizeFormRgba`

`renderPageToPng`'s body minus the PNG encode, driven over a scratch page, mapping a form's `/BBox` onto exactly `devW × devH` pixels.

**Files:**
- Modify: `src/raster.ts` (append after `renderPageToPng`)
- Test: `test/svg-filter-render.test.ts` (create)

**Interfaces:**
- Consumes: `interpret` from `src/pagerender.js`, `Canvas` and `RasterSink` (both private to `raster.ts`), `Page` from `src/page.js`.
- Produces: `rasterizeFormRgba(doc, form, devW, devH): ImageRgba` from `src/raster.ts`.

- [ ] **Step 1: Write the failing test**

Create `test/svg-filter-render.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { rasterizeFormRgba } from '../src/raster.js';
import { enc } from '../src/serialize.js';
import { name, type PdfDict, type PdfObject } from '../src/types.js';
import { buildSvgPdf } from './helpers/build-svg-fixtures.js';

/** A Form XObject over BBox [0,0,10,10] painting a red square in its
 *  bottom-left quadrant (PDF y-up). */
function redQuadrant(): { dict: PdfDict; content: string } {
  const dict: PdfDict = new Map<string, PdfObject>([
    ['Type', name('XObject')],
    ['Subtype', name('Form')],
    ['FormType', 1],
    ['BBox', [0, 0, 10, 10]],
    ['Matrix', [1, 0, 0, 1, 0, 0]],
    ['Resources', new Map<string, PdfObject>()],
  ]);
  return { dict, content: '1 0 0 rg\n0 0 5 5 re\nf' };
}

describe('rasterizeFormRgba', () => {
  it('renders a form at the requested pixel size, top-down', () => {
    const doc = Document.Open(buildSvgPdf({ mediaBox: [0, 0, 20, 20], content: '' }));
    const { dict, content } = redQuadrant();
    const img = rasterizeFormRgba(doc, { kind: 'stream', dict, raw: enc(content) }, 20, 20);
    expect(img.w).toBe(20);
    expect(img.h).toBe(20);
    // BBox y=0..5 is the BOTTOM half in PDF space, so it lands in the BOTTOM
    // half of the raster: row 0 is the top.
    const at = (x: number, y: number) => img.data.slice((y * 20 + x) * 4, (y * 20 + x) * 4 + 4);
    expect([...at(5, 15)]).toEqual([255, 0, 0, 255]);   // bottom-left: painted
    expect(at(5, 5)[3]).toBe(0);                        // top-left: unpainted
    expect(at(15, 15)[3]).toBe(0);                      // bottom-right: unpainted
  });

  it('leaves unpainted area transparent rather than white', () => {
    const doc = Document.Open(buildSvgPdf({ mediaBox: [0, 0, 20, 20], content: '' }));
    const { dict, content } = redQuadrant();
    const img = rasterizeFormRgba(doc, { kind: 'stream', dict, raw: enc(content) }, 4, 4);
    expect(img.data[3]).toBe(0);
  });

  it('honours a BBox that does not start at the origin', () => {
    const doc = Document.Open(buildSvgPdf({ mediaBox: [0, 0, 20, 20], content: '' }));
    const dict: PdfDict = new Map<string, PdfObject>([
      ['Type', name('XObject')], ['Subtype', name('Form')], ['FormType', 1],
      ['BBox', [100, 100, 110, 110]], ['Matrix', [1, 0, 0, 1, 0, 0]],
      ['Resources', new Map<string, PdfObject>()],
    ]);
    // Fill the whole BBox: every pixel must be red, which is only true if the
    // BBox origin was subtracted.
    const img = rasterizeFormRgba(
      doc, { kind: 'stream', dict, raw: enc('1 0 0 rg\n100 100 10 10 re\nf') }, 8, 8);
    expect([...img.data.slice(0, 4)]).toEqual([255, 0, 0, 255]);
    expect([...img.data.slice(-4)]).toEqual([255, 0, 0, 255]);
  });

  it('does not add the scratch page to the document', () => {
    const doc = Document.Open(buildSvgPdf({ mediaBox: [0, 0, 20, 20], content: '' }));
    const before = doc.Pages.length;
    const { dict, content } = redQuadrant();
    rasterizeFormRgba(doc, { kind: 'stream', dict, raw: enc(content) }, 4, 4);
    expect(doc.Pages.length).toBe(before);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/svg-filter-render.test.ts`
Expected: FAIL — `rasterizeFormRgba` is not exported from `raster.ts`.

- [ ] **Step 3: Write the implementation**

Append to `src/raster.ts`, after `renderPageToPng`. Add `Page` to the value imports at the top (it is currently `import type`):

```ts
import { Page } from './page.js';
```

```ts
/** Rasterize one Form XObject to straight-alpha sRGB RGBA, top-down, mapping
 *  its /BBox onto exactly devW x devH pixels. Unpainted area is transparent.
 *
 *  Exists for svgembed.ts's SvgRasterSink: an SVG <filter> has no PDF
 *  equivalent, so the filtered subtree is flattened to pixels and the primitive
 *  graph runs over them. Driven over a SCRATCH page -- never added to the page
 *  tree, so Save's mark-sweep drops it and the form with it.
 *
 *  Never throws: whatever composited before a failure still comes back, which
 *  is renderPageToPng's contract too. */
export function rasterizeFormRgba(
  doc: Document, form: PdfStream, devW: number, devH: number,
): ImageRgba {
  const w = Math.max(1, Math.floor(devW)), h = Math.max(1, Math.floor(devH));
  const bb = arrNums(doc.resolve(form.dict.get('BBox'))) ?? [0, 0, 1, 1];
  const bx = Math.min(bb[0], bb[2]), by = Math.min(bb[1], bb[3]);
  const bw = Math.abs(bb[2] - bb[0]) || 1, bh = Math.abs(bb[3] - bb[1]) || 1;
  const sx = w / bw, sy = h / bh;

  // The scratch page is the form's BBox scaled to the raster: MediaBox
  // [0,0,w,h] means baseMatrix's flip is the only y handling needed, and the
  // `cm` below is a pure scale-and-shift in PDF's own y-up space.
  const fref = doc.allocObject(form);
  const res: PdfDict = new Map<string, PdfObject>([
    ['XObject', new Map<string, PdfObject>([['Fm0', fref]])],
  ]);
  const content = `${sx} 0 0 ${sy} ${-bx * sx} ${-by * sy} cm\n/Fm0 Do`;
  const pageDict: PdfDict = new Map<string, PdfObject>([
    ['Type', name('Page')],
    ['MediaBox', [0, 0, w, h]],
    ['Resources', res],
    ['Contents', doc.allocObject({ kind: 'stream', dict: new Map(), raw: enc(content) })],
  ]);
  const page = new Page(doc, pageDict, 1);

  const canvas = new Canvas(w, h, false);
  try {
    interpret(doc, page, baseMatrix(page, 'media').matrix, new RasterSink(doc, canvas));
  } catch {
    // Degrade: whatever composited before the failure still comes back.
  }

  const out = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h * 4; i++) {
    const v = canvas.data[i];
    out[i] = Math.round((v < 0 ? 0 : v > 1 ? 1 : v) * 255);
  }
  return { w, h, data: out };
}
```

`enc` must be imported in `raster.ts`; add it if it is not already there:

```ts
import { enc } from './serialize.js';
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/svg-filter-render.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck and run the whole suite**

Run: `npm run typecheck && npm test`
Expected: both green. `raster.ts` gained an export and changed nothing existing.

---

## Task 6: The `feFlood` and `feOffset` kernels, and the runner

Two kernels and the graph evaluator, so the seam in Task 7 has something to call.

**Files:**
- Modify: `src/svgfilterfx.ts`
- Modify: `src/svgfilter.ts` (add both names to `SUPPORTED`)
- Test: `test/svg-filterfx.test.ts` (append)

**Interfaces:**
- Consumes: `FilterSpec`, `FilterPrim`, `primLength` from `src/svgfilter.js`; `parseColor` from `src/svgstyle.js`.
- Produces: `runFilter(spec, source, scale): Surface` from `src/svgfilterfx.ts`.

- [ ] **Step 1: Write the failing test**

Append to `test/svg-filterfx.test.ts`:

```ts
import { runFilter } from '../src/svgfilterfx.js';       // add to the existing import
import { resolveFilter, type FilterSpec } from '../src/svgfilter.js';
import { parseXml, type XmlNode } from '../src/xml.js';

const xml = (s: string) => new TextEncoder().encode(s);
const VP = { minX: 0, minY: 0, w: 100, h: 100 };
/** A 10x10 user-unit box at the origin, so 1 user unit = 1 pixel at scale 1. */
const BOX10 = { x: 0, y: 0, w: 10, h: 10 };

/** Resolve a <filter> whose region is exactly the 10x10 box. */
function specOf(prims: string): FilterSpec {
  const root = parseXml(xml(
    '<svg><filter id="f" filterUnits="userSpaceOnUse" x="0" y="0" ' +
    `width="10" height="10">${prims}</filter></svg>`));
  let f: XmlNode | undefined;
  const walk = (n: XmlNode): void => {
    if (n.name === 'filter') f ??= n;
    for (const c of n.children) walk(c);
  };
  walk(root);
  const r = resolveFilter(f!, BOX10, VP);
  if (r.kind !== 'draw') throw new Error(`expected draw, got ${r.kind}`);
  return r.spec;
}

/** A 10x10 source: opaque white in the top-left 2x2, transparent elsewhere. */
function source(): ReturnType<typeof makeSurface> {
  const s = makeSurface(0, 0, 10, 10);
  for (let y = 0; y < 2; y++) for (let x = 0; x < 2; x++) {
    const i = (y * 10 + x) * 4;
    s.data[i] = 1; s.data[i + 1] = 1; s.data[i + 2] = 1; s.data[i + 3] = 1;
  }
  return s;
}

const px = (s: { w: number; data: Float32Array }, x: number, y: number): number[] =>
  [...s.data.slice((y * s.w + x) * 4, (y * s.w + x) * 4 + 4)];

describe('runFilter — feOffset', () => {
  it('shifts by dx/dy in user units scaled to pixels', () => {
    const out = runFilter(specOf('<feOffset dx="3" dy="4"/>'), source(), 1);
    near(px(out, 3, 4)[3], 1);
    near(px(out, 0, 0)[3], 0);
  });

  it('scales the shift with the raster scale', () => {
    const out = runFilter(specOf('<feOffset dx="3" dy="0"/>'), source(), 1);
    const out2 = runFilter(
      specOf('<feOffset dx="3" dy="0"/>'),
      // A 20x20 raster of the same 10x10 region: the 2x2 block is now 4x4.
      (() => { const s = makeSurface(0, 0, 20, 20);
               for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++)
                 s.data.set([1, 1, 1, 1], (y * 20 + x) * 4);
               return s; })(), 2);
    near(px(out, 3, 0)[3], 1);
    near(px(out2, 6, 0)[3], 1);          // 3 user units at 2 px/unit
  });

  it('drops pixels shifted outside the region', () => {
    const out = runFilter(specOf('<feOffset dx="-5" dy="0"/>'), source(), 1);
    for (let y = 0; y < 10; y++) for (let x = 0; x < 10; x++) near(px(out, x, y)[3], 0);
  });

  it('defaults dx and dy to zero', () => {
    const out = runFilter(specOf('<feOffset/>'), source(), 1);
    near(px(out, 0, 0)[3], 1);
  });
});

describe('runFilter — feFlood', () => {
  it('fills the subregion with flood-color at flood-opacity', () => {
    const out = runFilter(
      specOf('<feFlood flood-color="#ff0000" flood-opacity="0.5"/>'), source(), 1);
    const p = px(out, 5, 5);
    near(p[3], 0.5, 5);
    near(p[0], 1 * 0.5, 5);              // linear red 1.0, premultiplied
    near(p[1], 0, 5);
  });

  it('fills ONLY its subregion', () => {
    const out = runFilter(
      specOf('<feFlood flood-color="#ff0000" x="0" y="0" width="4" height="4"/>'),
      source(), 1);
    near(px(out, 2, 2)[3], 1);
    near(px(out, 6, 6)[3], 0);
  });

  it('defaults to opaque black', () => {
    const out = runFilter(specOf('<feFlood/>'), source(), 1);
    expect(px(out, 5, 5)).toEqual([0, 0, 0, 1]);
  });

  it('converts the flood colour into the working space', () => {
    // sRGB 0.5 gray floods to LINEAR 0.214 under the default linearRGB.
    const out = runFilter(specOf('<feFlood flood-color="#808080"/>'), source(), 1);
    near(px(out, 5, 5)[0], srgbToLinear(128 / 255), 3);
  });

  it('leaves a sRGB primitive in sRGB while it runs, and hands back linear', () => {
    // The pipeline's contract: runFilter always RETURNS linear, whatever any
    // individual primitive asked to work in.
    const out = runFilter(
      specOf('<feFlood flood-color="#808080" color-interpolation-filters="sRGB"/>'),
      source(), 1);
    near(px(out, 5, 5)[0], srgbToLinear(128 / 255), 3);
  });
});

describe('runFilter — graph', () => {
  it('returns the LAST primitive\'s result', () => {
    const out = runFilter(
      specOf('<feFlood flood-color="#ff0000"/><feOffset in="SourceGraphic" dx="1"/>'),
      source(), 1);
    near(px(out, 1, 0)[3], 1);
    near(px(out, 5, 5)[3], 0);           // the flood is not the result
  });

  it('feeds SourceAlpha as black at the source alpha', () => {
    const out = runFilter(specOf('<feOffset in="SourceAlpha" dx="0"/>'), source(), 1);
    expect(px(out, 0, 0)).toEqual([0, 0, 0, 1]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/svg-filterfx.test.ts`
Expected: FAIL — `runFilter` is not exported, and `resolveFilter` rejects `feFlood`/`feOffset`... it does not: both are already in `SUPPORTED` from Task 1.

- [ ] **Step 3: Write the implementation**

Append to `src/svgfilterfx.ts`:

```ts
import { parseColor } from './svgstyle.js';
import { primLength, type FilterPrim, type FilterSpec } from './svgfilter.js';

/** Copy `src` into a fresh surface of `dst` extent, clipped. The universal
 *  "place this result in its subregion" step: every kernel produces pixels over
 *  some window and every result is stored over its subregion. */
function place(src: Surface, dst: Surface): void {
  for (let y = 0; y < src.h; y++) {
    const dy = y + src.y - dst.y;
    if (dy < 0 || dy >= dst.h) continue;
    for (let x = 0; x < src.w; x++) {
      const dx = x + src.x - dst.x;
      if (dx < 0 || dx >= dst.w) continue;
      const si = (y * src.w + x) * 4, di = (dy * dst.w + dx) * 4;
      dst.data[di] = src.data[si];
      dst.data[di + 1] = src.data[si + 1];
      dst.data[di + 2] = src.data[si + 2];
      dst.data[di + 3] = src.data[si + 3];
    }
  }
}

/** Black at the source's alpha. Premultiplied, so the colour channels are 0. */
function sourceAlpha(s: Surface): Surface {
  const out = makeSurface(s.x, s.y, s.w, s.h);
  for (let p = 0; p < s.w * s.h; p++) out.data[p * 4 + 3] = s.data[p * 4 + 3];
  return out;
}

function offsetKernel(input: Surface, dx: number, dy: number): Surface {
  const out = makeSurface(input.x, input.y, input.w, input.h);
  const ox = Math.round(dx), oy = Math.round(dy);
  for (let y = 0; y < input.h; y++) {
    const ty = y + oy;
    if (ty < 0 || ty >= out.h) continue;
    for (let x = 0; x < input.w; x++) {
      const tx = x + ox;
      if (tx < 0 || tx >= out.w) continue;
      const si = (y * input.w + x) * 4, di = (ty * out.w + tx) * 4;
      out.data[di] = input.data[si];
      out.data[di + 1] = input.data[si + 1];
      out.data[di + 2] = input.data[si + 2];
      out.data[di + 3] = input.data[si + 3];
    }
  }
  return out;
}

/** flood-color x flood-opacity, in the primitive's own working space. */
function floodKernel(p: FilterPrim, w: number, h: number, x: number, y: number): Surface {
  const out = makeSurface(x, y, w, h);
  const c = parseColor(p.attrs.get('flood-color') ?? 'black');
  if (c === null || c === undefined) return out;     // 'none' floods nothing
  const oRaw = parseFloat(p.attrs.get('flood-opacity') ?? '1');
  const a = clamp01(Number.isFinite(oRaw) ? oRaw : 1);
  // parseColor yields 0..255 sRGB. The surface is in the primitive's working
  // space, which runFilter converts out of afterwards.
  const conv = p.space === 'sRGB' ? (v: number) => v : srgbToLinear;
  const r = conv(c[0] / 255) * a, g = conv(c[1] / 255) * a, b = conv(c[2] / 255) * a;
  for (let i = 0; i < w * h; i++) out.data.set([r, g, b, a], i * 4);
  return out;
}

/** Evaluate the primitive graph over a rasterized source.
 *
 *  `scale` is device pixels per user unit: every length-valued parameter
 *  arrives in user units and is multiplied by it here, so a kernel never sees
 *  a user unit and the region raster's resolution never leaks into one.
 *
 *  Always RETURNS premultiplied linear RGBA over the whole filter region,
 *  whatever colour space individual primitives asked to work in. */
export function runFilter(spec: FilterSpec, source: Surface, scale: number): Surface {
  const W = source.w, H = source.h;
  const results = new Map<string, Surface>();
  results.set('SourceGraphic', source);
  results.set('SourceAlpha', sourceAlpha(source));

  /** A subregion in user space -> the pixel window inside the region raster. */
  const window = (sub: SegBBox): { x: number; y: number; w: number; h: number } => {
    const x = Math.round((sub.x - spec.region.x) * scale);
    const y = Math.round((sub.y - spec.region.y) * scale);
    return {
      x, y,
      w: Math.min(W - x, Math.round(sub.w * scale)),
      h: Math.min(H - y, Math.round(sub.h * scale)),
    };
  };

  let last: Surface = source;
  for (const p of spec.prims) {
    const inSpace = (key: string): Surface => {
      const s = results.get(key) ?? makeSurface(0, 0, W, H);
      return p.space === 'sRGB' ? convertSpace(s, 'sRGB') : s;
    };
    const win = window(p.sub);
    let raw: Surface;
    switch (p.name) {
      case 'feOffset': {
        raw = offsetKernel(
          inSpace(p.in1),
          primLength(spec, p.attrs.get('dx'), 0, 'x') * scale,
          primLength(spec, p.attrs.get('dy'), 0, 'y') * scale);
        break;
      }
      case 'feFlood':
        raw = floodKernel(p, win.w, win.h, win.x, win.y);
        break;
      default:
        // Unreachable: SUPPORTED in svgfilter.ts is this switch's cases, and a
        // chain with anything else never reaches a runner.
        raw = inSpace(p.in1);
    }
    // Clip the result to the primitive's subregion, then bring it back to the
    // pipeline's linear space: a following primitive may ask for either, and
    // storing everything in one space is what keeps the graph composable.
    const clipped = makeSurface(0, 0, W, H);
    place({ ...raw, x: Math.max(raw.x, win.x), y: Math.max(raw.y, win.y) }, clipped);
    maskTo(clipped, win);
    last = p.space === 'sRGB' ? convertSpace(clipped, 'linearRGB') : clipped;
    results.set(p.result, last);
  }
  return last;
}

/** Zero everything outside `win`. A primitive may not paint outside its
 *  subregion (SVG 1.1 §15.7.5), and a kernel that works over the whole raster
 *  (a blur, an offset) would otherwise leak past it. */
function maskTo(s: Surface, win: { x: number; y: number; w: number; h: number }): void {
  for (let y = 0; y < s.h; y++) {
    const inRow = y >= win.y && y < win.y + win.h;
    for (let x = 0; x < s.w; x++) {
      if (inRow && x >= win.x && x < win.x + win.w) continue;
      s.data.fill(0, (y * s.w + x) * 4, (y * s.w + x) * 4 + 4);
    }
  }
}
```

Add the `SegBBox` type import at the top of `svgfilterfx.ts`:

```ts
import type { SegBBox } from './svgpath.js';
```

`SUPPORTED` in `svgfilter.ts` already holds exactly `feFlood` and `feOffset`, which is now true of the switch above — the invariant holds with no edit.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/svg-filterfx.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: no output, exit 0.

---

## Task 7: The seam — `SvgRasterSink`, `deviceScale`, and the walker wiring

The only task that touches `svgdraw.ts` and `svgembed.ts`. After it, a `<filter>` renders.

**Files:**
- Modify: `src/svgdraw.ts`
- Modify: `src/svgembed.ts`
- Test: `test/svg-filter-render.test.ts` (append)

**Interfaces:**
- Consumes: `resolveFilter` from `src/svgfilter.js`; `runFilter`, `toSurface`, `surfaceImage` from `src/svgfilterfx.js`; `rasterizeFormRgba` from `src/raster.js`; `ctmScale` from `src/strokegeom.js`; `subtreeBBox`, `shapeSegs` from `src/svgpath.js`.
- Produces: `SvgRasterSink`, `SvgDrawOptions`, `DrawResult.rasterized`, `AddSVGOptions.filterScale`, `AddSVGResult.rasterized`.

- [ ] **Step 1: Write the failing test**

Append to `test/svg-filter-render.test.ts`:

```ts
import { decodePng, type DecodedPng } from './helpers/decode-png.js';
import { isDict, isName, isStream } from '../src/types.js';

const svg = (s: string) => new TextEncoder().encode(s);

/** Place `src` over a 200x200 page at 1 px per point. */
function render(src: string, opts: Record<string, unknown> = {}) {
  const p = Document.Open(buildSvgPdf({ mediaBox: [0, 0, 200, 200], content: '' })).Pages[0];
  const r = p.AddSVGObject(svg(src), [0, 0, 200, 200], { fit: 'fill', ...opts });
  const rt = Document.Open(p.Document.Save());
  return { png: decodePng(rt.Pages[0].ToImage()), result: r, doc: rt };
}

const isRed = (png: DecodedPng, x: number, y: number): boolean => {
  const [r, g, b] = png.at(x, y);
  return r > 200 && g < 80 && b < 80;
};
const isWhite = (png: DecodedPng, x: number, y: number): boolean => {
  const [r, g, b] = png.at(x, y);
  return r > 240 && g > 240 && b > 240;
};

/** A red square shifted 50 user units right and down by an feOffset. */
const SHIFT =
  '<svg viewBox="0 0 200 200"><defs>' +
  '<filter id="f" filterUnits="userSpaceOnUse" x="0" y="0" width="200" height="200">' +
  '<feOffset dx="50" dy="50"/></filter></defs>' +
  '<rect x="0" y="0" width="50" height="50" fill="#ff0000" filter="url(#f)"/></svg>';

describe('AddSVGObject — filters through Save/Open/ToImage', () => {
  it('draws the filtered result, not the source', () => {
    const { png, result } = render(SHIFT);
    expect(result.skipped).toEqual([]);
    expect(result.rasterized).toEqual(['filter']);
    expect(isRed(png, 75, 75)).toBe(true);      // where the offset put it
    expect(isWhite(png, 25, 25)).toBe(true);    // where the source was
  });

  it('emits the result as an image with an /SMask, not as vector ink', () => {
    const { doc } = render(SHIFT);
    // Walk the page's XObjects for an Image carrying an /SMask.
    const found: boolean[] = [];
    const scan = (res: unknown): void => {
      if (!isDict(res)) return;
      const xo = doc.resolve(res.get('XObject'));
      if (!isDict(xo)) return;
      for (const v of xo.values()) {
        const s = doc.resolve(v);
        if (!isStream(s)) continue;
        const st = s.dict.get('Subtype');
        if (isName(st) && st.name === 'Image') found.push(s.dict.has('SMask'));
        else if (isName(st) && st.name === 'Form') scan(doc.resolve(s.dict.get('Resources')));
      }
    };
    scan(doc.Pages[0].Resources);
    expect(found).toContain(true);
  });

  it('scales the raster with filterScale', () => {
    const small = render(SHIFT, { filterScale: 1 });
    const big = render(SHIFT, { filterScale: 4 });
    const widthOf = (d: Document): number => {
      let w = 0;
      const scan = (res: unknown): void => {
        if (!isDict(res)) return;
        const xo = d.resolve(res.get('XObject'));
        if (!isDict(xo)) return;
        for (const v of xo.values()) {
          const s = d.resolve(v);
          if (!isStream(s)) continue;
          const st = s.dict.get('Subtype');
          if (isName(st) && st.name === 'Image') {
            const n = s.dict.get('Width');
            if (typeof n === 'number') w = Math.max(w, n);
          } else if (isName(st) && st.name === 'Form') scan(d.resolve(s.dict.get('Resources')));
        }
      };
      scan(d.Pages[0].Resources);
      return w;
    };
    expect(widthOf(big.doc)).toBeGreaterThan(widthOf(small.doc) * 3);
  });

  it('rejects a bad filterScale before allocating anything', () => {
    const p = Document.Open(buildSvgPdf({ mediaBox: [0, 0, 200, 200], content: '' })).Pages[0];
    const before = p.Document.Save().length;
    expect(() => p.AddSVGObject(svg(SHIFT), [0, 0, 200, 200], { filterScale: 0 }))
      .toThrow(TypeError);
    expect(() => p.AddSVGObject(svg(SHIFT), [0, 0, 200, 200], { filterScale: 99 }))
      .toThrow(TypeError);
    expect(p.Document.Save().length).toBe(before);
  });

  it('draws unfiltered and reports an unsupported primitive', () => {
    const { png, result } = render(SHIFT.replace('<feOffset dx="50" dy="50"/>',
                                                 '<feTurbulence/>'));
    expect(result.skipped).toEqual(['feTurbulence']);
    expect(result.rasterized).toEqual([]);
    expect(isRed(png, 25, 25)).toBe(true);      // the source, unfiltered
  });

  it('draws unfiltered and reports an unresolvable filter reference', () => {
    const { png, result } = render(
      '<svg viewBox="0 0 200 200">' +
      '<rect width="50" height="50" fill="#ff0000" filter="url(#nope)"/></svg>');
    expect(result.skipped).toEqual(['url()']);
    expect(isRed(png, 25, 25)).toBe(true);
  });

  it('renders nothing, and reports nothing, for a zero-area filter region', () => {
    const { png, result } = render(SHIFT.replace('width="200"', 'width="0"'));
    expect(result.skipped).toEqual([]);
    expect(isWhite(png, 25, 25)).toBe(true);
    expect(isWhite(png, 75, 75)).toBe(true);
  });

  it('applies a clip-path to the FILTERED result, not to the source', () => {
    // SVG's order is filter -> clip -> mask -> opacity. A clip covering only
    // the shifted half proves the clip ran after the offset.
    const { png } = render(
      '<svg viewBox="0 0 200 200"><defs>' +
      '<filter id="f" filterUnits="userSpaceOnUse" x="0" y="0" width="200" height="200">' +
      '<feOffset dx="50" dy="50"/></filter>' +
      '<clipPath id="c"><rect x="50" y="50" width="150" height="150"/></clipPath>' +
      '</defs><rect width="50" height="50" fill="#ff0000" ' +
      'filter="url(#f)" clip-path="url(#c)"/></svg>');
    expect(isRed(png, 75, 75)).toBe(true);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/svg-filter-render.test.ts`
Expected: FAIL — `rasterized` is not on the result, and `filter` lands in `skipped` as an unknown property.

- [ ] **Step 3: Implement the sink and options in `svgdraw.ts`**

Add the imports:

```ts
import { resolveFilter } from './svgfilter.js';
import { runFilter, toSurface, surfaceImage } from './svgfilterfx.js';
import { ctmScale } from './strokegeom.js';
import type { ImageRgba } from './raster.js';
```

Add the sink interface next to `SvgImageSink`:

```ts
/** Rasterize a Form XObject to RGBA. svgembed.ts implements it, because only it
 *  may allocate; mirrors SvgStreamSink and SvgImageSink, for the same reason.
 *
 *  Returns raster.ts's ImageRgba -- straight-alpha sRGB bytes -- NOT a Surface.
 *  The sink stays in the rasterizer's vocabulary; converting to premultiplied
 *  linear Float32 is the filter pipeline's job, and belongs on the pure side of
 *  the seam where it is testable without a Document.
 *
 *  The form's /BBox defines what is rendered: it maps onto exactly devW x devH
 *  pixels, so the sink makes no resolution policy of its own. */
export interface SvgRasterSink {
  rasterize(dict: PdfDict, content: string, devW: number, devH: number): ImageRgba | null;
}

/** The placement-dependent knobs. Everything here is absent in a pure unit
 *  test, where a filter simply reports rather than rasterizing. */
export interface SvgDrawOptions {
  /** Points per user unit at the placement. Default 1. */
  deviceScale?: number;
  /** Resolution multiplier for a rasterized filter. Default 2. */
  filterScale?: number;
  raster?: SvgRasterSink;
}
```

Extend `DrawResult`:

```ts
export interface DrawResult {
  content: string;
  resources: PdfDict;
  skipped: string[];
  /** Distinct element names whose subtree was flattened to a bitmap, sorted.
   *  Not a fidelity loss like `skipped` -- the content renders correctly -- but
   *  it is resolution-bound, and its text is no longer extractable. */
  rasterized: string[];
}
```

Add to `Emitter`, next to `masks`:

```ts
  /** Element names flattened to a bitmap. Shared with every child, like
   *  `skipped`: a rasterization inside a tile is still one. */
  rasterized = new Set<string>();
  /** Supplied by svgembed.ts when a filter can be rasterized at all. */
  raster?: SvgRasterSink;
  /** Points per user unit at the placement, times the filter resolution
   *  multiplier. Only the filter path reads it. */
  filterPx = 2;
  /** Filter ids currently being expanded, to break reference cycles — a filter
   *  whose own subtree carries the same filter. Mirrors activeMasks. */
  activeFilters = new Set<string>();
```

and share them in `child()`:

```ts
    c.rasterized = this.rasterized;
    c.raster = this.raster;
    c.filterPx = this.filterPx;
    c.activeFilters = this.activeFilters;
```

Add `'filter'` to `DEFINITION`:

```ts
const DEFINITION = new Set([
  'clipPath', 'linearGradient', 'radialGradient', 'pattern', 'mask', 'marker', 'filter',
]);
```

Thread the options through `drawSvg`:

```ts
export function drawSvg(
  root: XmlNode, viewport: ViewBox, provider: SvgFontProvider,
  streams: SvgStreamSink, images: SvgImageSink, opts: SvgDrawOptions = {},
): DrawResult {
  const e = new Emitter();
  e.viewport = viewport;
  e.fonts = provider;
  e.streams = streams;
  e.imageSink = images;
  e.raster = opts.raster;
  e.filterPx = (opts.deviceScale ?? 1) * (opts.filterScale ?? 2);
  indexIds(root, e.ids);
  if (applyStylesheet(e, root)) e.skipped.add('style');
  walk(e, root, INITIAL, false, [...IDENTITY]);
  return {
    content: e.out.join('\n'),
    resources: buildResources(e),
    skipped: [...e.skipped].sort(),
    rasterized: [...e.rasterized].sort(),
  };
}
```

`__ctmProbe` needs no change — it never sets `raster`, so a filter there reports and draws unfiltered.

- [ ] **Step 4: Implement the filter emission in `svgdraw.ts`**

Add above `walk`:

```ts
/** The largest raster a single filter may allocate, in pixels. filterScale is
 *  capped at 8, but the filter REGION is author-controlled and unbounded, so
 *  the cap has to be on the product. At 4 bytes per pixel per Surface and a
 *  handful of live surfaces, 16 Mpx is already ~250 MB of Float32. */
const MAX_FILTER_PX = 16_000_000;

/** Rasterize `body`'s subtree over the filter region, run the graph, and emit
 *  the result as an image. Returns false when it could not be done, in which
 *  case the caller paints the element unfiltered.
 *
 *  The image is drawn where `paintInto` would have painted, INSIDE the
 *  element's own `cm` and inside any clip/mask wrapper — which is exactly SVG's
 *  order: filter, then clip-path, then mask, then opacity. */
function emitFiltered(
  e: Emitter, spec: FilterSpec, scale: number, body: (sub: Emitter) => void,
): boolean {
  if (!e.raster) return false;
  const region = spec.region;

  let px = scale;
  let devW = Math.max(1, Math.round(region.w * px));
  let devH = Math.max(1, Math.round(region.h * px));
  if (spec.res) { devW = Math.min(devW, spec.res[0]); devH = Math.min(devH, spec.res[1]); }
  if (devW * devH > MAX_FILTER_PX) {
    const k = Math.sqrt(MAX_FILTER_PX / (devW * devH));
    devW = Math.max(1, Math.floor(devW * k));
    devH = Math.max(1, Math.floor(devH * k));
  }
  // The scale the KERNELS see: what the raster actually came out at, not what
  // was asked for. A capped raster whose kernels still use the requested scale
  // blurs and offsets by the wrong number of pixels.
  px = devW / region.w;

  const g = e.child();
  body(g);
  if (g.out.length === 0) return false;
  const formDict: PdfDict = new Map<string, PdfObject>([
    ['Type', name('XObject')],
    ['Subtype', name('Form')],
    ['FormType', 1],
    ['BBox', [region.x, region.y, region.x + region.w, region.y + region.h]],
    ['Matrix', [...IDENTITY]],
    ['Group', new Map<string, PdfObject>([
      ['Type', name('Group')], ['S', name('Transparency')],
    ])],
    ['Resources', buildResources(g)],
  ]);
  const img = e.raster.rasterize(formDict, g.out.join('\n'), devW, devH);
  if (img === null) return false;

  const out = runFilter(spec, toSurface(img), px);
  const ref = e.imageSink.image(surfaceImage(out));
  const key = e.xobjKey(ref);
  // A PDF image fills the unit square with its first row at v = 1, and this
  // space is y-DOWN, so the local -h is the flip that cancels the one in
  // placementMatrix. Mirrors svgimage.ts's imagePlacement.
  e.out.push('q');
  e.out.push(`${num(region.w)} 0 0 ${num(-region.h)} ${num(region.x)} ${num(region.y + region.h)} cm`);
  e.out.push(`/${key} Do`);
  e.out.push('Q');
  return true;
}
```

In `walk`, after the `paintInto` definition and **before** the mask block, add:

```ts
  // SVG's order is filter -> clip-path -> mask -> opacity. The filter replaces
  // the subtree with an image, so it is innermost here: `clipped` and the mask
  // wrapper below already surround whatever paintInto emits.
  let painted = paintInto;
  const filterAttr = styleGetter(n.attrs, e.css.get(n))('filter');
  if (filterAttr !== undefined && filterAttr.trim() !== 'none'
      && !inDefs && !DEFINITION.has(n.name)) {
    const fid = urlRef(filterAttr);
    const fnode = fid !== undefined ? e.ids.get(fid) : undefined;
    if (!fnode || fnode.name !== 'filter') {
      // A missing target, or a CSS filter function like blur(2px), which this
      // stack does not parse. Either way the element draws unfiltered.
      e.skipped.add('url()');
    } else if (fid !== undefined && e.activeFilters.has(fid)) {
      e.skipped.add('filter');          // reference cycle
    } else {
      const { box, complete } = subtreeBBox(n, e.ids, textMeasure(e, paint));
      const r = complete
        ? resolveFilter(fnode, box, e.viewport, e.css.get(fnode))
        : { kind: 'skip' as const, report: ['filter'] };
      if (r.kind === 'empty') {
        painted = () => { /* SVG 1.1 15.7.2: the element renders nothing. */ };
      } else if (r.kind === 'skip') {
        for (const s of r.report) e.skipped.add(s);
      } else {
        const scale = e.filterPx * ctmScale(here);
        const inner = paintInto;
        painted = (t: Emitter): void => {
          if (fid !== undefined) t.activeFilters.add(fid);
          const ok = emitFiltered(t, r.spec, scale, inner);
          if (fid !== undefined) t.activeFilters.delete(fid);
          if (ok) t.rasterized.add('filter');
          else { t.skipped.add('filter'); inner(t); }
        };
      }
    }
  }
```

Then replace the two `paintInto` call sites at the bottom of `walk` with `painted`:

```ts
  if (group && spec) {
    const body = groupForm(e, spec.region, painted);
    …
  } else {
    painted(e);
  }
```

Add the `FilterSpec` type import:

```ts
import { resolveFilter, type FilterSpec } from './svgfilter.js';
```

- [ ] **Step 5: Implement the sink and options in `svgembed.ts`**

Add the imports:

```ts
import { drawSvg, type SvgImageSink, type SvgRasterSink, type SvgStreamSink } from './svgdraw.js';
import { rasterizeFormRgba } from './raster.js';
```

Add to `AddSVGOptions`:

```ts
  /** Resolution multiplier for a rasterized <filter>: a multiple of the placed
   *  device size. Default 2 (~144 DPI at 1:1 placement). Capped at 8, so a typo
   *  cannot ask for gigabytes of pixels. */
  filterScale?: number;
```

Add to `AddSVGResult`:

```ts
  /** Distinct element names whose subtree was flattened to a bitmap, sorted.
   *  Not a fidelity loss like `skipped` — the content renders correctly — but
   *  it is resolution-bound, and its text is no longer extractable. */
  rasterized: string[];
```

Add the sink:

```ts
/** Rasterizes the filtered subtree. Only this module may allocate the scratch
 *  objects raster.ts needs, which is why <filter> reaches the walker as a sink.
 *  Never throws: a failure makes the element draw unfiltered and report. */
function rasterSink(doc: Document): SvgRasterSink {
  return {
    rasterize: (dict, content, devW, devH) => {
      try {
        return rasterizeFormRgba(doc, { kind: 'stream', dict, raw: enc(content) }, devW, devH);
      } catch {
        return null;
      }
    },
  };
}
```

Validate the option in `addSvgObject`, next to the `fit` check:

```ts
  const filterScale = opts.filterScale;
  if (filterScale !== undefined
      && (!Number.isFinite(filterScale) || filterScale <= 0 || filterScale > 8))
    throw new TypeError('filterScale must be a finite number in (0, 8]');
```

and pass the options through, after `placementMatrix` is available. `placementMatrix` currently runs *after* `drawSvg`; move its computation above the `drawSvg` call so `deviceScale` can be derived from it — it depends only on `vb`, `rect` and the root attributes, none of which `drawSvg` touches:

```ts
  const m = placementMatrix(vb, rect, root.attrs.get('preserveAspectRatio'), fit);
  const { content, resources, skipped, rasterized } = drawSvg(
    root, vb, provider, streamSink(doc), imageSink(doc),
    { deviceScale: ctmScale(m), filterScale, raster: rasterSink(doc) });
```

with `import { ctmScale } from './strokegeom.js';` added, and the later `const m = …` line deleted.

Finally, return it:

```ts
  return { skipped, rasterized };
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx vitest run test/svg-filter-render.test.ts`
Expected: PASS.

- [ ] **Step 7: Run the whole suite and typecheck**

Run: `npm run typecheck && npm test`
Expected: both green. `AddSVGResult` gained a field, which is additive; the four existing `drawSvg` callers in `test/` pass no options and keep working.

If `test/svg-golden.test.ts` reports a diff, inspect it: no fixture in that suite uses `filter`, so any change there means the walker's non-filter path moved and must be reverted.

- [ ] **Step 8: Prove the assertions are load-bearing**

Break each, confirm red, revert:

1. In `emitFiltered`, emit `+region.h` instead of `-region.h` in the `cm` → the offset test's red pixel moves; "draws the filtered result" must fail.
2. In `emitFiltered`, use the requested `scale` rather than `devW / region.w` for `runFilter` → set `MAX_FILTER_PX` to `1000` temporarily; the offset lands in the wrong place.
3. In `walk`, apply the filter *outside* the clip wrapper → "applies a clip-path to the FILTERED result" must fail.
4. Return `spec.region` from `resolveFilter` with `w: 0` → "renders nothing, and reports nothing" must still pass, and "draws the filtered result" must fail.

- [ ] **Step 9: Commit**

```bash
git add src/svgdraw.ts src/svgembed.ts src/svgfilter.ts src/svgfilterfx.ts \
        src/raster.ts src/imageembed.ts test/svg-filterfx.test.ts test/svg-filter-render.test.ts
git commit -m "$(cat <<'EOF'
feat(svg): rasterize a filtered subtree and run the primitive graph

The seam an SVG <filter> needs: raster.ts gains rasterizeFormRgba (a form's
/BBox onto exactly devW x devH pixels, over a scratch page that Save's
mark-sweep drops), svgdraw.ts gains the SvgRasterSink that reaches it and a
deviceScale scalar for sizing, and svgfilterfx.ts owns the pixels -- Surface,
the premultiplied sRGB<->linear edges, and the graph runner.

Carrying feFlood and feOffset only: SUPPORTED must equal the kernel table.

Public: filterScale (default 2, cap 8, validated before any allocation) and
rasterized[] on AddSVGResult -- filters render correctly but are
resolution-bound and their text stops being extractable, which is not the same
thing as skipped and should not be reported as one.

Refs: aspose-pdf-foss-for-ts-1gg0.10.3

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---
---

# Commit C — the kernels

Nine more primitives. Each is a pure function added to `svgfilterfx.ts`'s switch plus a name in `svgfilter.ts`'s `SUPPORTED`, in the same commit — the invariant from Commit A.

Each task follows the same shape, so it is written out once here and referenced by each: **Step 1** append tests to `test/svg-filterfx.test.ts`; **Step 2** run `npx vitest run test/svg-filterfx.test.ts`, expect FAIL; **Step 3** add the kernel and its `switch` case, and add the name to `SUPPORTED`; **Step 4** re-run, expect PASS; **Step 5** `npm run typecheck`.

The helpers `specOf`, `source`, `px` and `near` are already in the test file from Task 6.

---

## Task 8: `feMerge`

**Files:** modify `src/svgfilterfx.ts`, `src/svgfilter.ts`; test `test/svg-filterfx.test.ts`.

**Interfaces:** consumes `FilterPrim.node.children`; produces no new export.

- [ ] **Step 1: Tests**

```ts
describe('runFilter — feMerge', () => {
  it('stacks its nodes bottom-first', () => {
    const out = runFilter(specOf(
      '<feFlood flood-color="#ff0000" result="r"/>' +
      '<feFlood flood-color="#0000ff" x="0" y="0" width="4" height="4" result="b"/>' +
      '<feMerge><feMergeNode in="r"/><feMergeNode in="b"/></feMerge>'), source(), 1);
    // Blue is listed second, so it is on top inside its 4x4 subregion.
    near(px(out, 2, 2)[2], 1, 3);
    near(px(out, 2, 2)[0], 0, 3);
    // Outside it, red shows.
    near(px(out, 6, 6)[0], 1, 3);
  });

  it('is source-over, not replacement', () => {
    const out = runFilter(specOf(
      '<feFlood flood-color="#ff0000" result="r"/>' +
      '<feFlood flood-color="#0000ff" flood-opacity="0.5" result="b"/>' +
      '<feMerge><feMergeNode in="r"/><feMergeNode in="b"/></feMerge>'), source(), 1);
    const p = px(out, 5, 5);
    near(p[3], 1, 3);
    near(p[0], 0.5, 3);          // red at 1-0.5
    near(p[2], 0.5, 3);
  });

  it('produces transparent black for an feMerge with no nodes', () => {
    const out = runFilter(specOf('<feMerge/>'), source(), 1);
    expect(px(out, 5, 5)).toEqual([0, 0, 0, 0]);
  });
});
```

- [ ] **Step 2: Run, expect FAIL** (`feMerge` is not in `SUPPORTED`, so `specOf` throws "expected draw, got skip").

- [ ] **Step 3: Implement**

```ts
/** Source-over composite of `src` onto `dst`, in place. Premultiplied, so this
 *  is the plain Porter-Duff form with no division. */
function over(dst: Surface, src: Surface): void {
  for (let p = 0; p < dst.w * dst.h; p++) {
    const sa = src.data[p * 4 + 3], inv = 1 - sa;
    for (let c = 0; c < 4; c++)
      dst.data[p * 4 + c] = src.data[p * 4 + c] + dst.data[p * 4 + c] * inv;
  }
}
```

`switch` case:

```ts
      case 'feMerge': {
        raw = makeSurface(0, 0, W, H);
        for (const c of p.node.children) {
          if (c.name !== 'feMergeNode') continue;
          over(raw, inSpace(c.attrs.get('in') ?? 'SourceGraphic'));
        }
        break;
      }
```

An `feMergeNode` with no `in` takes `SourceGraphic` rather than the previous
result: it is not a primitive and does not participate in the implicit chain.

Add `'feMerge'` to `SUPPORTED`.

- [ ] **Step 4: Run, expect PASS**
- [ ] **Step 5: `npm run typecheck`**

---

## Task 9: `feComposite`

**Files:** modify `src/svgfilterfx.ts`, `src/svgfilter.ts`; test `test/svg-filterfx.test.ts`.

- [ ] **Step 1: Tests**

The Porter-Duff algebra, term by term — an external reference, not a diff against our own output.

```ts
describe('runFilter — feComposite', () => {
  /** Two overlapping opaque floods: A over the left 6 columns, B over the top 6
   *  rows. (2,2) is in both, (8,2) is in B only, (2,8) is in A only, (8,8) in
   *  neither. */
  const AB = (op: string) =>
    '<feFlood flood-color="#ff0000" x="0" y="0" width="6" height="10" result="a"/>' +
    '<feFlood flood-color="#0000ff" x="0" y="0" width="10" height="6" result="b"/>' +
    `<feComposite in="a" in2="b" operator="${op}"/>`;

  it('over: A where A is, B where only B is', () => {
    const out = runFilter(specOf(AB('over')), source(), 1);
    near(px(out, 2, 2)[0], 1, 3);        // A wins in the overlap
    near(px(out, 8, 2)[2], 1, 3);        // B alone
    near(px(out, 2, 8)[0], 1, 3);        // A alone
    near(px(out, 8, 8)[3], 0, 3);
  });

  it('in: A only where B is', () => {
    const out = runFilter(specOf(AB('in')), source(), 1);
    near(px(out, 2, 2)[0], 1, 3);
    near(px(out, 2, 8)[3], 0, 3);        // A without B: gone
    near(px(out, 8, 2)[3], 0, 3);        // B without A: never contributes colour
  });

  it('out: A only where B is not', () => {
    const out = runFilter(specOf(AB('out')), source(), 1);
    near(px(out, 2, 2)[3], 0, 3);
    near(px(out, 2, 8)[0], 1, 3);
  });

  it('atop: A over B, clipped to B', () => {
    const out = runFilter(specOf(AB('atop')), source(), 1);
    near(px(out, 2, 2)[0], 1, 3);        // A in the overlap
    near(px(out, 8, 2)[2], 1, 3);        // B outside A
    near(px(out, 2, 8)[3], 0, 3);        // A outside B: dropped
  });

  it('xor: either but not both', () => {
    const out = runFilter(specOf(AB('xor')), source(), 1);
    near(px(out, 2, 2)[3], 0, 3);
    near(px(out, 2, 8)[0], 1, 3);
    near(px(out, 8, 2)[2], 1, 3);
  });

  it('arithmetic: k1*i1*i2 + k2*i1 + k3*i2 + k4, per channel', () => {
    const out = runFilter(specOf(
      '<feFlood flood-color="#ffffff" flood-opacity="0.5" result="a"/>' +
      '<feFlood flood-color="#ffffff" flood-opacity="0.25" result="b"/>' +
      '<feComposite in="a" in2="b" operator="arithmetic" ' +
      'k1="1" k2="0.5" k3="0.25" k4="0.1"/>'), source(), 1);
    // Alpha: 1*0.5*0.25 + 0.5*0.5 + 0.25*0.25 + 0.1 = 0.125+0.25+0.0625+0.1
    near(px(out, 5, 5)[3], 0.5375, 3);
  });

  it('clamps an arithmetic result into 0..1', () => {
    const out = runFilter(specOf(
      '<feFlood flood-color="#ffffff" result="a"/>' +
      '<feComposite in="a" in2="a" operator="arithmetic" k2="5"/>'), source(), 1);
    near(px(out, 5, 5)[3], 1, 6);
  });

  it('defaults to over', () => {
    const out = runFilter(specOf(AB('bogus')), source(), 1);
    near(px(out, 2, 2)[0], 1, 3);
  });
});
```

- [ ] **Step 2: Run, expect FAIL**

- [ ] **Step 3: Implement**

```ts
/** Porter-Duff, on PREMULTIPLIED values: the coefficient pair is all that
 *  distinguishes the operators, so the algebra is written once. */
const PORTER_DUFF: Record<string, [number, number, number, number]> = {
  // [Fa constant, Fa*ab, Fb constant, Fb*aa]  ->  fa = c0 + c1*ab, fb = c2 + c3*aa
  over: [1, 0, 1, -1],
  in:   [0, 1, 0, 0],
  out:  [1, -1, 0, 0],
  atop: [0, 1, 1, -1],
  xor:  [1, -1, 1, -1],
};

function compositeKernel(a: Surface, b: Surface, p: FilterPrim, W: number, H: number): Surface {
  const out = makeSurface(0, 0, W, H);
  const op = p.attrs.get('operator') ?? 'over';
  if (op === 'arithmetic') {
    const k = (n: string): number => {
      const v = parseFloat(p.attrs.get(n) ?? '0');
      return Number.isFinite(v) ? v : 0;
    };
    const [k1, k2, k3, k4] = [k('k1'), k('k2'), k('k3'), k('k4')];
    for (let i = 0; i < W * H * 4; i++) {
      const i1 = a.data[i], i2 = b.data[i];
      out.data[i] = clamp01(k1 * i1 * i2 + k2 * i1 + k3 * i2 + k4);
    }
    return out;
  }
  const [c0, c1, c2, c3] = PORTER_DUFF[op] ?? PORTER_DUFF.over;
  for (let q = 0; q < W * H; q++) {
    const aa = a.data[q * 4 + 3], ab = b.data[q * 4 + 3];
    const fa = c0 + c1 * ab, fb = c2 + c3 * aa;
    for (let c = 0; c < 4; c++)
      out.data[q * 4 + c] = clamp01(a.data[q * 4 + c] * fa + b.data[q * 4 + c] * fb);
  }
  return out;
}
```

`switch` case:

```ts
      case 'feComposite':
        raw = compositeKernel(inSpace(p.in1), inSpace(p.in2 || 'SourceGraphic'), p, W, H);
        break;
```

Add `'feComposite'` to `SUPPORTED`.

- [ ] **Step 4: Run, expect PASS**
- [ ] **Step 5: `npm run typecheck`**

---

## Task 10: `feBlend`

**Files:** modify `src/svgfilterfx.ts`, `src/svgfilter.ts`; test `test/svg-filterfx.test.ts`.

- [ ] **Step 1: Tests**

```ts
describe('runFilter — feBlend', () => {
  const two = (mode: string, ca: string, cb: string) =>
    `<feFlood flood-color="${ca}" result="a"/>` +
    `<feFlood flood-color="${cb}" result="b"/>` +
    `<feBlend in="a" in2="b" mode="${mode}"/>`;

  it('normal is source-over', () => {
    const out = runFilter(specOf(two('normal', '#ff0000', '#0000ff')), source(), 1);
    near(px(out, 5, 5)[0], 1, 3);
    near(px(out, 5, 5)[2], 0, 3);
  });

  it('multiply darkens: opaque cr = ca*cb', () => {
    // 0.5 linear gray over 0.5 linear gray -> 0.25.
    const out = runFilter(specOf(
      '<feFlood flood-color="#ff0000" result="a"/>' +
      '<feFlood flood-color="#ffffff" result="b"/>' +
      '<feBlend in="a" in2="b" mode="multiply"/>'), source(), 1);
    near(px(out, 5, 5)[0], 1, 3);      // red x white = red
    near(px(out, 5, 5)[1], 0, 3);
  });

  it('screen lightens: 1-(1-ca)(1-cb)', () => {
    const out = runFilter(specOf(two('screen', '#ff0000', '#0000ff')), source(), 1);
    const p = px(out, 5, 5);
    near(p[0], 1, 3); near(p[2], 1, 3);
  });

  it('darken takes the per-channel minimum where both are opaque', () => {
    const out = runFilter(specOf(two('darken', '#ff0000', '#0000ff')), source(), 1);
    const p = px(out, 5, 5);
    near(p[0], 0, 3); near(p[2], 0, 3);
  });

  it('lighten takes the per-channel maximum', () => {
    const out = runFilter(specOf(two('lighten', '#ff0000', '#0000ff')), source(), 1);
    const p = px(out, 5, 5);
    near(p[0], 1, 3); near(p[2], 1, 3);
  });

  it('falls back to normal for an unknown mode', () => {
    const out = runFilter(specOf(two('color-dodge', '#ff0000', '#0000ff')), source(), 1);
    near(px(out, 5, 5)[0], 1, 3);
  });
});
```

- [ ] **Step 2: Run, expect FAIL**

- [ ] **Step 3: Implement**

```ts
/** SVG 1.1 §15.7.4's five modes, written in the spec's own PREMULTIPLIED form
 *  rather than routed through blend.ts — that module takes non-premultiplied
 *  Rgb and returns the blend function alone, without the qa/qb weighting these
 *  formulas fold in. */
function blendKernel(a: Surface, b: Surface, mode: string, W: number, H: number): Surface {
  const out = makeSurface(0, 0, W, H);
  for (let q = 0; q < W * H; q++) {
    const qa = a.data[q * 4 + 3], qb = b.data[q * 4 + 3];
    out.data[q * 4 + 3] = clamp01(qa + qb - qa * qb);
    for (let c = 0; c < 3; c++) {
      const ca = a.data[q * 4 + c], cb = b.data[q * 4 + c];
      let v: number;
      switch (mode) {
        case 'multiply': v = ca * cb + ca * (1 - qb) + cb * (1 - qa); break;
        case 'screen':   v = ca + cb - ca * cb; break;
        case 'darken':   v = Math.min((1 - qb) * ca + cb, (1 - qa) * cb + ca); break;
        case 'lighten':  v = Math.max((1 - qb) * ca + cb, (1 - qa) * cb + ca); break;
        default:         v = ca + cb * (1 - qa); break;     // normal
      }
      out.data[q * 4 + c] = clamp01(v);
    }
  }
  return out;
}
```

`switch` case:

```ts
      case 'feBlend':
        raw = blendKernel(
          inSpace(p.in1), inSpace(p.in2 || 'SourceGraphic'),
          p.attrs.get('mode') ?? 'normal', W, H);
        break;
```

Add `'feBlend'` to `SUPPORTED`.

- [ ] **Step 4: Run, expect PASS**
- [ ] **Step 5: `npm run typecheck`**

---

## Task 11: `feColorMatrix`

**Files:** modify `src/svgfilterfx.ts`, `src/svgfilter.ts`; test `test/svg-filterfx.test.ts`.

- [ ] **Step 1: Tests**

The `saturate="0"` case is pinned against the spec's published luminance coefficients — outside our implementation.

```ts
describe('runFilter — feColorMatrix', () => {
  /** An opaque flood of `c`, colour-matrixed. */
  const cm = (c: string, attrs: string) =>
    `<feFlood flood-color="${c}" result="a"/><feColorMatrix in="a" ${attrs}/>`;

  it('saturate=0 applies the spec luminance coefficients', () => {
    // SVG 1.1 15.7.6: 0.2126 R + 0.7152 G + 0.0722 B (the published values).
    const out = runFilter(specOf(cm('#ff0000', 'type="saturate" values="0"')), source(), 1);
    const p = px(out, 5, 5);
    near(p[0], 0.2126, 3);
    near(p[1], 0.2126, 3);
    near(p[2], 0.2126, 3);
    near(p[3], 1, 6);
  });

  it('saturate=1 is the identity', () => {
    const out = runFilter(specOf(cm('#ff0000', 'type="saturate" values="1"')), source(), 1);
    near(px(out, 5, 5)[0], 1, 4);
    near(px(out, 5, 5)[1], 0, 4);
  });

  it('luminanceToAlpha writes luminance into alpha and zeroes colour', () => {
    const out = runFilter(specOf(cm('#00ff00', 'type="luminanceToAlpha"')), source(), 1);
    const p = px(out, 5, 5);
    near(p[3], 0.7152, 3);
    near(p[0], 0, 4); near(p[1], 0, 4); near(p[2], 0, 4);
  });

  it('hueRotate by 360 degrees is the identity', () => {
    const out = runFilter(specOf(cm('#ff0000', 'type="hueRotate" values="360"')), source(), 1);
    near(px(out, 5, 5)[0], 1, 3);
    near(px(out, 5, 5)[1], 0, 3);
  });

  it('type=matrix takes the 20 values row-major', () => {
    // Swap R and B, keep alpha.
    const out = runFilter(specOf(cm('#ff0000',
      'type="matrix" values="0 0 1 0 0  0 1 0 0 0  1 0 0 0 0  0 0 0 1 0"')), source(), 1);
    const p = px(out, 5, 5);
    near(p[0], 0, 4); near(p[2], 1, 3);
  });

  it('operates on NON-premultiplied values', () => {
    // A half-transparent red. type=matrix with an identity colour part and a
    // constant alpha of 1 must give FULL red, not the premultiplied 0.5 red
    // that reusing the stored value would produce.
    const out = runFilter(specOf(
      '<feFlood flood-color="#ff0000" flood-opacity="0.5" result="a"/>' +
      '<feColorMatrix in="a" type="matrix" ' +
      'values="1 0 0 0 0  0 1 0 0 0  0 0 1 0 0  0 0 0 0 1"/>'), source(), 1);
    const p = px(out, 5, 5);
    near(p[3], 1, 4);
    near(p[0], 1, 3);
  });

  it('defaults to the identity matrix for a malformed values list', () => {
    const out = runFilter(specOf(cm('#ff0000', 'type="matrix" values="1 2 3"')), source(), 1);
    near(px(out, 5, 5)[0], 1, 4);
  });
});
```

- [ ] **Step 2: Run, expect FAIL**

- [ ] **Step 3: Implement**

```ts
/** SVG 1.1 §15.7.6's luminance coefficients. Also used by feDiffuseLighting in
 *  a later phase; they are the Rec. 709 primaries. */
const LUM = [0.2126, 0.7152, 0.0722] as const;

function colorMatrixValues(p: FilterPrim): number[] {
  const type = p.attrs.get('type') ?? 'matrix';
  const nums = (p.attrs.get('values') ?? '').trim().split(/[\s,]+/)
    .map(Number).filter((n) => Number.isFinite(n));
  const ident = [1,0,0,0,0, 0,1,0,0,0, 0,0,1,0,0, 0,0,0,1,0];
  if (type === 'matrix') return nums.length === 20 ? nums : ident;
  if (type === 'saturate') {
    const s = nums.length >= 1 ? nums[0] : 1;
    const [r, g, b] = LUM;
    return [
      r + (1 - r) * s, g - g * s,       b - b * s,       0, 0,
      r - r * s,       g + (1 - g) * s, b - b * s,       0, 0,
      r - r * s,       g - g * s,       b + (1 - b) * s, 0, 0,
      0, 0, 0, 1, 0,
    ];
  }
  if (type === 'hueRotate') {
    const deg = nums.length >= 1 ? nums[0] : 0;
    const c = Math.cos(deg * Math.PI / 180), n = Math.sin(deg * Math.PI / 180);
    // SVG 1.1 §15.7.6's published hueRotate matrix, term for term.
    return [
      0.213 + c * 0.787 - n * 0.213, 0.715 - c * 0.715 - n * 0.715, 0.072 - c * 0.072 + n * 0.928, 0, 0,
      0.213 - c * 0.213 + n * 0.143, 0.715 + c * 0.285 + n * 0.140, 0.072 - c * 0.072 - n * 0.283, 0, 0,
      0.213 - c * 0.213 - n * 0.787, 0.715 - c * 0.715 + n * 0.715, 0.072 + c * 0.928 + n * 0.072, 0, 0,
      0, 0, 0, 1, 0,
    ];
  }
  if (type === 'luminanceToAlpha')
    return [0,0,0,0,0, 0,0,0,0,0, 0,0,0,0,0, LUM[0], LUM[1], LUM[2], 0, 0];
  return ident;
}

/** SVG 1.1 §15.7.6: operates on NON-premultiplied values. Storing premultiplied
 *  and matrixing them directly is the bug this unpremultiply guards. */
function colorMatrixKernel(input: Surface, p: FilterPrim, W: number, H: number): Surface {
  const m = colorMatrixValues(p);
  const out = makeSurface(0, 0, W, H);
  for (let q = 0; q < W * H; q++) {
    const a = input.data[q * 4 + 3];
    const r = a > 0 ? input.data[q * 4] / a : 0;
    const g = a > 0 ? input.data[q * 4 + 1] / a : 0;
    const b = a > 0 ? input.data[q * 4 + 2] / a : 0;
    const na = clamp01(m[15] * r + m[16] * g + m[17] * b + m[18] * a + m[19]);
    out.data[q * 4 + 3] = na;
    for (let c = 0; c < 3; c++) {
      const v = clamp01(m[c * 5] * r + m[c * 5 + 1] * g + m[c * 5 + 2] * b
                        + m[c * 5 + 3] * a + m[c * 5 + 4]);
      out.data[q * 4 + c] = v * na;
    }
  }
  return out;
}
```

`switch` case:

```ts
      case 'feColorMatrix':
        raw = colorMatrixKernel(inSpace(p.in1), p, W, H);
        break;
```

Add `'feColorMatrix'` to `SUPPORTED`.

- [ ] **Step 4: Run, expect PASS**
- [ ] **Step 5: `npm run typecheck`**

---

## Task 12: `feComponentTransfer`

**Files:** modify `src/svgfilterfx.ts`, `src/svgfilter.ts`; test `test/svg-filterfx.test.ts`.

- [ ] **Step 1: Tests**

```ts
describe('runFilter — feComponentTransfer', () => {
  const ct = (c: string, funcs: string) =>
    `<feFlood flood-color="${c}" result="a"/>` +
    `<feComponentTransfer in="a">${funcs}</feComponentTransfer>`;

  it('linear applies slope*C + intercept', () => {
    const out = runFilter(specOf(ct('#ffffff',
      '<feFuncR type="linear" slope="0.5" intercept="0.1"/>')), source(), 1);
    near(px(out, 5, 5)[0], 0.6, 4);
    near(px(out, 5, 5)[1], 1, 4);          // G untouched: no feFuncG
  });

  it('table interpolates between its entries', () => {
    // C = 1 lands on the last entry exactly.
    const out = runFilter(specOf(ct('#ffffff',
      '<feFuncR type="table" tableValues="0 0.25"/>')), source(), 1);
    near(px(out, 5, 5)[0], 0.25, 4);
  });

  it('table interpolates in the middle', () => {
    const out = runFilter(specOf(
      '<feFlood flood-color="#ffffff" result="w"/>' +
      '<feComponentTransfer in="w">' +
      '<feFuncR type="linear" slope="0.5"/></feComponentTransfer>' +
      '<feComponentTransfer><feFuncR type="table" tableValues="0 1"/>' +
      '</feComponentTransfer>'), source(), 1);
    near(px(out, 5, 5)[0], 0.5, 3);
  });

  it('discrete steps without interpolating', () => {
    const out = runFilter(specOf(
      '<feFlood flood-color="#ffffff" result="w"/>' +
      '<feComponentTransfer in="w">' +
      '<feFuncR type="linear" slope="0.5"/></feComponentTransfer>' +
      '<feComponentTransfer><feFuncR type="discrete" tableValues="0 0.3 0.9"/>' +
      '</feComponentTransfer>'), source(), 1);
    // n=3, C=0.5 -> k = floor(0.5*3) = 1 -> v[1] = 0.3.
    near(px(out, 5, 5)[0], 0.3, 3);
  });

  it('gamma applies amplitude*C^exponent + offset', () => {
    const out = runFilter(specOf(
      '<feFlood flood-color="#ffffff" result="w"/>' +
      '<feComponentTransfer in="w">' +
      '<feFuncR type="linear" slope="0.25"/></feComponentTransfer>' +
      '<feComponentTransfer><feFuncR type="gamma" amplitude="2" exponent="0.5" offset="0.1"/>' +
      '</feComponentTransfer>'), source(), 1);
    near(px(out, 5, 5)[0], 2 * Math.sqrt(0.25) + 0.1, 3);
  });

  it('identity and an absent function both leave the channel alone', () => {
    const out = runFilter(specOf(ct('#ff8000',
      '<feFuncR type="identity"/>')), source(), 1);
    near(px(out, 5, 5)[0], 1, 3);
  });

  it('transfers alpha, and operates on NON-premultiplied colour', () => {
    // Half-transparent white with alpha forced to 1: the colour must come back
    // to full white, which only holds if the kernel unpremultiplied first.
    const out = runFilter(specOf(
      '<feFlood flood-color="#ffffff" flood-opacity="0.5" result="a"/>' +
      '<feComponentTransfer in="a">' +
      '<feFuncA type="linear" slope="0" intercept="1"/></feComponentTransfer>'),
      source(), 1);
    const p = px(out, 5, 5);
    near(p[3], 1, 4);
    near(p[0], 1, 3);
  });
});
```

- [ ] **Step 2: Run, expect FAIL**

- [ ] **Step 3: Implement**

```ts
/** One feFuncR/G/B/A as a 0..1 -> 0..1 function. SVG 1.1 §15.7.7. */
function transferFn(n: XmlNode | undefined): (c: number) => number {
  if (!n) return (c) => c;
  const num = (k: string, d: number): number => {
    const v = parseFloat(n.attrs.get(k) ?? '');
    return Number.isFinite(v) ? v : d;
  };
  const table = (n.attrs.get('tableValues') ?? '').trim().split(/[\s,]+/)
    .map(Number).filter((v) => Number.isFinite(v));
  switch (n.attrs.get('type')) {
    case 'table': {
      if (table.length === 0) return (c) => c;
      if (table.length === 1) return () => table[0];
      const n1 = table.length - 1;
      return (c) => {
        const k = Math.min(n1 - 1, Math.floor(c * n1));
        return table[k] + (c - k / n1) * n1 * (table[k + 1] - table[k]);
      };
    }
    case 'discrete': {
      if (table.length === 0) return (c) => c;
      return (c) => table[Math.min(table.length - 1, Math.floor(c * table.length))];
    }
    case 'linear': {
      const s = num('slope', 1), i = num('intercept', 0);
      return (c) => s * c + i;
    }
    case 'gamma': {
      const a = num('amplitude', 1), e = num('exponent', 1), o = num('offset', 0);
      return (c) => a * Math.pow(c, e) + o;
    }
    default:
      return (c) => c;
  }
}

/** SVG 1.1 §15.7.7: operates on NON-premultiplied values, like feColorMatrix. */
function componentTransferKernel(input: Surface, p: FilterPrim, W: number, H: number): Surface {
  const byName = new Map<string, XmlNode>();
  for (const c of p.node.children) if (!byName.has(c.name)) byName.set(c.name, c);
  const fns = [
    transferFn(byName.get('feFuncR')), transferFn(byName.get('feFuncG')),
    transferFn(byName.get('feFuncB')), transferFn(byName.get('feFuncA')),
  ];
  const out = makeSurface(0, 0, W, H);
  for (let q = 0; q < W * H; q++) {
    const a = input.data[q * 4 + 3];
    const na = clamp01(fns[3](a));
    out.data[q * 4 + 3] = na;
    for (let c = 0; c < 3; c++) {
      const straight = a > 0 ? input.data[q * 4 + c] / a : 0;
      out.data[q * 4 + c] = clamp01(fns[c](clamp01(straight))) * na;
    }
  }
  return out;
}
```

Add `import type { XmlNode } from './xml.js';` to `svgfilterfx.ts`.

`switch` case:

```ts
      case 'feComponentTransfer':
        raw = componentTransferKernel(inSpace(p.in1), p, W, H);
        break;
```

Add `'feComponentTransfer'` to `SUPPORTED`.

- [ ] **Step 4: Run, expect PASS**
- [ ] **Step 5: `npm run typecheck`**

---

## Task 13: `feGaussianBlur` and `feDropShadow`

**Files:** modify `src/svgfilterfx.ts`, `src/svgfilter.ts`; test `test/svg-filterfx.test.ts`.

- [ ] **Step 1: Tests**

The blur is pinned against two external facts: a blurred delta sums to 1 (energy conservation), and the spec's own box-size formula.

```ts
describe('runFilter — feGaussianBlur', () => {
  /** A single opaque white pixel at the centre of a 21x21 region. */
  function delta(): ReturnType<typeof makeSurface> {
    const s = makeSurface(0, 0, 21, 21);
    s.data.set([1, 1, 1, 1], (10 * 21 + 10) * 4);
    return s;
  }
  function bigSpec(prims: string): FilterSpec {
    const root = parseXml(xml(
      '<svg><filter id="f" filterUnits="userSpaceOnUse" x="0" y="0" ' +
      `width="21" height="21">${prims}</filter></svg>`));
    let f: XmlNode | undefined;
    const walk = (n: XmlNode): void => {
      if (n.name === 'filter') f ??= n;
      for (const c of n.children) walk(c);
    };
    walk(root);
    const r = resolveFilter(f!, { x: 0, y: 0, w: 21, h: 21 }, VP);
    if (r.kind !== 'draw') throw new Error(`expected draw, got ${r.kind}`);
    return r.spec;
  }
  const sum = (s: { data: Float32Array; w: number; h: number }, ch: number): number => {
    let t = 0;
    for (let p = 0; p < s.w * s.h; p++) t += s.data[p * 4 + ch];
    return t;
  };

  it('conserves energy: a blurred delta still sums to 1', () => {
    for (const sd of ['0.7', '1.5', '3']) {
      const out = runFilter(bigSpec(`<feGaussianBlur stdDeviation="${sd}"/>`), delta(), 1);
      expect(Math.abs(sum(out, 3) - 1)).toBeLessThan(0.02);
    }
  });

  it('spreads: the centre falls and the neighbours rise', () => {
    const out = runFilter(bigSpec('<feGaussianBlur stdDeviation="2"/>'), delta(), 1);
    expect(px(out, 10, 10)[3]).toBeLessThan(0.3);
    expect(px(out, 12, 10)[3]).toBeGreaterThan(0);
    expect(px(out, 10, 12)[3]).toBeGreaterThan(0);
  });

  it('is symmetric about the delta', () => {
    const out = runFilter(bigSpec('<feGaussianBlur stdDeviation="2"/>'), delta(), 1);
    near(px(out, 8, 10)[3], px(out, 12, 10)[3], 5);
    near(px(out, 10, 8)[3], px(out, 10, 12)[3], 5);
  });

  it('takes two stdDeviations as x and y', () => {
    const out = runFilter(bigSpec('<feGaussianBlur stdDeviation="3 0"/>'), delta(), 1);
    expect(px(out, 13, 10)[3]).toBeGreaterThan(0);
    near(px(out, 10, 13)[3], 0, 6);        // no vertical spread
  });

  it('is the identity at stdDeviation 0', () => {
    const out = runFilter(bigSpec('<feGaussianBlur stdDeviation="0"/>'), delta(), 1);
    near(px(out, 10, 10)[3], 1, 5);
  });

  it('scales the radius with the raster scale', () => {
    const wide = runFilter(bigSpec('<feGaussianBlur stdDeviation="1"/>'), delta(), 2);
    const narrow = runFilter(bigSpec('<feGaussianBlur stdDeviation="1"/>'), delta(), 1);
    expect(px(wide, 13, 10)[3]).toBeGreaterThan(px(narrow, 13, 10)[3]);
  });
});

describe('runFilter — feDropShadow', () => {
  it('keeps the source and adds an offset shadow beneath it', () => {
    const out = runFilter(specOf(
      '<feDropShadow dx="4" dy="4" stdDeviation="0" flood-color="#ff0000"/>'), source(), 1);
    // The source is white and on top at its own pixels.
    near(px(out, 0, 0)[3], 1, 4);
    near(px(out, 0, 0)[0], 1, 3);
    // The shadow is red, offset by (4,4).
    const s = px(out, 4, 4);
    near(s[3], 1, 3);
    near(s[0], 1, 3); near(s[1], 0, 3);
  });

  it('honours flood-opacity', () => {
    const out = runFilter(specOf(
      '<feDropShadow dx="4" dy="4" stdDeviation="0" flood-opacity="0.5"/>'), source(), 1);
    near(px(out, 4, 4)[3], 0.5, 3);
  });
});
```

- [ ] **Step 2: Run, expect FAIL**

- [ ] **Step 3: Implement**

```ts
/** SVG 1.1 §15.17's box-size formula: d = floor(s * 3 * sqrt(2*PI) / 4 + 0.5). */
function boxSize(sigma: number): number {
  return Math.floor(sigma * 3 * Math.sqrt(2 * Math.PI) / 4 + 0.5);
}

/** One horizontal or vertical box blur of width `d`, on premultiplied data. */
function boxBlur1D(
  src: Float32Array, dst: Float32Array, w: number, h: number, d: number,
  horizontal: boolean, shift: number,
): void {
  const half = Math.floor(d / 2);
  const lines = horizontal ? h : w;
  const len = horizontal ? w : h;
  for (let l = 0; l < lines; l++) {
    for (let i = 0; i < len; i++) {
      for (let c = 0; c < 4; c++) {
        let acc = 0;
        for (let k = 0; k < d; k++) {
          const j = i + k - half + shift;
          if (j < 0 || j >= len) continue;
          const idx = horizontal ? (l * w + j) : (j * w + l);
          acc += src[idx * 4 + c];
        }
        const o = horizontal ? (l * w + i) : (i * w + l);
        dst[o * 4 + c] = acc / d;
      }
    }
  }
}

/** A true Gaussian convolution, for the small sigmas where three box blurs are
 *  visibly boxy. SVG 1.1 prescribes the box approximation only for sigma >= 2. */
function gaussian1D(
  src: Float32Array, dst: Float32Array, w: number, h: number, sigma: number,
  horizontal: boolean,
): void {
  const r = Math.max(1, Math.ceil(sigma * 3));
  const k = new Float64Array(r * 2 + 1);
  let total = 0;
  for (let i = -r; i <= r; i++) {
    const v = Math.exp(-(i * i) / (2 * sigma * sigma));
    k[i + r] = v; total += v;
  }
  for (let i = 0; i < k.length; i++) k[i] /= total;
  const lines = horizontal ? h : w;
  const len = horizontal ? w : h;
  for (let l = 0; l < lines; l++) {
    for (let i = 0; i < len; i++) {
      for (let c = 0; c < 4; c++) {
        let acc = 0;
        for (let j = -r; j <= r; j++) {
          const q = i + j;
          if (q < 0 || q >= len) continue;
          const idx = horizontal ? (l * w + q) : (q * w + l);
          acc += src[idx * 4 + c] * k[j + r];
        }
        const o = horizontal ? (l * w + i) : (i * w + l);
        dst[o * 4 + c] = acc;
      }
    }
  }
}

/** Blur one axis by `sigma` pixels: three successive box blurs above the
 *  spec's 2.0 threshold, a true Gaussian below it. */
function blurAxis(s: Surface, sigma: number, horizontal: boolean): Surface {
  const out = makeSurface(s.x, s.y, s.w, s.h);
  if (!(sigma > 0)) { out.data.set(s.data); return out; }
  if (sigma < 2) {
    gaussian1D(s.data, out.data, s.w, s.h, sigma, horizontal);
    return out;
  }
  const d = boxSize(sigma);
  if (d < 1) { out.data.set(s.data); return out; }
  const a = new Float32Array(s.data.length);
  const b = new Float32Array(s.data.length);
  // SVG 1.1 §15.17: for an even d, the first two boxes are offset by half a
  // pixel in opposite directions and the third is one wider, which is what
  // keeps an even-width blur centred.
  if (d % 2 === 1) {
    boxBlur1D(s.data, a, s.w, s.h, d, horizontal, 0);
    boxBlur1D(a, b, s.w, s.h, d, horizontal, 0);
    boxBlur1D(b, out.data, s.w, s.h, d, horizontal, 0);
  } else {
    boxBlur1D(s.data, a, s.w, s.h, d, horizontal, 0);
    boxBlur1D(a, b, s.w, s.h, d, horizontal, 1);
    boxBlur1D(b, out.data, s.w, s.h, d + 1, horizontal, 0);
  }
  return out;
}

function blurKernel(input: Surface, sx: number, sy: number): Surface {
  return blurAxis(blurAxis(input, sx, true), sy, false);
}

/** The two stdDeviation numbers, already scaled to pixels. */
function stdDev(spec: FilterSpec, p: FilterPrim, scale: number): [number, number] {
  const raw = (p.attrs.get('stdDeviation') ?? '0').trim().split(/[\s,]+/);
  const x = primLength(spec, raw[0], 0, 'x') * scale;
  const y = primLength(spec, raw[1] ?? raw[0], 0, 'y') * scale;
  return [Math.max(0, x), Math.max(0, y)];
}
```

`switch` cases:

```ts
      case 'feGaussianBlur': {
        const [sx, sy] = stdDev(spec, p, scale);
        raw = blurKernel(inSpace(p.in1), sx, sy);
        break;
      }
      case 'feDropShadow': {
        // Filter Effects 1 §9.6's shorthand: blur(offset(SourceAlpha)),
        // coloured by flood-*, with the source composited over it.
        const src = inSpace(p.in1);
        const [sx, sy] = stdDev(spec, p, scale);
        const shadow = offsetKernel(
          blurKernel(sourceAlpha(src), sx, sy),
          primLength(spec, p.attrs.get('dx'), 2, 'x') * scale,
          primLength(spec, p.attrs.get('dy'), 2, 'y') * scale);
        const tint = floodKernel(p, W, H, 0, 0);
        // The tint, cut to the shadow's alpha: 'in' with the shadow as in2.
        raw = makeSurface(0, 0, W, H);
        for (let q = 0; q < W * H; q++) {
          const a = shadow.data[q * 4 + 3];
          for (let c = 0; c < 4; c++) raw.data[q * 4 + c] = tint.data[q * 4 + c] * a;
        }
        over(raw, src);
        break;
      }
```

Add `'feGaussianBlur'` and `'feDropShadow'` to `SUPPORTED`.

- [ ] **Step 4: Run, expect PASS**
- [ ] **Step 5: `npm run typecheck`**

---

## Task 14: `feMorphology` and `feTile`

**Files:** modify `src/svgfilterfx.ts`, `src/svgfilter.ts`; test `test/svg-filterfx.test.ts`.

- [ ] **Step 1: Tests**

`feMorphology` on a known binary shape has an exactly enumerable result — the external reference CLAUDE.md asks for.

```ts
describe('runFilter — feMorphology', () => {
  it('dilate by radius 1 grows the 2x2 block to 4x4, exactly', () => {
    const out = runFilter(specOf('<feMorphology operator="dilate" radius="1"/>'),
                          source(), 1);
    // The source block is (0,0)-(1,1). Radius 1 reaches one pixel out.
    for (let y = 0; y <= 2; y++) for (let x = 0; x <= 2; x++) near(px(out, x, y)[3], 1, 5);
    near(px(out, 3, 0)[3], 0, 5);
    near(px(out, 0, 3)[3], 0, 5);
  });

  it('erode by radius 1 removes the 2x2 block entirely', () => {
    // Every pixel of a 2x2 block has a transparent neighbour within radius 1.
    const out = runFilter(specOf('<feMorphology operator="erode" radius="1"/>'),
                          source(), 1);
    for (let y = 0; y < 10; y++) for (let x = 0; x < 10; x++) near(px(out, x, y)[3], 0, 5);
  });

  it('is the identity at radius 0', () => {
    const out = runFilter(specOf('<feMorphology operator="dilate" radius="0"/>'),
                          source(), 1);
    near(px(out, 0, 0)[3], 1, 5);
    near(px(out, 2, 0)[3], 0, 5);
  });

  it('takes two radii as x and y', () => {
    const out = runFilter(specOf('<feMorphology operator="dilate" radius="2 0"/>'),
                          source(), 1);
    near(px(out, 3, 0)[3], 1, 5);
    near(px(out, 0, 3)[3], 0, 5);
  });

  it('defaults to erode', () => {
    const out = runFilter(specOf('<feMorphology radius="1"/>'), source(), 1);
    near(px(out, 0, 0)[3], 0, 5);
  });
});

describe('runFilter — feTile', () => {
  it('repeats the input subregion across the output subregion', () => {
    const out = runFilter(specOf(
      '<feFlood flood-color="#ff0000" x="0" y="0" width="2" height="2" result="t"/>' +
      '<feTile in="t" x="0" y="0" width="10" height="10"/>'), source(), 1);
    near(px(out, 0, 0)[0], 1, 3);
    near(px(out, 4, 4)[0], 1, 3);       // two tiles across and down
    near(px(out, 9, 9)[0], 1, 3);
  });

  it('produces nothing from an empty input subregion', () => {
    const out = runFilter(specOf(
      '<feFlood flood-color="#ff0000" x="0" y="0" width="0" height="0" result="t"/>' +
      '<feTile in="t"/>'), source(), 1);
    near(px(out, 5, 5)[3], 0, 5);
  });
});
```

- [ ] **Step 2: Run, expect FAIL**

- [ ] **Step 3: Implement**

```ts
/** SVG 1.1 §15.7.13: per-channel min (erode) or max (dilate) over the kernel
 *  rectangle, on premultiplied values. */
function morphologyKernel(
  input: Surface, rx: number, ry: number, dilate: boolean, W: number, H: number,
): Surface {
  const out = makeSurface(0, 0, W, H);
  const ix = Math.floor(rx), iy = Math.floor(ry);
  if (ix <= 0 && iy <= 0) { out.data.set(input.data); return out; }
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const best = dilate ? [0, 0, 0, 0] : [1, 1, 1, 1];
      for (let j = -iy; j <= iy; j++) {
        const yy = y + j;
        if (yy < 0 || yy >= H) { if (!dilate) best.fill(0); continue; }
        for (let i = -ix; i <= ix; i++) {
          const xx = x + i;
          // Outside the surface counts as transparent black, so an erode at the
          // edge correctly clears rather than sampling nothing.
          if (xx < 0 || xx >= W) { if (!dilate) best.fill(0); continue; }
          for (let c = 0; c < 4; c++) {
            const v = input.data[((yy * W) + xx) * 4 + c];
            best[c] = dilate ? Math.max(best[c], v) : Math.min(best[c], v);
          }
        }
      }
      for (let c = 0; c < 4; c++) out.data[(y * W + x) * 4 + c] = best[c];
    }
  }
  return out;
}

/** SVG 1.1 §15.7.19: repeat the INPUT primitive's subregion across this
 *  primitive's. `inSub` is the input's window, in raster pixels. */
function tileKernel(
  input: Surface, inSub: { x: number; y: number; w: number; h: number },
  W: number, H: number,
): Surface {
  const out = makeSurface(0, 0, W, H);
  if (inSub.w <= 0 || inSub.h <= 0) return out;
  for (let y = 0; y < H; y++) {
    const sy = inSub.y + ((((y - inSub.y) % inSub.h) + inSub.h) % inSub.h);
    if (sy < 0 || sy >= H) continue;
    for (let x = 0; x < W; x++) {
      const sx = inSub.x + ((((x - inSub.x) % inSub.w) + inSub.w) % inSub.w);
      if (sx < 0 || sx >= W) continue;
      for (let c = 0; c < 4; c++)
        out.data[(y * W + x) * 4 + c] = input.data[(sy * W + sx) * 4 + c];
    }
  }
  return out;
}
```

`feTile` needs the *input's* subregion, so `runFilter` must remember one window per result. Add, next to `results`:

```ts
  const windows = new Map<string, { x: number; y: number; w: number; h: number }>();
```

record it at the end of the loop body, beside `results.set(p.result, last)`:

```ts
    windows.set(p.result, win);
```

and seed the two pseudo-inputs before the loop:

```ts
  const whole = { x: 0, y: 0, w: W, h: H };
  windows.set('SourceGraphic', whole);
  windows.set('SourceAlpha', whole);
```

`switch` cases:

```ts
      case 'feMorphology': {
        const rr = (p.attrs.get('radius') ?? '0').trim().split(/[\s,]+/);
        raw = morphologyKernel(
          inSpace(p.in1),
          primLength(spec, rr[0], 0, 'x') * scale,
          primLength(spec, rr[1] ?? rr[0], 0, 'y') * scale,
          p.attrs.get('operator') === 'dilate', W, H);
        break;
      }
      case 'feTile':
        raw = tileKernel(inSpace(p.in1), windows.get(p.in1) ?? whole, W, H);
        break;
```

Add `'feMorphology'` and `'feTile'` to `SUPPORTED`.

- [ ] **Step 4: Run, expect PASS**
- [ ] **Step 5: `npm run typecheck`**

---

## Task 15: Documentation, mutation check, and close

**Files:**
- Modify: `README.md`
- Test: `test/svg-filter-render.test.ts` (append one chained end-to-end case)

- [ ] **Step 1: Add a chained end-to-end test**

Append to `test/svg-filter-render.test.ts`:

```ts
describe('AddSVGObject — a realistic chain', () => {
  it('renders a drop shadow: soft dark ink below-right of the shape', () => {
    const { png, result } = render(
      '<svg viewBox="0 0 200 200"><defs>' +
      '<filter id="f" filterUnits="userSpaceOnUse" x="0" y="0" width="200" height="200">' +
      '<feGaussianBlur in="SourceAlpha" stdDeviation="4"/>' +
      '<feOffset dx="20" dy="20" result="s"/>' +
      '<feMerge><feMergeNode in="s"/><feMergeNode in="SourceGraphic"/></feMerge>' +
      '</filter></defs>' +
      '<rect x="20" y="20" width="60" height="60" fill="#ff0000" filter="url(#f)"/></svg>');
    expect(result.skipped).toEqual([]);
    expect(result.rasterized).toEqual(['filter']);
    expect(isRed(png, 50, 50)).toBe(true);            // the shape itself
    const [r, g, b] = png.at(100, 100);               // inside the shadow
    expect(r).toBeLessThan(240);
    expect(Math.abs(r - g)).toBeLessThan(20);         // grey, not red
    expect(Math.abs(g - b)).toBeLessThan(20);
    expect(isWhite(png, 180, 180)).toBe(true);        // clear of both
  });
});
```

Run: `npx vitest run test/svg-filter-render.test.ts`
Expected: PASS.

- [ ] **Step 2: Prove the kernel assertions are load-bearing**

Break each, confirm red, revert:

1. In `colorMatrixKernel`, use the premultiplied value instead of `input.data[…] / a` → "operates on NON-premultiplied values" must fail.
2. In `blurAxis`, drop the even-`d` branch and always use three equal boxes → "is symmetric about the delta" must fail.
3. In `compositeKernel`, swap `in`'s and `out`'s coefficient rows → both operator tests must fail.
4. In `over`, replace the composite with a plain copy → feMerge's "is source-over, not replacement" must fail.
5. In `morphologyKernel`, treat outside-the-surface as opaque for erode → "erode by radius 1 removes the 2x2 block" must fail.
6. In `runFilter`, drop the `maskTo` call → feFlood's "fills ONLY its subregion" must fail.

- [ ] **Step 3: Update `README.md`**

Find the SVG embedding bullet (it mentions masks and markers from phases 1 and 2) and extend it:

```markdown
  Filters (`filter=`) are supported for `feFlood`, `feOffset`, `feMerge`,
  `feBlend`, `feComposite`, `feColorMatrix`, `feComponentTransfer`,
  `feGaussianBlur`, `feDropShadow`, `feMorphology` and `feTile`, in linearRGB
  (or sRGB via `color-interpolation-filters`). A filtered subtree is
  **rasterized**: it renders correctly but is resolution-bound, and its text
  stops being extractable and searchable. `filterScale` (default 2, max 8) sets
  the raster resolution as a multiple of the placed size, and every element name
  that was flattened is listed in the result's `rasterized` array — distinct
  from `skipped`, which still means a fidelity loss. A filter using any other
  primitive draws the element unfiltered and reports the primitive's name.
```

- [ ] **Step 4: Run the whole suite and typecheck**

Run: `npm run typecheck && npm test`
Expected: both green.

- [ ] **Step 5: Commit**

```bash
git add src/svgfilterfx.ts src/svgfilter.ts test/svg-filterfx.test.ts \
        test/svg-filter-render.test.ts README.md
git commit -m "$(cat <<'EOF'
feat(svg): the nine remaining core filter kernels

feMerge, feComposite (Porter-Duff and arithmetic), feBlend, feColorMatrix,
feComponentTransfer, feGaussianBlur, feDropShadow, feMorphology and feTile,
each added to SUPPORTED in the same commit as its kernel.

feColorMatrix and feComponentTransfer unpremultiply first: SVG 1.1 defines both
on non-premultiplied values, and matrixing the stored premultiplied value is
wrong wherever alpha < 1 -- invisible on the opaque fixtures that make up most
of a test suite.

Kernel expectations come from outside our own code, per CLAUDE.md: saturate=0
against the spec's published luminance coefficients, feComposite against the
Porter-Duff algebra term by term, a blurred delta against energy conservation
and the spec's box-size formula, and feMorphology against an exactly
enumerable binary result.

Closes: aspose-pdf-foss-for-ts-1gg0.10.3

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

- [ ] **Step 6: File the deferred work and close the issue**

```bash
bd create "SVG <filter>: FillPaint and StrokePaint pseudo-inputs" \
  -t feature -p 4 --parent aspose-pdf-foss-for-ts-1gg0.10 \
  -d "Deferred from 1gg0.10.3. FillPaint/StrokePaint are infinite planes of the element's paint; resolveFilter does not see the resolved Paint, so both currently make the chain report 'filter' and draw unfiltered. Implement for solid paint; a gradient or pattern keeps reporting."
bd close aspose-pdf-foss-for-ts-1gg0.10.3
```

- [ ] **Step 7: Push**

```bash
git pull --rebase
git push
git status          # MUST show "up to date with origin"
```

---

## Self-Review

**Spec coverage** (design doc section 3, plus the two 2026-07-31 additions):

| Spec item | Task |
|---|---|
| Region and graph; `filterUnits`, `primitiveUnits`, subregions | 1, 2, 3 |
| `filterRes` honoured as a cap | 2, 7 |
| Zero-area region renders nothing, not reported | 2, 7 |
| Implicit `in`, named `result`, first-primitive default | 1 |
| Colour space: linearRGB default, per-primitive, premultiplied Float32 | 4, 6 |
| `Surface` model with device-space origin | 4 |
| Raster path steps 1–5 | 7 |
| `SvgRasterSink` seam; `rasterizeFormRgba` | 5, 7 |
| `deviceScale` scalar (2026-07-31 addition) | 7 |
| Flate `BuiltImage` emit, no PNG round trip (2026-07-31 addition) | 4 |
| `filterScale` validated before allocation, cap 8 | 7 |
| `rasterized[]` on the result | 7 |
| Eleven core kernels | 6, 8–14 |
| `SourceGraphic` / `SourceAlpha`; `BackgroundImage` reported | 1, 6 |
| Errors: no new types, `TypeError` for options, degrade otherwise | 7 |
| Mutation check per phase | 3, 7, 15 |
| README | 15 |

Deliberately **not** covered, and stated in "Scope" above: `feConvolveMatrix`, `feDisplacementMap`, `feImage`, `feTurbulence`, the lighting primitives (all `1gg0.10.4`); `FillPaint` / `StrokePaint` (filed in Task 15); the vector fast paths (`1gg0.10.5`).

**Type consistency:** `resolveFilter` / `primLength` / `FilterSpec` / `FilterPrim` / `FilterResolution` are defined in Task 1–3 and used unchanged in 6–14. `Surface` / `makeSurface` / `toSurface` / `surfaceImage` / `convertSpace` / `runFilter` are defined in Tasks 4 and 6 and used unchanged after. `SvgRasterSink.rasterize(dict, content, devW, devH)` matches `rasterizeFormRgba(doc, form, devW, devH)` through the one adapter in `svgembed.ts`. `spec`, `scale`, `W`, `H`, `inSpace`, `win`, `windows`, `whole` and `over` are all in scope where the Commit C `switch` cases use them — `over` is introduced in Task 8 and reused by `feDropShadow` in Task 13, so Task 8 must land first.

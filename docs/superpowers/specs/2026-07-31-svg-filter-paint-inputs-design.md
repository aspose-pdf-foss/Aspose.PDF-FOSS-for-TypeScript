# SVG `<filter>`: the FillPaint and StrokePaint pseudo-inputs — design

Issue: `aspose-pdf-foss-for-ts-1gg0.10.6` (parent `1gg0.10`, SVG masks, filters and
markers; epic `1gg0`). Date: 2026-07-31.

Deferred from `1gg0.10.3`, which shipped the filter graph and named this gap in
`RUNNABLE_PSEUDO`'s comment. Today `FillPaint` and `StrokePaint` fall through to
the same refusal as a misspelled input name: the chain reports `filter` and the
element draws unfiltered.

SVG 1.1 §15.7.3 defines both as **infinite planes of the element's paint**. The
element's resolved `Paint` never reaches `resolveFilter`, and threading it there
is very nearly the whole cost.

## Scope

`FillPaint` and `StrokePaint` as graph inputs, for **solid** paint. A gradient or
pattern paint server keeps reporting `filter` and drawing unfiltered.

Out of scope: `BackgroundImage` / `BackgroundAlpha`, which need the accumulated
page backdrop that a single-pass walker does not retain (and which no shipping
browser has ever implemented). Resolving a gradient paint server into the plane —
it would need per-pixel gradient evaluation inside a module that touches no paint
servers at all, and patterns would still refuse.

## Where it plugs in

This is an **input**, not an emission. `runFilter` already seeds its `results` map
with `SourceGraphic` and `SourceAlpha`; these are two more seeds. Nothing
rasterizes, `extras` is not involved, and `svgfilterfx.ts` stays pure.

### `svgfilter.ts` — the paint reaches the resolver

`resolveFilter` gains an optional trailing parameter:

```ts
export function resolveFilter(
  node: XmlNode, bbox: SegBBox | null, viewport: ViewBox,
  css?: CssDecls, paint?: Paint,
): FilterResolution;
```

`svgfilter.ts` already imports `parseColor` / `styleGetter` / `Rgb` from
`svgstyle.ts`, so `type Paint` adds no dependency and closes no cycle.

`RUNNABLE_PSEUDO` stops being a module-level `Set` and becomes a predicate,
because runnability now depends on the paint:

```ts
const pseudoOk = (v: string): boolean =>
  v === 'SourceGraphic' || v === 'SourceAlpha'
  || (v === 'FillPaint'   && paint !== undefined && paint.fillRef === null)
  || (v === 'StrokePaint' && paint !== undefined && paint.strokeRef === null);
```

An **absent `paint` refuses**, exactly as today. That keeps every existing caller
and every existing test unchanged, and makes the new capability opt-in at the one
call site that has the information.

`FilterSpec` gains the two colours, and only the colours:

```ts
/** The element's own paint, for the FillPaint/StrokePaint pseudo-inputs.
 *  `null` means the paint is `none`: a fully transparent plane. Absent when
 *  the caller supplied no paint, which refuses both pseudo-inputs. */
paint?: { fill: Rgb | null; stroke: Rgb | null };
```

### `svgdraw.ts` — one call site

`walk` resolves `paint` (via `resolveStyle`) well before it reaches the filter
block, so the change is passing it through.

### `svgfilterfx.ts` — the plane

A `planeSurface(c: Rgb | null, W, H): Surface`, seeded into `results` alongside
`SourceGraphic`, with `whole` in `windows` — the plane has infinite extent, and
`feTile` is the only reader of that map.

**Seeded LINEAR, premultiplied.** `results` holds linear surfaces and `inSpace`
converts to sRGB only on demand, so the seed is `srgbToLinear(c)`. This is the
**opposite** convention from `floodKernel`, which builds in the primitive's own
space and lets `runFilter` convert back — because a flood is a primitive *output*
and a plane is a graph *input*. The asymmetry gets a comment at the seed; it is
exactly the kind of thing that silently ships wrong gamma.

**Seeded lazily.** A plane is `W × H × 4` floats — roughly 2.5 MB at 400×400,
which is not worth allocating for the chains that never name it. `runFilter`
scans `prims` for the two names once and seeds only what is used.

## Decisions

### `fill-opacity` is not read

SVG 1.1 §15.7.3 defines `FillPaint` as "the value of the **fill property**", and
`fill-opacity` is a separate property. The spec's own note — that the plane may
be non-opaque when a gradient or pattern carries alpha — points at the paint
server, not at `fill-opacity`.

The consequence is worth stating because it looks like a bug: a chain compositing
`FillPaint` against `SourceAlpha` comes out **more opaque than the element
itself**, since `SourceGraphic` is the rendered result and already has
`fill-opacity` baked in. That is the intended distinction between the paint and
the painted result.

### `none` is a transparent plane, not a refusal

SVG defines it exactly — no paint means transparent black everywhere — it costs
one branch, and it is the common case rather than an edge one: **`stroke`
defaults to `none`**, so any element that never set a stroke would otherwise
refuse the moment it names `StrokePaint`.

Only `fillRef` / `strokeRef` — a gradient or pattern — refuses.

### The refusal keeps reporting `filter`, not a more specific name

A gradient fill under `FillPaint` is arguably actionable ("your fill is a
gradient"), but `skipped` names elements and primitives, never properties, and
the existing unresolvable-input path already reports `filter`. Splitting the
vocabulary for one case buys less than the consistency costs.

## Known divergence

SVG's plane is infinite; ours is the filter region. Every primitive that samples
outside its input — `feOffset`, `feGaussianBlur`, `feConvolveMatrix`,
`feMorphology`, `feDisplacementMap` — would see paint beyond the region edge
where we see transparent.

Because the plane is **constant**, the spec-correct result of translating or
blurring it is the same plane, so the error is confined to a band at the region
boundary whose width is the primitive's reach.

It is **not** reported. It bites only when a spatial primitive consumes a paint
plane directly, and reporting every such chain would be far broader than the
artifact justifies. Recorded here so it is found as a known limit rather than
rediscovered as a bug.

## No fast-path interaction

`classify` (`1gg0.10.5`) matches `in1 === 'SourceGraphic'` on every branch, so a
chain naming `FillPaint` falls straight through to the raster path. Correct, and
no change needed.

Worth noting why the obvious candidate is not worth adding: `feComposite
in="FillPaint" in2="SourceAlpha" operator="in"` would be exactly the existing
`tint` emission — but for a solid fill it reproduces the unfiltered element, so
nobody writes it.

## Testing

One new file, `test/svg-filter-paint.test.ts`, keeping the phase self-contained
the way `1gg0.10.5` did.

**Pure** — `resolveFilter`: `FillPaint` accepted for a solid fill, refused for a
`fillRef`, refused when `paint` is omitted entirely, accepted for `fill="none"`,
and `StrokePaint` accepted on an element that never set a stroke.

**Kernel** — `runFilter` over a hand-built spec: the plane carries the colour in
linear, and `feComposite in="FillPaint" in2="SourceAlpha" operator="in"`
reproduces the fill over the source's silhouette.

**End-to-end** — `AddSVGObject` + `ToImage`: the colour survives the whole stack;
a gradient fill reports `filter` and draws unfiltered.

### Fixtures chosen to be load-bearing

| Trap | Fixture that catches it |
|---|---|
| plane seeded in sRGB instead of linear | a **mid-tone** `#996633`. `srgbToLinear` fixes both endpoints (`0 → 0`, `1 → 1`), so `#ff0000`, `#00ff00`, `#0000ff`, `#000000` and `#ffffff` all pass with the conversion deleted — the same shape as `.10.4`'s "an all-red PNG cannot detect a dropped y-flip" |
| fill and stroke planes swapped | different colours on each, both named in one chain |
| `fill-opacity` wrongly folded in | `fill-opacity="0.4"` with the plane asserted fully opaque |
| an omitted `paint` silently enabling the pseudo-input | `resolveFilter` called with four arguments, as every existing caller does |

**Not tested, deliberately:** the lazy seeding. Whether a `Float32Array` was
allocated is invisible through every public surface, so a test would have to
reach into internals to assert a pure performance property.

## Files

| File | Change |
|---|---|
| `src/svgfilter.ts` | `pseudoOk` predicate replacing `RUNNABLE_PSEUDO`; `FilterSpec.paint`; `resolveFilter` signature |
| `src/svgfilterfx.ts` | `planeSurface` + lazy seeding into `results`/`windows` |
| `src/svgdraw.ts` | pass `paint` at the one `resolveFilter` call site |
| `test/svg-filter-paint.test.ts` | new |
| `README.md` | "the `BackgroundImage`/`FillPaint` pseudo-inputs make the element draw unfiltered and report" is now half false |

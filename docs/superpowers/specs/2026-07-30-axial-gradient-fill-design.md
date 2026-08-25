# Axial (linear) gradient fills in `PageGraphics` — design

Issue: `aspose-pdf-foss-for-ts-lqp5.1` (epic `lqp5`, vector gradient fills).
Date: 2026-07-30.

Absorbs `lqp5.3` ("gradient color model + stops plumbing"), which is closed as
folded into this issue. The colour model has exactly one consumer today, so
building it here lets a real caller shape it instead of a guessed-at interface.

Parity target: `Aspose-PDF-FOSS-for-Go` `_examples/feature_showcase/main.go`,
which fills with `LinearGradient` / `RadialGradient` over `GradientStops`. Today
`graphics.ts` supports solid fill colours and a constant alpha, nothing else.

## Correcting the premise

The issue reads as new work — "ShadingType 2 axial shading + PdfFunction
stitching from GradientStops". **Most of it already exists.** `svggradient.ts`
(shipped across `1gg0.7`, `1gg0.17`, `1gg0.18`) already contains the stop model,
the offset normalizer, and the type-2-ramps-stitched-into-a-type-3 function
builder, together with its `/DeviceGray` alpha twin. It is covered by 746 lines
of tests.

What it is not is *public*, or *reusable*: the module is SVG-shaped. Its stop
colour is `Rgb` from `svgstyle.ts`, and the file imports `XmlNode`, `CssMap`,
`parseTransform` and `SegBBox`.

So the bulk of this issue is an **extraction and promotion**, plus one genuinely
new piece: getting a registered `/Pattern` resource onto a page and selecting it
from a content stream. Writing a second stitching implementation alongside the
existing one is the main thing this design exists to prevent — a fix to one
would silently miss the other.

## Scope

Axial (`ShadingType 2`) gradient **fills** on `PageGraphics`, with coordinates in
page user space, `/Extend` control, and uniform stop alpha.

Out of scope, each with a reason:

- **Radial fills** — `lqp5.2`, which this unblocks. `RadialGradient` is *declared*
  here so the public union is complete and `lqp5.2` adds no type churn.
- **Varying per-stop alpha** — deferred to a follow-up issue; throws
  `UnsupportedFeatureError`. See "Alpha" below. (Shipped in `lqp5.4`, which
  replaced the throw with the luminosity soft mask designed there.)
- **`setStrokeGradient`** — the issue says fill. Nothing in the design blocks it.

## Module boundaries

```
src/gradient.ts          NEW · pure, imports only types.ts
  GradientStop, LinearGradient, RadialGradient, Gradient
  validateGradient()
  normalizeStops(), stopsFunction(), StopPick, ALPHA     moved from svggradient.ts
  axialShading()                                          geometry -> ShadingType 2 dict

src/svggradient.ts       REFACTORED · SVG parsing only
  imports the core above; keeps resolveGradient, gradientPaint, coord,
  spreadRange, radialSpreadRange, tileStops, patternMatrix

src/pagecontent.ts       + registerShadingPattern(doc, page, dict) -> key

src/graphics.ts          + setFillGradient(g)
src/index.ts             + the public types
```

`gradient.ts` builds **direct** `PdfDict`s and touches no `Document`, preserving
the property `svggradient.ts` has today: the SVG path allocates no indirect
objects. `PageGraphics` allocates freely, but it does so in
`registerShadingPattern`, on the `Document` side of the boundary.

## Public types

```ts
export interface GradientStop {
  offset: number;                    // 0..1, clamped
  color: [number, number, number];   // DeviceRGB
  opacity?: number;                  // default 1
}

export interface LinearGradient {
  kind: 'linear';
  x1: number; y1: number; x2: number; y2: number;   // page user space
  stops: GradientStop[];
  extend?: [boolean, boolean];       // default [true, true]
}

export interface RadialGradient {    // declared now, painted by lqp5.2
  kind: 'radial';
  cx: number; cy: number; r: number;
  fx?: number; fy?: number;          // focal point, defaults to the centre
  stops: GradientStop[];
  extend?: [boolean, boolean];
}

export type Gradient = LinearGradient | RadialGradient;
```

`opacity` is **optional** here and required on `svggradient.ts`'s internal stop,
so its objects still satisfy this type unchanged. Only the two readers —
`ALPHA` and `uniformOpacity` — need a `stopOpacity(s) = s.opacity ?? 1` helper.

`validateGradient` runs to completion before anything is allocated, following the
`formcreate.ts` invariant: a rejected call leaves the document byte-identical.
Empty `stops` throws, unlike SVG, where a stopless gradient is a legal document
that renders nothing.

## `setFillGradient`

1. `validateGradient(g)`.
2. Normalize stops.
3. **Degenerate collapses**, matching `gradientPaint`: fewer than two stops, or
   `x1,y1 == x2,y2`, emits `setFillColor` of the single/last stop and allocates
   no pattern.
4. `axialShading` -> `PatternType 2` wrapper -> `registerShadingPattern` -> emit
   `/Pattern cs` and `/<key> scn`.

`registerShadingPattern` allocates a **fresh** key (`freshKey(pat, 'P')`) per
call and does not deduplicate, unlike `registerExtGState` beside it, which
compares two scalars. A shading pattern nests three dicts deep — `svgdraw.ts`
makes the same call, noting a field-by-field compare would be worse than the
duplication. Callers who want one pattern shared across many fills should call
`setFillGradient` once; and `Optimize()`'s content-hashed stream dedup is the
general answer, not this helper.

### Invariant: gradient coordinates ignore the CTM

A pattern `/Matrix` maps pattern space to the **default** space of the parent
content stream (PDF 32000-1 §8.7.3.1), not the CTM in force when the pattern is
selected. So a `transform()` earlier in the builder moves the *path* and not the
*ramp*:

```ts
g.transform(2, 0, 0, 2, 0, 0);      // does NOT scale the gradient
g.setFillGradient({ kind: 'linear', x1: 100, /* ... */ });
g.rect(50, 50, 100, 50).fill();     // rect scaled, ramp not
```

This is inherent to PDF and is the reverse side of choosing page-user-space
coordinates. It is also load-bearing in our favour: it means `apply()`'s `q/Q`
wrapping and `appendContent`'s stream nesting can never shift a gradient. Pinned
by a test.

## Alpha

| Stops | Emitted |
|---|---|
| all opacity 1 | nothing extra |
| uniform `a < 1` | `registerExtGState(doc, page, a)` + `/GSn gs` |
| varying | `UnsupportedFeatureError` (deferred — `lqp5.4` now emits the soft mask below) |

The uniform-alpha `gs` sets `ca` *and* `CA`, so it **overrides** a caller's
earlier `setOpacity()` rather than multiplying with it. Documented on the method.

### The varying-alpha path (shipped in `lqp5.4`)

Recorded here as designed; `lqp5.4` built it, with one correction below.
`stopsFunction(stops, ALPHA)` already yields the `/DeviceGray` twin with identical `/Bounds` and
`/Encode`, which is what makes a mask line up with the colour it masks. That gray
pattern is painted into a Form XObject with `/Group << /S /Transparency /CS
/DeviceGray >>` and referenced from `/SMask << /S /Luminosity /G form >>` — the
shape `maskGroup` in `svgdraw.ts` already has, liftable into a
`registerSoftMaskExtGState` helper.

Its `/BBox` should be the **page MediaBox**. `svgdraw` uses the shape bbox, but
`PageGraphics` deliberately tracks no paths. MediaBox is correct rather than
merely convenient: with `/Extend [true true]` the gray pattern covers the whole
plane, and where extend is off the unpainted area gives luminosity 0 — masked
out, matching the colour pattern being unpainted there too. `/BC` defaults to
black, which agrees.

Nothing about the public type shape changes when this lands — and nothing did.

**Correction found while building it: the mask group needs the inverse CTM as its
`/Matrix`.** The design above assumed the mask lands where the colour does, but
the two are placed by different rules. A shading pattern is pinned to the content
stream's *default* space (the invariant above), while a soft-mask group renders
under the CTM in force where its `gs` executes (§11.6.5.2). So a caller's
`transform()` scales the mask and not the colour, and the ramp fades along the
wrong axis — invisible to any fixture that does not transform first.
`PageGraphics` therefore tracks its own CTM (a matrix plus a `save`/`restore`
stack, used for nothing else) and hands `registerSoftMaskExtGState` the inverse.
That is also what makes the MediaBox `/BBox` correct, since `/BBox` is read in
the space `/Matrix` establishes.

## Testing

**The extraction is lossless.** `svg-gradient.test.ts` and
`svg-gradient-render.test.ts` stay green with only import paths changed, and zero
assertion edits. An assertion that *has* to change means the extraction changed
behaviour — stop and report it rather than editing the test.

**`test/gradient.test.ts`** (new) — the pure core: `normalizeStops` (offsets
forced non-decreasing, endpoints padded, doubled offsets kept), `stopsFunction`
(one interval -> bare type 2; more -> type 3 with strictly increasing `/Bounds`;
zero-width intervals contribute no sub-function), `validateGradient` rejections,
`axialShading` geometry.

**`test/graphics.test.ts`** (additions, existing style) — `/Pattern cs` + `/P0
scn` emitted; the page `/Resources /Pattern` entry resolves to a `PatternType 2`
with `ShadingType 2` and the right `/Coords`; both degenerate collapses emit
plain `rg` and allocate no pattern; a rejected gradient leaves the document
byte-identical; uniform alpha emits a `gs`; varying alpha throws; the CTM
invariant above.

**One end-to-end render test** — `ToImage` a gradient-filled rect and sample
pixels along the axis (red at the start, blue at the end, mixed in the middle).
The only test that exercises the whole chain, and the one that catches a wrong
`/Matrix`. The renderers already resolve `PatternType 2`
(`pagerender.ts:136`), so this needs no new rendering support.

**Mutation check.** Per CLAUDE.md, passing on the first run is not evidence.
Break each path deliberately — swap the `/Coords` endpoints, drop the `/Bounds`
sort, skip the pattern registration — and confirm the suite goes red before
closing.

## Follow-ups to file

- ~~Varying per-stop alpha via a luminosity soft mask~~ — filed as `lqp5.4`,
  shipped.
- `setStrokeGradient`, if a caller wants it — filed as `menf`, designed in
  `2026-08-04-stroke-gradient-design.md`.

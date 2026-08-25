# SVG `<mask>`, `<filter>` and markers — design

Issue: `aspose-pdf-foss-for-ts-1gg0.10` (epic `1gg0`, page-furniture &
text-authoring parity gaps). Date: 2026-07-30.

Deferred from `1gg0.3`, which shipped `page.AddSVGObject`; see
`2026-07-28-svg-embedding-design.md`. Today `<mask>`, `<filter>` and `<marker>`
all fall into `walk`'s "not `STRUCTURAL`, not a shape" branch
(`src/svgdraw.ts`), so the element name lands in `result.skipped` and nothing is
drawn. The `mask=`, `filter=` and `marker-start` / `-mid` / `-end` properties are
not read at all.

## Scope

All three features, in full:

- **`<mask>`** — luminance and alpha masking of any shape or group, through a PDF
  soft mask. Exact.
- **Markers** — `marker-start` / `marker-mid` / `marker-end` (and the `marker`
  shorthand) on `path`, `line`, `polyline`, `polygon`. Exact.
- **`<filter>`** — every SVG 1.1 filter primitive plus `feDropShadow`, rendered
  by rasterizing the filtered subtree and running the primitive graph in pixel
  space, with a narrow set of vector fast paths for chains that map to PDF
  exactly.

Out of scope: group `opacity` as a true transparency group (issue `1gg0.12` —
still folded into child alphas by `svgstyle.ts`), `textPath` (`1gg0.20`), and the
two `<image>` follow-ups (`1gg0.21`, `1gg0.22`). `BackgroundImage` /
`BackgroundAlpha` filter inputs are reported, not implemented; see "Pseudo-inputs".

## The constraint that shapes the work

`src/svgdraw.ts` allocates nothing. Streams reach it through `SvgStreamSink`,
image XObjects through `SvgImageSink`, fonts through `SvgFontProvider` — all
implemented by `src/svgembed.ts`, the only module in the SVG stack that touches a
`Document`. Everything below preserves that: the new geometry, graph and pixel
modules are pure, and one new sink (`SvgRasterSink`) carries the single new
capability that needs a `Document`.

Content is emitted in **viewBox units with y pointing DOWN**; the flip to PDF's
y-up happens once, in `svgtransform.ts`'s `placementMatrix`. Mask groups, marker
forms and rasterized filter output all live in that same y-down space.

## Rendering order

SVG's rendering model applies, per element:

```
filter  →  clip-path  →  mask  →  opacity
```

Filter comes **first** and replaces the subtree with an image, so a `clip-path`
on a filtered group clips the bitmap, not the source geometry. Today
`clip-path` opens the outer `q`/`Q` in `walk`; the mask nests inside it, and the
filter wraps the whole thing.

## Modules

| Module | New? | Responsibility |
|---|---|---|
| `src/svgmask.ts` | new | Resolve a `<mask>`: `maskUnits`, `maskContentUnits`, the default region, luminance vs alpha. Pure; returns a descriptor. |
| `src/svgmarker.ts` | new | Vertices + tangent angles from `SvgSeg[]`; the per-vertex placement matrix. Pure geometry. |
| `src/svgfilter.ts` | new | Parse `<filter>` into a primitive graph; resolve the filter region and per-primitive subregions; classify the chain (fast path vs raster). No pixels. |
| `src/svgfilterfx.ts` | new | The `Surface` type, the sRGB↔linear edge conversions, and the pixel kernels: blur, offset, flood, blend, composite, colorMatrix, componentTransfer, morphology, tile, merge, convolveMatrix, displacementMap. |
| `src/svgfilterlight.ts` | new | `feDiffuseLighting` / `feSpecularLighting` and the three light sources. Its own file: the surface-normal Sobel kernels plus the light model would double `svgfilterfx.ts`. |
| `src/svgfilternoise.ts` | new | `feTurbulence` — the SVG 1.1 Perlin generator. Self-contained, likewise its own file. |
| `src/svgdraw.ts` | changed | Wiring: the three properties, the group-ify helper, the `DEFINITION` additions, `gsKey`'s soft-mask subtype. |
| `src/svgembed.ts` | changed | Implements `SvgRasterSink`; validates and forwards `filterScale`; surfaces `rasterized`. |
| `src/svgstyle.ts` | changed | `marker-start` / `-mid` / `-end` / `marker` on `Paint` (they inherit). |
| `src/raster.ts` | changed | One new export: `rasterizeFormRgba`. |

`<mask>`, `<filter>` and `<marker>` all join `DEFINITION` in `svgdraw.ts`, so
they render nothing where they sit and are never reported for merely existing.

---

## 1. `<mask>`

### Region

`maskUnits` (default `objectBoundingBox`) governs `x` / `y` / `width` /
`height`, which default to `-10%`, `-10%`, `120%`, `120%` — the 10% bleed that
lets a blurred or stroked mask reach past the element's box. `userSpaceOnUse`
takes the values as literal user units.

`maskContentUnits` (default `userSpaceOnUse`) governs the children;
`objectBoundingBox` prepends the bbox transform `[w 0 0 h x y]`.

The resolved region becomes the group's `/BBox`, which gives SVG's "mask content
outside the region is clipped" for free.

### PDF mapping

```
/ExtGState << /Type /ExtGState /ca … /CA …
              /SMask << /S /Luminosity /G «group ref» /BC [0] >> >>
```

with

```
/Type /XObject /Subtype /Form /FormType 1
/Matrix    [1 0 0 1 0 0]
/BBox      [x y x+w y+h]
/Group     << /Type /Group /S /Transparency /CS /DeviceGray >>
/Resources «the mask content's own resources»
content:   «the mask's children, walked»
```

**Why this is exact, not an approximation.** SVG defines the mask value as
`luminance × alpha`. A PDF luminosity group composited over a black backdrop
scales colour by alpha, and luminance is linear, so
`luminance(C·α) = luminance(C)·α` — the two definitions coincide. `/BC [0]` is
the `/DeviceGray` default, stated explicitly because the mask region is finite
here (unlike the gradient ramp case in `1gg0.17`, where `/Extend` meant the
backdrop was never sampled) and content may genuinely fall short of `/BBox`.

`mask-type: alpha` and CSS `mask-mode: alpha` map to `/S /Alpha`, with a
`/DeviceRGB` group colour space. Supporting it costs one branch, so it is in.

### The group-ify helper

A single `gs` holds at most one `/SMask`, and a varying-alpha gradient already
claims that slot (`resolvePaint` in `svgdraw.ts`). A masked element therefore
paints into its **own transparency-group Form XObject**, and the mask applies to
the `Do`:

```
q
  /GSn gs            % the mask
  /Fmn Do
Q
```

This is uniform across a masked shape, a masked `<g>`, and a mask whose own
children are masked; it keeps the gradient ramp working *inside* the group; and
it is the same helper `<filter>` needs and that `1gg0.12` (group opacity) will
need. An unmasked, unfiltered shape still paints inline exactly as today — no
regression in output for the overwhelmingly common case.

Cost: one extra Form XObject per masked element. Accepted.

### Mechanics

- `gsKey(ca, CA, smask?)` grows a subtype parameter; the existing gradient-ramp
  callers keep `Luminosity`. The canonical-key cache still distinguishes states
  correctly because the subtype is part of the dict it hashes.
- A mask group is a separate content stream with its own `/Resources`, so it is
  built with `e.child()` + `streams.stream`, exactly like a pattern tile.
- `activeMasks`, shared with every child emitter, breaks reference cycles —
  mirroring `activePatterns`.
- The existing `e.masks` map (canonical dict → ref) already caches by content, so
  two elements sharing one `<mask>` allocate one group.

### Reporting

A resolvable `<mask>` reports nothing. A `mask=` whose target is missing or is
not a `<mask>` element draws **unmasked** and reports `url()` — matching how
`emitClip` already handles an unresolvable `clip-path`, and preferring visible
wrong-but-present ink to silently dropped content.

---

## 2. Markers

### Properties

`marker-start`, `marker-mid`, `marker-end`, plus the `marker` shorthand which
sets all three. They are inherited properties, so they go on `Paint` as three
nullable ids and travel through the existing `resolveStyle` cascade — presentation
attribute, inline `style=`, and stylesheet all work with no extra code.

They apply to `path`, `line`, `polyline` and `polygon` only (SVG 1.1 §11.6.2),
and are ignored elsewhere.

### `<marker>` attributes

| Attribute | Default | Effect |
|---|---|---|
| `markerWidth` / `markerHeight` | 3 | Viewport size the content is fitted into. |
| `refX` / `refY` | 0 | The point, in viewBox coordinates, aligned to the vertex. |
| `markerUnits` | `strokeWidth` | `strokeWidth` scales by the element's stroke width; `userSpaceOnUse` does not. |
| `orient` | `0` | `auto`, `auto-start-reverse`, or an angle in degrees. |
| `viewBox` + `preserveAspectRatio` | — | Standard viewport mapping, via `svgtransform.ts`. |
| `overflow` | `hidden` | Clip to the viewBox rect, or `(0, 0, markerWidth, markerHeight)` with no viewBox. |

### Vertices and angles

`SvgSeg[]` is already flattened to `M` / `L` / `C` / `Z`, so every shape and every
path command — arcs included — reaches this uniformly. `svgmarker.ts` walks the
segments and emits `{ x, y, angle, kind: 'start' | 'mid' | 'end' }`:

- **start** — the first vertex of the **whole path**, with the **outgoing**
  tangent. Not per subpath: SVG 1.1 §11.6.2 defines it as "the first vertex of the
  given `path` element or basic shape", so a two-subpath path gets exactly one
  start marker, and the second subpath's opening vertex is a **mid**.
- **end** — the last vertex of the whole path, with the **incoming** tangent.
- **mid** — every interior vertex, with the **bisector** of incoming and outgoing
  tangents (`atan2` of the summed unit vectors, not the average of two angles —
  averaging is discontinuous across ±180°). When the two unit vectors cancel
  exactly (a perfect reversal), the sum is the zero vector and has no angle; fall
  back to the incoming tangent.
- A Bézier's tangent comes from its first or last **non-degenerate control leg**,
  not from the chord: a curve whose first control point coincides with its start
  point must fall through to the next leg.
- Zero-length segments are skipped when seeking a tangent, so an `L` to the
  current point cannot yield an undefined angle.
- `Z` (closepath) appends the subpath's start point as a further vertex, so a
  closed triangle yields four: start, mid, mid, and the closing one. That closing
  vertex's angle is the **bisector** of the closing incoming tangent and the
  subpath's initial outgoing tangent — the tangent wraps round, rather than
  stopping dead as an open path's would.

### A shared length resolver

`maskUnits` / `maskContentUnits` need exactly the objectBoundingBox-vs-userSpaceOnUse
length rule that `svgpattern.ts`'s private `len()` already implements, and that
`svggradient.ts` has a near-copy of. A third copy is the point at which it earns
extraction: it moves to `svgtransform.ts` — which already owns the shared unit and
viewport helpers (`parseViewBox`, `fitBox`) and is already imported by
`svgpattern.ts` — as

```ts
export function unitLength(
  v: string | undefined, dflt: number, obb: boolean, span: number,
): number;
```

`svgpattern.ts` switches to it, with its tests unchanged as the proof. `svggradient.ts`
keeps its own: that one resolves gradient *coordinates* against a different rule,
and merging them would mean a parameter that only ever has one caller per value.

### Placement matrix

Per vertex, right-to-left in PDF's convention:

```
translate(vx, vy) · rotate(θ) · scale(sw) · translate(−refX′, −refY′) · vbMatrix
```

where `sw` is the element's `stroke-width` under `markerUnits: strokeWidth` (else
1), `vbMatrix` is the viewBox → `(markerWidth, markerHeight)` mapping, and
`(refX′, refY′)` is `(refX, refY)` **mapped through `vbMatrix`**. That last point
is the one implementations routinely get wrong — `refX` is in viewBox
coordinates, not viewport coordinates — so it gets its own direct test with a
non-identity viewBox scale.

`orient: auto-start-reverse` adds 180° to a start marker's θ only.

### Emission

The marker subtree becomes **one Form XObject per (marker, element)**, `Do`'d
once per vertex:

```
q  «placement cm»  /Fmn Do  Q
```

A 500-vertex polyline then emits 500 short blocks rather than 500 copies of the
artwork. One form serves all of an element's vertices because the `strokeWidth`
scale is per-element, not per-vertex — but a *different* element with a different
stroke width needs its own, hence the key is the pair. The `overflow: hidden`
clip is baked into the form's `/BBox`.

Marker content does **not** inherit from the referencing element: it resolves
from `INITIAL` down the `<marker>` element itself, exactly as `tilingFor` does
for a pattern tile.

### Reporting

A resolvable marker reports nothing. A missing or non-`<marker>` target reports
`url()` and draws the path without markers.

---

## 3. `<filter>`

### Region and graph

`svgfilter.ts` turns the element into a graph, with no pixels involved:

- `filterUnits` (default `objectBoundingBox`) resolves `x` / `y` / `width` /
  `height`, defaulting to `-10%`, `-10%`, `120%`, `120%`.
- `primitiveUnits` (default `userSpaceOnUse`) resolves each primitive's own
  `x` / `y` / `width` / `height` subregion and its length-valued parameters
  (`stdDeviation`, `dx`/`dy`, `radius`, …).
- Primitives run in document order. `in` defaults to the previous primitive's
  `result`, or to `SourceGraphic` for the first. A named `result` is visible to
  every later primitive.
- `filterRes`, deprecated but honoured, caps the raster resolution.
- A zero or negative `width`/`height` on the filter region disables rendering of
  the element entirely (SVG 1.1 §15.7.2) — the element draws nothing, and this is
  the author's choice, so it is **not** reported.

### Primitives

All of SVG 1.1, plus `feDropShadow` from Filter Effects 1 (a shorthand for
offset + blur + flood + composite, and by far the most common filter in
real-world assets):

`feBlend`, `feColorMatrix`, `feComponentTransfer` (with `feFuncR`/`G`/`B`/`A`:
`identity`, `table`, `discrete`, `linear`, `gamma`), `feComposite` (`over`, `in`,
`out`, `atop`, `xor`, `arithmetic`), `feConvolveMatrix`, `feDiffuseLighting`,
`feDisplacementMap`, `feDropShadow`, `feFlood`, `feGaussianBlur`, `feImage`,
`feMerge` (+ `feMergeNode`), `feMorphology` (`dilate`, `erode`), `feOffset`,
`feSpecularLighting`, `feTile`, `feTurbulence` (`fractalNoise`, `turbulence`), and
the light sources `feDistantLight`, `fePointLight`, `feSpotLight`.

`feGaussianBlur` uses the spec's three-successive-box-blur approximation for
`stdDeviation ≥ 2.0` and a true Gaussian kernel below it, which is what the spec
prescribes and what browsers do.

### Pseudo-inputs

- `SourceGraphic`, `SourceAlpha` — implemented.
- `FillPaint`, `StrokePaint` — infinite planes of the element's paint.
  Implemented for solid paint; a gradient or pattern reports `filter` and the
  primitive falls back to transparent black.
- `BackgroundImage`, `BackgroundAlpha` — **reported, not implemented.** They
  require the accumulated page backdrop, which our single-pass walker does not
  retain, and which no shipping browser has ever implemented either.

### Colour space

`color-interpolation-filters` defaults to **linearRGB** in SVG 1.1, and is a
per-primitive property. Kernels operate on **premultiplied linear RGBA**
(`Float32Array`); sRGB→linear conversion happens on ingest and linear→sRGB on
emit, per primitive as the property dictates.

This is in from the first phase rather than retrofitted: getting it wrong makes
every blur and every composite visibly disagree with a browser, and a retrofit
would mean re-deriving every kernel's test expectations.

### Surface model

```ts
interface Surface {
  /** Device-space origin — a surface is a window onto the filter region, not
   *  its own coordinate system. Mirrors raster.ts's Canvas.originX/Y. */
  x: number; y: number;
  w: number; h: number;
  /** Premultiplied linear RGBA, 0..1, row-major. */
  data: Float32Array;
}
```

Every kernel is a pure function from one or two `Surface`s plus parameters to a
new `Surface`. No kernel knows anything about PDF, SVG, or the `Document`.

### The raster path

1. Build the filtered subtree as a Form XObject over the filter region
   (`e.child()` + `streams.stream`, as for a pattern tile).
2. Rasterize it at `filterScale` × the placed device size, through the new sink.
3. Run the graph, kernel by kernel.
4. Emit the final surface as an Image XObject: `DeviceRGB` plus an `/SMask` for
   the alpha channel, exactly as `imageembed.ts` does for a PNG.
5. Draw it at the filter region rect.

#### How the walker learns the device size (decided 2026-07-31)

`drawSvg` has never known where its content lands: `svgembed.ts` owns
`placementMatrix`, and the walker emits viewBox units. The raster path is the
first thing in the stack that needs a pixel count, so `drawSvg` gains one
**scalar** parameter, `deviceScale` — points-per-user-unit, computed by
`svgembed.ts` as `sqrt(|det|)` of the placement matrix. The walker multiplies it
by `ctmScale(here)` at the filtered element and by `filterScale` to size the
raster.

A scalar, not the matrix: passing the matrix would put placement knowledge inside
a walker that has deliberately never had any, and would tempt later code to use
it for geometry. The cost is that anisotropic `fit: 'fill'` rasterizes at the
geometric mean of the two axis scales rather than per-axis — a resolution choice,
never a geometry one, and the same compromise `ctmScale` already makes for
stroke flattening in `strokegeom.ts`.

#### Emitting the surface (decided 2026-07-31)

The final surface becomes a `BuiltImage` directly: an 8-bit `DeviceRGB`
`FlateDecode` stream plus an 8-bit `DeviceGray` `/SMask`, built by a pure
function in `svgfilterfx.ts` and allocated through the **existing**
`SvgImageSink` — which already handles the `/SMask` allocation for `<image>`.

Not a PNG round trip through `buildImageXObject`: encoding our own pixels only to
re-parse them costs two full passes and a PNG predictor search for no fidelity we
did not already have. `imageembed.ts` is for bytes we did not produce; these are
ours.

### Phase 4 decisions (decided 2026-07-31)

**`feTurbulence` and lighting are validated against browsers, not against
themselves.** `feTurbulence` is a *published reference implementation*: porting
the spec's C and asserting against values derived from the same C proves
nothing, which is exactly the cancellation CLAUDE.md's differential rule warns
about. A new `scripts/gen-filter-goldens.ts` — mirroring `gen-svg-goldens.ts`,
including its no-runtime-dependency discipline and its `PROVENANCE.md` — renders
the fixtures in headless Chrome and commits the pixels to
`test/fixtures/svg-filter/`.

**Two constraints, both measured rather than assumed** (2026-07-31, on Chrome
150 headless-shell and `@resvg/resvg-js` 2.6.2):

- **The turbulence goldens must use a LOW `baseFrequency`.** Chrome and resvg
  disagree on high-frequency noise by far more than a tolerance can absorb, and
  the disagreement scales smoothly with frequency: at `baseFrequency` 0.5 the
  mean channel difference is 30.9/255, at 0.15 it is 12.0, at 0.05 it is 3.8,
  and at 0.02 it is 1.7. Both engines implement the same noise function; what
  differs is *where each samples it*, and high-frequency noise is maximally
  sensitive to a sub-pixel offset. Fixtures therefore stay at `baseFrequency
  ≤ 0.05`, where the large-scale structure a wrong lattice or gradient table
  would destroy is still fully exercised — and where OUR raster's own sampling
  offset does not swamp the comparison either.
- **resvg cannot cross-check the lighting primitives at all.** It panics inside
  `resvg/src/filter/lighting.rs` (`assertion failed: src.width == dest.width`),
  and the panic aborts the process rather than raising catchably, so the
  generator must not invoke it for those fixtures. Lighting goldens come from
  Chrome alone; `PROVENANCE.md` records that as a stated gap in independence,
  not an oversight. Turbulence keeps the two-engine gate.

Lighting fixture constants are chosen to stay *discriminating*: a white light at
`specularExponent="20"` saturates to two distinct output levels, which would
pass against almost any implementation. Prefer parameters that produce a visible
gradient across the surface.

The other three kernels need no goldens: `feConvolveMatrix` on a known kernel,
`feDisplacementMap` on a known displacement, and `feImage` on a known raster all
have exactly enumerable results.

**`feImage` resolves same-document element references as well as `data:` URI
rasters.** Both are pre-rasterized on the *impure* side and handed to the graph
as ready-made surfaces, so `svgfilterfx.ts` still rasterizes nothing:

- `runFilter` gains an `extras: Map<string, Surface>` parameter, keyed by the
  primitive's `result`. `feImage`'s kernel only places what it is given.
- `emitFiltered` fills that map before running the graph. Both reference kinds
  reuse the **existing** `SvgRasterSink.rasterize` — an element reference by
  walking the referenced subtree into a form, a `data:` URI by building a
  one-operator form that draws the decoded Image XObject. One seam, two
  producers, no new sink method.
- An external href, or a reference that resolves to nothing, reports `filter`
  and draws the element unfiltered — the same refusal `<image>` already gives a
  non-`data:` href.
- The `<use>` cycle guard covers an `feImage` whose target carries the same
  filter, since the walk runs through `walk` as usual.

**Lighting uses the spec's nine surface-normal kernels.** SVG 1.1 §15.7.16
publishes distinct Sobel coefficients for the interior, the four corners and the
four edges. The one-pixel border is where a lit bevel is most visible, so the
interior-kernel-everywhere shortcut is not taken.

### Phase 3 staging (decided 2026-07-31)

`1gg0.10.3` stays one issue, landed as three commits, each green on
`npm run typecheck` and `npm test`:

- **A — the graph.** `svgfilter.ts` alone: parse, filter region, per-primitive
  subregions, `primitiveUnits`, `in`/`result` wiring, unsupported-primitive
  reporting. Pure, no pixels, no walker change.
- **B — the seam.** `rasterizeFormRgba`, `SvgRasterSink`, the `Surface` type and
  its sRGB↔linear edges, `deviceScale`, the image emit, `filterScale`,
  `rasterized[]`, and the walker wiring — carrying only `feFlood` and `feOffset`,
  the two kernels that need no new machinery. End-to-end ink through `ToImage` at
  the end of this commit.
- **C — the kernels.** `feMerge`, `feBlend`, `feComposite`, `feColorMatrix`,
  `feComponentTransfer`, `feGaussianBlur`, `feDropShadow`, `feMorphology`,
  `feTile`, against the external references below.

### The new seam

```ts
/** Rasterize a content stream to RGBA. svgembed.ts implements it, because only
 *  it may allocate; mirrors SvgStreamSink and SvgImageSink, for the same
 *  reason.
 *
 *  Returns raster.ts's own ImageRgba — straight-alpha sRGB bytes — NOT a
 *  Surface. The sink stays in the rasterizer's vocabulary; converting to
 *  premultiplied linear Float32 is the filter pipeline's job, and belongs on the
 *  pure side of the seam where it is testable without a Document. */
export interface SvgRasterSink {
  rasterize(dict: PdfDict, content: string, devW: number, devH: number): ImageRgba | null;
}
```

`devW`/`devH` are decided on the pure side, from `deviceScale` (above) — the sink
renders what it is told to and makes no resolution policy of its own.

`svgfilterfx.ts` owns the two conversions at the pipeline's edges —
`toSurface(ImageRgba)` on ingest (unpremultiply-free: it premultiplies and
linearizes) and `fromSurface(Surface)` on emit (linear→sRGB, then split into RGB
bytes and an alpha plane for the `/SMask`). Both are pure and directly tested,
including the round trip.

`svgembed.ts` implements it over **one new export in `raster.ts`**:

```ts
export function rasterizeFormRgba(
  doc: Document, form: PdfStream, matrix: Matrix, devW: number, devH: number,
): ImageRgba;
```

which is `renderPageToPng`'s body minus the PNG encode, driven over a scratch
page — `new Page(doc, dict, 1)` on an unlinked dict carrying `/MediaBox`,
`/Contents` and `/Resources`. `Canvas` and `RasterSink` stay private to
`raster.ts`; the scratch page is never added to the page tree and never reached
by `Save`'s mark-sweep except through the form it references.

Returning `null` from the sink (an allocation or render failure) makes the
element fall back to drawing **unfiltered** and reports `filter`.

### Vector fast paths

Deliberately narrow. A chain qualifies only when it is a **single** primitive
that is exactly representable:

| Chain | Emission |
|---|---|
| lone `feOffset` | `q dx dy cm … Q` around the subtree |
| lone `feFlood`, no input dependency | fill the subregion with `flood-color × flood-opacity` |
| lone `feBlend` with `in` = `SourceGraphic` and `in2` = an `feFlood` | `/ExtGState /BM` |

`svgfilter.ts` exposes this as `classify()` returning a **discriminated union**,
so `walk` cannot fall into the wrong branch by forgetting a check. Anything not
in the table rasterizes.

Each fast path is tested by rendering it *and* the raster path and asserting the
two agree within tolerance. The raster path is the reference implementation; this
is the only way a second code path stays honest.

### Public API

```ts
interface AddSVGOptions {
  /** Resolution multiplier for a rasterized <filter>: a multiple of the placed
   *  device size. Default 2 (≈144 DPI at 1:1 placement). Capped at 8. */
  filterScale?: number;
}

interface AddSVGResult {
  /** Distinct element names whose subtree was flattened to a bitmap, sorted.
   *  Not a fidelity loss like `skipped` — the content renders correctly — but
   *  it is resolution-bound, and its text is no longer extractable. */
  rasterized: string[];
}
```

`filterScale` is validated in `addSvgObject` before anything is allocated, like
every other option: finite, `> 0`, `≤ 8`, else `TypeError`. The cap exists so a
typo cannot ask for gigabytes of `Float32Array`.

`skipped` keeps its meaning — an unsupported primitive, an unresolvable `in`, a
`BackgroundImage` input, a gradient `FillPaint`. A fully supported filter chain
reports `filter` in `rasterized` and nothing in `skipped`.

---

## Errors

No new error types. Consistent with the rest of the SVG stack:

- Bad option values throw `TypeError` from `addSvgObject`, before allocation, so
  a rejected call leaves the document byte-identical.
- Anything unrenderable degrades and is reported through `skipped`. A malformed
  `<filter>`, an unresolvable reference, a cycle, or a failed rasterization never
  throws.

## Phases

Each phase lands green — `npm run typecheck` and `npm test` — and is committed on
its own, with README updated in step.

1. **`<mask>`** — `svgmask.ts`, the group-ify helper, `gsKey`'s subtype,
   luminosity + alpha, `maskUnits` / `maskContentUnits`, nesting, the cycle
   guard, order against `clip-path`.
2. **Markers** — `svgmarker.ts` geometry, `svgstyle.ts` properties, the
   per-(marker, element) form XObject wiring.
3. **Filter infrastructure** — graph parse, region and subregions,
   `primitiveUnits`, the linearRGB pipeline, `rasterizeFormRgba`, the
   `SvgRasterSink` seam, image embedding, `filterScale`, `rasterized[]`, and the
   kernels that need no new machinery: `feFlood`, `feOffset`, `feMerge`,
   `feBlend`, `feComposite`, `feColorMatrix`, `feComponentTransfer`,
   `feGaussianBlur`, `feDropShadow`, `feMorphology`, `feTile`. Landed as three
   commits — see "Phase 3 staging".
4. **Remaining kernels** — `feConvolveMatrix`, `feDisplacementMap`, `feImage`,
   `svgfilternoise.ts` (`feTurbulence`), `svgfilterlight.ts`
   (`feDiffuseLighting` / `feSpecularLighting` × the three light sources).
5. **Vector fast paths** — last, so the raster path already exists as the
   reference to diff against.

## Testing

Pure unit tests per module, mirroring the existing `test/svg-*.test.ts` split;
end-to-end tests through `Save` / `Open` / `ToImage`, mirroring
`test/svg-*-render.test.ts`; fixture builders in `test/helpers/`.

| File | Covers |
|---|---|
| `test/svg-mask.test.ts` | Region resolution under both `maskUnits` values, `maskContentUnits`, the `/SMask` dict shape, `/S /Alpha` for `mask-type`, nesting, cycle guard, group reuse, unresolvable target draws unmasked. |
| `test/svg-mask-render.test.ts` | A mask actually masks: pixel assertions through `ToImage`. |
| `test/svg-marker.test.ts` | Vertex and angle extraction (bisectors, degenerate segments, degenerate control legs, `h` wrap, multi-subpath), the placement matrix with a non-identity viewBox, `markerUnits`, `orient` including `auto-start-reverse`, `overflow` clip. |
| `test/svg-marker-render.test.ts` | Markers appear at the right places, at the right rotation. |
| `test/svg-filter.test.ts` | Graph wiring (implicit `in`, named `result`, forward reference), region and subregion resolution, `primitiveUnits`, `classify()`'s union, unsupported-primitive reporting, zero-area region draws nothing without reporting. |
| `test/svg-filterfx.test.ts` | Each kernel, against external references (below). |
| `test/svg-filterlight.test.ts` | Surface normals and the three light sources. |
| `test/svg-filternoise.test.ts` | `feTurbulence` against the spec's reference values. |
| `test/svg-filter-render.test.ts` | End-to-end: `filterScale` changes the image dimensions, `rasterized` is populated, the image carries an `/SMask`, and each vector fast path matches its raster equivalent within tolerance. |

**External references for the kernels.** CLAUDE.md's rule applies: a
differential test cannot validate the code it runs through, so kernel
expectations must come from outside our own implementation.

- A blurred delta must sum to 1, and match the closed-form three-box weights the
  spec prescribes for the chosen `stdDeviation`.
- `feColorMatrix type="saturate" values="0"` must equal the spec's luminance
  coefficients (0.2126, 0.7152, 0.0722) applied to the source.
- `feComposite` must match the Porter-Duff algebra term by term.
- `feTurbulence` must match values produced by the spec's published reference
  implementation, not by ours.
- `feMorphology` on a known binary shape has an exactly enumerable result.

**Mutation check per phase.** Per CLAUDE.md, a fixture that passes first time is
not evidence. Each phase breaks the code path it claims to cover and confirms the
suite goes red before the issue is closed.

## Documentation

`README.md`'s SVG embedding bullet gains: masks (exact, luminance and alpha),
markers (all attributes), and filters — with the resolution-bound and
text-not-extractable consequences of rasterization stated plainly, alongside
`filterScale` and `rasterized`.

## Bookkeeping

`1gg0.10` remains the issue of record for all three features, with five children
filed under it for the phases above — the repo convention is one issue per landed
feature, and each phase is independently shippable. Scope is unchanged.

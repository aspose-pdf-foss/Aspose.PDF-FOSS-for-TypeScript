# SVG gradients: luminosity `/SMask` for varying `stop-opacity` — design

Issue: `aspose-pdf-foss-for-ts-1gg0.17` (epic `1gg0`, page-furniture & text-authoring
parity gaps). Date: 2026-07-30.

Follow-up to `1gg0.7`, which shipped `linearGradient` / `radialGradient` as PDF
shading patterns and deliberately deferred this case; see
`2026-07-28-svg-gradients-design.md`, "Opacity". Today a gradient whose stops
carry *differing* `stop-opacity` values paints opaque, and the element's name is
added to `skipped`. A *uniform* `stop-opacity` is already exact: it folds into the
`/ca` + `/CA` `ExtGState` the walker builds.

## Scope

Exact per-stop alpha for `linearGradient` and `radialGradient`, on `fill` and on
`stroke`, on shapes and on `<text>`, through a luminosity soft mask.

Everything the gradient mapping already supports comes along unchanged, because
the mask is built from the same normalized stop list: `gradientUnits`,
`gradientTransform`, `spreadMethod` (including the `reflect` / `repeat` tiling),
`href` reuse, and hard stops.

Out of scope, unchanged from `1gg0.7`: radial `reflect` / `repeat` (still padded
and reported), and the group-`opacity` approximation.

## Mechanism

A varying alpha ramp becomes an `ExtGState` `/SMask`:

```
<< /Type /ExtGState /ca … /CA …
   /SMask << /S /Luminosity /G «form ref» >> >>
```

whose `/G` is a transparency-group Form XObject holding one rectangle painted
with a **grayscale twin of the colour shading**:

```
/Type /XObject /Subtype /Form /FormType 1
/Matrix    [1 0 0 1 0 0]
/BBox      [x y x+w y+h]
/Group     << /Type /Group /S /Transparency /CS /DeviceGray >>
/Resources << /Pattern << /P0 «alphaPattern» >> >>

content:   /Pattern cs /P0 scn
           x y w h re
           f
```

Luminosity of a `/DeviceGray` value *g* is *g*, so a stop's alpha maps to a gray
level directly.

No `/BC`. The default backdrop for a `/DeviceGray` group is already black, and
`/Extend [true true]` means the shading covers the whole rectangle anyway, so the
backdrop is never sampled.

### Rectangle, not geometry

The mask group paints a plain rectangle rather than re-painting the shape in
gray. Re-painting the geometry would give exact ink coverage, but the mask group
would then need stroke parameters, the fill rule, and — for `<text>` — the entire
font resource set, all to compute a mask that is never sampled outside the ink in
the first place.

That last point is what makes the rectangle safe, and it is worth stating
plainly: **the mask value outside the painted ink is never consulted**, so
over-covering costs nothing and under-covering is the only failure. The rectangle
is therefore the shape's own bbox (`segsBBox`, or `glyphsBBox` for text),
inflated on a stroking pass by

```
strokeWidth * max(1, miterLimit) / 2
```

which is the exact upper bound on how far a projecting cap or a miter join
reaches beyond the path.

### The mask's pattern matrix

`/Matrix` on the group is identity, so the group's content space is **element user
space** — the group is rendered under the CTM that was in force when the `gs`
executed (PDF 32000-1 §11.6.5), and that CTM is the walker's accumulated matrix
at the element, because `walk` emits the element's `cm` before `paintShape` runs.

A pattern used inside a form maps to *that form's* default space, not the page's.
So the alpha pattern's matrix is the colour pattern's **without** the element CTM:

```
alpha  /Matrix = mul(gradientTransform, bboxMatrix)
colour /Matrix = mul(mul(gradientTransform, bboxMatrix), elementCtm)
```

This is the same cancellation `spreadRange` already relies on, and the same
property of the renderer (`pagerender.ts` takes `baseCtm` from the enclosing
stream's initial CTM) that makes today's colour pattern land correctly. The
end-to-end test nests the case in a `<g transform>` so a stray CTM factor shows
up as a visibly displaced ramp rather than as nothing at all.

## Modules

### `src/svggradient.ts`

Two generalizations, both small, plus one field.

- `stopsFunction(stops, pick)` gains a projection from a stop to a colour vector.
  It defaults to the stop's RGB; the alpha twin passes `s => [s.opacity]`.
  Offsets alone decide the function's *shape*, so the colour and alpha functions
  get identical `/Bounds` and `/Encode` by construction — including across a hard
  stop (a doubled offset, whose zero-width interval is dropped by the same rule in
  both) and including the copies `tileStops` synthesizes for `reflect` / `repeat`,
  since each tiled stop already carries its opacity.
- `patternOf(entries, matrix, cs)` gains a colour space: `/DeviceRGB` or
  `/DeviceGray`.
- `GradientPaint`'s pattern variant gains `alphaPattern`:

```ts
| { kind: 'pattern'; pattern: PdfDict; alphaPattern: PdfDict | null;
    opacity: number; report: boolean }
```

`alphaPattern` is `null` exactly when `uniformOpacity` returns a value, so the
existing `/ca` + `/CA` fold stays the fast path and no existing output changes.
When non-null it is a complete PatternType 2 dict, as above. `report` drops to
`false` for the varying case; only radial `reflect` / `repeat` still reports.

One correctness fix rides along. The degenerate solid outcomes — a single stop,
`x1 == x2 && y1 == y2`, `r == 0` — currently return `opacity: 1` whenever the
stops disagree, because `uniformOpacity` returned `null`. Each should return the
alpha of the stop whose *colour* it uses. That makes all three exact and removes
their report.

### `src/svgdraw.ts`

- `SvgTileSink` becomes `SvgStreamSink { stream(dict, content): PdfObject }`.
  Nothing about the old interface was tile-specific — it was already "allocate a
  content stream and hand back its reference" — and the mask group needs exactly
  that. One concept instead of two identical ones.
- A helper builds the mask group and allocates it through the sink, returning the
  ref for `/SMask /G`.
- `gsKey` extends to `(ca, CA, smask?)`, deduping on the canonical serialization
  through the existing `__canon`.

### `src/svgembed.ts`

Renames `tileSink` to `streamSink` and passes it where the tile sink went. No
other change: the mask group is a stream like a tile, allocated the same way.

## Two passes

A soft mask is a single scalar field applied to the whole painting operation. A
shape with a varying-alpha gradient fill *and* a stroke — or with two different
gradients — needs two fields, and one paint operation cannot carry both.

`resolvePaint` therefore gains a `canSplit` parameter and returns passes:

```ts
export interface PaintPass { fill: boolean; stroke: boolean; ops: string[]; }
export interface PaintOps  { fill: boolean; stroke: boolean; passes: PaintPass[]; }
```

`paintShape` passes `canSplit: true` and loops: `q`, the pass's ops, the
segments, `f` / `S` / `B` per the pass's own flags, `Q`. There is one pass
whenever no mask is in play, so every existing fixture's output stays
byte-identical; the segments are re-emitted only for a masked shape. `B` is
defined as `f` then `S`, so splitting changes nothing visually. Sibling `q` / `Q`
blocks mean the first pass's soft mask is restored away before the second runs —
no `/SMask /None` is needed.

`Emitter.setPaint`, the `<text>` path, passes `canSplit: false`: `emitGlyphs`
would have to show every run twice to split, roughly doubling the text output for
a case that barely occurs. It keeps its `{ fill, stroke }` return and emits
`passes[0]`. When the two paints would need different masks, `resolvePaint` drops
both, emits as it does today, and adds the gradient element's name to `skipped` —
the same report the varying case gets today, now narrowed to the one combination
that is still lossy. The mask group is built **lazily**, after that decision, so
the rejected path allocates nothing.

## Errors

No new failure modes, and no new error types. The mask is purely additive: a
gradient that resolves to nothing still paints nothing, a null bbox means nothing
paints so no mask is built, and every path that cannot produce a mask falls back
to exactly today's behaviour.

## Testing

**`svggradient.ts`** — the alpha function's `/Bounds` and `/Encode` match the
colour function's, across a hard stop and across the copies `reflect` synthesizes;
`/ColorSpace /DeviceGray` on the alpha shading; `alphaPattern` null under a
uniform alpha; the alpha `/Matrix` equals the colour `/Matrix` with the CTM factor
removed; each of the three degenerate solids takes the last stop's alpha.

**`svgdraw.ts`** — a varying-alpha gradient fill emits an `/ExtGState` carrying
`/SMask << /S /Luminosity /G … >>`, and the group's `/Resources` hold a
`/DeviceGray` pattern; a varying-alpha fill plus a solid stroke emits two `q` /
`Q` blocks ending `f` and `S`, with the mask on the first only; the gradient no
longer appears in `skipped`; the ambiguous text case still does; a uniform-alpha
gradient's content stream is unchanged.

**`svgembed.ts`, end to end** — the load-bearing test. Paint an opaque coloured
rectangle, then place over it an SVG whose gradient runs `stop-opacity="0"` to
`"1"`, nested inside a `<g transform>`. `Save()` / `Open()` / `ToImage`, then
assert the transparent end reads the backdrop colour, the opaque end the gradient
colour, and the midpoint a roughly even blend of the two. `raster.ts` is an
independently written *reader* of both shadings and luminosity masks, so this is a
genuine cross-implementation check rather than a round trip through one body of
code — the same reasoning behind the `1gg0.7` rasterization test.

**Mutation**, per the CLAUDE.md rule that an assertion passing on the first run is
not yet evidence: removing the CTM cancellation from the alpha `/Matrix`, changing
the group's `/CS` to `/DeviceRGB`, and collapsing the two passes back into one
must each turn the suite red.

Fixtures extend `test/helpers/build-svg-fixtures.ts`, programmatic as the rest of
the SVG suite is.

## Documentation

`README.md`: the `AddSVGObject` entry currently lists varying per-stop alpha as a
limitation beside radial `reflect` / `repeat`. Remove the first, keep the second,
and note that per-stop alpha is rendered through a soft mask.

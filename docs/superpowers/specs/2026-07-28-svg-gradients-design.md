# SVG gradients (`linearGradient` / `radialGradient` → PDF shadings) — design

Issue: `aspose-pdf-foss-for-ts-1gg0.7` (epic `1gg0`, page-furniture & text-authoring
parity gaps). Date: 2026-07-28.

Follow-up to `1gg0.3`, which shipped `page.AddSVGObject` and deliberately deferred
gradients; see `2026-07-28-svg-embedding-design.md`. Today a `fill="url(#grad)"`
resolves to no paint and the gradient element's name is added to `skipped`.

**Direction note.** `svgrender.ts` is PDF→SVG. This is SVG→PDF and shares no code
with it. It is, however, the first code in the repo that *writes* a shading —
`pdffunction.ts`, `raster.ts` and `svgrender.ts` only read them. That asymmetry is
what makes the end-to-end test in "Testing" worth having.

## Scope

- `linearGradient` and `radialGradient`, referenced from `fill` or `stroke`.
- `gradientUnits` — `objectBoundingBox` (the default) and `userSpaceOnUse`.
- `gradientTransform`.
- `spreadMethod` — `pad` everywhere; `reflect` and `repeat` on linear gradients.
- Stops: `offset` (number or percentage), `stop-color`, `stop-opacity`, and the
  presentation-attribute / inline-`style=` cascade on the stop element.
- `href` / `xlink:href` reuse between gradient elements.

Out of scope, each filed as a follow-up:

- **Per-stop varying `stop-opacity`**, which needs a luminosity `/SMask`.
- **`reflect` / `repeat` on a radial gradient.**
- **The `<pattern>` element.**

## Mechanism: shading patterns, not `sh`

A gradient becomes a **PatternType 2** (shading) pattern, selected with
`/Pattern cs /P0 scn` for a fill and `/Pattern CS /P0 SCN` for a stroke.

The alternative — clip to the path and run the `sh` operator — was rejected: it
needs an explicit clip per shape, it re-implements `fill-rule` by hand, and it
cannot stroke at all. The pattern path gets all three for free.

A PatternType 2 pattern is a **dictionary**, as are the shading and the type 2/3
functions inside it. So the whole gradient is a tree of direct dicts and
`svgdraw.ts` keeps the property it has today: it allocates no indirect objects
and imports no `Document`, placing direct dicts into the Form XObject's own
`/Resources`.

| SVG | PDF |
|---|---|
| `linearGradient` | ShadingType 2, `/Coords [x1 y1 x2 y2]` |
| `radialGradient` | ShadingType 3, `/Coords [fx fy 0 cx cy r]` |
| stops | `/Function`: type 2 for two stops, else type 3 stitching over type 2s |
| `spreadMethod="pad"` | `/Extend [true true]` |
| `gradientTransform`, `gradientUnits`, element CTM | the pattern `/Matrix` |
| uniform `stop-opacity` | folded into the existing `/ca` + `/CA` `ExtGState` |

Colour space is `/DeviceRGB` throughout; everything upstream in `svgstyle.ts` is
already RGB.

## The pattern matrix

This is the part most likely to be got wrong, so it is stated explicitly.

Pattern space **ignores the CTM in effect when the fill is painted**. It maps to
the default space of the content stream the pattern is used in — here, the Form
XObject's space, which (identity `/Matrix`, per `1gg0.3`) is raw viewBox units
with y still pointing down.

`svgdraw.ts` today does not know its own accumulated transform: it emits `cm` and
lets PDF's graphics state hold it. It must now track it. `Emitter` gains a CTM
stack pushed and popped in lockstep with every `q` / `Q` it already emits.

In this repo's convention — `mul(m, n)` is "m followed by n", i.e. row vectors,
leftmost applied first:

```
/Matrix = mul(mul(gradientTransform, bboxMatrix), elementCtm)
```

| factor | value |
|---|---|
| `gradientTransform` | the parsed `gradientTransform` attribute, else identity |
| `bboxMatrix` | `[bw, 0, 0, bh, bx, by]` for `objectBoundingBox`; identity for `userSpaceOnUse` |
| `elementCtm` | the walker's accumulated matrix at the shape being painted |

The order of the first two follows SVG's own model: `objectBoundingBox`
establishes a coordinate system equivalent to `translate(bx,by) scale(bw,bh)`,
and `gradientTransform` applies *inside* it. Swapping them makes a rotated
gradient rotate about the wrong origin — visible only on a non-square bbox, which
is why the test uses one.

### Bounding box

`objectBoundingBox` is the **default**, so the shape's bbox is needed on the
common path, not the rare one. It is the tight bbox of the shape's own geometry
in its own user space, excluding the stroke (per SVG).

Segments reaching `svgdraw.ts` are already normalized to `M`/`L`/`C`/`Z`, so a
tight bbox is endpoints plus the cubic extrema — the roots of the per-axis
derivative quadratic. The control-point hull is **not** acceptable: a circle's
cubic control points lie outside the circle, so a hull bbox would inset every
`objectBoundingBox` gradient on any curved shape.

## Stops

Parsed from `<stop>` children: `offset` (a number, or a percentage), `stop-color`
and `stop-opacity`, each readable as a presentation attribute or through inline
`style=`, reusing `svgstyle.ts`'s existing cascade helpers.

Normalization, in order:

1. Offsets parsed, percentages divided by 100, clamped to `[0, 1]`.
2. Each offset forced to be ≥ its predecessor (SVG's own rule for out-of-order
   stops).
3. A stop prepended at offset 0, and appended at 1, when the list does not
   already start and end there — repeating the adjacent colour. This makes
   `/Domain [0 1]` exact and removes any need to reason about `/Extend` for the
   pad case separately.
4. Zero-width intervals dropped. This is what turns a doubled offset into a hard
   colour edge, and it is simultaneously what satisfies PDF's requirement that
   `/Bounds` be strictly increasing.

The function is then:

- two stops → a single **type 2** exponential, `/N 1`, `/C0` and `/C1` the two
  colours;
- more → a **type 3** stitching function over those type 2s, `/Bounds` the
  interior offsets, `/Encode` `[0 1]` repeated.

`stop-color: currentColor` resolves to black — the CSS default when no `color`
property is in effect, and this stack does not track `color`.

### Degenerate cases

Each is the outcome SVG itself mandates, so each is correct rather than a
fidelity loss and **none is reported in `skipped`**:

| condition | result |
|---|---|
| no `<stop>` children (after href resolution) | the paint is `none` |
| exactly one stop | solid fill of that stop's colour |
| linear with `x1 == x2 && y1 == y2` | solid fill of the **last** stop's colour |
| radial with `r == 0` | solid fill of the last stop's colour |
| `objectBoundingBox` and the bbox has zero width or height | that paint is suppressed (the gradient cannot be positioned) |

The last row suppresses only the paint that referenced the gradient, not the whole
element: a shape with a gradient fill and a solid stroke still strokes.

## Geometry

### Linear

Defaults `x1="0%" y1="0%" x2="100%" y2="0%"`. `/Coords [x1 y1 x2 y2]`,
`/Extend [true true]`.

### Radial

Defaults `cx="50%" cy="50%" r="50%"`, with `fx`/`fy` defaulting to `cx`/`cy`.
Maps to `/Coords [fx fy 0 cx cy r]`, `/Extend [true true]` — PDF's inner circle of
radius 0 at the focal point is exactly SVG's model.

If the focal point lies outside the circle, it is moved onto the circle's edge,
per SVG 1.1. SVG 2's `fr` is ignored (inner radius stays 0); it is rare enough
not to warrant a report.

### Percentages

Under `objectBoundingBox` a percentage is simply the fraction. Under
`userSpaceOnUse` it resolves against the viewport: `w` for x coordinates, `h` for
y, and `sqrt((w² + h²) / 2)` for `r`, per SVG's normalized diagonal.

That requires the viewport, which `svgdraw.ts` does not currently have —
`svgembed.ts` resolves the viewBox and passes only the root node. `drawSvg` gains
the resolved `ViewBox` as a parameter.

## spreadMethod

`pad` is `/Extend [true true]` and needs nothing further.

`reflect` and `repeat` on a **linear** gradient extend `/Coords` along the axis to
an integer repetition range `[k0, k1]` — from `P(k0)` to `P(k1)` where
`P(t) = p1 + t·(p2 − p1)` — and pack `k1 − k0` copies of the ramp into the
stitching function, mirroring alternate copies for `reflect`. `/Extend [true true]`
then pads outside that range, which is invisible once the range covers the shape.

The range is **computed, not guessed**. The shape's bbox corners are mapped
through `invert(mul(gradientTransform, bboxMatrix))` into gradient space and
projected onto the axis; `k0` and `k1` are the floor and ceiling of the resulting
`t` interval. The element CTM cancels out of that expression — the shape is in
element user space and the pattern matrix carries the same `elementCtm` factor —
and that cancellation is the check that the composition above is right.

Capped at 64 repetitions, degrading to `pad` beyond it, so a pathological gradient
cannot inflate the content stream without bound.

Radial `reflect` / `repeat` falls back to `pad` and adds the element name to
`skipped`. The outward tiling of an annulus has no clean PDF equivalent and the
combination is rare.

## `href` reuse

`href` / `xlink:href` between gradient elements resolves before any mapping:
stops are inherited when the child declares none, and each attribute
(`gradientUnits`, `gradientTransform`, `spreadMethod`, and the geometry
attributes) is inherited when unset on the child. A visited-set cycle guard
matches the one `<use>` already has in `svgdraw.ts`, so a self-referencing
gradient terminates.

A `linearGradient` may inherit from a `radialGradient` and vice versa; SVG allows
it. Stops and the common attributes are inherited, the other type's geometry
attributes ignored.

## Opacity

Uniform `stop-opacity` — every stop carrying the same value — multiplies into the
`/ca` and `/CA` of the `ExtGState` the walker already builds. Exact, and free.

Differing `stop-opacity` values across stops would need a luminosity `/SMask`: a
parallel grayscale shading of the alpha ramp, wrapped in a transparency-group Form
XObject. v1 paints the gradient opaque and adds the gradient element's name to
`skipped`, so the loss is visible rather than silent. Filed as a follow-up.

This mirrors the choice `1gg0.3` made for an unsupported paint: never guess
something plausible-looking, because only a visibly wrong result gets noticed.

## Modules

- **`src/svggradient.ts`** *(new)* — the entire mapping, pure: href resolution,
  stop normalization, function build, coords, spread synthesis, pattern matrix.
  In: the gradient `XmlNode`, the id map, the shape bbox, the viewport, and the
  element CTM. Out: a pattern `PdfDict`, or a degenerate verdict (`none`, or a
  solid `Rgb`). Touches no `Document` and allocates nothing.
- **`src/svgpath.ts`** — add `segsBBox(segs)`, tight via exact cubic extrema.
- **`src/svgstyle.ts`** — `Paint` gains `fillRef` and `strokeRef`
  (`string | null`) so a `url(#…)` survives the cascade instead of being
  discarded at parse time. Additive; inheritance of the new fields works like the
  existing colours. `parsePaint` keeps returning the fallback colour so an
  unresolvable reference behaves exactly as it does today.
- **`src/svgdraw.ts`** — the CTM stack; bbox computation when a gradient paint
  applies; a `/Pattern` resource sub-dict with dedupe mirroring the existing
  `gsKey`; `scn` / `SCN` emission.
- **`src/svgembed.ts`** — passes the resolved `ViewBox` into `drawSvg`, and merges
  `/Pattern` into the Form XObject's `/Resources`.

`svggradient.ts` is its own module rather than part of `svgstyle.ts` because it is
the only unit that knows about PDF object shapes; `svgstyle.ts` is pure colour and
cascade, and importing `types.ts` into it would blur that.

## Errors

No new error conditions. A malformed gradient follows SVG's error handling as the
rest of the stack does — an unparseable attribute falls back to its default, and a
reference that does not resolve to a gradient element keeps today's behaviour: the
explicit fallback colour if the paint gives one, otherwise `none`, with the name
reported.

## Testing

The pure modules carry most of the weight, since that is where a failure isolates
to one cause.

**`svggradient.ts`** — stop normalization (percentage offsets, out-of-order
offsets clamped forward, hard stops, the prepended/appended 0 and 1 stops); the
emitted function shape (type 2 direct for two stops; type 3 `/Bounds` and
`/Encode` for more; `/Bounds` strictly increasing across a hard stop); linear and
radial defaults; percentage resolution under both `gradientUnits`; focal-point
clamping onto the circle; the `objectBoundingBox` matrix; `gradientTransform`
composition order against a **non-square** bbox, which is the only shape that
distinguishes the two orderings; `reflect` and `repeat` stop synthesis and the
64-repetition cap; href inheritance and its cycle guard; every degenerate case in
the table above.

**`svgpath.ts`** — `segsBBox` asserted against an **independent circle formula**,
not against our own arc converter, per the CLAUDE.md rule that a differential test
cannot validate the interpreter it runs through. A control-point-hull
implementation must fail this test.

**`svgdraw.ts`** — `/Pattern cs` + `scn` emitted for a gradient fill and
`CS` + `SCN` for a gradient stroke; pattern dedupe across two shapes sharing one
gradient; the element CTM baked into `/Matrix` under a nested `<g transform>`;
uniform `stop-opacity` folded into `/ca`; varying `stop-opacity` reported in
`skipped`.

**`svgembed.ts`** — end-to-end, and the strongest check available: build a linear
gradient SVG, place it with `AddSVGObject`, `Save()` / `Open()`, then **rasterize
with `ToImage`** and assert pixel colours at both axis ends and the midpoint.
`raster.ts` is an independently written *reader* of shadings, so this is a genuine
cross-implementation check rather than a round trip through one body of code — the
same reasoning the CLAUDE.md fixture rule applies to third-party binaries. A
radial case asserts the centre and the rim.

Fixtures are programmatic SVG builders in `test/helpers`, extending
`build-svg-fixtures.ts`, keeping the suite hermetic.

Per the repo rule, assertions that pass on the first run are proved load-bearing
by mutation before being accepted — specifically the pattern-matrix composition
order, the `objectBoundingBox` bbox mapping, and the `ToImage` pixel assertions.

## Documentation

`README.md`: extend the `AddSVGObject` entry with gradient support, and record the
two limitations a user meets first — varying per-stop alpha, and radial
`reflect` / `repeat` — beside the existing group-`opacity` approximation note.

## Follow-ups

To be filed under epic `1gg0`:

1. Luminosity `/SMask` for varying `stop-opacity`.
2. Radial `reflect` / `repeat` spread.
3. The `<pattern>` element.

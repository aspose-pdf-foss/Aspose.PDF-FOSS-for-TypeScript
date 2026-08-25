# SVG group opacity via transparency groups

Issue: `aspose-pdf-foss-for-ts-1gg0.12` (epic `1gg0`). Deferred from `1gg0.3`.

## Problem

`page.AddSVGObject` folds an element's `opacity` into its children's fill and
stroke alphas. That is exact only when nothing in the subtree overlaps anything
else in it. Where two children overlap, each is painted at the reduced alpha
independently and the overlap composites twice, so it comes out darker than the
group as a whole should be.

The fold happens in `resolveStyle` (svgstyle.ts):

```ts
const groupOpacity = clamp01(numOr(get('opacity'), 1));
p.fillOpacity   = clamp01(numOr(get('fill-opacity'), 1))   * parent.fillOpacity   * groupOpacity;
p.strokeOpacity = clamp01(numOr(get('stroke-opacity'), 1)) * parent.strokeOpacity * groupOpacity;
```

`fillOpacity` and `strokeOpacity` inherit, so the group alpha travels down with
them. Once multiplied in it cannot be recovered — which is also why `<image>`
currently applies `fill-opacity`, a property SVG says does not apply to an
image: by the time svgdraw.ts reads `p.fillOpacity`, the two are one number.

Correct semantics need the subtree composited as a unit and faded once: a PDF
transparency group (`/Group /S /Transparency`) drawn under an ExtGState `ca`.

## Design

### 1. Unfold group opacity in the cascade

`resolveStyle` stops multiplying `groupOpacity` into the two alphas and returns
it alongside the paint:

```ts
// was: { paint, refs }
{ paint, refs, groupOpacity }
```

`Paint` gains no field and `INITIAL` is unchanged — `groupOpacity` is
per-element, not inherited state. This matches SVG, where `opacity` is not an
inherited property; `get('opacity')` already reads own attributes and own CSS
only, so removing the pre-multiply is the whole change.

Nesting still composes, because the groups nest:

- `<g opacity=.5><g opacity=.5>` — two nested groups at 0.5 = 0.25.
- `<g opacity=.5><rect fill-opacity=.5/></g>` — the rect draws at 0.5 inside a
  group faded to 0.5 = 0.25, as before.

### 2. Group vs. fold: the one-paint-operation rule

Folding is exact whenever the element performs exactly one paint operation:
there is nothing for the reduced alpha to double-count against. So the fold is
kept for those cases and a transparency group is emitted for the rest.

| Element | `opacity` < 1 |
|---|---|
| `<g>`, `<svg>`, `<use>`, `<symbol>` | **group** |
| shape with fill *xor* stroke, no markers | fold into that one channel |
| shape with fill *and* stroke | **group** — the stroke overlaps the fill along the boundary |
| shape with markers | **group** — markers overlap the path |
| `<text>` | **group** — glyphs can overlap each other, and decoration overlaps glyphs |
| `<image>` | fold into `ca` |

Keeping the fold for the single-operation cases is not only cheaper: it is what
stops every ordinary faded shape in every SVG from allocating a Form XObject.

The walk-time predicate for "both channels paint" is:

```ts
(p.fill !== null || p.fillRef !== null)
  && (p.stroke !== null || p.strokeRef !== null)
  && p.strokeWidth > 0
```

This over-approximates *both* on purpose. Deciding "both" when only one channel
actually paints costs a redundant group and looks identical; deciding "one"
when both paint is a wrong pixel. The asymmetry is the point, and any future
paint channel must be added on the conservative side.

### 3. `<image>`: the second half of the fix

svgdraw.ts currently pushes `p.fillOpacity` for an image, which carries both
`fill-opacity` and group `opacity`. With the two separated it pushes
`groupOpacity` alone. An image is a single paint operation, so no transparency
group is needed — the fold into `ca` is exact.

This removes a documented README limitation rather than adding one.

### 4. Placement and `/BBox`

`groupForm` and `gsKey` are reused unchanged. The wrapper goes **outside** the
mask wrapper and **inside** the element's own `transform` q/Q:

```
/GsAlpha gs
/Fm<n> Do        <- the group form, holding [mask wrapper | painted]
```

SVG's rendering order is filter -> clip-path -> mask -> opacity, so opacity is
outermost of the four; the mask wrapper must be inside this one. Sitting inside
the element's `transform` rather than outside it is equivalent, because alpha
compositing of a whole group commutes with an enclosing affine and with an
enclosing clip — and it preserves `groupForm`'s contract that `/Matrix` is
identity and the box is in the element's own user space.

`/BBox` is the viewport rectangle mapped back through the inverse of the
walker's accumulated CTM (`here`), axis-aligned.

This never crops. svgembed.ts already sets the outer form's `/BBox` to the
viewport, so ink outside it is invisible regardless of what this box says. The
tempting alternative — `subtreeBBox`, inflated by stroke width — was rejected:
it is documented as fill-geometry-only and can return `complete: false`, and
markers, filter regions and miter joins all paint outside it. Every future
primitive that paints outside the fill box would become a silent cropping bug,
and a cropping bug in an opacity group is invisible until someone looks at the
right fixture.

The cost of the large box is a large offscreen buffer at render time, not a
larger file: the `/BBox` is four numbers.

A non-invertible CTM (zero determinant) collapses the content to no area, so
nothing is visible either way. That case folds and is not reported.

### 5. Renderers

No change. `pagerender.ts`'s buffering predicate already reads:

```ts
const unitComposite = gs.fillAlpha < 1 || gs.blend !== 'Normal' || gs.softMask !== undefined;
const needsBuffer = isTransparencyGroup && (unitComposite || ...) && ctx.depth < MAX_OFFSCREEN_DEPTH;
```

so `ca < 1` on a `/Group /S /Transparency` form forces the buffer, and
`endOffscreen({ kind: 'group', alpha })` composites it as a unit. Both `ToImage`
and `ToSvg` inherit this from the mask work.

Inherited caveat, not a code change: `MAX_OFFSCREEN_DEPTH` is 8, so opacity
nested deeper than that degrades to inline drawing **in our own renderers**. The
emitted PDF is still correct for a conforming viewer.

### 6. Module boundaries

No new module. Two edits at an existing seam: `resolveStyle` returns one more
number, and `walk` decides and reuses `groupForm`/`gsKey`. A `svgopacity.ts`
holding one predicate would be a file that exists to be a file.

## Testing

Two files, matching the `svg-mask` / `svg-mask-render` precedent.

### `test/svg-opacity.test.ts` — content-stream structure

- `<g opacity=".5">` emits a `/Group /S /Transparency` form and a `gs` with
  `ca` 0.5, and the children's own ops carry no alpha.
- `<rect fill="red" opacity=".5"/>` (fill only, no stroke) emits **no** form —
  the guard against bloating every ordinary faded shape.
- A fill-and-stroke shape emits a form.
- A shape with markers emits a form.
- `<image opacity=".5" fill-opacity=".5">` pushes `ca` 0.5, not 0.25.
- `transform="scale(0)"` does not throw.

### `test/svg-opacity-render.test.ts` — the load-bearing assertion

A red rect and a blue rect overlapping, inside `<g opacity="0.5">`, rendered
through `ToImage`. Inside the group blue fully covers red, so the composited
overlap pixel must equal the blue-only region's pixel. Under the current fold
the overlap is purple.

This asserts an *internal identity* — overlap equals top-only — rather than
diffing our output against our own producer, so it cannot cancel out the way
CLAUDE.md warns a differential test can.

Nested `<g opacity=".5">` twice checks that the composed result is 0.25.

### Proving the tests load-bearing

Per the repo rule, passing on the first run is not evidence. Both files are
verified by restoring the fold and confirming they go red.

`test/svg-input-fixtures.test.ts` renders third-party SVGs and may churn if
those files carry `opacity`. This is checked rather than assumed, and any golden
update is called out explicitly rather than silently regenerated.

## Docs

README, in the SVG embedding bullet:

- Replace the trailing *"Group `opacity` is folded into child alphas, which is
  exact unless the children overlap."*
- Fix the `<image>` sentence asserting that `fill-opacity` is folded into the
  image's constant alpha along with group `opacity` and that PDF cannot separate
  them short of a transparency group. They are now separated, and `fill-opacity`
  is correctly ignored for an image.

## Out of scope

- `textPath` (`1gg0.20`), nested SVG image payloads (`1gg0.22`) and the href
  resolver (`1gg0.21`) are separate issues in the same epic.
- Raising `MAX_OFFSCREEN_DEPTH`.

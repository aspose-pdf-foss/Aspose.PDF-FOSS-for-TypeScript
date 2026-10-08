# Rounded corners and background images on boxes — design (v9j3.4)

Part of epic `v9j3` (Flow authoring conveniences), labelled `net-parity`:
.NET's `FloatingBox.BackgroundImage` and `BorderInfo.RoundedBorderRadius`,
and CSS `border-radius` and `background-image` on the HTML path. Approved in
conversation on 2026-10-08; this records it.

## Goal

A box can have rounded corners (per corner, elliptical) and a background
image or gradient, on `FloatingBox` and on every CSS box `AddHtml` renders.
A box that states none of these renders byte-identically to before.

## Baseline (measured)

- `FloatingBox` paints a flat `background` rect and a stroked `border`
  (optionally on a subset of `sides`) through `PageGraphics`. It never
  splits, so it knows its whole height when it paints.
- `cssframe.ts` lowers a CSS box to one `BoxElement` per element its subtree
  produced. Each slice paints its own flat background (`fillRect`) and its
  own edges (filled rects, per-edge width and colour); the top edge is drawn
  only by the first slice and the bottom only by the last. A shared
  `BoxRun` already carries the running height for `min-height`.
- `cssprop.ts` has 43 longhands, asserted by size. `background-color` is the
  only background longhand. The `background` shorthand refuses any value
  that is not a plain colour (an image is reported, not reduced to its
  colour). `border-radius` is an unknown property.
- `gradient.ts` builds axial and radial shadings from stops; `PageGraphics`'
  gradient fills are pinned to page space. `tiling.ts` builds colored tiling
  patterns.

## Decisions

1. **Scope:** per-corner elliptical radii; one background layer that is an
   image (`url()`), a `linear-gradient()` or a `radial-gradient()`, with
   `background-size`, `background-repeat` and `background-position`.
2. **Splitting follows CSS `box-decoration-break: slice`.** A slice rounds
   its top corners only when it is the box's FIRST slice and its bottom
   corners only when it is the LAST. The background is laid out against the
   WHOLE box and each slice paints the part inside it, so an image or
   gradient continues across a column break.
3. **One geometry owner.** A new pure leaf, `src/boxpaint.ts`, importing
   nothing, owns every rule: radius resolution and overlap scaling, the
   rounded paths, the border ring and its edge wedges, the background layer's
   size, position and tile grid, and the gradient line and ending shape. Both
   painters call it, so `FloatingBox` and HTML cannot disagree about a corner.
   Rejected: extending `PageGraphics` (it has no clip-to-path or image fill,
   and the CSS rules would land in a general builder or be duplicated);
   rasterizing (resolution-bound, lossy).
4. **Opt-in by construction.** A box with no radius, no image and no gradient
   runs exactly today's painting code — except for decision 5.
5. **Fixed on the way (amended 2026-10-08):** a box's background and side
   borders paint over the GAPS between its children. Measured before this
   work: a `<div style="background:red">` holding two `<p style="margin:20px
   0">` paints red behind each paragraph and leaves a white hole in the 20px
   between them, where Chrome fills the whole div. A slice paints only its own
   `used` height and the inter-element gap falls outside every slice. A
   continuous image or gradient would be striped by the same holes, so this
   work cannot ship without it. The rule is `QuotedElement.paintBar`'s: a
   NON-LAST slice that did not split extends its background and side borders
   down by `spaceAfter + next slice's spaceBefore + paragraphSpacing`, bounded
   by the column bottom; `frameBoxes` knows the next slice's `spaceBefore` at
   build. The extension counts in `BoxRun`'s running height, so the
   background phase stays continuous. A `Fixed` CHANGELOG entry records it;
   any `html-identity` hash it moves is shown as a before/after render, not
   silently re-recorded.

## Geometry (`boxpaint.ts`)

- **Radii.** A corner is `{ rx, ry }`. CSS percentages resolve against the
  border box's width (`rx`) and height (`ry`). Overlap (CSS Backgrounds 3
  §5.5): `f = min(Li / Si)` over the four sides, where `Li` is the side's
  length and `Si` the sum of the two radii along it; if `f < 1` every radius
  is multiplied by `f`.
- **Paths.** Corners are quarter ellipses drawn as one cubic each (control
  offset `0.5523 × r`). The outer path is the border box; the inner path is
  the padding box, whose radii are the outer radii less the adjoining border
  widths, floored at 0.
- **Clip.** The background is clipped to the rounded BORDER box (CSS's
  initial `background-clip: border-box`); position and size measure from the
  PADDING box (initial `background-origin: padding-box`).
- **Border ring.** With any radius, the border is the outer path minus the
  inner path, filled even-odd, so differing edge widths come out exactly as
  CSS draws them. A zero-width edge contributes nothing. Differing COLOURS:
  each edge's share is clipped to its wedge — the quadrilateral from the
  outer box corners to the inner box corners — which is Chrome's diagonal
  colour join. With no radius, straight edges are drawn exactly as today.
- **Slices.** A slice's clip is the rounded border box with only the corners
  it owns rounded (top pair if first, bottom pair if last); the layer is
  positioned in the coordinates of the whole box, offset by the height of
  the slices already painted.

## Backgrounds

- **Image size** (CSS Backgrounds 3 §3.9). An image's natural size is its
  pixels × 0.75pt, the rule `<img>` already uses. `auto`, `cover`,
  `contain`, lengths and percentages (of the positioning area); one `auto`
  keeps the aspect ratio.
- **Position.** Keywords, lengths and percentages, including the 4-value
  edge-offset form. A percentage `p` places the image's `p` point on the
  area's `p` point.
- **Repeat.** `repeat`, `no-repeat`, `repeat-x`, `repeat-y`. `no-repeat` is a
  single `Do`; any repetition is a colored tiling pattern (`tiling.ts`)
  filling the clip, phased so a tile lands on the position.
- **Linear gradient** (CSS Images 3 §3.1). The gradient image is the size
  box (by default the positioning area). An angle θ (CSS degrees, 0 = to
  top, 180 = to bottom) gives a line through the centre of length
  `|W sin θ| + |H cos θ|`; `to right`, `to top left` and the other side and
  corner keywords map to angles, the corner forms from the box's own aspect.
- **Radial gradient** (§3.2). `circle` or `ellipse`; size keywords
  `closest-side`, `closest-corner`, `farthest-side`, `farthest-corner`
  (default), or explicit sizes; `at <position>`. An ellipse is drawn as a
  circle under a scaling matrix, since a PDF radial shading is circular.
- **Stops.** Omitted positions are filled by CSS's rules (first 0%, last
  100%, the rest spread evenly between known ones); a stop behind an earlier
  one is clamped up to it. Lowered to `gradient.ts`'s `GradientStop`s.
- **Painting order, per slice:** clip; colour; image layer; borders. All of
  it is `/Artifact` in a tagged flow, as the flat fill already is.

## CSS

- **New longhands (43 → 52, asserted):** `border-top-left-radius`,
  `border-top-right-radius`, `border-bottom-right-radius`,
  `border-bottom-left-radius` (each `<length-percentage>{1,2}`),
  `background-image`, `background-size`, `background-repeat`,
  `background-position-x`, `background-position-y`. None inherited.
  Lengths stay px in the computed value; the × 0.75 still crosses in
  `cssflow.ts` alone.
- **Shorthands:** `border-radius` (1–4 values, optional `/` second half);
  `background-position`; `background`, extended to carry colour, image,
  position `/` size and repeat (and no longer refusing an image).
- **Reported, never silently wrong:** multiple layers, `repeating-*-gradient`,
  `conic-gradient`, `image-set()`, `cross-fade()`,
  `background-attachment: fixed`, repeat `space`/`round`, and colour hints
  fail the property's grammar and are reported through the cascade's existing `unparsable-value` record, so `CONSTRUCTS` stays at 22.
  `background-clip`, `background-origin` and `background-blend-mode` remain
  unknown properties.
- **Image resolution** goes through `data:` URIs and the existing
  `resolveImage(src, alt)` hook with `alt` `''`. One that will not resolve is
  reported as `construct: 'image'`, `kind: 'dropped'`, `detail: 'background-image: <src>'`, and the colour still paints.

## FloatingBox

```ts
doc.NewFloatingBox({
  width: 200, padding: 8,
  border: { width: 1, color: [0.6, 0.6, 0.6] },
  radius: 8,              // or { topLeft: 8, topRight: [16, 8], bottomRight: 0, bottomLeft: 8 }
  background: { kind: 'linear', angle: 180, stops: [/* GradientStop */] },
  // or: backgroundImage: { data: pngBytes, fit: 'cover' } — one layer, so a
  // gradient background and an image are exclusive (TypeError)
});
```

- `radius?: number | { topLeft?, topRight?, bottomRight?, bottomLeft? }`, each
  a number or `[rx, ry]`, in points. Top level, not in `border`, since a
  borderless box rounds too.
- `background?: [r, g, b] | BoxGradient` — a BOX-RELATIVE gradient:
  `{ kind: 'linear'; angle?: number; stops }` or
  `{ kind: 'radial'; shape?: 'circle' | 'ellipse'; size?: <size keyword>;
  at?: [x, y] (fractions of the box); stops }`. It lowers through the same
  function a CSS gradient does.
- `backgroundImage?: { data: Uint8Array; fit?: 'stretch' | 'cover' |
  'contain' | 'tile' | 'none'; format? }`. Each `fit` is a preset of the CSS
  rule: `stretch` = size 100% 100% no-repeat (the default, as .NET),
  `cover`/`contain` = centred no-repeat, `tile` = natural size repeated from
  the top-left, `none` = natural size, top-left, once. Decoded in the
  constructor, so bad bytes throw before anything is drawn.
- `border.sides` keeps its meaning; with a radius a missing side is a
  zero-width edge of the ring.
- Validation before any work: `TypeError` for a wrong kind (non-finite
  radius, unknown `fit`, bad stops), `RangeError` for a negative radius.

## Testing

- **`boxpaint.ts` unit tests**, from numbers: radius resolution and overlap
  scaling (incl. `50%` on a non-square box), inner radii, edge wedges,
  `cover`/`contain`/% sizing, position keywords and the 4-value form, tile
  phase, the gradient line length per angle, corner keywords, radial size
  keywords per shape.
- **Chrome pixel oracle.** `scripts/gen-box-paint-goldens.ts` (not run by
  `npm test`) screenshots TEXT-FREE `<div>`s in headless Chrome: radii
  (uniform, per-corner, elliptical, `50%`, overlapping), differing border
  widths and colours on a rounded box, an image under each size, repeat and
  position, linear and radial gradients. `test/box-paint-oracle.test.ts`
  renders the same HTML through `AddHtml` → `ToImage` and compares pixels
  within a stated antialiasing tolerance. Provenance in
  `test/fixtures/box-paint/PROVENANCE.md`.
- **Cascade goldens.** `gen-cascade-goldens.ts` gains fixtures for the new
  longhands, compared through `getComputedStyle`.
- **Splitting** (invisible to a screenshot): only the first slice rounds its
  top corners and only the last its bottom; an image and a gradient continue
  across a column break, each slice offset by the height above it.
- **Fences, unedited:** `html-identity`, `rich-runs-identity`, the Flow and
  notes identity fences, the existing FloatingBox tests, the css-box corpus.
- **Tagging:** decoration is `/Artifact`; a tagged flow with backgrounds
  passes `ValidatePdfUa`.
- **Mutation sweep** over the geometry, the slice rules, the CSS parsing and
  both painters, recorded in CLAUDE.md.

## Docs

README (capabilities, an example for `FloatingBox` and one for HTML, API
rows, limitations), CHANGELOG under `[Unreleased]` / `Added`, CLAUDE.md
entries for `boxpaint.ts` and the `cssframe.ts`/`floatbox.ts` invariants.

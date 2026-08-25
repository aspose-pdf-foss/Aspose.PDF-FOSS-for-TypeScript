# SVG textPath — method="stretch"

Issue: `aspose-pdf-foss-for-ts-1gg0.25` (epic `1gg0`). Deferred from `1gg0.20`;
see `2026-08-03-svg-textpath-design.md`, **Out of scope**.

## Problem

`1gg0.20` shipped every part of SVG 2's `textPath` except `method="stretch"`,
which renders as `align` and reports `textPath` in `result.skipped`.

`align` places upright glyphs at tangent angles: each glyph is rigid, rotated
about its own origin. `stretch` instead warps the glyph **outlines** along the
curve, so a glyph spanning a bend is itself bent. The two differ visibly on any
path whose tangent turns within one glyph's advance.

The deferral was not about the mapping, which is the same arc-length mapping
`align` already uses. It was about what the output has to be: outlines mean
vector paths, and vector paths are not text. Every other part of this stack
keeps text extractable and searchable, and the naive implementation gives that
up.

## What this covers

- `method="stretch"` on `<textPath>`, for every face the SVG stack can produce:
  the bundled Standard-14 substitutes, a caller-supplied TrueType font, and a
  caller-supplied OpenType/CFF font.
- The warped run stays extractable and searchable.
- A face with no outline source still falls back to `align` and reports, which
  is today's behaviour — so the feature never makes anything worse.

Not covered: warping the `text-decoration` rules. They keep the per-glyph
rotated rects the `align` path already produces, which on a curve is a polyline
hugging the path. See **Decoration**.

## Design

### 1. Where it plugs in

`applyTextPaths` (svgdraw.ts) loops the owners carrying a `TextPathSpec` and
maps each one's glyphs. It gains a second output — the warped geometry — rather
than a second loop:

```ts
interface StretchedRun {
  /** Warped contours as M/L/Z subpaths, in the <text> element's user space. */
  segs: SvgSeg[];
  /** The run's style: `paint` for the fill, and nothing else is read. */
  style: SvgTextStyle;
}

function applyTextPaths(
  e: Emitter, flat: FlatText, glyphs: PlacedGlyph[],
): { glyphs: PlacedGlyph[]; stretched: StretchedRun[] };
```

An owner is stretched when `spec.stretch` **and every face inside it** supplies
outlines. All-or-nothing per owner, not per run: a `<textPath>` mixing a face
that can stretch with one that cannot would otherwise render half its glyphs
warped and half upright, which looks like a bug rather than a degradation. A
mixed owner falls back whole, and reports.

A stretched owner still runs `mapGlyphsToPath` — its glyphs are what the
invisible overlay is emitted from (§5), and they are what the existing
midpoint drop rule is applied to. Stretching adds geometry; it does not replace
the mapping.

The text branch in `walk` then paints each `StretchedRun` through the existing
`paintShape` before calling `emitGlyphs`:

```ts
const { glyphs, stretched } = applyTextPaths(t, flat, laid);
for (const r of stretched) paintShape(t, r.segs, glyphFillPaint(r.style.paint), here);
const drew = emitGlyphs(glyphs, t, here);
```

This is the load-bearing simplification. A warped outline is ordinary path
geometry, so routing it through `paintShape` gets gradients, patterns, stroke,
dash, opacity and the `objectBoundingBox` box with no new painting code — the
same reason `1gg0.20` reused `flattenCubic` rather than writing a second
flattener.

`glyphFillPaint` forces `fillRule: 'nonzero'`. SVG's `fill-rule` governs the
author's own geometry; glyph contours are font geometry, defined under nonzero
winding by both TrueType and CFF. Honouring `fill-rule="evenodd"` on the `<text>`
would punch holes through overlapping contours in exactly the fonts that use
them.

### 2. The warp — new module `svgtextstretch.ts`

Pure, like `svgtextpath.ts`: no PDF objects, no `Document`, no font parsing.

```ts
export function stretchGlyphs(
  glyphs: PlacedGlyph[], onPath: (g: PlacedGlyph) => boolean,
  m: PathMetrics, startOffset: number, tol: number,
): { segs: SvgSeg[]; style: SvgTextStyle }[];
```

For each glyph the face is asked for its contours already mapped into the run's
chunk-local user space:

```
em = [size * hscale, 0, 0, size, 0, 0] x textMatrix(g.x, g.y, g.rot)
polys = g.style.face.outline!(g.ch, em, tol)
```

`textMatrix` is the same helper `emitGlyphs` uses for its `Tm`, so a stretched
glyph and an align glyph start from byte-identically the same placement — the
`rotate=` attribute, `hscale` from `lengthAdjust="spacingAndGlyphs"`, `dy` and
`baseline-shift` all reach the warp without a second implementation.

Each resulting point `(ux, uy)` then maps onto the path by the rule
`mapGlyphsToPath` already uses:

```
d   = startOffset + ux
P   = pointAt(m, clamp(d, 0, m.total))
out = (P.x - sin(P.angle) * uy, P.y + cos(P.angle) * uy)
```

which is exactly `mapGlyphsToPath`'s formula with `half = 0`. Both therefore
call one shared helper:

```ts
export function placeAt(m: PathMetrics, d: number, perp: number)
  : { x: number; y: number; angle: number } | null;
```

`mapGlyphsToPath` keeps its half-advance backoff and its behaviour is unchanged
— the extraction is a refactor with the existing textPath tests as its guard.

**Which glyphs render** is unchanged: the existing midpoint rule
(`startOffset + g.x + g.adv/2` off the path → the glyph is not rendered). Only
the *points* of a surviving glyph clamp to `[0, total]`, so a glyph straddling
the tip of the path bunches against the end instead of vanishing or flying off.
Deciding per point instead would tear a glyph in half at the boundary.

Runs are grouped by `style` identity, the same key `sameRun` uses, so one
`<tspan>` inside a stretched `<textPath>` yields one `StretchedRun` and one
`paintShape` call.

### 3. The outline seam

`SvgFace` gains one optional member beside the two it already carries:

```ts
export interface SvgFace {
  key: string;
  driver: FontDriver;
  vmetrics: VMetrics;
  /** Flattened contours for `ch`, mapped through `m` (em, y-up -> user space),
   *  or null when the face has no glyph for it. Absent on a face with no
   *  outline source at all, which is what makes stretch fall back to align. */
  outline?: (ch: string, m: Matrix, tol: number) => Poly[] | null;
}
```

`svgembed.ts`'s `fontProvider` fills it in, because it is already the module
that decides which font a family resolves to and the only one permitted to touch
the document:

- **Standard-14 face** — `getStd14Sfnt(std)` (std14fonts.ts), the bundled
  Liberation + URW substitutes. These are metric-compatible clones, so their
  advances agree with the AFM widths `winAnsiDriver` used to lay the run out.
  They are substitutes, not the real faces, so outline shapes are approximate in
  exactly the way `ToImage` already is — a fact worth stating in the README, not
  a defect to solve here.
- **Caller-supplied `EmbeddedFont`** — its `sfnt`, the same program that will be
  subset and embedded, so the drawn outline is the drawn font.

Both dispatch on `sfnt.outlines`: `'glyf'` uses `sfnt.glyphOutline(gid)`,
`'cff'` uses `new CffFont(sfnt.table('CFF ')!).glyphPath(gid)`, parsed once and
cached on the face. `gid` comes from `sfnt.cmapLookup(cp)`; an uncmapped
character returns `null`.

### 4. One glyph flattener, shared

The flattening these outlines need already exists in raster.ts, privately:
`flattenGlyphContours` + `flattenQuad` for TrueType quadratics, and
`flattenPath` for CFF cubics (which also serves ordinary page fills). Writing a
second copy for the SVG side is what `flattenCubic` was made shared to prevent.

- New `glyphoutline.ts` receives `flattenGlyphContours` and `flattenQuad`, and
  adds the glyf/CFF dispatch both raster.ts and the SVG seam want.
- `flattenPath` moves to `strokegeom.ts`, whose charter is already
  backend-neutral Bézier flattening.
- raster.ts imports both instead of owning them.

Both are **pure moves**. The hardcoded `FLATTEN_TOL` becomes a parameter
defaulted to `FLATTEN_TOL`, so raster.ts's calls are unchanged in behaviour and
the raster + SVG goldens staying byte-identical is the regression guard.

The SVG side passes `tol = FLATTEN_TOL / ctmScale(here)`, so flatness is
device-relative: an SVG placed into a large rect gets proportionally finer
subdivision rather than visible faceting.

### 5. Extraction survives

The warped run is *also* emitted as text, invisibly, at the `align` positions
`mapGlyphsToPath` produced for it (§1) — every glyph of a stretched owner is
marked `invisible` rather than dropped:

```
q  <warped contours>  f  Q
BT 3 Tr /F0 12 Tf  <Tm per glyph>  <Tj>  ET
```

`PlacedGlyph` gains `invisible?: boolean`. `sameRun` compares it, so visible and
invisible glyphs never share a run, and `emitGlyphs` emits `3 Tr` and skips
`setPaint` entirely for an invisible run — there is no colour to set, and
running the paint path would register a gradient nothing paints with.

Placement is the `align` mapping: on the path, upright-per-glyph rather than
warped. Extraction gets the right characters in the right reading order at
positions within a glyph of the ink. Text rendering mode 3 is the standard
"invisible but extractable" device (PDF 32000-1 §9.3.6), the same one scanned-page
OCR layers use.

Accounting follows the ink, not the operators: `usedFonts` gains the face (the
run really does reference it), and `addInk` takes the union of the warped
contours' box and the invisible glyphs' box.

### 6. Decoration

`text-decoration` on a stretched run keeps the per-glyph rotated rects the
`align` path produces — on a curve, a polyline hugging the path. Warping the
rules too would mean running the same warp over four-point rectangles, which is
strictly more code for a difference visible only on a tight curve under a thick
rule. Recorded here as a deliberate limit rather than an oversight.

## Degradation and reporting

Following the established rule that SVG-mandated outcomes are silent while
fidelity losses report:

| Case | Renders | `skipped` |
|---|---|---|
| `method="stretch"`, face has outlines | warped contours + invisible text | — |
| Face with no outline source | as `align`, visible text | `textPath` |
| Glyph with no contours (space, uncmapped) | nothing painted; stays in the overlay | — |
| Glyph midpoint past either end of the path | that glyph alone is dropped | — (SVG mandates) |
| Everything else about `textPath` | unchanged from `1gg0.20` | unchanged |

The second row is today's behaviour exactly, which is what makes the feature
purely additive: a build with no outline source anywhere behaves as it does now.

## Testing

### `test/svg-textstretch.test.ts` — units

- **Vertical straight path.** The mapping is computable in closed form: a point
  at run-distance `d` and perpendicular `uy` must land at `(x0 - uy, y0 + d)`.
  Every warped point must satisfy that, so the whole run occupies a vertical
  band — and an unwarped fallback lays it out horizontally, which the same
  assertion catches.
- **Semicircle.** Contours must actually curve: the tangent angle sampled at the
  first and last glyph must differ by ~180°, and no two glyphs may share a
  rotation.
- **Perpendicular offset.** A glyph's contour must span the face's ascent in the
  normal direction — this is what fails if the `uy` term is dropped.
- **Fallback.** `test/helpers/fake-svg-font.ts` deliberately supplies no
  `outline`, so every existing textPath test already asserts the align fallback.
  One explicit test adds a provider *with* outlines and asserts the same document
  now paints fill operators and reports nothing.
- **Run grouping.** A `<tspan>` inside a stretched `<textPath>` produces two
  `StretchedRun`s, one per style.

### `test/svg-textpath-render.test.ts` — extraction

Save a page carrying a stretched `<textPath>`, reopen it, and assert
`page.GetText()` returns the run's characters. This is the property the whole
invisible-overlay design exists for, so it is asserted end to end through the
real serializer and the real text extractor rather than by inspecting operators.

### Proving the tests load-bearing

Per the repo rule, passing on the first run is not evidence. Four mutations,
each of which must turn a specific test red:

1. Route a stretch owner through `mapGlyphsToPath` → the vertical-band test.
2. Drop the `uy` term from the point mapping → the perpendicular-offset test.
3. Drop the invisible overlay → the `GetText` round trip.
4. Change either moved flattener → the raster and SVG goldens.

## Docs

- README: `method="stretch"` moves from the limitations list to what ships, with
  the two caveats — Standard-14 outlines come from metric-compatible substitutes,
  and the run is vector art with an invisible text layer behind it.
- `src/page.ts`'s `AddSVGObject` doc comment carries the same claim; update it.
- `2026-08-03-svg-textpath-design.md`'s **Out of scope** section gains a pointer
  to this spec.

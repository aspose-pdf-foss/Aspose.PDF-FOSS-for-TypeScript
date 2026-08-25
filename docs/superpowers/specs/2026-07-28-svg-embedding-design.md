# SVG-object embedding (`page.AddSVGObject`) — design

Issue: `aspose-pdf-foss-for-ts-1gg0.3` (epic `1gg0`, page-furniture & text-authoring
parity gaps). Date: 2026-07-28.

Parity target: SVG-object placement in
[Aspose-PDF-FOSS-for-Go](https://github.com/aspose-pdf-foss/Aspose-PDF-FOSS-for-Go/blob/main/_examples/feature_showcase/main.go).

**Direction note.** `svgrender.ts` is PDF→SVG. This is the opposite direction,
SVG→PDF, and shares no code with it.

## Scope

Parse an SVG asset and place it onto a page as vector content, wrapped in a Form
XObject and fitted to a target rectangle.

v1 covers **geometry and paint**:

- **Structure** — `svg`, `g`, `defs`, `use` (with a cycle guard), `clipPath`.
- **Shapes** — `path` (every command, including elliptical arcs and quadratics),
  `rect` (including `rx`/`ry`), `circle`, `ellipse`, `line`, `polyline`,
  `polygon`.
- **Geometry** — `transform` lists (`translate`, `scale`, `rotate` with and
  without a centre, `skewX`, `skewY`, `matrix`), `viewBox`,
  `preserveAspectRatio`.
- **Paint** — `fill`, `stroke`, `fill-rule`, `stroke-width`, `stroke-linecap`,
  `stroke-linejoin`, `stroke-miterlimit`, `stroke-dasharray`,
  `stroke-dashoffset`, `opacity`, `fill-opacity`, `stroke-opacity`; colours as
  `#rgb`, `#rrggbb`, `rgb()`, the CSS named colours, and `none`.
- **Styling** — presentation attributes and inline `style="…"`, with inheritance
  down the element tree.

Out of scope, deliberately, each filed as a follow-up:

- **Text** (`text`, `tspan`). Needs font-family resolution against the
  Standard-14 faces, and anything else needs an embedded font the SVG cannot
  supply.
- **Gradients and patterns** (`linearGradient`, `radialGradient`, `pattern`).
  Maps to PDF shadings, but `spreadMethod`'s repeat/reflect have no direct PDF
  equivalent and need synthesized stops.
- **`<image>`**, **masks**, **filters**, **markers**.
- **CSS `<style>` selectors.** Only presentation attributes and inline `style=`
  are honoured.
- **Transparency groups** for exact group `opacity` (see "Approximations").

## Modules

Follows the barcode stack's precedent (`barcode.ts` / `qr.ts` /
`barcodeplace.ts`): pure geometry models, then a placer. The walker consumes
`XmlNode` from `xml.ts` directly — there is no parallel model tree, because only
the arithmetic benefits from being pure.

- **`src/svgpath.ts`** — the path `d` grammar, normalizing every command to
  cubics (arcs and quadratics converted). Pure. The most bug-prone unit.
- **`src/svgstyle.ts`** — colour parsing and the presentation-attribute +
  inline-`style=` cascade into a resolved paint state. Pure.
- **`src/svgtransform.ts`** — `transform` lists, and `viewBox` +
  `preserveAspectRatio` → placement matrix. Pure.
- **`src/svgdraw.ts`** — walks the `XmlNode` tree and emits a content stream,
  maintaining the `q`/`Q` state stack, clip paths and the skipped-element list.
- **`src/svgembed.ts`** — `page.AddSVGObject`: Form XObject assembly, placement,
  and the public result.
- **`src/page.ts`** — `AddSVGObject` delegating to `svgembed.ts`.
- **`src/index.ts`** — exports `AddSVGOptions`, `AddSVGResult`.

## API

```ts
/** Options for {@link Page.AddSVGObject}. */
export interface AddSVGOptions {
  /** Override the file's own preserveAspectRatio: 'meet' fits the drawing
   *  inside the rect, 'slice' covers it, 'fill' stretches each axis
   *  independently. Default: whatever the SVG asks for (xMidYMid meet). */
  fit?: 'meet' | 'slice' | 'fill';
}

/** The outcome of {@link Page.AddSVGObject}. */
export interface AddSVGResult {
  /** Distinct element names whose rendering was skipped or incomplete, sorted —
   *  e.g. ['linearGradient', 'text']. Empty when the SVG rendered in full. */
  skipped: string[];
}

/** Parse `data` as SVG and draw it into `rect` = [x, y, w, h]. */
AddSVGObject(
  data: Uint8Array, rect: [number, number, number, number], opts?: AddSVGOptions,
): AddSVGResult
```

`Uint8Array` input matches `AddImage` and `AddBarcode`. The `AddSVGObject`
spelling comes from the issue and matches `AddTOC`'s acronym style; it is
knowingly inconsistent with the existing `ToSvg`.

## The coordinate flip

SVG's y axis points **down**; PDF's points **up**. This is the fact that makes
everything else wrong if it is missed, so the design confines it to one place.

Content is emitted in raw viewBox units with y still downward. The Form XObject
gets `/BBox` = the viewBox and an identity `/Matrix`. A single placement matrix
on the page then composes both the viewBox→rect fit and the flip:

```
P = [sx, 0, 0, -sy,  x + tx - vbMinX*sx,  y + h - ty + vbMinY*sy]
```

One pure function in `svgtransform.ts` produces `P`, so the flip is testable on
its own rather than smeared through the walker.

### viewBox resolution

In order: the `viewBox` attribute; else the root `width`/`height` attributes as
`0 0 width height`; else the target rect's own size, which makes the mapping
identity.

### preserveAspectRatio

`<align> [<meetOrSlice>]`, default `xMidYMid meet`. `align` is one of `none` or
the nine `x{Min,Mid,Max}Y{Min,Mid,Max}` combinations.

| resolved | scale | alignment |
|---|---|---|
| `meet` | `sx = sy = min(w/vbW, h/vbH)` | per `align` within the rect |
| `slice` | `sx = sy = max(w/vbW, h/vbH)` | per `align` within the rect |
| `none` | `sx = w/vbW`, `sy = h/vbH` | n/a — the rect is filled exactly |

The alignment offsets are the leftover space times the align fraction — 0 for
`Min`, 0.5 for `Mid`, 1 for `Max`:

```
tx = fracX * (w - vbW * sx)
ty = fracY * (h - vbH * sy)      // measured DOWNWARD from the rect's top edge
```

`ty` running downward is what makes it compose with the flip in `P`: `yMin`
(top-aligned) gives `ty = 0` and puts the content's top edge at `y + h`, while
`yMax` pushes it down to sit on `y`. Both are negative under `slice`, which is
correct — the content overflows and is clipped.

`opts.fit` overrides the file: `'meet'` → `xMidYMid meet`, `'slice'` →
`xMidYMid slice`, `'fill'` → `none`.

Because `slice` deliberately overflows the viewport, the placement **always**
wraps the drawing in a `W n` clip to `rect`. An SVG can never paint outside the
rectangle it was given, whatever it asks for.

## Walker and paint state

`svgdraw.ts` walks the tree, pushing `q`/`Q` around any element that carries a
transform or a style change, and popping on exit.

Non-rendering elements — `title`, `desc`, `metadata` — are ignored **without**
being reported: they are not a fidelity loss.

Two initial values that are easy to get backwards, each with its own test:

- the initial `fill` is **black**, not none;
- the initial `stroke` is **none**, not black.

`<use>` resolves `href` / `xlink:href` to an `id` and re-walks that subtree
behind a visited-set cycle guard, so a self-referencing `use` terminates rather
than hanging.

`clipPath` emits its child geometry followed by `W n` before the clipped
content. Nested clips intersect naturally through the `q`/`Q` stack.

### Paint mapping

| SVG | PDF |
|---|---|
| `fill` + `fill-rule: nonzero` / `evenodd` | `f` / `f*` |
| `stroke` | `S` |
| both | `B` / `B*` |
| `fill="none"`, `stroke="none"` | the op is simply not emitted |
| `stroke-width` | `w` |
| `stroke-linecap` butt/round/square | `J` 0/1/2 |
| `stroke-linejoin` miter/round/bevel | `j` 0/1/2 |
| `stroke-miterlimit` | `M` |
| `stroke-dasharray` + `stroke-dashoffset` | `d` |
| `fill-opacity` / `stroke-opacity` | `/ca` / `/CA` in an `/ExtGState` |

### Unsupported paint references

An unsupported or unresolvable paint (`fill="url(#grad)"`) follows SVG's own
rule: honour an explicit fallback colour when one is given
(`fill="url(#g) red"`), otherwise treat the paint as `none`. The referenced
element's name goes into `skipped`.

It never falls back to black. A silently-wrong solid fill is worse than a
visibly missing one, because only the second is noticeable.

## Approximations

Stated plainly rather than left to be discovered:

**Group `opacity`.** v1 multiplies a `<g opacity>` into its children's `/ca` and
`/CA`. For non-overlapping content this is exact; where children overlap it is
not — correct semantics require a transparency group, deferred to a follow-up.
This is an approximation, not a skip, so it is **not** reported in `skipped`;
it is documented in the README instead.

## Errors

| Condition | Error |
|---|---|
| malformed XML | `PdfParseError` (thrown by `xml.ts`) |
| root element is not `<svg>` | `PdfParseError` |
| `rect` not `[x, y, w, h]` of finite numbers, or non-positive `w`/`h` | `TypeError` |
| `fit` not `'meet'`, `'slice'` or `'fill'` | `TypeError` |

Malformed **path data** is not an error: SVG's own error handling is to render
the valid prefix and stop, which v1 follows, adding the element name to
`skipped` to signal the degradation.

Validation of `rect` and `fit` runs before anything is allocated, so a rejected
call leaves the document byte-identical.

## Testing

Programmatic SVG builders in `test/helpers`, keeping the suite hermetic. The
pure modules carry most of the weight, since that is where a failure can be
isolated to one cause.

- **`svgpath.ts`** — every command, absolute and relative; implicit repeated
  commands; the implicit `lineto` after a `moveto`; exponent notation and
  omitted separators; `S`/`T` smooth-control reflection; all four
  large-arc × sweep flag combinations; degenerate arcs (`rx` or `ry` = 0 → a
  line). **Arc conversion is checked against an independent circle formula, not
  against our own converter** — per the CLAUDE.md rule that a differential test
  cannot validate the interpreter it runs through.
- **`svgstyle.ts`** — `#rgb`, `#rrggbb`, `rgb()`, named colours, `none`;
  `style=` winning over the equivalent presentation attribute; inheritance
  through nested `<g>`; the black-fill / none-stroke initial values.
- **`svgtransform.ts`** — each transform function, including `rotate` about a
  centre; composition order (left-to-right = outermost first); all nine aligns ×
  `meet`/`slice`, plus `none`; the y-flip; viewBox fallback chain.
- **`svgdraw.ts`** — content-stream assertions per shape; `f` vs `f*`; clip
  emitting `W n`; `use` resolution; the cycle guard terminating; `skipped`
  collection.
- **`svgembed.ts`** — `/BBox` and `/Matrix` on the built XObject, the placement
  `cm`, the always-present rect clip, `skipped` surfaced through the result, and
  a `Save()`/`Open()` round-trip.

Per the repo rule, any assertion passing on its first run is proved load-bearing
by mutation before being accepted — in particular the y-flip sign and the
fill/stroke initial values.

### Real-world fixture — deliberately deferred

SVG path data is exactly the case CLAUDE.md's third-party fixture rule exists
for: our parser and our test builders could agree with each other and both
disagree with the format, over lexical quirks like implicit repeated commands,
exponent notation and omitted separators.

Sourcing one properly needs a named producer and a `PROVENANCE.md` recording
producer, version, command and SHA-256. That is filed as its own follow-up
rather than satisfied with an arbitrary file, so v1's suite stays hermetic and
offline.

## Documentation

`README.md`: a feature bullet beside the image-insertion entry, and a row in the
API table. The group-`opacity` approximation and the v1 scope boundary are
recorded there, since they are what a user will hit first.

## Follow-ups

Each filed under epic `1gg0`:

1. SVG gradients (`linearGradient` / `radialGradient` → PDF shadings).
2. SVG text (`text` / `tspan`).
3. SVG `<image>` embedding.
4. SVG masks, filters and markers.
5. CSS `<style>` selector support.
6. Transparency groups for exact group `opacity`.
7. A real-world SVG fixture with provenance.

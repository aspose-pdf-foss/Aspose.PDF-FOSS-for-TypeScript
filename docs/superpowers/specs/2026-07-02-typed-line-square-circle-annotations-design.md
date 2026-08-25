# Typed Line / Square / Circle Annotations

**Issue:** aspose-pdf-foss-for-ts-i1p (sub-issue 1 of 3)
**Date:** 2026-07-02

## Context

The annotation model (`src/annotation.ts`, `src/appearance.ts`) currently ships
typed create/edit + appearance generation for Text, Stamp,
Highlight/Underline/StrikeOut/Squiggly, Link, and FileAttachment. Other subtypes
read back only as the base `Annotation` via `.Dict`, with no typed setters
(README Limitations).

Issue i1p asks to extend the model with FreeText, Ink, Line, Square/Circle,
Polygon/Polyline, and Popup. That is too large for one plan, so it is split by
complexity into three sub-issues:

1. **This spec — simple shapes: Line, Square, Circle.** They share a small,
   self-contained appearance vocabulary (stroke, fill, one Bézier ellipse, a
   couple of arrowhead paths).
2. Path shapes: Polygon, Polyline, Ink (multi-vertex / multi-stroke paths).
3. FreeText + Popup (text layout; Popup is a companion to a parent markup).

Sub-issues 2 and 3 are filed as follow-ups and are out of scope here.

## Scope

Add typed handle classes, `Page.Add*` create APIs, live accessors, and generated
`/AP /N` appearance streams for `/Line`, `/Square`, and `/Circle`, mirroring the
existing Text/Stamp/Markup patterns. Tests + fixtures per subtype. README updated.

Non-goals: Polygon/Polyline/Ink/FreeText/Popup (later sub-issues); measurement
lines (`/Line` `/Measure`, captions); dashed/cloudy border styles (`/BS /D`,
`/BE`) — border is a solid width only.

## Handle classes (`src/annotation.ts`)

### `SquareCircleAnnotation extends Annotation`
Shared by both `/Square` and `/Circle` (as `MarkupAnnotation` covers four
subtypes). Accessors:
- `ShapeType`: `'square' | 'circle'` derived from `/Subtype`.
- `InteriorColor`: `/IC` as `[r,g,b]` in 0..1, or `undefined`. Setter validates
  components in 0..1; `undefined` deletes `/IC`.
- `BorderWidth`: `/BS /W` number; getter returns the resolved width (default 1
  when absent); setter writes `/BS << /Type /Border /W n >>`, validating a
  non-negative finite number.

### `LineAnnotation extends Annotation`
Accessors:
- `Line`: `/L` as `[x1,y1,x2,y2]`, or `undefined` when missing/malformed.
  Setter validates 4 finite numbers.
- `BorderWidth`: `/BS /W`, as above.
- `LineEndings`: `/LE` as `[start, end]` of `LineEnding`; `undefined` when
  absent. Setter validates both names against the supported set.

`BorderWidth` lives on each of these two classes (not base `Annotation`) so
Text/Link/etc. do not gain a meaningless border accessor. It can be lifted to a
shared intermediate base when Polygon/FreeText need it in later sub-issues.

### Dispatch
Add cases to `wrapAnnotation`: `'Line' -> LineAnnotation`,
`'Square' | 'Circle' -> SquareCircleAnnotation`.

## Create API (`Page` methods → `annotation.ts` functions)

Thin `Page` wrappers (as with `AddStamp`/`AddHighlight`) delegating to
`addLine`/`addSquare`/`addCircle` in `annotation.ts`.

```ts
export type LineEnding = 'None' | 'OpenArrow' | 'ClosedArrow' | 'Circle' | 'Square';

export interface LineOptions {
  line: [number, number, number, number]; // endpoints x1,y1,x2,y2 (sets /L)
  color?: [number, number, number];        // stroke /C, default black [0,0,0]
  width?: number;                          // /BS /W, default 1
  startEnding?: LineEnding;                // default 'None'
  endEnding?: LineEnding;                  // default 'None'
  contents?: string;
  opacity?: number;                        // /CA, 0..1
}

export interface SquareCircleOptions {
  rect: [number, number, number, number];
  color?: [number, number, number];       // border /C, default black [0,0,0]
  fill?: [number, number, number];         // interior /IC, optional (omitted → no fill)
  width?: number;                          // border /BS /W, default 1
  contents?: string;
  opacity?: number;                        // /CA, 0..1
}
```

`Page.AddLine(opts): LineAnnotation`,
`Page.AddSquare(opts): SquareCircleOptions → SquareCircleAnnotation`,
`Page.AddCircle(opts): SquareCircleAnnotation`.

Validate-before-attach: every input is validated before any object is allocated
or attached to `/Annots` (matching `addStamp`/`addMarkup`).

## Appearance generation

New helpers in `annotation.ts`, reusing `buildAppearanceXObject`, `installAP`,
`WidgetGeom`, and the `/GS0` ExtGState opacity path already used by `addMarkup`
(when `opacity < 1`, prepend `/GS0 gs` and register a `ca`/`CA` ExtGState in the
form's `/Resources`).

### Square
`/Rect` is used as given. The stroked rectangle is inset by half the border width
so the stroke stays inside `/Rect`; the inset is recorded in `/RD`
(`[dx dx dx dx]`). Body: optional `r g b rg` (fill) + `r g b RG w` (stroke) +
`x y w h re` + `B` (fill+stroke) / `S` (stroke only) / `f` (fill only, width 0).

### Circle
Ellipse inscribed in the same inset rect, drawn with 4 Bézier curves
(κ = 0.5523). Same fill/stroke selection as Square.

### Line
`/L` holds the true endpoints in page space. `/Rect` is derived from the endpoint
bounding box padded by `margin = max(width, endingSize)` (as markups derive
`/Rect` from `/QuadPoints`). Endpoints are translated into form space
(`/BBox [0 0 w h]`). The segment is stroked p1→p2; arrowheads/shapes for
`startEnding`/`endEnding` are drawn oriented along the line direction:
- `OpenArrow`: two stroked barbs forming a "V".
- `ClosedArrow`: filled triangle.
- `Square` / `Circle`: small filled shape centered on the endpoint.
- `None`: nothing.

`endingSize` scales with border width (e.g. `max(8, 3·width)`).

## Testing (`test/`)

Fixtures in `test/helpers/build-annot-target.ts`: read-back builders producing a
page with a `/Square` (with `/IC`, `/BS`), a `/Circle`, and a `/Line`
(with `/L`, `/LE`). Mirror the existing `buildMarkupReadTarget` style.

`test/annotation.test.ts` additions:
- **Read model:** typed handles from `Page.Annotations`; `ShapeType`,
  `InteriorColor`, `BorderWidth`, `Line`, `LineEndings` read correctly.
- **Setters:** round-trip `InteriorColor`, `BorderWidth`, `Line`, `LineEndings`;
  `undefined`/out-of-range rejected with `TypeError`.
- **Create:** `AddSquare`/`AddCircle`/`AddLine` attach a well-formed dict to
  `/Annots` with `/Type /Annot`, correct `/Subtype`, `/Rect`, default `/F` print,
  and an installed `/AP /N` Form XObject.
- **Appearance sanity:** decoded `/AP /N` content stream contains the expected
  ops (`re`/`B` for Square, Bézier `c` ops for Circle, `m`/`l`/`S` + arrowhead
  path for Line); `/GS0 gs` present when `opacity < 1`.
- **Validate-before-attach:** invalid inputs throw before `/Annots` grows.

Run `npm run typecheck` and `npm test` green before closing.

## Docs (`README.md`)

- Add `AddSquare`/`AddCircle`/`AddLine` usage to the annotations example and the
  API-overview table.
- Extend the typed-handle paragraph with `SquareCircleAnnotation`
  (`ShapeType`/`InteriorColor`/`BorderWidth`) and `LineAnnotation`
  (`Line`/`LineEndings`/`BorderWidth`).
- Update the Limitations note to list only the still-unmodeled subtypes:
  FreeText, Ink, Polygon/Polyline, Popup.

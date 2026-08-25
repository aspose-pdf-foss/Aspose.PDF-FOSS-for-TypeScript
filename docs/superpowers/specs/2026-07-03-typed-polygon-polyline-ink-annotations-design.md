# Typed Polygon / Polyline / Ink Annotations

**Issue:** aspose-pdf-foss-for-ts-g6p (sub-issue 2 of 3 under i1p)
**Date:** 2026-07-03

## Context

The annotation model (`src/annotation.ts`, `src/appearance.ts`) ships typed
create/edit + appearance generation for Text, Stamp,
Highlight/Underline/StrikeOut/Squiggly, Link, FileAttachment, the geometric
shapes Line/Square/Circle (sub-issue 1, `i1p`), and FreeText/Popup (sub-issue 3,
`ur5`). The remaining path-shape subtypes — `/Polygon`, `/PolyLine`, `/Ink` —
still read back only as the base `Annotation` via `.Dict`, with no typed setters
(README Limitations).

This sub-issue adds them, mirroring the Line/Square/Circle patterns: a live-dict
handle class per shape, a `createAnnotation`-based `add*` factory that validates
before allocating, and a content-stream `/AP /N` built with
`buildAppearanceXObject` / `installShapeAP`. `Page` methods are thin wrappers.

## Scope

Typed handle classes, `Page.Add*` create APIs, live accessors, and generated
`/AP /N` appearance streams for `/Polygon`, `/PolyLine`, and `/Ink`. Tests +
fixtures per subtype. README updated.

Non-goals: dashed/cloudy border styles (`/BS /D`, `/BE`), Bézier-smoothed ink
(strokes are drawn as straight polylines through the input points), measurement
(`/Measure`), and rich-content captions.

## Handle classes (`src/annotation.ts`)

### `PolyAnnotation extends Annotation`
Shared by `/Polygon` and `/PolyLine` (as `SquareCircleAnnotation` covers two
subtypes). Accessors:
- `PolyType`: `'polygon' | 'polyline'` derived from `/Subtype`.
- `Vertices`: `/Vertices` as a flat `number[]` (`[x1,y1,x2,y2,…]`); `[]` when
  absent. Setter validates a non-empty list of finite numbers of even length ≥ 4
  (at least two points).
- `InteriorColor`: `/IC` as `[r,g,b]` in 0..1, or `undefined` (fill; primarily a
  closed-polygon feature). Setter validates 0..1; `undefined` deletes `/IC`.
- `BorderWidth`: `/BS /W` number (default 1); setter writes
  `/BS << /Type /Border /W n >>` (shared `readBorderWidth`/`setBorderWidth`).
- `LineEndings`: `/LE` as `[start, end]` of `LineEnding`; `undefined` when
  absent (meaningful for `/PolyLine`). Setter validates both names.

### `InkAnnotation extends Annotation`
Accessors:
- `InkList`: `/InkList` as `number[][]` — one flat point list per stroke; `[]`
  when absent. Setter validates a non-empty array of strokes, each a finite,
  even-length (≥ 4) number list.
- `BorderWidth`: `/BS /W`, as above.

## Create API + appearance (`src/annotation.ts`, `src/page.ts`)

Reuse the shared validators/helpers from sub-issue 1: `checkOptColor`,
`checkOptWidth`, `checkOptOpacity`, `installShapeAP`, `paintOp`, `drawEnding`,
`widgetGeom`, `quadsBBox` (works over any even-length flat coordinate list),
`LINE_ENDINGS`, `num`.

### `Page.AddPolygon(opts): PolyAnnotation`
`PolygonOptions`: `{ vertices; popup?; color?; fill?; width?; contents?; opacity? }`.
- `/Rect` = vertices bbox padded by `max(width, 1)`.
- Appearance: move to the first vertex, line to each remaining vertex, close
  (`h`), then `paintOp(width>0, fill!==undefined)` (`B`/`f`/`S`). Fill uses `/IC`.

### `Page.AddPolyline(opts): PolyAnnotation`
`PolylineOptions`: `{ vertices; popup?; color?; width?; startEnding?; endEnding?; contents?; opacity? }`.
- `/Rect` = vertices bbox padded by `endingSize` when either ending is set, else
  `max(width, 1)`.
- Appearance: move to the first vertex, line to the rest, `S`; then a start
  ending at v0 (outward = v1→v0) and an end ending at the last vertex
  (outward = v_{n-2}→v_{n-1}), via `drawEnding`.

### `Page.AddInk(opts): InkAnnotation`
`InkOptions`: `{ paths; popup?; color?; width?; contents?; opacity? }` where
`paths: number[][]`.
- `/Rect` = bbox over all points across all strokes, padded by `max(width, 1)`.
- Appearance: for each stroke, move to its first point, line to the rest, `S`.

All three set the border via `setBorderWidth`, record `/CA` when opacity is
given, translate geometry into form space (origin at `/Rect` lower-left), and
install the `/AP /N` through `installShapeAP` (which wraps a `/GS0` ExtGState
when opacity < 1). Zero-area `/Rect` skips appearance generation (annotation is
still created), matching the other `add*` factories. Every factory validates all
inputs before allocating any object (validate-before-attach).

## Errors
`TypeError`/`RangeError` for bad public input, matching existing setters/factories.

## Tests (`test/annotation.test.ts`, `test/helpers/build-annot-target.ts`)
- Fixture `buildPathReadTarget()`: a page with `/Polygon` (`/Vertices` + `/IC` +
  `/BS`), `/PolyLine` (`/Vertices` + `/LE`), and `/Ink` (multi-stroke
  `/InkList`).
- Read model: dispatch to `PolyAnnotation`/`InkAnnotation`; accessors read back;
  round-trip + rejection of bad input.
- Create API: `AddPolygon`/`AddPolyline`/`AddInk` set the right dict entries,
  derive `/Rect`, generate the expected `/AP` operators (`re`-free path built
  from `m`/`l`/`h`; `B`/`f`/`S`; `c`-free), apply opacity via `/GS0`, and
  validate before attaching (no stranded objects on throw).

## README
Add the three `Add*` calls to the annotations example, extend the typed-handle
paragraph with `PolyAnnotation` and `InkAnnotation`, add API-table rows, and drop
`Ink`/`Polygon`/`Polyline` from the "still read back as a base `Annotation`"
Limitations note (leaving it as the residual set).

# Flow inline images — design (db7v.5)

**Issue:** aspose-pdf-foss-for-ts-db7v.5 (parent epic db7v — Flow layout engine)
**Date:** 2026-07-24
**Status:** approved, ready to plan
**Depends on:** db7v.1 (Flow container: geometry, columns, auto-pagination) — shipped

## Goal

`flow.AddImage(data, options)`: place a raster image (JPEG/PNG) inline in the flow
as its own block element — sized to the column, aspect-preserving, alignable,
paginating atomically, and (when the flow is tagged) tagged as `/Figure`.

## Approach

Reuse the existing image stack unchanged. `buildImageXObject(data, format?)`
parses/embeds the raster into a `BuiltImage` (no `Document` needed);
`drawBuiltImage(doc, page, built, [x, y, w, h], { tag })` paints it. These are the
same primitives `FloatingBox.AddImage` already uses, including `/Figure`+`/Alt`
tagging via `structParent.Append('Figure', { alt })`.

A new `ImageElement implements FlowElement` plugs into the `Flow` engine
(`place`/`measure`, `spaceBefore`/`spaceAfter`). It is **atomic** — an image never
splits across a column boundary.

### Sizing (lazy, region-relative)

Size is resolved from the region width the engine passes at placement
(`ctx.width`), so `place` and `measure` always agree (both call one shared
`resolveSize(regionWidth)`):

```
ih, iw = intrinsic pixel dimensions (from the built XObject's /Width, /Height)
baseW  = options.width ?? regionWidth                    // default fills the region
baseH  = (options.height && options.height > 0) ? options.height : baseW * (ih / iw)
if baseW > regionWidth:
    factor = regionWidth / baseW
    drawW  = regionWidth
    drawH  = baseH * factor                              // clamp preserves the requested aspect
else:
    drawW  = baseW
    drawH  = baseH
```

- **Default width** (`width` omitted) = the region width → the image fills the
  column.
- **Clamp:** a requested width wider than the region is scaled down to the region
  width, preserving whatever aspect was requested (intrinsic, or an explicit
  `height`). An image therefore never overflows the column horizontally.
- **Beside a float:** `ctx.width` is the narrowed channel, so the image fits it;
  if the image cannot fit there the engine's existing `besideFloat` path retries
  it full width (float cleared), where `resolveSize` re-resolves it larger. This
  is atomic and consistent with how text reflows past a float.

### Alignment

`align: 'left' | 'center' | 'right'` (default `'left'`) offsets the image within
the region:

```
offsetX = align === 'center' ? (regionWidth - drawW) / 2
        : align === 'right'  ?  regionWidth - drawW
        : 0
drawX = ctx.x + offsetX
```

Since `drawW <= regionWidth` always, `offsetX >= 0`. The offset is within the
region (narrowed beside a float), consistent with text alignment.

### `FlowElement` implementation

`place(ctx)` (EPS = the engine's `1e-9` tolerance):

- `ctx.availHeight <= 0` → `{ usedHeight: 0, remainder: this, drew: false }`.
- resolve size from `ctx.width`.
- `drawH > ctx.availHeight + EPS` → `{ usedHeight: 0, remainder: this, drew: false }`
  (atomic: nothing drawn; the engine advances the column, or throws "does not fit
  in an empty column" when already at a column start — the same contract as
  `FloatingBox`).
- otherwise: when `structParent` is present (tagged flow), append one `/Figure`
  (with `/Alt` if `alt` was given); `drawBuiltImage(ctx.doc, ctx.page, built,
  [drawX, ctx.top - drawH, drawW, drawH], fig ? { tag: fig } : {})`; return
  `{ usedHeight: drawH, remainder: null, drew: true }`.

`measure(ctx)`:

- `ctx.availHeight <= 0` → `{ usedHeight: 0, fits: false }`.
- resolve size; `drawH <= ctx.availHeight + EPS` → `{ usedHeight: drawH, fits: true }`,
  else `{ usedHeight: 0, fits: false }`.

Because the image is atomic, `measure.usedHeight` is `0` unless the whole image
fits — so an image is a correct keep-with-next **successor** (a heading keeps with
a following image only when the entire image fits beneath it). An image is **not**
`keepWithNextEligible` (only headings are).

`spaceBefore`/`spaceAfter` are `readonly` fields the engine already reads for the
gap-before-element computation (additive with `paragraphSpacing`, dropped at a
column top).

## Public API

```ts
/** Options for {@link Flow.AddImage}. All lengths are in points. */
export interface FlowImageOptions {
  /** Drawn width. Default: the column (region) width. Clamped to the region
   *  width if larger (aspect preserved). > 0. */
  width?: number;
  /** Drawn height. Omitted/0 → auto from aspect ratio at the drawn width. >= 0. */
  height?: number;
  /** Force the decoder; default sniffs JPEG/PNG magic bytes. */
  format?: 'jpeg' | 'png';
  /** Horizontal alignment within the column. Default 'left'. */
  align?: 'left' | 'center' | 'right';
  /** Alt text for the `/Figure` when the flow is tagged. */
  alt?: string;
  /** Points inserted above the image (dropped at a column top). >= 0. Default 0. */
  spaceBefore?: number;
  /** Points inserted below the image (dropped at a column top). >= 0. Default 0. */
  spaceAfter?: number;
}

class Flow {
  /** Append a raster image (JPEG/PNG) as its own flow block. Chainable. */
  AddImage(data: Uint8Array, options?: FlowImageOptions): this;
}
```

Validation (all throw `TypeError` except the format sniff):

- `width`, if given: positive finite.
- `height`, if given: non-negative finite.
- `align`, if given: one of `'left'`/`'center'`/`'right'`.
- `alt`, if given: a string.
- `spaceBefore`/`spaceAfter`: non-negative finite (via the existing
  `normalizeSpacing`/`nonNegative` helpers).
- An unrecognized image format throws `UnsupportedFeatureError` (from
  `buildImageXObject` — JPEG and PNG only).

`buildImageXObject(data, format)` runs eagerly in `AddImage` (embed at authoring
time, like `FloatingBox.AddImage`); intrinsic `/Width` and `/Height` are read off
the built XObject dict.

### Test-only factory

```ts
/** Test-only factory for a flow image element. @internal */
export function makeImage(data: Uint8Array, options?: FlowImageOptions): FlowElement;
```

Mirrors `makeParagraph`/`makeList` so `place`/`measure` are unit-testable without
a full render. `ImageElement` needs no `Document` at construction (the built
XObject is `doc`-independent; `drawBuiltImage` takes `ctx.doc` at place time).

## Implementation shape

`src/flow.ts` gains:

- `FlowImageOptions` interface.
- `class ImageElement implements FlowElement` — fields: `built: BuiltImage`,
  `iw`/`ih` (intrinsic), `reqWidth?`/`reqHeight?`, `align`, `alt?`,
  `spaceBefore`/`spaceAfter`; a private `resolveSize(regionWidth)`; `place` and
  `measure` as above.
- `makeImage(data, options)` factory.
- `Flow.AddImage(data, options)` — validates, builds the XObject, pushes an
  `ImageElement`.

No engine changes: `ImageElement` is just another `FlowElement`, so gap/spacing,
pagination, keep-with-next lookahead, and the "empty column" guard all apply
unchanged.

## Testing (`test/flow.test.ts`, additive)

PNG fixtures via the existing `buildPngRgb` helper (already imported by the test
file). Assertions proven load-bearing.

- **Default fills the column** — `AddImage(png)` with no options draws at the
  column width with aspect height (assert the emitted `cm` scale / drawn rect
  width equals the column width, height = width * ih/iw).
- **Explicit width honored** — `{ width: W }` (W < column) draws at W.
- **Over-column width clamped** — `{ width: hugeW }` draws at the column width,
  height scaled by `columnWidth / hugeW` (aspect preserved).
- **Alignment** — `align: 'left'|'center'|'right'` place the image at
  `columnX`, `columnX + (colW - drawW)/2`, and `columnX + colW - drawW`
  respectively (assert the `cm` translate x, or `makeImage(...).place` into a
  known rect).
- **Atomic pagination** — a filler that leaves less than the image height, then an
  image, pushes the image wholly to the next column/page (image absent on page 1,
  present on page 2; never split).
- **Too tall for a column throws** — an image taller than a full empty column
  throws `/does not fit in an empty column/`.
- **Spacing** — `spaceBefore`/`spaceAfter` shift following content by the expected
  points (extracted text Y), and drop at a column top.
- **Tagged `/Figure`** — a tagged flow with one image round-trips through `Save()`
  → `GetStructTree()`; exactly one `/Figure` with the given `/Alt`.
- **Keep-with-next successor** — a heading immediately before an image pushes when
  the whole image does not fit beneath it, and does not push when it does
  (image treated atomically via `measure`).
- **Validation** — bad `width`/`height`/`align`/`alt`/`spaceBefore`/`spaceAfter`
  throw `TypeError`; a non-image blob throws `UnsupportedFeatureError`.
- **`makeImage` unit** — `place` returns `drew:false, remainder:self` when
  `availHeight` is too small; `drew:true, remainder:null` when it fits; `measure`
  reports `fits` accordingly.
- **Regression** — existing flow/floatbox tests stay green (no engine change).

## Defaults chosen (flagged for record)

- **Default width = column width** (fills the region), matching
  `FloatingBox.AddImage`'s content-width default.
- **Clamp over-wide images** to the region (never overflow horizontally), rather
  than honoring an over-wide explicit width (which `FloatingBox` does) — flow
  images live in the main text column and bleeding past it is a layout bug.
- **`align` default `'left'`**, matching text/paragraph defaults; body text and
  left-aligned images share the column edge.
- **Atomic** — an image taller than a full column throws (consistent with
  `FloatingBox`), rather than auto-shrinking to the column height.

## Out of scope (follow-up)

- Text wrapping *around* an inline image (an image is a full-width block; wrap-
  around is the floating-box feature, db7v.4 / db7v.9 / db7v.10).
- Captions as a coupled unit (author a following `AddParagraph`; keep-with-next
  is heading-only).
- Vector/SVG or PDF-page images (raster JPEG/PNG only, per `buildImageXObject`).

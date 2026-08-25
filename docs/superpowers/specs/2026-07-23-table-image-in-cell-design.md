# Table: Image-in-cell support (49l.7)

**Issue:** aspose-pdf-foss-for-ts-49l.7 (epic 49l — Table authoring & rendering)
**Depends on:** 49l.4 (page.AddTable rendering + public API), shipped.
**Date:** 2026-07-23

## Goal

`cell.setImage(data, opts?)`: embed a JPEG/PNG (via `imageembed.ts`) into a table
cell, aspect-fit to the cell box with alignment. A cell may carry both an image
and text (text is painted over the image). Parity with Aspose's `Cell.SetImage`.

## API

A chainable method on `CellBuilder`:

```ts
row.addCell('', {}).setImage(data: Uint8Array, opts?: CellImageOptions): this
```

```ts
interface CellImageOptions {
  /** Explicit image content height in points. Default: aspect-fit to the cell's
   *  inner width (imgH * innerWidth / imgW). */
  height?: number;
  /** Horizontal placement of the image in the cell box. Default: the cell's
   *  resolved text align. */
  align?: 'left' | 'center' | 'right';
  /** Vertical placement of the image in the cell box. Default: the cell's
   *  resolved text valign. */
  valign?: 'top' | 'center' | 'bottom';
  /** Constant opacity 0..1 (reuses /ExtGState). Default 1. */
  opacity?: number;
  /** Override JPEG/PNG sniffing. */
  format?: 'jpeg' | 'png';
}
```

- `setImage` calls `buildImageXObject(data, opts.format)` once. That validates the
  bytes (throwing `UnsupportedFeatureError`/`PdfParseError` for unsupported or
  malformed images) and yields the intrinsic pixel `Width`/`Height` from the
  built XObject's dict.
- It stashes `{ built: BuiltImage; width: number; height: number; opts:
  CellImageOptions }` on the cell (a new mutable `image?` field on `CellBuilder`).
- Validation reuses the existing checkers: `checkPos('image height', ...)` for
  `height`, `checkAlign`/`checkValign` for the alignments, and a 0..1 range check
  for `opacity`. `data` must be a `Uint8Array`.
- Chainable: returns `this`.

## Measurement (`tableauthor.ts` `measure`)

For a cell with an image, its **image content height** is:

```
imageContentHeight = opts.height ?? (imgH * innerWidth / imgW)
```

where `innerWidth = outerWidth - 2 * padding`. The cell's height becomes:

```
cellHeight = max(max(1, textLines) * leading, imageContentHeight) + 2 * padding
```

So an image-only row sizes itself to the image, an image+text cell takes the
taller of the two, and text-only cells keep today's exact height. The measurement
reads only the numeric `width`/`height` cached on `cell.image` (no XObject
internals).

## Painting (`tablerender.ts`)

- The `Placed` interface gains an optional `image` field carrying the cached
  `BuiltImage`, its intrinsic `width`/`height`, and the resolved
  align/valign/opacity/height for that cell.
- `placeRows` copies `cell.image` into the `Placed` it produces.
- `paintPlaced` gets a new pass, so paint order is:
  **backgrounds → images → text → borders**. Text draws over the image;
  image-only cells simply have empty text.
- Each image is drawn **contained** (aspect-preserving) into a box of
  `innerWidth × imageContentHeight`:
  ```
  scale  = min(innerWidth / imgW, imageContentHeight / imgH)
  drawnW = imgW * scale
  drawnH = imgH * scale
  ```
  then positioned within the cell's full inner box (`innerWidth × innerHeight`,
  where `innerHeight = cellHeight - 2*padding`) by align/valign:
  ```
  ix = cellX + padding;  iy = cellBottom + padding
  x  = ix + (align:  left → 0, center → (innerWidth  - drawnW)/2, right  → innerWidth  - drawnW)
  y  = iy + (valign: bottom → 0, center → (innerHeight - drawnH)/2, top   → innerHeight - drawnH)
  ```
  Containing against `imageContentHeight` (not the full `innerHeight`) means an
  explicit `height` caps the image even when a sibling cell makes the row taller.

## New shared helper (`imageembed.ts`)

Factor the embed+paint tail of `addImage` into:

```ts
export function drawBuiltImage(
  doc: Document, page: Page, built: BuiltImage,
  rect: [number, number, number, number], opts?: { opacity?: number },
): void
```

- It **clones** the XObject stream dict (and any soft-mask stream) before
  allocating, so the same cached `BuiltImage` can be embedded independently on
  multiple pages (a repeating-header image) without dict aliasing.
- Registers the XObject in the page's own `/XObject` resources, wraps in an
  `/ExtGState` opacity group when `opacity < 1`, and appends the
  `q … w 0 0 h x y cm /Im Do Q` content.
- `addImage` becomes `buildImageXObject(...)` then `drawBuiltImage(...)`, with its
  external signature and behavior unchanged (tag/layer handling stays in
  `addImage`).

The table image pass calls `drawBuiltImage` once per image cell.

## Pagination / edge cases

- Repeating-header (49l.6) and manual-remainder paths re-paint the same
  `CellBuilder` references per page, so a header image reprints on every page; the
  clone in `drawBuiltImage` gives each page an independent XObject.
- `colSpan` image cells work: the inner width is the sum of the spanned columns
  (same cursor walk as text/background).
- Malformed/unsupported image bytes throw at `setImage` time (fail fast, before
  layout).

## Tests (vitest, programmatic fixtures)

A helper builds a tiny valid PNG (e.g. 2×1 and 1×1, 8-bit RGB) and a minimal
baseline JPEG. Assertions:

- The image XObject is registered in the page's `/XObject` subdict after
  `AddTable`.
- The `cm` matrix scales/places the image correctly for the aspect-fit case and
  for an explicit `height` (height-capped) case.
- align/valign move the image within the cell box (left/center/right,
  top/center/bottom).
- Image + text coexist: both the image XObject and the text glyphs are present in
  the cell.
- A taller-than-text image drives the row height (measure/placement reflects it).
- A `colSpan` image spans the combined column width.
- `opacity < 1` registers an `/ExtGState` and references it before the `Do`.
- With auto-pagination + a repeating header row that has an image, the image
  XObject appears on every appended page.
- Invalid image bytes throw `UnsupportedFeatureError`/`PdfParseError`; a bad
  `height`/`align`/`opacity` throws `TypeError`.

## Docs

Add `setImage` to the table section of `README.md`.

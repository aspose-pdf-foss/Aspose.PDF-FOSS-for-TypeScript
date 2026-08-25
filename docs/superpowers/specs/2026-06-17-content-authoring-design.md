# Content Authoring — Design Spec (Phase 1)

Date: 2026-06-17

## Context

The library can read, parse, decrypt, extract from, and re-serialize PDFs, and
it can mutate the page tree, fill forms, edit metadata/outlines, and *stamp a
single line of Helvetica text* onto a page. What it cannot do is **author page
content**: there is no general way to draw vector graphics, place a raster
image, or lay out richer text.

This spec defines **Phase 1 — Content authoring**, the first deliverable in a
larger roadmap (below). Phase 1 builds a reusable page-drawing layer that later
phases depend on (form-field appearance streams, annotation appearances,
redaction fill boxes, flattening).

## Roadmap (the larger plan this spec opens)

Four areas of currently-unimplemented PDF functionality, sequenced by
dependency. Each item later gets its own spec → plan → implementation cycle.

| Phase | Deliverable | Depends on | Rationale |
|---|---|---|---|
| **1** (this spec) | **Content authoring** — `PageGraphics` drawing API + `page.AddImage` | existing content-stream + stamping code | Foundation for nearly everything below; high reuse, low risk |
| **1b** (later) | **Richer text** — Standard-14 font family + multi-line / word-wrap (extends `stamp.ts`) | Phase 1 | Trimmed out of Phase 1 to keep the first deliverable tight |
| **2a** | **Encrypted Save** — RC4 + AESV2/AESV3 output | `crypto.ts` (exists) | Self-contained; closes the #1 README limitation |
| **2b** | **Form appearance generation** — render filled fields, drop `/NeedAppearances` | Phase 1 | Needs a drawing layer to paint values |
| **3** | **Annotations** (create/edit highlights, links, stamps, text notes) + **XMP metadata** | Phase 1 for annot appearances; XMP independent | Builds on the drawing layer |
| **4** | **Redaction & editing** — text search/replace, true content removal, flatten fields/annots | Phases 1–3 + text extraction | Most complex; security-sensitive; consumes the rest |

Phase 1 itself is scoped to two modules: **A — `PageGraphics`** and
**B — `page.AddImage`**. Richer text (formerly "Module C") is deferred to Phase
1b.

## Goals

- A fluent, buffered **`PageGraphics`** builder for vector drawing on a page.
- **`page.AddImage(data, rect, opts?)`** to embed and place JPEG and PNG rasters.
- Reuse the existing resource-registration and content-splicing machinery in
  `stamp.ts`; do not duplicate it.
- Preserve existing page content (wrap it in `q`/`Q` before appending, exactly as
  `appendContent` already does).
- Zero runtime dependencies (only `node:zlib`, already used).

## Non-goals (Phase 1)

- Richer text / additional fonts / wrapping (→ Phase 1b).
- Reading back or editing existing vector content (write-only authoring).
- Image formats other than JPEG (DCTDecode) and PNG (FlateDecode). No GIF/TIFF,
  no CCITT/JBIG2/JPX *encoding*.
- Color spaces beyond DeviceRGB / DeviceGray for drawing, and the image's own
  native space (RGB / Gray / Indexed) for `AddImage`. No CMYK, ICC, or
  Separation drawing.
- Clipping paths, patterns, shadings, transparency groups, blend modes (only
  constant alpha via `/ExtGState`, already supported).

## Module A — `PageGraphics`

### Public surface

```ts
// page.ts
Graphics(): PageGraphics
```

`page.Graphics()` returns a fresh `PageGraphics` bound to the page. The builder
**buffers** operators in memory; nothing is written to the page until `apply()`
is called. Calling `apply()` more than once, or on an empty builder, is a
harmless no-op after the first flush (the buffer is cleared on apply).

### `PageGraphics` interface

```ts
class PageGraphics {
  // ---- graphics state ----
  setLineWidth(w: number): this;
  setStrokeColor(rgb: [number, number, number]): this;   // RG
  setFillColor(rgb: [number, number, number]): this;      // rg
  setLineCap(cap: 0 | 1 | 2): this;                        // J  butt/round/square
  setLineJoin(join: 0 | 1 | 2): this;                      // j  miter/round/bevel
  setDash(pattern: number[], phase?: number): this;        // d
  setOpacity(alpha: number): this;                         // /GS gs (reuses registerExtGState)

  // ---- nesting & transform ----
  save(): this;                                            // q
  restore(): this;                                         // Q
  transform(a: number, b: number, c: number,
            d: number, e: number, f: number): this;        // cm

  // ---- path construction ----
  moveTo(x: number, y: number): this;                      // m
  lineTo(x: number, y: number): this;                      // l
  curveTo(x1: number, y1: number,
          x2: number, y2: number,
          x3: number, y3: number): this;                   // c
  rect(x: number, y: number, w: number, h: number): this;  // re
  close(): this;                                            // h

  // ---- convenience constructors (build a path; caller picks a paint op) ----
  drawLine(x1: number, y1: number, x2: number, y2: number): this; // m,l (then stroke)
  drawRect(x: number, y: number, w: number, h: number): this;     // re
  circle(cx: number, cy: number, r: number): this;                // 4-bezier
  ellipse(cx: number, cy: number, rx: number, ry: number): this;  // 4-bezier

  // ---- paint (consume the current path) ----
  stroke(): this;          // S
  fill(): this;            // f  (nonzero winding)
  fillEvenOdd(): this;     // f*
  fillStroke(): this;      // B

  // ---- commit ----
  apply(): void;           // splice buffered ops into /Contents
}
```

### Behaviour & rules

- **Validation:** numeric inputs must be finite (`TypeError` otherwise, matching
  `stamp.ts` style); colors are `[r,g,b]` each in `0..1`; `cap`/`join` are the
  small integer enums; `setOpacity` alpha in `0..1`.
- **Number formatting:** reuse the existing `num()` formatter (rounds to 1e-6,
  normalizes `-0`). Promote `num()` from `stamp.ts` into a shared
  `serialize.ts`/`content.ts` helper so both modules import it (no copy).
- **Buffering:** the builder appends text fragments to an internal `string[]`
  (or `Uint8Array[]`); `apply()` joins them, `enc()`s the result, and calls the
  shared splice helper.
- **State opcodes** are emitted inline in call order — the builder does not
  reorder or dedupe; the caller is responsible for sensible ordering (e.g. set
  color before paint). This keeps the builder a thin, predictable wrapper over
  PDF operators.
- **`setOpacity`** registers/reuses an `/ExtGState` (via the existing
  `registerExtGState`) and emits `/GSx gs`.
- **`apply()`** delegates to the shared `appendContent(doc, page, body)` helper
  extracted from `stamp.ts` (see Refactor below). If the buffer is empty,
  `apply()` does nothing.

### Refactor: extract a shared content-authoring core

`stamp.ts` currently owns `num`, `streamOf`, `freshKey`, `ensureOwnResources`,
`ensureOwnSubdict`, `registerExtGState`, `normalizeContents`, `concat`, and
`appendContent`. Phase 1 moves the **page-content-mutation** helpers
(`ensureOwnResources`, `ensureOwnSubdict`, `registerExtGState`, `appendContent`,
`streamOf`, `freshKey`, `normalizeContents`, `concat`, `num`) into a new
`pagecontent.ts` module. `stamp.ts`, `graphics.ts`, and `imageembed.ts` all
import from it. This is a focused, behaviour-preserving extraction (the existing
stamping tests must stay green), justified because three modules now share the
machinery.

## Module B — `page.AddImage`

### Public surface

```ts
// page.ts
AddImage(data: Uint8Array, rect: [number, number, number, number],
         opts?: AddImageOptions): void

interface AddImageOptions {
  /** Constant opacity 0..1 (reuses /ExtGState). Default 1. */
  opacity?: number;
  /** Override auto-detection ('jpeg' | 'png'). Default: sniff magic bytes. */
  format?: 'jpeg' | 'png';
}
```

`rect = [x, y, w, h]` places the image with its lower-left corner at `(x, y)`,
scaled to `w × h` points. The image's pixel aspect ratio is **not** preserved
automatically — `w`/`h` are exact (caller can compute a ratio from the returned
dimensions of a prior decode if desired; a helper is out of Phase 1 scope).

### Pipeline

1. **Sniff** format from magic bytes (`FF D8` → JPEG; `89 50 4E 47` → PNG)
   unless `opts.format` overrides.
2. **Build an Image XObject stream:**
   - **JPEG:** store raw bytes with `/Filter /DCTDecode`. Parse SOF0/SOF1/SOF2
     markers for `/Width`, `/Height`, `/BitsPerComponent` (8), and component
     count → `/ColorSpace` (`DeviceGray`/`DeviceRGB`; 4-component/CMYK JPEG is
     rejected with `UnsupportedFeatureError` in Phase 1).
   - **PNG:** parse IHDR (width/height/bit-depth/color-type), concatenate and
     `inflate` IDAT via `node:zlib`, reverse PNG row filters (reuse/extend the
     existing `predictor.ts` PNG-predictor logic), then re-store the raw samples
     with `/Filter /FlateDecode` (+ a PNG/`Up` predictor in `/DecodeParms`, or
     plain Flate of unfiltered samples — implementation detail, tested by
     round-trip). Color types: grayscale, RGB, palette (→ `/ColorSpace [/Indexed
     /DeviceRGB n <palette>]`), and grayscale/RGB **with alpha** (alpha channel
     split into a separate `/SMask` Image XObject, `DeviceGray`, same
     dimensions). Interlaced PNG (Adam7) is rejected with
     `UnsupportedFeatureError` in Phase 1.
3. **Register** the XObject under a fresh `/ImN` key in the page's own
   `/Resources /XObject` (reuse `ensureOwnResources` + `ensureOwnSubdict`).
4. **Paint:** append `q  w 0 0 h x y cm  /ImN Do  Q` (with optional `/GSx gs`
   for opacity) via the shared `appendContent`.

### Errors

- Unrecognized/mismatched format, truncated JPEG/PNG, unsupported subtype
  (CMYK JPEG, interlaced PNG, 16-bit-with-alpha edge cases) → throw
  `UnsupportedFeatureError` or `PdfParseError` as appropriate (reuse the public
  error types).

## Data flow

```
caller ──Graphics()──▶ PageGraphics (buffers ops in memory)
                          │ apply()
                          ▼
                   pagecontent.appendContent(doc, page, body)
                          │  (wraps existing /Contents in q/Q, allocs streams)
                          ▼
                   page.Dict['Contents']  ──Save()──▶ serialized PDF

caller ──AddImage()──▶ sniff ▶ build XObject stream ▶ register in /Resources
                          │
                          └─▶ appendContent(doc, page, "… cm /ImN Do …")
```

`Save()` already mark-sweeps from `/Root`, so newly allocated XObject/ExtGState
objects and content streams are picked up with no serializer changes.

## Testing

TDD with vitest; fixture builders in `test/helpers/` mirroring existing style.

- **PageGraphics:** for each state/path/paint method, build a page, draw, then
  `parseContentStream(page.Contents)` and assert the exact operator/operand
  sequence; assert prior content is preserved and wrapped in `q`/`Q`; assert
  `apply()` on an empty builder is a no-op; assert `setOpacity` registers one
  reusable `/ExtGState`; assert number formatting via `num()`.
- **AddImage:** craft minimal valid JPEG and PNG fixtures (grayscale, RGB,
  palette, RGBA) programmatically; assert the resulting XObject `/Width`,
  `/Height`, `/ColorSpace`, `/Filter`, `/SMask` presence, the `cm`/`Do` paint
  op, and that `doc.Pages[0].Images` (existing extractor) now finds the embedded
  image and `Decode()` round-trips the samples. Assert `UnsupportedFeatureError`
  for CMYK JPEG and interlaced PNG.
- **Refactor safety:** the existing `stamp.ts` tests must remain green after the
  `pagecontent.ts` extraction.

## Public API / docs

- `index.ts` exports `PageGraphics` and `AddImageOptions`.
- README: add "Vector drawing" and "Image insertion" subsections; update the
  Features list and API-overview table; remove image insertion from any implied
  limitation. Note the new error cases.

## Files

- New: `src/graphics.ts` (`PageGraphics`), `src/imageembed.ts` (`AddImage`
  pipeline), `src/pagecontent.ts` (shared helpers extracted from `stamp.ts`).
- Changed: `src/stamp.ts` (import shared helpers), `src/page.ts` (`Graphics()`,
  `AddImage()`), `src/predictor.ts` (export PNG row-filter reversal if needed),
  `src/index.ts`, `README.md`.
- Tests: `test/graphics.test.ts`, `test/image-embed.test.ts`, plus
  `test/helpers/build-*.ts` fixtures.

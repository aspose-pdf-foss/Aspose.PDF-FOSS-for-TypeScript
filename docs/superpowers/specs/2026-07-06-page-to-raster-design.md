# Page → raster (PNG) — `Page.ToImage()`

**Issue:** aspose-pdf-foss-for-ts-3sh.2 (parent epic 3sh — PDF rendering: page → SVG → raster)
**Date:** 2026-07-06
**Status:** Approved design
**Depends on:** 3sh.1 (Page → SVG) — shipped

## Goal

Add the second rendering pillar: a pure-TypeScript software rasterizer that
renders a page to **PNG bytes**. `page.ToImage(options?)` returns anti-aliased
raster output — vector fills/strokes, clipping, affine-sampled images, gradients,
and glyphs from embedded outlines — using node built-ins only (`zlib`, `Buffer`).

The SVG task (3sh.1) deliberately wrote SVG strings inline with **no shared
display list** and leaned on the browser for glyph shapes. This task supplies
both: a shared content-stream interpreter feeding pluggable **sinks**, and a
glyph-outline pipeline (TrueType `glyf` + CFF Type2 charstrings), since a
rasterizer has no browser to draw text for it.

## Key decisions (locked during brainstorming)

- **Architecture — shared interpreter + sink.** Extract the graphics-state
  interpreter out of `svgrender.ts` into `pagerender.ts`, driving a small
  `RenderSink` interface. The existing SVG output becomes one sink (`SvgSink`);
  the rasterizer is another (`RasterSink`). Minimal duplication; the SVG
  regression surface is small because the SVG tests assert **attributes and
  structure via regex**, not golden `d` strings.
- **Glyphs — `glyf` + CFF now; Standard-14 placeholder.** Decode embedded
  TrueType `glyf` contours and implement a CFF Type2 charstring interpreter, so
  most embedded fonts rasterize as real glyphs. Non-embedded Standard-14 fonts
  have only AFM **metrics** bundled (no outlines), and the zero-dep rule
  discourages shipping font files, so they render as a **low-coverage / outlined
  placeholder box** per glyph (layout-preserving, not a solid redaction bar).
  Bundling Base-14 outlines is a deferred follow-up.
- **Output — opaque white by default.** RGB PNG composited on white by default
  (matches how PDF pages present); `{ background: 'transparent' }` emits an RGBA
  PNG with unpainted area transparent.
- **Anti-aliasing — analytic coverage.** A signed-area coverage-accumulation
  scanline rasterizer (AGG/stb-style), deterministic and single-pass; no
  supersampled framebuffer. Supports nonzero and even-odd winding.
- **Zero runtime deps:** node built-ins only. Reuses `pngencode.ts` unchanged.

## Module layout

New / changed files under `src/`:

- **`pagerender.ts`** (new) — the shared graphics-state interpreter, moved out of
  `svgrender.ts`. Owns the `q`/`Q` stack, CTM, color state, line style, the text
  machine (`BT…ET`, `Tf/Td/TD/Tm/T*/Tc/Tw/Tz/TL/Ts`, `Tj/TJ/'/"`), path
  construction as **structured subpaths**, image/`Do` dispatch, Form-XObject
  recursion (`/Matrix`∘CTM, `/BBox` clip, depth/cycle guards), and shading
  dispatch. Emits to a `RenderSink`. Colorspace/function/font resolution helpers
  move here (shared by both sinks).
- **`svgrender.ts`** (changed) — keeps `renderPageToSvg` and `baseMatrix`; the
  inline emission becomes an `SvgSink implements RenderSink` that serializes
  subpaths → `d`, opens/closes `<g clip-path>` groups on save/restore/addClip,
  builds `<defs>` gradients, and emits `<text>`/`<image>` exactly as today.
- **`raster.ts`** (new) — `renderPageToPng(doc, page, opts): Uint8Array`, the
  `RasterSink`, the canvas, the coverage rasterizer, the stroker, the clip-mask
  stack, and affine image sampling.
- **`cff.ts`** (new) — a CFF parser + Type2 charstring interpreter producing glyph
  outlines (used by the glyph rasterizer for CFF/OpenType-CFF fonts).
- **`sfnt.ts`** (changed) — add a `glyf` **contour decoder** (simple + composite
  glyphs → quadratic-Bézier outline in font units) alongside the existing raw
  `glyphData(gid)`.
- **`page.ts`** (changed) — add `ToImage(options?: ImageOptions): Uint8Array`.
- **`node.ts`** (changed) — add `savePageImageFile(inputPath, pageIndex, outPath,
  options?)`, matching the existing `*File` wrappers.
- **`index.ts`** (changed) — export `ImageOptions`.
- **`pngencode.ts`** (unchanged) — reused (RGB color type 2, RGBA color type 6).

## The `RenderSink` interface

The interpreter drives the sink through the graphics-state **lifecycle**, so clip
nesting is handled identically to the current SVG code (`groupStack` / pending
clip). Geometry is passed in **user space plus the CTM** — the SVG sink needs
this to emit `transform="matrix(…)"`; the raster sink flattens/transforms to
device space itself.

```ts
interface Subpath { segs: Seg[]; closed: boolean; }   // Seg: M|L|C with points
interface StrokeStyle { width: number; cap: number; join: number; miter: number; dash: number[]; }

interface RenderSink {
  save(): void;                                             // q
  restore(): void;                                          // Q
  addClip(path: Subpath[], ctm: Matrix, evenOdd: boolean): void;   // W/W* at next paint
  fill(path: Subpath[], ctm: Matrix, color: Rgb, evenOdd: boolean): void;
  stroke(path: Subpath[], ctm: Matrix, color: Rgb, style: StrokeStyle): void;
  image(stream: PdfStream, ctm: Matrix, fillColor: Rgb): void;
  glyphRun(run: GlyphRun, textMatrix: Matrix, ctm: Matrix, fontSize: number, color: Rgb): void;
  shading(dict: PdfDict, ctm: Matrix): void;
}
```

`SvgSink` reproduces the shipped output. `RasterSink` composites onto the canvas.
`renderPageToSvg` and `renderPageToPng` are thin wrappers: build the base matrix,
construct the sink, call `interpret(doc, page, base, sink)`, return the sink's
result. `interpret` **never throws** (degrades like `ToSvg`).

## Rasterizer core (`raster.ts`)

- **Canvas:** an RGBA buffer at device resolution. Device matrix = the reused
  `baseMatrix(page, box)` post-scaled by the effective scale (from `scale`, or
  derived from `width`/`height`). Background pre-filled white (or left
  transparent).
- **AA fill:** a signed-area coverage-accumulation scanline rasterizer. Flatten
  Bézier subpaths to device-space polylines (tolerance in device pixels), feed
  edges into per-scanline coverage/area cells, sweep to 0..1 coverage. Winding
  rule selects nonzero vs even-odd. Single pass; fully deterministic.
- **Compositing:** source-over with `alpha = coverage × clipMask` and opaque
  source color (matches SVG's no-constant-alpha model). Writes into RGBA; final
  flatten to RGB-on-white unless `background:'transparent'`.

## Stroking

Stroke geometry is generated in **user space** (using the user-space line width),
then the resulting outline is transformed by the CTM and filled with nonzero
winding — this scales strokes correctly under anisotropic and skewed CTMs.

- Flatten curves to polylines; offset each segment by ±width/2 into quads.
- **Caps:** butt (0) / round (1) / square (2) at open ends.
- **Joins:** miter (0, clamped by miter limit) / round (1) / bevel (2).
- **Dashes:** split the flattened path by the dash array before offsetting.

## Clipping

A **clip-mask stack** of 0..1 coverage buffers. `addClip` rasterizes the clip
path's coverage and multiplies it into the current clip mask. `save`/`restore`
push/pop the mask alongside graphics state. Every fill/stroke/image multiplies
its own coverage by the active clip mask before compositing. Masks are lazily
allocated (only once a clip is active) and bbox-tracked to bound memory. Nested
clips compose by multiplication, matching the nested `<g clip-path>` groups on
the SVG side.

## Images (affine sampling)

Decode via the existing `ImageInfo.Decode()` + colorspace conversion (the same
path `svgrender` uses to re-encode PNGs), yielding RGBA (or RGB) samples:

- `/ImageMask` → 1-bit stencil painted in the current fill color (transparent
  where masked out).
- `/SMask` → composited as per-pixel alpha.
- Base colorspaces (Device*, CalGray/RGB, Lab, ICCBased alternate, Indexed,
  Separation/DeviceN) via `colorspace.ts`.

Then map the unit square under the CTM (with the image's local Y-flip) to device
space, compute the transformed bounding box, and for each device pixel
**inverse-map** to image UV and **bilinear-sample**, compositing under the clip.
Undecodable images (JBIG2/JPX/CCITT edge cases) → a light-gray placeholder rect,
mirroring the SVG degrade path.

## Glyph rasterizer

`glyphRun` resolves each code → gid → outline, scales by
`fontSize / unitsPerEm`, places by `textMatrix × ctm` (with the text Y
convention), flattens, and fills nonzero in the current fill color. Text render
mode 3 (invisible) and clip-only modes are skipped/approximated as in the SVG
task.

- **Embedded TrueType (`glyf`):** new `sfnt.ts` contour decoder — simple glyphs
  (on/off quadratic points, implied on-curve midpoints, multiple contours) and
  **composite** glyphs (component gid + 2×2/offset transform, recursively).
- **Embedded CFF / OpenType-CFF:** new `cff.ts` — parse Header/Name/Top-DICT/
  String/Global-Subr INDEXes, CharStrings INDEX, charset (gid→SID/CID), Private
  DICT + local subrs; interpret Type2 charstrings (`rmoveto/hmoveto/vmoveto`,
  `rlineto/hlineto/vlineto`, `rrcurveto/hvcurveto/vhcurveto/…`, `hstem/vstem/
  hstemhm/vstemhm/hintmask/cntrmask`, `callsubr/callgsubr/return/endchar`,
  subr bias) → cubic-Bézier outline. CID-keyed CFF resolves FDSelect/FDArray for
  per-glyph Private DICT/subrs.
- **Non-embedded Standard-14 (and any font without usable outlines):** a
  **low-coverage / outlined placeholder box** per glyph, sized to the glyph
  advance × cap-height in the fill color — layout-preserving, visually distinct
  from real text and from solid redaction bars.

Glyph id resolution reuses `TextFont` (simple-font encodings, `/Differences`,
Type0/Identity-H, CIDToGIDMap) already used by text extraction and the SVG task.

## Output & API

```ts
interface ImageOptions {
  scale?: number;                     // multiplier on 72-DPI point size; default 1
  width?: number;                     // target px width  (overrides scale)
  height?: number;                    // target px height (overrides scale)
  box?: 'crop' | 'media';             // default 'crop'
  background?: 'white' | 'transparent'; // default 'white'
}

class Page { ToImage(options?: ImageOptions): Uint8Array /* PNG bytes */ }
```

- Default `scale: 1` → 72 DPI. `scale: 2` → 144 DPI. If only `width` or only
  `height` is given, the other is derived aspect-preserving; if both, the page is
  fit into the box (may change aspect). `box`/`Rotate`/`CropBox` handled by the
  reused `baseMatrix`.
- `background:'white'` → opaque RGB PNG; `'transparent'` → RGBA PNG.
- `node.ts`: `savePageImageFile(inputPath, pageIndex, outPath, options?)`.
- Export `ImageOptions` from `index.ts`.

## Error handling

`ToImage()` never throws on unsupported content — it degrades, mirroring `ToSvg`:

- Unknown/unparseable colorspace → gray.
- Unsupported shading type / tiling pattern → solid fallback.
- Undecodable image → light-gray placeholder rect.
- Font without usable outlines → placeholder glyph boxes.
- Malformed geometry → MediaBox, then US-Letter (via the shared box logic).

The method always returns valid PNG bytes.

## Testing

vitest, with fixtures built programmatically by `test/helpers/` builders
(reusing the SVG fixtures where possible). Assertions decode the returned PNG and
check **specific pixels** (color + approximate coverage at known coordinates),
plus structural round-trips — deterministic references, not perceptual diffs:

1. **Solid fill** — a filled rect; assert interior pixels are the fill color and
   exterior is background, with anti-aliased edge coverage between.
2. **Even-odd fill** — a rect-with-hole; assert the hole shows background.
3. **Stroke** — a stroked line/rect with width, cap, join; assert stroked pixels
   and clean interior.
4. **Clipping** — content clipped to a rect; assert pixels outside the clip are
   background.
5. **Image** — a small Flate image scaled up; assert sampled pixel colors at
   mapped coordinates.
6. **ImageMask** — a stencil painted in a fill color; assert painted vs
   transparent/background pixels.
7. **glyf text** — an embedded TrueType font; assert glyph ink appears where
   expected and whitespace stays background.
8. **CFF text** — an embedded CFF/OTF font; same shape of assertion.
9. **Standard-14 fallback** — assert placeholder boxes render (low coverage, not
   solid) at glyph positions.
10. **Options** — `scale`/`width`/`height` produce the expected PNG dimensions;
    `transparent` yields an RGBA PNG with transparent unpainted area.

`npm run typecheck` and `npm test` must be green before closing each sub-issue.

## Decomposition (beads sub-issues under 3sh.2)

Ordered phases, each landing with its own tests:

1. **3sh.2.1 — Interpreter/sink refactor.** Extract `pagerender.ts` + `SvgSink`;
   SVG tests stay green (no behavior change).
2. **3sh.2.2 — Raster core + API.** Canvas, AA coverage fill, PNG output,
   `Page.ToImage({scale/width/height, box, background})`, `node.ts` wrapper,
   `index.ts` export.
3. **3sh.2.3 — Stroking + dashes.**
4. **3sh.2.4 — Clipping** (clip-mask stack).
5. **3sh.2.5 — Image affine sampling** (incl. `/ImageMask`, `/SMask`).
6. **3sh.2.6 — glyf glyph rasterizer** (`sfnt.ts` contour decoder + fill;
   Standard-14 placeholder fallback).
7. **3sh.2.7 — CFF Type2 charstring interpreter** (`cff.ts`).

## Out of scope (follow-ups)

- **Bundled Base-14 glyph outlines** (real non-embedded text) — separate issue.
- Type1 (PFB) charstring outlines, Type3 glyph procedures.
- Blend modes, soft-mask groups, transparency groups, constant alpha (`CA`/`ca`),
  knockout/isolation — opaque approximations only.
- Tiling-pattern fidelity — solid fallback (as in the SVG task).
- Shading types other than axial/radial — solid fallback.

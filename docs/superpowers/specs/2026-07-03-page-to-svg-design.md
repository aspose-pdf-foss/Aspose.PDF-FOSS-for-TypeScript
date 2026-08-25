# Page → SVG conversion (`Page.ToSvg()`)

**Issue:** aspose-pdf-foss-for-ts-3sh.1 (parent epic 3sh — PDF rendering: page → SVG → raster)
**Date:** 2026-07-03
**Status:** Approved design

## Goal

Add the first rendering pillar: a content-stream interpreter that walks a page's
graphics-state machine and emits a **standalone `<svg>` string**. No rasterizer.
Unlocks browser preview, thumbnails, and visual regression, and is the direct
precursor to the PNG rasterizer (issue 3sh.2).

`page.ToSvg(options?)` returns a self-contained SVG document string for
representative fixtures (vector, Standard-14 text, embedded-font text, JPEG/PNG
images, clipping), honoring `/Rotate` and `CropBox`.

## Key decisions (locked during brainstorming)

- **Text rendering:** native positioned `<text>` now (selectable, small output,
  generic font-family mapping). Glyph-outline mode (`glyf`/CFF → `<path>`) is a
  **follow-up issue**, not this one. The acceptance criterion is "text as
  `<text>` OR embedded glyph outlines" — `<text>` satisfies it.
- **Paint model:** full, including gradients. Device (Gray/RGB/CMYK), CalGray/
  CalRGB, Lab, ICCBased (via N-component alternate), Indexed, Separation/DeviceN
  (via tint-transform sampling); axial (type 2) and radial (type 3) shadings as
  SVG gradients. Other shading types and tiling patterns → solid fallback.
- **Architecture:** **direct-to-SVG** — the interpreter writes SVG elements
  directly; no shared display-list IR yet. The display list is extracted later
  when 3sh.2 (PNG) lands, informed by what the rasterizer actually needs.
- **Zero runtime deps:** node built-ins only (`zlib` `deflateSync` for PNG,
  `Buffer` for base64). Consistent with the project's zero-dep rule.

## Module layout

New files under `src/`:

- **`svgrender.ts`** — the graphics-state interpreter + SVG builder. Owns:
  - the graphics-state stack (CTM, fill/stroke color, line width, dash, cap,
    join, miter limit, clip, text state) with a `q`/`Q` save/restore stack;
  - path construction (`m/l/c/v/y/re/h`) → SVG path `d` with real cubic Béziers;
  - paint ops (`f/F/f*/S/s/B/b/B*/b*/n`) with fill-rule selection;
  - the text-state machine (`BT…ET`, `Tf/Td/TD/Tm/T*/Tc/Tw/Tz/TL/Ts/Tr`,
    `Tj/TJ/'/"`) → positioned `<text>`;
  - image placement (`Do` image XObject, inline `BI/ID/EI`) → `<image>` with a
    data URI;
  - Form-XObject recursion (`Do` form) with `/Matrix`∘CTM and `/BBox` clip,
    depth- and cycle-guarded (mirrors the `walkScope` pattern in `text.ts`);
  - a `<defs>` collector for `<clipPath>`, `<linearGradient>`, `<radialGradient>`.
  - Reuses matrix helpers (`mul`/`apply`/`translate`/`vscale`) and `Matrix` from
    `text.ts`, `TextFont` from `font.ts`. Does **not** reuse `visitContent`,
    which flattens curves and drops color/clip/dash.
- **`colorspace.ts`** — parse a `/ColorSpace` operand into a
  `(components: number[]) => [r, g, b]` converter (0..1 components → 0..255 RGB).
  Handles Device*, CalGray/CalRGB, Lab, ICCBased (fall back to `/N`-component
  alternate or `/Alternate`), Indexed (lookup table), Separation/DeviceN
  (evaluate `/Function` tint transform over the alternate space). Naive CMYK→RGB
  (`r = 255*(1-c)*(1-k)` etc.). Unknown → gray.
- **`pngencode.ts`** — minimal PNG encoder: signature + IHDR + zlib IDAT
  (`deflateSync` with a per-row filter byte 0) + IEND. Supports grayscale, RGB,
  and RGBA (color types 0/2/6), 8-bit. Shared and reusable by the future
  rasterizer.
- **`page.ts`** — add `ToSvg(options?: SvgOptions): string` delegating to
  `svgrender.ts`. Export `SvgOptions` from `index.ts`.

`SvgOptions` starts minimal (reserved for future `text: 'outline'`); v1 may ship
it empty or with a `box?: 'crop' | 'media'` selector (default `crop`).

## Coordinate system, CropBox, Rotate

- **viewBox / size:** `W`/`H` = CropBox width/height, **swapped** for `/Rotate`
  90 or 270. `<svg width="W" height="H" viewBox="0 0 W H"
  xmlns="http://www.w3.org/2000/svg">`.
- **Base matrix** maps PDF user space → SVG viewport: translate by the negated
  CropBox origin, flip Y (`[1, 0, 0, -1, 0, H]`), pre-composed with the `/Rotate`
  rotation (0/90/180/270). All interpreter output sits under this base CTM.
- **Paths** carry coordinates in their *local* user space, wrapped in
  `<path transform="matrix(a b c d e f)">` reflecting the full current CTM. This
  makes stroke width / dash / caps / joins scale exactly as PDF requires,
  including under skew, instead of baking device-space points.
- **Text** applies the text-rendering matrix as a per-`<text>` `transform`, with
  an extra local Y-flip so glyphs render upright rather than mirrored by the base
  flip.

## Content interpretation detail

- **Paths:** `m` moveto, `l` lineto, `c/v/y` cubic Béziers (kept as curves),
  `re` rectangle, `h` closepath. Paint: `f/F`→`fill-rule:nonzero`;
  `f*`→`evenodd`; `S/s`→stroke; `B/B*/b/b*`→fill+stroke; `n`→no paint (clip
  application only).
- **Color:** `g/rg/k` set nonstroking; `G/RG/K` stroking; `cs/CS` select a
  colorspace; `sc/scn`/`SC/SCN` set components (or a pattern name). `scn`/`SCN`
  naming a **shading pattern** → gradient fill; **tiling pattern** → nearest
  solid or mid-gray fallback.
- **Shadings:** `sh` and shading patterns → axial (type 2) `<linearGradient>` /
  radial (type 3) `<radialGradient>` in `<defs>`, with stops sampled from the
  shading `/Function` (evaluate at N sample points across the domain). Other
  shading types → solid fallback (average or mid-gray).
- **Clipping:** `W`/`W*` mark the *current path* as a pending clip; on the next
  paint op the path is registered as a `<clipPath>` (with the right clip-rule)
  and a `<g clip-path="url(#id)">` group is opened. Clip is graphics state, so
  the `q`/`Q` stack opens/closes these groups; nested clips nest groups.
- **Line style:** `w`→`stroke-width`, `d`→`stroke-dasharray`+`stroke-dashoffset`,
  `J`→`stroke-linecap` (0 butt/1 round/2 square), `j`→`stroke-linejoin`
  (0 miter/1 round/2 bevel), `M`→`stroke-miterlimit`.
- **Text:** full text-state machine. Each `Tj/TJ/'/"` emits a `<text>` at the run
  origin with `font-size` from the effective size, `font-family` mapped to a
  generic family (serif/sans-serif/monospace) with bold/italic inferred from the
  font descriptor flags or `/BaseFont` name, `fill` = current nonstroking color.
  Decoded Unicode via `TextFont.decode`. `Tr` mode 3 (invisible) → skip the
  `<text>`; modes 4–7 (clip) → render fill portion, ignore the clip in v1.
- **Images:** `Do` image XObject and inline images → `<image x=0 y=0 width=1
  height=1 preserveAspectRatio="none" transform="matrix(CTM)" href="data:...">`
  (the unit square under the CTM). DCTDecode → `data:image/jpeg;base64,<raw>`.
  Other filters → `ImageInfo.Decode()` samples → `pngencode` →
  `data:image/png;base64`. `/ImageMask` → 1-bit stencil painted in the current
  fill color, encoded as an RGBA PNG (transparent where masked out). `/SMask`,
  when present, is composited into an RGBA PNG.
- **Form XObjects:** recurse with child CTM = `/Matrix`∘CTM, clipped to `/BBox`,
  own `/Resources` (falling back to the parent's), depth-guarded
  (`MAX_XOBJECT_DEPTH`) and cycle-guarded by visited dicts.

## Error handling

`ToSvg()` never throws on unsupported content — it degrades:

- Unknown / unparseable colorspace → gray.
- Unsupported shading type or tiling pattern → solid fallback.
- Undecodable image (JBIG2Decode, JPXDecode, or a CCITT edge case) → a
  light-gray placeholder `<rect>` at the image's box so layout is preserved.
- Malformed geometry → MediaBox, then US-Letter, mirroring `Page.box()`.

The method always returns a valid, standalone `<svg>` string.

## Testing

vitest, with fixtures built programmatically by new `test/helpers/` builders
(mirroring the existing builder/test style). One fixture per acceptance case:

1. **Vector** — paths with fill nonzero, fill even-odd, stroke, and a dash
   pattern; assert `<path>` `d`, `fill-rule`, `stroke-dasharray`.
2. **Standard-14 text** — assert `<text>` with expected content, position
   (`transform`/`x`/`y`), `font-size`, generic `font-family`.
3. **Embedded-font text** — a page with an embedded simple/Type0 font; assert
   decoded text renders as `<text>`.
4. **JPEG image** — assert `<image href="data:image/jpeg;base64,...">`.
5. **Flate ("PNG") image** — a Flate-encoded image XObject; assert
   `<image href="data:image/png;base64,...">` and that the PNG bytes decode.
6. **Clipping** — a `W n` clip around content; assert a `<clipPath>` in `<defs>`
   and a `clip-path="url(#...)"` group.
7. **Rotate + CropBox** — a `/Rotate 90` page with a non-zero-origin CropBox;
   assert swapped `width`/`height`, the `viewBox`, and the base transform.
8. **Shading** — an axial shading fill; assert a `<linearGradient>` in `<defs>`.

Assertions parse the returned SVG string and check for expected
elements/attributes (not pixel comparison). Round-trip where practical (decode
an emitted PNG data URI back to samples).

`npm run typecheck` and `npm test` must be green before closing the issue.

## Documentation

Update `README.md`: move rendering out of "Limitations" (currently notes "no
rendering" throughout) and add `Page.ToSvg()` to Features / API overview, noting
that text is emitted as positioned `<text>` (glyph-outline mode is future work)
and listing the paint-model coverage and fallbacks.

## Out of scope (follow-ups)

- Glyph-outline text mode (`glyf`/CFF → `<path>`) — separate issue.
- Software rasterizer to PNG (issue 3sh.2) — will extract a shared display list.
- Tiling-pattern fidelity, blend modes, soft-mask groups, transparency groups,
  knockout/isolation — solid/opacity approximations only in v1.

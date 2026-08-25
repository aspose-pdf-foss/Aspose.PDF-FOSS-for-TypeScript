# Vector/Path Content Extraction — `page.GetPaths()`

**Issue:** aspose-pdf-foss-for-ts-8i9
**Date:** 2026-07-17
**Status:** Approved design

## Goal

Extract a page's painted vector graphics (path-construction + paint ops) as a
positioned path/shape model, mirroring the text (`GetTextFragments`) and image
extractors. Each returned path carries its subpaths, the paint applied (fill and
stroke color + colorspace family), the fill rule, stroke line width, clip usage,
and the CTM in effect at paint time. This enables analysis, format conversion,
and geometry-based redaction of vector art (a current redaction gap).

## Acceptance Criteria (from the issue)

- `page.GetPaths()` returns positioned path objects with device-space geometry,
  paint color, and stroke/fill kind.
- Covers nested Form XObjects.
- Matches shapes drawn by a fixture.
- Documented model in the README.

## Public API

New method on `Page`:

```ts
GetPaths(): PagePath[]
```

New module `src/paths.ts` exports the model types and `extractPaths(doc, page)`;
`Page.GetPaths()` delegates to it. Types are re-exported from `src/index.ts`.

### Model

```ts
/** A painted vector path: one entry per paint operation. */
export interface PagePath {
  /** Subpaths in the *local user space* of the content stream that drew them
   *  (page space for page content; the XObject's own space inside a Form). */
  subpaths: PathSubpath[];
  /** Affine [a,b,c,d,e,f] mapping that user space to device (page) space at
   *  paint time — the composed CTM including any Form XObject /Matrix. */
  ctm: Matrix;
  /** Device-space aligned bounding box [x0,y0,x1,y1] of the whole path,
   *  including bezier control points (conservative — never smaller than the
   *  visible geometry). Empty paths get a zero-area box at their origin. */
  bbox: [number, number, number, number];
  /** Fill paint, or null when the path was not filled. */
  fill: PathPaint | null;
  /** Stroke paint, or null when the path was not stroked. */
  stroke: PathPaint | null;
  /** Winding rule of the fill, or null when not filled. */
  fillRule: 'nonzero' | 'evenodd' | null;
  /** Stroke width in device units; 0 when not stroked. */
  lineWidth: number;
  /** When the path was also used as a clip (W / W*), its clip winding rule. */
  clip: 'nonzero' | 'evenodd' | null;
  /** Innermost active marked-content MCID at paint time, if any. */
  mcid?: number;
  /** True when painted inside an /Artifact marked-content scope. */
  artifact?: boolean;
  /** Provenance: content-stream address (reuses the text/image extractor type). */
  addr: ContentAddr;
}

export interface PathSubpath {
  /** True when the subpath was explicitly closed (h, or a re rectangle). */
  closed: boolean;
  segments: PathSegment[];
}

export type PathSegment =
  | { op: 'move'; pt: [number, number] }
  | { op: 'line'; pt: [number, number] }
  | { op: 'cubic'; c1: [number, number]; c2: [number, number]; pt: [number, number] };

export interface PathPaint {
  /** Resolved sRGB, 0–255 per channel (the library's `Rgb` convention). */
  rgb: Rgb;
  /** Colorspace family label: 'DeviceGray' | 'DeviceRGB' | 'DeviceCMYK' |
   *  'CalGray' | 'CalRGB' | 'Lab' | 'ICCBased' | 'Indexed' | 'Separation' |
   *  'DeviceN' | 'Pattern' | 'Unknown'. */
  space: string;
}
```

`Matrix`, `ContentAddr`, and `Rgb` are the existing types imported from
`text.ts` / `editcontent.ts` / `colorspace.ts`.

## Geometry Normalization

Path-construction ops are recorded in the current stream's user space (points are
**not** pre-multiplied by the CTM; the CTM is reported separately so consumers
can transform as needed and reconstruct the exact device geometry):

- `m x y` → `{ op:'move', pt }`, starts a new subpath.
- `l x y` → `{ op:'line', pt }`.
- `c x1 y1 x2 y2 x3 y3` → `{ op:'cubic', c1:[x1,y1], c2:[x2,y2], pt:[x3,y3] }`.
- `v x2 y2 x3 y3` → cubic with `c1` = current point (per PDF 32000 §8.5.2.1).
- `y x1 y1 x3 y3` → cubic with `c2` = endpoint `pt`.
- `re x y w h` → a **closed** subpath: move(x,y), line(x+w,y), line(x+w,y+h),
  line(x,y+h), close.
- `h` → sets the current subpath `closed = true`.

A degenerate op with the wrong operand count is skipped (never throws).

## Paint & Emission

State machine over the content stream (per graphics-state scope, `q`/`Q` saved &
restored — CTM, color, line width, clip-pending):

- **Color ops tracked:** `g`/`G` (gray), `rg`/`RG` (rgb), `k`/`K` (cmyk),
  `cs`/`CS` (set colorspace by name → resolve via `/Resources /ColorSpace`),
  `sc`/`scn`/`SC`/`SCN` (set color in the current space). Fill ops are lowercase,
  stroke uppercase; each maintains its own current colorspace + components.
- **Resolution:** the current fill/stroke components are converted to `Rgb`
  through `resolveColorSpace(...).toRgb(...)` from `colorspace.ts` (handles
  Device*, CalGray/RGB, Lab, ICCBased, Indexed, Separation, DeviceN). The
  `space` label is derived independently from the colorspace operand's family.
- **Pattern paint** (`scn`/`SCN` with a name operand): `space:'Pattern'`; `rgb`
  from any numeric components present (uncolored pattern) via the underlying
  space, else `[0,0,0]`. Shadings/gradients are not evaluated (scope cut).
- **Clip:** `W` / `W*` set a pending clip winding; it attaches to the next
  painting/`n` op, then clears.

**Emission — one `PagePath` per paint operator**, capturing a snapshot of the
current path + state:

| Operator            | fill | stroke | fillRule        |
|---------------------|------|--------|-----------------|
| `S`, `s`            | –    | ✓      | –               |
| `f`, `F`            | ✓    | –      | nonzero         |
| `f*`                | ✓    | –      | evenodd         |
| `B`, `b`            | ✓    | ✓      | nonzero         |
| `B*`, `b*`          | ✓    | ✓      | evenodd         |
| `n`                 | –    | –      | –               |

`s`/`b`/`b*` also close the current subpath before painting. A path is emitted
for `n` **only** when a clip is pending (clip-only path); a bare `n` with no clip
and no other paint emits nothing. After any of these ops the path is reset.

`lineWidth` is the current `w` value scaled by the device magnitude of the CTM
(`w * vscale(ctm)`), reported only when stroked (else 0). `mcid`/`artifact` come
from the active marked-content scope (`BDC`/`BMC`/`EMC`), same rules as the text
extractor.

## Form XObjects, Nesting, Guards

`Do` on a Form XObject recurses into the referenced stream with the child CTM =
`Matrix × parentCTM`, its own `/Resources` (falling back to the parent's), and a
fresh path/color state, threading `addr.path` with the XObject name — identical
to the recursion in `imageusage.ts` / `text.ts`. Depth is capped at
`MAX_XOBJECT_DEPTH` (8) and a `seen` set breaks reference cycles. `Do` on an
image XObject and inline images (`BI`) produce no paths.

## Architecture & Isolation

- `src/paths.ts` is self-contained: it owns the content walk (CTM/XObject/mcid
  threading + path construction + color tracking). This deliberately does **not**
  extend the shared `visitContent` walker in `text.ts`, following the precedent
  of `imageusage.ts` (a focused walker with its own CTM threading). Rationale:
  keeps `text.ts` and its `PathEvent`/`table.ts` consumers untouched (zero
  regression risk) and keeps colorspace resolution out of the text path.
- Reused helpers: `Matrix`, `IDENTITY`, `mul`, `apply`, `vscale`,
  `contentStreamBytes` (from `text.ts`); `parseContentStream` (from
  `content.ts`); `resolveColorSpace`, `Rgb` (from `colorspace.ts`);
  `inflateStream` (from `flate.ts`); `ContentAddr` (from `editcontent.ts`).
- `Page.GetPaths()` is a one-line delegate to `extractPaths(this.doc, this)`.

## Error Handling

Never throws on malformed content: a stream that fails to parse or decode
contributes no paths (consistent with the other extractors). Wrong-arity ops are
skipped. Unknown colorspaces resolve to gray with `space:'Unknown'`.

## Testing

Fixture builder `test/helpers/build-paths-pdf.ts` produces a single-page PDF with
known, distinct shapes; `test/paths.test.ts` asserts the extracted model:

1. **Filled RGB rectangle** (`re` + `rg` + `f`): one path, `fill.rgb` = the RGB,
   `fill.space === 'DeviceRGB'`, `fillRule === 'nonzero'`, `stroke === null`,
   subpath closed, device bbox matches the rectangle.
2. **Stroked CMYK line** (`m`/`l` + `K` + `w` + `S`): `stroke.space ===
   'DeviceCMYK'`, `stroke.rgb` = cmyk→rgb, `fill === null`, `lineWidth` scaled.
3. **Bezier curve** (`c`): a `cubic` segment with the expected control points.
4. **`v`/`y` normalization**: control points reconstructed to full cubics.
5. **Clipped path** (`re` + `W n`): `clip === 'nonzero'`, no fill/stroke.
6. **Shape inside a Form XObject** drawn via `cm` scale + `Do`: `ctm` reflects
   the composed matrix, device bbox lands at the scaled/translated position,
   `addr.path` names the XObject.
7. **Fill+stroke** (`B`): both `fill` and `stroke` populated.
8. Round-trips through `Document.Open(doc.Save())` and re-extracts identically.

Run `npm run typecheck` and `npm test` green before closing.

## Documentation

Add a "Vector path extraction" subsection to the README Features / API overview
covering `page.GetPaths()` and the `PagePath` model (user-space subpaths + CTM,
device bbox, resolved fill/stroke color + space, fill rule, line width, clip,
mcid/artifact), and note the scope cuts (no shading evaluation, dash, caps/joins).

## Scope Cuts (YAGNI)

- No shading/gradient color evaluation (patterns reported as `space:'Pattern'`).
- No dash array, line cap, or line join.
- No path-to-path boolean/clip-intersection geometry — `clip` is a flag only.
- Curves are preserved (not flattened); the device `bbox` uses control points.

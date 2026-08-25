# Partial image redaction (clip + re-encode) — design

**Issue:** aspose-pdf-foss-for-ts-gq8
**Date:** 2026-07-07
**Status:** approved (brainstorming)

## Goal

Extend redaction to images that a redaction region covers only *partially*.
Today a partially-covered image throws `UnsupportedFeatureError`; instead,
decode the image, destroy only the covered pixels, and re-encode it — so the
covered area's data is gone while the rest of the image survives.

Acceptance (from the issue): redacting over a region covering part of an image
removes only the covered pixels (re-encoded), leaving the rest; vitest; README
redaction note updated.

## Scope (locked decisions)

- **Undecodable codecs** (JPEG/`DCTDecode`, `JPXDecode`, `JBIG2Decode`): partial
  coverage continues to throw `UnsupportedFeatureError` (no pixel decode
  available; full-image removal would destroy the uncovered part, which the
  acceptance forbids). JPEG partial redaction is a follow-up once a decoder
  exists.
- **Placement**: axis-aligned placements (scale / flip / translate — CTM with
  `b == 0 && c == 0`) are redacted precisely. Rotated / skewed placement throws
  `UnsupportedFeatureError`.
- **Inline images** (`BI…EI`): partial coverage throws; partial redaction is
  image-XObject-only in this landing. Full-coverage inline-image removal is
  unchanged.
- **Fully-covered images** are dropped wholesale, exactly as today.

## Approach

For each image *draw op* (`Do`) whose placement box is partially covered by one
or more redaction rects:

1. **Decode** the image XObject to straight-alpha RGBA via the rasterizer's
   `decodeImageRgba`. When it returns `undefined` (JPEG/JPX/JBIG2), throw
   `UnsupportedFeatureError`.
2. **Map** each covering device rect through the inverse image CTM to a pixel
   box and **blank** those pixels (RGB → 0, alpha → 255: opaque black). Multiple
   rects over one placement union their boxes.
3. **Re-encode** the RGBA raster as a fresh DeviceRGB, 8-bit, `FlateDecode`
   image XObject. When any source pixel had alpha < 255, also emit a DeviceGray
   `/SMask` (8-bit `FlateDecode`) carrying the alpha channel.
4. **Copy-on-write**: register the re-encoded image as a *new* indirect object
   under a fresh `/XObject` resource name in the draw op's content scope, and
   rewrite the `Do` operand to that name. The original XObject is untouched, so
   other placements / shared uses are unaffected; if it becomes unreferenced,
   `Save`'s mark-sweep drops it.

Re-encoding through RGBA normalizes colorspace to DeviceRGB, so uncovered pixels
of a CMYK/Indexed source are converted (a documented fidelity note). This reuses
the rasterizer's proven, colorspace-and-bit-depth-agnostic decoder rather than
adding per-colorspace sample-blanking code.

## Geometry (axis-aligned mapping)

Image space is the unit square `[0,1] × [0,1]` with sample **row 0 at the top**
(`v = 1`). Given a device rect `R = [x0,y0,x1,y1]` and the image placement matrix
`M` (the CTM active at the `Do`, with `b == c == 0`):

```
Minv          = invert(M)                       // 2×3 affine inverse
(u0,v0)       = apply(Minv, x0, y0)             // map both corners
(u1,v1)       = apply(Minv, x1, y1)
uLo,uHi       = sort(clamp01(u0), clamp01(u1))
vLo,vHi       = sort(clamp01(v0), clamp01(v1))
pxLo          = floor(uLo * W); pxHi = ceil(uHi * W)
pyLo          = floor((1 - vHi) * H); pyHi = ceil((1 - vLo) * H)   // v flips
```

`invert([a,b,c,d,e,f])` for a 2×3 affine (`det = a*d - b*c`, throw on
`det == 0`):

```
[  d/det, -b/det, -c/det,  a/det,
   (c*f - d*e)/det, (b*e - a*f)/det ]
```

Rotation/skew detection: `b !== 0 || c !== 0` on `M` → throw. Detection uses a
small epsilon (`1e-6`) to tolerate floating-point noise from CTM composition.

## Module changes

Files that change together, grouped by responsibility.

### `text.ts`

- Add `ctm: Matrix` to `ImageEvent` (the placement matrix, already in scope in
  `emitImage` at the `image` visitor call). Consumers that ignore it are
  unaffected.
- Add and export `invert(m: Matrix): Matrix` next to `mul` / `apply`.

### `raster.ts`

- Export the existing private `decodeImageRgba(doc, stream, fill): { w; h; data }
  | undefined` and the `ImageRgba` result interface, unchanged. This is the
  shared decoder (Flate/LZW/CCITT + DeviceGray/RGB/CMYK/Indexed/ICCBased;
  `undefined` for DCT/JPX/JBIG2).

### `imageredact.ts` (new)

The pure, testable core — no `Document` mutation:

- `coveredPixelBox(ctm: Matrix, w: number, h: number, rect: Rect): PixelBox | undefined`
  — the axis-aligned pixel box for one device rect, or `undefined` when the rect
  misses the image. Throws `UnsupportedFeatureError` on rotated/skewed `ctm`.
- `blankPixels(img: ImageRgba, boxes: PixelBox[]): void` — set RGB → 0, alpha →
  255 inside each box (mutates `img.data`).
- `encodeRgbaXObject(img: ImageRgba): { dict: PdfDict; raw: Uint8Array; smask?: { dict: PdfDict; raw: Uint8Array } }`
  — deflate the RGB planes into a DeviceRGB 8bpc `FlateDecode` image dict; when
  any alpha < 255, also produce the DeviceGray `/SMask` stream.

`PixelBox = { x0: number; y0: number; x1: number; y1: number }` (half-open).

### `redact.ts`

- In `removeRegionContent`, replace the partial-image throw: bucket
  partially-covered `Do` ops per stream as
  `{ opIndex, stream, ctm, boxes: PixelBox[] }` during the provenance walk
  (using the new `ImageEvent.ctm`). Fully-covered images keep the existing
  drop-op path; only partial ones take the re-encode path.
- In the per-stream rebuild loop, for each partial-image op: decode → blank →
  encode; allocate the new image XObject (and `/SMask`) via `doc.allocObject`;
  register it under a fresh name in the scope's resources
  (`ensureOwnResources` for page content, `ec.xobjectResources(path)` for a Form
  XObject) — deriving a unique name (e.g. `RdImg0`, `RdImg1`, …); rewrite the
  `Do` op's name operand to the new name; keep the op.
- Apply the same partial path to the standalone `removeImagesUnder` export for
  consistency.
- `sanitizeResources` runs after, as today; the re-added redacted image is
  referenced by the rewritten `Do`, so it is retained, while an original that
  loses all references is pruned/swept.

## Testing

`test/imageredact.test.ts` (new) — unit tests of the pure core with hand-built
`ImageRgba` and matrices:

- `coveredPixelBox`: a device rect covering the left half of a unit-square-placed
  image yields the left pixel columns; a flipped (`d < 0`) placement maps rows
  correctly; a rect outside the image → `undefined`; a rotated CTM throws.
- `blankPixels` zeroes RGB and sets alpha 255 only inside the box.
- `encodeRgbaXObject` round-trips: inflate the output and confirm pixel values;
  an all-opaque image emits no `/SMask`; an image with alpha emits one.

`test/redact-image.test.ts` (new) — end-to-end through `redactPage`, fixtures
building a page with a Flate DeviceRGB image XObject placed by a known `cm`:

- Partial coverage: re-open the saved PDF, decode the redacted image, assert the
  covered pixel box is black and a sampled uncovered pixel is unchanged.
- Full coverage still drops the image (op removed, resource pruned).
- Rotated placement (`cm` with rotation) throws `UnsupportedFeatureError`.
- JPEG (`DCTDecode`) partial coverage throws `UnsupportedFeatureError`.
- Shared image drawn twice, one placement partially covered: the other
  placement's image is byte-for-byte unchanged (COW verified).
- The opaque marker box is still painted over the region.

## Documentation

`README.md` redaction section: note that partially-covered images are now
clipped and re-encoded (only the covered pixels are destroyed). Limitations:
partial redaction requires a decodable codec (not JPEG/JPX/JBIG2) and
axis-aligned placement; re-encoded images are normalized to DeviceRGB; partial
inline-image coverage is unsupported.

## Follow-up issues (out of scope)

- JPEG (`DCTDecode`) decode to enable partial redaction of JPEG images.
- Rotated/skewed placement (polygon fill in image space).
- Partial inline-image (`BI…EI`) redaction.
- Preserve original colorspace/bit-depth on re-encode (sample-level blanking).

## Non-goals

- No change to text-glyph redaction or fully-covered image removal.
- No new runtime dependencies (decode/encode stay on `node:zlib` + existing code).
```

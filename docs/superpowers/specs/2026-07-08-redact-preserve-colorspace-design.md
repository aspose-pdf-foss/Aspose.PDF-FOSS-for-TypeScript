# Partial image redaction: preserve original colorspace/bit-depth

**Issue:** aspose-pdf-foss-for-ts-njs
**Date:** 2026-07-08
**Status:** Approved

## Problem

Partial image redaction (`redact.ts` → `reencodeRedactedImage`) decodes a
partially-covered image to straight-alpha RGBA via `decodeImageRgba`
(`raster.ts`), blanks the covered pixels, and re-encodes the whole raster as a
DeviceRGB 8-bpc FlateDecode image (`encodeRgbaXObject`, `imageredact.ts`). This
normalizes every source — CMYK, Indexed, ICC, 16-bpc — down to DeviceRGB 8-bpc.
Uncovered pixels are therefore re-quantized and no longer byte-identical to the
original, and the document's colorspace/bit-depth choice is lost.

## Goal

For images whose samples can be decoded without leaving the original colorspace
(i.e. everything except DCT/JPX/JBIG2), blank the covered region **at sample
level** and re-encode preserving the original `/ColorSpace`, `/BitsPerComponent`,
and `/Decode`. Uncovered pixels stay byte-identical after re-inflation.

**Acceptance:** a partially-covered CMYK/Indexed image keeps its
colorspace/bit-depth; uncovered pixels are unchanged; covered by vitest.

## Approach

`ImageInfo.Decode()` already returns raw sample bytes in the original colorspace
and bit-depth for Flate/LZW/ASCII/CCITT filters (DCT is passed through as JPEG
bytes; JPX/JBIG2 throw). So the sample-preserving path decodes once, zeros the
covered samples in place, and re-deflates — no colorspace conversion.

Blank value is **0** for every component (index 0 for Indexed, all-zero for
CMYK/Gray/RGB). This destroys the covered content; the opaque redaction marker
box is painted over the region afterward regardless, so the underlying value is
never visible. Zeroing is uniform across colorspaces and needs no per-space
"black" computation.

### Eligibility

An image takes the sample-preserving path when **all** hold; otherwise it falls
back to the existing RGBA → DeviceRGB path (which remains correct):

- effective filter is sample-returning: not `DCTDecode`/`DCT`, `JPXDecode`, or
  `JBIG2Decode`
- not an `/ImageMask`
- no `/SMask` and no `/Mask` — transparency/masked images keep the RGBA path so
  the alpha/mask is destroyed with the color, avoiding a leaked silhouette
- `/ColorSpace` resolves to a known component count `nc` (Indexed → `nc = 1`)
- `/BitsPerComponent` ∈ {1, 2, 4, 8, 16}
- `Decode()` succeeds

The fallback boundary means no behavior regresses: DCT images, soft-masked
images, and image masks are handled exactly as they are today.

### Sample layout and blanking

PDF image sample streams are row-major with each **row byte-aligned**. For a
`w`-wide image with `nc` components at `bpc` bits:

- row stride (bytes) = `ceil(w * nc * bpc / 8)`
- bit offset of component `c` of pixel `x` within its row =
  `(x * nc + c) * bpc`

`blankSamples(samples, w, h, nc, bpc, boxes)` zeros every component of every
covered pixel:

- `bpc === 8`: write one `0` byte per component
- `bpc === 16`: write two `0` bytes per component (big-endian; value is 0 either
  way)
- `bpc < 8` (1/2/4): clear exactly the `bpc`-bit field at the component's bit
  offset within its byte, leaving the other bit-fields in that byte untouched.
  This is what keeps a box-edge byte shared with an uncovered pixel
  bit-identical.

Covered boxes come from the existing `coveredPixelBox(ctm, w, h, rect)`, which
already maps device rects to half-open pixel boxes and throws
`UnsupportedFeatureError` for rotated/skewed placements. It is unchanged.

## Components

### Pure core — `src/imageredact.ts`

- `blankSamples(samples: Uint8Array, w: number, h: number, nc: number, bpc: number, boxes: PixelBox[]): void`
  — in-place sample zeroing as specified above.
- `encodeSamplesXObject(opts): { dict: PdfDict; raw: Uint8Array }`
  — deflate blanked samples; build the new image dict by cloning
  `Type/Subtype/Width/Height/ColorSpace/BitsPerComponent/Decode` (and `Intent`
  if present) from the source dict, setting `Filter = FlateDecode` and dropping
  the original `/Filter` and `/DecodeParms`. `/ColorSpace` and `/Decode` values
  are carried over by reference (the palette/ICC/array objects stay reachable
  and are re-serialized by `Save`).

### Orchestration — `src/redact.ts`

`reencodeRedactedImage(doc, getOwned, stream, ctm, rects)`:

1. Determine eligibility from the source dict + resolved colorspace.
2. **Eligible:** `samples = info.Decode()` (validates decodability);
   `coveredPixelBox` for each rect (validates rotation) → `boxes`;
   `blankSamples(...)`; `encodeSamplesXObject(...)`. All validation runs before
   `getOwned()` so a throw mutates nothing.
3. **Ineligible:** existing `decodeImageRgba` → `blankPixels` →
   `encodeRgbaXObject` path, unchanged.
4. Register the result as a fresh copy-on-write `RdImg<n>` XObject and return the
   new name — identical to today for both paths.

Component count `nc` is `resolveColorSpace(...).components` (already used by
`raster.ts`); this yields 1 for Indexed, 4 for CMYK/ICC-CMYK/4-colorant DeviceN,
etc.

## Testing (`test/redact-image.test.ts` + fixtures)

New fixture builder in `test/helpers/build-image-pdf.ts` that places a single
image with an arbitrary raw `/ColorSpace` token (name or array, e.g.
`[/Indexed /DeviceRGB 3 <palette-hex>]`), given `bits`, `filter`, `raw`, and a
`cm`.

Cases:

1. **Indexed 8-bpc** — partial redact; reopened image keeps `/ColorSpace`
   `[/Indexed …]` with the original palette; uncovered index bytes are
   byte-identical; covered indices are 0.
2. **DeviceCMYK 8-bpc** — colorspace stays `DeviceCMYK`; uncovered CMYK samples
   identical; covered samples `0,0,0,0`.
3. **Sub-byte (4-bpc Indexed)** — a box edge that bisects a byte: the covered
   nibble is cleared, the uncovered nibble in the same byte is unchanged.
4. **16-bpc** — colorspace/bit-depth preserved; uncovered 16-bit samples
   identical; covered samples 0.
5. **Fallback** — an image with an `/SMask` still re-encodes to DeviceRGB (RGBA
   path), confirming the eligibility boundary. (DCT fallback already covered by
   existing tests.)

## Non-goals

- Blanking or preserving `/SMask` / `/Mask` at sample level (those images use the
  RGBA fallback).
- Predictor-preserving re-encode (output is raw FlateDecode without a predictor).
- Any change to `coveredPixelBox`, rotation handling, or the marker-box paint.

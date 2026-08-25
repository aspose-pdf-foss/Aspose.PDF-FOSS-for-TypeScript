# Partial inline image redaction (BI…EI) — design

**Issue:** aspose-pdf-foss-for-ts-357 (discovered from gq8, "Partial image redaction").

## Problem

Partial redaction of an inline image (`BI … ID … EI`) currently throws
`UnsupportedFeatureError`; only image XObjects are partially redactable. A region
that covers *part* of an inline image should remove only the covered pixels and
leave the rest, re-encoding the image data in place within the content stream.

## Current state

Partial redaction of image **XObjects** already works via
`reencodeRedactedImage` in `src/redact.ts`:

- `sampleRedactPlan` decides between two encode paths.
- **Sample-preserving** path: `ImageInfo.Decode()` → `blankSamples` (in
  `src/imageredact.ts`) → `encodeSamplesXObject`, keeping the original
  colorspace and bit depth.
- **RGBA fallback**: `decodeImageRgba` → `blankPixels` → `encodeRgbaXObject`,
  producing DeviceRGB plus a DeviceGray `/SMask` when any pixel is non-opaque.
- `coveredPixelBox` maps a device rect to the covered pixel box and throws on a
  rotated/skewed placement.

Two sites throw for partial **inline** images:

- `removeRegionContent` (`src/redact.ts`, the live `Redact` path used by
  `redactPage`).
- `removeImagesUnder` (`src/redact.ts`, a standalone exported function with its
  own tests; not on the `redactPage` path).

## Two constraints that shape the design

1. **Abbreviated keys.** Inline image dicts use abbreviations (`W`, `H`, `BPC`,
   `CS`, `F`, `D`, `DP`, `IM`) and abbreviated colorspace/filter names
   (`G`/`RGB`/`CMYK`, `Fl`/`LZW`/`AHx`/…). The existing decoders (`ImageInfo`,
   `sampleRedactPlan`, `decodeImageRgba`) read **full** keys. Filter
   abbreviations are already accepted by `applyDecodeFilters`; the *keys* and the
   device/indexed colorspace names are not. So an inline image must be
   normalized into a synthetic full-key `PdfStream` before reuse.

2. **No `/SMask` inline.** Inline images may not carry a soft mask. The RGBA
   fallback is therefore only usable when its result is fully opaque; a
   non-opaque result must throw.

## Approach

Keep the image **inline** (issue: "re-encode inline image data in place within
the content stream") — no `/Resources` mutation. Normalize, reuse the existing
decode/blank primitives, then re-emit a `BI` op.

### New pure helper — `inlineImageToStream` (`src/imageredact.ts`)

```
inlineImageToStream(inline: { dict: PdfDict; data: Uint8Array }): PdfStream
```

Expand an inline image into a synthetic full-key `PdfStream { dict, raw: data }`:

- Map abbreviated **keys** to full keys: `W→Width`, `H→Height`,
  `BPC→BitsPerComponent`, `CS→ColorSpace`, `F→Filter`, `D→Decode`,
  `DP→DecodeParms`, `IM→ImageMask`, `I→Interpolate`. Keys already in full form
  pass through. `L`/`Length` are dropped (the synthetic stream's length is
  implicit).
- Map abbreviated **device/indexed colorspace** names: `G→DeviceGray`,
  `RGB→DeviceRGB`, `CMYK→DeviceCMYK`, and in an indexed array
  `[/I base hival lookup]` the head `I→Indexed` and the base name recursively.
  Filter names are left as-is (`applyDecodeFilters` accepts abbreviations).
- A bare non-device colorspace name (a `/Resources /ColorSpace` reference)
  passes through unchanged; it will not resolve, so `sampleRedactPlan` returns
  `undefined` and the RGBA fallback then fails to decode → throw. That is the
  intended "named-resource colorspace not supported" outcome.

Pure and Document-free; unit-testable in isolation.

### New orchestrator — `reencodeRedactedInline` (`src/redact.ts`)

```
reencodeRedactedInline(doc, biOp: ContentOp, ctm: Matrix, rects: Rect[]): ContentOp
```

Mirrors `reencodeRedactedImage` but returns a fresh `BI` `ContentOp` instead of
allocating/registering an XObject. Steps:

1. `const stream = inlineImageToStream(biOp.inlineImage!)`.
2. `const plan = sampleRedactPlan(doc, stream)`.
3. **Sample-preserving** (`plan` defined): `ImageInfo.Decode()` (wrap in
   try/catch → `UnsupportedFeatureError`), compute boxes with `coveredPixelBox`
   (validates rotation), `blankSamples`, `deflateSync`. Output inline dict =
   **clone of the original `biOp.inlineImage.dict`** with `F` set to `/Fl` (and
   any `Filter` key removed) and `DP`/`DecodeParms` dropped. W/H/BPC/CS/D are
   unchanged by blanking, so the author's original abbreviations are preserved.
4. **RGBA fallback** (`plan` undefined): `decodeImageRgba(doc, stream, [0,0,0])`
   (undefined → throw). Compute boxes, `blankPixels`. If **any** pixel alpha ≠
   255, throw `UnsupportedFeatureError` (inline images cannot carry `/SMask`).
   Deflate the RGB (drop alpha). Output inline dict `{ W, H, CS:/RGB, BPC:8,
   F:/Fl }`.

All validation (decode, rotation, transparency) runs before the op is built, so
a throw leaves the content unmodified.

### Wire-up

In both `removeRegionContent` and `removeImagesUnder`, replace the
`if (e.kind === 'inline') throw …` with recording the partial inline op the same
way partial XObjects are recorded (op index → `{ ctm, rects }`, keyed to the
stream scope). In each rebuild loop, when the op at index `i` is a recorded
partial inline, push `reencodeRedactedInline(doc, ops[i], ctm, rects)` in place
of the original op (no resource handling needed).

The `q [cm]* BI…EI Q` placement group is **not** cut for a partial inline (only
full-coverage removals go through `imageCutSet`); the surrounding `cm`/`q`/`Q`
that position the image stay, and only the `BI` op's data changes.

## Scope

**Supported:** device or indexed colorspace; bpc ∈ {1,2,4,8,16}; Flate / LZW /
ASCIIHex / ASCII85 / RunLength / CCITT / raw sample data; opaque DCT via the RGBA
fallback.

**Throws `UnsupportedFeatureError`** (matching the XObject path's limits):

- `/ImageMask` stencils (RGBA fallback yields per-pixel alpha → transparency
  throw). Tracked as a follow-up bead.
- Images with transparency / `/Mask` (RGBA result non-opaque).
- Named-resource colorspaces (cannot resolve without page resources).
- Rotated/skewed placement (`coveredPixelBox`).
- Undecodable codecs (JPX/JBIG2, truncated/progressive DCT).

## Testing (vitest)

Fixtures via an inline-image content string in `buildMultiStreamPage` (as the
existing inline tests in `test/redact-image.test.ts` already do).

- **Sample-preserving, DeviceRGB 8-bit:** a small inline image (e.g. 4×4, one
  distinct colour per pixel) placed at a known CTM; redact the left device half;
  reopen and assert covered columns are `[0,0,0]` and uncovered columns keep
  their original channel values. The image stays inline (content still contains
  `BI`, no new `/XObject`).
- **DeviceGray and 1-bit (bpc 1) sample-preserving:** covered bits cleared,
  uncovered bits identical (verifies sub-byte `blankSamples`).
- **Opaque DCT inline via RGBA fallback:** covered columns black, uncovered
  preserved (± JPEG tolerance); output re-encoded as `/Fl /RGB`.
- **Rotated inline placement throws** `UnsupportedFeatureError`.
- **Undecodable inline (truncated DCT) throws.**
- **ImageMask inline throws** (documents the follow-up boundary).
- **Full coverage still drops** the inline image (existing behavior unchanged).
- Unit test for `inlineImageToStream`: abbreviation expansion (keys + device and
  indexed colorspace names).

## Docs

Update the README redaction note: partial redaction now covers inline images
(same colorspace/codec support and the same limits as image XObjects, minus
transparency and image masks, which cannot be represented inline).

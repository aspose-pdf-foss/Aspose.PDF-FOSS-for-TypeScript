# Image (XObject) extraction — design

Issue: `aspose-pdf-foss-for-ts-5ua` (P3, feature)

## Goal

Enumerate and extract embedded images from a page. Expose
`Page.Images: ImageInfo[]`, where each `ImageInfo` reports
width/height/colorspace/bits and gives access to both the raw encoded
stream bytes and decoded bytes (Flate → decoded samples; DCTDecode/JPEG →
raw JPEG passthrough). Image masks / SMasks are handled gracefully (never
throw during enumeration).

Does **not** require the content-stream tokenizer — the walk is purely over
resource dictionaries.

## API

New file `src/image.ts`, an `ImageInfo` live-handle class mirroring the
existing `Page` / `Field` pattern (wraps the live image XObject and resolves
indirect references through the owning `Document`):

```ts
export class ImageInfo {
  readonly Name: string;            // resource key it was found under, e.g. 'Im0'
  readonly Dict: PdfDict;           // live image XObject dict
  get Width(): number;              // /Width (0 when absent/invalid)
  get Height(): number;             // /Height (0 when absent/invalid)
  get Bits(): number;               // /BitsPerComponent; default 8; 1 for /ImageMask
  get ColorSpace(): string;         // label, see below ('' when none)
  get Filter(): string | undefined; // effective codec filter name
  get RawData(): Uint8Array;        // raw encoded stream bytes (still Flate/DCT-encoded)
  Decode(): Uint8Array;             // Flate→decoded samples; DCT→JPEG passthrough; else throws
}
```

`Page.Images: ImageInfo[]` is the entry point (getter on `Page`, delegating to
a helper in `image.ts`).

## Walk

Traverse `Page.Resources/XObject`. For each resolved entry:

- `/Subtype /Image` → emit an `ImageInfo` (keyed by its resource name).
- `/Subtype /Form` → recurse into *that* form's `/Resources/XObject`.

Recursion is cycle-guarded by a `Set<PdfDict>` of visited XObject dicts.

`SMask` / `Mask` are referenced from inside the image dict, not from
`Resources/XObject`, so they are never double-listed. `/ImageMask true`
images are enumerated normally (1-bit, no colorspace); nothing throws.

## ColorSpace label

- name → the name as-is (`DeviceRGB`, `DeviceGray`, `DeviceCMYK`, `Indexed`, …)
- array → first element's name (`ICCBased`, `Indexed`, `DeviceN`, `CalRGB`, …)
- absent → `''`

Named colorspace *resources* are not resolved (YAGNI).

## Decode()

- Effective filter is `DCTDecode` / `DCT` → return `stream.raw` unchanged
  (the JPEG file bytes).
- Otherwise delegate to the existing `inflateStream(stream)` in
  `src/flate.ts`, which already handles a single `FlateDecode` (+ optional
  predictor via `DecodeParms`/`DP`) and throws `UnsupportedFeatureError` for
  anything else (LZW, CCITT, JBIG2, JPX, filter chains).

`RawData` always returns `stream.raw` regardless of filter, so enumeration
and raw access never throw — only `Decode()` of an unsupported filter throws.

## Exports

Add `ImageInfo` to `src/index.ts`.

## Testing

New `test/helpers/build-image-pdf.ts` building a single-page PDF containing:

- a 2×2 `DeviceRGB`, 8-bit, `FlateDecode` image (no predictor)
- a `/DCTDecode` image carrying small JPEG bytes
- an image nested inside a `/Subtype /Form` XObject
- an image with an `SMask`
- an `/ImageMask` image (1-bit, no colorspace)
- an image with an unsupported filter (e.g. `CCITTFaxDecode`)

New `test/image.test.ts` asserts:

- `Page.Images` lists images with correct `Width`/`Height`/`ColorSpace`/`Bits`
- DCT image: `RawData` and `Decode()` both equal the JPEG bytes (passthrough)
- Flate image: `Decode()` equals the expected decoded samples
- the Form-nested image is enumerated (recursion works)
- presence of `SMask` and `/ImageMask` images does not throw
- the unsupported-filter image is listed, but `Decode()` throws
  `UnsupportedFeatureError`

Implementation follows TDD, consistent with the repo's test-per-module layout.

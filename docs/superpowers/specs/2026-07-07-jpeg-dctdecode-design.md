# JPEG (DCTDecode) decode — design

**Issue:** aspose-pdf-foss-for-ts-b3b
**Date:** 2026-07-07
**Status:** approved (brainstorming)
**Discovered from:** aspose-pdf-foss-for-ts-gq8 (partial image redaction)

## Goal

Partial redaction of a `DCTDecode` (JPEG) image currently throws
`UnsupportedFeatureError` because there is no baseline-JPEG decoder: the
rasterizer's `decodeImageRgba` returns `undefined` for `DCTDecode`, and
`redact.ts` turns that into a throw. Add a from-scratch JPEG decoder so DCT
images can be decoded to pixels, blanked, and re-encoded exactly like the
Flate/CCITT path that already works.

Acceptance (from the issue): a partially-covered `DCTDecode` image is decoded,
the covered pixels destroyed, and the image re-encoded; vitest.

## Scope (locked decisions)

- **Coding processes:** baseline sequential DCT Huffman (SOF0, and SOF1
  extended-sequential which shares the same entropy coding), 8-bit precision.
  **Progressive DCT (SOF2) is out of scope here** — split into follow-up
  `aspose-pdf-foss-for-ts-3ee`; it throws `UnsupportedFeatureError` for now.
  Arithmetic coding (SOF9–11), lossless / differential / hierarchical
  (SOF3/5/6/7), and 12-bit precision also throw `UnsupportedFeatureError` — which
  the redaction path already tolerates by degrading to the pre-existing throw.
- **Components / color:** 1 (grayscale), 3 (YCbCr → RGB, honoring the Adobe
  APP14 transform flag), 4 (YCCK → CMYK or CMYK, honoring Adobe inversion).
  Chroma subsampling (e.g. 4:2:0, 4:2:2) and restart markers (DRI/RSTn) are
  handled.
- **CMYK is best-effort:** 4-component JPEGs are converted CMYK → RGB and, like
  all partial redaction, re-encoded as DeviceRGB. Adobe-inverted CMYK is handled
  by the decoder; non-Adobe CMYK edge cases may be imperfect. This is a
  documented fidelity note, not a correctness guarantee.
- **DCT soft-masks stay unsupported:** a DCT-encoded `/SMask` is still declined
  (`decodeSMaskAlpha` keeps rejecting DCT) — the base image decodes, but such a
  soft mask contributes no alpha. Out of scope here.
- **`ImageInfo.Decode()` is unchanged:** it keeps passing DCT bytes through
  (extraction and `Save` still preserve the original JPEG). The new decoder is
  used only on the rasterizer / redaction path.

## Approach

### New module: `src/jpeg.ts`

A pure decoder with no `Document` coupling:

```ts
export interface JpegImage {
  width: number;
  height: number;
  comps: number;          // 1, 3, or 4
  data: Uint8Array;       // interleaved 8-bit, comps per pixel, row 0 = top
}
export function decodeJpeg(bytes: Uint8Array): JpegImage;
```

`decodeJpeg` throws `UnsupportedFeatureError` for unsupported coding
processes/precision (progressive SOF2 included, until follow-up `3ee`) and
`PdfParseError` for malformed / truncated streams. The `data` channels are the
final color-transformed samples:

- 1 comp → gray.
- 3 comp → R,G,B (YCbCr → RGB applied unless Adobe transform flag == 0).
- 4 comp → C,M,Y,K (YCCK → CMYK applied when Adobe transform == 2; Adobe
  inversion applied when the APP14 marker is present, so the caller receives
  conventional CMYK where 0 = no ink).

**Decoder pipeline:**

1. **Marker walk.** SOI; APPn (capture APP14 "Adobe" transform byte, mirroring
   the scan already in `imageembed.ts`); DQT (up to 4 quantization tables, stored
   in zig-zag order); DHT (Huffman tables → fast lookup built from the
   `bits[16] + values` encoding); DRI (restart interval); SOFn (frame header:
   precision, dimensions, per-component id + H/V sampling factors + quant-table
   id); SOS (scan header); EOI. Reject progressive (SOF2),
   arithmetic/lossless/hierarchical SOFs, and non-8-bit precision.
2. **Geometry.** Compute `maxH`/`maxV`, MCUs per line/column, and per-component
   block grid. Allocate an `Int16Array` coefficient store per component sized to
   its block grid × 64.
3. **Entropy decode (per SOS scan).** Baseline sequential: per 8×8 block, DC =
   previous-DC + Huffman-decoded diff; AC = run/size Huffman with the 0..63
   zig-zag walk. Interleaved (multi-component MCU) or single-component
   (non-interleaved) ordering. Restart markers reset the DC predictors and
   resync the bit reader every `DRI` MCUs.
4. **Reconstruct.** After all scans: dequantize each block, run a float
   separable 8×8 inverse DCT, and write spatial samples into each component's
   full-resolution plane, upsampling subsampled components (box/replicate) to the
   image size.
5. **Color transform.** Apply YCbCr → RGB / YCCK → CMYK and Adobe CMYK inversion
   per the rules above; emit interleaved `data`.

The IDCT is the float separable form (row 1-D IDCT then column 1-D IDCT) for
clarity and correctness; redaction tolerates the tiny rounding cost.

### Integration: `src/raster.ts`

`decodeImageRgba` gains a DCT branch placed **before** the existing
`NO_RASTER_DECODER` short-circuit (so `DCTDecode` stays in that set for
`decodeSMaskAlpha`, which continues to decline DCT soft-masks):

```ts
const f = info.Filter;
if (f === 'DCTDecode' || f === 'DCT') {
  let dec: JpegImage | undefined;
  try { dec = decodeJpeg(info.Decode()); } catch { return undefined; }
  const { width: jw, height: jh, comps, data: s } = dec;
  const alpha = decodeSMaskAlpha(doc, dict, jw, jh);   // Flate /SMask still honored
  const data = new Uint8Array(jw * jh * 4);
  for (let i = 0; i < jw * jh; i++) {
    let r: number, g: number, b: number;
    if (comps === 1)      { r = g = b = s[i]; }
    else if (comps === 3) { r = s[i*3]; g = s[i*3+1]; b = s[i*3+2]; }
    else /* 4: CMYK */    { /* naive CMYK→RGB from s[i*4..i*4+3] */ }
    data[i*4] = r; data[i*4+1] = g; data[i*4+2] = b;
    data[i*4+3] = alpha ? alpha[i] : 255;
  }
  return { w: jw, h: jh, data };
}
if (NO_RASTER_DECODER.has(f ?? '')) return undefined;   // JPX/JBIG2 still undecodable
```

- Dimensions come from the decoded SOF (authoritative for sample layout); the
  `w*h > 64M` guard still applies up front.
- The `fill` argument is unused for DCT (JPEG is never an `/ImageMask`).
- No change to `redact.ts`: `reencodeRedactedImage` already decodes via
  `decodeImageRgba`, blanks, and re-encodes; it simply stops throwing for JPEG.

## Testing

JPEG bytes cannot be produced by `node:zlib` alone, so add a **minimal,
dependency-free baseline JPEG encoder** as a fixture builder in `test/helpers/`
(`build-jpeg.ts`). This keeps tests deterministic and self-contained (no external
tool, no runtime dep), mirroring the existing programmatic-fixture convention.
(The follow-up progressive work, `3ee`, will test via embedded pre-generated
progressive byte-array fixtures rather than a progressive encoder.)

### `test/jpeg.test.ts` (new) — decoder unit tests

Round-trip encode → `decodeJpeg` → compare, with a small per-channel tolerance
(DCT is lossy; flat-color blocks assert near-exact via DC-only energy):

- Grayscale (1 comp) round-trips.
- YCbCr 4:4:4 (no subsampling) round-trips to RGB.
- YCbCr 4:2:0 / 4:2:2 (subsampled) round-trips within tolerance; correct
  dimensions and upsampling.
- CMYK / Adobe (4 comp) decodes to sane CMYK (inversion handled).
- Restart interval (DRI) stream decodes identically to the non-restart version.
- A progressive (SOF2) stream throws `UnsupportedFeatureError` (deferred to
  `3ee`); arithmetic-coding SOF likewise throws; truncated/garbage streams throw
  `PdfParseError`.

### `test/redact-image.test.ts` (update) — end-to-end

- The existing *"JPEG (`DCTDecode`) partial coverage throws
  `UnsupportedFeatureError`"* assertion **flips to success**: build a page with a
  real baseline-JPEG image XObject placed by a known `cm`, redact a partial
  region, re-open the saved PDF, decode the redacted image, and assert the
  covered pixel box is black while a sampled uncovered pixel is preserved (within
  DCT tolerance).
- Full-coverage JPEG removal is unchanged (op dropped, resource pruned) — still
  works because it never needed a decoder.
- A progressive-JPEG image under partial coverage still throws
  `UnsupportedFeatureError` (deferred to `3ee`).

## Documentation

- **README** redaction section: narrow the JPEG partial-redaction exclusion to
  *baseline* only — state that baseline `DCTDecode` images are now partially
  redactable (decoded, blanked, re-encoded as DeviceRGB like other codecs). Note
  remaining limitations: progressive JPEG (follow-up), arithmetic-coded JPEG,
  12-bit JPEG, and DCT-encoded soft masks are unsupported and degrade
  gracefully; JPX/JBIG2 still undecodable.

## Non-goals

- No progressive (SOF2) JPEG — follow-up `aspose-pdf-foss-for-ts-3ee`.
- No JPXDecode / JBIG2Decode support (issues `kec` / `8t9`).
- No DCT `/SMask` decode (Flate soft masks remain the supported path).
- No 12-bit or arithmetic-coded JPEG.
- No change to `ImageInfo.Decode()` DCT passthrough, extraction, or `Save`
  (original JPEG bytes are still preserved when an image is not redacted).
- No new runtime dependencies (`node:` built-ins only; the JPEG encoder lives in
  `test/helpers/`).
```

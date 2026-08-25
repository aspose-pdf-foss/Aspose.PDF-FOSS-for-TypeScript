# Baseline JPEG Encoder (`encodeJpeg`) — Design

**Issue:** aspose-pdf-foss-for-ts-aw0 · Baseline JPEG encoder
**Date:** 2026-07-15

## Problem

The tree has no *production* JPEG encoder. `jpeg.ts` is decode-only (baseline,
progressive, arithmetic, lossless, hierarchical) and `pngencode.ts` is the only
encoder under `src/`.

`test/helpers/build-jpeg.ts` does contain a fixture-grade baseline encoder, but
it cannot serve this purpose, and the reasons are the whole point of this issue:
its `DQT` is **all ones** (build-jpeg.ts:208) — no quantization, hence no quality
knob — and its `fixedHuff` (build-jpeg.ts:54) gives every symbol the same code
length, so it barely compresses. Those are deliberate choices for a fixture
generator and exactly the two things a production encoder must do properly. See
"Relationship to build-jpeg.ts" below.

Issue `kqy` (Optimize: image downsampling + recompression) cannot honor its
"target quality" acceptance criterion without one: re-encoding a photographic
image as Flate would grow it several-fold. The encoder is the blocker, and it is
a substantial from-scratch subproject with its own test surface, so it is
specced and landed on its own rather than as a sub-task of the optimizer.

This is the same split the `doo` spec made when it moved images out of
`Optimize`: a hard dependency, not a preference.

## Scope

Sequential **baseline** DCT, 8-bit precision, 1/3/4 components, with per-image
optimized Huffman tables.

**Out of scope** — progressive, arithmetic, 12-bit, lossless, hierarchical, and
restart markers. Nothing in the tree needs to *write* them; the decoder already
covers *reading* them. Adding a mode later is additive.

`encodeJpeg` is **internal**, like `encodePng`: imported by its consumers, not
re-exported from `index.ts`. It gains a public surface only if and when a public
API needs one.

## Architecture

Three focused modules, mirroring how decode is already split across
`jpeg.ts` / `jpegarith.ts` / `jpeglossless.ts` / `jpeghier.ts`.

| Module | Responsibility |
|---|---|
| `src/jpegfdct.ts` | Forward DCT, Annex K quantization tables, quality scaling, quantize |
| `src/jpeghuffenc.ts` | Bit writer (`FF00` stuffing), canonical table build, 16-bit length limiting, Annex K standard tables |
| `src/jpegencode.ts` | Color transform, block/MCU assembly, marker writing, orchestration |

## API

The signature mirrors `encodePng(width, height, data, kind)` so the two encoders
read the same way at their call sites.

```ts
export type JpegKind = 'gray' | 'rgb' | 'cmyk';

export interface JpegEncodeOptions {
  /** 1..100 on the IJG scale. Default 75. */
  quality?: number;
  /** 3-component only; ignored for gray and CMYK. Default '4:2:0'. */
  subsampling?: '4:4:4' | '4:2:0';
  /** Per-image Huffman tables. Default true. */
  optimizeHuffman?: boolean;
}

/** Encode interleaved 8-bit samples as a baseline JPEG. */
export function encodeJpeg(
  width: number, height: number, samples: Uint8Array, kind: JpegKind,
  opts?: JpegEncodeOptions,
): Uint8Array;
```

`samples` is interleaved at 1 (gray), 3 (RGB), or 4 (CMYK) bytes per pixel, row
-major, length `width * height * channels`. A length mismatch throws `TypeError`,
consistent with `addImage`'s rect validation.

## Pipeline

1. **Color transform** — RGB → YCbCr (JFIF full-range). Gray and CMYK pass
   through untransformed.
2. **Subsample** — for 4:2:0, box-average Cb/Cr 2×2. 4:4:4 leaves planes as-is.
3. **Blocks** — split each plane into 8×8, replicating edge pixels into partial
   blocks at the right/bottom margins.
4. **Level shift** — subtract 128.
5. **FDCT** — separable float forward DCT, mirroring the structure of the
   existing `idct` (src/jpeg.ts:31). Readability over speed: these images are
   encoded once, not decoded in a render loop.
6. **Quantize** — divide by the scaled table, round to nearest.
7. **Entropy code** — DC differential + AC run-length (`RRRRSSSS`, `EOB`, `ZRL`),
   MCU-interleaved.
8. **Markers** — `SOI, APP0?, DQT, SOF0, DHT, SOS, <entropy>, EOI`.

**Quality scaling** uses the standard IJG formula over the Annex K base tables:
`scale = quality < 50 ? 5000 / quality : 200 - 2 * quality`, then
`value = clamp(floor((base * scale + 50) / 100), 1, 255)`. Quality is clamped to
1..100.

The `floor` is load-bearing, not a rounding preference: libjpeg computes this
with C integer division, which truncates. At `quality: 50` the scale is exactly
100, so `floor((base * 100 + 50) / 100) === base` — the identity the tests pin.
Using `round` there would yield `base + 1` for every entry, silently degrading
every image encoded at the default-adjacent qualities.

**MCU geometry** — 8×8 (one block per component) for gray and 4:4:4; 16×16 with
4 Y blocks + 1 Cb + 1 Cr for 4:2:0. CMYK is always 4:4:4: chroma subsampling is
meaningless without a chroma/luma separation.

## Optimized Huffman tables

Default on, and still fully baseline-compliant — the tables are transmitted in
`DHT`, so any conforming reader accepts them. Typically 5-10% smaller than the
standard tables.

Two passes over the coefficients:

1. Encode to a **symbol histogram** only, emitting no bits.
2. Build canonical tables from the histogram, then encode for real.

Table construction follows Annex K.2, including the **reserved-codeword trick**:
a phantom symbol of count 1 is included during code-length generation so no real
symbol can be assigned the all-ones codeword, and the length-limiting procedure
then folds any code longer than 16 bits back under the limit. Both are required
for a decodable table; a naive Huffman build can emit 17+ bit codes on adversarial
histograms.

`optimizeHuffman: false` selects the Annex K standard tables. Beyond being an
escape hatch, this gives the tests a fixed-table control whose output does not
shift when the histogram logic changes.

## Colorspace conventions

**Gray and RGB** carry an APP0/JFIF marker.

**CMYK is written with no Adobe APP14 marker, and samples are stored
uninverted.** This is load-bearing rather than incidental:

- `combinePlanes` (src/jpeg.ts:334) inverts CMYK **only** when APP14 is present
  (`cmyk(data, transform, adobeTransform !== undefined)`).
- `buildJpegXObject` (src/imageembed.ts:80) emits `/Decode [1 0 1 0 1 0 1 0]`
  **only** under the same condition.

So omitting APP14 means no inversion is applied on either the decode path or the
embed path, and all three components of the round trip agree. Writing APP14 would
silently oblige the encoder to store inverted samples to stay consistent with
both — a trap with no upside here, since in PDF the image dict's `/ColorSpace`
governs interpretation and needs no marker to disambiguate.

## Relationship to `build-jpeg.ts`

The new `src/` modules share **no code** with `test/helpers/build-jpeg.ts`, and
the helper is left untouched. This duplicates a `BitWriter`, an FDCT, and a color
transform, and the duplication is deliberate.

`build-jpeg.ts` generates the fixtures that validate `decodeJpeg`. If it imported
the production encoder, `decodeJpeg`'s test suite would depend on our encoder
while our encoder's suite depends on `decodeJpeg` — mutually confirming, and a
shared bug in a common primitive would be invisible to both.

Keeping them apart preserves an **independent implementation** of the format. The
decoder stays anchored by fixtures from an encoder that shares nothing with the
code under test, which is also the strongest available mitigation for the
round-trip blind spot described below.

The helper is also not merely "the same thing, less polished": it writes
CMYK as Adobe-inverted with an APP14 marker (build-jpeg.ts:105-108), where this
encoder writes neither. Both are self-consistent; they are simply different
choices, and neither needs to follow the other.

Mining the helper for proven approaches — the `FF00` stuffing in `BitWriter`,
`category`/`valueBits`, the YCbCr transform, the MCU traversal — is expected and
encouraged. Copying an approach is not the same as sharing a module.

## Testing

TDD per house style. Tests in `test/jpegencode.test.ts` (plus per-module tests for
`jpegfdct` and `jpeghuffenc`), over synthetic rasters — gradients, flat fields,
sharp edges, pseudo-random noise — from a new `test/helpers/build-raster.ts`
builder, mirroring the existing builders' style.

A lossy encoder has no byte-exact expectation, so correctness is pinned by
round-tripping through the tree's own decoder with quality-indexed PSNR floors:

- **Round trip** `encodeJpeg` → `decodeJpeg` at PSNR floors q90 ≥ 40dB,
  q75 ≥ 35dB, q50 ≥ 30dB, for gray, RGB (at both 4:4:4 and 4:2:0), and CMYK.
  4:2:0 floors apply to the luma plane; chroma is subsampled by design, so a
  whole-image RGB PSNR at 4:2:0 is held to the q50 floor at every quality.
- **Monotonicity** — rising quality yields strictly larger output and
  non-decreasing PSNR.
- **Optimized vs standard tables** — optimized is strictly smaller on the same
  input; both decode to identical geometry.
- **Structure** — exact assertions on geometry, component count, and marker
  layout.
- **Edge geometry** — dimensions that are not multiples of 8 (and, for 4:2:0, not
  multiples of 16) round-trip at the correct size; 1×1 and single-row images
  encode and decode.
- **Flat field** round-trips near-exactly: a cheap, sharp correctness signal that
  a subtly wrong DCT or quant table cannot pass.

### Known blind spot

Verifying an encoder against our own decoder cannot catch a convention both sides
get wrong in the same direction.

This is sharper than it first appears, and the spec should say so plainly: **the
tree contains no real-world JPEG fixture.** A survey of `test/` finds no `.jpg`
file and no embedded base64 blob — `decodeJpeg` is validated entirely against
synthetic fixtures from `build-jpeg.ts`. So the JPEG chain is currently
self-referential end to end: nothing here has ever been checked against bytes
produced by a third-party encoder.

Three mitigations, which together are meaningful but stop short of interop proof:

- `build-jpeg.ts` and this encoder are **independent implementations** that share
  no code, and both must agree with `decodeJpeg`. A shared wrong convention would
  have to be arrived at twice, separately.
- The Annex K tables and the IJG scaling formula are fixed constants, checked
  against the specification rather than against our decoder. Note that a
  misremembered constant here costs *compression ratio, not correctness*: both
  quant and Huffman tables are transmitted in `DQT`/`DHT`, so any internally
  valid table still decodes correctly in any conforming reader.
- One test hand-verifies the DC coefficient of a known flat 8×8 block against an
  independently computed DCT value, anchoring the transform to arithmetic rather
  than to `idct`'s inverse.

What remains uncovered is the shared-convention class of bug: marker layout or
component ordering that our decoder tolerates and a real reader rejects. Closing
it needs bytes from a trusted encoder. Taking a dev dependency (sharp /
ImageMagick) is rejected — it cuts against the zero-dependency and hermetic-test
conventions. The house already has a pattern for exactly this gap:
**aspose-pdf-foss-for-ts-da9** checks in a real-world `.woff2` from a trusted
encoder as a regression fixture. A follow-up issue applies that pattern to JPEG
and closes this for the decoder and the encoder at once. It is deliberately not a
blocker: it constrains nothing in this design, and the encoder is useful before
it lands.

## Follow-up

- **aspose-pdf-foss-for-ts-kqy** — `Optimize({ images })`: placement/DPI scan,
  resampling, re-embed, report. Blocked on this issue; gets its own spec.
- **aspose-pdf-foss-for-ts-w6m** — check in real-world JPEGs from a trusted encoder
  (baseline gray/RGB/CMYK, 4:4:4 and 4:2:0), mirroring what `da9` does for
  `.woff2`. Validates `decodeJpeg` against non-synthetic bytes and closes the
  shared-convention blind spot above. Not a blocker for this issue.
- Progressive encoding, restart markers, and 12-bit precision if a consumer ever
  needs them.

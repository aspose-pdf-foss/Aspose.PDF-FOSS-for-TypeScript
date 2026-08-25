# JPEG differential + hierarchical decode (SOF5-7 / SOF13-15, DHP, EXP)

**Date:** 2026-07-13
**Issue:** aspose-pdf-foss-for-ts-ac6.3 (Sub-project C of the arithmetic / lossless /
differential / hierarchical bundle, ac6)
**Status:** approved — planning

## Context

After ac6.1 (arithmetic DCT, SOF9/10) and ac6.2 (lossless, SOF3/SOF11),
`decodeJpeg` (`src/jpeg.ts`) decodes every *single-frame* JPEG coding process.
Issue ac6 's last piece is **hierarchical mode** (T.81 Annex J): a multi-frame
progression where a non-differential base frame is refined by one or more
*differential* frames, each adding a residual — DCT or lossless, Huffman or
arithmetic — onto an upsampled reconstruction of the previous frame.

This depends on A and B because a differential residual reuses any of their
entropy/transform paths; only the *reconstruction* step differs (no level shift,
add to reference). Completing this closes the ac6 epic.

## Goal / non-goals

**Goal:** decode hierarchical JPEGs — DHP frame header, EXP 2× reference
expansion, and all six differential frame types (SOF5/6/7 Huffman, SOF13/14/15
arithmetic) — to pixel samples, so hierarchical `DCTDecode` images flow through
the existing redaction / `decodeImageRgba` consumers. No change to the public
`JpegImage` interface.

**Non-goals:** intra-frame component subsampling combined with hierarchical
progression (frames are treated as 1×1-sampled); precision > 12 (kept at 8/12 to
match the existing constraint). Predictor selection value 0 is supported *only*
for differential-lossless frames (where it means "no spatial prediction").

## Detection strategy — branch, don't rewrite

Hierarchical mode restructures `decodeJpeg`'s single-frame assumption into a
frame-composition loop. To keep this off the existing (single-frame) hot path and
its ~1583 guarding tests, the decoder **branches by detection**:

- A cheap marker pre-walk (`isHierarchical(data)`) advances over segments by their
  length fields until the first SOS, returning `true` if it sees **DHP** (`0xDE`)
  or any **differential SOF** (`0xC5-0xC7`, `0xCD-0xCF`).
- **Not hierarchical** → the existing `decodeJpeg` body runs completely unchanged
  (zero regression risk).
- **Hierarchical** → `decodeHierarchical(data)` in a new module `src/jpeghier.ts`
  runs the frame-composition loop.

Shared marker parsing (DQT / DHT / DAC and the SOF header) is extracted into small
exported helpers in `jpeg.ts` so both paths stay DRY and consistent. The residual
scans reuse `decodeScan` / `decodeArithScan` / `decodeLosslessScan` unchanged.

## Frame flags from the marker

The six differential markers carry the same base-process flags as their
non-differential twins, plus `differential`. The entropy decode is byte-identical;
only reconstruction differs.

| flag | markers |
|---|---|
| `differential` | C5, C6, C7, CD, CE, CF |
| `progressive` | C2, **C6**, CA, **CE** |
| `lossless` | C3, **C7**, CB, **CF** |
| `arithmetic` | C9, CA, CB, CD, CE, CF |

`Frame` gains `differential: boolean`. `Comp` gains `quant?: Int32Array` (see
below). Accepted SOF markers become C0-C3, C5-C7, C9-CB, CD-CF (all SOF except
C4=DHT and C8=JPG-reserved, which still throw). DHP (`0xDE`) and EXP (`0xDF`) are
new marker cases.

## Reconstruction: residual-aware planes

Each frame reconstructs to **per-component `Int32` planes at frame resolution,
before the color transform** — composition happens in component space, color is
applied once at the very end:

- **Non-differential DCT** (frame 1): IDCT **with** level-shift + clamp → absolute
  samples.
- **Differential DCT:** IDCT with **no level-shift and no clamp** → signed
  residual. `idct` gains a `differential` mode (`shift = 0`, skip the [0,maxv]
  clamp).
- **Non-differential lossless:** the `c.samples` plane (absolute).
- **Differential lossless:** predictor `Psv = 0` (no spatial prediction) →
  `c.samples` holds the raw residual. `losslessPredict` / the lossless
  `decodeSample` treat `Psv = 0` as `Px = 0`.

### Quant-table snapshot

DCT reconstruction is deferred to frame finalize, but a later frame's DQT may
overwrite `qt[]` before then. To avoid the race, each component snapshots its
quant table at SOF parse time into `Comp.quant = qt[c.tq]`. Reconstruction reads
`c.quant`, immune to later redefinition. (Huffman/DAC tables are used at scan-decode
time, which is immediate, so they have no such race.)

## Composition & EXP

```
refPlanes = reconstruct(frame1)                    // absolute, Int32 per component
for each differential frame k (in order):
    if EXP pending: refPlanes = upsample2x(refPlanes, Eh, Ev)   // per component, ×2
    refPlanes[c] = clamp0..maxv(refPlanes[c] + reconstruct(k)[c])  // element-wise
output = combineFinal(lastFrame, refPlanes, adobe) // clamp → 8-bit → combinePlanes
```

- **Frame finalize** happens lazily: when the next SOF/DHP arrives or at EOI, the
  pending frame's scans are complete and it is reconstructed + composed.
- **EXP** (`0xDF`, length 3, data byte `Eh<<4 | Ev`) upsamples **each** reference
  component ×2 in H and/or V by bilinear interpolation: even output = original,
  odd output = `(a + b + 1) >> 1`, last odd = last original (edge replication).
  Applies only to the immediately following differential frame; the pending
  expansion is consumed at that frame's finalize.
- **combineFinal** clamps each Int32 plane to `[0, maxv]`, downshifts 12→8-bit, and
  calls the shared `combinePlanes` for upsampling + interleave + color transform.

The oracle makes the EXP filter choice self-consistent: since the encoder forms
`residual = original − upsample(ref)` and the decoder yields
`upsample(ref) + residual = original`, a **lossless differential frame recovers the
original exactly** regardless of the exact filter — the skip'd real-file slot is
the eventual independent check on the filter and the composition math.

**Scope guard:** frames use 1×1 sampling; test image dimensions are multiples of 16
so EXP doubling lands on padded (8×8-block) boundaries evenly. `upsample2x` and the
element-wise add crop to the differential frame's plane extent.

## `src/jpeghier.ts`

- `isHierarchical(data: Uint8Array): boolean` — the pre-walk detector.
- `decodeHierarchical(data: Uint8Array): JpegImage` — the frame-composition loop
  (marker parsing via the shared helpers + reconstruction + EXP + compose).
- `upsample2x(plane: Int32Array, pw: number, ph: number, eh: boolean, ev: boolean): { plane: Int32Array; pw: number; ph: number }`.
- `dctPlanes(frame, differential): Int32Array[]` and `losslessPlanes(frame): Int32Array[]`
  — residual-aware reconstruction to Int32 component planes (reuse `idct` / `ZIGZAG`).
- `combineFinal(frame, planes: Int32Array[], adobe): JpegImage`.

Exports newly needed from `jpeg.ts`: `idct` (with a `differential` param),
`setupGeometry`, `decodeScan`, and the extracted table/SOF parse helpers, plus the
already-exported `ZIGZAG`, `combinePlanes`, `BitReader`, `buildHuff`, `decodeHuff`,
`extend`, and the `Frame`/`Comp`/`Plane`/`Huff`/`JpegImage` types.

## Test encoder

**`test/helpers/build-jpeg-hier.ts`** — a hierarchical frame-splitter:

- **Frame 1** is a **lossless** low-res base (downsample the full image by 2 in the
  expanded axes). Lossless ⇒ the reconstruction equals the low-res input exactly,
  so the encoder needs no self-decode to form the reference.
- **EXP** upsamples the base ×2 (the same `upsample2x` the decoder uses).
- **Frame 2** (differential) encodes `residual = full − upsample(base)` as any of
  the six differential types:
  - DCT-differential (SOF5/13): a **shift-0 FDCT** of the residual (no level shift),
    Huffman or arithmetic sequential entropy.
  - progressive-differential (SOF6/14): the progressive encoder at shift 0.
  - lossless-differential (SOF7/15): `Psv = 0`, Huffman or arithmetic.
- Assembles `SOI · DHP · [tables] · frame1(SOF+scans) · EXP · frame2(SOF+scans) · EOI`.

Options: `width/height/comps/pixels`, `residual: '{seq|prog}-dct' | 'lossless'`,
`mode: 'huffman' | 'arithmetic'`, `expand: 'h' | 'v' | 'hv'`.

## Test plan

`test/jpeg.test.ts` (unit), `test/redact-image.test.ts` (acceptance). Oracle:
exact recovery for lossless-differential, DCT-tolerance for DCT-differential.

1. Two-frame hierarchical, **SOF5 / SOF13** (differential sequential DCT, Huffman /
   arithmetic) → matches the original within DCT tolerance.
2. **SOF7 / SOF15** (differential lossless, Huffman / arithmetic) → **exact**.
3. **SOF6 / SOF14** (differential progressive DCT) → within tolerance.
4. **EXP** variants: horizontal-only, vertical-only, both — lossless-differential,
   exact.
5. Grayscale + RGB.
6. `decodeImageRgba` — a hierarchical DCTDecode image XObject decodes to RGBA.
7. **Acceptance (redaction):** a partially-covered hierarchical DCTDecode image is
   decoded, covered pixels blacked, re-encoded.
8. **Real-file slot** (`it.skip`) with provenance recipe (jpeg-9 / PVRG
   hierarchical; libjpeg cannot emit hierarchical) to later drop in an
   externally-generated file, guarding the EXP filter + composition against a
   shared encoder/decoder bug.

## Risks

The frame-composition math (EXP upsampling, residual add, level-shift handling)
and the deferred-reconstruction quant snapshot are the main risks. Mitigations:

- lossless-differential is **exact**, so the composition + EXP are checked against
  the known original independently of coefficient values;
- the single-frame path is byte-for-byte unchanged (detection branch), so the
  entire existing suite guards against regressions;
- the skip'd real-file slot is the follow-up guard for the EXP filter and the
  encoder/decoder symmetry.

## Out of scope / follow-ups

- Intra-frame subsampling within hierarchical frames.
- Filling the real-file hierarchical fixture slot.
- This closes the ac6 epic; no sub-project D.

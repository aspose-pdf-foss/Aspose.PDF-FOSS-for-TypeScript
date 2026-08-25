# JPEG arithmetic-coded DCT decode (SOF9 / SOF10)

**Date:** 2026-07-10
**Issue:** aspose-pdf-foss-for-ts-ac6 (Sub-project A of the arithmetic / lossless /
differential / hierarchical bundle)
**Status:** shipped

## Context

`decodeJpeg` (`src/jpeg.ts`) currently decodes baseline (SOF0), extended
sequential (SOF1), and progressive (SOF2) **Huffman**-coded DCT JPEGs at 8- or
12-bit precision. It throws `UnsupportedFeatureError` for every other coding
process. Issue ac6 asks for arithmetic (SOF9-11), lossless (SOF3), differential
(SOF5-7) and hierarchical support so those `DCTDecode` images can be decoded for
**partial image redaction** (decode → destroy covered pixels → re-encode).

The bundle is decomposed into three sequenced sub-projects, each landing
independently and each on its own satisfying the ac6 acceptance criterion (only
*one* coding process need decode end-to-end):

- **A — Arithmetic-coded DCT (SOF9, SOF10).** This document.
- **B — Lossless (SOF3 Huffman, SOF11 arithmetic).** Reuses A's QM decoder.
- **C — Differential + Hierarchical (SOF5-7, SOF13-15, DHP, EXP).** Depends on
  A and B (a differential frame's residual can use any of their paths).

This spec covers **Sub-project A only.**

## Goal / non-goals

**Goal:** decode arithmetic-coded sequential (SOF9) and progressive (SOF10) DCT
JPEGs to pixel samples, reusing the existing dequant/IDCT/`assemble`/color path,
so arithmetic `DCTDecode` images flow through the existing redaction pipeline
unchanged.

**Non-goals (deferred to B/C):** lossless coding (SOF3/SOF11), differential
(SOF5-7/SOF13-15), hierarchical (DHP/EXP). Arithmetic *lossless* (SOF11) is part
of B, not A. No change to the public `JpegImage` interface or to any consumer in
`raster.ts`.

## Architecture

Arithmetic-specific code lives in a **new module `src/jpegarith.ts`**, keeping
`jpeg.ts` focused (it already carries the full Huffman + DCT + color pipeline).
The existing coefficient store (`Comp.blocks`, raw natural-order coefficients),
`setupGeometry`, dequantization, `idct`, `assemble`, and all color transforms are
**reused byte-for-byte** — arithmetic coding changes only entropy decoding and
per-block symbol reading.

### `src/jpegarith.ts` exports

- **`class ArithDecoder`** — the QM-coder decoder of T.81 Annex D.
  - Registers: `C` (32-bit code), `A` (16-bit interval), `CT` (bit counter),
    plus the input byte cursor.
  - Procedures: `INITDEC`, `DECODE`, `RENORMD`, `BYTEIN` — implemented per Annex
    D, including JPEG's `0xFF` byte-stuffing / marker-detection in `BYTEIN`
    (a `0xFF` followed by a byte > `0x8F` marks the end of entropy data).
  - Driven by the standard 47-state probability table (Table D.3): `Qe[47]`,
    `NMPS[47]`, `NLPS[47]`, `SWITCH[47]`.
  - Core method `decode(stats: Uint8Array, s: number): 0 | 1` — decodes one binary
    decision against statistics bin `s`, updating that bin's state index + MPS
    sense in place (MPS/LPS exchange + renormalization).
  - Convenience `decodeFixed(): 0 | 1` — decode against a fixed 0.5 bin (used for
    sign and low-order magnitude / refinement bits).

- **`class ArithStats`** — per-component statistics areas, sized to mirror
  libjpeg (`jdarith.c`): `dc: Uint8Array(64)` and `ac: Uint8Array(256)` state
  bins per used table, plus per-component previous-DC difference `Da` (for DC
  context selection). `reset()` zeros all bins (state 0, MPS 0) and clears `Da`.

- **`function decodeArithScan(data, seg, entropy, frame, dac, restartInterval): number`**
  — the arithmetic counterpart to `decodeScan`. Parses the SOS header identically
  (component selectors, `Ss/Se/Ah/Al`), then dispatches per block to sequential
  or progressive DC-first / DC-refine / AC-first / AC-refine decoders and writes
  into `Comp.blocks`. Returns the byte position past the entropy segment.

### Shared traversal refactor in `src/jpeg.ts`

The MCU/block traversal (currently inline at the bottom of `decodeScan`: the
interleaved multi-component loop, the non-interleaved single-component loop, and
the restart cadence) is extracted into an exported helper:

```ts
export function forEachBlockInScan(
  frame: Frame,
  scan: { c: Comp }[],
  restartInterval: number,
  decodeBlock: (si: number, off: number) => void,
  onRestart: () => void,
): void;
```

Both entropy paths call it. `onRestart` performs `BitReader.restart()` +
predictor/eobrun reset for Huffman, or `ArithDecoder` re-`INITDEC` + `ArithStats`
reset for arithmetic. The existing Huffman `decodeScan` is rewritten to call the
helper with no behavior change; existing tests guard the refactor.

## Entropy model detail

### DAC segment (marker `0xCC`)

Parsed in `jpeg.ts` alongside `DHT`. Each Tc/Tb entry carries one value byte:

- DC table (`Tc = 0`): `L = value >> 4`, `U = value & 0x0F` — the conditioning
  bounds for classifying the previous DC difference.
- AC table (`Tc = 1`): `Kx = value` — the coefficient index splitting low- vs
  high-frequency AC magnitude contexts.

Stored as `dcCond[tb] = {L, U}` and `acCond[tb] = {Kx}`. Defaults when no `DAC`
appears: `L = 0, U = 1` (DC) and `Kx = 5` (AC), per T.81. Passed to
`decodeArithScan`.

### DC decode (Annex F.1.4.4.1)

Context is selected from the component's previous difference `Da`, classified
into one of 5 buckets — zero, small-positive, small-negative, large-positive,
large-negative — using the `L`/`U` bounds. The decode is a binary decision tree
over the DC stats bins:

1. Decode "is the difference zero" against the context bin.
2. If nonzero: decode the sign, then the magnitude *size* as a sequence of
   "magnitude ≥ 2^k" decisions, then the low-order magnitude bits (fixed-prob).
3. Sign-extend, add to the running predictor: `pred += diff`, then
   `c.blocks[off] = pred` (sequential) or `<< Al` (progressive DC-first).

`Da` is updated to the new difference for the next block's context.

### AC decode (Annex F.1.4.4.2)

Per coefficient `k` over the scan band:

1. Decode an EOB decision against the AC stats; on EOB, stop the block.
2. Otherwise decode a run of "coefficient is zero" decisions to reach the next
   nonzero coefficient.
3. Decode sign + magnitude for that coefficient, with the AC stats bin indexed by
   `k` and split at `Kx` (coefficients `≤ Kx` vs `> Kx` use different magnitude
   context bases).
4. Write `c.blocks[off + ZIGZAG[k]]` (`<< Al` in progressive AC-first).

### Progressive arithmetic (Annex G.2)

Same four-way split as the Huffman progressive path, driven by `Ss/Se/Ah/Al`:

- **DC-first:** DC magnitude as above, stored `<< Al`.
- **DC-refine:** one fixed-probability correction bit ORed into the DC coefficient.
- **AC-first:** arithmetic EOB/run/size over band `Ss..Se`, stored `<< Al`.
- **AC-refine:** arithmetic correction bits for existing coefficients + new
  `±(1<<Al)` coefficients, matching the Huffman refine semantics.

Coefficients are stored identically to the Huffman progressive path so `assemble`
dequantizes uniformly.

### Reset semantics

At scan start and after every RST marker: re-`INITDEC` the decoder, `reset()` all
statistics areas (state 0 / MPS 0), and zero each component's `Da`. Restart
cadence is driven by `forEachBlockInScan`, identical to the Huffman path.

## Wiring in `decodeJpeg`

- Accept SOF9 (`0xC9`) and SOF10 (`0xCA`): set `frame.arithmetic = true` and
  `frame.progressive = (marker === 0xCA)`. `Frame` gains an `arithmetic: boolean`
  field. SOF11/13/14/15 remain thrown (deferred to B/C).
- Parse `DAC` (`0xCC`) into conditioning tables.
- In the SOS branch, when `frame.arithmetic`, call `decodeArithScan(...)` instead
  of `decodeScan(...)`. Everything downstream (`assemble`, color, output) is
  unchanged.

## Test encoder

**`test/helpers/build-jpeg-arith.ts`** — a QM *encoder* (T.81 Annex D:
`INITENC`, `ENCODE`, `RENORME`, `BYTEOUT`, `FLUSH`) plus arithmetic DC/AC and
progressive encode procedures, symmetric to the decoder. It reuses
`buildComponentBlocks` (exported from `build-jpeg.ts`) for the FDCT'd coefficient
blocks — no FDCT duplication; only the entropy stage differs. Emits SOF9/SOF10,
an optional `DAC` segment, and `DRI`/`RSTn` when a restart interval is given.
Options mirror `JpegEncodeOptions` (`width/height/comps/pixels/subsample/
restartInterval/successive`), adding optional non-default `dac` conditioning.

## Test plan

`test/jpeg.test.ts` (unit) and `test/redact-image.test.ts` (acceptance):

1. Arithmetic **sequential** grayscale, RGB (4:4:4), subsampled (4:2:0), CMYK —
   `decodeJpeg(arith)` matches the baseline Huffman decode of the same pixels
   (exact: identical coefficients, different entropy coder).
2. Arithmetic **progressive** grayscale + RGB, spectral selection and successive
   approximation — matches baseline within tolerance.
3. **Restart interval:** arithmetic stream with `DRI`/`RSTn` decodes identically
   to the no-restart stream; a guard asserts the bytes contain `DRI` + `RSTn`.
4. **Custom `DAC` conditioning** (non-default `L`/`U`/`Kx`) round-trips.
5. `decodeImageRgba` — an arithmetic DCT image XObject decodes to RGBA.
6. **Acceptance (redaction):** a partially-covered arithmetic `DCTDecode` image is
   decoded, covered pixels blacked, re-encoded — mirrors the existing
   baseline/progressive redaction tests.
7. **Hybrid reference slot** (`it.skip`) with provenance recipe
   (`cjpeg -arithmetic -outfile ref.jpg input.ppm`) to later drop in a real
   externally-generated arithmetic JPEG, guarding against a shared
   encoder/decoder bug — same pattern as the progressive hybrid slot.

## Risks

The QM coder and exact context modeling are the main correctness risk. A
symmetric in-repo encoder can hide symmetric bugs, so:

- every arithmetic path is validated against the **independent** baseline Huffman
  decode (different entropy coder, same coefficients), not just against its own
  encoder; and
- the skip'd real-reference slot is the intended follow-up guard, to be filled
  with a `cjpeg -arithmetic` fixture.

## Out of scope / follow-ups

- Sub-project B (lossless SOF3/SOF11) — new bd issue, reuses `ArithDecoder`.
- Sub-project C (differential + hierarchical) — new bd issue, depends on A and B.
- Filling the real-reference hybrid fixture slot.

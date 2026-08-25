# JPEG lossless decode (SOF3 Huffman / SOF11 arithmetic)

**Date:** 2026-07-13
**Issue:** aspose-pdf-foss-for-ts-ac6.2 (Sub-project B of the arithmetic / lossless /
differential / hierarchical bundle, ac6)
**Status:** approved — planning

## Context

`decodeJpeg` (`src/jpeg.ts`) decodes baseline (SOF0), extended sequential (SOF1),
and progressive (SOF2) **Huffman** DCT JPEGs, and — after ac6.1 — arithmetic
sequential (SOF9) and progressive (SOF10) DCT via `src/jpegarith.ts`. Every other
coding process throws `UnsupportedFeatureError`.

Issue ac6 wants the remaining processes so those `DCTDecode` images can flow
through **partial image redaction** (decode → destroy covered pixels → re-encode).
The bundle is three sequenced sub-projects, each landing independently and each on
its own satisfying the ac6 acceptance criterion:

- **A — Arithmetic DCT (SOF9/10).** Shipped (ac6.1).
- **B — Lossless (SOF3 Huffman, SOF11 arithmetic).** This document.
- **C — Differential + Hierarchical (SOF5-7/13-15, DHP, EXP).** Depends on A + B.

## Goal / non-goals

**Goal:** decode lossless (Annex H) sequential JPEGs — SOF3 (Huffman) and SOF11
(arithmetic) — to pixel samples, so lossless `DCTDecode` images flow through the
existing redaction / `decodeImageRgba` consumers unchanged. No change to the
public `JpegImage` interface or to any consumer in `raster.ts`.

**Non-goals (deferred to C):** differential (SOF5-7 / SOF13-15), hierarchical
(DHP / EXP). Predictor selection value 0 (used only by differential frames) is out
of scope here.

## Architecture

Lossless is a **predictive spatial pipeline** with no DCT, quantization, or IDCT.
It shares almost nothing with the DCT reconstruction path, so it gets its own
module **`src/jpeglossless.ts`** (parallel to `jpegarith.ts`), exporting
`decodeLosslessScan(...)`.

### Reuse boundaries

- **Huffman entropy (SOF3):** reuses `BitReader`, `buildHuff`, `decodeHuff`,
  `extend`, and the `Huff` type from `jpeg.ts` — these become **exported** (they
  are currently module-private). No behavior change.
- **Arithmetic entropy (SOF11):** reuses `ArithDecoder` from `jpegarith.ts`, plus
  a small refactor (below) to share the DC-difference binary-tree decode.
- **Color / output:** the upsample + interleave + YCbCr / CMYK tail of `assemble`
  is extracted into a shared `combinePlanes(frame, planes, adobe)` helper in
  `jpeg.ts`. Both the DCT `assemble` and the new lossless assemble call it, so
  color handling (Adobe transform marker, grayscale/RGB/CMYK) is identical.

### Sample storage & geometry

Lossless has no 8×8 blocks. `Comp` gains an optional `samples?: Int32Array` — a
full-resolution per-component plane sized `pw x ph`. A new
`setupLosslessGeometry(frame)` allocates these instead of the DCT block store.
`Frame` gains `lossless: boolean`.

Geometry (T.81 A.2): a lossless data unit is one sample, so
`mcusPerLine = ceil(width / maxH)`, `mcusPerColumn = ceil(height / maxV)`; a
component's plane is `pw = mcusPerLine * h`, `ph = mcusPerColumn * v`. For the
common non-subsampled case all sampling factors are 1 and each plane is
`ceil(width) x ceil(height)` padded to MCU bounds.

### Wiring in `decodeJpeg`

- Accept SOF3 (`0xC3`) and SOF11 (`0xCB`): set `frame.lossless = true`,
  `frame.arithmetic = (marker === 0xCB)`, `frame.progressive = false`; call
  `setupLosslessGeometry`. SOF7/15 (differential lossless) remain thrown.
- SOS → `decodeLosslessScan(...)` when `frame.lossless`.
- End → lossless assemble: apply point transform (`sample << Pt`), downshift
  precision to 8-bit output (as the DCT path does), then `combinePlanes`.

## Predictor + reconstruction (shared by both entropy coders)

Per T.81 H.1.2.1, over each component plane. Neighbors: `Ra` = left (x-1, y),
`Rb` = above (x, y-1), `Rc` = above-left (x-1, y-1). Prediction `Px`:

- first sample of scan / of a restart interval: `Px = 2^(P - Pt - 1)`
- rest of the first line: `Px = Ra`; first sample of a later line: `Px = Rb`
- otherwise, by predictor selector `Psv` (SOS `Ss`, 1..7):
  1. `Ra` · 2. `Rb` · 3. `Rc` · 4. `Ra + Rb - Rc` ·
  5. `Ra + ((Rb - Rc) >> 1)` · 6. `Rb + ((Ra - Rc) >> 1)` · 7. `(Ra + Rb) >> 1`

Reconstruct `sample = (Px + Diff) & 0xFFFF`. `Diff` is the only thing that
differs between SOF3 and SOF11.

Interleaved MCU traversal visits each component in an order where `(x-1, y)` and
`(x, y-1)` are always already-decoded (within an MCU the Hi x Vi samples go
row-major; MCUs go left-to-right, top-to-bottom), so raster neighbor lookup from
the plane is always valid. For the tested 1x1 case the traversal is plain raster.

### `readDiff()` — Huffman (SOF3)

`ssss = decodeHuff(r, dcTable)`; then `ssss === 0 → 0`, `ssss === 16 → 32768`,
else `extend(r.receive(ssss), ssss)`. The lossless DC ("DC" = difference) table
is the Huffman table selected by the scan component's Td.

### `readDiff()` — arithmetic (SOF11)

The DC-difference binary tree of F.1.4.4.1, with per-component conditioning
bounds (L/U from DAC, defaults L=0/U=1) and previous-difference context — this is
**identical** to the tree already in `jpegarith.ts`'s `decodeDC`. That tree is
extracted into an exported helper:

```ts
export function decodeArithDiff(
  dec: ArithDecoder, stats: Uint8Array, ctx: Int32Array, si: number,
  L: number, U: number,
): number; // signed difference; updates ctx[si] for the next sample
```

The existing DCT `decodeDC` is rewritten to call it (`lastDc[si] += diff;
blocks[off] = lastDc[si] << Al`) — a no-op refactor guarded by the current arith
tests. Lossless calls the same helper and does `sample = (Px + diff) & 0xFFFF`.

Statistics areas are keyed by DC table number (Td) so components sharing a table
share adaptive bins, matching the DCT arithmetic path. AC statistics are unused in
lossless.

## Restart

Restart interval is in MCUs (in non-interleaved lossless, one sample per MCU). At
each restart boundary:

- re-init the entropy coder (`BitReader.restart()` for Huffman;
  `ArithDecoder.restart()` for arithmetic),
- reset arithmetic statistics + difference context to state 0,
- **reset the predictor to start-of-scan state** — the first sample of the new
  interval uses the `2^(P - Pt - 1)` default, per jpeg-9 behavior.

The encoder mirrors this via a single shared reset rule so the two cannot
disagree. The restart-identity test uses a row-aligned interval so the reset also
coincides with a start-of-line boundary (spec-plausible).

T.81's lossless restart/predictor-reset wording is terse; the jpeg-9
interpretation above is the committed one, paired with the skip'd real-file slot
(below) as the eventual independent check.

## Test encoder

**`test/helpers/build-jpeg-lossless.ts`** — an in-repo lossless encoder,
test-only counterpart to `src/jpeglossless.ts`:

- operates on **raw input samples** (no FDCT — lossless is exact); reuses the
  plane-building / color-conversion structure from `build-jpeg.ts` but skips the
  DCT stage,
- raster prediction (the same shared predictor rules) producing per-sample
  differences,
- Huffman path: fixed canonical table over the SSSS symbols actually used (same
  `fixedHuff` approach as `build-jpeg.ts`); arithmetic path: reuses `ArithEncoder`
  from `build-jpeg-arith.ts` with the DC-difference encode tree,
- emits SOF3 / SOF11, optional DAC (non-default L/U), DRI + RSTn when a restart
  interval is given.

Options mirror `JpegEncodeOptions` (`width/height/comps/pixels/subsample/
restartInterval/precision`) plus `predictor?: 1..7` (default 1) and optional
`dac` conditioning; a `mode: 'huffman' | 'arithmetic'` selector.

## Test plan

`test/jpeg.test.ts` (unit) and `test/redact-image.test.ts` (acceptance). Because
lossless is exact, the oracle is `decodeJpeg(encode(px))` **equals `px` exactly**
(no DCT tolerance):

1. **Huffman lossless** grayscale, RGB (4:4:4), CMYK — exact sample match.
2. **Arithmetic lossless** grayscale, RGB, CMYK — exact sample match.
3. **All 7 predictors** round-trip exactly (a gradient image that exercises
   Ra/Rb/Rc combinations), both entropy coders.
4. **Restart interval:** a lossless stream with DRI/RSTn decodes identically to
   the no-restart stream; a guard asserts the bytes contain DRI + RSTn, both
   entropy coders.
5. **Custom DAC conditioning** (non-default L/U) round-trips (arithmetic).
6. `decodeImageRgba` — a lossless DCTDecode image XObject decodes to RGBA.
7. **Acceptance (redaction):** a partially-covered lossless DCTDecode image is
   decoded, covered pixels blacked, re-encoded — mirrors the baseline / progressive
   / arithmetic redaction tests, for both SOF3 and SOF11.
8. **Real-file slot** (`it.skip`) with a provenance recipe (jpeg-9 `cjpeg` or
   PVRG `pvrg-jpeg -l`, since libjpeg's `cjpeg` cannot emit lossless) to later
   drop in an externally-generated lossless JPEG, guarding against a shared
   encoder/decoder bug.

## Risks

The predictor boundary rules and the restart/predictor-reset semantics are the
main correctness risks. Mitigations:

- lossless is **exact**, so every decode is checked against the known input pixels
  — a strong oracle independent of the coefficient values (only the entropy stage
  is shared encoder↔decoder);
- the skip'd real-file slot is the intended follow-up guard for the restart
  interpretation and the QM/Huffman symmetry.

## Out of scope / follow-ups

- Sub-project C (differential + hierarchical) — depends on this + ac6.1.
- Filling the real-file lossless fixture slot.
- Precision > 12 (kept at 8/12 to match the existing DCT constraint; lossless
  output downshifts 12→8 like the DCT path).

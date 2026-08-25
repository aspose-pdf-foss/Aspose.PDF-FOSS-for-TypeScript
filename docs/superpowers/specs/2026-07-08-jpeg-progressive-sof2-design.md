# Progressive JPEG (SOF2) decode — design

**Issue:** aspose-pdf-foss-for-ts-3ee
**Date:** 2026-07-08
**Status:** approved (brainstorming)
**Discovered from:** aspose-pdf-foss-for-ts-b3b (baseline JPEG / DCTDecode decode)

## Goal

Extend the baseline JPEG decoder (`src/jpeg.ts`, shipped in b3b) to **progressive
DCT (SOF2)** so progressive `DCTDecode` images can be decoded to pixels, blanked,
and re-encoded during partial redaction. Progressive JPEGs currently throw
`UnsupportedFeatureError` at the SOF2 marker and degrade to the pre-existing
whole-image behavior.

Acceptance (from the issue): a partially-covered progressive (SOF2) `DCTDecode`
image is decoded, the covered pixels destroyed, and the image re-encoded; vitest.

## Background: how progressive differs from baseline

Baseline (SOF0/SOF1) codes every block fully in a single scan: DC diff then the
full AC run to zig-zag index 63. Progressive (SOF2) spreads each block's
coefficients across **multiple scans**, so coefficients must **accumulate in a
persistent store before dequant+IDCT**. Each scan header carries:

- **Spectral selection** `Ss..Se` — which zig-zag coefficient band this scan
  codes. DC scans use `Ss=Se=0`; AC scans use `1 <= Ss <= Se <= 63` and are
  always **single-component**.
- **Successive approximation** `Ah`/`Al` — bit-plane refinement. `Ah==0` is the
  *first* scan for a band (values shifted left by `Al`); `Ah!=0` is a *refinement*
  scan appending one lower-order bit.

This yields four entropy procedures: **DC-first**, **DC-refine**, **AC-first**,
**AC-refine**, the latter two with **EOB-run** tracking (a run of blocks whose
current band ends immediately).

## Scope (locked decisions)

- **In scope:** SOF2 progressive DCT, 8-bit precision, 1/3/4 components, chroma
  subsampling, restart markers (DRI/RSTn) — the same feature envelope as the
  baseline decoder, extended to the progressive scan structure.
- **Baseline path refactor:** coefficient storage changes from per-scan-local +
  dequant-during-decode to **per-component persistent, storing raw
  (un-dequantized) coefficients**, with a single dequant→IDCT reconstruct after
  EOI. Baseline and progressive share the reconstruct path. Existing baseline
  tests guard this refactor.
- **Out of scope (filed as follow-ups):**
  - Arithmetic / lossless / hierarchical / differential coding — `ac6`.
  - 12-bit precision — `1hw`.
  - DCT-encoded `/SMask` soft masks — `hu8`.
  These continue to throw `UnsupportedFeatureError` / decline, which the redaction
  path already tolerates by degrading to the pre-existing behavior.

## Approach

### `src/jpeg.ts` changes

**1. Marker walk.** SOF2 (`0xc2`) no longer throws; it parses the frame header
exactly like SOF0/SOF1 and sets `frame.progressive = true`. (SOF1 `0xc1` stays
baseline-sequential.)

**2. Persistent coefficient store.** Allocation moves out of `decodeScan` into a
one-time setup after the first SOF, sized to the MCU-padded block grid
(`bpl = mcusPerLine * c.h`, `bpc = mcusPerColumn * c.v`, `× 64`). Each component
also records its **actual** non-interleaved block extent:

- `blocksPerLine   = ceil(ceil(width  * c.h / maxH) / 8)`
- `blocksPerColumn = ceil(ceil(height * c.v / maxV) / 8)`

Blocks are stored in **natural order**, coefficient `k` at index `ZIGZAG[k]`, as
today — but **raw** (not multiplied by the quant table).

**3. Scan dispatch.** `decodeScan` parses `Ss/Se/Ah/Al` (already located in the
header, currently ignored) and dispatches:

- **Sequential** (`Ss==0 && Se==63 && Ah==0 && Al==0`) → existing full-block
  decode, now writing raw coefficients (no `* q`).
- **Progressive**, by `(Ss==0)` × `(Ah==0)`:
  - **DC-first** (`Ss==0, Ah==0`): `coeff[0] += extend(dcDiff) << Al` with the
    usual DC predictor accumulation.
  - **DC-refine** (`Ss==0, Ah!=0`): read one bit; if set, `coeff[0] |= 1 << Al`.
  - **AC-first** (`Ss>0, Ah==0`): run/size decode over band `Ss..Se`; place
    `extend(receive(size),size) << Al` at `ZIGZAG[k]`; `size==0` means either ZRL
    (`run==15`, skip 16) or **EOB-run** `eobrun = (1<<run) + receive(run)` which
    ends this and the next `eobrun-1` blocks' band.
  - **AC-refine** (`Ss>0, Ah!=0`): walk the band applying **correction bits** to
    already-nonzero coefficients and inserting new `±1<<Al` coefficients per the
    canonical libjpeg/pdf.js refinement algorithm, honoring the running `eobrun`.

**4. MCU traversal.**

- **Interleaved** (any scan with ≥2 components — always a DC or sequential scan):
  iterate MCUs; each MCU visits `c.h * c.v` blocks per component in the padded
  grid, as baseline does today.
- **Non-interleaved** (single-component scan — all AC scans, and single-component
  DC scans): iterate `blockRow = 0..blocksPerColumn-1`,
  `blockCol = 0..blocksPerLine-1`, one block each, addressing the padded grid.

Restart markers reset the DC predictors **and** `eobrun`, then resync the bit
reader (existing `BitReader.restart()`).

**5. Reconstruct.** `assemble` gains a dequantize step: for each block, multiply
raw coefficients by the component's quant table into a scratch block, then run the
**existing** float separable IDCT. Upsampling and color transform are unchanged.

### Integration

No changes outside `src/jpeg.ts`. `src/raster.ts` already routes `DCTDecode`
through `decodeJpeg` (from b3b) and wraps it in `try/catch`; removing the SOF2
throw makes progressive images decode, so `reencodeRedactedImage` blanks and
re-encodes them with no further change.

## Testing (Hybrid strategy)

No real progressive JPEG encoder (cjpeg / ImageMagick / sharp / PIL) is available
in this environment, so the issue's "pre-generated real streams" plan is not
feasible as the primary source. Instead:

### Self-contained progressive encoder (primary)

Extend `test/helpers/build-jpeg.ts` (or add `build-jpeg-progressive.ts`) with a
minimal progressive encoder that emits a configurable scan script with **spectral
selection and successive approximation refined down to bit 0** (so the fully
decoded coefficients equal the baseline-quantized coefficients). It must exercise
every decoder procedure:

- DC-first + DC-refine scans.
- AC-first + AC-refine scans, including an **EOB-run**.
- A multi-component **interleaved DC scan**.
- Chroma subsampling.
- A **restart interval**.

### Cross-validation (neutralizes the shared-bug risk)

For each source bitmap, assert **progressive decode == baseline decode of the same
bitmap** within DCT/IDCT rounding tolerance. Because the baseline encode/decode
pair is independently trusted (shipped in b3b) and refines to bit 0, matching
pixels proves the progressive entropy path reconstructs the same coefficients — an
encoder/decoder shared bug would have to also coincide with the baseline result,
which is implausible for successive-approximation logic.

### `test/jpeg.test.ts` (update)

- Add a `decodeJpeg — progressive` block: grayscale, RGB (4:4:4), subsampled RGB,
  restart-interval, each cross-validated against baseline.
- **Flip** the existing *"throws UnsupportedFeatureError for progressive (SOF2)"*
  assertion — SOF2 now decodes. Keep the arithmetic-coding (SOF9) throw and the
  truncated-stream `PdfParseError` assertions.

### `test/redact-image.test.ts` (update, end-to-end)

- Build a page with a **progressive**-JPEG image XObject placed by a known `cm`,
  redact a partial region, reopen the saved PDF, decode the redacted image, and
  assert the covered pixel box is destroyed while a sampled uncovered pixel is
  preserved (within DCT tolerance).
- Flip the b3b *"progressive-JPEG under partial coverage throws
  `UnsupportedFeatureError`"* assertion to success.

### Real-stream slot (secondary, Hybrid)

Leave a documented constant slot and a **provenance recipe** (e.g. `cjpeg
-progressive` / ImageMagick command + source PGM) so one small real reference
stream — with its known source pixels — can be committed as a byte array and
asserted later when a real encoder is available. Not required to close 3ee.

## Documentation

- **README** redaction section: move progressive JPEG from the unsupported list to
  supported — baseline **and** progressive `DCTDecode` images are partially
  redactable (decoded, blanked, re-encoded as DeviceRGB). Remaining DCT
  limitations: arithmetic/lossless/12-bit JPEG and DCT-encoded soft masks
  (follow-ups `ac6`/`1hw`/`hu8`) still degrade gracefully; JPX/JBIG2 undecodable.

## Non-goals

- No arithmetic / lossless / hierarchical / 12-bit JPEG (`ac6`, `1hw`).
- No DCT `/SMask` decode (`hu8`).
- No change to `ImageInfo.Decode()` DCT passthrough, extraction, or `Save` (original
  JPEG bytes preserved when an image is not redacted).
- No new runtime dependencies (`node:` built-ins only; the encoder lives in
  `test/helpers/`).

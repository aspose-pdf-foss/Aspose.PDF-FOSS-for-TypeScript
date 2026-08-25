# JBIG2Decode image decode — Design

**Issue:** `aspose-pdf-foss-for-ts-8t9`
**Date:** 2026-07-14
**Status:** Approved

## Goal

Decode JBIG2 (`JBIG2Decode`) images embedded in PDF image XObjects to 1-bit
samples, so `ImageInfo.Decode()` returns pixels (today it throws
`UnsupportedFeatureError`) and `ToImage` / `ToSvg` render JBIG2 images. This is
the last undecodable image filter; landing it means `Image.Decode()` covers
every PDF image codec.

## Scope

**In scope** — JBIG2 **embedded (PDF) organization** only (sequential segment
headers, no file header / random-access table):

- **Generic regions** — arithmetic coding (generic templates GB0–GB3, with
  TPGDON typical-prediction), and **MMR (Group-4)** coding via the existing
  `decodeCcitt` engine.
- **Symbol dictionaries** — arithmetic coding.
- **Text regions** — arithmetic coding; referenced symbols composited onto the
  region bitmap (strips, S/T coordinates, per-region combination operator).
- **`/JBIG2Globals`** — shared segments (typically a global symbol dictionary)
  parsed and made available to the embedded stream's region segments.
- **Page composition** — region bitmaps combined onto the page bitmap using the
  page default pixel value and the segment combination operator (OR default).

**Out of scope → `UnsupportedFeatureError`** (naming the specific segment
type / flag), decided per segment so a known-but-unimplemented feature is
explicit, never a crash:

- Halftone region + pattern dictionary.
- Generic **refinement** region.
- Symbol-dictionary refinement / aggregate coding (`REFAGG`).
- Text-region refinement (`SBREFINE = 1`).
- **Huffman-coded** regions of any type (standard tables or custom table
  segments). Virtually all PDF-embedded JBIG2 (scanner output, `jbig2enc`) is
  arithmetic-coded.

**Malformed structure** (truncated segment, impossible dimensions, dangling
referred-to segment) → `PdfParseError`.

## Architecture

A new decoder split across five focused modules, mirroring the JPX split. It
**reuses** the existing MQ arithmetic decoder (`jpxmq.ts`) and the existing
CCITT Group-4 engine (`ccitt.ts`) — no new arithmetic-coder code.

| Module | Responsibility |
|---|---|
| `jbig2.ts` | Public entry `decodeJbig2(data, globals, width, height)`. Segment-header parsing (T.88 §7.2), embedded sequential organization, referred-to-segment resolution, page-info handling, page bitmap assembly + composition, final 1-bpp packing. Orchestrator. |
| `jbig2arith.ts` | Arithmetic **integer** decoding procedures `IADH, IADW, IAEX, IAAI, IADT, IAFS, IADS, IAIT, IARI, IARDW, IARDH, IARDX, IARDY` and the symbol-ID decoder `IAID` (T.88 Annex A), built on the reused `MqDecoder`. |
| `jbig2generic.ts` | Generic region decode: arithmetic (GB0–GB3 templates + TPGDON) and MMR (delegates to `decodeCcitt`). |
| `jbig2symbol.ts` | Symbol-dictionary decode → ordered array of symbol bitmaps (height-class walk). |
| `jbig2text.ts` | Text-region decode: place referenced symbols onto the region bitmap (strip walk, S/T advance, transposition, combination op). |

### Reused engines

- **`jpxmq.ts` `MqDecoder`** — JBIG2's arithmetic coder (T.88 Annex E) is the
  same MQ coder as JPEG 2000's (T.800 Annex C). The `MqDecoder(data, start, end)`
  + `decode(cx, i)` interface with per-context `Int8Array` state
  (`index<<1 | mps`) is used directly. Each JBIG2 arithmetic procedure allocates
  its own context array sized to its template/procedure.
- **`ccitt.ts` `decodeCcitt`** — MMR-coded generic regions are Group-4. They are
  decoded with `{ k: -1, columns: regionWidth, rows: regionHeight,
  blackIs1: true, byteAlign: false, endOfBlock: false }`, producing the region
  bitmap.

## Data flow

1. **Dispatch** — `image.ts` `Decode()` detects the `JBIG2Decode` terminal
   filter, resolves `DecodeParms/JBIG2Globals` (an indirect stream, decoded to
   bytes if present), and calls
   `decodeJbig2(embeddedBytes, globalsBytes | undefined, Width, Height)`.
2. **Parse** — parse the globals segments first (if any), then the embedded
   stream's segments, in order. Each segment header yields: segment number,
   type, referred-to segment numbers, and data length.
3. **Accumulate** — symbol-dictionary segments decode to symbol-bitmap arrays,
   stored keyed by segment number; text/generic region segments resolve their
   referred-to symbol dictionaries, decode the region bitmap, then composite it
   onto the page bitmap at the region's (X, Y) using the region's combination
   operator.
4. **Page** — the page-info segment sets page dimensions (expected to equal the
   PDF image `Width`/`Height`) and the default pixel value.
5. **Pack** — serialize the page bitmap to **1-bpp, MSB-first, each row padded
   to a byte boundary** (standard PDF image sample layout). JBIG2 uses
   `1 = black`; PDF 1-bpc DeviceGray treats `0 = black` under the default
   `[0 1]` decode, so the packed output is **bit-inverted** before return
   (matches pdf.js `Jbig2Stream`). The inverted, packed bytes are the decoded
   sample data `Decode()` returns.

## Error handling

- `PdfParseError` — truncated / structurally invalid segment stream, impossible
  region or symbol dimensions, unresolved referred-to segment.
- `UnsupportedFeatureError` — an out-of-scope segment type or coding flag,
  message naming the specific feature (e.g. `"JBIG2: halftone region
  (segment type 20) not supported"`, `"JBIG2: Huffman-coded text region not
  supported"`).
- The decoder is pure and side-effect free: it reads the input bytes and returns
  new sample bytes. A throw mutates nothing in the document model, consistent
  with the rest of the image-decode path.

## Testing

- **Unit — integer arithmetic decoders (`jbig2arith.ts`):** decode hand-authored
  MQ-encoded vectors. A tiny MQ **encoder** helper in `test/helpers/` (the
  encode counterpart of `MqDecoder`) generates the vectors, giving
  encode→decode round-trips for each `IAx` procedure and `IAID`.
- **Unit — segment-header parse (`jbig2.ts`):** hand-built segment-header blobs
  cover short/long form, referred-to-segment count encodings, and page-
  association sizes.
- **Unit — generic region:** small round-trip via a minimal arithmetic
  generic-region encoder helper (or an offline fixture) exercising GB0 template
  and TPGDON.
- **End-to-end:** JBIG2 streams minted offline with `jbig2enc` (dev-only,
  provenance documented in the helper), embedded base64 in
  `test/helpers/build-jbig2-pdf.ts`:
  - a generic-region-only image,
  - a symbol-dictionary + text-region image,
  - an MMR-generic image,

  each asserting `Image.Decode()` returns the expected 1-bpp samples (spot-
  checked against the known bitmap), plus a `ToImage` render smoke check
  confirming the page rasterizes.
- **Graceful degradation:** a halftone (or refinement) fixture asserts
  `Image.Decode()` throws `UnsupportedFeatureError` naming the segment type.
- **Docs:** README image-filter note updated (JBIG2 moves from "throws" to
  "decoded", with the arithmetic-only / no-refinement / no-halftone boundary
  stated).
- **Gates:** `npm run typecheck` and `npm test` both green.

## Implementation notes

- **Spec reference:** ITU-T T.88 (JBIG2). Cross-check against pdf.js
  `src/core/jbig2.js` and `jbig2enc` output.
- **Segment types** (T.88 §7.3) touched: 0 (symbol dict), 4/6/7 (text region,
  intermediate/immediate/immediate-lossless), 36/38/39 (generic region),
  48 (page info), 49 (end of page), 50 (end of stripe), 51 (end of file),
  62 (extension). Out-of-scope: 16 (pattern dict), 20/22/23 (halftone),
  40/42/43 (refinement region).
- **Plan decomposition:** ~6–7 tasks, each a `bd` sub-issue under
  `aspose-pdf-foss-for-ts-8t9`, landed TDD: (1) arithmetic integer decoders +
  MQ encoder helper, (2) segment-header parse + orchestration skeleton,
  (3) generic region (arithmetic + MMR), (4) symbol dictionary, (5) text region,
  (6) `image.ts` dispatch + globals + packing/inversion + end-to-end fixtures,
  (7) graceful rejection + README.

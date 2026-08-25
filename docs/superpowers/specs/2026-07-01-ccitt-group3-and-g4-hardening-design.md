# CCITT: Group 3 support + Group 4 hardening

**Issue:** aspose-pdf-foss-for-ts-2qx
**Date:** 2026-07-01
**Status:** Approved

## Goal

Extend `src/ccitt.ts` beyond the current Group 4 (T.6, `K<0`) decoder to cover
the full set of PDF `CCITTFaxDecode` modes, and harden all paths against real
(and malformed) fax data:

- **Group 3 1D** (`K == 0`): pure modified-Huffman run-length rows.
- **Group 3 2D** (`K > 0`): per-line 1D/2D selection via a tag bit.
- **Group 4** (`K < 0`): existing pure-2D path, hardened for EOL/EOFB framing
  and termination safety.

JBIG2 / JPX remain out of scope.

## Context

`decodeCcitt` (Approach A, unified row loop) currently implements G4 only and
throws `UnsupportedFeatureError` for `K >= 0`. Tests
(`test/ccitt.test.ts`) cover V0, horizontal, VR1, and runs < 64 via hand-traced
golden vectors. Run-length and mode tables live in `src/ccitt-tables.ts` and are
already complete (terminating, makeup, extended makeup, all T.6 mode codes) — no
table changes needed.

`Image.Decode` (`src/image.ts`) plumbs `K`, `Columns`, `Rows`, `BlackIs1`,
`EncodedByteAlign` into `CcittParams`. `EndOfLine` and `EndOfBlock` are not yet
plumbed.

## Approach (A): unified row loop with mode dispatch

Keep a single `decodeCcitt` entry point. Extract the per-row body into focused,
independently testable helpers; reuse the already-tested G4 primitives
(`findB1Index`, `readMode`, `readRun`).

### Params & wiring

`CcittParams` gains two fields:

```ts
endOfLine: boolean;   // EOL codes present before lines (PDF EndOfLine; default false)
endOfBlock: boolean;  // honor EOFB to stop (PDF EndOfBlock; default true)
```

`src/image.ts` reads them: `b('EndOfLine', false)`, `b('EndOfBlock', true)`.
All existing callers and tests are updated to supply the two new fields.

### Row-decode helpers

- `decode1DRow(br, columns): number[]` — reads alternating white/black runs via
  `readRun`, starting white, accumulating changing-element positions until the
  row fills `columns`. Used by G3-1D and the 1D lines of G3-2D.
- `decode2DRow(br, ref, columns): number[]` — the current G4 inner loop
  (P/H/V modes via `readMode` / `findB1Index`), extracted verbatim. Used by G4
  and the 2D lines of G3-2D.

Row-packing (changing-elements → packed 1-bpp bytes), `blackIs1` inversion, and
`byteAlign` handling remain in the outer loop, shared by all paths.

### Per-row dispatch

```
K < 0  → decode2DRow(ref = prev line; initial ref = [] i.e. all-white)
K == 0 → decode1DRow
K > 0  → after framing, read 1 tag bit: 1 → decode1DRow, 0 → decode2DRow(prev)
```

The 2D reference line is always the previously decoded line's changing-element
list (initial reference = empty = all white), identical to G4.

### Framing: EOL / EOFB

A `syncLine(br)` step runs at the top of each row iteration:

- Skips fill bits + EOL codes (`000000000001`). When `endOfLine` is true an EOL
  is expected; either way stray/fill EOLs are tolerated defensively (real
  encoders emit them regardless).
- Detects **EOFB** (two consecutive EOLs, T.6) and end-of-data: if `endOfBlock`
  and EOFB is seen → stop. Also stops on genuine end of buffer.
- For `K > 0`, the 1D/2D tag bit is read immediately after `syncLine`.

### Error handling & hardening

- Keep throwing `PdfParseError` on bad codes / truncation, **except** when at
  end-of-data past the last expected row, where decoding stops cleanly.
- **Termination guard:** each row must make forward progress toward `columns`;
  if a decode step fails to advance, throw `PdfParseError` rather than loop
  forever. Row count is capped at `rows` (or a sane bound when `rows <= 0`).
- G4 now tolerates a trailing EOFB (previously would throw when `rows`
  overshot the real row count).

## Testing

New dependency-free encoder helper `test/helpers/ccitt-encode.ts` emits G3-1D,
G3-2D, and G4 streams with options for `byteAlign`, `endOfLine`, and
`endOfBlock`/EOFB. `test/ccitt.test.ts` round-trips encode → decode for:

- runs ≥ 64 (makeup) and ≥ 1792 (extended makeup),
- all 2D modes including pass, VR2/VR3, VL2/VL3,
- `K == 0`, `K > 0` (mixed 1D/2D lines), `K < 0`,
- `byteAlign` on/off, `endOfLine` on/off, EOFB present/absent,
- `blackIs1` inversion.

Existing G4 golden-vector tests remain as a regression anchor. The
`k >= 0 throws UnsupportedFeatureError` test is replaced by real decode tests.

## Out of scope

- JBIG2Decode / JPXDecode.
- Damaged-row recovery beyond clean termination (no `DamagedRowsBeforeError`).
- Changes to `ccitt-tables.ts` (already complete).

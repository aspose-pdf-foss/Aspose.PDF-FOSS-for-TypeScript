# WOFF / WOFF2 → sfnt ingestion

**Issue:** aspose-pdf-foss-for-ts-6al (P3, feature)
**Date:** 2026-07-14

## Goal

Let `Document.AddFont` / `AddFontFile` accept `.woff` and `.woff2` font
containers by unpacking them to a raw sfnt (TrueType/OpenType) in memory, then
feeding the existing parse → subset/embed pipeline unchanged. No new public API
surface, no signature changes, zero new runtime dependencies — decompression
uses `node:zlib` (`inflateSync` for WOFF, `brotliDecompressSync` for WOFF2).

## Non-goals

- No WOFF/WOFF2 *writing*. This is ingestion only.
- No preservation of WOFF metadata/private blocks (ExtendedMetadata, private
  data). They are read past and dropped.
- No variable-font or `hmtx`-beyond-v1 transform support (they don't exist in
  the spec for the affected tables).

## Entry point

Normalization happens in `parseSfnt` (`src/sfnt.ts`), the single choke point
through which every embedding path already flows:

```
parseSfnt(bytes):
  if magic(bytes) in {wOFF, wOF2}: bytes = sfntFromWoff(bytes)
  return new SfntFont(bytes)  // + the existing table-parsing tail
```

The `SfntFont` constructor's current `UnsupportedFeatureError` on WOFF magic
(`src/sfnt.ts:180-181`) is kept as a defensive fallback: unreachable via
`parseSfnt`, but keeps the constructor honest for any direct construction.

`AddFont` / `AddFontFile` (`src/document.ts`) are unchanged — they transparently
gain the new containers.

## Module: `src/woff.ts`

One public export:

```ts
/** Unwrap a WOFF (per-table zlib) or WOFF2 (brotli + glyf/loca transform)
 *  container to raw sfnt bytes. Throws PdfParseError (malformed) or
 *  UnsupportedFeatureError (unsupported transform). */
export function sfntFromWoff(bytes: Uint8Array): Uint8Array
```

Internally three units plus shared helpers.

### 1. WOFF decoder — `decodeWoff1(bytes): Uint8Array`

WOFF is spec-simple and low-risk (per-table zlib, trivially invertible).

- Read the 44-byte header (signature `wOFF`, flavor, length, numTables, …).
- Read `numTables` directory entries, each 20 bytes:
  `tag, offset, compLength, origLength, origChecksum`.
- For each table: slice `[offset, offset+compLength)`. If
  `compLength < origLength` → `inflateSync` (zlib). If `compLength == origLength`
  → stored verbatim. (Spec: a table is stored uncompressed exactly when compLength
  equals origLength.)
- Reassemble via the shared sfnt writer (below), using `flavor` as the sfnt
  version (`0x00010000` glyf, `0x4F54544F` CFF).

### 2. WOFF2 decoder — `decodeWoff2(bytes): Uint8Array`

Four sub-steps.

**a. Header + compact table directory.**
Header: signature `wOF2`, flavor, length, numTables, reserved, totalSfntSize,
totalCompressedSize, versions, meta/priv offsets+lengths. Then `numTables`
variable-length directory entries:

- 1 flags byte: bits 0–5 = known-tag index into the static tag table
  (WOFF2 spec Table 6, 63 entries); index `0x3f` means a 4-byte arbitrary tag
  follows. Bits 6–7 = transform version.
- `UIntBase128` origLength.
- `UIntBase128` transformLength — **present only** when the table has a non-null
  transform (glyf/loca with transform version 0, or any table whose
  transformVersion ≠ the null value for its type). Per spec: for glyf/loca the
  null transform is version 3 and carries no transformLength; for all other
  tables the null transform is version 0 and carries none.

Record for each table: `{ tag, transformVersion, origLength, transformLength }`.

**b. Brotli decompress + slice.**
`brotliDecompressSync` the single stream at
`headerEnd + directoryLength` of `totalCompressedSize` bytes. Walk the
decompressed buffer, slicing each table's bytes in directory order using
`transformLength` when the table is transformed, else `origLength`.

**c. glyf/loca reconstruction — `reconstructGlyf(transformed, indexFormatOut)`.**
For `glyf` transform version 0:

- Parse the transformed glyf header: `reserved(u16), optionFlags(u16),
  numGlyphs(u16), indexFormat(u16)`, then seven sub-stream sizes (u32 each):
  nContourStream, nPointsStream, flagStream, glyphStream, compositeStream,
  bboxStream, instructionStream. Slice the seven sub-streams.
- For each glyph read `numberOfContours` (i16) from nContourStream:
  - `== 0`: empty glyph (no glyf record).
  - `> 0`: simple glyph. Read per-contour point counts from nPointsStream
    (255UShort), then flags from flagStream and x/y deltas from glyphStream via
    the WOFF2 triplet encoding; re-encode as a standard simple-glyph record
    (endPtsOfContours, instructionLength+instructions from instructionStream when
    the bbox/option bits say so, flags, xCoords, yCoords).
  - `< 0` (0xFFFF -1): composite. Copy the composite component records from
    compositeStream verbatim (they're already in sfnt form) up to the
    end-of-components flag; pull instructions from instructionStream if the
    WE_HAVE_INSTRUCTIONS flag is set.
  - Bounding box: emitted from bboxStream when the per-glyph bbox bitmap bit is
    set, else computed from points (simple glyphs) — composites always carry an
    explicit bbox in bboxStream.
- Emit `loca` in the width dictated by `indexFormat`; write `indexFormat` back so
  the caller sets `head.indexToLocFormat` consistently (the reconstructed `head`
  comes from the stream; we overwrite offset 50 to match).

Null transform (glyf/loca transform version 3): both tables pass through the
brotli stream verbatim.

**d. hmtx transform (version 1).**
Reconstruct left-side bearings from the glyph bounding boxes per the spec's
optional hmtx transform. Small, self-contained. Any other non-null hmtx version
→ `UnsupportedFeatureError`.

**e. Reassembly.** Shared sfnt writer, `flavor` as version.

### 3. Shared helpers

- `read255UShort(reader)`, `readUIntBase128(reader)` — WOFF2 variable-length ints.
- `KNOWN_TAGS: string[]` — the 63-entry static table (spec Table 6).
- `writeSfnt(version, tables: {tag, data}[]): Uint8Array` — offset table with
  recomputed searchRange/entrySelector/rangeShift, directory sorted by tag
  ascending, 4-byte-padded bodies, recomputed offsets. Checksums written as 0
  (the parser ignores them, matching `test/helpers/build-sfnt.ts`).
- A small `Reader` mirroring `sfnt.ts` (u8/u16/u32/i16/tag + bounds `need`).

## Error handling

- Unsupported `glyf`/`loca` transform version (not 0 or 3), or unsupported
  `hmtx` version (not 0 or 1) → `UnsupportedFeatureError` with a specific message.
- Truncated stream, brotli/inflate failure, sub-stream length overrun, or a
  directory entry pointing past the buffer → `PdfParseError` with the byte
  offset (matches `sfnt.ts` conventions). `node:zlib` throws are caught and
  re-thrown as `PdfParseError`.
- CFF (OTTO-flavored) WOFF2: no glyf transform present; tables pass through after
  brotli and reconstruction is skipped, feeding the existing CFF path.

## Testing

No woff2 tooling exists on the build host and the repo builds all font fixtures
in code, so fixtures are self-encoded via new test helpers, with two independent
anchors guarding against a self-inverse encoder/decoder bug.

**Helper `test/helpers/build-woff.ts`:**
- `wrapWoff1(sfnt)` — per-table zlib WOFF.
- `wrapWoff2Null(sfnt)` — WOFF2, null transform (glyf/loca verbatim).
- `wrapWoff2Transformed(sfnt)` — WOFF2 with the real glyf transform encoded.

**`test/woff.test.ts`:**
- **WOFF round-trip** — wrap `buildMinimalTtf()`, `buildClosureTtf()`,
  `makeOttoWithCff()`; decode; assert reconstructed sfnt parses and matches the
  source in `numGlyphs`, `cmap`, `advances`, and per-gid `glyphOutline`.
- **WOFF2 null-transform** — same assertions; exercises header/compact-directory/
  brotli/255UShort/UIntBase128.
- **WOFF2 transformed** — outlines/advances match the source **and** match the
  null-transform decode of the same font (independent anchor #1).
- **Golden glyf bytes** (independent anchor #2) — hand-built transformed
  sub-streams for one simple + one composite glyph; assert `reconstructGlyf`
  emits the exact expected `glyf`/`loca` bytes, so an encoder bug can't hide
  behind a matching decoder.
- **End-to-end** — `doc.AddFont(woff2Bytes)` → draw → `Save`; assert the embedded
  subset font stream is valid (mirrors existing embed tests).
- **Errors** — unsupported transform version and truncated stream throw the
  correct typed errors.

**Follow-up (separate issue):** add a real-world `.woff2` regression fixture from
a trusted encoder once woff2 tooling is available on the host, to validate
interop beyond self-encoded fixtures.

## Docs

Update the README font note to list `.woff` / `.woff2` as accepted
`AddFontFile` / `AddFont` inputs (unwrapped to sfnt, then subset/embedded as
usual).

## Files touched

- `src/woff.ts` — new module (decoder).
- `src/sfnt.ts` — call `sfntFromWoff` at the top of `parseSfnt` on WOFF magic.
- `test/helpers/build-woff.ts` — new encoders.
- `test/woff.test.ts` — new tests.
- `README.md` — font-input note.

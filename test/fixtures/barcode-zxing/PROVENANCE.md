# PDF417 and Data Matrix — provenance

What a decoder we did not write said about the symbols `src/pdf417.ts` and
`src/datamatrix.ts` draw. Tests in `test/barcode-zxing.test.ts`; the cases are
`test/helpers/barcode-cases.ts`, shared by the generator and the suite so the
two cannot drift.

An encoder checked only by our own reading of ISO/IEC 15438 and ISO/IEC 16022
is checked against itself: a misread placement rule or a transposed table
produces a symbol that looks right and that no scanner reads. So every case is
handed to a third-party decoder, and the suite holds the encoder to what it
said.

## The decoder

**ZXing core 3.5.3**, Apache-2.0, from Maven Central
(`core-3.5.3.jar`, SHA-256
`8d8064c1636fdaef7189dd9055c7d59950a8940a12f2293956446ec3c109fd82`, checked by
the generator before use), run under `java version "26" 2026-03-17` through
`scripts/BarcodeOracle.java`.

```
npm run gen:barcode-goldens
```

Needs a JDK on `PATH` and network access the first time. Not run by `npm test`.

## The files

| File | SHA-256 | Holds |
|---|---|---|
| `goldens.json` | `c861dc6b1dbd27f1cd0afc7120081e5426b5110991b1241d971fe9d8fc0014f8` | 93 decode goldens and 13 writer goldens |
| `pdf417-ec.json` | `8286661d46ac4ea7beca1590a43511fc358f0faa2ac6a0647aad4aef74c85042` | ZXing's tabulated PDF417 Reed-Solomon coefficients, levels 0–8 (`npm run gen:barcodes`) |

**Decode goldens.** Each case is drawn by our encoder, rendered at 4 pixels a
module with a 10-module margin and read by ZXing's image readers
(`PDF417Reader`, `DataMatrixReader` with `PURE_BARCODE`), with `TRY_HARDER`. A
golden records the SHA-256 of the exact module matrix ZXing was handed, the text
it read and how many errors it corrected. The generator refuses to write one
unless the text equals the input **and the count is zero** — Reed-Solomon would
otherwise quietly correct an encoder bug and the symbol would still decode. A
Data Matrix is also run through ZXing's module-level `Decoder` on the bare
matrix, which must agree with the image reader; that is where its zero comes
from. PDF417 has no public module-level decoder, so its count is the image
reader's `ERRORS_CORRECTED` metadata.

The suite does not run ZXing. It re-encodes each case and requires the matrix
hash to equal the golden's, so a changed hash means the encoder changed and
ZXing must be asked again. **A fence, not a golden to refresh by hand.**

**Writer goldens.** ZXing's decoder stops at the first pad codeword, so the
randomized pads after it are invisible to every decode golden. For 13 short
ASCII inputs ZXing's own Data Matrix *writer* chooses ASCII encodation too, so
its modules must equal ours bit for bit; those hashes pin the pad sequence.

## What the cases cover

PDF417: every compaction path (text sub-modes, shifts and latches, numeric
groups across the 44-digit boundary, byte compaction with and without a
multiple of six, Latin-1 bytes, ECI 26 UTF-8), 1 and 30 columns, all nine EC
levels, and a symbol near the 928-codeword capacity. Data Matrix: all 30 ECC 200
sizes filled exactly and with padding (the suite asserts every size is reached),
digit pairs, upper shift, Base256 with a one- and a two-codeword length, ECI 26,
and `shape: 'any'`.

## What this does NOT cover

- **One decoder.** ZXing is evidence, not conformance; no second reader
  arbitrates. The tables in `src/pdf417data.ts` and `src/datamatrixdata.ts` are
  extracted from ZXing's *encoder* sources at the same tag, so a table error
  shared by ZXing's encoder and decoder would pass. The PDF417 pattern table is
  additionally checked against a property ISO/IEC 15438 states and no
  transcription supplies — each pattern's cluster from its own bar widths.
- **The 144x144 interleave is ZXing's, not ISO's.** ZXing reads 144x144 with
  its error-correction blocks rotated by 8 and fails the literal ISO order; zint
  writes the rotated order by default. libdmtx writes and reads the literal
  order and cannot read our 144x144 symbols. Recorded in `dataMatrixWithEc`.
- **Compaction choices are mostly invisible.** Any compaction that decodes
  passes; only the matrix hash sees which was chosen, and only for inputs a case
  holds. Measured: lowering the numeric threshold from 13 digits to 6 left every
  golden green, since no case has a 6–12 digit run, so a unit assertion in
  `test/barcode-zxing.test.ts` pins it instead.
- **No C40, Text, X12 or EDIFACT encodation**, no PDF417 macro or Compact
  PDF417, no structured append; and nothing about print quality, only module
  geometry.

# Real-world WOFF2 regression fixture — design

Issue: `aspose-pdf-foss-for-ts-da9`. Depends on `6al` (WOFF/WOFF2 ingestion), closed.

## Problem

The WOFF2 tests landed by `6al` (`test/woff.test.ts`) assert against bytes this
repo produced: fixtures from `test/helpers/build-woff.ts`, a null-transform
cross-check, and hand-built golden `glyf`/`hmtx` vectors. That suite cannot see a
shared-convention bug — one where `src/woff.ts` and the test helper agree with
each other and both disagree with the format. `test/fixtures/jpeg/` exists for
exactly this reason on the JPEG side, and it caught a real defect (`parseDAC`
nibble order, `aspose-pdf-foss-for-ts-hof`) that the synthetic round-trip suite
structurally could not.

This adds the same class of guard for WOFF2: bytes from a trusted encoder,
checked in, read back and compared against a known-good sfnt.

## Decisions

### Bytes come from Google's reference encoder, not from the wild

`wawoff2` (npm, 2.0.1, MIT) is the Emscripten build of Google's `woff2`
reference implementation. Encoding a TTF ourselves beats vendoring a downloaded
`.woff2` because it gives us **ground truth**: we hold the exact sfnt the encoder
consumed, so the test can assert what the reconstruction *should* have produced
rather than merely that it parsed.

The encoder is installed one-off and removed. Only its output is committed —
the same shape as the `cjpeg`/magick-wasm/sharp fixtures in
`test/fixtures/jpeg/PROVENANCE.md`. Running the suite needs nothing but the
committed bytes plus `node:zlib` brotli, so the zero-runtime-dependency and
hermetic-test conventions hold.

### The source font is `fonts/LiberationSans-Regular.ttf`

The two small vendored fonts are blind to the hard part of the WOFF2 `glyf`
transform, which splits `glyf` into seven sub-streams:

| Font | Glyphs | Composites | Instructed | `indexToLocFormat` |
|---|---|---|---|---|
| `StandardSymbolsPS.ttf` | 191 | **0** | **0** | 0 (short) |
| `D050000L.ttf` | 226 | **0** | **0** | 0 (short) |
| `LiberationSans-Regular.ttf` | 2620 | 1076 | 1484 | **1 (long)** |

A font with no composites and no hinting never populates `compositeStream` or
`instructionStream`, and short `loca` never exercises the long-`loca` path. The
small fonts are cheap and would leave the trickiest reconstruction code
untested; the ~120–160 KB fixture buys all three dimensions.

Liberation carries a second advantage: **the ground truth is already in the
tree**. The fixture is one new binary compared directly against
`fonts/LiberationSans-Regular.ttf` — no reference sfnt to commit or keep in sync.

### Assertions are layered, and the layers are measured, not assumed

A WOFF2 round-trip is not guaranteed byte-identical to its input. The encoder
recomputes `loca`, may flip `head.indexToLocFormat`, reorders the table
directory, and glyph padding can legitimately differ. So "matches the original"
must be given a precise, empirically established meaning before the test is
written. See "Measurement pass" below.

## Layout

```
test/fixtures/fonts/
  LiberationSans-Regular.woff2   # the fixture
  PROVENANCE.md                  # encoder, command, hashes, measured table partition
test/woff2-real.test.ts          # the tests
```

`test/fixtures/` is where fixtures live (`jpeg/`, `xfdf/`, `unicode/`), so a
test-only artifact goes there rather than into `fonts/`, which is the curated
home of the Standard-14 substitute faces.

### Licence

The fixture is the same OFL-1.1 font as its source, so `fonts/LICENSE-OFL.txt`
already grants it. `PROVENANCE.md` points at that file rather than duplicating
it. `package.json` declares `files: ["dist"]`, so `test/` never enters the
published tarball and these bytes are not redistributed to npm consumers.

## Measurement pass

This runs **first**, and its result determines what the test asserts.

A scratch script (not committed) reconstructs the sfnt through `parseSfnt` and
diffs it against `fonts/LiberationSans-Regular.ttf` table by table, classifying
each table as byte-identical or not and recording the reason for every
deviation.

Prediction, recorded so the outcome can contradict it: `loca` and `head`
(`indexToLocFormat`, `checkSumAdjustment`) differ, `glyf` may differ in padding
only, and the remaining tables survive intact. **The committed test encodes what
the measurement actually shows, not this prediction.** The resulting partition is
written into `PROVENANCE.md` as a table with reasons.

## Tests — `test/woff2-real.test.ts`

| Test | Asserts |
|---|---|
| Parse | `parseSfnt` accepts the fixture; reconstructed table set matches the original's |
| Byte-exact tables | Every table on the measured byte-identical list equals the original's bytes |
| `glyf` structure | All 2620 glyphs: contour counts, point coordinates and flags, composite component records (1076), instruction bytes (1484) |
| `hmtx` | `advanceWidth` and `lsb` for every glyph equal the original's |
| `head` / `maxp` | Field-by-field equality except fields WOFF2 is permitted to recompute |
| End-to-end | `AddFont(.woff2)` → `AddText` → `Save` → `Open`; embedded font program parses and subsets |

Hermetic and skip-free: no network, no optional tooling, no conditional skips.

## Source changes

None planned. If the measurement exposes a genuine defect in `src/woff.ts`, fix
it — that is the fixture earning its keep, as `testimgari.jpg` did.

## Out of scope

**CFF-flavoured (OTF) WOFF2.** A CFF-flavoured file skips the `glyf` transform
entirely and is a distinct path, but the repo vendors no CFF font to encode. A
separate follow-up issue is filed for it rather than expanding scope here.

## Risks

| Risk | Response |
|---|---|
| ~120–160 KB binary in the tree | Accepted; no smaller font provides composite + instruction + long-`loca` coverage |
| Measurement shows wide deviation, degrading the byte-exact and `head`/`maxp` tests toward semantic-only | Acceptable and documented — that would be a fact about the encoder, not a weakened test |
| `wawoff2` must run once on the build host | One-off at authoring time; the suite never needs it again |

## Success criteria

- `test/woff2-real.test.ts` passes against committed bytes, with no network or optional tooling.
- `PROVENANCE.md` records encoder version, exact command, SHA-256 of input and output, and the measured table partition with reasons.
- `npm run typecheck` and `npm test` green.
- Follow-up issue filed for CFF-flavoured WOFF2.

# Font test fixtures — provenance

WOFF2 files from trusted encoders, here to validate `sfntFromWoff` against bytes
it did not produce. See
`docs/superpowers/specs/2026-07-20-woff2-real-fixture-design.md`.

Three fixtures, two encoders, because no single encoder or font covers the
format:

| Fixture | Encoder | Exists for |
|---|---|---|
| `LiberationSans-Regular.woff2` | wawoff2 | the `glyf` transform — composites, hinting, long `loca` |
| `LiberationMono-Italic.woff2` | fontTools | the optional `hmtx` transform, which wawoff2 never elects |
| `NimbusSans-Regular.woff2` | fontTools | CFF-flavoured (`OTTO`) input, which bypasses the transforms entirely |

The WOFF2 tests in `test/woff.test.ts` assert against bytes this repo produced —
`test/helpers/build-woff.ts` fixtures, a null-transform cross-check, and
hand-built golden vectors. That suite cannot see a shared-convention bug, where
`src/woff.ts` and the helper agree with each other and both disagree with the
format. This file is the guard against that class.

---

## LiberationSans-Regular.woff2

**Encoder:** `wawoff2` 2.0.1 (MIT), the Emscripten build of Google's `woff2`
reference implementation. **Installed one-off and removed** — it is not a dev
dependency. Running the suite needs nothing but these bytes and `node:zlib`
brotli, so the zero-dependency and hermetic-test conventions hold. Same shape as
the `cjpeg` fixtures in `test/fixtures/jpeg/PROVENANCE.md`.

**Source:** `fonts/LiberationSans-Regular.ttf`, already vendored here, which is
therefore the ground truth. No reference sfnt is committed beside the fixture —
the test compares against the TTF in `fonts/`.

| File | Bytes | SHA-256 |
|---|---|---|
| `fonts/LiberationSans-Regular.ttf` (encoder input) | 410,712 | `76d04c18ea243f426b7de1f3ad208e927008f961dc5945e5aad352d0dfde8ee8` |
| `LiberationSans-Regular.woff2` (encoder output) | 146,772 | `96354f9eccff91c022e39f790d287a66d33091c381beb014075255a0ba618a74` |

### Command

```js
import { compress } from 'wawoff2';
writeFileSync('test/fixtures/fonts/LiberationSans-Regular.woff2',
  Buffer.from(await compress(readFileSync('fonts/LiberationSans-Regular.ttf'))));
```

### Why this face

It is the only vendored font that exercises the hard parts of the WOFF2 `glyf`
transform, which splits `glyf` into seven sub-streams:

| Font | Glyphs | Composites | Instructed | `indexToLocFormat` |
|---|---|---|---|---|
| `StandardSymbolsPS.ttf` | 191 | **0** | **0** | 0 (short) |
| `D050000L.ttf` | 226 | **0** | **0** | 0 (short) |
| **`LiberationSans-Regular.ttf`** | **2620** | **1076** | **1484** | **1 (long)** |

A font with no composites and no hinting never populates `compositeStream` or
`instructionStream`, and short `loca` never exercises the long-`loca` path. The
two small faces are cheaper but blind to exactly the code most likely to break.

---

## What the encoder actually transformed

Read from the fixture's own WOFF2 table directory. **wawoff2 transforms only
`glyf` and `loca`** — every other table, `hmtx` included, is stored with the
null transform and merely brotli-compressed:

| Table | Stored as | Sizes |
|---|---|---|
| `glyf` | **transformed** | 269,328 → 237,802 |
| `loca` | **transformed** | 10,484 → 0 (rebuilt from `glyf`) |
| all 17 others | null (untransformed) | unchanged |

This matters, and it was not obvious: the WOFF2 `hmtx` transform is *optional*,
and this encoder declined it. `reconstructHmtx` is therefore never called for
this fixture. Discovered by mutation testing — corrupting every reconstructed
advance in `reconstructHmtx` left the whole suite green, which is what prompted
reading the directory flags. See "Not covered" below.

## Measured round-trip — what "matches the original" means

A WOFF2 round-trip is **not** byte-identical by construction, so the meaning was
established by measurement before the assertions were written. Reconstructed
sfnt: 487,456 bytes, from a 410,712-byte original. **No table is dropped or
added** — the rebuilt table set equals the original's exactly.

| Table | Result | Reason if differing |
|---|---|---|
| `FFTM` | identical | |
| `GDEF` | identical | |
| `GPOS` | identical | |
| `GSUB` | identical | |
| `OS/2` | identical | |
| `cmap` | identical | |
| `cvt ` | identical | |
| `fpgm` | identical | |
| `gasp` | identical | |
| `hhea` | identical | |
| `hmtx` | identical | |
| `kern` | identical | |
| `maxp` | identical | |
| `name` | identical | |
| `post` | identical | |
| `prep` | identical | |
| `glyf` | **differs** | 269,356 → 266,882 bytes. Re-encoded, not corrupted — see below |
| `head` | **differs** | Bytes 8–11 (`checkSumAdjustment`) and 16–17 (`flags`) only |
| `loca` | **differs** | Offsets follow the re-encoded `glyf`. Length and format unchanged |

`test/woff2-real.test.ts` locks this partition: a table that survives intact
today must keep surviving intact, and one that legitimately differs is asserted
structurally instead.

### `head` — one bit, and it is required

`head.flags` goes `0x001f` → `0x081f`. The xor is `0x0800`, **bit 11**, which
the WOFF2 spec requires a decoder to set: it marks font data that has been
through a transform that is lossless in semantics but not in bytes. Setting it
is correct behaviour, not drift.

`checkSumAdjustment` is recomputed, as any re-serialization must.

`indexToLocFormat` is **preserved** (1 → 1), and `loca` stays 10,484 bytes.
The test therefore asserts equality on it rather than masking it, and asserts
`flags` equals the original *or*'d with `0x0800` rather than masking the field —
so any other flag bit changing would still fail.

### `glyf` — re-encoded, semantically identical, and now compact

The difference is entirely re-encoding. Verified across all 2620 glyphs:
**0 mismatched outlines, 0 mismatched composite component lists, 0 mismatched
instruction streams.**

The WOFF2 transform discards `glyf`'s compact encodings, so reconstruction must
choose them afresh. It originally did not, emitting every coordinate as `int16`
and every flag byte individually — 346,100 bytes, 28% over the original. Fixed
in `-8me`; the measured baseline and the result:

| | simple glyphs | points | x short-form | y short-form | REPEAT runs | `glyf` |
|---|---|---|---|---|---|---|
| original | 1529 | 35,285 | 21,216 | 17,430 | 2,050 | 269,356 |
| reconstructed, before | 1529 | 35,285 | **0** | **0** | **0** | 346,100 |
| reconstructed, after | 1529 | 35,285 | 21,222 | 17,441 | 2,051 | **266,882** |

The rebuild now lands slightly *under* the original: wawoff2's source leaves six
x deltas and eleven y deltas long that fit a byte. So the test asserts our counts
are a floor over the original's rather than equal to them.

This mattered beyond the fixture: `src/subset.ts` copies glyph bytes verbatim, so
a PDF embedding a WOFF2-sourced font carried the inflated `glyf`.

---

## LiberationMono-Italic.woff2

Here for exactly one reason: the **`hmtx` transform**, which the wawoff2 fixture
above cannot reach. Tests in `test/woff2-hmtx-real.test.ts`.

**Encoder:** `fontTools` 4.63.0 (MIT), which unlike wawoff2 will elect the `hmtx`
transform on request. **Installed one-off and removed** — via an embeddable
Python 3.12.8 unpacked in a scratch directory and deleted afterwards, so nothing
was installed on the machine and the zero-dependency convention holds.

**Source:** `fonts/LiberationMono-Italic.ttf`, already vendored, which is the
ground truth the test compares against.

| File | Bytes | SHA-256 |
|---|---|---|
| `fonts/LiberationMono-Italic.ttf` (encoder input) | 281,536 | `605c01c711b44480a7508d349dfbf3264e81fa43d69e61cfa7d10b86e764c4d1` |
| `LiberationMono-Italic.woff2` (encoder output) | 112,064 | `27d410edab53bcce786c0e0cdf4d405fd1f393fb0eef599adffa1b1cc3ad71ba` |

### Command

```py
from fontTools.ttLib.woff2 import compress
compress('fonts/LiberationMono-Italic.ttf',
         'test/fixtures/fonts/LiberationMono-Italic.woff2',
         transform_tables={'glyf', 'loca', 'hmtx'})
```

Confirmed in the output's own table directory: `glyf(v0) hmtx(v1) loca(v0)`. The
test asserts this directly, so an encoder that silently stopped electing the
transform would fail rather than quietly reduce the fixture to a duplicate.

### Why this face

The transform has **two** optional arrays — the proportional left side bearings
and the trailing ones for glyphs past `numHMetrics` — and only a font with
`numGlyphs > numHMetrics` exercises the second. Across all 14 vendored faces only
the two Mono Italics qualify:

| Font | numGlyphs | numHMetrics | trailing glyphs |
|---|---|---|---|
| every other vendored face | — | equal | **0** |
| `LiberationMono-Italic.ttf` | 2425 | 2423 | **2** |

It is also the smaller fixture (112 KB against 144 KB for Liberation Sans).

Eligibility is not automatic: the transform may omit an lsb array only where
`lsb == xMin` for every glyph. All 14 vendored faces satisfy this, Liberation
Sans included — so wawoff2 declined the transform **by policy, not because the
font was unsuitable**, and no choice of face would have changed that.

### Why an encoder survey came first

Before reaching for a second toolchain, all 35 `.woff2` files on the dev machine
were checked for an encoder that already elects the transform — FontAwesome,
Bootstrap glyphicons, Bootstrap Icons, and the Fira / SourceSerif4 /
SourceCodePro set shipped by rustdoc:

**35 files, 5+ producers, `glyf` + `loca` and nothing else in every one. Zero
elect `hmtx`.** The transform is essentially unused in the wild, which is why it
takes a deliberate `transform_tables=` request to a library that implements it.
(The same survey found zero `OTTO`-flavoured files, which is why `-spv` cannot be
closed by scavenging either.)

### Coverage added

| Dimension | Covered by |
|---|---|
| `hmtx` transform, advances | 2423 advances, byte-identical `hmtx` |
| `hmtx` transform, lsb array omitted and rebuilt from `xMin` | 2423 proportional lsbs |
| `hmtx` transform, trailing lsb array omitted and rebuilt | 2 trailing glyphs |
| `glyf`/`loca` transform from a **second, independent encoder** | outline and cmap assertions |

Verified **load-bearing, not merely green** — the tests passed on the first run,
so each branch was confirmed by breaking it and watching the suite go red:

| Mutation to `reconstructHmtx` | Result |
|---|---|
| every advance `+ 1` | caught |
| lsb-absent branch yields `0` instead of `xMin` | caught |
| trailing-absent branch yields `0` instead of `xMin` | caught |

The first of those is the exact mutation that **survived the entire suite** when
`-p6p` was filed. It no longer does.

### Outcome

Like the wawoff2 fixture, this one exposed **no correctness defect**:
`reconstructHmtx` was already right, and is now proven right against bytes we did
not produce. Its value is that the proof exists.

---

## NimbusSans-Regular.woff2

CFF-flavoured (`OTTO`) WOFF2. A CFF font has no `glyf`/`loca`, so the transform
machinery is bypassed completely: every table is brotli-compressed and passed
through, and the `OTTO` flavour has to survive `writeSfnt`. Tests in
`test/woff2-cff-real.test.ts`.

This is also **the repo's first real CFF font of any kind**. Every other CFF
assertion in the tree runs on bytes `test/helpers/build-cff.ts` produced.

**Encoder:** `fontTools` 4.63.0 (MIT), one-off embeddable Python, removed after.

**Source:** `NimbusSans-Regular.otf` from
[ArtifexSoftware/urw-base35-fonts](https://github.com/ArtifexSoftware/urw-base35-fonts)
(`fonts/`, branch `master`) — the same upstream `fonts/D050000L.ttf` and
`fonts/StandardSymbolsPS.ttf` already come from.

Unlike the other two fixtures the ground truth is committed **beside** the
fixture, because the repo vendors no CFF counterpart to compare against.
`fonts/` was deliberately not used: it holds the Standard-14 substitute sources
that feed `scripts/gen-std14-fonts.mjs`, is documented as all-TrueType, and has
its own `SHA256SUMS.txt`.

| File | Bytes | SHA-256 |
|---|---|---|
| `NimbusSans-Regular.otf` (ground truth + encoder input) | 82,264 | `7c25be4d78155523080ab85b10277150657ff7dabbcad7037bdd536c9b6d0d08` |
| `NimbusSans-Regular.woff2` (encoder output) | 53,552 | `edd4d4b266baffb261824b5aff72d90cee6468f581ad6ac49e692089a4ce264c` |

### Command

```py
from fontTools.ttLib.woff2 import compress
compress('NimbusSans-Regular.otf', 'NimbusSans-Regular.woff2')
```

No `transform_tables=` argument: `glyf`/`loca` are the only transformable tables
by default and a CFF font has neither, so the output carries **zero** transforms.
Asking for `hmtx` explicitly was tried and produced a byte-identical file —
fontTools correctly declines it on CFF, where there is no `xMin` to rebuild lsb
from. The test asserts the zero-transform, `OTTO` shape directly.

### What this face brings

| | |
|---|---|
| glyphs | 855, name-keyed (not CID) |
| local / global subrs | 214 / 215, with 743 `callsubr` and 790 `callgsubr` |
| hinting | 479 `hintmask`, 18 `cntrmask`, 816 stem ops |
| unitsPerEm | 1000 (CFF convention, unlike the 2048 of the TTFs) |

### The differential trap, twice

Both mistakes are recorded because the second is subtle and easy to repeat.

**First:** the outline comparison was written against `SfntFont.glyphOutline`,
which returns `[]` for anything that is not `glyf` ([sfnt.ts:81](../../../src/sfnt.ts)).
It compared empty to empty across all 855 glyphs and passed. Caught only because
a separate non-vacuity guard asserted a real glyph had a non-empty path.

**Second, and the real lesson:** rewriting it against `CffFont.glyphPath` made it
compare fixture to original — but **both sides run through our own interpreter**,
so an interpreter bug corrupts both identically and cancels out. Shifting the
local-subr bias in `cff.ts` left the whole file green. A differential test
between two copies of one font can only validate the *round-trip*, never the
*parser*.

The fix is an assertion against a table the interpreter never reads. A
charstring's control points bound its curves, so the minimum control-point x can
never exceed the glyph's true left extremum — which is exactly what `hmtx` lsb
records:

| | |
|---|---|
| glyphs with outlines | 851 |
| `minX == lsb` exactly | 841 |
| `minX < lsb` (curve-hull slack) | 10 |
| `minX > lsb` | **0**, and mathematically cannot occur |

### Coverage added

| Dimension | Covered by |
|---|---|
| CFF-flavoured WOFF2, zero transformed tables | the fixture shape assertions |
| `OTTO` flavour preserved through `writeSfnt` | the flavour assertion |
| whole-table brotli passthrough incl. `CFF ` | byte-identical over 11 tables |
| `head` bit 11 set even with nothing transformed | the `flags` assertion |
| `cff.ts` charstring interpreter on **real** bytes | the `hmtx` lsb cross-check |

Verified load-bearing by mutation — all four caught:

| Mutation | Caught by |
|---|---|
| `writeSfnt` forced to TrueType flavour | flavour assertion |
| corrupt the passed-through `CFF ` table | byte-identical + outline comparison |
| `cff.ts` local-subr bias `+ 1` | `hmtx` cross-check **only** |
| `cff.ts` global-subr bias `+ 1` | `hmtx` cross-check **only** |

The last two are the point: before the cross-check existed, both survived.

### Outcome

No correctness defect. The CFF WOFF2 path and the charstring interpreter were
both already right; what changed is that a real CFF font now proves it.

---

## NimbusSans-Regular.t1 + NimbusSans-Regular.afm

A **Type 1** font program and its metrics, here to validate `src/type1.ts` and
`src/type1charstring.ts` against bytes this repo did not produce. Tests in
`test/type1-real.test.ts`. See
`docs/superpowers/specs/2026-08-11-type1-fontfile-design.md`.

The synthetic suite (`test/helpers/build-type1.ts`) writes eexec and charstring
encryption that is the exact inverse of what `type1.ts` reads. That pair can
agree with each other and both disagree with the format, which is the class this
directory exists to guard.

**Source:** [ArtifexSoftware/urw-base35-fonts](https://github.com/ArtifexSoftware/urw-base35-fonts)
(`fonts/`, branch `master`) — the same upstream `NimbusSans-Regular.otf` beside
it comes from, which is what makes the second oracle below possible. No encoder
was involved: these are upstream's own bytes.

| File | Bytes | SHA-256 |
|---|---|---|
| `NimbusSans-Regular.t1` | 104,001 | `779a9c820bbe8b470d36e77bcf949eef7bf1b889184274ba0f51da4c8c883cfa` |
| `NimbusSans-Regular.afm` | 116,120 | `ed4ead49b4d090c80c1d4a8d771879153a41af262d331168dd2635508634cfa1` |

### Command

```bash
curl -sL -o NimbusSans-Regular.t1 \
  https://raw.githubusercontent.com/ArtifexSoftware/urw-base35-fonts/master/fonts/NimbusSans-Regular.t1
curl -sL -o NimbusSans-Regular.afm \
  https://raw.githubusercontent.com/ArtifexSoftware/urw-base35-fonts/master/fonts/NimbusSans-Regular.afm
```

### Shape of the file

PFA-framed with a **binary** eexec section — not PFB, and not hex:

| | |
|---|---|
| header | `%!PS-AdobeFont-1.0: NimbusSans-Regular 1.00` |
| `eexec` at | offset 890, followed by `\r` then binary |
| trailer | the conventional 512 zeros + `cleartomark` |
| `/lenIV` | **absent** — the default 4 applies |
| charstrings | 855, including `.notdef` |
| `/Subrs` | 5 |
| `unitsPerEm` | 1000 |

This maps onto a PDF `/FontFile`'s `/Length1`/`/Length2`/`/Length3` without
re-encoding, so the same bytes serve both the bare-program and the embedded
case.

**The glyph order is the point.** This face lists `/A` first and `/.notdef`
**last**, at index 854. Type 1 has no glyph-id space at all, so any reader
carrying over the CFF/TrueType convention that gid 0 is `.notdef`, or indexing
the program by character code, is wrong by 854 here. The glyph *name* is the
only route in, which is what `src/encoding.ts`'s Annex D tables exist for.

### Two oracles, neither of which the interpreter reads

1. **`.afm` advances against `hsbw`.** The AFM publishes `WX` for all 855
   glyphs; `hsbw` carries the same number inside the encrypted charstring. This
   is the direct analogue of the `hmtx` lsb cross-check above — the assertion
   that was the *only* one to catch the CFF subr-bias mutations.
2. **Outlines against `NimbusSans-Regular.otf`**, the same design read through
   `cff.ts`'s Type 2 interpreter. The trap recorded above — that a differential
   between two copies of one font validates only the round-trip — does not
   apply, because the two sides run through interpreters that share no code and
   were not derived from each other.

Compared on **contour starts**, not only on bounding boxes. A bounding box turned
out to be far too coarse: a flex is a deliberately shallow curve, so a flex that
fails to assemble leaves seven stray movetos whose extent is nearly identical to
the curve they should have formed. 600+ glyphs agree on contour count and on
every contour's start point to within 2 units.

### Verified load-bearing, not merely green

Everything passed on the first run, so each assertion was checked by breaking
the path it covers. **Three of the eight mutations survived the real-font suite**,
and each survivor is recorded here with the reason — two of them exposed weak
assertions that have since been tightened.

| Mutation | Caught by real font | Caught by synthetic |
|---|---|---|
| `hsbw` no longer moves the pen | **yes** (bbox, minX) | yes |
| `hsbw` sbx/width swapped | **yes** (AFM widths) | yes |
| `255` operand read as 16.16 fixed | **yes** (bbox) | yes |
| `callsubr` biased by 107 (Type 2's rule) | no — see below | yes |
| flex emits one curve instead of two | no — see below | yes |
| flex reference point used as a control | no — see below | yes¹ |
| unknown othersubr drops its arguments | no — see below | yes |
| `/lenIV` forced to 0 | no — see below | yes² |
| `seac` drops the sidebearing correction | n/a — no `seac` in this font | yes¹ |

¹ Survived at first because the test asserted a curve *count* and a zero
sidebearing. Both now assert coordinates with a non-zero `asb`/`sbx`.
² Survived at first in the synthetic suite too, because that test asserted a
segment count; the stale pad bytes are read by `hsbw` as the sidebearing and
width, so the square stays a square in the wrong place. Now asserts coordinates.

### Why the four subr/flex mutations cannot be caught here

Measured from the fixture itself, not assumed. Its five subrs decode as the
standard OtherSubrs helpers:

| Subr | Bytes | Meaning |
|---|---|---|
| 0 | `3 0 callothersubr pop pop setcurrentpoint return` | flex end |
| 1 | `0 1 callothersubr return` | flex begin |
| 2 | `0 2 callothersubr return` | flex middle |
| 3 | `return` | the no-op hint-replacement target |
| 4 | `3 1 3 callothersubr pop callsubr return` | hint replacement |

All **360** `callsubr` calls across 168 glyphs target **subr 4**. Subrs 0–2 are
present but never invoked: **this font contains no flex at all**, and no `seac`
and no `div` either. Hint replacement draws nothing, so biasing `callsubr` turns
the only reachable subr into a no-op and leaves every outline byte-identical.

`/lenIV` is likewise unreachable: the four pad bytes are `00 00 00 00`, and byte
0 is an operator that clears an already-empty stack, so skipping the wrong
number of them changes nothing in *this* font.

### Not covered

Flex, `seac`, `div`, hex-encoded eexec, PFB segment framing, a non-default
`/lenIV`, the `-|`/`|-`/`|` token spellings, and the `/Encoding` precedence
rungs. All of these are **synthetic-only**, and each is proven load-bearing in
the table above. A second real fixture that actually uses flex — most Adobe-
produced Type 1 fonts do, where URW's do not — would close the largest of these
gaps.

### Also covers — glyph advances (`imxw.4`)

The `.afm` now serves a second consumer. `glyphprogram.ts`'s `programAdvance`
reports an advance normalised to 1/1000 em, and the AFM's `WX` column validates
**two independent readers of it**:

| Reader | Source of the advance |
|---|---|
| Type 1 | `hsbw`, out of the eexec-encrypted charstring |
| CFF | the Type 2 charstring's optional width prefix, out of `NimbusSans-Regular.otf` |

The two share no code, and neither reads the AFM — so one oracle covers both
without either being able to cancel out an error in the other. The `.otf` beside
this fixture is what makes the second reader checkable at all.

Mutations confirmed caught by these assertions: dropping the
`* 1000 / unitsPerEm` normalisation, and returning the CFF width operand
directly rather than `nominalWidthX + operand`.

### Outcome

No correctness defect: both oracles passed on the first run against bytes we did
not produce. What they changed is the *test suite* — the bounding-box comparator
and three synthetic assertions were all too weak to detect mutations they were
written to detect, and that was only visible because the mutations were actually
run.

---

## Licence

The two Liberation fixtures are the same OFL-1.1 fonts as their sources, covered
by the grant in `fonts/LICENSE-OFL.txt`. `NimbusSans-Regular.{otf,woff2,t1,afm}`
is URW base35 under AGPLv3 + font exception, covered by
`fonts/LICENSE-URW-AGPL.txt` —
already in the repo for the two URW faces in `fonts/`. `package.json` `files` is
`["dist"]`, so none of `test/` enters the published tarball. See
`fonts/SOURCES.md` for the upstreams.

These fixtures are not redistributed to npm consumers: `package.json` declares
`files: ["dist"]`, so `test/` never enters the published tarball.

---

## Coverage

| Dimension | Covered by |
|---|---|
| brotli-compressed table directory from a real encoder | the fixture as a whole |
| `glyf` transform, `compositeStream` | 1076 composite glyphs |
| `glyf` transform, `instructionStream` | 1484 instructed glyphs |
| `glyf` transform, simple-glyph point/flag streams | 1529 simple glyphs, 35,285 points |
| long `loca` (`indexToLocFormat` = 1), rebuilt from `glyf` | the `loca` assertions |
| null-transform passthrough of 17 tables | the byte-identical assertions |
| `head` bit-11 decoder obligation | the `flags` assertion |

### Not covered

**The WOFF2 `hmtx` transform** — closed by the second fixture below.

The `hmtx` assertions here are still load-bearing, just for the null-transform
path: corrupting the passed-through `hmtx` fails both the byte-identical case and
the advance-width case.

**CFF-flavoured (OTF) WOFF2**, which skips the `glyf` transform entirely —
closed by the third fixture below (`-spv`).

### Outcome

This fixture exposed **no correctness defect**. `glyf` reconstruction is exact
across all 2620 glyphs on the first run against bytes we did not produce, which
is a real result given the synthetic suite could not have shown it.

It did expose two things worth tracking, both filed and both since closed:
`glyf` was rebuilt ~28% larger than necessary (fixed in `-8me`, see above), and
the `hmtx` transform had no real-world coverage at all (closed in `-p6p` by the
second fixture below).

Like the CMYK pair in `test/fixtures/jpeg/`, these assertions are a guard rather
than a fix — so they were verified **load-bearing rather than merely green**.
Each was checked by breaking the code path it covers and confirming it fails:
dropping trailing composite components fails the outline and component cases;
corrupting instruction bytes fails the instruction case alone; corrupting a
passed-through table fails exactly that table's case. That discipline is what
caught the `hmtx` gap, which a green suite had been quietly hiding.

---


## `LiberationSans.dfont` — a Macintosh suitcase

**File:** `LiberationSans.dfont`, 1,633,529 bytes,
sha256 `ee86a00a589577892dc65f501d3c24ccb2aa6d8e5c1f8f8fab444d7b32e7436b`.

**Producer:** FontForge 20251009 (git `c41bdb92`), driven by
`scripts/gen-dfont-fixture.mjs` (`npm run gen:dfont`, not run by `npm test`).

**Payload:** the four `fonts/LiberationSans-*.ttf` faces already vendored here
— Regular, Bold, Italic, Bold Italic — unmodified, wrapped into one resource
fork. The suitcase carries two resource types, `sfnt` (4 resources) and `FOND`
(1).

**Deterministic:** FontForge writes identical bytes on every run, verified by
generating twice and comparing sha256, so re-running produces no diff.
`test/dfont-real.test.ts` asserts the hash, because the fixture is produced by
a tool rather than by hand and a FontForge upgrade that changed the container
would otherwise silently rewrite what the assertions are measured against.

### Why this exists

`l1my.6` added `src/dfont.ts` with no real-world fixture. Its unit tests build
suitcases with `test/helpers/build-dfont.ts`, which transcribes the same
section of Inside Macintosh the reader does — the shared-convention class this
directory exists to guard against, where both halves of one understanding
agree and are both wrong. FontForge is a container writer we did not write, so
its resource map is somebody else's reading of the format.

### Why not a real Apple suitcase

`l1my.7` proposed vendoring `Monaco.dfont`, `Geneva.dfont` or `Courier.dfont`
from a macOS `/System/Library/Fonts`. **They cannot be vendored.** Those are
Apple copyright with no redistribution grant — the same objection
`test/fixtures/icc/PROVENANCE.md` records for `RSWOP.icm` — and unlike a
golden *table*, our tests need the BYTES at test time, so it cannot be reduced
to a committed table with the file left out. Every other fixture here is
OFL-1.1 or AGPL+font-exception with its grant in the repo; an Apple system
font would be the only one without one.

Liberation is OFL-1.1, already vendored, and its identity does not matter:
what is under test is the container around the payload, and the payload's own
parsing is anchored by the 14 sfnt fixtures above.

### What it pins, measured

Each mutation was applied to `src/dfont.ts` and BOTH dfont suites re-run, so
the split says what this file ADDS over the builder-anchored one:

| Rule | here | `dfont.test.ts` |
|---|---|---|
| resource count is stored **minus one** | 2 | 7 |
| type count is stored **minus one** | **0** | 9 |
| reference list is based on the **type list**, not the map | 5 | 8 |
| the u24 addresses a **length**, so the sfnt begins 4 bytes on | 2 | 4 |
| faces are selected **by tag**, not by position | **0** | 2 |

### The ceiling — what this does NOT cover

- **Two of the five rules are not anchored here, and no FontForge output can
  anchor them.** It emits `sfnt` as type 0 and `FOND` as type 1, so reading
  the type count raw still yields type 0, and taking type 0 blindly still
  lands on `sfnt`. Both mutations survive this file. `dfont.test.ts` holds
  them alone, and its hand-built suitcases can order the types freely
  *because* they are hand-built.
- **A real Apple suitcase might order its types the other way** — it carries
  `FOND`, and often `NFNT` strikes and `POST` fragments — which is the one
  thing this fixture cannot stand in for. That is now the whole of the
  remaining gap, where before it was the whole rule set.
- **One writer, no second to arbitrate.** The same limit
  `test/fixtures/icc/PROVENANCE.md` records for WCS and
  `test/fixtures/css-selectors/PROVENANCE.md` for Blink. If FontForge and we
  are both wrong about the container in the same way, this file agrees with
  us.
- **No `.suit`**, whose resources live in a true resource fork, so on any
  non-Mac filesystem its data fork is empty or arbitrary — out of scope for
  `dfont.ts` by design.
- **No `.dfont` whose `sfnt` resource is itself a `ttcf`.** `faceIndex` is
  consumed by the container layer before such a payload reaches the collection
  test, so it would need two-level addressing nobody has asked for.

### Licence

Liberation is OFL-1.1, covered by the grant already in
`fonts/LICENSE-OFL.txt`. FontForge is GPLv3+, but only the *tool* is — it
grants no rights over its output, which carries the input's licence, so the
suitcase is OFL-1.1 exactly as its four faces are. `package.json` `files` is
`["dist"]`, so `test/` never enters the published tarball.

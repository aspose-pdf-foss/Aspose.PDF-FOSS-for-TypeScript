# Real-World JPEG Regression Fixtures — Design

**Issue:** aspose-pdf-foss-for-ts-w6m · Real-world JPEG regression fixtures from a trusted encoder
**Date:** 2026-07-17

## Problem

The tree contains no real-world JPEG fixture. A survey of `test/` finds no `.jpg`
file and no embedded base64 blob: `decodeJpeg` is validated entirely against
synthetic fixtures from `test/helpers/build-jpeg.ts` and its arithmetic,
lossless, and hierarchical siblings. The JPEG chain is therefore
self-referential — nothing in it has ever been checked against bytes produced by
a third-party encoder.

The uncovered bug class is the **shared convention**: a marker layout or
component-ordering rule that our decoder and our fixture builder get wrong in the
same direction. A round-trip test against our own decoder cannot see it, because
both halves agree. `docs/superpowers/specs/2026-07-15-jpeg-encoder-design.md`
("Known blind spot") names this and defers it here.

This is not hypothetical. The fixture work below found exactly such a bug on its
first run — see "What this found" — which is the strongest available argument
that the blind spot was real.

## Constraints

Two constraints shaped every decision here, and both are worth stating plainly
because they rule out the obvious approach.

1. **No encoder is reachable.** The npm registry is unreachable from the dev box
   and no ImageMagick / `cjpeg` / Python is installed. The jpeg-encoder spec
   separately rejects taking a `sharp`/ImageMagick dev dependency as cutting
   against the zero-dependency and hermetic-test conventions.
2. **Therefore we cannot choose our fixture content.** We can only vendor JPEGs
   that already exist and are fetchable. This is the key difference from w6m's
   original phrasing, which assumed we could *produce* one JPEG per config.

The consequence is that ground truth cannot be analytic. If we could encode
known synthetic inputs ourselves, the source pixels would *be* the truth. Instead
the truth must be a paired uncompressed original shipped by the same upstream,
and the assertion must absorb real lossy-compression error.

> **Superseded in part (`ehd`, 2026-07-17).** Constraint 1 was half wrong, and
> the half that was wrong mattered. The npm registry became reachable, which
> re-opened the "encode known synthetic inputs ourselves" path this section rules
> out — and as predicted, it *is* strictly better: `synth-*` assert at max error
> 3 and 6, against 34 for the vendored set.
>
> Constraint 1's second clause still holds and was not violated: no `sharp` /
> ImageMagick **dev dependency** was taken. The distinction the original text
> missed is between a dev dep and a **one-off authoring step**. An encoder that
> runs once, emits frozen bytes that get committed, and is then uninstalled
> leaves the suite exactly as hermetic and zero-dep as vendoring does — it is how
> `fonts/` already works, since nobody needs a font compiler to run the tests.
>
> Constraint 2 ("therefore we cannot choose our fixture content") falls with it.
> We chose the content of `synth-gray.pgm` / `synth-rgb.ppm`.
>
> What does *not* change: the vendored set stays, its statistical assertions stay
> correct for it, and generated fixtures catch the same shared-convention class,
> because the property that matters is that the **bytes** are not ours — not that
> the image is. See `test/fixtures/jpeg/PROVENANCE.md`.

## Source

**libjpeg-turbo `testimages/`**, pinned by commit. Three JPEGs of one 227×149
image, plus that image uncompressed:

| File | Size | Frame | Role |
|---|---|---|---|
| `testorig.jpg` | 5,770 B | SOF0 baseline, JFIF APP0, 4:2:0, IDs 1/2/3 | primary baseline fixture |
| `testimgint.jpg` | 5,756 B | SOF0 baseline, 4:2:0 | second encoder config, same image |
| `testimgari.jpg` | 5,126 B | SOF9 arithmetic + DAC, 4:2:0 | arithmetic fixture (green since `hof`) |
| `testorig.ppm` | 101,484 B | P6 227×149 maxval 255 | **ground truth for all three** |

One ground-truth file serving three JPEGs is what makes this affordable: ~118 KB
total for baseline *and* arithmetic coverage.

`testorig.ppm` is the **uncompressed source** libjpeg compressed, not a reference
decode. This was determined empirically, and it is the single most
consequence-bearing fact in this design: our decode of `testorig.jpg` lands at
mean absolute error 1.365 with max 34. A reference *decode* would agree within
~1 LSB (IDCT variance); a max of 34 is lossy-compression loss on high-detail
edges. See "Assertions".

### Why not other sources

- **libjpeg-turbo has no gray, 4:4:4, or CMYK test image.** All three JPEGs above
  are the same 4:2:0 RGB image. Those configs went to `ehd`, which ultimately
  *generated* gray and 4:4:4 with mozjpeg `cjpeg` rather than finding them to
  vendor; CMYK remains open as `66o`.
- `monkey12.jpg` (SOF1, 12-bit, 149×227) is **not** paired with `monkey16.pgm`
  (P5 16-bit *grayscale*, same dims) — the JPEG is 3-component colour, so the PGM
  is not its ground truth. Without a paired original it buys only a smoke test,
  and 12-bit is outside w6m's baseline scope.

### Licensing and placement

Vendored to `test/fixtures/jpeg/` with two files alongside:

- `LICENSE-IJG.txt` — upstream's `README.ijg`, **verbatim**. IJG licence
  condition (1) requires that README be included "with this copyright and
  no-warranty notice unaltered"; copying it byte-for-byte discharges that with
  no judgement call.
- `PROVENANCE.md` — our notes: upstream URL, pinned commit, per-file SHA-256,
  and the source-vs-reference-decode fact. Kept separate precisely so the
  licence file stays unaltered.

This follows established house practice rather than inventing any:

- `fonts/` already vendors 12 Liberation TTFs (~300 KB *each*, dwarfing this
  fixture set) with `LICENSE-OFL.txt` and `LICENSE-URW-AGPL.txt` beside them.
- `test/fixtures/unicode/BidiCharacterTest.txt` is already a committed
  third-party conformance fixture.

Redistribution scope is narrow: `package.json` declares `files: ["dist"]`, so
test fixtures never enter the npm tarball.

Assets are committed directly, with **no generator script**. `scripts/gen-ucd.mjs`
fetches into a gitignored cache because the UCD is versioned data that gets
refreshed; these fixtures are frozen bytes pinned to a commit and must never
change silently — a regression fixture that re-downloads is not a regression
fixture. This matches how `fonts/` vendors.

## Assertions

Because the reference is the pre-compression original, the existing suite's
per-pixel `near(a, b, tol=3)` style **cannot be used** — it would fail on
legitimate lossy error. Assertions are statistical, with headroom over measured
values so that ordinary IDCT refactors don't trip them but any real breakage does.

Measured today:

| Fixture | mean abs err | max | within 2 | within 8 |
|---|---|---|---|---|
| `testorig.jpg` | 1.365 | 34 | 84.16% | 98.21% |
| `testimgint.jpg` | 1.428 | 30 | 82.73% | 98.14% |

Per baseline fixture, assert:

- exact `width` 227, `height` 149, `comps` 3
- mean absolute error `< 2.0`
- ≥ 97% of samples within 8
- max absolute error `≤ 40`
- the flat top-left corner pixel matches the reference **exactly** (`48,47,45` —
  measured exact). A cheap, sharp signal: a flat region has no lossy excuse, so
  a wrong DC, quant table, or component order cannot pass it.
- **cross-check:** the two baseline decodes agree with each other within a tight
  tolerance (same image, different encoder settings)

A statistical bound is a weaker regression signal per-pixel, but it is the right
instrument here: every realistic breakage is gross, not subtle. Swapped component
order, wrong upsampling, or a bad quant table move the mean by tens, not by
tenths — as `hof` demonstrates at mean 112.67 against a threshold of 2.0.

## Structure

- `test/helpers/read-pnm.ts` — minimal P6/P5 reader (ASCII header → `{ w, h,
  max, data }`), mirroring existing helper style. P5 is included for `ehd`'s
  future grayscale use.
- `test/jpeg-real.test.ts` — the fixture tests, kept separate from
  `jpeg.test.ts` so the synthetic surface and the real-bytes surface stay
  distinct and the latter is greppable.
- The arithmetic case lands as a **skipped** test citing `hof`, so the fixture
  and its expected failure are documented in the tree without reddening the suite.

## What this found

`testimgari.jpg` decodes to garbage: mean absolute error **112.67**, max 236,
only 3.11% of samples within 2 — against a baseline decode of the same image at
1.365.

The failure has a precise shape: output is correct for the first **32 pixels**
(exactly 2 MCUs at 4:2:0's 16-pixel MCU width), then diverges; **401 of 504
blocks decode flat**, so AC coefficients are dying while DC roughly survives. It
is not noise (194 distinct values in the first 1000 px).

It is *not* the custom-conditioning path — the file's DAC carries plain T.81
defaults (DC `L=0 U=1`, AC `Kx=5`). The prime suspect is the 3-component
interleaved scan in which Cb and Cr **share** statistics tables (`Cs=2 Td=1/Ta=1`
and `Cs=3 Td=1/Ta=1`); per T.81 the statistics area is per table index and shared
by all components using it. A synthetic fixture that never interleaves three
components with shared tables would never exercise this.

Tracked as **`hof`** (P1), which owns the fix and un-skipping the test.

### Resolution (hof, 2026-07-17)

The suspicion above was wrong in its particulars but right in its class. The
statistics *were* already shared per table index; the actual root cause was one
nibble. `parseDAC` decoded the DC conditioning byte as `L = val >> 4, U = val &
15`, but T.81 B.2.4.3 puts **L in the low nibble and U in the high** one. libjpeg
writes `0x10` for the defaults `L=0 U=1`; we read it as `L=1 U=0`, which
misclassifies the DC conditioning category, so `dc_context` diverges from the
second block onward and the arithmetic decoder desynchronizes for good.

Both of our JPEG builders wrote that byte as `(L << 4) | U` — the *same* swap —
which is why the round-trip suite stayed green: the fixtures never disagreed with
the parser. This is the shared-convention blind spot the spec predicted, landing
in a place nobody was looking. It survived because the DAC marker is optional and
our builders only emitted one for *non-default* conditioning, while libjpeg emits
one on every arithmetic frame.

The pixel-tolerance assertion is a soft check, so the fix was verified against a
much sharper oracle: re-encoding the arithmetic decoder's output reproduces
libjpeg's entire 4,921-byte entropy stream byte-for-byte. The guard against
regression is a direct `parseDAC` unit test in `jpeg.test.ts` asserting the
nibble order against the wire format rather than against our own writer.

## Scope

**In:** vendoring the four files + licence; `read-pnm.ts`; `jpeg-real.test.ts`
with two green baseline tests and one skipped arithmetic test.

**Out:** fixing `hof`. Gray / 4:4:4 / CMYK coverage (`ehd`). 12-bit (`monkey12`).
Any change to `src/`.

**Added later by `ehd`** (same files, same shape): `synth-gray.pgm`,
`synth-rgb.ppm`, `synth-gray-baseline.jpg`, `synth-rgb444-baseline.jpg`, and two
tests in `jpeg-real.test.ts`. `read-pnm.ts`'s P5 support, added here speculatively
for exactly this, is now used.

## Follow-ups

- **aspose-pdf-foss-for-ts-hof** (P1, bug) — `jpegarith.ts` garbage on real
  arithmetic JPEGs; owns the fix and un-skipping the arithmetic test.
- ~~**aspose-pdf-foss-for-ts-ehd**~~ (done, 2026-07-17) — gray and RGB 4:4:4
  landed as `synth-*`, generated rather than vendored once npm became reachable;
  see the note under "Constraints".
- **aspose-pdf-foss-for-ts-66o** (P3, task) — CMYK / Adobe APP14 / YCCK, split
  out of `ehd`. Still the highest-value gap, and still unsolved: `cjpeg` reads
  PPM/PGM/BMP/TGA only, so the generation path `ehd` used does not reach CMYK.

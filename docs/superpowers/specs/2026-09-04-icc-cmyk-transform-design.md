# A real ICC destination-profile transform for CMYK (`85l8.7`)

## The gap this closes

`85l8.3` shipped the *seam* — `ConvertColors({ to: 'cmyk', transform })` — not a
transform. Without one, the bundled `rgbToCmyk` is naive maximum-black removal
with no destination profile. Measured against Windows Color System through
`RSWOP.icm` (U.S. Web Coated SWOP), the gap is not marginal:

| sRGB in | SWOP, perceptual | our naive `rgbToCmyk` |
|---|---|---|
| `rgb(128,128,128)` | C 24.8 M 20.9 Y 19.6 **K 35.8** | C 0 M 0 Y 0 K 21.6 |
| `rgb(200,100,50)` | C 11.0 M 73.6 Y 88.3 K 1.8 | C 0 M 50 Y 75 K 21.6 |
| `rgb(0,255,0)` | C 63.9 M 0 Y 100 K 0 | C 100 M 0 Y 100 K 0 |

The naive transform puts no ink in three channels for a mid grey where SWOP
uses all four, and its idea of green is 36 points of cyan away from the
profile's. That is wrong ink on press, which is what the epic set out to fix.

## Scope

**In:** reading an ICC v2 output profile and building a `CmykTransform` from
its `B2A` tag — the composition sRGB → PCS → CMYK, with the rendering intent
selectable.

**Out, and each deliberately:**

- **v4 profiles** (`mAB `/`mBA ` lutAtoB/lutBtoA, `para` curves). Our fixture
  and every profile on the dev machine are v2. A v4 profile is *declined*, not
  mis-read — `UnsupportedFeatureError` from the factory, before anything
  converts.
- **Absolute colorimetric.** It is relative plus a white-point adaptation and
  has no `B2A` tag of its own; declined for now.
- **Black point compensation.** Off, and documented. It is a policy on top of
  the transform rather than part of it.
- **A2B (CMYK → RGB).** Nothing in this library needs it. Note the *fixture*
  work below does not need it either — WCS reads the profile, we do not.
- **Any change to `colorspace.ts`.** It resolves an ICCBased space through
  `/N` and `/Alternate` and is shared with `paths.ts`, `raster.ts` and
  `text.ts`; widening it to render through real profiles is a different issue
  with four consumers.

## Design

### Where it plugs in

`85l8.3` already threads a `CmykTransform` to every leg — content operators,
inline images, image samples, shading functions, mesh vertices, annotation
colours. So this issue adds **no plumbing at all**:

```ts
import { iccCmykTransform } from '@asposefoss/pdf';
doc.ConvertColors({ to: 'cmyk', transform: iccCmykTransform(profileBytes) });
```

The factory is the primitive. A `profile?: Uint8Array` sugar option on
`ConvertColorsOptions` is *not* proposed: it would be a second spelling of one
call, and the caller who has profile bytes can pass the factory's result.

The factory runs **before** any conversion, so a profile it refuses leaves the
document byte-identical — the rule `checkTarget` and `checkTransform` already
follow.

### Modules

Three pure leaves, none importing `Document`, `Page` or any PDF object module,
mirroring the `type1.ts` / `type1charstring.ts` split:

- **`icc.ts`** — the container. Header fields (size, version, class, data
  colour space, PCS, `acsp` signature) and the tag table. Knows nothing of
  transforms.
- **`icclut.ts`** — the pipeline elements a `B2A` tag is built from: `curv`
  curves, the 3×3 matrix, the CLUT, and interpolation. Knows nothing of
  colour spaces or intents.
- **`icctransform.ts`** — the composition. sRGB → PCS, PCS → CMYK, intent
  selection, and `iccCmykTransform`.

### The source half needs no profile

Our input is always the sRGB triple `rgbPivot` produces, and sRGB is defined by
a specification rather than by a file — so the source leg is the published sRGB
TRC and matrix, written out, not parsed from `srgb.ts`. That keeps the whole
feature dependent on exactly one profile: the caller's destination.

PCS is then XYZ (D50-adapted, per ICC), converted to Lab when the destination
says `Lab ` — which `RSWOP.icm` does, and which is the common case for output
profiles.

### The two encodings that are silently wrong when reversed

- **How Lab reaches the LUT's input range.** ⚠️ **This section was WRONG as
  first written, and the implementation corrected it — see
  `src/icctransform.ts`.** It said L\* 100 arrives as `0xFF00` because ICC v2
  stores Lab in a legacy encoding with that full-scale point, and cited a
  spike measurement for it. The citation was a misread: white had come back
  `0.5000`, which inverts to an encoded **1.0**, and I wrote `0.4984`.
  Measured properly against the goldens, **L\* 100 arrives at the full input
  range**, while **a\*/b\* do use the legacy `(v + 128) × 256` over 0..0xFFFF**
  — an asymmetry that reads like an inconsistency and is what WCS does. The
  `0xFF00` reading for L costs 0.383% on every colour, proportional to L\*,
  zero at black and worst at white: a uniformly slightly-light document,
  invisible without a reference. Both wrong readings are caught by the golden
  comparison and by no hand-written case, which is the argument for the oracle
  in miniature.
- **`mft2` input/output curve tables** are 16-bit and their *lengths* are read
  from the tag (`inputEnt`/`outputEnt`), while `mft1`'s are fixed at 256 8-bit
  entries. Assuming 256 for both reads `mft2`'s CLUT as curve data.

### Interpolation, and why the fixture makes it exact

CLUT interpolation is 3-in/4-out. Trilinear (8 corners) is the straightforward
reading; littlecms and, presumably, WCS use tetrahedral. The two agree only for
an **affine** CLUT, and differ by small amounts otherwise — so an oracle built
from WCS can demand exact agreement only where the CLUT is affine.

That is a property we can *choose*, because we author the fixture:

- the **affine** fixture profile pins the whole pipeline — curves, matrix,
  encoding, intent selection — to an exact answer, with no tolerance to hide a
  bug in;
- a second **non-affine** fixture pins interpolation itself, with a documented
  tolerance, and is the only place a tolerance appears.

Trilinear is the choice, stated in the source, because it is the one whose
arithmetic can be read off the spec. If a later measurement shows WCS is
tetrahedral and the deviation matters, that is a change with a fixture already
in place to measure it.

## The oracle

Windows Color System (`mscms.dll`) via `OpenColorProfileW` +
`CreateMultiProfileTransform` + `TranslateColors` — a CMS written by neither
us nor the profile's author. `scripts/gen-icc-goldens.ts` drives it through
PowerShell and commits what it said, the arrangement
`scripts/gen-svg-goldens.ts` and `scripts/gen-selector-goldens.ts` already use.
It is **not** run by `npm test`.

**The profile fixture is authored, not vendored.** `RSWOP.icm` is
"Copyright (c) 2000 Microsoft Corporation" with no licence grant, so it cannot
go in the repo — and unlike a golden table, our engine needs profile bytes at
*test* time, so a non-vendorable profile would cost the suite its hermeticity.
We therefore write `test/fixtures/icc/synthetic-cmyk.icc` ourselves and let WCS
read it: it must both *accept* our profile and *agree* with our transform
through it. Two independently written halves against one published format —
`scripts/jbig2-codec.mjs` against `src/jbig2*.ts`, and
`test/helpers/decode-gif.ts` against `src/gifencode.ts`.

### The ceiling, recorded in `PROVENANCE.md` rather than discovered later

- **One CMS, one machine, no second engine to arbitrate.** The same limit
  `test/fixtures/css-selectors/PROVENANCE.md` records for Blink.
- **A profile we authored exercises only what we chose to put in it.** It says
  nothing about Adobe's or Agfa's real profiles — v4 tags, `para` curves,
  matrix-based CMYK, unusual CLUT grids. A dev-only check against `RSWOP.icm`
  covers real-world shapes during development; it is skipped when the file is
  absent and so **cannot report a regression in CI**. Do not read it as
  coverage.
- **Colour errors are silent.** Every rule here is one whose failure renders a
  plausible page, which is why the affine fixture — the one that admits no
  tolerance — is the load-bearing one.

## Delivery

Two children, because the first is verifiable with **no new fixture at all**
and is worth landing on its own:

- **`85l8.7.1` — `icc.ts`, the container.** Header and tag table, checked
  against the sRGB profile already vendored in `srgb.ts`: 3144 bytes, class
  `mntr`, space `RGB `, PCS `XYZ `, signature `acsp`, and its published
  primaries and TRC. No licensing question, no generator, no oracle needed.
- **`85l8.7.2` — the transform.** `icclut.ts`, `icctransform.ts`, the authored
  fixture, the generator and the goldens.

## Acceptance

`ConvertColors({ to: 'cmyk', transform: iccCmykTransform(bytes) })` reproduces
WCS's CMYK through the same profile — exactly for the affine fixture, within a
stated tolerance for the non-affine one — across content operators, image
samples, shading functions and mesh vertices, with `report.cmykTransform`
reading `'supplied'`. A v4 profile, a profile with no `B2A` tag, and a
non-CMYK profile are each declined before anything converts.

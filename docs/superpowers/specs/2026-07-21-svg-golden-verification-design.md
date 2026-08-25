# SVG Transparency Golden Verification — Design

Issue: `aspose-pdf-foss-for-ts-0k7`. Follows `a6i` (render transparency) and its
spec, `2026-07-21-render-transparency-design.md`.

## Problem

`ToSvg` emits `<mask>`, `<pattern>`, `mix-blend-mode` and `isolation="isolate"`
for the transparency constructs, but `test/svg-transparency.test.ts` asserts
markup *shape* only. Nothing checks that a renderer paints that markup the way
the PDF says it should.

Three specific divergences are suspected:

1. **Mask luminosity.** PDF computes luminosity as `0.3R + 0.59G + 0.11B` on
   device values. SVG 1.1 masks default to `linearRGB` colour interpolation, and
   CSS `mask-type: luminance` specifies Rec.709 coefficients. Both the
   coefficients and the working space may differ from ours.
2. **Tiling patterns.** `patternTransform` plus our untransformed device-space
   covering rect is an encoding choice, not a spec-mandated one. Lattice phase
   and clip interaction are unverified.
3. **Group isolation.** Whether `isolation="isolate"` matches PDF transparency
   group isolation semantics is assumed, not demonstrated.

The library takes no runtime dependencies, and its dev dependencies are
TypeScript and vitest only. So the test suite cannot rasterize its own SVG.

## Approach

Move the renderer out of the test run and into a manual generator, following the
existing `gen:fonts` / `gen:ucd` precedent: a script produces committed
artifacts out of band, and the suite consumes them with no new dependency.

The oracle is **a real SVG engine versus our own rasterizer**. `src/raster.ts`
composites blend modes and soft masks directly from the PDF semantics; a browser
composites our emitted markup. These are independent implementations of the same
math, so agreement is evidence and disagreement localizes to one side. This
satisfies the repo rule that a differential test must not run both sides through
the same code.

## Components

### `scripts/gen-svg-goldens.mjs`

Manual, `npx`-only, never added to `devDependencies`. Per fixture:

1. Build the PDF via the `test/helpers/build-transparency-fixtures.ts` builders.
2. `page.ToSvg()`.
3. Rasterize twice — headless Chrome (`npx puppeteer`) and `npx @resvg/resvg-js`.
4. **Cross-check the two engines** using the same two-axis comparison the tests
   use (interior samples ±2/255, whole image within the loose budget). If they
   disagree, write no golden and report the fixture. An engine disagreement is a
   finding in its own right; a golden that freezes one engine's quirk is worse
   than no golden.
5. On agreement, write `test/fixtures/svg/<name>.png` and record provenance.

Chrome must be pinned to sRGB with LCD text disabled so its output is
reproducible.

### `test/fixtures/svg/`

Committed goldens plus `PROVENANCE.md` in the established house style: producer
and version, exact command, SHA-256 of every PNG, and an explicit statement of
what the fixture does **not** cover.

### `test/svg-golden.test.ts`

Per fixture: `page.ToImage()`, decode both PNGs, compare on two axes.

- **Interior samples, ±2/255.** Named sample points inside large flat-color
  regions, where the composite result is a mathematical constant. This is the
  transparency math, and it is immune to antialiasing.
- **Whole image, loose budget.** Per-pixel delta plus a maximum fraction of
  failing pixels, sized to catch gross geometry drift — a mis-phased pattern
  lattice, a mask resolved in the wrong space — without edge antialiasing
  consuming the budget.

### `test/helpers/png-decode.ts`

PNG → RGBA for the test side: `node:zlib` inflate plus PNG unfiltering, mirroring
the logic already in `src/predictor.ts`. `ToImage` returns PNG bytes as well, so
one decoder serves both sides of the comparison.

## Coverage

The seven existing builders map onto the suspected divergences:

| Fixture | Covers |
|---|---|
| `luminositySoftMaskPdf` | luminosity coefficients and working space |
| `tilingPatternPdf`, `tilingPatternOffsetClipPdf`, `strokePatternPdf` | `patternTransform` vs the device-space covering rect, lattice phase, clip interaction |
| `isolatedGroupPdf` | `isolation="isolate"` vs PDF group isolation |
| `constantAlphaPdf` | `ca` / `CA` |
| `blendModePdf(mode)` | separable modes plus the four non-separable modes |

Those builders were written for markup-shape assertions, so some lack wide flat
interiors. Where that is true, add golden-specific builders alongside them in the
same helper file rather than reshaping builders the current tests depend on.

## Scope of fixes

Divergences whose fix is contained to emission in `src/svgrender.ts` — forcing
`color-interpolation` on the mask, adjusting the covering rect — are fixed here.
Anything requiring structural rework becomes its own bd issue referencing the
failing golden. Every divergence is recorded in `PROVENANCE.md` regardless of
which side of that line it falls on.

## Testing

Beyond the goldens themselves, the repo's fixture rule applies: **prove the
assertions load-bearing**. A golden usually passes on first run, and that is not
evidence. Perturb each construct in `svgrender.ts` — wrong luminosity
coefficients, dropped `isolation`, shifted pattern origin — and confirm the
corresponding golden goes red. A golden that cannot fail is not a test.

## Risk

The design's value depends on the goldens staying regenerable. If
`gen-svg-goldens.mjs` bit-rots against a future Chrome, the committed PNGs become
unfalsifiable frozen bytes that no one can reproduce or challenge. Pinning exact
tool versions in `PROVENANCE.md` mitigates this; it does not cure it.

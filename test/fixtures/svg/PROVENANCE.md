# SVG Transparency Goldens — Provenance

Browser-rendered rasterizations of `Page.ToSvg()` output for the transparency
constructs. They exist to answer a question the builders cannot: does a real SVG
engine paint our markup the way `Page.ToImage()` composites it? Our rasterizer
works from PDF semantics and the browser works from our emitted markup, so the
two are independent implementations and agreement is evidence.

## Producer

| | |
|---|---|
| Generator | `scripts/gen-svg-goldens.ts` (not run by `npm test`) |
| Committed bytes from | headless Chrome 150.0.7871.24, via puppeteer 25.3.0 |
| Cross-checked against | `@resvg/resvg-js` 2.6.2 |
| Runner | tsx 4.23.1 |
| Node | v24.16.0 |
| OS | Windows 11 Pro, 10.0.26200 |
| Date | 2026-07-21 |

Command — the packages are installed **without** being recorded in
`package.json`, so the library's dependency tree is unchanged. A later
`npm install` / `npm ci` prunes them; re-run the first line to restore.

```bash
npm i --no-save tsx puppeteer @resvg/resvg-js
npx tsx scripts/gen-svg-goldens.ts
```

Chrome is pinned to sRGB with LCD text and subpixel positioning disabled
(`--force-color-profile=srgb --disable-lcd-text
--disable-font-subpixel-positioning`) so its output is reproducible.

A golden is written only if Chrome and resvg agree (whole-image failing-pixel
fraction within the fixture's budget) **and** both match the hand-computed
ISO 32000-1 §11.3.5.2 probe values. A fixture that fails either gate is listed
under Divergences below instead of being committed.

The budget defaults to 2% and is declared per fixture in
`test/helpers/svg-golden-fixtures.ts`. It is consumed by antialiasing along
colour boundaries, so it scales with a fixture's edge density rather than with
how correct the fixture is: the tiling fixtures cover a 100×100 page in 10×10
cells, putting ~1900 pixels on a boundary, and carry a 25% budget. The probes are
what actually verify those two — a mis-phased lattice would show a cross-engine
`maxDelta` near 255, against the 28 observed.

## Goldens

| File | Size | Cross-engine maxDelta | Fail fraction / budget | SHA-256 |
|---|---|---|---|---|
| `constant-alpha.png` | 200×200 | 1 | 0.0000 / 0.02 | `3dac38dadd70d9781aef1a03812e9f0908ce0b93562a08d88864c7e70a439300` |
| `soft-mask-luminosity.png` | 200×200 | 0 | 0.0000 / 0.02 | `a595cf8c24681b5a7796a42d3ed8f06d18bfc227c93a612c23fef2b816148bc2` |
| `tiling-pattern.png` | 100×100 | 28 | 0.1900 / 0.25 | `85e1925f3b8dbd8ced2d6e9e120de584071cc978c5d75e51445d702f7ba404a0` |
| `tiling-pattern-offset-clip.png` | 100×100 | 28 | 0.0304 / 0.25 | `f33805777e1c782b366666545b5ab29cf8bd4d35e9c7d05cc4453d6aee71fa20` |
| `stroke-pattern.png` | 100×100 | 0 | 0.0000 / 0.02 | `7a7c4da980a38d2109a8c84d5bc90572bc8caf411fb5c9fda62f68568845ea65` |
| `isolated-group.png` | 200×200 | 0 | 0.0000 / 0.02 | `55d091737eabee2f6e0c60d243c02fd44f91b7209980e59981bbada373444913` |
| `non-isolated-group.png` | 200×200 | 0 | 0.0000 / 0.02 | `55d091737eabee2f6e0c60d243c02fd44f91b7209980e59981bbada373444913` |
| `blend-multiply.png` | 100×100 | 0 | 0.0000 / 0.02 | `256a1fcae0010cc60a7355b218a5a1230b27ed975ef34650cfcd342e886e8bd1` |
| `blend-screen.png` | 100×100 | 0 | 0.0000 / 0.02 | `c244e782f09e8eedea47678ca450918da7477641744d389719f43ec68b2d1a7c` |
| `blend-darken.png` | 100×100 | 0 | 0.0000 / 0.02 | `256a1fcae0010cc60a7355b218a5a1230b27ed975ef34650cfcd342e886e8bd1` |
| `blend-lighten.png` | 100×100 | 0 | 0.0000 / 0.02 | `c244e782f09e8eedea47678ca450918da7477641744d389719f43ec68b2d1a7c` |
| `blend-difference.png` | 100×100 | 0 | 0.0000 / 0.02 | `2f1879d2acdea7b43b40f307143f062e5b0636de6d53b43bffa2cdab9b0788b0` |
| `blend-exclusion.png` | 100×100 | 0 | 0.0000 / 0.02 | `2f1879d2acdea7b43b40f307143f062e5b0636de6d53b43bffa2cdab9b0788b0` |
| `blend-luminosity.png` | 100×100 | 0 | 0.0000 / 0.02 | `ab3b1e49f67b26d7e6dea9466c98ff3cf6bf44c995fead9ded05403bdd0e0694` |
| `isolated-blend-group.png` | 200×200 | 0 | 0.0000 / 0.02 | `878cafad82a5ce20bd9a2f62af4f55dcdc1a607ba609e5136c88fd5f1fe3694d` |
| `non-isolated-blend-group.png` | 200×200 | 0 | 0.0000 / 0.02 | `d46f0b2ff7e76b74759cc0ac97ceec6a49139a897db168d1ee6c2d5b6e1cce7b` |
| `nested-clip.png` | 100×100 | 0 | 0.0000 / 0.05 | `cbf3b435050b41f0c0c0c12733522c22676c0165c8eaa23114a82f49134f3d65` |

The 2026-07-22 regeneration that added `non-isolated-group` (`bbu`) rewrote all
sixteen files; the fifteen pre-existing ones came back byte-identical, so their
SHAs are unchanged above. That is the only reproducibility evidence this table
carries — same machine, same pinned engines. `non-isolated-group` shares
`isolated-group`'s exact SHA: same geometry, `/I` absent versus `/I true`, and
the two must render identically because the group has no inner blend.

The later `nested-clip` (`sel`) addition surfaced `cul`: `ToSvg` mirrored every
clip vertically. The fix (device-space leaf geometry — see Covers) rewrote the
representation of every leaf, yet regenerating left all sixteen prior files
byte-identical, which is what shows the change altered how the clip is expressed,
not what any of them renders.

## Divergences

Both were found by the first generator run, and both are now fixed with a golden
committed. Neither is detectable from `ToImage`,
which composites directly and never goes through this markup — which is why
`test/raster-transparency.test.ts` was green throughout. This is exactly the
shared-convention blind spot the goldens were added to find.

### Tiling patterns rendered empty — FIXED

`aspose-pdf-foss-for-ts-85a`. Chrome and resvg agreed with each other and both
disagreed with PDF semantics: every in-cell probe read white, i.e. the pattern
painted nothing. The emitted markup for `tilingPatternPdf` (100-high page, 20×20
cell, 10×10 square at the cell origin) was:

```xml
<pattern id="tile1" patternUnits="userSpaceOnUse" x="0" y="0" width="20" height="20"
         patternTransform="matrix(1 0 0 -1 0 100)">
  <path d="M0 0L10 0L10 10L0 10Z" transform="matrix(1 0 0 -1 0 100)" .../>
</pattern>
```

`paintTiling` walks the cell with `initialState(cellCtm)`, so every captured path
carries the full device CTM; `use.matrix` was then re-applied as
`patternTransform`, landing it twice. The inner flip mapped the square to y
90..100, outside the 20×20 tile box, leaving the cell empty.

Fixed in `svgrender.ts` by wrapping the captured content in the inverse of
`use.matrix`, which returns it to pattern space — where `x`/`y`/`width`/`height`
are measured. The raster backend still needs the device-space CTM, so the
correction belongs in the emitter rather than in `paintTiling`.

### Stroke-shaped clips are ignored — FIXED

`aspose-pdf-foss-for-ts-csi`. Chrome and resvg both painted nothing where
`ToImage` paints blue. To paint a stroke through a pattern, `pagerender` clips to
the stroke outline and fills; `svgrender` emitted that clip as

```xml
<clipPath id="sclip0">
  <path d="M0 50L100 50" fill="none" stroke="#000" stroke-width="20"/>
</clipPath>
```

but per SVG 1.1 §14.3.5 the `stroke` property does not affect a clipping path —
only the child's fill geometry counts, so a zero-area line yields an empty clip.

The fix did not need new geometry after all: the rasterizer already outlined
strokes (joins, caps, dashes, flattened Béziers) to fill them and to build stroke
clip masks. That code moved from `raster.ts` to `src/strokegeom.ts` and both
backends now share it, so `svgrender` emits the outline as ordinary nonzero fill
geometry in device space:

```xml
<clipPath id="sclip0"><path d="M0 60L100 60L100 40L0 40Z"/></clipPath>
```

`stroke-pattern.png` is now committed (`aspose-pdf-foss-for-ts-otk`): both
engines paint the band blue, agreeing with `ToImage` at cross-engine `maxDelta`
0. Restoring the stroked-line `clipPath` puts the fixture back in this section —
see Mutation checks. `test/svgrender.test.ts` keeps its hermetic parse of the
emitted `clipPath` as the fast in-tree guard.

### Non-isolated groups render isolated — FIXED

`aspose-pdf-foss-for-ts-7wg`. Chrome and resvg agree with each other and both
disagree with PDF semantics: `non-isolated-blend-group` probes green at the
group centre and both engines paint cyan, i.e. the group renders isolated.

```
SKIP non-isolated-blend-group: engines agree with each other but not with PDF semantics
    chrome (100,100) expected 0,255,0 (±2), got 0,255,255
    resvg  (100,100) expected 0,255,0 (±2), got 0,255,255
```

`drawFormBody` wraps every form XObject body in a clip for its `/BBox`, which
`SvgSink.addClip` emits as `<g clip-path="url(#id)">`. `clip-path` establishes a
CSS stacking context, and a stacking context isolates — so the group's inner
`mix-blend-mode` composites against the wrapper's transparent backdrop instead
of the page. The wrapper is emitted on the unbuffered path too, so this is wrong
even at group alpha 1 with a Normal group blend, which is the case
`aspose-pdf-foss-for-ts-bbu` describes as exact. `ToImage` is correct there.

Not detectable from `ToImage`, which composites directly and never goes through
this markup — the same blind spot the goldens exist to find.

Fixed in `svgrender.ts`: clips are now attributes on the leaves they clip rather
than wrapper elements. Each clip is defined as a `<clipPath>` chained onto the
enclosing one — SVG intersects a `<clipPath>` with its own `clip-path` — so
nesting composes without any element between a blending leaf and the page.
Regenerating after the fix left the other 14 goldens byte-identical, which is
what shows the change altered representation and not rendering.

## Covers

- ExtGState constant alpha (`ca` / `CA`).
- `/SMask` luminosity soft masks.
- Group offscreen compositing. The `isolated-group` overlap probe is the
  load-bearing one: drawn inline rather than through an offscreen, the two
  squares composite twice and the overlap reads `255,64,64`. Note this verifies
  that the group is composited once — **not** the `isolation` attribute; see
  Mutation checks.
- The six separable blend modes plus `Luminosity`.
- Tiling-pattern fills: lattice phase, `patternTransform` against the
  device-space covering rect, and clip interaction with a cell that lies outside
  the region it fills.
- **Stroke-shaped clips**, and therefore stroke patterns (`stroke-pattern`): that
  the outline emitted as nonzero fill geometry clips where the stroked band is,
  in an engine that follows SVG 1.1 §14.3.5.
- **Non-isolated groups** (`non-isolated-blend-group`): that a group without
  `/I true` lets its contents' blend reach the page backdrop, and that our clip
  markup puts no stacking context in the way. Paired with `isolated-blend-group`,
  which is the same fixture isolated — the two differ only in `/I`, so together
  they discriminate isolation rather than merely exercising it.
- **Unit compositing of a default `/Group`** (`non-isolated-group`): that a
  transparency group with no `/I` key — the spec default, false — still gets an
  offscreen buffer at `ca 0.5`, so its overlapping contents composite once.
  Before `bbu` the buffering predicate required `/I true` and this drew inline,
  reading `(255,64,64)` at the overlap. Paired with `isolated-group`, which is
  the same geometry with `/I true`: the two must agree, which is what makes the
  gating insight (seeding is a no-op without an inner blend) checkable.
- **Offscreen buffering of a group whose contents blend** (`isolated-blend-group`):
  that a real engine confines the inner `mix-blend-mode` to the group rather than
  letting it reach the page. This is what the vp8 renderer fix produces, and
  reverting that fix is caught — see Mutation checks. It does **not** verify the
  `isolation` attribute; that is a separate claim and it failed.
- **Nested-clip intersection** (`nested-clip`): that two clips compose by
  `<clipPath>` chaining and paint only their intersection in a real engine. The
  fixture clips an enclosing left band (user x 0..60) against an inner bottom band
  (user y 0..60); its load-bearing probe sits in the inner-minus-enclosing
  difference, which must be **unpainted** — a concentric inner⊂outer nesting
  could not test this, since dropping the chain would change no pixel. Adding it
  is what exposed `cul` (see below); with the fix in place both engines agree
  with `ToImage` at cross-engine `maxDelta` 0.
- **Device-space clip positioning** (all clip goldens, retroactively). Before
  `cul`, `ToSvg` emitted painted leaves with `transform=CTM` and a `clip-path`;
  because clip-path resolves in the referencing element's user space, the page
  flip was applied to the clip geometry twice, mirroring it vertically. Every
  existing clip golden was blind to it — their clips are flip-symmetric
  (`tiling-pattern-offset-clip`'s user (40..80)² through a period-20 lattice) or
  the leaf was already identity (the tiling covering rect, the outlined stroke
  clip). The fix bakes the CTM into each leaf's `d` (device coordinates, no
  transform) for fills, strokes and the shading covering rect, so their user
  space is the identity and the device-space clip lands where it should; images
  and glyph runs keep their transform and take the clip on an identity `<g>`
  wrapper instead. `nested-clip` is the golden that discriminates it.

## Does NOT cover

- **Isolation** — still, now with a golden that was supposed to cover it and
  demonstrably does not. Removing `isolation:isolate` leaves
  `isolated-blend-group.png` byte-identical under *both* engines, because the
  group's `/BBox` clip wrapper already establishes a stacking context. Nothing
  here discriminates it; verifying it needs a group with no BBox clip. See
  Mutation checks (`aspose-pdf-foss-for-ts-k01`).
- **Distinguishing `Multiply` from `Darken`, `Screen` from `Lighten`, or
  `Difference` from `Exclusion`.** With this fixture's inputs (cs = (1,0,0) over
  cb = 0.5) each pair is mathematically identical, and the committed PNGs within
  each pair are byte-for-byte equal. Swapping a mode for its partner would not be
  detected. Distinguishing them needs a fixture with a non-neutral backdrop.
- **The luminosity coefficients.** `soft-mask-luminosity` uses a pure black-and-
  white mask, where PDF's 0.3/0.59/0.11 and CSS `mask-type:luminance`'s Rec.709
  coefficients agree. It proves the mask is applied in roughly the right place;
  it cannot detect a wrong coefficient set or a linearRGB working space. That
  needs a mid-gray mask fixture.
- **Clipped image/glyph-run blend reaching a non-isolated backdrop.** Because an
  image or glyph run keeps its own transform, its clip rides on an identity `<g>`
  wrapper (see Covers), and that wrapper is a stacking context. So a clipped
  image or text whose `mix-blend-mode` would need to reach a non-isolated group's
  page backdrop is isolated instead — the narrow residue of `cul`'s fix. Fills
  and strokes (the common blended leaves, and the ones `non-isolated-blend-group`
  exercises) stay wrapper-free and are unaffected. No golden covers this residue.
- **Knockout groups in SVG** (`/K true`) — SVG 1.1 has no expression for
  per-element backdrop reset (§11.4.6.2). `ToImage` implements knockout
  (`aspose-pdf-foss-for-ts-076`); `ToSvg` renders a knockout group as an
  ordinary group.
- **Backdrop removal in SVG** for non-isolated groups (ISO 32000-1 §11.4.6).
  `ToImage` implements it (`bbu`); `ToSvg` cannot. Group `opacity` creates a
  stacking context and therefore forces isolation, so a non-isolated group that
  both composites as a unit *and* blends internally has no SVG expression. SVG
  is exact for every other combination, including the common
  `non-isolated-group` case. No golden covers the residue: both engines isolate
  it, so it could only be registered as a SKIP.
- **`Hue`, `Saturation`, `Color` blend modes.** Correct output for these is a
  range rather than a point, so there is no flat-interior probe value that is not
  itself an implementation detail.
- **Any renderer other than Chrome and resvg.** Firefox and Safari are unverified.
- **`ToImage` correctness.** These goldens check that the SVG matches the raster
  backend and the ISO formulas; the raster backend's own conformance is
  `test/raster-transparency.test.ts`.
- **Text, shadings, and images** under transparency. Only vector fills and
  strokes appear in these fixtures.

## Mutation checks

A golden that passes on the first run is not evidence. Each construct was broken
in `svgrender.ts` and the generator re-run; a caught mutation shows up as the
fixture failing its probes under both engines. Every mutation was reverted.

| Mutation | Result |
|---|---|
| Pattern origin shifted by 7 (`x="bbox[0] + 7"`) | **caught** — `tiling-pattern` and `tiling-pattern-offset-clip` both went red, in-cell probes reading white |
| `blendCss` maps `Multiply` → `screen` | **caught** — `blend-multiply` went red |
| `clipToStroke` emits the source path with `stroke-width` again (the original bug) | **caught** — `stroke-pattern` skipped: "engines agree with each other but not with PDF semantics", both painting nothing |
| `groupContentBlends` dropped from `needsBuffer` in `pagerender.ts` (reverts the vp8 fix) | **caught** — `isolated-blend-group` alone went red in `test/svg-golden.test.ts`, both the probe and whole-page assertions; the other 13 fixtures stayed green |
| `isolation` removed from the group | **not caught, by either fixture** — the `/BBox` clip wrapper isolates independently; see below |
| `pushClip` emits a `<g clip-path>` wrapper again | **caught** — `non-isolated-blend-group` skipped, both engines painting the isolated result, plus `tiling-pattern`, `tiling-pattern-offset-clip` and `stroke-pattern`. Broader than the original bug: leaves keep their own `clip-path`, so the content is clipped twice |
| `clipAttrs` returns nothing, so leaves are unclipped | **caught** — 5 hermetic tests red; `tiling-pattern-offset-clip` and `stroke-pattern` skipped |
| `beginOffscreen` lets a capture inherit the active clip | **caught** — the hermetic pattern-cell test red; `tiling-pattern-offset-clip` and `stroke-pattern` skipped, each cell clipped to a region it lies outside |
| `pushClip` stops chaining onto the enclosing clip | **caught** — `chains nested clipPaths` red in-tree, **and** `nested-clip` skipped: "engines agree with each other but not with PDF semantics". Before `sel` added that fixture this was caught only in-tree — the gap `sel` closed |
| `fill` keeps `transform=CTM` instead of baking `d` to device space (reverts the `cul` fix) | **caught** — `nested-clip` skipped under both engines; the leaf's CTM re-applies to the device-space clip and mirrors it. The other clip goldens stay green because their clips are flip-symmetric, which is why `cul` hid until `nested-clip` |

The four rows below are `bbu`, and unlike the rest of this table they are
raster-side: the mutation is in `raster.ts`/`pagerender.ts` and the catch is in
`test/raster-transparency.test.ts` (`ToImage`), not in a browser golden. The
observed values are the interior colour actually read, not the ones the plan
predicted.

| Mutation | Result |
|---|---|
| Backdrop seeding loop dropped in `RasterSink.beginOffscreen` (keep the `groupAlpha` allocation) | **caught** — `§11.4.6` red, interior reads `128,255,128` (the isolated answer: with no seed the inner Multiply sees a transparent backdrop and is a no-op) |
| Removal term forced to `k = 0` in `composeGroup` | **caught** (since `9yk`) — `§11.4.6 fractional group alpha` red, interior reads `223,255,0` vs the correct `191,255,0`. `nonIsolatedBlendGroupPdf`'s probes could not catch it: there the group and backdrop are both opaque (`agn = 1`, `a0 = 1`), so `k = a0/agn − a0 = 0` identically and the formula only does arithmetic where `agn < 1` or `a0 < 1`. `fractionalAlphaRemovalGroupPdf` (group `ca 0.5`, inner square `ca 0.5` → `agn = 0.5`, `a0 = 1` → `k = 1`) supplies the flat interior where the term is load-bearing |
| `groupAlpha` accumulation removed from `Canvas.blend` | **caught** — `§11.4.6` red, interior reads `255,255,0` (the yellow page): `αgn` stays 0, every pixel hits the `agn <= 0` continue and the group contributes nothing |
| `needsBuffer` first conjunct reverted from `isTransparencyGroup` to `isolated` | **caught** — the `absent` and `false` double-darken cases and `§11.4.6` all red, and the `non-isolated-group` golden red under both engines; the `/I true` case stayed green. Broader than predicted: with the blend group no longer buffered it draws inline, so `§11.4.6` catches it too |

The three rows below are `076` (knockout groups), and are likewise
raster-side: the mutation is in `raster.ts`/`pagerender.ts` and the catch is the
`knockout transparency groups` block in `test/raster-transparency.test.ts`. Only
semi-transparent overlaps discriminate knockout — opaque squares read the
topmost element either way — so the probes use `ca 0.5` elements and the merge
must weight by shape (`f_j`), not shape×`ca`.

| Mutation | Result |
|---|---|
| Per-op reset dropped in `RasterSink.beginKnockoutElement` (elements accumulate into the group buffer) | **caught** — isolated knockout overlap reads `128,64,191` (source-over: blue over red) instead of `128,128,255`; the non-isolated case reads `128,64,128` vs `128,128,128` (`076`) |
| Knockout merge weight collapsed from `E.shape` to `E.groupAlpha` (shape → shape×ca) in `endKnockoutElement` | **caught** — the semi-transparent element no longer fully knocks out; isolated overlap reads `191,159,223`, neither knockout (`128,128,255`) nor source-over (`128,64,191`). This is the shape-vs-opacity split of §11.4.8 (`076`) |
| `knockout` removed from `needsBuffer` in `drawForm` | **caught** — the group draws inline and does not knock out; isolated knockout overlap reads `128,64,191` (`076`) |

### `isolation="isolate"` is not verified by `isolated-group`

`aspose-pdf-foss-for-ts-vp8`. Deleting `isolation="isolate"` from `svgrender.ts`
produced a byte-identical `isolated-group.png`, because `isolatedGroupPdf` draws
its group at `ca 0.5` — SVG group opacity below 1 already forces an implicit
stacking context, so the attribute is redundant there. `isolation` only has an
observable effect at alpha 1 with a blend mode inside the group.

Investigating that turned up a renderer bug rather than a fixture gap. The
buffering predicate in `pagerender.ts` tested `gs.blend`, the blend mode in force
*outside* the group when `Do` ran; a blend used inside the group did not appear
in it, so the group drew inline and blended against the page. Isolated and
non-isolated output were measurably identical (`0,255,0` for both, where isolated
should be `0,255,255`). Fixed by `groupContentBlends`, a resource-tree scan that
triggers the offscreen path when a group's contents blend.

`isolated-blend-group` is the fixture that exercises it: an isolated group at
`ca 1.0` whose contents Multiply cyan over a yellow page. Isolated reads
`(0,255,255)`; non-isolated reads `(0,255,0)`.

### …and `isolated-blend-group` does not verify it either

`aspose-pdf-foss-for-ts-otk`, corrected under `aspose-pdf-foss-for-ts-k01`. The
golden is committed, and the prediction above — that a fixture at `ca 1.0` with
an inner blend would make isolation load-bearing — **is wrong**. Removing it and
regenerating produces `isolated-blend-group.png` byte-identical to the committed
one (`878cafad…`) under Chrome *and* resvg.

The first explanation offered here was that both engines isolate any `<g>`
unconditionally. That was also wrong, and a direct probe of the two engines
refuted it. Measured, ten markup variants, Chrome 150 and resvg 2.6.2 agreeing
on every row:

| Markup | Result |
|---|---|
| `style="isolation:isolate"` | isolated |
| `isolation="isolate"` *(presentation attribute)* | **not isolated** |
| bare `<g>`, `opacity="1"`, `isolation:auto`, no wrapper | not isolated |
| `opacity="0.999"` | isolated |
| `<g clip-path="…">` with no isolation at all | **isolated** |

Two separate facts, and each was a bug in what this file previously claimed:

1. **`isolation` is not an SVG presentation attribute.** CSS Compositing defines
   the property but no attribute form, so `isolation="isolate"` — which is what
   `svgrender.ts` emitted until k01 — parses as an unknown attribute and is
   dropped. It was inert. Deleting it changed nothing because it did nothing.
   Now emitted as `style="isolation:isolate"`, merged into the same `style` as
   `mix-blend-mode` (a repeated `style` attribute would discard one of them).
2. **`clip-path` establishes a stacking context**, so the `<g clip-path>` wrapper
   that `drawFormBody` emits for the form's `/BBox` isolates the group on its
   own. That is why the golden was green while the isolation markup was inert,
   and why removing isolation is *still* not caught after the fix.

So the property remains unverifiable by these fixtures — not because engines
ignore it, but because our own `/BBox` clip makes it redundant in every group we
emit. It is kept because relying on that redundancy is fragile: a form without
`/BBox` gets no clip wrapper, and eliding a whole-page BBox clip is an
optimization someone could reasonably make later. Verifying it needs a fixture
whose group carries no BBox clip.

What the fixture *does* buy is the row above it: reverting the vp8
`groupContentBlends` fix makes `ToImage` blend against the page while the browser
golden does not, and `test/svg-golden.test.ts` fails on exactly this fixture. So
it guards the renderer bug that motivated it — just not the attribute.

In-tree, `test/raster-transparency.test.ts` covers the compositing (including a
non-isolated case proving the fixture discriminates) and
`test/svg-transparency.test.ts` asserts the attribute is emitted at
`opacity="1"`. The latter is an assertion about our own markup, and the goldens
have now shown it has no observable consequence in either engine we test.

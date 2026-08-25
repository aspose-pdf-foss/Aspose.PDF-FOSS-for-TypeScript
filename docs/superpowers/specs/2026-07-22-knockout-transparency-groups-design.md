# Knockout transparency groups (`/K true`) — raster backend

Issue: `aspose-pdf-foss-for-ts-076` (split out of `bbu`, which covered
non-isolated backdrop removal only). Follows `aspose-pdf-foss-for-ts-9yk`.

## Problem

A knockout group composites each of its elements against the group's **initial**
backdrop rather than the accumulated result of the elements painted before it
(ISO 32000-1 §11.4.6.2, §11.4.8). In an overlap, the topmost element replaces
those beneath it instead of compositing over them.

Neither backend reads `/K`. `raster.ts` and `svgrender.ts` both render a
knockout group as an ordinary group, so overlapping elements accumulate when
they should knock out. SVG 1.1 has no expression for per-element backdrop reset.

## Decisive observation: opaque elements cannot discriminate knockout

Two overlapping **opaque** elements show the topmost in the overlap whether or
not the group is knockout — the results are identical. Knockout differs from
ordinary compositing only when elements are **semi-transparent**: ordinary
compositing gives top-over-bottom in the overlap; knockout replaces (top over
the *initial backdrop*, hiding the bottom element entirely within the top's
footprint).

Therefore any load-bearing test must use fractional alpha, and the
implementation must separate an element's **shape** (geometric coverage, the
`f_j` of §11.4.8) from its **opacity** (`ca`, the `q_j`). This is the crux of
the spec's compositing formula and cannot be avoided — it is the same lesson as
`9yk`, where the removal term was only load-bearing at fractional alpha.

## Scope

- **In:** faithful `/K true` in the raster backend (`ToImage`) for both isolated
  and non-isolated knockout groups.
- **Out (documented limitations):**
  - SVG faithful knockout — `ToSvg` renders as an ordinary group; recorded as a
    known limitation.
  - Per-glyph knockout within a single text-showing operator (each `Tj`/`TJ` is
    one element).
  - `/K` is a `/Group` attribute on form XObjects only — not an ExtGState
    concept.

## Design (Approach 1: per-element sub-buffer + shape channel)

A knockout element is essentially a mini backdrop-seeded sub-group over the
group's initial backdrop `B0`, and the knockout merge is a sibling of
`composeGroup`. This reuses the `bbu` machinery (backdrop seeding +
group-only-alpha tracking) rather than adding a parallel path.

### 1. Detection & dispatch — `pagerender.ts`

`drawForm` reads `/K` alongside `/I`:

```ts
const knockout = isTransparencyGroup && ctx.doc.resolve(grp.get('K')) === true;
```

- `needsBuffer` gains `|| knockout`: a knockout group **always** buffers, even at
  alpha 1 / Normal / no soft mask, because its overlaps differ from inline.
- `needsBackdrop` (seeding) is true for **non-isolated knockout regardless of
  `innerBlends()`** — a non-isolated element's initial backdrop *is* the page, so
  elements must composite over the seed even without an inner blend. (Current
  rule: `needsBuffer && !isolated && innerBlends()`; extend to
  `... && (innerBlends() || knockout)`.)
- The group's `OffscreenUse` (`{ kind: 'group'; ... }`) carries
  `knockout: boolean`.

`walk` learns when it is rendering a knockout group's **own top level** via a
`knockout` flag in the walk context, set only for this level. Nested `Do` forms
are single elements and run with `knockout: false`. Each top-level painting
element is bracketed:

```
sink.beginKnockoutElement();  <paint op>  sink.endKnockoutElement();
```

Bracketed ops: `doFill` (`f`/`F`/`f*`), `doStroke` (`S`/`s`), the fill+stroke
combinators (`B`/`b`/`B*`/`b*` — each produces one element pair; see note),
`Do` (image or nested form), `sh`, and each text-showing operator. `q`/`Q`,
clipping (`W`/`W*`), and `gs` between paints are **not** elements — only the
paint ops are.

Note on `B`/`b` (fill+stroke in one op): treated as a single element — the fill
and stroke composite together into one element buffer, then knock out as a unit.
This matches the spec's treatment of the combined path-painting operator as one
object.

Text: **each text-showing op (`Tj`/`TJ`) is one element.** Glyphs within one op
do not knock each other out — a documented simplification; per-glyph knockout is
rare and would cost a buffer per glyph.

### 2. Shape channel — `raster.ts` `Canvas` + rasterizers

Add an optional `shape?: Float32Array` to `Canvas`, parallel to `groupAlpha`.
When present, every rasterizer path (`rasterizeFill` / `rasterizeStroke` /
`rasterizeImage` / `rasterizeGlyphRun`) records **geometric coverage × soft
mask, before `ca`**, unioned per pixel:

```
shape[i] = cov + shape[i] * (1 - cov)
```

where `cov` is the pre-`ca` coverage (geometry × soft mask). This is `f_j` of
§11.4.8, distinct from the color blend's `cov * ca`. The pre-`ca` coverage must
be threaded through `Paint` so it is available at the write point in
`Canvas.blend` (or recorded by the rasterizer alongside the blend call). The
existing `groupAlpha` update in `Canvas.blend` already uses the post-`ca` `sa`;
the `shape` update uses the pre-`ca` coverage instead.

### 3. Element buffer & knockout merge — `raster.ts` sink

`beginKnockoutElement()` pushes an element buffer `E` initialized to `B0`:
transparent when isolated (a fresh buffer, no seed), or the page seed when
non-isolated (the same seeding loop `beginOffscreen` uses today). `E` also
carries a `shape` channel and a `groupAlpha` channel (element-only alpha,
excluding the seed). The op renders into `E` at full strength (Normal, alpha 1)
so its inner blend, if any, sees `B0`. `E.groupAlpha` is what feeds the
non-isolated removal's `agn`; `E.shape` is the merge weight `f`; `E.alpha` (which
includes the seed when non-isolated) is the merge's `E_alpha`.

`endKnockoutElement()` merges `E` into the group accumulator `G` — a sibling of
`composeGroup` — per pixel with element shape `f = E.shape`:

```
G_premul'     = (1 - f) * G_premul     + f * E_premul       // color * alpha
G_alpha'      = (1 - f) * G_alpha      + f * E_alpha
G_groupAlpha' = (1 - f) * G_groupAlpha + f * E_groupAlpha
```

- At `f = 1` the element replaces `G` (knockout).
- At `f = 0`, `G` is untouched.
- Fractional `f` at antialiased edges lerps, which is the correct partial-shape
  behaviour.

Working in premultiplied space keeps the color correct when `G_alpha` and
`E_alpha` differ. `G`'s `groupAlpha` (element-only alpha, excluding the seed) is
maintained through the merge so the existing §11.4.6 removal still applies at
group-composite time.

The group accumulator `G` is the offscreen buffer created by `beginOffscreen`
for the knockout group; it starts equal to `B0` (transparent when isolated, page
seed when non-isolated). `beginKnockoutElement`/`endKnockoutElement` operate
within that buffer's lifetime.

### 4. Group composite — unchanged

`endOffscreen` composites `G` down via the existing `composeGroup`:

- **Isolated knockout:** `B0` transparent, no removal (`groupAlpha`/seed absent,
  so `composeGroup` takes the plain path).
- **Non-isolated knockout:** `B0` = page seed, and the existing §11.4.6 removal
  (`k = a0 / agn - a0`) subtracts it — now operating on the knockout-accumulated
  `G`. No new composite code.

### 5. SVG — documented limitation

`svgrender.ts` unchanged (renders knockout as an ordinary group). Add a `/K`
knockout row to the SVG limitations in `README.md` and
`test/fixtures/svg/PROVENANCE.md`, next to the existing "backdrop removal in
SVG" entry.

## Testing

Vitest fixtures built programmatically in `test/helpers/build-transparency-
fixtures.ts`, hand-computed and **mutation-verified** per project convention.

1. **Isolated knockout, two overlapping semi-transparent squares** — e.g. red
   `ca 0.5` then blue `ca 0.5` over white. The overlap reads pure blue-at-0.5
   over white; the non-knockout result (source-over) reads blue-over-red. The
   gap is in a saturated channel, so antialiasing cannot blur it. Values
   computed by hand.
2. **Discrimination probe** — the fixture is parametrized by `K` (like
   `nonIsolatedGroupPdf`'s `/I`), and a test asserts the knockout and
   non-knockout renders differ at the overlap, proving the fixture is not
   vacuous.
3. **Non-isolated knockout** — elements knock out over a yellow page; combined
   with an inner blend mode to exercise the §11.4.6 removal path under knockout
   accumulation.
4. **Shape-vs-opacity guard** — the semi-transparent overlap is exactly what
   fails if `f` collapses to `f * ca`; the isolated fixture already covers this,
   called out explicitly in the test comment.
5. **No NaN / out-of-range** sweep over the page (as the `bbu` suite does).

Mutation checks recorded in the PROVENANCE mutation table, each of which must
turn a new probe red:

- Drop the per-op reset (`beginKnockoutElement` becomes a no-op / elements
  accumulate) → overlap reads the source-over value.
- Collapse `shape` to `shape * ca` in the merge weight → semi-transparent
  overlap no longer fully knocks out.
- Remove `knockout` from `needsBuffer` → the group draws inline and overlaps
  double-composite.

## Files touched

- `src/pagerender.ts` — read `/K`; extend `needsBuffer` / `needsBackdrop`;
  thread the walk `knockout` flag; bracket top-level paint ops.
- `src/raster.ts` — `shape` channel on `Canvas`; `beginKnockoutElement` /
  `endKnockoutElement`; knockout merge; `knockout` on the group `OffscreenUse`;
  thread pre-`ca` coverage through `Paint` / the rasterizers.
- `src/svgrender.ts` — unchanged (limitation only).
- `test/helpers/build-transparency-fixtures.ts` — knockout fixtures.
- `test/raster-transparency.test.ts` — probes.
- `test/fixtures/svg/PROVENANCE.md`, `README.md` — SVG limitation + mutation
  table rows.

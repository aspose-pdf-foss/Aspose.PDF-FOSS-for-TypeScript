# SVG `<filter>`: vector fast paths — design

Issue: `aspose-pdf-foss-for-ts-1gg0.10.5` (parent `1gg0.10`, SVG masks, filters and
markers; epic `1gg0`). Date: 2026-07-31.

Phase 5 and the last of the filter track. `1gg0.10.3` built the graph, the raster
seam and the core kernels; `1gg0.10.4` completed SVG 1.1's primitive set. Both
rasterize unconditionally. This phase adds the narrow set of chains that PDF can
express *exactly*, so those stop being flattened to a bitmap — the text inside
them stays extractable and the vectors stay resolution-independent.

The ordering was deliberate: the raster path had to exist first, because it is
the reference implementation every fast path is measured against. A second code
path with no independent oracle drifts.

## Correcting the premise

`2026-07-30-svg-masks-filters-markers-design.md` ("Vector fast paths") sketched
three qualifying chains: lone `feOffset`, lone `feFlood`, and `feBlend` with
`in="SourceGraphic"` and `in2` an `feFlood`, mapped to `/ExtGState /BM`.

**The `feBlend` row is wrong and is dropped, not deferred.** `color-interpolation-filters`
defaults to `linearRGB`, so SVG composites `feBlend` on linearized values, while
a PDF `/BM` blends in the device colour space. The mapping is exact only when the
author wrote `color-interpolation-filters="sRGB"` — a spelling almost nobody
writes, guarding the most intricate of the three paths. The raster path already
renders `feBlend` correctly in both spaces; there is nothing to gain.

It is replaced by the chain authors actually write — recolouring an icon:

```svg
<filter id="tint">
  <feFlood flood-color="#c33"/>
  <feComposite in2="SourceAlpha" operator="in"/>
</filter>
```

This one is exact in *either* colour space. Take flood colour `C` at alpha `a`
and source alpha `s`. Linearize and premultiply: `(lin(C)·a, a)`. `operator="in"`
reads only `in2`'s alpha: `(lin(C)·a·s, a·s)`. Unpremultiply and convert back and
the colour is `C` again, at alpha `a·s`. The linearization round-trips because
the colour is constant, which is precisely what `feBlend` cannot claim. And it
lands on machinery already in the tree: an `/S /Alpha` soft mask, which
`svgmask.ts` and `gsKey` have supported since `1gg0.10.1`.

## Scope

Four chain shapes, three emission kinds:

| Chain | `FastPath` |
|---|---|
| lone `feOffset` from `SourceGraphic` | `offset` (identity when `dx`/`dy` are 0 or absent) |
| `feMerge` with exactly one `feMergeNode in="SourceGraphic"` | `offset` with `dx = dy = 0` |
| lone `feFlood` | `flood` |
| `feFlood`, then `feComposite operator="in"` whose `in` is the flood's result and whose `in2` is `SourceAlpha` or `SourceGraphic` | `tint` |

Matching is on the *resolved* `FilterPrim`, not on the source attributes, so the
common spelling works without special-casing: the tint recipe above writes no
`in` on its `feComposite` at all, and `resolveFilter` has already defaulted it to
the previous primitive's result — the flood's. Likewise a lone `feOffset` with no
`in` has already resolved to `SourceGraphic`.

Everything else rasterizes exactly as it does today. No public API changes, no
new options, no new files.

Out of scope: `feBlend` (above). `FillPaint` / `StrokePaint` pseudo-inputs
(`1gg0.10.6`). SVG group opacity via transparency groups (`1gg0.12`).

## Where it plugs in

### `svgfilter.ts` — `classify`, pure

Next to `resolveFilter`, under the same rule as the rest of that module: it
decides geometry and returns a descriptor, allocating nothing and touching no
pixels.

```ts
export type FastPath =
  | { kind: 'offset'; dx: number; dy: number; clip: SegBBox }
  | { kind: 'flood';  color: Rgb; opacity: number; clip: SegBBox }
  | { kind: 'tint';   color: Rgb; opacity: number; clip: SegBBox };

export function classify(spec: FilterSpec): FastPath | null;
```

Three cases, not four. An identity chain is `offset` with `dx = dy = 0` rather
than its own `kind`, so there is no fourth branch for a consumer to forget — the
same reasoning that made `FilterResolution` a union in `1gg0.10.3`, applied in
the other direction.

`clip` is the subregion the result paints into. `resolveFilter` already
intersects every `prim.sub` with the filter region (`clipTo`), so for `offset`
and `flood` it is just the primitive's own `sub`; for `tint` it is the flood's
`sub` intersected with the composite's.

`dx` / `dy` go through `primLength`, so `primitiveUnits="objectBoundingBox"`
scales them by the right bbox side per axis. `color` / `opacity` are read with
the same `parseColor` + `flood-opacity` rules as `floodKernel` in
`svgfilterfx.ts`, including its treatment of `none` and of an unparseable
colour — a divergence there would make the two paths disagree on exactly the
inputs no one tests.

### `svgdraw.ts` — `emitFastFilter`

Beside `emitFiltered`, with the same signature shape. In `walk`, the
`r.kind === 'draw'` branch tries `classify(r.spec)` first and falls through to
`emitFiltered` on `null`.

**`offset`** — `groupForm` over the subtree with `/BBox` set to the filter
region, then:

```
q
<clip> re W n
1 0 0 1 dx dy cm      % omitted when dx and dy are both 0
/Fm Do
Q
```

The form `/BBox` is load-bearing, not incidental. SVG clips `SourceGraphic` to
the filter region *before* the primitive runs, so a shifted result must not drag
back in ink that the region cut away. Letting the form's own BBox do that clip in
the form's coordinate space, and the `cm` translate the already-clipped result,
gets SVG's order for free — the alternative is translating the region rectangle
and intersecting it by hand, which is the same thing spelled worse.

**`flood`** — no form and no clip operator; the fill rectangle *is* the clip.

```
q
/GSn gs               % ca = opacity; omitted when opacity is 1
r g b rg
<clip> re f
Q
```

**`tint`** — the same form as `offset`, used as the `/G` of an `/S /Alpha` soft
mask through the existing `gsKey(opacity, opacity, form, 'Alpha')`, then the
flood fill over `clip`. `flood-opacity` folds into `/ca`, since the painted alpha
is the constant alpha times the mask value, which is exactly `a·s`.

Per `maskFor`'s convention an alpha soft-mask group carries `/CS /DeviceRGB`; the
group is unchanged from the one `offset` builds apart from that key.

## Consequences

- **A fast path adds nothing to `rasterized` and nothing to `skipped`.** That
  absence is the observable signal, and what the emission tests assert on.
- **A fast path needs no rasterizer.** `emitFastFilter` never touches `e.raster`,
  so these filters now render through `drawSvg` calls that pass no raster sink —
  which is every existing test helper. Filters that previously drew unfiltered
  there now draw correctly.
- **`filterRes` is ignored on a fast path.** It caps a raster that no longer
  exists; honouring it could only make exact output worse.
- No output changes for any chain that does not classify.

## Testing

`test/svg-filter-fast.test.ts`, in three layers.

**Pure.** `classify` called directly, no document. The three kinds recognised,
and — where the value actually is — the near-misses rejected: two primitives
where one is required, an `in` naming a prior result rather than `SourceGraphic`,
`feComposite operator="over"`, the composite's `in` and `in2` swapped,
`flood-color="none"`, an `feMerge` with two nodes. A near-miss that wrongly
classifies emits confident, plausible, wrong ink — the same failure shape as
listing a primitive in `SUPPORTED` before its kernel exists.

**Emission.** Through `drawSvg`: the expected operators are present, no image
XObject was allocated, `rasterized` is empty.

**Equivalence.** Through the public `AddSVGObject` + `ToImage`: the fast chain
against the same chain padded with a trailing `feOffset dx="0" dy="0"`, compared
as mean absolute difference. The padding is a no-op by spec but makes the chain
two primitives, so it rasterizes. This keeps both sides on the shipping API and
costs no test-only opt-out flag — a code path that exists only for tests is a
code path no caller exercises.

### Fixtures chosen to be load-bearing

Each of these exists because the obvious fixture passes with the code under test
deleted. Every one is confirmed by breaking the path and watching the suite go
red, never by watching it go green on the first run.

| Trap | Fixture that catches it |
|---|---|
| subregion clip dropped | a subregion narrower than the filter region — a full-region one passes with the clip deleted, the same way `maskTo` slipped through in `1gg0.10.3` |
| region clip on the source dropped (the form `/BBox`) | ink extending past a `userSpaceOnUse` region, offset back inward |
| `dy` sign flipped | a vertically asymmetric source; a symmetric one cannot see the y-down/y-up seam, which has already bitten this stack once |
| `/S /Alpha` built as `/S /Luminosity` | a **dark** source shape — luminosity of near-black is ~0 so the tint vanishes, while alpha is full. A white or light source makes the two mask types agree and the test passes either way |
| `flood-opacity` dropped | opacity ≠ 1 and ≠ 0.5; a half value survives several averaging mistakes |

## Files

| File | Change |
|---|---|
| `src/svgfilter.ts` | new `FastPath` union and `classify`; still pure |
| `src/svgdraw.ts` | new `emitFastFilter`; `walk` tries `classify` before `emitFiltered` |
| `test/svg-filter-fast.test.ts` | new |
| `README.md` | filter limitation wording: these chains are no longer rasterized |

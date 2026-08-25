# SVG gradients: `reflect` / `repeat` spread on radial gradients — design

Issue: `aspose-pdf-foss-for-ts-1gg0.18` (epic `1gg0`, page-furniture & text-authoring
parity gaps). Date: 2026-07-30.

Follow-up to `1gg0.7`, which shipped `spreadRange` / `tileStops` for **linear**
gradients only; see `2026-07-28-svg-gradients-design.md`, "spreadMethod". Today a
radial gradient with `spreadMethod="reflect"` or `"repeat"` falls back to `pad`
and adds `radialGradient` to `skipped`.

## Correcting the premise

The issue records the expectation that this "needs either many stitched
ShadingType 3 rings or a tiling pattern." **Neither is needed**, and that is the
central finding of this design.

PDF extends a ShadingType 3 by interpolating **both** centre and radius linearly:
circle `s` is centred at `c₀ + s(c₁ − c₀)` with radius `r₀ + s(r₁ − r₀)`. SVG's
radial model is the same family: circle `t` is centred at `f + t(c − f)` with
radius `t·r`. So one shading, with its outer circle pushed out to parameter `k`
and `k` copies of the ramp packed into its function, *is* the tiled gradient. No
new PDF machinery, and no per-ring objects.

| | today | with tiling |
|---|---|---|
| `/Coords` | `[fx, fy, 0, cx, cy, r]` | `[fx, fy, 0, fx + k(cx−fx), fy + k(cy−fy), k·r]` |
| `/Function` | ramp over `[0, 1]` | `tileStops(stops, 0, k, reflect)` |

Two things make the radial case *cheaper* than the linear one:

- **`k₀` is always 0.** `r(t) = t·r` is only meaningful for `t ≥ 0`, and SVG's
  spread applies outward from `t = 1`, so the range is `[0, k]`. There is no floor
  to compute and the inner circle stays the radius-0 focal point it already is.
- **The alpha twin comes along free.** `pair()` (from `1gg0.17`) builds the
  `/DeviceGray` mask from the same coords and the same tiled stops, so a radial
  `repeat` carrying a varying `stop-opacity` needs no extra code.

`tileStops` is reusable unchanged, called with `k₀ = 0` and `n = k`. Its
`reflect` rule — mirror copy `i` when `k₀ + i` is odd — gives copy 0 forward,
copy 1 mirrored, which is SVG's mirroring about every integer boundary.

## Scope

`reflect` and `repeat` on `radialGradient`, under both `gradientUnits`, with or
without `gradientTransform`, with a centred or an eccentric focal point, and on
fill or stroke. `pad` is untouched.

Out of scope: nothing new is deferred. This closes the last gradient limitation.

## Where it plugs in

In `gradientPaint`'s radial branch, **after** the existing 0.999 focal-point
clamp. The order matters: that clamp is what guarantees `|d| < r`, which the range
math below depends on, so the range must be computed from the clamped `fx`/`fy`.

```ts
const spread = g.attrs.get('spreadMethod');
let coords = [fx, fy, 0, cx, cy, r];
let fnStops = stops;
if (spread === 'reflect' || spread === 'repeat') {
  const k = radialSpreadRange([fx, fy], [cx, cy], r,
                              mul(gt, bboxMatrix(obb, bbox)), bbox);
  if (k !== null) {
    coords = [fx, fy, 0, fx + k * (cx - fx), fy + k * (cy - fy), k * r];
    fnStops = tileStops(stops, 0, k, spread === 'reflect');
  }
}
return {
  kind: 'pattern',
  ...pair([['ShadingType', 3], ['Coords', coords]], fnStops),
  opacity,
  report: false,
};
```

`/Extend [true true]` is unchanged and still correct: outward it pads with the
last ramp value, which is invisible once `k` covers the shape; inward, at radius
0, it is a no-op.

`report` becomes unconditionally `false` for a radial gradient, so
`radialGradient` leaves `skipped` altogether.

## `radialSpreadRange`

A new export in `svggradient.ts`, beside `spreadRange`. It returns a single
`number | null` rather than a `[k₀, k₁]` pair, because `k₀` is always 0.

```ts
export function radialSpreadRange(
  f: [number, number], c: [number, number], r: number,
  m: Matrix, bbox: SegBBox | null, cap = 64,
): number | null
```

For each bbox corner, mapped through `invert(m)` into gradient space, solve for
the parameter `t` whose circle passes through it:

```
t²(|d|² − r²) − 2t·d·(p − f) + |p − f|² = 0        where d = c − f
```

```ts
const a = dx * dx + dy * dy - r * r;   // < 0, because |d| < r
const b = -2 * (dx * ex + dy * ey);
const g = ex * ex + ey * ey;           // >= 0
const t = (-b - Math.sqrt(b * b - 4 * a * g)) / (2 * a);
```

Two facts make this robust rather than fiddly, and both belong in comments beside
the code:

- **That expression is always the non-negative root.** `disc = b² − 4ag ≥ b²`,
  since `−4ag ≥ 0`, so `√disc ≥ |b|` and the numerator is `≤ 0`; the denominator
  is `< 0`. No root selection, and no branch to get wrong.
- **Four corners suffice.** With the focus strictly inside the circle, the family
  `t ↦ (f + t·d, t·r)` is strictly nested and expanding, so the level sets of
  `t(p)` are nested convex curves and the maximum over a convex polygon is
  attained at a vertex.

Then `k = max(1, ceil(max t))`.

`null` is returned when the box is absent, the matrix is singular, `a ≥ 0` (which
the focal clamp should already prevent, but the guard costs nothing and keeps the
function total), or `k` exceeds `cap`. On `null` the caller keeps the un-tiled
coords, i.e. `pad`. Following the precedent the linear path set, that bounded
degradation is **not** reported.

### Why the element CTM is absent from `m`

`m` is `mul(gradientTransform, bboxMatrix)` — no element CTM — exactly as
`spreadRange` already takes it. The shape's box is in element user space and the
pattern `/Matrix` carries the same CTM factor, so it cancels out of the
projection. That cancellation is now load-bearing in four places: the colour
matrix, the alpha matrix, and both spread ranges.

### The one refactor

`spreadRange` and `radialSpreadRange` share the same preamble — reject a null
box, invert `m`, map the four corners. That becomes a small
`gradientSpaceCorners(m, bbox): [number, number][] | null` helper which both
call, carrying the CTM-cancellation explanation once instead of twice. Nothing
else moves.

## Errors

No new error conditions and no new error types. Every failure path returns `null`
and falls back to the behaviour shipping today.

## Testing

**`radialSpreadRange`** — asserted on the **covering property**, never on the
formula, so the test does not run through the same quadratic it is meant to check
(the CLAUDE.md rule that a differential test cannot validate the interpreter it
runs through):

- for the returned `k`, every bbox corner lies inside the circle
  `(f + k·d, k·r)`;
- for `k − 1`, at least one corner lies outside it — the tightness half, without
  which a function returning the cap every time would pass.

Both are plain distance arithmetic. Plus: `k ≥ 1` even for a box inside the first
circle; the concentric case against the closed form `ceil(L / r)`; `null` past
the cap; `null` on a singular matrix.

**`gradientPaint`** — a radial `repeat` scales `/Coords` by `k` and tiles the
function; `reflect` mirrors alternate copies; the `/DeviceGray` alpha twin carries
the same tiled coords and function; a radial `pad`'s output is unchanged; the
gradient no longer appears in `skipped`.

**End to end through `Save`/`Open`/`ToImage`** — a `userSpaceOnUse` radial with a
small `r` over a wide shape: sample the centre, the first ring's outer edge, and
the second ring's start, which must return to the first stop's colour.
Deliberately a **low** repetition count: `raster.ts` samples the shading function
into a 257-entry LUT (`shadingLut`), so packing many ramp copies into `[0, 1]`
bands in our own rasterizer even though the emitted PDF is exact. The existing
linear `repeat` test already lives with that at four bands. This is a property of
the test harness, not of the output, and is not a limitation worth documenting.

**Mutation**, per the repo rule that an assertion passing first time is not yet
evidence: dropping the `k` scaling from `/Coords` while keeping the tiled stops,
and using `k₀ = 1` instead of 0, must each turn the end-to-end test red.

Fixtures extend the existing programmatic SVG builders; the new cases go in
`test/svg-gradient.test.ts` and `test/svg-gradient-render.test.ts`.

## Documentation

`README.md`: `spreadMethod` is currently described as "`pad` everywhere,
`reflect`/`repeat` on linear gradients", and `1gg0.17` left the sentence "One
gradient limitation remains: `reflect`/`repeat` on a **radial** gradient falls
back to `pad` and names the gradient element in `result.skipped`." Both change:
`reflect`/`repeat` now work on both gradient types, and no gradient limitation
remains.

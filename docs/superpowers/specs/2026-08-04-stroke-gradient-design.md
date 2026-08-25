# Gradient stroke paint in `PageGraphics` — design

Issue: `aspose-pdf-foss-for-ts-menf`, the last follow-up filed by
`2026-07-30-axial-gradient-fill-design.md` (epic `lqp5`).
Date: 2026-08-04.

## Correcting the premise

As with the fill design, most of this already exists. A gradient stroke is
`/Pattern CS` + `/<key> SCN` over the *same* `shadingPattern()` a fill registers:
`gradient.ts` needs nothing new, `registerShadingPattern` needs nothing new, and
the renderers already resolve stroke shading patterns (`pagerender.ts:450-458`,
which narrows the clip to the stroke outline through `clipToStroke`).

What is actually new is alpha. `ca` and `CA` are separate channels and the
shipped fill path writes both; a soft mask has no channel split at all. Those two
facts are the whole design.

## Scope

`PageGraphics.setStrokeGradient(g: Gradient)` — axial and radial, uniform and
varying stop alpha, symmetric with `setFillGradient` in every respect the two can
be symmetric in.

Includes one correction to shipped behaviour: `setFillGradient`'s uniform-alpha
path currently writes `ca` **and** `CA`, so a translucent gradient fill also
fades strokes. It becomes `ca`-only. See "Alpha channels" below.

Out of scope: a public `setStrokeOpacity` / `setFillOpacity` pair. `setOpacity`
keeps setting both channels, which is what its name says and what its eight
callers across `stamp.ts`, `decorate.ts`, `compose.ts` and `imageembed.ts` mean.

## Module boundaries

```
src/pagecontent.ts   registerExtGState gains an AlphaChannel parameter
src/graphics.ts      + setStrokeGradient, + the shared gradientPaint core,
                     + the live-soft-mask guard
```

No new module. `gradient.ts` is untouched — it is already paint-agnostic, which
is the property that makes this issue small.

## Alpha channels

```ts
export type AlphaChannel = 'both' | 'fill' | 'stroke';

export function registerExtGState(
  doc: Document, page: Page, opacity: number, channel: AlphaChannel = 'both',
): string
```

`'fill'` writes `/ca`, `'stroke'` writes `/CA`, `'both'` writes both. The default
keeps all eight existing call sites byte-identical.

**Invariant: the dedup compare must match the exact key set, not just the
values.** The loop today asks whether `ca` and `CA` both equal the wanted
opacity. Left alone, it would hand a `<< /ca 0.5 >>` back to a caller asking for
`<< /ca 0.5 /CA 0.5 >>` — silently dropping the stroke half of `setOpacity`. The
compare therefore reads both keys as `number | undefined` and requires each to
equal what the channel wants, absence included. Presence is read off the **raw**
dict, since `doc.resolve(undefined)` returns `null` and a resolved absent key
therefore does not compare equal to `undefined` — the trap that already fired
once in the PDF/X rules.

Found while planning, and fixed in the same loop: **a state carrying an `/SMask`
must never be reused.** The mask states `registerSoftMaskExtGState` builds set
`ca = CA = 1`, so a request for opacity 1 matches one on both channels and
silently inherits its soft mask. Latent today only because every current caller
guards on `opacity < 1`, but `setOpacity(1)` after a masked gradient reaches it.

`setFillGradient` moves to `'fill'` and `setStrokeGradient` uses `'stroke'`. This
applies to the degenerate collapse too, which today routes through the public
`setOpacity()`: a single-stop translucent stroke gradient must not fade fills any
more than a full ramp does, so the collapse calls the scoped register directly.

Both still **override** rather than multiply with an earlier `setOpacity()` — now
only in their own channel. Documented on both methods.

## One core, two entry points

`setFillGradient` and `setStrokeGradient` differ in exactly three things:
operator case (`cs`/`scn` vs `CS`/`SCN`), the degenerate solid (`rg` vs `RG`),
and the alpha channel. Everything else — validation, normalization, the
degenerate predicate, the shading twins, pattern registration, the soft mask — is
shared. So the shipped body becomes:

```ts
private gradientPaint(g: Gradient, ch: 'fill' | 'stroke'): this
setFillGradient(g: Gradient): this   { return this.gradientPaint(g, 'fill'); }
setStrokeGradient(g: Gradient): this { return this.gradientPaint(g, 'stroke'); }
```

Writing a second copy is the main thing this design exists to prevent: the fill
path already carries three invariants (default-space coordinates, the inverse-CTM
mask matrix, per-stop opacity on the degenerate collapse) that a parallel
implementation would have to re-derive, and a later fix to one would silently
miss the other.

## The live-soft-mask guard

An `/ExtGState` holds **one** `/SMask`, and it masks fill and stroke alike —
there is no per-channel split the way `ca`/`CA` gives one. So a varying-alpha
fill gradient followed by a varying-alpha stroke gradient loses the first mask
entirely, and a `fillStroke()` paints the fill through the *stroke's* ramp. The
fix is to paint in two operations, the split `svgdraw.ts` already makes in
`resolvePaint`/`gsOps`.

Left undetected that is a silently wrong render, so `PageGraphics` tracks which
channel owns the mask currently in force:

```ts
private liveMask?: 'fill' | 'stroke';
```

- Set when a varying-alpha gradient registers its mask.
- Cleared by every paint op — `stroke()`, `fill()`, `fillEvenOdd()`,
  `fillStroke()`. The mask has done its job; replacing it now is harmless.
- Saved and restored with the CTM. The stack becomes `{ ctm, liveMask }[]`, so a
  `restore()` returns to whatever was live at the matching `save()`.
- Setting the **other** channel's mask while one is live throws
  `UnsupportedFeatureError` naming the fix. Setting the **same** channel's again
  is legal: nothing was painted through the mask being replaced.

```ts
g.setFillGradient(varyingA);
g.setStrokeGradient(varyingB);   // throws
```
```ts
g.setFillGradient(varyingA);
g.fill();                        // clears the live mask
g.setStrokeGradient(varyingB);   // fine
g.stroke();
```

The class comment stating the CTM is tracked "for ONE reason" is updated: the
stack now carries two pieces of state, for two reasons.

## Inherited invariants

Both restated on `setStrokeGradient`, because both bite a stroke caller exactly
as they bite a fill caller:

- **Gradient coordinates are in the page's DEFAULT user space and ignore the
  CTM** (PDF 32000-1 §8.7.3.1). A `transform()` moves the path, not the ramp.
- **The soft-mask group gets the inverse CTM as its `/Matrix`** (§11.6.5.2),
  since the mask renders under the CTM in force where its `gs` runs while the
  shading pattern it twins is pinned to the default space.

A third is stroke-specific and worth stating once: the ramp is pinned to page
space, not to the stroke's own path, so a gradient stroke's colour at a point
depends on where that point *is* and not on how far along the outline it lies.
That is what PDF's shading patterns are; a ramp that follows a path is a
different feature and is not this one.

## Testing

**`test/graphics.test.ts`** — a `PageGraphics.setStrokeGradient` describe
mirroring the fill one, reusing its `pageResource` / `extGState` / `maskShading`
helpers:

- `/Pattern CS` and `/P0 SCN` emitted; the page `/Resources /Pattern` entry
  resolves to a `PatternType 2` with a `ShadingType 2` and the right `/Coords`.
- Radial: `ShadingType 3`.
- Both degenerate collapses (fewer than two stops, zero-length axis / zero
  radius) emit `RG`, allocate no pattern, and take the single stop's own opacity.
- Uniform alpha writes `<< /CA a >>` **and no `/ca`**; the fill side gets the
  mirrored assertion, pinning the `ca`-only correction.
- Varying alpha produces the `/SMask` ExtGState over the `/DeviceGray` twin.
- A rejected gradient leaves the document byte-identical.
- The CTM invariant: a `transform()` before the call does not move the `/Coords`.
- The guard throws on `fill-then-stroke` and does not throw when a paint op
  separates them.

**`test/graphics-gradient-render.test.ts`** — one end-to-end case: a thick
gradient-stroked line through `Save` / `Open` / `ToImage`, sampling red at one
end of the axis and blue at the other. This is the only test that exercises the
whole chain and the one that catches a wrong operator case or a wrong `/Matrix`.

**Mutation check.** Per CLAUDE.md, passing on the first run is not evidence.
Break each path deliberately and confirm the suite goes red: swap the `/Coords`
endpoints, emit lowercase `scn` on the stroke path, write `ca` where `CA`
belongs, and remove the live-mask guard.

## Docs

`README.md` gains `setStrokeGradient` beside `setFillGradient` in the graphics
API overview, and the `ca`-only correction is noted where the fill method's
alpha override is described.

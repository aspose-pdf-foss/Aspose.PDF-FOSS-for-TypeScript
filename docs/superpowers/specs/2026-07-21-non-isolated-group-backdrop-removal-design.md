# Non-Isolated Transparency Groups — Backdrop Removal — Design

Issue: `aspose-pdf-foss-for-ts-bbu`. Follows `a6i` (render fidelity) and `7wg`
(SVG clip isolation), and their specs
`2026-07-21-render-transparency-design.md` and
`2026-07-21-svg-clip-isolation-design.md`.

## Problem

A non-isolated transparency group composites against the page backdrop. Doing
that correctly means initializing the group's offscreen buffer with the backdrop
and subtracting it back out at composite time (ISO 32000-1 §11.4.6). What
shipped draws non-isolated groups inline, which is exact at alpha 1 with a
Normal group blend and an approximation otherwise.

The buffering predicate in `pagerender.ts` is:

```ts
const isolated = isDict(grp) && /* /S /Transparency */ && ctx.doc.resolve(grp.get('I')) === true;
const needsBuffer = isolated
  && (gs.fillAlpha < 1 || gs.blend !== 'Normal' || gs.softMask !== undefined
    || groupContentBlends(ctx.doc, stream))
  && ctx.depth < MAX_OFFSCREEN_DEPTH;
```

`isolated` requires `/I true` **explicitly**. `/I` defaults to false, so the
ordinary `/Group` form — no `/I` key at all — takes `needsBuffer === false` and
draws inline unconditionally, even at `ca 0.5`.

### Measured

Two overlapping opaque red squares inside a transparency group drawn at
`ca 0.5` over white (the `isolatedGroupPdf` shape, varying only `/I`):

| `/Group /I` | overlap probe | single-coverage probe | correct |
|---|---|---|---|
| `true` | `255,128,128` | `255,128,128` | ✓ |
| `false` | `255,64,64` | `255,128,128` | ✗ |
| absent | `255,64,64` | `255,128,128` | ✗ |

The overlap composites twice. This is a live fidelity bug in the default case,
not only the exotic blend case the issue describes, and it is the most visible
thing this work fixes.

## Key insight: removal is a no-op without an inner blend

With Normal inner compositing, seeding a buffer with the backdrop and then
algebraically removing it recovers **exactly** the isolated result — the
§11.4.6 formula is constructed so that identity holds. A non-isolated group
differs from an isolated one only when its contents use a non-Normal blend mode
that actually consults the backdrop.

So the expensive path can be gated on `groupContentBlends`, which already
exists and already computes precisely that predicate:

| Group | Unit composite (`ca<1` ∥ blend ∥ softmask) | Inner blend | Path |
|---|---|---|---|
| any | no | — | inline (unchanged) |
| isolated | yes | — | plain buffer (unchanged) |
| isolated | no | yes | plain buffer (unchanged — the `vp8` fix) |
| non-isolated | yes | no | plain buffer — exact, no removal machinery |
| non-isolated | yes | yes | backdrop seed + removal |

Only the last row allocates a group-alpha plane or runs the removal formula.

## The formula

ISO 32000-1 §11.4.6:

```
C = Cn + (Cn − C0) × (α0/αgn − α0)
```

- `C0`, `α0` — the backdrop under the group.
- `Cn`, `αn` — the buffer after rendering the group's contents onto a
  backdrop-initialized buffer.
- `αgn` — the group's **own** accumulated alpha, excluding the backdrop.

`αgn` is the crux: the buffer's alpha channel holds `αn`, not `αgn`.

### Why `αgn` needs its own storage

It cannot be derived algebraically. The backdrop goes down source-over beneath
everything, so `αn = αgn + α0(1−αgn)`, giving `αgn = (αn − α0)/(1 − α0)` — which
is `0/0` whenever `α0 = 1`. A page rendered onto opaque white has `α0 = 1`
almost everywhere, so the derivation fails in the common case rather than an
edge case. It gets a parallel plane.

## Mechanism

Three touches, all in the raster backend plus the shared interface.

**`Canvas`** gains an optional `groupAlpha?: Float32Array`, allocated only for
the last-row case. `blend()` accumulates `ga = sa + ga·(1−sa)` into it behind a
null check — one guarded line in the hot path.

**`beginOffscreen`** gains an options argument to seed the new buffer from the
parent canvas over the allocated region, and to allocate the plane. No separate
backdrop copy is stored: the parent canvas (`top.saved`) is not written while
the group renders, so `composeGroup` reads `C0`/`α0` back out of it at the same
device coordinates.

**`composeGroup`** applies the formula for `isolated: false` buffers that carry
a plane, with the result clamped to [0,1] against float drift. Degenerate cases
fall out: `αgn = 0` → the group contributed nothing, skip the pixel; `α0 = 0` →
reduces to `C = Cn`, the isolated answer.

**Predicate**, in `pagerender.ts`:

```ts
const unitComposite = gs.fillAlpha < 1 || gs.blend !== 'Normal' || gs.softMask !== undefined;
const needsBuffer = isTransparencyGroup
  && (unitComposite || (isolated && groupContentBlends(ctx.doc, stream)))
  && ctx.depth < MAX_OFFSCREEN_DEPTH;
```

`isTransparencyGroup` tests `/S /Transparency` only; `isolated` keeps its
`/I true` reading, now used to select the *path* rather than to gate buffering
at all.

## Other backends

`RenderSink` is shared, so `svgrender.ts` and `htmlfixed.ts` accept the new
`beginOffscreen` argument and ignore it. `svgrender.ts` additionally stops
emitting `isolation:isolate` for `isolated: false` groups.

This makes SVG **exact** for the no-inner-blend row. It remains approximate only
for the last row: SVG group `opacity` creates a stacking context and therefore
forces isolation, as measured in `test/fixtures/svg/PROVENANCE.md` — a
non-isolated group that both composites as a unit and blends internally is not
expressible in SVG 1.1 + CSS Compositing. That residue is narrower than the
whole-feature divergence it replaces.

## Degradation

The existing caps carry over unchanged. On depth or size cap `beginOffscreen`
pushes a marker without redirecting, so content draws inline with the outer
paint and `endOffscreen` no-ops. A capped non-isolated group therefore degrades
to exactly today's behaviour.

Nested groups need no special handling: the backdrop for an inner group is the
enclosing buffer's accumulated content, which is what reading from the parent
canvas gives.

## Testing

In `test/raster-transparency.test.ts`:

1. Non-isolated, `ca 0.5`, overlapping opaque rects, no inner blend → equals the
   isolated result, showing no double-darkening. Regression for the measured bug
   above; covers both `/I false` and `/I` absent.
2. Non-isolated, `ca 0.5`, inner `Multiply` over a coloured page backdrop →
   asserted against a hand-computed §11.4.6 literal, and asserted `≠` the
   isolated value.
3. The isolated twin of (2), unchanged — proves the two paths diverge where they
   should.
4. Degenerate sweep: every buffer pixel finite and within [0,1], guarding the
   `αgn = 0` / `α0 = 0` division class.

Fixtures go in `test/helpers/build-transparency-fixtures.ts`, alongside
`isolatedGroupPdf` and `isolatedBlendGroupPdf`, following their style of
documenting the correct and broken probe values in the doc comment.

### Mutation checks

A green first run is not evidence. Each is applied, the suite re-run, and
reverted:

| Mutation | Must break |
|---|---|
| drop backdrop seeding | (2) |
| drop the removal formula | (2) |
| drop `groupAlpha` accumulation | (2) |
| revert predicate to `isolated && …` | (1) |

Results recorded in the `PROVENANCE.md` mutation table in its existing format.

### SVG golden

One new fixture: a non-isolated group at `ca 0.5` **without** inner blend. SVG
becomes exact there, so Chrome and resvg should agree with us, and it currently
renders wrong — an engine-verified win rather than a SKIP.

No golden for the inner-blend case: both engines isolate it, so it could only
land as a SKIP, and the PROVENANCE Limits section carries that better as prose.

## Docs

- `CLAUDE.md` — the `svgrender.ts` invariant block currently states only the
  `/I true` case; extend it to the non-isolated rule and the `/I` default trap.
- `test/fixtures/svg/PROVENANCE.md` — narrow the "Backdrop removal" limit to the
  inner-blend residue; add the mutation rows; register the new golden.
- `README.md` — check whether the rendering limitations list mentions group
  isolation, and update if so.

## Out of scope

Knockout groups (`/K true`) remain unimplemented. Knockout requires every
painting op inside the group to composite against the group's *initial*
backdrop rather than the running buffer — a per-op reset in the dispatch path,
not a buffer-level change. Filed as `aspose-pdf-foss-for-ts-076`.

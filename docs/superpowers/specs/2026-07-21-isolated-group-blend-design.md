# Isolated Transparency Groups With Inner Blend Modes — Design

Issue: `aspose-pdf-foss-for-ts-vp8`. Follows `0k7` (SVG golden verification) and
its spec, `2026-07-21-svg-golden-verification-design.md`.

## Problem

`vp8` was filed as a test-coverage gap: deleting `isolation="isolate"` from
`svgrender.ts` produces a byte-identical `isolated-group.png` and all 37 golden
tests still pass, so the attribute is unverified. The filed cause was that
`isolatedGroupPdf` draws its group at `ca 0.5`, and SVG group opacity below 1
already forces offscreen compositing — making `isolation` redundant there.

That diagnosis is correct but incomplete. The prescribed fixture — an isolated
group at `ca 1.0` containing a blend-mode fill over a non-neutral backdrop —
**cannot pass today**, because the renderer does not distinguish isolated from
non-isolated at alpha 1.

Measured, with an isolated group containing a Multiply cyan square over a yellow
page:

| `/I` | `ToImage` at (100,100) | Correct |
|---|---|---|
| `true` | `0,255,0` | `0,255,255` |
| `false` | `0,255,0` | `0,255,0` |

The two agree, and the SVG contains no isolation group at all — the multiply
blends directly against the page.

The cause is the buffering predicate in `pagerender.ts`:

```ts
const needsBuffer = isolated
  && (gs.fillAlpha < 1 || gs.blend !== 'Normal' || gs.softMask !== undefined)
  && ctx.depth < MAX_OFFSCREEN_DEPTH;
```

`gs.blend` is the blend mode of the graphics state **outside** the group, in
force when `Do` executes. A blend mode used *inside* the group does not appear in
it. So an isolated group whose contents blend draws inline, and those contents
blend against the page backdrop — which is precisely the non-isolated behaviour
the group was declared to prevent.

This is why `isolation="isolate"` is unverifiable: not merely that the existing
fixture picked `ca 0.5`, but that the renderer never emits a case where the
attribute carries meaning.

## Approach

Fix the predicate, then add the fixture. Adding the fixture alone would commit a
golden certifying wrong output.

### Detection

A new `groupContentBlends(doc, stream)` in `pagerender.ts` answers "do this
form's contents use a non-Normal blend mode?" by walking resources, not content:

- scan `/Resources /ExtGState` values for `/BM` other than `Normal`, resolving
  the name through `blendModeFromName` and handling the array form exactly as
  `applyExtGState` already does (first name wins; Illustrator emits the array
  form). Reusing that resolver rather than comparing raw name strings matters:
  it maps both `/Compatible` and unrecognized names to `Normal`, so the scan
  agrees with what the interpreter will actually do;
- recurse into `/Resources /XObject` entries whose `/Subtype` is `/Form`;
- guard resource cycles with a `Set` of visited stream objects, and cap recursion
  at the existing `MAX_OFFSCREEN_DEPTH`.

Rejected alternatives:

- **Parse the content stream** for `gs` operators that actually set a blend. Has
  no false positives, but costs a content parse per group form and duplicates
  work the interpreter already does.
- **Always buffer isolated groups.** Unconditionally correct and trivial, but
  most `/Group` forms are isolated, so it allocates an offscreen buffer for
  nearly every form XObject. The comment at `pagerender.ts:594` exists to avoid
  exactly that.

The resource scan over-triggers when an ExtGState is declared but never used.
That is the deliberate direction of error: buffering is always correct and merely
slower, whereas under-triggering is silent wrong pixels.

### Wiring

```ts
const needsBuffer = isolated
  && (gs.fillAlpha < 1 || gs.blend !== 'Normal' || gs.softMask !== undefined
      || groupContentBlends(ctx.doc, stream))
  && ctx.depth < MAX_OFFSCREEN_DEPTH;
```

Only the isolated branch changes. Non-isolated groups still draw inline, so this
does not address `bbu` (non-isolated backdrop removal) and does not pretend to.

## Fixture

`isolatedBlendGroupPdf` in `test/helpers/build-transparency-fixtures.ts`: a
200×200 yellow page, then an isolated group (`/I true`, `ca 1.0`) whose contents
set `/BM /Multiply` and fill a cyan 100×100 square.

- **Isolated** — the blend sees a transparent group backdrop, so it is a no-op;
  the group composites Normal onto the page: `(0,255,255)`.
- **Non-isolated** — the blend sees the yellow page: cyan × yellow `(0,255,0)`.

The colours are chosen so the two answers differ in a channel that is saturated
either way, so antialiasing cannot blur one into the other.

Added to `GOLDEN_FIXTURES` with both probes.

## Verification

Behaviour, in `test/raster-transparency.test.ts`:

- isolated → cyan (the regression guard for the predicate fix);
- a companion `/I false` case → green, which proves the fixture *discriminates*
  rather than merely passing.

Markup, in `test/svg-transparency.test.ts`: the group is emitted as
`<g opacity="1" isolation="isolate">`. `opacity="1"` creates no stacking context,
so `isolation` is the only thing making the emitted SVG correct — the attribute
becomes load-bearing, which is what `vp8` asked for.

Per the repo rule, each assertion is confirmed load-bearing by mutation before
the issue closes, not merely observed green.

## What this does NOT cover

No golden PNG is committed. Generating one needs Chrome and resvg out of band,
which folds into `aspose-pdf-foss-for-ts-otk`. The in-tree tests prove our two
backends agree and that the attribute is emitted; they **cannot** prove a real
SVG engine honours `isolation` the way we assume, and that assumption is the
entire reason the goldens exist.

The Mutation-checks entry in `test/fixtures/svg/PROVENANCE.md` therefore changes
from "proven decorative" to "load-bearing in our output, browser-unverified",
and `isolation` stays under "Does NOT cover" until the golden lands.

## Risk

Isolated groups that previously drew inline now allocate a buffer, so existing
goldens and raster expectations may shift. Any movement is reported rather than
absorbed by adjusting expectations.

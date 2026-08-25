# Tiling-pattern authoring on PageGraphics

Design for `aspose-pdf-foss-for-ts-lucg.2`, the second child of the
`Authoring breadth` epic (`lucg`). `graphics.ts` registers shading patterns
(`PatternType 2`) and nothing else; there is no way to author a tiling pattern
(`PatternType 1`).

## Problem

The gap is one-sided in the same way `lucg.1`'s was, which is what makes it
conspicuous rather than merely absent:

- **The format is already built here.** `svgdraw.ts:456` constructs a complete
  `PatternType 1` dict — `BBox`, `XStep`, `YStep`, `Resources`, `Matrix` — for
  SVG `<pattern>` import, allocating through a sink `svgembed.ts` owns.
- **Both renderers already read one**, colored and uncolored alike:
  `pagerender.ts:213-232` resolves the dict and maps `PaintType 2`,
  `raster.ts:1027` steps the device-space lattice.
- **The optimizer already scans them.** `glyphusage.ts:392` and
  `imageusage.ts:267` both walk every `PatternType 1` in a resource dict.

So a PDF containing a tiling pattern is imported, rendered, and optimized
correctly, and cannot be authored. `graphics.ts` reaches
`registerShadingPattern` only.

## Approach

**A new pure leaf `tiling.ts` for the model, methods on the builder for the
allocation** — exactly `gradient.ts`'s existing division of labour, which the
repo describes as "the colour-stop model shared by the two gradient
*producers*; builds DIRECT `PdfDict`s and touches no `Document`". Validation,
the `/Matrix` composition and the pattern dict live in the leaf; `graphics.ts`
owns `setFillPattern`/`setStrokePattern` and `document.ts` owns the allocation.

Two alternatives were considered:

- **Everything in `graphics.ts`.** Smaller diff. Rejected because that file is
  441 lines and this would push it past ~570 with a nested-builder mechanism
  plus trigonometry — and the lattice arithmetic would then be observable only
  through emitted bytes, which is precisely the arithmetic that is silently
  wrong when transposed.
- **Fold into `gradient.ts` as a "paint servers" module.** Both are patterns,
  so it looks unifying. Rejected on evidence the repo has already gathered one
  layer down: `svggradient.ts` and `svgpattern.ts` are separate because "the
  two share no attributes and so share no code beyond the matrix helpers". A
  colour-stop ramp and a repeating cell have nothing in common but the word.

## Scope

In scope:

- `Document.NewTilingPattern(width, height, draw, opts?)` and the
  `TilingPattern` handle.
- `PageGraphics.setFillPattern` / `setStrokePattern`.
- Uncolored patterns (`PaintType 2`).
- Independent `xStep`/`yStep`, and lattice placement via `{ x, y, rotation }`.
- The `pagecontent.ts` resource-target refactor and the `PageGraphics` base
  split that make a full-featured tile builder possible.
- A byte-identity fence over `graphics.ts` output, added **before** that
  refactor.
- README and CHANGELOG.

Out of scope, deliberately:

- **Preset generators** (hatch, stripes, dots, checkerboard). Real convenience,
  but a second vocabulary to design, document and pin, and each is a few lines
  over the primitive once the primitive exists. Left until someone asks.
- **A raw `matrix` escape hatch.** `{ x, y, rotation }` covers what callers
  actually want; the raw form is recorded as deferred rather than rejected, to
  be filed as a follow-up if the offset/rotation pair proves insufficient.
- **Automatic `BBox` growth for content that overruns the tile.** See §5.
- **Text or images inside a tile.** `PageGraphics` has neither today; this
  issue does not add them.

## Design

### 1. The resource seam

`PageGraphics` hardcodes its resource target in four places — `setOpacity` and
the private `channelOpacity` reach `registerExtGState(this.doc, this.page)`,
`gradientPaint` reaches `registerShadingPattern` and
`registerSoftMaskExtGState`, and `BeginLayer` reaches `registerOcProperty`. A
tile's registrations must land in the *tile's* `/Resources`, not the page's.

**`pagecontent.ts`'s four `register*` helpers take a resources `PdfDict`
rather than a `Page`.** `ensureOwnResources(doc, page)` moves to the call site.
This is mechanical and byte-identical for every existing caller: the same keys
are minted from the same `freshKey` in the same order.

**`PageGraphics` splits into a base plus the page-bound subclass.** The base is
`VectorGraphics`, in `graphics.ts` beside its subclass: it holds every drawing
primitive, the state stack, the CTM tracking and an abstract resource target.
`PageGraphics extends VectorGraphics` and adds exactly `apply()` and `page`.
Its public surface is unchanged, so no existing caller moves.

`VectorGraphics` is exported from `index.ts` — it is the type a tile callback's
parameter has, so a caller writing a named `draw` function rather than an inline
arrow needs to be able to spell it.

**Invariant:** the tile callback receives the **base** type, which has no
`apply()` at all. A tile builder therefore cannot splice itself into a page —
the method does not exist on what the callback holds, so the mistake is
unrepresentable rather than refused at runtime. This is the move
`HtmlOptions.backdrop` already makes with a three-valued option where two
booleans would have permitted an invisible page.

### 2. The API

**Creation lives on the `Document`, not on the builder.** A `TilingPattern` is
page-independent, and the same hatch on forty pages must be one stream rather
than forty. The handle carries the allocated `PdfRef`; `setFillPattern`
registers that ref into whichever page it is used on. This follows
`createTable`, `doc.NewFlow` and `doc.NewFloatingBox`, and it matters here in a
way it does not for shadings: `registerShadingPattern` deliberately does not
deduplicate ("Optimize()'s content-hashed dedup is the general answer"), which
is tolerable for a three-dict shading and wasteful for a tile stream.

```ts
const hatch = doc.NewTilingPattern(20, 20, (t) => {
  t.setLineWidth(1).setStrokeColor([0.2, 0.2, 0.6])
   .drawLine(0, 0, 20, 20).stroke();
}, { rotation: 45 });

g.setFillPattern(hatch).drawRect(0, 0, 200, 100).fill();
```

`TilingPatternOptions`: `{ xStep?, yStep?, x?, y?, rotation?, uncolored? }`.
Steps default to the tile's `width`/`height`; `x`/`y`/`rotation` compose into
`/Matrix`; `uncolored` selects `PaintType 2`. `rotation` is in **degrees,
counter-clockwise**, matching every author-facing rotation in the library —
`stamp.ts`'s `AddText`/`AddTextBlock` and `decorate.ts`'s watermark angle all
take degrees CCW. `arc()` is the deliberate counter-example at radians, and it
is a geometry primitive rather than a placement option; a 45° hatch should not
be spelled `Math.PI / 4`.

The pattern stream is allocated when `NewTilingPattern` returns, so the handle
is a live object reference and not a recipe. Validation and the callback both
run before that allocation, which is what makes a rejected call leave the
document byte-identical.

Exported from `index.ts`: `TilingPattern`, `ColoredTilingPattern`,
`UncoloredTilingPattern`, `TilingPatternOptions`, and `VectorGraphics`.

**Invariant:** colored and uncolored are **different types**, and the overloads
make the colour non-optional exactly when it is needed:

```ts
setFillPattern(pattern: ColoredTilingPattern): this;
setFillPattern(pattern: UncoloredTilingPattern, color: [number, number, number]): this;
```

`NewTilingPattern` is overloaded the same way, so `{ uncolored: true }` returns
the narrow type. A single optional colour argument would be required half the
time and silently ignored the other half — the silent-acceptance trap the repo
already guards against where `region` must be destructured out before reaching
`addRedact` or `redactPage`.

**Invariant:** an uncolored tile builder **throws** on `setFillColor`,
`setStrokeColor` and both gradient setters. A viewer ignores every colour
operator inside a `PaintType 2` tile (32000-1 §8.7.3.1) — the colour arrives
from the `scn` at use time — so emitting them produces bytes no viewer honours.
A silent no-op there reads as a rendering bug for an afternoon.

**Invariant:** degenerate cases are refused at authoring time, not painted as
nothing. A zero or negative `width`/`height`, a non-positive `xStep`/`yStep`,
or a callback that emits no operators throws `TypeError` and allocates nothing,
so a rejected call leaves the document byte-identical. This differs on purpose
from `gradientPaint`, whose degenerate cases *collapse to a solid* — a gradient
with one stop still has a defensible colour to paint, while an empty tile has
no defensible ink.

### 3. The lattice

`/Matrix` = `mul(rotate(θ), translate(x, y))` — rotate about the pattern
origin, then shift — using `text.ts`'s existing `mul`, whose `m` argument
applies first (verified: `mul` transforms `m`'s translation by `n` and adds
`n`'s).

Defaults `x = y = 0`, `rotation = 0` yield the identity, so a pattern carrying
no options emits `[1 0 0 1 0 0]` and the option is provably free.

**Invariant:** the lattice is pinned to the parent stream's **default** user
space and ignores the CTM. This is not a choice — 32000-1 §8.7.3.1 maps a
pattern `/Matrix` to the default space of the parent content stream, not to the
CTM in force when the pattern is selected — and it is the same rule
`gradientPaint` already documents. A `transform()` earlier in the builder moves
the path and not the lattice. `{ x, y, rotation }` exists precisely because
that rule leaves the caller no other way to place the tiling.

### 4. The stream

```
Type        /Pattern
PatternType 1
PaintType   1 | 2
TilingType  1
BBox        [0, 0, width, height]
XStep       xStep ?? width
YStep       yStep ?? height
Resources   <the nested builder's registrations>
Matrix      <§3>
```

`/Resources` is required rather than optional, so a tile that registered
nothing still carries an empty dict.

### 5. Clipping

**Invariant:** tile content is clipped to `[0, 0, width, height]`, because that
is what `/BBox` means. A caller wanting deliberate spill sizes the tile larger
and sets smaller steps — the same escape `svgdraw.ts` takes for
`overflow: visible`, where it grows the box while holding `XStep`/`YStep` at
the tile size so adjacent cells overlap.

That growth is **not** automated here. `svgdraw.ts` can infer the intent from
an SVG attribute and can measure the subtree's ink; an authoring call has
neither an attribute to read nor a reason to believe overrun was deliberate,
and silently enlarging the box would make two adjacent fills overlap in a way
the caller never asked for.

## Testing

**`test/graphics-identity.test.ts` — written and committed BEFORE the
`pagecontent.ts` refactor.** The sha256 of a saved page exercising all four
registration paths: `setOpacity` (`/ExtGState`), a varying-alpha gradient
(`/Pattern` plus a soft-mask `/ExtGState`), and `BeginLayer` (`/Properties`).
Recorded from `main` as it stands. Same contract as
`test/table-slice-identity.test.ts` — **a fence, not a golden**: if it moves,
the refactor changed a resource key or an allocation order, and that is the
bug, not the hash.

This matters more than it may look. There is currently **no** byte-identity
fence anywhere over `graphics.ts` or `pagecontent.ts`: `test/graphics.test.ts`
and `test/gradient.test.ts` assert behaviour, and every `createHash` fence in
the suite covers tables, DOCX, rich runs, HTML or signing. The refactor's whole
claim is "byte-identical for existing callers" and nothing checks it today.

**`test/tiling.test.ts`** — the pure leaf from numbers, no PDF anywhere:

- the `/Matrix` composition with **one vector at a time** — `{x: 5}` alone,
  `{y: 5}` alone, `{rotation: 90}` alone, then a composite. Not one combined
  case: this is the trap `CLAUDE.md` records for the JBIG2 halftone grid, where
  transposing `HRX`/`HRY` renders a rotated screen that "reads as an unusual
  halftone rather than as a decode fault" and no single grid could pin both
  cross terms. A rotated-and-offset hatch has exactly that property;
- the identity case, asserting `[1 0 0 1 0 0]` for a pattern with no options —
  which is what makes the feature provably free for a caller who ignores it;
- step defaults, and an explicit step that differs from the tile size;
- every validation refusal, each with a companion asserting the adjacent legal
  value is accepted.

**`test/tiling-pattern.test.ts`** — end to end:

- the emitted operators for a colored fill (`/Pattern cs /P0 scn`) and for an
  uncolored one (`/Pattern /DeviceRGB cs`, then `r g b /P0 scn`);
- stroke beside fill, asserting operator case (`CS`/`SCN`);
- **a registration made inside the tile lands in the tile's `/Resources` and
  not the page's** — the seam §1 exists for, asserted on both dicts;
- one pattern used on two pages allocates **one** stream, asserted by object
  count, since that is the whole argument for `Document`-level creation;
- the uncolored refusals, and that the colored builder accepts the same calls.

**Acceptance:** render through `ToImage` and probe pixels — one inside a
painted module, one in the gap between tiles at a known lattice position. A
test asserting only that a `/Pattern` resource exists passes with the steps,
the matrix and the paint type all simultaneously wrong.

Every assertion is mutation-checked before the issue closes, per the repo rule
that a fixture passing on the first run is not evidence. The three that a
plausible-looking wrong implementation still satisfies are the matrix
composition order, the step defaults, and the resource target — each is broken
deliberately and confirmed to redden its own case while leaving the others
green.

## Risks

- **The `pagecontent.ts` refactor is the whole risk of this issue.** Four
  helpers shared by `graphics.ts` and others move off `Page`. The fence above
  is the only thing standing under it, which is why it is written first.
- **The `PageGraphics` base split touches the most-used authoring class in the
  repo.** Its public surface must not move; the fence covers the emitted bytes,
  and `npm run typecheck` covers the surface, but a subclass split is the kind
  of change that is easy to get subtly wrong in the state stack or the CTM
  tracking. Both live in the base, undivided, for that reason.
- **`{ x, y, rotation }` may prove insufficient** for someone who wants a
  skewed lattice. That is the deferred raw-matrix escape hatch, and it can be
  added without moving anything, since it would compose into the same
  `/Matrix` slot.

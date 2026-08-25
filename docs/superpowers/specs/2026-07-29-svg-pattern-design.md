# SVG `<pattern>` embedding — design

Issue: `aspose-pdf-foss-for-ts-1gg0.19` (epic `1gg0`, page-furniture & text-authoring
parity gaps). Date: 2026-07-29. Deferred from `1gg0.3`; the last unimplemented
paint server, after gradients landed in `1gg0.7`.

## Scope

`page.AddSVGObject` reports `pattern` in `skipped` and paints nothing where a
`fill="url(#p)"` names one — following the "never fall back to black" rule from
`1gg0.3`, so today a pattern-filled shape is visibly missing rather than wrongly
solid.

v1 maps `<pattern>` onto a PDF **PatternType 1 (tiling)** pattern, covering:

- **Tile geometry** — `x`, `y`, `width`, `height` under `patternUnits`
  (`objectBoundingBox` default, `userSpaceOnUse`), and `patternContentUnits`
  (`userSpaceOnUse` default, `objectBoundingBox`).
- **Placement** — `patternTransform`, and `viewBox` + `preserveAspectRatio`
  (which override `patternContentUnits`).
- **Inheritance** — `href` / `xlink:href` between pattern elements, exactly as
  gradients already do.
- **Content** — anything the walker can already draw: shapes, groups, `use`,
  clip paths, gradients, **text** (`1gg0.8`), and **nested patterns**, behind a
  reference cycle guard.
- **`overflow: visible`** — content spilling across tile boundaries.

Out of scope: `PaintType 2` (uncoloured) patterns, which SVG has no expression
for.

## Three facts that shaped the design

### 1. A tiling pattern is a stream, so the walker cannot build one

This is the whole difficulty, and it is not the one the issue text names.

`svggradient.ts` builds a shading pattern as a **direct dict** and hands it to
`Emitter.patKey`, which is why `svgdraw.ts` can stay free of PDF plumbing — it
allocates nothing, and `/ExtGState` and shading-pattern entries are direct
objects in the form's own `/Resources`.

A PatternType 1 pattern **is a content stream**, and streams must be indirect
objects in PDF. So the walker cannot produce one at all. Only `svgembed.ts` may
allocate.

This is precisely the font problem from `1gg0.8`, and it takes the same shape:

```ts
/** Allocates a tiling-pattern content stream and returns its reference.
 *  svgembed.ts implements it, because a PatternType 1 pattern IS a stream and
 *  streams must be indirect objects. Mirrors SvgFontProvider, for the same
 *  reason and with the same division of labour. */
export interface SvgTileSink {
  tile(dict: PdfDict, content: string): PdfObject;
}
```

The rejected alternative was returning tile data in `DrawResult` and allocating
after the walk, which would keep `svgdraw.ts` strictly allocation-free. Nesting
kills it: an outer tile's `/Resources` must already reference the inner tile's
object, so it would need placeholder keys and a patch pass over a tree. The sink
allocates innermost-first as the recursion unwinds, and nesting needs no special
handling at all.

### 2. Tile content is a separate stream with its own resources

A pattern's content stream cannot see the enclosing form's `/Resources`. So tile
content needs a **child `Emitter`**: sharing `ids`, `css`, `fonts`, `skipped`,
the sink and the cycle-guard set, but with fresh `out`, `extg`, `pat` and
`patKeys`.

The resource-assembly currently inlined at the end of `drawSvg` is extracted, so
the form and every tile build theirs identically. A font used only inside a tile
lands in that tile's `/Font`, not the form's — which is the observable
consequence, and gets its own test.

### 3. `canon` has no `ref` case, and tiles are the first refs

```ts
function canon(v: PdfObject): string {
  if (v instanceof Map) …
  if (Array.isArray(v)) …
  if (… v.kind === 'name') return `/${v.name}`;
  return String(v);                 // <- a PdfRef lands here
}
```

`PdfRef` is `{ kind: 'ref', num, gen }`, so `String(v)` is `[object Object]` for
**every** reference. Nothing puts a ref in a pattern dict today, so the bug is
dormant; the moment tiles do, two unrelated tiles canonicalize identically and
`patKey` returns the first one's key for the second — which silently paints the
wrong tile.

A `ref` branch lands **before** any pattern work, with its own regression test.

## Modules

- **`src/svgpattern.ts`** — NEW. Resolves a `<pattern>` element: `href`
  inheritance, unit resolution, and the tile rect → `/BBox`, `/XStep`,
  `/YStep`, `/Matrix`. Pure arithmetic; mirrors `svggradient.ts`'s role, and
  deliberately separate from it because neither reads the other's attributes.
- **`src/svgdraw.ts`** — the `canon` fix, the child `Emitter`, extracted
  resource assembly, and the paint path learning about patterns.
- **`src/svgembed.ts`** — implements `SvgTileSink`.
- **`src/svgtext.ts`** — unchanged; text inside a tile works because the child
  emitter carries the same `fonts` provider.

## Geometry

| SVG | PDF |
|---|---|
| `x`, `y`, `width`, `height` | the tile rect; `width`/`height` become `/XStep`, `/YStep` |
| `patternUnits="objectBoundingBox"` (default) | fractions of the shape's bbox, via the existing `bboxMatrix` |
| `patternUnits="userSpaceOnUse"` | user units, percentages against the viewport |
| `patternContentUnits="userSpaceOnUse"` (default) | content drawn as authored |
| `patternContentUnits="objectBoundingBox"` | a bbox scale folded into `/Matrix` |
| `patternTransform` | composed into `/Matrix`, same order as `gradientTransform` |
| `viewBox` (+ `preserveAspectRatio`) | overrides `patternContentUnits`; reuses `placementMatrix` |

`/Matrix` composes as `patternTransform · tilePlacement · ctm`, matching
`svggradient.ts`'s `patternMatrix` so the two paint servers cannot drift.

**No extra y-flip.** Pattern space is the enclosing content stream's space, which
is this stack's y-down space — the same assumption gradients already make, and
the same reason `1gg0.3` put the flip in `placementMatrix` alone.

### `overflow: visible`

The one entry that is not a mapping. PDF **always** clips a cell to `/BBox`, so
spilling is expressed by making `/BBox` large enough to hold the ink while
leaving `/XStep`/`/YStep` at the tile size — adjacent cells then overlap and
content crosses boundaries.

That needs the tile's actual ink extent, so the child emitter accumulates a union
bbox as it paints: shapes through `segsBBox`, text through `glyphsBBox`, each
under the CTM in force.

**Stated plainly:** where spilled content overlaps a neighbouring cell, PDF leaves
the paint order between cells implementation-dependent, so the stacking is not
guaranteed to match a browser's. This is an approximation, not a skip, so it is
not reported — documented in the README beside the group-opacity one.

## Reporting

`pattern` stops being named in `skipped`. Two conditions that look like failures
stay unreported, following the precedent set for a stopless gradient in
`1gg0.7`:

| Condition | Reported |
|---|---|
| `<pattern>` with no children | *nothing* — SVG mandates the element is not rendered |
| zero or negative `width`/`height` | *nothing* — likewise |
| a `href` reference cycle | `pattern` |
| unsupported content inside a tile | that content's own name, via the shared `skipped` |

A pattern that resolves to nothing paints nothing, and the shape's other paint
still applies — the same rule `1gg0.3` set for an unresolvable paint reference.

## Errors

No new error conditions.

## Testing

`svgpattern.ts` carries the pure weight: unit resolution under both
`patternUnits` values, the tile rect, matrix composition order,
`patternContentUnits`, `viewBox` fit, `href` inheritance including the
attribute-merge rules, and the degenerate sizes above.

`svgdraw.ts`: the nested stream emitted with its own `/Resources`; a tile's font
landing in the **tile's** `/Font` and not the form's; the cycle guard
terminating; `skipped` propagating out of a tile; a nested pattern; and the
`canon` regression — two tiles with different content must not collapse to one.

`svgembed.ts`: the pattern resource is an **indirect ref to a stream**, where a
shading pattern stays a direct dict — the observable difference between the two
paint servers. Plus a `Save`/`Open` round trip.

### This one has a real independent reader

Unlike `1gg0.11`, where nothing in the repository could disagree with our CSS
interpretation, `raster.ts` implements tiling patterns **itself** — `blitTile`
replicates an offscreen cell across the clip bbox on the pattern lattice, using
its own reading of `/Matrix`, `/XStep` and `/YStep`.

So a checkerboard tile rendered through `Save`/`Open`/`ToImage` and sampled at
known cell centres is a genuine cross-implementation check: our writer against a
reader written separately. That is what CLAUDE.md's differential rule asks for,
and it is the strongest verification available here.

It covers what operator assertions cannot: the tile matrix, the `XStep`/`YStep`
spacing (a checkerboard sampled at four cell centres proves the lattice, not just
the first cell), and `overflow: visible` spilling past a cell boundary.

Mutation-prove, per the repo rule: the `canon` ref fix, and the
`/BBox`-versus-`/XStep` split that makes `overflow: visible` work.

## Documentation

`README.md`: remove `<pattern>` from the SVG not-rendered list, describe the
supported attribute set, and record the `overflow: visible` stacking
approximation beside the group-opacity one.

## Follow-ups

None proposed. `1gg0.13` (real-world SVG fixture with provenance) remains the
outstanding verification item for the SVG stack as a whole.

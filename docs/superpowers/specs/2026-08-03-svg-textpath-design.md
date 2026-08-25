# SVG textPath — text along a path

Issue: `aspose-pdf-foss-for-ts-1gg0.20` (epic `1gg0`). Deferred from `1gg0.8`.

## Problem

`page.AddSVGObject` does not render `<textPath>` at all. `walkText`'s child
dispatch (svgtext.ts) recognises `tspan`, the non-rendering `title`/`desc`/
`metadata`, and drops everything else:

```ts
} else if (kid.name === 'tspan') {
  walkText(ctx, kid, paint, style, ws, here);
} else if (kid.name === 'title' || kid.name === 'desc' || kid.name === 'metadata') {
  // Non-rendering: not a fidelity loss, so not reported.
} else {
  ctx.skipped.add(kid.name);
}
```

So a `<textPath>`'s characters are discarded — not laid out on the baseline,
not drawn — and `textPath` lands in `result.skipped`.

## What this covers

All of SVG 2's `textPath` **except** `method="stretch"`:

- `href` / `xlink:href` to a `<path>`
- SVG 2 inline `path="M…"`
- `startOffset`, as a length or a percentage of path length
- `side="left" | "right"`
- `spacing="auto" | "exact"` — accepted; `auto` renders as `exact`
- `method="stretch"` renders as `align` and reports

`method="stretch"` is deliberately excluded and gets its own issue; see
**Out of scope**.

## Design

### 1. Where it plugs in

`<textPath>` becomes a recognised child that recurses exactly like `tspan`, so
style inheritance, nested tspans, the `x`/`y`/`dx`/`dy`/`rotate` lists and
`textLength` all keep working unchanged. It additionally records its path on the
owner `walkText` already allocates:

```ts
export interface TextPathSpec {
  /** id from href / xlink:href, '#' stripped. null when absent. */
  href: string | null;
  /** SVG 2 inline path data. null when absent. Wins over href when both. */
  inline: string | null;
  /** Raw attribute text; resolved against the path length at map time, so a
   *  percentage does not need the geometry at parse time. */
  startOffset: string;
  side: 'left' | 'right';
  /** method="stretch": rendered as align, and reported. */
  stretch: boolean;
}

export interface OwnerSpec {
  textLength?: number;
  spacingAndGlyphs: boolean;
  path?: TextPathSpec;
}
```

### 2. A textPath starts a new anchored chunk

`placeChars` already receives the whole `FlatText`, so it can read `f.owners`
and open a new chunk when a glyph's `chain` enters a path owner that the
previous glyph's `chain` did not contain. The cursor resets to 0 there, because
inside a textPath `x` means *distance along the path*, not a position in the
element's user space.

Without this, `<text>before<textPath href="#p">on path</textPath></text>` would
put both runs in one anchored chunk: `text-anchor` would be computed across the
combined width, and the path text would start dragged along by the width of
"before".

Because membership is by `chain`, mixed content works rather than being
forbidden — a textPath beside ordinary tspans in one `<text>` lays each out in
its own space.

### 3. New module: `svgtextpath.ts`

Pure — no PDF objects, no `Document` — mirroring `svgmask.ts` and
`svgpattern.ts`:

```ts
export interface PathMetrics {
  pts: { x: number; y: number }[];
  /** Cumulative arc length at each vertex; cum[0] === 0. */
  cum: number[];
  total: number;
}

export function measurePath(segs: SvgSeg[]): PathMetrics;
export function pointAt(
  m: PathMetrics, dist: number,
): { x: number; y: number; angle: number } | null;
export function mapGlyphsToPath(
  glyphs: PlacedGlyph[], onPath: (g: PlacedGlyph) => boolean,
  m: PathMetrics, startOffset: number,
): PlacedGlyph[];
```

`measurePath` flattens cubics with `flattenCubic` from `strokegeom.ts` — already
the shared Bézier flattener both renderers use, so textPath does not introduce a
second one — and accumulates segment lengths into `cum`.

`pointAt` binary-searches `cum`, lerps between the bracketing vertices, and takes
the angle from that segment's direction. It returns `null` for a distance before
0 or past `total`.

`mapGlyphsToPath` returns a **filtered** array rather than mutating in place:
SVG 1.1 §10.13.3 makes a glyph whose midpoint falls off the path *not rendered*,
and dropping a glyph cannot be expressed by mutating it.

### 4. The placement rule

For each glyph the distance along the path is taken at the **midpoint of its
advance**, not at its origin:

```
d = startOffset + g.x + g.adv / 2
```

`pointAt(d)` yields a point and a tangent angle. The glyph is placed so its own
midpoint lands on that point: origin = point − (adv/2) along the tangent,
displaced by `g.y` along the normal — which is how `dy` and `baseline-shift`
reach the result — with `g.rot` set to the tangent angle plus whatever `rotate=`
the author already applied.

`applyAnchors` runs *before* this pass, so its shift of `x` within the chunk
converts directly into a shift along the arc: `text-anchor="middle"` centres the
run about `startOffset` with no path-specific anchor code.

`startOffset` resolves as a length, or as a percentage of `m.total`.

`side="right"` reverses the polyline before measuring, which flips both the
traversal direction and the normal — the whole of what SVG 2 means by rendering
on the other side. `startOffset` is then measured from the **reversed** start,
so the two attributes compose without a special case.

A negative `startOffset` needs no handling of its own: it pushes early glyphs to
a distance below 0, where `pointAt` returns `null` and they are dropped, which is
what SVG requires.

Each path owner is mapped independently — `svgdraw.ts` loops the owners carrying
a `TextPathSpec` and calls `mapGlyphsToPath` once per owner, with a predicate
matching that owner's `chain`. Two textPaths in one `<text>` therefore each get
their own geometry, and glyphs belonging to neither stay on the baseline.

**Consequence:** per-glyph `rot` makes `sameRun` break after every glyph, so a
path run emits one `Tm` + one `Tj` per glyph instead of one per run. `showOps`
already handles a one-glyph run, so this needs no new code, but the content
stream grows proportionally. The text stays real text — extractable and
searchable — which is the property `method="stretch"` would have cost.

### 5. Decoration must rotate with the run

`decorationOps` builds an axis-aligned rect from `run[0].x`/`run[0].y` and
ignores `rot`, even though its own run grouping requires equal `rot`. Verified
on the current tree: an underline under `rotate="45"` emits
`0 51.2 32 0.8 re` — byte-identical to the unrotated case — while the glyph `Tm`
correctly carries the rotation.

textPath cannot route around this, since every glyph on a path is rotated, so
the fix is a prerequisite rather than an optional extra. It also repairs
`rotate=` on ordinary text.

The fix reuses `textMatrix` as the decoration's frame:

```
q  <textMatrix(x, y, rot)> cm
   0 <offsetEm*size - t/2> <w> <t> re  f
Q
```

In that frame local `+x` runs along the baseline and local `+y` is glyph-up,
which is the space the vmetrics offsets are already expressed in — so the
explicit y-down sign flip disappears into the matrix.

**At `rot = 0` the emitted geometry is unchanged**, which is the regression
guard: existing decoration output must stay byte-identical.

On a curve, each glyph being its own run yields one short rotated rect per
glyph, so the underline becomes a polyline hugging the path.

### 6. Where the path is resolved

`svgdraw.ts` resolves `href` → the `<path>` element → its `d` → `SvgSeg[]` via
`parsePath`, because `e.ids` lives there. `svgtext.ts` stays `Document`-free,
the same seam it already uses for fonts through `SvgFontProvider`.

The referenced path's own `transform` is **ignored**: SVG 1.1 §10.13.3 places
the path data in the user space of the `textPath` element, and browsers agree.

## Degradation and reporting

Following the established rule that SVG-mandated outcomes are silent while
fidelity losses report:

| Case | Renders | `skipped` |
|---|---|---|
| `href` missing, dangling, or not a path | on the baseline, as a plain tspan | `textPath` |
| Inline `path=` that parses to **no segments** | on the baseline, as a plain tspan | `textPath` |
| `method="stretch"` | as `align` | `textPath` |
| Glyph midpoint past either end of the path | that glyph alone is dropped | — (SVG mandates) |
| Path that parses but has **zero length** (e.g. `path="M0 0"`) | nothing | — (SVG mandates) |
| `spacing="auto"` | as `exact` | — (the spec permits the discretion) |

The two path-shaped failures are deliberately separated. *No segments* means
there is no geometry to place text on, which is the same situation as a dangling
`href` and degrades the same way. *Zero length* means the author supplied real
geometry that happens to have no extent, which SVG defines as rendering nothing
— the same distinction the filter path already draws between an unresolvable
filter and a zero-area filter region.

Rendering an unresolvable textPath on the baseline diverges from SVG 1.1, which
renders nothing. It matches this library's house rule instead — CLAUDE.md's
filter invariant is explicit that visible ink beats silently dropped content,
and an unresolvable filter already degrades to unfiltered rather than to
nothing. A typo'd id costing an author a whole run of text is the outcome being
avoided.

## Testing

### `test/svg-textpath.test.ts` — units and structure

- `measurePath`: cumulative lengths on a straight line, on a polyline, and on a
  cubic (against the analytic length of a flattened quarter circle, within
  tolerance).
- `pointAt`: endpoints, midpoint, and `null` past either end.
- The chunk rule: `<text>before<textPath>…` puts the path text in its own chunk,
  and `text-anchor` does not span the two.
- Every row of the degradation table.
- Structure: a textPath run emits one `Tm` per glyph.

### `test/svg-textpath-render.test.ts` — the load-bearing assertions

Text on a **vertical straight path**. The mapping is exactly computable — glyph
*i* sits at `y0 + d`, rotated 90° — and the failure mode is unmistakable: ink
lands in a vertical band where an unmapped fallback would lay it horizontally.
That is an internal check on geometry we can predict in closed form, not a diff
against our own producer.

A second fixture on a semicircle confirms the tangent actually turns rather than
staying constant.

### Proving the tests load-bearing

Per the repo rule, passing on the first run is not evidence. Three mutations,
each of which must turn a specific test red:

1. Skip `mapGlyphsToPath` entirely → the vertical-band test.
2. Use `g.x` instead of `g.x + g.adv / 2` → the exact-placement assertions,
   which must catch the half-advance shift.
3. Revert the decoration frame to the axis-aligned rect → a `rot=90` decoration
   test.

## Docs

- README: replace "`<textPath>` is **not** rendered — it is skipped and named in
  `result.skipped`" with what now ships, including the `method="stretch"` and
  bad-href degradations.
- `src/page.ts` carries the same claim in the `AddSVGObject` doc comment; update
  it too.

## Out of scope

`method="stretch"` got its own child issue under `1gg0` (`1gg0.25`) and has
since shipped; see `2026-08-03-svg-textpath-stretch-design.md`. It needed a
glyph-outline seam on `SvgFace` (whose `FontDriver` exposed only
`measure`/`encode`/`probe`), outline warping along the curve, and vector-path
emission instead of text operators — which appeared to cost the text
extractability every other part of this stack preserves. Outline extraction
existed in `raster.ts` and `sfnt.ts`, but on the *rendering* side, a different
seam from SVG authoring.

What resolved the extractability objection was emitting the same run a second
time in text rendering mode 3, invisibly, behind the warped contours.

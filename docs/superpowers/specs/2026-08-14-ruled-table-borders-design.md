# Ruled table borders and shading — recovery and export

Design for `aspose-pdf-foss-for-ts-8yt9.3`, the third child of the
`PDF to DOCX export` epic (`8yt9`). `8yt9.2` shipped the `w:tbl` grid, spans,
header-row repetition and nesting; this issue replaces the uniform single-line
frame it emits with the borders and shading the page actually carried.

## Problem

A ruled table on a page states more than its grid. It states which edges are
drawn, how thick, in what colour, and which cells are shaded. None of that
survives extraction today:

- **`Rule` is `{ pos, lo, hi }`** (`table.ts:17`). `MAX_RULE_THICK` collapses a
  thin filled rectangle to a centerline, deliberately discarding its thickness,
  and a stroke's `lineWidth` is never read at all.
- **`PathEvent` carries no colour** (`text.ts:255`) — `stroke` and `fill` are
  booleans. The walker the detector runs on cannot see a colour even in
  principle.
- **`TableCell` has no border or shading fields.** Cell backgrounds are not
  collected by anything: `rulesFromPath` discards every fill that is not thin.

So `docxtable.ts` has nothing to emit and draws the same single-line frame on
every table. A table ruled only between its rows exports as a full grid, and a
shaded header row exports as plain white — output that is confidently wrong
rather than visibly incomplete.

The data does exist elsewhere. `paths.ts`'s `PagePath` carries
`fill`/`stroke` as `PathPaint { rgb, space }`, a CTM-scaled `lineWidth`, and a
device-space `bbox`. It is a second, colour-aware content walker
(`page.GetPaths()`) that the table detector does not currently use.

## Approach

**Decorate after detect.** `table.ts`'s detector is left exactly as it is on
`visitContent`. A new pure module, `tableink.ts`, indexes the page's ink from
`page.GetPaths()` and answers two questions per cell — what ink lies on this
edge, and what fill lies under this rect. Detection therefore cannot regress,
because it does not change.

Two alternatives were considered and rejected:

- **Move detection onto `GetPaths()`.** One walker, colour available
  throughout. Rejected because the detector is the most heavily tested geometry
  in `src/` — nested tables, cross-page stitching, rotated frames, connected
  component partitioning — and `PagePath` has a different shape (`subpaths` in
  user space versus flattened device-space `segments`). That is a rewrite with
  real regression risk and no user-visible gain over decorating.
- **Add colour to `PathEvent`.** One walk, least new code. Rejected because
  `visitContent` is the shared walker behind struct validation, `docmodel.ts`,
  HTML fixed mode and the untagged builder. Colour resolution needs a
  `Document` and real colorspace work, which `paths.ts` already implements;
  every consumer would pay for a colour it never reads.

A note on why `tableink.ts` cannot lean on `PagePath.bbox` for strokes: a grid
drawn as ONE stroked path has a single bbox covering the whole table. Stroked
edges must come from `subpaths` transformed through the path's own `ctm`.
`bbox` is used only for fills, where it is exactly the rectangle wanted.

## Scope

In scope:

- `src/tableink.ts` (new) — the pure ink index.
- `src/tablemodel.ts` — `CellBorder`, `CellBorders`, `TableCell.borders`,
  `TableCell.shading`; and `toHtml` emitting them.
- `src/table.ts` — decorate built cells with recovered ink.
- `src/docxtable.ts` — per-cell `w:tcBorders` and `w:shd`.
- `test/`, `README.md`, `CLAUDE.md`.

Out of scope: textbox mode (`8yt9.4`); dash patterns, which `PagePath` does not
record; recovering borders for a *tagged* table, which has no geometry to
recover from; and `Table.toMarkdown`, since GFM cannot express a border.

## `tableink.ts`

```ts
export interface InkEdge { pos: number; lo: number; hi: number; width: number; color: Rgb }
export interface InkFill { rect: Rect; color: Rgb }
export interface PageInk { horiz: InkEdge[]; vert: InkEdge[]; fills: InkFill[] }

export function collectPageInk(paths: PagePath[], minLen: number, maxThick: number): PageInk;
export function edgeAt(
  ink: PageInk, axis: 'h' | 'v', pos: number, lo: number, hi: number, tol: number,
): InkEdge | undefined;
export function fillUnder(ink: PageInk, rect: Rect, tol: number): InkFill | undefined;
```

`Rgb` and `Rect` are the existing types — `Rgb` from `colorspace.ts` (which
`paths.ts` already re-exports through `PathPaint`), `Rect` from
`tablemodel.ts`.

It takes `PagePath[]` as an argument and imports no PDF object module, so every
rule below is testable without building a file — the split `floatstack.ts`,
`booklet.ts` and `docinfer.ts` already make. `table.ts` calls `page.GetPaths()`
and hands the result over.

**Invariant:** the tolerances are ARGUMENTS, not constants of this module.
`table.ts` owns `SNAP`, `MIN_RULE_LEN` and `MAX_RULE_THICK` and passes them in,
so the detector and the ink index cannot come to disagree about what "the same
edge" or "thin enough to be a rule" means. A private copy here is two constants
that drift, and the drift shows up as a border on some edges and not others.

Edges come from the two sources `rulesFromPath` already distinguishes, and for
the same reasons: a **stroke** contributes its axis-aligned `move`/`line`
segments transformed through the path's `ctm`, taking `lineWidth` as the width
and `stroke.rgb` as the colour; a **thin fill** contributes its centerline,
taking its min side as the width and `fill.rgb` as the colour. Cubics are
skipped — a rule is never a curve.

**Invariant:** a fill claims a cell only when EACH of its bbox's four edges is
within `tol` of the cell rect's corresponding edge — never merely containing
it. A page background, a full-table wash and a shaded header cell are all
filled rectangles, and a containment test paints the entire table grey the
moment a producer lays a background behind it. Where several fills qualify, the
LAST in content order wins, since that is the one painted on top.

**Invariant:** an edge must SPAN the cell side it is claimed for — `lo <= side
start + tol` and `hi >= side end - tol` — not merely touch or overlap it. A
short rule under one column does not border the cell beside it. This is the
same test `coveredH`/`coveredV` already apply in the detector.

**Invariant:** `collectPageInk` is called once per page and memoized. A table
has cells × 4 edges to resolve and a page may hold several tables; walking the
content per query is the shape that turned an N-figure page into N content
walks in `no93.1`.

## Model additions

```ts
/** One drawn cell edge. `width` is in points; `color` absent means the ink
 *  carried none. */
export interface CellBorder { width: number; color?: Rgb }
export interface CellBorders {
  top?: CellBorder; right?: CellBorder; bottom?: CellBorder; left?: CellBorder;
}
// on TableCell:
borders?: CellBorders;
shading?: Rgb;
```

**Invariant — the one this whole design rests on:** `borders` ABSENT means *not
recovered*; an edge missing from a PRESENT `borders` means *measured absent*.
A tagged table, a rotated table, and a page whose ink could not be read are the
first; a genuine gap in the ruling is the second. They want opposite
renderings — the first must fall back to the frame that ships today, the second
must draw nothing — and collapsing them is the mistake CLAUDE.md already
records twice: `parseSimpleWidths` losing the difference between a
`/MissingWidth` of zero and no `/MissingWidth` at all, and `Table.toMarkdown`
distinguishing a table that reports no header from one that carries no header
information.

**Invariant:** recovery is skipped entirely for a rotated table
(`table.angle !== 0`). Cell quads are in the table's own upright frame while
ink is in page space, and mapping between them is a second geometry with its
own failure modes. For a feature whose absence degrades cleanly to the current
frame, that trade is not worth taking — and `borders` being absent is exactly
how the model already says so.

## DOCX emission

Per cell, inside `w:tcPr`:

```xml
<w:tcBorders>
  <w:top w:val="single" w:sz="6" w:color="333333"/>
  <w:left w:val="none"/>
  ...
</w:tcBorders>
<w:shd w:val="clear" w:color="auto" w:fill="EEEEEE"/>
```

`w:sz` is in EIGHTHS of a point, so `sz = clamp(round(width * 8), 2, 96)`.
Colour is uppercase `RRGGBB`, or `auto` when the ink carried none.

**Invariant:** `w:tcPr`'s children are schema-ORDERED, not free: `tcW`,
`gridSpan`, `vMerge`, `tcBorders`, `shd`. Wrong order produces a file Word
rejects outright. The current emitter is in order only by accident, which is
why this is written down rather than left to the next person to append safely.

**Invariant:** a recovered table OMITS the table-level `w:tblBorders` and
states all four edges on every cell, present or `none`. Keeping both leaves two
sources for one edge with Word's specificity rules deciding between them, which
is what makes "why is this border here" unanswerable.

**Invariant:** an unrecovered table emits exactly what ships today — the
uniform `w:tblBorders` frame, byte for byte. That is what makes this change
additive rather than a rewrite of every existing export.

## HTML emission

`Table.toHtml` gains an inline `style` on `td`/`th` when the cell was
recovered: `border-top: 0.75pt solid #333333` per edge, `border-*: none` for a
measured-absent edge, and `background-color` for shading. An unrecovered cell
emits no `style` attribute at all.

**Sequencing, which is what keeps the fence usable:** the extraction and model
change lands FIRST, with the HTML and Markdown snapshots green — that green is
the evidence the model extension moved nothing by accident. HTML emission lands
as a SEPARATE commit whose snapshot churn is entirely intended. Combined in one
commit, a snapshot diff could no longer distinguish an extraction bug from the
new rendering, which is the whole value the snapshots have.

## Testing

Most of it is pure, building no PDF — `tableink.ts` driven from hand-built
`PagePath[]`:

- a stroked grid drawn as one path, yielding an edge per segment rather than
  one bbox-sized edge;
- a thin filled rule, yielding its centerline and its min side as width;
- the ambiguous fill: a page-sized background that must claim NO cell, beside a
  header-sized fill that must claim exactly one;
- a short rule that must not border the cell beside it;
- colour carried from `stroke.rgb` and from `fill.rgb` respectively.

Above that, a `PageGraphics`-drawn ruled table with a shaded header row through
real extraction, asserting the recovered `borders` and `shading`. Then
`docxtable.ts` on both branches: a recovered table emitting per-cell borders and
no `w:tblBorders`, and an unrecovered one byte-identical to today's output.

Per CLAUDE.md each new path is broken and the suite confirmed red rather than
trusted on first green. Mutations to run: make `fillUnder` a containment test
(the ambiguous-fill case must go red); drop the span requirement from `edgeAt`;
treat absent `borders` as "no borders" rather than falling back to the frame;
emit `w:sz` in points rather than eighths; emit `tcBorders` after `shd`; keep
`w:tblBorders` on a recovered table; and read `PagePath.bbox` for a stroked
path instead of its subpaths.

## Limitations, stated rather than implied

**No dash patterns.** `PagePath` records no dash array, so every recovered
border emits `single` — a dashed rule becomes a solid one.

**Rotated tables are skipped**, and report `borders: undefined` rather than a
guess.

**A tagged table has no geometry**, so `AddTable({ tagged: true })` output
round-trips *worse* here than an untagged table. That is counterintuitive
enough to be worth stating: the structure tree records what a cell IS, never
what it looked like.

**Word compatibility is still unverified in CI**, unchanged from `8yt9.1`.

## Documentation

- `README.md` — the DOCX table limitation is rewritten: borders and shading are
  now recovered from the ruling geometry, with the dash, rotation and tagged
  caveats above.
- `CLAUDE.md` — a Source-list entry for `tableink.ts` carrying the
  fill-ambiguity and span invariants, the `tablemodel.ts` entry gaining the
  absent-versus-measured-absent rule, and the `docxtable.ts` entry gaining the
  `w:tcPr` ordering and the omitted `w:tblBorders`.

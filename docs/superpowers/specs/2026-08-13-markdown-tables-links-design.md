# Markdown tables and links in flow

Design for `aspose-pdf-foss-for-ts-gl6o.3.3`, the last of three pieces of
`gl6o.3` (Render Markdown into Flow and directly onto a page), itself the third
child of the `gl6o` epic. It stands on `gl6o.3.1` (rich inline runs) and
`gl6o.3.2` (the AST-to-Flow mapping), and is followed by `gl6o.4` (tagged
Markdown for PDF/UA).

## Problem

`gl6o.3.2` shipped `AddMarkdown` with two constructs deliberately unrendered,
each naming itself in the `skipped` report rather than vanishing:

- **A table** is dropped whole. `mdflow.ts` returns `[]` for `'table'`.
- **A link** renders its *words*, styled blue and underlined, but places no
  `/URI` annotation. `mdruns.ts` sets colour and underline from a
  `link: boolean` state and throws the destination away.

Neither is a walk problem. Both are missing machinery a layer down:

**There is no flow table element.** `page.AddTable` is page-positioned: its
pagination loop reads the anchor page's `CropBox`, decides where the bottom line
is, and appends pages itself. A flow element is handed a rect and must report an
overflow; the two models contradict each other. What Flow lacks is not a table
model — `TableBuilder` already has row measurement, a `continuationFrom(row)`
remainder, and repeating headers — but an element that drives them against a
column.

**Layout knows where a run landed and tells nobody.** `layoutRuns` splits each
line into `LaidSegment`s tagged with the run they came from, and
`buildRunBlockBody` computes each segment's x, baseline and width in order to
emit it. That geometry — everything a `/Link` rect needs — is discarded the
moment the bytes are written.

**A table cell holds a `string`.** `CellBuilder.text` is plain text, so
`| **bold** | [docs](/u) |` — ordinary GFM — would render flat and grey with the
link silently gone, even after the two problems above were solved.

## Scope

In scope:

- `TextRun.link`, making a hyperlink a property of the rich-run text engine, so
  any rich-run text carries one — flow paragraphs, headings, list items, table
  cells, and `page.AddTextBlock`.
- `/Link` annotation placement at laid-out run positions, including a run that
  crosses a line break and a paragraph that paginates.
- A flow table element and `Flow.AddTable`, splitting by row across columns and
  pages with repeating headers.
- Table cells holding `TextRun[]`.
- The `MdTable` → `TableBuilder` mapping, with a `table` style group.
- Tagged output for both: `/Table` > `/TR` > `/TD`|`/TH` through the existing
  `tabletag.ts`, and a `/Link` element carrying the link text's MCIDs plus an
  `/OBJR`.

Out of scope, each for a stated reason:

- **PDF/UA conformance sweep.** `gl6o.4`. This work tags what it draws and keeps
  `ValidatePdfUa`'s `UntaggedContent` quiet for its own content; it does not
  chase the rule set.
- **`/Code` and `/BlockQuote` structure types.** Filed as `xsmk`; they belong to
  the blocks `gl6o.3.2` shipped, not to this one.
- **Per-line leading.** Filed as `g61q`, inherited from `gl6o.3.1`.
- **Inline images.** Still alt text, still reported. An inline raster at line
  height is a layout feature neither half of this issue needs.
- **Raw HTML.** Out of scope by design since `gl6o.1`.
- **Nested tables and cell images from Markdown.** GFM has no syntax for either;
  `TableBuilder` supports both for hand-built tables and keeps doing so.

## Architecture

Two independent halves sharing one new idea — that a laid-out run has a position
worth reporting.

```
── the link half ────────────────────────────────────────────────
textdecor.ts   TextRun.link?: string        vocabulary (one field)
layout.ts      (unchanged)                  LaidSegment already tags its run
stamp.ts       runLinkBoxes()               pure geometry
               buildRunBlockBody()          nested BDC/EMC around link runs
runlink.ts     placeRunLinks()      NEW     boxes → /Link annots + structure
mdruns.ts      InlineState.link: string     carry the destination, not a flag

── the table half ───────────────────────────────────────────────
tableauthor.ts CellBuilder.text: string | TextRun[]
tablerender.ts paintRowSlice()      extracted from drawTable's closure
flowtable.ts   table(builder, opts) NEW     the FlowElement + Flow.AddTable
mdstyle.ts     style.table                  border, header fill, padding, size
mdflow.ts      case 'table'                 MdTable → TableBuilder
```

### The link half

**Vocabulary.** `TextRun` gains `link?: string`, validated beside the existing
decoration options — a non-empty string, rejected before anything is allocated.
It lives in `textdecor.ts` because that module already owns the run model.

`mdruns.ts`'s `InlineState.link` changes from `boolean` to
`string | undefined`, carrying the destination. `stateKey` folds it in, so two
adjacent links to different destinations stay two runs rather than merging into
one that would link the whole phrase to the second URI.

**Geometry.** A new `runLinkBoxes(lines, runs, x, w, baseline0, o)` in
`stamp.ts`, a sibling of `blockLineBoxes`, walks each laid line's segments in
order:

```
penX = x + alignOffset(o.align, w, line.width)
for each seg of line.segments:
    if runs[seg.run].link:
        emit { run: seg.run, x: penX, width: segWidth, baseline, top, bottom }
    penX += segWidth
```

where `segWidth = seg.width + tw × (spaces in seg.text)` and `tw` is the
`justifySpacing` value the emitter itself uses. Reading `tw` here rather than
`seg.width` alone is what makes a justified line's rects land on the drawn
glyphs instead of the measured ones — the same correction `blockLineBoxes`
already makes for decoration, where it widens a justified line's box to the full
`w`.

Vertical extent comes from `vmetricsFor(run.font)` scaled by the run's own
`fontSize`. **A link rect is exactly the box the `background` decoration
computes**, so the two read one geometry rule rather than growing a second; this
is the same consolidation `textdecor.ts` exists to make for underline,
strikethrough and background.

**Ink and structure.** `flowTextBlock` and `stampTextBlock` call
`placeRunLinks` themselves. They already take `doc` and `page`, so putting the
call there means no caller changes and no chance of a caller forgetting;
`measureTextBlock`, the dry run, never calls it, which is what keeps measurement
free of side effects.

`runlink.ts` owns the whole "a laid-out run becomes an annotation":

- one `addLink({ rect, action: { type: 'uri', uri }, border: 0 })` per box —
  border 0 because the style already draws an underline, and a viewer-drawn
  frame on top would be a second, uglier one;
- when `options.tag` is present, a `/Link` element appended to it, carrying the
  link's MCIDs and the annotation via `AddAnnotation` (`/OBJR`).

**MCID splitting.** `buildRunBlockBody` opens `/Span <</MCID k>> BDC` before a
link run's segments and `EMC` after, nested inside the existing `BT`/`ET` —
legal, and the shape `tocstruct.ts` already produces by stamping a row's text
*into* its `/Link` element before attaching the annotation. A link crossing a
line break contributes several MCIDs to the one element, which `/K` handles
natively.

**Why `runlink.ts` is its own module.** `stamp.ts` is the layout-and-ink module
and is already large; annotation creation plus structure-tree wiring is
object-graph work — the split `redactannots.ts` makes against `redact.ts`. It
also holds `stamp.ts`'s dependency on `annotation.ts` to one symbol. Nothing in
`annotation.ts`'s transitive graph imports `stamp.ts`, so the edge closes no
cycle.

### The table half

**Cells take runs.** `CellBuilder.text` widens to `string | TextRun[]`. Both
consumers already have the arm they need: `TableBuilder.measure` calls
`measureTextBlock` and `paintPlaced`'s text pass calls `stampTextBlock`, each of
which has had a `TextRun[]` overload since `gl6o.3.1`. Links inside cells then
come free from the link half — a cell's `stampTextBlock` call places them like
any other block.

**A row-slice painter.** `drawTable`'s `paintRows` closure becomes an exported
`paintRowSlice(...)` that both `drawTable` and the new element call. This is a
pure extraction: `page.AddTable` must emit the same bytes afterwards.

**The flow element.** `table(builder, opts)` in `flowtable.ts`, with
`Flow.AddTable(builder, opts)` as the method. Its `place(ctx)`:

1. `resolveColumnWidths(ctx.width)` — a Markdown table declares no widths, and
   the default is already equal fractions;
2. `measure(widths)` → row heights;
3. take rows greedily while their cumulative height fits `ctx.availHeight`;
4. no rows fit → `{ usedHeight: 0, remainder: this, drew: false }`, letting the
   engine advance the column;
5. paint the slice through `paintRowSlice`;
6. remainder → `table(builder.continuationFrom(i), opts)`, which prepends the
   repeating header rows on its own.

`measure()` is implemented too, because the engine's keep-with-next lookahead
calls it on the element following a heading.

A row taller than an empty column reaches the engine's existing
`'element does not fit in an empty column'` throw — the same treatment an
oversized image gets today, so this adds no rule.

**Tagged pagination** reuses `tabletag.ts`'s `/Table` sharing: the remainder
element carries the live `TableTagger` forward, which is what keeps a split
table one `/Table` rather than two.

### Markdown mapping

In `mdflow.ts`, `case 'table'` builds a `TableBuilder`:

- `MdTable.align[c]` → the cell's `align`;
- `MdTableCell.children` → `inlineRuns(...)`, the same function paragraphs use,
  so bold, code spans, strikethrough and links behave identically inside a cell;
- `setRepeatingRowsCount(1)` when the table has a header row (in GFM that is
  always row 0, and only row 0), so a table split across a column repeats it.

Note what that last line makes unnecessary: `CellOptions.header` already
defaults to "cells in the repeating-header rows are column headers", so setting
`header: 'column'` explicitly would restate the documented default. The mapper
sets the repeat count and lets `/TH` with column scope follow from it — one
statement, not two that can drift apart.

This lives in `mdflow.ts` rather than a new module: it *is* "map a block to
elements", it is about forty lines, and an `mdtableflow.ts` sitting beside the
existing `mdtable.ts` (which parses GFM tables) would be two files whose names
differ only by where you look.

`mdstyle.ts` gains a `table` group — border colour and thickness, header
background, cell padding, font size — validated like every other group, with
documented defaults.

## Invariants

These are the rules that are silently wrong when broken, to be recorded in
`CLAUDE.md`:

- **A link rect and a text background are one geometry.** Both are the
  text-tight box around a run: `vmetricsFor` scaled by the run's own
  `fontSize`, not the block's. A second derivation drifts, and the drift is
  invisible until someone compares a link's clickable area with its underline.
- **A justified line's run positions are not its measured ones.** `tw` spreads
  slack across spaces, so a rect computed from `seg.width` alone marches left of
  the glyphs, further with every segment. `runLinkBoxes` must read the same
  `justifySpacing` the emitter reads.
- **The destination is part of the run's identity.** `stateKey` must fold in the
  URI, or two adjacent links merge into one run and the first destination is
  lost — a defect that renders perfectly and links wrongly.
- **`measureTextBlock` places no annotations.** It is the dry run the flow
  engine calls before deciding anything; placing annotations there would leave
  links behind for text that was never drawn.
- **A run list with no `link` emits byte-identical bytes.** The BDC/EMC split
  fires only for runs carrying one.
- **`page.AddTable` output is unchanged by the `paintRowSlice` extraction.**
- **A cell's runs go through `inlineRuns`, not a second inline mapper.** Two
  definitions of "what a Markdown inline looks like" is how a cell comes to
  render bold where a paragraph renders code.

## Error handling

Nothing here throws on document content — `mdflow.ts`'s existing rule. A link
with an empty destination (`[text]()`, which CommonMark accepts) renders as
styled text and names itself `'link'` in `skipped`, rather than placing a `/URI`
annotation pointing nowhere. A malformed table cannot reach the mapper:
`parseMarkdown` only produces an `MdTable` for input matching the delimiter-row
grammar.

Option validation throws `TypeError` before allocating, as everywhere else in
the authoring layer: `TextRun.link` must be a non-empty string, and the
`style.table` group validates in full before any element is built.

## Testing

- **Byte-identity, twice.** `test/rich-runs-identity.test.ts` gains a case
  asserting a run list with no `link` emits unchanged bytes, and a new
  assertion hashes `page.AddTable` output across the `paintRowSlice`
  extraction. Both must be shown to go red under a deliberate mutation, not
  merely observed green.
- **Link geometry checked against an independent path.** Each `/Link` `/Rect` is
  cross-checked against the quad `GetTextFragments()` reports for that text.
  Asserting the rect against the same arithmetic that produced it would cancel
  any bug out — the rule `cff.ts` follows in checking charstrings against
  `hmtx`. Left, centre, right and justify each get a case, since alignment is
  where `tw` and `alignOffset` can silently disagree.
- **Split cases.** A link crossing a line break (two rects, one `/Link`, two
  MCIDs); a link in a paragraph that paginates across columns (`sliceRuns`
  spreads the source run, so `link` survives — asserted, not assumed); a table
  splitting mid-body with and without a repeating header.
- **Tagged output.** Walk the tree rather than serializing it — it is cyclic —
  and assert a `/Link` carries both an `/OBJR` and its MCIDs, and that a
  paginated table yields one `/Table`, not two.
- **`ValidatePdfUa`** on a tagged flow containing a table and a link, since
  `UntaggedContent` is the rule this half exists to keep quiet.
- **`skipped`.** `test/markdown-render.test.ts`'s "reports what it skipped" case
  inverts: the table now renders, and the report is empty.
- **Cell runs.** A GFM table whose cells carry bold, code and a link, asserted
  on extracted text, on the emitted font keys, and on the placed annotation.

## Public surface

```ts
// textdecor.ts — one new field on the existing run model
interface TextRun {
  text: string;
  font?: AuthoringFont;
  fontSize?: number;
  color?: [number, number, number];
  link?: string;              // NEW: the /URI this run links to
}

// flowtable.ts — NEW module
export function table(t: TableBuilder, options?: FlowTableOptions): FlowElement[];
export interface FlowTableOptions {
  /** Total table width. Default: the full column width. */
  width?: number;
  /** Table-level cell padding override, as page.AddTable's. */
  cellPadding?: number;
  spaceBefore?: number;
  spaceAfter?: number;
  clear?: FlowClear;
}

// flow.ts
Flow.AddTable(t: TableBuilder, options?: FlowTableOptions): this   // chainable

// tableauthor.ts — widened, both arms already supported downstream
CellBuilder.text: string | TextRun[]
RowBuilder.addCell(text?: string | TextRun[], opts?: CellOptions): CellBuilder
TableBuilder.addRow(cells?: (string | TextRun[])[], opts?: RowOptions): RowBuilder

// mdstyle.ts — a new style group, every field optional
MarkdownStyle.table?: {
  border?: { color?: [number, number, number]; thickness?: number };
  headerBackground?: [number, number, number];
  padding?: number;
  fontSize?: number;
  spaceBefore?: number;
  spaceAfter?: number;
}
```

Exported from `index.ts`: `table`, `FlowTableOptions`. `TextRun` and
`TableBuilder` are already exported.

The table element is an ordinary `FlowElement`, so `page.AddMarkdown` and
`placeElements` get it with no further work — the property `gl6o.3.2` asserted
by rendering one source through all three entry points and comparing extracted
text, which extends to a source containing a table.

`README.md` gains the table and link entries under Markdown and the
`Flow.AddTable` row in the API overview; the Limitations sentence stating that
Markdown tables and links are not rendered is removed, and the surrounding
paragraph rewritten to state what remains unsupported (raw HTML, syntax
highlighting, inline images).

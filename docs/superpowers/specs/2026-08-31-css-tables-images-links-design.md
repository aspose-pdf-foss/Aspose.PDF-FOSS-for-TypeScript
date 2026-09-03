# CSS tables, images and links — design

Issue: `zch2.6`, under epic `zch2` (HTML to PDF conversion, `gap-vs-java`).
Date: 2026-08-31.

`zch2.2` closed with the CSS parser and cascade, `zch2.3` with the box model,
`zch2.4` with the lowering to `FlowElement[]`, and `zch2.5` with the three
`AddHtml` entry points. What ships today renders block and inline formatting
contexts, margins, padding, borders, backgrounds, headings and lists — and
reports tables, images and floats in `skipped`. This issue removes two of
those three reports. Float placement stays `zch2.10`'s.

Nothing here is exported from `index.ts` except one new option on
`HtmlFlowOptions`.

## Three findings that set the shape

Each was measured against the code before the design was written, which is
this repo's practice and has now corrected a design in four consecutive
issues.

### Links already work

`cssinline.ts` reads `<a href>` into `TextRun.link` and folds the destination
into the run merge key; `runlink.ts` turns a laid-out run into the `/Link`
annotation and its structure element. Driving
`<p>See <a href="https://example.com">the docs</a> here.</p>` through
`htmlElements` + `placeElements` produces **one `/Link` annotation** with rect
`[46.3, 755.4, 86.0, 766.2]`, an empty `skipped`, and the text
`See the docs here.`

So links need no implementation. They need a REGRESSION FENCE — nothing
currently pins behaviour that works by two modules composing — and one
decision, below.

### Images have a pattern to copy, and it is not a new one

`mdflow.ts` takes `resolveImage?: (destination, title) => Uint8Array |
undefined`, decodes `data:` URIs itself, and defers everything else to the
caller. That is how this library renders pictures while touching neither `fs`
nor the network, and it is what `HtmlFlowOptions` should mirror.

### The table box is EMPTY, and that is deliberate

`cssbox.ts`'s `boxFor` returns `{ kind: 'table', el, style, float, clear }`
and does not descend — its own recorded invariant says the anonymous-table
fixup "belongs with zch2.6, the issue that knows what a table becomes". So a
`TableBox` today has no content at all, and supplying it is the bulk of this
work.

## Where the work goes

```
cssbox.ts ──> (TableBox gains rows/cells) ──> csstable.ts ──> TableBuilder
                                                   │
cssflow.ts ────────────────────────────────────────┘
```

**`cssbox.ts` gains the descent.** CSS 2.1 §17.2.1 is literally about
generating anonymous BOXES, and that module already owns box generation and
holds the styles map — `buildBoxes` calls `computeStyles` itself. `TableBox`
gains `rows: TableRowBox[]`, each with `cells: TableCellBox[]`, and a cell is
an ordinary block container carrying the same `blocks | inline` content every
other box has. That is what makes a cell's bold, code and links behave
identically to a paragraph's; `mdflow.ts` records the same rule, that a second
inline mapper is how a cell comes to render bold where a paragraph renders
code.

**`csstable.ts` is a new pure leaf**: `TableBox` in, `TableBuilder` out.
`createTable` is document-free, so this module touches no `Document`, and
every rule below is testable from a hand-built box tree.

**`cssflow.ts`** loses `c.skipped.push('table')` and gains one call.

Two alternatives were rejected. Walking the DOM from `box.el` inside
`csstable.ts` would need its own access to computed styles and would
re-derive "what does this element's content become" — a second definition of
a rule `cssbox.ts` owns, which is the "one builder per construct" hazard the
issue text names. Doing it all in `cssflow.ts` would roughly double that
file, which is the mapper and nothing else.

## The table rules

**The fixup earns its place on `display: table-*`, not on `<table>`.** Worth
stating because it otherwise reads as dead code: `htmltree.ts` already
produces well-formed `table > tbody > tr > td`, so real HTML markup needs
almost none of §17.2.1. The fixup exists for a `<div style="display:
table-row">` whose parent is not a table, and for a stray non-cell child of a
row.

**Spans map with no translation.** `colspan`/`rowspan` are HTML attributes
read off the cell element. `CellOptions.rowSpan` already documents HTML's own
convention — rows below a spanning cell OMIT the covered cells, "because a
placeholder would be a second way to say the same thing and the two would
drift" — so the mapping is direct, and the builder already clamps.

**Headers.** A `<th>`, or any cell inside a `<thead>`, marks its row as a
header row. When the header rows are the LEADING ones, use
`setRepeatingRowsCount(n)` and let `CellOptions.header` follow from its
documented default; `mdflow.ts` records that saying both is two statements
which can drift apart. A `<th>` that is NOT in a leading header row gets an
explicit `header` instead, since the default cannot reach it.

**Borders and backgrounds** come from each cell's own computed style through
`bordersides.ts` into `CellTextOptions.border`/`.background`, with the table's
own from the table box's style. `border-collapse` and `border-spacing` are
already among the 43 longhands and already inherited, so the values are there
to read.

**Column widths: `autoFitColumns()`, always.** A CSS `width` on a cell or a
`<col>` is deliberately NOT honoured here. Mixing stated and auto columns is
what `resolveColumnWidths`'s `ColumnWidth` specs exist for, and getting it
wrong silently mis-sizes every column in the table rather than failing. It
becomes a follow-up issue rather than a guess. The table's own `width` IS
honoured, since `FlowTableOptions.width` takes it directly.

**A `<caption>` becomes a paragraph before the table.** `TableBuilder` has no
caption vocabulary, and dropping the subtree would break the rule this stack
follows everywhere — a construct that does not render names itself in
`skipped` and still contributes its text.

**A cell holding BLOCK content flattens to its runs** and reports
`table-cell-blocks`. `TableBuilder.addCell` takes `string | TextRun[]`, so a
cell containing a `<p>` and a `<ul>` cannot be represented; extending the
table authoring layer to accept `FlowElement[]` in a cell would change
`tableauthor.ts`, `tablerender.ts` and `flowtable.ts` together and is its own
issue. A cell holding a paragraph and a list is far rarer in real documents
than the two constructs that trade against it.

## Images

`HtmlFlowOptions` gains `resolveImage?: (src: string, alt: string) =>
Uint8Array | undefined`. It mirrors `mdflow.ts`'s PATTERN rather than its
arity — that one takes `(destination, title)` because those are Markdown's
two, and HTML's are `src` and `alt`. `data:` URIs are decoded internally;
everything else is the caller's, and an unresolvable `src` is reported rather
than throwing.

**A box whose inline content is ONE atomic and no MEANINGFUL runs becomes an
`image()`** — `<p><img></p>`, or an `<img>` alone in a block. *Meaningful*
carries weight here: `cssinline.ts` filters only `text !== ''`, so
`<p>\n  <img>\n</p>` arrives with whitespace runs either side of the atomic,
and a naive "no runs" test would report the commonest formatting of an image
in real markup. `mdflow.ts`'s `loneImage` says the same thing as "ignoring
surrounding whitespace". Anything else
keeps today's `image:<src>` report until `zch2.11` teaches `layoutRuns` to
place an atomic in a line. That mirrors `mdflow.ts`'s `loneImage` exactly, so
the two producers share one rule rather than diverging.

`<img alt>` maps to `FlowImageOptions.alt`, which is what a tagged flow emits
as the `/Figure`'s alternate text.

**The `data:` decoder moves to a new `dataurl.ts` leaf.** It is ~6 lines,
private to `mdflow.ts` today, and about to have two consumers — one owner, the
extraction `colornames.ts`, `preformat.ts` and `bordersides.ts` each already
made. `cssflow.ts` importing `mdflow.ts` would drag the whole Markdown mapper
in for six lines.

## Links

A fence, and one behaviour change.

**`href="#intro"` emits NO annotation and is reported.** Today
`cssinline.ts` sets `link` unconditionally, so a fragment-only href becomes a
`/URI` action pointing at `#intro` — a link that looks clickable and does
nothing in a viewer. "Renders perfectly and links wrongly" is the failure this
repo already guards against for merged runs, and a link that silently does
nothing is worse than no link. Resolving one properly needs an
id-to-destination map built after placement, since a flow element does not
know its page until it is placed; that is a real feature and a follow-up.

## Testing, and a ceiling that is thinner than `zch2.2`'s

**There is no oracle.** `getComputedStyle` exposes no table geometry that maps
onto `TableBuilder`'s model, so which builder a cell goes through, where a
span lands, and how a caption is placed are not observable through Blink. This
is the position `zch2.4` was in, and its design said so rather than implying
coverage. What the existing corpus DOES anchor is the computed styles on table
elements — `display`, `border-collapse`, `border-spacing` — from `zch2.2.3`;
that is the input to this work, not its output.

So every rule here is held by a hand-built case plus a mutation, and any
mutation that reddens nothing is recorded as uncovered rather than kept
quietly — the practice that found two real gaps in `zch2.2.6` and a real bug
in `zch2.2.7`.

- `test/csstable.test.ts` — the `TableBox`-to-`TableBuilder` mapping from
  hand-built box trees: spans, headers, borders, the caption, the flattened
  block cell.
- `test/cssbox.test.ts` — the §17.2.1 fixup and the new `TableBox` content.
- `test/htmlflow.test.ts` — tables, images and links end to end through the
  public `AddHtml`.

## Out of scope, stated so it stays a decision

- **Inline atomics** — `zch2.11`, filed with the measurement of why it is a
  layout subsystem rather than an image feature.
- **Float placement** — `zch2.10`.
- **Column widths from CSS** — follow-up, for the reason above.
- **Block content in a table cell** — follow-up; needs `tableauthor.ts`,
  `tablerender.ts` and `flowtable.ts` together.
- **Internal links to a fragment** — follow-up; needs an id-to-destination
  map built after placement.

# Auto-fit table columns

Design for `aspose-pdf-foss-for-ts-qdat`, a P3 follow-up filed during `gl6o.3.3`
(Markdown tables and links in flow) as "per-column table widths from a style
option". The measurement below reframes it: the problem is the default, not the
absence of an override.

## Problem

A GFM table declares no column widths, so `mdflow.ts` builds its `TableBuilder`
without calling `setColumnWidths` and `resolveColumnWidths` falls back to equal
fractions. Measured on a realistic two-column table in a default A4 flow
(451pt of content width, 10pt text):

```
| Qty | Description |
| --: | :---------- |
| 12 | A reasonably long product description that needs room to breathe |
```

- The `Qty` column is allotted **~225pt** — half the table — for content whose
  widest cell needs about 20pt.
- `Description` starts at x=302 and **wraps to two lines**, so the table renders
  roughly twice as tall as it needs to.

The issue as filed proposes `style.table.columnWidths`. That cannot work well:
`MarkdownStyle` is document-wide, so one array would have to serve every table
in the document regardless of column count, and a document mixing a 2-column and
a 3-column table could not use it at all. It also leaves the default bad for
everyone who does not set it, which is the actual complaint.

## Scope

In scope:

- `TableBuilder.autoFitColumns()` — size columns from their content.
- `mdflow.ts` calling it, so Markdown tables auto-fit by default.

Out of scope, each for a stated reason:

- **`style.table.columnWidths`.** The shape is wrong for a document-wide style,
  and auto-fit removes the motivating need. If per-table control is ever wanted,
  it needs a per-table channel, which is its own design.
- **Auto-fit for `flow.AddTable` / `page.AddTable` by default.** Those callers
  already have `setColumnWidths`, their output is fenced by
  `table-slice-identity`, and changing their default would move bytes for
  everyone. They opt in by calling the method.
- **Image width as a sizing input.** `measure()` already fits a cell image to
  whatever width its column receives. Letting a wide image claim natural width
  would starve the text columns.
- **Table extraction.** `tablestruct.ts` and `table.ts` read documents; nothing
  here touches them.

## Architecture

One method and one flag on the existing model, plus one line in the Markdown
mapper.

```
tableauthor.ts   TableBuilder.autoFitColumns()   NEW — sets a flag, chainable
                 resolveColumnWidths(total)      measures when the flag is set
mdflow.ts        mdTable()                       calls it
```

### Why a flag rather than computed widths

`mdTable` runs at `AddMarkdown` time; the column budget arrives at `place()`
time from the flow column, and differs between a one-column and a two-column
flow, and again on a continuation. So natural widths computed up front could
only be stored as *fractions* — and a fraction cannot express a floor, because
the floor depends on the total.

`resolveColumnWidths(totalWidth)` is the only place the budget exists, so that
is where the measurement happens. `autoFitColumns()` records the intent:

```ts
/** Size columns from their content rather than splitting the width equally.
 *  Chainable. An explicit `setColumnWidths` wins — an author who stated widths
 *  meant them. */
autoFitColumns(): this
```

### Placement

In `tableauthor.ts`, not `mdflow.ts`. Column-width computation belongs with the
table model, which already owns the style cascade (`resolveCellStyle`) and the
measuring driver (`measuringDriverFor`) that `measure()` uses. Putting it in the
Markdown mapper would make a second home for table geometry and would deny it to
hand-built tables.

### The algorithm

Two measurements per column, both through the existing cell-style cascade so
font and padding are already correct:

- **max-content** — the widest cell's text laid out unwrapped, plus that cell's
  horizontal padding.
- **min-content** — the widest single word, plus padding. Below this, wrapping
  degenerates into breaking mid-word or overflowing.

Two things "the cell's text" has to mean precisely, since both are reachable:

- **A `TextRun[]` cell measures the concatenation, run by run at each run's own
  font and size** — not the block font applied to the joined string. A word may
  also span a run boundary (`**bold**text` is one word), which is the rule
  `layoutRuns` already follows for break opportunities, so min-content must find
  words on the concatenated text rather than per run.
- **An embedded newline splits the measurement.** max-content is the longest
  *line*, not the whole string. A cell may carry a hard break — `addCell` takes
  arbitrary text, and `mdruns.ts` maps `linebreak` to `'\n'` — and measuring
  across it would demand a column wide enough for every line at once.

Then, against the real budget:

1. **Distribute proportionally to max-content.** This handles both regimes
   correctly with one rule: when the natural widths fit, every column gets at
   least what it needs plus a proportional share of the slack; when they do not,
   every column shrinks together rather than one collapsing.
2. **Raise any column below its min-content up to it**, taking the shortfall
   proportionally from the columns still above their own floor.
3. **If the floors alone exceed the budget, fall back to equal fractions.**
   Nothing can satisfy the constraint, and equal is the honest answer rather
   than picking an arbitrary winner.

On the measured case this yields roughly `Qty` 35pt and `Description` 415pt
against 225/225 today: the description stops wrapping and the table halves in
height.

**A `colSpan` cell is excluded from both measurements.** It contributes to no
single column, so attributing its width to one of the columns it spans would be
arbitrary — the choice CSS auto-layout makes for the same reason. A table whose
only content is spanning cells therefore auto-fits to equal fractions, which is
correct: nothing distinguishes its columns.

## Invariants

To be recorded in `CLAUDE.md`:

- **Auto-fit measures at resolve time, not at build time.** The column budget
  comes from the flow at `place()` and differs per column count and per
  continuation; widths computed up front could only be fractions, and a fraction
  cannot carry a floor.
- **An explicit `setColumnWidths` outranks `autoFitColumns`.** A stated width is
  a decision; a measured one is a guess.
- **A `colSpan` cell sizes no column.** Its width belongs to no one of them.
- **Auto-fit is opt-in for hand-built tables and default for Markdown.** GFM
  declares no widths, so Markdown has nothing to lose; `page.AddTable` callers
  have `setColumnWidths` and a byte-identity fence.

## Error handling

`autoFitColumns()` takes no arguments, so there is nothing to validate.
`resolveColumnWidths` keeps its existing throws — a `setColumnWidths` count that
disagrees with the column count, and fixed columns leaving no room for the
fractions. An empty table still returns `[]`.

The "floors exceed the budget" case is a **fallback, not an error**. A table too
narrow for its own content is a layout outcome, not a caller mistake, and
throwing there would fail a whole document over a cosmetic problem — the rule
`svgdraw.ts` sets for content it cannot draw fully.

## Testing

The arithmetic is pure — no `Document`, no page — so most of it is tested by
driving `resolveColumnWidths` directly, the rule `floatstack.ts` and
`booklet.ts` already follow: geometry that is silently wrong when reversed
should be testable without building a file.

`test/table-autofit.test.ts`:

- a narrow and a wide column split proportionally to their content, not 50/50
- when the natural widths fit the budget, every column receives **at least** its
  natural width
- when they do not, the columns shrink together rather than one collapsing
- a column squeezed below its min-content is raised to it, and the shortfall is
  taken from columns with room above their own floor
- floors exceeding the budget falls back to equal fractions
- an explicit `setColumnWidths` beats `autoFitColumns`
- a `colSpan` cell does not skew the columns it spans
- a `TextRun[]` cell measures at each run's own font, so a bold run widens its
  column more than the same characters would in the body face
- a cell carrying a newline sizes to its longest line, not to the whole string

End to end:

- **The measured case, asserted as measured:** rendering the `Qty`/`Description`
  source, the description's text no longer wraps to a second line, and the table
  is shorter than the same source rendered without auto-fit.
- **`test/markdown-tables.test.ts` stays green**, in particular its alignment
  case — it asserts that a right-aligned column's text ends further right than a
  left-aligned column's, which should survive a change of widths. If it does
  not, the assertion was fragile about position rather than about alignment and
  needs to say what it means.
- **`test/table-slice-identity.test.ts` stays green**, proving hand-built tables
  are untouched.

## Public surface

```ts
// tableauthor.ts
TableBuilder.autoFitColumns(): this
```

`TableBuilder` is already exported from `index.ts`, so no export changes.

`README.md` gains `autoFitColumns` in the table-authoring bullet, and the
Markdown limitation sentence — "A table's columns are always equal fractions of
the flow column, since GFM declares no widths — use `flow.AddTable` with
`setColumnWidths` for control" — is replaced by a statement that Markdown tables
size to their content.

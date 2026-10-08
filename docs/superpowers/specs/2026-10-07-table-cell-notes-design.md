# Footnotes and Endnotes in Flow Table Cells (v9j3.3.3) — Design

**Issue:** `v9j3.3.3`, child of `v9j3.3` (Footnotes and endnotes).
**Status:** approved in conversation, 2026-10-07.

## Goal

A footnote or endnote reference inside a table cell renders through the
v9j3.3 Flow note engine — in a hand-built Flow, in Markdown and in DOCX —
where today it is refused: a `TypeError` from `resolveRuns`' guard for a
hand-built flow, `footnote (table cell)` for Markdown and
`w:footnoteReference (table cell)` for DOCX, both reported dropped.

## Decisions

| Question | Decision |
|---|---|
| Where notes are lowered | In `table()` (`flowtable.ts`), on a PRIVATE COPY of the builder. Not in `addCell`, not in `flow.AddTable` alone. |
| A reference in a repeating header row | The mark draws in EVERY repeat; the note is placed ONCE, with the first slice. A repeat behaves as a repeated citation. |
| `page.AddTable`, `AddTextBlock`, a TOC | Still refuse, through the existing `resolveRuns` guard, unchanged. |
| The `(table cell)` report names | Removed from the Markdown and DOCX vocabularies, being unreachable. Logged as **Changed**. |
| HTML tables | Out of scope: HTML has no footnotes. |

## Engine

### Lowering (`flowtable.ts`)

`table(t, o)` scans every cell. If none holds a run carrying `footnote` or
`endnote`, it uses `t` exactly as today — the byte-identity argument, by
construction. Otherwise it builds a private copy: rows and cells copied
shallowly (every other field shared), each cited run list replaced by
`lowerNotes(runs, size)`, where `size` is the cell's cascaded font size
(cell, row, table defaults — the `resolveCellStyle` cascade), so a mark is
sized against the text it follows, as in a paragraph.

- The caller's builder is never mutated. The same builder passed to
  `page.AddTable` afterwards still meets the guard and still refuses, and two
  `table()` calls over one builder lower two sets of fresh `NoteRef`s, the
  v9j3.3 rule that every lowering makes a fresh reference.
- `lowerNotes`' validation (both notes on one run, a malformed `FlowNote`)
  runs here, at build time, as `paragraph()` runs it.
- `tableauthor.ts` learns nothing about notes and gains no import. A mark run
  is an ordinary `TextRun` with `rise` set and a symbol key, which the cell's
  run path already measures and paints.

`TableBuilder`/`RowBuilder`/`CellBuilder` need an internal way to build such a
copy (the cell's `text` is otherwise fixed at `addCell`); it is `@internal` and
does not change the public surface.

### The element

`TableElement`:

- **`noteRefs()`** — every reference in its rows, row-major, cells in order,
  runs in order: reading order, which the up-front numbering pass and
  `restart: 'page'` renumbering use.
- **`measure()`** reports **`notes`**: the references in the rows `fit()`
  kept. A table splits by row only and a row is atomic, so more budget keeps a
  superset of rows and of references — `settleBudget`'s monotonicity holds and
  it bisects unchanged; its "keep one line" fallback is "keep one row".
- **`place()`** sets `ref.owner` for every kept reference to the structure
  element of its cell, so a tagged `/Note` is created under that `/TD`/`/TH`.
  `TableTagger` records, per `CellBuilder`, the element it last created
  (a `Map`), and the element reads it after `paintRowSlice`. Untagged, nothing
  is recorded.

### Repeated header rows

A continuation (`continuationFrom`) holds the header rows as the SAME row
objects, so the same mark runs and the same references. A continuation
`TableElement` knows its first `repeatingRowsCount` rows are repeats and
EXCLUDES their references from `noteRefs()` and from `measure().notes`:

- the note is committed once, by the first slice;
- the mark still draws in every repeat, being the same, already numbered run;
- under `restart: 'page'` a repeat keeps its first-page number — the note it
  names is on that page, and a committed reference is final (v9j3.3.2's
  invariant).

### What stays refused

- `page.AddTable`, `AddTextBlock`, `AddText`, TOC rows: unlowered runs, so the
  `resolveRuns` guard throws as today.
- A float holding a table with notes: refused, as any float with notes is.
- `placeElements` (one rect) refuses a table with references, as it refuses a
  paragraph with them; `notesAsTrailing` detaches them first (below).

## Front ends

### Markdown (`mdflow.ts`)

A table cell is given the citation resolver a paragraph is given, in place of
`noteRefusal: 'footnote (table cell)'`. Cited runs reach `addCell`;
`table()` lowers them. Repeated citations share one `FlowNote` (first wins);
`footnotePlacement: 'end'` works unchanged. A citation inside a footnote
definition stays `footnote (nested)`.

### DOCX (`wmlflow.ts`)

`cellContent` stops clearing `cite`. `w:footnoteReference (table cell)` and
`w:endnoteReference (table cell)` leave the vocabulary; `(in a note)` stays.

### One rect

`page.AddMarkdown` and `page.AddDocx` need no change: `notesAsTrailing` finds
the table's references through `noteRefs()`, numbers them and DETACHES them by
deleting the symbol key from the shared mark run, after which the table has no
references and `placeElements` accepts it.

## Oracle

`word2010-notes.docx` (the v9j3.3.2 corpus) already holds a footnote in a
table cell, the last note of section 1, whose mark Word shows as `3`. The
existing corpus test compares the marks the READER computes, which already
include it. New: RENDER the file through `doc.AddDocx` and hold the marks
DRAWN to Word's — `1 2 * 3` in section 1 and `i` in section 2 — which fails
today, the cell note being dropped. Nothing is regenerated. Markdown and the
engine are held by hand-built cases.

## Testing

- **Fences, recorded before any change:** a hash of a note-free Flow table
  (plain, split, with repeating headers, tagged); the existing
  `test/rich-runs-identity.test.ts`, `test/docx-flow-identity.test.ts` and
  `test/flow-notes-identity.test.ts` stay green unedited.
- **Engine:** a cell footnote at the foot; a split table whose second slice's
  note lands on page 2; a row pushed to the next column with its note
  (`settleBudget`); a header-row note committed once while its mark repeats on
  every slice; endnotes from cells; a tagged `/Note` whose parent is the cell's
  `/TD`; numbering in row-major order; `restart: 'page'` across a split;
  `page.AddTable` with a cited run still throws; the caller's builder is
  unchanged after `table()`.
- **Front ends:** Markdown and DOCX through all three entry points
  (`flow.Add*`, `page.Add*`, `doc.Add*`), and the Word render oracle above.
- **Mutation sweep** at the end, fixtures shaped so each mutation is visible
  (the header case needs a table that actually splits with a note in its
  header).

## Review Focus

1. A note in a repeating header row: placed once, mark on every slice.
2. A split table: each slice's notes at the foot of the page that slice lands on.
3. A note-free table: byte-identical output.
4. `page.AddTable` with a cited run: still a `TypeError`, and the builder
   that a `table()` call lowered a copy of is untouched.

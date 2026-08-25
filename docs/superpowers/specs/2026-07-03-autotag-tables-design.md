# Accessibility Auto-tagging: Tables

**Issue:** aspose-pdf-foss-for-ts-pwi.3 (under the pwi umbrella; final sub-issue).
**Date:** 2026-07-03

## Context

`doc.AutoTag()` (pwi.2) infers a `/StructTreeRoot` for an untagged document —
headings, paragraphs, and figures/artifacts — via `StructElement.MarkContent`
(pwi.1). Tables were explicitly deferred. This adds table tagging on top of the
same machinery, using the shipped `page.GetTables()` extractor as the source of
truth for rows/cells/headers/spans.

`Table` (`src/tablemodel.ts`): `quad`, `rowCount`, `colCount`, `rows`,
`summary?`, `angle`. `TableRow`: `cells`, `quad`, `section?`. `TableCell`:
`row`, `col`, `rowSpan`, `colSpan`, `quad`, `text`, `isHeader?`, `scope?`,
`headers?`, `tables?`. The PDF/UA validator (`src/structvalidate.ts`) requires
`TR` under `Table`/`THead`/`TBody`/`TFoot` and `TH`/`TD` under `TR`.
`StructElement.SetTableAttributes(Partial<TableAttributes>)` writes
`rowSpan`/`colSpan`/`scope` (`Row`/`Column`/`Both`)/`summary`.

## Scope

Extend `autoTag` (`src/autotag.ts`) to tag detected tables as `Table > TR >
TH/TD`, mark each cell's content with `MarkContent`, carry spans/scope/summary
via `SetTableAttributes`, and exclude table text from the paragraph/heading pass.
Add `AutoTagOptions.tables` (default true) and `AutoTagReport.tables`.

Non-goals: `THead`/`TBody`/`TFoot` grouping; nested tables (a cell's `tables` are
not separately tagged — the whole cell is one `TD`); exact rotated-table region
matching (axis-aligned bounding-box, approximate for skewed tables).

## Behavior

`autoTag`'s per-page loop becomes, in order:

1. **Tables.** `const tables = (opts.tables ?? true) ? page.GetTables() : []`.
   For each `table`:
   - `const tEl = root.Append('Table')`; if `table.summary`,
     `tEl.SetTableAttributes({ summary: table.summary })`.
   - For each `row` of `table.rows`: `const trEl = tEl.Append('TR')`.
     - For each `cell` of `row.cells`: a cell is a header when `cell.isHeader`
       **or** it is in the first row of a multi-row table (the standard
       first-row-header heuristic — `GetTables` sets `isHeader` only from a
       pre-tagged source, so untagged/geometry tables rely on the heuristic).
       `const cellEl = trEl.Append(isHeaderCell ? 'TH' : 'TD')`; derive `scope`
       (`cell.scope` if a valid enum, else `'Column'` for a heuristic first-row
       header); collect `SetTableAttributes` from `{ rowSpan, colSpan, scope }`
       when `rowSpan`/`colSpan` > 1 or `scope` is set; `cellEl.MarkContent(page,
       cell.quad)`.
   - `report.tables++`.
2. **Text blocks.** Collect the table quads. For each `GetStructuredText` block,
   skip it when its center `((x0+x2)/2,(y0+y2)/2)` lies inside any table quad
   (already tagged as a cell); otherwise classify `H<n>` / `P` as today.
3. **Images.** Unchanged (Figure/Artifact).

`SetTableAttributes` is only called when at least one attribute is set, to avoid
empty `/A`. `scope` is passed through only when it is one of `Row`/`Column`/`Both`.

## API changes

```ts
interface AutoTagOptions {
  // …existing…
  tables?: boolean; // detect and tag tables (default true)
}
interface AutoTagReport {
  headings: number; paragraphs: number; figures: number; artifacts: number;
  tables: number;   // NEW — count of Table elements
}
```

`AutoTagReport.tables` is additive; existing fields are unchanged.

## Errors

No new error paths. `MarkContent` on an empty cell region returns -1 (the cell
element is still created and structurally valid, just with no marked content —
matching how an empty text block is skipped, but here the `TD`/`TH` is kept so
the row's column structure stays intact).

## Testing (`test/autotag.test.ts`)

A ruled-table fixture (a content stream drawing table rule lines plus cell text,
built with the existing table-fixture helpers) auto-tagged:
- `GetStructTree` root has a `Table`; its children are `TR`s; each `TR`'s children
  are `TH`/`TD`; a header-row cell is `TH`, body cells `TD`.
- A cell element's `GetText()` returns that cell's text (MCID round-trip).
- The first row of a multi-row table is `TH` (heuristic) with `scope: 'Column'`;
  body rows are `TD`. A spanning cell carries `rowSpan`/`colSpan` in
  `TableAttributes`.
- Table text is **not** also tagged as `P` (no `P` element whose text duplicates a
  cell).
- `report.tables` is the table count; `ValidatePdfUa()` reports no
  `TableStructure` errors.
- `opts.tables === false` skips table tagging (the table's text falls back to
  `P`/`H`).

## README

- Update the "Accessibility auto-tagging" Features bullet: AutoTag now also tags
  detected tables as `Table > TR > TH/TD` (headers, spans, and summary carried;
  `opts.tables` toggles it, default on).
- Update the auto-tagging Limitations bullet: tables are tagged (ruled/borderless
  per `GetTables`), but `THead/TBody` grouping, nested tables, and exact
  rotated-table regions are out of scope; lists remain untagged.

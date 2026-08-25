# Tagged-PDF `/Table` structure-tree extraction — design (k33)

Issue: `aspose-pdf-foss-for-ts-k33` — follow-up to `7y8` (geometry-only table
extraction, shipped in `src/table.ts`).

## Goal

When a tagged PDF exposes `/Table → TR → TH/TD` structure elements, use the
structure tree as the **authoritative** source for rows, cells, and spans
instead of reconstructing them from ruling-line/text geometry. The structure
tree also carries semantics geometry cannot recover — header vs. data cells,
`scope`, header/id associations, `THead`/`TBody`/`TFoot` sections, and a table
`Summary` — all of which this feature surfaces.

Non-goals (tracked by sibling issues):

- **Cross-page tables (7ac)** — a tagged `/Table` that spans pages is emitted
  once, whole, on its primary page. True per-page slicing is deferred.
- **Nested tables (84u)** — a `/Table` nested inside a `TD` is *not* surfaced as
  a separate `Table`; its text is flattened into the parent cell.

## Building blocks (already shipped)

- `src/table.ts` (7y8): `extractTables(doc, page, opts) → Table[]`,
  `Page.GetTables(opts?)`. `Table`/`TableRow`/`TableCell` model with
  `toHtml()`/`toMarkdown()`.
- `src/struct.ts` (Phase 8 read model): `doc.GetStructTree()`, `doc.IsTagged`,
  `StructElement` with `StandardType`, `Children`, `ContentItems`, `GetText()`,
  `Page`, `ID`. Internal per-page `mcidGlyphs(doc, page): Map<number,
  GlyphEvent[]>` — each `GlyphEvent` carries a page-space `quad`.
- `src/structattr.ts` (S4): `StructElement.TableAttributes` →
  `{ rowSpan, colSpan, headers, scope, summary }` (merged `/A` + `/C`, defaults
  `rowSpan`/`colSpan` = 1 on read); `LayoutAttributes` with `bbox`.

## Decisions

1. **Integration** — auto, with geometry fallback. `Page.GetTables()` uses the
   structure tree when the page is tagged and has `/Table` elements; otherwise
   the current geometric detection. A new `structure?: 'auto' | 'off'` option
   (default `'auto'`) forces geometry-only.
2. **Cell quads** — prefer a cell's `LayoutAttributes` `/BBox`; fall back to the
   union of the glyphs behind the cell's marked content; degenerate zero-quad
   for empty cells.
3. **Model richness** — full: capture header/data distinction, `scope`,
   header/id associations, `THead`/`TBody`/`TFoot` sections, and table
   `Summary`.
4. **Page assignment** — the whole table is emitted once on its primary page
   (page of its first content-bearing cell, or the Table element's `/Pg`).
5. **Nesting** — nested `/Table` text is flattened into the parent cell via
   `GetText()`; nested tables are not emitted separately (deferred to 84u).

## Architecture & module layout

The geometry extractor and the tagged extractor both produce the shared `Table`
model, and the dispatcher needs both — so the model is factored out to break the
import cycle.

- **`src/tablemodel.ts` (new)** — the shared model: `Rect`,
  `TableExtractOptions`, `TableCell`, `TableRow`, and the `Table` class
  (`toHtml`/`toMarkdown`). No document/page dependencies beyond types.
- **`src/tablestruct.ts` (new)** — `extractTaggedTables(doc, page, options):
  Table[]`. Walks the structure tree into the shared model. Imports
  `tablemodel.ts` + `struct.ts`.
- **`src/table.ts`** — keeps geometry detection; re-exports the model from
  `tablemodel.ts` for backwards compatibility (existing import sites unchanged).
  `extractTables()` becomes the **dispatcher**: when `options.structure !==
  'off'` and `extractTaggedTables()` returns a non-empty result, return it;
  otherwise fall back to geometry.
- **`src/page.ts`** — `Page.GetTables(options?)` unchanged in signature; the new
  `structure` option rides on `TableExtractOptions`.
- **`src/struct.ts`** — add `StructElement.GetBBox(page?): Rect | undefined`:
  the union of descendant glyph quads on `page` (defaults to the element's own
  `Page`), or `undefined` when the element contributes no glyphs. Mirrors the
  recursion in `GetText()`. Reused for the cell-quad fallback and generally
  useful.
- **`src/index.ts`** — export any newly public types (`extractTaggedTables` stays
  internal; the public surface remains `Page.GetTables` + `Table`).

## Extraction algorithm (`extractTaggedTables`)

1. **Find tables for the page.** `const root = doc.GetStructTree()`; if `null`
   (or `!doc.IsTagged`), return `[]` (dispatcher falls back to geometry). Walk
   the tree (depth-first over `Children`) collecting elements with
   `StandardType === 'Table'`. For each, compute its **primary page** = the page
   of its first content-bearing cell (first cell whose `GetBBox()`/content items
   resolve to a page), or the Table element's inherited `Page`. Keep only tables
   whose primary page `===` this page. When `options.region` is set, further
   keep only tables whose overall quad centroid falls inside the region.

2. **Rows & sections.** Iterate the Table's `Children` in document order:
   - `TR` → one row, section `'body'`.
   - `THead` / `TBody` / `TFoot` → iterate their `TR` children, tagging rows
     `'head'` / `'body'` / `'foot'` respectively.
   - Rows preserve authored order. (A table with no section wrappers yields rows
     with `section` left `undefined`.)

3. **Cells & grid placement (HTML-style occupancy).** Maintain a set of occupied
   `(r, c)` slots carried down by earlier `rowSpan`s. For each row `r`, iterate
   its `TH`/`TD` children left-to-right; each cell takes the next free column
   `c`. Read `rowSpan`/`colSpan` from `TableAttributes` (default 1). Mark every
   covered slot `(r..r+rowSpan-1, c..c+colSpan-1)` occupied. `colCount` = max
   grid width observed; `rowCount` = number of rows.

4. **Cell fields.**
   - `text` = `GetText()` (nested `/Table` text flattened in).
   - `isHeader` = `StandardType === 'TH'`.
   - `scope` = `TableAttributes.scope`; `headers` = `TableAttributes.headers`;
     `id` = `StructElement.ID`.
   - `quad` = `LayoutAttributes.bbox` when present, else `GetBBox(primaryPage)`,
     else the degenerate zero-quad `[0,0,0,0]`.

5. **Table & row aggregates.** Row `quad` = union of its cells' quads; table
   `quad` = union of all cells' quads; `summary` = `TableAttributes.summary` on
   the Table element. Rows with no cells are still emitted (preserving row
   indices) with a degenerate quad.

## Model extensions (`tablemodel.ts`)

```ts
interface TableExtractOptions { region?: Rect; structure?: 'auto' | 'off'; }

interface TableCell {
  row: number; col: number; rowSpan: number; colSpan: number;
  quad: Rect; text: string;
  isHeader?: boolean;   // TH — tagged path only
  scope?: string;       // 'Row' | 'Column' | 'Both' | 'None' (TableAttributes)
  id?: string;          // element /ID, for header association
  headers?: string[];   // TD → ids of associated header cells
}

interface TableRow {
  cells: TableCell[];
  quad: Rect;
  section?: 'head' | 'body' | 'foot';
}

class Table {
  constructor(
    public quad: Rect,
    public rowCount: number,
    public colCount: number,
    public rows: TableRow[],
    public summary?: string,   // Table /Summary
  ) {}
  toHtml(): string;
  toMarkdown(): string;
}
```

The geometry path leaves every new field `undefined` and omits `summary`, so its
behavior and existing tests are unchanged.

## Serialization

- **`toHtml`** — when any row has a `section`, group rows into
  `<thead>`/`<tbody>`/`<tfoot>` (in head→body→foot order); emit `<caption>` from
  `summary`. Header cells render as `<th>` with `scope`/`id` attributes when set;
  data cells carry a `headers` attribute when set. When no tagged semantics are
  present (geometry path: no sections, no `isHeader`, no `summary`), output is
  byte-identical to today (`<table>`/`<tr>`/`<td>` with span attributes).
- **`toMarkdown`** — unchanged. Markdown cannot express scope/sections/id
  associations; the existing first-row-as-header rendering is kept and the extra
  metadata is intentionally lossy.

## Testing

- **Fixture** `test/helpers/build-tagged-table-pdf.ts` (mirrors
  `build-tagged-pdf.ts`): a marked-content page with a real `/StructTreeRoot` →
  `Table` → `THead`/`TBody` → `TR` → `TH`/`TD`, including: a `colSpan` header, a
  `rowSpan` data cell, `scope` on headers, an `/ID` + `headers` association, a
  table `/Summary`, and at least one cell with **no** `/BBox` so its quad
  exercises the glyph-union fallback.
- **Tests** `test/table-tagged.test.ts`:
  - auto-selection: tagged extraction is used over geometry when the page is
    tagged with `/Table`;
  - `structure: 'off'` forces the geometry path;
  - grid placement with `rowSpan`/`colSpan` (correct `row`/`col`/`rowCount`/
    `colCount`);
  - section tagging (`head`/`body`/`foot`);
  - `isHeader`, `scope`, `id`, `headers` populated;
  - `summary` populated;
  - cell quad from `/BBox` and from glyph union;
  - `toHtml` emits `<thead>`/`<th scope>`/`<caption>`; `toMarkdown` unchanged;
  - a non-tagged page still uses geometry (regression).
- `npm run typecheck` and `npm test` must be green before closing k33.

## Risks / notes

- Changing `GetTables()` default output for tagged PDFs is intentional (tagged is
  more authoritative); `structure: 'off'` is the escape hatch.
- `/BBox` coordinate space: `LayoutAttributes.bbox` is taken as page default
  user space (consistent with how glyph quads are reported). No CTM composition
  is attempted for v1; if a fixture reveals a mismatch, prefer the glyph-union
  path.
- README (Features / API overview / Limitations) updated to note tagged-table
  extraction and the `structure` option.

# Nested Table Extraction Design

> Issue: `aspose-pdf-foss-for-ts-84u` — Table extraction: nested tables.
> Follow-up to `aspose-pdf-foss-for-ts-7y8` (geometry v1) and
> `aspose-pdf-foss-for-ts-k33` (tagged `/Table` extraction), which explicitly
> deferred nested tables.

## Goal

Support tables nested inside a table cell in the **tagged** extraction path:
a `/Table` structure element inside a `TD`/`TH` is emitted as a child table
(recursive, unbounded depth — the PDF declares the nesting, so it is
deterministic and safe).

A nested table is represented as a `Table` object attached to its parent
`TableCell`, and its text is removed from the parent cell's `text`. The model
field and HTML serialization are path-agnostic, so the geometry path can
populate the same `tables` field later without further model changes.

> **Geometry path is deferred to `aspose-pdf-foss-for-ts-e2o`.** The geometry
> detector (`collectRules` → `assembleTable`) builds one flat grid from *all*
> ruling-line positions on the page, so it has no notion of nesting levels: a
> nested grid's rules pollute the outer table and its cells flatten into the
> outer grid as top-level cells. Detecting nested tables geometrically needs a
> rule-hierarchy pass (outer-by-span vs. nested-by-confinement, or
> flat-then-regroup) that is heuristic and out of scope for this deterministic
> change.

## Data model (`src/tablemodel.ts`)

Add one optional field to `TableCell`:

```ts
export interface TableCell {
  row: number; col: number; rowSpan: number; colSpan: number;
  quad: Rect; text: string;
  isHeader?: boolean; scope?: string; id?: string; headers?: string[];
  /** Tables nested inside this cell (recursive). Absent when none. */
  tables?: Table[];
}
```

- `Table` is unchanged; a nested table is an ordinary `Table` in a parent
  cell's `tables` array.
- When a cell has nested tables, the nested tables' text is **excluded** from
  the parent cell's `text`. So `text` holds the cell's own prose only, and
  `tables` holds the nested structure. A pure container cell has `text: ''`.
- A cell with no nesting leaves `tables` absent → output byte-identical to today.

### Top-level invariant

A nested table appears **only** inside its parent cell's `tables`, never also as
a top-level entry in the `Table[]` returned by `extractTaggedTables` /
`extractTables` / `Page.GetTables()`.

## Tagged path (`src/tablestruct.ts`)

### 1. Collect only top-level tables

`findTables` today walks the whole struct tree and pushes every `Table`
element, including nested ones. Change it so that when a `Table` is found, it is
pushed and its subtree is **not** further scanned for top-level tables (nested
`Table`s are handled by `buildTable`). Net: `extractTaggedTables` returns only
outermost tables per page.

### 2. `buildTable` recurses over cells

For each `TD`/`TH` cell element:

- **Find nested tables:** the nearest-enclosed `Table` elements in the cell's
  descendant subtree (i.e., descend through non-`Table` elements, stop at and
  collect the first `Table` on each branch). Each collected element becomes a
  nested `Table` via a recursive `buildTable` call (unbounded depth).
- **Own text:** compute the cell's text with a `GetText`-style walk that
  **prunes any `Table` subtree**, so nested-table text is excluded. `GetText` in
  `src/struct.ts` gains an **optional skip predicate** —
  `GetText(skip?: (e: StructElement) => boolean)` — where a child for which
  `skip` returns true has its whole subtree omitted. This is behavior-preserving
  (existing zero-arg callers unchanged); the MCID→glyph machinery lives in
  `struct.ts`, so this is the correct home for the pruned walk (a refinement of
  the spec's original "helper in `tablestruct.ts`", which could not reach the
  private glyph logic). `buildTable` calls
  `cellElem.GetText((e) => e.StandardType === 'Table')`.
- **Quad:** unchanged — `/BBox` layout attribute else `GetBBox()`.
- If nested tables were found, set `cell.tables`; otherwise leave it absent.

Nested tables reuse all existing per-table logic (rows, spans, sections,
headers, scope, id, summary) through the recursive `buildTable`.

## Serialization (`src/tablemodel.ts`)

`toHtml()` — when a cell has `tables`, emit each nested table's HTML **inside**
the parent `<td>`/`<th>`, after the cell text:

```html
<td>Parent cell text
<table>…nested…</table></td>
```

The nested `<table>` is produced by the same recursive `toHtml()`, so nested
`<thead>`/`<th scope>`/`<caption>`/spans carry through. Indentation is
best-effort; correctness over pretty-printing. Cells with no `tables` produce
byte-identical output to today.

`toMarkdown()` — **unchanged**. GFM cannot express nested tables, so nested
tables are omitted; since nested text was stripped from the parent, the parent
cell renders whatever own-text remains (often empty for a pure container cell).
No crash, no HTML leakage into Markdown.

## Testing

**Fixtures (`test/helpers/`):**

- A new tagged fixture with a `/Table` whose one `TD` contains a child `/Table`,
  and — to prove unbounded recursion — a `TD` of that nested table containing a
  further `/Table` (2 levels deep in one branch).

**Tests (`test/table-tagged.test.ts`):**

- Tagged: parent cell `tables.length`; nested `rowCount`/`colCount`/cell text;
  parent `text` excludes nested text; the nested table is absent from top-level
  results; 2-level nesting resolves (nested cell itself carries `tables`).
- Serialization: `toHtml()` nests `<table>` inside the parent cell tag;
  `toMarkdown()` omits nested tables and does not throw.
- Regression: the full existing suite stays green; non-nested output is
  byte-identical (including the k33 `build-tagged-table-pdf` fixture, which has
  no nesting).

## Scope

**In scope:** nested tables in the **tagged** path (unbounded depth); the
`tables` model field; nested HTML serialization; the `GetText` skip predicate.

**Deferred:** geometry-path nested detection → `aspose-pdf-foss-for-ts-e2o`
(needs a rule-hierarchy pass; the flat detector conflates nesting levels).

**Out of scope (unchanged):** cross-page tables (`7ac`), rotated/skewed tables
(`5ct`). Nesting combined with those is not addressed here.

**Files touched:** `src/tablemodel.ts` (`tables` field + `toHtml`),
`src/struct.ts` (`GetText` skip predicate), `src/tablestruct.ts` (`findTables`
+ recursive `buildTable` nesting + pruned cell text), `README.md` (limitations
note), plus a fixture and tests. `src/table.ts`, `src/index.ts`, and
`src/page.ts` need no signature changes.

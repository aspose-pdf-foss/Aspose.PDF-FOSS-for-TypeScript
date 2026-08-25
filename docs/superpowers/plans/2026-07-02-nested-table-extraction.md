# Nested Tagged-Table Extraction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extract tables nested inside a tagged PDF's `/Table` cells — a `/Table` inside a `TD`/`TH` becomes a child `Table` attached to that cell (recursive, unbounded depth), with its text removed from the parent cell and rendered as an inner `<table>` by `toHtml()`.

**Architecture:** Add an optional `tables?: Table[]` field to `TableCell` and nest child tables inside the parent cell in `Table.toHtml()` (both in `src/tablemodel.ts`). Give `StructElement.GetText` an optional skip predicate (`src/struct.ts`) so the tagged extractor can compute a cell's text while pruning nested-`Table` subtrees. In `src/tablestruct.ts`, stop `findTables` from descending into a found table (so nested tables are not top-level) and make `buildTable` collect each cell's nearest-enclosed `Table`s and recurse. Geometry-path nesting is deferred to `aspose-pdf-foss-for-ts-e2o`.

**Tech Stack:** TypeScript (ESM + NodeNext, `strict`), vitest. Zero runtime deps (`node:` built-ins only).

## Global Constraints

- Zero runtime dependencies — only `node:` built-ins. Do not add npm runtime deps.
- ESM + NodeNext: every relative import specifier carries a `.js` extension.
- `strict` TypeScript; `npm run typecheck` and `npm test` must both be green before closing the issue.
- TDD: write the failing test first, watch it fail, then implement.
- Follow existing patterns: fixtures are built programmatically in `test/helpers/`; tests live in `test/*.test.ts`.
- Public error types: `PdfParseError`, `UnsupportedFeatureError`, `InvalidPasswordError` (do not invent new error classes).
- Keep `README.md` in sync when public API changes.
- Reference issue: `aspose-pdf-foss-for-ts-84u`. Geometry follow-up: `aspose-pdf-foss-for-ts-e2o`.

---

## Task 1: `tables?` model field + nested `toHtml()`

Add the optional `tables` array to `TableCell` and make `Table.toHtml()` emit each nested table inside the parent cell's `<td>`/`<th>`, after the cell text. Output stays byte-identical for cells with no nested tables. `toMarkdown()` is unchanged (nested tables are omitted; GFM cannot express them).

**Files:**
- Modify: `src/tablemodel.ts` (`TableCell` field; `toHtml` cell emission)
- Test: `test/tablemodel.test.ts` (create)

**Interfaces:**
- Produces (consumed by Tasks 4, 5):
  - `interface TableCell { …; tables?: Table[]; }`
  - `Table.toHtml()` renders `<td>…text…<table>…nested…</table></td>` when a cell has `tables`.

- [ ] **Step 1: Write the failing test**

Create `test/tablemodel.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { Table } from '../src/index.js';
import type { Rect, TableRow } from '../src/index.js';

const rows = (cells: TableRow['cells'], quad: Rect): TableRow[] => [{ cells, quad }];

describe('Table.toHtml nesting', () => {
  it('nests a child table inside the parent cell, after its text', () => {
    const q: Rect = [0, 0, 10, 10];
    const child = new Table(q, 1, 1, rows(
      [{ row: 0, col: 0, rowSpan: 1, colSpan: 1, quad: q, text: 'inner' }], q));
    const parent = new Table(q, 1, 1, rows(
      [{ row: 0, col: 0, rowSpan: 1, colSpan: 1, quad: q, text: 'outer', tables: [child] }], q));
    expect(parent.toHtml()).toMatch(/<td>outer<table>[\s\S]*inner[\s\S]*<\/table><\/td>/);
  });

  it('is byte-identical to the pre-nesting output for a cell with no nested tables', () => {
    const q: Rect = [0, 0, 10, 10];
    const t = new Table(q, 1, 1, rows(
      [{ row: 0, col: 0, rowSpan: 1, colSpan: 1, quad: q, text: 'x' }], q));
    expect(t.toHtml()).toBe('<table>\n  <tr>\n    <td>x</td>\n  </tr>\n</table>');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/tablemodel.test.ts`
Expected: FAIL — the `tables` property is not accepted on the cell literal (type error) / nested `<table>` not present in output.

- [ ] **Step 3: Add the `tables` field to `TableCell`**

In `src/tablemodel.ts`, add the field to the `TableCell` interface (after `headers?`):

```ts
export interface TableCell {
  row: number; col: number; rowSpan: number; colSpan: number;
  quad: Rect; text: string;
  /** Tagged path only: true for a `TH` cell. */
  isHeader?: boolean;
  /** Tagged path only: `/Scope` — 'Row' | 'Column' | 'Both'. */
  scope?: string;
  /** Tagged path only: the element's `/ID`, for header association. */
  id?: string;
  /** Tagged path only: `/Headers` — ids of the header cells that describe this cell. */
  headers?: string[];
  /** Tables nested inside this cell (recursive). Absent when none. */
  tables?: Table[];
}
```

- [ ] **Step 4: Emit nested tables in `toHtml()`**

In `src/tablemodel.ts`, replace the cell-emitting line inside `emitRow` (currently
`lines.push(\`    <${tag}${attrs}>${escHtml(c.text).replace(/\n/g, '<br>')}</${tag}>\`);`)
with:

```ts
        const inner = escHtml(c.text).replace(/\n/g, '<br>');
        const nested = c.tables?.length ? c.tables.map((t) => t.toHtml()).join('') : '';
        lines.push(`    <${tag}${attrs}>${inner}${nested}</${tag}>`);
```

(For a cell with no `tables`, `nested` is `''` and the output is unchanged.)

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run test/tablemodel.test.ts`
Expected: PASS (both tests).

- [ ] **Step 6: Typecheck + existing table suites (regression)**

Run: `npm run typecheck && npx vitest run test/table.test.ts test/table-tagged.test.ts`
Expected: no type errors; all existing table tests PASS (non-nested output unchanged).

- [ ] **Step 7: Commit**

```bash
git add src/tablemodel.ts test/tablemodel.test.ts
git commit -m "feat(84u): TableCell.tables field + nested toHtml

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 2: `GetText` skip predicate on `StructElement`

Give `StructElement.GetText` an optional predicate that omits a child element's whole subtree when it returns true. Behavior-preserving: existing zero-argument calls are unaffected. The tagged extractor uses it to compute a cell's text while skipping nested `Table` subtrees.

**Files:**
- Modify: `src/struct.ts` (`GetText` signature + child recursion)
- Test: `test/struct.test.ts` (add one describe block)

**Interfaces:**
- Produces (consumed by Task 4): `StructElement.GetText(skip?: (e: StructElement) => boolean): string`.

- [ ] **Step 1: Write the failing test**

Add to `test/struct.test.ts` (after the `GetBBox glyph-union` describe block). `Document`, `buildTaggedPdf`, and `StructElement` are already imported at the top of the file.

```ts
describe('GetText skip predicate', () => {
  it('omits the subtree of any element for which the predicate returns true', () => {
    const doc = Document.Open(buildTaggedPdf());
    const docElem = doc.GetStructTree()!.Children[0];   // Document → [H1, P, Figure]
    expect(docElem.GetText()).toBe('Hello Heading\nBody paragraph');
    expect(docElem.GetText((e) => e.StandardType === 'P')).toBe('Hello Heading');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/struct.test.ts -t "skip predicate"`
Expected: FAIL — `GetText` takes no argument, so the skip has no effect and the second assertion returns `'Hello Heading\nBody paragraph'`.

- [ ] **Step 3: Add the predicate to `GetText`**

In `src/struct.ts`, change the `GetText` signature and the `isStructElem` branch. Replace:

```ts
  GetText(): string {
    const parts: string[] = [];
    const ownPage = this.Page;
    for (const k of kids(this.doc, this.Dict)) {
      const r = this.doc.resolve(k);
      if (typeof r === 'number') {
        if (ownPage) parts.push(glyphsToText(mcidGlyphs(this.doc, ownPage).get(r) ?? []));
      } else if (isStructElem(this.doc, k)) {
        const child = new StructElement(this.doc, r as PdfDict, isRef(k) ? k : undefined, this.Root);
        parts.push(child.GetText());
      } else if (isDict(r)) {
```

with:

```ts
  GetText(skip?: (e: StructElement) => boolean): string {
    const parts: string[] = [];
    const ownPage = this.Page;
    for (const k of kids(this.doc, this.Dict)) {
      const r = this.doc.resolve(k);
      if (typeof r === 'number') {
        if (ownPage) parts.push(glyphsToText(mcidGlyphs(this.doc, ownPage).get(r) ?? []));
      } else if (isStructElem(this.doc, k)) {
        const child = new StructElement(this.doc, r as PdfDict, isRef(k) ? k : undefined, this.Root);
        if (skip?.(child)) continue;
        parts.push(child.GetText(skip));
      } else if (isDict(r)) {
```

(The MCR/`isDict` branch and the trailing `return parts.filter(...)` are unchanged.)

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/struct.test.ts -t "skip predicate"`
Expected: PASS.

- [ ] **Step 5: Typecheck + full struct suite (regression)**

Run: `npm run typecheck && npx vitest run test/struct.test.ts`
Expected: no type errors; all struct tests PASS (zero-arg `GetText` callers unchanged).

- [ ] **Step 6: Commit**

```bash
git add src/struct.ts test/struct.test.ts
git commit -m "feat(84u): optional skip predicate on StructElement.GetText

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 3: Nested tagged-table fixture

Add a fixture builder producing a one-page tagged PDF with a 2×2 outer `/Table`
whose bottom-right `TD` contains a 2×2 nested `/Table`, whose bottom-left `TD`
in turn contains a 1×1 `/Table` — two levels of nesting in one branch. Leaf
cells carry MCIDs 0..6: `0=A 1=B 2=C` (outer), `3=D 4=E 5=F` (nested), `6=G`
(deep). Container cells (bottom-right outer, bottom-left nested) have no MCID.

**Files:**
- Create: `test/helpers/build-nested-table-pdf.ts`
- Test: `test/table-tagged.test.ts` (add a smoke test)

**Interfaces:**
- Produces (consumed by Tasks 4, 5): `buildNestedTablePdf(): Uint8Array`.

- [ ] **Step 1: Create `test/helpers/build-nested-table-pdf.ts`**

```ts
const enc = (s: string) => new TextEncoder().encode(s);
const byteLen = (s: string) => enc(s).length;

/** One-page tagged PDF: a 2×2 outer /Table whose bottom-right TD contains a
 *  2×2 nested /Table, whose bottom-left TD in turn contains a 1×1 /Table ("G")
 *  — two levels of nesting in one branch. Leaf cells carry MCIDs 0..6:
 *  0 A, 1 B, 2 C (outer); 3 D, 4 E, 5 F (nested); 6 G (deep). Container cells
 *  (outer bottom-right, nested bottom-left) have no MCID. */
export function buildNestedTablePdf(): Uint8Array {
  const cell = (mcid: number, x: number, y: number, text: string) =>
    `/TD <</MCID ${mcid}>> BDC\nBT /F1 12 Tf ${x} ${y} Td (${text}) Tj ET\nEMC\n`;
  const content =
    cell(0, 50, 340, 'A') +
    cell(1, 150, 340, 'B') +
    cell(2, 50, 300, 'C') +
    cell(3, 160, 280, 'D') +
    cell(4, 240, 280, 'E') +
    cell(5, 240, 250, 'F') +
    cell(6, 160, 250, 'G');

  const objects: string[] = [];
  objects[1] = `<< /Type /Catalog /Pages 2 0 R /StructTreeRoot 6 0 R /MarkInfo << /Marked true >> /Lang (en-US) >>`;
  objects[2] = `<< /Type /Pages /Count 1 /Kids [3 0 R] /MediaBox [0 0 400 400] >>`;
  objects[3] = `<< /Type /Page /Parent 2 0 R /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> /StructParents 0 >>`;
  objects[4] = `<< /Length ${byteLen(content)} >>\nstream\n${content}endstream`;
  objects[5] = `<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>`;
  objects[6] = `<< /Type /StructTreeRoot /K [7 0 R] /ParentTree 8 0 R >>`;
  // Outer table (2x2)
  objects[7] = `<< /Type /StructElem /S /Table /P 6 0 R /Pg 3 0 R /K [9 0 R 10 0 R] >>`;
  objects[8] = `<< /Nums [0 [11 0 R 12 0 R 13 0 R 18 0 R 19 0 R 21 0 R 24 0 R]] >>`;
  objects[9] = `<< /Type /StructElem /S /TR /P 7 0 R /K [11 0 R 12 0 R] >>`;
  objects[10] = `<< /Type /StructElem /S /TR /P 7 0 R /K [13 0 R 14 0 R] >>`;
  objects[11] = `<< /Type /StructElem /S /TD /P 9 0 R /Pg 3 0 R /K 0 >>`;
  objects[12] = `<< /Type /StructElem /S /TD /P 9 0 R /Pg 3 0 R /K 1 >>`;
  objects[13] = `<< /Type /StructElem /S /TD /P 10 0 R /Pg 3 0 R /K 2 >>`;
  objects[14] = `<< /Type /StructElem /S /TD /P 10 0 R /K [15 0 R] >>`;   // container
  // Nested table (inside TD 14)
  objects[15] = `<< /Type /StructElem /S /Table /P 14 0 R /Pg 3 0 R /K [16 0 R 17 0 R] >>`;
  objects[16] = `<< /Type /StructElem /S /TR /P 15 0 R /K [18 0 R 19 0 R] >>`;
  objects[17] = `<< /Type /StructElem /S /TR /P 15 0 R /K [20 0 R 21 0 R] >>`;
  objects[18] = `<< /Type /StructElem /S /TD /P 16 0 R /Pg 3 0 R /K 3 >>`;
  objects[19] = `<< /Type /StructElem /S /TD /P 16 0 R /Pg 3 0 R /K 4 >>`;
  objects[20] = `<< /Type /StructElem /S /TD /P 17 0 R /K [22 0 R] >>`;   // container
  objects[21] = `<< /Type /StructElem /S /TD /P 17 0 R /Pg 3 0 R /K 5 >>`;
  // Deep table (inside TD 20)
  objects[22] = `<< /Type /StructElem /S /Table /P 20 0 R /Pg 3 0 R /K [23 0 R] >>`;
  objects[23] = `<< /Type /StructElem /S /TR /P 22 0 R /K [24 0 R] >>`;
  objects[24] = `<< /Type /StructElem /S /TD /P 23 0 R /Pg 3 0 R /K 6 >>`;
  const maxObj = 24;

  let body = '%PDF-1.7\n%\xE2\xE3\xCF\xD3\n';
  const offsets: number[] = new Array(maxObj + 1).fill(0);
  for (let n = 1; n <= maxObj; n++) {
    if (objects[n] === undefined) continue;
    offsets[n] = byteLen(body);
    body += `${n} 0 obj\n${objects[n]}\nendobj\n`;
  }
  const xrefOffset = byteLen(body);
  let xref = `xref\n0 ${maxObj + 1}\n0000000000 65535 f \n`;
  for (let n = 1; n <= maxObj; n++) {
    xref += offsets[n]
      ? `${String(offsets[n]).padStart(10, '0')} 00000 n \n`
      : `0000000000 00000 f \n`;
  }
  const trailer = `trailer\n<< /Size ${maxObj + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return enc(body + xref + trailer);
}
```

- [ ] **Step 2: Add a smoke test**

In `test/table-tagged.test.ts`, add the import at the top (with the other helper imports):

```ts
import { buildNestedTablePdf } from './helpers/build-nested-table-pdf.js';
```

and add this describe block at the end of the file:

```ts
describe('nested tagged tables', () => {
  it('fixture opens tagged with an outer Table element', () => {
    const doc = Document.Open(buildNestedTablePdf());
    expect(doc.IsTagged).toBe(true);
    const outer = doc.GetStructTree()!.Children[0];
    expect(outer.StandardType).toBe('Table');
  });
});
```

- [ ] **Step 3: Run the smoke test**

Run: `npx vitest run test/table-tagged.test.ts -t "nested tagged tables"`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add test/helpers/build-nested-table-pdf.ts test/table-tagged.test.ts
git commit -m "test(84u): nested tagged /Table fixture + smoke test

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 4: Nesting in `extractTaggedTables`

Stop `findTables` from collecting tables nested inside a table's cells (so only outermost tables are top-level), and make `buildTable` attach each cell's nearest-enclosed `/Table`s as child tables (recursing) while pruning their text from the parent cell.

**Files:**
- Modify: `src/tablestruct.ts` (`findTables`; add `collectNested`; `buildTable` cell construction)
- Test: `test/table-tagged.test.ts` (extend the `nested tagged tables` describe)

**Interfaces:**
- Consumes: `StructElement.GetText(skip?)` (Task 2), `TableCell.tables` (Task 1), `buildNestedTablePdf` (Task 3).
- Produces: `extractTaggedTables` returns only outermost tables per page; each cell may carry `tables: Table[]`.

- [ ] **Step 1: Write the failing tests**

Extend the `nested tagged tables` describe block in `test/table-tagged.test.ts`:

```ts
  const openNested = () => {
    const doc = Document.Open(buildNestedTablePdf());
    return { doc, page: doc.Pages[0] };
  };

  it('returns only the outer table at top level', () => {
    const { doc, page } = openNested();
    const tables = extractTaggedTables(doc, page);
    expect(tables).toHaveLength(1);
    expect(tables[0].rowCount).toBe(2);
    expect(tables[0].colCount).toBe(2);
    expect(tables[0].rows[0].cells.find((c) => c.col === 0)!.text).toBe('A');
    expect(tables[0].rows[1].cells.find((c) => c.col === 0)!.text).toBe('C');
  });

  it('attaches the nested table to its parent cell and strips its text', () => {
    const { doc, page } = openNested();
    const outer = extractTaggedTables(doc, page)[0];
    const container = outer.rows[1].cells.find((c) => c.col === 1)!;
    expect(container.text).toBe('');            // D/E/F/G pruned
    expect(container.text).not.toContain('D');
    expect(container.tables).toHaveLength(1);
    const nested = container.tables![0];
    expect(nested.rowCount).toBe(2);
    expect(nested.colCount).toBe(2);
    const at = (r: number, c: number) => nested.rows[r].cells.find((x) => x.col === c)?.text;
    expect(at(0, 0)).toBe('D');
    expect(at(0, 1)).toBe('E');
    expect(at(1, 1)).toBe('F');
  });

  it('recurses to a second level of nesting', () => {
    const { doc, page } = openNested();
    const nested = extractTaggedTables(doc, page)[0]
      .rows[1].cells.find((c) => c.col === 1)!.tables![0];
    const deepContainer = nested.rows[1].cells.find((c) => c.col === 0)!;
    expect(deepContainer.text).toBe('');
    expect(deepContainer.tables).toHaveLength(1);
    const deep = deepContainer.tables![0];
    expect(deep.rowCount).toBe(1);
    expect(deep.colCount).toBe(1);
    expect(deep.rows[0].cells[0].text).toBe('G');
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/table-tagged.test.ts -t "nested tagged tables"`
Expected: FAIL — today `extractTaggedTables` returns 3 tables (outer + nested + deep, all top-level via `findTables`), and cells carry no `tables` (the container cell's `text` still contains `D E F G` from the un-pruned `GetText()`).

- [ ] **Step 3: Make `findTables` stop at a found table**

In `src/tablestruct.ts`, replace:

```ts
/** Collect every Table element in the tree (depth-first, document order). */
function findTables(elems: StructElement[], out: StructElement[]): void {
  for (const e of elems) {
    if (e.StandardType === 'Table') out.push(e);
    findTables(e.Children, out);
  }
}
```

with:

```ts
/** Collect only top-level Table elements — a table found inside another table's
 *  cells is attached to that cell by buildTable, not returned at top level. */
function findTables(elems: StructElement[], out: StructElement[]): void {
  for (const e of elems) {
    if (e.StandardType === 'Table') out.push(e);
    else findTables(e.Children, out);
  }
}

/** The nearest-enclosed Table elements inside `elem`: descend through non-Table
 *  descendants, stop at and collect the first Table on each branch. */
function collectNested(elem: StructElement, out: StructElement[]): void {
  for (const child of elem.Children) {
    if (child.StandardType === 'Table') out.push(child);
    else collectNested(child, out);
  }
}
```

- [ ] **Step 4: Prune cell text and attach nested tables in `buildTable`**

In `src/tablestruct.ts`, inside `buildTable`, replace the cell construction block. Change:

```ts
      const cell: TableCell = {
        row: r, col: c, rowSpan, colSpan,
        quad: cellQuad(cellElem, page),
        text: cellElem.GetText(),
      };
      if (st === 'TH') cell.isHeader = true;
      if (attrs?.scope) cell.scope = attrs.scope;
      const id = cellElem.ID;
      if (id) cell.id = id;
      if (attrs?.headers && attrs.headers.length) cell.headers = attrs.headers;
      cells.push(cell);
```

to:

```ts
      const cell: TableCell = {
        row: r, col: c, rowSpan, colSpan,
        quad: cellQuad(cellElem, page),
        text: cellElem.GetText((e) => e.StandardType === 'Table'),
      };
      if (st === 'TH') cell.isHeader = true;
      if (attrs?.scope) cell.scope = attrs.scope;
      const id = cellElem.ID;
      if (id) cell.id = id;
      if (attrs?.headers && attrs.headers.length) cell.headers = attrs.headers;
      const nested: StructElement[] = [];
      collectNested(cellElem, nested);
      if (nested.length) {
        const childTables = nested
          .map((n) => buildTable(n, page))
          .filter((t): t is Table => t !== undefined);
        if (childTables.length) cell.tables = childTables;
      }
      cells.push(cell);
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run test/table-tagged.test.ts -t "nested tagged tables"`
Expected: PASS (smoke + three nesting tests).

- [ ] **Step 6: Typecheck + full tagged-table + k33 regression**

Run: `npm run typecheck && npx vitest run test/table-tagged.test.ts`
Expected: no type errors; ALL tests PASS — including the existing k33 `build-tagged-table-pdf` cases (that fixture has no nesting, so its output is unchanged and no cell gains a `tables` field).

- [ ] **Step 7: Commit**

```bash
git add src/tablestruct.ts test/table-tagged.test.ts
git commit -m "feat(84u): nested-table extraction in extractTaggedTables

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 5: Serialization test, README, and close-out

Add a `Page.GetTables()` → `toHtml()` integration test for the nested fixture, update the README, run full verification, record the beads memory, close the issue, and push.

**Files:**
- Test: `test/table-tagged.test.ts` (one integration test)
- Modify: `README.md` (table-extraction API row + limitations note)

- [ ] **Step 1: Write the failing integration test**

Add to the `nested tagged tables` describe block in `test/table-tagged.test.ts`:

```ts
  it('Page.GetTables + toHtml nests the child <table> inside the parent cell', () => {
    const doc = Document.Open(buildNestedTablePdf());
    const html = doc.Pages[0].GetTables()[0].toHtml();
    expect(html).toMatch(/<td[^>]*>[\s\S]*<table>[\s\S]*<\/table>[\s\S]*<\/td>/);
    expect(html).toContain('>D</td>');   // a nested leaf cell renders
  });
```

- [ ] **Step 2: Run it — should already pass**

Run: `npx vitest run test/table-tagged.test.ts -t "toHtml nests"`
Expected: PASS (Tasks 1 + 4 already deliver this; the test locks the end-to-end path in).

If it fails, stop and diagnose before continuing.

- [ ] **Step 3: Update the README API row**

In `README.md`, find the `page.GetTables(options?)` table row and append `/tables`
to the `TableCell` field list. Change the fragment
`with \`row\`/\`col\`/\`rowSpan\`/\`colSpan\`/\`quad\`/\`text\`)` to
`with \`row\`/\`col\`/\`rowSpan\`/\`colSpan\`/\`quad\`/\`text\`/\`tables\`)`.

- [ ] **Step 4: Update the README limitations note**

In `README.md`, replace the existing table-extraction limitation sentence:

```
Still out of scope: rotated/skewed tables, and nested or cross-page tagged tables (a nested `/Table` contributes its text to the enclosing cell but is not emitted as its own table).
```

with:

```
Nested tables are extracted from the tagged `/Table` tree (a nested `/Table` inside a cell is attached to that cell's `tables` and rendered as an inner `<table>` by `toHtml()`, its text removed from the parent cell); nested detection in the geometry path is not yet implemented. Still out of scope: rotated/skewed tables, cross-page tables, and geometry-path nested tables.
```

- [ ] **Step 5: Full verification**

Run: `npm run typecheck && npm test && npm run build`
Expected: no type errors; entire suite green; `dist/` emitted.

- [ ] **Step 6: Record the beads memory and close the issue**

```bash
bd remember --key nested-table-extraction-shipped "Nested tagged tables shipped (84u). src/tablestruct.ts: findTables now stops descending into a found Table (only outermost tables are top-level); buildTable collects each cell's nearest-enclosed /Table via collectNested and recurses (unbounded depth), attaching them as TableCell.tables (new optional field in tablemodel.ts). Parent cell text uses StructElement.GetText(skip) with skip=(e)=>e.StandardType==='Table' (GetText gained an optional skip predicate in struct.ts; behavior-preserving). Table.toHtml() emits nested <table> inside the parent td/th after the text; non-nested output byte-identical; toMarkdown unchanged (nested omitted). Fixture test/helpers/build-nested-table-pdf.ts (2 levels deep). Geometry-path nesting deferred to e2o (flat detector conflates nesting levels). Cross-page 7ac, rotated 5ct still open."
bd close aspose-pdf-foss-for-ts-84u
```

- [ ] **Step 7: Commit**

```bash
git add README.md test/table-tagged.test.ts .beads
git commit -m "docs(84u): document nested tagged tables; close issue

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

- [ ] **Step 8: Push (session-completion protocol)**

```bash
git pull --rebase
git push
git status   # MUST show "up to date with origin"
```

---

## Self-Review

**Spec coverage:**
- `tables?: Table[]` model field → Task 1. ✓
- Nested `toHtml()` (inner `<table>`, `toMarkdown` unchanged) → Task 1 + Task 5 integration test. ✓
- Tagged unbounded recursion + top-level invariant (`findTables` stop-descend) → Task 4. ✓
- Pruned parent-cell text via `GetText` skip predicate → Task 2 (predicate) + Task 4 (use). ✓
- Nearest-enclosed nested collection (`collectNested`) → Task 4. ✓
- 2-level fixture + tests → Task 3 + Task 4. ✓
- Geometry deferred to `e2o` → not implemented here; README note (Task 5) + design doc. ✓
- README update → Task 5. ✓
- Regression (k33 fixture unchanged, byte-identical non-nested output) → Task 1 Step 6, Task 4 Step 6, Task 5 Step 5. ✓

**Placeholder scan:** No TBD/TODO; every code step shows complete code, exact edit targets, and exact commands with expected results.

**Type consistency:** `GetText(skip?: (e: StructElement) => boolean)` defined in Task 2 and called with `(e) => e.StandardType === 'Table'` in Task 4. `TableCell.tables?: Table[]` defined in Task 1, populated in Task 4, read in Task 1's `toHtml` and Task 5's test. `buildNestedTablePdf()` defined in Task 3, used in Tasks 3/4/5. `collectNested(elem, out)` and the `t is Table` filter use the `Table` value import already present in `tablestruct.ts`. `buildTable(n, page)` matches the existing `buildTable(table: StructElement, page: Page)` signature.
```

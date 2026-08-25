# Tagged-PDF `/Table` Structure-Tree Extraction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reconstruct tables from a tagged PDF's `/Table → TR → TH/TD` structure tree — authoritative rows/cells/spans plus header/scope/section/summary semantics — and use it automatically from `Page.GetTables()` when available, falling back to geometry.

**Architecture:** Factor the shared `Table` model out of `src/table.ts` into `src/tablemodel.ts` so both the geometry extractor and a new `src/tablestruct.ts` (tagged extractor) can produce it without an import cycle. `extractTables()` in `table.ts` becomes a dispatcher: it tries the tagged extractor first (unless `structure:'off'`) and falls back to geometry. Cell quads come from a cell's `/BBox` layout attribute, else a new `StructElement.GetBBox()` glyph-union helper.

**Tech Stack:** TypeScript (ESM + NodeNext, `strict`), vitest. Zero runtime deps (`node:` built-ins only).

## Global Constraints

- Zero runtime dependencies — only `node:` built-ins. Do not add npm runtime deps.
- ESM + NodeNext: every relative import specifier carries a `.js` extension.
- `strict` TypeScript; `npm run typecheck` and `npm test` must both be green before closing the issue.
- TDD: write the failing test first, watch it fail, then implement.
- Follow existing patterns: fixtures are built programmatically in `test/helpers/`; tests live in `test/*.test.ts`.
- Public error types: `PdfParseError`, `UnsupportedFeatureError`, `InvalidPasswordError` (do not invent new error classes).
- Keep `README.md` in sync when public API changes.
- Reference issue: `aspose-pdf-foss-for-ts-k33`.

---

## Task 1: Extract the shared table model into `tablemodel.ts`

Pure structural refactor plus additive fields. Move `Rect`, `TableExtractOptions`, `TableCell`, `TableRow`, `escHtml`, and the `Table` class out of `src/table.ts` into a new `src/tablemodel.ts`; add the new optional fields and the `structure` option. `table.ts` imports and re-exports them so every existing import site (`index.ts`, `page.ts`) is unaffected. No behavior change — existing tests stay green.

**Files:**
- Create: `src/tablemodel.ts`
- Modify: `src/table.ts` (remove moved definitions; import + re-export from `tablemodel.js`)
- Test: `test/table.test.ts` (existing suite is the regression gate; no new test needed here)

**Interfaces:**
- Produces (consumed by Tasks 3, 4, 5):
  - `type Rect = [number, number, number, number]` (re-exported from `text.ts` via `table.ts` today; in `tablemodel.ts` import it as `import type { Rect as TextRect } from './text.js'; export type Rect = TextRect;`)
  - `interface TableExtractOptions { region?: Rect; structure?: 'auto' | 'off'; }`
  - `interface TableCell { row: number; col: number; rowSpan: number; colSpan: number; quad: Rect; text: string; isHeader?: boolean; scope?: string; id?: string; headers?: string[]; }`
  - `interface TableRow { cells: TableCell[]; quad: Rect; section?: 'head' | 'body' | 'foot'; }`
  - `class Table { constructor(quad: Rect, rowCount: number, colCount: number, rows: TableRow[], summary?: string); toHtml(): string; toMarkdown(): string; }`

- [ ] **Step 1: Create `src/tablemodel.ts` with the moved model + new fields**

```ts
import type { Rect as TextRect } from './text.js';

export type Rect = TextRect;
export interface TableExtractOptions { region?: Rect; structure?: 'auto' | 'off'; }
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
}
export interface TableRow { cells: TableCell[]; quad: Rect; section?: 'head' | 'body' | 'foot'; }

const escHtml = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** A reconstructed table: a rows×cells model with page-space quads and text,
 *  serializable to HTML or Markdown. */
export class Table {
  constructor(
    public quad: Rect,
    public rowCount: number,
    public colCount: number,
    public rows: TableRow[],
    /** Tagged path only: the table's `/Summary`. */
    public summary?: string,
  ) {}

  toHtml(): string {
    const lines = ['<table>'];
    for (const row of this.rows) {
      lines.push('  <tr>');
      for (const c of row.cells) {
        const attrs =
          (c.colSpan > 1 ? ` colspan="${c.colSpan}"` : '') +
          (c.rowSpan > 1 ? ` rowspan="${c.rowSpan}"` : '');
        lines.push(`    <td${attrs}>${escHtml(c.text).replace(/\n/g, '<br>')}</td>`);
      }
      lines.push('  </tr>');
    }
    lines.push('</table>');
    return lines.join('\n');
  }

  toMarkdown(): string {
    // Expand spans into a dense grid of strings (colSpan repeats, rowSpan blanks below).
    const grid: string[][] = Array.from({ length: this.rowCount }, () => new Array(this.colCount).fill(''));
    for (const row of this.rows) {
      for (const c of row.cells) {
        const cell = c.text.replace(/\n/g, ' ');
        for (let dr = 0; dr < c.rowSpan; dr++)
          for (let dc = 0; dc < c.colSpan; dc++)
            grid[c.row + dr][c.col + dc] = dr === 0 ? cell : '';
      }
    }
    const fmt = (r: string[]) => `| ${r.map((s) => s.replace(/\|/g, '\\|')).join(' | ')} |`;
    const out = [fmt(grid[0]), `| ${new Array(this.colCount).fill('---').join(' | ')} |`];
    for (let r = 1; r < grid.length; r++) out.push(fmt(grid[r]));
    return out.join('\n');
  }
}
```

Note: this is the current `toHtml`/`toMarkdown` verbatim (only the constructor gains the optional `summary` param and `escHtml` moves here). Task 5 enriches `toHtml`.

- [ ] **Step 2: Trim `src/table.ts` — remove the moved definitions, import + re-export**

At the top of `src/table.ts`, the current lines 1–8 define `Rect`, `TableExtractOptions`, `TableCell`, `TableRow`. Replace them so `table.ts` imports the model instead. Change the header of `src/table.ts` from:

```ts
import { visitContent, extractFragments, type PathEvent, type TextFragment, type Rect as TextRect } from './text.js';
import type { Document } from './document.js';
import type { Page } from './page.js';

export type Rect = TextRect;
export interface TableExtractOptions { region?: Rect; }
export interface TableCell { row: number; col: number; rowSpan: number; colSpan: number; quad: Rect; text: string; }
export interface TableRow { cells: TableCell[]; quad: Rect; }
```

to:

```ts
import { visitContent, extractFragments, type PathEvent, type TextFragment } from './text.js';
import type { Document } from './document.js';
import type { Page } from './page.js';
import { Table } from './tablemodel.js';
import type { Rect, TableExtractOptions, TableCell, TableRow } from './tablemodel.js';

export { Table } from './tablemodel.js';
export type { Rect, TableExtractOptions, TableCell, TableRow } from './tablemodel.js';
```

- [ ] **Step 3: Delete the old `escHtml` and `Table` class body from `src/table.ts`**

Remove these blocks from `src/table.ts` (now provided by `tablemodel.ts`):
- The `escHtml` const (current lines 70–71).
- The entire `export class Table { … }` block (current lines 73–115), including its doc comment.

Leave everything else (`collectRules`, `buildCells`, `assembleTable`, `detectWhitespaceTable`, `extractTables`, etc.) untouched. The remaining code references `Table` (via the new import) and `Rect`/`TableCell`/`TableRow` (via the new type import).

- [ ] **Step 4: Typecheck**

Run: `npm run typecheck`
Expected: no errors. (If `Table` is reported as unused in `table.ts`, confirm `assembleTable`/`detectWhitespaceTable` still call `new Table(...)` — they do, so it is used.)

- [ ] **Step 5: Run the existing table suite to confirm no behavior change**

Run: `npx vitest run test/table.test.ts`
Expected: PASS (all existing tests green — the refactor is behavior-preserving).

- [ ] **Step 6: Commit**

```bash
git add src/tablemodel.ts src/table.ts
git commit -m "refactor(k33): extract shared Table model into tablemodel.ts

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 2: `StructElement.GetBBox()` glyph-union helper

Add a method to `StructElement` that returns the union of the page-space quads of all glyphs behind the element's marked content (recursing into descendant elements), or `undefined` when it contributes no glyphs. This is the cell-quad fallback for the tagged extractor.

**Files:**
- Modify: `src/struct.ts` (add `GetBBox` method to `StructElement`; add a private recursion helper)
- Test: `test/struct.test.ts` (add one test using the existing `buildTaggedPdf` fixture)

**Interfaces:**
- Consumes: existing internal `mcidGlyphs(doc, page): Map<number, GlyphEvent[]>` and `GlyphEvent.quad: [number, number, number, number]` (from `text.ts`).
- Produces (consumed by Task 4): `StructElement.GetBBox(page?: Page): [number, number, number, number] | undefined`.

- [ ] **Step 1: Write the failing test**

Add to `test/struct.test.ts` (near the other `StructElement` tests). The `buildTaggedPdf` fixture has an `H1` element (MyHead) with `/K 0` showing "Hello Heading" at `50 350` in 24pt; its bbox must be a plausible page-space rect at roughly that origin.

```ts
it('GetBBox unions the glyph quads behind an element', () => {
  const doc = Document.Open(buildTaggedPdf());
  const root = doc.GetStructTree()!;
  const docElem = root.Children[0];         // Document
  const heading = docElem.Children[0];      // H1 (MyHead), /K 0
  const bbox = heading.GetBBox();
  expect(bbox).toBeDefined();
  const [x0, y0, x1, y1] = bbox!;
  expect(x0).toBeCloseTo(50, 0);            // Td x origin
  expect(y0).toBeGreaterThan(340);          // baseline ~350
  expect(x1).toBeGreaterThan(x0);           // non-empty width
  expect(y1).toBeGreaterThan(y0);           // non-empty height
});

it('GetBBox returns undefined for an element with no glyphs', () => {
  const doc = Document.Open(buildTaggedPdf());
  const root = doc.GetStructTree()!;
  const figure = root.Children[0].Children[2];   // Figure: OBJR only, no glyphs
  expect(figure.GetBBox()).toBeUndefined();
});
```

If `Document` / `buildTaggedPdf` are not already imported at the top of `test/struct.test.ts`, they are (this file already exercises the fixture) — reuse the existing imports.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/struct.test.ts -t "GetBBox"`
Expected: FAIL with "GetBBox is not a function" (method does not exist yet).

- [ ] **Step 3: Implement `GetBBox` on `StructElement`**

In `src/struct.ts`, add this method to the `StructElement` class (place it just after `GetText()`, near line 198). It mirrors `GetText`'s `/K` recursion but collects `GlyphEvent`s and unions their quads.

```ts
  /** Union of the page-space quads of every glyph behind this element's marked
   *  content (recursing into descendant elements), or undefined when it
   *  contributes no glyphs. `page` defaults to this element's own /Pg page. */
  GetBBox(page?: Page): [number, number, number, number] | undefined {
    const glyphs: GlyphEvent[] = [];
    this.collectGlyphs(page ?? this.Page, glyphs);
    if (!glyphs.length) return undefined;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const g of glyphs) {
      x0 = Math.min(x0, g.quad[0]); y0 = Math.min(y0, g.quad[1]);
      x1 = Math.max(x1, g.quad[2]); y1 = Math.max(y1, g.quad[3]);
    }
    return [x0, y0, x1, y1];
  }

  private collectGlyphs(ownPage: Page | undefined, out: GlyphEvent[]): void {
    for (const k of kids(this.doc, this.Dict)) {
      const r = this.doc.resolve(k);
      if (typeof r === 'number') {
        if (ownPage) out.push(...(mcidGlyphs(this.doc, ownPage).get(r) ?? []));
      } else if (isStructElem(this.doc, k)) {
        const child = new StructElement(this.doc, r as PdfDict, isRef(k) ? k : undefined, this.Root);
        child.collectGlyphs(child.Page ?? ownPage, out);
      } else if (isDict(r)) {
        const type = this.doc.resolve(r.get('Type'));
        if (isName(type) && type.name === 'MCR') {
          const mcid = this.doc.resolve(r.get('MCID'));
          const pg = r.get('Pg');
          const page = isRef(pg) ? this.doc.pageForRef(pg) : ownPage;
          if (typeof mcid === 'number' && page) out.push(...(mcidGlyphs(this.doc, page).get(mcid) ?? []));
        }
        // OBJR: no glyph contribution.
      }
    }
  }
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/struct.test.ts -t "GetBBox"`
Expected: PASS (both new tests).

- [ ] **Step 5: Typecheck and run the full struct suite**

Run: `npm run typecheck && npx vitest run test/struct.test.ts`
Expected: no type errors; all struct tests PASS.

- [ ] **Step 6: Commit**

```bash
git add src/struct.ts test/struct.test.ts
git commit -m "feat(k33): StructElement.GetBBox glyph-union bounding box

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 3: Tagged-table fixture builder

Add a fixture builder that produces a one-page tagged PDF whose structure tree is a real `/Table` with `THead`/`TBody`, `colSpan`/`rowSpan`, `scope`, `/ID`+`/Headers` association, `/Summary`, and one cell without a `/BBox` (to exercise the glyph-union fallback) plus one with a `/BBox`. This fixture drives Tasks 4 and 5.

**Files:**
- Create: `test/helpers/build-tagged-table-pdf.ts`
- Test: covered indirectly by Tasks 4/5; add a smoke assertion here.

**Interfaces:**
- Produces (consumed by Tasks 4, 5): `buildTaggedTablePdf(): Uint8Array`.

Table layout (page 400×400, `/Pg` = page 3):

| grid | col 0 | col 1 | col 2 |
|------|-------|-------|-------|
| row 0 (head) | `TH` "Name" (id h1, scope Column) | `TH` "Info" (id h2, scope Column, **colSpan 2**) | ← |
| row 1 (body) | `TD` "Alice" (headers [h1]) | `TD` "30" | `TD` "NYC" (**has /BBox**) |
| row 2 (body) | `TD` "Bob" (**rowSpan 2**) | `TD` "25" | `TD` "LA" |
| row 3 (body) | ↑ (occupied by Bob) | `TD` "40" | `TD` "SF" |

- [ ] **Step 1: Create `test/helpers/build-tagged-table-pdf.ts`**

```ts
const enc = (s: string) => new TextEncoder().encode(s);
const byteLen = (s: string) => enc(s).length;

/** One-page classic-xref tagged PDF containing a single /Table.
 *
 *  3 columns × 4 rows. THead has one row (TH "Name" id h1 scope Column;
 *  TH "Info" id h2 scope Column colSpan 2). TBody has three rows; "Bob" spans
 *  two rows. "Alice" has /Headers [h1]. The table carries /Summary. The "NYC"
 *  cell has a /Layout /BBox; every other cell's quad comes from glyph union.
 *  MCIDs 0..9 map to the ten cells in reading order via /ParentTree key 0. */
export function buildTaggedTablePdf(): Uint8Array {
  const cell = (mcid: number, tag: string, x: number, y: number, text: string) =>
    `/${tag} <</MCID ${mcid}>> BDC\nBT /F1 12 Tf ${x} ${y} Td (${text}) Tj ET\nEMC\n`;
  const content =
    cell(0, 'TH', 50, 340, 'Name') +
    cell(1, 'TH', 150, 340, 'Info') +
    cell(2, 'TD', 50, 315, 'Alice') +
    cell(3, 'TD', 150, 315, '30') +
    cell(4, 'TD', 250, 315, 'NYC') +
    cell(5, 'TD', 50, 290, 'Bob') +
    cell(6, 'TD', 150, 290, '25') +
    cell(7, 'TD', 250, 290, 'LA') +
    cell(8, 'TD', 150, 265, '40') +
    cell(9, 'TD', 250, 265, 'SF');

  const objects: string[] = [];
  objects[1] = `<< /Type /Catalog /Pages 2 0 R /StructTreeRoot 6 0 R /MarkInfo << /Marked true >> /Lang (en-US) >>`;
  objects[2] = `<< /Type /Pages /Count 1 /Kids [3 0 R] /MediaBox [0 0 400 400] >>`;
  objects[3] = `<< /Type /Page /Parent 2 0 R /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> /StructParents 0 >>`;
  objects[4] = `<< /Length ${byteLen(content)} >>\nstream\n${content}endstream`;
  objects[5] = `<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>`;
  objects[6] = `<< /Type /StructTreeRoot /K [7 0 R] /ParentTree 8 0 R >>`;
  // Table + sections
  objects[7] = `<< /Type /StructElem /S /Table /P 6 0 R /Pg 3 0 R /K [9 0 R 10 0 R] /A << /O /Table /Summary (Employee directory) >> >>`;
  objects[9] = `<< /Type /StructElem /S /THead /P 7 0 R /K [11 0 R] >>`;
  objects[10] = `<< /Type /StructElem /S /TBody /P 7 0 R /K [12 0 R 13 0 R 14 0 R] >>`;
  // Rows
  objects[11] = `<< /Type /StructElem /S /TR /P 9 0 R /K [15 0 R 16 0 R] >>`;
  objects[12] = `<< /Type /StructElem /S /TR /P 10 0 R /K [17 0 R 18 0 R 19 0 R] >>`;
  objects[13] = `<< /Type /StructElem /S /TR /P 10 0 R /K [20 0 R 21 0 R 22 0 R] >>`;
  objects[14] = `<< /Type /StructElem /S /TR /P 10 0 R /K [23 0 R 24 0 R] >>`;
  // Header cells
  objects[15] = `<< /Type /StructElem /S /TH /P 11 0 R /Pg 3 0 R /K 0 /ID (h1) /A << /O /Table /Scope /Column >> >>`;
  objects[16] = `<< /Type /StructElem /S /TH /P 11 0 R /Pg 3 0 R /K 1 /ID (h2) /A << /O /Table /Scope /Column /ColSpan 2 >> >>`;
  // Body row 1
  objects[17] = `<< /Type /StructElem /S /TD /P 12 0 R /Pg 3 0 R /K 2 /A << /O /Table /Headers [(h1)] >> >>`;
  objects[18] = `<< /Type /StructElem /S /TD /P 12 0 R /Pg 3 0 R /K 3 >>`;
  objects[19] = `<< /Type /StructElem /S /TD /P 12 0 R /Pg 3 0 R /K 4 /A << /O /Layout /BBox [250 312 285 328] >> >>`;
  // Body row 2 ("Bob" rowSpan 2)
  objects[20] = `<< /Type /StructElem /S /TD /P 13 0 R /Pg 3 0 R /K 5 /A << /O /Table /RowSpan 2 >> >>`;
  objects[21] = `<< /Type /StructElem /S /TD /P 13 0 R /Pg 3 0 R /K 6 >>`;
  objects[22] = `<< /Type /StructElem /S /TD /P 13 0 R /Pg 3 0 R /K 7 >>`;
  // Body row 3 (col 0 occupied by Bob's rowSpan)
  objects[23] = `<< /Type /StructElem /S /TD /P 14 0 R /Pg 3 0 R /K 8 >>`;
  objects[24] = `<< /Type /StructElem /S /TD /P 14 0 R /Pg 3 0 R /K 9 >>`;
  // ParentTree: page StructParents key 0 -> cell elems by MCID 0..9
  objects[8] = `<< /Nums [0 [15 0 R 16 0 R 17 0 R 18 0 R 19 0 R 20 0 R 21 0 R 22 0 R 23 0 R 24 0 R]] >>`;
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

Note: object numbers are assigned out of sequential order (8 is written last) but every number 1..24 is populated, so the loops and xref stay dense. The `if (objects[n] === undefined) continue;` guard is defensive only.

- [ ] **Step 2: Add a smoke test that the fixture opens and is tagged**

Create `test/table-tagged.test.ts` with an initial smoke test (Task 4 adds the rest):

```ts
import { describe, it, expect } from 'vitest';
import { Document } from '../src/index.js';
import { buildTaggedTablePdf } from './helpers/build-tagged-table-pdf.js';

describe('tagged table extraction', () => {
  it('fixture opens as a tagged document with a Table element', () => {
    const doc = Document.Open(buildTaggedTablePdf());
    expect(doc.IsTagged).toBe(true);
    const root = doc.GetStructTree()!;
    expect(root).toBeTruthy();
    const table = root.Children[0];
    expect(table.StandardType).toBe('Table');
  });
});
```

- [ ] **Step 3: Run the smoke test**

Run: `npx vitest run test/table-tagged.test.ts`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add test/helpers/build-tagged-table-pdf.ts test/table-tagged.test.ts
git commit -m "test(k33): tagged /Table fixture builder + smoke test

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 4: `extractTaggedTables()` — the tagged extractor

Implement the structure-tree walk into the `Table` model in a new `src/tablestruct.ts`. Grid placement uses HTML-style occupancy; cell quads prefer `/BBox`, else `GetBBox()`; sections, headers, scope, id, headers, and summary are populated.

**Files:**
- Create: `src/tablestruct.ts`
- Test: `test/table-tagged.test.ts` (extend)

**Interfaces:**
- Consumes: `Document`, `Page`; `doc.GetStructTree()`, `doc.IsTagged`; `StructTreeRoot.Children`, `StructElement` (`StandardType`, `Children`, `Page`, `ID`, `GetText()`, `GetBBox()`, `TableAttributes`, `LayoutAttributes`); `Table`/`TableCell`/`TableRow`/`Rect`/`TableExtractOptions` from `tablemodel.js`.
- Produces (consumed by Task 5): `extractTaggedTables(doc: Document, page: Page, options?: TableExtractOptions): Table[]`.

- [ ] **Step 1: Write the failing tests (extend `test/table-tagged.test.ts`)**

```ts
import { extractTaggedTables } from '../src/tablestruct.js';
// (add to the existing imports at the top of the file)

describe('extractTaggedTables', () => {
  const open = () => {
    const doc = Document.Open(buildTaggedTablePdf());
    return { doc, page: doc.Pages[0] };
  };

  it('reconstructs a 3×4 grid with the right cell text', () => {
    const { doc, page } = open();
    const [t] = extractTaggedTables(doc, page);
    expect(t).toBeTruthy();
    expect(t.rowCount).toBe(4);
    expect(t.colCount).toBe(3);
    const at = (r: number, c: number) =>
      t.rows[r].cells.find((x) => x.row === r && x.col === c)?.text;
    expect(at(0, 0)).toBe('Name');
    expect(at(1, 0)).toBe('Alice');
    expect(at(1, 2)).toBe('NYC');
    expect(at(2, 0)).toBe('Bob');
    expect(at(3, 1)).toBe('40');
    expect(at(3, 2)).toBe('SF');
  });

  it('reads colSpan and rowSpan from TableAttributes', () => {
    const { doc, page } = open();
    const [t] = extractTaggedTables(doc, page);
    const info = t.rows[0].cells.find((c) => c.text === 'Info')!;
    expect(info.colSpan).toBe(2);
    expect(info.col).toBe(1);
    const bob = t.rows[2].cells.find((c) => c.text === 'Bob')!;
    expect(bob.rowSpan).toBe(2);
    expect(bob.col).toBe(0);
    // Row 3's first data cell lands in column 1 because Bob occupies column 0.
    const forty = t.rows[3].cells.find((c) => c.text === '40')!;
    expect(forty.col).toBe(1);
  });

  it('tags sections, headers, scope, id and header associations', () => {
    const { doc, page } = open();
    const [t] = extractTaggedTables(doc, page);
    expect(t.rows[0].section).toBe('head');
    expect(t.rows[1].section).toBe('body');
    const name = t.rows[0].cells.find((c) => c.text === 'Name')!;
    expect(name.isHeader).toBe(true);
    expect(name.scope).toBe('Column');
    expect(name.id).toBe('h1');
    const alice = t.rows[1].cells.find((c) => c.text === 'Alice')!;
    expect(alice.isHeader).toBeFalsy();
    expect(alice.headers).toEqual(['h1']);
    expect(t.summary).toBe('Employee directory');
  });

  it('takes a cell quad from /BBox when present, else glyph union', () => {
    const { doc, page } = open();
    const [t] = extractTaggedTables(doc, page);
    const nyc = t.rows[1].cells.find((c) => c.text === 'NYC')!;
    expect(nyc.quad).toEqual([250, 312, 285, 328]);   // from /BBox
    const alice = t.rows[1].cells.find((c) => c.text === 'Alice')!;
    expect(alice.quad[0]).toBeCloseTo(50, 0);          // from glyph union
    expect(alice.quad[2]).toBeGreaterThan(alice.quad[0]);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/table-tagged.test.ts -t "extractTaggedTables"`
Expected: FAIL — cannot find module `../src/tablestruct.js` (not created yet).

- [ ] **Step 3: Implement `src/tablestruct.ts`**

```ts
import type { Document } from './document.js';
import type { Page } from './page.js';
import type { StructElement } from './struct.js';
import { Table } from './tablemodel.js';
import type { Rect, TableCell, TableRow, TableExtractOptions } from './tablemodel.js';

const ZERO: Rect = [0, 0, 0, 0];

const unionRect = (rects: Rect[]): Rect => {
  const nz = rects.filter((r) => r[2] > r[0] || r[3] > r[1]);
  if (!nz.length) return ZERO;
  return [
    Math.min(...nz.map((r) => r[0])), Math.min(...nz.map((r) => r[1])),
    Math.max(...nz.map((r) => r[2])), Math.max(...nz.map((r) => r[3])),
  ];
};

const centroid = (q: Rect): [number, number] => [(q[0] + q[2]) / 2, (q[1] + q[3]) / 2];
const contains = (q: Rect, x: number, y: number): boolean => x >= q[0] && x <= q[2] && y >= q[1] && y <= q[3];

/** Collect every Table element in the tree (depth-first, document order). */
function findTables(elems: StructElement[], out: StructElement[]): void {
  for (const e of elems) {
    if (e.StandardType === 'Table') out.push(e);
    findTables(e.Children, out);
  }
}

interface RawRow { row: StructElement; section?: 'head' | 'body' | 'foot'; }

/** Flatten a Table's children into ordered rows with their section label. */
function tableRows(table: StructElement): RawRow[] {
  const out: RawRow[] = [];
  for (const child of table.Children) {
    const t = child.StandardType;
    if (t === 'TR') out.push({ row: child });
    else if (t === 'THead') for (const tr of child.Children) if (tr.StandardType === 'TR') out.push({ row: tr, section: 'head' });
    else if (t === 'TBody') for (const tr of child.Children) if (tr.StandardType === 'TR') out.push({ row: tr, section: 'body' });
    else if (t === 'TFoot') for (const tr of child.Children) if (tr.StandardType === 'TR') out.push({ row: tr, section: 'foot' });
  }
  return out;
}

/** The page-space quad for a cell: /BBox layout attribute, else glyph union. */
function cellQuad(cell: StructElement, page: Page): Rect {
  const bbox = cell.LayoutAttributes?.bbox;
  if (bbox) return bbox;
  return cell.GetBBox(page) ?? ZERO;
}

/** Build one Table from a Table structure element. */
function buildTable(table: StructElement, page: Page): Table | undefined {
  const rawRows = tableRows(table);
  if (!rawRows.length) return undefined;

  // HTML-style occupancy: occupied[r] is a set of taken column indices.
  const occupied: Set<number>[] = rawRows.map(() => new Set<number>());
  const rows: TableRow[] = [];
  let colCount = 0;

  rawRows.forEach((rr, r) => {
    const cells: TableCell[] = [];
    let c = 0;
    for (const cellElem of rr.row.Children) {
      const st = cellElem.StandardType;
      if (st !== 'TD' && st !== 'TH') continue;
      while (occupied[r].has(c)) c++;
      const attrs = cellElem.TableAttributes;
      const rowSpan = Math.max(1, attrs?.rowSpan ?? 1);
      const colSpan = Math.max(1, attrs?.colSpan ?? 1);
      for (let dr = 0; dr < rowSpan; dr++)
        for (let dc = 0; dc < colSpan; dc++)
          occupied[r + dr]?.add(c + dc);
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
      colCount = Math.max(colCount, c + colSpan);
      c += colSpan;
    }
    rows.push({ cells, quad: unionRect(cells.map((x) => x.quad)), section: rr.section });
  });

  const quad = unionRect(rows.map((x) => x.quad));
  const summary = table.TableAttributes?.summary;
  return new Table(quad, rows.length, colCount, rows, summary);
}

/** Primary page of a Table: page of its first content-bearing cell, else /Pg. */
function primaryPage(table: StructElement): Page | undefined {
  for (const { row } of tableRows(table))
    for (const cell of row.Children) {
      if (cell.StandardType !== 'TD' && cell.StandardType !== 'TH') continue;
      const p = cell.Page;
      if (p) return p;
    }
  return table.Page;
}

/** Extract tables from a page's tagged /Table structure elements. Returns []
 *  when the document is untagged or the page has no Table structure. */
export function extractTaggedTables(doc: Document, page: Page, options: TableExtractOptions = {}): Table[] {
  const root = doc.GetStructTree();
  if (!root) return [];
  const tables: StructElement[] = [];
  findTables(root.Children, tables);
  const out: Table[] = [];
  for (const te of tables) {
    if (primaryPage(te)?.Number !== page.Number) continue;
    const t = buildTable(te, page);
    if (!t || !t.rows.length) continue;
    if (options.region && !contains(options.region, ...centroid(t.quad))) continue;
    out.push(t);
  }
  return out;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/table-tagged.test.ts -t "extractTaggedTables"`
Expected: PASS (all four tests).

- [ ] **Step 5: Typecheck and run the whole tagged-table file**

Run: `npm run typecheck && npx vitest run test/table-tagged.test.ts`
Expected: no type errors; all PASS.

- [ ] **Step 6: Commit**

```bash
git add src/tablestruct.ts test/table-tagged.test.ts
git commit -m "feat(k33): extractTaggedTables structure-tree table extractor

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 5: Dispatcher wiring + serialization enrichment + exports

Make `Page.GetTables()` auto-use the tagged extractor (with `structure:'off'` escape hatch), enrich `Table.toHtml()` with sections/`<th>`/`<caption>`, add public exports, and update the README.

**Files:**
- Modify: `src/table.ts` (`extractTables` dispatcher)
- Modify: `src/tablemodel.ts` (`toHtml` enrichment)
- Modify: `src/index.ts` (export `extractTaggedTables`)
- Modify: `src/page.ts` (doc comment for the `structure` option — signature already accepts `TableExtractOptions`)
- Modify: `README.md`
- Test: `test/table-tagged.test.ts` (dispatcher + toHtml tests)

**Interfaces:**
- Consumes: `extractTaggedTables` (Task 4), the enriched `Table` model (Task 1).
- Produces: no new signatures; `extractTables` behavior gains the tagged-first path.

- [ ] **Step 1: Write the failing tests (extend `test/table-tagged.test.ts`)**

```ts
import { buildTablePdf, hline, vline, text } from './helpers/build-table-pdf.js';   // existing geometry fixture

describe('GetTables dispatcher + serialization', () => {
  it('Page.GetTables auto-uses the structure tree for a tagged table', () => {
    const doc = Document.Open(buildTaggedTablePdf());
    const t = doc.Pages[0].GetTables();
    expect(t).toHaveLength(1);
    expect(t[0].rows[0].cells[0].isHeader).toBe(true);   // proves the tagged path ran
    expect(t[0].summary).toBe('Employee directory');
  });

  it("structure:'off' forces the geometry path (no tagged semantics)", () => {
    const doc = Document.Open(buildTaggedTablePdf());
    const t = doc.Pages[0].GetTables({ structure: 'off' });
    // Geometry path never sets isHeader/summary; the tagged fixture has no
    // ruling lines, so geometry falls to whitespace detection or returns [].
    for (const tbl of t) {
      expect(tbl.summary).toBeUndefined();
      for (const row of tbl.rows) for (const cell of row.cells) expect(cell.isHeader).toBeUndefined();
    }
  });

  it('toHtml emits sections, <th scope>, headers and <caption>', () => {
    const doc = Document.Open(buildTaggedTablePdf());
    const html = doc.Pages[0].GetTables()[0].toHtml();
    expect(html).toContain('<caption>Employee directory</caption>');
    expect(html).toContain('<thead>');
    expect(html).toContain('<tbody>');
    expect(html).toContain('<th scope="Column" id="h1">Name</th>');
    expect(html).toContain('colspan="2"');
    expect(html).toContain('headers="h1"');
  });

  it('a non-tagged page still uses geometry (regression)', () => {
    const stream =
      hline(50, 150, 200) + hline(50, 150, 150) + hline(50, 150, 100) +
      vline(50, 100, 200) + vline(100, 100, 200) + vline(150, 100, 200) +
      text(55, 175, 'A') + text(105, 175, 'B') +
      text(55, 125, 'C') + text(105, 125, 'D');
    const doc = Document.Open(buildTablePdf(stream));
    const t = doc.Pages[0].GetTables();
    expect(t.length).toBeGreaterThan(0);
    // Geometry path: no tagged fields.
    expect(t[0].summary).toBeUndefined();
    expect(t[0].rows[0].cells[0].isHeader).toBeUndefined();
  });
});
```

Note: `buildTablePdf(stream: string)` takes a content-stream string (not a ready-made PDF) and `hline`/`vline`/`text` are its companion helpers — this ruled 2×2 grid is copied from the existing `test/table.test.ts` "ruled" test, so it is known to produce a geometry table.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/table-tagged.test.ts -t "dispatcher"`
Expected: FAIL — `GetTables()` currently returns the geometry result, so `isHeader`/`summary`/`<caption>` assertions fail.

- [ ] **Step 3: Wire the dispatcher in `src/table.ts`**

Add the tagged import near the top of `src/table.ts` (after the existing imports):

```ts
import { extractTaggedTables } from './tablestruct.js';
```

Then change the top of `extractTables` (current line 291) from:

```ts
export function extractTables(doc: Document, page: Page, options: TableExtractOptions = {}): Table[] {
  const { horiz, vert } = collectRules(doc, page, options.region);
```

to:

```ts
export function extractTables(doc: Document, page: Page, options: TableExtractOptions = {}): Table[] {
  if (options.structure !== 'off') {
    const tagged = extractTaggedTables(doc, page, options);
    if (tagged.length) return tagged;
  }
  const { horiz, vert } = collectRules(doc, page, options.region);
```

The rest of `extractTables` (geometry ruled path + whitespace fallback) is unchanged and now serves as the fallback.

- [ ] **Step 4: Enrich `Table.toHtml()` in `src/tablemodel.ts`**

Replace the `toHtml()` method body (from Task 1) with the section/header-aware version:

```ts
  toHtml(): string {
    const emitRow = (lines: string[], row: TableRow) => {
      lines.push('  <tr>');
      for (const c of row.cells) {
        const tag = c.isHeader ? 'th' : 'td';
        const attrs =
          (c.colSpan > 1 ? ` colspan="${c.colSpan}"` : '') +
          (c.rowSpan > 1 ? ` rowspan="${c.rowSpan}"` : '') +
          (c.scope ? ` scope="${escHtml(c.scope)}"` : '') +
          (c.id ? ` id="${escHtml(c.id)}"` : '') +
          (c.headers && c.headers.length ? ` headers="${escHtml(c.headers.join(' '))}"` : '');
        lines.push(`    <${tag}${attrs}>${escHtml(c.text).replace(/\n/g, '<br>')}</${tag}>`);
      }
      lines.push('  </tr>');
    };

    const lines = ['<table>'];
    if (this.summary) lines.push(`  <caption>${escHtml(this.summary)}</caption>`);
    const hasSections = this.rows.some((r) => r.section);
    if (hasSections) {
      const groups: ['thead' | 'tbody' | 'tfoot', 'head' | 'body' | 'foot'][] =
        [['thead', 'head'], ['tbody', 'body'], ['tfoot', 'foot']];
      for (const [tag, sec] of groups) {
        const rows = this.rows.filter((r) => r.section === sec);
        if (!rows.length) continue;
        lines.push(`  <${tag}>`);
        for (const row of rows) emitRow(lines, row);
        lines.push(`  </${tag}>`);
      }
      for (const row of this.rows.filter((r) => !r.section)) emitRow(lines, row);
    } else {
      for (const row of this.rows) emitRow(lines, row);
    }
    lines.push('</table>');
    return lines.join('\n');
  }
```

This is byte-identical to the old output for geometry tables (no `summary`, no `section`, no `isHeader`/`scope`/`id`/`headers` → `<td>` with only colspan/rowspan). `toMarkdown()` is unchanged.

- [ ] **Step 5: Export the tagged extractor from `src/index.ts`**

In `src/index.ts`, change line 29 from:

```ts
export { extractTables, Table } from './table.js';
```

to:

```ts
export { extractTables, Table } from './table.js';
export { extractTaggedTables } from './tablestruct.js';
```

(The `TableCell`/`TableRow`/`TableExtractOptions` type export on line 30 already covers the new optional fields since they live on the same interfaces.)

- [ ] **Step 6: Update the `Page.GetTables` doc comment in `src/page.ts`**

Replace the doc comment above `GetTables` (current lines 284–287) to mention the tagged path and the option:

```ts
  /** Reconstruct tables on the page. When the page is tagged and exposes
   *  `/Table` structure elements, the structure tree is used as the
   *  authoritative source for rows/cells/spans (with header/scope/section and
   *  summary semantics); otherwise tables are detected from ruling lines and
   *  text geometry. Returns a rows×cells model (spans, page-space quads, cell
   *  text), each serializable to HTML/Markdown. Pass `options.region` to
   *  restrict to a page-space rectangle, or `options.structure = 'off'` to force
   *  geometry-only detection. Returns [] when none found. */
```

- [ ] **Step 7: Run the dispatcher + serialization tests**

Run: `npx vitest run test/table-tagged.test.ts`
Expected: PASS (all tests, including the new dispatcher/toHtml ones).

- [ ] **Step 8: Run the full suite + typecheck + build**

Run: `npm run typecheck && npm test && npm run build`
Expected: no type errors; entire suite green (existing `test/table.test.ts` still passes — geometry output unchanged); build emits `dist/`.

- [ ] **Step 9: Update `README.md`**

In the table-extraction section of `README.md` (search for `GetTables`), add a sentence that tagged PDFs are extracted from the `/Table` structure tree automatically (with header/scope/section/summary metadata on the returned model), that `toHtml()` emits `<thead>/<tbody>/<th scope>/<caption>` for tagged tables, and that `{ structure: 'off' }` forces geometry-only detection. If there is a Limitations note about tables, update it to reflect that nested (84u) and cross-page (7ac) tagged tables are still out of scope.

- [ ] **Step 10: Commit**

```bash
git add src/table.ts src/tablemodel.ts src/index.ts src/page.ts README.md test/table-tagged.test.ts
git commit -m "feat(k33): auto-dispatch to tagged tables + section/header toHtml

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 6: Close-out

- [ ] **Step 1: Final verification**

Run: `npm run typecheck && npm test`
Expected: both green.

- [ ] **Step 2: Update the beads memory and close the issue**

```bash
bd remember --key tagged-table-extraction-shipped "Tagged /Table extraction shipped (k33). src/tablestruct.ts: extractTaggedTables(doc,page,opts)->Table[]; walks GetStructTree() for StandardType 'Table', flattens THead/TBody/TFoot into rows (section head/body/foot), HTML-style occupancy grid placement using TableAttributes rowSpan/colSpan. Cell quad: LayoutAttributes.bbox else StructElement.GetBBox() (new: glyph-union over descendant MCIDs). Cell fields isHeader(TH)/scope/id(/ID)/headers. Table.summary from TableAttributes.summary. Model moved table.ts->src/tablemodel.ts (Table+types+escHtml); table.ts re-exports. extractTables() dispatches tagged-first unless opts.structure==='off'. toHtml() emits thead/tbody/tfoot + th scope/id + headers + caption; geometry output byte-identical. Fixture test/helpers/build-tagged-table-pdf.ts; tests test/table-tagged.test.ts. Follow-ups still open: 84u nested, 7ac cross-page, 5ct rotated."
bd close k33
```

- [ ] **Step 3: Push (session-completion protocol)**

```bash
git pull --rebase
git push
git status   # MUST show "up to date with origin"
```

---

## Self-Review

**Spec coverage:**
- Module layout (tablemodel/tablestruct/table dispatcher/struct GetBBox) → Tasks 1, 2, 4, 5. ✓
- Auto integration + `structure:'off'` → Task 5 (dispatcher + tests). ✓
- Cell quads: `/BBox` then glyph union → Task 2 (GetBBox) + Task 4 (`cellQuad`) + Task 4 quad test. ✓
- Full richness: isHeader/scope/id/headers/sections/summary → Task 1 (fields) + Task 4 (population) + Task 4 tests. ✓
- Page assignment (whole table on primary page) → Task 4 (`primaryPage`). ✓
- Nesting flattened via GetText → Task 4 (cell text = `GetText()`; no nested-table emission). ✓
- Serialization (toHtml sections/th/caption; toMarkdown unchanged) → Task 5. ✓
- Testing (fixture + coverage) → Task 3 + Tasks 4/5 tests. ✓
- README update → Task 5 Step 9. ✓

**Placeholder scan:** No TBD/TODO; every code step shows complete code. The only deferred detail is confirming the geometry fixture's exact export name in Task 5 Step 1 (flagged inline, resolved by reading `test/helpers/build-table-pdf.ts`).

**Type consistency:** `extractTaggedTables(doc, page, options?)` signature matches across Tasks 4 and 5. `GetBBox(page?)` return type `[number,number,number,number] | undefined` matches `Rect | undefined` usage in `cellQuad`. `TableAttributes` fields (`rowSpan`/`colSpan`/`scope`/`headers`/`summary`) match `src/structattr.ts`. `LayoutAttributes.bbox` field name matches `src/structattr.ts`. `Table` constructor `(quad, rowCount, colCount, rows, summary?)` consistent in Tasks 1 and 4.

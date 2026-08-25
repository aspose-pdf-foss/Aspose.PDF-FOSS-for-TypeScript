# page.AddTable Rendering Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the public `page.AddTable` that lays out a built table and draws its cell text into a page's `/Contents`.

**Architecture:** A new `src/tablerender.ts` owns `drawTable(doc, page, table, x, top, opts)`, exposed as `Page.AddTable`. It resolves column widths and measures row heights via the 49l.1/49l.2 model, then draws each cell's text with the existing `stampTextBlock` engine at the measured geometry. The model gains one additive export — `resolveCellStyle` (with `color`) — so the renderer reuses the exact style cascade. Text-only MVP: no borders/fills/alignment (49l.3) and no pagination (49l.5).

**Tech Stack:** TypeScript (strict, ESM + NodeNext), vitest. Reuses `resolveColumnWidths`/`measure` (`tableauthor.ts`), `stampTextBlock` (`stamp.ts`), and coordinate text extraction (`Page.GetTextFragments`) for tests.

**Spec:** `docs/superpowers/specs/2026-07-23-table-addtable-rendering-design.md`
**Issue:** `aspose-pdf-foss-for-ts-49l.4`

## Global Constraints

- ESM + NodeNext, `strict` TypeScript. Every import specifier carries the `.js` extension.
- Zero runtime dependencies — `node:` built-ins only. Do not add npm runtime deps.
- TDD with vitest; tests live in `test/**/*.test.ts`; fixture builders in `test/helpers/`.
- Argument-validation failures throw `TypeError` (delegated to `resolveColumnWidths`/`measure`, which already validate).
- `npm run typecheck` and `npm test` must both be green before the issue is closed.
- Method naming: PascalCase on the `Page` facade (`AddTable`), matching `AddText`/`AddImage`.

---

### Task 1: `resolveCellStyle` — export the style cascade with color

**Files:**
- Modify: `src/tableauthor.ts` (extend `ResolvedStyle` with `color`; rename+export `resolveStyle` → `resolveCellStyle`; update the `measure` call site)
- Test: `test/table-author.test.ts` (new cascade `describe` block)

**Interfaces:**
- Consumes: `CellBuilder`, `TableDefaults`, `AuthoringFont` (same file).
- Produces:
  - `export interface ResolvedStyle { font: AuthoringFont; fontSize: number; leading: number; color: [number, number, number] }`
  - `export function resolveCellStyle(cell: CellBuilder, d: TableDefaults): ResolvedStyle`

- [ ] **Step 1: Write the failing test**

Append this `describe` block to `test/table-author.test.ts`. Note it imports from `../src/tableauthor.js` (the module, not the public index — `resolveCellStyle` is a render-support export, not public API):

```ts
import { resolveCellStyle } from '../src/tableauthor.js';

describe('table authoring — resolveCellStyle cascade', () => {
  it('cell overrides table defaults, which override built-ins (incl. color)', () => {
    const t = createTable({ font: 'Times-Roman', fontSize: 10, color: [0, 0, 1] });
    const r = t.addRow();
    const a = r.addCell('a');                                   // inherits table defaults
    const b = r.addCell('b', { color: [1, 0, 0], leading: 20 }); // cell overrides
    expect(resolveCellStyle(a, t.defaults)).toEqual({
      font: 'Times-Roman', fontSize: 10, leading: 1.2 * 10, color: [0, 0, 1],
    });
    expect(resolveCellStyle(b, t.defaults)).toEqual({
      font: 'Times-Roman', fontSize: 10, leading: 20, color: [1, 0, 0],
    });
  });

  it('falls back to built-ins when nothing is set', () => {
    const c = createTable().addRow().addCell('x');
    expect(resolveCellStyle(c, createTable().defaults)).toEqual({
      font: 'Helvetica', fontSize: 12, leading: 1.2 * 12, color: [0, 0, 0],
    });
  });
});
```

(`createTable` is already imported at the top of this test file from `../src/index.js`; add the `resolveCellStyle` import line shown above near the other imports.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/table-author.test.ts`
Expected: FAIL — `resolveCellStyle` is not exported by `../src/tableauthor.js`.

- [ ] **Step 3: Extend `ResolvedStyle` and export `resolveCellStyle`**

In `src/tableauthor.ts`, replace the `ResolvedStyle` interface (currently at lines 41–46):

```ts
/** A cell's fully-resolved text style (no undefined fields). */
export interface ResolvedStyle {
  font: AuthoringFont;
  fontSize: number;
  leading: number;
  color: [number, number, number];
}
```

Replace the `resolveStyle` function (currently at lines 58–67):

```ts
/** Resolve a cell's style against table defaults, then built-ins
 *  (Helvetica / 12pt / 1.2*fontSize leading / black). */
export function resolveCellStyle(cell: CellBuilder, d: TableDefaults): ResolvedStyle {
  const fontSize = cell.options.fontSize ?? d.fontSize ?? 12;
  return {
    font: cell.options.font ?? d.font ?? 'Helvetica',
    fontSize,
    leading: cell.options.leading ?? d.leading ?? 1.2 * fontSize,
    color: cell.options.color ?? d.color ?? [0, 0, 0],
  };
}
```

- [ ] **Step 4: Update the `measure` call site**

In `src/tableauthor.ts`, inside `measure` (currently line 223), change:

```ts
        const st = resolveStyle(cell, this.defaults);
```

to:

```ts
        const st = resolveCellStyle(cell, this.defaults);
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run test/table-author.test.ts`
Expected: PASS (all prior tests plus the 2 new cascade tests).

- [ ] **Step 6: Commit**

```bash
git add src/tableauthor.ts test/table-author.test.ts
git commit -m "feat(table): export resolveCellStyle with color for the renderer (49l.4)"
```

---

### Task 2: `drawTable` + `page.AddTable` + blank-page helper

**Files:**
- Create: `src/tablerender.ts`
- Create: `test/helpers/build-blank-page.ts`
- Modify: `src/page.ts` (import + `AddTable` method)
- Modify: `src/index.ts` (export `AddTableOptions`)
- Test: `test/table-render.test.ts`

**Interfaces:**
- Consumes: `resolveColumnWidths`/`measure`/`TableBuilder`/`resolveCellStyle` (`tableauthor.ts`), `stampTextBlock` (`stamp.ts`), `Document`/`Page` (facade), `Page.GetTextFragments` (`page.ts`).
- Produces:
  - `export interface AddTableOptions { width: number; cellPadding?: number }`
  - `export function drawTable(doc: Document, page: Page, table: TableBuilder, x: number, top: number, opts: AddTableOptions): void`
  - `Page.AddTable(table: TableBuilder, x: number, top: number, opts: AddTableOptions): void`
  - `export function buildBlankPage(): Uint8Array` (test helper)

- [ ] **Step 1: Write the blank-page fixture helper**

Create `test/helpers/build-blank-page.ts` (same classic-xref assembly as `build-stamp-target.ts`):

```ts
const enc = (s: string) => new TextEncoder().encode(s);
const byteLen = (s: string) => enc(s).length;

/** Assemble a classic-xref PDF from a 1-based array of object bodies. */
function assemble(objects: string[], maxObj: number, rootNum: number): Uint8Array {
  let body = '%PDF-1.7\n%\xE2\xE3\xCF\xD3\n';
  const offsets: number[] = new Array(maxObj + 1).fill(0);
  for (let n = 1; n <= maxObj; n++) {
    offsets[n] = byteLen(body);
    body += `${n} 0 obj\n${objects[n]}\nendobj\n`;
  }
  const xrefOffset = byteLen(body);
  let xref = `xref\n0 ${maxObj + 1}\n0000000000 65535 f \n`;
  for (let n = 1; n <= maxObj; n++) xref += `${String(offsets[n]).padStart(10, '0')} 00000 n \n`;
  const trailer = `trailer\n<< /Size ${maxObj + 1} /Root ${rootNum} 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return enc(body + xref + trailer);
}

function streamObj(content: string): string {
  return `<< /Length ${byteLen(content)} >>\nstream\n${content}\nendstream`;
}

/** A single blank letter-size page (612x792), empty /Contents, no fonts. */
export function buildBlankPage(): Uint8Array {
  const objects: string[] = [];
  objects[1] = `<< /Type /Catalog /Pages 2 0 R >>`;
  objects[2] = `<< /Type /Pages /Count 1 /Kids [3 0 R] /MediaBox [0 0 612 792] >>`;
  objects[3] = `<< /Type /Page /Parent 2 0 R /Resources << >> /Contents 4 0 R >>`;
  objects[4] = streamObj('');
  return assemble(objects, 4, 1);
}
```

- [ ] **Step 2: Write the failing render test**

Create `test/table-render.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { Document, createTable } from '../src/index.js';
import { buildBlankPage } from './helpers/build-blank-page.js';

describe('table rendering — page.AddTable', () => {
  it('places each cell in its column and row band', () => {
    const doc = Document.Open(buildBlankPage());
    const page = doc.Pages[0];
    const t = createTable({ font: 'Helvetica', fontSize: 10, leading: 12 });
    t.addRow(['Alpha', 'Beta']);
    t.addRow(['Gamma', 'Delta']);
    const x = 72, top = 720, width = 400, pad = 3;
    const widths = t.resolveColumnWidths(width);             // [200, 200]
    const { rowHeights } = t.measure(widths, { cellPadding: pad });
    page.AddTable(t, x, top, { width, cellPadding: pad });

    const frags = page.GetTextFragments();
    const columnX = [x, x + widths[0], x + widths[0] + widths[1]];
    const rowTop = [top, top - rowHeights[0]];
    const rowBottom = [top - rowHeights[0], top - rowHeights[0] - rowHeights[1]];
    const find = (s: string) => frags.find((f) => f.text.includes(s))!;

    const alpha = find('Alpha');                             // row 0, col 0
    expect(alpha.quad[0]).toBeGreaterThanOrEqual(columnX[0]);
    expect(alpha.quad[0]).toBeLessThan(columnX[1]);
    expect(alpha.quad[1]).toBeGreaterThanOrEqual(rowBottom[0] - 0.01);
    expect(alpha.quad[1]).toBeLessThanOrEqual(rowTop[0] + 0.01);

    const delta = find('Delta');                             // row 1, col 1
    expect(delta.quad[0]).toBeGreaterThanOrEqual(columnX[1]);
    expect(delta.quad[0]).toBeLessThan(columnX[2]);
    expect(delta.quad[1]).toBeGreaterThanOrEqual(rowBottom[1] - 0.01);
    expect(delta.quad[1]).toBeLessThanOrEqual(rowTop[1] + 0.01);
  });

  it('a colspan header spans the full width; body cells stay in their columns', () => {
    const doc = Document.Open(buildBlankPage());
    const page = doc.Pages[0];
    const t = createTable({ font: 'Helvetica', fontSize: 10, leading: 12 });
    t.addRow().addCell('Header', { colSpan: 2 });
    t.addRow(['L', 'R']);
    const x = 72, width = 300;
    const widths = t.resolveColumnWidths(width);             // [150, 150]
    page.AddTable(t, x, 720, { width, cellPadding: 0 });

    const frags = page.GetTextFragments();
    const header = frags.find((f) => f.text.includes('Header'))!;
    const rCell = frags.find((f) => f.text === 'R')!;
    expect(header.quad[0]).toBeGreaterThanOrEqual(x);
    expect(header.quad[0]).toBeLessThan(x + 5);              // starts at table's left edge
    expect(rCell.quad[0]).toBeGreaterThanOrEqual(x + widths[0]); // 'R' in column 1
  });

  it('a two-line first-row cell pushes the next row down by one leading', () => {
    const secondBaseline = (first: string) => {
      const t = createTable({ font: 'Helvetica', fontSize: 10, leading: 12 });
      t.addRow([first]);
      t.addRow(['second']);
      const page = Document.Open(buildBlankPage()).Pages[0];
      page.AddTable(t, 72, 720, { width: 200, cellPadding: 0 });
      return page.GetTextFragments().find((f) => f.text.includes('second'))!.quad[1];
    };
    expect(secondBaseline('a') - secondBaseline('a\nb')).toBeCloseTo(12, 4);
  });

  it('an empty table draws nothing and does not throw', () => {
    const page = Document.Open(buildBlankPage()).Pages[0];
    expect(() => page.AddTable(createTable(), 72, 720, { width: 400 })).not.toThrow();
    expect(page.GetTextFragments()).toEqual([]);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run test/table-render.test.ts`
Expected: FAIL — `page.AddTable is not a function`.

- [ ] **Step 4: Write `src/tablerender.ts`**

```ts
import type { Document } from './document.js';
import type { Page } from './page.js';
import { stampTextBlock } from './stamp.js';
import { TableBuilder, resolveCellStyle } from './tableauthor.js';

/** Options for {@link drawTable} / `page.AddTable`. */
export interface AddTableOptions {
  /** Total table width in points; feeds resolveColumnWidths. Required. */
  width: number;
  /** Inner padding per cell in points. Default 2 (matches measure()). */
  cellPadding?: number;
}

/** Lay out `table` with its top-left corner at (x, top) in PDF user space and
 *  draw each cell's text into the page's /Contents. Rows stack downward. Draws
 *  text only — borders/fills/alignment are a later issue. Existing content is
 *  preserved. Input validation is delegated to resolveColumnWidths/measure. */
export function drawTable(
  doc: Document, page: Page, table: TableBuilder,
  x: number, top: number, opts: AddTableOptions,
): void {
  const widths = table.resolveColumnWidths(opts.width);
  if (widths.length === 0) return;
  const padding = opts.cellPadding ?? 2;
  const { rowHeights } = table.measure(widths, { cellPadding: padding });

  // Column left edges by prefix sum: columnX[c] = x + Σ widths[0..c).
  const columnX: number[] = [x];
  for (let i = 0; i < widths.length; i++) columnX.push(columnX[i] + widths[i]);

  let rowTop = top;
  for (let r = 0; r < table.rows.length; r++) {
    const rowBottom = rowTop - rowHeights[r];
    let c = 0; // physical-column cursor (matches measure's walk)
    for (const cell of table.rows[r].cells) {
      const cellX = columnX[c];
      let cellW = 0;
      for (let k = 0; k < cell.colSpan; k++) cellW += widths[c + k];
      const st = resolveCellStyle(cell, table.defaults);
      stampTextBlock(doc, page, cell.text,
        [cellX + padding, rowBottom + padding, cellW - 2 * padding, rowHeights[r] - 2 * padding],
        { font: st.font, fontSize: st.fontSize, leading: st.leading, color: st.color,
          align: 'left', valign: 'top' });
      c += cell.colSpan;
    }
    rowTop = rowBottom;
  }
}
```

- [ ] **Step 5: Add `AddTable` to the `Page` facade**

In `src/page.ts`, add this import near the other feature-module imports (after line 13, `import { addBarcode, ... } from './barcodeplace.js';`):

```ts
import { drawTable, AddTableOptions } from './tablerender.js';
import { TableBuilder } from './tableauthor.js';
```

Add this method inside the `Page` class, immediately after `AddBarcode` (currently ends at line 453):

```ts
  /** Lay out a built table (see {@link createTable}) with its top-left corner at
   *  (x, top) in PDF user space and draw its cell text into this page's
   *  /Contents. `opts.width` is the total table width in points; `opts.cellPadding`
   *  defaults to 2. Draws text only — borders, fills, and alignment come in a
   *  later release. Existing content is preserved. */
  AddTable(table: TableBuilder, x: number, top: number, opts: AddTableOptions): void {
    drawTable(this.doc, this, table, x, top, opts);
  }
```

- [ ] **Step 6: Export `AddTableOptions` from `src/index.ts`**

In `src/index.ts`, add after the `tableauthor.js` type-export line (line 66):

```ts
export type { AddTableOptions } from './tablerender.js';
```

- [ ] **Step 7: Run test to verify it passes**

Run: `npx vitest run test/table-render.test.ts`
Expected: PASS (4 render tests).

- [ ] **Step 8: Commit**

```bash
git add src/tablerender.ts src/page.ts src/index.ts test/table-render.test.ts test/helpers/build-blank-page.ts
git commit -m "feat(table): page.AddTable — draw a laid-out table's cell text (49l.4)"
```

---

### Task 3: README, whole-suite + typecheck gate, close issue

**Files:**
- Modify: `README.md` (Features bullet, Tables section, API-overview row)
- (verification) `npm run typecheck`, `npm test`

- [ ] **Step 1: Add a Features bullet**

In `README.md`, immediately after the **Image insertion** bullet (line 18), add:

```md
- **Table authoring** — `createTable()` builds rows/cells with fixed/fractional column widths and colspan; `page.AddTable(table, x, top, { width })` lays it out and draws the cell text. Borders, fills, alignment, and pagination are in progress.
```

- [ ] **Step 2: Add a `### Tables` section**

In `README.md`, immediately before the `### Vector drawing` heading (line 300), insert:

```md
### Tables

Build a table from rows and cells, then draw it onto a page. Column widths are
fixed points or fractions of the available width, and cells can span columns.

```ts
import { Document, createTable } from '@asposefoss/pdf';

const doc = Document.Open(bytes);
const table = createTable({ font: 'Helvetica', fontSize: 10 });
table.setColumnWidths([{ fixed: 120 }, { fraction: 1 }, { fraction: 1 }]);
table.addRow(['Item', 'Qty', 'Price']);            // string[] shorthand
const row = table.addRow();
row.addCell('Widget', { font: 'Helvetica-Bold' });
row.addCell('3');
row.addCell('$4.00');

doc.Pages[0].AddTable(table, 72, 720, { width: 400 }); // top-left at (72, 720)
```

Cell text is drawn left/top-aligned. Borders, background fills, alignment, and
multi-page overflow are in progress.
```

- [ ] **Step 3: Add an API-overview table row**

In `README.md`, immediately after the `page.AddTextBlock` row (line 956), add:

```md
| `page.AddTable(table, x, top, opts)` | Lay out a `createTable` table with its top-left at `(x, top)` and draw its cell text (`opts.width` = total width; `cellPadding?`) |
```

- [ ] **Step 4: Typecheck the whole project**

Run: `npm run typecheck`
Expected: exits 0, no errors. (Catches `.d.ts` / import-extension issues from the new public export and the `page.ts` import.)

- [ ] **Step 5: Run the full test suite**

Run: `npm test`
Expected: the whole `test/**/*.test.ts` suite passes, including `test/table-render.test.ts` and `test/table-author.test.ts`, with no regressions from the `resolveStyle` → `resolveCellStyle` rename.

- [ ] **Step 6: Commit and close the issue (only if both gates are green)**

```bash
git add README.md
git commit -m "docs(table): README entry for page.AddTable (49l.4)"
bd close aspose-pdf-foss-for-ts-49l.4
bd export -o .beads/issues.jsonl
git add .beads/issues.jsonl
git commit -m "chore(bd): close 49l.4 (page.AddTable rendering)"
```

---

## Notes / known limitations (by design)

- **Text-only.** No borders, fills, or H/V alignment (49l.3); no pagination
  (49l.5). A table taller than the page overflows the bottom edge.
- **No shaping in cell text.** The model wraps with the plain driver, so a shaped
  embedded font could wrap differently than measured. MVP cells are Standard-14
  or unshaped embedded fonts.
- **`AddTable` returns `void`.** 49l.5 introduces a height/overflow-continuation
  return when pagination needs it.
- **Renderer re-wraps via `stampTextBlock`.** Passing the same inner width and
  font/size/leading as `measure` makes the wrap identical, so every line fits the
  measured row height — no clipping.

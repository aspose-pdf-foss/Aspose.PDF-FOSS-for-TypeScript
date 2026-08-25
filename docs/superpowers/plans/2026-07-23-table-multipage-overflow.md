# Table Multi-page Overflow / Auto-pagination Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `page.AddTable` continue a too-tall table onto following pages — returning the undrawn rows as a re-drawable remainder (manual mode) or auto-appending pages until the table is exhausted (`autoPaginate: true`).

**Architecture:** Refactor `drawTable`'s single-page paint into two reusable helpers (`placeRows` → placed cells, `paintPlaced` → the 3-pass paint + per-page outer border), then drive them from a row-walk loop that breaks pages on atomic-row boundaries. A continuation `TableBuilder` (new `continuationFrom`) carries the original column specs and count so re-drawing resolves identical widths.

**Tech Stack:** TypeScript (ESM/NodeNext, `strict`), vitest, `node:` built-ins only. Coordinate text extraction (`Page.GetTextFragments()`) and vector path extraction (`Page.GetPaths()`) for assertions.

## Global Constraints

- Zero runtime dependencies — only `node:` built-ins. Do not add npm runtime deps.
- ESM + NodeNext: every relative import specifier carries the `.js` extension.
- `strict` TypeScript. `npm run typecheck` and `npm test` must be green before closing.
- TDD: write the failing test first, watch it fail, then implement.
- Public error types only where thrown: `TypeError` for input validation (matches existing table code).
- Return-type widening `void → AddTableResult` on `drawTable`/`Page.AddTable` is intentional and backward compatible (existing callers ignore the value).

---

### Task 1: Continuation builder in `tableauthor.ts`

Add `TableBuilder.continuationFrom(startRow)` plus a `forcedColumnCount` override so a slice of rows resolves to the *same* column widths as the original table even when the leftover rows are narrower than the widest original row.

**Files:**
- Modify: `src/tableauthor.ts` (class `TableBuilder`, near `columnCount`/`resolveColumnWidths`, ~lines 222–251)
- Test: `test/table-author.test.ts`

**Interfaces:**
- Consumes: existing `TableBuilder` (`rows`, private `columnSpecs`, `defaults`, `resolveColumnWidths`).
- Produces: `TableBuilder.continuationFrom(startRow: number): TableBuilder` (public method, `@internal`) — a new builder sharing `defaults` and `columnSpecs`, carrying the original column count, holding the same `RowBuilder` references from index `startRow` onward.

- [ ] **Step 1: Write the failing test**

Add to `test/table-author.test.ts` (inside the existing top-level `describe`, or a new `describe('table continuation', …)`):

```ts
it('continuationFrom keeps the original column count and specs', () => {
  const t = createTable();
  t.addRow().addCell('A', { colSpan: 2 });        // row 0 establishes 2 columns
  t.addRow(['x']);                                 // row 1 has a single (narrower) cell
  t.setColumnWidths([{ fraction: 1 }, { fraction: 1 }]);
  expect(t.resolveColumnWidths(200)).toEqual([100, 100]);

  const cont = t.continuationFrom(1);              // rows [row 1] only
  expect(cont.rows.length).toBe(1);
  // Without the forced column count, cont would see 1 column and throw on the
  // 2-entry width spec; with it, widths match the original exactly.
  expect(cont.resolveColumnWidths(200)).toEqual([100, 100]);
});

it('continuationFrom shares table defaults', () => {
  const t = createTable({ fontSize: 9, background: [0, 0, 1] });
  t.addRow(['a']); t.addRow(['b']);
  const cont = t.continuationFrom(1);
  expect(cont.defaults.fontSize).toBe(9);
  expect(cont.defaults.background).toEqual([0, 0, 1]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/table-author.test.ts`
Expected: FAIL — `cont.continuationFrom is not a function` (property `continuationFrom` does not exist on `TableBuilder`).

- [ ] **Step 3: Implement `continuationFrom` + `forcedColumnCount`**

In `src/tableauthor.ts`, add the private field alongside `columnSpecs` (after line ~198):

```ts
  /** @internal Fixed column count for continuation tables; when set, overrides
   *  the rows-derived count so resolveColumnWidths matches the original table
   *  even if the leftover rows are narrower. */
  private forcedColumnCount?: number;
```

Replace the existing `private columnCount()` (lines ~222–227) with:

```ts
  /** @internal Physical column count: forced (continuation tables) or the
   *  widest row's total colSpan. */
  private columnCount(): number {
    if (this.forcedColumnCount !== undefined) return this.forcedColumnCount;
    return this.rows.reduce(
      (m, r) => Math.max(m, r.cells.reduce((s, c) => s + c.colSpan, 0)),
      0);
  }
```

Add the public `@internal` method (place it after `resolveColumnWidths`, before `measure`):

```ts
  /** @internal Build a continuation table of rows `[startRow, end)`: shares this
   *  table's `defaults` and normalized column specs, carries the original column
   *  count, and holds the same RowBuilder references (never mutated). Re-drawing
   *  it with the same `width` yields identical per-column widths. */
  continuationFrom(startRow: number): TableBuilder {
    const t = new TableBuilder(this.defaults);
    t.forcedColumnCount = this.columnCount();
    t.columnSpecs = this.columnSpecs;
    t.rows.push(...this.rows.slice(startRow));
    return t;
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/table-author.test.ts`
Expected: PASS (all tests in the file, including the two new ones).

- [ ] **Step 5: Commit**

```bash
git add src/tableauthor.ts test/table-author.test.ts
git commit -m "feat(table): TableBuilder.continuationFrom for paginated re-draw (49l.5)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: Refactor `drawTable` into `placeRows`/`paintPlaced`; add `AddTableResult` + options

Split the current single-pass paint into reusable helpers and widen the return type. Behavior stays single-page (no pagination yet); every existing `table-render.test.ts` case must still pass.

**Files:**
- Modify: `src/tablerender.ts` (whole file — extract helpers, change return type)
- Modify: `src/page.ts` (`AddTable` return type + doc comment, ~lines 457–464)
- Modify: `src/index.ts` (export `AddTableResult`, line ~67)
- Test: `test/table-render.test.ts` (add one result-shape case)

**Interfaces:**
- Consumes: `TableBuilder` (`resolveColumnWidths`, `measure`, `defaults`, `rows`), `resolveCellStyle`, `ResolvedStyle`, `BorderInfo` from `tableauthor.js`; `stampTextBlock` from `stamp.js`; `PageGraphics` from `graphics.js`; `Page.CropBox`/`MediaBox` from `page.js`.
- Produces:
  - `interface AddTableResult { pages: Page[]; endY: number; remainder?: TableBuilder }`
  - `AddTableOptions` gains `autoPaginate?: boolean`, `bottomMargin?: number`, `topMargin?: number` (declared now; `bottomMargin` used in Task 3, the other two in Task 4).
  - `drawTable(...): AddTableResult` (was `void`).
  - Internal `placeRows(table, rowStart, rowEnd, rowHeights, columnX, widths, top): Placed[]`
  - Internal `paintPlaced(doc, page, placed, padding, outerBorder, blockRect): void`

- [ ] **Step 1: Write the failing test**

Add to `test/table-render.test.ts` (in the first `describe`):

```ts
it('AddTable returns the anchor page and the last row bottom', () => {
  const doc = Document.Open(buildBlankPage());
  const page = doc.Pages[0];
  const t = createTable({ fontSize: 10, leading: 12 });
  t.addRow(['a', 'b']);
  t.addRow(['c', 'd']);
  const { rowHeights } = t.measure(t.resolveColumnWidths(200), { cellPadding: 2 });
  const totalH = rowHeights[0] + rowHeights[1];

  const res = page.AddTable(t, 72, 720, { width: 200 });
  expect(res.pages).toEqual([page]);
  expect(res.remainder).toBeUndefined();
  expect(res.endY).toBeCloseTo(720 - totalH, 4);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/table-render.test.ts`
Expected: FAIL — `res.pages` is undefined (`AddTable` currently returns `void`), so `expect(res.pages).toEqual(...)` throws / fails.

- [ ] **Step 3: Rewrite `src/tablerender.ts`**

Replace the entire file with:

```ts
import type { Document } from './document.js';
import type { Page } from './page.js';
import { stampTextBlock } from './stamp.js';
import { PageGraphics } from './graphics.js';
import {
  TableBuilder, resolveCellStyle, ResolvedStyle, BorderInfo,
} from './tableauthor.js';

/** Options for {@link drawTable} / `page.AddTable`. */
export interface AddTableOptions {
  /** Total table width in points; feeds resolveColumnWidths. Required. */
  width: number;
  /** Inner padding per cell in points. Overrides the table style's `padding`
   *  (default 2). */
  cellPadding?: number;
  /** Append pages (sized to the anchor page) and draw the whole table. Default
   *  false: draw what fits above the bottom line and return the rest as
   *  `remainder`. */
  autoPaginate?: boolean;
  /** Stop line, in points above each page's CropBox bottom edge: a row is drawn
   *  only while it fits above `CropBox.y0 + bottomMargin`. Non-negative.
   *  Default 0 (fill to the bottom edge). */
  bottomMargin?: number;
  /** Continuation start, in points below an appended page's CropBox top edge:
   *  each new page starts at `CropBox.y1 - topMargin`. Non-negative. Default =
   *  the anchor's top inset (`anchor.CropBox.y1 - top`). Only used in auto
   *  mode. */
  topMargin?: number;
}

/** The outcome of {@link drawTable} / `page.AddTable`. */
export interface AddTableResult {
  /** Pages drawn onto, in order. Always includes the anchor page; length > 1
   *  only in auto mode. */
  pages: Page[];
  /** The y of the bottom edge of the last drawn row on the last page (equals
   *  `top` when nothing was drawn). */
  endY: number;
  /** Rows that did not fit, as a re-drawable TableBuilder. Set only in manual
   *  mode when the table overflowed; undefined when everything was drawn. */
  remainder?: TableBuilder;
}

/** A placed cell: page-space rect (top-left origin uses `bottom`), text, style. */
interface Placed { x: number; bottom: number; w: number; h: number; text: string; style: ResolvedStyle }

/** A page block's outer rectangle for the table border. */
interface BlockRect { x: number; bottom: number; w: number; h: number }

/** Place the cells of rows `[rowStart, rowEnd)` with the first row's top at
 *  `top`, stacking downward. `columnX` are prefix-sum column left edges; the
 *  colspan cursor walk mirrors `measure`. */
function placeRows(
  table: TableBuilder, rowStart: number, rowEnd: number,
  rowHeights: number[], columnX: number[], widths: number[], top: number,
): Placed[] {
  const placed: Placed[] = [];
  let rowTop = top;
  for (let r = rowStart; r < rowEnd; r++) {
    const rowBottom = rowTop - rowHeights[r];
    let c = 0;
    for (const cell of table.rows[r].cells) {
      let cellW = 0;
      for (let k = 0; k < cell.colSpan; k++) cellW += widths[c + k];
      placed.push({
        x: columnX[c], bottom: rowBottom, w: cellW, h: rowHeights[r],
        text: cell.text, style: resolveCellStyle(cell, table.rows[r].style, table.defaults),
      });
      c += cell.colSpan;
    }
    rowTop = rowBottom;
  }
  return placed;
}

/** Paint placed cells into `page`: backgrounds, then aligned text, then cell
 *  borders and (if given) the outer border around `blockRect`. Paint order is
 *  fills -> text -> borders. Existing content is preserved. */
function paintPlaced(
  doc: Document, page: Page, placed: Placed[], padding: number,
  outerBorder: BorderInfo | undefined, blockRect: BlockRect | undefined,
): void {
  // Pass 1: backgrounds (bottom). apply() no-ops if nothing was drawn.
  const bg = new PageGraphics(doc, page);
  for (const p of placed)
    if (p.style.background) bg.setFillColor(p.style.background).drawRect(p.x, p.bottom, p.w, p.h).fill();
  bg.apply();

  // Pass 2: cell text (middle), aligned per resolved style.
  for (const p of placed)
    stampTextBlock(doc, page, p.text,
      [p.x + padding, p.bottom + padding, p.w - 2 * padding, p.h - 2 * padding],
      { font: p.style.font, fontSize: p.style.fontSize, leading: p.style.leading,
        color: p.style.color, align: p.style.align, valign: p.style.valign });

  // Pass 3: cell borders + the block's outer border (top). Each border fully
  // sets its state (width/color/dash) so nothing leaks; dash `[]` means solid.
  const bd = new PageGraphics(doc, page);
  for (const p of placed)
    if (p.style.border) {
      const b = p.style.border;
      bd.setLineWidth(b.width).setStrokeColor(b.color).setDash(b.dash ?? [])
        .drawRect(p.x, p.bottom, p.w, p.h).stroke();
    }
  if (outerBorder && blockRect) {
    const ob = outerBorder;
    bd.setLineWidth(ob.width).setStrokeColor(ob.color).setDash(ob.dash ?? [])
      .drawRect(blockRect.x, blockRect.bottom, blockRect.w, blockRect.h).stroke();
  }
  bd.apply();
}

/** Lay out `table` with its top-left corner at (x, top) in PDF user space and
 *  draw its backgrounds, cell text (aligned), and borders into the page's
 *  /Contents. This single-page version draws every row; pagination is layered on
 *  in later tasks. Returns the anchor page and the last row's bottom y. Input
 *  validation is delegated to resolveColumnWidths/measure. */
export function drawTable(
  doc: Document, page: Page, table: TableBuilder,
  x: number, top: number, opts: AddTableOptions,
): AddTableResult {
  const widths = table.resolveColumnWidths(opts.width);
  if (widths.length === 0) return { pages: [page], endY: top, remainder: undefined };
  const padding = opts.cellPadding ?? table.defaults.padding ?? 2;
  const { rowHeights } = table.measure(widths, { cellPadding: padding });

  // Column left edges by prefix sum: columnX[c] = x + Σ widths[0..c).
  const columnX: number[] = [x];
  for (let i = 0; i < widths.length; i++) columnX.push(columnX[i] + widths[i]);
  const tableWidth = columnX[widths.length] - x;

  const totalH = rowHeights.reduce((a, h) => a + h, 0);
  const placed = placeRows(table, 0, table.rows.length, rowHeights, columnX, widths, top);
  paintPlaced(doc, page, placed, padding, table.defaults.outerBorder,
    { x, bottom: top - totalH, w: tableWidth, h: totalH });
  return { pages: [page], endY: top - totalH, remainder: undefined };
}
```

- [ ] **Step 4: Update `src/page.ts` `AddTable`**

Replace the `AddTable` method and its doc comment (lines ~457–464) with:

```ts
  /** Lay out a built table (see {@link createTable}) with its top-left corner at
   *  (x, top) in PDF user space and draw its backgrounds, cell text (aligned),
   *  and borders into this page's /Contents. `opts.width` is the total table
   *  width in points; `opts.cellPadding` defaults to 2. By default a too-tall
   *  table is drawn only down to `opts.bottomMargin` above the page bottom and
   *  the undrawn rows are returned as `result.remainder` (re-draw with a fresh
   *  `AddTable`); pass `{ autoPaginate: true }` to append pages automatically.
   *  Existing content is preserved. */
  AddTable(table: TableBuilder, x: number, top: number, opts: AddTableOptions): AddTableResult {
    return drawTable(this.doc, this, table, x, top, opts);
  }
```

Update the import at line ~14 to bring in the result type:

```ts
import { drawTable, AddTableOptions, AddTableResult } from './tablerender.js';
```

- [ ] **Step 5: Export `AddTableResult` from `src/index.ts`**

Replace line ~67:

```ts
export type { AddTableOptions, AddTableResult } from './tablerender.js';
```

- [ ] **Step 6: Run tests + typecheck**

Run: `npx vitest run test/table-render.test.ts && npm run typecheck`
Expected: PASS — all existing render tests plus the new result-shape test; typecheck clean.

- [ ] **Step 7: Commit**

```bash
git add src/tablerender.ts src/page.ts src/index.ts test/table-render.test.ts
git commit -m "refactor(table): extract placeRows/paintPlaced; AddTable returns AddTableResult (49l.5)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: Manual pagination — draw what fits, return the remainder

Replace `drawTable`'s draw-all body with a row-walk that stops at the bottom line and returns a continuation `TableBuilder`. Atomic rows: a row that will not fit moves whole to the next page; a first-on-page row taller than the space is drawn anyway.

**Files:**
- Modify: `src/tablerender.ts` (`drawTable` body only — helpers from Task 2 unchanged)
- Test: `test/table-render.test.ts` (new `describe('table rendering — pagination')`)

**Interfaces:**
- Consumes: `placeRows`, `paintPlaced` (Task 2); `TableBuilder.continuationFrom` (Task 1); `Page.CropBox`.
- Produces: `drawTable` honoring `opts.bottomMargin` in manual mode; `AddTableResult.remainder` set on overflow.

- [ ] **Step 1: Write the failing tests**

Add this `describe` block to `test/table-render.test.ts`:

```ts
describe('table rendering — pagination (manual)', () => {
  const tallTable = (n: number) => {
    const t = createTable({ fontSize: 10, leading: 12 });
    for (let i = 0; i < n; i++) t.addRow([`row${i}`]);
    return t;
  };

  it('draws rows that fit above bottomMargin and returns the rest', () => {
    const page = Document.Open(buildBlankPage()).Pages[0];
    const t = tallTable(40);                            // 16pt rows
    const res = page.AddTable(t, 72, 100, { width: 200, cellPadding: 2 });
    expect(res.remainder).toBeDefined();
    expect(res.pages).toEqual([page]);
    for (const f of page.GetTextFragments()) expect(f.quad[1]).toBeGreaterThanOrEqual(0);
    expect(res.endY).toBeGreaterThanOrEqual(0);
  });

  it('remainder redrawn continues; the union of drawn rows covers all rows once', () => {
    const t = tallTable(40);
    const seen: string[] = [];
    let rem: TableBuilder | undefined = t;
    let guard = 0;
    while (rem && guard++ < 60) {
      const page = Document.Open(buildBlankPage()).Pages[0];   // fresh page each slice
      const res: AddTableResult = page.AddTable(rem, 72, 100, { width: 200, cellPadding: 2 });
      for (const f of page.GetTextFragments()) if (/^row\d+$/.test(f.text)) seen.push(f.text);
      rem = res.remainder;
    }
    expect(rem).toBeUndefined();                          // fully consumed
    const expected = Array.from({ length: 40 }, (_, i) => `row${i}`);
    expect(seen.slice().sort()).toEqual(expected.slice().sort());   // each row once
  });

  it('a row that would straddle the bottom line moves whole to the remainder', () => {
    // top 40, bottomMargin 0, 16pt rows: row0 [40..24], row1 [24..8], row2 [8..-8]
    // -> row2 does not fit; only 2 rows drawn, row2 is first of remainder.
    const page = Document.Open(buildBlankPage()).Pages[0];
    const t = tallTable(5);
    const res = page.AddTable(t, 72, 40, { width: 200, cellPadding: 2 });
    const drawn = page.GetTextFragments().map((f) => f.text).filter((s) => /^row\d+$/.test(s));
    expect(drawn.sort()).toEqual(['row0', 'row1']);
    // remainder starts at row2
    const rpage = Document.Open(buildBlankPage()).Pages[0];
    rpage.AddTable(res.remainder!, 72, 700, { width: 200, cellPadding: 2 });
    const first = rpage.GetTextFragments().find((f) => /^row\d+$/.test(f.text))!;
    expect(first.text).toBe('row2');
  });

  it('a single row taller than the page is drawn anyway (no infinite remainder)', () => {
    const page = Document.Open(buildBlankPage()).Pages[0];
    const t = createTable({ fontSize: 10, leading: 12 });
    t.addRow(['only']);
    // bottomMargin so large the row cannot fit, but it is first-on-page -> drawn.
    const res = page.AddTable(t, 72, 40, { width: 200, cellPadding: 2, bottomMargin: 100 });
    expect(page.GetTextFragments().some((f) => f.text.includes('only'))).toBe(true);
    expect(res.remainder).toBeUndefined();
  });

  it('an empty table returns the anchor page and no remainder', () => {
    const page = Document.Open(buildBlankPage()).Pages[0];
    const res = page.AddTable(createTable(), 72, 720, { width: 400 });
    expect(res).toEqual({ pages: [page], endY: 720, remainder: undefined });
    expect(page.GetTextFragments()).toEqual([]);
  });
});
```

Add `TableBuilder` and `AddTableResult` to the test file's imports:

```ts
import { Document, createTable, TableBuilder, AddTableResult } from '../src/index.js';
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/table-render.test.ts -t pagination`
Expected: FAIL — `res.remainder` is always `undefined` (drawTable still draws all rows), so the overflow/atomic tests fail.

- [ ] **Step 3: Implement the manual pagination loop**

In `src/tablerender.ts`, replace the tail of `drawTable` (from the `const totalH = …` line to the final `return`) with the row-walk:

```ts
  const bottomMargin = opts.bottomMargin ?? 0;
  const ob = table.defaults.outerBorder;

  // Paint rows [start, end) on `pg` with the first row's top at `sliceTop`.
  const paintSlice = (pg: Page, start: number, end: number, sliceTop: number): void => {
    if (end <= start) return;
    let h = 0;
    for (let r = start; r < end; r++) h += rowHeights[r];
    const placed = placeRows(table, start, end, rowHeights, columnX, widths, sliceTop);
    paintPlaced(doc, pg, placed, padding, ob, { x, bottom: sliceTop - h, w: tableWidth, h });
  };

  const cb = page.CropBox;                 // [x0, y0, x1, y1]
  const bottomLine = cb[1] + bottomMargin;
  const sliceTop = top;
  let usedHeight = 0;
  let rowsOnThisPage = 0;
  let i = 0;
  for (; i < table.rows.length; i++) {
    const h = rowHeights[i];
    const fits = sliceTop - usedHeight - h >= bottomLine;
    if (!fits && rowsOnThisPage > 0) {
      paintSlice(page, 0, i, sliceTop);
      return { pages: [page], endY: sliceTop - usedHeight, remainder: table.continuationFrom(i) };
    }
    usedHeight += h;
    rowsOnThisPage++;
  }
  paintSlice(page, 0, table.rows.length, sliceTop);
  return { pages: [page], endY: sliceTop - usedHeight, remainder: undefined };
```

(Delete the old `const totalH = … return { … };` block this replaces. Keep everything above it — `widths`, empty-table early return, `padding`, `measure`, `columnX`, `tableWidth`.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/table-render.test.ts && npm run typecheck`
Expected: PASS — all render tests (existing single-page ones still pass because a table that fits never breaks) and the new pagination cases; typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add src/tablerender.ts test/table-render.test.ts
git commit -m "feat(table): manual pagination — draw to bottomMargin, return remainder (49l.5)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 4: Auto-paginate — append pages sized to the anchor

Extend the page-break branch: with `autoPaginate: true`, append a page (MediaBox copied from the anchor), reset the cursor to `CropBox.y1 - topMargin`, and continue until the table is exhausted.

**Files:**
- Modify: `src/tablerender.ts` (`drawTable` — the loop from Task 3)
- Test: `test/table-render.test.ts` (new `describe('table rendering — pagination (auto)')`)

**Interfaces:**
- Consumes: `doc.AddPage()` (returns `{ page: Page; number: number }`), `Page.MediaBox` getter/setter, `Page.CropBox`.
- Produces: `drawTable` honoring `opts.autoPaginate` and `opts.topMargin`; `AddTableResult.pages` lists every page, `remainder` undefined.

- [ ] **Step 1: Write the failing tests**

Add to `test/table-render.test.ts`:

```ts
describe('table rendering — pagination (auto)', () => {
  const tallTable = (n: number) => {
    const t = createTable({ fontSize: 10, leading: 12 });
    for (let i = 0; i < n; i++) t.addRow([`row${i}`]);
    return t;
  };

  it('appends pages and draws the whole table, no remainder', () => {
    const doc = Document.Open(buildBlankPage());          // 1 page, 612 x 792
    const page = doc.Pages[0];
    const t = tallTable(120);                             // far taller than one page
    const res = page.AddTable(t, 72, 720, {
      width: 200, cellPadding: 2, autoPaginate: true, bottomMargin: 72, topMargin: 72,
    });
    expect(res.remainder).toBeUndefined();
    expect(res.pages.length).toBeGreaterThan(1);
    expect(res.pages[0]).toBe(page);
    expect(doc.Pages.length).toBe(res.pages.length);      // pages were appended
    // Every row text appears somewhere across the appended pages.
    const all = res.pages.flatMap((p) => p.GetTextFragments().map((f) => f.text));
    for (let i = 0; i < 120; i++) expect(all).toContain(`row${i}`);
  });

  it('appended pages copy the anchor MediaBox (Letter, not the AddPage A4 default)', () => {
    const doc = Document.Open(buildBlankPage());          // Letter 612 x 792
    const t = tallTable(120);
    const res = doc.Pages[0].AddTable(t, 72, 720, {
      width: 200, cellPadding: 2, autoPaginate: true, bottomMargin: 72,
    });
    expect(res.pages.length).toBeGreaterThan(1);
    expect(res.pages[1].MediaBox).toEqual([0, 0, 612, 792]);   // not 595 x 842
  });

  it('endY is the last drawn row bottom on the last page', () => {
    const doc = Document.Open(buildBlankPage());
    const t = tallTable(120);
    const res = doc.Pages[0].AddTable(t, 72, 720, {
      width: 200, cellPadding: 2, autoPaginate: true, bottomMargin: 72, topMargin: 72,
    });
    const last = res.pages[res.pages.length - 1];
    const lowest = Math.min(...last.GetTextFragments().map((f) => f.quad[1]));
    // endY (row bottom) is below the lowest baseline but within a row height of it.
    expect(res.endY).toBeLessThanOrEqual(lowest);
    expect(lowest - res.endY).toBeLessThan(16);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/table-render.test.ts -t "pagination (auto)"`
Expected: FAIL — with `autoPaginate` not yet handled, the loop returns a `remainder` and a single page, so `res.pages.length > 1` and `remainder` undefined assertions fail.

- [ ] **Step 3: Implement the auto branch**

In `src/tablerender.ts`, replace the manual loop tail (from `const cb = page.CropBox;` through the final `return`) with the multi-page version:

```ts
  const autoPaginate = opts.autoPaginate ?? false;
  const anchorCb = page.CropBox;                 // [x0, y0, x1, y1]
  const topMargin = opts.topMargin ?? (anchorCb[3] - top);
  const anchorMediaBox = page.MediaBox;

  const pages: Page[] = [page];
  let currentPage = page;
  let cb = anchorCb;
  let bottomLine = cb[1] + bottomMargin;
  let sliceTop = top;
  let sliceStartRow = 0;
  let usedHeight = 0;
  let rowsOnThisPage = 0;

  for (let i = 0; i < table.rows.length; i++) {
    const h = rowHeights[i];
    const fits = sliceTop - usedHeight - h >= bottomLine;
    if (!fits && rowsOnThisPage > 0) {
      paintSlice(currentPage, sliceStartRow, i, sliceTop);
      if (!autoPaginate)
        return { pages, endY: sliceTop - usedHeight, remainder: table.continuationFrom(i) };
      // Append a page sized to the anchor and continue from its top.
      currentPage = doc.AddPage().page;
      currentPage.MediaBox = [...anchorMediaBox];
      pages.push(currentPage);
      cb = currentPage.CropBox;
      bottomLine = cb[1] + bottomMargin;
      sliceTop = cb[3] - topMargin;
      sliceStartRow = i;
      usedHeight = 0;
      rowsOnThisPage = 0;
      i--;                                         // retry this row on the new page
      continue;
    }
    usedHeight += h;
    rowsOnThisPage++;
  }
  paintSlice(currentPage, sliceStartRow, table.rows.length, sliceTop);
  return { pages, endY: sliceTop - usedHeight, remainder: undefined };
```

Also update `paintSlice` to no longer assume slices start at row 0 — it already takes `start`/`end`, so it is unchanged; just confirm the earlier `paintSlice(page, 0, i, …)` call sites are gone (replaced by `sliceStartRow`).

> Implementation note: this replaces the Task 3 manual-only loop entirely. The
> manual path is preserved by the `if (!autoPaginate) return …` line, so all
> Task 3 pagination tests keep passing.

- [ ] **Step 4: Run the full suite + typecheck**

Run: `npx vitest run test/table-render.test.ts && npm run typecheck`
Expected: PASS — manual and auto pagination, plus every pre-existing render test.

- [ ] **Step 5: Commit**

```bash
git add src/tablerender.ts test/table-render.test.ts
git commit -m "feat(table): autoPaginate — append anchor-sized pages until table drawn (49l.5)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 5: Documentation + full-suite gate

Document pagination in the README table section and run the whole suite.

**Files:**
- Modify: `README.md` (table-authoring section)

**Interfaces:** none (docs only).

- [ ] **Step 1: Update the README table-authoring section**

Find the table-authoring subsection (search `AddTable` / `createTable` in `README.md`). Remove any "pagination is in progress / coming later" caveat and add a pagination note with both modes. Insert after the existing `AddTable` example:

```markdown
#### Multi-page tables

A table taller than the space on the page paginates. By default `AddTable` draws
the rows that fit above `bottomMargin` (points from the page bottom, default 0)
and returns the rest as a re-drawable `remainder`:

```ts
let remainder = createTable(/* … */);
let y = 720;
while (remainder) {
  const { remainder: rest } = page.AddTable(remainder, 72, y, { width: 468, bottomMargin: 72 });
  if (rest) { page = doc.AddPage().page; y = 720; }
  remainder = rest;
}
```

Or let `AddTable` append pages for you with `autoPaginate: true`. Appended pages
copy the anchor page's size; `topMargin` sets where each continuation starts:

```ts
const { pages, endY } = page.AddTable(table, 72, 720, {
  width: 468, autoPaginate: true, bottomMargin: 72, topMargin: 72,
});
// `pages` lists every page drawn onto; `endY` is the bottom of the last row.
```

Rows are atomic: a row that will not fit moves whole to the next page (a single
row taller than a full page is drawn anyway). Each page gets its own outer
border.
```

(Adjust the surrounding prose/fences to match the README's existing heading depth and code-fence style.)

- [ ] **Step 2: Run the full test suite + typecheck**

Run: `npm test && npm run typecheck`
Expected: PASS — entire vitest suite green, typecheck clean.

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs(table): README — multi-page overflow and autoPaginate (49l.5)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

- [ ] **Step 4: Close the issue**

```bash
bd close aspose-pdf-foss-for-ts-49l.5
```

---

## Self-Review

**Spec coverage:**
- Manual mode + remainder → Task 3. ✓
- Auto mode + append pages → Task 4. ✓
- `AddTableOptions` (`autoPaginate`/`bottomMargin`/`topMargin`) + `AddTableResult` → Task 2 (declared), Task 3/4 (behavior). ✓
- Atomic rows + oversized-row guarantee → Task 3 tests + loop condition (`!fits && rowsOnThisPage > 0`). ✓
- Overflow-margin geometry (`bottomLine`, `contTop`, topMargin default) → Task 4. ✓
- Appended pages match anchor MediaBox → Task 4 test + `currentPage.MediaBox = [...anchorMediaBox]`. ✓
- Per-page outer border → Task 2 `paintPlaced(blockRect)` + Task 3/4 per-slice blockRect. ✓
- Continuation column-width stability → Task 1 `continuationFrom`/`forcedColumnCount` + test. ✓
- `index.ts` exports `AddTableResult` → Task 2. ✓
- README → Task 5. ✓
- Empty-table result → Task 3 test + early return. ✓

**Placeholder scan:** No `TBD`/`TODO`/"handle edge cases"/sketch code remains — every test and implementation step shows complete, runnable code.

**Type consistency:** `AddTableResult { pages; endY; remainder? }`, `AddTableOptions` fields, `placeRows`/`paintPlaced`/`continuationFrom` signatures, and `BlockRect` are named identically across Tasks 1–4 and the spec. `drawTable`/`AddTable` return `AddTableResult` everywhere after Task 2.

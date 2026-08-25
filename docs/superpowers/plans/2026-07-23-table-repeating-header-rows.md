# Table Repeating Header Rows Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `TableBuilder.setRepeatingRowsCount(n)` so the first N rows of a built table reprint at the top of every continuation page (auto mode) and are embedded into the re-drawable `remainder` (manual mode).

**Architecture:** Store the count on `TableBuilder`; make `continuationFrom` prepend the header rows and carry the count forward; generalize `drawTable`'s per-page placement from a contiguous `[start, end)` range to an explicit ordered row-index list so a continuation page can paint `header ++ body` as one bordered block. Progress is guaranteed by the existing "first row on a page always draws" rule applied to the first body row.

**Tech Stack:** TypeScript (ESM + NodeNext, `strict`), vitest. Zero runtime deps (`node:` built-ins only).

## Global Constraints

- Zero runtime dependencies — only `node:` built-ins. Do not add npm runtime deps.
- ESM + NodeNext: every relative import specifier carries the `.js` extension (e.g. `import { X } from './tableauthor.js'`).
- `strict` TypeScript. Throw the public error types from `errors.ts` where applicable; plain `TypeError` is the established choice for table option validation (see `tableauthor.ts`).
- TDD: write the failing test first, watch it fail, implement minimally, watch it pass, commit.
- Run `npm run typecheck` and `npm test` before considering the feature done; both must be green.
- Follow existing table code style: JSDoc on public/`@internal` members, `checkNonNeg`-style validators, programmatic test fixtures.

---

### Task 1: `setRepeatingRowsCount` on `TableBuilder` (state + validation)

Add the setter, private field, and internal getter. No rendering behavior yet.

**Files:**
- Modify: `src/tableauthor.ts` (add field, getter, setter to `class TableBuilder`, ~after `setColumnWidths` at lines 221-225)
- Test: `test/table-author.test.ts` (append a `describe` block)

**Interfaces:**
- Consumes: nothing new.
- Produces:
  - `TableBuilder.setRepeatingRowsCount(n: number): this` — validates `n` is a non-negative integer (`TypeError` otherwise); stores it; chainable.
  - `TableBuilder.repeatingRowCount: number` (getter) — the raw stored count (default `0`), consumed by `continuationFrom` and the renderer.

- [ ] **Step 1: Write the failing tests**

Append to `test/table-author.test.ts`:

```ts
describe('TableBuilder.setRepeatingRowsCount', () => {
  it('defaults to 0 and stores a non-negative integer, chainable', () => {
    const t = createTable();
    expect(t.repeatingRowCount).toBe(0);
    expect(t.setRepeatingRowsCount(2)).toBe(t);   // chainable
    expect(t.repeatingRowCount).toBe(2);
    expect(t.setRepeatingRowsCount(0).repeatingRowCount).toBe(0);
  });

  it('rejects negatives, non-integers, and non-finite counts', () => {
    const t = createTable();
    expect(() => t.setRepeatingRowsCount(-1)).toThrow(TypeError);
    expect(() => t.setRepeatingRowsCount(1.5)).toThrow(TypeError);
    expect(() => t.setRepeatingRowsCount(Infinity)).toThrow(TypeError);
    expect(() => t.setRepeatingRowsCount(NaN)).toThrow(TypeError);
    // @ts-expect-error runtime guard for non-number
    expect(() => t.setRepeatingRowsCount('2')).toThrow(TypeError);
  });
});
```

Confirm `createTable` is already imported at the top of `test/table-author.test.ts`; if not, add it to the existing `import { ... } from '../src/index.js';` line.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/table-author.test.ts`
Expected: FAIL — `t.setRepeatingRowsCount is not a function` / `repeatingRowCount` is `undefined`.

- [ ] **Step 3: Implement the field, getter, and setter**

In `src/tableauthor.ts`, inside `class TableBuilder`, add the private field next to the other private fields (near `forcedColumnCount`, ~line 203):

```ts
  /** @internal Repeat the first N rows atop each continuation page; 0 = none. */
  private _repeatingRows = 0;
```

Add the getter and setter immediately after `setColumnWidths` (after line 225):

```ts
  /** The repeating-header row count set via {@link setRepeatingRowsCount}
   *  (default 0). @internal Read by the renderer and `continuationFrom`. */
  get repeatingRowCount(): number {
    return this._repeatingRows;
  }

  /** Repeat the first `n` rows at the top of every continuation page (`n = 0`
   *  disables). On page 1 they appear naturally as the leading rows. The count
   *  is clamped to the row count at draw time, so rows may be added afterward.
   *  Chainable. */
  setRepeatingRowsCount(n: number): this {
    if (typeof n !== 'number' || !Number.isInteger(n) || n < 0)
      throw new TypeError('repeatingRowsCount must be a non-negative integer');
    this._repeatingRows = n;
    return this;
  }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/table-author.test.ts`
Expected: PASS (all, including the pre-existing tests).

- [ ] **Step 5: Commit**

```bash
git add src/tableauthor.ts test/table-author.test.ts
git commit -m "feat(table): setRepeatingRowsCount state + validation (49l.6)"
```

---

### Task 2: `continuationFrom` embeds header rows (manual-mode remainder)

Make the leftover-rows table (used by manual pagination and re-draws) prepend the header rows and carry the count forward.

**Files:**
- Modify: `src/tableauthor.ts` — `continuationFrom` (lines 240-246)
- Test: `test/table-author.test.ts` (extend the `setRepeatingRowsCount` describe block)

**Interfaces:**
- Consumes: `TableBuilder.repeatingRowCount` (Task 1).
- Produces: `continuationFrom(startRow)` unchanged signature (`TableBuilder`), new behavior — when `repeatingRowCount > 0`, the returned table's `rows` are `rows[0, N)` ++ `rows[max(startRow, N)..end)` with `N = min(repeatingRowCount, rows.length)`, and its `repeatingRowCount === N`. When the count is 0, behavior is exactly as before (`rows[startRow..end)`).

- [ ] **Step 1: Write the failing tests**

Add to the `setRepeatingRowsCount` describe block in `test/table-author.test.ts`:

```ts
  it('continuationFrom prepends the header rows and carries the count', () => {
    const t = createTable();
    for (let i = 0; i < 6; i++) t.addRow([`r${i}`]);   // rows r0..r5
    t.setRepeatingRowsCount(1);                          // header = r0
    const cont = t.continuationFrom(3);                  // leftover from r3
    // header r0 prepended, then r3,r4,r5
    expect(cont.rows.map((r) => r.cells[0].text)).toEqual(['r0', 'r3', 'r4', 'r5']);
    expect(cont.repeatingRowCount).toBe(1);
    // A further split still prepends the header (composability).
    const cont2 = cont.continuationFrom(2);              // header r0 + leftover from index 2 (r4)
    expect(cont2.rows.map((r) => r.cells[0].text)).toEqual(['r0', 'r4', 'r5']);
  });

  it('continuationFrom with count 0 is unchanged (raw leftover, no header)', () => {
    const t = createTable();
    for (let i = 0; i < 4; i++) t.addRow([`r${i}`]);
    const cont = t.continuationFrom(2);
    expect(cont.rows.map((r) => r.cells[0].text)).toEqual(['r2', 'r3']);
    expect(cont.repeatingRowCount).toBe(0);
  });

  it('continuationFrom does not duplicate header rows when startRow is within the header', () => {
    const t = createTable();
    for (let i = 0; i < 5; i++) t.addRow([`r${i}`]);
    t.setRepeatingRowsCount(2);                          // header = r0,r1
    const cont = t.continuationFrom(1);                  // startRow inside header
    // body starts at max(1, 2) = 2 -> header r0,r1 then r2,r3,r4 (no repeated r1)
    expect(cont.rows.map((r) => r.cells[0].text)).toEqual(['r0', 'r1', 'r2', 'r3', 'r4']);
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/table-author.test.ts`
Expected: FAIL — `continuationFrom` returns `['r3','r4','r5']` (no header) and `cont.repeatingRowCount` is `0`.

- [ ] **Step 3: Implement the header-aware `continuationFrom`**

Replace `continuationFrom` (lines 240-246) in `src/tableauthor.ts` with:

```ts
  /** @internal Build a continuation table of the rows left after `startRow`:
   *  shares this table's `defaults` and normalized column specs, carries the
   *  original column count, and holds the same RowBuilder references (never
   *  mutated). With a repeating-header count `N > 0`, the leftover is prefixed
   *  with the header rows `[0, N)` and the body starts at `max(startRow, N)`, so
   *  re-drawing reprints the header and never duplicates a header row; the count
   *  is carried forward so further splits compose. Re-drawing with the same
   *  `width` yields identical per-column widths. */
  continuationFrom(startRow: number): TableBuilder {
    const t = new TableBuilder(this.defaults);
    t.forcedColumnCount = this.columnCount();
    t.columnSpecs = this.columnSpecs;
    const n = Math.min(this._repeatingRows, this.rows.length);
    if (n > 0) {
      t._repeatingRows = n;
      t.rows.push(...this.rows.slice(0, n), ...this.rows.slice(Math.max(startRow, n)));
    } else {
      t.rows.push(...this.rows.slice(startRow));
    }
    return t;
  }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/table-author.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/tableauthor.ts test/table-author.test.ts
git commit -m "feat(table): continuationFrom embeds repeating header rows (49l.6)"
```

---

### Task 3: Generalize `drawTable` placement to a row-index list

Refactor placement from a contiguous `[start, end)` slice to an explicit ordered list of row indices. Pure refactor — no behavior change yet, existing tests stay green.

**Files:**
- Modify: `src/tablerender.ts` — `placeRows` (lines 53-74) and `paintSlice` (lines 136-142) inside `drawTable`
- Test: existing `test/table-render.test.ts` is the regression guard (no new test)

**Interfaces:**
- Consumes: nothing new.
- Produces (internal to `tablerender.ts`):
  - `placeRows(table, rowIndices: number[], rowHeights: number[], columnX: number[], widths: number[], top: number): Placed[]` — places the rows named by `rowIndices` in order, each stacked below the previous, first row's top at `top`.
  - The per-page painter now takes an index list: `paintRows(pg: Page, rowIndices: number[], sliceTop: number): void`.

- [ ] **Step 1: Rewrite `placeRows` to take a row-index list**

Replace `placeRows` (lines 53-74) in `src/tablerender.ts` with:

```ts
/** Place the cells of the rows named by `rowIndices` (in the given order) with
 *  the first row's top at `top`, stacking downward. `columnX` are prefix-sum
 *  column left edges; the colspan cursor walk mirrors `measure`. */
function placeRows(
  table: TableBuilder, rowIndices: number[],
  rowHeights: number[], columnX: number[], widths: number[], top: number,
): Placed[] {
  const placed: Placed[] = [];
  let rowTop = top;
  for (const r of rowIndices) {
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
```

- [ ] **Step 2: Rewrite the per-page painter to take an index list**

In `drawTable`, replace the `paintSlice` helper (lines 136-142) with:

```ts
  // Paint the rows named by `rowIndices` on `pg` with the first row's top at
  // `sliceTop`, wrapped in one outer-border block.
  const paintRows = (pg: Page, rowIndices: number[], sliceTop: number): void => {
    if (rowIndices.length === 0) return;
    let h = 0;
    for (const r of rowIndices) h += rowHeights[r];
    const placed = placeRows(table, rowIndices, rowHeights, columnX, widths, sliceTop);
    paintPlaced(doc, pg, placed, padding, ob, { x, bottom: sliceTop - h, w: tableWidth, h });
  };
```

- [ ] **Step 3: Update the two call sites to pass index ranges**

In `drawTable`, the spill paint (line 162) becomes:

```ts
      paintRows(currentPage, rangeIndices(sliceStartRow, i), sliceTop);
```

and the final paint (line 181) becomes:

```ts
  paintRows(currentPage, rangeIndices(sliceStartRow, table.rows.length), sliceTop);
```

Add this small helper at module scope in `src/tablerender.ts` (just below the `BlockRect` interface, ~line 48):

```ts
/** The contiguous index list `[start, start+1, ..., end-1)`. */
function rangeIndices(start: number, end: number): number[] {
  const out: number[] = [];
  for (let i = start; i < end; i++) out.push(i);
  return out;
}
```

- [ ] **Step 4: Run the full table suite to verify no regression**

Run: `npx vitest run test/table-render.test.ts test/table-author.test.ts`
Expected: PASS (all existing rendering + author tests still green).

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/tablerender.ts
git commit -m "refactor(table): per-page placement takes a row-index list (49l.6)"
```

---

### Task 4: Auto-mode reprints the header on each continuation page

Wire the header into the auto-pagination loop: seed each appended page's used height with the header cost and prepend the header indices when painting.

**Files:**
- Modify: `src/tablerender.ts` — `drawTable` pagination loop (lines 144-182 in the original; post-Task-3 the loop body)
- Test: `test/table-render.test.ts` (extend the `pagination (auto)` describe block, and add a manual-mode assertion)

**Interfaces:**
- Consumes: `TableBuilder.repeatingRowCount` (Task 1), `paintRows`/`rangeIndices` (Task 3), `continuationFrom` (Task 2).
- Produces: no signature change to `drawTable`; new behavior — continuation pages show the header rows on top.

- [ ] **Step 1: Write the failing tests**

Add to the `describe('table rendering — pagination (auto)', ...)` block in `test/table-render.test.ts` (the `tallTable` helper and `buildBlankPage` are already in scope):

```ts
  it('reprints a 1-row header at the top of every continuation page', () => {
    const doc = Document.Open(buildBlankPage());
    const t = createTable({ fontSize: 10, leading: 12 });
    t.addRow(['HEADER']);                          // row 0 = header
    for (let i = 0; i < 120; i++) t.addRow([`row${i}`]);
    t.setRepeatingRowsCount(1);
    const res = doc.Pages[0].AddTable(t, 72, 720, {
      width: 200, cellPadding: 2, autoPaginate: true, bottomMargin: 72, topMargin: 72,
    });
    expect(res.pages.length).toBeGreaterThan(1);
    // HEADER appears exactly once per page.
    for (const p of res.pages) {
      const headers = p.GetTextFragments().filter((f) => f.text.includes('HEADER'));
      expect(headers.length).toBe(1);
    }
    // Every body row still appears somewhere.
    const all = res.pages.flatMap((p) => p.GetTextFragments().map((f) => f.text));
    for (let i = 0; i < 120; i++) expect(all).toContain(`row${i}`);
  });

  it('reprints a 2-row header (incl. a colspan header) on each continuation page', () => {
    const doc = Document.Open(buildBlankPage());
    const t = createTable({ fontSize: 10, leading: 12 }).setColumnWidths([{ fraction: 1 }, { fraction: 1 }]);
    t.addRow().addCell('TITLE', { colSpan: 2 });   // row 0
    t.addRow(['A', 'B']);                          // row 1
    for (let i = 0; i < 120; i++) t.addRow([`c${i}`, `d${i}`]);
    t.setRepeatingRowsCount(2);
    const res = doc.Pages[0].AddTable(t, 72, 720, {
      width: 200, cellPadding: 2, autoPaginate: true, bottomMargin: 72, topMargin: 72,
    });
    expect(res.pages.length).toBeGreaterThan(1);
    for (const p of res.pages) {
      const texts = p.GetTextFragments().map((f) => f.text);
      expect(texts.filter((x) => x.includes('TITLE')).length).toBe(1);
      expect(texts.filter((x) => x === 'A').length).toBe(1);
    }
  });

  it('header on the header-carrying manual remainder reprints when redrawn', () => {
    const doc = Document.Open(buildBlankPage());
    const t = createTable({ fontSize: 10, leading: 12 });
    t.addRow(['HEADER']);
    for (let i = 0; i < 120; i++) t.addRow([`row${i}`]);
    t.setRepeatingRowsCount(1);
    const res = doc.Pages[0].AddTable(t, 72, 720, { width: 200, cellPadding: 2, bottomMargin: 72 });
    expect(res.remainder).toBeDefined();
    // The remainder's first row is the header, so a redraw reprints it.
    expect(res.remainder!.rows[0].cells[0].text).toBe('HEADER');
    const rpage = Document.Open(buildBlankPage()).Pages[0];
    rpage.AddTable(res.remainder!, 72, 720, { width: 200, cellPadding: 2, bottomMargin: 72 });
    expect(rpage.GetTextFragments().some((f) => f.text.includes('HEADER'))).toBe(true);
  });

  it('a repeating count of 0 leaves auto pagination unchanged', () => {
    const doc = Document.Open(buildBlankPage());
    const t = tallTable(120);
    t.setRepeatingRowsCount(0);
    const res = doc.Pages[0].AddTable(t, 72, 720, {
      width: 200, cellPadding: 2, autoPaginate: true, bottomMargin: 72, topMargin: 72,
    });
    // row0 appears exactly once total (not reprinted per page).
    const all = res.pages.flatMap((p) => p.GetTextFragments().map((f) => f.text));
    expect(all.filter((x) => x === 'row0').length).toBe(1);
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/table-render.test.ts`
Expected: FAIL — the header appears only on page 1 (its `filter(...).length` is `0` on continuation pages); the manual remainder's first row is `row0`, not `HEADER` (until Task 2 is present — it is, so that assertion passes, but the auto-mode assertions fail).

- [ ] **Step 3: Wire the header into the pagination loop**

In `src/tablerender.ts`, inside `drawTable`, just before the `const pages: Page[] = [page];` line (original line 149), compute the header:

```ts
  const headerCount = Math.min(table.repeatingRowCount, table.rows.length);
  const headerIndices = rangeIndices(0, headerCount);
  let headerHeight = 0;
  for (let r = 0; r < headerCount; r++) headerHeight += rowHeights[r];
```

Track whether the current page is a continuation. Add alongside the existing loop state (after `let rowsOnThisPage = 0;`, original line 156):

```ts
  let onContinuation = false;
```

Replace the spill branch and the final paint so continuation pages prepend the header. The spill paint (post-Task-3 line `paintRows(currentPage, rangeIndices(sliceStartRow, i), sliceTop);`) and the block that appends a page become:

```ts
    if (!fits && rowsOnThisPage > 0) {
      const body = rangeIndices(sliceStartRow, i);
      paintRows(currentPage, onContinuation ? [...headerIndices, ...body] : body, sliceTop);
      if (!autoPaginate)
        return { pages, endY: sliceTop - usedHeight, remainder: table.continuationFrom(i) };
      // Append a page sized to the anchor and continue from its top.
      currentPage = doc.AddPage().page;
      currentPage.MediaBox = [...anchorMediaBox];
      pages.push(currentPage);
      cb = currentPage.CropBox;
      bottomLine = cb[1] + bottomMargin;
      sliceTop = cb[3] - topMargin;
      sliceStartRow = Math.max(i, headerCount);   // body never re-lists a header row
      onContinuation = true;
      usedHeight = headerHeight;                   // header consumes space up top
      rowsOnThisPage = 0;
      i = sliceStartRow - 1;                        // retry the first body row on the new page
      continue;
    }
```

And the final paint (post-Task-3 line `paintRows(currentPage, rangeIndices(sliceStartRow, table.rows.length), sliceTop);`) becomes:

```ts
  {
    const body = rangeIndices(sliceStartRow, table.rows.length);
    paintRows(currentPage, onContinuation ? [...headerIndices, ...body] : body, sliceTop);
  }
```

Note: `usedHeight` still counts only what stacks below `sliceTop` on the current page, and on a continuation page it starts at `headerHeight`, so `endY = sliceTop - usedHeight` remains the true bottom of the last drawn row. The `i = sliceStartRow - 1` retry (instead of the old `i--`) skips any header rows that page 1 could not fit — they are drawn via the header prefix, not the body.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/table-render.test.ts`
Expected: PASS (new header tests + all existing pagination tests).

- [ ] **Step 5: Run the whole suite + typecheck**

Run: `npm run typecheck && npm test`
Expected: typecheck clean; full vitest suite green.

- [ ] **Step 6: Commit**

```bash
git add src/tablerender.ts test/table-render.test.ts
git commit -m "feat(table): reprint repeating header rows on continuation pages (49l.6)"
```

---

### Task 5: README documentation

Document `setRepeatingRowsCount` in the user-facing table section.

**Files:**
- Modify: `README.md` (table authoring section)

**Interfaces:**
- Consumes: the shipped `setRepeatingRowsCount` API.
- Produces: documentation only.

- [ ] **Step 1: Locate the table section**

Run: `grep -n "setColumnWidths\|autoPaginate\|createTable\|AddTable" README.md`
Expected: finds the table authoring subsection (the one covering `createTable` / `AddTable` / pagination).

- [ ] **Step 2: Add the repeating-header description**

In the table authoring subsection, next to the pagination (`autoPaginate` / `remainder`) prose, add a sentence and a short example consistent with the surrounding style, e.g.:

```markdown
Call `table.setRepeatingRowsCount(n)` to reprint the first *n* rows at the top of
every continuation page (a header that repeats). It works in both pagination
modes: with `autoPaginate: true` the header is redrawn on each appended page, and
in manual mode the returned `remainder` already carries the header rows, so
re-drawing it reprints them.

```ts
const t = createTable({ fontSize: 10 });
t.addRow(['Name', 'Amount']);        // header row
for (const r of data) t.addRow([r.name, r.amount]);
t.setRepeatingRowsCount(1);          // repeat the header on every page
page.AddTable(t, 72, 720, { width: 400, autoPaginate: true, bottomMargin: 72 });
```
```

Match the exact heading level, code-fence language tag, and prose voice already used in that section; adjust the wording to fit.

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs(table): README — setRepeatingRowsCount repeating header rows (49l.6)"
```

---

### Task 6: Final verification and issue close

**Files:** none (verification + tracker).

- [ ] **Step 1: Full green gate**

Run: `npm run typecheck && npm test`
Expected: typecheck clean; entire vitest suite passes.

- [ ] **Step 2: Prove the new assertions are load-bearing (spot check)**

Temporarily revert the header prepend in the final/spill paint (drop the `onContinuation ? [...headerIndices, ...body] : body` back to plain `body`) and run:
`npx vitest run test/table-render.test.ts`
Expected: the new header-per-page tests FAIL. Restore the code and confirm green again. (Do not commit the revert.)

- [ ] **Step 3: Close the issue**

```bash
bd close aspose-pdf-foss-for-ts-49l.6
```

---

## Self-Review Notes

- **Spec coverage:** API (Task 1), embed-in-remainder manual mode (Task 2), auto-mode reprint + one-block-per-page via index-list refactor (Tasks 3–4), edge cases N=0 / N≥rowCount / colSpan header / column-width parity (Tasks 2 & 4 tests), validation (Task 1), progress guarantee (Task 4 relies on the existing first-row-always-draws rule; the N=1/N=2 tests over 120 rows exercise many continuation pages without hanging), docs (Task 5). All spec sections map to a task.
- **N ≥ rowCount:** handled by `Math.min` clamps in both `continuationFrom` (Task 2) and `headerCount` (Task 4); body range becomes empty and no continuation occurs.
- **Type consistency:** `repeatingRowCount` (getter), `setRepeatingRowsCount` (setter), `placeRows(rowIndices)`, `paintRows`, `rangeIndices` are named identically across tasks.

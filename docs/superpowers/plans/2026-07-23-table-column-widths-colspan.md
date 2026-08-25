# Column Widths + Colspan Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend the table authoring model with fixed/proportional column-width specs, a pure width resolver, and horizontal cell colspan.

**Architecture:** All changes are additive to the existing `src/tableauthor.ts` (from 49l.1). New `ColumnWidth` / `CellOptions` types, a `setColumnWidths` builder setter, a standalone `resolveColumnWidths(totalWidth)` resolver, a `colSpan` on `CellBuilder`, and a colspan-aware physical-column walk inside the existing `measure()`. The 49l.1 `measure(columnWidths: number[], opts)` signature is unchanged.

**Tech Stack:** TypeScript (strict, ESM + NodeNext), vitest. Reuses the 49l.1 model and `layoutText` from `src/layout.js`; tests reuse `measureText` from `src/stamp.js`.

**Spec:** `docs/superpowers/specs/2026-07-23-table-column-widths-colspan-design.md`
**Issue:** `aspose-pdf-foss-for-ts-49l.2`

## Global Constraints

- ESM + NodeNext, `strict` TypeScript. Every import specifier carries the `.js` extension.
- Zero runtime dependencies — `node:` built-ins only. Do not add npm runtime deps.
- TDD with vitest; tests live in `test/**/*.test.ts`.
- Argument-validation failures throw `TypeError` (matches `graphics.ts` / `stamp.ts` / 49l.1).
- `npm run typecheck` and `npm test` must both be green before the issue is closed.
- Method naming: camelCase on the builder classes.
- Do NOT add a README entry — deferred to 49l.4 when a render path exists.

---

### Task 1: Column-width specs, `setColumnWidths`, and `colSpan`

**Files:**
- Modify: `src/tableauthor.ts` (add `ColumnWidth`/`CellOptions` types, validation, `setColumnWidths`, `colSpan` on `CellBuilder`/`addCell`)
- Modify: `src/index.ts` (export the two new types)
- Test: `test/table-author.test.ts` (new builder `describe` block)

**Interfaces:**
- Consumes (from 49l.1, same file): `CellTextOptions`, `validateStyleOpts`, `CellBuilder`, `RowBuilder`, `TableBuilder`, `createTable`.
- Produces:
  - `type ColumnWidth = { fixed: number } | { fraction: number }`
  - `interface CellOptions extends CellTextOptions { colSpan?: number }`
  - `CellBuilder.colSpan: number` (readonly, default 1)
  - `RowBuilder.addCell(text?: string, opts?: CellOptions): CellBuilder`
  - `TableBuilder.setColumnWidths(widths: ColumnWidth[]): this`
  - `TableBuilder`'s private `columnSpecs?: ColumnWidth[]` (normalized store; read by Task 2)

- [ ] **Step 1: Write the failing test**

Append this `describe` block to `test/table-author.test.ts`:

```ts
describe('table authoring — column widths & colspan (builders)', () => {
  it('setColumnWidths stores mixed fixed/fraction specs and is chainable', () => {
    const t = createTable();
    const ret = t.setColumnWidths([{ fixed: 120 }, { fraction: 2 }, { fraction: 1 }]);
    expect(ret).toBe(t);
  });

  it('rejects malformed column-width specs', () => {
    const t = createTable();
    expect(() => t.setColumnWidths([{ fixed: 0 }])).toThrow(TypeError);
    expect(() => t.setColumnWidths([{ fraction: -1 }])).toThrow(TypeError);
    expect(() => t.setColumnWidths([{ fixed: 1, fraction: 2 } as any])).toThrow(TypeError);
    expect(() => t.setColumnWidths([{} as any])).toThrow(TypeError);
  });

  it('addCell records colSpan and defaults it to 1', () => {
    const t = createTable();
    const r = t.addRow();
    const spanned = r.addCell('Summary', { colSpan: 3 });
    const plain = r.addCell('x');
    expect(spanned.colSpan).toBe(3);
    expect(plain.colSpan).toBe(1);
  });

  it('rejects a non-integer or < 1 colSpan', () => {
    const r = createTable().addRow();
    expect(() => r.addCell('x', { colSpan: 0 })).toThrow(TypeError);
    expect(() => r.addCell('x', { colSpan: 1.5 })).toThrow(TypeError);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/table-author.test.ts`
Expected: FAIL — `t.setColumnWidths is not a function` (and `colSpan` undefined on the returned cell).

- [ ] **Step 3: Add the types after the `CellTextOptions` interface**

In `src/tableauthor.ts`, immediately after the `CellTextOptions` interface (currently ends near line 19), add:

```ts
/** A column-width spec: an absolute width in points (`fixed`), or a share of the
 *  leftover space after fixed columns are allotted (`fraction`). */
export type ColumnWidth = { fixed: number } | { fraction: number };

/** `addCell` options: the per-cell text style plus an optional horizontal span. */
export interface CellOptions extends CellTextOptions {
  /** Number of columns this cell spans. Integer >= 1. Default 1. */
  colSpan?: number;
}
```

- [ ] **Step 4: Add the validators near the other `check*` helpers**

In `src/tableauthor.ts`, after `validateStyleOpts` (currently ends near line 76), add:

```ts
/** Validate one column-width spec and return a normalized single-key copy, so
 *  later discrimination via `'fixed' in w` is reliable. */
function normColumnWidth(w: ColumnWidth): ColumnWidth {
  const fx = (w as { fixed?: unknown }).fixed;
  const fr = (w as { fraction?: unknown }).fraction;
  const hasFixed = fx !== undefined;
  const hasFraction = fr !== undefined;
  if (hasFixed === hasFraction)
    throw new TypeError('each column width must have exactly one of { fixed } or { fraction }');
  const v = hasFixed ? fx : fr;
  if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0)
    throw new TypeError(`column width ${hasFixed ? 'fixed' : 'fraction'} must be a positive finite number`);
  return hasFixed ? { fixed: v } : { fraction: v };
}

function validateColSpan(n: number): void {
  if (typeof n !== 'number' || !Number.isInteger(n) || n < 1)
    throw new TypeError('colSpan must be an integer >= 1');
}
```

- [ ] **Step 5: Add `colSpan` to `CellBuilder` and split it out in `addCell`**

In `src/tableauthor.ts`, change the `CellBuilder` constructor:

```ts
/** One cell in a table row: a text string, optional per-cell style, and how many
 *  columns it spans. */
export class CellBuilder {
  constructor(
    public text: string,
    readonly options: CellTextOptions,
    readonly colSpan: number = 1,
  ) {}
}
```

Change `RowBuilder.addCell` to accept `CellOptions` and peel off `colSpan`:

```ts
  /** Append a cell with `text` (default '') and optional per-cell style/span. */
  addCell(text = '', opts: CellOptions = {}): CellBuilder {
    const { colSpan = 1, ...style } = opts;
    validateColSpan(colSpan);
    validateStyleOpts(style);
    const c = new CellBuilder(text, style, colSpan);
    this.cells.push(c);
    return c;
  }
```

- [ ] **Step 6: Add the `columnSpecs` store and `setColumnWidths` to `TableBuilder`**

In `src/tableauthor.ts`, add the field right after `readonly rows: RowBuilder[] = [];`:

```ts
  /** @internal Normalized column specs from {@link setColumnWidths};
   *  undefined => equal columns at resolve time. */
  private columnSpecs?: ColumnWidth[];
```

Add this method inside `TableBuilder`, after `addRow`:

```ts
  /** Set per-column widths as `fixed` points or `fraction`s of the leftover
   *  space. Chainable. The count is validated against the table's columns at
   *  resolve time (rows may be added afterward), not here. */
  setColumnWidths(widths: ColumnWidth[]): this {
    if (!Array.isArray(widths)) throw new TypeError('columnWidths must be an array');
    this.columnSpecs = widths.map(normColumnWidth);
    return this;
  }
```

- [ ] **Step 7: Export the new types from `src/index.ts`**

Change line 66 of `src/index.ts` from:

```ts
export type { TableDefaults, CellTextOptions, TableMetrics } from './tableauthor.js';
```

to:

```ts
export type { TableDefaults, CellTextOptions, TableMetrics, ColumnWidth, CellOptions } from './tableauthor.js';
```

- [ ] **Step 8: Run test to verify it passes**

Run: `npx vitest run test/table-author.test.ts`
Expected: PASS (all prior 10 tests plus the 4 new builder tests).

- [ ] **Step 9: Commit**

```bash
git add src/tableauthor.ts src/index.ts test/table-author.test.ts
git commit -m "feat(table): column-width specs + setColumnWidths + cell colSpan (49l.2)"
```

---

### Task 2: `resolveColumnWidths`

**Files:**
- Modify: `src/tableauthor.ts` (add private `columnCount()` + public `resolveColumnWidths`)
- Test: `test/table-author.test.ts` (new resolution `describe` block)

**Interfaces:**
- Consumes (Task 1): `columnSpecs`, `ColumnWidth`, `CellBuilder.colSpan`.
- Produces: `TableBuilder.resolveColumnWidths(totalWidth: number): number[]`.

- [ ] **Step 1: Write the failing test**

Append this `describe` block to `test/table-author.test.ts`:

```ts
describe('table authoring — column-width resolution', () => {
  it('splits total equally when all columns are fractions', () => {
    const t = createTable();
    t.addRow(['a', 'b', 'c', 'd']);
    t.setColumnWidths([{ fraction: 1 }, { fraction: 1 }, { fraction: 1 }, { fraction: 1 }]);
    expect(t.resolveColumnWidths(400)).toEqual([100, 100, 100, 100]);
  });

  it('gives fixed columns their width and splits the remainder by fraction', () => {
    const t = createTable();
    t.addRow(['a', 'b', 'c']);
    t.setColumnWidths([{ fixed: 120 }, { fraction: 2 }, { fraction: 1 }]);
    const w = t.resolveColumnWidths(300);
    expect(w[0]).toBeCloseTo(120, 6);
    expect(w[1]).toBeCloseTo(120, 6); // (300-120)*2/3
    expect(w[2]).toBeCloseTo(60, 6);  // (300-120)*1/3
  });

  it('defaults to equal columns when setColumnWidths is never called', () => {
    const t = createTable();
    t.addRow(['a', 'b']);
    expect(t.resolveColumnWidths(200)).toEqual([100, 100]);
  });

  it('throws when the spec count does not match the column count', () => {
    const t = createTable();
    t.addRow(['a', 'b', 'c']);
    t.setColumnWidths([{ fraction: 1 }, { fraction: 1 }]);
    expect(() => t.resolveColumnWidths(300)).toThrow(TypeError);
  });

  it('throws when fixed columns leave no room for the fractions', () => {
    const t = createTable();
    t.addRow(['a', 'b']);
    t.setColumnWidths([{ fixed: 200 }, { fraction: 1 }]);
    expect(() => t.resolveColumnWidths(200)).toThrow(TypeError);
  });

  it('rejects a non-positive totalWidth', () => {
    const t = createTable();
    t.addRow(['a']);
    expect(() => t.resolveColumnWidths(0)).toThrow(TypeError);
  });

  it('column count reflects colspan; an empty table resolves to []', () => {
    const t = createTable();
    t.addRow().addCell('Summary', { colSpan: 3 });
    t.addRow(['a', 'b', 'c']);
    expect(t.resolveColumnWidths(300)).toEqual([100, 100, 100]);
    expect(createTable().resolveColumnWidths(300)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/table-author.test.ts`
Expected: FAIL — `t.resolveColumnWidths is not a function`.

- [ ] **Step 3: Add `columnCount()` and `resolveColumnWidths()` to `TableBuilder`**

In `src/tableauthor.ts`, add both methods inside `TableBuilder`, after `setColumnWidths`:

```ts
  /** @internal Physical column count = the widest row's total colSpan. */
  private columnCount(): number {
    return this.rows.reduce(
      (m, r) => Math.max(m, r.cells.reduce((s, c) => s + c.colSpan, 0)),
      0);
  }

  /** Resolve the column specs (from {@link setColumnWidths}, or equal columns if
   *  unset) plus a `totalWidth` in points into concrete per-column widths. Fixed
   *  columns take their absolute width; fraction columns split the leftover
   *  `totalWidth - Σfixed` by share. Returns `[]` for an empty table. Throws if
   *  the spec count disagrees with the column count, or if fixed columns leave no
   *  room for the fractions. */
  resolveColumnWidths(totalWidth: number): number[] {
    if (typeof totalWidth !== 'number' || !Number.isFinite(totalWidth) || totalWidth <= 0)
      throw new TypeError('totalWidth must be a positive finite number');
    const n = this.columnCount();
    if (n === 0) return [];
    const specs = this.columnSpecs ?? Array.from({ length: n }, () => ({ fraction: 1 } as ColumnWidth));
    if (specs.length !== n)
      throw new TypeError(`setColumnWidths has ${specs.length} entries but the table has ${n} columns`);
    let fixedSum = 0, fracSum = 0;
    for (const w of specs) {
      if ('fixed' in w) fixedSum += w.fixed; else fracSum += w.fraction;
    }
    const remaining = totalWidth - fixedSum;
    if (fracSum > 0 && remaining <= 0)
      throw new TypeError('fixed columns leave no room for the proportional columns');
    return specs.map((w) => ('fixed' in w ? w.fixed : (remaining * w.fraction) / fracSum));
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/table-author.test.ts`
Expected: PASS (builder + resolution tests).

- [ ] **Step 5: Commit**

```bash
git add src/tableauthor.ts test/table-author.test.ts
git commit -m "feat(table): resolveColumnWidths — fixed + proportional resolution (49l.2)"
```

---

### Task 3: Colspan-aware `measure()`

**Files:**
- Modify: `src/tableauthor.ts` (replace the cell loop in `measure` with a physical-column walk)
- Test: `test/table-author.test.ts` (new colspan-measurement `describe` block)

**Interfaces:**
- Consumes (Tasks 1–2): `CellBuilder.colSpan`, `resolveColumnWidths`, and the unchanged `measure(columnWidths: number[], opts?: { cellPadding?: number }): TableMetrics`.
- Produces: no new symbol — `measure` gains span handling; `rowHeights` / `totalHeight` / `cellLines` keep their 49l.1 shapes (`cellLines` indexed by cell position within the row).

- [ ] **Step 1: Write the failing test**

Append this `describe` block to `test/table-author.test.ts` (it uses the already-imported `measureText`):

```ts
describe('table authoring — colspan measurement', () => {
  it('resolve-then-measure: a colspan header shares the full width', () => {
    const t = createTable({ font: 'Helvetica', fontSize: 10, leading: 12 });
    t.addRow().addCell('Header', { colSpan: 2 });
    t.addRow(['left', 'right']);
    const widths = t.resolveColumnWidths(300);
    const m = t.measure(widths, { cellPadding: 0 });
    expect(widths).toEqual([150, 150]);
    expect(m.cellLines[0].length).toBe(1); // header row: one spanning cell
    expect(m.cellLines[1].length).toBe(2); // body row: two cells
  });

  it('a spanning cell wraps to fewer lines than the same text in one column', () => {
    const t = createTable({ font: 'Helvetica', fontSize: 10, leading: 12 });
    const word = 'aaaa';
    const w = measureText(word, 10, 'Helvetica');
    const sp = measureText(' ', 10, 'Helvetica');
    // One column fits exactly two words + a space; two spanned columns fit all four.
    const colWidth = 2 * w + 1.5 * sp + 0.5;
    const text = `${word} ${word} ${word} ${word}`;
    t.addRow().addCell(text);                    // one column -> 2 lines
    t.addRow().addCell(text, { colSpan: 2 });    // spans both -> 1 line
    const m = t.measure([colWidth, colWidth], { cellPadding: 0 });
    expect(m.cellLines[0][0].length).toBe(2);
    expect(m.cellLines[1][0].length).toBe(1);
  });

  it("throws when a row's spans overrun the provided columns", () => {
    const t = createTable();
    t.addRow().addCell('a', { colSpan: 3 });
    expect(() => t.measure([100, 100])).toThrow(TypeError);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/table-author.test.ts`
Expected: FAIL — the colspan header is measured against a single column (wrong line counts), and the overrun case does not yet throw.

- [ ] **Step 3: Replace the `measure` method body**

In `src/tableauthor.ts`, replace the entire `measure` method (from `measure(columnWidths...` through its closing `}`) with:

```ts
  /** Measure the table's natural laid-out height given resolved `columnWidths`
   *  (points). A cell spans `cell.colSpan` adjacent columns (default 1); its
   *  outer width is the sum of those columns and its text is wrapped to
   *  `outer - 2*cellPadding`. Cell height is `max(1, lineCount) * leading +
   *  2*cellPadding`; row height is the tallest cell; total is the row sum.
   *  `cellPadding` defaults to 2pt. */
  measure(columnWidths: number[], opts: { cellPadding?: number } = {}): TableMetrics {
    if (!Array.isArray(columnWidths) || !columnWidths.every((w) => Number.isFinite(w) && w > 0))
      throw new TypeError('columnWidths must be an array of positive finite numbers');
    const padding = opts.cellPadding ?? 2;
    if (!Number.isFinite(padding) || padding < 0)
      throw new TypeError('cellPadding must be a non-negative finite number');
    const cols = this.columnCount();
    if (columnWidths.length < cols)
      throw new TypeError(`columnWidths has ${columnWidths.length} entries but a row spans ${cols} columns`);

    const rowHeights: number[] = [];
    const cellLines: string[][][] = [];
    for (const row of this.rows) {
      const rowCellLines: string[][] = [];
      let rowHeight = 0;
      let c = 0; // physical-column cursor
      for (const cell of row.cells) {
        if (c + cell.colSpan > columnWidths.length)
          throw new TypeError(`a row's spans overrun the ${columnWidths.length} provided columns`);
        let outerWidth = 0;
        for (let k = 0; k < cell.colSpan; k++) outerWidth += columnWidths[c + k];
        const innerWidth = outerWidth - 2 * padding;
        if (innerWidth <= 0)
          throw new TypeError('each cell span width must exceed 2 * cellPadding');
        const st = resolveStyle(cell, this.defaults);
        const res = layoutText(cell.text, measuringDriverFor(st.font), st.fontSize, innerWidth, Infinity, st.leading);
        const lineCount = Math.max(1, res.lines.length);
        rowHeight = Math.max(rowHeight, lineCount * st.leading + 2 * padding);
        rowCellLines.push(res.lines.map((l) => l.text));
        c += cell.colSpan;
      }
      rowHeights.push(rowHeight);
      cellLines.push(rowCellLines);
    }
    return { rowHeights, totalHeight: rowHeights.reduce((a, b) => a + b, 0), cellLines };
  }
```

Note: the 49l.1 measurement tests (`rejects too-few columns and a width <= 2*padding`) still pass — a too-short `columnWidths` trips the `cols` check, and `measure([5, 5], { cellPadding: 3 })` trips the per-cell `innerWidth <= 0` check.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/table-author.test.ts`
Expected: PASS (all builder, resolution, 49l.1 measurement, and new colspan tests).

- [ ] **Step 5: Commit**

```bash
git add src/tableauthor.ts test/table-author.test.ts
git commit -m "feat(table): colspan-aware measure() column walk (49l.2)"
```

---

### Task 4: Whole-suite + typecheck gate

**Files:** none changed (integration verification).

- [ ] **Step 1: Typecheck the whole project**

Run: `npm run typecheck`
Expected: exits 0, no errors. (Catches `.d.ts` / import-extension issues from the new public type exports.)

- [ ] **Step 2: Run the full test suite**

Run: `npm test`
Expected: the whole `test/**/*.test.ts` suite passes, including `test/table-author.test.ts`, with no regressions.

- [ ] **Step 3: Close the issue (only if both gates are green)**

```bash
bd close aspose-pdf-foss-for-ts-49l.2
bd export -o .beads/issues.jsonl
git add .beads/issues.jsonl
git commit -m "chore(bd): close 49l.2 (column widths + colspan)"
```

> README note: the user-facing feature entry stays deferred to 49l.4, when a render path exists. Do not add a README section in this issue.

---

## Notes / known limitations (by design)

- **Spanned width is a plain column sum.** Inter-column borders/gaps are 49l.3; when they land, a spanned cell reclaims the interior borders it bridges — an additive change to `outerWidth`.
- **All-fixed tables may under- or over-run `totalWidth`.** Fixed is fixed; page-fit is 49l.4/49l.5. Only fraction columns with no leftover space are an error.
- **Colspan is horizontal only.** Rowspan is not part of the epic.
- **`cellLines` stays indexed by cell position**, not physical column. The renderer (49l.4) maps a cell to its starting physical column via the same span walk `measure` uses.

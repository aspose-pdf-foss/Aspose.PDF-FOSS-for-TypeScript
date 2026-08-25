# Table Core Model + Cell/Row Builders + Measurement — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a page-independent table authoring model — build a table from rows/cells and measure its natural laid-out height for resolved column widths.

**Architecture:** A new module `src/tableauthor.ts` exposes `createTable()` → `TableBuilder` with `RowBuilder`/`CellBuilder`. Cells hold text plus optional per-cell font overrides that fall back to table defaults. `TableBuilder.measure(columnWidths, {cellPadding})` reuses the existing `layoutText()` word-wrap engine (with unbounded height so nothing is dropped) to compute per-row heights, a total, and the wrapped line texts. No page/`/Contents` interaction — rendering is a later issue (49l.4).

**Tech Stack:** TypeScript (strict, ESM + NodeNext), vitest. Reuses `layout.ts` (`layoutText`, `winAnsiDriver`, `FontDriver`), `stamp.ts` (`AuthoringFont`, `validateFont`), `embeddedfont.ts` (`EmbeddedFont`).

**Spec:** `docs/superpowers/specs/2026-07-22-table-core-model-design.md`
**Issue:** `aspose-pdf-foss-for-ts-49l.1`

## Global Constraints

- ESM + NodeNext, `strict` TypeScript. Every import specifier carries the `.js` extension (e.g. `import { EmbeddedFont } from './embeddedfont.js'`).
- Zero runtime dependencies — `node:` built-ins only. Do not add npm runtime deps.
- TDD with vitest; tests live in `test/**/*.test.ts`.
- Argument-validation failures throw `TypeError` (matches `graphics.ts` / `stamp.ts`).
- `npm run typecheck` and `npm test` must both be green before the issue is closed.
- Method naming: camelCase on the builder classes (matches `PageGraphics`).

---

### Task 1: Builders, types, and validation

**Files:**
- Create: `src/tableauthor.ts`
- Modify: `src/stamp.ts` (export the existing `validateFont`)
- Modify: `src/index.ts` (export the new public symbols)
- Test: `test/table-author.test.ts`

**Interfaces:**
- Consumes: `AuthoringFont`, `validateFont` from `src/stamp.js`.
- Produces:
  - `interface TableDefaults { font?: AuthoringFont; fontSize?: number; leading?: number; color?: [number, number, number] }`
  - `interface CellTextOptions { font?: AuthoringFont; fontSize?: number; leading?: number; color?: [number, number, number] }`
  - `class CellBuilder { text: string; readonly options: CellTextOptions }`
  - `class RowBuilder { readonly cells: CellBuilder[]; addCell(text?: string, opts?: CellTextOptions): CellBuilder }`
  - `class TableBuilder { readonly rows: RowBuilder[]; readonly defaults: TableDefaults; addRow(cells?: string[]): RowBuilder }`
  - `function createTable(opts?: TableDefaults): TableBuilder`

- [ ] **Step 1: Export `validateFont` from `stamp.ts`**

In `src/stamp.ts`, change the declaration (near line 92):

```ts
export function validateFont(font: AuthoringFont): void {
  if (font instanceof EmbeddedFont) return;
  if (typeof font !== 'string' || !AUTHORING_FONTS.includes(font))
    throw new TypeError(
      `font must be one of the 12 Latin Standard-14 fonts or a Document.AddFont handle, got ${JSON.stringify(font)}`);
}
```

(Only the leading `export` is added; the body is unchanged.)

- [ ] **Step 2: Write the failing test**

Create `test/table-author.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { createTable } from '../src/index.js';

describe('table authoring — builders', () => {
  it('builds rows from a string[] shorthand', () => {
    const t = createTable();
    const r = t.addRow(['Name', 'Qty']);
    expect(t.rows.length).toBe(1);
    expect(r.cells.map((c) => c.text)).toEqual(['Name', 'Qty']);
  });

  it('builds cells one at a time and reads them back', () => {
    const t = createTable();
    const r = t.addRow();
    r.addCell('Widget', { font: 'Helvetica-Bold' });
    r.addCell('3');
    expect(r.cells.map((c) => c.text)).toEqual(['Widget', '3']);
    expect(r.cells[0].options.font).toBe('Helvetica-Bold');
  });

  it('rejects an unknown font at set time', () => {
    const t = createTable();
    const r = t.addRow();
    expect(() => r.addCell('x', { font: 'Comic Sans' as any })).toThrow(TypeError);
    expect(() => createTable({ font: 'Nope' as any })).toThrow(TypeError);
  });

  it('rejects a non-positive fontSize', () => {
    expect(() => createTable({ fontSize: 0 })).toThrow(TypeError);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run test/table-author.test.ts`
Expected: FAIL — `createTable` is not exported (module `../src/index.js` has no such member) / `src/tableauthor.ts` does not exist.

- [ ] **Step 4: Write `src/tableauthor.ts` (builders + types + validation)**

```ts
import { AuthoringFont, validateFont } from './stamp.js';

/** Table-level text defaults; each is overridable per cell. */
export interface TableDefaults {
  font?: AuthoringFont;
  fontSize?: number;
  leading?: number;
  color?: [number, number, number];
}

/** Per-cell text overrides; each falls back to the table default. */
export interface CellTextOptions {
  font?: AuthoringFont;
  fontSize?: number;
  leading?: number;
  color?: [number, number, number];
}

function checkPos(label: string, n: number): void {
  if (typeof n !== 'number' || !Number.isFinite(n) || n <= 0)
    throw new TypeError(`${label} must be a positive finite number`);
}

function checkColor(rgb: [number, number, number]): void {
  if (!Array.isArray(rgb) || rgb.length !== 3 ||
      !rgb.every((c) => typeof c === 'number' && Number.isFinite(c) && c >= 0 && c <= 1))
    throw new TypeError('color must be [r, g, b] with each component in 0..1');
}

/** Validate the optional fields shared by table defaults and per-cell options. */
function validateStyleOpts(o: TableDefaults | CellTextOptions): void {
  if (o.font !== undefined) validateFont(o.font);
  if (o.fontSize !== undefined) checkPos('fontSize', o.fontSize);
  if (o.leading !== undefined) checkPos('leading', o.leading);
  if (o.color !== undefined) checkColor(o.color);
}

/** One cell in a table row: a text string plus optional per-cell style. */
export class CellBuilder {
  constructor(public text: string, readonly options: CellTextOptions) {}
}

/** One row: an ordered list of cells. */
export class RowBuilder {
  readonly cells: CellBuilder[] = [];

  /** Append a cell with `text` (default '') and optional per-cell style. */
  addCell(text = '', opts: CellTextOptions = {}): CellBuilder {
    validateStyleOpts(opts);
    const c = new CellBuilder(text, opts);
    this.cells.push(c);
    return c;
  }
}

/** A page-independent table: ordered rows over shared text defaults. Build it
 *  with {@link createTable}, then measure (and later render) it. */
export class TableBuilder {
  readonly rows: RowBuilder[] = [];

  /** @internal Use {@link createTable}. */
  constructor(readonly defaults: TableDefaults) {}

  /** Append a row. With a `string[]`, appends one text cell per entry. */
  addRow(cells?: string[]): RowBuilder {
    const r = new RowBuilder();
    if (cells) for (const t of cells) r.addCell(t);
    this.rows.push(r);
    return r;
  }
}

/** Create a table with optional shared text defaults (font, size, leading,
 *  color), each overridable per cell. */
export function createTable(opts: TableDefaults = {}): TableBuilder {
  validateStyleOpts(opts);
  return new TableBuilder(opts);
}
```

- [ ] **Step 5: Add public exports to `src/index.ts`**

Append after the `stamp.js` export block (near line 64):

```ts
export { createTable, TableBuilder, RowBuilder, CellBuilder } from './tableauthor.js';
export type { TableDefaults, CellTextOptions } from './tableauthor.js';
```

- [ ] **Step 6: Run test to verify it passes**

Run: `npx vitest run test/table-author.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 7: Commit**

```bash
git add src/tableauthor.ts src/stamp.ts src/index.ts test/table-author.test.ts
git commit -m "feat(table): authoring builders — createTable/TableBuilder/RowBuilder/CellBuilder (49l.1)"
```

---

### Task 2: Natural-height measurement

**Files:**
- Modify: `src/tableauthor.ts` (add `measure()`, the measuring driver, style resolution, `TableMetrics`)
- Modify: `src/index.ts` (export `TableMetrics`)
- Test: `test/table-author.test.ts` (add a measurement `describe` block)

**Interfaces:**
- Consumes: `layoutText`, `winAnsiDriver`, `FontDriver` from `src/layout.js`; `EmbeddedFont` from `src/embeddedfont.js`; the Task 1 classes.
- Produces:
  - `interface TableMetrics { rowHeights: number[]; totalHeight: number; cellLines: string[][][] }`
  - `TableBuilder.measure(columnWidths: number[], opts?: { cellPadding?: number }): TableMetrics`

- [ ] **Step 1: Write the failing test**

Append to `test/table-author.test.ts`:

```ts
import { measureText } from '../src/stamp.js';

describe('table authoring — measurement', () => {
  it('single-line cells: row height = leading + 2*padding', () => {
    const t = createTable({ font: 'Helvetica', fontSize: 10, leading: 12 });
    t.addRow(['Hi', 'Yo']);
    const m = t.measure([100, 100], { cellPadding: 3 });
    expect(m.rowHeights.length).toBe(1);
    expect(m.rowHeights[0]).toBeCloseTo(12 + 2 * 3, 6);
    expect(m.totalHeight).toBeCloseTo(18, 6);
    expect(m.cellLines[0][0]).toEqual(['Hi']);
  });

  it('row height is the tallest cell in the row', () => {
    const t = createTable({ font: 'Helvetica', fontSize: 10, leading: 12 });
    const word = 'aaaa';
    const w = measureText(word, 10, 'Helvetica');
    const sp = measureText(' ', 10, 'Helvetica');
    // A width that fits exactly two words plus their separating space, not three.
    const colWidth = 2 * w + sp + 0.5;
    const r = t.addRow();
    r.addCell('short');                                 // one line
    r.addCell(`${word} ${word} ${word} ${word}`);       // wraps to two lines
    const m = t.measure([colWidth, colWidth], { cellPadding: 0 });
    expect(m.cellLines[0][1].length).toBe(2);
    expect(m.rowHeights[0]).toBeCloseTo(2 * 12, 6);
  });

  it('padding adds 2*P per row', () => {
    const t = createTable({ fontSize: 10, leading: 12 });
    t.addRow(['a']);
    t.addRow(['b']);
    const a = t.measure([100], { cellPadding: 0 });
    const b = t.measure([100], { cellPadding: 4 });
    expect(b.totalHeight - a.totalHeight).toBeCloseTo(2 * 4 * 2, 6);
  });

  it('empty cell keeps one line of height; empty table is zero', () => {
    const t = createTable({ fontSize: 10, leading: 12 });
    t.addRow(['']);
    expect(t.measure([100], { cellPadding: 0 }).totalHeight).toBeCloseTo(12, 6);
    expect(createTable().measure([]).totalHeight).toBe(0);
  });

  it('an explicit newline forces a line break', () => {
    const t = createTable({ fontSize: 10, leading: 12 });
    t.addRow(['a\nb']);
    const m = t.measure([200], { cellPadding: 0 });
    expect(m.cellLines[0][0]).toEqual(['a', 'b']);
    expect(m.rowHeights[0]).toBeCloseTo(2 * 12, 6);
  });

  it('rejects too-few columns and a width <= 2*padding', () => {
    const t = createTable();
    t.addRow(['a', 'b']);
    expect(() => t.measure([100])).toThrow(TypeError);
    expect(() => t.measure([5, 5], { cellPadding: 3 })).toThrow(TypeError);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/table-author.test.ts`
Expected: FAIL — `t.measure is not a function` (and `TableMetrics` unused import errors are not present; only runtime failures).

- [ ] **Step 3: Add measurement to `src/tableauthor.ts`**

Add these imports at the top of the file (alongside the existing `stamp.js` import):

```ts
import { EmbeddedFont } from './embeddedfont.js';
import { FontDriver, winAnsiDriver, layoutText } from './layout.js';
```

Add, after the `CellTextOptions` interface:

```ts
/** Measurement result for a table at given resolved column widths. */
export interface TableMetrics {
  /** Per-row laid height in points. */
  rowHeights: number[];
  /** Sum of `rowHeights`. */
  totalHeight: number;
  /** `cellLines[row][col]` = the wrapped line texts of that cell. */
  cellLines: string[][][];
}

/** A cell's fully-resolved text style (no undefined fields). */
interface ResolvedStyle {
  font: AuthoringFont;
  fontSize: number;
  leading: number;
}

const EMPTY = new Uint8Array(0);

/** A {@link FontDriver} that measures/wraps like the real font but records no
 *  glyph usage — `encode` returns empty bytes, which measurement ignores. This
 *  keeps `measure()` side-effect-free for embedded fonts. */
function measuringDriverFor(font: AuthoringFont): FontDriver {
  const real: FontDriver = font instanceof EmbeddedFont ? font.driver() : winAnsiDriver(font);
  return { measure: (t, fs) => real.measure(t, fs), probe: (t) => real.probe(t), encode: () => EMPTY };
}

/** Resolve a cell's style against table defaults, then built-ins
 *  (Helvetica / 12pt / 1.2*fontSize leading). */
function resolveStyle(cell: CellBuilder, d: TableDefaults): ResolvedStyle {
  const fontSize = cell.options.fontSize ?? d.fontSize ?? 12;
  return {
    font: cell.options.font ?? d.font ?? 'Helvetica',
    fontSize,
    leading: cell.options.leading ?? d.leading ?? 1.2 * fontSize,
  };
}
```

Add the `measure` method inside the `TableBuilder` class (after `addRow`):

```ts
  /** Measure the table's natural laid-out height given resolved `columnWidths`
   *  (points). Cell `i` maps to column `i` (no spans yet). Each cell's text is
   *  wrapped to `columnWidths[i] - 2*cellPadding`; its height is
   *  `max(1, lineCount) * leading + 2*cellPadding`. Row height is the tallest
   *  cell; total is the row sum. `cellPadding` defaults to 2pt. */
  measure(columnWidths: number[], opts: { cellPadding?: number } = {}): TableMetrics {
    if (!Array.isArray(columnWidths) || !columnWidths.every((w) => Number.isFinite(w) && w > 0))
      throw new TypeError('columnWidths must be an array of positive finite numbers');
    const padding = opts.cellPadding ?? 2;
    if (!Number.isFinite(padding) || padding < 0)
      throw new TypeError('cellPadding must be a non-negative finite number');
    const maxCells = this.rows.reduce((m, r) => Math.max(m, r.cells.length), 0);
    if (columnWidths.length < maxCells)
      throw new TypeError(`columnWidths has ${columnWidths.length} entries but a row has ${maxCells} cells`);
    if (columnWidths.slice(0, maxCells).some((w) => w <= 2 * padding))
      throw new TypeError('each used column width must exceed 2 * cellPadding');

    const rowHeights: number[] = [];
    const cellLines: string[][][] = [];
    for (const row of this.rows) {
      const rowCellLines: string[][] = [];
      let rowHeight = 0;
      for (let i = 0; i < row.cells.length; i++) {
        const cell = row.cells[i];
        const st = resolveStyle(cell, this.defaults);
        const innerWidth = columnWidths[i] - 2 * padding;
        const res = layoutText(cell.text, measuringDriverFor(st.font), st.fontSize, innerWidth, Infinity, st.leading);
        const lineCount = Math.max(1, res.lines.length);
        rowHeight = Math.max(rowHeight, lineCount * st.leading + 2 * padding);
        rowCellLines.push(res.lines.map((l) => l.text));
      }
      rowHeights.push(rowHeight);
      cellLines.push(rowCellLines);
    }
    return { rowHeights, totalHeight: rowHeights.reduce((a, b) => a + b, 0), cellLines };
  }
```

- [ ] **Step 4: Export `TableMetrics` from `src/index.ts`**

Extend the type export added in Task 1:

```ts
export type { TableDefaults, CellTextOptions, TableMetrics } from './tableauthor.js';
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run test/table-author.test.ts`
Expected: PASS (all builder + measurement tests).

- [ ] **Step 6: Commit**

```bash
git add src/tableauthor.ts src/index.ts test/table-author.test.ts
git commit -m "feat(table): natural-height measurement via layoutText (49l.1)"
```

---

### Task 3: Whole-suite + typecheck gate

**Files:** none changed (integration verification).

- [ ] **Step 1: Typecheck the whole project**

Run: `npm run typecheck`
Expected: exits 0, no errors. (Catches `.d.ts` naming / import-extension issues from the new public exports.)

- [ ] **Step 2: Run the full test suite**

Run: `npm test`
Expected: the whole `test/**/*.test.ts` suite passes, including `test/table-author.test.ts`, with no regressions from the `stamp.ts` export change.

- [ ] **Step 3: Close the issue (only if both gates are green)**

```bash
bd close aspose-pdf-foss-for-ts-49l.1
bd export -o .beads/issues.jsonl
git add .beads/issues.jsonl
git commit -m "chore(bd): close 49l.1 (table core model)"
```

> README note: the user-facing feature entry is intentionally deferred to 49l.4, when a render path exists. Do not add a README section in this issue.

---

## Notes / known limitations (by design)

- **No shaping in cell measurement.** `layoutText` measures with the plain driver (no BiDi/GSUB/GPOS). Shaped table text is out of scope for the epic's foundation; Standard-14 and unshaped embedded fonts measure correctly.
- **`cellLines` for an empty cell is `[]`, but its reserved height is one line.** A blank cell draws nothing yet occupies a row slot — intended, so a blank cell does not collapse a row.
- **Cell `i` → column `i`.** Colspan and width resolution are 49l.2; `measure()` is structured so that becomes an additive change to the cell→column mapping.

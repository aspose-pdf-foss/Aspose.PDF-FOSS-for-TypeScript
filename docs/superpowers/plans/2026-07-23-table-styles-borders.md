# Table Styles, Borders & Backgrounds Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add borders, background fills, H/V text alignment, and a table→row→cell style cascade to the table renderer, with cell padding promoted into the table style.

**Architecture:** Additive to the shipped model (`tableauthor.ts`) and renderer (`tablerender.ts`). A new `BorderInfo` type; the cascadable option type gains `align`/`valign`/`border`/`background`; `TableDefaults` gains `padding`/`outerBorder`; `resolveCellStyle` becomes a three-level cascade; `RowBuilder` carries a style. The renderer paints three appended passes — backgrounds (bottom) → text (middle) → borders (top) — using `PageGraphics`.

**Tech Stack:** TypeScript (strict, ESM + NodeNext), vitest. Reuses `PageGraphics` (`graphics.ts`), `stampTextBlock` (`stamp.ts`), and public extraction (`GetPaths`, `GetTextFragments`) for tests.

**Spec:** `docs/superpowers/specs/2026-07-23-table-styles-borders-design.md`
**Issue:** `aspose-pdf-foss-for-ts-49l.3`

## Global Constraints

- ESM + NodeNext, `strict` TypeScript. Every import specifier carries the `.js` extension.
- Zero runtime dependencies — `node:` built-ins only.
- TDD with vitest; tests in `test/**/*.test.ts`.
- Argument-validation failures throw `TypeError`.
- `npm run typecheck` and `npm test` must both be green before closing the issue.
- `GetPaths()` returns colours as **0..255** RGB (red = `[255,0,0]`); `c*255` rounded via `Math.round`.

---

### Task 1: Model — style types, three-level cascade, validation, row style, padding-from-style

**Files:**
- Modify: `src/tableauthor.ts`
- Modify: `src/index.ts` (export `BorderInfo`)
- Test: `test/table-author.test.ts` (update the existing `resolveCellStyle` block; add cascade/validation/padding tests)

**Interfaces:**
- Produces:
  - `export interface BorderInfo { width: number; color: [number,number,number]; dash?: number[] }`
  - `CellTextOptions` gains `align?: 'left'|'center'|'right'`, `valign?: 'top'|'center'|'bottom'`, `border?: BorderInfo`, `background?: [number,number,number]`.
  - `TableDefaults extends CellTextOptions` and adds `padding?: number`, `outerBorder?: BorderInfo`.
  - `ResolvedStyle` gains `align`, `valign`, `border?`, `background?`.
  - `resolveCellStyle(cell: CellBuilder, row: CellTextOptions, table: TableDefaults): ResolvedStyle` (was 2-arg).
  - `RowBuilder` gains `readonly style: CellTextOptions`; `addRow(cells?: string[], style?: CellTextOptions): RowBuilder`.

- [ ] **Step 1: Update the existing `resolveCellStyle` tests to the 3-arg cascade and add coverage**

In `test/table-author.test.ts`, replace the entire `describe('table authoring — resolveCellStyle cascade', ...)` block (added in 49l.4) with:

```ts
describe('table authoring — resolveCellStyle cascade', () => {
  it('resolves cell ?? row ?? table ?? built-in for every field', () => {
    const t = createTable({ font: 'Times-Roman', fontSize: 10, color: [0, 0, 1], align: 'center' });
    const r = t.addRow(['a'], { align: 'right', background: [0, 1, 0] });
    const cellInheritsRow = r.cells[0];                          // align<-row, bg<-row, font<-table
    const b = r.addCell('b', { color: [1, 0, 0], leading: 20, valign: 'bottom' });
    expect(resolveCellStyle(cellInheritsRow, r.style, t.defaults)).toEqual({
      font: 'Times-Roman', fontSize: 10, leading: 1.2 * 10, color: [0, 0, 1],
      align: 'right', valign: 'top', border: undefined, background: [0, 1, 0],
    });
    expect(resolveCellStyle(b, r.style, t.defaults)).toEqual({
      font: 'Times-Roman', fontSize: 10, leading: 20, color: [1, 0, 0],
      align: 'right', valign: 'bottom', border: undefined, background: [0, 1, 0],
    });
  });

  it('falls back to built-ins when nothing is set', () => {
    const t = createTable();
    const c = t.addRow().addCell('x');
    expect(resolveCellStyle(c, t.rows[0].style, t.defaults)).toEqual({
      font: 'Helvetica', fontSize: 12, leading: 1.2 * 12, color: [0, 0, 0],
      align: 'left', valign: 'top', border: undefined, background: undefined,
    });
  });

  it('validates the new style fields', () => {
    expect(() => createTable({ align: 'middle' as any })).toThrow(TypeError);
    expect(() => createTable({ valign: 'centre' as any })).toThrow(TypeError);
    expect(() => createTable({ border: { width: 0, color: [0, 0, 0] } })).toThrow(TypeError);
    expect(() => createTable({ border: { width: 1, color: [2, 0, 0] } })).toThrow(TypeError);
    expect(() => createTable({ background: [0, 0, 2] as any })).toThrow(TypeError);
    expect(() => createTable({ padding: -1 })).toThrow(TypeError);
    expect(() => createTable().addRow(['a'], { align: 'x' as any })).toThrow(TypeError);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/table-author.test.ts`
Expected: FAIL — `resolveCellStyle` is 2-arg / new fields unvalidated (type + assertion errors).

- [ ] **Step 3: Add `BorderInfo` and extend the option interfaces**

In `src/tableauthor.ts`, replace the `TableDefaults` and `CellTextOptions` interfaces (lines 5–19) with:

```ts
/** A cell/table border: stroke width (pt), RGB colour (0..1), optional dash. */
export interface BorderInfo {
  width: number;
  color: [number, number, number];
  dash?: number[];
}

/** Per-cell/row text + visual style; each field falls back through the cascade
 *  (cell ?? row ?? table ?? built-in). */
export interface CellTextOptions {
  font?: AuthoringFont;
  fontSize?: number;
  leading?: number;
  color?: [number, number, number];
  align?: 'left' | 'center' | 'right';
  valign?: 'top' | 'center' | 'bottom';
  border?: BorderInfo;
  background?: [number, number, number];
}

/** Table-level defaults; the cascade root, plus table-only fields. */
export interface TableDefaults extends CellTextOptions {
  /** Default cell padding in points. Default 2. */
  padding?: number;
  /** Border around the whole table. */
  outerBorder?: BorderInfo;
}
```

- [ ] **Step 4: Extend `ResolvedStyle`**

In `src/tableauthor.ts`, replace the `ResolvedStyle` interface (currently lines 41–47) with:

```ts
/** A cell's fully-resolved style (no undefined text fields). */
export interface ResolvedStyle {
  font: AuthoringFont;
  fontSize: number;
  leading: number;
  color: [number, number, number];
  align: 'left' | 'center' | 'right';
  valign: 'top' | 'center' | 'bottom';
  border?: BorderInfo;
  background?: [number, number, number];
}
```

- [ ] **Step 5: Rewrite `resolveCellStyle` to the three-level cascade**

In `src/tableauthor.ts`, replace the `resolveCellStyle` function (currently lines 59–69) with:

```ts
/** Resolve a cell's style: cell ?? row ?? table ?? built-in
 *  (Helvetica / 12pt / 1.2*fontSize leading / black / left / top / no border /
 *  no background). */
export function resolveCellStyle(
  cell: CellBuilder, row: CellTextOptions, table: TableDefaults,
): ResolvedStyle {
  const o = cell.options;
  const fontSize = o.fontSize ?? row.fontSize ?? table.fontSize ?? 12;
  return {
    font: o.font ?? row.font ?? table.font ?? 'Helvetica',
    fontSize,
    leading: o.leading ?? row.leading ?? table.leading ?? 1.2 * fontSize,
    color: o.color ?? row.color ?? table.color ?? [0, 0, 0],
    align: o.align ?? row.align ?? table.align ?? 'left',
    valign: o.valign ?? row.valign ?? table.valign ?? 'top',
    border: o.border ?? row.border ?? table.border,
    background: o.background ?? row.background ?? table.background,
  };
}
```

- [ ] **Step 6: Extend validation (align/valign/border/background) and add padding/border checks**

In `src/tableauthor.ts`, replace the `validateStyleOpts` function (currently lines 82–88) with the following, and add the helper functions right before it:

```ts
function checkNonNeg(label: string, n: number): void {
  if (typeof n !== 'number' || !Number.isFinite(n) || n < 0)
    throw new TypeError(`${label} must be a non-negative finite number`);
}

function checkAlign(a: unknown): void {
  if (a !== 'left' && a !== 'center' && a !== 'right')
    throw new TypeError("align must be 'left', 'center', or 'right'");
}

function checkValign(v: unknown): void {
  if (v !== 'top' && v !== 'center' && v !== 'bottom')
    throw new TypeError("valign must be 'top', 'center', or 'bottom'");
}

function checkBorder(b: BorderInfo): void {
  if (typeof b !== 'object' || b === null)
    throw new TypeError('border must be a { width, color, dash? } object');
  checkPos('border.width', b.width);
  checkColor(b.color);
  if (b.dash !== undefined &&
      (!Array.isArray(b.dash) || !b.dash.every((n) => typeof n === 'number' && Number.isFinite(n) && n >= 0)))
    throw new TypeError('border.dash must be an array of non-negative finite numbers');
}

/** Validate the cascadable style fields shared by table/row/cell. */
function validateStyleOpts(o: CellTextOptions): void {
  if (o.font !== undefined) validateFont(o.font);
  if (o.fontSize !== undefined) checkPos('fontSize', o.fontSize);
  if (o.leading !== undefined) checkPos('leading', o.leading);
  if (o.color !== undefined) checkColor(o.color);
  if (o.align !== undefined) checkAlign(o.align);
  if (o.valign !== undefined) checkValign(o.valign);
  if (o.border !== undefined) checkBorder(o.border);
  if (o.background !== undefined) checkColor(o.background);
}
```

- [ ] **Step 7: Add `style` to `RowBuilder` and the `addRow` style arg**

In `src/tableauthor.ts`, replace the `RowBuilder` class header (currently lines 120–123, through the `cells` field) so it carries a style:

```ts
/** One row: an ordered list of cells plus an optional row-level style. */
export class RowBuilder {
  readonly cells: CellBuilder[] = [];

  /** @internal Use {@link TableBuilder.addRow}. */
  constructor(readonly style: CellTextOptions = {}) {}
```

(Keep the existing `addCell` method body unchanged below it.)

Then replace `addRow` (currently lines 147–153) with:

```ts
  /** Append a row with an optional row-level `style`. With a `string[]`, appends
   *  one text cell per entry (each inheriting the row + table style). */
  addRow(cells?: string[], style: CellTextOptions = {}): RowBuilder {
    validateStyleOpts(style);
    const r = new RowBuilder(style);
    if (cells) for (const t of cells) r.addCell(t);
    this.rows.push(r);
    return r;
  }
```

- [ ] **Step 8: Padding-from-style and row style in `measure`**

In `src/tableauthor.ts` `measure`, change the padding line (currently line 204):

```ts
    const padding = opts.cellPadding ?? 2;
```

to:

```ts
    const padding = opts.cellPadding ?? this.defaults.padding ?? 2;
```

and change the `resolveCellStyle` call (currently line 225):

```ts
        const st = resolveCellStyle(cell, this.defaults);
```

to:

```ts
        const st = resolveCellStyle(cell, row.style, this.defaults);
```

- [ ] **Step 9: Validate table-only fields in `createTable`**

In `src/tableauthor.ts`, replace `createTable` (currently lines 239–244) with:

```ts
/** Create a table with optional shared defaults (text style, alignment, border,
 *  background, padding, outer border), each overridable per row/cell. */
export function createTable(opts: TableDefaults = {}): TableBuilder {
  validateStyleOpts(opts);
  if (opts.padding !== undefined) checkNonNeg('padding', opts.padding);
  if (opts.outerBorder !== undefined) checkBorder(opts.outerBorder);
  return new TableBuilder(opts);
}
```

- [ ] **Step 10: Export `BorderInfo`**

In `src/index.ts`, change the `tableauthor.js` type-export line (line 66) to add `BorderInfo`:

```ts
export type { TableDefaults, CellTextOptions, TableMetrics, ColumnWidth, CellOptions, BorderInfo } from './tableauthor.js';
```

- [ ] **Step 11: Run to verify it passes**

Run: `npx vitest run test/table-author.test.ts`
Expected: PASS (updated cascade block + all prior model tests).

- [ ] **Step 12: Commit**

```bash
git add src/tableauthor.ts src/index.ts test/table-author.test.ts
git commit -m "feat(table): style cascade — align/valign/border/background + row styles + padding-in-style (49l.3)"
```

---

### Task 2: Renderer — background fills + alignment

**Files:**
- Modify: `src/tablerender.ts` (place cells once; background pass; pass align/valign; padding from style)
- Test: `test/table-render.test.ts` (fill, cascade fill, alignment, padding-shift)

**Interfaces:**
- Consumes: `resolveCellStyle`/`ResolvedStyle` (`tableauthor.ts`), `PageGraphics` (`graphics.ts`), `stampTextBlock` (`stamp.ts`).
- Produces: `drawTable` now paints backgrounds then aligned text; `AddTableOptions.cellPadding` stays optional and falls back to the table style. No signature changes.

- [ ] **Step 1: Write the failing tests**

Append to `test/table-render.test.ts`:

```ts
describe('table rendering — backgrounds & alignment', () => {
  it('a cell background paints a filled rect at the cell', () => {
    const page = Document.Open(buildBlankPage()).Pages[0];
    const t = createTable({ fontSize: 10, leading: 12 });
    t.addRow().addCell('x', { background: [1, 0, 0] });
    const { rowHeights } = t.measure(t.resolveColumnWidths(100), { cellPadding: 2 });
    page.AddTable(t, 72, 720, { width: 100 });
    const red = page.GetPaths().find(
      (p) => p.fill && p.fill.space === 'DeviceRGB' &&
             p.fill.rgb[0] === 255 && p.fill.rgb[1] === 0 && p.fill.rgb[2] === 0)!;
    expect(red).toBeTruthy();
    expect(red.bbox[0]).toBeCloseTo(72, 3);
    expect(red.bbox[2]).toBeCloseTo(172, 3);
    expect(red.bbox[3]).toBeCloseTo(720, 3);
    expect(red.bbox[1]).toBeCloseTo(720 - rowHeights[0], 3);
  });

  it('background cascades table -> row -> cell', () => {
    const page = Document.Open(buildBlankPage()).Pages[0];
    const t = createTable({ background: [0.5, 0.5, 0.5] });     // table gray
    t.addRow(['a'], { background: [0, 0, 1] });                 // row blue
    t.addRow(['b']);                                            // inherits table gray
    t.addRow().addCell('c', { background: [1, 0, 0] });         // cell red
    page.AddTable(t, 72, 720, { width: 60 });
    const rgbs = page.GetPaths().filter((p) => p.fill?.space === 'DeviceRGB').map((p) => p.fill!.rgb);
    expect(rgbs).toContainEqual([0, 0, 255]);
    expect(rgbs).toContainEqual([128, 128, 128]);              // round(0.5*255)
    expect(rgbs).toContainEqual([255, 0, 0]);
  });

  it('horizontal alignment shifts text: left < center < right', () => {
    const xAt = (align: 'left' | 'center' | 'right') => {
      const t = createTable({ fontSize: 10, leading: 12, align });
      t.addRow(['Hi']);
      const page = Document.Open(buildBlankPage()).Pages[0];
      page.AddTable(t, 72, 720, { width: 200, cellPadding: 4 });
      return page.GetTextFragments().find((f) => f.text.includes('Hi'))!.quad[0];
    };
    expect(xAt('left')).toBeLessThan(xAt('center'));
    expect(xAt('center')).toBeLessThan(xAt('right'));
  });

  it('table padding (from style) shifts a left-aligned cell right', () => {
    const xAt = (padding: number) => {
      const t = createTable({ fontSize: 10, leading: 12, padding });
      t.addRow(['Hi']);
      const page = Document.Open(buildBlankPage()).Pages[0];
      page.AddTable(t, 72, 720, { width: 200 });               // no cellPadding -> style padding
      return page.GetTextFragments().find((f) => f.text.includes('Hi'))!.quad[0];
    };
    expect(xAt(10) - xAt(2)).toBeCloseTo(8, 3);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/table-render.test.ts`
Expected: FAIL — no fills are emitted; alignment/padding come from hard-coded left/top and the `cellPadding ?? 2` default.

- [ ] **Step 3: Rewrite `drawTable` to place cells once + background + aligned text**

Replace the entire body of `src/tablerender.ts` with:

```ts
import type { Document } from './document.js';
import type { Page } from './page.js';
import { stampTextBlock } from './stamp.js';
import { PageGraphics } from './graphics.js';
import { TableBuilder, resolveCellStyle, ResolvedStyle } from './tableauthor.js';

/** Options for {@link drawTable} / `page.AddTable`. */
export interface AddTableOptions {
  /** Total table width in points; feeds resolveColumnWidths. Required. */
  width: number;
  /** Inner padding per cell in points. Overrides the table style's `padding`
   *  (default 2). */
  cellPadding?: number;
}

/** A placed cell: page-space rect (top-left origin uses `bottom`), text, style. */
interface Placed { x: number; bottom: number; w: number; h: number; text: string; style: ResolvedStyle }

/** Lay out `table` with its top-left corner at (x, top) in PDF user space and
 *  draw its backgrounds, cell text (aligned), and borders into the page's
 *  /Contents (paint order: fills -> text -> borders). Existing content is
 *  preserved. Input validation is delegated to resolveColumnWidths/measure. */
export function drawTable(
  doc: Document, page: Page, table: TableBuilder,
  x: number, top: number, opts: AddTableOptions,
): void {
  const widths = table.resolveColumnWidths(opts.width);
  if (widths.length === 0) return;
  const padding = opts.cellPadding ?? table.defaults.padding ?? 2;
  const { rowHeights } = table.measure(widths, { cellPadding: padding });

  // Column left edges by prefix sum: columnX[c] = x + Σ widths[0..c).
  const columnX: number[] = [x];
  for (let i = 0; i < widths.length; i++) columnX.push(columnX[i] + widths[i]);

  // Place every cell once (reuses measure's colspan cursor walk).
  const placed: Placed[] = [];
  let rowTop = top;
  for (let r = 0; r < table.rows.length; r++) {
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
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run test/table-render.test.ts`
Expected: PASS (49l.4 tests + the 4 new background/alignment tests).

- [ ] **Step 5: Commit**

```bash
git add src/tablerender.ts test/table-render.test.ts
git commit -m "feat(table): render cell backgrounds + H/V alignment; padding from style (49l.3)"
```

---

### Task 3: Renderer — cell borders + table outer border

**Files:**
- Modify: `src/tablerender.ts` (add the border pass after text)
- Test: `test/table-render.test.ts` (cell border, outer border)

**Interfaces:**
- Consumes: the Task 2 `placed`/`columnX`/`rowHeights` locals and `table.defaults.outerBorder`.
- Produces: `drawTable` also strokes cell borders and the outer border (top pass). No signature change.

- [ ] **Step 1: Write the failing tests**

Append to `test/table-render.test.ts`:

```ts
describe('table rendering — borders', () => {
  it('a cell border strokes a rect at each cell', () => {
    const page = Document.Open(buildBlankPage()).Pages[0];
    const t = createTable({ fontSize: 10, leading: 12, border: { width: 0.75, color: [0, 0, 0] } });
    t.addRow(['a', 'b']);
    const { rowHeights } = t.measure(t.resolveColumnWidths(200), { cellPadding: 2 });
    page.AddTable(t, 72, 720, { width: 200 });
    const cellStrokes = page.GetPaths().filter(
      (p) => p.stroke?.space === 'DeviceRGB' && Math.abs(p.lineWidth - 0.75) < 1e-6);
    expect(cellStrokes.length).toBeGreaterThanOrEqual(2);
    expect(cellStrokes[0].stroke!.rgb).toEqual([0, 0, 0]);
    const c0 = cellStrokes.find((p) => Math.abs(p.bbox[0] - 72) < 1e-3)!;
    expect(c0.bbox[2]).toBeCloseTo(172, 3);
    expect(c0.bbox[3]).toBeCloseTo(720, 3);
    expect(c0.bbox[1]).toBeCloseTo(720 - rowHeights[0], 3);
  });

  it('outerBorder strokes one rect around the whole table', () => {
    const page = Document.Open(buildBlankPage()).Pages[0];
    const t = createTable({ fontSize: 10, leading: 12, outerBorder: { width: 1.5, color: [0, 0, 1] } });
    t.addRow(['a', 'b']);
    t.addRow(['c', 'd']);
    const { rowHeights } = t.measure(t.resolveColumnWidths(200), { cellPadding: 2 });
    const totalH = rowHeights[0] + rowHeights[1];
    page.AddTable(t, 72, 720, { width: 200 });
    const strokes = page.GetPaths().filter((p) => p.stroke && Math.abs(p.lineWidth - 1.5) < 1e-6);
    expect(strokes.length).toBe(1);
    expect(strokes[0].stroke!.rgb).toEqual([0, 0, 255]);
    expect(strokes[0].bbox[0]).toBeCloseTo(72, 3);
    expect(strokes[0].bbox[2]).toBeCloseTo(272, 3);            // 72 + Σwidths
    expect(strokes[0].bbox[3]).toBeCloseTo(720, 3);
    expect(strokes[0].bbox[1]).toBeCloseTo(720 - totalH, 3);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/table-render.test.ts`
Expected: FAIL — no stroke paths are emitted.

- [ ] **Step 3: Add the border pass to `drawTable`**

In `src/tablerender.ts`, at the end of `drawTable` (after the Pass-2 text loop), add:

```ts

  // Pass 3: borders (top). Each border fully sets its state (width/color/dash)
  // so nothing leaks between cells; dash `[]` means solid.
  const bd = new PageGraphics(doc, page);
  for (const p of placed)
    if (p.style.border) {
      const b = p.style.border;
      bd.setLineWidth(b.width).setStrokeColor(b.color).setDash(b.dash ?? [])
        .drawRect(p.x, p.bottom, p.w, p.h).stroke();
    }
  const ob = table.defaults.outerBorder;
  if (ob) {
    const tableWidth = columnX[widths.length] - x;
    const tableBottom = top - rowHeights.reduce((a, h) => a + h, 0);
    bd.setLineWidth(ob.width).setStrokeColor(ob.color).setDash(ob.dash ?? [])
      .drawRect(x, tableBottom, tableWidth, top - tableBottom).stroke();
  }
  bd.apply();
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run test/table-render.test.ts`
Expected: PASS (all background/alignment + border tests).

- [ ] **Step 5: Commit**

```bash
git add src/tablerender.ts test/table-render.test.ts
git commit -m "feat(table): render cell borders + table outer border (49l.3)"
```

---

### Task 4: README, whole-suite + typecheck gate, close issue

**Files:**
- Modify: `README.md` (Tables section — borders/fills/alignment now supported)
- (verification) `npm run typecheck`, `npm test`

- [ ] **Step 1: Update the README Tables section**

In `README.md`, in the `### Tables` section, replace the closing line:

```md
Cell text is drawn left/top-aligned. Borders, background fills, alignment, and
multi-page overflow are in progress.
```

with:

```md
Style the table, a row, or a cell (cell overrides row overrides table): `border`
and `outerBorder` (a `BorderInfo` `{ width, color, dash? }`), `background` fill,
`align`/`valign`, `color`, and `padding`. Multi-page overflow is in progress.

```ts
const t = createTable({
  border: { width: 0.5, color: [0.6, 0.6, 0.6] },   // grid line on every cell
  outerBorder: { width: 1, color: [0, 0, 0] },       // frame
  padding: 4,
});
t.addRow(['Name', 'Total'], { background: [0.9, 0.9, 0.9], align: 'center' }); // header row
t.addRow(['Widget', '$4.00']);
doc.Pages[0].AddTable(t, 72, 720, { width: 300 });
```
```

- [ ] **Step 2: Also update the Features bullet**

In `README.md`, replace the **Table authoring** Features bullet (added in 49l.4):

```md
- **Table authoring** — `createTable()` builds rows/cells with fixed/fractional column widths and colspan; `page.AddTable(table, x, top, { width })` lays it out and draws the cell text. Borders, fills, alignment, and pagination are in progress.
```

with:

```md
- **Table authoring** — `createTable()` builds rows/cells with fixed/fractional column widths and colspan, plus a table→row→cell style cascade (borders, background fills, H/V alignment, padding); `page.AddTable(table, x, top, { width })` lays it out and draws it. Multi-page overflow is in progress.
```

- [ ] **Step 3: Typecheck the whole project**

Run: `npm run typecheck`
Expected: exits 0, no errors.

- [ ] **Step 4: Run the full test suite**

Run: `npm test`
Expected: the whole suite passes, including `test/table-author.test.ts` and `test/table-render.test.ts`, with no regressions (49l.4 render tests still green — no styles set means no fills/borders and left/top text at the same positions).

- [ ] **Step 5: Commit and close the issue (only if both gates are green)**

```bash
git add README.md
git commit -m "docs(table): README — borders, fills, alignment, cascade (49l.3)"
bd close aspose-pdf-foss-for-ts-49l.3
bd export -o .beads/issues.jsonl
git add .beads/issues.jsonl
git commit -m "chore(bd): close 49l.3 (table styles, borders, backgrounds)"
```

---

## Notes / known limitations (by design)

- **Borders are zero-thickness for layout** — drawn on the cell boundary; they
  don't shrink content. Adjacent cells' shared edges are stroked twice (identical
  line).
- **Padding is table-level** — one value for all cells (overridable per-call via
  `cellPadding`); no per-cell padding.
- **No per-side borders, no cell margins, no rowspan.** Pagination is 49l.5.
- **Outer border uses the laid table width** (`Σ widths`), which for an all-fixed
  table can differ from `opts.width`.

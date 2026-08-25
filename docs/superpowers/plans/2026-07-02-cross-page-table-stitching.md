# Cross-Page Table Stitching Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Merge a table's continuation on the next page back into one logical `Table`, exposed as a pure `stitchTables()` engine plus a `Document.GetTables()` wrapper.

**Architecture:** A pure function `stitchTables(perPage: Table[][])` walks pages in order, maintaining open chains; a next-page table extends a chain when it has a matching column signature, with an optional repeated-header drop. Multi-page chains emit one `Table` with concatenated/renumbered rows and a new `pageSpans` field. `Document.GetTables` marshals each page's `GetTables()` into the engine.

**Tech Stack:** TypeScript (ESM, NodeNext, strict, `.js` import specifiers), vitest. Zero runtime deps.

## Global Constraints

- Zero runtime dependencies — only `node:` built-ins. Do not add npm runtime deps.
- ESM + NodeNext: every relative import specifier carries a `.js` extension.
- TDD: failing test first, watch it fail, minimal code to pass.
- Never mutate inputs: stitching produces new `Table`/row/cell objects; shared `Rect` arrays are fine (never mutated).
- Run `npm run typecheck` and `npm test` green before finishing.
- Match surrounding code style in `src/table*.ts`.

---

### Task 1: Add `pageSpans` to the `Table` model

**Files:**
- Modify: `src/tablemodel.ts` (the `Table` class constructor, ~line 26-34)
- Test: `test/tablemodel.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `Table` gains a 6th optional constructor param
  `pageSpans?: { page: number; quad: Rect }[]`, exposed as a public field.

- [ ] **Step 1: Write the failing test**

Add to `test/tablemodel.test.ts`:

```ts
import { Table } from '../src/tablemodel.js';

it('carries optional pageSpans for a stitched table', () => {
  const t = new Table([0, 0, 10, 10], 1, 1, [], undefined,
    [{ page: 0, quad: [0, 0, 10, 10] }, { page: 1, quad: [0, 0, 10, 8] }]);
  expect(t.pageSpans).toHaveLength(2);
  expect(t.pageSpans![1].page).toBe(1);
  const plain = new Table([0, 0, 10, 10], 1, 1, []);
  expect(plain.pageSpans).toBeUndefined();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/tablemodel.test.ts`
Expected: FAIL — `Expected 6 arguments, but got 6` type error / `pageSpans` does not exist on `Table`.

- [ ] **Step 3: Add the field**

In `src/tablemodel.ts`, extend the constructor (after the `summary` param):

```ts
  constructor(
    public quad: Rect,
    public rowCount: number,
    public colCount: number,
    public rows: TableRow[],
    /** Tagged path only: the table's `/Summary`. */
    public summary?: string,
    /** For a stitched table: the contributing page rectangles, in page order.
     *  Absent for a single-page (non-stitched) table. */
    public pageSpans?: { page: number; quad: Rect }[],
  ) {}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/tablemodel.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck + commit**

```bash
npm run typecheck
git add src/tablemodel.ts test/tablemodel.test.ts
git commit -m "feat(7ac): add Table.pageSpans for stitched tables"
```

---

### Task 2: Pure `stitchTables` engine (signature match, chains, emit)

**Files:**
- Create: `src/tablestitch.ts`
- Test: `test/table-stitch.test.ts`

**Interfaces:**
- Consumes: `Table` from `./tablemodel.js` (fields `quad`, `rowCount`,
  `colCount`, `rows`, `summary`; each `TableRow` has `cells`; each
  `TableCell` has `row`, `col`, `colSpan`, `quad`, `text`).
- Produces:
  - `export interface TableStitchOptions { stitch?: boolean; }`
  - `export function stitchTables(perPage: Table[][], options?: TableStitchOptions): Table[]`

This task implements everything except repeated-header drop (Task 3): a follower's
rows are appended verbatim.

- [ ] **Step 1: Write the failing tests**

Create `test/table-stitch.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { Table } from '../src/tablemodel.js';
import type { TableRow, TableCell } from '../src/tablemodel.js';
import { stitchTables } from '../src/tablestitch.js';

/** Build a Table from a grid of row-major text with uniform 20-wide columns and
 *  10-tall rows, top row starting at y=top. Column boundaries are shared by
 *  construction so same-shape tables get matching signatures. */
function grid(texts: string[][], top = 100): Table {
  const cols = texts[0].length;
  const rows: TableRow[] = texts.map((line, r) => {
    const yTop = top - r * 10, yBot = yTop - 10;
    const cells: TableCell[] = line.map((text, c) => ({
      row: r, col: c, rowSpan: 1, colSpan: 1,
      quad: [c * 20, yBot, c * 20 + 20, yTop], text,
    }));
    return { cells, quad: [0, yBot, cols * 20, yTop] };
  });
  const yBot = top - texts.length * 10;
  return new Table([0, yBot, cols * 20, top], texts.length, cols, rows);
}

describe('stitchTables', () => {
  it('stitches a two-page continuation into one table with pageSpans', () => {
    const p0 = grid([['A', 'B'], ['1', '2']]);
    const p1 = grid([['3', '4'], ['5', '6']]);
    const out = stitchTables([[p0], [p1]]);
    expect(out).toHaveLength(1);
    expect(out[0].rowCount).toBe(4);
    expect(out[0].rows.map((r) => r.cells.map((c) => c.text).join(''))).toEqual(['AB', '12', '34', '56']);
    expect(out[0].rows.map((r) => r.cells[0].row)).toEqual([0, 1, 2, 3]);
    expect(out[0].pageSpans).toHaveLength(2);
    expect(out[0].pageSpans!.map((s) => s.page)).toEqual([0, 1]);
  });

  it('does not stitch when column counts differ', () => {
    const out = stitchTables([[grid([['A', 'B']])], [grid([['X', 'Y', 'Z']])]]);
    expect(out).toHaveLength(2);
    expect(out[0].pageSpans).toBeUndefined();
  });

  it('does not stitch when columns are misaligned beyond tolerance', () => {
    const a = grid([['A', 'B']]);
    const b = grid([['X', 'Y']]);
    // shift every boundary of b right by 20 pt
    for (const row of b.rows) for (const c of row.cells) { c.quad = [c.quad[0] + 20, c.quad[1], c.quad[2] + 20, c.quad[3]]; }
    const out = stitchTables([[a], [b]]);
    expect(out).toHaveLength(2);
  });

  it('extends a chain across three pages', () => {
    const out = stitchTables([[grid([['A', 'B']])], [grid([['1', '2']])], [grid([['3', '4']])]]);
    expect(out).toHaveLength(1);
    expect(out[0].pageSpans).toHaveLength(3);
    expect(out[0].rowCount).toBe(3);
  });

  it('breaks a chain across a gap page with no table', () => {
    const out = stitchTables([[grid([['A', 'B']])], [], [grid([['1', '2']])]]);
    expect(out).toHaveLength(2);
    expect(out.every((t) => t.pageSpans === undefined)).toBe(true);
  });

  it('passes tables through unchanged when stitch is false', () => {
    const p0 = grid([['A', 'B']]), p1 = grid([['1', '2']]);
    const out = stitchTables([[p0], [p1]], { stitch: false });
    expect(out).toEqual([p0, p1]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/table-stitch.test.ts`
Expected: FAIL — cannot find module `../src/tablestitch.js` / `stitchTables` is not a function.

- [ ] **Step 3: Implement the engine**

Create `src/tablestitch.ts`:

```ts
import { Table } from './tablemodel.js';
import type { TableRow } from './tablemodel.js';

export interface TableStitchOptions {
  /** Merge continuations across page boundaries. Default true. */
  stitch?: boolean;
}

const STITCH_TOL = 3;   // column-boundary alignment tolerance, in points

/** Sorted, tolerance-deduplicated vertical cell boundaries of a table. */
function columnBoundaries(t: Table): number[] {
  const xs: number[] = [];
  for (const row of t.rows) for (const c of row.cells) xs.push(c.quad[0], c.quad[2]);
  xs.sort((a, b) => a - b);
  const out: number[] = [];
  for (const x of xs) if (!out.length || Math.abs(x - out[out.length - 1]) > STITCH_TOL) out.push(x);
  return out;
}

/** Two consecutive-page tables continue each other when they have the same
 *  column count and pairwise-aligned column boundaries. */
function signatureMatch(a: Table, b: Table): boolean {
  if (a.colCount !== b.colCount) return false;
  const ba = columnBoundaries(a), bb = columnBoundaries(b);
  if (ba.length !== bb.length) return false;
  return ba.every((x, i) => Math.abs(x - bb[i]) <= STITCH_TOL);
}

interface Chain { members: { page: number; table: Table }[]; anchor: number; }

/** Concatenate a chain's rows into one Table: rows renumbered contiguously,
 *  cell quads left page-local, quad/summary from the leader, pageSpans per page.
 *  `follower` rows are already header-adjusted by the caller. */
function emitChain(chain: Chain): Table {
  const lead = chain.members[0].table;
  const rows: TableRow[] = [];
  let idx = 0;
  for (const m of chain.members) {
    for (const row of m.table.rows) {
      const ri = idx++;
      rows.push({ ...row, cells: row.cells.map((c) => ({ ...c, row: ri })) });
    }
  }
  const pageSpans = chain.members.map((m) => ({ page: m.page, quad: m.table.quad }));
  return new Table(lead.quad, rows.length, lead.colCount, rows, lead.summary, pageSpans);
}

export function stitchTables(perPage: Table[][], options: TableStitchOptions = {}): Table[] {
  if (options.stitch === false) return perPage.flat();

  const chains: Chain[] = [];
  for (let page = 0; page < perPage.length; page++) {
    const available = chains.filter((c) => c.anchor === page - 1);
    const used = new Set<Chain>();
    for (const table of perPage[page]) {
      const match = available.find((c) => !used.has(c) && signatureMatch(c.members[c.members.length - 1].table, table));
      if (match) { match.members.push({ page, table }); match.anchor = page; used.add(match); }
      else chains.push({ members: [{ page, table }], anchor: page });
    }
  }

  return chains.map((c) => (c.members.length === 1 ? c.members[0].table : emitChain(c)));
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/table-stitch.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Typecheck + commit**

```bash
npm run typecheck
git add src/tablestitch.ts test/table-stitch.test.ts
git commit -m "feat(7ac): pure stitchTables engine (signature match + chains)"
```

---

### Task 3: Repeated-header drop

**Files:**
- Modify: `src/tablestitch.ts`
- Test: `test/table-stitch.test.ts`

**Interfaces:**
- Consumes: `stitchTables`, `emitChain` from Task 2.
- Produces: no signature change; a follower whose row 0 per-column text equals the
  chain leader's row 0 has that row dropped before concatenation.

- [ ] **Step 1: Write the failing test**

Append to `test/table-stitch.test.ts` inside the `describe`:

```ts
it('drops a repeated header row on the follower', () => {
  const p0 = grid([['H1', 'H2'], ['a', 'b']]);
  const p1 = grid([['H1', 'H2'], ['c', 'd']]);   // header repeats on page 2
  const out = stitchTables([[p0], [p1]]);
  expect(out).toHaveLength(1);
  expect(out[0].rowCount).toBe(3);
  expect(out[0].rows.map((r) => r.cells.map((c) => c.text).join(''))).toEqual(['H1H2', 'ab', 'cd']);
  expect(out[0].rows.map((r) => r.cells[0].row)).toEqual([0, 1, 2]);
});

it('keeps the follower first row when it only partially matches the header', () => {
  const p0 = grid([['H1', 'H2'], ['a', 'b']]);
  const p1 = grid([['H1', 'X'], ['c', 'd']]);
  const out = stitchTables([[p0], [p1]]);
  expect(out[0].rowCount).toBe(4);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/table-stitch.test.ts`
Expected: FAIL — first new test gets `rowCount` 4 (header not dropped), expected 3.

- [ ] **Step 3: Implement header-drop**

In `src/tablestitch.ts`, add a helper and use it in `emitChain`:

```ts
/** Per-column trimmed text of a row, ordered by column. */
function headerKey(row: TableRow): string[] {
  return row.cells.slice().sort((a, b) => a.col - b.col).map((c) => c.text.trim());
}

/** True if follower's row 0 duplicates the leader's header row (all columns). */
function repeatsHeader(leaderRow0: TableRow | undefined, followerRow0: TableRow | undefined): boolean {
  if (!leaderRow0 || !followerRow0) return false;
  const a = headerKey(leaderRow0), b = headerKey(followerRow0);
  return a.length === b.length && a.every((t, i) => t === b[i]);
}
```

Update `emitChain` to skip the follower's row 0 when it repeats the header:

```ts
function emitChain(chain: Chain): Table {
  const lead = chain.members[0].table;
  const headerRow0 = lead.rows[0];
  const rows: TableRow[] = [];
  let idx = 0;
  chain.members.forEach((m, mi) => {
    const src = (mi > 0 && repeatsHeader(headerRow0, m.table.rows[0]))
      ? m.table.rows.slice(1)
      : m.table.rows;
    for (const row of src) {
      const ri = idx++;
      rows.push({ ...row, cells: row.cells.map((c) => ({ ...c, row: ri })) });
    }
  });
  const pageSpans = chain.members.map((m) => ({ page: m.page, quad: m.table.quad }));
  return new Table(lead.quad, rows.length, lead.colCount, rows, lead.summary, pageSpans);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/table-stitch.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 5: Typecheck + commit**

```bash
npm run typecheck
git add src/tablestitch.ts test/table-stitch.test.ts
git commit -m "feat(7ac): drop repeated header rows when stitching"
```

---

### Task 4: `Document.GetTables` wrapper, exports, 2-page fixture, README

**Files:**
- Modify: `src/document.ts` (add `GetTables` method + imports)
- Modify: `src/index.ts` (export `stitchTables`, `TableStitchOptions`)
- Modify: `test/helpers/build-table-pdf.ts` (add a 2-page builder)
- Test: `test/table.test.ts` (integration through `Document.GetTables`)
- Modify: `README.md` (tables section + limitations)

**Interfaces:**
- Consumes: `stitchTables`, `TableStitchOptions` from `./tablestitch.js`;
  `Table`, `TableExtractOptions` (already imported in the table modules).
- Produces:
  - `Document.GetTables(options?: TableExtractOptions & TableStitchOptions): Table[]`
  - `buildTwoPageTablePdf(stream0: string, stream1: string): Uint8Array` in the test helper.

- [ ] **Step 1: Add the 2-page fixture builder**

Append to `test/helpers/build-table-pdf.ts`:

```ts
/** Two pages, shared Helvetica font, MediaBox 0 0 300 300 each. */
export function buildTwoPageTablePdf(stream0: string, stream1: string): Uint8Array {
  const objs: Record<number, string> = {
    1: `<< /Type /Catalog /Pages 2 0 R >>`,
    2: `<< /Type /Pages /Count 2 /Kids [3 0 R 6 0 R] /MediaBox [0 0 300 300] >>`,
    3: `<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>`,
    4: `<< /Length ${byteLen(stream0)} >>\nstream\n${stream0}\nendstream`,
    5: `<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>`,
    6: `<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 5 0 R >> >> /Contents 7 0 R >>`,
    7: `<< /Length ${byteLen(stream1)} >>\nstream\n${stream1}\nendstream`,
  };
  let body = '%PDF-1.7\n%\xE2\xE3\xCF\xD3\n';
  const off: number[] = new Array(8).fill(0);
  for (let n = 1; n <= 7; n++) { off[n] = byteLen(body); body += `${n} 0 obj\n${objs[n]}\nendobj\n`; }
  const xo = byteLen(body);
  let xref = `xref\n0 8\n0000000000 65535 f \n`;
  for (let n = 1; n <= 7; n++) xref += `${String(off[n]).padStart(10, '0')} 00000 n \n`;
  return enc(body + xref + `trailer\n<< /Size 8 /Root 1 0 R >>\nstartxref\n${xo}\n%%EOF\n`);
}
```

- [ ] **Step 2: Write the failing integration test**

Add to `test/table.test.ts` (imports: extend the existing
`build-table-pdf.js` import to include `buildTwoPageTablePdf`):

```ts
describe('Document.GetTables — cross-page stitching', () => {
  it('stitches a ruled table continued on the next page', () => {
    // Same 2-column grid geometry on both pages (columns at x=50/100/150).
    const page0 =
      hline(50, 150, 250) + hline(50, 150, 210) + hline(50, 150, 170) +
      vline(50, 170, 250) + vline(100, 170, 250) + vline(150, 170, 250) +
      text(55, 235, 'Name') + text(105, 235, 'Qty') +
      text(55, 195, 'Apple') + text(105, 195, '3');
    const page1 =
      hline(50, 150, 250) + hline(50, 150, 210) + hline(50, 150, 170) +
      vline(50, 170, 250) + vline(100, 170, 250) + vline(150, 170, 250) +
      text(55, 235, 'Name') + text(105, 235, 'Qty') +   // repeated header
      text(55, 195, 'Pear') + text(105, 195, '5');
    const doc = Document.Open(buildTwoPageTablePdf(page0, page1));
    const tables = doc.GetTables();
    expect(tables).toHaveLength(1);
    expect(tables[0].rowCount).toBe(3);   // header + 2 data rows
    expect(tables[0].rows.map((r) => r.cells.map((c) => c.text).join('|')))
      .toEqual(['Name|Qty', 'Apple|3', 'Pear|5']);
    expect(tables[0].pageSpans).toHaveLength(2);
    // opt-out yields the two per-page tables
    expect(doc.GetTables({ stitch: false })).toHaveLength(2);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run test/table.test.ts`
Expected: FAIL — `doc.GetTables is not a function`.

- [ ] **Step 4: Implement `Document.GetTables` and exports**

In `src/document.ts`, add imports near the other table imports:

```ts
import { stitchTables, type TableStitchOptions } from './tablestitch.js';
import type { Table } from './tablemodel.js';
import type { TableExtractOptions } from './tablemodel.js';
```

Add the method to the `Document` class (place near other page-spanning
accessors):

```ts
  /** Extract tables from every page and stitch continuations across page
   *  boundaries into single logical tables. Pass `{ stitch: false }` for the
   *  flat per-page list. See `Page.GetTables` for per-page extraction. */
  GetTables(options?: TableExtractOptions & TableStitchOptions): Table[] {
    return stitchTables(this.Pages.map((p) => p.GetTables(options)), options);
  }
```

(If `TableExtractOptions`/`Table` are already imported in `document.ts`, do not
duplicate the imports — reuse the existing ones.)

In `src/index.ts`, after the existing table exports:

```ts
export { stitchTables } from './tablestitch.js';
export type { TableStitchOptions } from './tablestitch.js';
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run test/table.test.ts`
Expected: PASS.

- [ ] **Step 6: Full suite + typecheck**

Run:
```bash
npm run typecheck
npx vitest run
```
Expected: all green.

- [ ] **Step 7: Update README**

In `README.md` tables feature bullet (~line 20) and API table (~line 670), add a
sentence for `doc.GetTables(options?)`: "extracts tables from every page and
stitches continuations across page boundaries into single logical tables
(`pageSpans` records the contributing page rectangles); pass `{ stitch: false }`
for the flat per-page list." In the limitations bullet (~line 712), update the
cross-page note: replace "Still out of scope: rotated/skewed and cross-page
tables." with "Cross-page tables are stitched by `doc.GetTables()` when the
continuation shares the same column count and aligned column positions (repeated
headers dropped); non-tail continuations, column-count changes across the break,
and spanning-cell reflow across the seam are not handled. Still out of scope:
rotated/skewed tables."

- [ ] **Step 8: Commit**

```bash
git add src/document.ts src/index.ts test/table.test.ts test/helpers/build-table-pdf.ts README.md
git commit -m "feat(7ac): Document.GetTables stitches cross-page tables"
```

---

## Self-review notes

- **Spec coverage:** pure `stitchTables` (T2) + `Document.GetTables` wrapper (T4)
  = "Both" API choice; signature match on colCount+aligned columns (T2);
  repeated-header drop (T3); `pageSpans` field (T1); `stitch:false` pass-through
  (T2); 3-page chain, colCount mismatch, misaligned, gap-page (T2);
  integration via real 2-page PDF (T4); README (T4). All spec sections covered.
- **Type consistency:** `stitchTables(perPage: Table[][], options?: TableStitchOptions): Table[]`
  and `Table.pageSpans?: { page: number; quad: Rect }[]` used identically across
  tasks. `emitChain`/`repeatsHeader`/`headerKey`/`columnBoundaries`/`signatureMatch`
  are file-private, defined before use.
- **Known limitation (documented, not a bug):** only chain tails extend, so a
  non-tail earlier-page table that is the true continuation is not stitched;
  a rowSpan header row that repeats is dropped by top row only (rare).

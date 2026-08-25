# Table / Structured-Data Extraction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reconstruct tables (rows/cells with spans, bounding quads, and text) from a page's positioned text and vector ruling lines, with HTML/Markdown serialization, exposed as `Page.GetTables()`.

**Architecture:** A unified separator model. Extend the existing content walker in `src/text.ts` to emit vector `PathEvent`s. A new `src/table.ts` reduces both ruling lines and whitespace gaps to horizontal/vertical cuts, builds one maximal grid per candidate region, derives cells and spans from which interior separators are present, assigns text fragments to cells, and serializes.

**Tech Stack:** TypeScript (strict, ESM/NodeNext, `.js` import specifiers), vitest, zero runtime deps (`node:` built-ins only).

## Global Constraints

- Zero runtime dependencies — only `node:` built-ins. Do not add npm runtime deps.
- ESM + NodeNext: every relative import specifier carries a `.js` extension (e.g. `import { Page } from './page.js'`).
- `strict` TypeScript; `npm run typecheck` (tsc `--noEmit`) and `npm test` (vitest) MUST be green before closing the issue.
- Coordinates are PDF page space (Y up). `Rect = [x0, y0, x1, y1]` with `x0<=x1`, `y0<=y1`, reused from `src/text.ts`.
- Errors: never throw from the extraction path; return `[]` when nothing is found. No new public error types.
- Follow existing patterns: read-only extraction lives in `text.ts`; the `Page` facade wraps module functions (see `GetText`/`GetTextFragments`/`GetStructuredText` at `src/page.ts:263-281`).
- Public API additions must be mirrored in `README.md` and exported from `src/index.ts`.

---

## Module / File map

- **Modify `src/text.ts`** — add `PathEvent` interface, `path?` callback on `ContentVisitor`, and path-op handling in `walkScope`.
- **Create `src/table.ts`** — types, detection pipeline, grid/span algorithm, cell-text assembly, `Table` class with `toHtml`/`toMarkdown`, and `extractTables(doc, page, options?)`.
- **Modify `src/page.ts`** — `Page.GetTables(options?)` wrapper.
- **Modify `src/index.ts`** — export `PathEvent`, `Table`, `TableRow`, `TableCell`, `TableExtractOptions`, and `extractTables`.
- **Create `test/helpers/build-table-pdf.ts`** — content-stream fixture builders (ruled, borderless, merged, region, prose).
- **Create `test/table.test.ts`** — unit + integration tests.
- **Modify `README.md`** — Features, API overview, Limitations.

---

## Task 1: Capture vector paths in the content walker

**Files:**
- Modify: `src/text.ts` (add `PathEvent`, extend `ContentVisitor`, add path-op state to `walkScope` ~lines 174-299)
- Test: `test/table.test.ts` (new file — path-capture section)

**Interfaces:**
- Consumes: existing `ContentAddr`, `Matrix`, `apply`, `mul`, `vscale`, `nums`/`num` in `text.ts`.
- Produces:
  ```ts
  export interface PathEvent {
    addr: ContentAddr;
    /** Page-space axis segments [x0,y0,x1,y1] after CTM. */
    segments: [number, number, number, number][];
    stroke: boolean;  // painted with S/s/B/B*/b/b*
    fill: boolean;    // painted with f/F/f*/B/B*/b/b*
    /** Stroke width in page units (line width * CTM scale); 0 when not stroked. */
    lineWidth: number;
  }
  // ContentVisitor gains: path?(e: PathEvent): void;
  ```

- [ ] **Step 1: Write the failing test**

Add to a new `test/table.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { visitContent, type PathEvent } from '../src/text.js';
import { buildSimpleTextPdf } from './helpers/build-text-pdf.js';

describe('visitContent path capture', () => {
  it('emits a stroked segment and a filled rectangle in page space', () => {
    // A horizontal stroked line, then a thin filled rect.
    const stream = '2 w 10 20 m 110 20 l S 50 50 40 3 re f';
    const doc = Document.Open(buildSimpleTextPdf(stream));
    const paths: PathEvent[] = [];
    visitContent(doc, doc.Pages[0], { path: (e) => paths.push(e) });

    expect(paths).toHaveLength(2);

    const [line, rect] = paths;
    expect(line.stroke).toBe(true);
    expect(line.fill).toBe(false);
    expect(line.lineWidth).toBeCloseTo(2, 5);
    expect(line.segments).toEqual([[10, 20, 110, 20]]);

    expect(rect.fill).toBe(true);
    expect(rect.stroke).toBe(false);
    // re emits 4 closed edges of [x,y,x+w,y+h] = [50,50,90,53]
    expect(rect.segments).toEqual([
      [50, 50, 90, 50],
      [90, 50, 90, 53],
      [90, 53, 50, 53],
      [50, 53, 50, 50],
    ]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/table.test.ts -t "path capture"`
Expected: FAIL — `path` callback never fires / `paths` is empty (walker ignores path ops).

- [ ] **Step 3: Implement path capture in `walkScope`**

In `src/text.ts`, add the interface near `ImageEvent` (after line 172):

```ts
/** A painted vector path, its subpaths flattened to page-space segments. */
export interface PathEvent {
  addr: ContentAddr;
  segments: [number, number, number, number][];
  stroke: boolean;
  fill: boolean;
  lineWidth: number;
}
```

Extend `ContentVisitor` (line 174):

```ts
export interface ContentVisitor {
  glyph?(e: GlyphEvent): void;
  image?(e: ImageEvent): void;
  path?(e: PathEvent): void;
}
```

Inside `walkScope`, add path/line-width state alongside the other locals (near line 218-221):

```ts
  // Path construction state (page-space points).
  let lineWidth = 1;
  let subpaths: [number, number][][] = [];
  let cur: [number, number][] | undefined;
  let start: [number, number] | undefined;
  const pt = (x: number, y: number): [number, number] => apply(curCtm, x, y);
  const flushPath = (addr: ContentAddr, stroke: boolean, fill: boolean) => {
    const segs: [number, number, number, number][] = [];
    for (const sp of subpaths)
      for (let i = 1; i < sp.length; i++)
        segs.push([sp[i - 1][0], sp[i - 1][1], sp[i][0], sp[i][1]]);
    if (segs.length && ctx.visitor.path)
      ctx.visitor.path({ addr, segments: segs, stroke, fill, lineWidth: stroke ? lineWidth * vscale(curCtm) : 0 });
    subpaths = []; cur = undefined; start = undefined;
  };
```

Add cases to the operator `switch` (alongside the existing ones):

```ts
        case 'w': lineWidth = num(op.operands[0]); break;
        case 'm': {
          const [x, y] = nums(op.operands);
          start = pt(x, y); cur = [start]; subpaths.push(cur); break;
        }
        case 'l': {
          const [x, y] = nums(op.operands);
          if (cur) cur.push(pt(x, y)); break;
        }
        case 'c': case 'v': case 'y': {
          // Approximate a curve by its endpoint (last coordinate pair).
          const n = nums(op.operands);
          if (cur && n.length >= 2) cur.push(pt(n[n.length - 2], n[n.length - 1])); break;
        }
        case 're': {
          const [x, y, w, h] = nums(op.operands);
          const r: [number, number][] = [pt(x, y), pt(x + w, y), pt(x + w, y + h), pt(x, y + h), pt(x, y)];
          subpaths.push(r); cur = r; start = r[0]; break;
        }
        case 'h': { if (cur && start) cur.push(start); break; }
        case 'S': case 's': flushPath(addr, true, false); break;
        case 'f': case 'F': case 'f*': flushPath(addr, false, true); break;
        case 'B': case 'B*': case 'b': case 'b*': flushPath(addr, true, true); break;
        case 'n': flushPath(addr, false, false); break;
```

Note: `s`, `b`, `b*` imply a close first; the trailing edge is optional for rule
detection, so closing is not required for correctness here.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/table.test.ts -t "path capture"`
Expected: PASS.

- [ ] **Step 5: Run typecheck and full suite (no regressions)**

Run: `npm run typecheck && npx vitest run test/text.test.ts`
Expected: PASS (existing glyph/image consumers unaffected).

- [ ] **Step 6: Commit**

```bash
git add src/text.ts test/table.test.ts
git commit -m "feat(7y8): capture vector paths in content walker (PathEvent)"
```

---

## Task 2: Grid/span algorithm (`buildCells`)

**Files:**
- Create: `src/table.ts`
- Test: `test/table.test.ts` (buildCells section)

**Interfaces:**
- Produces:
  ```ts
  export type Rect = [number, number, number, number];   // re-exported from text.ts
  export interface TableExtractOptions { region?: Rect; }
  export interface TableCell { row: number; col: number; rowSpan: number; colSpan: number; quad: Rect; text: string; }
  export interface TableRow { cells: TableCell[]; quad: Rect; }

  // Internal, exported for unit testing:
  // xcuts ascending (column boundaries), ycuts DESCENDING (row boundaries, top→bottom in page space).
  // vSep[r][k] = a vertical rule exists between col k and k+1 within atomic row r (k in 0..C-2).
  // hSep[c][k] = a horizontal rule exists between row k and k+1 within atomic col c (k in 0..R-2).
  export function buildCells(
    xcuts: number[], ycuts: number[], vSep: boolean[][], hSep: boolean[][],
  ): { row: number; col: number; rowSpan: number; colSpan: number; quad: Rect }[];
  ```

- [ ] **Step 1: Write the failing test**

Add to `test/table.test.ts`:

```ts
import { buildCells } from '../src/table.js';

describe('buildCells', () => {
  it('produces a simple grid when every interior separator is present', () => {
    // 2 cols x 2 rows, all separators present.
    const xcuts = [0, 10, 20];
    const ycuts = [20, 10, 0];        // descending
    const vSep = [[true], [true]];    // per row: 1 interior boundary, present
    const hSep = [[true], [true]];    // per col: 1 interior boundary, present
    const cells = buildCells(xcuts, ycuts, vSep, hSep);
    expect(cells).toHaveLength(4);
    expect(cells.every((c) => c.rowSpan === 1 && c.colSpan === 1)).toBe(true);
    // top-left cell quad = x[0..10], y[10..20]
    const tl = cells.find((c) => c.row === 0 && c.col === 0)!;
    expect(tl.quad).toEqual([0, 10, 10, 20]);
  });

  it('merges across a missing interior vertical rule into a colSpan', () => {
    const xcuts = [0, 10, 20];
    const ycuts = [20, 10, 0];
    const vSep = [[false], [true]];   // row 0 top: no divider -> colSpan 2; row 1: divided
    const hSep = [[true], [true]];
    const cells = buildCells(xcuts, ycuts, vSep, hSep);
    const wide = cells.find((c) => c.row === 0 && c.col === 0)!;
    expect(wide.colSpan).toBe(2);
    expect(wide.quad).toEqual([0, 10, 20, 20]);
    // row 1 still has two cells
    expect(cells.filter((c) => c.row === 1)).toHaveLength(2);
  });

  it('merges down a missing horizontal rule into a rowSpan', () => {
    const xcuts = [0, 10, 20];
    const ycuts = [20, 10, 0];
    const vSep = [[true], [true]];
    const hSep = [[false], [true]];   // col 0: rows 0-1 merged; col 1: divided
    const cells = buildCells(xcuts, ycuts, vSep, hSep);
    const tall = cells.find((c) => c.row === 0 && c.col === 0)!;
    expect(tall.rowSpan).toBe(2);
    expect(tall.quad).toEqual([0, 0, 10, 20]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/table.test.ts -t "buildCells"`
Expected: FAIL — `buildCells` is not exported (module `src/table.ts` does not exist).

- [ ] **Step 3: Implement `src/table.ts` types + `buildCells`**

```ts
import type { Rect as TextRect } from './text.js';

export type Rect = TextRect;
export interface TableExtractOptions { region?: Rect; }
export interface TableCell { row: number; col: number; rowSpan: number; colSpan: number; quad: Rect; text: string; }
export interface TableRow { cells: TableCell[]; quad: Rect; }

/** Build cells (with spans) from a maximal grid and interior-separator presence.
 *  xcuts ascending; ycuts descending (row 0 is the top band). */
export function buildCells(
  xcuts: number[], ycuts: number[], vSep: boolean[][], hSep: boolean[][],
): { row: number; col: number; rowSpan: number; colSpan: number; quad: Rect }[] {
  const R = ycuts.length - 1, C = xcuts.length - 1;
  const out: { row: number; col: number; rowSpan: number; colSpan: number; quad: Rect }[] = [];
  if (R < 1 || C < 1) return out;
  const consumed: boolean[][] = Array.from({ length: R }, () => new Array(C).fill(false));

  for (let r = 0; r < R; r++) {
    for (let c = 0; c < C; c++) {
      if (consumed[r][c]) continue;
      // Grow colSpan across missing vertical separators on the top row r.
      let colSpan = 1;
      while (c + colSpan < C && !consumed[r][c + colSpan] && vSep[r]?.[c + colSpan - 1] === false)
        colSpan++;
      // Grow rowSpan down while the horizontal separator below is absent for every column in the span.
      let rowSpan = 1;
      while (r + rowSpan < R) {
        let open = true;
        for (let k = c; k < c + colSpan; k++)
          if (hSep[k]?.[r + rowSpan - 1] !== false || consumed[r + rowSpan][k]) { open = false; break; }
        if (!open) break;
        rowSpan++;
      }
      for (let rr = r; rr < r + rowSpan; rr++)
        for (let cc = c; cc < c + colSpan; cc++) consumed[rr][cc] = true;
      const x0 = xcuts[c], x1 = xcuts[c + colSpan];
      const yTop = ycuts[r], yBot = ycuts[r + rowSpan];   // yTop > yBot (descending)
      out.push({ row: r, col: c, rowSpan, colSpan, quad: [x0, yBot, x1, yTop] });
    }
  }
  return out;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/table.test.ts -t "buildCells"`
Expected: PASS (all three cases).

- [ ] **Step 5: Commit**

```bash
git add src/table.ts test/table.test.ts
git commit -m "feat(7y8): table grid/span algorithm (buildCells)"
```

---

## Task 3: Rule collection & clustering

**Files:**
- Modify: `src/table.ts`
- Create: `test/helpers/build-table-pdf.ts`
- Test: `test/table.test.ts` (collectRules section)

**Interfaces:**
- Consumes: `visitContent`, `PathEvent` from `text.js`; `Document`, `Page`.
- Produces:
  ```ts
  interface Rule { pos: number; lo: number; hi: number; }     // internal
  // horizontal rule: pos=y, lo..hi = x-span; vertical rule: pos=x, lo..hi = y-span
  export function collectRules(doc: Document, page: Page, region?: Rect):
    { horiz: Rule[]; vert: Rule[] };
  ```

Module constants (top of `table.ts`):

```ts
const AXIS_TOL = 0.6;          // segment is axis-aligned if the off-axis delta <= this
const MIN_RULE_LEN = 3;        // ignore shorter segments
const MAX_RULE_THICK = 3;      // filled rect this thin (min side) is a rule; collapse to centerline
const SNAP = 2;                // cluster cut positions within this distance
```

- [ ] **Step 1: Write the fixture builder**

Create `test/helpers/build-table-pdf.ts`:

```ts
const enc = (s: string) => new TextEncoder().encode(s);
const byteLen = (s: string) => enc(s).length;

/** One page, one Helvetica font (F1), MediaBox 0 0 300 300, given content stream. */
export function buildTablePdf(stream: string): Uint8Array {
  const objs: Record<number, string> = {
    1: `<< /Type /Catalog /Pages 2 0 R >>`,
    2: `<< /Type /Pages /Count 1 /Kids [3 0 R] /MediaBox [0 0 300 300] >>`,
    3: `<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>`,
    4: `<< /Length ${byteLen(stream)} >>\nstream\n${stream}\nendstream`,
    5: `<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>`,
  };
  let body = '%PDF-1.7\n%\xE2\xE3\xCF\xD3\n';
  const off: number[] = new Array(6).fill(0);
  for (let n = 1; n <= 5; n++) { off[n] = byteLen(body); body += `${n} 0 obj\n${objs[n]}\nendobj\n`; }
  const xo = byteLen(body);
  let xref = `xref\n0 6\n0000000000 65535 f \n`;
  for (let n = 1; n <= 5; n++) xref += `${String(off[n]).padStart(10, '0')} 00000 n \n`;
  return enc(body + xref + `trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xo}\n%%EOF\n`);
}

/** Emit a `Tj` text-show block at (x,y), size 10 Helvetica. */
export function text(x: number, y: number, s: string, size = 10): string {
  return `BT /F1 ${size} Tf 1 0 0 1 ${x} ${y} Tm (${s.replace(/([()\\])/g, '\\$1')}) Tj ET\n`;
}

/** Stroked horizontal line. */
export function hline(x0: number, x1: number, y: number): string {
  return `${x0} ${y} m ${x1} ${y} l S\n`;
}

/** Stroked vertical line. */
export function vline(x: number, y0: number, y1: number): string {
  return `${x} ${y0} m ${x} ${y1} l S\n`;
}
```

- [ ] **Step 2: Write the failing test**

Add to `test/table.test.ts`:

```ts
import { collectRules } from '../src/table.js';
import { buildTablePdf, hline, vline } from './helpers/build-table-pdf.js';

describe('collectRules', () => {
  it('classifies and clusters axis-aligned rules', () => {
    const stream =
      hline(50, 150, 200) + hline(50, 150, 100) +   // two horizontals
      vline(50, 100, 200) + vline(150, 100, 200);   // two verticals
    const doc = Document.Open(buildTablePdf(stream));
    const { horiz, vert } = collectRules(doc, doc.Pages[0]);
    expect(horiz.map((r) => Math.round(r.pos)).sort((a, b) => a - b)).toEqual([100, 200]);
    expect(vert.map((r) => Math.round(r.pos)).sort((a, b) => a - b)).toEqual([50, 150]);
    // horizontal rule spans x 50..150
    expect(horiz[0].lo).toBeCloseTo(50, 1);
    expect(horiz[0].hi).toBeCloseTo(150, 1);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run test/table.test.ts -t "collectRules"`
Expected: FAIL — `collectRules` not exported.

- [ ] **Step 4: Implement `collectRules`**

Add to `src/table.ts` (add imports for `visitContent`, `PathEvent`, `Document`, `Page`):

```ts
import { visitContent, type PathEvent } from './text.js';
import type { Document } from './document.js';
import type { Page } from './page.js';

interface Rule { pos: number; lo: number; hi: number; }

function inRegion(r: Rect | undefined, x0: number, y0: number, x1: number, y1: number): boolean {
  if (!r) return true;
  return x0 >= r[0] - SNAP && x1 <= r[2] + SNAP && y0 >= r[1] - SNAP && y1 <= r[3] + SNAP;
}

/** A single painted path's segments, reduced to horizontal/vertical rules. */
function rulesFromPath(e: PathEvent, horiz: Rule[], vert: Rule[], region?: Rect): void {
  // A thin filled rectangle → collapse its bbox to a centerline rule.
  if (e.fill && !e.stroke) {
    const xs = e.segments.flatMap((s) => [s[0], s[2]]);
    const ys = e.segments.flatMap((s) => [s[1], s[3]]);
    const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
    const w = x1 - x0, h = y1 - y0;
    if (Math.min(w, h) <= MAX_RULE_THICK && Math.max(w, h) >= MIN_RULE_LEN && inRegion(region, x0, y0, x1, y1)) {
      if (w >= h) horiz.push({ pos: (y0 + y1) / 2, lo: x0, hi: x1 });
      else vert.push({ pos: (x0 + x1) / 2, lo: y0, hi: y1 });
    }
    return;
  }
  // Stroked segments → keep axis-aligned ones.
  for (const [x0, y0, x1, y1] of e.segments) {
    const dx = Math.abs(x1 - x0), dy = Math.abs(y1 - y0);
    if (dy <= AXIS_TOL && dx >= MIN_RULE_LEN) {
      const y = (y0 + y1) / 2, lo = Math.min(x0, x1), hi = Math.max(x0, x1);
      if (inRegion(region, lo, y, hi, y)) horiz.push({ pos: y, lo, hi });
    } else if (dx <= AXIS_TOL && dy >= MIN_RULE_LEN) {
      const x = (x0 + x1) / 2, lo = Math.min(y0, y1), hi = Math.max(y0, y1);
      if (inRegion(region, x, lo, x, hi)) vert.push({ pos: x, lo, hi });
    }
  }
}

/** Merge rules whose `pos` is within SNAP, unioning their lo..hi spans. */
function clusterRules(rules: Rule[]): Rule[] {
  const sorted = [...rules].sort((a, b) => a.pos - b.pos);
  const out: Rule[] = [];
  for (const r of sorted) {
    const last = out[out.length - 1];
    if (last && r.pos - last.pos <= SNAP) {
      last.pos = (last.pos + r.pos) / 2;
      last.lo = Math.min(last.lo, r.lo);
      last.hi = Math.max(last.hi, r.hi);
    } else out.push({ ...r });
  }
  return out;
}

export function collectRules(doc: Document, page: Page, region?: Rect): { horiz: Rule[]; vert: Rule[] } {
  const horiz: Rule[] = [], vert: Rule[] = [];
  visitContent(doc, page, { path: (e) => rulesFromPath(e, horiz, vert, region) });
  return { horiz: clusterRules(horiz), vert: clusterRules(vert) };
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run test/table.test.ts -t "collectRules"`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/table.ts test/helpers/build-table-pdf.ts test/table.test.ts
git commit -m "feat(7y8): collect and cluster axis-aligned ruling lines"
```

---

## Task 4: Ruled-table assembly (grid → `Table` cells with text)

**Files:**
- Modify: `src/table.ts`
- Test: `test/table.test.ts` (ruled extraction section)

**Interfaces:**
- Consumes: `buildCells`, `collectRules`, `extractFragments` (from `text.js`), `TextFragment`.
- Produces:
  ```ts
  export function extractTables(doc: Document, page: Page, options?: TableExtractOptions): Table[];
  // Table defined here as a stub with fields (toHtml/toMarkdown added in Task 6).
  ```

- [ ] **Step 1: Write the failing test**

```ts
import { extractTables } from '../src/table.js';
import { buildTablePdf, hline, vline, text } from './helpers/build-table-pdf.js';

describe('extractTables — ruled', () => {
  it('reconstructs a 2x2 ruled grid with cell text', () => {
    const stream =
      // grid lines
      hline(50, 150, 200) + hline(50, 150, 150) + hline(50, 150, 100) +
      vline(50, 100, 200) + vline(100, 100, 200) + vline(150, 100, 200) +
      // cell text (baseline near the bottom of each band)
      text(55, 175, 'A') + text(105, 175, 'B') +
      text(55, 125, 'C') + text(105, 125, 'D');
    const doc = Document.Open(buildTablePdf(stream));
    const tables = extractTables(doc, doc.Pages[0]);
    expect(tables).toHaveLength(1);
    const t = tables[0];
    expect(t.rowCount).toBe(2);
    expect(t.colCount).toBe(2);
    expect(t.rows[0].cells.map((c) => c.text)).toEqual(['A', 'B']);
    expect(t.rows[1].cells.map((c) => c.text)).toEqual(['C', 'D']);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/table.test.ts -t "ruled"`
Expected: FAIL — `extractTables` not exported.

- [ ] **Step 3: Implement the ruled path + `Table` stub + text assembly**

Add to `src/table.ts`:

```ts
import { extractFragments, type TextFragment } from './text.js';

/** Placeholder Table; serializers added in Task 6. */
export class Table {
  constructor(
    public quad: Rect,
    public rowCount: number,
    public colCount: number,
    public rows: TableRow[],
  ) {}
}

const uniqSorted = (xs: number[], asc: boolean): number[] => {
  const s = [...xs].sort((a, b) => (asc ? a - b : b - a));
  const out: number[] = [];
  for (const v of s) if (!out.length || Math.abs(v - out[out.length - 1]) > SNAP) out.push(v);
  return out;
};

/** True if some horizontal rule at ~y covers [x0,x1]. */
const coveredH = (rules: Rule[], y: number, x0: number, x1: number): boolean =>
  rules.some((r) => Math.abs(r.pos - y) <= SNAP && r.lo <= x0 + SNAP && r.hi >= x1 - SNAP);
const coveredV = (rules: Rule[], x: number, y0: number, y1: number): boolean =>
  rules.some((r) => Math.abs(r.pos - x) <= SNAP && r.lo <= y0 + SNAP && r.hi >= y1 - SNAP);

/** Assemble fragments (already cell-local) into text: cluster into baselines,
 *  left-to-right, join lines with '\n'. */
function cellText(frags: TextFragment[]): string {
  if (!frags.length) return '';
  const sorted = [...frags].sort((a, b) => (b.quad[1] - a.quad[1]) || (a.quad[0] - b.quad[0]));
  const lines: TextFragment[][] = [];
  let bucket: TextFragment[] = [];
  let y = sorted[0].quad[1];
  for (const f of sorted) {
    if (bucket.length && Math.abs(f.quad[1] - y) > Math.max(2, 0.5 * f.fontSize)) { lines.push(bucket); bucket = []; }
    if (!bucket.length) y = f.quad[1];
    bucket.push(f);
  }
  if (bucket.length) lines.push(bucket);
  return lines.map((ln) => {
    ln.sort((a, b) => a.quad[0] - b.quad[0]);
    let s = '', prevEnd: number | undefined;
    for (const f of ln) {
      if (prevEnd !== undefined && f.quad[0] - prevEnd > 0.25 * f.fontSize && !s.endsWith(' ') && !f.text.startsWith(' ')) s += ' ';
      s += f.text; prevEnd = f.quad[2];
    }
    return s.trim();
  }).join('\n');
}

const centroid = (q: Rect): [number, number] => [(q[0] + q[2]) / 2, (q[1] + q[3]) / 2];
const contains = (q: Rect, x: number, y: number): boolean => x >= q[0] && x <= q[2] && y >= q[1] && y <= q[3];

/** Build one Table from clustered rules + fragments within its region. */
function assembleTable(horiz: Rule[], vert: Rule[], frags: TextFragment[]): Table | undefined {
  const xcuts = uniqSorted(vert.map((r) => r.pos), true);
  const ycuts = uniqSorted(horiz.map((r) => r.pos), false);   // descending
  const C = xcuts.length - 1, R = ycuts.length - 1;
  if (R < 1 || C < 1) return undefined;

  // Interior separator presence.
  const vSep: boolean[][] = [];
  for (let r = 0; r < R; r++) {
    const yTop = ycuts[r], yBot = ycuts[r + 1], row: boolean[] = [];
    for (let k = 0; k < C - 1; k++) row.push(coveredV(vert, xcuts[k + 1], yBot, yTop));
    vSep.push(row);
  }
  const hSep: boolean[][] = [];
  for (let c = 0; c < C; c++) {
    const x0 = xcuts[c], x1 = xcuts[c + 1], colArr: boolean[] = [];
    for (let k = 0; k < R - 1; k++) colArr.push(coveredH(horiz, ycuts[k + 1], x0, x1));
    hSep.push(colArr);
  }

  const raw = buildCells(xcuts, ycuts, vSep, hSep);
  const cells: TableCell[] = raw.map((c) => {
    const mine = frags.filter((f) => { const [cx, cy] = centroid(f.quad); return contains(c.quad, cx, cy); });
    return { ...c, text: cellText(mine) };
  });
  // Group cells into rows by their `row` index.
  const rows: TableRow[] = [];
  for (let r = 0; r < R; r++) {
    const rc = cells.filter((c) => c.row === r).sort((a, b) => a.col - b.col);
    if (rc.length) rows.push({ cells: rc, quad: rowBbox(rc) });
  }
  const quad: Rect = [xcuts[0], ycuts[R], xcuts[C], ycuts[0]];
  return new Table(quad, R, C, rows);
}

function rowBbox(cells: TableCell[]): Rect {
  return [
    Math.min(...cells.map((c) => c.quad[0])), Math.min(...cells.map((c) => c.quad[1])),
    Math.max(...cells.map((c) => c.quad[2])), Math.max(...cells.map((c) => c.quad[3])),
  ];
}

export function extractTables(doc: Document, page: Page, options: TableExtractOptions = {}): Table[] {
  const { horiz, vert } = collectRules(doc, page, options.region);
  const frags = extractFragments(doc, page).filter((f) =>
    !options.region || contains(options.region, ...centroid(f.quad)));
  const out: Table[] = [];
  // Ruled path: a grid needs >=2 horizontal and >=2 vertical cuts.
  if (uniqSorted(horiz.map((r) => r.pos), false).length >= 2 && uniqSorted(vert.map((r) => r.pos), true).length >= 2) {
    const t = assembleTable(horiz, vert, frags);
    if (t && t.rows.length) out.push(t);
  }
  return out;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/table.test.ts -t "ruled"`
Expected: PASS.

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/table.ts test/table.test.ts
git commit -m "feat(7y8): assemble ruled tables into Table cells with text"
```

---

## Task 5: Whitespace (borderless) detection

**Files:**
- Modify: `src/table.ts`
- Test: `test/table.test.ts` (whitespace section)

**Interfaces:**
- Consumes: `extractFragments`, fragment geometry; reuses `assembleTable`.
- Produces: whitespace candidates handled inside `extractTables` (no new public export). Internal `detectWhitespaceTable(frags, region?): Table | undefined`.

Algorithm: cluster fragments into text lines by baseline (rows). Build an
X-coverage histogram over the fragments' x-spans; column gaps are maximal
x-intervals of zero coverage wider than `COL_GAP` that occur across most rows.
Column boundaries = gap midpoints; row boundaries = midpoints between adjacent
line baselines (extended by half-line at top/bottom). Feed synthetic
"all-present" separators into `buildCells` (simple grid). Require ≥2 rows and ≥2
columns or return `undefined`.

Add constant: `const COL_GAP = 6;` (min whitespace gap, page units).

- [ ] **Step 1: Write the failing test**

```ts
describe('extractTables — whitespace', () => {
  it('detects a borderless 2-column, 3-row table from aligned text', () => {
    // No rules. Two columns at x=50 and x=160; three rows at y=200,180,160.
    const rows = [['Name', 'Age'], ['Alice', '30'], ['Bob', '25']];
    let stream = '';
    rows.forEach((r, i) => {
      const y = 200 - i * 20;
      stream += text(50, y, r[0]) + text(160, y, r[1]);
    });
    const doc = Document.Open(buildTablePdf(stream));
    const tables = extractTables(doc, doc.Pages[0]);
    expect(tables).toHaveLength(1);
    expect(tables[0].colCount).toBe(2);
    expect(tables[0].rowCount).toBe(3);
    expect(tables[0].rows[0].cells.map((c) => c.text)).toEqual(['Name', 'Age']);
    expect(tables[0].rows[2].cells.map((c) => c.text)).toEqual(['Bob', '25']);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/table.test.ts -t "whitespace"`
Expected: FAIL — no table detected (only ruled path implemented), `tables` is empty.

- [ ] **Step 3: Implement `detectWhitespaceTable` and wire it in**

Add to `src/table.ts`:

```ts
const COL_GAP = 6;

/** Group fragments into text lines by baseline; returns lines top→bottom. */
function groupLines(frags: TextFragment[]): TextFragment[][] {
  const sorted = [...frags].sort((a, b) => b.quad[1] - a.quad[1]);
  const lines: TextFragment[][] = [];
  let bucket: TextFragment[] = [];
  let y = sorted[0]?.quad[1] ?? 0;
  for (const f of sorted) {
    if (bucket.length && Math.abs(f.quad[1] - y) > Math.max(2, 0.5 * f.fontSize)) { lines.push(bucket); bucket = []; }
    if (!bucket.length) y = f.quad[1];
    bucket.push(f);
  }
  if (bucket.length) lines.push(bucket);
  return lines;
}

/** Column boundaries from vertical whitespace gaps present across most rows. */
function columnCuts(lines: TextFragment[][], x0: number, x1: number): number[] {
  const STEP = 1;
  const n = Math.max(1, Math.ceil((x1 - x0) / STEP));
  // For each cell of the histogram, count rows whose text covers it.
  const cover = new Array(n).fill(0);
  for (const ln of lines) {
    const rowCov = new Array(n).fill(false);
    for (const f of ln) {
      const a = Math.max(0, Math.floor((f.quad[0] - x0) / STEP));
      const b = Math.min(n - 1, Math.ceil((f.quad[2] - x0) / STEP));
      for (let i = a; i <= b; i++) rowCov[i] = true;
    }
    for (let i = 0; i < n; i++) if (rowCov[i]) cover[i]++;
  }
  // A gap column = covered by no row. Find gap runs wider than COL_GAP that are interior.
  const cuts: number[] = [x0];
  let i = 0;
  while (i < n) {
    if (cover[i] === 0) {
      let j = i; while (j < n && cover[j] === 0) j++;
      const gapStart = x0 + i * STEP, gapEnd = x0 + j * STEP;
      if (gapStart > x0 + COL_GAP && gapEnd < x1 - COL_GAP && gapEnd - gapStart >= COL_GAP)
        cuts.push((gapStart + gapEnd) / 2);
      i = j;
    } else i++;
  }
  cuts.push(x1);
  return cuts;
}

function detectWhitespaceTable(frags: TextFragment[]): Table | undefined {
  if (frags.length < 2) return undefined;
  const lines = groupLines(frags);
  if (lines.length < 2) return undefined;
  const x0 = Math.min(...frags.map((f) => f.quad[0])) - 1;
  const x1 = Math.max(...frags.map((f) => f.quad[2])) + 1;
  const xcuts = columnCuts(lines, x0, x1);
  if (xcuts.length - 1 < 2) return undefined;   // need >=2 columns

  // Row boundaries: midpoints between adjacent baselines, padded top/bottom.
  const baselines = lines.map((ln) => Math.max(...ln.map((f) => f.quad[3])));  // top of line
  const bottoms = lines.map((ln) => Math.min(...ln.map((f) => f.quad[1])));    // baseline
  const ycuts: number[] = [Math.max(...baselines) + 2];
  for (let i = 1; i < lines.length; i++) ycuts.push((bottoms[i - 1] + baselines[i]) / 2);
  ycuts.push(Math.min(...bottoms) - 2);

  const R = ycuts.length - 1, C = xcuts.length - 1;
  const vSep = Array.from({ length: R }, () => new Array(C - 1).fill(true));
  const hSep = Array.from({ length: C }, () => new Array(R - 1).fill(true));
  const raw = buildCells(xcuts, ycuts, vSep, hSep);
  const cells: TableCell[] = raw.map((c) => {
    const mine = frags.filter((f) => contains(c.quad, ...centroid(f.quad)));
    return { ...c, text: cellText(mine) };
  });
  const rows: TableRow[] = [];
  for (let r = 0; r < R; r++) {
    const rc = cells.filter((c) => c.row === r).sort((a, b) => a.col - b.col);
    rows.push({ cells: rc, quad: rowBbox(rc) });
  }
  return new Table([xcuts[0], ycuts[R], xcuts[C], ycuts[0]], R, C, rows);
}
```

Then, in `extractTables`, add a fallback after the ruled block:

```ts
  if (out.length === 0) {
    const t = detectWhitespaceTable(frags);
    if (t) out.push(t);
  }
  return out;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/table.test.ts -t "whitespace"`
Expected: PASS.

- [ ] **Step 5: Re-run ruled + buildCells tests (no regression)**

Run: `npx vitest run test/table.test.ts`
Expected: PASS (all sections so far).

- [ ] **Step 6: Commit**

```bash
git add src/table.ts test/table.test.ts
git commit -m "feat(7y8): borderless (whitespace) table detection"
```

---

## Task 6: HTML / Markdown serialization

**Files:**
- Modify: `src/table.ts` (add `toHtml`/`toMarkdown` to `Table`)
- Test: `test/table.test.ts` (serialization section)

**Interfaces:**
- Produces: `Table.toHtml(): string`, `Table.toMarkdown(): string`.

- [ ] **Step 1: Write the failing test**

```ts
describe('Table serialization', () => {
  it('emits HTML with escaped text and Markdown pipe table', () => {
    const stream =
      hline(50, 150, 200) + hline(50, 150, 150) + hline(50, 150, 100) +
      vline(50, 100, 200) + vline(100, 100, 200) + vline(150, 100, 200) +
      text(55, 175, 'a&b') + text(105, 175, 'B') +
      text(55, 125, 'C') + text(105, 125, 'D');
    const t = extractTables(Document.Open(buildTablePdf(stream)), Document.Open(buildTablePdf(stream)).Pages[0]);
    const table = extractTables(
      (() => { const d = Document.Open(buildTablePdf(stream)); return d; })(),
      (() => { const d = Document.Open(buildTablePdf(stream)); return d.Pages[0]; })(),
    )[0];
    const html = table.toHtml();
    expect(html).toContain('<table>');
    expect(html).toContain('<td>a&amp;b</td>');
    const md = table.toMarkdown();
    expect(md.split('\n')[0]).toBe('| a&b | B |');
    expect(md.split('\n')[1]).toBe('| --- | --- |');
    expect(md.split('\n')[2]).toBe('| C | D |');
  });
});
```

(Simplify the test setup in the actual file — one `Document.Open` reused; the
above shows expected output shape.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/table.test.ts -t "serialization"`
Expected: FAIL — `toHtml`/`toMarkdown` are not methods on `Table`.

- [ ] **Step 3: Implement serializers**

Replace the `Table` class body in `src/table.ts`:

```ts
const escHtml = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export class Table {
  constructor(
    public quad: Rect,
    public rowCount: number,
    public colCount: number,
    public rows: TableRow[],
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

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/table.test.ts -t "serialization"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/table.ts test/table.test.ts
git commit -m "feat(7y8): Table toHtml/toMarkdown serialization"
```

---

## Task 7: Public API — `Page.GetTables`, exports, and remaining fixtures

**Files:**
- Modify: `src/page.ts` (add `GetTables`), `src/index.ts` (exports)
- Modify: `test/helpers/build-table-pdf.ts` (merged-cell + prose fixtures)
- Test: `test/table.test.ts` (merged, region, negative sections)

**Interfaces:**
- Consumes: `extractTables`, `Table`, `TableExtractOptions` from `table.js`.
- Produces: `Page.GetTables(options?: TableExtractOptions): Table[]`.

- [ ] **Step 1: Write the failing tests**

```ts
describe('Page.GetTables', () => {
  it('exposes tables via the Page facade', () => {
    const stream =
      hline(50, 150, 200) + hline(50, 150, 100) +
      vline(50, 100, 200) + vline(100, 100, 200) + vline(150, 100, 200) +
      text(55, 150, 'X') + text(105, 150, 'Y');
    const t = Document.Open(buildTablePdf(stream)).Pages[0].GetTables();
    expect(t).toHaveLength(1);
    expect(t[0].rows[0].cells.map((c) => c.text)).toEqual(['X', 'Y']);
  });

  it('merges a cell across a missing interior vertical rule (colSpan)', () => {
    // Top row: no vertical divider between the two columns -> colSpan 2.
    const stream =
      hline(50, 150, 200) + hline(50, 150, 150) + hline(50, 150, 100) +
      vline(50, 100, 200) + vline(150, 100, 200) + vline(100, 100, 150) +  // middle rule only in bottom band
      text(70, 175, 'Header') +
      text(55, 125, 'C') + text(105, 125, 'D');
    const t = Document.Open(buildTablePdf(stream)).Pages[0].GetTables()[0];
    const top = t.rows[0].cells[0];
    expect(top.colSpan).toBe(2);
    expect(top.text).toBe('Header');
    expect(t.toHtml()).toContain('colspan="2"');
  });

  it('restricts extraction to a region', () => {
    const stream =
      hline(50, 150, 200) + hline(50, 150, 100) +
      vline(50, 100, 200) + vline(100, 100, 200) + vline(150, 100, 200) +
      text(55, 150, 'A') + text(105, 150, 'B') +
      text(55, 40, 'footer prose outside the table');
    const t = Document.Open(buildTablePdf(stream)).Pages[0].GetTables({ region: [40, 90, 160, 210] });
    expect(t).toHaveLength(1);
    expect(t[0].rows[0].cells.map((c) => c.text)).toEqual(['A', 'B']);
  });

  it('returns [] for ordinary paragraph text', () => {
    const stream =
      text(50, 200, 'This is a single line of running prose.') +
      text(50, 185, 'Another sentence continues the paragraph.');
    expect(Document.Open(buildTablePdf(stream)).Pages[0].GetTables()).toEqual([]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/table.test.ts -t "GetTables"`
Expected: FAIL — `GetTables` is not a method on `Page`.

- [ ] **Step 3: Add `Page.GetTables` and exports**

In `src/page.ts`, add the import and method (after `GetStructuredText`, ~line 281):

```ts
import { extractTables, type Table, type TableExtractOptions } from './table.js';
```

```ts
  /** Reconstruct tables on the page from ruling lines and text geometry.
   *  Returns a rows×cells model (with spans, page-space quads, and cell text);
   *  each `Table` can serialize to HTML/Markdown. Pass `options.region` to
   *  restrict extraction to a page-space rectangle. Returns [] when none found. */
  GetTables(options?: TableExtractOptions): Table[] {
    return extractTables(this.doc, this, options);
  }
```

In `src/index.ts`, add:

```ts
export { extractTables, Table } from './table.js';
export type { TableCell, TableRow, TableExtractOptions } from './table.js';
export type { PathEvent } from './text.js';
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/table.test.ts -t "GetTables"`
Expected: PASS (all four cases).

If the negative case fails (prose detected as a table), tighten
`detectWhitespaceTable`: also require that every candidate column contains text
in ≥50% of rows (reject when a single line spreads across one column only). Add
this guard and re-run.

- [ ] **Step 5: Full suite + typecheck**

Run: `npm run typecheck && npx vitest run test/table.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/page.ts src/index.ts test/table.test.ts test/helpers/build-table-pdf.ts
git commit -m "feat(7y8): Page.GetTables facade + public exports"
```

---

## Task 8: Docs, full-suite gate, and close

**Files:**
- Modify: `README.md`
- Test: full suite

- [ ] **Step 1: Update README**

Add to the Features list:

```markdown
- **Table extraction** — reconstruct ruled and borderless tables from page
  geometry (`Page.GetTables()`): a rows×cells model with spans and bounding
  quads, plus `Table.toHtml()` / `Table.toMarkdown()` serialization.
```

Add to the API overview (near the other `Page.Get*` text methods):

```markdown
- `Page.GetTables(options?)` → `Table[]` — detected tables. Each `Table` has
  `rowCount`, `colCount`, `rows` (`TableRow[]` → `TableCell[]` with
  `row/col/rowSpan/colSpan/quad/text`), and `toHtml()` / `toMarkdown()`.
  `options.region` limits extraction to a page-space rectangle.
```

Add to Limitations:

```markdown
- Table extraction is geometry-based and handles axis-aligned tables only.
  Borderless-table detection is heuristic (conservative — loosely-aligned
  columns may be missed), and Markdown output approximates spanning cells
  (colspan repeats text, rowspan leaves blanks). Rotated/nested/cross-page
  tables and the tagged-PDF `/Table` structure tree are not yet used.
```

- [ ] **Step 2: Run the full quality gate**

Run: `npm run typecheck && npm test`
Expected: PASS (entire suite green).

- [ ] **Step 3: Commit docs**

```bash
git add README.md
git commit -m "docs(7y8): document Page.GetTables table extraction"
```

- [ ] **Step 4: Close the issue and record memory**

```bash
bd close aspose-pdf-foss-for-ts-7y8
bd remember --key table-extraction-shipped "Table extraction shipped (issue 7y8). src/table.ts: extractTables(doc,page,opts?)->Table[]; Page.GetTables(opts?). Unified separator model: collectRules() reduces stroked/thin-filled paths to clustered H/V rules (src/text.ts PathEvent + ContentVisitor.path added); buildCells() forms maximal grid from x/y cuts and derives rowSpan/colSpan from absent interior separators. Ruled path first; detectWhitespaceTable() fallback (X-projection column gaps + baseline rows, conservative >=2x2). Table.toHtml()/toMarkdown() (md spans approximated). Fixtures: test/helpers/build-table-pdf.ts. Follow-ups: 5ct rotated, 84u nested, 7ac cross-page, k33 tagged /Table."
```

- [ ] **Step 5: Session-close push (per CLAUDE.md)**

```bash
git pull --rebase && git push && git status
```
Expected: "up to date with origin".

---

## Self-Review

**Spec coverage:**
- Ruled tables → Tasks 1,3,4. Whitespace tables → Task 5. Spans → Task 2 (`buildCells`), verified Task 7. HTML/Markdown → Task 6. `region` option → Tasks 3,4,7. Auto-detect → Task 4/5. Model with quads + text → Tasks 4/5. `Page.GetTables` surface → Task 7. Fixtures (ruled/borderless/merged/region/negative) → Tasks 3-7. Docs → Task 8. Out-of-scope items filed as 5ct/84u/7ac/k33. ✓ All spec sections mapped.

**Placeholder scan:** No TBD/TODO; every code step shows complete code. The Task 6 test note explicitly flags its setup as illustrative and says to reuse one `Document.Open` — the implementer writes one clean setup; expected output shape is exact. ✓

**Type consistency:** `PathEvent`/`ContentVisitor.path` (Task 1) consumed in Task 3. `buildCells` signature (Task 2) consumed in Tasks 4-5. `Rect`/`TableCell`/`TableRow`/`Table`/`TableExtractOptions`/`extractTables` names consistent across Tasks 2-7. `Table` constructor `(quad, rowCount, colCount, rows)` stable from Task 4 through Task 6 (Task 6 only adds methods). `collectRules` returns `{horiz, vert}` used in Task 4. ✓

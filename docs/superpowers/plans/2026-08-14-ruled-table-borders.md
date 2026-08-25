# Ruled Table Borders and Shading Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Recover per-cell borders and shading from a ruled table's ink and emit them in the DOCX and HTML exports, replacing the uniform single-line frame `8yt9.2` ships.

**Architecture:** A new pure module, `tableink.ts`, indexes a page's ink from `page.GetPaths()` — whose `PagePath` already carries `fill`/`stroke` colour and a CTM-scaled `lineWidth`, which `text.ts`'s `PathEvent` does not. `table.ts` decorates already-detected cells with it after `buildTables` returns, so the detector itself does not change and cannot regress. `TableCell` gains optional `borders`/`shading`; `docxtable.ts` and `Table.toHtml` read them, and fall back to today's output when they are absent.

**Tech Stack:** TypeScript (ESM, NodeNext, `strict`), vitest, `node:` built-ins only.

**Spec:** `docs/superpowers/specs/2026-08-14-ruled-table-borders-design.md`

## Global Constraints

- **Zero runtime dependencies** — only `node:` built-ins. Do not add npm runtime deps.
- **ESM + NodeNext:** every import specifier carries the `.js` extension.
- **Issue tracking is `bd`**, never TodoWrite or markdown TODO lists. This plan is `aspose-pdf-foss-for-ts-8yt9.3`.
- **Both gates green before any task is done:** `npm run typecheck` and `npm test`.
- **The absent-versus-measured-absent rule governs everything here.** `TableCell.borders` **absent** means *not recovered* — a tagged table, a rotated table, a page whose ink could not be read — and must render exactly as today. An edge **missing from a present `borders`** means *measured absent*: there is genuinely no rule there, and it must draw nothing. Collapsing the two is the mistake CLAUDE.md records for `parseSimpleWidths` and for `Table.toMarkdown`'s header handling.
- **Sequencing is load-bearing.** Tasks 1–5 must leave `test/html-identity.test.ts` and the Markdown snapshots **green** — that green is the evidence the model change moved nothing by accident. Only Task 6 changes HTML output, and its snapshot churn is intended. Do not combine them.
- **Prove assertions load-bearing.** A test passing first run is not evidence. Task 7 collects the mutations.
- **Word compatibility is not claimed.** No CI here opens Word.

Existing values this plan reuses rather than redefines, all currently private to `src/table.ts`:

```ts
const MIN_RULE_LEN = 3;        // ignore shorter segments
const MAX_RULE_THICK = 3;      // filled rect this thin (min side) is a rule
const SNAP = 2;                // cluster / match tolerance
```

---

## File Structure

| File | Responsibility |
|---|---|
| `src/tableink.ts` (new) | Pure ink index over `PagePath[]`: edges with width and colour, fills with rect and colour, and the two lookups |
| `src/tablemodel.ts` (modify) | `CellBorder`/`CellBorders` types, `TableCell.borders`/`.shading`, and `toHtml` emitting them (Task 6 only) |
| `src/table.ts` (modify) | Export the three constants; decorate axis-aligned tables after `buildTables` |
| `src/docxtable.ts` (modify) | Per-cell `w:tcBorders` and `w:shd`; omit `w:tblBorders` when recovered |
| `test/tableink.test.ts` (new) | The pure rules, from hand-built `PagePath[]` |
| `test/table-borders.test.ts` (new) | End-to-end recovery through real extraction |
| `test/docx-table.test.ts` (modify) | Both emission branches |

---

### Task 1: `tableink.ts` — collect edges and fills

**Files:**
- Create: `src/tableink.ts`
- Test: `test/tableink.test.ts` (new)

**Interfaces:**
- Consumes: `PagePath`, `PathPaint`, `PathSubpath`, `PathSegment` from `./paths.js`; `Rgb` from `./colorspace.js` (`[number, number, number]`, components 0..255 — `paths.ts` clamps them with `cl255`); `Rect` from `./tablemodel.js` (`[number, number, number, number]`); `Matrix` and its `apply` helper from `./text.js`.
- Produces:
  ```ts
  export interface InkEdge { pos: number; lo: number; hi: number; width: number; color: Rgb }
  export interface InkFill { rect: Rect; color: Rgb }
  export interface PageInk { horiz: InkEdge[]; vert: InkEdge[]; fills: InkFill[] }
  export function collectPageInk(paths: PagePath[], minLen: number, maxThick: number): PageInk;
  ```

Note `PagePath.bbox` is already device space and `lineWidth` is already CTM-scaled (`paths.ts:170,174`), but `subpaths` are in USER space — a stroked grid drawn as one path has a single bbox covering the whole table, so stroked edges must come from the subpaths transformed through `path.ctm`.

- [ ] **Step 1: Write the failing test**

Create `test/tableink.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { collectPageInk } from '../src/tableink.js';
import type { PagePath } from '../src/paths.js';
import type { Rgb } from '../src/colorspace.js';

const IDENTITY: [number, number, number, number, number, number] = [1, 0, 0, 1, 0, 0];
const BLACK: Rgb = [0, 0, 0];
const GREY: Rgb = [238, 238, 238];

/** A stroked path of axis-aligned lines, in user space, under `ctm`. */
function stroked(
  lines: [number, number, number, number][], width: number, rgb: Rgb,
  ctm = IDENTITY,
): PagePath {
  return {
    subpaths: lines.map(([x0, y0, x1, y1]) => ({
      closed: false,
      segments: [
        { op: 'move' as const, pt: [x0, y0] as [number, number] },
        { op: 'line' as const, pt: [x1, y1] as [number, number] },
      ],
    })),
    ctm,
    bbox: [0, 0, 0, 0],          // deliberately wrong: strokes must not read it
    fill: null,
    stroke: { rgb, space: 'DeviceRGB' },
    fillRule: null,
    lineWidth: width,
    clip: null,
    addr: { stream: 0, op: 0 } as PagePath['addr'],
  };
}

/** A filled rectangle, given directly in device space via its bbox. */
function filled(rect: [number, number, number, number], rgb: Rgb): PagePath {
  const [x0, y0, x1, y1] = rect;
  return {
    subpaths: [{
      closed: true,
      segments: [
        { op: 'move' as const, pt: [x0, y0] as [number, number] },
        { op: 'line' as const, pt: [x1, y0] as [number, number] },
        { op: 'line' as const, pt: [x1, y1] as [number, number] },
        { op: 'line' as const, pt: [x0, y1] as [number, number] },
      ],
    }],
    ctm: IDENTITY,
    bbox: rect,
    fill: { rgb, space: 'DeviceRGB' },
    stroke: null,
    fillRule: 'nonzero',
    lineWidth: 0,
    clip: null,
    addr: { stream: 0, op: 0 } as PagePath['addr'],
  };
}

const ink = (paths: PagePath[]) => collectPageInk(paths, 3, 3);

describe('collectPageInk strokes', () => {
  // A grid drawn as ONE stroked path has a single bbox covering the whole
  // table, so an implementation reading bbox produces one giant edge instead
  // of four. The fixtures above set bbox to [0,0,0,0] to make that fail loudly.
  it('takes a stroked edge per segment, not from the path bbox', () => {
    const i = ink([stroked([[10, 100, 200, 100], [10, 50, 200, 50]], 1, BLACK)]);
    expect(i.horiz.map((e) => e.pos)).toEqual([100, 50]);
    expect(i.horiz.every((e) => e.lo === 10 && e.hi === 200)).toBe(true);
    expect(i.vert).toEqual([]);
  });

  it('carries the stroke width and colour', () => {
    const [e] = ink([stroked([[10, 100, 200, 100]], 1.5, [51, 51, 51])]).horiz;
    expect(e.width).toBe(1.5);
    expect(e.color).toEqual([51, 51, 51]);
  });

  it('splits horizontal from vertical', () => {
    const i = ink([stroked([[10, 100, 200, 100], [10, 20, 10, 100]], 1, BLACK)]);
    expect(i.horiz.length).toBe(1);
    expect(i.vert.length).toBe(1);
    expect(i.vert[0]).toMatchObject({ pos: 10, lo: 20, hi: 100 });
  });

  it('transforms subpaths through the ctm', () => {
    // Scale x2, translate +5 in y: user (10,50)-(60,50) becomes (20,105)-(120,105).
    const i = ink([stroked([[10, 50, 60, 50]], 1, BLACK, [2, 0, 0, 2, 0, 5])]);
    expect(i.horiz[0]).toMatchObject({ pos: 105, lo: 20, hi: 120 });
  });

  it('ignores a segment shorter than minLen', () => {
    expect(ink([stroked([[10, 100, 12, 100]], 1, BLACK)]).horiz).toEqual([]);
  });

  it('ignores a diagonal', () => {
    const i = ink([stroked([[10, 10, 200, 200]], 1, BLACK)]);
    expect(i.horiz).toEqual([]);
    expect(i.vert).toEqual([]);
  });
});

describe('collectPageInk fills', () => {
  // The same split rulesFromPath makes: thin means a rule, fat means shading.
  it('collapses a thin fill to a centreline edge with its min side as width', () => {
    const [e] = ink([filled([10, 99, 200, 100], BLACK)]).horiz;
    expect(e.pos).toBeCloseTo(99.5, 6);
    expect(e.width).toBeCloseTo(1, 6);
    expect(e.color).toEqual(BLACK);
  });

  it('keeps a fat fill as a shading rect, not an edge', () => {
    const i = ink([filled([10, 80, 200, 100], GREY)]);
    expect(i.horiz).toEqual([]);
    expect(i.fills).toEqual([{ rect: [10, 80, 200, 100], color: GREY }]);
  });

  it('ignores a path that is neither filled nor stroked', () => {
    const p = filled([10, 80, 200, 100], GREY);
    expect(ink([{ ...p, fill: null }]).fills).toEqual([]);
  });

  it('keeps fills in content order, so a later one can win a tie', () => {
    const i = ink([filled([0, 0, 500, 700], GREY), filled([10, 80, 200, 100], BLACK)]);
    expect(i.fills.map((f) => f.color)).toEqual([GREY, BLACK]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/tableink.test.ts`
Expected: FAIL — `Failed to load url ../src/tableink.js`.

- [ ] **Step 3: Implement `src/tableink.ts`**

```ts
import type { PagePath } from './paths.js';
import type { Rgb } from './colorspace.js';
import type { Rect } from './tablemodel.js';
import { apply, type Matrix } from './text.js';

/** One drawn axis-aligned edge, in page space. `pos` is the constant
 *  coordinate; `lo`..`hi` the span along the edge. */
export interface InkEdge { pos: number; lo: number; hi: number; width: number; color: Rgb }

/** A filled rectangle that is too fat to be a rule — a candidate cell or table
 *  background. */
export interface InkFill { rect: Rect; color: Rgb }

export interface PageInk { horiz: InkEdge[]; vert: InkEdge[]; fills: InkFill[] }

const AXIS_TOL = 0.6;   // matches table.ts: off-axis delta this small is axis-aligned

/** Flatten a path's subpaths to device-space line segments. Cubics are skipped:
 *  a rule is never a curve, and their control points would widen every bbox. */
function deviceSegments(p: PagePath): [number, number, number, number][] {
  const out: [number, number, number, number][] = [];
  const ctm = p.ctm as Matrix;
  for (const sp of p.subpaths) {
    let cur: [number, number] | undefined;
    let start: [number, number] | undefined;
    for (const seg of sp.segments) {
      if (seg.op === 'move') {
        cur = apply(ctm, seg.pt[0], seg.pt[1]) as [number, number];
        start = cur;
        continue;
      }
      if (seg.op === 'cubic') { cur = apply(ctm, seg.pt[0], seg.pt[1]) as [number, number]; continue; }
      const to = apply(ctm, seg.pt[0], seg.pt[1]) as [number, number];
      if (cur) out.push([cur[0], cur[1], to[0], to[1]]);
      cur = to;
    }
    if (sp.closed && cur && start) out.push([cur[0], cur[1], start[0], start[1]]);
  }
  return out;
}

function pushAxis(
  segs: [number, number, number, number][], width: number, color: Rgb,
  minLen: number, horiz: InkEdge[], vert: InkEdge[],
): void {
  for (const [x0, y0, x1, y1] of segs) {
    const dx = Math.abs(x1 - x0), dy = Math.abs(y1 - y0);
    if (dy <= AXIS_TOL && dx >= minLen) {
      horiz.push({ pos: (y0 + y1) / 2, lo: Math.min(x0, x1), hi: Math.max(x0, x1), width, color });
    } else if (dx <= AXIS_TOL && dy >= minLen) {
      vert.push({ pos: (x0 + x1) / 2, lo: Math.min(y0, y1), hi: Math.max(y0, y1), width, color });
    }
  }
}

/** Index a page's painted paths as edges and candidate background fills.
 *
 *  Pure: takes `PagePath[]` and the caller's tolerances, imports no PDF object
 *  module, and touches no Document. `table.ts` owns `MIN_RULE_LEN` and
 *  `MAX_RULE_THICK` and passes them in, so the detector and this index cannot
 *  drift about what counts as a rule.
 *
 *  **Invariant:** a stroked edge comes from the path's SUBPATHS transformed
 *  through its own `ctm`, never from `bbox`. A grid drawn as one stroked path
 *  has a single bbox covering the whole table, which would yield one giant edge
 *  bordering everything.
 *
 *  **Invariant:** fills stay in CONTENT ORDER, so a later fill can win a tie
 *  against an earlier one — it is the one painted on top. */
export function collectPageInk(paths: PagePath[], minLen: number, maxThick: number): PageInk {
  const horiz: InkEdge[] = [], vert: InkEdge[] = [], fills: InkFill[] = [];
  for (const p of paths) {
    if (p.fill && !p.stroke) {
      const [x0, y0, x1, y1] = p.bbox;
      const w = x1 - x0, h = y1 - y0;
      // Thin means a rule, fat means shading — the same split rulesFromPath makes.
      if (Math.min(w, h) <= maxThick && Math.max(w, h) >= minLen) {
        const thick = Math.min(w, h);
        if (w >= h) horiz.push({ pos: (y0 + y1) / 2, lo: x0, hi: x1, width: thick, color: p.fill.rgb });
        else vert.push({ pos: (x0 + x1) / 2, lo: y0, hi: y1, width: thick, color: p.fill.rgb });
      } else if (w > 0 && h > 0) {
        fills.push({ rect: [x0, y0, x1, y1], color: p.fill.rgb });
      }
      continue;
    }
    if (p.stroke) {
      pushAxis(deviceSegments(p), p.lineWidth, p.stroke.rgb, minLen, horiz, vert);
    }
  }
  return { horiz, vert, fills };
}
```

`apply(m: Matrix, x: number, y: number): [number, number]` and `Matrix` are both already exported from `src/text.ts` (lines 14 and 28), so the `as Matrix` cast above is only narrowing `PagePath.ctm`'s structural type — no new export is needed.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/tableink.test.ts` — Expected: PASS
Run: `npm run typecheck` — Expected: no errors

- [ ] **Step 5: Commit**

```bash
git add src/tableink.ts test/tableink.test.ts
git commit -m "feat(table): index a page's ink with width and colour"
```

---

### Task 2: `tableink.ts` — the two lookups

**Files:**
- Modify: `src/tableink.ts`
- Test: `test/tableink.test.ts`

**Interfaces:**
- Consumes: `PageInk`, `InkEdge`, `InkFill` (Task 1).
- Produces:
  ```ts
  export function edgeAt(
    ink: PageInk, axis: 'h' | 'v', pos: number, lo: number, hi: number, tol: number,
  ): InkEdge | undefined;
  export function fillUnder(ink: PageInk, rect: Rect, tol: number): InkFill | undefined;
  ```

- [ ] **Step 1: Write the failing test**

Append to `test/tableink.test.ts`:

```ts
import { edgeAt, fillUnder, type PageInk } from '../src/tableink.js';

const INK: PageInk = {
  horiz: [
    { pos: 100, lo: 10, hi: 200, width: 1, color: BLACK },
    { pos: 50, lo: 10, hi: 60, width: 1, color: BLACK },     // short: first column only
  ],
  vert: [{ pos: 10, lo: 20, hi: 100, width: 2, color: BLACK }],
  fills: [],
};

describe('edgeAt', () => {
  it('finds an edge that spans the whole side', () => {
    expect(edgeAt(INK, 'h', 100, 10, 200, 2)?.width).toBe(1);
  });

  // A short rule under one column does not border the cell beside it. Overlap
  // is not enough -- the edge must SPAN the side.
  it('refuses an edge that only overlaps the side', () => {
    expect(edgeAt(INK, 'h', 50, 10, 200, 2)).toBeUndefined();
    expect(edgeAt(INK, 'h', 50, 10, 60, 2)).toBeDefined();
  });

  it('matches a position within tolerance and not beyond it', () => {
    expect(edgeAt(INK, 'h', 101, 10, 200, 2)).toBeDefined();
    expect(edgeAt(INK, 'h', 104, 10, 200, 2)).toBeUndefined();
  });

  it('looks on the axis it is asked for', () => {
    expect(edgeAt(INK, 'v', 10, 20, 100, 2)?.width).toBe(2);
    expect(edgeAt(INK, 'v', 100, 10, 200, 2)).toBeUndefined();
  });
});

describe('fillUnder', () => {
  const cell: [number, number, number, number] = [10, 80, 200, 100];

  // A page background, a full-table wash and a shaded header cell are all
  // filled rectangles. Containment would let the page background claim every
  // cell and paint the whole table grey.
  it('refuses a fill that merely contains the cell', () => {
    const ink: PageInk = { horiz: [], vert: [], fills: [{ rect: [0, 0, 500, 700], color: GREY }] };
    expect(fillUnder(ink, cell, 2)).toBeUndefined();
  });

  it('accepts a fill matching the cell on all four edges', () => {
    const ink: PageInk = { horiz: [], vert: [], fills: [{ rect: [10, 80, 200, 100], color: GREY }] };
    expect(fillUnder(ink, cell, 2)?.color).toEqual(GREY);
  });

  it('accepts a near match within tolerance', () => {
    const ink: PageInk = { horiz: [], vert: [], fills: [{ rect: [11, 79, 199, 101], color: GREY }] };
    expect(fillUnder(ink, cell, 2)?.color).toEqual(GREY);
  });

  // The last one in content order is the one painted on top.
  it('prefers the last qualifying fill', () => {
    const ink: PageInk = { horiz: [], vert: [], fills: [
      { rect: [10, 80, 200, 100], color: GREY },
      { rect: [10, 80, 200, 100], color: BLACK },
    ] };
    expect(fillUnder(ink, cell, 2)?.color).toEqual(BLACK);
  });

  it('returns undefined when there is no fill at all', () => {
    expect(fillUnder({ horiz: [], vert: [], fills: [] }, cell, 2)).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/tableink.test.ts`
Expected: FAIL — `edgeAt` / `fillUnder` are not exported.

- [ ] **Step 3: Implement the lookups**

Append to `src/tableink.ts`:

```ts
/** The edge drawn along a cell side, or undefined when none is.
 *
 *  **Invariant:** the edge must SPAN the side, within `tol` — not merely
 *  overlap it. A short rule under one column does not border the cell beside
 *  it. Same test `coveredH`/`coveredV` already apply in the detector. */
export function edgeAt(
  ink: PageInk, axis: 'h' | 'v', pos: number, lo: number, hi: number, tol: number,
): InkEdge | undefined {
  const list = axis === 'h' ? ink.horiz : ink.vert;
  return list.find((e) =>
    Math.abs(e.pos - pos) <= tol && e.lo <= lo + tol && e.hi >= hi - tol);
}

/** The background fill of a cell rect, or undefined when none matches.
 *
 *  **Invariant:** a fill claims a cell only when EACH of its four edges is
 *  within `tol` of the cell's corresponding edge — never merely containing it.
 *  A page background, a full-table wash and a shaded header cell are all
 *  filled rectangles, and a containment test paints the whole table grey the
 *  moment a producer lays a background behind it.
 *
 *  **Invariant:** where several qualify, the LAST in content order wins: it is
 *  the one painted on top. */
export function fillUnder(ink: PageInk, rect: Rect, tol: number): InkFill | undefined {
  let hit: InkFill | undefined;
  for (const f of ink.fills) {
    const near = f.rect.every((v, i) => Math.abs(v - rect[i]) <= tol);
    if (near) hit = f;
  }
  return hit;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/tableink.test.ts` — Expected: PASS
Run: `npm run typecheck` — Expected: no errors

- [ ] **Step 5: Commit**

```bash
git add src/tableink.ts test/tableink.test.ts
git commit -m "feat(table): resolve a cell edge and a cell background from page ink"
```

---

### Task 3: model fields and decoration

**Files:**
- Modify: `src/tablemodel.ts` (the `TableCell` interface at line 6)
- Modify: `src/table.ts` (constants at lines 13–15; `extractTables` at line 518)
- Test: `test/table-borders.test.ts` (new)

**Interfaces:**
- Consumes: `collectPageInk`, `edgeAt`, `fillUnder` (Tasks 1–2); `page.GetPaths(): PagePath[]` (`src/page.ts:433`).
- Produces:
  ```ts
  export interface CellBorder { width: number; color?: Rgb }
  export interface CellBorders {
    top?: CellBorder; right?: CellBorder; bottom?: CellBorder; left?: CellBorder;
  }
  // on TableCell:
  borders?: CellBorders;
  shading?: Rgb;
  ```

A cell's `quad` is `[x0, y0, x1, y1]` with y0 the BOTTOM (`buildCells` builds `[x0, yBot, x1, yTop]`, `table.ts:590`), so `top` is the horizontal edge at `quad[3]` and `bottom` the one at `quad[1]`.

- [ ] **Step 1: Write the failing test**

Create `test/table-borders.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { Document, PageFormat } from '../src/index.js';
import { extractTables } from '../src/table.js';

/** A 2x2 ruled table with a shaded top-left cell, drawn as vectors.
 *  Grid lines at x = 100, 200, 300 and y = 500, 550, 600.
 *
 *  PageGraphics takes colours in 0..1 (they go straight into `RG`/`rg`), while
 *  paths.ts hands them back in 0..255 via its `cl255` clamp — so 0.2 in gives
 *  51 out, and 0.8 gives 204. */
function ruledPage() {
  const doc = Document.New();
  const { page } = doc.AddPage(PageFormat.A4);
  const g = page.Graphics();
  // Shading first, so the rules paint over it.
  g.setFillColor([0.8, 0.8, 0.8]).rect(100, 550, 100, 50).fill();
  g.setStrokeColor([0.2, 0.2, 0.2]).setLineWidth(1);
  for (const y of [500, 550, 600]) g.drawLine(100, y, 300, y).stroke();
  for (const x of [100, 200, 300]) g.drawLine(x, 500, x, 600).stroke();
  g.apply();
  page.AddText('A', { x: 120, y: 570, size: 10 });
  page.AddText('B', { x: 220, y: 570, size: 10 });
  page.AddText('C', { x: 120, y: 520, size: 10 });
  page.AddText('D', { x: 220, y: 520, size: 10 });
  return { doc, page };
}

describe('recovered cell borders', () => {
  it('records all four edges of an interior cell', () => {
    const { doc, page } = ruledPage();
    const [t] = extractTables(doc, page);
    const cell = t.rows[0].cells[0];
    expect(cell.borders).toBeDefined();
    for (const side of ['top', 'right', 'bottom', 'left'] as const)
      expect(cell.borders![side]).toBeDefined();
    expect(cell.borders!.top!.width).toBeCloseTo(1, 1);
    expect(cell.borders!.top!.color).toEqual([51, 51, 51]);   // 0.2 * 255
  });

  it('recovers the shading of the cell that has it, and only that cell', () => {
    const { doc, page } = ruledPage();
    const [t] = extractTables(doc, page);
    expect(t.rows[0].cells[0].shading).toEqual([204, 204, 204]);   // 0.8 * 255
    expect(t.rows[0].cells[1].shading).toBeUndefined();
    expect(t.rows[1].cells[0].shading).toBeUndefined();
  });

  // Absent means NOT RECOVERED, which is what makes the export fall back to the
  // frame it has always drawn. A missing edge on a PRESENT borders means
  // measured absent -- there is genuinely no rule there.
  it('leaves an edge undefined where no rule spans it', () => {
    const doc = Document.New();
    const { page } = doc.AddPage(PageFormat.A4);
    const g = page.Graphics();
    g.setStrokeColor([0, 0, 0]).setLineWidth(1);
    // A full frame, plus ONE interior horizontal rule and no interior vertical.
    for (const y of [500, 550, 600]) g.drawLine(100, y, 300, y).stroke();
    for (const x of [100, 300]) g.drawLine(x, 500, x, 600).stroke();
    g.apply();
    page.AddText('A', { x: 120, y: 570, size: 10 });
    page.AddText('C', { x: 120, y: 520, size: 10 });
    const [t] = extractTables(doc, page);
    const cell = t.rows[0].cells[0];
    expect(cell.borders).toBeDefined();
    expect(cell.borders!.top).toBeDefined();
    expect(cell.borders!.left).toBeDefined();
    expect(cell.borders!.right).toBeDefined();     // the frame's right edge
  });
});
```

The `PageGraphics` methods used above are the real ones (`src/graphics.ts`): `setFillColor`/`setStrokeColor` take an `[r, g, b]` tuple in 0..1, `setLineWidth`, `rect(x, y, w, h)`, `drawLine(x1, y1, x2, y2)`, `fill()`, `stroke()`, and `apply()` to splice the buffered operators into `/Contents`. All are chainable.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/table-borders.test.ts`
Expected: FAIL — `cell.borders` is undefined (and TypeScript rejects the property).

- [ ] **Step 3: Add the model fields**

In `src/tablemodel.ts`, above `TableCell`:

```ts
import type { Rgb } from './colorspace.js';

/** One drawn cell edge. `width` is in points; `color` absent means the ink
 *  carried none. */
export interface CellBorder { width: number; color?: Rgb }
export interface CellBorders {
  top?: CellBorder; right?: CellBorder; bottom?: CellBorder; left?: CellBorder;
}
```

and inside `TableCell`:

```ts
  /** The cell's drawn edges, when they could be recovered.
   *
   *  **Invariant:** ABSENT means *not recovered* — a tagged table, a rotated
   *  table, a page whose ink could not be read — and a consumer must fall back
   *  to whatever it drew before this field existed. An edge missing from a
   *  PRESENT `borders` means *measured absent*: there is genuinely no rule
   *  there, and it must draw nothing. The two want opposite renderings, and
   *  collapsing them is the mistake `parseSimpleWidths` records about a present
   *  versus an absent `/MissingWidth`. */
  borders?: CellBorders;
  /** The cell's recovered background, absent when none was found. */
  shading?: Rgb;
```

- [ ] **Step 4: Export the tolerances from `table.ts`**

Change the three constants at `src/table.ts:13-15` to be exported, so `tableink.ts`'s callers pass the detector's own values rather than a second copy:

```ts
export const MIN_RULE_LEN = 3;        // ignore shorter segments
export const MAX_RULE_THICK = 3;      // filled rect this thin (min side) is a rule
export const SNAP = 2;                // cluster / match tolerance
```

- [ ] **Step 5: Decorate axis-aligned tables**

Add to `src/table.ts`:

```ts
/** Attach recovered borders and shading to every cell of `tables`, recursing
 *  into nested tables.
 *
 *  **Invariant:** this runs AFTER detection and changes nothing the detector
 *  decided. That is what makes the feature incapable of regressing table
 *  detection — the most heavily tested geometry in this file. */
function decorateInk(tables: Table[], ink: PageInk): void {
  for (const t of tables) {
    for (const row of t.rows) {
      for (const c of row.cells) {
        const [x0, y0, x1, y1] = c.quad;      // y0 is the BOTTOM (buildCells)
        const b: CellBorders = {};
        const top = edgeAt(ink, 'h', y1, x0, x1, SNAP);
        const bottom = edgeAt(ink, 'h', y0, x0, x1, SNAP);
        const left = edgeAt(ink, 'v', x0, y0, y1, SNAP);
        const right = edgeAt(ink, 'v', x1, y0, y1, SNAP);
        if (top) b.top = { width: top.width, color: top.color };
        if (bottom) b.bottom = { width: bottom.width, color: bottom.color };
        if (left) b.left = { width: left.width, color: left.color };
        if (right) b.right = { width: right.width, color: right.color };
        c.borders = b;                        // present, even when empty: recovered
        const fill = fillUnder(ink, c.quad, SNAP);
        if (fill) c.shading = fill.color;
        if (c.tables?.length) decorateInk(c.tables, ink);
      }
    }
  }
}
```

and call it from the axis-aligned branch of `extractTables` only:

```ts
  if (Math.abs(theta) < ANGLE_EPS) {
    const { horiz, vert } = collectRules(doc, page, options.region);
    const frags = extractFragments(doc, page).filter((f) =>
      !options.region || contains(options.region, ...centroid(f.quad)));
    const tables = buildTables(horiz, vert, frags);
    // Axis-aligned only. A rotated table's cell quads are in its own upright
    // frame while ink is in page space; mapping between them is a second
    // geometry with its own failure modes, and `borders` being absent is
    // already how the model says "not recovered".
    decorateInk(tables, collectPageInk(page.GetPaths(), MIN_RULE_LEN, MAX_RULE_THICK));
    return tables;
  }
```

Import `collectPageInk`, `edgeAt`, `fillUnder` and `type PageInk` from `./tableink.js`, and `type CellBorders` from `./tablemodel.js`.

Note the rotated branch below it is left untouched, so a rotated table's cells keep `borders === undefined`.

**Invariant:** `collectPageInk` is called ONCE, outside `decorateInk`, and the
`PageInk` is passed down. Moving the call inside the cell loop walks the page's
content per cell — the shape that turned an N-figure page into N content walks
in `no93.1`, and a table has cells × 4 edges to resolve.

**Invariant:** `c.borders` is assigned even when the object is EMPTY. Present
and empty means "recovered, and this cell has no drawn edges"; absent means
"not recovered". Assigning only when an edge was found collapses the two, and
every consumer then falls back to a frame for a cell that provably has none.

- [ ] **Step 6: Run the tests**

Run: `npx vitest run test/table-borders.test.ts` — Expected: PASS
Run: `npm run typecheck` — Expected: no errors
Run: `npm test` — Expected: green, **including** `test/html-identity.test.ts`, `test/table*.test.ts` and the Markdown snapshots

The fences must be green here. `toHtml` and `toMarkdown` do not read the new fields yet, so any movement means the decoration disturbed detection — fix that, never the snapshot.

- [ ] **Step 7: Commit**

```bash
git add src/tablemodel.ts src/table.ts test/table-borders.test.ts
git commit -m "feat(table): recover per-cell borders and shading from page ink"
```

---

### Task 4: DOCX per-cell borders and shading

**Files:**
- Modify: `src/docxtable.ts`
- Test: `test/docx-table.test.ts`

**Interfaces:**
- Consumes: `TableCell.borders` / `.shading` (Task 3); `CellBorder`, `CellBorders` from `./tablemodel.js`.
- Produces: no new exports — `docxTable`'s signature is unchanged.

- [ ] **Step 1: Write the failing test**

Append to `test/docx-table.test.ts`:

```ts
describe('docxTable borders', () => {
  const bordered = (over: Partial<TableCell> = {}): TableCell => cell(0, 0, 'x', {
    borders: {
      top: { width: 1, color: [51, 51, 51] },
      bottom: { width: 0.5 },
      // left and right measured absent
    },
    ...over,
  });

  it('emits a per-cell tcBorders when the cell was recovered', () => {
    const xml = docxTable(table([row([bordered()])], 1), ctx);
    expect(xml).toContain('<w:top w:val="single" w:sz="8" w:color="333333"/>');
    expect(xml).toContain('<w:bottom w:val="single" w:sz="4" w:color="auto"/>');
  });

  // Measured absent draws nothing -- distinct from not recovered, which falls
  // back to the frame.
  it('emits none for an edge measured absent', () => {
    const xml = docxTable(table([row([bordered()])], 1), ctx);
    expect(xml).toContain('<w:left w:val="none"/>');
    expect(xml).toContain('<w:right w:val="none"/>');
  });

  // Two sources for one edge leaves Word's specificity rules to decide, which
  // is what makes "why is this border here" unanswerable.
  it('omits the table-level frame once any cell is recovered', () => {
    const xml = docxTable(table([row([bordered()])], 1), ctx);
    expect(xml).not.toContain('<w:tblBorders>');
  });

  // The byte-identical fallback: an unrecovered table is exactly what shipped.
  it('keeps the uniform frame when nothing was recovered', () => {
    const xml = docxTable(table([row([cell(0, 0, 'x')])], 1), ctx);
    expect(xml).toContain('<w:tblBorders>');
    expect(xml).not.toContain('<w:tcBorders>');
  });

  it('emits shading as w:shd', () => {
    const xml = docxTable(table([row([bordered({ shading: [238, 238, 238] })])], 1), ctx);
    expect(xml).toContain('<w:shd w:val="clear" w:color="auto" w:fill="EEEEEE"/>');
  });

  // w:tcPr's children are schema-ORDERED. Wrong order is a file Word refuses.
  it('orders tcPr children tcW, gridSpan, vMerge, tcBorders, shd', () => {
    const xml = docxTable(table([row([bordered({ colSpan: 1, shading: [1, 2, 3] })])], 1), ctx);
    const at = (tag: string) => xml.indexOf(tag);
    expect(at('<w:tcW')).toBeLessThan(at('<w:tcBorders>'));
    expect(at('<w:tcBorders>')).toBeLessThan(at('<w:shd'));
  });

  // sz is in EIGHTHS of a point, and Word's range is 2..96.
  it('clamps the border size to Word\'s range', () => {
    const thin = cell(0, 0, 'x', { borders: { top: { width: 0.05 } } });
    const fat = cell(0, 1, 'y', { borders: { top: { width: 40 } } });
    const xml = docxTable(table([row([thin, fat])], 2), ctx);
    expect(xml).toContain('w:sz="2"');
    expect(xml).toContain('w:sz="96"');
  });
});
```

Add `TableCell` to the existing type import at the top of the file if it is not already there.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/docx-table.test.ts`
Expected: FAIL — no `w:tcBorders` is emitted at all.

- [ ] **Step 3: Implement**

In `src/docxtable.ts`, add above `cellXml`:

```ts
import type { CellBorder, CellBorders, Table, TableCell } from './tablemodel.js';

const SIDES = ['top', 'left', 'bottom', 'right'] as const;

/** `w:sz` is in EIGHTHS of a point, and Word's accepted range is 2..96. */
function borderSz(width: number): number {
  return Math.max(2, Math.min(96, Math.round(width * 8)));
}

const hex = (rgb: readonly number[]): string =>
  rgb.map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0'))
    .join('').toUpperCase();

function edgeXml(side: string, b: CellBorder | undefined): string {
  // Measured absent draws NOTHING -- distinct from not recovered, which never
  // reaches this function because the caller falls back to the table frame.
  if (!b) return `<w:${side} w:val="none"/>`;
  const color = b.color ? hex(b.color) : 'auto';
  return `<w:${side} w:val="single" w:sz="${borderSz(b.width)}" w:color="${color}"/>`;
}

function tcBordersXml(borders: CellBorders): string {
  return `<w:tcBorders>${SIDES.map((s) => edgeXml(s, borders[s])).join('')}</w:tcBorders>`;
}
```

Then in `cellXml`, append the two properties **after** `vMerge`:

```ts
function cellXml(c: TableCell, widthTwips: number, ctx: DocxTableCtx): string {
  // **Invariant:** w:tcPr's children are schema-ORDERED, not free: tcW,
  // gridSpan, vMerge, tcBorders, shd. Wrong order is a file Word refuses
  // outright, so a new property is INSERTED at its place, never appended.
  const props = `<w:tcW w:w="${Math.round(widthTwips)}" w:type="dxa"/>`
    + (c.colSpan > 1 ? `<w:gridSpan w:val="${c.colSpan}"/>` : '')
    + (c.rowSpan > 1 ? '<w:vMerge w:val="restart"/>' : '')
    + (c.borders ? tcBordersXml(c.borders) : '')
    + (c.shading ? `<w:shd w:val="clear" w:color="auto" w:fill="${hex(c.shading)}"/>` : '');
  const nested = (c.tables ?? []).map((t) => docxTable(t, ctx)).join('');
  const body = ctx.paragraph(c.text) + nested + (nested ? ctx.paragraph('') : '');
  return `<w:tc><w:tcPr>${props}</w:tcPr>${body}</w:tc>`;
}
```

And in `docxTable`, make the frame conditional:

```ts
  // **Invariant:** a recovered table OMITS the table-level frame and states all
  // four edges on every cell. Keeping both leaves two sources for one edge with
  // Word's specificity rules deciding, which makes "why is this border here"
  // unanswerable. An UNRECOVERED table emits exactly what shipped before this
  // feature existed, byte for byte.
  const recovered = table.rows.some((r) => r.cells.some((c) => c.borders));
  const frame = recovered ? '' : '<w:tblBorders>'
    + ['top', 'left', 'bottom', 'right', 'insideH', 'insideV']
      .map((s) => `<w:${s} w:val="single" w:sz="4" w:color="auto"/>`).join('')
    + '</w:tblBorders>';
  return `<w:tbl><w:tblPr><w:tblW w:w="${total}" w:type="dxa"/>`
    + `${frame}</w:tblPr><w:tblGrid>${grid}</w:tblGrid>${rows}</w:tbl>`;
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run test/docx-table.test.ts test/docx-export.test.ts` — Expected: PASS
Run: `npm run typecheck && npm test` — Expected: green

- [ ] **Step 5: Commit**

```bash
git add src/docxtable.ts test/docx-table.test.ts
git commit -m "feat(docx): emit recovered per-cell borders and shading"
```

---

### Task 5: HTML emission

**Files:**
- Modify: `src/tablemodel.ts` (`Table.toHtml`)
- Test: `test/table-borders.test.ts`, plus the HTML snapshots

**Interfaces:**
- Consumes: `TableCell.borders` / `.shading` (Task 3).
- Produces: no new exports.

This is the task whose snapshot churn is **intended**. It is deliberately separate from Task 3 so that a snapshot diff can still distinguish an extraction bug from the new rendering.

- [ ] **Step 1: Write the failing test**

Append to `test/table-borders.test.ts`:

```ts
import { Table, type TableCell, type TableRow } from '../src/tablemodel.js';

describe('Table.toHtml borders', () => {
  const mk = (over: Partial<TableCell>) => new Table([0, 0, 100, 20], 1, 1, [{
    cells: [{ row: 0, col: 0, rowSpan: 1, colSpan: 1, quad: [0, 0, 100, 20], text: 'x', ...over }],
    quad: [0, 0, 100, 20],
  } as TableRow]);

  it('emits inline border and background styles for a recovered cell', () => {
    const html = mk({
      borders: { top: { width: 1, color: [51, 51, 51] } },
      shading: [238, 238, 238],
    }).toHtml();
    expect(html).toContain('border-top: 1pt solid #333333');
    expect(html).toContain('border-left: none');
    expect(html).toContain('background-color: #EEEEEE');
  });

  // No style attribute at all, so every existing snapshot of an unrecovered
  // table stays exactly as it was.
  it('emits no style attribute for an unrecovered cell', () => {
    expect(mk({}).toHtml()).not.toContain('style=');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/table-borders.test.ts`
Expected: FAIL — no `style=` is emitted.

- [ ] **Step 3: Implement**

In `src/tablemodel.ts`'s `toHtml`, build the attribute alongside the existing ones:

```ts
const cssHex = (rgb: readonly number[]): string =>
  '#' + rgb.map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16)
    .padStart(2, '0')).join('').toUpperCase();

/** Inline style for a recovered cell, or '' when the cell was not recovered.
 *
 *  An unrecovered cell emits NO style attribute, which is what keeps every
 *  existing snapshot of an unruled or tagged table exactly as it was. */
function cellStyle(c: TableCell): string {
  if (!c.borders && !c.shading) return '';
  const parts: string[] = [];
  if (c.borders) {
    for (const side of ['top', 'right', 'bottom', 'left'] as const) {
      const b = c.borders[side];
      parts.push(b
        ? `border-${side}: ${b.width}pt solid ${b.color ? cssHex(b.color) : 'currentColor'}`
        : `border-${side}: none`);
    }
  }
  if (c.shading) parts.push(`background-color: ${cssHex(c.shading)}`);
  return ` style="${escHtml(parts.join('; '))}"`;
}
```

and include `cellStyle(c)` in the `attrs` string the cell tag already builds.

- [ ] **Step 4: Run the tests and update the snapshots**

Run: `npx vitest run test/table-borders.test.ts` — Expected: PASS
Run: `npm test` — Expected: `test/html-identity.test.ts` may now FAIL on a fixture containing a ruled table.

`test/html-identity.test.ts` uses `toMatchSnapshot()`, and its "untagged: ruled table + card" case builds a `RULED_TABLE` content stream — so that snapshot is the one expected to move, and it is the only one that should.

Read every diff before accepting it. A `style` attribute appearing on a ruled table's cells is the intended change; anything else — moved text, changed structure, a style on an *unruled* table or on the card frame — is a bug in Task 3 or here, and must be fixed rather than blessed. Then accept with:

Run: `npx vitest run test/html-identity.test.ts -u`
Run: `npm test` — Expected: green

- [ ] **Step 5: Commit**

```bash
git add src/tablemodel.ts test/
git commit -m "feat(html): emit recovered table borders and shading as inline styles"
```

---

### Task 6: Prove the assertions, then document

**Files:**
- Modify: `README.md`, `CLAUDE.md`
- Possibly modify: any test whose mutation ran green

**Interfaces:**
- Consumes: everything above. Produces: no code.

- [ ] **Step 1: Run the mutations**

Apply each, run the named test, confirm **red**, revert. A mutation that leaves the suite green means the assertion is not load-bearing — strengthen it and record what you found, the way CLAUDE.md records the `scanDelimiterRow` and `docinfer` follower-clause findings.

| # | Mutation | Must go red |
|---|---|---|
| 1 | `fillUnder` accepts containment (`rect` inside `f.rect`) instead of a four-edge match | `test/tableink.test.ts` "refuses a fill that merely contains the cell" |
| 2 | `edgeAt` drops the span test, keeping only the `pos` match | `test/tableink.test.ts` "refuses an edge that only overlaps the side" |
| 3 | `collectPageInk` reads `p.bbox` for a stroked path instead of its subpaths | `test/tableink.test.ts` "takes a stroked edge per segment" |
| 4 | `decorateInk` sets `c.borders` only when at least one edge was found | `test/table-borders.test.ts` "leaves an edge undefined where no rule spans it" — if it stays green, the fallback is unpinned; add a case where a cell has NO edges and must still be `borders: {}` |
| 5 | `borderSz` returns `round(width)` rather than `round(width * 8)` | `test/docx-table.test.ts` "emits a per-cell tcBorders" |
| 6 | `cellXml` appends `tcBorders` after `shd` | `test/docx-table.test.ts` "orders tcPr children" |
| 7 | `docxTable` keeps `w:tblBorders` on a recovered table | `test/docx-table.test.ts` "omits the table-level frame" |
| 8 | `docxTable` drops the frame unconditionally | `test/docx-table.test.ts` "keeps the uniform frame when nothing was recovered" |
| 9 | `decorateInk` runs on the rotated branch too | no test covers this; ADD one — a rotated ruled table whose cells must have `borders === undefined` |
| 10 | `cellStyle` returns a style for an unrecovered cell | `test/table-borders.test.ts` "emits no style attribute" |

Mutation 9 is expected to expose a gap: the rotated skip is stated in the spec but nothing asserts it. Add `test/table-borders.test.ts`'s rotated case as part of this step rather than leaving the limit unpinned.

- [ ] **Step 2: Update `README.md`**

Replace the DOCX table limitation added by `8yt9.2`:

> - **DOCX and HTML tables recover their ruling** — per-cell borders and shading are read from the page's vector ink, so a table ruled only between rows exports that way rather than as a full grid. Three limits: a **dashed** rule becomes solid, since the path model records no dash array; a **rotated** table is skipped and falls back to a uniform frame; and a **tagged** table has no geometry at all, so `AddTable({ tagged: true })` output round-trips less faithfully here than an untagged table — the structure tree records what a cell *is*, never what it looked like.

- [ ] **Step 3: Update `CLAUDE.md`**

- Add a Source-list entry for `tableink.ts` beside the table-extraction group, carrying: the fill-ambiguity invariant (four-edge match, not containment; last in content order wins); the span invariant on `edgeAt`; the subpaths-not-bbox invariant; and that the tolerances are arguments so the detector stays their single owner.
- Extend the `table.ts`/`tablemodel.ts` entry with the absent-versus-measured-absent rule and the rotated-table skip.
- Extend the `docxtable.ts` entry with the `w:tcPr` child ordering and the omitted `w:tblBorders` on a recovered table.

- [ ] **Step 4: Verify and commit**

Run: `npm run typecheck && npm test` — Expected: green

```bash
git add README.md CLAUDE.md test/
git commit -m "docs(table): record the ink-recovery invariants and the dash/rotation limits"
```

- [ ] **Step 5: Close out**

```bash
bd close aspose-pdf-foss-for-ts-8yt9.3
git pull --rebase && git push && git status
bd dolt push
```

The session is not complete until `git push` succeeds and `git status` shows the branch up to date with origin.

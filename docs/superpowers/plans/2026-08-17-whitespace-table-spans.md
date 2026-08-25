# Whitespace Table Spans Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the borderless/whitespace table detector `colSpan`, so a header spanning two columns exports as one cell instead of text plus an empty cell.

**Architecture:** The column cuts are distorted by the very rows a span detector is looking for, so break the circularity: derive a second set of cuts from the rows holding the *modal* fragment count and use those purely as a yardstick. The final grid stays the all-rows cuts — detection is untouched — and the two cut systems are joined by **index, never position**. Preceded by an extraction: the whitespace half of `table.ts` is pure and has never had a test file, which is how this issue's original premise came to be wrong.

**Tech Stack:** TypeScript (ESM, NodeNext, `strict`), vitest, zero runtime dependencies.

**Spec:** `docs/superpowers/specs/2026-08-17-whitespace-table-spans-design.md`

**Issue:** `aspose-pdf-foss-for-ts-c3t7.5`, under epic `c3t7`.

## Global Constraints

- **Zero runtime dependencies.** Only `node:` built-ins.
- **ESM + NodeNext.** Every import specifier carries `.js`.
- **`strict` TypeScript.** `npm run typecheck` green before any task closes.
- **`npm test` green before any task closes.** Target one file with `npx vitest run test/<name>.test.ts`.
- **Tasks 1 and 2 are behaviour-neutral.** They are pure moves. If any existing test changes, the move is wrong — stop and fix the move, do not update the test.
- **Detection must not change, ever.** The prose guard runs on the all-true grid exactly as today. Reference cuts are a yardstick and never become the final grid. This is `decorateInk`'s rule: runs after detection, changes nothing the detector decided.
- **Absent, not defaulted.** New optional fields are omitted when they carry the default.
- **`SPAN_OVERHANG = 0.2` and `PROSE_FILL = 0.5` are named constants and tuning starting points**, not derived figures.
- **Prove assertions load-bearing.** Break the path each new test covers, confirm red, restore. A green first run is not evidence.
- **Errors** use the `errors.ts` types. Extraction entry points never throw on a damaged page; they degrade.

## File Structure

| File | Responsibility |
|---|---|
| `src/tablegrid.ts` (new, ~60 lines) | Grid arithmetic and the cell helpers **both** detectors need: `buildCells`, `centroid`, `contains`, `rowBbox`, `cellText`. A leaf — imports neither detector |
| `src/tablestream.ts` (new, ~230 lines) | The whitespace ("stream") detector, pure over `TextFragment[]`: `groupLines`, `columnCuts`, `median`, `largestGap`, `candidateSplits`, `segmentBlocks`, `detectWhitespaceTable`, plus the new `modalCount`, `referenceCuts`, `spanSeparators` |
| `src/table.ts` (~400 lines after) | Ruled detection, rotation, rule partitioning, ink decoration, `extractTables`. Keeps `SNAP`, `rectContains`, and everything that reads a `Document` |
| `test/tablestream.test.ts` (new) | The detector's first unit tests: characterization in Task 2, then the span rules |

---

### Task 1: Extract `tablegrid.ts`

A pure move. `buildCells` is `export`ed from `table.ts` and has **no importer outside it**, verified, so it relocates freely. `centroid`, `contains`, `rowBbox` and `cellText` are used by both detectors, which is why they must live below both.

`rectContains` stays in `table.ts` — it is ruled-only and depends on `SNAP`, which also stays. `mat` stays out of this module; it is whitespace-only and moves in Task 2.

**Files:**
- Create: `src/tablegrid.ts`
- Modify: `src/table.ts` — delete `cellText` (:96-117), `centroid` (:119), `contains` (:120), `rowBbox` (:126-131), `buildCells` (:614-646); add an import

**Interfaces:**
- Consumes: `Rect`, `TableCell` from `tablemodel.js`; `TextFragment` from `text.js`.
- Produces:
  ```ts
  export function buildCells(
    xcuts: number[], ycuts: number[], vSep: boolean[][], hSep: boolean[][],
  ): { row: number; col: number; rowSpan: number; colSpan: number; quad: Rect }[];
  export const centroid: (q: Rect) => [number, number];
  export const contains: (q: Rect, x: number, y: number) => boolean;
  export function rowBbox(cells: TableCell[]): Rect;
  export function cellText(frags: TextFragment[]): string;
  ```
  Tasks 2–4 consume all five.

- [ ] **Step 1: Create the module by moving code verbatim**

Create `src/tablegrid.ts`. Copy the five function bodies out of `src/table.ts` **unchanged** — same logic, same comments — adding `export` to each and this header:

```ts
// Grid arithmetic shared by both table detectors: turning cut lines into cells
// with spans, and the cell-level text and geometry helpers.
//
// A LEAF. table.ts (ruled) and tablestream.ts (whitespace) both import it, so it
// must import neither — that is what keeps tablestream.ts from having to take
// buildCells as an argument the way docxtable.ts takes its paragraph builder.
import type { Rect, TableCell } from './tablemodel.js';
import type { TextFragment } from './text.js';
```

Keep `buildCells`' existing doc comment, which documents the cut ordering
(`xcuts` ascending, `ycuts` descending, row 0 is the top band).

- [ ] **Step 2: Delete the originals and import them back**

In `src/table.ts`, delete the five definitions at the lines above and add:

```ts
import { buildCells, cellText, centroid, contains, rowBbox } from './tablegrid.js';
```

`table.ts` currently re-exports `buildCells`. Keep that re-export so no external
consumer can break:

```ts
export { buildCells } from './tablegrid.js';
```

- [ ] **Step 3: Verify the move is inert**

```bash
npm run typecheck && npm test
```
Expected: green, with **no test modified**. `test/table*.test.ts` and
`test/html-identity.test.ts` (which snapshots `Table.toHtml`) are the fences. If
any of them moves, the move was wrong — fix the move.

- [ ] **Step 4: Commit**

```bash
git add src/tablegrid.ts src/table.ts
git commit -m "refactor(table): extract tablegrid.ts, the shared grid arithmetic

Pure move, no behaviour change: buildCells plus the cell helpers both
detectors need. A leaf, so the whitespace detector can import it in the
next commit without closing a cycle against table.ts.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 2: Extract `tablestream.ts` and characterize it

The second pure move, plus the detector's first unit tests. Those tests pin
**today's flat behaviour** before any span logic exists, so Task 4's diff is
visible rather than inferred.

**Files:**
- Create: `src/tablestream.ts`, `test/tablestream.test.ts`
- Modify: `src/table.ts` — delete `COL_GAP` (:169), `groupLines` (:172-185), `columnCuts` (:187-215), `detectWhitespaceTable` (:217-255), `median` (:257-263), `largestGap` (:265-279), `VGAP_MULT`/`HGAP_MULT` (:281-282), `candidateSplits` (:291-317), `segmentBlocks` (:319-328), `mat` (:330-332); add an import

**Interfaces:**
- Consumes: `buildCells`, `cellText`, `centroid`, `contains`, `rowBbox` (Task 1); `Table` from `tablemodel.js`; `TableCell`, `TableRow`, `Rect` types.
- Produces:
  ```ts
  export function groupLines(frags: TextFragment[]): TextFragment[][];
  export function columnCuts(lines: TextFragment[][], x0: number, x1: number): number[];
  export function segmentBlocks(frags: TextFragment[]): Table[];
  export function detectWhitespaceTable(frags: TextFragment[]): Table | undefined;
  export const mat: (rows: number, cols: number, v: boolean) => boolean[][];
  ```
  `table.ts` needs only `segmentBlocks`. Tasks 3–4 use `groupLines`, `columnCuts`, `mat`.

- [ ] **Step 1: Create the module by moving code verbatim**

Create `src/tablestream.ts` with the ten items moved **unchanged**, exporting
`groupLines`, `columnCuts`, `segmentBlocks`, `detectWhitespaceTable` and `mat`
(the rest stay module-private), under this header:

```ts
// The whitespace ("stream") table detector: reconstruct a table from text
// geometry alone, for a table drawn with no ruling lines.
//
// Pure over TextFragment[] — no Document, no Page, no content walk — which is
// what lets every threshold be tested from hand-built fragments. Distinct from
// tablestruct.ts (tagged-tree extraction) and tableink.ts (border recovery);
// it imports neither.
import { Table } from './tablemodel.js';
import type { Rect, TableCell, TableRow } from './tablemodel.js';
import type { TextFragment } from './text.js';
import { buildCells, cellText, centroid, contains, rowBbox } from './tablegrid.js';
```

- [ ] **Step 2: Name the prose-guard constant**

The guard is currently an inline expression. Give it a name, since Tasks 3–4
have to reason about it. In `src/tablestream.ts`, above `detectWhitespaceTable`:

```ts
/** A candidate is prose unless EVERY column carries text in at least this
 *  fraction of its rows.
 *
 *  **Note, measured:** this is knife-edge. A 4-row table whose second column
 *  holds text in exactly 2 rows passes; one fewer and the whole table is
 *  rejected as prose. It is the precision/recall knob for the whole detector. */
const PROSE_FILL = 0.5;
```

and change the guard to use it, preserving the `Math.ceil` exactly:

```ts
  if (colFill.some((n) => n < Math.ceil(R * PROSE_FILL))) return undefined;
```

`Math.ceil(R * 0.5)` is identical to the previous `Math.ceil(R / 2)` for every
integer `R`, so this is still a pure move.

- [ ] **Step 3: Delete the originals and import back**

In `src/table.ts`, delete the ten items listed above and add:

```ts
import { segmentBlocks } from './tablestream.js';
```

- [ ] **Step 4: Write the characterization tests**

Create `test/tablestream.test.ts`. These describe what the detector does
**today**, flat cells included:

```ts
import { describe, it, expect } from 'vitest';
import type { TextFragment } from '../src/text.js';
import { groupLines, columnCuts, detectWhitespaceTable, segmentBlocks } from '../src/tablestream.js';

/** A fragment of `text` at (x, baseline), 10pt unless told otherwise. */
function f(text: string, x: number, baseline: number, size = 10): TextFragment {
  return {
    text, fontSize: size,
    quad: [x, baseline, x + text.length * size * 0.55, baseline + size],
  };
}

/** A two-column body row: left at x=20, right at x=120. */
const row = (baseline: number, a: string, b: string): TextFragment[] =>
  [f(a, 20, baseline), f(b, 120, baseline)];

describe('groupLines', () => {
  it('buckets fragments by baseline, top first', () => {
    const lines = groupLines([...row(230, '10', '20'), ...row(260, 'Q1', 'Q2')]);
    expect(lines).toHaveLength(2);
    expect(lines[0].map((x) => x.text).sort()).toEqual(['Q1', 'Q2']);
  });
});

describe('columnCuts', () => {
  it('cuts at the midpoint of a gap no row covers', () => {
    const lines = [row(260, 'Q1', 'Q2'), row(245, '10', '20')];
    const cuts = columnCuts(lines, 19, 134);
    expect(cuts).toHaveLength(3);            // x0, one interior cut, x1
    expect(cuts[1]).toBeCloseTo(76.65, 1);
  });

  it('is PUSHED OUT OF THE WAY by a row that covers the gap', () => {
    // The measurement this whole feature exists because of: a wide row moves
    // the interior cut right, so the wide text ends up inside column 0.
    const lines = [[f('Quarterly results', 20, 260)], row(245, 'Q1', 'Q2'), row(230, '10', '20')];
    const cuts = columnCuts(lines, 19, 134);
    expect(cuts[1]).toBeGreaterThan(100);
  });
});

describe('detectWhitespaceTable (today: always flat)', () => {
  const spanning = [
    ...[f('Quarterly results', 20, 260)],
    ...row(245, 'Q1', 'Q2'),
    ...row(230, '10', '20'),
  ];

  it('detects a 3x2 grid', () => {
    const t = detectWhitespaceTable(spanning)!;
    expect(t).toBeDefined();
    expect([t.rowCount, t.colCount]).toEqual([3, 2]);
  });

  it('gives every cell colSpan 1 — the gap this plan closes', () => {
    const t = detectWhitespaceTable(spanning)!;
    for (const r of t.rows) for (const c of r.cells) expect(c.colSpan).toBe(1);
  });

  it('rejects a candidate whose column is emptier than the prose guard allows', () => {
    // Column 1 has text in 1 of 4 rows; ceil(4 * 0.5) = 2 required.
    const frags = [
      ...row(260, 'Name', 'Note'), ...[f('Bolt', 20, 245)],
      ...[f('Nut', 20, 230)], ...[f('Screw', 20, 215)],
    ];
    expect(detectWhitespaceTable(frags)).toBeUndefined();
  });
});

describe('segmentBlocks', () => {
  it('returns one table per whitespace-separated region', () => {
    const frags = [
      ...row(260, 'Name', 'Qty'), ...row(245, 'Bolt', '12'),
      ...row(120, 'City', 'Pop'), ...row(105, 'Rome', '99'),
    ];
    expect(segmentBlocks(frags)).toHaveLength(2);
  });

  it('does not halve a single table on its inter-column gap', () => {
    // The load-bearing guard in segmentBlocks: a split is accepted only when it
    // yields >= 2 VALID tables, and single-column halves are not valid.
    expect(segmentBlocks([...row(260, 'Q1', 'Q2'), ...row(245, '10', '20')])).toHaveLength(1);
  });
});
```

- [ ] **Step 5: Run them and the full suite**

```bash
npx vitest run test/tablestream.test.ts
npm run typecheck && npm test
```
Expected: the new file green, the existing suite green with **no test modified**.
If a `columnCuts` number is off, adjust the *expectation* to what the code
actually produces and note the real figure — these are characterization tests,
and the code is the authority here, not the plan's arithmetic.

- [ ] **Step 6: Commit**

```bash
git add src/tablestream.ts src/table.ts test/tablestream.test.ts
git commit -m "refactor(table): extract tablestream.ts and characterize it

Pure move of the whitespace detector, plus its first unit tests. It has
never had one -- observable only through GetTables on a built PDF, which
is how c3t7.5's original premise came to be wrong.

The tests pin today's behaviour, flat cells included, so the span commit's
diff is visible rather than inferred. One of them records the measurement
the feature exists because of: a wide row PUSHES the interior cut out of
its own way.

Names PROSE_FILL, previously an inline ceil(R / 2).

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 3: Reference rows and reference cuts

The undistorted yardstick. Pure, and tested on its own before anything consumes
it.

**Files:**
- Modify: `src/tablestream.ts`
- Test: `test/tablestream.test.ts`

**Interfaces:**
- Consumes: `columnCuts`, `groupLines` (Task 2).
- Produces:
  ```ts
  export function modalCount(lines: TextFragment[][]): number;
  export interface SpanRefs { cuts: number[]; modal: number }
  export function referenceCuts(
    lines: TextFragment[][], x0: number, x1: number,
  ): SpanRefs | undefined;
  ```
  Task 4 consumes both.

- [ ] **Step 1: Write the failing tests**

Append to `test/tablestream.test.ts` (and add `modalCount`, `referenceCuts` to
its import):

```ts
describe('modalCount', () => {
  it('takes the most common fragment count', () => {
    expect(modalCount([row(260, 'a', 'b'), row(245, 'c', 'd'), [f('e', 20, 230)]])).toBe(2);
  });

  it('resolves a TIE to the higher count', () => {
    // Two rows of 2 and two rows of 1: more fragments reveal more boundaries,
    // so 2 wins. This is the sparse-table shape, and the tie is what keeps its
    // cuts identical to today's.
    const lines = [
      row(260, 'Name', 'Note'), [f('Bolt', 20, 245)],
      [f('Nut', 20, 230)], row(215, 'Screw', 'spare'),
    ];
    expect(modalCount(lines)).toBe(2);
  });

  it('returns 0 for no lines', () => {
    expect(modalCount([])).toBe(0);
  });
});

describe('referenceCuts', () => {
  const spanning = [
    [f('Quarterly results', 20, 260)], row(245, 'Q1', 'Q2'), row(230, '10', '20'),
  ];

  it('derives cuts from the modal rows alone, undistorted', () => {
    const refs = referenceCuts(spanning, 19, 134)!;
    expect(refs).toBeDefined();
    expect(refs.modal).toBe(2);
    // The body rows alone leave the gap open, so the cut sits far left of the
    // all-rows cut (>100, asserted in Task 2).
    expect(refs.cuts[1]).toBeLessThan(90);
  });

  it('declines when the modal count is below 2', () => {
    // One column: no interior boundary exists, so no span can.
    expect(referenceCuts([[f('a', 20, 260)], [f('b', 20, 245)]], 19, 40)).toBeUndefined();
  });

  it('declines with fewer than two reference rows', () => {
    // Getting this fixture right takes care. The modal count must be >= 2 (or
    // the earlier guard fires instead and the test proves nothing), yet only ONE
    // row may hold it. Three fragments in row 0, one in each of two more rows:
    // counts are [3, 1, 1], so modal ties at 1... which fails the wrong guard.
    // Use [3, 3-but-only-once] instead: counts [3, 2], modal resolves to 3, and
    // exactly one row has it.
    const lines = [
      [f('a', 20, 260), f('b', 60, 260), f('c', 100, 260)],
      row(245, 'Q1', 'Q2'),
    ];
    expect(modalCount(lines)).toBe(3);          // guard 1 passes
    expect(referenceCuts(lines, 19, 134)).toBeUndefined();   // guard 2 fires
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run test/tablestream.test.ts`
Expected: FAIL — `modalCount` and `referenceCuts` are not exported.

- [ ] **Step 3: Implement**

Add to `src/tablestream.ts`, above `detectWhitespaceTable`:

```ts
/** The most common fragment-count among `lines`, ties resolving to the HIGHER
 *  count. 0 for no lines.
 *
 *  **Invariant:** ties go to the higher count because more fragments reveal
 *  more column boundaries. On the sparse shape — two rows of two and two rows
 *  of one — that keeps the reference rows the fully-populated ones, and so
 *  keeps the reference cuts identical to the all-rows cuts, which is why a
 *  sparse table sees no change at all. */
export function modalCount(lines: TextFragment[][]): number {
  const freq = new Map<number, number>();
  for (const ln of lines) freq.set(ln.length, (freq.get(ln.length) ?? 0) + 1);
  let best = 0, bestFreq = -1;
  // Descending by count, so the first of an equal-frequency pair is the higher.
  for (const [count, n] of [...freq].sort((a, b) => b[0] - a[0]))
    if (n > bestFreq) { bestFreq = n; best = count; }
  return best;
}

/** The reference cuts and the modal count behind them. */
export interface SpanRefs { cuts: number[]; modal: number }

/** Column cuts derived from the modal rows ALONE — the boundaries a spanning
 *  row has not distorted — or undefined when there is not enough majority
 *  structure to trust.
 *
 *  **Invariant:** these are a YARDSTICK and never the final grid. Using them to
 *  build cells would change cell quads and text assignment for tables that
 *  detect correctly today, which is the one thing this feature must not do. */
export function referenceCuts(
  lines: TextFragment[][], x0: number, x1: number,
): SpanRefs | undefined {
  const modal = modalCount(lines);
  if (modal < 2) return undefined;              // one column: no boundary to span
  const refs = lines.filter((ln) => ln.length === modal);
  if (refs.length < 2) return undefined;        // no majority to trust
  return { cuts: columnCuts(refs, x0, x1), modal };
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run test/tablestream.test.ts`
Expected: PASS.

- [ ] **Step 5: Prove the assertions load-bearing**

Break each, confirm red, restore:
1. Sort ascending instead of descending in `modalCount` → the tie test must fail.
2. Change `modal < 2` to `modal < 1` → the "below 2" test must fail.
3. Change `refs.length < 2` to `refs.length < 1` → the "fewer than two" test must fail.

- [ ] **Step 6: Typecheck, full suite, commit**

```bash
npm run typecheck && npm test
git add src/tablestream.ts test/tablestream.test.ts
git commit -m "feat(table): derive reference column cuts from the modal rows

The yardstick for span detection: cuts taken from the rows holding the
modal fragment count, which a spanning row has not distorted. Ties resolve
to the HIGHER count, which is what keeps a sparse table's reference cuts
identical to its all-rows cuts and so leaves it untouched.

Declines below 2 columns and below 2 reference rows. A yardstick only --
it never becomes the final grid.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 4: The span predicate, and wire it in

**Files:**
- Modify: `src/tablestream.ts`
- Test: `test/tablestream.test.ts`

**Interfaces:**
- Consumes: `referenceCuts`, `SpanRefs`, `modalCount` (Task 3); `mat`, `buildCells` (Tasks 1–2).
- Produces:
  ```ts
  export function spanSeparators(
    lines: TextFragment[][], xcuts: number[], refs: SpanRefs,
  ): boolean[][] | undefined;
  ```
  Nothing later consumes it; `detectWhitespaceTable` is the only caller.

- [ ] **Step 1: Write the failing tests**

Append to `test/tablestream.test.ts` (adding `spanSeparators` to the import):

```ts
describe('spanSeparators', () => {
  const spanning = [
    [f('Quarterly results', 20, 260)], row(245, 'Q1', 'Q2'), row(230, '10', '20'),
  ];

  it('opens the separator under a straddling single-fragment row', () => {
    const refs = referenceCuts(spanning, 19, 134)!;
    const vSep = spanSeparators(spanning, [19, 108, 134], refs)!;
    expect(vSep).toBeDefined();
    expect(vSep[0][0]).toBe(false);        // row 0 spans the only interior boundary
    expect(vSep[1][0]).toBe(true);         // body rows untouched
    expect(vSep[2][0]).toBe(true);
  });

  it('returns undefined when nothing spans', () => {
    const flat = [row(260, 'Q1', 'Q2'), row(245, '10', '20')];
    const refs = referenceCuts(flat, 19, 134)!;
    expect(spanSeparators(flat, [19, 76.65, 134], refs)).toBeUndefined();
  });

  it('does NOT span a sparse row whose text never reaches the cut', () => {
    // The case cardinality alone gets wrong: 'Bolt' is one fragment on a row of
    // fewer than modal, but it stops well short of the boundary. Spanning it
    // would make toMarkdown print "Bolt | Bolt", inventing data.
    const sparse = [
      row(260, 'Name', 'Note'), [f('Bolt', 20, 245)],
      [f('Nut', 20, 230)], row(215, 'Screw', 'spare'),
    ];
    const refs = referenceCuts(sparse, 19, 190)!;
    expect(spanSeparators(sparse, [19, 100, 190], refs)).toBeUndefined();
  });

  it('requires the overhang margin: just-over spans, just-under does not', () => {
    // The discriminating pair. Reference cut is at 76.65 with a following
    // reference column of ~57.6, so the margin is 0.2 * 57.6 = 11.5pt: a
    // fragment must end past 88.2 to span.
    const refs = referenceCuts(
      [row(245, 'Q1', 'Q2'), row(230, '10', '20')], 19, 134,
    )!;
    const wide = (x1: number): TextFragment[][] => [
      [{ text: 'h', fontSize: 10, quad: [20, 260, x1, 270] }],
      row(245, 'Q1', 'Q2'), row(230, '10', '20'),
    ];
    expect(spanSeparators(wide(95), [19, 108, 134], refs)).toBeDefined();
    expect(spanSeparators(wide(80), [19, 108, 134], refs)).toBeUndefined();
  });

  it('declines when the two cut systems disagree about the column count', () => {
    // Index, never position: a reference grid with a different number of
    // columns cannot be mapped onto the final one without guessing.
    const refs = referenceCuts(spanning, 19, 134)!;
    expect(spanSeparators(spanning, [19, 60, 100, 134], refs)).toBeUndefined();
  });

  it('ignores a multi-fragment non-reference row', () => {
    // Only a single-fragment row is a candidate, which is what makes "the
    // spanned columns are empty in this row" true by construction.
    const three = [
      [f('a', 20, 260), f('b', 60, 260), f('c', 100, 260)],
      row(245, 'Q1', 'Q2'), row(230, '10', '20'),
    ];
    const refs = referenceCuts(three, 19, 134)!;
    expect(spanSeparators(three, [19, 108, 134], refs)).toBeUndefined();
  });
});

describe('detectWhitespaceTable with spans', () => {
  const spanning = [
    [f('Quarterly results', 20, 260)], row(245, 'Q1', 'Q2'), row(230, '10', '20'),
  ];

  it('gives the header colSpan 2 and leaves the body 1x1', () => {
    // BOTH halves matter: asserting only the header would also pass if every
    // cell spanned, which is the worst available bug.
    const t = detectWhitespaceTable(spanning)!;
    expect(t.rows[0].cells).toHaveLength(1);
    expect(t.rows[0].cells[0].colSpan).toBe(2);
    expect(t.rows[0].cells[0].text).toBe('Quarterly results');
    for (const r of t.rows.slice(1)) {
      expect(r.cells).toHaveLength(2);
      for (const c of r.cells) expect(c.colSpan).toBe(1);
    }
  });

  it('still reports 2 columns', () => {
    expect(detectWhitespaceTable(spanning)!.colCount).toBe(2);
  });

  it('renders the span in Markdown', () => {
    // toMarkdown expands a colSpan by REPEATING the text, which is why a false
    // span invents data.
    const md = detectWhitespaceTable(spanning)!.toMarkdown();
    expect(md.split('\n')[0]).toContain('Quarterly results');
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run test/tablestream.test.ts`
Expected: FAIL — `spanSeparators` is not exported, and the `colSpan 2`
assertions fail against today's flat grid.

- [ ] **Step 3: Implement the predicate**

Add to `src/tablestream.ts`, below `referenceCuts`:

```ts
/** How far past a reference cut a fragment must reach to count as spanning it,
 *  as a fraction of the following REFERENCE column's width.
 *
 *  **Invariant:** this margin is the entire precision argument. A long wrapped
 *  cell in column 0 is geometrically indistinguishable from a spanning header —
 *  both are one wide fragment on a row with fewer fragments than its
 *  neighbours — and excluding such a row from the cuts moves the midpoint
 *  toward it, which is exactly how a false span arises. Measured: the canonical
 *  header clears the cut by 29% of the next column, a wrapped cell ending just
 *  past the midpoint by ~6%. A starting point to tune, not a derived figure. */
const SPAN_OVERHANG = 0.2;

/** A `vSep` matrix with `false` wherever a single-fragment, non-reference row's
 *  text clears a reference cut — or undefined when no span was found, so the
 *  caller keeps the grid it already built.
 *
 *  **Invariant:** the two cut systems are joined by INDEX, never by position.
 *  Both must describe the same number of columns or this declines outright. They
 *  normally agree, because a spanning header moves a boundary rather than
 *  inventing a column; when they agree, reference-cut index `i` IS final
 *  interior index `i - 1`. On the canonical fixture the two cuts differ by 31pt,
 *  so no honest positional tolerance could join them.
 *
 *  **Invariant:** only a row with exactly ONE fragment is a candidate. That is
 *  what makes "the spanned columns are empty in this row" true by construction
 *  rather than by a separate check — and cardinality alone is NOT the signal:
 *  measured, a sparse row holds a single fragment too, and spanning it would
 *  make `toMarkdown` print `Bolt | Bolt`. Width decides. */
export function spanSeparators(
  lines: TextFragment[][], xcuts: number[], refs: SpanRefs,
): boolean[][] | undefined {
  const C = xcuts.length - 1;
  if (C < 2) return undefined;
  if (refs.cuts.length - 1 !== C) return undefined;

  const vSep = mat(lines.length, C - 1, true);
  let found = false;
  lines.forEach((ln, r) => {
    if (ln.length !== 1 || ln.length === refs.modal) return;
    const x0 = ln[0].quad[0], x1 = ln[0].quad[2];
    for (let i = 1; i < refs.cuts.length - 1; i++) {
      const cut = refs.cuts[i];
      const margin = SPAN_OVERHANG * (refs.cuts[i + 1] - cut);
      if (x0 < cut && x1 > cut + margin) { vSep[r][i - 1] = false; found = true; }
    }
  });
  return found ? vSep : undefined;
}
```

- [ ] **Step 4: Wire it into `detectWhitespaceTable`**

In `src/tablestream.ts`, the function currently builds `cells0`, runs the prose
guard against it, then maps it to cells with text. Insert the span pass between
the guard and the text mapping. Replace:

```ts
  const cells: TableCell[] = cells0.map((c) => {
```

with:

```ts
  // **Invariant:** the span pass runs AFTER the prose guard and cannot change
  // what the detector decided — the guard above ran on the all-true grid
  // exactly as it always has. decorateInk's rule, applied to the other detector.
  const refs = referenceCuts(lines, x0, x1);
  const vSep = refs ? spanSeparators(lines, xcuts, refs) : undefined;
  const grid = vSep ? buildCells(xcuts, ycuts, vSep, mat(C, R - 1, true)) : cells0;

  const cells: TableCell[] = grid.map((c) => {
```

Leave the body of the `.map` untouched: fragment-to-cell assignment is centroid
containment against `c.quad`, so a spanning cell's wider quad simply claims the
fragment with no further change.

- [ ] **Step 5: Run to verify pass**

Run: `npx vitest run test/tablestream.test.ts`
Expected: PASS. If the "just-under" case at `x1 = 80` spans, print the actual
`refs.cuts` and recompute the margin — the plan's 88.2 threshold assumes a
reference cut at 76.65 and a right edge at 134.

- [ ] **Step 6: Prove every rule load-bearing**

Break each, confirm red, restore. Note which test reds — if a break reds
*nothing*, the rule is unpinned and needs a test before proceeding:
1. Drop the `ln.length !== 1` condition → "sparse row" and "multi-fragment row" must fail.
2. Set `SPAN_OVERHANG = 0` → the "just-under" half of the discriminating pair must fail.
3. Set `SPAN_OVERHANG = 5` → the "just-over" half and the `colSpan 2` tests must fail.
4. Drop the `refs.cuts.length - 1 !== C` check → the cut-count test must fail.
5. Drop the `x0 < cut` half of the predicate → nothing may break silently; if nothing reds, add a case with a fragment starting to the *right* of the cut.

- [ ] **Step 7: Run the full suite and read every diff**

```bash
npm run typecheck && npm test
```

Existing table fixtures holding a wide row **may legitimately change output
here**. For each failure: print the before and after, confirm the new spans are
correct for that fixture, and only then update the expectation — in this commit,
with the reason in the message. These are fences, not goldens. If a change looks
wrong, the threshold is wrong, not the test.

- [ ] **Step 8: Commit**

```bash
git add src/tablestream.ts test/tablestream.test.ts
git commit -m "feat(table): detect spanning cells in whitespace tables

A single-fragment row whose text clears a reference cut by SPAN_OVERHANG of
the following reference column opens that separator, and buildCells grows
the colSpan. No public API change: TableCell.colSpan already exists and all
five consumers already read it.

The margin is the whole precision argument -- a long wrapped cell in column
0 is geometrically identical to a spanning header, and excluding such a row
from the cuts moves the midpoint toward it. Measured: canonical header 29%,
wrapped cell ~6%. Cardinality cannot be the signal, since a sparse row is
also one fragment; spanning it would make toMarkdown print 'Bolt | Bolt'.

Detection is untouched: the prose guard still runs on the all-true grid, and
the reference cuts are a yardstick that never becomes the final one.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 5: End-to-end coverage, docs, close

**Files:**
- Create: `test/table-spans.test.ts`
- Modify: `README.md`, `CLAUDE.md`

- [ ] **Step 1: Write the end-to-end test**

The unit tests drive `detectWhitespaceTable` directly; this proves the whole
pipeline from PDF bytes.

`word/document.xml` is deflated inside the archive, so it is read through the
same `unzip`/`textOf` helpers `test/docx-textbox-media.test.ts` uses — never by
decoding the bytes directly.

```ts
import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { buildSimpleTextPdf } from './helpers/build-text-pdf.js';
import { unzip, textOf } from './helpers/unzip.js';

/** A borderless table whose first row spans both columns. */
const spanningPdf = () => buildSimpleTextPdf([
  'BT /F1 10 Tf 20 260 Td (Quarterly results) Tj ET',
  'BT /F1 10 Tf 20 245 Td (Q1) Tj 100 0 Td (Q2) Tj ET',
  'BT /F1 10 Tf 20 230 Td (10) Tj 100 0 Td (20) Tj ET',
].join(' '));

const firstTable = () => Document.Open(spanningPdf()).Pages[0].GetTables()[0];

describe('whitespace table spans, end to end', () => {
  it('reports the header as one spanning cell', () => {
    const t = firstTable();
    expect(t.rows[0].cells).toHaveLength(1);
    expect(t.rows[0].cells[0].colSpan).toBe(2);
    // The body must stay 1x1, or this passes with everything spanned.
    expect(t.rows[1].cells).toHaveLength(2);
    expect(t.rows[1].cells.every((c) => c.colSpan === 1)).toBe(true);
  });

  it('emits colspan in HTML', () => {
    expect(firstTable().toHtml()).toContain('colspan="2"');
  });

  it('emits w:gridSpan in DOCX', () => {
    // The span must reach the export layer, not just the model.
    const zip = unzip(Document.Open(spanningPdf()).Pages[0].ToDocx());
    expect(textOf(zip, 'word/document.xml')).toContain('<w:gridSpan w:val="2"/>');
  });
});
```

- [ ] **Step 2: Run it**

Run: `npx vitest run test/table-spans.test.ts`
Expected: PASS. If `GetTables()` returns no table, the fixture's page box is
300x300 — check the y coordinates sit inside it.

- [ ] **Step 3: Update the README**

The table paragraph currently reads, in part, *"and it reports no **spans** — a
header spanning two columns becomes text in the first cell with the second left
empty, rather than a `colSpan` (the ruled path does detect spans)"*. That is now
false. Replace with: the whitespace path detects a **column** span when a row
holds a single fragment that clears the column boundary the *other* rows imply,
by a margin; that a long wrapped cell in one column is geometrically identical
to a spanning header, so the margin is deliberately conservative and a missed
span leaves the previous flat output; and that **`rowSpan` is never inferred**,
because rows come from baselines and a cell covering two bands is
indistinguishable from wrapped text.

- [ ] **Step 4: Update CLAUDE.md**

Add `tablestream.ts` and `tablegrid.ts` to the table module block, recording:
`tablegrid.ts` is a leaf both detectors import, which is what avoids the cycle;
`tablestream.ts` is pure over `TextFragment[]` and must not import
`tablestruct.ts` or `tableink.ts`; the reference cuts are a yardstick and never
the final grid, so detection cannot regress; the two cut systems join by index
and decline on a column-count mismatch; cardinality is not the span signal
because a sparse row is also one fragment; `SPAN_OVERHANG` is the precision
knob with the 29%-vs-6% measurement; `PROSE_FILL` is knife-edge; and the three
fixture traps — a uniform fixture cannot test spans at all, a `colSpan === 2`
assertion needs its body-row companion, and `segmentBlocks`' ">= 2 valid
tables" guard must survive future edits.

- [ ] **Step 5: Full verification**

```bash
npm run typecheck && npm test && npm run build
```
Expected: all three green.

- [ ] **Step 6: Commit, close, push**

```bash
git add test/table-spans.test.ts README.md CLAUDE.md
git commit -m "test(table): end-to-end spans, and document the rule

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"

bd close aspose-pdf-foss-for-ts-c3t7.5 --reason "..."
git pull --rebase && git push && git status
```

The close reason should record: the disproved original premise with its
measurement, the modal-reference-cut approach, the index-not-position rule, the
conservative margin with its 29%-vs-6% figures, that no public API changed, and
what stayed out of scope (`rowSpan`, multiple spans per row, nesting) with the
reason for each. File nesting as its own issue if still wanted.

---

## Self-Review

**Spec coverage.** Extraction → Tasks 1–2. Reference rows and cuts → Task 3.
Span rule, predicate, wiring → Task 4. Testing → Tasks 2–5, with the spec's
three named traps carried into Task 4 step 6 and Task 5 step 4. Documentation →
Task 5. The spec's out-of-scope list (`rowSpan`, multiple spans, nesting) is
carried into the close reason rather than dropped.

**Two things the spec left implicit, decided here:**
- `spanSeparators` returns `undefined` rather than an all-true matrix when
  nothing spans, so the caller keeps the exact `cells0` it already built. That
  is what makes "no span found" byte-identical rather than merely equivalent.
- `C < 2` is an explicit early return. A one-column grid has no interior
  separator, so `mat(R, 0, true)` would be an empty row and the loop would never
  run — correct by accident. The guard makes it correct on purpose.

**Names verified against the source**, since three of this issue's own claims
turned out wrong when checked: `buildCells` has no importer outside `table.ts`;
`rectContains` depends on `SNAP` and so stays behind; `mat` is whitespace-only
(0 ruled-path uses) and moves to `tablestream.ts`; `table.ts` re-exports
`buildCells` today, so the re-export is preserved.

**Two of my own drafting faults, fixed rather than left in.** Task 5's DOCX test
began as a stub with a `void xml;` and a "replace this" note — the exact
placeholder shape this skill forbids; it now carries the real `unzip`/`textOf`
code and names the test file whose pattern it follows. And Task 3's
"fewer than two reference rows" fixture originally tripped the *wrong* guard: with
counts `[3, 1, 1]` the modal ties at 1, so `modal < 2` fires and the test proves
nothing about `refs.length`. Corrected to `[3, 2]`, where the tie-break makes the
modal 3 with exactly one row holding it — and the test now asserts `modalCount`
is 3 first, so a future edit cannot silently slide back to passing for the wrong
reason.

**One deliberate instruction to deviate.** Task 2 step 5 and Task 4 step 5 tell
the implementer to trust the code's actual numbers over the plan's arithmetic for
`columnCuts` values. The characterization figures were computed by hand from
fragment widths; Helvetica advances make them approximate, and a plan that
demands its own arithmetic be right is worse than one that says which side is
authoritative.

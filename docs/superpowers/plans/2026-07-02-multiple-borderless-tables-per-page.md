# Multiple Borderless Tables Per Page Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Detect multiple borderless/whitespace tables on a single page (stacked and side-by-side), and let a page yield ruled AND borderless tables.

**Architecture:** Add a pure recursive XY-cut `segmentBlocks` to `src/table.ts` that splits page fragments on the largest full-span whitespace band (validated so single tables aren't split), running `detectWhitespaceTable` per leaf. Wire it into `extractTables`, replacing the single-table fallback and composing with the ruled path by excluding fragments inside ruled-table bboxes.

**Tech Stack:** TypeScript (strict, ESM/NodeNext), vitest. Node built-ins only.

## Global Constraints

- Zero runtime dependencies — only `node:` built-ins. Do not add npm runtime deps.
- ESM + NodeNext: all relative imports carry the `.js` extension.
- `strict` TypeScript. `npm run typecheck` and `npm test` must both be green before closing.
- Live-mutation model unchanged; no public API signature changes (`extractTables`, `Document.GetTables`, `Page.GetTables` keep returning `Table[]`).
- Follow existing `src/table.ts` style: small pure helpers, `SNAP`-tolerant geometry, validation guards (`>= 2` col/row).

---

### Task 1: Recursive whitespace segmentation (`segmentBlocks`)

Add the segmentation engine and use it in place of the single whitespace fallback. Pages with no ruled tables (stacked / side-by-side borderless) now yield multiple tables. Composition with the ruled path is Task 2.

**Files:**
- Modify: `src/table.ts` (add helpers `median`, `largestGap`, `candidateSplits`, `segmentBlocks`; change the fallback block in `extractTables` at `src/table.ts:394-397`; move the reading-order sort to after the fallback)
- Test: `test/table.test.ts` (new cases in a `describe('extractTables — whitespace segmentation', …)` block)

**Interfaces:**
- Consumes (existing in `src/table.ts`): `detectWhitespaceTable(frags: TextFragment[]): Table | undefined`; `centroid(q: Rect): [number, number]`; `TextFragment` (from `./text.js`, fields `quad: [number,number,number,number]`, `fontSize: number`); `Table`.
- Produces (for Task 2): `segmentBlocks(frags: TextFragment[]): Table[]` — internal (not exported); returns zero or more borderless tables discovered by recursive XY-cut.

- [ ] **Step 1: Write the failing tests**

Add to `test/table.test.ts` (the file already imports `Document`, `extractTables`, and the `text`/`hline`/`vline`/`buildTablePdf` helpers):

```ts
describe('extractTables — whitespace segmentation', () => {
  it('detects two vertically stacked borderless tables as separate tables', () => {
    // Table A rows y=300,280,260; Table B rows y=200,180,160. Cols at x=50,160.
    let stream = '';
    [['Name', 'Age'], ['Alice', '30'], ['Bob', '25']].forEach((r, i) => {
      const y = 300 - i * 20; stream += text(50, y, r[0]) + text(160, y, r[1]);
    });
    [['Item', 'Qty'], ['Pen', '5'], ['Ink', '2']].forEach((r, i) => {
      const y = 200 - i * 20; stream += text(50, y, r[0]) + text(160, y, r[1]);
    });
    const doc = Document.Open(buildTablePdf(stream));
    const tables = extractTables(doc, doc.Pages[0]);
    expect(tables).toHaveLength(2);
    // Reading order: top table first.
    expect(tables[0].rows[0].cells.map((c) => c.text)).toEqual(['Name', 'Age']);
    expect(tables[0].rowCount).toBe(3);
    expect(tables[1].rows[0].cells.map((c) => c.text)).toEqual(['Item', 'Qty']);
    expect(tables[1].rowCount).toBe(3);
  });

  it('detects two side-by-side borderless tables as separate tables', () => {
    // Left cols x=50,120; Right cols x=300,370. Rows y=200,180,160.
    let stream = '';
    [['A', 'B'], ['a', 'b'], ['c', 'd']].forEach((r, i) => {
      const y = 200 - i * 20;
      stream += text(50, y, r[0]) + text(120, y, r[1]) + text(300, y, r[0]) + text(370, y, r[1]);
    });
    const doc = Document.Open(buildTablePdf(stream));
    const tables = extractTables(doc, doc.Pages[0]);
    expect(tables).toHaveLength(2);
    tables.forEach((t) => { expect(t.colCount).toBe(2); expect(t.rowCount).toBe(3); });
    // Reading order: left table first.
    expect(tables[0].quad[0]).toBeLessThan(tables[1].quad[0]);
  });

  it('keeps a single borderless table with a moderate internal gap as one table', () => {
    // Row pitch 20 normally; last row pitch 26 (still below the separator threshold).
    const rows = [['Name', 'Age'], ['Alice', '30'], ['Bob', '25'], ['Eve', '40']];
    const ys = [200, 180, 160, 134];
    let stream = '';
    rows.forEach((r, i) => { stream += text(50, ys[i], r[0]) + text(160, ys[i], r[1]); });
    const doc = Document.Open(buildTablePdf(stream));
    const tables = extractTables(doc, doc.Pages[0]);
    expect(tables).toHaveLength(1);
    expect(tables[0].rowCount).toBe(4);
  });

  it('does not treat ordinary prose as a table', () => {
    let stream = '';
    ['The quick brown', 'fox jumps over', 'the lazy dog'].forEach((s, i) => {
      stream += text(50, 200 - i * 20, s);
    });
    const doc = Document.Open(buildTablePdf(stream));
    expect(extractTables(doc, doc.Pages[0])).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/table.test.ts -t "whitespace segmentation"`
Expected: FAIL — the stacked case returns 1 (merged/single) instead of 2; side-by-side returns 1 wide table.

- [ ] **Step 3: Add the segmentation helpers**

In `src/table.ts`, insert these helpers immediately after `detectWhitespaceTable` (i.e. after `src/table.ts:247`, before the `const mat = …` line):

```ts
/** Median of a numeric list (0 for empty). */
function median(xs: number[]): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** Largest gap in 1-D coverage of the given intervals (undefined if none). */
function largestGap(intervals: [number, number][]): { lo: number; hi: number; size: number } | undefined {
  if (intervals.length < 2) return undefined;
  const sorted = [...intervals].sort((a, b) => a[0] - b[0]);
  let cover = sorted[0][1];
  let best: { lo: number; hi: number; size: number } | undefined;
  for (let i = 1; i < sorted.length; i++) {
    const [lo, hi] = sorted[i];
    if (lo > cover) {
      const size = lo - cover;
      if (!best || size > best.size) best = { lo: cover, hi: lo, size };
    }
    cover = Math.max(cover, hi);
  }
  return best;
}

const VGAP_MULT = 2.0;   // stacked separator must exceed this * median font size
const HGAP_MULT = 2.5;   // side-by-side separator must exceed this * median font size

/** Candidate splits on each axis whose largest full-span whitespace band exceeds
 *  its threshold, ordered by how much it exceeds it (most-exceeding first). A gap
 *  in the Y projection is a full-width horizontal band (separates stacked tables);
 *  a gap in the X projection is a full-height vertical band (separates side-by-side
 *  tables). Both are returned so a caller can try the next axis when the first
 *  split fails validation — critical when a full-height inter-column gap competes
 *  with the true stacked separator. */
function candidateSplits(frags: TextFragment[]): [TextFragment[], TextFragment[]][] {
  const fs = median(frags.map((f) => f.fontSize)) || 1;
  const build = (axis: 'y' | 'x', mult: number) => {
    const gap = axis === 'y'
      ? largestGap(frags.map((f) => [f.quad[1], f.quad[3]] as [number, number]))
      : largestGap(frags.map((f) => [f.quad[0], f.quad[2]] as [number, number]));
    if (!gap || gap.size < mult * fs) return undefined;
    const mid = (gap.lo + gap.hi) / 2;
    const A: TextFragment[] = [], B: TextFragment[] = [];
    for (const f of frags) {
      const c = axis === 'y' ? (f.quad[1] + f.quad[3]) / 2 : (f.quad[0] + f.quad[2]) / 2;
      (c > mid ? A : B).push(f);
    }
    if (!A.length || !B.length) return undefined;
    return { ratio: gap.size / (mult * fs), split: [A, B] as [TextFragment[], TextFragment[]] };
  };
  const cs = [build('y', VGAP_MULT), build('x', HGAP_MULT)]
    .filter((c): c is NonNullable<typeof c> => !!c)
    .sort((a, b) => b.ratio - a.ratio);
  return cs.map((c) => c.split);
}

/** Recursively XY-cut fragments into spatially-separated blocks, detecting one
 *  whitespace table per leaf. Each axis's split is tried in most-exceeding order;
 *  a split is accepted only when it yields >= 2 valid tables, so a single sparse
 *  table is not wrongly halved (splitting it on an inter-column gap produces
 *  single-column halves that fail detection). Otherwise the whole block is a
 *  single candidate. */
function segmentBlocks(frags: TextFragment[]): Table[] {
  if (frags.length < 2) return [];
  for (const [A, B] of candidateSplits(frags)) {
    const left = segmentBlocks(A);
    const right = segmentBlocks(B);
    if (left.length + right.length >= 2) return [...left, ...right];
  }
  const t = detectWhitespaceTable(frags);
  return t ? [t] : [];
}
```

- [ ] **Step 4: Wire `segmentBlocks` into `extractTables` and move the sort**

In `src/table.ts`, replace the current tail of `extractTables` (`src/table.ts:391-398`):

```ts
  // Reading order: top→bottom, then left→right.
  out.sort((a, b) => (b.quad[3] - a.quad[3]) || (a.quad[0] - b.quad[0]));
  // Whitespace fallback when no ruled table was found.
  if (out.length === 0) {
    const t = detectWhitespaceTable(frags);
    if (t) out.push(t);
  }
  return out;
```

with:

```ts
  // Whitespace tables (only when the ruled path found nothing — Task 2 relaxes this).
  if (out.length === 0) out.push(...segmentBlocks(frags));
  // Reading order: top→bottom, then left→right.
  out.sort((a, b) => (b.quad[3] - a.quad[3]) || (a.quad[0] - b.quad[0]));
  return out;
```

- [ ] **Step 5: Run the new tests to verify they pass**

Run: `npx vitest run test/table.test.ts -t "whitespace segmentation"`
Expected: PASS (all four cases).

- [ ] **Step 6: Run the full table suite to check for regressions**

Run: `npx vitest run test/table.test.ts test/table-nested.test.ts test/table-stitch.test.ts test/table-tagged.test.ts test/tablemodel.test.ts`
Expected: PASS — in particular the existing `extractTables — whitespace` single-table test still returns exactly one table.

- [ ] **Step 7: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 8: Commit**

```bash
git add src/table.ts test/table.test.ts
git commit -m "feat(ajj): recursive whitespace segmentation for multiple borderless tables

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: Compose borderless tables with the ruled path

Drop the `out.length === 0` gate so a page can yield ruled AND borderless tables, excluding fragments that fall inside a ruled table's bbox before segmenting.

**Files:**
- Modify: `src/table.ts` (the whitespace block added in Task 1, near `src/table.ts:391`)
- Test: `test/table.test.ts` (add cases to the `describe('extractTables — whitespace segmentation', …)` block)

**Interfaces:**
- Consumes: `segmentBlocks(frags: TextFragment[]): Table[]` (Task 1); `contains(q: Rect, x: number, y: number): boolean` and `centroid` (existing in `src/table.ts`); `Table.quad: Rect`.
- Produces: no new symbols; `extractTables` now returns ruled + borderless tables together in reading order.

- [ ] **Step 1: Write the failing tests**

Add to the same `describe('extractTables — whitespace segmentation', …)` block in `test/table.test.ts`:

```ts
  it('returns a ruled table and a borderless table on the same page', () => {
    // Ruled 2-row/2-col table high on the page (y 220..300).
    const ruled =
      hline(50, 150, 300) + hline(50, 150, 260) + hline(50, 150, 220) +
      vline(50, 220, 300) + vline(100, 220, 300) + vline(150, 220, 300) +
      text(55, 280, 'X') + text(105, 280, 'Y') +
      text(55, 240, 'p') + text(105, 240, 'q');
    // Borderless table well below it (y 160..200).
    let ws = '';
    [['P', 'Q'], ['1', '2'], ['3', '4']].forEach((r, i) => {
      const y = 200 - i * 20; ws += text(50, y, r[0]) + text(160, y, r[1]);
    });
    const doc = Document.Open(buildTablePdf(ruled + ws));
    const tables = extractTables(doc, doc.Pages[0]);
    expect(tables).toHaveLength(2);
    // Ruled table (top) first, then borderless.
    expect(tables[0].rows[0].cells.map((c) => c.text)).toEqual(['X', 'Y']);
    expect(tables[1].rows[0].cells.map((c) => c.text)).toEqual(['P', 'Q']);
  });

  it('does not add spurious borderless tables from a ruled table plus prose', () => {
    const ruled =
      hline(50, 150, 300) + hline(50, 150, 260) + hline(50, 150, 220) +
      vline(50, 220, 300) + vline(100, 220, 300) + vline(150, 220, 300) +
      text(55, 280, 'X') + text(105, 280, 'Y') +
      text(55, 240, 'p') + text(105, 240, 'q');
    const prose =
      text(50, 200, 'A paragraph of running text') +
      text(50, 180, 'that should not be a table') +
      text(50, 160, 'on this page at all.');
    const doc = Document.Open(buildTablePdf(ruled + prose));
    const tables = extractTables(doc, doc.Pages[0]);
    expect(tables).toHaveLength(1);
    expect(tables[0].rows[0].cells.map((c) => c.text)).toEqual(['X', 'Y']);
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/table.test.ts -t "same page"`
Expected: FAIL — with the Task 1 gate still present, the ruled table exists so the whitespace path is skipped; the mixed case returns 1 (ruled only) instead of 2.

- [ ] **Step 3: Replace the gated whitespace block with ruled-aware composition**

In `src/table.ts`, replace the Task 1 line:

```ts
  // Whitespace tables (only when the ruled path found nothing — Task 2 relaxes this).
  if (out.length === 0) out.push(...segmentBlocks(frags));
```

with:

```ts
  // Whitespace tables: segment fragments not already inside a ruled table so a
  // page can yield ruled AND borderless tables.
  const ruledBoxes = out.map((t) => t.quad);
  const wsFrags = frags.filter((f) => !ruledBoxes.some((b) => contains(b, ...centroid(f.quad))));
  out.push(...segmentBlocks(wsFrags));
```

- [ ] **Step 4: Run the new tests to verify they pass**

Run: `npx vitest run test/table.test.ts -t "same page"`
Expected: PASS (both cases).

- [ ] **Step 5: Run the full test suite and typecheck**

Run: `npm test && npm run typecheck`
Expected: all tests PASS; no type errors. Confirms no regressions across the whole suite (including nested, stitching, and tagged table paths).

- [ ] **Step 6: Commit**

```bash
git add src/table.ts test/table.test.ts
git commit -m "feat(ajj): compose ruled and borderless tables on one page

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Notes for the implementer

- The two thresholds `VGAP_MULT` (2.0) and `HGAP_MULT` (2.5) are tuned so the fixtures pass: normal row pitch (20, gap ≈ 13) and the moderate-gap fixture (pitch 26, gap ≈ 19) stay below `2.0 × fontSize (10) = 20`, while the stacked separator (gap ≈ 53) and side-by-side separator (gap ≈ 175) clear their thresholds. If real-world tuning is needed later, adjust these constants — the split-validation guard (`>= 2` tables) already prevents fragmenting a sparse single table even when an internal column gap exceeds `HGAP_MULT`.
- `segmentBlocks` is internal by design (tested through `extractTables`), matching the existing `detectWhitespaceTable` / `buildRuledRegion` pattern. Do not export it.
- No README change is required — `extractTables`/`GetTables` already document returning multiple tables; this only broadens detection.
```

# Geometry-Path Nested Table Extraction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Detect a table nested inside a ruled table's cell in the untagged (geometry) path and attach it to its parent `TableCell` (recursive, arbitrary depth), reusing the `tables` field and nested `toHtml()` shipped in 84u.

**Architecture:** In `src/table.ts`, replace the direct `assembleTable` call on the ruled path with a new recursive `buildRuledRegion`. It classifies clustered rules as *structural* (span ≥ 90% of the table extent) or *confined*, builds a coarse structural-only grid to locate container cells, qualifies each container's confined rules as a nested table via two tiers (tight, else bounded by the container-cell edges), builds the returned outer table from all rules minus the consumed nested rules, and recurses into each nested region. Regression-safe: with no qualifying nested table, output is byte-identical to today.

**Tech Stack:** TypeScript (ESM + NodeNext, `strict`), vitest. Zero runtime deps (`node:` built-ins only).

## Global Constraints

- Zero runtime dependencies — only `node:` built-ins. Do not add npm runtime deps.
- ESM + NodeNext: every relative import specifier carries a `.js` extension.
- `strict` TypeScript; `npm run typecheck` and `npm test` must both be green before closing the issue.
- TDD: write the failing test first, watch it fail, then implement.
- Follow existing patterns: geometry fixtures are content-stream strings built with `hline`/`vline`/`text` and wrapped by `buildTablePdf` (`test/helpers/build-table-pdf.ts`, MediaBox 0 0 300 300).
- Public error types: `PdfParseError`, `UnsupportedFeatureError`, `InvalidPasswordError` (do not invent new error classes).
- Keep `README.md` in sync when public API changes.
- Reference issue: `aspose-pdf-foss-for-ts-e2o`. The `TableCell.tables` field and nested `toHtml()` already ship from `aspose-pdf-foss-for-ts-84u` — do not re-add them.

---

## Task 1: `buildRuledRegion` seam (pass-through) wired into `extractTables`

Introduce the recursive-detector seam without any nesting logic yet: `buildRuledRegion` initially just delegates to `assembleTable`, and `extractTables` calls it with the rule bounding box. This isolates the plumbing and proves zero regression before the algorithm lands.

**Files:**
- Modify: `src/table.ts` (add `ruleBbox` + `buildRuledRegion`; call from `extractTables`)
- Test: `test/table.test.ts` (existing suite is the regression gate; no new test)

**Interfaces:**
- Consumes: existing private `assembleTable(horiz: Rule[], vert: Rule[], frags: TextFragment[]): Table | undefined`, `Rule` = `{ pos: number; lo: number; hi: number }`, `Rect`, `TextFragment`.
- Produces (consumed by Task 2): `buildRuledRegion(horiz: Rule[], vert: Rule[], frags: TextFragment[], bbox: Rect): Table | undefined`; `ruleBbox(horiz: Rule[], vert: Rule[]): Rect`.

- [ ] **Step 1: Add `ruleBbox` and the pass-through `buildRuledRegion`**

In `src/table.ts`, immediately before `export function extractTables`, insert:

```ts
const SPAN_FRAC = 0.9;   // a rule spanning >= this fraction of the table extent is structural

/** Union of all rule extents → a page-space bbox. */
function ruleBbox(horiz: Rule[], vert: Rule[]): Rect {
  const xs: number[] = [], ys: number[] = [];
  for (const h of horiz) { xs.push(h.lo, h.hi); ys.push(h.pos); }
  for (const v of vert) { xs.push(v.pos); ys.push(v.lo, v.hi); }
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}

/** Build a ruled table for `bbox`. (Task 2 adds nested-table detection; for now
 *  this is a straight delegation to assembleTable.) */
function buildRuledRegion(horiz: Rule[], vert: Rule[], frags: TextFragment[], _bbox: Rect): Table | undefined {
  return assembleTable(horiz, vert, frags);
}
```

- [ ] **Step 2: Call `buildRuledRegion` from `extractTables`**

In `src/table.ts`, in the ruled branch of `extractTables`, change:

```ts
  if (uniqSorted(horiz.map((r) => r.pos), false).length >= 2 && uniqSorted(vert.map((r) => r.pos), true).length >= 2) {
    const t = assembleTable(horiz, vert, frags);
    if (t && t.rows.length) out.push(t);
  }
```

to:

```ts
  if (uniqSorted(horiz.map((r) => r.pos), false).length >= 2 && uniqSorted(vert.map((r) => r.pos), true).length >= 2) {
    const t = buildRuledRegion(horiz, vert, frags, ruleBbox(horiz, vert));
    if (t && t.rows.length) out.push(t);
  }
```

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`
Expected: no errors. (`_bbox` is intentionally unused for now; the leading underscore satisfies `noUnusedParameters`.)

- [ ] **Step 4: Run the existing table suite (regression gate)**

Run: `npx vitest run test/table.test.ts`
Expected: PASS — behavior is unchanged (pure delegation).

- [ ] **Step 5: Commit**

```bash
git add src/table.ts
git commit -m "refactor(e2o): buildRuledRegion seam on the ruled path

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 2: Nested detection (algorithm) + inset fixture

Implement the full recursive nested-table detection in `buildRuledRegion`, driven by an *inset* nested-table fixture (nested grid drawn with a gap inside a cell).

**Files:**
- Modify: `src/table.ts` (`buildRuledRegion` body)
- Test: `test/table-nested.test.ts` (create)

**Interfaces:**
- Consumes: `assembleTable`, `cellText(frags: TextFragment[]): string`, `contains(q: Rect, x: number, y: number): boolean`, `centroid(q: Rect): [number, number]`, `SNAP` (= 2), `Rule`, `TableCell`, `Table` — all already in `src/table.ts`.
- Produces: `buildRuledRegion` now populates `cell.tables` for nested tables and strips their text from the parent cell.

- [ ] **Step 1: Write the failing test**

Create `test/table-nested.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { Document } from '../src/index.js';
import { buildTablePdf, hline, vline, text } from './helpers/build-table-pdf.js';

/** Outer 2×2 grid (x50..250 split 150, y50..250 split 150). Bottom-right cell
 *  [150,50,250,150] contains an inset 2×2 grid (x170..230 split 200,
 *  y70..130 split 100) drawn with a gap. */
const insetStream =
  hline(50, 250, 250) + hline(50, 250, 150) + hline(50, 250, 50) +
  vline(50, 50, 250) + vline(150, 50, 250) + vline(250, 50, 250) +
  hline(170, 230, 130) + hline(170, 230, 100) + hline(170, 230, 70) +
  vline(170, 70, 130) + vline(200, 70, 130) + vline(230, 70, 130) +
  text(70, 200, 'A') + text(170, 200, 'B') + text(70, 100, 'C') +
  text(175, 110, 'w') + text(205, 110, 'x') + text(175, 80, 'y') + text(205, 80, 'z');

describe('geometry nested tables — inset', () => {
  const outer = () => Document.Open(buildTablePdf(insetStream)).Pages[0].GetTables()[0];

  it('keeps a clean 2×2 outer grid', () => {
    const t = outer();
    expect(t.rowCount).toBe(2);
    expect(t.colCount).toBe(2);
    expect(t.rows[0].cells.find((c) => c.col === 0)!.text).toBe('A');
    expect(t.rows[0].cells.find((c) => c.col === 1)!.text).toBe('B');
    expect(t.rows[1].cells.find((c) => c.col === 0)!.text).toBe('C');
  });

  it('attaches the inset grid to its container cell and strips its text', () => {
    const t = outer();
    const container = t.rows[1].cells.find((c) => c.col === 1)!;   // bottom-right
    expect(container.text).toBe('');
    expect(container.tables).toHaveLength(1);
    const nested = container.tables![0];
    expect(nested.rowCount).toBe(2);
    expect(nested.colCount).toBe(2);
    const at = (r: number, c: number) => nested.rows[r].cells.find((x) => x.col === c)?.text;
    expect(at(0, 0)).toBe('w');
    expect(at(0, 1)).toBe('x');
    expect(at(1, 0)).toBe('y');
    expect(at(1, 1)).toBe('z');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/table-nested.test.ts`
Expected: FAIL — the pass-through `buildRuledRegion` produces one flat grid; the container cell has no `tables`, and the outer grid is polluted by the inset rules (so `rowCount`/`colCount` are not 2×2).

- [ ] **Step 3: Implement the algorithm in `buildRuledRegion`**

In `src/table.ts`, replace the pass-through `buildRuledRegion` body with:

```ts
interface NestedRegion { horiz: Rule[]; vert: Rule[]; bbox: Rect; }

/** Build a ruled table for `bbox`, detecting tables nested inside cells
 *  (arbitrary depth) by classifying rules as structural (span >= SPAN_FRAC of
 *  the table extent) or confined, then qualifying each container cell's confined
 *  rules as a nested table. Regression-safe: with no nested table detected this
 *  is identical to assembleTable(horiz, vert, frags). */
function buildRuledRegion(horiz: Rule[], vert: Rule[], frags: TextFragment[], bbox: Rect): Table | undefined {
  const w = bbox[2] - bbox[0], h = bbox[3] - bbox[1];
  const structH = new Set(horiz.filter((r) => r.hi - r.lo >= SPAN_FRAC * w));
  const structV = new Set(vert.filter((r) => r.hi - r.lo >= SPAN_FRAC * h));
  const confH = horiz.filter((r) => !structH.has(r));
  const confV = vert.filter((r) => !structV.has(r));

  const nested: NestedRegion[] = [];
  const consumed = new Set<Rule>();

  // Coarse container grid from structural rules only (used to locate/bound
  // nested tables; never returned). Skip when there is nothing confined.
  const coarse = (confH.length || confV.length)
    ? assembleTable(horiz.filter((r) => structH.has(r)), vert.filter((r) => structV.has(r)), [])
    : undefined;
  if (coarse) {
    for (const row of coarse.rows) for (const cell of row.cells) {
      const [x0, y0, x1, y1] = cell.quad;
      const inH = confH.filter((r) => r.pos >= y0 - SNAP && r.pos <= y1 + SNAP && r.lo >= x0 - SNAP && r.hi <= x1 + SNAP);
      const inV = confV.filter((r) => r.pos >= x0 - SNAP && r.pos <= x1 + SNAP && r.lo >= y0 - SNAP && r.hi <= y1 + SNAP);
      if (!inH.length && !inV.length) continue;
      const fragsC = frags.filter((f) => contains(cell.quad, ...centroid(f.quad)));
      // Tier 1: confined lines alone (inset nested table).
      let cand = assembleTable(inH, inV, fragsC);
      let usedH = inH, usedV = inV;
      // Tier 2: bound by the container-cell edges (nested table sharing borders).
      if (!cand || cand.rowCount < 2 || cand.colCount < 2) {
        usedH = [...inH, { pos: y1, lo: x0, hi: x1 }, { pos: y0, lo: x0, hi: x1 }];
        usedV = [...inV, { pos: x0, lo: y0, hi: y1 }, { pos: x1, lo: y0, hi: y1 }];
        cand = assembleTable(usedH, usedV, fragsC);
      }
      if (!cand || cand.rowCount < 2 || cand.colCount < 2) continue;
      nested.push({ horiz: usedH, vert: usedV, bbox: cand.quad });
      for (const r of inH) consumed.add(r);
      for (const r of inV) consumed.add(r);
    }
  }

  // Returned outer table: all rules minus the confined rules consumed by a
  // nested table; fragments inside a nested bbox are removed from the outer.
  const outerFrags = nested.length
    ? frags.filter((f) => { const c = centroid(f.quad); return !nested.some((n) => contains(n.bbox, ...c)); })
    : frags;
  const outer = assembleTable(horiz.filter((r) => !consumed.has(r)), vert.filter((r) => !consumed.has(r)), outerFrags);
  if (!outer) return undefined;

  // Attach each nested table to the outer cell containing its bbox, recursing
  // for deeper nesting, and strip the nested content from the parent cell text.
  for (const n of nested) {
    const [cx, cy] = centroid(n.bbox);
    let target: TableCell | undefined;
    for (const row of outer.rows) for (const cell of row.cells) if (contains(cell.quad, cx, cy)) target = cell;
    if (!target) continue;
    const sub = buildRuledRegion(n.horiz, n.vert, frags.filter((f) => contains(n.bbox, ...centroid(f.quad))), n.bbox);
    if (!sub) continue;
    (target.tables ??= []).push(sub);
    const tq = target.quad;
    target.text = cellText(frags.filter((f) => {
      const c = centroid(f.quad);
      return contains(tq, ...c) && !nested.some((m) => contains(m.bbox, ...c));
    }));
  }
  return outer;
}
```

Keep the `NestedRegion` interface next to the function. Remove the `SPAN_FRAC`/`ruleBbox` you added in Task 1 only if duplicated — they stay as-is; this step replaces only the `buildRuledRegion` body (and adds `NestedRegion`).

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/table-nested.test.ts`
Expected: PASS (both inset tests).

- [ ] **Step 5: Typecheck + regression**

Run: `npm run typecheck && npx vitest run test/table.test.ts`
Expected: no type errors; the existing table suite stays green (no nested tables in those fixtures ⇒ `consumed` empty, `outerFrags === frags` ⇒ identical output).

- [ ] **Step 6: Commit**

```bash
git add src/table.ts test/table-nested.test.ts
git commit -m "feat(e2o): rule-hierarchy nested-table detection on the ruled path

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 3: Shared-border nested table

Prove the Tier-2 path: a nested table whose outer border coincides with the parent cell's borders (only interior confined lines).

**Files:**
- Test: `test/table-nested.test.ts` (extend)

- [ ] **Step 1: Write the test**

Append to `test/table-nested.test.ts`:

```ts
/** Outer 2×2 grid; bottom-right cell [150,50,250,150] holds a 2×2 table whose
 *  outer border IS the parent cell border, with interior split at x200/y100. */
const sharedStream =
  hline(50, 250, 250) + hline(50, 250, 150) + hline(50, 250, 50) +
  vline(50, 50, 250) + vline(150, 50, 250) + vline(250, 50, 250) +
  vline(200, 50, 150) + hline(150, 250, 100) +
  text(70, 200, 'A') + text(170, 200, 'B') + text(70, 100, 'C') +
  text(160, 120, 'p') + text(210, 120, 'q') + text(160, 70, 'r') + text(210, 70, 's');

describe('geometry nested tables — shared border', () => {
  const outer = () => Document.Open(buildTablePdf(sharedStream)).Pages[0].GetTables()[0];

  it('keeps a 2×2 outer grid and detects the shared-border nested table', () => {
    const t = outer();
    expect(t.rowCount).toBe(2);
    expect(t.colCount).toBe(2);
    const container = t.rows[1].cells.find((c) => c.col === 1)!;
    expect(container.text).toBe('');
    expect(container.tables).toHaveLength(1);
    const nested = container.tables![0];
    expect(nested.rowCount).toBe(2);
    expect(nested.colCount).toBe(2);
    const texts = nested.rows.flatMap((row) => row.cells.map((c) => c.text)).sort();
    expect(texts).toEqual(['p', 'q', 'r', 's']);
  });
});
```

- [ ] **Step 2: Run the test**

Run: `npx vitest run test/table-nested.test.ts -t "shared border"`
Expected: PASS (Task 2's Tier-2 branch handles this). If it fails, the container-edge fallback needs debugging — fix in `buildRuledRegion` before continuing.

- [ ] **Step 3: Commit**

```bash
git add test/table-nested.test.ts
git commit -m "test(e2o): shared-border nested table (Tier-2 qualification)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 4: Deep nesting + spanning-cell false-positive guard

Two guards: recursion produces a second nesting level, and a merged (spanning) header cell is **not** misdetected as a nested table.

**Files:**
- Test: `test/table-nested.test.ts` (extend)

- [ ] **Step 1: Write the deep-nesting test**

Append to `test/table-nested.test.ts`:

```ts
/** Outer 2×2; bottom-right holds an inset 2×2 (level 1); that table's
 *  bottom-right cell [200,70,230,100] holds a further inset 2×2 (level 2). */
const deepStream =
  hline(50, 250, 250) + hline(50, 250, 150) + hline(50, 250, 50) +
  vline(50, 50, 250) + vline(150, 50, 250) + vline(250, 50, 250) +
  hline(170, 230, 130) + hline(170, 230, 100) + hline(170, 230, 70) +
  vline(170, 70, 130) + vline(200, 70, 130) + vline(230, 70, 130) +
  hline(205, 225, 97) + hline(205, 225, 85) + hline(205, 225, 73) +
  vline(205, 73, 97) + vline(215, 73, 97) + vline(225, 73, 97) +
  text(175, 110, 'w') + text(205, 110, 'x') + text(175, 80, 'y') +
  text(206, 88, '1', 6) + text(216, 88, '2', 6) + text(206, 75, '3', 6) + text(216, 75, '4', 6);

describe('geometry nested tables — deep nesting', () => {
  it('recurses to a second nesting level', () => {
    const t = Document.Open(buildTablePdf(deepStream)).Pages[0].GetTables()[0];
    const l1 = t.rows[1].cells.find((c) => c.col === 1)!.tables![0];   // level 1
    expect(l1.rowCount).toBe(2);
    expect(l1.colCount).toBe(2);
    const l1BR = l1.rows[1].cells.find((c) => c.col === 1)!;           // level-1 bottom-right
    expect(l1BR.tables).toHaveLength(1);
    const l2 = l1BR.tables![0];                                        // level 2
    expect(l2.rowCount).toBe(2);
    expect(l2.colCount).toBe(2);
    const texts = l2.rows.flatMap((row) => row.cells.map((c) => c.text)).sort();
    expect(texts).toEqual(['1', '2', '3', '4']);
  });
});
```

- [ ] **Step 2: Run the deep-nesting test**

Run: `npx vitest run test/table-nested.test.ts -t "deep nesting"`
Expected: PASS (recursion in `buildRuledRegion`). If it fails, inspect the level-1/level-2 bbox classification before continuing.

- [ ] **Step 3: Write the spanning-cell control test**

Append to `test/table-nested.test.ts`:

```ts
/** A table with a merged (spanning) header: the middle vertical divider exists
 *  only in the body row (y50..150), so the header spans two columns. There is
 *  NO nested table — the lone confined divider must not be misdetected. */
const spanStream =
  hline(50, 250, 250) + hline(50, 250, 150) + hline(50, 250, 50) +
  vline(50, 50, 250) + vline(250, 50, 250) + vline(150, 50, 150) +
  text(120, 200, 'Header') + text(70, 100, 'a') + text(170, 100, 'b');

describe('geometry nested tables — spanning-cell control', () => {
  it('treats a lone partial divider as a spanning cell, not a nested table', () => {
    const tables = Document.Open(buildTablePdf(spanStream)).Pages[0].GetTables();
    expect(tables).toHaveLength(1);
    const t = tables[0];
    expect(t.colCount).toBe(2);
    const header = t.rows[0].cells.find((c) => c.text === 'Header')!;
    expect(header.colSpan).toBe(2);
    // No cell anywhere gained a nested table.
    for (const row of t.rows) for (const c of row.cells) expect(c.tables).toBeUndefined();
  });
});
```

- [ ] **Step 4: Run the control test**

Run: `npx vitest run test/table-nested.test.ts -t "spanning-cell control"`
Expected: PASS — the body cell's confined divider yields `R=1` under Tier 2 (`< 2` rows), so it does not qualify; the outer table is built from all rules exactly as today, giving a 2-column table with a colspan-2 header and no `tables`.

- [ ] **Step 5: Commit**

```bash
git add test/table-nested.test.ts
git commit -m "test(e2o): deep nesting + spanning-cell false-positive guard

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 5: Serialization test, README, verification, and close-out

Add a `toHtml()` integration test, update the README, run full verification, record the memory, close the issue, and push.

**Files:**
- Test: `test/table-nested.test.ts` (one integration test)
- Modify: `README.md` (limitations note)

- [ ] **Step 1: Write the serialization test**

Append to `test/table-nested.test.ts` (reuses `insetStream`):

```ts
describe('geometry nested tables — serialization', () => {
  it('toHtml nests the child <table> inside the parent cell', () => {
    const html = Document.Open(buildTablePdf(insetStream)).Pages[0].GetTables()[0].toHtml();
    expect(html).toMatch(/<td[^>]*>[\s\S]*<table>[\s\S]*<\/table>[\s\S]*<\/td>/);
    expect(html).toContain('>w</td>');   // a nested leaf cell renders
  });
});
```

- [ ] **Step 2: Run it**

Run: `npx vitest run test/table-nested.test.ts -t "serialization"`
Expected: PASS (Tasks 2 + 84u's `toHtml` deliver this end-to-end).

- [ ] **Step 3: Update the README limitations note**

In `README.md`, replace the current table-extraction limitation sentence:

```
Nested tables are extracted from the tagged `/Table` tree (a nested `/Table` inside a cell is attached to that cell's `tables` and rendered as an inner `<table>` by `toHtml()`, its text removed from the parent cell); nested detection in the geometry path is not yet implemented. Still out of scope: rotated/skewed tables, cross-page tables, and geometry-path nested tables.
```

with:

```
Nested tables are extracted in both paths — from the tagged `/Table` tree, and (for ruled tables) in the geometry path via rule-hierarchy detection (a rule spanning < 90% of the table extent is treated as confined; a container cell whose confined rules form a ≥2×2 grid becomes a nested table). Each nested table is attached to its parent cell's `tables`, rendered as an inner `<table>` by `toHtml()`, and its text removed from the parent cell. Geometry nesting is heuristic (borderless/whitespace nested tables and multiple-tables-per-page are not detected). Still out of scope: rotated/skewed and cross-page tables.
```

- [ ] **Step 4: Full verification**

Run: `npm run typecheck && npm test && npm run build`
Expected: no type errors; entire suite green; `dist/` emitted.

- [ ] **Step 5: Record the beads memory and close the issue**

```bash
bd remember --key geometry-nested-table-extraction-shipped "Geometry-path nested tables shipped (e2o). src/table.ts buildRuledRegion(horiz,vert,frags,bbox) replaces the direct assembleTable call on the ruled path (via ruleBbox()). Classifies clustered rules structural (span>=SPAN_FRAC=0.9 of bbox extent) vs confined; builds a coarse structural-only grid for container cells; per container cell, qualifies confined rules as nested via Tier1 (confined lines alone, inset case) else Tier2 (plus container-cell edge rules, shared-border case), requiring rowCount>=2 && colCount>=2 (a lone spanning-cell divider fails -> no false positive). Returned outer table = assembleTable(all rules minus consumed confined, frags outside nested bboxes); nested attached to the containing outer cell via TableCell.tables (from 84u), recursed for arbitrary depth, parent text stripped via cellText. Regression-safe: no nested -> identical to assembleTable. Fixtures inline in test/table-nested.test.ts (inset, shared-border, deep, spanning-cell control). Deferred: whitespace/borderless nested + multiple-tables-per-page (fwc). Still open: 7ac cross-page, 5ct rotated."
bd close aspose-pdf-foss-for-ts-e2o
```

- [ ] **Step 6: Commit**

```bash
git add README.md test/table-nested.test.ts .beads
git commit -m "docs(e2o): document geometry nested tables; close issue

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

- [ ] **Step 7: Push (session-completion protocol)**

```bash
git pull --rebase
git push
git status   # MUST show "up to date with origin"
```

---

## Self-Review

**Spec coverage:**
- `buildRuledRegion` replacing `assembleTable` on the ruled path → Task 1 (seam) + Task 2 (algorithm). ✓
- Structural/confined classification by `SPAN_FRAC` → Task 2. ✓
- Coarse container grid + per-container Tier-1/Tier-2 qualification → Task 2. ✓
- Outer table = all rules minus consumed; frags outside nested bboxes → Task 2. ✓
- Attach + recurse (arbitrary depth) + text stripping → Task 2 (recursion), Task 4 (deep test). ✓
- Robust to both border styles → Task 2 (inset) + Task 3 (shared border). ✓
- Spanning-cell false-positive guard → Task 4. ✓
- Serialization via 84u `toHtml` → Task 5 test. ✓
- Regression-safe (byte-identical when no nesting) → Task 1 Step 4, Task 2 Step 5, Task 5 Step 4. ✓
- README + close-out → Task 5. ✓
- Out of scope (whitespace nested, multi-table `fwc`, `5ct`, `7ac`) → not implemented; README note. ✓

**Placeholder scan:** No TBD/TODO; every code step shows complete code, exact edit targets, and exact commands with expected results.

**Type consistency:** `buildRuledRegion(horiz, vert, frags, bbox)` and `ruleBbox(horiz, vert)` defined in Task 1, body completed in Task 2, called in `extractTables`. `NestedRegion { horiz: Rule[]; vert: Rule[]; bbox: Rect }` local to Task 2. Reuses existing `assembleTable`/`cellText`/`contains`/`centroid`/`SNAP`/`Rule`/`TableCell`/`Table`. `Table` has `rowCount`/`colCount`/`rows`/`quad`; `TableCell` has `quad`/`text`/`col`/`colSpan`/`tables?` (last from 84u). `Rule` = `{ pos; lo; hi }` used verbatim for the synthetic edge rules.
```

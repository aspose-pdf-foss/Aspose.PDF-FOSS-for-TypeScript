# Flow multi-float layout Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a flow column hold a left and a right float concurrently, with text in the middle channel, plus multiple floats stacked vertically per side.

**Architecture:** A new pure-arithmetic module `src/floatstack.ts` owns all float geometry (per-side insets at a pen y, the y where the channel next widens, pruning, and where a new box may go). `Flow.Render` swaps its single `activeFloat` variable for an `ActiveFloat[]` and consults that module — element `place()` and the public API are untouched.

**Tech Stack:** TypeScript (ESM + NodeNext, `strict`), vitest. No runtime dependencies.

**Spec:** `docs/superpowers/specs/2026-07-25-flow-multi-float-design.md`
**Issue:** `aspose-pdf-foss-for-ts-db7v.9` (epic db7v — Flow layout engine)

## Global Constraints

- **Zero runtime dependencies.** Only `node:` built-ins. Do not add npm runtime deps.
- **ESM + NodeNext:** every relative import specifier carries the `.js` extension (`from './floatstack.js'`), including in tests (`from '../src/floatstack.js'`).
- **Public API is unchanged.** `flow.AddFloatBox(box, side)`, `doc.NewFloatingBox(options)` and `FloatBoxOptions` keep their current shapes. Do not export `floatstack.ts` from `src/index.ts` — it is internal geometry.
- **Existing tests are the regression guard.** Every currently-green test in `test/flow.test.ts` and `test/floatbox.test.ts` must stay green **unmodified**. If one goes red, the change is wrong — do not edit the test.
- **Epsilon convention:** float comparisons use `1e-9`, matching `src/flow.ts`.
- **Coordinates:** PDF user space, y increasing upward. A float's `bottom` is the y its box reaches down to, so "lower on the page" means a *smaller* y.
- **Task tracking:** this project uses `bd` (beads). Do NOT create markdown TODO lists or use TodoWrite.
- **Quality gates before the final commit:** `npm run typecheck` and `npm test` both green.

## File Structure

- **Create `src/floatstack.ts`** — pure float geometry: `ActiveFloat`, `insetsAt`, `nextBoundary`, `pruneFloats`, `resolveFloatTop`. No PDF, document, or drawing knowledge; every function is a total function of its arguments.
- **Create `test/floatstack.test.ts`** — unit tests for the above, no PDF round-trip.
- **Modify `src/flow.ts`** — `Flow.Render` only (roughly lines 850–965): replace `activeFloat` with `floats: ActiveFloat[]`.
- **Modify `test/flow.test.ts`** — integration tests appended to the existing `describe('flow floating boxes')` block, plus a new tagging test.
- **Modify `README.md`** — the Flow floating-box paragraph (around line 463) currently says "one float is active at a time".

## Shared Test Geometry

Every integration test in Tasks 2–4 uses this flow geometry, which is the one the existing float tests already use:

```ts
const opts = () => ({
  format: PageFormat.custom(300, 500), columns: 1,
  marginLeft: 20, marginRight: 20, marginTop: 20, marginBottom: 20,
});
```

That yields `contentLeft = 20`, `contentTop = 480`, `contentBottom = 20`, `columnWidth = 260`, `columnHeight = 460`.

Two facts drive every expected number below — **verify them before debugging a failing expectation**:

1. **`FloatingBox.measure()` inserts `spacing` *between* items.** A box with N paragraphs at `leading: 12` and `spacing: 6` is `N*12 + (N-1)*6` tall, not `N*12`. A single-paragraph box is just `12`.
2. **A box's first item is laid out against the box's top edge**, so its baseline is a fixed offset below that top. The exact offset is *not* asserted anywhere in this plan — text assertions pin the **x** (which is exact and metric-free) and capture the **y** to compare against a known box edge. Do not hardcode a baseline y.

Assertions are made on the **content stream** (`new TextDecoder('latin1').decode(page.Contents)`), not on `GetTextFragments()`. `GetTextFragments` merges glyph runs whose baselines are within `max(2, 0.5*fontSize)` *regardless of horizontal gap direction*, so float text and beside-text on a shared baseline merge into one fragment and destroy the position being asserted. The content stream keeps them separate and is emitted in draw order.

Where an assertion needs a *width* (not just an x), the probe is a **flow image with an explicit `width` and `height`**, whose placement is metric-free: `drawBuiltImage` emits exactly

```
<w> 0 0 <h> <x> <y> cm
```

on its own line, and `ImageElement.place` computes `x = elemX + (elemWidth − drawW)` for `align: 'right'` and `x = elemX` for `align: 'left'`. A right-aligned image therefore pins both edges of the channel in one assertion.

---

### Task 1: Pure float geometry module

**Files:**
- Create: `src/floatstack.ts`
- Test: `test/floatstack.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `interface ActiveFloat { side: 'left' | 'right'; band: number; bottom: number }`
  - `insetsAt(floats: readonly ActiveFloat[], top: number): { left: number; right: number }`
  - `nextBoundary(floats: readonly ActiveFloat[], top: number): number | undefined`
  - `pruneFloats(floats: readonly ActiveFloat[], top: number): ActiveFloat[]`
  - `resolveFloatTop(floats: readonly ActiveFloat[], side: 'left' | 'right', width: number, spacing: number, naturalTop: number, columnWidth: number): number`

- [ ] **Step 1: Write the failing tests**

Create `test/floatstack.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import {
  insetsAt, nextBoundary, pruneFloats, resolveFloatTop, type ActiveFloat,
} from '../src/floatstack.js';

const L = (band: number, bottom: number): ActiveFloat => ({ side: 'left', band, bottom });
const R = (band: number, bottom: number): ActiveFloat => ({ side: 'right', band, bottom });

describe('insetsAt', () => {
  it('reports zero insets with no floats', () => {
    expect(insetsAt([], 470)).toEqual({ left: 0, right: 0 });
  });

  it('reports the band of a float in force', () => {
    expect(insetsAt([L(106, 400)], 470)).toEqual({ left: 106, right: 0 });
    expect(insetsAt([R(86, 400)], 470)).toEqual({ left: 0, right: 86 });
  });

  it('reports both sides concurrently', () => {
    expect(insetsAt([L(106, 400), R(86, 300)], 470)).toEqual({ left: 106, right: 86 });
  });

  it('takes the widest band per side (staircase)', () => {
    const fs = [L(106, 400), L(66, 300)];
    expect(insetsAt(fs, 470).left).toBe(106); // both in force → the wider wins
    expect(insetsAt(fs, 350).left).toBe(66);  // the wide one has been passed
  });

  it('ignores a float the pen has reached or passed', () => {
    expect(insetsAt([L(106, 400)], 400)).toEqual({ left: 0, right: 0 });
    expect(insetsAt([L(106, 400)], 399)).toEqual({ left: 0, right: 0 });
  });
});

describe('nextBoundary', () => {
  it('is undefined when no float is in force', () => {
    expect(nextBoundary([], 470)).toBeUndefined();
    expect(nextBoundary([L(106, 400)], 400)).toBeUndefined();
  });

  it('picks the highest bottom among the floats in force', () => {
    const fs = [L(106, 400), L(66, 300)];
    expect(nextBoundary(fs, 470)).toBe(400);
    expect(nextBoundary(fs, 350)).toBe(300);
  });

  it('spans both sides', () => {
    expect(nextBoundary([L(106, 300), R(86, 420)], 470)).toBe(420);
  });
});

describe('pruneFloats', () => {
  it('drops the floats the pen has passed and keeps the rest', () => {
    expect(pruneFloats([L(106, 400), L(66, 300)], 350)).toEqual([L(66, 300)]);
    expect(pruneFloats([L(106, 400)], 400)).toEqual([]);
    expect(pruneFloats([L(106, 400)], 470)).toEqual([L(106, 400)]);
  });
});

describe('resolveFloatTop', () => {
  it('returns naturalTop unchanged, by identity, when nothing pushes the box', () => {
    const naturalTop = 474;
    expect(resolveFloatTop([], 'left', 100, 6, naturalTop, 260)).toBe(naturalTop);
  });

  it('never shares a side: a same-side float pushes the box below it', () => {
    // left float bottom 400, spacing 6 → new box top 394.
    expect(resolveFloatTop([L(106, 400)], 'left', 100, 6, 474, 260)).toBe(394);
  });

  it('sits beside an opposing float when the box fits the remaining channel', () => {
    // left band 106 + width 100 = 206 <= 260 → unchanged.
    expect(resolveFloatTop([L(106, 400)], 'right', 100, 6, 474, 260)).toBe(474);
  });

  it('pushes below an opposing float the box cannot fit beside', () => {
    // left band 106 + width 160 = 266 > 260 → below the left float.
    expect(resolveFloatTop([L(106, 400)], 'right', 160, 6, 474, 260)).toBe(394);
  });

  it('resolves across both rules in successive passes', () => {
    // pass 1: same-side left in force → 400 - 6 = 394.
    // pass 2: opposing band 200 + width 100 = 300 > 260 → 250 - 6 = 244.
    // pass 3: nothing in force at 244 → done.
    expect(resolveFloatTop([L(106, 400), R(200, 250)], 'left', 100, 6, 474, 260)).toBe(244);
  });

  it('gives up rather than looping when the box exceeds the bare column', () => {
    // No opposing float to push below; the caller handles the overflow.
    expect(resolveFloatTop([], 'left', 400, 6, 474, 260)).toBe(474);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/floatstack.test.ts`
Expected: FAIL — `Failed to load ../src/floatstack.js` (the module does not exist yet).

- [ ] **Step 3: Write the implementation**

Create `src/floatstack.ts`:

```ts
/** Geometry for the floating boxes active in one flow column: the horizontal
 *  bands they exclude, where those bands end, and where a new box may go.
 *  Pure arithmetic — no PDF, document, or drawing knowledge. @internal */

/** Tolerance shared with flow.ts. */
const EPS = 1e-9;

/** A float occupying a horizontal band on one side of the column, down to
 *  `bottom` (PDF user space, y up). */
export interface ActiveFloat {
  side: 'left' | 'right';
  /** Horizontal space to avoid, measured from the column edge: width + spacing. */
  band: number;
  /** The y the box reaches down to. */
  bottom: number;
}

/** True while `f` still excludes space at pen y `top`. */
function inForce(f: ActiveFloat, top: number): boolean {
  return top > f.bottom + EPS;
}

/** Horizontal insets in force at pen y `top`: the widest band per side over the
 *  floats still in force, 0 for a side with none. */
export function insetsAt(
  floats: readonly ActiveFloat[], top: number,
): { left: number; right: number } {
  let left = 0;
  let right = 0;
  for (const f of floats) {
    if (!inForce(f, top)) continue;
    if (f.side === 'left') left = Math.max(left, f.band);
    else right = Math.max(right, f.band);
  }
  return { left, right };
}

/** The highest (largest y) bottom among the floats in force at `top` — the y at
 *  which the channel next widens. `undefined` when none is in force. */
export function nextBoundary(
  floats: readonly ActiveFloat[], top: number,
): number | undefined {
  let best: number | undefined;
  for (const f of floats) {
    if (!inForce(f, top)) continue;
    if (best === undefined || f.bottom > best) best = f.bottom;
  }
  return best;
}

/** Drop the floats the pen at `top` has passed. */
export function pruneFloats(
  floats: readonly ActiveFloat[], top: number,
): ActiveFloat[] {
  return floats.filter((f) => inForce(f, top));
}

/** The lowest (smallest y) bottom among the floats in force at `top` on `side`. */
function lowestBottom(
  floats: readonly ActiveFloat[], top: number, side: 'left' | 'right',
): number | undefined {
  let best: number | undefined;
  for (const f of floats) {
    if (f.side !== side || !inForce(f, top)) continue;
    if (best === undefined || f.bottom < best) best = f.bottom;
  }
  return best;
}

/** Resolve the top edge of a new float of `width` on `side`, starting from
 *  `naturalTop` (the pen minus the box's leading gap). Floats never share a
 *  side, so a same-side float in force pushes the box below it; an opposing
 *  float pushes it down only when the box no longer fits the channel it leaves.
 *  Returns `naturalTop` itself (identity) when nothing pushes the box — callers
 *  rely on that to decide whether the pen moves. */
export function resolveFloatTop(
  floats: readonly ActiveFloat[], side: 'left' | 'right', width: number,
  spacing: number, naturalTop: number, columnWidth: number,
): number {
  const opposite = side === 'left' ? 'right' : 'left';
  let top = naturalTop;
  // Each pass drops `top` below at least one float bottom, retiring it, so the
  // loop cannot run more times than there are floats.
  for (let pass = 0; pass <= floats.length; pass++) {
    const same = lowestBottom(floats, top, side);
    if (same !== undefined) { top = same - spacing; continue; }
    if (insetsAt(floats, top)[opposite] + width > columnWidth + EPS) {
      const low = lowestBottom(floats, top, opposite);
      // No opposing float left to clear: the box exceeds the bare column, which
      // is the caller's fit check to report.
      if (low === undefined) break;
      top = low - spacing;
      continue;
    }
    break;
  }
  return top;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/floatstack.test.ts`
Expected: PASS (23 assertions across 5 describes).

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: no output, exit 0.

- [ ] **Step 6: Commit**

```bash
git add src/floatstack.ts test/floatstack.test.ts
git commit -m "feat(flow): pure multi-float geometry module (db7v.9)

insetsAt/nextBoundary/pruneFloats/resolveFloatTop over an ActiveFloat list:
per-side widest band at a pen y, the y where the channel next widens, and
where a new box may go (never sharing a side; beside an opposing float only
when it still fits).

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 2: Text flows in the channel left by all active floats

Element *placement* starts consulting every active float. Box *placement* is still naive (Task 3) — this task only stops text from running through a box on the other side, and stops a closed channel from producing garbage geometry.

**Files:**
- Modify: `src/flow.ts` (imports; `Flow.Render`, currently lines 850–961)
- Test: `test/flow.test.ts` (append to the existing `describe('flow floating boxes')` block)

**Interfaces:**
- Consumes: `ActiveFloat`, `insetsAt`, `nextBoundary`, `pruneFloats` from Task 1.
- Produces: `Flow.Render`'s per-column state is now `let floats: ActiveFloat[]`, cleared by `advanceColumn`. Task 3 replaces the float branch's `boxTop` computation and pen update.

- [ ] **Step 1: Write the failing tests**

Append inside `describe('flow floating boxes', ...)` in `test/flow.test.ts`, after the existing `'is chainable'` test:

```ts
  it('left + right floats are active at once: text flows in the middle channel', () => {
    const doc = Document.Open(buildBlankPage());
    const flow = doc.NewFlow(opts());
    // Left box: 5 paragraphs → 5*12 + 4*6 = 84 tall, bottom 480-84 = 396, band 86.
    const left = doc.NewFloatingBox({ width: 80, spacing: 6 });
    for (let i = 1; i <= 5; i++) left.AddParagraph(`L${i}`, { fontSize: 10, leading: 12 });
    // Right box: 3 paragraphs → 3*12 + 2*6 = 48 tall, top 474, bottom 426, band 86.
    const right = doc.NewFloatingBox({ width: 80, spacing: 6 });
    for (let i = 1; i <= 3; i++) right.AddParagraph(`R${i}`, { fontSize: 10, leading: 12 });
    flow.AddFloatBox(left, 'left');
    flow.AddFloatBox(right, 'right');
    // Two image probes pin the two channel edges. One alone cannot: a
    // right-aligned image lands at columnX + columnWidth - insetR, in which the
    // left inset cancels out, so it is blind to the left float.
    flow.AddImage(buildPngRgb(), { align: 'left', width: 40, height: 24 });
    flow.AddImage(buildPngRgb(), { align: 'right', width: 40, height: 24 });
    const [page] = flow.Render();
    const content = new TextDecoder('latin1').decode(page.Contents);
    // Channel at top 474: x = 20+86 = 106, width = 260-86-86 = 88.
    // Left-aligned probe → x = 106, y = 474-24 = 450.
    expect(content).toMatch(/(^|\n)40 0 0 24 106 450 cm/);
    // Right-aligned probe, one row down → x = 106 + (88-40) = 154, y = 426.
    expect(content).toMatch(/(^|\n)40 0 0 24 154 426 cm/);
    // Both boxes painted at their column edges: left at 20, right at 20+260-80 = 200.
    expect(content).toMatch(/(^|\n)20 [\d.]+ Td\s+\(L1\)/);
    expect(content).toMatch(/(^|\n)200 [\d.]+ Td\s+\(R1\)/);
  });

  it('a channel closed by both bands skips to where it reopens', () => {
    const doc = Document.Open(buildBlankPage());
    const flow = doc.NewFlow(opts());
    // Bands 136 and 126 sum to 262 > columnWidth 260 → the channel is negative.
    const left = doc.NewFloatingBox({ width: 130, spacing: 6 });
    for (let i = 1; i <= 3; i++) left.AddParagraph(`L${i}`, { fontSize: 10, leading: 12 });
    const right = doc.NewFloatingBox({ width: 120, spacing: 6 });
    right.AddParagraph('R1', { fontSize: 10, leading: 12 });
    flow.AddFloatBox(left, 'left');   // 48 tall, bottom 432
    flow.AddFloatBox(right, 'right'); // 12 tall, top 474, bottom 462
    flow.AddImage(buildPngRgb(), { align: 'left', width: 40, height: 24 });
    const [page] = flow.Render();
    const content = new TextDecoder('latin1').decode(page.Contents);
    // Skips to the right box's bottom (462), where only the left band remains:
    // x = 20+136 = 156, avail = 462-432 = 30 >= 24, y = 462-24 = 438.
    expect(content).toMatch(/(^|\n)40 0 0 24 156 438 cm/);
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/flow.test.ts -t "middle channel"`
Expected: FAIL on the **left-aligned** probe — only the right float is tracked, so the region starts at `columnX` (20) and the image lands at `20 450` instead of `106 450`.

> A right-aligned probe alone would pass against the old code: it lands at `elemX + elemWidth`, which expands to `columnX + columnWidth − insetR` — the left inset cancels out. Both probes are required.

Run: `npx vitest run test/flow.test.ts -t "closed by both bands"`
Expected: FAIL — no matching `cm` line (the image is placed against a stale single-float region).

- [ ] **Step 3: Add the import to `src/flow.ts`**

After the existing `import { PageFormat } from './pageformat.js';` line near the top:

```ts
import {
  insetsAt, nextBoundary, pruneFloats, type ActiveFloat,
} from './floatstack.js';
```

- [ ] **Step 4: Replace the per-column float state**

In `Flow.Render`, replace:

```ts
    // A single active float in the current column (option A: one at a time).
    // `band` is the horizontal space to avoid; `bottom` the y the box reaches down to.
    let activeFloat: { side: 'left' | 'right'; band: number; bottom: number } | undefined;
```

with:

```ts
    // Floats active in the current column: left and right concurrently, stacked
    // vertically per side. `band` is the horizontal space to avoid; `bottom` the
    // y the box reaches down to.
    let floats: ActiveFloat[] = [];
```

and in `advanceColumn`, replace `activeFloat = undefined;` with `floats = [];`.

- [ ] **Step 5: Replace the loop-top clear**

Replace:

```ts
      // Clear a float once the pen has passed its bottom.
      if (activeFloat && colTop <= activeFloat.bottom + 1e-9) activeFloat = undefined;
```

with:

```ts
      // Clear the floats the pen has passed.
      floats = pruneFloats(floats, colTop);
```

- [ ] **Step 6: Record a placed float in the list**

In the `isFloat(item)` branch, replace:

```ts
        activeFloat = { side: item.side, band: box.width + box.spacing, bottom: boxTop - h };
```

with:

```ts
        floats.push({ side: item.side, band: box.width + box.spacing, bottom: boxTop - h });
```

Leave the rest of that branch (including `const boxTop = colTop - gap;` and `colTop = boxTop;`) alone — Task 3 handles it.

- [ ] **Step 7: Compute the element region from all active floats**

Replace:

```ts
      // Region: narrowed beside an active float, and capped at the float bottom so
      // the element re-flows below the box at full width.
      const besideFloat = activeFloat !== undefined && top > activeFloat.bottom + 1e-9;
      let elemX = columnX(g, col);
      let elemWidth = g.columnWidth;
      let availHeight = top - g.contentBottom;
      if (besideFloat) {
        if (activeFloat!.side === 'left') elemX = columnX(g, col) + activeFloat!.band;
        elemWidth = g.columnWidth - activeFloat!.band;
        availHeight = top - activeFloat!.bottom;
      }
```

with:

```ts
      // Region: narrowed by the floats in force at `top`, and capped at the y
      // where the channel next widens so the element re-flows there.
      const { left: insetL, right: insetR } = insetsAt(floats, top);
      const besideFloat = insetL > 0 || insetR > 0;
      // Defined whenever besideFloat: a non-zero inset means a float is in force.
      const boundary = besideFloat ? nextBoundary(floats, top)! : 0;
      const elemX = columnX(g, col) + insetL;
      const elemWidth = g.columnWidth - insetL - insetR;
      const availHeight = besideFloat ? top - boundary : top - g.contentBottom;

      // A left and a right band can swallow the column between them: skip the pen
      // to where it reopens rather than placing into a negative-width region.
      if (elemWidth <= 0) {
        colTop = boundary;
        floats = pruneFloats(floats, colTop);
        continue;
      }
```

The keep-with-next block below needs **no edit**: it already guards on `!besideFloat`, and `besideFloat` now means "either inset is non-zero", which is exactly the scope the spec calls for.

- [ ] **Step 8: Reflow at the boundary instead of clearing the one float**

Replace, in the `res.drew` branch:

```ts
          if (besideFloat) {
            // Reflowed at the float bottom: continue full width below the box.
            colTop = activeFloat!.bottom;
            activeFloat = undefined;
          } else {
```

with:

```ts
          if (besideFloat) {
            // Reflowed where the channel widens: continue there — possibly still
            // beside a taller float on the other side.
            colTop = boundary;
            floats = pruneFloats(floats, colTop);
          } else {
```

and replace the "nothing painted" beside-float branch:

```ts
      if (besideFloat) {
        // Could not fit even one line beside the float: skip past it, retry full width.
        colTop = activeFloat!.bottom;
        activeFloat = undefined;
        continue;
      }
```

with:

```ts
      if (besideFloat) {
        // Could not fit even one line in this channel: skip to where it widens.
        colTop = boundary;
        floats = pruneFloats(floats, colTop);
        continue;
      }
```

- [ ] **Step 9: Run the new tests, then the whole flow suite**

Run: `npx vitest run test/flow.test.ts`
Expected: PASS — both new tests, **and every pre-existing test in the file unmodified**. A single float now produces byte-identical output: `insetsAt` returns its band, `nextBoundary` returns its bottom, so the region math is the same expression as before.

Run: `npx vitest run test/floatbox.test.ts && npm run typecheck`
Expected: PASS, then no typecheck output.

- [ ] **Step 10: Commit**

```bash
git add src/flow.ts test/flow.test.ts
git commit -m "feat(flow): text flows in the channel left by all active floats (db7v.9)

Render tracks an ActiveFloat list instead of one activeFloat, so a left and a
right box narrow the region concurrently and the element re-flows wherever the
channel next widens. A channel closed by both bands skips to where it reopens
instead of placing into a negative-width region.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 3: Stack floats per side, and never move the pen past one

Box *placement*: a same-side float pushes the new box below it (fixing the current silent overlap), an opposing float pushes it down only when it no longer fits beside, and a pushed box leaves the pen where it was.

**Files:**
- Modify: `src/flow.ts` (`Flow.Render`, the `isFloat(item)` branch)
- Test: `test/flow.test.ts` (append to `describe('flow floating boxes')`)

**Interfaces:**
- Consumes: `resolveFloatTop` from Task 1; the `floats: ActiveFloat[]` state from Task 2.
- Produces: no new exports.

- [ ] **Step 1: Write the failing tests**

Append inside `describe('flow floating boxes', ...)`:

```ts
  it('same-side floats stack vertically instead of overlapping', () => {
    const doc = Document.Open(buildBlankPage());
    const flow = doc.NewFlow(opts());
    // A: 3 paragraphs → 3*12 + 2*6 = 48 tall. Top 480, bottom 432.
    const a = doc.NewFloatingBox({ width: 100, spacing: 6 });
    for (let i = 1; i <= 3; i++) a.AddParagraph(`A${i}`, { fontSize: 10, leading: 12 });
    // B: 2 paragraphs → 2*12 + 6 = 30 tall. Pushed to A.bottom - spacing = 426.
    const b = doc.NewFloatingBox({ width: 60, spacing: 6 });
    for (let i = 1; i <= 2; i++) b.AddParagraph(`B${i}`, { fontSize: 10, leading: 12 });
    flow.AddFloatBox(a, 'left');
    flow.AddFloatBox(b, 'left');
    const [page] = flow.Render();
    const content = new TextDecoder('latin1').decode(page.Contents);
    // Both boxes paint at the column edge (x = 20).
    const a1 = /(?:^|\n)20 ([\d.]+) Td\s+\(A1\)/.exec(content);
    const b1 = /(?:^|\n)20 ([\d.]+) Td\s+\(B1\)/.exec(content);
    expect(a1).not.toBeNull();
    expect(b1).not.toBeNull();
    // B starts strictly below A's bottom edge (432) — today it overlaps at ~464.
    expect(Number(a1![1])).toBeGreaterThan(432);
    expect(Number(b1![1])).toBeLessThan(432);
  });

  it('a pushed float leaves the pen alone, so text fills the upper channel first', () => {
    const doc = Document.Open(buildBlankPage());
    const flow = doc.NewFlow(opts());
    const a = doc.NewFloatingBox({ width: 100, spacing: 6 }); // band 106, bottom 432
    for (let i = 1; i <= 3; i++) a.AddParagraph(`A${i}`, { fontSize: 10, leading: 12 });
    const b = doc.NewFloatingBox({ width: 60, spacing: 6 });  // band 66, top 426, bottom 396
    for (let i = 1; i <= 2; i++) b.AddParagraph(`B${i}`, { fontSize: 10, leading: 12 });
    flow.AddFloatBox(a, 'left');
    flow.AddFloatBox(b, 'left');
    // Three left-aligned 40x24 images: their x is exactly the channel's left edge.
    for (let i = 0; i < 3; i++) flow.AddImage(buildPngRgb(), { align: 'left', width: 40, height: 24 });
    const [page] = flow.Render();
    const content = new TextDecoder('latin1').decode(page.Contents);
    // Pen still at 480 (B was pushed): first two images sit beside the WIDE box A
    // at x = 20+106 = 126, filling 480→432 exactly (2 * 24).
    expect(content).toMatch(/(^|\n)40 0 0 24 126 456 cm/);
    expect(content).toMatch(/(^|\n)40 0 0 24 126 432 cm/);
    // Third image: A is passed, so the staircase steps left to B's band,
    // x = 20+66 = 86, y = 432-24 = 408.
    expect(content).toMatch(/(^|\n)40 0 0 24 86 408 cm/);
  });

  it('a float too wide to sit beside an opposing float is pushed below it', () => {
    const doc = Document.Open(buildBlankPage());
    const flow = doc.NewFlow(opts());
    const left = doc.NewFloatingBox({ width: 100, spacing: 6 }); // band 106, bottom 432
    for (let i = 1; i <= 3; i++) left.AddParagraph(`L${i}`, { fontSize: 10, leading: 12 });
    // 106 + 160 = 266 > columnWidth 260 → cannot sit beside; pushed to 432-6 = 426.
    const wide = doc.NewFloatingBox({ width: 160, spacing: 6 });
    wide.AddParagraph('R1', { fontSize: 10, leading: 12 });
    flow.AddFloatBox(left, 'left');
    flow.AddFloatBox(wide, 'right');
    const [page] = flow.Render();
    const content = new TextDecoder('latin1').decode(page.Contents);
    // x = 20+260-160 = 120, and it starts below the left box's bottom (432).
    const r1 = /(?:^|\n)120 ([\d.]+) Td\s+\(R1\)/.exec(content);
    expect(r1).not.toBeNull();
    expect(Number(r1![1])).toBeLessThan(432);
  });

  it('a float that still fits beside an opposing float stays at the pen', () => {
    const doc = Document.Open(buildBlankPage());
    const flow = doc.NewFlow(opts());
    const left = doc.NewFloatingBox({ width: 100, spacing: 6 }); // band 106
    for (let i = 1; i <= 3; i++) left.AddParagraph(`L${i}`, { fontSize: 10, leading: 12 });
    // 106 + 140 = 246 <= 260 → sits beside, at the natural top 480-6 = 474.
    const fits = doc.NewFloatingBox({ width: 140, spacing: 6 });
    fits.AddParagraph('R1', { fontSize: 10, leading: 12 });
    flow.AddFloatBox(left, 'left');
    flow.AddFloatBox(fits, 'right');
    const [page] = flow.Render();
    const content = new TextDecoder('latin1').decode(page.Contents);
    // x = 20+260-140 = 140, and it stays level with the left box (above 432).
    const r1 = /(?:^|\n)140 ([\d.]+) Td\s+\(R1\)/.exec(content);
    expect(r1).not.toBeNull();
    expect(Number(r1![1])).toBeGreaterThan(432);
  });

  it('a stacked float that overruns the column moves to the next page', () => {
    const doc = Document.Open(buildBlankPage());
    const flow = doc.NewFlow(opts());
    // A: 12 paragraphs → 12*12 + 11*6 = 210 tall, bottom 480-210 = 270.
    const a = doc.NewFloatingBox({ width: 100, spacing: 6 });
    for (let i = 1; i <= 12; i++) a.AddParagraph(`A${i}`, { fontSize: 10, leading: 12 });
    // B: 17 paragraphs → 17*12 + 16*6 = 300 tall. Stacked at 270-6 = 264 it would
    // end at -36, below contentBottom 20 → next page, where it starts at 480.
    const b = doc.NewFloatingBox({ width: 100, spacing: 6 });
    for (let i = 1; i <= 17; i++) b.AddParagraph(`B${i}`, { fontSize: 10, leading: 12 });
    flow.AddFloatBox(a, 'left');
    flow.AddFloatBox(b, 'left');
    const pages = flow.Render();
    expect(pages).toHaveLength(2);
    expect(pages[0].GetText()).toContain('A1');
    expect(pages[0].GetText()).not.toContain('B1');
    expect(pages[1].GetText()).toContain('B1');
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/flow.test.ts -t "stack vertically"`
Expected: FAIL — B is placed at top 474, overlapping box A, so its captured y is above 432 rather than below it.

Run: `npx vitest run test/flow.test.ts -t "leaves the pen alone"`
Expected: FAIL — no image at `126 456`.

Run: `npx vitest run test/flow.test.ts -t "pushed below it"`
Expected: FAIL — the wide right box is placed at top 474 beside the left box (captured y above 432), overlapping it.

Run: `npx vitest run test/flow.test.ts -t "still fits beside"`
Expected: PASS already — it characterises the "nothing pushes the box" path, which must keep returning `naturalTop`. Keep it: it is what catches an over-eager `resolveFloatTop`.

Run: `npx vitest run test/flow.test.ts -t "overruns the column"`
Expected: FAIL — both boxes land on one page, so `pages` has length 1.

- [ ] **Step 3: Extend the import**

In `src/flow.ts`, extend the `./floatstack.js` import added in Task 2 to:

```ts
import {
  insetsAt, nextBoundary, pruneFloats, resolveFloatTop, type ActiveFloat,
} from './floatstack.js';
```

- [ ] **Step 4: Resolve the box top and hold the pen**

In the `isFloat(item)` branch of `Flow.Render`, replace:

```ts
        const gap = atColumnStart ? 0 : pendingSpaceAfter + g.paragraphSpacing + box.spacing;
        const boxTop = colTop - gap;
```

with:

```ts
        const gap = atColumnStart ? 0 : pendingSpaceAfter + g.paragraphSpacing + box.spacing;
        const naturalTop = colTop - gap;
        // Never share a side; sit beside an opposing float only when the box
        // still fits the channel it leaves.
        const boxTop = resolveFloatTop(
          floats, item.side, box.width, box.spacing, naturalTop, g.columnWidth);
```

and replace:

```ts
        colTop = boxTop;
        atColumnStart = false;
```

with:

```ts
        // A float never advances the pen past itself: one placed at the pen
        // consumes its leading gap, a pushed one leaves the pen alone. The
        // comparison is exact — resolveFloatTop returns the very naturalTop it
        // was given when nothing pushes the box.
        if (boxTop === naturalTop) colTop = boxTop;
        atColumnStart = false;
```

The existing fit check (`if (boxTop - h < g.contentBottom - 1e-9)`) and its throw stay exactly as they are: `atColumnStart` implies `floats` is empty (placing a float clears `atColumnStart`, `advanceColumn` clears `floats`), so the retry after `advanceColumn` either fits or throws.

- [ ] **Step 5: Run the new tests, then the whole flow suite**

Run: `npx vitest run test/flow.test.ts`
Expected: PASS — the five new tests, Task 2's two, and every pre-existing test unmodified. In particular the existing `'a box taller than a full column throws'` must still throw: `atColumnStart` implies no active floats, so `resolveFloatTop` returns `naturalTop` and the fit check reaches the same throw as before.

Run: `npm run typecheck`
Expected: no output, exit 0.

- [ ] **Step 6: Commit**

```bash
git add src/flow.ts test/flow.test.ts
git commit -m "feat(flow): stack floats per side and hold the pen (db7v.9)

A new float resolves its top through resolveFloatTop: below any same-side
float, and below an opposing float only when it no longer fits beside. A
pushed float leaves the pen where it was, so text fills the upper channel
first and steps through the staircase as each band is passed.

Fixes the silent overlap of two same-side floats.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 4: Tagging order, load-bearing verification, and docs

**Files:**
- Test: `test/flow.test.ts` (append to `describe('flow floating box tagging')`)
- Modify: `README.md` (the Flow floating-box paragraph, around line 463)

**Interfaces:**
- Consumes: everything from Tasks 1–3.
- Produces: nothing.

- [ ] **Step 1: Write the failing test**

Append inside `describe('flow floating box tagging', ...)`, after the existing `/Figure` test:

```ts
  it('two stacked floats tag in flow order, before the wrapping text', () => {
    const doc = Document.Open(buildBlankPage());
    const flow = doc.NewFlow(tagged());
    const a = doc.NewFloatingBox({ width: 100, spacing: 6, alt: 'boxA' });
    a.AddImage(buildPngRgb(), { width: 40, height: 24 });
    const b = doc.NewFloatingBox({ width: 100, spacing: 6, alt: 'boxB' });
    b.AddImage(buildPngRgb(), { width: 40, height: 24 });
    flow.AddFloatBox(a, 'left');
    flow.AddFloatBox(b, 'left');
    flow.AddParagraph('body text beside the two stacked boxes', { fontSize: 10, leading: 12 });
    flow.Render();

    const sect = doc.CreateStructTree().Children.find((c) => c.Type === 'Sect')!;
    const kinds = sect.Children.map((c) => c.Type);
    // Both boxes tag, in the order they were floated.
    expect(sect.Children.filter((c) => c.Type === 'Figure').map((c) => c.Alt))
      .toEqual(['boxA', 'boxB']);
    // The wrapping paragraph comes after both.
    expect(kinds.lastIndexOf('P')).toBeGreaterThan(kinds.lastIndexOf('Figure'));
  });
```

- [ ] **Step 2: Run the test**

Run: `npx vitest run test/flow.test.ts -t "tag in flow order"`
Expected: PASS. Tagging is untouched by Tasks 1–3, so this is a characterization test that locks the ordering in. If it fails, a float is landing on a second page — recheck the box heights (24 + no inter-item spacing for a single-item box).

- [ ] **Step 3: Prove the new assertions are load-bearing**

For each mutation below: apply it, run the named command, confirm **RED**, then `git checkout -- src/` before the next one. Per CLAUDE.md, a green fixture is not evidence — the code path must be shown to be covered.

| Mutation in `src/flow.ts` / `src/floatstack.ts` | Command | Must go red |
|---|---|---|
| `insetsAt`: return `{ left: 0, right: 0 }` unconditionally | `npx vitest run test/floatstack.test.ts test/flow.test.ts` | insets + middle-channel + staircase |
| `insetsAt`: use `Math.min` instead of `Math.max` per side | `npx vitest run test/floatstack.test.ts test/flow.test.ts` | staircase tests |
| `nextBoundary`: return the *lowest* bottom (`f.bottom < best`) | `npx vitest run test/flow.test.ts` | closed-channel + staircase |
| Delete the `if (elemWidth <= 0)` guard | `npx vitest run test/flow.test.ts -t "closed by both bands"` | closed-channel test |
| `resolveFloatTop`: `return naturalTop` immediately | `npx vitest run test/floatstack.test.ts test/flow.test.ts` | stacking, too-wide push, overrun |
| Pen rule: change `if (boxTop === naturalTop)` to unconditional `colTop = boxTop` | `npx vitest run test/flow.test.ts -t "leaves the pen alone"` | pen test |

Record the outcome in the commit message if any mutation stays green — that means an assertion is decorative and needs strengthening before the task is done.

- [ ] **Step 4: Update the README**

In `README.md`, replace:

```
'right')` floats it so surrounding text wraps in the narrowed channel beside it
and resumes full width below (one float is active at a time). Simultaneous/stacked
floats are tracked as follow-up work.
```

with:

```
'right')` floats it so surrounding text wraps in the narrowed channel beside it
and resumes full width below. A left and a right box can float at once (text
flows in the middle channel), and several boxes on the same side stack
vertically — a box never shares a side, and only sits beside an opposing box
when it still fits the remaining channel. A float never pushes the text pen
past itself, so text fills the channel beside the upper box first and widens as
each box is passed. Floats are per-column: `AddColumnBreak` (and automatic
pagination) clears them. CSS-style `clear` controls and carrying a float across
a column boundary are tracked as follow-up work.
```

- [ ] **Step 5: Run the full quality gates**

Run: `npm run typecheck`
Expected: no output, exit 0.

Run: `npm test`
Expected: the entire suite green.

- [ ] **Step 6: Commit**

```bash
git add test/flow.test.ts README.md
git commit -m "test(flow): tagging order for stacked floats; document multi-float (db7v.9)

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

- [ ] **Step 7: Close the issue and push**

```bash
bd close aspose-pdf-foss-for-ts-db7v.9
git pull --rebase
git push
git status   # MUST show "up to date with origin"
```

---

## Notes for the implementer

- **If an expected coordinate is off**, re-derive it from the two facts in *Shared Test Geometry* before touching `src/`. The most common slip is forgetting that `FloatingBox.measure()` adds `spacing` *between* items, which changes every box height and therefore every `bottom`.
- **Never edit a pre-existing test to make it pass.** A single float must behave exactly as before; if an old test goes red, the region math or the pen rule is wrong.
- **`boundary` is only meaningful when `besideFloat` is true.** It is initialised to `0` in the false branch purely to keep it a `number`; every read of it is guarded by `besideFloat` (or by the `elemWidth <= 0` check, which can only trigger when both insets are non-zero).

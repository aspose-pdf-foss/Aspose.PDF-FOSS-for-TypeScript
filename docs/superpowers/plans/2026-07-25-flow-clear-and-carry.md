# Flow float clearing and deferred-float carry Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give flow elements a CSS-style `clear`, and stop a float that does not fit the remaining column height from dragging all following content into the next column.

**Architecture:** `src/floatstack.ts` gains one pure function (`clearTo`) and the `ClearSide` union. `Flow.Render` gains a four-line clear block before the gap computation, and a `pending: FloatItem[]` queue that defers a non-fitting float instead of advancing the column. Element `place()` is untouched.

**Tech Stack:** TypeScript (ESM + NodeNext, `strict`), vitest. No runtime dependencies.

**Spec:** `docs/superpowers/specs/2026-07-25-flow-clear-and-carry-design.md`
**Issue:** `aspose-pdf-foss-for-ts-db7v.10` (epic db7v — Flow layout engine, last child)

## Global Constraints

- **Zero runtime dependencies.** Only `node:` built-ins. Do not add npm runtime deps.
- **ESM + NodeNext:** every relative import specifier carries the `.js` extension (`from './floatstack.js'`), including in tests (`from '../src/flow.js'`).
- **`src/floatstack.ts` imports nothing.** It is pure geometry; keep it that way. The `ClearSide` union is defined there and re-exported by `flow.ts`, never the reverse (`flow.ts` imports `floatstack.ts`, so the opposite direction is circular).
- **Existing tests are the regression guard.** Every currently-green test in `test/flow.test.ts`, `test/floatbox.test.ts` and `test/floatstack.test.ts` must stay green **unmodified**. If one goes red, the change is wrong — do not edit the test.
- **Epsilon convention:** float comparisons use `1e-9`, matching `src/flow.ts`.
- **Coordinates:** PDF user space, y increasing upward. A float's `bottom` is the y its box reaches down to, so "lower on the page" means a *smaller* y, and "the lowest float" is the one with the **smallest** `bottom`.
- **Task tracking:** this project uses `bd` (beads). Do NOT create markdown TODO lists or use TodoWrite.
- **Quality gates before the final commit:** `npm run typecheck` and `npm test` both green.

## File Structure

- **Modify `src/floatstack.ts`** — add `export type ClearSide` and `export function clearTo`. No other change.
- **Modify `test/floatstack.test.ts`** — a `describe('clearTo')` block.
- **Modify `src/flow.ts`** — the `FlowClear` type alias, `clear` on three option interfaces and the `FlowElement` interface, a `normalizeClear` validator, the three element constructors, and two edits in `Flow.Render`.
- **Modify `src/index.ts`** — add `FlowClear` to the flow type export list (line ~70).
- **Modify `test/flow.test.ts`** — integration tests.
- **Modify `README.md`** — the Flow floating-box paragraph.

## Shared Test Geometry

Tests in Tasks 2 and 4 use the single-column geometry the existing float tests use:

```ts
const opts = () => ({
  format: PageFormat.custom(300, 500), columns: 1,
  marginLeft: 20, marginRight: 20, marginTop: 20, marginBottom: 20,
});
```

→ `contentLeft = 20`, `contentTop = 480`, `contentBottom = 20`, `columnWidth = 260`, `columnHeight = 460`.

Task 3 uses a two-column geometry so a column boundary is visible on one page:

```ts
const twoCol = () => ({
  format: PageFormat.custom(400, 300), columns: 2, columnGap: 20,
  marginLeft: 20, marginRight: 20, marginTop: 20, marginBottom: 20,
});
```

→ `contentTop = 280`, `contentBottom = 20`, `columnWidth = (360-20)/2 = 170`, `columnX(0) = 20`, `columnX(1) = 210`.

Three facts drive every expected number — **verify them before debugging a failing expectation**:

1. **`FloatingBox.measure()` inserts `spacing` *between* items.** A box with N paragraphs at `leading: 12` and `spacing: 6` is `N*12 + (N-1)*6` tall. A single-paragraph box is just `12`.
2. **Assertions go against the content stream** (`new TextDecoder('latin1').decode(page.Contents)`), never `GetTextFragments()` — that merges glyph runs whose baselines are within `max(2, 0.5*fontSize)` with no directional gap check, so float text and beside-text on a shared baseline collapse into one fragment.
3. **A flow image with explicit `width`/`height` is the metric-free probe.** `drawBuiltImage` emits `<w> 0 0 <h> <x> <y> cm` on its own line, and `ImageElement.place` computes `x = elemX` for `align: 'left'` and `x = elemX + (elemWidth - drawW)` for `align: 'right'`.
   **A right-aligned probe alone cannot detect a left inset** — it lands at `columnX + columnWidth - insetR`, in which `insetL` cancels out. Whenever a test needs to pin *both* channel edges, it needs both probes.

Text assertions pin the **x** (exact and metric-free) and capture the **y** to compare against a known box edge. Do not hardcode a baseline y.

---

### Task 1: `clearTo` geometry

**Files:**
- Modify: `src/floatstack.ts`
- Test: `test/floatstack.test.ts`

**Interfaces:**
- Consumes: `ActiveFloat` (already in `src/floatstack.ts`).
- Produces:
  - `export type ClearSide = 'left' | 'right' | 'both'`
  - `export function clearTo(floats: readonly ActiveFloat[], side: ClearSide): number | undefined`

- [ ] **Step 1: Write the failing tests**

Append to `test/floatstack.test.ts` (the `L`/`R` helpers already exist at the top of that file):

```ts
describe('clearTo', () => {
  it('is undefined when the requested side carries no float', () => {
    expect(clearTo([], 'both')).toBeUndefined();
    expect(clearTo([L(106, 400)], 'right')).toBeUndefined();
    expect(clearTo([R(86, 400)], 'left')).toBeUndefined();
  });

  it('returns the bottom of the float on the requested side', () => {
    expect(clearTo([L(106, 400)], 'left')).toBe(400);
    expect(clearTo([R(86, 300)], 'right')).toBe(300);
  });

  it('is side-selective: it ignores the other side entirely', () => {
    const fs = [L(106, 400), R(86, 300)];
    expect(clearTo(fs, 'left')).toBe(400);   // not 300 — the right float is not cleared
    expect(clearTo(fs, 'right')).toBe(300);
  });

  it("'both' clears every float", () => {
    expect(clearTo([L(106, 400), R(86, 300)], 'both')).toBe(300);
  });

  it('picks the LOWEST bottom when a side carries stacked floats', () => {
    // Smaller y = further down the page. Clearing must pass the lower box.
    expect(clearTo([L(106, 400), L(66, 250)], 'left')).toBe(250);
  });
});
```

Add `clearTo` to the existing import at the top of the file:

```ts
import {
  clearTo, insetsAt, nextBoundary, pruneFloats, resolveFloatTop, type ActiveFloat,
} from '../src/floatstack.js';
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/floatstack.test.ts`
Expected: FAIL — `clearTo is not a function` (or a TS resolution error on the import).

- [ ] **Step 3: Write the implementation**

Append to `src/floatstack.ts`:

```ts
/** Which side's floats an element must clear. */
export type ClearSide = 'left' | 'right' | 'both';

/** The y to drop the pen to so `side` is cleared: the lowest (smallest y)
 *  bottom among the floats on the requested side(s). `undefined` when the
 *  requested side carries no float.
 *
 *  Takes no `top`: callers prune first, so every float in the list is in force. */
export function clearTo(
  floats: readonly ActiveFloat[], side: ClearSide,
): number | undefined {
  let best: number | undefined;
  for (const f of floats) {
    if (side !== 'both' && f.side !== side) continue;
    if (best === undefined || f.bottom < best) best = f.bottom;
  }
  return best;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/floatstack.test.ts`
Expected: PASS — 20 tests (the 15 from db7v.9 plus these 5).

Run: `npm run typecheck`
Expected: no output, exit 0.

- [ ] **Step 5: Commit**

```bash
git add src/floatstack.ts test/floatstack.test.ts
git commit -m "feat(flow): clearTo float geometry (db7v.10)

The y to drop the pen to so a side is cleared: the lowest bottom among the
floats on that side, side-selective so 'left' leaves a deeper right float in
force.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 2: `clear` on flow elements

**Files:**
- Modify: `src/flow.ts` (imports, type alias, 3 option interfaces, `FlowElement`, `normalizeClear`, 3 element constructors, `Flow.Render`)
- Modify: `src/index.ts` (flow type export list, ~line 70)
- Test: `test/flow.test.ts`

**Interfaces:**
- Consumes: `clearTo`, `ClearSide` from Task 1.
- Produces: `export type FlowClear = ClearSide` from `src/flow.ts`; `clear?: FlowClear` on `FlowParagraphOptions`, `FlowListOptions`, `FlowImageOptions`; `readonly clear?: FlowClear` on `FlowElement`.

- [ ] **Step 1: Write the failing tests**

Append a new `describe` block at the end of `test/flow.test.ts`:

```ts
describe('flow float clearing', () => {
  const opts = () => ({
    format: PageFormat.custom(300, 500), columns: 1,
    marginLeft: 20, marginRight: 20, marginTop: 20, marginBottom: 20,
  });

  /** Left box 84 tall (bottom 396, band 86) + right box 48 tall (top 474,
   *  bottom 426, band 86). Channel between them: x 106, width 88. */
  const twoFloats = (doc: Document, flow: Flow) => {
    const left = doc.NewFloatingBox({ width: 80, spacing: 6 });
    for (let i = 1; i <= 5; i++) left.AddParagraph(`L${i}`, { fontSize: 10, leading: 12 });
    const right = doc.NewFloatingBox({ width: 80, spacing: 6 });
    for (let i = 1; i <= 3; i++) right.AddParagraph(`R${i}`, { fontSize: 10, leading: 12 });
    flow.AddFloatBox(left, 'left');
    flow.AddFloatBox(right, 'right');
  };

  it('without clear, a heading sits in the channel between the floats', () => {
    const doc = Document.Open(buildBlankPage());
    const flow = doc.NewFlow(opts());
    twoFloats(doc, flow);
    flow.AddHeading(2, 'SECTION', { fontSize: 10 });
    const [page] = flow.Render();
    const content = new TextDecoder('latin1').decode(page.Contents);
    // Channel left edge = 20 + 86 = 106; above the deeper float bottom (426).
    const m = /(?:^|\n)106 ([\d.]+) Td\s+\(SECTION\)/.exec(content);
    expect(m).not.toBeNull();
    expect(Number(m![1])).toBeGreaterThan(426);
  });

  it("clear: 'both' drops the element below every float", () => {
    const doc = Document.Open(buildBlankPage());
    const flow = doc.NewFlow(opts());
    twoFloats(doc, flow);
    flow.AddHeading(2, 'SECTION', { fontSize: 10, clear: 'both' });
    const [page] = flow.Render();
    const content = new TextDecoder('latin1').decode(page.Contents);
    // Cleared to the lowest bottom (396) → full column width, x = 20.
    const m = /(?:^|\n)20 ([\d.]+) Td\s+\(SECTION\)/.exec(content);
    expect(m).not.toBeNull();
    expect(Number(m![1])).toBeLessThan(396);
  });

  it('clearing moves the pen only: spaceBefore still applies', () => {
    const doc = Document.Open(buildBlankPage());
    const flow = doc.NewFlow(opts());
    twoFloats(doc, flow);
    flow.AddHeading(2, 'SECTION', { fontSize: 10, clear: 'both', spaceBefore: 20 });
    const [page] = flow.Render();
    const content = new TextDecoder('latin1').decode(page.Contents);
    // Cleared to 396, then the 20pt gap applies → top 376, baseline 366. Were a
    // cleared element treated as sitting at a column top, the gap would be
    // dropped and the baseline would be 386.
    const m = /(?:^|\n)20 ([\d.]+) Td\s+\(SECTION\)/.exec(content);
    expect(m).not.toBeNull();
    expect(Number(m![1])).toBeLessThan(380);
  });

  it("clear: 'left' leaves a deeper right float in force", () => {
    const doc = Document.Open(buildBlankPage());
    const flow = doc.NewFlow(opts());
    // Left 48 tall (bottom 432, band 86); right 138 tall (top 474, bottom 336).
    const left = doc.NewFloatingBox({ width: 80, spacing: 6 });
    for (let i = 1; i <= 3; i++) left.AddParagraph(`L${i}`, { fontSize: 10, leading: 12 });
    const right = doc.NewFloatingBox({ width: 80, spacing: 6 });
    for (let i = 1; i <= 8; i++) right.AddParagraph(`R${i}`, { fontSize: 10, leading: 12 });
    flow.AddFloatBox(left, 'left');
    flow.AddFloatBox(right, 'right');
    // Both probes: the left one proves the left float cleared, the right one
    // proves the right float did NOT (a full-width region would put it at 240).
    flow.AddImage(buildPngRgb(), { align: 'left', width: 40, height: 24, clear: 'left' });
    flow.AddImage(buildPngRgb(), { align: 'right', width: 40, height: 24 });
    const [page] = flow.Render();
    const content = new TextDecoder('latin1').decode(page.Contents);
    // Cleared to 432: x = 20 (left band gone), y = 432-24 = 408.
    expect(content).toMatch(/(^|\n)40 0 0 24 20 408 cm/);
    // Still inside the right band: width 174 → x = 20 + (174-40) = 154, y = 384.
    expect(content).toMatch(/(^|\n)40 0 0 24 154 384 cm/);
  });

  it('clear on a list applies to the first item only', () => {
    const els = makeList(['a', 'b'], { clear: 'left' });
    expect(els[0].clear).toBe('left');
    expect(els[1].clear).toBeUndefined();
  });

  it('clear drops the whole list below the float', () => {
    const doc = Document.Open(buildBlankPage());
    const flow = doc.NewFlow(opts());
    const box = doc.NewFloatingBox({ width: 80, spacing: 6 }); // band 86, bottom 432
    for (let i = 1; i <= 3; i++) box.AddParagraph(`L${i}`, { fontSize: 10, leading: 12 });
    flow.AddFloatBox(box, 'left');
    // Explicit indent keeps the body x metric-free: cleared → 20+30 = 50.
    flow.AddList(['ITEMA', 'ITEMB'], { clear: 'left', indent: 30, fontSize: 10, leading: 12 });
    const [page] = flow.Render();
    const content = new TextDecoder('latin1').decode(page.Contents);
    expect(content).toMatch(/(^|\n)50 [\d.]+ Td\s+\(ITEMA\)/);
  });

  it('clear is a no-op with no active floats', () => {
    const doc = Document.Open(buildBlankPage());
    const flow = doc.NewFlow(opts());
    flow.AddParagraph('SOLO', { fontSize: 10, leading: 12, clear: 'both' });
    const [page] = flow.Render();
    const content = new TextDecoder('latin1').decode(page.Contents);
    expect(content).toMatch(/(^|\n)20 [\d.]+ Td\s+\(SOLO\)/);
  });

  it('rejects an invalid clear value', () => {
    const doc = Document.Open(buildBlankPage());
    const flow = doc.NewFlow(opts());
    expect(() => flow.AddParagraph('x', { clear: 'sideways' as never })).toThrow(TypeError);
    expect(() => flow.AddImage(buildPngRgb(), { clear: 'up' as never })).toThrow(TypeError);
    expect(() => flow.AddList(['a'], { clear: 'down' as never })).toThrow(TypeError);
  });
});
```

Add `Flow` and `makeList` to the existing import at the top of `test/flow.test.ts` if not already present — the current import line is:

```ts
import { PageFormat, normalizeFlowOptions, columnX, makeParagraph, makeList, makeImage, Flow } from '../src/flow.js';
```

so both are already there; no import change is needed.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/flow.test.ts -t "flow float clearing"`
Expected: FAIL — TypeScript rejects `clear` as an unknown option property, so the whole file fails to compile. That is the expected first failure; it turns into per-test assertions once Step 3 lands the types.

- [ ] **Step 3: Add the type and the validator to `src/flow.ts`**

Extend the `./floatstack.js` import:

```ts
import {
  clearTo, insetsAt, nextBoundary, pruneFloats, resolveFloatTop,
  type ActiveFloat, type ClearSide,
} from './floatstack.js';

/** Which side's floats an element must clear before it places. */
export type FlowClear = ClearSide;
```

Add the validator next to the existing `normalizeSpacing` helper:

```ts
/** Validate an optional `clear` option. @internal */
function normalizeClear(v: FlowClear | undefined): FlowClear | undefined {
  if (v === undefined) return undefined;
  if (v !== 'left' && v !== 'right' && v !== 'both')
    throw new TypeError("clear must be 'left', 'right', or 'both'");
  return v;
}
```

- [ ] **Step 4: Add `clear` to the option interfaces and `FlowElement`**

In `FlowParagraphOptions` (inherited by `FlowHeadingOptions`), add:

```ts
  /** Drop this element below the floats on the given side(s) before placing it.
   *  Default: none. */
  clear?: FlowClear;
```

Add the identical field to `FlowListOptions` (documented as applying to the first
item) and to `FlowImageOptions`.

In the `FlowElement` interface, add beside `spaceBefore`/`spaceAfter`:

```ts
  /** Side(s) whose floats this element clears before placing; treated as none
   *  when absent. Continuations never carry it. */
  readonly clear?: FlowClear;
```

- [ ] **Step 5: Thread `clear` through the three element classes**

`TextElement` — append a parameter to the constructor:

```ts
    readonly keepWithNext?: boolean,
    readonly clear?: FlowClear,
  ) {}
```

Its continuation already reads `new TextElement(remainder, this.opts, this.structType, 0, this.spaceAfter, this.tag)` — leave it exactly as is, so a remainder gets `clear: undefined`.

`ImageElement` — append to the constructor:

```ts
    readonly spaceAfter: number,
    readonly clear?: FlowClear,
  ) {
```

`ListItemElement` — add a mutable field in the class body next to `lbody`, assigned in the spacing post-pass rather than through the constructor (its continuation constructs a fresh instance and must not copy it):

```ts
  clear?: FlowClear;
```

Update the four construction sites:

```ts
// makeParagraph
return new TextElement(text, paragraphOptions(o), 'P', spaceBefore, spaceAfter,
  undefined, false, undefined, normalizeClear(o.clear));

// Flow.AddParagraph
this.items.push(new TextElement(text, paragraphOptions(options), 'P',
  spaceBefore, spaceAfter, undefined, false, undefined, normalizeClear(options.clear)));

// Flow.AddHeading
this.items.push(
  new TextElement(
    text, paragraphOptions(withDefaults), 'H' + String(level),
    spaceBefore, spaceAfter, undefined, true, options.keepWithNext,
    normalizeClear(options.clear)),
);

// buildImageElement (after the existing normalizeSpacing call)
return new ImageElement(built, o.width, o.height, align, o.alt, spaceBefore, spaceAfter,
  normalizeClear(o.clear));
```

In `buildListElements`, validate once and assign to the first element only, at the
end of the existing spacing post-pass:

```ts
  const listClear = normalizeClear(options.clear);
  if (els.length > 0) els[0].clear = listClear;
  return els;
```

- [ ] **Step 6: Apply `clear` in `Flow.Render`**

Insert immediately after the closing brace of the `if (isFloat(item)) { ... }` block and before the `// Gap above this element` comment:

```ts
      // Clear: drop the pen below the floats on the requested side(s). Idempotent
      // — the cleared floats are pruned, so re-entering with the same element
      // (a boundary skip, a retry) changes nothing further. Side-selective: a
      // deeper float on the other side stays in force and still narrows the
      // region. Moves the pen only — the gap below is computed as usual, and
      // atColumnStart is untouched.
      if (item.clear) {
        const target = clearTo(floats, item.clear);
        if (target !== undefined) {
          colTop = target;
          floats = pruneFloats(floats, colTop);
        }
      }
```

- [ ] **Step 7: Export the type from `src/index.ts`**

Add `FlowClear` to the existing flow type export block (around line 70):

```ts
export type {
  FlowOptions, FlowParagraphOptions, FlowHeadingOptions, FlowListOptions, FlowImageOptions,
  FlowListItem, FlowListNode, FlowElement, FlowClear, PlaceContext, PlaceResult,
} from './flow.js';
```

- [ ] **Step 8: Run the tests**

Run: `npx vitest run test/flow.test.ts test/floatbox.test.ts test/floatstack.test.ts`
Expected: PASS — the seven new tests plus every pre-existing test unmodified.

Run: `npm run typecheck`
Expected: no output, exit 0.

- [ ] **Step 9: Commit**

```bash
git add src/flow.ts src/index.ts test/flow.test.ts
git commit -m "feat(flow): per-element float clearing (db7v.10)

clear?: 'left' | 'right' | 'both' on paragraphs, headings, lists and images
drops the pen below the floats on the requested side(s) before placing. Side-
selective: clearing left leaves a deeper right float narrowing the region.
Continuations never inherit it.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 3: Deferred-float carry

**Files:**
- Modify: `src/flow.ts` (`Flow.Render`: the `pending` state, `advanceColumn`, the loop condition, the float fit branch)
- Test: `test/flow.test.ts`

**Interfaces:**
- Consumes: the `floats`/`FloatItem` machinery already in `Flow.Render`.
- Produces: no new exports. Behaviour change only.

- [ ] **Step 1: Write the failing tests**

Append a new `describe` block at the end of `test/flow.test.ts`:

```ts
describe('flow deferred-float carry', () => {
  const twoCol = () => ({
    format: PageFormat.custom(400, 300), columns: 2, columnGap: 20,
    marginLeft: 20, marginRight: 20, marginTop: 20, marginBottom: 20,
  });

  /** A box 246pt tall — fits an empty 260pt column, not the ~244 left after a
   *  line of text. Paragraph labels are prefixed so tests can tell boxes apart. */
  const tallBox = (doc: Document, label: string) => {
    const box = doc.NewFloatingBox({ width: 80, spacing: 6 });
    for (let i = 1; i <= 14; i++) box.AddParagraph(`${label}${i}`, { fontSize: 10, leading: 12 });
    return box;
  };

  it('a deferred float no longer drags following content out of the column', () => {
    const doc = Document.Open(buildBlankPage());
    const flow = doc.NewFlow(twoCol());
    flow.AddParagraph('FIRST', { fontSize: 10, leading: 12 });
    flow.AddFloatBox(tallBox(doc, 'X'), 'left');
    flow.AddParagraph('AFTER', { fontSize: 10, leading: 12 });
    const [page] = flow.Render();
    const content = new TextDecoder('latin1').decode(page.Contents);
    // Column 1 (x=20) keeps filling: AFTER stays there instead of following the
    // float into column 2 (where it used to land beside the box at x=296).
    expect(content).toMatch(/(^|\n)20 [\d.]+ Td\s+\(FIRST\)/);
    expect(content).toMatch(/(^|\n)20 [\d.]+ Td\s+\(AFTER\)/);
    // The box itself lands at the top of column 2 (x=210).
    expect(content).toMatch(/(^|\n)210 [\d.]+ Td\s+\(X1\)/);
  });

  it('a float deferred by the last element is still drawn', () => {
    const doc = Document.Open(buildBlankPage());
    const flow = doc.NewFlow(twoCol());
    flow.AddParagraph('FIRST', { fontSize: 10, leading: 12 });
    flow.AddFloatBox(tallBox(doc, 'X'), 'left');
    const [page] = flow.Render();
    const content = new TextDecoder('latin1').decode(page.Contents);
    // Nothing follows the float, so only the trailing flush can place it.
    expect(content).toMatch(/(^|\n)210 [\d.]+ Td\s+\(X1\)/);
  });

  it('two floats deferred from one column land on successive columns', () => {
    const doc = Document.Open(buildBlankPage());
    const flow = doc.NewFlow(twoCol());
    flow.AddParagraph('FIRST', { fontSize: 10, leading: 12 });
    flow.AddFloatBox(tallBox(doc, 'X'), 'left');
    flow.AddFloatBox(tallBox(doc, 'Y'), 'left');
    const pages = flow.Render();
    expect(pages).toHaveLength(2);
    // X takes column 2 of page 1; Y cannot stack under it, so it carries again
    // to column 1 of page 2.
    const p1 = new TextDecoder('latin1').decode(pages[0].Contents);
    const p2 = new TextDecoder('latin1').decode(pages[1].Contents);
    expect(p1).toMatch(/(^|\n)210 [\d.]+ Td\s+\(X1\)/);
    expect(p2).toMatch(/(^|\n)20 [\d.]+ Td\s+\(Y1\)/);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/flow.test.ts -t "deferred-float carry"`
Expected: 2 of 3 FAIL.

- "no longer drags following content" — FAIL: `AFTER` is drawn at x=296 (column 2, beside the box), so the `20 ... (AFTER)` assertion finds no match.
- "two floats ... successive columns" — FAIL: both boxes and the text restart in column 2, so `Y1` is not on page 2 (`pages` has length 1).
- "deferred by the last element" — **PASS already**. With nothing following the float, deferring and the old `advanceColumn()` put the box in the same place. Keep it: it is the only guard on the trailing-flush path, which is easy to omit in Step 3 and would silently drop the box.

- [ ] **Step 3: Add the pending queue**

In `Flow.Render`, after `let floats: ActiveFloat[] = [];` add:

```ts
    // Floats deferred from a column that ran out of room, re-queued at the top
    // of the next one.
    let pending: FloatItem[] = [];
```

Extend `advanceColumn` (`queue` is declared above it, so this is in scope):

```ts
    const advanceColumn = () => {
      col++;
      if (col >= g.columns) { col = 0; pageIdx++; }
      colTop = g.contentTop;
      atColumnStart = true;
      pendingSpaceAfter = 0;
      floats = [];
      // Carried floats lead the new column — ahead of any remainder a caller
      // re-queued just before calling us, so its text wraps beside them.
      if (pending.length > 0) { queue.unshift(...pending); pending = []; }
    };
```

- [ ] **Step 4: Defer instead of advancing, and flush at the end**

Replace the loop header:

```ts
    while (queue.length > 0) {
      const item = queue[0];
```

with:

```ts
    while (queue.length > 0 || pending.length > 0) {
      // Only carried floats left: open the column they were deferred to. The
      // loop condition guarantees `pending` is non-empty here, so advanceColumn
      // always re-queues work and this cannot spin.
      if (queue.length === 0) { advanceColumn(); continue; }
      const item = queue[0];
```

Replace the float fit failure:

```ts
        if (boxTop - h < g.contentBottom - 1e-9) {
          if (atColumnStart)
            throw new Error('Flow: floating box does not fit in an empty column (column too short for the box)');
          advanceColumn();
          continue;
        }
```

with:

```ts
        if (boxTop - h < g.contentBottom - 1e-9) {
          if (atColumnStart)
            throw new Error('Flow: floating box does not fit in an empty column (column too short for the box)');
          // Defer rather than advancing: taking the column with us would abandon
          // the rest of it. Following content keeps filling this column and the
          // box leads the next one. A column start has no active floats, so a
          // carried float there either fits or throws — this terminates.
          pending.push(item);
          queue.shift();
          continue;
        }
```

- [ ] **Step 5: Run the tests**

Run: `npx vitest run test/flow.test.ts test/floatbox.test.ts test/floatstack.test.ts`
Expected: PASS — the three new tests plus every pre-existing test unmodified. Two pre-existing tests are the ones at risk here:

- `'a stacked float that overruns the column moves to the next page'` (db7v.9) — still passes: with no content after the float, the trailing flush lands it exactly where `advanceColumn` used to.
- `'a box taller than a full column throws'` (db7v.4) — still passes: the `atColumnStart` throw is above the new defer branch and is untouched.

Run: `npm run typecheck`
Expected: no output, exit 0.

- [ ] **Step 6: Commit**

```bash
git add src/flow.ts test/flow.test.ts
git commit -m "feat(flow): carry a deferred float to the next column (db7v.10)

A float that does not fit the remaining height is queued as pending instead of
advancing the column, so following content keeps filling the current column and
the box leads the next one. A trailing flush draws a float deferred by the last
element.

Previously a deferred float took the rest of its column with it — measured at
94% of a column abandoned.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 4: Tagging order, load-bearing verification, and docs

**Files:**
- Test: `test/flow.test.ts` (append to `describe('flow deferred-float carry')`)
- Modify: `README.md` (the Flow floating-box paragraph)

**Interfaces:**
- Consumes: everything from Tasks 1–3.
- Produces: nothing.

- [ ] **Step 1: Write the tagging test**

Append inside `describe('flow deferred-float carry', ...)`:

```ts
  it('a deferred float tags in draw order, after the text that outran it', () => {
    const doc = Document.Open(buildBlankPage());
    const flow = doc.NewFlow({ ...twoCol(), tagged: true });
    const box = doc.NewFloatingBox({ width: 80, spacing: 6, alt: 'carried' });
    for (let i = 1; i <= 14; i++) box.AddParagraph(`X${i}`, { fontSize: 10, leading: 12 });
    flow.AddParagraph('FIRST', { fontSize: 10, leading: 12 });
    flow.AddFloatBox(box, 'left');
    flow.AddParagraph('AFTER', { fontSize: 10, leading: 12 });
    flow.Render();

    const sect = doc.CreateStructTree().Children.find((c) => c.Type === 'Sect')!;
    const kinds = sect.Children.map((c) => c.Type);
    // Structure is appended when content draws, and the deferred box draws last,
    // so its paragraphs follow both flow paragraphs. Reading order tracks visual
    // order, not call order — see the design's "Accepted consequence".
    expect(kinds.filter((k) => k === 'P').length).toBeGreaterThanOrEqual(3);
    expect(kinds.lastIndexOf('P')).toBeGreaterThan(1);
  });
```

- [ ] **Step 2: Run it**

Run: `npx vitest run test/flow.test.ts -t "tags in draw order"`
Expected: PASS. This is a characterization test — it locks in the accepted consequence rather than driving new code. If it fails, the box is not being drawn at all; recheck the trailing flush.

- [ ] **Step 3: Prove the new assertions are load-bearing**

For each mutation: apply it, run the command, confirm **RED**, then `git checkout -- src/` before the next. A green fixture is not evidence (CLAUDE.md).

Detect failure by exit code, not by grepping for `×` — vitest emits ANSI colour codes before that glyph, so an anchored pattern silently matches nothing:

```bash
run() { if npx vitest run $2 >/tmp/mut.log 2>&1; then echo "GREEN (BAD) <- $1"; \
  else echo "RED (good) <- $1 :: $(grep -oE '[0-9]+ failed' /tmp/mut.log | head -1)"; fi; }
```

| Mutation | Command | Must go red |
|---|---|---|
| `clearTo`: `return undefined` at the top | `test/floatstack.test.ts test/flow.test.ts` | clearTo units + all clear tests |
| `clearTo`: `f.bottom > best` (highest not lowest) | `test/floatstack.test.ts test/flow.test.ts` | stacked-side unit + `clear: 'both'` |
| `clearTo`: drop the `side !== 'both'` guard | `test/floatstack.test.ts test/flow.test.ts` | side-selective unit + `clear: 'left'` |
| `flow.ts`: delete the `if (item.clear)` block | `test/flow.test.ts` | every clear integration test |
| `flow.ts`: set `atColumnStart = true` inside the clear block | `test/flow.test.ts` | the spaceBefore test |
| `buildListElements`: don't assign `els[0].clear` | `test/flow.test.ts` | list clear tests |
| Float defer: restore `advanceColumn(); continue;` | `test/flow.test.ts` | carry tests |
| `advanceColumn`: drop the `queue.unshift(...pending)` | `test/flow.test.ts` | carry tests (box never drawn) |
| Loop: restore `while (queue.length > 0)` and drop the flush | `test/flow.test.ts` | trailing-flush test |

If any mutation stays green, the corresponding assertion is decorative — strengthen it before finishing the task.

- [ ] **Step 4: Update the README**

In `README.md`, the Flow floating-box paragraph currently ends:

```
each box is passed. Floats are per-column: `AddColumnBreak` (and automatic
pagination) clears them. CSS-style `clear` controls and carrying a float across
a column boundary are tracked as follow-up work.
```

Replace that with:

```
each box is passed. Floats are per-column: `AddColumnBreak` (and automatic
pagination) clears them. Any element takes `clear: 'left' | 'right' | 'both'`,
which drops it below the floats on those sides before it places — clearing one
side leaves a deeper float on the other still narrowing the region. A float that
does not fit the remaining column height is carried to the top of the next
column, and the content after it keeps filling the current one.
```

- [ ] **Step 5: Run the full quality gates**

Run: `npm run typecheck`
Expected: no output, exit 0.

Run: `npm test`
Expected: the entire suite green.

- [ ] **Step 6: Commit**

```bash
git add test/flow.test.ts README.md
git commit -m "test(flow): deferred-float tagging order; document clear and carry (db7v.10)

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

- [ ] **Step 7: Close the issue and the epic, then push**

`db7v.10` is the last open child of epic `db7v`, so close both:

```bash
bd close aspose-pdf-foss-for-ts-db7v.10
bd show aspose-pdf-foss-for-ts-db7v      # confirm 10/10 before closing the epic
bd close aspose-pdf-foss-for-ts-db7v
git add .beads/
git commit -m "chore(bd): close db7v.10 and epic db7v (flow layout engine)

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
git pull --rebase
git push
git status   # MUST show "up to date with origin"
```

---

## Notes for the implementer

- **`bd close` leaves `.beads/interactions.jsonl` dirty**, which blocks `git pull --rebase`. Commit it as a `chore(bd):` commit first — that is this repo's convention (see `6cb2a7b`).
- **If an expected coordinate is off**, re-derive it from the three facts in *Shared Test Geometry* before touching `src/`. The most common slip is forgetting that `FloatingBox.measure()` adds `spacing` *between* items, which changes every box height and therefore every `bottom`.
- **Never edit a pre-existing test to make it pass.** A single float, and a float with no content after it, must behave exactly as before.
- **`clearTo` deliberately ignores whether a float is in force.** The loop-top `pruneFloats` has already dropped the passed ones; adding a second check there would be dead code that hides a caller bug.

# CSS float splitting Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** an over-tall CSS float paints as much as fits, carries the rest to the next column, and leads that column as a float again — with text wrapping beside both halves.

**Architecture:** `FloatContent` gains ONE optional member, `splitPaint`, which paints into a height budget and hands back the leftover as a ready-to-enqueue `FlowElement`. Only `elementFloat` implements it, over the `placeElements` call `paintAt` already makes; `FloatingBox` declines it and keeps throwing. `flow.ts`'s float branch gains one step, in the position that degrades today, so nothing that passes today moves.

**Tech Stack:** TypeScript (ESM, NodeNext, `strict`), vitest. Zero runtime dependencies — `node:` built-ins only.

**Spec:** `docs/superpowers/specs/2026-09-02-css-float-splitting-design.md`

## Global Constraints

- **Import specifiers carry the `.js` extension** (`import { x } from './flowplace.js'`), even from `.ts` sources.
- **No new npm runtime dependencies.** `node:` built-ins only.
- **`npm run typecheck` and `npm test` must BOTH be green before an issue is closed.** Target one file with `npx vitest run test/<name>.test.ts`.
- **`CHANGELOG.md` is updated in the same commit as the user-visible change**, under `## [Unreleased]`, with the issue id `zch2.15` in parentheses at the end.
- **Decision 1 — split ONLY when the float cannot fit an EMPTY column.** A float that fits a column on its own still defers whole. No behaviour `zch2.10` shipped may move.
- **Decision 2 — `FloatingBox` is edited NOT AT ALL.** It declines `splitPaint` and keeps throwing.
- **Decision 3 — `flowplace.ts` does not split and is not edited.**
- **Geometry the tests depend on:** `Flow`'s default margins are 72 on all four sides (`src/flow.ts:62-68`). On A4 (595 × 842) that is a column **698 pt tall** and **451 pt wide**. Every height in the fixtures below is chosen against 698.

---

### Task 1: The seam — `FloatContent.splitPaint` and `elementFloat`'s implementation

**Files:**
- Modify: `src/flowelement.ts` (the `FloatContent` interface, currently lines 92-105)
- Modify: `src/flowfloat.ts` (the module header comment, and `elementFloat`)
- Test: `test/flowfloat.test.ts`

**Interfaces:**
- Consumes: `placeElements` / `measureElements` from `./flowplace.js`; `FlowElement`, `FloatContent` from `./flowelement.js` — all already imported by `src/flowfloat.ts`.
- Produces, relied on by Task 2:
  - `FloatContent.splitPaint?(page: Page, x: number, topY: number, maxHeight: number, side: 'left' | 'right', structParent?: StructElement): { height: number; tail?: FlowElement }`
  - `elementFloat(doc, elements, width, spacing)` now returns a `FloatContent` whose `splitPaint` is defined. `tail`, when present, is a `FlowElement` already carrying `float: { side, content }` — the engine enqueues it as-is and builds nothing.

- [ ] **Step 1: Write the failing tests**

Append to `test/flowfloat.test.ts`, inside the existing `describe('elementFloat', ...)` block (after the `measure() draws nothing` case, before its closing `});`):

```ts
  it('splitPaint paints what fits the budget and hands back the rest', () => {
    const doc = Document.New();
    const { page } = doc.AddPage(PageFormat.A4);
    // One paragraph's height is the budget, so the first fits and the second
    // cannot. Deriving it rather than hardcoding keeps the fixture honest
    // against a font-metric change.
    const oneHigh = elementFloat(doc, paragraph('alpha alpha'), 200, 0).measure();
    const inner = [...paragraph('alpha alpha'), ...paragraph('bravo bravo')];
    const c = elementFloat(doc, inner, 200, 0);
    const res = c.splitPaint!(page, 50, 700, oneHigh + 1, 'left');
    expect(res.height).toBeGreaterThan(0);
    expect(res.tail).toBeDefined();
    expect(page.GetText()).toContain('alpha');
    expect(page.GetText()).not.toContain('bravo');
  });

  it('the tail carries the float marker, so the engine enqueues it as-is', () => {
    const doc = Document.New();
    const { page } = doc.AddPage(PageFormat.A4);
    const oneHigh = elementFloat(doc, paragraph('alpha alpha'), 200, 0).measure();
    const inner = [...paragraph('alpha alpha'), ...paragraph('bravo bravo')];
    const res = elementFloat(doc, inner, 200, 0)
      .splitPaint!(page, 50, 700, oneHigh + 1, 'right');
    expect(res.tail!.float?.side).toBe('right');
    expect(res.tail!.float?.content.width).toBe(200);
    // And it can split again, which is what lets a float span three columns.
    expect(typeof res.tail!.float?.content.splitPaint).toBe('function');
  });

  it('splitPaint hands back NO tail when everything fits the budget', () => {
    const doc = Document.New();
    const { page } = doc.AddPage(PageFormat.A4);
    const c = elementFloat(doc, paragraph('one line of text'), 200, 0);
    const res = c.splitPaint!(page, 50, 700, c.measure() + 50, 'left');
    expect(res.tail).toBeUndefined();
    expect(res.height).toBeCloseTo(c.measure(), 6);
  });

  it('reports height 0 and paints NOTHING when nothing fits the budget', () => {
    // This is the engine's exit to the degrade path: the call must have had no
    // effect, or degrading afterwards would leave a half-painted float.
    const doc = Document.New();
    const { page } = doc.AddPage(PageFormat.A4);
    const before = page.GetText();
    const res = elementFloat(doc, paragraph('alpha bravo'), 200, 0)
      .splitPaint!(page, 50, 700, 1, 'left');
    expect(res.height).toBe(0);
    expect(page.GetText()).toBe(before);
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/flowfloat.test.ts`
Expected: FAIL. TypeScript reports `Property 'splitPaint' does not exist on type 'FloatContent'`, and at runtime `c.splitPaint!` is `undefined`, so the calls throw `TypeError: c.splitPaint is not a function`.

- [ ] **Step 3: Add the optional member to `FloatContent`**

In `src/flowelement.ts`, in the `FloatContent` interface, insert this AFTER the existing `degradeOnOverflow` member and before the interface's closing `}`:

```ts
  /** Paint into a height budget and hand back what did not fit (`zch2.15`).
   *
   *  Only `elementFloat` implements it. `FloatingBox` declines it and never
   *  splits: its border and background have no defined way to continue across
   *  a column, so a split box reads as a fault.
   *
   *  `height` is what was ACTUALLY painted, which after a split differs from
   *  `measure()` — the engine takes the excluded band from it for that reason.
   *  A `height` of 0 means nothing was painted and the call had no effect,
   *  which is what lets the engine fall through to the degrade path. `tail` is
   *  a `FlowElement` already carrying the float marker, ready to enqueue. */
  splitPaint?(
    page: Page, x: number, topY: number, maxHeight: number,
    side: 'left' | 'right', structParent?: StructElement,
  ): { height: number; tail?: FlowElement };
```

Also update the interface's own header comment, replacing:

```ts
 *  Invariant: FOUR members, and `FloatingBox` satisfies every one of them
 *  UNEDITED — that is what lets a CSS float join the existing float branch
 *  instead of adding a second one. A required edit to `FloatingBox` means this
 *  seam is wrong. */
```

with:

```ts
 *  Invariant: FOUR REQUIRED members, and `FloatingBox` satisfies every one of
 *  them UNEDITED — that is what lets a CSS float join the existing float branch
 *  instead of adding a second one. A required edit to `FloatingBox` means this
 *  seam is wrong. `splitPaint` is the one OPTIONAL member: `FloatingBox`
 *  declines it and keeps its documented refusal to split. */
```

- [ ] **Step 4: Implement `splitPaint` in `elementFloat`**

In `src/flowfloat.ts`, replace the whole `elementFloat` function body's returned object with this version (the `paintAt` member is unchanged; `splitPaint` is added after it):

```ts
export function elementFloat(
  doc: Document, elements: FlowElement[], width: number, spacing: number,
): FloatContent {
  return {
    width,
    spacing,
    // A CSS float degrades to ordinary flow rather than throwing, which is this
    // epic's rule; FloatingBox's contract is the opposite and it sets nothing.
    degradeOnOverflow: true,
    measure(): number {
      return measureElements(elements, width);
    },
    paintAt(page: Page, x: number, topY: number, structParent?: StructElement): number {
      const h = measureElements(elements, width);
      // rect `y` is the BOTTOM edge, the convention placeElements takes.
      const { usedHeight } = placeElements(
        doc, page, elements, [x, topY - h, width, h],
        { paragraphSpacing: 0, structParent });
      return usedHeight;
    },
    // The SAME placeElements call paintAt makes, with a budget instead of the
    // measured height — which is the whole of splitting, because placeElements
    // has always returned the remainder and paintAt has always made one
    // impossible by asking for a rect exactly as tall as measure().
    splitPaint(
      page: Page, x: number, topY: number, maxHeight: number,
      side: 'left' | 'right', structParent?: StructElement,
    ): { height: number; tail?: FlowElement } {
      const { usedHeight, remainder } = placeElements(
        doc, page, elements, [x, topY - maxHeight, width, maxHeight],
        { paragraphSpacing: 0, structParent });
      return {
        height: usedHeight,
        // A full float element, not a bare FloatContent: the tail then has a
        // real degrade path of its own (floatElement's place()) and the engine
        // builds nothing. It leads a column, so it carries no leading gap.
        tail: remainder.length === 0
          ? undefined
          : floatElement(remainder, side, elementFloat(doc, remainder, width, spacing), 0, 0),
      };
    },
  };
}
```

- [ ] **Step 5: Rewrite the two stale invariants in the module header**

In `src/flowfloat.ts`, replace this paragraph of the header comment:

```
 *  Invariant, and it looks like a violation of CLAUDE.md's "a container never
 *  holds and paginates its children": the wrapper DOES hold a group. It is
 *  allowed to because a float never SPLITS — zch2.10 defers a float whole
 *  rather than splitting it — so the wrapper never paginates. If splitting
 *  lands later, this wrapper is the thing that has to change.
```

with:

```
 *  Invariant, and it is the reading zch2.15's own issue got wrong: the wrapper
 *  DOES hold a group, and splitting did NOT force it to become a decorator over
 *  one child. CLAUDE.md's hazard is a container with its OWN pagination loop —
 *  how a quote comes to break across a column under one rule and a list under
 *  another. placeElements is not a second loop; it is the shared one, extracted
 *  in zch2.5 precisely so a caller can lay elements into ONE rect and get the
 *  overflow back. A container that delegates to it is not what the rule forbids.
 *
 *  Invariant: measure(), paintAt() and splitPaint() all run the same arithmetic
 *  through placeElements/measureElements, so the three cannot disagree about
 *  one float. Two walks is how a float comes to measure one way and paint
 *  another.
```

and delete the now-duplicated older `Invariant: measure() and paintAt() run the SAME placement arithmetic ...` paragraph directly above it.

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx vitest run test/flowfloat.test.ts && npm run typecheck`
Expected: PASS — all cases in `test/flowfloat.test.ts` green (the five that existed before this task included), and typecheck clean.

- [ ] **Step 7: Commit**

```bash
git add src/flowelement.ts src/flowfloat.ts test/flowfloat.test.ts
git commit -m "feat(zch2.15): FloatContent.splitPaint, and elementFloat implements it

Paint into a height budget and hand the leftover back as a ready-to-enqueue
float element. It is the placeElements call paintAt already makes, with a
budget instead of the measured height — placeElements has always returned a
remainder and paintAt has always made one impossible.

Optional, so FloatingBox is edited not at all and keeps its refusal to split.
Nothing calls it yet.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 2: The engine — Render splits instead of degrading

**Files:**
- Modify: `src/flow.ts` (the float branch, currently lines 1381-1409)
- Test: `test/flow-float-content.test.ts`

**Interfaces:**
- Consumes from Task 1: `FloatContent.splitPaint(page, x, topY, maxHeight, side, structParent?) => { height: number; tail?: FlowElement }`.
- Produces: no new exports. Behaviour relied on by Task 3 — an over-tall degradable float now splits across columns rather than laying out in flow, and the excluded band is taken from the painted height.

- [ ] **Step 1: Write the failing tests**

Append to `test/flow-float-content.test.ts`. First add this helper immediately after the existing `floatEl` helper (line 36):

```ts
/** A FloatContent that splits: every splitPaint call paints `perColumn` and
 *  hands back a tail one step shorter, so `columns` of 3 spans three columns.
 *  `painted` records every paint by either route. */
function splittingContent(width: number, perColumn: number, columns: number): {
  content: FloatContent;
  painted: { x: number; topY: number; height: number }[];
  splits: number;
} {
  const painted: { x: number; topY: number; height: number }[] = [];
  const state = { splits: 0 };
  const make = (left: number): FloatContent => ({
    width,
    spacing: 0,
    degradeOnOverflow: true,
    measure: () => perColumn * left,
    paintAt: (_page: Page, x: number, topY: number) => {
      painted.push({ x, topY, height: perColumn * left });
      return perColumn * left;
    },
    splitPaint: (_page: Page, x: number, topY: number, _max: number, side: 'left' | 'right') => {
      state.splits++;
      painted.push({ x, topY, height: perColumn });
      const rest = left - 1;
      return {
        height: perColumn,
        tail: rest === 0 ? undefined : {
          float: { side, content: make(rest) },
          spaceBefore: 0,
          spaceAfter: 0,
          place: (ctx) => paragraph('degraded body text')[0].place(ctx),
        } as FlowElement,
      };
    },
  });
  const content = make(columns);
  return { content, painted, get splits() { return state.splits; } };
}
```

Then append these describe blocks at the end of the file:

```ts
describe('a float too tall for an EMPTY column (zch2.15)', () => {
  it('splits across columns instead of degrading', () => {
    // The column is 698pt (A4 less 72pt margins). 400 x 3 = 1200 does not fit,
    // nor does 800; the last 400 does, so it lands through the ordinary
    // paintAt path. Three paints, three pages.
    const f = splittingContent(100, 400, 3);
    const doc = Document.New();
    const flow = doc.NewFlow({ format: PageFormat.A4 });
    flow.AddElements([floatEl(f.content, 'left')]);
    const pages = flow.Render();
    expect(f.painted).toHaveLength(3);
    expect(f.splits).toBe(2);
    expect(pages).toHaveLength(3);
    expect(pages[0].GetText()).not.toContain('degraded body text');
  });

  it('takes the excluded band from the height PAINTED, not the height measured', () => {
    // Measures 2000 and paints 100. With the band read from measure() the
    // channel stays narrow for the whole column and every line of body text is
    // indented; with it read from the paint, the text resumes at full width
    // 100pt down. A float that fills its budget exactly cannot see this.
    const tail: FloatContent = {
      width: 200, spacing: 0, degradeOnOverflow: true,
      measure: () => 50,
      paintAt: () => 50,
    };
    const content: FloatContent = {
      width: 200, spacing: 0, degradeOnOverflow: true,
      measure: () => 2000,
      paintAt: () => 2000,
      splitPaint: (_p: Page, _x: number, _t: number, _m: number, side: 'left' | 'right') => ({
        height: 100,
        tail: {
          float: { side, content: tail },
          spaceBefore: 0, spaceAfter: 0,
          place: (ctx) => paragraph('degraded body text')[0].place(ctx),
        } as FlowElement,
      }),
    };
    const doc = Document.New();
    const flow = doc.NewFlow({ format: PageFormat.A4 });
    flow.AddElements([floatEl(content, 'left')]);
    flow.AddParagraph(
      'alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima '
      + 'mike november oscar papa quebec romeo sierra tango uniform victor whiskey');
    const xs = flow.Render()[0].GetTextFragments()
      .sort((a, b) => b.quad[1] - a.quad[1])
      .map((fr) => fr.quad[0]);
    expect(xs.length).toBeGreaterThan(1);
    expect(xs[0]).toBeGreaterThan(xs[xs.length - 1] + 100);
  });

  it('degrades when splitPaint can place nothing, and asks exactly once', () => {
    let calls = 0;
    const content: FloatContent = {
      width: 100, spacing: 0, degradeOnOverflow: true,
      measure: () => 5000,
      paintAt: () => 5000,
      splitPaint: () => { calls++; return { height: 0 }; },
    };
    const doc = Document.New();
    const flow = doc.NewFlow({ format: PageFormat.A4 });
    flow.AddElements([floatEl(content, 'left')]);
    const pages = flow.Render();
    expect(calls).toBe(1);
    expect(pages[0].GetText()).toContain('degraded body text');
  });

  it('still THROWS for a non-degradable content whose split places nothing', () => {
    const content: FloatContent = {
      width: 100, spacing: 0,
      measure: () => 5000,
      paintAt: () => 5000,
      splitPaint: () => ({ height: 0 }),
    };
    const doc = Document.New();
    const flow = doc.NewFlow({ format: PageFormat.A4 });
    flow.AddElements([floatEl(content, 'left')]);
    expect(() => flow.Render()).toThrow(/does not fit in an empty column/);
  });
});

describe('a float that DOES fit an empty column (zch2.10 stands)', () => {
  it('defers WHOLE rather than splitting, even when it does not fit what is left', () => {
    // 690 fits the 698pt column but not what one paragraph leaves of it, so
    // zch2.10's defer runs and splitPaint is never asked. The 8pt margin is
    // deliberate: any single line of text exceeds it.
    const f = splittingContent(100, 690, 1);
    const doc = Document.New();
    const flow = doc.NewFlow({ format: PageFormat.A4 });
    flow.AddParagraph('a paragraph that spends part of the first column');
    flow.AddElements([floatEl(f.content, 'left')]);
    flow.Render();
    expect(f.splits).toBe(0);
    expect(f.painted).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/flow-float-content.test.ts`
Expected: FAIL on the four new `zch2.15` cases — `splits` is 0 and `painted` empty because nothing calls `splitPaint`, the over-tall float degrades, and `pages` has length 1. The two `zch2.10` cases and the four pre-existing cases PASS unchanged.

- [ ] **Step 3: Add the split step to Render's float branch**

In `src/flow.ts`, replace this (currently lines 1401-1409):

```ts
        } else if (box.degradeOnOverflow !== true) {
          throw new Error('Flow: floating box does not fit in an empty column (column too short for the box)');
        }
        // Degradable and it will not fit an empty column: floatPlan stays
        // undefined and we fall through. The marker rides ON a FlowElement, so
        // "not floating it" is just placing it, frame and content intact —
        // there is no fallback rendering path to write.
```

with:

```ts
        } else {
          // Too tall even for an EMPTY column. Split if the content can
          // fragment (zch2.15); otherwise degrade, or throw. This is the ONLY
          // caller of splitPaint, and it runs at a column start, so the budget
          // is the whole column.
          let splitHeight = 0;
          let splitTail: FlowElement | undefined;
          if (box.splitPaint !== undefined) {
            const page = ensurePage(pageIdx);
            const boxX = fl.side === 'left'
              ? columnX(g, col)
              : columnX(g, col) + g.columnWidth - box.width;
            const s = box.splitPaint(
              page, boxX, boxTop, boxTop - g.contentBottom, fl.side, structParent);
            splitHeight = s.height;
            splitTail = s.tail;
          }
          if (splitHeight > 0) {
            // The band comes from what was PAINTED. After a split that differs
            // from `h`, and reading `h` narrows the channel past the column
            // bottom for every element below.
            floats.push({
              side: fl.side, band: box.width + box.spacing, bottom: boxTop - splitHeight,
            });
            if (boxTop === naturalTop) colTop = boxTop;
            atColumnStart = false;
            pendingSpaceAfter = 0;
            queue.shift();
            // The tail leads the next column through the same `pending`
            // mechanism a deferred float already uses. It is accepted only
            // when something was painted, so it is strictly shorter than what
            // produced it and the split terminates.
            if (splitTail !== undefined) pending.push(splitTail);
            continue;
          }
          // splitPaint absent, or it painted nothing because the content
          // cannot fragment at all. Either way the call had no effect, so
          // degrading here is clean: floatPlan stays undefined and we fall
          // through. The marker rides ON a FlowElement, so "not floating it"
          // is just placing it, frame and content intact — there is no
          // fallback rendering path to write.
          if (box.degradeOnOverflow !== true) {
            throw new Error('Flow: floating box does not fit in an empty column (column too short for the box)');
          }
        }
```

No import changes: `FlowElement` and `FloatContent` are already imported at `src/flow.ts:26`, and `ensurePage`, `columnX`, `pending`, `structParent` are all already in scope at this point.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/flow-float-content.test.ts && npm run typecheck`
Expected: PASS — all ten cases green, typecheck clean.

- [ ] **Step 5: Run the neighbouring float fences**

Run: `npx vitest run test/flowfloat.test.ts test/flowplace-floats.test.ts test/css-float.test.ts test/floatstack.test.ts test/floatbox.test.ts`
Expected: PASS, with **no case changed**. Decision 1 moves nothing that passes today; a red case here means the split step is firing where a defer should.

- [ ] **Step 6: Commit**

```bash
git add src/flow.ts test/flow-float-content.test.ts
git commit -m "feat(zch2.15): Render splits an over-tall float across columns

The step goes in the position that degrades today, AFTER the defer, so a
float that fits a column on its own still leads the next one whole — which
is what browsers do in paged media and what zch2.10 shipped.

Two details that are silent when wrong. The band comes from the height
PAINTED, not from measure(); the engine discarded paintAt's return value and
after a split the two differ, so reading the measure narrows the channel past
the column bottom. And a tail is accepted only when something was painted,
which is the termination proof: content that cannot fragment reports height 0,
the call has had no effect, and the degrade below is still clean.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 3: End to end, the `flowplace` asymmetry, and the docs

**Files:**
- Test: `test/css-float.test.ts`
- Test: `test/flowplace-floats.test.ts`
- Modify: `CLAUDE.md` (lines 613-618 and 636-639)
- Modify: `CHANGELOG.md`

**Interfaces:**
- Consumes from Task 2: an over-tall CSS float splits across pages under `Document.AddHtml`.
- Produces: nothing further depends on this task.

- [ ] **Step 1: Write the failing tests**

Append to `test/css-float.test.ts`:

```ts
describe('an over-tall CSS float (zch2.15)', () => {
  // 150px is 112.5pt, at which each LINEnn word is most of a line, so 200 of
  // them run well past the 698pt column and the float must span two pages.
  const TALL = Array.from({ length: 200 }, (_, i) => `LINE${i}`).join(' ');
  const SRC_TALL = `<div style="float:left;width:150px">${TALL}</div>
<p style="margin:0">alpha bravo charlie delta echo</p>`;

  it('splits across pages instead of laying out in flow', () => {
    const { pages } = Document.New().AddHtml(SRC_TALL);
    expect(pages.length).toBeGreaterThan(1);
    expect(pages[0].GetText()).toContain('LINE0');
    expect(pages[pages.length - 1].GetText()).toContain('LINE199');
  });

  it('keeps narrowing the channel on the page it continues onto', () => {
    // The head's band is easy to get right and the tail's is the one a lost
    // band leaves plausible: both halves still paint, and only the text beside
    // the tail moves.
    const { pages } = Document.New().AddHtml(SRC_TALL);
    const floatXs = pages[1].GetTextFragments()
      .filter((f) => f.text.includes('LINE'))
      .map((f) => f.quad[0]);
    expect(floatXs.length).toBeGreaterThan(0);
    // The continuation sits at the column's left edge, exactly as the head did.
    expect(Math.min(...floatXs)).toBeCloseTo(72, 0);
  });
});
```

Append to `test/flowplace-floats.test.ts`, inside the existing `describe('placeElements with a float', ...)` block:

```ts
  it('does NOT split an over-tall float — one rect has no next column', () => {
    // Splitting here would paint the head and leave the tail in a remainder
    // most callers of page.AddHtml never re-place: half a float drawn and the
    // rest silently gone. Degrading to in-flow draws everything.
    //
    // The fixture turns on the width difference: the same words need ~7 lines
    // at the float's 100pt and 2 at the rect's 400pt, so a 60pt rect cannot
    // take the float and can take it in flow.
    const doc = Document.New();
    const { page } = doc.AddPage(PageFormat.A4);
    const inner = paragraph(BODY);
    const el = floatElement(inner, 'left', elementFloat(doc, inner, 100, 6), 0, 0);
    const res = placeElements(doc, page, [el], [50, 600, 400, 60]);
    expect(res.remainder).toHaveLength(0);
    expect(page.GetText()).toContain('juliet');
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/css-float.test.ts test/flowplace-floats.test.ts`
Expected: the two `css-float.test.ts` cases FAIL (`pages.length` is 1 — the float degrades to in-flow, so `LINE199` is on page 1 and page 2 does not exist). The `flowplace-floats.test.ts` case PASSES already, because Decision 3 is that `flowplace.ts` is not edited — it is a pin on an asymmetry, not a change. Record that it passed on the first run in the commit message rather than treating it as a bug.

- [ ] **Step 3: Confirm nothing needs implementing for these**

There is no source change in this task: Task 2 already made the `css-float.test.ts` cases pass. If they still fail, the fault is in Task 2's split step — do not add code here. Re-run and confirm:

Run: `npx vitest run test/css-float.test.ts test/flowplace-floats.test.ts`
Expected: PASS.

- [ ] **Step 4: Update `CLAUDE.md`**

Replace lines 613-614, which currently read:

```
  **Invariant:** `FloatContent` has FOUR members — `width`, `spacing`,
  `measure()`, `paintAt()` — and `FloatingBox` satisfies every one UNEDITED.
```

with:

```
  **Invariant:** `FloatContent` has FOUR REQUIRED members — `width`, `spacing`,
  `measure()`, `paintAt()` — and `FloatingBox` satisfies every one UNEDITED.
  Since `zch2.15` there is one OPTIONAL fifth, `splitPaint`, which only
  `elementFloat` implements; `FloatingBox` declines it and keeps its documented
  refusal to split, so it is STILL edited not at all.
```

Replace lines 636-639, which currently read:

```
  **Invariant, and it LOOKS like a violation of "a container never holds and
  paginates its children":** the wrapper DOES hold a group. It is allowed to
  because a float never SPLITS — `zch2.10` defers a float whole — so the
  wrapper never paginates. If splitting lands, this wrapper is what changes.
```

with:

```
  **Invariant, and `zch2.15`'s own issue predicted the opposite:** the wrapper
  DOES hold a group, and splitting did NOT force it to become a decorator over
  one child. The hazard "a container never holds and paginates its children"
  names a container with its OWN pagination loop; `placeElements` is not a
  second loop but the shared one, extracted in `zch2.5` so a caller can lay
  elements into ONE rect and get the overflow back, so a container that
  delegates to it is not what the rule forbids. The wrapper is unchanged.
  **Invariant (`zch2.15`):** a float splits ONLY when it cannot fit an EMPTY
  column. One that fits a column on its own still defers whole, which is what
  browsers do in paged media — push to the next fragmentainer, fragment only if
  it cannot. So splitting replaced the degrade path and moved nothing `zch2.10`
  shipped.
  **Invariant (`zch2.15`):** the excluded band comes from the height PAINTED,
  never from `measure()`. The engine discarded `paintAt`'s return value and
  after a split the two differ, so reading the measure narrows the channel past
  the column bottom for every element below. A fixture whose split head fills
  its budget exactly cannot see this.
  **Invariant (`zch2.15`):** a tail is accepted only when something was
  PAINTED, which is the termination proof — every split consumes drawn content,
  so the tail is strictly shorter than what produced it. Content that cannot
  fragment at all reports `height: 0`, the call has had no effect, and the
  degrade is still clean.
  **Note (`zch2.15`), and it is a deliberate asymmetry:** `flowplace.ts` does
  NOT split. One rect has no next column, so a split head would paint and the
  tail would land in a `remainder` most callers of `page.AddHtml` never
  re-place — half a float drawn and the rest silently gone, strictly worse than
  degrading to in-flow, which draws everything. Pinned in
  `test/flowplace-floats.test.ts` so it reads as a decision.
```

- [ ] **Step 5: Add the `CHANGELOG.md` entry**

Under `## [Unreleased]`, in the `### Fixed` section, add as the FIRST entry of that section:

```markdown
- **An HTML float taller than a whole column now splits across columns instead of silently laying out in flow.** `zch2.10` placed floats but deferred one that did not fit — it led the next column whole, and one taller than a whole column stopped being a float at all, so a tall sidebar in a two-column document simply became body text with nothing said. It now paints what fits, carries the rest, and leads the next column as a float again, with text wrapping beside both halves. **A float that fits a column on its own still defers whole**, which is what browsers do in paged media — push to the next fragmentainer, fragment only if it cannot — so nothing `zch2.10` shipped moves. Splitting is one optional member on `FloatContent`, `splitPaint`, which only the CSS float implements: a `FloatingBox` (`Flow.AddFloatBox`) is unaffected and still refuses, because its border and background have no defined way to continue across a column. `page.AddHtml` is unaffected too and deliberately so — it places into ONE rect, which has no next column, so a split head would paint and the tail would be lost; it keeps degrading to in-flow, which draws everything. **Still not reported:** content that cannot fragment at all — a lone image taller than the column — degrades in flow with nothing said, which is `zch2.16`, because it is a placement-time fact and `AddHtml` hands `skipped` back before anything is placed. (`zch2.15`)
```

- [ ] **Step 6: Run the full suite and typecheck**

Run: `npm run typecheck && npm test`
Expected: PASS, both. This is the gate — the issue cannot be closed on a partial run.

- [ ] **Step 7: Commit**

```bash
git add test/css-float.test.ts test/flowplace-floats.test.ts CLAUDE.md CHANGELOG.md
git commit -m "test(zch2.15): end-to-end split through AddHtml, and the flowplace pin

The flowplace case passed on its first run and is a PIN rather than a change:
placeElements is deliberately not edited, because one rect has no next column
and a split head would leave its tail in a remainder most callers never
re-place. It is in the suite so the asymmetry reads as a decision.

CLAUDE.md's FloatContent member count and the wrapper-never-paginates note
were both made false by this work and are rewritten.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

- [ ] **Step 8: Mutation sweep — prove the assertions load-bearing**

There is NO oracle for any of this: `test/fixtures/css-box/` measures used widths and collapsed gaps and nothing positional, and placement is not observable through `getComputedStyle` at all. So a green suite is not evidence until each rule has been broken and seen to redden. Run each mutation, record which cases go red, then REVERT it:

| # | Mutation | Must redden |
|---|---|---|
| 1 | In `flow.ts`, push the band from `h` instead of `splitHeight` | `flow-float-content.test.ts` "takes the excluded band from the height PAINTED" |
| 2 | In `flow.ts`, accept the tail when `splitHeight >= 0` instead of `> 0` | the render hangs or repeats — "degrades when splitPaint can place nothing" |
| 3 | In `flow.ts`, move the split step ABOVE the `!atColumnStart` defer | `flow-float-content.test.ts` "defers WHOLE rather than splitting" |
| 4 | In `flow.ts`, drop the `if (splitTail !== undefined) pending.push(splitTail)` | "splits across columns" (one paint, one page) and `css-float.test.ts` "splits across pages" |
| 5 | In `flowfloat.ts`, pass `elements` instead of `remainder` to the tail's `floatElement` | "splits across columns" — it never terminates or repaints the head |
| 6 | In `flowfloat.ts`, return `tail` unconditionally rather than on a non-empty remainder | `flowfloat.test.ts` "hands back NO tail when everything fits" |
| 7 | In `flowfloat.ts`, build the split rect as `[x, topY - h, width, h]` (the `paintAt` rect) | `flowfloat.test.ts` "paints what fits the budget" — `bravo` appears |

Record the result of every one in the issue's close notes, INCLUDING any that redden nothing — an uncovered rule is written down, not deleted. Add a note to `CLAUDE.md` for any mutation that reddens nothing, in the house form ("**Note, measured and NOT covered:** …").

- [ ] **Step 9: Close the issue and push**

```bash
bd close zch2.15
git pull --rebase
git push
git status   # MUST show "up to date with origin"
```

---

## Self-review

**Spec coverage.** Decision 1 → Task 2 Step 3 (position of the step) + the `zch2.10 stands` describe block + mutation 3. Decision 2 → Task 1 Step 3 (optional member) + Task 2's "still THROWS" case. Decision 3 → Task 3's `flowplace-floats` pin + the `CLAUDE.md` note. Decision 4 (fresh measure of the tail) → Task 2's "splits across columns", which relies on it for the third column, and `css-float.test.ts`'s "keeps narrowing the channel". Decision 5 (`zch2.16`) → filed already; named in the `CHANGELOG` entry and out of scope here. The seam → Task 1. The engine → Task 2. Testing section → Tasks 2 and 3 plus the Step 8 sweep. Files table → Tasks 1-3 exactly, with `floatstack.ts`, `floatbox.ts`, `flowplace.ts`, `cssflow.ts`, `cssframe.ts` untouched as the spec requires.

**Placeholders.** None: every step carries the code or the exact command, every fixture height is derived from the stated 698pt column, and every mutation names the case it must redden.

**Type consistency.** `splitPaint(page, x, topY, maxHeight, side, structParent?)` returning `{ height: number; tail?: FlowElement }` is used with that exact signature in Task 1 Step 3 (declaration), Task 1 Step 4 (implementation), Task 2's stubs, and Task 2 Step 3 (the caller). `tail` is a `FlowElement` in all four, never a `FloatContent`.

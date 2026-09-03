# CSS float placement Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `float: left` / `float: right` place through all three `AddHtml` entry
points, text wraps beside them, and `float` leaves the `skipped` report.

**Architecture:** a CSS float rides as an optional `float` marker on an ordinary
`FlowElement`, carrying a four-member `FloatContent` that `FloatingBox` already
satisfies unedited. `flow.ts`'s float branch reads the marker; `flowplace.ts`
gains the same band bookkeeping for one rect; and the adapter that turns
`FlowElement[]` into `FloatContent` is INJECTED into `cssflow.ts`, which is a
pure leaf and may not construct one.

**Tech Stack:** TypeScript (ESM, NodeNext, `strict`), vitest. No runtime
dependencies — `node:` built-ins only.

**Spec:** `docs/superpowers/specs/2026-09-02-css-float-placement-design.md`

## Global Constraints

- Zero runtime dependencies. Only `node:` built-ins.
- ESM + NodeNext: every import specifier carries the `.js` extension.
- `npm run typecheck` and `npm test` green before any task closes.
- Target one file with `npx vitest run test/<name>.test.ts`.
- TDD: the failing test is written and *observed failing* before the code.
- **A float is DEFERRED whole, never split.** One taller than a whole column
  lays out in flow.
- **Flow's "floats never share a side" rule stands.** `floatstack.ts` is NOT
  modified.
- **`FloatingBox` is not edited.** It must satisfy `FloatContent` as it stands;
  a required edit to it means the seam is wrong.
- **Fences that must not move:** `test/rich-runs-identity.test.ts`,
  `test/html-identity.test.ts`, and every existing float test
  (`npx vitest run test/ --reporter=basic` filtered to `float`).
- Every new rule gets a mutation check; anything uncovered is RECORDED in
  CLAUDE.md rather than quietly kept.
- CHANGELOG entry lands in Task 7, as one entry for the whole issue.

## One correction to the spec, settled while pinning signatures

The spec says `mapBox` "emits float items". It cannot emit N of them: a float
box lowers to `frameBoxes(...)` = one `BoxElement` per inner element, and a
marker on the first would leave the other N-1 in the queue to be placed a second
time. So a float box lowers to **exactly ONE** wrapper element holding the
group.

That looks like it violates CLAUDE.md's "a container never holds and paginates
its children" — it does not, and the reason is Decision 1: **a float never
splits**, so the wrapper never paginates. If splitting lands later, this wrapper
is the thing that has to change. Recorded in CLAUDE.md by Task 3.

## File structure

| File | Responsibility |
|---|---|
| `src/textextents.ts` (new) | Max-content / min-content of `string \| TextRun[]`. Extracted from `tableauthor.ts`. |
| `src/tableauthor.ts` | `cellExtents` becomes a thin wrapper over the leaf. |
| `src/flowelement.ts` | `FloatContent`; `FlowElement.float`. |
| `src/flow.ts` | `FloatItem.box` widens; `isFloat` widens; the degrade rule replaces the throw for degradable content. |
| `src/flowfloat.ts` (new) | `elementFloat` (the injected adapter) and `floatElement` (the wrapper). |
| `src/flowplace.ts` | Band bookkeeping for one rect; a measure walk sharing the place loop's gap arithmetic. |
| `src/cssflow.ts` | Emits float wrappers, supplies `MeasureFn`, reports same-side stacking; `float` leaves `skipped`. |
| `src/htmlflow.ts` | Supplies `makeFloat`, closing over the `Document`. |
| `scripts/gen-box-goldens.ts` | Float fixtures for the shrink-to-fit width oracle. |

---

### Task 1: Extract the min/max-content measurer

**Files:**
- Create: `src/textextents.ts`
- Modify: `src/tableauthor.ts` (delete `CellPiece`, `sliceWidth`, `measuringDriverFor`, `cellExtents`; import instead)
- Test: `test/textextents.test.ts`

**Interfaces:**
- Consumes: `AuthoringFont` (type, `stamp.js`), `TextRun`/`isTextRunList` (`textdecor.js`), `FontDriver`/`winAnsiDriver` (`layout.js`), `EmbeddedFont` (`embeddedfont.js`).
- Produces: `textExtents(text: string | TextRun[], font: AuthoringFont, fontSize: number): { longestLine: number; longestWord: number }`

- [ ] **Step 1: Write the failing test**

Create `test/textextents.test.ts`:

```ts
/** Max-content (widest LINE) and min-content (widest WORD), shared by table
 *  auto-fit and a CSS float's shrink-to-fit (zch2.10). */
import { describe, it, expect } from 'vitest';
import { textExtents } from '../src/textextents.js';

describe('textExtents', () => {
  it('measures the widest line and the widest word of a plain string', () => {
    const one = textExtents('aa', 'Helvetica', 10);
    const two = textExtents('aa aaaa', 'Helvetica', 10);
    // One line, so longestLine covers the whole string; the widest word is the
    // four-character one.
    expect(two.longestLine).toBeGreaterThan(one.longestLine);
    expect(two.longestWord).toBeGreaterThan(one.longestWord);
    expect(two.longestWord).toBeLessThan(two.longestLine);
  });

  it('measures LINES, not the whole string, across a hard break', () => {
    const wide = textExtents('aaaaaaaa', 'Helvetica', 10);
    const split = textExtents('aaaa\naaaa', 'Helvetica', 10);
    // Measuring across the break would demand a box fitting both lines at once.
    expect(split.longestLine).toBeLessThan(wide.longestLine);
  });

  it('measures each run at its OWN font size', () => {
    const small = textExtents([{ text: 'aaaa', fontSize: 6 }], 'Helvetica', 10);
    const big = textExtents([{ text: 'aaaa', fontSize: 20 }], 'Helvetica', 10);
    expect(big.longestLine).toBeGreaterThan(small.longestLine * 2);
  });

  it('finds a word spanning a RUN boundary', () => {
    // layoutRuns breaks on the concatenated text, so `aa`+`aa` is one word.
    const joined = textExtents([{ text: 'aa' }, { text: 'aa' }], 'Helvetica', 10);
    const apart = textExtents([{ text: 'aa ' }, { text: 'aa' }], 'Helvetica', 10);
    expect(joined.longestWord).toBeGreaterThan(apart.longestWord);
  });

  it('does not break on U+00A0, which a code block paints for indentation', () => {
    const nbsp = textExtents('aa aa', 'Helvetica', 10);
    const space = textExtents('aa aa', 'Helvetica', 10);
    expect(nbsp.longestWord).toBeGreaterThan(space.longestWord);
  });

  it('returns zeros for empty content', () => {
    expect(textExtents('', 'Helvetica', 10)).toEqual({ longestLine: 0, longestWord: 0 });
    expect(textExtents([], 'Helvetica', 10)).toEqual({ longestLine: 0, longestWord: 0 });
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run test/textextents.test.ts`
Expected: FAIL — cannot resolve `../src/textextents.js`.

- [ ] **Step 3: Create the leaf**

Create `src/textextents.ts` with the bodies moved VERBATIM from
`src/tableauthor.ts` (`CellPiece` at ~line 207, `sliceWidth` at ~line 213,
`measuringDriverFor` at ~line 200, `cellExtents` at ~line 237), with
`cellExtents` renamed and its `st: ResolvedStyle` parameter replaced by the two
fields it actually reads:

```ts
/** Max-content and min-content widths of a piece of text (zch2.10).
 *
 *  Invariant: a pure leaf. Extracted from tableauthor.ts because a CSS float's
 *  shrink-to-fit asks the same question a table column's auto-fit does, and two
 *  copies is two answers to "how wide does this content want to be".
 *
 *  Invariant: LINES rather than the whole string. A hard break means measuring
 *  across one would demand a box wide enough for every line at once.
 *
 *  Invariant: words are found on the CONCATENATED run text, because a word may
 *  span a run boundary (`**bold**text` is one word) — which is what layoutRuns
 *  does for break opportunities — while each piece is still measured at its own
 *  run's font. Only U+0020 and '\n' break, so the U+00A0 a code block paints
 *  for indentation keeps its line intact. */

import type { AuthoringFont } from './stamp.js';
import { isTextRunList, type TextRun } from './textdecor.js';
import { winAnsiDriver, type FontDriver } from './layout.js';
import { EmbeddedFont } from './embeddedfont.js';

const EMPTY = new Uint8Array(0);

/** One piece of content with the font it measures at. */
interface Piece { text: string; driver: FontDriver; fontSize: number }

/** A driver that measures like the real font but records no glyph usage —
 *  `encode` returns empty bytes, which measurement ignores. Keeps measuring
 *  side-effect-free for embedded fonts. */
function measuringDriverFor(font: AuthoringFont): FontDriver {
  const real: FontDriver = font instanceof EmbeddedFont ? font.driver() : winAnsiDriver(font);
  return { measure: (t, fs) => real.measure(t, fs), probe: (t) => real.probe(t), encode: () => EMPTY };
}

/** Width of the concatenated pieces' [from, to) slice, measured piece by piece
 *  so each keeps its own font. Summing per piece agrees exactly with measuring
 *  the whole string for the WinAnsi and Identity-H drivers. */
function sliceWidth(pieces: Piece[], from: number, to: number): number {
  let w = 0;
  let at = 0;
  for (const p of pieces) {
    const s = Math.max(from, at);
    const e = Math.min(to, at + p.text.length);
    if (e > s) w += p.driver.measure(p.text.slice(s - at, e - at), p.fontSize);
    at += p.text.length;
  }
  return w;
}

export function textExtents(
  text: string | TextRun[], font: AuthoringFont, fontSize: number,
): { longestLine: number; longestWord: number } {
  const pieces: Piece[] = isTextRunList(text)
    ? text.map((r) => ({
      text: r.text,
      driver: measuringDriverFor(r.font ?? font),
      fontSize: r.fontSize ?? fontSize,
    }))
    : [{ text, driver: measuringDriverFor(font), fontSize }];
  const all = pieces.map((p) => p.text).join('');
  let longestLine = 0;
  let longestWord = 0;
  let lineStart = 0;
  let wordStart = 0;
  for (let i = 0; i <= all.length; i++) {
    const ch = i < all.length ? all[i] : '\n';
    if (ch !== '\n' && ch !== ' ') continue;
    if (i > wordStart) longestWord = Math.max(longestWord, sliceWidth(pieces, wordStart, i));
    wordStart = i + 1;
    if (ch === '\n') {
      longestLine = Math.max(longestLine, sliceWidth(pieces, lineStart, i));
      lineStart = i + 1;
    }
  }
  return { longestLine, longestWord };
}
```

- [ ] **Step 4: Make `tableauthor.ts` delegate**

Delete `EMPTY`, `measuringDriverFor`, `CellPiece`, `sliceWidth` and the body of
`cellExtents` from `src/tableauthor.ts`, add
`import { textExtents } from './textextents.js';`, and replace `cellExtents`
with:

```ts
/** The widest single LINE (max-content) and widest single WORD (min-content) of
 *  a cell's content, in points, excluding padding. The rules live in
 *  textextents.ts, shared with a CSS float's shrink-to-fit. */
function cellExtents(
  text: string | TextRun[], st: ResolvedStyle,
): { longestLine: number; longestWord: number } {
  return textExtents(text, st.font, st.fontSize);
}
```

**`measuringDriverFor` MUST STAY in `tableauthor.ts`** — verified: besides the
two calls inside `cellExtents` (lines 243 and 246, which leave with it), it has
two more at lines 786 and 790, in the row-height walk. So delete `EMPTY`,
`CellPiece`, `sliceWidth` and `cellExtents`'s body, and **keep**
`measuringDriverFor` (and the `EMPTY` constant it needs) where they are. The
leaf gets its own private copy.

That is a deliberate duplication of six lines, and the alternative is worse:
exporting the leaf's copy would make a pure-measurement helper part of a module
boundary for no gain, and the two are not a rule that can drift — a driver that
measures like the real font and encodes nothing is the same six lines in both
places or it is broken in one of them, which its own callers would show
immediately.

- [ ] **Step 5: Run the table fences**

Run: `npx vitest run test/textextents.test.ts test/table-author.test.ts test/table-autofit.test.ts test/csstable.test.ts test/table-cell-runs.test.ts test/table-slice-identity.test.ts`
Expected: PASS. This is a pure extraction — a red table test means a body was
changed on the way out, not merely moved.

- [ ] **Step 6: Add the CLAUDE.md module entry**

A new `src/*.ts` earns its entry when it lands, per the module-list rule. Insert
near `textcoverage.ts` in the Source list:

```markdown
- **textextents.ts** — max-content and min-content widths of a piece of text
  (`zch2.10`). A pure leaf, extracted from `tableauthor.ts` because a CSS
  float's shrink-to-fit asks the same question a table column's auto-fit does,
  and two copies is two answers to "how wide does this content want to be".
  **Invariant:** LINES rather than the whole string. `addCell` takes arbitrary
  text and `mdruns.ts` maps a hard break to `'\n'`, so measuring across one
  would demand a box wide enough for every line at once.
  **Invariant:** words are found on the CONCATENATED run text, because a word
  may span a run boundary (`**bold**text` is one word) — the rule `layoutRuns`
  already uses for break opportunities — while each piece is still measured at
  its own run's font. Only U+0020 and `'\n'` break, so the U+00A0 a code block
  paints for indentation keeps its line intact.
  **Invariant:** its measuring driver records NO glyph usage (`encode` returns
  empty bytes, which measurement ignores), so asking how wide an embedded font
  wants to be does not retain glyphs for text that may never be drawn.
```

- [ ] **Step 7: Typecheck and commit**

```bash
npm run typecheck
git add src/textextents.ts src/tableauthor.ts test/textextents.test.ts CLAUDE.md
git commit -m "refactor(zch2.10): textextents.ts, one owner of min/max-content width"
```

---

### Task 2: The `FloatContent` seam and the degrade rule

**Files:**
- Modify: `src/flowelement.ts` (add `FloatContent`; add `FlowElement.float`)
- Modify: `src/flow.ts` (`FloatItem.box` type; `isFloat`; the float branch's content lookup; the throw at ~line 1368)
- Test: `test/flow-float-content.test.ts`

**Interfaces:**
- Consumes: nothing from Task 1.
- Produces:
  - `interface FloatContent { readonly width: number; readonly spacing: number; measure(): number; paintAt(page: Page, x: number, topY: number, structParent?: StructElement): number; readonly degradeOnOverflow?: boolean }`
  - `FlowElement.float?: { side: 'left' | 'right'; content: FloatContent }`

- [ ] **Step 1: Write the failing test**

Create `test/flow-float-content.test.ts`:

```ts
/** The engine floats anything satisfying FloatContent, and an element carrying
 *  a float marker is floated as one (zch2.10). Driven from a hand-built
 *  FloatContent, so nothing here needs the CSS stack. */
import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { PageFormat } from '../src/pageformat.js';
import { paragraph } from '../src/flow.js';
import type { FloatContent, FlowElement } from '../src/flowelement.js';
import type { Page } from '../src/page.js';

/** A FloatContent that records where it was painted and draws nothing. */
function stubContent(width: number, height: number, degrade = false): FloatContent & {
  painted: { x: number; topY: number }[];
} {
  const painted: { x: number; topY: number }[] = [];
  return {
    width, spacing: 0, painted,
    degradeOnOverflow: degrade,
    measure: () => height,
    paintAt: (_page: Page, x: number, topY: number) => { painted.push({ x, topY }); return height; },
  };
}

/** An element carrying a float marker; its own place() is the degrade path. */
function floatEl(content: FloatContent, side: 'left' | 'right'): FlowElement {
  const inner = paragraph('degraded body text')[0];
  return {
    float: { side, content },
    spaceBefore: 0,
    spaceAfter: 0,
    place: (ctx) => inner.place(ctx),
    measure: (ctx) => inner.measure!(ctx),
  };
}

describe('an element carrying a float marker', () => {
  it('is painted through its FloatContent, not placed in flow', () => {
    const c = stubContent(100, 50);
    const doc = Document.New();
    const flow = doc.NewFlow({ format: PageFormat.A4 });
    flow.AddElements([floatEl(c, 'left')]);
    flow.AddParagraph('body text that should wrap beside the float');
    flow.Render();
    expect(c.painted).toHaveLength(1);
  });

  it('narrows the channel for the text beside it', () => {
    const build = (withFloat: boolean) => {
      const doc = Document.New();
      const flow = doc.NewFlow({ format: PageFormat.A4 });
      if (withFloat) flow.AddElements([floatEl(stubContent(200, 60), 'left')]);
      flow.AddParagraph('alpha bravo charlie delta echo foxtrot golf hotel india');
      const page = flow.Render()[0];
      return page.GetTextFragments().map((f) => f.quad[0]);
    };
    const withoutX = Math.min(...build(false));
    const withX = Math.min(...build(true));
    // The float is on the left, so the text starts further right.
    expect(withX).toBeGreaterThan(withoutX + 100);
  });
});

describe('a float that cannot fit an empty column', () => {
  it('THROWS when the content is not degradable (FloatingBox behaviour)', () => {
    const doc = Document.New();
    const flow = doc.NewFlow({ format: PageFormat.A4 });
    flow.AddElements([floatEl(stubContent(100, 5000, false), 'left')]);
    expect(() => flow.Render()).toThrow(/does not fit in an empty column/);
  });

  it('lays out in flow and does NOT throw when it is degradable', () => {
    const c = stubContent(100, 5000, true);
    const doc = Document.New();
    const flow = doc.NewFlow({ format: PageFormat.A4 });
    flow.AddElements([floatEl(c, 'left')]);
    const pages = flow.Render();
    expect(c.painted).toHaveLength(0);           // never floated
    expect(pages[0].GetText()).toContain('degraded body text'); // placed in flow
  });
});
```

**`Flow.AddElements` does not exist yet** — verified: the only
`this.items.push(...elements)` sites are inside `AddMarkdown` and `AddHtml`, and
neither takes a caller's list. Add it in Step 3, beside `AddQuote`:

```ts
  /** @internal Append already-built elements. The seam AddMarkdown and AddHtml
   *  use internally, exposed so a float can be driven from a hand-built
   *  FloatContent with no CSS stack in the way. */
  AddElements(elements: FlowElement[]): this {
    if (!Array.isArray(elements)) throw new TypeError('elements must be an array');
    this.items.push(...elements);
    return this;
  }
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run test/flow-float-content.test.ts`
Expected: FAIL — `float` is not a known `FlowElement` member and the elements
place in flow rather than floating.

- [ ] **Step 3: Add `FloatContent` and the marker**

In `src/flowelement.ts`, after the `FlowElement` interface:

```ts
/** What the flow engine needs of a floated thing: how wide a band it excludes,
 *  how tall it is, and how to paint it.
 *
 *  Invariant: FOUR members, and `FloatingBox` satisfies every one of them
 *  unedited — that is what lets a CSS float join the existing float branch
 *  instead of adding a second one. A required edit to FloatingBox means this
 *  seam is wrong. */
export interface FloatContent {
  /** Drawn width; the excluded band is `width + spacing`. */
  readonly width: number;
  /** Gap between the box and the text beside it. */
  readonly spacing: number;
  /** Height at `width`, non-destructively. */
  measure(): number;
  /** Draw at `x` with its TOP edge at `topY`; returns the height drawn. */
  paintAt(page: Page, x: number, topY: number, structParent?: StructElement): number;
  /** Lay out in flow rather than throwing when it cannot fit an EMPTY column.
   *  Only a CSS float sets it: this epic's rule is degrade-and-report, while
   *  FloatingBox's documented contract is to throw. */
  readonly degradeOnOverflow?: boolean;
}
```

and inside `FlowElement`, beside `clear`:

```ts
  /** Float this element instead of placing it in flow. The engine paints
   *  `content` and narrows the channel; `place()` is then reached ONLY on the
   *  degrade path, when the float cannot fit an empty column. */
  readonly float?: { side: 'left' | 'right'; content: FloatContent };
```

- [ ] **Step 4: Widen the engine**

In `src/flow.ts`:

```ts
interface FloatItem { readonly kind: 'float'; readonly box: FloatContent; readonly side: 'left' | 'right'; }
```

(import `FloatContent` from `./flowelement.js`; `FloatingBox` stays imported for
`AddFloatBox`'s signature.)

Replace `isFloat` and add a content lookup:

```ts
function isFloat(item: FlowItem): item is FloatItem {
  return (item as FloatItem).kind === 'float';
}
/** The float a queue item carries: an explicit FloatItem, or an element with a
 *  marker. Returns undefined for anything that places in flow. */
function floatOf(item: FlowItem): { content: FloatContent; side: 'left' | 'right' } | undefined {
  if (isFloat(item)) return { content: item.box, side: item.side };
  const f = (item as FlowElement).float;
  return f === undefined ? undefined : { content: f.content, side: f.side };
}
```

In `Render`, replace `if (isFloat(item)) {` with `const fl = floatOf(item); if (fl !== undefined) {`
and inside it replace `const box = item.box;` with `const box = fl.content;` and
every `item.side` with `fl.side`.

Then rewrite the fit check. **A degrading float must FALL THROUGH to ordinary
placement, not continue down the float path** — so the `boxTop`/`h` computation
moves above the branch and the branch is entered only when the box will actually
be floated. Replace the whole `if (isFloat(item)) { … }` block with:

```ts
      const fl = floatOf(item);
      let floatPlan: { top: number; height: number } | undefined;
      if (fl !== undefined) {
        const h = fl.content.measure();
        const gap = atColumnStart ? 0 : pendingSpaceAfter + g.paragraphSpacing + fl.content.spacing;
        const naturalTop = colTop - gap;
        const boxTop = resolveFloatTop(
          floats, fl.side, fl.content.width, fl.content.spacing, naturalTop, g.columnWidth);
        if (boxTop - h >= g.contentBottom - 1e-9) {
          floatPlan = { top: boxTop, height: h };
        } else if (!atColumnStart) {
          // Defer rather than advancing: taking the column with us would abandon
          // the rest of it. Following content keeps filling this column and the
          // box leads the next one. A column start has no active floats, so a
          // carried float there either fits, degrades, or throws — this
          // terminates.
          pending.push(item);
          queue.shift();
          continue;
        } else if (fl.content.degradeOnOverflow !== true) {
          throw new Error('Flow: floating box does not fit in an empty column (column too short for the box)');
        }
        // Degradable and it will not fit an empty column: leave floatPlan
        // undefined and fall through. The marker rides ON a FlowElement, so
        // "not floating it" is just placing it, frame and content intact —
        // there is no fallback rendering path to write.
      }
      if (fl !== undefined && floatPlan !== undefined) {
        const page = ensurePage(pageIdx);
        const boxX = fl.side === 'left'
          ? columnX(g, col)
          : columnX(g, col) + g.columnWidth - fl.content.width;
        fl.content.paintAt(page, boxX, floatPlan.top, structParent);
        floats.push({
          side: fl.side,
          band: fl.content.width + fl.content.spacing,
          bottom: floatPlan.top - floatPlan.height,
        });
        // A float never advances the pen past itself. The comparison is exact —
        // resolveFloatTop returns the very naturalTop it was given when nothing
        // pushes the box.
        if (floatPlan.top === colTop - (atColumnStart ? 0 : pendingSpaceAfter + g.paragraphSpacing + fl.content.spacing))
          colTop = floatPlan.top;
        atColumnStart = false;
        pendingSpaceAfter = 0;
        queue.shift();
        continue;
      }
```

Hoist `naturalTop` to a `const` in the outer scope of that block rather than
recomputing it in the pen-advance comparison — the duplicated expression above is
written out only so the intent is unambiguous; a single `naturalTop` binding
reused in both places is what should land.

- [ ] **Step 5: Run the test and the float fences**

Run: `npx vitest run test/flow-float-content.test.ts`
Expected: PASS, 4 tests.

Run: `npx vitest run test/floatstack.test.ts test/flow-floats.test.ts test/floatbox.test.ts`
Expected: PASS. Use whichever of those exist —
`ls test | grep -i float` first. The `FloatContent` widening is a type change
with no logic behind it; a red test there means it was not.

- [ ] **Step 6: Typecheck and commit**

```bash
npm run typecheck
git add src/flowelement.ts src/flow.ts test/flow-float-content.test.ts
git commit -m "feat(zch2.10): FloatContent seam and the degrade-instead-of-throw rule"
```

---

### Task 3: `flowfloat.ts` — the adapter and the wrapper

**Files:**
- Create: `src/flowfloat.ts`
- Test: `test/flowfloat.test.ts`
- Modify: `CLAUDE.md` (module entry)

**Interfaces:**
- Consumes: `FloatContent`, `FlowElement` (Task 2); `placeElements` (`flowplace.js`).
- Produces:
  - `elementFloat(doc: Document, elements: FlowElement[], width: number, spacing: number): FloatContent`
  - `floatElement(elements: FlowElement[], side: 'left' | 'right', content: FloatContent, spaceBefore: number, spaceAfter: number): FlowElement`

- [ ] **Step 1: Write the failing test**

Create `test/flowfloat.test.ts`:

```ts
/** The element-backed float: a FloatContent over FlowElement[] (zch2.10). */
import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { PageFormat } from '../src/pageformat.js';
import { paragraph } from '../src/flow.js';
import { elementFloat, floatElement } from '../src/flowfloat.js';

describe('elementFloat', () => {
  it('measures the height its elements will occupy at the float width', () => {
    const doc = Document.New();
    const c = elementFloat(doc, paragraph('one line of text'), 200, 0);
    expect(c.measure()).toBeGreaterThan(0);
    expect(c.width).toBe(200);
    expect(c.spacing).toBe(0);
  });

  it('measure() equals what paintAt() consumes', () => {
    // One walk, or a float measures one way and paints another.
    const doc = Document.New();
    const { page } = doc.AddPage(PageFormat.A4);
    const c = elementFloat(doc, paragraph('alpha bravo charlie delta echo'), 120, 0);
    const measured = c.measure();
    const painted = c.paintAt(page, 50, 700);
    expect(painted).toBeCloseTo(measured, 6);
  });

  it('is degradable, unlike a FloatingBox', () => {
    const doc = Document.New();
    expect(elementFloat(doc, paragraph('x'), 100, 0).degradeOnOverflow).toBe(true);
  });

  it('measure() draws nothing', () => {
    const doc = Document.New();
    const { page } = doc.AddPage(PageFormat.A4);
    const before = page.GetText();
    elementFloat(doc, paragraph('must not appear'), 200, 0).measure();
    expect(page.GetText()).toBe(before);
  });
});

describe('floatElement', () => {
  it('carries the marker and places its children in flow when asked', () => {
    const doc = Document.New();
    const { page } = doc.AddPage(PageFormat.A4);
    const inner = paragraph('inner body');
    const c = elementFloat(doc, inner, 200, 0);
    const el = floatElement(inner, 'left', c, 0, 0);
    expect(el.float?.side).toBe('left');
    expect(el.float?.content).toBe(c);
    // place() is the degrade path.
    const res = el.place({ doc, page, x: 50, top: 700, width: 400, availHeight: 600 });
    expect(res.drew).toBe(true);
    expect(page.GetText()).toContain('inner body');
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run test/flowfloat.test.ts`
Expected: FAIL — cannot resolve `../src/flowfloat.js`.

- [ ] **Step 3: Create the module**

Create `src/flowfloat.ts`:

```ts
/** A CSS float as the flow engine sees it (zch2.10): a FloatContent over an
 *  ordinary FlowElement[], and the wrapper element that carries the marker.
 *
 *  Invariant: `elementFloat` captures a Document, which is why it is INJECTED
 *  into cssflow.ts rather than constructed there. placeElements needs a
 *  Document; FloatingBox captures one at construction; Page.doc is PRIVATE and
 *  paintAt takes only a Page — so the adapter must capture one too, and
 *  cssflow.ts is a pure leaf that may not import document.js.
 *
 *  Invariant: measure() and paintAt() run the SAME placement, so the two agree
 *  by construction. Two walks is how a float comes to measure one way and paint
 *  another.
 *
 *  Invariant, and it looks like a violation of CLAUDE.md's "a container never
 *  holds and paginates its children": the wrapper DOES hold a group. It is
 *  allowed to because a float never SPLITS (zch2.10 defers whole rather than
 *  splitting), so the wrapper never paginates. If splitting lands later, this
 *  wrapper is the thing that has to change. */

import type { Document } from './document.js';
import type { Page } from './page.js';
import type { StructElement } from './struct.js';
import type { FloatContent, FlowElement, PlaceContext, PlaceResult, MeasureContext } from './flowelement.js';
import { placeElements } from './flowplace.js';

/** A FloatContent backed by flow elements, painted through placeElements. */
export function elementFloat(
  doc: Document, elements: FlowElement[], width: number, spacing: number,
): FloatContent {
  return {
    width,
    spacing,
    // A CSS float degrades to ordinary flow rather than throwing.
    degradeOnOverflow: true,
    measure(): number {
      return measureElements(elements, width);
    },
    paintAt(page: Page, x: number, topY: number, structParent?: StructElement): number {
      const h = measureElements(elements, width);
      // rect y is the BOTTOM edge, the convention placeElements takes.
      const { usedHeight } = placeElements(
        doc, page, elements, [x, topY - h, width, h],
        { paragraphSpacing: 0, structParent });
      return usedHeight;
    },
  };
}

/** The single element a float box lowers to: it carries the marker, and its
 *  own place() is the degrade path. */
export function floatElement(
  elements: FlowElement[], side: 'left' | 'right', content: FloatContent,
  spaceBefore: number, spaceAfter: number,
): FlowElement {
  // Named rather than `this` inside an object literal: under `strict` an
  // object-literal method's `this` is implicitly typed, and the remainder has
  // to be the element itself.
  const el: FlowElement = {
    float: { side, content },
    spaceBefore,
    spaceAfter,
    place(ctx: PlaceContext): PlaceResult {
      const { usedHeight, remainder } = placeElements(
        ctx.doc, ctx.page, elements,
        [ctx.x, ctx.top - ctx.availHeight, ctx.width, ctx.availHeight],
        { paragraphSpacing: ctx.paragraphSpacing ?? 0, structParent: ctx.structParent });
      return {
        usedHeight,
        drew: usedHeight > 0,
        // A float never splits, so an overflowing degrade is reported as "did
        // not fit here" and retried in the next column, whole.
        remainder: remainder.length === 0 ? null : el,
      };
    },
    measure(ctx: MeasureContext): { usedHeight: number; fits: boolean } {
      const h = measureElements(elements, ctx.width);
      return { usedHeight: Math.min(h, ctx.availHeight), fits: h <= ctx.availHeight };
    },
  };
  return el;
}
```

`measureElements` comes from Task 4. Until then this module will not typecheck —
that is expected; Tasks 3 and 4 land together in the same commit if the executor
prefers, or Task 4 first. **If executing in order, do Task 4 before Task 3's
Step 4.**

- [ ] **Step 4: Run the test**

Run: `npx vitest run test/flowfloat.test.ts`
Expected: PASS, 5 tests. (Requires Task 4's `measureElements`.)

- [ ] **Step 5: Add the CLAUDE.md entry**

Add a `- **flowfloat.ts** — …` entry to the Source list, near the
`flowelement.ts`/`flowblock.ts`/`flowplace.ts` entry, carrying the three
invariants from the module header verbatim.

- [ ] **Step 6: Typecheck and commit**

```bash
npm run typecheck
git add src/flowfloat.ts test/flowfloat.test.ts CLAUDE.md
git commit -m "feat(zch2.10): flowfloat.ts, the element-backed float and its wrapper"
```

---

### Task 4: Bands and a measure walk in `flowplace.ts`

**Files:**
- Modify: `src/flowplace.ts`
- Test: `test/flowplace-floats.test.ts`

**Interfaces:**
- Consumes: `ActiveFloat`, `insetsAt`, `nextBoundary`, `pruneFloats`, `clearTo` (`floatstack.js`); `floatOf`-equivalent logic (local).
- Produces: `measureElements(elements: FlowElement[], width: number): number`

- [ ] **Step 1: Write the failing test**

Create `test/flowplace-floats.test.ts`:

```ts
/** placeElements gains the same band bookkeeping Render has, so page.AddHtml
 *  places floats too — zch2.5's rule is that the three entry points are one
 *  implementation (zch2.10). */
import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { PageFormat } from '../src/pageformat.js';
import { paragraph } from '../src/flow.js';
import { placeElements, measureElements } from '../src/flowplace.js';
import { elementFloat, floatElement } from '../src/flowfloat.js';

const BODY = 'alpha bravo charlie delta echo foxtrot golf hotel india juliet';

function render(withFloat: boolean): number {
  const doc = Document.New();
  const { page } = doc.AddPage(PageFormat.A4);
  const els = [];
  if (withFloat) {
    const inner = paragraph('float');
    els.push(floatElement(inner, 'left', elementFloat(doc, inner, 150, 6), 0, 0));
  }
  els.push(...paragraph(BODY));
  placeElements(doc, page, els, [50, 50, 400, 700]);
  return Math.min(...page.GetTextFragments().map((f) => f.quad[0]));
}

describe('placeElements with a float', () => {
  it('narrows the channel for the text beside it', () => {
    expect(render(true)).toBeGreaterThan(render(false) + 100);
  });

  it('places the float itself', () => {
    const doc = Document.New();
    const { page } = doc.AddPage(PageFormat.A4);
    const inner = paragraph('floated words');
    placeElements(doc, page, [
      floatElement(inner, 'left', elementFloat(doc, inner, 150, 6), 0, 0),
      ...paragraph(BODY),
    ], [50, 50, 400, 700]);
    expect(page.GetText()).toContain('floated words');
  });
});

describe('measureElements', () => {
  it('reports the height placeElements consumes for the same elements', () => {
    const doc = Document.New();
    const { page } = doc.AddPage(PageFormat.A4);
    const els = paragraph(BODY);
    const measured = measureElements(els, 300);
    const { usedHeight } = placeElements(doc, page, els, [50, 50, 300, 700]);
    expect(measured).toBeCloseTo(usedHeight, 6);
  });

  it('draws nothing', () => {
    const doc = Document.New();
    const { page } = doc.AddPage(PageFormat.A4);
    measureElements(paragraph('must not appear'), 300);
    expect(page.GetText()).toBe('');
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run test/flowplace-floats.test.ts`
Expected: FAIL — `measureElements` is not exported, and the float places in flow.

- [ ] **Step 3: Add `measureElements`**

In `src/flowplace.ts`:

```ts
/** Height `elements` would occupy at `width` with unlimited room, including the
 *  gaps between them. Shares the gap arithmetic with {@link placeElements} —
 *  `spaceAfter + paragraphSpacing + spaceBefore`, dropped above the first — so
 *  the two cannot disagree about the same list. Draws nothing. */
export function measureElements(
  elements: FlowElement[], width: number, paragraphSpacing = 0,
): number {
  let total = 0;
  let started = false;
  let pendingAfter = 0;
  for (const el of elements) {
    const m = el.measure?.({ width, availHeight: Infinity });
    if (m === undefined || m.usedHeight <= 0) continue;
    total += (started ? pendingAfter + paragraphSpacing + (el.spaceBefore ?? 0) : 0) + m.usedHeight;
    started = true;
    pendingAfter = el.spaceAfter ?? 0;
  }
  return total;
}
```

- [ ] **Step 4: Add the band bookkeeping**

In `placeElements`, before the loop:

```ts
  let floats: ActiveFloat[] = [];
```

and inside the loop, before the gap arithmetic, handle a float and then narrow
the channel:

```ts
    floats = pruneFloats(floats, top);
    const fl = elements[i].float;
    if (fl !== undefined) {
      const fh = fl.content.measure();
      const naturalTop = top - (started ? pendingAfter + ps + (el.spaceBefore ?? 0) : 0);
      const fTop = resolveFloatTop(floats, fl.side, fl.content.width, fl.content.spacing,
        naturalTop, w);
      // One rect and no next column: a float that does not fit is simply not
      // floated, and falls through to ordinary placement below.
      if (fTop - fh >= y - 1e-9) {
        const fx = fl.side === 'left' ? x : x + w - fl.content.width;
        fl.content.paintAt(page, fx, fTop, options.structParent);
        floats.push({ side: fl.side, band: fl.content.width + fl.content.spacing, bottom: fTop - fh });
        if (fTop === naturalTop) top = fTop;
        started = true;
        pendingAfter = 0;
        continue;
      }
    }
    const { left: insetL, right: insetR } = insetsAt(floats, top);
```

then narrow the region exactly as `flow.ts:1414-1422` does — that code, adapted
to a rect (`y` is the bottom, and there is no next column to skip to):

```ts
    // Region: narrowed by the floats in force at `top`, and capped at the y
    // where the channel next widens so the element re-flows there.
    const { left: insetL, right: insetR } = insetsAt(floats, top);
    const besideFloat = insetL > 0 || insetR > 0;
    const boundary = besideFloat ? nextBoundary(floats, top)! : 0;
    const elemX = x + insetL;
    const elemWidth = w - insetL - insetR;
    const elemAvail = besideFloat ? elTop - boundary : elTop - y;
    // A left and a right band can swallow the rect between them: drop the pen
    // to where it reopens. flow.ts skips to the next column here; a rect has
    // none, so the pen simply moves down.
    if (elemWidth <= 0) { top = boundary; continue; }
```

and pass `elemX` / `elemWidth` / `elemAvail` into `el.place(...)` in place of
`x` / `w` / `availHeight`. When an element beside a float comes back with a
remainder, drop `top` to `boundary` and retry rather than stopping — that is
what lets text resume at full width below the float.

Import from `./floatstack.js`: `insetsAt`, `nextBoundary`, `pruneFloats`,
`resolveFloatTop`, `type ActiveFloat`.

- [ ] **Step 5: Run the tests**

Run: `npx vitest run test/flowplace-floats.test.ts test/flowfloat.test.ts`
Expected: PASS.

- [ ] **Step 6: Run the fences**

Run: `npx vitest run test/rich-runs-identity.test.ts test/html-identity.test.ts test/html-render.test.ts test/markdown-flow.test.ts`
Expected: PASS. `placeElements` runs for every `page.AddMarkdown`/`page.AddHtml`
call, so a document with no floats must be byte-identical.

- [ ] **Step 7: Typecheck and commit**

```bash
npm run typecheck
git add src/flowplace.ts test/flowplace-floats.test.ts
git commit -m "feat(zch2.10): placeElements places floats and measures without drawing"
```

---

### Task 5: Wire the CSS stack

**Files:**
- Modify: `src/cssflow.ts` (emit float wrappers; `MeasureFn`; same-side report; drop the `float` skip)
- Modify: `src/htmlflow.ts` (supply `makeFloat`)
- Test: `test/css-float.test.ts`

**Interfaces:**
- Consumes: `elementFloat`, `floatElement` (Task 3); `textExtents` (Task 1); `MeasureFn` (`cssresolve.js`, existing).
- Produces: `CssFlowOptions.makeFloat?: (elements: FlowElement[], width: number, spacing: number) => FloatContent`

- [ ] **Step 1: Write the failing test**

Create `test/css-float.test.ts`:

```ts
/** CSS floats place, and `float` has left the skipped report (zch2.10). */
import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { PageFormat } from '../src/pageformat.js';

const SRC = `<div style="float:left;width:150px">FLOATED</div>
<p>alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima</p>`;

const leftmostBody = (page: { GetTextFragments(): { quad: number[]; text: string }[] }): number =>
  Math.min(...page.GetTextFragments()
    .filter((f) => !f.text.includes('FLOATED'))
    .map((f) => f.quad[0]));

describe('AddHtml places a float', () => {
  it('narrows the channel for the text beside it', () => {
    const withFloat = Document.New().AddHtml(SRC).pages[0];
    const without = Document.New().AddHtml(
      '<p>alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima</p>',
    ).pages[0];
    expect(leftmostBody(withFloat)).toBeGreaterThan(leftmostBody(without) + 100);
  });

  it('draws the float’s own content', () => {
    expect(Document.New().AddHtml(SRC).pages[0].GetText()).toContain('FLOATED');
  });

  it('no longer reports float in skipped', () => {
    // A construct LEAVING the report is worth pinning: a caller reads it to
    // tell a dropped construct from an empty document.
    const { skipped } = Document.New().AddHtml(SRC);
    expect(skipped.filter((r) => r.construct === 'float')).toEqual([]);
  });

  it('clears past a float when asked', () => {
    const cleared = Document.New().AddHtml(
      `${SRC}<p style="clear:left">AFTER</p>`).pages[0];
    const after = cleared.GetTextFragments().filter((f) => f.text.includes('AFTER'));
    expect(after).toHaveLength(1);
    // A cleared paragraph starts at the container's left edge, not indented.
    expect(after[0].quad[0]).toBeLessThan(leftmostBody(cleared) + 1);
  });

  it('shrink-to-fits an auto-width float rather than filling the column', () => {
    const auto = Document.New().AddHtml(
      `<div style="float:left">hi</div><p>alpha bravo charlie delta echo foxtrot</p>`).pages[0];
    // A full-width float would exclude the whole channel and leave the text
    // below it at the container's left edge; a shrunk one indents it a little.
    const xs = auto.GetTextFragments().filter((f) => !f.text.includes('hi')).map((f) => f.quad[0]);
    expect(Math.min(...xs)).toBeGreaterThan(72);
    expect(Math.min(...xs)).toBeLessThan(200);
  });

  it('reports two same-side floats that CSS would have put side by side', () => {
    const { skipped } = Document.New().AddHtml(
      `<div style="float:left;width:50px">A</div><div style="float:left;width:50px">B</div><p>x</p>`);
    const f = skipped.filter((r) => r.construct === 'float');
    expect(f).toHaveLength(1);
    expect(f[0].kind).toBe('degraded');
  });

  it('places floats through all three entry points alike', () => {
    const viaDoc = Document.New().AddHtml(SRC).pages[0].GetText();
    const flowDoc = Document.New();
    const flow = flowDoc.NewFlow({ format: PageFormat.A4 });
    flow.AddHtml(SRC);
    const viaFlow = flow.Render()[0].GetText();
    const pageDoc = Document.New();
    const { page } = pageDoc.AddPage(PageFormat.A4);
    page.AddHtml(SRC, [72, 72, 451, 697]);
    const viaPage = page.GetText();
    expect(viaFlow.replace(/\s+/g, ' ').trim()).toBe(viaDoc.replace(/\s+/g, ' ').trim());
    expect(viaPage.replace(/\s+/g, ' ').trim()).toBe(viaDoc.replace(/\s+/g, ' ').trim());
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run test/css-float.test.ts`
Expected: FAIL — the float still lays out in flow and still reports.

- [ ] **Step 3: Add the `makeFloat` seam**

In `src/cssflow.ts`, add to `CssFlowOptions` and to `Ctx`:

```ts
  /** Turns a float box's elements into a FloatContent. INJECTED because the
   *  adapter must capture a Document and this module is a pure leaf —
   *  htmlflow.ts supplies it, exactly as it supplies resolveFamily. Omitted:
   *  floats lay out in flow and report, which is the pre-zch2.10 behaviour. */
  makeFloat?: (elements: FlowElement[], width: number, spacing: number) => FloatContent;
```

In `src/htmlflow.ts`, beside the existing `resolveFamily` default:

```ts
    makeFloat: options.makeFloat
      ?? ((els, width, spacing) => elementFloat(doc, els, width, spacing)),
```

- [ ] **Step 4: Emit the float wrapper**

In `src/cssflow.ts`'s `mapBox`, delete the `c.skipped.push({ … construct: 'float' … })`
block and instead wrap the box's produced elements at the END of the function.
The cleanest shape, given `mapBox` has several `return` points, is to rename the
existing body to `mapBoxInner` and add:

```ts
/** Map one box, floating it when it says so. A float box lowers to exactly ONE
 *  wrapper element: a marker on the first of several would leave the rest in
 *  the queue to be placed a second time. */
function mapBox(r: ResolvedBox, spaceBefore: number, c: Ctx): FlowElement[] {
  const els = mapBoxInner(r, spaceBefore, c);
  const side = r.box.float;
  if (side === 'none' || els.length === 0 || c.makeFloat === undefined) return els;
  const spacing = side === 'left' ? r.marginRight : r.marginLeft;
  const content = c.makeFloat(els, r.borderBoxWidth, spacing);
  return [floatElement(els, side, content, spaceBefore, 0)];
}
```

`ResolvedBox` carries `contentWidth`, `insetLeft`/`insetRight` and
`marginLeft`/`marginRight` (verified, `cssresolve.ts:27-38`) — there is **no**
`borderBoxWidth` field, so compute it as a local:

```ts
  const borderBoxWidth = r.contentWidth + r.insetLeft + r.insetRight;
```

That, not `contentWidth`, is what the float physically occupies: its border and
padding exclude space too. Every `r.borderBoxWidth` in this plan means that
local.

- [ ] **Step 5: Supply the `MeasureFn` for shrink-to-fit**

In `src/cssflow.ts`, at the `resolveBoxes(boxes, widthPx)` call (~line 465), pass
a third argument:

```ts
  const resolved = resolveBoxes(boxes, widthPx, (box) => {
    // Intrinsic widths for a float's shrink-to-fit. Inline content measures
    // directly; a block container takes the max over its children, which is
    // what CSS's shrink-to-fit does.
    if (box.content.kind === 'inline') {
      const runs = scaleRuns(box.content.runs);
      const e = textExtents(runs, runs[0]?.font ?? 'Helvetica', runs[0]?.fontSize ?? 12);
      return { min: e.longestWord / PT_PER_PX, max: e.longestLine / PT_PER_PX };
    }
    let min = 0;
    let max = 0;
    for (const kid of box.content.children ?? []) {
      const k = measureBox(kid);
      min = Math.max(min, k.min);
      max = Math.max(max, k.max);
    }
    return { min, max };
  });
```

Extract that arrow into a named `measureBox` so the recursive call resolves.
**Units:** `textExtents` returns POINTS and `resolveBoxes` works in CSS px, so
divide by `PT_PER_PX` — the module already defines it. Getting this backwards
makes every float 33% too wide, which reads as a style choice.

`BlockBox.content` is the union
`{ kind: 'blocks'; children: BoxNode[] } | { kind: 'inline'; runs; atomics }`
(verified, `cssbox.ts:52-54`), so the block arm is
`box.content.kind === 'blocks' ? box.content.children : []` — there is no
optional `children` to `??` against. A table box is a different `BoxNode` kind
with neither arm, so return `{ min: 0, max: 0 }` for it rather than reaching
into a field it does not have.

- [ ] **Step 6: Report same-side stacking**

In the same `mapBox` wrapper, track the previous float on each side through
`Ctx` and report a pair that would have fitted side by side:

```ts
  // CSS puts two same-side floats side by side when there is room; Flow stacks
  // them (floatstack.ts's ActiveFloat.band is one width from the column edge
  // and insetsAt takes the MAX per side, so side-by-side needs a SUM). Widths
  // are resolved at BUILD time, so the divergence is knowable here.
  const prev = c.lastFloat?.[side];
  if (prev !== undefined && prev + r.borderBoxWidth <= containingWidthPx) {
    c.skipped.push({
      el: r.box.el, kind: 'degraded', construct: 'float', detail: side,
    });
  }
  (c.lastFloat ??= {})[side] = r.borderBoxWidth;
```

`containingWidthPx` is the width `resolveBoxes` was given; thread it onto `Ctx`
rather than recomputing it.

- [ ] **Step 7: Run the tests and the fences**

Run: `npx vitest run test/css-float.test.ts test/cssflow.test.ts test/cssflow-report.test.ts test/html-render.test.ts test/htmlflow.test.ts test/html-identity.test.ts`
Expected: PASS. `test/cssflow-report.test.ts` almost certainly asserts the OLD
float report — update those cases to the new behaviour rather than working
around them.

- [ ] **Step 8: Typecheck and commit**

```bash
npm run typecheck
git add src/cssflow.ts src/htmlflow.ts test/css-float.test.ts test/cssflow-report.test.ts
git commit -m "feat(zch2.10): CSS floats place through all three entry points"
```

---

### Task 6: The shrink-to-fit width oracle

**Files:**
- Modify: `scripts/gen-box-goldens.ts` (float fixtures)
- Modify: `test/fixtures/css-box/PROVENANCE.md`
- Regenerate: `test/fixtures/css-box/*`

**Interfaces:**
- Consumes: Task 5's shrink-to-fit.
- Produces: no code. Browser-checked evidence for the width arithmetic.

- [ ] **Step 1: Read the generator and its fixture shape**

Run: `sed -n '1,80p' scripts/gen-box-goldens.ts` and
`sed -n '1,40p' test/fixtures/css-box/PROVENANCE.md`.
The generator records `getComputedStyle(el).width`, which IS the used content
width — and a float's shrink-to-fit width is exactly that, which is why this
costs almost nothing.

- [ ] **Step 2: Add float fixtures**

Add documents in the generator's existing fixture list covering: a float with a
stated `width`; an auto-width float whose content is one short word
(shrink-to-fit lands at min-content); an auto-width float whose content is a long
sentence (lands at the available width, clamped); and a float with margins.

- [ ] **Step 3: Regenerate and inspect the diff**

```bash
npx tsx scripts/gen-box-goldens.ts
git diff --stat test/fixtures/css-box/
```

Expected: only additions. A CHANGED existing golden means the `MeasureFn` wiring
altered a non-float box's width, which it must not — investigate before
continuing.

- [ ] **Step 4: Run the corpus**

Run: `npx vitest run test/cssbox-suite.test.ts test/cssresolve.test.ts`
Expected: PASS, with the new float comparisons included.

- [ ] **Step 5: Update PROVENANCE.md**

Its ceiling section currently says floats are outside the corpus. Rewrite that
to say float WIDTHS are now covered and float PLACEMENT is not — where text sits
beside a float is not observable through `getComputedStyle`, and stays held by
hand-built cases plus mutation. Leaving the old sentence would tell a reader the
corpus covers floats when it covers half of them.

- [ ] **Step 6: Commit**

```bash
git add scripts/gen-box-goldens.ts test/fixtures/css-box/
git commit -m "test(zch2.10): browser-checked goldens for a float's shrink-to-fit width"
```

---

### Task 7: Mutation sweep, docs, rename and close

**Files:**
- Modify: `CHANGELOG.md`, `README.md`, `CLAUDE.md`
- Verify: whole suite

- [ ] **Step 1: Full verification**

```bash
npm run typecheck
npm test
```
Expected: green. Record the file and test counts.

- [ ] **Step 2: Mutation-check every new rule**

Apply, run the named tests, record the count, REVERT. Anything reddening nothing
is RECORDED in CLAUDE.md, not deleted.

| # | Mutation | Expect red in |
|---|---|---|
| 1 | `floatOf` ignores the element marker (returns undefined for it) | `flow-float-content`, `css-float` |
| 2 | `degradeOnOverflow` ignored — always throw | the degradable case |
| 3 | `degradeOnOverflow` ignored — never throw | the FloatingBox-throws case |
| 4 | `elementFloat.measure` returns a constant | `flowfloat`'s measure==paint case |
| 5 | `placeElements` skips `insetsAt` narrowing | `flowplace-floats` |
| 6 | `placeElements` skips the float paint | `flowplace-floats` |
| 7 | `measureElements` drops the inter-element gaps | its agreement case |
| 8 | `MeasureFn` not passed to `resolveBoxes` | the shrink-to-fit case, and the box corpus |
| 9 | `textExtents` measures the whole string rather than lines | `textextents` |
| 10 | The same-side report is dropped | its case |
| 11 | The float wrapper marks only the first element instead of wrapping | `css-float` (content drawn twice) |

- [ ] **Step 3: CHANGELOG entry**

Add under `## [Unreleased]` → `### Added`. Draft, to be adjusted only where the
mutation results from Step 2 contradict it:

```markdown
- **CSS floats place, and text wraps beside them.** `float: left` and `float: right` render through all three `AddHtml` entry points instead of being laid out in flow and reported: the box is painted at the column edge, following content narrows around it, and `clear` drops past it. **Shrink-to-fit is live at last** — `resolveBoxes` has taken a `MeasureFn` since `zch2.3` and *no caller ever passed one*, so an auto-width float came out full width, excluded the whole channel, and was indistinguishable from ordinary flow; it now measures min-content and max-content through the same code a table column's auto-fit uses, extracted to a shared leaf rather than copied. `float` leaves the `skipped` report, as `table` did in `zch2.6`. **The engine change is one type, not new machinery.** The issue was filed expecting the latter, but `Render`'s float branch only ever touched four members of `FloatingBox` — `width`, `spacing`, `measure()`, `paintAt()` — so a CSS float joins the existing branch through a structural `FloatContent` that `FloatingBox` satisfies unedited, and there is no second copy of the top resolution, the deferral or the band bookkeeping. A float rides as an optional marker on an ordinary `FlowElement`, which makes **degrading free**: a float the engine declines to place is just an element with a marker it ignores, so it places in flow with its frame and content intact and no fallback rendering path exists to go wrong. `placeElements` gained the same band bookkeeping so `page.AddHtml` is not the odd one out. **Three limits, each deliberate.** A float that does not fit leads the next column WHOLE rather than splitting — correct for every float shorter than a column, and splitting is its own follow-up. Two same-side floats STACK rather than sitting side by side, and the pair is reported: `ActiveFloat.band` is one width from the column edge and `insetsAt` takes the maximum per side, so side-by-side needs a sum — a change to the band model that `AddFloatBox` shares. And a float taller than a whole column lays out in flow silently, because that is a placement-time fact and `AddHtml` hands `skipped` back before anything is placed. (`zch2.10`)
```

- [ ] **Step 4: README**

Update the HTML limitation bullet, which currently says float placement does not
render. Say what does work (placement, wrapping, `clear`, shrink-to-fit) and name
the three limits.

- [ ] **Step 5: CLAUDE.md**

Record the measured mutation results on the `flowfloat.ts` entry, and add the
`FloatContent`/marker invariants to the `flowelement.ts` entry and the band
bookkeeping to the `flowplace.ts` half of its entry.

- [ ] **Step 6: Rename the issue and file the follow-up**

```bash
bd update aspose-pdf-foss-for-ts-zch2.10 --title "CSS float placement"
bd create "A CSS float should be able to split across a column" -t feature -p 3 \
  --parent aspose-pdf-foss-for-ts-zch2 -d "<what zch2.10 deferred and why>"
```

The rename is the spec's decision: zch2.10 does NOT split, and closing it against
a title that says it does would misreport what shipped.

- [ ] **Step 7: Final verification, commit, close and push**

```bash
npm run typecheck && npm test
git add CHANGELOG.md README.md CLAUDE.md
git commit -m "docs(zch2.10): changelog, README limits and measured coverage notes"
bd close aspose-pdf-foss-for-ts-zch2.10 --reason "<what shipped, mutation results, anything uncovered>"
git add .beads/ && git commit -m "chore(beads): close zch2.10"
git pull --rebase && git push
git status -sb
```
Expected: `## main...origin/main` with nothing ahead.

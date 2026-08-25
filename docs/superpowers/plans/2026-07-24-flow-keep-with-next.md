# Flow heading keep-with-next Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A flow heading that fully fits at a column bottom but leaves no room for the following element's first line pushes to the next column, instead of dangling alone.

**Architecture:** Non-destructive lookahead in `Flow.Render`. A new measure-only twin of `flowTextBlock` (`measureTextBlock`) lets flow elements predict their laid-out height without drawing; the engine measures a heading and its successor before drawing the heading and, when the successor cannot place even one line beneath it, advances the column first. Controlled by a flow-level default (`FlowOptions.keepHeadingsWithNext`, default `true`) with a per-heading override (`FlowHeadingOptions.keepWithNext`).

**Tech Stack:** TypeScript (ESM + NodeNext, `strict`; `.js` import specifiers), vitest. Zero runtime deps (`node:` built-ins only).

## Global Constraints

- Zero runtime dependencies — only `node:` built-ins. Do not add npm runtime deps.
- ESM + NodeNext: every relative import specifier carries the `.js` extension.
- TDD: write the failing test first, watch it fail, then implement. Assertions must be load-bearing (breaking the code path turns the suite red).
- Run `npm run typecheck` and `npm test` green before considering the issue done.
- Errors use the public error types where applicable; option-validation failures throw `TypeError` (matches existing flow validation).
- Files touched: `src/stamp.ts`, `src/flow.ts`, `test/flow.test.ts`, `test/stamp.test.ts` (or the nearest existing stamp test file — see Task 1), `README.md`.

---

### Task 1: `measureTextBlock` — non-destructive layout measure (`stamp.ts`)

A read-only twin of `flowTextBlock` that runs the identical `layoutText` path but never appends content. The keep-with-next lookahead needs the laid-out height of a text block without mutating the page.

**Files:**
- Modify: `src/stamp.ts` (add `measureTextBlock` next to `flowTextBlock`, around line 409–446; export it)
- Test: `test/stamp.test.ts` (add a `describe('measureTextBlock', …)` block; if no `test/stamp.test.ts` exists, discover the file that tests `flowTextBlock` with `grep -rl flowTextBlock test/` and add there)

**Interfaces:**
- Consumes: existing `stamp.ts` internals `normalizeBlockOptions`, `effectiveShape`, `shapeOptsFrom`, `shapedDriver`, `driverFor`, and `layoutText` (from `./layout.js`), all already in scope in `stamp.ts`.
- Produces: `export function measureTextBlock(text: string, width: number, availHeight: number, options?: TextBlockOptions): { usedHeight: number; remainder: string | null }`.

- [ ] **Step 1: Write the failing test**

Add to the stamp test file. It proves the measure agrees with a real `flowTextBlock` draw for both a fits-fully and an overflow case, and that measuring draws nothing.

```ts
import { describe, it, expect } from 'vitest';
import { Document } from '../src/index.js';
import { flowTextBlock, measureTextBlock } from '../src/stamp.js';
import { buildBlankPage } from './helpers/build-blank-page.js';

describe('measureTextBlock', () => {
  const text = Array.from({ length: 12 }, (_, i) => `word${i}`).join(' ');
  const opts = { font: 'Helvetica' as const, fontSize: 12, leading: 16 };

  it('agrees with flowTextBlock usedHeight and remainder (fits fully)', () => {
    const doc = Document.Open(buildBlankPage());
    const page = doc.Pages[0];
    const [x, y, w, h] = [50, 50, 400, 400];
    const drawn = flowTextBlock(doc, page, text, [x, y, w, h], opts);
    const measured = measureTextBlock(text, w, h, opts);
    expect(measured.usedHeight).toBeCloseTo(drawn.usedHeight, 9);
    expect(measured.remainder).toBe(drawn.remainder);
  });

  it('agrees with flowTextBlock when the box clips to a few lines (overflow)', () => {
    const doc = Document.Open(buildBlankPage());
    const page = doc.Pages[0];
    const [x, y, w, h] = [50, 50, 120, 34]; // ~2 lines at leading 16
    const drawn = flowTextBlock(doc, page, text, [x, y, w, h], opts);
    const measured = measureTextBlock(text, w, h, opts);
    expect(measured.usedHeight).toBeCloseTo(drawn.usedHeight, 9);
    expect(measured.remainder).toBe(drawn.remainder);
  });

  it('draws nothing (page content unchanged)', () => {
    const doc = Document.Open(buildBlankPage());
    const page = doc.Pages[0];
    const before = new TextDecoder('latin1').decode(page.Contents);
    measureTextBlock(text, 120, 400, opts);
    const after = new TextDecoder('latin1').decode(page.Contents);
    expect(after).toBe(before);
  });

  it('returns zero height / null remainder for empty text', () => {
    expect(measureTextBlock('', 200, 200, opts)).toEqual({ usedHeight: 0, remainder: null });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/stamp.test.ts -t measureTextBlock`
Expected: FAIL — `measureTextBlock` is not exported / not a function.

- [ ] **Step 3: Write minimal implementation**

Insert into `src/stamp.ts` immediately after `flowTextBlock` (after line 446). It mirrors `flowTextBlock`'s driver selection and `layoutText` call, minus every drawing side effect (`registerFont`, `buildBlockBody`, `appendContent`, MCID/tagging):

```ts
/** Non-destructive twin of {@link flowTextBlock}: run the identical layout for
 *  `text` in a `width` x `availHeight` box and report `usedHeight`
 *  (`linesDrawn * leading`, 0 when nothing fits) and the unconsumed `remainder`
 *  (`null` when everything fit or nothing was drawable), WITHOUT drawing. Because
 *  it calls the same `layoutText` with the same options, its result equals what a
 *  subsequent `flowTextBlock` draw of the same text/box would produce. */
export function measureTextBlock(
  text: string, width: number, availHeight: number, options: TextBlockOptions = {},
): { usedHeight: number; remainder: string | null } {
  const o = normalizeBlockOptions(options);
  const driver = effectiveShape(o.font, options.shape)
    ? shapedDriver(o.font, shapeOptsFrom(options))
    : driverFor(o.font);
  if (driver.probe(text) === 0) return { usedHeight: 0, remainder: null };
  const { lines, remainder } = layoutText(text, driver, o.fontSize, width, availHeight, o.leading);
  return { usedHeight: lines.length * o.leading, remainder: remainder === '' ? null : remainder };
}
```

Note: on the shaped path `flowTextBlock` narrows `o.font` to `EmbeddedFont` via the `effectiveShape` type guard before calling `shapedDriver`. Here the guard is inlined in the ternary; if `tsc` cannot narrow inside the ternary, hoist it:

```ts
  let driver;
  if (effectiveShape(o.font, options.shape)) driver = shapedDriver(o.font, shapeOptsFrom(options));
  else driver = driverFor(o.font);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/stamp.test.ts -t measureTextBlock`
Expected: PASS (4 tests).

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/stamp.ts test/stamp.test.ts
git commit -m "feat(stamp): measureTextBlock — non-destructive layout measure (db7v.6)"
```

---

### Task 2: `measure()` on flow text elements (`flow.ts`)

Give `TextElement` and `ListItemElement` a non-destructive `measure` that predicts `place`'s outcome, so the engine can dry-run a heading and its successor.

**Files:**
- Modify: `src/flow.ts` — extend the `FlowElement` interface (lines 120–126); add `measure` to `TextElement` (class at 163–200) and `ListItemElement` (class at 302–372)
- Test: `test/flow.test.ts` (new `describe('flow element measure', …)`)

**Interfaces:**
- Consumes: `measureTextBlock` from Task 1 (`import { … measureTextBlock } from './stamp.js'`); existing `makeParagraph`/`makeList` exported factories.
- Produces on `FlowElement`:
  - `measure?(ctx: MeasureContext): { usedHeight: number; fits: boolean }`
  - `export interface MeasureContext { width: number; availHeight: number }`

- [ ] **Step 1: Write the failing test**

`makeParagraph` and `makeList` return `FlowElement`s; call `.measure` directly. Assert a paragraph that fits reports `fits: true` with the expected line-count height, and one clipped to a short box reports `fits: false`; a list item measures against its indented body width.

```ts
import { makeParagraph, makeList } from '../src/flow.js';

describe('flow element measure', () => {
  it('paragraph measure predicts full fit and used height', () => {
    const p = makeParagraph('word0 word1 word2', { font: 'Helvetica', fontSize: 12, leading: 16 });
    const m = p.measure!({ width: 400, availHeight: 400 });
    expect(m.fits).toBe(true);
    expect(m.usedHeight).toBeCloseTo(16, 6); // one line
  });

  it('paragraph measure reports no full fit when the box clips it', () => {
    const long = Array.from({ length: 30 }, (_, i) => `w${i}`).join(' ');
    const p = makeParagraph(long, { font: 'Helvetica', fontSize: 12, leading: 16 });
    const m = p.measure!({ width: 80, availHeight: 16 }); // room for one line only
    expect(m.fits).toBe(false);
    expect(m.usedHeight).toBeCloseTo(16, 6);
  });

  it('list item measure honors the indent (narrower body wraps sooner)', () => {
    const [item] = makeList(['alpha beta gamma delta epsilon'], { fontSize: 12, leading: 16, indent: 60 });
    const wide = item.measure!({ width: 300, availHeight: 400 });
    const narrow = item.measure!({ width: 120, availHeight: 400 });
    expect(narrow.usedHeight).toBeGreaterThan(wide.usedHeight); // indent eats width → more lines
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/flow.test.ts -t "flow element measure"`
Expected: FAIL — `p.measure` is `undefined` (not a function).

- [ ] **Step 3: Implement — interface + import**

In `src/flow.ts`, add `measureTextBlock` to the existing `./stamp.js` import (lines 5–8):

```ts
import {
  flowTextBlock, stampText, measureText, measureTextBlock,
  type TextBlockOptions, type StampOptions, type AuthoringFont,
} from './stamp.js';
```

Add the `MeasureContext` interface just above `PlaceContext` (before line 95):

```ts
/** Inputs for a non-destructive {@link FlowElement.measure}. @internal */
export interface MeasureContext {
  width: number;
  availHeight: number;
}
```

Extend `FlowElement` (lines 120–126) with the optional `measure`:

```ts
export interface FlowElement {
  place(ctx: PlaceContext): PlaceResult;
  /** Non-destructive dry-run of {@link place}: predict the vertical space the
   *  element would consume and whether it fully fits, without drawing. */
  measure?(ctx: MeasureContext): { usedHeight: number; fits: boolean };
  /** Points to reserve above this element; treated as 0 when absent. */
  readonly spaceBefore?: number;
  /** Points to reserve below this element; treated as 0 when absent. */
  readonly spaceAfter?: number;
}
```

- [ ] **Step 4: Implement — `TextElement.measure`**

Add this method to `TextElement` (after `place`, before the closing brace at line 200):

```ts
  measure(ctx: MeasureContext): { usedHeight: number; fits: boolean } {
    if (ctx.availHeight <= 0) return { usedHeight: 0, fits: false };
    const { usedHeight, remainder } = measureTextBlock(this.text, ctx.width, ctx.availHeight, this.opts);
    return { usedHeight, fits: remainder === null && usedHeight > 0 };
  }
```

- [ ] **Step 5: Implement — `ListItemElement.measure`**

Add to `ListItemElement` (after `place`, before the closing brace at line 372). It mirrors `place`'s body rect: body width is `width - indent`.

```ts
  measure(ctx: MeasureContext): { usedHeight: number; fits: boolean } {
    if (ctx.availHeight <= 0) return { usedHeight: 0, fits: false };
    const bodyOpts: TextBlockOptions = {
      font: this.opts.font, fontSize: this.opts.fontSize, color: this.opts.color,
      align: this.opts.align, leading: this.opts.leading,
    };
    const { usedHeight, remainder } =
      measureTextBlock(this.text, ctx.width - this.opts.indent, ctx.availHeight, bodyOpts);
    return { usedHeight, fits: remainder === null && usedHeight > 0 };
  }
```

- [ ] **Step 6: Run test to verify it passes**

Run: `npx vitest run test/flow.test.ts -t "flow element measure"`
Expected: PASS (3 tests).

- [ ] **Step 7: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 8: Commit**

```bash
git add src/flow.ts test/flow.test.ts
git commit -m "feat(flow): non-destructive measure() on text/list elements (db7v.6)"
```

---

### Task 3: Keep-with-next engine, options & validation (`flow.ts`)

Wire the heading eligibility + policy options and the `Flow.Render` lookahead that pushes a dangling heading to the next column. This is the payload task; it also carries the README update.

**Files:**
- Modify: `src/flow.ts` — `FlowOptions` (lines 14–35), `FlowHeadingOptions` (lines 142–144), `TextElement` (163–200), `makeParagraph` (202–206), `Flow` fields/ctor (409–420), `AddParagraph` (422–427), `AddHeading` (429–446), `Render` (473–596)
- Modify: `README.md` — Flow prose (lines 434–441)
- Test: `test/flow.test.ts` (new `describe('flow heading keep-with-next', …)`)

**Interfaces:**
- Consumes: `MeasureContext` and `measure` from Task 2; existing `isBreak`/`isFloat` guards (lines 399–404); `advanceColumn`/`atColumnStart`/`pendingSpaceAfter`/`colTop` locals in `Render`.
- Produces:
  - `FlowOptions.keepHeadingsWithNext?: boolean` (default `true`)
  - `FlowHeadingOptions` becomes `interface … extends FlowParagraphOptions { keepWithNext?: boolean }`
  - `FlowElement.keepWithNextEligible?: boolean`, `FlowElement.keepWithNext?: boolean`
  - `TextElement` constructor gains trailing params `keepWithNextEligible: boolean`, `keepWithNext: boolean | undefined`.

- [ ] **Step 1: Write the failing tests**

Add a new describe to `test/flow.test.ts`. The fixture geometry is chosen so every text line is exactly 20pt tall and the column holds exactly 8 lines (`format 200x200`, margins 20 → `contentTop=180`, `contentBottom=20`, column height 160). A 7-line filler leaves one 20pt slot (fits the heading alone, not heading+line → push); a 6-line filler leaves two slots (heading+line fit → no push).

```ts
describe('flow heading keep-with-next', () => {
  // 200x200, 20pt margins → column height 160 = 8 lines at leading 20.
  const opts = (extra = {}) => ({
    format: PageFormat.custom(200, 200), columns: 1,
    marginLeft: 20, marginRight: 20, marginTop: 20, marginBottom: 20, ...extra,
  });
  const L = { font: 'Helvetica' as const, fontSize: 12, leading: 20 };
  const filler = (n: number) => Array.from({ length: n }, (_, i) => `F${i}`).join('\n');
  const page1Has = (pages: any[], s: string) => pages[0].GetText().includes(s);

  it('pushes a heading whose next line will not fit to the next column', () => {
    const doc = Document.Open(buildBlankPage());
    const flow = new Flow(doc, opts());
    flow.AddParagraph(filler(7), L);        // fills 7 of 8 slots; one 20pt slot left
    flow.AddHeading(2, 'HEADING', L);       // fits the last slot alone…
    flow.AddParagraph('body', L);           // …but heading+body do not → push both
    const pages = flow.Render();
    expect(pages.length).toBe(2);
    expect(page1Has(pages, 'HEADING')).toBe(false);   // heading pushed off page 1
    expect(pages[1].GetText()).toContain('HEADING');
    expect(pages[1].GetText()).toContain('body');
  });

  it('does not push when the next line fits beneath the heading', () => {
    const doc = Document.Open(buildBlankPage());
    const flow = new Flow(doc, opts());
    flow.AddParagraph(filler(6), L);        // two slots left: heading + body both fit
    flow.AddHeading(2, 'HEADING', L);
    flow.AddParagraph('body', L);
    const pages = flow.Render();
    expect(pages.length).toBe(1);
    expect(page1Has(pages, 'HEADING')).toBe(true);
    expect(pages[0].GetText()).toContain('body');
  });

  it('per-heading keepWithNext:false disables the push', () => {
    const doc = Document.Open(buildBlankPage());
    const flow = new Flow(doc, opts());
    flow.AddParagraph(filler(7), L);
    flow.AddHeading(2, 'HEADING', { ...L, keepWithNext: false });
    flow.AddParagraph('body', L);
    const pages = flow.Render();
    expect(page1Has(pages, 'HEADING')).toBe(true); // stays at the column bottom
  });

  it('flow-level keepHeadingsWithNext:false disables it, per-heading true re-enables', () => {
    const off = Document.Open(buildBlankPage());
    const flowOff = new Flow(off, opts({ keepHeadingsWithNext: false }));
    flowOff.AddParagraph(filler(7), L);
    flowOff.AddHeading(2, 'HEADING', L);
    flowOff.AddParagraph('body', L);
    expect(flowOff.Render()[0].GetText()).toContain('HEADING'); // not pushed

    const on = Document.Open(buildBlankPage());
    const flowOn = new Flow(on, opts({ keepHeadingsWithNext: false }));
    flowOn.AddParagraph(filler(7), L);
    flowOn.AddHeading(2, 'HEADING', { ...L, keepWithNext: true }); // override wins
    flowOn.AddParagraph('body', L);
    const pages = flowOn.Render();
    expect(pages[0].GetText().includes('HEADING')).toBe(false);   // pushed
  });

  it('pushes when the following element is a list whose first line will not fit', () => {
    const doc = Document.Open(buildBlankPage());
    const flow = new Flow(doc, opts());
    flow.AddParagraph(filler(7), L);
    flow.AddHeading(2, 'HEADING', L);
    flow.AddList(['listitem'], { fontSize: 12, leading: 20 });
    const pages = flow.Render();
    expect(pages[0].GetText().includes('HEADING')).toBe(false);   // pushed with the list
  });

  it('no-op: a trailing heading (nothing follows) draws in place', () => {
    const doc = Document.Open(buildBlankPage());
    const flow = new Flow(doc, opts());
    flow.AddParagraph(filler(7), L);
    flow.AddHeading(2, 'HEADING', L);
    const pages = flow.Render();
    expect(pages.length).toBe(1);
    expect(pages[0].GetText()).toContain('HEADING');
  });

  it('no-op: a column-break after the heading does not trigger a push', () => {
    const doc = Document.Open(buildBlankPage());
    const flow = new Flow(doc, opts());
    flow.AddParagraph(filler(7), L);
    flow.AddHeading(2, 'HEADING', L);
    flow.AddColumnBreak();
    flow.AddParagraph('body', L);
    const pages = flow.Render();
    expect(pages[0].GetText()).toContain('HEADING'); // heading stayed; break moved body
  });

  it('no-op: a float after the heading does not trigger a push', () => {
    const doc = Document.Open(buildBlankPage());
    const flow = doc.NewFlow(opts());
    flow.AddParagraph(filler(7), L);
    flow.AddHeading(2, 'HEADING', L);
    const box = doc.NewFloatingBox({ width: 80 });
    box.AddParagraph('BX', { fontSize: 10, leading: 12 });
    flow.AddFloatBox(box, 'left');
    const pages = flow.Render();
    expect(pages[0].GetText()).toContain('HEADING'); // heading not pushed by a float
  });

  it('accepts the orphan without looping when even a full column cannot hold heading+line', () => {
    // Column height 40 = 2 lines; heading (20) + body line (20) = 40 fits a FULL column,
    // so make the body two lines tall so heading+body never co-fit any column.
    const doc = Document.Open(buildBlankPage());
    const flow = new Flow(doc, {
      format: PageFormat.custom(200, 80), columns: 1,
      marginLeft: 20, marginRight: 20, marginTop: 20, marginBottom: 20, // height 40 = 2 lines
    });
    flow.AddHeading(2, 'HEADING', L);                 // heading at a fresh column start
    flow.AddParagraph('one\ntwo\nthree', L);          // 3 lines: never co-fits
    const pages = flow.Render();                      // must terminate, not loop/throw
    expect(pages[0].GetText()).toContain('HEADING');  // drawn at column start (orphan accepted)
  });

  it('folds spaceAfter/spaceBefore into the one-line check', () => {
    // 6-line filler leaves two 20pt slots. Without spacing, heading+body fit (no push).
    // A 5pt spaceAfter on the heading pushes body's baseline past the last slot → push.
    const push = Document.Open(buildBlankPage());
    const flow = new Flow(push, opts());
    flow.AddParagraph(filler(6), L);                  // two slots: without spacing, no push
    flow.AddHeading(2, 'HEADING', { ...L, spaceAfter: 5 });
    flow.AddParagraph('body', L);
    expect(flow.Render()[0].GetText().includes('HEADING')).toBe(false); // pushed
  });

  it('validates the policy options', () => {
    const doc = Document.Open(buildBlankPage());
    expect(() => new Flow(doc, opts({ keepHeadingsWithNext: 'yes' as any }))).toThrow(TypeError);
    const flow = new Flow(Document.Open(buildBlankPage()), opts());
    expect(() => flow.AddHeading(2, 'x', { keepWithNext: 1 as any })).toThrow(TypeError);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/flow.test.ts -t "keep-with-next"`
Expected: FAIL — pushes do not happen (headings stay on page 1) and the option validations do not throw.

- [ ] **Step 3: Implement — options & fields**

In `src/flow.ts`:

Add to `FlowOptions` (after the `tagged` field, line 34, inside the interface):

```ts
  /** Push a heading to the next column when the following element cannot place at
   *  least one line beneath it in the current column. Default true. Overridable
   *  per heading via {@link FlowHeadingOptions.keepWithNext}. */
  keepHeadingsWithNext?: boolean;
```

Replace the `FlowHeadingOptions` type alias (lines 142–144) with an interface that adds the override:

```ts
/** Options for {@link Flow.AddHeading}. Extends {@link FlowParagraphOptions}; the
 *  heading `level` (1..6) is the positional argument, not an option. */
export interface FlowHeadingOptions extends FlowParagraphOptions {
  /** Override the flow's {@link FlowOptions.keepHeadingsWithNext} policy for this
   *  heading. `undefined` inherits the flow default (true). */
  keepWithNext?: boolean;
}
```

Extend the `FlowElement` interface (edited in Task 2) with the two eligibility markers — add after the `measure` line:

```ts
  /** True only for headings — the elements eligible for keep-with-next. */
  readonly keepWithNextEligible?: boolean;
  /** Per-element override of the flow keep-with-next policy; `undefined` inherits
   *  the flow default. Meaningful only when {@link keepWithNextEligible}. */
  readonly keepWithNext?: boolean;
```

- [ ] **Step 4: Implement — `TextElement` constructor params**

Add the two trailing constructor params to `TextElement` (lines 164–171). They are `public readonly` so they satisfy the `FlowElement` markers directly:

```ts
  constructor(
    private readonly text: string,
    private readonly opts: TextBlockOptions,
    private readonly structType: string,
    readonly spaceBefore: number,
    readonly spaceAfter: number,
    private tag?: StructElement,
    readonly keepWithNextEligible: boolean = false,
    readonly keepWithNext?: boolean,
  ) {}
```

In `TextElement.place`, the continuation `TextElement` it constructs on overflow (line 196) must stay non-eligible (it already started). It currently passes 6 args ending with `this.tag`; leave it unchanged — the two new params default to `false`/`undefined`, exactly the desired "continuation is not eligible".

- [ ] **Step 5: Implement — factory & Add methods**

`makeParagraph` (lines 202–206) is unchanged (defaults give `keepWithNextEligible = false`).

`AddParagraph` (lines 422–427) is unchanged for the same reason.

In `AddHeading` (lines 429–446), validate the override and pass eligibility. Replace the body after the level guard:

```ts
  AddHeading(level: number, text: string, options: FlowHeadingOptions = {}): this {
    if (!Number.isInteger(level) || level < 1 || level > 6)
      throw new TypeError('heading level must be an integer in 1..6');
    if (options.keepWithNext !== undefined && typeof options.keepWithNext !== 'boolean')
      throw new TypeError('keepWithNext must be a boolean');
    const withDefaults: FlowParagraphOptions = {
      ...options,
      font: options.font ?? 'Helvetica-Bold',
      fontSize: options.fontSize ?? HEADING_SIZES[level - 1],
    };
    const { spaceBefore, spaceAfter } = normalizeSpacing(options);
    this.items.push(
      new TextElement(
        text, paragraphOptions(withDefaults), 'H' + String(level),
        spaceBefore, spaceAfter, undefined, true, options.keepWithNext),
    );
    return this;
  }
```

- [ ] **Step 6: Implement — Flow field, ctor validation**

Add a `keepHeadingsWithNext` field to `Flow` (near line 413) and validate/store it in the constructor (after the `tagged` validation, line 419):

```ts
  private readonly keepHeadingsWithNext: boolean;
```

```ts
    if (options?.keepHeadingsWithNext !== undefined && typeof options.keepHeadingsWithNext !== 'boolean')
      throw new TypeError('keepHeadingsWithNext must be a boolean');
    this.keepHeadingsWithNext = options?.keepHeadingsWithNext ?? true;
```

- [ ] **Step 7: Implement — the lookahead in `Render`**

In `Render`, the text-element branch computes `gap`, `top`, `besideFloat`, `elemX`, `elemWidth`, `availHeight` (lines 541–556), then calls `item.place` (line 559). Insert the keep-with-next check between the region computation and the `ensurePage`/`place` (i.e. after line 556, before line 558):

```ts
      // Keep-with-next: an eligible heading that fully fits here but leaves no room
      // for the next element's first line pushes to the next column. Never at a
      // column start (that would loop) and never beside a float (out of scope).
      const keep = item.keepWithNextEligible
        && (item.keepWithNext ?? this.keepHeadingsWithNext);
      if (keep && !atColumnStart && !besideFloat && item.measure) {
        const self = item.measure({ width: elemWidth, availHeight });
        if (self.fits) {
          const next = queue.length > 1 && !isBreak(queue[1]) && !isFloat(queue[1])
            ? (queue[1] as FlowElement) : undefined;
          if (next?.measure) {
            const gapNext = (item.spaceAfter ?? 0) + g.paragraphSpacing + (next.spaceBefore ?? 0);
            const remaining = (top - self.usedHeight) - gapNext - g.contentBottom;
            if (next.measure({ width: g.columnWidth, availHeight: remaining }).usedHeight <= 0) {
              advanceColumn();
              continue;
            }
          }
        }
      }
```

Note on `continue`: nothing was drawn and `queue` is untouched, so after `advanceColumn` the same heading is retried at a fresh column top where `atColumnStart` is true, so the `keep && !atColumnStart` guard is false and it draws unconditionally — no loop.

- [ ] **Step 8: Run the keep-with-next tests**

Run: `npx vitest run test/flow.test.ts -t "keep-with-next"`
Expected: PASS (all cases in the describe).

- [ ] **Step 9: Prove the assertions are load-bearing**

Temporarily change the push condition `.usedHeight <= 0` to `.usedHeight < 0` (never true → never pushes) and rerun the keep-with-next tests.
Run: `npx vitest run test/flow.test.ts -t "keep-with-next"`
Expected: the "pushes …", "flow-level … re-enables", list, and spacing tests FAIL. Then revert the change and confirm green again.

- [ ] **Step 10: Full suite + typecheck**

Run: `npm run typecheck && npm test`
Expected: typecheck clean; entire vitest suite green (existing flow/stamp/struct tests unaffected — untagged, non-dangling flows paginate exactly as before).

- [ ] **Step 11: Update the README**

In `README.md`, in the Flow prose after the `spaceBefore`/`spaceAfter` sentence (ends line 439 "dropped at a column top)."), add:

```markdown
By default a heading is kept with the element after it: if the heading fits at a
column bottom but the next element cannot place even one line beneath it, the
heading moves to the next column. Set `keepHeadingsWithNext: false` on `NewFlow`
to disable this flow-wide, or `keepWithNext: false` (or `true`) on an individual
`AddHeading` to override the flow default.
```

- [ ] **Step 12: Commit**

```bash
git add src/flow.ts test/flow.test.ts README.md
git commit -m "feat(flow): keep-with-next / orphan control for headings (db7v.6)"
```

---

## Self-Review

**Spec coverage:**
- `measureTextBlock` non-destructive twin → Task 1. ✓
- `FlowElement.measure` on `TextElement` + `ListItemElement` → Task 2. ✓
- Engine lookahead with exact `remaining` (folds `spaceAfter`+`paragraphSpacing`+next `spaceBefore`) → Task 3 Step 7 + spacing test. ✓
- Effective policy `item.keepWithNext ?? flowKeepDefault`, headings-only via `keepWithNextEligible` → Task 3 Steps 3–7. ✓
- `!atColumnStart` no-loop guard → Task 3 Step 7 + orphan test. ✓
- Non-triggers (last, column-break, float, `!fits`, beside-float) → Task 3 Step 7 + no-op tests. ✓
- API: `FlowOptions.keepHeadingsWithNext` (default true), `FlowHeadingOptions extends … { keepWithNext }`, validation → Task 3 Steps 3, 5, 6 + validation test. ✓
- Continuation constructed non-eligible → Task 3 Step 4. ✓
- Byte-output note (default true changes dangling-heading pagination; others unchanged) → Task 3 Step 10 regression check. ✓
- Docs (README) → Task 3 Step 11. ✓

**Placeholder scan:** none — every code/step is concrete.

**Type consistency:** `measureTextBlock(text, width, availHeight, options?)` returns `{ usedHeight, remainder }` (Task 1) and is consumed as such in Task 2. `MeasureContext { width, availHeight }` and `measure(ctx) → { usedHeight, fits }` are defined in Task 2 and consumed identically in Task 3. `keepWithNextEligible`/`keepWithNext` names match across the interface, `TextElement` ctor, `AddHeading`, and the `Render` check.

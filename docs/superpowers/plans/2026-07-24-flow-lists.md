# Flow Lists (bulleted / numbered) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `flow.AddList(items, options)` — bullet and numbered lists with configurable marker, auto/explicit body indent, per-item and per-list spacing, automatic pagination, and opt-in `/L`/`/LI`/`/Lbl`/`/LBody` PDF/UA tagging.

**Architecture:** A new internal `ListItemElement implements FlowElement` lives in `src/flow.ts` alongside the existing `TextElement`. `AddList` expands the string array into one `ListItemElement` per item, pushed onto the same `items` queue the `Flow.Render` loop already drains — so pagination, column breaks, and `spaceBefore`/`spaceAfter` gap handling come for free with no change to `Render`. Each item draws its word-wrapped body through the existing `flowTextBlock` and its marker through the existing single-line `stampText`; tagging reuses `StructElement.Append`.

**Tech Stack:** TypeScript (ESM + NodeNext, `.js` import specifiers), vitest. Zero runtime deps.

## Global Constraints

- Zero runtime dependencies — only `node:` built-ins. Do not add npm runtime deps.
- ESM + NodeNext, `strict` TypeScript; every import specifier carries the `.js` extension.
- Public errors are `TypeError` for bad arguments (matches the rest of `flow.ts`).
- Follow existing `flow.ts` patterns: `nonNegative(v, dflt, name)` for numeric validation; test-only element factories exported from `flow.ts` (e.g. `makeParagraph`) and imported directly by `test/flow.test.ts`.
- Default list font size is **11pt** (intentionally one point smaller than the paragraph/block 12pt default), Helvetica, bullet `"•"` (•), `markerGap = 0.5 × fontSize`.
- Run `npm run typecheck` and `npm test` — both green — before closing the issue.
- Keep `README.md` in sync (the Flow layout section).

---

### Task 1: List options, validation, and element builder

Add the `FlowListOptions` public type, an internal `NormalizedListOptions` + `normalizeListOptions` validator (which also computes the auto gutter width), and the shared `buildListElements` factory. No rendering yet — this task delivers the validated option surface and a test-only `makeList` factory that later tasks and tests consume.

**Files:**
- Modify: `src/flow.ts` (add imports, types, validator, builder, test-only factory)
- Test: `test/flow.test.ts` (new `describe('flow list options')` block)

**Interfaces:**
- Consumes: existing `nonNegative(v, dflt, name)`, `measureText(text, fontSize, font)` from `./stamp.js`, `FlowElement`.
- Produces:
  - `export interface FlowListOptions { ordered?: boolean; start?: number; bullet?: string; font?: AuthoringFont; fontSize?: number; color?: [number, number, number]; leading?: number; indent?: number; itemSpacing?: number; spaceBefore?: number; spaceAfter?: number; align?: 'left' | 'center' | 'right' | 'justify'; }`
  - `interface NormalizedListOptions { ordered: boolean; start: number; bullet: string; font: AuthoringFont; fontSize: number; color?: [number, number, number]; leading?: number; align?: 'left'|'center'|'right'|'justify'; indent: number; markerGap: number; itemSpacing: number; spaceBefore: number; spaceAfter: number; }` (internal, not exported)
  - `function normalizeListOptions(o: FlowListOptions, count: number): NormalizedListOptions` (internal)
  - `function markerFor(o: NormalizedListOptions, index: number): string` — `o.ordered ? `${o.start + index}.` : o.bullet` (internal, 0-based index)
  - `function buildListElements(items: string[], options: FlowListOptions): FlowElement[]` (internal)
  - `export function makeList(items: string[], options?: FlowListOptions): FlowElement[]` (test-only, delegates to `buildListElements`)

- [ ] **Step 1: Extend the stamp import in `src/flow.ts`**

Change the existing import at the top of `src/flow.ts` from:

```ts
import { flowTextBlock, type TextBlockOptions, type AuthoringFont } from './stamp.js';
```

to:

```ts
import {
  flowTextBlock, stampText, measureText,
  type TextBlockOptions, type StampOptions, type AuthoringFont,
} from './stamp.js';
```

- [ ] **Step 2: Write the failing test**

Add to `test/flow.test.ts` (place after the `describe('paragraph element placement', …)` block). Add `makeList` to the existing top-of-file import from `../src/flow.js`:

```ts
describe('flow list options', () => {
  it('validates its inputs', () => {
    expect(() => makeList(['a'], { start: 1.5 })).toThrow(TypeError);
    expect(() => makeList(['a'], { itemSpacing: -1 })).toThrow(TypeError);
    expect(() => makeList(['a'], { spaceBefore: NaN })).toThrow(TypeError);
    expect(() => makeList(['a'], { fontSize: 0 })).toThrow(TypeError);
    expect(() => makeList(['a'], { indent: -5 })).toThrow(TypeError);
    expect(() => makeList('nope' as any)).toThrow(TypeError);
    expect(() => makeList([1 as any])).toThrow(TypeError);
  });

  it('builds one element per item; empty array builds none', () => {
    expect(makeList(['a', 'b', 'c']).length).toBe(3);
    expect(makeList([]).length).toBe(0);
  });

  it('first item carries spaceBefore, last carries spaceAfter, middles carry itemSpacing', () => {
    const els = makeList(['a', 'b', 'c'],
      { spaceBefore: 10, spaceAfter: 20, itemSpacing: 5 });
    expect(els[0].spaceBefore).toBe(10);
    expect(els[0].spaceAfter).toBe(5);   // itemSpacing between item 0 and 1
    expect(els[1].spaceBefore).toBe(0);
    expect(els[1].spaceAfter).toBe(5);
    expect(els[2].spaceAfter).toBe(20);  // list-level spaceAfter on the last item
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run test/flow.test.ts -t "flow list options"`
Expected: FAIL — `makeList` is not exported / not defined.

- [ ] **Step 4: Add the types, validator, and builder to `src/flow.ts`**

Insert after the `makeParagraph` factory (around `src/flow.ts:202`, before the `ColumnBreak` sentinel):

```ts
/** Default bullet glyph (U+2022) for an unordered {@link Flow.AddList}. */
const DEFAULT_BULLET = '•';

/** Options for {@link Flow.AddList}. All lengths are in points. */
export interface FlowListOptions {
  /** `false` → bullet list; `true` → `1.`/`2.`/`3.` numbered list. Default false. */
  ordered?: boolean;
  /** First ordinal for an ordered list. Integer. Default 1. */
  start?: number;
  /** Marker glyph for an unordered list. Default "•" (U+2022). */
  bullet?: string;
  /** Body + marker font. Default Helvetica. */
  font?: AuthoringFont;
  /** Font size (points). Default 11. */
  fontSize?: number;
  color?: [number, number, number];
  leading?: number;
  /** Body-text indent from the list's left edge (points). Default: auto —
   *  widest measured marker width + a half-em gap. */
  indent?: number;
  /** Vertical gap between consecutive items. >= 0. Default 0. */
  itemSpacing?: number;
  /** Gap above the whole list (dropped at a column top). >= 0. Default 0. */
  spaceBefore?: number;
  /** Gap below the whole list (dropped at a column top). >= 0. Default 0. */
  spaceAfter?: number;
  /** Body alignment. Default 'left'. */
  align?: 'left' | 'center' | 'right' | 'justify';
}

/** Resolved, validated list options (shared by every item of one list). @internal */
interface NormalizedListOptions {
  ordered: boolean;
  start: number;
  bullet: string;
  font: AuthoringFont;
  fontSize: number;
  color?: [number, number, number];
  leading?: number;
  align?: 'left' | 'center' | 'right' | 'justify';
  /** Resolved gutter: body text starts this many points right of the list edge. */
  indent: number;
  /** Gap between the marker's right edge and the body's left edge. */
  markerGap: number;
  itemSpacing: number;
  spaceBefore: number;
  spaceAfter: number;
}

/** The marker string for item `index` (0-based). @internal */
function markerFor(o: NormalizedListOptions, index: number): string {
  return o.ordered ? `${o.start + index}.` : o.bullet;
}

/** Validate `options` and resolve the shared list geometry. `count` sizes the
 *  auto-indent computation (widest marker across the list). @internal */
function normalizeListOptions(o: FlowListOptions, count: number): NormalizedListOptions {
  const ordered = o.ordered ?? false;
  if (typeof ordered !== 'boolean') throw new TypeError('ordered must be a boolean');
  const start = o.start ?? 1;
  if (!Number.isInteger(start)) throw new TypeError('start must be an integer');
  const bullet = o.bullet ?? DEFAULT_BULLET;
  if (typeof bullet !== 'string') throw new TypeError('bullet must be a string');
  const font = o.font ?? 'Helvetica';
  const fontSize = o.fontSize ?? 11;
  if (!Number.isFinite(fontSize) || fontSize <= 0)
    throw new TypeError('fontSize must be a positive finite number');
  const itemSpacing = nonNegative(o.itemSpacing, 0, 'itemSpacing');
  const spaceBefore = nonNegative(o.spaceBefore, 0, 'spaceBefore');
  const spaceAfter = nonNegative(o.spaceAfter, 0, 'spaceAfter');
  const markerGap = 0.5 * fontSize;

  const resolved: NormalizedListOptions = {
    ordered, start, bullet, font, fontSize, color: o.color, leading: o.leading,
    align: o.align, indent: 0, markerGap, itemSpacing, spaceBefore, spaceAfter,
  };
  if (o.indent !== undefined) {
    resolved.indent = nonNegative(o.indent, 0, 'indent');
  } else {
    let maxMarker = 0;
    for (let i = 0; i < count; i++)
      maxMarker = Math.max(maxMarker, measureText(markerFor(resolved, i), fontSize, font));
    resolved.indent = maxMarker + markerGap;
  }
  return resolved;
}

/** Expand `items` into one {@link ListItemElement} per string, sharing one
 *  resolved-options object and one structure holder. @internal */
function buildListElements(items: string[], options: FlowListOptions): FlowElement[] {
  if (!Array.isArray(items)) throw new TypeError('items must be an array of strings');
  if (!items.every((s) => typeof s === 'string'))
    throw new TypeError('items must be an array of strings');
  const o = normalizeListOptions(options, items.length);
  const holder: ListStructHolder = {};
  return items.map((text, i) => {
    const spaceBefore = i === 0 ? o.spaceBefore : 0;
    const spaceAfter = i === items.length - 1 ? o.spaceAfter : o.itemSpacing;
    return new ListItemElement(text, markerFor(o, i), o, spaceBefore, spaceAfter, holder);
  });
}

/** Test-only factory for a list's flow elements. @internal */
export function makeList(items: string[], options: FlowListOptions = {}): FlowElement[] {
  return buildListElements(items, options);
}
```

Note: `ListItemElement` and `ListStructHolder` are added in Task 2. This step will not
compile until Task 2 lands them — that is expected; the test in this task is written but
its green run happens after Task 2, Step 3. Proceed to Task 2 before running Step 5's
green check.

- [ ] **Step 5: (Deferred) green check runs after Task 2**

The `flow list options` tests depend on `ListItemElement` (Task 2). After Task 2 Step 3,
run: `npx vitest run test/flow.test.ts -t "flow list options"` → Expected: PASS.

- [ ] **Step 6: Commit (with Task 2)**

Task 1 and Task 2 share a commit because `buildListElements` references `ListItemElement`.
Commit at the end of Task 2, Step 8.

---

### Task 2: `ListItemElement` — marker + indented body + split continuation (untagged)

Implement the element that draws one list item: word-wrapped body through `flowTextBlock` at the indented `x`, a right-aligned marker through `stampText` drawn only on the first line, and a body-only continuation on overflow. Tagging fields are declared but only wired in Task 4 (they stay `undefined` when `ctx.structParent` is absent, i.e. untagged flows).

**Files:**
- Modify: `src/flow.ts` (add `ListStructHolder` + `ListItemElement` before `buildListElements`)
- Test: `test/flow.test.ts` (new `describe('list item element placement')` block)

**Interfaces:**
- Consumes: `PlaceContext`, `PlaceResult`, `FlowElement`, `NormalizedListOptions`, `flowTextBlock`, `stampText`, `measureText`, `StampOptions`, `TextBlockOptions`, `StructElement`.
- Produces:
  - `interface ListStructHolder { list?: StructElement; }` (internal)
  - `class ListItemElement implements FlowElement` with constructor `(text: string, marker: string, opts: NormalizedListOptions, spaceBefore: number, spaceAfter: number, holder: ListStructHolder)` and a `place(ctx: PlaceContext): PlaceResult` method; public readonly `spaceBefore` / `spaceAfter`.

- [ ] **Step 1: Write the failing test**

Add to `test/flow.test.ts`:

```ts
describe('list item element placement', () => {
  it('draws the marker once and indents the body past it', () => {
    const doc = Document.Open(buildBlankPage());
    const page = doc.Pages[0];
    const [el] = makeList(['hello'], { ordered: false, fontSize: 12, indent: 24 });
    const res = el.place({ doc, page, x: 72, top: 600, width: 200, availHeight: 200 });
    expect(res.drew).toBe(true);
    expect(res.remainder).toBeNull();

    const frags = page.GetTextFragments();
    const bullet = frags.find((f) => f.text.includes('•'))!;
    const body = frags.find((f) => f.text.includes('hello'))!;
    // Body starts at the gutter (x + indent = 96); marker sits left of it.
    expect(body.quad[0]).toBeCloseTo(96, 0);
    expect(bullet.quad[0]).toBeLessThan(body.quad[0]);
    // Marker and first body line share a baseline (top - fontSize = 588).
    expect(bullet.quad[1]).toBeCloseTo(body.quad[1], 1);
  });

  it('splits a tall item: marker on the first block only, body-only continuation', () => {
    const doc = Document.Open(buildBlankPage());
    const page = doc.Pages[0];
    const [el] = makeList(['aaa\nbbb\nccc\nddd'],
      { fontSize: 10, leading: 12, indent: 20 });
    // availHeight fits only 2 lines (24pt).
    const res = el.place({ doc, page, x: 72, top: 600, width: 200, availHeight: 24 });
    expect(res.drew).toBe(true);
    expect(res.remainder).not.toBeNull();
    // Continuation places the rest with no leftover and draws NO second marker.
    const doc2 = Document.Open(buildBlankPage());
    const page2 = doc2.Pages[0];
    // Re-run first placement on page2 so the continuation's page is clean of a marker.
    const [el2] = makeList(['aaa\nbbb\nccc\nddd'], { fontSize: 10, leading: 12, indent: 20 });
    const first = el2.place({ doc: doc2, page: page2, x: 72, top: 600, width: 200, availHeight: 24 });
    const cont = first.remainder!;
    const doc3 = Document.Open(buildBlankPage());
    const page3 = doc3.Pages[0];
    const res3 = cont.place({ doc: doc3, page: page3, x: 72, top: 500, width: 200, availHeight: 200 });
    expect(res3.drew).toBe(true);
    expect(res3.remainder).toBeNull();
    // The continuation page has body text but no bullet marker.
    const contFrags = page3.GetTextFragments();
    expect(contFrags.some((f) => f.text.includes('ccc'))).toBe(true);
    expect(contFrags.some((f) => f.text.includes('•'))).toBe(false);
  });

  it('retries (remainder=self, drew=false) when no space is left', () => {
    const doc = Document.Open(buildBlankPage());
    const page = doc.Pages[0];
    const [el] = makeList(['hi'], { fontSize: 10, leading: 12 });
    const res = el.place({ doc, page, x: 72, top: 600, width: 200, availHeight: 0 });
    expect(res.drew).toBe(false);
    expect(res.remainder).toBe(el);
  });

  it('discards an empty item (remainder=null, drew=false)', () => {
    const doc = Document.Open(buildBlankPage());
    const page = doc.Pages[0];
    const [el] = makeList([''], { fontSize: 10, leading: 12 });
    const res = el.place({ doc, page, x: 72, top: 600, width: 200, availHeight: 200 });
    expect(res.drew).toBe(false);
    expect(res.remainder).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/flow.test.ts -t "list item element placement"`
Expected: FAIL — `ListItemElement` / `makeList` not defined.

- [ ] **Step 3: Implement `ListStructHolder` + `ListItemElement`**

Insert into `src/flow.ts` immediately before the `buildListElements` function added in Task 1:

```ts
/** Shared across the items of one list so they append to a single `/L` node. The
 *  node is created lazily on the first item that actually draws. @internal */
interface ListStructHolder { list?: StructElement; }

/** One list item: a right-aligned marker (drawn once) plus a word-wrapped body
 *  flowed through {@link flowTextBlock} at an indented x. Overflow yields a
 *  body-only continuation that carries no marker. @internal */
class ListItemElement implements FlowElement {
  private markerDrawn = false;
  private li?: StructElement;
  private lbl?: StructElement;
  private lbody?: StructElement;

  constructor(
    private readonly text: string,
    private readonly marker: string,
    private readonly opts: NormalizedListOptions,
    readonly spaceBefore: number,
    readonly spaceAfter: number,
    private readonly holder: ListStructHolder,
  ) {}

  place(ctx: PlaceContext): PlaceResult {
    if (ctx.availHeight <= 0) return { usedHeight: 0, remainder: this, drew: false };

    // Lazily build /L → /LI → /Lbl + /LBody on first placement of non-empty text
    // under a tagged flow. Empty text never tags (no orphan); an overflow probe
    // that draws nothing leaves the nodes childless until the item draws.
    if (this.li === undefined && ctx.structParent && this.text.length > 0) {
      if (this.holder.list === undefined) this.holder.list = ctx.structParent.Append('L');
      this.li = this.holder.list.Append('LI');
      this.lbl = this.li.Append('Lbl');
      this.lbody = this.li.Append('LBody');
    }

    const bodyOpts: TextBlockOptions = {
      font: this.opts.font, fontSize: this.opts.fontSize, color: this.opts.color,
      align: this.opts.align, leading: this.opts.leading,
      ...(this.lbody ? { tag: this.lbody } : {}),
    };
    const rect: [number, number, number, number] = [
      ctx.x + this.opts.indent, ctx.top - ctx.availHeight,
      ctx.width - this.opts.indent, ctx.availHeight,
    ];
    const { remainder, usedHeight } = flowTextBlock(ctx.doc, ctx.page, this.text, rect, bodyOpts);

    if (usedHeight === 0) {
      // Nothing drawn: null remainder = empty (discard); else it did not fit the
      // leftover space (retry this element in the next column).
      return { usedHeight: 0, remainder: remainder === null ? null : this, drew: false };
    }

    if (!this.markerDrawn) {
      const markerWidth = measureText(this.marker, this.opts.fontSize, this.opts.font);
      // Right-align the marker against the gutter: its right edge sits one
      // markerGap left of the body edge, so ordinals line up on the period.
      const markerX = ctx.x + this.opts.indent - this.opts.markerGap - markerWidth;
      const baseline = ctx.top - this.opts.fontSize; // = the body's first-line baseline
      const markerOpts: StampOptions = {
        font: this.opts.font, fontSize: this.opts.fontSize, color: this.opts.color,
        ...(this.lbl ? { tag: this.lbl } : {}),
      };
      stampText(ctx.doc, ctx.page, this.marker, markerX, baseline, markerOpts);
      this.markerDrawn = true;
    }

    if (remainder === null) return { usedHeight, remainder: null, drew: true };
    // Continuation: body-only remainder, marker already drawn, same struct nodes,
    // spaceBefore = 0 (already started), same spaceAfter.
    const cont = new ListItemElement(
      remainder, this.marker, this.opts, 0, this.spaceAfter, this.holder);
    cont.markerDrawn = true;
    cont.li = this.li;
    cont.lbl = this.lbl;
    cont.lbody = this.lbody;
    return { usedHeight, remainder: cont, drew: true };
  }
}
```

- [ ] **Step 4: Run the list-item tests to verify they pass**

Run: `npx vitest run test/flow.test.ts -t "list item element placement"`
Expected: PASS (all four).

- [ ] **Step 5: Run the deferred Task 1 tests**

Run: `npx vitest run test/flow.test.ts -t "flow list options"`
Expected: PASS (all three).

- [ ] **Step 6: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 7: Run the full flow test file**

Run: `npx vitest run test/flow.test.ts`
Expected: PASS (existing + new).

- [ ] **Step 8: Commit**

```bash
git add src/flow.ts test/flow.test.ts
git commit -m "feat(flow): ListItemElement + list options/validation (db7v.3)"
```

---

### Task 3: `Flow.AddList` public method + integration through `Render`

Wire the public `AddList(items, options)` onto `Flow`, pushing the built elements onto the queue. Test end-to-end through `Render`: numbering sequence honoring `start`, auto-indent aligning `"1."` and `"10."`, `itemSpacing` gaps, `AddColumnBreak` between items, empty array no-op, chainable, and the marker-once-across-a-real-page-boundary case.

**Files:**
- Modify: `src/flow.ts` (add `AddList` method to `class Flow`)
- Test: `test/flow.test.ts` (new `describe('flow lists (AddList)')` block)

**Interfaces:**
- Consumes: `buildListElements` (Task 1), the existing `Flow.items` array and `Render` loop.
- Produces: `AddList(items: string[], options?: FlowListOptions): this` on `class Flow`.

- [ ] **Step 1: Write the failing test**

Add to `test/flow.test.ts`:

```ts
describe('flow lists (AddList)', () => {
  const opts = () => ({
    format: PageFormat.custom(300, 500), columns: 1,
    marginLeft: 20, marginRight: 20, marginTop: 20, marginBottom: 20,
  });

  it('renders a bullet list; each item is indented past the marker', () => {
    const doc = Document.Open(buildBlankPage());
    const flow = new Flow(doc, opts());
    flow.AddList(['First', 'Second', 'Third'], { fontSize: 12, leading: 16 });
    const [page] = flow.Render();
    const frags = page.GetTextFragments();
    const bullets = frags.filter((f) => f.text.includes('•'));
    expect(bullets.length).toBe(3);
    const first = frags.find((f) => f.text.includes('First'))!;
    const bullet = bullets[0];
    expect(bullet.quad[0]).toBeLessThan(first.quad[0]); // marker left of body
  });

  it('numbers an ordered list from start and aligns wide/narrow ordinals', () => {
    const doc = Document.Open(buildBlankPage());
    const flow = new Flow(doc, opts());
    const items = Array.from({ length: 10 }, (_, i) => `item${i}`);
    flow.AddList(items, { ordered: true, start: 1, fontSize: 12, leading: 16 });
    const [page] = flow.Render();
    const text = page.GetText();
    expect(text).toContain('1.');
    expect(text).toContain('10.');
    // "1." and "10." bodies share one gutter: item0 and item9 body x match.
    const frags = page.GetTextFragments();
    const b0 = frags.find((f) => f.text.includes('item0'))!;
    const b9 = frags.find((f) => f.text.includes('item9'))!;
    expect(b0.quad[0]).toBeCloseTo(b9.quad[0], 1);
  });

  it('itemSpacing inserts a vertical gap between items', () => {
    function gap(itemSpacing: number): number {
      const doc = Document.Open(buildBlankPage());
      const flow = new Flow(doc, opts());
      flow.AddList(['AAA', 'BBB'], { fontSize: 12, leading: 14, itemSpacing });
      const [page] = flow.Render();
      const a = page.GetTextFragments().find((f) => f.text.includes('AAA'))!;
      const b = page.GetTextFragments().find((f) => f.text.includes('BBB'))!;
      return a.quad[1] - b.quad[1]; // larger y = higher; positive gap downward
    }
    expect(gap(20) - gap(0)).toBeCloseTo(20, 2);
  });

  it('is chainable and empty array is a no-op', () => {
    const doc = Document.Open(buildBlankPage());
    const flow = new Flow(doc, opts());
    expect(flow.AddList([])).toBe(flow);
    expect(flow.AddList(['x'])).toBe(flow);
    const pages = flow.Render();
    expect(pages[0].GetText()).toContain('x');
  });

  it('draws the marker once when an item spans a page boundary', () => {
    // Short page: force a single long item to overflow onto a second page.
    const doc = Document.Open(buildBlankPage());
    const flow = new Flow(doc, {
      format: PageFormat.custom(200, 120), columns: 1,
      marginLeft: 20, marginRight: 20, marginTop: 20, marginBottom: 20,
    });
    const long = Array.from({ length: 30 }, (_, i) => `w${i}`).join(' ');
    flow.AddList([long], { fontSize: 12, leading: 16 });
    const pages = flow.Render();
    expect(pages.length).toBeGreaterThan(1);
    const bulletCount = pages.reduce(
      (n, p) => n + p.GetTextFragments().filter((f) => f.text.includes('•')).length, 0);
    expect(bulletCount).toBe(1); // exactly one marker across all pages
  });

  it('AddColumnBreak between items jumps to the next column', () => {
    const doc = Document.Open(buildBlankPage());
    const flow = new Flow(doc, {
      format: PageFormat.custom(400, 400), columns: 2, columnGap: 20,
      marginLeft: 20, marginRight: 20, marginTop: 20, marginBottom: 20,
    });
    flow.AddList(['AAA'], { fontSize: 12, leading: 14 });
    flow.AddColumnBreak();
    flow.AddList(['BBB'], { fontSize: 12, leading: 14 });
    const [page] = flow.Render();
    const frags = page.GetTextFragments();
    const a = frags.find((f) => f.text.includes('AAA'))!;
    const b = frags.find((f) => f.text.includes('BBB'))!;
    expect(a.quad[0]).toBeLessThan(210);
    expect(b.quad[0]).toBeGreaterThanOrEqual(210);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/flow.test.ts -t "flow lists (AddList)"`
Expected: FAIL — `flow.AddList is not a function`.

- [ ] **Step 3: Add the `AddList` method to `class Flow`**

Insert into `class Flow` in `src/flow.ts` after `AddHeading` (around `src/flow.ts:251`, before `AddColumnBreak`):

```ts
  /** Append a bullet (default) or numbered (`{ ordered: true }`) list. Each
   *  string in `items` is one word-wrapped item; the marker is drawn once even
   *  when an item spans a column/page boundary. Empty array is a no-op.
   *  Chainable. */
  AddList(items: string[], options: FlowListOptions = {}): this {
    for (const el of buildListElements(items, options)) this.items.push(el);
    return this;
  }
```

- [ ] **Step 4: Run the AddList tests to verify they pass**

Run: `npx vitest run test/flow.test.ts -t "flow lists (AddList)"`
Expected: PASS (all six).

- [ ] **Step 5: Commit**

```bash
git add src/flow.ts test/flow.test.ts
git commit -m "feat(flow): Flow.AddList public method + pagination integration (db7v.3)"
```

---

### Task 4: Tagged logical structure (`/L` → `/LI` → `/Lbl` + `/LBody`)

The `ListItemElement.place` code already appends the `/L`/`/LI`/`/Lbl`/`/LBody` nodes and tags the marker and body when `ctx.structParent` is present (added in Task 2). This task verifies that behavior end-to-end through a tagged flow and proves the assertions are load-bearing.

**Files:**
- Test: `test/flow.test.ts` (new `describe('flow list tagging')` block)
- Modify (only if a test surfaces a bug): `src/flow.ts`

**Interfaces:**
- Consumes: `Flow` with `{ tagged: true }`, `doc.CreateStructTree()`, `StructElement.Children` / `.Type` / `.GetText()`, `doc.Save()` + `Document.Open`.
- Produces: no new source interfaces (verification task).

- [ ] **Step 1: Write the failing/verifying test**

Add to `test/flow.test.ts`:

```ts
describe('flow list tagging', () => {
  const tagged = () => ({
    format: PageFormat.custom(400, 500), columns: 1,
    marginLeft: 20, marginRight: 20, marginTop: 20, marginBottom: 20, tagged: true,
  });

  it('emits /L → /LI → /Lbl + /LBody for each item (round-trip)', () => {
    const doc = Document.Open(buildBlankPage());
    const flow = new Flow(doc, tagged());
    flow.AddList(['Alpha', 'Beta'], { ordered: true, fontSize: 12, leading: 16 });
    flow.Render();

    const sect = doc.CreateStructTree().Children.find((c) => c.Type === 'Sect')!;
    const list = sect.Children.find((c) => c.Type === 'L')!;
    expect(list).toBeDefined();
    const items = list.Children.filter((c) => c.Type === 'LI');
    expect(items.length).toBe(2);
    for (const li of items) {
      expect(li.Children.some((c) => c.Type === 'Lbl')).toBe(true);
      expect(li.Children.some((c) => c.Type === 'LBody')).toBe(true);
    }
    // Text survives a save/open round-trip and lands under the list.
    const re = Document.Open(doc.Save());
    expect(re.GetStructTree()!.GetText()).toContain('Alpha');
    expect(re.GetStructTree()!.GetText()).toContain('Beta');
  });

  it('an all-empty list produces no /L node', () => {
    const doc = Document.Open(buildBlankPage());
    const flow = new Flow(doc, tagged());
    flow.AddList(['', ''], { fontSize: 12 });
    flow.Render();
    const sect = doc.CreateStructTree().Children.find((c) => c.Type === 'Sect')!;
    expect(sect.Children.some((c) => c.Type === 'L')).toBe(false);
  });

  it('a split item keeps exactly one /Lbl and one /LBody', () => {
    // Two short columns force a single long item to span a column boundary.
    const doc = Document.Open(buildBlankPage());
    const flow = new Flow(doc, {
      format: PageFormat.custom(360, 120), columns: 2, columnGap: 20,
      marginLeft: 20, marginRight: 20, marginTop: 20, marginBottom: 20, tagged: true,
    });
    const long = Array.from({ length: 30 }, (_, i) => `w${i}`).join(' ');
    flow.AddList([long], { fontSize: 12, leading: 16 });
    flow.Render();
    const sect = doc.CreateStructTree().Children.find((c) => c.Type === 'Sect')!;
    const list = sect.Children.find((c) => c.Type === 'L')!;
    const lis = list.Children.filter((c) => c.Type === 'LI');
    expect(lis.length).toBe(1); // one item, even though it drew on two columns
    const li = lis[0];
    expect(li.Children.filter((c) => c.Type === 'Lbl').length).toBe(1);
    expect(li.Children.filter((c) => c.Type === 'LBody').length).toBe(1);
  });

  it('untagged flow (default) creates no list structure', () => {
    const doc = Document.Open(buildBlankPage());
    const flow = new Flow(doc, {
      format: PageFormat.custom(400, 500), columns: 1,
      marginLeft: 20, marginRight: 20, marginTop: 20, marginBottom: 20, // tagged omitted
    });
    flow.AddList(['x', 'y'], { fontSize: 12 });
    flow.Render();
    const re = Document.Open(doc.Save());
    expect(re.GetStructTree()).toBeNull();
  });
});
```

- [ ] **Step 2: Run the tagging tests**

Run: `npx vitest run test/flow.test.ts -t "flow list tagging"`
Expected: PASS (all four). If any fail, debug `ListItemElement.place`'s struct-node
creation (Task 2 Step 3) — the nodes must be created once, reused by the continuation,
and gated on `text.length > 0`.

- [ ] **Step 3: Prove the tagging assertion is load-bearing (repo convention)**

Temporarily break the structure in `src/flow.ts`: in `ListItemElement.place`, change
`this.lbl = this.li.Append('Lbl');` to `this.lbl = this.li.Append('Span');` and re-run:

Run: `npx vitest run test/flow.test.ts -t "flow list tagging"`
Expected: FAIL on the `/Lbl` assertion (confirms the test guards the subtree shape).

Then **revert** the change (restore `'Lbl'`) and re-run:

Run: `npx vitest run test/flow.test.ts -t "flow list tagging"`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add test/flow.test.ts
git commit -m "test(flow): verify list /L/LI/Lbl/LBody tagging (db7v.3)"
```

---

### Task 5: Public exports, README, follow-up issues, and quality gates

Export `FlowListOptions` from the package index, document `AddList` in the README's Flow section, file the two deferred follow-up issues, and run the full quality gates before closing.

**Files:**
- Modify: `src/index.ts` (add `FlowListOptions` to the flow type re-export)
- Modify: `README.md` (Flow layout section)

**Interfaces:**
- Consumes: `FlowListOptions` (Task 1).
- Produces: `FlowListOptions` in the public type surface.

- [ ] **Step 1: Write the failing export test**

Add to `test/flow.test.ts`, inside the existing `describe('doc.NewFlow integration', …)` block, a new `it`:

```ts
  it('AddList is available on a doc-bound flow and renders', () => {
    const doc = Document.Open(buildBlankPage());
    const flow = doc.NewFlow({ format: PageFormat.custom(300, 400),
      marginLeft: 20, marginRight: 20, marginTop: 20, marginBottom: 20 });
    flow.AddList(['one', 'two'], { ordered: true });
    const [page] = flow.Render();
    expect(page.GetText()).toContain('one');
    expect(page.GetText()).toContain('1.');
  });
```

- [ ] **Step 2: Run it (should already pass — AddList shipped in Task 3)**

Run: `npx vitest run test/flow.test.ts -t "AddList is available on a doc-bound flow"`
Expected: PASS (this is a smoke test through `doc.NewFlow`).

- [ ] **Step 3: Add `FlowListOptions` to the index re-export**

In `src/index.ts`, change the flow type export (lines 70-72) from:

```ts
export type {
  FlowOptions, FlowParagraphOptions, FlowHeadingOptions, FlowElement, PlaceContext, PlaceResult,
} from './flow.js';
```

to:

```ts
export type {
  FlowOptions, FlowParagraphOptions, FlowHeadingOptions, FlowListOptions,
  FlowElement, PlaceContext, PlaceResult,
} from './flow.js';
```

- [ ] **Step 4: Update the README Flow section**

In `README.md`, in the Flow layout example (around line 417), add a list call after the
`AddColumnBreak` example line:

```ts
flow.AddParagraph('This starts in the next column.');
flow.AddList(['First point', 'Second point', 'Third point']);          // bullets
flow.AddList(['Step one', 'Step two'], { ordered: true, itemSpacing: 4 }); // 1. 2.
```

And extend the prose paragraph (around line 431). Replace:

```
`/P` for paragraphs) into the document structure tree; the default is untagged.
Lists, images, and floating boxes are tracked as follow-up work.
```

with:

```
`/P` for paragraphs, `/L`/`/LI`/`/Lbl`/`/LBody` for lists) into the document
structure tree; the default is untagged. `AddList(items, options)` takes a string
per item and draws a bullet (`bullet`, default "•") or numbered (`ordered: true`,
`start`) marker, with an auto or explicit `indent`, `itemSpacing` between items,
and list-level `spaceBefore`/`spaceAfter`. Nested lists, images, and floating
boxes are tracked as follow-up work.
```

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 6: Full test suite**

Run: `npm test`
Expected: all green.

- [ ] **Step 7: Build (verify the public type surface compiles to d.ts)**

Run: `npm run build`
Expected: succeeds, `dist/` emitted with no errors.

- [ ] **Step 8: File the two follow-up issues**

```bash
bd create "Nested lists in flow (sub-lists, per-level numbering, alternating markers)" \
  -t feature -p 3 --parent aspose-pdf-foss-for-ts-db7v \
  -d "Extend flow.AddList with nesting: sub-lists indent, ordered numbering restarts per level, unordered markers alternate. Deferred from db7v.3 (flat lists only)."
bd create "Object-form list items for flow.AddList (per-item overrides)" \
  -t feature -p 3 --parent aspose-pdf-foss-for-ts-db7v \
  -d "Widen flow.AddList items from string[] to also accept object items ({ text, ... }) for per-item styling. Non-breaking. Deferred from db7v.3."
```

(Verify the exact `bd create` flags with `bd create --help` first; adjust `--parent`/`-t`/`-p` to the project's conventions if they differ.)

- [ ] **Step 9: Commit**

```bash
git add src/index.ts README.md test/flow.test.ts
git commit -m "feat(flow): export FlowListOptions + document AddList (db7v.3)"
```

- [ ] **Step 10: Close the issue**

```bash
bd close aspose-pdf-foss-for-ts-db7v.3
```

---

## Notes for the implementer

- **Marker/body baseline coupling:** the body block (default `valign: 'top'`) puts its first
  line's baseline at `rectTop - fontSize`. Since `rectTop = ctx.top`, the marker is drawn at
  `baseline = ctx.top - fontSize` so the two align. Do not change one without the other.
- **Why the marker is drawn after the body in the content stream:** `flowTextBlock` runs first
  (to learn whether the item drew and to allocate the body MCID); the marker `stampText` follows.
  Painting order is irrelevant (text on text), and tagged reading order comes from the struct
  tree (`/Lbl` appended before `/LBody`), not the stream.
- **Continuation reuses the struct nodes** (`li`/`lbl`/`lbody`) so a split item's overflow lands
  under the original `/LBody` and no second `/Lbl` is created.
- **Empty items** never create struct nodes (gated on `text.length > 0`), matching `TextElement`.
```

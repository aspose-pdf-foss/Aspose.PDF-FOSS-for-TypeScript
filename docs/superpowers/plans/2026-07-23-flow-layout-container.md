# Flow Layout Container Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `doc.NewFlow(options)` — a multi-column, auto-paginating flow layout container that appends fresh pages at the end of the document and flows content elements into them, shipping with a minimal `AddParagraph` element.

**Architecture:** A new `src/flow.ts` holds `PageFormat`, `FlowOptions`, a `FlowElement` placement protocol, a minimal paragraph element, and the `Flow` engine. The paragraph element reuses the existing `layout.ts`/`stamp.ts` text stack via a new `flowTextBlock` helper extracted from `stampTextBlock`. `doc.NewFlow()` on the `Document` facade constructs a `Flow` bound to the document; `flow.Render()` walks columns across appended pages, placing queued elements and re-queuing overflow.

**Tech Stack:** TypeScript (ESM, NodeNext, strict), vitest. Zero runtime deps (`node:` built-ins only).

## Global Constraints

- Zero runtime dependencies — only `node:` built-ins. Do NOT add npm runtime deps.
- ESM + NodeNext: every relative import specifier carries the `.js` extension (e.g. `import { Page } from './page.js'`).
- `strict` TypeScript. Run `npm run typecheck` and `npm test` before closing; both must be green.
- Public error types are `PdfParseError`/`UnsupportedFeatureError`/`InvalidPasswordError` (see `errors.ts`); use `TypeError`/`Error` for argument/state validation, matching the existing authoring modules (`stamp.ts`, `tablerender.ts`).
- TDD: write the failing test first, watch it fail, implement minimally, watch it pass, commit.
- Keep `README.md` in sync when adding public API.
- All coordinates are PDF user space (points, origin bottom-left).

---

## File Structure

- **Create `src/flow.ts`** — `PageFormat`, `FlowOptions`, `FlowParagraphOptions`, `FlowElement`/`PlaceContext`/`PlaceResult`, internal `ParagraphElement`, internal geometry (`normalizeFlowOptions`), and `class Flow`.
- **Modify `src/stamp.ts`** — extract `flowTextBlock` (returns `{ remainder, usedHeight }`); make `stampTextBlock` a thin wrapper.
- **Modify `src/document.ts`** — add `NewFlow(options?)` method.
- **Modify `src/index.ts`** — export the new public symbols.
- **Modify `README.md`** — add a Flow-layout subsection.
- **Create `test/flow.test.ts`** — engine, geometry, pagination, column-break, PageFormat, guards, round-trip.
- **Existing `test/stamp.test.ts` / `test/textblock.test.ts`** — must stay green after the `stampTextBlock` refactor.

---

## Task 1: `PageFormat` class

**Files:**
- Create: `src/flow.ts`
- Test: `test/flow.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `class PageFormat { readonly width: number; readonly height: number; static readonly A4: PageFormat; static readonly Letter: PageFormat; static readonly Legal: PageFormat; static custom(width: number, height: number): PageFormat; landscape(): PageFormat; portrait(): PageFormat; }`

- [ ] **Step 1: Write the failing test**

Create `test/flow.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { PageFormat } from '../src/flow.js';

describe('PageFormat', () => {
  it('exposes standard sizes in points', () => {
    expect([PageFormat.A4.width, PageFormat.A4.height]).toEqual([595, 842]);
    expect([PageFormat.Letter.width, PageFormat.Letter.height]).toEqual([612, 792]);
    expect([PageFormat.Legal.width, PageFormat.Legal.height]).toEqual([612, 1008]);
  });

  it('landscape() yields width >= height and is idempotent', () => {
    const l = PageFormat.A4.landscape();
    expect([l.width, l.height]).toEqual([842, 595]);
    expect(l.landscape()).toBe(l); // already landscape → same instance
  });

  it('portrait() yields height >= width and is idempotent', () => {
    const p = PageFormat.A4.landscape().portrait();
    expect([p.width, p.height]).toEqual([595, 842]);
    expect(PageFormat.A4.portrait()).toBe(PageFormat.A4);
  });

  it('custom() validates positive finite dimensions', () => {
    expect([PageFormat.custom(300, 200).width, PageFormat.custom(300, 200).height]).toEqual([300, 200]);
    expect(() => PageFormat.custom(0, 200)).toThrow(TypeError);
    expect(() => PageFormat.custom(300, -1)).toThrow(TypeError);
    expect(() => PageFormat.custom(NaN, 200)).toThrow(TypeError);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/flow.test.ts`
Expected: FAIL — cannot resolve `../src/flow.js` (module does not exist).

- [ ] **Step 3: Write minimal implementation**

Create `src/flow.ts`:

```ts
/** A page size in points (1/72"). Immutable. Go-parity abstraction for
 *  {@link FlowOptions.format}. */
export class PageFormat {
  private constructor(readonly width: number, readonly height: number) {}

  static readonly A4 = new PageFormat(595, 842);
  static readonly Letter = new PageFormat(612, 792);
  static readonly Legal = new PageFormat(612, 1008);

  /** A custom page size; both dimensions must be positive and finite. */
  static custom(width: number, height: number): PageFormat {
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0)
      throw new TypeError('PageFormat.custom: width and height must be positive finite numbers');
    return new PageFormat(width, height);
  }

  /** This format oriented so width >= height (returns `this` if already so). */
  landscape(): PageFormat {
    return this.width >= this.height ? this : new PageFormat(this.height, this.width);
  }

  /** This format oriented so height >= width (returns `this` if already so). */
  portrait(): PageFormat {
    return this.height >= this.width ? this : new PageFormat(this.height, this.width);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/flow.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/flow.ts test/flow.test.ts
git commit -m "feat(flow): PageFormat page-size abstraction (db7v.1)"
```

---

## Task 2: `flowTextBlock` helper in stamp.ts

Extract the body of `stampTextBlock` into `flowTextBlock`, which also returns the height consumed, and make `stampTextBlock` a thin wrapper. No behavior change to the public `stampTextBlock` / `Page.AddTextBlock`.

**Files:**
- Modify: `src/stamp.ts` (the `stampTextBlock` function near the end of the file)
- Test: `test/stamp.test.ts` (add a `flowTextBlock` case) and the existing suite must stay green.

**Interfaces:**
- Consumes: existing `stamp.ts` internals (`normalizeBlockOptions`, `validateRect`, `effectiveShape`, `shapeOptsFrom`, `shapedDriver`, `driverFor`, `layoutText`, `buildBlockBody`, `buildShapedBlockBody`, `registerFont`, `registerExtGState`, `appendContent`, `wrapMarkedContent`, `allocContentMcid`).
- Produces: `export function flowTextBlock(doc: Document, page: Page, text: string, rect: [number, number, number, number], options?: TextBlockOptions): { remainder: string | null; usedHeight: number }`. `usedHeight` is `linesDrawn * leading` (0 when nothing was drawn). `remainder` matches the existing `stampTextBlock` contract (`null` when everything fit or nothing was drawable; the leftover string otherwise).

- [ ] **Step 1: Write the failing test**

Add to `test/stamp.test.ts` (inside the top-level `describe`, keep existing imports; add `flowTextBlock` to the import from `../src/stamp.js` and `buildBlankPage` if not present):

```ts
import { flowTextBlock } from '../src/stamp.js';
// (buildBlankPage is already used by this suite; reuse it)

describe('flowTextBlock', () => {
  it('reports usedHeight = lines * leading and no remainder when it all fits', () => {
    const doc = Document.Open(buildBlankPage());
    const page = doc.Pages[0];
    const r = flowTextBlock(doc, page, 'one two three', [72, 600, 400, 200],
      { font: 'Helvetica', fontSize: 10, leading: 12 });
    expect(r.remainder).toBeNull();
    expect(r.usedHeight).toBeCloseTo(12, 6); // single line
  });

  it('clips to the box height and returns the overflow as remainder', () => {
    const doc = Document.Open(buildBlankPage());
    const page = doc.Pages[0];
    // Box only tall enough for 2 lines at leading 12.
    const text = 'aaa\nbbb\nccc\nddd';
    const r = flowTextBlock(doc, page, text, [72, 600, 40, 24],
      { font: 'Helvetica', fontSize: 10, leading: 12 });
    expect(r.usedHeight).toBeCloseTo(24, 6); // 2 lines
    expect(r.remainder).toContain('ccc');
  });

  it('returns usedHeight 0 and null remainder for empty text', () => {
    const doc = Document.Open(buildBlankPage());
    const page = doc.Pages[0];
    const r = flowTextBlock(doc, page, '', [72, 600, 400, 200], { fontSize: 10, leading: 12 });
    expect(r.usedHeight).toBe(0);
    expect(r.remainder).toBeNull();
  });
});
```

> If `test/stamp.test.ts` does not already import `Document` / `buildBlankPage`, add:
> `import { Document } from '../src/index.js';` and
> `import { buildBlankPage } from './helpers/build-blank-page.js';`

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/stamp.test.ts`
Expected: FAIL — `flowTextBlock` is not exported from `../src/stamp.js`.

- [ ] **Step 3: Write minimal implementation**

In `src/stamp.ts`, replace the existing `stampTextBlock` function (the one whose signature is `export function stampTextBlock(doc, page, text, rect, options = {}): string | null`) with the following two functions. The body of `flowTextBlock` is the old `stampTextBlock` body with `usedHeight` tracking added and the return values changed to the `{ remainder, usedHeight }` object; `stampTextBlock` becomes a wrapper:

```ts
/** Flow `text` into the rectangle [x, y, w, h] on `page`, wrapping to the box
 *  width and clipping to its height. Returns the unconsumed `remainder` (`null`
 *  when everything fit or nothing was drawable) and `usedHeight`, the vertical
 *  space the drawn lines consumed (`linesDrawn * leading`, 0 when nothing was
 *  drawn). Existing content is preserved. */
export function flowTextBlock(
  doc: Document, page: Page, text: string,
  rect: [number, number, number, number], options: TextBlockOptions = {},
): { remainder: string | null; usedHeight: number } {
  validateRect(rect);
  const o = normalizeBlockOptions(options);
  const [x, y, w, h] = rect;
  if (effectiveShape(o.font, options.shape)) {
    const font = o.font;
    const so = shapeOptsFrom(options);
    const driver = shapedDriver(font, so);
    if (driver.probe(text) === 0) return { remainder: null, usedHeight: 0 };
    const { lines, remainder } = layoutText(text, driver, o.fontSize, w, h, o.leading);
    if (lines.length > 0) {
      const fontKey = registerFont(doc, page, font);
      const gsKey = o.opacity < 1 ? registerExtGState(doc, page, o.opacity) : undefined;
      const body = buildShapedBlockBody(font, lines, x, y, w, h, o, fontKey, gsKey, so);
      const tagged = options.tag
        ? wrapMarkedContent(options.tag.Type, allocContentMcid(doc, options.tag, page), body)
        : body;
      appendContent(doc, page, tagged);
    }
    return { remainder: remainder === '' ? null : remainder, usedHeight: lines.length * o.leading };
  }
  const driver = driverFor(o.font);
  if (driver.probe(text) === 0) return { remainder: null, usedHeight: 0 };
  const { lines, remainder } = layoutText(text, driver, o.fontSize, w, h, o.leading);
  if (lines.length > 0) {
    const fontKey = registerFont(doc, page, o.font);
    const gsKey = o.opacity < 1 ? registerExtGState(doc, page, o.opacity) : undefined;
    const body = buildBlockBody(lines, x, y, w, h, o, fontKey, gsKey);
    const tagged = options.tag
      ? wrapMarkedContent(options.tag.Type, allocContentMcid(doc, options.tag, page), body)
      : body;
    appendContent(doc, page, tagged);
  }
  return { remainder: remainder === '' ? null : remainder, usedHeight: lines.length * o.leading };
}

/** Flow `text` into the rectangle [x, y, w, h] on `page`, returning the
 *  unconsumed remainder (to continue into another box) or `null` when everything
 *  fit or nothing was drawn. Existing content is preserved. */
export function stampTextBlock(
  doc: Document, page: Page, text: string,
  rect: [number, number, number, number], options: TextBlockOptions = {},
): string | null {
  return flowTextBlock(doc, page, text, rect, options).remainder;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/stamp.test.ts test/textblock.test.ts`
Expected: PASS — new `flowTextBlock` cases pass and every existing block/text test stays green.

- [ ] **Step 5: Commit**

```bash
git add src/stamp.ts test/stamp.test.ts
git commit -m "refactor(stamp): extract flowTextBlock returning usedHeight (db7v.1)"
```

---

## Task 3: Flow geometry — `FlowOptions` + `normalizeFlowOptions`

Add the option type and a pure geometry function with full validation. Not yet exported publicly (Task 6 wires exports); tested by importing from `../src/flow.js`.

**Files:**
- Modify: `src/flow.ts`
- Test: `test/flow.test.ts`

**Interfaces:**
- Consumes: `PageFormat` (Task 1).
- Produces (all in `flow.ts`):
  - `export interface FlowOptions { format?: PageFormat; columns?: number; columnGap?: number; marginLeft?: number; marginRight?: number; marginTop?: number; marginBottom?: number; paragraphSpacing?: number; }`
  - `export interface Geometry { format: PageFormat; columns: number; columnGap: number; paragraphSpacing: number; contentLeft: number; contentTop: number; contentBottom: number; columnWidth: number; columnHeight: number; }`
  - `export function normalizeFlowOptions(options?: FlowOptions): Geometry`
  - `export function columnX(g: Geometry, col: number): number` — left edge of column `col`.

- [ ] **Step 1: Write the failing test**

Add to `test/flow.test.ts`:

```ts
import { normalizeFlowOptions, columnX } from '../src/flow.js';

describe('flow geometry', () => {
  it('defaults: A4, 1 column, 72pt margins', () => {
    const g = normalizeFlowOptions();
    expect(g.contentLeft).toBe(72);
    expect(g.contentTop).toBe(842 - 72);
    expect(g.contentBottom).toBe(72);
    expect(g.columnWidth).toBeCloseTo(595 - 144, 6);
    expect(g.columnHeight).toBeCloseTo(842 - 144, 6);
    expect(g.columns).toBe(1);
    expect(columnX(g, 0)).toBe(72);
  });

  it('splits width across columns with the gap', () => {
    const g = normalizeFlowOptions({
      format: PageFormat.custom(1000, 800), columns: 2, columnGap: 40,
      marginLeft: 50, marginRight: 50, marginTop: 60, marginBottom: 30,
    });
    // contentWidth = 1000-100 = 900; columnWidth = (900-40)/2 = 430
    expect(g.columnWidth).toBeCloseTo(430, 6);
    expect(columnX(g, 0)).toBe(50);
    expect(columnX(g, 1)).toBeCloseTo(50 + 430 + 40, 6);
    expect(g.contentTop).toBe(800 - 60);
    expect(g.contentBottom).toBe(30);
  });

  it('validates its inputs', () => {
    expect(() => normalizeFlowOptions({ columns: 0 })).toThrow(TypeError);
    expect(() => normalizeFlowOptions({ columns: 1.5 })).toThrow(TypeError);
    expect(() => normalizeFlowOptions({ marginLeft: -1 })).toThrow(TypeError);
    expect(() => normalizeFlowOptions({ columnGap: NaN })).toThrow(TypeError);
    // columnWidth <= 0: margins + gap eat all the width
    expect(() => normalizeFlowOptions({ marginLeft: 300, marginRight: 300 })).toThrow(TypeError);
    // columnHeight <= 0
    expect(() => normalizeFlowOptions({ marginTop: 500, marginBottom: 500 })).toThrow(TypeError);
    // wrong format type
    expect(() => normalizeFlowOptions({ format: {} as any })).toThrow(TypeError);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/flow.test.ts`
Expected: FAIL — `normalizeFlowOptions` / `columnX` not exported.

- [ ] **Step 3: Write minimal implementation**

Append to `src/flow.ts`:

```ts
/** Options for {@link Document.NewFlow}. All lengths are in points. */
export interface FlowOptions {
  /** Page size for every page the flow creates. Default {@link PageFormat.A4}. */
  format?: PageFormat;
  /** Number of columns. Integer >= 1. Default 1. */
  columns?: number;
  /** Gutter between columns. >= 0. Default 0. */
  columnGap?: number;
  /** Left / right / top / bottom page margins. Each >= 0. Default 72. */
  marginLeft?: number;
  marginRight?: number;
  marginTop?: number;
  marginBottom?: number;
  /** Vertical gap inserted between consecutive elements in a column. >= 0.
   *  Default 0. Dropped at a column top. */
  paragraphSpacing?: number;
}

/** Resolved, validated flow geometry (identical on every page). @internal */
export interface Geometry {
  format: PageFormat;
  columns: number;
  columnGap: number;
  paragraphSpacing: number;
  contentLeft: number;
  contentTop: number;
  contentBottom: number;
  columnWidth: number;
  columnHeight: number;
}

function nonNegative(v: number | undefined, dflt: number, name: string): number {
  const n = v ?? dflt;
  if (!Number.isFinite(n) || n < 0)
    throw new TypeError(`${name} must be a non-negative finite number`);
  return n;
}

/** Validate `options` and derive the page/column geometry. @internal */
export function normalizeFlowOptions(options: FlowOptions = {}): Geometry {
  const format = options.format ?? PageFormat.A4;
  if (!(format instanceof PageFormat)) throw new TypeError('format must be a PageFormat');
  const columns = options.columns ?? 1;
  if (!Number.isInteger(columns) || columns < 1)
    throw new TypeError('columns must be an integer >= 1');
  const columnGap = nonNegative(options.columnGap, 0, 'columnGap');
  const marginLeft = nonNegative(options.marginLeft, 72, 'marginLeft');
  const marginRight = nonNegative(options.marginRight, 72, 'marginRight');
  const marginTop = nonNegative(options.marginTop, 72, 'marginTop');
  const marginBottom = nonNegative(options.marginBottom, 72, 'marginBottom');
  const paragraphSpacing = nonNegative(options.paragraphSpacing, 0, 'paragraphSpacing');

  const contentLeft = marginLeft;
  const contentTop = format.height - marginTop;
  const contentBottom = marginBottom;
  const contentWidth = format.width - marginLeft - marginRight;
  const columnWidth = (contentWidth - (columns - 1) * columnGap) / columns;
  const columnHeight = contentTop - contentBottom;
  if (columnWidth <= 0)
    throw new TypeError('flow columnWidth must be positive (reduce margins, columns, or columnGap)');
  if (columnHeight <= 0)
    throw new TypeError('flow column height must be positive (reduce top/bottom margins)');

  return {
    format, columns, columnGap, paragraphSpacing,
    contentLeft, contentTop, contentBottom, columnWidth, columnHeight,
  };
}

/** Left edge (PDF user space) of column `col` (0-based). @internal */
export function columnX(g: Geometry, col: number): number {
  return g.contentLeft + col * (g.columnWidth + g.columnGap);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/flow.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/flow.ts test/flow.test.ts
git commit -m "feat(flow): FlowOptions geometry + validation (db7v.1)"
```

---

## Task 4: `FlowElement` protocol + minimal paragraph element

Define the placement protocol and the internal `ParagraphElement` that drives `flowTextBlock`. Test the element directly (no engine yet).

**Files:**
- Modify: `src/flow.ts`
- Test: `test/flow.test.ts`

**Interfaces:**
- Consumes: `flowTextBlock` (Task 2), `TextBlockOptions`/`AuthoringFont` from `stamp.ts`, `Document`/`Page` types.
- Produces (in `flow.ts`):
  - `export interface PlaceContext { doc: Document; page: Page; x: number; top: number; width: number; availHeight: number; }`
  - `export interface PlaceResult { usedHeight: number; remainder: FlowElement | null; drew: boolean; }`
  - `export interface FlowElement { place(ctx: PlaceContext): PlaceResult; }`
  - `export interface FlowParagraphOptions { font?: AuthoringFont; fontSize?: number; color?: [number, number, number]; align?: 'left' | 'center' | 'right' | 'justify'; leading?: number; }`
  - internal `class ParagraphElement implements FlowElement` with constructor `(text: string, opts: TextBlockOptions)`.
  - internal `function paragraphOptions(o: FlowParagraphOptions): TextBlockOptions`.

**Placement contract for `ParagraphElement.place`:**
- `availHeight <= 0` → `{ usedHeight: 0, remainder: this, drew: false }` (retry in next column).
- Otherwise call `flowTextBlock` with rect `[x, top - availHeight, width, availHeight]`.
  - `usedHeight > 0` → `{ usedHeight, remainder: <continuation ParagraphElement or null>, drew: true }`.
  - `usedHeight === 0` and `flowTextBlock` remainder is `null` (empty/undrawable) → `{ usedHeight: 0, remainder: null, drew: false }` (discard).
  - `usedHeight === 0` and remainder non-null (nothing fit in the leftover space) → `{ usedHeight: 0, remainder: this, drew: false }` (retry).

- [ ] **Step 1: Write the failing test**

Add to `test/flow.test.ts` (add imports at top of file):

```ts
import { Document } from '../src/index.js';
import { buildBlankPage } from './helpers/build-blank-page.js';
import { makeParagraph } from '../src/flow.js'; // test-only factory added in Step 3

describe('paragraph element placement', () => {
  it('draws what fits and returns a continuation for the rest', () => {
    const doc = Document.Open(buildBlankPage());
    const page = doc.Pages[0];
    const el = makeParagraph('aaa\nbbb\nccc\nddd', { font: 'Helvetica', fontSize: 10, leading: 12 });
    // availHeight only fits 2 lines
    const res = el.place({ doc, page, x: 72, top: 600, width: 40, availHeight: 24 });
    expect(res.drew).toBe(true);
    expect(res.usedHeight).toBeCloseTo(24, 6);
    expect(res.remainder).not.toBeNull();

    // The continuation places the rest in a taller box with no leftover.
    const res2 = res.remainder!.place({ doc, page, x: 72, top: 500, width: 40, availHeight: 200 });
    expect(res2.drew).toBe(true);
    expect(res2.remainder).toBeNull();
  });

  it('retries (remainder=self, drew=false) when no space is left', () => {
    const doc = Document.Open(buildBlankPage());
    const page = doc.Pages[0];
    const el = makeParagraph('hello', { fontSize: 10, leading: 12 });
    const res = el.place({ doc, page, x: 72, top: 600, width: 200, availHeight: 0 });
    expect(res.drew).toBe(false);
    expect(res.remainder).toBe(el);
  });

  it('discards empty text (remainder=null, drew=false)', () => {
    const doc = Document.Open(buildBlankPage());
    const page = doc.Pages[0];
    const el = makeParagraph('', { fontSize: 10, leading: 12 });
    const res = el.place({ doc, page, x: 72, top: 600, width: 200, availHeight: 200 });
    expect(res.drew).toBe(false);
    expect(res.remainder).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/flow.test.ts`
Expected: FAIL — `makeParagraph` not exported.

- [ ] **Step 3: Write minimal implementation**

At the top of `src/flow.ts` add the imports (keep the existing `PageFormat` code):

```ts
import type { Document } from './document.js';
import type { Page } from './page.js';
import { flowTextBlock, type TextBlockOptions, type AuthoringFont } from './stamp.js';
```

> Note: `AuthoringFont` and `TextBlockOptions` are already exported from `stamp.ts`. `flowTextBlock` is added in Task 2.

Append to `src/flow.ts`:

```ts
/** Where an element is being placed. `top` is the current column pen (PDF user
 *  space, decreasing downward); `availHeight = top - contentBottom`. @internal */
export interface PlaceContext {
  doc: Document;
  page: Page;
  x: number;
  top: number;
  width: number;
  availHeight: number;
}

/** Outcome of {@link FlowElement.place}. @internal */
export interface PlaceResult {
  /** Vertical space consumed in this column. */
  usedHeight: number;
  /** Overflow to continue in the next column/page, or `null` if fully placed
   *  (or discarded). */
  remainder: FlowElement | null;
  /** Whether anything was painted. */
  drew: boolean;
}

/** A unit of flow content. Sibling issues (headings, lists, images, floating
 *  boxes) implement this to plug into the {@link Flow} engine. */
export interface FlowElement {
  place(ctx: PlaceContext): PlaceResult;
}

/** Typographic options for {@link Flow.AddParagraph} (a subset of the text-block
 *  options; flow content is always laid top-down, so `valign` is not offered). */
export interface FlowParagraphOptions {
  font?: AuthoringFont;
  fontSize?: number;
  color?: [number, number, number];
  align?: 'left' | 'center' | 'right' | 'justify';
  leading?: number;
}

function paragraphOptions(o: FlowParagraphOptions): TextBlockOptions {
  return { font: o.font, fontSize: o.fontSize, color: o.color, align: o.align, leading: o.leading };
}

/** A word-wrapped paragraph flowed through {@link flowTextBlock}. @internal */
class ParagraphElement implements FlowElement {
  constructor(private readonly text: string, private readonly opts: TextBlockOptions) {}

  place(ctx: PlaceContext): PlaceResult {
    if (ctx.availHeight <= 0) return { usedHeight: 0, remainder: this, drew: false };
    const rect: [number, number, number, number] =
      [ctx.x, ctx.top - ctx.availHeight, ctx.width, ctx.availHeight];
    const { remainder, usedHeight } = flowTextBlock(ctx.doc, ctx.page, this.text, rect, this.opts);
    if (usedHeight === 0) {
      // Nothing drawn: null remainder = empty/undrawable (discard); else it did
      // not fit in the leftover space (retry this element in the next column).
      return { usedHeight: 0, remainder: remainder === null ? null : this, drew: false };
    }
    return {
      usedHeight,
      remainder: remainder === null ? null : new ParagraphElement(remainder, this.opts),
      drew: true,
    };
  }
}

/** Test-only factory for a paragraph element. @internal */
export function makeParagraph(text: string, o: FlowParagraphOptions = {}): FlowElement {
  return new ParagraphElement(text, paragraphOptions(o));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/flow.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/flow.ts test/flow.test.ts
git commit -m "feat(flow): FlowElement protocol + paragraph element (db7v.1)"
```

---

## Task 5: `Flow` class + pagination engine

Add `class Flow` with `AddParagraph`, `AddColumnBreak`, and the `Render` engine (single/multi-column, auto page append, column break, guards). `Flow` takes a `Document` in its constructor.

**Files:**
- Modify: `src/flow.ts`
- Test: `test/flow.test.ts`

**Interfaces:**
- Consumes: `normalizeFlowOptions`/`Geometry`/`columnX` (Task 3), `FlowElement`/`ParagraphElement`/`paragraphOptions`/`FlowParagraphOptions` (Task 4), `PageFormat` (Task 1), `Document.AddPage` (`doc.AddPage().page`), `Page.MediaBox` setter.
- Produces: `export class Flow { constructor(doc: Document, options?: FlowOptions); AddParagraph(text: string, options?: FlowParagraphOptions): this; AddColumnBreak(): this; Render(): Page[]; }`

**Engine rules (from the spec):**
- Pages are created lazily and only when a real element needs one, so a trailing `AddColumnBreak()` never yields a blank page. If the flow produced no pages at all (no drawable content), emit exactly one blank page.
- Per column, place queued items from `colTop` (start `contentTop`) toward `contentBottom`.
  - `drew && !remainder`: `colTop -= usedHeight`, then `colTop -= paragraphSpacing`.
  - `drew && remainder`: unshift remainder, advance column.
  - `!drew && remainder === null`: shift (empty element discarded), stay in column.
  - `!drew && remainder !== null`: if this is a fresh column start → throw; else advance column.
  - break marker: advance column.
- Advancing a column past the last column starts a new page at column 0.

- [ ] **Step 1: Write the failing test**

Add to `test/flow.test.ts`:

```ts
import { Flow } from '../src/flow.js';

describe('Flow engine', () => {
  // Small page so overflow is easy to force: 300x260, 1 column, 30pt margins.
  const smallOpts = () => ({
    format: PageFormat.custom(300, 260), columns: 1,
    marginLeft: 30, marginRight: 30, marginTop: 30, marginBottom: 30,
  });

  it('renders a single paragraph onto one appended page', () => {
    const doc = Document.Open(buildBlankPage());
    const before = doc.Pages.length;
    const flow = new Flow(doc, smallOpts());
    flow.AddParagraph('hello world', { font: 'Helvetica', fontSize: 12, leading: 14 });
    const pages = flow.Render();
    expect(pages.length).toBe(1);
    expect(doc.Pages.length).toBe(before + 1);
    expect([pages[0].MediaBox[2], pages[0].MediaBox[3]]).toEqual([300, 260]);
    expect(pages[0].GetText()).toContain('hello');
  });

  it('auto-paginates: long text spans multiple appended pages in order', () => {
    const doc = Document.Open(buildBlankPage());
    const flow = new Flow(doc, smallOpts());
    // Column height = 260 - 60 = 200; at leading 20 that is ~10 lines/page.
    const lines = Array.from({ length: 40 }, (_, i) => `L${i}`).join('\n');
    const flow2 = flow.AddParagraph(lines, { font: 'Helvetica', fontSize: 12, leading: 20 });
    expect(flow2).toBe(flow); // chainable
    const pages = flow.Render();
    expect(pages.length).toBeGreaterThan(1);
    // First marker on page 0, a later marker on a subsequent page.
    expect(pages[0].GetText()).toContain('L0');
    expect(pages[pages.length - 1].GetText()).toContain('L39');
    expect(pages[0].GetText()).not.toContain('L39');
  });

  it('fills column 0 then column 1 before a new page (2-col)', () => {
    const doc = Document.Open(buildBlankPage());
    const flow = new Flow(doc, {
      format: PageFormat.custom(400, 260), columns: 2, columnGap: 20,
      marginLeft: 20, marginRight: 20, marginTop: 20, marginBottom: 20,
    });
    const lines = Array.from({ length: 24 }, (_, i) => `N${i}`).join('\n');
    flow.AddParagraph(lines, { font: 'Helvetica', fontSize: 12, leading: 20 });
    const pages = flow.Render();
    // Column width = (360-20)/2 = 170; column 1 left edge = 20+170+20 = 210.
    const frags = pages[0].GetTextFragments();
    const n0 = frags.find((f) => f.text.includes('N0'))!;
    const later = frags.find((f) => f.text.includes('N11'))!;
    expect(n0.quad[0]).toBeLessThan(210);   // first content in the left column
    expect(later.quad[0]).toBeGreaterThanOrEqual(210); // later content in the right column
  });

  it('AddColumnBreak forces the next column with space left', () => {
    const doc = Document.Open(buildBlankPage());
    const flow = new Flow(doc, {
      format: PageFormat.custom(400, 400), columns: 2, columnGap: 20,
      marginLeft: 20, marginRight: 20, marginTop: 20, marginBottom: 20,
    });
    flow.AddParagraph('AAA', { font: 'Helvetica', fontSize: 12, leading: 14 });
    flow.AddColumnBreak();
    flow.AddParagraph('BBB', { font: 'Helvetica', fontSize: 12, leading: 14 });
    const pages = flow.Render();
    expect(pages.length).toBe(1);
    const frags = pages[0].GetTextFragments();
    const a = frags.find((f) => f.text.includes('AAA'))!;
    const b = frags.find((f) => f.text.includes('BBB'))!;
    expect(a.quad[0]).toBeLessThan(210);           // left column
    expect(b.quad[0]).toBeGreaterThanOrEqual(210);  // right column (break jumped)
  });

  it('empty flow still produces one blank page', () => {
    const doc = Document.Open(buildBlankPage());
    const flow = new Flow(doc, smallOpts());
    const pages = flow.Render();
    expect(pages.length).toBe(1);
  });

  it('throws on second Render', () => {
    const doc = Document.Open(buildBlankPage());
    const flow = new Flow(doc, smallOpts());
    flow.AddParagraph('x', { fontSize: 12, leading: 14 });
    flow.Render();
    expect(() => flow.Render()).toThrow(/already rendered/i);
  });

  it('throws when an element cannot fit an empty column', () => {
    const doc = Document.Open(buildBlankPage());
    // Column height ~ 8pt but leading 40 → not even one line fits.
    const flow = new Flow(doc, {
      format: PageFormat.custom(300, 60), columns: 1,
      marginLeft: 20, marginRight: 20, marginTop: 26, marginBottom: 26,
    });
    flow.AddParagraph('too tall', { fontSize: 30, leading: 40 });
    expect(() => flow.Render()).toThrow(/does not fit/i);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/flow.test.ts`
Expected: FAIL — `Flow` not exported from `../src/flow.js`.

- [ ] **Step 3: Write minimal implementation**

Append to `src/flow.ts`:

```ts
/** Sentinel enqueued by {@link Flow.AddColumnBreak}. @internal */
interface ColumnBreak { readonly kind: 'column-break'; }
type FlowItem = FlowElement | ColumnBreak;
function isBreak(item: FlowItem): item is ColumnBreak {
  return (item as ColumnBreak).kind === 'column-break';
}

/** A flow layout container. Create via {@link Document.NewFlow}. Queue content
 *  with {@link AddParagraph}/{@link AddColumnBreak}, then call {@link Render} to
 *  append the laid-out pages to the document. */
export class Flow {
  private readonly geometry: Geometry;
  private readonly items: FlowItem[] = [];
  private rendered = false;

  constructor(private readonly doc: Document, options?: FlowOptions) {
    this.geometry = normalizeFlowOptions(options);
  }

  /** Append a word-wrapped paragraph. Chainable. */
  AddParagraph(text: string, options: FlowParagraphOptions = {}): this {
    this.items.push(new ParagraphElement(text, paragraphOptions(options)));
    return this;
  }

  /** Force the following content to start in the next column (next page if in
   *  the last column). Chainable. */
  AddColumnBreak(): this {
    this.items.push({ kind: 'column-break' });
    return this;
  }

  /** Lay out the queued content, appending fresh pages at the end of the
   *  document, and return those pages in order. Single-shot: a second call
   *  throws. */
  Render(): Page[] {
    if (this.rendered) throw new Error('Flow already rendered');
    this.rendered = true;
    const g = this.geometry;
    const pages: Page[] = [];
    const ensurePage = (idx: number): Page => {
      while (pages.length <= idx) {
        const p = this.doc.AddPage().page;
        p.MediaBox = [0, 0, g.format.width, g.format.height];
        pages.push(p);
      }
      return pages[idx];
    };

    const queue: FlowItem[] = [...this.items];
    let pageIdx = 0;
    let col = 0;
    let colTop = g.contentTop;
    let atColumnStart = true;
    const advanceColumn = () => {
      col++;
      if (col >= g.columns) { col = 0; pageIdx++; }
      colTop = g.contentTop;
      atColumnStart = true;
    };

    while (queue.length > 0) {
      const item = queue[0];
      if (isBreak(item)) { queue.shift(); advanceColumn(); continue; }

      const page = ensurePage(pageIdx); // create a page only when content needs it
      const res = item.place({
        doc: this.doc, page,
        x: columnX(g, col), top: colTop, width: g.columnWidth,
        availHeight: colTop - g.contentBottom,
      });

      if (res.drew) {
        queue.shift();
        colTop -= res.usedHeight;
        atColumnStart = false;
        if (res.remainder) { queue.unshift(res.remainder); advanceColumn(); }
        else { colTop -= g.paragraphSpacing; }
        continue;
      }
      // Nothing painted.
      if (res.remainder === null) { queue.shift(); continue; } // empty element
      if (atColumnStart)
        throw new Error('Flow: element does not fit in an empty column (column too short for its content)');
      advanceColumn();
    }

    if (pages.length === 0) ensurePage(0); // always produce at least one page
    return pages;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/flow.test.ts`
Expected: PASS (all Flow-engine cases).

- [ ] **Step 5: Commit**

```bash
git add src/flow.ts test/flow.test.ts
git commit -m "feat(flow): Flow container with multi-column auto-pagination engine (db7v.1)"
```

---

## Task 6: Wire `doc.NewFlow`, public exports, and README

Expose the API on the `Document` facade and from `index.ts`, remove the test-only `makeParagraph` export path by keeping it (it is `@internal` and harmless) — no change needed there — and document the feature.

**Files:**
- Modify: `src/document.ts` (add the `NewFlow` method + import)
- Modify: `src/index.ts` (exports)
- Modify: `README.md` (Flow-layout subsection)
- Test: `test/flow.test.ts` (integration via `doc.NewFlow`)

**Interfaces:**
- Consumes: `Flow`, `FlowOptions` (Task 5).
- Produces: `Document.NewFlow(options?: FlowOptions): Flow`.

- [ ] **Step 1: Write the failing test**

Add to `test/flow.test.ts`:

```ts
describe('doc.NewFlow integration', () => {
  it('creates a Flow bound to the document and renders through it', () => {
    const doc = Document.Open(buildBlankPage());
    const flow = doc.NewFlow({ format: PageFormat.custom(300, 260), marginLeft: 30,
      marginRight: 30, marginTop: 30, marginBottom: 30 });
    flow.AddParagraph('bound to the doc', { font: 'Helvetica', fontSize: 12, leading: 14 });
    const pages = flow.Render();
    expect(pages.length).toBe(1);
    expect(pages[0].GetText()).toContain('bound');
    // Round-trips through save/open.
    const reopened = Document.Open(doc.Save());
    expect(reopened.Pages[reopened.Pages.length - 1].GetText()).toContain('bound');
  });
});
```

Also add a public-export smoke check to the existing top-of-file imports by importing from the package index:

```ts
import { PageFormat as PageFormatPub, Flow as FlowPub } from '../src/index.js';
// referenced in an assertion so the import is load-bearing:
it('exports PageFormat and Flow from the package index', () => {
  expect(typeof FlowPub).toBe('function');
  expect(PageFormatPub.A4.width).toBe(595);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/flow.test.ts`
Expected: FAIL — `doc.NewFlow` is not a function; `Flow`/`PageFormat` not exported from `../src/index.js`.

- [ ] **Step 3: Write minimal implementation**

In `src/document.ts`, add the import near the other authoring imports (top of file):

```ts
import { Flow, type FlowOptions } from './flow.js';
```

Add the method to the `Document` class (place it near `AddPage`, e.g. right after `AddPage`):

```ts
  /** Create a {@link Flow} layout container bound to this document. Queue content
   *  with `AddParagraph`/`AddColumnBreak`, then call `Render()` to append the
   *  laid-out pages to the end of this document. */
  NewFlow(options?: FlowOptions): Flow {
    return new Flow(this, options);
  }
```

In `src/index.ts`, add near the other authoring exports (after the `stamp`/`tableauthor` block around lines 64–70):

```ts
export { PageFormat, Flow } from './flow.js';
export type {
  FlowOptions, FlowParagraphOptions, FlowElement, PlaceContext, PlaceResult,
} from './flow.js';
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/flow.test.ts`
Expected: PASS.

- [ ] **Step 5: Add README documentation**

In `README.md`, add a subsection under the content-authoring area (near the `AddTable`/`AddTextBlock` documentation). Use this content:

```markdown
### Flow layout (`doc.NewFlow`)

Flow content into multi-column pages that the library appends and paginates
automatically:

```ts
import { PageFormat } from 'aspose-pdf-foss-for-ts';

const flow = doc.NewFlow({
  format: PageFormat.A4.landscape(),
  columns: 2,
  columnGap: 34,
  marginLeft: 48, marginRight: 48, marginTop: 128, marginBottom: 52,
  paragraphSpacing: 7,
});

flow.AddParagraph('Body text that word-wraps to the column width…',
                  { font: 'Helvetica', fontSize: 11, leading: 14 });
flow.AddColumnBreak();
flow.AddParagraph('This starts in the next column.');

const pages = flow.Render(); // fresh pages appended to the document
```

`Render()` returns the pages it created. It is single-shot — call it once per
flow. Page size comes from `PageFormat` (`.A4`/`.Letter`/`.Legal`,
`PageFormat.custom(w, h)`, `.landscape()`/`.portrait()`). Paragraphs are the
only content element today; headings, lists, images, and floating boxes are
tracked as follow-up work.
```

- [ ] **Step 6: Run the full quality gate**

Run: `npm run typecheck && npx vitest run test/flow.test.ts test/stamp.test.ts test/textblock.test.ts`
Expected: typecheck clean; all listed suites PASS.

- [ ] **Step 7: Commit**

```bash
git add src/document.ts src/index.ts README.md test/flow.test.ts
git commit -m "feat(flow): wire doc.NewFlow, exports, and README (db7v.1)"
```

---

## Final Verification (after all tasks)

- [ ] Run the whole suite: `npm test` — all green.
- [ ] Run `npm run typecheck` — no errors.
- [ ] Update the bd issue: `bd close db7v.1` (or `bd update db7v.1` with progress) and push per the session-completion workflow in `CLAUDE.md`.

---

## Self-Review Notes (author)

- **Spec coverage:** PageFormat (Task 1), FlowOptions + geometry/validation (Task 3), FlowElement protocol + engine + column break + guards (Tasks 4–5), minimal AddParagraph reusing stamp.ts via flowTextBlock (Tasks 2, 4), doc.NewFlow + exports + README + round-trip (Task 6). "Flow appends fresh pages at the end" and "single-shot Render" are covered by Task 5 tests. Fresh-column-too-short throw covered by Task 5.
- **Type consistency:** `flowTextBlock` returns `{ remainder, usedHeight }` in Tasks 2/4; `PlaceResult` fields `{ usedHeight, remainder, drew }` consistent across Tasks 4/5; `Geometry`/`columnX` names consistent across Tasks 3/5; `FlowParagraphOptions`/`paragraphOptions` consistent Tasks 4/5.
- **No placeholders:** every code step is complete; every command has an expected result.

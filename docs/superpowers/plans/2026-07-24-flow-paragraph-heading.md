# Flow Paragraph & Heading Elements Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `flow.AddHeading(level, text, options)`, per-element `spaceBefore`/`spaceAfter` spacing on flow text elements, and opt-in logical-structure tagging (`/H1`..`/H6`, `/P`) to the existing flow layout engine.

**Architecture:** Generalize the existing internal `ParagraphElement` into one `TextElement` that carries a structure type and per-element spacing. Refactor the `Flow.Render` engine to apply spacing as a single additive "gap-before-element" (dropped at a column top). Wire tagging through the machinery `stamp.ts`/`struct.ts` already expose (`flowTextBlock`'s `tag` option + MCR cross-page spanning), gated by a new opt-in `FlowOptions.tagged` flag so default output stays byte-identical.

**Tech Stack:** TypeScript (strict, ESM/NodeNext, `.js` import specifiers), vitest. Zero runtime deps.

## Global Constraints

- **Zero runtime dependencies** — only `node:` built-ins. Do not add npm deps.
- **ESM + NodeNext** — every import specifier carries the `.js` extension (e.g. `import { StructElement } from './struct.js'`).
- **Public error types only** — throw `TypeError` for invalid arguments (matches existing flow validation).
- **TDD** — write the failing test first, watch it fail, implement minimally, watch it pass, commit.
- **Run `npm run typecheck` and `npm test` green before closing** — both must pass.
- **Design spec:** `docs/superpowers/specs/2026-07-24-flow-paragraph-heading-design.md` — the authority for behavior.
- **All lengths in points.** Spacing options validate as non-negative finite numbers.

---

## File structure

| File | Change | Responsibility |
|---|---|---|
| `src/flow.ts` | Modify | The whole feature: spacing options, `TextElement`, engine gap logic, `AddHeading`, opt-in tagging. |
| `src/index.ts` | Modify | Export the new `FlowHeadingOptions` type. |
| `test/flow.test.ts` | Modify | Additive tests for spacing, headings, tagging. |
| `README.md` | Modify | Document `AddHeading`, spacing, and `tagged`. |

All source changes live in `src/flow.ts` because the flow engine is a single cohesive unit; the tagging rides entirely on already-exported helpers (`flowTextBlock`, `StructElement`, `doc.CreateStructTree`), so no other module changes.

---

## Task 1: Per-element spacing + `TextElement` generalization + engine gap refactor

**Files:**
- Modify: `src/flow.ts`
- Test: `test/flow.test.ts`

**Interfaces:**
- Consumes: existing `flowTextBlock` (from `stamp.ts`), `nonNegative`, `paragraphOptions`, `PlaceContext`, `PlaceResult`, `Geometry`, `columnX` (all already in `flow.ts`).
- Produces:
  - `FlowParagraphOptions` gains `spaceBefore?: number` and `spaceAfter?: number`.
  - `FlowElement` gains optional `readonly spaceBefore?: number` and `readonly spaceAfter?: number`.
  - internal `class TextElement implements FlowElement` with constructor `(text: string, opts: TextBlockOptions, structType: string, spaceBefore: number, spaceAfter: number, tag?: StructElement)`. `structType` and `tag` are dormant here; consumed in Task 3.
  - `makeParagraph(text, options?)` still returns a `FlowElement` (now a `TextElement` with `structType: 'P'`).

- [ ] **Step 1: Write the failing tests**

Add this block to the end of `test/flow.test.ts` (before the final `import`/`describe('doc.NewFlow integration')` block is fine; append at file end):

```ts
describe('flow per-element spacing', () => {
  // 400pt tall page, 1 column, so two short paragraphs share a column and we can
  // measure the vertical gap between them from extracted text positions.
  const opts = () => ({
    format: PageFormat.custom(300, 400), columns: 1,
    marginLeft: 20, marginRight: 20, marginTop: 20, marginBottom: 20,
  });

  function topOf(page: import('../src/index.js').Page, needle: string): number {
    const f = page.GetTextFragments().find((fr) => fr.text.includes(needle))!;
    // quad = [x0, y0, x1, y1]; y0 is the baseline row. Larger y = higher on page.
    return f.quad[1];
  }

  it('spaceBefore pushes the following element down by the given points', () => {
    const doc = Document.Open(buildBlankPage());
    const flow = new Flow(doc, opts());
    flow.AddParagraph('AAA', { fontSize: 12, leading: 14 });
    flow.AddParagraph('BBB', { fontSize: 12, leading: 14, spaceBefore: 30 });
    const [page] = flow.Render();

    const doc2 = Document.Open(buildBlankPage());
    const flow2 = new Flow(doc2, opts());
    flow2.AddParagraph('AAA', { fontSize: 12, leading: 14 });
    flow2.AddParagraph('BBB', { fontSize: 12, leading: 14 }); // no spaceBefore
    const [page2] = flow2.Render();

    const gapWith = topOf(page, 'AAA') - topOf(page, 'BBB');
    const gapWithout = topOf(page2, 'AAA') - topOf(page2, 'BBB');
    expect(gapWith - gapWithout).toBeCloseTo(30, 3);
  });

  it('spaceAfter of the previous element also pushes the next down', () => {
    const doc = Document.Open(buildBlankPage());
    const flow = new Flow(doc, opts());
    flow.AddParagraph('AAA', { fontSize: 12, leading: 14, spaceAfter: 25 });
    flow.AddParagraph('BBB', { fontSize: 12, leading: 14 });
    const [page] = flow.Render();

    const doc2 = Document.Open(buildBlankPage());
    const flow2 = new Flow(doc2, opts());
    flow2.AddParagraph('AAA', { fontSize: 12, leading: 14 });
    flow2.AddParagraph('BBB', { fontSize: 12, leading: 14 });
    const [page2] = flow2.Render();

    const gapWith = topOf(page, 'AAA') - topOf(page, 'BBB');
    const gapWithout = topOf(page2, 'AAA') - topOf(page2, 'BBB');
    expect(gapWith - gapWithout).toBeCloseTo(25, 3);
  });

  it('drops leading gap at a column top (first element flush at contentTop)', () => {
    // Two columns; a spaceBefore paragraph forced to the top of column 1 must NOT
    // be pushed down by its spaceBefore.
    const doc = Document.Open(buildBlankPage());
    const flow = new Flow(doc, {
      format: PageFormat.custom(400, 300), columns: 2, columnGap: 20,
      marginLeft: 20, marginRight: 20, marginTop: 20, marginBottom: 20,
    });
    flow.AddParagraph('AAA', { fontSize: 12, leading: 14 });
    flow.AddColumnBreak();
    flow.AddParagraph('BBB', { fontSize: 12, leading: 14, spaceBefore: 40 });
    const [page] = flow.Render();
    // BBB is the first element of column 1: its baseline sits within one leading
    // of contentTop (300 - 20 = 280), i.e. spaceBefore was dropped.
    const top = topOf(page, 'BBB');
    expect(top).toBeGreaterThan(280 - 14 - 0.5); // ~266, not pushed 40 lower
  });

  it('rejects negative / non-finite spacing', () => {
    const doc = Document.Open(buildBlankPage());
    const flow = new Flow(doc, opts());
    expect(() => flow.AddParagraph('x', { spaceBefore: -1 })).toThrow(TypeError);
    expect(() => flow.AddParagraph('x', { spaceAfter: NaN })).toThrow(TypeError);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/flow.test.ts -t "per-element spacing"`
Expected: FAIL — `spaceBefore`/`spaceAfter` are not applied yet (gaps equal; validation not thrown).

- [ ] **Step 3: Add spacing to the option and element interfaces**

In `src/flow.ts`, extend `FlowParagraphOptions` (currently lines 115-121) to add the two spacing fields:

```ts
export interface FlowParagraphOptions {
  font?: AuthoringFont;
  fontSize?: number;
  color?: [number, number, number];
  align?: 'left' | 'center' | 'right' | 'justify';
  leading?: number;
  /** Points inserted above this element (dropped at a column top). >= 0. Default 0. */
  spaceBefore?: number;
  /** Points inserted below this element (dropped at a column top). >= 0. Default 0. */
  spaceAfter?: number;
}
```

Extend `FlowElement` (currently lines 107-111) so the engine can read spacing:

```ts
export interface FlowElement {
  place(ctx: PlaceContext): PlaceResult;
  /** Points to reserve above this element; treated as 0 when absent. */
  readonly spaceBefore?: number;
  /** Points to reserve below this element; treated as 0 when absent. */
  readonly spaceAfter?: number;
}
```

Add a spacing normalizer helper next to `paragraphOptions` (after line 125):

```ts
function normalizeSpacing(o: FlowParagraphOptions): { spaceBefore: number; spaceAfter: number } {
  return {
    spaceBefore: nonNegative(o.spaceBefore, 0, 'spaceBefore'),
    spaceAfter: nonNegative(o.spaceAfter, 0, 'spaceAfter'),
  };
}
```

- [ ] **Step 4: Replace `ParagraphElement` with `TextElement`**

Add the import for `StructElement` at the top of `src/flow.ts` (with the other imports, ~line 4):

```ts
import type { StructElement } from './struct.js';
```

Replace the entire `class ParagraphElement` (currently lines 127-147) with:

```ts
/** A word-wrapped text element (paragraph or heading) flowed through
 *  {@link flowTextBlock}. `structType` (`'P'`, `'H1'`..`'H6'`) and `tag` drive
 *  logical-structure tagging when the flow is tagged. @internal */
class TextElement implements FlowElement {
  constructor(
    private readonly text: string,
    private readonly opts: TextBlockOptions,
    private readonly structType: string,
    readonly spaceBefore: number,
    readonly spaceAfter: number,
    private tag?: StructElement,
  ) {}

  place(ctx: PlaceContext): PlaceResult {
    if (ctx.availHeight <= 0) return { usedHeight: 0, remainder: this, drew: false };
    const opts = this.tag ? { ...this.opts, tag: this.tag } : this.opts;
    const rect: [number, number, number, number] =
      [ctx.x, ctx.top - ctx.availHeight, ctx.width, ctx.availHeight];
    const { remainder, usedHeight } = flowTextBlock(ctx.doc, ctx.page, this.text, rect, opts);
    if (usedHeight === 0) {
      // Nothing drawn: null remainder = empty/undrawable (discard); else it did
      // not fit in the leftover space (retry this element in the next column).
      return { usedHeight: 0, remainder: remainder === null ? null : this, drew: false };
    }
    return {
      usedHeight,
      // Continuation carries spaceBefore = 0 (already started) and the same tag.
      remainder: remainder === null ? null
        : new TextElement(remainder, this.opts, this.structType, 0, this.spaceAfter, this.tag),
      drew: true,
    };
  }
}
```

Update `makeParagraph` (currently lines 149-152) to build a `TextElement`:

```ts
/** Test-only factory for a paragraph element. @internal */
export function makeParagraph(text: string, o: FlowParagraphOptions = {}): FlowElement {
  const { spaceBefore, spaceAfter } = normalizeSpacing(o);
  return new TextElement(text, paragraphOptions(o), 'P', spaceBefore, spaceAfter);
}
```

Update `Flow.AddParagraph` (currently lines 173-177) to build a `TextElement`:

```ts
  /** Append a word-wrapped paragraph. Chainable. */
  AddParagraph(text: string, options: FlowParagraphOptions = {}): this {
    const { spaceBefore, spaceAfter } = normalizeSpacing(options);
    this.items.push(new TextElement(text, paragraphOptions(options), 'P', spaceBefore, spaceAfter));
    return this;
  }
```

- [ ] **Step 5: Refactor the `Render` engine loop for gap-before-element**

Replace the body of `Render()` from the `const queue` line through the end of the `while` loop (currently lines 201-237) with this version (the surrounding `Render` signature, `rendered` guard, `ensurePage`, and trailing `if (pages.length === 0)` return stay unchanged):

```ts
    const queue: FlowItem[] = [...this.items];
    let pageIdx = 0;
    let col = 0;
    let colTop = g.contentTop;
    let atColumnStart = true;
    let pendingSpaceAfter = 0; // spaceAfter of the last fully-placed element in this column
    const advanceColumn = () => {
      col++;
      if (col >= g.columns) { col = 0; pageIdx++; }
      colTop = g.contentTop;
      atColumnStart = true;
      pendingSpaceAfter = 0;
    };

    while (queue.length > 0) {
      const item = queue[0];
      if (isBreak(item)) { queue.shift(); advanceColumn(); continue; }

      // Gap above this element, dropped entirely at a column top.
      const gap = atColumnStart ? 0
        : pendingSpaceAfter + g.paragraphSpacing + (item.spaceBefore ?? 0);
      const top = colTop - gap;

      const page = ensurePage(pageIdx); // create a page only when content needs it
      const res = item.place({
        doc: this.doc, page,
        x: columnX(g, col), top, width: g.columnWidth,
        availHeight: top - g.contentBottom,
      });

      if (res.drew) {
        queue.shift();
        colTop = top - res.usedHeight; // consume the gap and the used height
        atColumnStart = false;
        if (res.remainder) { queue.unshift(res.remainder); advanceColumn(); }
        else { pendingSpaceAfter = item.spaceAfter ?? 0; }
        continue;
      }
      // Nothing painted.
      if (res.remainder === null) { queue.shift(); continue; } // empty element
      if (atColumnStart)
        throw new Error('Flow: element does not fit in an empty column (column too short for its content)');
      advanceColumn();
    }
```

- [ ] **Step 6: Run the new spacing tests and the whole flow suite**

Run: `npx vitest run test/flow.test.ts`
Expected: PASS — the four new spacing tests plus every pre-existing flow test (the gap refactor is behavior-preserving when no spacing is set, so the existing pagination/geometry/column-break tests stay green).

- [ ] **Step 7: Run the stamp suite (untouched but adjacent) and typecheck**

Run: `npx vitest run test/stamp.test.ts && npm run typecheck`
Expected: PASS — no `flowTextBlock`/`stampTextBlock` behavior changed; types compile.

- [ ] **Step 8: Commit**

```bash
git add src/flow.ts test/flow.test.ts
git commit -m "feat(flow): per-element spaceBefore/spaceAfter + TextElement generalization (db7v.2)"
```

---

## Task 2: `flow.AddHeading(level, text, options)`

**Files:**
- Modify: `src/flow.ts`
- Modify: `src/index.ts`
- Test: `test/flow.test.ts`

**Interfaces:**
- Consumes: `TextElement`, `normalizeSpacing`, `paragraphOptions`, `FlowParagraphOptions` (Task 1).
- Produces:
  - `type FlowHeadingOptions = FlowParagraphOptions` exported from `flow.ts` and re-exported from `index.ts`.
  - `Flow.AddHeading(level: number, text: string, options?: FlowHeadingOptions): this`.
  - internal constant `HEADING_SIZES = [24, 18, 14, 12, 10, 8]`.

- [ ] **Step 1: Write the failing tests**

Append to `test/flow.test.ts`:

```ts
describe('flow headings', () => {
  const opts = () => ({
    format: PageFormat.custom(400, 400), columns: 1,
    marginLeft: 20, marginRight: 20, marginTop: 20, marginBottom: 20,
  });

  function sizeOf(page: import('../src/index.js').Page, needle: string): number {
    return page.GetTextFragments().find((f) => f.text.includes(needle))!.fontSize;
  }

  it('level maps to the default size ramp [24,18,14,12,10,8] in Helvetica-Bold', () => {
    const doc = Document.Open(buildBlankPage());
    const flow = new Flow(doc, opts());
    flow.AddHeading(1, 'H1');
    flow.AddHeading(3, 'H3');
    flow.AddHeading(6, 'H6');
    const [page] = flow.Render();
    expect(sizeOf(page, 'H1')).toBeCloseTo(24, 3);
    expect(sizeOf(page, 'H3')).toBeCloseTo(14, 3);
    expect(sizeOf(page, 'H6')).toBeCloseTo(8, 3);
    // Bold default: rendered width matches Helvetica-Bold, wider than Helvetica.
    const bold = page.MeasureText('H1', 24, 'Helvetica-Bold');
    const reg = page.MeasureText('H1', 24, 'Helvetica');
    expect(bold).not.toBeCloseTo(reg, 1);
  });

  it('explicit fontSize/font override the level defaults', () => {
    const doc = Document.Open(buildBlankPage());
    const flow = new Flow(doc, opts());
    flow.AddHeading(2, 'HH', { fontSize: 15, font: 'Times-Bold' });
    const [page] = flow.Render();
    expect(sizeOf(page, 'HH')).toBeCloseTo(15, 3); // 15, not the ramp's 18
  });

  it('rejects an out-of-range or non-integer level', () => {
    const doc = Document.Open(buildBlankPage());
    const flow = new Flow(doc, opts());
    expect(() => flow.AddHeading(0, 'x')).toThrow(TypeError);
    expect(() => flow.AddHeading(7, 'x')).toThrow(TypeError);
    expect(() => flow.AddHeading(2.5, 'x')).toThrow(TypeError);
  });

  it('is chainable', () => {
    const doc = Document.Open(buildBlankPage());
    const flow = new Flow(doc, opts());
    expect(flow.AddHeading(1, 'x')).toBe(flow);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/flow.test.ts -t "headings"`
Expected: FAIL — `flow.AddHeading is not a function`.

- [ ] **Step 3: Add the `FlowHeadingOptions` type and the size ramp**

In `src/flow.ts`, add after the `FlowParagraphOptions` interface:

```ts
/** Options for {@link Flow.AddHeading}. Identical to {@link FlowParagraphOptions};
 *  the heading `level` (1..6) is the positional argument, not an option. */
export type FlowHeadingOptions = FlowParagraphOptions;

/** Default font size (points) for heading levels 1..6 when `fontSize` is unset. */
const HEADING_SIZES = [24, 18, 14, 12, 10, 8];
```

- [ ] **Step 4: Implement `AddHeading`**

In `src/flow.ts`, add this method to `class Flow` immediately after `AddParagraph`:

```ts
  /** Append a word-wrapped heading. `level` is an integer 1..6, driving a default
   *  font size (24/18/14/12/10/8) and a Helvetica-Bold default, both overridable
   *  via `options`, and (when the flow is tagged) the `/H1`..`/H6` structure type.
   *  Chainable. */
  AddHeading(level: number, text: string, options: FlowHeadingOptions = {}): this {
    if (!Number.isInteger(level) || level < 1 || level > 6)
      throw new TypeError('heading level must be an integer in 1..6');
    const withDefaults: FlowParagraphOptions = {
      ...options,
      font: options.font ?? 'Helvetica-Bold',
      fontSize: options.fontSize ?? HEADING_SIZES[level - 1],
    };
    const { spaceBefore, spaceAfter } = normalizeSpacing(options);
    this.items.push(
      new TextElement(text, paragraphOptions(withDefaults), 'H' + String(level), spaceBefore, spaceAfter),
    );
    return this;
  }
```

- [ ] **Step 5: Export `FlowHeadingOptions` from the package index**

In `src/index.ts`, extend the flow type re-export (currently lines 70-72):

```ts
export type {
  FlowOptions, FlowParagraphOptions, FlowHeadingOptions, FlowElement, PlaceContext, PlaceResult,
} from './flow.js';
```

- [ ] **Step 6: Run the heading tests, the full flow suite, and typecheck**

Run: `npx vitest run test/flow.test.ts && npm run typecheck`
Expected: PASS — headings render at the ramp sizes, overrides win, guards throw, and nothing regressed.

- [ ] **Step 7: Commit**

```bash
git add src/flow.ts src/index.ts test/flow.test.ts
git commit -m "feat(flow): AddHeading with level size-ramp and bold default (db7v.2)"
```

---

## Task 3: Opt-in logical-structure tagging

**Files:**
- Modify: `src/flow.ts`
- Test: `test/flow.test.ts`

**Interfaces:**
- Consumes: `TextElement` (its dormant `structType` and `tag` params from Task 1), `doc.CreateStructTree(): StructTreeRoot`, `StructTreeRoot.Append(type): StructElement`, `StructElement` (from `struct.js`, already imported in Task 1).
- Produces:
  - `FlowOptions` gains `tagged?: boolean` (default `false`).
  - `PlaceContext` gains `structParent?: StructElement`.
  - `Flow` stores `private readonly tagged: boolean`.
  - `TextElement.place` lazily appends its `structType` element under `ctx.structParent` on first placement of non-empty text, reused across continuations.

- [ ] **Step 1: Write the failing tests**

Append to `test/flow.test.ts`:

```ts
describe('flow logical-structure tagging', () => {
  const opts = (tagged: boolean) => ({
    format: PageFormat.custom(400, 500), columns: 1,
    marginLeft: 20, marginRight: 20, marginTop: 20, marginBottom: 20,
    tagged,
  });

  it('tags heading then paragraph as /H2, /P in reading order (round-trip)', () => {
    const doc = Document.Open(buildBlankPage());
    const flow = new Flow(doc, opts(true));
    flow.AddHeading(2, 'The Heading');
    flow.AddParagraph('The body paragraph text.');
    const [page] = flow.Render();

    // BDC/EMC pair emitted around the tagged bodies.
    const content = new TextDecoder('latin1').decode(page.Contents);
    expect(content).toContain('BDC');
    expect(content).toContain('EMC');

    const re = Document.Open(doc.Save());
    const root = re.GetStructTree()!;
    expect(root.GetText()).toContain('The Heading');
    expect(root.GetText()).toContain('The body paragraph text.');
    const rePage = re.Pages[re.Pages.length - 1];
    const spKey = re.resolve(rePage.Dict.get('StructParents')) as number;
    expect(root.ElementFor(spKey, 0)!.Type).toBe('H2');
    expect(root.ElementFor(spKey, 1)!.Type).toBe('P');
  });

  it('untagged flow (default) creates no structure tree and no /StructParents', () => {
    const doc = Document.Open(buildBlankPage());
    const flow = new Flow(doc, opts(false));
    flow.AddHeading(2, 'Heading');
    flow.AddParagraph('Body.');
    const [page] = flow.Render();
    expect(page.Dict.has('StructParents')).toBe(false);
    const re = Document.Open(doc.Save());
    expect(re.GetStructTree()).toBeNull();
  });

  it('a heading spanning a column boundary yields one struct element (MCR)', () => {
    // Force the heading to overflow one column into the next via a 2-column page.
    const doc = Document.Open(buildBlankPage());
    const flow = new Flow(doc, {
      format: PageFormat.custom(360, 140), columns: 2, columnGap: 20,
      marginLeft: 20, marginRight: 20, marginTop: 20, marginBottom: 20,
      tagged: true,
    });
    const many = Array.from({ length: 30 }, (_, i) => `word${i}`).join(' ');
    flow.AddHeading(3, many, { fontSize: 12, leading: 14 });
    flow.Render();
    const root = doc.CreateStructTree(); // reuses the one Render created
    // Exactly one /Sect with exactly one /H3 child, even though it drew on two columns.
    const sect = root.Children.find((c) => c.Type === 'Sect')!;
    const headings = sect.Children.filter((c) => c.Type === 'H3');
    expect(headings.length).toBe(1);
  });

  it('empty text in a tagged flow creates no struct element', () => {
    const doc = Document.Open(buildBlankPage());
    const flow = new Flow(doc, opts(true));
    flow.AddParagraph('');
    flow.AddParagraph('Real text.');
    flow.Render();
    const sect = doc.CreateStructTree().Children.find((c) => c.Type === 'Sect')!;
    // Only the non-empty paragraph produced a /P; the empty one made no node.
    expect(sect.Children.filter((c) => c.Type === 'P').length).toBe(1);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/flow.test.ts -t "tagging"`
Expected: FAIL — `tagged` is ignored; no struct tree is created.

- [ ] **Step 3: Add `tagged` to `FlowOptions`**

In `src/flow.ts`, add to the `FlowOptions` interface (after `paragraphSpacing`, ~line 26):

```ts
  /** Emit logical structure (`/H1`..`/H6`, `/P`) into the document structure tree
   *  on Render. Default false (output is byte-identical to an untagged flow). */
  tagged?: boolean;
```

- [ ] **Step 4: Add `structParent` to `PlaceContext`**

In `src/flow.ts`, extend the `PlaceContext` interface (currently lines 87-94) with:

```ts
  /** When the flow is tagged, the grouping element under which this element
   *  appends its `/Hn` or `/P` on first draw. Absent for an untagged flow. */
  structParent?: StructElement;
```

- [ ] **Step 5: Create/carry the tag in `TextElement.place`**

In `src/flow.ts`, insert the tag-creation step at the top of `TextElement.place`, right after the `availHeight <= 0` guard:

```ts
  place(ctx: PlaceContext): PlaceResult {
    if (ctx.availHeight <= 0) return { usedHeight: 0, remainder: this, drew: false };
    // First placement of non-empty text under a tagged flow: create this element's
    // /Hn or /P node in reading order. Empty text draws nothing, so it never tags
    // (no orphan). flowTextBlock only allocates an MCID when a line actually paints,
    // so an overflow probe that draws nothing here leaves the node childless until
    // it draws in the next column.
    if (this.tag === undefined && ctx.structParent && this.text.length > 0) {
      this.tag = ctx.structParent.Append(this.structType);
    }
    const opts = this.tag ? { ...this.opts, tag: this.tag } : this.opts;
    // ...rest of place() unchanged...
```

(The remainder of `place()` — `rect`, the `flowTextBlock` call, and the two `return`s — stays exactly as written in Task 1.)

- [ ] **Step 6: Store `tagged` on `Flow` and create the `/Sect` in `Render`**

In `src/flow.ts`, add a field and set it in the constructor (currently lines 165-171):

```ts
export class Flow {
  private readonly geometry: Geometry;
  private readonly items: FlowItem[] = [];
  private readonly tagged: boolean;
  private rendered = false;

  constructor(private readonly doc: Document, options?: FlowOptions) {
    this.geometry = normalizeFlowOptions(options);
    if (options?.tagged !== undefined && typeof options.tagged !== 'boolean')
      throw new TypeError('tagged must be a boolean');
    this.tagged = options?.tagged ?? false;
  }
```

In `Render()`, create the grouping element after `ensurePage` is defined and before the `const queue` line:

```ts
    const structParent = this.tagged
      ? this.doc.CreateStructTree().Append('Sect')
      : undefined;
```

Then pass it into the `place` call in the loop — add `structParent` to the context object:

```ts
      const res = item.place({
        doc: this.doc, page,
        x: columnX(g, col), top, width: g.columnWidth,
        availHeight: top - g.contentBottom,
        structParent,
      });
```

- [ ] **Step 7: Run the tagging tests, the full flow suite, and typecheck**

Run: `npx vitest run test/flow.test.ts && npm run typecheck`
Expected: PASS — tagged round-trip resolves `/H2` then `/P`; untagged emits no structure; the spanning heading is one node; empty text makes no node; all earlier tests stay green.

- [ ] **Step 8: Run the struct-write suite (shares the MCR path) as a regression check**

Run: `npx vitest run test/struct-write.test.ts`
Expected: PASS — the tagging reuses the existing MCR/marked-content machinery unchanged.

- [ ] **Step 9: Commit**

```bash
git add src/flow.ts test/flow.test.ts
git commit -m "feat(flow): opt-in logical-structure tagging for headings and paragraphs (db7v.2)"
```

---

## Task 4: Documentation + final gate

**Files:**
- Modify: `README.md`
- (verify) `src/index.ts`, full test suite

**Interfaces:**
- Consumes: the finished public API from Tasks 1-3 (`AddHeading`, `spaceBefore`/`spaceAfter`, `FlowOptions.tagged`, `FlowHeadingOptions`).
- Produces: user-facing docs; no code.

- [ ] **Step 1: Update the Features one-liner**

In `README.md`, replace the Flow-layout Features bullet (line 20) with:

```markdown
- **Flow layout** — `doc.NewFlow({ format, columns, columnGap, margin*, paragraphSpacing, tagged })` builds a multi-column document flow. `flow.AddParagraph(text, options)` adds word-wrapped body text, `flow.AddHeading(level, text, options)` adds a heading (level 1–6 → a default size ramp and Helvetica-Bold, both overridable), and `flow.AddColumnBreak()` forces the next column; both text methods accept per-element `spaceBefore`/`spaceAfter`. `flow.Render()` appends freshly sized pages (`PageFormat.A4`/`Letter`/`Legal`/`custom`, `.landscape()`/`.portrait()`) and auto-paginates across columns and pages; with `tagged: true` it also emits logical structure (`/H1`–`/H6`, `/P`).
```

- [ ] **Step 2: Update the Flow-layout subsection**

In `README.md`, replace the code example and trailing paragraph in the `### Flow layout (doc.NewFlow)` subsection (lines 413-425) with:

```markdown
flow.AddHeading(2, 'Section title');            // 18pt Helvetica-Bold by default
flow.AddParagraph('Body text that word-wraps to the column width…',
                  { font: 'Helvetica', fontSize: 11, leading: 14, spaceAfter: 6 });
flow.AddColumnBreak();
flow.AddParagraph('This starts in the next column.');

const pages = flow.Render(); // fresh pages appended to the document
```

````
`Render()` returns the pages it created. It is single-shot — call it once per
flow. Page size comes from `PageFormat` (`.A4`/`.Letter`/`.Legal`,
`PageFormat.custom(w, h)`, `.landscape()`/`.portrait()`). `AddHeading(level, …)`
takes a level 1–6 that sets a default font size (24/18/14/12/10/8) and a
Helvetica-Bold default, both overridable via the options. `AddParagraph` and
`AddHeading` accept per-element `spaceBefore`/`spaceAfter` (points, additive with
the flow's `paragraphSpacing`, dropped at a column top). Passing
`tagged: true` to `NewFlow` emits logical structure (`/H1`–`/H6` for headings,
`/P` for paragraphs) into the document structure tree; the default is untagged.
Lists, images, and floating boxes are tracked as follow-up work.
````

- [ ] **Step 3: Run the whole suite and typecheck one final time**

Run: `npm run typecheck && npm test`
Expected: PASS — the complete vitest suite and `tsc` are green.

- [ ] **Step 4: Commit**

```bash
git add README.md
git commit -m "docs(flow): document AddHeading, per-element spacing, and tagged flows (db7v.2)"
```

- [ ] **Step 5: Close the issue**

```bash
bd close aspose-pdf-foss-for-ts-db7v.2
```

---

## Self-review

**Spec coverage:**

- Public surface (`AddHeading`, spacing options, `FlowHeadingOptions`) → Tasks 1, 2. ✓
- Heading level semantics (ramp `[24,18,14,12,10,8]`, `Helvetica-Bold` default, `H1..H6` type, level guard) → Task 2 (ramp/default/guard) + Task 3 (type emission). ✓
- Opt-in tagging (`FlowOptions.tagged`, `/Sect`, append-on-first-draw, no orphan on empty text, MCR spanning, byte-identical when off) → Task 3. ✓
- Spacing engine change (additive gap-before-element, dropped at column top, reduces to today's behavior when unset, continuation carries `spaceBefore = 0`) → Task 1. ✓
- Implementation shape (`TextElement` with `structType`/`tag`, `FlowElement.spaceBefore/After`, `PlaceContext.structParent`) → Tasks 1, 3. ✓
- Testing list (ramp, override, guard, spacing shift+drop+validation, tagged round-trip, untagged no-structure, spanning heading) → Tasks 1-3 tests. ✓
- Docs (README) → Task 4. ✓
- Follow-up (keep-with-next db7v.6) → already filed before planning. ✓

**Placeholder scan:** No TBD/TODO/"handle edge cases"; every code step shows full code. ✓

**Type consistency:** `TextElement` constructor `(text, opts, structType, spaceBefore, spaceAfter, tag?)` is used identically in `makeParagraph`, `AddParagraph` (Task 1), `AddHeading` (Task 2), and the continuation inside `place` (Task 1). `normalizeSpacing` returns `{ spaceBefore, spaceAfter }` and is called the same way in all three constructors. `FlowHeadingOptions` (Task 2) aliases `FlowParagraphOptions` (Task 1). `PlaceContext.structParent` (Task 3) is read in `place` (Task 1's class, extended in Task 3) and written in `Render` (Task 3). ✓

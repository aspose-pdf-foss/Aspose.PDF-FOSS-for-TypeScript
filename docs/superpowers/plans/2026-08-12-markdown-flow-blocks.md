# Markdown-to-Flow Blocks Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn a parsed `MdDocument` into laid-out PDF pages, through a Flow, into a rect on a page, or in one call on a document.

**Architecture:** Three pure layers (`mdstyle.ts` → `mdruns.ts` → `mdflow.ts`) lower the AST to a flat `FlowElement[]`. Flow's engine and a new rect placer both consume that array, so three entry points cost one implementation. Containers (quote, list item) never paginate their own children — they lower to flat decorated elements. Flow gains the three block types it lacks: code block, block quote, thematic break.

**Tech Stack:** TypeScript (strict, ESM/NodeNext), vitest, zero runtime dependencies.

**Spec:** [docs/superpowers/specs/2026-08-12-markdown-flow-blocks-design.md](../specs/2026-08-12-markdown-flow-blocks-design.md)

## Global Constraints

- **Zero runtime dependencies.** Only `node:` built-ins. Never add an npm runtime dep.
- **ESM + NodeNext.** Every relative import specifier carries the `.js` extension (`import { Page } from './page.js'`).
- **Strict TypeScript.** `npm run typecheck` must be clean before any commit.
- **Full suite green.** `npm test` must pass before any commit.
- **Byte-identity.** Every existing caller of `AddParagraph`/`AddHeading`/`AddList`/`AddImage`/`AddTextBlock` must emit unchanged content-stream bytes. `test/rich-runs-identity.test.ts` is the fence.
- **Errors** are `TypeError` for argument validation; `PdfParseError` / `UnsupportedFeatureError` / `InvalidPasswordError` (from `errors.ts`) are the public PDF error types. A rejected call must leave the document byte-identical — validate everything before allocating anything.
- **Task tracking is `bd`**, not TodoWrite or markdown TODO lists. Issue: `aspose-pdf-foss-for-ts-gl6o.3.2`.
- **Commit messages** end with `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`.
- **One refinement on the spec**, deliberate: `markdownElements` takes no `Document`. `buildImageXObject(data, format)` needs none, so the mapper is fully pure and testable without building a file. The spec's signature said `(doc, src, options)`; the plan uses `(src, options)`.

---

## Phase 1 — the Flow block vocabulary (Tasks 1-10)

Lands as its own commit. It is a refactor of code every existing caller runs, plus new elements that nothing yet calls. The byte-identity fence goes in first and must stay green through all of it.

### Task 1: Extend the byte-identity fence to lists

**Files:**
- Modify: `test/rich-runs-identity.test.ts:24-105`

The fence currently covers one nested list inside `flow-paragraph-heading-list`. Tasks 3 and 8 rewrite the list flattener and the marker-drawing path, so the fence needs cases that would actually move if those went wrong.

**Interfaces:**
- Produces: nothing consumed by later tasks. This is a regression fence.

- [ ] **Step 1: Add three list cases to `CASES`**

Insert after the `'flow-paragraph-heading-list'` entry, before `'table-cell'`:

```ts
  // gl6o.3.2 rewrites the list flattener (FlowListItem.blocks) and the
  // marker-drawing path (a shared marker holder). These three cases are what
  // would move if either went wrong: a deep nest exercises the per-depth
  // cumulative indent, per-item styles exercise resolveItemOptions' fast path,
  // and a paginating item exercises the body-only continuation that must NOT
  // redraw its marker.
  'flow-list-deep-nested': () => {
    const doc = Document.New();
    const flow = doc.NewFlow({ format: PageFormat.A4 });
    flow.AddList([
      { text: 'level one alpha', items: [
        { text: 'level two alpha', items: ['level three alpha', 'level three beta'] },
        'level two beta',
      ] },
      { text: 'level one beta', items: ['level two gamma'] },
    ]);
    return flow.Render()[0];
  },
  'flow-list-styled-items': () => {
    const doc = Document.New();
    const flow = doc.NewFlow({ format: PageFormat.A4 });
    flow.AddList([
      'plain item',
      { text: 'bold item', font: 'Helvetica-Bold' },
      { text: 'big item', fontSize: 16, color: [0.2, 0.3, 0.9] },
      { text: 'decorated item', underline: true, background: [0.95, 0.95, 0.8] },
    ], { ordered: true, start: 3, itemSpacing: 4 });
    return flow.Render()[0];
  },
  'flow-list-item-paginates': () => {
    const doc = Document.New();
    // A short column forces one item's body to split; the marker must be drawn
    // once, on the first fragment only.
    const flow = doc.NewFlow({ format: PageFormat.A4, columns: 2, marginTop: 700 });
    flow.AddList([LOREM, LOREM]);
    return flow.Render()[0];
  },
```

- [ ] **Step 2: Add the three keys to `EXPECTED` with placeholder hashes**

```ts
  'flow-list-deep-nested': 'RECORD',
  'flow-list-styled-items': 'RECORD',
  'flow-list-item-paginates': 'RECORD',
```

- [ ] **Step 3: Run to read the real hashes**

Run: `npx vitest run test/rich-runs-identity.test.ts`

Expected: the three new cases FAIL, each reporting `expected 'RECORD' to be '<16 hex chars>'`. The eight existing cases PASS — if any of those moved, stop: the working tree is not clean and nothing below is trustworthy.

- [ ] **Step 4: Replace each `'RECORD'` with the hash the run reported**

Copy each 16-character hash from the failure output into its `EXPECTED` entry.

- [ ] **Step 5: Run to verify all eleven pass**

Run: `npx vitest run test/rich-runs-identity.test.ts`
Expected: PASS, 12 tests (11 cases + the key-coverage test).

- [ ] **Step 6: Prove the new cases are load-bearing**

Temporarily change `markerGap: 0.5 * fontSize` to `0.51 * fontSize` in `src/flow.ts` (in `normalizeListOptions`, around line 474).

Run: `npx vitest run test/rich-runs-identity.test.ts`
Expected: FAIL on `flow-list-deep-nested`, `flow-list-styled-items` and `flow-paragraph-heading-list`.

Revert the change. Re-run. Expected: PASS. A fence that has never been seen red is not a fence.

- [ ] **Step 7: Commit**

```bash
git add test/rich-runs-identity.test.ts
git commit -m "$(cat <<'EOF'
test(flow): extend the byte-identity fence to nested, styled and paginating lists

gl6o.3.2 rewrites the list flattener and the marker-drawing path. Recorded
from the implementation as it stands before that work, and confirmed red on a
0.01em nudge to markerGap.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Extract `flowelement.ts`

**Files:**
- Create: `src/flowelement.ts`
- Modify: `src/flow.ts:1-27` (imports), `:23-24` (`FlowClear`), `:69-74` (`nonNegative`), `:112-162` (the protocol), `:236-249` (`normalizeClear`, `normalizeSpacing`)

`flowblock.ts` (Task 5) needs the `FlowElement` protocol and the shared validators. Importing them from `flow.ts` while `flow.ts` imports the builders back would close a runtime cycle — the thing `fieldstyle.ts` and `bordersides.ts` were each split out to avoid. The protocol moves to a module that imports nothing from either.

**Interfaces:**
- Produces: `src/flowelement.ts` exporting `FlowClear`, `MeasureContext`, `PlaceContext`, `PlaceResult`, `FlowElement`, `nonNegative(v, dflt, name)`, `normalizeClear(v)`, `normalizeSpacing(o)`. `flow.ts` re-exports every one of them, so no existing import path changes.

- [ ] **Step 1: Create `src/flowelement.ts`**

```ts
/** The Flow element protocol, and the argument validators every element shares.
 *
 *  Its own module so that flowblock.ts can implement the protocol without
 *  importing flow.ts, which imports flowblock.ts back for the builders. This
 *  file imports nothing from either — the same split fieldstyle.ts and
 *  bordersides.ts already make. */

import type { Document } from './document.js';
import type { Page } from './page.js';
import type { StructElement } from './struct.js';
import type { ClearSide } from './floatstack.js';

/** Which side's floats an element must clear before it places. */
export type FlowClear = ClearSide;

/** Inputs for a non-destructive {@link FlowElement.measure}. @internal */
export interface MeasureContext {
  width: number;
  availHeight: number;
}

/** Where an element is being placed. `top` is the current column pen (PDF user
 *  space, decreasing downward); `availHeight = top - contentBottom`. @internal */
export interface PlaceContext {
  doc: Document;
  page: Page;
  x: number;
  top: number;
  width: number;
  availHeight: number;
  /** The gap the engine inserts between two consecutive elements, over and above
   *  their own `spaceAfter`/`spaceBefore`. A decorating element that must paint
   *  across that gap (a quote bar) cannot otherwise know it. Optional: a caller
   *  that inserts no such gap may omit it, and an element must read it as 0. */
  paragraphSpacing?: number;
  /** When the flow is tagged, the grouping element under which this element
   *  appends its `/Hn` or `/P` on first draw. Absent for an untagged flow. */
  structParent?: StructElement;
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

/** A unit of flow content. */
export interface FlowElement {
  place(ctx: PlaceContext): PlaceResult;
  /** Non-destructive dry-run of {@link place}: predict the vertical space the
   *  element would consume and whether it fully fits, without drawing. */
  measure?(ctx: MeasureContext): { usedHeight: number; fits: boolean };
  /** True only for headings — the elements eligible for keep-with-next. */
  readonly keepWithNextEligible?: boolean;
  /** Per-element override of the flow keep-with-next policy; `undefined` inherits
   *  the flow default. Meaningful only when {@link keepWithNextEligible}. */
  readonly keepWithNext?: boolean;
  /** Points to reserve above this element; treated as 0 when absent. */
  readonly spaceBefore?: number;
  /** Points to reserve below this element; treated as 0 when absent. */
  readonly spaceAfter?: number;
  /** Side(s) whose floats this element clears before placing; treated as none
   *  when absent. Continuations never carry it. */
  readonly clear?: FlowClear;
}

/** Validate an optional non-negative finite number, defaulting when absent.
 *  @internal */
export function nonNegative(v: number | undefined, dflt: number, name: string): number {
  const n = v ?? dflt;
  if (!Number.isFinite(n) || n < 0)
    throw new TypeError(`${name} must be a non-negative finite number`);
  return n;
}

/** Validate an optional `clear` option. @internal */
export function normalizeClear(v: FlowClear | undefined): FlowClear | undefined {
  if (v === undefined) return undefined;
  if (v !== 'left' && v !== 'right' && v !== 'both')
    throw new TypeError("clear must be 'left', 'right', or 'both'");
  return v;
}

/** Validate the two spacing options every block-level element accepts. @internal */
export function normalizeSpacing(
  o: { spaceBefore?: number; spaceAfter?: number },
): { spaceBefore: number; spaceAfter: number } {
  return {
    spaceBefore: nonNegative(o.spaceBefore, 0, 'spaceBefore'),
    spaceAfter: nonNegative(o.spaceAfter, 0, 'spaceAfter'),
  };
}
```

- [ ] **Step 2: Delete the moved declarations from `src/flow.ts`**

Delete these, and only these:
- `export type FlowClear = ClearSide;` and its doc comment (around line 23-24)
- `function nonNegative(...)` (around line 69-74)
- `export interface MeasureContext`, `PlaceContext`, `PlaceResult`, `FlowElement` and their doc comments (around line 112-162)
- `function normalizeClear(...)` and `function normalizeSpacing(...)` (around line 236-249)

- [ ] **Step 3: Import and re-export them in `src/flow.ts`**

Add below the existing imports:

```ts
import {
  nonNegative, normalizeClear, normalizeSpacing,
  type FlowClear, type FlowElement, type MeasureContext, type PlaceContext, type PlaceResult,
} from './flowelement.js';

export type {
  FlowClear, FlowElement, MeasureContext, PlaceContext, PlaceResult,
} from './flowelement.js';
```

Remove `type ClearSide` from the `./floatstack.js` import if it is now unused there.

- [ ] **Step 4: Typecheck**

Run: `npm run typecheck`
Expected: clean. Any error names a declaration that did not move cleanly.

- [ ] **Step 5: Run the fence and the flow suite**

Run: `npx vitest run test/rich-runs-identity.test.ts test/flow.test.ts`
Expected: PASS. This is a pure move — one byte of output change means something else changed too.

- [ ] **Step 6: Run the full suite**

Run: `npm test`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/flowelement.ts src/flow.ts
git commit -m "$(cat <<'EOF'
refactor(flow): extract the element protocol into flowelement.ts

flowblock.ts will implement FlowElement while flow.ts imports its builders
back; the protocol moves to a module neither depends on so that closes no
cycle. flow.ts re-exports every moved name, so no import path changes.

PlaceContext gains an optional paragraphSpacing: a decorating element that
paints across the inter-element gap cannot otherwise know how wide it is.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: Public element builders

**Files:**
- Modify: `src/flow.ts:302-307` (`makeParagraph`), `:762-765` (`makeList`), `:907-910` (`makeImage`), `:944-994` (the `Add*` methods)
- Modify: `test/flow.test.ts:2` and every `make*` call site

Three entry points and a mapper all construct content. One definition per construct is what stops `Flow.AddList` and `Page.AddMarkdown` from disagreeing about what a list is.

**Interfaces:**
- Consumes: `FlowElement` from Task 2.
- Produces, all from `src/flow.ts`:
  - `paragraph(text: FlowText, options?: FlowParagraphOptions): FlowElement[]`
  - `heading(level: number, text: FlowText, options?: FlowHeadingOptions): FlowElement[]`
  - `list(items: FlowListNode[], options?: FlowListOptions): FlowElement[]`
  - `image(data: Uint8Array, options?: FlowImageOptions): FlowElement[]`

  Every builder returns an array, uniformly, because `list` and `quote` lower to several and a caller composing `blocks` should not have to remember which is which.

- [ ] **Step 1: Write the failing test**

Add to `test/flow.test.ts`:

```ts
describe('element builders', () => {
  it('every builder returns an array of elements', () => {
    expect(paragraph('hi')).toHaveLength(1);
    expect(heading(2, 'hi')).toHaveLength(1);
    expect(list(['a', 'b'])).toHaveLength(2);
    expect(image(buildPngRgb())).toHaveLength(1);
  });

  it('heading applies the level default size and bold face', () => {
    // 24pt is HEADING_SIZES[0]; a 1-line H1 consumes 1.2 * 24 of leading.
    const [h1] = heading(1, 'Title');
    expect(h1.measure!({ width: 400, availHeight: 400 }).usedHeight).toBeCloseTo(28.8, 6);
    const [h3] = heading(3, 'Title');
    expect(h3.measure!({ width: 400, availHeight: 400 }).usedHeight).toBeCloseTo(16.8, 6);
  });

  it('heading rejects an out-of-range level before building anything', () => {
    expect(() => heading(0, 'x')).toThrow(TypeError);
    expect(() => heading(7, 'x')).toThrow(TypeError);
    expect(() => heading(1.5, 'x')).toThrow(TypeError);
  });

  it('AddHeading and heading() produce the same bytes', () => {
    const viaMethod = (() => {
      const doc = Document.New();
      const flow = doc.NewFlow({ format: PageFormat.A4 });
      flow.AddHeading(2, 'Same Title');
      return flow.Render()[0].Contents;
    })();
    const viaBuilder = (() => {
      const doc = Document.New();
      const flow = doc.NewFlow({ format: PageFormat.A4 });
      for (const el of heading(2, 'Same Title')) (flow as any).items.push(el);
      return flow.Render()[0].Contents;
    })();
    expect(Buffer.from(viaBuilder).equals(Buffer.from(viaMethod))).toBe(true);
  });
});
```

Update the import on line 2 to:

```ts
import { PageFormat, normalizeFlowOptions, columnX, paragraph, heading, list, image, Flow } from '../src/flow.js';
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/flow.test.ts`
Expected: FAIL — `paragraph`, `heading`, `list`, `image` are not exported.

- [ ] **Step 3: Rename and add the builders in `src/flow.ts`**

Replace `makeParagraph` (around line 302):

```ts
/** Build a word-wrapped paragraph element. The builder behind
 *  {@link Flow.AddParagraph}; use it to compose the `blocks` of a list item or
 *  the contents of a {@link quote}. */
export function paragraph(text: FlowText, o: FlowParagraphOptions = {}): FlowElement[] {
  const { spaceBefore, spaceAfter } = normalizeSpacing(o);
  return [new TextElement(text, paragraphOptions(o), 'P', spaceBefore, spaceAfter,
    undefined, false, undefined, normalizeClear(o.clear))];
}

/** Build a word-wrapped heading element. `level` is an integer 1..6, driving a
 *  default font size (24/18/14/12/10/8) and a Helvetica-Bold default, both
 *  overridable, and (when the flow is tagged) the `/H1`..`/H6` structure type.
 *  The builder behind {@link Flow.AddHeading}. */
export function heading(level: number, text: FlowText, o: FlowHeadingOptions = {}): FlowElement[] {
  if (!Number.isInteger(level) || level < 1 || level > 6)
    throw new TypeError('heading level must be an integer in 1..6');
  if (o.keepWithNext !== undefined && typeof o.keepWithNext !== 'boolean')
    throw new TypeError('keepWithNext must be a boolean');
  const withDefaults: FlowParagraphOptions = {
    ...o,
    font: o.font ?? 'Helvetica-Bold',
    fontSize: o.fontSize ?? HEADING_SIZES[level - 1],
  };
  const { spaceBefore, spaceAfter } = normalizeSpacing(o);
  return [new TextElement(text, paragraphOptions(withDefaults), 'H' + String(level),
    spaceBefore, spaceAfter, undefined, true, o.keepWithNext, normalizeClear(o.clear))];
}
```

Replace `makeList` (around line 762):

```ts
/** Build the elements of a bullet or numbered list. The builder behind
 *  {@link Flow.AddList}. */
export function list(items: FlowListNode[], options: FlowListOptions = {}): FlowElement[] {
  return buildListElements(items, options);
}
```

Replace `makeImage` (around line 907):

```ts
/** Build a raster image element (JPEG/PNG). The builder behind
 *  {@link Flow.AddImage}. */
export function image(data: Uint8Array, options: FlowImageOptions = {}): FlowElement[] {
  return [buildImageElement(data, options)];
}
```

- [ ] **Step 4: Make the `Add*` methods delegate**

Replace the bodies of `AddParagraph`, `AddHeading`, `AddList` and `AddImage` (around lines 944-994), keeping their doc comments exactly as they are:

```ts
  AddParagraph(text: FlowText, options: FlowParagraphOptions = {}): this {
    this.items.push(...paragraph(text, options));
    return this;
  }

  AddHeading(level: number, text: FlowText, options: FlowHeadingOptions = {}): this {
    this.items.push(...heading(level, text, options));
    return this;
  }

  AddList(items: FlowListNode[], options: FlowListOptions = {}): this {
    this.items.push(...list(items, options));
    return this;
  }

  AddImage(data: Uint8Array, options: FlowImageOptions = {}): this {
    this.items.push(...image(data, options));
    return this;
  }
```

- [ ] **Step 5: Update the remaining `make*` call sites in `test/flow.test.ts`**

`makeList` and `makeImage` already read as arrays or single values at their call sites; adjust each:
- `makeParagraph(x, o)` → `paragraph(x, o)[0]`, except where the result is immediately destructured.
- `makeList(...)` → `list(...)` (already returns an array; destructuring is unchanged).
- `makeImage(x, o)` → `image(x, o)[0]`.

Run `grep -n "make\(Paragraph\|List\|Image\)" test/flow.test.ts` to confirm none remain.

- [ ] **Step 6: Run the tests**

Run: `npx vitest run test/flow.test.ts test/rich-runs-identity.test.ts`
Expected: PASS. The `AddHeading`-versus-`heading()` byte comparison is the assertion that the delegation is real and not a second implementation.

- [ ] **Step 7: Run the full suite and typecheck**

Run: `npm run typecheck && npm test`
Expected: both clean.

- [ ] **Step 8: Commit**

```bash
git add src/flow.ts test/flow.test.ts
git commit -m "$(cat <<'EOF'
feat(flow): promote the element factories to public builders

paragraph/heading/list/image replace the test-only makeParagraph/makeList/
makeImage, each returning FlowElement[] uniformly. Every Flow.AddX now
delegates to its builder, so three entry points and the Markdown mapper share
one definition per construct rather than one per caller.

Asserted on bytes: AddHeading and heading() emit an identical page.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: Thread `paragraphSpacing` through `Flow.Render`

**Files:**
- Modify: `src/flow.ts:1178-1181` (the `item.place({...})` call in `Render`)

The field exists on `PlaceContext` from Task 2; nothing sets it yet. The quote bar in Task 7 reads it.

**Interfaces:**
- Consumes: `PlaceContext.paragraphSpacing` from Task 2.
- Produces: `Flow.Render` supplies `g.paragraphSpacing` on every `place` call.

- [ ] **Step 1: Write the failing test**

Add to `test/flow.test.ts`:

```ts
describe('PlaceContext.paragraphSpacing', () => {
  it('Render reports the flow gap to every element it places', () => {
    const seen: (number | undefined)[] = [];
    const probe = {
      place(ctx: import('../src/flowelement.js').PlaceContext) {
        seen.push(ctx.paragraphSpacing);
        return { usedHeight: 10, remainder: null, drew: true };
      },
    };
    const doc = Document.New();
    const flow = doc.NewFlow({ format: PageFormat.A4, paragraphSpacing: 7 });
    (flow as any).items.push(probe, probe);
    flow.Render();
    expect(seen).toEqual([7, 7]);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/flow.test.ts -t paragraphSpacing`
Expected: FAIL — `expected [ undefined, undefined ] to deeply equal [ 7, 7 ]`.

- [ ] **Step 3: Set the field**

In `Render`, change the `place` call (around line 1179) to:

```ts
      const res = item.place({
        doc: this.doc, page, x: elemX, top, width: elemWidth, availHeight,
        paragraphSpacing: g.paragraphSpacing, structParent,
      });
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run test/flow.test.ts -t paragraphSpacing`
Expected: PASS.

- [ ] **Step 5: Run the fence**

Run: `npx vitest run test/rich-runs-identity.test.ts`
Expected: PASS. Adding a field no existing element reads must move no bytes.

- [ ] **Step 6: Commit**

```bash
git add src/flow.ts test/flow.test.ts
git commit -m "$(cat <<'EOF'
feat(flow): report paragraphSpacing to placed elements

The engine knows the gap it is about to insert; a decorating element that
paints across that gap (the quote bar) cannot derive it. No existing element
reads the field, so output is unchanged.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: `flowblock.ts` — the thematic break

**Files:**
- Create: `src/flowblock.ts`
- Create: `test/flow-blocks.test.ts`
- Modify: `src/flow.ts` (import `rule`, add `Flow.AddRule`)

The first of the three blocks Flow lacks, and the one that establishes the module.

**Interfaces:**
- Consumes: `FlowElement`, `PlaceContext`, `PlaceResult`, `MeasureContext`, `normalizeSpacing`, `normalizeClear`, `nonNegative` from `flowelement.ts` (Task 2).
- Produces, from `src/flowblock.ts`:
  - `interface FlowRuleOptions { thickness?, color?, width?, align?, spaceBefore?, spaceAfter?, clear? }`
  - `rule(options?: FlowRuleOptions): FlowElement[]`

  And `Flow.AddRule(options?: FlowRuleOptions): this`.

- [ ] **Step 1: Write the failing test**

Create `test/flow-blocks.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { PageFormat } from '../src/pageformat.js';
import { rule } from '../src/flowblock.js';

/** A page's content stream as latin1 text, for operator assertions. */
const cs = (page: { Contents: Uint8Array }): string =>
  new TextDecoder('latin1').decode(page.Contents);

describe('rule', () => {
  it('consumes exactly its thickness and paints a filled rect', () => {
    const doc = Document.New();
    const { page } = doc.AddPage(PageFormat.A4);
    const [el] = rule({ thickness: 2, color: [0, 0, 0] });
    const res = el.place({ doc, page, x: 20, top: 400, width: 200, availHeight: 300 });
    expect(res.drew).toBe(true);
    expect(res.remainder).toBeNull();
    expect(res.usedHeight).toBeCloseTo(2, 6);
    // The rect sits with its top at the pen: y = 400 - 2.
    expect(cs(page)).toMatch(/20 398 200 2 re/);
  });

  it('defaults to the full region width, and honours an explicit width + align', () => {
    const doc = Document.New();
    const { page } = doc.AddPage(PageFormat.A4);
    const [el] = rule({ thickness: 1, width: 50, align: 'center' });
    el.place({ doc, page, x: 100, top: 400, width: 200, availHeight: 300 });
    // centred in [100, 300): 100 + (200 - 50) / 2 = 175
    expect(cs(page)).toMatch(/175 399 50 1 re/);
  });

  it('does not draw when the remaining height is too small, and retries whole', () => {
    const doc = Document.New();
    const { page } = doc.AddPage(PageFormat.A4);
    const [el] = rule({ thickness: 4 });
    const res = el.place({ doc, page, x: 20, top: 400, width: 200, availHeight: 2 });
    expect(res.drew).toBe(false);
    expect(res.remainder).toBe(el);
    expect(cs(page)).toBe('');
  });

  it('measures the same height it places', () => {
    const [el] = rule({ thickness: 3 });
    expect(el.measure!({ width: 200, availHeight: 300 })).toEqual({ usedHeight: 3, fits: true });
    expect(el.measure!({ width: 200, availHeight: 1 })).toEqual({ usedHeight: 0, fits: false });
  });

  it('validates before building anything', () => {
    expect(() => rule({ thickness: -1 })).toThrow(TypeError);
    expect(() => rule({ thickness: 0 })).toThrow(TypeError);
    expect(() => rule({ width: 0 })).toThrow(TypeError);
    expect(() => rule({ color: [2, 0, 0] })).toThrow(TypeError);
    expect(() => rule({ align: 'middle' as any })).toThrow(TypeError);
    expect(() => rule({ spaceBefore: -1 })).toThrow(TypeError);
  });

  it('Flow.AddRule is chainable and draws through the engine', () => {
    const doc = Document.New();
    const flow = doc.NewFlow({ format: PageFormat.A4 });
    expect(flow.AddParagraph('above').AddRule({ thickness: 1 }).AddParagraph('below')).toBe(flow);
    const page = flow.Render()[0];
    expect(cs(page)).toMatch(/ 1 re\nf\n/);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/flow-blocks.test.ts`
Expected: FAIL — cannot resolve `../src/flowblock.js`.

- [ ] **Step 3: Create `src/flowblock.ts`**

```ts
/** The three block-level Flow elements Markdown needs and Flow lacked: a
 *  thematic break, a preformatted code block, and a block quote.
 *
 *  Its own module because flow.ts is already large and because these three
 *  implement the protocol rather than owning the engine. It imports the
 *  protocol from flowelement.ts, never from flow.ts, so flow.ts importing the
 *  builders back closes no cycle. */

import {
  nonNegative, normalizeClear, normalizeSpacing,
  type FlowClear, type FlowElement, type MeasureContext, type PlaceContext, type PlaceResult,
} from './flowelement.js';
import { num, appendContent, wrapArtifact } from './pagecontent.js';
import { enc } from './serialize.js';

/** Validate an RGB triple in 0..1. */
function checkColor(label: string, c: unknown): [number, number, number] {
  if (!Array.isArray(c) || c.length !== 3
      || !c.every((n) => typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= 1))
    throw new TypeError(`${label} must be [r, g, b] with each component in 0..1`);
  return c as [number, number, number];
}

/** Validate an optional strictly-positive finite number. */
function positive(v: number | undefined, dflt: number, name: string): number {
  const n = v ?? dflt;
  if (!Number.isFinite(n) || n <= 0)
    throw new TypeError(`${name} must be a positive finite number`);
  return n;
}

/** Operators for a filled rectangle in its own q/Q, so the fill colour cannot
 *  leak into whatever the page draws next. */
function fillRect(
  x: number, y: number, w: number, h: number, color: [number, number, number],
): Uint8Array {
  return enc(`q\n${num(color[0])} ${num(color[1])} ${num(color[2])} rg\n`
    + `${num(x)} ${num(y)} ${num(w)} ${num(h)} re\nf\nQ`);
}

/** Paint `body` on the page, marked as an /Artifact when the flow is tagged.
 *  A rule, a code-block fill and a quote bar are all decoration: they carry no
 *  meaning a screen reader should announce, and in a tagged document every
 *  piece of content must be either tagged or artifacted. */
function paintDecoration(ctx: PlaceContext, body: Uint8Array): void {
  appendContent(ctx.doc, ctx.page, ctx.structParent ? wrapArtifact(body) : body);
}

/** Options for {@link rule} / {@link Flow.AddRule}. Lengths in points. */
export interface FlowRuleOptions {
  /** Rule thickness. > 0. Default 0.5. */
  thickness?: number;
  /** Rule colour (RGB 0..1). Default a mid grey. */
  color?: [number, number, number];
  /** Rule width. > 0. Default: the full region width. */
  width?: number;
  /** Horizontal placement of an explicit `width` within the region. Default 'left'. */
  align?: 'left' | 'center' | 'right';
  /** Points inserted above the rule (dropped at a column top). >= 0. Default 0. */
  spaceBefore?: number;
  /** Points inserted below the rule (dropped at a column top). >= 0. Default 0. */
  spaceAfter?: number;
  /** Drop the rule below the floats on the given side(s) before placing it. */
  clear?: FlowClear;
}

const RULE_COLOR: [number, number, number] = [0.6, 0.6, 0.6];

/** A horizontal rule. Atomic: it either fits in what is left of the column or
 *  moves whole to the next. @internal */
class RuleElement implements FlowElement {
  constructor(
    private readonly thickness: number,
    private readonly color: [number, number, number],
    private readonly reqWidth: number | undefined,
    private readonly align: 'left' | 'center' | 'right',
    readonly spaceBefore: number,
    readonly spaceAfter: number,
    readonly clear?: FlowClear,
  ) {}

  /** Drawn width and its x offset for a given region width. */
  private geometry(regionWidth: number): { w: number; dx: number } {
    const w = Math.min(this.reqWidth ?? regionWidth, regionWidth);
    const dx = this.align === 'center' ? (regionWidth - w) / 2
      : this.align === 'right' ? regionWidth - w : 0;
    return { w, dx };
  }

  measure(ctx: MeasureContext): { usedHeight: number; fits: boolean } {
    return this.thickness <= ctx.availHeight + 1e-9
      ? { usedHeight: this.thickness, fits: true }
      : { usedHeight: 0, fits: false };
  }

  place(ctx: PlaceContext): PlaceResult {
    if (this.thickness > ctx.availHeight + 1e-9)
      return { usedHeight: 0, remainder: this, drew: false };
    const { w, dx } = this.geometry(ctx.width);
    paintDecoration(ctx,
      fillRect(ctx.x + dx, ctx.top - this.thickness, w, this.thickness, this.color));
    return { usedHeight: this.thickness, remainder: null, drew: true };
  }
}

/** Build a horizontal rule element — Markdown's thematic break, and a section
 *  divider for any hand-built flow. The builder behind {@link Flow.AddRule}. */
export function rule(options: FlowRuleOptions = {}): FlowElement[] {
  const thickness = positive(options.thickness, 0.5, 'thickness');
  const color = options.color === undefined ? RULE_COLOR : checkColor('color', options.color);
  const width = options.width === undefined ? undefined : positive(options.width, 1, 'width');
  const align = options.align ?? 'left';
  if (align !== 'left' && align !== 'center' && align !== 'right')
    throw new TypeError("align must be 'left', 'center', or 'right'");
  const { spaceBefore, spaceAfter } = normalizeSpacing(options);
  return [new RuleElement(thickness, color, width, align, spaceBefore, spaceAfter,
    normalizeClear(options.clear))];
}
```

- [ ] **Step 4: Add `Flow.AddRule`**

In `src/flow.ts`, add to the imports:

```ts
import { rule, type FlowRuleOptions } from './flowblock.js';

export { rule } from './flowblock.js';
export type { FlowRuleOptions } from './flowblock.js';
```

And add the method after `AddImage`:

```ts
  /** Append a horizontal rule — a section divider, and Markdown's thematic
   *  break. Atomic: it never splits across a column. Chainable. */
  AddRule(options: FlowRuleOptions = {}): this {
    this.items.push(...rule(options));
    return this;
  }
```

- [ ] **Step 5: Run to verify it passes**

Run: `npx vitest run test/flow-blocks.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 6: Typecheck and run the fence**

Run: `npm run typecheck && npx vitest run test/rich-runs-identity.test.ts`
Expected: both clean — a new element nothing calls moves no bytes.

- [ ] **Step 7: Commit**

```bash
git add src/flowblock.ts src/flow.ts test/flow-blocks.test.ts
git commit -m "$(cat <<'EOF'
feat(flow): thematic break (Flow.AddRule) in a new flowblock.ts

The first of the three block types Markdown needs and Flow lacked. Atomic,
artifacted under a tagged flow, and validated before anything is built.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: `flowblock.ts` — the code block

**Files:**
- Modify: `src/flowblock.ts` (append)
- Modify: `test/flow-blocks.test.ts` (append)
- Modify: `src/flow.ts` (import `codeBlock`, add `Flow.AddCodeBlock`)

`layoutRuns` collapses runs of spaces (`a  b` lays out as `a b`) — a documented invariant of the one wrapping engine, load-bearing for every existing caller's byte-identity, and fatal to code indentation. The block substitutes U+00A0, which encodes to WinAnsi `0xA0` (named `/space` in Annex D Table D.2) and carries the identical AFM advance: 278 in Helvetica, 600 in Courier.

**Interfaces:**
- Consumes: `flowTextBlock`, `measureTextBlock`, `TextBlockOptions`, `AuthoringFont` from `stamp.ts`.
- Produces, from `src/flowblock.ts`:
  - `interface FlowCodeOptions { font?, fontSize?, color?, leading?, background?, padding?, tabWidth?, spaceBefore?, spaceAfter?, clear? }`
  - `codeBlock(text: string, options?: FlowCodeOptions): FlowElement[]`
  - `preformat(text: string, tabWidth: number): string` — exported for the test that pins the substitution.

  And `Flow.AddCodeBlock(text: string, options?: FlowCodeOptions): this`.

- [ ] **Step 1: Write the failing test**

Append to `test/flow-blocks.test.ts`:

```ts
import { codeBlock, preformat } from '../src/flowblock.js';
import { encodeWinAnsi } from '../src/encoding.js';
import { measure } from '../src/metrics.js';

describe('preformat', () => {
  it('substitutes U+00A0 for every space', () => {
    expect(preformat('a  b', 4)).toBe('a  b');
    expect(preformat('  indented', 4)).toBe('  indented');
  });

  it('expands tabs to the next multiple of tabWidth, per line', () => {
    expect(preformat('a\tb', 4)).toBe('a   b');   // col 1 -> col 4
    expect(preformat('ab\tc', 4)).toBe('ab  c');       // col 2 -> col 4
    expect(preformat('abcd\te', 4)).toBe('abcd    e'); // col 4 -> col 8
    // The column counter restarts on each line.
    expect(preformat('ab\n\tc', 4)).toBe('ab\n    c');
  });

  // This is the load-bearing fact the whole approach rests on, so it is asserted
  // against the tables rather than assumed from the code that reads them.
  it('U+00A0 encodes to WinAnsi 0xA0 and advances exactly like a space', () => {
    expect(Array.from(encodeWinAnsi(' '))).toEqual([0xa0]);
    for (const font of ['Helvetica', 'Courier', 'Times-Roman'] as const) {
      expect(measure(font, encodeWinAnsi(' '), 10))
        .toBe(measure(font, encodeWinAnsi(' '), 10));
    }
  });
});

describe('codeBlock', () => {
  it('preserves indentation through a real render', () => {
    const doc = Document.New();
    const flow = doc.NewFlow({ format: PageFormat.A4 });
    flow.AddCodeBlock('if (x) {\n    return 1;\n}');
    const page = flow.Render()[0];
    // Read the RESULT, not the emitter: extraction is outside the code path
    // that produced it, so a collapsed run of spaces cannot hide here.
    const text = page.GetText();
    expect(text).toContain('    return 1;');
  });

  it('does not word-wrap on the spaces it preserved', () => {
    // Four short "words" that would wrap to several lines if the spaces were
    // separators; as one NBSP-glued token they stay on one line.
    const [el] = codeBlock('aa bb cc dd', { fontSize: 10, leading: 12, padding: 0 });
    const m = el.measure!({ width: 400, availHeight: 400 });
    expect(m.usedHeight).toBeCloseTo(12, 6);
  });

  it('one source line per emitted line, plus padding', () => {
    const [el] = codeBlock('one\ntwo\nthree', { fontSize: 10, leading: 12, padding: 3 });
    const m = el.measure!({ width: 400, availHeight: 400 });
    expect(m.usedHeight).toBeCloseTo(3 * 12 + 2 * 3, 6);
    expect(m.fits).toBe(true);
  });

  it('paints its background before its text', () => {
    const doc = Document.New();
    const { page } = doc.AddPage(PageFormat.A4);
    const [el] = codeBlock('x', { fontSize: 10, leading: 12, padding: 4, background: [0.9, 0.9, 0.9] });
    el.place({ doc, page, x: 20, top: 400, width: 200, availHeight: 300 });
    const s = cs(page);
    const bg = s.indexOf(' re\nf\n');
    const tj = s.indexOf('Tj');
    expect(bg).toBeGreaterThanOrEqual(0);
    expect(tj).toBeGreaterThan(bg); // text composites over the fill
  });

  it('splits between lines when the column runs out', () => {
    const doc = Document.New();
    const { page } = doc.AddPage(PageFormat.A4);
    const [el] = codeBlock('one\ntwo\nthree\nfour', { fontSize: 10, leading: 12, padding: 0 });
    const res = el.place({ doc, page, x: 20, top: 400, width: 200, availHeight: 24 });
    expect(res.drew).toBe(true);
    expect(res.usedHeight).toBeCloseTo(24, 6);
    expect(res.remainder).not.toBeNull();
    const rest = res.remainder!.measure!({ width: 200, availHeight: 400 });
    expect(rest.usedHeight).toBeCloseTo(24, 6); // the other two lines
  });

  it('validates before building anything', () => {
    expect(() => codeBlock(5 as any)).toThrow(TypeError);
    expect(() => codeBlock('x', { fontSize: 0 })).toThrow(TypeError);
    expect(() => codeBlock('x', { padding: -1 })).toThrow(TypeError);
    expect(() => codeBlock('x', { tabWidth: 0 })).toThrow(TypeError);
    expect(() => codeBlock('x', { background: [0, 0, 5] })).toThrow(TypeError);
  });

  it('Flow.AddCodeBlock is chainable', () => {
    const doc = Document.New();
    const flow = doc.NewFlow({ format: PageFormat.A4 });
    expect(flow.AddCodeBlock('x')).toBe(flow);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/flow-blocks.test.ts`
Expected: FAIL — `codeBlock` and `preformat` are not exported.

- [ ] **Step 3: Append to `src/flowblock.ts`**

Add to its imports:

```ts
import {
  flowTextBlock, measureTextBlock, type TextBlockOptions, type AuthoringFont,
} from './stamp.js';
```

And append:

```ts
/** Options for {@link codeBlock} / {@link Flow.AddCodeBlock}. */
export interface FlowCodeOptions {
  /** Body font. Default 'Courier'. */
  font?: AuthoringFont;
  /** Font size (points). > 0. Default 9. */
  fontSize?: number;
  /** Text colour (RGB 0..1). Default black. */
  color?: [number, number, number];
  /** Baseline-to-baseline distance. Default 1.2 * fontSize. */
  leading?: number;
  /** Fill painted behind the block, or `false` for none. Default a light grey. */
  background?: [number, number, number] | false;
  /** Inset between the fill's edge and the text, all four sides. >= 0. Default 4. */
  padding?: number;
  /** Columns a tab advances to. Integer > 0. Default 4. */
  tabWidth?: number;
  /** Points inserted above the block (dropped at a column top). >= 0. Default 0. */
  spaceBefore?: number;
  /** Points inserted below the block (dropped at a column top). >= 0. Default 0. */
  spaceAfter?: number;
  /** Drop the block below the floats on the given side(s) before placing it. */
  clear?: FlowClear;
}

const CODE_BACKGROUND: [number, number, number] = [0.96, 0.96, 0.96];

/** Turn source text into text the wrapping engine will not reflow: expand tabs
 *  to `tabWidth` columns, then substitute U+00A0 for every space.
 *
 *  **Invariant:** this substitution happens here, once, and nothing downstream
 *  knows about it. `layoutRuns` COLLAPSES runs of spaces (`a  b` lays out as
 *  `a b`), which is fatal to code indentation, and adding a preserve-spaces mode
 *  to the one wrapping engine would put every existing caller's byte-identity at
 *  risk. U+00A0 costs nothing instead: `winAnsi[0xA0]` is U+00A0, WinAnsiEncoding
 *  names that code /space (32000-1 Annex D Table D.2's documented duplicate), and
 *  its AFM advance is identical to /space's. So the block measures exactly as the
 *  same text with real spaces would, while each source line becomes one
 *  unbreakable unit — and a line too wide for the column then falls through
 *  layout.ts's existing UAX #14 over-wide-token path instead of running off the
 *  page. */
export function preformat(text: string, tabWidth: number): string {
  let out = '';
  let col = 0;
  for (const ch of text) {
    if (ch === '\n') { out += ch; col = 0; continue; }
    if (ch === '\t') {
      const n = tabWidth - (col % tabWidth);
      out += ' '.repeat(n);
      col += n;
      continue;
    }
    out += ch === ' ' ? ' ' : ch;
    col++;
  }
  return out;
}

/** A preformatted block: monospaced, indentation-preserving, optionally on a
 *  fill. An ordinary text element underneath, so it inherits pagination,
 *  measurement and tagging rather than growing a second layout path. @internal */
class CodeBlockElement implements FlowElement {
  constructor(
    /** Already through {@link preformat}. */
    private readonly text: string,
    private readonly opts: TextBlockOptions,
    private readonly padding: number,
    private readonly background: [number, number, number] | undefined,
    readonly spaceBefore: number,
    readonly spaceAfter: number,
    readonly clear?: FlowClear,
  ) {}

  /** The text box inside the padding, for a given region. */
  private inner(width: number, availHeight: number): { w: number; h: number } {
    return { w: width - 2 * this.padding, h: availHeight - 2 * this.padding };
  }

  measure(ctx: MeasureContext): { usedHeight: number; fits: boolean } {
    const { w, h } = this.inner(ctx.width, ctx.availHeight);
    if (w <= 0 || h <= 0) return { usedHeight: 0, fits: false };
    const { usedHeight, remainder } = measureTextBlock(this.text, w, h, this.opts);
    if (usedHeight === 0) return { usedHeight: 0, fits: false };
    return { usedHeight: usedHeight + 2 * this.padding, fits: remainder === null };
  }

  place(ctx: PlaceContext): PlaceResult {
    const { w, h } = this.inner(ctx.width, ctx.availHeight);
    if (w <= 0 || h <= 0) return { usedHeight: 0, remainder: this, drew: false };
    // Measure first so the fill can be painted at the right height BEFORE the
    // text, which is what puts the glyphs on top of it. measureTextBlock runs
    // the identical layout, so the two agree by construction.
    const probe = measureTextBlock(this.text, w, h, this.opts);
    if (probe.usedHeight === 0)
      return { usedHeight: 0, remainder: probe.remainder === null ? null : this, drew: false };
    const used = probe.usedHeight + 2 * this.padding;
    if (this.background)
      paintDecoration(ctx, fillRect(ctx.x, ctx.top - used, ctx.width, used, this.background));
    const rect: [number, number, number, number] =
      [ctx.x + this.padding, ctx.top - used + this.padding, w, probe.usedHeight];
    const { remainder } = flowTextBlock(ctx.doc, ctx.page, this.text, rect, this.opts);
    return {
      usedHeight: used,
      remainder: remainder === null ? null
        : new CodeBlockElement(remainder, this.opts, this.padding, this.background,
          0, this.spaceAfter, undefined),
      drew: true,
    };
  }
}

/** Build a preformatted code block: monospaced, indentation-preserving, wrapped
 *  only where a line is too wide for the column. Splits between source lines
 *  across a column boundary. The builder behind {@link Flow.AddCodeBlock}. */
export function codeBlock(text: string, options: FlowCodeOptions = {}): FlowElement[] {
  if (typeof text !== 'string') throw new TypeError('code block text must be a string');
  const fontSize = positive(options.fontSize, 9, 'fontSize');
  const tabWidth = options.tabWidth ?? 4;
  if (!Number.isInteger(tabWidth) || tabWidth <= 0)
    throw new TypeError('tabWidth must be an integer > 0');
  const padding = nonNegative(options.padding, 4, 'padding');
  const background = options.background === false ? undefined
    : options.background === undefined ? CODE_BACKGROUND
      : checkColor('background', options.background);
  if (options.color !== undefined) checkColor('color', options.color);
  const opts: TextBlockOptions = {
    font: options.font ?? 'Courier',
    fontSize,
    color: options.color,
    leading: options.leading,
    align: 'left',
  };
  const { spaceBefore, spaceAfter } = normalizeSpacing(options);
  return [new CodeBlockElement(preformat(text, tabWidth), opts, padding, background,
    spaceBefore, spaceAfter, normalizeClear(options.clear))];
}
```

- [ ] **Step 4: Add `Flow.AddCodeBlock`**

In `src/flow.ts`, extend the `./flowblock.js` import and re-export to include `codeBlock` and `FlowCodeOptions`, then add after `AddRule`:

```ts
  /** Append a preformatted code block. Indentation and line breaks are
   *  preserved; a line too wide for the column wraps rather than running off the
   *  page. Splits between source lines across a column. Chainable. */
  AddCodeBlock(text: string, options: FlowCodeOptions = {}): this {
    this.items.push(...codeBlock(text, options));
    return this;
  }
```

- [ ] **Step 5: Run to verify it passes**

Run: `npx vitest run test/flow-blocks.test.ts`
Expected: PASS.

- [ ] **Step 6: Prove the substitution is load-bearing**

Temporarily change `preformat`'s `out += ch === ' ' ? ' ' : ch;` to `out += ch;`.

Run: `npx vitest run test/flow-blocks.test.ts`
Expected: FAIL on `preserves indentation through a real render` and on `does not word-wrap on the spaces it preserved`. If the render test still passes, the assertion is not reading what it claims to — fix the test, not the code.

Revert. Re-run. Expected: PASS.

- [ ] **Step 7: Typecheck, fence, full suite**

Run: `npm run typecheck && npm test`
Expected: clean.

- [ ] **Step 8: Commit**

```bash
git add src/flowblock.ts src/flow.ts test/flow-blocks.test.ts
git commit -m "$(cat <<'EOF'
feat(flow): preformatted code blocks (Flow.AddCodeBlock)

The one wrapping engine collapses runs of spaces, which is fatal to code
indentation and cannot be changed without risking every existing caller's
byte-identity. codeBlock substitutes U+00A0 instead: it encodes to WinAnsi
0xA0, which Annex D names /space and whose AFM advance is identical, so the
block measures as the same text with real spaces would while each source line
becomes one unbreakable unit.

Asserted against the encoding and metrics tables directly, and confirmed red
with the substitution removed.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 7: `flowblock.ts` — the block quote

**Files:**
- Modify: `src/flowblock.ts` (append)
- Modify: `test/flow-blocks.test.ts` (append)
- Modify: `src/flow.ts` (import `quote`, add `Flow.AddQuote`)

**Invariant this task establishes:** a container never holds and paginates its children. The Flow engine is a flat queue; a container that paginated its own children would be a second copy of `Render`'s loop, which is how a quote comes to break across a column under one rule and a list under another. A quote lowers to a flat array in which each child is wrapped by a decorator owning an indent and its own ink.

**Interfaces:**
- Consumes: everything from Tasks 2, 5, 6.
- Produces, from `src/flowblock.ts`:
  - `interface FlowQuoteOptions { indent?, bar?, spaceBefore?, spaceAfter?, clear? }`
  - `quote(blocks: FlowElement[], options?: FlowQuoteOptions): FlowElement[]`

  And `Flow.AddQuote(blocks: FlowElement[], options?: FlowQuoteOptions): this`.

- [ ] **Step 1: Write the failing test**

Append to `test/flow-blocks.test.ts`:

```ts
import { quote } from '../src/flowblock.js';
import { paragraph } from '../src/flow.js';

describe('quote', () => {
  it('lowers to one element per child, not one container', () => {
    const els = quote([...paragraph('a'), ...paragraph('b'), ...codeBlock('c')]);
    expect(els).toHaveLength(3);
  });

  it('indents its children and narrows their width', () => {
    const doc = Document.New();
    const { page } = doc.AddPage(PageFormat.A4);
    const [el] = quote([...paragraph('hello', { fontSize: 10, leading: 12 })], { indent: 20 });
    el.place({ doc, page, x: 100, top: 400, width: 200, availHeight: 300 });
    // The text matrix places the first line at x = 100 + 20.
    expect(cs(page)).toMatch(/1 0 0 1 120 /);
  });

  it('paints a bar in the gutter, spanning the element and the gap below it', () => {
    const doc = Document.New();
    const { page } = doc.AddPage(PageFormat.A4);
    const els = quote(
      [...paragraph('a', { fontSize: 10, leading: 12, spaceAfter: 6 }),
        ...paragraph('b', { fontSize: 10, leading: 12 })],
      { indent: 20, bar: { width: 3, color: [0.5, 0.5, 0.5] } },
    );
    els[0].place({ doc, page, x: 100, top: 400, width: 200, availHeight: 300, paragraphSpacing: 4 });
    // 12 used + 6 spaceAfter + 4 paragraphSpacing = 22 tall, top at 400.
    expect(cs(page)).toMatch(/100 378 3 22 re/);
  });

  it("the last child's bar stops at its own bottom", () => {
    const doc = Document.New();
    const { page } = doc.AddPage(PageFormat.A4);
    const els = quote([...paragraph('a', { fontSize: 10, leading: 12 })], { indent: 20 });
    els[0].place({ doc, page, x: 100, top: 400, width: 200, availHeight: 300, paragraphSpacing: 4 });
    expect(cs(page)).toMatch(/100 388 3 12 re/);
  });

  it('clamps the bar to the region bottom rather than the margin', () => {
    const doc = Document.New();
    const { page } = doc.AddPage(PageFormat.A4);
    const els = quote(
      [...paragraph('a', { fontSize: 10, leading: 12, spaceAfter: 50 }),
        ...paragraph('b', { fontSize: 10, leading: 12 })],
      { indent: 20 },
    );
    // Only 12pt of room below the pen: the bar may not extend past 400 - 12.
    els[0].place({ doc, page, x: 100, top: 400, width: 200, availHeight: 12, paragraphSpacing: 4 });
    expect(cs(page)).toMatch(/100 388 3 12 re/);
  });

  it('nests: two bars at two indents', () => {
    const doc = Document.New();
    const { page } = doc.AddPage(PageFormat.A4);
    const inner = quote([...paragraph('deep', { fontSize: 10, leading: 12 })], { indent: 20 });
    const outer = quote(inner, { indent: 20 });
    outer[0].place({ doc, page, x: 100, top: 400, width: 200, availHeight: 300 });
    const s = cs(page);
    expect(s).toMatch(/100 388 3 12 re/); // outer bar at x = 100
    expect(s).toMatch(/120 388 3 12 re/); // inner bar at x = 100 + 20
    expect(s).toMatch(/1 0 0 1 140 /);    // text at x = 100 + 20 + 20
  });

  it('carries the indent and the bar into a continuation', () => {
    const doc = Document.New();
    const { page } = doc.AddPage(PageFormat.A4);
    const long = Array.from({ length: 40 }, (_, i) => `w${i}`).join(' ');
    const [el] = quote([...paragraph(long, { fontSize: 10, leading: 12 })], { indent: 20 });
    const res = el.place({ doc, page, x: 100, top: 400, width: 200, availHeight: 24 });
    expect(res.drew).toBe(true);
    expect(res.remainder).not.toBeNull();
    const before = cs(page).length;
    res.remainder!.place({ doc, page, x: 100, top: 700, width: 200, availHeight: 300 });
    const after = cs(page).slice(before);
    expect(after).toMatch(/1 0 0 1 120 /); // still indented
    expect(after).toMatch(/100 \d+(\.\d+)? 3 /); // still barred
  });

  it('bar: false draws no bar', () => {
    const doc = Document.New();
    const { page } = doc.AddPage(PageFormat.A4);
    const [el] = quote([...paragraph('a', { fontSize: 10, leading: 12 })], { bar: false });
    el.place({ doc, page, x: 100, top: 400, width: 200, availHeight: 300 });
    expect(cs(page)).not.toMatch(/ re\nf\n/);
  });

  it('validates before building anything', () => {
    expect(() => quote('nope' as any)).toThrow(TypeError);
    expect(() => quote([{} as any])).toThrow(TypeError);
    expect(() => quote([...paragraph('a')], { indent: -1 })).toThrow(TypeError);
    expect(() => quote([...paragraph('a')], { bar: { width: -1 } })).toThrow(TypeError);
    expect(() => quote([...paragraph('a')], { bar: { color: [0, 0, 2] } })).toThrow(TypeError);
  });

  it('Flow.AddQuote is chainable', () => {
    const doc = Document.New();
    const flow = doc.NewFlow({ format: PageFormat.A4 });
    expect(flow.AddQuote([...paragraph('quoted')])).toBe(flow);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/flow-blocks.test.ts`
Expected: FAIL — `quote` is not exported.

- [ ] **Step 3: Append to `src/flowblock.ts`**

```ts
/** The bar drawn down a quote's gutter. */
export interface FlowQuoteBar {
  /** Bar thickness. >= 0. Default 3. */
  width?: number;
  /** Bar colour (RGB 0..1). Default a light grey. */
  color?: [number, number, number];
  /** Points from the region's left edge to the bar's left edge. >= 0. Default 0. */
  offset?: number;
}

/** Options for {@link quote} / {@link Flow.AddQuote}. */
export interface FlowQuoteOptions {
  /** Points the contents are indented from the region's left edge. >= 0. Default 18. */
  indent?: number;
  /** The gutter bar, or `false` for none. Default: a 3pt light-grey bar at the edge. */
  bar?: FlowQuoteBar | false;
  /** Points inserted above the quote (dropped at a column top). >= 0. Default 0. */
  spaceBefore?: number;
  /** Points inserted below the quote (dropped at a column top). >= 0. Default 0. */
  spaceAfter?: number;
  /** Drop the quote below the floats on the given side(s) before placing it.
   *  Applies to its first element only. */
  clear?: FlowClear;
}

interface ResolvedBar { width: number; color: [number, number, number]; offset: number }

const QUOTE_BAR_COLOR: [number, number, number] = [0.8, 0.8, 0.8];

/** One quoted child: an indent plus its own ink.
 *
 *  **Invariant:** a container never holds and paginates its children. This
 *  decorates exactly ONE inner element and delegates place/measure to it, so a
 *  quote split across a column needs no special case — each element paints its
 *  bar wherever it lands, and a nested quote is just this wrapping itself.
 *  @internal */
class QuotedElement implements FlowElement {
  constructor(
    private readonly inner: FlowElement,
    private readonly indent: number,
    private readonly bar: ResolvedBar | undefined,
    /** Points of following gap the bar covers, over and above the engine's own
     *  paragraphSpacing. 0 on the quote's last element. */
    private readonly barExtend: number,
    readonly spaceBefore: number,
    readonly spaceAfter: number,
    readonly clear?: FlowClear,
  ) {}

  get keepWithNextEligible(): boolean | undefined { return this.inner.keepWithNextEligible; }
  get keepWithNext(): boolean | undefined { return this.inner.keepWithNext; }

  measure(ctx: MeasureContext): { usedHeight: number; fits: boolean } {
    // Every element in this repo implements measure; the fallback is unreachable
    // and exists only because the protocol declares it optional.
    return this.inner.measure?.({ width: ctx.width - this.indent, availHeight: ctx.availHeight })
      ?? { usedHeight: 0, fits: false };
  }

  place(ctx: PlaceContext): PlaceResult {
    const res = this.inner.place({
      ...ctx, x: ctx.x + this.indent, width: ctx.width - this.indent,
    });
    if (res.drew && this.bar) this.paintBar(ctx, res.usedHeight, res.remainder !== null);
    return {
      usedHeight: res.usedHeight,
      drew: res.drew,
      remainder: res.remainder === null ? null
        : new QuotedElement(res.remainder, this.indent, this.bar, this.barExtend,
          0, this.spaceAfter, undefined),
      // A continuation carries no `clear`: the quote already cleared once.
    };
  }

  /** The bar covers this element's band plus the gap that follows it, so a quote
   *  of several blocks reads as one continuous rule rather than a dashed column.
   *  Two bounds: an element that overflowed has nothing after it in this column,
   *  and the painted bottom never passes the region's own bottom edge. */
  private paintBar(ctx: PlaceContext, used: number, split: boolean): void {
    const b = this.bar!;
    if (!(b.width > 0)) return;
    const extend = split ? 0 : this.barExtend + (ctx.paragraphSpacing ?? 0);
    const bottom = Math.max(ctx.top - used - extend, ctx.top - ctx.availHeight);
    const h = ctx.top - bottom;
    if (!(h > 0)) return;
    paintDecoration(ctx, fillRect(ctx.x + b.offset, bottom, b.width, h, b.color));
  }
}

/** Build a block quote from already-built child elements: each is indented and
 *  gains a gutter bar. Nests — pass the result of one `quote` as the `blocks` of
 *  another. The builder behind {@link Flow.AddQuote}. */
export function quote(blocks: FlowElement[], options: FlowQuoteOptions = {}): FlowElement[] {
  if (!Array.isArray(blocks)) throw new TypeError('quote blocks must be an array');
  for (const b of blocks) {
    if (typeof b !== 'object' || b === null || typeof (b as FlowElement).place !== 'function')
      throw new TypeError('each quote block must be a FlowElement (see the flow builders)');
  }
  const indent = nonNegative(options.indent, 18, 'indent');
  let bar: ResolvedBar | undefined;
  if (options.bar !== false) {
    const b = options.bar ?? {};
    if (typeof b !== 'object' || b === null || Array.isArray(b))
      throw new TypeError('bar must be an object or false');
    bar = {
      width: nonNegative(b.width, 3, 'bar.width'),
      color: b.color === undefined ? QUOTE_BAR_COLOR : checkColor('bar.color', b.color),
      offset: nonNegative(b.offset, 0, 'bar.offset'),
    };
  }
  const { spaceBefore, spaceAfter } = normalizeSpacing(options);
  const clear = normalizeClear(options.clear);
  if (blocks.length === 0) return [];

  return blocks.map((inner, i) => {
    const last = i === blocks.length - 1;
    // What the engine will insert after this child, minus its own paragraphSpacing
    // (which the element reads from its PlaceContext at draw time).
    const extend = last ? 0 : (inner.spaceAfter ?? 0) + (blocks[i + 1].spaceBefore ?? 0);
    return new QuotedElement(
      inner, indent, bar, extend,
      i === 0 ? spaceBefore + (inner.spaceBefore ?? 0) : (inner.spaceBefore ?? 0),
      last ? spaceAfter + (inner.spaceAfter ?? 0) : (inner.spaceAfter ?? 0),
      i === 0 ? clear : undefined,
    );
  });
}
```

- [ ] **Step 4: Add `Flow.AddQuote`**

In `src/flow.ts`, extend the `./flowblock.js` import and re-export to include `quote`, `FlowQuoteOptions` and `FlowQuoteBar`, then add after `AddCodeBlock`:

```ts
  /** Append a block quote: the given elements, indented behind a gutter bar.
   *  Build the elements with the flow builders (`paragraph`, `list`,
   *  `codeBlock`, `quote` itself for a nested quote). Each child paginates on its
   *  own, so a long quote flows across columns and its bar follows. Chainable. */
  AddQuote(blocks: FlowElement[], options: FlowQuoteOptions = {}): this {
    this.items.push(...quote(blocks, options));
    return this;
  }
```

- [ ] **Step 5: Run to verify it passes**

Run: `npx vitest run test/flow-blocks.test.ts`
Expected: PASS.

- [ ] **Step 6: Prove the clamp and the extend are load-bearing**

Temporarily change `paintBar`'s `const bottom = Math.max(...)` to `const bottom = ctx.top - used - extend;`.

Run: `npx vitest run test/flow-blocks.test.ts -t "clamps the bar"`
Expected: FAIL.

Revert, then temporarily change `extend` to `0`.

Run: `npx vitest run test/flow-blocks.test.ts -t "spanning the element"`
Expected: FAIL.

Revert. Re-run the file. Expected: PASS.

- [ ] **Step 7: Typecheck, full suite**

Run: `npm run typecheck && npm test`
Expected: clean.

- [ ] **Step 8: Commit**

```bash
git add src/flowblock.ts src/flow.ts test/flow-blocks.test.ts
git commit -m "$(cat <<'EOF'
feat(flow): block quotes (Flow.AddQuote)

A quote lowers to a flat array of single-child decorators rather than a
container that paginates its own children — the engine is a flat queue, and a
second pagination loop is how a quote and a list come to break across a column
under two different rules. Each element paints its own bar, so a split quote
needs no special case and nesting is the decorator wrapping itself.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 8: `FlowListItem.blocks` and the shared marker holder

**Files:**
- Modify: `src/flow.ts:478-589` (`ListStructHolder`, `ListItemElement`), `:591-630` (`FlowListItem`), `:643-760` (`validateNode`, `buildListElements`)
- Modify: `test/flow-blocks.test.ts` (append)

A Markdown list item may hold several paragraphs, a code block or a nested quote. `FlowListItem.text` is a single body. The flattener already lowers a nested item tree into a pre-order queue with per-depth indents; this extends that lowering so one item may produce several elements, all sharing its indent, its `/LBody` and its marker.

**Invariant this task establishes:** the marker is owned by per-item state, not by one element. With a private flag the text body owns it, and an item whose first block is a code block never draws a marker at all.

**Interfaces:**
- Consumes: `FlowElement` (Task 2), the builders (Task 3), `codeBlock`/`quote` (Tasks 6-7).
- Produces: `FlowListItem.text` becomes optional; `FlowListItem.blocks?: FlowElement[]` is new. `list()` and `Flow.AddList` accept both.

- [ ] **Step 1: Write the failing test**

Append to `test/flow-blocks.test.ts`:

```ts
import { list } from '../src/flow.js';

describe('list items holding blocks', () => {
  it('lowers an item to its body plus its blocks, all at one indent', () => {
    const els = list([
      { text: 'intro', blocks: [...paragraph('second paragraph'), ...codeBlock('x')] },
      'plain',
    ]);
    expect(els).toHaveLength(4); // body + 2 blocks + the plain item
  });

  it('indents every element of the item equally', () => {
    const doc = Document.New();
    const { page } = doc.AddPage(PageFormat.A4);
    const els = list([{ text: 'intro', blocks: [...paragraph('more')] }],
      { fontSize: 10, leading: 12, indent: 30 });
    els[0].place({ doc, page, x: 100, top: 400, width: 300, availHeight: 300 });
    const afterBody = cs(page).length;
    els[1].place({ doc, page, x: 100, top: 380, width: 300, availHeight: 300 });
    expect(cs(page).slice(0, afterBody)).toMatch(/1 0 0 1 130 /);
    expect(cs(page).slice(afterBody)).toMatch(/1 0 0 1 130 /);
  });

  it('draws the marker exactly once across the item, on the first element', () => {
    const doc = Document.New();
    const { page } = doc.AddPage(PageFormat.A4);
    const els = list([{ text: 'intro', blocks: [...paragraph('more')] }],
      { fontSize: 10, leading: 12, indent: 30, bullet: '*' });
    for (const el of els) el.place({ doc, page, x: 100, top: 400, width: 300, availHeight: 300 });
    const marks = cs(page).match(/\(\*\) Tj/g) ?? [];
    expect(marks).toHaveLength(1);
  });

  // The case a private markerDrawn flag silently gets wrong.
  it('an item with no text draws its marker on its first block', () => {
    const doc = Document.New();
    const { page } = doc.AddPage(PageFormat.A4);
    const els = list([{ blocks: [...codeBlock('code first')] }],
      { fontSize: 10, indent: 30, bullet: '*' });
    expect(els).toHaveLength(1);
    els[0].place({ doc, page, x: 100, top: 400, width: 300, availHeight: 300 });
    expect(cs(page)).toMatch(/\(\*\) Tj/);
  });

  it('a block that paginates keeps the indent and does not redraw the marker', () => {
    const doc = Document.New();
    const { page } = doc.AddPage(PageFormat.A4);
    const [el] = list([{ blocks: [...codeBlock('a\nb\nc\nd', { fontSize: 10, leading: 12, padding: 0 })] }],
      { fontSize: 10, indent: 30, bullet: '*' });
    const res = el.place({ doc, page, x: 100, top: 400, width: 300, availHeight: 24 });
    expect(res.remainder).not.toBeNull();
    const before = cs(page).length;
    res.remainder!.place({ doc, page, x: 100, top: 700, width: 300, availHeight: 300 });
    const after = cs(page).slice(before);
    expect(after).toMatch(/1 0 0 1 130 /);
    expect(after).not.toMatch(/\(\*\) Tj/);
  });

  it('a quote nested inside a list item composes both indents', () => {
    const doc = Document.New();
    const { page } = doc.AddPage(PageFormat.A4);
    const els = list([{ text: 'item', blocks: quote([...paragraph('quoted', { fontSize: 10, leading: 12 })], { indent: 20 }) }],
      { fontSize: 10, leading: 12, indent: 30 });
    els[1].place({ doc, page, x: 100, top: 400, width: 300, availHeight: 300 });
    expect(cs(page)).toMatch(/1 0 0 1 150 /); // 100 + 30 (list) + 20 (quote)
  });

  it('rejects an item with neither text nor blocks', () => {
    expect(() => list([{} as any])).toThrow(TypeError);
    expect(() => list([{ blocks: 'nope' as any }])).toThrow(TypeError);
    expect(() => list([{ blocks: [{} as any] }])).toThrow(TypeError);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/flow-blocks.test.ts -t "list items holding blocks"`
Expected: FAIL — `blocks` is not a known property, and an item without `text` throws.

- [ ] **Step 3: Introduce `ItemState` and the shared helpers in `src/flow.ts`**

Replace the `ListStructHolder` declaration (around line 481) with:

```ts
/** Shared across the items of one sub-list so they append to a single `/L` node,
 *  created lazily on the first item that actually draws. `parentBody` chains a
 *  nested sub-list's `/L` under its parent item's `/LBody`. @internal */
interface ListStructHolder { list?: StructElement; parentBody?: () => StructElement | undefined; }

/** Per-item state shared by every element one item lowers to.
 *
 *  **Invariant:** the marker is owned here, not by one element. An item may
 *  lower to a body plus several blocks, and whichever draws FIRST must paint
 *  the marker — with a private flag the text body owns it, so an item whose
 *  first block is a code block would never draw one at all. The `/LI`, `/Lbl`
 *  and `/LBody` nodes are shared for the same reason. @internal */
interface ItemState {
  markerDrawn: boolean;
  li?: StructElement;
  lbl?: StructElement;
  lbody?: StructElement;
}

/** Create this item's `/LI` + `/Lbl` + `/LBody` under its sub-list's `/L`, once.
 *  A no-op for an untagged flow. An element that draws nothing in this column
 *  leaves the nodes childless until it draws in the next one — the same
 *  behaviour an overflow probe has always had. @internal */
function ensureItemStruct(
  ctx: PlaceContext, marker: ListMarker, holder: ListStructHolder, state: ItemState,
): void {
  if (state.li !== undefined || !ctx.structParent) return;
  const parent = holder.parentBody?.() ?? ctx.structParent;
  if (holder.list === undefined) holder.list = parent.Append('L');
  state.li = holder.list.Append('LI');
  state.lbl = state.li.Append('Lbl',
    marker.kind === 'shape' ? { actualText: marker.actualText } : undefined);
  state.lbody = state.li.Append('LBody');
}

/** Paint the item's marker, right-aligned against the gutter so ordinals line up
 *  on the period, at the first line's baseline. Once per item. @internal */
function drawMarkerOnce(
  ctx: PlaceContext, marker: ListMarker, indent: number,
  o: NormalizedListOptions, state: ItemState,
): void {
  if (state.markerDrawn) return;
  const rightEdge = ctx.x + indent - o.markerGap;
  const baseline = ctx.top - o.fontSize; // = the body's first-line baseline
  if (marker.kind === 'shape') {
    drawShapeMarker(ctx.doc, ctx.page, marker.shape, rightEdge, baseline, o, state.lbl);
  } else {
    const mw = measureText(marker.text, o.fontSize, o.font);
    const markerOpts: StampOptions = {
      font: o.font, fontSize: o.fontSize, color: o.color,
      underline: o.underline, strikethrough: o.strikethrough, background: o.background,
      ...(state.lbl ? { tag: state.lbl } : {}),
    };
    stampText(ctx.doc, ctx.page, marker.text, rightEdge - mw, baseline, markerOpts);
  }
  state.markerDrawn = true;
}
```

- [ ] **Step 4: Rewrite `ListItemElement` over `ItemState`**

Replace the class body (around line 498-589), keeping its doc comment:

```ts
class ListItemElement implements FlowElement {
  /** Set on the list's first element only; a continuation never copies it. */
  clear?: FlowClear;

  constructor(
    private readonly text: FlowText,
    private readonly marker: ListMarker,
    private readonly indent: number,
    private readonly opts: NormalizedListOptions,
    public spaceBefore: number,
    public spaceAfter: number,
    private readonly holder: ListStructHolder,
    private readonly state: ItemState,
  ) {}

  measure(ctx: MeasureContext): { usedHeight: number; fits: boolean } {
    if (ctx.availHeight <= 0) return { usedHeight: 0, fits: false };
    const bodyOpts = bodyOptions(this.opts);
    const { usedHeight, remainder } =
      measureFlowText(this.text, ctx.width - this.indent, ctx.availHeight, bodyOpts);
    return { usedHeight, fits: remainder === null && usedHeight > 0 };
  }

  place(ctx: PlaceContext): PlaceResult {
    if (ctx.availHeight <= 0) return { usedHeight: 0, remainder: this, drew: false };

    // Empty text never tags, so it leaves no orphan node behind.
    if (!isEmptyFlowText(this.text)) ensureItemStruct(ctx, this.marker, this.holder, this.state);

    const bodyOpts: TextBlockOptions = {
      ...bodyOptions(this.opts),
      ...(this.state.lbody ? { tag: this.state.lbody } : {}),
    };
    const rect: [number, number, number, number] = [
      ctx.x + this.indent, ctx.top - ctx.availHeight,
      ctx.width - this.indent, ctx.availHeight,
    ];
    const { remainder, usedHeight } = drawFlowText(ctx.doc, ctx.page, this.text, rect, bodyOpts);

    if (usedHeight === 0) {
      // Nothing drawn: null remainder = empty (discard); else it did not fit the
      // leftover space (retry this element in the next column).
      return { usedHeight: 0, remainder: remainder === null ? null : this, drew: false };
    }

    drawMarkerOnce(ctx, this.marker, this.indent, this.opts, this.state);

    if (remainder === null) return { usedHeight, remainder: null, drew: true };
    // Continuation: body-only remainder, same shared state (so the marker is not
    // redrawn and the struct nodes are reused), spaceBefore = 0.
    return {
      usedHeight,
      remainder: new ListItemElement(remainder, this.marker, this.indent, this.opts,
        0, this.spaceAfter, this.holder, this.state),
      drew: true,
    };
  }
}

/** One non-text block of a list item: the item's indent, the item's marker and
 *  `/LBody`, wrapped around an arbitrary element. Delegates place and measure —
 *  it does not paginate its child, exactly as {@link QuotedElement} does not.
 *  @internal */
class ListBlockElement implements FlowElement {
  constructor(
    private readonly inner: FlowElement,
    private readonly marker: ListMarker,
    private readonly indent: number,
    private readonly opts: NormalizedListOptions,
    private readonly holder: ListStructHolder,
    private readonly state: ItemState,
    public spaceBefore: number,
    public spaceAfter: number,
  ) {}

  measure(ctx: MeasureContext): { usedHeight: number; fits: boolean } {
    return this.inner.measure?.({ width: ctx.width - this.indent, availHeight: ctx.availHeight })
      ?? { usedHeight: 0, fits: false };
  }

  place(ctx: PlaceContext): PlaceResult {
    if (ctx.availHeight <= 0) return { usedHeight: 0, remainder: this, drew: false };
    ensureItemStruct(ctx, this.marker, this.holder, this.state);
    const res = this.inner.place({
      ...ctx,
      x: ctx.x + this.indent,
      width: ctx.width - this.indent,
      // A block inside an item nests under /LBody, so a multi-paragraph item
      // reads as LI > LBody > P, P rather than as loose content.
      structParent: this.state.lbody ?? ctx.structParent,
    });
    if (res.drew) drawMarkerOnce(ctx, this.marker, this.indent, this.opts, this.state);
    return {
      usedHeight: res.usedHeight,
      drew: res.drew,
      remainder: res.remainder === null ? null
        : new ListBlockElement(res.remainder, this.marker, this.indent, this.opts,
          this.holder, this.state, 0, this.spaceAfter),
    };
  }
}
```

- [ ] **Step 5: Widen `FlowListItem` and `validateNode`**

Change `FlowListItem.text` (around line 594) to optional and add `blocks`:

```ts
  /** The item's word-wrapped body text. A {@link TextRun} list mixes styles
   *  within the item; a bare string is one style throughout. Optional only when
   *  `blocks` is given — an item must have one or the other. */
  text?: FlowText;
  /** Further block content for THIS item, built with the flow builders
   *  (`paragraph`, `codeBlock`, `quote`, `list`). Each is placed at the item's
   *  own indent, under its `/LBody`, and the item's marker is drawn by whichever
   *  of the item's elements draws first. */
  blocks?: FlowElement[];
```

In `validateNode`, replace the text check:

```ts
  if (typeof n !== 'object' || n === null)
    throw new TypeError('a list item must be a string or an object');
  if (n.text !== undefined && !(typeof n.text === 'string' || isTextRunList(n.text)))
    throw new TypeError('item.text must be a string or a run list');
  if (n.blocks !== undefined) {
    if (!Array.isArray(n.blocks)) throw new TypeError('item.blocks must be an array');
    for (const b of n.blocks) {
      if (typeof b !== 'object' || b === null || typeof (b as FlowElement).place !== 'function')
        throw new TypeError('each item.blocks entry must be a FlowElement (see the flow builders)');
    }
  }
  if (n.text === undefined && (n.blocks === undefined || n.blocks.length === 0))
    throw new TypeError('a list item must have text or blocks');
```

- [ ] **Step 6: Lower each item to several elements in `buildListElements`**

Change the `Planned` interface and the construction pass (around line 709-756):

```ts
  interface Planned {
    item: FlowListItem; marker: ListMarker; depth: number;
    holder: ListStructHolder; opts: NormalizedListOptions;
    state: ItemState; elements: FlowElement[];
  }
```

In `walk`, build the state up front so the child holder can close over it:

```ts
      const p: Planned = {
        item, marker, depth, holder, opts: itemOpts,
        state: { markerDrawn: false }, elements: [],
      };
      planned.push(p);
      if (item.items && item.items.length > 0) {
        const childCfg: SublistCfg = {
          ordered: item.ordered ?? cfg.ordered,
          bulletOverride: item.bullet,
          start: item.start ?? 1,
        };
        const childHolder: ListStructHolder = { parentBody: () => p.state.lbody };
        walk(item.items, depth + 1, childCfg, childHolder);
      }
```

Replace the construction and spacing pass:

```ts
  // Construct elements, then assign spacing in flattened (pre-order) order.
  for (const p of planned) {
    const indent = p.item.indent ?? cumulative[p.depth];
    if (p.item.text !== undefined)
      p.elements.push(new ListItemElement(p.item.text, p.marker, indent, p.opts, 0, 0,
        p.holder, p.state));
    for (const b of p.item.blocks ?? [])
      p.elements.push(new ListBlockElement(b, p.marker, indent, p.opts, p.holder, p.state,
        b.spaceBefore ?? 0, b.spaceAfter ?? 0));
  }
  planned.forEach((p, i) => {
    const first = p.elements[0];
    const last = p.elements[p.elements.length - 1];
    first.spaceBefore = p.item.spaceBefore ?? (i === 0 ? o.spaceBefore : 0);
    last.spaceAfter = p.item.spaceAfter
      ?? (i === planned.length - 1 ? o.spaceAfter : o.itemSpacing);
  });
  const els: FlowElement[] = planned.flatMap((p) => p.elements);
  const listClear = normalizeClear(options.clear);
  if (planned.length > 0) planned[0].elements[0].clear = listClear;
  return els;
```

`ListBlockElement` has no `clear` field; give it one (`clear?: FlowClear`) so the first-element assignment type-checks for either class.

- [ ] **Step 7: Run to verify it passes**

Run: `npx vitest run test/flow-blocks.test.ts test/flow.test.ts`
Expected: PASS.

- [ ] **Step 8: Run the fence — this is the task most likely to move bytes**

Run: `npx vitest run test/rich-runs-identity.test.ts`
Expected: PASS, all eleven. If `flow-list-*` moved, the marker or spacing lowering changed behaviour for a plain list; fix the code, do not re-record.

- [ ] **Step 9: Prove the shared marker holder is load-bearing**

Temporarily change `ListBlockElement.place` to skip `drawMarkerOnce`.

Run: `npx vitest run test/flow-blocks.test.ts -t "no text draws its marker"`
Expected: FAIL.

Revert. Re-run. Expected: PASS.

- [ ] **Step 10: Typecheck and full suite**

Run: `npm run typecheck && npm test`
Expected: clean.

- [ ] **Step 11: Commit**

```bash
git add src/flow.ts test/flow-blocks.test.ts
git commit -m "$(cat <<'EOF'
feat(flow): list items may hold arbitrary blocks

FlowListItem gains blocks?: FlowElement[], lowered to the item's own indent and
/LBody alongside its text body. The marker moves from a private flag to
per-item state shared by every element the item lowers to: with a private flag
the text body owns it, so an item opening with a code block never drew one.

The existing single-text path is untouched and the byte-identity fence,
extended to nested, styled and paginating lists, stays green.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 9: Checkbox markers for task list items

**Files:**
- Modify: `src/flow.ts:310-319` (`BULLET_SHAPES`, `ListMarker`), `:387-449` (`drawShapeMarker`, `markerFor`, `markerWidth`), `FlowListItem`
- Modify: `test/flow-blocks.test.ts` (append)

GFM task items need `☐` / `☑`. WinAnsi has no ballot-box glyph, so a text marker is not available; the marker is drawn as vector geometry, extending the existing bullet-shape vocabulary rather than adding a second marker painter.

**Interfaces:**
- Produces: `FlowListItem.marker?: 'checkbox' | 'checked'`, overriding the computed marker for that item.

- [ ] **Step 1: Write the failing test**

Append to `test/flow-blocks.test.ts`:

```ts
describe('checkbox markers', () => {
  it('draws an unfilled box for an unchecked item and adds a check when checked', () => {
    const render = (marker: 'checkbox' | 'checked') => {
      const doc = Document.New();
      const { page } = doc.AddPage(PageFormat.A4);
      const [el] = list([{ text: 'task', marker }], { fontSize: 10, leading: 12, indent: 30 });
      el.place({ doc, page, x: 100, top: 400, width: 300, availHeight: 300 });
      return cs(page);
    };
    const un = render('checkbox');
    const on = render('checked');
    expect(un).toMatch(/ re\n/);     // the box outline
    expect(un).toMatch(/S\n/);       // stroked, not filled
    // The check is two extra stroked segments, so the checked form is longer.
    expect(on.length).toBeGreaterThan(un.length);
    expect(on).toMatch(/ l\n/);      // line segments
  });

  it('reserves a wider gutter than a bullet', () => {
    const [box] = list([{ text: 'task', marker: 'checkbox' }], { fontSize: 10, leading: 12 });
    const [dot] = list(['task'], { fontSize: 10, leading: 12 });
    // A wider marker means a wider auto indent, so the body wraps sooner.
    const w = (el: any) => el.measure({ width: 60, availHeight: 400 }).usedHeight;
    expect(w(box)).toBeGreaterThanOrEqual(w(dot));
  });

  it('carries the ballot-box character as /Lbl actual text when tagged', () => {
    const doc = Document.New();
    const flow = doc.NewFlow({ format: PageFormat.A4, tagged: true });
    flow.AddList([{ text: 'done', marker: 'checked' }]);
    flow.Render();
    const dump = JSON.stringify(doc.GetStructTree(), (_k, v) =>
      typeof v === 'bigint' ? String(v) : v);
    expect(dump).toContain('☑');
  });

  it('rejects an unknown marker name', () => {
    expect(() => list([{ text: 'x', marker: 'star' as any }])).toThrow(TypeError);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/flow-blocks.test.ts -t "checkbox markers"`
Expected: FAIL — `marker` is not a known property of `FlowListItem`.

- [ ] **Step 3: Extend the shape vocabulary in `src/flow.ts`**

Replace the shape constants (around line 311-319):

```ts
/** Vector-bullet cycle by depth: filled disc, hollow ring, filled square. */
const BULLET_SHAPES = ['disc', 'ring', 'square'] as const;
const BULLET_GLYPHS = ['•', '◦', '▪'];

/** The two task-list markers, drawn as vector geometry because WinAnsi has no
 *  ballot-box glyph and there is no substitute face to fall back on. */
const CHECK_SHAPES = ['checkbox', 'checked'] as const;
type MarkerShape = (typeof BULLET_SHAPES)[number] | (typeof CHECK_SHAPES)[number];

/** A resolved list marker: an ordinal / explicit-bullet text glyph, or a vector
 *  shape (default bullet cycle, or a task checkbox). @internal */
type ListMarker =
  | { kind: 'text'; text: string }
  | { kind: 'shape'; shape: MarkerShape; actualText: string };
```

- [ ] **Step 4: Draw the two shapes**

In `drawShapeMarker`, change the parameter type to `shape: MarkerShape`, and replace the size line and the shape dispatch:

```ts
  // A checkbox is glyph-sized rather than bullet-sized: it stands in for a
  // character, not for a dot.
  const isCheck = shape === 'checkbox' || shape === 'checked';
  const size = (isCheck ? 0.7 : 0.35) * fontSize;
```

and add, before the existing `if (shape === 'square')` branch:

```ts
  if (isCheck) {
    const lw = Math.max(0.4, 0.07 * fontSize);
    const bottom = cy - size / 2;
    let s2 = `q\n${num(r)} ${num(g)} ${num(b)} RG\n${num(lw)} w\n`
      + `${num(left + lw / 2)} ${num(bottom + lw / 2)} `
      + `${num(size - lw)} ${num(size - lw)} re\nS\n`;
    if (shape === 'checked') {
      // A two-segment tick inside the box.
      const x0 = left + 0.22 * size, y0 = bottom + 0.52 * size;
      const x1 = left + 0.42 * size, y1 = bottom + 0.28 * size;
      const x2 = left + 0.80 * size, y2 = bottom + 0.74 * size;
      s2 += `${num(x0)} ${num(y0)} m\n${num(x1)} ${num(y1)} l\n${num(x2)} ${num(y2)} l\nS\n`;
    }
    s = s2 + 'Q';
  } else if (shape === 'square') {
```

(the existing `if (shape === 'square') { ... } else { ... }` becomes the `else if` / `else` tail of this chain).

In `markerWidth`, account for the wider box:

```ts
function markerWidth(m: ListMarker, fontSize: number, font: AuthoringFont): number {
  if (m.kind !== 'shape') return measureText(m.text, fontSize, font);
  return (m.shape === 'checkbox' || m.shape === 'checked' ? 0.7 : 0.35) * fontSize;
}
```

- [ ] **Step 5: Accept the per-item override**

Add to `FlowListItem`:

```ts
  /** Draw a task-list checkbox for THIS item instead of the computed marker.
   *  Vector-drawn: WinAnsi has no ballot-box glyph. */
  marker?: 'checkbox' | 'checked';
```

In `validateNode`:

```ts
  if (n.marker !== undefined && n.marker !== 'checkbox' && n.marker !== 'checked')
    throw new TypeError("item.marker must be 'checkbox' or 'checked'");
```

In `walk`, override the computed marker:

```ts
      const marker: ListMarker = item.marker !== undefined
        ? { kind: 'shape', shape: item.marker,
          actualText: item.marker === 'checked' ? '☑' : '☐' }
        : markerFor(cfg, index, depth);
```

(replacing `const marker = markerFor(cfg, index, depth);`).

- [ ] **Step 6: Run to verify it passes**

Run: `npx vitest run test/flow-blocks.test.ts -t "checkbox markers"`
Expected: PASS.

- [ ] **Step 7: Typecheck, fence, full suite**

Run: `npm run typecheck && npm test`
Expected: clean; the fence unmoved (no existing list asks for a checkbox).

- [ ] **Step 8: Commit**

```bash
git add src/flow.ts test/flow-blocks.test.ts
git commit -m "$(cat <<'EOF'
feat(flow): vector checkbox markers for task list items

WinAnsi has no ballot-box glyph and there is no substitute face, so the two GFM
task markers are drawn as geometry, extending the existing bullet-shape
vocabulary rather than adding a second marker painter. U+2610/U+2611 become the
/Lbl actual text, which is the mechanism already in place for vector bullets.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 10: `flowplace.ts` — place elements into a rect

**Files:**
- Create: `src/flowplace.ts`
- Create: `test/flow-place.test.ts`

`Page.AddMarkdown` needs to lay elements into one rect and hand back what did not fit. This is the Flow loop with columns, floats, keep-with-next and page creation removed — a separate module rather than a mode of `Render`, precisely so it cannot grow those back.

**Interfaces:**
- Consumes: `FlowElement`, `PlaceContext` from `flowelement.ts`.
- Produces, from `src/flowplace.ts`:
  - `interface PlaceElementsOptions { paragraphSpacing?: number; structParent?: StructElement }`
  - `interface PlaceElementsResult { usedHeight: number; remainder: FlowElement[] }`
  - `placeElements(doc, page, elements, rect, options?): PlaceElementsResult`

  `rect` is `[x, y, w, h]` with `y` the **bottom** edge, matching `flowTextBlock` and `Page.AddTextBlock`.

- [ ] **Step 1: Write the failing test**

Create `test/flow-place.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { PageFormat } from '../src/pageformat.js';
import { paragraph } from '../src/flow.js';
import { placeElements } from '../src/flowplace.js';

const cs = (page: { Contents: Uint8Array }): string =>
  new TextDecoder('latin1').decode(page.Contents);

const LOREM = 'The quick brown fox jumps over the lazy dog, and then it does so again '
  + 'because one sentence is not enough to force a wrap in a narrow column.';

describe('placeElements', () => {
  it('stacks elements from the top of the rect downward', () => {
    const doc = Document.New();
    const { page } = doc.AddPage(PageFormat.A4);
    const els = [...paragraph('one', { fontSize: 10, leading: 12 }),
      ...paragraph('two', { fontSize: 10, leading: 12 })];
    const r = placeElements(doc, page, els, [50, 300, 200, 100]);
    expect(r.remainder).toEqual([]);
    expect(r.usedHeight).toBeCloseTo(24, 6);
    // Rect top = 300 + 100 = 400; baselines at 400-10 and 388-10.
    expect(cs(page)).toMatch(/1 0 0 1 50 390 /);
    expect(cs(page)).toMatch(/1 0 0 1 50 378 /);
  });

  it('inserts paragraphSpacing between elements but never above the first', () => {
    const doc = Document.New();
    const { page } = doc.AddPage(PageFormat.A4);
    const els = [...paragraph('one', { fontSize: 10, leading: 12 }),
      ...paragraph('two', { fontSize: 10, leading: 12 })];
    const r = placeElements(doc, page, els, [50, 300, 200, 100], { paragraphSpacing: 6 });
    expect(r.usedHeight).toBeCloseTo(30, 6);
    expect(cs(page)).toMatch(/1 0 0 1 50 390 /);
    expect(cs(page)).toMatch(/1 0 0 1 50 372 /);
  });

  it("honours an element's own spaceBefore and spaceAfter", () => {
    const doc = Document.New();
    const { page } = doc.AddPage(PageFormat.A4);
    const els = [...paragraph('one', { fontSize: 10, leading: 12, spaceAfter: 5 }),
      ...paragraph('two', { fontSize: 10, leading: 12, spaceBefore: 3 })];
    const r = placeElements(doc, page, els, [50, 300, 200, 100]);
    expect(r.usedHeight).toBeCloseTo(12 + 5 + 3 + 12, 6);
  });

  it('returns a split element as the head of the remainder', () => {
    const doc = Document.New();
    const { page } = doc.AddPage(PageFormat.A4);
    const els = [...paragraph(LOREM, { fontSize: 10, leading: 12 }),
      ...paragraph('after', { fontSize: 10, leading: 12 })];
    const r = placeElements(doc, page, els, [50, 300, 100, 24]);
    expect(r.usedHeight).toBeCloseTo(24, 6);
    expect(r.remainder).toHaveLength(2);
    // The head is the continuation, not the original.
    expect(r.remainder[0]).not.toBe(els[0]);
    expect(r.remainder[1]).toBe(els[1]);
  });

  it('returns an unplaceable element whole, without splitting it', () => {
    const doc = Document.New();
    const { page } = doc.AddPage(PageFormat.A4);
    const els = [...paragraph('one', { fontSize: 10, leading: 12 }),
      ...paragraph('two', { fontSize: 10, leading: 12 })];
    const r = placeElements(doc, page, els, [50, 300, 200, 12]);
    expect(r.usedHeight).toBeCloseTo(12, 6);
    expect(r.remainder).toEqual([els[1]]);
  });

  it('a remainder can be fed straight back into another rect', () => {
    const doc = Document.New();
    const { page } = doc.AddPage(PageFormat.A4);
    const first = placeElements(doc, page, [...paragraph(LOREM, { fontSize: 10, leading: 12 })],
      [50, 500, 100, 24]);
    expect(first.remainder).toHaveLength(1);
    const second = placeElements(doc, page, first.remainder, [200, 100, 300, 400]);
    expect(second.remainder).toEqual([]);
    expect(cs(page)).toMatch(/1 0 0 1 200 /);
  });

  it('discards an element that draws nothing and is not retryable', () => {
    const doc = Document.New();
    const { page } = doc.AddPage(PageFormat.A4);
    const els = [...paragraph('', { fontSize: 10, leading: 12 }),
      ...paragraph('visible', { fontSize: 10, leading: 12 })];
    const r = placeElements(doc, page, els, [50, 300, 200, 100]);
    expect(r.remainder).toEqual([]);
    expect(r.usedHeight).toBeCloseTo(12, 6);
  });

  it('validates its rect', () => {
    const doc = Document.New();
    const { page } = doc.AddPage(PageFormat.A4);
    expect(() => placeElements(doc, page, [], [0, 0, 0, 10])).toThrow(TypeError);
    expect(() => placeElements(doc, page, [], [0, 0, 10, -1])).toThrow(TypeError);
    expect(() => placeElements(doc, page, 'no' as any, [0, 0, 10, 10])).toThrow(TypeError);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/flow-place.test.ts`
Expected: FAIL — cannot resolve `../src/flowplace.js`.

- [ ] **Step 3: Create `src/flowplace.ts`**

```ts
/** Place a list of {@link FlowElement}s into ONE rectangle on ONE page and hand
 *  back what did not fit.
 *
 *  This is `Flow.Render`'s loop with columns, floats, keep-with-next and page
 *  creation removed. It is a separate module rather than a mode of `Render`
 *  precisely so it cannot grow those back: a caller who wants columns wants a
 *  Flow. What it shares with the engine is the element protocol and the spacing
 *  rule, which is the part that must not drift. */

import type { Document } from './document.js';
import type { Page } from './page.js';
import type { StructElement } from './struct.js';
import type { FlowElement } from './flowelement.js';

/** Options for {@link placeElements}. */
export interface PlaceElementsOptions {
  /** Gap inserted between consecutive elements, on top of their own
   *  `spaceAfter`/`spaceBefore`. Dropped above the first element. >= 0.
   *  Default 0. */
  paragraphSpacing?: number;
  /** Grouping element the placed content tags under. Omit for untagged output. */
  structParent?: StructElement;
}

/** Result of {@link placeElements}. */
export interface PlaceElementsResult {
  /** Vertical space consumed, measured from the rect's top edge. */
  usedHeight: number;
  /** Elements that did not fit, in order, ready to pass to another
   *  `placeElements` call. `[]` when everything was placed. A split element
   *  appears here as its continuation, not as the original. */
  remainder: FlowElement[];
}

/** Lay `elements` top-down into `rect` = `[x, y, w, h]`, where `y` is the
 *  BOTTOM edge (the convention `flowTextBlock` and `Page.AddTextBlock` use).
 *  Draws onto `page` and never creates one. */
export function placeElements(
  doc: Document, page: Page, elements: FlowElement[],
  rect: [number, number, number, number],
  options: PlaceElementsOptions = {},
): PlaceElementsResult {
  if (!Array.isArray(elements)) throw new TypeError('elements must be an array');
  if (!Array.isArray(rect) || rect.length !== 4 || !rect.every((n) => Number.isFinite(n)))
    throw new TypeError('rect must be [x, y, width, height] of finite numbers');
  const [x, y, w, h] = rect;
  if (!(w > 0)) throw new TypeError('rect width must be positive');
  if (!(h >= 0)) throw new TypeError('rect height must be non-negative');
  const ps = options.paragraphSpacing ?? 0;
  if (!Number.isFinite(ps) || ps < 0)
    throw new TypeError('paragraphSpacing must be a non-negative finite number');

  const rectTop = y + h;
  let top = rectTop;
  let started = false;
  let pendingAfter = 0;
  const stop = (remainder: FlowElement[]): PlaceElementsResult =>
    ({ usedHeight: rectTop - top, remainder });

  for (let i = 0; i < elements.length; i++) {
    const el = elements[i];
    // The gap above this element, dropped entirely at the rect's top.
    const gap = started ? pendingAfter + ps + (el.spaceBefore ?? 0) : 0;
    const elTop = top - gap;
    const availHeight = elTop - y;
    if (availHeight <= 0) return stop(elements.slice(i));

    const res = el.place({
      doc, page, x, top: elTop, width: w, availHeight,
      paragraphSpacing: ps, structParent: options.structParent,
    });

    if (res.drew) {
      top = elTop - res.usedHeight;
      started = true;
      if (res.remainder) return stop([res.remainder, ...elements.slice(i + 1)]);
      pendingAfter = el.spaceAfter ?? 0;
      continue;
    }
    // Nothing painted: a null remainder means the element was empty (discard);
    // anything else means it did not fit what is left, and the rect is done.
    if (res.remainder === null) continue;
    return stop(elements.slice(i));
  }
  return stop([]);
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run test/flow-place.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck and full suite**

Run: `npm run typecheck && npm test`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add src/flowplace.ts test/flow-place.test.ts
git commit -m "$(cat <<'EOF'
feat(flow): placeElements — a FlowElement[] into one rect

Render's loop with columns, floats, keep-with-next and page creation removed,
so Page.AddMarkdown can lay elements into a rect and hand back the overflow.
Its own module rather than a mode of Render so it cannot grow those back.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

## Phase 2 — the Markdown mapper (Tasks 11-18)

Lands as its own commit series. Nothing here can break an existing caller: it is all new surface on top of Phase 1.

### Task 11: `mdstyle.ts` — the style vocabulary

**Files:**
- Create: `src/mdstyle.ts`
- Create: `test/markdown-style.test.ts`

`emph` and `strong` need a face, and this library has no synthetic slant or emboldening. The style is therefore built around a four-face *family*, derived by name for a Standard-14 base and stated explicitly for an embedded one.

**Interfaces:**
- Consumes: `AuthoringFont` from `stamp.ts`, `FlowQuoteBar` from `flowblock.ts`.
- Produces, from `src/mdstyle.ts`:
  - `interface MarkdownFontFamily { regular: AuthoringFont; bold?, italic?, boldItalic? }`
  - `type MarkdownFontSpec = AuthoringFont | MarkdownFontFamily`
  - `interface ResolvedFamily { regular; bold; italic; boldItalic }` — all four `AuthoringFont`
  - `interface MarkdownStyle { ... }` (all fields optional)
  - `interface ResolvedMarkdownStyle { ... }` (every field filled)
  - `resolveFamily(spec: MarkdownFontSpec): ResolvedFamily`
  - `resolveMarkdownStyle(style?: MarkdownStyle): ResolvedMarkdownStyle`
  - `faceFor(family: ResolvedFamily, bold: boolean, italic: boolean): AuthoringFont`

- [ ] **Step 1: Write the failing test**

Create `test/markdown-style.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { buildUnicodeTtf } from './helpers/build-sfnt.js';
import { resolveFamily, resolveMarkdownStyle, faceFor } from '../src/mdstyle.js';

describe('resolveFamily', () => {
  it('derives the three Standard-14 families by name', () => {
    expect(resolveFamily('Helvetica')).toEqual({
      regular: 'Helvetica', bold: 'Helvetica-Bold',
      italic: 'Helvetica-Oblique', boldItalic: 'Helvetica-BoldOblique',
    });
    expect(resolveFamily('Times-Roman')).toEqual({
      regular: 'Times-Roman', bold: 'Times-Bold',
      italic: 'Times-Italic', boldItalic: 'Times-BoldItalic',
    });
    expect(resolveFamily('Courier')).toEqual({
      regular: 'Courier', bold: 'Courier-Bold',
      italic: 'Courier-Oblique', boldItalic: 'Courier-BoldOblique',
    });
  });

  it('derives from any member of a family, not only its roman', () => {
    // A bold base still names the family; emphasis is relative to the family.
    expect(resolveFamily('Helvetica-Bold').italic).toBe('Helvetica-Oblique');
    expect(resolveFamily('Times-BoldItalic').regular).toBe('Times-BoldItalic');
  });

  it('has no family for Symbol or ZapfDingbats: every face is the base', () => {
    expect(resolveFamily('Symbol')).toEqual({
      regular: 'Symbol', bold: 'Symbol', italic: 'Symbol', boldItalic: 'Symbol',
    });
  });

  it('falls back to regular for an embedded face the caller did not supply', () => {
    const doc = Document.New();
    const font = doc.AddFont(buildUnicodeTtf());
    const fam = resolveFamily(font);
    expect(fam.bold).toBe(font);
    expect(fam.italic).toBe(font);
  });

  it('takes an explicit family verbatim, filling only what is missing', () => {
    const fam = resolveFamily({ regular: 'Times-Roman', bold: 'Helvetica-Bold' });
    expect(fam.bold).toBe('Helvetica-Bold');
    expect(fam.italic).toBe('Times-Roman'); // unset -> regular, not a derived guess
  });

  it('rejects a malformed family', () => {
    expect(() => resolveFamily({} as any)).toThrow(TypeError);
    expect(() => resolveFamily({ regular: 'NotAFont' } as any)).toThrow(TypeError);
    expect(() => resolveFamily(42 as any)).toThrow(TypeError);
  });
});

describe('faceFor', () => {
  it('selects by the two flags', () => {
    const f = resolveFamily('Helvetica');
    expect(faceFor(f, false, false)).toBe('Helvetica');
    expect(faceFor(f, true, false)).toBe('Helvetica-Bold');
    expect(faceFor(f, false, true)).toBe('Helvetica-Oblique');
    expect(faceFor(f, true, true)).toBe('Helvetica-BoldOblique');
  });
});

describe('resolveMarkdownStyle', () => {
  it('fills a coherent default document', () => {
    const s = resolveMarkdownStyle();
    expect(s.fontSize).toBe(11);
    expect(s.family.regular).toBe('Helvetica');
    expect(s.heading.family.regular).toBe('Helvetica-Bold');
    expect(s.heading.sizes).toEqual([24, 18, 14, 12, 10, 8]);
    expect(s.code.font).toBe('Courier');
    expect(s.link.underline).toBe(true);
  });

  it('scales derived values off the base size', () => {
    const s = resolveMarkdownStyle({ fontSize: 20 });
    expect(s.leading).toBeCloseTo(20 * 1.35, 6);
    expect(s.quote.indent).toBeCloseTo(20 * 1.6, 6);
    expect(s.paragraphSpacing).toBeCloseTo(20 * 0.55, 6);
  });

  it('an explicit value wins over the derived one', () => {
    const s = resolveMarkdownStyle({ fontSize: 20, leading: 13, quote: { indent: 4 } });
    expect(s.leading).toBe(13);
    expect(s.quote.indent).toBe(4);
  });

  it('code.sizeRatio governs inline code and code.fontSize the block', () => {
    const s = resolveMarkdownStyle({ fontSize: 10, code: { fontSize: 7, sizeRatio: 0.8 } });
    expect(s.code.fontSize).toBe(7);
    expect(s.code.sizeRatio).toBe(0.8);
  });

  it('validates every field before returning anything', () => {
    expect(() => resolveMarkdownStyle({ fontSize: 0 })).toThrow(TypeError);
    expect(() => resolveMarkdownStyle({ leading: -1 })).toThrow(TypeError);
    expect(() => resolveMarkdownStyle({ align: 'middle' as any })).toThrow(TypeError);
    expect(() => resolveMarkdownStyle({ color: [0, 0, 2] })).toThrow(TypeError);
    expect(() => resolveMarkdownStyle({ heading: { sizes: [1, 2, 3] } })).toThrow(TypeError);
    expect(() => resolveMarkdownStyle({ code: { sizeRatio: 0 } })).toThrow(TypeError);
    expect(() => resolveMarkdownStyle({ link: { color: 'blue' as any } })).toThrow(TypeError);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/markdown-style.test.ts`
Expected: FAIL — cannot resolve `../src/mdstyle.js`.

- [ ] **Step 3: Create `src/mdstyle.ts`**

```ts
/** The style vocabulary the Markdown mapper renders through: one flat, wholly
 *  optional {@link MarkdownStyle} over a documented defaults table, resolved
 *  once into a {@link ResolvedMarkdownStyle} with every field filled.
 *
 *  Pure: no PDF objects, no layout, no AST. It knows about fonts only as
 *  AuthoringFont values it passes along. */

import { EmbeddedFont } from './embeddedfont.js';
import { AUTHORING_FONTS, validateFont, type AuthoringFont } from './stamp.js';
import type { FlowQuoteBar } from './flowblock.js';

/** The four faces emphasis selects between. `bold`, `italic` and `boldItalic`
 *  each fall back to `regular` when neither given nor derivable. */
export interface MarkdownFontFamily {
  regular: AuthoringFont;
  bold?: AuthoringFont;
  italic?: AuthoringFont;
  boldItalic?: AuthoringFont;
}

/** A single face (whose family is derived when it is Standard-14) or an explicit
 *  family. */
export type MarkdownFontSpec = AuthoringFont | MarkdownFontFamily;

/** A family with all four faces filled. */
export interface ResolvedFamily {
  regular: AuthoringFont;
  bold: AuthoringFont;
  italic: AuthoringFont;
  boldItalic: AuthoringFont;
}

/** The three Standard-14 Latin families, in [regular, bold, italic, boldItalic]
 *  order. Symbol and ZapfDingbats have no family and are absent by design. */
const STD_FAMILIES: Record<string, [AuthoringFont, AuthoringFont, AuthoringFont, AuthoringFont]> = {
  Helvetica: ['Helvetica', 'Helvetica-Bold', 'Helvetica-Oblique', 'Helvetica-BoldOblique'],
  Times: ['Times-Roman', 'Times-Bold', 'Times-Italic', 'Times-BoldItalic'],
  Courier: ['Courier', 'Courier-Bold', 'Courier-Oblique', 'Courier-BoldOblique'],
};

/** Which Standard-14 family a face belongs to, or undefined for one that has
 *  none (Symbol, ZapfDingbats) — matching how textdecor.ts picks its metrics. */
function familyRoot(font: AuthoringFont): string | undefined {
  if (typeof font !== 'string') return undefined;
  if (font.startsWith('Times')) return 'Times';
  if (font.startsWith('Courier')) return 'Courier';
  if (font.startsWith('Helvetica')) return 'Helvetica';
  return undefined;
}

function isFamilyObject(v: MarkdownFontSpec): v is MarkdownFontFamily {
  return typeof v === 'object' && v !== null && !(v instanceof EmbeddedFont);
}

/** Resolve a font spec to four faces.
 *
 *  A Standard-14 face derives its family by name — including from a non-roman
 *  member, since emphasis is relative to the FAMILY, not to the given face. An
 *  EmbeddedFont derives nothing: there is no synthetic slant or emboldening
 *  here, so an unstated face falls back to `regular` and emphasis shows as no
 *  change rather than as a missing glyph. */
export function resolveFamily(spec: MarkdownFontSpec): ResolvedFamily {
  if (isFamilyObject(spec)) {
    const f = spec;
    if (f.regular === undefined) throw new TypeError('font family must have a regular face');
    for (const [k, v] of Object.entries(f)) {
      if (v !== undefined) validateFont(v as AuthoringFont);
      if (!['regular', 'bold', 'italic', 'boldItalic'].includes(k))
        throw new TypeError(`unknown font family face '${k}'`);
    }
    return {
      regular: f.regular,
      bold: f.bold ?? f.regular,
      italic: f.italic ?? f.regular,
      boldItalic: f.boldItalic ?? f.bold ?? f.italic ?? f.regular,
    };
  }
  validateFont(spec);
  const root = familyRoot(spec);
  if (root === undefined)
    return { regular: spec, bold: spec, italic: spec, boldItalic: spec };
  const [regular, bold, italic, boldItalic] = STD_FAMILIES[root];
  // The given face stays the regular one: `font: 'Helvetica-Bold'` means a bold
  // body, with emphasis still resolving against the Helvetica family.
  return { regular: spec, bold, italic, boldItalic };
}

/** The face the two emphasis flags select. */
export function faceFor(family: ResolvedFamily, bold: boolean, italic: boolean): AuthoringFont {
  if (bold && italic) return family.boldItalic;
  if (bold) return family.bold;
  if (italic) return family.italic;
  return family.regular;
}

/** How Markdown renders. Every field is optional; unset fields take the
 *  documented default, and derived defaults scale off `fontSize` so overriding
 *  the base size alone still yields a coherent document. */
export interface MarkdownStyle {
  /** Body face or family. Default 'Helvetica'. */
  font?: MarkdownFontSpec;
  /** Body size (points). > 0. Default 11. */
  fontSize?: number;
  /** Body colour (RGB 0..1). Default: the renderer's own default (black). */
  color?: [number, number, number];
  /** Baseline-to-baseline distance. Default 1.35 * fontSize. */
  leading?: number;
  /** Paragraph alignment. Default 'left'. */
  align?: 'left' | 'center' | 'right' | 'justify';
  /** Gap between consecutive blocks. >= 0. Default 0.55 * fontSize. */
  paragraphSpacing?: number;
  heading?: {
    /** Heading face or family. Default 'Helvetica-Bold'. */
    font?: MarkdownFontSpec;
    /** Sizes for levels 1..6. Exactly six positive numbers.
     *  Default [24, 18, 14, 12, 10, 8] — Flow's own heading scale. */
    sizes?: number[];
    color?: [number, number, number];
    /** Default 1.2 * fontSize. */ spaceBefore?: number;
    /** Default 0.4 * fontSize. */ spaceAfter?: number;
  };
  code?: {
    /** Default 'Courier'. */ font?: AuthoringFont;
    /** Size of a fenced/indented code BLOCK (points). > 0. Default 0.85 * fontSize. */
    fontSize?: number;
    /** Size of an INLINE code span, as a fraction of the block it sits in.
     *  > 0. Default 0.9 — Courier reads optically larger than Helvetica. */
    sizeRatio?: number;
    color?: [number, number, number];
    /** Fill behind a code block, or `false` for none. Default a light grey. */
    background?: [number, number, number] | false;
    /** Fill behind an inline code span, or `false` for none. Default a light grey. */
    inlineBackground?: [number, number, number] | false;
    /** Inset inside a code block's fill. >= 0. Default 0.4 * fontSize. */
    padding?: number;
    spaceBefore?: number;
    spaceAfter?: number;
  };
  quote?: {
    /** Indent of quoted content. >= 0. Default 1.6 * fontSize. */ indent?: number;
    /** The gutter bar, or `false`. Default a 3pt light-grey bar at the edge. */
    bar?: FlowQuoteBar | false;
    spaceBefore?: number;
    spaceAfter?: number;
  };
  rule?: {
    /** > 0. Default 0.5. */ thickness?: number;
    color?: [number, number, number];
    /** Default 0.8 * fontSize. */ spaceBefore?: number;
    /** Default 0.8 * fontSize. */ spaceAfter?: number;
  };
  list?: {
    /** Per-level body indent. >= 0. Default: Flow's measured-marker auto indent. */
    indent?: number;
    /** Gap between items of a TIGHT list. >= 0. Default 0. */ itemSpacing?: number;
    /** Marker glyph for a bullet list. Default: Flow's vector bullet cycle. */
    bullet?: string;
    spaceBefore?: number;
    spaceAfter?: number;
  };
  link?: {
    /** Default a mid blue. */ color?: [number, number, number];
    /** Default true. */ underline?: boolean;
  };
  image?: {
    /** Default 'left'. */ align?: 'left' | 'center' | 'right';
    spaceBefore?: number;
    spaceAfter?: number;
  };
}

/** {@link MarkdownStyle} with every field resolved. @internal */
export interface ResolvedMarkdownStyle {
  family: ResolvedFamily;
  fontSize: number;
  color?: [number, number, number];
  leading: number;
  align: 'left' | 'center' | 'right' | 'justify';
  paragraphSpacing: number;
  heading: {
    family: ResolvedFamily; sizes: number[];
    color?: [number, number, number]; spaceBefore: number; spaceAfter: number;
  };
  code: {
    font: AuthoringFont; fontSize: number; sizeRatio: number;
    color?: [number, number, number];
    background: [number, number, number] | false;
    inlineBackground: [number, number, number] | false;
    padding: number; spaceBefore: number; spaceAfter: number;
  };
  quote: { indent: number; bar: FlowQuoteBar | false; spaceBefore: number; spaceAfter: number };
  rule: {
    thickness: number; color?: [number, number, number];
    spaceBefore: number; spaceAfter: number;
  };
  list: {
    indent?: number; itemSpacing: number; bullet?: string;
    spaceBefore: number; spaceAfter: number;
  };
  link: { color: [number, number, number]; underline: boolean };
  image: { align: 'left' | 'center' | 'right'; spaceBefore: number; spaceAfter: number };
}

function pos(v: number | undefined, dflt: number, name: string): number {
  const n = v ?? dflt;
  if (!Number.isFinite(n) || n <= 0) throw new TypeError(`${name} must be a positive finite number`);
  return n;
}
function nonNeg(v: number | undefined, dflt: number, name: string): number {
  const n = v ?? dflt;
  if (!Number.isFinite(n) || n < 0)
    throw new TypeError(`${name} must be a non-negative finite number`);
  return n;
}
function color(v: unknown, name: string): [number, number, number] {
  if (!Array.isArray(v) || v.length !== 3
      || !v.every((c) => typeof c === 'number' && Number.isFinite(c) && c >= 0 && c <= 1))
    throw new TypeError(`${name} must be [r, g, b] with each component in 0..1`);
  return v as [number, number, number];
}
function optColor(v: unknown, name: string): [number, number, number] | undefined {
  return v === undefined ? undefined : color(v, name);
}
/** A fill option: a colour, or `false` for none. */
function fill(
  v: [number, number, number] | false | undefined, dflt: [number, number, number], name: string,
): [number, number, number] | false {
  if (v === false) return false;
  return v === undefined ? dflt : color(v, name);
}

const DEFAULT_HEADING_SIZES = [24, 18, 14, 12, 10, 8];
const DEFAULT_CODE_FILL: [number, number, number] = [0.96, 0.96, 0.96];
const DEFAULT_LINK_COLOR: [number, number, number] = [0.1, 0.3, 0.75];

/** Validate and fill a {@link MarkdownStyle}. Validates EVERYTHING before
 *  returning, so a rejected style leaves the document byte-identical. */
export function resolveMarkdownStyle(style: MarkdownStyle = {}): ResolvedMarkdownStyle {
  if (typeof style !== 'object' || style === null)
    throw new TypeError('style must be an object');
  const fontSize = pos(style.fontSize, 11, 'fontSize');
  const align = style.align ?? 'left';
  if (!['left', 'center', 'right', 'justify'].includes(align))
    throw new TypeError('align must be left, center, right, or justify');

  const h = style.heading ?? {};
  const sizes = h.sizes ?? DEFAULT_HEADING_SIZES;
  if (!Array.isArray(sizes) || sizes.length !== 6
      || !sizes.every((n) => Number.isFinite(n) && n > 0))
    throw new TypeError('heading.sizes must be six positive numbers, for levels 1..6');

  const c = style.code ?? {};
  if (c.font !== undefined) validateFont(c.font);
  const q = style.quote ?? {};
  if (q.bar !== undefined && q.bar !== false
      && (typeof q.bar !== 'object' || q.bar === null || Array.isArray(q.bar)))
    throw new TypeError('quote.bar must be an object or false');
  const r = style.rule ?? {};
  const l = style.list ?? {};
  if (l.bullet !== undefined && typeof l.bullet !== 'string')
    throw new TypeError('list.bullet must be a string');
  const k = style.link ?? {};
  if (k.underline !== undefined && typeof k.underline !== 'boolean')
    throw new TypeError('link.underline must be a boolean');
  const im = style.image ?? {};
  const imAlign = im.align ?? 'left';
  if (!['left', 'center', 'right'].includes(imAlign))
    throw new TypeError("image.align must be 'left', 'center', or 'right'");

  return {
    family: resolveFamily(style.font ?? 'Helvetica'),
    fontSize,
    color: optColor(style.color, 'color'),
    leading: pos(style.leading, fontSize * 1.35, 'leading'),
    align: align as ResolvedMarkdownStyle['align'],
    paragraphSpacing: nonNeg(style.paragraphSpacing, fontSize * 0.55, 'paragraphSpacing'),
    heading: {
      family: resolveFamily(h.font ?? 'Helvetica-Bold'),
      sizes,
      color: optColor(h.color, 'heading.color'),
      spaceBefore: nonNeg(h.spaceBefore, fontSize * 1.2, 'heading.spaceBefore'),
      spaceAfter: nonNeg(h.spaceAfter, fontSize * 0.4, 'heading.spaceAfter'),
    },
    code: {
      font: c.font ?? 'Courier',
      fontSize: pos(c.fontSize, fontSize * 0.85, 'code.fontSize'),
      sizeRatio: pos(c.sizeRatio, 0.9, 'code.sizeRatio'),
      color: optColor(c.color, 'code.color'),
      background: fill(c.background, DEFAULT_CODE_FILL, 'code.background'),
      inlineBackground: fill(c.inlineBackground, DEFAULT_CODE_FILL, 'code.inlineBackground'),
      padding: nonNeg(c.padding, fontSize * 0.4, 'code.padding'),
      spaceBefore: nonNeg(c.spaceBefore, 0, 'code.spaceBefore'),
      spaceAfter: nonNeg(c.spaceAfter, 0, 'code.spaceAfter'),
    },
    quote: {
      indent: nonNeg(q.indent, fontSize * 1.6, 'quote.indent'),
      bar: q.bar ?? {},
      spaceBefore: nonNeg(q.spaceBefore, 0, 'quote.spaceBefore'),
      spaceAfter: nonNeg(q.spaceAfter, 0, 'quote.spaceAfter'),
    },
    rule: {
      thickness: pos(r.thickness, 0.5, 'rule.thickness'),
      color: optColor(r.color, 'rule.color'),
      spaceBefore: nonNeg(r.spaceBefore, fontSize * 0.8, 'rule.spaceBefore'),
      spaceAfter: nonNeg(r.spaceAfter, fontSize * 0.8, 'rule.spaceAfter'),
    },
    list: {
      indent: l.indent === undefined ? undefined : nonNeg(l.indent, 0, 'list.indent'),
      itemSpacing: nonNeg(l.itemSpacing, 0, 'list.itemSpacing'),
      bullet: l.bullet,
      spaceBefore: nonNeg(l.spaceBefore, 0, 'list.spaceBefore'),
      spaceAfter: nonNeg(l.spaceAfter, 0, 'list.spaceAfter'),
    },
    link: {
      color: k.color === undefined ? DEFAULT_LINK_COLOR : color(k.color, 'link.color'),
      underline: k.underline ?? true,
    },
    image: {
      align: imAlign as 'left' | 'center' | 'right',
      spaceBefore: nonNeg(im.spaceBefore, 0, 'image.spaceBefore'),
      spaceAfter: nonNeg(im.spaceAfter, 0, 'image.spaceAfter'),
    },
  };
}
```

Drop `AUTHORING_FONTS` from the `./stamp.js` import if `validateFont` turns out to be the only name used from it.

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run test/markdown-style.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck and commit**

Run: `npm run typecheck`
Expected: clean.

```bash
git add src/mdstyle.ts test/markdown-style.test.ts
git commit -m "$(cat <<'EOF'
feat(markdown): the style vocabulary (mdstyle.ts)

emph and strong need a face and this library has no synthetic slant, so the
style is built around a four-face family: derived by name for Standard-14 —
including from a non-roman member, since emphasis is relative to the family —
and falling back to regular for an embedded face the caller did not supply.

Derived defaults scale off fontSize, so overriding the base size alone still
gives a coherent document.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 12: `mdruns.ts` — inlines to `TextRun[]`

**Files:**
- Create: `src/mdruns.ts`
- Create: `test/markdown-runs.test.ts`

**Interfaces:**
- Consumes: `MdInline` from `mdast.ts`, `TextRun` from `textdecor.ts`, `ResolvedMarkdownStyle` / `ResolvedFamily` / `faceFor` from `mdstyle.ts` (Task 11).
- Produces, from `src/mdruns.ts`:
  - `interface RunContext { family: ResolvedFamily; fontSize: number }`
  - `inlineRuns(nodes: MdInline[], style: ResolvedMarkdownStyle, ctx: RunContext, skipped: string[]): TextRun[]`
  - `plainText(nodes: MdInline[]): string` — the inlines' text with all styling dropped, for an image's `alt`.

- [ ] **Step 1: Write the failing test**

Create `test/markdown-runs.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { parseMarkdown } from '../src/markdown.js';
import type { MdParagraph } from '../src/mdast.js';
import { resolveMarkdownStyle } from '../src/mdstyle.js';
import { inlineRuns, plainText } from '../src/mdruns.js';

const STYLE = resolveMarkdownStyle();
const CTX = { family: STYLE.family, fontSize: STYLE.fontSize };

/** The inlines of a one-paragraph document. */
const inlinesOf = (src: string, gfm = true) => {
  const doc = parseMarkdown(src, { gfm });
  return (doc.children[0] as MdParagraph).children;
};
const runs = (src: string, skipped: string[] = []) =>
  inlineRuns(inlinesOf(src), STYLE, CTX, skipped);

describe('inlineRuns', () => {
  it('plain text is ONE run carrying no overrides at all', () => {
    // The closest a run list gets to the string path, which is what keeps a
    // plain Markdown paragraph cheap and its output stable.
    expect(runs('hello world')).toEqual([{ text: 'hello world' }]);
  });

  it('merges adjacent pieces of identical style', () => {
    // A soft break is a space; it must not split the run.
    expect(runs('one\ntwo')).toEqual([{ text: 'one two' }]);
  });

  it('a hard break becomes a newline in the run text', () => {
    const r = runs('one  \ntwo');
    expect(r).toHaveLength(1);
    expect(r[0].text).toBe('one\ntwo');
  });

  it('selects bold, italic and bold-italic faces', () => {
    expect(runs('**b**')[0].font).toBe('Helvetica-Bold');
    expect(runs('*i*')[0].font).toBe('Helvetica-Oblique');
    expect(runs('**a *b* c**').map((r) => r.font))
      .toEqual(['Helvetica-Bold', 'Helvetica-BoldOblique', 'Helvetica-Bold']);
  });

  it('nesting order does not matter', () => {
    expect(runs('*__x__*')[0].font).toBe('Helvetica-BoldOblique');
    expect(runs('__*x*__')[0].font).toBe('Helvetica-BoldOblique');
  });

  it('inline code takes the code face at sizeRatio of the block size', () => {
    const r = runs('`x`');
    expect(r[0].font).toBe('Courier');
    expect(r[0].fontSize).toBeCloseTo(11 * 0.9, 6);
    expect(r[0].background).toEqual([0.96, 0.96, 0.96]);
  });

  it('inline code scales to the block it sits in, not to the body size', () => {
    const big = inlineRuns(inlinesOf('`x`'), STYLE, { family: STYLE.family, fontSize: 24 }, []);
    expect(big[0].fontSize).toBeCloseTo(24 * 0.9, 6);
  });

  it('strikethrough decorates the run', () => {
    expect(runs('~~gone~~')[0].strikethrough).toBe(true);
  });

  it('a link colours and underlines its children, keeping their faces', () => {
    const r = runs('[**bold** plain](/x)');
    expect(r[0].font).toBe('Helvetica-Bold');
    expect(r.every((x) => x.underline === true)).toBe(true);
    expect(r.every((x) => x.color !== undefined)).toBe(true);
  });

  it('an inline image falls back to its alt text and reports itself', () => {
    const skipped: string[] = [];
    const r = inlineRuns(inlinesOf('see ![a cat](cat.png) here'), STYLE, CTX, skipped);
    expect(r.map((x) => x.text).join('')).toBe('see a cat here');
    expect(skipped).toEqual(['image:cat.png']);
  });

  it('inline HTML is dropped and reported', () => {
    const skipped: string[] = [];
    const r = inlineRuns(inlinesOf('a <b>c'), STYLE, CTX, skipped);
    expect(r.map((x) => x.text).join('')).toBe('a c');
    expect(skipped).toEqual(['html_inline']);
  });

  it('an embedded family without a bold face leaves the run unstyled, not dropped', () => {
    const fam = { regular: 'Helvetica' as const, bold: 'Helvetica' as const,
      italic: 'Helvetica' as const, boldItalic: 'Helvetica' as const };
    const r = inlineRuns(inlinesOf('**b**'), STYLE, { family: fam, fontSize: 11 }, []);
    expect(r).toEqual([{ text: 'b' }]);
  });
});

describe('plainText', () => {
  it('flattens every inline to its characters', () => {
    expect(plainText(inlinesOf('**a** *b* `c` [d](/x)'))).toBe('a b c d');
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/markdown-runs.test.ts`
Expected: FAIL — cannot resolve `../src/mdruns.js`.

- [ ] **Step 3: Create `src/mdruns.ts`**

```ts
/** Markdown inlines to {@link TextRun}s.
 *
 *  Pure: no Document, no PDF objects, no layout. It turns an emphasis tree into
 *  the flat run list gl6o.3.1 made the Flow text engine carry. */

import type { MdInline } from './mdast.js';
import type { TextRun } from './textdecor.js';
import { faceFor, type ResolvedFamily, type ResolvedMarkdownStyle } from './mdstyle.js';

/** The block a run list is being built for: a heading and a paragraph select
 *  faces from different families and scale inline code differently. */
export interface RunContext {
  family: ResolvedFamily;
  /** The block's own font size, which an inline code span scales against. */
  fontSize: number;
}

/** The styling in force at a point in the inline tree. */
interface InlineState {
  bold: boolean;
  italic: boolean;
  code: boolean;
  strike: boolean;
  link: boolean;
}

const START: InlineState = {
  bold: false, italic: false, code: false, strike: false, link: false,
};

/** A key identifying a state, so adjacent pieces of identical style merge into
 *  one run rather than one run per AST node. */
const stateKey = (s: InlineState): string =>
  `${+s.bold}${+s.italic}${+s.code}${+s.strike}${+s.link}`;

/** The run properties a state implies.
 *
 *  Every property the state does NOT change is left unset, so it inherits the
 *  block's. Plain text therefore yields a run with nothing but `text` — the
 *  closest a run list gets to the string path, and what keeps an ordinary
 *  Markdown paragraph from restating the paragraph's own font on every run. */
function runProps(
  s: InlineState, style: ResolvedMarkdownStyle, ctx: RunContext,
): Omit<TextRun, 'text'> {
  const r: Omit<TextRun, 'text'> = {};
  if (s.code) {
    r.font = style.code.font;
    r.fontSize = ctx.fontSize * style.code.sizeRatio;
    if (style.code.inlineBackground !== false) r.background = style.code.inlineBackground;
    if (style.code.color !== undefined) r.color = style.code.color;
  } else {
    const face = faceFor(ctx.family, s.bold, s.italic);
    if (face !== ctx.family.regular) r.font = face;
  }
  if (s.strike) r.strikethrough = true;
  if (s.link) {
    r.color = style.link.color;
    if (style.link.underline) r.underline = true;
  }
  return r;
}

/** Map `nodes` to runs. Anything that cannot be rendered names itself in
 *  `skipped` and still contributes its text where it has any — the rule
 *  svgdraw.ts sets for content it cannot draw fully. */
export function inlineRuns(
  nodes: MdInline[], style: ResolvedMarkdownStyle, ctx: RunContext, skipped: string[],
): TextRun[] {
  const out: TextRun[] = [];
  let lastKey: string | undefined;

  const push = (text: string, s: InlineState): void => {
    if (text === '') return;
    const k = stateKey(s);
    if (k === lastKey) { out[out.length - 1].text += text; return; }
    out.push({ text, ...runProps(s, style, ctx) });
    lastKey = k;
  };

  const walk = (ns: MdInline[], s: InlineState): void => {
    for (const n of ns) {
      switch (n.type) {
        case 'text': push(n.value, s); break;
        // A soft break is a space: the wrapping engine decides where the line
        // actually ends. A hard break is a newline, which layoutRuns already
        // treats as a paragraph boundary.
        case 'softbreak': push(' ', s); break;
        case 'linebreak': push('\n', s); break;
        case 'emph': walk(n.children, { ...s, italic: true }); break;
        case 'strong': walk(n.children, { ...s, bold: true }); break;
        case 'strikethrough': walk(n.children, { ...s, strike: true }); break;
        case 'code': push(n.value, { ...s, code: true }); break;
        // The /URI annotation is gl6o.3.3; the text and its styling are here.
        case 'link': walk(n.children, { ...s, link: true }); break;
        // An image reached inline (rather than alone in its paragraph, which
        // mdflow.ts lifts to a block) renders as its alt text: an inline raster
        // at line height is a layout feature nothing here needs.
        case 'image':
          skipped.push(`image:${n.destination}`);
          walk(n.children, s);
          break;
        case 'html_inline': skipped.push('html_inline'); break;
      }
    }
  };

  walk(nodes, START);
  return out;
}

/** The characters of `nodes` with all styling dropped — an image's alt text, and
 *  a heading's plain form. */
export function plainText(nodes: MdInline[]): string {
  let s = '';
  const walk = (ns: MdInline[]): void => {
    for (const n of ns) {
      switch (n.type) {
        case 'text': s += n.value; break;
        case 'code': s += n.value; break;
        case 'softbreak': case 'linebreak': s += ' '; break;
        case 'emph': case 'strong': case 'strikethrough':
        case 'link': case 'image':
          walk(n.children); break;
        case 'html_inline': break;
      }
    }
  };
  walk(nodes);
  return s;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run test/markdown-runs.test.ts`
Expected: PASS.

- [ ] **Step 5: Prove the merge and the inherit-by-omission are load-bearing**

Temporarily change `push` to always `out.push(...)` without the `k === lastKey` branch.

Run: `npx vitest run test/markdown-runs.test.ts -t "merges adjacent"`
Expected: FAIL.

Revert, then temporarily change `if (face !== ctx.family.regular) r.font = face;` to `r.font = face;`.

Run: `npx vitest run test/markdown-runs.test.ts -t "carrying no overrides"`
Expected: FAIL.

Revert. Re-run the file. Expected: PASS.

- [ ] **Step 6: Typecheck and commit**

Run: `npm run typecheck`
Expected: clean.

```bash
git add src/mdruns.ts test/markdown-runs.test.ts
git commit -m "$(cat <<'EOF'
feat(markdown): inlines to TextRun[] (mdruns.ts)

A recursive walk over an emphasis state, emitting the flat run list gl6o.3.1
made the Flow engine carry. Adjacent pieces of identical style merge, and a run
states only what it changes — so plain text is one run with nothing but text,
and inline code scales against the block it sits in rather than the body size.

Unrenderable inlines (an inline image, raw HTML) name themselves in `skipped`
and still contribute their text.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 13: `mdflow.ts` — blocks other than lists and images

**Files:**
- Create: `src/mdflow.ts`
- Create: `test/markdown-flow.test.ts`

**Interfaces:**
- Consumes: `parseMarkdown` / `MarkdownOptions` from `markdown.js`, the AST types from `mdast.js`, `paragraph`/`heading` from `flow.js`, `codeBlock`/`rule`/`quote` from `flowblock.js`, Tasks 11-12.
- Produces, from `src/mdflow.ts`:
  - `interface MarkdownFlowOptions extends MarkdownOptions { style?: MarkdownStyle; resolveImage?: (destination: string, title: string) => Uint8Array | undefined }`
  - `interface MarkdownElements { elements: FlowElement[]; skipped: string[] }`
  - `markdownElements(src: string | MdDocument, options?: MarkdownFlowOptions): MarkdownElements`

  Tasks 14 and 15 extend the `switch` inside it; the signature is final here.

- [ ] **Step 1: Write the failing test**

Create `test/markdown-flow.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { PageFormat } from '../src/pageformat.js';
import { markdownElements } from '../src/mdflow.js';
import { placeElements } from '../src/flowplace.js';

const cs = (page: { Contents: Uint8Array }): string =>
  new TextDecoder('latin1').decode(page.Contents);

/** Render elements onto a fresh full-page rect and return the page. */
const render = (src: string, options = {}) => {
  const doc = Document.New();
  const { page } = doc.AddPage(PageFormat.A4);
  const { elements, skipped } = markdownElements(src, { gfm: true, ...options });
  placeElements(doc, page, elements, [50, 50, 495, 742]);
  return { doc, page, skipped };
};

describe('markdownElements: blocks', () => {
  it('a paragraph becomes one element', () => {
    expect(markdownElements('hello').elements).toHaveLength(1);
  });

  it('headings take their level size and family', () => {
    const { elements } = markdownElements('# One\n\n### Three');
    const h = (el: any) => el.measure({ width: 400, availHeight: 500 }).usedHeight;
    // Default leading is 1.2 * fontSize inside a text block, sizes 24 and 14.
    expect(h(elements[0])).toBeCloseTo(24 * 1.2, 6);
    expect(h(elements[1])).toBeCloseTo(14 * 1.2, 6);
  });

  it('a thematic break becomes a rule of the styled thickness', () => {
    const { page } = render('a\n\n---\n\nb', { style: { rule: { thickness: 2 } } });
    expect(cs(page)).toMatch(/ 2 re\nf\n/);
  });

  it('a fenced code block preserves indentation, read back through extraction', () => {
    const { page } = render('```\nif (x) {\n    return 1;\n}\n```');
    expect(page.GetText()).toContain('    return 1;');
  });

  it('a code block drops the single trailing newline the AST carries', () => {
    // literal is "a\nb\n"; three emitted lines would mean a blank last line.
    const { elements } = markdownElements('```\na\nb\n```');
    const m = (elements[0] as any).measure({ width: 400, availHeight: 500 });
    const one = (markdownElements('```\na\n```').elements[0] as any)
      .measure({ width: 400, availHeight: 500 });
    expect(m.usedHeight - one.usedHeight).toBeGreaterThan(0);
    // Exactly one extra line, not two.
    const three = (markdownElements('```\na\nb\nc\n```').elements[0] as any)
      .measure({ width: 400, availHeight: 500 });
    expect(three.usedHeight - m.usedHeight).toBeCloseTo(m.usedHeight - one.usedHeight, 6);
  });

  it('a block quote indents and bars its children', () => {
    const { page } = render('> quoted text\n>\n> second para');
    const s = cs(page);
    expect(s).toMatch(/50 \d+(\.\d+)? 3 \d/); // a bar at the rect's left edge
    expect(s).toMatch(/1 0 0 1 (6[6-9]|7[0-9])(\.\d+)? /); // text indented ~17.6pt
  });

  // Read through GetPaths rather than the content stream: the vector extractor
  // is outside the code path that emitted the bar, so it cannot agree with a
  // bug by construction. cs() above pins the operators; this pins the geometry.
  it('a nested quote composes two indents and two bars', () => {
    const { page } = render('> outer\n>\n> > inner');
    const bars = page.GetPaths().filter((p) => p.fill !== null && p.bbox[2] - p.bbox[0] < 6);
    expect(bars.length).toBeGreaterThanOrEqual(2);
    const xs = [...new Set(bars.map((p) => Math.round(p.bbox[0])))].sort((a, b) => a - b);
    expect(xs.length).toBeGreaterThanOrEqual(2);
    expect(xs[0]).toBe(50);              // the outer bar at the rect edge
    // The inner bar is one quote indent (11 * 1.6 = 17.6pt) further in. Asserted
    // as a range, not a rounded equality: the point is that it composed, and a
    // half-point tolerance on a rounded value is a flake waiting to happen.
    expect(xs[1] - xs[0]).toBeGreaterThan(10);
    expect(xs[1] - xs[0]).toBeLessThan(25);
  });

  it('accepts an already parsed tree, so a caller need not re-parse', async () => {
    const { parseMarkdown } = await import('../src/markdown.js');
    const tree = parseMarkdown('# Title');
    expect(markdownElements(tree).elements).toHaveLength(1);
  });

  it('reports a table and raw HTML without dropping the rest', () => {
    const { elements, skipped } = markdownElements(
      'before\n\n| a | b |\n| - | - |\n| 1 | 2 |\n\n<div>x</div>\n\nafter',
      { gfm: true });
    expect(skipped).toEqual(['table', 'html_block']);
    expect(elements).toHaveLength(2); // before, after
  });

  it('never throws on any input', () => {
    for (const src of ['', '   ', '#', '```', '> > > >', ' ', '![](']) {
      expect(() => markdownElements(src, { gfm: true })).not.toThrow();
    }
  });

  it('validates its style before building anything', () => {
    expect(() => markdownElements('x', { style: { fontSize: -1 } })).toThrow(TypeError);
  });
});
```

Note the `await import` inside a non-async test: change that test to `it('accepts an already parsed tree...', async () => {`.

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/markdown-flow.test.ts`
Expected: FAIL — cannot resolve `../src/mdflow.js`.

- [ ] **Step 3: Create `src/mdflow.ts`**

```ts
/** The Markdown AST to a flat list of Flow elements.
 *
 *  This module owns the MAPPING and nothing else: it knows about columns,
 *  rects and pagination not at all. Both consumers — Flow's column engine and
 *  flowplace.ts's rect placer — take the `FlowElement[]` it returns, which is
 *  what makes three entry points cost one implementation.
 *
 *  Nothing here throws on document content. Every string is a valid CommonMark
 *  document (see markdown.ts), so damage shows up as literal text; the only
 *  TypeErrors come from the caller's own options. */

import { parseMarkdown, type MarkdownOptions } from './markdown.js';
import type {
  MdBlock, MdCodeBlock, MdDocument, MdHeading, MdParagraph,
} from './mdast.js';
import type { FlowElement } from './flowelement.js';
import { paragraph, heading } from './flow.js';
import { codeBlock, quote, rule } from './flowblock.js';
import { inlineRuns } from './mdruns.js';
import { resolveMarkdownStyle, type MarkdownStyle, type ResolvedMarkdownStyle } from './mdstyle.js';

/** Options for the Markdown entry points. Extends {@link MarkdownOptions}, so
 *  `{ gfm: true }` reaches the parser unchanged. */
export interface MarkdownFlowOptions extends MarkdownOptions {
  /** How it renders. Every field optional; see {@link MarkdownStyle}. */
  style?: MarkdownStyle;
  /** Supply the bytes for an image destination. `data:` URIs are decoded
   *  without it, since that needs no I/O and this library's core never touches
   *  `fs`. Return `undefined` for a destination you cannot resolve: the image
   *  falls back to its alt text and names itself in `skipped`. */
  resolveImage?: (destination: string, title: string) => Uint8Array | undefined;
}

/** What {@link markdownElements} produced. */
export interface MarkdownElements {
  /** The mapped elements, ready for a Flow or for `placeElements`. */
  elements: FlowElement[];
  /** Every construct that did not render, in document order: `'table'`,
   *  `'html_block'`, `'html_inline'`, `'image:<destination>'`. Without this a
   *  caller cannot distinguish a dropped table from an empty document. */
  skipped: string[];
}

/** @internal Everything the per-node builders need. */
interface Ctx {
  st: ResolvedMarkdownStyle;
  opts: MarkdownFlowOptions;
  skipped: string[];
}

function paragraphElements(n: MdParagraph, c: Ctx, extraBefore: number): FlowElement[] {
  const runs = inlineRuns(n.children, c.st, { family: c.st.family, fontSize: c.st.fontSize },
    c.skipped);
  return paragraph(runs, {
    font: c.st.family.regular,
    fontSize: c.st.fontSize,
    color: c.st.color,
    leading: c.st.leading,
    align: c.st.align,
    spaceBefore: extraBefore,
    spaceAfter: c.st.paragraphSpacing,
  });
}

function headingElements(n: MdHeading, c: Ctx, extraBefore: number): FlowElement[] {
  const size = c.st.heading.sizes[n.level - 1];
  const runs = inlineRuns(n.children, c.st, { family: c.st.heading.family, fontSize: size },
    c.skipped);
  return heading(n.level, runs, {
    font: c.st.heading.family.regular,
    fontSize: size,
    color: c.st.heading.color,
    align: c.st.align === 'justify' ? 'left' : c.st.align,
    spaceBefore: c.st.heading.spaceBefore + extraBefore,
    spaceAfter: c.st.heading.spaceAfter,
  });
}

function codeElements(n: MdCodeBlock, c: Ctx, extraBefore: number): FlowElement[] {
  // The AST's literal ends with the newline that closed its last line; emitting
  // it would add a blank line at the bottom of every code block.
  const literal = n.literal.endsWith('\n') ? n.literal.slice(0, -1) : n.literal;
  return codeBlock(literal, {
    font: c.st.code.font,
    fontSize: c.st.code.fontSize,
    color: c.st.code.color,
    background: c.st.code.background,
    padding: c.st.code.padding,
    spaceBefore: c.st.code.spaceBefore + extraBefore,
    spaceAfter: c.st.code.spaceAfter + c.st.paragraphSpacing,
  });
}

/** Map one block. `extraBefore` is added to the element's own `spaceBefore`,
 *  which is how a loose list item opens a gap above its first extra block.
 *  @internal */
function blockToElements(n: MdBlock, c: Ctx, extraBefore: number): FlowElement[] {
  switch (n.type) {
    case 'paragraph': return paragraphElements(n, c, extraBefore);
    case 'heading': return headingElements(n, c, extraBefore);
    case 'code_block': return codeElements(n, c, extraBefore);
    case 'thematic_break':
      return rule({
        thickness: c.st.rule.thickness,
        color: c.st.rule.color,
        spaceBefore: c.st.rule.spaceBefore + extraBefore,
        spaceAfter: c.st.rule.spaceAfter,
      });
    case 'block_quote':
      return quote(blockElements(n.children, c, 0), {
        indent: c.st.quote.indent,
        bar: c.st.quote.bar,
        spaceBefore: c.st.quote.spaceBefore + extraBefore,
        spaceAfter: c.st.quote.spaceAfter + c.st.paragraphSpacing,
      });
    // gl6o.3.3 owns tables; raw HTML is out of scope by design (mdast.ts has
    // recorded that since gl6o.1). Both name themselves rather than vanishing.
    case 'table': c.skipped.push('table'); return [];
    case 'html_block': c.skipped.push('html_block'); return [];
    default: return [];
  }
}

/** Map a run of sibling blocks. `spaceBeforeFirst` applies to the first element
 *  produced, and to nothing else.
 *
 *  NOT exported: its `Ctx` parameter is module-private, and an exported function
 *  naming a private type fails `.d.ts` emit (`npm run build`). @internal */
function blockElements(
  blocks: MdBlock[], c: Ctx, spaceBeforeFirst: number,
): FlowElement[] {
  const out: FlowElement[] = [];
  for (const b of blocks) {
    out.push(...blockToElements(b, c, out.length === 0 ? spaceBeforeFirst : 0));
  }
  return out;
}

/** Lower a Markdown document to Flow elements.
 *
 *  `src` may be source text (parsed here, with `options` forwarded to
 *  `parseMarkdown`) or an already parsed tree, so a caller that wants to inspect
 *  or rewrite the AST first is not forced to re-parse. */
export function markdownElements(
  src: string | MdDocument, options: MarkdownFlowOptions = {},
): MarkdownElements {
  if (options.resolveImage !== undefined && typeof options.resolveImage !== 'function')
    throw new TypeError('resolveImage must be a function');
  // Validate the whole style before building anything, so a rejected call
  // leaves the document byte-identical.
  const st = resolveMarkdownStyle(options.style);
  const doc = typeof src === 'string' ? parseMarkdown(src, options) : src;
  const c: Ctx = { st, opts: options, skipped: [] };
  return { elements: blockElements(doc.children, c, 0), skipped: c.skipped };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run test/markdown-flow.test.ts`
Expected: PASS (the list and image cases are not written yet).

- [ ] **Step 5: Prove the trailing-newline trim is load-bearing**

Temporarily change `codeElements` to use `n.literal` directly.

Run: `npx vitest run test/markdown-flow.test.ts -t "trailing newline"`
Expected: FAIL.

Revert. Re-run. Expected: PASS.

- [ ] **Step 6: Typecheck and commit**

Run: `npm run typecheck && npm test`
Expected: clean.

```bash
git add src/mdflow.ts test/markdown-flow.test.ts
git commit -m "$(cat <<'EOF'
feat(markdown): map paragraphs, headings, code, quotes and rules to Flow

mdflow.ts owns the mapping and nothing else — no columns, no rects, no
pagination — so its FlowElement[] serves the column engine and the rect placer
alike. Tables and raw HTML name themselves in `skipped` rather than vanishing.

Code-block indentation is asserted by reading the rendered page back through
GetText(), which is outside the code path that produced it.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 14: `mdflow.ts` — lists

**Files:**
- Modify: `src/mdflow.ts` (add the `list` case)
- Modify: `test/markdown-flow.test.ts` (append)

Markdown items nest arbitrarily. Every item lowers through `FlowListItem.blocks` from Task 8, and a nested list is just another block inside its parent item — so indents compose and the nested `/L` lands under the parent's `/LBody` with no second mechanism.

**Interfaces:**
- Consumes: `list`, `FlowListItem`, `FlowListNode` from `flow.js`; Task 8's `blocks` and Task 9's `marker`.
- Produces: `blockToElements` handles `'list'`.

- [ ] **Step 1: Write the failing test**

Append to `test/markdown-flow.test.ts`:

```ts
describe('markdownElements: lists', () => {
  it('a bullet list lowers to one element per item', () => {
    expect(markdownElements('- a\n- b\n- c').elements).toHaveLength(3);
  });

  it('an ordered list carries its start ordinal', () => {
    const { page } = render('5. five\n6. six');
    expect(page.GetText()).toContain('5.');
    expect(page.GetText()).toContain('6.');
  });

  it('a multi-paragraph item lowers to a body plus a block', () => {
    // A loose item: two paragraphs in one list item.
    expect(markdownElements('- first\n\n  second').elements).toHaveLength(2);
  });

  it('a nested list composes indents rather than restarting at the margin', () => {
    const { page } = render('- outer\n  - inner');
    const xs = [...cs(page).matchAll(/1 0 0 1 (\d+(?:\.\d+)?) /g)].map((m) => Number(m[1]));
    expect(xs.length).toBeGreaterThanOrEqual(2);
    expect(Math.max(...xs)).toBeGreaterThan(Math.min(...xs));
  });

  it('a code block inside an item still draws the item marker', () => {
    const { page } = render('- item text\n\n  ```\n  code\n  ```');
    expect(page.GetText()).toContain('code');
  });

  it('an item whose first block is a code block draws a marker', () => {
    const { page } = render('-     indented code\n');
    expect(cs(page)).toMatch(/ re\nf\n/); // the vector bullet
  });

  // The AST field no HTML rendering can see, and the reason mdast.ts records it.
  it('a loose list spaces its items more widely than a tight one', () => {
    const height = (src: string) => {
      const doc = Document.New();
      const { page } = doc.AddPage(PageFormat.A4);
      const { elements } = markdownElements(src);
      return placeElements(doc, page, elements, [50, 50, 495, 742]).usedHeight;
    };
    expect(height('- a\n\n- b')).toBeGreaterThan(height('- a\n- b'));
  });

  it('a task list draws checkboxes and distinguishes checked from unchecked', () => {
    const un = render('- [ ] todo', {}).page;
    const on = render('- [x] done', {}).page;
    expect(cs(on).length).toBeGreaterThan(cs(un).length);
  });

  it('an empty item renders nothing and does not throw', () => {
    const { elements } = markdownElements('-\n- b');
    const doc = Document.New();
    const { page } = doc.AddPage(PageFormat.A4);
    expect(() => placeElements(doc, page, elements, [50, 50, 495, 742])).not.toThrow();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/markdown-flow.test.ts -t "lists"`
Expected: FAIL — `markdownElements('- a\n- b\n- c').elements` is empty; `'list'` falls through to `default`.

- [ ] **Step 3: Add the list mapping to `src/mdflow.ts`**

Add the imports:

```ts
import { list, type FlowListItem, type FlowListNode } from './flow.js';
import type { MdItem, MdList } from './mdast.js';
```

Add the two functions before `blockToElements`:

```ts
/** One Markdown item as a Flow list node.
 *
 *  The item's leading paragraph becomes the body text so it shares the marker's
 *  line; everything after it — further paragraphs, a code block, a quote, a
 *  NESTED LIST — becomes `blocks`, placed at the item's own indent under its
 *  `/LBody`. A nested list is not special-cased: it is a block like any other,
 *  so its indent composes with its parent's and its `/L` lands under the parent
 *  item's `/LBody` through the same path. */
function itemNode(item: MdItem, parent: MdList, c: Ctx): FlowListItem {
  const kids = item.children;
  const leading = kids.length > 0 && kids[0].type === 'paragraph'
    ? (kids[0] as MdParagraph) : undefined;
  const text = leading
    ? inlineRuns(leading.children, c.st, { family: c.st.family, fontSize: c.st.fontSize },
      c.skipped)
    : undefined;
  // A loose item opens a gap above its second block; a tight one does not.
  const gap = parent.tight ? 0 : c.st.paragraphSpacing;
  const blocks = blockElements(leading ? kids.slice(1) : kids, c, gap);

  const node: FlowListItem = {};
  // An item with neither text nor blocks (`- ` on its own) still needs a body:
  // an empty run list draws nothing and the engine discards it.
  if (text !== undefined) node.text = text;
  else if (blocks.length === 0) node.text = [];
  if (blocks.length > 0) node.blocks = blocks;
  if (item.checked !== undefined) node.marker = item.checked ? 'checked' : 'checkbox';
  return node;
}

function listElements(n: MdList, c: Ctx, extraBefore: number): FlowElement[] {
  const items: FlowListNode[] = n.children.map((it) => itemNode(it, n, c));
  return list(items, {
    ordered: n.ordered,
    start: n.start,
    bullet: c.st.list.bullet,
    font: c.st.family.regular,
    fontSize: c.st.fontSize,
    color: c.st.color,
    leading: c.st.leading,
    align: c.st.align,
    indent: c.st.list.indent,
    // Tightness is the one mapping decision no HTML rendering can see.
    itemSpacing: n.tight ? c.st.list.itemSpacing : c.st.paragraphSpacing,
    spaceBefore: c.st.list.spaceBefore + extraBefore,
    spaceAfter: c.st.list.spaceAfter + c.st.paragraphSpacing,
  });
}
```

And the case in `blockToElements`:

```ts
    case 'list': return listElements(n, c, extraBefore);
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run test/markdown-flow.test.ts`
Expected: PASS.

- [ ] **Step 5: Prove the tightness mapping is load-bearing**

Temporarily change `itemSpacing` to `c.st.list.itemSpacing` unconditionally.

Run: `npx vitest run test/markdown-flow.test.ts -t "loose list spaces"`
Expected: FAIL.

Revert. Re-run. Expected: PASS.

- [ ] **Step 6: Typecheck, full suite, commit**

Run: `npm run typecheck && npm test`
Expected: clean.

```bash
git add src/mdflow.ts test/markdown-flow.test.ts
git commit -m "$(cat <<'EOF'
feat(markdown): map lists, including multi-block and task items

An item's leading paragraph becomes the body text so it shares the marker's
line; everything after it becomes blocks at the item's own indent. A nested
list is not special-cased — it is a block like any other, so indents compose
and its /L lands under the parent item's /LBody through the same path.

Tightness drives item spacing, asserted on rendered heights: it is invisible to
every HTML oracle and is the field mdast.ts records for exactly this.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 15: `mdflow.ts` — images

**Files:**
- Modify: `src/mdflow.ts` (the lone-image lift and the resolver)
- Modify: `test/markdown-flow.test.ts` (append)

`MdImage` is an inline node, but a paragraph whose only content is one image is the shape every author means as a figure. `data:` URIs decode without a callback; everything else goes through `resolveImage`, and an unresolved destination falls back to alt text and reports itself rather than throwing.

**Interfaces:**
- Consumes: `image` from `flow.js`, `plainText` from `mdruns.js`, `MarkdownFlowOptions.resolveImage` (Task 13).
- Produces: no new exported names. `blockToElements`'s `'paragraph'` case lifts a lone image.

- [ ] **Step 1: Write the failing test**

Append to `test/markdown-flow.test.ts`:

```ts
import { buildPngRgb } from './helpers/build-embed-images.js';

/** buildPngRgb() as a base64 data: URI. */
const dataUri = (): string =>
  `data:image/png;base64,${Buffer.from(buildPngRgb()).toString('base64')}`;

describe('markdownElements: images', () => {
  it('a paragraph holding only an image becomes an image block', () => {
    const { elements, skipped } = markdownElements(`![a cat](${dataUri()})`);
    expect(elements).toHaveLength(1);
    expect(skipped).toEqual([]);
    // An image element measures by aspect, not by leading: 2x1 at 400 wide.
    expect((elements[0] as any).measure({ width: 400, availHeight: 500 }).usedHeight)
      .toBeCloseTo(200, 6);
  });

  it('resolves a plain destination through the callback', () => {
    const seen: string[] = [];
    const { elements, skipped } = markdownElements('![cat](cat.png "T")', {
      resolveImage: (d, t) => { seen.push(`${d}|${t}`); return buildPngRgb(); },
    });
    expect(seen).toEqual(['cat.png|T']);
    expect(skipped).toEqual([]);
    expect(elements).toHaveLength(1);
  });

  it('an unresolved destination falls back to alt text and reports itself', () => {
    const { elements, skipped } = markdownElements('![a cat](missing.png)');
    expect(skipped).toEqual(['image:missing.png']);
    expect(elements).toHaveLength(1);
    const doc = Document.New();
    const { page } = doc.AddPage(PageFormat.A4);
    placeElements(doc, page, elements, [50, 50, 495, 742]);
    expect(page.GetText()).toContain('a cat');
  });

  it('undecodable bytes report and fall back rather than throwing', () => {
    const { skipped } = markdownElements('![alt](x.png)', {
      resolveImage: () => new Uint8Array([1, 2, 3]),
    });
    expect(skipped).toEqual(['image:x.png']);
  });

  it('an image beside other content stays inline: alt text, reported once', () => {
    const { elements, skipped } = markdownElements(`see ![a cat](${dataUri()}) here`);
    expect(elements).toHaveLength(1);
    expect(skipped).toHaveLength(1);
    const doc = Document.New();
    const { page } = doc.AddPage(PageFormat.A4);
    placeElements(doc, page, elements, [50, 50, 495, 742]);
    expect(page.GetText()).toContain('see a cat here');
  });

  it('surrounding whitespace does not stop the lift', () => {
    expect(markdownElements(`  ![x](${dataUri()})  `).skipped).toEqual([]);
  });

  it('carries the alt text onto the figure', () => {
    const doc = Document.New();
    const flow = doc.NewFlow({ format: PageFormat.A4, tagged: true });
    const { elements } = markdownElements(`![the alt](${dataUri()})`);
    for (const el of elements) (flow as any).items.push(el);
    flow.Render();
    expect(JSON.stringify(doc.GetStructTree())).toContain('the alt');
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/markdown-flow.test.ts -t "images"`
Expected: FAIL — a lone image currently renders as an empty paragraph.

- [ ] **Step 3: Add the image path to `src/mdflow.ts`**

Extend the existing imports — `inlineRuns` is already imported from `./mdruns.js`, so add `plainText` to that clause rather than writing a second one:

```ts
import { image } from './flow.js';                     // add to the ./flow.js clause
import { inlineRuns, plainText } from './mdruns.js';   // plainText is the addition
import type { MdImage, MdInline } from './mdast.js';   // add to the ./mdast.js clause
```

Add before `paragraphElements`:

```ts
/** The single image a paragraph consists of, ignoring surrounding whitespace and
 *  soft breaks; undefined for a paragraph that holds anything else. This is the
 *  shape every Markdown author means as a figure. */
function loneImage(children: MdInline[]): MdImage | undefined {
  const meaningful = children.filter((n) =>
    !(n.type === 'softbreak')
    && !(n.type === 'text' && n.value.trim() === ''));
  return meaningful.length === 1 && meaningful[0].type === 'image'
    ? meaningful[0] : undefined;
}

/** Decode a `data:` URI's payload. Returns undefined for anything else — including
 *  a malformed one, which is a destination we cannot resolve, not an error. */
function decodeDataUri(dest: string): Uint8Array | undefined {
  const comma = dest.indexOf(',');
  if (!dest.startsWith('data:') || comma < 0) return undefined;
  const meta = dest.slice(5, comma);
  const payload = dest.slice(comma + 1);
  try {
    if (/;base64$/i.test(meta)) return new Uint8Array(Buffer.from(payload, 'base64'));
    return new TextEncoder().encode(decodeURIComponent(payload));
  } catch {
    return undefined;
  }
}

/** An image block for `n`, or undefined when its bytes cannot be had or decoded.
 *  Never throws: a figure that will not render must cost its own ink, not the
 *  document. */
function imageElement(n: MdImage, c: Ctx, extraBefore: number): FlowElement[] | undefined {
  const data = decodeDataUri(n.destination)
    ?? c.opts.resolveImage?.(n.destination, n.title);
  if (data === undefined) return undefined;
  const alt = plainText(n.children);
  try {
    return image(data, {
      align: c.st.image.align,
      alt: alt === '' ? undefined : alt,
      spaceBefore: c.st.image.spaceBefore + extraBefore,
      spaceAfter: c.st.image.spaceAfter + c.st.paragraphSpacing,
    });
  } catch {
    // buildImageXObject rejects anything that is not JPEG or PNG.
    return undefined;
  }
}
```

Change `paragraphElements` to lift a lone image first:

```ts
function paragraphElements(n: MdParagraph, c: Ctx, extraBefore: number): FlowElement[] {
  const img = loneImage(n.children);
  if (img !== undefined) {
    const els = imageElement(img, c, extraBefore);
    if (els !== undefined) return els;
    // Unresolvable: report it once here, and let the alt text render below.
    // inlineRuns would otherwise report it a second time.
    c.skipped.push(`image:${img.destination}`);
    return paragraph(
      inlineRuns(img.children, c.st, { family: c.st.family, fontSize: c.st.fontSize }, c.skipped),
      {
        font: c.st.family.regular, fontSize: c.st.fontSize, color: c.st.color,
        leading: c.st.leading, align: c.st.align,
        spaceBefore: extraBefore, spaceAfter: c.st.paragraphSpacing,
      });
  }
  const runs = inlineRuns(n.children, c.st, { family: c.st.family, fontSize: c.st.fontSize },
    c.skipped);
  return paragraph(runs, {
    font: c.st.family.regular,
    fontSize: c.st.fontSize,
    color: c.st.color,
    leading: c.st.leading,
    align: c.st.align,
    spaceBefore: extraBefore,
    spaceAfter: c.st.paragraphSpacing,
  });
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run test/markdown-flow.test.ts`
Expected: PASS, including the earlier `never throws on any input` case.

- [ ] **Step 5: Typecheck, full suite, commit**

Run: `npm run typecheck && npm test`
Expected: clean.

```bash
git add src/mdflow.ts test/markdown-flow.test.ts
git commit -m "$(cat <<'EOF'
feat(markdown): render a lone-image paragraph as a figure

data: URIs decode with no callback, since that needs no I/O and this library's
core never touches fs; everything else goes through options.resolveImage. An
unresolved or undecodable destination falls back to its alt text and names
itself in `skipped` — visible content beats a silently dropped subtree, which
is the rule svgdraw.ts already sets.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 16: `Flow.AddMarkdown`

**Files:**
- Modify: `src/flow.ts` (the method)
- Create: `test/markdown-render.test.ts`

**Interfaces:**
- Consumes: `markdownElements`, `MarkdownFlowOptions`, `MarkdownElements` (Tasks 13-15).
- Produces: `Flow.AddMarkdown(src: string | MdDocument, options?: MarkdownFlowOptions): MarkdownResult`, where `interface MarkdownResult { skipped: string[] }` is exported from `mdflow.ts`.

  This is the one `Flow.Add*` that returns a value rather than `this`. Without it a caller cannot distinguish a dropped table from an empty document, and the chainable alternative buys nothing a second statement does not.

- [ ] **Step 1: Add `MarkdownResult` to `src/mdflow.ts`**

```ts
/** What a Markdown entry point reports. */
export interface MarkdownResult {
  /** Every construct that did not render; see {@link MarkdownElements.skipped}. */
  skipped: string[];
}
```

and change `MarkdownElements` to extend it:

```ts
export interface MarkdownElements extends MarkdownResult {
  elements: FlowElement[];
}
```

- [ ] **Step 2: Write the failing test**

Create `test/markdown-render.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { PageFormat } from '../src/pageformat.js';

const SRC = [
  '# Title',
  '',
  'A paragraph with **bold**, *italic* and `code` in it, long enough to wrap',
  'across more than one line of a narrow column so pagination has work to do.',
  '',
  '- first item',
  '- second item',
  '',
  '> quoted',
  '',
  '```',
  'code line',
  '```',
  '',
  '---',
].join('\n');

describe('Flow.AddMarkdown', () => {
  it('renders a document and reports nothing skipped', () => {
    const doc = Document.New();
    const flow = doc.NewFlow({ format: PageFormat.A4 });
    const res = flow.AddMarkdown(SRC);
    expect(res.skipped).toEqual([]);
    const pages = flow.Render();
    const text = pages[0].GetText();
    expect(text).toContain('Title');
    expect(text).toContain('first item');
    expect(text).toContain('quoted');
    expect(text).toContain('code line');
  });

  it('mixes with hand-built content in one flow', () => {
    const doc = Document.New();
    const flow = doc.NewFlow({ format: PageFormat.A4 });
    flow.AddHeading(1, 'Hand built');
    flow.AddMarkdown('from markdown');
    flow.AddParagraph('hand built again');
    const text = flow.Render()[0].GetText();
    expect(text).toContain('Hand built');
    expect(text).toContain('from markdown');
    expect(text).toContain('hand built again');
  });

  it('reports what it skipped', () => {
    const doc = Document.New();
    const flow = doc.NewFlow({ format: PageFormat.A4 });
    const res = flow.AddMarkdown('a\n\n| x | y |\n| - | - |\n| 1 | 2 |', { gfm: true });
    expect(res.skipped).toEqual(['table']);
  });

  it('tags headings, paragraphs and lists under a tagged flow', () => {
    const doc = Document.New();
    const flow = doc.NewFlow({ format: PageFormat.A4, tagged: true });
    flow.AddMarkdown('# T\n\npara\n\n- a\n- b');
    flow.Render();
    const dump = JSON.stringify(doc.GetStructTree());
    for (const t of ['H1', 'P', 'L', 'LI', 'Lbl', 'LBody']) expect(dump).toContain(t);
  });

  it('paginates across columns and pages', () => {
    const doc = Document.New();
    const flow = doc.NewFlow({ format: PageFormat.A4, columns: 2 });
    flow.AddMarkdown(`${SRC}\n\n${SRC}\n\n${SRC}\n\n${SRC}\n\n${SRC}`);
    const pages = flow.Render();
    expect(pages.length).toBeGreaterThanOrEqual(1);
    expect(pages[0].GetText().length).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `npx vitest run test/markdown-render.test.ts`
Expected: FAIL — `flow.AddMarkdown is not a function`.

- [ ] **Step 4: Add the method to `src/flow.ts`**

Add the import:

```ts
import { markdownElements, type MarkdownFlowOptions, type MarkdownResult } from './mdflow.js';
import type { MdDocument } from './mdast.js';
```

and the method after `AddQuote`:

```ts
  /** Append a Markdown document: CommonMark 0.31.2, or GFM with
   *  `{ gfm: true }`. Headings, paragraphs, lists (tight/loose, task items),
   *  code blocks, block quotes, thematic breaks and figures all map onto flow
   *  elements, so the result paginates, tags and mixes with hand-built content
   *  like any other flow.
   *
   *  Unlike the other `Add*` methods this returns a report rather than `this`:
   *  `skipped` names every construct that did not render (a table, raw HTML, an
   *  image whose destination could not be resolved), and without it a caller
   *  cannot tell a dropped table from an empty document. */
  AddMarkdown(src: string | MdDocument, options: MarkdownFlowOptions = {}): MarkdownResult {
    const { elements, skipped } = markdownElements(src, options);
    this.items.push(...elements);
    return { skipped };
  }
```

- [ ] **Step 5: Run to verify it passes**

Run: `npx vitest run test/markdown-render.test.ts`
Expected: PASS.

- [ ] **Step 6: Typecheck, full suite, commit**

Run: `npm run typecheck && npm test`
Expected: clean.

```bash
git add src/mdflow.ts src/flow.ts test/markdown-render.test.ts
git commit -m "$(cat <<'EOF'
feat(markdown): Flow.AddMarkdown

Markdown becomes ordinary flow elements, so it paginates, tags and mixes with
hand-built content. The one Flow.Add* that returns a report rather than `this`:
without it a caller cannot tell a dropped table from an empty document.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 17: `Page.AddMarkdown` and `Document.AddMarkdown`

**Files:**
- Modify: `src/page.ts` (after `AddTextBlock`, around line 490)
- Modify: `src/document.ts` (near `NewFlow`, around line 1947)
- Modify: `test/markdown-render.test.ts` (append)

**Interfaces:**
- Consumes: `placeElements` (Task 10), `markdownElements` (Tasks 13-15).
- Produces:
  - `Page.AddMarkdown(src, rect: [number, number, number, number], options?: MarkdownFlowOptions & { paragraphSpacing?: number; structParent?: StructElement }): AddMarkdownResult`
  - `interface AddMarkdownResult extends MarkdownResult { usedHeight: number; remainder: FlowElement[] }` — exported from `mdflow.ts`
  - `Document.AddMarkdown(src, options?: MarkdownFlowOptions & FlowOptions): { pages: Page[]; skipped: string[] }`

- [ ] **Step 1: Write the failing test**

Append to `test/markdown-render.test.ts`:

```ts
import { placeElements } from '../src/flowplace.js';

describe('Page.AddMarkdown', () => {
  it('lays markdown into a rect and reports what it used', () => {
    const doc = Document.New();
    const { page } = doc.AddPage(PageFormat.A4);
    const res = page.AddMarkdown('# Title\n\nbody text', [50, 400, 300, 300]);
    expect(res.skipped).toEqual([]);
    expect(res.remainder).toEqual([]);
    expect(res.usedHeight).toBeGreaterThan(0);
    expect(page.GetText()).toContain('Title');
  });

  it('hands back a remainder that continues into another rect', () => {
    const doc = Document.New();
    const { page } = doc.AddPage(PageFormat.A4);
    const first = page.AddMarkdown(SRC, [50, 700, 200, 60]);
    expect(first.remainder.length).toBeGreaterThan(0);
    const rest = placeElements(doc, page, first.remainder, [300, 100, 200, 600]);
    expect(rest.usedHeight).toBeGreaterThan(0);
  });

  it('validates its rect', () => {
    const doc = Document.New();
    const { page } = doc.AddPage(PageFormat.A4);
    expect(() => page.AddMarkdown('x', [0, 0, 0, 100])).toThrow(TypeError);
  });
});

describe('Document.AddMarkdown', () => {
  it('renders a whole document in one call', () => {
    const doc = Document.New();
    const res = doc.AddMarkdown(SRC, { format: PageFormat.A4, columns: 2 });
    expect(res.pages.length).toBeGreaterThanOrEqual(1);
    expect(res.skipped).toEqual([]);
    expect(res.pages[0].GetText()).toContain('Title');
  });
});

// The assertion that stops the rect placer and the column engine from drifting.
describe('the three entry points agree', () => {
  const textOf = (page: { GetText(): string }) => page.GetText().replace(/\s+/g, ' ').trim();

  it('produce the same text for the same source', () => {
    const viaFlow = (() => {
      const doc = Document.New();
      const flow = doc.NewFlow({ format: PageFormat.A4 });
      flow.AddMarkdown(SRC);
      return textOf(flow.Render()[0]);
    })();
    const viaDocument = (() => {
      const doc = Document.New();
      return textOf(doc.AddMarkdown(SRC, { format: PageFormat.A4 }).pages[0]);
    })();
    const viaPage = (() => {
      const doc = Document.New();
      const { page } = doc.AddPage(PageFormat.A4);
      // The same content box a default A4 flow uses: 72pt margins.
      page.AddMarkdown(SRC, [72, 72, 595.28 - 144, 841.89 - 144]);
      return textOf(page);
    })();
    expect(viaDocument).toBe(viaFlow);
    expect(viaPage).toBe(viaFlow);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/markdown-render.test.ts`
Expected: FAIL — `page.AddMarkdown is not a function`.

- [ ] **Step 3: Add `AddMarkdownResult` to `src/mdflow.ts`**

```ts
/** What {@link Page.AddMarkdown} reports. */
export interface AddMarkdownResult extends MarkdownResult {
  /** Vertical space consumed, from the rect's top edge. */
  usedHeight: number;
  /** Elements that did not fit, ready to pass to another `AddMarkdown` (via
   *  `placeElements`) — `[]` when everything fit. */
  remainder: FlowElement[];
}
```

- [ ] **Step 4: Add `Page.AddMarkdown`**

In `src/page.ts`, add the imports:

```ts
import { markdownElements, type AddMarkdownResult, type MarkdownFlowOptions } from './mdflow.js';
import { placeElements } from './flowplace.js';
import type { MdDocument } from './mdast.js';
import type { StructElement } from './struct.js';
```

(skip any that are already imported), and the method after `AddTextBlock`:

```ts
  /** Lay a Markdown document into the rectangle [x, y, w, h] (PDF user space,
   *  `y` the bottom edge) on this page. Existing content is preserved.
   *
   *  Returns `usedHeight`, the `skipped` report, and a `remainder` of the
   *  elements that did not fit — pass it to `placeElements` to continue into
   *  another rect or another page. For a document that should paginate itself,
   *  use `Document.AddMarkdown` or a `Flow`. */
  AddMarkdown(
    src: string | MdDocument,
    rect: [number, number, number, number],
    options: MarkdownFlowOptions & {
      /** Gap between consecutive blocks, on top of the style's own spacing.
       *  Default 0. */
      paragraphSpacing?: number;
      /** Grouping element the content tags under. Omit for untagged output. */
      structParent?: StructElement;
    } = {},
  ): AddMarkdownResult {
    const { elements, skipped } = markdownElements(src, options);
    const { usedHeight, remainder } = placeElements(this.doc, this, elements, rect, {
      paragraphSpacing: options.paragraphSpacing,
      structParent: options.structParent,
    });
    return { usedHeight, remainder, skipped };
  }
```

`Page`'s constructor declares `private readonly doc: Document`, so `this.doc` is the value to pass — the same one `AddTextBlock` hands to `stampTextBlock`.

- [ ] **Step 5: Add `Document.AddMarkdown`**

In `src/document.ts`, add the import:

```ts
import { markdownElements, type MarkdownFlowOptions } from './mdflow.js';
```

and the method beside `NewFlow`:

```ts
  /** Render a whole Markdown document, appending freshly sized pages to the end
   *  of this document. The one-call form of `NewFlow` + `AddMarkdown` +
   *  `Render`; `options` carries both the Markdown options (`gfm`, `style`,
   *  `resolveImage`) and the flow's page geometry (`format`, `columns`,
   *  `margin*`, `tagged`). */
  AddMarkdown(
    src: string | MdDocument, options: MarkdownFlowOptions & FlowOptions = {},
  ): { pages: Page[]; skipped: string[] } {
    const flow = new Flow(this, options);
    const { skipped } = flow.AddMarkdown(src, options);
    return { pages: flow.Render(), skipped };
  }
```

Add `import type { MdDocument } from './mdast.js';` if it is not already there.

- [ ] **Step 6: Run to verify it passes**

Run: `npx vitest run test/markdown-render.test.ts`
Expected: PASS, including the three-entry-point agreement.

- [ ] **Step 7: Typecheck, full suite, commit**

Run: `npm run typecheck && npm test`
Expected: clean.

```bash
git add src/mdflow.ts src/page.ts src/document.ts test/markdown-render.test.ts
git commit -m "$(cat <<'EOF'
feat(markdown): Page.AddMarkdown and Document.AddMarkdown

The rect form returns usedHeight plus a re-placeable remainder, mirroring
AddTextBlock and AddTable; the document form is the one-call NewFlow + render.
Both consume the same FlowElement[] as Flow.AddMarkdown, which is what makes
three entry points one implementation — asserted directly by rendering one
source through all three and comparing extracted text.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 18: Exports and documentation

**Files:**
- Modify: `src/index.ts:98-102`
- Modify: `README.md`
- Modify: `CLAUDE.md`

**Interfaces:**
- Consumes: every public name from Tasks 3, 5-11, 13-17.
- Produces: the public surface.

- [ ] **Step 1: Write the failing test**

Append to `test/markdown-render.test.ts`:

```ts
describe('public surface', () => {
  it('exports everything a caller needs from the package root', async () => {
    const api = await import('../src/index.js');
    for (const name of [
      'paragraph', 'heading', 'list', 'image', 'rule', 'codeBlock', 'quote',
      'placeElements', 'markdownElements', 'resolveMarkdownStyle',
    ]) {
      expect(typeof (api as any)[name]).toBe('function');
    }
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/markdown-render.test.ts -t "public surface"`
Expected: FAIL — `paragraph` is undefined.

- [ ] **Step 3: Export from `src/index.ts`**

Replace the Flow export block (around line 98-102) with:

```ts
export { Flow, paragraph, heading, list, image } from './flow.js';
export type {
  FlowOptions, FlowParagraphOptions, FlowHeadingOptions, FlowListOptions, FlowImageOptions,
  FlowListItem, FlowListNode, FlowElement, FlowClear, PlaceContext, PlaceResult,
} from './flow.js';

// --- Flow block vocabulary (gl6o.3.2) ---
export { rule, codeBlock, quote } from './flowblock.js';
export type { FlowRuleOptions, FlowCodeOptions, FlowQuoteOptions, FlowQuoteBar } from './flowblock.js';
export { placeElements } from './flowplace.js';
export type { PlaceElementsOptions, PlaceElementsResult } from './flowplace.js';

// --- Markdown rendering (gl6o.3.2) ---
export { markdownElements } from './mdflow.js';
export type {
  MarkdownFlowOptions, MarkdownElements, MarkdownResult, AddMarkdownResult,
} from './mdflow.js';
export { resolveMarkdownStyle, resolveFamily, faceFor } from './mdstyle.js';
export type {
  MarkdownStyle, MarkdownFontFamily, MarkdownFontSpec, ResolvedFamily,
} from './mdstyle.js';
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run test/markdown-render.test.ts -t "public surface"`
Expected: PASS.

- [ ] **Step 5: Update `README.md`**

In **Features**, under the content-authoring section, add:

```markdown
- **Markdown to PDF** — render CommonMark 0.31.2 (and GFM with `{ gfm: true }`)
  into a flow, into a rect on a page, or a whole document in one call:
  `flow.AddMarkdown`, `page.AddMarkdown`, `doc.AddMarkdown`. Headings,
  paragraphs with inline styling, lists (tight/loose, task items), code blocks,
  block quotes, thematic breaks and figures. Tables and links are pending.
- **Flow blocks** — `AddCodeBlock`, `AddQuote` and `AddRule` beside the existing
  `AddParagraph`/`AddHeading`/`AddList`/`AddImage`, with public element builders
  (`paragraph`, `heading`, `list`, `image`, `codeBlock`, `quote`, `rule`) for
  composing nested content.
```

In the **API overview**, add a Markdown section:

````markdown
### Markdown

```ts
import { Document, PageFormat } from 'aspose-pdf-foss-for-ts';

const doc = Document.New();
const { pages, skipped } = doc.AddMarkdown(source, {
  gfm: true,
  format: PageFormat.A4,
  columns: 2,
  style: { fontSize: 10, quote: { indent: 18 } },
  resolveImage: (dest) => readFileSync(join(base, dest)),
});
// skipped names anything that did not render: 'table', 'html_block',
// 'image:<destination>'.
```

Into an existing flow, mixed with hand-built content:

```ts
const flow = doc.NewFlow({ format: PageFormat.A4, tagged: true });
flow.AddHeading(1, 'Report');
flow.AddMarkdown(body, { gfm: true });
flow.Render();
```

Into a rect, continuing the overflow yourself:

```ts
const { remainder, usedHeight } = page.AddMarkdown(src, [72, 72, 451, 698]);
if (remainder.length) placeElements(doc, nextPage, remainder, [72, 72, 451, 698]);
```
````

Under **Limitations**, add: *Markdown tables and link annotations are not yet rendered (they are reported in `skipped`); raw HTML and syntax highlighting are out of scope.*

- [ ] **Step 6: Update `CLAUDE.md`**

Add to the Source section, after the `flow.ts`/`floatbox.ts`/`floatstack.ts` entry:

```markdown
- **flowelement.ts**, **flowblock.ts**, **flowplace.ts** — the Flow element
  protocol and the three block types Markdown needed and Flow lacked.
  `flowelement.ts` holds `FlowElement`/`PlaceContext`/`PlaceResult` and the
  shared spacing validators; it is its own module so `flowblock.ts` can
  implement the protocol while `flow.ts` imports its builders back, closing no
  cycle (the split `fieldstyle.ts` and `bordersides.ts` already make).
  `flowblock.ts` is `rule` (thematic break), `codeBlock` (preformatted) and
  `quote` (block quote); `flowplace.ts` is `placeElements`, the Render loop with
  columns, floats, keep-with-next and page creation removed, so a caller can lay
  elements into ONE rect and get the overflow back.
  **Invariant:** a container never holds and paginates its children. The engine
  is a flat queue, and a container with its own pagination loop is how a quote
  comes to break across a column under one rule and a list under another. A
  quote lowers to a flat array of single-child decorators, each owning an indent
  and its own ink; a split quote therefore needs no special case, and nesting is
  the decorator wrapping itself.
  **Invariant:** there is ONE builder per construct. `Flow.AddX`, a list item's
  `blocks` and the Markdown mapper all construct content, and three definitions
  of "a list" is three chances for them to disagree.
  **Invariant:** a code block substitutes U+00A0 for every space, in
  `preformat`, once. `layoutRuns` COLLAPSES runs of spaces (`a  b` lays out as
  `a b`), which is fatal to indentation, and a preserve-spaces mode would put
  every existing caller's byte-identity at risk. U+00A0 costs nothing instead:
  `winAnsi[0xA0]` is U+00A0, WinAnsiEncoding names that code `/space` (Annex D
  Table D.2's documented duplicate, recorded in `WIN_HIGH`), and its AFM advance
  is identical — 278 in Helvetica, 600 in Courier. Each source line then becomes
  one unbreakable unit, and an over-wide line falls through the existing UAX #14
  path instead of running off the page.
  **Invariant:** a list item's marker is owned by per-item state, not by one
  element. An item lowers to a body plus its `blocks`, and whichever draws FIRST
  paints the marker — with a private flag the text body owns it, so an item
  opening with a code block draws none at all.
- **mdstyle.ts**, **mdruns.ts**, **mdflow.ts** — Markdown rendering
  (`flow.AddMarkdown`, `page.AddMarkdown`, `doc.AddMarkdown`). Three pure layers
  lowering an `MdDocument` to a flat `FlowElement[]`: `mdstyle.ts` is the style
  vocabulary and its defaults, `mdruns.ts` maps inlines to `TextRun`s, and
  `mdflow.ts` maps blocks. Note the direction — nothing here parses; that is
  `markdown.ts`.
  **Invariant:** `mdflow.ts` knows nothing about columns, rects or pagination.
  Both consumers take its array, which is what makes three entry points one
  implementation — asserted directly by rendering one source through all three
  and comparing extracted text.
  **Invariant:** emphasis selects from a four-face FAMILY. There is no synthetic
  slant or emboldening here, so a Standard-14 base derives its family by name
  (including from a non-roman member — emphasis is relative to the family) and
  an embedded face falls back to `regular`, showing no change rather than a
  missing glyph.
  **Invariant:** a run states only what it CHANGES. Plain text is one run
  carrying nothing but `text`, which is the closest a run list gets to the
  string path; setting the block's own font on every run would restate it
  needlessly and move bytes.
  **Invariant:** a construct that does not render names itself in `skipped` and
  still contributes its text where it has any — a table, raw HTML, an inline or
  unresolvable image. Visible content beats a silently dropped subtree, the rule
  `svgdraw.ts` already sets. `MdList.tight` is the one mapping input no HTML
  oracle can see, which is why the loose-versus-tight spacing is asserted on
  rendered heights.
```

- [ ] **Step 7: Full suite and typecheck**

Run: `npm run typecheck && npm test`
Expected: clean.

- [ ] **Step 8: Commit**

```bash
git add src/index.ts README.md CLAUDE.md test/markdown-render.test.ts
git commit -m "$(cat <<'EOF'
docs(markdown): export the surface and record the invariants

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

## Closing the issue

- [ ] **Run the whole gate one more time**

```bash
npm run typecheck
npm test
```

Both must be green. `test/rich-runs-identity.test.ts` in particular must show all eleven cases passing with the hashes recorded in Task 1.

- [ ] **File follow-ups**

```bash
bd create "Markdown: emit /Code and /BlockQuote structure types" -t task -p 2
bd create "Flow: per-line leading, so an oversized run cannot collide with the line above" -t task -p 3
```

The second is the limitation `gl6o.3.1` recorded and this work inherits.

- [ ] **Close the issue and push**

```bash
bd close aspose-pdf-foss-for-ts-gl6o.3.2
git pull --rebase
git push
git status   # MUST show "up to date with origin"
```

# Flow nested lists Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend `flow.AddList` with nesting — sub-lists indent per depth, ordered numbering restarts per sub-list, unordered markers cycle `• ◦ ▪` (drawn as vector shapes), with correct nested PDF/UA `/L` structure.

**Architecture:** Two steps. First migrate list markers to a descriptor model and render the default bullet as a vector shape (disc), tagged `/Lbl` + `/ActualText` — flat lists keep working, `ListItemElement` gains a per-item `indent` and a `ListMarker`. Then add nesting: a recursive pre-order walk flattens the item tree onto the existing `Flow.items` queue with per-depth cumulative indents and chained struct holders, so `Flow.Render` is unchanged.

**Tech Stack:** TypeScript (ESM + NodeNext, `strict`; `.js` import specifiers), vitest. Zero runtime deps.

## Global Constraints

- Zero runtime dependencies — only `node:` built-ins.
- ESM + NodeNext: relative import specifiers carry the `.js` extension.
- TDD: failing test first, watch it fail, then implement. Assertions load-bearing.
- `npm run typecheck` and `npm test` green before done.
- Option/input validation throws `TypeError`.
- Files touched: `src/flow.ts`, `test/flow.test.ts`.

---

### Task 1: Marker descriptors + vector rendering + flat-list migration (`flow.ts`)

Introduce a `ListMarker` (text | shape) descriptor, draw shape markers as vector geometry tagged `/Lbl`+`/ActualText`, move `indent` onto the element, and switch the default (unset) bullet from a WinAnsi `•` text glyph to a vector disc. Flat lists stay fully functional.

**Files:**
- Modify: `src/flow.ts` — imports; `ListMarker` type; `drawShapeMarker`; `markerFor`; `normalizeListOptions`; `ListItemElement`; `buildListElements`
- Test: `test/flow.test.ts` — update two db7v.3 bullet-count tests (lines 491, ~548); add flat-shape tests

**Interfaces:**
- Consumes: `num`, `appendContent`, `wrapMarkedContent` from `./pagecontent.js`; `allocContentMcid` from `./structwrite.js`; `enc` from `./serialize.js`; existing `measureText`, `stampText`, `StructElement`.
- Produces:
  - `type ListMarker = { kind: 'text'; text: string } | { kind: 'shape'; shape: 'disc'|'ring'|'square'; actualText: string }`
  - `ListItemElement` constructor `(text, marker: ListMarker, indent: number, opts: NormalizedListOptions, spaceBefore: number, spaceAfter: number, holder: ListStructHolder)` with **mutable** `spaceBefore`/`spaceAfter` public fields and a public `lbody?: StructElement`.

- [ ] **Step 1: Write the failing tests**

Update the two db7v.3 bullet-count assertions and add new flat-shape tests. First, edit the existing assertions:

In "renders a bullet list: one marker glyph per item, bodies present" (line 491), replace:
```ts
    // One bullet glyph (WinAnsi \225) per item.
    expect((content.match(/\(\\225\)/g) ?? []).length).toBe(3);
```
with:
```ts
    // Default bullet is a vector disc: one fill-paint (f\nQ) per item.
    expect((content.match(/f\nQ/g) ?? []).length).toBe(3);
```

In "draws the marker once when an item spans a page boundary" (~line 548), replace:
```ts
    const bulletCount = pages.reduce(
      (n, p) => n + (new TextDecoder('latin1').decode(p.Contents).match(/\(\\225\)/g) ?? []).length, 0);
    expect(bulletCount).toBe(1); // exactly one marker across all pages
```
with:
```ts
    const bulletCount = pages.reduce(
      (n, p) => n + (new TextDecoder('latin1').decode(p.Contents).match(/f\nQ/g) ?? []).length, 0);
    expect(bulletCount).toBe(1); // exactly one marker paint across all pages
```

Then add a new describe after the `flow lists (AddList)` block:
```ts
describe('flow list vector bullets', () => {
  const opts = () => ({
    format: PageFormat.custom(300, 500), columns: 1,
    marginLeft: 20, marginRight: 20, marginTop: 20, marginBottom: 20,
  });

  it('draws the default bullet as a filled disc (Bézier path + fill), not text', () => {
    const doc = Document.Open(buildBlankPage());
    const flow = new Flow(doc, opts());
    flow.AddList(['One'], { fontSize: 12, leading: 16 });
    const content = new TextDecoder('latin1').decode(flow.Render()[0].Contents);
    expect(content).toMatch(/ c\n/);   // circle Bézier curve op
    expect(content).toMatch(/f\nQ/);   // filled
    expect(content).not.toMatch(/\(\\225\)/); // no WinAnsi bullet glyph
  });

  it('an explicit bullet string is still drawn as text', () => {
    const doc = Document.Open(buildBlankPage());
    const flow = new Flow(doc, opts());
    flow.AddList(['One'], { bullet: '*', fontSize: 12, leading: 16 });
    const content = new TextDecoder('latin1').decode(flow.Render()[0].Contents);
    expect(content).toContain('(*)'); // text marker
  });

  it('tags a vector bullet /Lbl with /ActualText', () => {
    const doc = Document.Open(buildBlankPage());
    const flow = new Flow(doc, { ...opts(), tagged: true });
    flow.AddList(['One'], { fontSize: 12, leading: 16 });
    flow.Render();
    const sect = doc.CreateStructTree().Children.find((c) => c.Type === 'Sect')!;
    const l = sect.Children.find((c) => c.Type === 'L')!;
    const lbl = l.Children[0].Children.find((c) => c.Type === 'Lbl')!;
    expect(lbl.ActualText).toBe('•');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/flow.test.ts -t "vector bullet"` and `npx vitest run test/flow.test.ts -t "AddList"`
Expected: the new "vector bullets" tests FAIL (still text markers), and the two updated db7v.3 assertions FAIL (`f\nQ` not found — markers are text).

- [ ] **Step 3: Implement — imports and KAPPA**

Add to `src/flow.ts` imports:
```ts
import { num, appendContent, wrapMarkedContent } from './pagecontent.js';
import { allocContentMcid } from './structwrite.js';
import { enc } from './serialize.js';
```
Add near the top-level consts (e.g. after `DEFAULT_BULLET`):
```ts
/** k constant for a 4-Bézier circle approximation (mirrors graphics.ts). */
const KAPPA = 0.5522847498307936;
/** Vector-bullet cycle by depth: filled disc, hollow ring, filled square. */
const BULLET_SHAPES = ['disc', 'ring', 'square'] as const;
const BULLET_GLYPHS = ['•', '◦', '▪'];

/** A resolved list marker: an ordinal / explicit-bullet text glyph, or a vector
 *  shape (default bullet cycle). @internal */
type ListMarker =
  | { kind: 'text'; text: string }
  | { kind: 'shape'; shape: (typeof BULLET_SHAPES)[number]; actualText: string };
```

- [ ] **Step 4: Implement — `drawShapeMarker`**

Add a helper that paints a vector marker right-aligned with its right edge at `rightX`, vertically centered on the body's first line, wrapped in the `/Lbl` marked content when `tag` is present:
```ts
/** Paint a vector list marker (disc/ring/square) whose right edge sits at
 *  `rightX`, centered near the first line's x-height. Wrapped in the /Lbl marked
 *  content when `tag` is given. @internal */
function drawShapeMarker(
  doc: Document, page: Page, shape: (typeof BULLET_SHAPES)[number],
  rightX: number, baseline: number, fontSize: number,
  color: [number, number, number] | undefined, tag?: StructElement,
): void {
  const size = 0.35 * fontSize;         // diameter / side
  const [r, g, b] = color ?? [0, 0, 0];
  const cy = baseline + 0.3 * fontSize; // ~ x-height midpoint
  const left = rightX - size;
  let s: string;
  if (shape === 'square') {
    s = `q\n${num(r)} ${num(g)} ${num(b)} rg\n`
      + `${num(left)} ${num(cy - size / 2)} ${num(size)} ${num(size)} re\nf\nQ`;
  } else {
    const rad = size / 2;
    const cx = left + rad;
    const k = rad * KAPPA;
    const path =
      `${num(cx + rad)} ${num(cy)} m\n`
      + `${num(cx + rad)} ${num(cy + k)} ${num(cx + k)} ${num(cy + rad)} ${num(cx)} ${num(cy + rad)} c\n`
      + `${num(cx - k)} ${num(cy + rad)} ${num(cx - rad)} ${num(cy + k)} ${num(cx - rad)} ${num(cy)} c\n`
      + `${num(cx - rad)} ${num(cy - k)} ${num(cx - k)} ${num(cy - rad)} ${num(cx)} ${num(cy - rad)} c\n`
      + `${num(cx + k)} ${num(cy - rad)} ${num(cx + rad)} ${num(cy - k)} ${num(cx + rad)} ${num(cy)} c\nh\n`;
    s = shape === 'disc'
      ? `q\n${num(r)} ${num(g)} ${num(b)} rg\n${path}f\nQ`
      : `q\n${num(r)} ${num(g)} ${num(b)} RG\n${num(Math.max(0.4, 0.08 * fontSize))} w\n${path}S\nQ`;
  }
  const body = enc(s);
  const tagged = tag
    ? wrapMarkedContent(tag.Type, allocContentMcid(doc, tag, page), body)
    : body;
  appendContent(doc, page, tagged);
}
```

- [ ] **Step 5: Implement — `markerFor` returns `ListMarker`**

Replace the string-returning `markerFor` (and its `NormalizedListOptions` argument) with a version keyed on a per-sub-list config plus depth. For Task 1, the flat list is depth 0.
```ts
/** The marker for item `index` (0-based) of an ordered/unordered sub-list at
 *  `depth`. Ordered → "N."; explicit bullet → that text; else the vector cycle. */
function markerFor(
  cfg: { ordered: boolean; bulletOverride?: string; start: number }, index: number, depth: number,
): ListMarker {
  if (cfg.ordered) return { kind: 'text', text: `${cfg.start + index}.` };
  if (cfg.bulletOverride !== undefined) return { kind: 'text', text: cfg.bulletOverride };
  return { kind: 'shape', shape: BULLET_SHAPES[depth % 3], actualText: BULLET_GLYPHS[depth % 3] };
}

/** Rendered width of a marker for gutter sizing. @internal */
function markerWidth(m: ListMarker, fontSize: number, font: AuthoringFont): number {
  return m.kind === 'shape' ? 0.35 * fontSize : measureText(m.text, fontSize, font);
}
```

- [ ] **Step 6: Implement — `normalizeListOptions` (drop indent computation, add overrides)**

Change `NormalizedListOptions` to drop `indent` and `bullet`, add `bulletOverride?: string` and `indentOverride?: number`; drop the `count` parameter and the auto-indent loop (indent moves to `buildListElements`). Replace the interface's `bullet: string` / `indent: number` fields and the tail of `normalizeListOptions`:
```ts
interface NormalizedListOptions {
  ordered: boolean;
  start: number;
  bulletOverride?: string;   // explicit bullet text, or undefined → vector cycle
  font: AuthoringFont;
  fontSize: number;
  color?: [number, number, number];
  leading?: number;
  align?: 'left' | 'center' | 'right' | 'justify';
  markerGap: number;
  itemSpacing: number;
  spaceBefore: number;
  spaceAfter: number;
  indentOverride?: number;   // uniform per-level step, or undefined → per-depth auto
}
```
```ts
function normalizeListOptions(o: FlowListOptions): NormalizedListOptions {
  const ordered = o.ordered ?? false;
  if (typeof ordered !== 'boolean') throw new TypeError('ordered must be a boolean');
  const start = o.start ?? 1;
  if (!Number.isInteger(start)) throw new TypeError('start must be an integer');
  if (o.bullet !== undefined && typeof o.bullet !== 'string')
    throw new TypeError('bullet must be a string');
  const font = o.font ?? 'Helvetica';
  const fontSize = o.fontSize ?? 11;
  if (!Number.isFinite(fontSize) || fontSize <= 0)
    throw new TypeError('fontSize must be a positive finite number');
  const itemSpacing = nonNegative(o.itemSpacing, 0, 'itemSpacing');
  const spaceBefore = nonNegative(o.spaceBefore, 0, 'spaceBefore');
  const spaceAfter = nonNegative(o.spaceAfter, 0, 'spaceAfter');
  const indentOverride = o.indent !== undefined ? nonNegative(o.indent, 0, 'indent') : undefined;
  return {
    ordered, start, bulletOverride: o.bullet, font, fontSize, color: o.color, leading: o.leading,
    align: o.align, markerGap: 0.5 * fontSize, itemSpacing, spaceBefore, spaceAfter, indentOverride,
  };
}
```

- [ ] **Step 7: Implement — `ListItemElement` (per-item indent, marker descriptor, shape draw)**

Rewrite the class: `marker: ListMarker`, `indent: number` (per-item), mutable `spaceBefore`/`spaceAfter`, public `lbody`, and a `parentBody` chained holder. Use `this.indent` everywhere `this.opts.indent` was used, add `/ActualText` to the `/Lbl`, and branch the marker draw:
```ts
interface ListStructHolder { list?: StructElement; parentBody?: () => StructElement | undefined; }

class ListItemElement implements FlowElement {
  private markerDrawn = false;
  private li?: StructElement;
  private lbl?: StructElement;
  lbody?: StructElement;

  constructor(
    private readonly text: string,
    private readonly marker: ListMarker,
    private readonly indent: number,
    private readonly opts: NormalizedListOptions,
    public spaceBefore: number,
    public spaceAfter: number,
    private readonly holder: ListStructHolder,
  ) {}

  measure(ctx: MeasureContext): { usedHeight: number; fits: boolean } {
    if (ctx.availHeight <= 0) return { usedHeight: 0, fits: false };
    const bodyOpts: TextBlockOptions = {
      font: this.opts.font, fontSize: this.opts.fontSize, color: this.opts.color,
      align: this.opts.align, leading: this.opts.leading,
    };
    const { usedHeight, remainder } =
      measureTextBlock(this.text, ctx.width - this.indent, ctx.availHeight, bodyOpts);
    return { usedHeight, fits: remainder === null && usedHeight > 0 };
  }

  place(ctx: PlaceContext): PlaceResult {
    if (ctx.availHeight <= 0) return { usedHeight: 0, remainder: this, drew: false };

    if (this.li === undefined && ctx.structParent && this.text.length > 0) {
      const parent = this.holder.parentBody?.() ?? ctx.structParent;
      if (this.holder.list === undefined) this.holder.list = parent.Append('L');
      this.li = this.holder.list.Append('LI');
      this.lbl = this.li.Append('Lbl',
        this.marker.kind === 'shape' ? { actualText: this.marker.actualText } : undefined);
      this.lbody = this.li.Append('LBody');
    }

    const bodyOpts: TextBlockOptions = {
      font: this.opts.font, fontSize: this.opts.fontSize, color: this.opts.color,
      align: this.opts.align, leading: this.opts.leading,
      ...(this.lbody ? { tag: this.lbody } : {}),
    };
    const rect: [number, number, number, number] = [
      ctx.x + this.indent, ctx.top - ctx.availHeight, ctx.width - this.indent, ctx.availHeight,
    ];
    const { remainder, usedHeight } = flowTextBlock(ctx.doc, ctx.page, this.text, rect, bodyOpts);

    if (usedHeight === 0) {
      return { usedHeight: 0, remainder: remainder === null ? null : this, drew: false };
    }

    if (!this.markerDrawn) {
      const rightEdge = ctx.x + this.indent - this.opts.markerGap;
      const baseline = ctx.top - this.opts.fontSize;
      if (this.marker.kind === 'shape') {
        drawShapeMarker(ctx.doc, ctx.page, this.marker.shape, rightEdge, baseline,
          this.opts.fontSize, this.opts.color, this.lbl);
      } else {
        const mw = measureText(this.marker.text, this.opts.fontSize, this.opts.font);
        const markerOpts: StampOptions = {
          font: this.opts.font, fontSize: this.opts.fontSize, color: this.opts.color,
          ...(this.lbl ? { tag: this.lbl } : {}),
        };
        stampText(ctx.doc, ctx.page, this.marker.text, rightEdge - mw, baseline, markerOpts);
      }
      this.markerDrawn = true;
    }

    if (remainder === null) return { usedHeight, remainder: null, drew: true };
    const cont = new ListItemElement(
      remainder, this.marker, this.indent, this.opts, 0, this.spaceAfter, this.holder);
    cont.markerDrawn = true;
    cont.li = this.li;
    cont.lbl = this.lbl;
    cont.lbody = this.lbody;
    return { usedHeight, remainder: cont, drew: true };
  }
}
```

- [ ] **Step 8: Implement — flat `buildListElements`**

Rewrite the flat builder to compute a single-level indent from the resolved markers and construct elements with the descriptor. (Task 3 replaces this with the recursive version.)
```ts
function buildListElements(items: string[], options: FlowListOptions): FlowElement[] {
  if (!Array.isArray(items)) throw new TypeError('items must be an array of strings');
  if (!items.every((s) => typeof s === 'string'))
    throw new TypeError('items must be an array of strings');
  const o = normalizeListOptions(options);
  const holder: ListStructHolder = {};
  const cfg = { ordered: o.ordered, bulletOverride: o.bulletOverride, start: o.start };
  const markers = items.map((_, i) => markerFor(cfg, i, 0));
  const maxW = markers.reduce((m, mk) => Math.max(m, markerWidth(mk, o.fontSize, o.font)), 0);
  const indent = o.indentOverride ?? maxW + o.markerGap;
  return items.map((text, i) => {
    const spaceBefore = i === 0 ? o.spaceBefore : 0;
    const spaceAfter = i === items.length - 1 ? o.spaceAfter : o.itemSpacing;
    return new ListItemElement(text, markers[i], indent, o, spaceBefore, spaceAfter, holder);
  });
}
```

- [ ] **Step 9: Run tests to verify they pass**

Run: `npx vitest run test/flow.test.ts -t "vector bullet"` then `npx vitest run test/flow.test.ts -t "AddList"` then `npx vitest run test/flow.test.ts -t "list tagging"`
Expected: all PASS (new shape tests, updated bullet counts, and the unchanged tagging/ordered/spacing tests).

- [ ] **Step 10: Typecheck + full flow suite**

Run: `npm run typecheck && npx vitest run test/flow.test.ts`
Expected: typecheck clean; the whole flow test file green.

- [ ] **Step 11: Commit**

```bash
git add src/flow.ts test/flow.test.ts
git commit -m "feat(flow): vector list markers + marker descriptors (db7v.7)"
```

---

### Task 2: Nested lists — recursive builder, per-depth indent, nested tagging (`flow.ts`)

Widen `AddList` to accept recursive item objects and replace the flat builder with a pre-order tree walk: per-sub-list config resolution, per-depth cumulative indents, chained struct holders for nested `/L`, and a spacing post-pass.

**Files:**
- Modify: `src/flow.ts` — `FlowListItem`/`FlowListNode` types; `buildListElements` (recursive); `AddList`/`makeList` signatures
- Modify: `src/index.ts` — export `FlowListItem`, `FlowListNode`
- Test: `test/flow.test.ts` — new `describe('flow nested lists', …)`

**Interfaces:**
- Consumes: `markerFor`, `markerWidth`, `ListItemElement`, `ListStructHolder`, `normalizeListOptions` from Task 1.
- Produces:
  - `export interface FlowListItem { text: string; items?: FlowListNode[]; ordered?: boolean; bullet?: string; start?: number }`
  - `export type FlowListNode = string | FlowListItem`
  - `AddList(items: FlowListNode[], options?: FlowListOptions): this`
  - `makeList(items: FlowListNode[], options?: FlowListOptions): FlowElement[]`

- [ ] **Step 1: Write the failing tests**

Add a new describe:
```ts
describe('flow nested lists', () => {
  const opts = (extra = {}) => ({
    format: PageFormat.custom(300, 500), columns: 1,
    marginLeft: 20, marginRight: 20, marginTop: 20, marginBottom: 20, ...extra,
  });
  const bodyX = (page: any, needle: string) =>
    page.GetTextFragments().find((f: any) => f.text.includes(needle))!.quad[0];

  it('indents a sub-list deeper than its parent', () => {
    const doc = Document.Open(buildBlankPage());
    const flow = new Flow(doc, opts());
    flow.AddList([{ text: 'Parent', items: ['Child'] }, 'Sibling'], { fontSize: 12, leading: 16 });
    const [page] = flow.Render();
    expect(bodyX(page, 'Child')).toBeGreaterThan(bodyX(page, 'Parent'));
    expect(bodyX(page, 'Sibling')).toBeCloseTo(bodyX(page, 'Parent'), 1);
  });

  it('restarts ordered numbering per sub-list', () => {
    const doc = Document.Open(buildBlankPage());
    const flow = new Flow(doc, opts());
    flow.AddList([
      { text: 'A', ordered: true, items: ['a1', 'a2'] },
      { text: 'B', ordered: true, items: ['b1', 'b2'] },
    ], { ordered: true, fontSize: 12, leading: 16 });
    const text = flow.Render()[0].GetText();
    // Top: 1. A, 2. B. Each sub-list restarts: 1. 2.
    expect(text).toContain('1.');
    expect(text).toContain('2.');
    expect(text).not.toContain('3.'); // sub-lists restarted, no running count
  });

  it('cycles bullet shapes by depth (disc, ring, square)', () => {
    const doc = Document.Open(buildBlankPage());
    const flow = new Flow(doc, opts());
    flow.AddList([{ text: 'L0', items: [{ text: 'L1', items: ['L2'] }] }], { fontSize: 12, leading: 16 });
    const content = new TextDecoder('latin1').decode(flow.Render()[0].Contents);
    // depth 0 disc (fill), depth 1 ring (stroke), depth 2 square (fill).
    expect((content.match(/f\nQ/g) ?? []).length).toBe(2); // disc + square
    expect((content.match(/S\nQ/g) ?? []).length).toBe(1); // ring
  });

  it('supports mixed ordered/unordered nesting via the item override', () => {
    const doc = Document.Open(buildBlankPage());
    const flow = new Flow(doc, opts());
    flow.AddList([{ text: 'Bulleted', ordered: true, items: ['n1', 'n2'] }], { fontSize: 12, leading: 16 });
    const content = new TextDecoder('latin1').decode(flow.Render()[0].Contents);
    expect(content).toMatch(/f\nQ/);   // top is a vector disc
    expect(content).toContain('(1.)'); // sub-list is ordered text
  });

  it('emits nested /L under the parent /LBody when tagged', () => {
    const doc = Document.Open(buildBlankPage());
    const flow = new Flow(doc, opts({ tagged: true }));
    flow.AddList([{ text: 'Parent', items: ['Child'] }], { fontSize: 12, leading: 16 });
    flow.Render();
    const sect = doc.CreateStructTree().Children.find((c) => c.Type === 'Sect')!;
    const topL = sect.Children.find((c) => c.Type === 'L')!;
    const parentLi = topL.Children.find((c) => c.Type === 'LI')!;
    const parentBody = parentLi.Children.find((c) => c.Type === 'LBody')!;
    const nestedL = parentBody.Children.find((c) => c.Type === 'L'); // nested /L inside /LBody
    expect(nestedL).toBeDefined();
    expect(nestedL!.Children.some((c) => c.Type === 'LI')).toBe(true);
  });

  it('validates node shapes', () => {
    const doc = Document.Open(buildBlankPage());
    const flow = new Flow(doc, opts());
    expect(() => flow.AddList([{ text: 5 as any }])).toThrow(TypeError);
    expect(() => flow.AddList([{ text: 'x', items: 'no' as any }])).toThrow(TypeError);
    expect(() => flow.AddList([{ text: 'x', ordered: 1 as any }])).toThrow(TypeError);
    expect(() => flow.AddList([{ text: 'x', bullet: 5 as any }])).toThrow(TypeError);
    expect(() => flow.AddList([{ text: 'x', start: 1.5 as any }])).toThrow(TypeError);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/flow.test.ts -t "nested lists"`
Expected: FAIL — object items are rejected by the flat builder's string check / type errors.

- [ ] **Step 3: Implement — input types + widen `AddList`/`makeList`**

Add above `buildListElements`:
```ts
/** One nested-list item. A bare string is a leaf item. */
export interface FlowListItem {
  /** The item's word-wrapped body text. */
  text: string;
  /** Sub-list nested under this item. */
  items?: FlowListNode[];
  /** Override ordered-ness of THIS item's sub-list. Default: inherit the parent. */
  ordered?: boolean;
  /** Override the marker glyph of THIS item's (unordered) sub-list (drawn as text). */
  bullet?: string;
  /** First ordinal of THIS item's (ordered) sub-list. Integer. Default 1. */
  start?: number;
}
export type FlowListNode = string | FlowListItem;
```
Change `AddList` and `makeList` signatures from `items: string[]` to `items: FlowListNode[]` (bodies unchanged).

- [ ] **Step 4: Implement — recursive `buildListElements`**

Replace the flat `buildListElements` (from Task 1) with the recursive walk:
```ts
interface SublistCfg { ordered: boolean; bulletOverride?: string; start: number }

function validateNode(n: FlowListNode): FlowListItem {
  if (typeof n === 'string') return { text: n };
  if (typeof n !== 'object' || n === null || typeof n.text !== 'string')
    throw new TypeError('a list item must be a string or an object with a string text');
  if (n.items !== undefined && !Array.isArray(n.items))
    throw new TypeError('item.items must be an array');
  if (n.ordered !== undefined && typeof n.ordered !== 'boolean')
    throw new TypeError('item.ordered must be a boolean');
  if (n.bullet !== undefined && typeof n.bullet !== 'string')
    throw new TypeError('item.bullet must be a string');
  if (n.start !== undefined && !Number.isInteger(n.start))
    throw new TypeError('item.start must be an integer');
  return n;
}

function buildListElements(items: FlowListNode[], options: FlowListOptions): FlowElement[] {
  if (!Array.isArray(items)) throw new TypeError('items must be an array');
  const o = normalizeListOptions(options);

  interface Planned {
    item: FlowListItem; marker: ListMarker; depth: number;
    holder: ListStructHolder; element?: ListItemElement;
  }
  const planned: Planned[] = [];
  const maxWidthByDepth: number[] = [];

  const walk = (nodes: FlowListNode[], depth: number, cfg: SublistCfg, holder: ListStructHolder) => {
    nodes.forEach((raw, index) => {
      const item = validateNode(raw);
      const marker = markerFor(cfg, index, depth);
      maxWidthByDepth[depth] =
        Math.max(maxWidthByDepth[depth] ?? 0, markerWidth(marker, o.fontSize, o.font));
      const p: Planned = { item, marker, depth, holder };
      planned.push(p);
      if (item.items && item.items.length > 0) {
        const childCfg: SublistCfg = {
          ordered: item.ordered ?? cfg.ordered,
          bulletOverride: item.bullet,
          start: item.start ?? 1,
        };
        const childHolder: ListStructHolder = { parentBody: () => p.element?.lbody };
        walk(item.items, depth + 1, childCfg, childHolder);
      }
    });
  };
  walk(items, 0, { ordered: o.ordered, bulletOverride: o.bulletOverride, start: o.start }, {});

  // Per-depth cumulative indent (uniform step when indentOverride is set).
  const cumulative: number[] = [];
  let acc = 0;
  for (let d = 0; d < maxWidthByDepth.length; d++) {
    acc += o.indentOverride ?? (maxWidthByDepth[d] ?? 0) + o.markerGap;
    cumulative[d] = acc;
  }

  // Construct elements, then assign spacing in flattened order.
  for (const p of planned) {
    p.element = new ListItemElement(p.item.text, p.marker, cumulative[p.depth], o, 0, 0, p.holder);
  }
  const els = planned.map((p) => p.element!);
  els.forEach((el, i) => {
    el.spaceBefore = i === 0 ? o.spaceBefore : 0;
    el.spaceAfter = i === els.length - 1 ? o.spaceAfter : o.itemSpacing;
  });
  return els;
}
```

- [ ] **Step 5: Implement — export the types from index**

In `src/index.ts`, add `FlowListItem`, `FlowListNode` to the `flow.js` type export line.

- [ ] **Step 6: Run tests to verify they pass**

Run: `npx vitest run test/flow.test.ts -t "nested lists"`
Expected: PASS (6 tests).

- [ ] **Step 7: Prove the assertions are load-bearing**

Temporarily change the nested-`/L` placement — in `place`, replace `const parent = this.holder.parentBody?.() ?? ctx.structParent;` with `const parent = ctx.structParent;` (always attach at top). Rerun.
Run: `npx vitest run test/flow.test.ts -t "nested /L"`
Expected: the "emits nested /L under the parent /LBody" test FAILS. Revert.

Then temporarily change the cycle index `depth % 3` to `0` in `markerFor`. Rerun.
Run: `npx vitest run test/flow.test.ts -t "cycles bullet"`
Expected: the "cycles bullet shapes by depth" test FAILS (all discs, no ring). Revert and confirm green.

- [ ] **Step 8: Full suite + typecheck**

Run: `npm run typecheck && npm test`
Expected: typecheck clean; entire vitest suite green.

- [ ] **Step 9: Update the README**

In `README.md`, extend the `AddList` sentence to note nesting:
```markdown
List items may nest: pass `{ text, items: [...] }` for a sub-list — sub-lists
indent per depth, ordered numbering restarts per level, and unordered markers
cycle • ◦ ▪ by depth (drawn as vector shapes). An item's `ordered`/`bullet`/`start`
override its own sub-list.
```

- [ ] **Step 10: Commit**

```bash
git add src/flow.ts src/index.ts README.md test/flow.test.ts
git commit -m "feat(flow): nested lists — recursion, per-depth indent, nested /L (db7v.7)"
```

---

## Self-Review

**Spec coverage:**
- Recursive item objects (`FlowListItem`/`FlowListNode`), `AddList` widened → Task 2 Steps 3-4. ✓
- Ordered inherits + restarts per sub-list → Task 2 Step 4 (`childCfg.ordered`, per-sub-list `start`) + restart test. ✓
- Unordered cycle `• ◦ ▪` by depth as vector markers → Task 1 Steps 3-5 + Task 2 cycle test. ✓
- Vector marker rendering (disc/ring/square) + `/Lbl` `/ActualText` → Task 1 Steps 4, 7 + tagged-ActualText test. ✓
- db7v.3 flat default bullet → vector disc; two bullet-count tests updated → Task 1 Step 1. ✓
- Cumulative per-depth gutter; `options.indent` uniform override → Task 2 Step 4 + indent test. ✓
- Pre-order flatten onto the item queue; `Render` unchanged → Task 2 Step 4. ✓
- Nested `/L` under the parent `/LBody` via `parentBody()` chain → Task 1 Step 7 + Task 2 Step 4 + nested-`/L` test. ✓
- Spacing post-pass (first `spaceBefore`, last `spaceAfter`, else `itemSpacing`) → Task 2 Step 4. ✓
- Validation of node/`items`/`ordered`/`bullet`/`start` → Task 2 Step 4 + validation test. ✓
- README nesting note → Task 2 Step 9. ✓

**Placeholder scan:** none — every step has concrete code/commands.

**Type consistency:** `ListMarker` shape (Task 1 Step 3) is consumed identically in `markerFor`/`markerWidth`/`ListItemElement`/`buildListElements`. `ListItemElement` constructor arg order `(text, marker, indent, opts, spaceBefore, spaceAfter, holder)` matches every construction site (Task 1 Steps 7-8, Task 2 Step 4). `ListStructHolder` gains `parentBody?` in Task 1 Step 7 and is used in Task 2 Step 4. `SublistCfg`/`markerFor`'s `cfg` object share the `{ ordered, bulletOverride, start }` shape. `FlowListNode`/`FlowListItem` names match across types, `AddList`, `makeList`, and index export.

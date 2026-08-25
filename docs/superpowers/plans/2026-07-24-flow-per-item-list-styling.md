# Flow per-item list styling Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let individual `flow.AddList` items override the list-level appearance (font, size, colour, alignment, leading, spacing, indent) by adding style fields to the existing `FlowListItem`.

**Architecture:** Two steps. First, add the style fields + validation, a `resolveItemOptions` merge helper that returns the list options unchanged when an item overrides nothing (cheap common path), and wire per-item text/marker style through the builder (measuring each depth's marker gutter with the item's own size). Then wire the two geometry overrides — per-item `indent` and per-item `spaceBefore`/`spaceAfter` — into the builder's element construction and spacing post-pass. `ListItemElement` is unchanged: it already reads every style/geometry value from its `opts`/`indent`.

**Tech Stack:** TypeScript (ESM + NodeNext, `strict`; `.js` import specifiers), vitest. Zero runtime deps.

## Global Constraints

- Zero runtime dependencies — only `node:` built-ins.
- ESM + NodeNext: relative import specifiers carry the `.js` extension.
- TDD: failing test first, watch it fail, then implement. Assertions load-bearing.
- `npm run typecheck` and `npm test` green before done.
- Option/input validation throws `TypeError`.
- Files touched: `src/flow.ts`, `test/flow.test.ts`, `README.md`.
- The item's marker inherits the item's style (a red/larger item → red/larger marker).
- `markerGap` stays list-level so markers right-align at a common gutter edge.
- Per-item `indent`/`spaceBefore`/`spaceAfter` **replace** (not add to) the value the item would otherwise get.
- `FlowListItem` is already exported from `src/index.ts` — no index change needed.

---

### Task 1: Per-item text/marker style (`flow.ts`)

Add the eight style fields to `FlowListItem`, validate all of them, add `resolveItemOptions`, and wire `font`/`fontSize`/`color`/`align`/`leading` through the builder so each item resolves its own `NormalizedListOptions` and each depth's auto-gutter is measured with the item's own size.

**Files:**
- Modify: `src/flow.ts` — `FlowListItem` interface; `validateNode`; new `resolveItemOptions`; `buildListElements` walk + construction
- Test: `test/flow.test.ts` — new `describe('flow per-item list styling')`

**Interfaces:**
- Consumes: `NormalizedListOptions`, `FlowListItem`, `FlowListNode`, `markerFor`, `markerWidth`, `ListItemElement`, `validateNode`, `AuthoringFont`, `makeList` (all existing in `flow.ts`).
- Produces:
  - `FlowListItem` gains optional `font`, `fontSize`, `color`, `align`, `leading`, `spaceBefore`, `spaceAfter`, `indent`.
  - `function resolveItemOptions(list: NormalizedListOptions, item: FlowListItem): NormalizedListOptions` — returns `list` unchanged when no style field is set, else a copy with `font`/`fontSize`/`color`/`align`/`leading` overridden.

- [ ] **Step 1: Write the failing tests**

Add this new describe immediately after the `describe('flow nested lists', …)` block (search for `describe('flow nested lists'` and place the new block after its closing `});`):

```ts
describe('flow per-item list styling', () => {
  const opts = (extra = {}) => ({
    format: PageFormat.custom(300, 500), columns: 1,
    marginLeft: 20, marginRight: 20, marginTop: 20, marginBottom: 20, ...extra,
  });
  const cm = (page: any) => new TextDecoder('latin1').decode(page.Contents);
  const bodyX = (page: any, needle: string) =>
    page.GetTextFragments().find((f: any) => f.text.includes(needle))!.quad[0];

  it('overrides font size for one item only', () => {
    const doc = Document.Open(buildBlankPage());
    const flow = new Flow(doc, opts());
    flow.AddList(['Small', { text: 'Big', fontSize: 20 }], { fontSize: 10, leading: 24 });
    const content = cm(flow.Render()[0]);
    expect(content).toMatch(/ 10 Tf/); // the default item
    expect(content).toMatch(/ 20 Tf/); // the overridden item
  });

  it('overrides colour for the body AND the marker of one item', () => {
    const doc = Document.Open(buildBlankPage());
    const flow = new Flow(doc, opts());
    flow.AddList(['Black', { text: 'Red', color: [1, 0, 0] }], { fontSize: 12, leading: 16 });
    const content = cm(flow.Render()[0]);
    // The red item paints red twice: once for its disc marker, once for its body.
    expect((content.match(/1 0 0 rg/g) ?? []).length).toBeGreaterThanOrEqual(2);
    expect(content).toMatch(/0 0 0 rg/); // the black item is still black
  });

  it('widens the depth gutter when an item uses a larger marker size', () => {
    const uni = Document.Open(buildBlankPage());
    const uniFlow = new Flow(uni, opts());
    uniFlow.AddList(['A', 'B'], { fontSize: 10, leading: 24 });
    const uniX = bodyX(uniFlow.Render()[0], 'A');

    const big = Document.Open(buildBlankPage());
    const bigFlow = new Flow(big, opts());
    bigFlow.AddList([{ text: 'A', fontSize: 30 }, 'B'], { fontSize: 10, leading: 34 });
    const bigX = bodyX(bigFlow.Render()[0], 'B'); // sibling shifts too: shared depth gutter
    expect(bigX).toBeGreaterThan(uniX); // 30pt marker widened the gutter for the whole depth
  });

  it('renders byte-identically to a plain string list when no style is overridden', () => {
    const a = Document.Open(buildBlankPage());
    const strFlow = new Flow(a, opts());
    strFlow.AddList(['One', 'Two'], { fontSize: 12, leading: 16 });
    const strContent = cm(strFlow.Render()[0]);

    const b = Document.Open(buildBlankPage());
    const objFlow = new Flow(b, opts());
    objFlow.AddList([{ text: 'One' }, { text: 'Two' }], { fontSize: 12, leading: 16 });
    const objContent = cm(objFlow.Render()[0]);
    expect(objContent).toBe(strContent);
  });

  it('validates per-item style field types', () => {
    const doc = Document.Open(buildBlankPage());
    const flow = new Flow(doc, opts());
    expect(() => flow.AddList([{ text: 'x', font: 5 as any }])).toThrow(TypeError);
    expect(() => flow.AddList([{ text: 'x', fontSize: 0 }])).toThrow(TypeError);
    expect(() => flow.AddList([{ text: 'x', color: [1, 0] as any }])).toThrow(TypeError);
    expect(() => flow.AddList([{ text: 'x', align: 'middle' as any }])).toThrow(TypeError);
    expect(() => flow.AddList([{ text: 'x', leading: -1 }])).toThrow(TypeError);
    expect(() => flow.AddList([{ text: 'x', indent: -1 }])).toThrow(TypeError);
    expect(() => flow.AddList([{ text: 'x', spaceBefore: -1 }])).toThrow(TypeError);
    expect(() => flow.AddList([{ text: 'x', spaceAfter: -1 }])).toThrow(TypeError);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/flow.test.ts -t "per-item list styling"`
Expected: FAIL — the fontSize/colour/gutter tests fail (overrides ignored today), and the validation test fails (bad style fields are not yet rejected; e.g. `fontSize: 0` does not throw).

- [ ] **Step 3: Implement — add the style fields to `FlowListItem`**

In `src/flow.ts`, extend the `FlowListItem` interface (find `export interface FlowListItem {`). Add the new fields after the existing `start?: number;` line, before the closing `}`:

```ts
  /** Override the body + marker font for THIS item. Default: the list font. */
  font?: AuthoringFont;
  /** Override the body + marker font size (points) for THIS item. > 0. Default: the list size. */
  fontSize?: number;
  /** Override the body + marker colour (RGB 0..1) for THIS item. Default: the list colour. */
  color?: [number, number, number];
  /** Override the body alignment for THIS item. Default: the list alignment. */
  align?: 'left' | 'center' | 'right' | 'justify';
  /** Override the body leading (points) for THIS item. >= 0. Default: the list leading. */
  leading?: number;
  /** Gap above THIS item, replacing the default (list spaceBefore at the first
   *  item, else 0). >= 0. */
  spaceBefore?: number;
  /** Gap below THIS item, replacing the default (list spaceAfter at the last
   *  item, else itemSpacing). >= 0. */
  spaceAfter?: number;
  /** Body indent (points from the list's left edge) for THIS item, replacing the
   *  per-depth auto/uniform indent. Affects only this item, not its descendants. */
  indent?: number;
```

- [ ] **Step 4: Implement — validate the new fields in `validateNode`**

In `validateNode`, add these checks after the existing `if (n.start !== undefined …)` check and before `return n;`:

```ts
  if (n.font !== undefined && typeof n.font !== 'string')
    throw new TypeError('item.font must be a string');
  if (n.fontSize !== undefined && (!Number.isFinite(n.fontSize) || n.fontSize <= 0))
    throw new TypeError('item.fontSize must be a positive finite number');
  if (n.color !== undefined
      && (!Array.isArray(n.color) || n.color.length !== 3 || !n.color.every((c) => typeof c === 'number')))
    throw new TypeError('item.color must be an [r, g, b] number triple');
  if (n.align !== undefined && !['left', 'center', 'right', 'justify'].includes(n.align))
    throw new TypeError('item.align must be left, center, right, or justify');
  if (n.leading !== undefined && (!Number.isFinite(n.leading) || n.leading < 0))
    throw new TypeError('item.leading must be a non-negative finite number');
  if (n.indent !== undefined && (!Number.isFinite(n.indent) || n.indent < 0))
    throw new TypeError('item.indent must be a non-negative finite number');
  if (n.spaceBefore !== undefined && (!Number.isFinite(n.spaceBefore) || n.spaceBefore < 0))
    throw new TypeError('item.spaceBefore must be a non-negative finite number');
  if (n.spaceAfter !== undefined && (!Number.isFinite(n.spaceAfter) || n.spaceAfter < 0))
    throw new TypeError('item.spaceAfter must be a non-negative finite number');
```

- [ ] **Step 5: Implement — `resolveItemOptions` helper**

Add this function immediately above `function buildListElements(` (after the `validateNode` function):

```ts
/** Merge an item's style overrides onto the list options. Returns `list`
 *  unchanged when the item sets no style field (uniform-list fast path, keeping
 *  output byte-identical to a plain string list). @internal */
function resolveItemOptions(list: NormalizedListOptions, item: FlowListItem): NormalizedListOptions {
  if (item.font === undefined && item.fontSize === undefined && item.color === undefined
      && item.align === undefined && item.leading === undefined) {
    return list;
  }
  return {
    ...list,
    font: item.font ?? list.font,
    fontSize: item.fontSize ?? list.fontSize,
    color: item.color ?? list.color,
    align: item.align ?? list.align,
    leading: item.leading ?? list.leading,
  };
}
```

- [ ] **Step 6: Implement — wire style through the builder walk**

In `buildListElements`, add an `opts` field to the local `Planned` interface. Change:

```ts
  interface Planned {
    item: FlowListItem; marker: ListMarker; depth: number;
    holder: ListStructHolder; element?: ListItemElement;
  }
```
to:
```ts
  interface Planned {
    item: FlowListItem; marker: ListMarker; depth: number;
    holder: ListStructHolder; opts: NormalizedListOptions; element?: ListItemElement;
  }
```

Then in the `walk` callback, replace:
```ts
      const item = validateNode(raw);
      const marker = markerFor(cfg, index, depth);
      maxWidthByDepth[depth] =
        Math.max(maxWidthByDepth[depth] ?? 0, markerWidth(marker, o.fontSize, o.font));
      const p: Planned = { item, marker, depth, holder };
```
with:
```ts
      const item = validateNode(raw);
      const itemOpts = resolveItemOptions(o, item);
      const marker = markerFor(cfg, index, depth);
      maxWidthByDepth[depth] =
        Math.max(maxWidthByDepth[depth] ?? 0, markerWidth(marker, itemOpts.fontSize, itemOpts.font));
      const p: Planned = { item, marker, depth, holder, opts: itemOpts };
```

Finally, in the construction loop, pass the per-item opts. Change:
```ts
  for (const p of planned) {
    p.element = new ListItemElement(p.item.text, p.marker, cumulative[p.depth], o, 0, 0, p.holder);
  }
```
to:
```ts
  for (const p of planned) {
    p.element = new ListItemElement(p.item.text, p.marker, cumulative[p.depth], p.opts, 0, 0, p.holder);
  }
```

(Per-item `indent`/spacing stay on the list defaults for now — Task 2 wires them.)

- [ ] **Step 7: Run tests to verify they pass**

Run: `npx vitest run test/flow.test.ts -t "per-item list styling"`
Expected: all 5 tests PASS.

- [ ] **Step 8: Prove an assertion is load-bearing**

Temporarily edit `resolveItemOptions` to ignore `fontSize`: change `fontSize: item.fontSize ?? list.fontSize,` to `fontSize: list.fontSize,`. Rerun.
Run: `npx vitest run test/flow.test.ts -t "overrides font size"`
Expected: the "overrides font size for one item only" test FAILS (no ` 20 Tf`). Revert the change and confirm it passes again.

- [ ] **Step 9: Typecheck + full flow suite**

Run: `npm run typecheck && npx vitest run test/flow.test.ts`
Expected: typecheck clean; the whole flow test file green.

- [ ] **Step 10: Commit**

```bash
git add src/flow.ts test/flow.test.ts
git commit -m "feat(flow): per-item list text/marker style overrides (db7v.8)"
```

---

### Task 2: Per-item indent + spacing (`flow.ts`), README, verification

Wire the two geometry overrides into the builder — per-item `indent` at construction, per-item `spaceBefore`/`spaceAfter` in the spacing post-pass — then document the feature and run the full suite.

**Files:**
- Modify: `src/flow.ts` — `buildListElements` construction loop + spacing post-pass
- Modify: `README.md` — extend the `AddList` paragraph
- Test: `test/flow.test.ts` — add two tests to `describe('flow per-item list styling')`

**Interfaces:**
- Consumes: `buildListElements`, `FlowListItem` (with `indent`/`spaceBefore`/`spaceAfter` from Task 1), `Planned` (with `opts`).
- Produces: no new symbols; per-item `indent`/`spaceBefore`/`spaceAfter` now take effect.

- [ ] **Step 1: Write the failing tests**

Add these two tests inside the existing `describe('flow per-item list styling', …)` block (before its closing `});`):

```ts
  it('applies a per-item indent to that item only', () => {
    const doc = Document.Open(buildBlankPage());
    const flow = new Flow(doc, opts());
    flow.AddList(['Normal', { text: 'Hung', indent: 80 }], { fontSize: 12, leading: 16 });
    const page = flow.Render()[0];
    // Column left is marginLeft = 20; the override item's body sits at 20 + 80.
    expect(bodyX(page, 'Hung')).toBeCloseTo(100, 1);
    expect(bodyX(page, 'Normal')).toBeLessThan(100); // auto indent, unaffected
  });

  it('applies a per-item spaceAfter, dropping the next item further down', () => {
    const bodyY = (page: any, needle: string) =>
      page.GetTextFragments().find((f: any) => f.text.includes(needle))!.quad[1];

    const plain = Document.Open(buildBlankPage());
    const plainFlow = new Flow(plain, opts());
    plainFlow.AddList(['P1', 'P2', 'P3'], { fontSize: 12, leading: 16 });
    const plainY = bodyY(plainFlow.Render()[0], 'P3');

    const spaced = Document.Open(buildBlankPage());
    const spacedFlow = new Flow(spaced, opts());
    spacedFlow.AddList(['P1', { text: 'P2', spaceAfter: 40 }, 'P3'], { fontSize: 12, leading: 16 });
    const spacedY = bodyY(spacedFlow.Render()[0], 'P3');
    // Extra 40pt gap after P2 pushes P3 ~40pt lower (smaller y in PDF space).
    expect(plainY - spacedY).toBeCloseTo(40, 0);
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/flow.test.ts -t "per-item indent"` and `npx vitest run test/flow.test.ts -t "per-item spaceAfter"`
Expected: FAIL — indent override is ignored (body at auto indent, not 100), and spaceAfter override is ignored (P3 at the same y in both lists).

- [ ] **Step 3: Implement — per-item indent at construction**

In `buildListElements`, change the construction loop:
```ts
  for (const p of planned) {
    p.element = new ListItemElement(p.item.text, p.marker, cumulative[p.depth], p.opts, 0, 0, p.holder);
  }
```
to use the per-item indent override when present:
```ts
  for (const p of planned) {
    const indent = p.item.indent ?? cumulative[p.depth];
    p.element = new ListItemElement(p.item.text, p.marker, indent, p.opts, 0, 0, p.holder);
  }
```

- [ ] **Step 4: Implement — per-item spacing in the post-pass**

Change the spacing post-pass:
```ts
  els.forEach((el, i) => {
    el.spaceBefore = i === 0 ? o.spaceBefore : 0;
    el.spaceAfter = i === els.length - 1 ? o.spaceAfter : o.itemSpacing;
  });
```
to let a per-item override replace the default:
```ts
  els.forEach((el, i) => {
    const item = planned[i].item;
    el.spaceBefore = item.spaceBefore ?? (i === 0 ? o.spaceBefore : 0);
    el.spaceAfter = item.spaceAfter ?? (i === els.length - 1 ? o.spaceAfter : o.itemSpacing);
  });
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run test/flow.test.ts -t "per-item list styling"`
Expected: all 7 tests PASS.

- [ ] **Step 6: Prove an assertion is load-bearing**

Temporarily revert the indent wiring — change `const indent = p.item.indent ?? cumulative[p.depth];` back to `const indent = cumulative[p.depth];`. Rerun.
Run: `npx vitest run test/flow.test.ts -t "per-item indent"`
Expected: the "applies a per-item indent" test FAILS (body not at 100). Restore the override and confirm green.

- [ ] **Step 7: Update the README**

In `README.md`, find the `AddList(items, options)` paragraph (search for `` `AddList(items, options)` ``). After the existing sentence describing nested lists (ends `…override its own sub-list.`), append:

```markdown
An object item may also carry per-item style overrides — `font`, `fontSize`,
`color`, `align`, `leading`, `spaceBefore`, `spaceAfter`, `indent` — each
overriding the list-level value for that item only (its marker inherits the
item's font/size/colour).
```

- [ ] **Step 8: Full suite + typecheck**

Run: `npm run typecheck && npm test`
Expected: typecheck clean; entire vitest suite green.

- [ ] **Step 9: Commit**

```bash
git add src/flow.ts README.md test/flow.test.ts
git commit -m "feat(flow): per-item list indent + spacing overrides (db7v.8)"
```

---

## Self-Review

**Spec coverage:**
- `FlowListItem` gains font/fontSize/color/align/leading/spaceBefore/spaceAfter/indent → Task 1 Step 3. ✓
- Marker inherits item styling (drawn from `this.opts`, unchanged `ListItemElement`) → Task 1 Step 6 passes `p.opts`; colour test asserts red marker + body. ✓
- Text/marker style via merged per-item `NormalizedListOptions` (`resolveItemOptions`) → Task 1 Steps 5-6. ✓
- `markerGap` stays list-level; `maxWidthByDepth` measured with the item's size → Task 1 Step 6 + gutter-widening test. ✓
- Per-item `indent` = absolute body offset for that item only, not descendants → Task 2 Step 3 + indent test. ✓
- Per-item `spaceBefore`/`spaceAfter` replace the post-pass default → Task 2 Step 4 + spaceAfter test. ✓
- Non-breaking / cheap common path (uniform items reuse the list opts instance) → Task 1 Step 5 (early return) + byte-identical test. ✓
- Validation throws `TypeError` for every new field → Task 1 Step 4 + validation test. ✓
- README per-item-styling sentence → Task 2 Step 7. ✓
- No `src/index.ts` change (already exported) → Global Constraints. ✓

**Placeholder scan:** none — every step has concrete code/commands.

**Type consistency:** `resolveItemOptions(list: NormalizedListOptions, item: FlowListItem): NormalizedListOptions` defined in Task 1 Step 5, consumed in Task 1 Step 6. `Planned` gains `opts: NormalizedListOptions` in Task 1 Step 6, consumed in Task 2 Steps 3-4 (`p.opts`, `planned[i].item`). `ListItemElement` constructor arg order `(text, marker, indent, opts, spaceBefore, spaceAfter, holder)` matches every construction site (Task 1 Step 6, Task 2 Step 3). New `FlowListItem` field names (font/fontSize/color/align/leading/spaceBefore/spaceAfter/indent) match across the interface (Task 1 Step 3), validation (Task 1 Step 4), `resolveItemOptions` (Task 1 Step 5), construction/post-pass (Task 2 Steps 3-4), and README (Task 2 Step 7).

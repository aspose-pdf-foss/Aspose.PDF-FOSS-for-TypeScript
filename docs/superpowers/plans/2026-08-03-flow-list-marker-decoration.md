# Flow List Marker Decoration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give `flow.AddList` the `underline` / `strikethrough` / `background` options and paint them on the item marker as well as the item body.

**Architecture:** `FlowListOptions` and `FlowListItem` gain the three decoration fields, validated eagerly in `normalizeListOptions` / `validateNode` and carried unresolved on `NormalizedListOptions`. The body and the text marker forward them raw to `flowTextBlock` / `stampText`, which already resolve and paint decoration. The vector-bullet path (`drawShapeMarker`) paints filled paths rather than glyphs, so it calls `resolveDecor` + `decorRects` itself. Marker and body are decorated as two independent runs; the `markerGap` between them stays blank.

**Tech Stack:** TypeScript (ESM, NodeNext, `strict`), vitest. Zero runtime dependencies.

## Global Constraints

- **Spec:** `docs/superpowers/specs/2026-08-03-flow-list-marker-decoration-design.md`. Read it before Task 1.
- **Zero runtime dependencies** — only `node:` built-ins. Do not add npm runtime deps.
- **Import specifiers carry the `.js` extension** (e.g. `from './textdecor.js'`), even for `.ts` sources.
- **`behind` is NOT added** to any flow options type. Flow content is laid into a column the flow is composing; sinking one element beneath the page reorders it against its siblings.
- **All lengths are points.** Colours are `[r, g, b]` with each component in `0..1`.
- Every task ends green: `npm run typecheck` and `npx vitest run test/flow-decoration.test.ts test/flow.test.ts` both pass before you commit.
- The full suite (`npm test`) runs once, in Task 5.
- All work happens in `src/flow.ts` and `test/flow-decoration.test.ts` (plus `README.md` in Task 5). No other source file changes.

## File Structure

| File | Responsibility | Tasks |
|---|---|---|
| `src/flow.ts` (modify) | The whole change. Options types, validation, the `bodyOptions` helper, the marker draws. | 1–4 |
| `test/flow-decoration.test.ts` (modify) | All new tests, beside the existing `Flow paragraph decoration` block. | 1–4 |
| `README.md` (modify) | `AddList` options paragraph; the text-decoration Limitations entry. | 5 |

Everything the change needs already exists and is exported from `src/textdecor.ts`: `Decoration`, `Background`, `validateDecoration`, `validateBackground`, `resolveDecor`, `decorRects`, `vmetricsFor`.

## Geometry Reference (used by every test)

Every test builds the same flow, so these numbers hold throughout:

```ts
const opts = () => ({
  format: PageFormat.custom(300, 500), columns: 1,
  marginLeft: 20, marginRight: 20, marginTop: 20, marginBottom: 20,
});
```

- `contentLeft` = 20, `contentTop` = 500 − 20 = **480**, `columnWidth` = 260.
- At `fontSize: 12`, `markerGap` = 0.5 × 12 = **6**.
- First body baseline = `contentTop` − `fontSize` = 480 − 12 = **468**. The marker
  shares it (`baseline = ctx.top - fontSize` in `ListItemElement.place`).
- Ordered list: marker text is `'1.'`, `mw = measureText('1.', 12, 'Helvetica')`.
  The auto indent is `mw + 6`, the marker is right-aligned against the gutter, so
  the marker's left edge lands at **x = 20** and the body's at **x = 26 + mw**.
- Unordered default list: the marker is a vector disc of width 0.35 × 12 = **4.2**.
  Indent = 4.2 + 6 = 10.2, so the marker box is **x ∈ [20, 24.2]** and the body
  starts at **x = 30.2**.
- Helvetica metrics at 12pt (from the AFM constants in `textdecor.ts`):
  underline offset −0.1 em = **−1.2**, underline thickness 0.05 em = **0.6**,
  ascent 0.718 em = **8.616**, descent −0.207 em = **−2.484**.
- A left-aligned body line's rule spans the *measured text width*, not the box
  width (`blockLineBoxes` widens only justified lines).

---

### Task 1: List options carry decoration to the item body

**Files:**
- Modify: `src/flow.ts:9` (import), `src/flow.ts:287-315` (`FlowListOptions`), `src/flow.ts:317-333` (`NormalizedListOptions`), `src/flow.ts:390-409` (`normalizeListOptions`), `src/flow.ts:438-447` + `src/flow.ts:466-470` (`ListItemElement.measure` / `.place`)
- Test: `test/flow-decoration.test.ts`

**Interfaces:**
- Consumes: `Decoration`, `Background`, `validateDecoration`, `validateBackground` from `./textdecor.js`.
- Produces: `FlowListOptions.underline` / `.strikethrough` / `.background`; the same three fields on `NormalizedListOptions`; `function bodyOptions(o: NormalizedListOptions): TextBlockOptions` (module-private, used by Tasks 2–4 as the single definition of an item's body options).

- [ ] **Step 1: Write the failing tests**

Append to `test/flow-decoration.test.ts`, after the closing `});` of the existing `Flow paragraph decoration` block:

```ts
describe('Flow list decoration', () => {
  it('forwards underline to the item body', () => {
    const doc = Document.Open(buildBlankPage());
    const flow = doc.NewFlow(opts());
    flow.AddList(['alpha'], { ordered: true, fontSize: 12, underline: true });
    expect(decoded(flow.Render()[0])).toContain('re f');
  });

  it('forwards background and strikethrough to the item body', () => {
    const doc = Document.Open(buildBlankPage());
    const flow = doc.NewFlow(opts());
    flow.AddList(['alpha'], {
      ordered: true, fontSize: 12, background: [0, 0, 1], strikethrough: true,
    });
    expect(decoded(flow.Render()[0])).toContain('0 0 1 rg');
  });

  it('an undecorated list emits no rects', () => {
    const doc = Document.Open(buildBlankPage());
    const flow = doc.NewFlow(opts());
    flow.AddList(['alpha', 'beta'], { ordered: true, fontSize: 12 });
    expect(decoded(flow.Render()[0])).not.toContain('re f');
  });

  it('AddList rejects a malformed decoration before queuing anything', () => {
    const doc = Document.Open(buildBlankPage());
    const flow = doc.NewFlow(opts());
    expect(() => flow.AddList(['alpha'], { underline: { color: [2, 0, 0] } }))
      .toThrow(TypeError);
    expect(() => flow.AddList(['alpha'], { background: { color: [0, 0] } as never }))
      .toThrow(TypeError);
    // Nothing was queued: the rejected calls left no content behind.
    expect(decoded(flow.Render()[0])).not.toContain('alpha');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/flow-decoration.test.ts`

Expected: the four new tests FAIL. `forwards underline to the item body` and
`forwards background and strikethrough` fail on the assertion (no `re f` /
no `0 0 1 rg` in the stream — the option is silently dropped by
`ListItemElement`'s hand-copied `bodyOpts`). `AddList rejects a malformed
decoration` fails because nothing throws. `an undecorated list emits no rects`
passes already — that one is the regression guard, not a new behaviour.

`npm run typecheck` will also fail here with "Object literal may only specify
known properties" on `underline`. That is expected: vitest strips types without
checking them, so the tests still run. Both go green in Step 4.

- [ ] **Step 3: Implement**

3a. Replace the type-only import at `src/flow.ts:9`:

```ts
import {
  validateDecoration, validateBackground,
  type Decoration, type Background,
} from './textdecor.js';
```

3b. In `FlowListOptions`, immediately after `leading?: number;`:

```ts
  /** Rule below the baseline of the marker and of every body line. The marker
   *  and the body are decorated as two separate runs, so the gap between them
   *  stays blank. Default: none. */
  underline?: Decoration;
  /** Rule through the glyphs of the marker and of every body line. Default: none. */
  strikethrough?: Decoration;
  /** Fill painted behind the marker and behind each body line. Default: none. */
  background?: Background;
```

3c. In `NormalizedListOptions`, immediately after `leading?: number;`:

```ts
  underline?: Decoration;
  strikethrough?: Decoration;
  background?: Background;
```

3d. In `normalizeListOptions`, immediately before the `return {`:

```ts
  validateDecoration('underline', o.underline);
  validateDecoration('strikethrough', o.strikethrough);
  validateBackground('background', o.background);
```

and add to the returned object literal, after `align: o.align,`:

```ts
    underline: o.underline, strikethrough: o.strikethrough, background: o.background,
```

3e. Add this helper directly above `class ListItemElement`:

```ts
/** The text-block options an item's body is flowed with. One definition, so
 *  `measure` and `place` cannot drift apart — a field added to one and not the
 *  other measures a layout it does not draw. @internal */
function bodyOptions(o: NormalizedListOptions): TextBlockOptions {
  return {
    font: o.font, fontSize: o.fontSize, color: o.color,
    align: o.align, leading: o.leading,
    underline: o.underline, strikethrough: o.strikethrough, background: o.background,
  };
}
```

3f. In `ListItemElement.measure`, replace the `bodyOpts` literal:

```ts
    const bodyOpts = bodyOptions(this.opts);
```

3g. In `ListItemElement.place`, replace the `bodyOpts` literal:

```ts
    const bodyOpts: TextBlockOptions = {
      ...bodyOptions(this.opts),
      ...(this.lbody ? { tag: this.lbody } : {}),
    };
```

- [ ] **Step 4: Run the tests and the typechecker**

Run: `npx vitest run test/flow-decoration.test.ts test/flow.test.ts && npm run typecheck`
Expected: PASS, all of them, with no warnings.

- [ ] **Step 5: Commit**

```bash
git add src/flow.ts test/flow-decoration.test.ts
git commit -m "feat(flow): AddList takes underline/strikethrough/background"
```

---

### Task 2: Decorate a text marker (ordinal or explicit bullet)

**Files:**
- Modify: `src/flow.ts:491-498` (the `markerOpts` branch of `ListItemElement.place`)
- Test: `test/flow-decoration.test.ts`

**Interfaces:**
- Consumes: `NormalizedListOptions.underline` / `.strikethrough` / `.background` (Task 1).
- Produces: nothing new. `stampText` already resolves the decoration against the marker's own font/size/colour and paints at the stamp's measured width.

- [ ] **Step 1: Write the failing tests**

Add to `test/flow-decoration.test.ts` inside the `Flow list decoration` block.
First extend the imports at the top of the file:

```ts
import { measureText } from '../src/stamp.js';
```

Then the tests:

```ts
  it('underlines the ordinal marker as well as the body', () => {
    const doc = Document.Open(buildBlankPage());
    const flow = doc.NewFlow(opts());
    flow.AddList(['alpha'], { ordered: true, fontSize: 12, underline: true });
    // One rule under the marker, one under the single body line.
    expect((decoded(flow.Render()[0]).match(/re f/g) ?? []).length).toBe(2);
  });

  it('places the two rules where GetPaths reads them back', () => {
    const doc = Document.Open(buildBlankPage());
    const flow = doc.NewFlow(opts());
    flow.AddList(['alpha'], { ordered: true, fontSize: 12, underline: true });
    const page = flow.Render()[0];
    const rules = page.GetPaths().filter((p) => p.fill !== null)
      .sort((a, b) => a.bbox[0] - b.bbox[0]);
    expect(rules).toHaveLength(2);

    const mw = measureText('1.', 12, 'Helvetica');
    // The marker is right-aligned against the gutter, so it starts at the
    // column's left edge; the body starts one marker + one markerGap in.
    expect(rules[0].bbox[0]).toBeCloseTo(20, 3);
    expect(rules[0].bbox[2]).toBeCloseTo(20 + mw, 3);
    expect(rules[1].bbox[0]).toBeCloseTo(20 + mw + 6, 3);
    expect(rules[1].bbox[2]).toBeCloseTo(20 + mw + 6 + measureText('alpha', 12, 'Helvetica'), 3);
    // The gutter between them is blank: two runs, not one spanning rule.
    expect(rules[1].bbox[0]).toBeGreaterThan(rules[0].bbox[2]);

    // Both sit on the same baseline (480 - 12), offset -1.2, thickness 0.6.
    for (const r of rules) {
      expect(r.bbox[1]).toBeCloseTo(468 - 1.2 - 0.3, 3);
      expect(r.bbox[3]).toBeCloseTo(468 - 1.2 + 0.3, 3);
    }
  });

  it('decorates an explicit bullet string', () => {
    const doc = Document.Open(buildBlankPage());
    const flow = doc.NewFlow(opts());
    flow.AddList(['alpha'], { bullet: '-', fontSize: 12, underline: true });
    expect((decoded(flow.Render()[0]).match(/re f/g) ?? []).length).toBe(2);
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/flow-decoration.test.ts`
Expected: the three new tests FAIL — `expected 1 to be 2` on the two count
assertions, and `expected length 1 to be 2` on the `GetPaths` one. Only the body
is decorated; the marker's `stampText` call gets no decoration options.

- [ ] **Step 3: Implement**

In `ListItemElement.place`, in the `else` branch that stamps a text marker,
replace the `markerOpts` literal:

```ts
        const markerOpts: StampOptions = {
          font: this.opts.font, fontSize: this.opts.fontSize, color: this.opts.color,
          underline: this.opts.underline, strikethrough: this.opts.strikethrough,
          background: this.opts.background,
          ...(this.lbl ? { tag: this.lbl } : {}),
        };
```

- [ ] **Step 4: Run the tests and the typechecker**

Run: `npx vitest run test/flow-decoration.test.ts test/flow.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/flow.ts test/flow-decoration.test.ts
git commit -m "feat(flow): decorate a list item's text marker"
```

---

### Task 3: Decorate a vector bullet

**Files:**
- Modify: `src/flow.ts:335-370` (`drawShapeMarker`), `src/flow.ts:488-490` (its call site in `ListItemElement.place`)
- Test: `test/flow-decoration.test.ts`

**Interfaces:**
- Consumes: `NormalizedListOptions` (Task 1) — `drawShapeMarker`'s `fontSize` / `color` parameters are replaced by the whole options object, which is also the `DecorationOptions` it resolves.
- Produces: `drawShapeMarker(doc, page, shape, rightX, baseline, o: NormalizedListOptions, tag?)` — the new signature. No other caller exists.

- [ ] **Step 1: Write the failing tests**

Add to `test/flow-decoration.test.ts` inside the `Flow list decoration` block:

```ts
  it('underlines the default vector bullet as well as the body', () => {
    const doc = Document.Open(buildBlankPage());
    const flow = doc.NewFlow(opts());
    flow.AddList(['alpha'], { fontSize: 12, underline: true });
    // The disc itself is Beziers + `f`, never `re f`, so both rects are rules.
    expect((decoded(flow.Render()[0]).match(/re f/g) ?? []).length).toBe(2);
  });

  it("a bullet's background spans the font's ascent-to-descent, not the bullet box", () => {
    const doc = Document.Open(buildBlankPage());
    const flow = doc.NewFlow(opts());
    flow.AddList(['alpha'], { fontSize: 12, background: [0, 1, 0] });
    const page = flow.Render()[0];
    // GetPaths reports colour components in 0..255, not 0..1.
    const green = page.GetPaths().filter(
      (p) => p.fill !== null && p.fill.rgb[0] === 0 && p.fill.rgb[1] === 255 && p.fill.rgb[2] === 0);
    expect(green).toHaveLength(2); // marker background + body background

    const marker = green.sort((a, b) => a.bbox[0] - b.bbox[0])[0];
    // Horizontal extent is the bullet's own 0.35em box, at the column edge.
    expect(marker.bbox[0]).toBeCloseTo(20, 3);
    expect(marker.bbox[2]).toBeCloseTo(24.2, 3);
    // Vertical extent is the FONT's, so it aligns with the body's background
    // instead of floating as a small square at x-height.
    expect(marker.bbox[1]).toBeCloseTo(468 - 2.484, 3);
    expect(marker.bbox[3]).toBeCloseTo(468 + 8.616, 3);
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/flow-decoration.test.ts`
Expected: both FAIL — `expected 1 to be 2` and `expected length 1 to be 2`.
`drawShapeMarker` emits the disc and nothing else.

- [ ] **Step 3: Implement**

3a. Extend the `textdecor.js` import at `src/flow.ts:9` (it already brings in the
two validators from Task 1):

```ts
import {
  validateDecoration, validateBackground, resolveDecor, decorRects, vmetricsFor,
  type Decoration, type Background,
} from './textdecor.js';
```

3b. Replace `drawShapeMarker` entirely. `fontSize` and `color` become `o`, and
the composed body picks up the decoration layers:

```ts
/** Paint a vector list marker (disc/ring/square) whose right edge sits at
 *  `rightX`, centered near the first line's x-height. The marker's decoration is
 *  resolved here rather than inherited from `stampText`, because the shape is
 *  filled paths and not glyphs; its horizontal extent is the bullet's own box,
 *  its vertical extent the font's, so a bullet background lines up with the
 *  body's instead of floating as a small square at x-height. Wrapped in the
 *  /Lbl marked content when `tag` is given. @internal */
function drawShapeMarker(
  doc: Document, page: Page, shape: (typeof BULLET_SHAPES)[number],
  rightX: number, baseline: number, o: NormalizedListOptions, tag?: StructElement,
): void {
  const fontSize = o.fontSize;
  const size = 0.35 * fontSize;         // diameter / side
  const color = o.color ?? [0, 0, 0];
  const [r, g, b] = color;
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
  // Each decoration layer gets its own q/Q, so its fill colour cannot leak into
  // the shape or into whatever the page draws next. No `cm` is needed: this
  // function already works in absolute page space.
  const decor = resolveDecor(o, color, fontSize, vmetricsFor(o.font));
  const parts: string[] = [];
  if (decor) {
    const d = decorRects([{ x: left, baseline, width: size }], decor);
    if (d.beneath) parts.push(`q\n${d.beneath}Q`);
    parts.push(s);
    if (d.above) parts.push(`q\n${d.above}Q`);
  } else {
    parts.push(s);
  }
  const body = enc(parts.join('\n'));
  const tagged = tag
    ? wrapMarkedContent(tag.Type, allocContentMcid(doc, tag, page), body)
    : body;
  appendContent(doc, page, tagged);
}
```

3c. Update the single call site in `ListItemElement.place`:

```ts
      if (this.marker.kind === 'shape') {
        drawShapeMarker(ctx.doc, ctx.page, this.marker.shape, rightEdge, baseline,
          this.opts, this.lbl);
      } else {
```

- [ ] **Step 4: Run the tests and the typechecker**

Run: `npx vitest run test/flow-decoration.test.ts test/flow.test.ts && npm run typecheck`
Expected: PASS. `test/flow.test.ts` covers undecorated bullet lists and must stay
green — the `else` branch keeps the old single-part body, so those bytes are
unchanged.

- [ ] **Step 5: Commit**

```bash
git add src/flow.ts test/flow-decoration.test.ts
git commit -m "feat(flow): decorate a list item's vector bullet"
```

---

### Task 4: Per-item decoration overrides

**Files:**
- Modify: `src/flow.ts:515-546` (`FlowListItem`), `src/flow.ts:560-590` (`validateNode`), `src/flow.ts:592-608` (`resolveItemOptions`)
- Test: `test/flow-decoration.test.ts`

**Interfaces:**
- Consumes: `NormalizedListOptions` decoration fields (Task 1).
- Produces: `FlowListItem.underline` / `.strikethrough` / `.background`.

- [ ] **Step 1: Write the failing tests**

Add to `test/flow-decoration.test.ts` inside the `Flow list decoration` block:

```ts
  it('a per-item underline decorates that item only', () => {
    const doc = Document.Open(buildBlankPage());
    const flow = doc.NewFlow(opts());
    flow.AddList([{ text: 'alpha', underline: true }, 'beta'],
      { ordered: true, fontSize: 12 });
    // Item 1: marker rule + body rule. Item 2: nothing.
    expect((decoded(flow.Render()[0]).match(/re f/g) ?? []).length).toBe(2);
  });

  it('a per-item override can switch the list default off', () => {
    const doc = Document.Open(buildBlankPage());
    const flow = doc.NewFlow(opts());
    flow.AddList(['alpha', { text: 'beta', underline: false }],
      { ordered: true, fontSize: 12, underline: true });
    expect((decoded(flow.Render()[0]).match(/re f/g) ?? []).length).toBe(2);
  });

  it('rejects a malformed per-item decoration', () => {
    const doc = Document.Open(buildBlankPage());
    const flow = doc.NewFlow(opts());
    expect(() => flow.AddList([{ text: 'alpha', strikethrough: { thickness: -1 } }]))
      .toThrow(TypeError);
  });
```

Note the second test: `underline: false` must reach `resolveItemOptions` as an
override, not be treated as "unset". `false ?? list.underline` is `false`, which
is what `resolveDecor` reads as off — the `??` operator is load-bearing here and
`||` would be a bug.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/flow-decoration.test.ts`
Expected: `a per-item underline decorates that item only` FAILS with
`expected 0 to be 2` (the item's `underline` is dropped by `resolveItemOptions`'s
uniform-list fast path, which returns the list options unchanged).
`a per-item override can switch the list default off` FAILS with
`expected 4 to be 2` (both items are decorated).
`rejects a malformed per-item decoration` FAILS because nothing throws.

- [ ] **Step 3: Implement**

3a. In `FlowListItem`, after `leading?: number;`:

```ts
  /** Override the marker + body underline for THIS item. `false` switches the
   *  list-level value off. Default: the list value. */
  underline?: Decoration;
  /** Override the marker + body strikethrough for THIS item. Default: the list value. */
  strikethrough?: Decoration;
  /** Override the marker + body background for THIS item. Default: the list value. */
  background?: Background;
```

3b. In `validateNode`, immediately before `return n;`:

```ts
  validateDecoration('item.underline', n.underline);
  validateDecoration('item.strikethrough', n.strikethrough);
  validateBackground('item.background', n.background);
```

3c. Replace `resolveItemOptions` entirely — the fast-path guard must test the
three new fields, or a decorated item silently draws undecorated:

```ts
/** Merge an item's style overrides onto the list options. Returns `list`
 *  unchanged when the item sets no style field (uniform-list fast path, keeping
 *  output byte-identical to a plain string list). @internal */
function resolveItemOptions(list: NormalizedListOptions, item: FlowListItem): NormalizedListOptions {
  if (item.font === undefined && item.fontSize === undefined && item.color === undefined
      && item.align === undefined && item.leading === undefined
      && item.underline === undefined && item.strikethrough === undefined
      && item.background === undefined) {
    return list;
  }
  return {
    ...list,
    font: item.font ?? list.font,
    fontSize: item.fontSize ?? list.fontSize,
    color: item.color ?? list.color,
    align: item.align ?? list.align,
    leading: item.leading ?? list.leading,
    // `??`, not `||`: an item's `underline: false` is an override that switches
    // the list-level rule off, not an absent value to fall back from.
    underline: item.underline ?? list.underline,
    strikethrough: item.strikethrough ?? list.strikethrough,
    background: item.background ?? list.background,
  };
}
```

- [ ] **Step 4: Run the tests and the typechecker**

Run: `npx vitest run test/flow-decoration.test.ts test/flow.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/flow.ts test/flow-decoration.test.ts
git commit -m "feat(flow): per-item decoration overrides on AddList"
```

---

### Task 5: Prove the assertions load-bearing, then document

**Files:**
- Modify: `README.md` (the `AddList` options paragraph near line 520; the text-decoration Limitations entry near line 1460)
- Verify: `src/flow.ts`, `test/flow-decoration.test.ts` (no permanent changes)

**Interfaces:**
- Consumes: everything from Tasks 1–4.
- Produces: nothing consumed by later tasks.

CLAUDE.md requires this: a test that passes on the first run is not yet evidence.
Break each code path and confirm the suite goes red.

- [ ] **Step 1: Mutation — the text marker**

In `ListItemElement.place`, temporarily delete the three decoration lines from
`markerOpts` (Task 2, step 3).

Run: `npx vitest run test/flow-decoration.test.ts`
Expected: RED — `underlines the ordinal marker as well as the body`,
`places the two rules where GetPaths reads them back` and
`decorates an explicit bullet string` all fail.

**Restore the lines** (`git checkout src/flow.ts` if the file is otherwise clean,
or undo by hand) and re-run to confirm green before continuing.

- [ ] **Step 2: Mutation — the vector bullet**

In `drawShapeMarker`, temporarily replace `const decor = resolveDecor(...)` with
`const decor = undefined;`.

Run: `npx vitest run test/flow-decoration.test.ts`
Expected: RED — `underlines the default vector bullet as well as the body` and
`a bullet's background spans the font's ascent-to-descent` both fail.

Restore and re-run to confirm green.

- [ ] **Step 3: Mutation — the bullet background's vertical extent**

The point of that test is that the bullet's background is *font*-tall, not
*bullet*-tall. Temporarily change the `decorRects` call in `drawShapeMarker` to
pass a bullet-tall box instead, by replacing the whole `decor` block with:

```ts
  const decor = resolveDecor(o, color, fontSize, vmetricsFor(o.font));
  const shrunk = decor?.background
    ? { ...decor, background: { ...decor.background, top: size, bottom: 0 } }
    : decor;
```

and using `shrunk` in the `decorRects` call.

Run: `npx vitest run test/flow-decoration.test.ts`
Expected: RED — `a bullet's background spans the font's ascent-to-descent` fails
on the `bbox[1]` / `bbox[3]` assertions.

Restore and re-run to confirm green.

- [ ] **Step 4: Mutation — the fast-path guard**

In `resolveItemOptions`, temporarily drop `&& item.underline === undefined
&& item.strikethrough === undefined && item.background === undefined` from the
guard.

Run: `npx vitest run test/flow-decoration.test.ts`
Expected: RED — `a per-item underline decorates that item only` fails with
`expected 0 to be 2`.

Restore and re-run to confirm green.

- [ ] **Step 5: Run the full suite**

Run: `npm test && npm run typecheck`
Expected: PASS, everything, with no warnings. `src/flow.ts` must be back to its
Task 4 state — confirm with `git diff src/flow.ts` showing no output.

- [ ] **Step 6: Update the README**

6a. In the `AddList` section (search for "list-level value for that item only"),
append to the paragraph that describes the per-item overrides:

```markdown
`underline`, `strikethrough` and `background` decorate the list too, at either
level. The marker and the item body are decorated as **two separate runs**, so a
rule covers the bullet or ordinal and then the body text, leaving the gutter
between them blank; a background behind a vector bullet is as tall as the font,
so it lines up with the body's.
```

6b. In the Limitations section, find the entry beginning
`- **Text decoration is per-call, not per-run**` and rewrite its middle so the
list-marker clause is gone and the TOC clause stands alone. Replace:

```
Each stamp is decorated independently, which shows in two places: a TOC row is three stamps (title, dot leader, page number), so its underline breaks at the `leaderGap` blanks either side of the leader rather than running unbroken across the row; and `flow.AddList` draws the item marker as a separate stamp, so an underlined list item leaves its bullet or number undecorated.
```

with:

```
Each stamp is decorated independently, which shows in a TOC row: it is three stamps (title, dot leader, page number), so its underline breaks at the `leaderGap` blanks either side of the leader rather than running unbroken across the row. `flow.AddList` decorates the item marker and the item body the same way — two runs with a blank gutter between them, not one rule spanning both.
```

- [ ] **Step 7: Commit**

```bash
git add README.md
git commit -m "docs: AddList decorates markers and bodies alike"
```

- [ ] **Step 8: Close the issue and push**

```bash
bd close aspose-pdf-foss-for-ts-1gg0.15
git pull --rebase
git push
git status   # MUST show "up to date with origin"
```

---

## Notes for the implementer

- **Why the marker is a separate run.** The body's per-line rects are computed
  inside `flowTextBlock` (`blockLineBoxes`), which knows nothing about the
  marker. Unioning the marker into the body's first line box would need a
  one-off code path in `ListItemElement` that no other consumer has. Two runs is
  also what `1gg0.4` established for a TOC row. Do not "improve" this into a
  spanning rule.
- **Why `drawShapeMarker` resolves its own decoration.** It paints filled paths,
  not glyphs, so there is no `stampText` call to inherit from.
- **Continuations need no work.** `markerDrawn` already confines the marker to
  its first placement, so its decoration is drawn once even when an item wraps
  across a column or page; the body continuation carries the same options and so
  every wrapped line gets its rects. If you find yourself editing the
  continuation branch, stop — something else is wrong.
- **Do not add `behind`.** See Global Constraints.

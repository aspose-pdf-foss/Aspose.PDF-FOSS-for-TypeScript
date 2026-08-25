# Flow inline images Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `flow.AddImage(data, options)` places a JPEG/PNG image as its own flow block — column-fitted, aspect-preserving, alignable, atomically paginated, `/Figure`-tagged when the flow is tagged.

**Architecture:** A new `ImageElement implements FlowElement` in `flow.ts` wraps a `BuiltImage` (from the existing `buildImageXObject`) and paints via the existing `drawBuiltImage`. Sizing resolves lazily from the region width the engine hands `place`/`measure`, so the two always agree. No flow-engine changes: the element plugs into gap/spacing, pagination, keep-with-next, and the empty-column guard unchanged.

**Tech Stack:** TypeScript (ESM + NodeNext, `strict`; `.js` import specifiers), vitest. Zero runtime deps (`node:` built-ins only).

## Global Constraints

- Zero runtime dependencies — only `node:` built-ins. Do not add npm runtime deps.
- ESM + NodeNext: every relative import specifier carries the `.js` extension.
- TDD: write the failing test first, watch it fail, then implement. Assertions must be load-bearing (breaking the code path turns the suite red).
- Run `npm run typecheck` and `npm test` green before considering the issue done.
- Option-validation failures throw `TypeError`; an unrecognized image throws `UnsupportedFeatureError` (raised inside `buildImageXObject`).
- Files touched: `src/flow.ts`, `src/index.ts`, `test/flow.test.ts`, `README.md`.

---

### Task 1: `ImageElement` model + `makeImage` factory + options/validation (`flow.ts`)

The atomic flow image element and its options, unit-tested through the `makeImage` factory (its `place`/`measure` exercised directly, no full render).

**Files:**
- Modify: `src/flow.ts` — add the `./imageembed.js` import; add `FlowImageOptions`; broaden `normalizeSpacing`; add `class ImageElement`; add `buildImageElement` + `makeImage`
- Modify: `src/index.ts:70-73` — export `FlowImageOptions`
- Test: `test/flow.test.ts` (new `describe('flow image element', …)`)

**Interfaces:**
- Consumes: `buildImageXObject(data, format?) → BuiltImage` and `drawBuiltImage(doc, page, built, [x,y,w,h], { tag? })` from `./imageembed.js`; the existing `MeasureContext`, `PlaceContext`, `PlaceResult`, `FlowElement`, `nonNegative`, `normalizeSpacing` in `flow.ts`. `BuiltImage.stream.dict` carries numeric `'Width'`/`'Height'`. `StructElement.Append(type, { alt }?)` returns the child element.
- Produces:
  - `export interface FlowImageOptions { width?: number; height?: number; format?: 'jpeg'|'png'; align?: 'left'|'center'|'right'; alt?: string; spaceBefore?: number; spaceAfter?: number }`
  - `export function makeImage(data: Uint8Array, options?: FlowImageOptions): FlowElement`
  - `class ImageElement implements FlowElement` with `place`, `measure`, `readonly spaceBefore`, `readonly spaceAfter`.

- [ ] **Step 1: Write the failing test**

Add to `test/flow.test.ts`. `buildPngRgb` (a 2×1 RGB PNG → intrinsic aspect ih/iw = 0.5) is already imported at the top of the file. Build a `PlaceContext`/`MeasureContext` directly, as the existing "paragraph element placement" tests do.

```ts
describe('flow image element', () => {
  const cm = (page: import('../src/page.js').Page) =>
    new TextDecoder('latin1').decode(page.Contents);

  it('default fills the region width with aspect height, left-aligned', () => {
    const doc = Document.Open(buildBlankPage());
    const page = doc.Pages[0];
    const el = makeImage(buildPngRgb()); // 2x1 → height = width/2
    const res = el.place({ doc, page, x: 20, top: 400, width: 260, availHeight: 400 });
    expect(res.drew).toBe(true);
    expect(res.usedHeight).toBeCloseTo(130, 6); // 260 * (1/2)
    expect(res.remainder).toBeNull();
    expect(cm(page)).toMatch(/260 0 0 130 20 270 cm/); // [x=20, y=400-130=270, w=260, h=130]
  });

  it('honors an explicit width (aspect height) below the region width', () => {
    const doc = Document.Open(buildBlankPage());
    const page = doc.Pages[0];
    const el = makeImage(buildPngRgb(), { width: 100 });
    el.place({ doc, page, x: 20, top: 400, width: 260, availHeight: 400 });
    expect(cm(page)).toMatch(/100 0 0 50 20 350 cm/); // w=100,h=50,x=20,y=350
  });

  it('clamps an over-region width to the region, preserving aspect', () => {
    const doc = Document.Open(buildBlankPage());
    const page = doc.Pages[0];
    const el = makeImage(buildPngRgb(), { width: 520 }); // baseH = 260; factor 260/520
    el.place({ doc, page, x: 20, top: 400, width: 260, availHeight: 400 });
    expect(cm(page)).toMatch(/260 0 0 130 20 270 cm/); // clamped to 260x130 (still 2:1)
  });

  it('aligns center and right within the region', () => {
    const center = Document.Open(buildBlankPage());
    makeImage(buildPngRgb(), { width: 100, align: 'center' })
      .place({ doc: center, page: center.Pages[0], x: 20, top: 400, width: 260, availHeight: 400 });
    expect(cm(center.Pages[0])).toMatch(/100 0 0 50 100 350 cm/); // x = 20 + (260-100)/2

    const right = Document.Open(buildBlankPage());
    makeImage(buildPngRgb(), { width: 100, align: 'right' })
      .place({ doc: right, page: right.Pages[0], x: 20, top: 400, width: 260, availHeight: 400 });
    expect(cm(right.Pages[0])).toMatch(/100 0 0 50 180 350 cm/); // x = 20 + 260-100
  });

  it('place returns drew:false / remainder:self when the image is taller than availHeight', () => {
    const doc = Document.Open(buildBlankPage());
    const el = makeImage(buildPngRgb()); // 260-wide region → 130 tall
    const res = el.place({ doc, page: doc.Pages[0], x: 20, top: 400, width: 260, availHeight: 100 });
    expect(res.drew).toBe(false);
    expect(res.remainder).toBe(el);
    expect(cm(doc.Pages[0])).not.toMatch(/Do\b/); // no image XObject drawn
  });

  it('measure reports fit atomically', () => {
    const el = makeImage(buildPngRgb());
    expect(el.measure!({ width: 260, availHeight: 130 })).toEqual({ usedHeight: 130, fits: true });
    expect(el.measure!({ width: 260, availHeight: 129 })).toEqual({ usedHeight: 0, fits: false });
  });

  it('validates options and rejects non-images', () => {
    expect(() => makeImage(buildPngRgb(), { width: 0 })).toThrow(TypeError);
    expect(() => makeImage(buildPngRgb(), { width: -1 })).toThrow(TypeError);
    expect(() => makeImage(buildPngRgb(), { height: -1 })).toThrow(TypeError);
    expect(() => makeImage(buildPngRgb(), { align: 'middle' as any })).toThrow(TypeError);
    expect(() => makeImage(buildPngRgb(), { alt: 5 as any })).toThrow(TypeError);
    expect(() => makeImage(buildPngRgb(), { spaceBefore: -1 })).toThrow(TypeError);
    expect(() => makeImage(new Uint8Array([1, 2, 3]))).toThrow(); // UnsupportedFeatureError
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/flow.test.ts -t "flow image element"`
Expected: FAIL — `makeImage` is not exported.

- [ ] **Step 3: Implement — import**

In `src/flow.ts`, add after the `./stamp.js` import block:

```ts
import { buildImageXObject, drawBuiltImage, type BuiltImage } from './imageembed.js';
```

- [ ] **Step 4: Implement — broaden `normalizeSpacing`**

`normalizeSpacing` currently takes `FlowParagraphOptions`. Broaden its parameter so `FlowImageOptions` (and any spacing-bearing options) can reuse it. Replace its signature line:

```ts
function normalizeSpacing(o: { spaceBefore?: number; spaceAfter?: number }): { spaceBefore: number; spaceAfter: number } {
```

(The body is unchanged; `FlowParagraphOptions` still satisfies the wider parameter.)

- [ ] **Step 5: Implement — `FlowImageOptions`**

Add near the other flow option interfaces (e.g. after `FlowListOptions`):

```ts
/** Options for {@link Flow.AddImage}. All lengths are in points. */
export interface FlowImageOptions {
  /** Drawn width. Default: the column (region) width. Clamped down to the region
   *  width if larger (aspect preserved). > 0. */
  width?: number;
  /** Drawn height. Omitted/0 → auto from aspect ratio at the drawn width. >= 0. */
  height?: number;
  /** Force the decoder; default sniffs JPEG/PNG magic bytes. */
  format?: 'jpeg' | 'png';
  /** Horizontal alignment within the column. Default 'left'. */
  align?: 'left' | 'center' | 'right';
  /** Alt text for the `/Figure` when the flow is tagged. */
  alt?: string;
  /** Points inserted above the image (dropped at a column top). >= 0. Default 0. */
  spaceBefore?: number;
  /** Points inserted below the image (dropped at a column top). >= 0. Default 0. */
  spaceAfter?: number;
}
```

- [ ] **Step 6: Implement — `ImageElement`**

Add the class (near `TextElement`/`ListItemElement`). It reads intrinsic dimensions off the built XObject dict, resolves size lazily, and paints via `drawBuiltImage`:

```ts
/** An atomic raster image flow block (JPEG/PNG). Sized lazily from the region
 *  width so `place` and `measure` agree; never splits across a column. @internal */
class ImageElement implements FlowElement {
  private readonly iw: number;
  private readonly ih: number;

  constructor(
    private readonly built: BuiltImage,
    private readonly reqWidth: number | undefined,
    private readonly reqHeight: number | undefined,
    private readonly align: 'left' | 'center' | 'right',
    private readonly alt: string | undefined,
    readonly spaceBefore: number,
    readonly spaceAfter: number,
  ) {
    this.iw = built.stream.dict.get('Width') as number;
    this.ih = built.stream.dict.get('Height') as number;
  }

  /** Drawn size for a given region width: default fills the region; an over-region
   *  width clamps down (requested aspect preserved). */
  private resolveSize(regionWidth: number): { drawW: number; drawH: number } {
    const baseW = this.reqWidth ?? regionWidth;
    const baseH = this.reqHeight !== undefined && this.reqHeight > 0
      ? this.reqHeight : baseW * (this.ih / this.iw);
    if (baseW > regionWidth) {
      const factor = regionWidth / baseW;
      return { drawW: regionWidth, drawH: baseH * factor };
    }
    return { drawW: baseW, drawH: baseH };
  }

  measure(ctx: MeasureContext): { usedHeight: number; fits: boolean } {
    if (ctx.availHeight <= 0) return { usedHeight: 0, fits: false };
    const { drawH } = this.resolveSize(ctx.width);
    return drawH <= ctx.availHeight + 1e-9
      ? { usedHeight: drawH, fits: true }
      : { usedHeight: 0, fits: false };
  }

  place(ctx: PlaceContext): PlaceResult {
    if (ctx.availHeight <= 0) return { usedHeight: 0, remainder: this, drew: false };
    const { drawW, drawH } = this.resolveSize(ctx.width);
    if (drawH > ctx.availHeight + 1e-9) return { usedHeight: 0, remainder: this, drew: false };
    const offsetX = this.align === 'center' ? (ctx.width - drawW) / 2
      : this.align === 'right' ? ctx.width - drawW : 0;
    const fig = ctx.structParent
      ? ctx.structParent.Append('Figure', this.alt !== undefined ? { alt: this.alt } : undefined)
      : undefined;
    drawBuiltImage(ctx.doc, ctx.page, this.built,
      [ctx.x + offsetX, ctx.top - drawH, drawW, drawH], fig ? { tag: fig } : {});
    return { usedHeight: drawH, remainder: null, drew: true };
  }
}
```

- [ ] **Step 7: Implement — `buildImageElement` + `makeImage`**

Add the shared builder/validator and the test factory:

```ts
/** Validate `options`, embed the image, and build one {@link ImageElement}. @internal */
function buildImageElement(data: Uint8Array, o: FlowImageOptions): FlowElement {
  if (o.width !== undefined && (!Number.isFinite(o.width) || o.width <= 0))
    throw new TypeError('image width must be a positive finite number');
  if (o.height !== undefined && (!Number.isFinite(o.height) || o.height < 0))
    throw new TypeError('image height must be a non-negative finite number');
  const align = o.align ?? 'left';
  if (align !== 'left' && align !== 'center' && align !== 'right')
    throw new TypeError("align must be 'left', 'center', or 'right'");
  if (o.alt !== undefined && typeof o.alt !== 'string')
    throw new TypeError('alt must be a string');
  const { spaceBefore, spaceAfter } = normalizeSpacing(o);
  const built = buildImageXObject(data, o.format);
  return new ImageElement(built, o.width, o.height, align, o.alt, spaceBefore, spaceAfter);
}

/** Test-only factory for a flow image element. @internal */
export function makeImage(data: Uint8Array, options: FlowImageOptions = {}): FlowElement {
  return buildImageElement(data, options);
}
```

- [ ] **Step 8: Implement — export from index**

In `src/index.ts`, add `FlowImageOptions` to the `flow.js` type export (lines 70-73):

```ts
export type {
  FlowOptions, FlowParagraphOptions, FlowHeadingOptions, FlowListOptions, FlowImageOptions,
  FlowElement, PlaceContext, PlaceResult,
} from './flow.js';
```

- [ ] **Step 9: Run test to verify it passes**

Run: `npx vitest run test/flow.test.ts -t "flow image element"`
Expected: PASS (7 tests).

- [ ] **Step 10: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 11: Commit**

```bash
git add src/flow.ts src/index.ts test/flow.test.ts
git commit -m "feat(flow): ImageElement + makeImage factory for inline images (db7v.5)"
```

---

### Task 2: `Flow.AddImage` + integration, tagging & README (`flow.ts`)

Wire the public method onto the `Flow` class and verify end-to-end behavior through `Render`.

**Files:**
- Modify: `src/flow.ts` — add `AddImage` to `class Flow` (near `AddList`)
- Modify: `README.md` — Flow section (add `AddImage`; drop "main-column flow images … follow-up")
- Test: `test/flow.test.ts` (new `describe('flow images (AddImage)', …)`)

**Interfaces:**
- Consumes: `buildImageElement` and `FlowImageOptions` from Task 1; the existing `Flow.items`/`Render` engine.
- Produces: `Flow.AddImage(data: Uint8Array, options?: FlowImageOptions): this`.

- [ ] **Step 1: Write the failing tests**

```ts
describe('flow images (AddImage)', () => {
  const has = (page: any, re: RegExp) => re.test(new TextDecoder('latin1').decode(page.Contents));
  const opts = (extra = {}) => ({
    format: PageFormat.custom(300, 200), columns: 1,
    marginLeft: 20, marginRight: 20, marginTop: 20, marginBottom: 20, ...extra, // colW 260, colH 160
  });
  const L = { font: 'Helvetica' as const, fontSize: 12, leading: 20 };

  it('renders a column-width image and is chainable', () => {
    const doc = Document.Open(buildBlankPage());
    const flow = doc.NewFlow(opts());
    expect(flow.AddImage(buildPngRgb())).toBe(flow);
    const pages = flow.Render();
    expect(pages.length).toBe(1);
    expect(has(pages[0], /260 0 0 130 20 /)).toBe(true); // 260-wide, 130 tall at column x
  });

  it('paginates atomically: an image that will not fit moves wholly to the next page', () => {
    const doc = Document.Open(buildBlankPage());
    const flow = doc.NewFlow(opts());
    flow.AddParagraph(Array.from({ length: 5 }, (_, i) => `F${i}`).join('\n'), L); // 100pt used → 60 left
    flow.AddImage(buildPngRgb()); // 130 tall → cannot fit in 60
    const pages = flow.Render();
    expect(pages.length).toBe(2);
    expect(has(pages[0], /0 0 130 /)).toBe(false); // not on page 1
    expect(has(pages[1], /260 0 0 130 /)).toBe(true); // whole image on page 2
  });

  it('throws when an image is taller than an empty column', () => {
    const doc = Document.Open(buildBlankPage());
    const flow = doc.NewFlow({ format: PageFormat.custom(300, 100), columns: 1,
      marginLeft: 20, marginRight: 20, marginTop: 20, marginBottom: 20 }); // colH 60 < 130
    flow.AddImage(buildPngRgb());
    expect(() => flow.Render()).toThrow(/does not fit in an empty column/i);
  });

  it('spaceAfter shifts following content by the given points', () => {
    function belowY(spaceAfter: number): number {
      const doc = Document.Open(buildBlankPage());
      const flow = doc.NewFlow(opts({ format: PageFormat.custom(300, 500) })); // tall page, one column
      flow.AddImage(buildPngRgb(), { width: 40, spaceAfter }); // 20 tall
      flow.AddParagraph('below', L);
      const page = flow.Render()[0];
      return page.GetTextFragments().find((f: any) => f.text.includes('below'))!.quad[1];
    }
    expect(belowY(0) - belowY(20)).toBeCloseTo(20, 2); // larger spaceAfter pushes 'below' down
  });

  it('emits exactly one /Figure with /Alt when the flow is tagged', () => {
    const doc = Document.Open(buildBlankPage());
    const flow = doc.NewFlow(opts({ format: PageFormat.custom(300, 500), tagged: true }));
    flow.AddImage(buildPngRgb(), { alt: 'a red-green dot' });
    flow.Render();
    const sect = doc.CreateStructTree().Children.find((c) => c.Type === 'Sect')!;
    const figs = sect.Children.filter((c) => c.Type === 'Figure');
    expect(figs.length).toBe(1);
    expect(figs[0].Alt).toBe('a red-green dot');
  });

  it('untagged flow (default) creates no structure for an image', () => {
    const doc = Document.Open(buildBlankPage());
    const flow = doc.NewFlow(opts({ format: PageFormat.custom(300, 500) }));
    flow.AddImage(buildPngRgb());
    flow.Render();
    expect(Document.Open(doc.Save()).GetStructTree()).toBeNull();
  });

  it('a heading keeps with a following image, treated atomically', () => {
    // 200x200, colH 160 = 8 slots of 20pt. Image {width:40} is 20 tall (one slot).
    const push = Document.Open(buildBlankPage());
    const flowP = new Flow(push, opts());
    flowP.AddParagraph(Array.from({ length: 7 }, (_, i) => `F${i}`).join('\n'), L); // one slot left
    flowP.AddHeading(2, 'HEADING', L);        // fills it; no room for the image
    flowP.AddImage(buildPngRgb(), { width: 40 });
    expect(flowP.Render()[0].GetText().includes('HEADING')).toBe(false); // pushed with the image

    const stay = Document.Open(buildBlankPage());
    const flowS = new Flow(stay, opts());
    flowS.AddParagraph(Array.from({ length: 6 }, (_, i) => `F${i}`).join('\n'), L); // two slots left
    flowS.AddHeading(2, 'HEADING', L);
    flowS.AddImage(buildPngRgb(), { width: 40 });
    expect(flowS.Render()[0].GetText()).toContain('HEADING'); // heading + image both fit
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/flow.test.ts -t "flow images (AddImage)"`
Expected: FAIL — `flow.AddImage` is not a function.

- [ ] **Step 3: Implement — `Flow.AddImage`**

Add to `class Flow`, right after `AddList`:

```ts
  /** Append a raster image (JPEG/PNG) as its own flow block. Sized to the column
   *  by default (aspect height); an over-column width is clamped. Atomic — it
   *  never splits across a column. Chainable. */
  AddImage(data: Uint8Array, options: FlowImageOptions = {}): this {
    this.items.push(buildImageElement(data, options));
    return this;
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/flow.test.ts -t "flow images (AddImage)"`
Expected: PASS (7 tests).

- [ ] **Step 5: Prove the assertions are load-bearing**

Temporarily change `resolveSize`'s clamp branch guard `if (baseW > regionWidth)` to `if (false)` (never clamp) and rerun.
Run: `npx vitest run test/flow.test.ts -t "flow image"`
Expected: the "clamps an over-region width" (Task 1) test FAILS. Revert.

Then temporarily change `place`'s fit guard `drawH > ctx.availHeight + 1e-9` to `drawH > ctx.availHeight + 1e9` (never overflow) and rerun.
Run: `npx vitest run test/flow.test.ts -t "flow images (AddImage)"`
Expected: the "paginates atomically" and "throws when … taller than an empty column" tests FAIL. Revert and confirm green.

- [ ] **Step 6: Full suite + typecheck**

Run: `npm run typecheck && npm test`
Expected: typecheck clean; entire vitest suite green (no engine change; existing flow/floatbox tests unaffected).

- [ ] **Step 7: Update the README**

In `README.md`, in the Flow section:

1. After the `AddList(...)` description sentence, add a sentence documenting `AddImage`:

```markdown
`AddImage(data, options)` places a JPEG/PNG image as its own flow block: `width`
defaults to the column width (clamped down if larger, aspect preserved), `height`
auto-derives from the aspect ratio, `align` is `'left'` (default)/`'center'`/
`'right'`, and `alt` tags the image as `/Figure` when the flow is tagged. An image
paginates atomically (it never splits; one taller than a full column throws).
```

2. In the closing follow-up sentence, remove "main-column flow images":

```markdown
Nested lists and simultaneous/stacked floats are tracked as follow-up work.
```

- [ ] **Step 8: Commit**

```bash
git add src/flow.ts README.md test/flow.test.ts
git commit -m "feat(flow): Flow.AddImage inline images (db7v.5)"
```

---

## Self-Review

**Spec coverage:**
- Reuse `buildImageXObject`/`drawBuiltImage`, `/Figure`+`/Alt` tagging → Task 1 Steps 3, 6 + Task 2 tagging test. ✓
- `ImageElement implements FlowElement`, atomic, no engine change → Task 1 Step 6. ✓
- Lazy `resolveSize(regionWidth)` shared by `place`/`measure`; default fills region; clamp preserves aspect → Task 1 Step 6 + sizing/clamp tests. ✓
- Alignment left/center/right within the region (default left) → Task 1 Step 6 + alignment test. ✓
- `measure` atomic (usedHeight 0 unless whole image fits) → keep-with-next successor → Task 1 Step 6 + Task 2 keep-with-next test. ✓
- `place` overflow contract (drew:false/remainder:self; empty-column throw) → Task 1 overflow test + Task 2 too-tall throw. ✓
- `spaceBefore`/`spaceAfter` via `normalizeSpacing` (broadened) → Task 1 Step 4 + Task 2 spacing test. ✓
- API `FlowImageOptions` + `Flow.AddImage` + index export → Task 1 Steps 5, 8; Task 2 Step 3. ✓
- Validation (`TypeError` per field; `UnsupportedFeatureError` for non-image) → Task 1 Step 7 + validation test. ✓
- README (document AddImage; drop follow-up line) → Task 2 Step 7. ✓

**Placeholder scan:** none — every step has concrete code/commands.

**Type consistency:** `FlowImageOptions` fields match across the interface (Task 1 Step 5), `buildImageElement`/`ImageElement` ctor (Steps 6-7), and `Flow.AddImage` (Task 2 Step 3). `resolveSize(regionWidth) → { drawW, drawH }` is called identically in `place` and `measure`. `makeImage`/`buildImageElement`/`Flow.AddImage` all return via the same `ImageElement`. `MeasureContext`/`PlaceContext`/`PlaceResult` are the existing engine types (unchanged).

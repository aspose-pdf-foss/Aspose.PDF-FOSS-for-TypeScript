# Flow Floating Boxes (wrap-around) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `doc.NewFloatingBox(options)` (a padded/bordered/filled box of paragraphs and/or an image) that `flow.AddFloatBox(box, side)` floats left or right of a column, with surrounding flow text wrapping in the narrowed channel beside it and resuming full width below.

**Architecture:** A new `src/floatbox.ts` module owns the `FloatingBox` builder — it measures its own content (via `layoutText`, mirroring `tableauthor`) and paints its chrome (`PageGraphics`) + inner content (`stampTextBlock` / `drawBuiltImage`). `flow.ts` gains a `{ kind: 'float' }` queue item and one per-column `activeFloat` state variable; the existing `place`/remainder mechanism handles the "beside then below" reflow with no change to `FlowElement.place`. Box images can be tagged as `/Figure` via a small `tag?` addition to `drawBuiltImage`.

**Tech Stack:** TypeScript (ESM + NodeNext, `.js` import specifiers), vitest. Zero runtime deps.

## Global Constraints

- Zero runtime dependencies — only `node:` built-ins. Do not add npm runtime deps.
- ESM + NodeNext, `strict` TypeScript; every import specifier carries the `.js` extension.
- Public errors are `TypeError` for bad arguments; `Error` for layout-impossible conditions (matches `flow.ts`).
- `spacing` is used for BOTH the internal gap between consecutive box elements AND the external band (`band = width + spacing`) the wrapped text keeps from the box, AND the vertical gap above/below the box. One knob, three uses — make this explicit in the JSDoc.
- `width` is the box's OUTER (border-box) width; `contentWidth = width − padLeft − padRight − 2·borderWidth`.
- Box paragraph defaults match flow paragraphs: font Helvetica, `fontSize` 12, `leading` `1.2·fontSize`.
- Follow existing patterns: `PageGraphics` for vector chrome, `stampTextBlock`/`drawBuiltImage` for content, test-only factories exported from the module and imported by the test.
- Run `npm run typecheck` and `npm test` — both green — before closing the issue. Keep `README.md` Flow section in sync.

---

### Task 1: `drawBuiltImage` gains an optional `/Figure` tag

`drawBuiltImage` currently takes only `{ opacity? }`. Add `tag?: StructElement` so a box image can be wrapped in marked content and attached to a `/Figure`, mirroring what `addImage` already does.

**Files:**
- Modify: `src/imageembed.ts` (`drawBuiltImage` signature + body)
- Test: `test/image.test.ts` (new `it` in an existing describe, or a new one)

**Interfaces:**
- Consumes: existing `wrapMarkedContent`, `allocContentMcid`, `appendContent`, `StructElement`.
- Produces: `drawBuiltImage(doc, page, built, rect, opts?: { opacity?: number; tag?: StructElement })` — when `opts.tag` is set, the image draw is wrapped `/<tag.Type> <</MCID n>> BDC … EMC`.

- [ ] **Step 1: Write the failing test**

Add to `test/image.test.ts` (import `drawBuiltImage`, `buildImageXObject` from `../src/imageembed.js`, `buildPngRgb` from `./helpers/build-embed-images.js`, `Document` from `../src/index.js`, `buildBlankPage` from `./helpers/build-blank-page.js`, and `CreateStructTree` via the doc):

```ts
it('drawBuiltImage wraps the draw in marked content when tagged', () => {
  const doc = Document.Open(buildBlankPage());
  const page = doc.Pages[0];
  const fig = doc.CreateStructTree().Append('Figure', { alt: 'a red dot' });
  const built = buildImageXObject(buildPngRgb());
  drawBuiltImage(doc, page, built, [10, 10, 20, 20], { tag: fig });
  const content = new TextDecoder('latin1').decode(page.Contents);
  expect(content).toContain('BDC');
  expect(content).toContain('EMC');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/image.test.ts -t "drawBuiltImage wraps the draw"`
Expected: FAIL — no `BDC` (tag ignored / not accepted).

- [ ] **Step 3: Implement the tag support**

In `src/imageembed.ts`, change `drawBuiltImage`'s `opts` type and tag the body. Replace:

```ts
export function drawBuiltImage(
  doc: Document, page: Page, built: BuiltImage,
  rect: [number, number, number, number], opts: { opacity?: number } = {},
): void {
```

with:

```ts
export function drawBuiltImage(
  doc: Document, page: Page, built: BuiltImage,
  rect: [number, number, number, number],
  opts: { opacity?: number; tag?: StructElement } = {},
): void {
```

and replace the final append at the end of the function:

```ts
  s += `/${key} Do\nQ`;
  appendContent(doc, page, enc(s));
```

with:

```ts
  s += `/${key} Do\nQ`;
  const body = enc(s);
  const tagged = opts.tag
    ? wrapMarkedContent(opts.tag.Type, allocContentMcid(doc, opts.tag, page), body)
    : body;
  appendContent(doc, page, tagged);
```

(`StructElement`, `wrapMarkedContent`, `allocContentMcid` are already imported in this file — used by `addImage`. Verify the imports at the top include them; if `StructElement` is not imported, add `import type { StructElement } from './struct.js';`.)

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/image.test.ts -t "drawBuiltImage wraps the draw"`
Expected: PASS.

- [ ] **Step 5: Run the image test file (no regressions)**

Run: `npx vitest run test/image.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/imageembed.ts test/image.test.ts
git commit -m "feat(image): optional /Figure tag on drawBuiltImage (db7v.4)"
```

---

### Task 2: `FloatingBox` model — construction, content, validation, measure

Create `src/floatbox.ts` with the `FloatingBox` builder: options validation, `AddParagraph`/`AddImage`, and a pure `measure()` (with a shared private `layoutItems()` that both `measure` and `paintAt` use). No painting yet.

**Files:**
- Create: `src/floatbox.ts`
- Test: `test/floatbox.test.ts`

**Interfaces:**
- Consumes: `Document`, `Page`, `layoutText`, `winAnsiDriver`, `FontDriver` (from `./layout.js`), `EmbeddedFont` (from `./embeddedfont.js`), `buildImageXObject`, `BuiltImage` (from `./imageembed.js`), `AuthoringFont` (from `./stamp.js`), `FlowParagraphOptions` (type, from `./flow.js`).
- Produces:
  - `export interface FloatBoxOptions { width: number; padding?: number | { top: number; right: number; bottom: number; left: number }; border?: { width: number; color: [number,number,number] }; background?: [number,number,number]; spacing?: number; alt?: string; }`
  - `export interface FloatBoxImageOptions { width?: number; height?: number; format?: 'jpeg' | 'png'; }`
  - `export class FloatingBox` with:
    - `constructor(doc: Document, options: FloatBoxOptions)`
    - `readonly width: number`, `readonly spacing: number`
    - `AddParagraph(text: string, options?: FlowParagraphOptions): this`
    - `AddImage(data: Uint8Array, options?: FloatBoxImageOptions): this`
    - `measure(): number`
    - `contentWidth(): number` (internal, used by tests/paint)
    - (private `layoutItems(): { heights: number[]; total: number }`)

- [ ] **Step 1: Write the failing tests**

Create `test/floatbox.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { FloatingBox } from '../src/floatbox.js';
import { Document } from '../src/index.js';
import { buildBlankPage } from './helpers/build-blank-page.js';
import { buildPngRgb } from './helpers/build-embed-images.js';

function newBox(opts: any) {
  const doc = Document.Open(buildBlankPage());
  return { doc, box: new FloatingBox(doc, opts) };
}

describe('FloatingBox model', () => {
  it('validates its options', () => {
    const { doc } = newBox({ width: 100 });
    expect(() => new FloatingBox(doc, { width: 0 })).toThrow(TypeError);
    expect(() => new FloatingBox(doc, { width: -5 })).toThrow(TypeError);
    expect(() => new FloatingBox(doc, { width: 100, spacing: -1 })).toThrow(TypeError);
    expect(() => new FloatingBox(doc, { width: 100, padding: -2 })).toThrow(TypeError);
    expect(() => new FloatingBox(doc, { width: 100, border: { width: -1, color: [0,0,0] } })).toThrow(TypeError);
    expect(() => new FloatingBox(doc, { width: 100, background: [2,0,0] as any })).toThrow(TypeError);
  });

  it('contentWidth subtracts padding and border from the outer width', () => {
    const { box } = newBox({ width: 100, padding: 6, border: { width: 2, color: [0,0,0] } });
    expect(box.contentWidth()).toBeCloseTo(100 - 12 - 4, 6); // 84
  });

  it('measures a one-line paragraph as leading + padding + border', () => {
    const { box } = newBox({ width: 100, padding: 5, border: { width: 1, color: [0,0,0] } });
    box.AddParagraph('short', { fontSize: 10, leading: 12 });
    // one line (12) + padTop+padBottom (10) + 2*border (2) = 24
    expect(box.measure()).toBeCloseTo(24, 6);
  });

  it('measures an image at its aspect ratio and adds inter-element spacing', () => {
    const { box } = newBox({ width: 100, spacing: 4 }); // no padding/border
    box.AddImage(buildPngRgb());                 // 2x1 → height = contentWidth/2
    box.AddParagraph('cap', { fontSize: 10, leading: 12 });
    // contentWidth = 100; image height = 100/2 = 50; + spacing 4 + line 12 = 66
    expect(box.measure()).toBeCloseTo(50 + 4 + 12, 6);
  });

  it('AddParagraph / AddImage are chainable', () => {
    const { box } = newBox({ width: 100 });
    expect(box.AddParagraph('a')).toBe(box);
    expect(box.AddImage(buildPngRgb())).toBe(box);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/floatbox.test.ts`
Expected: FAIL — cannot import `FloatingBox`.

- [ ] **Step 3: Create `src/floatbox.ts`**

```ts
import type { Document } from './document.js';
import type { Page } from './page.js';
import { layoutText, winAnsiDriver, type FontDriver } from './layout.js';
import { EmbeddedFont } from './embeddedfont.js';
import { buildImageXObject, type BuiltImage } from './imageembed.js';
import type { AuthoringFont } from './stamp.js';
import type { FlowParagraphOptions } from './flow.js';

/** Options for {@link Document.NewFloatingBox}. All lengths are in points. */
export interface FloatBoxOptions {
  /** Outer (border-box) width in points. Required, > 0. */
  width: number;
  /** Inside padding between border and content. Default 0. */
  padding?: number | { top: number; right: number; bottom: number; left: number };
  /** Border stroke. Default none. */
  border?: { width: number; color: [number, number, number] };
  /** Background fill color (rgb 0..1). Default none. */
  background?: [number, number, number];
  /** Gap between consecutive box elements, the horizontal band the wrapped text
   *  keeps from the box (`band = width + spacing`), and the vertical gap above/
   *  below the box. One knob, three uses. Default 0. */
  spacing?: number;
  /** Alt text for the box's `/Figure` when the flow is tagged. */
  alt?: string;
}

/** Options for {@link FloatingBox.AddImage}. */
export interface FloatBoxImageOptions {
  /** Drawn width, points. Default: the box content width. */
  width?: number;
  /** Drawn height, points. Omitted/0 → auto from aspect ratio at the drawn width. */
  height?: number;
  format?: 'jpeg' | 'png';
}

type Padding = { top: number; right: number; bottom: number; left: number };

interface ParaItem { kind: 'paragraph'; text: string; opts: FlowParagraphOptions; }
interface ImageItem { kind: 'image'; built: BuiltImage; drawW: number; drawH: number; }
type BoxItem = ParaItem | ImageItem;

function checkNonNeg(v: number, name: string): number {
  if (!Number.isFinite(v) || v < 0) throw new TypeError(`${name} must be a non-negative finite number`);
  return v;
}
function checkColor(c: [number, number, number], name: string): [number, number, number] {
  if (!Array.isArray(c) || c.length !== 3 || !c.every((n) => Number.isFinite(n) && n >= 0 && n <= 1))
    throw new TypeError(`${name} must be [r, g, b] with each component in 0..1`);
  return c;
}

/** A measuring {@link FontDriver}: wraps/measures like the font but emits no
 *  glyphs (measurement ignores `encode`), matching tableauthor.ts. */
function measuringDriver(font: AuthoringFont): FontDriver {
  const real: FontDriver = font instanceof EmbeddedFont ? font.driver() : winAnsiDriver(font);
  return { measure: (t, fs) => real.measure(t, fs), probe: (t) => real.probe(t), encode: () => new Uint8Array(0) };
}

/** A padded/bordered/filled box of paragraphs and/or an image, floated into a
 *  {@link Flow} column by `flow.AddFloatBox`. Create via `doc.NewFloatingBox`. */
export class FloatingBox {
  readonly width: number;
  readonly spacing: number;
  /** @internal */ readonly padding: Padding;
  /** @internal */ readonly borderWidth: number;
  /** @internal */ readonly border?: { width: number; color: [number, number, number] };
  /** @internal */ readonly background?: [number, number, number];
  /** @internal */ readonly alt?: string;
  private readonly items: BoxItem[] = [];

  constructor(private readonly doc: Document, options: FloatBoxOptions) {
    if (!Number.isFinite(options.width) || options.width <= 0)
      throw new TypeError('width must be a positive finite number');
    this.width = options.width;
    this.spacing = checkNonNeg(options.spacing ?? 0, 'spacing');
    const p = options.padding ?? 0;
    this.padding = typeof p === 'number'
      ? { top: checkNonNeg(p, 'padding'), right: checkNonNeg(p, 'padding'), bottom: checkNonNeg(p, 'padding'), left: checkNonNeg(p, 'padding') }
      : { top: checkNonNeg(p.top, 'padding.top'), right: checkNonNeg(p.right, 'padding.right'), bottom: checkNonNeg(p.bottom, 'padding.bottom'), left: checkNonNeg(p.left, 'padding.left') };
    if (options.border) {
      this.border = { width: checkNonNeg(options.border.width, 'border.width'), color: checkColor(options.border.color, 'border.color') };
    }
    this.borderWidth = this.border?.width ?? 0;
    if (options.background) this.background = checkColor(options.background, 'background');
    this.alt = options.alt;
    if (this.contentWidth() <= 0)
      throw new TypeError('floating box contentWidth must be positive (reduce padding/border or raise width)');
  }

  /** Content width: outer width minus horizontal padding and both borders. */
  contentWidth(): number {
    return this.width - this.padding.left - this.padding.right - 2 * this.borderWidth;
  }

  /** Append a word-wrapped paragraph inside the box. Chainable. */
  AddParagraph(text: string, options: FlowParagraphOptions = {}): this {
    this.items.push({ kind: 'paragraph', text, opts: options });
    return this;
  }

  /** Append an image inside the box. `height` omitted/0 → auto from aspect at the
   *  drawn width (default the box content width). Chainable. */
  AddImage(data: Uint8Array, options: FloatBoxImageOptions = {}): this {
    const built = buildImageXObject(data, options.format);
    const w = built.stream.dict.get('Width') as number;
    const h = built.stream.dict.get('Height') as number;
    const drawW = options.width ?? this.contentWidth();
    if (!Number.isFinite(drawW) || drawW <= 0) throw new TypeError('image width must be positive');
    const drawH = options.height && options.height > 0 ? options.height : drawW * (h / w);
    this.items.push({ kind: 'image', built, drawW, drawH });
    return this;
  }

  /** Per-item heights and their total (content only, no padding/border). @internal */
  layoutItems(): { heights: number[]; total: number } {
    const cw = this.contentWidth();
    const heights = this.items.map((it) => {
      if (it.kind === 'image') return it.drawH;
      const fontSize = it.opts.fontSize ?? 12;
      const leading = it.opts.leading ?? 1.2 * fontSize;
      const font = it.opts.font ?? 'Helvetica';
      const res = layoutText(it.text, measuringDriver(font), fontSize, cw, Infinity, leading);
      return Math.max(1, res.lines.length) * leading;
    });
    let total = heights.reduce((a, b) => a + b, 0);
    if (this.items.length > 1) total += (this.items.length - 1) * this.spacing;
    return { heights, total };
  }

  /** Total box height: content + inter-element spacing + padding + borders. */
  measure(): number {
    return this.layoutItems().total + this.padding.top + this.padding.bottom + 2 * this.borderWidth;
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/floatbox.test.ts`
Expected: PASS (all 5).

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: no errors. (`FlowParagraphOptions` is imported type-only from `./flow.js`; `flow.ts` will import `FloatingBox` type-only in Task 4 — no runtime cycle.)

- [ ] **Step 6: Commit**

```bash
git add src/floatbox.ts test/floatbox.test.ts
git commit -m "feat(flow): FloatingBox model + measure (db7v.4)"
```

---

### Task 3: `FloatingBox.paintAt` — chrome + inner content (untagged)

Add painting: background fill, border stroke, and inner elements top-down inside the padding box. Tagging is added in Task 5 via an optional `structParent` parameter (declared now, unused until then).

**Files:**
- Modify: `src/floatbox.ts` (add `paintAt`, imports)
- Test: `test/floatbox.test.ts` (new `describe('FloatingBox.paintAt')`)

**Interfaces:**
- Consumes: `PageGraphics` (from `./graphics.js`), `stampTextBlock` (from `./stamp.js`), `drawBuiltImage` (from `./imageembed.js`), `StructElement` (type, from `./struct.js`), `TextBlockOptions` (type, from `./stamp.js`).
- Produces: `paintAt(page: Page, x: number, topY: number, structParent?: StructElement): number` — paints the box with its top-left at `(x, topY)`, returns the height consumed (`= measure()`).

- [ ] **Step 1: Write the failing tests**

Add to `test/floatbox.test.ts`:

```ts
describe('FloatingBox.paintAt', () => {
  it('paints background fill and border stroke around the box', () => {
    const doc = Document.Open(buildBlankPage());
    const page = doc.Pages[0];
    const box = new FloatingBox(doc, { width: 80, padding: 4,
      background: [0.9, 0.9, 1], border: { width: 1, color: [0, 0, 0] } });
    box.AddParagraph('hello', { fontSize: 10, leading: 12 });
    const h = box.paintAt(page, 50, 700);
    expect(h).toBeCloseTo(box.measure(), 6);
    const content = new TextDecoder('latin1').decode(page.Contents);
    expect(content).toContain(' rg');   // fill color set (background)
    expect(content).toContain(' re');   // rectangle path
    expect(content).toContain(' f');    // fill
    expect(content).toContain(' RG');   // stroke color set (border)
    expect(content).toContain(' S');    // stroke
    expect(content).toContain('(hello)'); // inner paragraph text
  });

  it('draws an inner image inside the padding box', () => {
    const doc = Document.Open(buildBlankPage());
    const page = doc.Pages[0];
    const box = new FloatingBox(doc, { width: 60, padding: 5 });
    box.AddImage(buildPngRgb()); // 2x1 → 50x25 at contentWidth 50
    box.paintAt(page, 100, 700);
    const content = new TextDecoder('latin1').decode(page.Contents);
    expect(content).toContain(' Do');  // XObject draw
    expect(content).toContain(' cm');  // image placement matrix
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/floatbox.test.ts -t "paintAt"`
Expected: FAIL — `box.paintAt is not a function`.

- [ ] **Step 3: Implement `paintAt`**

Add these imports to the top of `src/floatbox.ts`:

```ts
import { PageGraphics } from './graphics.js';
import { stampTextBlock, type TextBlockOptions } from './stamp.js';
import { drawBuiltImage } from './imageembed.js';
import type { StructElement } from './struct.js';
```

(Extend the existing `buildImageXObject` import to also bring `drawBuiltImage`, or add a new import line — either is fine.)

Add the method to `class FloatingBox` (after `measure`):

```ts
  /** Paint the box with its top-left corner at `(x, topY)` (PDF user space, y up).
   *  When `structParent` is given (tagged flow), each image is appended as a
   *  `/Figure` (with `/Alt`) and each paragraph as a `/P`, in order. Returns the
   *  height consumed. */
  paintAt(page: Page, x: number, topY: number, structParent?: StructElement): number {
    const { heights, total } = this.layoutItems();
    const h = total + this.padding.top + this.padding.bottom + 2 * this.borderWidth;
    const bw = this.borderWidth;

    // Chrome: background fill, then border stroke (inset by bw/2 so the stroke
    // stays within the outer box).
    const g = new PageGraphics(this.doc, page);
    if (this.background) g.setFillColor(this.background).rect(x, topY - h, this.width, h).fill();
    if (this.border && bw > 0)
      g.setLineWidth(bw).setStrokeColor(this.border.color)
        .rect(x + bw / 2, topY - h + bw / 2, this.width - bw, h - bw).stroke();
    g.apply();

    // Inner content, top-down inside the padding box.
    const cx = x + this.padding.left + bw;
    const cw = this.contentWidth();
    let top = topY - this.padding.top - bw;
    this.items.forEach((it, i) => {
      if (i > 0) top -= this.spacing;
      const eh = heights[i];
      if (it.kind === 'image') {
        const fig = structParent
          ? structParent.Append('Figure', this.alt !== undefined ? { alt: this.alt } : undefined)
          : undefined;
        drawBuiltImage(this.doc, page, it.built, [cx, top - it.drawH, it.drawW, it.drawH],
          fig ? { tag: fig } : {});
      } else {
        const tag = structParent ? structParent.Append('P') : undefined;
        const opts: TextBlockOptions = {
          font: it.opts.font, fontSize: it.opts.fontSize, color: it.opts.color,
          align: it.opts.align, leading: it.opts.leading, ...(tag ? { tag } : {}),
        };
        stampTextBlock(this.doc, page, it.text, [cx, top - eh, cw, eh], opts);
      }
      top -= eh;
    });
    return h;
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/floatbox.test.ts -t "paintAt"`
Expected: PASS (both).

- [ ] **Step 5: Run the whole floatbox file + typecheck**

Run: `npx vitest run test/floatbox.test.ts && npm run typecheck`
Expected: PASS, no type errors.

- [ ] **Step 6: Commit**

```bash
git add src/floatbox.ts test/floatbox.test.ts
git commit -m "feat(flow): FloatingBox.paintAt chrome + content (db7v.4)"
```

---

### Task 4: `doc.NewFloatingBox` + `flow.AddFloatBox` + wrap-around in `Render` (untagged)

Wire the box into the document facade and the flow: a `{ kind: 'float' }` queue item, one `activeFloat` state variable, and the narrowed-region placement that produces the "beside then below" wrap.

**Files:**
- Modify: `src/document.ts` (add `NewFloatingBox`)
- Modify: `src/flow.ts` (imports, `FloatItem`, `AddFloatBox`, `Render` changes)
- Test: `test/flow.test.ts` (new `describe('flow floating boxes')`)

**Interfaces:**
- Consumes: `FloatingBox` (type + runtime for `NewFloatingBox`), `columnX`, the existing `Render` loop.
- Produces:
  - `Document.NewFloatingBox(options: FloatBoxOptions): FloatingBox`
  - `Flow.AddFloatBox(box: FloatingBox, side: 'left' | 'right'): this`

- [ ] **Step 1: Write the failing tests**

Add to `test/flow.test.ts` (import `FloatingBox` is not needed — create via `doc.NewFloatingBox`; `buildPngRgb` import from `./helpers/build-embed-images.js` at top of file):

```ts
describe('flow floating boxes', () => {
  const opts = () => ({
    format: PageFormat.custom(300, 500), columns: 1,
    marginLeft: 20, marginRight: 20, marginTop: 20, marginBottom: 20,
  });

  it('left float: text wraps beside it, then resumes full width below', () => {
    const doc = Document.Open(buildBlankPage());
    const flow = doc.NewFlow(opts());
    const box = doc.NewFloatingBox({ width: 100, spacing: 6 });
    box.AddParagraph('BOX', { fontSize: 10, leading: 12 });
    box.AddParagraph('BOX2', { fontSize: 10, leading: 12 });
    box.AddParagraph('BOX3', { fontSize: 10, leading: 12 }); // make the box tall
    flow.AddFloatBox(box, 'left');
    // Lots of wrapping text: early lines beside the box, later lines below it.
    const body = Array.from({ length: 40 }, (_, i) => `word${i}`).join(' ');
    flow.AddParagraph(body, { fontSize: 10, leading: 12 });
    const [page] = flow.Render();
    const frags = page.GetTextFragments();
    // band = width(100) + spacing(6) = 106; columnX = 20 → beside-text starts at 126.
    const first = frags.find((f) => f.text.includes('word0'))!;
    const last = frags.find((f) => f.text.includes('word39'))!;
    expect(first.quad[0]).toBeGreaterThan(120);   // beside the left float
    expect(last.quad[0]).toBeLessThan(60);        // resumed full width (near columnX 20)
  });

  it('right float: box on the right, beside-text stays left', () => {
    const doc = Document.Open(buildBlankPage());
    const flow = doc.NewFlow(opts());
    const box = doc.NewFloatingBox({ width: 100, spacing: 6 });
    box.AddParagraph('R', { fontSize: 10, leading: 12 });
    flow.AddFloatBox(box, 'right');
    flow.AddParagraph('sidetext', { fontSize: 10, leading: 12 });
    const [page] = flow.Render();
    const t = page.GetTextFragments().find((f) => f.text.includes('sidetext'))!;
    expect(t.quad[0]).toBeCloseTo(20, 0); // stays at the left margin
    // Box content 'R' sits on the right: columnX + colWidth - width = 20+260-100 = 180.
    const r = page.GetTextFragments().find((f) => f.text === 'R' || f.text.includes('R'))!;
    expect(r.quad[0]).toBeGreaterThan(150);
  });

  it('a box taller than a full column throws', () => {
    const doc = Document.Open(buildBlankPage());
    const flow = doc.NewFlow({ format: PageFormat.custom(200, 120), columns: 1,
      marginLeft: 20, marginRight: 20, marginTop: 20, marginBottom: 20 });
    const box = doc.NewFloatingBox({ width: 100 });
    for (let i = 0; i < 20; i++) box.AddParagraph(`L${i}`, { fontSize: 10, leading: 12 });
    flow.AddFloatBox(box, 'left');
    expect(() => flow.Render()).toThrow(/does not fit in an empty column/i);
  });

  it('is chainable', () => {
    const doc = Document.Open(buildBlankPage());
    const flow = doc.NewFlow(opts());
    const box = doc.NewFloatingBox({ width: 50 });
    box.AddParagraph('x');
    expect(flow.AddFloatBox(box, 'left')).toBe(flow);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/flow.test.ts -t "floating boxes"`
Expected: FAIL — `doc.NewFloatingBox` / `flow.AddFloatBox` not functions.

- [ ] **Step 3: Add `Document.NewFloatingBox`**

In `src/document.ts`, add the import near the existing Flow import (line ~59):

```ts
import { FloatingBox, type FloatBoxOptions } from './floatbox.js';
```

And add the method right after `NewFlow` (line ~1595):

```ts
  /** Create a {@link FloatingBox} bound to this document. Add content with
   *  `AddParagraph`/`AddImage`, then float it into a flow with
   *  `flow.AddFloatBox(box, side)`. */
  NewFloatingBox(options: FloatBoxOptions): FloatingBox {
    return new FloatingBox(this, options);
  }
```

- [ ] **Step 4: Add the `FloatItem` + `AddFloatBox` to `flow.ts`**

In `src/flow.ts`, add a type-only import for `FloatingBox`:

```ts
import type { FloatingBox } from './floatbox.js';
```

Add the float sentinel next to `ColumnBreak` (near `src/flow.ts` `interface ColumnBreak`):

```ts
/** A floating box enqueued by {@link Flow.AddFloatBox}. @internal */
interface FloatItem { readonly kind: 'float'; readonly box: FloatingBox; readonly side: 'left' | 'right'; }
```

Update the `FlowItem` union and the guards:

```ts
type FlowItem = FlowElement | ColumnBreak | FloatItem;
function isBreak(item: FlowItem): item is ColumnBreak {
  return (item as ColumnBreak).kind === 'column-break';
}
function isFloat(item: FlowItem): item is FloatItem {
  return (item as FloatItem).kind === 'float';
}
```

Add the `AddFloatBox` method to `class Flow` (after `AddColumnBreak`):

```ts
  /** Float `box` to the `left` or `right` of the column; following flow text
   *  wraps in the narrowed channel beside it and resumes full width below.
   *  Chainable. */
  AddFloatBox(box: FloatingBox, side: 'left' | 'right'): this {
    if (side !== 'left' && side !== 'right') throw new TypeError("side must be 'left' or 'right'");
    this.items.push({ kind: 'float', box, side });
    return this;
  }
```

- [ ] **Step 5: Rewrite the `Render` loop body for float awareness**

In `src/flow.ts`, `Render()`, add the `activeFloat` state next to the other per-column vars (`let pendingSpaceAfter = 0;`):

```ts
    let activeFloat: { side: 'left' | 'right'; band: number; bottom: number } | undefined;
```

Add float-clearing to `advanceColumn`:

```ts
    const advanceColumn = () => {
      col++;
      if (col >= g.columns) { col = 0; pageIdx++; }
      colTop = g.contentTop;
      atColumnStart = true;
      pendingSpaceAfter = 0;
      activeFloat = undefined;
    };
```

Replace the entire `while (queue.length > 0) { … }` body with:

```ts
    while (queue.length > 0) {
      const item = queue[0];
      if (isBreak(item)) { queue.shift(); advanceColumn(); continue; }

      // Clear a float once the pen has passed its bottom.
      if (activeFloat && colTop <= activeFloat.bottom + 1e-9) activeFloat = undefined;

      if (isFloat(item)) {
        const box = item.box;
        const h = box.measure();
        const gap = atColumnStart ? 0 : pendingSpaceAfter + g.paragraphSpacing + box.spacing;
        const boxTop = colTop - gap;
        if (boxTop - h < g.contentBottom - 1e-9) {
          if (atColumnStart)
            throw new Error('Flow: floating box does not fit in an empty column (column too short for the box)');
          advanceColumn();
          continue;
        }
        const page = ensurePage(pageIdx);
        const boxX = item.side === 'left'
          ? columnX(g, col)
          : columnX(g, col) + g.columnWidth - box.width;
        box.paintAt(page, boxX, boxTop, structParent);
        activeFloat = { side: item.side, band: box.width + box.spacing, bottom: boxTop - h };
        colTop = boxTop;
        atColumnStart = false;
        pendingSpaceAfter = 0;
        queue.shift();
        continue;
      }

      // A normal flow element.
      const gap = atColumnStart ? 0
        : pendingSpaceAfter + g.paragraphSpacing + (item.spaceBefore ?? 0);
      const top = colTop - gap;

      // Region: narrowed beside an active float, capped at the float bottom so the
      // element re-flows below the box at full width.
      const besideFloat = activeFloat !== undefined && top > activeFloat.bottom + 1e-9;
      let elemX = columnX(g, col);
      let elemWidth = g.columnWidth;
      let availHeight = top - g.contentBottom;
      if (besideFloat) {
        if (activeFloat!.side === 'left') elemX = columnX(g, col) + activeFloat!.band;
        elemWidth = g.columnWidth - activeFloat!.band;
        availHeight = top - activeFloat!.bottom;
      }

      const page = ensurePage(pageIdx);
      const res = item.place({
        doc: this.doc, page, x: elemX, top, width: elemWidth, availHeight, structParent,
      });

      if (res.drew) {
        queue.shift();
        colTop = top - res.usedHeight;
        atColumnStart = false;
        if (res.remainder) {
          queue.unshift(res.remainder);
          if (besideFloat) {
            // Reflowed at the float bottom: continue full width below the box.
            colTop = activeFloat!.bottom;
            activeFloat = undefined;
          } else {
            advanceColumn();
          }
        } else {
          pendingSpaceAfter = item.spaceAfter ?? 0;
        }
        continue;
      }
      // Nothing painted.
      if (res.remainder === null) { queue.shift(); continue; } // empty element
      if (besideFloat) {
        // Could not fit even one line beside the float: skip past it, retry full width.
        colTop = activeFloat!.bottom;
        activeFloat = undefined;
        continue;
      }
      if (atColumnStart)
        throw new Error('Flow: element does not fit in an empty column (column too short for its content)');
      advanceColumn();
    }
```

- [ ] **Step 6: Run the floating-box tests**

Run: `npx vitest run test/flow.test.ts -t "floating boxes"`
Expected: PASS (all 4).

- [ ] **Step 7: Run the full flow file + typecheck**

Run: `npx vitest run test/flow.test.ts && npm run typecheck`
Expected: PASS, no type errors (existing flow tests unaffected — no float means `activeFloat` stays `undefined` and the region math reduces to the original full-width placement).

- [ ] **Step 8: Commit**

```bash
git add src/document.ts src/flow.ts test/flow.test.ts
git commit -m "feat(flow): AddFloatBox + wrap-around Render integration (db7v.4)"
```

---

### Task 5: Tagged logical structure for floats

`paintAt` already appends `/Figure`+`/P` when given a `structParent`, and `Render` already passes `structParent` (the flow's `Sect`) to `box.paintAt`. This task verifies the tagged output end-to-end and proves the assertion is load-bearing.

**Files:**
- Test: `test/flow.test.ts` (new `describe('flow floating box tagging')`)
- Modify (only if a test surfaces a bug): `src/floatbox.ts` / `src/flow.ts`

**Interfaces:**
- Consumes: `doc.CreateStructTree()`, `StructElement.Children`/`.Type`/`.Alt`, tagged `Flow`.
- Produces: no new source interfaces (verification task).

- [ ] **Step 1: Write the verifying tests**

Add to `test/flow.test.ts`:

```ts
describe('flow floating box tagging', () => {
  const tagged = () => ({
    format: PageFormat.custom(300, 500), columns: 1,
    marginLeft: 20, marginRight: 20, marginTop: 20, marginBottom: 20, tagged: true,
  });

  it('emits /Figure (with /Alt) and /P for box content, before the wrapping text', () => {
    const doc = Document.Open(buildBlankPage());
    const flow = doc.NewFlow(tagged());
    const box = doc.NewFloatingBox({ width: 100, spacing: 4, alt: 'a red dot' });
    box.AddImage(buildPngRgb());
    box.AddParagraph('caption', { fontSize: 10, leading: 12 });
    flow.AddFloatBox(box, 'left');
    flow.AddParagraph('body text that wraps beside the floated figure box', { fontSize: 10, leading: 12 });
    flow.Render();

    const sect = doc.CreateStructTree().Children.find((c) => c.Type === 'Sect')!;
    const kinds = sect.Children.map((c) => c.Type);
    // Figure and the box caption come before the wrapping paragraph.
    expect(kinds.indexOf('Figure')).toBeGreaterThanOrEqual(0);
    expect(kinds.indexOf('Figure')).toBeLessThan(kinds.lastIndexOf('P'));
    const fig = sect.Children.find((c) => c.Type === 'Figure')!;
    expect(fig.Alt).toBe('a red dot');
    // Box caption /P + wrapping /P → at least two P nodes.
    expect(kinds.filter((k) => k === 'P').length).toBeGreaterThanOrEqual(2);
  });

  it('untagged flow (default) creates no structure for a float box', () => {
    const doc = Document.Open(buildBlankPage());
    const flow = doc.NewFlow({ format: PageFormat.custom(300, 500), columns: 1,
      marginLeft: 20, marginRight: 20, marginTop: 20, marginBottom: 20 });
    const box = doc.NewFloatingBox({ width: 100 });
    box.AddParagraph('x');
    flow.AddFloatBox(box, 'left');
    flow.AddParagraph('y');
    flow.Render();
    const re = Document.Open(doc.Save());
    expect(re.GetStructTree()).toBeNull();
  });
});
```

- [ ] **Step 2: Run the tagging tests**

Run: `npx vitest run test/flow.test.ts -t "floating box tagging"`
Expected: PASS (both). If the `/Figure`/`/Alt` assertions fail, debug `FloatingBox.paintAt`'s `structParent.Append('Figure', { alt })` path and confirm `Render` passes `structParent` (Task 4, Step 5).

- [ ] **Step 3: Prove the tagging assertion is load-bearing**

Temporarily break the figure tag in `src/floatbox.ts`: change `structParent.Append('Figure', …)` to `structParent.Append('Span', …)` and re-run:

Run: `npx vitest run test/flow.test.ts -t "floating box tagging"`
Expected: FAIL on the `/Figure` assertion.

Then **revert** (restore `'Figure'`) and re-run:

Run: `npx vitest run test/flow.test.ts -t "floating box tagging"`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add test/flow.test.ts
git commit -m "test(flow): verify floating box /Figure/Alt + /P tagging (db7v.4)"
```

---

### Task 6: Public exports, README, follow-up issues, quality gates

Export the new public types/class, document the API in the README, file the two follow-up issues, and run the full quality gates.

**Files:**
- Modify: `src/index.ts` (export `FloatingBox`, `FloatBoxOptions`, `FloatBoxImageOptions`)
- Modify: `README.md` (Flow layout section)

**Interfaces:**
- Consumes: the new public surface from `floatbox.ts`.
- Produces: `FloatingBox`, `FloatBoxOptions`, `FloatBoxImageOptions` in the package index.

- [ ] **Step 1: Write the failing export test**

Add to `test/flow.test.ts`, inside `describe('doc.NewFlow integration', …)`:

```ts
  it('exports FloatingBox and NewFloatingBox from the package', async () => {
    const mod = await import('../src/index.js');
    expect(typeof (mod as any).FloatingBox).toBe('function');
    const doc = Document.Open(buildBlankPage());
    expect(doc.NewFloatingBox({ width: 50 })).toBeInstanceOf((mod as any).FloatingBox);
  });
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run test/flow.test.ts -t "exports FloatingBox"`
Expected: FAIL — `FloatingBox` not exported from index.

- [ ] **Step 3: Add the exports to `src/index.ts`**

After the existing flow exports (the `export { Flow } …` / `export type { FlowOptions, … }` block, lines ~69-72), add:

```ts
export { FloatingBox } from './floatbox.js';
export type { FloatBoxOptions, FloatBoxImageOptions } from './floatbox.js';
```

- [ ] **Step 4: Run the export test**

Run: `npx vitest run test/flow.test.ts -t "exports FloatingBox"`
Expected: PASS.

- [ ] **Step 5: Update the README Flow section**

In `README.md`, in the Flow layout example (after the `AddList` lines added in db7v.3), add:

```ts
const sidebar = doc.NewFloatingBox({
  width: 120, spacing: 6, padding: 6,
  border: { width: 1, color: [0.2, 0.2, 0.6] }, background: [0.95, 0.95, 1],
});
sidebar.AddImage(pngBytes);                       // auto aspect at content width
sidebar.AddParagraph('Figure 1. Caption.', { fontSize: 9 });
flow.AddFloatBox(sidebar, 'left');                // text wraps to its right
```

And extend the Flow prose paragraph. Replace:

```
`/P` for paragraphs, `/L`/`/LI`/`/Lbl`/`/LBody` for lists) into the document
structure tree; the default is untagged.
```

with:

```
`/P` for paragraphs, `/L`/`/LI`/`/Lbl`/`/LBody` for lists, `/Figure`+`/P` for
float boxes) into the document structure tree; the default is untagged.
`doc.NewFloatingBox({ width, padding, border, background, spacing, alt })` builds a
box (`AddParagraph`/`AddImage`); `flow.AddFloatBox(box, 'left' | 'right')` floats
it so surrounding text wraps in the narrowed channel beside it and resumes full
width below. One float is active at a time.
```

Also update the trailing "follow-up work" sentence to drop floating boxes:

```
Nested lists, images, and floating boxes are tracked as follow-up work.
```

→

```
Nested lists, main-column flow images, and simultaneous/stacked floats are
tracked as follow-up work.
```

- [ ] **Step 6: Typecheck + full suite + build**

Run: `npm run typecheck && npm test && npm run build`
Expected: typecheck clean; all tests green; build succeeds. Confirm the export landed:
Run: `grep -c "FloatingBox" dist/src/index.d.ts` → expect ≥ 1.

- [ ] **Step 7: File the two follow-up issues**

```bash
bd create "Simultaneous left+right floats and per-side float stacking in flow" \
  -t feature -p 3 --parent aspose-pdf-foss-for-ts-db7v \
  -d "Extend floating boxes beyond one-at-a-time (option A): allow a left and a right float concurrently (text flows in the middle channel) and multiple stacked floats per side. Deferred from db7v.4."
bd create "CSS-style float clearing controls and cross-column float carry" \
  -t feature -p 3 --parent aspose-pdf-foss-for-ts-db7v \
  -d "Add float 'clear' controls and let a float carry across column/page boundaries (option C). Deferred from db7v.4."
```

- [ ] **Step 8: Commit**

```bash
git add src/index.ts README.md test/flow.test.ts
git commit -m "feat(flow): export FloatingBox + document AddFloatBox (db7v.4)"
```

- [ ] **Step 9: Close the issue**

```bash
bd close aspose-pdf-foss-for-ts-db7v.4
```

---

## Notes for the implementer

- **Why the `place`/remainder mechanism suffices for wrap:** placing a beside element with `availHeight` capped at the float bottom makes it reflow exactly at the box edge; the remainder is re-enqueued and, because the float is cleared and `colTop` snapped to the float bottom, the remainder draws full-width below. No change to `FlowElement.place`.
- **`spacing` triple-duty:** internal inter-element gap, external `band = width + spacing`, and vertical gap above/below the box. Keep this consistent between `measure`, `paintAt`, and the `Render` float branch.
- **Atomic floats:** a float never splits; if it doesn't fit the remaining height it moves whole to the next column (or throws in an empty column). The wrapping text paginates normally and does not carry the float across columns (option A).
- **No runtime import cycle:** `flow.ts` imports `FloatingBox` type-only; `floatbox.ts` imports `FlowParagraphOptions` type-only; the runtime instance is created by `document.ts`.
- **Right-float text assertion:** `GetTextFragments` may merge nearby runs; when asserting the box's own content x for a right float, allow that the box content sits at `columnX + columnWidth − width`.
```

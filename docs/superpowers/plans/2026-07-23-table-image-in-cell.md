# Table Image-in-Cell Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `CellBuilder.setImage(data, opts?)` so a table cell can embed a JPEG/PNG, aspect-fit to the cell box with alignment, optionally alongside text.

**Architecture:** Factor a reusable `drawBuiltImage` (embed a pre-built image XObject into a rect, cloning the stream so it can be reused across pages) out of `addImage`. Cache the built image + intrinsic pixel size on the cell. Extend `measure` so an image contributes `opts.height ?? imgH*innerWidth/imgW` to the row height, and add an image paint pass to the table renderer (order: backgrounds → images → text → borders).

**Tech Stack:** TypeScript (ESM + NodeNext, `strict`), vitest. Zero runtime deps (`node:` built-ins only).

## Global Constraints

- Zero runtime dependencies — only `node:` built-ins. Do not add npm runtime deps.
- ESM + NodeNext: every relative import specifier carries the `.js` extension.
- `strict` TypeScript. Table option validation throws `TypeError` (existing convention in `tableauthor.ts`); image parsing throws `UnsupportedFeatureError`/`PdfParseError` from `imageembed.ts`.
- TDD: failing test first, watch it fail, minimal implementation, watch it pass, commit.
- Run `npm run typecheck` and `npm test` before done; both green.
- Follow existing style: JSDoc on public/`@internal` members, the `checkPos`/`checkAlign`/`checkValign` validators, programmatic test fixtures.

---

### Task 1: `drawBuiltImage` helper (refactor `addImage`)

Factor the embed+paint tail of `addImage` into a reusable function that takes a pre-built `BuiltImage` and clones its stream, so the same image can be embedded independently on multiple pages.

**Files:**
- Modify: `src/imageembed.ts` — add `drawBuiltImage`, rewrite `addImage`'s tail to call it (lines 96-126)
- Test: `test/image-embed.test.ts` (append a `describe` block)

**Interfaces:**
- Consumes: `buildImageXObject(data, format?) => BuiltImage`, `ensureOwnResources`, `ensureOwnSubdict`, `registerExtGState`, `appendContent`, `freshKey`, `num` (all already imported in `imageembed.ts`).
- Produces:
  - `export function drawBuiltImage(doc: Document, page: Page, built: BuiltImage, rect: [number, number, number, number], opts?: { opacity?: number }): void` — clones `built.stream` (and `built.smask`), registers a fresh `/ImN` XObject in the page's own resources, and appends `q [/GS gs] w 0 0 h x y cm /ImN Do Q`. Called once per image draw.

- [ ] **Step 1: Write the failing tests**

Append to `test/image-embed.test.ts`. Add `drawBuiltImage` to the existing `import { buildImageXObject } from '../src/imageembed.js';` line so it reads `import { buildImageXObject, drawBuiltImage } from '../src/imageembed.js';`. Then:

```ts
describe('drawBuiltImage', () => {
  it('embeds a pre-built image into a rect and paints a cm/Do', () => {
    const doc = Document.Open(buildStampTarget());
    const built = buildImageXObject(buildJpeg(40, 20, 3));
    drawBuiltImage(doc, doc.Pages[0], built, [10, 10, 80, 40]);
    expect(doc.Pages[0].Images.length).toBe(1);
    const text = content(doc);
    expect(text).toContain('80 0 0 40 10 10 cm');
    expect(text).toContain('Do');
  });

  it('can embed the same BuiltImage twice as two independent XObjects', () => {
    const doc = Document.Open(buildStampTarget());
    const built = buildImageXObject(buildPngRgba());   // carries a soft mask
    drawBuiltImage(doc, doc.Pages[0], built, [0, 0, 10, 10]);
    drawBuiltImage(doc, doc.Pages[0], built, [20, 0, 10, 10]);
    const imgs = doc.Pages[0].Images;
    expect(imgs.length).toBe(2);                        // two distinct XObjects
  });

  it('registers an /ExtGState when opacity < 1', () => {
    const doc = Document.Open(buildStampTarget());
    const built = buildImageXObject(buildJpeg(8, 8, 3));
    drawBuiltImage(doc, doc.Pages[0], built, [0, 0, 8, 8], { opacity: 0.4 });
    expect(content(doc)).toMatch(/\/GS\d+ gs/);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/image-embed.test.ts`
Expected: FAIL — `drawBuiltImage` is not exported / not a function.

- [ ] **Step 3: Implement `drawBuiltImage` and rewrite `addImage`'s tail**

In `src/imageembed.ts`, replace the body of `addImage` from `const built = buildImageXObject(...)` through the end of the function (lines 102-126) with a build + delegate, and add `drawBuiltImage` right after `addImage`. The full replacement for the region starting at `const built = buildImageXObject(data, opts.format);`:

```ts
  const built = buildImageXObject(data, opts.format);
  const res = ensureOwnResources(doc, page);
  const xobjs = ensureOwnSubdict(doc, res, 'XObject');
  const key = freshKey(xobjs, 'Im');
  if (built.smask) built.stream.dict.set('SMask', doc.allocObject(built.smask));
  if (opts.layer) built.stream.dict.set('OC', opts.layer.Ref);
  xobjs.set(key, doc.allocObject(built.stream));

  const [x, y, w, h] = rect;
  const opacity = opts.opacity;
  const gsKey = opacity !== undefined && opacity < 1
    ? registerExtGState(doc, page, opacity) : undefined;
  let s = 'q\n';
  if (gsKey) s += `/${gsKey} gs\n`;
  s += `${num(w)} 0 0 ${num(h)} ${num(x)} ${num(y)} cm\n`;
  s += `/${key} Do\nQ`;
  const body = enc(s);
  const tagged = opts.tag
    ? wrapMarkedContent(opts.tag.Type, allocContentMcid(doc, opts.tag, page), body)
    : body;
  appendContent(doc, page, tagged);
}

/** Embed a pre-built {@link BuiltImage} into `rect` [x, y, w, h] on `page`.
 *  Clones the image stream (and its soft mask) before allocating, so a single
 *  `BuiltImage` can be embedded independently on several pages (e.g. a repeating
 *  table header). Registers a fresh `/ImN` XObject and appends the draw. */
export function drawBuiltImage(
  doc: Document, page: Page, built: BuiltImage,
  rect: [number, number, number, number], opts: { opacity?: number } = {},
): void {
  if (!Array.isArray(rect) || rect.length !== 4 || !rect.every((n) => Number.isFinite(n)))
    throw new TypeError('rect must be [x, y, w, h] (4 finite numbers)');
  const stream: PdfStream = { ...built.stream, dict: new Map(built.stream.dict) };
  if (built.smask) {
    const smask: PdfStream = { ...built.smask, dict: new Map(built.smask.dict) };
    stream.dict.set('SMask', doc.allocObject(smask));
  }
  const res = ensureOwnResources(doc, page);
  const xobjs = ensureOwnSubdict(doc, res, 'XObject');
  const key = freshKey(xobjs, 'Im');
  xobjs.set(key, doc.allocObject(stream));

  const [x, y, w, h] = rect;
  const opacity = opts.opacity;
  const gsKey = opacity !== undefined && opacity < 1
    ? registerExtGState(doc, page, opacity) : undefined;
  let s = 'q\n';
  if (gsKey) s += `/${gsKey} gs\n`;
  s += `${num(w)} 0 0 ${num(h)} ${num(x)} ${num(y)} cm\n`;
  s += `/${key} Do\nQ`;
  appendContent(doc, page, enc(s));
}
```

Note: `addImage`'s original ordering set `SMask` before registering; the rewrite keeps that. `PdfStream` is already imported at the top of `imageembed.ts`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/image-embed.test.ts`
Expected: PASS (new `drawBuiltImage` tests + all existing `addImage`/`buildImageXObject` tests).

- [ ] **Step 5: Commit**

```bash
git add src/imageembed.ts test/image-embed.test.ts
git commit -m "refactor(image): extract drawBuiltImage (reusable, stream-cloning) from addImage (49l.7)"
```

---

### Task 2: `CellImageOptions` + `CellBuilder.setImage`

Add the image option type, the cached-image field on `CellBuilder`, and the chainable `setImage` setter with validation.

**Files:**
- Modify: `src/tableauthor.ts` — imports, `CellImageOptions` interface, `CellBuilder.image` field + `setImage` method, an `checkOpacity`-style guard
- Test: `test/table-author.test.ts` (append a `describe` block)

**Interfaces:**
- Consumes: `buildImageXObject`, `BuiltImage` from `./imageembed.js`; existing `checkPos`, `checkAlign`, `checkValign`.
- Produces:
  - `export interface CellImageOptions { height?: number; align?: 'left'|'center'|'right'; valign?: 'top'|'center'|'bottom'; opacity?: number; format?: 'jpeg'|'png'; }`
  - `CellBuilder.image?: { built: BuiltImage; width: number; height: number; opts: CellImageOptions }` (mutable, default undefined).
  - `CellBuilder.setImage(data: Uint8Array, opts?: CellImageOptions): this` — validates, builds the XObject once, caches it with intrinsic pixel `width`/`height`, chainable.

- [ ] **Step 1: Write the failing tests**

Append to `test/table-author.test.ts`. First ensure the import line pulls in the helper and types; add to the existing `../src/index.js` import (or a new import) so `createTable` is available (it already is). Add a PNG builder import at the top: `import { buildPngRgbWith } from './helpers/build-embed-images.js';`. Then:

```ts
describe('CellBuilder.setImage', () => {
  const png2x1 = () => buildPngRgbWith(2, 1, [255, 0, 0, 0, 255, 0], 0);   // 2x1 RGB

  it('caches the built image and its intrinsic pixel size; chainable', () => {
    const cell = createTable().addRow().addCell('');
    expect(cell.setImage(png2x1())).toBe(cell);            // chainable
    expect(cell.image).toBeDefined();
    expect(cell.image!.width).toBe(2);
    expect(cell.image!.height).toBe(1);
    expect(cell.image!.opts).toEqual({});
  });

  it('keeps the cell text alongside the image', () => {
    const cell = createTable().addRow().addCell('caption');
    cell.setImage(png2x1(), { align: 'center', valign: 'bottom', height: 20, opacity: 0.5 });
    expect(cell.text).toBe('caption');
    expect(cell.image!.opts.height).toBe(20);
    expect(cell.image!.opts.align).toBe('center');
  });

  it('throws on invalid options and bad image bytes', () => {
    const cell = () => createTable().addRow().addCell('');
    expect(() => cell().setImage(png2x1(), { height: 0 })).toThrow(TypeError);
    expect(() => cell().setImage(png2x1(), { height: -5 })).toThrow(TypeError);
    expect(() => cell().setImage(png2x1(), { align: 'middle' as any })).toThrow(TypeError);
    expect(() => cell().setImage(png2x1(), { valign: 'centre' as any })).toThrow(TypeError);
    expect(() => cell().setImage(png2x1(), { opacity: 2 })).toThrow(TypeError);
    expect(() => cell().setImage(new Uint8Array([1, 2, 3]))).toThrow();   // unrecognized image
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/table-author.test.ts`
Expected: FAIL — `cell.setImage is not a function`.

- [ ] **Step 3: Implement `CellImageOptions`, the field, and `setImage`**

In `src/tableauthor.ts`:

Add to the imports at the top (after the existing `./layout.js` import):

```ts
import { buildImageXObject, BuiltImage } from './imageembed.js';
```

Add the option type near `CellOptions` (after the `CellOptions` interface, ~line 41):

```ts
/** `setImage` options: image sizing, placement, and opacity for a cell image. */
export interface CellImageOptions {
  /** Explicit image content height in points; default aspect-fit to inner width. */
  height?: number;
  /** Horizontal placement in the cell box; default the cell's resolved align. */
  align?: 'left' | 'center' | 'right';
  /** Vertical placement in the cell box; default the cell's resolved valign. */
  valign?: 'top' | 'center' | 'bottom';
  /** Constant opacity 0..1 (reuses /ExtGState). Default 1. */
  opacity?: number;
  /** Override JPEG/PNG sniffing. */
  format?: 'jpeg' | 'png';
}
```

Add an opacity validator next to `checkNonNeg`/`checkAlign` (~line 119):

```ts
function checkOpacity(n: number): void {
  if (typeof n !== 'number' || !Number.isFinite(n) || n < 0 || n > 1)
    throw new TypeError('opacity must be a number in 0..1');
}
```

In `class CellBuilder`, add the field and method. Replace the class body (lines 165-171) so the field and method are members:

```ts
export class CellBuilder {
  /** A cached cell image (from {@link setImage}) with intrinsic pixel size, or
   *  undefined. Painted aspect-fit into the cell box, under any cell text. */
  image?: { built: BuiltImage; width: number; height: number; opts: CellImageOptions };

  constructor(
    public text: string,
    readonly options: CellTextOptions,
    readonly colSpan: number = 1,
  ) {}

  /** Embed `data` (JPEG/PNG) in this cell, aspect-fit to the cell box. Validates
   *  and builds the image XObject once, caching it with its intrinsic pixel size.
   *  Bad image bytes throw from `buildImageXObject`. Chainable. */
  setImage(data: Uint8Array, opts: CellImageOptions = {}): this {
    if (!(data instanceof Uint8Array)) throw new TypeError('setImage data must be a Uint8Array');
    if (opts.height !== undefined) checkPos('image height', opts.height);
    if (opts.align !== undefined) checkAlign(opts.align);
    if (opts.valign !== undefined) checkValign(opts.valign);
    if (opts.opacity !== undefined) checkOpacity(opts.opacity);
    const built = buildImageXObject(data, opts.format);
    const width = built.stream.dict.get('Width') as number;
    const height = built.stream.dict.get('Height') as number;
    this.image = { built, width, height, opts };
    return this;
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/table-author.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck (new cross-module import)**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/tableauthor.ts test/table-author.test.ts
git commit -m "feat(table): CellBuilder.setImage + CellImageOptions (49l.7)"
```

---

### Task 3: `measure` accounts for image height

Extend `TableBuilder.measure` so an image cell contributes its aspect-fit (or explicit) height to the row height.

**Files:**
- Modify: `src/tableauthor.ts` — `measure` loop (the per-cell body, ~lines 294-308)
- Test: `test/table-author.test.ts` (extend the `setImage` describe block)

**Interfaces:**
- Consumes: `CellBuilder.image` (Task 2).
- Produces: `measure` unchanged signature; rows with image cells get a height of `max(textLinesHeight, imageContentHeight) + 2*padding`, where `imageContentHeight = image.opts.height ?? image.height * innerWidth / image.width`.

- [ ] **Step 1: Write the failing tests**

Add to the `CellBuilder.setImage` describe block in `test/table-author.test.ts`:

```ts
  it('an image drives the row height by aspect-fit to the inner width', () => {
    const t = createTable();
    t.addRow().addCell('').setImage(png2x1());     // 2x1 image (aspect 2:1)
    const pad = 2, colW = 100;                     // innerWidth = 96 -> imageH = 48
    const { rowHeights } = t.measure([colW], { cellPadding: pad });
    expect(rowHeights[0]).toBeCloseTo(48 + 2 * pad, 5);
  });

  it('an explicit image height overrides the aspect-fit height', () => {
    const t = createTable();
    t.addRow().addCell('').setImage(png2x1(), { height: 30 });
    const pad = 2;
    const { rowHeights } = t.measure([100], { cellPadding: pad });
    expect(rowHeights[0]).toBeCloseTo(30 + 2 * pad, 5);
  });

  it('a tall image beats the text line height for the row', () => {
    const t = createTable({ fontSize: 10, leading: 12 });
    // Two cells in one row: a text cell and a tall image cell.
    const row = t.addRow();
    row.addCell('hi');
    row.addCell('').setImage(png2x1());            // innerWidth 96 -> imageH 48
    const pad = 2;
    const { rowHeights } = t.measure([100, 100], { cellPadding: pad });
    expect(rowHeights[0]).toBeCloseTo(48 + 2 * pad, 5);   // image dominates
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/table-author.test.ts`
Expected: FAIL — row heights come out at the text line height (`12 + 4 = 16`), not the image height.

- [ ] **Step 3: Implement the image height in `measure`**

In `src/tableauthor.ts` `measure`, replace the per-cell height computation. The current block is:

```ts
        const st = resolveCellStyle(cell, row.style, this.defaults);
        const res = layoutText(cell.text, measuringDriverFor(st.font), st.fontSize, innerWidth, Infinity, st.leading);
        const lineCount = Math.max(1, res.lines.length);
        rowHeight = Math.max(rowHeight, lineCount * st.leading + 2 * padding);
        rowCellLines.push(res.lines.map((l) => l.text));
```

Replace it with:

```ts
        const st = resolveCellStyle(cell, row.style, this.defaults);
        const res = layoutText(cell.text, measuringDriverFor(st.font), st.fontSize, innerWidth, Infinity, st.leading);
        const lineCount = Math.max(1, res.lines.length);
        const textHeight = lineCount * st.leading;
        const imageHeight = cell.image
          ? (cell.image.opts.height ?? cell.image.height * innerWidth / cell.image.width)
          : 0;
        rowHeight = Math.max(rowHeight, Math.max(textHeight, imageHeight) + 2 * padding);
        rowCellLines.push(res.lines.map((l) => l.text));
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/table-author.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/tableauthor.ts test/table-author.test.ts
git commit -m "feat(table): measure accounts for image cell height (49l.7)"
```

---

### Task 4: Paint the image in the cell box

Carry the image through `Placed`, and add an image paint pass to the table renderer (order: backgrounds → images → text → borders), contained and aligned in the cell box.

**Files:**
- Modify: `src/tablerender.ts` — imports, `Placed` interface, `placeRows`, `paintPlaced`
- Test: `test/table-render.test.ts` (append a `describe` block)

**Interfaces:**
- Consumes: `drawBuiltImage` (Task 1); `CellBuilder.image` (Task 2); `resolveCellStyle`.
- Produces: internal only — `Placed` gains an optional `image` field; `paintPlaced` draws each image between backgrounds and text.

- [ ] **Step 1: Write the failing tests**

Append to `test/table-render.test.ts`. Add imports at the top: `import { buildPngRgbWith } from './helpers/build-embed-images.js';`. Then:

```ts
describe('table rendering — images in cells', () => {
  const png2x1 = () => buildPngRgbWith(2, 1, [255, 0, 0, 0, 255, 0], 0);   // aspect 2:1
  const png1x1 = () => buildPngRgbWith(1, 1, [0, 0, 255], 0);              // square
  const content = (page: any) => new TextDecoder().decode(page.Contents);
  // Parse the single "w 0 0 h x y cm" image placement from the content.
  const cmOf = (page: any) => {
    const m = content(page).match(/([-\d.]+) 0 0 ([-\d.]+) ([-\d.]+) ([-\d.]+) cm\s*\/Im\d+ Do/);
    if (!m) throw new Error('no image cm found');
    return { w: +m[1], h: +m[2], x: +m[3], y: +m[4] };
  };

  it('registers the image XObject and scales it aspect-fit to the inner width', () => {
    const doc = Document.Open(buildBlankPage());
    const t = createTable();
    t.addRow().addCell('').setImage(png2x1());
    const page = doc.Pages[0];
    page.AddTable(t, 72, 720, { width: 100, cellPadding: 2 });   // innerWidth 96 -> 96x48
    expect(page.Images.length).toBe(1);
    const cm = cmOf(page);
    expect(cm.w).toBeCloseTo(96, 3);
    expect(cm.h).toBeCloseTo(48, 3);
    expect(cm.x).toBeCloseTo(72 + 2, 3);          // left inset by padding
  });

  it('honors an explicit height (height-capped) and centers a square image', () => {
    const doc = Document.Open(buildBlankPage());
    const t = createTable();
    t.addRow().addCell('').setImage(png1x1(), { height: 20, align: 'center', valign: 'top' });
    const page = doc.Pages[0];
    page.AddTable(t, 72, 720, { width: 100, cellPadding: 2 });   // innerWidth 96, box 96x20
    const cm = cmOf(page);
    expect(cm.w).toBeCloseTo(20, 3);              // square contained into 96x20 -> 20x20
    expect(cm.h).toBeCloseTo(20, 3);
    expect(cm.x).toBeCloseTo(72 + 2 + (96 - 20) / 2, 3);   // centered horizontally
  });

  it('draws the image under the cell text (both present)', () => {
    const doc = Document.Open(buildBlankPage());
    const t = createTable({ fontSize: 10, leading: 12 });
    t.addRow().addCell('LABEL').setImage(png2x1());
    const page = doc.Pages[0];
    page.AddTable(t, 72, 720, { width: 100, cellPadding: 2 });
    expect(page.Images.length).toBe(1);                        // image present
    expect(page.GetTextFragments().some((f) => f.text.includes('LABEL'))).toBe(true);  // text present
    // Image Do appears before the text 'LABEL' in the content stream (image under text).
    const c = content(page);
    const doIdx = c.indexOf(' Do');
    const txtIdx = c.indexOf('LABEL');
    expect(doIdx).toBeGreaterThanOrEqual(0);
    expect(txtIdx).toBeGreaterThanOrEqual(0);
    expect(doIdx).toBeLessThan(txtIdx);
  });

  it('spans a colspan image across the combined column width', () => {
    const doc = Document.Open(buildBlankPage());
    const t = createTable().setColumnWidths([{ fixed: 60 }, { fixed: 60 }]);
    t.addRow().addCell('', { colSpan: 2 }).setImage(png2x1());  // inner width 120 - 4 = 116
    const page = doc.Pages[0];
    page.AddTable(t, 72, 720, { width: 120, cellPadding: 2 });
    const cm = cmOf(page);
    expect(cm.w).toBeCloseTo(116, 3);
  });

  it('applies image opacity via /ExtGState', () => {
    const doc = Document.Open(buildBlankPage());
    const t = createTable();
    t.addRow().addCell('').setImage(png2x1(), { opacity: 0.3 });
    const page = doc.Pages[0];
    page.AddTable(t, 72, 720, { width: 100, cellPadding: 2 });
    expect(content(page)).toMatch(/\/GS\d+ gs/);
  });

  it('reprints a header image on every auto-paginated page', () => {
    const doc = Document.Open(buildBlankPage());
    const t = createTable({ fontSize: 10, leading: 12 });
    t.addRow().addCell('').setImage(png2x1(), { height: 10 });   // header row with image
    for (let i = 0; i < 120; i++) t.addRow([`row${i}`]);
    t.setRepeatingRowsCount(1);
    const res = doc.Pages[0].AddTable(t, 72, 720, {
      width: 100, cellPadding: 2, autoPaginate: true, bottomMargin: 72, topMargin: 72,
    });
    expect(res.pages.length).toBeGreaterThan(1);
    for (const p of res.pages) expect(p.Images.length).toBe(1);   // one image per page
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/table-render.test.ts`
Expected: FAIL — no image XObject is drawn (`page.Images.length` is 0 / `no image cm found`).

- [ ] **Step 3: Carry the image through `Placed`**

In `src/tablerender.ts`, add the import (extend the existing `./tableauthor.js` import to include `CellImageOptions`, and add a new import for `drawBuiltImage` + `BuiltImage`):

```ts
import { drawBuiltImage } from './imageembed.js';
import type { BuiltImage } from './imageembed.js';
import {
  TableBuilder, resolveCellStyle, ResolvedStyle, BorderInfo, CellImageOptions,
} from './tableauthor.js';
```

Extend the `Placed` interface (line 45):

```ts
interface Placed {
  x: number; bottom: number; w: number; h: number; text: string; style: ResolvedStyle;
  image?: { built: BuiltImage; width: number; height: number; opts: CellImageOptions };
}
```

In `placeRows`, copy the image onto the `Placed` (the `placed.push({...})`):

```ts
      placed.push({
        x: columnX[c], bottom: rowBottom, w: cellW, h: rowHeights[r],
        text: cell.text, style: resolveCellStyle(cell, table.rows[r].style, table.defaults),
        image: cell.image,
      });
```

- [ ] **Step 4: Add the image paint pass**

In `paintPlaced`, insert a new pass between the backgrounds pass (`bg.apply();`) and the text pass. `paintPlaced` needs `doc`/`page` which it already receives. Add after `bg.apply();`:

```ts
  // Pass 1.5: cell images (above backgrounds, below text). Contained (aspect-
  // preserving) into innerWidth x imageContentHeight, then placed in the full
  // inner box by the image's align/valign (defaulting to the cell's).
  for (const p of placed) {
    if (!p.image) continue;
    const innerW = p.w - 2 * padding;
    const innerH = p.h - 2 * padding;
    if (innerW <= 0 || innerH <= 0) continue;
    const { built, width: imgW, height: imgH, opts } = p.image;
    const boxH = opts.height ?? imgH * innerW / imgW;   // measured image content height
    const scale = Math.min(innerW / imgW, boxH / imgH);
    const drawnW = imgW * scale;
    const drawnH = imgH * scale;
    const align = opts.align ?? p.style.align;
    const valign = opts.valign ?? p.style.valign;
    const ix = p.x + padding, iy = p.bottom + padding;
    const dx = align === 'center' ? (innerW - drawnW) / 2 : align === 'right' ? innerW - drawnW : 0;
    const dy = valign === 'center' ? (innerH - drawnH) / 2 : valign === 'top' ? innerH - drawnH : 0;
    drawBuiltImage(doc, page, built, [ix + dx, iy + dy, drawnW, drawnH], { opacity: opts.opacity });
  }
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run test/table-render.test.ts`
Expected: PASS (new image tests + all existing rendering tests).

- [ ] **Step 6: Full suite + typecheck**

Run: `npm run typecheck && npm test`
Expected: typecheck clean; full vitest suite green.

- [ ] **Step 7: Commit**

```bash
git add src/tablerender.ts test/table-render.test.ts
git commit -m "feat(table): paint image cells (contained, aligned) in the cell box (49l.7)"
```

---

### Task 5: README documentation

Document `setImage` in the user-facing table section.

**Files:**
- Modify: `README.md` (table authoring section + the API-summary table row + the feature bullet)

**Interfaces:**
- Consumes: the shipped `setImage` API.
- Produces: documentation only.

- [ ] **Step 1: Locate the table section**

Run: `grep -n "setRepeatingRowsCount\|setColumnWidths\|AddTable\|Table authoring" README.md`
Expected: finds the table authoring subsection and its API-summary row.

- [ ] **Step 2: Add the image-in-cell description**

In the table authoring subsection (near the styling/pagination prose), add a short paragraph and example consistent with the surrounding style:

```markdown
A cell can hold an image (JPEG/PNG) via `cell.setImage(bytes, opts?)`. The image
is embedded (see `AddImage`) and drawn aspect-fit to the cell box; it sizes the
row by default (`imgH * innerWidth / imgW`) unless you pass an explicit `height`.
`align`/`valign` position it in the box (defaulting to the cell's), and it may sit
under cell text.

```ts
const t = createTable();
const row = t.addRow();
row.addCell('').setImage(logoPng, { height: 32, align: 'center' });
row.addCell('Acme Corp.', { valign: 'center' });
doc.Pages[0].AddTable(t, 72, 720, { width: 400 });
```
```

Also update the feature bullet at the top of the table section to mention images, and the API-summary table row for `page.AddTable` / add a `setImage` mention. Match the exact heading level, code-fence tag, and voice already used.

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs(table): README — cell.setImage image-in-cell support (49l.7)"
```

---

### Task 6: Final verification and issue close

**Files:** none (verification + tracker).

- [ ] **Step 1: Full green gate**

Run: `npm run typecheck && npm test`
Expected: typecheck clean; entire vitest suite passes.

- [ ] **Step 2: Prove the new assertions are load-bearing (spot check)**

Temporarily comment out the `drawBuiltImage(...)` call in the image paint pass and run:
`npx vitest run test/table-render.test.ts`
Expected: the image tests FAIL (no XObject / no cm). Restore the code and confirm green again. (Do not commit the revert.)

- [ ] **Step 3: Close the issue**

```bash
bd close aspose-pdf-foss-for-ts-49l.7
```

---

## Self-Review Notes

- **Spec coverage:** API + validation + cache (Task 2), measurement aspect-fit/override (Task 3), painting contained+aligned with backgrounds→images→text→borders order (Task 4), the `drawBuiltImage` clone/reuse helper (Task 1), image+text coexistence and colSpan and opacity and header-image-per-page (Task 4 tests), invalid bytes/options (Task 2 tests), docs (Task 5). Every spec section maps to a task.
- **Placeholder scan:** none — every code step shows complete code; every test step shows real assertions.
- **Type consistency:** `CellImageOptions`, `CellBuilder.image` (`{ built, width, height, opts }`), `setImage`, `drawBuiltImage(doc, page, built, rect, { opacity })`, `Placed.image` all use identical shapes and names across Tasks 1–4. `imageContentHeight`/`boxH` is computed identically in `measure` (Task 3) and the paint pass (Task 4): `opts.height ?? imgH * innerWidth / imgW`.

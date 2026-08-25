# Markup Annotations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the text-markup annotation family — `/Highlight`, `/Underline`, `/StrikeOut`, `/Squiggly` — keyed on `/QuadPoints`, each with a generated `/AP /N` appearance (filled quads for highlight; lines / a zig-zag for the others), honoring `/C` color and `/CA` opacity.

**Architecture:** `src/annotation.ts` gains a `MarkupAnnotation extends Annotation` subclass (`MarkupType` getter + `QuadPoints` accessor) and one private `addMarkup(doc, page, subtype, opts, draw)` builder shared by four thin `add*` functions that differ only by `/Subtype` and a draw routine. The builder computes the annotation `/Rect` as the bounding box of `/QuadPoints`, sets `/QuadPoints` and `/CA`, then installs an `/AP /N` Form XObject built with `buildAppearanceXObject`/`installAP` from `src/appearance.ts`; the appearance form draws in form-space (quad coordinates offset by the rect origin) and carries a per-form `/ExtGState` when opacity `< 1`. `wrapAnnotation` dispatches the four subtypes to `MarkupAnnotation`, and `Page` gains `AddHighlight`/`AddUnderline`/`AddStrikeOut`/`AddSquiggly`, mirroring `Page.AddStamp`.

**Tech Stack:** TypeScript (strict, ESM + NodeNext), vitest. Node built-ins only.

## Global Constraints

- **Zero runtime dependencies** — only `node:` built-ins. Do not add npm runtime deps.
- **ESM + NodeNext** — every relative import specifier carries the `.js` extension.
- **Strict TypeScript** — `npm run typecheck` must stay green.
- **Public error types only** — `TypeError` for bad inputs.
- **Live-mutation model** — edits act directly on the live dict; never copy-and-replace the page dict.
- **Colors are DeviceRGB `0..1`** — three finite numbers in `[0,1]`; `TypeError` otherwise (enforced by the shared `createAnnotation` for `/C`).
- **Default annotation flag** — created annotations get `/F = 4` (Print), `/M` = now, `/P` → the page, appended to the page's **own** `/Annots`. All handled by `createAnnotation`.
- **Validate before mutating the page** — validate `quads` (and `color`/`opacity`) *before* `createAnnotation` allocates/attaches anything.
- **Coordinates are DeviceRGB `0..1` colors and point coordinates** — `/QuadPoints` are absolute page-space points; the appearance form draws them offset by the rect origin so the form `/BBox` `[0 0 w h]` maps onto `/Rect`.
- **TDD** — failing test first, watch it fail, implement minimally, watch it pass, commit. Run `npm run typecheck` before any commit that changes types.
- Target a single test file with `npx vitest run test/annotation.test.ts`; full suite with `npm test`.

## Foundation already shipped (consume, do not rebuild)

From `src/annotation.ts` (on `main`):
- `class Annotation { constructor(doc, dict); readonly Dict; get Subtype; get/set Rect, Color, Contents, Name, ModDate, Flags, Print, Hidden, Opacity }`. `doc` is `protected`.
- `class TextAnnotation`, `class StampAnnotation` — the established subclass pattern to mirror.
- `function wrapAnnotation(doc, dict): Annotation` — dispatches on `/Subtype`; currently `case 'Text'` and `case 'Stamp'`. This plan adds four markup cases.
- `function createAnnotation(doc, page, init: BaseAnnotInit): PdfDict` where `interface BaseAnnotInit { subtype: string; rect: [number,number,number,number]; color?: [number,number,number]; contents?: string }` — sets `/Type`, `/Subtype`, `/Rect`, `/F`=4, `/M`=now, `/P`, optional `/C`/`/Contents`, validates `rect`/`color` before allocating, appends to the page's own `/Annots`.
- Module-private helpers available to same-module code: `pdfText(s)`, `checkNums(key, v, n)` (returns a defensive copy; throws `TypeError` unless `v` is exactly `n` finite numbers), `numArray(doc, o, n)`, `FLAG_PRINT`.
- Already-imported in `annotation.ts`: `PdfDict, PdfObject, PdfStream, isArray, isName, isString, name` from `./types.js`; `decodePdfText, encodePdfText, formatPdfDate, parsePdfDate` from `./metadata.js`; `widgetGeom, buildAppearanceXObject, installAP, type WidgetGeom` from `./appearance.js`; `measure` from `./metrics.js`; `encodeWinAnsi` from `./encoding.js`; `serializeString` from `./serialize.js`; `num` from `./pagecontent.js`; `buildImageXObject, type BuiltImage` from `./imageembed.js`.

From `src/appearance.ts`:
- `interface WidgetGeom { w: number; h: number; rotate: 0|90|180|270 }`.
- `function buildAppearanceXObject(doc, g: WidgetGeom, std: StdFont, fontKey: string, body: string): PdfStream` — wraps `body` in `q … Q`, sets `/BBox [0 0 g.w g.h]`, `/Matrix` (identity for `rotate: 0`), `/Resources` = a Font subdict. (Markup ignores the font; the unused entry is harmless, matching the image-stamp path.)
- `function installAP(doc, dict, stream): void` — allocates `stream`, sets `dict`'s `/AP` to `<< /N <ref> >>`.

From `src/pagecontent.ts`: `function num(n: number): string`.
From `src/types.js`: `function name(s): PdfName`; the `PdfDict`/`PdfObject`/`PdfStream` types.

From `src/page.ts`: `Page` delegates feature methods to free functions (`AddStamp` → `addStamp`); `this.doc` and `this` available in methods.

From `test/helpers/build-annot-target.ts`: `buildAnnotTarget()`, `buildBlankPage()`, `buildStampReadTarget()`, and the private `assemble(objects, maxObj, rootNum)`.

From `src/content.ts`: `parseContentStream(buf): ContentOp[]`, `interface ContentOp { readonly operator: string; readonly operands: PdfObject[] }`.

---

### Task 1: `MarkupAnnotation` subclass + `wrapAnnotation` dispatch

Introduces the subclass and makes the read model return it for the four markup subtypes. Pure read-model.

**Files:**
- Modify: `test/helpers/build-annot-target.ts` (add a `buildMarkupReadTarget` fixture)
- Modify: `src/annotation.ts` (add `MarkupAnnotation`, extend `wrapAnnotation`)
- Modify: `test/annotation.test.ts` (add a `MarkupAnnotation` describe block + imports)

**Interfaces:**
- Consumes: `Annotation` (base), `isName`/`name` (already imported), `numArray`, `checkNums` (module-private).
- Produces:
  - `export function buildMarkupReadTarget(): Uint8Array` — one page with a single `/Highlight` annotation carrying `/QuadPoints [10 40 60 40 10 30 60 30]`.
  - `type MarkupType = 'highlight' | 'underline' | 'strikeout' | 'squiggly'`
  - `class MarkupAnnotation extends Annotation { get MarkupType(): MarkupType; get QuadPoints(): number[]; set QuadPoints(q: number[]) }`
  - `wrapAnnotation` returns `MarkupAnnotation` for `Highlight`/`Underline`/`StrikeOut`/`Squiggly`.

- [ ] **Step 1: Add the read fixture**

In `test/helpers/build-annot-target.ts`, append:

```ts
/** One page carrying a single existing /Highlight markup annotation. */
export function buildMarkupReadTarget(): Uint8Array {
  const objects: string[] = [];
  objects[1] = `<< /Type /Catalog /Pages 2 0 R >>`;
  objects[2] = `<< /Type /Pages /Count 1 /Kids [3 0 R] /MediaBox [0 0 300 200] >>`;
  objects[3] = `<< /Type /Page /Parent 2 0 R /Annots [4 0 R] >>`;
  objects[4] = `<< /Type /Annot /Subtype /Highlight /Rect [10 30 60 40] ` +
    `/QuadPoints [10 40 60 40 10 30 60 30] /C [1 1 0] /F 4 >>`;
  return assemble(objects, 4, 1);
}
```

- [ ] **Step 2: Write the failing test**

In `test/annotation.test.ts`, extend the import from `../src/annotation.js` to add `MarkupAnnotation`, and the helper import to add `buildMarkupReadTarget`:

```ts
import {
  Annotation, createAnnotation, TextAnnotation, StampAnnotation, MarkupAnnotation,
} from '../src/annotation.js';
import {
  buildAnnotTarget, buildBlankPage, buildStampReadTarget, buildMarkupReadTarget,
} from './helpers/build-annot-target.js';
```

Append a new describe block:

```ts
describe('MarkupAnnotation', () => {
  it('wraps the four markup subtypes and exposes MarkupType + QuadPoints', () => {
    const doc = Document.Open(buildMarkupReadTarget());
    const a = doc.Pages[0].Annotations[0];
    expect(a).toBeInstanceOf(MarkupAnnotation);

    const m = a as MarkupAnnotation;
    expect(m.Subtype).toBe('Highlight');
    expect(m.MarkupType).toBe('highlight');
    expect(m.QuadPoints).toEqual([10, 40, 60, 40, 10, 30, 60, 30]);

    m.QuadPoints = [0, 8, 4, 8, 0, 0, 4, 0];
    expect(m.QuadPoints).toEqual([0, 8, 4, 8, 0, 0, 4, 0]);
  });

  it('rejects /QuadPoints whose length is not a positive multiple of 8', () => {
    const doc = Document.Open(buildMarkupReadTarget());
    const m = doc.Pages[0].Annotations[0] as MarkupAnnotation;
    expect(() => { m.QuadPoints = [1, 2, 3, 4]; }).toThrow(TypeError);
    expect(() => { m.QuadPoints = []; }).toThrow(TypeError);
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx vitest run test/annotation.test.ts`
Expected: FAIL — `MarkupAnnotation` is not exported / `instanceof MarkupAnnotation` is false.

- [ ] **Step 4: Add the `MarkupAnnotation` subclass**

In `src/annotation.ts`, insert this immediately after the `StampAnnotation` class (and before `wrapAnnotation`):

```ts
/** The four text-markup subtypes, lower-cased. */
export type MarkupType = 'highlight' | 'underline' | 'strikeout' | 'squiggly';

const MARKUP_SUBTYPES: Record<string, MarkupType> = {
  Highlight: 'highlight', Underline: 'underline', StrikeOut: 'strikeout', Squiggly: 'squiggly',
};

/** A text-markup annotation (/Highlight, /Underline, /StrikeOut, /Squiggly)
 *  positioned by /QuadPoints (8 numbers per marked quad). */
export class MarkupAnnotation extends Annotation {
  /** Lower-cased markup kind derived from /Subtype. */
  get MarkupType(): MarkupType {
    return MARKUP_SUBTYPES[this.Subtype] ?? 'highlight';
  }

  /** /QuadPoints as a flat list of 8·n finite numbers; [] when absent. */
  get QuadPoints(): number[] {
    const a = this.doc.resolve(this.Dict.get('QuadPoints'));
    if (!isArray(a)) return [];
    const out: number[] = [];
    for (const e of a) { const v = this.doc.resolve(e); if (typeof v === 'number') out.push(v); }
    return out;
  }

  set QuadPoints(q: number[]) {
    if (!Array.isArray(q) || q.length === 0 || q.length % 8 !== 0 ||
        !q.every((x) => typeof x === 'number' && Number.isFinite(x)))
      throw new TypeError('QuadPoints must be a non-empty list of finite numbers, length a multiple of 8');
    this.Dict.set('QuadPoints', [...q]);
  }
}
```

- [ ] **Step 5: Extend `wrapAnnotation`**

In `src/annotation.ts`, add the four cases to the `wrapAnnotation` switch (alongside `case 'Text'`/`case 'Stamp'`):

```ts
    case 'Stamp': return new StampAnnotation(doc, dict);
    case 'Highlight':
    case 'Underline':
    case 'StrikeOut':
    case 'Squiggly': return new MarkupAnnotation(doc, dict);
    default: return new Annotation(doc, dict);
```

- [ ] **Step 6: Run typecheck and tests**

Run: `npm run typecheck` — Expected: no errors.
Run: `npx vitest run test/annotation.test.ts` — Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/annotation.ts test/annotation.test.ts test/helpers/build-annot-target.ts
git commit -m "feat: MarkupAnnotation subtype with MarkupType + QuadPoints

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: `Page.AddHighlight` + the shared `addMarkup` builder (filled-quad appearance)

Adds `MarkupOptions`, the shared builder, the highlight draw routine, `Page.AddHighlight`, exports, and docs. Establishes the appearance machinery the other three reuse.

**Files:**
- Modify: `src/annotation.ts` (add `MarkupOptions`, quad geometry helpers, `addMarkup`, highlight draw, `addHighlight`)
- Modify: `src/page.ts` (add `AddHighlight` method + imports)
- Modify: `src/index.ts` (export `MarkupAnnotation` + `MarkupOptions` + `MarkupType`)
- Modify: `README.md` (API row)
- Modify: `test/annotation.test.ts` (create + appearance + round-trip tests)

**Interfaces:**
- Consumes: `createAnnotation`, `MarkupAnnotation`/`MarkupType` (Task 1), `buildAppearanceXObject`/`installAP`, `num`, `name`.
- Produces:
  - `interface MarkupOptions { quads: number[]; color?: [number,number,number]; contents?: string; opacity?: number }`
  - `interface QuadCorners { x1:number;y1:number;x2:number;y2:number;x3:number;y3:number;x4:number;y4:number }`
  - `function quadsBBox(quads: number[]): { minX:number; minY:number; maxX:number; maxY:number }`
  - `function offsetQuads(quads: number[], minX: number, minY: number): QuadCorners[]`
  - `function addMarkup(doc, page, subtype, opts, draw: (qs: QuadCorners[], color: [number,number,number]) => string): MarkupAnnotation`
  - `function addHighlight(doc: Document, page: Page, opts: MarkupOptions): MarkupAnnotation`
  - `Page.AddHighlight(opts: MarkupOptions): MarkupAnnotation`

- [ ] **Step 1: Write the failing test**

In `test/annotation.test.ts`, append (the `isStream`/`parseContentStream` imports already exist from the stamp tasks):

```ts
describe('Page.AddHighlight', () => {
  function apN(doc: Document, m: MarkupAnnotation) {
    const ap = doc.resolve(m.Dict.get('AP')) as Map<string, any>;
    const n = doc.resolve(ap.get('N'));
    expect(isStream(n)).toBe(true);
    return n as any;
  }

  it('creates a /Highlight with /Rect = quad bbox, /QuadPoints, and a fill appearance', () => {
    const doc = Document.Open(buildBlankPage());
    const page = doc.Pages[0];

    const m = page.AddHighlight({ quads: [10, 40, 60, 40, 10, 30, 60, 30] });

    expect(m).toBeInstanceOf(MarkupAnnotation);
    expect(m.Subtype).toBe('Highlight');
    expect(m.MarkupType).toBe('highlight');
    expect(m.Rect).toEqual([10, 30, 60, 40]);          // bbox of the quad
    expect(m.QuadPoints).toEqual([10, 40, 60, 40, 10, 30, 60, 30]);
    expect(m.Color).toEqual([1, 1, 0]);                // default yellow
    expect(m.Print).toBe(true);
    expect(page.Annotations).toHaveLength(1);

    const n = apN(doc, m);
    expect(n.dict.get('BBox')).toEqual([0, 0, 50, 10]); // w=50, h=10
    const ops = parseContentStream(n.raw).map((o) => o.operator);
    expect(ops).toContain('f');                         // filled quad
  });

  it('honors a custom color and sets /CA + an ExtGState when opacity < 1', () => {
    const doc = Document.Open(buildBlankPage());
    const m = doc.Pages[0].AddHighlight({
      quads: [0, 10, 20, 10, 0, 0, 20, 0], color: [0, 1, 0], opacity: 0.4, contents: 'note',
    });
    expect(m.Color).toEqual([0, 1, 0]);
    expect(m.Opacity).toBe(0.4);
    expect(m.Contents).toBe('note');

    const ap = doc.resolve(m.Dict.get('AP')) as Map<string, any>;
    const n = doc.resolve(ap.get('N')) as any;
    const res = doc.resolve(n.dict.get('Resources')) as Map<string, any>;
    expect(res.has('ExtGState')).toBe(true);
    expect(new TextDecoder().decode(n.raw)).toContain('gs');
  });

  it('rejects quads whose length is not a positive multiple of 8', () => {
    const doc = Document.Open(buildBlankPage());
    const page = doc.Pages[0];
    expect(() => page.AddHighlight({ quads: [1, 2, 3, 4] })).toThrow(TypeError);
    expect(page.Annotations).toHaveLength(0);
  });

  it('round-trips a highlight through Save/Open', () => {
    const doc = Document.Open(buildBlankPage());
    doc.Pages[0].AddHighlight({ quads: [10, 40, 60, 40, 10, 30, 60, 30] });

    const reopened = Document.Open(doc.Save());
    const annots = reopened.Pages[0].Annotations;
    expect(annots).toHaveLength(1);
    expect(annots[0]).toBeInstanceOf(MarkupAnnotation);
    expect((annots[0] as MarkupAnnotation).QuadPoints).toEqual([10, 40, 60, 40, 10, 30, 60, 30]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/annotation.test.ts`
Expected: FAIL — `page.AddHighlight is not a function`.

- [ ] **Step 3: Add `MarkupOptions`, geometry helpers, `addMarkup`, highlight draw, and `addHighlight`**

Append at the end of `src/annotation.ts`:

```ts
/** Options for the Page.Add{Highlight,Underline,StrikeOut,Squiggly} methods. */
export interface MarkupOptions {
  /** /QuadPoints: 8·n finite numbers (4 corner points per marked quad). */
  quads: number[];
  /** /C color, RGB 0..1. Default yellow for highlight, black otherwise. */
  color?: [number, number, number];
  /** /Contents body text. */
  contents?: string;
  /** /CA constant opacity, 0..1. */
  opacity?: number;
}

/** A quad's four corners (PDF QuadPoints order: 1=TL, 2=TR, 3=BL, 4=BR). */
export interface QuadCorners {
  x1: number; y1: number; x2: number; y2: number;
  x3: number; y3: number; x4: number; y4: number;
}

/** Axis-aligned bounding box over all corner points of `quads`. */
export function quadsBBox(quads: number[]): { minX: number; minY: number; maxX: number; maxY: number } {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (let i = 0; i < quads.length; i += 2) {
    const x = quads[i], y = quads[i + 1];
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
  }
  return { minX, minY, maxX, maxY };
}

/** Split `quads` into per-quad corners, translated into form space (origin at
 *  the quad bbox lower-left, so the form /BBox [0 0 w h] maps onto /Rect). */
export function offsetQuads(quads: number[], minX: number, minY: number): QuadCorners[] {
  const out: QuadCorners[] = [];
  for (let i = 0; i < quads.length; i += 8) {
    out.push({
      x1: quads[i] - minX,     y1: quads[i + 1] - minY,
      x2: quads[i + 2] - minX, y2: quads[i + 3] - minY,
      x3: quads[i + 4] - minX, y3: quads[i + 5] - minY,
      x4: quads[i + 6] - minX, y4: quads[i + 7] - minY,
    });
  }
  return out;
}

/** Validate `quads`: a non-empty list of finite numbers whose length is 8·n. */
function checkQuads(quads: number[]): number[] {
  if (!Array.isArray(quads) || quads.length === 0 || quads.length % 8 !== 0 ||
      !quads.every((x) => typeof x === 'number' && Number.isFinite(x)))
    throw new TypeError('quads must be a non-empty list of finite numbers, length a multiple of 8');
  return [...quads];
}

/** @internal Build a markup annotation of `subtype`, attach it to the page, set
 *  /QuadPoints + optional /CA, and install an /AP /N drawn by `draw`. Validates
 *  before allocating. `draw` receives form-space quad corners + the resolved color. */
export function addMarkup(
  doc: Document, page: Page, subtype: string, opts: MarkupOptions,
  draw: (qs: QuadCorners[], color: [number, number, number]) => string,
): MarkupAnnotation {
  const quads = checkQuads(opts.quads);
  const defaultColor: [number, number, number] = subtype === 'Highlight' ? [1, 1, 0] : [0, 0, 0];
  const color = opts.color ?? defaultColor;
  if (opts.opacity !== undefined &&
      (typeof opts.opacity !== 'number' || !Number.isFinite(opts.opacity) || opts.opacity < 0 || opts.opacity > 1))
    throw new TypeError('opacity must be in 0..1');

  const { minX, minY, maxX, maxY } = quadsBBox(quads);
  const dict = createAnnotation(doc, page, {
    subtype,
    rect: [minX, minY, maxX, maxY],
    color,
    contents: opts.contents,
  });
  const markup = new MarkupAnnotation(doc, dict);
  markup.QuadPoints = quads;
  if (opts.opacity !== undefined) markup.Opacity = opts.opacity;

  const w = maxX - minX, h = maxY - minY;
  if (w > 0 && h > 0) {
    const g: WidgetGeom = { w, h, rotate: 0 };
    const qs = offsetQuads(quads, minX, minY);
    const opacity = opts.opacity ?? 1;
    let body = '';
    if (opacity < 1) body += '/GS0 gs\n';
    body += draw(qs, color);
    const stream = buildAppearanceXObject(doc, g, 'Helvetica', 'F0', body);
    if (opacity < 1) {
      const gsDict: PdfDict = new Map<string, PdfObject>([
        ['Type', name('ExtGState')], ['ca', opacity], ['CA', opacity],
      ]);
      (stream.dict.get('Resources') as PdfDict).set(
        'ExtGState', new Map<string, PdfObject>([['GS0', doc.allocObject(gsDict)]]),
      );
    }
    installAP(doc, dict, stream);
  }
  return markup;
}

/** Fill each quad with the markup color (TL→TR→BR→BL polygon). */
function drawHighlight(qs: QuadCorners[], color: [number, number, number]): string {
  const [r, g, b] = color;
  let s = `${num(r)} ${num(g)} ${num(b)} rg\n`;
  for (const q of qs) {
    s += `${num(q.x1)} ${num(q.y1)} m ${num(q.x2)} ${num(q.y2)} l ` +
      `${num(q.x4)} ${num(q.y4)} l ${num(q.x3)} ${num(q.y3)} l f\n`;
  }
  return s;
}

/** Build and attach a /Highlight markup annotation to `page`. */
export function addHighlight(doc: Document, page: Page, opts: MarkupOptions): MarkupAnnotation {
  return addMarkup(doc, page, 'Highlight', opts, drawHighlight);
}
```

- [ ] **Step 4: Add `Page.AddHighlight`**

In `src/page.ts`, extend the existing import from `./annotation.js`:

```ts
import {
  Annotation, wrapAnnotation, addTextNote, TextAnnotation, TextNoteOptions,
  addStamp, StampAnnotation, StampAnnotationOptions,
  addHighlight, MarkupAnnotation, MarkupOptions,
} from './annotation.js';
```

Add the method immediately after `AddStamp`:

```ts
  /** Add a /Highlight markup annotation over the given /QuadPoints. */
  AddHighlight(opts: MarkupOptions): MarkupAnnotation {
    return addHighlight(this.doc, this, opts);
  }
```

- [ ] **Step 5: Run typecheck and tests**

Run: `npm run typecheck` — Expected: no errors.
Run: `npx vitest run test/annotation.test.ts` — Expected: PASS.

- [ ] **Step 6: Export from `index.ts`**

In `src/index.ts`, replace:

```ts
export { Annotation, TextAnnotation, StampAnnotation } from './annotation.js';
export type { TextNoteOptions, StampAnnotationOptions } from './annotation.js';
```

with:

```ts
export { Annotation, TextAnnotation, StampAnnotation, MarkupAnnotation } from './annotation.js';
export type { TextNoteOptions, StampAnnotationOptions, MarkupOptions, MarkupType } from './annotation.js';
```

- [ ] **Step 7: Update the README**

In `README.md`, after the `page.AddStamp(opts)` row, add:

```
| `page.AddHighlight(opts)` | Add a `/Highlight` markup over `/QuadPoints` with a fill appearance |
```

- [ ] **Step 8: Run typecheck, full suite, and build**

Run: `npm run typecheck` — Expected: no errors.
Run: `npm test` — Expected: full suite green.
Run: `npm run build` — Expected: clean build (emits `MarkupAnnotation`/`MarkupOptions`/`MarkupType` to `.d.ts`).

- [ ] **Step 9: Commit**

```bash
git add src/annotation.ts src/page.ts src/index.ts README.md test/annotation.test.ts
git commit -m "feat: Page.AddHighlight markup annotation with fill appearance

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: `AddUnderline` / `AddStrikeOut` / `AddSquiggly` (line + zig-zag appearances)

Adds the three line-based markup methods, reusing the Task 2 builder with new draw routines. Underline strokes along each quad's bottom, strike-out along the vertical middle, squiggly draws a zig-zag along the bottom.

**Files:**
- Modify: `src/annotation.ts` (three draw routines + three `add*` functions)
- Modify: `src/page.ts` (three `Add*` methods + imports)
- Modify: `README.md` (API rows)
- Modify: `test/annotation.test.ts` (per-subtype create + appearance tests)

**Interfaces:**
- Consumes: `addMarkup`, `QuadCorners`, `num` (Task 2).
- Produces:
  - `function addUnderline(doc, page, opts: MarkupOptions): MarkupAnnotation`
  - `function addStrikeOut(doc, page, opts: MarkupOptions): MarkupAnnotation`
  - `function addSquiggly(doc, page, opts: MarkupOptions): MarkupAnnotation`
  - `Page.AddUnderline`/`AddStrikeOut`/`AddSquiggly(opts: MarkupOptions): MarkupAnnotation`

- [ ] **Step 1: Write the failing test**

In `test/annotation.test.ts`, append:

```ts
describe('Page.AddUnderline / AddStrikeOut / AddSquiggly', () => {
  function apOps(doc: Document, m: MarkupAnnotation): string[] {
    const ap = doc.resolve(m.Dict.get('AP')) as Map<string, any>;
    const n = doc.resolve(ap.get('N')) as any;
    expect(isStream(n)).toBe(true);
    return parseContentStream(n.raw).map((o) => o.operator);
  }

  const quads = [10, 40, 60, 40, 10, 30, 60, 30];

  it('AddUnderline creates an /Underline with a stroked-line appearance (black default)', () => {
    const doc = Document.Open(buildBlankPage());
    const m = doc.Pages[0].AddUnderline({ quads });
    expect(m.Subtype).toBe('Underline');
    expect(m.MarkupType).toBe('underline');
    expect(m.Color).toEqual([0, 0, 0]);                // default black
    const ops = apOps(doc, m);
    expect(ops).toContain('S');                        // stroke
    expect(ops).not.toContain('f');                    // not a fill
  });

  it('AddStrikeOut creates a /StrikeOut with a stroked-line appearance', () => {
    const doc = Document.Open(buildBlankPage());
    const m = doc.Pages[0].AddStrikeOut({ quads });
    expect(m.Subtype).toBe('StrikeOut');
    expect(m.MarkupType).toBe('strikeout');
    expect(apOps(doc, m)).toContain('S');
  });

  it('AddSquiggly creates a /Squiggly with a multi-segment stroked path', () => {
    const doc = Document.Open(buildBlankPage());
    const m = doc.Pages[0].AddSquiggly({ quads });
    expect(m.Subtype).toBe('Squiggly');
    expect(m.MarkupType).toBe('squiggly');
    const ap = doc.resolve(m.Dict.get('AP')) as Map<string, any>;
    const n = doc.resolve(ap.get('N')) as any;
    const lineCount = parseContentStream(n.raw).filter((o) => o.operator === 'l').length;
    expect(lineCount).toBeGreaterThan(1);              // zig-zag has multiple segments
  });

  it('round-trips an underline through Save/Open', () => {
    const doc = Document.Open(buildBlankPage());
    doc.Pages[0].AddUnderline({ quads, color: [1, 0, 0] });
    const reopened = Document.Open(doc.Save());
    const m = reopened.Pages[0].Annotations[0] as MarkupAnnotation;
    expect(m).toBeInstanceOf(MarkupAnnotation);
    expect(m.MarkupType).toBe('underline');
    expect(m.Color).toEqual([1, 0, 0]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/annotation.test.ts`
Expected: FAIL — `page.AddUnderline is not a function`.

- [ ] **Step 3: Add the three draw routines and `add*` functions**

In `src/annotation.ts`, append after `addHighlight`:

```ts
/** Per-quad geometry: left/right x span, bottom y, and quad height. */
function quadSpan(q: QuadCorners): { xl: number; xr: number; yb: number; h: number } {
  const xl = Math.min(q.x1, q.x2, q.x3, q.x4);
  const xr = Math.max(q.x1, q.x2, q.x3, q.x4);
  const yb = Math.min(q.y1, q.y2, q.y3, q.y4);
  const yt = Math.max(q.y1, q.y2, q.y3, q.y4);
  return { xl, xr, yb, h: yt - yb };
}

/** Stroke a horizontal line across each quad at fractional height `frac`
 *  (0 = bottom, 0.5 = middle), with width proportional to quad height. */
function strokeLines(qs: QuadCorners[], color: [number, number, number], frac: number): string {
  const [r, g, b] = color;
  let s = `${num(r)} ${num(g)} ${num(b)} RG\n`;
  for (const q of qs) {
    const { xl, xr, yb, h } = quadSpan(q);
    const lw = Math.max(0.5, h * 0.06);
    const y = yb + h * frac + (frac === 0 ? lw : 0);
    s += `${num(lw)} w ${num(xl)} ${num(y)} m ${num(xr)} ${num(y)} l S\n`;
  }
  return s;
}

/** Stroke a zig-zag along the bottom of each quad. */
function drawSquiggly(qs: QuadCorners[], color: [number, number, number]): string {
  const [r, g, b] = color;
  let s = `${num(r)} ${num(g)} ${num(b)} RG\n`;
  for (const q of qs) {
    const { xl, xr, yb, h } = quadSpan(q);
    const amp = Math.max(1, h * 0.1);
    const step = Math.max(2, amp);
    const lw = Math.max(0.5, h * 0.04);
    s += `${num(lw)} w ${num(xl)} ${num(yb)} m\n`;
    let up = true;
    for (let x = xl + step; x < xr; x += step) {
      s += `${num(x)} ${num(up ? yb + amp : yb)} l\n`;
      up = !up;
    }
    s += `${num(xr)} ${num(yb)} l S\n`;
  }
  return s;
}

/** Build and attach an /Underline markup annotation to `page`. */
export function addUnderline(doc: Document, page: Page, opts: MarkupOptions): MarkupAnnotation {
  return addMarkup(doc, page, 'Underline', opts, (qs, c) => strokeLines(qs, c, 0));
}

/** Build and attach a /StrikeOut markup annotation to `page`. */
export function addStrikeOut(doc: Document, page: Page, opts: MarkupOptions): MarkupAnnotation {
  return addMarkup(doc, page, 'StrikeOut', opts, (qs, c) => strokeLines(qs, c, 0.5));
}

/** Build and attach a /Squiggly markup annotation to `page`. */
export function addSquiggly(doc: Document, page: Page, opts: MarkupOptions): MarkupAnnotation {
  return addMarkup(doc, page, 'Squiggly', opts, drawSquiggly);
}
```

- [ ] **Step 4: Add the three `Page` methods**

In `src/page.ts`, extend the `./annotation.js` import to add the three builders:

```ts
import {
  Annotation, wrapAnnotation, addTextNote, TextAnnotation, TextNoteOptions,
  addStamp, StampAnnotation, StampAnnotationOptions,
  addHighlight, addUnderline, addStrikeOut, addSquiggly, MarkupAnnotation, MarkupOptions,
} from './annotation.js';
```

Add immediately after `AddHighlight`:

```ts
  /** Add an /Underline markup annotation over the given /QuadPoints. */
  AddUnderline(opts: MarkupOptions): MarkupAnnotation {
    return addUnderline(this.doc, this, opts);
  }

  /** Add a /StrikeOut markup annotation over the given /QuadPoints. */
  AddStrikeOut(opts: MarkupOptions): MarkupAnnotation {
    return addStrikeOut(this.doc, this, opts);
  }

  /** Add a /Squiggly markup annotation over the given /QuadPoints. */
  AddSquiggly(opts: MarkupOptions): MarkupAnnotation {
    return addSquiggly(this.doc, this, opts);
  }
```

- [ ] **Step 5: Update the README**

In `README.md`, after the `page.AddHighlight(opts)` row, add:

```
| `page.AddUnderline(opts)` | Add an `/Underline` markup over `/QuadPoints` |
| `page.AddStrikeOut(opts)` | Add a `/StrikeOut` markup over `/QuadPoints` |
| `page.AddSquiggly(opts)` | Add a `/Squiggly` (wavy underline) markup over `/QuadPoints` |
```

- [ ] **Step 6: Run typecheck, full suite, and build**

Run: `npm run typecheck` — Expected: no errors.
Run: `npx vitest run test/annotation.test.ts` — Expected: PASS.
Run: `npm test` — Expected: full suite green.
Run: `npm run build` — Expected: clean build.

- [ ] **Step 7: Commit**

```bash
git add src/annotation.ts src/page.ts README.md test/annotation.test.ts
git commit -m "feat: Page.AddUnderline/AddStrikeOut/AddSquiggly markup annotations

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Notes / follow-ups

- **Highlight opacity:** when `opacity` is omitted, the fill is fully opaque (it covers the underlying text). Blend modes are a Phase 3 non-goal; pass `opacity` (e.g. `0.4`) for a readable highlight. Documented limitation from the design spec's Module C.
- **QuadPoints order:** drawing assumes the PDF 32000 corner order (1=TL, 2=TR, 3=BL, 4=BR). The fill polygon and the bbox are robust to swapped top/bottom because they min/max over all corners; the squiggly/underline use the quad's own min/max y.
- **`/CA` mirroring:** opacity is written both to the annotation `/CA` (queryable, honored by viewers) and to a per-form `/ExtGState` so the appearance stream itself is semi-transparent.
- Remaining Phase 3 leaves after this: `c9p` (links), `rwn`/`82q` (XMP). Links reuse `createAnnotation` but need no `/AP`.

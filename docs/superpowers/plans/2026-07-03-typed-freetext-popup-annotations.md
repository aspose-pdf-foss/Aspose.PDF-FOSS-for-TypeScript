# Typed FreeText + Popup Annotations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add typed handle classes, `Page.Add*` create APIs, live accessors, and generated `/AP` appearance for `/FreeText` (including callout leaders) and `/Popup` annotations, mirroring the Line/Square/Circle patterns from i1p sub-issue 1.

**Architecture:** New `FreeTextAnnotation` and `PopupAnnotation` subclasses of `Annotation` in `src/annotation.ts`; `addFreeText`/`addPopup` create functions with validate-before-attach; a shared `wrapTextBody` helper exported from `src/appearance.ts`; auto-popup centralized in the existing `createAnnotation` via a new `BaseAnnotInit.popup` field. Thin `Page.AddFreeText`/`AddPopup` wrappers.

**Tech Stack:** TypeScript (ESM, NodeNext, strict), vitest. Zero runtime deps (only `node:` built-ins).

## Global Constraints

- Zero runtime dependencies — only `node:` built-ins. Do not add npm runtime deps.
- ESM + NodeNext: all relative imports carry a `.js` extension.
- Appearance uses Standard-14 Helvetica only; `/DA` font resource name is `Helv`, matching the form/appearance layer.
- Validate-before-attach: validate every input before allocating or attaching any object to `/Annots`.
- Errors: throw `TypeError`/`RangeError` for bad inputs; `UnsupportedFeatureError` (from `errors.js`) for structurally-unreferenceable parents.
- Border is a solid width only (no `/BS /D`, `/BE`). No rich text (`/RS`,`/DS`,`/Rich`).
- Run `npm run typecheck` and `npm test` green before closing the issue.
- `PdfDict` is a `Map` keyed by name without leading `/`; tagged objects via `name()`, `{ kind: 'string', bytes }`, `ref()`.

---

### Task 1: `FreeTextAnnotation` handle + dispatch + read/setter tests

**Files:**
- Modify: `src/annotation.ts` (add class after `LineAnnotation`, ~line 362; add import of `parseDA`, `enc`, `PdfRef`/`isRef`, `UnsupportedFeatureError`; add `wrapAnnotation` case)
- Modify: `test/helpers/build-annot-target.ts` (add `buildFreeTextReadTarget`)
- Test: `test/annotation.test.ts`

**Interfaces:**
- Consumes: base `Annotation`, `readBorderWidth`/`setBorderWidth`, `numArray`, `checkNums`, `LineEnding`/`LINE_ENDINGS`, `parseDA` (from `da.js`), `enc` (from `serialize.js`).
- Produces: `class FreeTextAnnotation extends Annotation` with accessors `Alignment: 'left'|'center'|'right'`, `FontSize: number`, `TextColor: [number,number,number]`, `BorderWidth: number`, `InteriorColor: [number,number,number]|undefined`, `Intent: string|undefined`, `CalloutLine: number[]|undefined`, `CalloutEnding: LineEnding|undefined`. Internal `buildDA(fontName,size,color): PdfObject`.

- [ ] **Step 1: Write the failing test**

Add `buildFreeTextReadTarget` to `test/helpers/build-annot-target.ts`:

```ts
/** One page carrying a /FreeText annotation with DA, Q, IC, BS, CL, LE, IT. */
export function buildFreeTextReadTarget(): Uint8Array {
  const objects: string[] = [];
  objects[1] = `<< /Type /Catalog /Pages 2 0 R >>`;
  objects[2] = `<< /Type /Pages /Count 1 /Kids [3 0 R] /MediaBox [0 0 300 200] >>`;
  objects[3] = `<< /Type /Page /Parent 2 0 R /Annots [4 0 R] >>`;
  objects[4] = `<< /Type /Annot /Subtype /FreeText /Rect [20 20 160 90] ` +
    `/Contents (note) /DA (/Helv 14 Tf 1 0 0 rg) /Q 1 /IC [0.9 0.9 0.9] ` +
    `/BS << /Type /Border /W 2 >> /IT /FreeTextCallout ` +
    `/CL [30 30 60 60 100 80] /LE /OpenArrow /F 4 >>`;
  return assemble(objects, 4, 1);
}
```

Add to `test/annotation.test.ts` (import `FreeTextAnnotation` from `../src/annotation.js` and `buildFreeTextReadTarget` from the helper):

```ts
describe('FreeText read model + setters', () => {
  it('reads FreeText entries as typed accessors', () => {
    const doc = Document.Open(buildFreeTextReadTarget());
    const ft = doc.Pages[0].Annotations[0] as FreeTextAnnotation;
    expect(ft).toBeInstanceOf(FreeTextAnnotation);
    expect(ft.Subtype).toBe('FreeText');
    expect(ft.Contents).toBe('note');
    expect(ft.Alignment).toBe('center');
    expect(ft.FontSize).toBe(14);
    expect(ft.TextColor).toEqual([1, 0, 0]);
    expect(ft.BorderWidth).toBe(2);
    expect(ft.InteriorColor).toEqual([0.9, 0.9, 0.9]);
    expect(ft.Intent).toBe('FreeTextCallout');
    expect(ft.CalloutLine).toEqual([30, 30, 60, 60, 100, 80]);
    expect(ft.CalloutEnding).toBe('OpenArrow');
  });

  it('round-trips setters and preserves the other /DA parts', () => {
    const doc = Document.Open(buildFreeTextReadTarget());
    const ft = doc.Pages[0].Annotations[0] as FreeTextAnnotation;
    ft.Alignment = 'right';
    expect(ft.Alignment).toBe('right');
    ft.FontSize = 20;
    expect(ft.FontSize).toBe(20);
    expect(ft.TextColor).toEqual([1, 0, 0]); // unchanged by FontSize set
    ft.TextColor = [0, 0, 1];
    expect(ft.TextColor).toEqual([0, 0, 1]);
    expect(ft.FontSize).toBe(20);            // unchanged by TextColor set
    ft.InteriorColor = undefined;
    expect(ft.InteriorColor).toBeUndefined();
    ft.CalloutEnding = undefined;
    expect(ft.CalloutEnding).toBeUndefined();
    expect(() => { ft.TextColor = [2, 0, 0]; }).toThrow(TypeError);
    expect(() => { ft.CalloutLine = [1, 2, 3]; }).toThrow(TypeError);
    expect(() => { ft.CalloutEnding = 'Nope' as any; }).toThrow(TypeError);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/annotation.test.ts -t "FreeText read model"`
Expected: FAIL — `FreeTextAnnotation` is not exported / not a constructor.

- [ ] **Step 3: Write minimal implementation**

In `src/annotation.ts`, extend the imports:

```ts
import { PdfDict, PdfObject, PdfRef, PdfStream, isArray, isDict, isName, isRef, isString, name, ref } from './types.js';
```
```ts
import { serializeString, enc } from './serialize.js';
import { parseDA } from './da.js';
import { UnsupportedFeatureError } from './errors.js';
```
(Keep existing imports; add only the missing names — `PdfRef`, `isRef`, `ref` to the types import; `enc` to the serialize import; the two new import lines.)

Add after `LineAnnotation` (after line ~362):

```ts
/** Build a /DA PDF string `/<font> <size> Tf r g b rg` (ASCII/latin1). */
function buildDA(fontName: string, size: number, color: [number, number, number]): PdfObject {
  const [r, g, b] = color;
  return { kind: 'string', bytes: enc(`/${fontName} ${num(size)} Tf ${num(r)} ${num(g)} ${num(b)} rg`) };
}

/** A /FreeText annotation: text drawn directly on the page, optionally with a
 *  callout leader line (/CL, /IT FreeTextCallout, /LE ending). */
export class FreeTextAnnotation extends Annotation {
  /** Parsed /DA (font resource name, size, color); Helvetica/0/black default. */
  private da(): { fontName: string; size: number; color: [number, number, number] } {
    const s = this.doc.resolve(this.Dict.get('DA'));
    return parseDA(isString(s) ? new TextDecoder('latin1').decode(s.bytes) : '');
  }

  /** /Q text justification as 'left' | 'center' | 'right' (0/1/2). */
  get Alignment(): 'left' | 'center' | 'right' {
    const q = this.doc.resolve(this.Dict.get('Q'));
    return q === 1 ? 'center' : q === 2 ? 'right' : 'left';
  }

  set Alignment(v: 'left' | 'center' | 'right') {
    this.touch();
    this.Dict.set('Q', v === 'center' ? 1 : v === 'right' ? 2 : 0);
  }

  /** /DA font size (0 = auto). */
  get FontSize(): number { return this.da().size; }

  set FontSize(v: number) {
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) throw new TypeError('FontSize must be a non-negative finite number');
    this.touch();
    const d = this.da();
    this.Dict.set('DA', buildDA(d.fontName, v, d.color));
  }

  /** /DA fill color [r,g,b] in 0..1. */
  get TextColor(): [number, number, number] { return this.da().color; }

  set TextColor(v: [number, number, number]) {
    const c = checkNums('TextColor', v, 3);
    if (c.some((x) => x < 0 || x > 1)) throw new TypeError('TextColor components must be in 0..1');
    this.touch();
    const d = this.da();
    this.Dict.set('DA', buildDA(d.fontName, d.size, [c[0], c[1], c[2]]));
  }

  /** Border width from /BS /W; 1 when absent. */
  get BorderWidth(): number { return readBorderWidth(this.doc, this.Dict); }
  set BorderWidth(v: number) { setBorderWidth(this.Dict, v); this.touch(); }

  /** /IC interior (box background) color [r,g,b] in 0..1; undefined when absent. */
  get InteriorColor(): [number, number, number] | undefined {
    const c = numArray(this.doc, this.Dict.get('IC'), 3);
    return c ? [c[0], c[1], c[2]] : undefined;
  }

  set InteriorColor(v: [number, number, number] | undefined) {
    this.touch();
    if (v === undefined) { this.Dict.delete('IC'); return; }
    const c = checkNums('InteriorColor', v, 3);
    if (c.some((x) => x < 0 || x > 1)) throw new TypeError('InteriorColor components must be in 0..1');
    this.Dict.set('IC', c);
  }

  /** /IT intent name; undefined when absent. */
  get Intent(): string | undefined {
    const n = this.Dict.get('IT');
    return isName(n) ? n.name : undefined;
  }

  set Intent(v: string | undefined) {
    this.touch();
    if (v === undefined) { this.Dict.delete('IT'); return; }
    if (typeof v !== 'string') throw new TypeError('Intent must be a string');
    this.Dict.set('IT', name(v));
  }

  /** /CL callout line: 4 or 6 finite numbers; undefined when absent/malformed. */
  get CalloutLine(): number[] | undefined {
    const a = this.doc.resolve(this.Dict.get('CL'));
    if (!isArray(a) || (a.length !== 4 && a.length !== 6)) return undefined;
    const out: number[] = [];
    for (const e of a) { const v = this.doc.resolve(e); if (typeof v !== 'number') return undefined; out.push(v); }
    return out;
  }

  set CalloutLine(v: number[] | undefined) {
    this.touch();
    if (v === undefined) { this.Dict.delete('CL'); return; }
    if (!Array.isArray(v) || (v.length !== 4 && v.length !== 6) || !v.every((x) => typeof x === 'number' && Number.isFinite(x)))
      throw new TypeError('CalloutLine must be 4 or 6 finite numbers');
    this.Dict.set('CL', [...v]);
  }

  /** /LE single line-ending name; undefined when absent. */
  get CalloutEnding(): LineEnding | undefined {
    const le = this.doc.resolve(this.Dict.get('LE'));
    return isName(le) ? (le.name as LineEnding) : undefined;
  }

  set CalloutEnding(v: LineEnding | undefined) {
    this.touch();
    if (v === undefined) { this.Dict.delete('LE'); return; }
    if (!LINE_ENDINGS.has(v)) throw new TypeError('CalloutEnding must be a supported ending name');
    this.Dict.set('LE', name(v));
  }
}
```

Add the dispatch case in `wrapAnnotation` (in the `switch`):

```ts
    case 'FreeText': return new FreeTextAnnotation(doc, dict);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/annotation.test.ts -t "FreeText read model"`
Expected: PASS (both `it` blocks).

- [ ] **Step 5: Typecheck + commit**

```bash
npm run typecheck
git add src/annotation.ts test/helpers/build-annot-target.ts test/annotation.test.ts
git commit -m "feat(ur5): FreeTextAnnotation typed handle + accessors"
```

---

### Task 2: `PopupAnnotation` handle + dispatch + read tests

**Files:**
- Modify: `src/annotation.ts` (add class + `wrapAnnotation` case)
- Modify: `test/helpers/build-annot-target.ts` (add `buildPopupReadTarget`)
- Test: `test/annotation.test.ts`

**Interfaces:**
- Consumes: base `Annotation`, `wrapAnnotation`, `TextAnnotation.Open` pattern.
- Produces: `class PopupAnnotation extends Annotation` with `Open: boolean` and `Parent: Annotation | undefined`.

- [ ] **Step 1: Write the failing test**

Add to `test/helpers/build-annot-target.ts`:

```ts
/** One page carrying a /Text markup and its linked /Popup companion. */
export function buildPopupReadTarget(): Uint8Array {
  const objects: string[] = [];
  objects[1] = `<< /Type /Catalog /Pages 2 0 R >>`;
  objects[2] = `<< /Type /Pages /Count 1 /Kids [3 0 R] /MediaBox [0 0 300 200] >>`;
  objects[3] = `<< /Type /Page /Parent 2 0 R /Annots [4 0 R 5 0 R] >>`;
  objects[4] = `<< /Type /Annot /Subtype /Text /Rect [10 20 30 40] /Contents (hi) /Popup 5 0 R /F 4 >>`;
  objects[5] = `<< /Type /Annot /Subtype /Popup /Rect [40 20 240 120] /Parent 4 0 R /Open true >>`;
  return assemble(objects, 5, 1);
}
```

Add to `test/annotation.test.ts` (import `PopupAnnotation`, `TextAnnotation` already imported, `buildPopupReadTarget`):

```ts
describe('Popup read model', () => {
  it('reads /Open and resolves a typed /Parent handle', () => {
    const doc = Document.Open(buildPopupReadTarget());
    const popup = doc.Pages[0].Annotations[1] as PopupAnnotation;
    expect(popup).toBeInstanceOf(PopupAnnotation);
    expect(popup.Subtype).toBe('Popup');
    expect(popup.Open).toBe(true);
    expect(popup.Parent).toBeInstanceOf(TextAnnotation);
    expect(popup.Parent!.Subtype).toBe('Text');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/annotation.test.ts -t "Popup read model"`
Expected: FAIL — `PopupAnnotation` not exported.

- [ ] **Step 3: Write minimal implementation**

In `src/annotation.ts`, add after `FreeTextAnnotation`:

```ts
/** A /Popup annotation: a companion window bound to a parent markup via /Parent
 *  (the parent carries /Popup back). No appearance stream. */
export class PopupAnnotation extends Annotation {
  /** /Open: whether the popup is initially displayed open. false when absent. */
  get Open(): boolean {
    return this.doc.resolve(this.Dict.get('Open')) === true;
  }

  set Open(v: boolean) {
    if (typeof v !== 'boolean') throw new TypeError('Open must be a boolean');
    this.Dict.set('Open', v);
    this.touch();
  }

  /** The parent markup annotation this popup belongs to (/Parent), as a typed
   *  handle; undefined when absent. */
  get Parent(): Annotation | undefined {
    const p = this.doc.resolve(this.Dict.get('Parent'));
    return isDict(p) ? wrapAnnotation(this.doc, p as PdfDict) : undefined;
  }
}
```

Add the dispatch case in `wrapAnnotation`:

```ts
    case 'Popup': return new PopupAnnotation(doc, dict);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/annotation.test.ts -t "Popup read model"`
Expected: PASS.

- [ ] **Step 5: Typecheck + commit**

```bash
npm run typecheck
git add src/annotation.ts test/helpers/build-annot-target.ts test/annotation.test.ts
git commit -m "feat(ur5): PopupAnnotation typed handle"
```

---

### Task 3: `wrapTextBody` helper + `addFreeText` (no callout) + `Page.AddFreeText`

**Files:**
- Modify: `src/appearance.ts` (export `wrapTextBody`)
- Modify: `src/annotation.ts` (add `FreeTextOptions`, `addFreeText`, box-body helper)
- Modify: `src/page.ts` (add `AddFreeText`)
- Test: `test/annotation.test.ts`

**Interfaces:**
- Consumes: `buildAppearanceXObject`, `installShapeAP`, `widgetGeom`, `WidgetGeom`, `checkOptColor`, `checkOptWidth`, `checkOptOpacity`, `createAnnotation`, `wrapLines`/`measure`/`PAD`/`encodeWinAnsi` (inside appearance.ts).
- Produces:
  - `export function wrapTextBody(text: string, std: StdFont, size: number, color: [number,number,number], boxW: number, boxH: number, inset: number, align: 'left'|'center'|'right'): string`
  - `export interface FreeTextOptions { rect; contents; fontSize?; textColor?; align?; color?; fill?; width?; callout?; calloutEnding?; opacity?; popup? }`
  - `export function addFreeText(doc, page, opts): FreeTextAnnotation`
  - `Page.AddFreeText(opts): FreeTextAnnotation`
  - internal `freeTextBoxBody(w, h, contents, fontSize, textColor, align, color, fill, width): string`

- [ ] **Step 1: Write the failing test**

Add to `test/annotation.test.ts`:

```ts
describe('Page.AddFreeText (no callout)', () => {
  function apOps(doc: Document, annot: Annotation): string[] {
    const ap = doc.resolve(annot.Dict.get('AP')) as Map<string, any>;
    const n = doc.resolve(ap.get('N'));
    expect(isStream(n)).toBe(true);
    return parseContentStream((n as any).raw).map((o) => o.operator);
  }

  it('creates a /FreeText box with /DA, /Q, /IC and a text appearance', () => {
    const doc = Document.Open(buildBlankPage());
    const page = doc.Pages[0];
    const ft = page.AddFreeText({
      rect: [20, 20, 180, 90], contents: 'hello world from a wrapped note',
      fontSize: 12, textColor: [0, 0, 1], align: 'center', fill: [0.9, 0.9, 0.9], width: 1,
    });
    expect(ft).toBeInstanceOf(FreeTextAnnotation);
    expect(ft.Subtype).toBe('FreeText');
    expect(ft.Alignment).toBe('center');
    expect(ft.FontSize).toBe(12);
    expect(ft.TextColor).toEqual([0, 0, 1]);
    expect(ft.InteriorColor).toEqual([0.9, 0.9, 0.9]);
    expect(page.Annotations).toHaveLength(1);

    const ops = apOps(doc, ft);
    expect(ops).toContain('Tj'); // text drawn
    expect(ops).toContain('re'); // border/fill rect
  });

  it('applies opacity via /GS0 and validates before attaching', () => {
    const doc = Document.Open(buildBlankPage());
    const page = doc.Pages[0];
    const ft = page.AddFreeText({ rect: [0, 0, 100, 40], contents: 'x', opacity: 0.5 });
    const ap = doc.resolve(ft.Dict.get('AP')) as Map<string, any>;
    expect(new TextDecoder().decode((doc.resolve(ap.get('N')) as any).raw)).toContain('gs');

    expect(() => page.AddFreeText({ rect: [0, 0, 10, 10], contents: '' })).toThrow(TypeError);
    expect(() => page.AddFreeText({ rect: [0, 0, 10, 10], contents: 'x', textColor: [2, 0, 0] })).toThrow(TypeError);
    expect(page.Annotations).toHaveLength(1); // nothing stranded
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/annotation.test.ts -t "AddFreeText (no callout)"`
Expected: FAIL — `page.AddFreeText` is not a function.

- [ ] **Step 3a: Add `wrapTextBody` to `src/appearance.ts`**

Add (exported) near the other text helpers (after `wrapLines`):

```ts
/** Body ops for wrapped, aligned text in a box, top-anchored. `inset` is a
 *  border inset applied on all sides; alignment positions each line by measure. */
export function wrapTextBody(
  text: string, std: StdFont, size: number, color: [number, number, number],
  boxW: number, boxH: number, inset: number, align: 'left' | 'center' | 'right',
): string {
  const words = text.split(/\s+/).filter((w) => w.length > 0);
  const maxW = boxW - 2 * (PAD + inset);
  const leading = size * 1.15;
  const lines = wrapLines(words, std, size, maxW);
  const [r, g, b] = color;
  const top = boxH - inset - PAD - size * 0.8;
  let s = `BT\n/Helv ${num(size)} Tf\n${num(r)} ${num(g)} ${num(b)} rg\n`;
  let prevX = 0, prevY = 0;
  lines.forEach((ln, i) => {
    const bytes = encodeWinAnsi(ln);
    const tw = measure(std, bytes, size);
    let x = PAD + inset;
    if (align === 'center') x = inset + (boxW - 2 * inset - tw) / 2;
    else if (align === 'right') x = boxW - inset - PAD - tw;
    if (x < inset + PAD) x = inset + PAD;
    const y = top - i * leading;
    s += `${num(x - prevX)} ${num(y - prevY)} Td\n${serializeString(bytes)} Tj\n`;
    prevX = x; prevY = y;
  });
  return s + 'ET';
}
```

- [ ] **Step 3b: Add FreeText create code to `src/annotation.ts`**

Add import of the helper:

```ts
import { widgetGeom, buildAppearanceXObject, installAP, wrapTextBody, type WidgetGeom } from './appearance.js';
```
(extend the existing `./appearance.js` import — add `wrapTextBody`.)

Add a validation helper and box-body helper near the other `checkOpt*` helpers:

```ts
/** Validate a /CL callout: 4 or 6 finite numbers; returns a defensive copy. */
function checkCallout(v: number[]): number[] {
  if (!Array.isArray(v) || (v.length !== 4 && v.length !== 6) ||
      !v.every((x) => typeof x === 'number' && Number.isFinite(x)))
    throw new TypeError('callout must be 4 or 6 finite numbers');
  return [...v];
}

/** Body for a text box of size w×h at the origin: optional fill, optional inset
 *  border stroke, then wrapped/aligned text (text inset by the border width). */
function freeTextBoxBody(
  w: number, h: number, contents: string, fontSize: number,
  textColor: [number, number, number], align: 'left' | 'center' | 'right',
  color: [number, number, number], fill: [number, number, number] | undefined, width: number,
): string {
  let s = '';
  if (fill) s += `${num(fill[0])} ${num(fill[1])} ${num(fill[2])} rg\n0 0 ${num(w)} ${num(h)} re f\n`;
  if (width > 0) {
    const half = width / 2;
    s += `${num(color[0])} ${num(color[1])} ${num(color[2])} RG\n${num(width)} w\n` +
      `${num(half)} ${num(half)} ${num(w - width)} ${num(h - width)} re S\n`;
  }
  s += wrapTextBody(contents, 'Helvetica', fontSize, textColor, w, h, width, align);
  return s;
}
```

Add the options interface and create function (place after `addLine`, before `LinkOptions`):

```ts
/** Options for Page.AddFreeText. */
export interface FreeTextOptions {
  rect: [number, number, number, number];
  /** Displayed text (required, non-empty). */
  contents: string;
  /** /DA font size. Default 12. */
  fontSize?: number;
  /** /DA text fill color, RGB 0..1. Default black [0,0,0]. */
  textColor?: [number, number, number];
  /** /Q alignment. Default 'left'. */
  align?: 'left' | 'center' | 'right';
  /** Border /C color, RGB 0..1. Default black [0,0,0]. */
  color?: [number, number, number];
  /** Box interior /IC fill, RGB 0..1. Omitted → no fill. */
  fill?: [number, number, number];
  /** Border /BS /W width. Default 1. */
  width?: number;
  /** /CL callout leader: 4 or 6 numbers in page space (first point is the tip). */
  callout?: number[];
  /** /LE ending at the callout tip. Default 'OpenArrow' when a callout is set. */
  calloutEnding?: LineEnding;
  /** /CA constant opacity, 0..1. */
  opacity?: number;
  /** Auto-attach a companion /Popup. */
  popup?: PopupSpec;
}

/** Build and attach a /FreeText annotation to `page`. Callout handling lands in
 *  a later step; this creates the plain text box. */
export function addFreeText(doc: Document, page: Page, opts: FreeTextOptions): FreeTextAnnotation {
  if (typeof opts.contents !== 'string' || opts.contents.length === 0)
    throw new TypeError('contents must be a non-empty string');
  const rect = checkNums('rect', opts.rect, 4);
  const fontSize = opts.fontSize ?? 12;
  if (typeof fontSize !== 'number' || !Number.isFinite(fontSize) || fontSize <= 0)
    throw new TypeError('fontSize must be a positive finite number');
  const textColor = checkOptColor('textColor', opts.textColor) ?? [0, 0, 0];
  const color = checkOptColor('color', opts.color) ?? [0, 0, 0];
  const fill = checkOptColor('fill', opts.fill);
  const width = checkOptWidth(opts.width);
  const opacity = checkOptOpacity(opts.opacity);
  const align = opts.align ?? 'left';
  if (align !== 'left' && align !== 'center' && align !== 'right')
    throw new TypeError("align must be 'left', 'center', or 'right'");

  const dict = createAnnotation(doc, page, {
    subtype: 'FreeText', rect: [rect[0], rect[1], rect[2], rect[3]], color, contents: opts.contents,
    popup: opts.popup,
  });
  const annot = new FreeTextAnnotation(doc, dict);
  dict.set('DA', buildDA('Helv', fontSize, textColor));
  annot.Alignment = align;
  setBorderWidth(dict, width);
  if (fill) annot.InteriorColor = fill;
  if (opacity !== undefined) annot.Opacity = opacity;
  const half = width / 2;
  dict.set('RD', [half, half, half, half]);

  const g = widgetGeom(doc, dict);
  if (g) {
    const body = freeTextBoxBody(g.w, g.h, opts.contents, fontSize, textColor, align, color, fill, width);
    installShapeAP(doc, dict, g, body, opacity ?? 1);
  }
  return annot;
}
```

> Note: `FreeTextOptions.popup` references `PopupSpec`, defined in Task 5. To keep Task 3 self-contained and compiling, add the `PopupSpec` interface now (it is inert until Task 5/6 wire it):
> ```ts
> /** Popup placement for AddPopup / auto-popup. */
> export interface PopupSpec { rect?: [number, number, number, number]; open?: boolean }
> ```
> Place it just above `FreeTextOptions`. Also add `popup?: PopupSpec` to `BaseAnnotInit` now and have `createAnnotation` validate it early (`if (init.popup?.rect !== undefined) checkNums('popup rect', init.popup.rect, 4);`) — the attach call is added in Task 5. This keeps every task compiling.

- [ ] **Step 3c: Add `Page.AddFreeText` to `src/page.ts`**

Add to the annotation imports from `./annotation.js`: `addFreeText`, `FreeTextAnnotation`, `type FreeTextOptions`. Add the method near `AddLine`:

```ts
  /** Add a /FreeText annotation: text drawn on the page, optionally with a callout. */
  AddFreeText(opts: FreeTextOptions): FreeTextAnnotation {
    return addFreeText(this.doc, this, opts);
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/annotation.test.ts -t "AddFreeText (no callout)"`
Expected: PASS.

- [ ] **Step 5: Typecheck + commit**

```bash
npm run typecheck
git add src/appearance.ts src/annotation.ts src/page.ts test/annotation.test.ts
git commit -m "feat(ur5): AddFreeText plain text box + wrapTextBody helper"
```

---

### Task 4: FreeText callout leader (`/CL`, `/LE`, `/IT`, `/RD`, arrowhead)

**Files:**
- Modify: `src/annotation.ts` (`addFreeText` callout branch)
- Test: `test/annotation.test.ts`

**Interfaces:**
- Consumes: `drawEnding` (private in annotation.ts), `freeTextBoxBody`, `installShapeAP`, `WidgetGeom`, `LINE_ENDINGS`.
- Produces: `addFreeText` handles `opts.callout`; sets `/CL`, `/LE`, `/IT FreeTextCallout`, enlarged `/Rect` + `/RD`; appearance strokes the leader + arrowhead.

- [ ] **Step 1: Write the failing test**

Add to `test/annotation.test.ts`:

```ts
describe('Page.AddFreeText (callout)', () => {
  function apStr(doc: Document, annot: Annotation): string {
    const ap = doc.resolve(annot.Dict.get('AP')) as Map<string, any>;
    return new TextDecoder().decode((doc.resolve(ap.get('N')) as any).raw);
  }

  it('adds /CL, /LE, /IT and enlarges /Rect to enclose the leader', () => {
    const doc = Document.Open(buildBlankPage());
    const page = doc.Pages[0];
    const ft = page.AddFreeText({
      rect: [120, 120, 260, 180], contents: 'see here',
      callout: [20, 20, 80, 90, 120, 150],
    }) as FreeTextAnnotation;

    expect(ft.CalloutLine).toEqual([20, 20, 80, 90, 120, 150]);
    expect(ft.CalloutEnding).toBe('OpenArrow'); // default when callout set
    expect(ft.Intent).toBe('FreeTextCallout');
    // /Rect grew to include the callout tip at (20,20).
    const [x0, y0] = ft.Rect!;
    expect(x0).toBeLessThan(20);
    expect(y0).toBeLessThan(20);
    // /RD records the padding from /Rect to the text box.
    const rd = doc.resolve(ft.Dict.get('RD')) as number[];
    expect(rd).toHaveLength(4);

    const body = apStr(doc, ft);
    expect(body).toContain('Tj'); // text still drawn
    expect(body).toContain(' l ') || expect(body).toContain('l\n'); // leader stroke
  });

  it('honors an explicit calloutEnding and rejects a bad /CL length', () => {
    const doc = Document.Open(buildBlankPage());
    const page = doc.Pages[0];
    const ft = page.AddFreeText({
      rect: [100, 100, 200, 150], contents: 'x', callout: [10, 10, 100, 120], calloutEnding: 'ClosedArrow',
    }) as FreeTextAnnotation;
    expect(ft.CalloutEnding).toBe('ClosedArrow');
    expect(() => page.AddFreeText({ rect: [0, 0, 50, 50], contents: 'x', callout: [1, 2, 3] })).toThrow(TypeError);
    expect(page.Annotations).toHaveLength(1); // bad call stranded nothing
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/annotation.test.ts -t "AddFreeText (callout)"`
Expected: FAIL — callout is ignored (no `/CL`, `/Rect` unchanged).

- [ ] **Step 3: Implement the callout branch**

Replace the body of `addFreeText` from the `const dict = createAnnotation(...)` line onward with a branch on `callout`. Full replacement of that tail:

```ts
  const callout = opts.callout !== undefined ? checkCallout(opts.callout) : undefined;
  const calloutEnding = callout ? (opts.calloutEnding ?? 'OpenArrow') : opts.calloutEnding;
  if (calloutEnding !== undefined && !LINE_ENDINGS.has(calloutEnding))
    throw new TypeError('calloutEnding must be a supported ending name');

  // Text box in page space (normalized min/max).
  const bx0 = Math.min(rect[0], rect[2]), by0 = Math.min(rect[1], rect[3]);
  const bx1 = Math.max(rect[0], rect[2]), by1 = Math.max(rect[1], rect[3]);

  // /Rect = text box, or its union with the callout points (padded) when set.
  let annotRect: [number, number, number, number] = [bx0, by0, bx1, by1];
  if (callout) {
    const endingSize = Math.max(8, width * 3);
    const margin = Math.max(width, endingSize);
    let mnX = bx0, mnY = by0, mxX = bx1, mxY = by1;
    for (let i = 0; i < callout.length; i += 2) {
      mnX = Math.min(mnX, callout[i] - margin); mxX = Math.max(mxX, callout[i] + margin);
      mnY = Math.min(mnY, callout[i + 1] - margin); mxY = Math.max(mxY, callout[i + 1] + margin);
    }
    annotRect = [mnX, mnY, mxX, mxY];
  }

  const dict = createAnnotation(doc, page, {
    subtype: 'FreeText', rect: annotRect, color, contents: opts.contents, popup: opts.popup,
  });
  const annot = new FreeTextAnnotation(doc, dict);
  dict.set('DA', buildDA('Helv', fontSize, textColor));
  annot.Alignment = align;
  setBorderWidth(dict, width);
  if (fill) annot.InteriorColor = fill;
  if (opacity !== undefined) annot.Opacity = opacity;

  if (callout) {
    annot.CalloutLine = callout;
    if (calloutEnding) annot.CalloutEnding = calloutEnding;
    annot.Intent = 'FreeTextCallout';
    // /RD padding from /Rect to the text box [left, top, right, bottom].
    dict.set('RD', [bx0 - annotRect[0], annotRect[3] - by1, annotRect[2] - bx1, by0 - annotRect[1]]);
  } else {
    const half = width / 2;
    dict.set('RD', [half, half, half, half]);
  }

  const g = widgetGeom(doc, dict);
  if (g) {
    const boxW = bx1 - bx0, boxH = by1 - by0;
    let body: string;
    if (callout) {
      const ox = bx0 - annotRect[0], oy = by0 - annotRect[1]; // text-box offset in BBox
      body = `q 1 0 0 1 ${num(ox)} ${num(oy)} cm\n` +
        freeTextBoxBody(boxW, boxH, opts.contents, fontSize, textColor, align, color, fill, width) + `\nQ\n`;
      // Leader polyline (page → BBox space) stroked, plus a tip arrowhead.
      const p = callout.map((v, i) => (i % 2 === 0 ? v - annotRect[0] : v - annotRect[1]));
      body += `${num(color[0])} ${num(color[1])} ${num(color[2])} RG\n${num(width || 1)} w\n`;
      body += `${num(p[0])} ${num(p[1])} m `;
      for (let i = 2; i < p.length; i += 2) body += `${num(p[i])} ${num(p[i + 1])} l `;
      body += `S\n`;
      if (calloutEnding && calloutEnding !== 'None') {
        const len = Math.hypot(p[0] - p[2], p[1] - p[3]) || 1;
        const dx = (p[0] - p[2]) / len, dy = (p[1] - p[3]) / len; // outward at the tip
        body += drawEnding(p[0], p[1], dx, dy, calloutEnding, Math.max(8, width * 3), color);
      }
    } else {
      body = freeTextBoxBody(g.w, g.h, opts.contents, fontSize, textColor, align, color, fill, width);
    }
    installShapeAP(doc, dict, g, body, opacity ?? 1);
  }
  return annot;
```

(Delete the old no-callout-only tail so the function ends at this single `return annot;`.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/annotation.test.ts -t "AddFreeText"`
Expected: PASS (both no-callout and callout describes).

- [ ] **Step 5: Typecheck + commit**

```bash
npm run typecheck
git add src/annotation.ts test/annotation.test.ts
git commit -m "feat(ur5): FreeText callout leader with arrowhead + /RD"
```

---

### Task 5: `createPopup` + `addPopup` + `Page.AddPopup`

**Files:**
- Modify: `src/annotation.ts` (`PopupOptions`, `createPopup`, `addPopup`, `refForAnnot`)
- Modify: `src/page.ts` (add `AddPopup`)
- Test: `test/annotation.test.ts`

**Interfaces:**
- Consumes: `ownAnnots`, `createAnnotation` (unchanged), `numArray`, `checkNums`, `isRef`, `PdfRef`, `ref`, `UnsupportedFeatureError`, `PopupSpec` (Task 3).
- Produces:
  - `export interface PopupOptions extends PopupSpec { parent: Annotation | PdfDict }`
  - `export function addPopup(doc, page, opts): PopupAnnotation`
  - internal `createPopup(doc, page, parentRef: PdfRef, spec: PopupSpec, parentDict: PdfDict): PopupAnnotation`
  - internal `refForAnnot(doc, page, dict): PdfRef`
  - `Page.AddPopup(opts): PopupAnnotation`

- [ ] **Step 1: Write the failing test**

Add to `test/annotation.test.ts` (uses `buildStampReadTarget` for an existing indirect parent, already importable; or create a stamp then a popup on a blank page):

```ts
describe('Page.AddPopup', () => {
  it('links a popup to its parent both ways', () => {
    const doc = Document.Open(buildBlankPage());
    const page = doc.Pages[0];
    const sq = page.AddSquare({ rect: [10, 10, 90, 60] });
    const popup = page.AddPopup({ parent: sq, rect: [100, 10, 300, 110], open: true });

    expect(popup).toBeInstanceOf(PopupAnnotation);
    expect(popup.Subtype).toBe('Popup');
    expect(popup.Open).toBe(true);
    expect(popup.Dict.has('AP')).toBe(false); // no appearance
    // parent /Popup → popup, popup /Parent → parent (same dict identity)
    expect(doc.resolve(sq.Dict.get('Popup'))).toBe(popup.Dict);
    expect(popup.Parent!.Dict).toBe(sq.Dict);
    expect(page.Annotations).toHaveLength(2);
  });

  it('derives a default rect and rejects a bad rect before attaching', () => {
    const doc = Document.Open(buildBlankPage());
    const page = doc.Pages[0];
    const sq = page.AddSquare({ rect: [10, 10, 90, 60] });
    const popup = page.AddPopup({ parent: sq });
    expect(popup.Rect).toHaveLength(4);
    expect(() => page.AddPopup({ parent: sq, rect: [1, 2, 3] as any })).toThrow(TypeError);
    expect(page.Annotations).toHaveLength(2); // parent + first popup only
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/annotation.test.ts -t "AddPopup"`
Expected: FAIL — `page.AddPopup` is not a function.

- [ ] **Step 3: Implement create/link functions in `src/annotation.ts`**

Add (place after the `PopupAnnotation` class or near the other create functions):

```ts
/** Options for Page.AddPopup. */
export interface PopupOptions extends PopupSpec {
  /** The markup annotation this popup belongs to (an attached, indirect annot). */
  parent: Annotation | PdfDict;
}

/** Default popup rect: a ~200×100 box beside the parent's /Rect (right, top). */
function defaultPopupRect(doc: Document, parentDict: PdfDict): [number, number, number, number] {
  const pr = numArray(doc, parentDict.get('Rect'), 4) ?? [0, 0, 0, 0];
  const x1 = Math.max(pr[0], pr[2]), yTop = Math.max(pr[1], pr[3]);
  return [x1, yTop - 100, x1 + 200, yTop];
}

/** Find the /Annots ref that resolves to `dict` on `page`; throws when `dict`
 *  is not an indirect annotation on this page. */
function refForAnnot(doc: Document, page: Page, dict: PdfDict): PdfRef {
  const arr = doc.resolve(page.Dict.get('Annots'));
  if (isArray(arr)) for (const e of arr) { if (isRef(e) && doc.resolve(e) === dict) return e; }
  throw new UnsupportedFeatureError('popup parent must be an indirect annotation on this page');
}

/** @internal Build a /Popup dict, attach it to the page, link it to its parent
 *  (/Parent → parentRef, parent /Popup → new popup). Validates rect first. */
function createPopup(
  doc: Document, page: Page, parentRef: PdfRef, spec: PopupSpec, parentDict: PdfDict,
): PopupAnnotation {
  const rect = spec.rect !== undefined ? checkNums('popup rect', spec.rect, 4) : defaultPopupRect(doc, parentDict);
  const dict: PdfDict = new Map<string, PdfObject>();
  dict.set('Type', name('Annot'));
  dict.set('Subtype', name('Popup'));
  dict.set('Rect', rect);
  dict.set('Parent', parentRef);
  if (spec.open) dict.set('Open', true);
  const r = doc.allocObject(dict);
  ownAnnots(doc, page).push(r);
  parentDict.set('Popup', r);
  return new PopupAnnotation(doc, dict);
}

/** Build and attach a /Popup annotation bound to `opts.parent`. */
export function addPopup(doc: Document, page: Page, opts: PopupOptions): PopupAnnotation {
  const parentDict = opts.parent instanceof Annotation ? opts.parent.Dict : opts.parent;
  if (!isDict(parentDict)) throw new TypeError('parent must be an annotation dict');
  const parentRef = refForAnnot(doc, page, parentDict);
  return createPopup(doc, page, parentRef, { rect: opts.rect, open: opts.open }, parentDict);
}
```

- [ ] **Step 4a: Add `Page.AddPopup` to `src/page.ts`**

Extend the `./annotation.js` imports with `addPopup`, `PopupAnnotation`, `type PopupOptions`. Add near `AddFreeText`:

```ts
  /** Add a /Popup window bound to an existing markup annotation on this page. */
  AddPopup(opts: PopupOptions): PopupAnnotation {
    return addPopup(this.doc, this, opts);
  }
```

- [ ] **Step 4b: Run test to verify it passes**

Run: `npx vitest run test/annotation.test.ts -t "AddPopup"`
Expected: PASS.

- [ ] **Step 5: Typecheck + commit**

```bash
npm run typecheck
git add src/annotation.ts src/page.ts test/annotation.test.ts
git commit -m "feat(ur5): AddPopup standalone create + parent linkage"
```

---

### Task 6: Auto-popup via `BaseAnnotInit.popup`

**Files:**
- Modify: `src/annotation.ts` (`createAnnotation` attaches popup; add `popup?` to markup-family option interfaces + forward)
- Test: `test/annotation.test.ts`

**Interfaces:**
- Consumes: `createPopup`, `PopupSpec`, `BaseAnnotInit.popup` (validation stub added in Task 3).
- Produces: `createAnnotation` builds a linked popup when `init.popup` is set; `popup?: PopupSpec` on `TextNoteOptions`, `StampAnnotationOptions`, `MarkupOptions`, `SquareCircleOptions`, `LineOptions` (FreeText already has it), each forwarded into its `createAnnotation` call.

- [ ] **Step 1: Write the failing test**

Add to `test/annotation.test.ts`:

```ts
describe('auto-popup option', () => {
  it('AddSquare with popup attaches a linked popup in one call', () => {
    const doc = Document.Open(buildBlankPage());
    const page = doc.Pages[0];
    const sq = page.AddSquare({ rect: [10, 10, 90, 60], popup: { open: true } });
    expect(page.Annotations).toHaveLength(2);
    const popup = page.Annotations.find((a) => a.Subtype === 'Popup') as PopupAnnotation;
    expect(popup).toBeInstanceOf(PopupAnnotation);
    expect(popup.Open).toBe(true);
    expect(popup.Parent!.Dict).toBe(sq.Dict);
    expect(doc.resolve(sq.Dict.get('Popup'))).toBe(popup.Dict);
  });

  it('AddHighlight and AddFreeText also accept popup', () => {
    const doc = Document.Open(buildBlankPage());
    const page = doc.Pages[0];
    page.AddHighlight({ quads: [10, 40, 60, 40, 10, 30, 60, 30], popup: {} });
    page.AddFreeText({ rect: [80, 80, 180, 140], contents: 'x', popup: { rect: [190, 80, 380, 180] } });
    expect(page.Annotations.filter((a) => a.Subtype === 'Popup')).toHaveLength(2);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/annotation.test.ts -t "auto-popup"`
Expected: FAIL — `popup` is not a recognized option / no popup attached.

- [ ] **Step 3a: Attach the popup in `createAnnotation`**

In `createAnnotation`, replace the final lines:

```ts
  const r = doc.allocObject(dict);
  ownAnnots(doc, page).push(r);
  return dict;
```
with:
```ts
  const r = doc.allocObject(dict);
  ownAnnots(doc, page).push(r);
  if (init.popup) createPopup(doc, page, r, init.popup, dict);
  return dict;
```

(The early validation `if (init.popup?.rect !== undefined) checkNums('popup rect', init.popup.rect, 4);` was added in Task 3; confirm it is present near the top of `createAnnotation`, before `doc.allocObject`.)

- [ ] **Step 3b: Add `popup?` to the markup-family option interfaces and forward it**

For each interface, add the field:
```ts
  /** Auto-attach a companion /Popup. */
  popup?: PopupSpec;
```
to: `TextNoteOptions`, `StampAnnotationOptions`, `MarkupOptions`, `SquareCircleOptions`, `LineOptions`.

Forward `popup` in each create function's `createAnnotation({ ... })` call by adding `popup: opts.popup,`:
- `addTextNote` (its `createAnnotation` call)
- `addStamp` (its `createAnnotation` call)
- `addMarkup` (its `createAnnotation` call — `opts` is `MarkupOptions`)
- `addSquareCircle` (its `createAnnotation` call)
- `addLine` (its `createAnnotation` call)

Example for `addSquareCircle`:
```ts
  const dict = createAnnotation(doc, page, { subtype, rect: opts.rect, color, contents: opts.contents, popup: opts.popup });
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/annotation.test.ts -t "auto-popup"`
Expected: PASS.

- [ ] **Step 5: Full suite + typecheck + commit**

```bash
npm run typecheck
npm test
git add src/annotation.ts test/annotation.test.ts
git commit -m "feat(ur5): auto-popup option on markup-family Add* methods"
```

Expected: full suite green.

---

### Task 7: README docs + Limitations + close issue

**Files:**
- Modify: `README.md`

**Interfaces:**
- Consumes: the public API from Tasks 1–6.
- Produces: user-facing docs for `AddFreeText`/`AddPopup`, typed handles, the `popup` option, and an updated Limitations note.

- [ ] **Step 1: Locate the annotation sections**

Run: `grep -n "AddLine\|AddSquare\|SquareCircleAnnotation\|LineAnnotation\|Limitations\|FreeText\|Popup" README.md`
Expected: the annotations example, the API-overview table row(s), the typed-handle paragraph, and the Limitations list.

- [ ] **Step 2: Update the annotations example + API table**

In the annotations code example, add lines mirroring the existing `AddLine`/`AddSquare` style:

```ts
// A free-text note with a callout leader pointing at (x,y):
page.AddFreeText({
  rect: [200, 600, 360, 660], contents: 'Check this figure', fontSize: 12,
  align: 'left', fill: [1, 1, 0.8], callout: [120, 500, 180, 560, 200, 620],
});
// A popup bound to an existing markup (or pass `popup: {}` to any Add* call):
const note = page.AddSquare({ rect: [100, 100, 200, 160] });
page.AddPopup({ parent: note, open: false });
```

Add API-overview table rows for `Page.AddFreeText(opts)` and `Page.AddPopup(opts)` matching the existing row format.

- [ ] **Step 3: Update the typed-handle paragraph + Limitations**

Extend the typed-handle sentence to include:
> `FreeTextAnnotation` (`Alignment`, `FontSize`, `TextColor`, `BorderWidth`, `InteriorColor`, `Intent`, `CalloutLine`, `CalloutEnding`) and `PopupAnnotation` (`Open`, `Parent`). Any markup-family `Add*` method accepts a `popup` option to attach a companion popup in one call.

Update the Limitations note so the unmodeled-subtype list reads only:
> Ink, Polygon/Polyline annotations are still read back as the base `Annotation` (no typed setters or appearance generation).

- [ ] **Step 4: Verify build + full suite**

Run: `npm run typecheck && npm test && npm run build`
Expected: all green; `dist/` builds.

- [ ] **Step 5: Commit + close issue**

```bash
git add README.md
git commit -m "docs(ur5): document AddFreeText/AddPopup + typed handles"
bd close aspose-pdf-foss-for-ts-ur5
```

Then follow the CLAUDE.md Session Completion workflow (`git pull --rebase && git push`).

---

## Self-Review

**Spec coverage:**
- FreeTextAnnotation handle + all accessors → Task 1. ✓
- PopupAnnotation handle → Task 2. ✓
- AddFreeText (plain box, /DA, /Q, /IC, border, appearance) → Task 3. ✓
- FreeText callout (/CL, /LE, /IT, /RD, arrowhead) → Task 4. ✓
- AddPopup standalone + linkage → Task 5. ✓
- Auto-popup on markup-family Add* → Task 6. ✓
- wrapTextBody shared helper in appearance.ts → Task 3. ✓
- Fixtures (buildFreeTextReadTarget, buildPopupReadTarget) → Tasks 1, 2. ✓
- Tests: read model, setters, create, appearance sanity, auto-popup, validate-before-attach → Tasks 1–6. ✓
- README + Limitations → Task 7. ✓
- Dispatch cases in wrapAnnotation → Tasks 1, 2. ✓

**Placeholder scan:** No TBD/TODO; every code step shows complete code. ✓

**Type consistency:** `wrapTextBody(text, std, size, color, boxW, boxH, inset, align)` defined in Task 3 and called by `freeTextBoxBody` (Task 3) consistently. `PopupSpec { rect?, open? }` defined in Task 3, consumed by `FreeTextOptions` (Task 3), `PopupOptions`/`createPopup` (Task 5), `BaseAnnotInit.popup` (Task 3 stub → Task 6 attach). `createPopup(doc, page, parentRef, spec, parentDict)` signature identical in Tasks 5 and 6. `buildDA('Helv', size, color)` used in Task 1 (accessor setters) and Tasks 3/4 (create). `checkCallout` defined in Task 3, used in Task 4. `drawEnding` is the existing private helper (annotation.ts:968). ✓

**Note on /RD edge order:** Task 4 writes `/RD` as `[left, top, right, bottom]` per PDF 32000-1 Table 174. Tests assert length/positioning, not exact spec-edge semantics; confirm the order against the spec if a viewer renders the box offset.

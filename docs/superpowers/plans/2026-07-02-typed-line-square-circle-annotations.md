# Typed Line / Square / Circle Annotations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add typed handle classes, `Page.Add*` create APIs, live accessors, and generated `/AP /N` appearance streams for `/Line`, `/Square`, and `/Circle` annotations.

**Architecture:** Follow the existing annotation pattern in `src/annotation.ts`: a live-dict handle subclass per subtype, a `createAnnotation`-based `add*` factory that validates before allocating, and a content-stream `/AP` built with `buildAppearanceXObject`/`installAP` from `src/appearance.ts`. `Page` methods are thin wrappers. Square and Circle share one handle class (`SquareCircleAnnotation`) as `MarkupAnnotation` already covers four subtypes.

**Tech Stack:** TypeScript (strict, ESM/NodeNext, `.js` import specifiers), vitest, zero runtime deps (`node:` built-ins only).

## Global Constraints

- Zero runtime dependencies — only `node:` built-ins. Do not add npm runtime deps.
- ESM + NodeNext: every import specifier carries the `.js` extension.
- Live-mutation model: edits act directly on the live dict; never mutate inputs on `Save`.
- Validate-before-attach: validate every input before allocating or attaching any object (no stranded objects on invalid input).
- Errors: throw `TypeError`/`RangeError` for bad public input (matching existing setters).
- Colors are RGB `[r,g,b]` in 0..1; coordinates are PDF user space (origin bottom-left, points).
- Run `npm run typecheck` and `npm test` green before closing the issue.
- Keep `README.md` in sync with public API changes.

---

### Task 1: `SquareCircleAnnotation` read model + dispatch + fixture

**Files:**
- Modify: `src/annotation.ts` (add class after `MarkupAnnotation`, ~line 271; add dispatch cases in `wrapAnnotation`, ~line 344)
- Modify: `test/helpers/build-annot-target.ts` (add `buildShapeReadTarget`)
- Test: `test/annotation.test.ts`

**Interfaces:**
- Consumes: `Annotation` base class, `numArray(doc, o, n)`, `checkNums(key, v, n)`, `name`, `isDict`, `PdfDict`, `PdfObject` (all in `annotation.ts`); `Document.resolve`.
- Produces:
  - `export type ShapeType = 'square' | 'circle'`
  - `export class SquareCircleAnnotation extends Annotation` with `get ShapeType(): ShapeType`, `get/set InteriorColor(): [number,number,number] | undefined`, `get/set BorderWidth(): number`.
  - module helpers `readBorderWidth(doc: Document, dict: PdfDict): number` and `setBorderWidth(dict: PdfDict, v: number): void`.
  - `export function buildShapeReadTarget(): Uint8Array`.

- [ ] **Step 1: Write the failing test**

Add to `test/annotation.test.ts` (import `SquareCircleAnnotation` from `../src/annotation.js` and `buildShapeReadTarget` from `./helpers/build-annot-target.js`):

```ts
describe('SquareCircleAnnotation read model', () => {
  it('wraps /Square and /Circle with shape/interior/border accessors', () => {
    const doc = Document.Open(buildShapeReadTarget());
    const annots = doc.Pages[0].Annotations;
    const square = annots.find((a) => a.Subtype === 'Square') as SquareCircleAnnotation;
    const circle = annots.find((a) => a.Subtype === 'Circle') as SquareCircleAnnotation;

    expect(square).toBeInstanceOf(SquareCircleAnnotation);
    expect(circle).toBeInstanceOf(SquareCircleAnnotation);
    expect(square.ShapeType).toBe('square');
    expect(circle.ShapeType).toBe('circle');
    expect(square.InteriorColor).toEqual([1, 1, 0]);
    expect(circle.InteriorColor).toBeUndefined(); // fixture circle has no /IC
    expect(square.BorderWidth).toBe(2);
    expect(circle.BorderWidth).toBe(1);           // default when /BS absent
  });

  it('round-trips interior color and border width, rejecting bad input', () => {
    const doc = Document.Open(buildShapeReadTarget());
    const square = doc.Pages[0].Annotations.find((a) => a.Subtype === 'Square') as SquareCircleAnnotation;

    square.InteriorColor = [0, 0.5, 1];
    expect(square.InteriorColor).toEqual([0, 0.5, 1]);
    square.InteriorColor = undefined;
    expect(square.InteriorColor).toBeUndefined();

    square.BorderWidth = 3;
    expect(square.BorderWidth).toBe(3);

    expect(() => { square.InteriorColor = [2, 0, 0]; }).toThrow(TypeError);
    expect(() => { square.BorderWidth = -1; }).toThrow(TypeError);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/annotation.test.ts -t "SquareCircleAnnotation read model"`
Expected: FAIL — `buildShapeReadTarget`/`SquareCircleAnnotation` not exported.

- [ ] **Step 3: Add the fixture builder**

Append to `test/helpers/build-annot-target.ts`:

```ts
/** One page carrying /Square (with /IC + /BS), /Circle (no /IC), and /Line. */
export function buildShapeReadTarget(): Uint8Array {
  const objects: string[] = [];
  objects[1] = `<< /Type /Catalog /Pages 2 0 R >>`;
  objects[2] = `<< /Type /Pages /Count 1 /Kids [3 0 R] /MediaBox [0 0 300 200] >>`;
  objects[3] = `<< /Type /Page /Parent 2 0 R /Annots [4 0 R 5 0 R 6 0 R] >>`;
  objects[4] = `<< /Type /Annot /Subtype /Square /Rect [10 10 90 60] ` +
    `/C [0 0 1] /IC [1 1 0] /BS << /Type /Border /W 2 >> /F 4 >>`;
  objects[5] = `<< /Type /Annot /Subtype /Circle /Rect [100 10 180 60] /C [1 0 0] /F 4 >>`;
  objects[6] = `<< /Type /Annot /Subtype /Line /Rect [10 100 190 140] ` +
    `/L [20 110 180 130] /LE [/None /OpenArrow] /C [0 0 0] /F 4 >>`;
  return assemble(objects, 6, 1);
}
```

- [ ] **Step 4: Add the handle class, helpers, and dispatch**

In `src/annotation.ts`, add after the `MarkupAnnotation` class:

```ts
/** Border width from /BS /W; default 1 when absent or malformed. */
function readBorderWidth(doc: Document, dict: PdfDict): number {
  const bs = doc.resolve(dict.get('BS'));
  if (isDict(bs)) {
    const w = doc.resolve((bs as PdfDict).get('W'));
    if (typeof w === 'number' && Number.isFinite(w)) return w;
  }
  return 1;
}

/** Write /BS << /Type /Border /W v >>. Validates a non-negative finite number. */
function setBorderWidth(dict: PdfDict, v: number): void {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0)
    throw new TypeError('BorderWidth must be a non-negative finite number');
  dict.set('BS', new Map<string, PdfObject>([['Type', name('Border')], ['W', v]]));
}

/** 'square' or 'circle' — the two subtypes SquareCircleAnnotation covers. */
export type ShapeType = 'square' | 'circle';

/** A /Square or /Circle annotation: a stroked (optionally filled) rectangle or
 *  inscribed ellipse in /Rect. */
export class SquareCircleAnnotation extends Annotation {
  /** 'circle' for /Circle, else 'square'. */
  get ShapeType(): ShapeType {
    return this.Subtype === 'Circle' ? 'circle' : 'square';
  }

  /** /IC interior fill color RGB [r,g,b] in 0..1; undefined when absent. */
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

  /** Border width from /BS /W; 1 when absent. */
  get BorderWidth(): number { return readBorderWidth(this.doc, this.Dict); }
  set BorderWidth(v: number) { setBorderWidth(this.Dict, v); this.touch(); }
}
```

In `wrapAnnotation`, add cases before `default:`:

```ts
    case 'Square':
    case 'Circle': return new SquareCircleAnnotation(doc, dict);
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run test/annotation.test.ts -t "SquareCircleAnnotation read model"`
Expected: PASS (both `it` blocks).

- [ ] **Step 6: Commit**

```bash
git add src/annotation.ts test/helpers/build-annot-target.ts test/annotation.test.ts
git commit -m "feat(i1p): SquareCircleAnnotation read model + dispatch"
```

---

### Task 2: `LineAnnotation` read model + dispatch

**Files:**
- Modify: `src/annotation.ts` (add class after `SquareCircleAnnotation`; add dispatch case in `wrapAnnotation`)
- Test: `test/annotation.test.ts`

**Interfaces:**
- Consumes: `Annotation`, `numArray`, `checkNums`, `readBorderWidth`, `setBorderWidth`, `name`, `isArray`, `isName` (all in `annotation.ts`); `buildShapeReadTarget` (Task 1).
- Produces:
  - `export type LineEnding = 'None' | 'OpenArrow' | 'ClosedArrow' | 'Circle' | 'Square'`
  - module constant `LINE_ENDINGS: ReadonlySet<string>`
  - `export class LineAnnotation extends Annotation` with `get/set Line(): [number,number,number,number] | undefined`, `get/set BorderWidth(): number`, `get/set LineEndings(): [LineEnding, LineEnding] | undefined`.

- [ ] **Step 1: Write the failing test**

Add to `test/annotation.test.ts` (import `LineAnnotation`):

```ts
describe('LineAnnotation read model', () => {
  it('wraps /Line with endpoint/border/ending accessors', () => {
    const doc = Document.Open(buildShapeReadTarget());
    const line = doc.Pages[0].Annotations.find((a) => a.Subtype === 'Line') as LineAnnotation;

    expect(line).toBeInstanceOf(LineAnnotation);
    expect(line.Line).toEqual([20, 110, 180, 130]);
    expect(line.BorderWidth).toBe(1);                 // no /BS → default
    expect(line.LineEndings).toEqual(['None', 'OpenArrow']);
  });

  it('round-trips line/endings and rejects bad input', () => {
    const doc = Document.Open(buildShapeReadTarget());
    const line = doc.Pages[0].Annotations.find((a) => a.Subtype === 'Line') as LineAnnotation;

    line.Line = [0, 0, 100, 100];
    expect(line.Line).toEqual([0, 0, 100, 100]);

    line.LineEndings = ['OpenArrow', 'ClosedArrow'];
    expect(line.LineEndings).toEqual(['OpenArrow', 'ClosedArrow']);
    line.LineEndings = undefined;
    expect(line.LineEndings).toBeUndefined();

    expect(() => { line.Line = [1, 2, 3] as any; }).toThrow(TypeError);
    expect(() => { line.LineEndings = ['Bogus', 'None'] as any; }).toThrow(TypeError);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/annotation.test.ts -t "LineAnnotation read model"`
Expected: FAIL — `LineAnnotation` not exported.

- [ ] **Step 3: Add the handle class + dispatch**

In `src/annotation.ts`, add after `SquareCircleAnnotation`:

```ts
/** Supported /LE line-ending styles. */
export type LineEnding = 'None' | 'OpenArrow' | 'ClosedArrow' | 'Circle' | 'Square';

const LINE_ENDINGS: ReadonlySet<string> = new Set<string>([
  'None', 'OpenArrow', 'ClosedArrow', 'Circle', 'Square',
]);

/** A /Line annotation: a straight segment between /L endpoints with optional
 *  /LE endings (arrowheads/shapes) at each end. */
export class LineAnnotation extends Annotation {
  /** /L endpoints [x1,y1,x2,y2]; undefined when missing/malformed. */
  get Line(): [number, number, number, number] | undefined {
    const l = numArray(this.doc, this.Dict.get('L'), 4);
    return l ? [l[0], l[1], l[2], l[3]] : undefined;
  }

  set Line(v: [number, number, number, number] | undefined) {
    this.touch();
    if (v === undefined) { this.Dict.delete('L'); return; }
    this.Dict.set('L', checkNums('Line', v, 4));
  }

  /** Border width from /BS /W; 1 when absent. */
  get BorderWidth(): number { return readBorderWidth(this.doc, this.Dict); }
  set BorderWidth(v: number) { setBorderWidth(this.Dict, v); this.touch(); }

  /** /LE endings [start, end]; undefined when absent or malformed. */
  get LineEndings(): [LineEnding, LineEnding] | undefined {
    const le = this.doc.resolve(this.Dict.get('LE'));
    if (!isArray(le) || le.length < 2) return undefined;
    const s = this.doc.resolve(le[0]); const e = this.doc.resolve(le[1]);
    if (!isName(s) || !isName(e)) return undefined;
    return [s.name as LineEnding, e.name as LineEnding];
  }

  set LineEndings(v: [LineEnding, LineEnding] | undefined) {
    this.touch();
    if (v === undefined) { this.Dict.delete('LE'); return; }
    if (!Array.isArray(v) || v.length !== 2 || !LINE_ENDINGS.has(v[0]) || !LINE_ENDINGS.has(v[1]))
      throw new TypeError('LineEndings must be [start, end] of supported ending names');
    this.Dict.set('LE', [name(v[0]), name(v[1])]);
  }
}
```

In `wrapAnnotation`, add before `default:`:

```ts
    case 'Line': return new LineAnnotation(doc, dict);
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/annotation.test.ts -t "LineAnnotation read model"`
Expected: PASS (both `it` blocks).

- [ ] **Step 5: Commit**

```bash
git add src/annotation.ts test/annotation.test.ts
git commit -m "feat(i1p): LineAnnotation read model + dispatch"
```

---

### Task 3: `AddSquare` / `AddCircle` create API + appearance

**Files:**
- Modify: `src/annotation.ts` (add option validators, appearance helpers, `addSquare`/`addCircle`)
- Modify: `src/page.ts` (import + `AddSquare`/`AddCircle` methods)
- Test: `test/annotation.test.ts`

**Interfaces:**
- Consumes: `createAnnotation`, `SquareCircleAnnotation`, `setBorderWidth`, `widgetGeom`, `buildAppearanceXObject`, `installAP`, `WidgetGeom`, `num`, `name`, `PdfDict`, `PdfObject`.
- Produces:
  - `export interface SquareCircleOptions { rect; color?; fill?; width?; contents?; opacity? }`
  - `export function addSquare(doc, page, opts): SquareCircleAnnotation`
  - `export function addCircle(doc, page, opts): SquareCircleAnnotation`
  - module helpers `checkOptColor`, `checkOptWidth`, `checkOptOpacity`, `installShapeAP`, `drawRect`, `drawEllipse`.
  - `Page.AddSquare(opts): SquareCircleAnnotation`, `Page.AddCircle(opts): SquareCircleAnnotation`.

- [ ] **Step 1: Write the failing test**

Add to `test/annotation.test.ts` (uses `parseContentStream`, `isStream`, `buildBlankPage` already imported):

```ts
describe('Page.AddSquare / AddCircle', () => {
  function apOps(doc: Document, annot: Annotation): string[] {
    const ap = doc.resolve(annot.Dict.get('AP')) as Map<string, any>;
    const n = doc.resolve(ap.get('N'));
    expect(isStream(n)).toBe(true);
    return parseContentStream((n as any).raw).map((o) => o.operator);
  }

  it('AddSquare creates a filled+stroked /Square with an appearance', () => {
    const doc = Document.Open(buildBlankPage());
    const page = doc.Pages[0];
    const sq = page.AddSquare({ rect: [10, 10, 90, 60], color: [0, 0, 1], fill: [1, 1, 0], width: 2 });

    expect(sq).toBeInstanceOf(SquareCircleAnnotation);
    expect(sq.Subtype).toBe('Square');
    expect(sq.InteriorColor).toEqual([1, 1, 0]);
    expect(sq.BorderWidth).toBe(2);
    expect(sq.Print).toBe(true);
    expect(page.Annotations).toHaveLength(1);

    const ops = apOps(doc, sq);
    expect(ops).toContain('re');
    expect(ops).toContain('B');   // fill + stroke
  });

  it('AddCircle without fill strokes an ellipse (Bézier curves)', () => {
    const doc = Document.Open(buildBlankPage());
    const c = doc.Pages[0].AddCircle({ rect: [10, 10, 90, 60], color: [1, 0, 0] });

    expect(c.ShapeType).toBe('circle');
    expect(c.InteriorColor).toBeUndefined();
    const ops = apOps(doc, c);
    expect(ops.filter((o) => o === 'c').length).toBe(4); // 4 quarter-arcs
    expect(ops).toContain('S');                          // stroke only
  });

  it('applies opacity via a /GS0 ExtGState and validates before attaching', () => {
    const doc = Document.Open(buildBlankPage());
    const page = doc.Pages[0];
    const sq = page.AddSquare({ rect: [0, 0, 40, 40], opacity: 0.5 });
    const ap = doc.resolve(sq.Dict.get('AP')) as Map<string, any>;
    const n = doc.resolve(ap.get('N'));
    expect(new TextDecoder().decode((n as any).raw)).toContain('gs');
    expect(sq.Opacity).toBe(0.5);

    expect(() => page.AddSquare({ rect: [0, 0, 10, 10], color: [2, 0, 0] })).toThrow(TypeError);
    expect(() => page.AddSquare({ rect: [0, 0, 10, 10], opacity: 5 })).toThrow(TypeError);
    expect(page.Annotations).toHaveLength(1); // no stranded objects from the throwing calls
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/annotation.test.ts -t "Page.AddSquare"`
Expected: FAIL — `AddSquare` not a function on `Page`.

- [ ] **Step 3: Add option validators + appearance helpers + factories**

In `src/annotation.ts`, add (near the other `add*` functions, e.g. after `addSquiggly`):

```ts
/** Validate an optional RGB color; returns a defensive copy or undefined. */
function checkOptColor(key: string, v: [number, number, number] | undefined): [number, number, number] | undefined {
  if (v === undefined) return undefined;
  const c = checkNums(key, v, 3);
  if (c.some((x) => x < 0 || x > 1)) throw new TypeError(`${key} components must be in 0..1`);
  return [c[0], c[1], c[2]];
}

/** Validate an optional border width; default 1. */
function checkOptWidth(v: number | undefined): number {
  if (v === undefined) return 1;
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0)
    throw new TypeError('width must be a non-negative finite number');
  return v;
}

/** Validate an optional /CA opacity in 0..1; undefined passes through. */
function checkOptOpacity(v: number | undefined): number | undefined {
  if (v === undefined) return undefined;
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 1)
    throw new TypeError('opacity must be in 0..1');
  return v;
}

/** Install `body` as the annotation's /AP /N, wrapping in a /GS0 ExtGState when
 *  opacity < 1 (matching the markup opacity path). */
function installShapeAP(doc: Document, dict: PdfDict, g: WidgetGeom, body: string, opacity: number): void {
  let full = '';
  if (opacity < 1) full += '/GS0 gs\n';
  full += body;
  const stream = buildAppearanceXObject(doc, g, 'Helvetica', 'F0', full);
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

/** Painting op for the fill/stroke selection: B = both, S = stroke, f = fill. */
function paintOp(stroke: boolean, fill: boolean): string {
  if (stroke && fill) return 'B';
  if (fill) return 'f';
  return 'S';
}

/** Rectangle inset by half the border so the stroke stays inside the box. */
function drawRect(g: WidgetGeom, color: [number, number, number], fill: [number, number, number] | undefined, width: number): string {
  const half = width / 2;
  const x = half, y = half, w = g.w - width, h = g.h - width;
  let s = '';
  if (fill) s += `${num(fill[0])} ${num(fill[1])} ${num(fill[2])} rg\n`;
  s += `${num(color[0])} ${num(color[1])} ${num(color[2])} RG\n${num(width)} w\n`;
  s += `${num(x)} ${num(y)} ${num(w)} ${num(h)} re\n`;
  return s + paintOp(width > 0, fill !== undefined) + '\n';
}

/** Ellipse inscribed in the inset rect via 4 Bézier quarter-arcs. */
function drawEllipse(g: WidgetGeom, color: [number, number, number], fill: [number, number, number] | undefined, width: number): string {
  const half = width / 2;
  const x0 = half, y0 = half, w = g.w - width, h = g.h - width;
  const cx = x0 + w / 2, cy = y0 + h / 2, rx = w / 2, ry = h / 2;
  const k = 0.5523;               // circle→Bézier control-point ratio
  const ox = rx * k, oy = ry * k;
  let s = '';
  if (fill) s += `${num(fill[0])} ${num(fill[1])} ${num(fill[2])} rg\n`;
  s += `${num(color[0])} ${num(color[1])} ${num(color[2])} RG\n${num(width)} w\n`;
  s += `${num(cx + rx)} ${num(cy)} m\n`;
  s += `${num(cx + rx)} ${num(cy + oy)} ${num(cx + ox)} ${num(cy + ry)} ${num(cx)} ${num(cy + ry)} c\n`;
  s += `${num(cx - ox)} ${num(cy + ry)} ${num(cx - rx)} ${num(cy + oy)} ${num(cx - rx)} ${num(cy)} c\n`;
  s += `${num(cx - rx)} ${num(cy - oy)} ${num(cx - ox)} ${num(cy - ry)} ${num(cx)} ${num(cy - ry)} c\n`;
  s += `${num(cx + ox)} ${num(cy - ry)} ${num(cx + rx)} ${num(cy - oy)} ${num(cx + rx)} ${num(cy)} c\n`;
  return s + paintOp(width > 0, fill !== undefined) + '\n';
}

/** Options for Page.AddSquare / Page.AddCircle. */
export interface SquareCircleOptions {
  rect: [number, number, number, number];
  /** Border stroke color /C, RGB 0..1. Default black [0,0,0]. */
  color?: [number, number, number];
  /** Interior fill color /IC, RGB 0..1. Omitted → no fill. */
  fill?: [number, number, number];
  /** Border width /BS /W. Default 1. */
  width?: number;
  /** /Contents body text. */
  contents?: string;
  /** /CA constant opacity, 0..1. */
  opacity?: number;
}

/** @internal Shared builder for /Square and /Circle. */
function addSquareCircle(doc: Document, page: Page, subtype: 'Square' | 'Circle', opts: SquareCircleOptions): SquareCircleAnnotation {
  const color = checkOptColor('color', opts.color) ?? [0, 0, 0];
  const fill = checkOptColor('fill', opts.fill);
  const width = checkOptWidth(opts.width);
  const opacity = checkOptOpacity(opts.opacity);

  const dict = createAnnotation(doc, page, { subtype, rect: opts.rect, color, contents: opts.contents });
  const annot = new SquareCircleAnnotation(doc, dict);
  setBorderWidth(dict, width);
  if (fill) annot.InteriorColor = fill;
  if (opacity !== undefined) annot.Opacity = opacity;
  // Record the border half-inset between /Rect and the drawn geometry.
  const half = width / 2;
  dict.set('RD', [half, half, half, half]);

  const g = widgetGeom(doc, dict);
  if (g) {
    const body = subtype === 'Circle' ? drawEllipse(g, color, fill, width) : drawRect(g, color, fill, width);
    installShapeAP(doc, dict, g, body, opacity ?? 1);
  }
  return annot;
}

/** Build and attach a /Square annotation to `page`. */
export function addSquare(doc: Document, page: Page, opts: SquareCircleOptions): SquareCircleAnnotation {
  return addSquareCircle(doc, page, 'Square', opts);
}

/** Build and attach a /Circle annotation to `page`. */
export function addCircle(doc: Document, page: Page, opts: SquareCircleOptions): SquareCircleAnnotation {
  return addSquareCircle(doc, page, 'Circle', opts);
}
```

- [ ] **Step 4: Wire up the `Page` methods**

In `src/page.ts`, extend the `annotation.js` import block with:

```ts
  addSquare, addCircle, SquareCircleAnnotation, SquareCircleOptions,
```

And add methods to the `Page` class next to `AddSquiggly`/`AddLink`:

```ts
  /** Add a /Square rectangle annotation (border + optional interior fill). */
  AddSquare(opts: SquareCircleOptions): SquareCircleAnnotation {
    return addSquare(this.doc, this, opts);
  }

  /** Add a /Circle ellipse annotation (border + optional interior fill). */
  AddCircle(opts: SquareCircleOptions): SquareCircleAnnotation {
    return addCircle(this.doc, this, opts);
  }
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run test/annotation.test.ts -t "Page.AddSquare"`
Expected: PASS (all three `it` blocks).

- [ ] **Step 6: Commit**

```bash
git add src/annotation.ts src/page.ts test/annotation.test.ts
git commit -m "feat(i1p): AddSquare/AddCircle with generated appearance"
```

---

### Task 4: `AddLine` create API + appearance (arrowheads)

**Files:**
- Modify: `src/annotation.ts` (add ending drawing helpers, `LineOptions`, `addLine`)
- Modify: `src/page.ts` (import + `AddLine` method)
- Test: `test/annotation.test.ts`

**Interfaces:**
- Consumes: `createAnnotation`, `LineAnnotation`, `LineEnding`, `LINE_ENDINGS`, `setBorderWidth`, `checkNums`, `checkOptColor`, `checkOptWidth`, `checkOptOpacity`, `installShapeAP`, `widgetGeom`, `num`.
- Produces:
  - `export interface LineOptions { line; color?; width?; startEnding?; endEnding?; contents?; opacity? }`
  - `export function addLine(doc, page, opts): LineAnnotation`
  - module helpers `rot`, `drawEnding`.
  - `Page.AddLine(opts): LineAnnotation`.

- [ ] **Step 1: Write the failing test**

Add to `test/annotation.test.ts`:

```ts
describe('Page.AddLine', () => {
  function apOps(doc: Document, annot: Annotation): string[] {
    const ap = doc.resolve(annot.Dict.get('AP')) as Map<string, any>;
    const n = doc.resolve(ap.get('N'));
    expect(isStream(n)).toBe(true);
    return parseContentStream((n as any).raw).map((o) => o.operator);
  }

  it('AddLine sets /L, derives /Rect from endpoints, and strokes the segment', () => {
    const doc = Document.Open(buildBlankPage());
    const page = doc.Pages[0];
    const line = page.AddLine({ line: [20, 30, 120, 30], color: [1, 0, 0], width: 2 });

    expect(line).toBeInstanceOf(LineAnnotation);
    expect(line.Subtype).toBe('Line');
    expect(line.Line).toEqual([20, 30, 120, 30]);
    expect(line.BorderWidth).toBe(2);
    // /Rect encloses both endpoints (with margin), so it is wider/taller than /L.
    const [x1, y1, x2, y2] = line.Rect!;
    expect(x1).toBeLessThan(20);
    expect(x2).toBeGreaterThan(120);
    expect(y1).toBeLessThan(30);
    expect(y2).toBeGreaterThan(30);

    const ops = apOps(doc, line);
    expect(ops).toContain('m');
    expect(ops).toContain('l');
    expect(ops).toContain('S');
  });

  it('renders a closed arrowhead as a filled triangle at the end', () => {
    const doc = Document.Open(buildBlankPage());
    const line = doc.Pages[0].AddLine({ line: [0, 0, 100, 0], endEnding: 'ClosedArrow' });
    expect(line.LineEndings).toEqual(['None', 'ClosedArrow']);
    const ops = apOps(doc, line);
    expect(ops).toContain('f'); // filled arrowhead triangle
  });

  it('validates inputs before attaching', () => {
    const doc = Document.Open(buildBlankPage());
    const page = doc.Pages[0];
    expect(() => page.AddLine({ line: [0, 0, 1] as any })).toThrow(TypeError);
    expect(() => page.AddLine({ line: [0, 0, 1, 1], endEnding: 'Bogus' as any })).toThrow(TypeError);
    expect(page.Annotations).toHaveLength(0); // nothing stranded
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/annotation.test.ts -t "Page.AddLine"`
Expected: FAIL — `AddLine` not a function on `Page`.

- [ ] **Step 3: Add ending helpers + `addLine`**

In `src/annotation.ts`, add:

```ts
/** Rotate vector (vx,vy) by angle `a` radians. */
function rot(vx: number, vy: number, a: number): [number, number] {
  const c = Math.cos(a), s = Math.sin(a);
  return [vx * c - vy * s, vx * s + vy * c];
}

/** Draw an /LE ending at (px,py). (dx,dy) is the outward unit direction the
 *  ending points (away from the line). Arrowheads fill/stroke with `color`. */
function drawEnding(px: number, py: number, dx: number, dy: number, ending: LineEnding, size: number, color: [number, number, number]): string {
  if (ending === 'None') return '';
  const [r, g, b] = color;
  if (ending === 'Square') {
    const rad = size / 2;
    return `${num(r)} ${num(g)} ${num(b)} rg\n` +
      `${num(px - rad)} ${num(py - rad)} ${num(2 * rad)} ${num(2 * rad)} re f\n`;
  }
  if (ending === 'Circle') {
    const rad = size / 2, k = 0.5523 * rad;
    return `${num(r)} ${num(g)} ${num(b)} rg\n` +
      `${num(px + rad)} ${num(py)} m\n` +
      `${num(px + rad)} ${num(py + k)} ${num(px + k)} ${num(py + rad)} ${num(px)} ${num(py + rad)} c\n` +
      `${num(px - k)} ${num(py + rad)} ${num(px - rad)} ${num(py + k)} ${num(px - rad)} ${num(py)} c\n` +
      `${num(px - rad)} ${num(py - k)} ${num(px - k)} ${num(py - rad)} ${num(px)} ${num(py - rad)} c\n` +
      `${num(px + k)} ${num(py - rad)} ${num(px + rad)} ${num(py - k)} ${num(px + rad)} ${num(py)} c\nf\n`;
  }
  // OpenArrow / ClosedArrow: two barbs from the reversed outward direction.
  const theta = 0.5236; // 30°
  const [b1x, b1y] = rot(-dx, -dy, theta);
  const [b2x, b2y] = rot(-dx, -dy, -theta);
  const p1x = px + b1x * size, p1y = py + b1y * size;
  const p2x = px + b2x * size, p2y = py + b2y * size;
  if (ending === 'ClosedArrow') {
    return `${num(r)} ${num(g)} ${num(b)} rg\n` +
      `${num(px)} ${num(py)} m ${num(p1x)} ${num(p1y)} l ${num(p2x)} ${num(p2y)} l f\n`;
  }
  return `${num(r)} ${num(g)} ${num(b)} RG\n` +
    `${num(p1x)} ${num(p1y)} m ${num(px)} ${num(py)} l ${num(p2x)} ${num(p2y)} l S\n`;
}

/** Options for Page.AddLine. */
export interface LineOptions {
  /** Endpoints [x1,y1,x2,y2] in user space (sets /L). */
  line: [number, number, number, number];
  /** Stroke color /C, RGB 0..1. Default black [0,0,0]. */
  color?: [number, number, number];
  /** Line width /BS /W. Default 1. */
  width?: number;
  /** Start ending /LE[0]. Default 'None'. */
  startEnding?: LineEnding;
  /** End ending /LE[1]. Default 'None'. */
  endEnding?: LineEnding;
  /** /Contents body text. */
  contents?: string;
  /** /CA constant opacity, 0..1. */
  opacity?: number;
}

/** Build and attach a /Line annotation to `page`. /Rect is derived from the
 *  endpoint bounding box padded for the line width and any endings. */
export function addLine(doc: Document, page: Page, opts: LineOptions): LineAnnotation {
  const line = checkNums('line', opts.line, 4);
  const color = checkOptColor('color', opts.color) ?? [0, 0, 0];
  const width = checkOptWidth(opts.width);
  const opacity = checkOptOpacity(opts.opacity);
  const start = opts.startEnding ?? 'None';
  const end = opts.endEnding ?? 'None';
  if (!LINE_ENDINGS.has(start) || !LINE_ENDINGS.has(end))
    throw new TypeError('startEnding/endEnding must be a supported ending name');

  const [x1, y1, x2, y2] = line;
  const hasEndings = start !== 'None' || end !== 'None';
  const endingSize = Math.max(8, width * 3);
  const margin = hasEndings ? endingSize : Math.max(width, 1);
  const minX = Math.min(x1, x2) - margin, maxX = Math.max(x1, x2) + margin;
  const minY = Math.min(y1, y2) - margin, maxY = Math.max(y1, y2) + margin;

  const dict = createAnnotation(doc, page, {
    subtype: 'Line', rect: [minX, minY, maxX, maxY], color, contents: opts.contents,
  });
  const annot = new LineAnnotation(doc, dict);
  annot.Line = [x1, y1, x2, y2];
  setBorderWidth(dict, width);
  if (hasEndings) annot.LineEndings = [start, end];
  if (opacity !== undefined) annot.Opacity = opacity;

  const g = widgetGeom(doc, dict);
  if (g) {
    // Endpoints translated into form space (origin at /Rect lower-left).
    const ax = x1 - minX, ay = y1 - minY, bx = x2 - minX, by = y2 - minY;
    let body = `${num(color[0])} ${num(color[1])} ${num(color[2])} RG\n${num(width)} w\n`;
    body += `${num(ax)} ${num(ay)} m ${num(bx)} ${num(by)} l S\n`;
    const len = Math.hypot(bx - ax, by - ay) || 1;
    const ux = (bx - ax) / len, uy = (by - ay) / len;
    body += drawEnding(ax, ay, -ux, -uy, start, endingSize, color); // start points away from p2
    body += drawEnding(bx, by, ux, uy, end, endingSize, color);     // end points away from p1
    installShapeAP(doc, dict, g, body, opacity ?? 1);
  }
  return annot;
}
```

- [ ] **Step 4: Wire up the `Page` method**

In `src/page.ts`, extend the `annotation.js` import block with:

```ts
  addLine, LineAnnotation, LineOptions,
```

And add to the `Page` class:

```ts
  /** Add a /Line annotation between two points, with optional end arrowheads. */
  AddLine(opts: LineOptions): LineAnnotation {
    return addLine(this.doc, this, opts);
  }
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run test/annotation.test.ts -t "Page.AddLine"`
Expected: PASS (all three `it` blocks).

- [ ] **Step 6: Run the full annotation suite + typecheck**

Run: `npx vitest run test/annotation.test.ts && npm run typecheck`
Expected: PASS, no type errors.

- [ ] **Step 7: Commit**

```bash
git add src/annotation.ts src/page.ts test/annotation.test.ts
git commit -m "feat(i1p): AddLine with arrowhead appearance"
```

---

### Task 5: README docs + full-suite verification + close issue

**Files:**
- Modify: `README.md` (annotations example, typed-handle paragraph, API table, Limitations)

**Interfaces:**
- Consumes: the public API from Tasks 1–4. Produces: documentation only.

- [ ] **Step 1: Update the annotations usage example**

In `README.md`, after the text-markup lines (~line 487), add:

```md
// Geometric shapes: rectangle, ellipse, and line (with optional arrowheads).
page.AddSquare({ rect: [72, 440, 240, 500], color: [0, 0, 1], fill: [0.9, 0.9, 1], width: 1.5 });
page.AddCircle({ rect: [260, 440, 380, 500], color: [1, 0, 0] });
page.AddLine({ line: [72, 420, 380, 420], color: [0, 0, 0], endEnding: 'ClosedArrow' });
```

- [ ] **Step 2: Update the typed-handle paragraph**

In the paragraph that lists handle subclasses (~line 497), add `SquareCircleAnnotation` (`ShapeType`/`InteriorColor`/`BorderWidth`) and `LineAnnotation` (`Line`/`LineEndings`/`BorderWidth`) to the enumeration.

- [ ] **Step 3: Update the API-overview table**

In the API table, after the `AddSquiggly` row (~line 655), add:

```md
| `page.AddSquare(opts)` | Add a `/Square` rectangle annotation with a stroked/filled appearance |
| `page.AddCircle(opts)` | Add a `/Circle` ellipse annotation with a stroked/filled appearance |
| `page.AddLine(opts)` | Add a `/Line` annotation between two points, with optional end arrowheads |
```

- [ ] **Step 4: Update the Limitations note**

In `README.md` (~line 715), edit the "Annotation subtypes are a curated set" bullet. Two exact replacements:

Replace:

```md
create/edit covers `/Text`, `/Stamp`, the text-markup family (`/Highlight`, `/Underline`, `/StrikeOut`, `/Squiggly`), and `/Link` (GoTo/URI).
```

with:

```md
create/edit covers `/Text`, `/Stamp`, the text-markup family (`/Highlight`, `/Underline`, `/StrikeOut`, `/Squiggly`), `/Link` (GoTo/URI), and the geometric shapes (`/Line`, `/Square`, `/Circle`).
```

Replace:

```md
Other subtypes (`FreeText`, `Ink`, `Line`, `Square`/`Circle`, `Popup`, ...) still read back as a base `Annotation` (use `.Dict`) but have no typed setters.
```

with:

```md
Other subtypes (`FreeText`, `Ink`, `Polygon`/`Polyline`, `Popup`, ...) still read back as a base `Annotation` (use `.Dict`) but have no typed setters.
```

- [ ] **Step 5: Run the full test suite + typecheck**

Run: `npm run typecheck && npm test`
Expected: PASS — entire suite green, no type errors.

- [ ] **Step 6: Commit**

```bash
git add README.md
git commit -m "docs(i1p): document AddSquare/AddCircle/AddLine"
```

- [ ] **Step 7: Close the issue**

Run: `bd close aspose-pdf-foss-for-ts-i1p`
(Sub-issues g6p and ur5 remain open for the later passes.)

---

## Notes for the implementer

- Place new handle classes and `add*` functions in `src/annotation.ts` following the existing ordering (handle classes near the other subclasses; `add*` factories in the lower half beside `addMarkup`/`addLink`).
- `num` (from `pagecontent.js`) is already imported in `annotation.ts` and formats numbers for content streams — always use it for coordinates in `/AP` bodies.
- The opacity ExtGState path (`installShapeAP`) mirrors `addMarkup`'s handling; keep the `/GS0` key and `ca`/`CA` entries identical for consistency.
- `widgetGeom(doc, dict)` returns `undefined` for a zero-area `/Rect`; the `add*` functions skip appearance generation in that case (the annotation is still created), matching `addStamp`/`addMarkup`.

# Caret Annotation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `/Caret` text-insertion annotation — `page.AddCaret` — drawn as a concave-sided filled wedge with an optional paragraph symbol, and teach `regenerateAppearance` to draw one.

**Architecture:** No new module. `annotdraw.ts` gains one `caretBody` function used by both the builder and appearance regeneration; `annotation.ts` gains the `CaretAnnotation` handle and `addCaret` builder, following `addSquareCircle` exactly. A three-way duplicated `/T` accessor is consolidated on the way past.

**Tech Stack:** TypeScript (strict, ESM/NodeNext), vitest, `node:` built-ins only.

**Spec:** `docs/superpowers/specs/2026-08-05-caret-annotation-design.md`
**Issue:** `aspose-pdf-foss-for-ts-0pvw.2` (already claimed)

## Global Constraints

- **Zero runtime dependencies.** Only `node:` built-ins. Do not add npm runtime deps.
- **ESM + NodeNext, strict TypeScript.** Every import specifier carries the `.js` extension.
- **Task tracking is `bd`.** Do NOT use TodoWrite, TaskCreate, or markdown TODO lists.
- **Argument validation uses plain `TypeError`**, matching the rest of the `Add*` family. The public error types (`PdfParseError`, `UnsupportedFeatureError`, `InvalidPasswordError`) are not used here.
- **Validate before allocating.** `addCaret` validates every argument before the first `createAnnotation` call, so a rejected call leaves the document byte-identical.
- **Both gates green before the issue closes:** `npm run typecheck` and `npm test`.
- **The appearance's font operator must name `F0`.** `installShapeAP` calls `buildAppearanceXObject(doc, g, 'Helvetica', 'F0', body)` and `fontResources` registers exactly one key. Emitting `/Helv` would name a resource that is not in the form — the pre-existing bug filed as `cu3b`. Do not fix `cu3b` here; do not reproduce it either.
- Tests go in the **existing** `test/annotation.test.ts` and `test/annotdraw.test.ts`. Do not create per-subtype test files — there are none for `/Square`, `/Ink` or `/FreeText` either.
- Commit after every task. Do not push until the final task.

## File Structure

| File | Responsibility |
|---|---|
| `src/annotation.ts` (modify) | `readTextString`/`writeTextString` helpers, `CaretAnnotation`, `CaretOptions`, `addCaret`, `wrapAnnotation` dispatch |
| `src/annotdraw.ts` (modify) | `caretBody`, the `regenerateAppearance` case, the doc comment |
| `src/page.ts` (modify) | `AddCaret` |
| `src/index.ts` (modify) | public exports |
| `test/annotation.test.ts` (modify) | builder tests |
| `test/annotdraw.test.ts` (modify) | `caretBody` and regeneration tests |
| `README.md`, `CLAUDE.md` (modify) | user-facing docs, architecture note |

---

### Task 1: Consolidate the `/T` accessor

`Author` is copied verbatim on `TextAnnotation` and `RedactAnnotation`; `CaretAnnotation` would make three. Pure refactor — the existing suites are the proof it is behaviour-preserving.

**Files:**
- Modify: `src/annotation.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: module-private `readTextString(doc: Document, dict: PdfDict, key: string): string | undefined` and `writeTextString(dict: PdfDict, key: string, v: string | undefined, label: string): void` in `src/annotation.ts`. Not exported.

- [ ] **Step 1: Add the helpers**

In `src/annotation.ts`, immediately after the existing `pdfText` function near the top of the file:

```ts
/** A PDF text string entry, decoded; undefined when absent or not a string.
 *  Shared by every accessor over a plain text-string key (/T today). */
function readTextString(doc: Document, dict: PdfDict, key: string): string | undefined {
  const s = doc.resolve(dict.get(key));
  return isString(s) ? decodePdfText(s.bytes) : undefined;
}

/** Write (or delete, when `v` is undefined) a PDF text string entry. `label` is
 *  the public property name, so the thrown message names what the caller wrote. */
function writeTextString(dict: PdfDict, key: string, v: string | undefined, label: string): void {
  if (v === undefined) { dict.delete(key); return; }
  if (typeof v !== 'string') throw new TypeError(`${label} must be a string`);
  dict.set(key, pdfText(v));
}
```

- [ ] **Step 2: Delegate `TextAnnotation.Author`**

Replace its getter/setter bodies:

```ts
  /** /T text label (the note's author); undefined when absent. */
  get Author(): string | undefined { return readTextString(this.doc, this.Dict, 'T'); }

  set Author(v: string | undefined) {
    this.touch();
    writeTextString(this.Dict, 'T', v, 'Author');
  }
```

- [ ] **Step 3: Delegate `RedactAnnotation.Author`**

Replace its getter/setter bodies with exactly the same two accessors:

```ts
  /** /T text label (who marked it); undefined when absent. */
  get Author(): string | undefined { return readTextString(this.doc, this.Dict, 'T'); }

  set Author(v: string | undefined) {
    this.touch();
    writeTextString(this.Dict, 'T', v, 'Author');
  }
```

- [ ] **Step 4: Run the suites that cover both classes**

Run: `npx vitest run test/annotation.test.ts test/annot-roundtrip.test.ts test/redact-annot.test.ts`
Expected: PASS. A behaviour change here shows up as a failure in one of these three.

- [ ] **Step 5: Typecheck and commit**

```bash
npm run typecheck
git add src/annotation.ts
git commit -m "refactor(annot): one /T accessor shared by Text and Redact (0pvw.2)"
```

---

### Task 2: `caretBody`

The drawing, as a pure function with no document access — testable without building a file.

**Files:**
- Modify: `src/annotdraw.ts`
- Modify: `test/annotdraw.test.ts`

**Interfaces:**
- Consumes: `WidgetGeom` (already imported by `annotdraw.ts` from `./appearance.js`).
- Produces: `caretBody(g: WidgetGeom, color: [number, number, number], symbol: 'none' | 'paragraph', rd?: number[]): string` exported from `src/annotdraw.ts`.

- [ ] **Step 1: Write the failing tests**

Append to `test/annotdraw.test.ts` (add `caretBody` to the existing `../src/annotdraw.js` import):

```ts
describe('caretBody', () => {
  const g = { w: 40, h: 20, rotate: 0 };

  it('draws a filled, curved wedge — not a plain triangle', () => {
    const body = caretBody(g, [0, 0, 0], 'none');
    expect(body).toContain('0 0 0 rg');           // fill colour
    expect(body.match(/ c\n/g)).toHaveLength(2);  // two curved sides
    expect(body).toContain('h f');                // closed and filled
    expect(body).not.toContain(' S');             // never stroked
  });

  it('curves the sides inward rather than straight to the apex', () => {
    // The left side runs (0,0) -> apex (20,20). A straight edge would put its
    // control points on that line; concave means both sit to the RIGHT of it,
    // which is the whole visual difference from a triangle.
    const body = caretBody(g, [0, 0, 0], 'none');
    const curve = body.split('\n').find((l) => l.endsWith(' c'))!;
    const [c1x, c1y, c2x, c2y] = curve.split(' ').map(Number);
    expect(c1x).toBeGreaterThan(c1y / 2); // line at height y has x = y/2
    expect(c2x).toBeGreaterThan(c2y / 2);
  });

  it('draws no text when the symbol is none', () => {
    expect(caretBody(g, [0, 0, 0], 'none')).not.toContain('Tj');
  });

  it('draws the paragraph sign naming the registered font key', () => {
    const body = caretBody(g, [0, 0, 0], 'paragraph');
    expect(body).toContain('Tj');
    // installShapeAP registers exactly one font, under the key F0. Naming /Helv
    // here would point at a resource that is not in the form (bug cu3b).
    expect(body).toContain('/F0 ');
    expect(body).not.toContain('/Helv');
  });

  it('narrows the caret to make room for the symbol', () => {
    const plain = caretBody(g, [0, 0, 0], 'none');
    const withSym = caretBody(g, [0, 0, 0], 'paragraph');
    const apexOf = (s: string) => Number(s.split('\n').find((l) => l.endsWith(' c'))!.split(' ')[4]);
    expect(apexOf(withSym)).toBeGreaterThan(apexOf(plain)); // apex pushed right
  });

  it('insets the drawing by /RD', () => {
    const plain = caretBody(g, [0, 0, 0], 'none');
    const inset = caretBody(g, [0, 0, 0], 'none', [4, 2, 4, 2]);
    expect(inset).not.toEqual(plain);
    expect(inset.startsWith('0 0 0 rg')).toBe(true);
    expect(inset).toContain('4 2 m'); // baseline starts at the inset corner
  });

  it('returns an empty body when /RD leaves no room', () => {
    expect(caretBody(g, [0, 0, 0], 'none', [30, 0, 30, 0])).toBe('');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/annotdraw.test.ts`
Expected: FAIL — `caretBody` is not exported.

- [ ] **Step 3: Add the imports**

At the top of `src/annotdraw.ts`, beside the existing imports:

```ts
import { measure } from './metrics.js';
import { encodeWinAnsi } from './encoding.js';
import { serializeString } from './serialize.js';
```

(`appearance.ts` already imports all three, so this introduces no cycle.)

- [ ] **Step 4: Implement**

In `src/annotdraw.ts`, after `drawEllipse`:

```ts
/** Fraction of the width the paragraph sign takes when /Sy is /P. */
const CARET_SYMBOL_SHARE = 0.4;

/** A text-insertion caret: a filled wedge whose two sides curve *inward* to a
 *  sharp apex, on a flat baseline — the proofreader's caret, not a triangle.
 *  With `symbol: 'paragraph'` a WinAnsi paragraph sign is drawn in the leftmost
 *  40% of the box and the caret takes the remaining 60%.
 *
 *  `rd` is the annotation's /RD, the difference between /Rect and the caret's
 *  own boundary. We never author one, but another producer may; applying it here
 *  keeps that rule in a single place rather than at each call site. */
export function caretBody(
  g: WidgetGeom, color: [number, number, number],
  symbol: 'none' | 'paragraph', rd?: number[],
): string {
  // /RD is [left, top, right, bottom] (32000-1 table 164).
  const [dl, dt, dr, db] = rd !== undefined && rd.length === 4 ? rd : [0, 0, 0, 0];
  const x = dl, y = db;
  const w = g.w - dl - dr, h = g.h - dt - db;
  if (w <= 0 || h <= 0) return ''; // nothing left to draw in

  const [r, gg, b] = color;
  let s = `${num(r)} ${num(gg)} ${num(b)} rg\n`;

  const cw = symbol === 'paragraph' ? w * (1 - CARET_SYMBOL_SHARE) : w;
  const x0 = symbol === 'paragraph' ? x + w * CARET_SYMBOL_SHARE : x;
  const x1 = x0 + cw, cx = x0 + cw / 2, y1 = y + h;

  // Control points sit inside the straight edge (linear would be 0.167w/0.333w
  // at these heights), which is what bows each side toward the centre.
  s += `${num(x0)} ${num(y)} m\n`;
  s += `${num(x0 + cw * 0.30)} ${num(y + h * 0.33)} ` +
       `${num(x0 + cw * 0.42)} ${num(y + h * 0.72)} ${num(cx)} ${num(y1)} c\n`;
  s += `${num(x1 - cw * 0.42)} ${num(y + h * 0.72)} ` +
       `${num(x1 - cw * 0.30)} ${num(y + h * 0.33)} ${num(x1)} ${num(y)} c\n`;
  s += 'h f\n';

  if (symbol === 'paragraph') {
    const size = h * 0.7;
    const bytes = encodeWinAnsi('¶');
    const tw = measure('Helvetica', bytes, size);
    const sx = x + Math.max(0, (w * CARET_SYMBOL_SHARE - tw) / 2);
    const sy = y + (h - size * 0.7) / 2;
    // /F0 is the key installShapeAP registers; /Helv would name nothing (cu3b).
    s += `BT\n/F0 ${num(size)} Tf\n${num(r)} ${num(gg)} ${num(b)} rg\n` +
         `${num(sx)} ${num(sy)} Td\n${serializeString(bytes)} Tj\nET\n`;
  }
  return s;
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run test/annotdraw.test.ts`
Expected: PASS, all suites in the file.

- [ ] **Step 6: Typecheck and commit**

```bash
npm run typecheck
git add src/annotdraw.ts test/annotdraw.test.ts
git commit -m "feat(annot): caretBody — concave-sided caret with optional paragraph sign (0pvw.2)"
```

---

### Task 3: `CaretAnnotation`, `addCaret`, `Page.AddCaret`

**Files:**
- Modify: `src/annotation.ts`, `src/page.ts`, `src/index.ts`
- Modify: `test/annotation.test.ts`

**Interfaces:**
- Consumes: `caretBody` (Task 2), `readTextString`/`writeTextString` (Task 1).
- Produces:
  - `class CaretAnnotation extends Annotation` with `Symbol: 'none' | 'paragraph'` and `Author: string | undefined`.
  - `interface CaretOptions { rect: [number, number, number, number]; symbol?: 'none' | 'paragraph'; color?: [number, number, number]; contents?: string; author?: string; opacity?: number; popup?: PopupSpec }`
  - `addCaret(doc: Document, page: Page, opts: CaretOptions): CaretAnnotation`
  - `Page.AddCaret(opts: CaretOptions): CaretAnnotation`

- [ ] **Step 1: Write the failing tests**

Append to `test/annotation.test.ts` (extend the `../src/annotation.js` import with `CaretAnnotation`; `buildBlankPage`, `isStream` and `isName` are already imported there — add `PdfDict`/`PdfStream` to the `../src/types.js` import and `inflateStream` from `../src/flate.js` if not already present):

```ts
describe('page.AddCaret', () => {
  const apBody = (doc: Document, a: { Dict: PdfDict }) => {
    const n = doc.resolve((doc.resolve(a.Dict.get('AP')) as PdfDict).get('N'));
    return new TextDecoder('latin1').decode(inflateStream(n as PdfStream));
  };

  it('writes the /Caret keys and returns a live handle', () => {
    const doc = Document.Open(buildBlankPage());
    const c = doc.Pages[0].AddCaret({
      rect: [72, 700, 92, 720], color: [0, 0, 1], contents: 'insert here', author: 'ed',
    });

    expect(c).toBeInstanceOf(CaretAnnotation);
    expect(c.Subtype).toBe('Caret');
    expect(c.Rect).toEqual([72, 700, 92, 720]);
    expect(c.Color).toEqual([0, 0, 1]);
    expect(c.Contents).toBe('insert here');
    expect(c.Author).toBe('ed');
    expect(c.Symbol).toBe('none');
    expect(isName(c.Dict.get('Sy')) && (c.Dict.get('Sy') as { name: string }).name).toBe('None');
  });

  it('round-trips through Save/Open as a CaretAnnotation', () => {
    const doc = Document.Open(buildBlankPage());
    doc.Pages[0].AddCaret({ rect: [72, 700, 92, 720], symbol: 'paragraph' });

    const back = Document.Open(doc.Save()).Pages[0].Annotations[0];
    expect(back).toBeInstanceOf(CaretAnnotation);
    expect((back as CaretAnnotation).Symbol).toBe('paragraph');
  });

  it('draws the paragraph sign only when asked, naming the registered font', () => {
    const doc = Document.Open(buildBlankPage());
    const plain = doc.Pages[0].AddCaret({ rect: [72, 700, 92, 720] });
    const sym = doc.Pages[0].AddCaret({ rect: [72, 660, 92, 680], symbol: 'paragraph' });

    expect(apBody(doc, plain)).not.toContain('Tj');
    const body = apBody(doc, sym);
    expect(body).toContain('Tj');
    // The operator must name the key fontResources actually registered — see cu3b.
    expect(body).toContain('/F0 ');
    const ap = doc.resolve((doc.resolve(sym.Dict.get('AP')) as PdfDict).get('N')) as PdfStream;
    const res = doc.resolve(ap.dict.get('Resources')) as PdfDict;
    const fonts = doc.resolve(res.get('Font')) as PdfDict;
    expect([...fonts.keys()]).toContain('F0');
  });

  it('reads an unrecognised /Sy as none rather than throwing', () => {
    const doc = Document.Open(buildBlankPage());
    const c = doc.Pages[0].AddCaret({ rect: [72, 700, 92, 720] });
    c.Dict.set('Sy', name('Wat'));
    expect(c.Symbol).toBe('none');
  });

  it('sets Symbol through the accessor', () => {
    const doc = Document.Open(buildBlankPage());
    const c = doc.Pages[0].AddCaret({ rect: [72, 700, 92, 720] });
    c.Symbol = 'paragraph';
    expect((c.Dict.get('Sy') as { name: string }).name).toBe('P');
    c.Symbol = 'none';
    expect((c.Dict.get('Sy') as { name: string }).name).toBe('None');
  });

  it('creates the annotation without an /AP for a degenerate rect', () => {
    const doc = Document.Open(buildBlankPage());
    const c = doc.Pages[0].AddCaret({ rect: [72, 700, 72, 700] });
    expect(c.Subtype).toBe('Caret');
    expect(c.Dict.has('AP')).toBe(false);
  });

  it('rejects bad input before adding anything', () => {
    const doc = Document.Open(buildBlankPage());
    const page = doc.Pages[0];
    expect(() => page.AddCaret({ rect: [1, 2, 3] as never })).toThrow(TypeError);
    expect(() => page.AddCaret({ rect: [0, 0, 10, 10], color: [2, 0, 0] })).toThrow(TypeError);
    expect(() => page.AddCaret({ rect: [0, 0, 10, 10], symbol: 'star' as never })).toThrow(TypeError);
    expect(() => page.AddCaret({ rect: [0, 0, 10, 10], opacity: 5 })).toThrow(TypeError);
    expect(page.Annotations).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/annotation.test.ts`
Expected: FAIL — `CaretAnnotation` is not exported and `AddCaret` is not a function.

- [ ] **Step 3: Add the `CaretAnnotation` class**

In `src/annotation.ts`, after `FreeTextAnnotation` and before `RedactAnnotation`:

```ts
/** A /Caret annotation (PDF 32000-1 §12.5.6.11): a text-insertion mark, drawn as
 *  a wedge at the point where text should be added, optionally with a paragraph
 *  sign. */
export class CaretAnnotation extends Annotation {
  /** /Sy symbol: 'paragraph' for /P, 'none' otherwise. An unrecognised name
   *  reads as 'none' — a foreign dict is not worth throwing over. */
  get Symbol(): 'none' | 'paragraph' {
    const s = this.Dict.get('Sy');
    return isName(s) && s.name === 'P' ? 'paragraph' : 'none';
  }

  set Symbol(v: 'none' | 'paragraph') {
    if (v !== 'none' && v !== 'paragraph')
      throw new TypeError("Symbol must be 'none' or 'paragraph'");
    this.touch();
    this.Dict.set('Sy', name(v === 'paragraph' ? 'P' : 'None'));
  }

  /** /T text label (who marked the insertion); undefined when absent. */
  get Author(): string | undefined { return readTextString(this.doc, this.Dict, 'T'); }

  set Author(v: string | undefined) {
    this.touch();
    writeTextString(this.Dict, 'T', v, 'Author');
  }
}
```

- [ ] **Step 4: Dispatch in `wrapAnnotation`**

In `wrapAnnotation`'s switch, beside the other cases:

```ts
    case 'Caret': return new CaretAnnotation(doc, dict);
```

- [ ] **Step 5: Add the options type and builder**

In `src/annotation.ts`, after `addSquare`/`addCircle`:

```ts
/** Options for Page.AddCaret. */
export interface CaretOptions {
  rect: [number, number, number, number];
  /** /Sy symbol drawn beside the caret. Default 'none'. */
  symbol?: 'none' | 'paragraph';
  /** /C colour, RGB 0..1. Default black [0,0,0]. */
  color?: [number, number, number];
  /** /Contents body text. */
  contents?: string;
  /** /T author label. */
  author?: string;
  /** /CA constant opacity, 0..1. */
  opacity?: number;
  /** Auto-attach a companion /Popup. */
  popup?: PopupSpec;
}

/** Build and attach a /Caret text-insertion annotation to `page`: a filled wedge
 *  marking where text should be inserted, with an optional paragraph sign.
 *  /RD is never written — our caret fills its /Rect, so the difference it would
 *  record is always zero, which is what an absent /RD already means. */
export function addCaret(doc: Document, page: Page, opts: CaretOptions): CaretAnnotation {
  const color = checkOptColor('color', opts.color) ?? [0, 0, 0];
  const opacity = checkOptOpacity(opts.opacity);
  const symbol = opts.symbol ?? 'none';
  if (symbol !== 'none' && symbol !== 'paragraph')
    throw new TypeError("symbol must be 'none' or 'paragraph'");
  if (opts.author !== undefined && typeof opts.author !== 'string')
    throw new TypeError('author must be a string');

  const dict = createAnnotation(doc, page, {
    subtype: 'Caret', rect: opts.rect, color, contents: opts.contents, popup: opts.popup,
  });
  const annot = new CaretAnnotation(doc, dict);
  annot.Symbol = symbol;
  if (opts.author !== undefined) annot.Author = opts.author;
  if (opacity !== undefined) annot.Opacity = opacity;

  const g = widgetGeom(doc, dict);
  if (g) installShapeAP(doc, dict, g, caretBody(g, color, symbol), opacity ?? 1);
  return annot;
}
```

Add `caretBody` to the existing `./annotdraw.js` import block at the top of the file.

Note `createAnnotation` validates `rect` (via `checkNums`) and `color` before allocating, and `checkOptColor`/`checkOptOpacity` run before it — so every rejection leaves the document untouched.

- [ ] **Step 6: Wire `Page.AddCaret`**

In `src/page.ts`, after `AddFreeText` (extend the `./annotation.js` import with `addCaret`, `CaretAnnotation`, `CaretOptions`):

```ts
  /** Add a /Caret annotation: a text-insertion mark, optionally with a
   *  paragraph sign. */
  AddCaret(opts: CaretOptions): CaretAnnotation {
    return addCaret(this.doc, this, opts);
  }
```

- [ ] **Step 7: Export from `src/index.ts`**

Add `CaretAnnotation` to the annotation class export line and the options type to the type export block:

```ts
export { Annotation, TextAnnotation, StampAnnotation, MarkupAnnotation, LinkAnnotation, FileAttachmentAnnotation, RedactAnnotation, CaretAnnotation } from './annotation.js';
export type {
  TextNoteOptions, StampAnnotationOptions, MarkupOptions, MarkupType,
  LinkOptions, LinkAction, FileAttachmentOptions, RedactAnnotationOptions, CaretOptions,
} from './annotation.js';
```

- [ ] **Step 8: Run the tests to verify they pass**

Run: `npx vitest run test/annotation.test.ts`
Expected: PASS, all suites in the file.

- [ ] **Step 9: Prove the font-key assertion is load-bearing**

It passes on the first run, which is not evidence — and the failure it guards is invisible in any viewer that falls back to a default font.

In `src/annotdraw.ts`, change `caretBody`'s text operator from `/F0` to `/Helv`:

```ts
    s += `BT\n/Helv ${num(size)} Tf\n${num(r)} ${num(gg)} ${num(b)} rg\n` +
```

Run: `npx vitest run test/annotation.test.ts test/annotdraw.test.ts`
Expected: RED — "draws the paragraph sign naming the registered font key" (annotdraw) and "draws the paragraph sign only when asked, naming the registered font" (annotation) both fail.

Then **revert the change** and re-run to confirm green. If either test stayed green, it is not covering what it claims and must be strengthened before moving on.

- [ ] **Step 10: Typecheck and commit**

```bash
npm run typecheck
git add src/annotation.ts src/page.ts src/index.ts test/annotation.test.ts
git commit -m "feat(annot): page.AddCaret authors a /Caret insertion mark (0pvw.2)"
```

---

### Task 4: Appearance regeneration

**Files:**
- Modify: `src/annotdraw.ts`
- Modify: `test/annotdraw.test.ts`

**Interfaces:**
- Consumes: `caretBody` (Task 2).
- Produces: no new exported names — `regenerateAppearance` keeps its signature `(doc: Document, dict: PdfDict) => boolean`.

- [ ] **Step 1: Write the failing tests**

Append to `test/annotdraw.test.ts`. The file already has the `attach(subtype, entries)` and `apBody(doc, dict)` helpers at the top — use them:

```ts
describe('regenerateAppearance — /Caret', () => {
  it('draws a caret from /Rect and /C', () => {
    const { doc, dict } = attach('Caret', [['Rect', [0, 0, 40, 20]], ['C', [1, 0, 0]]]);
    expect(regenerateAppearance(doc, dict)).toBe(true);
    const body = apBody(doc, dict);
    expect(body).toContain('1 0 0 rg');
    expect(body).toContain('h f');
    expect(body).not.toContain('Tj'); // /Sy absent → no symbol
  });

  it('honours /Sy /P', () => {
    const { doc, dict } = attach('Caret', [
      ['Rect', [0, 0, 40, 20]], ['C', [0, 0, 0]], ['Sy', name('P')],
    ]);
    expect(regenerateAppearance(doc, dict)).toBe(true);
    expect(apBody(doc, dict)).toContain('Tj');
  });

  it('honours /RD by drawing inside a smaller box', () => {
    const plain = attach('Caret', [['Rect', [0, 0, 40, 20]], ['C', [0, 0, 0]]]);
    const inset = attach('Caret', [
      ['Rect', [0, 0, 40, 20]], ['C', [0, 0, 0]], ['RD', [4, 2, 4, 2]],
    ]);
    expect(regenerateAppearance(plain.doc, plain.dict)).toBe(true);
    expect(regenerateAppearance(inset.doc, inset.dict)).toBe(true);
    expect(apBody(inset.doc, inset.dict)).not.toEqual(apBody(plain.doc, plain.dict));
    expect(apBody(inset.doc, inset.dict)).toContain('4 2 m');
  });

  it('returns false when /RD leaves nothing to draw', () => {
    const { doc, dict } = attach('Caret', [
      ['Rect', [0, 0, 40, 20]], ['C', [0, 0, 0]], ['RD', [30, 0, 30, 0]],
    ]);
    expect(regenerateAppearance(doc, dict)).toBe(false);
    expect(dict.has('AP')).toBe(false);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/annotdraw.test.ts`
Expected: FAIL — `regenerateAppearance` hits its `default: return false` for `/Caret`.

- [ ] **Step 3: Add the switch case**

In `src/annotdraw.ts`, in `regenerateAppearance`'s switch, after the `FreeText` case and before `default`:

```ts
    case 'Caret': {
      const sy = doc.resolve(dict.get('Sy'));
      const symbol = isName(sy) && sy.name === 'P' ? 'paragraph' : 'none';
      const rd = numsOf(doc, dict.get('RD'));
      body = caretBody(g, color, symbol, rd.length === 4 ? rd : undefined);
      if (body === '') return false; // /RD left no room
      break;
    }
```

`numsOf`, `colorOf` and `isName` are already in scope in this file.

- [ ] **Step 4: Update the doc comment**

`regenerateAppearance`'s doc comment still lists `/Caret` among the subtypes with no generator. Change that sentence:

```ts
 *  Returns false when this subtype has no generator (/Text and /Stamp are
 *  viewer-drawn or carry their content only in an appearance we do not have;
 *  /Link, /Popup, /Sound and /FileAttachment likewise), or when the
 *  geometry is too degenerate or malformed to draw. In every false case the
 *  dict is left untouched, without an /AP — better an annotation with no
 *  appearance than one drawn from a guess. */
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run test/annotdraw.test.ts`
Expected: PASS, all suites in the file.

- [ ] **Step 6: Typecheck and commit**

```bash
npm run typecheck
git add src/annotdraw.ts test/annotdraw.test.ts
git commit -m "feat(annot): regenerate a /Caret appearance from /Sy and /RD (0pvw.2)"
```

---

### Task 5: Documentation and wrap-up

**Files:**
- Modify: `README.md`, `CLAUDE.md`

**Interfaces:**
- Consumes: everything from Tasks 1–4. Produces no new names.

- [ ] **Step 1: Add the README example**

In the annotations example block (around `README.md:1327`, beside the `AddFreeText` lines), add:

```ts
page.AddCaret({ rect: [72, 340, 84, 356], symbol: 'paragraph', contents: 'insert a clause here' });
```

- [ ] **Step 2: Add the README API-table row**

In the annotation API table (around `README.md:1604`, beside the `page.AddFreeText(opts)` row):

```
| `page.AddCaret(opts)` | Add a `/Caret` text-insertion mark, optionally with a paragraph sign (`/Sy`) |
```

- [ ] **Step 3: Update the two README lines that call /Caret ungenerated**

In the annotation-subtypes limitation bullet (around `README.md:1660`), `/Caret` must move from the unsupported list into the supported list. The supported list currently ends `..., '/Popup', and '/Redact'`; make it `..., '/Popup', '/Redact', and '/Caret'`, and delete `/Caret` from the "Remaining subtypes" parenthetical if it appears there.

In the XFDF appearance bullet (around `README.md:1695`), the sentence reads "Subtypes with no generator (`Sound`, `Caret`, `Text`, `Stamp`, `Link`, `FileAttachment`, `Popup`) import without an appearance in that case." Remove `Caret` from that list.

- [ ] **Step 4: Update CLAUDE.md**

In the `annotation.ts` bullet of the Architecture Overview, add `Caret` to the list of typed subclasses — it currently reads `Text`/`Stamp`/`Markup`/`Link`/`Redact` subclasses. Make it `Text`/`Stamp`/`Markup`/`Link`/`Redact`/`Caret`.

Then extend the sentence about shared accessors, which currently names `QuadPoints`, `Alignment`, `InteriorColor` and the `/DA` read, to also name `/T`:

```
  `QuadPoints`, `Alignment`, `InteriorColor`, `/T` and the `/DA` read are
  module-private helpers the subclasses delegate to, since several of them need
  overlapping subsets and TypeScript has single inheritance.
```

- [ ] **Step 5: Run the full suite and typecheck**

```bash
npm run typecheck
npm test
```
Expected: both green. Investigate any failure before continuing — do not proceed on a red suite.

- [ ] **Step 6: Commit**

```bash
git add README.md CLAUDE.md
git commit -m "docs(annot): document page.AddCaret and /Caret regeneration (0pvw.2)"
```

- [ ] **Step 7: Close the issue and the epic**

`0pvw.2` is the last child of epic `0pvw`, so both close:

```bash
bd close aspose-pdf-foss-for-ts-0pvw.2
bd close aspose-pdf-foss-for-ts-0pvw
```

- [ ] **Step 8: Push**

```bash
git pull --rebase
git push
git status   # MUST show "up to date with origin"
```

Note `.beads/` is tracked in this repo — commit the bd bookkeeping change (`chore(bd): close 0pvw.2, close epic 0pvw`) before pushing if `git status` shows one.

---

## Self-Review

**Spec coverage:**

| Spec section | Task |
|---|---|
| `Page.AddCaret` + options table | 3 |
| `CaretAnnotation` with `Symbol` and `Author` | 3 |
| Unrecognised `/Sy` reads as `'none'` | 3 |
| `/RD` read, never written | 2 (read in `caretBody`), 3 (never authored), 4 (regeneration) |
| Concave-sided filled wedge | 2 |
| 40/60 split and the ¶ glyph | 2 |
| Font key must be `F0`, not `/Helv` (`cu3b`) | 2, 3 (asserted), 3 Step 9 (mutation-checked) |
| `regenerateAppearance` case + doc comment | 4 |
| `/T` accessor consolidation | 1 |
| Error table (bad rect/colour/symbol/opacity, degenerate rect) | 3 |
| Testing assertions 1–10 | 2, 3, 4 |
| README + CLAUDE.md updates | 5 |

No gaps.

**Type consistency:** `caretBody(g, color, symbol, rd?)` is defined in Task 2 and called in Task 3 (`caretBody(g, color, symbol)`) and Task 4 (`caretBody(g, color, symbol, rd)`) with matching arities. `CaretOptions.symbol` and `CaretAnnotation.Symbol` share the `'none' | 'paragraph'` union throughout. `readTextString`/`writeTextString` are defined in Task 1 and used in Task 3. `CaretAnnotation` is exported in Task 3 and referenced by the Task 3 tests only.

**One codebase check the plan asks for rather than assuming:** Task 3 Step 1 says to extend `test/annotation.test.ts`'s imports "if not already present" — that file already imports `Document`, `buildBlankPage`, `isName` and `isStream`, but the implementer should confirm `inflateStream`, `PdfDict` and `PdfStream` before adding duplicates.

# Redact Annotation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `/Redact` annotation type that *marks* a region without destroying anything, plus an `ApplyRedactions` step that consumes those marks through the existing destructive pipeline and paints each mark's overlay.

**Architecture:** `annotation.ts` gains the `RedactAnnotation` handle and the `addRedact` builder (mark side); `annotdraw.ts` gains the pending-mark outline; a new `redactapply.ts` owns the apply side — collecting marks, driving `redact.ts`, painting overlays. `redact.ts` gets one seam (`redactRegions`) so the destructive ordering lives in exactly one place and both painters share it.

**Tech Stack:** TypeScript (strict, ESM/NodeNext), vitest, `node:` built-ins only.

**Spec:** `docs/superpowers/specs/2026-08-05-redact-annotation-design.md`
**Issue:** `aspose-pdf-foss-for-ts-0pvw.1` (already claimed)

## Global Constraints

- **Zero runtime dependencies.** Only `node:` built-ins (`zlib`, `crypto`, `fs`). Do not add npm runtime deps.
- **ESM + NodeNext, strict TypeScript.** Every import specifier carries the `.js` extension (`import { Page } from './page.js'`).
- **Task tracking is `bd`.** Do NOT use TodoWrite, TaskCreate, or markdown TODO lists. This plan's checkboxes are the per-task tracking.
- **Public error types only:** `PdfParseError`, `UnsupportedFeatureError`, `InvalidPasswordError` from `errors.ts`. Argument validation uses plain `TypeError`, matching the rest of the `Add*` family.
- **Validate before allocating.** Every `Add*` entry point validates all arguments before the first `createAnnotation`/`allocObject` call, so a rejected call leaves the document byte-identical.
- **Both gates green before the issue closes:** `npm run typecheck` and `npm test`.
- Tests live in `test/`, fixture builders in `test/helpers/`. Mirror the existing builder/test style.
- Commit after every task. Do not push until the final task.

## File Structure

| File | Responsibility |
|---|---|
| `src/annotation.ts` (modify) | `RedactAnnotation`, `RedactAnnotationOptions`, `addRedact`, `rectToQuad`, `wrapAnnotation` dispatch, shared accessor helpers |
| `src/annotdraw.ts` (modify) | `redactMarkBody` — the pending-mark outline body |
| `src/redact.ts` (modify) | `redactRegions` seam; `redactPage` becomes its first caller |
| `src/redactapply.ts` (**create**) | `applyRedactions`, `paintRedactOverlay`, `markRedactText`, `redactRects` |
| `src/page.ts` (modify) | `AddRedact`, `MarkRedactText`, `ApplyRedactions` |
| `src/document.ts` (modify) | `MarkRedactText`, `ApplyRedactions` mirrors |
| `src/index.ts` (modify) | public exports |
| `test/helpers/build-redact-annot.ts` (**create**) | hand-written `/Redact` fixtures (foreign-producer shapes) |
| `test/redact-annot.test.ts` (**create**) | mark side: authoring, round-trip, non-destructiveness |
| `test/redact-apply.test.ts` (**create**) | apply side: destruction, overlay, `/RO`, `/Repeat`, errors |
| `README.md`, `CLAUDE.md` (modify) | user-facing docs, architecture note |

---

### Task 1: Shared accessors and the `RedactAnnotation` read model

`QuadPoints` lives on `MarkupAnnotation`, `Alignment`/`InteriorColor`/`da()` on `FreeTextAnnotation`. `RedactAnnotation` needs all four and TypeScript has single inheritance, so the bodies move to module-private helpers that all three classes delegate to.

**Files:**
- Modify: `src/annotation.ts`
- Create: `test/helpers/build-redact-annot.ts`
- Create: `test/redact-annot.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `class RedactAnnotation extends Annotation` with `QuadPoints: number[]`, `InteriorColor: [number,number,number] | undefined`, `Alignment: 'left'|'center'|'right'`, `OverlayText: string | undefined`, `Repeat: boolean`, `FontSize: number`, `TextColor: [number,number,number]`, `Author: string | undefined`, and a read-only `Overlay: PdfStream | undefined`. Exported from `src/annotation.ts`.

- [ ] **Step 1: Write the fixture builder**

Create `test/helpers/build-redact-annot.ts`. Copy the `serialize`/`enc`/`byteLen` preamble from `test/helpers/build-annot-target.ts` (same file-local helpers, same style) and add:

```ts
/** A page carrying one hand-written /Redact annotation with every key set —
 *  the shape another producer writes, which our reader must accept. */
export function buildRedactReadTarget(): Uint8Array {
  const objects: Record<number, string> = {
    1: `<< /Type /Catalog /Pages 2 0 R >>`,
    2: `<< /Type /Pages /Count 1 /Kids [3 0 R] /MediaBox [0 0 300 300] >>`,
    3: `<< /Type /Page /Parent 2 0 R /Resources << >> /Annots [4 0 R] >>`,
    4: `<< /Type /Annot /Subtype /Redact /Rect [50 100 200 130] ` +
       `/QuadPoints [50 130 200 130 50 100 200 100] ` +
       `/IC [0 0 1] /C [1 0 0] /OverlayText (CLASSIFIED) /Repeat true /Q 1 ` +
       `/DA (/Helv 9 Tf 1 1 1 rg) /T (auditor) /Contents (why) >>`,
  };
  return serialize(objects, 4);
}
```

- [ ] **Step 2: Write the failing test**

Create `test/redact-annot.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { RedactAnnotation } from '../src/annotation.js';
import { buildRedactReadTarget } from './helpers/build-redact-annot.js';

describe('RedactAnnotation read model', () => {
  it('wraps a /Redact annotation and exposes every key', () => {
    const doc = Document.Open(buildRedactReadTarget());
    const a = doc.Pages[0].Annotations[0];
    expect(a).toBeInstanceOf(RedactAnnotation);

    const r = a as RedactAnnotation;
    expect(r.Subtype).toBe('Redact');
    expect(r.QuadPoints).toEqual([50, 130, 200, 130, 50, 100, 200, 100]);
    expect(r.InteriorColor).toEqual([0, 0, 1]);
    expect(r.OverlayText).toBe('CLASSIFIED');
    expect(r.Repeat).toBe(true);
    expect(r.Alignment).toBe('center');
    expect(r.FontSize).toBe(9);
    expect(r.TextColor).toEqual([1, 1, 1]);
    expect(r.Author).toBe('auditor');
    expect(r.Overlay).toBeUndefined();
  });

  it('round-trips setter writes through Save/Open', () => {
    const doc = Document.Open(buildRedactReadTarget());
    const r = doc.Pages[0].Annotations[0] as RedactAnnotation;
    r.OverlayText = 'REDACTED';
    r.Alignment = 'right';
    r.Repeat = false;
    r.InteriorColor = [1, 0, 0];

    const back = Document.Open(doc.Save()).Pages[0].Annotations[0] as RedactAnnotation;
    expect(back.OverlayText).toBe('REDACTED');
    expect(back.Alignment).toBe('right');
    expect(back.Repeat).toBe(false);
    expect(back.InteriorColor).toEqual([1, 0, 0]);
  });

  it('rejects malformed QuadPoints without writing them', () => {
    const doc = Document.Open(buildRedactReadTarget());
    const r = doc.Pages[0].Annotations[0] as RedactAnnotation;
    expect(() => { r.QuadPoints = [1, 2, 3]; }).toThrow(TypeError);
    expect(r.QuadPoints).toEqual([50, 130, 200, 130, 50, 100, 200, 100]);
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx vitest run test/redact-annot.test.ts`
Expected: FAIL — `RedactAnnotation` is not exported from `../src/annotation.js`.

- [ ] **Step 4: Extract the shared accessor helpers**

In `src/annotation.ts`, add these module-private helpers just above `class MarkupAnnotation` (they use `numArray`, `checkNums`, `parseDA`, `buildDA`, all already in the file — note `buildDA` is defined further down at the old line ~471, which is fine, function declarations hoist):

```ts
/** /QuadPoints as a flat list of 8·n finite numbers; [] when absent. Shared by
 *  MarkupAnnotation and RedactAnnotation — one copy of the grammar. */
function readQuadPoints(doc: Document, dict: PdfDict): number[] {
  const a = doc.resolve(dict.get('QuadPoints'));
  if (!isArray(a)) return [];
  const out: number[] = [];
  for (const e of a) { const v = doc.resolve(e); if (typeof v === 'number') out.push(v); }
  return out;
}

/** Validate and write /QuadPoints: a non-empty list of finite numbers, 8·n. */
function writeQuadPoints(dict: PdfDict, q: number[]): void {
  if (!Array.isArray(q) || q.length === 0 || q.length % 8 !== 0 ||
      !q.every((x) => typeof x === 'number' && Number.isFinite(x)))
    throw new TypeError('QuadPoints must be a non-empty list of finite numbers, length a multiple of 8');
  dict.set('QuadPoints', [...q]);
}

/** /Q justification as 'left' | 'center' | 'right' (0/1/2). */
function readAlignment(doc: Document, dict: PdfDict): 'left' | 'center' | 'right' {
  const q = doc.resolve(dict.get('Q'));
  return q === 1 ? 'center' : q === 2 ? 'right' : 'left';
}

function writeAlignment(dict: PdfDict, v: 'left' | 'center' | 'right'): void {
  dict.set('Q', v === 'center' ? 1 : v === 'right' ? 2 : 0);
}

/** /IC interior colour [r,g,b] in 0..1; undefined when absent. */
function readInteriorColor(doc: Document, dict: PdfDict): [number, number, number] | undefined {
  const c = numArray(doc, dict.get('IC'), 3);
  return c ? [c[0], c[1], c[2]] : undefined;
}

function writeInteriorColor(dict: PdfDict, v: [number, number, number] | undefined): void {
  if (v === undefined) { dict.delete('IC'); return; }
  const c = checkNums('InteriorColor', v, 3);
  if (c.some((x) => x < 0 || x > 1)) throw new TypeError('InteriorColor components must be in 0..1');
  dict.set('IC', c);
}

/** Parsed /DA (font resource name, size, colour); Helv/0/black when absent. */
function readDA(doc: Document, dict: PdfDict): { fontName: string; size: number; color: [number, number, number] } {
  const s = doc.resolve(dict.get('DA'));
  return parseDA(isString(s) ? new TextDecoder('latin1').decode(s.bytes) : '');
}
```

- [ ] **Step 5: Delegate the existing classes to the helpers**

In `MarkupAnnotation`, replace the `QuadPoints` getter/setter bodies:

```ts
  /** /QuadPoints as a flat list of 8·n finite numbers; [] when absent. */
  get QuadPoints(): number[] { return readQuadPoints(this.doc, this.Dict); }

  set QuadPoints(q: number[]) { writeQuadPoints(this.Dict, q); this.touch(); }
```

In `FreeTextAnnotation`, replace the private `da()` and the `Alignment` / `InteriorColor` bodies:

```ts
  private da(): { fontName: string; size: number; color: [number, number, number] } {
    return readDA(this.doc, this.Dict);
  }

  /** /Q text justification as 'left' | 'center' | 'right' (0/1/2). */
  get Alignment(): 'left' | 'center' | 'right' { return readAlignment(this.doc, this.Dict); }

  set Alignment(v: 'left' | 'center' | 'right') { this.touch(); writeAlignment(this.Dict, v); }

  /** /IC interior (box background) color [r,g,b] in 0..1; undefined when absent. */
  get InteriorColor(): [number, number, number] | undefined {
    return readInteriorColor(this.doc, this.Dict);
  }

  set InteriorColor(v: [number, number, number] | undefined) {
    this.touch();
    writeInteriorColor(this.Dict, v);
  }
```

- [ ] **Step 6: Add the `RedactAnnotation` class**

In `src/annotation.ts`, immediately after `FreeTextAnnotation` (before `PopupAnnotation`):

```ts
/** A /Redact annotation (PDF 32000-1 §12.5.6.23): a *mark* over a region, plus
 *  the overlay to paint when it is applied. Marking removes nothing — see
 *  `Page.ApplyRedactions`. */
export class RedactAnnotation extends Annotation {
  /** /QuadPoints as a flat list of 8·n finite numbers; [] when absent. */
  get QuadPoints(): number[] { return readQuadPoints(this.doc, this.Dict); }
  set QuadPoints(q: number[]) { writeQuadPoints(this.Dict, q); this.touch(); }

  /** /IC — the colour painted over the region on apply; undefined when absent. */
  get InteriorColor(): [number, number, number] | undefined {
    return readInteriorColor(this.doc, this.Dict);
  }
  set InteriorColor(v: [number, number, number] | undefined) {
    this.touch();
    writeInteriorColor(this.Dict, v);
  }

  /** /Q justification of the overlay text. */
  get Alignment(): 'left' | 'center' | 'right' { return readAlignment(this.doc, this.Dict); }
  set Alignment(v: 'left' | 'center' | 'right') { this.touch(); writeAlignment(this.Dict, v); }

  /** /OverlayText drawn over the filled region on apply; undefined when absent. */
  get OverlayText(): string | undefined {
    const s = this.doc.resolve(this.Dict.get('OverlayText'));
    return isString(s) ? decodePdfText(s.bytes) : undefined;
  }
  set OverlayText(v: string | undefined) {
    this.touch();
    if (v === undefined) { this.Dict.delete('OverlayText'); return; }
    if (typeof v !== 'string') throw new TypeError('OverlayText must be a string');
    this.Dict.set('OverlayText', pdfText(v));
  }

  /** /Repeat — tile the overlay text to fill the region. False when absent. */
  get Repeat(): boolean { return this.doc.resolve(this.Dict.get('Repeat')) === true; }
  set Repeat(v: boolean) {
    if (typeof v !== 'boolean') throw new TypeError('Repeat must be a boolean');
    this.touch();
    this.Dict.set('Repeat', v);
  }

  /** /DA font size (0 = auto). */
  get FontSize(): number { return readDA(this.doc, this.Dict).size; }
  set FontSize(v: number) {
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0)
      throw new TypeError('FontSize must be a non-negative finite number');
    this.touch();
    const d = readDA(this.doc, this.Dict);
    this.Dict.set('DA', buildDA(d.fontName, v, d.color));
  }

  /** /DA fill colour [r,g,b] in 0..1 — the overlay text colour. */
  get TextColor(): [number, number, number] { return readDA(this.doc, this.Dict).color; }
  set TextColor(v: [number, number, number]) {
    const c = checkNums('TextColor', v, 3);
    if (c.some((x) => x < 0 || x > 1)) throw new TypeError('TextColor components must be in 0..1');
    this.touch();
    const d = readDA(this.doc, this.Dict);
    this.Dict.set('DA', buildDA(d.fontName, d.size, [c[0], c[1], c[2]]));
  }

  /** /T text label (who marked it); undefined when absent. */
  get Author(): string | undefined {
    const s = this.doc.resolve(this.Dict.get('T'));
    return isString(s) ? decodePdfText(s.bytes) : undefined;
  }
  set Author(v: string | undefined) {
    this.touch();
    if (v === undefined) { this.Dict.delete('T'); return; }
    if (typeof v !== 'string') throw new TypeError('Author must be a string');
    this.Dict.set('T', pdfText(v));
  }

  /** /RO overlay appearance form XObject; undefined when absent. Read-only: we
   *  honour one another producer wrote, but never author one — /IC plus
   *  /OverlayText already say what it would say. */
  get Overlay(): PdfStream | undefined {
    const s = this.doc.resolve(this.Dict.get('RO'));
    return isStream(s) ? s : undefined;
  }
}
```

Add `isStream` to the `./types.js` import list at the top of the file if it is not already there.

- [ ] **Step 7: Dispatch in `wrapAnnotation`**

In `wrapAnnotation`'s switch, beside the other cases:

```ts
    case 'Redact': return new RedactAnnotation(doc, dict);
```

- [ ] **Step 8: Run the tests to verify they pass**

Run: `npx vitest run test/redact-annot.test.ts test/annotation.test.ts test/annot-roundtrip.test.ts`
Expected: PASS. The two existing suites are the regression proof that the helper extraction preserved `MarkupAnnotation.QuadPoints` and `FreeTextAnnotation.Alignment`/`InteriorColor`.

- [ ] **Step 9: Typecheck and commit**

```bash
npm run typecheck
git add src/annotation.ts test/helpers/build-redact-annot.ts test/redact-annot.test.ts
git commit -m "feat(annot): RedactAnnotation read model over shared accessors (0pvw.1)"
```

---

### Task 2: The pending-mark outline body

**Files:**
- Modify: `src/annotdraw.ts`
- Modify: `test/annotdraw.test.ts`

**Interfaces:**
- Consumes: `QuadCorners` (already exported from `annotdraw.ts`).
- Produces: `redactMarkBody(qs: QuadCorners[], color: [number, number, number]): string` exported from `src/annotdraw.ts`.

- [ ] **Step 1: Write the failing test**

Append to `test/annotdraw.test.ts` (add `redactMarkBody` to the existing `../src/annotdraw.js` import):

```ts
describe('redactMarkBody', () => {
  const quad = { x1: 0, y1: 10, x2: 20, y2: 10, x3: 0, y3: 0, x4: 20, y4: 0 };

  it('strokes the quad outline and never fills it', () => {
    const body = redactMarkBody([quad], [1, 0, 0]);
    expect(body).toContain('1 0 0 RG');   // stroke colour
    expect(body).toContain('h S');        // closed, stroked
    expect(body).not.toContain(' rg');    // no fill colour set
    expect(body).not.toMatch(/\bf\b/);    // no fill op
  });

  it('emits one closed subpath per quad', () => {
    const body = redactMarkBody([quad, quad], [0, 0, 0]);
    expect(body.match(/ m /g)).toHaveLength(2);
    expect(body.match(/h S/g)).toHaveLength(2);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/annotdraw.test.ts`
Expected: FAIL — `redactMarkBody` is not exported.

- [ ] **Step 3: Implement**

In `src/annotdraw.ts`, after `drawSquiggly`:

```ts
/** Pending redaction mark: stroke each quad's outline in the mark colour and
 *  fill nothing, so the content underneath stays readable.
 *
 *  It must not look like an applied redaction. Both the renderers and
 *  FlattenAnnotations composite /AP /N, so a filled preview would render a page
 *  whose text is still fully extractable as though it were already redacted. */
export function redactMarkBody(qs: QuadCorners[], color: [number, number, number]): string {
  const [r, g, b] = color;
  let s = `${num(r)} ${num(g)} ${num(b)} RG\n1 w\n`;
  for (const q of qs) {
    // Same TL→TR→BR→BL corner order as drawHighlight.
    s += `${num(q.x1)} ${num(q.y1)} m ${num(q.x2)} ${num(q.y2)} l ` +
      `${num(q.x4)} ${num(q.y4)} l ${num(q.x3)} ${num(q.y3)} l h S\n`;
  }
  return s;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/annotdraw.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/annotdraw.ts test/annotdraw.test.ts
git commit -m "feat(annot): redactMarkBody, the pending-mark outline (0pvw.1)"
```

---

### Task 3: `addRedact` and `Page.AddRedact`

The mark side, end to end. The load-bearing test here is that marking removes nothing.

**Files:**
- Modify: `src/annotation.ts`, `src/page.ts`, `src/index.ts`
- Modify: `test/redact-annot.test.ts`

**Interfaces:**
- Consumes: `RedactAnnotation` (Task 1), `redactMarkBody` (Task 2).
- Produces:
  - `interface RedactAnnotationOptions` with optional `quads`, `rect`, `color`, `fill`, `overlayText`, `repeat`, `align`, `fontSize`, `textColor`, `contents`, `author`, `opacity`, `popup`.
  - `addRedact(doc: Document, page: Page, opts: RedactAnnotationOptions): RedactAnnotation`
  - `rectToQuad(r: [number, number, number, number]): number[]`
  - `Page.AddRedact(opts: RedactAnnotationOptions): RedactAnnotation`

- [ ] **Step 1: Write the failing tests**

Append to `test/redact-annot.test.ts` (extend the imports with `buildMultiStreamPage` from `./helpers/build-edit-pdf.js`):

```ts
describe('page.AddRedact', () => {
  const page1 = () => Document.Open(
    buildMultiStreamPage(['BT /F1 10 Tf 50 100 Td (TopSecret) Tj ET']));

  it('writes every /Redact key and returns a live handle', () => {
    const doc = page1();
    const r = doc.Pages[0].AddRedact({
      rect: [40, 95, 200, 115], fill: [0, 0, 0], overlayText: 'REDACTED',
      align: 'center', fontSize: 8, textColor: [1, 1, 1], author: 'auditor',
    });

    expect(r).toBeInstanceOf(RedactAnnotation);
    expect(r.Subtype).toBe('Redact');
    expect(r.Rect).toEqual([40, 95, 200, 115]);
    expect(r.QuadPoints).toEqual([40, 115, 200, 115, 40, 95, 200, 95]);
    expect(r.InteriorColor).toEqual([0, 0, 0]);
    expect(r.OverlayText).toBe('REDACTED');
    expect(r.Alignment).toBe('center');
    expect(r.FontSize).toBe(8);
    expect(r.Author).toBe('auditor');
    expect(r.Color).toEqual([1, 0, 0]); // mark outline defaults to red
  });

  it('MARKING REMOVES NOTHING — the text survives a save/open round trip', () => {
    // The assertion this whole feature exists to keep true. If AddRedact ever
    // starts deleting content, mark mode has silently become apply mode.
    const doc = page1();
    doc.Pages[0].AddRedact({ rect: [40, 95, 200, 115], overlayText: 'REDACTED' });

    const back = Document.Open(doc.Save());
    expect(back.Pages[0].GetText()).toContain('TopSecret');
    expect(back.Pages[0].Annotations).toHaveLength(1);
  });

  it('installs a stroked, unfilled /AP so a mark cannot pass for a redaction', () => {
    const doc = page1();
    const r = doc.Pages[0].AddRedact({ rect: [40, 95, 200, 115] });
    const ap = doc.resolve((doc.resolve(r.Dict.get('AP')) as PdfDict).get('N'));
    expect(isStream(ap)).toBe(true);
    const body = new TextDecoder('latin1').decode(inflateStream(ap as PdfStream));
    expect(body).toContain('1 0 0 RG');
    expect(body).not.toContain(' rg');
  });

  it('rejects quads and rect together, adding no annotation', () => {
    const doc = page1();
    expect(() => doc.Pages[0].AddRedact({
      rect: [0, 0, 10, 10], quads: [0, 10, 10, 10, 0, 0, 10, 0],
    })).toThrow(TypeError);
    expect(doc.Pages[0].Annotations).toHaveLength(0);
  });

  it('rejects neither quads nor rect, adding no annotation', () => {
    const doc = page1();
    expect(() => doc.Pages[0].AddRedact({})).toThrow(TypeError);
    expect(doc.Pages[0].Annotations).toHaveLength(0);
  });

  it('rejects a bad fill colour before allocating anything', () => {
    const doc = page1();
    expect(() => doc.Pages[0].AddRedact({
      rect: [0, 0, 10, 10], fill: [2, 0, 0],
    })).toThrow(TypeError);
    expect(doc.Pages[0].Annotations).toHaveLength(0);
  });
});
```

Add to that file's imports: `import { isStream, PdfDict, PdfStream } from '../src/types.js';` and `import { inflateStream } from '../src/flate.js';`.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/redact-annot.test.ts`
Expected: FAIL — `AddRedact` is not a function on `Page`.

- [ ] **Step 3: Add the options type and builder**

In `src/annotation.ts`, after `addFreeText`:

```ts
/** Options for Page.AddRedact. Exactly one of `quads` or `rect`.
 *  (Named distinctly from `RedactOptions` in redact.ts, which configures the
 *  unrelated destructive `Redact`.) */
export interface RedactAnnotationOptions {
  /** /QuadPoints: 8·n finite numbers (4 corner points per marked quad). */
  quads?: number[];
  /** Single-region convenience, expanded to one quad. */
  rect?: [number, number, number, number];
  /** /C colour of the pending-mark outline, RGB 0..1. Default red [1,0,0]. */
  color?: [number, number, number];
  /** /IC colour painted over the region on apply, RGB 0..1. Default black. */
  fill?: [number, number, number];
  /** /OverlayText drawn over the filled region on apply. */
  overlayText?: string;
  /** /Repeat — tile the overlay text to fill the region. Default false. */
  repeat?: boolean;
  /** /Q overlay-text justification. Default 'left'. */
  align?: 'left' | 'center' | 'right';
  /** /DA overlay-text font size. Default 12. */
  fontSize?: number;
  /** /DA overlay-text colour, RGB 0..1. Default white [1,1,1]. */
  textColor?: [number, number, number];
  /** /Contents body text. */
  contents?: string;
  /** /T author label. */
  author?: string;
  /** /CA constant opacity, 0..1. */
  opacity?: number;
  /** Auto-attach a companion /Popup. */
  popup?: PopupSpec;
}

/** @internal One /QuadPoints quad covering `r`, in the TL, TR, BL, BR order
 *  PDF 32000-1 §12.5.6.10 specifies. Shared with markRedactText, which turns
 *  each search hit's line box into a quad. */
export function rectToQuad(r: [number, number, number, number]): number[] {
  const x0 = Math.min(r[0], r[2]), y0 = Math.min(r[1], r[3]);
  const x1 = Math.max(r[0], r[2]), y1 = Math.max(r[1], r[3]);
  return [x0, y1, x1, y1, x0, y0, x1, y0];
}

/** Build and attach a /Redact annotation to `page`. This *marks* the region and
 *  removes nothing; `Page.ApplyRedactions` is what destroys the content. The
 *  installed /AP outlines each quad rather than filling it, so an unapplied mark
 *  never renders like a finished redaction. */
export function addRedact(doc: Document, page: Page, opts: RedactAnnotationOptions): RedactAnnotation {
  const hasQuads = opts.quads !== undefined, hasRect = opts.rect !== undefined;
  if (hasQuads === hasRect)
    throw new TypeError('AddRedact requires exactly one of quads or rect');
  const quads = hasQuads
    ? checkQuads(opts.quads as number[])
    : rectToQuad(checkNums('rect', opts.rect as number[], 4) as [number, number, number, number]);

  const color = checkOptColor('color', opts.color) ?? [1, 0, 0];
  const fill = checkOptColor('fill', opts.fill) ?? [0, 0, 0];
  const textColor = checkOptColor('textColor', opts.textColor) ?? [1, 1, 1];
  const opacity = checkOptOpacity(opts.opacity);
  const fontSize = opts.fontSize ?? 12;
  if (typeof fontSize !== 'number' || !Number.isFinite(fontSize) || fontSize <= 0)
    throw new TypeError('fontSize must be a positive finite number');
  const align = opts.align ?? 'left';
  if (align !== 'left' && align !== 'center' && align !== 'right')
    throw new TypeError("align must be 'left', 'center', or 'right'");
  if (opts.overlayText !== undefined && typeof opts.overlayText !== 'string')
    throw new TypeError('overlayText must be a string');
  if (opts.repeat !== undefined && typeof opts.repeat !== 'boolean')
    throw new TypeError('repeat must be a boolean');
  if (opts.author !== undefined && typeof opts.author !== 'string')
    throw new TypeError('author must be a string');

  const { minX, minY, maxX, maxY } = quadsBBox(quads);
  const dict = createAnnotation(doc, page, {
    subtype: 'Redact',
    rect: [minX, minY, maxX, maxY],
    color,
    contents: opts.contents,
    popup: opts.popup,
  });
  const annot = new RedactAnnotation(doc, dict);
  annot.QuadPoints = quads;
  annot.InteriorColor = fill;
  annot.Alignment = align;
  dict.set('DA', buildDA('Helv', fontSize, textColor));
  if (opts.overlayText !== undefined) annot.OverlayText = opts.overlayText;
  if (opts.repeat) annot.Repeat = true;
  if (opts.author !== undefined) annot.Author = opts.author;
  if (opacity !== undefined) annot.Opacity = opacity;

  const w = maxX - minX, h = maxY - minY;
  if (w > 0 && h > 0) {
    const g: WidgetGeom = { w, h, rotate: 0 };
    installShapeAP(doc, dict, g, redactMarkBody(offsetQuads(quads, minX, minY), color), opacity ?? 1);
  }
  return annot;
}
```

Add `redactMarkBody` to the existing `./annotdraw.js` import block at the top of `src/annotation.ts`.

- [ ] **Step 4: Wire `Page.AddRedact`**

In `src/page.ts`, beside `AddSquare`/`AddCircle` (extend the existing `./annotation.js` import with `addRedact`, `RedactAnnotation`, `RedactAnnotationOptions`):

```ts
  /** Mark a region for redaction with a /Redact annotation. This removes
   *  nothing — the marked content is still in the file and still extractable
   *  until `ApplyRedactions` is called. */
  AddRedact(opts: RedactAnnotationOptions): RedactAnnotation {
    return addRedact(this.doc, this, opts);
  }
```

- [ ] **Step 5: Export from `src/index.ts`**

Add `RedactAnnotation` to the existing annotation class export line, and the options type to the annotation type export block:

```ts
export type { RedactAnnotationOptions } from './annotation.js';
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx vitest run test/redact-annot.test.ts`
Expected: PASS, all suites in the file.

- [ ] **Step 7: Typecheck and commit**

```bash
npm run typecheck
git add src/annotation.ts src/page.ts src/index.ts test/redact-annot.test.ts
git commit -m "feat(annot): page.AddRedact marks a region without destroying it (0pvw.1)"
```

---

### Task 4: The `redactRegions` seam

Pure refactor of `redact.ts`: the destructive ordering becomes callable with a caller-supplied painter, so apply reuses it instead of re-deriving it.

**Files:**
- Modify: `src/redact.ts`
- Modify: `test/redact.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `redactRegions(doc: Document, page: Page, rects: Rect[], paint: (rects: Rect[]) => void): void` exported from `src/redact.ts`. `redactPage` keeps its exact current signature and behaviour.

- [ ] **Step 1: Write the failing test**

Append to `test/redact.test.ts` (add `redactRegions` to the imports from `../src/redact.js`):

```ts
describe('redactRegions', () => {
  it('removes content and then hands the validated rects to the painter', () => {
    const doc = Document.Open(buildMultiStreamPage(['BT /F1 10 Tf 50 100 Td (TopSecret) Tj ET']));
    const seen: number[][] = [];
    redactRegions(doc, doc.Pages[0], [[200, 115, 40, 95]], (rs) => { seen.push(...rs); });

    expect(seen).toEqual([[200, 115, 40, 95]]); // passed through as given
    expect(doc.Pages[0].GetText()).not.toContain('TopSecret');
  });

  it('validates every rect before touching the page', () => {
    const doc = Document.Open(buildMultiStreamPage(['BT /F1 10 Tf 50 100 Td (TopSecret) Tj ET']));
    let painted = false;
    expect(() => redactRegions(
      doc, doc.Pages[0], [[40, 95, 200, 115], [1, 2, 3] as never], () => { painted = true; },
    )).toThrow(TypeError);
    expect(painted).toBe(false);
    expect(doc.Pages[0].GetText()).toContain('TopSecret');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/redact.test.ts`
Expected: FAIL — `redactRegions` is not exported.

- [ ] **Step 3: Implement the seam**

In `src/redact.ts`, replace the body of `redactPage` with:

```ts
/** Remove the content under `rects` and hand the validated rects to `paint`.
 *
 *  **Invariant:** the removal → sanitize → commit ordering lives here and
 *  nowhere else. Text removal rebuilds the op list, so a caller that splits the
 *  passes lets glyph rewrites and image removals drift each other's op indices —
 *  and the failure is silent, because the page still looks redacted. Both
 *  painters (the flat marker box and the annotation overlay) share this. */
export function redactRegions(
  doc: Document, page: Page, rects: Rect[], paint: (rects: Rect[]) => void,
): void {
  const valid = rects.map(checkRect); // validate up front: no partial mutation on bad input
  const ec = new EditableContent(doc, page);
  removeRegionContent(doc, page, valid, ec); // text + images in one per-stream rebuild
  sanitizeResources(doc, page, ec);
  ec.commit();
  paint(valid);
}

/** Redact every `rects` region on `page`: truly remove covered text and images,
 *  prune resources they leave orphaned, then paint an opaque marker box over
 *  each region. */
export function redactPage(doc: Document, page: Page, rects: Rect[], opts: RedactOptions = {}): void {
  redactRegions(doc, page, rects, (rs) => paintRedactionBoxes(doc, page, rs, opts.color));
  if (opts.scrubMetadata) doc.ClearMetadata();
}
```

- [ ] **Step 4: Run the full redaction suite to verify nothing regressed**

Run: `npx vitest run test/redact.test.ts test/redact-box.test.ts test/redact-image.test.ts test/redact-sanitize.test.ts test/redact-search.test.ts test/redact-text.test.ts`
Expected: PASS. These suites are the proof the refactor was behaviour-preserving.

- [ ] **Step 5: Typecheck and commit**

```bash
npm run typecheck
git add src/redact.ts test/redact.test.ts
git commit -m "refactor(redact): redactRegions seam so apply shares the destructive ordering (0pvw.1)"
```

---

### Task 5: `ApplyRedactions` with the `/IC` fill overlay

End-to-end apply, with the simplest overlay. Text, `/Repeat` and `/RO` land in Tasks 6 and 7.

**Files:**
- Create: `src/redactapply.ts`
- Modify: `src/page.ts`, `src/document.ts`, `src/index.ts`
- Create: `test/redact-apply.test.ts`

**Interfaces:**
- Consumes: `RedactAnnotation` (Task 1), `redactRegions` (Task 4).
- Produces:
  - `interface ApplyRedactionsOptions { scrubMetadata?: boolean }`
  - `redactRects(annot: RedactAnnotation): Rect[]`
  - `paintRedactOverlay(doc: Document, page: Page, annot: RedactAnnotation, rects: Rect[]): void`
  - `applyRedactions(doc: Document, page: Page, opts?: ApplyRedactionsOptions): number`
  - `Page.ApplyRedactions(opts?): number`, `Document.ApplyRedactions(opts?): number`

- [ ] **Step 1: Write the failing tests**

Create `test/redact-apply.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { RedactAnnotation } from '../src/annotation.js';
import { inflateStream } from '../src/flate.js';
import { isStream, PdfDict } from '../src/types.js';
import { buildMultiStreamPage } from './helpers/build-edit-pdf.js';

/** The page's own /Contents, inflated, as latin1 text. */
function contentText(doc: Document, pageIndex = 0): string {
  return new TextDecoder('latin1').decode(doc.Pages[pageIndex].Contents);
}

const secretPage = () => Document.Open(
  buildMultiStreamPage(['BT /F1 10 Tf 50 100 Td (TopSecret) Tj ET']));

describe('page.ApplyRedactions', () => {
  it('destroys the marked text and reports the count', () => {
    const doc = secretPage();
    doc.Pages[0].AddRedact({ rect: [40, 95, 200, 115] });

    expect(doc.Pages[0].ApplyRedactions()).toBe(1);

    const back = Document.Open(doc.Save());
    expect(back.Pages[0].GetText()).not.toContain('TopSecret');
    expect(contentText(back)).not.toContain('TopSecret');
  });

  it('removes the mark once applied', () => {
    const doc = secretPage();
    doc.Pages[0].AddRedact({ rect: [40, 95, 200, 115] });
    doc.Pages[0].ApplyRedactions();
    expect(doc.Pages[0].Annotations.filter((a) => a instanceof RedactAnnotation)).toHaveLength(0);
  });

  it('paints the /IC fill over the region', () => {
    const doc = secretPage();
    doc.Pages[0].AddRedact({ rect: [40, 95, 200, 115], fill: [0, 0, 1] });
    doc.Pages[0].ApplyRedactions();
    expect(contentText(doc)).toContain('0 0 1 rg');
  });

  it('is a no-op returning 0 when the page carries no marks', () => {
    const doc = secretPage();
    const before = doc.Save();
    expect(doc.Pages[0].ApplyRedactions()).toBe(0);
    expect(doc.Save()).toEqual(before);
  });

  it('leaves a non-Redact annotation alone', () => {
    const doc = secretPage();
    doc.Pages[0].AddTextNote({ rect: [10, 10, 30, 30], contents: 'keep me' });
    doc.Pages[0].AddRedact({ rect: [40, 95, 200, 115] });
    expect(doc.Pages[0].ApplyRedactions()).toBe(1);
    expect(doc.Pages[0].Annotations).toHaveLength(1);
    expect(doc.Pages[0].Annotations[0].Subtype).toBe('Text');
  });

  it('scrubs metadata only when asked', () => {
    const doc = secretPage();
    doc.SetInfo({ Title: 'sensitive' });
    doc.Pages[0].AddRedact({ rect: [40, 95, 200, 115] });
    doc.Pages[0].ApplyRedactions({ scrubMetadata: true });
    expect(doc.GetInfo().Title).toBeUndefined();
  });
});

describe('doc.ApplyRedactions', () => {
  it('sums across pages', () => {
    const doc = secretPage();
    doc.Pages[0].AddRedact({ rect: [40, 95, 120, 115] });
    doc.Pages[0].AddRedact({ rect: [120, 95, 200, 115] });
    expect(doc.ApplyRedactions()).toBe(2);
  });
});
```

Check `doc.SetInfo`/`doc.GetInfo` against `src/document.ts` before running; if the metadata accessors are named differently there, use the names that file exports and keep the assertion's intent (a title set before, absent after).

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/redact-apply.test.ts`
Expected: FAIL — `ApplyRedactions` is not a function on `Page`.

- [ ] **Step 3: Create `src/redactapply.ts`**

```ts
// The annotation-driven half of redaction: consume /Redact marks and apply them.
//
// redact.ts owns the destructive content surgery (glyph rewriting, image
// re-encoding, resource pruning) and imports no annotation code. This module
// reads annotation dicts and paints overlays — a different job with a different
// dependency set, so it lives beside redact.ts rather than inside it.
import type { Document } from './document.js';
import type { Page } from './page.js';
import { RedactAnnotation } from './annotation.js';
import { quadsBBox } from './annotdraw.js';
import { PageGraphics } from './graphics.js';
import { redactRegions } from './redact.js';
import type { Rect } from './text.js';

/** Options for `Page.ApplyRedactions` / `Document.ApplyRedactions`. */
export interface ApplyRedactionsOptions {
  /** Also clear document metadata (/Info + XMP) when true. */
  scrubMetadata?: boolean;
}

/** The regions a mark covers: one Rect per /QuadPoints quad (its bounding box),
 *  falling back to /Rect when /QuadPoints is absent — a foreign producer may omit
 *  it, though `AddRedact` always writes it. [] when neither is usable. */
export function redactRects(annot: RedactAnnotation): Rect[] {
  const q = annot.QuadPoints;
  if (q.length >= 8) {
    const out: Rect[] = [];
    for (let i = 0; i + 8 <= q.length; i += 8) {
      const { minX, minY, maxX, maxY } = quadsBBox(q.slice(i, i + 8));
      out.push([minX, minY, maxX, maxY]);
    }
    return out;
  }
  const r = annot.Rect;
  return r ? [r] : [];
}

/** Paint what a mark leaves behind: the /IC fill over each of its regions. */
export function paintRedactOverlay(
  doc: Document, page: Page, annot: RedactAnnotation, rects: Rect[],
): void {
  const fill = annot.InteriorColor ?? [0, 0, 0];
  const g = new PageGraphics(doc, page);
  g.setFillColor(fill);
  for (const r of rects) {
    const x0 = Math.min(r[0], r[2]), y0 = Math.min(r[1], r[3]);
    const x1 = Math.max(r[0], r[2]), y1 = Math.max(r[1], r[3]);
    g.rect(x0, y0, x1 - x0, y1 - y0).fill();
  }
  g.apply();
}

/** Apply every /Redact mark on `page`: destroy the marked content, paint each
 *  mark's overlay, then remove the marks. Returns the number applied; a page
 *  with no usable mark is left untouched and returns 0. */
export function applyRedactions(
  doc: Document, page: Page, opts: ApplyRedactionsOptions = {},
): number {
  const marks: Array<{ annot: RedactAnnotation; rects: Rect[] }> = [];
  for (const a of page.Annotations) {
    if (!(a instanceof RedactAnnotation)) continue;
    const rects = redactRects(a);
    if (rects.length === 0) continue; // no geometry to act on: skip, don't throw
    marks.push({ annot: a, rects });
  }
  if (marks.length === 0) return 0;

  // The overlay is painted inside the seam's callback so it lands after
  // ec.commit() and therefore sits on top of whatever content survived.
  redactRegions(doc, page, marks.flatMap((m) => m.rects), () => {
    for (const m of marks) paintRedactOverlay(doc, page, m.annot, m.rects);
  });

  // After painting, because the painter needs these dicts alive. RemoveAnnotation
  // (not a raw /Annots splice) because it is what calls untagObjects: a tagged
  // annotation is also named by an /OBJR reachable from /Root, and leaving that
  // keeps the annotation in the saved bytes with no /Annots entry anywhere.
  for (const m of marks) page.RemoveAnnotation(m.annot);

  if (opts.scrubMetadata) doc.ClearMetadata();
  return marks.length;
}
```

- [ ] **Step 4: Wire `Page.ApplyRedactions`**

In `src/page.ts`, after `RedactText` (import `applyRedactions` and `ApplyRedactionsOptions` from `./redactapply.js`):

```ts
  /** Apply every /Redact mark on this page: truly remove the marked content,
   *  paint each mark's overlay (/RO, else its /IC fill and /OverlayText), then
   *  remove the marks. Returns the number applied; a page with no marks is
   *  untouched and returns 0. */
  ApplyRedactions(opts?: ApplyRedactionsOptions): number {
    return applyRedactions(this.doc, this, opts ?? {});
  }
```

- [ ] **Step 5: Wire `Document.ApplyRedactions`**

In `src/document.ts`, beside `RedactText`:

```ts
  /** Apply every /Redact mark across all pages; see `Page.ApplyRedactions`.
   *  Returns the total number applied. */
  ApplyRedactions(opts?: ApplyRedactionsOptions): number {
    let total = 0;
    for (const page of this.Pages) total += page.ApplyRedactions(opts);
    return total;
  }
```

Add `import type { ApplyRedactionsOptions } from './redactapply.js';` beside the existing `RedactOptions` type import.

- [ ] **Step 6: Export from `src/index.ts`**

```ts
export type { ApplyRedactionsOptions } from './redactapply.js';
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `npx vitest run test/redact-apply.test.ts`
Expected: PASS.

- [ ] **Step 8: Typecheck and commit**

```bash
npm run typecheck
git add src/redactapply.ts src/page.ts src/document.ts src/index.ts test/redact-apply.test.ts
git commit -m "feat(redact): ApplyRedactions consumes /Redact marks and paints the /IC fill (0pvw.1)"
```

---

### Task 6: Overlay text with `/DA`, `/Q` and `/Repeat`

**Files:**
- Modify: `src/redactapply.ts`
- Modify: `test/redact-apply.test.ts`

**Interfaces:**
- Consumes: `paintRedactOverlay` (Task 5) — same signature, extended behaviour.
- Produces: no new exported names.

- [ ] **Step 1: Write the failing tests**

Append to `test/redact-apply.test.ts`:

```ts
describe('overlay text', () => {
  const wide = () => Document.Open(
    buildMultiStreamPage(['BT /F1 10 Tf 50 100 Td (TopSecret) Tj ET']));

  it('draws /OverlayText in the /DA colour over the fill', () => {
    const doc = wide();
    doc.Pages[0].AddRedact({
      rect: [40, 95, 200, 115], overlayText: 'REDACTED', textColor: [1, 1, 1],
    });
    doc.Pages[0].ApplyRedactions();

    const body = contentText(doc);
    expect(body).toContain('(REDACTED) Tj');
    expect(body).toContain('1 1 1 rg');
    expect(Document.Open(doc.Save()).Pages[0].GetText()).toContain('REDACTED');
  });

  it('honours /Q by moving the text anchor', () => {
    const mk = (align: 'left' | 'center' | 'right') => {
      const doc = wide();
      doc.Pages[0].AddRedact({ rect: [40, 95, 200, 115], overlayText: 'X', align });
      doc.Pages[0].ApplyRedactions();
      return contentText(doc);
    };
    // Same text, same box: only the x origin of the text matrix may differ.
    expect(mk('left')).not.toEqual(mk('center'));
    expect(mk('center')).not.toEqual(mk('right'));
  });

  it('tiles the text when /Repeat is set', () => {
    const once = () => {
      const doc = wide();
      doc.Pages[0].AddRedact({ rect: [40, 95, 200, 115], overlayText: 'X', fontSize: 8 });
      doc.Pages[0].ApplyRedactions();
      return (contentText(doc).match(/\(X\) Tj/g) ?? []).length;
    };
    const many = () => {
      const doc = wide();
      doc.Pages[0].AddRedact({
        rect: [40, 95, 200, 115], overlayText: 'X', fontSize: 8, repeat: true,
      });
      doc.Pages[0].ApplyRedactions();
      return (contentText(doc).match(/\(X\) Tj/g) ?? []).length;
    };
    expect(once()).toBe(1);
    expect(many()).toBeGreaterThan(1);
  });

  it('paints only the fill when there is no overlay text', () => {
    const doc = wide();
    doc.Pages[0].AddRedact({ rect: [40, 95, 200, 115], fill: [0, 0, 0] });
    doc.Pages[0].ApplyRedactions();
    expect(contentText(doc)).not.toContain('Tj');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/redact-apply.test.ts`
Expected: FAIL — no `Tj` in the content; only the fill is painted.

- [ ] **Step 3: Implement**

In `src/redactapply.ts`, add the imports:

```ts
import { measure } from './metrics.js';
import { stampText } from './stamp.js';
import { encodeWinAnsi } from './encoding.js';
```

and replace `paintRedactOverlay` with:

```ts
/** Paint what a mark leaves behind: the /IC fill over each region, then its
 *  /OverlayText in the /DA font, size and colour, anchored by /Q and tiled when
 *  /Repeat is set. Introduces no rendering primitives — the fill goes through
 *  PageGraphics and the text through stampText, the rule tocrender.ts follows. */
export function paintRedactOverlay(
  doc: Document, page: Page, annot: RedactAnnotation, rects: Rect[],
): void {
  const fill = annot.InteriorColor ?? [0, 0, 0];
  const g = new PageGraphics(doc, page);
  g.setFillColor(fill);
  const boxes = rects.map(normRect);
  for (const [x0, y0, x1, y1] of boxes) g.rect(x0, y0, x1 - x0, y1 - y0).fill();
  g.apply();

  const text = annot.OverlayText;
  if (text === undefined || text.length === 0) return;

  const size = annot.FontSize > 0 ? annot.FontSize : 12;
  const color = annot.TextColor;
  const align = annot.Alignment;
  const width = measure('Helvetica', encodeWinAnsi(text), size);
  const opts = { font: 'Helvetica' as const, fontSize: size, color, align };

  for (const [x0, y0, x1, y1] of boxes) {
    // Baseline anchor: /Q picks the x edge; y centres the cap height in the box.
    const x = align === 'center' ? (x0 + x1) / 2 : align === 'right' ? x1 : x0;
    const y = (y0 + y1) / 2 - size * 0.35;
    if (!annot.Repeat) { stampText(doc, page, text, x, y, opts); continue; }

    // Tile: step by the text width across, by the line height down, until full.
    const step = width > 0 ? width * 1.2 : size;
    const lead = size * 1.2;
    for (let ty = y1 - lead * 0.8; ty >= y0; ty -= lead) {
      for (let tx = x0; tx + width <= x1; tx += step) {
        stampText(doc, page, text, tx, ty, { ...opts, align: 'left' });
      }
    }
  }
}

/** A rect as [minX, minY, maxX, maxY], however the caller ordered its corners. */
function normRect(r: Rect): Rect {
  return [
    Math.min(r[0], r[2]), Math.min(r[1], r[3]),
    Math.max(r[0], r[2]), Math.max(r[1], r[3]),
  ];
}
```

If `stampText`'s `font` option does not accept the bare string `'Helvetica'` in this codebase's typing, pass whatever `StampOptions.font` accepts for a Standard-14 face (check `src/stamp.ts`'s `AuthoringFont`) — the intent is Helvetica, matching `measure`'s font argument above.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/redact-apply.test.ts`
Expected: PASS, all suites in the file.

- [ ] **Step 5: Typecheck and commit**

```bash
npm run typecheck
git add src/redactapply.ts test/redact-apply.test.ts
git commit -m "feat(redact): overlay text with /DA, /Q and /Repeat on apply (0pvw.1)"
```

---

### Task 7: `/RO` precedence

`/RO` is a form XObject holding arbitrary overlay artwork. §12.5.6.23 gives it precedence over `/IC` and `/OverlayText`. We read it; we never author it.

**Files:**
- Modify: `src/redactapply.ts`
- Modify: `test/helpers/build-redact-annot.ts`, `test/redact-apply.test.ts`

**Interfaces:**
- Consumes: `paintRedactOverlay` (Tasks 5–6) — same signature, extended behaviour.
- Produces: no new exported names.

- [ ] **Step 1: Add the `/RO` fixture**

Append to `test/helpers/build-redact-annot.ts`:

```ts
/** A page with text and a hand-written /Redact carrying an /RO overlay form —
 *  the shape Acrobat writes when the author drew custom overlay artwork. The
 *  form paints a green box, distinguishable from any /IC we would pick. */
export function buildRedactWithROTarget(): Uint8Array {
  const ro = `0 1 0 rg 0 0 160 20 re f`;
  const objects: Record<number, string> = {
    1: `<< /Type /Catalog /Pages 2 0 R >>`,
    2: `<< /Type /Pages /Count 1 /Kids [3 0 R] /MediaBox [0 0 300 300] >>`,
    3: `<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 6 0 R >> >> ` +
       `/Contents 7 0 R /Annots [4 0 R] >>`,
    4: `<< /Type /Annot /Subtype /Redact /Rect [40 95 200 115] ` +
       `/QuadPoints [40 115 200 115 40 95 200 95] ` +
       `/IC [0 0 1] /OverlayText (SHOULD NOT APPEAR) /RO 5 0 R >>`,
    5: `<< /Type /XObject /Subtype /Form /BBox [0 0 160 20] /Length ${byteLen(ro)} >>\n` +
       `stream\n${ro}\nendstream`,
    6: `<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>`,
    7: streamObj(`BT /F1 10 Tf 50 100 Td (TopSecret) Tj ET`),
  };
  return serialize(objects, 7);
}
```

`streamObj` and `byteLen` come from the same file-local preamble Task 1 copied in.

- [ ] **Step 2: Write the failing test**

Append to `test/redact-apply.test.ts` (import `buildRedactWithROTarget` from `./helpers/build-redact-annot.js`):

```ts
describe('/RO precedence', () => {
  it('draws the /RO form and neither the /IC fill nor the overlay text', () => {
    const doc = Document.Open(buildRedactWithROTarget());
    expect(doc.Pages[0].ApplyRedactions()).toBe(1);

    const body = contentText(doc);
    expect(body).toContain('Do');                        // the form was placed
    expect(body).not.toContain('0 0 1 rg');              // /IC not painted
    expect(body).not.toContain('SHOULD NOT APPEAR');     // /OverlayText not drawn
    expect(doc.Pages[0].GetText()).not.toContain('TopSecret'); // still destructive
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx vitest run test/redact-apply.test.ts`
Expected: FAIL — the `/IC` fill is painted and no `Do` appears.

- [ ] **Step 4: Implement**

In `src/redactapply.ts`, add the imports:

```ts
import { appendContent, ensureOwnResources, ensureOwnSubdict, freshKey, num } from './pagecontent.js';
import { placementMatrix } from './text.js';
import { isArray, isRef, PdfStream } from './types.js';
```

and add, above `paintRedactOverlay`:

```ts
/** Resolve `o` to `n` finite numbers, or undefined. */
function numArray(doc: Document, o: unknown, n: number): number[] | undefined {
  const a = doc.resolve(o as never);
  if (!isArray(a) || a.length < n) return undefined;
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    const v = doc.resolve(a[i]);
    if (typeof v !== 'number' || !Number.isFinite(v)) return undefined;
    out.push(v);
  }
  return out;
}

/** Place the mark's /RO overlay form into the page at its /Rect. Returns false
 *  when there is no usable /RO, so the caller falls back to /IC + /OverlayText.
 *
 *  §12.5.6.23 gives /RO precedence: a viewer showing the mark shows /RO, so
 *  applying it must produce the same ink. We honour one another producer wrote
 *  but never author one. */
function paintOverlayForm(doc: Document, page: Page, annot: RedactAnnotation): boolean {
  const ro = annot.Overlay;
  if (ro === undefined) return false;
  const rect = annot.Rect;
  if (rect === undefined) return false;
  const bbox = numArray(doc, ro.dict.get('BBox'), 4);
  if (bbox === undefined) return false;
  const m = (numArray(doc, ro.dict.get('Matrix'), 6) as [number, number, number, number, number, number] | undefined)
    ?? [1, 0, 0, 1, 0, 0];
  const place = placementMatrix(bbox, m, rect);
  if (place === undefined) return false;

  const entry = annot.Dict.get('RO');
  const ref = isRef(entry) ? entry : doc.allocObject(ro as PdfStream);
  const xobjs = ensureOwnSubdict(doc, ensureOwnResources(doc, page), 'XObject');
  const key = freshKey(xobjs, 'Fm');
  xobjs.set(key, ref);
  appendContent(doc, page, new TextEncoder().encode(
    `q ${place.map(num).join(' ')} cm /${key} Do Q\n`));
  return true;
}
```

Then make `paintRedactOverlay` short-circuit on it — insert as its first statement:

```ts
  if (paintOverlayForm(doc, page, annot)) return;
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run test/redact-apply.test.ts`
Expected: PASS, all suites in the file.

- [ ] **Step 6: Typecheck and commit**

```bash
npm run typecheck
git add src/redactapply.ts test/helpers/build-redact-annot.ts test/redact-apply.test.ts
git commit -m "feat(redact): honour a mark's /RO overlay form on apply (0pvw.1)"
```

---

### Task 8: `MarkRedactText`

**Files:**
- Modify: `src/redactapply.ts`, `src/page.ts`, `src/document.ts`, `src/index.ts`
- Modify: `test/redact-apply.test.ts`

**Interfaces:**
- Consumes: `addRedact`, `rectToQuad` (Task 3).
- Produces:
  - `type MarkRedactTextOptions = Omit<RedactAnnotationOptions, 'quads' | 'rect'>`
  - `markRedactText(doc: Document, page: Page, find: string | RegExp, opts?: MarkRedactTextOptions): number`
  - `Page.MarkRedactText(find, opts?): number`, `Document.MarkRedactText(find, opts?): number`

- [ ] **Step 1: Write the failing tests**

Append to `test/redact-apply.test.ts`:

```ts
describe('page.MarkRedactText', () => {
  const twoHits = () => Document.Open(buildMultiStreamPage([
    'BT /F1 10 Tf 50 200 Td (card 4111 here) Tj ET',
    'BT /F1 10 Tf 50 100 Td (card 4222 here) Tj ET',
  ]));

  it('adds one mark per match and destroys nothing', () => {
    const doc = twoHits();
    expect(doc.Pages[0].MarkRedactText(/\d{4}/, { overlayText: 'X' })).toBe(2);

    const marks = doc.Pages[0].Annotations.filter((a) => a instanceof RedactAnnotation);
    expect(marks).toHaveLength(2);
    expect((marks[0] as RedactAnnotation).OverlayText).toBe('X');
    expect(doc.Pages[0].GetText()).toContain('4111'); // still there — only marked
  });

  it('returns 0 and adds nothing when there is no match', () => {
    const doc = twoHits();
    expect(doc.Pages[0].MarkRedactText('nothing-here')).toBe(0);
    expect(doc.Pages[0].Annotations).toHaveLength(0);
  });

  it('marks then applies, end to end', () => {
    const doc = twoHits();
    doc.Pages[0].MarkRedactText(/\d{4}/, { overlayText: 'X' });
    expect(doc.Pages[0].ApplyRedactions()).toBe(2);

    const back = Document.Open(doc.Save());
    expect(back.Pages[0].GetText()).not.toContain('4111');
    expect(back.Pages[0].GetText()).not.toContain('4222');
    expect(back.Pages[0].Annotations.filter((a) => a instanceof RedactAnnotation)).toHaveLength(0);
  });
});

describe('doc.MarkRedactText', () => {
  it('sums across pages', () => {
    const doc = Document.Open(buildMultiStreamPage(['BT /F1 10 Tf 50 100 Td (card 4111) Tj ET']));
    expect(doc.MarkRedactText(/\d{4}/)).toBe(1);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/redact-apply.test.ts`
Expected: FAIL — `MarkRedactText` is not a function on `Page`.

- [ ] **Step 3: Implement in `src/redactapply.ts`**

Add the imports:

```ts
import { addRedact, rectToQuad, type RedactAnnotationOptions } from './annotation.js';
import { searchText } from './textedit.js';
```

and append:

```ts
/** Options for `Page.MarkRedactText` — everything `AddRedact` takes except the
 *  geometry, which comes from the search hit. */
export type MarkRedactTextOptions = Omit<RedactAnnotationOptions, 'quads' | 'rect'>;

/** Mark every occurrence of `find` (a literal string or RegExp) on `page` with a
 *  /Redact annotation, using the same search as `Search`. One annotation per
 *  match, carrying a quad per line the match spans. Returns the number of
 *  occurrences marked; nothing is removed until `ApplyRedactions`. */
export function markRedactText(
  doc: Document, page: Page, find: string | RegExp, opts: MarkRedactTextOptions = {},
): number {
  const matches = searchText(doc, page, find);
  for (const m of matches) {
    // One annotation per match: a match wrapping a line break spans several line
    // boxes, and those become several quads on the same mark, not several marks.
    addRedact(doc, page, { ...opts, quads: m.quads.flatMap(rectToQuad) });
  }
  return matches.length;
}
```

- [ ] **Step 4: Wire the page and document methods**

In `src/page.ts`, after `AddRedact` (extend the `./redactapply.js` import with `markRedactText`, `MarkRedactTextOptions`):

```ts
  /** Mark every occurrence of `find` (a literal string or RegExp) for redaction
   *  with a /Redact annotation, via the same search as `Search`. Returns the
   *  number of occurrences marked. Nothing is removed until `ApplyRedactions` —
   *  the marked text is still extractable until then. */
  MarkRedactText(find: string | RegExp, opts?: MarkRedactTextOptions): number {
    return markRedactText(this.doc, this, find, opts ?? {});
  }
```

In `src/document.ts`, beside `ApplyRedactions`:

```ts
  /** Mark every occurrence of `find` across all pages; see `Page.MarkRedactText`.
   *  Returns the total number of occurrences marked. */
  MarkRedactText(find: string | RegExp, opts?: MarkRedactTextOptions): number {
    let total = 0;
    for (const page of this.Pages) total += page.MarkRedactText(find, opts);
    return total;
  }
```

Add `MarkRedactTextOptions` to `document.ts`'s type import from `./redactapply.js`.

- [ ] **Step 5: Export from `src/index.ts`**

```ts
export type { MarkRedactTextOptions } from './redactapply.js';
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx vitest run test/redact-apply.test.ts`
Expected: PASS, all suites in the file.

- [ ] **Step 7: Typecheck and commit**

```bash
npm run typecheck
git add src/redactapply.ts src/page.ts src/document.ts src/index.ts test/redact-apply.test.ts
git commit -m "feat(redact): MarkRedactText marks every search hit (0pvw.1)"
```

---

### Task 9: Structure untagging, failure atomicity, mutation check, docs

The two assertions that pass trivially on a correct implementation and cover invisible failures, plus the docs.

**Files:**
- Modify: `test/redact-apply.test.ts`
- Modify: `README.md`, `CLAUDE.md`

**Interfaces:**
- Consumes: everything from Tasks 1–8. Produces no new names.

- [ ] **Step 1: Write the structure-untagging test**

Append to `test/redact-apply.test.ts` (import `tagAnnotation` from `../src/structwrite.js`, and `isDict`, `isName` from `../src/types.js`):

```ts
/** Dicts of the given /Subtype anywhere in the object map — including objects no
 *  page points at any more, which is the whole question here. */
function subtypeCount(doc: Document, subtype: string): number {
  let n = 0;
  for (const [, o] of doc.objectEntries()) {
    if (!isDict(o)) continue;
    const st = doc.resolve(o.get('Subtype'));
    if (isName(st) && st.name === subtype) n++;
  }
  return n;
}

describe('applied marks are untagged, not just detached', () => {
  it('leaves no /OBJR keeping the annotation alive through Save', () => {
    // /StructTreeRoot is reachable from /Root, so an /OBJR naming the annotation
    // survives the mark-sweep: the file would carry a /Redact in no /Annots.
    const doc = secretPage();
    const tree = doc.CreateStructTree();
    const mark = doc.Pages[0].AddRedact({ rect: [40, 95, 200, 115] });
    tagAnnotation(doc, tree.Add('Annot'), mark);

    expect(doc.Pages[0].ApplyRedactions()).toBe(1);

    const back = Document.Open(doc.Save());
    expect(subtypeCount(back, 'Redact')).toBe(0);
  });
});
```

Before running, check `src/struct.ts` / `src/structwrite.ts` for the actual way `test/flatten-struct.test.ts` builds a struct tree and an element (around its line 185, where `tagAnnotation` derives the page from `/P`), and mirror that construction exactly rather than the `doc.CreateStructTree()` / `tree.Add('Annot')` sketch above — the intent is: a struct element whose `/K` holds an `/OBJR` naming the mark.

- [ ] **Step 2: Write the failure-atomicity test**

Append to `test/redact-apply.test.ts`:

```ts
describe('a failed apply changes nothing', () => {
  it('throws on an undecodable partially-covered image, leaving marks and text', () => {
    // The throw happens inside removeRegionContent, before ec.commit(), so the
    // whole apply is a no-op and the caller can fix the mark and retry.
    const doc = Document.Open(buildSingleImagePdfWithCm('/DCTDecode'));
    const page = doc.Pages[0];
    const [x0, y0, x1, y1] = page.MediaBox;
    page.AddRedact({ rect: [x0, y0, (x0 + x1) / 2, (y0 + y1) / 2] }); // partial cover

    expect(() => page.ApplyRedactions()).toThrow(UnsupportedFeatureError);
    expect(page.Annotations.filter((a) => a instanceof RedactAnnotation)).toHaveLength(1);
  });
});
```

Import `UnsupportedFeatureError` from `../src/errors.js`. Take the fixture and the partial-cover rect from `test/redact-image.test.ts`'s existing "undecodable partially-covered image throws" case — reuse whatever builder and coordinates it already proved trigger the throw, rather than the sketch above.

- [ ] **Step 3: Run the tests to verify they pass**

Run: `npx vitest run test/redact-apply.test.ts`
Expected: PASS.

- [ ] **Step 4: Prove the two assertions are load-bearing (mutation check)**

These pass on the first run, which is not evidence. Break each path and confirm red:

1. In `src/redactapply.ts`, replace `page.RemoveAnnotation(m.annot)` with a raw splice of the page's `/Annots` array (no `untagObjects`).
   Run: `npx vitest run test/redact-apply.test.ts` → the untagging test MUST fail.
   Revert.
2. In `src/annotation.ts`, make `addRedact` call `redactPage` on its rect before returning.
   Run: `npx vitest run test/redact-annot.test.ts` → "MARKING REMOVES NOTHING" MUST fail.
   Revert.

If either stays green, the assertion is not covering what it claims and must be strengthened before moving on.

- [ ] **Step 5: Run the whole suite and typecheck**

```bash
npm run typecheck
npm test
```
Expected: both green. Investigate any failure before continuing — do not proceed on a red suite.

- [ ] **Step 6: Update `README.md`**

In the redaction section, alongside the existing `Redact`/`RedactText` documentation, add mark-then-apply. Include this example and state plainly that a mark removes nothing until applied:

```ts
// Mark — nothing is removed yet, and the text is still extractable.
page.AddRedact({ rect: [72, 700, 300, 720], overlayText: 'REDACTED' });
page.MarkRedactText(/\d{4}-\d{4}-\d{4}-\d{4}/, { overlayText: 'REDACTED' });

// Apply — now the content is destroyed and the overlay painted.
const n = doc.ApplyRedactions();
```

Add `RedactAnnotation` to the annotation-types list, and note the two limitations from the spec: apply does not remove other annotations overlapping a redacted region, and the painted overlay is untagged content.

- [ ] **Step 7: Update `CLAUDE.md`**

Extend the `redact.ts` bullet in the Architecture Overview to name `redactapply.ts`, and record the two invariants:

```
  **Invariant:** the removal → sanitize → commit ordering lives in
  `redactRegions` and nowhere else. Text removal rebuilds the op list, so a
  caller that splits the passes lets glyph rewrites and image removals drift
  each other's op indices — silently, because the page still looks redacted.
  **Invariant:** an unapplied `/Redact` mark must not render like an applied
  redaction. Its `/AP` outlines each quad and fills nothing, because both the
  renderers and `FlattenAnnotations` composite `/AP /N` — a filled preview would
  render a page whose text is still fully extractable as though it were already
  redacted.
```

Also add `RedactAnnotation` to the `annotation.ts` bullet's list of subclasses.

- [ ] **Step 8: Commit**

```bash
git add test/redact-apply.test.ts README.md CLAUDE.md
git commit -m "test(redact): untagging + failure atomicity; document mark-then-apply (0pvw.1)"
```

- [ ] **Step 9: File the deferred follow-ups**

```bash
bd create "ApplyRedactions should remove annotations overlapping a redacted region" \
  -t bug -p 2 \
  -d "A sticky note under a redacted region keeps its /Contents after apply, so the text survives in the annotation. Pre-existing in paintRedactionBoxes/redactPage too, not new to 0pvw.1. Decide whether apply drops overlapping annotations outright or only scrubs their text keys."

bd create "Redaction overlay content is untagged" \
  -t bug -p 3 \
  -d "The marker box and overlay text painted by paintRedactionBoxes and paintRedactOverlay are untagged content, which a tagged document should not carry. stampText already takes an 'artifact' option; decide whether the overlay is an /Artifact or a tagged /Span."
```

- [ ] **Step 10: Close the issue and push**

```bash
bd close aspose-pdf-foss-for-ts-0pvw.1
git pull --rebase
git push
git status   # MUST show "up to date with origin"
```

---

## Self-Review

**Spec coverage:**

| Spec section | Task |
|---|---|
| `Page.AddRedact` + options table | 3 |
| `Page.MarkRedactText`, `Document.MarkRedactText` | 8 |
| `Page.ApplyRedactions`, `Document.ApplyRedactions` | 5 |
| `RedactAnnotation` accessors incl. read-only `Overlay` | 1 |
| Shared accessors (`QuadPoints`/`Alignment`/`InteriorColor`/`readDA`) | 1 |
| `redactMarkBody` / pending-mark `/AP` invariant | 2, 3 |
| `redactRegions` seam + ordering invariant | 4 |
| Apply pipeline steps 1–7 | 5 |
| `/RO` precedence | 7 |
| `/IC` + `/OverlayText` + `/DA` + `/Q` + `/Repeat` | 5, 6 |
| `RemoveAnnotation` → `untagObjects` | 5 (impl), 9 (test) |
| Error table | 3 (validation), 5 (empty), 9 (image throw) |
| Testing assertions 1–10 | 3, 5, 6, 7, 8, 9 |
| Mutation-testing assertions 1 and 9 | 9 |
| Documented limitations | 9 |

No gaps.

**Type consistency:** `RedactAnnotationOptions` (Task 3) is consumed by `MarkRedactTextOptions` (Task 8) via `Omit`. `paintRedactOverlay(doc, page, annot, rects)` keeps one signature across Tasks 5–7. `redactRects` returns `Rect[]`, matching `redactRegions`'s third parameter (Task 4). `rectToQuad` is exported in Task 3 and consumed in Task 8. `redactMarkBody(qs, color)` is defined in Task 2 and called in Task 3 with `offsetQuads(...)`, which returns `QuadCorners[]`.

**Three places the plan tells the implementer to verify against the codebase rather than trusting the sketch** — flagged inline, not left as placeholders: `doc.SetInfo`/`GetInfo` naming (Task 5 Step 1), `StampOptions.font` accepting a Standard-14 string (Task 6 Step 3), and the struct-tree/undecodable-image fixture construction (Task 9 Steps 1–2). Each names the file to check and states the intent so the assertion survives whatever the real API is called.

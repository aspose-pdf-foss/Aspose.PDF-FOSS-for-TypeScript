# Annotation Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a typed `Annotation` model over `/Annots` with read getters, live setters, an internal creation helper, and `Page.RemoveAnnotation` — the foundation the per-subtype annotation features build on.

**Architecture:** A new `src/annotation.ts` holds a base `Annotation` live-dict handle (constructed with `(doc, dict)`, mirroring `Field`/`Page`), a `wrapAnnotation` factory, and an internal `createAnnotation` helper. `Page.Annotations` is repurposed from `PdfDict[]` to `Annotation[]`; `Page.RemoveAnnotation` deletes from the page's own `/Annots`. New annotation objects are allocated via the existing `Document.allocObject` and serialized by the existing `Save()` mark-sweep with no serializer change.

**Tech Stack:** TypeScript (strict, ESM + NodeNext), vitest. Node built-ins only.

## Global Constraints

- **Zero runtime dependencies** — only `node:` built-ins. Do not add npm runtime deps.
- **ESM + NodeNext** — every relative import specifier carries the `.js` extension (e.g. `import { Page } from './page.js'`).
- **Strict TypeScript** — `npm run typecheck` (tsc `--noEmit`) must stay green.
- **Public error types only** — throw `TypeError` for bad inputs; reuse `PdfParseError`/`UnsupportedFeatureError`/`InvalidPasswordError` from `errors.ts` where applicable.
- **Live-mutation model** — edits act directly on the live dict in the objects map; never copy-and-replace the page dict.
- **Colors are DeviceRGB `0..1`** — three finite numbers in `[0,1]`; reject anything else with `TypeError`.
- **Breaking change** — `Page.Annotations` changes return type from `PdfDict[]` to `Annotation[]`; each wrapper still exposes `.Dict`.
- **TDD** — write the failing test first, watch it fail, implement minimally, watch it pass, commit. Run `npm run typecheck` before any commit that changes types.
- Target a single test file with `npx vitest run test/<name>.test.ts`; full suite with `npm test`.

---

### Task 1: `Annotation` base class — read accessors + repurpose `Page.Annotations`

Introduces the typed wrapper with read-only accessors and switches `Page.Annotations` to return it. Fixes the one existing test that asserted the old raw return.

**Files:**
- Create: `src/annotation.ts`
- Create: `test/helpers/build-annot-target.ts`
- Create: `test/annotation.test.ts`
- Modify: `src/page.ts` (imports + `Annotations` getter)
- Modify: `test/page.test.ts:86-87` (adapt the breaking assertion)

**Interfaces:**
- Consumes: `Document.resolve(o: PdfObject | undefined): PdfObject`; `Page.Dict: PdfDict`; `decodePdfText(bytes)`, `parsePdfDate(s)` from `metadata.ts`; type guards from `types.ts`.
- Produces:
  - `class Annotation { constructor(doc: Document, dict: PdfDict); readonly Dict: PdfDict; get Subtype(): string; get Rect(): [number,number,number,number] | undefined; get Color(): [number,number,number] | undefined; get Contents(): string | undefined; get Name(): string | undefined; get ModDate(): Date | string | undefined; get Flags(): number; get Print(): boolean; get Hidden(): boolean; get Opacity(): number | undefined; }`
  - `function wrapAnnotation(doc: Document, dict: PdfDict): Annotation`

- [ ] **Step 1: Write the fixture builder**

Create `test/helpers/build-annot-target.ts` (mirrors `build-stamp-target.ts`):

```ts
const enc = (s: string) => new TextEncoder().encode(s);
const byteLen = (s: string) => enc(s).length;

/** Assemble a classic-xref PDF from a 1-based array of object bodies. */
function assemble(objects: string[], maxObj: number, rootNum: number): Uint8Array {
  let body = '%PDF-1.7\n%\xE2\xE3\xCF\xD3\n';
  const offsets: number[] = new Array(maxObj + 1).fill(0);
  for (let n = 1; n <= maxObj; n++) {
    offsets[n] = byteLen(body);
    body += `${n} 0 obj\n${objects[n]}\nendobj\n`;
  }
  const xrefOffset = byteLen(body);
  let xref = `xref\n0 ${maxObj + 1}\n0000000000 65535 f \n`;
  for (let n = 1; n <= maxObj; n++) xref += `${String(offsets[n]).padStart(10, '0')} 00000 n \n`;
  const trailer = `trailer\n<< /Size ${maxObj + 1} /Root ${rootNum} 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return enc(body + xref + trailer);
}

/** One page carrying two existing annotations: a /Text note and a /Link. */
export function buildAnnotTarget(): Uint8Array {
  const objects: string[] = [];
  objects[1] = `<< /Type /Catalog /Pages 2 0 R >>`;
  objects[2] = `<< /Type /Pages /Count 1 /Kids [3 0 R] /MediaBox [0 0 300 200] >>`;
  objects[3] = `<< /Type /Page /Parent 2 0 R /Annots [4 0 R 5 0 R] >>`;
  objects[4] = `<< /Type /Annot /Subtype /Text /Rect [10 20 30 40] /Contents (hello) /C [1 0 0] /F 4 >>`;
  objects[5] = `<< /Type /Annot /Subtype /Link /Rect [50 60 200 80] >>`;
  return assemble(objects, 5, 1);
}
```

- [ ] **Step 2: Write the failing test**

Create `test/annotation.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { Annotation } from '../src/annotation.js';
import { buildAnnotTarget } from './helpers/build-annot-target.js';

describe('Annotation read model', () => {
  it('exposes typed annotations from Page.Annotations', () => {
    const doc = Document.Open(buildAnnotTarget());
    const annots = doc.Pages[0].Annotations;
    expect(annots).toHaveLength(2);
    expect(annots[0]).toBeInstanceOf(Annotation);

    const text = annots[0];
    expect(text.Subtype).toBe('Text');
    expect(text.Rect).toEqual([10, 20, 30, 40]);
    expect(text.Contents).toBe('hello');
    expect(text.Color).toEqual([1, 0, 0]);
    expect(text.Flags).toBe(4);
    expect(text.Print).toBe(true);
    expect(text.Hidden).toBe(false);

    expect(annots[1].Subtype).toBe('Link');
    expect(annots[1].Color).toBeUndefined();
    expect(annots[1].Dict).toBeInstanceOf(Map); // raw escape hatch present
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx vitest run test/annotation.test.ts`
Expected: FAIL — `Cannot find module '../src/annotation.js'`.

- [ ] **Step 4: Implement `src/annotation.ts`**

```ts
import type { Document } from './document.js';
import { PdfDict, PdfObject, isArray, isName, isString } from './types.js';
import { decodePdfText, parsePdfDate } from './metadata.js';

// Annotation flag bits (/F), PDF 32000-1 §12.5.3.
const FLAG_HIDDEN = 1 << 1; // bit 2, value 2
const FLAG_PRINT = 1 << 2;  // bit 3, value 4

/** Read an n-length array of resolved numbers from `o`, or undefined. */
function numArray(doc: Document, o: PdfObject | undefined, n: number): number[] | undefined {
  const a = doc.resolve(o);
  if (!isArray(a) || a.length < n) return undefined;
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    const v = doc.resolve(a[i]);
    if (typeof v !== 'number') return undefined;
    out.push(v);
  }
  return out;
}

/** A live, mutable handle over an annotation dictionary. */
export class Annotation {
  constructor(
    protected readonly doc: Document,
    /** The live annotation dict from the objects map (not a copy). */
    readonly Dict: PdfDict,
  ) {}

  /** /Subtype name without leading '/'; '' when missing. */
  get Subtype(): string {
    const s = this.Dict.get('Subtype');
    return isName(s) ? s.name : '';
  }

  /** /Rect as [llx, lly, urx, ury]; undefined when missing or malformed. */
  get Rect(): [number, number, number, number] | undefined {
    const r = numArray(this.doc, this.Dict.get('Rect'), 4);
    return r ? [r[0], r[1], r[2], r[3]] : undefined;
  }

  /** /C as RGB [r, g, b] in 0..1; undefined when absent or not 3-component. */
  get Color(): [number, number, number] | undefined {
    const c = numArray(this.doc, this.Dict.get('C'), 3);
    return c ? [c[0], c[1], c[2]] : undefined;
  }

  /** /Contents text; undefined when absent. */
  get Contents(): string | undefined {
    const s = this.doc.resolve(this.Dict.get('Contents'));
    return isString(s) ? decodePdfText(s.bytes) : undefined;
  }

  /** /NM annotation name; undefined when absent. */
  get Name(): string | undefined {
    const s = this.doc.resolve(this.Dict.get('NM'));
    return isString(s) ? decodePdfText(s.bytes) : undefined;
  }

  /** /M modification date (parsed Date, or raw string when unparseable). */
  get ModDate(): Date | string | undefined {
    const s = this.doc.resolve(this.Dict.get('M'));
    return isString(s) ? parsePdfDate(decodePdfText(s.bytes)) : undefined;
  }

  /** /F flag bitfield; 0 when absent. */
  get Flags(): number {
    const f = this.doc.resolve(this.Dict.get('F'));
    return typeof f === 'number' ? f : 0;
  }

  get Print(): boolean { return (this.Flags & FLAG_PRINT) !== 0; }
  get Hidden(): boolean { return (this.Flags & FLAG_HIDDEN) !== 0; }

  /** /CA constant opacity in 0..1; undefined when absent. */
  get Opacity(): number | undefined {
    const a = this.doc.resolve(this.Dict.get('CA'));
    return typeof a === 'number' ? a : undefined;
  }
}

/** Wrap an annotation dict in its typed handle. Subtype-specific subclasses are
 *  introduced by later plans; today every subtype yields the base `Annotation`. */
export function wrapAnnotation(doc: Document, dict: PdfDict): Annotation {
  return new Annotation(doc, dict);
}
```

- [ ] **Step 5: Repurpose `Page.Annotations`**

In `src/page.ts`, add to the import from `./types.js` nothing new (it already imports `isArray`, `isDict`), and add a new import line after the `metadata` import:

```ts
import { Annotation, wrapAnnotation } from './annotation.js';
```

Replace the existing getter:

```ts
  /** Resolved /Annots entries that are dicts; [] when absent. */
  get Annotations(): PdfDict[] {
    const a = this.doc.resolve(this.Dict.get('Annots'));
    if (!isArray(a)) return [];
    const out: PdfDict[] = [];
    for (const e of a) {
      const d = this.doc.resolve(e);
      if (isDict(d)) out.push(d);
    }
    return out;
  }
```

with:

```ts
  /** This page's annotations as typed handles; [] when absent. Each handle's
   *  `.Dict` exposes the raw annotation dictionary. */
  get Annotations(): Annotation[] {
    const a = this.doc.resolve(this.Dict.get('Annots'));
    if (!isArray(a)) return [];
    const out: Annotation[] = [];
    for (const e of a) {
      const d = this.doc.resolve(e);
      if (isDict(d)) out.push(wrapAnnotation(this.doc, d));
    }
    return out;
  }
```

- [ ] **Step 6: Fix the breaking existing test**

In `test/page.test.ts:86-87`, the assertions currently expect raw dicts:

```ts
    expect(new Page(doc, new Map<string, any>([['Annots', [a1, a2]]]), 1).Annotations).toEqual([a1, a2]);
    expect(new Page(doc, new Map(), 1).Annotations).toEqual([]);
```

Replace with `.Dict`-aware versions:

```ts
    expect(new Page(doc, new Map<string, any>([['Annots', [a1, a2]]]), 1).Annotations.map((x) => x.Dict)).toEqual([a1, a2]);
    expect(new Page(doc, new Map(), 1).Annotations).toEqual([]);
```

(Here `a1`/`a2` are inline dicts in the page, so `resolve` returns them unchanged and `.Dict` is identity.)

- [ ] **Step 7: Run typecheck and tests**

Run: `npm run typecheck` — Expected: no errors.
Run: `npx vitest run test/annotation.test.ts test/page.test.ts` — Expected: PASS.
Run: `npm test` — Expected: full suite green.

- [ ] **Step 8: Commit**

```bash
git add src/annotation.ts src/page.ts test/annotation.test.ts test/page.test.ts test/helpers/build-annot-target.ts
git commit -m "feat: typed Annotation read model over /Annots

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: Live setters on `Annotation`

Adds mutating accessors so callers can edit existing annotations in place.

**Files:**
- Modify: `src/annotation.ts` (add setters + a shared validation helper + `encodePdfText`/`formatPdfDate` imports)
- Modify: `test/annotation.test.ts` (add a setter round-trip block)

**Interfaces:**
- Consumes: `encodePdfText(s)`, `formatPdfDate(d)` from `metadata.ts`.
- Produces (added to `Annotation`): `set Rect(v: [number,number,number,number] | undefined)`, `set Color(v: [number,number,number] | undefined)`, `set Contents(v: string | undefined)`, `set Name(v: string | undefined)`, `set ModDate(v: Date | string | undefined)`, `set Flags(v: number)`, `set Print(v: boolean)`, `set Hidden(v: boolean)`, `set Opacity(v: number | undefined)`.
- Produces (exported helper): `function checkNums(key: string, v: number[], n: number): number[]`.

- [ ] **Step 1: Write the failing test**

Append a new `describe` block to `test/annotation.test.ts` (`Document` and `buildAnnotTarget` are already imported at the top from Task 1 — do not re-import them):

```ts
describe('Annotation setters', () => {
  it('round-trips mutations onto the live dict', () => {
    const doc = Document.Open(buildAnnotTarget());
    const a = doc.Pages[0].Annotations[0];

    a.Rect = [1, 2, 3, 4];
    expect(a.Rect).toEqual([1, 2, 3, 4]);

    a.Color = [0, 0.5, 1];
    expect(a.Color).toEqual([0, 0.5, 1]);
    a.Color = undefined;
    expect(a.Color).toBeUndefined();

    a.Contents = 'edited';
    expect(a.Contents).toBe('edited');

    a.Name = 'note-1';
    expect(a.Name).toBe('note-1');

    const when = new Date(Date.UTC(2026, 5, 18, 12, 0, 0));
    a.ModDate = when;
    expect(a.ModDate).toEqual(when);

    a.Print = false;
    expect(a.Print).toBe(false);
    a.Hidden = true;
    expect(a.Hidden).toBe(true);

    a.Opacity = 0.25;
    expect(a.Opacity).toBe(0.25);
  });

  // (`Document` and `buildAnnotTarget` come from the imports added in Task 1.)
  it('rejects invalid input with TypeError', () => {
    const doc = Document.Open(buildAnnotTarget());
    const a = doc.Pages[0].Annotations[0];
    expect(() => { a.Rect = [1, 2, 3] as any; }).toThrow(TypeError);
    expect(() => { a.Color = [2, 0, 0]; }).toThrow(TypeError);
    expect(() => { a.Opacity = 5; }).toThrow(TypeError);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/annotation.test.ts`
Expected: FAIL — assigning to `a.Rect` errors (no setter) or the `TypeError` expectations are unmet.

- [ ] **Step 3: Implement the setters**

In `src/annotation.ts`, extend the imports:

```ts
import { decodePdfText, encodePdfText, formatPdfDate, parsePdfDate } from './metadata.js';
```

Add this validation helper near the top (after `numArray`):

```ts
/** Validate an array of exactly `n` finite numbers; returns a defensive copy. */
export function checkNums(key: string, v: number[], n: number): number[] {
  if (!Array.isArray(v) || v.length !== n || !v.every((x) => typeof x === 'number' && Number.isFinite(x))) {
    throw new TypeError(`${key} must be ${n} finite numbers`);
  }
  return [...v];
}

/** A PdfString tagged object carrying a PDF text string. */
function pdfText(s: string): PdfObject {
  return { kind: 'string', bytes: encodePdfText(s) };
}
```

Add the setters inside the `Annotation` class (each immediately after its getter):

```ts
  set Rect(v: [number, number, number, number] | undefined) {
    if (v === undefined) { this.Dict.delete('Rect'); return; }
    this.Dict.set('Rect', checkNums('Rect', v, 4));
  }

  set Color(v: [number, number, number] | undefined) {
    if (v === undefined) { this.Dict.delete('C'); return; }
    const c = checkNums('Color', v, 3);
    if (c.some((x) => x < 0 || x > 1)) throw new TypeError('Color components must be in 0..1');
    this.Dict.set('C', c);
  }

  set Contents(v: string | undefined) {
    if (v === undefined) { this.Dict.delete('Contents'); return; }
    if (typeof v !== 'string') throw new TypeError('Contents must be a string');
    this.Dict.set('Contents', pdfText(v));
  }

  set Name(v: string | undefined) {
    if (v === undefined) { this.Dict.delete('NM'); return; }
    if (typeof v !== 'string') throw new TypeError('Name must be a string');
    this.Dict.set('NM', pdfText(v));
  }

  set ModDate(v: Date | string | undefined) {
    if (v === undefined) { this.Dict.delete('M'); return; }
    const text = v instanceof Date ? formatPdfDate(v) : String(v);
    this.Dict.set('M', pdfText(text));
  }

  set Flags(v: number) {
    if (typeof v !== 'number' || !Number.isInteger(v)) throw new TypeError('Flags must be an integer');
    this.Dict.set('F', v);
  }

  set Print(v: boolean) { this.Flags = v ? (this.Flags | FLAG_PRINT) : (this.Flags & ~FLAG_PRINT); }
  set Hidden(v: boolean) { this.Flags = v ? (this.Flags | FLAG_HIDDEN) : (this.Flags & ~FLAG_HIDDEN); }

  set Opacity(v: number | undefined) {
    if (v === undefined) { this.Dict.delete('CA'); return; }
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 1) throw new TypeError('Opacity must be in 0..1');
    this.Dict.set('CA', v);
  }
```

Note: place each setter directly beneath its matching getter so the getter and setter form one accessor pair. `set Print`/`set Hidden` reuse the `Flags` getter/setter.

- [ ] **Step 4: Run typecheck and tests**

Run: `npm run typecheck` — Expected: no errors.
Run: `npx vitest run test/annotation.test.ts` — Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/annotation.ts test/annotation.test.ts
git commit -m "feat: live setters for Annotation properties

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: Creation helper, `Document.pageRef`, and `Page.RemoveAnnotation`

Adds the internal `createAnnotation` helper (used by later per-subtype plans), the `Document.pageRef` accessor it needs for `/P`, and the public `Page.RemoveAnnotation`.

**Files:**
- Modify: `src/document.ts` (add `@internal pageRef`)
- Modify: `src/annotation.ts` (add `createAnnotation` + `ownAnnots`)
- Modify: `src/page.ts` (add `RemoveAnnotation`)
- Modify: `test/annotation.test.ts` (create + remove tests)

**Interfaces:**
- Consumes: `Document.allocObject(obj): PdfRef`, `Document.resolve`, `Page.Dict`, `Page.Number`, `name(n)`/`ref(num,gen)` from `types.ts`, `checkNums` (Task 2), `encodePdfText`/`formatPdfDate`.
- Produces:
  - `Document.pageRef(page: number): PdfRef` (`@internal`)
  - `interface BaseAnnotInit { subtype: string; rect: [number,number,number,number]; color?: [number,number,number]; contents?: string }`
  - `function createAnnotation(doc: Document, page: Page, init: BaseAnnotInit): PdfDict` (`@internal`)
  - `Page.RemoveAnnotation(a: Annotation | PdfDict): void`

- [ ] **Step 1: Write the failing test**

In `test/annotation.test.ts`, extend the existing top-of-file import from `../src/annotation.js` to add `createAnnotation`:

```ts
import { Annotation, createAnnotation } from '../src/annotation.js';
```

Then append a new `describe` block:

```ts
describe('Annotation lifecycle', () => {
  it('createAnnotation attaches a well-formed dict to the page /Annots', () => {
    const doc = Document.Open(buildAnnotTarget());
    const page = doc.Pages[0];
    const before = page.Annotations.length;

    const dict = createAnnotation(doc, page, {
      subtype: 'Square',
      rect: [5, 5, 95, 45],
      color: [0, 0, 1],
      contents: 'made',
    });

    expect(page.Annotations.length).toBe(before + 1);
    const made = page.Annotations[page.Annotations.length - 1];
    expect(made.Dict).toBe(dict);
    expect(made.Subtype).toBe('Square');
    expect(made.Rect).toEqual([5, 5, 95, 45]);
    expect(made.Color).toEqual([0, 0, 1]);
    expect(made.Contents).toBe('made');
    expect(made.Print).toBe(true);              // default /F = 4
    expect(made.ModDate).toBeInstanceOf(Date);  // /M set to now
  });

  it('createAnnotation creates /Annots when the page has none', () => {
    const doc = Document.Open(buildBlankPage());
    const page = doc.Pages[0];
    expect(page.Annotations).toHaveLength(0);
    createAnnotation(doc, page, { subtype: 'Square', rect: [0, 0, 10, 10] });
    expect(page.Annotations).toHaveLength(1);
  });

  it('createAnnotation validates rect before allocating', () => {
    const doc = Document.Open(buildBlankPage());
    const page = doc.Pages[0];
    expect(() => createAnnotation(doc, page, { subtype: 'Square', rect: [0, 0, 10] as any }))
      .toThrow(TypeError);
    expect(page.Annotations).toHaveLength(0); // no stranded object
  });

  it('RemoveAnnotation removes exactly the target', () => {
    const doc = Document.Open(buildAnnotTarget());
    const page = doc.Pages[0];
    const link = page.Annotations.find((a) => a.Subtype === 'Link')!;
    page.RemoveAnnotation(link);
    expect(page.Annotations.map((a) => a.Subtype)).toEqual(['Text']);
  });
});
```

Add a `buildBlankPage` helper to `test/helpers/build-annot-target.ts`:

```ts
/** One page with no /Annots entry. */
export function buildBlankPage(): Uint8Array {
  const objects: string[] = [];
  objects[1] = `<< /Type /Catalog /Pages 2 0 R >>`;
  objects[2] = `<< /Type /Pages /Count 1 /Kids [3 0 R] /MediaBox [0 0 300 200] >>`;
  objects[3] = `<< /Type /Page /Parent 2 0 R >>`;
  return assemble(objects, 3, 1);
}
```

Import it in the test: `import { buildAnnotTarget, buildBlankPage } from './helpers/build-annot-target.js';`

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/annotation.test.ts`
Expected: FAIL — `createAnnotation` / `RemoveAnnotation` not defined.

- [ ] **Step 3: Add `Document.pageRef`**

In `src/document.ts`, add this method next to the existing private `pageRefForNumber` (around line 351). Keep `pageRefForNumber` as-is (its error message is outline-specific); `pageRef` is the generic public-internal accessor:

```ts
  /** @internal The indirect ref for a 1-based page number; throws when that page
   *  is not an indirect object. */
  pageRef(page: number): PdfRef {
    const num = this.pageObjNums[page - 1];
    if (!num) throw new UnsupportedFeatureError('page is not an indirect object');
    return ref(num);
  }
```

(`ref`, `PdfRef`, and `UnsupportedFeatureError` are already imported in `document.ts`.)

- [ ] **Step 4: Add `createAnnotation` + `ownAnnots` to `src/annotation.ts`**

Extend imports:

```ts
import { PdfDict, PdfObject, isArray, isName, isString, name } from './types.js';
import type { Page } from './page.js';
```

(`import type { Page }` is erased at runtime, so it does not create an import cycle with `page.ts`.)

Add at module scope:

```ts
/** The page's own live /Annots array, created and attached when absent. */
function ownAnnots(doc: Document, page: Page): PdfObject[] {
  const existing = doc.resolve(page.Dict.get('Annots'));
  if (isArray(existing)) return existing;
  const arr: PdfObject[] = [];
  page.Dict.set('Annots', arr);
  return arr;
}

/** Common fields accepted by every annotation constructor. */
export interface BaseAnnotInit {
  subtype: string;
  rect: [number, number, number, number];
  color?: [number, number, number];
  contents?: string;
}

/** @internal Build an annotation dict, attach it to the page's own /Annots, and
 *  return the live dict. Sets /Type, /Subtype, /Rect, default /F Print, /M now,
 *  and /P -> the page. Validates all inputs before allocating any object. */
export function createAnnotation(doc: Document, page: Page, init: BaseAnnotInit): PdfDict {
  const dict: PdfDict = new Map<string, PdfObject>();
  dict.set('Type', name('Annot'));
  dict.set('Subtype', name(init.subtype));
  dict.set('Rect', checkNums('rect', init.rect, 4));
  dict.set('F', FLAG_PRINT);
  dict.set('M', pdfText(formatPdfDate(new Date())));
  if (init.color !== undefined) {
    const c = checkNums('color', init.color, 3);
    if (c.some((x) => x < 0 || x > 1)) throw new TypeError('color components must be in 0..1');
    dict.set('C', c);
  }
  if (init.contents !== undefined) {
    if (typeof init.contents !== 'string') throw new TypeError('contents must be a string');
    dict.set('Contents', pdfText(init.contents));
  }
  dict.set('P', doc.pageRef(page.Number));
  const r = doc.allocObject(dict);
  ownAnnots(doc, page).push(r);
  return dict;
}
```

Note: every validating `set` runs before `doc.allocObject`, so a `TypeError` leaves no stranded object.

- [ ] **Step 5: Add `Page.RemoveAnnotation`**

In `src/page.ts`, add immediately after the `Annotations` getter:

```ts
  /** Remove an annotation from this page's /Annots. Accepts an Annotation handle
   *  or a raw dict; a no-op when the annotation is not on this page. */
  RemoveAnnotation(a: Annotation | PdfDict): void {
    const target = a instanceof Annotation ? a.Dict : a;
    const arr = this.doc.resolve(this.Dict.get('Annots'));
    if (!isArray(arr)) return;
    for (let i = 0; i < arr.length; i++) {
      if (this.doc.resolve(arr[i]) === target) { arr.splice(i, 1); return; }
    }
  }
```

(`Annotation` is already imported from Task 1; `isArray` is already imported.)

- [ ] **Step 6: Run typecheck and tests**

Run: `npm run typecheck` — Expected: no errors.
Run: `npx vitest run test/annotation.test.ts` — Expected: PASS.
Run: `npm test` — Expected: full suite green.

- [ ] **Step 7: Commit**

```bash
git add src/document.ts src/annotation.ts src/page.ts test/annotation.test.ts test/helpers/build-annot-target.ts
git commit -m "feat: annotation create helper and Page.RemoveAnnotation

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 4: Public exports, README, and Save→Open round-trip

Surfaces `Annotation` from the package entry point, documents the change (including the breaking `Page.Annotations` return type), and proves the create/remove path survives serialization.

**Files:**
- Modify: `src/index.ts` (export `Annotation`)
- Modify: `README.md` (Annotations row + note)
- Modify: `test/annotation.test.ts` (round-trip test)

**Interfaces:**
- Consumes: `Document.Open(buf)`, `Document.Save()`, `createAnnotation`, `Page.RemoveAnnotation`.
- Produces: `Annotation` re-exported from `index.ts`.

- [ ] **Step 1: Write the failing round-trip test**

Append to `test/annotation.test.ts`:

```ts
describe('Annotation persistence', () => {
  it('round-trips a created annotation through Save/Open', () => {
    const doc = Document.Open(buildBlankPage());
    createAnnotation(doc, doc.Pages[0], {
      subtype: 'Square',
      rect: [5, 5, 95, 45],
      color: [0, 0, 1],
      contents: 'persisted',
    });

    const reopened = Document.Open(doc.Save());
    const annots = reopened.Pages[0].Annotations;
    expect(annots).toHaveLength(1);
    expect(annots[0].Subtype).toBe('Square');
    expect(annots[0].Rect).toEqual([5, 5, 95, 45]);
    expect(annots[0].Color).toEqual([0, 0, 1]);
    expect(annots[0].Contents).toBe('persisted');
  });

  it('round-trips a removal through Save/Open', () => {
    const doc = Document.Open(buildAnnotTarget());
    const link = doc.Pages[0].Annotations.find((a) => a.Subtype === 'Link')!;
    doc.Pages[0].RemoveAnnotation(link);

    const reopened = Document.Open(doc.Save());
    expect(reopened.Pages[0].Annotations.map((a) => a.Subtype)).toEqual(['Text']);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails or passes**

Run: `npx vitest run test/annotation.test.ts`
Expected: PASS for the round-trip (the machinery exists from Tasks 1-3). If it fails, fix before continuing — the failure indicates a real serialization gap. This step exists to confirm persistence, so a green result is the deliverable; proceed to exports.

- [ ] **Step 3: Export `Annotation` from `index.ts`**

In `src/index.ts`, add (placed near the other model exports such as `Page`/`Field`):

```ts
export { Annotation } from './annotation.js';
```

- [ ] **Step 4: Update the README**

In `README.md`, the API-overview table currently has:

```
| `page.Annotations` | Annotation dictionaries |
```

Replace that row with:

```
| `page.Annotations` | Typed `Annotation[]` handles (`.Dict` for the raw dict) |
| `page.RemoveAnnotation(a)` | Remove an annotation from the page |
```

Add a short note beneath the table (or in the relevant section) recording the breaking change:

```
> **Breaking change:** `page.Annotations` now returns typed `Annotation` handles
> instead of raw dictionaries. Use `page.Annotations.map(a => a.Dict)` for the
> previous behaviour. Each handle exposes typed, mutable accessors (`Rect`,
> `Color`, `Contents`, `Name`, `ModDate`, `Flags`, `Print`, `Hidden`, `Opacity`).
```

- [ ] **Step 5: Run typecheck and the full suite**

Run: `npm run typecheck` — Expected: no errors.
Run: `npm test` — Expected: full suite green.
Run: `npm run build` — Expected: clean `tsc` build (verifies the public `.d.ts` for `Annotation` emits).

- [ ] **Step 6: Commit**

```bash
git add src/index.ts README.md test/annotation.test.ts
git commit -m "feat: export Annotation; document typed Page.Annotations

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Notes for the next plans

This foundation deliberately stops at the base `Annotation` and a generic
`createAnnotation`. The per-subtype plans (`fu3` text notes, `c9p` links, `vpm`
markup, `82t` stamps) each:

- introduce their subclass (e.g. `TextAnnotation extends Annotation`) with
  subtype-specific accessors,
- extend `wrapAnnotation`'s switch on `/Subtype` to return that subclass,
- add the typed `Page.Add*` method that calls `createAnnotation` with the right
  `subtype` plus subtype-specific dict entries (and, for markup/stamp, an `/AP`
  built via `buildAppearanceXObject`/`installAP`).

The XMP track (`rwn`/`82q`) is independent and gets its own plan.

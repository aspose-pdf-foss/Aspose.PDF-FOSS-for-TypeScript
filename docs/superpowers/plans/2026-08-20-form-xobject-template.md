# Form XObject Template API Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a caller author a reusable Form XObject — `doc.NewTemplate(w, h)`, drawn into with every existing authoring API, then `PlaceOn` any number of pages from one allocated object.

**Architecture:** A template wraps a page dict that is never allocated and never linked into the page tree, so `AddText`/`AddImage`/`AddTable`/`Graphics()` all work on it unchanged. The first `PlaceOn` converts that page's contents and resources into a Form XObject and freezes the template. Placement reuses `text.ts`'s `placementMatrix` plus a `containMatrix` extracted from `compose.ts`.

**Tech Stack:** TypeScript (ESM, NodeNext, `strict`), vitest. Zero runtime dependencies — `node:` built-ins only.

**Spec:** `docs/superpowers/specs/2026-08-20-form-xobject-template-design.md` — read it before Task 1 and keep it open; this plan argues from it.

**Issue:** `aspose-pdf-foss-for-ts-lucg.3` (beads). Claim it with `bd update aspose-pdf-foss-for-ts-lucg.3 --claim` before Task 1.

## Global Constraints

- **Zero runtime dependencies.** Only `node:` built-ins.
- **ESM + NodeNext.** Every import specifier carries the `.js` extension.
- **Task order is load-bearing.** Task 1 pins the contain arithmetic; Task 2 extracts it. Do not reorder — see the note in Task 1.
- **`rect` is `[x, y, w, h]` in the public API and `[x0, y0, x1, y1]` in `placementMatrix`/`containMatrix`.** `PlaceOn` converts once, at its own boundary. Those helpers normalize with `Math.min`/`Math.max`, so a w/h pair passed through silently places the form in the wrong rect at the wrong size rather than erroring.
- **`rotation` is degrees counter-clockwise about the rect's ORIGIN**, matching what `stamp.ts` documents for `AddText`.
- **Validation precedes allocation**, so a rejected call leaves the document byte-identical.
- **Errors are `TypeError`** for argument and lifecycle violations.
- **Structure inside a template is unsupported and undetected** — documented, not guarded.
- **Run before closing:** `npm run typecheck` and `npm test`, both green.
- **Commit style:** `feat(lucg.3): <subject>` / `test(lucg.3): …` / `docs(lucg.3): …`, ending with a `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>` trailer.

---

## File Structure

| File | Status | Responsibility |
|---|---|---|
| `test/nup.test.ts` | modify (Task 1) | One new case pinning the contain arithmetic with a differing aspect ratio. |
| `src/text.ts` | modify | `containMatrix` and `transformedExtent`, beside the existing `placementMatrix`. |
| `src/compose.ts` | modify | `placeFitted` delegates to `containMatrix`; its private `transformedExtent` goes away. |
| `src/pagecontent.ts` | modify | `registerXObjectRef` — register-or-reuse an already-allocated form on a page. |
| `src/template.ts` | **create** | `Template`, `PlaceOptions`, the page→form conversion, placement. |
| `src/document.ts` | modify | `NewTemplate` entry point. |
| `test/template.test.ts` | **create** | The arithmetic and the model, from numbers. |
| `test/template-place.test.ts` | **create** | End to end: reuse, freeze, refusals, options, a pixel probe. |
| `src/index.ts` | modify | Export `Template`, `PlaceOptions`. |
| `README.md` / `CHANGELOG.md` | modify | Docs. |

---

## Task 1: Pin the contain arithmetic

**Files:**
- Modify: `test/nup.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: nothing consumed by code. Task 2 depends on this case existing.

**One deviation from the spec, decided while planning.** The spec names a new
file `test/nup-contain.test.ts`. The case goes into `test/nup.test.ts` instead:
it needs that file's `placements`, `pageContent` and `buildNUpSource` helpers,
and it belongs beside the very case whose degeneracy motivates it — a reader
comparing the two learns more than a reader who has to find the other file.

**Why this comes first.** The existing N-up suite does **not** cover the arithmetic Task 2 extracts. Its `'scales each cell to fit'` case puts a 200x100 source into a 200x100 cell — an exact fit where the scale is 1 and the centring offset is 0, so a transposed, stretched or uncentred build produces identical numbers. The `drawBorder` cases assert the stroked *frame*, which `NUp` computes from the cell rect and never from the placement. Extracting first would be a verbatim move with nothing under it.

- [ ] **Step 1: Write the failing test**

Append to the `describe('doc.NUp', …)` block in `test/nup.test.ts`:

```ts
  it('contains a differing aspect ratio: uniform scale, centred in the cell', () => {
    // THE case the existing 200x100-into-200x100 test cannot make: there the
    // scale is 1 and the centring offset is 0, so stretch, transpose and
    // no-centring all produce identical numbers.
    //
    // Source pages are 200x100 (2:1). A 300x200 sheet in a 2x1 grid gives
    // 150x200 cells (3:4), so:
    //   contain  -> s = min(150/200, 200/100) = 0.75 both axes,
    //               fh = 75, so f = (200 - 75) / 2 = 62.5
    //   stretch  -> sx = 0.75, sy = 2      (caught by sx === sy)
    //   transposed -> s = min(200/200, 150/100) = 1  (caught by the value)
    //   uncentred  -> f = 0                (caught by the offset)
    const out = Document.Open(buildNUpSource(2)).NUp(2, 1, { pageSize: [300, 200] });
    const places = placements(pageContent(out, out.Pages[0]));
    expect(places).toHaveLength(2);
    for (const p of places) {
      expect(p.sx).toBeCloseTo(0.75, 6);
      expect(p.sy).toBeCloseTo(0.75, 6);   // uniform, not stretched
      expect(p.f).toBeCloseTo(62.5, 6);    // centred vertically in the cell
    }
    // and the two cells sit side by side
    expect(places.map((p) => p.e).sort((a, b) => a - b)).toEqual([0, 150]);
  });
```

- [ ] **Step 2: Run it and confirm it PASSES**

Run: `npx vitest run test/nup.test.ts`

Expected: PASS. This is a characterization test over behaviour that already works — the point is to have it *before* the refactor, not to drive new code. The numbers above were measured against the current implementation, so a failure here means the fixture or the option shape is wrong, not the arithmetic.

Note `pageSize` is `[w, h]`, not a rect — `NUp` throws `NUp: pageSize must be [w, h] (two positive numbers)` for a four-element array.

- [ ] **Step 3: Prove it is load-bearing**

In `src/compose.ts`'s `placeFitted`, change `const s = Math.min(cw / tw, ch / th);` to `const s = Math.min(ch / tw, cw / th);` (the transposition). Run `npx vitest run test/nup.test.ts`:

- the new case must FAIL (`sx` becomes 1)
- `'scales each cell to fit …'` must stay GREEN — which is the whole reason the new case exists

Restore, then change `s` to a per-axis stretch by replacing `placementMatrix(bbox, m, [x0, y0, x0 + fw, y0 + fh])` with `placementMatrix(bbox, m, cell)`: the new case must FAIL on `sy`, and the old one stay green. Restore.

- [ ] **Step 4: Commit**

```bash
git add test/nup.test.ts
git commit -m "test(lucg.3): pin N-up's contain arithmetic before extracting it

The existing suite does not cover it: the scale-to-fit case puts a 200x100
source into a 200x100 cell, where the scale is 1 and the centring offset is 0,
so stretch, transpose and no-centring all produce identical numbers; the
drawBorder cases assert the stroked frame, which is computed from the cell rect
and never from the placement.

A 200x100 source into a 150x200 cell separates all three. Measured: the
transposition reddens the new case alone and leaves the old one green.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 2: Extract `containMatrix`

**Files:**
- Modify: `src/text.ts` (add beside `placementMatrix`)
- Modify: `src/compose.ts` (`placeFitted` delegates; its private `transformedExtent` goes away)
- Test: `test/nup.test.ts` (run only — do not edit)

**Interfaces:**
- Consumes: `placementMatrix`, `apply`, `Matrix` (already in `text.ts`).
- Produces:
  ```ts
  export function transformedExtent(bbox: number[], m: Matrix): [number, number] | undefined;
  export function containMatrix(bbox: number[], m: Matrix, rect: number[]): Matrix | undefined;
  ```
  `rect` is `[x0, y0, x1, y1]` corners. Task 4 calls `containMatrix`.

- [ ] **Step 1: Move `transformedExtent` into `text.ts`**

Cut it from `src/compose.ts` and paste it into `src/text.ts` immediately above `placementMatrix`, adding `export` and this comment:

```ts
/** The aligned bounding box of `bbox` transformed by `m` (a form's /Matrix),
 *  returned as `[w, h]`; `undefined` for a degenerate (zero-area) box.
 *
 *  Exported because both placements need it: N-up's contain fit and a
 *  template's. It lives here beside {@link placementMatrix} rather than in
 *  compose.ts, which is page-to-page composition and the wrong direction for
 *  an authoring primitive to import from. */
export function transformedExtent(bbox: number[], m: Matrix): [number, number] | undefined {
  const corners: [number, number][] = [
    apply(m, bbox[0], bbox[1]), apply(m, bbox[2], bbox[1]),
    apply(m, bbox[2], bbox[3]), apply(m, bbox[0], bbox[3]),
  ];
  const xs = corners.map((c) => c[0]), ys = corners.map((c) => c[1]);
  const w = Math.max(...xs) - Math.min(...xs), h = Math.max(...ys) - Math.min(...ys);
  return w === 0 || h === 0 ? undefined : [w, h];
}
```

- [ ] **Step 2: Add `containMatrix` beneath `placementMatrix` in `text.ts`**

```ts
/** Place a form's `bbox` (under its /Matrix `m`) inside `rect`
 *  (`[x0, y0, x1, y1]`) scaled UNIFORMLY and centred, preserving aspect ratio;
 *  `undefined` for a degenerate box. Contrast {@link placementMatrix}, which
 *  fills the rect exactly and may stretch.
 *
 *  One owner, deliberately: N-up imposition and a placed template both need
 *  "scale uniformly and centre", and two copies is how the two come to
 *  disagree about one placement. The body is `placeFitted`'s, verbatim — it
 *  computes the fitted sub-rect and then delegates, so the result is
 *  arithmetically identical to what N-up produced before the extraction. */
export function containMatrix(bbox: number[], m: Matrix, rect: number[]): Matrix | undefined {
  const ext = transformedExtent(bbox, m);
  if (ext === undefined) return undefined;
  const [tw, th] = ext;
  const rx0 = Math.min(rect[0], rect[2]), rx1 = Math.max(rect[0], rect[2]);
  const ry0 = Math.min(rect[1], rect[3]), ry1 = Math.max(rect[1], rect[3]);
  const cw = rx1 - rx0, ch = ry1 - ry0;
  const s = Math.min(cw / tw, ch / th);
  const fw = tw * s, fh = th * s;
  const x0 = rx0 + (cw - fw) / 2;
  const y0 = ry0 + (ch - fh) / 2;
  return placementMatrix(bbox, m, [x0, y0, x0 + fw, y0 + fh]);
}
```

- [ ] **Step 3: Make `placeFitted` delegate**

In `src/compose.ts`, replace the body from `const ext = transformedExtent(bbox, m);` down to `if (place === undefined) return;` with:

```ts
  const place = containMatrix(bbox, m, cell);
  if (place === undefined) return;   // degenerate source: nothing to draw
```

Remove `transformedExtent` from the file, drop `placementMatrix` from its `./text.js` import if nothing else there uses it, and add `containMatrix`.

- [ ] **Step 4: Run the N-up suite**

Run: `npx vitest run test/nup.test.ts test/compose.test.ts`

Expected: PASS, including the case added in Task 1 — that case is the evidence the extraction is arithmetically identical.

- [ ] **Step 5: Typecheck and commit**

```bash
npm run typecheck
npx vitest run test/nup.test.ts test/compose.test.ts test/booklet.test.ts
git add src/text.ts src/compose.ts
git commit -m "feat(lucg.3): one owner for the contain placement arithmetic

containMatrix and transformedExtent move to text.ts beside placementMatrix,
and placeFitted delegates. The body is placeFitted's verbatim — it computes the
fitted sub-rect and delegates to placementMatrix — so N-up's output is
arithmetically unchanged, which the case added in the previous commit is there
to demonstrate.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 3: The `Template` model

**Files:**
- Create: `src/template.ts`
- Modify: `src/pagecontent.ts` (`registerXObjectRef`)
- Modify: `src/document.ts` (`NewTemplate`)
- Test: `test/template-place.test.ts` (create)

**Interfaces:**
- Consumes: `placementMatrix` (`text.ts`), `ensureOwnResources`/`ensureOwnSubdict`/`freshKey`/`appendContent`/`num` (`pagecontent.ts`), `Page`, `Document`.
- Produces:
  ```ts
  // pagecontent.ts
  export function registerXObjectRef(doc: Document, page: Page, ref: PdfRef): string;

  // template.ts
  export class Template {
    constructor(doc: Document, width: number, height: number);
    readonly width: number;
    readonly height: number;
    get page(): Page;                       // throws once placed
    PlaceOn(page: Page, rect: [number, number, number, number]): void;
  }

  // document.ts
  NewTemplate(width: number, height: number): Template;
  ```
  Task 4 widens `PlaceOn` with an options argument.

- [ ] **Step 1: Write the failing test**

Create `test/template-place.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { PageFormat } from '../src/pageformat.js';
import { isStream, type PdfDict } from '../src/types.js';

const dec = (u: Uint8Array) => new TextDecoder('latin1').decode(u);

/** A document with `n` A4 pages. */
const docWith = (n: number) => {
  const doc = Document.New();
  for (let i = 0; i < n; i++) doc.AddPage(PageFormat.A4);
  return doc;
};

/** A drawn-into 100x50 template. */
const drawn = (doc: Document) => {
  const t = doc.NewTemplate(100, 50);
  t.page.Graphics().setFillColor([1, 0, 0]).drawRect(0, 0, 100, 50).fill().apply();
  return t;
};

describe('Document.NewTemplate', () => {
  it('exposes a drawable page that is NOT in the page tree', () => {
    // The load-bearing assumption of the whole feature: a Page is a thin live
    // wrapper over a dict, so an off-tree one draws exactly like a real page.
    const doc = docWith(1);
    const before = doc.Pages.length;
    const t = doc.NewTemplate(100, 50);
    t.page.Graphics().drawRect(0, 0, 10, 10).fill().apply();
    expect(doc.Pages).toHaveLength(before);
    expect(t.page.Contents.length).toBeGreaterThan(0);
  });

  it('accepts the ordinary authoring APIs', () => {
    // AddText and Graphics both reach the page only through appendContent and
    // ensureOwnResources, neither of which cares about the page tree. Asserted
    // rather than assumed, because nothing else in the suite pins it.
    const doc = docWith(1);
    const t = doc.NewTemplate(200, 80);
    t.page.AddText('ACME', 10, 30, { fontSize: 18 });
    t.page.Graphics().drawLine(0, 4, 200, 4).stroke().apply();
    const body = dec(t.page.Contents);
    expect(body).toContain('ACME');
    expect(body).toContain('re');
  });

  it('rejects a non-positive size and allocates nothing', () => {
    const doc = docWith(1);
    const before = doc.Save().length;
    expect(() => doc.NewTemplate(0, 50)).toThrow(TypeError);
    expect(() => doc.NewTemplate(100, -1)).toThrow(TypeError);
    expect(() => doc.NewTemplate(Number.NaN, 50)).toThrow(TypeError);
    expect(doc.Save().length).toBe(before);
  });
});

describe('Template.PlaceOn', () => {
  it('allocates ONE form for placements on two pages', () => {
    // The whole argument for the feature: a logo on forty pages is one object.
    const doc = docWith(2);
    const t = drawn(doc);
    t.PlaceOn(doc.Pages[0], [40, 700, 100, 50]);
    t.PlaceOn(doc.Pages[1], [40, 700, 100, 50]);

    const rt = Document.Open(doc.Save());
    let forms = 0;
    for (const [, obj] of rt.objectEntries()) {
      if (isStream(obj) && (obj.dict.get('Subtype') as { name?: string })?.name === 'Form') forms++;
    }
    expect(forms).toBe(1);
    for (const p of rt.Pages) expect(dec(p.Contents)).toMatch(/\/Fm\d+ Do/);
  });

  it('emits two Do against ONE key when placed twice on one page', () => {
    const doc = docWith(1);
    const t = drawn(doc);
    t.PlaceOn(doc.Pages[0], [0, 700, 100, 50]);
    t.PlaceOn(doc.Pages[0], [200, 700, 100, 50]);
    const res = doc.resolve(doc.Pages[0].Dict.get('Resources')) as PdfDict;
    const xo = doc.resolve(res.get('XObject')) as PdfDict;
    expect([...xo.keys()]).toHaveLength(1);
    expect(dec(doc.Pages[0].Contents).match(/\/Fm\d+ Do/g)).toHaveLength(2);
  });

  it('stretches the form onto the rect', () => {
    // BBox is 100x50, rect is 200x50, so sx = 2 and sy = 1.
    const doc = docWith(1);
    const t = drawn(doc);
    t.PlaceOn(doc.Pages[0], [40, 700, 200, 50]);
    expect(dec(doc.Pages[0].Contents)).toContain('2 0 0 1 40 700 cm');
  });

  it('freezes the template: page throws after the first placement', () => {
    const doc = docWith(1);
    const t = drawn(doc);
    expect(() => t.page).not.toThrow();          // companion: fine before
    t.PlaceOn(doc.Pages[0], [0, 700, 100, 50]);
    expect(() => t.page).toThrow(TypeError);
  });

  it('catches an edit made through a stashed page reference', () => {
    // The getter cannot intercept a Page already handed out, so the build
    // records the content length and a later placement checks it.
    const doc = docWith(2);
    const t = drawn(doc);
    const stashed = t.page;
    t.PlaceOn(doc.Pages[0], [0, 700, 100, 50]);
    stashed.Graphics().drawRect(0, 0, 5, 5).fill().apply();
    expect(() => t.PlaceOn(doc.Pages[1], [0, 700, 100, 50])).toThrow(TypeError);
  });

  it('refuses an empty template and allocates nothing', () => {
    const doc = docWith(1);
    const t = doc.NewTemplate(100, 50);
    const before = doc.Save().length;
    expect(() => t.PlaceOn(doc.Pages[0], [0, 700, 100, 50])).toThrow(TypeError);
    expect(doc.Save().length).toBe(before);
  });

  it('rejects a non-positive rect', () => {
    const doc = docWith(1);
    const t = drawn(doc);
    expect(() => t.PlaceOn(doc.Pages[0], [0, 700, 0, 50])).toThrow(TypeError);
    expect(() => t.PlaceOn(doc.Pages[0], [0, 700, 100, Number.NaN])).toThrow(TypeError);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/template-place.test.ts`

Expected: FAIL — `doc.NewTemplate is not a function`.

- [ ] **Step 3: Add `registerXObjectRef` to `pagecontent.ts`**

Beside `registerPatternRefIn`:

```ts
/** Register (or reuse) an already-allocated XObject under the page's
 *  /Resources /XObject and return its key (for `/<key> Do`).
 *
 *  Reuses an existing key mapping to the same ref, which is what lets one
 *  template placed twice on a page emit two `Do` against one key. Contrast
 *  compose.ts's placeFitted, which mints a fresh key per cell because every
 *  N-up cell is a DIFFERENT imported form. */
export function registerXObjectRef(doc: Document, page: Page, ref: PdfRef): string {
  const res = ensureOwnResources(doc, page);
  const xo = ensureOwnSubdict(doc, res, 'XObject');
  for (const [k, v] of xo) {
    if (isRef(v) && v.num === ref.num && v.gen === ref.gen) return k;
  }
  const key = freshKey(xo, 'Fm');
  xo.set(key, ref);
  return key;
}
```

- [ ] **Step 4: Write `src/template.ts`**

```ts
// A reusable Form XObject a caller authors: doc.NewTemplate(w, h) hands back a
// Template wrapping an OFF-TREE page, so every existing authoring API draws
// into it unchanged, and the first PlaceOn converts that page into a form.
//
// Direction note: compose.ts's importPageAsXObject also turns a page into a
// form, but for a page in ANOTHER document — it deep-copies the resource graph
// through importGraphInto. Used same-document that would duplicate every font
// and image a template touches, which is why the conversion here is its own.
import type { Document } from './document.js';
import { Page } from './page.js';
import { enc, escapeName } from './serialize.js';
import { name, type PdfDict, type PdfObject, type PdfRef } from './types.js';
import { appendContent, num, registerXObjectRef } from './pagecontent.js';
import { IDENTITY, placementMatrix } from './text.js';

function positive(label: string, n: number): number {
  if (typeof n !== 'number' || !Number.isFinite(n) || n <= 0)
    throw new TypeError(`${label} must be a positive finite number`);
  return n;
}

/** A reusable piece of drawn content, placed on any number of pages from a
 *  single Form XObject. Build one with {@link Document.NewTemplate}. */
export class Template {
  /** @internal The page dict. Deliberately NOT allocated: the content streams
   *  and image XObjects that drawing allocates are real objects, and become
   *  reachable only through the form's /Resources once the template is placed.
   *  So an unplaced template contributes nothing to Save() — not because a
   *  sweep removes it, but because there was never an object to sweep. */
  private readonly dict: PdfDict;
  private readonly drawPage: Page;
  /** The built form, once {@link PlaceOn} has run. Its presence IS the frozen
   *  flag. */
  private form?: PdfRef;
  /** Content length at build time, for the stale-edit check. */
  private builtLength = 0;

  /** @internal Use {@link Document.NewTemplate}. */
  constructor(
    private readonly doc: Document,
    readonly width: number,
    readonly height: number,
  ) {
    positive('template width', width);
    positive('template height', height);
    this.dict = new Map<string, PdfObject>([
      ['Type', name('Page')],
      ['MediaBox', [0, 0, width, height]],
      ['CropBox', [0, 0, width, height]],
      ['Resources', new Map<string, PdfObject>()],
    ]);
    // Number 0: it has no position in a document that does not contain it.
    this.drawPage = new Page(doc, this.dict, 0);
  }

  /** The page to draw the template's content into, in template space
   *  (`[0, 0, width, height]`). Every ordinary authoring API works on it.
   *
   *  Throws once the template has been placed: the form is built on the first
   *  {@link PlaceOn} and cannot change afterwards. Silently ignoring the edit
   *  is the failure mode worth spending a throw on — it reads as the drawing
   *  call being broken rather than as a lifecycle mistake.
   *
   *  Note that logical structure inside a template is NOT supported: a `tag:`
   *  or `MarkContent` here would write /Pg references to a page that is never
   *  written to the file. Tag the *placement* instead. */
  get page(): Page {
    if (this.form !== undefined)
      throw new TypeError(
        'this template has already been placed and can no longer be drawn into; '
        + 'build a second template');
    return this.drawPage;
  }

  /** Build the form on first use, and check for a stale edit afterwards. */
  private built(): PdfRef {
    const body = this.drawPage.Contents;
    if (this.form !== undefined) {
      // The `page` getter cannot intercept a Page the caller already stashed,
      // so this catches "edited through that reference, then placed again".
      if (body.length !== this.builtLength)
        throw new TypeError(
          'this template was modified after it was placed; a template is frozen '
          + 'by its first PlaceOn');
      return this.form;
    }
    // An empty template would allocate a form that paints nothing wherever it
    // is used.
    if (body.length === 0)
      throw new TypeError('a template must draw something before it is placed');

    const resources = this.dict.get('Resources') ?? new Map<string, PdfObject>();
    // No /Matrix: identity is the PDF default, and the template page's own
    // space already IS the template's space. compose.ts writes one only
    // because it must honour a source page's /Rotate.
    const dict: PdfDict = new Map<string, PdfObject>([
      ['Type', name('XObject')],
      ['Subtype', name('Form')],
      ['FormType', 1],
      ['BBox', [0, 0, this.width, this.height]],
      ['Resources', resources],
    ]);
    this.form = this.doc.allocObject({ kind: 'stream', dict, raw: body });
    this.builtLength = body.length;
    return this.form;
  }

  /** Draw this template onto `page`, stretched to fill `rect` (`[x, y, w, h]`).
   *  Builds the form on the first call and freezes the template. */
  PlaceOn(page: Page, rect: [number, number, number, number]): void {
    checkRect(rect);
    const ref = this.built();
    // placementMatrix takes CORNERS, not width/height — it normalizes with
    // Math.min/Math.max, so a w/h pair silently places the form in the wrong
    // rect at the wrong size. Convert once, here.
    const corners = [rect[0], rect[1], rect[0] + rect[2], rect[1] + rect[3]];
    const place = placementMatrix([0, 0, this.width, this.height], IDENTITY, corners);
    if (place === undefined) return;   // unreachable: checkRect requires w,h > 0
    const key = registerXObjectRef(this.doc, page, ref);
    const body = enc(
      `q\n${place.map(num).join(' ')} cm\n/${escapeName(key)} Do\nQ`);
    appendContent(this.doc, page, body);
  }
}

/** Module-private: nothing outside template.ts validates a placement rect. */
function checkRect(rect: [number, number, number, number]): void {
  if (!Array.isArray(rect) || rect.length !== 4 || !rect.every((n) => Number.isFinite(n)))
    throw new TypeError('rect must be [x, y, w, h] of finite numbers');
  if (!(rect[2] > 0) || !(rect[3] > 0))
    throw new TypeError('rect width and height must be positive');
}
```

- [ ] **Step 5: Add `NewTemplate` to `document.ts`**

Beside `NewTilingPattern`:

```ts
  /** Create a reusable template: a Form XObject you draw once and place on any
   *  number of pages, allocated as a single object however often it is used.
   *
   *  `tpl.page` is an ordinary {@link Page} in template space
   *  (`[0, 0, width, height]`) that simply is not in this document's page tree,
   *  so `AddText`, `AddImage`, `AddTable`, `Graphics()` and `AddSVGObject` all
   *  work on it unchanged. The first `PlaceOn` builds the form and freezes the
   *  template; drawing into it afterwards throws.
   *
   *  Logical structure inside a template is not supported — tag the placement
   *  instead. */
  NewTemplate(width: number, height: number): Template {
    return new Template(this, width, height);
  }
```

with `import { Template } from './template.js';` at the top.

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx vitest run test/template-place.test.ts`

Expected: PASS.

- [ ] **Step 7: Prove the freeze and the build-once load-bearing**

1. Make `built()` allocate every call (move the `if (this.form !== undefined) return this.form;` early-return out). Run the file: `allocates ONE form for placements on two pages` must FAIL with 2. Restore.
2. Make the `page` getter return `this.drawPage` unconditionally. Run: `freezes the template` and `catches an edit made through a stashed page reference` must FAIL. Restore.

- [ ] **Step 8: Typecheck and commit**

```bash
npm run typecheck
npx vitest run test/template-place.test.ts test/nup.test.ts
git add src/template.ts src/pagecontent.ts src/document.ts test/template-place.test.ts
git commit -m "feat(lucg.3): doc.NewTemplate over an off-tree page

The template's page dict is never allocated and never linked into the page
tree, so every existing authoring API draws into it unchanged — the feature
needs no content-target refactor. The first PlaceOn converts contents plus
resources into a Form XObject and freezes the template; a stashed page
reference is caught by a content-length check at the next placement.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 4: Placement options

**Files:**
- Modify: `src/template.ts` (`PlaceOptions`, widened `PlaceOn`)
- Modify: `src/index.ts` (exports)
- Test: `test/template.test.ts` (create), `test/template-place.test.ts` (append)

**Interfaces:**
- Consumes: `containMatrix` (Task 2), `markDrawing`/`validateMarkOptions`/`MarkOptions` (`structwrite.ts`), `registerExtGState` (`pagecontent.ts`).
- Produces:
  ```ts
  export interface PlaceOptions extends MarkOptions {
    fit?: 'stretch' | 'contain';
    opacity?: number;
    rotation?: number;
  }
  export function rotateAbout(x: number, y: number, degrees: number): Matrix;
  PlaceOn(page: Page, rect: [number, number, number, number], opts?: PlaceOptions): void;
  ```

- [ ] **Step 1: Write the failing arithmetic test**

Create `test/template.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { containMatrix, placementMatrix, IDENTITY } from '../src/text.js';
import { rotateAbout } from '../src/template.js';

const BBOX = [0, 0, 200, 100];   // a 2:1 form

describe('containMatrix', () => {
  it('scales uniformly and centres vertically in a taller cell', () => {
    // 200x100 into a 150x200 cell: s = min(0.75, 2) = 0.75, fh = 75,
    // so the vertical offset is (200 - 75) / 2 = 62.5.
    const m = containMatrix(BBOX, IDENTITY, [0, 0, 150, 200])!;
    expect(m[0]).toBeCloseTo(0.75, 9);
    expect(m[3]).toBeCloseTo(0.75, 9);   // uniform, not stretched
    expect(m[4]).toBeCloseTo(0, 9);
    expect(m[5]).toBeCloseTo(62.5, 9);
  });

  it('scales uniformly and centres horizontally in a wider cell', () => {
    // The other axis, on its own: 200x100 into 400x100 gives s = 1 and a
    // horizontal offset of (400 - 200) / 2 = 100. One vector at a time —
    // a single case cannot tell a transposed fit from a correct one.
    const m = containMatrix(BBOX, IDENTITY, [0, 0, 400, 100])!;
    expect(m[0]).toBeCloseTo(1, 9);
    expect(m[3]).toBeCloseTo(1, 9);
    expect(m[4]).toBeCloseTo(100, 9);
    expect(m[5]).toBeCloseTo(0, 9);
  });

  it('agrees with placementMatrix on an exactly-matching rect', () => {
    // The degenerate case the old N-up test lived on: with the same aspect
    // ratio the two modes coincide, which is why it pinned nothing.
    const a = containMatrix(BBOX, IDENTITY, [0, 0, 400, 200])!;
    const b = placementMatrix(BBOX, IDENTITY, [0, 0, 400, 200])!;
    expect(a).toEqual(b);
  });

  it('is undefined for a degenerate box', () => {
    expect(containMatrix([0, 0, 0, 100], IDENTITY, [0, 0, 10, 10])).toBeUndefined();
  });
});

describe('rotateAbout', () => {
  it('is the identity at zero degrees', () => {
    expect(rotateAbout(50, 50, 0)).toEqual([1, 0, 0, 1, 0, 0]);
  });

  it('leaves its own centre fixed', () => {
    // The defining property: the pivot does not move. A rotation composed in
    // the wrong order still LOOKS rotated while moving the content off the
    // rect entirely, so this is the assertion that matters.
    const m = rotateAbout(50, 20, 90);
    const x = m[0] * 50 + m[2] * 20 + m[4];
    const y = m[1] * 50 + m[3] * 20 + m[5];
    expect(x).toBeCloseTo(50, 9);
    expect(y).toBeCloseTo(20, 9);
  });

  it('turns +x into +y about the origin', () => {
    const m = rotateAbout(0, 0, 90);
    expect(m[0]).toBeCloseTo(0, 9);
    expect(m[1]).toBeCloseTo(1, 9);
    expect(m[2]).toBeCloseTo(-1, 9);
    expect(m[3]).toBeCloseTo(0, 9);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run test/template.test.ts`

Expected: FAIL — `rotateAbout` is not exported by `../src/template.js`.

- [ ] **Step 3: Add the options and the rotation helper**

In `src/template.ts`, extend the imports:

```ts
import { IDENTITY, containMatrix, mul, placementMatrix, type Matrix } from './text.js';
import { appendContent, num, registerExtGState, registerXObjectRef } from './pagecontent.js';
import { markDrawing, validateMarkOptions, type MarkOptions } from './structwrite.js';
```

Add the options type and the helper:

```ts
/** Options for {@link Template.PlaceOn}. The marking fields are
 *  structwrite.ts's, so a placed template tags exactly as `AddBarcode` and
 *  `AddSVGObject` do. */
export interface PlaceOptions extends MarkOptions {
  /** `'stretch'` (default) fills `rect` exactly; `'contain'` scales uniformly
   *  and centres, preserving the template's aspect ratio. */
  fit?: 'stretch' | 'contain';
  /** Constant opacity 0..1 via an /ExtGState, as `AddImage` takes. Default 1. */
  opacity?: number;
  /** Rotation in DEGREES counter-clockwise about the rect's ORIGIN — the point
   *  `(rect[0], rect[1])` — matching what `stamp.ts` documents for `AddText`.
   *  Default 0. */
  rotation?: number;
}

/** A rotation of `degrees` counter-clockwise about the point (`x`, `y`).
 *
 *  Composed as translate(-x,-y) then rotate then translate(x,y); `mul(m, n)`
 *  applies `m` first. Getting the order wrong still produces something that
 *  looks rotated while moving the content off its rect entirely, which is why
 *  the test asserts that the pivot itself does not move. */
export function rotateAbout(x: number, y: number, degrees: number): Matrix {
  if (degrees === 0) return [...IDENTITY];
  const r = (degrees * Math.PI) / 180;
  const c = Math.cos(r), s = Math.sin(r);
  return mul(mul([1, 0, 0, 1, -x, -y], [c, s, -s, c, 0, 0]), [1, 0, 0, 1, x, y]);
}
```

Replace `PlaceOn`:

```ts
  /** Draw this template onto `page` inside `rect` (`[x, y, w, h]`). Builds the
   *  form on the first call and freezes the template.
   *
   *  The same template may be placed any number of times, on any number of
   *  pages of this document, and costs one Form XObject in total. */
  PlaceOn(
    page: Page, rect: [number, number, number, number], opts: PlaceOptions = {},
  ): void {
    checkRect(rect);
    checkPlaceOptions(opts);
    validateMarkOptions(opts);
    const ref = this.built();
    // placementMatrix and containMatrix take CORNERS, not width/height — they
    // normalize with Math.min/Math.max, so a w/h pair silently places the form
    // in the wrong rect at the wrong size. Convert once, here.
    const corners = [rect[0], rect[1], rect[0] + rect[2], rect[1] + rect[3]];
    const bbox = [0, 0, this.width, this.height];
    const base = opts.fit === 'contain'
      ? containMatrix(bbox, IDENTITY, corners)
      : placementMatrix(bbox, IDENTITY, corners);
    if (base === undefined) return;   // unreachable: checkRect requires w,h > 0
    const place = opts.rotation
      ? mul(base, rotateAbout(rect[0], rect[1], opts.rotation))
      : base;

    const key = registerXObjectRef(this.doc, page, ref);
    const parts = ['q'];
    if (opts.opacity !== undefined && opts.opacity < 1)
      parts.push(`/${escapeName(registerExtGState(this.doc, page, opts.opacity))} gs`);
    parts.push(`${place.map(num).join(' ')} cm`);
    parts.push(`/${escapeName(key)} Do`);
    parts.push('Q');
    const body = enc(parts.join('\n'));
    appendContent(this.doc, page, markDrawing(this.doc, page, body, opts));
  }
```

and the options validator beside `checkRect`:

```ts
function checkPlaceOptions(opts: PlaceOptions): void {
  if (opts.fit !== undefined && opts.fit !== 'stretch' && opts.fit !== 'contain')
    throw new TypeError("fit must be 'stretch' or 'contain'");
  if (opts.opacity !== undefined &&
      (typeof opts.opacity !== 'number' || !Number.isFinite(opts.opacity)
       || opts.opacity < 0 || opts.opacity > 1))
    throw new TypeError('opacity must be in 0..1');
  if (opts.rotation !== undefined &&
      (typeof opts.rotation !== 'number' || !Number.isFinite(opts.rotation)))
    throw new TypeError('rotation must be a finite number');
}
```

- [ ] **Step 4: Append the end-to-end option tests**

Append to `test/template-place.test.ts`:

```ts
describe('PlaceOn options', () => {
  it("contains rather than stretching with fit: 'contain'", () => {
    // A 100x50 template into a 100x100 rect: contain gives s = 1 both axes and
    // centres vertically by 25; stretch would give sy = 2.
    const doc = docWith(1);
    const t = drawn(doc);
    t.PlaceOn(doc.Pages[0], [0, 0, 100, 100], { fit: 'contain' });
    expect(dec(doc.Pages[0].Contents)).toContain('1 0 0 1 0 25 cm');
  });

  it('emits an /ExtGState for opacity below 1, and none at 1', () => {
    const doc = docWith(2);
    const t = drawn(doc);
    t.PlaceOn(doc.Pages[0], [0, 700, 100, 50], { opacity: 0.5 });
    expect(dec(doc.Pages[0].Contents)).toMatch(/\/GS\d+ gs/);

    t.PlaceOn(doc.Pages[1], [0, 700, 100, 50], { opacity: 1 });
    expect(dec(doc.Pages[1].Contents)).not.toMatch(/\/GS\d+ gs/);
  });

  it('rotates about the rect origin', () => {
    // A 100x50 template into a 100x50 rect at (40, 700) is an exact fit, so
    // the base placement is [1, 0, 0, 1, 40, 700]. Rotating 90 deg CCW about
    // (40, 700) composes to EXACTLY [0, 1, -1, 0, 40, 700] — computed, not
    // guessed: the translation is unchanged because the pivot IS the rect
    // origin, which is the whole claim being made.
    const doc = docWith(1);
    const t = drawn(doc);
    t.PlaceOn(doc.Pages[0], [40, 700, 100, 50], { rotation: 90 });
    const m = dec(doc.Pages[0].Contents).match(/([-\d. ]+) cm/)![1].trim().split(/\s+/).map(Number);
    expect(m[0]).toBeCloseTo(0, 6);
    expect(m[1]).toBeCloseTo(1, 6);
    expect(m[2]).toBeCloseTo(-1, 6);
    expect(m[3]).toBeCloseTo(0, 6);
    expect(m[4]).toBeCloseTo(40, 6);
    expect(m[5]).toBeCloseTo(700, 6);
  });

  it('wraps the placement as an /Artifact when asked', () => {
    const doc = docWith(1);
    const t = drawn(doc);
    t.PlaceOn(doc.Pages[0], [0, 700, 100, 50], { artifact: true });
    const body = dec(doc.Pages[0].Contents);
    expect(body).toContain('/Artifact BMC');
    expect(body).toContain('EMC');
  });

  it('rejects bad options before allocating', () => {
    const doc = docWith(1);
    const t = drawn(doc);
    expect(() => t.PlaceOn(doc.Pages[0], [0, 0, 10, 10], { fit: 'cover' as never }))
      .toThrow(TypeError);
    expect(() => t.PlaceOn(doc.Pages[0], [0, 0, 10, 10], { opacity: 2 })).toThrow(TypeError);
    expect(() => t.PlaceOn(doc.Pages[0], [0, 0, 10, 10], { rotation: Number.NaN }))
      .toThrow(TypeError);
  });
});

describe('template acceptance', () => {
  it('paints the template inside its rect and nowhere else', () => {
    // Asserting only that an /XObject resource exists passes with the
    // placement matrix entirely wrong. Probe pixels instead.
    const doc = Document.New();
    const { page } = doc.AddPage(PageFormat.custom(200, 200));
    const t = doc.NewTemplate(100, 50);
    t.page.Graphics().setFillColor([1, 0, 0]).drawRect(0, 0, 100, 50).fill().apply();
    t.PlaceOn(page, [50, 100, 100, 50]);

    const png = decodePng(page.ToImage({ scale: 1 }));
    // Device y runs DOWN: user (100, 125) -> device (100, 75), inside the rect.
    expect(png.at(100, 75)).toEqual([255, 0, 0, 255]);
    // Just left of the rect, same height -> unpainted.
    expect(png.at(20, 75)).toEqual([255, 255, 255, 255]);
    // Just below the rect, same column -> unpainted.
    expect(png.at(100, 140)).toEqual([255, 255, 255, 255]);
  });
});
```

Add `import { decodePng } from './helpers/decode-png.js';` to the file's imports.

- [ ] **Step 5: Add the exports**

In `src/index.ts`, beside the `PageGraphics` export:

```ts
export { Template } from './template.js';
export type { PlaceOptions } from './template.js';
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx vitest run test/template.test.ts test/template-place.test.ts`

Expected: PASS.

- [ ] **Step 7: Prove the rotation order load-bearing**

In `rotateAbout`, swap the composition to
`mul(mul([1, 0, 0, 1, x, y], [c, s, -s, c, 0, 0]), [1, 0, 0, 1, -x, -y])`. Run
`npx vitest run test/template.test.ts test/template-place.test.ts`:

- `leaves its own centre fixed` must FAIL
- `turns +x into +y about the origin` must stay GREEN — with the pivot at the
  origin both orders agree, which is why the pivot case exists

Restore.

- [ ] **Step 8: Typecheck and commit**

```bash
npm run typecheck
npx vitest run test/template.test.ts test/template-place.test.ts test/nup.test.ts
git add src/template.ts src/index.ts test/template.test.ts test/template-place.test.ts
git commit -m "feat(lucg.3): placement fit, opacity, rotation and tagging

fit: 'contain' reuses the containMatrix extracted earlier, so N-up and a
template cannot disagree about a uniform fit. Rotation is about the rect's
origin, matching stamp.ts's AddText; measured, reversing the composition order
reddens the pivot-stays-fixed case and leaves the rotate-about-origin case
green, since with the pivot at the origin both orders agree.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 5: Documentation and the full verification pass

**Files:**
- Modify: `README.md`
- Modify: `CHANGELOG.md`

**Interfaces:**
- Consumes: everything above.
- Produces: nothing consumed by code.

- [ ] **Step 1: Document it in the README**

Add a subsection after the tiling-pattern prose in the vector-graphics section (search for `A **tiling pattern** repeats a tile`), before `### Image insertion`:

````markdown
A **template** is a piece of content drawn once and placed many times, stored as
a single Form XObject however often it is used — a letterhead, a logo block, a
badge. `doc.NewTemplate(w, h)` hands back a template whose `page` is an ordinary
page in template space that simply is not in the document's page tree, so every
authoring API works on it:

```ts
const tpl = doc.NewTemplate(200, 80);
tpl.page.AddImage(logoPng, [8, 8, 48, 48]);
tpl.page.AddText('ACME Corp.', 64, 30, { fontSize: 18 });
tpl.page.Graphics().drawLine(8, 4, 192, 4).stroke().apply();

for (const p of doc.Pages) tpl.PlaceOn(p, [40, 700, 200, 80]);
```

`PlaceOn(page, [x, y, w, h], opts?)` takes `fit` (`'stretch'`, the default,
fills the rect exactly; `'contain'` scales uniformly and centres), `opacity`,
`rotation` (degrees counter-clockwise about the rect's origin, as `AddText`
takes), and the `tag`/`alt`/`artifact` marking options `AddBarcode` and
`AddSVGObject` take — so a placed template can be tagged or artifacted in a
tagged document.

The first `PlaceOn` builds the form and **freezes** the template: drawing into
`tpl.page` afterwards throws, since every placement must show the same content.
Build a second template if you need a variant. A template never drawn into is
refused rather than placed, and one never placed costs nothing in the saved
file.

Logical structure *inside* a template is not supported — `MarkContent` and a
`tag:` on the template's own page would reference a page that is never written.
Tag the placement instead.
````

- [ ] **Step 2: Update the Features bullet and the API table**

In the Features list, after the vector-drawing bullet, add:

```markdown
- **Reusable templates** — `doc.NewTemplate(w, h)` returns a Form XObject template whose `page` accepts every authoring API (`AddText`, `AddImage`, `AddTable`, `Graphics()`, `AddSVGObject`); `PlaceOn(page, rect, opts?)` draws it on any number of pages from one allocated object, with `fit`/`opacity`/`rotation` and `/Figure`/`/Artifact` marking. The first placement freezes the template.
```

In the API overview table, beside the `doc.NewTilingPattern` row:

```markdown
| `doc.NewTemplate(w, h)` | A reusable Form XObject template: draw into `tpl.page` with any authoring API, then `tpl.PlaceOn(page, [x, y, w, h], opts?)` (`fit`, `opacity`, `rotation`, `tag`/`alt`/`artifact`). One allocated object however many placements; the first placement freezes it |
```

- [ ] **Step 3: Add the CHANGELOG entry**

As the **first** bullet under `## [Unreleased]` → `### Added`:

```markdown
- **Reusable templates** — `doc.NewTemplate(w, h)` plus `PlaceOn`, so a letterhead or a logo block is drawn once and stored once however many pages carry it. This library builds Form XObjects in eight places — `compose.ts` for `StampWith`/`Overlay`/`NUp`, seven in `svgdraw.ts`, plus field appearances and soft-mask groups — and exposed no way for a caller to author one. The shape that made it cheap: a template's `page` is a real `Page` over a dict that is **never allocated and never linked into the page tree**, so `AddText`, `AddImage`, `AddTable`, `Graphics()` and `AddSVGObject` all work on it unchanged and the feature needed no content-target refactor — the counterpart of the resource-target seam tiling patterns required. An unplaced template therefore costs nothing in the saved file, not because a sweep removes it but because there was never an object to sweep. The first `PlaceOn` converts contents plus resources into the form and **freezes** the template; drawing into it afterwards throws, because silently ignoring the edit reads as the drawing call being broken. A caller who stashed the page reference before placing defeats that getter, so the build records the content length and a later placement refuses a stale one. Placement takes `fit` (`'stretch'`/`'contain'`), `opacity`, `rotation` about the rect's origin as `AddText` takes, and the usual `tag`/`alt`/`artifact` marking. Underneath, the uniform-fit arithmetic that N-up had inlined became `containMatrix` in `text.ts` with one owner — and the case that pins it was written **first**, because the existing N-up suite could not: its scale-to-fit test puts a 200x100 source into a 200x100 cell, where the scale is 1 and the centring offset is 0, so stretch, transposition and no-centring all produce identical numbers. Logical structure inside a template is not supported and is documented rather than detected. (`lucg.3`)
```

- [ ] **Step 4: Run the full suite and the typecheck**

```bash
npm run typecheck
npm test
```

Expected: both green, including `test/graphics-identity.test.ts` at
`46d1d2154c21a534` and `test/table-slice-identity.test.ts` at
`be2bd211ea459e23` — neither feature touches those paths, so a move there is a
surprise worth investigating.

- [ ] **Step 5: Re-run the new and adjacent files together**

```bash
npx vitest run test/template.test.ts test/template-place.test.ts test/nup.test.ts test/compose.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add README.md CHANGELOG.md
git commit -m "docs(lucg.3): reusable templates in the README and the changelog

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

- [ ] **Step 7: Close the issue and push**

```bash
bd close aspose-pdf-foss-for-ts-lucg.3
git pull --rebase
git push
git status   # MUST show "up to date with origin"
```

---

## Notes for the executor

**Task 1 before Task 2, without exception.** The extraction in Task 2 is a
verbatim move, which is exactly the kind of change a green suite is most likely
to be mistaken for coverage of. The measurement is recorded: the pre-existing
N-up cases stay green under a transposed fit.

**The off-tree page is the load-bearing assumption of the feature.** It holds
because `Page`'s constructor is `(doc, Dict, Number)` and every authoring entry
point reaches the page through `appendContent` / `ensureOwnResources` only.
`test/template-place.test.ts`'s `accepts the ordinary authoring APIs` is what
turns that from an assumption into a checked fact — if it ever fails, the
question is which entry point started reading `doc.Pages`, not how to patch
around it.

**Out of scope, per the spec.** `TemplateFromPage(page)` capturing an existing
in-tree page — the same conversion, cheap to add later, nobody has asked.
Structure inside a template — documented, not detected; the fix if it bites is
a guard, not a redesign. Placing a template on a page of a *different* document
— that needs `importGraphInto` and is `compose.ts`'s job.

**Recorded as deliberately unpinned.** `/Matrix` is omitted from the form dict
rather than written as the identity. Both are legal and render identically, so
no test can tell them apart; the omission is chosen for smaller output and is
asserted nowhere.

# Stamp Annotations + Appearance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `/Stamp` (rubber-stamp) annotation support: a `StampAnnotation` subclass and `Page.AddStamp(...)` for standard-name stamps, custom-text stamps, and custom-image stamps, each with a generated `/AP /N` appearance.

**Architecture:** `src/annotation.ts` gains a `StampAnnotation extends Annotation` subclass (a `StampName` accessor over `/Name`) and a free `addStamp(doc, page, opts)` builder that calls the existing `createAnnotation` helper, then installs an `/AP /N` Form XObject built with `buildAppearanceXObject`/`installAP` from `src/appearance.ts`. Label appearances (standard-name + custom-text) draw a stroked frame plus centered text measured via `src/metrics.ts`; image appearances embed an Image XObject built by a new `buildImageXObject` helper factored out of `src/imageembed.ts`, painted with `cm`/`Do` inside the appearance form. `wrapAnnotation` is extended to return `StampAnnotation` for the `/Stamp` subtype, and `Page.AddStamp` delegates to `addStamp`, mirroring `Page.AddTextNote`.

**Tech Stack:** TypeScript (strict, ESM + NodeNext), vitest. Node built-ins only.

## Global Constraints

- **Zero runtime dependencies** — only `node:` built-ins (`zlib`, `crypto`, `fs`). Do not add npm runtime deps.
- **ESM + NodeNext** — every relative import specifier carries the `.js` extension (e.g. `import { Page } from './page.js'`).
- **Strict TypeScript** — `npm run typecheck` must stay green.
- **Public error types only** — `TypeError` for bad inputs; reuse `PdfParseError`/`UnsupportedFeatureError` (these are what `buildImageXObject` already throws for bad image data).
- **Live-mutation model** — edits act directly on the live dict; never copy-and-replace the page dict.
- **Colors are DeviceRGB `0..1`** — three finite numbers in `[0,1]`; `TypeError` otherwise (enforced by the shared `createAnnotation` for `/C`).
- **Default annotation flag** — created annotations get `/F = 4` (Print), `/M` = now, `/P` → the page, and are appended to the page's **own** `/Annots` (never the inherited array). All handled by `createAnnotation`.
- **Validate before mutating the page** — parse/validate inputs (image bytes, the exactly-one-mode constraint) *before* `createAnnotation` allocates and attaches anything, so a bad call leaves the page untouched.
- **TDD** — failing test first, watch it fail, implement minimally, watch it pass, commit. Run `npm run typecheck` before any commit that changes types.
- Target a single test file with `npx vitest run test/<name>.test.ts`; full suite with `npm test`.

## Foundation already shipped (consume, do not rebuild)

From `src/annotation.ts` (on `main`):
- `class Annotation { constructor(doc, dict); readonly Dict; get Subtype; get/set Rect, Color, Contents, Name, ModDate, Flags, Print, Hidden, Opacity }`. `doc` is `protected` (subclasses may use `this.doc`).
- `class TextAnnotation extends Annotation` — the established subclass pattern to mirror.
- `function wrapAnnotation(doc, dict): Annotation` — dispatches on `/Subtype`; currently `case 'Text'` only. This plan adds `case 'Stamp'`.
- `function createAnnotation(doc, page, init: BaseAnnotInit): PdfDict` where `interface BaseAnnotInit { subtype: string; rect: [number,number,number,number]; color?: [number,number,number]; contents?: string }` — sets `/Type`, `/Subtype`, `/Rect`, `/F`=4, `/M`=now, `/P`, optional `/C`/`/Contents`, validates `rect`/`color` before allocating, and appends to the page's own `/Annots`.
- Module-private helpers available to same-module code: `pdfText(s): PdfObject`, `checkNums(key, v, n)`, `FLAG_PRINT`, `numArray`.

From `src/appearance.ts`:
- `interface WidgetGeom { w: number; h: number; rotate: 0|90|180|270 }`.
- `function widgetGeom(doc, dict): WidgetGeom | undefined` — reads `/Rect` (normalized abs w/h) and `/MK /R`; `undefined` for missing/zero-area rect. A `/Stamp` dict has no `/MK`, so this yields `{ w, h, rotate: 0 }`.
- `function buildAppearanceXObject(doc, g: WidgetGeom, std: StdFont, fontKey: string, body: string): PdfStream` — wraps `body` in `q … Q`, sets `/BBox [0 0 w h]`, `/Matrix`, and `/Resources` = a Font subdict mapping `fontKey` → a Type1 font whose `/BaseFont` is `std` (`WinAnsiEncoding`).
- `function installAP(doc, dict, stream): void` — allocates `stream` and sets `dict`'s `/AP` to `<< /N <ref> >>`. Works for any annotation dict.

From `src/metrics.ts`: `type StdFont` (includes `'Helvetica'`, `'Helvetica-Bold'`); `function measure(font: StdFont, bytes: Uint8Array, fontSize: number): number`.

From `src/pagecontent.ts`: `function num(n: number): string` (compact content-stream number).

From `src/encoding.ts`: `function encodeWinAnsi(s: string): Uint8Array`. From `src/serialize.ts`: `function serializeString(bytes: Uint8Array): string` (PDF literal string).

From `src/imageembed.ts`: `interface BuiltImage { stream: PdfStream; smask?: PdfStream }`; `function buildJpegXObject(data): BuiltImage`; module-private `sniff(data)` and `buildPngXObject(data)`; `function addImage(doc, page, data, rect, opts)`.

From `src/image.ts`: `function collectImages(doc, resources: PdfDict | undefined): ImageInfo[]`; `class ImageInfo { get Width; get Height; … }`.

From `src/content.ts`: `function parseContentStream(buf: Uint8Array): ContentOp[]` where `interface ContentOp { readonly operator: string; readonly operands: PdfObject[] }`.

From `src/page.ts`: `Page` delegates feature methods to free functions (`AddTextNote` → `addTextNote`); `this.doc` and `this` (the `Page`) are available inside methods.

From `test/helpers/build-annot-target.ts`: `buildAnnotTarget()` (Text+Link, length 2 — do not modify), `buildBlankPage()` (one page, no `/Annots`). The file's private `assemble(objects, maxObj, rootNum)` builds a classic-xref PDF from 1-based object bodies.

From `test/helpers/build-embed-images.ts`: `buildJpeg(width, height, components)`, `buildPngRgba()`.

---

### Task 1: `StampAnnotation` subclass + `wrapAnnotation` dispatch

Introduces the subclass and makes the read model return it for `/Stamp` annotations. Pure read-model; no creation or appearance yet.

**Files:**
- Modify: `test/helpers/build-annot-target.ts` (add a `buildStampReadTarget` fixture)
- Modify: `src/annotation.ts` (add `StampAnnotation`, extend `wrapAnnotation`)
- Modify: `test/annotation.test.ts` (add a `StampAnnotation` describe block + imports)

**Interfaces:**
- Consumes: `Annotation` (base), `isName`/`name` from `./types.js` (already imported in `annotation.ts`).
- Produces:
  - `export function buildStampReadTarget(): Uint8Array` — one page with a single `/Stamp` annotation (`/Name /Approved`).
  - `class StampAnnotation extends Annotation { get StampName(): string | undefined; set StampName(v: string | undefined) }` — reads/writes `/Name` as a PDF name.
  - `wrapAnnotation` now returns `StampAnnotation` when `/Subtype` is `Stamp`.

- [ ] **Step 1: Add the read fixture**

In `test/helpers/build-annot-target.ts`, append:

```ts
/** One page carrying a single existing /Stamp annotation (standard name). */
export function buildStampReadTarget(): Uint8Array {
  const objects: string[] = [];
  objects[1] = `<< /Type /Catalog /Pages 2 0 R >>`;
  objects[2] = `<< /Type /Pages /Count 1 /Kids [3 0 R] /MediaBox [0 0 300 200] >>`;
  objects[3] = `<< /Type /Page /Parent 2 0 R /Annots [4 0 R] >>`;
  objects[4] = `<< /Type /Annot /Subtype /Stamp /Rect [10 20 110 60] /Name /Approved /F 4 >>`;
  return assemble(objects, 4, 1);
}
```

- [ ] **Step 2: Write the failing test**

In `test/annotation.test.ts`, extend the import from `../src/annotation.js` to add `StampAnnotation`, and the import from `./helpers/build-annot-target.js` to add `buildStampReadTarget`:

```ts
import { Annotation, createAnnotation, TextAnnotation, StampAnnotation } from '../src/annotation.js';
import { buildAnnotTarget, buildBlankPage, buildStampReadTarget } from './helpers/build-annot-target.js';
```

Append a new describe block:

```ts
describe('StampAnnotation', () => {
  it('wraps /Stamp annotations and exposes StampName', () => {
    const doc = Document.Open(buildStampReadTarget());
    const a = doc.Pages[0].Annotations[0];
    expect(a).toBeInstanceOf(StampAnnotation);

    const stamp = a as StampAnnotation;
    expect(stamp.Subtype).toBe('Stamp');
    expect(stamp.StampName).toBe('Approved');

    stamp.StampName = 'Confidential';
    expect(stamp.StampName).toBe('Confidential');
    stamp.StampName = undefined;
    expect(stamp.StampName).toBeUndefined();
  });

  it('rejects an invalid StampName type', () => {
    const doc = Document.Open(buildStampReadTarget());
    const stamp = doc.Pages[0].Annotations[0] as StampAnnotation;
    expect(() => { (stamp as any).StampName = 5; }).toThrow(TypeError);
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx vitest run test/annotation.test.ts`
Expected: FAIL — `StampAnnotation` is not exported / `instanceof StampAnnotation` is false.

- [ ] **Step 4: Add the `StampAnnotation` subclass**

In `src/annotation.ts`, insert this class immediately after the `TextAnnotation` class definition (and before `wrapAnnotation`):

```ts
/** A /Stamp (rubber-stamp) annotation. /Name holds the stamp name for standard
 *  stamps (Approved, Confidential, Draft, …); custom text/image stamps leave it
 *  unset and carry their content in the /AP appearance. */
export class StampAnnotation extends Annotation {
  /** /Name stamp name; undefined when absent (custom text/image stamps). */
  get StampName(): string | undefined {
    const n = this.Dict.get('Name');
    return isName(n) ? n.name : undefined;
  }

  set StampName(v: string | undefined) {
    if (v === undefined) { this.Dict.delete('Name'); return; }
    if (typeof v !== 'string') throw new TypeError('StampName must be a string');
    this.Dict.set('Name', name(v));
  }
}
```

- [ ] **Step 5: Extend `wrapAnnotation` to dispatch on `/Stamp`**

In `src/annotation.ts`, add a case to the `wrapAnnotation` switch (alongside the existing `case 'Text'`):

```ts
    case 'Text': return new TextAnnotation(doc, dict);
    case 'Stamp': return new StampAnnotation(doc, dict);
    default: return new Annotation(doc, dict);
```

- [ ] **Step 6: Run typecheck and tests**

Run: `npm run typecheck` — Expected: no errors.
Run: `npx vitest run test/annotation.test.ts` — Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/annotation.ts test/annotation.test.ts test/helpers/build-annot-target.ts
git commit -m "feat: StampAnnotation subtype with StampName accessor

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: Factor `buildImageXObject` out of `imageembed.ts`

Extracts the format-sniff + dispatch from `addImage` into a reusable helper that returns a `BuiltImage` without touching any page, so the stamp appearance (Task 4) can embed an image. DRY refactor: `addImage` keeps working unchanged.

**Files:**
- Modify: `src/imageembed.ts` (add `buildImageXObject`, call it from `addImage`)
- Modify: `test/image-embed.test.ts` (direct test of `buildImageXObject`)

**Interfaces:**
- Consumes: module-private `sniff`, `buildJpegXObject`, `buildPngXObject`; `interface BuiltImage`.
- Produces: `export function buildImageXObject(data: Uint8Array, format?: 'jpeg' | 'png'): BuiltImage`.

- [ ] **Step 1: Write the failing test**

In `test/image-embed.test.ts`, extend the imports to pull in `buildImageXObject` and `isName`:

```ts
import { buildImageXObject } from '../src/imageembed.js';
import { isName } from '../src/types.js';
```

Append a describe block:

```ts
describe('buildImageXObject', () => {
  it('builds a DeviceRGB Image XObject from a JPEG without attaching it to a page', () => {
    const built = buildImageXObject(buildJpeg(4, 3, 3));
    const st = built.stream.dict.get('Subtype');
    expect(isName(st) && st.name).toBe('Image');
    expect(built.stream.dict.get('Width')).toBe(4);
    expect(built.stream.dict.get('Height')).toBe(3);
    expect(built.smask).toBeUndefined();
  });

  it('returns a soft mask for an RGBA PNG', () => {
    const built = buildImageXObject(buildPngRgba());
    expect(built.smask).toBeDefined();
  });

  it('throws on unrecognized image bytes', () => {
    expect(() => buildImageXObject(new Uint8Array([1, 2, 3]))).toThrow(UnsupportedFeatureError);
  });
});
```

(`buildJpeg`, `buildPngRgba`, and `UnsupportedFeatureError` are already imported at the top of this file.)

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/image-embed.test.ts`
Expected: FAIL — `buildImageXObject` is not exported.

- [ ] **Step 3: Add `buildImageXObject` and call it from `addImage`**

In `src/imageembed.ts`, add the helper immediately before `addImage`:

```ts
/** Build an Image XObject (+ optional soft mask) from encoded image bytes,
 *  auto-detecting JPEG/PNG. Does not attach it to any page. */
export function buildImageXObject(data: Uint8Array, format?: 'jpeg' | 'png'): BuiltImage {
  const fmt = format ?? sniff(data);
  return fmt === 'jpeg' ? buildJpegXObject(data) : buildPngXObject(data);
}
```

Then in `addImage`, replace these two lines:

```ts
  const fmt = opts.format ?? sniff(data);
  const built = fmt === 'jpeg' ? buildJpegXObject(data) : buildPngXObject(data);
```

with:

```ts
  const built = buildImageXObject(data, opts.format);
```

- [ ] **Step 4: Run typecheck and tests**

Run: `npm run typecheck` — Expected: no errors.
Run: `npx vitest run test/image-embed.test.ts` — Expected: PASS (new `buildImageXObject` tests plus all existing `addImage` tests still green).

- [ ] **Step 5: Commit**

```bash
git add src/imageembed.ts test/image-embed.test.ts
git commit -m "refactor: extract buildImageXObject from addImage

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: `Page.AddStamp` for standard-name and custom-text stamps (framed-label appearance)

Adds the public creation method, its options type, the framed-label appearance for standard-name and custom-text stamps, validation, exports, and docs. Image stamps are added in Task 4.

**Files:**
- Modify: `src/annotation.ts` (add `StampOptions`, label-appearance helpers, `addStamp`)
- Modify: `src/page.ts` (add `AddStamp` method + imports)
- Modify: `src/index.ts` (export `StampAnnotation` + `StampOptions`)
- Modify: `README.md` (API row)
- Modify: `test/annotation.test.ts` (create + appearance + round-trip tests)

**Interfaces:**
- Consumes: `createAnnotation`, `StampAnnotation` (Task 1), `widgetGeom`/`buildAppearanceXObject`/`installAP` (appearance.ts), `measure`/`StdFont` (metrics.ts), `encodeWinAnsi` (encoding.ts), `serializeString` (serialize.ts), `num` (pagecontent.ts).
- Produces:
  - `interface StampOptions { rect: [number,number,number,number]; name?: string; text?: string; image?: Uint8Array; color?: [number,number,number] }`
  - `function addStamp(doc: Document, page: Page, opts: StampOptions): StampAnnotation`
  - `Page.AddStamp(opts: StampOptions): StampAnnotation`
  - The `image` branch throws `TypeError('AddStamp: image stamps are added in a later step')` for now (replaced in Task 4). The validation that exactly one of `name`/`text`/`image` is set is in place from this task.

- [ ] **Step 1: Write the failing test**

In `test/annotation.test.ts`, add these imports (top of file):

```ts
import { isStream } from '../src/types.js';
import { parseContentStream } from '../src/content.js';
```

Append a describe block:

```ts
describe('Page.AddStamp (label)', () => {
  /** The /AP /N stream of an annotation, asserted to exist. */
  function apN(doc: Document, stamp: StampAnnotation) {
    const ap = doc.resolve(stamp.Dict.get('AP')) as Map<string, any>;
    const n = doc.resolve(ap.get('N'));
    expect(isStream(n)).toBe(true);
    return n as any;
  }

  it('creates a standard-name stamp with a framed-label appearance', () => {
    const doc = Document.Open(buildBlankPage());
    const page = doc.Pages[0];

    const stamp = page.AddStamp({ rect: [10, 20, 110, 60], name: 'Approved' });

    expect(stamp).toBeInstanceOf(StampAnnotation);
    expect(stamp.Subtype).toBe('Stamp');
    expect(stamp.StampName).toBe('Approved');
    expect(stamp.Print).toBe(true);              // default /F = 4
    expect(page.Annotations).toHaveLength(1);

    const ops = parseContentStream(apN(doc, stamp).raw).map((o) => o.operator);
    expect(ops).toContain('S');                  // stroked border
    expect(ops).toContain('Tj');                 // label text
  });

  it('creates a custom-text stamp (no /Name) with an appearance', () => {
    const doc = Document.Open(buildBlankPage());
    const stamp = doc.Pages[0].AddStamp({ rect: [0, 0, 100, 40], text: 'DRAFT', color: [0, 0, 1] });
    expect(stamp.StampName).toBeUndefined();
    expect(stamp.Color).toEqual([0, 0, 1]);      // /C set from color
    const ops = parseContentStream(apN(doc, stamp).raw).map((o) => o.operator);
    expect(ops).toContain('Tj');
  });

  it('rejects ambiguous or empty stamp specs without mutating the page', () => {
    const doc = Document.Open(buildBlankPage());
    const page = doc.Pages[0];
    expect(() => page.AddStamp({ rect: [0, 0, 10, 10] })).toThrow(TypeError);
    expect(() => page.AddStamp({ rect: [0, 0, 10, 10], name: 'A', text: 'B' })).toThrow(TypeError);
    expect(page.Annotations).toHaveLength(0);
  });

  it('round-trips a standard-name stamp through Save/Open', () => {
    const doc = Document.Open(buildBlankPage());
    doc.Pages[0].AddStamp({ rect: [5, 5, 105, 45], name: 'Confidential' });

    const reopened = Document.Open(doc.Save());
    const annots = reopened.Pages[0].Annotations;
    expect(annots).toHaveLength(1);
    expect(annots[0]).toBeInstanceOf(StampAnnotation);
    expect((annots[0] as StampAnnotation).StampName).toBe('Confidential');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/annotation.test.ts`
Expected: FAIL — `page.AddStamp is not a function`.

- [ ] **Step 3: Add imports to `src/annotation.ts`**

At the top of `src/annotation.ts`, add `PdfStream` to the existing `./types.js` import:

```ts
import { PdfDict, PdfObject, PdfStream, isArray, isName, isString, name } from './types.js';
```

and add these new imports:

```ts
import { widgetGeom, buildAppearanceXObject, installAP, type WidgetGeom } from './appearance.js';
import { measure } from './metrics.js';
import { encodeWinAnsi } from './encoding.js';
import { serializeString } from './serialize.js';
import { num } from './pagecontent.js';
```

- [ ] **Step 4: Add the label-appearance helpers + `StampOptions` + `addStamp`**

Append at the end of `src/annotation.ts`:

```ts
/** Options for Page.AddStamp. Exactly one of `name`, `text`, or `image`. */
export interface StampOptions {
  rect: [number, number, number, number];
  /** Standard stamp name (Approved, Confidential, Draft, …); sets /Name. */
  name?: string;
  /** Custom text stamp label. */
  text?: string;
  /** Custom image stamp (JPEG/PNG bytes). */
  image?: Uint8Array;
  /** Frame/text color for name/text stamps, RGB 0..1. Default red [1,0,0]. */
  color?: [number, number, number];
}

const STAMP_FONT = 'Helvetica-Bold';

/** Largest font size for `bytes` fitting ~60% of box height and 85% of width. */
function labelSize(bytes: Uint8Array, g: WidgetGeom): number {
  let size = Math.min(g.h * 0.6, 24);
  const avail = g.w * 0.85;
  const w = measure(STAMP_FONT, bytes, size);
  if (w > avail && w > 0) size = Math.max(4, (size * avail) / w);
  return size;
}

/** Build a framed-label /AP form: a stroked border plus centered bold text. */
function buildLabelAppearance(
  doc: Document, g: WidgetGeom, label: string, color: [number, number, number],
): PdfStream {
  const [r, gg, b] = color;
  const bw = Math.max(1, Math.min(g.w, g.h) * 0.04);
  const half = bw / 2;
  const bytes = encodeWinAnsi(label);
  const size = labelSize(bytes, g);
  const tw = measure(STAMP_FONT, bytes, size);
  const x = (g.w - tw) / 2;
  const y = (g.h - size) / 2 + size * 0.2;
  const body =
    `${num(r)} ${num(gg)} ${num(b)} RG ${num(bw)} w ` +
    `${num(half)} ${num(half)} ${num(g.w - bw)} ${num(g.h - bw)} re S\n` +
    `BT /F0 ${num(size)} Tf ${num(r)} ${num(gg)} ${num(b)} rg ` +
    `${num(x)} ${num(y)} Td ${serializeString(bytes)} Tj ET`;
  return buildAppearanceXObject(doc, g, STAMP_FONT, 'F0', body);
}

/** Build and attach a /Stamp annotation to `page`; returns its StampAnnotation
 *  handle. Exactly one of opts.name / opts.text / opts.image must be set. */
export function addStamp(doc: Document, page: Page, opts: StampOptions): StampAnnotation {
  const modes = [opts.name, opts.text, opts.image].filter((v) => v !== undefined);
  if (modes.length !== 1)
    throw new TypeError('AddStamp requires exactly one of name, text, or image');

  const dict = createAnnotation(doc, page, {
    subtype: 'Stamp',
    rect: opts.rect,
    color: opts.color,
  });
  const stamp = new StampAnnotation(doc, dict);
  const g = widgetGeom(doc, dict);
  const color = opts.color ?? [1, 0, 0];

  if (opts.name !== undefined) {
    stamp.StampName = opts.name;
    if (g) installAP(doc, dict, buildLabelAppearance(doc, g, opts.name, color));
  } else if (opts.text !== undefined) {
    if (typeof opts.text !== 'string') throw new TypeError('text must be a string');
    if (g) installAP(doc, dict, buildLabelAppearance(doc, g, opts.text, color));
  } else {
    throw new TypeError('AddStamp: image stamps are added in a later step');
  }
  return stamp;
}
```

- [ ] **Step 5: Add `Page.AddStamp`**

In `src/page.ts`, extend the existing import from `./annotation.js`:

```ts
import {
  Annotation, wrapAnnotation, addTextNote, TextAnnotation, TextNoteOptions,
  addStamp, StampAnnotation, StampOptions,
} from './annotation.js';
```

Add the method immediately after `AddTextNote`:

```ts
  /** Add a /Stamp (rubber-stamp) annotation to this page. Provide exactly one of
   *  `name` (standard stamp), `text` (custom text), or `image` (JPEG/PNG bytes). */
  AddStamp(opts: StampOptions): StampAnnotation {
    return addStamp(this.doc, this, opts);
  }
```

- [ ] **Step 6: Run typecheck and tests**

Run: `npm run typecheck` — Expected: no errors.
Run: `npx vitest run test/annotation.test.ts` — Expected: PASS.

- [ ] **Step 7: Export from `index.ts`**

In `src/index.ts`, replace:

```ts
export { Annotation, TextAnnotation } from './annotation.js';
export type { TextNoteOptions } from './annotation.js';
```

with:

```ts
export { Annotation, TextAnnotation, StampAnnotation } from './annotation.js';
export type { TextNoteOptions, StampOptions } from './annotation.js';
```

- [ ] **Step 8: Update the README**

In `README.md`, after the `page.AddTextNote(opts)` row, add:

```
| `page.AddStamp(opts)` | Add a `/Stamp` annotation (standard name, custom text, or image) with a generated appearance |
```

- [ ] **Step 9: Run typecheck, full suite, and build**

Run: `npm run typecheck` — Expected: no errors.
Run: `npm test` — Expected: full suite green.
Run: `npm run build` — Expected: clean build (emits `StampAnnotation`/`StampOptions` to `.d.ts`).

- [ ] **Step 10: Commit**

```bash
git add src/annotation.ts src/page.ts src/index.ts README.md test/annotation.test.ts
git commit -m "feat: Page.AddStamp for standard-name and custom-text stamps

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 4: Custom-image stamps

Replaces the image-branch placeholder in `addStamp` with a real image appearance: embed the Image XObject (Task 2's `buildImageXObject`), register it in the appearance form's `/Resources /XObject`, and paint it with `cm`/`Do`. Validation (image parsed before the annotation is attached) preserves the validate-before-mutate rule.

**Files:**
- Modify: `src/annotation.ts` (image-appearance helper + image branch in `addStamp`)
- Modify: `README.md` (note image stamps in the row, if not already covered)
- Modify: `test/annotation.test.ts` (image-stamp create + extractor + round-trip tests)

**Interfaces:**
- Consumes: `buildImageXObject` + `BuiltImage` (Task 2), `buildAppearanceXObject`/`installAP`/`widgetGeom`, `num`.
- Produces: an updated `addStamp` whose `image` branch installs an image appearance; no new public symbols (the `image` field on `StampOptions` already exists from Task 3).

- [ ] **Step 1: Write the failing test**

In `test/annotation.test.ts`, add imports:

```ts
import { collectImages } from '../src/image.js';
import { buildJpeg, buildPngRgba } from './helpers/build-embed-images.js';
```

Append a describe block:

```ts
describe('Page.AddStamp (image)', () => {
  it('embeds an image XObject in the stamp appearance, reachable by the extractor', () => {
    const doc = Document.Open(buildBlankPage());
    const stamp = doc.Pages[0].AddStamp({ rect: [0, 0, 64, 48], image: buildJpeg(8, 6, 3) });

    expect(stamp).toBeInstanceOf(StampAnnotation);
    expect(stamp.StampName).toBeUndefined();

    const ap = doc.resolve(stamp.Dict.get('AP')) as Map<string, any>;
    const n = doc.resolve(ap.get('N')) as any;
    expect(isStream(n)).toBe(true);

    const ops = parseContentStream(n.raw).map((o) => o.operator);
    expect(ops).toContain('Do');

    // The image XObject lives in the appearance form's own /Resources.
    const res = doc.resolve(n.dict.get('Resources')) as Map<string, any>;
    const imgs = collectImages(doc, res);
    expect(imgs).toHaveLength(1);
    expect(imgs[0].Width).toBe(8);
    expect(imgs[0].Height).toBe(6);
  });

  it('does not attach an annotation when the image bytes are unrecognized', () => {
    const doc = Document.Open(buildBlankPage());
    const page = doc.Pages[0];
    expect(() => page.AddStamp({ rect: [0, 0, 64, 48], image: new Uint8Array([1, 2, 3]) }))
      .toThrow();                         // UnsupportedFeatureError from buildImageXObject
    expect(page.Annotations).toHaveLength(0);
  });

  it('round-trips an image stamp through Save/Open', () => {
    const doc = Document.Open(buildBlankPage());
    doc.Pages[0].AddStamp({ rect: [0, 0, 64, 48], image: buildPngRgba() });

    const reopened = Document.Open(doc.Save());
    const annots = reopened.Pages[0].Annotations;
    expect(annots).toHaveLength(1);
    expect(annots[0]).toBeInstanceOf(StampAnnotation);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/annotation.test.ts`
Expected: FAIL — the image branch throws `TypeError('AddStamp: image stamps are added in a later step')`, and the unrecognized-bytes test attaches an annotation (length 1, not 0) because validation happens after `createAnnotation`.

- [ ] **Step 3: Add the image-appearance helper and import**

In `src/annotation.ts`, extend the imageembed import (add it near the other appearance imports):

```ts
import { buildImageXObject, type BuiltImage } from './imageembed.js';
```

Add this helper next to `buildLabelAppearance`:

```ts
/** Build an /AP form that paints `built` (an Image XObject) to fill the box,
 *  registering it under /Im0 in the form's own /Resources. */
function buildImageAppearance(doc: Document, g: WidgetGeom, built: BuiltImage): PdfStream {
  if (built.smask) built.stream.dict.set('SMask', doc.allocObject(built.smask));
  const imgRef = doc.allocObject(built.stream);
  const body = `${num(g.w)} 0 0 ${num(g.h)} 0 0 cm\n/Im0 Do`;
  const stream = buildAppearanceXObject(doc, g, 'Helvetica', 'F0', body);
  (stream.dict.get('Resources') as PdfDict).set(
    'XObject', new Map<string, PdfObject>([['Im0', imgRef]]),
  );
  return stream;
}
```

- [ ] **Step 4: Replace the image branch in `addStamp`**

The current `addStamp` parses nothing for images and throws in the `else`. Update it so the image is parsed **before** `createAnnotation`, and the `else` branch installs the image appearance.

Replace the start of `addStamp` (the validation block) with:

```ts
export function addStamp(doc: Document, page: Page, opts: StampOptions): StampAnnotation {
  const modes = [opts.name, opts.text, opts.image].filter((v) => v !== undefined);
  if (modes.length !== 1)
    throw new TypeError('AddStamp requires exactly one of name, text, or image');

  // Parse/validate the image before mutating the page (validate-before-attach).
  const built: BuiltImage | undefined =
    opts.image !== undefined ? buildImageXObject(opts.image) : undefined;

  const dict = createAnnotation(doc, page, {
    subtype: 'Stamp',
    rect: opts.rect,
    color: opts.color,
  });
```

And replace the trailing `else { throw … }` branch with:

```ts
  } else {
    if (g) installAP(doc, dict, buildImageAppearance(doc, g, built!));
  }
  return stamp;
}
```

(The rest of `addStamp` — the `name`/`text` branches and `return stamp` — is unchanged; `built!` is non-null in the `else` branch since exactly one mode is set and it is `image`.)

- [ ] **Step 5: Run typecheck and tests**

Run: `npm run typecheck` — Expected: no errors.
Run: `npx vitest run test/annotation.test.ts` — Expected: PASS.

- [ ] **Step 6: Run the full suite and build**

Run: `npm test` — Expected: full suite green.
Run: `npm run build` — Expected: clean build.

- [ ] **Step 7: Commit**

```bash
git add src/annotation.ts test/annotation.test.ts README.md
git commit -m "feat: image stamps via AddStamp image appearance

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Notes for the next plans / follow-ups

- Stamp label appearances honor `/C` only as the frame/text color; `/CA` opacity is not set by `AddStamp` (no `opacity` option in `StampOptions`, per spec). If a later plan adds it, route through `registerExtGState` like `stamp.ts`/`imageembed.ts`.
- Rotation: stamps are created with `rotate: 0` (no `/MK /R`); `widgetGeom` already supports quarter-turns if a future option needs it.
- Standard-name stamps render a text label (the name) rather than Acrobat's proprietary stamp artwork — a documented limitation already noted in the design spec's Module C.
- Remaining Phase 3 leaves: `c9p` (links), `vpm` (markup), `rwn`/`82q` (XMP). Markup reuses the same appearance machinery (`buildAppearanceXObject`/`installAP`).

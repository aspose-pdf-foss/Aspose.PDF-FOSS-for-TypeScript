# OCG Authoring (hz2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add creation of new optional-content groups and tagging of authored content (vector graphics, images, annotations) into a layer — the authoring counterpart to the ac0 read/edit/delete OCG API.

**Architecture:** Extend `OptionalContent` (src/ocg.ts) with `AddLayer` that allocates an OCG dict and wires `/OCGs` + `/D /Order`. Add `PageGraphics.BeginLayer/EndLayer` (src/graphics.ts) that emit `/OC /OCn BDC … EMC`, backed by a new `registerOcProperty` helper in src/pagecontent.ts. Add whole-object `/OC` membership via an image option (src/imageembed.ts) and an `Annotation.Layer` accessor (src/annotation.ts).

**Tech Stack:** TypeScript (strict, ESM/NodeNext, `.js` import specifiers), vitest, zero runtime deps (`node:` built-ins only).

## Global Constraints

- Zero runtime dependencies — `node:` built-ins only; do not add npm runtime deps.
- ESM + NodeNext: all relative imports carry the `.js` extension.
- TDD: write the failing test first; every task ends green on `npm run typecheck` and `npm test`.
- `PdfDict` is a `Map<string, PdfObject>` keyed by name without a leading `/`.
- Names/strings/refs are tagged objects: build names with `name('X')`, strings with `pdfText('X')` (local to ocg.ts), test ref equality with `sameRef` (exported from ocg.ts).
- `doc.allocObject(obj): PdfRef` allocates an object and returns its ref.
- Do not mutate parsed inputs destructively where a copy is expected: edit `/Order` on a deep copy, then `set` it back (mirrors `removeRefDeep` usage in `RemoveLayer`).
- The imported `name` function from `./types.js` is in scope in ocg.ts — do NOT shadow it; name the `AddLayer` string parameter `layerName`.

---

### Task 1: `OptionalContent.AddLayer` — create OCGs and wire `/Order`

**Files:**
- Modify: `src/ocg.ts` (add `AddLayerOptions`, two private helpers, `AddLayer` method on `OptionalContent`)
- Modify: `src/index.ts:11` area (export `AddLayerOptions` type)
- Test: `test/ocg.test.ts` (new `describe('OCG authoring — AddLayer')`)

**Interfaces:**
- Consumes (already present in src/ocg.ts): `sameRef(a, b): boolean`, `arrayOf(doc, o): PdfObject[]`, `pdfText(v): PdfObject` (local), the `Layer` class, `OptionalContent.ensureOcProps(): PdfDict` (private), `OptionalContent.Default: LayerConfig` (creates `/D`), `LayerConfig.Dict: PdfDict`, `LayerConfig.SetVisible(layer, v)`, `name` from `./types.js`, `isArray` from `./types.js`.
- Produces:
  - `interface AddLayerOptions { parent?: Layer; visible?: boolean; intent?: string | string[]; }`
  - `OptionalContent.AddLayer(layerName: string, opts?: AddLayerOptions): Layer`

- [ ] **Step 1: Write the failing test**

Add to `test/ocg.test.ts` (imports already include `Document`; add whatever the assertions need from `../src/types.js`):

```ts
import { isArray, isName, isString } from '../src/types.js';
import { decodePdfText } from '../src/metadata.js';

describe('OCG authoring — AddLayer', () => {
  it('creates a top-level layer in /OCGs and /D /Order, visible by default', () => {
    const doc = Document.Open(buildOcgPdf());
    const oc = doc.OptionalContent;
    const before = oc.Layers.length;
    const l = oc.AddLayer('New Layer');
    expect(l.Name).toBe('New Layer');
    expect(l.Visible).toBe(true);
    expect(l.Intent).toEqual(['View']); // default when /Intent absent
    expect(oc.Layers.length).toBe(before + 1);
    expect(oc.GetLayer('New Layer')).toBeTruthy();

    const props = doc.resolve(doc.catalog().get('OCProperties')) as Map<string, any>;
    const order = doc.resolve(props.get('D')) instanceof Map
      ? (doc.resolve((doc.resolve(props.get('D')) as Map<string, any>).get('Order')))
      : undefined;
    expect(isArray(order)).toBe(true);
    // the new ref is present at the top level of /Order
    expect((order as any[]).some((e) => e && e.kind === 'ref' && e.num === l.Ref.num)).toBe(true);
  });

  it('nests a layer under a parent as a group heading in /Order', () => {
    const doc = Document.Open(buildOcgPdf());
    const oc = doc.OptionalContent;
    const parent = oc.AddLayer('Group');
    const child = oc.AddLayer('Child', { parent });

    const props = doc.resolve(doc.catalog().get('OCProperties')) as Map<string, any>;
    const d = doc.resolve(props.get('D')) as Map<string, any>;
    const order = doc.resolve(d.get('Order')) as any[];
    // find parent ref, expect the element right after it to be an array containing child
    const i = order.findIndex((e) => e && e.kind === 'ref' && e.num === parent.Ref.num);
    expect(i).toBeGreaterThanOrEqual(0);
    const kids = order[i + 1];
    expect(isArray(kids)).toBe(true);
    expect((kids as any[]).some((e) => e && e.kind === 'ref' && e.num === child.Ref.num)).toBe(true);
  });

  it('honors visible:false (adds to /D /OFF) and intent', () => {
    const doc = Document.Open(buildOcgPdf());
    const oc = doc.OptionalContent;
    const l = oc.AddLayer('Hidden', { visible: false, intent: 'Design' });
    expect(l.Visible).toBe(false);
    expect(l.Intent).toEqual(['Design']);
    expect(oc.Default.IsVisible(l)).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/ocg.test.ts -t "AddLayer"`
Expected: FAIL — `oc.AddLayer is not a function`.

- [ ] **Step 3: Implement `AddLayer` and helpers in `src/ocg.ts`**

Add the interface just above the `OptionalContent` class (after the `LayerConfig` class), plus two module-level helpers near the top-level helpers (e.g. after `removeRefDeep`):

```ts
/** Deep-copy an /Order array (entries are refs, strings, or nested arrays). */
function deepCopyOrder(a: PdfObject[]): PdfObject[] {
  return a.map((e) => (isArray(e) ? deepCopyOrder(e) : e));
}

/** Place `ref` under `parent` in an /Order tree (mutates `order`): if the entry
 *  right after `parent` is an array, push into it; else insert a fresh `[ref]`
 *  array right after `parent`. Recurses into nested arrays. Returns whether it
 *  found `parent`. */
function placeUnder(order: PdfObject[], parent: PdfRef, ref: PdfRef): boolean {
  for (let i = 0; i < order.length; i++) {
    const e = order[i];
    if (sameRef(e, parent)) {
      const next = order[i + 1];
      if (isArray(next)) next.push(ref);
      else order.splice(i + 1, 0, [ref]);
      return true;
    }
    if (isArray(e) && placeUnder(e, parent, ref)) return true;
  }
  return false;
}
```

Add the interface (exported) above `OptionalContent`:

```ts
export interface AddLayerOptions {
  /** Nest the new layer under this one in /D /Order. Default: top level. */
  parent?: Layer;
  /** Default-config visibility. Default: true. */
  visible?: boolean;
  /** /Intent name(s). Default: 'View' (implicit when /Intent absent). */
  intent?: string | string[];
}
```

Add the method inside `OptionalContent` (e.g. after `RemoveConfig`):

```ts
AddLayer(layerName: string, opts: AddLayerOptions = {}): Layer {
  const p = this.ensureOcProps();
  const dict: PdfDict = new Map<string, PdfObject>([
    ['Type', name('OCG')],
    ['Name', pdfText(layerName)],
  ]);
  if (opts.intent !== undefined) {
    dict.set('Intent', Array.isArray(opts.intent)
      ? opts.intent.map((i) => name(i))
      : name(opts.intent));
  }
  const ref = this.doc.allocObject(dict);

  // /OCGs — authoritative list
  p.set('OCGs', [...arrayOf(this.doc, p.get('OCGs')), ref]);

  // /D /Order — panel tree
  const d = this.Default.Dict; // creates /D if absent
  const order = deepCopyOrder(arrayOf(this.doc, d.get('Order')));
  if (!(opts.parent && placeUnder(order, opts.parent.Ref, ref))) order.push(ref);
  d.set('Order', order);

  const layer = new Layer(this.doc, ref, dict, this);
  if (opts.visible === false) this.Default.SetVisible(layer, false);
  this.doc.markModified();
  return layer;
}
```

- [ ] **Step 4: Export the type in `src/index.ts`**

Change the ocg export line (currently `export { OptionalContent, Layer, LayerConfig } from './ocg.js';`) to also export the type:

```ts
export { OptionalContent, Layer, LayerConfig } from './ocg.js';
export type { AddLayerOptions } from './ocg.js';
```

- [ ] **Step 5: Run tests + typecheck**

Run: `npx vitest run test/ocg.test.ts -t "AddLayer"` → Expected: PASS (all 3).
Run: `npm run typecheck` → Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/ocg.ts src/index.ts test/ocg.test.ts
git commit -m "feat(ocg): AddLayer creates OCGs and wires /OCGs + /D /Order

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: `PageGraphics.BeginLayer` / `EndLayer` + `registerOcProperty`

**Files:**
- Modify: `src/pagecontent.ts` (add `registerOcProperty`)
- Modify: `src/graphics.ts` (import helper + `Layer` type; add `BeginLayer`/`EndLayer`)
- Test: `test/graphics.test.ts` (new `it` in the existing `describe('PageGraphics')`)

**Interfaces:**
- Consumes: `OptionalContent.AddLayer` (Task 1); `ensureOwnResources`, `ensureOwnSubdict`, `freshKey`, `isRef` (already in pagecontent.ts); `PageGraphics.op` (private), `escapeName` (already imported in graphics.ts); `Layer.Ref: PdfRef`.
- Produces:
  - `registerOcProperty(doc: Document, page: Page, ocg: PdfRef): string` (exported from pagecontent.ts)
  - `PageGraphics.BeginLayer(layer: Layer): this`
  - `PageGraphics.EndLayer(): this`

- [ ] **Step 1: Write the failing test**

Add to `test/graphics.test.ts` inside `describe('PageGraphics', ...)` (the file already imports `Document`, `parseContentStream`, `buildStampTarget`, and has the `pageContentText` helper):

```ts
it('BeginLayer/EndLayer tag content into an optional-content group', () => {
  const doc = Document.Open(buildStampTarget());
  const layer = doc.OptionalContent.AddLayer('Watermark');
  const g = doc.Pages[0].Graphics();
  g.BeginLayer(layer).rect(10, 10, 20, 20).fill().EndLayer();
  g.apply();

  const text = pageContentText(doc);
  // /OC /OCn BDC ... EMC around the drawing
  expect(text).toMatch(/\/OC\s+\/OC\d+\s+BDC/);
  expect(text).toContain('EMC');

  // the resource name in the BDC resolves to the OCG in /Resources /Properties
  const m = text.match(/\/OC\s+\/(OC\d+)\s+BDC/)!;
  const key = m[1];
  const res = doc.Pages[0].Resources!;
  const props = doc.resolve(res.get('Properties')) as Map<string, any>;
  const ref = props.get(key);
  expect(ref.kind).toBe('ref');
  expect(ref.num).toBe(layer.Ref.num);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/graphics.test.ts -t "BeginLayer"`
Expected: FAIL — `g.BeginLayer is not a function`.

- [ ] **Step 3: Add `registerOcProperty` to `src/pagecontent.ts`**

Add after `registerExtGState` (the imports already include `isRef`, `PdfRef`, `Page`, `Document`):

```ts
/** Register (or reuse) `ocg` under the page's /Resources /Properties and return
 *  its resource key (for `/OC /<key> BDC`). Reuses an existing key that already
 *  maps to the same ref. */
export function registerOcProperty(doc: Document, page: Page, ocg: PdfRef): string {
  const res = ensureOwnResources(doc, page);
  const props = ensureOwnSubdict(doc, res, 'Properties');
  for (const [k, v] of props) {
    if (isRef(v) && v.num === ocg.num && v.gen === ocg.gen) return k;
  }
  const key = freshKey(props, 'OC');
  props.set(key, ocg);
  return key;
}
```

- [ ] **Step 4: Add `BeginLayer`/`EndLayer` to `src/graphics.ts`**

Update the import from `./pagecontent.js` and add a type import for `Layer`:

```ts
import { num, appendContent, registerExtGState, registerOcProperty } from './pagecontent.js';
import type { Layer } from './ocg.js';
```

Add these methods next to `BeginMarkedContent`/`EndMarkedContent` (in the "marked content" section):

```ts
/** Begin an optional-content sequence: `/OC /<key> BDC`, tagging following ops
 *  into `layer`. Registers the OCG in the page's /Resources /Properties. Pair
 *  with {@link EndLayer}. */
BeginLayer(layer: Layer): this {
  const key = registerOcProperty(this.doc, this.page, layer.Ref);
  return this.op(`/OC /${escapeName(key)} BDC`);
}

/** End the most recent {@link BeginLayer} sequence. */
EndLayer(): this {
  return this.op('EMC');
}
```

- [ ] **Step 5: Run tests + typecheck**

Run: `npx vitest run test/graphics.test.ts -t "BeginLayer"` → Expected: PASS.
Run: `npm run typecheck` → Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/pagecontent.ts src/graphics.ts test/graphics.test.ts
git commit -m "feat(ocg): PageGraphics BeginLayer/EndLayer tag content into a layer

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: Image `/OC` membership — `AddImageOptions.layer`

**Files:**
- Modify: `src/imageembed.ts` (add `layer?` to `AddImageOptions`; set `/OC` in `addImage`)
- Test: `test/image-embed.test.ts` (new `it`)

**Interfaces:**
- Consumes: `OptionalContent.AddLayer` (Task 1); `Layer.Ref: PdfRef`; `built.stream.dict: PdfDict` in `addImage`.
- Produces: `AddImageOptions.layer?: Layer` — when set, `addImage` sets `/OC = layer.Ref` on the image XObject dict.

- [ ] **Step 1: Write the failing test**

Add to `test/image-embed.test.ts` (check the file's existing imports; it already opens documents and reads image XObjects — reuse its blank-doc/PNG helpers. If it does not already import a PNG builder, add `import { buildPngRgb } from './helpers/build-embed-images.js';` and `import { buildStampTarget } from './helpers/build-stamp-target.js';`):

```ts
it('tags an embedded image into an optional-content layer via opts.layer', () => {
  const doc = Document.Open(buildStampTarget());
  const layer = doc.OptionalContent.AddLayer('Photos');
  doc.Pages[0].AddImage(buildPngRgb(), [0, 0, 100, 100], { layer });

  const res = doc.Pages[0].Resources!;
  const xobjs = doc.resolve(res.get('XObject')) as Map<string, any>;
  // the single Im* entry is the image we just added
  const imRef = [...xobjs.values()].find((v) => v && v.kind === 'ref');
  const xo = doc.resolve(imRef);
  const oc = xo.dict.get('OC');
  expect(oc.kind).toBe('ref');
  expect(oc.num).toBe(layer.Ref.num);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/image-embed.test.ts -t "optional-content layer"`
Expected: FAIL — `opts.layer` unknown / `oc` is undefined.

- [ ] **Step 3: Implement in `src/imageembed.ts`**

Add a type-only import at the top: `import type { Layer } from './ocg.js';`

Add to `AddImageOptions`:

```ts
  /** Attach the whole image XObject to an optional-content layer (sets /OC). */
  layer?: Layer;
```

In `addImage`, after `const built = buildImageXObject(data, opts.format);` and the `SMask` block, before `const res = ensureOwnResources(...)`, add:

```ts
  if (opts.layer) built.stream.dict.set('OC', opts.layer.Ref);
```

- [ ] **Step 4: Run tests + typecheck**

Run: `npx vitest run test/image-embed.test.ts -t "optional-content layer"` → Expected: PASS.
Run: `npm run typecheck` → Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add src/imageembed.ts test/image-embed.test.ts
git commit -m "feat(ocg): AddImage layer option sets /OC on the image XObject

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 4: `Annotation.Layer` accessor

**Files:**
- Modify: `src/annotation.ts` (add `Layer` get/set on base `Annotation`)
- Test: `test/annotation.test.ts` (new `it`)

**Interfaces:**
- Consumes: `Annotation.Dict: PdfDict`, `Annotation.doc: Document` (protected), `Annotation.touch()`; `Document.OptionalContent: OptionalContent`; `OptionalContent.layerForRef(r): Layer | undefined`; `Layer.Ref: PdfRef`.
- Produces:
  - `Annotation.Layer` getter: `Layer | undefined` (resolves `/OC`)
  - `Annotation.Layer` setter: `Layer | undefined` (sets `/OC = v.Ref`, or deletes `/OC`)

- [ ] **Step 1: Write the failing test**

Add to `test/annotation.test.ts` (it already imports `buildBlankPage` from `./helpers/build-annot-target.js`; `StampAnnotationOptions` is `{ rect, name?, text?, image?, color? }` per `src/annotation.ts:420`):

```ts
it('gets and sets an annotation layer via /OC', () => {
  const doc = Document.Open(buildBlankPage());
  const layer = doc.OptionalContent.AddLayer('Review');
  const page = doc.Pages[0];
  const annot = page.AddStamp({ rect: [10, 10, 60, 40], name: 'Approved' });

  expect(annot.Layer).toBeUndefined();
  annot.Layer = layer;
  expect(annot.Dict.get('OC')).toBeTruthy();
  expect(annot.Layer?.Ref.num).toBe(layer.Ref.num);

  annot.Layer = undefined;
  expect(annot.Dict.get('OC')).toBeUndefined();
  expect(annot.Layer).toBeUndefined();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/annotation.test.ts -t "annotation layer"`
Expected: FAIL — `annot.Layer` unknown.

- [ ] **Step 3: Implement in `src/annotation.ts`**

Add a type-only import at the top: `import type { Layer } from './ocg.js';`

Add to the base `Annotation` class (e.g. after the `Name` accessor):

```ts
/** Optional-content layer this annotation belongs to (via /OC); undefined when
 *  absent. Setting to undefined removes /OC. */
get Layer(): Layer | undefined {
  return this.doc.OptionalContent.layerForRef(this.Dict.get('OC'));
}

set Layer(v: Layer | undefined) {
  this.touch();
  if (v === undefined) { this.Dict.delete('OC'); return; }
  this.Dict.set('OC', v.Ref);
}
```

Note: `layerForRef` calls `doc.resolve` and matches by ref, so passing the raw `/OC` value (a ref) works.

- [ ] **Step 4: Run tests + typecheck**

Run: `npx vitest run test/annotation.test.ts -t "annotation layer"` → Expected: PASS.
Run: `npm run typecheck` → Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add src/annotation.ts test/annotation.test.ts
git commit -m "feat(ocg): Annotation.Layer accessor for /OC membership

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 5: Save→Open round-trip + README authoring section

**Files:**
- Test: `test/ocg.test.ts` (new `describe('OCG authoring — round-trip')`)
- Modify: `README.md` (Layers section — add authoring example)

**Interfaces:**
- Consumes: all of Tasks 1–4; `Document.Save(): Uint8Array`; `Document.Open(bytes)`; `OptionalContent.Layers`.

- [ ] **Step 1: Write the failing round-trip test**

Add to `test/ocg.test.ts`:

```ts
describe('OCG authoring — round-trip', () => {
  it('re-enumerates authored layers after Save/Open', () => {
    const doc = Document.Open(buildStampTarget());
    const oc = doc.OptionalContent;
    const group = oc.AddLayer('Group');
    const child = oc.AddLayer('Child', { parent: group });
    const hidden = oc.AddLayer('Hidden', { visible: false });

    const g = doc.Pages[0].Graphics();
    g.BeginLayer(child).rect(10, 10, 20, 20).fill().EndLayer();
    g.apply();

    const round = Document.Open(doc.Save());
    const names = round.OptionalContent.Layers.map((l) => l.Name);
    expect(names).toEqual(expect.arrayContaining(['Group', 'Child', 'Hidden']));
    expect(round.OptionalContent.GetLayer('Hidden')!.Visible).toBe(false);
    expect(round.OptionalContent.GetLayer('Child')!.Visible).toBe(true);

    // content still carries the /OC BDC after a serialize round-trip
    const text = new TextDecoder().decode(round.Pages[0].Contents);
    expect(text).toMatch(/\/OC\s+\/OC\d+\s+BDC/);
  });
});
```

Add `import { buildStampTarget } from './helpers/build-stamp-target.js';` to `test/ocg.test.ts` if not already present.

- [ ] **Step 2: Run test to verify it fails, then passes**

Run: `npx vitest run test/ocg.test.ts -t "round-trip"`
Expected: PASS (all implementation already exists from Tasks 1–2). If it FAILS, treat the failure as a real defect in Tasks 1–2 and fix there — do not weaken the test.

- [ ] **Step 3: Update `README.md` Layers section**

Locate the "Layers" (Optional Content) section (search for `OptionalContent` or `Layers`). Under the existing read/edit/delete examples, add an authoring subsection:

````markdown
Create layers and tag authored content into them:

```ts
const oc = doc.OptionalContent;
const group = oc.AddLayer('Annotations');            // group heading
const notes = oc.AddLayer('Notes', { parent: group }); // nested, shows in panel tree
const draft = oc.AddLayer('Draft', { visible: false }); // hidden by default

// Tag vector content
const g = doc.Pages[0].Graphics();
g.BeginLayer(notes).setFillColor([1, 0, 0]).rect(72, 72, 100, 40).fill().EndLayer();
g.apply();

// Tag a whole image or annotation
doc.Pages[0].AddImage(pngBytes, [0, 0, 200, 120], { layer: draft });
const stamp = doc.Pages[0].AddStamp({ rect: [10, 10, 60, 40], name: 'Approved' });
stamp.Layer = notes;
```
````

- [ ] **Step 4: Run the full suite + typecheck**

Run: `npm test` → Expected: all green.
Run: `npm run typecheck` → Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add test/ocg.test.ts README.md
git commit -m "test(ocg): authoring round-trip; docs: layer authoring in README

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Post-implementation

- Close the issue: `bd close aspose-pdf-foss-for-ts-hz2`
- Session-close protocol (CLAUDE.md): `git pull --rebase && git push && git status` must show up to date.

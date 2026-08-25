# Optional Content Groups (Layers / OCG) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Read, enumerate, toggle visibility of, edit configs for, and delete optional-content layers (`/OCProperties`) through a live object-model API that round-trips through `Save()`.

**Architecture:** A new `src/ocg.ts` module exposes three live-handle classes — `Layer` (one `/OCG` dict), `LayerConfig` (a `/D` or `/Configs` viewing configuration), and `OptionalContent` (the `/OCProperties` entry point) — reached via a new `doc.OptionalContent` getter. Edits act directly on the resolved dicts/arrays in the objects map (mirroring `Field` in `form.ts`); `Save()` renumbers the reachable graph, so `/OCProperties` (hanging off the Catalog) is preserved and any deleted OCG becomes unreachable and is dropped. Content excision reuses the `content.ts` op tokenizer.

**Tech Stack:** TypeScript (strict, ESM/NodeNext, `.js` import specifiers), vitest, zero runtime deps (`node:` built-ins only).

## Global Constraints

- Zero runtime dependencies — only `node:` built-ins. Do not add npm runtime deps.
- ESM + NodeNext — all relative imports carry the `.js` extension.
- `strict` TypeScript. Run `npm run typecheck` and `npm test` before closing.
- Live-mutation model — edit the resolved dicts in place; never mutate inputs during `Save` (Save copies). After any in-place dict/array edit, call `this.doc.markModified()`.
- Errors — throw the public error types from `errors.ts` (`UnsupportedFeatureError` etc.) where applicable. (None expected in this feature.)
- Keep `README.md` (Features / Limitations) in sync with the new public API.
- PDF text strings: read with `decodePdfText(bytes)`, write as `{ kind: 'string', bytes: encodePdfText(v) }` (both from `metadata.ts`).

---

### Task 1: Fixture builder + module skeleton + layer enumeration

Builds the test fixture, the `src/ocg.ts` module with shared helpers and the `Layer`/`OptionalContent` read surface (`Layers`, `GetLayer`, `Layer.Name`/`Intent`/`Ref`), wires `doc.OptionalContent`, and exports the new public types.

**Files:**
- Create: `test/helpers/build-ocg-pdf.ts`
- Create: `src/ocg.ts`
- Modify: `src/document.ts` (add `get OptionalContent()` and its import)
- Modify: `src/index.ts` (export `Layer`, `LayerConfig`, `OptionalContent`)
- Test: `test/ocg.test.ts`

**Interfaces:**
- Consumes: `Document.resolve`, `Document.catalog()`, `Document.allocObject`, `Document.deleteObject`, `Document.markModified`, `Document.Pages` (array of `Page`); `Page.Dict`, `Page.Resources`; `types.ts` (`isDict`/`isArray`/`isRef`/`isName`/`isString`/`name`/`ref`, types `PdfObject`/`PdfDict`/`PdfRef`); `metadata.ts` `decodePdfText`/`encodePdfText`.
- Produces:
  - `class Layer { readonly Ref: PdfRef; readonly Dict: PdfDict; get Name(): string; set Name(v: string); get Intent(): string[]; get Visible(): boolean; set Visible(v: boolean) }`
  - `class LayerConfig` (filled in Tasks 2–3) `{ readonly Dict: PdfDict }`
  - `class OptionalContent { get Layers(): Layer[]; GetLayer(name: string): Layer | undefined; get Default(): LayerConfig; get Configs(): LayerConfig[]; GetConfig(name: string): LayerConfig | undefined; AddConfig(name: string): LayerConfig; RemoveConfig(cfg: LayerConfig): void; RemoveLayer(layer: Layer): void }`
  - module helpers `sameRef`, `arrayOf`, `resolveDict` (used by later tasks).
  - `Document` getter `get OptionalContent(): OptionalContent`.

- [ ] **Step 1: Write the fixture builder**

Create `test/helpers/build-ocg-pdf.ts`:

```ts
const enc = (s: string) => new TextEncoder().encode(s);
const byteLen = (s: string) => enc(s).length;

/** One-page classic-xref PDF exercising the OCG API.
 *  Objects: 1 Catalog, 2 Pages, 3 Page, 4 Contents (marked content),
 *  5 OCProperties, 6 OCG "Layer A", 7 OCG "Layer B", 8 OCG "Layer C",
 *  9 /D config, 10 Form XObject (/OC -> C), 11 Square annot (/OC -> B),
 *  12 named /Configs entry "Print".
 *  Content has an MC0 (Layer A) block enclosing a nested MC1 (Layer B) block.
 *  /D: BaseState ON, OFF=[B], Locked=[C], Order=[A B C]
 *      => A visible, B hidden, C visible & locked.
 *  Configs[0] "Print": BaseState OFF, ON=[A] => only A visible. */
export function buildOcgPdf(): Uint8Array {
  const content =
`/OC /MC0 BDC
1 0 0 RG
10 10 100 100 re
S
/OC /MC1 BDC
0 0 1 rg
20 20 50 50 re
f
EMC
EMC
0 0 0 rg
`;
  const form = `0 0 50 50 re f\n`;

  const objects: string[] = [];
  objects[1] = `<< /Type /Catalog /Pages 2 0 R /OCProperties 5 0 R >>`;
  objects[2] = `<< /Type /Pages /Count 1 /Kids [3 0 R] /MediaBox [0 0 400 400] >>`;
  objects[3] = `<< /Type /Page /Parent 2 0 R /Resources << /Properties << /MC0 6 0 R /MC1 7 0 R >> /XObject << /Fm0 10 0 R >> >> /Contents 4 0 R /Annots [11 0 R] >>`;
  objects[4] = `<< /Length ${byteLen(content)} >>\nstream\n${content}endstream`;
  objects[5] = `<< /OCGs [6 0 R 7 0 R 8 0 R] /D 9 0 R /Configs [12 0 R] >>`;
  objects[6] = `<< /Type /OCG /Name (Layer A) /Intent /View >>`;
  objects[7] = `<< /Type /OCG /Name (Layer B) >>`;
  objects[8] = `<< /Type /OCG /Name (Layer C) >>`;
  objects[9] = `<< /Name (Default) /BaseState /ON /OFF [7 0 R] /Locked [8 0 R] /Order [6 0 R 7 0 R 8 0 R] >>`;
  objects[10] = `<< /Type /XObject /Subtype /Form /BBox [0 0 50 50] /OC 8 0 R /Length ${byteLen(form)} >>\nstream\n${form}endstream`;
  objects[11] = `<< /Type /Annot /Subtype /Square /Rect [0 0 20 20] /OC 7 0 R >>`;
  objects[12] = `<< /Name (Print) /BaseState /OFF /ON [6 0 R] >>`;
  const maxObj = 12;

  let body = '%PDF-1.7\n%\xE2\xE3\xCF\xD3\n';
  const offsets: number[] = new Array(maxObj + 1).fill(0);
  for (let n = 1; n <= maxObj; n++) {
    offsets[n] = byteLen(body);
    body += `${n} 0 obj\n${objects[n]}\nendobj\n`;
  }
  const xrefOffset = byteLen(body);
  let xref = `xref\n0 ${maxObj + 1}\n0000000000 65535 f \n`;
  for (let n = 1; n <= maxObj; n++) xref += `${String(offsets[n]).padStart(10, '0')} 00000 n \n`;
  const trailer = `trailer\n<< /Size ${maxObj + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return enc(body + xref + trailer);
}
```

- [ ] **Step 2: Write the failing enumeration test**

Create `test/ocg.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { buildOcgPdf } from './helpers/build-ocg-pdf.js';

describe('OCG enumeration', () => {
  it('lists layers with names and intent', () => {
    const doc = Document.Open(buildOcgPdf());
    const oc = doc.OptionalContent;
    expect(oc.Layers.map((l) => l.Name)).toEqual(['Layer A', 'Layer B', 'Layer C']);
    expect(oc.GetLayer('Layer B')?.Name).toBe('Layer B');
    expect(oc.GetLayer('nope')).toBeUndefined();
    expect(oc.Layers[0].Intent).toEqual(['View']); // explicit /View
    expect(oc.Layers[1].Intent).toEqual(['View']); // default when absent
  });

  it('returns an empty layer list when /OCProperties is absent', () => {
    const empty = Document.Open(buildOcgPdf());
    empty.catalog().delete('OCProperties');
    expect(empty.OptionalContent.Layers).toEqual([]);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run test/ocg.test.ts`
Expected: FAIL — `doc.OptionalContent` is not a function / `Document` has no `OptionalContent`.

- [ ] **Step 4: Write the module skeleton**

Create `src/ocg.ts`:

```ts
import type { Document } from './document.js';
import {
  PdfObject, PdfDict, PdfRef,
  isDict, isArray, isRef, isName, isString, name, ref,
} from './types.js';
import { decodePdfText, encodePdfText } from './metadata.js';

/** Reference equality by object/generation number. */
export function sameRef(a: PdfObject | undefined, b: PdfRef): boolean {
  return isRef(a) && a.num === b.num && a.gen === b.gen;
}

/** Resolve `o` to its array of entries (empty when not an array). */
export function arrayOf(doc: Document, o: PdfObject | undefined): PdfObject[] {
  const a = doc.resolve(o);
  return isArray(a) ? a : [];
}

/** Resolve `o` to a dict, or undefined. */
export function resolveDict(doc: Document, o: PdfObject | undefined): PdfDict | undefined {
  const d = doc.resolve(o);
  return isDict(d) ? d : undefined;
}

function textOf(doc: Document, o: PdfObject | undefined): string | undefined {
  const s = doc.resolve(o);
  return isString(s) ? decodePdfText(s.bytes) : undefined;
}

function pdfText(v: string): PdfObject {
  return { kind: 'string', bytes: encodePdfText(v) };
}

/** A single optional-content group (layer): a live handle over its /OCG dict. */
export class Layer {
  constructor(
    private readonly doc: Document,
    readonly Ref: PdfRef,
    readonly Dict: PdfDict,
    private readonly oc: OptionalContent,
  ) {}

  get Name(): string { return textOf(this.doc, this.Dict.get('Name')) ?? ''; }
  set Name(v: string) { this.Dict.set('Name', pdfText(v)); this.doc.markModified(); }

  get Intent(): string[] {
    const i = this.doc.resolve(this.Dict.get('Intent'));
    if (isName(i)) return [i.name];
    if (isArray(i)) return i.filter(isName).map((n) => (n as { name: string }).name);
    return ['View'];
  }

  get Visible(): boolean { return this.oc.Default.IsVisible(this); }
  set Visible(v: boolean) { this.oc.Default.SetVisible(this, v); }
}

/** A viewing configuration (/D or a /Configs entry). Filled out in later tasks. */
export class LayerConfig {
  constructor(
    protected readonly doc: Document,
    readonly Dict: PdfDict,
    protected readonly oc: OptionalContent,
  ) {}
}

/** The document's optional-content properties (/OCProperties). */
export class OptionalContent {
  constructor(private readonly doc: Document) {}

  private ocProps(): PdfDict | undefined {
    return resolveDict(this.doc, this.doc.catalog().get('OCProperties'));
  }

  /** Create /OCProperties (with an empty /OCGs and /D) when absent. */
  private ensureOcProps(): PdfDict {
    let p = this.ocProps();
    if (!p) {
      p = new Map<string, PdfObject>([
        ['OCGs', []],
        ['D', new Map<string, PdfObject>([['Order', []]])],
      ]);
      this.doc.catalog().set('OCProperties', p);
      this.doc.markModified();
    }
    return p;
  }

  get Layers(): Layer[] {
    const p = this.ocProps();
    if (!p) return [];
    const out: Layer[] = [];
    for (const r of arrayOf(this.doc, p.get('OCGs'))) {
      if (!isRef(r)) continue;
      const d = this.doc.resolve(r);
      if (isDict(d)) out.push(new Layer(this.doc, r, d, this));
    }
    return out;
  }

  GetLayer(name: string): Layer | undefined {
    return this.Layers.find((l) => l.Name === name);
  }

  /** @internal Map an OCG ref back to a Layer handle. */
  layerForRef(r: PdfObject | undefined): Layer | undefined {
    if (!isRef(r)) return undefined;
    return this.Layers.find((l) => sameRef(r, l.Ref));
  }

  get Default(): LayerConfig {
    const p = this.ensureOcProps();
    let d = resolveDict(this.doc, p.get('D'));
    if (!d) { d = new Map(); p.set('D', d); this.doc.markModified(); }
    return new LayerConfig(this.doc, d, this);
  }

  // Configs / AddConfig / RemoveConfig — Task 3.
  get Configs(): LayerConfig[] { return []; }
  GetConfig(_name: string): LayerConfig | undefined { return undefined; }
  AddConfig(_name: string): LayerConfig { throw new Error('not implemented'); }
  RemoveConfig(_cfg: LayerConfig): void { /* Task 3 */ }

  // RemoveLayer — Tasks 4–5.
  RemoveLayer(_layer: Layer): void { /* Tasks 4–5 */ }
}

// silence unused-import warnings until later tasks use them
void ref; void name;
```

- [ ] **Step 5: Wire `doc.OptionalContent` and exports**

In `src/document.ts`, add the import near the other feature imports (e.g. next to the `struct.js` import around line 8):

```ts
import { OptionalContent } from './ocg.js';
```

Add the accessor inside the `Document` class, next to `get Form()` (around line 436):

```ts
  /** The document's optional-content (layers) model, rebuilt from the live
   *  catalog on each access. */
  get OptionalContent(): OptionalContent {
    return new OptionalContent(this);
  }
```

In `src/index.ts`, add to the public exports:

```ts
export { OptionalContent, Layer, LayerConfig } from './ocg.js';
```

- [ ] **Step 6: Run test to verify it passes**

Run: `npx vitest run test/ocg.test.ts`
Expected: PASS (both enumeration tests).

- [ ] **Step 7: Typecheck**

Run: `npm run typecheck`
Expected: no errors. (Remove the `void ref; void name;` line once Tasks 3–4 use them.)

- [ ] **Step 8: Commit**

```bash
git add src/ocg.ts src/document.ts src/index.ts test/helpers/build-ocg-pdf.ts test/ocg.test.ts
git commit -m "feat(ocg): enumerate optional-content layers via /OCProperties"
```

---

### Task 2: Layer visibility (default config)

Implements visibility resolution and editing on `LayerConfig` and the `Layer.Visible` sugar over `OptionalContent.Default`.

**Files:**
- Modify: `src/ocg.ts` (flesh out `LayerConfig`)
- Test: `test/ocg.test.ts`

**Interfaces:**
- Consumes: `sameRef`, `arrayOf` (Task 1); `Layer.Ref`.
- Produces (on `LayerConfig`):
  - `get BaseState(): 'ON' | 'OFF'` / `set BaseState(v: 'ON' | 'OFF')`
  - `IsVisible(layer: Layer): boolean`
  - `SetVisible(layer: Layer, v: boolean): void`

- [ ] **Step 1: Write the failing test**

Append to `test/ocg.test.ts`:

```ts
describe('OCG visibility (default config)', () => {
  it('resolves default visibility from /ON, /OFF and BaseState', () => {
    const doc = Document.Open(buildOcgPdf());
    const oc = doc.OptionalContent;
    const [a, b, c] = oc.Layers;
    expect(a.Visible).toBe(true);  // BaseState ON, not in OFF
    expect(b.Visible).toBe(false); // in /OFF
    expect(c.Visible).toBe(true);  // BaseState ON
    expect(oc.Default.BaseState).toBe('ON');
  });

  it('toggles visibility by editing /ON and /OFF', () => {
    const doc = Document.Open(buildOcgPdf());
    const oc = doc.OptionalContent;
    const [a, b] = oc.Layers;
    b.Visible = true;
    expect(b.Visible).toBe(true);
    a.Visible = false;
    expect(a.Visible).toBe(false);
    // setting visible removes it from /OFF; setting hidden removes it from /ON
    expect(oc.Default.IsVisible(b)).toBe(true);
    expect(oc.Default.IsVisible(a)).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/ocg.test.ts`
Expected: FAIL — `oc.Default.IsVisible is not a function` / `BaseState` undefined.

- [ ] **Step 3: Implement `LayerConfig` visibility**

Replace the `LayerConfig` class body in `src/ocg.ts` with:

```ts
export class LayerConfig {
  constructor(
    protected readonly doc: Document,
    readonly Dict: PdfDict,
    protected readonly oc: OptionalContent,
  ) {}

  get BaseState(): 'ON' | 'OFF' {
    const b = this.doc.resolve(this.Dict.get('BaseState'));
    return isName(b) && b.name === 'OFF' ? 'OFF' : 'ON';
  }
  set BaseState(v: 'ON' | 'OFF') { this.Dict.set('BaseState', name(v)); this.doc.markModified(); }

  IsVisible(layer: Layer): boolean {
    if (arrayOf(this.doc, this.Dict.get('ON')).some((r) => sameRef(r, layer.Ref))) return true;
    if (arrayOf(this.doc, this.Dict.get('OFF')).some((r) => sameRef(r, layer.Ref))) return false;
    return this.BaseState === 'ON';
  }

  SetVisible(layer: Layer, v: boolean): void {
    this.removeFrom('ON', layer.Ref);
    this.removeFrom('OFF', layer.Ref);
    this.addTo(v ? 'ON' : 'OFF', layer.Ref);
    this.doc.markModified();
  }

  /** @internal Drop a ref from a config array (leaving the array present). */
  protected removeFrom(key: string, r: PdfRef): void {
    const existing = this.doc.resolve(this.Dict.get(key));
    if (!isArray(existing)) return;
    this.Dict.set(key, existing.filter((e) => !sameRef(e, r)));
  }

  /** @internal Append a ref to a config array, creating it when absent. */
  protected addTo(key: string, r: PdfRef): void {
    const existing = this.doc.resolve(this.Dict.get(key));
    const arr = isArray(existing) ? [...existing] : [];
    if (!arr.some((e) => sameRef(e, r))) arr.push(r);
    this.Dict.set(key, arr);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/ocg.test.ts`
Expected: PASS (all describe blocks).

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/ocg.ts test/ocg.test.ts
git commit -m "feat(ocg): read and toggle layer visibility in the default config"
```

---

### Task 3: Named configurations (read/write)

Implements the full config model: enumerate named `/Configs`, add/remove/rename them, plus `LayerConfig.Name`/`Creator`/`Locked`/`SetLocked`.

**Files:**
- Modify: `src/ocg.ts` (`OptionalContent.Configs`/`GetConfig`/`AddConfig`/`RemoveConfig`; add `Name`/`Creator`/`Locked`/`SetLocked` to `LayerConfig`)
- Test: `test/ocg.test.ts`

**Interfaces:**
- Consumes: `sameRef`, `arrayOf`, `resolveDict`, `pdfText` (Task 1); `LayerConfig.removeFrom`/`addTo` (Task 2); `OptionalContent.layerForRef` (Task 1).
- Produces:
  - `LayerConfig`: `get Name(): string | undefined` / `set Name(v: string)`, `get Creator(): string | undefined`, `get Locked(): Layer[]`, `SetLocked(layer: Layer, v: boolean): void`
  - `OptionalContent`: `get Configs(): LayerConfig[]`, `GetConfig(name)`, `AddConfig(name)`, `RemoveConfig(cfg)`

- [ ] **Step 1: Write the failing test**

Append to `test/ocg.test.ts`:

```ts
describe('OCG named configurations', () => {
  it('enumerates named configs and their per-layer state', () => {
    const doc = Document.Open(buildOcgPdf());
    const oc = doc.OptionalContent;
    expect(oc.Configs.map((c) => c.Name)).toEqual(['Print']);
    const print = oc.GetConfig('Print')!;
    const [a, b] = oc.Layers;
    expect(print.IsVisible(a)).toBe(true);  // in /ON
    expect(print.IsVisible(b)).toBe(false); // BaseState OFF, not in /ON
  });

  it('adds, renames and removes configs', () => {
    const doc = Document.Open(buildOcgPdf());
    const oc = doc.OptionalContent;
    const cfg = oc.AddConfig('Screen');
    expect(oc.Configs.map((c) => c.Name)).toEqual(['Print', 'Screen']);
    cfg.Name = 'Web';
    expect(oc.GetConfig('Web')).toBeDefined();
    oc.RemoveConfig(cfg);
    expect(oc.Configs.map((c) => c.Name)).toEqual(['Print']);
  });

  it('reads and edits the Locked list of the default config', () => {
    const doc = Document.Open(buildOcgPdf());
    const oc = doc.OptionalContent;
    const [a, , c] = oc.Layers;
    expect(oc.Default.Locked.map((l) => l.Name)).toEqual(['Layer C']);
    oc.Default.SetLocked(a, true);
    expect(oc.Default.Locked.map((l) => l.Name).sort()).toEqual(['Layer A', 'Layer C']);
    oc.Default.SetLocked(c, false);
    expect(oc.Default.Locked.map((l) => l.Name)).toEqual(['Layer A']);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/ocg.test.ts`
Expected: FAIL — `AddConfig` throws "not implemented" / `Locked` undefined.

- [ ] **Step 3: Add `Name`/`Creator`/`Locked` to `LayerConfig`**

Add these members inside the `LayerConfig` class in `src/ocg.ts` (after `SetVisible`):

```ts
  get Name(): string | undefined { return textOf(this.doc, this.Dict.get('Name')); }
  set Name(v: string) { this.Dict.set('Name', pdfText(v)); this.doc.markModified(); }

  get Creator(): string | undefined { return textOf(this.doc, this.Dict.get('Creator')); }

  get Locked(): Layer[] {
    const out: Layer[] = [];
    for (const r of arrayOf(this.doc, this.Dict.get('Locked'))) {
      const l = this.oc.layerForRef(r);
      if (l) out.push(l);
    }
    return out;
  }

  SetLocked(layer: Layer, v: boolean): void {
    if (v) this.addTo('Locked', layer.Ref);
    else this.removeFrom('Locked', layer.Ref);
    this.doc.markModified();
  }
```

(`textOf` and `pdfText` are module-level helpers from Task 1.)

- [ ] **Step 4: Implement `Configs`/`GetConfig`/`AddConfig`/`RemoveConfig`**

Replace the Task-1 placeholder config methods in `OptionalContent` with:

```ts
  get Configs(): LayerConfig[] {
    const p = this.ocProps();
    if (!p) return [];
    const out: LayerConfig[] = [];
    for (const e of arrayOf(this.doc, p.get('Configs'))) {
      const d = resolveDict(this.doc, e);
      if (d) out.push(new LayerConfig(this.doc, d, this));
    }
    return out;
  }

  GetConfig(name: string): LayerConfig | undefined {
    return this.Configs.find((c) => c.Name === name);
  }

  AddConfig(name: string): LayerConfig {
    const p = this.ensureOcProps();
    const existing = this.doc.resolve(p.get('Configs'));
    const arr = isArray(existing) ? [...existing] : [];
    const dict: PdfDict = new Map<PdfObject extends never ? never : string, PdfObject>([['Name', pdfText(name)]]);
    arr.push(this.doc.allocObject(dict));
    p.set('Configs', arr);
    this.doc.markModified();
    return new LayerConfig(this.doc, dict, this);
  }

  RemoveConfig(cfg: LayerConfig): void {
    const p = this.ocProps();
    if (!p) return;
    const existing = this.doc.resolve(p.get('Configs'));
    if (!isArray(existing)) return;
    p.set('Configs', existing.filter((e) => resolveDict(this.doc, e) !== cfg.Dict));
    this.doc.markModified();
  }
```

If the `Map` generic above is awkward under strict TS, use the simpler form:

```ts
    const dict: PdfDict = new Map();
    dict.set('Name', pdfText(name));
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run test/ocg.test.ts`
Expected: PASS.

- [ ] **Step 6: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add src/ocg.ts test/ocg.test.ts
git commit -m "feat(ocg): read/write named optional-content configurations"
```

---

### Task 4: RemoveLayer — definitions, annotations, XObjects

Implements the non-content parts of layer deletion: strip the OCG from `/OCGs` and every config's arrays (including nested `/Order` and `/RBGroups`), drop annotations bound to the layer, and un-layer XObjects bound to it.

**Files:**
- Modify: `src/ocg.ts` (`RemoveLayer` + helpers `refMatchesLayer`, `removeRefDeep`)
- Test: `test/ocg.test.ts`

**Interfaces:**
- Consumes: `sameRef`, `arrayOf`, `resolveDict` (Task 1); `Document.Pages`, `Page.Dict`, `Page.Resources`, `Document.deleteObject`; `types.ts` `isStream`.
- Produces:
  - `OptionalContent.RemoveLayer(layer: Layer): void` (definition/annotation/XObject portions; content excision added in Task 5)
  - module helpers `refMatchesLayer(doc, o, target)`, `removeRefDeep(arr, target)`

- [ ] **Step 1: Write the failing test**

Append to `test/ocg.test.ts`:

```ts
import { isStream } from '../src/types.js';

describe('OCG RemoveLayer — definitions/annots/xobjects', () => {
  it('removes the layer from /OCGs and the default config arrays', () => {
    const doc = Document.Open(buildOcgPdf());
    const oc = doc.OptionalContent;
    const b = oc.GetLayer('Layer B')!;
    oc.RemoveLayer(b);
    expect(oc.Layers.map((l) => l.Name)).toEqual(['Layer A', 'Layer C']);
    // /D /OFF no longer references B
    expect(oc.Default.IsVisible(oc.Layers[0])).toBe(true);
    // /Order no longer references B (length 2)
    const ocProps = doc.resolve(doc.catalog().get('OCProperties')) as Map<string, unknown>;
    const d = doc.resolve(ocProps.get('D') as never) as Map<string, unknown>;
    expect((doc.resolve(d.get('Order') as never) as unknown[]).length).toBe(2);
  });

  it('drops annotations bound to the layer', () => {
    const doc = Document.Open(buildOcgPdf());
    const oc = doc.OptionalContent;
    oc.RemoveLayer(oc.GetLayer('Layer B')!);
    const annots = doc.resolve(doc.Pages[0].Dict.get('Annots'));
    expect(Array.isArray(annots) ? annots.length : 0).toBe(0);
  });

  it('un-layers XObjects bound to the layer', () => {
    const doc = Document.Open(buildOcgPdf());
    const oc = doc.OptionalContent;
    oc.RemoveLayer(oc.GetLayer('Layer C')!);
    const res = doc.Pages[0].Resources!;
    const xobjs = doc.resolve(res.get('XObject')) as Map<string, unknown>;
    const fm = doc.resolve(xobjs.get('Fm0') as never);
    expect(isStream(fm) && fm.dict.has('OC')).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/ocg.test.ts`
Expected: FAIL — `RemoveLayer` is a no-op, so layers/annots/OC are unchanged.

- [ ] **Step 3: Add helpers and implement the three portions of `RemoveLayer`**

Add `isStream` to the `types.js` import in `src/ocg.ts`:

```ts
import {
  PdfObject, PdfDict, PdfRef,
  isDict, isArray, isRef, isName, isString, isStream, name, ref,
} from './types.js';
```

Add these module-level helpers (near `sameRef`):

```ts
/** Does `o` (a ref, an OCG dict, or an OCMD listing the layer) name `target`? */
export function refMatchesLayer(doc: Document, o: PdfObject | undefined, target: PdfRef): boolean {
  if (sameRef(o, target)) return true;
  const d = doc.resolve(o);
  if (isDict(d)) {
    const t = doc.resolve(d.get('Type'));
    if (isName(t) && t.name === 'OCMD') {
      const ocgs = d.get('OCGs');
      if (isArray(doc.resolve(ocgs))) return arrayOf(doc, ocgs).some((g) => sameRef(g, target));
      return sameRef(ocgs, target);
    }
  }
  return false;
}

/** Return a copy of `arr` with `target` removed at any depth (for /Order, /RBGroups). */
export function removeRefDeep(arr: PdfObject[], target: PdfRef): PdfObject[] {
  const out: PdfObject[] = [];
  for (const e of arr) {
    if (sameRef(e, target)) continue;
    if (isArray(e)) out.push(removeRefDeep(e, target));
    else out.push(e);
  }
  return out;
}
```

Replace the Task-1 `RemoveLayer` placeholder in `OptionalContent` with:

```ts
  RemoveLayer(layer: Layer): void {
    const p = this.ocProps();
    if (!p) return;
    const target = layer.Ref;

    // 1. /OCGs
    p.set('OCGs', removeRefDeep(arrayOf(this.doc, p.get('OCGs')), target));

    // 1b. every config dict (/D and each /Configs entry)
    const configDicts: PdfDict[] = [];
    const dDict = resolveDict(this.doc, p.get('D'));
    if (dDict) configDicts.push(dDict);
    for (const e of arrayOf(this.doc, p.get('Configs'))) {
      const cd = resolveDict(this.doc, e);
      if (cd) configDicts.push(cd);
    }
    for (const cd of configDicts) {
      for (const key of ['ON', 'OFF', 'Order', 'Locked', 'RBGroups']) {
        const a = this.doc.resolve(cd.get(key));
        if (isArray(a)) cd.set(key, removeRefDeep(a, target));
      }
    }

    // 2. annotations + 4. XObjects, per page
    for (const page of this.doc.Pages) {
      const annots = this.doc.resolve(page.Dict.get('Annots'));
      if (isArray(annots)) {
        const kept = annots.filter((a) => {
          const ad = resolveDict(this.doc, a);
          return !(ad && refMatchesLayer(this.doc, ad.get('OC'), target));
        });
        if (kept.length !== annots.length) page.Dict.set('Annots', kept);
      }
      const xobjs = resolveDict(this.doc, page.Resources?.get('XObject'));
      if (xobjs) {
        for (const [, v] of xobjs) {
          const xo = this.doc.resolve(v);
          if (isStream(xo) && refMatchesLayer(this.doc, xo.dict.get('OC'), target)) xo.dict.delete('OC');
        }
      }
    }

    // 3. content excision — Task 5 inserts the call here.

    this.doc.deleteObject(target.num);
    this.doc.markModified();
  }
```

Remove the now-unused `void ref; void name;` line if `ref`/`name` are otherwise referenced; if `ref` is still unused, keep `void ref;` only.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/ocg.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/ocg.ts test/ocg.test.ts
git commit -m "feat(ocg): RemoveLayer strips definitions, annotations and XObject /OC"
```

---

### Task 5: RemoveLayer — page content excision

Excises each page's marked-content blocks (`/OC … BDC … EMC`) bound to the deleted layer, respecting nesting. All `/Contents` streams of a page are concatenated, parsed once, edited, and written back as a single uncompressed stream.

**Files:**
- Modify: `src/ocg.ts` (add `stripLayerContent` + call it from `RemoveLayer`)
- Test: `test/ocg.test.ts`

**Interfaces:**
- Consumes: `content.ts` `parseContentStream`/`serializeContentStream`/`ContentOp`; `filters.ts` `decodeStream`; `pagecontent.ts` `streamOf`; `refMatchesLayer`, `resolveDict` (Task 4); `Page.Resources`.
- Produces: private behaviour only (no new public surface).

- [ ] **Step 1: Write the failing test**

Append to `test/ocg.test.ts`:

```ts
import { decodeStream } from '../src/filters.js';

/** Decoded concatenation of a page's /Contents streams, as text. */
function pageContentText(doc: Document, pageIndex = 0): string {
  const c = doc.resolve(doc.Pages[pageIndex].Dict.get('Contents'));
  const refs = Array.isArray(c) ? c : [c];
  let out = '';
  for (const r of refs) {
    const s = doc.resolve(r as never);
    if (isStream(s)) out += new TextDecoder().decode(decodeStream(s));
  }
  return out;
}

describe('OCG RemoveLayer — content excision', () => {
  it('excises the inner nested block when deleting Layer B', () => {
    const doc = Document.Open(buildOcgPdf());
    const oc = doc.OptionalContent;
    oc.RemoveLayer(oc.GetLayer('Layer B')!);
    const txt = pageContentText(doc);
    expect(txt).toContain('/MC0');        // outer (Layer A) block kept
    expect(txt).not.toContain('/MC1');    // inner (Layer B) block gone
    expect(txt).not.toContain('20 20 50 50 re'); // inner body gone
    expect(txt).toContain('10 10 100 100 re');   // outer body kept
  });

  it('excises the whole outer block (with its nested child) when deleting Layer A', () => {
    const doc = Document.Open(buildOcgPdf());
    const oc = doc.OptionalContent;
    oc.RemoveLayer(oc.GetLayer('Layer A')!);
    const txt = pageContentText(doc);
    expect(txt).not.toContain('/MC0');
    expect(txt).not.toContain('/MC1');            // nested child removed with parent
    expect(txt).not.toContain('10 10 100 100 re');
    expect(txt).toContain('0 0 0 rg');            // content outside any OC block kept
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/ocg.test.ts`
Expected: FAIL — content still contains `/MC1` etc. (excision not wired in).

- [ ] **Step 3: Add imports and `stripLayerContent`**

Add to the top of `src/ocg.ts`:

```ts
import { parseContentStream, serializeContentStream, ContentOp } from './content.js';
import { decodeStream } from './filters.js';
import { streamOf } from './pagecontent.js';
import type { Page } from './page.js';
```

Add this module-level function:

```ts
/** Excise every `/OC … BDC … EMC` block bound to `target` from a page's content.
 *  All /Contents streams are concatenated, parsed, filtered, and rewritten as a
 *  single uncompressed stream. Returns true when anything was removed. */
function stripLayerContent(doc: Document, page: Page, target: PdfRef): boolean {
  const c = doc.resolve(page.Dict.get('Contents'));
  const refs: PdfObject[] = isArray(c) ? c : c === null ? [] : [page.Dict.get('Contents') as PdfObject];
  const parts: Uint8Array[] = [];
  for (const r of refs) {
    const s = doc.resolve(r);
    if (isStream(s)) parts.push(decodeStream(s));
  }
  if (parts.length === 0) return false;

  // concatenate with newline separators so ops never run together
  const NL = new Uint8Array([0x0a]);
  const joined: Uint8Array[] = [];
  parts.forEach((p, i) => { if (i) joined.push(NL); joined.push(p); });
  const total = joined.reduce((n, p) => n + p.length, 0);
  const buf = new Uint8Array(total);
  let off = 0;
  for (const p of joined) { buf.set(p, off); off += p.length; }

  const props = resolveDict(doc, page.Resources?.get('Properties'));
  const ops = parseContentStream(buf);

  const out: ContentOp[] = [];
  let dropDepth = -1; // -1 = not dropping; otherwise the nesting level the dropped block opened at
  let nesting = 0;
  let dropped = false;

  for (const op of ops) {
    if (op.operator === 'BDC' || op.operator === 'BMC') {
      const startDrop = dropDepth < 0 && op.operator === 'BDC' && isOcOperand(doc, op, props, target);
      if (startDrop) { dropDepth = nesting; dropped = true; }
      nesting++;
      if (dropDepth < 0) out.push(op);
      continue;
    }
    if (op.operator === 'EMC') {
      nesting = Math.max(0, nesting - 1);
      if (dropDepth >= 0) {
        if (nesting === dropDepth) dropDepth = -1; // close the dropped block (skip this EMC)
        continue;
      }
      out.push(op);
      continue;
    }
    if (dropDepth < 0) out.push(op);
  }

  if (!dropped) return false;
  page.Dict.set('Contents', [doc.allocObject(streamOf(serializeContentStream(out)))]);
  return true;
}

/** True when a BDC op is `/OC <prop> BDC` and <prop> resolves to `target`. */
function isOcOperand(doc: Document, op: ContentOp, props: PdfDict | undefined, target: PdfRef): boolean {
  const tag = op.operands[0];
  if (!isName(tag) || tag.name !== 'OC') return false;
  const p = op.operands[1];
  const oc = isName(p) && props ? props.get(p.name) : p;
  return refMatchesLayer(doc, oc, target);
}
```

- [ ] **Step 4: Call it from `RemoveLayer`**

In `OptionalContent.RemoveLayer`, replace the `// 3. content excision — Task 5 inserts the call here.` comment with:

```ts
    for (const page of this.doc.Pages) stripLayerContent(this.doc, page, target);
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run test/ocg.test.ts`
Expected: PASS (both new cases plus all prior).

- [ ] **Step 6: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add src/ocg.ts test/ocg.test.ts
git commit -m "feat(ocg): RemoveLayer excises bound marked-content blocks"
```

---

### Task 6: Round-trip through Save + README/docs

Proves the whole model survives serialization (classic and compressed) and documents the public API.

**Files:**
- Modify: `README.md` (Features + Limitations)
- Test: `test/ocg.test.ts`

**Interfaces:**
- Consumes: `Document.Save`, `Document.Open` (existing).
- Produces: no new code surface.

- [ ] **Step 1: Write the round-trip test**

Append to `test/ocg.test.ts`:

```ts
describe('OCG round-trip through Save()', () => {
  for (const compressed of [false, true]) {
    it(`preserves layers, visibility and edits (compressed=${compressed})`, () => {
      const doc = Document.Open(buildOcgPdf());
      const oc = doc.OptionalContent;
      oc.GetLayer('Layer B')!.Visible = true;       // edit /D
      oc.AddConfig('Screen');                        // add a config
      oc.RemoveLayer(oc.GetLayer('Layer C')!);       // delete a layer

      const out = doc.Save({ compressed });
      const re = Document.Open(out);
      const roc = re.OptionalContent;

      expect(roc.Layers.map((l) => l.Name)).toEqual(['Layer A', 'Layer B']);
      expect(roc.GetLayer('Layer B')!.Visible).toBe(true);
      expect(roc.Configs.map((c) => c.Name)).toEqual(['Print', 'Screen']);
      // deleted layer's XObject was un-layered and its content excised
      const txt = pageContentText(re);
      expect(txt).toContain('/MC0');
    });
  }
});
```

- [ ] **Step 2: Run test to verify it passes (round-trip already supported)**

Run: `npx vitest run test/ocg.test.ts`
Expected: PASS — `/OCProperties` hangs off the Catalog, so Save preserves it without extra code. If a case fails, fix the underlying model code before proceeding (do not edit the test to pass).

- [ ] **Step 3: Update README**

In `README.md`, under the Features list add a bullet:

```markdown
- **Optional content (layers / OCG)** — enumerate layers, read/toggle their
  visibility in the default and named viewing configurations, edit configs
  (add/remove/rename, locked state), and delete a layer together with its
  page-level marked content (`doc.OptionalContent`).
```

In the Limitations section add:

```markdown
- **Optional content** is manipulation-only (no rendering). `RemoveLayer`
  excises marked-content (`/OC … BDC … EMC`) blocks from page content streams,
  drops annotations bound to the layer, and removes `/OC` from bound XObjects,
  but does not delete an XObject (or its `Do`) that was used only by the layer,
  recurse into Form XObject streams, interpret OCMD `/VE` visibility
  expressions, or create new layers / author layered content.
```

- [ ] **Step 4: Run the full suite + typecheck**

Run: `npm run typecheck && npm test`
Expected: all green.

- [ ] **Step 5: Commit**

```bash
git add README.md test/ocg.test.ts
git commit -m "test(ocg): round-trip coverage; docs: layers in README"
```

- [ ] **Step 6: Close the issue**

```bash
bd close aspose-pdf-foss-for-ts-ac0
```

File follow-up issues for the documented out-of-scope items (deep XObject/`Do` excision, recursive Form-XObject content stripping, OCMD `/VE`, layer creation / layered-content authoring) with `bd create`.

---

## Self-Review

**1. Spec coverage:**
- Enumerate OCGs (name, default visibility) → Task 1 (names/intent) + Task 2 (visibility). ✓
- Read/set default config `/D` ON/OFF per layer → Task 2. ✓
- Toggle named configs (full read/write model) → Task 3. ✓
- Optionally delete a layer + its marked content → Tasks 4 (defs/annots/xobjects) + 5 (content). ✓
- Round-trips through Save() (classic + compressed) → Task 6. ✓
- Lazy `/OCProperties` creation → Task 1 `ensureOcProps`; reads (`Layers`) stay non-mutating. ✓
- Fixture + tests + README → Tasks 1–6. ✓

**2. Placeholder scan:** No "TBD/TODO"; every code step shows complete code. The Task-1 `OptionalContent` config/RemoveLayer stubs are explicitly temporary and are replaced wholesale in Tasks 3–5 (noted at each site). ✓

**3. Type consistency:** `Layer` ctor `(doc, Ref, Dict, oc)` used consistently; `LayerConfig` ctor `(doc, Dict, oc)` used in `Default`/`Configs`/`AddConfig`. `sameRef`/`arrayOf`/`resolveDict`/`refMatchesLayer`/`removeRefDeep` signatures match call sites. `IsVisible`/`SetVisible`/`SetLocked` take `Layer`. `stripLayerContent(doc, page, target)` matches its caller. `OptionalContent.layerForRef` (Task 1) is consumed by `LayerConfig.Locked` (Task 3). ✓

One note carried into execution: in Task 1 the module imports `name`/`ref` before they're used (guarded by `void`); remove the guard once Task 4 references `name`/keep `void ref;` if `ref` stays unused. The implementer should let `npm run typecheck` drive removal of any genuinely-unused import.

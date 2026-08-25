# OCG Authoring (hz2) — Design

Issue: `aspose-pdf-foss-for-ts-hz2` — *OCG: create new layers and author layered content*.
Counterpart to `ac0` (read/edit/delete OCGs). This adds **creation** of brand-new
optional-content groups and **tagging** of newly-authored content into a layer.

## Goal

Let callers create optional-content groups and attach content to them:

1. Create OCGs (`OptionalContent.AddLayer`), including nesting in the viewer's
   layer panel (`/D /Order`).
2. Tag authored vector content into a layer (`PageGraphics.BeginLayer`/`EndLayer`
   emitting `/OC /OCn BDC … EMC`).
3. Tag whole images and annotations into a layer (`/OC` on the object).

All of it round-trips through `Save()` and re-enumerates via the existing
`ac0` read API.

## Existing landscape

- `src/ocg.ts` — `OptionalContent` / `Layer` / `LayerConfig`. Read/edit/delete
  only. Has `ensureOcProps()` (creates `/OCProperties` with empty `/OCGs` and
  `/D { /Order [] }`), `Default` (the `/D` config), `layerForRef`, `sameRef`,
  `arrayOf`, `resolveDict`, `AddConfig` (the model for allocating + appending).
- `src/graphics.ts` — `PageGraphics`, a buffered op builder. `BeginMarkedContent`
  emits `<</MCID n>> BDC` (structure tagging, not OC). `setOpacity` shows the
  eager-resource-registration pattern (`registerExtGState`).
- `src/pagecontent.ts` — `ensureOwnResources`, `ensureOwnSubdict`, `freshKey`,
  `registerExtGState` (search-existing-then-fresh-key registration model).
- `src/imageembed.ts` — `addImage` / `AddImageOptions`. Builds an image XObject
  and sets its dict keys; already supports an `opts.tag` structure element.
- `src/annotation.ts` — base `Annotation` with `readonly Dict` and `touch()`;
  every setter calls `touch()` (`markModified`).
- `RemoveLayer` (ac0) already strips `/OC` from XObject dicts and drops
  annotations whose `/OC` matches, so whole-object membership composes with
  deletion.

`allocObject(obj): PdfRef` — allocates and returns a ref.

## 1. Create layers — `OptionalContent.AddLayer`

```ts
export interface AddLayerOptions {
  /** Nest the new layer under this one in /D /Order. Default: top level. */
  parent?: Layer;
  /** Default-config visibility. Default: true. */
  visible?: boolean;
  /** /Intent name(s). Default: 'View'. */
  intent?: string | string[];
}

AddLayer(name: string, opts?: AddLayerOptions): Layer
```

Behaviour:

1. `ensureOcProps()`.
2. Build the OCG dict: `<< /Type /OCG /Name (name) >>`, plus `/Intent` when
   `opts.intent` is given (a name for a single string, an array of names for an
   array).
3. `const ref = doc.allocObject(dict)`; append `ref` to `/OCGs`.
4. Wire `/D /Order` (via `Default.Dict`, key `Order`, create `[]` if absent):
   - **no parent** — append `ref` at the top level of `/Order`.
   - **parent** — recursively locate `parent.Ref` anywhere in the `/Order` tree.
     If the element immediately after it is an array, push `ref` into that array;
     otherwise insert a fresh `[ref]` array immediately after `parent.Ref`. This
     is PDF's "OCG ref followed by a children array" group form (§8.11.4.3), so a
     parent layer doubles as its own group heading. If `parent.Ref` is not found
     in `/Order`, fall back to appending at top level.
5. `visible === false` → `this.Default.SetVisible(layer, false)` (adds to
   `/D /OFF`). `visible` true/undefined → leave default (`BaseState` ON).
6. `markModified()`; return `new Layer(doc, ref, dict, this)`.

Order editing works on a deep-copied array and writes it back with `Dict.set`,
consistent with `removeRefDeep` usage in `RemoveLayer`.

## 2. Tag authored content — `PageGraphics.BeginLayer` / `EndLayer`

```ts
BeginLayer(layer: Layer): this   // -> `/OC /OCn BDC`
EndLayer(): this                 // -> `EMC`
```

- `BeginLayer` eagerly registers `layer.Ref` in the page's
  `/Resources /Properties` and buffers `/OC /<key> BDC`.
- `EndLayer` buffers `EMC`.
- Balancing BDC/EMC is the caller's responsibility, matching the existing
  `BeginMarkedContent`/`EndMarkedContent`.

New helper in `pagecontent.ts`, mirroring `registerExtGState`:

```ts
export function registerOcProperty(doc: Document, page: Page, ocg: PdfRef): string
```

Uses `ensureOwnResources` + `ensureOwnSubdict(res, 'Properties')`; reuses an
existing key whose value is the same ref (`sameRef`), else `freshKey(props, 'OC')`
(`OC0`, `OC1`, …); stores the ref; returns the key. (`sameRef` moves to a shared
import or is re-derived locally to avoid a `graphics`→`ocg` cycle; `pagecontent`
already imports `isRef`, so a local ref-equality check is fine.)

## 3. Tag images & annotations

**Image** — `AddImageOptions` gains:

```ts
/** Attach the image XObject to an optional-content layer (sets /OC). */
layer?: Layer;
```

When set, `addImage` sets `/OC = layer.Ref` on the built image XObject dict
(`built.stream.dict`) before `allocObject`. Whole-XObject membership — no BDC
needed; composes with `RemoveLayer`'s existing XObject `/OC` handling.

**Annotation** — base `Annotation` gains a `Layer` accessor:

```ts
get Layer(): Layer | undefined       // resolve /OC via doc.OptionalContent.layerForRef
set Layer(v: Layer | undefined)      // set /OC = v.Ref, or delete /OC; touch()
```

## 4. Public exports

`AddLayerOptions` exported from `index.ts` (alongside the existing `OptionalContent`,
`Layer`, `LayerConfig`). `Layer` accessor and `PageGraphics.BeginLayer/EndLayer`
need no new exports (the classes are already exported).

## 5. Tests & docs

New/extended vitest (mirroring the ac0 OCG tests and a fixture builder in
`test/helpers/`):

- `AddLayer` top-level: appears in `/OCGs` and `/D /Order`, `Visible` true.
- `AddLayer` nested (`parent`): `/Order` shape is `[ parent [ child … ] ]`.
- `AddLayer` with `visible: false`: layer ref in `/D /OFF`, `Visible` false.
- `AddLayer` with `intent`: `/Intent` name / name-array.
- `PageGraphics.BeginLayer`/`EndLayer`: content contains `/OC /OCn BDC … EMC`
  and `/Resources /Properties /OCn` resolves to the OCG.
- Image `layer`: image XObject dict has `/OC` → the OCG.
- Annotation `Layer` get/set: sets and clears `/OC`.
- Round-trip: build → `Save()` → `Open()` → `OptionalContent.Layers` re-lists the
  authored layers with correct names/visibility/nesting.

README "Layers" section: add an authoring example (create a layer, draw into it
via `BeginLayer`/`EndLayer`, tag an image/annotation).

## Non-goals

- Label-only (string) group headings in `/Order` — parent layers act as headings.
- OCMD / `/VE` visibility-expression authoring (`3sn`).
- Auto-balancing of BDC/EMC — caller-managed, like the structure API.
- Deep XObject-content excision changes — unrelated (`gvu`/`647`).

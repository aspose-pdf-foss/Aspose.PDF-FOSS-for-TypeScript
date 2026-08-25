# Optional Content Groups (Layers / OCG) — Design

Issue: `aspose-pdf-foss-for-ts-ac0` (P2, feature)
Date: 2026-06-30

## Goal

Read, enumerate, toggle, and remove optional-content layers via `/OCProperties`.
Manipulation only — **no rendering**. The library exposes a live object-model API
to inspect layers, read/set their visibility in viewing configurations, edit named
configurations, and delete a layer together with its page-level marked content.
Everything round-trips through `Save()` (classic and `{ compressed: true }`).

## Background: the `/OCProperties` structure

`/OCProperties` lives in the document Catalog (`/Root`), so it is reachable by
Save's mark-sweep and is preserved automatically; any OCG made unreachable by a
delete is dropped on the next `Save()`.

```
/OCProperties <<
  /OCGs    [ ocg1 ocg2 ... ]    % array of all OCG dicts (must be indirect)
  /D       << ...config... >>   % the default viewing configuration
  /Configs [ << ...config... >> ... ]   % optional alternate named configs
>>
```

An OCG (layer) dict:

```
<< /Type /OCG /Name (Layer 1) /Intent /View /Usage << ... >> >>
```

A configuration dict (`/D` or an entry of `/Configs`):

```
<< /Name (text) /Creator (text)
   /BaseState /ON | /OFF    % default for groups not in /ON or /OFF (default /ON)
   /ON  [ ocgs ]            % groups forced ON
   /OFF [ ocgs ]            % groups forced OFF
   /Order [ ... ]           % display-tree order in the viewer UI
   /Locked [ ocgs ]
   /RBGroups [ ... ]        % radio-button (mutually exclusive) groups
>>
```

Content is associated with a layer either through marked content
(`/OC /MCx BDC ... EMC`, where `/MCx` maps via the page's `Resources /Properties`
to an OCG/OCMD dict, or an inline `/OC << ... >> BDC`) or through `/OC` on an
XObject or annotation dict.

## Architecture

A new module `src/ocg.ts` holding three live-handle classes over the
`/OCProperties` sub-tree, plus a `doc.OptionalContent` accessor on `document.ts`.

- Live-mutation model: handles wrap the resolved dicts from the objects map
  (mirroring `Field` in `form.ts`). Edits act directly on those dicts; `Save()`
  renumbers and rewrites the reachable graph.
- Content-stream excision reuses the existing `content.ts` tokenizer and the
  `pagecontent.ts` content helpers; no new low-level parsing.

## API surface

```ts
// Entry point. Returned by doc.OptionalContent (getter).
// Reflects an empty model when /OCProperties is absent; the dict is created
// lazily on the first mutating call (AddConfig / RemoveLayer-with-edits).
class OptionalContent {
  get Layers(): Layer[]                  // from /OCGs, in array order
  GetLayer(name: string): Layer | undefined   // first layer with that /Name
  RemoveLayer(layer: Layer): void        // delete + strip content (see below)

  get Default(): LayerConfig             // the /D configuration
  get Configs(): LayerConfig[]           // named /Configs entries
  GetConfig(name: string): LayerConfig | undefined
  AddConfig(name: string): LayerConfig   // append a new /Configs entry
  RemoveConfig(cfg: LayerConfig): void   // remove from /Configs (not /D)
}

// Live handle over one /OCG dict.
class Layer {
  get Name(): string;        set Name(v: string)
  get Intent(): string[]                 // /View, /Design (single name -> [name])
  get Visible(): boolean;    set Visible(v: boolean)   // sugar over Default
  readonly Ref: PdfRef                   // indirect ref (OCGs are indirect)
  readonly Dict: PdfDict
}

// Live handle over /D or a /Configs entry.
class LayerConfig {
  get Name(): string | undefined;    set Name(v: string)
  get Creator(): string | undefined
  get BaseState(): 'ON' | 'OFF';     set BaseState(v: 'ON' | 'OFF')
  IsVisible(layer: Layer): boolean
  SetVisible(layer: Layer, v: boolean): void
  get Locked(): Layer[]
  SetLocked(layer: Layer, v: boolean): void
}
```

### Visibility resolution

A layer is visible in a config when it is listed in the config's `/ON`, **or**
it is not listed in `/OFF` and `/BaseState` is `/ON` (the default). `SetVisible`
maintains the arrays explicitly: `SetVisible(true)` ensures the layer ref is in
`/ON` and removes it from `/OFF`; `SetVisible(false)` does the reverse. Layer
refs are compared by object/generation number. `Layer.Visible` delegates to
`Default.IsVisible / SetVisible`.

## `RemoveLayer` semantics

Bounded to the page-stream level. Steps:

1. **Definition cleanup.** Remove the OCG ref from `/OCGs`; from `/D`'s
   `/ON /OFF /Order /Locked /RBGroups`; and from the same arrays in every
   `/Configs` entry. `/Order` may nest the ref inside arrays — remove it
   wherever it appears.
2. **Page content streams.** For each page, tokenize its `/Contents` (handling
   the array form by treating the concatenation logically but rewriting per
   stream). Find `/OC … BDC … EMC` blocks whose effective OCG — resolved through
   the page's `Resources /Properties` entry, or an inline dict — is the target
   layer, and excise the entire block (from the `BDC` operator through its
   matching `EMC`), respecting nesting of other BDC/EMC pairs. Rewrite the stream
   bytes.
3. **Annotations.** Delete from each page's `/Annots` any annotation dict whose
   `/OC` references the layer.
4. **XObjects.** Strip the `/OC` key from any XObject dict bound to the layer.
   This un-layers the XObject; it does **not** remove the XObject or its `Do`
   invocation (deeper content excision is deferred — see Limitations).

OCMD (`/OCMD` membership) dicts are handled when their `/OCGs` array directly
lists the target layer (the ref is removed; an OCMD left with no groups is
treated as always-visible by viewers, which is acceptable). Complex OCMD
visibility expressions (`/VE`) are not interpreted.

## Round-trip behaviour

`/OCProperties` is reached from the Catalog, so `Save()` preserves edited configs
and layers and drops removed OCGs (now unreachable). No incremental update path
exists in this library — every `Save()` rewrites the full reachable graph — so
live edits to config/OCG dicts serialize without extra bookkeeping. Tests assert
round-trip under both the classic xref output and `Save({ compressed: true })`.

## Testing

New fixture `test/helpers/build-ocg-pdf.ts` building a document with:

- 2–3 OCGs in `/OCGs` with distinct `/Name`s.
- A `/D` config with mixed `/ON`/`/OFF` membership and an explicit `/BaseState`.
- One named `/Configs` entry with a different visibility state.
- Page content containing marked-content blocks (`/OC /MCx BDC … EMC`) bound to
  layers via `Resources /Properties`, including one nested pair.
- An annotation carrying `/OC` for a layer.
- An XObject carrying `/OC` for a layer.

Vitest (`test/ocg.test.ts`) covers:

- Enumerate layers: names and default visibility.
- Get/set `Layer.Visible` and per-config `IsVisible`/`SetVisible`, including the
  `BaseState`-default path.
- `LayerConfig` read/write: `AddConfig`, `RemoveConfig`, rename, per-layer state,
  `Locked`.
- `RemoveLayer`: marked-content block excised (and nesting preserved), arrays in
  `/D` and `/Configs` cleaned, annotation dropped, XObject un-layered, OCG gone
  from `/OCGs`.
- Full round-trip through `Save()` and `Save({ compressed: true })` — reload and
  re-assert the above.

README "Features" and "Limitations" sections updated to describe the optional-
content API and its boundaries.

## Out of scope (follow-up issues)

- Creating brand-new OCGs from scratch and authoring layered content (tagging new
  graphics produced by `graphics.ts` into a layer) — a separate authoring feature.
- Removing an XObject and its `Do` invocation when its only purpose was the
  deleted layer (deeper content excision).
- Interpreting OCMD `/VE` visibility expressions.
- Any rendering / rasterization of layer state.

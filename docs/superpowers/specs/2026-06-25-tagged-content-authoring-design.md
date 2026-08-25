# Tagged-content authoring — design

**Date:** 2026-06-25
**Status:** Approved (design); plan pending
**Scope:** Sub-project S3 of the "Tagged PDF / accessibility" epic
(`aspose-pdf-foss-for-ts-pjx.3`). The authoring counterpart to the S1 read model
([2026-06-25-struct-tree-read-model-design.md](2026-06-25-struct-tree-read-model-design.md)).

## Context

S1 shipped a **read** model: live `StructTreeRoot` / `StructElement` handles over
`/StructTreeRoot`, RoleMap resolution, MCID→glyph correlation, reading-order
`GetText`, and `/ParentTree` lookups ([struct.ts](../../../src/struct.ts)). S2
added structure **preservation** across page ops
([structpreserve.ts](../../../src/structpreserve.ts)). Authoring was an explicit
non-goal of both.

S3 adds the **write** side: emit marked content (`BDC`/`EMC` with `/MCID`) while
adding content, and a write API to build/append `StructElement` nodes and wire
`/StructTreeRoot`, `/ParentTree`, and `/MarkInfo`. The design is symmetric with
the live-handle read model — the same `StructTreeRoot` / `StructElement` classes
gain write methods, so one handle type serves both directions.

The content-authoring layer this hooks into: `stamp.ts` (`AddText` /
`AddTextBlock`), `imageembed.ts` (`AddImage`), and `graphics.ts` (the buffered
`PageGraphics` vector builder), all of which build a content-stream body and
splice it via the helpers in [pagecontent.ts](../../../src/pagecontent.ts)
(`appendContent`). Annotations are created through `Page.Add*Annotation`
([annotation.ts](../../../src/annotation.ts)) and are object-level.

## Goals

1. **Build a structure tree from scratch** on an untagged document, or extend an
   existing one — create elements, set their accessibility properties, register
   custom roles.
2. **Tag authored content** — when adding text or images, emit `BDC`/`EMC` with
   an `/MCID` and wire the marked content to a structure element so the S1 read
   model (reading order, `ElementFor`, `GetText`) reads it back correctly.
3. **Tag annotations** — object-level structure via `/StructParent` + `OBJR`.
4. **Low-level escape hatch** — expose the marked-content primitives so callers
   who hand-build content (e.g. via `PageGraphics`) can mark it.

## Non-goals (other sub-projects)

- Deep attribute semantics (table/list/layout attribute interpretation) — S4.
- PDF/UA validation rules — S5.
- Automatic/inferred tagging of pre-existing untagged content. The caller
  decides what each piece of authored content is.

## Approach

Primary path is **element-first** (approach A): the caller builds a
`StructElement`, then passes it as a `tag` option to the existing draw calls. The
draw call allocates the page's MCID, wraps its body in marked content, and wires
the `/ParentTree` and the element's `/K`. A **low-level escape hatch** (approach
B) exposes the same MCID allocation plus `BDC`/`EMC` buffer ops for hand-built
content.

Rejected alternatives:

- *`tag` as a string structure type that auto-creates an element under an
  implicit "current parent".* Introduces hidden mutable state and ambiguous
  parentage. Rejected for an explicit, stateless `StructElement` handle.
- *A separate `StructTreeBuilder` class for writes.* Diverges from the
  live-handle convention and forces read/write handle conversions. Rejected for
  write methods on the existing handles.

## Module layout

New module `src/structwrite.ts` holds the write helpers (parallel to
`structpreserve.ts`):

- MCID allocation per page (`nextMcid`), including ensuring the page has a
  `/StructParents` key and a `/ParentTree` array entry.
- Object-key allocation for `OBJR` (`nextObjectKey`).
- Element-dict construction and `/K` appension (integer MCID + `/Pg`, `MCR`, or
  `OBJR`), with the single-page-vs-cross-page `/Pg` rule.
- `/ParentTree` `/Nums` maintenance and `ParentTreeNextKey` bookkeeping.

The live handles in `struct.ts` gain thin write methods/setters that delegate to
these helpers. `pagecontent.ts` gains `wrapMarkedContent`. The draw functions in
`stamp.ts` / `imageembed.ts` gain a `tag` option; `graphics.ts` gains
`BeginMarkedContent` / `EndMarkedContent` buffer ops.

## Public API

### Document facade ([document.ts](../../../src/document.ts))

```ts
CreateStructTree(): StructTreeRoot;   // idempotent
set Lang(v: string);                  // catalog /Lang (getter already exists)
```

`CreateStructTree` returns the existing root (wrapped) when the catalog already
has a `/StructTreeRoot`; otherwise it allocates
`{ /Type /StructTreeRoot /K [] /ParentTree << /Nums [] >> /ParentTreeNextKey 0 }`,
sets `catalog /StructTreeRoot`, and sets `catalog /MarkInfo << /Marked true >>`.

### Tree write API (on the live handles, `struct.ts`)

```ts
// StructTreeRoot
Append(type: string, opts?: ElemOpts): StructElement;   // top-level element
RegisterRole(custom: string, standard: string): void;   // adds to /RoleMap

// StructElement
Append(type: string, opts?: ElemOpts): StructElement;   // child element
set Alt(v: string | undefined);
set ActualText(v: string | undefined);
set Lang(v: string | undefined);
set Title(v: string | undefined);
set Expansion(v: string | undefined);
set ID(v: string | undefined);

interface ElemOpts {
  alt?: string; actualText?: string; lang?: string;
  title?: string; expansion?: string; id?: string;
}
```

`Append` allocates a new element dict
`{ /Type /StructElem /S <type> /P <parent ref> /K [] }`, appends its ref to the
parent's `/K`, applies `opts`, and returns the handle. Setters write PDF
text-strings (or delete the key when `undefined`). No hidden state — the tree is
shaped by explicit `Append` chains.

### Marked-content emission (draw-call integration)

The tag-aware draw calls accept `tag?: StructElement`:

```ts
page.AddText(text, x, y, { /* …existing… */ tag });
page.AddTextBlock(text, rect, { /* …existing… */ tag });   // single MCID for the block
page.AddImage(bytes, rect, { /* …existing… */ tag });
```

When `tag` is set, the draw call:

1. `mcid = structwrite.nextMcid(doc, page)` — ensures the page has a
   `/StructParents` key (allocating from `ParentTreeNextKey` and creating the
   `/ParentTree` array if absent) and returns the next per-page MCID. Next MCID
   starts after the current maximum MCID already present in the page content
   (so authoring onto an already-tagged page does not collide).
2. wraps the emitted body via
   `wrapMarkedContent(tagName, mcid, body)` → `/<tagName> << /MCID n >> BDC\n` +
   body + `\nEMC`. `tagName` is the element's raw `/S`.
3. `structwrite.attachMcid(doc, element, page, mcid)` — sets
   `ParentTree[structParentsKey][mcid] = <element ref>` and appends the content
   ref to the element's `/K`: an integer MCID (setting the element's `/Pg` to the
   page on first content) when the element's content is all on one page, or an
   `MCR` dict `<< /Type /MCR /Pg <page> /MCID n >>` once content spans pages.

`AddTextBlock` emits one MCID around the whole flowed block. The remainder-return
contract is unchanged.

### Annotations (object-level)

```ts
// StructElement
AddAnnotation(annotation: Annotation): void;
```

Allocates an object `/StructParent` key (from `ParentTreeNextKey`), sets the
annotation dict's `/StructParent`, sets `ParentTree[key] = <element ref>` (the
element directly, not an array), and appends an `OBJR` dict
`<< /Type /OBJR /Pg <page> /Obj <annot ref> >>` to the element's `/K`. The
annotation must be an indirect object (annotations already are). One method
covers any annotation subtype, instead of a `tag` option on each
`Add*Annotation`.

### Low-level escape hatch (PageGraphics / hand-built content)

```ts
// StructElement
NextMcid(page: Page): number;   // = nextMcid + attachMcid; returns the number

// PageGraphics (graphics.ts)
BeginMarkedContent(tag: string, mcid: number): this;   // buffers '/tag << /MCID n >> BDC'
EndMarkedContent(): this;                               // buffers 'EMC'
```

Usage:

```ts
const mcid = el.NextMcid(gfx.page);
gfx.BeginMarkedContent(el.Type, mcid);
// …vector ops…
gfx.EndMarkedContent();
```

## Edge cases

- **CreateStructTree idempotency** — a second call returns the same wrapped root;
  it never duplicates `/StructTreeRoot`, `/ParentTree`, or `/MarkInfo`.
- **Page already has `/StructParents`** (loaded tagged PDF) — reuse the existing
  key and array, appending; do not allocate a second key.
- **Next MCID on a page with existing marked content** — start after the current
  maximum MCID found in the page's content stream.
- **Element content spanning pages** — switch that element's `/K` entries to
  `MCR` dicts (with `/Pg`) once a second page contributes content.
- **`tag` element belonging to a different document** — out of scope; behavior
  is undefined (callers tag with elements from the same document).
- **Empty / all-unencodable text with `tag`** — the draw is a no-op (as today);
  no MCID is allocated and `/K` is not touched.

## Serialization

No serializer changes. Marked content is plain content-stream text spliced by the
existing `appendContent`. The structure tree, `/ParentTree` (a number tree with a
flat `/Nums`), `/RoleMap`, and `/MarkInfo` are ordinary dict/array objects that
the existing mark-sweep serializer renumbers and writes. `Save({ compressed })`
is unaffected.

## Testing (TDD)

`test/struct-write.test.ts`, extending the `test/helpers/build-tagged-pdf.ts`
builder where useful (and authoring onto blank pages built by existing helpers).

- **Round-trip symmetry (central test):** author a tagged document from scratch
  (`CreateStructTree`, `Append` a `Document`→`H1`+`P`, `AddText`/`AddTextBlock`
  with `tag`), `Save`, re-`Open`, and assert the S1 read model reads it back:
  tree shape, reading-order `GetText`, `ElementFor(structParentsKey, mcid)`,
  `Alt`/`Lang`, `IsTagged`, document `Lang`.
- `CreateStructTree` idempotency (no duplicate root/ParentTree/MarkInfo).
- `Figure` + `Alt` image via `AddImage({ tag })`; verify the `Figure` element's
  `Alt` and MCID correlation.
- `RegisterRole` custom→standard, read back through `StandardType`.
- Annotation `OBJR`: `AddAnnotation`, then `ElementForObject(/StructParent)`
  resolves the element after round-trip.
- Low-level `NextMcid` + `PageGraphics.BeginMarkedContent`/`EndMarkedContent`,
  verifying the MCID resolves to the element.
- Extending an already-tagged page (reuse existing `/StructParents`).
- Element content spanning two pages → `MCR` entries.

`npm run typecheck` and `npm test` must be green before close.

## Docs

README "Features" gains tagged-content authoring; "Limitations" updated to note
what authoring covers (manual tagging of authored content; no auto-tagging of
imported untagged content). Public exports (`ElemOpts`, any new types) added to
`index.ts`.

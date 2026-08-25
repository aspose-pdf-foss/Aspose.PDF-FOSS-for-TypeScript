# Structure-tree read model — design

**Date:** 2026-06-25
**Status:** Approved (design); plan pending
**Scope:** First sub-project of the "Tagged PDF / accessibility" epic.

## Context

The library has **no** tagged-PDF support today: `/StructTreeRoot` is never
parsed, the content walk ignores marked content (`BDC`/`EMC`/`MCID`), and page
copies explicitly drop `/StructParents` (`defaultPrunePolicy` in
[extractor.ts](../../../src/extractor.ts)). The broader epic — read model,
PDF/UA document basics, structure preservation across page ops, and authoring —
is too large for one spec, so it is decomposed. This spec covers the **read
model + query API** only, which the other three pieces build on.

Read-side conventions already in the codebase:

- Plain-data snapshots returned by module functions wrapped by thin facade
  methods (`Page.GetTextFragments` → `TextFragment[]`,
  `Page.GetStructuredText` → `TextBlock[]`).
- **Live dict handles** — `Page`, `Field`, `Annotation` wrap the underlying
  `PdfDict` with live accessors and expose the ref.

Because this model is also meant to seed the later preservation and authoring
sub-projects, it uses the **live dict handle** convention.

## Goals

The read model must serve four use cases (all in scope):

1. **Inspect / audit accessibility** — walk the tag tree; read element types
   (resolved through `/RoleMap`), `/Lang`, `/Alt`, `/ActualText`, title.
2. **Semantic text in reading order** — resolve each element's marked content
   (`/K` integers, `MCR`, `OBJR`) to glyphs and produce reading-order text.
3. **Foundation for preservation** — expose the raw model completely
   (`/ParentTree`, MCID/page mapping) so page-op preservation can build on it.
4. **Foundation for authoring** — live handles symmetric with a future write
   API.

## Non-goals (future sub-projects)

- Structure preservation across extract/split/merge.
- Authoring / `BDC` emission while adding content.
- Deep attribute semantics (table/list layout attribute interpretation).
- PDF/UA validation rules.

## Approach

**Extend the existing content walk** ([text.ts](../../../src/text.ts)
`visitContent` / `walkScope`) with marked-content tracking, and tag each
`GlyphEvent` with its active `mcid`. The new `struct.ts` module runs that walk
per page to obtain a `(page, MCID) → glyphs` map, reusing the tokenizer, CTM /
font handling, and word-assembly machinery. The text.ts change is purely
additive (existing consumers ignore the new field).

Rejected alternative: a standalone scanner in `struct.ts` that only tracks
`BDC/EMC` + `Tj/TJ`. It avoids touching text.ts but duplicates the tokenizer
and loses graphics-state / font fidelity, degrading text and reading order.

## Module & entry points

New module `src/struct.ts`. Public exports added to `index.ts`:
`StructTreeRoot`, `StructElement`, and the supporting types below.

Document facade ([document.ts](../../../src/document.ts)) gains:

- `GetStructTree(): StructTreeRoot | null` — `null` when the catalog has no
  `/StructTreeRoot` (untagged). Mirrors `GetXmp()` / `GetMetadata()`.
- `IsTagged: boolean` — `/MarkInfo /Marked === true`.
- `Lang: string | undefined` — catalog `/Lang` (document default language).

## Node classes (live handles)

### `class StructTreeRoot`

Wraps the `/StructTreeRoot` dict.

- `Children: StructElement[]` — top-level elements from `/K`.
- `RoleMap: Map<string, string>` — raw role map (custom name → mapped name).
- `ClassMap: Map<string, PdfObject>` — raw class map.
- `ElementFor(structParentsKey: number, mcid: number): StructElement | undefined`
  — `/ParentTree` lookup for a page's marked content.
- `ElementForObject(structParentKey: number): StructElement | undefined`
  — `/ParentTree` lookup for an object (annotation / XObject) via `/StructParent`.
- `GetText(): string` — whole-tree reading-order text.
- `Dict: PdfDict`, `Ref: PdfRef | undefined` — exposed for the future write side.

### `class StructElement`

Wraps a structure-element dict. **Live accessors** (read straight from the dict):

| Member | Source | Notes |
|---|---|---|
| `Type` | `/S` | raw structure type name |
| `StandardType` | `/S` via `/RoleMap` | resolved through the RoleMap chain to a standard type; cycle-guarded |
| `IsStandardType` | — | whether `StandardType` is in the standard set |
| `Title` | `/T` | |
| `Lang` | `/Lang` | own language only |
| `EffectiveLang` | `/Lang` ↑ | walks ancestors, then catalog `/Lang` |
| `Alt` | `/Alt` | alternate description |
| `ActualText` | `/ActualText` | |
| `Expansion` | `/E` | abbreviation expansion |
| `ID` | `/ID` | element identifier |
| `Page` | `/Pg` | resolved to a `Page`, else `undefined` (falls back to MCR `/Pg`, then inherited) |
| `Parent` | `/P` | parent `StructElement` or `undefined` at the root |
| `Children` | `/K` | child **elements** only (integers / `MCR` / `OBJR` filtered out) |
| `ContentItems` | `/K` | raw marked-content refs (see below) |
| `Attributes` | `/A`, `/C` | raw attribute dicts + resolved class attributes; no deep parsing |
| `GetText()` | — | this element + descendants, reading order |
| `Dict`, `Ref` | — | live handle exposure |

`ContentItems` entries:

```ts
type ContentItem =
  | { kind: 'mcid'; page: Page; mcid: number }
  | { kind: 'objr'; page: Page | undefined; ref: PdfRef };
```

## MCID → text resolution (text.ts change)

In `walkScope`, maintain a marked-content stack:

- `BMC` / `BDC` → push the current context. When `BDC` carries `/MCID` (inline
  property dict, or a name resolved through the `/Properties` resource), set the
  active MCID to that value.
- `EMC` → pop.
- The **innermost** active MCID is attached to each emitted glyph.

Add `mcid?: number` to `GlyphEvent`. Additive; no behavior change for existing
callers (redaction, `GetText`, fragments).

`struct.ts` builds `Map<number /*mcid*/, GlyphEvent[]>` per page from a single
cached `visitContent` pass. `StructElement.GetText()` gathers glyphs for the
element's MCIDs in `/K` order, recursing into child elements in order (the
logical reading order), then runs the existing word/line assembly to produce
readable text.

## Standard types & edge cases

- A static set of the PDF 1.7 standard structure types (grouping, block-level,
  inline-level, illustration) backs `IsStandardType` and terminates RoleMap
  chains.
- Untagged document → `GetStructTree()` returns `null`.
- `/K` may be a single item, an array, or a dict — normalized to an array.
- Missing `/Pg`: fall back to the MCR's `/Pg`, then inherit from the nearest
  ancestor with `/Pg`.
- RoleMap cycles guarded (visited-set).
- `MCR` dicts (`/Type /MCR`) and `OBJR` dicts (`/Type /OBJR`) handled in `/K`.
- `/Lang` read as a string object.

## Testing (TDD)

New fixture builder `test/helpers/build-tagged-pdf.ts` produces a small tagged
document: `Document` → `H1` + `P` (with MCIDs into a page content stream), a
`Figure` with `/Alt` and an `OBJR`, a custom role mapped via `/RoleMap`,
catalog `/Lang`, and `/MarkInfo /Marked true`.

Tests (`test/struct.test.ts`):

- Tree shape (root children, nested children, `Children` excludes content items).
- RoleMap resolution (custom → standard; chain; cycle guard).
- `Lang` vs `EffectiveLang` inheritance (element → ancestor → catalog).
- `Alt` / `ActualText` / `Title` / `Expansion` accessors.
- `Page` association incl. MCR fallback.
- `ContentItems` (mcid + objr).
- MCID glyph correlation and `GetText()` reading order (element and whole-tree).
- `ParentTree` lookups (`ElementFor`, `ElementForObject`).
- Untagged document → `null`; `IsTagged` true/false; document `Lang`.

`npm run typecheck` and `npm test` must be green before close.

## Public API surface (summary)

```ts
// document.ts
GetStructTree(): StructTreeRoot | null;
get IsTagged(): boolean;
get Lang(): string | undefined;

// struct.ts
class StructTreeRoot { /* see above */ }
class StructElement { /* see above */ }
type ContentItem = /* see above */;
```

README "Features" + "Limitations" updated when landed.

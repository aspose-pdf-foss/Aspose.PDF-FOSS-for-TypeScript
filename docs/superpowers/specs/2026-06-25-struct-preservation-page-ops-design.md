# Structure preservation across page ops — design

**Date:** 2026-06-25
**Status:** Approved (design); plan pending
**Scope:** Second sub-project of the "Tagged PDF / accessibility" epic
(`aspose-pdf-foss-for-ts-pjx`, child `.2` / S2). Builds on the structure-tree
read model ([2026-06-25-struct-tree-read-model-design.md](2026-06-25-struct-tree-read-model-design.md)).

## Context

The read model parses `/StructTreeRoot` and resolves marked content, but every
page-copy operation still **drops** all structure. `defaultPrunePolicy()` in
[extractor.ts](../../../src/extractor.ts) lists `StructParents` in
`dropPageKeys`, and neither of the two copy paths touches `/StructTreeRoot`,
`/K`, `/ParentTree`, `/RoleMap`, or MCIDs. So Split/ExtractPages/Merge/Append
and AddPage/InsertPage all produce **untagged** output even from a tagged
source.

Two copy paths exist today, both routed through `defaultPrunePolicy()`:

- **`extractPage`** ([extractor.ts](../../../src/extractor.ts)) — BFS from one
  page, renumbering to a self-contained `1..k` graph. Used by `Split` (one
  single-page `Document` per page).
- **`importPages`** ([document.ts](../../../src/document.ts)) — deep-copy pages
  into an accumulator document, dedup shared objects, flatten inherited
  attributes. Used by `ExtractPages`, `InsertPages`, `Append`, `Merge`.
- **`importPage`** ([document.ts](../../../src/document.ts)) — single-page
  variant of the above, used by `AddPage` / `InsertPage(source)`.

The structure tree is a document-level object graph **outside** the page tree.
Pages link back to it through `/StructParents` (an integer key) →
`/ParentTree` (a number tree) → structure elements (indexed by MCID).
Annotations/XObjects link through `/StructParent` → `/ParentTree` → element
directly.

**Key simplifier:** all in-scope ops copy page content streams **verbatim**, so
MCIDs never change. The only remapping is `/StructParents` (the page→ParentTree
key), element `/Pg` page references, and object numbers. MCID renumbering is out
of scope (it would only arise from content rewriting, e.g. redaction, which is
not a copy op).

## Goals

1. Tagged output from tagged input across **all** copy ops: Split,
   ExtractPages, Merge, Append, InsertPages, AddPage, InsertPage(source).
2. **Automatic when tagged** — no API change required; untagged sources are
   unaffected. A `preserveStructure: false` opt-out restores today's behavior.
3. Correct pruning — drop structure branches whose content lands only on
   dropped pages; keep elements that span kept and dropped pages, retaining only
   surviving content.
4. Correct combining — merging tagged documents concatenates their trees under
   one `/StructTreeRoot` with non-colliding `/StructParents` keys and a unioned
   `/RoleMap`/`/ClassMap`.

## Non-goals (future sub-projects)

- Tagged-content authoring (`BDC`/`EMC` emission, `StructElement` write API) — S3.
- Deep attribute semantics (table/list layout) — S4.
- PDF/UA validation — S5.
- MCID renumbering / structure repair after content rewriting (redaction).
- Preserving `/StructParents` through `Reorder` (in-place reorder keeps the
  existing tree untouched; reorder does not copy pages, so structure already
  survives — no work needed, covered by a regression test only).

## Approach

A single post-pass, isolated in a new module
[structpreserve.ts](../../../src/structpreserve.ts), rebuilds the structure tree
on the output document after pages are installed. Each op records where its new
pages came from and hands that map to the post-pass. This keeps all structure
logic in one place and handles the extract direction (one source) and the merge
direction (many sources) uniformly.

Rejected alternatives:

- **Copy-whole-tree-then-prune** — deep-copy all of `/StructTreeRoot`, then
  delete dead elements. Reuses existing copy machinery but copies-then-deletes
  most of the tree for small extracts and still needs the page map.
- **Incremental build inside the page walk** — copy structure while BFS-ing each
  page. The tree has cross-page shared ancestors, so per-page building
  duplicates/tangles shared nodes.

## Module & entry point

New module `src/structpreserve.ts`. Internal API (not exported from
`index.ts` — invoked by the page ops):

```ts
export interface PageOrigin {
  /** Source document the page (and its structure) came from. */
  srcDoc: Document;
  /** Source page object number in srcDoc. */
  srcPageNum: number;
  /** Resulting page object number in outDoc. */
  newPageNum: number;
}

/** Rebuild/extend outDoc's structure tree from the structure of the newly
 *  copied pages described by `origins`. No-op when no source is tagged. */
export function preserveStructure(outDoc: Document, origins: PageOrigin[]): void;
```

`origins` describes **only the newly copied pages**, never the destination's
pre-existing pages (whose structure, if any, is already correct).

### Op wiring

Each op stops dropping `StructParents` and builds `origins`, then calls
`preserveStructure(outDoc, origins)` once after `syncPages`:

| Op | outDoc | origins |
|---|---|---|
| `Split` | new single-page doc (per page) | one origin (`this`, src page num, output page num) |
| `ExtractPages` | new empty doc | one per selected page, paired `leafNums[i]` ↔ `pages[i]` |
| `Append` / `InsertPages` / `Merge` | `this` (may be tagged) | one per copied page |
| `AddPage` / `InsertPage(source)` | `this` (may be tagged) | one origin |

`extractPage` and `importPages`/`importPage` change only to surface the
source-page identity alongside the object numbers they already return (no
behavioral change for existing callers, which ignore the extra field). The
`StructParents` removal moves out of `defaultPrunePolicy().dropPageKeys`; the
post-pass owns that key now (it reassigns it). To preserve current behavior for
non-copy consumers and the opt-out, the post-pass deletes any stale
`StructParents` it does not reassign.

## Preservation algorithm (per output doc)

`preserveStructure` groups `origins` by `srcDoc` and skips any source that is
not tagged (`srcDoc.IsTagged` false or `GetStructTree()` null). For the tagged
sources:

1. **Collect survivors.** For each surviving source page, read its
   `/StructParents` key and the source `/ParentTree` entry (an array indexed by
   MCID) to find the structure elements with content on that page. Also collect
   `OBJR`-referenced objects that survived (annotations kept by
   `sanitizeAnnots`) via their `/StructParent` key. These elements are the
   "seeds" to keep.

2. **Clone with ancestor closure.** For each seed, walk up its `/P` chain to the
   structure root, cloning each element into `outDoc` with a fresh object
   number. A `sourceElemNum → newElemNum` map (per `preserveStructure` call)
   dedups shared ancestors, so an element spanning two kept pages is cloned once
   and keeps both surviving children. Elements never reached (no surviving
   descendant content) are never cloned — this is the pruning.

3. **Rewrite cloned elements.**
   - `/P` → the cloned parent (or the structure root for top-level elements).
   - `/K` → kept child elements (in original order) plus surviving content items
     (`MCR`/integer MCIDs on kept pages, `OBJR` for surviving objects); content
     items on dropped pages are removed. A `/K` that becomes a single item is
     left as an array for simplicity (valid PDF).
   - `/Pg` → the new page object ref (resolved via the element's own `/Pg`, else
     its MCR `/Pg`, else nearest ancestor `/Pg` — the read model's rule).
   - All other refs (`/A`, `/C`, etc.) deep-copied with fresh numbers via the
     existing remap helpers. MCIDs are copied unchanged.

4. **Rebuild `/ParentTree`.** Allocate a fresh `/StructParents` key per new page
   (sequential from the current `/ParentTreeNextKey`, or 0 for a new tree), set
   it on the page dict, and build the number-tree entry: an array indexed by
   MCID whose slots point to the cloned element for that MCID (gaps allowed),
   plus direct entries for each surviving `OBJR` object's `/StructParent`. Set
   `/ParentTreeNextKey` to one past the highest key used.

5. **Install / extend `/StructTreeRoot`.**
   - **New tree** (outDoc untagged): create `/StructTreeRoot` with `/K` = cloned
     top-level elements, `/ParentTree` = the new number tree, copy `/RoleMap` and
     `/ClassMap`; set catalog `/StructTreeRoot` and `/MarkInfo /Marked true`.
   - **Existing tree** (outDoc already tagged — Append/Insert onto a tagged doc,
     or Merge of multiple tagged docs): append cloned top-level elements to the
     existing `/K`; the keys allocated in step 4 already start above the existing
     `/ParentTreeNextKey`, so they graft into the existing `/ParentTree` without
     collision; union `/RoleMap`/`/ClassMap` (see conflict rule below).

## Merge / RoleMap conflicts

When unioning `/RoleMap` into an existing tree and a custom role maps to a
**different** target in the source, the source's role name is renamed (suffixed
`_2`, `_3`, …) and every cloned element whose `/S` used that name is updated to
the new name, so semantics are preserved with no silent collision. Identical
mappings are merged silently. `/ClassMap` conflicts on identical keys with
different values are handled the same way (rename + update element `/C`).

## Edge cases & policy

- **Untagged source** → contributes no structure; output stays untagged unless
  another source is tagged. Mixed merge is fine: untagged pages simply have no
  `/StructParents`.
- **Page copied N times within one output doc** (`ExtractPages([1, 1])`) —
  structure attaches to the **first** occurrence; later duplicate copies are
  left untagged. The MCID→page binding is otherwise ambiguous (both copies share
  identical MCIDs). Documented limitation; a regression test pins the behavior.
- **OBJR / annotations** — an `OBJR` is kept only if its referenced annotation
  survived `sanitizeAnnots`; the annotation's `/StructParent` is reassigned and
  added to the new `/ParentTree`.
- **Missing `/Pg`** — resolved via MCR `/Pg`, then nearest ancestor `/Pg`
  (matches the read model).
- **RoleMap cycle** — already cycle-guarded by `ResolveRole`; cloning copies the
  raw `/RoleMap` verbatim, so no new guarding needed.
- **`/StructTreeRoot` present but empty / no `/ParentTree`** — treated as
  untagged for that source (no seeds found → nothing cloned).

## Opt-out

A uniform `preserveStructure?: boolean` (default `true`) on the ops that take an
options object:

- `SplitOptions.preserveStructure` (Split, and via it `splitPdfFile`).
- A new optional `ExtractPagesOptions` param on `ExtractPages`.
- A new optional options param on `Append` / `InsertPages` / `Merge`.

`AddPage` / `InsertPage(source)` preserve unconditionally when the source is
tagged — they are single-page document-building helpers whose signatures
(`AddPage(source?)`, `InsertPage(at, source?)`) take no options object, and an
untagged single-page add is an unusual need. Setting `preserveStructure: false`
on any of the multi-page ops reproduces today's drop-everything behavior.

## Testing (TDD)

Extend [build-tagged-pdf.ts](../../../test/helpers/build-tagged-pdf.ts) to
produce multi-page tagged fixtures: a `Document` root with a `Sect` spanning two
pages (each page carrying `P` elements with MCIDs into its own content stream), a
`Figure` with `/Alt` + an `OBJR` to a link annotation, a custom role mapped via
`/RoleMap`, and `/MarkInfo /Marked true`.

New `test/structpreserve.test.ts`:

- **Split** — each single-page output is tagged; `GetStructTree()` non-null;
  `/K` holds that page's slice; `GetText()` reading order matches the source
  page; `ElementFor(structParents, mcid)` resolves on the output.
- **ExtractPages subset** — dropped-page branches pruned; a `Sect` spanning a
  kept and a dropped page keeps only the surviving child; `/ParentTree`
  round-trips.
- **Merge / Append** — combined tree concatenates both sources' top-level `/K`;
  `/StructParents` keys do not collide (destination keys preserved, source keys
  offset above `/ParentTreeNextKey`); `/RoleMap` unioned, including the
  rename-on-conflict path; `GetText()` covers both documents in order.
- **OBJR** — surviving annotation's structure (`Figure`/`/Alt`) preserved and
  re-keyed; dropped annotation's `OBJR` removed.
- **Untagged + opt-out** — untagged source → untagged output; `Split({
  preserveStructure: false })` drops structure.
- **Reorder regression** — in-place `Reorder` leaves the existing structure tree
  intact and resolvable.

`npm run typecheck` and `npm test` must be green before close.

## Public API surface (summary)

```ts
// document.ts — behavioral change only (automatic when tagged); plus a uniform
// opt-out on the multi-page ops (default true):
interface SplitOptions { /* existing */ preserveStructure?: boolean; }
interface ExtractPagesOptions { preserveStructure?: boolean; }
// Append / InsertPages / Merge gain an optional options param with the same flag.

// structpreserve.ts (internal)
interface PageOrigin { srcDoc: Document; srcPageNum: number; newPageNum: number; }
function preserveStructure(outDoc: Document, origins: PageOrigin[]): void;
```

README "Features" + "Limitations" updated when landed (tagged structure now
survives split/extract/merge; note the repeated-page limitation).

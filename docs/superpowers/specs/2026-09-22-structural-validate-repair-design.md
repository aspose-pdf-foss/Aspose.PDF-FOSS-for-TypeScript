# Structural `Validate()` and `Repair()` — design

Issue: `dmin.4`. Related: `1lr9` (filed while designing this; out of scope).

## Problem

Recovery runs inside `Open` and reports through `doc.recovery`, but nothing
lets a caller ask a document — healthy or salvaged — whether its page tree is
sound, and nothing reconciles a salvaged tree before it is written back.

A probe before design found three things:

1. **Our own page edits write a tree that fails the checks below.** Every page
   edit (`RemovePage`, `InsertPage`, `Rearrange`, `Merge`, …) ends in
   `syncPages`, which flattens every page into the root's `/Kids` — but leaves
   each page's `/Parent` pointing at its old intermediate node. That node still
   lists the pages with its old `/Count`, and survives `Save()` because the
   pages reach it through `/Parent`. Inherited attributes still resolve through
   the stale chain, so the pages render correctly; every one of them has a
   `/Parent` that is not the node listing it. **Fixed here.**
2. A page listed twice (`/Kids [3 0 R 3 0 R]`) makes `Open` throw
   `cycle in page tree` with no recovery. Not a cycle — filed as `1lr9`, **not
   fixed here**. Consequence: `PageTreeShared` below can only fire on a
   document mutated after `Open`.
3. A salvaged `/Count 7` over one surviving page, with a `/Kids` entry naming a
   missing object, is written back by `Save()` exactly as read. This is what
   `Repair()` exists for.

## API

On `Document`:

- `Validate(): ValidationReport` — reuses `validation.ts`'s type, shared with
  `ValidatePdfA/UA/X`. It reads the RAW object graph from `/Root`, never
  `doc.Pages`, so a mutation through a page's live `Dict` after `Open` is
  visible. It never throws on a broken structure; the one throw is
  `ResourceLimitError` from the existing `maxNestingDepth` bound on tree depth.
- `Repair(): ValidationIssue[]` — returns the issues it FIXED, in `Validate()`'s
  shape; afterwards `Validate().Passed` is true. When nothing needed fixing it
  touches nothing and does NOT call `markModified()` — a no-op that marks the
  document modified silently turns a following sign-on-save into a full
  rewrite (`pagemode.ts` records the same trap). Otherwise it marks the
  document modified and rebuilds `Pages` and `pageObjNums` through
  `buildPages`.

## Rules

All `error` severity, one issue per offending node, `object` set to the node's
ref (absent for an inline node), `page` set where the node is a page.

| Rule | Checks |
|---|---|
| `CatalogInvalid` | `/Root` resolves to a dict with `/Type /Catalog`, and its `/Pages` resolves to a dict with `/Type /Pages` |
| `PageTreeShared` | a node reached a second time through `/Kids` |
| `PageCountMismatch` | on every intermediate node, `/Count` equals the number of pages actually found under it |
| `PageParentMismatch` | every kid's `/Parent` resolves to the node that lists it (compared by resolved-object identity) |
| `PageMediaBoxMissing` | a page with no `/MediaBox` on itself or on any ancestor along the tree path that reached it |

`CatalogInvalid` stops the walk; the other four are collected across the whole
tree.

Leaf versus intermediate is decided exactly as `buildPages` decides it:
`/Type /Page` is a leaf; else a node with a `/Kids` array is intermediate; else
a leaf. One rule, so `Validate()` and `doc.Pages` cannot disagree about which
nodes are pages.

**Two deliberate non-rules**, each asserted by a test so they stay decisions:

- **No cycle test on back-references.** A PDF object graph is not a tree, and
  `/Parent`, an annotation's `/P` and an outline's `/Prev` are required by the
  format. The walk follows `/Kids` only and guards against a genuine `/Kids`
  cycle by ANCESTOR set, which is what makes it terminate; a node reached twice
  without being its own ancestor is `PageTreeShared`, and one that IS its own
  ancestor is reported the same way and not descended into again.
- **A dangling reference is not a failure.** 7.3.10 makes a reference to an
  absent object null. A `/Kids` entry resolving to null contributes no page; the
  only thing that surfaces is the resulting `PageCountMismatch`.

## Repair

One walk over the tree, fixing in place — the file's tree SHAPE is preserved,
so a clean document is byte-identical and a balanced tree stays balanced:

- replace a second occurrence of any node with a shallow copy
  (`new Map(node)`, installed as a fresh indirect object), then descend into
  the copy — so a shared intermediate node yields copied children too, and a
  leaf copy shares its content streams and resources, as `Reorder` already
  does for a repeated page. A node that is its own ancestor is a genuine
  `/Kids` cycle and its back edge is dropped instead — copying it would never
  terminate;
- on a node whose `/Count` is wrong, set `/Count` to the recount AND drop the
  `/Kids` entries that do not resolve to a dict. Only there: a null kid is
  legal (7.3.10), so on a node `Validate()` passes it is left alone, which is
  what keeps a clean document byte-identical;
- set every kid's `/Parent` to a reference to the node listing it. A kid of an
  INLINE (direct) node cannot be given one — there is no reference to write —
  so that check is skipped for inline parents in both modes;
- write US Letter `[0 0 612 792]` as `/MediaBox` on a page with none on itself
  or its ancestors — the size `Page.MediaBox` already reports for it, so the
  written file agrees with what this library has been rendering.

`CatalogInvalid` is not repairable and is not returned by `Repair()`; it cannot
arise on a document `Open` produced, since recovery refuses a file with no
walkable catalog.

## Module

New **`pagecheck.ts`** beside `pagetree.ts`, holding one walk that both
`Validate` and `Repair` use — two walks is how a checker and a fixer come to
disagree about which nodes are pages. It imports `Document` as a TYPE only;
`document.ts` wires the two public methods and supplies allocation for copies.

## `syncPages` fix

Before `syncPages` writes the flat root `/Kids`, each listed page gets its
inherited `MediaBox`, `CropBox`, `Resources` and `Rotate` copied onto its own
dict when absent there (through the existing `inheritedValue`), and its
`/Parent` set to the root. The old intermediate nodes become unreachable and
`Save()`'s mark-sweep drops them. The root's own values are not copied down —
the pages still inherit them from the root, correctly.

**Amended while planning:** `syncPages` itself is too late for this. `Reorder`
points every page's `/Parent` at the root BEFORE it calls `syncPages`, so by
then the intermediate chain is already gone and a nested page's intermediate
`/MediaBox` is lost outright — a worse form of the same defect, and a live one.
So the step is a private `flattenToRoot()` run at the START of each edit that
re-lists this document's existing pages: `Reorder` (after its inline-object
checks) and `currentKids()` (which `InsertPage`, `InsertPages` and `RemovePage`
call before mutating). Imported pages need nothing — `importPages` already
flattens them and parents them to the root.

## Testing

- One hand-built broken fixture per rule, each with a `Repair()` case asserting
  the returned issues and that `Validate()` then passes.
- The two non-rules: a document full of back-references validates clean; a
  dangling non-`/Kids` reference validates clean.
- A sweep: `Validate().Passed` for every PDF under `test/fixtures/` except
  `corrupt/`, plus a representative set of `test/helpers/` builders.
- The probe's recovered case: after `Repair()` and `Save()`, the reopened root
  says `/Count 1` and lists one kid.
- The nested-tree `RemovePage` case: validates clean afterwards and keeps its
  inherited 100x100 `/MediaBox` across a save.
- `Repair()` on a clean document returns `[]`, leaves `Save()` byte-identical,
  and does not mark the document modified (asserted through the sign path: the
  base survives as a byte-identical prefix).
- Each rule and each repair step mutation-checked.

## Docs

README Key Capabilities / example / API rows; CHANGELOG `Added` (the two
methods) and `Fixed` (`syncPages`'s stale `/Parent`); CLAUDE.md Source entry for
`pagecheck.ts`.

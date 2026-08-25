# Outlines / bookmarks read + write — Design

Issue: `aspose-pdf-foss-for-ts-5oh` (P3, feature)

## Goal

Read and write the document outline tree (`/Catalog /Outlines`): traverse the
`/First`–`/Next`–`/Parent`–`/Last` linked structure into a nested model with
titles + destinations; allow building/replacing the outline and serializing it
back through `Save()`.

Destinations reference pages by object ref. Updating destinations on
`Reorder`/`Merge` is **out of scope** for v1.

### Acceptance criteria

- `GetOutlines()` returns a nested title/destination tree for a bookmarked PDF.
- `SetOutlines()` writes a valid `/Outlines` tree that round-trips through
  `Save()` and shows in a viewer.

## Public model (`src/outline.ts`)

```ts
export interface OutlineItem {
  Title: string;
  Dest?: OutlineDest;        // undefined = heading with no/unresolvable target
  Open?: boolean;            // expanded state; read-populated for parents, write default true
  Children?: OutlineItem[];  // omitted/empty = leaf
}

export interface OutlineDest {
  page: number;              // 1-based page number
  view?: OutlineView;        // default { type: 'Fit' }
}

export type OutlineView =
  | { type: 'XYZ'; left?: number | null; top?: number | null; zoom?: number | null }
  | { type: 'Fit' }
  | { type: 'FitH'; top?: number | null }
  | { type: 'FitV'; left?: number | null }
  | { type: 'FitR'; left: number; bottom: number; right: number; top: number }
  | { type: 'FitB' }
  | { type: 'FitBH'; top?: number | null }
  | { type: 'FitBV'; left?: number | null };
```

The union covers all eight PDF 32000-1 §12.3.2.2 destination syntaxes, so the
typed page+view model loses no information on read. `null` is a permitted
coordinate value in PDF destinations ("retain current value") and is preserved.

### Design decisions (from brainstorming)

1. **Destination = typed page number + view mode** (not raw page-number-only,
   not an opaque preserved array). Friendly and typed; full fidelity via the
   8-variant view union. Default view when omitted on write: `{ type: 'Fit' }`
   (no coordinates, viewer-safe).
2. **Read coverage = explicit `/Dest` + `/A` GoTo + named destinations**
   (`/Names /Dests` name-tree and legacy `/Dests` dict). Covers virtually all
   real-world bookmarked PDFs.
3. **Write API = symmetric plain data.** `SetOutlines(items: OutlineItem[])`
   takes the same nested shape `GetOutlines()` returns — read-modify-write
   round-trips naturally; no separate builder class. Mirrors the existing
   `GetMetadata`/`SetMetadata` symmetry.

## Architecture & module boundaries

Follows the **metadata pattern**: pure model + parse/build logic in
`src/outline.ts`; `Document` owns the two public methods and the only
graph-private bits (object allocation, page↔ref mapping, catalog mutation).
`src/outline.ts` does **not** touch the private `objects` map directly — it
receives an `alloc` closure and `pageRef`/`pageOf` callbacks.

### `src/outline.ts` (new, pure)

- The types above.
- `readOutlineTree(doc, rootDict, pageOf)` → `OutlineItem[]` — walks
  `/First`/`/Next`, cycle-guarded with a `Set<PdfDict>` (like `Form`).
- `parseDest(doc, destObj, pageOf)` → `OutlineDest | undefined` — handles a
  `/Dest` array, an `/A << /S /GoTo /D … >>` action array, and a named
  destination (`/Dest` or `/D` as string/name).
- `resolveNamedDest(doc, key)` → raw dest array | undefined — walks the
  `/Names /Dests` name-tree **and** the legacy catalog `/Dests` dict. A name
  object and a string key both resolve (legacy `/Dests` is keyed by name; the
  `/Names` tree by string).
- `decodeView(parts)` → `OutlineView` — maps the dest array tail (operator name
  + operands) to a typed view; unrecognized → `{ type: 'Fit' }`.
- `encodeDest(pageRef, view)` → `PdfObject[]` — typed view back to a PDF dest
  array `[pageRef /Name …operands]`.
- `buildOutlineObjects(items, ctx)` → root object number — builds one dict per
  item plus the `/Outlines` root, wiring
  `/Parent`/`/Prev`/`/Next`/`/First`/`/Last`/`/Count`/`/Title`/`/Dest`.
  `ctx = { alloc(obj) → num, pageRef(n) → PdfRef }`.

### `src/document.ts` (additions)

- `GetOutlines(): OutlineItem[]` — `/Outlines` absent → `[]`.
- `SetOutlines(items: OutlineItem[]): void`.
- Private helpers:
  - `pageNumberForObject(o): number | undefined` — resolve a dest page
    ref/dict to a 1-based number via the existing `pageObjNums`.
  - `pageRefForNumber(n): PdfRef` — 1-based number to page ref; throws
    `UnsupportedFeatureError` when that page is not an indirect object.
  - an `alloc(obj) → num` closure over `maxObjNum`/`objects`.
  - old-`/Outlines`-subtree deletion (walk `/First`/`/Next`, cycle-guarded).

### `src/index.ts`

Export the `OutlineItem`, `OutlineDest`, `OutlineView` types.

## Read flow

`GetOutlines()` resolves `catalog → /Outlines`; absent or non-dict → `[]`.
Otherwise `readOutlineTree` walks children from `/First` following `/Next`.
For each item:

- `/Title` decoded via `decodePdfText` (`''` when missing).
- Destination resolved by priority: `/Dest` first, else `/A` when it is a
  `/GoTo` action with a `/D`. Array values parsed directly; string/name values
  routed through `resolveNamedDest` then parsed. `pageOf` maps the dest's first
  element (page ref) to a 1-based number; an unresolvable page → `Dest` omitted
  (the title and children are still returned).
- `Open` set from the `/Count` sign for items that have children
  (`Count > 0` → `true`, `Count < 0` → `false`); omitted for leaves.
- `Children` populated by recursion; omitted when empty.

## Write flow

`SetOutlines(items)`:

1. **Validate the entire tree before any mutation** (a throw leaves the document
   unmodified, matching `Field` setters):
   - each `Title` is a `string`;
   - when `Dest` is present, `page` is an integer in `1..Pages.length`, the
     target page is an indirect object (else `UnsupportedFeatureError`), and the
     `view` (if present) has a recognized `type` with well-typed operands.
2. Delete the old `/Outlines` subtree from the live `objects` map (tidy;
   `Save()`'s mark-sweep would prune it regardless).
3. `items` empty → delete catalog `/Outlines` and return.
4. `buildOutlineObjects` allocates the `/Outlines` root + one dict per item,
   wires sibling (`/Prev`/`/Next`), parent (`/Parent`), and child
   (`/First`/`/Last`) links, and `/Count` (absolute = visible-descendant count,
   signed by `Open`, default expanded/positive). `/Title` via `encodePdfText`;
   `/Dest` via `encodeDest` (default `[pageRef /Fit]`). The root `/Count` is the
   positive count of visible items. Set catalog `/Outlines` to the root ref.

`Save()` serializes everything reachable from `/Root`, so no serializer change
is needed.

## Errors & edge cases

- `RangeError` — page number out of `1..Pages.length`, non-string title.
- `UnsupportedFeatureError` — a destination target page is not an indirect
  object (consistent with `Reorder`).
- Cycle-guarded read (malformed `/First`/`/Next`/`/Parent` loops terminate).
- `/Outlines` absent → `GetOutlines()` returns `[]`.
- `SetOutlines([])` clears the outline entirely.
- Items with no `Dest` are valid (a heading bookmark); written with no `/Dest`.

### Out of scope (v1)

- Remapping destinations on `Reorder`/`Merge`.
- Outline item styling: color (`/C`), text flags (`/F` bold/italic).
- Non-`GoTo` actions (`/GoToR`, `/URI`, …) — read yields `Dest: undefined`.

## Testing (TDD)

New fixture `test/helpers/build-outline-pdf.ts`: a multi-page classic-xref PDF
exercising nested items, an explicit `/Dest` array, an `/A` GoTo action, and a
named destination resolved through both `/Names /Dests` and the legacy `/Dests`
dict.

`test/outline.test.ts`:

- read returns the correct nested shape, titles, destinations, and `Open` flags;
- each destination form (explicit / GoTo / named via name-tree / named via
  legacy `/Dests`) resolves to the right page + view;
- an unresolvable / non-`GoTo` destination yields `Dest: undefined` with the
  title preserved;
- `SetOutlines` output round-trips: `Save()` → `Open()` → `GetOutlines()`
  reproduces the written tree;
- validation throws (bad page number, non-string title) leave the document
  unmodified;
- `SetOutlines([])` clears the outline;
- `GetOutlines()` on a PDF with no `/Outlines` returns `[]`.

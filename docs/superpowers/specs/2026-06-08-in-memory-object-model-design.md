# In-Memory PDF Object Model — Design

**Date:** 2026-06-08
**Status:** Approved (pending spec review)

## Goal

Replace the current file-backed (incremental-update) architecture with a full
in-memory PDF object model where all operations read and write the same live
data structures — no save/reload required to observe mutations.

`Open` eagerly parses the entire PDF into a `Map<number, PdfObject>`. Every
mutation (`Reorder`, `SetMetadata`, `ClearMetadata`, `Page.Rotate` setter, …)
writes directly into those live structures. `Save` serializes the live model to
bytes. There are no deferred patches and no second representation: reads and
writes go through the same map.

## Background: current architecture (being replaced)

- **Lazy file-backed parse.** `Document.Open` reads only the xref + trailer.
  Objects are materialized on demand by `getObject()` and memoized in a `cache`
  (plus an `objStmCache` for object streams).
- **Deferred mutation state.** Metadata edits live in `infoState` /
  `infoWork`; reorder sets a `pageOrderChanged` flag and reordered
  `Pages` / `pageObjNums` arrays. The live document is not actually mutated.
- **Three save paths.** `save()` either returns the original buffer unchanged,
  appends an incremental-update section (`incremental.ts`), or — for `Split`
  output in `built` mode — serializes a full object map via `writePdf`
  (`writer.ts`).
- **Detached `Page`.** `Page` wraps a *materialized copy* of its dict with
  inheritable attributes folded in; it is not connected to any live structure.

The overhaul promotes today's `built` mode to be the only mode.

## Decisions

These were settled during brainstorming:

1. **Public API is open to change.** Rename `save()` → `Save()` (consistent with
   the PascalCase `Open` / `Reorder` / `Split`), add `WriteTo(path)`. Existing
   tests are updated to match.
2. **`Page` is a live, mutable handle**, and this overhaul adds the **`Rotate`
   setter** now (MediaBox / CropBox setters deferred to a follow-up).
3. **Serialize reachable-from-Root only, with renumbering.** A mark-and-sweep
   from the trailer `/Root` (+ `/Info`) collects live objects; they are
   renumbered compactly `1..N` on output. Orphans (e.g. pages dropped by
   Reorder) are not written.
4. **Implementation approach A — big-bang core rewrite.** Replace the engine in
   place, delete the transitional/dead modules, build operation-by-operation
   with TDD. No parallel engine is kept.

A consequence of (3) and the single-representation model: a PDF that used object
streams / a compressed xref on input is re-emitted as plain objects with a
classic xref table, and object numbers change. Byte-for-byte preservation of the
input is explicitly **not** a goal.

## Architecture

`Document` owns one live object map and one live trailer, both fully populated
at `Open` time:

```ts
class Document {
  private objects: Map<number, PdfObject>;  // every indirect object, eagerly parsed
  private trailer: PdfDict;                  // live: /Root, /Info, /ID, /Size
  readonly Pages: Page[];                    // derived view, rebuilt from the live tree
}
```

After `Open`, there is exactly one representation. The lazy `cache`,
`objStmCache`, xref `entries`, and the `built` branch are gone. `getObject(num)`
is a plain `objects.get(num)` lookup; `resolve()` reads through the same map.

`Open` is one entry point that builds this state by parsing bytes. A second,
internal factory builds a `Document` directly from an in-memory
`(objects, trailer)` pair without any byte parsing — this is what `Split` uses to
produce its result documents. Both entry points converge on the same live
`objects` + `trailer` + `Pages` invariant.

### `Open` flow

1. `readXref(buf)` → entries + trailer (unchanged).
2. Reject encrypted PDFs (`trailer` has `/Encrypt`) with
   `UnsupportedFeatureError` (unchanged).
3. **Eager-parse every xref entry** into `objects`:
   - `offset` entries via `ObjectParser`;
   - object-stream entries via `decodeObjStm`. Objects contained in an object
     stream are hoisted to top-level entries in the map; the object stream
     object itself is dropped (its contents now live directly in the map).
4. Build `Pages` from the live page tree.

`OpenFile(path)` is unchanged: read bytes, delegate to `Open`.

## Live mutation model

Every mutation writes straight into the live `objects` map / `trailer`.

### Metadata

- `/Info` becomes a real live object. If the trailer has no `/Info` on `Open`,
  none is fabricated until first write.
- `SetMetadata(update)`: resolve (or lazily create) the live `/Info` dict, give
  it an object number in the map, ensure `trailer` references it, then
  `applyUpdate` mutates that dict in place.
- `ClearMetadata()`: delete `/Info` from the trailer and drop the dict from the
  map. Reachable-from-Root serialization then naturally omits it.
- `GetMetadata()` reads the live `/Info` directly, so a `SetMetadata` is
  observable immediately — no save/reload.

`metadata.ts` (`readMetadata` / `applyUpdate`) is unchanged; it now operates on
the live `/Info` dict.

### Reorder

`Reorder(order)` mutates the live page tree instead of deferring:

- Validation unchanged: `RangeError` on empty, non-integer, or out-of-range
  input.
- Rewrite the **root `/Pages` node's `/Kids`** to the new sequence of page refs
  and set `/Count`. Each kid's `/Parent` is set to the root.
- **Repeated pages** are cloned into fresh objects in the map immediately, so a
  duplicate is a genuine second live object.
- **Dropped pages** are simply not referenced; mark-and-sweep on `Save` removes
  them.
- `Pages` is rebuilt from the live tree so `doc.Pages` reflects the new order
  immediately.
- Requires an indirect root `/Pages` and indirect leaf pages; otherwise
  `UnsupportedFeatureError` (as today for the inline-`/Pages` case).

### Page.Rotate setter

```ts
set Rotate(deg: number) { this.dict.set('Rotate', normalize(deg)); }
```

Writes `/Rotate` into the page's own live dict. Because `Page` holds the live
dict, `page.Rotate = 90` is observable immediately via the getter and serializes
on `Save`. Writing to the page's own dict correctly overrides any inherited
value.

## Page as a live handle

`Page` references the real page dict from the object map rather than a detached
copy:

```ts
class Page {
  constructor(
    private readonly doc: Document,
    readonly Dict: PdfDict,   // the live dict from the objects map (not a copy)
    readonly Number: number,
  ) {}
}
```

### Dynamic inheritance

Inheritable keys (`Resources`, `MediaBox`, `CropBox`, `Rotate`) are resolved by
walking the `/Parent` chain at read time, via a small `inherited(key)` helper
that uses `doc.resolve` and a cycle guard:

- `MediaBox`: own dict → walk `/Parent` ancestors → US-Letter default.
- `CropBox`: own/inherited → falls back to `MediaBox`.
- `Rotate`, `Resources`: own → inherited.

Reads stay correct whether the attribute sits on the page or an ancestor
`/Pages` node, and they reflect live edits.

Existing getters (`Contents`, `Annotations`, `Rect`) are unchanged in behavior —
they already read through `doc.resolve` against the live dict.

### `buildPages` / `pagetree.ts`

`buildPages` still returns one `Page` per leaf in document order, but no longer
materializes copies: it records each leaf's live dict + object number, and the
inheritance walk moves into `Page`. `PageTree`'s `rootPagesNum` and
`pageObjNums` remain (Reorder needs the root and per-page object numbers). Inline
(non-indirect) leaf pages can be read but cannot participate in Reorder.

## Serialization & the `Save` API

A single serializer replaces all three current save paths.

### `Save(): Uint8Array`

1. **Mark.** BFS/DFS from `trailer` `/Root` (and `/Info` when present),
   following every ref through dicts, arrays, and stream dicts; collect the
   reachable object-number set.
2. **Renumber.** Assign compact sequential numbers `1..N` to reachable objects
   in a deterministic order (root first, then discovery order); build an
   old→new map.
3. **Rewrite & write.** Serialize each reachable object with its refs remapped to
   the new numbers, emit a classic `xref` table, and a trailer with `/Size`,
   `/Root`, `/Info` (when present), and **preserved `/ID`**. Streams keep their
   raw bytes; `/Length` is recomputed (as `serialize.ts` already does).

Ref remapping happens per-object at write time (a shallow walk producing rewritten
copies for serialization), so the live map is never mutated by `Save`: you can
save, mutate further, and save again. `Save` is idempotent across reopen
(reopening serialized bytes and saving again yields an equivalent document).

This subsumes `writer.ts`. `incremental.ts` is deleted.

### Public API

- `Document.Save(): Uint8Array` — primary serializer (PascalCase).
- `Document.WriteTo(path: string): void` — serialize and write to a file (sync,
  mirroring `OpenFile`).
- `Split(): Document[]` — unchanged signature; each result is an ordinary
  `Document` backed by its own live map (the extractor already yields a
  reachable, renumbered object set, which now seeds a normal `Document` rather
  than a special `built` one).
- Node file helpers in `node.ts` (`splitPdfFile`, `readMetadataFile`,
  `updateMetadataFile`, `clearMetadataFile`) keep their behavior, delegating to
  `Save` / `WriteTo`.

### Error handling

Same error types as today: `PdfParseError` for malformed structure (missing
`/Root`, non-dict catalog); `UnsupportedFeatureError` for encryption and for
reorder on inline pages.

## Module changes

| File | Change |
|------|--------|
| `document.ts` | Eager parse in `Open`; live `objects` + `trailer`; live metadata/reorder; `Save` / `WriteTo`; mark-sweep + renumber serializer; delete `built` mode, deferred state, lazy cache |
| `incremental.ts` | **Deleted** |
| `writer.ts` | **Deleted** (subsumed by the new serializer) |
| `page.ts` | Live dict reference; dynamic inheritance helper; `Rotate` setter |
| `pagetree.ts` | `buildPages` records live dicts + object numbers; no materialize-copy |
| `extractor.ts` | Logic unchanged; output now seeds an ordinary `Document` |
| `serialize.ts` | Unchanged; reused by the new serializer |
| `metadata.ts` | Unchanged; operates on the live `/Info` |
| `node.ts` | Behavior unchanged; delegates to `Save` / `WriteTo` |
| `index.ts` | Export `Save` / `WriteTo`; drop removed types |

## Testing strategy

TDD, operation by operation:

- **Liveness (core guarantee):** `SetMetadata` then `GetMetadata` without save;
  `page.Rotate = 90` then read `page.Rotate`; `Reorder` then read `Pages` — all
  observable with no save/reload.
- **Round-trip:** existing reorder / metadata / split round-trip tests keep
  passing (reopen serialized bytes, assert content), adapted to `Save()`.
- **Serializer:** reachable-only (a dropped page is absent from output);
  renumber produces a valid sequential xref; `/ID` preserved; second `Save`
  after reopen is stable.
- **Eager parse:** object-stream / xref-stream inputs fully materialize via
  `Open` (existing `objstm` / `xref-stream` tests still green).
- **Inheritance:** a page inheriting `MediaBox` / `Rotate` from an ancestor
  `/Pages` node reads correctly through the dynamic walk.
- Lower-level unit tests (`lexer`, `flate`, `predictor`, `object-parser`,
  `xref`) are untouched.

## Implementation sequence

1. Eager parse in `Open` (drop lazy cache / objStmCache / entries).
2. Live metadata (`/Info` in the map; `Set` / `Clear` / `Get`).
3. Live reorder (mutate `/Kids`, clone duplicates, drop via sweep).
4. Live `Page` + dynamic inheritance + `Rotate` setter.
5. Mark-sweep + renumber serializer; `Save` / `WriteTo`.
6. Delete `incremental.ts` and `writer.ts`; update `index.ts` exports.

## Out of scope

- `MediaBox` / `CropBox` (and other) page setters — follow-up.
- Encryption support.
- Byte-for-byte input preservation; object-stream / compressed-xref output.
- Object-graph deduplication beyond reachability (no structural sharing
  analysis).

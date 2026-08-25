# Linearization (Fast Web View) — design

**Date:** 2026-06-29
**Status:** Approved (design); plan pending
**Scope:** Add linearized ("Fast Web View") output as a `Save` option, per
ISO 32000-1 Annex F.

## Context

The library opens a PDF into an in-memory object model, lets callers mutate it,
and serializes a fresh, compactly-renumbered document on `Save`
([serializer.ts](../../../src/serializer.ts)). `serializeDocument` runs a
mark-sweep `planDocument` (renumber 1..N reachable from `/Root`+`/Info`), then
writes header → objects (recording offsets) → cross-reference → trailer. Three
variants share that `Plan`: classic xref table (default), compressed
(cross-reference stream + object streams, `Save({ compressed: true })`), and
encrypted forms of each.

The library can **read** linearized PDFs today — a linearized file is a
structurally valid PDF, and the parser uses the main cross-reference path and
ignores the `/Linearized` parameter dictionary and first-page xref. It cannot
**write** linearized output: `Save` always emits a non-linearized layout, so a
round-trip drops Fast Web View.

This sub-project adds linearized output. Linearization is a different *physical*
layout over the same object graph: a parameter dictionary first, the first
page's objects and a hint stream near the front, two chained cross-reference
sections, and hint tables that let a viewer render page 1 (and seek to any page)
before the whole file arrives.

## Goals

1. `Save({ linearized: true })` emits a conformant linearized PDF (classic xref,
   unencrypted) that `qpdf --check` reports as "File is linearized" with no
   warnings or errors.
2. A `Document.IsLinearized` getter reports whether an opened file is linearized.
3. An exported `verifyLinearization(bytes)` re-parses output and checks every
   offset/length/hint entry for byte-accuracy, used by the test suite as the
   automated stand-in for `qpdf --check`.

## Non-goals (future follow-ups)

- Compressed linearization (cross-reference streams + object streams + hint
  stream). `compressed: true` combined with `linearized: true` throws.
- Encrypted linearization (encrypted hint stream + objects). `encrypt` combined
  with `linearized: true` throws.
- Optional hint tables (thumbnail, outline, thread, named-destination,
  interactive-form). Only the two mandatory tables are emitted.
- Re-linearizing in place / incremental linearization. Linearization is a full
  rewrite, like every other `Save`.

## Approach

New module `src/linearize.ts` (kept out of the already-large `serializer.ts`).
`serializeDocument` routes to `serializeLinearized(objects, trailer, ver)` when
`options.linearized` is set, after rejecting the unsupported `compressed` /
`encrypt` combinations. The function reuses the existing `planDocument`
mark-sweep to get the reachable, renumbered graph, then re-partitions and
re-lays-it-out in Annex F order.

### Algorithm phases

1. **Partition** the planned objects into a *first-page set* and a *remainder*
   (see "Object partitioning").
2. **Renumber** so the first-page set occupies one contiguous object-number
   range and the remainder another, so each cross-reference section is a
   contiguous subsection (the simplest conformant layout).
3. **Serialize each object body** to bytes; lengths are then fixed and known.
4. **Lay out** in Annex F order, computing every byte offset:

   ```
   %PDF-x.y header
   {linearization parameter dictionary}      (obj)
   xref            <- first-page cross-reference section + trailer (/Prev = main xref)
   {first-page objects: catalog, page-tree root, page 1 + its closure}
   {primary hint stream}                      (obj, referenced by /H)
   {remainder objects}
   xref            <- main cross-reference section + trailer
   startxref <offset-of-first-page-xref>
   %%EOF
   ```

5. **Backfill** the computed numbers into fixed-width placeholders (see "Offset
   resolution").

Rejected alternative: extending `serializer.ts` in place. Linearization is large
and self-contained; a separate module keeps each file focused and testable.

Rejected alternative: a fixpoint iteration that re-serializes until offsets
stabilize. The fixed-width-placeholder approach is deterministic and single-pass
for backfill — simpler and what qpdf does.

## Object partitioning

- **First page** = the first leaf of the page tree: `/Root /Pages`, descend the
  first `/Kids` entry to the first `/Type /Page`. Resolved via the existing page
  tree helpers ([pagetree.ts](../../../src/pagetree.ts)).
- **First-page set** = the document catalog, the page-tree root node(s) on the
  path to the first page, the first page object, and the transitive closure of
  that page's `/Contents`, `/Resources`, and `/Annots` — plus the linearization
  parameter dictionary and the primary hint stream. `/Info`, outlines, and the
  closures of other pages go in the **remainder**.
- **Shared objects** = objects in the first-page closure that are also
  referenced from the remainder. These populate the shared-object hint table.

The partition is a reachability computation over the already-built `Plan` graph;
it adds no new traversal machinery beyond `refsIn` (already in `serializer.ts`,
to be shared or duplicated minimally into `linearize.ts`).

## Offset resolution & hint stream

**Chicken-and-egg.** The parameter dictionary (`/L` total length, `/H` hint
offset+length, `/O` first-page object number, `/E` end-of-first-page offset,
`/T` main-xref offset) and the hint tables encode byte positions that depend on
the file's own size, including their own. Solved with qpdf's technique: every
backfilled numeric field is written as a **fixed-width, zero-padded** token, so
filling in its value never shifts any later byte. One forward pass lays out the
bytes and records offsets; one backfill pass writes the computed values into the
reserved slots. (`/O` and `/N` are known before layout — object number and page
count — but are written through the same mechanism for uniformity.)

**Primary hint stream.** Per Annex F.3, two mandatory tables only:

- **Page-offset hint table** — per page: number of objects, page length in
  bytes, and offsets needed to locate each page's objects.
- **Shared-object hint table** — the objects shared between the first page and
  later pages, with their lengths, so a viewer reuses already-downloaded shared
  objects.

The hint stream is `FlateDecode`-compressed like the serializer's other streams
([flate.ts](../../../src/flate.ts)). Bit-level table encoding follows Annex F.3
exactly (the implementation plan specifies the field widths).

## Public API

```ts
// serializer.ts — SerializeOptions
interface SerializeOptions {
  compressed?: boolean;
  encrypt?: EncryptOptions;
  linearized?: boolean;   // NEW — classic-xref, plaintext only
}

// document.ts
get IsLinearized(): boolean;   // NEW — opened file starts with a /Linearized dict

// linearize.ts
function serializeLinearized(
  objects: Map<number, PdfObject>, trailer: PdfDict, ver?: string,
): Uint8Array;

interface LinearizationCheck { linearized: boolean; errors: string[]; }
function verifyLinearization(bytes: Uint8Array): LinearizationCheck;  // NEW (exported)
```

`Document.Save(options)` / `WriteTo` pass `linearized` straight through to
`serializeDocument`. `node.ts` file wrappers inherit it via the same options
object.

## Module boundaries

- `linearize.ts` — new; owns `serializeLinearized`, the partition/renumber/layout
  logic, the hint-stream builder, and `verifyLinearization`. Depends on
  `serialize.ts` (object→bytes), `pagetree.ts` (first-page resolution),
  `flate.ts` (hint compression), `types.ts`. No new runtime dependencies.
- `serializer.ts` — `SerializeOptions` gains `linearized`; `serializeDocument`
  routes to `serializeLinearized` and rejects unsupported combinations. May
  export `refsIn`/`planDocument` for reuse (or `linearize.ts` keeps a local copy
  if that keeps boundaries cleaner).
- `document.ts` — `IsLinearized` getter (reads the first object after the
  header); `Save` already forwards options.
- `index.ts` — export `verifyLinearization` and `LinearizationCheck`.

## Errors

- `compressed: true` + `linearized: true` → `UnsupportedFeatureError`
  ("compressed linearization is not supported").
- `encrypt` + `linearized: true` → `UnsupportedFeatureError`
  ("encrypted linearization is not supported").
- Document with no pages → `UnsupportedFeatureError`
  ("linearization requires at least one page").

## Testing (TDD)

Automated verification cannot depend on the `qpdf` binary (zero-dependency,
deterministic CI), so `verifyLinearization` is the in-suite gate; `qpdf --check`
is a documented manual/CI acceptance step.

Fixtures (built programmatically in `test/helpers/`): a single-page document, a
multi-page document, and a multi-page document with a resource (font/XObject)
shared across pages.

New `test/linearize.test.ts`:

- `Save({ linearized: true })` output re-opens with `Document.Open` and the
  object graph (page count, page text, catalog) is intact.
- `verifyLinearization(output).linearized === true` and `.errors` is empty for
  each fixture.
- `/Linearized` dict appears within the first 1024 bytes; `/L` equals the actual
  byte length; `/O` resolves to the first page object; `/T` equals the main-xref
  offset.
- The shared-resource fixture lists the shared object in the shared-object hint
  table (asserted via `verifyLinearization` internals or a re-parse helper).
- `Document.Open(linearizedOutput).IsLinearized === true`; a normal `Save()`
  output → `IsLinearized === false`.
- `Save({ linearized: true, compressed: true })` and
  `Save({ linearized: true, encrypt })` throw `UnsupportedFeatureError`.
- A no-page document → `UnsupportedFeatureError`.
- A negative `verifyLinearization` test: corrupt one offset byte in valid output
  and assert `.errors` is non-empty (the verifier actually catches drift).

`npm run typecheck` and `npm test` must both be green before close. The
implementation plan documents the manual `qpdf --check` acceptance run.

## Documentation

`README.md` "Features" gains a linearization bullet (`Save({ linearized: true })`,
`IsLinearized`, classic-xref/plaintext scope). "Limitations" notes that
compressed and encrypted linearization and the optional hint tables are not yet
supported, and that `qpdf --check` is the external conformance gate.

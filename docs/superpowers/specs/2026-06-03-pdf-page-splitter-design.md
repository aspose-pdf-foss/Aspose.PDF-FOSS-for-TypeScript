# PDF Page Splitter — Design

**Date:** 2026-06-03
**Status:** Approved
**Project:** `aspose-pdf-foss-for-ts`

## Goal

Provide a public API that reads a PDF file and produces one **self-contained,
single-page PDF per page** of the input. Implemented from scratch in TypeScript,
with **no PDF-library dependencies**.

"Self-contained" means each output PDF can be opened on its own and renders that
one page identically, embedding exactly the objects that page needs and nothing
that belongs to other pages.

## Scope

### In scope (input parsing)
- Classic cross-reference tables + trailer (PDF 1.0–1.4).
- Cross-reference streams and compressed object streams (`/ObjStm`), PDF 1.5+.
- Incremental updates (chained `/Prev`) and linearized ("web-optimized") files,
  including hybrid-reference `/XRefStm`.
- PNG/TIFF predictor reversal for FlateDecode (xref streams routinely use it).

### Out of scope (for this iteration)
- **Encrypted PDFs** (`/Encrypt` present) → throws `UnsupportedFeatureError`.
  Explicitly deferred; may be added later.
- **Full AcroForm / form-field fidelity** — see "Planned next" below. This
  iteration keeps page-level widget annotations but drops the document-level
  `/AcroForm` dictionary, so interactive form behavior is not preserved yet.
- Repair/recovery of structurally broken files beyond what the spec requires
  (a lenient "scan for `obj`" fallback is a possible future stretch goal).

### Planned next (design must not foreclose)
- **Form-field fidelity** is a known upcoming requirement. The extractor's
  pruning rules will be structured as explicit, overridable policy (not hardcoded
  branches) so a later pass can: carry the relevant subset of `/AcroForm`
  (`/DR` default resources, `/DA`, `/NeedAppearances`), reconstruct the field
  hierarchy for widgets present on the extracted page, and keep field/value
  linkage intact. Keeping pruning policy-driven now is the concrete design
  accommodation for this.

## Decisions

| Decision | Choice | Rationale |
|---|---|---|
| Runtime | Node.js | Target environment. |
| Decompression dependency | Node built-in `zlib` | Standard library, not a PDF dep. Used only for inflate. |
| API shape | Bytes in → bytes out core, thin Node file wrapper | Pure core, no fs coupling. |
| Stream payloads | Copied **verbatim** (filters preserved) | Lossless; no content/image re-encoding. |
| Output xref format | **Classic xref table + trailer** | Trivial/robust to write, universally supported. Valid in any PDF version. |
| Cross-page links | **Strip action, keep annotation** | Keeps the annotation rect + appearance; removes only the action/destination so it becomes a no-op. Most faithful to page appearance. |
| Test/build tooling | Vitest + `tsc` | Fast TS/ESM tests; tsc for type-check + build. |

## Public API

```ts
// Core — pure, no filesystem.
export function splitPdf(input: Uint8Array): Uint8Array[];

// Node convenience wrapper.
export function splitPdfFile(
  inputPath: string,
  outDir: string,
): Promise<string[]>; // returns written file paths, one per page

// Errors
export class PdfParseError extends Error {}        // malformed/truncated, with byte-offset context
export class UnsupportedFeatureError extends Error {} // e.g. encryption
```

`splitPdf` returns one `Uint8Array` per input page, in page order. Empty input or
a document with zero pages yields an empty array (no throw for zero pages; a
non-PDF/garbage input throws `PdfParseError`).

## Architecture

Layered, byte-oriented core. Node `zlib` is used **only** to inflate
cross-reference streams and object streams; content and image streams are copied
verbatim. A thin Node wrapper adds file-path convenience.

### Data flow
```
bytes
  → xref map        (objNum → offset | {objStm, index})
  → document        (lazy, cached object resolution; trailer + catalog)
  → [page dicts]    (in order, with inherited attributes materialized)
  → (per page) extractor set   (reachable, pruned object graph)
  → writer          (renumber → serialize → classic xref + trailer)
  → Uint8Array[]
```

### Modules (each independently testable)

1. **lexer** — bytes → PDF tokens: numbers, names, literal/hex strings,
   delimiters, and keywords (`obj endobj stream endstream R true false null`).
2. **object-parser** — tokens → `PdfObject` model: dict, array, name, number,
   string, bool, null, ref, stream.
3. **xref** — locate `startxref`; parse classic xref tables and xref streams;
   follow `/Prev` and hybrid `/XRefStm` chains. Produces
   `objNum → {offset} | {objStmNum, index}`. Includes PNG/TIFF predictor
   reversal for FlateDecode.
4. **objstm** — inflate an `/ObjStm` stream and index its packed objects by
   number.
5. **document** — `Document` with lazy, cached `getObject(ref)` resolving via
   the xref map (direct offset or object stream). Exposes trailer + catalog.
   Detects `/Encrypt` → `UnsupportedFeatureError`.
6. **pagetree** — walk the `Pages` tree in order, materializing inherited
   attributes (`Resources`, `MediaBox`, `CropBox`, `Rotate`) onto each page.
7. **extractor** — from a sanitized page dict, BFS over references collecting the
   reachable object set, with pruning. Pruning is expressed as an explicit,
   overridable policy object (not hardcoded branches) so future form-field
   support can extend it without rewrites. Default policy:
   - Drop `/Parent`, article-thread `/B`, and struct linkage (`/StructParents`,
     references into `/StructTreeRoot`).
   - Do **not** follow document-level trees (Outlines, Names, AcroForm root,
     StructTreeRoot) — they are not part of a single page.
   - Sanitize `Annots`: keep the annotation and its appearance; if its action is
     a same-document `GoTo` (or a named destination resolving to another page),
     **strip the `/A`/`/Dest`** so it becomes a no-op. `URI` and `GoToR` actions
     are kept untouched.
8. **writer** — assign new sequential object numbers; serialize dicts/arrays/
   streams (stream payloads verbatim, lengths/filters preserved); emit a fresh
   `Catalog` → single-page `Pages` → page, then a classic xref table + trailer.
   Output is a complete `Uint8Array`.
9. **splitPdf** (public API) — orchestrates parse → per-page extract → write →
   collect. Node wrapper `splitPdfFile` reads/writes paths.

## Error handling
- Malformed/truncated structure → `PdfParseError` carrying byte-offset context.
- Encrypted (`/Encrypt`) → `UnsupportedFeatureError`.
- Missing/dangling object references during traversal → resolved as `null` per
  the PDF spec, never a crash.

## Testing (TDD, Vitest)

- **Programmatic fixture builder**: generates deterministic PDFs in code for each
  variant — classic xref; xref-stream + object-stream; inherited page attributes;
  multi-page; annotations with cross-page links and with URI links. No opaque
  binary blobs committed.
- **Unit tests** per module: lexer tokenization, object parsing, classic + stream
  xref, predictor reversal, object-stream extraction, page-attribute inheritance,
  extractor pruning rules, writer round-trip.
- **Integration test**: split an N-page fixture → exactly N outputs; each output
  is **re-parsed by our own parser**, has exactly one page, preserves
  content/resources, and has cross-page links stripped while URI links survive.
- **Round-trip invariant**: every output of `splitPdf` must parse cleanly back
  through the same `document` layer.

## State tracking
Implementation milestones are tracked in **beads** (`bd`): one bead per module
(lexer, object-parser, xref, objstm, document, pagetree, extractor, writer,
public API) plus an integration/round-trip bead, wired with dependencies.

## Project scaffolding
- `package.json` (ESM, type: module), `tsconfig.json`, Vitest config.
- Source under `src/`, tests colocated or under `test/`.
- No runtime dependencies; `zlib` via Node built-in.

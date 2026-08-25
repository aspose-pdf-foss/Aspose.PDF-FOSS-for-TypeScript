# PDF Metadata — Node fs Wrappers — Design

**Issue:** aspose-pdf-foss-for-ts-30g
**Date:** 2026-06-04
**Status:** Approved
**Follows up:** aspose-pdf-foss-for-ts-w98 (in-memory metadata API; see
`docs/superpowers/specs/2026-06-04-pdf-metadata-design.md`)

## Goal

Provide thin async filesystem wrappers around the existing in-memory
`Document` metadata API so callers can read, update, and clear a PDF file's
`/Info` metadata by path, without manually wiring `readFile` →
`Document.open` → `getMetadata`/`setMetadata`/`clearMetadata`/`save` →
`writeFile` themselves.

These are convenience wrappers only. All metadata semantics (merge update,
incremental save, string/date encoding) live in the in-memory API and are
unchanged here.

## Scope

In scope:
- Three functions in `src/node.ts`, alongside the existing `splitPdfFile`:
  - `readMetadataFile(inputPath)` → `Promise<Metadata>`
  - `updateMetadataFile(inputPath, outputPath, update)` → `Promise<void>`
  - `clearMetadataFile(inputPath, outputPath)` → `Promise<void>`
- Export all three from `src/index.ts`.

Out of scope (not in this iteration):
- In-place editing as a *default* (no single-path overload). In-place is still
  achievable by passing the same path for both `inputPath` and `outputPath`.
- XMP `/Metadata` stream handling.
- Any new error types or error wrapping/translation.

## API

Add to `src/node.ts` (which already imports `readFile`/`writeFile` from
`node:fs/promises`):

```ts
import { Document } from './document.js';
import { Metadata, MetadataUpdate } from './metadata.js';

/** Read a PDF from disk and return its document metadata (/Info). */
export async function readMetadataFile(inputPath: string): Promise<Metadata>;

/**
 * Read a PDF, merge `update` into its metadata, and write the result to
 * `outputPath`. Merge semantics: undefined leaves a field unchanged, null
 * deletes it, a value sets it (see MetadataUpdate).
 */
export async function updateMetadataFile(
  inputPath: string,
  outputPath: string,
  update: MetadataUpdate,
): Promise<void>;

/** Read a PDF, remove all document metadata, and write the result to `outputPath`. */
export async function clearMetadataFile(
  inputPath: string,
  outputPath: string,
): Promise<void>;
```

### Decisions

| Decision | Choice | Rationale |
|---|---|---|
| Function set | read + update + clear (all three) | Mirrors the in-memory API surface. |
| Output path | Required separate positional arg | Mirrors `splitPdfFile(inputPath, outDir)` ordering; no hidden in-place behavior. |
| In-place editing | Pass the same path for input and output | Whole file is read into memory before write, so there is no read/write aliasing hazard. |
| `update` semantics | Merge (delegates to `setMetadata`) | Consistent with the in-memory API; partial updates preserve untouched fields. |
| Error handling | None added | `fs` errors (e.g. `ENOENT`) and `Document.open` errors (parse / `UnsupportedFeatureError` for encrypted) propagate naturally. |

## Behavior

Each wrapper is a direct composition over the in-memory API:

- **read** — `readFile(inputPath)` → `Document.open(bytes)` →
  return `doc.getMetadata()`.
- **update** — open as above → `doc.setMetadata(update)` →
  `writeFile(outputPath, doc.save())`.
- **clear** — open as above → `doc.clearMetadata()` →
  `writeFile(outputPath, doc.save())`.

`Document.open` takes a `Uint8Array`; wrap the `readFile` Buffer as
`new Uint8Array(await readFile(inputPath))`, matching `splitPdfFile`.

`save()` produces an incremental update (original bytes + appended `/Info`
revision), so output files are larger than the input by the appended revision;
re-opening the output reflects the changes via the `/Prev` chain.

## Exports

Add to `src/index.ts`:

```ts
export { readMetadataFile, updateMetadataFile, clearMetadataFile } from './node.js';
```

`Metadata` / `MetadataUpdate` types are already exported from the index.

## Testing (TDD, Vitest)

New file `test/node-metadata.test.ts`, following the temp-dir pattern of
`test/node.test.ts` (`mkdtempSync(join(tmpdir(), ...))`, cleaned up in
`afterAll` with `rmSync(..., { recursive: true, force: true })`).

Fixtures use the existing `buildClassicPdf(pageCount, { info })` helper, which
already supports an `/Info` dictionary.

Cases:
- **read** — write a fixture with known `/Info` values; `readMetadataFile`
  returns them (standard fields populated, custom fields in `custom`).
- **update merges** — fixture with several `/Info` fields; update one field;
  read the output back via `readMetadataFile` and assert the updated field
  changed *and* the untouched fields survived.
- **update deletes** — update a field to `null`; read back and assert it's gone
  while others remain.
- **clear** — `clearMetadataFile`; read the output back and assert metadata
  is empty (`custom: {}`, no standard fields).
- **in-place** — pass the same path for input and output on an update; read back
  and confirm the change persisted to that single file.

Clean up all temp files in `afterAll`.

## Implementation order

1. Write `test/node-metadata.test.ts` (failing).
2. Implement the three wrappers in `src/node.ts`.
3. Add exports to `src/index.ts`.
4. Type-check (`tsc`) and run the full Vitest suite.

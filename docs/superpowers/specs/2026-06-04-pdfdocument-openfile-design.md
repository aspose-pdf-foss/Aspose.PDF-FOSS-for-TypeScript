# Document.OpenFile — Design

**Issue:** aspose-pdf-foss-for-ts-by5
**Date:** 2026-06-04
**Status:** Approved

## Goal

Add a static `OpenFile` method to `Document` that opens a PDF from a file
path, mirroring the existing `Document.Open(bytes)` factory but accepting a
file name instead of a byte array.

## Scope

In scope:
- `Document.OpenFile(fileName: string): Document`, synchronous, reading the
  file via `fs.readFileSync` and delegating to `Document.Open`.

Out of scope:
- An async variant (`Promise<Document>`) — `OpenFile` is synchronous to mirror
  `Open` and Aspose's synchronous `Document(filename)` style.
- Any new parsing, validation, or error translation (all reused from `Open`).

## API

In `src/document.ts`:

```ts
import { readFileSync } from 'node:fs';

// static method on Document:
static OpenFile(fileName: string): Document {
  return Document.Open(new Uint8Array(readFileSync(fileName)));
}
```

`readFileSync` returns a Node `Buffer`; wrapping it as `new Uint8Array(...)`
matches how `splitPdfFile`/`readMetadataFile` adapt `readFile` results before
handing bytes to the core. `OpenFile` then delegates to `Open`, so the
`/Encrypt` → `UnsupportedFeatureError` check and all xref/trailer parsing are
reused with no duplication.

## Architecture note

`src/document.ts` is currently a pure core module with no filesystem dependency;
the fs layer lives in `src/node.ts`. Placing `OpenFile` on `Document`
necessarily introduces a `node:fs` import into the core. This coupling is the
deliberate consequence of the two design choices — the method lives on the class
and is synchronous — and is accepted.

## Error handling

None added:
- A missing or unreadable file propagates `readFileSync`'s error (e.g. `ENOENT`).
- A malformed or encrypted PDF propagates the same errors `Open` already throws
  (`PdfParseError`, `UnsupportedFeatureError`).

## Exports

`Document` is already exported from `src/index.ts`; `OpenFile` is reached
through it. No export change.

## Testing (TDD, Vitest)

Add to `test/document.test.ts`, using the temp-dir pattern from
`test/node.test.ts` (`mkdtempSync(join(tmpdir(), ...))`, cleaned up in `afterAll`
with `rmSync(..., { recursive: true, force: true })`):

- **Opens a file:** write `buildClassicPdf(2)` to a temp path, call
  `Document.OpenFile(path)`, assert `doc.Pages.length === 2` and the catalog
  resolves (`doc.catalog()` returns a dict).
- **Missing file throws:** `Document.OpenFile(<nonexistent path>)` throws.

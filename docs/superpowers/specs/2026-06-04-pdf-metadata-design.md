# PDF Metadata Processing — Design

**Issue:** aspose-pdf-foss-for-ts-w98
**Date:** 2026-06-04

## Goal

Add document-metadata support to `Document`: read, modify, and clear the
`/Info` dictionary (standard keys plus arbitrary custom fields), and persist
changes by writing a valid PDF via an incremental update.

## Scope

In scope:
- `getMetadata` / `setMetadata` / `clearMetadata` on `Document`, targeting the
  trailer `/Info` dictionary only.
- Custom (non-standard) `/Info` fields.
- `save(): Uint8Array` that emits the modified PDF using an incremental update.

Out of scope (possible follow-ups):
- XMP `/Metadata` stream synchronization.
- A Node `fs` wrapper to read/modify/write a file in one call.
- Full whole-document rewrite serializer.

## API

New module `src/metadata.ts`:

```ts
export interface Metadata {
  title?: string;
  author?: string;
  subject?: string;
  keywords?: string;
  creator?: string;
  producer?: string;
  creationDate?: Date | string;   // Date when parseable; raw string fallback
  modDate?: Date | string;
  custom: Record<string, string>; // all non-standard /Info keys
}

// merge-update shape: undefined = leave unchanged, null = delete, value = set
export interface MetadataUpdate {
  title?: string | null;
  author?: string | null;
  subject?: string | null;
  keywords?: string | null;
  creator?: string | null;
  producer?: string | null;
  creationDate?: Date | string | null;
  modDate?: Date | string | null;
  custom?: Record<string, string | null>;
}
```

Methods on `Document` (camelCase, matching `getObject`/`resolve`/`catalog`):

- `getMetadata(): Metadata` — read `/Info`; map the eight standard keys
  (`Title`, `Author`, `Subject`, `Keywords`, `Creator`, `Producer`,
  `CreationDate`, `ModDate`) to typed fields, parsing dates; route every other
  key into `custom`.
- `setMetadata(update: MetadataUpdate): void` — merge into an in-memory
  working copy of `/Info`. `undefined` leaves a field unchanged; `null` deletes
  the key; a value sets it.
- `clearMetadata(): void` — mark `/Info` for removal entirely.
- `save(): Uint8Array` — emit the PDF via incremental update. If nothing
  changed, return the original bytes verbatim.

The standard key ↔ field mapping is shared by read and write so the set of
"standard" keys is defined once.

## Mutation model

`Document` gains private state:

- `infoState: 'unchanged' | 'modified' | 'cleared'` (default `'unchanged'`)
- `infoWork?: PdfDict`

The first mutating call clones the existing `/Info` dict (or starts an empty
`Map` if absent) into `infoWork` and sets `infoState = 'modified'`.
`clearMetadata` sets `infoState = 'cleared'` and discards `infoWork`.
`getMetadata` reads from `infoWork` when present, otherwise from the file's
`/Info`. When `infoState === 'cleared'`, `getMetadata` returns an empty
metadata object (`custom: {}`). This preserves the document's lazy-parse design;
no other objects are materialized.

## Incremental-update writer (`src/incremental.ts`)

`save()` delegates to an incremental-update writer that appends to the original
bytes:

1. Ensure the appended content starts on a fresh line (add `\n` if the original
   does not end in a newline).
2. When `infoState === 'modified'`: serialize the working `/Info` dict as an
   indirect object. Its object number is the existing `/Info` ref's number
   (reused, with its existing generation) when `/Info` is an indirect
   reference, or `maxObjNum + 1` (generation 0) when `/Info` is absent or inline.
3. Write a new `xref` section listing only the changed object(s), using classic
   subsection syntax.
4. Write a new trailer that:
   - preserves the original `/Root`,
   - sets `/Info <num> 0 R` (modified) or omits `/Info` entirely (cleared),
   - sets `/Size` to `maxObjNum + 1`,
   - sets `/Prev` to the original `startxref` offset (read by scanning the file
     tail for the last `startxref`).
5. Append `startxref <offsetOfNewXref>` and `%%EOF`.

For `'cleared'`, no `/Info` object is written; the orphaned previous `/Info`
object is left in place (harmless and unreferenced).

`maxObjNum` is taken from the document's existing xref entry set.

### Serialization reuse

`serializeValue` / `serializeDict` / `serializeStream` / `serializeString` /
`escapeName` currently live privately in `src/writer.ts`. Extract them into a
shared `src/serialize.ts`; `writer.ts` and `incremental.ts` both import from it.
Pure refactor — no behavior change to the existing splitter writer.

## String & date encoding

**Strings (write):** if a value is pure ASCII (all code points < 128), encode
as Latin1 bytes. Otherwise encode as UTF-16BE with a leading `FE FF` BOM (the
PDF-standard representation for non-Latin text). The existing
`serializeString` (byte-oriented, octal-escaping) handles emission.

**Strings (read):** if the string's bytes begin with `FE FF`, decode as
UTF-16BE; otherwise decode as Latin1 (a practical approximation of
PDFDocEncoding for the common case).

**Dates (write):** format a `Date` as `D:YYYYMMDDHHmmSS+00'00'` (UTC). A raw
`string` value is written verbatim (already-formatted PDF date).

**Dates (read):** parse `D:YYYYMMDDHHmmSS` with an optional trailing `Z` or
`±HH'mm'` offset into a `Date`. If parsing fails, return the raw string so the
value round-trips losslessly.

## Testing (TDD)

Extend the `buildClassicPdf` test helper with an optional `/Info` dictionary
(indirect object) so fixtures can carry metadata.

Cases:
- `getMetadata` reads standard fields and custom fields; dates parse to `Date`.
- `setMetadata` merge updates one field and preserves the others.
- `setMetadata` with `null` deletes a field (standard and custom).
- `clearMetadata` empties metadata.
- `save()` round-trips: re-opening the output via `Document.open` reflects
  the changes.
- Incremental output: the original bytes are a prefix of the saved output, and
  the `/Prev` chain parses (xref.ts follows it).
- Non-ASCII value round-trips via UTF-16BE.
- `save()` with no changes returns the original bytes verbatim.

## Exports

Add to `src/index.ts`: `Metadata`, `MetadataUpdate` types. The methods are
reached through `Document`, which is constructed via `Document.open`.
(`Document` is not currently exported from the index; export it if not
already, so callers can reach the new methods.)

# Embedded Files / Attachments — Design

**Date:** 2026-06-26
**Status:** Approved, ready for implementation plan

## Goal

Add read/write support for embedded files (attachments) to the library:

1. **Document-level attachments** — files registered in the `/Root /Names
   /EmbeddedFiles` name tree, the case viewers show in an "attachments" panel.
2. **FileAttachment annotations** — a `FileAttachment` annotation placing a
   clickable icon on a page, whose `/FS` points at an embedded file.

Both share the same `/Filespec` → `/EF /F` → `/EmbeddedFile` stream plumbing.

## Non-goals

- Balanced name-tree rebalancing (a single flat node is written, matching the
  existing named-destination implementation).
- Collection / portfolio (`/Collection`) UI metadata beyond the basic `/AF`
  association array.
- Incremental update; attachments participate in the normal full-rewrite save.

## Architecture & module layout

A new feature module **`src/embeddedfile.ts`** holds all `/Filespec` ↔
`/EmbeddedFile` logic, shared by the document-level API and the annotation. This
keeps `document.ts` and `annotation.ts` as thin delegators, matching the
`outline.ts` / `form.ts` / `stamp.ts` structure.

```
embeddedfile.ts   ← new: build/read Filespec + EmbeddedFile stream, name-tree upsert/remove
document.ts       ← GetAttachments / AddAttachment / RemoveAttachment (delegate)
annotation.ts     ← FileAttachmentAnnotation class + addFileAttachment()
page.ts           ← Page.AddFileAttachment (delegate)
index.ts          ← export Attachment, AttachmentOptions, FileAttachmentOptions,
                    FileAttachmentAnnotation
```

### Reused without modification

- `collectNameTree` / `flatNameNode` (`outline.ts`) — generic over any
  `/Names`+`/Kids` tree; used for `/EmbeddedFiles` exactly as for `/Dests`.
- Stream object pattern `{ kind: 'stream', dict, raw }` + `allocObject`
  (`imageembed.ts`).
- `flate.ts` for FlateDecode compression; `node:crypto` for the MD5 `/CheckSum`.
- Mark-sweep save: a filespec reachable from `/Root /Names` or a page's
  `/Annots` is retained and renumbered automatically — **no serializer change**.

## Public API

```typescript
// Shared (embeddedfile.ts)
interface AttachmentOptions {
  mimeType?: string;        // → /Subtype as a PDF name, e.g. application/pdf
  description?: string;     // → /Desc
  compress?: boolean;       // default true (FlateDecode); false stores raw, no /Filter
  creationDate?: Date;      // default: now
  modDate?: Date;           // default: now
}

interface Attachment {
  Name: string;
  Description?: string;
  MimeType?: string;
  Size?: number;            // from /Params /Size (uncompressed length)
  CreationDate?: Date;
  ModDate?: Date;
  GetBytes(): Uint8Array;   // lazy: resolves /EF /F and inflates on demand
}

// Document-level (document.ts)
doc.GetAttachments(): Attachment[];                                       // sorted by Name
doc.AddAttachment(name: string, bytes: Uint8Array, opts?: AttachmentOptions): void;
doc.RemoveAttachment(name: string): boolean;                             // false if absent

// Annotation (page.ts)
interface FileAttachmentOptions extends AttachmentOptions {
  rect: [number, number, number, number];
  name: string;
  bytes: Uint8Array;
  icon?: 'PushPin' | 'Paperclip' | 'Graph' | 'Tag';  // default 'PushPin'
  addToCatalog?: boolean;   // default false; true also upserts into /Names /EmbeddedFiles
}
page.AddFileAttachment(opts: FileAttachmentOptions): FileAttachmentAnnotation;
```

`FileAttachmentAnnotation extends Annotation` with live accessors (`Icon`,
`FileName`, `Description`, `GetBytes()`), joining the existing Text / Stamp /
Markup / Link subclasses. The annotation-subtype reader gains a `FileAttachment`
case.

## Data flow & metadata

### Write (`buildFilespec(bytes, name, opts)`)

1. Optionally Flate-compress `bytes` (default on).
2. `/EmbeddedFile` stream:
   - body = compressed (or raw) bytes; `/Filter /FlateDecode` only when compressed.
   - `/Type /EmbeddedFile`, optional `/Subtype` (mimeType as a name).
   - `/Params << /Size <uncompressed length> /CheckSum <MD5 of UNCOMPRESSED bytes>
     /CreationDate (D:...) /ModDate (D:...) >>`. Dates default to now; overridable.
3. `/Filespec` dict: `/Type /Filespec`, `/F (name)`, `/UF (name)`, optional
   `/Desc`, `/EF << /F <stream ref> /UF <stream ref> >>`.
4. Document-level: upsert `name → filespec ref` into `/Names /EmbeddedFiles` via
   collect → merge → `flatNameNode` (single flat node, no rebalance — mirrors
   `SetNamedDestination`). Also add the filespec to a `/Root /AF` array
   (PDF 2.0 associated files).

### Read

Walk `/Names /EmbeddedFiles` (via `collectNameTree`), decode each `/Filespec`
into an `Attachment`. `Size`/dates/checksum come from `/Params`. `GetBytes()`
resolves `/EF /F` (falling back to `/EF /UF`) and inflates if `/Filter` present.

### Remove

Collect → delete entry → if `/EmbeddedFiles` empties, drop it; if `/Names`
empties, drop it (mirrors `RemoveNamedDestination`). Returns whether a removal
occurred.

### Annotation

`addFileAttachment(doc, page, opts)` builds a filespec via `buildFilespec`, then
an annotation dict `<< /Type /Annot /Subtype /FileAttachment /Rect [...]
/FS <filespec ref> /Name /PushPin /Contents (description?) >>`, appends to the
page `/Annots`, and returns a `FileAttachmentAnnotation`. When
`addToCatalog` is true, the **same** filespec ref is also upserted into
`/Names /EmbeddedFiles` (one file = one shared object).

## Error handling

- `AddAttachment` with an existing name → upsert (overwrite), consistent with
  named destinations.
- Empty `name` → `RangeError`.
- `GetBytes()` on a missing/malformed embedded stream → `PdfParseError`.
- `AddFileAttachment` without `rect`/`name`/`bytes` → `RangeError`.

## Testing

New fixture builder `test/helpers/build-attachment-pdf.ts` and
`test/embedded-files.test.ts`:

- Round-trip add → `Save` → `Open` → `GetBytes()` equals input, for both the
  compressed and `compress:false` paths.
- `/Params /Size` and MD5 `/CheckSum` correctness.
- `GetAttachments` listing order; `RemoveAttachment` returns true/false and
  collapses empty `/EmbeddedFiles` and `/Names` containers.
- Multiple attachments; merge into a PDF that already has an `/EmbeddedFiles`
  tree (no clobbering of existing entries).
- Annotation: `AddFileAttachment` → reopen → annotation present with
  `FileAttachment` subtype and the chosen icon; live accessors read back;
  `addToCatalog: true` also surfaces the file in `GetAttachments()`.

`npm run typecheck` and full `npm test` must be green before closing the issue.
`README.md` updated (Features list + API overview).

## Effort

Document-level attachments are mostly assembly of existing primitives; the
FileAttachment annotation adds roughly half again. Estimated ~1–1.5 focused
sessions including tests and README.

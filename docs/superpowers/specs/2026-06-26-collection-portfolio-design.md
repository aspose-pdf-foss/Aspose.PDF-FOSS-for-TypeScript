# Collection / Portfolio (`/Collection`) — Design

**Date:** 2026-06-26
**Status:** Approved, ready for implementation plan
**Builds on:** `2026-06-26-embedded-files-attachments-design.md` (shipped)

## Goal

Add read/write support for PDF portfolios — the `/Root /Collection` presentation
layer over embedded files. This declares *how a viewer displays* the attachments
we already write (`/Names /EmbeddedFiles`): a column schema, view mode, sort
order, an initial document, and per-file custom field values.

## Non-goals

- PDF 2.0 `/Folders` nested folder hierarchy (deferred to a separate feature).
- `/CollectionSubitem` authoring with `/P` prefixes (we read it back, but write
  values directly).
- Navigator / custom-view SWF presentation metadata.
- Thumbnails (`/Thumb` / `/CI` thumbnail images).

## Architecture & module layout

```
collection.ts    ← NEW: build/read the /Root /Collection catalog dict
embeddedfile.ts  ← Attachment becomes a live handle class; add /CI get/set
document.ts      ← GetCollection / SetCollection / RemoveCollection
index.ts         ← export Attachment (class), CollectionSettings, CollectionFieldDef, CollectionView
```

Responsibility split: **embeddedfile.ts** owns files and their per-file metadata
(`/CI` lives on the filespec); **collection.ts** owns only the presentation
catalog dict. `document.ts` imports both; neither module imports the other, so
there is no cycle.

The only change to existing (unreleased, same-session) code: the `Attachment`
read view becomes a live handle **class** over `(doc, filespecDict)`, and
`AddAttachment` returns it instead of `void`. The existing read accessors
(`Name`, `Description`, `MimeType`, `Size`, `CreationDate`, `ModDate`,
`GetBytes()`) keep identical behavior, so `test/embedded-files.test.ts` stays
green.

## Public API

```typescript
// embeddedfile.ts — Attachment is now a live handle class over (doc, fsDict)
export class Attachment {
  get Name(): string;
  get Description(): string | undefined;
  get MimeType(): string | undefined;
  get Size(): number | undefined;
  get CreationDate(): Date | undefined;
  get ModDate(): Date | undefined;
  GetBytes(): Uint8Array;
  /** Read a custom /CI field value. number→number; a /CollectionSubitem /D is
   *  unwrapped; a string is returned as a Date when it parses as a PDF date,
   *  otherwise as the string. */
  GetField(name: string): string | number | Date | undefined;
  /** Write a custom /CI field value (string→PDF string, number→PDF number,
   *  Date→PDF date string). */
  SetField(name: string, value: string | number | Date): void;
  /** Remove a custom /CI field value. */
  RemoveField(name: string): void;
}

// document.ts
doc.AddAttachment(name: string, bytes: Uint8Array, opts?: AttachmentOptions): Attachment; // was void
doc.GetAttachments(): Attachment[];        // now Attachment instances
doc.RemoveAttachment(name: string): boolean;

// collection.ts
export type CollectionView = 'details' | 'tile' | 'hidden';
export type CollectionFieldType =
  | 'filename' | 'description' | 'size' | 'compressedSize' | 'creationDate' | 'modDate' // built-in
  | 'string' | 'date' | 'number';                                                        // custom
export interface CollectionFieldDef {
  name: string;            // schema key (and /CI key for custom fields)
  type: CollectionFieldType;
  displayName: string;     // /N
  order?: number;          // /O column order
  visible?: boolean;       // /V (default true)
  editable?: boolean;      // /E (default false)
}
export interface CollectionSettings {
  fields: CollectionFieldDef[];
  view?: CollectionView;        // default 'details'
  sortBy?: string;              // field name to sort on
  sortAscending?: boolean;      // default true
  initialFile?: string;         // /D — name of the file shown first
}

// document.ts
doc.GetCollection(): CollectionSettings | undefined;
doc.SetCollection(settings: CollectionSettings): void;
doc.RemoveCollection(): boolean;             // false when no /Collection present
```

## Data flow & encoding

### Field-type ↔ /Subtype mapping

| `type`          | `/Subtype` | /CI value? |
|-----------------|-----------|------------|
| `filename`      | `F`            | no (from filespec) |
| `description`   | `Desc`         | no |
| `size`          | `Size`         | no |
| `compressedSize`| `CompressedSize`| no |
| `creationDate`  | `CreationDate` | no |
| `modDate`       | `ModDate`      | no |
| `string`        | `S`            | yes |
| `date`          | `D`            | yes |
| `number`        | `N`            | yes |

Built-in fields are derived by the viewer from the filespec/`/Params` we already
write, so they need no `/CI`. Only custom fields carry `/CI` values.

### Per-file /CI (CollectionItem)

`SetField(name, value)` upserts into the filespec's `/CI` dict
(`<< /Type /CollectionItem name → value >>`), inferring the PDF type from the JS
value: `string`→PDF string, `number`→PDF number, `Date`→PDF date string. Values
are written directly (no `/CollectionSubitem` wrapper).

`GetField(name)` reads back: a number returns a number; a `/CollectionSubitem`
dict is unwrapped to its `/D`; a string is returned as a `Date` when
`parsePdfDate` recognizes a `D:` date, otherwise as the raw string.
`RemoveField` deletes the key (and drops `/CI` when it empties).

### Catalog /Collection dict

`buildCollection(settings, alloc)` →
`<< /Type /Collection /View <name> /Schema <dict> /Sort <dict> /D (initialFile) >>`:

- `/View`: `details`→`/D`, `tile`→`/T`, `hidden`→`/H` (default `details`).
- `/Schema`: dict keyed by `field.name` → `/CollectionField`
  `<< /Type /CollectionField /Subtype <mapped> /N (displayName) /O <order> /V <visible> /E <editable> >>`
  (`/O` only when provided; `/V` default true; `/E` default false).
- `/Sort`: `<< /Type /CollectionSort /S /<sortBy> /A <sortAscending> >>` (single
  field; omitted when `sortBy` absent).
- `/D`: the `initialFile` name (omitted when absent).

`readCollection(doc)` reverses this into `CollectionSettings`. An unknown
`/Subtype` maps to a best-effort `type` (`string`) and the field is preserved.

## Error handling

- `SetCollection`: every field must have a non-empty `name` and `displayName`
  and a known `type`, else `TypeError`. `sortBy` referencing a field not in
  `fields`, or `initialFile` that is empty, throws `RangeError`.
- `SetField`: a value that is not string/number/Date throws `TypeError`; empty
  `name` throws `RangeError`.
- `GetCollection` returns `undefined` when `/Root /Collection` is absent or not
  a dict.

## Testing

`test/portfolio.test.ts`:

- Round-trip `SetCollection` → `Save` → `Open` → `GetCollection`: schema fields
  (order/visible/editable), view mode, sort field + direction, initial file.
- Custom field `SetField`/`GetField` for string, number, and Date through
  `Save`/`Open`; `RemoveField`.
- Built-in-only schema produces no `/CI` on the filespecs.
- `RemoveCollection` returns true/false and drops `/Root /Collection`.
- Validation: unknown field type, `sortBy` referencing an absent field, and a
  non-string/number/Date `SetField` value all throw.
- `AddAttachment` returns a usable handle (set a field on the return value,
  reopen, read it back).

Existing `test/embedded-files.test.ts` must stay green after the `Attachment`
class refactor. `npm run typecheck` + full `npm test` green before close.
`README.md` updated (Features + portfolio usage + API table).

## Effort

~1 session. No new binary/stream work — catalog dictionary assembly plus a
small `/CI` extension on the existing attachment path, and a contained refactor
of `Attachment` into a live handle class.

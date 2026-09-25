# /Info ↔ XMP synchronisation and typed XMP reads (o6uu.4)

Issue: `aspose-pdf-foss-for-ts-o6uu.4`, epic `o6uu` (XMP as a data model).

## Goal

1. A public `doc.SyncMetadata(direction)` that makes the document information
   dictionary and the XMP packet agree on the eight mapped fields.
2. `D:` dates convert to and from ISO-8601 text without drift.
3. Read-only typed accessors over the XMP data model (`doc.GetXmpValue`).

Writing typed values (`SetXmpValue`) is OUT of scope and filed as its own issue.

## Decisions taken in brainstorming

- **Exact mirror.** A field absent on the source side is DELETED on the target
  side, so the two sides are literally identical afterwards (acceptance: "agree").
- **The existing mirrors are fixed too.** `SetMetadata`/`SetXmp` currently copy
  a string date verbatim, putting `D:…` text into `xmp:CreateDate` and ISO text
  into `/CreationDate`. Both route a *string* date through the converter.
- **Typed accessors are read-only now**; the write half is a follow-up.

## Field map

| /Info key | XMP property | Canonical comparison |
|---|---|---|
| Title | `dc:title` (Alt, `x-default` item only) | text |
| Author | `dc:creator` (Seq) | items joined with `", "`; /Info split on `,` |
| Subject | `dc:description` (Alt, `x-default` only) | text |
| Keywords | `pdf:Keywords` | text |
| Creator | `xmp:CreatorTool` | text |
| Producer | `pdf:Producer` | text |
| CreationDate | `xmp:CreateDate` | converted date text |
| ModDate | `xmp:ModifyDate` | converted date text |

Other languages of an Alt are never touched (o6uu.3's rule). An author whose
name contains a comma splits wrongly; recorded as a limit, as it already is for
the mirrors.

## 1. `src/pdfdate.ts` — text-to-text date conversion

A leaf importing nothing.

- `pdfDateToIso(s: string): string | undefined`
- `isoToPdfDate(s: string): string | undefined`

Neither goes through a JS `Date`, which loses the offset. Both return
`undefined` for input they cannot read; neither throws.

Mapping (PDF 32000-1 7.9.4 ↔ XMP / W3C-DTF):

| `D:` | ISO |
|---|---|
| `D:2024` | `2024` |
| `D:202406` | `2024-06` |
| `D:20240603` | `2024-06-03` |
| `D:2024060312` | `2024-06-03T12:00` (ISO needs minutes) |
| `D:202406031230` | `2024-06-03T12:30` |
| `D:20240603123045` | `2024-06-03T12:30:45` |
| `…Z` | `…Z` |
| `…+02'00'` / `…+02'00` / `…+02` | `…+02:00` |
| `…-05'30'` | `…-05:30` |

The reverse emits `+HH'mm'` (the style `formatPdfDate` already writes) and
`Z` for `Z`. ISO fractional seconds are DROPPED on the way to `D:`, since PDF
dates have no fractions — documented. A TZD with no time (legal in neither
grammar) is refused. Field ranges are checked (month 1–12, day 1–31, hour
0–23, minute/second 0–59, offset hours 0–23).

Acceptance: `isoToPdfDate(pdfDateToIso(d)) === d` for every full-form `D:`
string (to seconds, with `Z` or `+HH'mm'`).

## 2. Mirror fix (`src/xmp.ts`)

`mirrorMetaToXmp` converts a *string* `creationDate`/`modDate` with
`pdfDateToIso`; `mirrorXmpToMeta` converts a string `createDate`/`modifyDate`
with `isoToPdfDate`. A string that does not parse passes through unchanged (as
today). A `Date` object is untouched and formatted exactly as before, so every
caller passing `Date` is byte-identical. CHANGELOG **Fixed**.

## 3. `SyncMetadata` (`src/metasync.ts`)

```ts
type MetadataField = 'title' | 'author' | 'subject' | 'keywords'
  | 'creator' | 'producer' | 'creationDate' | 'modDate';
interface MetadataSyncReport { changed: MetadataField[]; skipped: MetadataField[] }
doc.SyncMetadata(direction: 'infoToXmp' | 'xmpToInfo'): MetadataSyncReport
```

- Reads RAW text on both sides: the /Info strings through `decodePdfText`
  (not `GetMetadata()`, whose `Date` loses the offset), and the XMP side from
  the `parseRdfPacket` model (x-default item of an Alt, items of `dc:creator`,
  simple values otherwise).
- Canonicalizes the source value into the target's syntax and compares it
  with the target's current text. Equal → nothing is written.
- Absent on source, present on target → deleted on target.
- A source DATE that does not parse → target left alone, field named in
  `skipped`. Deleting it or copying the garbage are both worse.
- `infoToXmp` writes through `editXmpPacket` (foreign schemas survive, o6uu.3)
  and NEVER creates /Info. With no packet and nothing to write, no packet is
  created.
- `xmpToInfo` writes through `applyUpdate` and creates /Info only when it has
  a value to write.
- The document is marked modified ONLY when something changed. A no-op sync
  must leave a later `Sign()` on its incremental path; pinned through the sign
  path, since a save cannot see it.
- `direction` other than the two strings → `RangeError`, before any work.
- The XMP packet is parsed with `doc.loadLimits`, not the defaults.
- `changed` and `skipped` list fields in the table's order.

The module takes the document as a TYPE only and exposes the pure planning
step (`planSync(infoText, xmpText, direction)`) so the comparison rules are
testable from plain records.

## 4. Typed reads (`src/xmpvalue.ts`)

```ts
doc.GetXmpValue(namespaceUri: string, name: string): XmpValue | undefined
class XmpValue {
  readonly raw: RdfValue;
  asText(lang?: string): string | undefined;
  asDate(): { iso: string; date: Date } | undefined;
  asBool(): boolean | undefined;
  asInt(): number | undefined;
  asReal(): number | undefined;
  asUri(): string | undefined;
  asArray(): XmpValue[] | undefined;
}
```

- A leaf over `xmprdf.ts` types and `langmatch.ts`.
- Top-level properties only; `undefined` when the property is absent or there
  is no packet.
- `asText()`: a simple (non-URI) value's text; for an Alt, the best item for
  `lang` by RFC 4647 extended filtering (`langMatches`), else `x-default`,
  else the first item. Undefined for a struct or Seq/Bag.
- `asDate()`: ISO grammar check through `isoToPdfDate`'s parser; `date` built
  from the ISO text.
- `asBool()`: `True`/`False`, case-insensitive (XMP spells them capitalised).
- `asInt()`: `/^[+-]?\d+$/`, safe integers only. `asReal()`: decimal grammar
  `/^[+-]?(\d+\.?\d*|\.\d+)$/` — no exponent, no `NaN`/`Infinity`.
- `asUri()`: only a value parsed from `rdf:resource`.
- `asArray()`: items of Seq/Bag/Alt wrapped as `XmpValue`.
- Every converter is lenient: `undefined`, never a throw.

## Testing

- `pdfdate`: round-trip table over every precision, `Z`, ± offsets, the
  three offset spellings; malformed and out-of-range input; fraction drop.
- Mirrors: string dates converted both ways; `Date` path byte-identical.
- Sync: both directions, delete-on-absent, no-op on agreement (no
  `markModified` — asserted through the sign path), `skipped` for a bad date,
  foreign schema survives, no /Info created by `infoToXmp`, `RangeError`.
- PDF/A integration: `ConvertToPdfA`, then change /Info behind the mirror,
  `SyncMetadata('infoToXmp')`, `ValidatePdfA` passes the consistency rule.
- `XmpValue`: every converter over hand-built RDF, including language
  selection and the strict number grammar.
- A mutation pass over each rule, recorded in CLAUDE.md.

## Docs

README (example + API Reference rows — `test/readme-api.test.ts` enforces
them), CLAUDE.md module entries for `pdfdate.ts`, `metasync.ts`,
`xmpvalue.ts`, CHANGELOG **Added** (sync, typed reads) and **Fixed** (mirror
dates).

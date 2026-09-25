# Typed XMP writes: `doc.SetXmpValue` (o6uu.8)

Issue: `aspose-pdf-foss-for-ts-o6uu.8`, epic `o6uu` (XMP as a data model). The
write half of `o6uu.4`'s read-only `GetXmpValue`.

## Decisions taken in brainstorming

- **The eight /Info-mirrored properties are written AND mirrored**, as `SetXmp`
  mirrors. This is also the only way to write title/description translations,
  since `SetXmp` writes `x-default` alone.
- **Input shape: plain values for scalars, tagged objects for the rest.**
- **Structs are writable** (`{ struct: [...] }`).

## API — `src/xmpwrite.ts`

```ts
export type XmpValueInput =
  | string | number | boolean | Date
  | { seq: XmpValueInput[] } | { bag: XmpValueInput[] } | { alt: XmpValueInput[] }
  | { lang: Record<string, string> }
  | { uri: string }
  | { struct: { namespace: string; name: string; value: XmpValueInput }[] };

export interface XmpWriteOptions { prefix?: string }

doc.SetXmpValue(namespaceUri: string, name: string, value: XmpValueInput | null, opts?: XmpWriteOptions): void
```

`null` deletes the property (the `SetXmp`/`SetMetadata` convention); deleting an
absent property changes nothing and marks nothing modified.

`src/xmpwrite.ts` is a leaf over `xmprdf.ts` types: `checkXmpWrite(ns, name,
value, opts)` validates, `toRdfValue(value)` converts.

| Input | Model (`RdfValue`) | Read back through |
|---|---|---|
| `string` | simple | `asText()` |
| `number` (finite) | simple, `String(n)` | `asInt()` / `asReal()` |
| `boolean` | simple `True` / `False` | `asBool()` |
| `Date` | simple, `toISOString()` (what `SetXmp` writes) | `asDate()` |
| `{ seq \| bag \| alt: [...] }` | array of that form, items converted recursively | `asArray()` |
| `{ lang: { tag: text } }` | Alt whose items carry `lang`; `x-default` FIRST (o6uu.3's order) | `asText(lang)` |
| `{ uri }` | simple with `uri: true` (`rdf:resource`) | `asUri()` |
| `{ struct: [{ namespace, name, value }] }` | struct of fields | `raw` |

## Validation — before anything is written

A rejected call leaves the document byte-identical (`formcreate.ts`'s rule).

- `TypeError` — the wrong KIND of thing: an empty namespace, the RDF or XML
  namespace, a name or prefix that is not an XML NCName, a value that is none
  of the shapes above (including a tagged object with zero or several tags), a
  non-finite number, an invalid `Date`, a struct field with a bad namespace or
  name, an empty `lang` map.
- `RangeError` — a prefix reserved for a DIFFERENT namespace: `rdf`, `x`,
  `xml`, `xmlns`, and the built-ins `dc`, `xmp`, `pdf`, `pdfaid`, `pdfuaid`,
  `pdfxid` (writing `dc:` properties under `dc` is of course fine).
- No type enforcement against the predefined schemas — value-type checking is
  `o6uu.10`, and a second, divergent answer here would be worse than none.
- Characters XML cannot carry are stripped (`writeXmpPacket`'s existing
  `sanitize`), as for every other write.

## Prefix

`opts.prefix` wins, including over a foreign namespace that already holds it
(`o6uu.7`'s rule for `custom`). Without it the packet's existing binding stands,
else the serializer's well-known prefix, else `nsN`.

## The eight mirrored properties

`dc:title`, `dc:creator`, `dc:description`, `pdf:Keywords`, `xmp:CreatorTool`,
`pdf:Producer`, `xmp:CreateDate`, `xmp:ModifyDate`.

After the edit, /Info is set from what the NEW packet says for that field,
through `metasync.ts`'s own readers (`xmpSide`) and `planSync(…, 'xmpToInfo')`
restricted to the one field — so `SetXmpValue` and `SyncMetadata` cannot
disagree about a mirror: the x-default title, creators joined with `", "`,
dates converted to `D:` text. Two differences from the sync, both because the
caller has just asked for this value:

- a value `xmpSide` reads as unreadable (`null`, e.g. a struct written to
  `dc:title`) DELETES the /Info key rather than being skipped — leaving it
  would keep /Info describing a value the packet no longer holds;
- a date that does not convert likewise deletes the key.

A non-mirrored property never touches /Info.

**All-or-nothing:** the XMP text is computed first (the only step that can
throw, e.g. a packet past the document's limits), then /Info, then the packet
is installed — `SetMetadata`'s order since `o6uu.7`.

## Plumbing

`xmp.ts` gains `editXmpPacketWith(existing, edit: (p: RdfPacket) => void,
limits)`, sharing `startModel` and `writeXmpPacket` with `editXmpPacket`: one
edit path, not two. `Document` parses under its own `loadLimits`.

## Testing

- Each input shape round-trips through `GetXmpValue`, including a struct's
  `raw` and a `lang` map's `asText(tag)`.
- Each refusal throws the stated error and leaves `Save()` bytes identical.
- `null` deletes; deleting an absent property is a no-op.
- Prefix: the caller's wins over a foreign holder; absent, the packet's own
  binding stands.
- Each of the eight mirrored properties updates /Info; a struct to `dc:title`
  deletes `/Title`; a non-mirrored property leaves /Info alone.
- All-or-nothing on a `ResourceLimitError`.
- Everything the write does not name survives (History, other languages).
- Mutation sweep, recorded in CLAUDE.md.

## Docs

README: an example in the XMP section, API Reference rows for
`doc.SetXmpValue`, `XmpValueInput`, `XmpWriteOptions`; the Limitations bullet
"XMP typed writes are not available" is replaced. CHANGELOG **Added**.
CLAUDE.md: a `xmpwrite.ts` entry.

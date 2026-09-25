# Preserve unknown XMP through SetXmp (`o6uu.3`)

Epic `o6uu`. Builds on `src/xmprdf.ts` (`o6uu.1` model, `o6uu.2` qualifiers and
URI values).

## Problem

`installXmp` (`src/document.ts`) rebuilds the whole packet from the fifteen
fields of `XmpMetadata` through `buildXmp`'s string template. Anything else in
the packet is dropped on every write:

- `xmpMM:History`, `DerivedFrom`, and qualified identifiers;
- non-literal custom properties;
- PDF/A extension-schema descriptions (`pdfaExtension:schemas`);
- language alternatives other than `x-default`.

`SetXmp`, `SetMetadata` and the PDF/A, UA and X converters all write through
`installXmp`.

## Findings

- **The validators read both forms.** Every reader of the identification
  properties accepts element form as well as attribute form: `pdfaIdValue`,
  `pdfxvalidate.ts`'s `xmpVersion`, and `readXmp`'s `idValue`. A canonical,
  element-form packet validates exactly as the current attribute-form one.
- **Our validator cannot see the loss.** `ValidatePdfA` has no
  extension-schema rule (ISO 19005-2 §6.6.2.3), so it passes whether or not the
  description survives. By the maintainer's decision this issue asserts that the
  description survives. The rule is filed separately.

## Decisions

### One writer: edit the parsed model

`src/xmp.ts` gains:

```ts
export function editXmpPacket(existing: Uint8Array | undefined, update: XmpUpdate): string | undefined;
```

It returns the serialized packet, or `undefined` when there was no packet and
the model would be empty. `undefined` is what keeps `SetMetadata` from
materializing a packet out of a pure delete.

`Document.installXmp` becomes `installXmp(update: XmpUpdate)`: it reads the
current `/Metadata` bytes, calls `editXmpPacket`, and installs the result.
`SetXmp` and `SetMetadata` pass their update rather than a merged
`XmpMetadata`. `mergeXmp` and `document.ts`'s `hasXmpField` lose their only
callers and are deleted, along with `mergeXmp`'s tests. `buildXmp` is
reimplemented over the same edit starting from an empty model, so it and
`installXmp` cannot disagree about the packet layout.

It lives in `xmp.ts` rather than in a module of its own because
`buildXmp` must reach it. A separate `xmpedit.ts` would import `xmp.ts` for
`readXmp` and `validateCustom`, and `xmp.ts` would import it back, which is a
2-cycle that `test/import-cycles.test.ts` fails the build on. `xmp.ts` →
`xmprdf.ts` is one-way.

Rejected: keeping `buildXmp` for fresh packets and using the model only for
existing ones means two writers, and a document's packet format would then
depend on its history. Splicing raw Descriptions was also rejected: namespace
scoping and duplicate properties make it fragile.

### Starting model

1. **No packet:** an empty model.
2. **A packet that `parseRdfPacket` accepts:** that model and its prefixes. The
   bytes are first decoded with `readXmp`'s BOM-aware decoder and re-encoded as
   UTF-8, so a UTF-16 packet is edited rather than rejected.
3. **A packet that does not parse:** a model built from `readXmp(bytes)`'s
   fields. That is exactly what survives today, so it is no regression.

### Field mapping

Each field is a (namespace, name) property. **Setting** a field replaces that
property in place, keeping its position, or appends it at the end when absent.
**`null` deletes** the property. A replaced property's qualifiers are dropped,
because they described the old value.

| Field | Property | Value written |
|---|---|---|
| `title` / `description` / `rights` | `dc:title` / `dc:description` / `dc:rights` | See **Language alternatives** below |
| `authors` | `dc:creator` | a Seq of simple items, replacing the property whole; `[]` deletes |
| `subjects` | `dc:subject` | a Bag of simple items, replacing the property whole; `[]` deletes |
| `keywords`, `producer` | `pdf:Keywords`, `pdf:Producer` | simple value |
| `creatorTool`, `createDate`, `modifyDate` | `xmp:CreatorTool`, `xmp:CreateDate`, `xmp:ModifyDate` | simple value; a `Date` is written with `toISOString()`, a string as given |
| `pdfaPart`, `pdfaConformance`, `pdfaRev` | `pdfaid:part`, `pdfaid:conformance`, `pdfaid:rev` | simple value (`String(n)`) |
| `pdfuaPart`, `pdfuaRev` | `pdfuaid:part`, `pdfuaid:rev` | simple value |
| `pdfxVersion` | `pdfxid:GTS_PDFXVersion` | simple value |
| `custom` | see below | see below |

The namespace URIs are the ones `buildXmp` already writes.

**Language alternatives.** Setting `title`, `description` or `rights` replaces
the `x-default` item of the `rdf:Alt`, or inserts one as the first item. Every
other language item is kept. If the existing value is not an `Alt`, the whole
property is replaced by a one-item Alt.

**`custom`.** Setting it first removes every property that
`readXmp(current).custom` reports, matched by (namespace, name), and then
appends the given ones as simple values. `null` removes them. Tying the removal
to what `readXmp` reports is what keeps `GetXmp().custom` and `SetXmp({ custom })`
agreeing about what `custom` means. A property it does not report, such as a
struct, an array, a qualified or URI value, or a property with a reserved
prefix, is untouched.

`validateCustom`'s checks still run before anything is written, so a rejected
call leaves the document unchanged.

### Output

The output is always the canonical form written by `serializeRdfPacket`: one
`rdf:Description`, in element form. Every metadata write therefore changes the
packet bytes compared with before, and the CHANGELOG entry says so.

## Acceptance

- **A custom namespace survives.** A document whose packet carries a custom
  namespace struct, the Adobe History packet, and a `de-DE` title keeps all of
  them after `SetXmp({ title })`: every property other than `dc:title` is
  model-equal, and the `de-DE` item survives.
- **A PDF/A extension schema survives an edit.** A PDF/A document with a
  `pdfaExtension:schemas` description and the custom property it describes is
  edited with `SetMetadata({ title })`. Afterwards the description property is
  model-equal to before, and `ValidatePdfA` still passes.
- **Conversion preserves foreign XMP.** `ConvertToPdfA` on a document with
  History keeps the History.

## Tests

- `test/xmp-edit.test.ts`: the mapping table cell by cell, `null`, in-place
  position, the language-alternative rule, `custom` semantics, the three
  starting models (including UTF-16), and the `undefined` return.
- `test/xmp-preserve.test.ts`: document-level acceptance, over the vendored
  Adobe and calibre packets and a hand-built PDF/A document with an extension
  schema.
- Fences: `test/xmp.test.ts` (two attribute-form assertions move to element
  form), plus the PDF/A, UA and X conversion and validation suites unedited.
- Mutation checks on in-place replacement, `x-default`-only replacement,
  `custom` scoping, the fallback path, and qualifier dropping.

## Follow-ups filed

- The ISO 19005-2 §6.6.2.3 extension-schema validation rule.

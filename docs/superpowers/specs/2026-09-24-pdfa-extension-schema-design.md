# PDF/A: XMP properties must be predefined or described (o6uu.6)

Issue: `aspose-pdf-foss-for-ts-o6uu.6`, epic `o6uu` (XMP as a data model).

## Goal

`ValidatePdfA` reports an XMP property that is neither predefined nor described
by the packet's `pdfaExtension:schemas`, and a malformed description.
`ConvertToPdfA` (and `ConvertToPdfUa` on a PDF/A document) writes the missing
descriptions it can state truthfully.

## Decisions taken in brainstorming

- **Two of three layers.** Presence (6.6.2.3.1-1 / 6.7.9-2) and description
  structure (6.6.2.3.2–3 / 6.7.8) ship now. Value-type correctness
  (6.6.2.3.1-2 / 6.7.9-3) is filed as its own issue: it means porting
  veraPDF's whole type-validator system.
- **Converters fix what they can.** Without that, every document carrying
  `pdfuaid`, `pdfxid` or a caller's `custom` property stops converting clean.

## The anchor

veraPDF, as for `72nc.1` and `q7hc.4`: a transcription with no runnable oracle.

- Rules: `veraPDF-validation-profiles` at `174a2db1` (2026-08-04),
  `PDF_A/PDFA-1B.xml`, `PDFA-2B.xml`, `PDFA-3B.xml`, `PDFA-4.xml`.
- Semantics and tables: `veraPDF-library` at `60f8f1dc` (2026-09-17),
  `core/src/main/java/org/verapdf/model/impl/axl/AXLExtensionSchema*.java`,
  `AXLXMPProperty.java`, and `model/tools/xmp/{XMPConstants,
  SchemasDefinitionCreator,ValidatorsContainer,ValidatorsContainerCreator,
  SimpleTypeValidator,URITypeValidator}.java`.

Findings:

- **Parts 1–3 only.** `PDFA-4.xml` has no rule on `XMPProperty` or any
  extension-schema object; ISO 19005-4 dropped the requirement. Part 4 is
  silent.
- **Parts 2 and 3 are identical** — the 21 extracted rules diff empty.
- **Presence is per PROPERTY**, keyed `(namespace URI, local name)`: a known
  namespace does not excuse an unknown property in it.
- **Part 1 uses the XMP 2004 predefined set; parts 2–3 the XMP 2005 set**
  (which adds xmpDM, camera raw, aux, xmpTPg and more).
- **Parts 2–3 only:** a property in an object-level metadata stream is also
  satisfied by a description in the CATALOG's packet (`isDefinedInMainPackage`).
  Part 1 allows the current packet alone.
- **"Shall be present" is enforced by the PREFIX test**, not the shape test:
  every `isXValid…` returns true for an absent field, and `xPrefix == "…"`
  fails on `null`. `property`, `valueType` (on a schema) and `field` (on a value
  type) allow `null` — they are optional.
- **Text and URI are the same shape test** — a simple node (`URITypeValidator`
  was relaxed to text validation "after discussion with TWG").
- **`isKnownType`** lowercases, strips `(open |closed )?(choice |choice$)(of )?`,
  repeatedly peels `bag `/`seq `/`alt `, treats a bare `bag`/`seq`/`alt` as an
  array of Text and keeps `lang alt` whole. A schema's own
  `pdfaSchema:valueType` entries register their `pdfaType:type` names for that
  schema's properties.
- **`pdfuaid` and `pdfxid` are not predefined.** A PDF/A-2 document that is
  also PDF/UA needs a `pdfuaid` description.

## 1. Data — `scripts/gen-xmp-schemas.mjs`, `src/xmpschemadata.ts`, `src/xmpschemas.ts`

`npm run gen:xmpschemas` downloads the pinned Java sources and emits
`src/xmpschemadata.ts`: the predefined `(ns, name)` pairs for the 2004 and 2005
sets, and the known value-type names for each. Only these facts are emitted —
no veraPDF code is vendored. The file carries a provenance header naming the
commit, and the suite asserts each set's size, so a truncated generation is a
red build. The script is not run by `npm test`, like every other `gen:*`.

`src/xmpschemas.ts` is a leaf over that data:

- `isPredefinedProperty(ns, name, era: '2004' | '2005'): boolean`
- `isKnownValueType(name, era, localTypes: ReadonlySet<string>): boolean` —
  the normalisation above, transcribed.

## 2. Rules — `src/pdfaext.ts`, wired in `src/pdfavalidate.ts`

Pure over `RdfPacket`: `extensionSchemaIssues(packet, main, part)` returning
`ValidationIssue[]`. `pdfavalidate.ts` parses every metadata stream (the
catalog's is `main`) and calls it at parts 1–3. A packet that will not parse
yields nothing here — `isSerializationValid` is a different rule.

| Rule id | Clauses (part 1 / 2–3) | Fires when |
|---|---|---|
| `XmpPropertyNotDescribed` | 6.7.9-2 / 6.6.2.3.1-1 | a top-level property is neither predefined nor described (current packet; parts 2–3 also the main one) |
| `XmpExtensionContainer` | 6.7.8-2 / 6.6.2.3.3-1 | `pdfaExtension:schemas` is not a Bag, or its namespace's prefix is not `pdfaExtension` |
| `XmpExtensionUndefinedField` | 6.7.8-1 / 6.6.2.3.2-1 | a schema/property/valueType/field struct carries a child outside its namespace and allowed names |
| `XmpExtensionField` | 6.7.8-3…8,10…17,19 / 6.6.2.3.3-2…18 minus the next row | a required field is absent or wrongly prefixed, a Text/URI field is not simple, a `property`/`valueType`/`field` is not a Seq |
| `XmpExtensionValueType` | 6.7.8-9,18 / 6.6.2.3.3-8,17; category of 6.7.8-10 / 6.6.2.3.3-9 | a `valueType` names no known type, or `category` is not `internal`/`external` |

Allowed children: schema `{schema, namespaceURI, prefix, property, valueType}`
in `pdfaSchema`; property `{name, valueType, category, description}` in
`pdfaProperty`; value type `{type, namespaceURI, prefix, description, field}` in
`pdfaType`; field `{name, valueType, description}` in `pdfaField`.

Severity: error at all three parts. Messages name the object (schema namespace,
property name) and the field.

**Stated divergence:** veraPDF compares the prefix each element literally used;
our model keeps one prefix per namespace (`RdfPacket.prefixes`, the first
binding in the source). A packet rebinding a prefix partway through can answer
differently. Recorded in CLAUDE.md.

**Not implemented:** value-type correctness (follow-up issue).

## 3. Converter — `extensionSchemaPass`

In `src/pdfaconvert.ts` at parts 1–3, after `identificationPass`, under a new
`ConvertCategory` `'extensionSchemas'`. Edits the parsed packet in place (via
the `o6uu.3` edit path), so everything else survives. For every top-level
property that is neither predefined nor described:

- `pdfuaid` → a schema describing `part` (Integer), `rev` (Integer), `amd`
  (Text), `corr` (Text), category `internal`;
- `pdfxid` → `GTS_PDFXVersion` (Text), category `internal`;
- any other namespace, simple non-URI value → that property as `Text`,
  category `external`, under the packet's own prefix for the namespace;
- anything else (array, struct, URI) → left, and still reported.

Descriptions for one namespace are grouped into one schema entry; an existing
schema entry for the namespace is extended rather than duplicated. Only the
catalog packet is touched.

`ConvertToPdfUa` runs the same pass after writing `pdfuaid`, when the packet
carries `pdfaid:part` 1, 2 or 3.

## Testing

- `xmpschemas`: normalisation cases and asserted table sizes.
- Each rule from hand-built packets, at part 1, part 2 and part 4 (silent) —
  the cross-part pair `72nc.1` requires, since a part-4-silent assertion alone
  cannot tell a gated rule from an unwired one.
- Object-level packet satisfied by the main packet at part 2, not at part 1.
- Converter: a document with a custom property converts clean; `ConvertToPdfA`
  then `ConvertToPdfUa` passes `ValidatePdfA('2a')`; a struct in an unknown
  namespace stays unresolved; `preserve: ['extensionSchemas']` declines.
- Fences: existing PDF/A validate/convert suites unedited; the vendored
  Acrobat packet (`test/fixtures/xmp/`) reports no issue at part 2.
- Mutation sweep, results recorded in CLAUDE.md.

## Docs

README (the PDF/A validation and conversion paragraphs, the new category),
CHANGELOG **Added** (the rules and the converter pass), CLAUDE.md entries for
`xmpschemas.ts`, `xmpschemadata.ts`, `pdfaext.ts`, and the new `gen:` script
in the Build section. File the value-type follow-up issue.

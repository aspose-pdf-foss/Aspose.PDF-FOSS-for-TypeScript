# PDF/A: XMP property value types (o6uu.10)

Issue: `aspose-pdf-foss-for-ts-o6uu.10`, epic `o6uu`. Layer 3 deferred from
`o6uu.6`: every XMP property's VALUE must match its predefined or described
type — veraPDF's `isValueTypeCorrect`.

## The anchor, and what it turned out to be

veraPDF-library at `60f8f1dc` (the pin `o6uu.6` already uses):
`model/tools/xmp/{ValidatorsContainer,ValidatorsContainerCreator,
SchemasDefinition,PredefinedSchemasDefinition,SchemasDefinitionCreator,
XMPConstants}.java`, `validators/*.java`, `model/impl/axl/AXLXMPProperty.java`,
and xmp-core's `ISO8601Converter.java`, `ParseRDF.java`, `XMPNodeUtils.java`,
`VeraPDFMeta.java`. Profile rules, `veraPDF-validation-profiles@integration`:

| Part | Clause | Test |
|---|---|---|
| 1 | 6.7.9 test 3 | `isValueTypeCorrect == true` on `XMPProperty` |
| 2, 3 | 6.6.2.3.1 test 2 | `isValueTypeCorrect == true` on `XMPProperty` |

Findings the design rests on, each read from the source:

1. **Closed-choice checking is OFF for validation.** `GFPDMetadata` builds
   `AXLMainXMPPackage(metadata, true)` / `AXLXMPPackage(metadata, true, main)`,
   the constructors that pass `isClosedChoiceCheck = false` (the flag exists
   for the metadata fixer). So every restricted field registers its OPEN type
   and every closed seq choice registers `seq integer` / `seq text`: the whole
   predefined side reduces to `(namespace, name) → type string`, and each
   structured type to `namespace` plus `field → type`.
2. **Type resolution order** (`AXLXMPProperty.getSchemasDefinition`): part 1 —
   the packet's own extension schemas, then the XMP 2004 predefined set;
   parts 2–3 — the packet's own, then the MAIN (catalog) packet's, then the
   XMP 2005 predefined set. An extension schema can therefore redefine a
   predefined property's type.
3. **Registration filters** (`SchemasDefinition.registerProperty`): a
   registration whose type is not KNOWN to the container is dropped (the
   property is then not "defined" there and resolution falls through), and the
   first registration for a (namespace, name) wins.
4. **Extension value types are scoped per schema.** Each `pdfaExtension:schemas`
   entry gets its own container — for part 2/3 object packets, copied from the
   main package's container for that namespace, else a fresh era container —
   extended by that entry's `pdfaSchema:valueType` items: a type with
   `pdfaType:field` entries and a `pdfaType:namespaceURI` becomes a struct type,
   one with no fields becomes Text.
5. **Lang Alt** = an Alt array in which at least one item carries `xml:lang`
   (`XMPNodeUtils.detectAltText`, run by `ParseRDF` regardless of
   normalization), OR an empty Alt (`LangAltValidator`).
6. **No normalization.** `VeraPDFMeta.parse` sets `setOmitNormalization(true)`,
   so a plain-text `dc:title` is NOT silently wrapped into a Lang Alt — it
   fails. This is the everyday real-world defect the converter repairs.
7. **The whole rule is `null == true`-failing**: a property with no resolved
   type yields `null` and veraPDF reports it again as "does not correspond to
   type null". See decision 1.
8. URI and URL validators accept any SIMPLE value (their parse checks are
   commented out upstream "after discussion with TWG"); XPath compiles the
   value with `javax.xml.xpath`; Date parses with `ISO8601Converter`.

## Decisions taken in brainstorming

1. **Report once.** A property with no resolved type is skipped — `o6uu.6`'s
   rule already reports it. A stated divergence from veraPDF, recorded in
   CLAUDE.md.
2. **The converter repairs lossless SHAPE mismatches and reports the rest**,
   under a new `ConvertCategory`, `'xmpValueTypes'`.

Two further divergences, decided here:

- **XPath accepts any simple value.** There is no XPath compiler to port, and no
  predefined property is typed XPath, so only an extension schema reaches it.
- **Date is XMPCore's grammar, transcribed** — not `pdfdate.ts`'s. Two grammars
  answering "is this a date" is how our validator and veraPDF would disagree.
  Its quirks come with it, including that an EMPTY string is a valid date.

## 1. Data — `scripts/gen-xmp-schemas.mjs` → `src/xmpschemadata.ts`

The generator additionally downloads the files above and replays veraPDF's
registration sequence per era (closed-choice OFF), emitting:

- `PROPERTY_TYPES_2004`, `PROPERTY_TYPES_2005`:
  `Readonly<Record<namespace, Readonly<Record<name, type>>>>`, with the
  unknown-type and first-wins filters applied.
- `STRUCT_TYPES_2004`, `STRUCT_TYPES_2005`:
  `Readonly<Record<simplifiedTypeName, { ns: string; fields: Record<name, type> }>>`,
  restricted fields merged in under their open types.
- `SIMPLE_TYPE_PATTERNS`: the `SimpleTypeEnum` regex sources, and
  `GPS_PATTERN_2004` / `GPS_PATTERN_2005` (the eras differ); Locale is `(?s).*`
  in both.

**Fence:** the generator asserts `PREDEFINED_*`'s name sets equal the key sets
of `PROPERTY_TYPES_*` and refuses to write otherwise, so `o6uu.6`'s tables and
these cannot drift. It also refuses to run if the validator construction it
depends on (the closed-choice-OFF constructors, the base container's contents)
stops matching what it parses. The Java regexes are emitted as source strings;
`xmptypes.ts` compiles each as `^(?:…)$` with the `s` flag where the Java
pattern carries `(?s)`, since Java's `matches()` is a whole-string match.

## 2. `src/xmptypes.ts` — the validator (new)

A pure leaf over `xmprdf.ts` types and `xmpschemadata.ts`. It never throws.

```ts
export class XmpTypeRegistry {
  static forEra(era: XmpEra): XmpTypeRegistry;
  extend(valueTypes: RdfValue | undefined): XmpTypeRegistry;  // a copy
  isKnownType(type: string): boolean;
  validate(value: RdfValue, type: string): boolean;
}
export function isXmpDate(s: string): boolean;   // ISO8601Converter.parse
```

- `simplifyType` is `ValidatorsContainer.getSimplifiedType` — lower-case, strip
  `(open |closed )?(choice |choice$)(of )?`, empty → `text`, a bare `bag`/`seq`/
  `alt` → `… text` — and is shared with `xmpschemas.ts`'s `simplifyValueType`
  rather than duplicated (one owner; the existing function moves or delegates).
- `validate`: `any` → true; an array prefix (`bag `, `seq `, `alt `) checks the
  form (Alt; Seq = ordered and not Alt; Bag = neither) and every item against
  the rest; otherwise the named validator, false when unknown.
- Model mapping: veraPDF's `isSimple` is `kind === 'simple'` (a URI included,
  qualifiers ignored); struct children are `fields`, matched by local name and
  namespace URI.
- Simple types match the WHOLE value against their pattern; `date` →
  `isXmpDate`; `lang alt` → an Alt with some item carrying `lang`, or an empty
  Alt; `uri`, `url`, `xpath` → any simple value; a struct type → a struct whose
  every field is declared, in the type's namespace, and validates.
- `extend` registers an extension schema's value types: fields and a namespace
  → a struct type; no fields → Text.

## 3. Resolution and the rule — `src/pdfavaluetypes.ts` (new)

Pure over `RdfPacket`, beside `pdfaext.ts` and reusing its packet model
(`PacketUnderTest`, the reachable `/Metadata` streams from `metadataStreams`).

- Per packet, build its extension definitions: for each schema entry, a
  registry (per finding 4) and its properties' types, registered with the
  known-type and first-wins filters.
- For each TOP-LEVEL property: resolve its type in the order of finding 2;
  unresolved → skip (decision 1); else `validate`, and on failure report
  `XmpValueType` (error), citing 6.7.9 test 3 at part 1 and 6.6.2.3.1 test 2 at
  parts 2–3, naming the property (prefix:name, namespace) and the expected type.
- Wired into `pdfavalidate.ts` beside `extensionSchemaRule`, parts 1–3 only.

## 4. The converter — `xmpValueTypesPass`

`pdfaconvert.ts`, category `'xmpValueTypes'`, after `extensionSchemaPass`. For
each property the rule reports, try in order and keep a repair only if the
result validates against the resolved type:

- simple → Lang Alt: a one-item Alt, `lang: 'x-default'`;
- simple → `bag|seq|alt T`: a one-item array of that form;
- Bag ↔ Seq: change the form, items in order;
- one-item Bag/Seq → Alt when the type is an Alt.

Everything else is left as written and lands in `unresolved`. Each packet is
rewritten through the existing edit path (`editXmpPacketWith` for the catalog
packet; the same model edit and `writeXmpPacket` for an object-level stream,
installed into that stream). A repaired `dc:title` keeps its text as the
`x-default` item, so /Info needs no mirror step.

## Testing

- Generator fence: a mutated source table must make the generator refuse.
- `xmptypes`: each simple pattern at its boundaries (Real's two alternatives,
  Integer sign, Boolean case, MIMEType), GPS in each era, the Date grammar
  (year-only, month/day ranges, `T` with and without minutes, fractional
  seconds, `Z`/offsets, the empty string, garbage), arrays of each form incl.
  nesting, Lang Alt (with lang, empty, Alt without any lang), structs (unknown
  field, wrong namespace, bad field value), `any`, type simplification.
- Resolution: an extension schema overriding a predefined type; part 1 ignoring
  the main packet; a registration with an unknown type falling through;
  first-wins; an extension value type usable only within its own schema.
- Rule: a mistyped predefined property reports; an undescribed one does NOT
  report here; part 4 silent; object-level packets checked.
- Converter: each repair; an unrepairable value in `unresolved`; `preserve:
  ['xmpValueTypes']` declines; `ValidatePdfA` passes after a repair.
- Real packets: `test/fixtures/xmp/`'s Acrobat and calibre packets produce no
  `XmpValueType` issue.
- Mutation sweep, recorded in CLAUDE.md.

## Ceiling

A transcription with no runnable oracle — veraPDF is not installed — so the
suite proves agreement with our reading of veraPDF, not with ISO 19005 or with
veraPDF's output. `72nc.1`'s ceiling, as for `o6uu.6`.

## Docs

README: the PDF/A validation list gains value types; the `ConvertToPdfA`
categories table gains `'xmpValueTypes'`. CHANGELOG **Added**. CLAUDE.md: an
entry for `xmptypes.ts` and `pdfavaluetypes.ts` with the invariants and the
three divergences.

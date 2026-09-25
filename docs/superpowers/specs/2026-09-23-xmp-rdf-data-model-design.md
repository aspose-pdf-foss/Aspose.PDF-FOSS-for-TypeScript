# XMP RDF data model: parse and serialize (`o6uu.1`)

Epic `o6uu` (XMP as a data model). This issue builds the model and nothing
else; wiring it under `readXmp`/`buildXmp` is `o6uu.3`, qualifiers and URI
values are `o6uu.2`.

## Findings that shape the design

1. **`xml.ts` discards namespaces.** `readName` strips the prefix from element
   AND attribute names, so `xmlns:dc="…"` arrives as attribute `dc`,
   `rdf:about` as `about`, `xml:lang` as `lang`. RDF identifies a property by
   namespace URI + local name, so the reader cannot serve RDF as it stands.
2. **`xml.ts` does NOT reject a DOCTYPE**, contrary to the issue text:
   `skipMisc` skips `<!…>` up to the first `>`, which also mis-skips a DOCTYPE
   with an internal subset. Rejection must happen in the RDF layer.
3. **The vendored real packets cannot meet the acceptance criterion alone.**
   The two IRS LiveCycle packets (`test/fixtures/xfa/`) carry a language
   alternative, a Bag and a Seq but no Seq of structs. They carry one
   real-world quirk worth pinning: Adobe encodes a space in a property NAME as
   U+2182 followed by four hex digits (`pdfx:Formↂ0020fields`).
   `ghostscript-x4.pdf` splits its properties across seven `rdf:Description`s
   and uses the attribute form heavily.

## Decisions

### `xml.ts`: opt-in qualified names

`parseXml(bytes, limits, { qnames: true })` keeps the prefix on element names
and attribute keys. Default is `false`, so every existing consumer is
byte-identical by construction. No namespace resolution is added to `xml.ts`;
the RDF layer resolves prefixes with its own scope stack. Rejected
alternatives: full namespace resolution in `xml.ts` (machinery ~20 consumers do
not need) and a second parser (ruled out by the issue).

### New module `src/xmprdf.ts`

A pure leaf over `xml.js` and `errors.js`. Internal: not exported from
`index.ts`, not called by `xmp.ts` yet. No user-visible change, so no
CHANGELOG entry; it earns a CLAUDE.md Source-list entry when it lands.

### Model

```ts
interface RdfProperty { ns: string; name: string; value: RdfValue; lang?: string }
type RdfValue =
  | { kind: 'simple'; value: string }
  | { kind: 'array'; form: 'Bag' | 'Seq' | 'Alt'; items: RdfItem[] }
  | { kind: 'struct'; fields: RdfProperty[] };
interface RdfItem { value: RdfValue; lang?: string }
interface RdfPacket {
  properties: RdfProperty[];
  /** namespace URI → the prefix the source used for it (serializer's preference). */
  prefixes: Map<string, string>;
}
```

The `Rdf*` names avoid colliding with `xmp.ts`'s public `XmpProperty`. A
language alternative is an `Alt` whose items carry `lang`; there is no separate
kind. `lang` is the only qualifier modelled here — `o6uu.2` adds general
qualifiers (`rdf:value`) and URI values (`rdf:resource`) as additive fields.

### `parseRdfPacket(bytes, limits?): RdfPacket`

Accepts:

- root `x:xmpmeta`, legacy `x:xapmeta`, or a bare `rdf:RDF`; the xpacket PIs
  around it are skipped;
- any number of `rdf:Description` children of `rdf:RDF`, merged in document
  order;
- properties as attributes of `rdf:Description` → simple;
- property element with text only → simple (text as written, not trimmed —
  whitespace inside a simple value is data);
- property element holding `rdf:Bag`/`rdf:Seq`/`rdf:Alt` → array; each
  `rdf:li` parsed recursively as a value, `xml:lang` on the `li` → item `lang`;
  an empty container (`<rdf:Bag/>`) → empty array;
- `rdf:parseType="Resource"` on a property element or an `rdf:li` → struct of
  its child elements;
- a property element or `rdf:li` holding one nested `rdf:Description` → struct
  (attributes and children of that Description are its fields);
- an EMPTY property element carrying property attributes (other than `xml:lang`,
  `rdf:*`) → struct of those attributes;
- `xml:lang` on a property element → property `lang`;
- `rdf:resource="…"` → simple value holding the URI (interim; `o6uu.2` makes it
  a URI value).

Namespaces are resolved with a scope stack of `xmlns:` declarations along the
ancestor chain; `xml:` is pre-bound. Whitespace-only text between elements is
ignored.

Throws `PdfParseError` on: a `<!DOCTYPE` or `<!ENTITY` anywhere in the source;
a root that is not one of the three; an element prefix with no binding; an
element with both non-whitespace text and child elements; an unknown
`rdf:parseType`. A duplicate top-level property (same ns + name, e.g. across
two Descriptions) keeps the FIRST occurrence and drops the rest. Leniency is
the caller's decision, as `readXmp` makes it today.

### `serializeRdfPacket(packet): string`

Canonical form:

```
<?xpacket begin="﻿" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/">
 <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
  <rdf:Description rdf:about="" xmlns:…="…" …>
   …properties in model order, element form…
  </rdf:Description>
 </rdf:RDF>
</x:xmpmeta>
<?xpacket end="w"?>
```

- one `rdf:Description rdf:about=""` declaring every namespace used anywhere
  in the model (struct fields included);
- arrays as `<p><rdf:Seq><rdf:li>…</rdf:li></rdf:Seq></p>`, empty as
  `<rdf:Seq/>`;
- structs as `rdf:parseType="Resource"`, empty struct as an empty element with
  `rdf:parseType="Resource"`;
- `xml:lang` written where the model has `lang`;
- text and attribute values escaped with `xml.ts`'s `escapeXml`.

Prefix choice: the packet's `prefixes` entry if it is a valid NCName and not
already taken; else a well-known default (dc, xmp, pdf, xmpMM, stRef, stEvt,
pdfaid, pdfuaid, pdfxid, pdfaExtension, pdfaSchema, pdfaProperty, pdfaType,
pdfaField); else `ns1`, `ns2`, …. `rdf`, `x`, `xml`, `xmlns` are never
assigned. The serializer throws `TypeError` on a model it cannot write: a
property or field name that is not an NCName, an empty namespace.

Round-trip contract: `parseRdfPacket(serializeRdfPacket(m))` deep-equals the
model part of `m` (`properties`); output is NOT byte-identical to a foreign
input.

## Real-world fixture: `test/fixtures/xmp/`

The acceptance criterion names a real Acrobat packet. **Amended during
implementation:** the plan was for Acrobat to re-save a PDF we built, but the
development machine has Acrobat Reader and no Acrobat Pro, and Reader cannot
edit and re-save metadata. By the maintainer's decision, the fixture is the
XMP packet from `TutorialSample.pdf`, which Acrobat Reader installs, vendored
byte for byte as `acrobat-tutorial-sample.xmp` (the packet only, not the PDF).
It is Adobe XMP Core 9.1 output and contains an `xmpMM:History` Seq of three
`parseType="Resource"` structs, a `DerivedFrom` struct, a `dc:title`
language alternative and an empty `<rdf:Bag/>`.

Ceiling, recorded in PROVENANCE: one producer; the nested-Description and
attribute-form struct syntaxes and multi-language Alts are held by hand-built
cases only. Calibre 7.26 was tried as a second writer and rejected: it copies
foreign schemas as XML subtrees rather than re-serializing them, so its output
would test our parser against our own syntax again.

## Tests

- `test/xml.test.ts` (qnames block): the option keeps prefixes on elements and
  attributes; default unchanged.
- `test/xmprdf.test.ts`: one case per accepted form, each also checked through
  a serialize → parse round trip; each refusal; duplicate-first-wins; prefix
  choice and collision renaming; namespace declared on an inner element.
- `test/xmprdf-real.test.ts`: the IRS, Ghostscript and Acrobat packets —
  expected model spot checks (History is a Seq of three structs with `stEvt:action`;
  title is an `x-default` language alternative; the U+2182 name survives), then
  `parse(serialize(parse(x)))` deep-equals `parse(x)`.
- Mutation check the load-bearing rules (namespace resolution by URI not
  prefix, `li` recursion, parseType dispatch, lang on items, DOCTYPE refusal).

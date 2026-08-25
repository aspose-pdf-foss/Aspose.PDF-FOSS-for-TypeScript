# FDF / XFDF form-data import & export

Issue: `aspose-pdf-foss-for-ts-e1p`
Follow-up: `aspose-pdf-foss-for-ts-73p` (annotation round-trip, blocked on this)

Round-trip AcroForm field values through the two standard data-exchange
formats: FDF (PDF object syntax, PDF 32000-1 §12.7.7) and XFDF (XML, ISO
19444-1). Self-contained and zero-dependency, layered on the existing
`Form`/`Field` model in `src/form.ts`.

## Scope

In scope: field values for the four settable field types (text, checkbox,
radio, choice), the `/RV` rich-text companion to `/V`, the `/F` source-file
reference, and `/ID`.

Out of scope, deliberately:

- **Annotations.** Both the FDF `/Annots` array and the XFDF annotation
  element vocabulary belong to issue 73p, which builds on the container
  defined here. The split keeps this issue testable on its own; the container
  has to exist first either way.
- **Field reconfiguration.** `/SetFf`, `/ClrFf`, `/SetF`, `/ClrF` — an FDF may
  carry these to change a form's shape rather than fill it. Not modelled.
- **Embedded JavaScript** (`/JavaScript` in the FDF dict) and page-level FDF
  data (`/Pages`, `/Differences`).
- **Rich-text rendering.** `/RV` is transported verbatim; see below.

## Architecture

Three modules, so that field semantics and format quirks never mix:

| Module | Responsibility | Depends on |
|---|---|---|
| `src/formdata.ts` | Format-neutral middle. Owns *all* interaction with the form. | `document.ts`, `form.ts` |
| `src/fdf.ts` | bytes ↔ `FormData` in FDF (PDF syntax) | `lexer.ts`, `object-parser.ts`, `serialize.ts` |
| `src/xfdf.ts` | bytes ↔ `FormData` in XFDF (XML) | `xml.ts` |
| `src/xml.ts` | Minimal XML reader/writer: node tree, escaping, raw-content passthrough. | nothing outside itself |

**As built:** the XML reader lives in its own `src/xml.ts` rather than inside
`xfdf.ts` — it has a single responsibility, is testable with no XFDF concepts,
and issue 73p (annotation round-trip) reuses it.

Neither format module imports `Document` or `Field`; `formdata.ts` knows
nothing about FDF syntax or XML. Each is independently testable: the format
modules against literal byte fixtures, `formdata.ts` against a built PDF.

`xfdf.ts` carries a small recursive-descent XML reader (~120 lines) producing
a minimal node tree — elements, attributes, text, CDATA, comments, entity
unescaping, self-closing tags — plus an escaping writer. The regex scanning in
`xmp.ts` is not reusable here: XFDF nests `<field>` elements by name segment,
and regex cannot match balanced nesting.

### Data flow

```
Export:  doc --collectFormData(opts)--> FormData --writeFdf/writeXfdf--> bytes
Import:  bytes --readFdf/readXfdf--> FormData --applyFormData--> ImportReport
```

## The intermediate model

```ts
interface FormDataField {
  /** Fully-qualified field name, segments joined with '.'. */
  name: string;
  /** Source field type; 'unknown' on the import path (see below). */
  type: FieldType;
  /** Always strings; length > 1 only for multi-select choice. */
  values: string[];
  /** Verbatim XHTML from /RV, when present. */
  richText?: string;
}

interface FormData {
  fields: FormDataField[];
  /** /F — the file the data was exported from. */
  file?: string;
  /** The originating document's trailer /ID pair, hex-encoded. */
  id?: [string, string];
}
```

Values are always strings because XFDF has no boolean type — a checkbox
travels as its appearance-state name (`Off`, or the widget's on-state).
`values` is an array so that multi-select choice needs no special case.

`type` is populated on the **export** path, where `fdf.ts` needs it to decide
whether `/V` is written as a name (checkbox, radio) or a string (text,
choice). On the **import** path the format modules cannot know it, so they set
`'unknown'` and `applyFormData` resolves the real type from the live form.

### Import value mapping

`applyFormData` looks up each `FormDataField.name` with `Form.Get`, then maps
by the *live* field's `Type`:

| Field type | Value passed to the setter |
|---|---|
| `text` | `values[0] ?? ''` |
| `checkbox` | `values.length > 0 && values[0] !== 'Off' && values[0] !== ''` — an absent or empty value is *unchecked*, not checked |
| `radio` | `values[0] ?? ''` |
| `choice` | multi-select → `values`; otherwise `values[0] ?? ''` |

Assignment goes through the existing `Field.Value` setter. That is the whole
point of routing through `formdata.ts`: the setter already validates options,
flips `/AS` on widgets, and regenerates the appearance stream. Because it
validates before mutating, a rejected value leaves the document untouched, so
a partially-applied import never leaves a field in a half-written state.

`signature` and `pushbutton` fields are never assigned; a data file naming one
produces a `skipped` entry.

### Rich text

`/RV` is carried **verbatim** as an XHTML string — `<value-richtext>` in XFDF,
`/RV` in FDF (string or stream on read; always a string on write). It is set
directly on the field dict, not through the setter, and only when the same
field's `/V` was applied successfully.

Appearance generation continues to derive from `/V` alone. Rich formatting is
transported, not rendered. This limitation is stated in the README.

## Public API

```ts
// document.ts
ExportFdf(opts?: ExportFormDataOptions): Uint8Array
ExportXfdf(opts?: ExportFormDataOptions): Uint8Array
ImportFdf(bytes: Uint8Array): ImportReport
ImportXfdf(bytes: Uint8Array): ImportReport

interface ExportFormDataOptions {
  /** Emit fields whose value is empty or Off. Default false. */
  includeEmpty?: boolean;
  /** Value for the /F source-file reference. Omitted when absent. */
  file?: string;
}

interface ImportReport {
  /** Fully-qualified names of fields that were set. */
  imported: string[];
  /** Fields present in the data file that were not applied. */
  skipped: { name: string; reason: string }[];
  /** /F from the data file, when present. */
  sourceFile?: string;
  /** /ID from the data file, when present. */
  sourceId?: [string, string];
}
```

Export skips `signature`, `pushbutton`, and `unknown` fields unconditionally —
they carry no exportable value. It skips empty values (a `''` text or choice
value, a checkbox or radio at `Off`) unless `includeEmpty` is set.

Import **reports** `/F` and `/ID` rather than enforcing them. Whether a
mismatch matters is the caller's policy, not the library's.

### Node convenience wrappers

Added to `node.ts`, following the existing `splitPdfFile` / `updateMetadataFile`
pattern:

```ts
exportFdfFile(pdfPath: string, fdfPath: string, opts?: ExportFormDataOptions): Promise<void>
exportXfdfFile(pdfPath: string, xfdfPath: string, opts?: ExportFormDataOptions): Promise<void>
importFdfFile(pdfPath: string, fdfPath: string, outPath?: string): Promise<ImportReport>
importXfdfFile(pdfPath: string, xfdfPath: string, outPath?: string): Promise<ImportReport>
```

**As built:** these are async, matching every existing helper in `node.ts`.

`outPath` defaults to `pdfPath` (in-place rewrite).

## Format details

### FDF

Structure: `%FDF-1.2` header, body objects, `trailer << /Root n 0 R >>`,
`%%EOF`. The catalog is `<< /FDF << /Fields [...] /F (...) /ID [<..><..>] >> >>`.

- **Writer** emits no cross-reference table. The FDF spec permits its absence
  and Acrobat omits it.
- **Reader** verifies the `%FDF-` header, then scans `N G obj … endobj`
  sequentially into an object map rather than trusting an xref. An xref table,
  if present, is skipped. `/Root` comes from the trailer dictionary.
- `/Fields` is a tree: an entry may carry `/Kids` of child fields. The reader
  flattens it, joining `/T` segments with `.`. The writer emits a **flat** list
  where each entry's `/T` is the full dotted name — legal, and what most
  producers emit.
- `/V` is a name for checkbox and radio, a string for text and single-select
  choice, and an array of strings for multi-select choice.

### XFDF

```xml
<?xml version="1.0" encoding="UTF-8"?>
<xfdf xmlns="http://ns.adobe.com/xfdf/">
  <f href="form.pdf"/>
  <ids original="A1B2…" modified="C3D4…"/>
  <fields>
    <field name="name">
      <field name="first"><value>Ada</value></field>
    </field>
    <field name="langs">
      <value>en</value><value>fr</value>
    </field>
  </fields>
</xfdf>
```

- Field names nest by `.` segment: `name.first` becomes a `<field name="name">`
  containing a `<field name="first">`. The reader rebuilds the dotted name by
  concatenating ancestor `name` attributes.
- Multi-select choice emits repeated `<value>` elements; the reader collects
  all of them in document order.
- Checkbox and radio values are state names, matching the FDF `/V` name.
- `<value-richtext>` carries `/RV`.
- The reader accepts the document with or without the XFDF namespace
  declaration and ignores any namespace prefix on element names.

## Error handling

`PdfParseError` is thrown only for a container that cannot be read at all:

- FDF: missing or malformed `%FDF-` header, unparseable object syntax, no
  `/Root`, or a `/Root` with no `/FDF` dictionary.
- XFDF: malformed XML (unbalanced or unterminated tags), or no `<xfdf>` root.

Everything field-level is reported, never thrown:

| Situation | Result |
|---|---|
| Name matches no field in the form | `skipped`, `"no such field"` |
| Value rejected by the setter | `skipped`, the setter's message (e.g. `"no option 'mauve'"`) |
| Field is `signature` / `pushbutton` / `unknown` | `skipped`, `"field type is not settable"` |
| Document has no AcroForm | every field `skipped`, `"document has no form"` |

Export against a document with no AcroForm returns a well-formed, empty data
file rather than throwing.

## Testing

Vitest, building on the existing `test/helpers/build-form-pdf.ts` fixture.
Format-module tests use literal byte fixtures and need no PDF at all.

Round-trip and integration:

- fill → export → import → verify, for each of text, checkbox, radio,
  single-select choice, and multi-select choice, in **both** formats
- `includeEmpty` true and false, verifying the emitted field set each way
- `/AP` verified regenerated after import (the stream differs from pre-import)
- rich text preserved byte-for-byte across a round trip
- `/F` and `/ID` surfaced on `ImportReport`

Graceful-skip behaviour:

- unknown field name is ignored *and* appears in `skipped`
- invalid choice option is rejected, appears in `skipped`, and the document is
  verified unmodified
- signature and pushbutton fields skipped with the right reason
- document with no AcroForm skips everything without throwing

Format-level:

- FDF writer output shape: header, trailer, `%%EOF`, no xref
- FDF reader tolerates an xref table when present
- FDF `/Fields` tree with `/Kids` flattens to dotted names
- XFDF nesting, attribute and text escaping, CDATA, repeated `<value>`,
  namespace present and absent
- malformed input of each kind raises `PdfParseError`

## Documentation

`README.md` gains the four methods under the forms section, the four `node.ts`
wrappers, and a Limitations note that `/RV` is transported but not rendered
into appearances, and that annotations are not yet carried (pointing at 73p).

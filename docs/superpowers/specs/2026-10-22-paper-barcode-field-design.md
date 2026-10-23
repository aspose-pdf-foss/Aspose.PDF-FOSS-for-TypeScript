# Paper-barcode form field — design (2srz.4)

## Intent

A form field that draws as a 2D barcode (PDF417, Data Matrix or QR) and holds
the form's data, so a filled form can be printed, scanned at the other end and
read back without retyping. Acrobat calls these *paper forms barcodes*: a text
field carrying a non-standard `/PMD` dictionary, whose value is computed by a
calculation script Acrobat generates.

Three moments, all in scope:

1. **Authoring** — create such a field through this library.
2. **Fill, then print or render** — after values change, the barcode's
   appearance shows the current data, so `ToImage`, flattening and printing
   produce a barcode that scans to what was entered.
3. **Acrobat-made forms** — open one, fill it here, and its barcode still
   carries what Acrobat would have put in it, so the form owner's existing
   scanning software keeps working.

**Anti-goal, and the failure that matters:** a barcode that renders fine and
scans to stale or wrongly formatted data. Every rule below is chosen so that a
barcode is either right or the caller is told it may not be.

## Amended after the Task 1 spike (user-approved, 2026-10-22)

Adobe Reader 26.1 neither recomputes nor draws a paper barcode. Acrobat's own
script tests `ADBE.PMD_Need_Version`, `ADBE` is undefined in Reader, and so
the script takes its fallback and sets the value to `" "`. Reader paints a
`/PMD` field as a grey box with no symbol. So **"stays current in Reader"
cannot hold for any barcode field, Acrobat's own included**. The goal is now:
current when filled in **Acrobat Pro or through this library**, while Reader
shows the last saved appearance. The `tab` default stands, because it is what
Acrobat Pro recomputes and what scanners read.

**The oracle is Reader's script engine, read as TEXT.** With the version
guard removed, Reader runs the template and computes the content (p2:
`"Ann\t7"`, which shows that `007` becomes `7`). The probe writes
`JSON.stringify(value)` into a visible field, and the capture is transcribed by
hand, as the XFA probes were. The drawn symbol is checked by our ZXing tooling
(2srz.3), not by Reader.

## Decided with the user

- **Our own fields may use our own format.** The library's own JSON form-data
  format (what `doc.ExportJson` writes) is an acceptable barcode payload.
- **The barcode redraws itself.** No explicit call is required; the refresh
  happens automatically when the document is written.
- **Acrobat-made forms keep Acrobat's format.** When values change, the
  barcode's content is what Acrobat's script would have produced, not ours.
- **Split scope is acceptable.** Acrobat's *tab-delimited* encoding is
  reproduced exactly and checked against Adobe. Acrobat's *XML* encoding is
  recognised but not recomputed in this issue: such a barcode keeps its last
  value and is reported.
- **Forms we create must stay current in Acrobat and Reader too**, which means
  they carry a calculation script Acrobat runs (see "Encodings").

## The format being reproduced

### `/PMD` (paper metadata) on the field dictionary

Not in ISO 32000. The keys, confirmed by a second producer (PDFlib's
`barcode={symbology= ecc= xsymwidth= xsymheight= dataprep=}` options) and by
DynaPDF's documentation:

| Key | Meaning |
|---|---|
| `/Symbology` | `/PDF417`, `/QRCode` or `/DataMatrix` |
| `/ECC` | error-correction level (PDF417 0–8; QR 0–3 = L/M/Q/H) |
| `/XSymWidth`, `/XSymHeight` | module width and height, in pixels at `/Resolution` |
| `/YSymHeight` (seen in some producers) | row height for PDF417 |
| `/nCodeWordRow`, `/nCodeWordCol` | PDF417 rows and columns |
| `/Resolution` | dots per inch the module sizes are stated at |
| `/DataPrep` | 0 = encode the value as is; 1 = Flate-compress it first |
| `/Caption` | text Acrobat may show under the symbol |

The builder must confirm the exact key set and which are required against the
Reader probe (below) before writing any of them; the table is from secondary
sources, so it is a starting point, not a transcription.

### Acrobat's tab-delimited calculation script

Quoted verbatim from a user's paste of Acrobat's generated script
(<https://community.adobe.com/t5/acrobat-discussions/when-using-a-barcode-field-is-it-possible-to-encode-using-something-other-than-xml-or-tab-delimited/td-p/8664920>):

```js
function strTabDelimited(oParam)
{
    var bNeedTab = false;
    var strNames = "";
    var strValues = "";
    for (var i = 0; i < oParam.oDoc.numFields; ++i)
    {
        var strFieldName = oParam.oDoc.getNthFieldName(i);
        if ((null == oParam.aFields || bMemberOf(strFieldName, oParam.aFields))
            && (null == oParam.strXclField || strFieldName != oParam.strXclField)
            && (oParam.oDoc.getField(strFieldName).type != "button"))
        {
            if (bNeedTab)
            {
                if (oParam.bFieldNames)
                    strNames += "\t";
                strValues += "\t";
            }
            if (oParam.bFieldNames)
                strNames += strFieldName;
            strValues += oParam.oDoc.getField(strFieldName).value;
            bNeedTab = true;
        }
    }
    if (oParam.bFieldNames)
        return strNames + "\n" + strValues;
    else
        return strValues;
}

try
{
    if ( app.viewerVersion >= ADBE.PMD_Need_Version )
        event.value = strTabDelimited({oDoc: this, aFields: [/* names */], bFieldNames: false});
    else event.value = " ";
}
catch (e)
{
    event.value = " ";
}
```

The `bMemberOf` helper's text was not in the thread. The probe must capture
it; the recogniser must not assume its body.

Semantics this implies, each to be **confirmed by the Reader probe, not
assumed**:

- Fields come in `getNthFieldName` order (the document's own field order), not
  the order of `aFields` — corroborated by a second thread
  (<https://community.adobe.com/questions-9/pdf-form-barcode-generator-variable-order-1232132>).
  What that order is (field tree order? alphabetical?) is a probe question.
- Push buttons and the barcode field itself (`strXclField`) are skipped.
- Each value is Acrobat's `field.value` stringified by JavaScript `+=`. Open
  questions for the probe: does a numeric-looking text value come back as a
  number (`007` → `7`, `1.50` → `1.5`)? What does an unchecked checkbox give
  (`Off`)? An empty field? A multi-select list (comma-joined array)? A radio
  group (export value)?
- `bFieldNames: true` prepends a tab-joined header row and a `\n`.
- `ADBE.PMD_Need_Version` is an Acrobat built-in; we treat the guard as true.

## Behaviour

### Recognising an Acrobat barcode field

A field is a **barcode field** when it is a text field whose dictionary (or,
for a merged field/widget, the dict itself) carries `/PMD`. Its *encoding* is
decided from its calculate action (`/AA /C`):

- **`tab`** — the script is Acrobat's tab-delimited template above. Recognise
  it the way `afcall.ts` recognises AForm calls: the template's SHAPE with the
  blanks (`aFields` list of string literals, `bFieldNames` boolean, optional
  `strXclField`) read out, or `undefined`. Never partially understood, never
  executed. How strictly whitespace and the helper bodies must match is the
  builder's call; the rule is that anything that could compute something else
  is not recognised.
- **`xml`** — recognised as Acrobat's XML template by its distinctive
  identifiers, but not recomputed.
- **`unrecognised`** — anything else, including no script.

### Refresh

One pass, `refreshBarcodeFields`, run where `finalizeEmbeddedFonts` already
runs: `Save`, the incremental save, `Sign`/`Certify`, `AddDocumentTimestamp`.
For each barcode field:

1. Compute the content: `tab` → the reproduction; our `json` / `value`
   encodings → see below; `xml` / `unrecognised` → the field's current `/V`.
2. Apply `/DataPrep` 1 (Flate) when stated. Byte-identical zlib output to
   Acrobat's is NOT required — a scanner inflates either — and is not claimed.
3. If the content equals the stored `/V` and every widget already has an
   `/AP`, change nothing — whoever drew that appearance, Acrobat included.
   Otherwise write `/V` and regenerate the appearance. *My call:* no marker key
   of our own is written, and an Acrobat-made form opened and saved untouched
   keeps Acrobat's appearance byte for byte.

`/V` always holds the PLAIN content — what Acrobat's `event.value` is. Under
`/DataPrep 1` the compression happens only inside the symbol. *My call.*

**Encoders take bytes internally.** A barcode field turns its content into
bytes itself and draws through an internal byte-input path of
`makePdf417`/`makeDataMatrix`/`makeQr` (needed for compressed payloads, and
for matching however Adobe encodes non-Latin-1 text). The public string
signatures and their output stay unchanged, with the 2srz.3 ZXing goldens as
the fence. How Acrobat turns non-ASCII text into symbol bytes (Latin-1, UTF-8
with or without ECI) is a probe question; the probes include non-ASCII
values. *My call.*

**Signatures.** Refresh never writes a field that a signature locks (FieldMDP)
or that the document's DocMDP level forbids changing. Such a barcode is left as
it is and reported. Writing it would turn an earlier signature into a
violation. *My call.*

**Empty content** (no fields carried, or every value empty) draws an empty
appearance, as an empty text field draws nothing, with `/V` holding what
Acrobat's script returns (`""`). The probe confirms what Reader shows.
*My call.*

**Unprobed value shapes.** If a carried field's kind or value shape was not
settled by the probe (a signature field, a field with a format script, rich
text), the barcode is NOT recomputed. It keeps its last value and is
reported, per the anti-goal. Only shapes with a probe golden are reproduced.
*My call, from the anti-goal.*

**Invariant:** a document whose barcode content did not change is untouched —
no write and no `markModified()` — so an untouched document saves
byte-identical and a later `Sign()` still appends incrementally. Pin it
through the sign path, as `Recalculate` and `pagemode.ts` do.

**Invariant:** it runs AFTER anything that changes values and BEFORE the
incremental delta is diffed, for the reason `finalizeEmbeddedFonts` does.

An `xml` or `unrecognised` barcode is reported (`skipped`-style, through
whatever report surface the builder chooses — a `Form` method returning the
list is the minimum) so a caller learns its content was not recomputed.

### Appearance

The appearance is a Form XObject in the widget's `/AP /N`, drawn with the
existing geometry: `makePdf417` / `makeDataMatrix` / `makeQr` for the model
and `barcodeplace.ts`'s vector rectangles for the drawing, with the `/PMD`
symbology, ECC and (for PDF417) columns. Module size from `/PMD`'s
`XSymWidth`/`Resolution` when stated, else fit to the rect as `AddBarcode`
does. Reuse rather than a second barcode painter.

### Authoring

`form.AddBarcodeField(init)` (and `page.AddBarcodeField`, a thin forwarder,
as `AddTextField` has), creating a text field through `formcreate.ts`'s
existing path — validate everything before allocating, a rejected call leaves
the document byte-identical. Options:

- `name`, `page`, `rect` — as every `Add*Field`.
- `symbology`: `'pdf417' | 'datamatrix' | 'qr'`, default `'pdf417'` (Acrobat's).
- symbology options: PDF417 `ecLevel`/`columns`, Data Matrix `shape`, QR `ecc`.
- `encoding`: `'tab'` (default), `'json'`, `'value'`.
- `fields`: which fields the barcode carries. The default is every field that
  exists when the barcode is created, written into the script as an EXPLICIT
  `aFields` list, as Acrobat's own UI writes it; fields added later are not
  carried, which Adobe documents for its barcodes too. The reproduction also
  handles `aFields: null` (every field) for scripts others wrote. *My call.*
  `fieldNames`
  (header row, tab only), default false. `compress` → `/DataPrep 1`.

### Encodings for fields we create

- **`tab` (default)** — writes Acrobat's tab-delimited script verbatim with
  the chosen fields filled in, so Acrobat and Reader recompute it, and our
  refresh recomputes it the same way. Default because it stays current in
  every viewer and is what existing barcode decoders (e.g. Adobe's Barcoded
  Forms Decoder) expect. *Builder's/my call; the user chose "Acrobat and
  Reader too", and this is the encoding that satisfies it.*
- **`json`** — the barcode holds `doc.ExportJson` of the chosen fields,
  written compactly, so a scan goes straight into `ImportJson`. **No script is
  written**, so it stays current only through this library; documented as
  such. Writing a JavaScript re-implementation of `ExportJson` was rejected:
  two implementations of one format drift.
- **`value`** — the barcode shows the field's own `/V`; no script; any viewer
  redraws it when the value is typed.

## The oracle

There is no Acrobat Pro on this machine, but Adobe Reader 26.1 is, and Reader
recalculates and renders barcode fields itself. So:

- A generator (`scripts/gen-paper-barcode-probes.ts`, not run by `npm test`)
  builds probe forms with **our** authoring code: text, number-like text,
  checkbox, radio, list, multi-select and button fields, a barcode field with
  Acrobat's exact script, and a document-open script that sets the values
  (Reader will not save typed data — the XFA probes found that).
- Reader opens each; the barcode Reader draws is captured from the window and
  decoded with ZXing (`scripts/BarcodeOracle.java` already decodes PDF417,
  Data Matrix and, with a one-line addition, QR). The decoded bytes are the
  golden: Acrobat's exact output for known values.
- The suite recomputes each probe with our reproduction and requires byte
  equality. This settles field order, number formatting and checkbox/list
  values from Adobe.
- The same capture shows whether Reader draws a barcode at all for our
  authored `/PMD` — which is the acceptance test for "stays current in Reader".

**First task, and a go/no-go:** a spike confirming Reader renders an
AcroForm barcode field we authored, with Acrobat's script, and that its window
capture decodes. If Reader draws nothing (e.g. it needs usage rights), stop
and come back: the oracle and the "current in Reader" goal both rest on it.

Fixtures go in `test/fixtures/paper-barcode/` with a `PROVENANCE.md` in this
repo's style: Reader version, the probes, capture procedure, hashes, and the
ceiling — one producer, one version, Reader rather than Acrobat Pro.

## Non-goals

- Recomputing Acrobat's XML encoding (recognised and reported only).
- Decoding barcodes from scanned paper.
- Executing any document JavaScript (`test/aform-noexec.test.ts` stays green).
- Byte-identical zlib output for `/DataPrep 1`.
- XFA `<barcode>` fields — `ConvertXfaToAcroForm` keeps refusing them.

## Left to the builder

- Module layout and names (a pure recogniser/reproducer leaf beside
  `afcall.ts`, a `Document`-holding refresh, as `afform.ts` is to `afcall.ts`).
- The exact recogniser strictness, within "never partially understood".
- The report surface for unrecomputed barcodes.
- Default module size when `/PMD` states none.
- Which `/PMD` keys are written, once the probe shows which Reader needs.
- CHANGELOG, README (Key Capabilities, example, API rows) and CLAUDE.md
  entries per the repo's rules.

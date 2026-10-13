# XFA `bind match="global"` -- design (yy09)

## Purpose

`ConvertXfaToAcroForm` reads `<bind match="global">` as an ordinary implicit
name match at the field's own data path. That finds nothing for the forms
that use it, because Designer stores a global field's datum ONCE, directly
under the outermost data group, whatever the field's own depth. The fields
convert with no value -- in the body as well as on master pages, where
`d3mq` creates every instance unbound and warns "not implemented yet (yy09)".

Success: a global field binds to the datum Designer wrote for it, every field
of that name shares it, master-page instances included; the rule is cited
beside the code, every divergence from the spec is stated, and what is not
modelled is reported rather than silently dropped.

## Evidence

**The specification** (XFA 3.3, `xfa_spec_3_3.pdf`, SHA-256
`a3344e7ef0b0da445bcce4323e689e646b31b64ecf1c318a8fc98f6b5edca01e`):

- p. 176, the `match` property: "global -- This is only allowed if the parent
  object is a field ... If the normal matching rules fail to provide a match
  for it, the data-binding process will look outside the current record for
  global data ... a single global data value node can bind to many fields."
- p. 246-247, "Globals": "If a global field in the Form DOM can not be matched
  directly, a match is sought among global data values." "The search ignores
  the depth of the global data value in the data hierarchy; instead it treats
  the Data DOM as though it was completely flattened. If there are multiple
  global data values matching the field, they are treated like siblings and
  the data binding process picks the one with the same index as the current
  record number." "Attributes of global data elements can not bind to
  fields." "Fields in the template sharing the same name must either be all
  global or all non-global. A mixture ... is not supported."
- p. 247: "**In non-record mode there is no such thing as global data and
  marking a field as global has no effect.**"
- p. 92 and p. 136: with record processing not enabled, the whole document is
  one record, the outermost data group. Record mode comes from a config
  `<record>` element (p. 531).
- p. 301: "Any page can contain one or more fields bound to global data" --
  page areas included.
- p. 348: "A field or exclusion group can bind to global data" -- which
  contradicts p. 176's "only allowed if the parent object is a field".

**The corpus.** None of the nine vendored forms carries a config `<record>`,
so by p. 247's letter global is a no-op in all of them. Yet seven use it, 175
fields in all: f1040 and fw9 for "checkbox as radio" groups (same-named
checkboxes sharing one value), I-130 and I-765 to repeat a name on later
pages, OPM 1644, DD 2875 and DD 1494 for CUI marking, start/stop and
classification fields on master pages. Their datasets put each global datum
directly under the outermost group: f1040's
`topmostSubform.Page1.Checkbox_ReadOrder.c1_8` has its datum at
`topmostSubform.c1_8`; I-130's `Pt2Line4a_FamilyName` at
`form1.Pt2Line4a_FamilyName`. Every vendored dataset is blank (`""`, `"0"`,
`"Off"`), so no oracle shows a FILLED value landing.

**pdf.js 6.3.289** (`Binder._bindElement` and `_findDataByNameToConsume`, in
the pinned `pdf.worker.mjs`): a global field tries the ordinary name match
first; failing that, it takes the first node of that name anywhere in the
data, depth first, without consuming it. pdf.js never binds a `<pageArea>`
field (only area, exclGroup, field, subform and subformSet are bindable), so
it corroborates the body half only.

## Decision

**Shared flattened binding, in every form**, record mode or not. It agrees
with Designer's data layout and with pdf.js, and its search is the spec's own
record-mode rule taken at record 0. Departing from p. 247's "no effect" is a
**stated divergence**, recorded beside the code: read literally, every one of
the 175 fields would bind nothing, which is the defect this issue exists for.
Record mode itself (advancing `$record`, per-record indices) is not modelled.

## The rule (`xfadata.ts`, pure)

For a field whose `bindMatch` is `'global'`:

1. **Ordinary match first** -- `values.get(field.dataPath)`, exactly as today.
   A datum at the field's own path wins.
2. **Otherwise, the flattened search:** the FIRST data VALUE in the whole
   `datasets` tree, in document order, whose element name equals the field's
   own name. A data GROUP (an element with children other than `<value>`)
   never matches, and an ATTRIBUTE never matches -- `collect` already records
   leaves only and reads no attributes, so both fall out of the existing
   walk.
3. **Shared, never consumed:** every global field of that name takes the same
   value.

`parseXfaGlobals(root)` builds `name -> first leaf value` once per conversion
in the same depth-first walk `parseXfaDatasets` makes, so the lookup is a map
hit, and the two cannot disagree about document order. `bindFieldValue` takes
it as an optional argument; with none, a global field behaves as today.

The field's own name comes from the template, as `XfaField.dataName` (the
`name` attribute, set only for a named field). Nothing re-splits a data path
on `.`, which an XML name may contain. An UNNAMED field has no global match.

`match="none"` and an explicit `ref` are untouched: `bind` has one `match`.

## Consumers (`xfaconvert.ts`)

- **Body fields** take it through `bindFieldValue` with no further change.
  So does the text measurer (`xfaMeasurer`), so a growable field is sized by
  the value it will carry.
- **Master-page fields** stating `match="global"` now get a value, and every
  instance on every page carries it -- the arrangement `dataRef` already has.
  The "not implemented yet (yy09)" warning is removed. A master-page field
  with neither `dataRef` nor `global` stays unbound, as p. 271 requires.
- **Reported, not modelled** (each one warning, in `report.warnings`):
  - a name that is global on some fields and ordinary on others (p. 247:
    "not supported"); each field still follows its own rule;
  - an `<exclGroup>` stating `match="global"`: p. 176 and p. 348 disagree, no
    vendored form has one, and a group binds by its own data path. It binds
    by that path, as today.

## What changes for hybrids

Global fields on f1040, fw9, I-130 and I-765 now bind their datum, and
`applyReconcile` writes every bound value through the public `Value` setter
WITHOUT comparing first. Every such datum is blank (`""`, `"0"`), so this is
the one place the change can move a vendored result: a setter may refuse a
blank datum (a checkbox handed `"0"`, a choice list handed `""`) and add a
`skipped` entry, or rewrite an appearance. The plan's first task MEASURES the
report and saved-bytes diff on the four hybrids before any rule is changed
further, and each difference is either justified in the CHANGELOG or fixed in
`valueFor` (which already turns a blank choice-list datum into no value,
`cb07`). The Adobe name and rect oracles (`test/xfa-real.test.ts`), the
master oracles and the chrome fence must stay green UNEDITED.

## Testing

- **Unit (`test/xfadata.test.ts`, builder data):** ordinary match outranks
  the global search; the first value in document order wins, depth ignored;
  a data group and an attribute are skipped; two global fields share one
  value; an unnamed field matches nothing; with no globals index a global
  field binds as before.
- **Converter (builder templates):** a body global field binds a datum stored
  at the record root; master-page instances on two pages share it; the
  mixture warning; the exclGroup warning; the yy09 warning is gone.
- **Real data shape:** f1040's `Page1.Checkbox_ReadOrder.c1_8` binds from
  `topmostSubform.c1_8` (its datasets edited to a non-blank value in a copy,
  since the vendored one is blank).
- **pdf.js agreement, body only:** on OPM 1644 (with a datum filled in a
  copy), the global checkboxes take the value pdf.js's rule names -- derived
  from the transcribed rule above, not from running pdf.js.
- **Mutation sweep:** ordinary match first, first-not-last, groups skipped,
  sharing, master wiring, the two warnings. Each must redden alone.

## Out of scope

Record mode and data windows; per-record global indices; `match="global"`
on an `<exclGroup>` (reported); writing data back.

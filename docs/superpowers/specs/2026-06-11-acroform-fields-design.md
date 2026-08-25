# AcroForm fields — enumerate and fill

**Issue:** aspose-pdf-foss-for-ts-jh9
**Date:** 2026-06-11
**Status:** Approved

## Goal

Read the `/Catalog /AcroForm` field tree, enumerate fields (name, type,
value), and set values for text fields, checkboxes, radio groups, and
choice fields. Values are written to the live field dicts so they survive
`Save()`. Appearance streams are never regenerated; instead text/choice
edits set `/NeedAppearances true`, and button edits flip widget `/AS` to
an existing appearance state.

## Scope

- New module `src/form.ts` with `Form` and `Field` classes; `Document.Form`
  getter; exports added to `src/index.ts`.
- Settable: text (Tx), checkbox (Btn), radio group (Btn + radio flag),
  choice (Ch, single and multi-select).
- Read-only enumeration for pushbuttons, signatures, unknown types
  (setter throws `UnsupportedFeatureError`).
- Out of scope: appearance-stream generation, field creation/deletion,
  flattening, JavaScript/calculation actions, XFA (ignored when present),
  rich text (`/RV`), field flags API beyond what classification needs.

## API

```ts
export type FieldType =
  'text' | 'checkbox' | 'radio' | 'choice' | 'pushbutton' | 'signature' | 'unknown';

export class Field {
  readonly Name: string;      // partial name (/T), '' when missing
  readonly FullName: string;  // non-empty partial names joined with '.'
  readonly Type: FieldType;
  readonly Dict: PdfDict;     // the live terminal field dict (escape hatch)
  get Value(): string | string[] | boolean;
  set Value(v: string | string[] | boolean);
  get Options(): string[];
}

export class Form {
  readonly Fields: Field[];                  // terminal fields, tree order
  Get(fullName: string): Field | undefined;  // exact FullName match
}

// Document:
get Form(): Form  // built fresh from the live catalog on each access
```

`Document.Form` rebuilds the tree per access (field trees are small);
`Field` objects are live handles over the real dicts, mirroring `Page`.
No `/AcroForm` in the catalog → a `Form` with `Fields: []`.

## Field-tree walk

- Resolve catalog `/AcroForm` (dict, possibly via ref) → `/Fields` array.
- Recurse over kids: a resolved dict kid **with `/T`** is a child field;
  a kid **without `/T`** is a widget annotation of the current field.
- A field whose kids are all widgets (or that has no kids) is **terminal**
  and becomes a `Field`. Non-terminal fields contribute only their name
  segment.
- `/FT`, `/Ff`, `/V` are inheritable: carried down during the recursion
  (no reliance on `/Parent` backlinks).
- `FullName` joins non-empty `/T` segments with `.`; a missing `/T`
  contributes nothing to the path.
- Cycle-guarded via a seen-set of dicts; non-dict or unresolvable entries
  are skipped silently (same tolerance as `Page.Annotations`).

## Type classification

From inherited `/FT` and `/Ff` (default 0):

| FT  | Ff bits                  | Type       |
|-----|--------------------------|------------|
| Tx  | —                        | text       |
| Btn | bit 17 (1<<16) set       | pushbutton |
| Btn | bit 16 (1<<15) set       | radio      |
| Btn | neither                  | checkbox   |
| Ch  | —                        | choice     |
| Sig | —                        | signature  |
| other/absent | —               | unknown    |

## Value getter

- **text**: `/V` text string decoded with `decodePdfText`; `''` when
  absent or not a string.
- **checkbox**: `true` iff `/V` is a name other than `Off`.
- **radio**: the `/V` name string; `''` when absent.
- **choice**: `/V` string → decoded string; `/V` array → `string[]` of its
  decoded string elements; `''` when absent.
- **pushbutton / signature / unknown**: `/V` decoded when it is a string
  or name, else `''`.

## Value setter

General rules: the value is written to the terminal field dict (`/V`);
a JS value whose type does not match the field type throws `TypeError`;
pushbutton/signature/unknown throw `UnsupportedFeatureError`. Widgets of
a field are the field dict itself when merged (the common single-widget
case: the dict has `/Subtype /Widget`) or the `/Kids` entries otherwise.

- **text** (`string`): `/V` ← `encodePdfText` string; set
  `/NeedAppearances true` on the AcroForm dict.
- **checkbox** (`boolean`): the widget's on-state is the first key of its
  `/AP /N` dict that is not `Off` (fallback `Yes`). `true` → `/V` and
  each widget `/AS` ← on-state name; `false` → `Off`. NeedAppearances is
  NOT set (existing appearance states are reused).
- **radio** (`string`): must equal `Off` or an on-state of at least one
  kid widget, else `RangeError`. `/V` ← name; each kid widget `/AS` ← the
  value when that widget has a matching `/AP /N` state, else `Off`.
  NeedAppearances NOT set.
- **choice** (`string | string[]`): an array is allowed only when the
  multi-select flag (bit 22, 1<<21) is set, else `TypeError`. When `/Opt`
  exists and the field is not an editable combo (combo bit 18 (1<<17) +
  edit bit 19 (1<<18)), each value must be an `/Opt` export value, else
  `RangeError`. `/V` ← string or array of strings; any `/I` entry is
  deleted (stale indices); set `/NeedAppearances true`.

Setting NeedAppearances writes the live resolved `/AcroForm` dict.

## Options getter

- **choice**: `/Opt` entries; a `[export, display]` pair contributes its
  export (first) element; strings decoded; non-conforming entries skipped.
- **checkbox / radio**: union of non-`Off` `/AP /N` keys across the
  field's widgets, in widget order.
- **other types**: `[]`.

## Error handling

- Malformed tree nodes are skipped during enumeration, never thrown.
- Setter validation errors (`TypeError`, `RangeError`,
  `UnsupportedFeatureError`) leave the document unmodified.
- Encrypted documents need no special handling: objects are decrypted at
  load and `Save()` writes unencrypted output.

## Testing

New fixture `test/helpers/build-form-pdf.ts`: a classic-xref one-page PDF
with a text field, a checkbox (with `/AP /N` Off/Yes states), a radio
group (two kid widgets, distinct export values), a choice field with
`/Opt`, and a hierarchical `parent.child` text field whose `/FT` lives on
the parent.

`test/form.test.ts`:

1. Enumeration lists all terminal fields with correct
   Name/FullName/Type/Value; `Form.Get` finds by FullName.
2. Inherited `/FT`/`/V` resolve through the hierarchy (`parent.child`).
3. Text set → value reads back; survives `Save()` + reopen;
   `/NeedAppearances` is true.
4. Checkbox `true`/`false` → `/V` and `/AS` flip to `Yes`/`Off`;
   round-trips; NeedAppearances untouched by button-only edits.
5. Radio set to each export value → `/V` set, the matching widget's `/AS`
   on, the other `Off`; invalid value → `RangeError`.
6. Choice set to a valid option round-trips; invalid option →
   `RangeError`; array on non-multiselect → `TypeError`.
7. Type mismatches throw `TypeError`; signature/pushbutton setters throw
   `UnsupportedFeatureError`.
8. Document without `/AcroForm` → `Form.Fields` is `[]`.
9. `Options` returns choice exports and checkbox/radio on-states.

README gets a short Form usage section.

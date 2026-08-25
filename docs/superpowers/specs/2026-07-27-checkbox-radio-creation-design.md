# Checkbox and radio-group creation

Issue: `aspose-pdf-foss-for-ts-dbpr.3`
Epic: `aspose-pdf-foss-for-ts-dbpr` (interactive form-field creation)
Builds on: `dbpr.1` (`2026-07-27-form-field-creation-design.md`),
`dbpr.2` (`2026-07-27-text-field-flags-design.md`)

`dbpr.1` shipped the creation machinery and a text-field slice; `dbpr.2` added
the text flags. This issue adds the two button field types: checkboxes, and
radio groups whose kid widgets may sit on different pages.

It is also the first caller of the non-merged field shape — a parent field with
N kid widgets — which is why `dbpr.1` exported `resolvePath`, `buildWidgetDict`
and `attachWidget` alongside the all-in-one `createField`.

## Scope

In scope:

- `Form.AddCheckbox` / `Page.AddCheckbox`, with an export value and an initial
  checked state.
- `Form.AddRadioGroup`, with per-option page and rect, export values, and an
  optional initial selection.
- `/AP` generation for both, keyed by the export name we actually chose rather
  than by a heuristic's guess.
- Extracting `buildButtonAP` from `generateFieldAppearance` so creation and
  regeneration share the drawing code without sharing the guess.
- A `buildAP` hook on `FieldSpec`, so a field type can supply its own appearance
  instead of the default value-driven generation.

Out of scope, deliberately:

- **New members on `CheckboxField` and `RadioField`.** `Field.Value` already
  returns a boolean for a checkbox and the on-state name for a radio group, and
  `Field.Options` already returns the export names read off the `/AP` states.
  `Checked` and `Selected` accessors would be pure aliases. Go has them only
  because its `Value()` returns a string for every field type.
- **`Page.AddRadioGroup`.** A group's widgets may span pages, so binding one
  page to the call would be misleading. `Form.AddRadioGroup` is the only entry
  point. `Page.AddCheckbox` does exist — a checkbox is single-widget.
- **`NoToggleToOff` and `RadiosInUnison`.** No `dbpr` issue covers them and
  nothing reads them today.
- **Choice and push-button fields** — `dbpr.4` and `dbpr.5`.

## Architecture

### Splitting the guess from the drawing

`generateFieldAppearance`'s checkbox/radio branch currently decides the on-state
name (`synthOnState`, which tries `/AS`, then `/Opt[widgetIndex]`, then `/V`,
then falls back to `'Yes'`) *and* builds the two appearance streams. The guess
exists because that function's job is regenerating documents we did not author.
At creation we know the name outright.

So the drawing half becomes an export:

```ts
/** Build and install a button widget's /Off and on-state appearances
 *  (/AP /N /<onState> and /AP /N /Off). */
export function buildButtonAP(
  doc: Document, widget: PdfDict, onState: string, kind: 'checkbox' | 'radio',
): void
```

The ZapfDingbats glyph bodies, the `zapfResources` font dict and the `mkOps`
background stay in `appearance.ts`. `generateFieldAppearance` calls
`buildButtonAP` with `synthOnState`'s result; `formcreate.ts` calls it with the
export name the caller gave. The heuristic stays confined to the read path.

Aspose-PDF-FOSS-for-Go solves the same problem by seeding `/AP /N` with empty
placeholder dicts keyed by the state names, purely so its regenerator can read
the names back out, then overwriting them. We reject that: it puts structurally
invalid objects into the document between the two steps, and any early return
leaves them there.

### The `buildAP` hook

`createField` ends by calling `generateFieldAppearance`. For a button that would
fire the guess before anything had been installed. `FieldSpec` therefore gains:

```ts
/** Build this field's /AP instead of the default value-driven generation. */
buildAP?: (doc: Document, dict: PdfDict) => void;
```

`createField` calls `spec.buildAP(doc, dict)` when present and
`generateFieldAppearance(...)` otherwise. Explicit, rather than relying on
`hasNStates` making the generator quietly no-op afterwards — that coupling would
be invisible and would break silently if the preservation rule ever changed.
`dbpr.4` and `dbpr.5` need the same seam.

### Radio groups use the non-merged shape

A checkbox is one merged field/widget dict and goes through `createField`
unchanged. A radio group cannot: it is a parent field carrying `/Kids`, with the
widgets as separate objects, potentially on different pages.

`addRadioGroup` therefore composes the exported pieces directly — `resolvePath`
for the field-tree slot, `buildWidgetDict` per option, `attachWidget` to reach
each option's own page `/Annots` — and allocates the parent itself.

## Public API

```ts
/** Options for Form.AddCheckbox / Page.AddCheckbox. */
export interface CheckboxInit extends FieldInit {
  /** /AP on-state name, which is also the export value. Default 'Yes'. */
  exportValue?: string;
  /** Initial state. Default false. */
  checked?: boolean;
}

/** One button of a radio group. */
export interface RadioOption {
  /** 1-based page number carrying this widget. */
  page: number;
  rect: [number, number, number, number];
  /** /AP on-state name for this kid, and its export value. */
  export: string;
}

/** Options for Form.AddRadioGroup. */
export interface RadioGroupInit {
  /** Fully-qualified field name; '.' separates hierarchy levels. */
  name: string;
  /** At least one option. */
  options: RadioOption[];
  /** Initially selected export value. Default: nothing selected (/V /Off). */
  selected?: string;
  readOnly?: boolean;
  required?: boolean;
}

Form.AddCheckbox(init: CheckboxInit): CheckboxField
Page.AddCheckbox(init: Omit<CheckboxInit, 'page'>): CheckboxField
Form.AddRadioGroup(init: RadioGroupInit): RadioField
```

`RadioGroupInit` deliberately does not extend `FieldInit`: `page`, `rect` and
the `/DA` options (`font`, `fontSize`, `textColor`) are either per-option or
meaningless for a field that draws no text.

### Written structure

A checkbox — one object:

```
<< /Type /Annot /Subtype /Widget /FT /Btn /T (agree)
   /V /Off /AS /Off /Rect [...] /P 3 0 R /F 4
   /AP << /N << /Yes 12 0 R /Off 13 0 R >> >> >>
```

A radio group — a parent plus one object per option:

```
parent: << /FT /Btn /Ff 32768 /T (color) /V /red /Kids [11 0 R 12 0 R] >>
kid:    << /Type /Annot /Subtype /Widget /Parent 10 0 R /Rect [...] /P 3 0 R
           /F 4 /AS /red /AP << /N << /red 13 0 R /Off 14 0 R >> >> >>
```

The parent has no `/Subtype` and no `/Rect`: it is a field, not an annotation.
That is also what makes the existing `Form` walk classify it as a terminal radio
field whose `/Kids` are widgets rather than child fields.

## Validation

Everything is checked before the first object is allocated, so a rejected call
leaves the document byte-identical — the invariant `dbpr.1` established.

| Rejected | Error |
|---|---|
| `options` empty or not an array | `TypeError` |
| an `export` that is not a non-empty string | `TypeError` |
| a duplicate `export` within the group | `RangeError` |
| an `export` of `'Off'` | `RangeError` |
| `selected` matching no `export` | `RangeError` |
| any option's `page` out of range, or `rect` malformed | `RangeError` / `TypeError` |
| a checkbox `exportValue` of `'Off'`, or not a non-empty string | `RangeError` / `TypeError` |

`'Off'` is reserved: it is the name every button's unselected appearance uses,
so an option claiming it would collide with its own off state.

For radio groups this up-front pass is load-bearing in a way it is not for a
single field. Allocating the parent, wiring two kids, and *then* rejecting item
three would leave an orphan parent and two widgets attached to pages.

## Testing

New cases in `test/form-create.test.ts`:

- **Checkbox structure**: `/FT /Btn` with no radio bit, `/V` and `/AS` both
  `/Off`, `/AP /N` carrying the export name and `Off`; `checked: true` sets both
  `/V` and `/AS` to the export name.
- **The case the guess gets wrong**: an *unchecked* checkbox with
  `exportValue: 'On'` has `/AS /Off`, `/V /Off` and no `/Opt`, so `synthOnState`
  would fall through to its `'Yes'` default. The `/AP /N` keys must be `On` and
  `Off`.
- **Radio parent shape**: no `/Subtype`, no `/Rect`, radio bit set, `/Kids` of
  the right length; each kid has a `/Parent` back-link.
- **Per-option pages**: with options on pages 1 and 2, each widget appears in
  its own page's `/Annots` and nowhere else.
- **Selection**: `selected` sets the parent `/V` and exactly one kid's `/AS`;
  the rest are `/Off`.
- **Read-back with no new members**: `Type` is `'checkbox'` / `'radio'`,
  `Options` lists the export names, `Value` is the boolean / on-state name.
- **The existing setters drive created fields**: `.Value = 'green'` flips `/AS`
  across kids and updates `/V`; `.Value = true` checks a created checkbox.
- **Atomicity**: each rejection throws and leaves the saved byte length
  unchanged — which for a radio group is what catches an orphan parent.
- **Round-trip**: a two-page group survives `Save`/`Open` with `Options` and
  `Value` intact.

Per `CLAUDE.md`, two assertions are proven by mutation rather than by watching
them go green:

- Make `buildButtonAP` ignore its `onState` argument and use `'Yes'` — the
  `exportValue: 'On'` test must go red.
- Move the radio option validation after the parent allocation — the atomicity
  test must go red.

`npm run typecheck` and the full `npm test` must be green before the issue
closes. `README.md`'s form section gains both entry points.

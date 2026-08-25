# Combo box and list box creation

Issue: `aspose-pdf-foss-for-ts-dbpr.4`
Epic: `aspose-pdf-foss-for-ts-dbpr` (interactive form-field creation)
Builds on: `dbpr.1` (`2026-07-27-form-field-creation-design.md`),
`dbpr.2` (`2026-07-27-text-field-flags-design.md`),
`dbpr.3` (`2026-07-27-checkbox-radio-creation-design.md`)

Adds the two choice field types — combo boxes and list boxes — with `/Opt`
option lists, export values distinct from displayed text, and the Edit and
MultiSelect flags.

It also fixes two rendering defects that creation exposes. Both come from the
same root cause: the appearance code keeps only the *display* half of each
`/Opt` entry and throws the *export* half away, while `/V` holds the export.
Neither is reachable today only because nothing could author a paired `/Opt`.

## Scope

In scope:

- `Form.AddComboBox` / `Page.AddComboBox`, with an `editable` flag.
- `Form.AddListBox` / `Page.AddListBox`, with a `multiSelect` flag.
- `/Opt` entries in both forms: a plain string, or an `[export, display]` pair.
- `/V` and `/I` for the initial selection.
- `ChoiceField.Combo`, `.Editable`, `.MultiSelect`.
- Fixing list-box selection matching and combo display text for
  `export ≠ display`, on the read path as well as for created fields.

Out of scope, deliberately:

- **New value accessors.** `Field.Value` already returns a string or `string[]`
  for a choice field, and `Field.Options` already returns the export values.
  `dbpr.3` set the precedent: no aliases.
- **Option-list mutation** (`AddOption` / `RemoveOption`). Go has them; no
  `dbpr` issue covers them, and nothing needs them to create a field. Filed as
  a follow-up.
- **`/TI`** (index of the first visible option). The list-box renderer honours
  it, but it is viewer-managed scroll state rather than authored content.
- **`/Ff` Sort and CommitOnSelChange.** Nothing reads them today.
- **Push buttons** — `dbpr.5`.

## Architecture

### One `/Opt` parse, two consumers

`optionLabels` currently returns display strings only:

```ts
if (isArray(r)) { const disp = doc.resolve(r[1] ?? r[0]); ... }   // display
else if (isString(r)) out.push(decodePdfText(r.bytes));
```

while `Field.Options` reads `r[0]` — the export. `/V` holds the export value,
which is what makes both renderers wrong when the two differ:

| Defect | Today | After |
|---|---|---|
| **List box.** `selectedIndices` falls back to `labels.indexOf(textOf(value))` — an export compared against display labels. | no row highlighted | match export first, then display |
| **Combo box.** The branch renders `singleLineText(textOf(value), …)` — `/V` verbatim. | draws `gb` | draws `United Kingdom` |

`optionLabels` is therefore replaced by a parse returning
`{ export: string; display: string }[]` (with `display` defaulting to `export`
for a plain string entry), and both consumers derive from it.

The combo falls back to rendering the raw `/V` when it matches no option: an
editable combo's free text must render as typed.

The list-box fallback matters more than it looks. `Field.setChoice` deletes
`/I` on every write — correctly, since the indices would otherwise be stale —
so the fallback is the normal path after any value change, not an edge case.

### `/I` at creation

Creation writes `/I` for the selected options: an ascending array of zero-based
`/Opt` indices, as PDF 32000-1 requires. It is a fast path that
`selectedIndices` reads before falling back.

`/I` is not state we maintain: the first `.Value = x` drops it, and the fixed
fallback covers everything from then on. Writing it at creation costs nothing
and matches what viewers emit.

An editable combo whose value matches no option gets no `/I` at all, since
there is no index to record.

## Public API

```ts
/** One option of a choice field. A bare string is an option whose export value
 *  and displayed text are the same. */
export type ChoiceOption = string | { export: string; display?: string };

/** Options common to both choice field types. */
export interface ChoiceInit extends FieldInit {
  /** The option list. May be empty. */
  options: ChoiceOption[];
  /** Initially selected export value(s). An array requires multiSelect. */
  value?: string | string[];
}

/** Options for Form.AddComboBox / Page.AddComboBox. */
export interface ComboBoxInit extends ChoiceInit {
  /** /Ff Edit (spec bit 19): the user may type a value not in the list. */
  editable?: boolean;
}

/** Options for Form.AddListBox / Page.AddListBox. */
export interface ListBoxInit extends ChoiceInit {
  /** /Ff MultiSelect (spec bit 22): more than one option may be selected. */
  multiSelect?: boolean;
}

Form.AddComboBox(init: ComboBoxInit): ChoiceField
Page.AddComboBox(init: Omit<ComboBoxInit, 'page'>): ChoiceField
Form.AddListBox(init: ListBoxInit): ChoiceField
Page.AddListBox(init: Omit<ListBoxInit, 'page'>): ChoiceField
```

Both field types are single-widget merged field/widget dicts, so both go through
`createField` and both get `Page` forwarders — unlike a radio group, which spans
pages and has none.

Both return the same `ChoiceField`: our reader classifies combo and list boxes
alike as `'choice'` (they differ only by `/Ff` Combo), so splitting the handle
would contradict the read path. Go splits them only because its `FieldType`
enumeration does.

`ChoiceField` gains only the flags:

```ts
get Combo(): boolean          // read-only: renders as a dropdown, not a list
get/set Editable: boolean     // combo only
get/set MultiSelect: boolean  // list only
```

`Combo` is read-only. Flipping a populated list box into a dropdown is legal but
is a different field, not a property change, and nothing needs it.

## Validation

Checked before anything is allocated, so a rejected call leaves the document
byte-identical.

| Rejected | Error |
|---|---|
| `options` not an array | `TypeError` |
| an entry that is neither a string nor an object with a string `export` | `TypeError` |
| an empty `export`, or a non-string `display` | `TypeError` |
| a duplicate `export` | `RangeError` |
| `value` given as an array on a field without MultiSelect | `TypeError` |
| a `value` matching no export — unless the field is an editable combo | `RangeError` |
| `editable` on a list box | `RangeError` |
| `multiSelect` on a combo box | `RangeError` |

The last two follow `dbpr.2`'s comb precedent: the specification calls Edit
meaningful only with Combo, so writing a flag no viewer will honour is worse
than refusing it. Both are enforced on the `Editable` / `MultiSelect` setters as
well, so the combination cannot be reached from either side.

An **empty `options` array is allowed**: an editable combo with no predefined
options is a legitimate free-text dropdown.

The "unless editable" exemption mirrors `Field.setChoice`, which already skips
`/Opt` validation for an editable combo.

## Testing

New cases in `test/form-create.test.ts`, with the read-path fixes in
`test/form-appearance.test.ts`:

- **`/Opt` encoding.** A bare string writes a plain string; `{export, display}`
  writes a two-element array; `{export}` alone writes a plain string.
- **Round-trip.** `Field.Options` returns the exports; a `Save`/`Open` cycle
  preserves both halves of a paired entry.
- **Flags.** Combo writes `FF_COMBO`, `+FF_EDIT` when editable; list writes
  neither, `+FF_MULTISELECT` when multi-select. Asserted against the numeric
  spec-bit literals, not against our own constants.
- **Selection.** `/V` and `/I` for a single value and for an array; `/I`
  ascending; `/I` absent when an editable combo holds free text.
- **The list-box fix.** With `export ≠ display` and a selection, the `/AP`
  highlights the row whose export matches.
- **The combo fix.** With `export ≠ display`, the `/AP` draws the display text
  and does not contain the export value.
- **Both fixes on the read path.** A hand-built fixture carrying a paired
  `/Opt` renders correctly through `Form.GenerateAppearances()` — proving the
  fix reaches documents we did not author.
- **Editable free text** is accepted; the same value on a non-editable combo
  throws.
- **Rejections** each leave the saved byte length unchanged.
- **The existing setters** drive created fields, including assigning a
  `string[]` to a multi-select list box.

Per `CLAUDE.md`, two assertions are proven by mutation rather than by watching
them go green:

- Revert `selectedIndices` to matching display labels only — the list-box
  highlight test must go red.
- Make the combo branch render `textOf(value)` again — the display-text test
  must go red.

`npm run typecheck` and the full `npm test` must be green before the issue
closes. `README.md`'s form section gains both entry points.

# Text-field flags: Multiline, Password, Comb, MaxLen, ReadOnly, Required

Issue: `aspose-pdf-foss-for-ts-dbpr.2`
Epic: `aspose-pdf-foss-for-ts-dbpr` (interactive form-field creation)
Builds on: `dbpr.1` (`docs/superpowers/specs/2026-07-27-form-field-creation-design.md`)
Blocks: `dbpr.6` (field styling)

`dbpr.1` shipped `Form.AddTextField` / `Page.AddTextField` with a value, a `/DA`
and a generated `/AP`. This issue adds the text-field flags: settable at
creation, and mutable afterwards on any text field — including one read from a
document we did not author.

Two of the three renderers these flags select are already implemented and
tested in `appearance.ts` (`multilineText`, `combText`); nothing could reach
them, because nothing could set the flags. The third case, Password, is not
implemented at all and is a live defect: `generateFieldAppearance` paints
`textOf(value)` unconditionally, so a password field's plaintext reaches the
content stream.

## Scope

In scope:

- `TextFieldInit` options: `multiline`, `password`, `comb`, `maxLen`.
- Accessors on `TextField`: `Multiline`, `Password`, `Comb`, `MaxLen`; and on
  the base `Field`: `ReadOnly`, `Required`. All regenerate the `/AP`.
- Password masking in `generateFieldAppearance`.
- One shared `/Ff` constants module, replacing three partial copies.
- Validation of the pairings the PDF specification forbids.

Out of scope, deliberately:

- **Other field types** — `dbpr.3`–`.5`.
- **Styling** — `/MK` border and background, `/BS`, `/Q` quadding: `dbpr.6`.
  The `/DA` half (`font`, `fontSize`, `textColor`) already shipped in `dbpr.1`.
- **`FileSelect`, `RichText`, `DoNotSpellCheck`, `DoNotScroll`.** Go exposes the
  first two as separate field *types* (`FileSelectBoxField`, `RichTextBoxField`)
  with `/RV` handling and format `/AA` actions behind them. That is a larger
  surface than a flag, and no `dbpr` issue covers it. Filed as a follow-up.
- **Refusing to write `/V` on a password field.** A conforming viewer does not
  save a password field's value, but neither Aspose nor Go refuses to set one,
  and the model layer is not where that policy belongs. We mask the appearance;
  `Field.Value` still returns the plaintext, because that is the model.

## Architecture

### One flag-constants module

`/Ff` bit constants are currently defined three times:

| Module | Defines |
|---|---|
| `appearance.ts` | `FF_MULTILINE`, `FF_COMB`, `FF_COMBO` |
| `formfield.ts` | `FF_RADIO`, `FF_PUSHBUTTON`, `FF_COMBO`, `FF_EDIT`, `FF_MULTISELECT` |
| `formcreate.ts` | `FF_READONLY`, `FF_REQUIRED` |

This issue would add `FF_PASSWORD` to a fourth place and `FF_COMB` to a second.
New `src/fieldflags.ts` carries the whole set once — PDF 32000-1 tables 226
(common), 228 (text), 229 (button) and 230 (choice) — each constant commented
with its **1-based specification bit number**, since that is where the error
lives: `FF_COMB` is spec bit 25 and therefore `1 << 24`, and an off-by-one
produces a flag that is silently wrong rather than obviously broken. The three
modules import from it and define none of their own.

This is a targeted improvement, not speculative refactoring: the duplication is
directly in the path of this change.

### Password masking

In `generateFieldAppearance`'s `case 'text'`, the shown string is derived from
the value before any renderer is chosen:

```ts
const plain = textOf(value);
const shown = (ff & FF_PASSWORD) ? '•'.repeat([...plain].length) : plain;
```

One WinAnsi bullet (`0x95`) per character. The existing comb / multiline /
single-line renderers then run unchanged, so measurement, auto-sizing and
clipping stay correct — they measure the bullets that are actually drawn.
Counting with `[...plain]` rather than `.length` means an astral character
masks as one bullet rather than two.

**This lands on the read path too.** `Field.GenerateAppearance()`,
`Form.GenerateAppearances()` and `FlattenForm()` all route through
`generateFieldAppearance`, so password fields in documents we did not author
are masked as well. That is the point rather than a side effect: flattening a
password field previously baked its plaintext into permanent page content,
where no viewer would ever mask it again.

### Mutable flags

`Field.ff` is the effective `/Ff` captured during the tree walk, and
`GenerateAppearance()` reads it. A setter that writes `/Ff` on the dict without
refreshing that field would regenerate the appearance from the *old* flags —
the new value stored, the old rendering drawn.

So `ff` loses `readonly`, and `Field` gains:

```ts
/** Set or clear one /Ff bit on the dict, keep the cached effective flags in
 *  step, and regenerate the appearance. */
protected setFlag(bit: number, on: boolean): void;
```

`dbpr.3`–`.5` reuse it for checkbox `Required`, choice `MultiSelect`, and the
rest.

## Public API

```ts
export interface TextFieldInit extends FieldInit {
  value?: string;
  /** /Ff Multiline (spec bit 13): wrap the value across lines. */
  multiline?: boolean;
  /** /Ff Password (spec bit 14): the appearance shows bullets, not the value. */
  password?: boolean;
  /** /Ff Comb (spec bit 25): evenly spaced cells. Requires maxLen > 0. */
  comb?: boolean;
  /** /MaxLen: maximum character count; 0 or absent means unlimited. */
  maxLen?: number;
}
```

Accessors, each regenerating the `/AP` on write:

| Class | Members |
|---|---|
| `Field` | `ReadOnly: boolean`, `Required: boolean` |
| `TextField` | `Multiline: boolean`, `Password: boolean`, `Comb: boolean`, `MaxLen: number` |

`ReadOnly` and `Required` live on the base class, matching where they already
sit in `FieldInit` — they are field-type-neutral.

`MaxLen` reads `0` when `/MaxLen` is absent, and writing `0` deletes the entry
rather than storing a meaningless limit.

## Validation

The PDF specification forbids three combinations. Each is rejected at the API
edge — in `addTextField` **and** in the corresponding setter — rather than
silently ignored, because each currently renders as something the caller did not
ask for:

| Rejected | What happens without the check | Error |
|---|---|---|
| `comb` without `maxLen > 0` | `appearance.ts` falls through to a plain single line | `RangeError` |
| `comb` with `multiline` | multiline silently wins in `appearance.ts` | `RangeError` |
| `comb` with `password` | bullets in comb cells; spec forbids the pair | `RangeError` |
| `maxLen` negative, or not an integer | a nonsense `/MaxLen` is stored | `TypeError` |

Setting `MaxLen = 0` while `Comb` is on throws, so the pair cannot be broken
from either side. This follows `dbpr.1`'s convention: `TypeError` for a
malformed argument, `RangeError` for a well-formed but rejected value.

As in `dbpr.1`, validation precedes mutation, so a rejected call leaves `/Ff`
and `/MaxLen` untouched.

## Testing

Extending `test/form-create.test.ts`, with the masking cases in
`test/form-appearance.test.ts`:

- **Flag bits.** Each flag round-trips through `Save`/`Open` as the right `/Ff`
  bit, asserted against the numeric literal from the specification table rather
  than against our own constant — a test that imports the constant it is
  checking cannot catch a mis-numbered bit.
- **Renderers reached.** `multiline: true` yields a multi-line `/AP` (more than
  one positioned run); `comb: true, maxLen: 9` yields nine.
- **Password masking.** The `/AP` content stream contains no byte of the
  plaintext, contains the bullet, and the bullet count equals the value length.
- **Masking on the read path.** `Form.GenerateAppearances()` masks a password
  field in a pre-existing fixture, and `FlattenForm()` produces baked page
  content with no plaintext in it.
- **Setters regenerate.** Flipping `Multiline` on a filled field changes the
  `/AP` stream bytes.
- **The stale-cache trap.** Set a flag, then call `GenerateAppearance()`
  explicitly and confirm the new flag took effect — this is what catches a
  `setFlag` that updates the dict but not `this.ff`.
- **Rejected pairings.** Each throws, and `/Ff` and `/MaxLen` are unchanged
  afterwards.

Per `CLAUDE.md`, the two load-bearing assertions are proven by mutation rather
than by watching them go green:

- Drop the `this.ff` update from `setFlag` — the stale-cache test must go red.
- Remove the mask — the plaintext-absence assertion must go red.

`npm run typecheck` and the full `npm test` must be green before the issue
closes. `README.md`'s form section gains the flags.

# Recognising the standard AF* form calls natively (jzn8)

## Why

6t2v.2 decided that document-supplied JavaScript is never executed. A filled
form therefore shows stale totals and unformatted values, and its own input
rules reject nothing. Most real forms do not use free-form script for these
jobs. They call Acrobat's standard AForm functions with literal arguments:
`AFSimple_Calculate("SUM", ["a","b"])` or `AFNumber_Format(2,0,0,0,"$",true)`.
This feature recognises those call **shapes** and implements their semantics
natively. The library still executes no JavaScript: no `eval`, no `vm`, and no
general JS parser.

**Intended use:** server-side fill. A caller fills a form in code, then saves
or flattens it. Totals should be right, appearances should show formatted
values, and the form's own input rules should be checkable.

## Decisions (from the brainstorm)

| Question | Decision |
|---|---|
| Families | Calculate, format, keystroke (commit-time) and validate |
| Rejected value | Reported by an explicit call **and** refusable on set through an opt-in |
| When it runs | Every piece is an explicit opt-in, so existing calls stay byte-identical |
| Recogniser | A tiny purpose-built call grammar (not regexes, not a JS parser) |
| Oracle | Goldens generated from pdf.js's Apache-2.0 AForm, commit `d52fdf411a6e4d338180687456e0df019e28475e` |

## 1. Recogniser: `afcall.ts`

`parseAfCall(script: string): AfCall | undefined`, a pure leaf that imports
nothing.

- **Grammar.** Optional whitespace and `//` or `/* */` comments, then one
  identifier `AF[A-Za-z_]+`, `(`, zero or more comma-separated arguments, `)`,
  an optional `;`, and end of input.
- **Arguments.** A number (optional sign, integer or decimal), a single- or
  double-quoted string with JavaScript's simple escapes (`\\ \' \" \n \r \t`),
  `true`/`false`, or an array of strings.
- **Refusals.** Anything else returns `undefined`: a second statement, an
  identifier or expression as an argument, a `\u` or `\x` escape, or trailing
  code. Nothing is partially recognised.
- **Known names.** A table maps each name to its arity and argument types.
  Required arguments are checked, optional trailing ones may be omitted, and a
  wrong type is unrecognised rather than coerced. The names are
  `AFNumber_Format`, `AFNumber_Keystroke`, `AFPercent_Format`,
  `AFPercent_Keystroke`, `AFDate_Format`, `AFDate_FormatEx`,
  `AFDate_Keystroke`, `AFDate_KeystrokeEx`, `AFTime_Format`,
  `AFTime_FormatEx`, `AFTime_Keystroke`, `AFTime_KeystrokeEx`,
  `AFSpecial_Format`, `AFSpecial_Keystroke`, `AFSpecial_KeystrokeEx`,
  `AFRange_Validate` and `AFSimple_Calculate`.

## 2. Semantics: pure leaves

Each module transcribes the pinned pdf.js code (`src/scripting_api/aform.js`,
`util.js` and `../shared/scripting_utils.js`). None touches a `Document`.

- **`afnumber.ts`** covers `AFMakeNumber`, the `AFNumber_*` and `AFPercent_*`
  format and keystroke functions, and the subset of `util.printf` they use
  (`%,<sep>.<dec>f`, separator styles 0-4).
- **`afdate.ts`** covers `AFDate_*` and `AFTime_*`, the `printd`/`scand`
  picture grammar, and the `DateFormats`/`TimeFormats` tables. It works on
  year, month, day, hour, minute and second directly and never goes through a
  local-time `Date`.
- **`afspecial.ts`** covers `AFSpecial_Format` (psf 0-3) and the special
  keystroke masks.
- **`afcalc.ts`** covers `AFSimple_Calculate`, whose five operations round to
  6 decimals and treat an unparseable operand as 0, and `AFRange_Validate`.
  The sum uses `Math.sumPrecise` where available, otherwise compensated
  summation.

`afform.ts` is the one module that touches a `Document`. It resolves field
names, walks `/CO`, and wires the modules into the API. The split is the same
one `svgdraw.ts`/`svgembed.ts` make.

## 3. Public API

A call that passes none of the new options produces the same bytes as today.

- **`form.Recalculate(): RecalculateReport`.** Walks `/AcroForm /CO` in order,
  once, which is Acrobat's model. For each field whose calculate script is a
  recognised `AFSimple_Calculate`, it computes the result and stores
  `String(result)` through the existing `Value` setter. The report carries:
  - `changed`: field, old value and new value;
  - `unrecognised`: a calculate script that is not one recognised call;
  - `notInOrder`: a field with a calculate script that `/CO` does not list.
    Acrobat never runs those, so neither do we.

  An unchanged value is not written, so a no-op call marks nothing modified.
- **`field.FormattedValue: string | undefined`.** The value as the recognised
  format script would display it, or `undefined` when the field has none.
  Read-only.
- **Formatted appearances, opt-in with `{ format: true }`.** Available on
  `GenerateAppearances`, `field.GenerateAppearance`, `doc.FlattenForm` and
  `field.Flatten`. Each draws `FormattedValue` where it exists and the raw
  value otherwise. `/V` always stays raw, and a password field stays masked.
- **`form.CheckValues(): ValueCheckReport`.** Checks each field's current
  value against its recognised commit-time keystroke rule and its recognised
  validate rule. It returns rejections as
  `{ field, trigger: 'keystroke' | 'validate', rule, value, message }`, plus a
  separate `unrecognised` list. An empty value passes.
- **`form.EnforceRules = true`** (default `false`). The `Value` setter runs the
  same checks first. A rejected value throws `RangeError` naming the field,
  the rule and the value, and leaves the document byte-identical.

## 4. Edge cases and errors

- **Nothing throws** except the opt-in refusal. Everything else degrades to
  *unrecognised* or *unchanged*.
- **Field names.** A name in `AFSimple_Calculate` that names a group expands to
  every terminal field below it, through `Form`'s tree walk. A name that
  resolves to nothing is skipped. Names may be an array or one comma-separated
  string (`AFMakeArrayFromList`).
- **Order.** A calculated result is stored even if that field's own validate
  rule rejects it, because Acrobat calculates and then validates.
  `CheckValues()` reports the rejection.
- **Signed documents.** `Recalculate()` is not refused. Changing `/V` is
  filling, which DocMDP permits, and the caller asked for it. The README says
  so.
- **Field types.** `Recalculate` writes only to text fields; a calculate
  script on any other field type is reported in `unrecognised`. An operand
  field whose value is not a string (a checkbox, a multi-select list) reads as
  `''`, which counts as 0.
- **Arguments pdf.js would throw on** (a date or time format index outside its
  table, a `psf` outside 0-3, `nDec` outside 0-100, a currency string
  containing `%`, an unknown `AFSimple_Calculate` operation) make the call
  unrecognised rather than an error.
- **Bounds.** Script text is already bounded when the file is parsed, by
  `maxObjectBytes` like any string, and the recogniser is one linear pass.

### Stated divergences from pdf.js

Each divergence is excluded from the goldens by a computed predicate, never by
a file list, and the excluded counts are asserted.

1. **Strict date matching only.** A date value that does not match its picture
   exactly (pdf.js's `_scand(format, value, true)` returns null) is left
   unformatted and is rejected by the keystroke check. pdf.js then tries two
   fallbacks, and neither is deterministic: `#tryToGuessDate` defaults the
   year to the CURRENT year, and `Date.parse` depends on the engine and the
   time zone.
2. **No red text.** `AFNumber_Format` negative styles 1 and 3 draw
   parentheses but not the red colour.
3. **No normalisation under `EnforceRules`.** The setter accepts or rejects a
   value but never rewrites it. pdf.js's `AFNumber_Keystroke` turns a
   comma-decimal commit into a dot.

## 5. Oracle and tests

- **Generator.** `scripts/gen-aform-goldens.mjs`, not run by `npm test`.
  Checks out pdf.js at the pinned commit, imports its AForm, util and
  constants modules directly, and drives each function with a stub `event`
  under `TZ=UTC`. It writes JSON to `test/fixtures/aform/` and records the
  commit, command, SHA-256 per file and case counts in `PROVENANCE.md`.
- **Golden grid.**
  - `AFNumber_Format`: separator styles 0-4 × negative styles 0-3 × currency
    before and after × 0-3 decimals, over values including -0, 0.5
    boundaries, 1e15 and non-numbers.
  - `AFPercent`: the same grid.
  - Dates and times: every `DateFormats`/`TimeFormats` index, plus pictures
    covering each token.
  - `AFSpecial`: psf 0-3 and masks.
  - Keystroke checks: commit-time inputs.
  - `AFRange_Validate`: all four flag combinations.
  - `AFSimple_Calculate`: each operation, including floating-point sums that
    expose the rounding.

  The suite demands exact equality with the goldens.
- **Ceiling.** pdf.js reimplements Acrobat; it is not Acrobat. Agreement is
  evidence, not conformance. `PROVENANCE.md` says so.
- **A real form.** Vendor one form carrying AF scripts, only if its origin
  permits redistribution (for example a US federal form from the pdf.js
  corpus). It proves the recogniser accepts scripts Acrobat actually wrote.
  If none qualifies, the gap is recorded rather than filled with a fixture we
  wrote.
- **Unit and integration tests.**
  - The recogniser, in both directions: every accepted shape and every
    refusal.
  - `Recalculate`: `/CO` order with a chain (C depends on B, B depends on A),
    `notInOrder`, group expansion, and a no-op call leaving the document
    unmodified (pinned through the sign path).
  - `FormattedValue`, and `format: true` against the default, which must stay
    byte-identical.
  - The password mask still winning over formatting.
  - `CheckValues` records.
  - The `EnforceRules` refusal leaving the document byte-identical.
- **Mutation checks.** Break each rule on purpose and confirm the suite goes
  red.
- **Docs.** README capability and API rows. The JavaScript Scope bullet names
  what is now recognised. A CHANGELOG Added entry, and CLAUDE.md entries for
  the new modules.

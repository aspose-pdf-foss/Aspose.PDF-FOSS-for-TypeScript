# Choice field option-list mutation

Closes `as76`. Picks up the option-list mutation `dbpr.4` deferred (see
`2026-07-27-choice-field-creation-design.md`), matching Go's
`ComboBoxField.AddOption` / `RemoveOption` and the `ListBoxField` equivalents.

## API

Both live on `ChoiceField`, which covers combo boxes and list boxes alike —
there is no separate class per kind here, so one pair serves both.

```ts
AddOption(option: ChoiceOption): void      // appended
RemoveOption(exportValue: string): void
```

`AddOption` appends. There is no insert-at-index: nothing needs one, and
appending is the only position that provably cannot disturb `/I`, whose entries
are indices into `/Opt`.

`RemoveOption` matches on the **export** half only. That is the identity `/V`
carries, and it is the identity every other API on the field already takes;
accepting a display string would let a caller name an option by a string no
other call recognises. An export that is not in the list is a `RangeError`,
matching `Field.Value`'s treatment of an unknown option — a silent no-op would
swallow a typo.

## Keeping the rest of the field consistent

The whole point of the issue. Removal touches four keys:

| Key | Rule |
|---|---|
| `/Opt` | the entry is dropped; the array is kept even when it empties, as creation writes one for an empty list |
| `/V` | touched **only** when it actually named the removed export — dropped from a multi-select array, deleted when nothing is left |
| `/I` | recomputed from the surviving values against the new `/Opt` |
| `/TI` | clamped when it now points past the end |

`/I` is the one that is silently wrong if left alone: it holds *indices*, so
removing an earlier entry shifts every later one and a stale `/I` highlights the
wrong row or none at all. Recomputing from `/V` renumbers and drops stale
entries in a single step, rather than deleting `/I` outright the way
`setChoice` does — the selection stays highlighted.

Free text on an editable combo never matched an option, so it is untouched. The
"only when it changed" guard on `/V` is load-bearing in the other direction too:
without it, removing an option from a field with no `/V` writes an empty one.

## Two things this exposed

**A stale `initialV`.** `Field.rawValue()` falls back to the value captured at
walk time when the dict has no own `/V` — that fallback exists for a value
*inherited* from a parent node. Every creation entry point was passing the
field's own freshly written `/V` into it, which is redundant while the key is
there and wrong the moment it is deleted: `RemoveOption` deleted `/V` and
`Field.Value` went on returning the removed option out of the cache. Creation
now passes `null`, since a newly created field inherits nothing.

**Three parsers for one grammar.** `/Opt` entries were being read inline in
`Field.Options` (export half), `appearance.ts`'s `choiceEntries` (both halves)
and nowhere reusable, while `formcreate.ts` owned the writer. `RemoveOption`
needed a fourth. They are now one module.

## New module: `src/choiceopt.ts`

`ChoiceOption`, `NormalizedOption`, `normalizeOption`/`normalizeOptions`,
`optArray` (write) and `parseOptions` (read), plus `displayOf`.

It is its own module for exactly the reason `fieldstyle.ts` is: `formfield.ts`
needs it and `formcreate.ts` already imports `formfield.ts`, so leaving the
vocabulary in `formcreate.ts` would close a cycle. `appearance.ts` reads it too,
which is the third consumer that makes a shared module pay.

`formcreate.ts` re-exports the `ChoiceOption` type so existing import sites —
including `index.ts` — are unaffected.

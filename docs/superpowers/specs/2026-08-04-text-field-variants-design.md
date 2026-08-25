# Text field variants: FileSelect, RichText, and field /AA actions

Closes `kjdx`. Picks up what `dbpr.2` deferred (see
`2026-07-27-text-field-flags-design.md`): the two remaining text-field flags,
plus the larger surface Go puts behind them — `/RV` rich text values and format
actions.

## Shape: accessors, not new field types

Go models these as separate types (`FileSelectBoxField`, `RichTextBoxField` in
`form_fields_extra.go`). That is a Go structuring choice; here the precedent set
by `dbpr.2` is a flag accessor on `TextField`, and Multiline, Password and Comb
already live there. New `FieldType` union members would mean `classify()`
dispatching on `/Ff` bits and every consumer of `Field.Type` seeing two more
cases, to express something that is a flag either way.

So: `TextField.FileSelect` and `.RichText`, plus `fileSelect` / `richText` on
`TextFieldInit`.

## The flags

| | Bit | Value |
|---|---|---|
| FileSelect | 21 | 1048576 |
| RichText | 26 | 33554432 |

Both are pinned by literal value in `test/fieldflags.test.ts`, not against the
constant they define. That test already existed for exactly this reason —
`fieldflags.ts` says the 1-based/0-based confusion is where the error lives —
and the first version of this work only asserted `Ff === FF_FILESELECT`, which
survives an off-by-one because both sides move together.

### One new validation

Table 228 states Comb is meaningful only with Multiline, Password **and**
FileSelect clear. The first two were already enforced from both directions; the
third is new, and is enforced the same way — at creation and on both setters.

Nothing else is rejected. RichText combines freely with everything, because the
specification does not say otherwise and inventing a constraint would reject
documents Acrobat produces.

## /RV

`TextField.RichTextValue: string | undefined`.

- **Reads** either shape. We write the string form; a producer may use a stream,
  and Acrobat does for anything sizeable.
- **Writes** the string form, and requires the `RichText` flag — `/RV` without
  it is a payload every viewer ignores, so it is a `RangeError` rather than a
  silent no-op.
- **Leaves `/V` alone.** `/V` holds the plain-text equivalent and is what the
  generated appearance draws; nothing here renders markup.
- `undefined` deletes the key.

`TextFieldInit.richTextValue` mirrors it, validated before allocation.

The read half already existed as a private helper in `formdata.ts`, where the
FDF/XFDF exporter needs it for fields of any type. It is now
`readRichTextValue` in `formfield.ts` and both go through it.

## Field /AA actions

The other half of Go's "larger surface". These are not specific to the two
variants — `/AA /K /F /V /C` applies to every field type — so they land on
`Field`, not on `TextField`.

```ts
get Actions(): FieldActions
SetActions(update: FieldActionsUpdate): void
FieldInit.actions?: FieldActions        // and RadioGroupInit.actions
```

`FieldActionsUpdate` is `FieldActions` with `| null` on each value: an action
sets, `null` removes, absent leaves alone — the shape `SetStyle` already
established. Values are ordinary `PdfAction`s, so `actions.ts` encodes and
parses them with the machinery link annotations and push buttons already use.

**Invariant:** only the four named keys are touched. A created field is a
*merged* field/widget dict, so one `/AA` holds the annotation's triggers
(`/E`, `/X`, …) and the field's alike; rewriting it whole silently drops the
annotation half. By the same token `/AA` is deleted only when nothing at all is
left in it, not when the four field keys are gone.

**Invariant:** every action is encoded before the first write, so a rejected
trigger leaves the field untouched — the same rule creation and `SetStyle`
hold. At creation the encode happens in the validation phase, before any object
is allocated.

`RadioGroupInit` needed the key explicitly: it is deliberately not a
`FieldInit`, and `addRadioGroup` builds its parent dict without going through
`createField`.

### One parse for two hosts

`parseAction(doc, annot)` reads `annot.get('A')` and takes the *annotation*
because a GoTo destination may live in its `/Dest`. An `/AA` entry is a bare
action dict with no such host, so the body is now `parseActionDict(doc, a,
host)` with two entries: `parseAction` for an annotation, and
`parseStandaloneAction` for a bare dict, which passes a one-key
`{ A: <dict> }` host so `parseDest` finds the action's own `/D` through the
path it already understands.

## Still deferred

`/Ff` **DoNotSpellCheck** (bit 23) and **DoNotScroll** (bit 24), named alongside
these two in the `dbpr.2` non-goals but not in this issue's title or
description. Filed as a follow-up.

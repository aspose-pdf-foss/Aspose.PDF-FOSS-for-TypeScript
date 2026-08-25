# Form field removal: Form.RemoveField

Closes `4nzl`. Picks up what `dbpr.1` deferred (see
`2026-07-27-form-field-creation-design.md`): Go has `Form.RemoveField`
(`form.go:725`) and no `dbpr` issue covered removal.

Creation validates, allocates and wires. Removal is the reverse of the wiring
half only — it unwires, and lets the mark-sweep in `Save()` collect what nothing
points at any more. Nothing is deleted from the object map, which is the model
the whole library runs on.

## API

```ts
Form.RemoveField(field: Field | string): boolean
```

The union mirrors `Page.RemoveAnnotation(a: Annotation | PdfDict)`. A string is a
terminal `FullName`, resolved through `Get`; a `Field` handle is used directly.

Returns `true` when a field was removed and `false` otherwise, so removal is
idempotent — a second call, an unknown name, or a handle whose field is already
gone all return `false` without touching the document. That follows
`RemoveAnnotation`, a documented no-op when the annotation is not on the page.
The `Add*` family throws on a bad name instead, but it throws to protect an
allocation that has not happened yet; here there is nothing to protect.

**Terminal fields only.** `Form.Fields` lists terminal fields and `Get` matches
terminal full names, so those are the names a caller can discover. Accepting
`'address'` as a subtree removal would widen the accepted name space past
anything the API exposes.

A signed signature field is removed like any other. Any edit to a signed
document invalidates its signatures, `FlattenForm` already deletes the whole
`/AcroForm` without a word, and a caller naming a signature field means it.

There is no `Page.RemoveField`. A radio group's widgets may sit on several
pages, so a field is not page-bound.

On success `Form` reruns `build()`, exactly as every `Add*` does, so a held
`Form` stays canonical.

## Module

New `src/formremove.ts`, exporting `removeField(doc, fieldDict): boolean`.

`formcreate.ts` is the creation machinery and `form.ts` is the facade; removal is
neither. This is the same split that gave `choiceopt.ts` and `fieldstyle.ts`
their own files. `form.ts` resolves a string to a `Field` through its own walk
and hands `removeField` a dict, so `formremove.ts` never re-derives full names.

## Algorithm

1. **Locate** the field dict by identity, walking `/AcroForm /Fields` down
   through `/Kids`, recording the container array and index at each level.
   Not found → `false`. Identity is what makes a stale handle (or one from
   another document) safe rather than a wrong deletion.
2. **Collect widgets.** A merged field/widget dict is its own widget; otherwise
   the resolved `/Kids` entries. Same rule as `Field.widgets()`.
3. **Detach widgets** from every page's `/Annots`, dropping entries that resolve
   to a collected widget. Every page, not the one named by `/P`: `/P` is
   optional, and a radio group's widgets sit on different pages anyway.
4. **Splice** the field's own entry out of its container.
5. **Prune ancestors.** Walking back up the recorded chain, splice out each
   intermediate node whose `/Kids` is now empty, stopping at the first that is
   not. The root `/Fields` array is never removed, and an `/AcroForm` left with
   zero fields stays in the catalog — deleting it would only make the next
   `Add*` bootstrap it again.
6. **Scrub `/AcroForm /CO`** of refs to the removed field and to every pruned
   ancestor.
7. `doc.markModified()`, matching every other in-place edit: an incremental
   append could otherwise emit a delta that leaves the field wired.

### Why /CO is load-bearing

`/CO` (calculation order, table 218) is an array of field refs reachable from
`/Root`. A leftover ref there keeps the removed field alive through `Save()`'s
mark-sweep, together with its widgets, and the saved file then carries a field
that is in no `/Fields` and has no `/Annots` entry — removed everywhere a
viewer looks and still present in the bytes.

Nothing this library writes emits `/CO`, so no builder fixture would catch it;
`docmdp.ts` already lists it among the `/AcroForm` keys real documents carry.
The test for it builds `/CO` by hand and asserts across `Save`/`Open`.

## Not covered, deliberately

- **Structure tree.** A tagged widget's `/OBJR` is left dangling, exactly as
  `Page.RemoveAnnotation` leaves it today. Fixing it belongs to whatever fixes
  both. **Done** (issue `hob8`): `untagObjects` in `structwrite.ts` — the mirror
  of `tagAnnotation` — drops the `/OBJR` kids naming a removed dict, prunes an
  element that leaves empty, and clears the `/ParentTree` slot; `removeField`
  and `Page.RemoveAnnotation` both call it. `flatten.ts` has the same hole and
  is tracked separately (`4dqa`), because a flattened annotation's ink becomes
  real page content and re-pointing the tag may beat dropping it.
- **`/DR` fonts.** Shared across fields; pruning what is now unused is
  `Optimize`'s job, not removal's.
- **XFA.** An `/AcroForm /XFA` packet is not rewritten, so removal desynchronizes
  a hybrid XFA form's packet from its AcroForm. We do not author XFA. Resolved
  (issue `txgg`) as a **documented limitation**, not an `UnsupportedFeatureError`
  from the mutating entry points: the same gap applies to field creation, value
  setting and `ImportFdf`/`ImportXfdf`, and throwing would reject hybrid
  documents whose AcroForm half is perfectly editable. See README's forms section
  (beside the removal paragraph) and the "XFA is never read or written"
  limitation.

## Testing

`test/form-remove.test.ts`, over the existing `buildBlankPage` and
`buildFormPdf` builders:

| Test | Asserts |
|---|---|
| removes a created field | gone from `Fields`, from `/AcroForm /Fields`, and its widget from the page `/Annots`; returns `true` |
| idempotent | a second call returns `false` and `Save()` stays byte-identical |
| unknown name / stale handle | `false`, document byte-identical |
| siblings survive | removing `address.city` leaves `address.zip` and the `address` node |
| ancestor pruning | removing the last child prunes `address`; a one-field `a.b.c` prunes `b` then `a` |
| radio group across pages | every widget leaves both pages' `/Annots`, parent leaves `/Fields` |
| `/Kids` widgets from a file | a `buildFormPdf` field whose widgets are `/Kids`, not a merged dict |
| `/CO` scrub | a hand-built `/CO` no longer names the field, and `Save`/`Open` shows it truly gone |
| handle overload | `RemoveField(field)` removes the same field as `RemoveField(name)` |

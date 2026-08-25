# Page MediaBox / CropBox setters

**Issue:** aspose-pdf-foss-for-ts-31b
**Date:** 2026-06-11
**Status:** Approved

## Goal

Complete the live page-attribute API started by the in-memory object model
overhaul (`2026-06-08-in-memory-object-model-design.md`), which shipped the
`Rotate` setter and explicitly deferred the box setters. Add `MediaBox` and
`CropBox` setters to `Page` that write the page's own dict, overriding any
value inherited from an ancestor `/Pages` node.

## Scope

- `set MediaBox(box: number[])` and `set CropBox(box: number[])` on `Page`.
- Out of scope: BleedBox / TrimBox / ArtBox (no getters exist yet — separate
  follow-up if wanted), clearing/removal semantics (setters only set),
  coordinate normalization (getters don't normalize either).

## Design

In `src/page.ts`, next to the existing `Rotate` setter:

```ts
set MediaBox(box: number[]) { this.Dict.set('MediaBox', checkBox('MediaBox', box)); }
set CropBox(box: number[])  { this.Dict.set('CropBox', checkBox('CropBox', box)); }
```

A small private helper validates and copies:

- The value must be an array of **exactly 4 finite numbers**
  (`Number.isFinite` on each element); otherwise throw
  `TypeError("<key> must be [llx, lly, urx, ury] (4 finite numbers)")`.
- On success it returns a **copy** (`[...box]`) so later mutation of the
  caller's array cannot silently alter the live dict.

Writing into the page's own dict naturally overrides inheritance — the
existing `inherited()` walk finds the own key first. Sibling pages that
inherit the same ancestor value are unaffected.

No type changes: the getters already return `number[]`, so the
getter/setter pair stays type-compatible.

## Error handling

- Invalid input → `TypeError`, dict untouched.
- No normalization or reordering of coordinates: stored as given.

## Testing

In `test/page.test.ts`:

1. Set `MediaBox` / `CropBox` → corresponding getter reflects the new value.
2. On a page that **inherits** the box from its `/Pages` ancestor: setting
   overrides for that page only; a sibling page still reads the inherited
   value.
3. The new value survives `Save` + reopen.
4. Throws `TypeError` on: wrong length, non-number entries, non-finite
   numbers (`NaN`, `Infinity`), and non-array input.
5. Setting `CropBox` does not affect `MediaBox` and vice versa
   (independent keys; `CropBox` getter fallback only applies when the key
   is absent).
6. The stored array is a copy: mutating the caller's array after the set
   does not change what the getter returns.

# Page BleedBox / TrimBox / ArtBox getters + setters

**Issue:** aspose-pdf-foss-for-ts-cjc
**Date:** 2026-06-11
**Status:** Approved

## Goal

Complete the page-boundary API begun in
`2026-06-11-page-box-setters-design.md` (31b): add `BleedBox`, `TrimBox`,
and `ArtBox` getter/setter pairs to `Page`. Unlike MediaBox/CropBox these
keys are **not inheritable** (PDF 32000-1 Table 30) and default to the
CropBox.

## Scope

- `get`/`set BleedBox`, `TrimBox`, `ArtBox` on `Page` (`src/page.ts`).
- Out of scope: intersection/clamping with MediaBox (existing getters
  don't clamp either), coordinate normalization, clearing/removal
  semantics, inheritance (spec forbids it for these keys).

## Design

A private `ownBox(key)` helper reads the page's **own** dict only —
no `/Parent` walk — resolving the array and its elements, and returns
`this.CropBox` when the key is absent or malformed (wrong length,
non-numeric entries). So the effective default chain is
BleedBox → CropBox → MediaBox → US Letter.

```ts
private ownBox(key: string): number[] {
  const b = this.doc.resolve(this.Dict.get(key));
  if (isArray(b) && b.length === 4) {
    const nums = b.map((x) => this.doc.resolve(x)).filter((x): x is number => typeof x === 'number');
    if (nums.length === 4) return nums;
  }
  return this.CropBox;
}

get BleedBox(): number[] { return this.ownBox('BleedBox'); }
set BleedBox(box: number[]) { this.Dict.set('BleedBox', checkBox('BleedBox', box)); }
// TrimBox and ArtBox identical, with their own keys
```

Setters reuse the existing `checkBox` validator from 31b: the value must
be an array of exactly 4 finite numbers, else `TypeError` and the dict is
untouched; on success a defensive copy is stored in the live page dict.

## Error handling

- Invalid setter input → `TypeError`, dict unmodified (same message shape
  as 31b: `"<key> must be [llx, lly, urx, ury] (4 finite numbers)"`).
- Malformed stored values are not errors: the getter falls back to
  CropBox, consistent with the tolerant getters elsewhere in `Page`.

## Testing

Extend `test/page.test.ts` (one block covering all three keys, looping
where natural):

1. Absent key → getter returns CropBox (and transitively MediaBox when
   CropBox is also absent).
2. Own value present → returned as numbers.
3. Setter → getter round-trip; value lands in the live dict.
4. NOT inherited: the key on the ancestor `/Pages` node is ignored by the
   page (contrast with MediaBox behavior).
5. Survives `Save()` + reopen.
6. `TypeError` on wrong length / non-number / non-finite / non-array;
   dict unchanged afterward.
7. Stored array is a copy: mutating the caller's array afterwards does
   not change the getter result.

README: add `page.BleedBox`, `page.TrimBox`, `page.ArtBox` to the API
overview table row for page geometry.

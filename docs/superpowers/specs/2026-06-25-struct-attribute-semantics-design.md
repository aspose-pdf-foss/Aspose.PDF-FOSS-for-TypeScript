# Deep attribute semantics (S4) — design

**Date:** 2026-06-25
**Status:** Approved (design); plan pending
**Scope:** Sub-project S4 of the "Tagged PDF / accessibility" epic
(`aspose-pdf-foss-for-ts-pjx.4`). Builds on the S1 read model
([2026-06-25-struct-tree-read-model-design.md](2026-06-25-struct-tree-read-model-design.md))
and the S3 authoring layer
([2026-06-25-tagged-content-authoring-design.md](2026-06-25-tagged-content-authoring-design.md)).

## Context

S1 exposes structure-element attributes only as a **raw passthrough**:
`StructElement.Attributes` returns `{ A: PdfObject[]; C: PdfObject[] }` (the
unresolved `/A` and `/C` values), and `StructTreeRoot.ClassMap` is a raw
`Map<string, PdfObject>`. Nothing interprets the attribute dictionaries.

S4 adds **typed interpretation and authoring** of the standard attribute owners —
Table (`RowSpan`/`ColSpan`/`Headers`/`Scope`/`Summary`), List (`ListNumbering`),
and the full Layout owner — on top of that raw layer. Read + write, symmetric
with the S1 live handles and the S3 authoring API.

## Goals

1. **Interpret** an element's `/A` + `/C` attributes into typed, structured views
   per owner, resolving `/ClassMap` classes and PDF precedence rules.
2. **Author** the same attributes with typed partial-object setters that merge
   into the element's `/A`, completing the S3 tagged-table/list authoring story.
3. Keep the raw `Attributes` passthrough for anything uninterpreted.

## Non-goals (other sub-projects / out of scope)

- PDF/UA validation rules — S5.
- Non-standard / markup owners (`/XML-1.00`, `/HTML`, `/CSS`, `/PrintField`,
  `/Artifact`, `/OCG`, `/Field`, `/RubyMinMax`). Reachable via raw `Attributes`.
- PDF 2.0 list continuation attributes (`/ContinuedList`, `/ContinuedFrom`).
- Writing attributes into `/C` / `/ClassMap` (writers target `/A` only).

## PDF attribute model (what the reader must honor)

Per ISO 32000-1 §14.7–14.8:

- An element's attributes come from `/A` (explicit) and `/C` (class names looked
  up in the structure tree root's `/ClassMap`).
- `/A` and `/C` may each be a single value **or an array interleaved with integer
  revision numbers**. Revision numbers (integers) are skipped.
- Each attribute object is a dict carrying an `/O` **owner** name (`/Table`,
  `/List`, `/Layout`, …) plus that owner's attribute keys.
- **Precedence:** `/A` takes precedence over `/C`; within each, earlier array
  entries take precedence over later ones, for a given owner + key.

## Architecture & module layout

New module **`src/structattr.ts`** holds the attribute codecs, the
owner-collection/precedence logic, the typed interfaces, and per-owner
read/write functions (parallel to how `structwrite.ts` backs S3). `StructElement`
in `struct.ts` gains thin typed getters/setters that delegate to it. The codecs
need the owning document (`resolve`) and, for reads, the tree root (`/ClassMap`);
both are reachable from the element (`this.doc`, `this.Root`).

## Public API

### On `StructElement` (struct.ts)

```ts
// Read — undefined when the element carries no attribute for that owner.
get TableAttributes(): TableAttributes | undefined;
get ListAttributes(): ListAttributes | undefined;
get LayoutAttributes(): LayoutAttributes | undefined;

// Write — merge a partial into the element's /A dict for that owner (creating it
// if absent); a field set to `undefined` deletes that key. Never touches /C.
SetTableAttributes(attrs: Partial<TableAttributes>): void;
SetListAttributes(attrs: Partial<ListAttributes>): void;
SetLayoutAttributes(attrs: Partial<LayoutAttributes>): void;
```

The existing raw `Attributes` getter and `StructTreeRoot.ClassMap` are unchanged.

### Typed interfaces (structattr.ts, re-exported from index.ts)

```ts
/** RGB components in 0..1 (consistent with the rest of the library). */
export type RGB = [number, number, number];
/** A single value, or one-per-edge [top, right, bottom, left] (PDF allows both). */
export type Edged<T> = T | [T, T, T, T];

export interface TableAttributes {     // owner /Table (TH/TD/Table)
  rowSpan?: number;                    // /RowSpan, default 1
  colSpan?: number;                    // /ColSpan, default 1
  headers?: string[];                  // /Headers — associated TH /IDs
  scope?: 'Row' | 'Column' | 'Both';   // /Scope (TH)
  summary?: string;                    // /Summary
}

export interface ListAttributes {      // owner /List (L)
  listNumbering?:
    | 'None' | 'Disc' | 'Circle' | 'Square'
    | 'Decimal' | 'UpperRoman' | 'LowerRoman' | 'UpperAlpha' | 'LowerAlpha';
}

export interface LayoutAttributes {    // owner /Layout — full ISO 32000 set
  placement?: 'Block' | 'Inline' | 'Before' | 'Start' | 'End';
  writingMode?: 'LrTb' | 'RlTb' | 'TbRl';
  backgroundColor?: RGB;
  borderColor?: Edged<RGB>;
  borderStyle?: Edged<BorderStyle>;
  borderThickness?: Edged<number>;
  color?: RGB;
  padding?: Edged<number>;
  spaceBefore?: number;
  spaceAfter?: number;
  startIndent?: number;
  endIndent?: number;
  textIndent?: number;
  textAlign?: 'Start' | 'Center' | 'End' | 'Justify';
  bbox?: [number, number, number, number];   // /BBox [llx lly urx ury]
  width?: number | 'Auto';
  height?: number | 'Auto';
  blockAlign?: 'Before' | 'Middle' | 'After' | 'Justify';
  inlineAlign?: 'Start' | 'Center' | 'End';
  tBorderStyle?: Edged<BorderStyle>;
  tPadding?: Edged<number>;
  lineHeight?: number | 'Normal' | 'Auto';
  baselineShift?: number;
  textDecorationType?: 'None' | 'Underline' | 'Overline' | 'LineThrough';
  textDecorationColor?: RGB;
  textDecorationThickness?: number;
  columnCount?: number;
  columnGap?: number | number[];
  columnWidths?: number | number[];
  glyphOrientationVertical?: 'Auto' | number;
  rubyAlign?: 'Start' | 'Center' | 'End' | 'Justify' | 'Distribute';
  rubyPosition?: 'Before' | 'After' | 'Warichu' | 'Inline';
}

export type BorderStyle =
  | 'None' | 'Hidden' | 'Dotted' | 'Dashed' | 'Solid'
  | 'Double' | 'Groove' | 'Ridge' | 'Inset' | 'Outset';
```

## Read semantics

`structattr.ts` core:

- `collectOwnerDicts(doc, root, element, owner): PdfDict[]` — gathers candidate
  attribute dicts in **precedence order**: each `/A` entry in array order
  (skipping integer revision numbers), then each `/C` class name resolved through
  `root`'s `/ClassMap` (in array order). Keeps only dicts whose resolved `/O`
  name equals `owner`. A single (non-array) `/A` or `/C` is normalized to a
  one-element list.
- `readAttr(doc, dicts, key): PdfObject | undefined` — the first occurrence of
  `key` across that ordered list (so `/A` beats `/C`, earlier beats later).
- Each typed getter builds the owner's dict list; returns `undefined` when the
  list is empty; otherwise decodes each known key via the codecs. `rowSpan` /
  `colSpan` default to 1 when absent (only when the `/Table` owner is present at
  all).

### Value codecs

| Form | PDF | JS |
|---|---|---|
| enum | `/Name` | string union |
| number | number | number |
| `RGB` | 3-number array (0..1) | `[r, g, b]` |
| `Edged<T>` | scalar **or** 4-array | `T` or `[T, T, T, T]` |
| `number \| 'Auto'/'Normal'` | number **or** `/Name` | number or string |
| `glyphOrientationVertical` | number (angle) **or** `/Auto` | number or `'Auto'` |
| `bbox` | 4-number array | `[llx, lly, urx, ury]` |
| `headers` | array of byte strings | `string[]` (decoded via `decodePdfText`) |
| `columnGap`/`columnWidths` | number **or** number array | `number` or `number[]` |

Reads are **lenient**: a key whose value has the wrong PDF type is omitted from
the result; other keys still decode. `Edged<RGB>` decodes a 4-array of 3-number
arrays to `[RGB, RGB, RGB, RGB]`, and a single 3-number array to one `RGB`.

## Write semantics

- `ownerDictForWrite(doc, element, owner): PdfDict` — normalizes a single `/A`
  into an array (creating `/A` if absent), finds the first `/A` entry whose `/O`
  equals `owner`, or creates `<< /O owner >>`, appends it to `/A`, and returns it
  live.
- Each setter encodes every provided field via the codecs and sets the key on
  that owner dict; a field explicitly set to `undefined` **deletes** the key.
  Fields not present on the partial are left untouched. Then `doc.markModified()`.
- Writers only ever mutate `/A`; `/C`, `/ClassMap`, and revision numbers are left
  intact.

## Edge cases

- `/A` and `/C` both absent for the owner → getter returns `undefined`.
- `/C` name missing from `/ClassMap` → that class is skipped.
- Malformed value for a key → that field omitted (other fields still returned).
- Multiple `/A` dicts for the same owner → read merges by precedence; write
  targets the first matching dict.
- `Edged<T>` ambiguity: a 4-element array is read as per-edge; anything else as a
  scalar (for `RGB`, a 3-number array is the scalar form).
- Setting `colSpan`/`rowSpan` to `1` writes the key explicitly (no default
  elision); reads still default to 1 when the key is absent.

## Serialization

No serializer changes. Attribute dicts/arrays are ordinary objects the existing
mark-sweep serializer renumbers and writes. `Save({ compressed })` is unaffected.

## Testing (TDD)

Extend `test/helpers/build-tagged-pdf.ts` (or a small dedicated builder) with:

- a `Table` whose `TH` carries `/Headers` + `/Scope` and whose `TD` carries
  `/ColSpan`;
- an `L` with a `/List` `ListNumbering`;
- a `Layout` dict exercising scalar, `RGB`, `Edged` (both scalar and 4-array),
  number-or-name (`Width`/`LineHeight`), `bbox`, and `columnWidths` forms;
- one attribute supplied via `/C` + `/ClassMap` (and the same owner+key also in
  `/A`) to prove `/A`-over-`/C` precedence.

`test/struct-attr.test.ts` covers:

- each typed getter returns the decoded values; `undefined` when the owner is
  absent;
- `/A`-over-`/C` precedence; `/C` resolution through `/ClassMap`;
- `rowSpan`/`colSpan` defaults of 1;
- lenient handling of a malformed value (field omitted, siblings intact);
- `Edged` scalar vs 4-array; number-or-name decoding;
- round-trip of each setter: build/author → `Save` → re-`Open` → getter returns
  what was set;
- `undefined` deletes a key;
- a writer merging into an element that already has an `/A` dict for the owner
  (existing keys preserved).

`npm run typecheck` and `npm test` must be green before close.

## Docs

README "Features" gains typed structure-attribute read/write; "Limitations"
notes the interpreted owners (Table/List/Layout) and that other owners remain
raw-only. New types (`TableAttributes`, `ListAttributes`, `LayoutAttributes`,
`BorderStyle`, `RGB`, `Edged`) exported from `index.ts`.

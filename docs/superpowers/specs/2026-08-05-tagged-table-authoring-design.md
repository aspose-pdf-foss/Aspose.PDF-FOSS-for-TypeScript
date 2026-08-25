# Tagged table authoring for `page.AddTable`

Closes `7efj`. `AddTable` emits untagged cell text, so any tagged document
containing one fails `ValidatePdfUa`'s `UntaggedContent` — before and
independently of `hdsx`, which covered vector paths. This adds a
`{ tagged: true }` mode emitting `/Table > /TR > /TD` (and `/TH`), with borders
and cell backgrounds as artifacts.

## What is actually broken

`hdsx`'s blast-radius table recorded `AddTable` as the one producer that already
fires `UntaggedContent` today, and recorded *why*: the trigger is its cell
**text**, not its borders. Artifacting the borders would leave the report exactly
where it is. Nothing short of real structure fixes it.

Everything the fix needs already exists:

- `stampTextBlock` takes `tag?: StructElement` and `artifact?: boolean`.
- `PageGraphics` has `BeginArtifact()` / `EndMarkedContent()`.
- `drawBuiltImage` takes `tag?: StructElement` (but has no artifact path — see
  below).
- `TableBuilder.repeatingRowCount` already models the header band.

So this is structure-building plus wiring, with no new rendering primitives —
the same shape as `page.AddTOC({ tagged: true })`.

## Module split

A new `src/tabletag.ts`, mirroring `tocstruct.ts`. It owns every structure
decision — when a cell is a `/TH`, its `/Scope`, the `colSpan` attribute,
`/Figure` creation, `/Table` reuse — and `tablerender.ts` gains an optional
tagger it threads onto its existing `Placed` records.

`tocstruct.ts` is its own module for exactly this reason: threading a level stack
through `paintRow` would blur "where the ink goes". The same argument holds
here, one layer deeper. The alternatives were both rejected:

- **Inline in `tablerender.ts`** — `paintPlaced` grows the tree vocabulary and
  the file stops being about painting.
- **In `tableauthor.ts`** — wrong layer. The model is page-independent, and a
  `/Table` is per-render with MCIDs bound to pages.

Note the name: `tablestruct.ts` is taken by the *extraction* side
(`extractTaggedTables`). `tabletag.ts` is the authoring counterpart, and the two
never import each other.

## Public surface

`AddTableOptions` (`tablerender.ts`) gains, mirroring `TOCOptions`:

```ts
  /** Emit /Table + /TR + /TD logical structure into the document structure
   *  tree. Default false, in which case output is byte-identical to an untagged
   *  call. Cell text is tagged into its cell element; cell backgrounds, cell
   *  borders and the outer border are marked as /Artifact. */
  tagged?: boolean;
  /** Element to append the /Table under. Default: the structure tree root. When
   *  this element is itself a /Table it is *reused* rather than nested, which is
   *  how a manual-pagination loop keeps one table across pages — pass back
   *  {@link AddTableResult.struct}. Requires `tagged: true`. */
  structParent?: StructElement;
```

`AddTableResult` gains:

```ts
  /** The /Table element, when `tagged` and at least one row was drawn. Pass it
   *  back as `structParent` on a continuation call so a paginated table stays a
   *  single /Table. */
  struct?: StructElement;
```

`CellOptions` (`tableauthor.ts`) gains:

```ts
  /** Emit this cell as a /TH rather than a /TD in a tagged table, with the given
   *  /Scope: 'column' (or true) for a column header, 'row' for a row header.
   *  Default: cells in the repeating-header rows are column headers, all others
   *  are /TD. `false` opts a cell out of that inference — a blank corner cell in
   *  a header row stays a /TD. Ignored when the table is not drawn tagged. */
  header?: boolean | 'row' | 'column';
```

`CellImageOptions` gains `alt?: string` and `artifact?: boolean`, mutually
exclusive, with the same meanings they carry in `structwrite.ts`'s
`MarkOptions`.

`drawBuiltImage` gains `artifact?: boolean` alongside its existing `tag`,
wrapping the body with `wrapArtifact`. `addImage` already has the same gap but is
out of scope here; only the `BuiltImage` path is reached by a cell image.

## The tree

```
/Table
  /TR                      one per painted row, in draw order
    /TD | /TH              one per cell, in column order
      /Figure              only when the cell has a non-artifact image
      <MCID>               the cell's text stamp
```

- A cell with `colSpan > 1` gets `SetTableAttributes({ colSpan })`. `rowSpan` is
  not in the model, so nothing is written for it.
- A `/TH` gets `Scope` `Column` (repeating-row inference, `header: true`,
  `header: 'column'`) or `Row` (`header: 'row'`).
- An empty cell still gets its `/TD`, with no kids. The grid has to stay
  rectangular for `tablestruct.ts` to read it back, and a `/TD` with an empty
  `/K` is valid.

**Repeated header rows become real `/TR`s.** On a continuation page the header
band is painted again, and each repaint appends another `/TR` of `/TH` cells to
the same `/Table`, in draw order. That is the honest representation: the ink
genuinely exists on both pages, and it is what Word and Acrobat emit. Artifacting
the repeats was considered and rejected — it would declare a visible header
decorative, and `extractTaggedTables` would then read a table whose later rows
have no header above them.

## Where each pass lands

`paintPlaced`'s four passes map onto the marking vocabulary directly:

| Pass | Marking |
|---|---|
| backgrounds (`PageGraphics`) | `/Artifact BMC … EMC` |
| cell images (`drawBuiltImage`) | `tag` = the cell's `/Figure`, or `/Artifact` |
| cell text (`stampTextBlock`) | `tag` = the `/TD` / `/TH` element |
| cell + outer borders (`PageGraphics`) | `/Artifact BMC … EMC` |

The two `PageGraphics` passes open the artifact sequence **only when the pass
actually draws something**. `apply()` no-ops on an empty part list, but
`BeginArtifact()` pushes a part, so an unconditional call would emit a bare
`/Artifact BMC EMC` into a table with no backgrounds — changing bytes for no
content. The sequence sits entirely inside `apply()`'s `q … Q`, which is the
proper nesting ISO 32000-1 §14.6 requires.

## Element creation order

Elements are created during `placeRows`, which already walks rows and cells in
row-major order, and are stored on the `Placed` record:

```ts
interface Placed {
  …
  /** The /TD or /TH this cell's text is tagged into. Tagged mode only. */
  struct?: StructElement;
  /** The /Figure this cell's image is tagged into. Tagged mode only, and only
   *  for a non-artifact image. */
  figure?: StructElement;
}
```

This matters for ordering. `paintPlaced` runs image-pass-then-text-pass across
*all* cells, so MCIDs are allocated in that order rather than in cell order — but
MCID numbering does not define reading order, `/K` order does. Building the
skeleton up front in row-major order, with each `/Figure` appended at cell
creation, gives every cell `/K = [Figure, textMcid]`: figure first, matching both
paint order (image under text) and reading order.

## Validation

At the top of `drawTable`, before `resolveColumnWidths` and `measure` and before
anything is allocated, mirroring `measureTOC`:

- `tagged` must be a boolean.
- `structParent` requires `tagged: true` — explicit rejection rather than
  implying `tagged`, so an unused option never silently changes output.
- `structParent` must carry an indirect ref and must belong to this document.

`header` is validated in `addCell`; `alt` and `artifact` in `setImage`, where
`artifact: true` combined with `alt` throws, as `validateMarkOptions` does.

The tagger is constructed on the **first painted row**, so a tagged call that
draws nothing bootstraps no structure tree and leaves the document untouched.

## Tests

`test/table-tagged.test.ts`, over the existing `test/helpers/` builders:

- Tree shape: `/Table > /TR > /TD`, cell text under the right cell, `colSpan`
  attribute on a spanning cell.
- `/TH` and `/Scope` from all three sources — the repeating-row inference,
  `header: 'row'`, `header: 'column'` — plus the `header: false` opt-out.
- Backgrounds and borders artifacted, asserted both ways. `UntaggedContent`
  subscribes a `path` callback since `hdsx`, so an unartifacted border *does*
  fire it — that is the guarantee. The content stream is asserted too, because
  the validator only reports that *something* on the page is unmarked and cannot
  distinguish a missed border from a missed background.
- Cell image: `/TD > /Figure` carrying `/Alt`, and `artifact: true` producing
  `/Artifact` and no `/Figure`.
- **The motivating case**: `ValidatePdfUa` reports `UntaggedContent` for a table
  drawn untagged into a tagged document, and reports none once drawn tagged.
- Untagged output is byte-identical to today's.
- Auto-pagination: one `/Table` across the appended pages, repeated header rows
  present as extra `/TR`s, and MCIDs bound to the correct pages (the `/Pg` +
  `MCR` rule in `appendContentKid`).
- Manual continuation: `result.struct` passed back as `structParent` yields one
  `/Table`, not two.
- Rejection leaves the document byte-identical (`structParent` without `tagged`,
  a foreign `structParent`, `alt` with `artifact`).
- Read-back through `extractTaggedTables`. That is a different stack, not the one
  under test, so it is a legitimate outside check on the tree shape rather than a
  differential test that would cancel a shared bug.

## Out of scope

- `rowSpan` — `TableBuilder` has no vertical spanning to describe.
- `/THead` / `/TBody` / `/TFoot` sectioning. A repeated header mid-table cannot
  live in `/THead` without reordering rows against reading order; the flat `/TR`
  list the issue specifies is the right shape.
- `/Table` `Summary`, and table captions.
- An artifact path for `addImage` (the non-`BuiltImage` entry point).

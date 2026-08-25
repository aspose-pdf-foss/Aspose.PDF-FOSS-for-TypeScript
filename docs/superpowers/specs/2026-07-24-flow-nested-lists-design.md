# Flow nested lists — design (db7v.7)

**Issue:** aspose-pdf-foss-for-ts-db7v.7 (parent epic db7v — Flow layout engine)
**Date:** 2026-07-24
**Status:** approved, ready to plan
**Depends on:** db7v.3 (Lists — bulleted / numbered) — shipped

## Goal

Extend `flow.AddList` with nesting: sub-lists indent per level, ordered numbering
restarts per level, and unordered markers alternate by depth (`• ◦ ▪`). Deferred
from db7v.3 (flat lists only). Per-item style overrides remain a separate issue
(db7v.8).

## Input model — recursive item objects

`AddList` widens its `items` parameter from `string[]` to a recursive union. A
plain string is a leaf item (unchanged); an object may carry a sub-list.

```ts
/** One nested-list item. A bare string is a leaf. */
export interface FlowListItem {
  /** The item's word-wrapped body text. */
  text: string;
  /** Sub-list nested under this item (leaves or further objects). */
  items?: FlowListNode[];
  /** Override ordered-ness of THIS item's sub-list. Default: inherit the parent
   *  list's ordered-ness. */
  ordered?: boolean;
  /** Override the marker glyph of THIS item's (unordered) sub-list. Drawn as text
   *  (WinAnsi); overrides the default vector bullet cycle for that level. */
  bullet?: string;
  /** First ordinal of THIS item's (ordered) sub-list. Integer. Default 1. */
  start?: number;
}

export type FlowListNode = string | FlowListItem;

// AddList signature widens (backward compatible — string[] still valid):
AddList(items: FlowListNode[], options?: FlowListOptions): this
```

`FlowListOptions` is unchanged; its `ordered`/`bullet`/`start` configure the
**top** list (depth 0).

## Level resolution (depth 0 = the top list)

Each **sub-list** (the top array, and every item's `items` array) resolves its own
ordered-ness, marker, and start:

- **Ordered inherits**: a sub-list is ordered iff the containing item's `ordered`
  is set, else it inherits the parent list's ordered-ness; the top list uses
  `options.ordered` (default false).
- **Ordered numbering restarts per sub-list**: ordinals count from the sub-list's
  `start` (item's `start`, else 1; top uses `options.start`). Because each
  sub-list is walked independently, numbering restarts automatically and is stable
  regardless of where items paginate. All levels use the `N.` decimal style (a./i.
  per-level styles are out of scope).
- **Unordered markers cycle by depth**: default marker at depth `d` is
  `CYCLE[d % 3]` where `CYCLE = ['•', '◦', '▪']`. An explicit `bullet` (top
  `options.bullet`, or an item's `bullet` for its sub-list) overrides that level's
  marker and is drawn as text.

## Markers — two kinds

**Vector markers** (the default bullet cycle — `•`/`◦`/`▪` cannot all be WinAnsi
text): drawn as vector geometry so they render with any font.

- disc = filled circle (`• `, depth 0, 3, …); ring = stroked circle (`◦`,
  depth 1, 4, …); square = filled `re` rectangle (`▪`, depth 2, 5, …).
- Size ≈ `0.35 × fontSize` (diameter / side), vertically centered on the first
  body line (center y ≈ baseline + `0.3 × fontSize`), right-aligned in the gutter
  (right edge at `bodyIndent − markerGap`).
- Circle approximated by four cubic Béziers (`c`); each marker is its own
  `q … Q` path.
- Under a tagged flow, the marker path is wrapped in the `/Lbl` marked content
  (`wrapMarkedContent` + `allocContentMcid`, the pattern `barcodeplace.ts` uses)
  and the `/Lbl` element carries `/ActualText` = the semantic glyph
  (`'•'`/`'◦'`/`'▪'`) via `StructElement.Append('Lbl', { actualText })`.

**Text markers** (ordered ordinals like `3.`, or an explicit `bullet` string):
drawn as today via `stampText` (WinAnsi), tagged `/Lbl` with the marker string as
its natural text.

### db7v.3 output change

The shipped flat-list default bullet changes from a text `•` (WinAnsi `\225`)
glyph to a vector disc. The two db7v.3 bullet-count tests are updated to count
marker **paints** (fill/stroke ops `f`/`S`, which flow body text never emits)
rather than `\225`:

- "renders a bullet list: one marker glyph per item" → assert one marker paint per
  item.
- "draws the marker once when an item spans a page boundary" → assert exactly one
  marker paint across all pages.

Explicit-`bullet` and ordered-numbering tests are unaffected (still text markers).

## Indent — cumulative per-depth gutter

- `markerGap = 0.5 × fontSize` (shared).
- `gutter(d)` = (max marker width among **all** items at depth `d`) + `markerGap`,
  where a vector marker's "width" is its diameter (`0.35 × fontSize`) and a text
  marker's is its measured width. Computed in a first pass over the flattened
  tree, so every level's bodies align document-wide.
- **Body indent** of a depth-`d` item = `Σ gutter(0..d)`. A child item's marker
  (right-aligned within `gutter(d)`) therefore begins at the parent's body left
  edge — the standard nested-list look.
- `options.indent`, if given, overrides the auto value with a **uniform step**:
  `gutter(d) = options.indent` for every depth (so body indent = `(d+1) ×
  indent`). For a flat list this equals today's behavior.

## Flattening & the element model

A recursive **pre-order** walk (parent item, then its sub-list) expands the tree
into the existing linear `ListItemElement` sequence pushed onto `Flow.items`. The
`Flow.Render` loop, pagination, `AddColumnBreak`, and gap handling are all
**unchanged**.

`ListItemElement` is generalized so each element carries its own:

- **body indent** (per depth) — moved off the shared `NormalizedListOptions` onto
  the element (today it lives in the shared opts).
- **marker descriptor**: either a text marker (string) or a vector marker
  (`{ shape: 'disc' | 'ring' | 'square'; actualText: string }`).
- shared body style (font/size/color/align/leading) stays in the shared options
  object (per-item style is db7v.8).

Spacing across the flattened sequence (computed in a post-pass once the full order
is known): element 0 carries the list-level `spaceBefore`; the last element
carries the list-level `spaceAfter`; every other element's `spaceAfter` =
`itemSpacing` (and `spaceBefore = 0`). This preserves the existing gap semantics
and reuses the `Render` gap engine untouched.

A **split** item (overflow remainder) keeps the existing pattern: a body-only
continuation, marker (text or vector) drawn once, reusing the same struct nodes.

## Tagged structure — nested `/L`

Each sub-list is one `/L`. A nested sub-list's `/L` is appended **under its parent
item's `/LBody`**:

```
/L                        (top list)
  /LI
    /Lbl                  (marker; /ActualText for a vector bullet)
    /LBody                (item text marked content)
      /L                  (nested sub-list)
        /LI
          /Lbl
          /LBody …
```

Because the walk is pre-order, a parent item draws before its children, so its
`/LBody` exists when the child sub-list first draws. Per-sub-list holders chain:
the top holder creates its `/L` under `ctx.structParent`; a nested holder creates
its `/L` under `parentItem`'s `/LBody`, obtained via a `parentBody()` accessor that
reads the parent `ListItemElement`'s lazily-created `/LBody`. `/L` nodes remain
lazily created on first draw (orphan avoidance), so an all-empty list tags nothing.

**Edge:** a parent item whose text is empty never creates an `/LBody`; if it has
children, the nested `/L` falls back to `ctx.structParent` (degraded but valid).
Documented; parent items with children are expected to have text.

Untagged flows skip all of this and stay byte-identical to no tagging.

## Validation

- `items` is an array; each node is a string or an object with a string `text`.
- On an item object: `items` (if present) is an array (recurse); `ordered` (if
  present) is a boolean; `bullet` (if present) is a string; `start` (if present)
  is an integer. Wrong types throw `TypeError`.
- Existing `FlowListOptions` validation (`start`, `itemSpacing`, `spaceBefore`,
  `spaceAfter`, etc.) is unchanged.
- Empty array remains a no-op; an empty `items: []` on an object is a leaf with no
  sub-list.

## Testing (`test/flow.test.ts`, additive + two db7v.3 updates)

Hermetic builders, load-bearing assertions.

- **Nesting indent** — a two-level list; assert depth-1 item bodies are indented
  further than depth-0 bodies (extracted fragment x-positions), and depth-1
  markers begin at the depth-0 body edge.
- **Ordered restart per sub-list** — top ordered `1. 2.`, each with an ordered
  sub-list; assert each sub-list renders `1. 2.` (restarts), not a running count.
- **Bullet cycle by depth** — a three-deep unordered list; assert the marker kind
  per level: disc paint at depth 0, ring (stroke) at depth 1, square at depth 2,
  and disc again at depth 3 (cycle). Under a tagged flow, assert `/Lbl`
  `/ActualText` = `•`/`◦`/`▪` per level.
- **Mixed nesting** — a bulleted top with an ordered sub-list (and vice versa) via
  the item `ordered` override.
- **Explicit bullet override** — an item `bullet: '*'` draws a text marker at that
  level (not a vector shape).
- **Split in a sub-list** — a long nested item overflows a short column; exactly
  one marker paint across pages; body resumes at the correct (nested) gutter.
- **Tagged nested `/L`** — `GetStructTree` shows `/L → /LI → /Lbl + /LBody → /L →
  /LI …`; a nested `/L` sits under the parent `/LBody`.
- **Validation** — bad node/`items`/`ordered`/`bullet`/`start` types throw
  `TypeError`.
- **db7v.3 updates** — the two bullet-count tests count marker paints (`f`/`S`)
  instead of `\225`.
- **Load-bearing** — break the nested-`/L`-under-`/LBody` placement (append under
  `structParent` instead) and confirm the tagged test goes red; break the cycle
  index and confirm the bullet-cycle test goes red.

Quality gates before closing: `npm run typecheck` and `npm test` green.

## Defaults chosen (flagged for record)

- **Recursive item objects** for nesting (chosen over implicit nested arrays);
  forward-compatible with db7v.8 per-item overrides (additive fields on the same
  object).
- **Vector bullet markers at all depths** (`• ◦ ▪` disc/ring/square), so the cycle
  renders with any font; the flat default bullet changes from text to vector
  (db7v.3 tests updated).
- **Ordered lists use `N.` decimal at every level**; numbering restarts per
  sub-list.
- **Cumulative per-depth auto-indent**; `options.indent` overrides to a uniform
  step.

## Out of scope (follow-up)

- Per-item style overrides (font/size/color per item) — db7v.8.
- Alternate ordinal styles per level (`a.`, `i.`, `A.`) — a further refinement.
- Per-level `itemSpacing`/indent-step overrides (a `levels` options array) — not
  needed for the chosen item-object model; can be added later.

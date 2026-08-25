# Flow lists (bulleted / numbered) — design (db7v.3)

**Issue:** aspose-pdf-foss-for-ts-db7v.3 (parent epic db7v — Flow layout engine)
**Date:** 2026-07-24
**Status:** approved, ready to plan
**Depends on:** db7v.2 (Paragraph & heading elements) — shipped

## Goal

Add `flow.AddList(items, options)` to the flow layout engine: bullet and numbered
lists with a configurable marker, an auto or explicit body indent, per-item and
per-list spacing, automatic pagination/column flow, and opt-in PDF/UA logical
structure. Reuses the existing `flowTextBlock` word-wrap engine and `stampText`
single-line emitter; the `Flow.Render` loop is unchanged.

## Scope (v1)

- Bullet and numbered lists, **flat only** (no nesting). Nesting is a filed
  follow-up issue.
- Items passed as a **string array** (each string is one word-wrapped item).
  Widening to object items (per-item overrides) is a later, non-breaking change.
- Marker drawn **only on the first line** of an item; a split item resumes
  body-only in the next column/page with no repeated marker.
- Under a tagged flow, emit the **full** `/L` → `/LI` → (`/Lbl` + `/LBody`)
  subtree.

## Public API

```ts
/** Options for {@link Flow.AddList}. All lengths in points. */
export interface FlowListOptions {
  /** false → bullet list; true → 1. 2. 3. numbered list. Default false. */
  ordered?: boolean;
  /** First ordinal for an ordered list. Integer. Default 1. */
  start?: number;
  /** Marker glyph for an unordered list. Default "•" (U+2022). */
  bullet?: string;
  /** Body + marker font. Default Helvetica. */
  font?: AuthoringFont;
  /** Font size (points). Default 11. */
  fontSize?: number;
  color?: [number, number, number];
  leading?: number;
  /** Body-text indent from the list's left edge (points). Default: auto —
   *  widest measured marker width + markerGap. */
  indent?: number;
  /** Vertical gap between consecutive items. >= 0. Default 0. */
  itemSpacing?: number;
  /** Gap above the whole list (dropped at a column top). >= 0. Default 0. */
  spaceBefore?: number;
  /** Gap below the whole list (dropped at a column top). >= 0. Default 0. */
  spaceAfter?: number;
  /** Body alignment. Default 'left'. */
  align?: 'left' | 'center' | 'right' | 'justify';
}

/** Append a bullet or numbered list. Each string is one word-wrapped item.
 *  Empty array is a no-op. Chainable. */
AddList(items: string[], options?: FlowListOptions): this
```

## Element model & layout

`AddList` expands `items` into **one `ListItemElement` per item**, pushed onto the
same `items` queue that `Flow.Render` already drains. Pagination, column breaks
between items, and the existing `spaceBefore`/`spaceAfter`/`paragraphSpacing` gap
handling all come for free — `Render` needs no changes.

Each `ListItemElement` holds:

- the pre-computed **marker string** (`"•"` or `"3."`); the ordinal is fixed at
  `AddList` time, so numbering is stable regardless of where items land;
- the **body text**, typographic options, and the **shared gutter width**
  (`indent`);
- `spaceBefore` / `spaceAfter` derived from list options:
  - first item carries the list-level `spaceBefore`;
  - each item's `spaceAfter` = `itemSpacing`;
  - the last item's `spaceAfter` = the list-level `spaceAfter`.

  This makes both inter-item gaps and the list's outer gaps fall out of the
  existing `Render` loop.

**Gutter width** (auto `indent`): computed once at `AddList` time as
`max(measureText(font, marker, fontSize))` over all markers `+ markerGap`, where
`markerGap ≈ 0.5 × fontSize`. So `"1."` and `"10."` share one body indent and
align. An explicit `indent` option overrides the auto value.

**`place(ctx)`** for one item:

1. Body rect = `[x + indent, top - availHeight, width - indent, availHeight]`;
   body drawn via `flowTextBlock` (reusing its wrap/overflow/justify logic).
2. **Marker drawn only on first placement** (a `markerDrawn` flag mirroring
   `TextElement`'s tag-once pattern), via `stampText` at
   `(x + indent - markerWidth, markerBaselineY)` — right-aligned against the
   gutter so ordinals align on the period. The marker baseline is derived from
   the body's first-line baseline (font size + leading) so marker and first body
   line share a baseline.
3. If `flowTextBlock` returns a remainder, `place` returns a continuation
   `ListItemElement` carrying **body-only** remainder text and
   `markerDrawn = true` (no repeated marker).

An empty item string draws nothing and is discarded (the same null-remainder
path `TextElement` uses).

## Tagged logical structure

When the flow is `tagged`, the list emits the full PDF/UA subtree:
`/L` → `/LI` → (`/Lbl` + `/LBody`).

Items are independent `FlowElement`s on the queue but must share **one `/L`
node**. Rather than thread new state through `Render`, `AddList` creates a
**shared holder** (`{ list?: StructElement }`) captured by all the item elements
it pushes:

- On an item's **first draw** under a tagged flow, if `holder.list` is unset,
  create it lazily: `holder.list = ctx.structParent.Append('L')`. Lazy creation
  means an all-empty list tags nothing (same orphan-avoidance rule as
  `TextElement`).
- The item then appends `const li = holder.list.Append('LI')`, then
  `const lbl = li.Append('Lbl')` and `const lbody = li.Append('LBody')`.
- Marker drawn via `stampText({ tag: lbl, ... })`; body via
  `flowTextBlock({ tag: lbody, ... })` — both already route through
  `wrapMarkedContent` + `allocContentMcid`.
- A **split** continuation reuses the same `li` / `lbody` (passed into the
  continuation element) so overflow marked content lands under the original
  `/LBody`; the marker is not redrawn, so no second `/Lbl`.

Reading order is correct: items draw in queue order and each `Append` extends
`/L` → `/LI` in sequence. Untagged flows skip all of this and are byte-identical
to no tagging, consistent with the rest of the flow set.

## Testing & validation

Add to `test/flow.test.ts` (hermetic builders, per repo TDD convention):

- **API / option validation**: `start` integer, `itemSpacing`/`spaceBefore`/
  `spaceAfter` `>= 0`, wrong types throw `TypeError`; empty array is a no-op;
  ordered numbering honors `start`.
- **Layout**: a bullet list and a numbered list render to a page; body text is
  indented past the marker (assert via `Page.GetTextFragments` x-positions —
  marker left of body, body lines left-aligned at the gutter); `"10."`-vs-`"1."`
  share one body indent.
- **Marker once on split**: force an item to overflow a short column; assert the
  marker appears exactly once and the continuation body resumes at the gutter on
  the next page (via extracted fragment positions across two pages).
- **Item spacing / column breaks**: `itemSpacing` gap between items;
  `AddColumnBreak` between items works.
- **Tagging**: with `{ tagged: true }`, `GetStructTree` shows
  `/L` → `/LI` → `/Lbl` + `/LBody`; an all-empty list produces no `/L`; a split
  item keeps one `/Lbl` and one `/LBody`.
- **Load-bearing check**: confirm a tagging assertion goes red if the subtree is
  built wrong (not merely that it passes green).

Quality gates before closing the issue: `npm run typecheck` and `npm test` green.

## Parity target

Aspose-PDF-FOSS-for-Go `_examples/feature_showcase/main.go` uses flow lists as
part of the document-authoring showcase; this issue brings the TS library to
parity for flat bullet/numbered lists while keeping the established TS option
idiom (`FlowListOptions` with `font`/`fontSize`/`color`/`align`/`leading`) rather
than the Go `TextStyle` field names.

## Follow-ups (filed as issues)

- Nested lists (sub-lists indent, numbering restarts per level, alternating
  markers).
- Object-form items for per-item overrides.

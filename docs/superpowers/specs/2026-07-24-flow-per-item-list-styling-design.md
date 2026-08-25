# Flow per-item list styling — Design (db7v.8)

## Summary

Extend `flow.AddList` so individual list items can override the list-level
appearance. The `string[] → object item` widening the original issue describes
already shipped in db7v.7 (nested lists introduced `FlowListItem` and
`FlowListNode`); db7v.8 completes the story by adding **per-item style
overrides** to the existing `FlowListItem`. Non-breaking: a bare string, and an
object item with no style fields, render exactly as today.

## Motivation

Today every item of one list shares a single resolved options object
(`NormalizedListOptions`): one font, size, colour, alignment, leading, indent,
and spacing. Callers cannot make a single item bold/larger/coloured, give one
item extra breathing room, or hang one item at a different indent without
splitting the list. Per-item overrides remove that limitation while keeping the
common (uniform) list a single cheap code path.

## API

`FlowListItem` (already exported from `src/index.ts`) gains eight optional
style fields. Names mirror `FlowListOptions` for consistency; each overrides the
list-level value **for that item only**:

```ts
export interface FlowListItem {
  text: string;                                    // existing
  items?: FlowListNode[];                          // existing (db7v.7): sub-list
  ordered?: boolean;                               // existing: THIS item's sub-list
  bullet?: string;                                 // existing: THIS item's sub-list
  start?: number;                                  // existing: THIS item's sub-list
  // NEW — per-item style overrides:
  font?: AuthoringFont;
  fontSize?: number;
  color?: [number, number, number];
  align?: 'left' | 'center' | 'right' | 'justify';
  leading?: number;
  spaceBefore?: number;
  spaceAfter?: number;
  indent?: number;
}
```

The existing `ordered`/`bullet`/`start` keep their db7v.7 meaning — they
configure the item's **sub-list**, not the item's own text — so there is no
naming conflict with the new style fields.

## Semantics

**Marker inherits item styling.** The item's marker (ordinal or bullet) is
drawn in the item's resolved font/size/colour, so a red or larger item gets a
red or larger marker. Which marker is drawn (ordinal vs. bullet vs. vector
shape) is unchanged — it still comes from the sub-list config
(`markerFor`), not from the style overrides.

**Text/marker style** (`font`, `fontSize`, `color`, `align`, `leading`). Each
item resolves its own `NormalizedListOptions` by merging its overrides onto the
list-level options. `ListItemElement` already reads all of these (and draws the
marker) from its `opts`, so the element itself barely changes.

**Marker gutter alignment.** `markerGap` stays a **list-level** value, so all
markers at a given depth right-align at a common gutter edge regardless of
per-item size. The per-depth auto-indent (`maxWidthByDepth`) is now measured
using **each item's resolved font/size**, so a larger ordinal/marker at a depth
widens that depth's gutter and is never clipped.

**`indent`.** An absolute body offset from the list's left edge for **that item
only** (same meaning as list-level `indent`), replacing the per-depth cumulative
indent for that item. Its marker right-edges at `x + indent - markerGap`. It
does **not** shift descendant items' computed indents. Setting it can misalign
one item's marker from its siblings — that is the caller's explicit choice.

**`spaceBefore` / `spaceAfter`.** When provided, each **replaces** the value the
spacing post-pass would otherwise assign that item — the list-level
`spaceBefore`/`spaceAfter` at the first/last item, or `itemSpacing` between
items. Adjacent gaps still combine through the flow engine's element-adjacency
rule: the gap between two consecutive elements is
`previous.spaceAfter + paragraphSpacing + next.spaceBefore` (they add).

**Non-breaking / cheap common path.** An item with no style overrides resolves
to the *same* `NormalizedListOptions` instance as the list, so uniform lists
(and plain `string[]` lists) produce byte-identical output to today.

## Architecture

All changes are in `src/flow.ts` (plus README prose). `src/index.ts` needs no
change (`FlowListItem` is already exported).

- **`FlowListItem`** — add the eight optional fields with doc comments.
- **`validateNode(n)`** — validate each new field with the existing `TypeError`
  idiom: `fontSize` positive-finite; `color` a 3-number tuple; `align` one of
  the enum; `font` a string; `leading`/`indent`/`spaceBefore`/`spaceAfter`
  non-negative finite. Absent fields are skipped.
- **`resolveItemOptions(list, item)`** (new helper) — returns `list` unchanged
  when the item sets no style overrides; otherwise a shallow copy with
  `font`/`fontSize`/`color`/`align`/`leading` overridden. `markerGap`,
  `itemSpacing`, `spaceBefore`, `spaceAfter`, `indentOverride`, `ordered`,
  `start`, `bulletOverride` are carried from `list`.
- **`buildListElements`** — in the pre-order `walk`, resolve `itemOpts` per node
  and:
  - measure `maxWidthByDepth[depth]` using the item's resolved font/size;
  - store `itemOpts` on the `Planned` entry (and keep the raw `item` for its
    `indent`/`spaceBefore`/`spaceAfter`);
  - construct with per-item indent `item.indent ?? cumulative[depth]` and
    `opts = itemOpts`;
  - spacing post-pass:
    `spaceBefore = item.spaceBefore ?? (i === 0 ? o.spaceBefore : 0)`,
    `spaceAfter  = item.spaceAfter  ?? (i === last ? o.spaceAfter : o.itemSpacing)`.
- **`ListItemElement`** — no structural change. It already reads
  font/size/colour/align/leading/markerGap from `this.opts`, indent from
  `this.indent`, and draws the marker from `this.opts`, so per-item styling
  flows through for free (including to the body-only continuation, which copies
  `this.opts`/`this.indent`).

## Testing

TDD in `test/flow.test.ts`, new `describe('flow per-item list styling')`, with
load-bearing assertions:

- **fontSize override** — an item with a larger `fontSize` emits a different
  `Tf` size / larger first-line advance than its siblings.
- **color override** — `color: [1,0,0]` emits `1 0 0 rg` for both the item's
  body text and its marker.
- **marker inherits size** — a larger-`fontSize` item's vector disc scales (its
  Bézier extents grow) and its depth gutter widens (assert via body-x /
  `GetTextFragments`).
- **per-item indent** — overriding one item's `indent` shifts only that item's
  body x; siblings are unchanged.
- **per-item spacing** — `spaceAfter` on a middle item increases the gap before
  the next item (its y drops further) and replaces `itemSpacing`.
- **validation** — each bad field type throws `TypeError`.
- **non-breaking** — a plain `string[]` list and an object list with no style
  fields render byte-identically.

Then `npm run typecheck` and the full `npm test` suite green. Prove at least one
new assertion load-bearing by mutation (e.g. force `resolveItemOptions` to
ignore the override and confirm the fontSize test goes red).

## Out of scope (YAGNI)

- Per-item marker glyph/shape override (distinct from styling; the sub-list
  `bullet` already covers explicit glyphs where wanted).
- Per-item background fills or borders (that is table territory, not flow lists).
- Changing the flow engine's element-adjacency spacing rule.

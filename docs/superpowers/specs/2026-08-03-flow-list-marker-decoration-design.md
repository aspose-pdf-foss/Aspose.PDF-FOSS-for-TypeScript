# Text decoration on `flow.AddList`, markers included

Issue: `1gg0.15` (epic `1gg0` — page-furniture & text-authoring parity gaps).

## Problem

`1gg0.4` added `underline` / `strikethrough` / `background` to the text-authoring
layer and threaded them through four consumers. `flow.ts` was one of them, but
only via `FlowParagraphOptions` → `paragraphOptions()`. `FlowListOptions` never
gained the fields at all, so today `flow.AddList` accepts no decoration:

- `ListItemElement.measure` and `.place` build a `bodyOpts` literal by copying a
  fixed field list (`font`, `fontSize`, `color`, `align`, `leading`), and
- the marker is a *separate* draw — `stampText` for an ordinal or an explicit
  `bullet:` string, `drawShapeMarker` for the default • ◦ ▪ vector cycle — with
  its own hand-copied `StampOptions`.

So an underlined list is not merely missing its marker rule; it is missing the
option. Both halves are in scope here: add the options, forward them to the
body, and decorate the marker.

## Decisions

**Two separate decoration runs, not one spanning the gutter.** The marker is
decorated over its own advance width and the body over its own line boxes; the
`markerGap` between them stays blank. This matches what `1gg0.4` already
established for a TOC row (title, dot leader and page number each decorated
independently) and needs no cross-stamp geometry: the body's per-line rects are
`flowTextBlock`'s to compute, and unioning the marker into the first of them
would be a one-off code path in `ListItemElement`. The reading is also the
defensible one — the marker is text, so it gets underlined; the gutter is not.

**Vector bullets are decorated too.** An unordered list must not silently differ
from an ordered one. `drawShapeMarker` paints filled paths rather than glyphs, so
it resolves and emits the decoration itself rather than inheriting it from
`stampText`.

**Per-item overrides, matching the existing cascade.** `FlowListItem` already
overrides `font` / `fontSize` / `color` / `align` / `leading` for one item;
decoration joins them rather than being list-level only.

**`behind` is not offered**, per the `1gg0.4` spec's deliberate asymmetry: flow
content is laid into a column the flow is composing, and sinking one element of
it beneath the page reorders it against its siblings.

## Changes

### Options and validation (`flow.ts`)

`FlowListOptions` gains `underline?: Decoration`, `strikethrough?: Decoration`
and `background?: Background`, declared inline with doc comments exactly as
`FlowParagraphOptions` declares them. `NormalizedListOptions` carries the three
through unresolved — the body and text-marker paths hand raw options to
`flowTextBlock` / `stampText`, which resolve them, and only the vector-marker
path needs an explicit `resolveDecor`.

`normalizeListOptions` validates them with `validateDecoration` /
`validateBackground` from `textdecor.ts`, and `validateNode` does the same for
the per-item form. Validation is therefore **eager**: `AddList` throws on a
malformed colour before any element is queued, which is how that function already
treats `ordered`, `start`, `fontSize` and `indent`. (`AddParagraph` defers to
`normalizeBlockOptions` at place time; the list path validates up front because
it already does, not because the two should differ in principle.)

`resolveItemOptions` merges the three onto the list options. Its uniform-list
fast path — return `list` unchanged when the item sets no style field, keeping
output byte-identical to a plain string list — must test the three new fields
too, or a decorated item silently draws undecorated.

### Body (`ListItemElement`)

`measure` and `place` build the same `bodyOpts` literal twice today. Extract one
`bodyOptions(opts)` helper and add the three fields there, so the two cannot
drift. Decoration does not affect line layout, so `measure` returns the same
heights as before; the shared helper is for the invariant, not the geometry.

### Text markers

`markerOpts` gains the three fields. `stampText` resolves them against the
marker's own font, size and colour and paints at the stamp's measured width, so
the run covers exactly the marker glyphs and stops at the gutter. Its
`markContent` wraps the whole body — decoration included — in the `/Lbl` marked
content, which is what we want.

### Vector markers (`drawShapeMarker`)

Takes the font and the decoration options (it takes neither today) and does the
work `stampText` does for the text case:

```
resolveDecor(decor, color ?? [0, 0, 0], fontSize, vmetricsFor(font))
decorRects([{ x: rightX - size, baseline, width: size }], resolved)
```

`beneath` is emitted before the shape operators and `above` after, inside the
same string that `wrapMarkedContent` then wraps as `/Lbl`. The function already
works in absolute page space, so the rects need no `cm`.

The background's *vertical* extent comes from `resolveDecor`, i.e. the font's
ascent and descent at `baseline` — not from the bullet's `0.35 * fontSize` box.
Only the horizontal extent is the bullet's. Otherwise a bullet's background would
be a small square floating at x-height while the body's background ran the full
line height beside it.

### Continuations

No change. `markerDrawn` already confines the marker to its first placement, so
its decoration is drawn once; the body continuation carries the same options, so
every wrapped line gets its rects.

## Testing

New cases in `test/flow-decoration.test.ts`, beside the existing paragraph ones:

- An ordered list with `underline` emits rules under **both** the ordinal and the
  body.
- **Placement, read back**: a `page.GetPaths` assertion that the marker's rule
  sits left of the body's rule and shares its baseline — checked where the rect
  actually lands rather than by string-matching the stream.
- A default (vector-bullet) list with `underline` decorates the bullet.
- A per-item `underline` decorates that item only, not its siblings — the guard
  on `resolveItemOptions`' fast path.
- A bullet `background` spans the font's ascent→descent, not the 0.35em bullet
  box.
- Regression: an undecorated list still emits no `re f`, so the fast path stays
  byte-identical.
- `AddList` throws a `TypeError` on a malformed `underline.color`, and does so
  before anything is queued.

Then the mutation pass CLAUDE.md requires: remove the marker's `decorRects` call
and confirm the suite goes red, so the marker assertions are known to be
load-bearing rather than merely green.

## Documentation

`README.md`: extend the `AddList` options paragraph (~line 520) with the three
fields and the two-runs behaviour, and strike the list-marker clause from the
text-decoration entry under Limitations (~line 1460). The TOC-leader clause in
that entry stays — it is still true, and `1gg0.4` argued it is the defensible
reading.

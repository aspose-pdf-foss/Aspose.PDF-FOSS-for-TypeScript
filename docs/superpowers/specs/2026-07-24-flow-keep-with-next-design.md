# Flow heading keep-with-next / orphan control — design (db7v.6)

**Issue:** aspose-pdf-foss-for-ts-db7v.6 (parent epic db7v — Flow layout engine)
**Date:** 2026-07-24
**Status:** approved, ready to plan
**Depends on:** db7v.2 (Paragraph & heading elements) — shipped

## Goal

A heading that lands at a column bottom with no room for at least one line of the
following element should push to the next column (keep-with-next), instead of
dangling alone at the foot of a column. Deferred from db7v.2 ("Out of scope"),
which named this as a self-contained follow-up needing engine lookahead in
`Flow.Render`.

## Approach

Non-destructive lookahead. `flowTextBlock` draws-and-mutates the page, so the
engine cannot draw a heading and then undo it if the following line does not fit.
Instead the engine measures — without drawing — whether the heading fully fits
and whether the next element can then place at least one line in the leftover
column height; if not, it advances the column *before* drawing the heading.

### Non-destructive measure (`stamp.ts`)

Add a measure-only counterpart to `flowTextBlock`:

```ts
export function measureTextBlock(
  text: string, width: number, availHeight: number, options?: TextBlockOptions,
): { usedHeight: number; remainder: string | null };
```

It runs the identical `layoutText` path as `flowTextBlock` (same option
normalization, same shape/simple driver selection, same `probe`/`layoutText`
call) but never appends content. Because both call the same layout with the same
inputs, a measure always agrees with the subsequent draw's `usedHeight` and
`remainder`. `flowTextBlock` remains the source of truth for drawing;
`measureTextBlock` is its read-only twin.

### `FlowElement` additions

```ts
interface MeasureContext { width: number; availHeight: number; }

interface FlowElement {
  place(ctx: PlaceContext): PlaceResult;                 // existing
  readonly spaceBefore?: number;                         // existing
  readonly spaceAfter?: number;                          // existing
  /** Non-destructive dry-run of place(): predict usedHeight and whether the
   *  element fully fits in `availHeight`, without drawing. */
  measure?(ctx: MeasureContext): { usedHeight: number; fits: boolean };
  /** True only for headings — the elements eligible for keep-with-next. */
  readonly keepWithNextEligible?: boolean;
  /** Per-element override of the flow keep-with-next policy; `undefined` inherits
   *  the flow default. Meaningful only when `keepWithNextEligible` is true. */
  readonly keepWithNext?: boolean;
}
```

- `measure` is implemented by both `TextElement` and `ListItemElement` (the
  "next element" the engine probes can be either). It delegates to
  `measureTextBlock`, mirroring each element's `place` rect derivation
  (`ListItemElement` uses `width - indent` for its body, as `place` does).
- `fits === (remainder === null)`.

### Engine logic (`Flow.Render`, text-element branch)

After `top`, `besideFloat`, `elemX`, `elemWidth`, and `availHeight` are computed,
and before `item.place(...)`:

```
if item.keepWithNextEligible AND effectiveKeep(item) AND !atColumnStart AND !besideFloat:
    self = item.measure({ width: elemWidth, availHeight })
    if self AND self.fits:                                   // heading fully lands here
        next = queue[1] if it is a FlowElement (not a column-break or float), else undefined
        if next AND next.measure:
            gapNext   = (item.spaceAfter ?? 0) + paragraphSpacing + (next.spaceBefore ?? 0)
            remaining = (top - self.usedHeight) - gapNext - contentBottom
            if next.measure({ width: columnWidth, availHeight: remaining }).usedHeight <= 0:
                advanceColumn(); continue                    // push heading; nothing drawn yet
```

- **Effective policy:** `effectiveKeep(item) = item.keepWithNext ?? flowKeepDefault`,
  where `flowKeepDefault = FlowOptions.keepHeadingsWithNext ?? true`. Only
  headings reach this test (`keepWithNextEligible`), so paragraphs and list items
  are never kept-with-next regardless of the flow default.
- **`remaining` mirrors reality exactly:** when the next element is actually
  placed it receives `top = colTop - gapNext` and `availHeight = top -
  contentBottom`; the lookahead computes the same value from `colTop = top -
  self.usedHeight`. So the probe's one-line verdict matches what the next
  `place` would produce.
- **No infinite loop:** the `!atColumnStart` gate means that after a push the
  heading lands at a fresh column top and is drawn unconditionally on the next
  iteration. If even a full column cannot hold the heading plus one following
  line, the heading is drawn anyway (the orphan is unavoidable) — the engine
  never re-pushes.

### Non-triggers (documented no-ops)

Keep-with-next does **not** fire — the heading draws where it is — when:

- the heading is the last queued element (no following content);
- the next queued item is a column-break (the heading intentionally ends the
  column) or a float (positioned separately);
- the heading itself does not fully fit in the current column (`!self.fits`) — it
  overflows/continues by the normal path;
- the heading sits beside an active float (`besideFloat`). Float-interaction
  refinement is out of scope here and belongs to db7v.9 / db7v.10.

## Public API additions

```ts
interface FlowOptions {
  // ...existing fields unchanged...
  /** Push a heading to the next column when the following element cannot fit at
   *  least one line beneath it in the current column. Default true. Overridable
   *  per heading via FlowHeadingOptions.keepWithNext. */
  keepHeadingsWithNext?: boolean;
}

interface FlowHeadingOptions extends FlowParagraphOptions {  // was: type alias
  /** Override the flow's keepHeadingsWithNext policy for this heading.
   *  `undefined` inherits the flow default (true). */
  keepWithNext?: boolean;
}
```

- `FlowHeadingOptions` changes from a bare `type` alias of `FlowParagraphOptions`
  to an `interface` that `extends` it, adding `keepWithNext`. Existing usages are
  source-compatible.
- `keepHeadingsWithNext` and `keepWithNext` validate as booleans when present
  (throw `TypeError` otherwise), consistent with existing option validation.
- `AddHeading` sets `keepWithNextEligible = true` and passes the per-heading
  `keepWithNext` (bool | undefined) into `TextElement`. `AddParagraph` /
  `makeParagraph` pass `keepWithNextEligible = false`.
- A **continuation** of a split heading is constructed non-eligible
  (`keepWithNextEligible = false`): it has already started drawing, so it must not
  re-trigger keep-with-next.

## Byte-output note

The default `keepHeadingsWithNext: true` intentionally changes pagination for any
document whose heading currently dangles at a column bottom — that is the fix.
Output is therefore *not* byte-identical to db7v.2 for such documents; documents
with no dangling heading are unaffected. `keepHeadingsWithNext: false` restores
db7v.2 behavior exactly.

## Testing (`test/flow.test.ts`, additive)

Programmatic fixtures per repo convention; assertions proven load-bearing (break
the code path and confirm the suite goes red), not merely green.

- **Push when next line does not fit** — a column sized so a heading fits but the
  following paragraph's first line does not; assert the heading and the paragraph
  both land at the top of the next column (extracted text Y positions), leaving
  the first column short.
- **No push when next line fits** — same shape but one line of slack; assert the
  heading stays at the first column bottom with the paragraph's first line
  beneath it.
- **Per-heading opt-out** — `AddHeading(2, …, { keepWithNext: false })` in the
  push scenario keeps the heading at the column bottom.
- **Flow-level default + override** — `NewFlow({ keepHeadingsWithNext: false })`
  disables pushing flow-wide; a per-heading `{ keepWithNext: true }` re-enables it
  for one heading.
- **Next is a list** — a heading followed by `AddList` pushes when the first list
  item's first line does not fit (confirms "any queued flow content").
- **No-op: last heading** — a trailing heading with nothing after it draws in
  place.
- **No-op: column-break next** — heading immediately before `AddColumnBreak`
  draws in place (the break already moves the following content).
- **No-op: float next** — heading immediately before `AddFloatBox` draws in place.
- **Orphan accepted (no loop)** — a heading whose next line cannot fit even in a
  full empty column renders (heading drawn, no infinite loop / no throw).
- **Spacing folded in** — a heading `spaceAfter` (and next `spaceBefore`) large
  enough to consume the one-line slack triggers a push that a zero-spacing
  variant would not.
- **`measureTextBlock` agrees with `flowTextBlock`** — for representative
  text/width/height, the measure's `usedHeight` and `remainder` equal a real
  `flowTextBlock` draw's (the load-bearing invariant behind the lookahead).
- **Regression** — existing flow pagination/geometry/tagging tests and all
  `stamp.ts` tests stay green.

## Defaults chosen (flagged for record)

- **`keepHeadingsWithNext` defaults to `true`** — the feature's purpose is that
  headings do not dangle; opt out per flow or per heading.
- **Only headings are eligible** — paragraphs and list items never keep-with-next,
  matching the issue scope ("for flow headings").
- **"At least one line"** = the next element placing a non-zero `usedHeight` in
  the leftover height — one line is the conventional keep-with-next threshold.

## Out of scope (follow-up)

- Keep-with-next interaction with floats (a heading beside an active float) —
  belongs with the float refinements db7v.9 / db7v.10.
- Widow/orphan control *within* a single element (a paragraph's own last line
  dangling) — a separate concern from heading keep-with-next.
- Configurable keep-with-next count (> 1 following line).

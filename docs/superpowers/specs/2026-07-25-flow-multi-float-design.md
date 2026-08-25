# Simultaneous left+right floats and per-side float stacking — design (db7v.9)

**Issue:** aspose-pdf-foss-for-ts-db7v.9 (parent epic db7v — Flow layout engine)
**Date:** 2026-07-25
**Status:** approved, ready to plan
**Depends on:** db7v.4 (Floating boxes) — shipped

## Goal

Lift the flow engine's floating boxes from "one float at a time" (option A, the
db7v.4 scope) to: a left and a right float active concurrently, with text flowing
in the middle channel, plus multiple floats stacked vertically per side.

## Motivating defect

The current one-float model does not merely lack multi-float support — it
silently corrupts layout, because `Flow.Render`'s float branch never inspects
`activeFloat`:

- Two left floats (width 100, spacing 6, column at x=20) paint at
  `(20, 470)` and `(20, 464)`. The second **overlaps** the first. The db7v.4
  design claimed a second float "is laid out below (it clears)"; no code
  implements that.
- A left float followed by a right float replaces `activeFloat`, so the
  following text starts at `x = 20` and **runs through the left box**.

Both fall out of the model below.

## Scope

**In:**

- Concurrent left + right floats; text flows in the channel between them.
- Multiple floats per side, stacked **vertically** (a new same-side float is
  placed below the lowest same-side float in force, at the same column edge).
  Boxes on one side never sit shoulder-to-shoulder.
- A float that cannot fit horizontally beside an opposing float is pushed below
  that float.
- Correct staircase channels when stacked floats have different widths.

**Out (unchanged from db7v.4 / deferred to db7v.10):**

- CSS-style side-by-side float packing on one side.
- CSS `clear` controls and cross-column float carry — `advanceColumn` still
  discards all active floats (db7v.10).
- Keep-with-next beside a float — still disabled whenever an inset is in force.
- Splitting a float across columns — floats remain atomic.

## Public API

**Unchanged.** `flow.AddFloatBox(box, side)`, `doc.NewFloatingBox(options)` and
`FloatBoxOptions` all keep their current shapes. This is a `Render`-time layout
change only, which makes every existing single-float test a regression guard.

## Semantics

Two decisions fix the model:

1. **Per-side stacking is vertical only.** A second left float goes below the
   active left float's bottom, at the same column edge.
2. **A float never advances the pen past itself.** A float placed at the pen
   consumes its leading gap (today's behaviour); a float *pushed* down — by a
   same-side float or by an opposing float it cannot fit beside — leaves the pen
   untouched. Following text therefore fills the channel beside the upper box
   first, then the channel beside the lower one, then full width. This mirrors
   CSS's "floats are out of flow" and wastes no space.

Given `AddFloatBox(A,'left'); AddFloatBox(B,'left'); AddParagraph(long)`:

```
| +--------+  word0 word1 word2 word3  |
| |   A    |  word4 word5 word6 word7  |
| +--------+  word8 word9 ...          |
| +-----+     word12 word13 word14 ... |
| |  B  |     word16 word17 ...        |
| +-----+     word20 ...               |
| word24 word25 word26 word27 word28   |
```

## New module `src/floatstack.ts`

`flow.ts` is already ~970 lines and the new logic is pure arithmetic, so it lives
in its own module and is unit-tested directly — no PDF round-trip required.

```ts
/** A float occupying a horizontal band on one side, down to `bottom`. */
export interface ActiveFloat {
  side: 'left' | 'right';
  /** Horizontal space to avoid: box width + box spacing. */
  band: number;
  /** The y the box reaches down to (PDF user space, y up). */
  bottom: number;
}

/** Horizontal insets in force at pen y `top`: the max band per side over the
 *  floats whose bottom lies strictly below `top`. 0 for a side with none. */
export function insetsAt(
  floats: readonly ActiveFloat[], top: number): { left: number; right: number };

/** The highest (largest y) float bottom strictly below `top` — the y at which
 *  the channel next widens. `undefined` when no float is in force. */
export function nextBoundary(
  floats: readonly ActiveFloat[], top: number): number | undefined;

/** Drop the floats the pen at `top` has passed. */
export function pruneFloats(
  floats: readonly ActiveFloat[], top: number): ActiveFloat[];

/** Resolve a new float's top edge: never share a side, and only sit beside an
 *  opposing float when the box still fits the remaining channel. */
export function resolveFloatTop(
  floats: readonly ActiveFloat[], side: 'left' | 'right', width: number,
  spacing: number, naturalTop: number, columnWidth: number): number;
```

`insetsAt` taking the **max band per side** is what produces a correct staircase:
a wide float A above a narrow float B yields a wide inset down to `A.bottom`,
then a narrow one down to `B.bottom`.

`resolveFloatTop` iterates from `naturalTop`:

1. If a same-side float is in force at the current candidate, drop the candidate
   to `bottom − spacing` of the **lowest** (smallest y) in-force same-side float
   and repeat.
2. Else if `oppositeInset + width > columnWidth`, drop the candidate to
   `bottom − spacing` of the **lowest** in-force opposing float and repeat.
3. Else the candidate is the answer. In this case the function returns
   `naturalTop` itself, unchanged — the caller relies on that identity (see the
   pen rule below).

Each pass strictly lowers the candidate past a float bottom, so it terminates in
at most `floats.length` passes.

All comparisons use the existing `1e-9` epsilon convention.

## `Flow.Render` changes

`activeFloat: { side; band; bottom } | undefined` becomes `floats: ActiveFloat[]`.

- **Loop-top prune** — `floats = pruneFloats(floats, colTop)` replaces the
  single-float clear.
- **Float item** — `naturalTop = colTop − gap` (gap as today: dropped at a column
  top, else `pendingSpaceAfter + paragraphSpacing + box.spacing`), then
  `boxTop = resolveFloatTop(floats, side, box.width, box.spacing, naturalTop, columnWidth)`.
  - Does not fit (`boxTop − h < contentBottom`): `advanceColumn()` and retry, or
    throw the existing "does not fit in an empty column" error at a column start.
    `atColumnStart` provably implies `floats` is empty (placing a float clears
    `atColumnStart`, and `advanceColumn` clears `floats`), so the retry after
    `advanceColumn` terminates: it either fits or throws.
  - Paint at the column edge as today: left → `columnX(g, col)`, right →
    `columnX(g, col) + columnWidth − box.width`.
  - Push `{ side, band: box.width + box.spacing, bottom: boxTop − h }`.
  - **Pen:** `if (boxTop === naturalTop) colTop = boxTop;` — otherwise leave
    `colTop` alone. The comparison is exact by construction (`resolveFloatTop`
    returns the very `naturalTop` it was given when nothing pushes the box), so
    no epsilon is involved. This reduces to today's `colTop = boxTop` when only
    one float exists. `atColumnStart = false` and `pendingSpaceAfter = 0` in both cases.
- **Element placement** — `const { left, right } = insetsAt(floats, top)`;
  `elemX = columnX(g, col) + left`, `elemWidth = columnWidth − left − right`, and
  when either inset is non-zero, `availHeight = top − nextBoundary(floats, top)!`
  (guaranteed defined: a non-zero inset implies a float is in force). Element
  `place` is untouched — the beside-then-below reflow keeps falling out of the
  existing remainder mechanism, now once per staircase step.
- **Degenerate channel** — `elemWidth <= 0` (left + right bands swallow the
  column) is handled exactly like "could not fit one line beside": set
  `colTop = nextBoundary(...)`, prune, retry. No throw, no loop.
- **Remainder while beside a float** — `colTop = nextBoundary(...)` and prune,
  instead of clearing the one float. Remainders not beside a float still
  `advanceColumn()`.
- **Keep-with-next** — the `besideFloat` guard becomes "either inset non-zero";
  scope unchanged.
- **`advanceColumn`** — `floats = []`.

Termination: every "skip to the boundary" step strictly lowers `colTop` past at
least one float bottom and prunes it, so the placement loop cannot spin.

## Testing

### `test/floatstack.test.ts` (new, pure unit tests)

- `insetsAt`: left only, right only, both sides, and a same-side staircase (max
  band wins); floats already passed contribute nothing.
- `nextBoundary`: picks the highest bottom strictly below `top`; `undefined` when
  none is in force.
- `pruneFloats`: drops passed floats, keeps in-force ones.
- `resolveFloatTop`: same-side stacking drops below `bottom − spacing`; an
  opposing float that leaves room returns `naturalTop` unchanged; an opposing
  float that does not leaves the box below it; multi-pass resolution across both
  rules.

### `test/flow.test.ts` (integration additions)

- Simultaneous left + right: beside-text x ≥ `columnX + leftBand` and its right
  edge ≤ `columnX + columnWidth − rightBand`.
- Two left floats: no vertical overlap (`B.top ≤ A.bottom − spacing`), both
  painted at `columnX`.
- Staircase (wide A above narrow B): beside-text x steps left at `A.bottom`.
- Pen semantics: text fills the channel beside A before any text appears beside
  B (the regression guard for decision 2).
- A right float too wide to sit beside an active left float is pushed below it.
- Fully-closed channel: text skips to the first boundary instead of throwing or
  looping.
- A stacked float that overruns the remaining column height moves to the next
  column; a box taller than a full column still throws.
- Tagging order preserved with two floats under `{ tagged: true }`.
- All existing single-float tests stay green unmodified.

### Quality gates

- Prove the new assertions load-bearing: break each code path and confirm the
  suite goes red, then revert (CLAUDE.md fixture rule).
- `npm run typecheck` and `npm test` green.
- Keep the README Flow / floating-box section in sync.

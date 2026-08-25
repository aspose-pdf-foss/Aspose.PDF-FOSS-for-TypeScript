# Float clearing controls and deferred-float carry — design (db7v.10)

**Issue:** aspose-pdf-foss-for-ts-db7v.10 (parent epic db7v — Flow layout engine)
**Date:** 2026-07-25
**Status:** approved, ready to plan
**Depends on:** db7v.4 (Floating boxes), db7v.9 (multi-float layout) — both shipped

## Goal

Close the epic's last float gap: give flow elements a CSS-style `clear`, and
stop a float that does not fit the remaining column height from dragging all
following content into the next column with it.

## Motivating defect (measured)

A float that does not fit the remaining height currently calls `advanceColumn()`
while still at the head of the queue, so the float *and everything after it*
restart in the next column. The rest of the current column is abandoned.

Measured on a 2-column page (400×300, margins 20 → `contentTop` 280,
`contentBottom` 20, `columnWidth` 170), with one short paragraph, then a
246pt-tall box (fits an empty 260pt column, not the ~244pt left):

```
col 1 (x=20)        col 2 (x=210)
FIRST @270          X1..X14  @270→36
(nothing else)      AFTER    @296,270
```

Roughly 244pt of column 1 — 94% of its height — is wasted.

## Scope

**In:**

- `clear?: 'left' | 'right' | 'both'` on paragraphs, headings, lists and images.
- Deferred floats: a float that does not fit becomes pending, following content
  keeps filling the current column, and the box lands at the top of the next
  column.

**Out:**

- `clear` on `AddFloatBox` itself (a float clearing another float). It takes no
  options object, and there is no demand for it yet.
- Splitting a float box across a column boundary. Floats stay atomic; a box
  taller than an empty column still throws.
- Preserving call order in the struct tree for a deferred float — see
  "Accepted consequence" below.

## Public API

```ts
/** Which side's floats an element must clear before it places. */
export type FlowClear = 'left' | 'right' | 'both';

interface FlowParagraphOptions { /* ... */ clear?: FlowClear }
interface FlowHeadingOptions extends FlowParagraphOptions { /* inherits clear */ }
interface FlowListOptions      { /* ... */ clear?: FlowClear }  // applies to item 1
interface FlowImageOptions     { /* ... */ clear?: FlowClear }

interface FlowElement { readonly clear?: FlowClear }  // beside spaceBefore/spaceAfter
```

`FlowClear` joins the existing flow type exports in `src/index.ts`.

Usage:

```ts
flow.AddFloatBox(sidebar, 'left');
flow.AddParagraph(body);                             // wraps beside the sidebar
flow.AddHeading(2, 'Next section', { clear: 'both' }); // starts below it
```

## Clearing

One new function in `src/floatstack.ts`, which already owns float geometry:

```ts
/** Which side's floats to clear. */
export type ClearSide = 'left' | 'right' | 'both';

/** The y to drop the pen to so `side` is cleared: the lowest (smallest y)
 *  bottom among the floats on the requested side(s). `undefined` when the
 *  requested side carries no float. */
export function clearTo(
  floats: readonly ActiveFloat[], side: ClearSide): number | undefined;
```

`flow.ts` re-exports it (`export type { ClearSide as FlowClear }`) so the union
has exactly one definition and `floatstack.ts` keeps its no-imports property.

In `Flow.Render`, after the `isFloat(item)` branch (where `item` is known to be
a `FlowElement`) and before the `gap` / `top` computation:

```ts
if (item.clear) {
  const target = clearTo(floats, item.clear);
  if (target !== undefined) { colTop = target; floats = pruneFloats(floats, colTop); }
}
```

`clearTo` needs no `top` argument: the loop-top `pruneFloats` guarantees every
remaining float is in force at `colTop`.

Three properties this relies on:

- **Idempotent.** After the pen drops, the matching floats are pruned, so
  re-entering the loop with the same element (a boundary skip, a retry) changes
  nothing further.
- **Side-selective.** `clear: 'left'` leaves a right float that reaches further
  down still in force, so the element places in the right-narrowed channel
  rather than at full width. This is CSS's behaviour and is what distinguishes
  a real implementation from "drop the pen below everything".
- **Never inherited by continuations.** The remainder constructors in
  `TextElement` and `ListItemElement` do not pass `clear`, so a re-flowed
  remainder cannot clear a second time.

Clearing moves the pen and nothing else. The gap above the element
(`pendingSpaceAfter + paragraphSpacing + spaceBefore`) is then computed from the
new `colTop` under the existing rules, and `atColumnStart` is untouched — a
cleared element is mid-column content, not the top of a column, so its gap is
not dropped.

## Deferred-float carry

`Flow.Render` gains one piece of state:

```ts
let pending: FloatItem[] = [];   // floats deferred to the next column
```

- **A float that does not fit the remaining height** is deferred instead of
  advancing the column: `pending.push(item); queue.shift(); continue;`.
  Following content keeps filling the current column. The `atColumnStart` throw
  is untouched — a box taller than an empty column is still an error.
- **`advanceColumn()`** ends with `queue.unshift(...pending); pending = [];`.
  Callers that re-queue a remainder do `queue.unshift(res.remainder)` *before*
  calling `advanceColumn`, so a carried float lands ahead of that remainder and
  the text continues wrapping beside it.
- **Trailing floats.** The loop condition becomes
  `while (queue.length > 0 || pending.length > 0)`, with
  `if (queue.length === 0) { advanceColumn(); continue; }` at the top, so a
  float deferred by the last element is still drawn. The `while` condition
  guarantees `pending` is non-empty there, so `advanceColumn` always re-queues
  work and the loop cannot spin.

**Termination.** A column start has no active floats (placing a float clears
`atColumnStart`; `advanceColumn` clears `floats`), so a carried float at a
column top either fits or throws. Each column therefore places at least one
pending float before deferring the next, and there are finitely many floats.

## Accepted consequence: tagging follows draw order

Logical structure is appended when content **draws**. A deferred float
therefore tags *after* the text that follows it in call order, so in a tagged
flow its `/Figure` moves behind that text in the struct tree — reading order
tracks visual order rather than call order.

This is accepted rather than worked around. Preserving call order would mean
pre-allocating struct nodes at deferral time and back-filling them, a much
larger change for a debatable gain (visual order is a defensible reading order,
and it is the order a sighted reader encounters the content in). A test asserts
the resulting order so the behaviour is locked in rather than incidental.

## Testing

### `test/floatstack.test.ts`

- `clearTo` for `'left'`, `'right'`, `'both'`.
- Picks the **lowest** bottom when one side carries stacked floats.
- `undefined` for an empty list, and for a side that carries no float.

### `test/flow.test.ts`

- `clear: 'both'` drops a heading below both floats; the same heading without
  `clear` sits in the channel (the paired assertion is what makes it
  load-bearing).
- `clear: 'left'` with a right float reaching further down still places in the
  right-narrowed channel — proves side-selectivity, not just "pen dropped".
- `clear` on a list applies to item 1 only; `clear` on an image works; `clear`
  is a no-op with no floats and at a column start.
- Carry: the measured 2-column case above — column 1 fills with the following
  text instead of being abandoned, and the box lands at the top of column 2.
- A float deferred by the *last* element still renders (trailing flush).
- Two floats deferred from one column place on successive columns.
- Tagged flow: the deferred float's `/Figure` order, locking in the accepted
  consequence above.
- A box taller than an empty column still throws (existing test, unmodified).

### Quality gates

- Prove each new assertion load-bearing by breaking its code path and
  confirming the suite goes red, then reverting (CLAUDE.md fixture rule).
- Every pre-existing flow/floatbox test stays green **unmodified**.
- `npm run typecheck` and `npm test` green.
- Keep the README Flow section in sync.

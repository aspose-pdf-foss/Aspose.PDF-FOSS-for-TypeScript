# CSS float splitting — design

**Issue:** `zch2.15` — a float taller than a whole column lays out in flow; it
should split across columns.

**Goal:** an over-tall CSS float paints as much as fits, carries the rest to the
next column, and leads that column as a float again — with text wrapping beside
both halves.

## What the issue got right, and what it got wrong

**Right — `floatElement` is where this lands, and the degrade path is the thing
that changes.** Everything `zch2.10` shipped stays: text wraps beside a float,
`clear` works, shrink-to-fit is live, two same-side floats report.

**Right — the band has to survive the split.** It does, but not the way the
issue expected; see Decision 4.

**Wrong — "the wrapper would have to become a decorator over one child like
`QuotedElement`, or the engine would have to paginate the group itself." This is
a false fork, and it is the reason the issue reads as expensive.** CLAUDE.md's
hazard under `flowblock.ts` is a container with **its own pagination loop** —
"how a quote comes to break across a column under one rule and a list under
another". `placeElements` is not a second loop; it is the shared one, extracted
in `zch2.5` precisely so a caller can lay elements into ONE rect and get the
overflow back. A container that delegates to it is not the thing the rule
forbids. So the wrapper keeps its group and neither branch of the fork is taken.

**Not named, and it is most of the work already done.** `elementFloat.paintAt`
**already** goes through `placeElements`, which **already** returns a remainder.
It is impossible to observe today only because `paintAt` builds a rect exactly
as tall as its own `measure()`, so nothing is ever left over. Splitting is a
height budget on the way in and a continuation on the way out.

**Not named — the engine ignores what `paintAt` returns.** `flow.ts` pushes the
band from `floatPlan.height`, the pre-computed measure, and discards
`paintAt`'s return value. After a split the two differ, so the band must come
from the painted height instead. This is the one existing line that is silently
wrong under splitting.

**Not named — `flowplace.ts` must NOT split.** See Decision 3.

## Decisions

1. **Split only when the float cannot fit an EMPTY column.** A float that fits a
   column on its own still defers whole and leads the next one, exactly as
   `zch2.10` shipped. Splitting strictly replaces today's degrade-to-in-flow /
   throw path, so nothing that passes today moves. This is also what browsers do
   in paged media: push to the next fragmentainer if it fits there, fragment
   only if it cannot.

2. **One OPTIONAL member on `FloatContent`, and `FloatingBox` declines it.**
   `FloatingBox` is edited not at all, so CLAUDE.md's seam invariant survives
   literally — a *required* edit to it would still mean the seam is wrong. Its
   documented contract also stands: a box's border and background have no
   defined way to continue across a column, so an over-tall `AddFloatBox` keeps
   throwing. The invariant's wording moves from "FOUR members" to "four
   required, one optional that `FloatingBox` declines".

3. **`flowplace.ts` does not split, deliberately.** One rect has no next column.
   A split head would paint and the tail would land in a `remainder` that most
   callers of `page.AddHtml` never re-place — half a float drawn and the rest
   silently gone, which is strictly worse than today's degrade-to-in-flow, which
   draws everything. The module's own rule already reads "a float that does not
   fit is simply not floated"; this keeps it and asserts it, so the asymmetry
   reads as a decision rather than an omission.

4. **The band is re-established by a FRESH MEASURE of the tail, and that is
   correct.** The issue predicted the opposite — "the band has to be
   re-established there rather than recomputed from a fresh measure". It does not,
   because the tail is not the original float: it is genuinely new, shorter
   content, and its height at the top of the next column is exactly what
   `measure()` reports. The existing `pending` mechanism carries it and the
   ordinary float path places it. `floatstack.ts` does not change.

5. **The degrade still exists, and reporting it is `zch2.16`.** Content that
   cannot fragment at all — a lone image taller than the column — still lays out
   in flow. Splitting shrinks how often that fires; it does not remove it. The
   report needs a channel on the Flow or on `Render`'s return, because `AddHtml`
   hands `skipped` back before anything is placed, and that is its own design.

## The seam

`paintAt` is untouched. `FloatContent` gains a fifth member, optional:

```ts
/** Paint into a height budget and hand back what did not fit.
 *
 *  Only `elementFloat` implements it. `FloatingBox` declines it and never
 *  splits: its border and background have no defined way to continue across a
 *  column, so a split box reads as a fault.
 *
 *  `height` is what was actually painted. A `height` of 0 means NOTHING was
 *  painted and the call had no effect, which is what lets the engine fall
 *  through to the degrade path afterwards. A `tail` is present only when
 *  content is left over. */
splitPaint?(
  page: Page, x: number, topY: number, maxHeight: number,
  structParent?: StructElement,
): { height: number; tail?: FloatContent };
```

`elementFloat` implements it over the same `placeElements` call `paintAt`
already makes, with `[x, topY - maxHeight, width, maxHeight]` as the rect:

```ts
splitPaint(page, x, topY, maxHeight, structParent) {
  const { usedHeight, remainder } = placeElements(
    doc, page, elements, [x, topY - maxHeight, width, maxHeight],
    { paragraphSpacing: 0, structParent });
  return {
    height: usedHeight,
    tail: remainder.length === 0
      ? undefined
      : elementFloat(doc, remainder, width, spacing),
  };
}
```

`measure()`, `paintAt` and `splitPaint` all run the same arithmetic through
`placeElements`/`measureElements`, so the three cannot disagree about one float —
the property `zch2.10` already relies on for the first two.

## The engine

`flow.ts`'s float branch keeps its order and gains one step:

```
fits the column            -> floatPlan, paint whole            (unchanged)
not at column start        -> defer whole to `pending`          (unchanged)
at column start, too tall  -> TRY TO SPLIT                      (new)
                           -> degrade to flow / throw           (unchanged)
```

The split step, in the branch that today falls through to the throw:

- Budget is `boxTop - g.contentBottom` — the whole empty column.
- Call `splitPaint` on the page at the float's own `boxX`.
- Accept the split only when `height > 0` **and** a `tail` came back. Then push
  the band from the **returned** `height`, apply the existing pen rule
  (`floatPlan.top === floatPlan.natural`), and push
  `floatElement(tailElements, side, tail, 0, 0)` onto `pending`, which the
  existing `advanceColumn` already unshifts ahead of the next column's queue.
- `height === 0` means nothing was painted, so falling through to
  degrade-or-throw is side-effect-free.
- `height > 0` with no `tail` cannot normally happen here (the float measured
  taller than the budget), but is handled as an ordinary placement at the
  returned height rather than treated as an error — `measure()` and `place()`
  disagreeing is not a reason to lose the ink.

**Continuation spacing.** The tail carries `spaceBefore: 0` — it leads a column
and its leading gap was already spent — and `spaceAfter: 0`, which is what
`cssflow.ts` already passes. It carries no `clear`, per `FlowElement`'s existing
rule that continuations never do.

**Termination.** A tail is accepted only when `height > 0`, so every split
consumes drawn content and the tail is strictly shorter than what produced it.
The unsplittable case exits through `height === 0` to the degrade, which
terminates because it is ordinary placement. Both exits are asserted.

## Testing

**There is no oracle.** `test/fixtures/css-box/` measures used widths and
collapsed gaps and nothing positional; CLAUDE.md already records that placement
is not observable through `getComputedStyle` at all. So this is hand-built cases
plus a mutation sweep, as `zch2.10` was, and every rule above names the mutation
that reddens it.

Fixtures that discriminate, and why the obvious ones do not:

- **Splits an over-tall float.** Both halves present, in different columns. A
  fixture whose float merely *fits* measures nothing — it defers, which is
  today's behaviour and passes with `splitPaint` never called.
- **Text wraps beside BOTH halves.** The band in the second column is the half
  a lost-band bug leaves plausible: the head still paints, the tail still
  paints, and only the text beside the tail moves.
- **The band comes from the painted height.** Asserted against a float whose
  split head is SHORTER than the budget — with content that breaks above the
  column bottom, `floatPlan.height` and the painted height differ, and a build
  reading the stale one narrows the channel too far. A float that fills its
  budget exactly cannot see this.
- **Unsplittable content degrades unchanged.** A lone over-tall image: lays out
  in flow, no half-painted float.
- **`FloatingBox` still throws.** `AddFloatBox` with an over-tall box.
- **`flowplace.ts` never splits.** `page.AddHtml` with an over-tall float
  degrades to in-flow and draws everything.
- **Terminates.** A float several columns tall renders and the render returns.

`test/flowfloat.test.ts`, `test/flowplace-floats.test.ts`, `test/css-float.test.ts`
and `test/flow-float-content.test.ts` are the existing fences. New cases join
them; no case already in them should change, since Decision 1 moves nothing that
passes today.

## Files

| File | Change |
|---|---|
| `src/flowelement.ts` | `FloatContent` gains optional `splitPaint` |
| `src/flowfloat.ts` | `elementFloat` implements it; header invariant rewritten |
| `src/flow.ts` | the split step in Render's float branch; band from the painted height |
| `CLAUDE.md` | the `FloatContent` member-count invariant and `flowfloat.ts`'s "never paginates" note |
| `CHANGELOG.md` | Added entry |

Unchanged: `floatstack.ts`, `floatbox.ts`, `flowplace.ts`, `cssflow.ts`,
`cssframe.ts`.

## Out of scope

- Reporting the surviving degrade — `zch2.16`.
- Splitting a `FloatingBox` (Decision 2).
- Splitting in `flowplace.ts` (Decision 3).
- Widow/orphan control at the split point. The engine has none anywhere, and
  inventing it for floats alone would be one rule for one construct.

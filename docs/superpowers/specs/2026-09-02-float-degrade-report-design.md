# Content too tall for a column: stop throwing, and report — design

**Issue:** `zch2.16`. Filed as "an over-tall CSS float degrades to in-flow
silently". **That premise is wrong**, and probing it is what produced this spec.

**Goal:** an element taller than an empty column renders — scaled if it is an
image, overflowing if it is not — instead of refusing the document, and every
such compromise is reported.

## What the probe found, and why the issue had to be rewritten

**The float does not degrade silently. It throws.** Every shape built to reach
the degrade path ends in
`Flow: element does not fit in an empty column (column too short for its
content)` (flow.ts:1570), which refuses the whole document. The degrade is not
silent because it is barely reachable: the float degrades, and then the in-flow
placement of the same over-tall content kills the render.

**And it cannot be recovered by reflow.** A float is NARROWER than the column,
so degrading it to full width makes an image TALLER, never shorter. The
original issue's mental model — "it lays out in flow, we just don't say so" —
does not describe anything that happens.

**The real defect has nothing to do with floats.** `ImageElement.resolveSize`
(flow.ts:1032) clamps an image's WIDTH to the region and never its HEIGHT, so a
portrait image scaled to the column width exceeds the column height and the
document is refused. Measured, on a default A4 flow (column 451 x 698 pt,
aspect 1.548) with a bare `<img>` and a `data:` URI:

| image | result |
|---|---|
| landscape 16:9, square 1:1, portrait 3:4, portrait 2:3 | renders |
| **portrait 9:16 (1.78)** | **throws** |
| **portrait 1:2 (2.00)** | **throws** |

9:16 is a phone photo held upright. One `<img>` tag is enough — no float, no
CSS, no file. This is the `zch2.13` defect class exactly: an error naming page
geometry when the cause is content the engine declined to fit.

**`page.AddHtml` does not throw, and is not silent either.** It returns the
element in `remainder` and draws nothing. Discoverable, but a caller who ignores
`remainder` loses the image, and `skipped` says nothing.

## Decisions

1. **Images SCALE to fit; everything else OVERFLOWS. Both are reported.**
   Losing content is not on the table (`zch2.7`'s rule), and refusing the
   document is the worst outcome of the three. Scaling is right for an image
   because it has an aspect ratio and no other meaning; it is meaningless for a
   line of 900pt text, which therefore draws at its natural size and bleeds past
   the bottom margin rather than vanishing.

2. **The shrink is an OPTIONAL protocol member, asked only as a last resort.**

   ```ts
   /** Fit into `availHeight`, or `undefined` when this element cannot be
    *  scaled. The engine asks ONLY at a column start, where `availHeight` is
    *  the whole column and the alternative is refusing the document. */
   shrinkToFit?(width: number, availHeight: number): FlowElement | undefined;
   ```

   It must NOT be consulted during ordinary placement. A tall image near the
   foot of a column has to move to the next column, not shrink to the gap it
   happens to find — and that is the difference between a correct document and
   one whose pictures change size depending on what precedes them. The engine
   already distinguishes the two: `atColumnStart` is exactly the guard.

3. **`ImageElement` implements it by clamping HEIGHT, the sibling of the width
   clamp it already has.** `resolveSize` clamps `baseW > regionWidth` with the
   aspect preserved; the new rule clamps `drawH > availHeight` the same way.
   That the two live together is the point — one function answers "how big is
   this drawn", and a second site would let them disagree.

4. **Everything else places with `availHeight: Infinity`.** The element draws at
   its natural size and the pen moves past the column bottom; the next element
   then sees no room and advances the column normally. Only UNSPLITTABLE content
   ever reaches here — a paragraph splits, a table splits, a float splits since
   `zch2.15` — so the overflow is one element, never a cascade.

5. **`flowplace.ts` shrinks at the equivalent point and never overflows.** Its
   analogue of "an empty column" is "nothing placed into this rect yet", and its
   `remainder` contract is a real answer that `Render` does not have, so an
   element that still will not fit is returned rather than drawn outside the
   caller's rect. A caller who gave us a rect meant it.

6. **The float report from the original issue survives, unchanged in shape.**
   `FloatContent.onDegraded?: () => void`, fired at both degrade points, mapped
   by `cssflow.ts` into `{ el, kind: 'degraded', construct: 'float', detail:
   side }`. It is worth keeping precisely because Decision 1 makes the degrade
   REACHABLE for the first time: with the throw gone, a float that cannot be
   floated now really does lay out in flow.

7. **One sink, `HtmlFlowOptions.onNotRendered`, for both halves.**
   `doc.AddHtml` and `page.AddHtml` install their own, collect into a local
   array, and return a FRESH `[...skipped, ...late]`. Nothing mutates under a
   caller: `flow.AddHtml`'s returned array is never appended to after the fact,
   and a Flow caller who wants placement-time reports passes the callback.

8. **The engine learns no HTML vocabulary.** It holds a `FlowElement` and a
   `FloatContent`, never an `HtmlElement`, and `NotRendered.el` is an
   `HtmlElement` — so `flow.ts` provably cannot build one of these records. Both
   channels are bare callbacks; `cssflow.ts` closes over the element.

9. **The engine may fire a callback MORE THAN ONCE for one element**, and the
   de-duplication lives where the record is made. After a float degrades it
   places like any other element, and a retry in the next column re-enters the
   float branch; the same is true of the region retries in `placeElements`. One
   box is one record, so `cssflow.ts`'s closure carries a `reported` flag. The
   engine must not have to know.

10. **`'float'` and `'image'` are reused; `'overflow'` is ADDED.** A scaled
    image reports `{ construct: 'image', kind: 'degraded', detail:
    'scaled-to-fit' }` — `'image'` already exists and already means "this
    picture did not render as specified". An overflowing element gets a NEW
    construct, `'overflow'`, and `CONSTRUCTS`'s asserted size moves from 20 to
    21 deliberately (it is 20 today — `test/htmlreport.test.ts` asserts it).

    **The alternative was reusing `'text'`, and it would make the report lie.**
    That name is documented as *text the resolved face cannot draw* — a missing
    glyph — and `svgdraw.ts` uses it for the same failure, so the library states
    one rule across both importers. A block that overflows its column drew every
    character perfectly; filing it under `'text'` would send a caller looking
    for a font problem. Widening a closed vocabulary is cheap and visible (the
    size assertion is a red build until updated); overloading a name is neither.

11. **The scale and the overflow report through `FlowElement.onCompromise`.**

    ```ts
    /** The engine had to compromise to place this at all: 'scaled' when it was
     *  shrunk to fit, 'overflow' when it was drawn past the column bottom. */
    onCompromise?: (how: 'scaled' | 'overflow') => void;
    ```

    Needed because NEITHER side can see these alone: the engine holds no
    `HtmlElement` (Decision 8), and `cssflow.ts` knows the container WIDTH but
    never the column HEIGHT, so it cannot predict either at build time.
    `cssflow.ts` assigns it in `mapBox`, where it already has the element, over
    everything the box produced.

    It is the ONE non-`readonly` member of `FlowElement`, deliberately: the
    builders (`paragraph`, `image`, `table`, …) are shared with Markdown and
    hand-built flows and must not grow an HTML-shaped option, so the assignment
    happens after construction. The engine fires it on the ORIGINAL element
    before swapping in a shrunk replacement, so the replacement need not carry
    it.

12. **The shrink is accepted only when the replacement actually FITS**, which
    is the termination proof. A `shrinkToFit` that returned something still too
    tall would be asked again at the same column start, forever — the same
    shape as `zch2.15`'s "a tail is accepted only when something was painted".
    The engine re-`measure`s the replacement and falls through to overflow if
    it does not fit.

## The two report shapes, and the one that already exists

`cssflow.ts` ALREADY emits `{ el: r.box.el, kind: 'degraded', construct:
'float', detail: side }` at cssflow.ts:419, for `zch2.10`'s two-same-side-floats
case. The float record here is byte-identical to it rather than a new shape.

**The cost, recorded rather than fixed:** a caller cannot tell the two float
reasons apart — both read `float:left`. Distinguishing them needs either a
second `Construct` (widening a closed vocabulary whose size is asserted) or a
structured `detail` (a plain string everywhere else). Both are worse than the
ambiguity for a caller whose realistic question is "did my floats lay out as
floats". Do not widen `Construct` without a caller asking.

## Testing

**There is no oracle.** Placement is not observable through `getComputedStyle`,
so `test/fixtures/css-box/` sees none of this. Hand-built cases plus a mutation
sweep, as `zch2.10` and `zch2.15` were.

Fixtures that discriminate, and the traps found while probing:

- **A bare 9:16 `<img>` renders instead of throwing.** The aspect ratio is the
  whole fixture: at 3:4 or 2:3 the image fits a default column and the case
  passes with the feature absent. Build it with `buildPngRgbWith(9, 16, …)`.
- **It is SCALED, not clipped**: its drawn height equals the column height and
  its width shrank proportionally. Asserting only "did not throw" passes for a
  build that drops the image entirely.
- **A tall image near a column FOOT moves to the next column and keeps its
  size.** This is the pin on Decision 2, and the case that a naive
  `shrinkToFit` at every `place()` breaks — without it, the shrink looks correct
  in every single-element document.
- **A 900pt-font paragraph overflows rather than throwing or vanishing**, and is
  reported. It cannot be scaled, so it is the only fixture that reaches
  Decision 4.
- **`page.AddHtml` scales the same image and returns an EMPTY remainder**, where
  today it returns the element and draws nothing.
- **The float degrade is now reachable**: a float whose content cannot fragment
  lays out in flow and reports `float`. Before this issue no such fixture could
  exist, because it threw.
- **One record per box** even when the element is retried across columns
  (Decision 9), and **`flow.AddHtml`'s `skipped` has the same length before and
  after `Render()`** (Decision 7).

## Files

| File | Change |
|---|---|
| `src/flowelement.ts` | `FlowElement.shrinkToFit?` and `onCompromise?`; `FloatContent.onDegraded?` |
| `src/flow.ts` | `ImageElement.resolveSize` height clamp + `shrinkToFit`; the throw site becomes shrink-then-overflow; fire `onDegraded` |
| `src/flowplace.ts` | shrink at the rect top; fire `onDegraded` |
| `src/flowfloat.ts` | `elementFloat` takes and stores `onDegraded` |
| `src/cssflow.ts` | `onNotRendered`; widen `makeFloat`; the closures and the `reported` flag |
| `src/htmlflow.ts` | `HtmlFlowOptions.onNotRendered`; pass through |
| `src/document.ts`, `src/page.ts` | collect late records, return a fresh array |
| `src/htmlreport.ts` | the `'overflow'` construct (`CONSTRUCTS` 20 -> 21) |
| `CLAUDE.md`, `CHANGELOG.md` | the invariants and a user-visible entry |

Unchanged: `floatstack.ts`, `floatbox.ts` (`FloatingBox` is edited not at all,
for the fourth issue running). `htmlreport.ts` gains ONE line: the `'overflow'`
construct, per Decision 10, which moves the asserted `CONSTRUCTS` size from 20
to 21.

## Out of scope

- **Paginating an over-tall element across columns.** Slicing an image or a line
  of text is a different feature; overflow is the honest degrade until someone
  asks.
- **A general placement-time event channel.** Two callbacks for two known cases;
  a general channel with no third caller is the shape this repo keeps rejecting.
- **Scaling anything but an image.** `shrinkToFit` is optional and only
  `ImageElement` implements it.

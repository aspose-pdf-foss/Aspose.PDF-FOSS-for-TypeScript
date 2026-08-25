# Per-line leading

Design for `aspose-pdf-foss-for-ts-g61q`, filed during `gl6o.3.1` (rich inline
runs) as a recorded limitation and inherited by `gl6o.3.2` and `gl6o.3.3`.

## Problem

Leading is block-level: every line of a wrapped block advances by the same
`leading`, whatever it contains. A run whose `fontSize` exceeds the block's
therefore draws glyphs taller than the band it was given, and they overrun the
line above.

Measured — a 24pt run inside a 10pt block with 12pt leading, in a 250pt box:

```
baseline=690.0  top=700.0  size=10  "ordinary body text that wraps onto a sec…"
baseline=678.0  top=688.0  size=10  "there is something above "
baseline=678.0  top=702.0  size=24  "HUGE "          <- overlaps the line above
baseline=666.0  top=676.0  size=10  "ordinary text continues after it…"
```

The 24pt fragment reaches **top = 702**, which is above the previous line's
*top* (700) and 12pt above its baseline (690). It does not merely crowd the line
above; it covers it.

Three facts the measurement settles, each of which narrows the work:

1. **Block level is already correct.** A 24pt list *item* among 11pt items lands
   at baseline 732.8 with top 756.8, clear of the 759 baseline above — each item
   is its own element, and the engine spaces elements by `usedHeight`, which
   follows that element's own leading. Only a run *inside* a block is affected.
2. **Markdown cannot reach it.** Inline code scales *down* (`code.sizeRatio`),
   and headings are their own blocks. The defect is reachable only through the
   public `TextRun.fontSize` API.
3. **No existing fixture is affected.** `resolveItemOptions` turns a per-item
   `fontSize` into that item's *block* size rather than a run inside a smaller
   block, so `rich-runs-identity`'s `flow-list-styled-items` — the only case with
   a `fontSize` override — has no oversized run.

## Scope

In scope: a line's height becomes a function of its own runs, and every
consumer of the block height model follows.

Out of scope, each for a stated reason:

- **Per-run vertical alignment.** A tall run sits on the shared baseline, as it
  does now. Superscript/subscript positioning is a separate feature.
- **Font-metric line heights.** Deriving each line's height from `vmetricsFor`'s
  ascent and descent is typographically finer, but it discards the caller's
  chosen leading ratio and would change the height of lines that have no defect.
- **Block-level leading versus block font size.** Measured as already correct;
  nothing to fix.
- **Shaped text.** `layoutText`'s shaped path takes one run at the block size,
  so the `max` collapses and its behaviour is unchanged.

## Architecture

```
layout.ts        LaidLine.height, .maxFontSize   computed while wrapping
                 layoutRuns(…, leading, fontSize)  gains the ratio denominator
                 the fitting loop                cumulative, not lines x leading
stamp.ts         firstBaseline                   block height = sum of heights
                 buildRunBlockBody               per-line Td delta
                 segmentBoxes, blockLineBoxes    per-line baselines
                 flowTextBlock, measureTextBlock usedHeight = sum of heights
tableauthor.ts   measure()                       row height from summed heights
```

### The rule

```
lineHeight = max(blockLeading, maxRunFontSize x blockLeading / blockFontSize)
```

It respects whatever density the caller chose — a double-spaced block stays
double-spaced around its big run — and it is **byte-identical by construction**
for every line whose runs sit at or below the block size, because the `max`
collapses to `blockLeading`. That is every line every existing caller produces,
which is why this needs no opt-in flag.

`layoutText` already receives `fontSize`, so it computes heights with no
signature change. Only `layoutRuns` gains a parameter, and all three of its call
sites — `stamp.ts` twice, `tableauthor.ts` once — already hold the block size.

### Baselines

The current model is `baseline₀ = blockTop − fontSize`, then `−leading` per
line. Generalised, each line occupies a band of its own height and its baseline
sits `maxFontSize` below that band's top:

```
baselineᵢ = blockTop − Σⱼ<ᵢ heightⱼ − maxFontSizeᵢ
```

which reduces exactly to the current formula when `heightⱼ = leading` and
`maxFontSizeᵢ = fontSize`.

Using `maxFontSize` rather than the block's `fontSize` also fixes the **first**
line, where an oversized run currently overflows the block's top edge — the
measured case put glyphs 2pt above the previous line's top, and on line 0 they
would leave the box entirely.

### What does not change

Nothing above `usedHeight`. The flow engine, `flowplace.ts`, `flowtable.ts` and
`flowblock.ts` all consume it and never recompute it, so pagination,
keep-with-next and the column budget follow automatically. `wrapLines` reports
widths only. `floatbox.ts` measures through `layoutText` with one run.

## Invariants

To be recorded in `CLAUDE.md`, replacing the existing note that leading is
block-level:

- **A line's height is `max(blockLeading, maxRunSize × blockLeading /
  blockFontSize)`.** The `max` is what makes every uniform block
  byte-identical — the property, not a hash, is the fence.
- **A line's baseline sits `maxFontSize` below its band top**, not `fontSize`.
  Using the block size lets an oversized run on line 0 escape the box.
- **`usedHeight` is the sum of the line heights**, and it is computed in one
  place per consumer. The flow engine reads it and never re-derives it, which is
  why pagination needed no change.
- **`layoutRuns` computes the heights, not its callers.** It is the function
  that decides which lines fit the budget, so a caller computing heights
  afterwards would disagree with the wrapping about what fitted.

## Error handling

Nothing new. `fontSize` is validated positive at every entry point, so the ratio
is always finite; `leading` is validated non-negative. A `leading` of 0 with an
oversized run yields `max(0, size × 0) = 0`, preserving today's behaviour for a
caller who deliberately asked for zero leading.

## Testing

The arithmetic is pure, so the core is driven through `layoutRuns` directly with
no `Document` — the rule `floatstack.ts` and `booklet.ts` follow.

`test/line-height.test.ts`:

- a line whose runs are all at the block size gets `height === leading`, stated
  directly rather than inferred from a hash
- a line containing a larger run gets `maxRunSize × leading / fontSize`
- a line containing a *smaller* run still gets `leading` — the floor
- a double-spaced block keeps its ratio around its big run
- fewer lines fit a fixed height budget once one of them is tall

Rendered:

- **The measured collision, asserted as measured:** the 24pt fragment's top must
  sit at or below the previous line's baseline (702 against 690 today), and an
  oversized run on line 0 must stay inside the block's top edge.
- **`usedHeight` grows** for a block with an oversized run, through
  `measureTextBlock`.
- **Pagination follows:** the same block in a short column takes fewer lines.
- **A table cell's row height** accounts for an oversized run.
- **All 14 `rich-runs-identity` hashes and `table-slice-identity` unchanged** —
  the fence for the whole change, and the thing that proves the `max` collapses
  as claimed.

## Public surface

None. `LaidLine` is `@internal`, and `layoutRuns` is internal to the authoring
layer. The change is visible only as correct spacing around a run that is larger
than its block.

`README.md`'s Markdown limitation sentence — "Leading is per block, not per
line, so a run whose `fontSize` exceeds the block's can collide with the line
above it" — is removed.

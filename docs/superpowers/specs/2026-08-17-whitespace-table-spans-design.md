# Spanning cells in the whitespace table detector

Design for `aspose-pdf-foss-for-ts-c3t7.5`, under the `Extraction fidelity`
epic (`c3t7`). It gives the borderless/whitespace table detector the one thing
the ruled detector has and it lacks: `colSpan`.

## Problem

`extractTables` runs two detectors. The ruled one reads ruling lines and emits
spans; the whitespace one reads text geometry and emits a flat grid, always.
Measured, on a page holding a header over two columns:

```
| Quarterly results |  |
| Q1 | Q2 |
| 10 | 20 |
```

The header's text lands in column 0 and column 1 is left empty, where it should
be one cell with `colSpan 2`.

**Two things already exist and shorten this considerably.** `buildCells` grows
`colSpan` from a separator-absence matrix, and `detectWhitespaceTable` already
calls it — with all separators present, which is exactly why every cell is 1x1.
And fragment-to-cell assignment is centroid containment against the cell quad,
so a wider quad simply claims the fragment. Neither the model nor the cell
builder needs anything: **`TableCell.colSpan` is already read by all five
consumers** (`toHtml`, `toMarkdown`, `docxtable`'s `w:gridSpan` and width
summing, `autotag`'s `ColSpan` attribute). This work adds no public surface.

The whole difficulty is deciding *which* cells span.

## The approach that does not work, recorded because it was the obvious one

The issue originally proposed inferring a span from a cell's text *overhanging
the column cuts either side of it*. It cannot be done that way, and the
measurement is worth keeping:

```
FRAG "Quarterly results" x=20.0..93.4
FRAG "Q1" x=20.0..33.3     FRAG "Q2" x=120.0..133.3
resulting cut: x=108        column 0: 19..108
```

`columnCuts` accepts only a gap column covered by **no** row, so the spanning
header pushes the gap start from 33.3 out to 93.4 and the cut lands at 108. The
header therefore sits *entirely inside* column 0 and straddles nothing — it is
even **narrower** than its own column. The signal is structurally absent, and a
width-ratio test against the cell's own column has the sign backwards.

That is the circularity at the heart of this feature: **the cuts are distorted
by the very rows we are trying to detect.**

## Approach

Break the circularity by deriving a second, undistorted set of cuts from the
rows that are *not* candidates, and use those purely as a yardstick.

Two alternatives were considered and rejected:

- **Iterative refinement to a fixed point** — compute cuts from all rows, treat
  a row whose removal materially widens a gap as a candidate, recompute without
  candidates, repeat. Strictly more general: it handles a table where *most*
  rows span, which this design cannot. Rejected as the default because it is a
  fixed-point loop over a heuristic in the page-extraction path — harder to
  bound, and much harder to explain when it gets a page wrong. If the modal rule
  proves too narrow against real documents, this is the upgrade, and it can
  replace `referenceRows` without touching anything else.
- **Width ratio against today's cuts** — simplest, no reference machinery, and
  measurably wrong for the reason above.

## Scope

In scope:

- `src/tablegrid.ts`, `src/tablestream.ts` (both new; an extraction plus the
  feature).
- `src/table.ts` — loses the whitespace half and the shared grid helpers.
- `README.md`, `CLAUDE.md`.

Out of scope, each for a stated reason:

- **`rowSpan`.** In the whitespace path rows come from baselines, so a cell
  occupying two row bands is indistinguishable from ordinary wrapped text —
  which is the common case, not the exception. Guessing there merges two real
  rows.
- **Multiple spans in one row.** Each additional span in a row is another
  chance to merge cells that were merely close together, and the rule below
  leans on "exactly one fragment" to know the spanned columns are empty.
- **Nested whitespace tables.** Independent of spans, and it is not settled that
  nesting is even desirable — the flattened grid is not wrong, only flatter than
  the source. Stays in `c3t7.5`'s successor if wanted.
- **Any change to detection.** See the invariant below.

## Module extraction

Done first, as its own commit, with no behaviour change.

| Module | Holds |
|---|---|
| `tablegrid.ts` (~50 lines) | `buildCells`, plus the helpers both detectors share: `centroid`, `contains`, `rowBbox`, `cellText`, `mat` |
| `tablestream.ts` (~200 lines) | `median`, `largestGap`, `groupLines`, `columnCuts`, `candidateSplits`, `segmentBlocks`, `detectWhitespaceTable`, and the new span pass |
| `table.ts` (~400 lines after) | Ruled detection, rotation, rule partitioning, ink decoration, `extractTables` |

**Invariant:** `tablegrid.ts` is a leaf. Both detectors import it, so it imports
neither. That is what avoids the cycle which would otherwise force
`tablestream.ts` to take `buildCells` as an argument the way `docxtable.ts`
takes its paragraph builder.

`buildCells` is currently `export`ed from `table.ts` and has **no importer
outside it**, so the move is free.

**Invariant:** the name is `tablestream.ts` because "stream table" is the term
for this class of detector. It must not be confused with `tablestruct.ts`
(tagged-tree extraction) or `tableink.ts` (border recovery), and it imports
neither.

Two existing invariants are easy to lose in a move and must survive it:

- `segmentBlocks` accepts a split only when it yields **>= 2 valid tables**, so
  a single sparse table is not halved on an inter-column gap.
- `detectWhitespaceTable`'s prose guard rejects a candidate unless every column
  carries text in at least `ceil(R / 2)` rows. The move is the moment to give
  that inline expression a named constant, since the span rule has to reason
  about it.

## The span rule

**Reference rows.** Count fragments per line; take the modal count `M`, ties
resolving to the **higher** count, since more fragments reveal more boundaries.
Reference rows are the lines holding exactly `M` fragments.

**Decline unless there is evidence:** `M >= 2` and at least **two** reference
rows. Otherwise there is no majority structure to trust and the answer is "no
spans" — today's output.

**Reference cuts** are `columnCuts` run over the reference rows alone. On the
canonical fixture the body rows give a gap of 33.3..120 and a cut at **76.7**,
against the all-rows cut of 108.

**Invariant:** the final grid stays the **all-rows** cuts, unchanged. Detection,
the prose guard, cell quads and text assignment are all byte-for-byte what they
are today; reference cuts are a yardstick and nothing else. This is
`decorateInk`'s rule — *runs after detection and changes nothing the detector
decided* — and it is what makes the feature incapable of regressing the most
heavily tested geometry in the file.

**Invariant:** the two cut systems are connected by **index, never by position**.
Require that both describe the same number of columns; decline spans entirely if
they do not. They normally agree, because a spanning header moves a boundary
rather than inventing a column, and when they agree, reference-cut index `i` *is*
final-interior index `i`. A positional mapping with a tolerance would be
guesswork on top of a heuristic — and here the two cuts differ by 31pt, so no
honest tolerance would join them.

**A row carries a span when all of:**

1. it is not a reference row (fragment count `!= M`);
2. it holds exactly **one** fragment — which is also what makes "the spanned
   columns are empty in this row" true by construction rather than by a check;
3. that fragment straddles a reference cut with enough overhang. Stated as a
   predicate, so it cannot be read two ways — for reference cut `refCuts[i]` and
   the fragment's quad `[x0, _, x1, _]`:

   ```
   x0 < cut  &&  x1 > cut + SPAN_OVERHANG * (refCuts[i + 1] - cut)
   ```

   The column width is the **reference** grid's following column, not the final
   grid's: the cut being cleared is a reference cut, so the span it must clear is
   measured in the same frame. On the canonical fixture that is
   `134.3 - 76.65 = 57.65`, and the header's `93.4` clears the cut by `16.75`,
   or 29%.

A straddle sets `vSep[r][i] = false` and `buildCells` grows the span.

### The precision argument

**Invariant:** condition 3 is the whole feature. Cardinality cannot be the
signal — measured, a sparse row holds a single fragment (`Bolt` in a two-column
table) and under a cardinality rule would merge with the empty cell beside it,
making `toMarkdown` print `Bolt | Bolt`, which invents data.

The failure mode is stated rather than hidden: **a long wrapped cell in column 0
is geometrically indistinguishable from a spanning header** — both are one wide
fragment on a row with fewer fragments than its neighbours. Excluding such a row
from the cuts widens the gap and moves the midpoint *toward* the wide text,
which is precisely how a false span would arise. The overhang margin is what
separates them:

| Case | Clears the cut by | Of a reference column of | Ratio |
|---|---|---|---|
| Canonical spanning header (ends 93.4) | 16.75pt | 57.65pt | 29% |
| Wrapped cell ending just past the midpoint (~80) | ~3.4pt | 57.65pt | ~6% |

**The error asymmetry is why the rule leans conservative, and it is not
symmetric at all.** A false span *destroys structure*: a column's data vanishes
from that row in HTML and DOCX, `toMarkdown` repeats the text across the spanned
columns, and `AutoTag` writes a `ColSpan` a screen reader announces. A missed
span is today's shipped output — flat, but truthful.

**Thresholds are starting points to tune against fixtures, not derived
figures:** `SPAN_OVERHANG` starts at 0.2. Both it and the prose guard's fraction
are named constants so the plan can move them without hunting literals.

Verified by hand against both probes taken while designing: the spanning header
gets `colSpan 2`, and the sparse `Bolt`/`Nut` rows get nothing — their modal
count ties at 2 and resolves to 2, the reference cuts land identically to
today's, and neither fragment reaches a cut.

## Wiring

```
cells0    = buildCells(xcuts, ycuts, allTrue, allTrue)   // unchanged
prose guard runs on cells0                                // unchanged
vSep      = spanSeparators(lines, xcuts, refCuts)         // all-true unless spans
finalGrid = vSep ? buildCells(xcuts, ycuts, vSep, allTrue) : cells0
cells     = finalGrid.map(assign text)                    // unchanged mechanism
```

No public API change: `TableCell.colSpan` exists, and every consumer already
reads it.

## Testing

`test/tablestream.test.ts` (new), pure, driven from hand-built `TextFragment`s
the way `test/docinfer.test.ts` and `test/docx-group.test.ts` are — which is
also the point of the extraction, since the whitespace detector has never had a
test file and was observable only through `GetTables` on a built PDF. That is
exactly how this issue's original premise came to be wrong.

- the modal count, including the **tie** resolving to the higher value;
- reference cuts differing from all-rows cuts — 76.7 against 108, asserted as
  numbers;
- the overhang margin at its boundary: just-over spans, just-under does not.
  The discriminating pair, as the centroid pair was for region scoping;
- the sparse row getting **no** span;
- each decline path: `M < 2`, fewer than two reference rows, cut-count mismatch.

End-to-end through `GetTables`: the canonical header returns `colSpan 2`, and
`toMarkdown` renders it spanned.

Every rule and both thresholds are proven load-bearing by breaking them
individually and confirming red, per this repository's standing rule. Three
traps recorded, since two of them already bit this issue:

- A **uniform** fixture cannot test spans at all — every row is a reference row,
  so there are no candidates and the pass is a no-op whatever it does.
- `expect(colSpan).toBe(2)` on the canonical case **also passes if everything
  spans**. It needs a companion assertion that the body rows are still 1x1, or
  the test is satisfied by the worst available bug.
- Existing table fixtures holding a wide row may legitimately change output in
  the span commit. Each diff is read before it is accepted — these are fences,
  not goldens.

## Documentation

`README.md`: the table paragraph currently states that the whitespace path
"reports no **spans**" — corrected earlier the same day and now false again. It
gains the rule, the conservative posture, and the wrapped-cell failure mode.
`rowSpan` remains stated as absent.

`CLAUDE.md`: entries for `tablestream.ts` and `tablegrid.ts` with the invariants
above — the leaf rule, index-not-position, detection untouched, and why
cardinality cannot be the signal.

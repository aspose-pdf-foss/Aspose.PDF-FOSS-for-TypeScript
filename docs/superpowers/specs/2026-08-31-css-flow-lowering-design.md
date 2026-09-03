# Lowering the styled box tree to FlowElement[] — design

Issue: `zch2.4`, under epic `zch2` (HTML to PDF conversion, `gap-vs-java`).
Date: 2026-08-31.

`zch2.3` closed with a box tree and the arithmetic to resolve it against a
containing-block width: `buildBoxes` produces `BoxNode[]`, `resolveBoxes`
produces used widths, insets, margins and a minimum height, and
`collapseMargins` produces the gap before each box. It positions nothing —
no x, no y, no line break, no page break.

This is the issue that spends that. It maps each `BoxNode` to a
`FlowElement`, and `flow.ts` then stacks and paginates exactly as it already
does for Markdown.

Every number below is measured against the code, not read off the spec or off
the predecessor's design. That practice caught a wrong claim in this one's
immediate predecessor, recorded in the next section.

## The decision that shapes everything: it is a mapper, not an engine

The issue text is the specification:

> Mirror `mdflow.ts` exactly: know nothing about columns, rects or
> pagination, and hand back a flat array. That is what makes three entry
> points one implementation, and it is what lets the existing pagination,
> keep-with-next and column budget work unchanged.

```
zch2.2.3   Map<HtmlElement, ComputedStyle>          43 longhands, CSS px
    ↓
zch2.3     BoxNode tree                             structure, no geometry
           resolveBoxes(boxes, width) → ResolvedBox[]
           collapseMargins(resolved)  → number[]
    ↓
zch2.4     BoxNode[] → FlowElement[]                THIS ISSUE
    ↓
flow.ts    stacks, paginates, floats, keep-with-next
flowplace.ts  the same elements into one rect
```

Two consumers take the array — Flow's column engine and `flowplace.ts`'s rect
placer — which is what makes `zch2.5`'s three entry points cost one
implementation. `mdflow.ts` already proves the shape.

## A correction to `zch2.3`'s design, measured

`2026-08-28-css-box-model-design.md` states, twice:

> `flow.ts` supplies that at `place()` time, so `resolveBoxes` is called
> there.

> `zch2.4` maps each `BoxNode` to a `FlowElement`, calls `resolveBoxes` at
> `place()` time with the width Flow hands it, and assigns the collapsed gaps
> to `spaceBefore`.

**Those two halves contradict each other, and the first is wrong.** Three
call sites read `spaceBefore` *before* `place()` ever runs:

- `flowplace.ts:63` — `const gap = started ? pendingAfter + ps + (el.spaceBefore ?? 0) : 0;`
- `flow.ts:1298` — the same expression in the column engine.
- `flow.ts:1330` — keep-with-next reads the *next* element's `spaceBefore`
  while deciding whether a heading and its follower fit together.

A gap computed inside `place()` can therefore never reach the engine. Since
the whole premise is *put the entire gap in `spaceBefore` and change nothing
in Flow*, resolution has to happen at **build** time, against a width the
caller supplies — which is exactly why `resolveBoxes` takes a width as an
argument rather than baking one in. Every entry point has one: a Flow knows
its column width from `normalizeFlowOptions`, and `page.AddHtml` is given a
rect.

The consequence is worth stating plainly, because it is the one thing this
design gives up: a percentage margin resolves against the width the caller
supplies, so an element placed into a column narrower or wider than that
width keeps the margin it was built for. No entry point in `zch2.5` produces
that mismatch — each resolves against the width it will place into.

## Scope

**In:**

- The mapping: block boxes, inline-content boxes, headings, lists.
- The `BoxElement` decorator — background, four borders, and the insets a
  nested box accumulates.
- Margin collapsing spent as `spaceBefore`, with `paragraphSpacing: 0` and
  every `spaceAfter` zero.
- Height as a minimum.
- CSS px → points, at one boundary.
- `clear`, which passes through to `FlowElement.clear` for nothing.
- `skipped` and `unsupported` reporting, mirroring `MarkdownResult`.

**Out, and tracked:**

- **Tables** — `zch2.6`. A `TableBox` names itself in `skipped`.
- **Images** — `zch2.6`. An `AtomicInline` names its `src` in `skipped`.
- **Float placement** — a floated box is laid out in flow and named in
  `skipped`. Tracked as `zch2.10`.
- **Inline geometry** — `inline-block`, `vertical-align`, inline padding.
  `zch2.3` declared these out and nothing here reopens them.
- **Public API** — nothing is exported from `index.ts`, so there is no
  `CHANGELOG.md` entry. `zch2.5` is the entry point and the next consumer.
  `zch2.2.1`, `zch2.2.2`, `zch2.2.3` and `zch2.3` all set this precedent.

## The two modules

Mirroring the `mdflow.ts` / `flowblock.ts` split, and for the same reasons.

**`cssflow.ts`** — the mapper. Walks `BoxNode[]`, calls `resolveBoxes` and
`collapseMargins`, and builds `FlowElement[]` through the existing builders.
It owns the `ComputedStyle` → Flow-options translation and the unit
conversion. It knows about columns, rects and pagination not at all.

**`cssframe.ts`** — the `BoxElement` decorator. Its own module for two
reasons: it *paints*, so it imports `pagecontent.js` and `serialize.js` and
cannot be a pure leaf the way the four `zch2.3` modules are; and keeping it
separate is what lets every framing rule be driven from a hand-built inner
element rather than from a parsed document. `flowblock.ts`'s `QuotedElement`
is the same shape for the same reason.

Neither imports the other's consumer: `cssflow.ts` imports `cssframe.ts`, and
`cssframe.ts` imports the protocol from `flowelement.ts`, never `flow.ts` —
the split `flowblock.ts` already makes, so `flow.ts` importing a builder back
closes no cycle.

## Approaches considered

**A — flatten with nested decorators.** Walk the box tree depth-first. An
inline-content box becomes a `paragraph()` or `heading()`. On the way back
up, each ancestor block box wraps *every* element its subtree produced in a
`BoxElement` carrying that box's insets and ink. Nesting is the decorator
wrapping itself.

**B — one decorator per leaf holding a stack of frames.** Accumulate the
ancestor chain into a single wrapper painting several frames. Fewer objects,
but it invents a frame-stack concept where the repo already has a proven
wrapping one, and it puts the whole ancestor chain into one object's state.

**C — a composite element that holds and paginates its children.** Ruled out
by an existing invariant, recorded in `CLAUDE.md` under `flowblock.ts`:

> a container never holds and paginates its children. The engine is a flat
> queue, and a container with its own pagination loop is how a quote comes to
> break across a column under one rule and a list under another.

**Chosen: A.** It is the repo's idiom, nesting costs nothing, and a split box
needs no special case — each decorator paints its own frame wherever it
lands, which is exactly how a quote split across a column already works.

## The mapping

| Box | Becomes |
|---|---|
| inline-content block | `paragraph()`, or `heading(level, …)` when the element is `h1`..`h6` |
| block-content block | nothing of its own — its children flatten, each wrapped in this box's `BoxElement` |
| run of `list-item` siblings | one `list()` |
| `TableBox` | named in `skipped`; text still emitted |
| `AtomicInline` (image) | named in `skipped` |
| `float: left \| right` | laid out in flow, named in `skipped` |

### Headings go through `heading()`, not `paragraph()`

The level comes from the tag name, which is a DOM fact rather than a CSS one
— there is no computed property that says "this is a heading". The cascade's
font, size and colour are passed **explicitly**, so the builder's own
defaults (`Helvetica-Bold`, and `24/18/14/12/10/8` by level) are overridden
and never double-apply on top of the UA sheet's.

What that buys is precisely what `paragraph()` cannot give: `/H1`..`/H6`
structure types in a tagged flow, and `keepWithNextEligible`, so a heading is
not orphaned at the foot of a column. Both are silent losses — a document
with `/P` for every heading renders identically and exports wrongly.

### Lists go through `list()`

A run of consecutive `display: list-item` siblings becomes one `list()` call.
Ordered-ness reads from `listStyleType`, and an `<ol start>` from the
attribute. `FlowListItem.blocks` takes arbitrary `FlowElement`s placed at the
item's own indent, so a styled `<li>` still gets its `BoxElement` — the
builder needs no widening.

Markers, the auto indent, `/L` > `/LI` > `/LBody` tagging and nesting all
come free. The alternative — painting markers as decorator ink — re-derives
the marker glyphs, the ordinal counter and the indent that `list()` already
owns, which is a second definition of a list and exactly what `CLAUDE.md`'s
*one builder per construct* rule exists to prevent.

Detecting the run on `display: list-item` rather than on the `ul`/`ol` tag is
what makes `display: list-item` on an arbitrary element work, and it costs
nothing extra.

## Units: CSS px to points, at one boundary

`zch2.3` is CSS px throughout and Flow is points. `1px = 0.75pt` (a px is
1/96 in, a point 1/72). The multiply belongs here, and it must happen in
exactly one place or the two will drift.

The trap: `cssinline.ts` emits `TextRun.fontSize` **in px**, since it reads
`ComputedStyle.fontSize` directly. Every run's `fontSize` therefore needs
scaling as well as every inset, margin, gap and minimum height. Leaving that
out renders all text 33% too large, which reads as a deliberate style choice
rather than as a fault — nothing throws and nothing looks broken.

## Height as a minimum, and the shared holder

`ResolvedBox.minHeight` is a floor. A box whose content is taller **grows**;
it does not clip. `zch2.3` reports the number and cannot test the rule —
measured there, mutation 7 of its plan (treat `height` as exact) reddens
nothing in that suite — which is why the rule was recorded on this issue.

A box with three children has three decorators, so no single one knows what
the box has used. They share a **per-box holder**, accumulated as each
places; the last one pads by `max(0, minHeight − used)` and paints its frame
over the padded band. This is the third instance of a pattern the repo
already runs: a list item's marker holder, a split table's `TableTagger`, and
`QuoteStruct`'s shared `/BlockQuote`.

**A fixture for this must have content taller than the stated height.** A
clipping build and a growing build agree on everything shorter, so a fixture
that fits measures nothing.

## The collapsed gap goes in `spaceBefore`

`collapseMargins` returns the gap *before* each box, first entry always 0.
`flow.ts` adds `spaceAfter + paragraphSpacing + spaceBefore` between
consecutive elements rather than collapsing, so: `paragraphSpacing: 0`, the
whole gap in `spaceBefore`, every `spaceAfter` zero. Flow's additive rule
then reproduces the collapsed result exactly, with no change to Flow.

**A fixture for this needs two different gaps in one list.** Putting the gap
in `spaceAfter` instead produces the same total for a uniform list and
diverges only when two gaps differ, so a uniform fixture passes either way.

Inherited from `zch2.3` and worth restating, because a zero looks like a bug:
an empty block's gap is emitted as **0**, with the whole collapsed run
landing on the *following* box. A zero-height `FlowElement` there is correct
and expected.

## Two consequences, named rather than buried

**The root box's escaped top margin is dropped.** `body { margin: 8px }`
collapses up and out of the root under rule 2, and both engines drop
`spaceBefore` above the first element anyway (`started ? … : 0`). Consistent
with how Flow treats any first element, and a divergence from a browser,
where that margin is visible against the viewport.

**A box's minimum height accumulates across a column break, and its padding
lands on the last slice.** The holder is created once per box at build time
and every decorator of that box shares it, a continuation included — so
accumulating is what falls out, and re-starting per column would be the extra
code. It is also the closer reading: `min-height` is a statement about the
box, not about a slice of it. The visible consequence is that a box which
already spent its minimum in an earlier column pads by nothing in the last
one, which is right.

**`measure()` ignores `minHeight` and so under-reports for such a box.** The
padding is computed from the holder's running total, which a non-destructive
dry run must not touch. The only consumer is keep-with-next, which may
therefore judge a min-height box shorter than it places; recorded rather than
worked around, since threading speculative state through `measure` would
make the dry run destructive.

## Reporting

`CssFlowResult` mirrors `MarkdownResult`: a `skipped: string[]` in document
order, and the `unsupported: UnsupportedDeclaration[]` that `zch2.2.3` and
`zch2.3` already accumulate, passed straight through for `zch2.7` to
formalize. The rule is `svgdraw.ts`'s and it is applied here early because it
is free: an element we cannot render fully names itself and still contributes
what text it has. Visible content beats a silently dropped subtree — and it
means `zch2.6` *replaces* a skip rather than adding a path.

## What this hands `zch2.5`

```ts
// cssflow.ts
export interface CssFlowOptions {
  /** The containing-block width, IN POINTS — what the caller will place into.
   *  Divided by 0.75 on the way into resolveBoxes, which works in CSS px. */
  width: number;
  /** ComputedStyle.fontFamily is a list of NAMES and TextRun.font is an
   *  AuthoringFont; bridging them needs Document.LoadFontByName, which no
   *  module below zch2.5 may import. The seam cssbox.ts and cssinline.ts
   *  already take — zch2.5 supplies the real resolver. */
  resolveFamily: FamilyResolver;
}

export interface CssFlowResult {
  /** Ready for a Flow or for placeElements. */
  elements: FlowElement[];
  /** Every construct that did not render, in document order:
   *  'table', 'image:<src>', 'float:<left|right>'. Without this a caller
   *  cannot tell a dropped table from an empty document. */
  skipped: string[];
  /** Passed through from zch2.2.3 and zch2.3 untouched, for zch2.7. */
  unsupported: UnsupportedDeclaration[];
}

export function htmlFlowElements(
  root: HtmlDocument, options: CssFlowOptions,
): CssFlowResult;
```

`resolveFamily` is threaded rather than imported, which is what keeps the
whole stack below `zch2.5` free of a font stack — the seam `grayimage.ts`
uses for `resolve`/`inflate`, and the one `cssinline.ts` and `cssresolve.ts`
already take.

## Testing

Hand-built unit suites per named rule, each **mutation-checked**: break the
path, confirm the suite reddens, and record which cases moved. A mutation
that reddens nothing goes into `CLAUDE.md` as an uncovered rule rather than
being quietly dropped — the practice that produced the `zch2.3` note this
design is built on.

There is no vendored or generated corpus for this issue. `zch2.3`'s box
corpus measures used widths and collapsed gaps from headless Chrome and stops
short of anything positional; what this issue adds — which builder a box goes
through, where the ink lands, how a split box frames itself — is not
observable through `getComputedStyle` at all. `zch2.5` is where an end-to-end
comparison becomes possible, by rendering one source through all three entry
points and comparing extracted text.

### Mutations, named before the code

1. Put the collapsed gap in `spaceAfter` → the two-different-gaps case
   reddens; a uniform-gap case stays green.
2. Treat `height` as exact rather than a minimum → the tall-content case
   reddens. This is `zch2.3`'s mutation 7, landing here.
3. Skip the px→pt scale on `TextRun.fontSize` → the text-size case reddens.
4. Skip it on insets and margins → the geometry cases redden.
5. Drop the `first`/`last` flags on a split box → the top border draws twice
   and the bottom never.
6. Give a nested box a fresh frame instead of accumulating insets → the
   nested-box indent case reddens.
7. Descend into a `TableBox` → the table case reddens.
8. Route a heading through `paragraph()` → the structure-type case reddens
   under a tagged flow.
9. Emit each `list-item` as its own `list()` rather than one per run → the
   ordinal-continuation case reddens (every item numbered 1).
10. Drop the shared minimum-height holder, giving each decorator its own →
    the three-children case reddens.

`npm run typecheck` and `npm test` both green before the issue closes.

## The honest note this work carries forward

Float behaviour arrives at `zch2.5` untested and, now, unimplemented — a
floated box is laid out in flow and reported. `zch2.3` predicted the first
half of that ("`zch2.4` should expect to find float behaviour untested when
it starts"); this design decides the second half rather than discovering it,
because a CSS float must be able to split across a column and Flow's
`FloatingBox` by design never does. Closing that gap needs new Flow
machinery, which is a change to the one thing this epic's premise says stays
unchanged.

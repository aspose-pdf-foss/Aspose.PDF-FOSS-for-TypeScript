# The box model: block and inline formatting contexts — design

Issue: `zch2.3`, under epic `zch2` (HTML to PDF conversion, `gap-vs-java`).
Date: 2026-08-28.

`zch2.2` closed with a complete CSS front end: a tokenizer and component-value
parser (`zch2.2.1`), selectors (`zch2.2.2`) and the cascade (`zch2.2.3`), the
last handing back a `Map<HtmlElement, ComputedStyle>` over 43 longhands in CSS
px. This is the piece that turns those computed styles into boxes.

It is the last genuinely new machinery in the epic. `zch2.4`, `zch2.5` and
`zch2.6` are wiring into `flow.ts`, `flowplace.ts` and `flowtable.ts`, which
already do multi-column pagination, floats and keep-with-next.

Every number below is measured against the code or against a browser, not read
off the spec. That practice has caught a wrong claim in six designs so far,
including both of this one's immediate predecessors.

## The decision that shapes everything: it positions nothing

`zch2.3` produces a **box tree** and the arithmetic to resolve it against a
containing-block width. It computes no x, no y, no line breaks and no page
breaks.

```
zch2.2.3   Map<HtmlElement, ComputedStyle>
    ↓
zch2.3     BoxNode tree                       structure, no geometry
           resolveBoxes(boxes, width) → ResolvedBox[]
    ↓
zch2.4     BoxNode → FlowElement[]
    ↓
flow.ts    stacks, paginates, floats, keep-with-next
```

The alternative — a full layout engine owning absolute geometry — was
considered and rejected. It would duplicate pagination and line breaking that
already exist, and it would make `zch2.4` a rectangle painter rather than the
mapper its own issue describes: *"Mirror mdflow.ts exactly: know nothing about
columns, rects or pagination, and hand back a flat array. That is what makes
three entry points one implementation, and it is what lets the existing
pagination, keep-with-next and column budget work unchanged."*

**Resolution takes a width as an argument rather than baking one in, and that
is forced rather than preferred.** A percentage margin resolves against the
containing block's WIDTH — vertical margins included, which is the part that
surprises — so margin collapsing cannot be computed until the width is known.
`flow.ts` supplies that at `place()` time, so `resolveBoxes` is called there.

## Scope

**In:**

- Box generation: `display`, `display: none` generating no box, and the
  anonymous block boxes a mixed container needs.
- The BFC/IFC classification the issue is named for.
- Margin collapsing, all four rules.
- Used widths, CSS 2.1 §10.3.3 in full, including `auto` centring.
- Padding and border insets.
- `float` and `clear` classification, and shrink-to-fit for a floated box
  whose width is `auto`.
- `height` as a MINIMUM.
- Lowering an inline formatting context to `TextRun[]`.

**Out, deferred to the issue that owns it:** the anonymous-table fixup
(CSS 2.1 §17.2.1) goes to `zch2.6`, which is scoped to map tables through
`flowtable.ts`. A table-display box is recognised, marked, and emitted opaque
without descending into it. Generating anonymous table, row-group, row and
cell boxes is an algorithm of its own and belongs with the module that knows
what a table becomes.

**Out, recorded for `zch2.7` rather than silently dropped:** `inline-block`,
`vertical-align` on inline boxes, inline padding and borders, `position`,
`overflow`, and every property outside the cascade's 43.

**Units are CSS px throughout**, as `zch2.2.3` established. The single
`× 0.75` to points belongs to `zch2.4`.

## The box model

The core rule, and the reason the issue is named for two formatting contexts:
**a block container holds EITHER only block-level children OR exactly one
inline formatting context.** Where an author mixes them, the inline runs are
wrapped in anonymous block boxes.

```ts
type BoxNode = BlockBox | TableBox;

interface BlockBox {
  kind: 'block' | 'anonymous' | 'list-item';
  /** null for an anonymous box, which corresponds to no element. */
  el: HtmlElement | null;
  style: ComputedStyle;
  float: 'none' | 'left' | 'right';
  clear: 'none' | 'left' | 'right' | 'both';
  content:
    | { kind: 'blocks'; children: BoxNode[] }
    | { kind: 'inline'; runs: TextRun[]; atomics: AtomicInline[] };
}

/** A table-display box, emitted opaque for zch2.6. */
interface TableBox {
  kind: 'table';
  el: HtmlElement;
  style: ComputedStyle;
  float: 'none' | 'left' | 'right';
  clear: 'none' | 'left' | 'right' | 'both';
}

/** An inline-level box that is not text — today only an image, which zch2.6
 *  renders. It carries the index of the run it sits BEFORE, because the run
 *  list is what layoutRuns wraps and an atomic has no place in it. */
interface AtomicInline {
  kind: 'image';
  el: HtmlElement;
  style: ComputedStyle;
  beforeRun: number;
}
```

**Invariant: an anonymous box carries its parent's computed style and no
element.** It exists to hold inline content, so it must inherit the styling
that content is in; giving it a fresh initial style would reset the font and
colour of every mixed container in a document.

**Invariant: `display: none` generates no box at all**, rather than a box
flagged invisible. A hidden subtree must not reach `zch2.4`, must not consume
a margin, and must not participate in collapsing.

## Modules

| Module | Responsibility |
|---|---|
| `cssbox.ts` | The `BoxNode` model and box generation — display, anonymous boxes, the BFC/IFC split. |
| `cssinline.ts` | An IFC's content → `TextRun[]`, resolving a `ComputedStyle` to a font. |
| `cssresolve.ts` | Used widths, `auto` margins, insets, min-height, against a containing width. |
| `cssmargin.ts` | The four collapsing rules. Pure arithmetic. |

All four are pure leaves: no `Document`, no `Page`, no PDF object module, no
`node:` import, and none throws. The split `cssmargin.ts` makes against
`cssresolve.ts` is `floatstack.ts`'s — the geometry that is silently wrong
when reversed is testable from numbers rather than from a built file.

**`cssinline.ts` reuses the ONE wrapping engine and adds none.** `CLAUDE.md`
carries the invariant directly: *"there is ONE wrapping engine, `layoutRuns`
in layout.ts"*, and warns that a second wrapper lets a box measure one way and
paint another. So an IFC lowers to the `TextRun[]` model `textdecor.ts`
already defines and `layoutRuns` wraps it — inheriting justification, per-line
leading, and the link-rect geometry `runlink.ts` owns. Resolving
`font-family` + `font-style` + `font-weight` to a face goes through the family
machinery `mdstyle.ts` already uses, for the same reason.

**One known lossy edge, stated rather than discovered:** `ComputedStyle.color`
carries alpha and `TextRun.color` does not, so a translucent text colour
flattens to its RGB. Recorded for `zch2.7`.

## Used widths

CSS 2.1 §10.3.3 transcribed, not approximated. The constraint is

```
margin-left + border-left + padding-left + width
  + padding-right + border-right + margin-right  =  containing block width
```

and the algorithm is a case analysis over which of the three are `auto`:

- `width: auto` — any `auto` margin becomes 0 and `width` absorbs the
  remainder.
- exactly one margin `auto` — that margin absorbs it.
- both margins `auto`, `width` stated — the remainder splits EQUALLY. This is
  how `margin: 0 auto` centres, and getting it wrong yields a document that
  looks fine and is never centred.
- nothing `auto` and over-constrained — `margin-right` is adjusted.

**Measured against Chrome, not assumed:** a block in an 800px containing block
with `padding: 10px` and `border: 5px` has a used content width of **770px**,
and `width: 50%; margin: 0 auto` in the same block gives **400px**.

**A floated box with `width: auto` is shrink-to-fit**, which needs intrinsic
widths. `resolveBoxes` therefore takes an injected `measure` callback rather
than importing a font stack — the seam `grayimage.ts` already uses for
`resolve`/`inflate`, and what keeps this module a pure leaf. The measurement
goes through `layoutRuns`, because `tableauthor.ts`'s auto-fit already
measures min-content and max-content that way and a second measuring path is
what the one-engine invariant forbids.

## Margin collapsing

Four rules, CSS 2.1 §8.3.1:

1. **Adjacent siblings** — one's bottom margin collapses with the next's top.
2. **Parent and first in-flow child** — collapse through the top, when the
   parent has no top border and no top padding.
3. **Parent and last in-flow child** — collapse through the bottom, when the
   parent additionally has no height.
4. **A wholly empty block** — its own top and bottom margins collapse
   together.

**The combining rule is not `max`.** Collapsed margins combine as *the largest
positive plus the most negative*, so `40px` against `-10px` is `30px` and not
`40px`. A document with no negative margins cannot tell the two apart, which
is why the fixture for it uses one.

Floats, cleared boxes and the root element do not collapse.

**How a collapsed margin reaches `flow.ts`, which ADDS rather than
collapses.** Flow inserts `spaceAfter + paragraphSpacing + spaceBefore`
between consecutive elements. `zch2.4` sets `paragraphSpacing: 0` and puts the
ENTIRE collapsed gap into the following element's `spaceBefore`, zeroing the
preceding element's `spaceAfter`. Flow's additive rule then reproduces the
collapsed result exactly, and Flow itself needs no change — which is the whole
premise of the epic.

## `height` is a minimum

A stated `height` reserves at least that much vertical space; content taller
than it makes the box taller. It never clips.

The alternative readings were both worse. Honouring it exactly and clipping
matches `overflow: hidden` and is wrong for the default `overflow: visible` —
and it means content silently disappears, which is the failure mode this repo
consistently refuses. Ignoring it makes a deliberate spacer box collapse to
nothing. As a minimum it needs no interaction with pagination at all: a taller
box simply consumes more of the column, and nothing is lost, so nothing is
reported.

## The oracle

`scripts/gen-box-goldens.ts` drives headless Chrome through
`npm i --no-save tsx puppeteer`, is not run by `npm test`, and commits what
the browser said — the arrangement `gen-svg-goldens.ts` established and
`gen-selector-goldens.ts` and `gen-cascade-goldens.ts` reused.

It records exactly two numbers per element, and both were verified in a
browser before this document was written:

- **The used content width**, from `getComputedStyle(el).width`. For a block
  this IS the used content width in px and needs no arithmetic on our side —
  measured: 770px for a block in an 800px container with 10px padding and 5px
  borders, where its `getBoundingClientRect().width` is 800.
- **The gap to the previous sibling**, from `getBoundingClientRect()` as
  `next.top − prev.bottom`. This is precisely the collapsed margin between
  them.

**One measurement covers rules 1 and 2 together**, which was not obvious until
it was run: a `<div>` whose own margins are zero but whose first child has
`margin-top: 40px` produces a sibling gap of 40px, because the child's margin
collapsed *through* the parent. `wrap.top === d.top` confirms it directly.

**And the sibling gap is the ONLY way to observe collapsing at all.**
`getComputedStyle(wrap).marginTop` reports `0px` — the SPECIFIED margin, not
the collapsed one. Chrome does not expose a collapsed margin through the CSSOM
anywhere, so a corpus built on computed styles could not test this rule set.
That is the whole argument for measuring geometry here rather than reusing
`zch2.2.3`'s approach.

Fixtures pin `html { width: 800px }` so percentages are viewport-independent,
and are restricted to static, float-free, single-column documents.

### The ceiling, for `PROVENANCE.md`

1. **One engine, no second to arbitrate** — as for `zch2.2.2` and `zch2.2.3`.
2. **Absolute positions are outside the corpus**, because we produce none.
   Widths and inter-sibling gaps are the whole comparison.
3. **Floats are outside it**, because a float in a fixture would drag float
   PLACEMENT into a comparison meant to measure widths. Shrink-to-fit is
   hand-tested only.
4. **Line breaking is outside it.** Where a line breaks is `layoutRuns`'
   answer and is pinned by that module's own tests; a fixture whose text wraps
   differently in Chrome than here would fail for a reason this issue does not
   own, so fixture text is kept short enough not to wrap.
5. **Inline geometry is outside it** — `inline-block`, `vertical-align` and
   inline padding are out of scope entirely.

## What this hands `zch2.4`

```ts
// cssbox.ts
function buildBoxes(root: HtmlDocument, styles: Map<HtmlElement, ComputedStyle>):
  { boxes: BoxNode[]; unsupported: UnsupportedDeclaration[] };

// cssresolve.ts
interface ResolvedBox {
  box: BoxNode;
  contentWidth: number;
  insetLeft: number; insetRight: number;   // border + padding
  insetTop: number; insetBottom: number;
  marginTop: number; marginBottom: number; // resolved, BEFORE collapsing
  minHeight: number;
}
/** Intrinsic widths of a box's own inline content, for shrink-to-fit. Injected
 *  rather than imported, so this module needs no font stack and stays a pure
 *  leaf — the seam grayimage.ts uses for resolve/inflate. Omitted, a floated
 *  box with `width: auto` falls back to the full containing width and says so
 *  on `unsupported`. */
type MeasureFn = (box: BoxNode) => { min: number; max: number };

function resolveBoxes(
  boxes: BoxNode[], containingWidth: number, measure?: MeasureFn,
): ResolvedBox[];

// cssmargin.ts
/** The gap before each box, after collapsing; parallel to the input. */
function collapseMargins(resolved: ResolvedBox[]): number[];
```

`zch2.4` maps each `BoxNode` to a `FlowElement`, calls `resolveBoxes` at
`place()` time with the width Flow hands it, and assigns the collapsed gaps to
`spaceBefore`. `zch2.6` receives the `TableBox` nodes untouched. `zch2.7`
reads `unsupported`.

## Testing

- **Hand-built unit tests** per named rule, each mutation-checked: break the
  path, confirm the suite reddens, record which cases moved. A mutation that
  reddens nothing is recorded in `CLAUDE.md` as an uncovered rule rather than
  quietly dropped.
- **The generated corpus**, run whole with no allowlist.
- `npm run typecheck` and `npm test` both green before the issue closes.

### Mutations, named before the code

1. Collapse only rule 1 → the parent/first-child gap case reddens.
2. Drop rule 3's no-height condition → the last-child case reddens.
3. Combine collapsed margins with `max` → the negative-margin case reddens,
   and every all-positive case stays green.
4. Split the both-`auto` margin case unevenly → the centring case reddens.
5. Let a float collapse its margins → the float case reddens.
6. Resolve a percentage margin against a height → the percentage case reddens.
7. Treat `height` as exact → the tall-content case reddens.
8. Descend into a table box → the table case reddens.
9. Put the collapsed gap in `spaceAfter` → nothing here reddens, since that
   is `zch2.4`'s line; recorded now so that issue's plan carries the test.
10. Give an anonymous box a fresh initial style → the mixed-container font
    case reddens.
11. Emit a box for `display: none` → the hidden-subtree case reddens.

## The honest note this work carries forward

The corpus measures **two numbers per element on static documents**. That is
narrower than `zch2.2.3`'s, which compared every declared property, and much
narrower than `zch2.2.1`'s vendored conformance suite.

What it genuinely anchors is the arithmetic most likely to be silently wrong:
used widths and the full margin-collapsing rule set. What it says nothing
about is floats, line breaking and anything positional — and those are exactly
the parts a reader will assume a "box model" issue tested. `PROVENANCE.md`
must say so plainly, and `zch2.4` should expect to find float behaviour
untested when it starts.

# The CSS cascade: UA sheet, inheritance, shorthands, computed values — design

Issue: `zch2.2.3`, under `zch2.2`, under epic `zch2` (HTML to PDF conversion,
`gap-vs-java`).
Date: 2026-08-28.

`zch2.2.1` closed with CSS Syntax Level 3 — a tokenizer and a component-value
parser, 149 of 149 vendored cases green. `zch2.2.2` closed with selectors:
parsing, matching against the `HtmlElement` tree, and specificity, anchored by
549 generated Blink match cases. This is the third and last piece of `zch2.2`:
declarations in, computed style out.

Nothing here produces PDF, nothing here is exported from `index.ts`, and
nothing here does layout — `zch2.3` owns the box model and reads what this
produces.

Every number below is measured against the code or read from the spec. That
practice has now caught a wrong claim in five designs, including both of this
one's siblings; it caught two in this one, and both changed the shape.

## Two findings that change the shape

### `cssparse.ts` stops one step short, in two places

Both measured by running `parseStylesheet` in this repo, not read off the
spec:

- A qualified rule's `block` is `CssValue[]` — the declarations inside it are
  **unparsed**. `parseDeclarationList` takes a `string`.
- An `@media` block is likewise `CssValue[]`, holding, per nested rule, its
  prelude values followed by a single `{kind:'block', open:'{'}` value.
  `parseStylesheet` takes a `string`.

Neither is a defect. `zch2.2.1` stopped exactly where CSS Syntax stops: a
qualified rule's block is a simple block, and parsing its contents is a
separate algorithm the caller invokes. But the cascade is that caller, and it
cannot reach either declarations or nested rules without re-serializing the
values back to text — lossy, and absurd — or re-deriving the rule grammar
locally, which would give this repo two owners for one grammar.

So this issue adds **two small `CssValue[]`-taking siblings to
`cssparse.ts`**, beside the string entry points that already exist:

```ts
export function parseDeclarationsFromValues(v: CssValue[]): (CssDeclaration | CssError)[];
export function parseRulesFromValues(v: CssValue[]): Rule[];
```

The second is *easier* at the component-value level than at the token level,
which is worth recording because the reverse is the intuition: the `{}` block
has already been assembled into one value, so finding a nested rule is a scan
that accumulates prelude values until it meets a `{` block. No bracket
matching, no nesting depth.

### The named-colour table already exists, at 148 entries

`svgstyle.ts` carries the CSS/SVG named colours. Counted rather than assumed:
**148** pairs — the 147 X11 names plus `rebeccapurple` — and `transparent` is
*not* among them, being handled separately by that module's `parseColor`.

It cannot be reused as it stands. It is a **string** parser where our input is
`CssValue[]`; it carries SVG paint semantics (`none`, `url(...)` references
with fallbacks) that mean nothing in HTML; and importing `svgstyle.ts` into
the HTML CSS stack would be exactly the cross-stack coupling `cssselect.ts`
deliberately refused against `svgcss.ts`.

But a second 148-entry copy of the same data is the hazard `CLAUDE.md` names
repeatedly. So the **data** moves to its own leaf, `colornames.ts`, and both
stacks read it. A pure data move with no behaviour change; the SVG goldens are
the fence.

## Scope

**In:**

- Collecting `<style>` element text and `style=` attribute text — a walk over
  `HtmlElement`, moved here from `zch2.2.1` because the cascade is its only
  consumer and putting it in the syntax module would have cost that module its
  purity for nothing.
- A UA stylesheet for HTML defaults.
- The cascade proper: six origin/importance tiers, the style attribute,
  specificity, document order.
- Shorthand expansion to longhands.
- The inherited/non-inherited property table, and initial values.
- Inheritance and computed values, including relative lengths.
- `@media` **types** (`print`, `all`, `screen`, comma lists).
- The CSS-wide keywords `inherit`, `initial`, `unset`, `revert`.
- Colours: 3/4/6/8-digit hex, `rgb()`/`rgba()`, `hsl()`/`hsla()`, the 148
  named colours, `transparent`, `currentColor`.

**The property set is bounded by what `zch2.3`, `zch2.4` and `zch2.6` will
consume**, not by CSS. Deciding that boundary was named in the issue as most
of the design work, so it is written out in full. Counted rather than
estimated: **43** longhands.

```
font-family font-size font-style font-weight line-height
color background-color
text-align text-decoration-line text-decoration-color text-decoration-style
text-indent white-space vertical-align
display float clear width height
margin-top margin-right margin-bottom margin-left
padding-top padding-right padding-bottom padding-left
border-{top,right,bottom,left}-width
border-{top,right,bottom,left}-style
border-{top,right,bottom,left}-color
list-style-type list-style-position
border-collapse border-spacing
```

Shorthands expanded: `margin`, `padding`, `border`, `border-{side}`,
`border-width`, `border-style`, `border-color`, `font`, `background`,
`list-style`, `text-decoration`.

The set is wider than what `flow.ts` renders today, which is deliberate. The
issue's wording bounds it by the authoring layer, but `zch2.3` is the very
next issue and is already scoped to margins, padding, borders and floats. A
narrower set would mean reopening this module as that issue's first act, and
the extra longhands are mostly rows in a table rather than new machinery.

**Out, each tracked as its own issue:**

- `calc()` — `zch2.2.6`. One branch of the value parser, legal at every length
  and percentage site, with its own type rules (`px + %` is legal, `px * %` is
  not).
- `var()` and custom properties — `zch2.2.7`. The largest single item, and it
  is a *pipeline* change rather than a value feature: custom properties
  cascade and inherit like any other property, so they must be resolved first,
  substituted into other declarations, and those re-parsed, with cycle
  detection and the invalid-at-computed-value-time rule — an error model
  nothing else here has.

**Out, recorded rather than silently dropped** — every one of these reaches
`zch2.7` as data, which is that issue's whole purpose:

- `@import` (needs I/O), `@font-face`, `@page` (belongs with `zch2.5`, the
  only layer that knows the page box), and any other at-rule.
- Media *features* — `(min-width: 60em)`, `(prefers-color-scheme: dark)`. A
  query carrying one is treated as non-matching. Evaluating them needs a
  viewport, which the cascade has no business knowing.
- `vw`/`vh`, for the same reason.
- Every property outside the 43 above.
- Every declaration whose value we cannot parse.

## Units: CSS px throughout

CSS `px` is 1/96 inch and a PDF point is 1/72 inch, so `1px = 0.75pt`. The
conversion happens at exactly one boundary, and that boundary is **`zch2.4`**,
where the styled tree is lowered to `FlowElement[]` — already the CSS→PDF
seam. This module and `zch2.3` both work in px.

The decisive argument is the oracle rather than taste: `getComputedStyle`
reports px, so a golden comparison is an exact equality. In points every
comparison would carry a multiply and a floating-point tolerance, and a unit
bug would become indistinguishable from a conversion bug.

## Modules

| Module | Responsibility |
|---|---|
| `colornames.ts` | The 148 named colours. A leaf importing nothing, shared with `svgstyle.ts`. |
| `cssvalue.ts` | Values over `CssValue[]`: lengths, percentages, numbers, colours, keywords, the CSS-wide keywords. |
| `cssprop.ts` | The property table — `inherited?`, `initial`, value grammar — and the `ComputedStyle` type. |
| `cssshorthand.ts` | Shorthand → longhand expansion. |
| `cssua.ts` | The UA stylesheet as CSS text, compiled lazily. |
| `csscascade.ts` | The collection walk, sheet compilation, `@media`, and per-element winning declarations. |
| `csscompute.ts` | The top-down inheritance and computed-value walk, producing the styled map. |

All seven are pure leaves. None imports `document.js`, `page.js`, any PDF
object module, any `node:` module, `svgcss.js` or `svgstyle.js`. None throws:
an unparseable declaration is a value on an `unsupported` list, which is
`csstoken.ts`'s and `cssselect.ts`'s rule.

`cssshorthand.ts` is its own module rather than a section of `cssprop.ts`
because expansion is logic where the table is data, and because the `font`
shorthand alone — reordering, the mandatory `size/line-height` pair, the
system-font keywords it must refuse — is larger than several table rows put
together.

## The cascade proper

### Six tiers

CSS Cascade 5 §6.4 sorts by origin and importance, then by context, then by
whether a declaration is element-attached (a `style=` attribute), then
specificity, then order of appearance. We have no user origin and no shadow
context, so the first and third steps flatten to six tiers, low to high:

```
1  UA normal
2  author normal, stylesheet
3  author normal, style=
4  author !important, stylesheet
5  author !important, style=
6  UA !important
```

The flattening is the point. The tempting shortcut — "a `style=` declaration
has infinite specificity" — is right that `style=` beats any selector at equal
importance and wrong that a normal `style=` beats an `!important` stylesheet
rule. Six tiers get both directions right by construction.

Tier 6 exists even though the UA sheet below declares nothing important. It is
cheap, it is what the spec says, and `revert` makes the UA origin observable
from author CSS regardless.

**Invariant: shorthands expand at parse time, and the cascade sorts longhands
only.** `p { margin: 0; margin-top: 5px }` yields `margin-top: 5px`, and
swapping the two declarations yields `0`. Cascading shorthands as units and
expanding afterwards yields `0` both times — a wrong answer indistinguishable
from a right one without a fixture that reverses the order.

**Invariant: the cascade keeps per-origin winners, not one winner.** `revert`
means "the value this element would have had with this origin's declarations
removed". Keeping the UA winner beside the author winner makes it a lookup;
one winner makes it a second cascade pass, and the two would drift.

**Invariant: the cascade is property-agnostic.** It sorts and merges
declarations without consulting the property table, which is what lets it be
tested from hand-written declaration lists and what lets it record a
declaration it does not understand rather than dropping it. The table is
consulted in `csscompute.ts`, one layer later.

### Collection

A walk over `HtmlElement`, in document order:

- `<style>` element text, concatenated. A `<style>` whose `type` is present
  and not `text/css` is skipped and recorded — the rule `svgcss.ts` already
  applies.
- `style=` attribute text per element, parsed as a declaration list.
- It must **not** descend into a `<template>`'s `content`, for the same
  structural reason `selectAll` does not: a template's content is not part of
  the document, so a `<style>` inside one styles nothing.

`<link rel=stylesheet>` is out with `@import`, and for the same reason: I/O.

### `@media`

Honour `print` and `all`; skip `screen`. A comma list matches if any of its
queries does. A query carrying a feature is non-matching and recorded.

An HTML-to-PDF converter is a print user agent, so `@media print` blocks are
precisely the ones an author wrote for us and `@media screen` blocks are
precisely the ones they did not. Dropping every `@media`, as `svgcss.ts` does,
would render a document whose entire print stylesheet sits inside
`@media print` completely unstyled — which is the common shape for a document
written to be printed.

## The UA stylesheet

CSS **text**, a string constant in `cssua.ts`, compiled on first use through
our own parser and selector engine, then memoized.

Text rather than a pre-compiled table because it is reviewable against the
HTML Standard §15 "Rendering" line by line, because it exercises the same
parser every author sheet goes through, and because a transcription error is
then visible as CSS rather than buried in a data structure. Compiled lazily so
a document with no HTML in it pays nothing.

It is transcribed from HTML §15, not from Chrome. That is a deliberate
divergence from the oracle and it is why the oracle compares author-declared
properties only — see below.

## Values

`cssvalue.ts` parses over `CssValue[]` and never re-reads a character, the
rule `cssparse.ts` and `cssselect.ts` both hold.

- **Lengths.** `px`, `pt` (× 4/3), `pc`, `in`, `cm`, `mm`, `Q`, and the
  relative units `em`, `rem`, `ex`, `ch`. `ex` and `ch` use CSS's documented
  fallbacks of `0.5em`, since this module has no font metrics.
- **Percentages**, kept as percentages where the computed value is a
  percentage — see below.
- **Colours.** 3/4/6/8-digit hex, `rgb()`/`rgba()` in both the comma and the
  space-separated forms, `hsl()`/`hsla()`, the 148 named colours,
  `transparent`, and `currentColor`. A colour is
  `{ rgb: [number, number, number]; a: number }` with components 0..1,
  matching the repo's convention; `transparent` is `a: 0` rather than a
  separate absent case, so nothing downstream has to special-case it.
- **The CSS-wide keywords** `inherit`, `initial`, `unset`, `revert`, which are
  valid for every property and so are recognised before the property's own
  grammar is consulted.

## The property table and computed values

`csscompute.ts` walks the tree top-down. For each element: resolve CSS-wide
keywords, then compute each declared longhand, then fill the rest by
inheritance or from the initial value.

Four rules here are silent when wrong. Each is named, and each has a mutation.

**`em` resolves against two different font sizes, depending on the property.**
On `font-size` it is the **parent's** computed size; on every other property
it is **this element's** computed size. One rule for both is wrong on exactly
one property — and that property is the one whose error compounds down the
tree, so a nested document is off by a factor rather than a pixel.

**`line-height: 1.5` and `line-height: 150%` are different values, not two
spellings of one.** A number computes to the number and inherits as a number,
so each descendant multiplies by its own size; a percentage computes to px and
inherits as that px. A document with one font size cannot tell them apart, so
the fixture needs a heading inside a styled container.

**A percentage `margin`, `padding` or `width` stays a percentage in the
computed value.** It resolves against the containing block, which is
`zch2.3`'s to know. So those fields are `px | pct` in `ComputedStyle`, and
collapsing them to px here would force a guess this module cannot make. (This
is also why they are excluded from the oracle — see below.)

**`color` computes before anything that can name `currentColor`** — border
colours, `background-color`, `text-decoration-color`. Wrong order silently
yields the initial black instead of the cascaded colour, which reads as an
authoring mistake rather than a bug.

Also in the table: `font-weight: bolder`/`lighter`, resolved against the
parent's computed weight; the seven absolute `font-size` keywords
(`xx-small` … `xx-large`) and the relative `smaller`/`larger`.

**Inherited**, from our 43: `color`, the four `font-*`, `line-height`,
`text-align`, `text-indent`, `white-space`, both `list-style-*`,
`border-collapse` and `border-spacing`. The last two are the ones that read
wrong — they are inherited so that setting them on a container reaches the
table — and are worth a test for that reason alone.

**Not inherited:** everything else, `text-decoration-*` and `vertical-align`
included.

**A note for `zch2.4`, which is not a defect here:** `text-decoration` is not
an inherited property, but it *propagates* visually to in-flow descendants.
That is a rendering rule rather than a cascade rule, so this module computes
it correctly as non-inherited and the propagation belongs downstream. Writing
it down because "underline did not reach the `<span>`" will otherwise be filed
against this module.

## The oracle

`scripts/gen-cascade-goldens.ts` drives headless Chrome through
`npm i --no-save tsx puppeteer`, is not run by `npm test`, and commits what
the browser said — the arrangement `scripts/gen-svg-goldens.ts` established
and `scripts/gen-selector-goldens.ts` reused. Elements are keyed by the
child-index path `zch2.2.2` already built and already fenced with a
deliberate-mismatch test.

**It compares only the properties a fixture itself declares.** That is the
whole design of the corpus, and the reason is structural: our UA sheet is
transcribed from HTML §15 while Chrome's is Chrome's, so comparing full
computed style would mismatch on every element nobody styled, and the only
ways out would be transcribing Chrome's UA sheet — adopting its quirks as our
behaviour — or maintaining an exclusion list by hand.

What that anchors: cascade order, the six tiers, `!important`, specificity
ties, document order, inheritance, shorthand expansion, and relative-length
resolution. Which is to say, all of the machinery.

### The ceiling, for `PROVENANCE.md`

1. **One engine, no second to arbitrate.** `fixtures/svg/` requires two
   engines to agree before writing a golden; that is not available here, as it
   was not for `zch2.2.2`.
2. **The UA sheet is deliberately outside the corpus.** It is hand-tested
   against HTML §15 and the oracle says nothing about it.
3. **`getComputedStyle` returns *used* values for layout-dependent
   properties.** Percentage `margin`/`padding` and `width` come back as
   resolved px, which is a different question from the computed value this
   module produces. They are excluded from the corpus rather than compared
   against a number that means something else — and their computed-value rule
   is pinned by hand-written tests instead.
4. **`ex` and `ch` are excluded.** Chrome has font metrics; we use the 0.5em
   fallback, so agreement would be a coincidence and disagreement is not a
   defect.
5. **`smaller`/`larger` are excluded.** Browsers approximate the scaling
   factor differently and the spec does not pin one.

## What this hands the rest of `zch2`

```ts
// cssprop.ts
type Origin = 'ua' | 'author';
interface UnsupportedDeclaration {
  el: HtmlElement | null;      // null for a sheet-level construct: an at-rule
  property: string;            // '@import' and '@media' name themselves here
  value: string;               // the source text, for a caller to report
  reason: 'unknown-property' | 'unparsable-value' | 'unsupported-at-rule'
        | 'unsupported-media-feature';
}

// csscascade.ts
interface Sheet { rules: CompiledRule[]; origin: Origin }
function collectSheets(root: HtmlDocument):
  { sheets: Sheet[]; inline: Map<HtmlElement, Declared>; unsupported: UnsupportedDeclaration[] };
/** Winning longhands per element, per origin — two entries, so `revert`
 *  is a lookup rather than a second pass. */
function cascade(root: HtmlDocument, sheets: Sheet[], inline: Map<HtmlElement, Declared>):
  Map<HtmlElement, Record<Origin, Declared>>;

// csscompute.ts
function computeStyles(root: HtmlDocument): {
  styles: Map<HtmlElement, ComputedStyle>;
  unsupported: UnsupportedDeclaration[];   // zch2.7 reads this
};
```

`zch2.3` reads `ComputedStyle` for the box model and works in px. `zch2.4`
lowers the styled tree to `FlowElement[]` and owns the single `× 0.75`.
`zch2.6` reads the table and list properties. `zch2.7` reads `unsupported`,
which is why it is a list of *declarations* — property, value, element —
rather than a boolean.

## Testing

- **Hand-built unit tests** per named rule above, each mutation-checked:
  break the path, confirm the suite reddens, record which cases moved. A
  mutation that reddens nothing is recorded in `CLAUDE.md` as an uncovered
  rule rather than quietly dropped — the practice this repo follows for
  `openers_bottom` and the JBIG2 refinement context order.
- **The generated corpus**, run whole with no allowlist.
- `npm run typecheck` and `npm test` both green before the issue closes.

### Mutations, named before the code

1. Collapse tiers 2 and 3 → the `style=` versus selector case reddens.
2. Collapse tiers 3 and 4 → the normal-`style=` versus `!important`-rule case
   reddens, and the case in 1 stays green. That asymmetry is the whole
   argument for six tiers.
3. Expand shorthands *after* the cascade → the `margin: 0; margin-top: 5px`
   case reddens and its reverse stays green.
4. Resolve `em` against the element's own size on `font-size` → the nested
   `font-size: 1.5em` case reddens.
5. Treat a `line-height` number as a percentage → the mixed-size case reddens
   and the single-size case stays green.
6. Collapse a percentage margin to px → its computed-value case reddens.
7. Resolve `currentColor` before `color` → the border-colour case reddens.
8. Mark `border-collapse` non-inherited → the table case reddens.
9. Treat `revert` as `unset` → the UA-origin case reddens.
10. Apply `@media screen` → the screen-versus-print case reddens.
11. Drop every `@media` → the `@media print` case reddens, and 10 stays green.
12. Skip `<template>` content in the selector walk but not the `<style>` walk
    → the style-in-template case reddens.

## The honest note this work carries forward

`zch2.2.1` was anchored by a vendored conformance corpus and could say so.
`zch2.2.2` was anchored by a corpus generated from one browser, which is
weaker than a published suite and stronger than nothing. This one is anchored
the same way and **more narrowly still**: the corpus covers the cascade
machinery and says nothing whatever about the UA stylesheet, which is a
transcription judgement checked only against the HTML Standard by a human
reading it.

That is the largest untested surface this issue ships, it is named here rather
than discovered later, and it should be the first thing re-examined if
`zch2.5` produces documents that look wrong in ways the unit tests do not
explain.

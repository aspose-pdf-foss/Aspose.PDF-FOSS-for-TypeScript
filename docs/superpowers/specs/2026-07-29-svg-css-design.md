# SVG CSS `<style>` selector support — design

Issue: `aspose-pdf-foss-for-ts-1gg0.11` (epic `1gg0`, page-furniture & text-authoring
parity gaps). Date: 2026-07-29. Deferred from `1gg0.3`; its value rose with
`1gg0.8` (SVG text), because real-world SVG routinely sets `font-family` from a
stylesheet rather than a presentation attribute.

## Scope

`page.AddSVGObject` honours presentation attributes and inline `style=` only. A
`<style>` element is reported in `skipped` and its rules ignored entirely — so
today an `<svg>` whose paint lives in a stylesheet renders with the initial
values (black fill, no stroke).

v1 adds a minimal CSS engine covering:

- **Selectors** — type (`rect`), class (`.a`), id (`#x`), universal (`*`),
  grouping (`a, b`), and the descendant (`g .a`) and child (`g > rect`)
  combinators.
- **Cascade** — specificity `(ids, classes, types)`, source order for ties, and
  `!important`, correctly ordered against inline `style=` and presentation
  attributes.
- **Reach** — every property the existing cascade reads: paint (`fill`,
  `stroke`, widths, caps, joins, dashes, opacities), the text properties from
  `1gg0.8` (`font-family`, `font-size`, `text-anchor`, …), and gradient `<stop>`
  properties (`stop-color`, `stop-opacity`, `offset`).
- **Placement** — a `<style>` anywhere in the tree, including inside `<defs>`
  and including one that appears *after* the elements it styles. CDATA content
  included, which is how Illustrator writes it.

Out of scope, reported rather than silently dropped:

- **At-rules** — `@media`, `@import`, `@font-face`. `@font-face` in particular
  can never be honoured: an SVG cannot hand us a font program, and
  `AddSVGObject`'s `font` option is the supported way to supply one.
- **Attribute and pseudo-class selectors** — `[fill]`, `:first-child`,
  `:nth-child(n)`. Rare in real SVG assets, and each needs its own matching and
  specificity handling.
- **Sibling combinators** (`+`, `~`), and `:hover`-style interactive states,
  which a static PDF has no expression for.

## Two facts that shaped the design

### 1. The cascade change carries no regression risk

`svgstyle.ts`'s `styleGetter` currently returns `inline.get(k) ?? attrs.get(k)` —
inline `style=` over presentation attributes, with nothing between.

CSS puts presentation attributes at the **bottom**: they behave as specificity-0
declarations at the start of the author stylesheet, so *any* matching rule beats
them, however weak its selector. Adding a stylesheet therefore demotes them from
tier 1 to tier 5.

That sounds like a behaviour change to existing documents, and it is not. With no
`<style>` present the rule set is empty and the cascade collapses to exactly
`inline ?? attrs` — byte-identical output. The shift is confined to documents
carrying a stylesheet, which today render wrong regardless.

### 2. Matching cannot happen at draw time

Three separate facts push the work into a pre-pass:

- A `<style>` may appear anywhere, including **after** the elements it styles, so
  the sheet must be complete before any element is resolved.
- Descendant combinators need an **ancestor chain**, which `svgdraw.ts`'s `walk`
  does not carry.
- `<stop>` elements are resolved by `svggradient.ts` from inside `<defs>`, where
  no ancestor chain is reconstructible at all.

Threading an ancestor stack through `svgdraw.ts`, `svgtext.ts` *and*
`svggradient.ts` to serve a feature none of them is about would be the wrong
shape. Instead: one extra whole-tree walk producing a
`Map<XmlNode, CssDecls>` keyed by node identity, stored on the `Emitter` beside
`ids`. After that, any code holding an `XmlNode` gets its declarations by
lookup — no plumbing, and gradient stops work for free.

## Modules

- **`src/svgcss.ts`** — NEW. Stylesheet parsing, selector matching, and the
  per-element cascade. Pure: no PDF objects, no `Document`, no `Paint`.
  Deliberately separate from `svgstyle.ts`, which owns the cascade *result* (the
  `Paint` model) rather than selector syntax — and is already 235 lines.
- **`src/svgstyle.ts`** — `styleGetter` and `resolveStyle` take an optional
  `CssDecls`; the four-tier lookup lives in `styleGetter`, the one function all
  three consumers already share.
- **`src/svgdraw.ts`** — collect `<style>` text, parse once, run the pre-pass,
  hold the map on `Emitter`, pass `e.css.get(n)` at each `resolveStyle`.
- **`src/svgtext.ts`** — `flattenText` takes the map and passes it per element.
- **`src/svggradient.ts`** — takes the map for `<stop>` resolution.

```
collect <style> text  →  parseStylesheet  →  resolveAll(root, sheet)  →  Map<XmlNode, CssDecls>
                                                                              ↓
                    svgdraw.walk ─┬─ svgstyle.resolveStyle(parent, attrs, css)
                                  ├─ svgtext.walkText  (same getter)
                                  └─ svggradient stops (same getter)
```

## The cascade

Four tiers above the presentation attributes, in CSS 2.1 order:

```ts
(k) => inlineImportant.get(k)   // style="fill: red !important"
    ?? css.important.get(k)     // .a { fill: red !important }
    ?? inline.get(k)            // style="fill: red"
    ?? css.normal.get(k)        // .a { fill: red }
    ?? attrs.get(k)             // fill="red"   <- was tier 1, now tier 5
```

Inline `!important` is included despite being rare in SVG: it is the top tier, and
omitting it would place the other three wrong in exactly the case where someone
reached for it deliberately.

Within `css.normal` (and independently within `css.important`), rules sort by
specificity, then by source order. Specificity is the CSS triple counted per
selector:

| Component | Weight |
|---|---|
| `#id` | a |
| `.class` | b |
| type (`rect`) | c |
| `*` | nothing |

packed as `a * 10000 + b * 100 + c`, which cannot overflow for any selector a
real asset contains.

A grouped selector expands to **independent rules**, each with its own
specificity: `.a, #b { fill: red }` is two rules, not one rule at the higher
specificity. Collapsing them would make `.a` win against a competing `#c`.

## Parsing

Source is the concatenated `text` of every `<style>` element, in document order.
`xml.ts` already folds CDATA into `text`, so Illustrator's
`<style><![CDATA[.cls-1{fill:#fff}]]></style>` needs no special handling.

1. Strip `/* … */` comments first, so a comment cannot hide a brace.
2. Skip at-rules with brace balancing: `@import …;` to the semicolon,
   `@media … { … }` and `@font-face { … }` to the matching close brace.
3. Split the remainder into `selectorList { declarations }`.
4. Split the selector list on top-level commas.
5. Split each selector into compound selectors on whitespace and `>`, recording
   the combinator between each pair.
6. Parse each compound into `{ type?, id?, classes[] }`; `*` sets no constraint.
7. Split declarations on `;`, then on the first `:`; strip and record
   `!important`.

An unparseable selector drops the **whole rule**, which is what browsers do. A
half-applied rule is worse than none, because the half that applied is
indistinguishable from a correct render.

## Matching

Right-to-left, the standard order — the rightmost compound is the most
selective, so a failure there rejects the rule immediately.

```
match(sel, i, node, ancestors):
  if not matchCompound(sel[i], node): return false
  if i == 0: return true
  if combinator[i-1] == '>':
      parent exists and match(sel, i-1, parent, …)
  else:                                   // descendant
      any ancestor a: match(sel, i-1, a, …)
```

The descendant case **backtracks**: in `a b c`, the nearest `b`-matching ancestor
may have no `a` above it while a further one does. Taking only the nearest
candidate silently fails to match rules that should apply.

`matchCompound` checks the type name (absent for `*`), the id, and that every
class in the selector appears in the element's space-separated `class` attribute.

Names match **case-sensitively**: SVG is XML, so `RECT` is not `rect` and
`.Logo` is not `.logo`. Property names are lower-cased, matching what
`parseInlineStyle` already does.

## Reporting

`<style>` stops being named in `skipped` — it is honoured now. It is named
instead only when something was genuinely dropped:

| Condition | Reported |
|---|---|
| a rule whose selector will not parse | `style` |
| any at-rule (`@media`, `@import`, `@font-face`) | `style` |
| a `<style>` whose `type` is present and not `text/css` | `style` |
| a stylesheet that parsed and applied in full | *nothing* |

This keeps the existing contract intact: `skipped` means *fidelity was lost*, not
*this element was present*.

## Errors

No new error conditions. A malformed stylesheet is not a parse failure — CSS's
own error handling is to discard what it cannot understand and keep the rest,
which v1 follows, matching how `svgpath.ts` already treats malformed path data.

## Testing

`svgcss.ts` carries most of the suite, as the pure unit where a failure isolates
to one cause:

- **Parsing** — comment stripping, including a comment containing a brace; each
  at-rule form skipped with balancing; grouping expanded; `!important` detected;
  a declaration with no colon ignored without killing its neighbours.
- **Specificity** — the three components counted; `*` contributing nothing;
  source order breaking a tie; a grouped selector's branches scored
  independently.
- **Matching** — each selector kind; multiple classes on one element; descendant
  vs child; the `a b c` backtracking case; case sensitivity.
- **Cascade** — all five tiers, each beating the one below.

Then integration through `drawSvg`:

- a class-styled `rect` emitting `1 0 0 rg`;
- a CSS rule beating an equivalent presentation attribute;
- inline `style=` beating the CSS rule, and CSS `!important` beating inline;
- `font-family` from a stylesheet reaching the font provider — **the case that
  motivated this issue**, since a substituted font is silent by design and would
  otherwise be invisible;
- a `<stop>` styled by CSS changing the emitted shading;
- a `<style>` appearing after the elements it styles;
- the reporting table above.

### On verification

Unlike the SVG goldens or `1gg0.8`'s y-flip, there is **no independent reader**
to check against — `raster.ts` does not parse CSS, so nothing in this repository
can disagree with our interpretation. CLAUDE.md's rule cannot be satisfied the
usual way.

The substitutes:

- assertions are on **emitted operators** (`1 0 0 rg`), derived by hand from the
  CSS 2.1 cascade rules rather than from our implementation's behaviour;
- the tier ordering is **mutation-proved**: restoring presentation attributes
  above the CSS tier must turn a test red, as must reversing the specificity
  comparison.

A real-world fixture would be the proper answer here, and `1gg0.13` already
tracks sourcing one with provenance; a stylesheet-bearing Illustrator export
would serve that issue and this one together.

## Documentation

`README.md`: remove CSS `<style>` from the SVG "not rendered" list, describe the
supported selector set and the cascade position of presentation attributes, and
record the at-rule limitation beside the existing gradient and text ones.

## Follow-ups

Filed under epic `1gg0` if wanted later — neither is proposed now:

1. Attribute and pseudo-class selectors.
2. Sibling combinators (`+`, `~`).

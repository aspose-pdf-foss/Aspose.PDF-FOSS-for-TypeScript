# CSS selectors: parse, match and specificity — design

Issue: `zch2.2.2`, under `zch2.2`, under epic `zch2` (HTML to PDF conversion,
`gap-vs-java`).
Date: 2026-08-27.

`zch2.2.1` closed with CSS Syntax Level 3 complete — a tokenizer and a
component-value parser, 149 of 149 vendored cases green. This is the second
piece: turning a qualified rule's prelude into a selector, matching it against
the `HtmlElement` tree `zch2.1` produces, and computing its specificity.
Nothing here understands a property, a value, or the cascade.

Every number below is measured against the code or read from the spec. That
practice caught a wrong claim in three of the four `zch2.1` designs, and it
caught one in this one: the issue's own premise.

## The issue's premise was wrong, and it changes the plan

The issue as filed says, twice and emphatically:

> NO VENDORABLE ORACLE. WPT's selector tests are reftests or testharness.js,
> both of which need a renderer or a JS engine; there is no data-driven
> corpus. Tests are hand-built, and the design must say so plainly rather than
> let a green suite imply conformance.

The first sentence is true. The conclusion does not follow, because this repo
already has a third pattern for exactly this situation, and it is neither
"vendor a corpus" nor "hand-build and hope":
`scripts/gen-svg-goldens.ts` drives headless Chrome through
`npm i --no-save puppeteer`, is not run by `npm test`, and commits what the
browser produced as fixtures under a `PROVENANCE.md`. The suite stays
hermetic because the goldens are committed; the evidence is third-party
because a browser produced them.

That works here and is **cheaper than it is for SVG**, because a selector's
answer is a list of elements rather than a bitmap: no rasterization, no
antialiasing tolerance, no second engine needed to arbitrate. So the oracle
is **generated rather than vendored**, and this issue is anchored after all.

What does not change is the honesty requirement, which now attaches to a
different claim — see *The oracle's ceiling* below.

## Scope

**In:**

- The selector grammar: type, universal, `#id`, `.class`, attribute selectors
  (all six operators plus the `i`/`s` case flags), the four combinators
  (descendant, `>`, `+`, `~`), and selector lists.
- The structural pseudo-classes: `:root`, `:empty`, `:first-child`,
  `:last-child`, `:only-child`, `:nth-child()`, `:nth-last-child()`, and the
  four `-of-type` forms plus `:nth-of-type()`/`:nth-last-of-type()`.
- The logical pseudo-classes `:not()`, `:is()`, `:where()`.
- The dynamic pseudo-classes `:hover`, `:active`, `:focus`,
  `:focus-visible`, `:target` and `:visited` — **in, as recognised selectors
  that match nothing**, which is not the same as being out. See the rule
  below; being out would invalidate every list they appear in.
- `:link`, which does match: an `<a>` with an `href` is a fact about the
  document rather than about a pointer.
- Specificity, including `:is()`/`:not()` taking their arguments' maximum and
  `:where()` contributing nothing.
- Matching against `HtmlElement`, and a document-order `selectAll`.

**Out, and tracked as its own issue:** `:has()`. It is the one pseudo-class
that cannot be answered by walking up parent pointers — every candidate needs
a search of its own subtree — so `zch2.2.3`'s whole-tree pre-pass acquires a
quadratic worst case that deserves its own thinking rather than a footnote
here.

**Out, and tracked with it:** `:lang()` and `:dir()`, which need `lang`
inheritance; that is the cascade's, so they cannot be answered in this module
at all.

**Out, and deliberately not an error:** namespace-qualified selectors
(`svg|rect`). We implement no `@namespace`, so the prefix syntax has nothing
to resolve against.

Nothing here produces PDF, and nothing here is exported from `index.ts`.
`zch2.2.3` is the only consumer.

## The module, and why it sits beside `svgcss.ts`

One new file, **`src/cssselect.ts`**.

`svgcss.ts` already has a selector engine — compound selectors, descendant
and child combinators, packed specificity, and a right-to-left match that
backtracks. Reusing it was a live option and the issue asks the design to
settle it. It sits beside, for four reasons that compound:

1. **Different input.** `svgcss.ts` takes a raw string and finds selectors
   with regexes, because it predates any CSS tokenizer here. This takes
   `CssValue[]` — a qualified rule's prelude, already tokenized by
   `cssparse.ts`. Re-lexing a string would put a second CSS grammar in the
   repo and would have to rejoin `~=` out of two delim tokens, which is
   exactly what `csstoken.ts`'s pinned spec era spares us.
2. **Different node type.** `XmlNode` has no parent pointers, which is why
   `svgcss.ts`'s `matches` threads an explicit `ancestors` array and why its
   only entry point is a whole-tree pre-pass. `HtmlElement` has them.
3. **Different case rules.** HTML type and attribute names are ASCII
   case-insensitive; SVG is case-sensitive XML. That is not a flag on one
   engine so much as a different question being asked.
4. **Six modules and a golden set depend on the current one.**
   `svgdraw.ts`, `svgfilter.ts`, `svggradient.ts`, `svgmask.ts`,
   `svgstyle.ts` and `svgtext.ts` import `svgcss.js`, and the SVG stack
   carries browser-rendered goldens plus `fixtures/svg-input/`. Generalising
   it risks moving those for no user-visible gain on the SVG side.

Two grammars sharing a name and no code — the idiom `CLAUDE.md` already
records for `tablegrid.ts` against `tablespan.ts`, and for `mdscan.ts`
against `htmltoken.ts`. The entry recorded for `cssselect.ts` must say so, or
the duplication reads as an oversight and gets "fixed".

**Invariant: a pure leaf.** It imports `htmldom.js` for types and
`cssparse.js`/`csstoken.js` for values. No `Document`, no PDF object, no
`node:` import. Collecting `<style>` text is a tree walk and stays
`zch2.2.3`'s, as `zch2.2.1` already decided for the syntax modules.

**Invariant: it never throws.** An unsupported or malformed selector is a
`null` return, and the caller drops the rule — which is CSS's own behaviour
for an invalid selector, not a degradation we invented. This is
`csstoken.ts`'s and `htmltoken.ts`'s rule and the opposite of `parseXml`.

## The model

```ts
type Combinator = 'descendant' | 'child' | 'next-sibling' | 'subsequent-sibling';
type AttrOp = 'exists' | '=' | '~=' | '|=' | '^=' | '$=' | '*=';

interface AttrSel { name: string; op: AttrOp; value?: string; ci?: boolean }

interface Compound {
  type?: string;
  id?: string;
  classes: string[];
  attrs: AttrSel[];
  pseudos: Pseudo[];
  pseudoElement?: string;
}

interface ComplexSelector {
  parts: Compound[];               // leftmost first
  combinators: Combinator[];       // combinators[i] joins parts[i] to parts[i+1]
}

type SelectorList = ComplexSelector[];
```

`parts` is leftmost-first with a parallel `combinators` array, which is
`svgcss.ts`'s shape — the one thing worth keeping from it, because the
right-to-left match reads naturally as a descending index and a reviewer who
knows one file can read the other.

**`id` and `classes` stay separate from `attrs`** even though both are
attributes underneath. Matching is then a direct compare rather than a scan of
a list, and specificity reads off the shape instead of re-deriving which
attribute selectors were really classes.

`Pseudo` is a discriminated union over three shapes: the plain structural
ones, the `An+B` ones carrying `a`, `b` and which axis they count on, and the
logical ones carrying a nested `SelectorList`.

## Matching

`matches(sel: ComplexSelector, el: HtmlElement): boolean`, right-to-left over
`parts`, **with no `ancestors` argument**. `htmldom.ts`'s own header says the
node model is mutable with parent pointers because "zch2.2's selector matching
needs ancestor and sibling traversal"; this is the issue that cashes that in.
Element siblings are the parent's children filtered to `kind === 'element'`.

Backtracking is required for `descendant` and `subsequent-sibling` for the
reason `svgcss.ts` records against its own descendant case: in `a b c`, the
nearest `b`-matching ancestor may have no `a` above it while a further one
does. `child` and `next-sibling` have exactly one candidate and do not
backtrack.

### Five rules that are silent when wrong

Each gets a test named for what it protects, and each is mutation-checked.

**Type names are ASCII case-insensitive on HTML elements and case-sensitive
otherwise.** One rule, and it must be asserted in both directions: `DIV`
matches `<div>`, and `lineargradient` must **not** match SVG
`<linearGradient>`. A one-directional test passes with the namespace check
deleted.

**Attribute names are ASCII case-insensitive on HTML elements; values are
case-sensitive unless the `i` flag says otherwise.** The two halves are
independent and a test asserting only the name half stays green when the value
half is wrong.

**In quirks mode, `#id` and `.class` match ASCII case-insensitively.**
`HtmlDocument.quirks` is computed properly by the tree builder
(`htmltree.ts:633`, from `§13.2.6.4.1`) and is currently read by exactly one
line of parsing logic. Reaching it requires walking up to the document, which
a template's content cannot do — see below — so a templated element is
non-quirks by construction, which is the answer we want anyway.

**A dynamic pseudo-class is KNOWN AND NEVER MATCHES — it is not unknown.**
`:hover`, `:active`, `:focus`, `:focus-visible`, `:target` and `:visited`
have no meaning in a static PDF, so they match nothing. The distinction from
"unsupported" is load-bearing and the failure is silent: an invalid selector
invalidates the whole list, so treating `:hover` as unknown makes
`a, a:hover { color: blue }` drop its `a` half too, and the document renders
unstyled rather than merely un-hovered. `:link` is the exception in this group
and does match — an `<a>` with an `href` — because that is a fact about the
document rather than about a pointer. `:visited` never matches, which is both
correct here and what browsers do for privacy.

**A pseudo-element is parsed, recorded on `Compound.pseudoElement`, and never
matches an element.** `p::before {}` is inert in this module. Recording it
rather than rejecting it is what lets `zch2.3`/`zch2.4` pick up generated
content later without re-parsing, and it keeps a `::before` rule from
invalidating a list it shares.

### Template content needs no special case

`htmltree.ts:719` assigns `el.content = createFragment()`, and
`htmldom.ts`'s `createFragment` leaves `parent: null`. So the chain from an
element inside a template's content runs element → fragment → `null` and
never reaches the document. Combined with `selectAll` not descending into
`content` on the way down, "CSS must not match into template content" is
structural in **both** directions, exactly as `htmldom.ts` claims when it
argues for the fragment being a real node.

That is a property of two files agreeing, not of one line, so it gets a test
of its own rather than being left to be rediscovered when someone gives
`createFragment` a parent for an unrelated reason.

## Specificity

```ts
type Specificity = readonly [number, number, number];
```

A tuple compared lexicographically, **not** `svgcss.ts`'s packed
`a * 10000 + b * 100 + c`. Packing needs a documented no-carry bound and
`svgcss.ts` duly documents one; a tuple needs nothing, and `:is()`'s "take
the maximum of the arguments" becomes a plain lexicographic max rather than a
claim about the packing preserving order. The cost is a comparator function
that `zch2.2.3` would have needed anyway to break ties on source order.

The weights, each of which is easy to get plausibly wrong:

| Construct | Contributes |
|---|---|
| `#id` | `a` |
| `.class`, `[attr]`, structural pseudo-class | `b` |
| type, pseudo-element | `c` |
| `*`, combinators | nothing |
| `:where(…)` | **nothing**, whatever its arguments |
| `:is(…)`, `:not(…)` | the **maximum** of its arguments' specificities |

`:where()` returning zero and `:is()` returning a max are the two that a
hand-built test tends to assert by restating the implementation. They are the
reason the oracle below reads specificity out of `getComputedStyle` rather
than trusting a number nobody can see.

## The oracle

**`scripts/gen-selector-goldens.ts`**, following `gen-svg-goldens.ts` line for
line in its conventions: installed with `npm i --no-save tsx puppeteer`, so
`package.json` is unchanged and the library's dependency tree does not grow;
**not run by `npm test`**; output committed under `test/fixtures/css-selectors/`
with a `PROVENANCE.md` recording the Chrome version, the exact command, the
SHA-256 of the emitted JSON, and what the goldens do and do not cover.

Two golden kinds, because the two things this issue ships are observable in
two different ways.

**Match sets.** A set of HTML documents crossed with a list of selectors. For
each pair, Blink's `document.querySelectorAll` gives the matched elements, and
each is identified by its **child-index path** from the document element —
`[1, 0, 3]` meaning "second child, then first, then fourth", counting element
children only. The path is what lets the answer be compared at all, since
there is no shared node identity across the two engines.

**Specificity order.** Pairs of selectors that both match one element and set
the same property to different values, resolved by reading
`getComputedStyle`. This turns specificity — a number with no direct
observable — into one, and it is where the `:is()`/`:where()`/`:not()`
weights and the attribute-equals-class parity actually get checked rather than
restated.

### The oracle's ceiling, stated plainly

Three things it does not give, and they must be in `PROVENANCE.md` rather than
left implicit behind a green suite:

1. **Blink is one implementation, not the spec.** Where Blink and Selectors 4
   disagree, this freezes Blink. That is the same trade `fixtures/svg/` makes,
   which is why that script requires *two* engines to agree before it writes a
   golden — a luxury not available here, since there is no second selector
   engine we can run in this environment without adding a runtime dependency.
2. **The identifying path is computed on both sides**, and that is the one
   place a bug can cancel out — the differential-test trap `CLAUDE.md` records
   under the fixtures table. The harness therefore carries a
   **deliberate-mismatch test**: a golden edited to name the wrong element must
   turn the suite red. Without it, "the paths agree" could mean "both walks are
   wrong the same way".
3. **It says nothing about what we chose not to implement.** A `:has()`
   selector is absent from the corpus by construction, so the corpus cannot
   report the gap. The scope section above is the record.

Hand-built tests remain for the rules where Blink and a wrong implementation
would agree for the wrong reason — most sharply the dynamic-pseudo-class rule,
where Blink's answer for `a:hover` on a page nobody is hovering over is
"matches nothing", which is *also* what a build that treats `:hover` as
unknown produces for that selector alone. Only the shared-list case
(`a, a:hover`) separates them, and only if it is in the corpus deliberately.

## What this hands `zch2.2.3`

```ts
parseSelectorList(prelude: CssValue[]): SelectorList | null
parseSelectorText(src: string): SelectorList | null    // tests and the oracle harness
matches(sel: ComplexSelector, el: HtmlElement): boolean
selectAll(root: HtmlNode, list: SelectorList): HtmlElement[]   // document order, skips template content
specificityOf(sel: ComplexSelector): Specificity
compareSpecificity(a: Specificity, b: Specificity): number
```

The cascade proper — origins, `!important`, declaration merging, the UA
stylesheet, `<style>` and `style=` collection — stays in `zch2.2.3`, as that
issue's own text says. `selectAll` is here rather than there because the
oracle harness needs it and because the template-content skip belongs with the
traversal rules it enforces.

## Testing

- **Hand-built unit tests** per named rule above, each one mutation-checked:
  break the path, confirm the suite reddens, record which cases moved.
- **The generated corpus**, run whole with no allowlist, the way
  `zch2.2.1` runs `css-parsing-tests`.
- **The deliberate-mismatch test** on the harness itself.
- `npm run typecheck` and `npm test` both green before the issue closes.

### Mutations, named before the code

Naming them first is what stopped `zch2.2.1` from shipping a rule with no
cover. Each must redden something, and a mutation that reddens nothing is
recorded as an uncovered rule rather than quietly dropped — the practice
`CLAUDE.md` records for `openers_bottom` and for the JBIG2 refinement context
order.

1. Match type names case-sensitively → HTML cases redden.
2. Match type names case-insensitively for foreign elements → the
   `linearGradient` case reddens.
3. Ignore the quirks flag for `.class`/`#id` → the quirks cases redden.
4. Treat a dynamic pseudo-class as unknown → the shared-list case reddens,
   and the `a:hover`-alone case does **not**, which is the asymmetry the rule
   is about.
5. Give `:where()` its arguments' specificity → the specificity goldens redden.
6. Give `:is()` the sum rather than the max → likewise.
7. Drop backtracking on `descendant` → the `a b c` case reddens.
8. Drop backtracking on `subsequent-sibling` → its own case reddens.
9. Let `selectAll` descend into `template.content` → the template case reddens.
10. Weigh an attribute selector as a type rather than a class → the
    specificity goldens redden.

## The honest note this work carries forward

`zch2.2.1` was anchored by a vendored corpus and could say so. This one is
anchored by a corpus **we generated from one browser**, which is weaker
evidence than a published conformance suite and stronger than nothing. It is
the same standing as `fixtures/svg/`, minus the second engine.

`zch2.2.3` has neither, and its design must say so — the cascade's oracle
would have to be `getComputedStyle` over whole documents, which is a much
larger surface to encode than a match set and may not be worth it. That
decision belongs to that issue; this document only records that the
"no oracle" claim was worth re-examining once, and should be re-examined
there too.

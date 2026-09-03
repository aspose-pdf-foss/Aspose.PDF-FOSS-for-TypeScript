# css-selectors — provenance

Blink's answers for a set of documents crossed with a set of selectors, here
to validate `src/cssselect.ts` against expectations this repo did not author.
See `docs/superpowers/specs/2026-08-27-css-selectors-design.md`.

**GENERATED, not vendored.** There is no data-driven selector corpus to
vendor: WPT ships reftests and `testharness.js` tests for selectors, both of
which need a renderer or a JavaScript engine. So this corpus is produced the
way `test/fixtures/svg/` is — by driving a browser from a script outside
`npm test` and committing what it said.

**Producer:** Chrome/152.0.7977.54, via puppeteer.
**Command:**

    npm i --no-save tsx puppeteer
    npx tsx scripts/gen-selector-goldens.ts

| File | Bytes | Match cases | Contests | SHA-256 |
|---|---|---|---|---|
| `goldens.json` | 268603 | 1344 | 10 | `3c43a55b4bf721fed7a317c3479c47178af289cb896f56ba0a2fcfb14489d6eb` |

14 documents x 97 selectors. Every case is run, with no allowlist. The full
cross product is 1358; Blink refused exactly ONE selector, `div:has(p:has(span))`,
on all 14 documents, so 1344 is what remains and no selector was silently
dropped for any other reason. That refusal is itself the finding: a nested
`:has()` is invalid CSS and `src/cssselect.ts` refuses it too, pinned in
`test/cssselect-has.test.ts` because a corpus can only record what Blink
ACCEPTS. The counts are asserted in `test/cssselect-suite.test.ts`, so a
regenerated corpus reddens the build rather than quietly changing what
`zch2.2.2` and `zch2.2.4` test.

The corpus grew for `zch2.2.4`, which added `:has()`: 19 selectors, two
documents shaped for relative selectors, and two specificity contests. It grew
again for `zch2.2.5`: 17 selectors for `:lang()` and `:dir()`, three documents
(one for language inheritance and the subtag-boundary rule, one for regional
tags, one for both `dir=auto` resolutions and the `<bdi>` default), and two
contests pinning that both weigh as ordinary pseudo-classes.

## What it found on its first run, which is why it exists

Two divergences, and neither was a transcription slip:

1. **A foreign type name folds too.** `src/cssselect.ts` compared a foreign
   element's name case-SENSITIVELY, which is what this issue's design and its
   implementation plan both specified. Blink matches `linearGradient`,
   `lineargradient` and `LINEARGRADIENT` alike against SVG `<linearGradient>`
   — confirmed through `querySelectorAll`, `Element.matches` AND the
   stylesheet cascade, with `clippath` still failing to match, so it is
   genuinely folding rather than a wildcard. The case-sensitive rule is
   XML's: the same probe against a document parsed as `application/xml`
   matches `linearGradient` and not `lineargradient`. `parseHtml` produces
   only HTML documents, so the fold-always rule is the whole rule here, and
   `Compound` needed no second spelling of the name after all.

2. **A contest that measured applicability, not specificity.** The generator
   originally set `:not(#t)` against `.c.c` on `<p id=t class=c>`. `:not(#t)`
   cannot match that element, so Blink's answer recorded `.c.c` as the winner
   — a fact about which rule APPLIED, which a consumer then reads as a
   specificity claim Blink never made. The generator now requires
   `el.matches()` for both selectors before recording a contest, and the case
   is written as `:not(#other)`, which both matches and still weighs
   `[1, 0, 0]`.

The second fix drops one contest from seven to six: `p:hover` against `p.c`
is refused by the same guard, nobody hovering over a headless page. That is
correct and it costs coverage — see item 5 below.

## What the zch2.2.4 regeneration found

Nothing wrong, which is worth recording rather than passing over: all 869
cases and all 8 contests agreed on the first run, with no allowlist. The
`:has()` work was therefore checked against Blink and not merely against
itself — unlike the two rules above, this corpus corrected nothing, so the
evidence it gives is confirmation rather than correction.

It did settle one thing the spec text alone leaves ambiguous. Blink refused
`div:has(p:has(span))` on all 11 documents, confirming that `:has()` is
non-forgiving and that a nested `:has()` is invalid — which is the CURRENT
reading of Selectors 4, after `:has()` was changed from a forgiving argument
list, and not the one an older reference would give.

## What the zch2.2.5 regeneration found, and it changed the feature

`:lang()` and `:dir()` agreed with Blink on every one of their 238 cases and
both contests on the first run. But the regeneration also **narrowed the
feature**, which is the more valuable result.

`zch2.2.5` was implemented to Selectors 4, whose `:lang()` argument is
`<language-range>#` — a comma-separated list whose members may be strings and
may carry `*` wildcards. Four such selectors were added to this corpus and
all four came back **dropped**, which is this generator's signal that Blink
REFUSED them. Probed directly, Chrome 152 accepts only a bare unquoted ident:

| selector | Chrome 152 |
|---|---|
| `p:lang(en)`, `p:lang(de-CH)` | matches |
| `p:lang(en, fr)`, `p:lang("en")` | refused |
| `p:lang("*")`, `p:lang("*-CH")`, `p:lang(*-CH)` | refused |

That is not merely a coverage gap. An unsupported selector invalidates its
whole list, so Blink discards `p, p:lang("*-CH")` entirely — and a build
accepting the wider grammar would style content that no browser styles, in
the permissive direction, with this corpus unable to see the divergence
because Blink refuses the selector rather than answering it. `cssselect.ts`
was narrowed to match Blink. The RFC 4647 extended-filtering MATCHER is
unaffected and still wildcard-capable; what narrowed is the syntax an author
may write.

The wildcard selectors are now **absent** from the generator rather than
listed and dropped: listing them would read as coverage while contributing no
case at all.

## What this covers

The match sets cover the whole implemented grammar: type, universal, id,
class, all six attribute operators with the `i` flag, the four combinators,
the structural pseudo-classes including the An+B forms that tokenize as a
single dimension or ident, `:not()`/`:is()`/`:where()`, `:link`, the
type-name case rules, and — since `zch2.2.4` — `:has()`: all four lead forms
of a relative selector, the anchoring case, and composition with `:is()`,
`:not()` and a second `:has()` on the same compound.

The specificity contests cover what no API reports directly: they set one
property twice on one element and read `getComputedStyle` to learn which rule
won. That is where `:where()` contributing nothing and an attribute selector
weighing as a class are actually checked rather than restated. Two of the
eight are `:has()`: that it takes its arguments MAXIMUM, and that its implicit
anchor weighs nothing — the second separates the two readings by itself, since
`p:has(> b)` at [0, 0, 2] loses to `.c` while a counted anchor would make it
[0, 1, 2] and win.

## What this does NOT cover, and it must not be read as covering it

1. **Blink is one implementation, not the spec.** Where Blink and Selectors 4
   disagree, this freezes Blink. `test/fixtures/svg/` makes the same trade and
   mitigates it by requiring TWO engines to agree before writing a golden.
   That is not available here: there is no second selector engine runnable in
   this environment without adding a dependency.
2. **The child-index path is computed on both sides** — in the browser by the
   generator, and in `test/helpers/selector-goldens.ts` by the loader. That is
   the differential-test trap `CLAUDE.md` records: a bug in the walk can
   cancel out. `test/cssselect-suite.test.ts` carries a deliberate-mismatch
   test proving the harness CAN fail, and a round-trip test pinning one path
   by hand.
3. **It says nothing about what we chose not to implement.** The corpus is a
   list of selectors we wrote, so a construct absent from it is invisible
   rather than reported, and the design documents are the record. This item
   named `:has()` until `zch2.2.4` implemented it and `:lang()`/`:dir()` until
   `zch2.2.5` did — which is the point: an omission here is never announced by
   the corpus, only by someone noticing.

   It also cannot report a REFUSAL. The generator drops any selector Blink
   itself rejects, so `div:has(p:has(span))` — invalid CSS, refused by both —
   contributes no case. Agreement on an invalid selector is pinned by unit
   test only.

   And it cannot see a COST rule. Widening `:has()`'s descendant candidate
   pool from the anchor's subtree to the whole document leaves this corpus
   entirely green, the answers being identical; only the running time moves.
   Measured, and recorded in `src/cssselect.ts` beside the code it concerns.
4. **Dynamic pseudo-classes are under-covered by construction.** Blink's
   answer for `a:hover` on a page nobody is hovering over is "matches
   nothing", which is also what a build treating `:hover` as UNKNOWN produces
   for that selector alone. Only the shared-list case separates them, and that
   case lives in `test/cssselect-logical.test.ts` rather than here.
5. **A dynamic pseudo-class's WEIGHT is not covered at all.** The one contest
   that would have measured it (`p:hover` against `p.c`) is exactly the shape
   the applicability guard refuses, and correctly so — a rule that does not
   apply cannot lose a specificity contest. `test/cssselect-specificity.test.ts`
   asserts it directly instead.
6. **`:is()`'s max-versus-sum is not separated here either.** The contest
   `:is(#t, .c)` against `.c.c` is won by `[1, 0, 0]` under the maximum
   reading and by `[1, 1, 0]` under the sum reading — both beat `[0, 2, 0]`.
   `test/cssselect-logical.test.ts` is what distinguishes them. Measured:
   summing instead of taking the maximum reddens that file and leaves this
   corpus green.
7. **A contest is a ONE-SIDED bound, by construction.** The generator writes
   the losing rule second, so a tie is legitimately resolved by source order
   and the suite can only assert `compareSpecificity(winner, loser) >= 0`.
   A mutation that collapses a real difference into a TIE therefore passes
   here. Measured: counting an attribute selector as a type rather than a
   class turns `[class] BEAT p` from `[0,1,0]` against `[0,0,1]` into
   `[0,0,1]` against `[0,0,1]`, which still satisfies `>= 0` — that mutation
   reddens three cases in `test/cssselect-specificity.test.ts` and nothing at
   all here.
8. **Nothing in the corpus reaches a `<template>`.** No document declares
   one, so making `selectAll` descend into template content reddens
   `test/cssselect-match.test.ts` alone.

## Regenerating

Only when the grammar grows. Re-run the command above, update the table, and
expect the asserted counts in `test/cssselect-suite.test.ts` to need updating
with it — that is the point of asserting them.

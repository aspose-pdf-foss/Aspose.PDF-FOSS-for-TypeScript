# css-cascade — provenance

Chrome's computed style for a set of documents, here to validate the cascade
in `src/csscascade.ts` and `src/csscompute.ts` against expectations this repo
did not author. See `docs/superpowers/specs/2026-08-28-css-cascade-design.md`.

**GENERATED, not vendored,** the way `test/fixtures/svg/` and
`test/fixtures/css-selectors/` are: WPT's cascade tests are `testharness.js`
and need a JavaScript engine, so there is no data-driven corpus to vendor.

**Producer:** Chrome/152.0.7977.54, via puppeteer, with
`emulateMediaType('print')` — without which Chrome is a screen user agent and
the `@media print` case would record the wrong answer while looking healthy.

**Command:**

    npm i --no-save tsx puppeteer
    npx tsx scripts/gen-cascade-goldens.ts

| File | Bytes | Cases | Comparisons | SHA-256 |
|---|---|---|---|---|
| `goldens.json` | 17480 | 22 | 320 | `9476eb42a48ed520d9a116d95012eb9cecc4d5a745c2432ba290c639e8b5c3ab` |

Every case is run, with no allowlist.

## What it compares, and what it deliberately does not

**Only the properties each fixture DECLARES**, on every element of that
fixture's document. That is the whole design. Our UA stylesheet is transcribed
from HTML §15 while Chrome's is Chrome's, so comparing full computed style
would mismatch on every element nobody styled, and the only ways out would be
transcribing Chrome's UA sheet — adopting its quirks as our behaviour — or
maintaining an exclusion list by hand.

What that anchors: cascade order, the six tiers, `!important`, the style
attribute, specificity, document order, inheritance, the CSS-wide keywords,
shorthand expansion, relative-length resolution, and `@media print`.

**The four `zch2.2.6` cases** add `calc()`, `min()`, `max()` and `clamp()`:
operator precedence, nesting, the unit table agreeing inside and outside a
math function, `clamp()`'s inverted-bounds rule, and — the case worth having
most — that an expression we REFUSE is one Chrome refuses too, so a hole in
the type rules shows up as a dropped declaration rather than as a plausible
number. All five mutations aimed at them redden the corpus.

Every declared value in those four reduces to a pure px or to a number,
because of ceiling 3 below: anything a percentage reaches comes back from
Chrome as used pixels. That is a limit on the CORPUS, not on the feature —
the percentage-bearing half is pinned by `test/csscalc.test.ts`,
`test/cssresolve.test.ts` and `test/htmlflow.test.ts`.

**The four `zch2.2.7` cases** add custom properties and `var()`: basic
resolution and inheritance, the fallback rules, case sensitivity, and `var()`
inside both a shorthand and `calc()`. All four agreed with Blink on the first
generated run.

The one worth naming is `var-fallback`'s `#b`. Its `--x` resolves to `10px`,
`color: 10px` then fails, and the element **inherits** rather than taking the
fallback — because a fallback fires only when the referenced property is
guaranteed-invalid, never when the substituted result merely fails the
property's grammar. Both readings render a perfectly plausible page, so this
is the rule least worth trusting to a hand-written test alone.

## The ceiling — do not read the corpus past it

1. **One engine, no second to arbitrate.** `test/fixtures/svg/` requires two
   engines to agree before writing a golden; that is not available here, as it
   was not for `zch2.2.2`.
2. **THE UA SHEET IS OUTSIDE THE CORPUS ENTIRELY.** It is hand-tested against
   HTML §15 in `test/cssua.test.ts` and the oracle says nothing about it. This
   is the largest untested surface `zch2.2.3` ships and the first thing to
   re-examine if `zch2.5` produces documents that look wrong in ways the unit
   tests do not explain.
3. **`getComputedStyle` returns USED values for layout-dependent
   properties.** A percentage `margin` or `padding`, and `width`/`height`,
   come back as resolved px — a different question from the computed value
   this module produces. The comparator returns "not compared" for those, and
   their computed-value rule is pinned by hand-written tests instead.
4. **A `border-width` whose `border-style` is `none` or `hidden` is
   excluded**, for the same reason and this is where it actually bit: Chrome
   reports the USED width, 0, while this module produces the computed one —
   the initial `medium`, 3px. The exclusion is driven off the element's own
   computed style rather than off the fixture, because it applies to every
   element a fixture does not give a border to, which is most of them.
   Where a fixture DOES declare a style, the width is compared normally.
5. **`ex` and `ch` are excluded.** Chrome has font metrics; we use CSS's
   documented 0.5em fallback, so agreement would be a coincidence and
   disagreement is not a defect.
6. **`smaller` and `larger` are excluded.** Browsers approximate the scaling
   factor differently and the spec does not pin one.
7. **Division by zero is a DELIBERATE DIVERGENCE, and it is out of the
   corpus rather than allowlisted inside it.** CSS Values 3 made `calc(10px /
   0)` invalid; Values 4 §10.9 makes it infinity and clamps it at §10.12, and
   Chrome follows Values 4 — measured, it computes `margin-top: calc(10px /
   0)` to **33554432px** (2^25). We refuse instead: an infinite length reaches
   `stamp.ts`, which throws on a non-finite rect, and matching Chrome would
   mean adopting the clamp as well for an expression no document means. A
   refused declaration falls back to the initial or inherited value, which
   renders. The oracle FOUND this — the first generated run failed on exactly
   that one comparison — and the case was then removed from
   `calc-invalid` so this corpus keeps running whole with no allowlist. The
   divergence is pinned by name in `test/csscalc.test.ts`.
8. **Custom properties themselves are not compared.** Chrome exposes them
   through `getComputedStyle().getPropertyValue('--x')` — measured — but this
   stack does not store one on `ComputedStyle`, since the environment dies
   with the compute walk. So there is no value on our side to compare, and
   what the corpus anchors is their EFFECT. The comparator names `--*`
   explicitly rather than letting it fall through `KEY_OF`, so the exclusion
   is a decision rather than the silent `ok: true` that `isComparedProp`
   exists to catch.
9. **`line-height: normal` is excluded**, on both sides, for the same
   metrics reason — and it is reached constantly, since every element a
   fixture does not style has it. What IS compared is the
   number-versus-percentage distinction, and the corpus catches that
   properly: a numeric line-height inherited by a child with a different font
   size yields a different px than a percentage one, so the two halves of
   `line-height-number-vs-percentage` disagree under a build that conflates
   them.

## On the harness

The comparators parse BOTH sides into the value domain rather than formatting
ours into Chrome's spellings. Writing a CSS serializer to compare text would
put a second implementation between the two, where its bugs could cancel
Chrome's out.

Two tests guard the harness itself, and both were earned rather than
anticipated:

- **A tampered golden must fail.** The tamper has to be FAR from the real
  value: the colour tolerance is 0.02 of a 0..1 component, so `rgb(1, 2, 3)`
  against black passes — 3/255 is 0.012. A tamper too small to fail is no
  evidence at all, and the first version of this test used exactly that.
- **Every property a fixture names must have a comparator row.** Asked of the
  `KEY_OF` map directly, not through a call: a missing row returns `ok: true`
  silently, which is the bug worth catching, and asking through a call would
  conflate it with a deliberate value-dependent exclusion like
  `line-height: normal`.

## Regenerating

Only when the grammar or the fixture set grows. Re-run the command above and
update the table. If a comparison then fails, it is REAL — fix `src/`, never
the goldens. The one legitimate reason to change a fixture is a property this
issue's scope deliberately excludes; remove it from that case's `props`,
regenerate, and record the reason here rather than deleting it silently.

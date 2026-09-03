# css-parsing-tests — provenance

The conformance corpus for CSS Syntax Level 3, here to validate
`src/csstoken.ts` and `src/cssparse.ts` against expectations this repo did not
author. See `docs/superpowers/specs/2026-08-27-css-syntax-design.md`.

**Source:** <https://github.com/CourtBouillon/css-parsing-tests> (BSD-3-Clause,
vendored as `LICENSE`). Downloaded verbatim, not regenerated.

**Commit:** `203ce36bffd617db7f118c551e32794561fb273d` (2025-09-24).

| File | Bytes | Cases | SHA-256 |
|---|---|---|---|
| `blocks_contents.json` | 2063 | 13 | `340c0397813fa100a2a02fb3de2126003a0fe3e678cc9ff9509246e9729efa9c` |
| `component_value_list.json` | 14886 | 50 | `a8d7a5252373b892cfcac359360930ad9a57ed918a84331bcf0c872b80f83200` |
| `declaration_list.json` | 1198 | 10 | `5d9e4680f64e9a92d9e668d1bc0a69168ab9bb8c6d392de8222b90e9dd88f052` |
| `one_component_value.json` | 657 | 10 | `34b568c084c48b26c13e991e297be6d71ce3793395335f43f85d665e0c15cac9` |
| `one_declaration.json` | 1363 | 21 | `5360083bfba780c54c2f129080816a87cc68ea0c6ba0de930ba6bbcf85064dd6` |
| `one_rule.json` | 1030 | 14 | `88f7b1b6049be88e1e2827673b75fc9261986b216e8ee6bf09621fecbe274e3c` |
| `rule_list.json` | 1342 | 15 | `7a0629ff8747c7837211c2f645a71f32ee69a5ee058ccc4e206d835cd128e55f` |
| `stylesheet.json` | 1341 | 16 | `7292c367370a7ccd4ff47f5c067d692f1ad665340cc7ec4754ea8c3681763794` |

149 cases across 8 files, every one run, with no allowlist and no bucket
predicate. The per-suite counts are asserted in
`test/css-parsing-suite.test.ts`, so a corpus update reddens the build rather
than quietly changing what this issue tests.

## Shape

Each file is a **flat array of alternating input and expected value**, not an
array of pairs. A loader that reads it as pairs finds half the cases and a
trailing `undefined`, which looks like a corpus problem rather than a reader
bug.

## What is deliberately NOT vendored

**`An+B.json`** (128 cases) is the `:nth-child()` microsyntax — Selectors, not
Syntax. It belongs to `zch2.2.2`, and only if that issue implements
`:nth-child` at all.

**The eight `color_*.json` files** (~400 KB) are CSS Color 4/5. Colour is not
part of Syntax 3: `#aaa` tokenizes as a hash token and `rgb(0,0,0)` as a
function token, and turning either into a colour is `zch2.2.3`'s job. A PDF
needs sRGB.

## THE SPEC ERA, and it is a decision

This corpus is pinned to the **2014-era** CSS Syntax 3 and still tokenizes
seven things the current editor's draft removed from the tokenizer:
`unicode-range`, the five match tokens (`~=` `|=` `^=` `$=` `*=`) and the
column token (`||`). **Eleven of the 149 cases turn on it** — all in
`component_value_list.json`, cases 38 through 48.

`src/csstoken.ts` implements the CORPUS's era, deliberately:

- It keeps the corpus running whole, with no bucket and no asserted
  exclusions, which is the strongest fence available here.
- `zch2.9` already records this repo following a pinned oracle against a newer
  spec, for HTML processing instructions, for exactly this reason.
- It helps `zch2.2.2`: `[href^="x"]` arrives as one `^=` token rather than two
  delims a selector parser would have to rejoin.

The cost is seven token types the live spec does not have, invisible to a
cascade. **Do not "fix" this toward the current draft** — two mutations below
exist to make that reddening immediate.

## The README is incomplete, and the data is authoritative

Two places where following the README alone produces a wrong implementation.
Both were found by checking the prose against the data before any code was
written:

- It documents **five** error kinds; the data uses **nine**. `eof-in-string`,
  `eof-in-url`, `empty`, `invalid` and `extra-input` are all absent from the
  prose. The full set is `bad-string`, `bad-url`, `eof-in-string`,
  `eof-in-url`, `)`, `]`, `empty`, `invalid`, `extra-input`.
- It says a `<dimension>` is "an array of length 4" and then lists five
  elements. The data shows five: `["dimension", "0", 0, "integer", "red"]`.

## Mutation results
Eleven mutations, each run against `test/css-parsing.test.ts`,
`test/csstoken.test.ts`, `test/cssparse.test.ts` and
`test/css-parsing-suite.test.ts` (187 assertions, all green at baseline) and
then reverted. OBSERVED counts, not predictions.

| # | Mutation | Failures | Where |
|---|---|---|---|
| 1 | A number's `int` flag always `true` | 10 | `component_value_list` 8, `one_component_value` 1, unit 1 |
| 2 | A number's `repr` replaced by `String(value)` | 14 | `component_value_list` 12, `one_component_value` 1, unit 1 |
| 3 | `bad-string` emitted as `string` | 6 | `component_value_list` 5, unit 1 |
| 4 | `bad-url` emitted as `url` | 3 | `component_value_list` 2, unit 1 |
| 5 | `url(` tokenized as a function token | 9 | `component_value_list` 6, unit 3 |
| 6 | CDO/CDC not dropped at stylesheet top level | 4 | `stylesheet` 3, unit 1 |
| 7 | An at-rule's absent block emitted as `[]` rather than `null` | 11 | `stylesheet` 3, `rule_list` 3, `one_rule` 2, `declaration_list` 1, `blocks_contents` 1, unit 1 |
| 8 | Escape handling removed from name consumption | 11 | `component_value_list` 10, unit 1 |
| 9 | The match tokens emitted as two delims (the current draft's reading) | 3 | `component_value_list` 2, unit 1 |
| 10 | `unicode-range` emitted as ident + dimension (the current draft's reading) | 10 | `component_value_list` 9, unit 1 |
| 11 | Negative zero not normalised | **4** | `component_value_list` 4, **unit 0** |

**Every mutation reddened something, and the design predicted the opposite.**
It said "with 149 cases rather than thousands, expect more empty results than
`zch2.1` produced" — `zch2.1` produced four empty results across four issues
and this produced none. A small corpus turns out to be a dense one: 50 of the
149 cases are `component_value_list`, and each packs dozens of tokens into a
single input, so almost any tokenizer rule is touched by several.

**Mutations 9 and 10 exist to guard the SPEC-ERA decision** recorded above,
and they work: reading the current editor's draft instead of the corpus's era
reddens 3 and 10 cases respectively. A future reader who "fixes" this toward
the live draft finds out immediately.

**Mutation 11 is the only rule with no hand-built cover** — 4 corpus cases and
0 unit tests. It is also the subtlest thing in this issue: `Number('-0')` is
`-0`, the corpus expects `+0`, and `JSON.stringify` renders both as `"0"`, so
a diff of serialized output shows nothing while a deep-equality assertion uses
`Object.is` and fails. Those four were the only failures during implementation
whose cause a JSON diff could not explain.

## What the corpus caught that the plan did not name

Five, of which three were invisible to a diff of serialized output:

1. **EOF inside a string or url emits the salvaged value AND THEN the error**,
   rather than replacing the value with it — `'eof` is `["string","eof"]`
   followed by `eof-in-string`. The hand-built test in
   `test/csstoken.test.ts` asserted the opposite and the corpus corrected it,
   which is exactly the risk the plan flagged for transcribed expectations.
2. **A trailing backslash is a valid escape.** The rule is "a backslash whose
   next code point is not a newline", and EOF is not a newline, so it yields
   U+FFFD *inside* the name rather than ending the name and leaving a delim.
3. **U+007F is in the non-printable set** that turns a url into a `bad-url` —
   and it is invisible in every view of the corpus, because `JSON.stringify`
   escapes control points below U+0020 and leaves DEL raw. `url(<DEL>)` reads
   on screen as the perfectly valid `url()`.
4. **Negative zero**, as above.
5. **A declaration's value keeps its trailing whitespace**: `foo: ` is `[" "]`
   rather than `[]`.

And one structural finding: **`parseBlocksContents` is not
`parseDeclarationList` under another name.** A run beginning with an ident may
be either a declaration or a qualified rule — `a:hover { }` opens exactly like
a declaration — and a qualified rule ENDS at its block, so `a b{c:d}e:f` is a
rule followed by a declaration. The choice is made from the delimited run
rather than by rewinding the cursor, because rewinding re-consumes past the
`;` that ended the run and loses everything after it.

## A note on running these mutations

Two of the eleven silently failed to apply on the first attempt, because the
shell mangled the backslashes in their search strings and the replacement
matched nothing — reporting a clean pass that meant only that the code had not
changed. The runner used here (`scratchpad/mutate.cjs`) therefore asserts that
its needle is present and throws when it is not. A mutation harness that
cannot fail loudly is worse than no harness.

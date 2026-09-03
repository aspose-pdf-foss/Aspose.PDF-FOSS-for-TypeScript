# CSS syntax: the tokenizer and the component-value parser — design

Issue: `zch2.2.1`, under `zch2.2`, under epic `zch2` (HTML to PDF conversion,
`gap-vs-java`).
Date: 2026-08-27.

`zch2.1` closed with the HTML parser complete for non-scripted content and
`parseHtml` public. This is the first piece of the CSS half: CSS Syntax
Level 3's tokenizer and its component-value parser. Nothing here understands a
selector, a property, or a colour.

Every number below is measured against the vendored corpus or read from the
spec. That practice caught a wrong claim in three of the four `zch2.1` designs
and none in the fourth.

## Why `zch2.2` was decomposed

The issue as filed bundled CSS syntax, selector matching, specificity, the
cascade, inheritance, shorthand expansion, computed values and a UA
stylesheet. That is larger than `zch2.1` was, and it splits cleanly at a line
that matters more than size:

| Piece | Issue | Oracle |
|---|---|---|
| Syntax: tokenizer + component-value parser | `zch2.2.1` — this document | **vendored** |
| Selectors: parse, match, specificity | `zch2.2.2` | hand-built only |
| The cascade, inheritance, shorthands, computed values | `zch2.2.3` | hand-built only |

**Only the first has a data-driven corpus.** CourtBouillon's
`css-parsing-tests` is JSON-driven and exact. For selectors and the cascade,
WPT ships reftests and `testharness.js` tests — both need a renderer or a
JavaScript engine, and neither can be run here. Splitting on that line keeps
the anchored work from lending its credibility to the unanchored work, and
gives each its own provenance record.

## Scope

**In:** all of CSS Syntax Level 3 — the tokenizer (§4) and the parser entry
points (§5) over the component-value model. 149 vendored cases, run whole.

**Out, and tracked:** selectors (`zch2.2.2`); the cascade, inheritance,
shorthands and computed values (`zch2.2.3`); colour, which is not part of
Syntax 3 at all (see below).

**Out, and corrected from the issue text:** collecting `<style>` element text
and `style=` attribute text. The issue as filed put it here; it is a walk over
`HtmlElement`, so it would make these modules import `htmldom.js` and destroy
"string in, structure out". Moved to `zch2.2.3`, which is its only consumer.
Both issues have been updated.

Nothing here produces PDF, and nothing here is exported from `index.ts`.

## Modules

Two pure leaves, mirroring `htmltoken.ts` against `htmltree.ts`.

- **`src/csstoken.ts`** — §4. `tokenize(css: string): CssToken[]`. **Thirty-one**
  token types plus EOF: ident, function, at-keyword, hash, string,
  bad-string, url, bad-url, delim, number, percentage, dimension,
  whitespace, CDO, CDC, colon, semicolon, comma, the six bracket types, and
  the seven the corpus's era still tokenizes — `unicode-range`, the match
  tokens `~=`, `|=`, `^=`, `$=`, `*=`, and the column token `||`. See
  **The two spec eras** below; that last group is a decision, not an
  oversight. Knows nothing of blocks, rules or declarations.
- **`src/cssparse.ts`** — §5. The parser entry points, over tokens. Never
  looks at a character.

**Invariant: the seam is real, not decorative.** The tokenizer is a pure
`string → CssToken[]` function and the parser never re-reads the source text.
The corpus cuts in the same place: `component_value_list.json` exercises the
token and block model while the other files exercise parser entry points, so
a failure lands on one side or the other rather than in between.

**Invariant: neither throws.** Syntax 3 defines a recovery for everything —
including the two failure modes it gives their own token types, `bad-string`
and `bad-url`. This is `htmltoken.ts`'s and `markdown.ts`'s rule and the
opposite of `parseXml`, which throws `PdfParseError`.

**Invariant: both are pure leaves.** No `Document`, no PDF object, no `node:`
import, and no `htmldom.js` — which is what the scope correction above
protects.

## The oracle

**Source:** `github.com/CourtBouillon/css-parsing-tests`, pinned at
`203ce36bffd617db7f118c551e32794561fb273d` (2025-09-24). Vendored to
`test/fixtures/css-parsing/`, a new directory, because this repo names fixture
directories for who produced the bytes.

Each file is a flat JSON array of alternating input and expected value. Eight
files, **149 cases**, measured:

| File | Cases | What it pins |
|---|---|---|
| `component_value_list.json` | 50 | the token and block model |
| `one_declaration.json` | 21 | a single declaration, `!important` |
| `stylesheet.json` | 16 | top-level rules, CDO/CDC |
| `rule_list.json` | 15 | at-rules, prelude versus block |
| `one_rule.json` | 14 | a single rule |
| `blocks_contents.json` | 13 | declarations and rules interleaved |
| `declaration_list.json` | 10 | a declaration list |
| `one_component_value.json` | 10 | a single component value |

**`An+B.json` is deliberately not vendored here.** Its 128 cases are the
`:nth-child()` microsyntax, which is Selectors rather than Syntax — it belongs
to `zch2.2.2`, and only if that issue implements `:nth-child` at all.

**The colour files are deliberately not vendored at all.** `color_lab_4`,
`color_oklch_4` and their six siblings are roughly 400 KB of CSS Color 4/5.
Colour is not part of Syntax 3: `#aaa` tokenizes as a hash token and
`rgb(0,0,0)` as a function token, and turning either into a colour is CSS
Color's job, so `zch2.2.3`'s. A PDF needs sRGB.

**Recorded plainly: 149 is a small corpus.** The tokenizer had 7,032 cases and
tree construction 1,936. This is a real anchor for the token and block model
and it is not, by itself, proof the parser is correct. The spec is small
enough that a literal transcription is tractable, which is the other half of
why the anchor is worth having.

### The two spec eras, and which one we implement

**Found while writing the implementation plan, not during implementation,
which is the only reason it is cheap.** The corpus is pinned to the 2014-era
CSS Syntax 3 and still tokenizes seven things the current editor's draft has
removed from the tokenizer:

| Token | Corpus era | Current spec |
|---|---|---|
| `unicode-range` | one token, `["unicode-range", start, end]` | parsed at the value level |
| `~=` `\|=` `^=` `$=` `*=` | one match token each | two delims |
| `\|\|` | one column token | two delims |

**Eleven of the 149 cases turn on it**, all in `component_value_list.json`,
cases 38 through 48.

**We implement the CORPUS's era.** Three reasons, in order of weight:

1. It keeps the corpus running whole — no bucket, no allowlist, no asserted
   counts — which is the strongest fence available here and the whole reason
   full implementation was chosen over a subset.
2. This repo already has the precedent and it points the same way: `zch2.9`
   records `htmltoken.ts` following its pinned html5lib oracle against a newer
   WPT expectation, for exactly the "the corpora are pinned to different spec
   eras" reason.
3. It *helps* `zch2.2.2`. An attribute selector `[href^="x"]` arrives as
   `'[' ident ^= string ']'` rather than `'[' ident ^ = string ']'`, so the
   selector parser has nothing to rejoin.

The cost is seven token types the live spec does not have, and that cost is
invisible to a cascade — no declaration value a PDF can render distinguishes
them. Recorded in `PROVENANCE.md` and `CLAUDE.md` as a decision so the next
reader does not "fix" it toward the current draft and redden 11 cases.

### The serializer, and the pattern it reuses

The corpus expects a JSON S-expression: a dimension is
`["dimension", "2em", 2, "integer", "em"]`, whitespace is the bare string
`" "`, a block is `["{}", …contents]`.

**We do not shape our types to match it.** Idiomatic TypeScript types, plus a
**test-only serializer** in `test/helpers/css-parsing.ts` that renders them to
the corpus's JSON — the `serializeTree`/`serializeFragment` pattern, used
twice already. Written from the corpus's README rather than from whatever our
types make convenient, because a serializer bent to fit the types hides bugs
in those types, and verified by reproducing a vendored expectation before the
parser exists to produce one.

Nothing in `src/` may import it.

## Three things the corpus will make us get right

Each is silent when wrong and each is pinned exactly by the JSON.

**A number carries a TYPE FLAG beside its value.** `["number", "1.0", 1,
"number"]` and `["number", "1", 1, "integer"]` differ in the flag alone —
their numeric values are equal. Dropping it is invisible until something
distinguishes `1` from `1.0`, and the representation string is carried too, so
`+1` and `1` stay distinguishable.

**`url(` and `url (` are different tokens.** The first is a url-token whose
value runs to the closing paren with no quoting; the second is an ident
followed by a function token. A tokenizer that treats `url` as a name
everywhere produces a plausible tree that is wrong for every unquoted URL.

**`bad-string` and `bad-url` end differently.** A bad string ends at the
newline that broke it; a bad url consumes to the closing paren. Collapsing
either into its good form, or into a generic error, changes what the rest of
the stylesheet parses as — and Syntax 3 gives them token types precisely so
recovery is defined rather than improvised.

## Testing

Vendored corpus, **no allowlist and no bucket predicate** — the whole of
Syntax 3 is implemented, so every case runs. That is the same footing
`zch2.1.1`'s 7,032 tokenizer cases stand on, and the reason this issue chose
full implementation over a subset: a partial parser still has to decide what
to do with what it does not understand, which is the harder problem, and it
would need a second bucket vocabulary to describe the gap.

Hand-built cases for the serializer, verified against a vendored expectation
before the parser exists.

### Mutations, named before the code

| Mutation | Expected to redden |
|---|---|
| The number type flag always `integer` | the `1.0` cases in `component_value_list` |
| The number representation string dropped | the `+1` / `01` cases |
| `bad-string` collapsed to `string` | the unterminated-string cases |
| `bad-url` collapsed to `url` | the unterminated-url cases |
| `url(` treated as a function token | every unquoted-url case |
| CDO/CDC tokens dropped | `stylesheet.json`'s top-level cases |
| An at-rule's prelude and block merged | `rule_list.json`, `one_rule.json` |
| Escape handling removed from ident consumption | scattered — record the count |
| The match tokens emitted as two delims (the current spec's reading) | `component_value_list` 47, 48 |
| `unicode-range` emitted as ident + dimension (the current spec's reading) | `component_value_list` 38–46 |

A mutation that reddens nothing is recorded as an uncovered gap rather than
left to be discovered. `zch2.1` produced four such results across its four
issues; with 149 cases rather than thousands, expect more here.

## The honest note this work carries forward

This is the only piece of `zch2.2` with an oracle. When `zch2.2.2` and
`zch2.2.3` land, their suites will be hand-built — our tests agreeing with our
code — and that must not be read as conformance the way this issue's green
legitimately can be. The distinction goes in `CLAUDE.md` beside the modules,
not only in a provenance file, because the next reader will see three CSS
modules and one fixture directory and will otherwise assume the anchor covers
all three.

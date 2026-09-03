# HTML5 tokenizer — design

Issue: `zch2.1.1`, under `zch2.1` (HTML5 tokenizer and tree construction),
under epic `zch2` (HTML to PDF conversion, `gap-vs-java`).
Date: 2026-08-26.

`zch2` is the largest functional gap against Aspose.PDF FOSS for Java. The epic
notes we are better positioned than it looks: `flow.ts` and `flowplace.ts`
already paginate across columns with floats and keep-with-next, and `mdflow.ts`
already lowers a parsed document to `FlowElement[]`. An HTML mapper is a *third*
producer for machinery that exists. What does not exist is an HTML5 parser, a
CSS cascade and a box model.

This is the design for the first piece of the first of those: the tokenizer.

## Two findings that shape everything

**`xml.ts` offers nothing to build on.** The issue text says to work "over
`xml.ts`'s scanning primitives". There are none. `parseXml` is a single
closure-based recursive descent whose helpers (`readName`, `skipMisc`,
`parseElement`) are local consts closing over one `i`, and every rule it holds
is the opposite of what HTML5 needs: it throws `PdfParseError` on a mismatched
end tag where HTML5 recovers, it demands quoted attribute values where HTML5
takes bare and unquoted ones, it strips namespace prefixes where HTML5's foreign
content depends on them, and it has one content model where HTML5 has six.
`xml.ts` stays untouched. This is recorded because "reuse `xml.ts`" is the
obvious reading of the issue and it is wrong.

**`mdscan.ts`'s HTML grammar is a different grammar.** `scanHtmlTag` is
CommonMark 0.31.2's tag production, it returns only an end index, and it
produces no tag name and no attributes — it answers "is there a tag here", which
is not the question a tokenizer asks. It also *rejects* inputs HTML5 accepts, on
purpose: an attribute must be preceded by whitespace, an unterminated tag is not
a tag. Both properties are load-bearing for CommonMark and fatal here. It stays
untouched too, and `mdscan.ts`'s one-scanner invariant is not violated: these
are two grammars that share a name, the same relationship `tablegrid.ts` (span
inference from ruling lines) has with `tablespan.ts` (declared spans), and the
same one `svgpattern.ts` has with `tiling.ts`.

## What is actually shared: the entity table

`src/mdentity.ts` is generated from `https://html.spec.whatwg.org/entities.json`
and holds **2125** named references. The source file holds **2231**. The
generator drops the difference on purpose:

> CommonMark recognises only the semicolon-terminated spelling. entities.json
> keys look like `"&copy;"` and `"&copy"`; keep the former, strip the framing.

The difference is the **106 legacy semicolon-less keys**, and they are already on
disk in the generator's cache.

**What they are is not what it first looks like, and the distinction is the
whole design of this part.** Measured against `entities.json`: every one of the
106 legacy names is *also* a semicolon-terminated key, and the two spellings
carry byte-identical values in all 106 cases. So the legacy set is **not a wider
name table** — `namedEntity` already resolves every name HTML5 can match. It is
the set of names *permitted to match without a trailing semicolon*.

That makes the addition a **predicate**, not a second map:

```ts
export function namedEntity(name: string): string | undefined;   // unchanged
export function allowsMissingSemicolon(name: string): boolean;   // the 106
export const MAX_ENTITY_NAME: number;                            // 31
```

Reading it as a second value table would have duplicated 106 entries to say
nothing, and — worse — would have hidden the actual rule behind a lookup that
appears to succeed for every name.

**Invariant: one owner for the HTML5 named character references.** One table,
one accessor for its values, one predicate for the spelling rule. Two tables is
how a document comes to render `&copy` one way in a Markdown code span and
another in an HTML attribute. `test/commonmark-spec.test.ts`'s 652 cases are the
fence that the CommonMark half did not move.

## The invariant that governs the module

**The tokenizer never throws.** Every string is a valid HTML document: the spec
mandates a recovery for every parse error by construction, so there is no input
for which "refuse" is the defined answer. This is `markdown.ts`'s rule, and it
is the exact opposite of `parseXml`, which throws `PdfParseError` and lives one
directory away. Recorded loudly because the contrast otherwise reads as an
oversight and gets "fixed".

Parse errors are **reported values**, never control flow:

```ts
export interface HtmlParseError { code: string; line: number; col: number; }
```

`code` is the spec's own kebab-case name (`eof-in-tag`,
`unexpected-null-character`, `missing-semicolon-after-character-reference`), not
a paraphrase, so a failing html5lib case names the spec section that governs it.

## Structure: a literal transcription

A `TokenizerState` enum with one branch per spec state, **named exactly as the
spec names them** — `ScriptDataDoubleEscapedDashDash`, not a shortened
paraphrase — driven by a dispatch loop consuming one code point at a time.
Roughly 80 states.

Two alternatives were considered and rejected. A **hybrid** with bulk `indexOf`
fast paths in Data/RCDATA/RAWTEXT buys throughput this workload does not need;
if a real document ever justifies it, it is a later and *measured* change, and
the Data state is the only one likely to repay it. A **regex-driven scanner** is
much faster to write and abandons the one property that makes conformance
debugging tractable.

The decisive argument for the literal form is the decision to assert parse-error
**positions**. Once a failing html5lib case is one column off, a paraphrased
state machine is nearly undiagnosable, while a literal one can be diffed against
the spec text state by state. This is the repo's established habit for published
algorithms: `jbig2*.ts` against ITU-T T.88, `svgfilterlight.ts` and
`svgfilternoise.ts` against SVG 1.1's reference implementations, `mdblock.ts`
against CommonMark's Appendix A.

## Shape: a pull model with a steering seam

Tree construction *drives* the tokenizer — the RCDATA, RAWTEXT, script-data and
PLAINTEXT switches are set by which element was just opened (`<title>`,
`<style>`, `<textarea>`, `<script>`, `<plaintext>`), which the tokenizer cannot
know. So the tokenizer exposes:

```ts
next(): HtmlToken            // Doctype | StartTag | EndTag | Comment | Character | Eof
setState(s: TokenizerState): void
errors: HtmlParseError[]
```

A pull model rather than a callback stream, because `zch2.1.2` needs to change
state *between* two tokens and, in the adoption-agency and foster-parenting
paths, to reason about one token at a time. It is also what lets the tokenizer
be tested standalone against html5lib's tokenizer suite with no tree at all,
which is the whole reason this is its own issue.

Behind `next()` sits a small output queue: several states emit more than one
token per step, and several reconsume the current code point in a new state.

**Appropriate-end-tag tracking is the tokenizer's own**, seeded from the last
start tag it emitted — the spec puts it there, and html5lib's `lastStartTag`
field exists to set it directly for a test that starts mid-stream.

**Invariant: `htmltoken.ts` is a pure leaf.** No `Document`, no PDF object, no
`node:` import. It takes a `string`. Character-encoding detection (the `<meta
charset>` prescan) is deliberately out of scope: every html5lib tree-construction
and tokenizer case is defined at the string level, and `AddHtml`'s callers pass
a string. A bytes entry point is a later decision, tracked separately.

## Four details that are silent when wrong

Each gets its own fixture, because each produces plausible output rather than a
failure.

**Preprocessing runs before tokenizing.** `\r\n` and a lone `\r` collapse to
`\n`, and that pass is also where the line/col counter is seeded. Wrong, every
position after the first `\r\n` is off by one while the token stream stays
perfect — so a suite asserting tokens alone cannot see it, which is precisely
why positions are being asserted.

**The named character reference state has an attribute rule**, and it is the
whole reason the legacy predicate is needed. In an attribute value a match not
ending in `;`, followed by `=` or an alphanumeric, must **not** be replaced — so
`href="?a=1&copy=2"` keeps its literal `&copy`. In text the same bytes resolve
to `©`. One table, two rules, decided by the return state.

**The numeric character reference end state carries the windows-1252 override
table** for 0x80–0x9F. Null, out-of-range and surrogate values become U+FFFD.
Skip the override and those code points become C1 controls, which draw nothing
and read as a missing glyph rather than as a decode fault.

**NULL handling is per-state, not global.** Some states replace U+0000 with
U+FFFD, some emit it unchanged, some emit an error and pass it through. A single
global replacement is the tempting simplification and it is wrong in both
directions.

## Anchoring

`html5lib-tests/tokenizer/*.test` is vendored into
`test/fixtures/html5lib/tokenizer/` with a `PROVENANCE.md` carrying the upstream
repository, the exact commit SHA, a per-file byte count and SHA-256, and what
the suite does and does **not** cover — the format
`test/fixtures/commonmark/PROVENANCE.md` and `test/fixtures/tiff/PROVENANCE.md`
already use.

The runner lives in `test/helpers/` and handles the suite's three wrinkles:

- **`doubleEscaped`** — input and expected output are `\uXXXX`-escaped twice and
  must be unescaped before comparison.
- **`initialStates`** — one input is run through up to six named starting
  states, so a case is several assertions.
- **`lastStartTag`** — sets the appropriate end tag for a case that begins
  inside RCDATA, RAWTEXT or script data.

Consecutive `Character` tokens are concatenated before comparison, which is what
the suite's expectations assume.

`xmlViolation.test` is excluded: it encodes an XML-compatibility output mode
this library does not implement. The exclusion is an **explicit list with a
reason each**, the way `test/commonmark-spec.test.ts`'s five-entry GFM
divergence list is — never a silent skip.

## Proving the assertions load-bearing

The repo's rule: a fixture usually passes on the first run, and that is not
evidence. These mutations are to be run and confirmed red, and the result
recorded:

| Mutation | Expected to redden |
|---|---|
| `allowsMissingSemicolon` always returns false | `namedEntities.test` alone |
| Delete the attribute-context rule in the named character reference state | only the legacy-entity-in-attribute cases |
| Drop `\r\n`/`\r` preprocessing | position assertions; every token assertion stays green |
| Drop the windows-1252 override | `numericEntities.test` alone |
| Replace U+0000 globally with U+FFFD | a subset of `test1`–`test4`; the entity suites stay green |

A mutation that reddens nothing means the fixture does not cover the rule, and
that gets recorded in `PROVENANCE.md` rather than left to be discovered — the
form `test/fixtures/fonts/PROVENANCE.md` already uses for the Type 1 paths its
one real font cannot reach.

## Scope

**In:** every tokenizer state, the named and numeric character reference states,
parse-error emission with line/col, the preprocessing pass, the steering seam.

**Out, and tracked elsewhere:** tree construction (`zch2.1.2`), foreign content
and `<template>` (`zch2.1.3`) — whose fixtures come from web-platform-tests
rather than html5lib-tests, which no longer carries them; see
`2026-08-26-html5-tree-construction-design.md`. Also out: character-encoding detection from bytes, and the
scripting flag — which is off, both because a print pipeline runs no script and
because whether document-supplied JavaScript should ever execute is an open
decision under `6t2v.2`.

Nothing here produces PDF.

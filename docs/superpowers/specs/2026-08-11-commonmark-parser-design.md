# CommonMark block and inline parser

Design for `aspose-pdf-foss-for-ts-gl6o.1`, the first child of the `gl6o` epic
(Markdown to PDF authoring).

## Problem

The Go library has `markdown.go`, `markdown_ast.go` and the `markdown_parse_*`
set, passing all 652 official CommonMark cases. TypeScript has no counterpart:
`src/` contains no Markdown code at all.

Every other child of the epic depends on this one — `gl6o.2` extends the node
set with GFM constructs, `gl6o.3` renders the tree into [flow.ts](../../../src/flow.ts)
and onto a page, `gl6o.4` tags that rendering for PDF/UA. So this issue produces
**no PDF**. It produces a tree, and the guarantee that the tree is right.

## Scope

In scope: Markdown text → a CommonMark abstract syntax tree, conforming to
**CommonMark 0.31.2**, verified against all 652 cases of the official suite with
no allowlist.

Out of scope:

- **Rendering.** No Flow, no page, no PDF. That is `gl6o.3`.
- **GFM.** Tables, strikethrough, task lists and extended autolinks are
  `gl6o.2`. The architecture must not preclude them; it must not contain them.
- **Source positions.** No node carries a line/column span. Nothing in `.2`,
  `.3` or `.4` needs one, and threading positions touches every constructor.
  A deliberate omission, recorded so it is not read as an oversight.
- **An options argument.** `parseMarkdown(src)` takes one parameter. `gl6o.2`
  adds an optional second, which is not a breaking change.

## Architecture

### Two phases, not one

The spec's Appendix A describes the algorithm, and `cmark` and `commonmark.js`
both implement it: a **block phase** over lines, then an **inline phase** over
the raw text each leaf block accumulated.

Two approaches were considered and rejected. A **single-pass recursive descent**
parser is structurally wrong for this grammar: a paragraph becomes a setext
heading only when a later line says so, and lazy continuation lets a blockquote's
paragraph swallow a line that carries no `>`, so the meaning of a line is not
decidable when it is read. A **permissive regex-driven parser** in the `marked`
style is quick to write and has no route to 652/652 — its failures are the
subtle ones, in emphasis flanking and link nesting.

**Block phase.** Maintain a stack of open blocks. For each line: match it against
the already-open blocks from the outside in, try to open new containers with what
remains, then attach the rest to a leaf block, closing what the line did not
match. Tabs are handled as **column arithmetic**, not expanded to spaces — a tab
inside a code block survives, but one that straddles a list marker's content
column is partially consumed. Link reference definitions are harvested off the
front of a paragraph as it closes, into a map; they never become nodes.

**Inline phase.** Over each leaf's raw text: code spans bind before everything
else, then the spec's delimiter-stack algorithm for `*`/`_` emphasis and its
bracket stack for links and images, with backslash escapes, entity references,
autolinks and raw inline HTML.

### Modules

| File | Owns |
|---|---|
| `src/mdast.ts` | the node model and type guards — pure data, imports nothing |
| `src/mdscan.ts` | the lexical scanners **both** phases need |
| `src/mdblock.ts` | the block phase |
| `src/mdinline.ts` | the inline phase |
| `src/mdentity.ts` | generated: the HTML5 named entity table |
| `src/markdown.ts` | the `parseMarkdown` entry point |

`mdscan.ts` is its own module because the HTML tag grammar is genuinely shared:
the block phase needs it for HTML block conditions 1–7 and the inline phase needs
it for `HtmlInline`. Two copies of that grammar is the shape this codebase keeps
getting bitten by — the same reasoning that produced `glyphprogram.ts` and
`choiceopt.ts`. It also owns entity references, backslash escapes, and the link
destination/title grammar, which both a reference definition and an inline link
must read identically, and the **label normalization** a reference definition and
a reference link both key on: strip and collapse internal whitespace, then case
fold. `String.prototype.toLowerCase` is simple case mapping rather than full
folding, which differs on `ß`/`ẞ` and a handful of others; the suite is the
arbiter, and a small fold table joins `mdscan.ts` only if a case demands it.

**Invariant:** an HTML tag, an entity, an escape and a link destination each have
exactly one scanner. A reference definition's destination and an inline link's
destination that disagree is a bug no HTML rendering reveals — both sides emit
the same `<a href>` for most inputs and differ only on the balanced-parenthesis
and pointy-bracket forms.

### The node model

```ts
export type MdBlock =
  | MdDocument | MdBlockQuote | MdList | MdItem
  | MdParagraph | MdHeading | MdThematicBreak | MdCodeBlock | MdHtmlBlock;

export type MdInline =
  | MdText | MdSoftBreak | MdHardBreak
  | MdEmph | MdStrong | MdCode | MdLink | MdImage | MdHtmlInline;
```

`MdList` carries `ordered`, `start`, `delimiter` and `tight`; `MdHeading` carries
`level` 1–6 for both the ATX and setext spellings; `MdCodeBlock` carries `fenced`
and the raw `info` string. `MdLink` and `MdImage` carry a resolved `destination`
and optional `title` — reference and inline links are indistinguishable in the
tree, which is what `gl6o.3` wants.

Exported from `index.ts` together with `parseMarkdown`, and documented in
`README.md`. It becomes public when `gl6o.3` lands regardless; shipping it now
costs one docs pass instead of two and lets the 652 cases pin its behaviour from
the start.

### Robustness

Markdown is untrusted text by definition, and this codebase's parsers all carry
the rule that damaged input costs the bytes it touched and never the process.
Two hazards, both with CVE history in `cmark`:

- **Nesting depth.** `[[[[[…` and `>>>>>…` recurse. A hard cap of 1000 on
  container and bracket nesting, past which the construct is emitted as literal
  text rather than rejected — the file is not damaged, it is merely absurd. No
  spec case nests past ten.
- **Quadratic emphasis.** The delimiter-stack algorithm degrades to O(n²) on
  adversarial `*a*a*a*…` without the spec's `openers_bottom` bookkeeping. The
  bound is part of the algorithm rather than a guard bolted on top; the test
  asserts it holds.

Line endings normalize on entry (`\r\n`, `\r` and `\n` all become `\n`) and NUL
becomes U+FFFD, as the spec requires.

### Data

**Unicode punctuation.** The emphasis flanking rules classify the characters
either side of a delimiter run. CommonMark 0.31.2 defines a Unicode punctuation
character as general category Pc, Pd, Pe, Pf, Pi, Po, Ps **or** Sc, Sk, Sm, So —
symbols were folded in at 0.31.0, so an implementation written against 0.30 gets
flanking wrong around `$`, `+` and `©`. Unicode whitespace is Zs plus tab, LF, FF
and CR.

`unicodePunctuation(cp)` therefore joins [unicode-data.ts](../../../src/unicode-data.ts)
via `scripts/gen-ucd.mjs`, parsed from the `UnicodeData.txt` that generator
already downloads. One generator owns every UCD-derived table, and regeneration
is pinned to Unicode 16.0.0 — the committed `BidiCharacterTest.txt` and
`LineBreakTest.txt` conformance suites are what prove the rest of the file did
not drift.

**HTML entities.** A new `scripts/gen-entities.mjs` emits `src/mdentity.ts` from
the WHATWG `entities.json`. Three details the table must respect:

- Only the **semicolon-terminated** forms. CommonMark recognises `&nbsp;` and
  leaves `&nbsp` as literal text; `entities.json` lists both.
- A value may be **two code points** (`&NotEqualTilde;` is U+2242 U+0338), so the
  table maps to a string, not to a scalar.
- Numeric references (`&#35;`, `&#X22;`) are handled by `mdscan.ts`, not the
  table. Zero, out-of-range and unpaired-surrogate values become U+FFFD.

Entity decoding is **not** test-only machinery: `&copy;` in a Markdown source has
to reach the PDF as ©, so this table is load-bearing for `gl6o.3`.

## Testing

**`test/fixtures/commonmark/spec.json`** — the official suite, CommonMark
0.31.2, 652 examples, vendored with a `PROVENANCE.md` recording the source URL,
the SHA-256, and what the suite does and does not cover. It belongs with the
other third-party conformance data (`fixtures/unicode/`) rather than with the
programmatic builders, because it catches the one class a builder cannot: our
parser and our own expectations agreeing with each other and both disagreeing
with CommonMark.

**`test/helpers/md-html.ts`** — an HTML renderer over the AST. Test-only, and
existing for one reason: the suite's expectations are HTML, so conformance
cannot be measured without one. It is a conformance oracle, not a feature, and
nothing in `src/` imports it.

**`test/commonmark-spec.test.ts`** — all 652 cases, no allowlist. A shortfall is
a red build, not a skipped case.

**`test/markdown-ast.test.ts`** — what an HTML oracle cannot see and `gl6o.3`
depends on:

- list **tightness**, which drives paragraph spacing in Flow
- an ordered list's `start` and delimiter
- a code block's `info` string, unescaped and untruncated
- link versus image, and a reference link resolving to the same
  `destination`/`title` as its inline equivalent
- heading `level` identical for the ATX and setext spellings

An HTML oracle can be perfectly green while the tree is wrong in exactly these
ways, because the rendering collapses the distinctions the renderer needs.

**`test/markdown-pathological.test.ts`** — the depth cap and the emphasis bound,
time-bounded, over adversarial inputs.

**Load-bearing, not merely green.** The 652 cases will pass on the first full run
once the algorithm is right, and that is not evidence of anything. Each AST and
robustness assertion is confirmed by breaking its path: drop `openers_bottom`,
drop the S\* categories from the punctuation class, treat a tab as three spaces,
resolve a reference definition without case folding, and let the depth cap
recurse.

## Files

| File | Change |
|---|---|
| `src/mdast.ts` | new — node model and type guards |
| `src/mdscan.ts` | new — shared HTML/entity/escape/destination scanners |
| `src/mdblock.ts` | new — block phase |
| `src/mdinline.ts` | new — inline phase |
| `src/mdentity.ts` | new, generated — HTML5 named entities |
| `src/markdown.ts` | new — `parseMarkdown` |
| `src/unicode-data.ts` | regenerated with `unicodePunctuation` |
| `scripts/gen-ucd.mjs` | emit the P\*/S\* punctuation table |
| `scripts/gen-entities.mjs` | new — emit `src/mdentity.ts` |
| `src/index.ts` | export `parseMarkdown` and the node types |
| `test/fixtures/commonmark/` | new — `spec.json` + `PROVENANCE.md` |
| `test/helpers/md-html.ts` | new — the HTML conformance oracle |
| `test/commonmark-spec.test.ts` | new |
| `test/markdown-ast.test.ts` | new |
| `test/markdown-pathological.test.ts` | new |
| `package.json` | `gen:entities` script |
| `README.md` | Markdown parsing in Features and the API overview |
| `CLAUDE.md` | the module map entry and the one-scanner invariant |

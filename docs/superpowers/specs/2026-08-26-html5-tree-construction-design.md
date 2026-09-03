# HTML5 tree construction — design

Issue: `zch2.1.2`, under `zch2.1`, under epic `zch2` (HTML to PDF conversion,
`gap-vs-java`).
Date: 2026-08-26.

> **Correction, added when the work landed.** This design was written against
> an older reading of §13.2.6 and two of its claims are wrong. The HTML Standard
> has REMOVED the "in select" and "in select in table" insertion modes, so there
> are **20** non-template modes rather than 22; and there are **four** scopes,
> not five — "select scope" is gone and `select` has moved into the DEFAULT
> scope's terminator list, which is a reversal, since select scope was inverted.
> Seventeen vendored cases fail against the older reading. Two exclusions also
> widened: the processing-instruction bucket is 86 rather than 79 (an
> unterminated `<?` leaves no PI node in the expected tree at all), and four
> `<selectedcontent>` cases are excluded because their expected tree holds text
> the ELEMENT clones in, not the parser. In scope is **1,317**, not 1,328. The
> measured record is `test/fixtures/wpt/PROVENANCE.md`; the rest of this
> document stands.

`zch2.1.1` landed the tokenizer: a literal transcription of the WHATWG state
machine, 7,032 html5lib cases green. This is the half that turns its token
stream into a node tree — insertion modes, the stack of open elements, the
active formatting elements, the adoption agency algorithm, foster parenting.

Foreign content (SVG/MathML), `<template>` and fragment parsing are `zch2.1.3`
and are out of scope here.

## The finding that changed the plan: the fixtures moved

The issue text, `zch2.1.3`'s text, and
`test/fixtures/html5lib/PROVENANCE.md` all say tree construction is anchored by
`html5lib-tests/tree-construction/*.dat`. **That directory no longer exists.**
html5lib-tests' own README says why:

> The HTML parser tree construction tests are now solely maintained on
> web-platform-tests:
> https://github.com/web-platform-tests/wpt/tree/master/html/syntax/parsing

The tests are alive and actively maintained at the new home — 62 `.dat` files,
471 KB, last touched 2026-08-21 — in the same format and with the same lineage.
So the anchoring plan survives; only the upstream changes. All three stale
claims are corrected as part of this work.

**They are vendored into `test/fixtures/wpt/tree-construction/`, a new
directory rather than a subdirectory of the existing `html5lib/`.** This repo
names fixture directories by *who produced the bytes* — `commonmark/`, `gfm/`,
`tiff/`, `pdfx/`, `bmp/` — and filing a second upstream under a name that means
"html5lib" defeats exactly what the provenance table exists to record. The
tokenizer's `PROVENANCE.md` gains a corrected cross-reference rather than a new
subdirectory.

## Scope, measured

Surveyed across all 62 files: **1,936 cases**, splitting as

| Bucket | Cases | Where |
|---|---|---|
| Fragment (`#document-fragment`) | 196 | `zch2.1.3` |
| Scripted (`#script-on`, `scripted_*.dat`) | 14 | excluded — the scripting flag is off |
| Foreign content and `<template>` | 319 | `zch2.1.3` |
| Processing instructions | 79 | excluded — see below (`zch2.9`) |
| **In scope here** | **1,328** | this issue |

**The loader classifies exactly, and the five bucket counts are asserted**, so a
case that migrates between buckets — because upstream edited it — reddens the
build rather than quietly leaving this issue testing less than it did.

## The two vendored oracles disagree, and we follow ours

Found while sizing the corpus, not during implementation, which is the only
reason it is cheap. WPT's `processing-instructions.dat` expects
`<body><?something>` to produce a real **ProcessingInstruction node** and **no
parse error**:

```
| <html>
|   <head>
|   <body>
|     <?something ?>
```

Our tokenizer produces a bogus **comment** plus
`unexpected-question-mark-instead-of-tag-name` — and it is right to, because
that is exactly what `html5lib-tests/tokenizer` expects, at the commit we pin,
which is also that repository's master. `zch2.1.1` passes 100% of it.

So a spec change for HTML processing instructions landed between the tokenizer
suite's last update (2026-06-26) and WPT's (July 2026). html5lib-tests now
maintains **only** tokenizer tests, so its expectations are plausibly stale —
but they are the oracle `htmltoken.ts` was built and verified against, and no
single implementation can satisfy both corpora today.

**The 79 in-scope cases whose expected tree names a PI node are excluded** — 76
in `processing-instructions.dat`, 2 in `tests1.dat`, 1 in `html5test-com.dat` —
by a predicate over the expected tree, not by file name: `processing-
instructions.dat`'s other ~45 cases expect comments and are kept.

Deferred rather than resolved because a processing instruction **draws nothing
in a PDF**, so the rendering cost of waiting is zero, while implementing it now
would redden tokenizer cases that currently pass. Tracked as `zch2.9`, which
records what to check and what to change if the spec has indeed moved.

**Invariant: the split is computed, never a hand-maintained file list.** A list
is a second place for the truth to live, and it drifts silently in the direction
of testing less.

## The decision on errors, which reverses `zch2.1.1`'s

The `.dat` format carries two error sections:

```
#errors
(1,0): expected-doctype-but-got-chars                    <- html5lib's own names
#new-errors
(1:7) unexpected-character-in-unquoted-attribute-value   <- the spec's codes
```

**Only `#document` is asserted. Both error sections are ignored.**

`zch2.1.1` asserts parse errors with positions, so this reads as an
inconsistency and is not one. `#errors` uses a vocabulary html5lib
invented — `expected-doctype-but-got-chars` appears nowhere in the HTML
Standard — and `htmltoken.ts` already guarantees that an error code is "the
spec's own kebab-case name, verbatim. Never paraphrased." Asserting `#errors`
would mean maintaining a **second, non-spec error vocabulary** beside the first,
and the two would eventually disagree about the same document.

`#new-errors` *is* spec-coded, but it is sparse (13 of 112 cases in
`tests1.dat`, absent from many files) and consists mostly of errors the
tokenizer already emits and `zch2.1.1` already asserts — so it largely re-tests
that issue through a second path.

The tree is the whole observable contract for a renderer. The exclusion is
recorded in `PROVENANCE.md` with this reasoning, the way the GFM five-case
divergence list already is — never a silent skip.

## Modules

Three, where the issue text named two.

- **`htmldom.ts`** — the node model: element, text, comment, doctype, document.
  **Mutable, with parent pointers**, deliberately not an immutable AST like
  `mdast.ts`: the adoption agency algorithm relocates live nodes, and `zch2.2`'s
  selector matching needs ancestor and sibling traversal.
- **`htmlstack.ts`** — the stack of open elements and the list of active
  formatting elements: the scope predicates (element / list item / button /
  table / select scope), the Noah's Ark clause, reconstruction, the markers.
  **Its own module because these are pure list algorithms**, testable from
  hand-built lists with no parser and no document — the split `floatstack.ts`
  makes against `floatbox.ts` and `tablespan.ts` against `tableauthor.ts`.
- **`htmltree.ts`** — the 22 insertion modes that drive them (all but "in
  template"), the adoption agency, foster parenting, implied end tags, and
  "reset the insertion mode appropriately".

**Invariant: all three are pure leaves.** No `Document`, no PDF object, no
`node:` import — the rule `htmltoken.ts` and `htmlcharref.ts` already follow.

**Invariant: `htmlstack.ts` does not import `htmltree.ts`.** The stacks are
operated *by* the insertion modes and know nothing about them, which is what
keeps every scope predicate assertable from a hand-built element list.

## Nothing is exported

`parseHtml` is **not** added to `src/index.ts` here, reversing an earlier
statement that it would arrive with this issue. Without foreign content an
inline `<svg>` subtree parses into the HTML namespace and yields a tree that is
wrong *silently* — and nothing needs the export before `zch2.4`, so shipping it
early buys nothing and ships a quiet wrong answer. It is exported with
`zch2.1.3`, which closes that gap.

The tokenizer set the same precedent one issue ago and for the same reason.

## The tokenizer seam

Already built. Tree construction calls `setState` for the generic RAWTEXT and
RCDATA element algorithms (`<title>`, `<textarea>` to RCDATA; `<style>`,
`<script>`, `<noframes>`, `<iframe>`, `<xmp>` to RAWTEXT or script data;
`<plaintext>` to PLAINTEXT), saving the **original insertion mode** and
switching to Text.

**Invariant: "original insertion mode" is ONE variable, not a stack.** The spec
says so, and a stack is the natural mistake — it behaves identically until a
document nests the constructs in a way that exposes it.

**Note:** the newline that a `<pre>`, `<listing>` or `<textarea>` start tag
swallows is *tree construction's* job, not the tokenizer's. The tokenizer
already emits that character normally.

## Seven rules that yield a plausible tree when wrong

Each gets its own fixture, because none of them fails loudly.

**The adoption agency's bookmark and element clone** (§13.2.6.4.7). Wrong, the
tree is merely mis-nested and still renders. `adoption01.dat`, `adoption02.dat`
and `tricky01.dat` exist for this, which is why the algorithm has a name rather
than being "handle misnested tags".

**Foster parenting inserts BEFORE the table**, never into it. Wrong, stray
content lands inside the table and still displays.

**Reconstruct the active formatting elements runs before inserting text.** Miss
it and formatting silently stops at the boundary where it should re-open.

**"Any other end tag" in body** walks the stack from the top and pops *through*
the matching node. A naive pop-until-match differs only on mis-nested input,
which is exactly the input this whole algorithm exists for.

**`generate implied end tags` and `...thoroughly`** exclude different tags, per
call site. One used for both is a subtle difference in what survives a `</p>`.

**"In table text"** buffers character tokens and re-processes them: whitespace
stays where it is, anything else triggers foster parenting.

**The scope predicates are five different lists**, not one. `has an element in
button scope` is what decides whether `<p>` auto-closes; using plain scope there
changes a very common document shape.

## Testing

`test/helpers/` gains two pieces.

**A `.dat` reader.** The format is line-oriented, and the case boundary is *a
blank line immediately followed by `#data`* — not any blank line, since `#data`
payloads legitimately contain them, and not a `#`-prefixed line, since payloads
contain those too. Sections run to the next `#`-directive line. The final case
has no trailing blank line.

**A tree serializer producing html5lib's `| ` format exactly** — `| `, then two
spaces per depth, text in double quotes, `<!-- comment -->`, `<!DOCTYPE name>`,
attributes each on their own line. **It is written from the format description,
not from whatever our DOM makes convenient**, because a serializer bent to fit
our tree can hide a bug in that tree. It is the oracle's other half.

### Proving the assertions load-bearing

Named up front, run and recorded in `PROVENANCE.md`:

| Mutation | Expected to redden |
|---|---|
| The adoption agency neutered to a plain pop | `adoption01`, `adoption02`, `tricky01`, and little else |
| Foster parenting inserts into the table | `tables01` and the table cases in `tests*` |
| Reconstruction skipped before text insertion | the formatting cases in `tests1`/`tests2` |
| `button scope` replaced by plain scope | the `<p>` auto-close cases |
| "Original insertion mode" made a stack | expected: NOTHING — recorded as uncovered if so |
| Implied end tags: the "thoroughly" variant used everywhere | the `</p>` and table-cell cases |

A mutation that reddens nothing means the corpus does not cover that rule, and
that gets written down rather than left to be discovered — the form
`test/fixtures/fonts/PROVENANCE.md` already uses.

## Scope

**In:** the 22 non-template insertion modes, the stacks and their scope
predicates, active formatting elements, the adoption agency, foster parenting,
implied end tags, reset-the-insertion-mode, the tokenizer seam, and 1,328
vendored cases green.

**Out, and tracked:** foreign content, `<template>` and fragment parsing
(`zch2.1.3`); processing instructions (`zch2.9`); the scripting flag (off, and
`6t2v.2` decides whether it ever turns on); character-encoding detection from
bytes (`zch2.8`); the public `parseHtml` export (`zch2.1.3`).

Nothing here produces PDF.

# PDF to Markdown — lists, code blocks, quotes and heading inference

Design for `aspose-pdf-foss-for-ts-no93.2`, the second child of the
`PDF to Markdown export` epic (`no93`), depending on `no93.1`, which shipped
`docmodel.ts` and the `Document.ToMarkdown` / `Page.ToMarkdown` serializer over
it.

## Problem

`no93.1` deliberately stopped at headings, paragraphs, tables and figures. Its
spec records the rest as siblings, and this is the one that closes three of the
gaps at once:

- **Lists.** `/L`, `/LI`, `/Lbl` and `/LBody` reach the serializer as unknown
  container types and flatten to their text, which is visible but no longer a
  list — and the label flattens with it, so an exported bullet item reads
  `• item`, then acquires a second bullet the moment anything re-renders it.
- **Code blocks.** A `/P` > `/Code` flattens to a paragraph. Its indentation is
  carried in U+00A0 (see below), so the paragraph is also littered with
  non-breaking spaces.
- **Quotes.** A `/BlockQuote` flattens to bare paragraphs, losing the quoting
  entirely. Not named in the issue title, but it is the fourth construct our own
  `AddMarkdown` writes and no other sibling of `no93` has a reason to restore it.

None of the four has an untagged path at all: a PDF from a producer that never
tagged anything yields paragraphs, whatever it looks like on the page.

The issue's remaining third, heading *inference*, is largely shipped —
`headingRanks` ranks every line by font size on the untagged path and `/H1`–`/H6`
drive the tagged one. What is missing is a heading that a producer set at body
size and distinguished some other way, which is most headings in most real
documents.

## Approach

Everything the two directions disagree about is decided once, in the builder, and
the serializers consume the decision. Concretely:

- `docmodel.ts` grows three node kinds and folds the tagged shapes into them;
- a new `src/docinfer.ts` holds the untagged heuristics as pure functions over
  `TextLine[]`;
- `mdexport.ts` and `htmlsemantic.ts` each gain a serialization rule per
  construct and no analysis of their own.

Two alternatives were considered and rejected:

- **Interpret in `mdexport.ts` only**, leaving `docmodel.ts`'s generic containers
  alone. Smallest diff and no risk to `ToHtml` — but the ordered-vs-bullet,
  nesting and code-run decisions would then be re-derived by HTML, DOCX (`8yt9`)
  and EPUB (`zwto`) in turn. That is the four-walk problem `no93.1` was written to
  prevent, arriving one issue later.
- **Everything inside `docmodel.ts`.** Identical output, one file fewer. Rejected
  because it roughly triples that module and buries the heuristics behind a
  `Document`: every bullet-character, nesting-tolerance and heading-evidence test
  would have to build a PDF to reach code that needs none. The split is the one
  `floatstack.ts` and `booklet.ts` already make — the arithmetic that is silently
  wrong when reversed belongs where it can be tested without a file.

## Scope

In scope:

- `src/docmodel.ts` — `DocList`, `DocListItem`, `DocCode`; the tagged mapping for
  `/L`, `/LI`, `/Lbl`, `/LBody`, `/Code` and `/BlockQuote`; the untagged
  classification pass.
- `src/docinfer.ts` (new) — marker detection, nesting depth, code-line detection,
  and the three new heading signals.
- `src/mdexport.ts` — list, code, quote serialization.
- `src/htmlsemantic.ts` — the same four constructs.
- `README.md`, `CLAUDE.md`.

Out of scope, each already a named sibling: table refinement (`no93.3`), link
destinations (`no93.4`), image deduplication and file output (`no93.5`).

Out of scope with no sibling: a thematic break. `Flow`'s `rule` draws a vector
line as an artifact with no structure element, so there is nothing to recover
from and no heuristic worth the false positives a page border would produce.

## The vocabulary

Three additions, and no more:

```ts
interface DocList     { kind: 'list'; ordered: boolean; start?: number; items: DocListItem[] }
interface DocListItem { kind: 'listItem'; blocks: DocNode[]; checked?: boolean }
interface DocCode     { kind: 'code'; text: string }
```

`/BlockQuote` gets **no** new kind: it is already a PDF standard structure type,
and the model's rule is that it speaks those. A new kind is earned only where the
model must carry a decision that is not a structure type, which `ordered`,
`start` and `checked` are and quoting is not.

`DocCode.text` is the code, newline-separated, unescaped and unfenced —
serializer concerns, exactly as `DocText.text` is unescaped today.

## The tagged mapping

- `/L` → `DocList`, its `/LI` kids becoming `items`. A non-`/LI` kid of an `/L`
  stays a sibling block rather than vanishing, under the transparency rule
  `no93.1` established.
- `/LI` → `DocListItem` whose `blocks` are its `/LBody`'s children. A nested `/L`
  under an `/LBody` is a block like any other — the same non-special-casing
  `mdflow.ts` uses in the opposite direction — so nesting composes with no depth
  parameter anywhere in the builder or either serializer.
- `/Code` → `DocCode`. A `/P` whose only child is a `/Code` collapses to the
  `DocCode`: that wrapper exists because `/Code` is inline level and needs a
  block-level element around it (32000-1 §14.8.4.3), and it carries no content of
  its own.
- `/BlockQuote` → an ordinary `DocContainer`, already produced today; only the
  serializers change.

**Invariant:** a marker is *evidence*, never content. `/Lbl` is read for what it
proves and then dropped, in the builder, and each serializer re-derives its own
marker from `ordered` / `start` / `checked`. Keeping the label as content is how
an export comes to read `• • item`, and it is the shape the current flattening
already produces.

What the `/Lbl` proves, in order of authority:

1. `/L`'s `/ListNumbering` attribute, via `StructElement.ListAttributes`, when the
   producer set one. `Disc`/`Circle`/`Square`/`None` are unordered; the five numbering
   values are ordered.
2. Otherwise the `/Lbl` text: `1.`, `(3)`, `iv.`, `b)` are ordered; `•◦▪‣·–—-*+`
   are bullets; `☐` and `☑` set `checked` to false and true.

Our own authoring never writes `/ListNumbering` — `flow.ts` appends a bare `/L` —
so rule 2 is the one that runs on documents this library produced, and rule 1
exists for documents it did not. A bullet `/Lbl` carries its glyph as
`/ActualText` (`flow.ts` draws the bullet as vector geometry), which `docmodel.ts`
already surfaces as the element's text, so both rules read the same way.

`start` is the first item's parsed ordinal, recorded only when it is not 1.

**Invariant:** U+00A0 maps back to U+0020 in `DocCode.text`. That substitution is
`preformat`'s, made because `layoutRuns` collapses runs of spaces and a code
block's indentation would not survive; undoing it here is what makes indentation
survive the round trip. It is confined to code, where the character is provably a
substitution rather than an author's choice.

## Untagged inference — `src/docinfer.ts`

Pure functions over `TextLine[]` and `TextFragment`, importing the positioned
types from `text.ts` and nothing else. No `Document`, no PDF objects, no I/O.

### What the pass sees

Classification runs over the lines of one `TextBlock` — the grouping
`GetStructuredText` already produced and `blockNodes` already walks — plus two
page-level measurements passed in, so the module needs no document:

- **column width**: the widest line on the page, ignoring lines inside a table
  region, which `untaggedModel` already excludes;
- **dominant leading**: the median baseline-to-baseline distance between
  consecutive lines on the page.

A block's first line takes its gap-above from the previous block's last baseline,
and the first block on a page counts as having a gap. Runs that cross a block
boundary are reunited by the adjacent-list merge below rather than by widening
what a single pass sees.

### Markers

A line opens an item when its text begins with a bullet (`•◦▪‣·–—-*+`), a task box
(`☐☑`), or an ordinal (`1.` `(3)` `iv.` `b)`) followed by a space. The module
reports the marker kind, the parsed ordinal, the index where content begins, and
the page-space x of the first content glyph — the item's own body indent.

**Invariant:** a marked line forms a list only with corroboration — an adjacent
marked line, or a continuation line indented to its body x. Without it,
`1990. It was a good year` is a list. A genuinely single-item list is therefore
missed; that is precision bought at the cost of recall, recorded as a limitation
rather than papered over.

### Nesting

Depth comes from the marker's x, bucketed at a tolerance of
`max(3pt, 0.5 × dominant font size)`, the depth being the bucket's rank among the
buckets in the same contiguous list run. An unmarked line whose x matches the open
item's body x is a continuation of that item, not a new block.

Two adjacent `DocList`s of the same ordered-ness merge, so a list that the block
grouper split on loose spacing comes back as one list.

### Code

A line is a code line when **every** fragment's `/BaseFont`, subset prefix
stripped, matches `Courier|Mono`. Consecutive code lines merge into one
`DocCode`.

Indentation is recovered from the text alone — the U+00A0 mapping above — and
never reconstructed from x offsets. A producer that positions each indented line
instead of writing spaces loses its indentation on export. That is a documented
limitation: reconstructing it means dividing an x offset by an assumed space
advance, which is a guess that fails silently on a proportional-but-monospace-named
face.

### Heading signals

Three signals, all on by default, all applying **only** to a line at body size —
a size-derived rank from `headingRanks` always wins — and all requiring the same
corroboration:

- the line is short: under 60% of the page's column width;
- it has a gap above of at least 1.2× the page's dominant leading;
- it is **followed by body text at the same left edge**.

On top of that shared corroboration:

- **bold** — every fragment's font name matches `Bold|Black|Heavy|Semibold|Demi`;
- **caps** — every cased letter is uppercase, with at least two letters present;
- **short and isolated** on its own — additionally refuses a line ending in `.`
  or `,`.

A promoted line's level is one below the smallest size-derived rank, capped at
H6; in a document with no size-derived headings at all it is H1. A line inside a
list run or a code run is never promoted.

**The "followed by body text" clause is load-bearing for a shipped test**, not
decoration. `test/html-identity.test.ts`'s ruled-card fixture contains
`Card heading` — short, isolated, body size, with nothing after it. Without the
clause the bare short-isolated signal promotes it, and a snapshot with nothing to
do with this work moves. This is the concrete reason the corroboration is shared
by all three signals rather than attached to the weakest one.

## Serialization

### Markdown

| Construct | Output |
|---|---|
| bullet item | `- ` |
| ordered item | `N. `, counting from `start ?? 1` |
| task item | `- [ ] ` / `- [x] ` |
| code block | backtick fence, no info string |
| quote | `> ` on every line |

An item's first block shares the marker's line; every subsequent line and block is
indented by the marker's own width, which is what puts a nested list inside its
parent item rather than beside it. Items are separated by a blank line only when
one of them holds more than one block **that is not a nested list** — that is how
our own parser reads the result back, so the tight/loose distinction survives the
round trip. The exclusion is what keeps a tight list with sub-items tight: a
nested list is a block, so counting it would make every nesting parent loose, and
a blank line between the items of the outer list is exactly what turns it loose
for the parser too.

**Invariant:** the fence is `max(3, longest backtick run in the text + 1)`
backticks. A fixed three-backtick fence lets a code block containing a fenced
example break out of itself, producing valid Markdown that says something else.
There is no info string, because a PDF records no language; inventing one from a
lexical guess would be a claim the document does not make.

Code text is emitted verbatim and never escaped — inside a fence there is nothing
to escape, and `escapeMarkdown` would fill it with backslashes.

A quote renders its children as blocks, then prefixes every line with `> `, blank
separator lines becoming `>`. Nesting composes into `> > ` with no special case.

Item body text still goes through `escapeMarkdown`, which already escapes a
line-leading `-`, `+`, `#`, `>` and `digit.`, so item text that looks like a
marker cannot open a list of its own.

### HTML

`<ul>` / `<ol start>` / `<li>`, `<pre><code>`, `<blockquote>`, and a task item's
state as `<input type="checkbox" disabled>` — a task's state is content rather
than a marker, the one place the marker-suppression rule does not apply.

This changes `ToHtml` output for documents containing these constructs, which
`no93.1` deliberately did not. It is the unavoidable cost of deciding once: the
model no longer carries an `/L` container for HTML to map to `<ul>`. No existing
snapshot covers a list, code block or quote — verified — so the change is
additive to the recorded suite and gets new snapshots of its own. Existing
snapshots must not move.

## Testing

`test/docinfer.test.ts` drives the heuristics from hand-built `TextLine`s, with no
PDF anywhere: bullets and ordinals, `1990. It was…` staying a paragraph, nesting
buckets at the tolerance boundary, monospace detection including a subset prefix,
and each heading signal with and without its corroboration.

`test/markdown-export.test.ts` gains tagged fixtures for a nested list, an ordered
list with a `start`, a task list, a code block and a quote.

The round-trip test grows a source exercising all of those — including a fence
containing backticks and indented lines — run **twice**, once through a tagged
flow and once through an untagged one, so the structure-tree path and the
inference path are held to the same output. Comparison stays on block structure
and text, as `no93.1` established, except for code, where the text is compared
exactly: indentation is the whole point of the construct.

`test/html-identity.test.ts` gains snapshots for the new constructs; its existing
snapshots not moving is the evidence the heading signals stayed contained.

Per CLAUDE.md each new path is broken and the suite confirmed red rather than
trusted on first-run green. Five mutations to run, because each produces entirely
plausible output:

1. keep the `/Lbl` as content — output reads `• • item`;
2. drop the U+00A0 → U+0020 mapping — indentation silently lost;
3. remove the "followed by body text" clause — the ruled-card snapshot moves;
4. remove list corroboration — a `1990.` paragraph becomes a list;
5. fix the fence at three backticks — a block containing a fence breaks out.

## Documentation

- `README.md` — `ToMarkdown`'s coverage extended to lists, code blocks and
  quotes, with the untagged-inference limitations stated (single-item lists,
  x-positioned code indentation).
- `CLAUDE.md` — a `docinfer.ts` entry beside `docmodel.ts`, carrying the
  marker-is-evidence, corroboration, U+00A0 and fence-length invariants.

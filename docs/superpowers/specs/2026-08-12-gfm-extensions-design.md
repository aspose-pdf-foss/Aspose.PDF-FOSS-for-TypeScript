# GFM extensions: tables, strikethrough, task lists, autolinks

Design for `aspose-pdf-foss-for-ts-gl6o.2`, the second child of the `gl6o` epic
(Markdown to PDF authoring). It builds on `gl6o.1`, the CommonMark 0.31.2 parser
in [markdown.ts](../../../src/markdown.ts) and its four supporting modules.

## Problem

`gl6o.1` shipped strict CommonMark. Every Markdown document written for GitHub —
which is most of them — uses constructs CommonMark does not define: pipe tables,
`~~strikethrough~~`, `- [x]` task lists, and bare `www.example.com` links. A
renderer (`gl6o.3`) fed the current tree drops all four on the floor as literal
text.

This issue produces **no PDF**. It extends the tree, and the guarantee that the
extension is right.

## Scope

In scope: all **five** extensions defined by the GitHub Flavored Markdown Spec —
tables, task list items, strikethrough, extended autolinks, and disallowed raw
HTML (`tagfilter`).

Out of scope:

- **Footnotes.** GitHub ships them; the spec document does not define them, so no
  conformance data exists to pin an implementation. A separate issue if the
  renderer ever wants them.
- **Rendering.** Still `gl6o.3`. Tagfilter is the one construct here whose spec
  definition *is* an output transform, and it is handled accordingly (below).
- **Source positions.** Unchanged from `gl6o.1`: no node carries a span.

### Opt-in, off by default

```ts
export interface MarkdownOptions { gfm?: boolean }
export function parseMarkdown(src: string, options?: MarkdownOptions): MdDocument
```

`gl6o.1` reserved this second parameter. One boolean turns on all five
extensions together; per-extension flags are four more option combinations to
test and document for a need nobody has stated.

Default **off**, so `parseMarkdown(src)` remains strict CommonMark 0.31.2 and the
652-case suite keeps pinning the *default* path with no argument. GFM genuinely
changes output — `~~x~~`, `www.foo.com` and `- [ ] x` all mean something else —
so this is a real choice, not a formality.

## Architecture

### Extensions live in their own modules

Three approaches were considered.

**Inline, behind `if (gfm)` in the two existing phase modules.** Least new code,
and rejected: `mdblock.ts` is already 795 lines and `mdinline.ts` 582, and the
652-case logic would end up interleaved with extension branches. `gl6o.1`'s
design asked for the opposite — "the architecture must not preclude them; it must
not contain them".

**A post-pass over the finished CommonMark tree.** Tempting, since it changes no
`gl6o.1` code, and wrong for two of the four parsing extensions. `~~` must share
the *same* delimiter stack as `*`/`_`, or `*a~~b*c~~` nests incorrectly. A
table's header row is a header only because the *next line* is a delimiter row —
by tree time the line structure is gone and the header has already been
inline-parsed.

**Chosen: extension logic in its own modules, reached from a few explicit hook
points.**

| File | Owns |
|---|---|
| `src/mdtable.ts` | the table block: delimiter-row scan, alignment, cell splitting, row construction |
| `src/mdgfm.ts` | the three inline extensions and the tag filter, as pure functions |

Both are pure — strings and data in, data out — so the table grammar and the
autolink trimming rules are testable without a document. The hooks in the phase
modules are small and guarded, and with `gfm` off none of them execute: the
CommonMark path stays byte-identical.

### The node model

```ts
export type MdAlign = 'left' | 'center' | 'right';
export interface MdTable     { type: 'table';      align: (MdAlign | null)[]; children: MdTableRow[] }
export interface MdTableRow  { type: 'table_row';  header: boolean; children: MdTableCell[] }
export interface MdTableCell { type: 'table_cell'; children: MdInline[] }
export interface MdStrikethrough { type: 'strikethrough'; children: MdInline[] }
```

`align` holds one entry per column, `null` where the delimiter row expressed
none — `gl6o.3` sets cell alignment from it, and a missing entry is not the same
as `'left'`, since a renderer may want its own default. `header` is what
`gl6o.4` needs to emit `/TH` with a `/Scope` rather than `/TD`.

Task lists add **one optional field**, `MdItem.checked?: boolean`: absent means
an ordinary list item, `false` is `[ ]`, `true` is `[x]` or `[X]`. A separate
node type would make every existing consumer of `MdItem` handle two shapes for
what is one item with an extra attribute.

Extended autolinks introduce **no node**. They produce an ordinary `MdLink`,
with `www.foo.com` normalized to `destination: 'http://www.foo.com'` as the spec
requires, so `gl6o.3` needs no second code path to emit a `/URI`.

`table`, `table_row` and `table_cell` join `BLOCK_TYPES`; `table` and
`table_row` join `CONTAINER_TYPES`, since their children are blocks, while
`table_cell` holds inlines like a paragraph does.

Every addition is additive: no existing field changes type or meaning, so code
written against `gl6o.1` keeps compiling.

### Tables

Confirmed against `cmark-gfm`'s `extensions/table.c` and the spec's own
examples, because three of these rules are not obvious from the prose:

- The header is the paragraph's **last** line. Earlier lines split off and remain
  a paragraph (`try_inserting_table_header_paragraph` upstream).
- A body line with no pipe at all is still a row. `bar` after a table becomes a
  single-cell row padded to width, not a paragraph — only a blank line or another
  block structure breaks the table.
- Body rows pad with empty cells when short and truncate when long, while the
  **header** row must match the delimiter row's cell count exactly or there is no
  table.

Alignment comes from a `:` at the start or end of each trimmed delimiter cell.
Cells split on unescaped `|` with optional leading and trailing pipes, and `\|`
becomes a literal `|` in the cell text. The split happens **before** inline
parsing, which is why a code span in a cell cannot contain a raw pipe.

**The hook.** One branch in `tryStart`, immediately after the setext-heading
branch, which is structurally the same move: the container is an open paragraph,
the current line is a delimiter row, the column counts agree, so `replaceChild`
swaps the paragraph for a `table`. `'table'` joins `ACCEPTS_LINES` so body rows
arrive through `addLine`, but is excluded from `incorporateLine`'s `matchedLeaf`
test the way a paragraph is, so a `# heading` on the next line still opens a
heading instead of becoming a row. `matchContinuation` closes the table on a
blank line. Cells stage their raw text exactly as paragraphs and headings do,
and the inline walk descends into them.

### Strikethrough

`~` joins `handleDelim` and rides the existing delimiter stack. A run of 1 or 2
may open or close under the same left/right-flanking test emphasis uses; opener
and closer must be the **same** length; a run of 3 or more is literal text. The
rules live in `mdgfm.ts`, the stack stays in `mdinline.ts`.

### Task list items

Block phase, at item finalize: if the item's first child is a paragraph whose
staged text begins with `[ ]`, `[x]` or `[X]` followed by whitespace, the marker
is stripped and `checked` set. Doing it here rather than during inline parsing
keeps the marker out of the tree entirely and leaves list tightness — which
`gl6o.3` reads — computed from the same lines as before.

### Extended autolinks

A post-pass over each leaf block's inline list, walking `text` nodes only and
never descending into a `link`. This is the one extension where a post-pass is
correct: code spans are already `MdCode` nodes and links already `MdLink`, so
the two contexts an autolink must not fire in are structurally excluded rather
than re-derived.

It covers the three schemes the spec names — `http://`, `https://`, `ftp://` —
plus the `www.` prefix, which gets `http://` inserted, and bare email addresses,
which get `mailto:`. It also accepts a literal `mailto:` or `xmpp:` before an
address, which the spec document does not define but `cmark-gfm` implements as
part of the *same* local-part scan: leaving them out does not leave them alone,
it leaves `mailto:` sitting outside the link as stray text. They are pinned by
hand rather than by example.

One divergence from `cmark-gfm` is accepted and recorded rather than hidden.
There, `www.` and the schemes are matched during inline parsing, where the
parser can still see that a bracket is open, so `[a www.b.com]` with no matching
reference stays plain text. A post-pass runs after the bracket stack is gone and
links it. Matching inline instead would break every text run in every document
on `w` and `:` to catch a construct this rare; no spec example covers it.

The fiddly half is where an autolink *stops*, and every rule here has an
example: trailing punctuation is trimmed, a closing `)` is kept only while the
parentheses balance, a trailing `&entity;` is excluded, a `<` ends the link
outright, the domain must contain a `.` and may not carry `_` in its last two
segments, and the preceding character decides whether an autolink may start at
all.

### Disallowed raw HTML

The spec defines this one as a transform applied "when rendering HTML output":
nine tags — `title`, `textarea`, `style`, `xmp`, `iframe`, `noembed`,
`noframes`, `script`, `plaintext` — get their leading `<` replaced by `&lt;`.

So it does **not** touch the tree. `mdgfm.ts` exports one pure function,
`filterDisallowedHtml(html: string): string`, and `MdHtmlBlock`/`MdHtmlInline`
keep their literal raw. Storing `&lt;script>` in the tree would push an HTML
encoding into a model whose only production consumer renders PDF, for the same
reason a link destination is stored unencoded and percent-encoding lives only in
the test oracle.

The oracle applies the filter when `gfm` is on, which is what makes the spec's
example pass. That leaves a `src/` function whose only in-repo caller is a test.
That is deliberate, and has precedent in `cmapcodec.ts`'s encoder, which "runs
only at build time and ships unused" to keep a format's two halves from
drifting: the function is public API, it is the right home for the tag list, and
the alternative is a second copy of that list living in `test/`.

## Testing

**`test/fixtures/gfm/spec.txt`** — the GFM spec, vendored from
`github/cmark-gfm` (`test/spec.txt`, version 0.29, dated 2019-04-06), with a
`PROVENANCE.md` recording the URL, the upstream commit, SHA-256
`7d8e5814befec287ac116786d81ff14e0adc9b13295b4494649e995408fd871c`, and — the
part that matters — that the file is a whole CommonMark **0.29** document with
the extension sections spliced in. We run **only** the five extension sections.
Running the rest against a 0.31.2 parser would need an allowlist for the
0.29-versus-0.31.2 divergences, and `gl6o.1` refused allowlists for a reason: a
shortfall must be a red build. The 652-case 0.31.2 suite already covers that
body of the file.

**`test/gfm-spec.test.ts`** — all **24** extension examples through the existing
`test/helpers/md-html.ts` oracle, no allowlist: Tables 8, Autolinks 11, Task
lists 2, Strikethrough 2, tagfilter 1.

**`test/gfm-ast.test.ts`** — what the HTML rendering collapses and what
`gl6o.3`/`gl6o.4` depend on:

- per-column `align`, including a column with none
- `header` true on the first row and false below it
- `checked` true, false, and absent on an ordinary item
- list tightness unchanged by the presence of a task marker
- `www.foo.com` yielding an `http://` destination
- a multi-line paragraph splitting so that only its last line becomes the header

**`test/commonmark-spec.test.ts`** — unchanged, still run with no options, still
652/652. A **second** run with `{ gfm: true }` asserts that the set of diverging
example numbers equals an explicit committed list with one reason per entry. GFM
claims to be a strict superset of CommonMark; this pins exactly what the
extensions change and catches behaviour leaking into constructs nobody thought
to look at.

**Load-bearing, not merely green.** 24 examples is thin cover, especially for
tables, so every assertion is confirmed by breaking its path and watching the
suite go red: swap the alignment `:` test, drop the pad-and-truncate rule, allow
`~` runs of three, drop strikethrough's same-length requirement, drop the
no-nested-link guard in the autolink pass, and let the tag filter through.

## Files

| File | Change |
|---|---|
| `src/mdtable.ts` | new — delimiter row, alignment, cell splitting, row construction |
| `src/mdgfm.ts` | new — strikethrough rules, task-list marker, extended autolinks, `filterDisallowedHtml` |
| `src/mdast.ts` | `MdTable`/`MdTableRow`/`MdTableCell`/`MdStrikethrough`, `MdItem.checked`, type sets |
| `src/mdblock.ts` | table hook in `tryStart`, `'table'` in `ACCEPTS_LINES`, task-list stripping at item finalize, options threading |
| `src/mdinline.ts` | `~` in the delimiter path, the autolink post-pass, inline parsing of table cells |
| `src/markdown.ts` | `MarkdownOptions` and the second parameter |
| `src/index.ts` | export the new node types, `MdAlign`, `MarkdownOptions`, `filterDisallowedHtml` |
| `test/fixtures/gfm/` | new — `spec.txt` + `PROVENANCE.md` |
| `test/gfm-spec.test.ts` | new — the 24 extension examples |
| `test/gfm-ast.test.ts` | new — what the oracle cannot see |
| `test/commonmark-spec.test.ts` | a second `{ gfm: true }` run with an asserted divergence list |
| `test/helpers/md-html.ts` | render tables, strikethrough and task checkboxes; apply the tag filter |
| `README.md` | GFM in Features and the API overview |
| `CLAUDE.md` | the two new modules and the invariants above |

# PDF to Markdown export — the document model

Design for `aspose-pdf-foss-for-ts-no93.1`, the first child of the
`PDF to Markdown export` epic (`no93`). The epic notes that Go has
`markdown_export.go` while TS has only `Table.toMarkdown()`, and that this child
"establishes the document-reconstruction model that DOCX and EPUB export both
build on" — `no93` blocks both `8yt9` (DOCX) and `zwto` (EPUB).

## Problem

The hard half of PDF→Markdown is already shipped, but it is shipped **as HTML**.
`htmlsemantic.ts` holds the entire document-reconstruction walk:

- the tagged path — a recursion over the structure tree honouring `/ActualText`,
  `/Lang`, `/Alt`, page filtering, tables via `tableFromStruct`, and composite
  figures resolved by MCID rather than by page position;
- the untagged path — `GetStructuredText` blocks with per-*line* heading ranking
  from `textrank.ts`, tables absorbed by centroid containment, then page images.

Every line of that is what Markdown needs, and none of it is reusable: the walk
and the HTML string-building are the same functions. A Markdown exporter written
against `GetStructuredText` directly would re-derive `centerInside`, the per-line
ranking, `pageMcidImages`, `figureImages`, `onPage` and the `/ActualText` rule —
a second walk that must agree with the first forever, and DOCX and EPUB would
make it four.

## Approach

Extract the walk into a neutral document model and make both exporters
serializers over it.

Two alternatives were considered and rejected:

- **Parallel `mdexport.ts`/`mdsemantic.ts` mirroring the HTML pair.** Fastest and
  risk-free for shipped HTML, but it is the duplicate walk described above.
- **Neutral model with Markdown as its only consumer**, leaving HTML untouched.
  Produces the model the epic asks for while still leaving two walks in the
  tree — the first option's problem with an extra module.

Rewriting `htmlsemantic.ts` as a serializer is the targeted improvement this work
earns. Its fence is byte-identity of HTML output; see **Testing**.

## Scope

In scope:

- `src/docmodel.ts` — the `DocNode` vocabulary and `buildDocModel`.
- `src/htmlsemantic.ts` rewritten as a serializer over `DocNode`.
- `src/mdexport.ts` — `MarkdownExportOptions`, the Markdown serializer, the escaper.
- `Document.ToMarkdown` / `Page.ToMarkdown`, exported `MarkdownExportOptions`.
- Paragraphs, headings (both paths), tables, figures — everything the existing
  machinery already yields.

Out of scope, each landing in a named sibling:

- **Nested lists and code blocks** — `no93.2`. `L`/`LI` reach the serializer as
  unknown containers and flatten to their text, so their content is visible
  rather than dropped.
- **Table refinement beyond `Table.toMarkdown()`** — `no93.3`.
- **Link destinations** — `no93.4`. A `Link` element renders as its text.
- **Image deduplication and file output** — `no93.5`.

Out of scope with no sibling:

- **`ToHtml` behaviour changes.** The refactor must not alter a byte. The `Link`
  element's missing `href` in `TAG_FOR` is a real HTML defect but fixing it here
  would break the fence; it belongs with `no93.4`.
- **Fixed-mode HTML** (`htmlfixed.ts`). It drives `pagerender.ts`, not the
  semantic walk, and is untouched.

## The node vocabulary

`DocNode` speaks **PDF standard structure types**, not HTML tags. That is what
keeps both serializers unprivileged, and it is why the untagged builder's output
is indistinguishable in shape from the tagged one — it emits `'H1'`…`'H6'` and
`'P'` containers, which is exactly what the tagged builder produces for the same
content.

```ts
type DocNode = DocContainer | DocText | DocTable | DocFigure;

interface DocContainer { kind: 'container'; type: string; lang?: string; children: DocNode[] }
interface DocText      { kind: 'text'; text: string }
interface DocTable     { kind: 'table'; table: Table }
interface DocFigure    { kind: 'figure'; alt: string; images: PdfStream[]; tagged: boolean }
```

Four kinds because `no93.1` has four things to say. `no93.2` adds `list`,
`listItem` and `code`; `no93.4` adds `link?: string` to `DocText`.

`DocText.text` is decoded and **unescaped** — escaping is a serializer concern,
and the two serializers escape differently. `DocTable` carries the `Table` model
object rather than markup, and `DocFigure` carries `PdfStream`s rather than
`data:` URIs, so `no93.5` can write files without re-deriving anything.

**Invariant:** page filtering and empty-node pruning live in the builder, never
in a serializer. Two serializers deciding independently whether a node is empty
is how the HTML and Markdown exports come to disagree about a document. The
rules are:

- a `DocText` whose `text` is `''` is dropped;
- a `DocContainer` left with no children after pruning is dropped;
- when a single page was asked for, a text leaf on another page never enters the
  model.

These are exactly equivalent to the current HTML code's `.filter((s) => s)` over
child strings and its `if (!inner) return ''` guard, including the case where
`/ActualText` is the empty string.

**Invariant:** `DocFigure.tagged` records provenance because the two paths
legitimately differ when an image cannot be encoded. A **tagged** `/Figure` still
emits `<img alt="…">` — the alt is the accessible content and dropping it would
tell assistive technology nothing was ever there. An **untagged** bare page image
emits nothing, because there is no alt and so nothing to announce. This
asymmetry is in the shipped code; without the flag the refactor erases it
silently, and no existing test covers an unencodable image.

## Module layout

- **`src/docmodel.ts`** (new) — the vocabulary above plus
  `buildDocModel(doc, pages): DocNode[]`. It owns the tagged-vs-untagged decision
  that currently sits in `html.ts`'s `bodyFor`, including the
  `only = pages.length === 1 && doc.Pages.length > 1` single-page rule (a tagged
  element crossing a page break must stay one element) and the `headingRanks(doc)`
  call.
- **`src/htmlsemantic.ts`** (rewritten) — `semanticBody(doc, nodes): string`.
  Keeps `TAG_FOR`, `escapeHtml`, `imageHref` and the alt-on-first-part-only rule
  for composite figures. Loses the walk, `centerInside`, `onPage`,
  `pageMcidImages` and `figureImages`, which move to `docmodel.ts`.
- **`src/mdexport.ts`** (new) — `MarkdownExportOptions`, `renderPageToMarkdown`,
  `renderDocumentToMarkdown`, the `DocNode`→Markdown serializer and the escaper.
- **`src/document.ts`**, **`src/page.ts`** — `ToMarkdown(options?)` beside
  `ToHtml`. **`src/index.ts`** — `export type { MarkdownExportOptions }`.
- **`src/html.ts`** — `bodyFor` becomes `semanticBody(doc, buildDocModel(doc, pages))`.
  Nothing else changes.

`mdexport.ts` is named for **direction**. The eleven existing `md*.ts` modules
(`markdown.ts`, `mdast.ts`, `mdblock.ts`, `mdinline.ts`, `mdscan.ts`,
`mdentity.ts`, `mdtable.ts`, `mdgfm.ts`, `mdstyle.ts`, `mdruns.ts`, `mdflow.ts`)
are all Markdown→PDF; this one is the reverse and shares no code with them. Same
hazard the `svgembed.ts`/`svgrender.ts` split carries, and it gets the same
treatment in CLAUDE.md.

## Markdown serialization

Output flavour is **GFM**: pipe tables, matching the `Table.toMarkdown()` already
shipped and the `{ gfm: true }` our own parser accepts. Strict CommonMark has no
table syntax, which would throw away `no93.3`'s entire deliverable.

Each structure type is block, inline, or transparent:

| Type | Treatment |
|---|---|
| `H1`–`H6` | block, `#`×N prefix |
| `P` | block |
| `Span`, `Link` | inline — concatenated into the enclosing block |
| `Document`, `Part`, `Sect`, `Div`, `Art`, `TOC`, `TOCI` | transparent |
| anything unknown | transparent |

Transparent means the children are emitted as sibling blocks. **Invariant:** an
unknown type is transparent, never dropped — visible content beats a silently
dropped subtree, the rule `svgdraw.ts` already sets, and it is what keeps
`no93.2`'s `L`/`LI` readable before that issue lands.

Blocks join with a blank line and the output ends with a newline. A `DocTable`
goes through `Table.toMarkdown()`. A `DocFigure` becomes one `![alt](uri)` per
image, with `imageHref` supplying a `data:` URI; a tagged figure with no
encodable image emits `![alt]()` rather than nothing, for the reason
`DocFigure.tagged` exists.

**Invariant:** `ToMarkdown` never throws, degrading to whatever was produced.
Same contract as `ToHtml` and `renderPageToSvg`.

`MarkdownExportOptions` ships with no members. It exists so the signature is
stable for `no93.4`'s link options and `no93.5`'s `images` option.

The name is **not** `MarkdownOptions`: that is the parser's option bag
(`markdown.ts`, `{ gfm }`), already exported from `index.ts` and already extended
by `mdflow.ts`'s `MarkdownFlowOptions`. The two would collide on export, and the
collision is the direction hazard in miniature — one name for the Markdown→PDF
input options and the PDF→Markdown output options.

### Escaping

The one piece of genuinely new logic. Rather than hand-writing a character list
and hoping, the escaper is specified by an oracle we own:

**Invariant:** escaping is correct when `parseMarkdown(ToMarkdown(doc))` yields
text equal to the text extracted from `doc`. Under-escaping turns a leading `#`
in body text into a heading and a `|` into a cell boundary; over-escaping litters
the output with backslashes. Both are visible against the parser, and neither is
visible against a hand-written list.

Escaping is nonetheless directional in one respect the oracle cannot see: a
character is escaped for the position it occupies. Line-leading `#`, `>`, `-`,
`+`, `=` and `digit.`/`digit)` are structural only at the start of a block; `` ` ``,
`*`, `_`, `[`, `]` and `|` are structural anywhere. The oracle catches a missing
case in either group, so the split is an implementation detail rather than a
second specification.

## Testing

**The fence goes in first.** `test/html-identity.test.ts` hashes semantic-mode
`ToHtml` output over the fixtures already built in `test/html.test.ts`, with the
hashes recorded from the **current** code before `htmlsemantic.ts` is touched.
This is the `test/rich-runs-identity.test.ts` pattern, and it is the whole
justification for rewriting a shipped exporter. If the refactor cannot be made
byte-identical, the approach is wrong and the work stops for re-design rather
than accepting a diff.

`test/markdown-export.test.ts` covers:

- tagged and untagged paths producing the same Markdown for one deliberately
  simple document — a heading and two paragraphs, where the font-size ranking and
  the structure tree have no room to disagree;
- heading levels from `headingRanks` (untagged) and from `/H1`…`/H6` (tagged);
- `/ActualText` replacing a subtree, `/Alt` on a figure;
- a table through `Table.toMarkdown()`, and a table's text not also appearing as
  prose;
- `Page.ToMarkdown` on a multi-page document emitting only that page;
- an unknown container type flattening rather than vanishing;
- the escaping oracle, on text containing `#`, `|`, `*`, `_`, `[`, `` ` `` and a
  leading digit-dot.

End-to-end, one test renders a Markdown source (headings, paragraphs, a table —
the constructs `no93.1` covers) through `AddMarkdown` into a **tagged** document
and back out through `ToMarkdown`. The comparison is on **block structure**, not
AST equality: heading levels and their text, paragraph text, table cell text. A
round trip through PDF is lossy by construction here — emphasis has no recovery
path until a sibling adds one, so the returned AST legitimately differs — and
asserting equality would fail for a reason that is not a defect. This still
exercises both directions of the Markdown stack against each other.

Per CLAUDE.md, each new path is broken and the suite confirmed red rather than
trusted on first-run green. Two specific mutations to run, because both produce
plausible output: dropping `DocFigure.tagged` (the untagged unencodable-image
case, which no existing test reaches), and making an unknown container drop
rather than flatten (which is invisible until a document has an `L` in it).

## Documentation

- `README.md` — `ToMarkdown` in the API overview beside `ToHtml`.
- `CLAUDE.md` — a `docmodel.ts` entry recording the one-walk invariant, and the
  `mdexport.ts` direction note against the eleven Markdown→PDF modules.

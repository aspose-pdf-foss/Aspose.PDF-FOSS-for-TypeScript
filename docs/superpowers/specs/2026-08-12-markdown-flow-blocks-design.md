# Map the Markdown AST onto Flow blocks

Design for `aspose-pdf-foss-for-ts-gl6o.3.2`, the second of three pieces of
`gl6o.3` (Render Markdown into Flow and directly onto a page), itself the third
child of the `gl6o` epic. It stands on `gl6o.3.1` (rich inline runs) and is
followed by `gl6o.3.3` (tables and links).

## Problem

`gl6o.1` and `gl6o.2` produce an `MdDocument` and nothing else — the parser was
shipped with rendering deliberately out of scope. `gl6o.3.1` then made the Flow
text engine carry mixed styles within one wrapped block. Nothing yet turns a
parsed tree into a page.

The gap is not only the walk. Flow's element vocabulary is missing three of
CommonMark's nine block types outright — there is no code block, no block quote
and no thematic break — and the two containers Markdown leans on hardest do not
nest the way Markdown nests. `FlowListItem.text` is a single body; a Markdown
item may hold several paragraphs, a code block or a quote, and a quote may hold
anything at all including another quote.

So this issue is two pieces of work that have to land together: the block
vocabulary Flow lacks, and the mapping onto it.

## Scope

In scope: the `MdDocument` → Flow mapping for paragraph, heading, list
(tight/loose, task items), image, code block, block quote and thematic break;
the three new Flow blocks as public API; a style vocabulary; and three entry
points — into a `Flow`, into a rect on a `Page`, and a whole-document
convenience on `Document`.

Out of scope, each for a stated reason:

- **Tables and links.** `gl6o.3.3`. A link's *text* renders here, styled, since
  dropping the words would lose content; only the `/URI` annotation waits. A
  table is skipped whole and named in the report.
- **Tagged-PDF conformance.** `gl6o.4`. Flow's existing `tagged: true` path
  keeps working and the new elements participate in it, but nothing here chases
  a PDF/UA rule set.
- **Syntax highlighting.** A fenced block's info string is parsed and carried by
  the AST and is not rendered. Highlighting needs a language grammar per
  language, which is a library, not a detail of this mapping.
- **Raw HTML.** `MdHtmlBlock` and `MdHtmlInline` are dropped and reported, as
  `mdast.ts` has recorded since `gl6o.1`. Rendering HTML means implementing a
  second document format.
- **Per-line leading.** Inherited from `gl6o.3.1`: the block's leading governs.
  Markdown's runs are their paragraph's size or smaller, so nothing here
  depends on it.

## Architecture

### Three layers

```
mdstyle.ts    the style vocabulary, its defaults, and font-family resolution
mdruns.ts     MdInline[] -> TextRun[]                   (pure; no Document)
mdflow.ts     MdBlock[]  -> FlowElement[]               (a Document only to embed images)
                     |
        +------------+------------+
   Flow.Render               flowplace.ts
   (columns, floats)         (one rect, returns the overflow)
        |                         |
Flow.AddMarkdown           Page.AddMarkdown           Document.AddMarkdown
```

The mapper's whole contract is

```ts
markdownElements(doc, src, options): { elements: FlowElement[]; skipped: string[] }
```

Both consumers take a `FlowElement[]`, which is what makes three entry points
cost one implementation. `mdflow.ts` knows nothing about columns, rects or
pagination; `mdruns.ts` and `mdstyle.ts` know nothing about PDF objects.

`src` is a `string` (parsed here, `MarkdownOptions` forwarded) or an already
parsed `MdDocument`, so a caller that wants to inspect or rewrite the tree
first is not forced to re-parse.

### The element-builder vocabulary

`flow.ts` already has `makeParagraph`, `makeList` and `makeImage`, each marked
test-only. They become the public builders `paragraph()`, `heading()`, `list()`
and `image()`, beside three new ones: `codeBlock()`, `rule()` and `quote()`.

Every `Flow.AddX` becomes `this.items.push(...builder(...))`. That is not
tidiness either: with three entry points and a mapper all constructing content,
one definition per construct is what stops `Flow.AddList` and
`Page.AddMarkdown` from disagreeing about what a list is.

A builder returns `FlowElement[]`, not one element, because `list()` and
`quote()` already lower to several — `makeList` returns an array today for
exactly this reason.

**Module split.** `flow.ts` is 1218 lines before this work. The three new
element classes and their options go in **`flowblock.ts`**. That would close a
cycle (`flow.ts` → `flowblock.ts` → `flow.ts` for the `FlowElement` protocol
and the shared validators), so the protocol —`FlowElement`, `PlaceContext`,
`MeasureContext`, `PlaceResult`, `FlowClear` — and the shared `nonNegative` /
`normalizeSpacing` / `normalizeClear` helpers move to **`flowelement.ts`**,
which imports nothing from either. This is the split `fieldstyle.ts` and
`bordersides.ts` already made for the same reason. `flow.ts` re-exports every
moved name, so no existing import path changes and no consumer notices.

### Nesting: flatten, never contain

**Invariant:** a container element never holds and paginates its children. The
Flow engine is a flat queue and a container that paginated its own children
would be a second copy of `Render`'s loop — which is how a quote comes to break
across a column under one rule and a list under another.

A container instead lowers to a flat `FlowElement[]` in which each child is
wrapped by a decorator owning two things: an *indent*, and *its own ink*.

- **`quote(blocks, style)`** wraps each child in a `QuotedElement`. It shifts
  `ctx.x` by the indent, shrinks `ctx.width`, delegates `place` and `measure`
  to the inner element, and after a successful draw paints its bar rect over
  its own band. A quote split across a column boundary needs no special case:
  each element paints its bar wherever it lands. Nested quotes compose — a
  `QuotedElement` wrapping a `QuotedElement` gives two bars at two indents,
  because the inner wrapper receives an `x` that already carries the outer
  indent.

  The bar extends downward over the gap that follows the element, so it reads
  as one continuous rule rather than a dashed column of segments. Two bounds
  apply: the extension is `spaceAfter + ctx.paragraphSpacing + the next
  element's spaceBefore`, which the builder knows because it sets that spacing
  itself; and the painted bottom is clamped to `ctx.top - ctx.availHeight`, so
  the last element in a column never paints into the bottom margin.
  `PlaceContext` gains `paragraphSpacing` for the first of those — the engine
  already knows the gap it is about to insert, and this is the only way a
  decorator can.

  A quote gets a bar and an indent, not a background fill. A background must
  also fill the inter-block gaps and stop cleanly at a column break; that is the
  same problem as the bar but far more visible when it is a point off, and no
  Markdown construct needs it.

- **Lists** keep flow.ts's existing flattener. `FlowListItem` gains
  `blocks?: FlowElement[]`, lowered to the same indent and the same `/LBody`
  tag as the item's own body. `ListItemElement.markerDrawn` changes from a
  private boolean to a holder object shared across the item's elements, so
  whichever of them draws *first* paints the marker. That is what makes an item
  opening with a code block work: with a private flag the text body owns the
  marker, and an item with no text body never draws one.

  The existing single-`text` path is untouched — same class, same code, same
  bytes.

### Code blocks and the space-collapse problem

`layoutRuns` collapses runs of spaces: `a  b` lays out as `a b`. That is a
documented invariant of the one wrapping engine, load-bearing for every
existing caller's byte-identity, and fatal to code indentation.

Adding a preserve-spaces mode to the engine would mean changing the unit model
that `gl6o.3.1` just stabilised. Instead **`codeBlock()` substitutes U+00A0 for
each space** in the literal.

The consequences were read out of the tables rather than assumed:

- `winAnsi[0xA0]` is U+00A0 (the table fills 0x20..0xFF from Latin-1), so
  `encodeWinAnsi` emits byte `0xA0` rather than dropping the character.
- WinAnsiEncoding names code `0xA0` `/space` — 32000-1 Annex D Table D.2's
  documented duplicate, which `encoding.ts` already records in its `WIN_HIGH`
  table with that reason written out beside it.
- Its AFM advance is identical to `/space`: 278 in Helvetica, 600 in Courier.

So indentation survives, the block measures exactly as the same text with real
spaces would, and every source line becomes one unbreakable unit. A line wider
than the column then falls through the existing `breakOverwideWord` UAX #14
path instead of running off the page — which is the behaviour a code block
wants anyway.

**Invariant:** the substitution happens in `codeBlock()`, once, and nothing
downstream knows about it. A second producer that re-derived it would be a
second place for the width table to be wrong.

The block is then an ordinary text element carrying a background fill and
padding, so it inherits pagination, measurement and tagging with no new
machinery. Its `\n`s are already honoured by `layoutRuns`.

### The rect placer

**`flowplace.ts`** places a `FlowElement[]` into one rect on one page and
returns what did not fit:

```ts
placeElements(doc, page, elements, rect, options): {
  usedHeight: number;
  remainder: FlowElement[];   // [] when everything fit
}
```

It is the Flow loop with columns, floats, keep-with-next and page creation all
removed: walk the elements, apply the spacing rule, call `place`, stop when one
does not fit. It is a separate module rather than a mode of `Render` precisely
because it must not grow those features back — a caller who wants columns wants
a `Flow`.

`Page.AddMarkdown` returns the remainder as an opaque handle the caller may
feed to a later call, mirroring how `AddTextBlock` and `AddTable` already hand
back a re-drawable overflow.

### Inline mapping

`mdruns.ts` walks inlines with a current `RunStyle` and emits `TextRun[]`:

| Node | Mapping |
|---|---|
| `text` | a run in the current style |
| `emph` / `strong` | the italic / bold face of the current family; both nested → bold-italic |
| `code` | the code face at `style.code.fontSize` with `style.code.background` |
| `strikethrough` | `strikethrough: true` on the run |
| `link` | `style.link.color` + underline; children mapped recursively; no `/URI` (3.3) |
| `softbreak` | a space |
| `linebreak` | `\n`, which `layoutRuns` already treats as a paragraph boundary |
| `image` | see below |
| `html_inline` | dropped, reported |

**Font families.** `emph` and `strong` need a face, and there is no synthetic
slant or emboldening in this library. `style.font` is therefore a family:
`{ regular, bold, italic, boldItalic }`. When a bare Standard-14 name is given
instead, the family derives by name (`Helvetica` → `-Bold` / `-Oblique` /
`-BoldOblique`; `Times-Roman` → `Times-Bold` / `-Italic` / `-BoldItalic`;
Courier likewise). An `EmbeddedFont` has no such derivation, so a family whose
`bold` is unset falls back to `regular` — emphasis then shows as no change
rather than as a missing glyph.

**Images.** `MdImage` is an inline node, but a paragraph whose only content is
one image (whitespace aside) is the shape every Markdown author means as a
figure, and it maps to an image *block* with the image's children as its `alt`.
An image anywhere else falls back to rendering its alt text as runs and is
reported — an inline raster at line height is a layout feature nothing here
needs.

Bytes come from `options.resolveImage?: (destination, title) => Uint8Array |
undefined`. A `data:` URI decodes without a callback, since that needs no I/O
and the core of this library never touches `fs`. An unresolved destination
falls back to alt text and is reported; it never throws, following the rule
`svgdraw.ts` already sets — visible content beats a silently dropped subtree,
and an unrenderable thing must name itself.

### Block mapping

| Node | Mapping |
|---|---|
| `document` | its children, in order |
| `paragraph` | `paragraph(runs)` — or `image()` for the lone-image shape |
| `heading` | `heading(level, runs)` |
| `thematic_break` | `rule()` |
| `code_block` | `codeBlock(literal)`; `info` is not rendered |
| `block_quote` | `quote(children mapped)` |
| `list` | `list(items)`; `tight` drives spacing, `checked` the task marker |
| `table` | skipped, reported (3.3) |
| `html_block` | dropped, reported |

**Tight versus loose.** `MdList.tight` is the field `mdast.ts` records as
invisible to an HTML oracle and load-bearing here. Tight → `itemSpacing: 0` and
no inter-block gap inside an item; loose → both take
`style.paragraphSpacing`. This is the one mapping decision the CommonMark suite
cannot catch, which is why `test/markdown-ast.test.ts` exists and why it is
asserted directly below.

**Task items.** `MdItem.checked` yields a vector marker — an outlined square,
plus a check stroke when true — drawn the way `drawShapeMarker` already draws
the bullet cycle, and extending its shape vocabulary rather than adding a
second marker painter. WinAnsi has no ballot-box glyph, so a text marker is not
an option; `☐` / `☑` become the `/Lbl` `actualText`, which is the mechanism
already in place for the vector bullets.

### The style vocabulary

`mdstyle.ts` owns one flat `MarkdownStyle`, every field optional, over a
documented defaults table: body Helvetica 11; headings reusing Flow's existing
24/18/14/12/10/8 at Helvetica-Bold; code Courier at 0.9× on a light fill;
quote indent and bar; rule thickness and colour; per-construct `spaceBefore` /
`spaceAfter`. Derived values scale off the base size, so overriding `fontSize`
alone still yields a coherent document.

Validation follows the house rule: everything is validated before any element
is built, so a rejected call leaves the document byte-identical.

### The report

`skipped: string[]` names each construct that did not render — `'table'`,
`'html_block'`, `'html_inline'`, `'image:cat.png'`. `Flow.AddMarkdown` is the
one `Flow.Add*` method that returns a value rather than `this`; that is
deliberate, since without it a caller cannot distinguish a dropped table from
an empty document, and the chainable alternative buys nothing a second
statement does not.

## Limitations

- **A quote's bar is per element, so it can show a seam.** The extension covers
  the computed gap exactly; a caller who changes an inner element's spacing
  after the fact would see a break. Nothing in the mapper can do that.
- **No syntax highlighting, no inline images, no HTML.** Each is recorded in
  Scope with its reason and each names itself in `skipped`.
- **Leading stays block-level**, inherited from `gl6o.3.1`.

## Testing

**Byte-identity first.** The `flowelement.ts` extraction and the marker-holder
change touch code every existing caller runs. `test/rich-runs-identity.test.ts`
already hashes emitted page bytes for eight call sites and was confirmed to go
red on a 0.01pt nudge; it is extended to cover `AddList` with a nested list and
a multi-item list, and asserted before the mapper is written. That is what
makes the refactor safe to land.

Then, each pinned by breaking its path and confirming a red build:

- **`mdruns.ts`, directly** — nested `**a *b* c**` selecting bold-italic; a
  link inside strong keeping both; a hard break becoming `\n`; a family whose
  `bold` is unset falling back to `regular` rather than dropping the run.
- **Lowering, as element trees** — a quote holding a list holding a code block
  produces the expected indents and wrapper nesting, with no rendering
  involved.
- **Tight versus loose** — the same items under both flags produce different
  spacing. Asserted on element spacing *and* on rendered baseline positions,
  because the AST field is invisible to every other test in the suite.
- **Code-block indentation survives** — read back through `GetText()` on saved
  bytes, not off the emitter. A three-space indent that arrives as one space is
  exactly the failure the U+00A0 substitution exists to prevent, and only the
  extraction side can see it.
- **The quote bar's geometry** — `GetPaths()` reports the bar at the expected
  x and spanning the expected band, including the second bar of a nested
  quote.
- **A list item opening with a code block draws its marker** — the case the
  shared marker holder exists for, and the one a private flag silently gets
  wrong.
- **The three entry points agree** — the same source through
  `Flow.AddMarkdown`, `Page.AddMarkdown` into a full-page rect and
  `Document.AddMarkdown` produces the same text and the same fragment
  positions. This is what stops the rect placer and the column engine from
  drifting.
- **The report is accurate** — a document with a table, an HTML block and an
  unresolved image names all three and renders everything else.

Assertions that read the *result* (`GetText`, `GetTextFragments`, `GetPaths`)
are preferred over assertions on the emitter, per CLAUDE.md's rule that a
differential test cannot validate the code path it runs through.

## Files

| File | Change |
|---|---|
| `src/flowelement.ts` | new — the `FlowElement` protocol and shared spacing/clear validators, moved out of `flow.ts` |
| `src/flowblock.ts` | new — `CodeBlockElement`, `RuleElement`, `QuotedElement` and the `codeBlock()`/`rule()`/`quote()` builders |
| `src/flowplace.ts` | new — `placeElements`: a `FlowElement[]` into one rect, returning the overflow |
| `src/mdstyle.ts` | new — `MarkdownStyle`, its defaults, validation and font-family resolution |
| `src/mdruns.ts` | new — inlines to `TextRun[]` |
| `src/mdflow.ts` | new — blocks to `FlowElement[]`; `markdownElements`; the `skipped` report |
| `src/flow.ts` | public `paragraph`/`heading`/`list`/`image` builders; `AddCodeBlock`/`AddQuote`/`AddRule`/`AddMarkdown`; `FlowListItem.blocks`; shared marker holder; `PlaceContext.paragraphSpacing`; re-exports the moved protocol |
| `src/page.ts` | `AddMarkdown(src, rect, options)` returning `{ usedHeight, remainder, skipped }` |
| `src/document.ts` | `AddMarkdown(src, options)` returning the appended pages and the report |
| `src/index.ts` | export the builders, `MarkdownStyle`, the options and result types |
| `test/rich-runs-identity.test.ts` | extended — nested and multi-item lists in the byte-identity corpus |
| `test/flow-blocks.test.ts` | new — code block, rule and quote as Flow API, without Markdown |
| `test/markdown-runs.test.ts` | new — the inline mapping |
| `test/markdown-flow.test.ts` | new — lowering, tight/loose, task items, images, the report |
| `test/markdown-render.test.ts` | new — the three entry points, read back through extraction |
| `README.md` | Markdown rendering in Features and the API overview; the new Flow blocks |
| `CLAUDE.md` | the flatten-never-contain, U+00A0 and one-builder-per-construct invariants |

## Landing order

Two commits, because the first half is a refactor of code every existing caller
runs and the second half is new surface that cannot break anything:

1. `flowelement.ts` + `flowblock.ts` + `flowplace.ts` + the `flow.ts` builders,
   `FlowListItem.blocks` and the marker holder — with the extended byte-identity
   corpus green before anything else is written.
2. `mdstyle.ts` + `mdruns.ts` + `mdflow.ts` and the three `AddMarkdown` entry
   points.

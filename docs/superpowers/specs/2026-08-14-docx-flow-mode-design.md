# DOCX flow mode — styled runs, headings, lists, hyperlinks, images, tables

Design for `aspose-pdf-foss-for-ts-8yt9.2`, the second child of the
`PDF to DOCX export` epic (`8yt9`). It fills the body seam `8yt9.1` left open in
`docxpackage.ts`, and it is the third serializer over `docmodel.ts` — after
`htmlsemantic.ts` (`no93.1`) and `mdexport.ts` (`no93.3`).

## Problem

`8yt9.1` writes a conformant but empty `.docx`. `docmodel.ts` reconstructs a
document as a `DocNode[]` tree of PDF standard structure types. Nothing maps one
onto the other, and `Document.ToDocx()` does not exist.

Two things the model does not carry stand in the way, and both are the reason
this issue is more than a mapping table:

- **No character styling.** `DocText` is `{ kind: 'text'; text: string }`.
  `struct.ts` builds a text node per MCID with `spacedText(glyphs)`, which
  discards the font; the untagged path goes through `TextFragment`, which
  carries `fontName`/`fontSize` that `docmodel.ts` then drops. The issue title
  names *styled runs* first, and there is nothing today to derive them from.
- **No image size.** `DocFigure` carries streams and an alt text. HTML gets away
  with that — an `<img>` takes its natural size — but a DOCX cannot: the
  `<wp:extent cx cy>` on an inline drawing is mandatory, and there is no
  "natural size" fallback in the format.

## Approach

Four new modules, following the split `svgdraw.ts`/`svgembed.ts` already make —
pure mappers plus exactly one module that touches a `Document`:

- **`docxflow.ts`** — `DocNode[]` → the inner XML of `<w:body>`. Takes an image
  sink as an argument, so it neither encodes bytes nor allocates package parts.
- **`docxtable.ts`** — `Table` → `w:tbl`.
- **`docxstyles.ts`** — generates `styles.xml` and `numbering.xml`.
- **`docxexport.ts`** — the entry: builds the model, implements the sink,
  assembles the package. The only module here that reads a `Document`.

And three shared files gain what the mapper needs: `font.ts` learns to report a
font's weight and slant, `text.ts`/`struct.ts` carry that onto their text runs,
and `docmodel.ts` carries it plus the drawn image size onto the neutral model.

Two alternatives were considered and rejected:

- **Structure-derived styles only** — map `H1`–`H6`, `Link` and `Code` to Word
  styles and emit no `<w:b/>` at all, on the grounds that the model records
  none. Smallest scope and zero risk to the other two serializers. Rejected
  because it silently redefines the issue: a converted document whose bold text
  is not bold is a worse deliverable than one that took two shared files to get
  right, and the follow-up would have to revisit every one of these modules
  anyway.
- **Re-deriving styling inside the DOCX serializer** from `TextFragment`s.
  Needs no model change. Rejected because it privileges one serializer and gives
  it a second, divergent walk of the page — precisely what the neutral model
  exists to prevent, and the four-walk problem `no93.1` was written against.

## Scope

In scope:

- `src/font.ts` — `fontStyle(font)`, the single owner of "is this font bold or
  italic".
- `src/text.ts` — `TextFragment` gains `bold`/`italic`.
- `src/struct.ts` — `StructTextNode` gains `bold`/`italic`; `Nodes` splits an
  own-text run where the font changes.
- `src/docmodel.ts` — `DocText` gains `bold`/`italic`; `DocFigure` gains `sizes`.
- `src/docxflow.ts`, `src/docxtable.ts`, `src/docxstyles.ts`,
  `src/docxexport.ts` (all new).
- `src/docxpackage.ts` — an optional second argument for extra parts and rels.
- `src/document.ts`, `src/page.ts`, `src/node.ts`, `src/index.ts` — the public
  entry points.
- `README.md`, `CLAUDE.md`.

Out of scope: textbox mode (`8yt9.4`), reading a `.docx` (this library converts
*from* PDF), and headers/footers, footnotes, section breaks and revision
tracking — none has a source in `docmodel.ts` to come from.

`8yt9.3` is **re-scoped rather than absorbed**: this issue emits the `w:tbl`
grid, spans and header rows, and `.3` becomes border and shading recovery from
the ruled geometry, plus nested tables.

## Shared-model changes

The whole risk of this issue sits here, and one existing test is the fence:
`test/html-identity.test.ts` snapshots `htmlsemantic.ts`'s output over the shared
model, and the Markdown export has its own snapshots. Every field added below is
optional and read by neither serializer, so those staying green is what proves
the extension moved nothing.

### `font.ts` — one owner for weight and slant

```ts
export interface FontStyle { bold: boolean; italic: boolean }
export function fontStyle(font: TextFont): FontStyle;
```

Italic when `/FontDescriptor /Flags` bit 7 is set, or `/ItalicAngle` is
non-zero, or the `/BaseFont` name matches `italic|oblique`. Bold when the
`ForceBold` flag is set, or `/FontWeight` is ≥ 600, or the name matches
`bold|black|heavy`. The descriptor is consulted first and the name is the
fallback, because a name is a string a producer chose and the descriptor is a
declaration.

**Invariant:** this question has ONE owner. Two consumers ask it — the tagged
path through `struct.ts` and the untagged path through `fragmentsFromGlyphs` —
and a second copy is how the two paths come to disagree about whether a heading
is bold, on a document where only one of them runs. Same rule
`glyphprogram.ts` records for `gidForCode`.

**Invariant:** a subset prefix does not defeat the name test. `/AAAAAB+Arial-BoldMT`
must read as bold, so the match is a substring search on the name with any
`ABCDEF+` prefix removed, not an equality test against a face list.

### `text.ts` — `TextFragment`

```ts
export interface TextFragment {
  /* ... existing ... */
  bold?: boolean;
  italic?: boolean;
}
```

`fragmentsFromGlyphs` already holds the `TextFont` in its accumulator and
already breaks a fragment on a font change, so the run granularity is free and
the fields are stamped at flush time.

**Invariant:** the fields are optional and absent when false, not `false`. A
fragment is compared and snapshotted in several tests; adding a key that is
always present moves output that has nothing to do with this feature.

### `struct.ts` — `StructTextNode`

```ts
export interface StructTextNode {
  kind: 'text'; text: string; page: Page;
  bold?: boolean; italic?: boolean;
}
```

`Nodes` currently emits one text node per MCID. It now splits that run wherever
the font's style changes, so a paragraph with a bold phrase in the middle
arrives as three nodes. `.Nodes` has exactly one consumer — `docmodel.ts` — so
the blast radius is contained, and `interleave` already walks glyphs
individually, which is where the split is cheapest to make.

**Invariant:** the split is on the *style*, not on the font. A document setting
the same face through two font objects, or switching between two regular faces
mid-sentence, must not fragment into a run per font — that multiplies runs in
the output for no visible difference, and `spacedText`'s leading and trailing
spaces would have to be reasoned about at each new boundary. Compare the derived
`{bold, italic}` pair.

**Invariant:** `spacedText` still produces each piece, so the leading and
trailing spaces a run drew survive the split. `assembleLines` drops whitespace
at a line's edges, which is right for a whole element and wrong for a fragment
of one — the `(the docs )` case `no93.1` records. Splitting a run in three is
three more chances to make that mistake.

### `docmodel.ts`

```ts
export interface DocText { kind: 'text'; text: string; bold?: boolean; italic?: boolean }

export interface DocFigure {
  kind: 'figure'; alt: string; images: PdfStream[];
  /** Drawn size in points, parallel to `images`. Absent when unknown. */
  sizes?: { width: number; height: number }[];
  tagged: boolean;
}
```

`pageMcidImages` already sees the `ImageEvent`, whose `quad` is the device-space
box of the drawn unit square, so the size is recorded alongside the stream in
the same pass rather than recovered later.

**Invariant:** `sizes` is parallel to `images` and the same length whenever
present. A figure holds several streams for a composite image, and a serializer
pairing them by index must not have to guess which size belongs to which
picture. A stream whose size could not be determined contributes
`{ width: 0, height: 0 }` rather than being omitted, which would shift every
later index by one and silently mis-size the rest of the figure.

**Invariant:** the size is the DRAWN size, not the image's pixel dimensions. A
producer that placed a 2400px scan two inches wide said what it meant; treating
the pixels as 96 DPI arrives at 25 inches. The pixels are the fallback only when
no draw was observed.

## `docxflow.ts`

```ts
export interface DocxImageSink {
  /** Register an image, returning its relationship id, or undefined when it
   *  cannot be encoded. Called at most once per distinct image. */
  add(stream: PdfStream): string | undefined;
}
export interface DocxLinkSink {
  /** Register an external hyperlink target, returning its relationship id. */
  add(href: string): string;
}
export interface DocxNumbering { numId: number; ordered: boolean; start?: number }

export function docxBody(
  nodes: DocNode[], images: DocxImageSink, links: DocxLinkSink,
): { xml: string; nums: DocxNumbering[] };
```

The sinks are what keep this module free of `Document`, `encodeImage` and the
package.

**Invariant:** the mapper reports the lists it emitted rather than a flag saying
that it did. `numbering.xml` needs one `w:num` per list, with that list's
ordered-ness and start override — the mapper is the only thing that knows how
many `w:numId`s it allocated and what each meant, and a boolean would leave
`docxstyles.ts` re-deriving it from a second walk of the model.

### Block mapping

| Model node | WordprocessingML |
|---|---|
| `H1`–`H6` | `<w:p><w:pPr><w:pStyle w:val="Heading1"/>…` |
| `P`, unknown inline types | a plain `<w:p>` |
| `BlockQuote` | `<w:p>` with `w:pStyle` `Quote` and an indent |
| `DocCode` | one `<w:p>` per line, style `SourceCode` |
| `DocList` | `<w:numPr>` with `w:ilvl` from depth and one `w:numId` per list |
| `DocListItem` | its blocks, the first carrying the `numPr` |
| `DocTable` | `docxtable.ts` |
| `DocFigure` | an inline `<w:drawing>` |
| unknown container type | transparent — children as sibling blocks |

Transparency is the rule `mdexport.ts` already follows: everything in a tagged
tree hangs under a `Document` wrapper, so dropping unknown types empties the
output entirely.

### Inline mapping

A `Link` with an `href` becomes `<w:hyperlink r:id="…">` wrapping its runs, each
carrying the `Hyperlink` character style. A `Link` without one becomes plain
runs — an internal `GoTo` names a page object that will not exist once the PDF is
gone, which is the rule `docmodel.ts` sets by only recording a URI action.
`bold`/`italic` become `<w:b/>`/`<w:i/>` in the run's `w:rPr`.

**Invariant:** every `<w:t>` carries `xml:space="preserve"`. A `/Link` draws
`(the docs )` inside its own marked content, and without the attribute Word
collapses that trailing space — rejoining the words either side into
`Seethe docshere.`, which is the exact defect `spacedText` exists to prevent,
reintroduced one layer down.

**Invariant:** text is stripped of the characters XML 1.0 forbids before it is
escaped. `escapeXml` in `xml.ts` handles `& < > "` and nothing else, and
extracted PDF text can carry a NUL or a C0 control. One such byte does not
corrupt a paragraph — it makes `document.xml` unparseable, so Word rejects the
entire file with no indication of where the fault is. Tab and newline are kept
and mapped; everything else below 0x20, plus the surrogate and non-character
ranges, is dropped.

**Invariant:** a newline inside a text node becomes `<w:br/>`, matching what
`Table.toHtml` already does with `<br>`. A raw newline in `<w:t>` is legal XML
and renders as a space, silently joining lines the document showed separately.

### Lists

One `w:numId` per `DocList`, so two sibling lists do not continue each other's
numbering, with `w:ilvl` carrying the nesting depth. `start` is applied through a
`<w:startOverride>` on the `w:num`, which is where Word reads it — putting it on
the abstract definition would move every list sharing that definition.

**Invariant:** a task item's checked state is CONTENT, emitted as a literal ☐ or
☒ at the head of the item's first paragraph. It is the one place the
marker-suppression rule does not apply, exactly as `htmlsemantic.ts` emits a
disabled checkbox: the state is what the document says, not decoration the
serializer re-derives.

**Invariant:** bullet levels use U+2022/U+25E6/U+25AA in the document font, not
Word's conventional U+F0B7 in Symbol. That codepoint is in the private use area
and means a bullet only in a font that is present on Windows and frequently not
elsewhere; where the font is missing, so is the glyph.

### Figures

An inline `wp:inline` drawing whose `wp:extent` is the drawn size in EMU
(1pt = 12700, rounded to an integer), with `alt` on `wp:docPr@descr`.

**Invariant:** `wp:docPr@id` is unique across the document and non-zero. Word
tolerates a duplicate in some builds and reports the file as corrupt in others,
which makes it the kind of defect that appears to depend on the reader.

**Invariant:** a figure is described once. A composite figure carries its `/Alt`
on the first drawing only — repeating it makes a screen reader announce the same
description once per part, the rule `htmlsemantic.ts` already holds.

**Invariant:** a figure with no encodable image emits a paragraph holding its
alt text when `tagged`, and nothing at all when not. The provenance flag
exists because the two paths legitimately differ: a tagged `/Figure` still has
accessible content to announce, an untagged page image has none.

## `docxtable.ts`

```ts
/** `paragraph` builds one `w:p` from cell text — supplied by `docxflow.ts`. */
export interface DocxTableCtx { paragraph(text: string): string }
export function docxTable(table: Table, ctx: DocxTableCtx): string;
```

**Invariant:** a cell's paragraphs are built by the function a body paragraph is
built by, passed in rather than imported. `docxflow.ts` calls this module, so
importing back would close a cycle — and a second paragraph emitter is how a
cell comes to lose the `xml:space` attribute or the control-character strip that
the rest of the document has.

Column widths come from the cells' `quad`s: the distinct x-edges across all rows
give the grid, and each column's width in twips (1pt = 20) fills `w:tblGrid`.
`colSpan` becomes `w:gridSpan`, `rowSpan` becomes a `w:vMerge` `restart` on the
first cell and a continuation on each covered one, and a row whose cells are
`isHeader` gets `w:tblHeader` so Word repeats it across a page break.

**Invariant:** every `w:tc` contains at least one `w:p`. An empty table cell is
invalid WordprocessingML and Word refuses the document — an empty *paragraph* is
how the format spells an empty cell.

**Invariant:** an empty `w:p` follows a table, and separates two adjacent
tables. Two `w:tbl` elements with nothing between them merge into one table in
Word, and a body ending in a table has no paragraph mark for the section
properties to attach to.

**Invariant:** a nested table is emitted inside its parent cell rather than
after it. `TableCell.tables` is recursive and WordprocessingML nests directly,
unlike GFM — which is why `Table.toMarkdown` has to follow a nested table with
its parent and this module does not.

## `docxstyles.ts`

`styles.xml` defines exactly the styles the mapper names: `Normal`, `Heading1`
through `Heading6`, `Quote`, `SourceCode`, `ListParagraph` and the `Hyperlink`
character style, over a `w:docDefaults`.

**Invariant:** the mapper cannot name a style this module does not define, so
the two are one decision and the style ids live here. A `w:pStyle` pointing at
an undefined style is not an error a reader reports — Word falls back to body
text, so a document of headings arrives looking like one long paragraph and
nothing anywhere says why.

**Invariant:** `styles.xml` is unconditional, `numbering.xml` appears only when
a list does. A relationships part with no relationships is legal and says
nothing — the rule `ooxml.ts` sets by not emitting one — and the same reasoning
applies to a numbering part defining lists nobody uses.

## `docxexport.ts` and package assembly

`docxpackage.ts` grows an optional second argument:

```ts
export interface DocxExtras { parts?: OoxmlPart[]; rels?: OoxmlRelationship[] }
export function writeDocx(bodyXml: string, extras?: DocxExtras): Uint8Array;
```

The existing single-argument call keeps working, so `8yt9.1`'s test stays as
written. `word/_rels/document.xml.rels` now appears — created by the first
style, image or hyperlink relationship through the same path every other `.rels`
uses, which is what that issue's close note anticipated.

Parts: `word/document.xml`, `word/styles.xml`, `word/numbering.xml` when a list
was emitted, and one `word/media/imageN.png|jpg` per distinct image.

**Invariant:** image identity is the hash of the ENCODED BYTES, not the
`PdfStream` object. A merged document holds distinct stream objects with
identical content, and keying on identity writes the same picture into the
package several times. `mdexport.ts`'s rule, reused rather than re-derived.

**Invariant:** media parts are `store`d, never deflated. `encodeImage` returns
JPEG or PNG, both already compressed; deflating costs time and usually grows
them, which is the case `zip.ts`'s per-entry method exists for.

**Invariant:** the body ends with a `w:sectPr` whose `w:pgSz` is the first
page's MediaBox in twips. The default is US Letter, so every A4 document would
otherwise reflow on open — a change to the document made by saying nothing.

**Invariant:** the export degrades rather than throws. `buildDocModel` is
wrapped and whatever was produced is emitted, matching `render` in `mdexport.ts`
and `renderPageToSvg`. A document we could not fully reconstruct still converts.

### Public API

```ts
class Document { ToDocx(): Uint8Array }
class Page     { ToDocx(): Uint8Array }
async function saveDocxFile(inputPath: string, outPath: string): Promise<void>;
```

There is deliberately no option bag. `ToHtml` and `ToMarkdown` each carry one
because each has a decision only the caller can make — how to deliver images.
A `.docx` contains its images and derives its page size from the document, so
there is nothing left to ask; an optional argument can be added later without
breaking a caller, and inventing one now would be inventing the question too.

For the same reason there is no `ToDocxAssets`: that split exists for Markdown
because a string has nowhere to hand image bytes back.

## Testing

Most of the coverage is pure and builds no PDF at all — the split `docinfer.ts`
and `booklet.ts` already make:

- **`docxflow.ts`** driven from hand-built `DocNode` trees, with stub sinks:
  each heading level, a styled run, a link with and without an `href`, an
  ordered list with a `start`, a nested list, a task item, a code block's
  indentation, an unknown container type staying transparent, and the control
  character and `xml:space` cases.
- **`docxtable.ts`** from hand-built `Table`s: the grid from quads, `gridSpan`,
  `vMerge`, a header row, an empty cell, a nested table.
- **`font.ts`** — `fontStyle` over descriptors and over subset-prefixed names.

Above that, an authored PDF through `ToDocx`, unzipped with
`test/helpers/unzip.ts` — written against APPNOTE rather than against `zip.ts`,
so it is not our writer validating itself — asserting the part list, that every
relationship resolves to a part that exists, and that each XML part parses
through `xml.ts`'s `parseXml`. One cross-check that `document.xml`'s text
matches `ToMarkdown`'s, since both are serializers over one model.

`test/html-identity.test.ts` and the Markdown snapshots are the fence on the
model extension. They are expected to stay green and are the evidence, not a
formality.

Per CLAUDE.md each new path is broken and the suite confirmed red rather than
trusted on first green. Mutations to run: drop `xml:space="preserve"`; skip the
control-character strip; emit `false` rather than omitting `bold`; split
`Nodes` on the font object instead of the derived style; use pixel dimensions
instead of the drawn size; emit a `w:tc` with no `w:p`; give two drawings the
same `wp:docPr@id`; put `startOverride` on the abstract numbering; and omit the
`w:sectPr`.

## Limitations, stated rather than implied

**We cannot run Word in CI.** These tests prove structural conformance to
ECMA-376 and nothing about a particular consumer. `8yt9.1` recorded this and it
is unchanged: the first time a `.docx` from this library is opened in Word will
be by hand.

**Bold and italic are inferred, not read.** A PDF records a font, not an
emphasis; a document that sets bold by using a separate bold face is recovered,
one that fakes it with a stroke width is not. Fake-bold detection has no source
in the model and is deliberately absent.

**Flow is continuous.** Pages are concatenated with no page break between them,
matching `ToMarkdown` and `ToHtml`. Reproducing the PDF's pagination is what
`8yt9.4`'s textbox mode is for.

**No headers, footers, footnotes or revision tracking** — `docmodel.ts` records
none of them.

## Documentation

- `README.md` — `ToDocx` in the API overview, and the Limitations section gains
  the inferred-emphasis and continuous-flow notes beside the existing
  Word-unverified one.
- `CLAUDE.md` — the four new modules in the Source list carrying the invariants
  above, the `docmodel.ts` entry noting the two new fields and why the other two
  serializers ignore them, and `font.ts` noting `fontStyle`'s single ownership.

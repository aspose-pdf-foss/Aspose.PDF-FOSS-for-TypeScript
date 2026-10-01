# DOCX import over the flow engine — design (`m2fp.5`)

Epic `m2fp` imports DOCX as a DOCUMENTED SUBSET lowered onto the flow engine
that `AddHtml` and `AddMarkdown` share — never a Word layout engine. `m2fp.1`
to `m2fp.4` and `m2fp.8`/`m2fp.9` built and anchored the reader: `readDocx`
turns a package into a resolved `WmlDocument` (`wmlbody.ts`, `wmlstyles.ts`,
`wmlnumbering.ts`), and the real-world corpus in `test/fixtures/docx/` holds it
to what Word 2010 and LibreOffice 26.8 agree a document says. This issue lowers
that model to `FlowElement[]` and ships the three entry points.

## Decisions taken in brainstorming

1. **The flow engine gains two narrow, OPT-IN capabilities** rather than the
   mapper approximating around their absence: an explicit per-item list marker
   (`FlowListItem.label`) and a paragraph indent (`FlowParagraphOptions.indent`).
   A caller that passes neither is byte-identical. Rejected: approximating
   Word's labels with `1.`/bullet markers and dropping indents (visibly wrong
   for any real numbered document), and translating the model into an HTML DOM
   for `lowerHtml` (CSS collapses vertical margins where Word adds them, and a
   string round trip makes per-construct reporting harder).
2. **`skipped` is counted records**: `{ name, count, kind }`, in Word's own
   vocabulary — the names `readDocx` already records — plus the placement
   compromises. Rejected: Markdown's flat `string[]` (loses dropped/degraded)
   and HTML's `NotRendered` (its `el` is an `HtmlElement` a DOCX construct can
   never supply).
3. **Three entry points, one implementation**, `htmlflow.ts`'s shape for its
   reason.

## Modules

The `docx*` prefix belongs to the WRITER (`docxexport.ts`, `docxflow.ts`, …)
and is not used here — `m2fp.3`'s rule. The reader side stays `wml*`.

- **`wmlflow.ts`** — the mapper. `WmlDocument` (plus an image-bytes callback
  and a font resolver) to `{ elements: FlowElement[]; skipped: DocxSkipped[] }`.
  A pure module in `mdflow.ts`'s position: it knows no columns, rects or
  pagination, touches no `Document`, and never throws on document content.
- **`wmlimport.ts`** — the wiring behind the three entry points, in
  `htmlflow.ts`'s position: opens the package through `readDocx`, supplies the
  font resolver (`cssfont.ts`'s `documentFamilyResolver`, falling back through
  the font table below) and the image reader, validates options. The only new
  module that touches a `Document`.
- **`wmlread.ts` grows** (the core-properties title is read here too, from
  the package-level `core-properties` relationship):
  - a lazy part reader returned beside the model (`openDocx` → `{ doc, readPart }`;
    `readDocx` stays the model-only form), so an image's bytes are read — and
    charged to the archive's `LoadLimits` — only when it is drawn;
  - `fontTable.xml`'s `w:family` per font name (`roman`, `swiss`, `modern`,
    `script`, `decorative`, `auto`), found through the main document's
    relationships like styles and numbering, degrading to empty when missing or
    unreadable.
- **`flow.ts` grows** the two options of decision 1 (below).
- **`document.ts`, `page.ts`, `flow.ts`** gain `AddDocx`; **`node.ts`** gains
  `docxFileToPdf`, mirroring `htmlFileToPdf`; **`index.ts`** exports the entry
  types.

## Public surface

```ts
interface DocxFlowOptions {
  /** Override the font bridge. Default: the document's registered families,
   *  then a generic chosen by the DOCX font table's w:family. */
  resolveFamily?: FamilyResolver;
  /** Placement-time compromises, for a Flow whose AddDocx returns before
   *  Render. doc/page.AddDocx fold them into `skipped` themselves. */
  onSkipped?: (s: DocxSkipped) => void;
}
interface DocxSkipped { name: string; count: number; kind: 'dropped' | 'degraded' }
interface DocxFlowResult { skipped: DocxSkipped[] }
interface AddDocxResult extends DocxFlowResult { usedHeight: number; remainder: FlowElement[] }

flow.AddDocx(bytes: Uint8Array, opts?: DocxFlowOptions): DocxFlowResult
page.AddDocx(bytes: Uint8Array, rect: Rect, opts?: DocxFlowOptions): AddDocxResult
doc.AddDocx(bytes: Uint8Array, opts?: DocxFlowOptions & FlowOptions & { title?: string }):
  { pages: Page[]; skipped: DocxSkipped[] }
docxFileToPdf(inputPath: string, outputPath: string,
  opts?: DocxFlowOptions & FlowOptions & { title?: string }): { skipped: DocxSkipped[] }   // node.ts
```

`doc.AddDocx` mirrors `doc.AddHtml`: `FlowOptions` carries the page geometry
(`format`, `margin*`, `columns`, `tagged`, `lang`). A `format` or `margin*` the
caller does not state is taken from the LAST `w:sectPr` (the body's), else
`FlowOptions`' own default. The PDF title comes from `docProps/core.xml`'s
`dc:title` when it is non-blank and no explicit `title` is given — `AddHtml`
reads `<title>` for the same reason: the document STATES it, so carrying it is
reading, not inventing; `flow.AddDocx` and `page.AddDocx` never set a title.
`skipped` is sorted by name with one record per (name, kind); a fresh array on
every return (`kk3q`'s rule).

## Flow engine additions

- **`FlowListItem.label?: string`** — the item's marker drawn as this text,
  measured into the list's marker width like any computed marker. Wins over
  `ordered`/`bullet` for that item only. An empty label draws no marker.
- **`FlowParagraphOptions.indent?: { left?: number; right?: number;
  firstLine?: number }`** — points; a NEGATIVE `firstLine` is a hanging
  indent. Left and right narrow the text box through `flowelement.ts`'s
  `insetScale` (the `e1bp` floor), so an indent wider than the column squeezes
  and reports `'squeezed'` rather than throwing. The first-line offset is a
  first-line x shift inside `layoutRuns`' existing per-line geometry, clamped
  to the box.
- Both are fenced by byte identity: `test/rich-runs-identity.test.ts`,
  `test/markdown-flow.test.ts` and the HTML identity suites must not move.

## Mapping

- **Paragraph** → `paragraph()` with runs: bold/italic select a face from a
  four-face family (`mdstyle.ts`'s rule), underline, strike, colour, size, and
  highlight/shading as the run background. Alignment maps directly.
  **Amended during implementation (Task 1):** Word 2010 COLLAPSES adjacent
  spacing — the gap between two paragraphs is `max(after, before)`, measured
  through COM over seven cases (`test/spacing-oracle.test.ts`). The engine ADDS
  `spaceAfter + spaceBefore` (placed with `paragraphSpacing: 0`), so the
  mapper emits `spaceAfter = after` and `spaceBefore = max(0, before -
  previousAfter)`, which sums to Word's gap. The previous element's `after`
  is carried across paragraphs, list items and tables; a table resets it to 0.
  Line spacing → `leading`: auto multiple × the default leading, exact as
  given, at-least as `max(default, value)`. Indents → the new `indent`.
- **Empty paragraph** → a vertical gap of its line height plus its spacing,
  collapsed with its neighbours by the same `max` rule.
  `paragraph('')` measures 0 (`zch2.13`) and would vanish, where Word gives it
  a line.
- **Heading** (resolved `outlineLvl` + 1) → `heading(level)` with Word's
  resolved face and size passed EXPLICITLY, so the builder's defaults never
  apply (`cssflow.ts`'s rule); this is what yields `/H1..H6` and
  keep-with-next. Levels 7-9 render as level 6, reported degraded.
- **Lists** → one `list()` per run of consecutive list paragraphs, nested by
  `ilvl` so tagging yields nested `/L`. Each item's `label` is the label
  `readDocx` computed; Word's hanging indent is the marker room. A BULLET
  level whose glyph the resolved face cannot draw — Word's default is U+F0B7
  in Symbol — draws `•` (U+2022) and is reported degraded: the rule rests on
  `numFmt=bullet` meaning "a bullet", not on a Symbol-to-Unicode table.
- **Tables** → `TableBuilder`: grid widths as fixed column widths,
  `gridSpan` → `colSpan`, a `vMerge` run → `rowSpan` counted down the grid
  column (after `gridBefore` offsets; a `gridBefore`/`gridAfter` gap is an
  empty borderless cell), leading header rows → `setRepeatingRowsCount`,
  shading → the cell background. A cell of several paragraphs flattens to runs
  separated by line breaks; a nested table flattens into its cell, reported
  degraded (`csstable.ts`'s rule); an image in a cell is a cell atomic.
- **Images** → among text, a `FlowAtomic` at its `wp:extent`; alone in its
  paragraph, a block `image()` at that size. A format `buildImageXObject`
  refuses is reported dropped by media type (`image/x-emf`, `image/x-wmf`); an
  unreadable part is dropped as `a:blip (unreadable image)`.
- **Links** → an external URL links its runs through `runlink.ts`. An internal
  anchor gets no link and is reported degraded (`w:hyperlink (anchor)`):
  resolving it needs a bookmark-to-destination map built after placement,
  `cssflow.ts`'s reason for fragment-only hrefs.
- **Breaks** → a line break is `\n` in the run. A page or column break is a
  column break in `flow.AddDocx`/`doc.AddDocx`, and is reported degraded in
  `page.AddDocx`, whose one rect has no next page.
- **Tab** → one space, reported degraded (`w:tab`): the engine has no tab
  stops, and a TOC's leaders need them.
- **Everything `readDocx` records** passes through to `skipped` with a kind:
  `dropped` for constructs that draw nothing (`w:headerReference`,
  `w:footerReference`, `w:footnoteReference` — the note's text is not drawn —
  `w:del`, …), `degraded` for those drawn differently (`w:drawing (anchor)`,
  `w:sym`, `w:ruby`, `w:ins`, a field, a property on a node's `unmodelled`).
  The kind of every name is one table in `wmlflow.ts`, asserted to cover every
  name the corpus files and `test/wmlbody.test.ts` produce; an unknown name
  defaults to `degraded`, since `readDocx` keeps its text.

## Fonts

A run's font name goes through the same resolver `AddHtml` uses. System fonts
stay OPT-IN, as everywhere in this library, so an unregistered Calibri falls
back — and `cssfont.ts` refuses a name-to-class table. DOCX carries something
better: `fontTable.xml`'s `w:family`, written by the producer. `roman` → serif,
`swiss` → sans-serif, `modern` → monospace, anything else → sans-serif. An
unresolved face is reported degraded once per name (`font:Calibri`). Glyphs the
resolved face cannot draw report through `textcoverage.ts`'s sink.

## Limits and errors

`readDocx`'s `PdfParseError` (not a WordprocessingML package) is the one throw
on damage; `ResourceLimitError` for bounds. Everything else is a value in
`skipped`, including an image that will not read or decode. A bad option is
`TypeError`, validated before any page is allocated, so a rejected call leaves
the document byte-identical.

## Testing

- **Unit** — `test/wmlflow.test.ts`: one case per mapping rule from
  hand-built `WmlDocument`s, no package needed; the two flow additions each
  with their own cases and the identity fences above.
- **Word oracle for spacing** — before the mapping ships, a small document
  with known before/after values is laid out by Word 2010 through COM
  (`wml-oracle.json`'s arrangement). It found Word COLLAPSES (see Mapping).
  The witness is a third paragraph with no spacing at its own boundary: Word's
  reported position for a paragraph that HAS space before reads as if the
  spacing added, and is not trustworthy. Word 2010's PDF export hangs on the
  machine that ran it, so no PDF could serve as the witness.
- **Corpus** — every file in `test/fixtures/docx/` renders through
  `doc.AddDocx`: extracted text matches the reader-agreed truth the corpus test
  already holds `readDocx` to; the structure tree shows the headings, lists and
  tables the truth records; every construct the truths count and we do not
  model appears in `skipped`.
- **Round trip** — tagged PDF → `ToDocx` → `AddDocx` → extracted text and
  structure types match the original.
- **Equivalence** — one source through all three entry points gives the same
  extracted text.
- **Mutation** — every rule is mutation-checked, and a rule the suite cannot
  see is recorded as such.

## Out of scope

Headers, footers, footnotes, text boxes, floating placement, tab stops,
internal link destinations, fields beyond HYPERLINK, section-by-section page
geometry (only the last `sectPr` is used), comments, tracked-change display,
and legacy `.doc`. Each is reported, never silently dropped.

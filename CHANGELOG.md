# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

> `package.json` is `0.1.0`, staged for the first public release to npm as
> `@asposefoss/pdf`. Nothing has been published or tagged yet, so everything
> below still sits under `[Unreleased]`; cut it to a `[0.1.0]` section at the
> moment of publishing, not before.
>
> Entries are newest first. Those covering work that predates 2026-08-18 were
> **reconstructed** from the git history and the issue tracker's close reasons
> rather than written as the work landed: they summarise a shipped capability
> rather than each commit that built it, and are grouped roughly one per feature
> epic. The issue id in parentheses is the entry point into the history for the
> detail. Work from 2026-08-18 onward is logged as it lands, at finer grain.

## [Unreleased]

### Added

- **Tab stops.** `tabStops` on `AddTextBlock`, Flow paragraphs, headings and list items, or once on a Flow, moves the text after a tab to a stop. A stop can be left, right, centre or decimal-aligned, and its gap can carry a leader: dots, middle dots, hyphens, underscores or a solid line. Past the last explicit stop come default stops every `defaultTabInterval` (36pt). Stops are measured from the left text edge, before any paragraph or list indent, as Word measures them, so a stop lands where it says however the paragraph is indented. A stop is chosen strictly past the pen, so a tab always moves forward. If no stop fits on the line, the tab ends it, and text after a right, centre or decimal stop that is wider than the room before it starts at the pen rather than overprinting what precedes it. In justified text, word spacing stretches only after the last tab. Leaders are artifacts in tagged output, and their glyphs are counted by the same function TOC rows use, so the two agree byte for byte. DOCX import now renders Word's tab stops: it resolves them down the style chain, where they accumulate and a `clear` removes an inherited one, and reads `w:defaultTabStop`; until now every `w:tab` became a reported space. The positions were checked against Word 2010 through COM for left, right, centre and decimal stops, default stops, a cleared style stop and a dot leader. All eight land exactly where Word puts them. A Word and a LibreOffice document carrying stops now join the corpus, read by both applications. A tab in a table cell is still reported. Without `tabStops`, a tab draws nothing and output is unchanged. (v9j3.1)
- **Note marks link to their notes and back.** Every footnote and endnote citation mark in a Flow — hand-built, Markdown or DOCX, in a paragraph, a list or a table cell — is now a GoTo link to its note, and the note's own mark links back to its first citation, as Word, LibreOffice and GitHub do. The links are written in one pass once everything is placed, so a link never names a note that has not been placed and may cross pages: an endnote on its own page links back to the page that cites it. A repeated citation links to the one note, whose back link goes to the first. Under a tagged flow each link is a `/Link` structure element holding the mark and its annotation, and `ValidatePdfUa` reports nothing new. On by default; `footnotes: { links: false }` and `endnotes: { links: false }` turn it off per kind and reproduce the earlier output byte for byte, which the identity fence asserts. In a single rect (`page.AddMarkdown`, `page.AddDocx`) a note that does not fit is not placed, and its citation gets no link. (v9j3.3.4)

- **Footnotes and endnotes in table cells.** A run in a Flow table cell may now cite a note — `addCell([{ text }, { text: '', footnote: { content } }])` — and Markdown and DOCX tables do the same. Until now a hand-built flow threw `TypeError`, and Markdown and DOCX reported the citation and drew nothing (Markdown as its literal `[^label]`). `table()` lowers the cited runs on a private copy of the builder, so the builder you passed is never changed and `page.AddTable`, which has no foot to put a note at, still refuses such a run. A table splits by row, so a row and its notes always share a page: a cited row that does not fit with its note moves on. A note cited from a repeating header row is placed once, with the first slice, while its mark repeats in the header on every page. Under a tagged flow the `/Note` sits under the cell's `/TD` or `/TH`. Numbering runs row-major, and `restart: 'page'` and `RestartNotes` apply as they do to paragraphs. `addCell` and `addRow` are typed to accept the note-carrying `FlowTextRun`. Checked against Word 2010: the footnote Word places in a table cell of the `notes` corpus file now draws as number 3 of its section, as Word numbers it. (v9j3.3.3)

- **Word footnotes and endnotes.** `flow.AddDocx`, `page.AddDocx` and `doc.AddDocx` used to report every footnote and endnote reference as dropped; now the notes render through the Flow footnote engine. The reader parses `footnotes.xml` and `endnotes.xml` with the same code as the body, so a note keeps its paragraphs, lists, tables, images and links. A note's links and images resolve against that part's own relationships, not the document's. Word's separator entries are skipped, and a custom mark (`w:customMarkFollows`) is drawn as the mark. Word's numbering is honoured: the format (decimal, lower/upper roman, lower/upper letter, chicago symbols), the start, and a restart each section or each page, read from `settings.xml` and the last section. A section with a different format, a note placement the engine cannot do, and a reference to a missing note are reported in `skipped`. `page.AddDocx` places the notes after the content inside its rect, tagged under a `structParent`. Checked against Word 2010 and LibreOffice 26.8 reading a new `notes` recipe in the DOCX corpus. That corpus found that Word writes a custom mark into the note body and that LibreOffice puts a tab after its own number; both would otherwise have been drawn. LibreOffice also ignores Word's per-section restart, so that rule is held to Word alone. (v9j3.3.2)

- **Note numbering that restarts.** `flow.RestartNotes(kind?)` restarts footnote or endnote numbering (or both) at a point in the flow and draws nothing. `footnotes: { restart: 'page' }` numbers footnotes from 1 on every page. A footnote's number then depends on where its line lands, so it is assigned each time its element is offered to a column, before anything is measured there. A line pushed to the next page is renumbered there, its gutter mark with it, and a mark never changes after its line is placed. Endnotes refuse `'page'`, since they do not sit on the page that cites them. A flow using neither is byte-identical, and a hash fence recorded before the change holds that. (v9j3.3.2)

- **Markdown footnotes.** With `{ gfm: true }`, `parseMarkdown` reads GitHub's footnotes — `[^label]` citations and `[^label]: …` definitions, which may hold several paragraphs, block quotes, lists and code indented under them — and `flow.AddMarkdown`, `page.AddMarkdown` and `doc.AddMarkdown` render them through the Flow footnote engine. The grammar is transcribed from `cmark-gfm`, GitHub's own implementation, function by function, and checked against the 10 footnote examples in its test data, vendored at pinned commits — the GFM spec document predates the extension and has none. In the tree a citation is an `MdFootnoteReference` numbered by first citation, labels match by Unicode case folding as link labels do, the first definition of a label wins, an uncited definition is dropped, and a citation with no definition stays as its literal text; the cited definitions sit on `MdDocument.footnotes` in number order. Rendered, the mark takes the style of the text it follows — a citation in bold text gets a bold mark — and the note goes at the foot of the column, or after the content with `footnotePlacement: 'end'`, as GitHub shows it. A definition cited three times is one note under one number with three marks. Note bodies are mapped by the same code as top-level blocks at `style.footnoteSize` (default 8pt), with their code and heading sizes scaled to match. `page.AddMarkdown` has one rect and no column foot, so it numbers the notes and places them after the content inside the rect, under the separator; what does not fit is in the returned `remainder`, and under a `structParent` each note is a `/Note` beside its citation, as in a tagged flow. Note bodies default to the flow's own note size under `flow.AddMarkdown`, so the gutter mark always matches the body it labels. A citation inside another note is drawn as its literal `[^label]` and reported in `skipped` as `footnote (nested)`, rather than refused; a citation in a table cell renders since v9j3.3.3. With `gfm` off nothing changes. (v9j3.3.1)

- **Footnotes and endnotes in Flow.** A run in `AddParagraph`, `AddHeading` or a list item cites a note with `{ text, footnote: { content } }` or `endnote`, where the body is text, runs, or any flow elements — a list or an image in a note. Marks are numbered across the flow before anything is laid out (footnotes `1, 2, 3`, endnotes `i, ii, iii` by default; `format` also offers upper roman, alpha and `* † ‡ § ¶ #`, every one drawable in a Standard-14 face), so a mark's width never changes after a line was measured; a `mark: '*'` overrides one and takes no number. A footnote is placed at the foot of the column holding its reference, under a separator rule. Before each element is placed, the engine asks which references the lines that would fit contain and finds the largest budget at which those lines and their whole notes share the column — so the lines above a reference still fill the page, a line whose note will not fit below it moves on with its note, and only a note too tall for an empty column is split, continuing at the foot of the next. A column filled by an earlier note's continuation holds later content back rather than separating another reference from its note; the footnote area never rises over a float; and a heading kept with its next paragraph counts that paragraph's own footnotes. Endnotes follow the flow's content, or start a new page with `endnotes.newPage`. In a tagged flow each note is a `/Note` holding its mark and its body, placed as a child of the element that cites it — so assistive technology reaches a note where it is referenced — with an `/ID` registered in the structure tree's `/IDTree`; the separator is an artifact. A flow citing no note takes exactly the path it took before, so its output is byte-identical. A note reference anywhere else — a table cell, a floating box, `AddTextBlock`, a single-rect placement such as `placeElements` — is refused with an error rather than drawn without its note. Markdown footnotes followed in v9j3.3.1, which also let one `FlowNote` be cited more than once; Word footnotes are a separate follow-up. (v9j3.3)

- **`TextRun.rise`.** A run may shift its baseline by `rise` points, emitted as `Ts`: the superscript behind a footnote mark, and available on any run. It moves the ink and not the layout — the line keeps the height its font size gives it — and the run's own underline, strikethrough, background and link rectangle follow the raised baseline, while a block-level decoration stays on the line. A run without `rise` emits nothing new. (v9j3.3)

- **Hyphenation in reflow.** `ReplaceText` and `RestyleText` with `adjust: 'reflow'` take `hyphenate` — the options `AddTextBlock` takes — and break a word that no longer fits at a Liang pattern point (or a soft hyphen with `mode: 'manual'`), drawing a hyphen in the word's own font, else the registered same face or a `fallbackFonts` face; a point no face can draw is skipped. Until now a word that no longer fit moved whole to the next line, leaving ragged gaps a fresh layout would have hyphenated. The wrap goes through the same engine as `AddTextBlock` — every drawn glyph or replacement character becomes one run measured at its exact advance — so a reflowed paragraph breaks exactly as a fresh hyphenated block of its new text would, which is what the tests compare against, glyph origin by glyph origin, in ragged and justified text. A replacement hyphenates too, split inside its own show operator with a `Tm`, keeping its style on both halves and on the hyphen. Without `lang` each paragraph uses its own `/Lang` (structure element, then document), and one with no bundled patterns reflows whole words. A soft hyphen (U+00AD) ending a line is removed when the reflow rejoins its halves. A drawn `-` is always kept: it may be an author's compound hyphen, and the patterns cannot tell — English breaks `wellknown`, `selfevident` and `cooperate` exactly where the compound's hyphen sits — so removing one would silently rewrite `well-known` as `wellknown`. The cost is that re-wrapping text hyphenated with drawn hyphens can bring one mid-line. Links, text-markup annotations and `RestyleText` decorations over a split word cover each line it lands on, the head through its hyphen. Off by default, and then output is byte-identical. (6y39)

- **Opt-in hyphenation.** `hyphenate: { lang }` on `AddTextBlock`, Flow paragraphs and lists (or once on the flow), table cells and `AddMarkdown` breaks a word that does not fit at a Liang pattern point and draws a hyphen, choosing the rightmost point that fits; a word wider than the whole column hyphenates before falling back to the plain split. Patterns for en-US, en-GB, de, fr, es, it, nl, pt and pl come from TeX's hyph-utf8 at a pinned commit, ship compressed, and are decoded only when a document first asks for that language; each carries its own licence. `mode: 'manual'` uses only the soft hyphens (U+00AD) already in the text, which are then invisible except at a break. A tag matches by RFC 4647 and an unlisted region falls back to its language (`en-AU` → en-US); French and Italian elisions hyphenate as the patterns intend. A word's later lines reuse the whole word's break points rather than treating each remainder as a new word, and the break is chosen in time linear in the word. The engine agrees with `hyphen`, an independent JavaScript implementation, on all 145 reference words across the nine languages. Off by default, and then every byte of output is what it was. (v9j3.2)

- **A replacement `color` reaches stroked text and colours named outside a form.** `ReplaceText` and `RestyleText` changed only the fill, so outlined text (render modes 1, 2, 5 and 6) kept its old stroke and a stroke-only replacement did not change colour at all; such text is now stroked in the new colour too, and the previous stroke put back after it. And where the colour in force had been set through a named colour space or pattern on the page while the text sits in a Form XObject — `/P0 scn` before a `Do` is the common shape — the call was refused, since the name does not resolve inside the form. That entry is now copied into the form's own `/Resources`, under the key that already names it there or a fresh one, so the restore draws the same colour. Fill-only text is written exactly as before. (u3l5.9)

- **`RestyleText` changes how found text looks without changing it.** `page.RestyleText(find, style)` and `doc.RestyleText(...)` take `color`, `fontSize`, `font`, `underline`, `strikethrough` and `background`. Colour, size and font go through `ReplaceText`'s own machinery with each match rewritten as its own text, cut at every show-string boundary so no part of a match moves to another operator; a colour alone keeps the original glyph bytes, and a font change re-encodes with `fallbackFonts` and `onUndrawable` as `ReplaceText` does. Decorations use the vocabulary and geometry of `AddText`'s `DecorationOptions`, so a restyled word and an authored one decorate alike — checked against `AddText` itself — and are painted in the text's own content stream, the background just before its text object and the rules just after, in a frame along the text's own baseline, so rotated, scaled and form-drawn text is decorated where it is. Metrics come from the restyled font, else the drawn font's embedded program, its Standard-14 family, or its descriptor. A size or font change can use `adjust`, and a decoration follows a word `'reflow'` moves. Decorations are artifacts in a tagged document, placed outside the structure content they decorate. A decoration starts where the text now starts — after an earlier resized match or an `adjust` kern on the same line — and a form several pages share through one `/Resources` dictionary is restyled once by `doc.RestyleText`. Vertical text, and a text object split across content streams, are refused before anything changes. (u3l5.6)

- **`ReplaceText` can re-wrap the paragraph around a replacement.** `adjust: 'reflow'` moves words between lines so a longer or shorter replacement reads like text that was always there. Words wrap through `layoutRuns`, the engine `AddTextBlock` uses, as unbreakable units — a replacement containing spaces is one unit, so it is never split across lines; the paragraph keeps its alignment — left, right, centred or justified, detected from its original line edges — and its first-line indent, and grows only into free space below it. A ragged paragraph wraps to the width of its widest line, the only width the page records. Lines before the edit keep their breaks, and once a new break lands on an original one the rest keep theirs too, moving by the lines added, since a producer's breaks need not be the ones a greedy wrap would choose. Nothing is re-encoded: each moved word gets a `Tm` or a `TJ` kern, so fonts, colours, the producer's own `TJ` kerning and marked content survive, a Form XObject drawn twice is rewritten once, and after the paragraph the line matrix is put back so a following paragraph positioned by `Td` does not move. Links and highlights, underlines, strike-outs and squiggles over the paragraph get new quads from their moved words, one per line, and a markup annotation's appearance is redrawn for its new rect. A tagged document's paragraph is its block-level structure element; otherwise it is the text block `GetStructuredText` reports, through one shared grouping. A paragraph that could be overprinted is refused rather than guessed at — vertical, rotated or unequally scaled text, two columns sharing baselines, glyphs in two scopes, another paragraph's text in the same pen chain, other ink inside it, an annotation that is not anchored to text, uneven line spacing, or no room below — with `UnsupportedFeatureError` naming the reason, or through `onUnreflowable`, which replaces that paragraph without reflow and reports `{ page, match, reason }`. Checked against `AddTextBlock` itself: reflowing a left or justified block to new text puts every glyph where a fresh block of that text, in the paragraph's measured box, does. `GlyphEvent` gains `tm`, `tlm` and `ctm`. (u3l5.5)

- **`ReplaceText` can keep the rest of the line in step with a replacement of a different width.** `adjust: 'shiftRest'` moves everything after the replacement on its line by the width difference, so a longer word no longer runs into the next one. `adjust: 'spaceWidth'` takes the difference out of the word gaps after the replacement instead, so the line keeps its end. A gap gives up at most half its width, so words never touch, and what the gaps cannot absorb shifts the rest of the line; a run of spaces counts as one gap. `adjust: 'none'`, the default, writes exactly what it wrote before. Before this, text after a match in the same show operator moved with it while text positioned by its own `Td` or `Tm` did not, so a wider replacement overlapped it. Both modes insert `TJ` kerns, and only where needed: the planner tracks the shift each glyph already gets from the pen and the shift it should get, and writes a kern only where they differ. The width difference is measured with the matched text's own `Tc`, `Tw`, `Tz`, size and scale. It includes the TJ kerns a match drops and any styled size. The suite checks it against the renderer's own pen: a follower in a separate operator lands exactly where one in the same operator does. "The rest of the line" is the page's reading order, so a word drawn earlier in the stream but later on the line moves too. Vertical text is refused. `GlyphEvent` gains `charSpacing`, `wordSpacing` and `hscale`, the `Tc`, `Tw` and `Tz` in force. (u3l5.4)

- **`ReplaceText` matches by case and whole word, and styles the replacement.** `ReplaceTextOptions` gains `ignoreCase`, `wholeWord`, `font`, `fontSize` and `color`, and `doc.ReplaceText` takes them like `page.ReplaceText`. `ignoreCase` and `wholeWord` are search options, so `Search`, `SearchAnnotations`, `RedactText` and `MarkRedactText` take them too. A string is matched under Unicode simple case folding and a `RegExp` gains the `i` flag. A whole word has no letter, digit, combining mark or `_` on either side; a rejected match resumes one character on rather than past its end, so in `ba a a` the whole-word `a a` that starts inside the rejected one is still found. `font`, `fontSize` and `color` restyle the replacement alone, never the text around it. The font and size switch with `Tf` and back. `fontSize` is in points as rendered, so text drawn under a 2x scale gets a `Tf` of half the number. The colour is set with `rg`, and the previous fill is put back by re-emitting the operators that set it, its `cs` included, so a CMYK or spot fill stays CMYK or spot rather than becoming its RGB approximation. To make that possible `GlyphEvent` gains `fillState`, the fill operators in force and the scope that named them. A size or font change where no font can be named — a Form XObject without its own `/Resources` — is refused, and so is a colour whose fill came from a named colour space set outside the form, which would not resolve inside it. Both refusals happen while planning, so the document is unchanged. `MarkRedactText` used to pass `includeHidden` on to the annotation options; it no longer does. (u3l5.3)

- **`ReplaceText` falls back to other fonts for characters the matched font cannot draw.** `page.ReplaceText(find, replacement, { fallbackFonts })` and now `doc.ReplaceText(..., options)` write each character in the first font that can draw it: the matched glyph's own font, then — with `matchRegisteredFonts: true` — the same face found by PostScript name in folders registered with `RegisterFontFolder`/`RegisterSystemFonts` (the subset tag stripped from `/BaseFont`), then each fallback in order, Standard-14 names or `AddFont`/`LoadFontByName` handles. The decision is per character, so only what the original cannot draw changes face. A foreign run is written by splitting the show operator and switching font with `Tf`, at the original size, spacing and colour, and the original font is restored straight after, so the rest of the line is drawn as before. A replacement the original font can fully draw is byte-identical to before. A character no font can draw throws `UnsupportedFeatureError` naming it and the page, or, with `onUndrawable`, is left out and reported as `{ page, match, missing }`. A scope that cannot take a switch — a Form XObject without its own `/Resources`, or one whose font was set on the page and inherited — gets no fallback. `GlyphEvent` (and so `TextMatch.hits`) gains `tfKey` and `tfSize`, the `Tf` in force. Re-subsetting the document's own embedded font to add glyphs is not done. (u3l5.2)

- **Sanitize reports an embedded search index.** An embedded search index, which Acrobat Pro adds through Manage Embedded Index, is a word index of the document's text. It holds every word, so it is the one piece of private data that can keep the content of text a sanitized page no longer shows. It lives in the catalog's `/PieceInfo` as `/SearchIndex`, holding a `%PDX-3.2` catalog stream and the `.idx` word data. `privateData` was already removing it with the rest of `/PieceInfo`. The report's `privateData.searchIndex` now says when one was there. The location comes from the strings of Acrobat DC 26.1's own `Search.api` plug-in: that release names `PieceInfo`, `SearchIndex`, `IsFreshIndex`, `PDXFile` and `IndexFile` in that order in the code that embeds the index. No file indexed by Acrobat itself is vendored yet. (74mf.5)

- **Sanitize's removals are checked in the saved file, and an incremental save after it is refused.** After `doc.Sanitize()`, `Save({ incremental: true })` now throws `UnsupportedFeatureError`. An incremental update appends to the bytes the document was opened from, and those still hold every removed script, attachment and comment, so a "sanitized" file saved that way carried all of it in its first revision. A plain `Save()` writes a fresh file and was always clean, and it also drops any earlier revisions the opened file carried. Every category is now checked against the SAVED bytes rather than the live model, plain and compressed. The search reads the raw file, every object as re-serialized, and every stream's DECODED payload, and checks hex and UTF-16 spellings of each marker. A raw byte search alone cannot see inside a deflated stream: an attachment's contents never appear in the file as written, so such a check passes whether the attachment leaked or not. Each check is therefore paired with a control that must find every marker in the unsanitized file. (74mf.4)

- **Sanitize can replace every page with its rendering.** `doc.Sanitize({ pagesToImages: true })` renders each page and replaces its content with that one image, which removes what a page hides in its own content — white text on white, text under a picture, glyphs clipped away or outside the crop box — that no key-level removal can reach. It is the one Sanitize category that is off by default, because it is lossy: the page stops having text, vectors and fonts. An object chooses `dpi` (default 150, at most 1200), `format` (`'flate'`, lossless, the default, or `'jpeg'`) and `quality` (JPEG only). The page dictionary is kept, so its size, `/Rotate`, crop box, labels and every link or bookmark pointing at it stay valid. The image is drawn through the inverse of the render's own page-to-pixel matrix, so a rotated page or one whose crop box is off the origin renders within two levels per channel of the original. Annotations are left out of the rendering; those that survived the other categories stay annotations rather than being drawn twice. The page tree's inherited `/Resources`, each page's `/Group` and the structure tree go too, since the marked content they described no longer exists. No text layer is kept: one built from the page's own text would carry exactly the hidden text this removes, so the README shows following it with `MakeSearchable`, which OCRs the rendering and finds every converted page image-only. A bad `dpi`, `format` or `quality`, or a `quality` without `'jpeg'`, is refused before anything changes. (74mf.3)

- **Sanitize removes private application data too.** `doc.Sanitize()` gained a seventh category, `privateData`, also on by default. It removes `/PieceInfo` page-piece dictionaries — where producers such as Illustrator keep private application data, sometimes a whole native copy of the artwork — together with the `/LastModified` stamp that dates each one. It covers the catalog, pages and form XObjects, the last reached only through `/Resources`, which is why every object is visited rather than only the catalog's tree. It also removes page `/Thumb` thumbnails, web-capture data (catalog `/SpiderInfo` and page `/ID`) and the catalog `/Perms` dictionary, which is how Reader usage rights are granted, so a file that enabled commenting in Reader stops doing so. Anything only these referenced is dropped by the next `Save()`. `/LastModified` on a dictionary with no `/PieceInfo` is left alone. The report's `privateData` section counts each. (74mf.2)

- **Remove hidden data in one call.** `doc.Sanitize(options?)` removes what a document carries beyond what it shows, in place, and returns a `SanitizeReport` saying what each category removed. The six categories are each on by default, and `false` keeps one. `metadata` removes `/Info` and every XMP packet, the catalog's and object-level ones alike. `actions` removes document-level JavaScript, `/OpenAction`, every `/AA` (catalog, page, annotation and field — including a non-terminal field node, which no annotation walk reaches) and every annotation and bookmark `/A`. A GoTo action on a link or bookmark becomes the plain `/Dest` it named, with its `/Next` chain dropped, so navigation survives and the script slot does not. `attachments` removes the `/EmbeddedFiles` tree, a catalog `/AF` (including a PDF/A-3 file the tree does not list), file-attachment annotations with their popups, and a portfolio `/Collection`. `annotations` removes every other annotation except form widgets; it removes them rather than flattening them. `forms` flattens the form, so values are baked in and `/AcroForm` goes. `layers` flattens optional content first, so hidden widgets and annotations are deleted before anything bakes them in. Before the same call existed, each of these was a separate call, and `/AA`, outline actions and object-level XMP had no call at all. A report section is `undefined` when its category was kept, so "kept" reads differently from "nothing found". An unknown or non-boolean option is a `TypeError`, so `{ metaData: false }` cannot silently strip what it meant to keep. A signed document is refused with `UnsupportedFeatureError`, because `Save()` would otherwise return the signed bytes and discard every change. Both refusals happen before anything changes, and a document with nothing to remove is not marked modified. Removing XMP also removes any PDF/A or PDF/UA identification. (74mf.1)

- **Graphical comparison.** `doc.CompareRendering(other, options?)` renders each page pair and reports which pixels changed: per page the changed and total pixel counts, their ratio, and the changed regions as page-space rectangles, plus document totals and an `identical` flag. It sees what text comparison cannot — a recoloured heading, a replaced image, a moved line — and says where, not what. `dpi` sets the resolution (default 72); `tolerance` lets each channel differ by up to n of 255 levels before a pixel counts, to absorb anti-aliasing noise between producers; `mergeDistance` (points, default 6) joins changes that close into one region; `annotations: false` leaves annotation appearances out. `image: true` adds a PNG per page: the second document's page faded, every changed pixel in red. Regions go back to page space through the inverse of the render's own page-to-pixel matrix, so rotated and cropped pages need no special handling, and grouping runs on a coarse grid so a noisy difference costs time linear in the page rather than quadratic in its specks. A page only one document has is compared against a blank page. Neither input is changed. (aq4a.5)

- **Side-by-side comparison PDFs.** `doc.CompareSideBySide(other, options?)` returns `{ document, comparison }`: a new document with one sheet per page pair — this document's page on the left, `other`'s on the right, tops aligned, separated by `gap` points (default 20) — with each deletion highlighted on the left and each insertion on the right. By default the marks are highlight annotations whose note says what changed (`Deleted: quick`), so a reader can step through them in a viewer's comment list; `marks: 'content'` draws translucent boxes into the page instead, for viewers and printers that hide annotations. A page only one document has gets its own sheet with the other half left empty. Pages are placed as Form XObjects at full size, honouring `/Rotate` and the CropBox, and each mark moves by exactly the transform its page did, so a mark lands where `Search` on the result sheet finds the same word. Neither input document is changed. The comparison options pass through as `compare`; colours as `deleteColor` and `insertColor`. With `tagged: true` the result is tagged: it carries both documents' structure trees, the first and then the second, each half of every sheet resolving to its own document's elements; every highlight is an `/Annot` element whose alternate text is its note, collected in a `Changes` section; drawn boxes are artifacts; and the first document's language is kept. The two pages on a sheet both number their marked content from 0, so the right page's are renumbered in its placed copy — inline, through named property lists and inside nested forms — and its structure is cloned with the same offset. Two Word 2010 revisions compared this way report exactly the PDF/UA issues the source files do, and no untagged content; a source that was never tagged contributes no structure, and its half stays untagged. (aq4a.4, aq4a.7)

- **Comparison reports in HTML, Markdown and JSON.** `comparisonToHtml(result, opts?)`, `comparisonToMarkdown(result, opts?)` and `comparisonToJson(result, opts?)` write out what `doc.CompareText` found. HTML marks deletions with `<del>` and insertions with `<ins>`, as a complete document with a style sheet and a summary line (deleted and inserted counts, similarity) or, with `fragment: true`, as markup to embed. Markdown uses GitHub's `~~deleted~~` and `**inserted**` around whole words; at character granularity it uses inline `<del>`/`<ins>` tags instead, because a mark inside a word next to punctuation would leave delimiters that do not close. Every Markdown output is checked by reading it back with this library's own GFM parser. Unchanged text is shown in the second document's spelling, so the report reads as the new version with deletions struck in place; `context: n` keeps n unchanged words either side of each change and cuts longer stretches to `…`. A change that is only whitespace is shown as `␣` rather than vanishing inside its mark. Pages mode gives each page pair its own section, headed by its page number and whether only one document has it. JSON carries the granularity, stats, `minimal` and every change, with page spans unless `spans: false`. `TextComparison` gained a `granularity` field, which says how runs join. (aq4a.3)

- **Compare the text of two documents.** `doc.CompareText(other, options?)` returns what was deleted, inserted and kept, as runs in reading order with token counts and a `similarity` score. Each run carries `TextSpan`s — page number, text and one page-space quad per line — computed by the same layout and placement `Search` uses, so a changed word has exactly the quads `Search` would report for it and can be highlighted on either document. By default each document is read as one text, so text that reflows across a page break is no change; `mode: 'pages'` pairs page with page and reports an unmatched page as wholly inserted or deleted. `granularity: 'character'` finds changes inside words, with whitespace collapsed (a moved line break is no change) or ignored; `ignoreCase`, `region` and `exclude` scope the comparison by `Search`'s centroid rule; hidden optional content is left out unless `includeHidden`. The diff is Myers' algorithm in linear memory and finds the smallest diff — checked against an independent longest-common-subsequence table — up to a search budget; past it a stretch is reported as a whole deletion plus insertion and `minimal` says so, so a refused search is never mistaken for a rewrite. By default a semantic cleanup then folds every unchanged stretch strictly shorter than the edits on both sides of it into one change, so a deleted sentence and the paragraph replacing it are not split around a word they happen to share; `cleanup: 'none'` returns the smallest diff. Two revisions of a document written by Microsoft Word 2010 are vendored with the list of edits made between them, and the comparison reports exactly those edits — that pair is what showed the cleanup was needed, and that diff-match-patch's `<=` rule merges independent one-word edits on words where strictly shorter does not. Comparison is of text: appearance-only changes do not register. (aq4a.2)

- **Summaries, document Q&A and image alt-text.** `doc.Summarize(model, opts?)`, `doc.Ask(model, question, opts?)` and `doc.GenerateAltText(model, opts?)` work with any `AiModel`. `Summarize` handles documents larger than one request by summarizing page-anchored chunks and combining the partial summaries, level by level; an `instructions` option shapes the final summary only, so "in German" does not translate every intermediate one. `Ask` cuts the document into overlapping passages, ranks them against the question locally with BM25 over `Intl.Segmenter` words — so CJK and Cyrillic rank correctly, with no extra model calls — and sends the best few in one request; the result carries the answer, a `found` flag that is false when the passages did not contain it rather than a guess, the cited pages (a page the model was not shown is dropped as invented), and the passages sent. `GenerateAltText` writes `/Alt` for every `/Figure` with neither `/Alt` nor `/ActualText`, so a tagged document stops failing PDF/UA's `IllustrationAlt`; it sends the figure's images, or a render cropped to its extent for a vector chart, with the page's text as context and the document's language. An untagged document has its pictures described and is then auto-tagged with those descriptions. Identical pictures are described once, an author's `/Alt` is kept unless `overwrite`, and a failing figure is reported while the run continues. Budgets are characters (default 48,000 per request), since the library does not know a model's tokenizer. (3ywf.4)

- **Scanned pages become searchable.** `doc.MakeSearchable(engine, { pages?, force?, dpi?, signal?, onPage? })` renders each image-only page, hands it to an `OcrEngine` you supply, and writes the recognized text as an invisible (render mode 3) layer placed exactly over the words in the picture, so `GetText`, `Search` and copy-paste find them and the page renders byte-for-byte as before. `aiOcrEngine(model)` is an engine over any `AiModel` — one request per page asking for lines and boxes on a 0–1000 grid; a dedicated OCR engine (Tesseract, a cloud OCR API) plugs into the same `recognize(image)` interface, and is the better choice when highlight precision matters, since vision models box coarsely. Each span's box is mapped back through the renderer's own page-to-pixel matrix, so rotated pages and offset crop boxes need no special case. The text uses a built-in glyphless font — an embedded TrueType with one empty glyph, a code per distinct character and a `/ToUnicode` map — so every script, Cyrillic, CJK and Arabic included, extracts with no font files, and PDF/A-2b and PDF/UA validation report nothing new; a tagged document gets the layer as an artifact. Pages that already have text are skipped and reported unless `force`; a page the engine fails on is reported and the run continues; an abort stops it, keeping finished pages. Signed documents are refused. Right-to-left text is written in logical order: this library extracts it correctly, other viewers may reorder it. (3ywf.3)

- **An AI model client, the seam for AI features.** `AiModel` is a one-method interface (`complete({ messages, schema?, maxTokens?, signal? })` → `{ text, usage? }`) that upcoming AI features — OCR into an invisible text layer, summarization, alt-text — take as an argument, so any provider, a local model or a test stub plugs in as a few-line object. `openAiModel(baseUrl, { model, apiKey?, … })` implements it for any OpenAI-compatible server (OpenAI, Ollama, vLLM) over Node's built-in `fetch`: still no runtime dependency, and no default endpoint, per the decision that this library reaches a host only through a client the caller builds. Messages carry text and PNG/JPEG bytes — never URLs, which would have the provider fetch something a document named. An optional JSON Schema is passed to the model as `response_format`; the library does not validate replies against it. Each attempt is bounded by a timeout (120 s) and a response cap (4 MiB, enforced while streaming, so a missing or false `Content-Length` cannot bypass it); HTTP 429, 500, 502, 503 and 504, network errors and timeouts are retried twice by default, honouring `Retry-After` and otherwise backing off 1 s then 2 s; a `Retry-After` longer than 30 s fails at once rather than being waited out. A `baseUrl` carrying credentials, a query or a fragment is refused at construction, since every error message names the endpoint. A reply cut off at `maxTokens` throws `AiServiceError` instead of returning a truncated answer, and the API key is redacted even from provider messages that echo it, as OpenAI's 401 does. `maxTokens` is sent as `max_tokens`, which local servers understand; OpenAI's reasoning models reject it. (3ywf.2)

- **Word documents render to PDF.** `doc.AddDocx(bytes)` renders a `.docx`
  as freshly sized pages, `flow.AddDocx` appends one to a flow beside other
  content, `page.AddDocx(bytes, rect)` lays one into a rectangle, and
  `docxFileToPdf(in, out)` does the whole trip from a file. It is a documented
  subset over the existing flow engine rather than a Word layout engine, so
  the result paginates, tags (`/H1`..`/H6`, `/P`, `/L`, `/Table`, `/Figure`)
  and mixes with Markdown, HTML and hand-built content — and it reflows rather
  than reproducing Word's line breaks. What renders: paragraphs with their
  resolved styles, alignment, spacing, line spacing and indents; headings by
  outline level; bold, italic, underline, strike, size, colour and highlight;
  lists; tables with column spans, vertical merges, shading and repeating
  header rows; images inline and as block figures; external hyperlinks; and
  the last section's page size and margins. Lists carry Word's OWN labels
  (`1.a)`, numbering that continues across an interrupting paragraph), which
  is why the flow engine gained `FlowListItem.label`, and Word's indents
  render because paragraphs and headings gained an `indent` option (`left`,
  `right`, `firstLine`, negative for a hanging indent) — both opt-in, with
  existing output byte-identical. A font that is not registered falls back to
  Times, Helvetica or Courier by the class the DOCX's own font table states
  for it, rather than by a guessed table of font names, and is reported.
  Adjacent paragraph spacing COLLAPSES to the larger of space-after and
  space-before: the design assumed Word adds them, and measuring Word 2010
  through COM over seven cases showed it does not. Everything outside the
  subset is counted in `skipped` as `{ name, count, kind }` — `dropped` for
  what drew nothing (headers, footers, footnote references, an unreadable
  image) and `degraded` for what drew differently (tab stops, internal links,
  fields, tracked changes, a nested table) — so a caller can tell a lost
  construct from an empty document. Legacy `.doc` is not read. (m2fp.5)

- **Acrobat's standard form scripts now take effect, without running any
  JavaScript.** A field's calculate, format, keystroke and validate scripts
  are recognised when they are exactly one call to one of Acrobat's 17
  standard AForm functions with literal arguments — `AFSimple_Calculate`,
  `AFNumber_Format`, `AFDate_FormatEx`, `AFRange_Validate` and the rest — and
  implemented natively. Everything is opt-in, so existing output is unchanged:
  `form.Recalculate()` recomputes totals once, in `/CO` order, as Acrobat
  does; `field.FormattedValue`, and `{ format: true }` on
  `GenerateAppearances` and `FlattenForm`, draw `$1,234.50` rather than
  `1234.5` while `/V` stays raw; `form.CheckValues()` reports values the
  form's own rules reject; and `form.EnforceRules = true` makes the `Value`
  setter refuse them. A script that is anything else is reported, never run.
  The semantics are transcribed from pdf.js's Apache-2.0 AForm and checked
  against 11,448 goldens generated from it, and the recogniser accepts 59 of
  the 63 AForm scripts in pdf.js's own Acrobat-authored test corpus — the
  other four are expressions or a mistyped argument, correctly refused. Three
  divergences are stated in the README: strict date matching, no red text for
  negative numbers, and no rewriting of a value under `EnforceRules`. (jzn8)

- **`Optimize({ images: { progressive: true } })` writes progressive JPEG.**
  The image pass wrote baseline (SOF0) only. With the flag it writes a
  spectral-selection progressive file (SOF2): one interleaved DC scan, then
  one AC scan per component, coding trailing zeros as EOB runs. Successive
  approximation is not written. The decoded pixels are the baseline
  encoding's exactly, checked through `jpeg.ts`'s own progressive decoder. A
  scan walks the component's own block grid rather than the MCU-padded one,
  which is what a 227x149 photograph with subsampled chroma exercises.
  Measured on libjpeg's `testorig` photograph at the default 4:2:0, the file
  is 1.5-2.2% smaller at quality 50-90. At 4:4:4 it is 0.8-1.6% LARGER, since a
  scan per full-resolution chroma plane does not repay itself on a small
  image. On a flat image the EOB runs halve the file (8,710 bytes to 4,451).
  `encodeJpeg` takes the same `progressive` option (29z6.5).
- **`ConvertToPdfA` embeds the bundled substitute for a non-embedded Latin
  Standard-14 font.** It used to report every such font as `FontEmbedded`
  unresolved, on a stated rule of never fabricating assets. A simple `/Type1`
  font naming one of the twelve Latin faces exactly (Helvetica, Times, Courier
  and their styles) now becomes a non-symbolic `/TrueType` with the bundled
  Liberation face as `/FontFile2`, shrunk to the glyphs the page shows. Its
  encoding is rewritten to express the same code -> glyph map over the WinAnsi
  or MacRoman base ISO 19005-2 6.2.11.6 requires. A font with no `/Encoding`
  keeps StandardEncoding's meaning through explicit `/Differences` (`'` stays
  quoteright). `/Widths` is kept, or written from the AFM metrics the text was
  laid out with. The page renders exactly as the non-embedded page did,
  because the renderer already drew these fonts from the same bundled faces.
  The font is declined and left unresolved when a shown code's width disagrees
  with the face's advance by more than 1/1000 em. It is also declined when a
  shown code has no glyph in the face, and for Symbol and ZapfDingbats. The
  width check applies to SHOWN codes only: measured, the Helvetica and Times
  AFMs disagree with the faces on five codes (¯ ± µ · ÷), and failing every
  Helvetica font over an unused `±` would make the pass useless.
  `preserve: ['fontEmbedding']` keeps the old behaviour (29z6.6).
- **`Optimize({ unembedStandard14: true })` removes Standard-14 font
  programs.** It is off by default. It deletes the `/FontFile*` key of a
  simple `/Type1` font whose `/BaseFont` names a Latin Standard-14 face
  exactly (a subset prefix aside; an alias such as `Arial` does not count),
  and nothing else: `/Widths`, `/Encoding` and the descriptor stay. It declines
  per font, reported in `report.unembedSkipped`, wherever a viewer's built-in
  face could draw a different glyph for a code: an encoding the embedded
  program defines, a `/Differences` with no `/BaseEncoding` (relative to that
  program) or naming a glyph outside the Latin sets, a descriptor shared with
  a non-Standard-14 font, and Symbol and ZapfDingbats. It also declines on a
  document that declares PDF/A, whose conformance it would break. Run before
  `ConvertToPdfA`, conversion embeds the bundled substitute again (29z6.6).
  Measured: unembedding NimbusSans-Regular under `/BaseFont /Helvetica` saves
  its 104 KB program (29z6.4).
- **`Optimize` merges duplicate images by their decoded pixels.** The dedup
  pass used to hash ENCODED payloads. So one picture stored twice, once raw and
  once Flate-compressed (what merging two differently produced documents
  routinely yields), survived as two copies. An image XObject coded only with
  cheap lossless filters (Flate, LZW, RunLength, ASCIIHex, ASCII85) is now
  keyed by its decoded samples plus its dict without the encoding entries. The
  same bytes read as 16x16 RGB and as 16x48 gray are therefore still two
  images, and a one-sample difference is never merged. DCT, JPX, CCITT and
  JBIG2 images keep the byte-identical rule, because decoding them to compare
  would cost more than it finds. The survivor of a group is its smallest
  payload, so the compressed copy is kept. The pass repeats until nothing
  merges, so two images become one once their raw and Flate soft masks have
  merged (29z6.3).
- **`Optimize` subsets OpenType-CFF whole-embeds.** A `/FontFile3` with
  `/Subtype /OpenType` and CFF outlines used to be skipped with "OpenType
  FontFile3 is CFF-outlined". That is the shape an `.otf` takes when its CFF
  will not rebuild. Such a font is now subset as the sfnt it is. The `CFF `
  table goes through the existing CFF shrink that matches its keying: CID-keyed
  stays CID-keyed, and name-keyed keeps its charset names and built-in
  encoding. Every other table is copied through, so `cmap`, `hmtx` and `post`
  still describe the same glyph ids. The keying decides the shrink, not the
  font dict: a CID re-assembly strips a name-keyed program of the names a
  simple dict resolves through. Measured on the bundled NimbusSans-Regular.otf
  (82 KB, 855 glyphs) under a simple `/TrueType` dict, a page showing `AVA`
  goes from 63,657 to 10,919 bytes and renders byte-identically (29z6.2).
- **`Optimize` subsets Type 1 (`/FontFile`) font programs.** They used to be
  skipped outright and listed in `report.skipped`. Now every glyph the
  document never shows has its charstring replaced by an empty
  `0 0 hsbw endchar`. The glyph's name stays defined, so `/Encoding`,
  `/Differences` and `seac` references resolve exactly as before, and the
  private portion is re-encrypted with true `/Length1`-`/Length3`. The glyphs
  a kept `seac` accent composes from are kept too. `/Subrs` is copied whole,
  because any kept glyph may call it.
  Used codes resolve through the renderer's own
  32000-1 9.6.6.2 name chain. A code that names nothing, or names a glyph the
  program does not define, leaves the font whole and reports that code. Measured
  on the bundled NimbusSans-Regular (104 KB, 855 glyphs), a page showing
  `AVA` saves from 104,312 to 24,803 bytes and renders byte-identically
  (29z6.1).

### Security

- **Font programs cannot exhaust memory or spin on one glyph.** A CFF or
  Type 1 font under a kilobyte, whose subroutines call each other ten times
  per level across the ten levels allowed, exhausted the heap and killed the
  process when a page using it was rendered; a TrueType composite glyph
  fanning out the same way ran for minutes. The new `maxGlyphOperations`
  field (default 100,000) bounds the operators or composite components one
  glyph may take — measured against every glyph of 283 real faces, whose
  maximum was 274 — and raises `ResourceLimitError`. Character maps now count
  the entries they write against `maxContainerItems`: a font `cmap` with
  overlapping segments no longer spins for a minute, one whose range reaches
  0xFFFFFFFF no longer dies on the map size, and a `/ToUnicode` range running
  past U+10FFFF stops there instead of throwing `RangeError`. Fonts embedded
  in a document follow that document's `LoadLimits`, as do `AddFont` and
  `Optimize`. (ibzo.12)

- **Image files and web fonts decompress under the document's limits.**
  `AddImage`, `AddImagePages`, an SVG `<image>` and every other way an image
  file enters a document, and `AddFont` for a WOFF or WOFF2, now decode under
  the same `LoadLimits` a PDF stream does. Before, a PNG whose image data
  inflated to 4.5 GB, or a WOFF table inflating to 2.3 GB, was decompressed in
  full before anything noticed; each now stops at `maxDecodedStreamBytes`,
  `maxExpansionRatio` or, across a file's strips or tables together,
  `maxTotalDecodedBytes`, and raises `ResourceLimitError`. A WOFF whose header
  declares a table larger than those limits is refused before inflating. A PNG
  now checks its declared size against `maxImagePixels` — one claiming
  2^31 × 2^31 used to be embedded unchecked — and an oversized BMP or TIFF raises
  `ResourceLimitError` naming `maxImagePixels` where it used to raise
  `PdfParseError`. Deeply nested input no longer crashes with a stack
  overflow: `AddHtml` refuses a document nested past `maxNestingDepth` in its
  elements or in its CSS (parentheses or `calc()` thousands deep), and
  `AddSVGObject` and every XML reader refuse element nesting past it, each as
  `ResourceLimitError` — 200,000 levels used to end in a `RangeError`. An SVG
  import now counts the content it emits against `maxContentTokens`, so
  `<use>` elements referencing ten copies of each other per level can no
  longer expand without end; a 10^9-element expansion is refused after about
  four seconds. (ibzo.11)

- **Lower default pixel limits, sized from measured memory.** A page canvas
  is 16 bytes a pixel as floating point and about 25 once encoded to PNG, so
  the shipped `maxCanvasPixels` of 2^28 let one hostile page box demand a
  ~6 GiB render — half of the ~12 GiB the defaults together admitted, and
  mostly outside the JavaScript heap where `--max-old-space-size` cannot
  stop it. `maxCanvasPixels` is now 2^26 (~1.6 GiB; A4 at 600 dpi still
  fits) and `maxImagePixels` is 2^27 (~1.2 GiB at the measured 8–10 bytes a
  rendered pixel; a 100-megapixel photograph still fits). BMP and TIFF files
  read the same pixel bound instead of their own copy of the old one. Raise
  either field with `LoadLimits.defaults.with(...)` for larger work. No
  combined memory limit was added: nothing reports memory released in a
  garbage-collected runtime, so a running total would refuse long-lived
  documents; the README now publishes the measured cost of each limit
  instead. (ibzo.10)

- **A page drawing many small forms is now bounded in total.**
  `maxContentTokens` was counted afresh for every content stream parsed, so a
  page reaching thousands of Form XObjects, tiling patterns or Type 3 glyph
  procedures — each comfortably under the limit — cost as much CPU as it liked
  in `GetText`, `ToImage`, `ToSvg`, `GetPaths`, `Optimize`, redaction, the
  validators and every export built on those walks. Each walk now shares one
  count across the page's content, every nested scope and its annotation
  appearances, and raises `ResourceLimitError` once the total passes the bound.
  The count is per page rather than per document, so a long document whose
  every page is fine still opens. `ConvertColors`, `FlattenLayers` and
  `RemoveLayer` keep a per-stream count, since they parse each distinct stream
  once. `Optimize`'s unused-`/DR` pass did not: it re-parsed an appearance
  shared by many widgets once per widget and every kept resource stream once per
  round, and now parses each stream once — on the test fixture, 4 parses where
  it took 9. (ibzo.8, ibzo.9)

- **Deeply nested structure no longer crashes or silently drops content.** A
  tagged PDF whose structure tree, parent tree or optional-content visibility
  expression nests thousands of levels deep — every level a separate object, so
  nothing looked deep to the parser — now raises `ResourceLimitError` naming
  `maxNestingDepth`. Before, thirteen operations ended in a raw `RangeError`
  (`ValidatePdfUa`, `ValidatePdfA`, `GetTables`, `Split`, `ExtractPages`,
  `Merge`, `StampWith`, `NUp`, `GetText`, `GetPaths`, `RemoveLayer`,
  `FlattenLayers`, removing a structure element), and two were worse: the
  Markdown, HTML and DOCX exports of a 200,000-deep structure tree returned an
  empty document where a shallow one gives its text, and `ToImage` left a deep
  optional-content section out with nothing said. The structure tree is bounded
  in one place every consumer descends through, so walkers added later are
  bounded too. A structure tree or visibility expression that refers back to
  itself used to recurse until the stack overflowed; it is now read as damage —
  the loop is skipped and the rest of the document works. (ibzo.6)

- **`GetText`, `ToImage` and every other content walker are now bounded**,
  which is what makes them safe on a file that parsed fine — the usual shape of
  a content-stream bomb. A page whose content expands to gigabytes is stopped at
  256 MiB of decoded content and refused with `ResourceLimitError` naming
  `maxContentBytes`, from extraction and rendering alike; the bound is on the
  page's content as a whole, so a `/Contents` array of many streams cannot pass
  stream by stream. Parsing counts content tokens (default 10 million, measured
  at ~97 heap bytes each — the 50 million the policy first shipped with was
  roughly 4.8 GB and bounded nothing) and operand nesting, whose reader used to
  recurse until the stack overflowed. The renderer refuses an image from its
  declared `/Width` x `/Height`, and a page canvas whose size the document's
  page box decided; a `width` and `height` you pass to `ToImage` yourself are
  exempt. Measured, a normal page pays nothing: parsing 2.1 MB of ordinary
  content stayed within ±3% of before. **Changed along the way:** a picture over
  64 megapixels used to be silently left out of a render; it now draws, up to
  the 268-megapixel image bound, and is refused past it rather than vanishing.
  (ibzo.4)

- **Decoding a stream or an image is now bounded too**, and refused with
  `ResourceLimitError` naming the limit rather than exhausting memory.
  Measured before this change: 64 MiB of zeros deflated twice is a few hundred
  bytes, and decoding it allocated the whole 64 MiB; a JBIG2 region declaring
  2^31 pixels, or a JPX image declaring a 100,000 x 100,000 tile grid, sized an
  allocation straight from the header. Now every stage of a filter chain stops
  at a cap — zlib's own `maxOutputLength`, and the LZW and RunLength loops —
  set by the decoded size per stream (512 MiB), the expansion ratio against the
  encoded input of the WHOLE chain (2,000:1, applied above 1 MiB of output so a
  tiny blank stream is never refused), a total of 2 GiB across the document
  (each stream counted once, so rendering a page twice costs nothing extra), and
  at most 8 filters. Image codecs refuse from DECLARED geometry before
  allocating: the JPEG frame, the JPX image area, CCITT columns x rows, the JBIG2
  page, regions, halftone grid and symbols, and a sampled function's table.
  **BREAKING** in one visible way: rendering, exporting and colour conversion
  used to skip an image they could not decode; an image refused for a limit now
  raises instead of silently vanishing, since a bomb rendered as a blank picture
  tells the caller nothing. Lift a bound with
  `LoadLimits.defaults.with({ maxImagePixels: null })`. (ibzo.3)

- **`Document.Open` now bounds what a hostile file can cost to parse**, and
  refuses past a bound with `ResourceLimitError` naming the limit, where it
  used to exhaust memory, overflow the stack or misreport the file as damaged.
  **BREAKING** for a caller opening very large trusted files: the defaults
  refuse input over 1 GiB, more than 2 million objects, more than 1,000
  cross-reference sections, an object over 256 MiB encoded, nesting deeper
  than 256, or a container of more than a million items — pass
  `{ limits: LoadLimits.unlimited() }`, or lift one field with
  `LoadLimits.defaults.with({ maxFileBytes: null })`. What each bound replaced,
  measured: a 10-million-row cross-reference table killed the process outright;
  a 10,000-deep array overflowed the stack and was reported as
  `object-parse-failure`; a 20,000-deep page tree threw a raw `RangeError` out
  of `Open`; a name tree naming itself, or a type 3 function stitching itself,
  recursed until the stack gave out. `OpenFile` and the `node.ts` file
  helpers refuse an oversized file from its size, before reading it. The bounds
  also govern the recovery sweep, and a bound reached there is never swallowed
  as damage — otherwise the brute-force scan over a hostile file is exactly what
  would run. Nesting is bounded in the object grammar and in the page, outline,
  form-field, name-tree, Form XObject resource, annotation and function graphs,
  where every node is a separate flat object. Decoded stream sizes, image
  pixels and content streams are not bounded yet. (ibzo.2)

### Fixed

- **A word hyphenated at a line end exports as one word.** `ToMarkdown`, `ToHtml`, `ToDocx` and `ToEpub` joined a paragraph's lines with a space. A word the PDF broke at the end of a line therefore came out as two, for example `documen tation` with an invisible soft hyphen after the first half, on both the untagged and the tagged path. When a line ends in a soft hyphen (U+00AD) and the next line starts with a lower-case letter, the halves are now joined with no space and the soft hyphen is dropped. This uses the same rule as reflow's rejoin, so it covers every break this library's hyphenation writes in a Standard-14 face, plus soft hyphens from other producers. A drawn `-` at a line end is still kept, since it may be an author's compound like `well-known`. A soft hyphen drawn mid-line, or before a capital, is also left as it is. A break that falls on a style change, such as a bold run starting the next line, joins too. (5cil)

- **A second `ReplaceText({ adjust: 'reflow' })` over an already reflowed paragraph no longer refuses.** The first reflow leaves a line ending in a show string's own trailing space, `(Documentation and analysis of ) Tj`. Text layout drops that space, so the paragraph finder gave it no paragraph, and because its pen was chained to the word before it the interleaving rule refused the whole edit as `interleaved`. Every second reflow over this library's own output failed that way, hyphenated or not, and so did a reflow over any producer's file that ends a line on `(word ) Tj`. Such a space now joins the paragraph through its pen chain, as a glyph drawing no text already did. A hyphen drawn by an earlier hyphenated reflow is still never rejoined and can be left mid-line, as documented for hyphenation. (8eew)

- **Markdown footnote reports cover what is drawn, and the definition grammar matches cmark-gfm on two edges.** A squeeze or an overflow INSIDE a footnote body never reached `skipped` or `onSkipped`, because only the main body's elements were wired to report; note bodies are now wired the same way. A definition cited only from inside another note (where the citation is drawn as its literal `[^label]`, notes not nesting) is never placed, yet its body's reports — an unresolvable image, an undrawable character — went into `skipped` as though they had been lost from the page; they are now reported only for a note the document body actually cites. In the parser, a line of one to three spaces now CLOSES a footnote definition rather than continuing it, as cmark-gfm's `parse_footnote_definition_block_prefix` does (only a literally empty line continues one), and at most 99 definitions open on one line, cmark-gfm's `MAX_LIST_DEPTH` — a per-line count, not a nesting bound. Both were transcribed from cmark-gfm `27d942c`'s `blocks.c`; with `gfm` off nothing moves, and the 652 CommonMark cases are the fence. The README now records that Markdown footnotes are numbered in body citation order, which differs from GitHub's tree order when an early definition cites another note. (v9j3.3.5)

- **A tagged note link's structure destination names the note.** In a tagged Flow, the `/SD` on a citation mark's GoTo action named whichever structure element came first on the note's page — usually the page's first paragraph — so an assistive technology following the link landed at the top of the page rather than on the footnote, and the note's back link likewise missed the citing paragraph. The citation now targets the `/Note` itself and the back link the element holding the first citation. A `/Note` holds no content of its own and inherits its page from the citing paragraph, so the target is accepted on the strength of where its CONTENT lies; otherwise an endnote on a later page would fall back to the page's first element. Untagged output is unchanged. The README now also says that a single-rect `remainder` placed later draws its notes without links. (mba3)

- **An inline image after a cited run is drawn after its note mark.** In a Flow paragraph, heading or list item, an image placed after a run that cites a footnote or endnote was drawn between the run and its mark, because inserting the mark shifted the runs while the image kept its old position. Measured: the mark landed 44pt from the start of a 24pt-wide word where it belongs right after it. Images are now moved past every mark inserted before them; Markdown and DOCX paragraphs, which place images among cited runs the same way, are fixed by the same rule. (v9j3.3.3)

- **Text fragments no longer run together words separated without a space character.** `GetTextFragments`, `GetStructuredText` and everything built on them (the untagged exports, `docmodel.ts`) merged glyphs across gaps up to half an em but never inserted the space `GetText` infers, so words a producer separated with a TJ kern or a positioning operator rather than a space glyph read as one — "thelazy" — and so did the lines `ReplaceText({ adjust: 'reflow' })` writes. A fragment now gains a space exactly where `GetText` does: across a gap over a quarter of the font size, unless a space is already there. No existing document changed, since none of the test corpus separates words that way. (567g)

- **`RestyleText` decorations survive clipping text and keep the text's colour space.** In a text object drawn in a clipping render mode (`Tr` 4-7) the underline or strikethrough was painted after the `ET` that commits the clip, so it was cut to the glyph outlines and all but vanished; the rules are now drawn before the text object, under the glyphs. A rule in the text's own colour was drawn in an RGB approximation of it, so CMYK, spot and pattern text got an RGB rule; it now re-emits the text's own fill operators, copying a colour space named outside a form into it. A show operator outside any text object, in a malformed stream, was decorated around the previous text object; and in a tagged document whose structure sequence opens in one content stream and closes in another, the decoration was nested inside it. A match covering text of a Form XObject drawn twice in only one of the drawings decorated both; that is now refused, since the drawings share one stream. (u3l5.12)

- **`adjust: 'reflow'` handles centred tails, matches across paragraphs, and annotations around it.** A centred or right-aligned paragraph whose short last line sat well in from the others was split in two by the left-edge grouping, so growing it was refused for want of room; that line is now kept with its paragraph when it shares the paragraph's centre or right edge at its line pitch. A match running from one paragraph into the next reflowed only the paragraph holding its start, leaving a hole where the matched text had been in the other, with nothing reported; both are reflowed now. A highlight or link spanning two paragraphs lost its quads over the paragraph that was not reflowed; those are kept. An annotation sitting just below a paragraph did not count as being in the way, so the paragraph could grow over it; it now counts, and growth is refused. (u3l5.11)

- **`adjust` moves the whole line, and is honest about a Form XObject drawn twice.** With `region` set, `adjust: 'shiftRest'` and `'spaceWidth'` worked on the region's layout only, so text after the replacement but outside the region was never moved and the line could overlap at the region's edge; `region` now limits which matches are found, and the rest of the line — inside the region or not — moves. For a Form XObject drawn twice on a page, the width a replacement removed was counted across both drawings, so even the first drawing's line moved by the wrong amount, and the second drawing's line did not move at all; each drawing is now measured and adjusted on its own. Because the two drawings share one stream, a kern written there moves both, so where they would need different spacing — two drawings on one line — the call is refused with `UnsupportedFeatureError` instead of silently letting the first decide. (u3l5.10)

- **A replacement written in an embedded fallback font keeps the word spacing of justified text.** Word spacing (`Tw`) applies only to the one-byte space code, and a fallback embedded with `AddFont` is written as two-byte codes, so in justified text a replacement written in one — through `fallbackFonts` or `font` — had spaces narrower than the words around it, by the full `Tw` each. Each such space is now followed by a `TJ` kern of exactly `Tw`, and `adjust` measures the run the same way, so the text after it moves by what was drawn. Errors about a template's page now say "a page outside the page tree" rather than "page 0", and README no longer says replacement is confined to the original font. (u3l5.8)

- **`ReplaceText` counts what it replaced, and drops the kerns around an ornament inside a replaced word.** The return value counted every match found, so a match made only of the spaces line assembly puts between words — `ReplaceText(' ', 'X')` on text drawn as separate words — reported replacements while editing nothing; it now counts matches that rewrote something, as the documentation always said, and `RestyleText` follows the same rule. Separately, a `TJ` string holding a glyph that draws no text (an ornament, a `/ToUnicode` gap) inside the replaced word was never treated as wholly matched, so the kerns between the replaced pieces were kept and the replacement was drawn with gaps the original word's kerning had made; the ornament is removed with the word, and now so are those kerns. An ornament at a string's edge, which the edit does not remove, still keeps its kerns. (u3l5.7)

- **`ReplaceText` wrote the replacement twice in a form drawn twice.** A Form XObject placed twice on a page is one content stream, but each drawing's match edited it, so `alpha beta` drawn twice became `alpha BETABETA` in both places. A glyph is now edited once however many drawings show it. (u3l5.6)

- **`ReplaceText` no longer writes a character a subset font cannot draw.** A subset font's encoding still maps characters whose glyphs were never embedded, so a replacement using one encoded happily and drew nothing, or `.notdef`, with no error. A character now counts as drawable in the original font only when its code decodes back to that character and, for an embedded font, selects a glyph the program defines (a glyph a subsetter emptied without renumbering — a zero-length TrueType slot, or a CFF or Type 1 charstring that draws nothing, the shape `Optimize` itself leaves — counts as missing, except for whitespace). Otherwise it falls back or is refused. (u3l5.2)

- **Replacing part of a ligature keeps the rest of it.** A glyph can draw several characters — a `fi` ligature is one glyph whose text is two letters — and `ReplaceText` treated each glyph as all-or-nothing, so replacing `ine` in `fine` produced `one`, replacing `f` produced `xne`, and two matches inside one `ffi` ligature lost its `i`. The replacement is now planned per character and written per glyph: a touched glyph becomes the characters no match covers, with each replacement where its match starts, re-encoded in that glyph's font. Glyphs no match touches keep their bytes exactly. A leftover character the font cannot encode is refused with `UnsupportedFeatureError` before anything changes, rather than silently dropped. (u3l5.1)

- **Search and replace hit the right glyphs after an emoji or other astral character.** The page text is indexed by UTF-16 code unit, but the list saying which glyph drew each character had one entry per code point, so every position after a character outside the Basic Multilingual Plane (an emoji, a mathematical alphanumeric) pointed at the next glyph. `Search` then reported the wrong glyphs and quads, `ReplaceText` rewrote the wrong bytes, and `SearchAnnotations` and `CompareText` placed their boxes one glyph late. Each code unit now has its own entry. (u3l5.1)

- **AI features no longer fail on a fenced reply, a split character or a transient error.** `Ask`, `GenerateAltText` and `aiOcrEngine` refused a reply wrapped in a markdown code fence (``````json … ``````), which models that ignore "reply with JSON only" nearly always produce, so a perfect answer failed the page or the figure; one fence spanning the whole reply is now stripped before parsing, while JSON with prose around it is still refused. In `GenerateAltText` a failed description was remembered for the rest of the run, so one transient error failed every figure that shared the picture; a failure is now retried by the next figure that shows it, while successes and decorative verdicts are still described once. `Ask`'s passage windows and `GenerateAltText`'s page-text context could be cut between the two halves of a surrogate pair, sending the model a lone half of an emoji or a rare CJK character; every hard cut now steps back off a pair. `Summarize` reduced up to six levels even when a level did not make the text shorter — a model answering at length repeated the same work five more times — and now sends the final request as soon as a level fails to shrink. (u0ec)

- **Text on a rotated baseline extracts as lines.** `GetText`, `Search`, `GetTextFragments`, structure-tree text and annotation search laid every run out by its page-space Y and X whatever the baseline's angle, so upright text on a `/Rotate 90` or `270` page, a rotated stamp or a 30° watermark came out one glyph per line (or, at 180°, backwards) and `Search` found none of it. Each run is now projected onto its own baseline, and each baseline angle is laid out separately — upright text first, then each other angle — so a rotated stamp no longer splits the body text it sits on. Runs within 0.01 rad of horizontal keep exactly the path they always took, which is why no existing extraction, HTML, Markdown or DOCX snapshot moved. Glyph events carry a new `penEnd`, the pen position after each glyph, since a run on a vertical baseline cannot otherwise know its own length. (w7jf)

- **`ToDocx` and `ToEpub` no longer throw on a large image.** The ZIP writer
  under both exports spread every byte of each entry into a function call's
  arguments, so a picture of a few hundred kilobytes — a media part is stored
  uncompressed — threw `RangeError: Maximum call stack size exceeded` and the
  whole export failed; a 40,000-relationship `.rels` of 220 KB did the same
  inside the test runner. The archive is now assembled from byte chunks and
  copied once, which also stops holding every payload byte in an array at
  eight bytes a slot. Measured: 4 MB stored and 4 MB deflated entries round
  trip through an independent reader, and a page with a 3 MB picture exports.
  Output is byte-identical for every archive that wrote before. An entry
  starting past 4 GB now throws as well, where its 32-bit offset used to wrap
  silently (h4z3).

- **A CFF2-outlined system font no longer hides a usable sibling from
  `LoadFontByName` and render substitution.** The font index reads only a
  face's `name`, `head` and `OS/2`, so a variable OpenType-CFF face (a `CFF2`
  table and neither `CFF ` nor `glyf`) was indexed like any other — and when
  style matching preferred it, typically as the family's Regular, the load
  failed and `LoadFontByName` returned `undefined` although a drawable face
  of the same family sat beside it. Such a face is now skipped at index time,
  decided from the table directory the partial read already holds, so
  selection falls through to the next candidate at no extra I/O. A face that
  carries CFF2 beside a `glyf` or `CFF ` table is still indexed and draws
  through that table. (dmin.6)

- **`AddFont` names CFF2 when it refuses a CFF2 font, instead of calling it
  broken.** A CFF2 font (an `OTTO` sfnt carrying a `CFF2` table rather than
  `CFF ` or `glyf`) threw `PdfParseError: font has neither a glyf nor a CFF
  table`, which reads as a damaged file when the font is well formed and
  simply one this library declines to read (see Scope and Limitations). It
  now throws `UnsupportedFeatureError` naming CFF2. A PDF embedding a CFF2
  program as `/FontFile3 /Subtype /OpenType` is unchanged in behaviour but
  now degrades by decision rather than by accident: it opens, its text
  extracts, and it renders pixel-identically to the same font with no
  embedded program at all (the Standard-14 substitute). (dmin.5)

- **`ConvertToPdfA` repairs and describes page-level XMP packets too, and a
  wrapped value keeps its language.** At PDF/A-1 a page's (or any object's)
  own metadata packet was never given the `pdfaExtension:schemas`
  descriptions it needed — only the catalog's was — so conversion left it
  reported as `XmpPropertyNotDescribed`; every reachable packet is now
  described, a page packet at parts 2–3 borrowing what the catalog already
  describes rather than repeating it. Repaired packets are written back into
  their own streams, so one stream shared by the catalog and a page is fixed
  for both instead of leaving the page on the old copy. And when a plain value
  is wrapped into a Lang Alt or an array, its `xml:lang` and qualifiers now
  move onto the item: a `dc:title` in German becomes a German item rather than
  an `x-default` one inside a German-tagged array (o6uu.13).

- **`SetXmpValue` refuses what it would silently corrupt, and a write that
  changes nothing no longer marks the document modified.** A `{ lang }` map
  could hold `x-default` and `X-Default` — writing an Alt that names one
  language twice — and took any string as a tag, `x y` included; tags must now
  be letters and digits joined by hyphens, distinct ignoring case, or the call
  throws `RangeError`. A namespace holding a character XML cannot carry was
  stripped on write, so the property landed under a different URI and
  `GetXmpValue` with the caller's URI missed it; it now throws `TypeError`.
  Deleting a shared property XMP did not hold (`/Info /Producer` alone) left
  the `/Info` key in place; it is now deleted. And setting a property to the
  value it already had rewrote the packet and marked the document modified,
  so a later `Sign()` rewrote the file instead of appending; now nothing is
  touched. A property named with non-ASCII letters reads back through
  `GetXmpValue` but not `GetXmp().custom`, which is now documented (o6uu.12).

- **PDF/A extension-schema checks and repairs no longer misfire in four
  cases.** An object-level metadata packet at parts 2–3 now knows the value
  types the catalog packet declares for the same namespace, as veraPDF's does,
  so a description using one is no longer reported as `XmpExtensionValueType`.
  `ConvertToPdfA` extending a description whose `pdfaSchema:property` list was
  a Bag or Alt reported the property described while the entry still failed
  the Seq rule; it now turns the list into a Seq. When the required PDF/A
  prefixes displaced a foreign namespace that had borrowed one of them, the
  namespace was written under a generated prefix while its description still
  named the old one; it is now re-bound explicitly and its
  `pdfaSchema:prefix` rewritten to match. And `ConvertToPdfX` on a PDF/A 1–3
  document wrote `pdfxid` without describing it, so the document stopped being
  PDF/A; it now writes the description, as `ConvertToPdfUa` already did for
  `pdfuaid` (o6uu.11).

- **Date conversion between `/Info` and XMP no longer skips or invents
  dates.** `SyncMetadata` (and the date conversion under `SetMetadata` and
  `SetXmp`) refused an offset written without apostrophes —
  `D:20240603123045+0200`, a spelling `GetMetadata` already read — so such a
  date was reported in `skipped` rather than converted; it now converts to
  `+02:00`. The day was checked only against 31, so `D:20240231` converted to
  a date that does not exist, and an ISO `2024-02-30` was rolled forward into
  March when compared; both grammars now check the day against its month and
  the leap year, and such a date is skipped. The docs now also state that an
  XMP date with no zone designator is read as UTC — beside an `/Info` date
  carrying an offset it differs, so either direction rewrites the other — and
  that `SyncMetadata('xmpToInfo')` creates `/Info`, which PDF/A-4 forbids
  without a `/PieceInfo` (o6uu.9).

- **Four XMP write edge cases now behave as documented.**
  - A document opened with looser `LoadLimits` could read a deeply nested
    XMP packet but not write it: `SetMetadata` and `SetXmp` parsed the packet
    under the default limits and threw `ResourceLimitError`. They now use the
    document's own limits.
  - When the XMP half of `SetMetadata` was refused, the `/Info` half had
    already been written, leaving the two out of step. The XMP half is now
    computed first, so a refused write changes nothing.
  - A `custom` property could come back from `GetXmp()` with a generated
    `nsN` prefix instead of the prefix the caller asked for. This happened
    when another namespace surviving in the packet already held that
    prefix. The caller's prefix now wins.
  - A custom property written as an attribute on `rdf:Description` was
    missing from `GetXmp().custom` until the first write moved it to
    element form, so the list changed after one `SetXmp`. It is now
    reported from the start (o6uu.7).

- **XMP packets are now read and written the way a conforming XML reader
  sees them.** A carriage return in a value was written raw, so any other
  XML reader returned it as a line feed. It is now written as a character
  reference, and tabs and line breaks in attribute values are written the
  same way. Reading now applies XML's own line-ending and attribute-whitespace
  normalization. An `xml:lang` on an `rdf:Alt`, `rdf:Bag`, `rdf:Seq` or
  `rdf:Description` used to be dropped silently. It is now inherited into the
  values below it, as RDF/XML defines, and `xml:lang=""` cancels it. A
  non-empty `rdf:about` (the resource the packet describes) was discarded on
  every write, and it now survives `SetXmp` and `SetMetadata`. Two
  `rdf:Description` elements that name different resources are refused, as
  Adobe's own XMP toolkit refuses them, rather than merged into one packet
  (o6uu.5).

- **A date passed as a string no longer lands in the wrong syntax on the other
  side.** `SetMetadata({ creationDate: "D:20240603123045+02'00'" })` copied
  that `D:` text verbatim into `xmp:CreateDate`, and `SetXmp` copied an
  ISO-8601 string verbatim into `/CreationDate` — each a value the other
  side's grammar does not accept, which PDF/A readers reject. A string date is
  now converted text to text, keeping its precision and its UTC offset. The
  side the string was handed to is fixed too: an ISO string passed to
  `SetMetadata` is written to `/Info` as a `D:` date, and a `D:` string passed
  to `SetXmp` is written to XMP as ISO 8601 — but only when it reads in the
  other syntax and not this one. A string that reads in neither passes through
  as before, and a `Date` object is written exactly as it always was (o6uu.4).

- **Writing metadata no longer discards XMP the library does not model.**
  `SetXmp`, `SetMetadata` and every conversion that stamps an identification
  (`ConvertToPdfA`, `ConvertToPdfUa`, `ConvertToPdfX`) rebuilt the whole XMP
  packet from its fifteen known fields, so one title edit silently dropped an
  `xmpMM:History`, a `DerivedFrom` reference, identifiers qualified by
  `xmpidq:Scheme`, every non-literal custom property, the translations of a
  title, and a PDF/A extension-schema description — leaving a PDF/A file that
  uses a custom namespace no longer describing it. The packet is now parsed
  into an RDF data model, edited field by field, and written back: a field you
  set replaces its property in place, `null` deletes it, a title replaces only
  its `x-default` language, and everything else survives. The packet is now
  written in one canonical layout (a single `rdf:Description`, properties as
  elements), so its bytes differ from before even where nothing was lost;
  every reader in this library accepts both forms. Characters XML cannot carry
  (such as a NUL in an `/Info` title) are dropped from values written into the
  packet. (o6uu.3)

- **A page tree listing a page twice could not be opened.** `/Kids [3 0 R
  3 0 R]` made `Document.Open` throw `cycle in page tree` with no recovery —
  the whole file was lost over a structure the page list can be built around. It opens now: the
  repeated page is two entries in `doc.Pages` over one dictionary, exactly as
  the file says, `Validate()` reports it as `PageTreeShared` and `Repair()`
  splits it. Only a node listing one of its own ancestors is a cycle, and its
  back edge is skipped. Because a shared node is walked again, a tree fanning
  out to 2^40 pages from 42 objects would now exhaust memory, so every node
  visited counts against `LoadLimits.maxObjects` and such a file raises
  `ResourceLimitError`. (1lr9)

- **Page edits on a nested page tree left the file inconsistent, and `Reorder`
  lost page sizes.** `RemovePage`, `InsertPage` and `InsertPages` re-list the
  document's pages directly under the root, but left each page's `/Parent`
  naming its old intermediate node — which survived the save still listing the
  page with its old `/Count`. The file rendered correctly and was structurally
  inconsistent. `Reorder` was worse: it repointed `/Parent` at the root before
  re-listing, so a page that inherited its `/MediaBox`, `/CropBox`,
  `/Resources` or `/Rotate` from an intermediate node silently lost it and came
  out US Letter. Each edit now copies those inherited values onto the page
  first (never the root's own, which the page still inherits, and never over a
  value the page states itself), so the old intermediate nodes become
  unreachable and are dropped on save. Found while building `Validate()`,
  which flagged documents this library had written. (dmin.4)

- **`saveImagesFile`, `htmlFileToPdf`, `saveMarkdownFile` and `saveDocxFile`
  are importable from the package.** All four were written, tested and
  announced, and README's own example imports the first two from
  `@asposefoss/pdf` — but `index.ts` exported none of them, so that example
  did not compile and the only way to reach them was a deep import. Their
  tests import `src/node.js` directly, which is why nothing noticed. Their
  option types are exported too: `SaveImagesOptions`, `HtmlFileOptions`, and
  `SaveImagesSkipped` for `saveImagesFile`'s skip record, renamed on the way
  out because `SkippedImage` already names `Optimize`'s. README's API
  Reference now gives every export a row — 69 were missing, including these,
  the three structure-namespace constants, the flow builders and the RFC 3161
  helpers — and its counts are corrected to 377 types and 143 values. A test
  now asks the TypeScript compiler what the package exports and fails when a
  name lacks a row, a count drifts, or a README example imports something the
  package does not export. (clik)
- **Markdown now reports what it could only place by compromising.** A quote,
  list or code block nested past what the column can indent renders squeezed
  to a 12pt content column, a block too tall for an empty column draws past its
  bottom, and an over-tall image is scaled to fit — and `AddMarkdown` said
  nothing about any of the three, so its `skipped` was empty for a page laid
  out as written and for one crushed into a sliver. They now arrive as
  `squeezed`, `overflow` and `image:scaled-to-fit`, the strings
  `describeNotRendered` gives for the matching HTML records, one per block
  however many levels of nesting did the squeezing. They are decided while
  placing, so `doc.AddMarkdown` and `page.AddMarkdown` fold them into the
  `skipped` they return, and a `Flow` — whose `AddMarkdown` returns before
  `Render` — receives them through a new `onSkipped: (s) => void` option. The
  squeeze reaches hand-built flows too: the quote, list and code-block
  elements report it through the same `onCompromise` channel HTML boxes use.
  (kk3q)
- **HTML nested past what the column can indent now says so.** Since the
  deep-nesting fix a box that cannot afford its own margins and padding scales
  them down to a 12pt content floor and renders, where it used to come out
  blank — but that removed the `overflow` record the blank page had carried and
  put nothing in its place, so `AddHtml` gave the same empty `skipped` for a
  page laid out as specified and one squeezed into a 12pt column. It now
  reports a new `squeezed` construct, `degraded`, against the innermost element
  it narrowed. Its own construct rather than `overflow`, which keeps meaning
  "drew past the column bottom". Twenty nested `<blockquote>`s around one
  paragraph are ONE record, not one per level, because every level reports
  through that paragraph's single one-shot callback; content that draws nothing
  reports no squeeze. (rfba)
- **Text inside a Form XObject is extracted with the text state it is drawn
  in.** A form started its content walk with every text state parameter reset,
  where ISO 32000-2 8.10.1 draws a form in the graphics state in force at its
  `Do`. So a form showing text in the font, horizontal scaling or rise the page
  had set before invoking it came back from `GetText`, `GetTextFragments`,
  table detection and every export with no font — and so no text at all — or
  with its glyphs misplaced, while the renderer drew it correctly. The form now
  starts from a copy of the caller's `Tc`, `Tw`, `Tz`, `TL`, `Ts`, `Tf` and
  `Tr`, and a setting it makes still cannot reach back out to the page.
  Annotation appearances are unchanged: they are not drawn inside the page's
  graphics state. (mih4)
- **Text extraction now honours `q`/`Q` around the text state.** The content
  walker behind `GetText`, `GetTextFragments`, `GetStructuredText`, `Search`,
  table detection and every export restored the CTM and fill colour at `Q` but
  not the text state, so a `Tc`, `Tw`, `Tz`, `TL`, `Ts` or `Tf` set inside a
  `q` … `Q` leaked into everything drawn after it — contrary to ISO 32000-2
  9.3.1, which makes all of them graphics state. A producer that scoped a
  superscript's rise or a condensed run's horizontal scaling that way got every
  later glyph on the page reported raised or misplaced, while the renderer drew
  it correctly. `q` now saves every text state parameter but the two text
  matrices, which `BT` resets instead. No existing test fixture moved: none sets
  text state inside a `q` and shows text after the `Q`. (g5x6)
- **Deeply nested Markdown and HTML now render instead of throwing or coming
  out blank.** Every decorator that indents — a block quote, a list item, a
  list item's further blocks, a code block's padding, a CSS box's margins and
  insets — subtracted its inset from the region width with no floor, so nesting
  drove the content width to zero. That failed two ways from one cause, and the
  second was the worse of them. `doc.AddMarkdown('>'.repeat(26) + ' x')` threw
  `TypeError: rect width and height must be positive` from inside the painter,
  a bare error naming nothing a caller could act on; a list nested 49 deep did
  the same. HTML did not throw — it rendered a BLANK PAGE and reported nothing,
  from depth 8, because a `<blockquote>` carries a 40px margin on both sides
  and `BoxElement` reads a non-positive width as "nothing to draw".
  An inset is now scaled to whatever room is left above a 12pt floor, about one
  em of body text, and every horizontal amount of one frame scales by the same
  factor — so the content BOX stays inside its column rather than sliding off
  the right edge, and a chain of decorators converges on a narrow column
  instead of reaching zero (a word wider than the floor still overflows its
  box, as an over-wide word does in any column). Deep content renders squeezed and tall, which is `zch2.16`'s
  decision in the horizontal direction: content that cannot fit renders rather
  than refusing the document. Nothing that fitted before moves, since the
  factor is 1 whenever there is room; the CSS used widths `cssresolve.ts`
  computes are untouched, the clamp being placement-only. Note a quote nested
  past the point its indent runs out draws its gutter bar over its own text,
  and a squeezed box is not reported — filed separately. (e1bp)

- **A word longer than a page no longer costs time quadratic in its length.**
  `layoutRuns` paginates an over-wide word by handing the tail back as a
  remainder and flowing it again, so everything that ran before the split ran
  again on every page the word spanned: the code point array, the character
  offset table and the UAX #14 line-break analysis, 64% of the profile between
  them. `lqs1` made the split and the over-wide test stop at the page and left
  all three. Measured on `'[a]('.repeat(n)` through `AddMarkdown`, the time per
  doubling was climbing to 4 — 0.29 s, 0.81, 2.4, 8.5, 32.1 at 50 K to 800 K
  characters, and 196 s at 2,000,000. All three are now grown ON DEMAND, so a
  page costs what it keeps: 0.24 s, 0.38, 0.82, 1.55, 3.21 and 8.8 s, a flat 2
  per doubling and 22x faster at two million.
  The analysis is the part that could not simply be chunked, which is why this
  was filed rather than done at the time. `lineBreakPrefix` states how far into
  a prefix its answers are FINAL, and the rest of the word is analysed only if
  the split reaches that far, over a prefix that doubles. The horizon is `n - 1`
  and the reasoning is worth recording, since the obvious reading is that a
  numeric run straddling the cut must cost much more: LB25's scan does run
  forward an unbounded distance, but its unguarded reads all sit within two
  characters of where it starts, so it can only notice the end of a prefix when
  it starts within two of that end — and the marks it would then differ on begin
  at `n - 1`, exactly where LB15b's and LB28a's one-character lookahead already
  put the answer at risk. No line break moves; that is asserted over every
  prefix of every row of the UAX #14 conformance corpus. (lt63)

- **A long run of Markdown delimiters no longer costs time quadratic in its
  length.** `AddMarkdown` took 3.7 s on `'*'.repeat(20000)`, 3.9 s on
  `'['.repeat(20000)` and 7.0 s on `'[a]('.repeat(20000)`, and none of the
  three finished at 500,000 characters in a minute. They are three separate
  defects, found by profiling rather than by reading. Two are in LAYOUT: an
  over-wide word was measured once per character to find its break points, and
  the answer was used only where a break opportunity had already been seen —
  so a word with none at all (a run of `*` or `[` is one, since UAX #14
  prohibits a break in both) computed and discarded every one of those
  measurements, each re-walking the prefix; and the split was materialized in
  full even though the page keeps only what fits, so a word longer than the
  page was re-split on every page as the remainder was re-flowed, which is the
  rule the previous entry fixed for ordinary words and did not reach here. The
  third is in PARSING: a bare link destination counted nesting parentheses
  with no bound, so every `]` scanned to the end of the document and then threw
  the work away, and a destination now stops being one past 32 levels of
  nesting — which is what cmark, the reference implementation, already does.
  Measured at 20,000: 22 ms, 9 ms and 292 ms, so 166x, 436x and 24x; the first
  two are linear to 500,000 characters and beyond. The three `subject.slice`
  calls behind every close bracket are gone too, though that one is an
  allocation saving rather than a quadratic — V8 answers such a slice in
  constant time. **A residual remains and is tracked separately:** a single
  word of millions of characters is still analysed in full on every page it
  spans, because UAX #14 line-break analysis has no incremental form, so
  `'[a]('.repeat(500000)` takes 41 s where it used to take longer than a
  minute. (lqs1)

- **A long paragraph no longer costs time quadratic in its length.**
  `AddHtml` took 26.4 s to lay out 100,000 words and did not finish 400,000 in
  two minutes; `AddMarkdown` took 6.2 s and 95.1 s. Each doubling of the text
  cost four times the work, because the engine paginates by handing the
  overflow back as a remainder and flowing it again — and wrapping was eager,
  so every page measured every word of the whole remaining text, twice over,
  and then handed it on to be measured again. Wrapping now stops at the height
  budget, the remainder is cut from the input rather than rebuilt line by
  line, and `drawsNothing` no longer encodes a whole block to learn that it is
  not empty. The cost is linear: 400,000 words take 0.9 s through
  `AddMarkdown` and 2.8 s through `AddHtml`, a 108x and 38x improvement, and
  every emitted page is byte-identical. **One behaviour changed as a
  consequence:** the remainder from `AddTextBlock` now preserves runs of
  spaces and blank lines. It used to collapse both, so an overflowing block
  containing `a\n\n\nb` came back as `a` and `b` with the blank lines gone,
  and a continuation the flow engine re-placed lost them from the page.
  (pl2h)

- **Nested HTML no longer costs exponential time to lay out.** `AddHtml` took
  2.6 s to build a document nesting 20 levels of blocks and 39 s at 25 levels,
  doubling with every further level — and generated markup nests 20 levels
  routinely, so ordinary documents hit it. Margin collapsing walks a box's
  first-child chain for the margin escaping its top edge and its last-child
  chain for the bottom (CSS 2.1 §8.3.1 rules 2 and 3); it computed both at
  every level, which in the common single-child chain, where the first and the
  last child are the same box, made two calls per level for one answer. The
  two edges now descend separately, one chain each, so the work is polynomial
  in nesting depth: the 20-level document builds in 11 ms and one nested to
  the 256-level `maxNestingDepth` in 36 ms. Collapsed margins are unchanged,
  which the browser-generated corpus in `test/fixtures/css-box/` fences.
  (bjov)

- **Resource limits now reach every stream a document holds, not only the ones
  it parsed.** A page brought in from another document with `AddPage` or
  `InsertPage`, and inline images, decoded under the default limits whatever
  policy the document was opened with — so opening a file with tighter limits
  and then importing pages into it quietly lifted them — and none of it, nor the
  streams of a `Merge` result, counted toward `maxTotalDecodedBytes`. Every object a document
  acquires now goes through one insertion point that ties its streams to the
  document's policy. (ibzo.7)

- **A `/Prev` cycle in the cross-reference chain is now reported.** It was
  skipped silently, so a document with one opened with nothing said. It is
  treated as damage rather than as a resource limit: the file still opens,
  through the recovery sweep, with `doc.recovery` naming the cycle. (ibzo.2)

### Added

- **PDF/A checks every XMP property's value against its type.**
  `ValidatePdfA` reports `XmpValueType` at parts 1–3 when a property's value
  does not match its type (ISO 19005-1 6.7.9, -2/-3 6.6.2.3.1): the type comes
  from the packet's own extension schemas, then the catalog packet's, then the
  predefined XMP 2004/2005 set, so a schema can redefine a predefined property.
  It is veraPDF's `isValueTypeCorrect` ported over the pinned sources the
  generator already reads — simple types by veraPDF's own patterns, dates by
  XMPCore's parser, arrays, Lang Alt and the structured types, with
  closed-choice checking off as veraPDF's validator runs it. Three stated
  divergences: a property with no known type is reported once (as
  undescribed), not twice; an XPath value is checked only for being simple;
  and a Lang Alt whose items take their `xml:lang` only by inheritance from an
  enclosing element passes here, where veraPDF, reading each element's own
  language, reports it. `ConvertToPdfA` repairs the shape mismatches it can without losing a
  value — the commonest being a plain `dc:title` or `dc:rights`, which veraPDF
  rejects because it does not normalize — under the new `'xmpValueTypes'`
  category. Measured on a real Acrobat packet, it reports exactly what
  veraPDF's tables imply: `xmpMM:History` events carrying `stEvt:changed` and
  a `xmpMM:DerivedFrom` carrying `stRef:originalDocumentID` (neither field is
  in veraPDF's structured types), and an empty `dc:creator` Bag where a Seq is
  required (o6uu.10).

- **Typed XMP writes.** `doc.SetXmpValue(namespaceUri, name, value, opts?)`
  writes any top-level XMP property from an `XmpValueInput`: plain strings,
  numbers, booleans and `Date`s, and tagged objects for what plain values
  cannot say — `{ seq }` and `{ bag }` for XMP's ordered and unordered arrays,
  `{ lang }` for a language alternative (the only way to write title and
  description translations, since `SetXmp` writes `x-default` alone), `{ uri }`
  and `{ struct }`. `null` deletes. Every value reads back through
  `GetXmpValue`, and everything the write does not name survives. The eight
  properties `/Info` shares are mirrored through `SyncMetadata`'s own rules, so
  the two cannot disagree; a value `/Info` cannot hold deletes its key. The
  call is validated first and computes the packet before touching `/Info`, so
  a refusal changes nothing; `opts.prefix` wins over a foreign namespace
  already using it. A prefix the library gives a well-known namespace
  (`dc`, `xmpMM`, `pdfaExtension`, …) is refused for any other namespace, and
  a `Date` outside years 0–9999 is refused, since its ISO text would not
  read back (o6uu.8).

- **PDF/A checks that every XMP property is predefined or described.**
  `ValidatePdfA` at parts 1–3 now reports an XMP property that is neither in
  the XMP 2004 (part 1) or 2005 (parts 2–3) predefined schemas nor described
  in the packet's `pdfaExtension:schemas`, and a description that is itself
  malformed — the rule veraPDF enforces and this library did not, so a file
  whose custom namespace lost its description validated here and failed
  there. It checks by property rather than namespace, covers object-level
  metadata streams too, and takes its predefined tables from veraPDF's own by
  a generator (`npm run gen:xmpschemas`), so hundreds of rows were not typed
  by hand. `ConvertToPdfA` writes the descriptions it can state truthfully —
  `pdfuaid`, `pdfxid`, and any other simple text value as `Text` — and
  `ConvertToPdfUa` does the same on a document already claiming PDF/A, which
  is what keeps a PDF/A + PDF/UA document conformant. Values are not
  type-checked yet; PDF/A-4 has no such rule (o6uu.6).

- **`doc.SyncMetadata(direction)` makes `/Info` and XMP agree.** The two
  drift whenever one is edited without the other, and PDF/A-1 reports the
  disagreement as an error. `'infoToXmp'` or `'xmpToInfo'` names the source;
  the sync is an exact mirror over the eight shared fields, deleting on the
  target what the source lacks. Both sides are read as raw text rather than
  through `GetMetadata()`, whose `Date` loses the offset, so dates convert
  `D:` ↔ ISO 8601 with precision and offset intact and a `D:…+00'00'` beside
  a `….000Z` of the same instant counts as agreement — which is what our own
  `SetMetadata(Date)` writes. Only differing fields are written and a no-op
  sync marks nothing modified, so a later `Sign()` stays an incremental
  append; `'infoToXmp'` edits the packet in place, keeping foreign schemas and
  title translations, and never creates `/Info` (o6uu.4).

- **Typed XMP reads.** `doc.GetXmpValue(namespaceUri, name)` returns any
  top-level XMP property as an `XmpValue` with `asText(lang?)`, `asDate()`,
  `asBool()`, `asInt()`, `asReal()`, `asUri()` and `asArray()`. It reaches
  what `GetXmp()`'s fifteen named fields never modelled — arrays, language
  alternatives chosen by RFC 4647 range, and `rdf:resource` URIs — over the
  data model `SetXmp` already edits. Every converter answers `undefined`
  rather than throwing, so a producer's malformed value costs that value and
  nothing else; `asDate()` keeps the ISO text beside the instant, since a JS
  `Date` drops the offset it was written in (o6uu.4).

- **Shapes and text markup with no appearance now draw.** A `/Square`,
  `/Circle`, `/Line`, `/Polygon`, `/PolyLine`, `/Ink`, `/Caret`, `/Highlight`,
  `/Underline`, `/StrikeOut` or `/Squiggly` whose producer left the appearance
  to the viewer — legal, and common — rendered blank in `ToImage` and `ToSvg`
  and vanished from `FlattenAnnotations`. Eleven subtypes the FDF/XFDF import
  path already knew how to draw were simply absent from the no-`/AP` fallback,
  which reached only sticky notes, file attachments, stamps and FreeText. They
  are now drawn from the **same builder** that path uses, so a document that
  arrives with appearances and one that does not provably cannot be drawn two
  ways; cloud borders (`/BE /S /C`) come with them, which closes the half of
  that feature a render could not previously reach. Nothing is written to the
  file: the appearance is built on the fly and the annotation still carries no
  `/AP` afterwards, so a document is byte-identical after a render and a later
  `Sign()` is still an incremental append. An `/AP` that is present but
  unusable is still respected rather than redrawn. **Note this changes what
  `FlattenAnnotations` bakes** — an annotation that had nothing to bake may now
  have something, and the returned count rises accordingly. (kapw)

- **Rich-text form fields draw their styling.** A text field with the RichText
  flag (`/Ff` bit 26) carries its markup in `/RV`, which was transported
  faithfully by the FDF/XFDF layer and then ignored: the generated appearance
  was built from the plain `/V`, so a styled field flattened unstyled. It now
  draws the markup — `<b>`, `<i>`, `<span style="…">` and `<br>` over the
  field's `/DA`: size, weight, style, family, colour, per-paragraph alignment
  including justify, underline and line-through — through the same engine a
  FreeText's `/RC` goes through, so the two cannot disagree about what `<b>`
  means. The `/DA` seeds the base style, so the base face and colour are the
  ones the plain value would have drawn in and emphasis picks that family's
  bold or italic sibling; `/DA` size 0 draws at 12pt, shrink-to-fit having no
  meaning once runs carry their own sizes. Fonts stay the Standard 14, as for
  every other field appearance — an embedded `/DR` face is not referenced,
  which keeps a field's base face the same whether or not rich text is on. A
  **password** field never draws rich text, because its value must never reach
  a content stream where flattening would bake it in permanently, and a
  **comb** field never does either, its per-character cells being unable to
  express styled runs; both draw exactly what they drew before. Markup that
  will not parse, or holds no text, falls back to the plain `/V`. (v0tz.5)

- **Cloud borders draw as clouds.** A `/Square` or `/Polygon` carrying
  `/BE /S /C` — what review markup looks like in Acrobat, and what the cloud
  tool writes — regenerated to a plain rectangle or a straight-sided polygon,
  so a document full of review clouds flattened to boxes. Its edges are now
  outward Bézier scallops sized by the intensity `/I`: one cubic per scallop,
  `round(len / 2h)` of them per edge at a bulge height of 4.5pt per unit of
  intensity, each at most a semicircle so a short edge gets a bulge rather
  than a spike. A square's boundary is derived from `/Rect`, so it is inset by
  the bulge and the scallops reach exactly where the straight border would
  have been; a polygon's is stated by `/Vertices`, so the scallops bulge out
  of where the document put them and the room comes from its own `/Rect`. The
  winding is measured from the signed area rather than assumed, since
  `/Vertices` may run either way and an inward bulge renders perfectly well as
  the wrong picture. A uniform approximation rather than a viewer-exact
  screen — 32000-1 12.5.4 names the effect and prescribes no drawing, the
  posture the `/LE` line endings already take. An absent `/BE`, a solid
  `/BE /S /S` and `/I 0` each draw the straight border byte for byte as
  before; `/Circle` is unchanged. (v0tz.4)

- **Styled FreeText comments keep their styling.** A FreeText's rich text
  (`/RC`) was never drawn: a styled comment imported from XFDF or FDF got an
  appearance of its plain `/Contents` and flattened unstyled, and one arriving
  with no appearance at all drew nothing. Both now draw the markup — `<b>`,
  `<i>`, `<span style="…">` and `<br>` over the `/DS` default style and the
  `/DA` font: size, weight, style, family (Helvetica, Times or Courier, the
  first name recognised in a list), colour, per-paragraph alignment including
  justify, underline and line-through — through the same line-breaking engine
  the rest of the library lays text out with, so a larger run makes its line
  taller. Markup that will not parse, or holds no text, falls back to plain
  `/Contents`, which is drawn byte for byte as before. Backgrounds, margins,
  super/subscript and nested block layout are not rendered; rich-text form
  fields are tracked separately. (v0tz.3)

- **Rubber stamps with no appearance now draw.** A `/Stamp` whose producer
  left the appearance to the viewer rendered blank in `ToImage` and `ToSvg`
  and vanished from `FlattenAnnotations`. It is now drawn as a caption box in
  its `/C` colour, red by default: its `/Name` — the 14 standard names
  spelled the way a stamp reads, `NotApproved` as NOT APPROVED — else the
  first line of its `/Contents`, else DRAFT, the default name the
  specification gives a stamp. It is a legible caption, not the standard
  rubber-stamp artwork, which is not ours to bundle. Like the sticky-note icons
  it is drawn when the page is rendered and never written into the file, and a
  present `/AP` is always respected. (v0tz.2)

- **Sticky notes and file attachments with no appearance now draw.** A
  `/Text` note or `/FileAttachment` whose producer left the appearance to the
  viewer — legal, and common in reviewed documents — rendered blank in
  `ToImage` and `ToSvg` and vanished from `FlattenAnnotations`, and that
  included notes made with this library's own `AddTextNote`. They now get
  the icon their `/Name` asks for, in their `/C` colour (yellow for a note
  that states none), squared and centred in the `/Rect`; an unknown name
  draws the default, as a viewer does. The icon is built when the page is
  drawn and never written into the document, so an unflattened file is
  unchanged and a viewer with its own icons keeps showing them; flattening
  bakes it in, as it must. An `/AP` that is present is always respected, even
  an unusable one. The artwork is the library's own rather than any viewer's.
  (v0tz.1)

- **Structural validation and repair.** `doc.Validate()` checks the page tree
  a healthy or salvaged document carries — the catalog resolves, every node is
  reached once, `/Count` agrees with the pages under each node, every
  `/Parent` is the node listing it, every page has a `/MediaBox` somewhere
  above it — and returns the same `ValidationReport` as `ValidatePdfA`. It
  reads the raw object graph rather than `doc.Pages`, and never throws on a
  broken structure. Two things are deliberately not failures: back-references
  (`/Parent`, `/P`, `/Prev`) are required by the format rather than cycles,
  and a reference to a missing object is null by ISO 32000-1 7.3.10, so it
  surfaces only through a `/Count` that then disagrees. `doc.Repair()` fixes
  what `Validate()` reports in place, keeping the tree's shape, so a document
  salvaged from a truncated file writes the pages it has rather than the
  `/Count` it claimed. On a sound document it returns `[]` and touches
  nothing, not even the modified flag, so a following signature still appends
  to the original bytes. It passes every vendored real-world PDF and every
  clean fixture builder in the suite. (dmin.4)

- **Empty signature fields, so a document can be prepared to be signed.**
  `doc.Form.AddSignatureField(init)` and `page.AddSignatureField(init)` create
  a `/FT /Sig` field with a widget and no `/V`: a place for a signature that
  someone else fills later, which is how approval workflows hand a document
  round. `doc.Sign` and `doc.Certify` with `fieldName` set to that field's
  full name now FILL it instead of adding a second field under the same name —
  which is what they did before, leaving the prepared box empty beside an
  invisible signature. Filling works on both write paths, so a prepared file
  that has been saved and reopened, or already carries a signature, is signed
  as an incremental append that keeps earlier signatures valid. A name that
  belongs to a field that is already signed, or is not a signature field, is
  refused, and so is an `opts.appearance` placed anywhere but the prepared
  widget, rather than silently redrawing the box elsewhere. The field draws as
  an empty box — a thin grey border unless a border or background colour is
  given — and sets `/SigFlags` SignaturesExist without disturbing bits already
  there; AppendOnly is left to signing, since an empty field is not a
  signature. Every argument and the whole field path are validated before
  anything is allocated, so a rejected call leaves the document
  byte-identical. `Field.Value` on a signature field still throws: filling one
  IS signing it. `doc.Signatures` now also reports signature fields nested
  under a dotted name, by full name; it read top-level fields only, and that
  shape is now one call away. (puep.1)

- **Seed values on signature fields, written and read back typed.**
  `AddSignatureField({ seedValue })` records what a signature in the field
  should look like — `filter`, `subFilter`, `digestMethod`, `v`, `reasons`,
  `legalAttestation`, `appearanceFilter`, `addRevInfo`, `lockDocument`,
  `mdp` and `timestamp` — and `doc.Signatures[i].seedValue` reads a field's
  `/SV` back, from our own files or anyone else's. `required` names the entries
  that BIND rather than advise, written as the `/Ff` bits; the distinction is
  what the whole feature turns on, so it is part of the API rather than
  implied. `mdp` and `timestamp` have no place in it: `/MDP` has no `/Ff` bit
  and always binds, and a timestamp's requirement flag lives in its own
  dictionary. The signature type is spelled as a word — `'approval'` or a
  DocMDP level — because implementations disagree about `/MDP /P 0`: Adobe and
  pyHanko read it as an ordinary approval signature, PDFBox's documentation as
  an author signature, and we follow the two that agree. The flag bits are
  transcribed from PDFBox and pyHanko rather than recalled, and each is pinned
  to its value alone, since a transposed pair round-trips perfectly. Writing is
  strict — a `required` entry the seed value does not state, an unknown digest
  method or a malformed value is refused before anything is allocated —
  and reading is lenient: a wrong-typed entry reads as absent, and a
  `/DigestMethod` written as strings, as pyHanko writes it, is accepted. `/SV`
  is written as an indirect object, as the specification requires. Signing
  honours it, and the certificate seed value (`/Cert`) is modelled too — see
  the entries that follow. (puep.2)

- **Signing a prepared field honours its seed value.** `Sign` and `Certify`
  filling a field that carries `/SV` now check every REQUIRED entry and refuse
  with the new `SeedValueError`, whose `entry` names the one at fault, before
  anything is written — signing around a constraint the document states is
  worse than declining. A field requiring SHA-384 refuses a signer that states
  SHA-256 and signs with SHA-384 when the signer states nothing; SHA-1 is
  never substituted. A required subfilter must be the first one we support, a
  required reason must be one listed (and `[]` or `['.']` forbids giving one),
  and a required named appearance or Adobe-style revocation info — neither of
  which this library produces — is refused. `/MDP` always binds: `Sign` on a
  field meant for a certification is refused rather than silently turned into
  one, `Certify` on an approval field likewise, and `Certify` takes the
  field's DocMDP level when the caller states none. A required `/LockDocument`
  sets or checks a certification's level, and (since puep.7) an
  approval signature's `/Lock /P` too. Advisory
  entries never refuse, and supply the digest, subfilter and level the caller
  left open. A required timestamp with no caller TSA is fetched from the
  field's `/TimeStamp` URL through the new `httpTimestampProvider` — only over
  http(s), never for a merely suggested URL, and with a timeout and a response
  cap, because that URL is chosen by the document. `/LegalAttestation` is met
  vacuously, as this signer attests nothing, and `/Cert` is not evaluated: the
  caller supplies the credentials. The rules follow pyHanko's seed-value
  enforcement. Signing a field with no seed value, or a new field, is
  unchanged. (puep.3)

- **Field locks: a signature can freeze named form fields, and verification
  reports when one changes.** `AddSignatureField({ lock })` writes a `/Lock`
  — every field, the listed ones, or all but the listed ones, a listed name
  also covering the subtree beneath it — and signing that field carries it into
  the signature's `/Reference` as a FieldMDP transform, beside the DocMDP one
  a certification already writes; a `/Lock` written by another tool is honoured
  the same way. `VerifySignatures` then reports `fieldMDP` — `violated`, with
  the names in `lockedFieldsChanged`, when a locked field's dictionary or one
  of its widgets changed, or the field was added or removed, in a revision
  after that signature — the way it already reports a DocMDP violation. The
  verdict reads the lock the SIGNATURE carries, so a `/Lock` rewritten after
  signing cannot unfreeze anything. Filling a still-unsigned signature field is
  exempt, so locking every field does not turn the next signer's signature into
  a violation; changing a field that is already signed is not exempt. The
  shapes and the matching rule — a prefix such as `ab` is not covered by `a` —
  follow pyHanko. A lock's level, PDF 2.0's `/Lock /P`, is covered below. (puep.4)

- **`AddDocumentTimestamp` fills a prepared signature field.** Given a
  `fieldName` naming an empty signature field — one made with
  `AddSignatureField` or by another tool — the document timestamp now goes
  into that field instead of a new invisible `Timestamp<n>` beside it, which
  left the prepared box empty; like `Sign`, it refuses a field that is already
  signed or is not a signature field, before anything is written. A field
  prepared with a seed value or a lock is refused too: those constrain a
  SIGNATURE, and a document timestamp — with no signer, no `/Reference` and
  always the `ETSI.RFC3161` subfilter — can honour neither, so filling it
  would ignore what the document states. With no `fieldName`, or a new one,
  nothing changes. (puep.5)

- **The certificate seed value (`/Cert`) is written and read back typed.**
  `seedValue.cert` records which certificate a signer should use — the
  allowed certificates, the issuers it must chain to, subject DN attributes
  such as `{ CN, O }`, key-usage profiles, and a URL where one can be
  obtained — with its own `required` set, written as the `/Cert /Ff` bits
  transcribed from pyHanko and pinned one at a time. A key-usage profile is
  typed as the usages a certificate must have and must not have, and is
  written as Table 235's nine-character `1`/`0`/`X` string in RFC 5280 bit
  order, so no caller hand-builds `'1X0XXXXXX'`. Certificates stay raw DER
  byte strings. Writing is strict — a `required` entry that is not set, a
  usage both required and forbidden, an empty certificate — and refused before
  anything is allocated; a foreign `/Cert` reads leniently. `/OID` is not
  modelled, because the specification does not say how an OID is encoded in
  its byte string and pyHanko does not support it either. The certificate
  constraint is recorded, not enforced when signing: the caller supplies the
  credentials directly. (puep.6)

- **An approval signature can lock the document: PDF 2.0's `/Lock /P`.** A
  `lock` may now carry `permissions` — `'no-changes'`, `'form-fill'` or
  `'form-fill-and-annotate'` — and an APPROVAL signature in that field then
  imposes that DocMDP level on the whole document, as only a certification
  could before. A lock that exists only for its level lists no fields
  (`{ action: 'include', fields: [], permissions }`, pyHanko's shape). Signing
  carries the level into the FieldMDP transform as well, which pyHanko does to
  match Acrobat. `VerifySignatures` now gives such a signature a real `docMDP`
  verdict instead of `n/a`, through the same classifier a certification uses:
  a later form fill passes at level 2 and fails at level 1. The level is read
  from what the signature carries, else from the field's `/Lock /P` as it was
  when signed — never from the current field, so a lock added or loosened
  afterwards changes nothing; pyHanko reads the current field, and this is the
  one place the two differ. `Sign` on a field whose seed value REQUIRES
  `/LockDocument true` is now honoured rather than refused, writing `/Lock /P
  1` into the field if it has none; an advisory `/LockDocument` imposes
  nothing, where pyHanko would apply it. A required lock the field's own
  `/Lock /P` contradicts is refused, and `Certify` on a field whose lock sets a
  level takes the stricter of that level and its own. (puep.7)

- **`LoadLimits`, a resource policy for opening files you did not write, and
  `ResourceLimitError`** — the vocabulary only: **nothing is enforced yet**, so
  no existing call changes behaviour. `Document.Open(buf, { limits })` accepts
  an immutable policy of sixteen bounds (input bytes, object count, `/Prev`
  chain length, nesting depth, decoded stream size, expansion ratio, image and
  canvas pixels, content tokens, …) and reads it back as `doc.loadLimits`.
  Defaults are bounded, and opting out is explicit: `LoadLimits.unlimited()` for
  trusted input, or `LoadLimits.defaults.with({ maxFileBytes: null })` to
  disable one bound alone. `with` rejects an unknown field name rather than
  ignoring it, because a typo that silently fails to lift a limit is the failure
  this exists to prevent. `ResourceLimitError` is deliberately a sibling of
  `PdfParseError`, not a subclass, so "too big" never triggers the recovery
  ladder meant for "broken", and it names the field it refused. The default
  expansion ratio is 2,000:1, not 1,000:1 — measured, zlib reaches 1028:1 on a
  run of zeros, so the round number would refuse a legitimate stream. The parse,
  filter and render boundaries start enforcing in follow-up releases. (ibzo.1)

- **`ValidatePdfUa(2)` now answers ISO 14289-2 8.10.3.5-1** — a graphic forming
  part of a signature's appearance needs alternative text. A signature widget
  (`/FT /Sig`) whose `/AP /N` paints an image, a shading or a path, and whose
  enclosing structure element chain carries no `/Alt`, reports. The `/Alt` may
  be **inherited** from any ancestor, which is deliberately not the same lookup
  as the private-use rule's — that one reads the element directly. Text alone in
  an appearance is not a graphic, so an ordinary typed-name signature field does
  not report. This completes clauses 8.9 and 8.10 at 26 rules, and PDF/UA-2
  validation at all 91 rules of the reference profile.

  **Note this one rule is an APPROXIMATION rather than a transcription**, and
  the source says so. The reference validator states it over a grouped
  *content-item* model — each graphic item carrying its own structure parent and
  inherited attributes — which this library does not have; the question is
  therefore asked once per signature annotation rather than once per content
  item. The two differ only when a single signature appearance is internally
  tagged with marked content pointing at different structure elements carrying
  different `/Alt` values, which no real signature appearance does. Every other
  PDF/UA rule in this library is a faithful transcription. (`q7hc.4.6`)

### Changed

- **A reflow no longer leaves dead text-positioning operators behind.** `ReplaceText({ adjust: 'reflow' })` and `RestyleText` with reflow position each moved word with a `Tm`, then restore the line matrix with another. They never removed what a `Tm` made pointless: a `Td`, an older `Tm` or a kern-only `TJ` with nothing drawn before it, or positioning just before `ET`. Every edit to the same paragraph therefore stacked another pair per moved line, measured at +11 `Tm` per reflow and 270 to 1,640 bytes over six edits. A content stream the reflow writes into now drops any contiguous run of such operators that a following `Tm` or `ET` overwrites. `TD`, which also sets the leading, is always kept. Six reflows in a row now stay at no more than two `Tm` per line, and every glyph lands exactly where the old output put it, checked by glyph position against output recorded before the change. The first reflow over a fresh paragraph is 40 to 56 bytes smaller as well. Streams a reflow does not write into, and `adjust: 'shiftRest'`/`'spaceWidth'`, are unchanged. (r9u0)

- **BREAKING: a hyphen inserted by hyphenation extracts as a soft hyphen (U+00AD) in a Standard-14 face.** `AddTextBlock`, Flow paragraphs, lists and table cells, `AddMarkdown` and `ReplaceText({ adjust: 'reflow', hyphenate })` used to draw a hyphenation break as `-`. A drawn `-` might be an author's compound hyphen, so a later reflow could never rejoin it, and even one reflow over hyphenated text stranded `extraor- dinary` mid-line. The break is now written as WinAnsi code `0xAD`, which Annex D defines as a second `/hyphen`, so the glyph and width are unchanged and the page renders pixel for pixel as before. It reads back as U+00AD, so `GetText`, `Search` and the exports return U+00AD at each break where they returned `-`, and a second reflow rejoins the word. A reflow in a document's own font writes its soft-hyphen code only where one decodes to U+00AD, has a defined glyph and has exactly the width of `-`; otherwise it keeps `-`. An embedded authoring font still draws `-`, since one of its glyphs has one Unicode meaning. Without `hyphenate` nothing changes. (rhud)

- **A cited link's mark goes to its note, and a tagged note's mark sits in a `/Link`.** A run that was both a URI link and a citation used to make its mark a second link to the same URI; the words keep the URI and the mark now links to the note. In a tagged flow the note's own mark is no longer the `/Note`'s direct content but a `/Link` child of it, and the citation mark gets its own `/Link` beside the citing text — so tagged output with notes changes even where nothing else did. `links: false` restores both. (v9j3.3.4)

- **`skipped` no longer names a note reference in a table cell.** Markdown's `footnote (table cell)` and DOCX's `w:footnoteReference (table cell)` and `w:endnoteReference (table cell)` are gone, because such a reference now renders. A caller filtering `skipped` on those names stops seeing them; `footnote (nested)` and `(in a note)` still report a reference inside a note. (v9j3.3.3)

- **A `FlowNote` may be cited more than once.** Citing the same note object from several runs used to throw `TypeError` ("may be referenced only once"). Now the first citation in reading order numbers the note and places it, and every later citation draws the same mark with no body of its own — so it reserves no room at the column foot, adds nothing to the endnotes and makes no second `/Note` in a tagged flow. This is GitHub's footnote model, which Markdown footnotes need, and code that never cited a note twice is unaffected. (v9j3.3.1)

- **`ReplaceText` re-encodes text in Type0 fonts where it can, and `doc.ReplaceText` is all-or-nothing.** Writing into a Type0 (composite) font always threw; a font under `/Identity-H` or `/Identity-V` now takes any character its `/ToUnicode` maps to a glyph the program holds, so a subset can be rewritten with the letters it already contains. `doc.ReplaceText` now plans every page before changing any, so an error on page 3 leaves pages 1 and 2 as they were, where before they were already rewritten. The count it returns is the number of occurrences found. (u3l5.2)

- **`ReplaceText` drops the kerning between glyphs it replaced.** When a match spans several elements of one `TJ` array, a kerning number between two of those elements adjusted the spacing of glyphs that no longer exist, and it stayed behind after the replacement: `[(Hel) -50 (lo)] TJ` became `[(World) -50 ()] TJ`. Such a number is now removed. It is removed only when every string between the match's first and last element is wholly part of the match, because layout orders text by position and a `TJ` can draw it out of order — a kerning number that positions text outside the match is always kept. Kerns before and after a match, and every line and text-matrix operator, are untouched. (u3l5.1)

- **`ReplaceText` removes a `Tj` it emptied.** When a match spans several show operators, the replacement goes into the operator where the match starts and the others only lose their matched text; one that lost everything used to stay behind as `() Tj`. A `Tj` emptied this way draws nothing and moves nothing, so it is now removed. A `TJ` is kept even when emptied, since its kerning numbers still move the pen, and so are `'` and `"`, which move to the next line. A `Tj` that was already empty before the replace is left alone. (u3l5.1)

- **`ReplaceText` can delete text set in a Type0 font.** An empty replacement used to throw `UnsupportedFeatureError` for a Type0 (composite) font, because the font cannot re-encode text and the empty string was encoded like any other. Deleting matched text writes no characters, so it now succeeds: the matched codes are cut whole, in any font. Writing text into a Type0 glyph still throws, before anything changes. (u3l5.1)

- **`Ask` and `GenerateAltText` tighten three edges.** `Ask` returning `found: false` now cites no pages, whatever the model listed — an answer that was not found has no source. A question so long that not even the best passage fits beside it within `maxInputChars` is now a `RangeError` before any request, where it used to send a request over the budget anyway. `GenerateAltText` on an untagged document with no picture to describe leaves the document untagged instead of auto-tagging every page for nothing; it also renders a page once for all of its picture-less figures (vector charts, barcodes), where a page holding several was rendered once per figure. A tagged figure judged decorative, or whose request failed, is still asked about on the next run, by design: nothing is written for it, so nothing records that it was asked. (u0ec)

- **A bad `pdfaProperty:category` is reported as `XmpExtensionField`.**
  `ValidatePdfA` reported a category other than `internal`/`external` under
  `XmpExtensionValueType`, the rule for a value type no schema declares. It is
  a malformed field, so it now reports under `XmpExtensionField`, beside the
  schema's other field-shape faults; a caller filtering on the old rule id
  for this case must switch (o6uu.11).

- **`AddStamp({ name })` captions a standard name the way a stamp reads.**
  `AddStamp({ name: 'NotApproved' })` drew the text `NotApproved`; it now
  draws NOT APPROVED, and each of the 14 standard names in ISO 32000-1
  12.5.6.12 is spelled out in capitals the same way. Any other name, and every
  `AddStamp({ text })`, is drawn exactly as given, as before. The change makes
  a stamp this library creates read the same as the one it now draws for a
  stamp that has no appearance. (v0tz.2)

- **`ValidatePdfUa()` now checks PDF/UA identification at part 1**, not only at
  part 2. `ConvertToPdfUa()` has written `pdfuaid:part 1` since it existed and
  nothing verified it; veraPDF's PDF/UA-1 profile carries clause 5 exactly as
  the PDF/UA-2 one does, so this was a gap rather than a difference between the
  parts. **A document that is otherwise UA-1 conformant but carries no
  `pdfuaid` will now report** — which is the point of the change. Note the two
  clauses are *not* the same rule: part 1 wants `pdfuaid:part 1` and states no
  `rev` requirement at all, since PDF/UA-1 carries `amd` and `corr` where
  PDF/UA-2 carries `rev`. Requiring a rev at part 1 would report on every
  conformant UA-1 file, including the ones this library writes. (`q7hc.4.5`)

- **BREAKING (report severity): PDF/UA identification is now a WARNING rather
  than an error**, at part 2 as well as part 1. Every rule of clause 5 is
  tagged `minor` in the reference profile at both parts, and this library maps
  that to a warning — the same treatment tab order already gets. The practical
  effect is that `ValidatePdfUa(2).Passed` can now be `true` for a document
  whose only defect is missing or wrong identification, where it was `false`
  before; the finding still appears in `Issues` and in `Warnings`. This is what
  keeps an authored tagged document passing `ValidatePdfUa` outright, since
  authoring deliberately writes no `pdfuaid` — making a conformance claim on
  the author's behalf is not the library's business. Callers who want
  identification treated as fatal should test for the `PdfuaIdentification`
  rule id directly rather than reading `Passed`. (`q7hc.4.5`)

- **PDF/A level `a` validation does not report missing PDF/UA
  identification.** ISO 19005 level `a` requires PDF/UA-1 *tagging*; it does
  not require the document to carry a PDF/UA *conformance claim*, which is what
  `pdfuaid:part` is. A PDF/A file identifies itself through `pdfaid:part`.
  Without this exclusion the previous entry would have reported on essentially
  every conformant level-`a` document. (`q7hc.4.5`)

### Added

- **A GoTo action now carries a structure destination (`/SD`) in a tagged
  document** — `page.AddLink({ action: { type: 'goto', … } })` and everything
  built on it, including a table of contents. `/SD` is written **beside** the
  existing `/D`, never in place of it: a PDF 1.7 viewer reads `/D` and navigates
  exactly as before, while a PDF 2.0 viewer reads `/SD`, so there is no
  compatibility cost. It is written only when the document is tagged and a
  structure element resolves for the target page — the first such element in
  tree order — so an **untagged document is byte-identical**. Note outline
  items, `/OpenAction` and named destinations are deliberately unchanged and
  still report under 8.8-1: their destination is tested directly, so satisfying
  the rule there would mean a destination older viewers cannot resolve, and
  trading navigation for a conformance line is the caller's decision rather
  than the library's default. (`q7hc.4.4`)

- **`ValidatePdfUa(2)` now answers ISO 14289-2 clauses 8.7, 8.8 and 8.14.1** —
  optional content, intra-document destinations and embedded files. Five rules:
  every optional-content configuration dictionary needs a non-empty `/Name`, and
  none may carry `/AS` (8.7-1,2); every destination whose target is inside the
  document must be a *structure* destination, both standalone and inside a GoTo
  action (8.8-1,2); and every file specification in the `/EmbeddedFiles` name
  tree needs a `/Desc` (8.14.1-1). **Note two asymmetries that are easy to get
  backwards.** The `/Name` rule fires only when the catalog's `/OCProperties`
  carries a `/Configs` array — a document with only a default configuration is
  exempt entirely — while the `/AS` prohibition is ungated and examines the
  default too. And a standalone destination qualifies as a structure
  destination when its first array element is a structure element, whereas a
  GoTo *action* qualifies only through `/SD`: a structure-destination array in
  its `/D` does **not** satisfy the rule. Note also that 8.7-2 prohibits
  automatic optional-content usage application outright, since `/AS` is what
  makes a `/Usage` entry do anything. Nothing here is converted; all five land
  in `unresolved`. (`q7hc.4.4`)

- **`ValidatePdfUa(2)` now answers ISO 14289-2 clauses 8.4.3, 8.4.4 and 8.6** —
  private-use characters and natural language. Six rules: real content mapping
  to a Unicode private-use code point needs an `/ActualText` or `/Alt` to say
  what it means, and neither of those strings may itself contain one
  (8.4.3-1..3); the catalog must state `/Lang`, and every `/Lang` — the
  catalog's, a structure element's, or a marked-content property list's — must
  be a valid language identifier (8.4.4-1,2); and no human-readable text string
  may use the private-use area (8.6-1). **Note three things a reader would
  otherwise get wrong.** The private-use area is *three* ranges
  (U+E000–F8FF, U+F0000–FFFFD, U+100000–10FFFD), both supplementary bounds
  ending at `FFFD` because the last two code points of each plane are
  noncharacters. 8.4.4-1 tests only that `/Lang` is *present*: an empty value is
  caught by the syntax rule instead, so the two together give the answer neither
  gives alone. And an `/Alt` excuses a private-use glyph only on that glyph's
  *own* structure element or an enclosing marked-content sequence — not on an
  ancestor element, which is the opposite of the intuitive reading. 8.6-1 checks
  a curated set of entries this library models as human-readable (document
  metadata, outline titles, annotation and field text, structure `/Alt`,
  `/ActualText`, `/E` and `/T`, and attachment descriptions) rather than every
  string in the file, which would report on binary values such as `/ID` and
  encryption or signature data. (`q7hc.4.4`)

- **`GlyphEvent.mcProps` reports the marked-content string attributes in scope**
  — the `/ActualText`, `/Alt` and `/Lang` inherited from the innermost `BDC`
  that states each, including one carried on a form the page draws. It is
  **absent unless some BDC in scope states one**, which is `GlyphEvent.color`'s
  rule and keeps every existing consumer byte-identical. It rides on the glyph
  rather than on the marked-content event because that event fires only when an
  `/MCID` resolves, while a `BDC` may carry `/ActualText` with no `/MCID` at
  all — and ISO 14289-2 8.4.3-1 reads exactly that case when deciding whether a
  private-use code point has been given a meaning. (`q7hc.4.4`)

- **`ValidatePdfUa(2)` now answers ISO 14289-2 clause 8.4.5** — the five glyph
  rules, which complete the clause at fifteen. An embedded font must define
  every glyph the document shows (8.4.5.5.1-2), the width in the font dictionary
  and the width in the font program must agree within one unit of 1/1000 em
  (8.4.5.6-1), every code shown must map to a Unicode value and that value must
  not contain U+0000, U+FEFF or U+FFFE (8.4.5.8-1,2), and no text-showing
  operator may reference `.notdef` (8.4.5.9-1). **Findings are deduplicated per
  (font, code, render mode)**, matching the reference validator's own glyph
  cache: a page with five thousand `e`s in one font yields at most one finding
  rather than five thousand. Four of the five exempt render mode 3, the
  invisible OCR layer of a scanned page; `.notdef` deliberately does not, since
  a `.notdef` there still stands for text that is lost. (`q7hc.4.3`)

- **`ValidatePdfUa(2)` now answers ISO 14289-2 clause 8.4.5** — fonts and CMaps.
  Five more rules over composite fonts: a CMap outside ISO 32000-2 Table 116
  must be embedded, an embedded CMap's `/WMode` must match the one its stream
  dictionary states, a CMap may not reference one outside Table 116
  (8.4.5.4-1..3), an embedded `CIDFontType2` must state `/CIDToGIDMap`
  (8.4.5.3.2-1), and a CIDFont's `/CIDSystemInfo` must agree with its CMap's
  registry and ordering with a supplement no higher (8.4.5.3.1-1). **Note
  Table 116 is sixty-one names where this library bundles 195 predefined Adobe
  CMaps** — "do we have this CMap" and "does PDF 2.0 sanction it" are different
  questions, and answering the first would pass 134 CMaps the rule exists to
  report. `Identity-H` and `Identity-V` are exempt from the `/CIDSystemInfo`
  rule by name: they belong to no character collection, so there is nothing to
  agree with. (`q7hc.4.3`)

- **`ValidatePdfUa(2)` now answers ISO 14289-2 clause 8.4.5** — fonts. The first
  five rules: every rendered font embedded (8.4.5.5.1-1), and the four TrueType
  encoding rules (8.4.5.7-1..4) — a non-symbolic face needs a `(3,1)` or `(1,0)`
  cmap subtable and a `MacRomanEncoding` or `WinAnsiEncoding` base with
  Unicode-resolvable `/Differences`, a symbolic one needs a `(3,0)` or `(1,0)`
  subtable and must state no `/Encoding` at all. The embedding rule exempts
  Type 3 (its glyphs are content streams, so there is no program to embed),
  Type 0 (the rule falls on its descendant) and render mode 3, the invisible OCR
  layer of a scanned page. **Note PDF 2.0 grants the Standard 14 no exemption**,
  so a document drawing unembedded Helvetica now reports — a true positive that
  `ConvertToPdfUa` deliberately does NOT fix, because embedding a face means
  choosing one and writing it into the file, which is authoring rather than
  remediation. Every rule here lands in `unresolved`. (`q7hc.4.3`)

- **`TextFont.dictWidth(key)` reports the width the font DICTIONARY states**, or
  `undefined` where it states none — a code for a simple font, a CID for a
  composite one. It is deliberately **not** `Glyph.width`, which falls through
  to the embedded font program when `/Widths` (or `/W`) has no entry for the
  key: that fallback is right for measuring text and fatal for asking whether
  the dictionary and the program AGREE, since comparing `Glyph.width` against
  the program compares the program's answer with itself. It mirrors the width
  lookup's first two branches and stops before the fallback, so the two cannot
  disagree about what the dictionary says. (`q7hc.4.3`)

- **`GlyphEvent.renderMode` reports the text rendering mode** (`/Tr`), the one
  text-state operator the content walk did not track. It is **absent for mode
  0**, the PDF initial value, which is `GlyphEvent.color`'s rule and keeps every
  existing consumer that compares an event byte-identical — read it as `?? 0`
  rather than testing presence. It exists because four of ISO 14289-2's five
  glyph rules exempt mode 3, invisible text, which is the OCR layer of every
  scanned PDF: without it those rules would fire on exactly the population they
  are written to excuse. Note the new field IS restored by `Q` while the five
  text-state values beside it (`Tc`, `Tw`, `Tz`, `TL`, `Ts`) are not, which is a
  pre-existing divergence from 32000-2 9.3.1 filed separately — scoping this one
  correctly matters because an OCR tool that wraps its invisible layer in
  `q` … `Q` would otherwise leave the mode stuck at 3 and silently exempt the
  visible text after it. (`q7hc.4.3`)

- **`ValidatePdfUa(2)` now answers ISO 14289-2 clauses 8.9 and 8.10** —
  annotations and forms. Twenty-five rules: the annotations that must be
  artifacts (Invisible, NoView without ToggleNoView, zero-size widgets,
  printer's marks), the ones that must describe themselves (`/Ink`, `/Screen`,
  `/3D`, `/RichMedia`, and a rubber stamp with neither `/Name` nor
  `/Contents`), enclosure (markup annotations in an `Annot`, field widgets in a
  `Form`, at most one widget per `Form`, a `/Popup` that must NOT be tagged),
  the subtypes PDF/UA-2 prohibits outright (`/Sound`, `/Movie`, `/TrapNet`),
  `/XFA`, tab order, and three textual-equivalence rules — `/Contents` against
  the enclosing element's `/Alt`, `/RC` against `/Contents`, and a text field's
  `/RV` against its `/V`. The last two reduce rich text the way the standard's
  reference validator does, by concatenating every text node, which is a new
  `{ verbatim: true }` mode on the existing reducer rather than a second one;
  the default is unchanged. Note what is NOT converted: every rule here lands in
  `unresolved`, because an absent `/Contents`, a missing label, a prohibited
  `/Sound` and an XFA packet are all authoring or destructive decisions — though
  `ConvertXfaToAcroForm()` converts the fields and removes `/XFA`, so running it
  first satisfies that rule for free. All part 2 only; part 1 is unchanged.
  (`q7hc.4.2`)

- **`ValidatePdfUa(2)` now answers ISO 14289-2 8.2.5**, the per-type structure
  requirements: a `TOCI` that identifies no target, the prohibited `H` and
  `Note` types, a footnote whose `/Ref` graph does not close in both
  directions, a link annotation outside a `Link`/`Reference` element or sharing
  one with a link that targets elsewhere, malformed `Ruby` and `Warichu`
  sequences, a labelled list with no numbering, an `LI` owning content
  directly, a misplaced `Caption`, MathML outside a `Formula`, and — the
  substantial half — table regularity and header connectivity. Tables are
  placed on a new occupancy grid that puts every cell where the document
  DECLARES it rather than where it fits, which is what makes an overlap or an
  overhanging span visible at all; header association follows ISO 32000-2
  14.8.5.7, including that an absent `/Scope` is filled in from the cell's
  position rather than treated as absent, and that a table whose every header
  states a scope is connected without a single cell being examined. Note two
  readings that are not the obvious ones: `ListNumbering` is INHERITED, so a
  nested list covered by an outer declaration does not report, while an absent
  `NoteType` reads as the default `None` and PASSES. Twenty rules, all part 2
  only — part 1 is unchanged. The twenty-first rule of the clause, a Figure's
  alternate text, was already reported at both parts and is not duplicated.
  (`q7hc.4.1`)

- **`StructElement.References`** reads an element's `/Ref` entry — the structure
  elements it points at, which is how a `TOCI` names its target and how a
  footnote and its citations reference one another. Deliberately not spelled
  `Refs`: `StructElement.Ref` already exists and is the element's own object
  reference, so the plural would be one letter from an unrelated thing.
  (`q7hc.4.1`)

- **PDF/UA-2 validation and remediation.** `doc.ValidatePdfUa(2)` and
  `doc.ConvertToPdfUa({ part: 2 })` target ISO 14289-2:2024, the PDF 2.0
  sibling of PDF/UA-1; both default to part 1, so every existing call is
  unchanged. Part 2 adds the `pdfuaid:part`/`pdfuaid:rev` identification, `/P`
  on every structure element, the catalog `/Metadata` stream, the namespace
  rules, and the requirement that the structure tree root hold a single
  `Document` element in the PDF 2.0 standard structure namespace — which
  conversion satisfies by wrapping existing top-level elements in one,
  preserving reading order. Note what part 2 does NOT require, because the
  obvious reading is wrong: an element that states no `/NS` is in the PDF 1.7
  namespace by default and is perfectly conformant, so a tree carried over from
  PDF/UA-1 needs no per-element change. Structure namespaces are also readable
  and writable directly — `element.Namespace`, `root.Namespaces`,
  `root.DeclareNamespace(uri)` and an `ns` option on `Append`, which is what
  lets a PDF 2.0 type such as `Aside` or `FENote` be authored at all
  (`q7hc.4`).

- **Structure elements can be moved and reordered.**
  `StructElement.MoveTo(parent, index?)` re-parents an element and its subtree
  — `parent` being another element or the tree root, `index` counting element
  children and defaulting to last — and `ReorderChildren(order)` permutes an
  element's children in place, leaving its own content items where they were.
  Reading order IS the tree's order, so this is what fixes a reading order
  `AutoTag` got wrong, which its geometric heuristic regularly does on a
  multi-column page with a full-width banner. Neither touches the
  `/ParentTree`: every MCID still resolves to the same element on the same page
  afterwards. Where an element relied on an inherited `/Pg`, the move
  materializes it first, so re-parenting across pages cannot silently re-point
  its marked content. A move into the element's own subtree, into a different
  structure tree, or at an out-of-range index is refused with a `RangeError`
  and writes nothing, as is a reorder whose argument is not exactly the
  element's children. Note the tree's order drives `GetText`,
  `StructElement.Nodes` and the `ToHtml('semantic')` / `ToMarkdown` / `ToDocx`
  / `ToEpub` exports; `GetStructuredText` is geometric and is unaffected by
  either (`q7hc.3`).

- **A structure element can be removed.** `StructElement.Remove()` detaches an
  element and its subtree, releases every `/ParentTree` slot its content items
  and `/OBJR` kids hold, and returns
  `{ elements, mcids, annotations, unreachable }`. **It does not delete ink:**
  the `BDC`/`EMC` pair around the content is removed while every operator
  between them survives, so the marked content stays on the page and becomes
  untagged — which `ValidatePdfUa` now reports as `UntaggedContent`, a true
  statement the caller can act on, where deleting the content would be a silent
  edit to the page. An annotation keeps its `/Annots` entry and loses only its
  `/StructParent`. Removing an already-detached element is a no-op returning
  zeroes (`q7hc.2`).

- **A structure element's type is writable.** `StructElement.SetType(type)`
  changes `/S` and rewrites the marked-content `BDC` tag behind that element's
  own content, returning `{ retagged, unreachable }`; `element.Type = 'H2'` is
  the same operation with the report discarded. Retyping is the commonest
  repair after supplying an `/Alt` — `AutoTag` is documented as a starting
  point a human refines, and until now an element it typed wrongly could not be
  corrected through the public API at all. The rewrite fails open: a `BDC` the
  content walk cannot address (inside a tiling pattern, a Type 3 `/CharProcs`
  or an annotation appearance) keeps its stale tag and is counted in
  `unreachable` rather than throwing, because the tag name is advisory — the
  `/MCID` is what binds content to the tree (`q7hc.1`).

- **`ConvertToPdfA('1b')` now drops a transparency group that provably does
  nothing.** ISO 19005-1 prohibits transparency and conversion cannot flatten
  it — correctly, since flattening means rasterizing the page and losing its
  text — so a page carrying `/Group /S /Transparency` was reported unresolved
  and left alone. But producers stamp that group on pages that use no
  transparency at all, where it cannot change the rendered result, so removing
  it costs nothing and is the difference between a document that converts and
  one that does not. The test is deliberately conservative and reads no
  content stream: every ExtGState in a resource dictionary counts whether or
  not any operator selects it, and a soft mask, a non-Normal blend mode, a
  constant alpha below 1, an image `/SMask` or `/Mask`, or a nested
  transparency group anywhere the page's resources reach — through form
  XObjects, patterns and Type 3 fonts alike — all keep the group. False means
  "transparency is ruled out", so the over-approximation is the safety
  property: a page that really uses transparency keeps its group and is still
  reported. Page groups only; `preserve: ['transparency']` declines the pass
  (`ixxw.5`).

- **A spot colour can now survive colour conversion instead of being
  flattened.** `ConvertColors` neutralises colour at the operator level, so
  `/Sep cs 1 scn` became `1 0 0 rg`: the page looked identical and the NAMED
  COLORANT was gone, which for a print workflow means the plate it would have
  been separated onto no longer exists. The new
  `preserveSpotColors` option rebuilds the SPACE instead — a Separation or
  DeviceN keeps its kind, its colorant names and its component count, and only
  the alternate space and tint transform move, so every content stream that
  selects it is untouched and a Separation image keeps its tint samples byte
  for byte. PDF has no way to compose a tint transform with an alternate-space
  conversion, so the composition is resampled into a type 0 sampled function:
  256 samples for one colorant, and one axis per colorant against a fixed
  total budget beyond that, so a four-colorant DeviceN samples coarsely rather
  than exploding. A linear tint lands on the sample points and round-trips
  exactly; a curved one is right to within a step or two per channel, and the
  report says which grid was used rather than implying exactness. The option
  is **off by default**, so every existing caller is byte-identical —
  `ConvertToGrayscale` means what it says, and a document asked to be grey
  should not still carry a spot colorant a RIP would ink. `ConvertToPdfA` sets
  it, where the point is conformance rather than colour reduction (`ixxw.4`).

### Changed

- **BREAKING: a structure type is now validated where it is written.**
  `StructTreeRoot.Append`, `StructElement.Append` and the new
  `StructElement.SetType` reject a type that is neither one of the 49 standard
  structure types nor mapped to one through the struct root's `/RoleMap`,
  throwing `RangeError`. Previously any name whatever was accepted and written
  to `/S`, and the document then failed `ValidatePdfUa`'s `StandardType` rule
  with nothing at the call site to say so — a tree that looks tagged and is not
  conformant. Map a deliberate custom type first with
  `RegisterRole(custom, standard)`, which is what it is for. The check runs
  before anything is allocated, so a rejected call leaves the document
  byte-identical (`q7hc.1`).

### Fixed

- **`ValidatePdfUa` called content tagged when its `/MCID` resolved to
  nothing.** `UntaggedContent` tested only whether a marked-content sequence
  carried an `/MCID`, so a `BDC` naming a `/ParentTree` slot that holds no
  element — a slot released by `StructElement.Remove`, or a mapping a
  third-party producer never wrote — read as perfectly tagged and no rule
  fired. It now requires the `/MCID` to resolve to a structure element, which
  is what "tagged" means. Measured: this moved no existing test, because every
  `/MCID` this library authors resolves; it is a fix for documents we did not
  write (`q7hc.2`).

- **An image's colour space did not count as device colour, so a CMYK picture
  passed PDF/A validation under an sRGB intent.** The page scan behind
  `ValidatePdfA` looked at colour OPERATORS and inline images only, so a page
  whose only colour is an image XObject reported no device colour at all —
  and ISO 19005-1 6.2.3.3 constrains the colour space, not the route by which
  content selects it. Two things followed, both silent: a DeviceCMYK payload
  validated clean under an RGB output intent, and a document whose only colour
  was a picture was never asked to carry an output intent in the first place.
  The scan now reads an image's `/ColorSpace` in all three shapes a document
  can write it — a direct device name, a name into the page's
  `/Resources /ColorSpace`, and an inline array, where only `/Indexed`
  delegates to its base since every other family is device-independent and
  permitted under any intent. Because `ConvertToPdfA`'s colour pass triggers
  on the same scan, a CMYK image is now converted as well as reported:
  DCTDecode payloads take the decode-and-re-encode route (both APP14
  transforms, plain CMYK and YCCK), coming out as 8-bit DeviceRGB with the
  stale `/Decode` gone, and the route each picture took is named in the
  conversion report. An `/ICCBased` image is deliberately left alone — it is
  device-independent and already conformant, so converting it would be a lossy
  re-encode buying nothing (`ixxw.3`).

### Added

- **`ConvertToPdfA` now normalises device colour to the output intent.** Since
  the validator started checking device colour against the intent's profile
  space, a combination the converter itself produces became non-conformant:
  it bolts an sRGB intent onto a document that has none, so a DeviceCMYK
  document came out of `ConvertToPdfA` failing its own post-conversion
  validation. A new pass runs the existing colour walk — page content, form
  XObjects, Type 3 glyph procedures, tiling patterns, inline images, image
  XObjects, shadings and annotation colour arrays — so the document's colour
  matches what its intent declares. It converts **only toward an RGB intent**,
  and that is a decision rather than a limitation: the rewrite there is the
  same pivot the renderer applies, so the rendered page is unchanged, which is
  what makes doing it automatically defensible. Under a caller-supplied CMYK
  or GRAY intent the content is left alone and reported unresolved, because
  converting would mean naive maximum-black ink with no destination profile —
  which `ConvertToPdfX` already refuses to do without an opt-in — or
  discarding colour outright. The trigger is DeviceCMYK in a page scan,
  matching exactly what the validator would report, so a document that needs
  nothing is not touched; `preserve: ['deviceColor']` declines the pass and
  takes the unresolved report instead, and a signed document is skipped rather
  than made to throw (`ixxw.2`).

### Fixed

- **An output intent whose ICC profile was written inline read as no output
  intent at all.** 32000-1 7.3.8 says every stream shall be indirect, so a
  `/DestOutputProfile` written directly into the intent dictionary is
  malformed — but this parser accepts it, as it accepts damage generally, and
  a document we did not write is exactly the population that leniency is for.
  The profile counter folded every inline profile onto a single sentinel and
  then reported the first indirect one it had seen, which was wrong in both
  directions: a lone inline profile set no such reference and fell through to
  "missing", so `ValidatePdfA` reported `OutputIntent` and
  `DeviceColorWithoutIntent` against a file whose intent is plainly there and
  skipped the transparency blending-space rule's precondition; and two
  DIFFERENT inline profiles shared the one sentinel, so a document naming two
  output conditions — which ISO 19005 prohibits — read as naming one and went
  unreported. Profiles are now counted by identity, an object number for a
  reference and the stream itself for an inline one, and the function answers
  with a marker rather than a reference, since no caller ever read it and
  answering with one for a reference and nothing for a stream is the asymmetry
  that produced the bug (`xu3j`).
- **`ValidatePdfA` passed DeviceCMYK content under an sRGB output intent.**
  ISO 19005-1 6.2.3.3 does not ask whether an output intent EXISTS, which is
  all the rule tested; it asks whether the intent's profile is a profile of the
  space the content uses. So a CMYK document carrying the sRGB intent almost
  every producer emits validated clean, and the conformance claim it then wrote
  into its own XMP was false — the single most likely way to ship a file a
  certified validator rejects. The intent's ICC profile is now parsed through
  `icc.ts` and its declared data colour space compared per device space:
  DeviceCMYK is permitted only under a CMYK profile, DeviceRGB only under an
  RGB one, and DeviceGray under either, which is what the standard says and
  what veraPDF enforces. Device colour is found by OPERATOR (`k`, `rg`, `g`)
  as well as by resource name, so a page that names no colour space at all is
  still checked. The space is read from the profile HEADER rather than from the
  stream dict's `/N`: both answer "how many components" and they agree in every
  real file, but `/N` is the producer's claim about the wrapper where the
  header is the profile's own statement, and `ICCBasedN` already reports the
  two disagreeing. A profile that will not parse is not checked at all and the
  rule falls back to its previous answer — the lenient-read posture this
  library takes for every embedded payload — so no document starts failing over
  damage the rule has no opinion about (`ixxw.1`).
- **A hidden run did not advance the pen when rendering, so the text after it
  overprinted.** Optional content is suppressed at one gate in the
  interpreter, and that gate skipped the whole show operator — while the text
  matrix is advanced *inside* the show. A text object mixing a hidden run with
  a visible one therefore drew the visible one where the hidden one began,
  piling the words on top of each other; a `TJ` array's kerning shifts were
  lost the same way. A show operator occupies its width whether or not anybody
  sees it (32000-1 9.4.4). The advance now sits outside the gate and only the
  ink, the paint-state sync and any text clip sit inside it — which is the
  shape the same function already used for the invisible render mode (`3 Tr`),
  and the rule extraction has held since `q1g2.3`, where the hidden flag
  suppresses the glyph event and never the advance. Bites any document that
  puts a watermark, a redaction overlay or a translation layer in the same
  text object as visible text (`q1g2.7`).
- **Text and vector extraction reported content no viewer shows.** The
  visibility resolver behind `doc.OptionalContent` was consumed only by the
  renderer (`q1g2.1`, `q1g2.2`), so `GetText`, `GetTextFragments`,
  `GetStructuredText`, `GetPaths`, `GetTables`, `Search` and every export
  built on them returned the words of a switched-off watermark, a "do not
  print" overlay or a disabled CAD layer — the same library's own `ToImage`
  having correctly left them out. All of those now answer "what does this page
  SHOW"; pass `{ includeHidden: true }` to ask what the file CONTAINS, which
  is what a forensic read or a redaction audit wants.

  The gate sits in the new `ocvisible.ts`, one owner for three walkers that
  must not disagree — the renderer's, `visitContent`'s and `GetPaths`'s own —
  because the nesting rule is exactly the sort that differs silently: a walker
  pushing only for `/OC` still hides the right ops on every single-level
  document. **The walker's default is to report EVERYTHING**, and that
  direction is the safety property rather than a conservative default:
  `RedactText`, `MarkRedactText`, `ReplaceText`, `page.InlineImages`,
  `MarkContent`, `page.Artifacts`, `AutoTag` and the structure validator go
  on acting on what the file holds, so redaction cannot quietly remove less
  than it was asked to, and the next consumer somebody adds inherits the safe
  default rather than the dangerous one. `Search` diverging from `RedactText`
  on one page is deliberate and asserted from both sides.

  Extraction also keeps the pen advancing across a hidden show operator, where
  the renderer skips it — a hidden run occupies its width, so suppressing the
  advance would misplace every visible glyph after it in the same text object,
  which is a wrong quad rather than an absent one. (`q1g2.3`)

- **A non-embedded symbol font drew Latin letters; it draws boxes now.**
  `normalizeFont` maps every unrecognised `/BaseFont` onto one of the
  Standard 14, defaulting to Helvetica, so a page whose font was
  `/Wingdings-Regular` rendered as ordinary text. The mechanism is worth
  stating because it is not obvious: a font with no `/Encoding` defaults to
  WinAnsi, so code 0x6C resolves to the text `l`, and the Helvetica substitute
  has an `l` to draw. The page looked fine and said something the document did
  not.

  Such a font now gets no substitute at all, so each glyph falls to the
  placeholder box the renderer already draws for anything unresolvable — a box
  says "this glyph is missing", which is the honest answer. The trigger is a
  conjunction, and deliberately narrow: the descriptor must set Symbolic and
  not Nonsymbolic, the name must not be a recognised Standard-14 one, no
  installed face may have matched, and the font must state neither `/Encoding`
  nor `/Differences`. That last clause is the load-bearing one — this library
  already records that the `/Flags` symbolic bit is widely wrong in the wild,
  so boxing on the flag alone would turn a mis-flagged *text* font into a page
  of boxes, which is worse than the defect. A producer that mis-sets the flag
  still says what its codes mean.

  `Symbol` and `ZapfDingbats` are untouched, being recognised names; so is a
  non-embedded `/Arial`. Registering a render folder that holds the real face
  (`RegisterRenderFontFolder`) resolves it properly and no box is drawn.
  (`lqcs.4`)

### Added

- **Flattening optional content down to one rendering.**
  `doc.FlattenLayers()` keeps only what the default configuration *shows* and
  then takes the vocabulary away: every marked-content span the configuration
  hides is deleted from the content stream it sits in, hidden XObject draws and
  hidden annotations go with them, every surviving `/OC` wrapper and `/OC` key
  is removed, and `/OCProperties` is deleted. The result is an ordinary PDF
  with no layers left to toggle that renders exactly as the configuration
  rendered. The deletion is the point: until now the only way to lose a layer
  was to *unreference* it, which leaves the ink in the file for anyone who
  looks — and which is what `ConvertToPdfA('1b')` did on its own, since
  ISO 19005-1 prohibits optional content and the converter simply dropped
  `/OCProperties`, making every hidden group unconditionally **visible**.
  Flattening first is what makes that conversion honest. It reaches all five
  nested content scopes as well as page content — form XObjects, tiling
  patterns, Type 3 glyph procedures, soft-mask groups and annotation appearance
  streams — because a section left standing in any one of them becomes visible
  the moment `/OCProperties` goes; each is pinned by its own fixture, and
  excluding any one of them was measured green until those existed. A page's
  `/Contents` array is treated as a single stream (32000-1 7.8.2), so a span
  opened in one member and closed in the next is handled whole. An `/OC`
  operand that is an inline dictionary — or a name no `/Properties` entry
  claims — is left exactly as written rather than guessed at, so its content
  survives and the returned report counts it as `unresolved`; the report also
  gives the pages changed, the spans deleted, the wrappers unwrapped and the
  XObjects and annotations removed. One-way, and refused for a signed document
  (`q1g2.6`).
- **Adopting a named optional-content configuration.**
  `/OCProperties /Configs` has always been readable — `GetConfig`, `AddConfig`,
  `RemoveConfig` — but nothing could *choose* one, so a document carrying a
  "Print" or "Review" preset rendered and extracted as `/D` said regardless.
  `oc.ApplyConfiguration(preset)` copies a preset's `/BaseState`, `/ON`,
  `/OFF`, `/Order`, `/Locked`, `/AS`, `/RBGroups`, `/Intent` and `/ListMode`
  into `/D` and leaves the preset in place to be chosen again;
  `oc.SaveConfiguration(name)` snapshots the current `/D` as a preset, which is
  how a caller keeps it, since applying overwrites `/D`. It is a write into
  `/D` rather than an in-memory selection on purpose: `/D` is this library's
  one notion of the current state — the one rendering, extraction, `ApplyUsage`
  and every export read — so a merely selected configuration would be a second
  answer to the same question. Applying **replaces** rather than merges, so a
  preset silent about a key leaves `/D` silent too; merged, the document would
  sit in a state that is neither configuration. A group's own `/Usage` is
  untouched, since that belongs to the group rather than to any configuration —
  applying a preset moves which statements are *applied*, never what a group
  *says* (`q1g2.5`).
- **Layer usage: what a group says about printing, and the `/AS` that makes it
  so.** A layer's `/Usage` dictionary records that it is a watermark not for
  print, or artwork for one zoom band, or a caption in German — and a
  configuration's `/AS` usage application dictionaries are what turn such a
  statement into a state. Neither was read, so "flatten a print copy and the
  do-not-print overlay goes away" could not be expressed at all.
  `config.ResolveForEvent('View' | 'Print' | 'Export', ctx?)` now reports every
  layer's state for an event without touching the document, and
  `config.ApplyUsage(...)` makes those states the configuration's own,
  returning just the layers that moved. `layer.Usage` reads the dictionary and
  `layer.SetUsage(...)` writes it **together with** the `/AS` entry that
  applies it — one without the other says nothing, which is why they are a
  single call. Several categories, and several entries, combine so that any one
  saying OFF wins; a group no matching `/AS` entry names keeps its configured
  state whatever its `/Usage` claims. `/Zoom` and `/Language` describe a viewer
  rather than a document, so they stay silent unless the caller supplies a
  magnification or a BCP 47 tag — being decided against an invented viewer is
  how a whole drawing comes to be switched off — and language matching is RFC
  4647, on whole subtags, so `de` covers `de-AT` and not `den`. `/User` is read
  and written but never evaluated: it names a person or organisation, and this
  library has no viewer identity to match one against. Since `ApplyUsage` moves
  the configuration's own state, every renderer, extractor and export honours
  the result with no further call (`q1g2.4`).
- **`AddRenderFont(bytes)` — a render substitution face supplied as bytes.**
  The companion to `RegisterRenderFontFolder` for a face that has no path to
  point at: one shipped as a bundled asset, unpacked from an archive, or
  fetched. WOFF, WOFF2, `.ttc`/`.otc`, `.dfont` and Type 1 are all accepted,
  and `{ faceIndex }` picks a face of a collection. It **throws** on bytes it
  cannot read, unlike `LoadFontByName`, which answers `undefined` — that one is
  a search, where a machine lacking a face is an ordinary outcome, while a
  caller handing explicit bytes named this font and wants to be told. Rendering
  only, on the same terms as the folder API: never reachable from
  `LoadFontByName`, never embedded in the document, and nothing about
  extraction or editing changes. (`lqcs.5`)

- **Render-time font substitution sources.** `RegisterRenderFontFolder(dir)`
  and `RegisterRenderSystemFonts()` hand the *renderer* font folders, so a font
  the document did not embed draws from an installed face instead of the
  bundled Standard-14 substitute — which for a non-embedded CJK font was a page
  of placeholder boxes, the commonest way an East Asian document reaches this
  library. `RegisterFontFolder` and `LoadFontByName` existed for *authoring*
  and stopped there; nothing reached the rasterizer.

  A face is chosen by `/BaseFont` first — the PostScript name (32000-1 9.6.2.1)
  ahead of the family, since MS Mincho states `MS-Mincho` — and then by how much
  of what the font can emit the face's `cmap` actually covers. `ulUnicodeRange`
  narrows the candidates for free, because `fontnames.ts` already read that
  `OS/2` slice for `usWeightClass`, and the real `cmap` decides: that field is
  the producer's claim about its own font and is routinely optimistic. No
  family-name table ships, so nothing unanchored does — for a composite font the
  wanted set is its own character collection's, already vendored and pinned, so
  a PDF naming SimSun finds PingFang SC without either name being written down.

  Opt-in: with no folder registered the face list is empty, the resolver returns
  on its first line and the bundled path runs as before, so a page looks the
  same on every machine. Rendering only — extraction, editing and PDF/A
  embedding are unchanged, and no substituted program is written into the
  document. `ToSvg` is unaffected by construction, since it emits text with a
  CSS family stack and resolves no glyph program at all. Font programs supplied
  as bytes are not a source yet, and a Type 1 face is reachable by name but
  never by coverage, having no `cmap`. (`lqcs.2`, `lqcs.3`)

- **Overprint preview: `/OP`, `/op` and `/OPM` are honoured when rendering.**
  A print-oriented document — the same kind PDF/X exists for, which this
  library already validates and converts — previewed wrongly: an overprinted
  spot or a magenta plate laid over cyan *replaced* what was under it instead
  of darkening, so a proof looked nothing like the press sheet.

  This is a **preview, not a separation model**, and it says so. A
  plate-accurate answer needs per-colorant buffers; the canvas is RGB, so an
  overprinting paint composites with per-channel minimum. A colorant the paint
  does not lay down has no ink, so its channel is 1 and the minimum preserves
  the backdrop by itself — which is what lets DeviceCMYK, Separation and
  DeviceN share one rule rather than each carrying a plate map. Measured
  against the exact CMYK answer it is right wherever the classic multiply
  approximation is and strictly better where they differ: 50% cyan overprinted
  by 50% cyan gives C=0.5, the correct plate replacement, where multiply
  compounds it to 0.75. Both are wrong only where a paint would *lighten* a
  plate already inked, which RGB cannot represent.

  `/OPM` matters only for DeviceCMYK and DeviceGray, and that asymmetry is the
  point: a Separation or DeviceN space names a subset of the device's
  colorants, so the rest are preserved whatever the mode says, while
  DeviceCMYK names every colorant and under mode 0 writes all of them —
  including the zeros — which is exactly normal painting. Only mode 1 leaves a
  zero-valued component's plate alone. `/OP` is the stroking flag and, for
  backward compatibility, sets the non-stroking one too unless `/op` overrides
  it. DeviceRGB and the CIE-based spaces are unaffected, per §11.7.4.2, and an
  explicit `/BM` wins over overprint rather than being silently replaced —
  a document that asked for Multiply gets Multiply.

  Fills, strokes, text and image masks overprint. A colour image in a
  subtractive space does not: its samples would need per-plate treatment the
  RGB canvas cannot carry.

  Note that **knockout groups already worked** — `/K true` has been honoured
  since transparency groups landed, and the issue behind this entry was wrong
  to pair the two. (4gtd.7)

- **Rendered pages can come out greyscale or bilevel: `ToImage({ mode })` and
  `ToTiff({ mode })`, with `threshold`.** A rendered page was always RGB, which
  also **stranded a feature already shipped** — `ccittencode.ts` refuses a
  non-bilevel frame rather than thresholding, so
  `ToImage({ format: 'tiff', compression: 'g4' })` could never succeed for a
  rendered page at all. It can now, single-page and multi-page alike, which is
  the CCITT Group 4 interchange archival and fax pipelines actually read.

  `'gray'` is Rec. 601 luminance through `colorrule.ts`'s `luma` — the one
  owner of that rule, already read by `ConvertColors` and by the JPEG
  coefficient-domain greying, so a rendered page and a converted document
  cannot disagree about a colour — and it is reduced from the float canvas
  rather than from its 8-bit form, which is the accurate answer. `'bilevel'` is
  a plain cut at `threshold` (an integer 0..255, default 128), never a dither.

  **What the mode states is the pixels**; how compactly a container encodes them
  is per-format and documented. PNG carries both natively and gained bit depth 1
  for the second; TIFF carries both natively, and only its bilevel form is what
  Group 4 accepts; JPEG carries grey natively as one component and **refuses**
  bilevel, since thresholded pixels through a DCT come back ringing round every
  edge — a plausible-looking file that is not what was asked for. GIF reaches
  both exactly through its palette, a page of flat fills being well under 256
  colours. BMP has no grey form here, so it writes 24-bit with equal channels:
  the right picture in a fatter file.

  Note the two bilevel polarities are **opposite** and that is not a bug: PNG
  greyscale means 0 is black, while a bilevel TIFF declares
  PhotometricInterpretation 0 and carries 1 = black, which is what `decodeCcitt`
  returns and `encodeG4` expects. Identical packing, inverted meaning, so one
  packer takes the polarity as an argument rather than each format keeping its
  own — get it backwards and the file is a perfect negative, which reads as a
  deliberate effect. A non-rgb mode with `background: 'transparent'` is refused
  rather than silently composited, the posture the opaque formats already take.
  An unset mode is `'rgb'` and takes exactly the path it always has. (4gtd.6)

- **Coons and tensor patch meshes render (`ShadingType` 6 and 7), the last
  shading types that painted a flat grey rectangle.** With 4gtd.3 and 4gtd.4
  before it, every shading type ISO 32000-1 defines now draws, and the opaque
  mid-grey degrade is left for a mesh that cannot be read rather than for one
  nobody implemented.

  A patch states its boundary as twelve control points walking a 4×4 tensor
  net's border once, and a flag of 1, 2 or 3 says the patch shares an edge with
  its predecessor — so four of those points and two of its four corner colours
  are absent from the record and come from the neighbour. New `src/meshpatch.ts`
  owns that topology, the conversion of a Coons patch's boundary into the four
  interior control points a tensor patch states outright (so **one** surface
  evaluator serves both types), and the tessellation into the triangles
  `meshtri.ts` already paints — which is what makes a patch mesh and a Gouraud
  mesh share the colour space, the `/Function` rule and the barycentric walk
  rather than each keeping its own.

  How finely a patch subdivides is decided from its control net **in device
  space**, by the standard cubic-Bézier chord bound and by the corner-colour
  spread, and never by evaluating the surface. A quadtree would be adaptive per
  region but leaves T-junctions between cells of different depth — a visible
  hairline crack — where one resolution per patch cannot; between neighbouring
  patches the shared edge lies on the same curve, so the gap is bounded by the
  coarser side's own tolerance and stays sub-pixel. The cell count is bounded by
  the patch's own device size, so a mesh of many small patches costs its pixels
  rather than its patch count.

  A continuation patch with nothing to continue is dropped rather than guessed
  at, and a record that ends early degrades the mesh alone. Note the anchor is
  weaker than this repo prefers and says so: no PDF rasterizer is available to
  check against, so these are a transcription — pushed back on by checking the
  point mapping structurally (the twelve must close the net's border) and the
  interior-point formula against a property it must have (on a regular affine
  lattice a Coons patch is that plane, so the formula must return the lattice's
  own interior points). `ToSvg` is unchanged and still degrades every mesh
  type. (4gtd.5)

- **Function-based shadings render (`ShadingType` 1), and `/BBox` and
  `/Background` are honoured for every shading type.** A type 1 shading
  degraded to a flat mid-grey fill of the clip region — worse than drawing
  nothing, since it is opaque and covers whatever sits behind it. Each device
  pixel now travels back through the CTM and the inverse of the shading's
  `/Matrix` into the function's own domain, and the function is evaluated
  there. Nothing new was needed to evaluate it: `parseFunction` already took
  two inputs, for both sampled (type 0) and PostScript calculator (type 4)
  functions, and already handled an array of *n* one-output functions.

  There is deliberately **no lookup table**. Types 2 and 3 index a 257-entry
  LUT because an axial or radial shading has one parameter; a two-dimensional
  domain has none, so the function runs per pixel. Measured at ~1.5 µs per
  pixel against a type 4 program — roughly 15× the LUT-indexed axial path — so
  a full-page type 1 at 150 dpi costs a few seconds. That is recorded rather
  than bought off with a 2-D table, which would blur exactly the field the
  shading exists to state.

  `/BBox` and `/Background` are **common** shading entries (ISO 32000-1
  Table 78) that no type honoured before, so both landed once in the shared
  per-pixel walk rather than as a rule belonging to type 1 — one owner, and
  a latent gap in the axial and radial paths closed with it. Outside the
  `/BBox` nothing paints at all; inside it, a point the shading does not cover
  takes the `/Background`, but **only** where the shading is a pattern fill,
  since §8.7.4.3 ignores that entry under the `sh` operator. A mesh gets the
  `/BBox` as a conservative device-space bound, being painted from its
  triangles rather than through that walk.

  A malformed type 1 — no `/Function`, which the type requires, or a singular
  `/Matrix` — still degrades to mid-grey. That matters beyond its own
  appearance: a singular matrix cannot be inverted, and letting the throw out
  would cost every operator drawn after it on the page. `ToSvg` is unchanged
  and still degrades a type 1, since no SVG gradient element can express a
  two-dimensional function field. (4gtd.3)

- **Text clipping modes 4-7 are honoured, so artwork clipped to display type
  no longer paints unclipped.** `4gtd.1` landed the text rendering mode's
  painting half and deliberately left the clipping half undone, so a `4 Tr`
  heading with an image or gradient drawn through it came out as a solid
  rectangle where the word should have been. The glyphs shown in a clipping
  mode now accumulate across **every** show operator in the text object, and
  their union becomes a clip at `ET`, restored by `Q` like any other. Mode 7
  clips without painting; 4-6 paint and clip. Where a sink cannot outline the
  glyphs — a font that will not parse, or one drawn as placeholder boxes — the
  clip is left **unchanged** rather than emptied: more shows than the document
  asked for, where the alternative makes the content that follows vanish. That
  is a deliberate divergence from a literal reading of ISO 32000-1, which would
  intersect an empty outline set and clip everything away. (4gtd.2)

- **Gouraud mesh shadings render (`ShadingType` 4 and 5).** Both degraded to a
  flat mid-grey fill of the clip region, which is worse than most rendering
  faults because it is opaque and covers what is behind it — a chart or a map
  export came out as a grey rectangle. `page.ToImage` now paints them: free-form
  triangles from the per-vertex edge flag, lattice-form from `/VerticesPerRow`,
  with the vertex colours interpolated barycentrically. A mesh carrying a
  `/Function` interpolates the parametric value across each triangle and
  evaluates **after**, through the same 257-entry LUT the axial and radial paths
  use — evaluating at the vertices and interpolating the resulting colours is a
  different answer for any non-linear function, and a plausible-looking one.
  Triangles are walked over their own bounding boxes rather than the whole clip
  region, so cost follows the mesh's area rather than the page's. A mesh that
  cannot be read still degrades to mid-grey, so damage costs its own appearance
  and never the page. `ToSvg` is unchanged and still degrades every mesh type;
  Coons and tensor patches (types 6 and 7) are unchanged in both. (4gtd.4)

- **XFA forms convert to real AcroForm fields.** `doc.ConvertXfaToAcroForm()`
  decodes `/AcroForm /XFA` — a single-stream XDP or the alternating name/stream
  array — models the `template` packet's field set, binds values out of
  `datasets`, and emits an `/AcroForm` field tree, so a form that only Acrobat
  could fill becomes one this library, and every other viewer, can read, fill,
  flatten, redact and export. `/XFA` and the catalog's `/NeedsRendering` are
  removed once something has converted, unless `{ removeXfa: false }`.

  The issue this closes was filed as decline-or-build, and its own framing —
  read plus flatten, minus the dynamic layout engine — is close to an empty set:
  a static or hybrid form already carries a complete AcroForm this library read
  before today, so there is nothing to flatten, while a dynamic form carries no
  field geometry anywhere, so there is nothing to flatten *to*. What makes the
  feature worth having is that **XFA geometry is not all-or-nothing**. A
  `<subform layout="position">` states absolute `x`/`y`/`w`/`h` on its children,
  so static and XFAF forms have their rects in the template: those fields become
  **real widgets with appearance streams**. Only the flow layouts need the engine
  that is out of scope, and a field under one becomes a **geometry-less field
  dict** — `doc.Form` finds it, fills it and `ExportFdf` exports it, and nothing
  draws it. No rect is ever approximated: a field drawn in the wrong place looks
  right and is wrong, so every geometry refusal is reported instead — a `px` or
  `pc` measurement (whose readings are not transcribed from the XFA
  specification here), a `rotate`, a `<pageArea>` whose declared `<medium>`
  disagrees with its page's CropBox by more than 1pt, a `pageArea` count that
  disagrees with the document's page count. `report.dataOnly` says the document
  converted to data and renders nothing at all, which is what a **dynamic** XFA
  form does: its fields become addressable, and the pages its layout engine
  would have built do not appear.

  A **hybrid** document reconciles rather than duplicating. The synthesized name
  is the SOM expression with occurrence indices, which is exactly what LiveCycle
  writes into the AcroForm half — so an existing field has its `/V` updated and
  its geometry left alone, and an FDF exported from a converted document stays
  interchangeable with Acrobat's. Values come from `datasets` and the template's
  own `<value>` becomes `/DV`, because conflating them destroys the difference
  between what a form was authored with and what someone entered, which for a
  filled archived form is the entire content.

  Conversion is **one-way** — nothing is written back into the XFA packets — and
  `<signature>`, `<imageEdit>` and `<barcode>` fields are refused and reported
  rather than synthesized. It throws `UnsupportedFeatureError` on a signed
  document, since `docmdp.ts` permits `/AcroForm /Fields` to change for *filling*
  and adding two hundred fields is not filling. `ConvertToPdfA` still drops
  `/XFA`, so the useful order is `ConvertXfaToAcroForm` **then** `ConvertToPdfA`:
  the fields survive as a real AcroForm and PDF/A's prohibition is satisfied for
  free, where the other order deletes them.

  **What was measured.** The oracle is the hybrid form itself: a static XFA
  document carries two independent descriptions of one field set — the template,
  and the `/AcroForm` LiveCycle generated from it — so the suite strips
  `/AcroForm /Fields` in a copy of IRS f1040, converts from the template alone,
  and compares against what Adobe wrote. All 199 names reproduce exactly, and so
  do **all 151 placed rects** — worst 0.0006pt, which is floating-point residue
  from the mm-to-pt conversions and nothing else.

  That comparison **found three rules the design had missed**, which is the whole
  reason to have one. First, an XFA field's box includes its label, and the
  widget covers only the edit region — the box minus the `<caption>` reserve;
  worst rect error across 151 fields was 229pt before that fix and 12pt after.
  Second, the point-or-two still left is the field's own `<margin>` insets, and
  a sweep of all 54 distinct text-field declaration shapes in that form shows
  the width error was exactly `leftInset + rightInset` and the height error
  exactly `topInset + bottomInset`, with no exception — worst error 12pt → 6.4pt
  and exact matches 53 → 105. The `<border>` turns out to contribute nothing at
  all, which reverses the guess that residue had been filed under. Third, a
  `<checkButton size>` states the button's own box rather than the field's, so
  the widget is the button: every one of Adobe's 54 button rects across both
  forms is exactly 8×8 where the reduced field box is commonly 12×12, and a
  converted checkbox had been drawn half again too large. Its placement default
  turned out to be two defaults — a caption on the right puts the button flush
  left, a caption on the left or none at all puts it flush right — and what
  settled that was fw9, a form the library declines to place at all but whose
  own `/AcroForm` still holds Adobe's rects. The oracle also confirmed the one
  judgement call the implementation adds, that a field's layout chain starts
  below the subform carrying the `<pageSet>`: f1040's root subform is
  `layout="tb"`, so the other reading would have placed nothing at all.

  The ceiling is worth stating: one producer's output is evidence for the forms
  it covers, not conformance. No second XFA implementation arbitrates any of
  this. (`6t2v.3`, `mw1m`, `17vo`)

- **An image among words in Markdown is now DRAWN, not described.**
  `AddMarkdown` rendered only a *lone* image — one alone in its paragraph, the
  figure shape — and flattened every other one to its alt text with an
  `image:<destination>` entry in `skipped`. So `see ![a cat](cat.png) here`
  came out as the words `see a cat here`: a page that looks deliberate and is
  quietly missing its picture. It now becomes a box on the line, placed by the
  same engine an inline `<img>` already used, in a paragraph and in a heading
  alike.

  **Sizing is 0.75pt per intrinsic pixel** — the 96-dpi convention a browser
  uses — so `![a](x)` and the `<img src=x>` that `AddHtml` renders come out the
  same size, and an image wider than the column is clamped to it with its
  aspect kept. The lone-image figure path is deliberately unchanged and still
  fills the column width, which is what every Markdown figure has always drawn
  at.

  **What still falls back to alt text, and still reports:** an image whose
  bytes cannot be had or decoded, which is the standing rule that visible
  content beats a silently dropped subtree. `data:` URIs are decoded without
  help and anything else comes through the existing `resolveImage` option,
  asked exactly once per image. (z77w)

- **…and inside a list item, so `- ![badge](x) text` draws too.** A list item
  is the one body that both paginates and carries a marker, so it took two
  rules a paragraph does not need. A continuation is handed the atomics
  *re-based* onto the sliced run list, never the originals — carry those
  forward and the picture vanishes at the column break rather than moving.
  And an item that is *nothing but* an image has an empty run list, so
  emptiness is "no text **and** no atomics": read it as "no text" alone and
  such an item gets no `/LI`, no `/LBody` and no bullet.

  Note a lone image in an item is **not** lifted to a block figure the way a
  top-level paragraph's is — a figure fills the column width, which inside a
  list item would tower over the marker beside it — so it draws at its natural
  size on the item's line. An image in one of the item's *further* blocks was
  already a figure and is unchanged.

  `FlowListItem.atomics` is public, so a hand-built flow can place one without
  going through Markdown. (092q)

- **…and inside a GFM table cell, which completes the set.** Every Markdown
  construct that can hold inline text can now hold an inline image. The row
  grows to fit the picture, because a cell's height has long been the sum of
  its line bands rather than a line count times a leading — the doc comment
  that said otherwise was stale, and correcting it turned a proposed rewrite
  of the table height model into plumbing. Column auto-fit sees the picture's
  width too, so a wide image widens its column instead of being silently
  scaled down to fit a column measured on text alone.

  `CellOptions.atomics` is public and is **distinct from `cell.setImage`**:
  that is one picture aspect-fit to the whole cell box and painted under the
  text, while these sit *in* the text, on its lines, and there may be several.
  A cell may carry both. (dsw8)

- **`saveImagesFile` — every embedded image, straight to disk.** `ImageInfo.Save`
  hands back `{ bytes, mediaType }`, and turning that into files was a loop the
  caller had to assemble — read the media type, map it through
  `imageExtension`, build the name, write the bytes — where getting the
  extension step wrong yields a `.png` holding JPEG bytes, a file no viewer
  opens. That is exactly the mistake the media type exists to prevent, so it is
  now prevented once: `saveImagesFile(inputPath, outDir, options?)` writes
  `img-1`, `img-2`, … in document order with the extension always taken from
  the encoder's media type and never from the source image. Encoding is
  `ImageInfo.Save`'s, so the default is faithful and an unmasked `DCTDecode`
  comes out byte for byte with no generation loss.
  **One file per distinct picture**, identity being a hash of the encoded bytes,
  so a logo drawn on forty pages — or a merged document carrying forty copies of
  it — is written once. A picture that will not encode costs itself and not the
  run: it lands in `skipped` with its page, resource key and reason while its
  neighbours are still written, which is why this returns
  `{ written, skipped }` rather than the bare `string[]` its neighbours in
  `node.ts` return — a plain path list would silently lose three pictures out of
  two hundred. A document with no images returns two empty arrays rather than
  throwing. Inline `BI … EI` images are out of reach and documented as such:
  they occupy no `/XObject` entry, so `page.Images` structurally never sees one.
  (72nc.8)

- **`doc.PageMode` and `doc.PageLayout` — how a document asks to be opened.**
  Both catalog entries (32000-1 Table 28) were absent: `/PageMode` says which
  of a viewer's panels is open — and its `FullScreen` value is what makes a
  viewer PRESENT a document rather than show it as a page in a window, without
  which the `page.Transition` and `page.Duration` shipped in 72nc.4 describe a
  slide deck nothing plays. `/PageLayout` says how pages are arranged, its
  `...Left`/`...Right` pairs differing in which side the first page falls on,
  which is what puts a cover opposite the right-hand first page of a book.
  Property pairs on `Document`, reporting only what the file STATES — absent
  reads `undefined` rather than the `UseNone`/`SinglePage` default, so a
  producer's silence stays distinguishable from its choice — read leniently, and
  validated before anything is written so a rejected assignment leaves the
  document byte-identical. Assign `null` to remove an entry; removing one the
  catalog has not got touches nothing, which matters because marking a document
  modified turns a later sign-on-save from an incremental append into a full
  rewrite. The page-mode vocabulary now has one owner: `NonFullScreenPageMode`
  is an `Exclude` over `PageMode` rather than the same four names written out
  twice. (72nc.7)

- **`page.Artifacts` — the read side of a vocabulary we only wrote.** An
  `/Artifact` marked-content scope is decoration a screen reader skips, and
  this library has always been able to *write* one — `PageGraphics.BeginArtifact`,
  the `artifact: true` option on every vector producer, `AutoTag`'s undescribed
  images — with no way to ask what a page declares. Each entry reports the
  property list (32000-1 14.8.2.2: `/Type`, `/Subtype`, `/Attached`, `/BBox`,
  plus the raw dict for keys the model does not name) and where the scope sits,
  as the `ContentAddr` the rest of the content API addresses ops by. Nested
  scopes are one entry each, the inner naming the outer as its `parent`, and the
  walk descends into Form XObjects.
  A declared `/BBox` is reported verbatim; absent one — which is the common
  case, since the whole property list is optional and a bare `/Artifact BMC` is
  what this library and most producers write — the entry carries the measured
  extent of the ink the scope encloses instead, with `bboxSource` saying which
  of the two it is. Measured through `visitContent`, so a glyph, image and path
  extent is text.ts's answer rather than a second one: `GetPaths`, `GetText` and
  this agree by construction. Read-only. (72nc.6)

- **`ImageInfo.Save` — an embedded image as a file, not just as samples.**
  `page.Images` exposed `Decode()` and `RawData`, so a caller could get pixels
  but not something writable to disk: turning either into a file meant knowing
  which codec the image used and re-implementing the PNG wrapping the exports
  already do. `img.Save()` returns `{ bytes, mediaType }`, and the media type is
  the point — it is what says whether to write `.jpg` or `.png`, and
  `imageExtension(mediaType)` is now exported for it. With no `format` the
  encoding is *faithful*: an unmasked `DCTDecode` hands back its embedded bytes
  verbatim, with no re-encode and no generation loss, and anything else becomes
  a PNG carrying alpha. `{ format: 'png' | 'jpeg' }` forces one — a forced
  format the faithful encoding already satisfies changes nothing — with
  `'jpeg'` compositing transparency onto white, since naming an opaque format is
  the request to flatten. It is the encoder five exports already share, so an
  extracted image is the same picture the HTML, Markdown and DOCX exports embed
  (`72nc.5`).

- **Page transitions and page duration — `/Trans` and `/Dur`.**
  `page.Transition` reads and writes 32000-1 Table 165 in full (the twelve
  styles, the effect `duration`, `dimension`, `motion`, `direction`, Fly's
  `scale` and `opaque`), and `page.Duration` the `/Dur` beside it — how long the
  page is shown before advancing. Neither key had an accessor, so a PDF meant to
  be presented could not be authored at all. Assigning replaces the dictionary
  wholly rather than merging, because a transition is a unit — a style plus that
  style's parameters — and merging would leave a stale `scale`, or a
  Glitter-only `315`, beside a newly-set style; `null` deletes. Reading is
  lenient (an entry of the wrong type or outside its enumeration reads as
  absent) while writing refuses a value the stated style does not admit, `315`
  off Glitter and `'None'` off Fly being values no viewer honours. Note the two
  durations are different clocks: `Transition.duration` is `/D`, how long the
  *effect* runs. Presenting still needs the catalog's `/PageMode /FullScreen`,
  which remains unmodelled (`72nc.4`).

- **The whole `/ViewerPreferences` dictionary, not just one flag of it.**
  `doc.GetViewerPreferences()` and `doc.SetViewerPreferences(update)` read and
  merge all 17 entries of 32000-1 Table 150 — the window and chrome flags,
  `NonFullScreenPageMode`, `Direction`, the view/print area and clip boxes,
  `PrintScaling`, `Duplex`, `PickTrayByPDFSize`, `NumCopies` and
  `PrintPageRange`. Only `/DisplayDocTitle` was reachable before, and only
  because PDF/UA needs it; everything a producer says about how a document
  should *open and print* had no accessor at all.

  The getter reports **only what the document states** — an entry it does not
  carry is `undefined` rather than the spec default — so a stated `false` stays
  distinguishable from silence, which is what lets a caller tell a producer's
  decision from its omission. Values are read leniently: one of the wrong type,
  or a name outside its enumeration, reads as `undefined` rather than throwing.
  The setter is the other half of that and merges narrowly, touching only the
  keys the update names, so an entry this library does not model — PDF 2.0's
  `/Enforce`, say — survives a read-modify-write instead of being silently
  stripped. `undefined` leaves an entry, `null` deletes it, a value sets it;
  the dictionary is created on the first write and removed when its last entry
  goes, since an empty `<< >>` gives a document that "has viewer preferences"
  and does not.

  `/PrintPageRange` is modelled as inclusive 1-based `[first, last]` pairs
  rather than the flat array on the wire, because an odd-length or descending
  flat array is exactly the mistake that produces a plausible wrong print job
  rather than an error. Writing range-checks each pair against the page count;
  reading reports whatever the producer wrote, since a document split out of a
  longer one legitimately carries a range past its own end. A bad value throws
  `TypeError` (wrong kind of thing) or `RangeError` (outside the permitted set)
  before anything is written, so a rejected call leaves the document
  byte-identical. `doc.DisplayDocTitle` keeps its signature and becomes a
  shorthand over the new writer, which is now the single owner of the
  dictionary — the ensure-the-dict dance had been hand-rolled in three places.
  (72nc.3)

- **PDF/A-4 conversion.** `doc.ConvertToPdfA('4' | '4e' | '4f')` remediates
  toward ISO 19005-4:2020 instead of throwing `UnsupportedFeatureError`. Part
  4's rules are not a superset of parts 1–3, so conversion runs in both
  directions: it *stops* removing JavaScript actions (and their `/Names`
  tree) and embedded files, and *starts* raising the catalog `/Version` to
  2.0 — an exact major there rather than a ceiling — writing
  `pdfaid:rev="2020"` with the conformance **absent** at the base level,
  clearing the ToggleNoView annotation flag, adding `/UF`,
  `/AFRelationship` and a `/Subtype` MIME type to embedded files, and
  removing `/NeedsRendering`, `/Requirements`, `/AlternatePresentations`,
  page `/PresSteps`, non-`/DocMDP` `/Perms` keys, ExtGState `/TR` and
  `/HTO` (forcing `/TR2` to `/Default`), `/HalftoneName`, image
  `/Alternates` and `/OPI`, Form XObject `/OPI`, `/DestOutputProfileRef`,
  surplus PDF/A output intents, appearance keys other than `/N`, and a
  Widget's `/A`. PDF/A-4e keeps 3D and RichMedia annotations and the
  SetOCGState and GoTo3DView actions, which is most of what makes it the
  engineering level.

  The casualty is the document information dictionary. PDF/A-4 permits
  `/Info` only alongside a catalog `/PieceInfo` and then only holding
  `/ModDate`, so essentially every real document loses it: conversion
  mirrors its title, author, subject, keywords **and** `/ModDate` into XMP
  first, then reduces the dictionary to `/ModDate` beside a `/PieceInfo` or
  removes it without one. The two branches are not a preference — a
  reduce-only pass can never pass validation for a document that has no
  `/PieceInfo`. `preserve: ['info']` keeps the dictionary and reports
  `InfoRestriction` unresolved instead. A PDF/A-4f file with no attachment
  reports `EmbeddedFilesRequired`, which conversion cannot synthesize, and a
  bad `/BitsPerComponent`, a prohibited halftone type and a `/ToUnicode`
  CMap with prohibited code points are reported rather than fixed —
  re-encoding an image, changing how a page prints, and destroying text
  extraction are all worse than saying so. `XmpMetadata.pdfaRev` is the one
  public type addition. Verified against this library's own PDF/A-4
  validator, itself a transcription of veraPDF's profiles: the two halves
  now agree by construction, which is not evidence that a certified
  validator would. (72nc.2)

- **PDF/A-4 validation.** `doc.ValidatePdfA('4' | '4e' | '4f')` checks the
  ISO 19005-4:2020 rule set. PDF/A-4 is a PDF 2.0-era standard whose rules are
  **not** a superset of parts 1–3: four checks this library makes at `'2u'` go
  *silent* at `'4'`, so a document can fail the older level and pass the newer
  one for the same reason. `/ToUnicode` is no longer required to be present
  (only constrained if it exists), `/CIDSet` has no rule at all, JavaScript
  actions are permitted, and `/Info` is near-banned — allowed only alongside a
  catalog `/PieceInfo` and then holding nothing but `/ModDate`, which supersedes
  the `/Info`-versus-XMP consistency check. New checks cover PDF 2.0 versioning,
  `pdfaid:rev`, the conformance-by-absence identification, `/Perms`,
  `/NeedsRendering`, `/Requirements`, alternate presentations, ExtGState `/TR`
  and `/HTO`, halftone types, image keys and bit depths, `/OPI`, output-intent
  keys, the transparency blending colour space, appearance keys, widget actions,
  optional-content configurations and embedded-file specifications. `'4e'`
  permits 3D and RichMedia annotations plus the `SetOCGState` and `GoTo3DView`
  actions; `'4f'` permits arbitrary embedded files and is the one conformance
  that *requires* the document to carry some. Clause 6.9-3 — embedded files must
  themselves be PDF/A — is reported as a warning rather than checked, since this
  validator does not recursively validate embedded documents. The rules are
  transcribed from veraPDF's published validation profiles and there is no
  runnable oracle here, so a passing report attests agreement with that
  transcription rather than certified ISO 19005-4 conformance. Conversion to
  part 4 is not yet supported: `ConvertToPdfA('4')` throws
  `UnsupportedFeatureError` rather than running part-2-shaped remediation, which
  would write a `pdfaid:conformance` PDF/A-4 forbids. (72nc.1)

- **`iccCmykTransform(profile)` converts RGB to CMYK through a real ICC
  destination profile.** `85l8.3` added the seam; this fills it. Pass it to
  `ConvertColors` and the conversion is genuinely colour managed:

  ```ts
  import { iccCmykTransform } from '@asposefoss/pdf';
  doc.ConvertColors({ to: 'cmyk', transform: iccCmykTransform(profileBytes) });
  ```

  The difference is not marginal. Through U.S. Web Coated (SWOP), a mid grey
  is C 24.8 M 20.9 Y 19.6 **K 35.8** — all four channels — where the bundled
  naive transform gives C 0 M 0 Y 0 K 21.6, and its idea of green sits 36
  points of cyan away from the profile's. It reaches image samples, shading
  functions and mesh vertices as well as content operators, so a converted
  document has no naive ink left anywhere.

  **Scope, and each limit is a decline rather than a guess.** ICC **v2 CMYK
  output profiles with a Lab connection space** — what press profiles are —
  reading the `B2A` tag for the intent you name: `B2A0` perceptual (default),
  `B2A1` media-relative, `B2A2` saturation. A **v4** profile is refused rather
  than mis-read, its `B2A` being an `mBA ` with a different element order;
  so are absolute colorimetric (which has no `B2A` of its own), a non-CMYK
  device space, and a profile carrying no `B2A`. Every refusal happens before
  any colour converts, so a rejected profile leaves the document
  byte-identical. Black point compensation is not applied.

  **CLUT interpolation is tetrahedral**, which is what a reference CMS does —
  measured against Windows Color System rather than assumed, and matching
  littlecms and Adobe's CMM. This started out trilinear, on the reasoning that
  its arithmetic reads straight off the spec; no spec text settles the method,
  and through a purpose-built curved profile the trilinear walk missed WCS by
  four percentage points of ink where tetrahedral tracks it to under one. The
  gap falls as the square of the CLUT cell size, so on a real profile — grid
  17, where ours is grid 3 — it is nearer a tenth of a percent; the reason to
  do it this way is agreement with the reference, not the magnitude. (85l8.7,
  m3gs)

  Without a `transform` the default is unchanged and still naive, byte for
  byte. (85l8.7)

### Added

- **A reported inline image now says which one it was.** `ColorSkipped` gains
  `opIndex`, the index of the `BI` operator within the stream `objNum` names,
  present for `what: 'inline-image'` and absent for every other kind — those
  address an object rather than an op inside one. A stream may draw several
  inline images, so the object number alone could not say which was left in
  colour; together the two are exact, and resolve with
  `parseContentStream(inflateStream(obj))[opIndex]`.

  An op index rather than the `ContentAddr` that `inlineimage.ts` already
  defines, and that is structural rather than a shortcut. A `ContentAddr` path
  is an **XObject** chain, but the colour walk also visits tiling patterns,
  Type 3 `/CharProcs` and ExtGState `/SMask /G` groups — any of which may hold
  a `BI`, none of which such a path can name. A `ContentAddr` is also
  page-relative, while the walk dedupes scopes by object number so that a form
  reached from two pages is rewritten once; that form has no single page to
  name. An object number plus an op index has neither problem and is uniform
  across all five scope kinds. (85l8.6)

### Added

- **`ConvertColors({ to: 'cmyk', transform })` takes the RGB→CMYK leg from the
  caller.** The bundled `rgbToCmyk` is naive maximum-black removal with no
  destination profile, so its numbers are structurally CMYK and not
  colorimetrically correct — which is why PDF/X remediation makes that rewrite
  opt-in, and why the CMYK target has carried a warning since it shipped. A
  caller who *is* colour managed, who has the profile and a CMS to apply it,
  can now hand the right numbers in:

  ```ts
  doc.ConvertColors({ to: 'cmyk', transform: (r, g, b) => cms(r, g, b) });
  ```

  It replaces that leg alone and never the pivot, so every source space still
  reaches RGB by the same route and a transform sees the same triple whatever
  the document declared. It reaches **image samples, shading functions and mesh
  vertices** as well as content operators and annotation colours — a transform
  that stopped at the operators would leave naive ink in every picture, which
  is the defect a colour-managed caller is trying to avoid. `report.cmykTransform`
  is `'naive'` or `'supplied'`, absent for a target with no cmyk leg, so an
  archived report answers "was this file colour managed?".

  The transform is validated **once, up front** — probed at four corners for a
  return of four finite numbers — so a rejected call leaves the document
  byte-identical, and every later result is clamped to 0..1 with a non-finite
  component becoming 0, because a `NaN` reaching a content stream is a corrupt
  file rather than a wrong colour. Passing it with `to: 'gray'` or `'rgb'`
  throws `RangeError` rather than being silently ignored.

  **This does not make the library colour managed.** With no `transform` the
  output is exactly as naive as before, byte for byte. Note also that declaring
  *which* output condition the numbers are for is a separate job: an
  `/OutputIntent` is a standards claim, and `ConvertToPdfX` already owns it.
  (85l8.3)

### Fixed

- **A non-embedded composite font draws real glyphs instead of empty boxes.**
  The substitute-face path was guarded by `!isType0`, so a Type0 font with no
  embedded program reached the outline stage with nothing to draw from and every
  glyph fell back to the placeholder box — a page of hairline rectangles where
  its text belonged, which is the everyday shape for Latin text a producer set
  in a composite font. Such a font now gets the same bundled Standard-14
  substitute a simple font gets, selected by the character the CID stands for:
  `/ToUnicode` first, then the bundled Adobe collection table, then the
  substitute's own cmap. **Advances are untouched** — they stay the document's
  `/W` and `/DW` — so this changes which glyph is drawn and never where it sits.
  A substituted composite font selects strictly by Unicode: falling back to the
  CID would draw a confident wrong glyph, since a CID is not a character code.
  With only the Standard-14 faces bundled the substitute covers Latin, so a
  non-embedded CJK font still shows boxes until real face substitution lands.
  (lqcs.1)

- **An `/OC` on an XObject or an annotation is honoured too — including the
  ones this library writes itself.** A layer marks content a page's own stream
  shows; an `/OC` on an image or form XObject, or on an annotation dictionary,
  is the other half of the vocabulary, and it is the half four public APIs
  already wrote: `Annotation.Layer`, `AddImage({ layer })`,
  `AddBarcode({ layer })` and `ImageInfo.Replace`'s `/OC` carry-over. So
  `page.AddImage({ layer })` followed by hiding that layer produced a document
  whose own renderer painted the image anyway. Both halves now resolve through
  the same configuration, and membership through an `/OCMD` counts as
  membership. **Two consequences worth knowing:** the annotation check lives in
  the predicate that decides what a static render draws, so
  `FlattenAnnotations` no longer bakes a hidden-layer annotation's ink into
  permanent page content, and `SearchAnnotations` no longer finds its drawn
  text — both were ways for hidden content to escape. `SearchAnnotationText`,
  which reports what the file *carries* rather than what it draws, still reads
  every annotation, as redaction depends on. (q1g2.2)

- **A hidden layer no longer renders.** The visibility resolver behind
  `doc.OptionalContent` was already written and already correct — OCMD
  policies, `/VE` expressions and all — and nothing consumed it: the
  content-stream interpreter had no `BDC`/`BMC`/`EMC` case whatever, so a
  switched-off watermark, a "do not print" overlay and a disabled CAD layer
  were all painted by `ToImage`, `ToSvg` and both fixed-layout backdrops. A
  marked-content stack now tracks optional content and suppresses the marks of
  a section the default configuration hides, so a rendered page shows what a
  viewer shows — pixel for pixel what the same page renders as after
  `RemoveLayer` excises the layer outright. **Content inside a hidden section
  still runs**: graphics state, transforms and clips apply exactly as in a
  viewer, and only the painting is suppressed, so a clip set inside a hidden
  section still clips what follows it. An `/OC` operand that is an inline
  dictionary rather than a name in `/Properties` is left visible rather than
  guessed at. Text and path EXTRACTION are unchanged and still report hidden
  content; that is tracked separately. (q1g2.1)

- **The text rendering mode (`Tr`) is honoured, so an OCR layer no longer
  prints over the scan it describes.** The content-stream interpreter had no
  `Tr` case at all and filled every run, and mode 3 — invisible — is what every
  OCR tool writes over a scanned page: `ToImage`, `ToSvg`, fixed-mode
  `ToHtml` and the DOCX textbox backdrop all painted a black transcription on
  top of the image, and the same defect hid any producer's deliberately
  invisible text. All of ISO 32000-1 Table 106's painting behaviour now
  applies: 0 fills, 1 strokes, 2 fills then strokes, 3 paints nothing, and
  4–6 paint as 0–2 do. Stroking is real geometry in `ToImage` (the glyph
  outlines are outlined through the same join and cap code a stroked path
  uses, at a half-width scaled by the CTM alone — a line width is user-space
  and must not scale with the font size) and native `fill`/`stroke` attributes
  in `ToSvg`; fixed-mode `ToHtml` suppresses a non-painting run like the
  others but still fills a stroking one, CSS having no portable glyph stroke.
  The mode is graphics state (9.3.1), so it follows `q`/`Q` and survives `BT`,
  which initialises the text matrices and nothing else. **Extraction is
  deliberately unchanged** — an invisible run is exactly what an OCR layer is
  for, and `GetText` still returns it. The clipping half of modes 4–7 remains
  unimplemented and is tracked separately. (4gtd.1)

- **Nine structural checks now report at PDF/A parts 1–3, not only part 4.**
  `72nc.1` landed them gated at part 4, so a document violating ExtGState
  `/TR`/`/TR2`, image `/Alternates`/`/OPI`/`BitsPerComponent`, Form XObject
  `/OPI`, an appearance dictionary holding more than `/N`, a Widget action, a
  halftone, `/NeedsRendering`, a transparency blending space or
  `/DestOutputProfileRef` was reported at `'4'` and passed at `'2b'` — the
  validator was quietly more lenient about the older, stricter parts. Each rule
  now applies at exactly the parts veraPDF's PDFA-1B/2B/3B profiles carry it,
  and cites that standard's own clause number rather than ISO 19005-4's. Three
  divergences are real and are not smoothed over: a 16-bit image is legal at
  parts 2/3/4 and **illegal at part 1** (PDF 1.4 had none), so a document that
  converts clean to `'2b'` can fail `'1b'`; `/DestOutputProfileRef` is exempt on
  a `GTS_PDFX` output intent at parts 2/3 but not at part 4; and a Widget's
  `/AA` is prohibited at parts 1–3 while ISO 19005-4 6.6.3-1 explicitly exempts
  it. `ConvertToPdfA` repairs the same set at the same parts, so conversions
  that reported clean keep doing so — except for a prohibited halftone type and
  a bad `BitsPerComponent`, which are reported rather than repaired because
  fixing them would change how a page prints or need the image re-encoded.
  Stripping a Widget's `/A` and `/AA` deletes real form behaviour (a push
  button's action, a field's keystroke and format scripts), so it is opt-out
  through the new `preserve: ['formActions']` category. (pjy7)

- **PDF/A-1 no longer reports transparency for an ExtGState that has no
  `/SMask`.** `ctx.R(dict.get('SMask'))` returns `null` for an absent key and
  `null !== undefined`, so every part-1 ExtGState was reported as carrying a
  soft mask — the exact trap this file already records for PDF/X. It had never
  fired because no part-1 test fixture carried an ExtGState at all until the
  backport above gave one to part 1, which is how a validator can hold a
  false positive nobody meets. A real `/ca` below 1 and a non-standard blend
  mode still report, since PDF/A-1 does prohibit those. (pjy7)

- **An empty XMP identification attribute no longer reads back as an absent
  one.** `pdfaid:part`, `pdfaid:conformance`, `pdfaid:rev`, `pdfuaid:part` and
  `pdfxid:GTS_PDFXVersion` each matched `["']([^"']+)["']` — one or more — so a
  packet declaring `pdfaid:conformance=""` was indistinguishable from one
  declaring nothing, in `GetXmp` and in both validators. That mattered most
  where absence is itself the declaration: ISO 19005-4 6.7.3-3 spells PDF/A-4's
  base conformance by genuine absence, so such a file passed `ValidatePdfA('4')`
  when it should have been reported. The general `scalar()` helper in the same
  module had always matched `([^"]*)`, so `pdf:Producer=""` already read back as
  `''` — the identification fields were the outliers, and they now follow one
  rule through a shared reader. A present-but-empty **string** field surfaces as
  `''`; a present-but-empty **numeric** field surfaces as `NaN` rather than
  `Number('')`'s `0`, which would read as a document claiming part 0 — junk like
  `part="x"` already yielded `NaN`, so empty and junk get one answer instead of
  two. Genuinely absent stays `undefined`. Found by a mutation during 72nc.2:
  a build writing `conformance=""` reddened nothing. (ugxr)

- **Signing no longer writes a `%PDF-1.7` header over the document's own
  version.** The sign-on-save (full-rewrite) writer hardcoded that header,
  where every other write path emits the catalog `/Version` through
  `headerVersion()`. Signing a document therefore silently overwrote its
  declared version — and the reachable case is the damaging one: `Sign` takes
  the full rewrite whenever the document is modified, and `ConvertToPdfA`
  marks it modified, so convert-then-sign breached the very version rule the
  conversion had just satisfied. A PDF/A-4 file requires PDF 2.n exactly
  (ISO 19005-4 6.1.2-1, not a ceiling) and a PDF/A-1 file forbids anything
  above 1.4, so both directions were wrong. The header sits inside the signed
  byte range, so it is chosen when the placeholder is laid out rather than
  patched afterwards; the incremental path is untouched and still preserves
  its base bytes verbatim, header included, which is asserted from the other
  side. (909q)

- **A colour conversion no longer skips a page whose `/Resources` is inherited
  from the page tree.** `/Resources` is an inheritable page attribute (32000-1
  7.7.3.4) and Ghostscript, Word and others put it on the `/Pages` node, but the
  colour walk read the page's own entry, which does not inherit. With no
  resources in hand the whole pass degraded at once, and the damage was much
  wider than a missed colour: every form XObject, tiling pattern, Type 3 glyph
  procedure and soft-mask group reachable through those resources was **never
  walked**, so a document converted with `ConvertToGrayscale` went on painting
  pure blue; named shadings were never converted; and every `cs` naming a
  resource fell back to DeviceGray. `report.skipped` was `[]` throughout. This
  predates the `{ to }` target — `ConvertToGrayscale` has always behaved this
  way on such a document. (85l8.5)

- **A `cs` naming a colour space that cannot be resolved no longer converts the
  colour from a space nobody established.** With the inheritance fixed this is
  a damaged file rather than an everyday one, but the old fallback to DeviceGray
  was wrong in two different ways at once. Converting to a non-gray target read
  the following `sc`'s operands as a single grey component, so **`1 0 0 sc` —
  red — came out `1 1 1 rg`, pure white**. Converting to gray retargeted the
  `cs` while leaving the `sc` alone, emitting `/DeviceGray cs 1 0 0 sc`: three
  operands in a one-component space, malformed rather than merely wrong. Both
  operators are now left exactly as the document wrote them and the resource
  name is reported in `skipped` under `what: 'content'`.

  This is the one `skipped` entry that means colour **survives** in the output,
  so the postcondition softens accordingly: after the call every colour is the
  target space *except what `skipped` names*. That is the honest trade — a
  reported refusal beats writing white where the document said red. (85l8.5)

### Fixed

- **A colour conversion no longer reports a clean run over content it left in
  colour.** Two constructs declined silently, so `skipped: []` — the field a
  caller reads to answer "did this document fully convert" — was reported for
  documents that provably had not.

  An **inline image** lives in the content stream and in no object, so
  `colorimage.ts` never sees one and every decline it made was invisible: a
  filtered `BI`, a `/Decode` array, a bit depth other than 8, a colour space
  outside the six device spellings, malformed geometry or a truncated payload
  all left the image drawing its original colour with nothing said. Each is now
  a `skipped` entry under the new `what: 'inline-image'`, whose `objNum` is the
  content stream that **drew** it — the only address an inline image has, and
  the form's stream rather than the page's when it is drawn inside one. The
  target check outranks every reason, so an image already in the target space
  still reports nothing however it is coded; without that, every filtered gray
  inline image would report a skip under `to: 'gray'` for work there was none
  of.

  An **annotation colour array** of an illegal width was worse than silent, it
  was wrong. 32000-1 12.5.2 gives `/C`, `/IC`, `/MK /BG` and `/MK /BC` their
  space by the array's length — 1 gray, 3 RGB, 4 CMYK — and any other width
  fell through to the RGB arm, so `/C [0.25 0.5]` was rewritten as RGB with
  blue 0, and an array holding no numbers at all was left in place unreported.
  Both are now reported under the `what: 'annotation'` kind, which was declared
  from the start and emitted by nothing, and the array is left exactly as the
  document wrote it rather than guessed at. An **empty** array is untouched and
  unreported, as before: it is legal and means *no colour*, so a record there
  would fire on every annotation that asked for no border. (85l8.4)

### Changed

- **`ColorSkipped.what` gains `'inline-image'`.** Additive at runtime and
  source-breaking for a caller doing an exhaustive `switch` on it. An inline
  image is not an image XObject — it has no object of its own, so a caller
  cannot address it the way `'image'` promises — and folding it into
  `'content'` would say the stream failed to parse when it parsed fine.
  (85l8.4)

### Added

- **`doc.ConvertColors({ to })` converts a document to one device space —
  `'gray'`, `'rgb'` or `'cmyk'`.** Until now the only document-wide colour
  operation was `ConvertToGrayscale`, and RGB→CMYK existed solely inside PDF/X
  remediation, where it is a side effect of a standards conversion rather than
  something a prepress caller can ask for on its own terms. The same walk now
  takes a target: page content, form XObjects, tiling patterns, Type 3 glyph
  procedures, image XObjects, inline images, shadings and annotations, with
  every existing image route preserved. `ConvertToGrayscale` remains as the
  named shorthand for `{ to: 'gray' }` and is byte-identical to it, which is
  asserted directly rather than assumed.

  Every colour ends up in the target space, DeviceGray content included — a
  grey becomes pure K under `'cmyk'`, which renders identically. That keeps the
  postcondition simple enough to check: after the call, every colour in the
  document *is* the target.

  Two limits worth stating before you reach for it. RGB→CMYK is the same naive
  maximum-black transform PDF/X remediation uses, with **no colour
  management**: without the destination profile there is no way to know what
  ink these values produce, so the output is structurally CMYK and not
  colorimetrically correct. And the coefficient-domain JPEG route is gray-only
  — it works because a YCbCr JPEG's Y channel *is* Rec. 601 luma, and no such
  identity exists for the other targets — so a photographic JPEG converted to
  CMYK re-encodes and sets `lossy` where the same image converted to gray would
  not. An unknown target throws `RangeError` before anything is converted, so a
  rejected call leaves the document byte-identical. (85l8.2)

### Changed

- **BREAKING: the colour-conversion report types are renamed.**
  `GrayscaleOptions` → `ColorConvertOptions`, `GrayscaleReport` →
  `ColorConvertReport`, `GrayImageResult` → `ColorImageResult`, `GraySkipped` →
  `ColorSkipped`, joined by the new `ConvertColorsOptions` and the re-exported
  `TargetSpace`. The old names are **not** kept as aliases: a method called
  `ConvertColors` returning a `GrayscaleReport` reads as a mistake, and
  carrying four deprecated aliases into the first published release to avoid
  that is worse than renaming now. Nothing has been published or tagged yet, so
  this breaks no released consumer — it is marked BREAKING because the names
  are exported from `index.ts` and anyone building against the repo will see
  it. Field names, shapes and values are unchanged; only the type names moved.
  (85l8.2)

### Changed

- **BREAKING: `Save()` now preserves a document's encryption instead of silently writing it in the clear.** Opening an encrypted PDF and saving it produced a **plaintext** file with no `/Encrypt` and no signal — measured, an `/Info /Title` of `SecretTitle` was visible in the output and read back fine, so a caller who opened a confidential document and saved it got an unprotected one. It is now written encrypted again, reusing the original `/Encrypt` dictionary and file key. Reusing them is not an optimization but the only faithful route: the owner password is hashed into `/O` and is unrecoverable, and re-deriving through `EncryptOptions` defaults `ownerPassword ?? userPassword`, which would silently equate them — a permissions downgrade shipped as a confidentiality fix. Pass `Save({ encrypt: false })` for the old behaviour, or `Save({ encrypt })` to re-encrypt with stated credentials. Preserving requires the trailer's `/ID`, which the file key is derived from, and throws `UnsupportedFeatureError` without it. Unencrypted documents are byte-identical. (`0cr3`)

- **BREAKING: `<?…>` is now a processing instruction, not a bogus comment**, and `HtmlNode` has a new `'pi'` member. The HTML Standard gained processing instructions in [whatwg/html#12118](https://github.com/whatwg/html/pull/12118), merged 2026-06-25: `<?target data?>` produces a real `HtmlProcessingInstruction` node, and the tag open state no longer reports `unexpected-question-mark-instead-of-tag-name` at all. `parseHtml` therefore returns a node kind it never produced before, which is additive at runtime and **source-breaking for a caller doing an exhaustive `switch` on `HtmlNode`**. A target must start with an ASCII letter or `_` and continue with alphanumerics, `-` and `_`; `xml` and `xml-stylesheet` are blocklisted so a page cannot smuggle in a stylesheet load, and every refused target still yields the bogus comment it always did — including the leading `?`, so `<?xml version="1.0">` is unchanged. Only `?>` closes, but a bare `>` closes too, matching the old behaviour. Rendering is unaffected: a PI draws nothing, exactly as a comment does, and it is not reported in `skipped` because drawing nothing is correct rather than a failure. (`zch2.9`)

- **BREAKING: `skipped` is now a structured report** on the three `AddHtml` entry points, where it was `string[]`. Each entry is a `NotRendered` record carrying the offending `HtmlElement`, a `construct` from a closed 19-name vocabulary, a `detail` (the src, the property, the declined value) and — the field that did not exist before — a **`kind`**: `dropped` means nothing was drawn, `degraded` means something was but not what the source said. A caller can act on that difference where it could not act on a string. `describeNotRendered(r)` recovers the exact strings the old field carried (`'image:pic.png'`, `'float:left'`), so a caller that only logs needs one function call and no other change. `AddMarkdown`'s `skipped` deliberately stays `string[]`: the useful field is a pointer to an `HtmlElement` and Markdown has `MdNode`, so a shared type would carry a field always `undefined` for half its callers. (`zch2.7`)

### Fixed

- **Signing an encrypted document works instead of being refused, and its /Contents survives a round trip.** Signing was refused because the append could not encrypt what it wrote; now it can. The signature value dictionary's `/Name`, `/Reason`, `/Location` and `/M` are encrypted like any other strings while `/Contents` is left in the clear, as 32000-1 §7.6.2 requires. The exemption is applied in BOTH directions, which uncovered a defect that predates this work: the reader had no exemption either, so it DECRYPTED a signature's `/Contents` and would have corrupted any encrypted signed document from any producer. Either half being wrong is silent and yields an unverifiable signature rather than an error. (`0cr3`)

- **An incremental save of an encrypted document no longer destroys it.** `Save({ incremental: true })` refused encrypted documents because the append had no encryption at all: appended objects were written in the clear, and the appended trailer carried no `/Encrypt`, so a reader took the newest trailer at its word, treated the whole file as unencrypted, and decoded every pre-existing encrypted string to garbage. Appended objects are now encrypted with the document own key under their own number and generation, and the new trailer references the `/Encrypt` object already present in the original bytes. (`0cr3`)

- **An object freed by an incremental update is no longer resurrected on open.** `readXref` recorded only in-use entries and dropped free ones, and its merge is newest-wins by "already present" — so a free entry in an appended revision left the slot empty and the *older* section's offset entry filled it. Any third-party PDF that deleted an object in an update, and every file our own `Save({ incremental: true })` produces that way, came back carrying the dead object in the live model. The symptom was not a corrupt file: `Save()`'s mark-sweep drops the object as unreachable, so what leaked was a false **report**. `objectEntries()` feeds the all-objects scan behind PDF/A and PDF/X validation, so a document whose author had correctly remediated it by deleting a prohibited stream still failed validation for that stream — measured, one `/LZWDecode` violation before freeing and one after, on a file qpdf agrees no longer contains it. Free entries are now recorded as a tombstone that occupies the slot, in both the classic-table and cross-reference-stream readers, and produce no object. One visible consequence: `readXref` now reports object 0, the free-list head every classic table opens with. (`2yvi`)

- **An incremental save after signing in the same session is refused, where it used to destroy the signature or lose the edit.** `Save({ incremental: true })` on a `Document` that had just been signed did one of two silently wrong things depending on how the edit was made: an untracked one (through a live `Dict` handle) returned the signed bytes verbatim and **dropped the edit**, while a tracked one cleared the cached signed bytes and appended onto the **unsigned** original, yielding a file whose signature read back `isSigned: false`. The cause is that `fillSignature` patches bytes and never the model, so the live `/Sig` carries a `/Contents` of length **0** while the signed bytes carry the real CMS — the model is permanently behind from the moment `Sign` returns, and an appended revision computed from it would overwrite the signature with an empty one. It refuses even with no edit at all, for that reason. The supported path is unchanged and now asserted directly: save the signed bytes, reopen them, then edit incrementally. (`msdn.5`)

- **Signing an encrypted document is refused rather than silently corrupting it.** `Sign`, `Certify`, `AddDocumentTimestamp` and `AddValidationData` produced an unreadable file for any document carrying `/Encrypt`, and said nothing. Signing appends an incremental update, and the appended trailer carried no `/Encrypt` at all — so a reader took the newest trailer at its word, treated the whole document as unencrypted, and decoded every pre-existing encrypted string to garbage: measured, an `/Info /Title` of `SecretTitle` read back as `CÞQjþ{}3`. The appended objects were written in the clear besides, so a signer's name and reason leaked from a document whose point was encryption. The two are one missing concept rather than two bugs, which is why the one-line trailer fix was **not** applied on its own: carrying `/Encrypt` forward would only invert the damage, decrypting the plaintext objects instead. A correct append must also encrypt what it writes under the original file key, with the signature `/Contents` exempt, and that is tracked separately. The refusal deliberately covers the full-rewrite path too, not just the append: that path silently drops encryption, so guarding only the append would leave a caller one `SetMetadata` away from a signed, silently unencrypted file. (`x8kx`)

- **An appended cross-reference section now carries each object's real generation, and can mark an object free.** Every appended object was written `N 0 obj` with a generation-0 xref row, though `xref.ts` had parsed the real generation all along — so replacing an object at generation 1 or above produced a revision whose header disagreed with the object it superseded. The generation is now read from the previous cross-reference, which also fixes it for signing, the only caller this path had. Deletions are expressible for the first time: a freed object gets an `f` row whose generation is the one it would take on reuse. An update that changes nothing emits the degenerate `0 0` subsection rather than an `xref` immediately followed by `trailer`, which is malformed. Note our own reader still cannot see a free entry — `readXref` drops them, so a freed object survives `Open` — which is tracked separately as its own defect. (`msdn.2`)

- **Content taller than a column no longer refuses the whole document.** `doc.AddHtml('<img src="…">')` threw `Flow: element does not fit in an empty column` for any image whose own aspect ratio exceeded the column's — measured at 1.548 on a default A4 flow, so a **9:16 phone photo held upright was enough**, with no float, no CSS and no file involved. The cause was one missing clamp: `ImageElement` fitted an image's WIDTH to the region and never its HEIGHT, so a portrait picture scaled to the column width ran past the column bottom and the engine gave up. An image now **scales to fit**, aspect preserved, and anything that cannot be scaled — a line of 900pt text, say — **draws past the column bottom** rather than taking the document with it. Both happen ONLY where the alternative was refusing the document: a tall image arriving near the foot of a column still moves to the next column at full size, so a picture's size never depends on what precedes it. `page.AddHtml` scales the same image where it previously drew nothing and handed the element back; it still returns anything it cannot scale in `remainder` rather than drawing outside the rect you gave it. Both compromises are now reported in `skipped` — a scaled image as `image:scaled-to-fit`, an overflowing block under the new `overflow` construct — as is a float that could only be laid out in flow, which was unreachable before because it threw. Each record names the **innermost** element responsible, the `<img>` or the `<p>` rather than the block that happens to wrap it. Because these are decided while PLACING, `doc.AddHtml` and `page.AddHtml` return a fresh `skipped` including them, while a `Flow` — whose `AddHtml` returns before `Render` runs — takes the new `onNotRendered` callback; the array `flow.AddHtml` hands back is never appended to afterwards. (`zch2.16`)

- **An HTML float taller than a whole column now splits across columns instead of silently laying out in flow.** `zch2.10` placed floats but deferred one that did not fit — it led the next column whole, and one taller than a whole column stopped being a float at all, so a tall sidebar in a two-column document simply became body text with nothing said. It now paints what fits, carries the rest, and leads the next column as a float again, with text wrapping beside both halves. **A float that fits a column on its own still defers whole**, which is what browsers do in paged media — push to the next fragmentainer, fragment only if it cannot — so nothing `zch2.10` shipped moves. Splitting is one optional member on `FloatContent`, `splitPaint`, which only the CSS float implements: a `FloatingBox` (`Flow.AddFloatBox`) is unaffected and still refuses, because its border and background have no defined way to continue across a column. `page.AddHtml` is unaffected too and deliberately so — it places into ONE rect, which has no next column, so a split head would paint and the tail would be lost; it keeps degrading to in-flow, which draws everything. **Still not reported:** content that cannot fragment at all — a lone image taller than the column — degrades in flow with nothing said, which is `zch2.16`, because it is a placement-time fact and `AddHtml` hands `skipped` back before anything is placed. (`zch2.15`)

- **Text the fallback face cannot draw no longer takes the whole document down.** `doc.AddHtml('<p>При</p>')` threw `Flow: element does not fit in an empty column` — no bytes and no file involved, a plain string was enough. The UA sheet declares `html { font-family: serif }`, which with no registered font folder resolves to Standard-14 Times with WinAnsi; a paragraph whose every character has no WinAnsi code encodes to nothing, measures 0 high, and the flow engine read that as "did not fit here, try the next column". At a column start there is no next column, so it threw — pointing the caller at page geometry when the cause was a missing glyph. **The defect was one word doing two jobs.** A flow element's `measure` reports `fits`, and every producer of it wrote `remainder === null && usedHeight > 0` — conflating *nothing was left over* with *something was drawn*. Only the first is what the engine needs: an element with nothing to draw must be discarded, not retried. `fits` now means nothing left over, and the one consumer that genuinely wanted "and drew something", the keep-with-next lookahead, tests `usedHeight` itself — without that an undrawable heading breaks the page under it, measured as a spurious second page. The fix had to hold for a **chain**: a `<div>` wrapping a `<p>` is a box wrapping a box, and the zero-height verdict propagates up through every one of them, which is why changing the paragraph alone left it still throwing. Affected shapes, all now rendering blank rather than refusing: a paragraph, a nested `div`, bare text, a list item, a block quote, a code block, and any of those followed by content that *is* drawable — which used to be lost with the document. **Not yet reported:** text dropped for want of a glyph is still absent from `skipped`, so a page can come out blank with nothing said. That is `zch2.14`, because the report vocabulary is HTML's while the loss reaches Markdown and hand-built flows equally. Unaffected throughout: a document with `RegisterFontFolder` and a face covering the script. (`zch2.13`)

### Added

- **`doc.Revisions` and `doc.hasIncrementalUpdates` report what an opened file already carries.** A PDF that has been signed, annotated or otherwise appended to holds several revisions, and until now nothing surfaced that. Each `PdfRevision` carries its cross-reference section's offset and, more usefully, the file's byte length as of that revision — so `bytes.subarray(0, rev.length)` IS that revision's complete document, which is how an earlier state is recovered and how a signature's `/ByteRange` is checked against the revision it covers. Oldest first, so the index is the revision number and `[0]` is the document as originally written; a clean, never-updated file reports exactly one. It is read from the `/Prev` walk `readXref` already makes rather than a second scan. The list is empty — deliberately distinguishable from a single entry — for a document authored in memory or one whose cross-reference structure had to be rebuilt, where the chain is precisely what could not be read. (`msdn.4`)

- **`Save({ incremental: true })` appends a revision rather than rewriting the file.** The bytes the document was opened from are preserved verbatim and only the objects that changed are appended, so a signature over the earlier revision stays valid — which is what makes review and annotation workflows on third-party files safe. What changed is decided by re-parsing the original bytes and comparing canonical serializations, so an edit made directly through a public `Dict` handle is caught like any other. The delta is deliberately reachability-blind, the inversion of `Save`'s mark-sweep: an earlier revision still points at the objects a new one supersedes, so nothing may be garbage-collected. Requires a document opened from bytes; refuses encrypted and recovery-opened documents, and refuses to combine with `compressed`, `encrypt`, `linearized` or `streamFilter`. (`msdn.3`)

- **Incremental-update delta computation.** `diffObjects` compares a pristine baseline against the live object map and reports which object numbers a cross-reference update must write, add or free. Equality is byte-equality of the canonical serialization rather than a dirty set maintained at mutation sites: the object model is publicly mutable through `Page.Dict` and its siblings, so a report-based delta cannot be complete, and its failure mode is the dangerous one — an appended revision that silently omits an edit. A serialization diff fails the other way, writing an unchanged-but-reordered object again rather than dropping a changed one. (`msdn.2`)

- **Inline `<svg>` renders.** An `<svg>` in an HTML document draws through the same importer `page.AddSVGObject` uses — paths, gradients, masks, markers, filters and text, all of it — instead of being suppressed and reported, which is what `zch2.7` had to do when its text was leaking into the paragraph flow while the graphic drew nothing. Works on all three `AddHtml` entry points. **"Through the existing importer" turned out not to be free**, and that is the interesting part: `AddSVGObject` takes SOURCE BYTES while the HTML parser produced a DOM, and this library had no DOM-to-markup serializer — the only tree serializer in the repo emits the html5lib debug format for the conformance corpus. So the subtree is serialized back to XML, which has to undo two things HTML tree construction did and which are both silent when missed: an adjusted foreign attribute is stored under a display key with a SPACE (`xlink href`, not `xlink:href`), and element names are already case-adjusted, so `linearGradient` and `viewBox` must be emitted as stored rather than lower-cased the way writing XML from an HTML DOM tempts you to. The output is validated by its consumer — the XML parser is strict — so a serializer bug surfaces as a parse error rather than as a silently wrong drawing. **`svgembed.ts` split** so the import runs from a `Document` alone, with no `Page`: that is what lets it happen while the boxes are being built, which is the only point at which the importer's findings can reach the `skipped` report — `AddHtml` hands that back before anything is drawn, the same timing limit `zch2.14` documented. `AddSVGObject`'s own output is byte-identical, because the builder returns the placement matrix as a closure over the rect rather than baking one in; its whole suite — 39 files, 1090 tests, browser-rendered goldens included — passes unedited. **What the importer could not draw is folded into the same report** as everything else: one `svg` record per finding, `dropped` when nothing rendered and `degraded` otherwise — including for a RASTERIZED subtree, which is a judgement rather than a mapping. The importer is explicit that rasterizing is not a fidelity loss, but it is resolution-bound and its text stops being extractable, so calling it a clean render would hide a real consequence from a caller about to extract text. The closed construct vocabulary does not grow. **An `<svg>` is an ATOMIC, not a block box**, which is the correction that mattered: it is `display: inline` by default, so it never reaches the block-box walk at all, and the first attempt produced no box whatsoever for a top-level graphic. It takes the lone-atomic path an `<img>` already takes, which also means an `<svg>` sharing a line with text stays out of scope for exactly the reason an image does. **Sizing is measured against Chrome rather than reasoned about**, and the headline row is the counter-intuitive one: `<svg viewBox="0 0 100 50">` with no width or height FILLS its container — 800x400 in an 800px container — rather than taking a small default box; the 300x150 default applies only when there is no viewBox to give an aspect ratio. CSS wins over the element's own attributes, and a percentage attribute resolves against the containing block. **Limits:** `<math>` is still suppressed and reported, since there is no MathML importer here; an `<svg>` sharing a line with text is not yet inline; and a filtered subtree still rasterizes, with everything that already implies. (`zch2.12`)

- **CSS floats place, and text wraps beside them.** `float: left` and `float: right` render through all three `AddHtml` entry points instead of being laid out in flow and reported: the box is painted at the channel edge, following content narrows around it and resumes at full width below it, and `clear` drops past it. **Shrink-to-fit is live at last** — `resolveBoxes` has taken a `MeasureFn` since `zch2.3` and *no caller ever passed one*, so an auto-width float came out full width, excluded the whole channel and was indistinguishable from ordinary flow; it now measures min-content and max-content through the same code a table column's auto-fit uses, extracted to a shared leaf rather than copied. `float` leaves the `skipped` report, as `table` did in `zch2.6`. **The engine change is one type, not new machinery.** The issue was filed expecting the latter, but `Render`'s float branch only ever touched four members of `FloatingBox` — `width`, `spacing`, `measure()`, `paintAt()` — so a CSS float joins the existing branch through a structural `FloatContent` that `FloatingBox` satisfies unedited, and there is no second copy of the top resolution, the deferral or the band bookkeeping. A float rides as an optional marker on an ordinary `FlowElement`, which makes **degrading free**: a float the engine declines to place is just an element with a marker it ignores, so it places in flow with its frame and content intact and no fallback rendering path exists to go wrong. `placeElements` gained the same band bookkeeping, so `page.AddHtml` is not the odd one out. **Two pre-existing defects surfaced on the way and are fixed.** A float with a stated width fell through CSS 2.1 §10.3.3's over-constrained rule — which governs normal flow, not floats — and absorbed the whole leftover column into `margin-right`: 326pt for a 150px float in a 601px container, which made its excluded band absurd and drove its own content width negative. And a container's per-child frame wrapper swallowed the float marker, so a float nested in anything (which is every float, since `body` is a container) laid out in flow silently. **Three limits, each deliberate.** A float that does not fit leads the next column WHOLE rather than splitting — correct for every float shorter than a column, and splitting is its own follow-up. Two same-side floats STACK rather than sitting side by side, and the pair is reported: `ActiveFloat.band` is one width from the channel edge and `insetsAt` takes the maximum per side, so side-by-side needs a sum — a change to the band model that `AddFloatBox` shares. And a float taller than a whole column lays out in flow silently, because that is a placement-time fact while `AddHtml` hands `skipped` back before anything is placed. (`zch2.10`)

- **Text a font cannot draw now says so.** With no registered font folder the fallback is Standard-14 with WinAnsi, which has no code for Cyrillic, Greek or CJK — so `AddHtml('<p>При</p>')` rendered a blank page, `skipped` came back empty, and nothing anywhere said why. It is reported now, on all three HTML entry points as a new **`text`** construct, on `AddMarkdown` as `text` or `text:partial`, and on hand-built flow and page text through a new opt-in **`onUndrawable`** option (`Flow.AddParagraph`/`AddHeading`/`AddList`/`AddCodeBlock`/`AddTable`, `page.AddText`/`AddTextBlock`/`AddTable`). Table cells report too, through their own walk — a cell's font comes from the cell→row→table cascade and never passes through the shared flow builders, so a table of Cyrillic would otherwise have stayed silent one construct away from the fix. **`dropped` versus `degraded` is the point of it**: nothing drew is one failure, a word vanishing out of a sentence is a worse one, because the page looks perfectly fine — `'alpha При omega'` drew as `'alpha  omega'` and no test, export or diff could tell you. **The reporting is opt-in for hand-built text and free for HTML and Markdown**, which already had a `skipped` channel promising exactly this; a callback rather than a changed return type, because `Flow.Add*` is chainable, `Render()` returns pages and `AddTextBlock` returns its remainder, and breaking three of the most-used methods in the library buys nothing a sink does not. **Two things were measured rather than reasoned about, and both would have shipped as bugs.** The obvious partial rule — encodable count against codepoint count — fires on `\n`, `\r` and `\t`, which encode to nothing because they are layout structure rather than ink: unfixed, every code block and every hard-broken paragraph in every document carries a report. And `FontDriver.probe` is the wrong primitive for the partial case at all, since the shaped driver counts GLYPHS and Arabic ligatures legitimately produce fewer glyphs than characters — so a shaped block gets the all-or-nothing answer only, and the per-character question goes through each font's own predicate. The construct is named `text` to match what the SVG importer has reported for the same failure since long before this, so the library states one rule across both importers rather than two. **Explicit non-goal:** no fallback face is substituted. We report that Times cannot draw `При`; we do not go looking for a face that can, which would change what documents render rather than only what they say about themselves. (`zch2.14`)

- **HTML that arrives as bytes, with the encoding worked out from the bytes** — `parseHtmlBytes(bytes, { encoding? })`, and `htmlFileToPdf(inputPath, outPath, options?)` in the Node wrappers, the first entry point in this library that reads HTML from a file. A byte order mark decides outright, else the caller's `encoding` (any Encoding Standard label — `windows-1251`, `cp1251`, `Shift_JIS`), else UTF-8 corrected by the document's own `<meta charset>`. The failure it closes is one a caller cannot detect: `readFile(p, 'utf8')` on a legacy page is silent mojibake that flows all the way into the PDF, and the caller is precisely the party who does not know the encoding. **`parseHtml(src)` is untouched** and still takes a string — the new entry is a sibling, because `parseHtml` is what 8,862 vendored cases anchor and it should not move. **There is deliberately no prescan, and that is the decision the whole thing turned on.** HTML's prescan is an optimization for a *streaming* parser: it exists so a browser can begin tokenizing a network response without waiting to see whether a `<meta>` is coming, and it gives up after 1024 bytes. We hold the whole buffer, so tree construction's own change-the-encoding rule reaches the same answer for every document — and reaches it for a `<meta>` past that window, which a browser misses and we get right. What lets the first pass find that `<meta>` at all is that tags are ASCII and UTF-8's decoder is non-fatal, so a windows-1251 body decodes to U+FFFD noise around perfectly intact tag structure. There is **at most one restart**, and that is a proof rather than a limit: the second pass runs with certain confidence, so the rule cannot fire again. **The Encoding Standard's label table is not transcribed** — `TextDecoder` already implements it, all ~230 labels over ~40 encodings, which is why this is ~100 lines and not a table-driven module; measured, `cp1251` and `x-cp1251` resolve to `windows-1251` and `iso-8859-1`/`us-ascii` to `windows-1252`, the standard's deliberate legacy aliases. That borrows one property: legacy decoders are **ICU-dependent**, so on a `small-icu` Node build an unresolvable label is treated as unknown and the current encoding stands — a degrade, never a throw. `htmlFileToPdf` resolves a relative `<img src>` from beside the HTML file, **confined to that directory**: a URL scheme, an absolute path, and anything climbing out with `..` are refused and reported in `skipped`, so the library still fetches nothing. A caller's own `resolveImage` always wins. **Not covered:** a UTF-16 document with no BOM, which §13.2.3.1 leaves implementation-defined and browsers answer with frequency heuristics we decline to guess at. Every rule here is held by hand-built fixtures, because both vendored corpora are string-level by construction and the one case that could discriminate — a comment pushing `<meta charset>` past 1024 bytes — is a *tree* test that asserts only where the element lands. 12 of 13 mutations redden; the thirteenth is recorded in the source as a redundant defence no portable fixture can reach. (`zch2.8`)

- **An image on a line of text.** `<img>` among words renders through `AddHtml` instead of being reported, and the wrapping engine every text producer shares can now place a non-text box in a line. Sized from `width`/`height` where stated, else the image's intrinsic pixels read as CSS px with the aspect preserved; an image wider than the column clamps to it, the rule block images already followed. `vertical-align: baseline`, `top` and `bottom` are honoured for one. **The engine change is the interesting half.** An atomic is a **U+FFFC OBJECT REPLACEMENT CHARACTER** in the concatenated run text — what Unicode defines that character for — so the whole index-based walk, the word units, the UAX #14 break search and the remainder reconstruction work unchanged, and `a<img>b` is one unbreakable word while `a <img> b` is three, which is CSS's own answer, for free. A new pure leaf `linebox.ts` owns the baseline and band arithmetic; **with no image present it collapses to exactly the arithmetic that came before**, which is why the byte-identity fence over eight existing call sites never moved. The subtlest part was the pen: the text emitter writes no per-segment `Td` and relies on `Tj` to advance, so an atomic — which emits no `Tj` — needs an explicit `TJ` kern or the following text overprints the picture. **The limits:** `vertical-align: middle` is *not* implemented and stays reported, because CSS defines it against half the x-height, which the AFM tables do not expose; a lone image in its own block is still a block figure rather than an inline box; and Markdown's `loneImage` restriction is unchanged, lifted in its own follow-up now that the engine exists. New `paragraph({ atomics })` authoring option, taking image bytes. All 18 mutations aimed at the new rules redden something — two only after their fixtures were rebuilt, one of which had been asserting a bound the bug also satisfied. (`zch2.11`)
- **Every construct that does not render now says so, and eight that were silent now report.** The rule `svgdraw.ts` set — an element we cannot render fully names itself and still contributes what it has — was true of tables, images and floats and quietly false of everything else. Probing a live build turned up eight silent cases and one outright loss. **A nested `<table>` inside a cell was losing its text entirely** — `<td>outer<table>…INNER…</table></td>` drew only `outer` — a regression shipped in `zch2.6` and now fixed by flattening the inner cells into the outer one. **`<iframe>` and inline `<svg>`/`<math>` content stops being drawn**, because no browser draws it: an `<iframe>`'s children are, in HTML's own words, "ignored by conforming user agents", and an SVG `<text>` was leaking into the paragraph flow as body text while the graphic drew nothing. **`<object>`, `<video>`, `<audio>` and `<canvas>` children keep rendering** — those genuinely are fallback content a browser shows when the thing cannot load, so the leak policy is per element by what the content *means* rather than one uniform rule that would be wrong in one direction or the other. **An `<input>`'s value is now drawn** where it used to vanish, and a `<select>` draws its selected option only — emitting every option turns a three-choice dropdown into three lines of body text. `type=hidden` and `type=password` draw nothing and report `dropped`: the password refusal follows the rule this library already applies to AcroForm fields, since flattening bakes plaintext into permanent page content where no viewer will ever mask it again. `display: inline-block`, `vertical-align` and padding on an inline box are reported rather than implemented — all three are computed and never read, so the cascade's unknown-property backstop never fired for them. A fragment-only `href` moved off `unsupported` onto the report, cashing in a note `zch2.6` left. **Rendering inline SVG through the existing importer is `zch2.12`.** All 21 mutations aimed at the new rules redden something except one, recorded as uncovered. (`zch2.7`)
- **CSS tables, images and links through `AddHtml`** — `<table>`, `<img>` and `<a>` now render, so two of the three constructs `zch2.5` could only report have left the `skipped` list. A table maps onto the **existing** `flowtable.ts` element rather than a second table implementation, which is what gets it pagination, repeating header rows, `colSpan`/`rowSpan`, per-cell borders and backgrounds, auto-fitted column widths and `/Table` > `/TR` > `/TD` tagging with no new code in the authoring layer — one builder per construct, since three definitions of a table is three chances for them to disagree. A cell's content is built by the **same** function a paragraph's is, so bold, code and links behave identically inside one. `<thead>` becomes the repeating header block and a `<caption>` is emitted as a paragraph above the table, since the authoring layer has no caption vocabulary and dropping it would lose its text. CSS 2.1 §17.2.1's anonymous-box fixup is implemented where it is actually needed — on a div tree given `display: table-*` by CSS, since the HTML5 tree constructor already produces well-formed `table > tbody > tr > td`. An `<img>` that is the only thing in its block renders as a figure: `data:` URIs decode with no setup, and anything else goes to a new **`resolveImage: (src, alt) => Uint8Array | undefined`** option, which is how the library renders pictures while touching neither `fs` nor the network. Links already worked and now have a test fence; what changed is that a **fragment-only `href` gets no link** and is reported instead, because a `/URI` action pointing at `#intro` is a link that looks clickable and does nothing in a viewer — resolving one needs an id-to-destination map built after placement. **The limits, each reported rather than silent:** a cell holding block content (a `<p>`, a nested list) flattens to its text and names itself `table-cell-blocks`, since the authoring layer's cells take runs rather than elements; CSS column widths are not read, so columns auto-fit; four differing cell border edges collapse to one width and colour; an image sharing its line with text is still reported (`zch2.11`); and float placement is still `zch2.10`'s. **Two rules were found unmeasured by the mutation sweep and are now pinned:** a `<td>` inside a `<thead>` is a header — every fixture had used `<th>`, leaving the section half of the rule unreachable — and a cell border's edge set, which the plan had predicted would be uncovered. (`zch2.6`)
- **CSS custom properties and `var()`** — `--brand: #336699; color: var(--brand)` now works through `AddHtml`, including inside a shorthand (`border: 1px solid var(--c)`) and inside `calc()`. Custom properties cascade through all six tiers, honour `!important`, inherit, and are case-sensitive — the one name in CSS that is, so `--Foo` and `--foo` are different properties. **Substitution is token-level and runs before any grammar sees the value,** which is forced rather than chosen: measured against Chrome, `--op: + 5px` with `calc(10px var(--op))` computes to 15px, so a variable is a *fragment* of a value, not a value — which is also why `calc()` and every other consumer needed no change at all. An unresolvable `var()` does not drop the declaration: the property falls back to inherited-or-initial exactly as CSS's invalid-at-computed-value-time rule says, and the failure is **reported** as `undefined-var` or `var-cycle` on the same `unsupported` list that already names unknown properties, so a caller can tell a typo'd variable from a malformed length. **Three rules the obvious implementation gets wrong, all measured rather than reasoned about:** a fallback fires only when the referenced property is *guaranteed-invalid*, never when the substituted result merely fails the property's grammar — so `--x: 10px; color: var(--x, red)` inherits rather than going red; a fallback inside a reference cycle does not rescue it; and a name declared on an element never sees its own inherited value, so `--a: var(--a)` is a self-cycle rather than a read-through to the parent. Cycles are detected on a dependency graph that includes fallback references, and a separate 65,536-token expansion budget catches the billion-laughs shape, which has no cycle at all — **a deliberate divergence**, since Chrome expanded 100,000 tokens and survived, but an unbounded expansion in a library that parses files it did not write is not something to ship. `@property`, `env()` and animation of custom properties remain out of scope. The Blink corpus grew from 18 cases to **22** and 271 comparisons to **320**, and all four new cases agreed on the first generated run. (`zch2.2.7`)
- **CSS `calc()`, `min()`, `max()` and `clamp()`** (CSS Values 4 §10), usable at every length, percentage and number site `AddHtml` understands — `margin-left: calc(25% + 4px)`, `font-size: calc(1em + 4px)`, `width: min(50%, 40em)`. The whole feature is one branch of the value parser, which is why it lands without touching the cascade: a math function is a single component value, so `lengthOf` and `numberOf` gained a branch each and all 43 longhands got it at once. **The model change underneath it is the part worth knowing about:** a length-percentage is now the single shape `A px + B %` rather than "either a px or a percentage", because `calc(100% - 20px)` is neither and CSS Values 4 §10.9 says every such function reduces to exactly that pair. A `calc()` is a sum of products and so always reduces; a `min()`/`max()`/`clamp()` reduces too *unless* a percentage reaches it, since which argument wins then depends on a containing block nobody knows until layout — those alone are carried unresolved and settled against the width, so `min(50%, 60px)` really does pick a different argument in a narrow column than in a wide one. Type checking is enforced rather than assumed: `px + %` is legal, `px * %` is not, division demands a number on the right, and a comparison demands one type across its arguments — which also makes `width: calc(5)` refuse itself, exactly as `width: 5` does, with no rule of its own. An expression we cannot read is reported as an unparsable value rather than dropped, so it stays visible to a caller. **One deliberate divergence from browsers, found by regenerating the Blink corpus rather than reasoned about:** `calc(10px / 0)` is refused here, where Chrome 152 follows Values 4's infinity-and-clamp rule and computes it to 33554432px. An infinite length reaches the stamping layer, which refuses a non-finite rect; a refused declaration falls back to the initial or inherited value, which renders. The cascade corpus grew from 14 cases to **18** and 203 comparisons to **271**, and all five mutations aimed at the new cases redden it. (`zch2.2.6`)
- **CSS `:lang()` and `:dir()`**, the two selectors `zch2.2.2` left out and the first that are user-visible through `AddHtml`. Both are answered from the **DOM** rather than the cascade, and that is the correction the issue turned on: it was filed on the belief that both "need the inherited lang, which is the cascade's rather than the selector engine's", but `lang` and `dir` are HTML *attributes* inherited through parent pointers, and `ComputedStyle` carries neither among its 43 longhands — so `matches()` gained no parameter and the work needed nothing from `zch2.2.3` at all. `:lang(en)` matches `en-US` and not `english`, by RFC 4647 §3.3.2 extended filtering: the match must fall on a subtag boundary, which `startsWith` gets backwards, and a singleton subtag may never be skipped because a one-character subtag begins an extension. `:dir()` honours an explicit `dir`, inherits it, and **resolves `dir=auto` by first strong character** through the existing UAX #9 implementation rather than defaulting it to `ltr` — which would answer wrongly for every Arabic or Hebrew document that uses it — with the scan skipping any descendant that states its own `dir`, and `<bdi>` defaulting to `auto`. An unknown `:dir(sideways)` is *valid and never matching* while an empty `:dir()` is *invalid*, a distinction that costs the whole selector list when reversed. **`:lang()` accepts one unquoted ident, which is narrower than Selectors 4 and was decided by measurement:** the spec allows a comma list of quoted, wildcard-bearing ranges, and regenerating the Blink corpus showed Chrome 152 refusing every one of those forms, `:lang("en")` included — so accepting them would style content no browser styles, since an unsupported selector invalidates its whole list. The corpus grew from 869 to **1,344 match cases** and 8 to 10 specificity contests, with all 238 `:lang()`/`:dir()` cases agreeing on the first run. (`zch2.2.5`)

- **HTML to PDF** — render an HTML document into a flow, into a rect on a page, or a whole document in one call: `flow.AddHtml`, `page.AddHtml`, `doc.AddHtml`. This is the first reachable end of the whole `zch2` stack: the source is parsed by the HTML5 tree constructor, styled through the CSS cascade (a UA sheet transcribed from HTML §15, author `<style>` elements and `style=` attributes, 43 longhands, selectors up to `:has()`), laid out as a CSS box tree with block and inline formatting contexts, used widths per CSS 2.1 §10.3.3 and full margin collapsing, and lowered onto the same flow elements Markdown uses — so it paginates, tags and mixes with hand-built content **with no second layout engine**. Block backgrounds, all four borders and padding are painted, and a box split across a column keeps its side borders while drawing its top and bottom exactly once. Headings become `/H1`..`/H6` under a tagged flow and take part in keep-with-next; a run of `display: list-item` siblings becomes one list, so ordinals run continuously and `/L` > `/LI` > `/LBody` follows. `font-family` resolves against the document's registered font folders first and falls back to the Standard-14 generics (`serif` → Times, `sans-serif` → Helvetica, `monospace` → Courier), so it renders with no setup and improves with `RegisterFontFolder` — note that means an unstyled paragraph is **Times**, because the UA sheet declares `html { font-family: serif }`. `doc.AddHtml` adopts the source's own `<title>` as the PDF title unless given one, which the Markdown entry point cannot do because Markdown has no title construct. **Tables, images and float *placement* do not render yet**: each names itself in the `skipped` report and still contributes its text, so a caller can tell a dropped table from an empty document. (`zch2.5`)

- **CSS `:has()`**, the one selector `zch2.2.2` left out — the relational pseudo-class, with all four relative-selector leads (`:has(p)`, `:has(> p)`, `:has(+ p)`, `:has(~ p)`), correct specificity, and the two refusals CSS requires. An argument is stored as an ordinary complex selector with the implicit anchor **prepended**, so `:has(> div p)` is held as `:scope > div p` and the existing right-to-left matcher does the anchoring, backtracking included; the module gained no second matching algorithm. That matters because the plausible alternative — "does some descendant match `div p`" — is wrong in a way that still renders: it styles every `div` with a `p` anywhere beneath it rather than one whose own **child** `div` holds the `p`. The anchor weighs `[0, 0, 0]`, since Selectors 4 counts a `:has()` as its most specific *argument* and the implicit `:scope` is not something the author wrote — left to the default branch it weighs a phantom class and reports `div:has(> p)` as `[0, 1, 2]`, a plausible number that loses the wrong contests. `:has()` is **non-forgiving** and refuses both a nested `:has()` and a pseudo-element inside one, which invalidates the whole selector list as every other refusal here does; that is the current reading of Selectors 4, after `:has()` was changed away from a forgiving argument list, and headless Chrome confirms it by refusing `div:has(p:has(span))` outright. The Blink corpus was regenerated for this and grew from 549 match cases and 6 specificity contests to **869 and 8, all green with no allowlist** — it corrected nothing this time, which is itself the point: the work is checked against a browser rather than against itself. **The cost was measured rather than reasoned about, and is worse than the quadratic the issue predicted.** The driver is nesting *depth*, not element count: the cascade asks every rule about every element, a `:has()` walks the anchor's subtree, and each candidate then walks back up the ancestor chain. At a fixed 4,000 elements that is roughly quadratic in depth — 31 ms at depth 10, 187 ms at 80, 2.7 s at 320 — and an all-nested chain, where depth *is* the element count, is cubic, at 7.4 s for 1,000 nested `div`s. It ships **unguarded**: real markup nests 10-20 deep, where 4,000 elements cost about 35 ms, nothing throws at any depth, and a visit budget would buy the bound by answering a selector *wrongly* on a large document. The numbers are recorded beside the code and fenced by a test rather than left to be discovered. Not reachable from public API — `cssselect.ts` is exported from no entry point; the box model (`zch2.3`) is its consumer. (`zch2.2.4`)

- **HTML5 fragment parsing, and `parseHtml` is now public API** — the first reachable piece of the HTML parser. `parseHtml(src)` takes a string and returns the node tree, following the WHATWG tokenizer and tree-construction stages; it never throws, because every string is a valid HTML document and the spec defines a recovery for every parse error. **1,830 of the 1,936 vendored web-platform-tests cases now run, all green**, up from 1,634 — the remainder are the scripting flag, processing instructions and `<selectedcontent>`, each excluded by a computed predicate and recorded with its reason. The fragment algorithm itself (§13.4) is implemented and fully tested but deliberately not exported: nothing can call it yet, because the entry points that will render HTML take a PDF target rather than an HTML element and so have no context element to pass. The return type is the tree alone rather than a result object carrying parse errors — those are never actionable for a caller rendering a PDF, and widening a return type later is additive where narrowing is not. Two failing cases on the first full run led to a sweep of the spec for every "fragment context element is" guard: there are exactly four that apply, and three were missing — in-body's `<input>` and `<select>` ignore the token when the context is a `select`, after-body's `</html>` ignores it rather than switching to "after after body" (which would send a following comment to the Document, where a fragment never serializes it), and in-frameset's `</frameset>` never leaves the mode. With this the HTML parser is complete for non-scripted content. (`zch2.1.3.3`)

- **HTML5 `<template>`**, the last insertion mode the parser was missing. The "in template" mode (HTML Standard §13.2.6.4.16) and the stack of template insertion modes beside it, plus a template's content fragment — a real node in the tree rather than an extra children array, because a template's content is deliberately not part of the document and nothing that walks the document should walk it. **1,634 of the 1,936 vendored web-platform-tests cases now run, all green**, up from 1,524, and `htmltree.ts` now implements every one of the 21 insertion modes the spec defines. It also fixes a defect shipped in `zch2.1.2` and invisible until now: foster parenting searched the stack for the last *table* where the spec says the last *template or table*, so stray content inside `<template><table>` fostered past the template entirely. **Three more rules the corpus caught that the design did not name** — in-body's end-of-file is the only place outside "in template" that consults the mode stack, and is the whole reason an unclosed `<template>` still gets a `<body>`; in-body's `<html>` and `<body>` start tags ignore the token outright when a template is open, rather than writing its attributes onto the real element; and foster parenting has to accept a content fragment as a table's parent. Two spec branches are deliberately absent and documented as decisions rather than gaps — declarative shadow DOM, which is gated on a parser flag no non-browser sets, and the insertion-target machinery behind a template's `for` attribute, which nothing reads; the corpus contains zero cases touching either. Still not reachable from public API — `parseHtml` ships with fragment parsing in `zch2.1.3.3`. (`zch2.1.3.2`)

- **HTML5 foreign content**, so an inline `<svg>` or `<math>` subtree parses into its own namespace instead of silently into the HTML one. The rules for parsing tokens in foreign content (HTML Standard §13.2.6.5), the four adjustment tables that fix the case of SVG element and attribute names and turn `xlink:href` into a namespaced attribute, the two integration-point predicates that decide when an HTML insertion mode resumes inside a foreign subtree, and the breakout list that pops out of one on an HTML block start tag. **1,524 of the 1,936 vendored web-platform-tests cases now run, all green**, up from 1,317. The self-closing flag is read for the first time in the parser's life: no HTML element's parsing depends on it, but `<svg/>` is an empty element while `<svg>` swallows the rest of the document — and a NUL is inserted as U+FFFD here where "in body" ignores it, one `case` label apart. **The corpus caught a rule the design and the plan both missed**, which is why such fixtures are vendored: every "pop until an element with this tag name" in the spec means an *HTML element* with that tag name, and `<td><svg><td>` puts an SVG `td` above the HTML one — so a name-only match stops at the wrong element and strands the entire SVG subtree on the stack. One vendored case (`namespace-sensitivity.dat`) failed on the first full run and nothing else did. Still not reachable from public API — `parseHtml` ships with fragment parsing in `zch2.1.3.3`. (`zch2.1.3.1`)

- **HTML5 tree construction**, the second piece of HTML→PDF conversion. The non-template insertion modes (HTML Standard §13.2.6), the stack of open elements with its distinct scope predicates, the active formatting elements with the Noah's Ark clause, the adoption agency algorithm that rescues misnested markup, and foster parenting — over the tokenizer that landed in `zch2.1.1`. Anchored by **1,317 web-platform-tests cases, all green**, with no allowlist: every in-scope case runs and the bucket counts are asserted separately, so a case cannot be reclassified to dodge a failure. The corpus is WPT's rather than html5lib's because html5lib-tests no longer carries tree-construction at all: its README records that the tests "are now solely maintained on web-platform-tests". **The corpus corrected the spec reading this work was designed against**, which is why such fixtures are vendored: the HTML Standard has *removed* the "in select" and "in select in table" insertion modes (the customizable-select change), so a `<select>`'s content is now parsed by "in body", and "select scope" is gone — `select` has moved into the *default* scope's terminator list, a reversal, since select scope used to be inverted. Seventeen vendored cases fail against the older reading. Two disagreements are recorded rather than papered over: processing instructions, where WPT and our pinned tokenizer oracle are on different sides of a spec change and we follow the tokenizer's (86 cases, `zch2.9`), and `<selectedcontent>`, whose expected tree holds text the *element* clones in from the selected `<option>` rather than anything a parser puts there (4 cases, `4h3p`). Still not reachable from public API — `parseHtml` ships with foreign content in `zch2.1.3`, because without it an inline `<svg>` parses into the HTML namespace and produces a tree that is wrong silently rather than loudly. (`zch2.1.2`)

- **A conformant HTML5 tokenizer**, the first piece of HTML→PDF conversion. A literal transcription of the WHATWG state machine (HTML Standard §13.2.5) — every state named as the spec names it, both character-reference forms, the alternate content models, and the full parse-error vocabulary with line and column — anchored by the official html5lib-tests tokenizer suite that browser engines share: **7,032 cases, all green**. It **never throws**: every string is a valid HTML document, since the spec mandates a recovery for every parse error by construction, so damage is reported as values on `errors` rather than by refusing the input. That is CommonMark's rule here and the exact opposite of `parseXml` one directory away, which is worth knowing before anyone "fixes" the difference. The bundled entity table gained the **106 names HTML5 matches without a trailing semicolon**, which turns out to be a spelling permission rather than a wider table — every one of them is already a semicolon key with an identical value — so `?a=1&copy=2` keeps its query string in an attribute while the same bytes in text give `©`; CommonMark reads the values and never the permission, and its 652 cases are the fence that its output did not move. **The suite corrected two rules this repo had asserted the wrong way round in its own tests**, which is the whole reason such fixtures are vendored: columns count UTF-16 code units rather than code points, so an astral character advances by two; and `cdata-in-html-content` is reported at the last character of the `[CDATA[` it consumed while `incorrectly-opened-comment` is reported at the one character it merely peeked. Both hand-written tests had passed, because both halves were ours. Not yet reachable from public API — tree construction is next, and `parseHtml` arrives with it. (`zch2.1.1`)

- **CCITT Group 4 encoding, for bilevel TIFF** — `encodeG4` (ITU-T T.6) and `encodeTiff(frames, { compression: 'g4' })` over a new `kind: 'bilevel'` frame, 1 bpp packed with 1 = black. This is the coding fax and document-archival toolchains expect to read, and it completes the symmetry with `ccitt.ts`, which has decoded G4 since the beginning. The code **tables are not transcribed twice**: `ccitt-tables.ts` already owned T.4's run-length codes and T.6's mode codes for the decoder, and the encoder imports them, as it imports `findB1Index` — "which changing element is opposite in colour to a0" is one question, and a second copy is how two halves come to disagree about a code no round trip through our own pair would ever reveal. G4 **refuses a frame that is not bilevel** rather than thresholding, because choosing a threshold is a decision about the image the caller did not ask us to make; that also means `ToImage({ format: 'tiff', compression: 'g4' })` refuses, a rendered page being 8-bit RGB. **Two things measured rather than claimed.** The original issue text said `ccitt.ts` already coded G4 — it decodes only, which is why this was split out of the TIFF encoder in the first place. And the claim that G4 beats Deflate did not survive measurement: on synthetic bilevel pages Deflate wins outright without vertical coherence and the two come within 2% with it, so the test asserts compression against the raw bitmap instead. Real scans favour G4 more than any fixture we can synthesize, but no real fax TIFF is vendored here, so the reason to write G4 is what other toolchains expect to read, not a size win we can demonstrate. (`vk5h.7`)

- **`doc.AddImagePages()` turns an image file into pages** — a multi-frame TIFF, which is how a scanned or faxed document arrives, becomes one page per frame; a single-frame JPEG, PNG or BMP becomes one page, which is the ordinary image-to-PDF operation and previously had no entry either. `frames` selects a subset (0-based, normalized ascending and deduped like every other page selection here) and `dpi` sizes the pages, defaulting to 72 so one pixel is one point — a 300-DPI scan passed `{ dpi: 300 }` gets pages in real inches. The expansion happens at **add** time rather than on save, which is where Java does it: this library's `Save()` is a pure function of the live model, so creating pages during serialization would make the page count depend on when you looked and would put a decoder inside the writer. A frame that will not decode costs **its own page and nothing else** — it is reported in `skipped` with the decoder's reason, so a partly-corrupt fax still yields the pages that survive; only a file where no frame at all decoded throws, there being nothing to hand back and silence looking like success. (`vk5h.6`)

- **`page.ToImage` can emit BMP and GIF** — the last two of Java's five raster devices, closing that gap. `{ format: 'bmp' }` writes an uncompressed 24-bit `BI_RGB` bitmap: the one encoding every reader in existence opens, chosen over a palette because a palette would mean quantization BMP does not need. `{ format: 'gif' }` writes a GIF89a, and the **quantizer is the interesting part** — an image with at most 256 distinct colours is passed through **exactly**, so a page of text and flat fills round-trips losslessly and only a photograph or a gradient reaches the median cut. That is why GIF is usable for rendered documents at all rather than being merely lossy, and it is stated in the option docs as the issue asked. Both are opaque-only and refuse `background: 'transparent'`, following JPEG rather than TIFF: 24-bit BMP has no alpha, and GIF has index transparency rather than an alpha channel, so honouring it would mean sacrificing a palette entry — a decision about the image nobody asked us to make. Two traps worth naming: GIF's LZW is **not** the LZW in `lzw.ts`, which is PDF's — the GIF coder is LSB-first with a palette-derived root size and length-prefixed sub-blocks, so reusing the existing encoder would have produced a structurally valid file that decodes to noise; and BMP stores rows **bottom-up**, the opposite of the samples this library holds, which when wrong yields a mirrored image that reads as a plausible picture rather than a fault. (`vk5h.5`)

- **`doc.ToTiff()` writes a page range as one multi-page TIFF** — the entry that actually closes the archival, fax-gateway and scanning-pipeline case, which the per-page encoder could not: encoded TIFFs cannot be concatenated, so a caller looping over `page.ToImage({ format: 'tiff' })` had no way to combine the results, and every frame has to reach a single `encodeTiff` call. `pages` takes an explicit 1-based list or a `"1-5,8,12-"` range string through the same `pagerange.ts` resolver `Overlay` and the decoration API use, so a list is normalized ascending and deduped; the remaining options are `ToImage`'s and apply to every frame, and `background: 'transparent'` is honoured, TIFF being able to carry alpha where JPEG cannot. An empty selection is refused **in `ToTiff`'s own terms** rather than by the encoder, which would otherwise report in terms of a function the caller never called — the real mistake is a page selection that matched nothing. (`vk5h.4`)

- **`page.ToImage` can emit TIFF, and `encodeTiff` writes multi-page TIFF** — `ToImage({ format: 'tiff' })` encodes the rendered page as a baseline strip TIFF, Deflate-compressed by default (`{ compression: 'none' }` writes the samples verbatim). The new `tiffencode.ts` is the writing counterpart to the `tiff.ts` reader and is pure — bytes in, bytes out, no `Document` — and it takes a LIST of frames rather than one, because a multi-page TIFF is not a different writer but the same IFDs with their `nextIFD` pointers chained; `encodeTiff` is exported so that contract is usable now, with the `doc.ToTiff()` entry to follow. Every choice is made from the set `tiff.ts` already decodes, so a file this library writes is one it can read back. Unlike JPEG, TIFF **can** carry alpha, so `background: 'transparent'` is honoured here through an unassociated `ExtraSamples` rather than refused — which is what makes the JPEG refusal a property of that format rather than a blanket rule. Rows are split into strips against a 64 KB budget instead of one image-sized block. **Not included:** CCITT G4, which the issue originally assumed was nearly free because `ccitt.ts` handles G4 — it decodes only, and a T.6 encoder is its own piece of work, now tracked separately. G4 is what makes a bilevel scan small, so a scanned-document TIFF written today is larger than a fax-toolchain one. (`vk5h.3`)

- **`page.ToImage` can emit JPEG** — `ToImage({ format: 'jpeg' })` encodes the rendered page through the library's own baseline JPEG encoder, with `quality` (1..100, IJG scale, default 75) selecting the trade. For a page of scanned or photographic content this is the format that belongs on the wire, and it was previously reachable only by rasterizing to PNG and re-encoding elsewhere. `quality` is read by lossy formats only and documented as ignored by PNG, so one options bag can be carried across formats without stripping keys. The **decision this raised**, recorded because both answers are defensible: JPEG has no alpha channel, so `{ format: 'jpeg', background: 'transparent' }` is a contradiction, and it now **throws** rather than quietly compositing onto white. Compositing would return a perfectly valid file, which is precisely what makes it the worse answer — the caller's transparency request would vanish with no signal, and `ToImage` returns bytes with no report channel to carry one, unlike `AddSVGObject`'s `skipped`. Refusing is also the reversible choice: relaxing it to composite later is additive, where tightening a silent composite into an error would break callers. The error names both options and says which to change. Internally the RGB conversion is now shared by both encoders rather than living inside the PNG path, so the two cannot disagree about it — the PNG byte-identity fence from `vk5h.1` is what proves that refactor moved nothing. (`vk5h.2`)

- **`page.ToImage` takes an explicit `format`, and refuses one it cannot encode** — the first step of widening raster output past PNG, which is today the only encoding `ToImage` can produce. `format` defaults to `'png'`, so nothing a caller wrote before changes and the emitted bytes are unmoved; what is new is that the option *exists*, that `ImageFormat` and `IMAGE_FORMATS` are exported so a caller can discover what is supported, and that an unrecognised value now throws `UnsupportedFeatureError` naming it. That refusal is the point of the change rather than a side effect: TypeScript already stops the mistake at the call site, but this ships as JavaScript too, and PNG bytes silently returned for `format: 'jpeg'` get written under an extension no viewer opens — a corrupt file, where an error is merely an inconvenience. The check runs before the render, so a refused call does no work. `ImageFormat` is a **closed union** rather than a wide `string` precisely so each encoder that follows widens it, which is additive; and the PNG path is fenced by a recorded hash of a known page's bytes, since a test that renders the same page twice through one encoder cannot notice that encoder changing. (`vk5h.1`)

- **The package is publishable to npm as public** — `@asposefoss/pdf` is scoped, and a scoped package publishes private by default, so `publishConfig.access` is now `public`. The manifest also gained the metadata a public package is read by: `license` (**MIT**, matching every sibling in the [aspose-pdf-foss](https://github.com/orgs/aspose-pdf-foss/repositories) org), `author`, `repository`, `homepage`, `bugs` and `keywords`, plus a `LICENSE` file. A `prepublishOnly` hook runs typecheck, the full suite and the build before anything leaves the machine — `dist/` is gitignored, so a publish without a build is the failure mode this guards. The tarball ships `dist/`, the README, both licence files and `THIRD-PARTY-NOTICES.md`, which is new: `dist/std14data.js` embeds the Standard-14 substitute outlines, and those fonts carry their own terms — Liberation under SIL OFL 1.1, and URW Standard Symbols PS / D050000L under AGPLv3 with the font exception that covers embedding them in a generated PDF. The library's own code is MIT; the notices say which parts are not, and how to rebuild the table without the URW faces. (`j2qu`)

- **Rich text (`/RC`, `/RV`) can be read and searched as text** — both entries hold an XHTML fragment rather than a string, and everything that read them got markup. Searching a note for the words a reader actually sees found nothing, while searching it for `p` or `body` matched a tag name; `RichTextValue` handed callers the same markup. `richTextToPlain` is the new reducer, `Page.SearchAnnotationText` now covers `/RC`, and a text field gains `RichTextPlain`. It is a **sibling** of the raw read rather than a change to it, and that was forced rather than chosen: FDF/XFDF round-trips both entries verbatim, so redefining `RichTextValue` would have silently corrupted every export. The block rule is stated because both ways of getting it wrong are silent and opposite — concatenating everything turns `<p>a</p><p>b</p>` into `ab` so a query for `ab` matches text that was never written, while separating every sibling turns `<p>a<b>x</b>y</p>` into `a x y` so a query for `axy` stops matching text that is there. Malformed markup yields nothing for that entry rather than throwing or falling back to the source, so one bad fragment cannot cost a page its search. Note `AnnotationTextKey` gained `RC`: additive at runtime, but source-breaking for a caller switching exhaustively on it. (`k2k5`)

- **A composite font measures a CID its `/W` omits from the embedded program** — `imxw.4` gave simple fonts their advances from the embedded program where `/Widths` could not answer, and composite fonts were left out on the grounds that `/DW` supplies a real default of 1000. That reasoning had a hole: `/DW` was read as `?? 1000`, which collapses *"the font says 1000"* into *"the font says nothing"* — the same distinction this library already draws for `/MissingWidth`, and for the same reason. The rule is now symmetric across both halves of the font model. A width stated in `/W` wins; an **explicit** `/DW` wins over the program, including a deliberate `/DW 1000`; and an **absent** `/DW` leaves 1000 as a spec default the producer never stated, so the program — which is embedded in the file and knows — answers first, with 1000 as the last resort. This reaches `GetText`, `GetTextFragments`, `ToImage` and `ToSvg` alike. The CID→glyph rule that makes it possible (`/CIDToGIDMap`, then a CID-keyed CFF charset, then identity) moved into the module that already owns "which glyph does this code select", so rendering and measurement can no longer disagree about which glyph a CID picks — they were separate copies before. (`e5j5`)

- **HTML export embeds Type 1 (`/FontFile`) programs as `@font-face`** — `ToHtml({ mode: 'fixed', fonts: 'embed' })` inlined `/FontFile2` and `/FontFile3` programs as WOFF but degraded a Type 1 to a mapped CSS family stack, so a document whose text was set in an embedded Type 1 rendered in a substituted face with different metrics. It is now converted to OpenType-CFF through the same path `AddFont` uses for a `.pfb`, so glyphs and advances match the PDF. Hinting is dropped, as it is there and for the same reason. Note what had to be got right and is invisible when wrong: the conversion **renumbers glyph ids** so `.notdef` is first, as CFF requires, while the cmap this export builds is keyed by ids from the Type 1 program's own numbering — a font listing `.notdef` last shifts every glyph by one, and since both numbers are valid glyph ids nothing errors, the page simply renders each character as its neighbour. `embed` and `embed-all` treat a Type 1 alike, there being no `OS/2` table and so no `fsType` bits to honour. (`m9on`)

- **A macOS `.dfont` suitcase can be embedded, and found by family name** — a `.dfont` holds ordinary sfnt faces inside a Macintosh resource-fork structure, so `parseSfnt` rejected one outright and `RegisterFontFolder` found nothing in a folder of them. Both work now, and a multi-face suitcase — the common Mac shape, with regular, bold and italic in one file — resolves each face separately through the same `{ weight, italic }` matching a folder of separate files gets. Two things made this smaller than it looked. A `.dfont` is a *data-fork* font: it keeps resource-fork-*format* bytes in the ordinary data fork, which is the whole reason the format exists, so there is no macOS-specific path handling anywhere. And a face needs no reassembly — each `sfnt` resource is a complete, self-consistent font whose table offsets are relative to its own start, so extraction is a view onto the bytes rather than a rebuild of the kind a `.ttc` needs. Detection is **structural**, because unlike every other container here a `.dfont` carries no signature at all: it opens with a raw offset, so the walk that finds the faces is the test that the file is one. That is what lets a classic suitcase which has lost its extension still be found, the same miss `l1my.4` closed for bare sfnt files. (`l1my.6`)

- **A Type 1 (`.pfb`/`.pfa`) font can be embedded, and found by family name** — `AddFont` was `parseSfnt`, which accepts sfnt, WOFF, WOFF2 and a `ttcf` collection and nothing else, so a Type 1 program could not be embedded at all; and because the folder index could not read one either, a `.pfb` in `/usr/share/fonts` — which several Linux distributions still ship — was invisible to `LoadFontByName`. Both work now. The conversion turned out to need no charstring transcoder: the interpreter this library already uses to render an *embedded* Type 1 produces outlines as M/L/C/Z cubics in glyph units, which is exactly the Type 2 charstring vocabulary, so the outlines are re-emitted as deltas and assembled into an OpenType-CFF font. That happens inside `parseSfnt`, before anything else sees the bytes — the same placement WOFF reconstruction and `.ttc` face extraction already use — which is why subsetting, `/FontFile3`, Identity-H emission, `/ToUnicode` and family-and-style matching all work with no special case anywhere. **Hinting is lost**, and deliberately: outlines carry none, and preserving them would mean implementing a second charstring grammar that differs from Type 2 in every stack-clearing operator. The cost is a little stem regularity at small sizes in some viewers; it is stated here because a caller comparing output against another producer would otherwise notice and wonder. Indexing stays cheap — a Type 1's cleartext header sits at the very start of the file, so finding one by name reads a prefix and touches no glyph data. (`l1my.5`)

- **A font folder scan no longer hides a font whose file name lacks an extension** — the walk filtered candidates by extension (`.ttf`, `.otf`, `.ttc`, `.otc`) before opening anything, so a font stored without one was invisible to the index even though the magic check would have accepted it: `LoadFontByName` reported the family absent, indistinguishable from "this machine has no such face". A font checked into a repo or unpacked from an archive routinely loses its extension, which made this a real miss rather than a theoretical one. Files with **no extension at all** are now opened and judged by their magic, at essentially no cost — a font directory holds essentially none of them, and one that is not a font costs a single partial read. A dotfile is deliberately *not* treated as extensionless (`.DS_Store` has its dot at index 0), so it stays skipped. For a font stored under some other extension entirely there is `RegisterFontFolder(dir, { sniff: true })`, which widens the scan to every file in the folder; it is opt-in because pointing that at a general asset folder opens every image and blob in it, which is exactly the cost the partial-read index exists to avoid, and `RegisterSystemFonts()` therefore never sniffs. `sniff` is sticky-on and does not move the folder: re-registering an already-held path with it upgrades that folder in place, keeping the documented guarantee that a helper registering on every call cannot perturb lookup order. (`l1my.4`)

- **A font can be asked for by weight and slant, with a family fallback chain** — `LoadFontByName` took a family name and nothing else, so a caller who wanted Roboto Bold had to know which file held it; the rule where a family had several faces was a tie-break preferring a plain one, which is a sensible default and no way to ask for anything else. It now takes `{ weight, italic }` and resolves them by the published [CSS Fonts 4 §5.2](https://www.w3.org/TR/css-fonts-4/#font-style-matching) rule — slant first, then the desired-weight walk — so a folder of nine Roboto weights is nine reachable faces rather than one. Citing §5.2 rather than inventing a rule matters here: the ordering it specifies is not the obvious one, and **slant outranks weight**, so asking for bold italic of a family holding Regular, Bold and Italic gives the **Italic** face, not the Bold one. `family` also accepts a list, which is a preference chain over **families**: the first name any indexed face belongs to wins outright and style matching then runs inside it, so `['Arial', 'Liberation Sans']` at weight 700 returns Arial Regular on a machine whose Arial ships upright only, and never consults Liberation Sans — a style detail must not silently override the order a caller stated. Degradation inside a family is silent, as it has to be, but `EmbeddedFont` exposes nothing about the face it holds, so **`ResolveFontByName`** is new beside it: the same selection, reporting the family, subfamily, derived weight and slant, path and face index it *would* load, plus whether the request was met exactly, without loading or embedding anything. Nothing new is read from disk for any of this — the folder index already recorded every field, so `l1my.1`'s partial-read cost model is untouched. The old prefer-a-plain-face tie-break is subsumed rather than replaced, being what resolving at weight 400 upright already does, and its tests carried over unedited as the fence for that claim. (`l1my.3`)

- **`LoadFontFamily` gives Markdown real emphasis from a system font** — `AddMarkdown` selects emphasis from a four-face family, and an embedded face derived nothing: bold and italic fell back to the regular face, so `**bold**` rendered identically to its surroundings and the document said something it did not mean. `doc.LoadFontFamily('Roboto')` returns the four faces in the shape `AddMarkdown({ style: { font } })` already takes. A slot is filled only when the chosen face actually plays that role and left absent otherwise, which is deliberate rather than incomplete: filling it with the regular face would give a one-weight family four faces that are one face, where an absent slot routes through the documented fallback and renders the same by a route a reader can follow. The bold slot is a bucket rather than an exact test, so a family shipping Semibold and no 700 has a bold face — it is the only heavier face there is — while resolving that family at 700 still reports `exact: false`, because the caller asked for 700 and did not get it. (`l1my.3`)

### Changed

- **BREAKING: the package is named `@asposefoss/pdf`** — it was `aspose-pdf-foss-for-typescript`, and every import specifier changes with it: `import { Document } from 'aspose-pdf-foss-for-typescript'` becomes `import { Document } from '@asposefoss/pdf'`. Nothing else moves. The public API, the entry point (`dist/index.js`), the type declarations and the module format are untouched, and no module under `src/` imports the library by its own name — the internal specifiers are all relative — so the rename reaches the manifest and the documentation and nothing else, which is why it lands with no code change and no test change. There has been no published release under either name, so nothing installed needs migrating; only checked-in source that spelled the old string does.

### Fixed

- **The built package resolved to a file that did not exist** — `package.json` declared `main: "dist/index.js"` and `types: "dist/index.d.ts"`, but `npm run build` compiled through `tsconfig.json`, whose `include` is `src`, `test` and `examples` with `rootDir: "."`. `tsc` therefore emitted `dist/src/index.js` and, alongside it, the whole compiled test suite and examples. Nothing in this repository noticed, because every test imports by relative path and never through the package entry — the defect was only ever reachable from an install. `npm run build` now goes through a new `src`-only `tsconfig.build.json` with `rootDir: "src"`, so the entry lands where `main` points, and a `clean` step precedes it so a stale `dist/src` cannot survive. `npm run typecheck` still uses the original config, which is what keeps the tests typechecked. Verified by packing the tarball, installing it into an empty project and round-tripping a document through the public entry point rather than by inspecting the output tree. (`j2qu`)

- **Removing an image now takes its whole placement group, not just the draw** — the cut walked back over `cm` and nothing else, so an image wrapped the way real producers actually write one — `q /GS0 gs 100 0 0 100 0 0 cm /Im0 Do Q`, or with a `re W n` clip — lost only its `Do`, leaving an inert `q /GS0 gs … cm Q` behind. Nothing rendered wrong, since the `Q` restores whatever the `q` set, but the leftover kept `/GS0` **referenced** — so `Remove({ sanitize: true })` could not prune an ExtGState that only the removed block had used, and the same residue accumulated through redaction. The walk now crosses any operator that marks nothing: graphics state, colour, and path construction and clipping. It is an allowlist, so an operator nobody has classified still stops the walk and degrades to the old behaviour, which is always safe; and every painting operator stays out, which is what makes the path ops safe to cross at all — `re W n` is taken with the group while `re f` is not, the terminator being the only difference. Marked content (`BDC`) also stops it, deliberately: cutting one changes what an optional-content group covers rather than leaving residue. (`5ttj`)

- **Inline (`BI…EI`) images render** — `page.ToImage` and `page.ToSvg` drew nothing at all for an inline image written with the abbreviated keys 32000-1 Table 93 mandates: `/W`, `/H`, `/CS`, `/BPC`. The interpreter wrapped the raw `BI` dict into a synthetic image stream and handed it to the backend, where every decoder reads full names — so the image decoded to nothing, drew nothing, and raised no error. Table 93 permits both spellings and the FULL one already worked, which is precisely why nothing caught it: two spellings of one construct behaved differently, and only the one real producers emit was broken. The normalizer that fixes it already existed for redaction (`inlineImageToStream`, expanding keys, colour-space names and filter abbreviations alike); it now lives in its own leaf so the renderer, the redactor and the inline-image editor share one reading of an inline dict rather than three. A side effect worth naming: `ConvertToGrayscale`'s pixel oracle documented that it could not see the inline-image pass, because no inline image rendered. It can now — measured by disabling that pass and watching the oracle redden — so the conversion gained end-to-end coverage it had been recorded as lacking. (`6dud`)

- **Exported images keep their transparency** — `ToSvg`, `Document.ToHtml`'s semantic mode, `ToMarkdown`, `ToDocx` and `ToEpub` all reach images through one encoder, and it had no alpha handling of any kind: not `/Mask` in either form, and not `/SMask` either. Every soft-masked or stencil-masked picture came out fully opaque — a cut-out logo arriving as a rectangle with its background filled in. `page.ToImage` has honoured `/SMask` all along, so the two renderers disagreed about the same document, silently and in opposite directions. The fix gives them one owner: `decodeImageRgba` moved out of the rasterizer into its own module, since three unrelated consumers want "image decoded to RGBA" and only one of them renders — reaching it through `raster.ts` would have made a Markdown export pull in the glyph outliner, the blend modes and a megabyte of bundled font outlines to produce a picture. A masked image is now encoded as an RGBA PNG. That means a **soft-masked JPEG changes media type**, because JPEG cannot carry alpha at all: it is re-encoded rather than passed through, and for a photograph the PNG is several times larger. Only images that were already wrong pay that — an unmasked JPEG still passes through as its original bytes, so no existing export's output moves by a single byte. (`2pgr`)

- **A masked image no longer renders opaque** — `page.ToImage` honoured `/SMask` and `/ImageMask` but ignored the `/Mask` entry in **both** of its legal forms, so every image masked by a colour key or by a stencil rendered with its masked-out pixels fully painted. Transparency is now a three-step fallback: `/SMask`, then a stencil `/Mask` stream, then a colour-key `/Mask` array. Only one form of `/Mask` can be present, since they are one entry, and `/SMask` outranks both — it is the richer mask and 32000-1 makes the two mutually exclusive anyway. A stencil is read with `/ImageMask`'s own polarity, sample 0 painting under the default `/Decode [0 1]`, and its `/Decode [1 0]` is honoured: ignoring that renders the precise negative of the intended transparency, which looks deliberate rather than broken. The colour-key rule moved to a leaf shared with the grayscale converter, so a greyed document cannot mask differently from the original — which is now asserted directly, by keying an image, converting it to grayscale, and checking the same pixels stay masked afterwards. That round trip is what `10u9.7`'s conversion could never show, since nothing rendered either form. It reaches `ToImage` and the raster backdrops behind `Document.ToHtml({ backdrop: 'raster' | 'page' })` and `ToDocx({ mode: 'textbox' })`. **`ToSvg` is unaffected and still drops the mask**, along with `/SMask`: its images go through a separate path that has no alpha handling at all, tracked as its own defect. (`10u9.12`)

- **A real progressive JPEG now opens at all** — `decodeScan` looked up both Huffman table classes for every scan component *before* reading the scan's `Ss`/`Se` spectral selection, so it could not yet know which class that scan referenced, and threw `JPEG: missing Huffman table` when either was absent. A progressive scan codes either the DC coefficient or a band of AC coefficients, never both, and T.81 G.1.1.1 lets it name a table it does not use — so a producer is free not to have sent that table yet. mozjpeg, libjpeg and every other real encoder open a progressive file with a DC-only scan and transmit the AC tables afterwards, which means **every** progressive JPEG was refused at its very first scan. It bit `page.ToImage`, `ToSvg`, image extraction, TIFF input and grayscale conversion alike, and the file simply failed to decode rather than decoding wrongly. Sequential frames still require both classes, which is what they always reference, so nothing else moves. Nothing caught it because the suite's only progressive coverage was a stream our own test helper built, and a helper declares every table up front — the shared-convention class that `test/fixtures/` exists for. Found on the first run of `test/fixtures/jpeg/testorig-prog.jpg`, added in the same change from libjpeg-turbo's own `testorig.ppm`. (`10u9.6`)

- **A JPEG whose components are already RGB is no longer colour-mangled** — a three-component JPEG carrying SOF component ids `'R'`, `'G'`, `'B'` (82/71/66) and no Adobe APP14 marker is already RGB, and `decodeJpeg` was applying the YCbCr inverse transform to it anyway. The result was not subtly off: red and blue decoded pinned near zero, so the picture arrived as a green wash. The test is libjpeg's own — `jpeg_default_colorspace` reads those ids the same way — and an Adobe marker still outranks them, since that states the producer's intent explicitly. It bites any `DCTDecode` image written that way, so it reached `page.ToImage`, `ToSvg` and image extraction as well as TIFF input. Found by the real-producer TIFF fixtures added in the same change, on their first run: libtiff writes exactly this shape for a JPEG-compressed TIFF whose photometric is RGB, and nothing built by our own test helpers ever does — which is the entire reason that fixture class exists. (`10u9.9`)

### Added

- **A face can be taken from a `.ttc`/`.otc` collection** — `AddFont`/`AddFontFile` accept a collection with `{ faceIndex }` (default 0), and `LoadFontByName` finds each of its families by name. Collections were skipped whole before, so a machine whose only copy of a family lived in one reported it absent — which on macOS is most of the system faces. The design decision that matters is invisible from outside: a face is **extracted into a standalone sfnt** rather than read where it lies. A collection's per-face table directories already hold absolute file offsets, and `SfntFont` resolves tables by absolute offset into its own bytes, so pointing a face at the collection decodes perfectly in about five lines — and would mean the CFF whole-embed fallback put *every face of a 40 MB system collection* into the PDF as one OpenType program. Extracting costs a copy of one face's tables and keeps collections invisible to subsetting, embedding, cmap and glyph access alike. Indexing still reads collections **in place**, face by face, so the partial-read cost model survives: extraction happens only when a face is actually loaded. (`l1my.2`)

- **A font can be loaded by family name** — `doc.RegisterFontFolder(dir)` and `doc.LoadFontByName('Liberation Sans')`, with `doc.RegisterSystemFonts()` adding the platform's own font directories. Until now `AddFont` took font **bytes** and nothing else, so a caller who wanted a named face had to locate and read the file themselves. Matching is exact, case-insensitive and whitespace-trimmed, against the typographic family (name ID 16) where a font states one and the family (ID 1) otherwise; where several faces share a family, one that is neither bold nor italic wins, then registration and directory order. That last rule is a **tie-break, not style selection** — choosing between weights on request is a separate piece of work — so `LoadFontByName('Arial')` will not hand back Arial Bold. Two decisions are worth knowing because a caller would otherwise meet them by surprise. The system directories are **opt-in**: searching them by default would let one program build different documents on different machines, and the failure would surface at `Save` as a missing face rather than at the call. And a miss returns **`undefined`** rather than throwing or quietly substituting a Standard-14 face, because "this machine has no Arial" is an ordinary outcome and a silent substitution renders the document in metrics and glyphs the caller never chose. Nothing here throws: an unreadable file, a malformed font, a `.ttc` collection and a registered folder that does not exist are all skipped. Underneath, folders are indexed lazily on first lookup and cached for the process, and each candidate is read **partially** — header, table directory, then only the `name`/`head`/`OS/2` byte ranges — because a system font folder holds thousands of faces and reading whole files would turn one lookup into hundreds of megabytes of I/O. Requesting one family twice returns the same handle, so the font is embedded once however often it is drawn. `.ttc` collections are not yet read. (`l1my.1`)

- **`ConvertToGrayscale` converts a colour-key `/Mask` instead of refusing the image** — the last construct the pass reported in `skipped`. The refusal was well-founded: a colour key states a range per colour component, two colours can share a luma, and (255,0,0) and (0,130,0) both grey to 76 — so any grey range covering the first also covers the second, and a re-derived mask hides pixels the original never touched. The way out is that the range never had to be re-derived. `/Mask` is defined as *either* a colour-key array *or* a stencil-mask image, so the conversion records **which pixels the key actually matched** as a 1-bit stencil, in the same entry: exact, one bit per pixel, and immune to the collision by construction. An **Indexed** image needs no conversion at all and is now simply passed through — 32000-1 8.9.6.4 keys raw pre-Decode samples, which for Indexed are index values, and the palette route leaves every index byte untouched, so the array stays correct as written. A masked JPEG keeps the exact coefficient route and pays one extra decode for the stencil, rather than being demoted to the re-encode. Still skipped, and now for the only reason left: an image carrying a colour-key `/Mask` *and* an `/SMask`, which 32000-1 makes mutually exclusive — converting one and leaving the other yields a file no two viewers agree about. Note our own renderer honours neither form of `/Mask` and never has, so `ToImage` and `ToSvg` show no change; that gap is tracked separately (`10u9.12`). (`10u9.7`)

- **`ConvertToGrayscale` greys a YCbCr JPEG exactly, in the coefficient domain** — a baseline JPEG's Y channel *is* Rec. 601 luma, so decoding one to RGB, computing luma per pixel and re-encoding was re-deriving, lossily, a number the file already held exactly. The new route keeps component 0's quantized coefficients and its quantization table verbatim, drops the two chroma components, and re-emits a one-component baseline JPEG: no IDCT, no FDCT, no requantization, no generation loss, and a smaller file. It reports as `route: 'jpeg-exact'` and does **not** set `report.lossy`, so a document whose images are ordinary photographs now converts losslessly where it previously could not. Progressive and arithmetic inputs take it too — they normalize into the same coefficient array — which turns the shapes that suffered most under the old route into the ones that gain most, and normalizes them to baseline on the way out. What it declines falls through to the unchanged sample route rather than being reported in `skipped`, because the image converts either way and `route` is what says how: CMYK and YCCK (component 0 is cyan, not luma), 12-bit precision, lossless and hierarchical JPEGs (no DCT coefficients at all), and — the sharp one — any three-component file whose colour transform is 0. That last case is a JPEG whose SOF component ids are `'R'`, `'G'`, `'B'`, which libtiff writes for a JPEG-compressed RGB TIFF: its component 0 is **red**, and greying by keeping it would emit the red channel as luma, a plausible-looking photograph that is entirely wrong with nothing anywhere to flag it. The rule deciding that has one owner, shared with the decoder, rather than a second copy that could drift. Underneath, `encodeJpeg`'s entropy coder and marker assembly moved into `jpegcoef.ts` so both producers share one, fenced by a sha256 identity test recorded before the extraction — measured necessary, since reordering the DHT writes leaves every existing pixel-asserting JPEG test green. `opts.quality` still governs the fallback and has no meaning on the exact route. Note the exact route's output is not byte-identical to the old one for the same image: `YCbCr → RGB → luma` round-trips through two clampings and lands within about ±1 of the Y plane, and the coefficient path is the more faithful of the two. (`10u9.6`)

- **`ConvertToGrayscale` now greys a function-less mesh shading instead of reporting it** — shading types 4 through 7 with no `/Function` were the one construct the pass named in `skipped` and left in colour, because a mesh states its colour nowhere a `/Function` can be substituted: it is bit-packed per vertex in the shading's own stream data, at `/BitsPerComponent` bits per component, with the ranges those integers decode against in `/Decode`. Greying one therefore means rewriting the stream. The splice re-emits every record with its colour tuple collapsed to a single component, and copies the coordinates as **raw bit patterns** rather than through a float, so the geometry of the output is bit-identical to the input's — a mesh that is re-spliced and re-spliced again cannot drift. The two encodings that are easy to conflate are handled apart, since each renders as a plausible mesh when read as the other: 32000-1 pads every type 4 vertex to a byte boundary while a type 5 lattice runs continuously, and a type 6/7 patch whose flag is non-zero shares an edge with its predecessor, so four of its control points and two of its four corner colours are simply absent from the record. Components are decoded through their own `/Decode` range before greying rather than passed on as raw integers, which is invisible for a DeviceRGB mesh and wrong for every Lab or Indexed one. Data that ends mid-record is refused and still reported in `skipped`, rather than emitting a short mesh whose last triangle is missing. `/Decode`'s coordinate half survives untouched and its colour half becomes the one grey range. (`10u9.5`)

- **Inline (`BI…EI`) images can be enumerated and removed** — `page.InlineImages` returns a handle per inline image in content order, descending into Form XObjects, and each can `Remove()` itself. An inline image lives in no object: no `/XObject` entry, no resource name, its samples in the content operator itself — which is why `page.Images` has never seen one and why `ImageInfo` cannot represent one. The handle is addressed by its position in the content stream instead. It reads through the same accessors an image XObject does (`Width`, `ColorSpace`, `Filter`, `Decode()`), over a dict whose abbreviated keys *and* filter names are expanded, so an inline image and an XObject no longer report `AHx` against `ASCIIHexDecode` for the same thing. `Remove()` takes exactly one draw — an inline image *is* one draw, so the XObject rule of removing every draw of a resource key has no counterpart here — together with its enclosing `q … cm … Q` group, and prunes nothing from `/Resources`, there being no entry to prune. The sharp edge is handled rather than documented away: removing one image shifts the operator indices of every later one, so a handle taken before a removal is verified against the image it was made from and throws `RangeError` if it no longer matches. Without that a `forEach` over the collection would quietly destroy the wrong pictures on a page that still looked plausible. Replacing an inline image is deliberately not offered — re-encoding one means choosing abbreviated filter and colour-space spellings, which is its own decision. (`10u9.10`)

- **An embedded image can be replaced or removed** — `ImageInfo.Replace(data)` swaps the picture for JPEG, PNG, BMP or TIFF bytes while keeping the placement, and `ImageInfo.Remove()` drops the image from the page: every draw of it in the page's content and in the Form XObjects the page descends into, plus its `/XObject` resource entry. Until now an image could be enumerated and read but the only way to get rid of one was to redact a rectangle over it, and there was no way at all to swap one picture for another. Both are **scoped to the page the handle came from**, which is what `page.Images` already means: an image shared with another page is copied rather than mutated on replace, and survives removal from one page while another still draws it — so a handle obtained from one page never silently edits a page the caller was not looking at. That is the one place this deliberately diverges from the Go implementation, which mutates the stream in place; the copy costs nothing that reaches disk, since an unshared old object is orphaned and swept by `Save()`. The new image is stretched into the existing footprint whatever its proportions, because the `cm` that sizes an image lives in the content stream — the caller asked to change the picture, not the layout. `Replace` builds and validates the new XObject **before** touching anything, so a rejected call leaves the document byte-identical, and it builds the image dict fresh rather than patching the old one: replacing an alpha PNG with an opaque JPEG must not leave the previous `/SMask` behind, which would show the new picture through a stencil cut for the old one. `/OC` is the one entry carried over, because optional-content membership describes the slot rather than the samples. Removal takes the enclosing `q … cm … Do … Q` group rather than the `Do` alone, through the same `imageCutSet` redaction uses — now in `content.ts` so there is one owner of that rule — and `Remove({ sanitize: true })` escalates to redaction's full prune of now-unreferenced `/Font`, `/XObject` and `/ExtGState` names. That flag changes which `/Resources` entries survive, never which objects reach the file, since `Save()` sweeps orphans either way. Inline `BI…EI` images carry no `/XObject` entry, so no handle for one exists and the refusal is structural rather than a check; redact their rectangle instead. (`10u9.4`)

- **`AddImage` accepts TIFF** — everywhere an image goes in, as BMP is. Nearly every codec TIFF needs was already here and separately tested — `decodeCcitt` for G3/G4, `lzwDecode`, `applyPredictor` (whose TIFF predictor 2 was already implemented), `runLengthDecode` (PDF's RunLengthDecode *is* PackBits), `decodeJpeg` and `node:zlib` — so what this adds is the container: byte order, the IFD chain, and strip/tile assembly. Covered: both byte orders, strips and tiles, compression 1/2/3/4/5/7/8/32946/32773, photometric WhiteIsZero, BlackIsZero, RGB, Palette and CMYK, `FillOrder` 1 and 2, predictor 1 and 2, associated and unassociated alpha, and multi-image files through `opts.page`, with `tiffPageCount` exported to give the bound — `page` throws rather than being silently ignored for a format that has no pages. A single-strip JPEG with no shared tables is passed through as `DCTDecode` with no re-encode, which is also why YCbCr works on that route while the raw-sample routes refuse it: a JPEG carries its own colour transform. This is also where `10u9.2`'s `BmpImage` became `RasterImage` in its own leaf — the generalization that issue deliberately deferred until a second caller existed — so `buildRasterXObject` is now the one owner of "which PDF colour space is this" for every image input format. Three rules are implemented against their failure modes, each of which decodes into something plausible rather than failing: `RowsPerStrip` defaults to 2³²−1, meaning the whole image is one strip; a partial edge *tile* still holds a full tile of data where a final *strip* is genuinely short; and associated alpha is premultiplied and must be divided out, or `/SMask` multiplies it in twice and the image renders darkest exactly where it is most transparent. Recorded honestly: unlike BMP, TIFF has no published hex dump to anchor against, so the container is builder-anchored, mitigated by an `II`-versus-`MM` differential that a shared builder bug cannot fake. (`10u9.3`)

- **`AddImage` accepts BMP** — Windows bitmaps alongside JPEG and PNG, everywhere an image goes in: `page.AddImage`, `flow.AddImage`, `cell.setImage`, a floating box, a signature appearance. BMP is not a PDF construct — there is no `BMPDecode` filter — so a bitmap is decoded to samples at embed time and stored as `FlateDecode`, and the saved file carries no trace of having been one. The decoder is a pure module whose only repo import is the error vocabulary, so every bit depth, mask rule and RLE escape is testable from raw bytes with no document in sight. A palette image keeps its indices as `/Indexed` rather than expanding to RGB: lossless, smaller by up to 24×, and the only route that works at 1, 2 and 4 bits per component, where the samples are still packed several pixels to a byte — the rule `10u9.1` established for greying an Indexed image by rewriting its palette alone. Covered: `BITMAPCOREHEADER` through `BITMAPV5HEADER` including OS/2 v2, 1/2/4/8-bit palettes, 16-bit RGB555 and `BI_BITFIELDS`, 24-bit, 32-bit BGRX and BGRA, RLE4 and RLE8, both row orders, and a `BI_JPEG`/`BI_PNG` payload sliced out and handed to the existing builders. The decision that will look like a bug and is not: the fourth byte of a 32-bpp pixel becomes an `/SMask` only when the header *declares* alpha, because that padding is very commonly zero across a whole image and honouring it unconditionally yields a picture that is drawn, structurally correct and completely invisible. Anchored on two published hex dumps transcribed as byte literals rather than on fixtures we generated, since for a format we only ever read our builder and our decoder could otherwise agree on a misreading with nothing to contradict them. (`10u9.2`)

- **A document can be converted to grayscale** — `doc.ConvertToGrayscale(opts?)`, across page content, form XObjects, tiling patterns, Type 3 glyph procedures, image XObjects, inline images, shadings and annotations. The design decision that shapes everything else is to *neutralize colour operators* rather than retarget colour spaces: every `rg`/`k`/`sc`/`scn` becomes `g`/`G` carrying the Rec. 601 luma of the colour it set, `cs` becomes `/DeviceGray`, and the named `/ColorSpace` resources are left unreferenced for `Optimize`'s `dr` pass to collect. Retargeting was rejected because it multiplies the ways to be half-wrong — a colour space shared between an image that converts and one that cannot (a colour-key `/Mask`, a JPX we will not re-encode) leaves the document self-inconsistent, and Indexed palettes would have to be rewritten in lockstep with every referencing image. Neutralization also buys the property the implementation rests on: the content pass **reads** colour-space resources that no pass **writes**, so the object-level and content-level passes run in either order. Everything non-device reaches the one greying rule through `resolveColorSpace`, the same owner `paths.ts` and glyph colour already use, which is why ICCBased, Indexed, Separation, DeviceN, CalRGB and Lab need no cases of their own. Rec. 601 rather than Rec. 709 because it is what Ghostscript and the rest of the PDF tooling emit — a document converted here matches the same document converted elsewhere — and because it is exactly JPEG's Y channel, which keeps a coefficient-domain route open later. Images take the cheapest faithful route: an **Indexed** image greys by rewriting its palette alone, leaving sample data byte-identical, which is lossless, smaller, and the only route that works at 1, 2 and 4 bits per component, where a decode hands samples back still packed; a **JPEG** re-encodes as a grey JPEG (`quality`, default 90) and sets `report.lossy`; other decodable samples become grey Flate, JPX included, which usually grows and says so through `bytesDelta`. Shading functions convert exactly where exactness is free — type 2 through `/C0`/`/C1`, type 3 by recursion — and are resampled into a one-output sampled function otherwise; a `/Function` that is an *array* of one-output functions is joined rather than recursed into, and a type 1 shading's two-input function is sampled on a grid, a distinction that otherwise yields a flat grey wash nobody inspects closely. What cannot convert is reported in `skipped` with a reason rather than silently left in colour: a colour-key `/Mask`, where two colours sharing a luma mean an RGB range is not a grey range; a `/Decode` array; a filtered inline image. An annotation's `/C`, `/IC`, `/MK` and `/DA` convert too, with `/DA` going through the *content* rewriter rather than `parseDA`, which would drop every operator it does not recognise; an empty `/C` stays empty, since it means "no colour" and collapsing it would paint a border the document never asked for. Throws `UnsupportedFeatureError` on a signed document, which converting would invalidate. (`10u9.1`)

- **The document's open behaviour and its JavaScript are authorable** — `doc.SetOpenDestination` / `doc.SetOpenAction` / `doc.GetOpenAction` / `doc.RemoveOpenAction` for the catalog `/OpenAction`, and `doc.SetJavaScript` / `doc.GetJavaScripts` / `doc.RemoveJavaScript` for the `/Names /JavaScript` tree. The gap ran one way through the whole stack, as this epic's three previous children did: `pdfavalidate.ts` reports both constructs, `pdfaconvert.ts` and `pdfxconvert.ts` *remove* both as prohibited, and `actions.ts` already modelled a JavaScript action with one encoder and one parser — so `ConvertToPdfA` could confidently report having removed a thing no caller could add. Two writers rather than one, because 32000-1 table 28 permits `/OpenAction` to be a destination **or** an action and the two are not interchangeable; a single sniffing entry point would have had to guess which a caller meant. Reading turns on one rule that is silently wrong when wrong: the discriminator is `/S` and nothing else, since `decodeDest` already accepts a `<< /D [...] >>` destination dict and a GoTo action carries `/D` too — mis-read, it still **decodes**, reporting the right page under the wrong `kind`, which is why the two dict shapes are asserted side by side on `kind` alone. Underneath, the name-tree upsert and its two-level prune became `nametree.ts` with one owner: the body existed verbatim twice already — `document.ts` for `/Dests`, `embeddedfile.ts` for `/EmbeddedFiles` — and `/JavaScript` would have been the third copy of a pruning rule whose failure mode is a stray `<< /Names << >> >>` in an unrelated feature's output. Only the tree half is shared; the legacy `/Dests` cleanup and the `/AF` registration stay with their callers, because they are not the same step. Document-level JavaScript is stored, never interpreted. (`lucg.4`)

- **Reusable templates** — `doc.NewTemplate(w, h)` plus `PlaceOn`, so a letterhead or a logo block is drawn once and stored once however many pages carry it. This library builds Form XObjects in eight places — `compose.ts` for `StampWith`/`Overlay`/`NUp`, seven in `svgdraw.ts`, plus field appearances and soft-mask groups — and exposed no way for a caller to author one. The shape that made it cheap: a template's `page` is a real `Page` over a dict that is **never allocated and never linked into the page tree**, so `AddText`, `AddImage`, `AddTable`, `Graphics()` and `AddSVGObject` all work on it unchanged and the feature needed no content-target refactor — the counterpart of the resource-target seam tiling patterns required. An unplaced template therefore costs nothing in the saved file, not because a sweep removes it but because there was never an object to sweep. The first `PlaceOn` converts contents plus resources into the form and **freezes** the template; drawing into it afterwards throws, because silently ignoring the edit reads as the drawing call being broken. A caller who stashed the page reference before placing defeats that getter, so the build records the content length and a later placement refuses a stale one — measured, the two guards redden disjoint cases. Placement takes `fit` (`'stretch'`/`'contain'`), `opacity`, `rotation` about the rect's origin as `AddText` takes, and the usual `tag`/`alt`/`artifact` marking. Underneath, the uniform-fit arithmetic that N-up had inlined became `containMatrix` in `text.ts` with one owner — and the case that pins it was written **first**, because the existing N-up suite could not: its scale-to-fit test puts a 200x100 source into a 200x100 cell, where the scale is 1 and the centring offset is 0, so a per-axis stretch produces identical numbers there and reddens the new case alone. Logical structure inside a template is not supported and is documented rather than detected. (`lucg.3`)

- **Tiling patterns can be authored** — `doc.NewTilingPattern(w, h, draw, opts?)` plus `setFillPattern`/`setStrokePattern`, closing a gap that ran one way through the whole stack: `svgdraw.ts` has always *built* a `PatternType 1` dict for SVG import, both renderers read one (colored and uncolored alike), and `glyphusage.ts`/`imageusage.ts` scan them — while `graphics.ts` could register a shading pattern and nothing else. The tile is painted by a callback into a builder scoped to tile space, so every existing vector primitive works inside it unchanged. Options are `xStep`/`yStep` (defaulting to the tile size, so larger leaves gaps and smaller overlaps) and `x`/`y`/`rotation` to place the lattice, which is pinned to the page's default user space and ignores the CTM exactly as a gradient's ramp is — a `transform()` moves the shape, not the tiling. `{ uncolored: true }` emits a `PaintType 2` tile carrying shape only, so one hatch serves every colour. Two decisions are worth naming. Colored and uncolored are **distinct types**, so the overloads make the colour argument required exactly when it is needed and rejected when it is not; a single optional argument would have been required half the time and silently ignored the other half. And an uncolored tile **throws** on colour operators rather than emitting bytes a viewer ignores — a silent no-op there reads as a rendering bug rather than a mistake. Underneath, `pagecontent.ts`'s four `register*` helpers gained resource-target variants so a registration inside a tile lands in the tile's own `/Resources`, and `PageGraphics` split into a `VectorGraphics` base plus the page-bound half: a tile callback holds the base, which has no `apply()`, so a tile builder cannot splice itself into a page. That refactor claimed byte-identity for existing callers and **nothing in the suite checked it**, which is why `test/graphics-identity.test.ts` was written and recorded first. (`lucg.2`)

- **Authored tables span rows** — `addCell(text, { rowSpan })` beside the `colSpan` the table has had since it shipped, closing a gap that ran one way through the whole stack: `structattr.ts` already encoded `/RowSpan`, and `tablegrid.ts`, `tablestruct.ts`, `tablemodel.ts` and `docxtable.ts` already read it, so a tagged PDF carrying a vertical span extracted correctly and could not be re-authored. Rows below a spanning cell omit the covered cells, as HTML does. What made this one piece of work rather than three is that the horizontal cursor walk existed in **three copies** — `contentWidths`, `measure` and `placeRows` — each with its own idea of which column a cell landed in; they are now reads of one pure occupancy grid (`tablespan.ts`), which is also exactly what a disagreement between measuring and painting would have looked like. Four decisions here are ones a plausible-looking wrong implementation still satisfies, so each is fenced by a case that reddens alone. A spanning cell's height shortfall goes entirely to the **last** row it covers, never spread across them, or a plain cell ends up floated in a box taller than its own content asked for. Overlapping spans are visited in order of **last covered row**, because satisfying the earlier-ending one first lets the longer one measure against the already-enlarged rows — reversed, the two each allocate the same height, measured as 30pt of over-allocation on a three-row fixture. A `rowSpan` group is **atomic** across a page or column break: both pagination loops back off to the last cut that slices no span, and a group taller than the page falls through to the same draw-it-anyway path an oversized row already takes, introducing no new error. And both clamps — to the table's last row, and to the repeating-header block a continuation reprints — are silent but *observable*, because `/RowSpan` states the clamped value rather than the requested one. One thing found by mutation rather than reasoning, and recorded in the test: the column count moving from the widest row's `Σ colSpan` to the grid's `max(col + colSpan)` is **not** pinned by a row whose columns are all inherited, since the count is a max over rows and the row above already supplies it — what pins it is a cell *pushed right* by an inherited span. `AutoTag` still writes no `RowSpan`: inferring one from geometry is a question about the detectors, not about the authoring model. (`lucg.1`)

- **JBIG2 Huffman-coded text regions decode, completing T.88's coding features** — `SBHUFF` no longer throws, and with it a Huffman symbol dictionary's aggregate symbol, which §6.5.8.2.1 decodes *as* a Huffman text region. Every coding feature ITU-T T.88 defines now decodes: generic, symbol-dictionary, text, refinement and halftone regions, arithmetic and MMR and Huffman alike. What remains is a segment type T.88 does not assign (`UnsupportedFeatureError`) and the `0xffffffff` unknown segment data length (`PdfParseError`), which was always out of scope as a container-organization limit rather than a coding one — and the refusal fence now *asserts* that by sweeping every assigned type rather than restating it in prose. Two pieces made it work. The **symbol-ID code table** (§7.4.3.1.7) runs for every Huffman region and has no simpler fallback: 35 four-bit runcode lengths, a runcode table, one code length per symbol decoded through it, then an align — where runcode 32 repeats the *previous* symbol's length while 33 and 34 repeat zero, a distinction that shifts every later symbol ID by a code if confused. And **refinement alternates entropy coders within one stream** (§6.4.11): RSIZE is read with a Huffman table, the reader aligns, an MQ decoder runs over exactly those bytes, and Huffman reading resumes after them, because T.88 defines no MMR refinement. Throughout, there is still one strip walk and one height-class walk with the entropy source injected — CURT and RI, which have no table selectors and are read as raw bits, are absent from the table type entirely so the mistake cannot be made. (`utax.7`)

- **JBIG2 Huffman-coded symbol dictionaries decode** — `SDHUFF` no longer throws. A Huffman dictionary does not decode a bitmap per symbol: it decodes the widths of a whole height class, reads `BMSIZE`, aligns, takes **one** bitmap for the entire class — MMR-coded, or stored uncompressed with each row padded to a byte when `BMSIZE` is 0 — and slices it by the widths already read (T.88 §6.5.9). Getting there introduced the seam the rest of this work has been building toward: `IntSource`, so the symbol dictionary and the text region read *"decode DH using SDHUFFDH or IADH"* as one call. There is now **one** height-class walk and **one** strip walk with the entropy source injected, rather than a copy of each per stack — the duplication that, in the Go implementation this tracks, is what lets the two paths disagree about a document. The refactor is byte-identical on the arithmetic path, which every existing vector pins. It also settled a question left open earlier: an aggregate text region inside a dictionary now shares that dictionary's arithmetic statistics per §6.5.8.2.1, and a fixture mixing the two REFAGG paths exists for it — the only shape that can observe the difference. Huffman-coded **text regions** still throw, and with them a Huffman aggregate of more than one instance, which is decoded as one. (`utax.2`)

- **JBIG2 custom Huffman table segments no longer refuse** — a segment of type 53 (ITU-T T.88 §B.2.3) is parsed and stored instead of throwing, so a file carrying one alongside otherwise-arithmetic content decodes rather than failing outright. **Huffman-*coded* symbol dictionaries and text regions still throw**; this is the table machinery underneath them, not the feature. What landed with it is the rest of that machinery: the MSB-first bit reader, T.88 B.3's canonical code assignment, and the fifteen standard tables B.1–B.15. Those tables are ~150 rows of hand-copied numbers and nothing consumes them yet, which is a bad combination, so they carry three checks that provably do not overlap: Annex B prints the assigned prefix **codes** as well as their lengths, so the two are transcribed as separate columns and asserted against each other; every table must be a complete prefix code (Kraft equality); and its lines must tile the integers with no gap or overlap. Measured by mutating the data — a wrong prefix length reddens the first two, a wrong range low reddens only the third, and reordering two same-length lines reddens only the first. (`utax.6`)

- **JBIG2 halftone regions and pattern dictionaries decode** — segment types 16 and 20/22/23 (ITU-T T.88 §6.7, §6.6 and Annex C.5) no longer throw, arithmetic and MMR alike, including HENABLESKIP. This is the one JBIG2 construct that is not a bilevel decode: a halftone region decodes a *grayscale* image — `ceil(log2(HNUMPATS))` bitplanes, each an ordinary generic region, Gray-coded and most-significant plane first — and stamps the pattern each grid cell's value names. **Three rules here are invisible to a round trip through our own encoder, and two of them are published transforms, so for the first time in this epic there is outside evidence available and it costs no bitstream.** The Gray fold is anchored on the published sequence (`00 01 11 10` naming `0 1 2 3`), hand-computed with a three-plane case so it is a chain rather than one XOR. The grid geometry is anchored on arithmetic over known inputs with one vector zeroed at a time: transposing HRX and HRY renders the screen *rotated*, which reads as an unusual halftone rather than as a decode fault, and no single grid could pin both cross terms — the round-trip fixture deliberately uses an exactly-tiling grid and cannot see them at all. The third, HENABLESKIP, has no anchor and is proved only by mutation: a skipped pixel is set to 0 **without being decoded**, so implementing it as a post-filter over a finished plane desynchronises the bitstream from the first skipped pixel onward; measured, moving the test out of the decode loop reddens the skip vector and leaves the plain one green. Under HMMR the bitplanes are not separate streams but one MMR datastream with an EOFB between them, which is what `ccitt.ts`'s new `decodeCcittConsumed` reports the byte count for — the only change this work makes outside `src/jbig2*.ts`, and `decodeCcitt` is now a wrapper over it so the two cannot drift. Huffman coding is the last JBIG2 feature still refused. (`utax.1`)

- **JBIG2 refinement inside symbol dictionaries and text regions** — a text region with SBREFINE (T.88 §6.4.11) and a symbol dictionary with REFAGG (§6.5.8.2) both decode, the latter at `REFAGGNINST` of 1 *and* greater. That completes refinement: the one `decodeRefinement` procedure now serves all three callers T.88 gives it, which is why it was built taking its reference and offset as arguments. An aggregate of more than one instance is decoded as a text region over the dictionary's own symbols, sharing its arithmetic stream and its integer contexts. **The two offset rules are deliberately different** — a text region offsets by `(RDW >> 1) + RDX`, re-centring the grown bitmap, while a single-instance dictionary aggregate offsets by RDX/RDY plain, because there the refined symbol's size comes from the height class rather than from a decoded delta; using one rule for both is a small uniform misplacement that reads as bad rendering rather than as a decode fault. Only Huffman-coded JBIG2, the pattern dictionary and the halftone region still refuse. (`utax.5`)

- **JBIG2 generic refinement regions decode** — segment types 40, 42 and 43 (ITU-T T.88 §6.3) no longer throw. Both templates are supported, with their adaptive-template pixels and TPGRON typical prediction, in a new leaf module that is pure over a bitmap and the MQ decoder — it takes the reference and its offset as arguments, so the one procedure will also serve the symbol-dictionary and text-region callers when those land. A refinement whose referred-to set names an intermediate region refines that buffer and composites the result with the segment's combination operator; one that names none refines **the page itself** and *replaces* the pixels under its rectangle, per §7.4.7.2 — the combination operator does not apply there, and OR-ing instead would render as a slightly bold page rather than as a fault, so the fixture's target clears pixels the reference had set. Refinement *within* a symbol dictionary (REFAGG) or a text region (SBREFINE) still refuses by name; that is the next child. The context bit order is anchored on T.88's published SLTP constants rather than on our own encoder, because a round trip provably cannot see a bit-order error — a reordering is a bijective relabelling of context bins, so the MQ state machine is identical and the output byte-for-byte the same; measured, sorting the adaptive pixels the way the generic-region template does leaves every round-trip vector green. (`utax.3`)

- **EPUB chapter splitting and a navigation TOC** — `doc.ToEpub()` now emits one content document per chapter instead of one for the whole book, and a navigation document listing them in spine order. The split level is *derived* rather than fixed at `H1`: it is the shallowest heading level the document actually contains, because our own extraction routinely produces H2-rooted documents and a fixed rule would leave those as one long chapter — the very defect this fixes. Content before the first heading is kept as a leading chapter rather than dropped, and a document with no headings stays a single chapter, so the spine and the nav are never empty. The splitter descends through a lone `/Sect` or `/Document` wrapper before looking for headings and re-wraps each chapter in it, which is what makes this work at all on tagged PDFs: both tagged paths bury everything one level down, so a top-level-only split would have failed silently on exactly the documents with the best structure. Sub-headings stay inside their chapter — a nested TOC would need an `id` on every heading in the shared HTML serializer, moving that export's output for a second time. (`zwto.2`)

- **PDF to EPUB export** — `doc.ToEpub(options?)` writes a valid EPUB 3 archive over the same neutral model the HTML, Markdown and DOCX exports read: an OCF container, an OPF package document, a navigation document, one XHTML content document, and each distinct image as its own part. The `mimetype` entry is stored and first, which is what lets a reader identify the file at byte 38 without inflating anything — the one rule a "are all the parts present" test cannot see, so it is asserted on the raw archive bytes and both halves were confirmed by mutation. `dc:identifier` resolves from an option, then the PDF's own trailer `/ID`, then a hash of the content, every branch deterministic, so two exports of one input are byte-identical; `dc:language` defaults to `und` rather than `en`, because a missing language makes the file invalid but claiming English would state a fact the PDF never did. Getting there made the HTML serializer emit XHTML-compatible markup — self-closed `<img>`, `<br>` and `<input>`, and spelled-out boolean attributes — unconditionally rather than behind a flag, since that spelling is valid HTML5 too and one dialect cannot drift between the two exports. Structural conformance to EPUB 3 is tested; as with Word and the DOCX export, no CI here can open a reader. This shipped as a single content document; chapter splitting followed immediately in `zwto.2`, above. (`zwto.1`)

- **HTML fixed mode: raster backdrops** — `ToHtml({ mode: 'fixed' })` gains `backdrop: 'vector' | 'raster' | 'page'` (default `'vector'`, today's inline SVG) plus `backdropScale` (default 2, a multiplier on the 72-DPI point size). `'raster'` draws the page's graphics as a PNG with **no glyphs in it** and keeps real, styled, selectable text spans over it; `'page'` rasterizes the whole page — glyphs included — and turns the text layer transparent, so it stays selectable and findable over a pixel-exact backdrop. A raster is exact by construction for the constructs SVG cannot express (a non-isolated group that blends internally, knockout groups, JBIG2, all recorded in the README) and bounds output size for a graphics-heavy page. The text treatment follows from the value and is never a separate option: the two other combinations are an invisible page and a double-drawn one. A page that fails to rasterize falls back to the vector backdrop **with visible text** — dropping only the backdrop would leave `'page'`'s transparent text over nothing, i.e. a blank page. Together with the reflowable `mode: 'semantic'`, this covers every capability the Go implementation's four HTML modes provide. (`kf8h.2`)

- **HTML fixed mode: fillable AcroForm controls** — `ToHtml({ mode: 'fixed', forms: true })` turns form fields into real HTML controls positioned on their widgets: text fields as `<input type="text">`, `type="password"` or `<textarea>` with `maxlength` from `/MaxLen`; checkboxes and radios as `<input>` carrying the widget's own export name as `value` (read from its `/AP /N`, never guessed); choice fields as `<select>`, with an `[export, display]` `/Opt` entry keeping both halves; push buttons as `<button type="submit">` or `"reset"` **only** when `/A` parses as SubmitForm or ResetForm. Controls are styled from `/MK` (border and background colour) and `/DA` (font size and colour), carry `required`/`readonly`/`disabled` from `/Ff`, and take a `tabindex` running across the whole document. A document-level `<form>` wraps the pages when a submit button was converted, with `action` from the SubmitForm URL. Signature fields convert too — as **disabled** inputs carrying the signer and date the document claims (`/V /Name`, `/V /M`), never a verification result, which would make an HTML export depend on trust stores and network-fetched revocation data. Every converted widget's painted appearance is suppressed from whichever backdrop renders, so nothing is drawn twice; a field that does not convert keeps its ink. Works with all three backdrops including `'page'`, where the Go implementation declines. Requires `mode: 'fixed'` and throws otherwise rather than silently ignoring the option. (`kf8h.1`)

- **HTML fixed mode: vertical writing** — a `/WMode 1` run (the `-V` CMaps) now emits one absolutely positioned `<span>` **per glyph** instead of one span for the whole run, so a vertically-set Japanese page stops exporting as a stack of short horizontal blobs. Placement comes from the same `glyphOrigin`/`glyphDisplacement` helpers the SVG and raster backends use, so all three place glyphs by the font's own `/W2` and `/DW2` rather than by whatever advance a browser would choose — the reason per-glyph spans were chosen over CSS `writing-mode`. Reaches `fonts: 'embed'` as well. A horizontal run is still one span. (`kf8h.4`)

- **Emphasis in the HTML and Markdown exports** — `DocText.bold`, `.italic` and `.script` are read by all three serializers, not `docxflow.ts` alone: HTML emits `<b>`/`<i>`/`<sub>`/`<sup>` and Markdown `*`/`**`/`***` plus raw `<sub>`/`<sup>`, so a Markdown → PDF → Markdown round trip now reproduces its own source byte for byte. `<b>` and `<i>` rather than `<strong>` and `<em>`: emphasis here is *derived* from the producing face, and `<strong>` would assert an importance the PDF never stated. Adjacent same-style runs merge before emission (two bold runs emitted separately give `**a****b**`, which does not reparse as emphasis at all), and a heading whose every run is bold emits none — both formats render headings bold themselves. (`c3t7.8`)

- **Extraction fidelity: sub/superscript, scoped search, and borderless tables** — `TextFragment.script` reports `'sub'`/`'super'`, derived from two pieces of evidence that must both hold: the run is materially smaller than its line's *dominant* size, and its baseline is materially shifted from that size's baseline. Requiring both is what keeps OpenType mark positioning (a raised glyph at an unchanged size — our own shaper emits exactly that) and small caps from being labelled a script. It reads position and size rather than `Ts`, because many producers write a superscript by moving the text matrix with no rise at all, and it reaches the tagged path too, where a `/Span` around a footnote marker contains nothing but the marker and so cannot be classified against itself. `searchText` gains a `region`, using the same centroid containment rule table extraction uses, so the two features cannot disagree about one page. Borderless tables are found by a second, whitespace-alignment detector run over the fragments left outside every ruled table, now with spanning cells and nesting — it infers a `colSpan` but never a `rowSpan`, since a cell covering two baseline bands is indistinguishable from ordinary wrapped text. Annotation text became searchable in both its meanings: what an annotation *draws* (`Page.SearchAnnotations`, the words inside its `/AP`) and what it *carries* (`Page.SearchAnnotationText` over `/Contents`, `/T` and `/Subj`). (`c3t7`)

- **PDF to DOCX export** — `Document.ToDocx()` / `Page.ToDocx()` write a `.docx` (Office Open XML) as `Uint8Array`, over a ZIP and OOXML package writer built on `node:zlib` with no new dependency. `mode: 'flow'` (default) reflows over the same neutral model `ToHtml` and `ToMarkdown` read — `Heading1`–`Heading6`, styled runs, nested/ordered/task lists, hyperlinks, images, and tables carrying their recovered per-cell borders and shading. `mode: 'textbox'` keeps each page's own geometry instead: every run becomes a page-anchored `w:framePr` text frame at its PDF position, one section per page carrying that page's size, so a mixed-size document survives. Frames err *wide* rather than narrow, because Word re-measures with a substituted face and an over-wide frame displaces nothing while a narrow one wraps to a second line. Output is byte-reproducible: entry timestamps are a fixed 1980-01-01 constant, never the clock, or nothing downstream could be snapshot-tested. The tests prove structural conformance to ECMA-376; no CI here can open Word. (`8yt9`)

- **PDF to Markdown export** — `Document.ToMarkdown()` / `Page.ToMarkdown()` serialize the same neutral model semantic `ToHtml` reads into one GFM document: ATX headings, paragraphs, pipe tables, nested lists (bullet, ordered with `start`, and task), fenced code blocks with their indentation intact, block quotes, links recovered from `/Link` annotations, and images inline as `data:` URIs or handed back as files. Every escaper is specified by this library's own CommonMark parser — `parseMarkdown(escape(s))` must yield back `s` — because a hand-written character list makes both under- and over-escaping invisible; there are two of them, since block text must escape the line-leading openers a table cell must not. A code fence is `max(3, longest backtick run inside + 1)` backticks, or a block containing a fenced example breaks out of itself into valid Markdown that says something else. `ToMarkdownAssets` returns the image files; `ToMarkdown` refuses `images: 'external'` rather than emitting links to files nobody wrote. (`no93`)

- **Markdown to PDF authoring** — `parseMarkdown(src)` implements CommonMark **0.31.2** by the spec's own two-phase algorithm, verified against all **652** cases of the official suite with no allowlist, and `{ gfm: true }` adds the five GitHub extensions (tables, strikethrough, task lists, extended autolinks, the tag filter). Rules the GFM prose does not settle are transcribed from `cmark-gfm`'s own sources rather than guessed, since its 24 published examples are far too thin to pin the grammar; `gfm` off leaves output byte-identical, which the conformance run pins. `flow.AddMarkdown` / `page.AddMarkdown` / `doc.AddMarkdown` then render it, lowering the AST to a flat list of flow elements through three pure layers that know nothing of columns, rects or pagination — which is what makes three entry points one implementation. Emphasis selects from a four-face family with no synthetic slant, and a construct that cannot render names itself in `skipped` while still contributing its text. `{ tagged: true }` emits `/H1`–`/H6`, `/P`, `/L`, `/Code` and `/BlockQuote` for PDF/UA. The parser never throws: every string is a valid CommonMark document, so damage shows up as literal text. (`gl6o`)

- **CJK text through the predefined CMaps** — a composite font's `/Encoding` may now name any of the **195** predefined Adobe CMaps (Japan1, GB1, CNS1, Korea1, KR, Identity, and the deprecated Japan2), bundled as 385,860 ranges in ~1.0 MB of base64 and inflated only when a document first names one, so a document with no CJK in it costs nothing. The shape these need and `/ToUnicode` never does is the *codespace*: codes are not a fixed width — `UniJIS-UTF8-H` mixes 1- to 4-byte codes in one show string — so a caller asks for one code at a time rather than slicing up front. Codespace ranges compare **byte by byte**, not as integers, because a Shift-JIS lead byte with an out-of-range trail is what mislabelled CJK text is made of. A `usecmap` parent supplies the codespace as well as the mappings, without which nearly every vertical CMap matches no code at all. Vertical writing (`/WMode 1`) reaches extraction, `ToImage` and `ToSvg`, with one owner for the direction arithmetic. When `/ToUnicode` is absent, CID→Unicode comes from Adobe's published tables for the collection `/CIDSystemInfo` names — not from inverting the bundled CMaps, which was measured to agree on only 39% of Adobe-Japan1's CIDs. (`z6wd`)

- **Interpreter coverage for legacy font and function types** — three formats a real corpus contains and the interpreter could not draw. **Type 3** fonts execute their `/CharProcs` under the font's own `/FontMatrix`, which fixes both how big the glyphs draw and — since `/Widths` are in the same space — how far the pen advances; fix only the drawing and a page renders at the right size with the glyphs piled on top of one another. **Type 1** (`/FontFile`) gets a container reader (PFA/PFB framing, eexec decryption, `/Subrs`, `/CharStrings`) and its own charstring interpreter, because the Type 1 and CFF grammars differ in every operator that clears the stack and a mode flag would fork inside nearly every branch. **Type 4** (PostScript calculator) functions are interpreted by a module that touches no PDF objects; before it, every type 4 function returned the constant `/Range` midpoint, so a PostScript-driven shading painted one flat colour with no error raised anywhere. Widths and metrics for all of these reach the extraction path too. (`imxw`)

- **Robust parsing of damaged files** — `Document.Open` falls back to scanning for `N G obj` headers when the cross-reference structure cannot be read, when an object will not parse at the offset the xref gave, or when `/Root` does not resolve to a `/Type /Catalog`; `doc.recovery` then reports what was `repaired` and what was `lost`, and is `undefined` after a clean parse. Objects inside an `/ObjStm` carry no header of their own, but the container does, so everything it declares is registered — without that step `/Root` is unreachable in every file `Save({ compressed: true })` ever produced. A container whose payload is damaged decodes as far as it goes rather than being dropped whole. When no trailer survives, one is rebuilt: `/Root` is the catalog with a walkable `/Pages` at the highest offset, and `/Info` is found by *reachability* — a valid document never reaches `/Info` from the catalog graph — which is what stops an outline item carrying `/Title` from winning. Real damaged files from Ghostscript and qpdf back the suite, with the damage recorded byte for byte. (`dxfk`)

- **Authoring lifecycle: create from scratch, and flatten one object** — `Document.New(format?)` builds an empty, valid document at a named page size without opening bytes first, so an authoring caller no longer has to keep a blank PDF around as a seed. `Field.Flatten()` and `Annotation.Flatten()` bake a single object's appearance into page content and unwire just that one, where `FlattenForm`/`FlattenAnnotations` take the whole document. The ordering is load-bearing and not obvious: per-object flatten bakes *before* it unwires, because the structure element is reached through the `/OBJR` naming the annotation and unwiring deletes exactly that — unwire first and nothing is baked at all, while the element loses its only kid and is pruned. (`x1xq`)

- **Navigation and metadata polish** — outline items carry `/C` colour and `/F` bold/italic flags; an outline destination may name a *named* destination rather than an explicit page target; and `SetXmp` accepts arbitrary namespaced custom properties instead of only the schemas it knows. (`qm5w`)

- **Flow layout: in-flow boxes and per-side box borders** — `Flow.AddFloatingBox` places a callout *in* the flow, consuming the band outright rather than narrowing the channel the way a side float does, and it never splits: a callout broken across a column reads as a fault, and a box's border and background have no defined way to continue. `FloatingBox` gains per-side borders over the same shared vocabulary table cells and the table frame use, so a float box no longer has to import the table-authoring module for a border type. (`blw2`)

- **PageGraphics shape and stroke-state primitives** — `roundedRect`, `arc`, `polyline` and `polygon` on the vector builder, plus `setMiterLimit`, so ordinary shapes stop being hand-rolled from Bézier segments at every call site. (`abhw`)

- **Table authoring: row geometry and border control** — explicit row height (`minHeight`, chainable as `RowBuilder.setMinHeight`) overriding the content-derived height; per-side borders on `BorderInfo`; and per-row and per-cell padding in the style cascade. All four edges keep the single `re` shorthand, which is what makes an unset `sides` byte-identical to a border written before the option existed. (`4nw7`)

- **Annotation coverage completion** — the `/Redact` annotation type (mark mode, with overlay text and style) and the `/Caret` type (`page.AddCaret`). An unapplied `/Redact` mark outlines each quad and fills nothing, deliberately: both renderers and `FlattenAnnotations` composite `/AP /N`, so a filled preview would render a page whose text is still fully extractable as though it were already redacted. (`0pvw`)

- **Tagged table authoring** — `page.AddTable({ tagged: true })` emits the `/Table` > `/TR` > `/TD`|`/TH` subtree with `/Scope` and `ColSpan` attributes, reusing one `/Table` element across a paginated table so it stays one table rather than one per page. (`7efj`)

- **Vector gradient fills** — axial and radial shading fills on `PageGraphics` (radial with a focal point), over a colour-stop model shared with the SVG import path, plus gradient *stroke* paint (`setStrokeGradient`). Varying per-stop alpha is carried by a luminosity soft mask, since a PDF shading has no alpha channel of its own. (`lqp5`, `menf`)

- **Form-field breadth** — choice-field option-list mutation (`AddOption`/`RemoveOption`), `Form.RemoveField` to delete a field and its widgets, the `FileSelect` and `RichText` text-field variants, the `DoNotSpellCheck` and `DoNotScroll` flags, and push-button icon layouts `/TP` 3, 4 and 5. An `/Opt` entry is read and written in exactly one place: the export half is what `/V` carries and the display half is what gets drawn, and every consumer that re-derived that grammar inline got one of the two halves wrong. (`as76`, `4nzl`, `kjdx`, `0sln`, `26w0`)

- **TOC, booklet imposition, SVG embedding, and text decoration** — `page.AddTOC` generates a paginated, clickable table of contents over `/PageLabels`, optionally tagged as `/TOC` + `/TOCI`. `doc.Booklet` does saddle-stitch imposition, including multi-sheet signatures and creep, over a pure arithmetic model that touches no PDF objects — so the geometry that is silently wrong when reversed is testable without building a file. `page.AddSVGObject` imports SVG as a Form XObject: the path grammar, transforms and viewBox placement, the CSS cascade (a whole-tree pre-pass, since a `<style>` may appear after what it styles), gradients, patterns, masks, markers, text and `textPath` including `method="stretch"`, `<image>`, and the filter primitives — with the lighting and turbulence kernels transcribed from SVG 1.1's published reference implementations and verified against browser-rendered goldens, which they cannot validate against themselves. An element the walker cannot render fully names itself in `skipped` and still draws, unfiltered and unmasked: visible ink beats silently dropped content. `AddText` gains underline, strikethrough and background decoration. (`1gg0`)

- **Interactive form-field creation** — `Form.AddTextField`, `AddCheckbox`, `AddRadioGroup`, `AddComboBox`, `AddListBox` and `AddPushButton` create fields from nothing: `/AcroForm` bootstrap, `/DR` + `/DA` defaults, hierarchical field-tree wiring, widget construction, and a style vocabulary for border, background and text. Creation validates every argument *and* the whole field path before allocating any object, so a rejected call leaves the document byte-identical — a radio group that rejected its third option after wiring the parent and two kids would otherwise strand all three, the parent in `/AcroForm /Fields` and the widgets in page `/Annots`. Creation never routes through the on-state *guess* that exists for documents we did not author: an unchecked checkbox with a custom export value is the case that exposes the difference, since every input the guess reads is `Off`. (`dbpr`)

- **Flow layout engine** — `doc.NewFlow()` lays a document out across columns and freshly sized pages: paragraphs, headings, bulleted and numbered lists (nested, with per-level numbering and per-item overrides), images, column breaks, keep-with-next and orphan control, side floats with per-side stacking, simultaneous left and right floats, CSS-style clearing, and cross-column float carry. The wrapping arithmetic lives in one engine, and the band bookkeeping behind float wrapping is a pure module that knows nothing about PDF or drawing. Optionally emits `/H1`–`/H6`, `/P`, `/L` and `/Figure` structure. (`db7v`)

- **Table authoring and rendering** — `createTable` builds a page-independent model of rows and cells over a table→row→cell style cascade (borders, background fills, alignment, padding) with fixed and fractional column widths and `colSpan`; `page.AddTable` lays it out and paints each page block through the stamping primitives. Multi-page overflow works either manually through a re-drawable remainder or by auto-pagination, with repeating header rows embedded in the continuation, and cells may hold images (aspect-fit). (`49l`)

- **PDF/X validation and conversion** — `doc.ValidatePdfX(level)` checks a curated, machine-decidable subset of ISO 15930 at `'1a'`/`'3'`/`'4'`/`'4p'`, and `doc.ConvertToPdfX` remediates toward it. Conversion never silently alters printed appearance: live transparency, non-embeddable fonts, RGB rasters and annotations overlapping the trim area are reported unresolved rather than rewritten, and the RGB→CMYK rewrite is opt-in because a naive conversion without the destination profile produces wrong ink on press. Ghostscript-produced real-world files back the rules — four conformant, one deliberately not. (`i9n`)

- **Render fidelity: patterns, soft masks, blend modes and transparency groups** — tiling and shading patterns, luminosity and alpha soft masks, the separable and non-separable blend functions, and transparency-group compositing in both backends. A group is buffered whenever it composites as a unit — group alpha, a blend mode, or a soft mask — and `/Group /I` then selects how it composites rather than whether it is buffered; gating buffering on `/I true` silently drew ordinary groups inline and double-composited their overlaps. For a non-isolated group whose contents also blend, the buffer is seeded with the page backdrop and the backdrop is subtracted back out at composite time. (`a6i`)

- **FDF and XFDF data exchange** — `ExportFdf`/`ExportXfdf`/`ImportFdf`/`ImportXfdf` for both field values and annotations, over two format-neutral middles that own all interaction with the document and format modules that never import `Document`. An annotation in the neutral model carries no reference cycle: `/Popup` and `/IRT` are stripped and carried as `/NM` name links, because `/Popup` → popup → `/Parent` closes a loop that inlining cannot represent. Acrobat's own `<appearance>` payload — base64 of an XML COS serialization, not a one-object PDF fragment — is read as well as ours, sniffed on the first byte; we write only ours. (`e1p`, `73p`, `yuk`)

- **Watermarks, Bates numbering and headers/footers** — `AddWatermark`, `AddHeaderFooter` and `AddBatesNumbering` as an ergonomic layer over the stamping primitives, with position anchors, `{page}`/`{bates}`/date templates, and a page selection resolved from an explicit list or a `"1-5,8,12-"` range string. No new rendering primitives. (`h8s`)

- **PDF to HTML export** — `doc.ToHtml()` / `page.ToHtml()` return a standalone HTML document. `mode: 'semantic'` produces reflowable markup, driven by the `/StructTree` when tagged and by document-wide font-size ranking when not; `mode: 'fixed'` reproduces page appearance with absolutely positioned text over an inline-SVG backdrop, from one interpreter pass so text is never double-drawn. Fonts map to CSS family stacks by default, or `fonts: 'embed'` inlines each embeddable program as a base64 WOFF `@font-face` with a freshly built cmap so glyphs and metrics match the PDF. A `/Figure`'s image is resolved by **MCID**, never by page position or resource order — `page.Images` is `/Resources` order and says nothing about which figure draws what. Never throws: a page that fails mid-walk contributes what it produced. (`hdx`, `ec5`, `kkh`)

- **Barcode generation** — `page.AddBarcode` for Code 128 (including Code A control characters), EAN-13, EAN-8, UPC-A and QR (GF(256)/Reed–Solomon, mode and version selection, masking), painted as vector modules or a 1-bit `/ImageMask` stencil, with an optional `/Alt` tag and OCG layer. The geometry models are pure and know nothing about PDF. (`66f`, `81g`)

- **Annotation and form appearances in the renderers** — `ToImage` and `ToSvg` composite each visible annotation's `/AP /N` through the same Form-XObject path as page content, so both backends get it from one rule set (`{ annotations: false }` opts out). The visibility predicate and placement are shared with flatten, which is what makes rendering, search and flattening agree about which annotations draw. (`57b`)

- **Document optimization** — `doc.Optimize()` shrinks the live model in place so the next `Save()` writes a smaller file, reporting what it did. Three lossless passes run by default: font subsetting (scanning page content, `/AP` streams, tiling patterns and Type 3 charprocs for the glyphs each program actually shows, then blanking the rest in place for TrueType and for CID-keyed and name-keyed CFF), content-hashed stream dedup, and payload recompression. Subsetting preserves GID numbering and never renumbers, and a usage scan that cannot prove itself complete skips the font rather than guessing — a wrong guess silently blanks a glyph that is actually shown. Opt-in `{ images }` is lossy: the CTM is tracked to find each image's maximum effective DPI, box-filtered down and re-encoded to JPEG. Unused `/AcroForm /DR` entries are pruned by walking from the catalog, never from the object map, or the pass reads the `/DA` of the very field whose removal it exists to clean up after. (`doo`, `kqy`, `4by`, `h7g5`, `gfs`)

- **Image codec breadth** — `JPXDecode` (JPEG 2000, ISO 15444-1: JP2 boxes and codestream over an MQ arithmetic decoder, EBCOT Tier-1/Tier-2, and the inverse 5/3 and 9/7 wavelets), `JBIG2Decode` (ITU-T T.88 embedded organization: segment parse and page assembly over generic regions with arithmetic templates 0–3 and MMR, symbol dictionaries and text regions — reusing the JPEG 2000 MQ coder, since JBIG2's arithmetic coder is the same one), the remaining JPEG modes (arithmetic SOF9/SOF10, lossless SOF3/SOF11, differential and hierarchical SOF5-7/SOF13-15), 12-bit precision, and CCITT Group 3 1D/2D alongside the hardened Group 4. A baseline JPEG *encoder* landed with them, for Optimize's image pass. Real images from libjpeg-turbo and `cjpeg`-generated synthetics (including CMYK/YCCK) back the decoders, because our own encoder agreeing with our own decoder proves only that the two agree. (`kec`, `8t9`, `ac6`, `2qx`, `1hw`, `aw0`)

- **Font ingestion and CFF subsetting** — `AddFontFile` accepts WOFF and WOFF2 web fonts and reconstructs them to sfnt in memory, and CFF fonts subset to a CID-keyed `CIDFontType0C` with a whole-embed fallback. The WOFF2 `glyf` transform discards the format's compact encodings, so reconstruction re-chooses them — short-form deltas, `SAME` bits, `REPEAT` flag runs; emitting the plain long form is semantically correct and silently inflates `glyf` by ~28%, which reaches the PDF because subsetting copies glyph bytes verbatim. Real `.woff2` files from wawoff2 and fontTools back it, covering `glyf`, `hmtx` and CFF-flavoured input. (`6al`, `y18`)

- **Complex-text shaping** — opt-in `{ shape: true }` on `AddText`/`AddTextBlock`: UAX #9 bidi, script itemization and Arabic joining, OpenType GDEF/GSUB/GPOS application (including class-based contextual lookups, cursive attachment and mark-to-ligature), UAX #14 line-breaking for wrapped shaped text, and Unicode normalization where shaping needs it — emitted as Identity-H glyph runs over range-compressed Unicode 16 tables. Conformance runs against Unicode's own UAX #9 and #14 data. (`8u0`, `aq4`, `5pz`)

- **Partial image redaction** — an image only partly covered by a redaction region is clipped and re-encoded rather than deleted whole, preserving its original colour space and bit depth, and covering DCT-encoded images (baseline and progressive), inline images (`BI…EI`) including inline masks, DCT-encoded `/SMask` soft masks, and rotated or skewed placements. (`gq8`, `b3b`, `3ee`, `2zs`, `357`, `66r`, `njs`, `hu8`)

- **Certificate-based (public-key) encryption** — the `/Adobe.PubSec` handler for both encrypt and decrypt, with RSA recipients (PKCS1-v1_5 or OAEP key transport), EC recipients (ECDH-ES key agreement with X9.63 KDF and AES key wrap), and per-recipient permission groups. (`5av`, `8kb`)

- **Rendering: page to SVG and to PNG** — `page.ToSvg()` emits a standalone `<svg>` and `page.ToImage()` rasterizes to PNG through a pure-TypeScript scanline rasterizer, both driven by one shared content-stream interpreter so the two backends cannot disagree about semantics. Covers path fills (nonzero and even-odd), stroking with dashes, joins and caps, the clip-mask stack, affine image sampling, axial and radial shadings, and glyph rasterization from `glyf` and CFF outlines with bundled Standard-14 substitute faces for non-embedded text. A stroke-shaped clip is emitted as *fill* geometry, because SVG excludes the `stroke` property from clipping paths and clipping to a stroked zero-area line silently vanishes in real engines while the raster path still looks correct. The SVG goldens are headless-Chrome rasterizations cross-checked against resvg: our rasterizer works from PDF semantics and the browser from our emitted markup, so agreement is independent evidence. (`3sh`)

- **Accessibility auto-tagging** — `doc.AutoTag()` infers a `/StructTreeRoot` from layout: headings and paragraphs from document-wide font-size ranking, figures from drawn images, and tables through the same detector `GetTables` uses. `StructElement.MarkContent(page, region)` is the primitive underneath, marking every content stream the region covers with its own balanced `BDC … EMC`. (`pwi`)

- **Optional content (layers / OCG)** — enumerate and toggle layers, author new ones and bind content to them, delete a layer and excise its marked content, interpret OCMD `/VE` visibility expressions, and recurse into Form XObject content streams when excising. Removal prunes the deleted layer from surviving OCMD `/VE` and `/OCGs`, from `/Properties` entries mapping a name directly at it, and from nested XObjects' `/OC` — each of which otherwise leaves a dangling reference behind. (`ac0`, `hz2`, `3sn`, `647`, `gvu`, `10p`, `7kf`, `lzf`)

- **Table extraction** — `page.GetTables()` recovers tables three ways, in priority order: an authored tagged `/Table` subtree first (a tag is a statement, detection is a guess), then ruling-line geometry, then whitespace alignment over what geometry left behind. It handles multiple tables per page, nested tables, rotated and skewed frames, and cross-page stitching, and returns a model with `toHtml()` and `toMarkdown()`. The geometry detector requires an *interior* separator — a component with two horizontal and two vertical rule positions is satisfied by a bare rectangle, and a card or callout is page furniture, not a table; reporting those cost twice over, filling the HTML export with empty tables and the structure tree with one-cell subtrees where a screen reader announces decoration as data. Per-cell borders and shading are recovered from the page's vector ink in a pass that runs *after* detection and changes nothing detection decided. (`7y8`, `k33`, `5ct`, `7ac`, `84u`, `ajj`, `fwc`, `e2o`)

- **Linearization (Fast Web View)** — `doc.Save({ linearized: true })` emits a linearized PDF per ISO 32000-1 Annex F: parameter dictionary first, the first page's objects and a primary hint stream near the front, and two chained cross-reference sections, with `verifyLinearization` and `Document.IsLinearized` to check the result. (`cu8`)

- **PDF/A validation and conversion** — `doc.ValidatePdfA(level)` checks a curated, machine-decidable subset of ISO 19005 across parts 1–3 at levels b/u/a, and `doc.ConvertToPdfA` remediates toward b and u, returning a report of what was applied, what passed and what could not be resolved. Conversion is best-effort and never fabricates assets: it will not invent an ICC profile or an embedded font it does not have. A bundled sRGB profile backs the output intent. (`4wk`)

- **PDF/UA validation and remediation** — `doc.ValidatePdfUa()` reports a curated subset of PDF/UA-1, and `doc.ConvertToPdfUa()` mechanically fixes the deterministic defects: `/MarkInfo /Marked`, `/ViewerPreferences /DisplayDocTitle`, a document `/Lang`, a `/Title`, role-map and suspects cleanup, and `pdfuaid` identification XMP. Mechanical only — it cannot write alt text or decide reading order, and says so in the report rather than guessing. (`hq6`, `pjx.5`)

- **Tagged PDF: read, author and preserve** — `doc.GetStructTree()` exposes the logical structure tree as a queryable model; `CreateStructTree`, `tag` and `MarkContent` author one; structure survives split, merge and extract; and typed `/A` + `/C` attribute views cover the table, list and layout vocabularies. Removing an annotation untags it, because `/StructTreeRoot` is reachable from `/Root` and the `/OBJR` naming an annotation would otherwise keep it alive through `Save()`'s mark-sweep — leaving a widget in the file that is in no `/Annots` and no `/AcroForm /Fields`. (`pjx`)

- **Structured and positioned text extraction** — `GetTextFragments` returns flat positioned runs with their quads, and `GetStructuredText` assembles them into blocks and lines, alongside the coordinate-free `GetText()`. A fragment runs *along* its writing direction and the inter-glyph gap is bounded in both directions — the backward half is not obvious and its absence was a live bug: a right-aligned list marker painted *after* its body merged into the body's fragment however far back it was. (`cgs`)

- **Digital signatures: sign, certify and verify** — `Sign`/`Certify` build CMS/PAdES signatures over an ASN.1/DER toolkit, with RSA PKCS1-v1_5 and PSS, ECDSA and Ed25519; credentials come from PEM, PKCS#12 or an external callback. Signing appends an incremental update rather than rewriting, to preserve earlier signed bytes — the only such path in the library. Visible appearances, certification with `/DocMDP`, RFC 3161 timestamps, `/DSS` validation-data embedding for LTV, document timestamps for PAdES-B-LTA, and CAdES commitment-type and signer-location attributes all ship. Verification covers integrity, cryptography, revision coverage, certificate-path building to trust anchors, OCSP and CRL revocation, and `/DocMDP` enforcement. (`stw`, `8kb`, `zn6`, `38p`)

- **Font embedding and subsetting for authoring** — `AddFont`/`AddFontFile` parse an sfnt, subset TrueType `glyf` to the used-glyph closure, and emit Type0/CIDFontType2 with Identity-H, `/CIDToGIDMap`, `/W` and `/ToUnicode` at `Save`, wired through `AddText` and `AddTextBlock`. (`gnr`)

- **Font and text authoring** — `page.AddText` stamps text in any of the 12 Standard-14 Latin faces with WinAnsi, and `page.AddTextBlock` flows wrapped multi-line text into a rect with leading, horizontal and vertical alignment, justification (with the last-line rule) and an overflow remainder, over a pure word-wrap and measure engine. (`8u8`, `25u9`)

- **Page composition and navigation** — `page.StampWith` (single-page overlay or underlay), `doc.Overlay` (multi-page and cross-document), `doc.NUp` imposition into a new document with an optional border, and `page.Resize`/`page.Scale`, all over a shared imported Form XObject primitive. Navigation gained `/PageLabels` read and write with label resolution, and named-destination CRUD. (`639`, `cyiw`)

- **Redaction and content editing** — `Redact`/`RedactText` remove the glyphs and images a region covers from the content stream itself, sanitize the resources and metadata that referenced them, prune what that orphans, and paint the marker box; `AddRedact`/`MarkRedactText` mark a region as an annotation and `ApplyRedactions` consumes the marks later. `FlattenAnnotations` and `FlattenForm` bake appearances into page content. Content surgery alone does not redact: `/Annots` is a separate object graph the content editor never visits, so an annotation over the region keeps its text and — with an `/AP` — keeps drawing it *over* the marker box, which is why annotation removal is part of the same pass. `ReplaceText` does same-font, no-reflow replacement. (`638`, `vcc`)

- **Annotations and XMP metadata** — a typed annotation model over `/Annots` with live accessors and a create/edit/delete API: text (sticky note), stamp, the four markup types (highlight, underline, strikeout, squiggly), links (GoTo and URI), FreeText, Popup, and typed Polygon/Polyline/Ink, with appearance generation for each. XMP arrived alongside: `GetXmp` reads the `/Root /Metadata` packet with a dependency-free scan and `SetXmp` builds one, mirroring the shared fields with `/Info`. (`tum`, `i1p`, `g6p`, `ur5`)

- **Content stamping and vector drawing** — `PageGraphics`, a buffered vector builder, plus the shared page-content helpers behind it (resource and `/ExtGState` registration, `/Contents` splicing), and text watermarks and page numbers on top. (`b3y`)

- **Image and text extraction** — `page.Images` enumerates embedded image XObjects, recursing into Form XObjects, and `Page.GetText()` walks content operators to emit positioned glyph runs assembled into words and lines. Spacing uses real glyph-width tables rather than an estimate, and the StandardEncoding high range is complete. Vector content followed later through `page.GetPaths()`. (`5ua`, `e37`, `722`, `4m2`, `8i9`)

- **Compressed output and save-time filters** — `Save({ compressed: true })` emits a cross-reference stream with object streams; `Save({ streamFilter })` re-encodes every stream document-wide; and ASCII85, ASCIIHex, LZW and RunLength encoders ship alongside the decoders. (`9vv`, `ox6`, `3jf`)

- **Outlines (bookmarks)** — read and write the outline tree, with destinations resolving to pages. (`5oh`)

- **AcroForm field enumeration and filling** — `doc.Form` exposes terminal fields with live dict handles, typed by `/FT`, with validated setters for text, checkbox, radio and choice values, and appearance generation from `/DA` plus Standard-14 AFM metrics. `/FT`, `/Ff` and `/V` are inherited during the tree walk rather than read off `/Parent`. (`jh9`)

- **Page operations and geometry** — `AddPage`/`InsertPage`/`RemovePage` (sized from a named page format), `Reorder`, `Split` into documents, `ExtractPages` by number, `Merge`/`Append`, and getters and setters for MediaBox, CropBox, BleedBox, TrimBox and ArtBox. (`25c`, `5zi`, `k0c`, `b2p`, `8ol`, `31b`, `cjc`, `v54m`)

- **Encryption on open** — the standard security handler decrypts RC4, `AESV2` and `AESV3` documents at `Open` via `node:crypto`, and `Save({ encrypt })` writes them back with AES-256, AES-128 or RC4, named permission flags, and a metadata-encryption toggle. (`u91`)

- **Live in-memory object model** — the library parses an entire PDF into an in-memory object model on `Open`, lets callers mutate that live model, and serializes a freshly renumbered document on `Save` (mark-sweep from `/Root` and `/Info`), replacing the earlier copy-through pipeline. No temp files, and `Save()` never mutates its inputs. (`j3y`)

- **Core parser and page extraction** — the foundation: PDF lexer and object grammar, classic cross-reference tables, cross-reference streams and hybrid `/XRefStm`, object streams, `FlateDecode` with PNG and TIFF predictors, a page-tree walker with attribute inheritance, a reachable-set extractor with a prune policy, and a serializer. `Document.Open`/`OpenFile`, `Document.Split()` and the Node file wrappers date from here. The lexer's central invariant was set here too: `Lexer.next()` never throws and always either consumes a byte or returns `eof`, and deciding that a token is a *syntax error* belongs to the caller — the only layer that knows which of the four grammars over this tokenizer is being read. (`x3n`)

### Changed

- **BREAKING — the supported Node floor is now 22, and `package.json` declares it.** The manifest carried no `engines` field at all, so nothing checked the requirement the README stated; an install on an unsupported runtime succeeded and failed later, at whatever call first touched a missing built-in. `engines.node` is now `">=22"` and the README agrees. The floor moved from 18 to 22 because both 18 (EOL April 2025) and 20 (EOL April 2026) are past end of life: the previous number described what the code technically needed rather than what anyone should run. Nothing in the library actually requires 22 — the surface is `node:zlib`, `node:crypto`, `node:fs`, `node:fs/promises` and `node:path`, all of it available well before 18, with an ES2022 target and no ES2023 or Node-20+ APIs — so a consumer pinned to an older runtime can still use the code; they simply do so unsupported. A test now pins the manifest and the README to the same number, since drifting apart silently is what made this worth an issue. (`ul19`)

- **BREAKING — `DocxOptions.backdrop`'s `'page'` value is now `'raster'`, and it renders a glyph-less backdrop.** The value is renamed because its meaning changed: it no longer rasterizes the whole page but only the page's *graphics*, which is exactly what `HtmlOptions.backdrop: 'raster'` has always meant. Keeping the old spelling would have left one word meaning glyph-less in HTML and full-page in DOCX — the cross-export collision the `background` → `backdrop` rename existed to prevent. DOCX deliberately does **not** gain HTML's other value, `'page'`: that pairing needs transparent text, and WordprocessingML has no transparent run colour to build it from (`w:color` carries no alpha, and `w14:textFill` would drag in an extension namespace this writer avoids), so the glyph-less backdrop is the only one DOCX can honestly offer — and the one that suits an editable format. See the Fixed entry below for what the behaviour change is. (`tvc4`)

- **BREAKING — `DocxOptions.background` is now `backdrop`, and its `'raster'` value is now `'page'`.** `ImageOptions.background` already meant `'white' | 'transparent'`, and the new `HtmlOptions` needed a third meaning for the same key; across option bags a caller mixes in one file, that has no compile-time guard. The value follows the key: leaving it as `'raster'` would make `backdrop: 'raster'` mean *glyph-less* in HTML and *full page* in DOCX. `ImageOptions.background` is unchanged — that one really is a background colour. Renders identically; the DOCX byte-identity fence is unmoved.

- **BREAKING — `splitPdf` was replaced by `Document.Split()`, and `Page.Save` removed.** The free function returned bytes and could only split; `Split()` returns `Document[]`, which composes with everything else the facade offers. `Page.Save` — added weeks earlier, with `splitPdf` delegating to it — went with it: a page is not independently serializable once the model is live and shared. (`k0c`)

- **BREAKING — the lowercase `open` entry point became `Open`.** Static entry points are PascalCase throughout the API and this was the only exception; the class itself was `PdfDocument` at the time and is now `Document`. (`efi`)

- **Unapplied `/Redact` marks outline rather than fill, and stay that way.** Recorded as a deliberate decision after review rather than a defect: both renderers and `FlattenAnnotations` composite `/AP /N`, so a filled preview would render a page whose text is still fully extractable as though it had already been redacted. (`ar2o`)

### Fixed

- **A JavaScript action whose `/JS` is a stream is read** — 32000-1 table 217 makes `/JS` a text string **or** a text stream, and `parseActionDict` accepted only the string, so such an action read back as `undefined` **entirely** rather than merely without its script. Reachable from any annotation `/A` and any field `/AA`, not only from the document-level tree — that is simply where it bites hardest, since a large script is exactly what a producer stores as a stream. An undecodable stream still yields `undefined` rather than throwing: this grammar is one of the layers that ignores what it cannot read. (`lucg.4`)

- **JBIG2 intermediate region segments no longer draw on the page** — a type 36 (intermediate generic region) or type 4 (intermediate text region) is now decoded and held for a later segment to use as its reference, which is what ITU-T T.88 §7.4 defines it for; only the immediate forms (6/7, 38/39) composite. Both were drawn unconditionally before, which is wrong in the direction that looks right: in a conformant file the intermediate region is subsequently refined onto the same spot, so the page ended up with approximately the intended ink and no fixture could tell the difference. It bites once refinement regions decode, since the buffer this now keeps *is* the reference a refinement reads. A file carrying an intermediate region nothing consumes is not conformant and now contributes no ink for it. The profiles segment (type 52) is also skipped rather than refused — it carries no bitmap and belongs beside the page-information and end-of-* segments; it reached the `default:` refusal only because nobody had met one. Halftone, pattern dictionary, refinement, custom Huffman tables and Huffman-coded regions still refuse by name. (`utax.4`)

- **DOCX textbox mode drew every glyph twice** — `ToDocx({ mode: 'textbox' })` rendered its backdrop with `page.ToImage()`, the whole page including text, and then stacked *visible* text frames over it. Every glyph was therefore drawn twice: once baked into the raster, once re-rendered by Word from the frame with a substituted face, which does not land on the same pixels — so text came out doubled and slightly offset, worst wherever Word's substitute differed most from the embedded face. The backdrop now renders through `renderPageGraphicsToPng`, the same glyph-less export HTML's `backdrop: 'raster'` uses, so the frames are the only drawing of the text and it stays real, editable Word text — which is the whole reason textbox mode positions frames at all. Measured on a 36pt fixture: 690 dark pixels inside the first fragment's own quad before, 0 after, with the text still present in `document.xml`. The stacking order and the frame geometry are unchanged, and flow mode is untouched — its byte-identity fence did not move. No test caught this: the textbox suite asserted that a picture frame existed, never what was inside it. (`tvc4`)

- **`AutoTag` no longer drops every content stream but one** — a page whose `/Contents` is an array lost all but the busiest stream from the document model, and so from every export: `MarkContent` reduced a region to a single stream and left the rest unmarked, which is neither tagged nor artifacted. It fired `UntaggedContent` on a document we had just tagged. This is the everyday shape of an authored page, not a damaged one — `page.AddText` splices a new stream per call, so any page built from several stamps and then AutoTagged exported with all but the first stamp missing. Every covered stream now gets its own balanced `BDC … EMC` with its own MCID, all appended as kids of the one element. Found while building a fixture for `c3t7.8`. (`c3t7.10`)

- **Redaction left an orphaned widget in place entirely** — a covered form widget survived redaction whole and went on drawing its `/AP` over the marker box, whenever the field was not reachable from `/AcroForm /Fields`. Detaching just the widget is not enough either: `/AcroForm /CO` keeps the dead field and its value in the saved bytes, and for a radio group a sibling widget elsewhere keeps the shared field reachable, whose `/Kids` then keeps the "removed" widget reachable in turn — so detaching one of a group accomplishes nothing at all. The previous test for this shape asserted only that redaction did not throw, which the leak satisfies as readily as the fix does. (`vvft`)

- **Interpreter used flat 500-unit widths for Standard-14 fonts with no `/Widths`** — only a Standard-14 face may omit the array, which is exactly what this library's own `stampText` writes, so the estimate made the interpreter disagree with the authoring side about text this library had just laid out: `GetTextFragments`, `ToImage` and `ToSvg` spaced glyphs too widely and rendered text overflowing a box it provably fits. Widths now come from the embedded program where there is one, and from the AFM tables otherwise. (`g6nt`)

- **A stray `>` aborted text extraction for the whole page** — an unmatched `>` is a delimiter no production claims, so it came back as a one-character keyword at an unchanged position; in a still-encrypted content stream that grew the operator list until the heap died. A damaged file must throw `PdfParseError`, never take the process down. (`0lns`)

- **Inflating an encrypted stream with no decryptor crashed the V8 worker.** (`oy0u`)

- **Arithmetic-coded JPEG decoded to garbage after two MCUs.** (`hof`)

- **Name `#XX` escapes in `0x80`–`0x9F` were decoded as windows-1252** rather than as the raw bytes a PDF name is made of. (`7kvh`)

- **`Optimize` shrank a shared `/FontFile2` twice, blanking live glyphs** — two font dicts pointing at one program had their usage sets applied independently, so the second pass blanked glyphs the first had proven live. (`4hf`)

- **`ConvertToPdfA` left the saved file over the version ceiling.** (`5rx`)

- **Renderer defects found against goldens** — `ToSvg` mirrored every clip vertically, because `clip-path` resolves in the *referencing* element's user space and a `transform=CTM` on the leaf re-applied the page flip to already device-space clip geometry; the raster backend stayed correct throughout, so it was invisible until a non-flip-symmetric clip fixture existed. Alongside it: stroke-shaped clips were ignored, tiling patterns rendered empty (the page y-flip applied twice), non-isolated groups rendered as isolated, and both backends painted pattern-filled text as flat colour. (`cul`, `csi`, `85a`, `7wg`, `1z2m`)

- **Structure-tree references outlived what they named** — both removing and flattening an annotation left a dangling `/OBJR` in the structure tree. Flatten must *retag* rather than untag, since it keeps the ink as page content: the `/OBJR` becomes a marked-content kid in the same `/K` slot, or the baked ink moves behind whatever used to precede it. (`hob8`, `4dqa`)

- **Accessibility rules under-reported and over-reported** — the `UntaggedContent` rule ignored vector path fills entirely, so every untagged fill and stroke went unreported; redaction's own overlay ink was itself untagged; and `FlattenAnnotations` baked `/Popup` annotations into page content. `Table.toHtml` emitted invalid `scope` and `headers` values, and the semantic HTML export emitted no table markup at all from tagged `/Table` subtrees — it keyed the lookup on an element's `/Pg`, which is optional and absent for every table `AutoTag` authors, so a 33-table tree exported zero tables. Untagged ruled page furniture emitted empty tables, and `/Figure` emitted an `<img>` with no `src`. (`hdsx`, `nmjf`, `vdp`, `tqw`, `6g6o`, `b96c`, `btqp`)

- **`ApplyRedactions` now removes annotations overlapping a redacted region**, rather than leaving them to draw over it. (`mssf`)

- **A `/FreeText` appearance named a font its own form did not contain** — the shared body producer hardcoded the *field* path's `/Helv` while its only caller was on the annotation path, which registers a different key. No viewer complains, since they fall back to a default face, so the contract is now asserted directly over every generated appearance rather than left to a rendering to reveal. (`cu3b`)

- **OpenType layout defects** — GSUB type 5 format 1 misread the order of `seqLookupCount`, and GPOS cursive attachment derived its direction from the lookup flag rather than from the run's bidi level. (`2wm`, `97x`)

- **PDF/X registered ICC conditions were missing current registry entries.** (`h1h`)

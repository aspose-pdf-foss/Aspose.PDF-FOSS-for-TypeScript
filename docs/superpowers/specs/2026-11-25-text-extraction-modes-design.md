# Text extraction modes and paragraph continuations

Issue `kprh.2` extends the read API for callers extracting fixed-format reports or following prose across a column or page break.

`page.GetText()` keeps its existing reading order. The caller can request content-stream order with `mode: 'raw'` or fixed-pitch columns with `mode: 'grid'`. A page-space rectangle and an option to limit extraction to the CropBox compose by intersection. Both ends of the glyph's baseline advance must fall inside the region. Keep the opt-in ActualText behavior established in `kprh.1`, including whole-span selection.

The approved paragraph API adds `page.GetParagraphs()` and `doc.GetParagraphs()`. It reads paragraphs in column order. Joining is opt-in. Each continuation carries its own page number, bounds and lines, so a caller can highlight the source of text that spans two pages. Existing structured-text callers depend on their page-local bounds and line grouping. A dedicated paragraph read lets them adopt column grouping independently.

The behavioral references are the Go implementation at `dfa75dbfb300e6eb5a8e5d2199f81d07ed602916`, particularly `text.go`, `text_clip_test.go`, and `paragraph_multicolumn.go`.

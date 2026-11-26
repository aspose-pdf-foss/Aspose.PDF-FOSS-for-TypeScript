# Annotated comparison copies and standalone diff reports

Beads `1t5g.2` adds two ways to distribute a text comparison. A reviewer can inspect changes where they occurred on a copy of either input. A reader who only needs the differences can open a searchable report generated from an existing `TextComparison`.

## Annotated copy

`source.CompareMarkup(destination, { side, compare })` returns `{ document, comparison }`, following the existing side-by-side result shape. The default side is `'destination'`. Highlight inserted text there, or strike out deleted text when the caller chooses `'source'`. Each annotation carries the changed text. Preserve the selected document's page geometry and existing annotations. Place the rectangles from each page span directly into that page's quad points.

For a change with text only on the opposite side, attach a caret note at the preceding unchanged text, falling back to the following unchanged text. Keep anchors within their comparison block. A page pair missing the selected side gets no mark. The returned comparison retains changes without an anchor, so the caller can still report them. Both inputs remain untouched, including when the same document is passed twice.

## Standalone report

`comparisonToPdf(result, options?)` returns PDF bytes. Write the title, summary counts, and styled changes as searchable text using Flow. Carry over the existing report writer's context option, page headings, and word versus character joining. Show insertions and deletions distinctly in monochrome as well as in color. Page-only changes remain visible in the report, and long runs wrap and paginate.

## Approaches

The existing `CompareSideBySide` places both pages on a new sheet, transforming the original page coordinates. The single-side copy keeps those original coordinates, which also preserves alignment on rotated and cropped pages. The standalone writer consumes the same comparison model as the HTML, Markdown and JSON writers, so generating a report requires neither input PDF nor a second comparison.

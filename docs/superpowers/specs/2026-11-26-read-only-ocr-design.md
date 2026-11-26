# Read-only OCR on a document

Beads `1t5g.5`. A caller inspecting a scanned PDF can ask a supplied `OcrEngine` for text and locations while preserving the document for signing, comparison or later edits.

## Public API

`await doc.RecognizeText(engine, options?)` returns a report with one record per selected page, in the same order as `MakeSearchable`. Both operations accept the same page selector, resolution and abort signal. The default resolution is 200 DPI. A page with extractable text produces a skipped record unless the caller sets `force: true`. A progress callback receives each completed page's record.

A successful record contains the 1-based page number, status `ocr`, recognized text, spans and the number of discarded spans. Join accepted spans with a newline in engine order. Each span contains NFC-normalized text, the clipped pixel box in the rendered image and the corresponding four corners in PDF page coordinates. Report the corners in image top-left, top-right, bottom-right, bottom-left order so callers can relate a rotated scan to its page. An empty recognition is a successful page with empty text and spans.

A skipped record gives the reason `has-text`. A failed record carries the render or engine error message. Both return empty text and spans. Preserve the overlay workflow's distinction between a malformed engine reply, which fails the page, and a geometrically unusable span, which is dropped. Cancellation and resource-limit errors terminate the operation.

## Approach

Share the page recognition pipeline and span geometry with `MakeSearchable`. Give the read-only operation its own result consumer. This lets a caller inspect signed documents and avoids allocating overlay fonts, appending page content or changing the document's modification state. The overlay continues to own signature checks, font allocation, tagging and content writes.

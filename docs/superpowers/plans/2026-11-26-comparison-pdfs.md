# Comparison PDF implementation plan

**Goal.** Deliver the two outputs in the [approved design](../specs/2026-11-26-comparison-pdfs-design.md) for Beads `1t5g.2`. Use the existing TypeScript comparison, annotation and Flow APIs. Track implementation in Beads.

## Mark up a copy of one input

1. Add public-entry tests in `test/compare-markup.test.ts`. Assert highlight and strikeout subtypes, per-line quad points, caret contents and positions, and the selected page count after saving and reopening the output. Exercise a missing first or second page, a block without equal text, and both caret anchor directions. Run the test and observe the missing API.
2. Add `Document.CompareMarkup(other, options?)` in `src/document.ts` and implement annotation placement in `src/comparemarkup.ts`. Return the independent document and the exact `TextComparison` used for its marks. Accept `side?: 'source' | 'destination'` and `compare?: CompareTextOptions`. Validate the side before copying. Use the selected document's live state, including unsaved edits, and preserve its load limits.
3. Reuse the existing detached-document preparation pattern for the selected input. Saving a live input can refresh barcodes and finalize fonts. Verify both inputs' annotations, text, and supplied bytes before and after the operation, including a shared input. Exercise an existing annotation and a password-protected selected document. Ensure a protected input cannot silently become a plaintext copy.
4. Use `TextSpan.quads`, `rectToQuad`, and the existing `AddHighlight`, `AddStrikeOut`, and `AddCaret` methods. Keep caret lookup linear in the number of changes. In pages mode, restart the anchor search at each page pair. In document mode, follow unchanged text across reflow. For rotated pages with an offset CropBox, compare the saved quads with the source text position and inspect changed pixels with annotations enabled and disabled.

## Generate a searchable report

1. Add `test/compare-pdf-report.test.ts`. Open the returned bytes, extract the text, and check title, summary counts, page-only headings and changes. Cover word and character joining, finite context, an empty comparison, text extending over multiple pages, and distinct insertion and deletion styling. Run the tests before adding the writer.
2. Share the report block and context logic in `src/comparereport.ts`. Add `comparisonToPdf(result, options?): Uint8Array` in `src/comparepdf.ts`, using Flow paragraphs and styled runs. Follow the existing report title and context conventions. Keep the source comparison read-only. Exercise the Word-generated revision pair in `test/fixtures/compare/` as well as small fixtures with exact expected output.
3. Export the new writer and public types in `src/index.ts`. Update `README.md` with examples for both outputs, API rows and compiler-verified export counts. Record the capability in `CHANGELOG.md` and describe the new modules in `CLAUDE.md`.

## Verification

Run the focused tests alongside the existing text, rendering, side-by-side and report suites. Run `npm run typecheck` and `npm test` on the integrated changes before closing the issue. Push the verified code and sync Beads.

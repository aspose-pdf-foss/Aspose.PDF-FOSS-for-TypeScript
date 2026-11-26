# Document-scoped read-only OCR implementation plan

Implement the [approved design](../specs/2026-11-26-read-only-ocr-design.md) for Beads `1t5g.5` in this session. Use TypeScript, Node.js 22+, ESM and Vitest with zero runtime dependencies. Track progress in Beads.

## Share recognition and positioning

1. Extend `test/ocrlayer.test.ts` with mixed accepted and rejected spans. At 72 DPI on a 200 by 100 point page, the box `[-5,30,100,50]` clips to `[0,30,100,50]`. Its PDF corners in image order are `[0,70,100,70,100,50,0,50]`. Assert normalization, drop count and preserved engine order. Run the focused test to see the missing geometry contract.
2. In `src/ocrlayer.ts`, share clipping, normalization and inverse-device mapping between recognition results and overlay placement. Keep the existing `buildOcrLayer` entry point and derive its text matrix from the same mapped geometry. Run `npm test -- test/ocrlayer.test.ts test/make-searchable-geometry.test.ts` to verify placement at every quarter turn and non-default DPI.
3. Extract validation, page selection, skip checks, PNG rendering, engine invocation and per-page failures from `src/makesearchable.ts` into a shared OCR path. Preserve existing per-page progress and overlay completion on cancellation, including cleanup of the glyphless font. Run `npm test -- test/make-searchable.test.ts` and verify the signature guard and partial-success cases.

## Return read-only results

1. Add `test/recognize-text.test.ts` using `test/helpers/fake-ocr.ts`. Exercise selected pages, skip and force, progress, an empty reply, a failed page followed by a successful page, and cancellation. Assert an engine returning two accepted spans produces their text joined with a newline. Run the focused test against the missing public method.
2. Expose `Document.RecognizeText(engine: OcrEngine, opts?: RecognizeTextOptions): Promise<RecognizeTextReport>` in `src/document.ts`. Export the options, report, page and positioned-span types in `src/index.ts`. Use page fields `page`, `status`, `reason?`, `text`, `spans` and `dropped`. Use span fields `text`, `box` and `quad`. Consume shared recognition results directly, including on pages with a signature field.
3. Test a rotated, offset crop at 144 DPI against hand-calculated coordinates. On a reopened PDF with a signature field, compare saved bytes and `isModifiedInternal()` before and after recognition. Check preservation on failure and abort, and preservation of pre-existing edits on a dirty document. Exercise propagation of a resource limit. Run all focused OCR suites.
4. Document the API, coordinate order, statuses and a usage example in `README.md`. Update `CHANGELOG.md` under Unreleased and the OCR module descriptions in `CLAUDE.md`. Run the README API test and verify the public export counts.

## Integration

Review the changes against the design, integrate on `main` and run `npm run typecheck` and `npm test`. Push the verified code, close `1t5g.5`, sync Beads and confirm the branch is up to date with its remote.

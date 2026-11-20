# Printer Marks Implementation Plan

**Goal** Add a page-level printer-mark generator and individual .NET-style constructors.

**Architecture** Build mark descriptions and normal appearance forms in `src/printermarks.ts`. Attach them through the existing annotation model or draw them from page-owned content resources.

**Tech stack** Strict TypeScript, NodeNext imports, and Vitest.

**Spec** [Printer marks design](../specs/2026-11-20-printer-marks-design.md)

## Test and implement

1. Add public API tests in `test/printermarks.test.ts` for individual placement, aggregation, saving and reopening, print flags, and the forms' color spaces. Exercise both output modes through the normal renderer. Cover nonzero and inherited boxes, fixed crop, annotations already on the page, invalid arguments with no changes, and repeat calls that keep the original layout bounds. Run the tests against the original public surface and confirm they fail.
2. Implement layout, boxes, and Form XObjects in `src/printermarks.ts`. Connect annotation classes and aggregate authoring through `src/annotation.ts`, `src/page.ts`, and `src/index.ts`. Apply the finished-box rule for printer marks in `src/pdfxvalidate.ts`. Check a conforming page with trim and bleed and one with ArtBox alone. Run the targeted tests and typecheck.
3. Document the public API and count the exports with `test/readme-api.test.ts`. Update `CLAUDE.md` and the Unreleased changelog. Review the patch, run both quality gates, and integrate the feature and Beads record under the repository workflow.

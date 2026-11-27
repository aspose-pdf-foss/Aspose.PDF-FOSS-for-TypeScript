# Selected-page transparency flattening implementation plan

Implement the [approved design](../specs/2026-11-27-selected-transparency-design.md) in TypeScript using the existing renderer, page-range parser, and glyphless font writer.

1. Extend the transparency fixture tests to exercise a mixed selection, rotation, DPI, searchable and image-only output, tagged content, and both filled and empty signature fields. Verify invalid options fail before mutation and each selected page appears once in the report.
2. In `src/pdfaflatten.ts`, share the per-page decision and replacement code with PDF/A conversion. Resolve the full selection before mutation. Keep the signature guard at document scope and check marked content even when dropping text. Preserve PDF/A progress, actions, and cleanup after interruption.
3. Expose the method in `src/document.ts` and its option and report types in `src/index.ts`. Document defaults, skip reasons, and the loss of vector detail. Verify saved output and run the full typecheck and test suite on main before closing the issue.

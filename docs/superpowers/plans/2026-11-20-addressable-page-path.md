# Addressable PagePath Implementation Plan

The [design](../specs/2026-11-20-addressable-page-path-design.md) covers `s2i2.1`.
Track issue status in Beads. The implementation uses the existing TypeScript
content model and the Node stream decoder.

1. In `test/paths.test.ts`, pin the inclusive operator coordinates, clipping,
   cross-stream construction, repeated nested form invocation, and stale
   verification after a stream edit or resource replacement. Check that
   verification allocates no objects and leaves resources intact.
2. In `src/paths.ts`, capture immutable addresses during extraction and add
   an internal verifier. Reuse resolution and the aggregate decode limit from
   `src/pagecontent.ts`, `src/text.ts`, and `src/editcontent.ts`.
3. Export `PagePathAddr` from `src/index.ts`, document it in `README.md`, and
   record the feature and maintainer invariant in `CHANGELOG.md` and `CLAUDE.md`.
4. Verify the focused regressions and API documentation, review the diff, and
   run both repository quality gates. Merge through `main` and sync Git and
   Beads.

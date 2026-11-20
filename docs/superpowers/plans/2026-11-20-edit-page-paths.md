# Edit Page Paths Implementation Plan

The [design](../specs/2026-11-20-edit-page-paths-design.md) defines `s2i2.2`.
Track work in Beads.

1. Regress removal across an indirect `/Contents` array, paint and clipping
   interaction, independent fill and stroke recoloring, local affine geometry,
   stale handles, and repeated nested Forms with inherited resources.
2. Add the methods to extracted handles in `src/paths.ts`. Put the operator
   edits in `src/pathedit.ts`. Use `EditableContent` to stage the page-content
   replacements and occurrence-specific Form copies.
3. Document method behavior, argument units, stale-handle rules, and Form
   limits. Update the public export table and the changelog.
4. Verify the focused tests and the required repository gates, review the
   change, integrate, and sync Git and Beads.

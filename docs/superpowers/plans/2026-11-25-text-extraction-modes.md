# Text extraction modes and paragraph continuation implementation plan

[Approved design](../specs/2026-11-25-text-extraction-modes-design.md)

1. Exercise the public text API on a page whose emission and visual order differ. Add a fixed-pitch column fixture, a rotated page and rotated baseline, intersecting clip regions and a partially selected ActualText span. Confirm failures before extending `TextReadOptions` and the extraction path in `src/text.ts`. Keep the default reading layout, font decoding and visibility handling shared with existing reads.
2. Exercise the paragraph API on aligned columns, positive and negative joins, and a continuation onto the next page. Implement column grouping and the conservative Go join rules. Expose the page and document methods with per-segment page geometry. Preserve the existing structured text API.
3. Update the public export table, extraction examples, architecture notes and changelog. Run the focused tests, then the repository typecheck and full suite. Integrate on main and verify both gates before closing and syncing the issue.

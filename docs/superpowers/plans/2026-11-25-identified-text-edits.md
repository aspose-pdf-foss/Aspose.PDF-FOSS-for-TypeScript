# Identified text edits implementation plan

[Approved design](../specs/2026-11-25-identified-text-edits-design.md)

1. Test duplicate occurrences, neighboring geometry, paragraph alignment, stale and multi-part handles and rollback through the public read methods.
2. Capture provenance while assembling fragments. Share source verification with path editing and use the resolved glyph addresses in the replacement and restyle planner.
3. Apply movement and alignment through compensated show-operator edits. Bind paragraph targets before exposing mutable line and fragment snapshots.
4. Verify focused regressions, update API documentation, integrate on main and run both repository gates before closing the issue.

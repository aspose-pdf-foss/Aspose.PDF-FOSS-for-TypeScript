# Rotated detected-table edits implementation plan

The approved behavior is recorded in [the design](../specs/2026-11-25-rotated-table-edits-design.md). Work is tracked in Beads under `kprh.6`.

1. Extend `test/detected-table-edits.test.ts` with oblique and quarter-turn tables. Verify original placement, a neighbor in a bounding-box corner, shared content after reopen, and rollback on overlap or a failed replacement.
2. Share the conversion of glyphs to table coordinates between extraction and editing. Bind the original glyph and path addresses to each rotated result. Apply the inverse rotation during ownership checks.
3. Draw the fitted replacement in the private page transaction. Rotate its paint and link geometry back into page space. Document the behavior and run the focused tests, typecheck, and full suite.

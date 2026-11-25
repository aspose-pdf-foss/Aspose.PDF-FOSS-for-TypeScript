# Rotated detected-table edits

A caller can use `Remove()` and `Replace(builder)` on an untagged single-page table at the angle reported by `GetTables()`. The table's top-left corner, width, and height limit are measured along its own axes. The replacement is painted at the captured angle even if the caller modifies the public snapshot.

The edit planner compares the table's cells with live glyphs, paths, images, and annotations in the table's coordinate system. Unrelated marks in the corners of the page-space bounding box can survive. Ambiguous ownership or a failed redraw aborts the transaction. Shared content streams and repeated Form drawings retain the existing copy-on-write behavior.

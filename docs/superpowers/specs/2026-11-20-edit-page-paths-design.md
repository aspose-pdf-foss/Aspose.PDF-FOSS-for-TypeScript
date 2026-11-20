# Edit individual page paths

`Page.GetPaths()` returns `EditablePagePath` handles with `Remove()`,
`Recolor({ fill?, stroke? })`, and `Transform(matrix)` (`s2i2.2`). The handles
extend the structural `PagePath` snapshot. Re-enumerate after an edit.
Recolor takes DeviceRGB components from 0 to 1 and targets channels
the terminal operator actually paints. The six-element transform acts in
the same drawing-stream coordinates as `subpaths` and keeps the stroke width.

Use the addressed source operators. Treating the extraction as a painting
recipe would lose dash, alpha, and resources that are absent from `PagePath`.
Keep surrounding operators, use a balanced graphics-state pair for color,
and replay persistent clipping outside that pair when a path also clips.
Removing a painted clip keeps its clip. Removing a clip-only path removes
the clip. Transform changes geometry, including a clip carried by that path.
Re-enumerating after recoloring a painted clip returns the scoped painted draw
followed by the persistent clip-only draw. Each has its own operator span.

Stage byte-local replacements and check the handle before allocating objects.
Raw bytes outside the selected operators survive, including operands that
continue into the next content stream. For Forms, rewrite the selected
invocation at each level to a fresh resource name
and a cloned stream. Copy resource dictionaries where they are owned and
reserve fresh aliases in the applicable inherited scope. A Form that inherits
its resources continues to do so after copying.
This preserves other draws of the same resource, including draws on another
page. Page content addresses use the same stream ordering for reads and writes,
including when `/Contents` refers to an indirect array.

Refuse malformed path objects that interleave unrelated operators. Refuse
editing Form occurrences with structure-parent entries since cloning those
requires updating structure references. Refusal leaves the document intact.

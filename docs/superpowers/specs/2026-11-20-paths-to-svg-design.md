# Export selected page paths to SVG

`page.PathsToSvg(paths: readonly PagePath[]): string` exports selected vector
path snapshots as one standalone SVG (`s2i2.3`). The page supplies its CropBox
and rotation, giving the export the same positions and viewport as `ToSvg()`.
Paths paint in the supplied order. An empty selection produces an empty SVG
with that viewport.

Compose each snapshot's drawing transform with the page's PDF-to-SVG matrix.
Reuse the renderer's path and document serialization. Export captured fill,
stroke, fill rule, and page-space stroke width. Represent a PDF hairline with
a one-pixel non-scaling stroke. When a PDF segment follows a closed subpath,
capture it in a fresh subpath at the closing point so SVG preserves both.

This is a read-only export of the snapshot data. A snapshot can still be
exported after its original draw is edited or deleted. Selection export skips
clip-only paths. Clips, patterns, transparency, and dash, cap, and join
overrides belong to the full graphics state and are outside this export.

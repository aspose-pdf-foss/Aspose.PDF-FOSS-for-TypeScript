# Flatten transparency on selected pages

Expose `Document.FlattenTransparency({ pages, dpi, retainText })` for callers who need an opaque raster of a page without converting the document to an archival standard. Use the existing one-based page range syntax. Omitting the selection processes all pages. Default to 150 DPI and searchable text. Accept positive resolutions through 1200 DPI.

Share the PDF/A-1 flattening algorithm so crop, rotation, live annotations, and glyph geometry follow the existing conversion behavior. Turning off text retention omits the glyphless layer while still checking for tagged content. Report affected page numbers and skip reasons for selected pages. Any signature field, including an empty field, skips the whole selection.

The alternative of running PDF/A conversion would also edit metadata and unrelated resources. A second rasterization implementation would duplicate the geometry and glyph mapping rules.

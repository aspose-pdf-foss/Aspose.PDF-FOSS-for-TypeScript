# HTML and SVG asset bundles

Beads `1t5g.3` adds two in-memory exports for callers who need separate files for serving HTML or SVG. Each call returns an `ExportBundle` with `files: Map<string, Uint8Array>` and `entryPoints: string[]`. Entry points are UTF-8 files, and every generated asset reference resolves relative to the file containing it.

## Output and page selection

`Document.ToHtmlBundle(options?)` writes `index.html` by default. With `split: true` it writes one complete `page-N.html` per selected page. HTML supports the existing semantic and fixed rendering options. Bundle entry points are complete documents, so the bundle options omit `fragment`.

`Document.ToSvgBundle(options?)` writes one `page-N.svg` per selected page using the existing SVG box and annotation options. In both APIs, `pages?: readonly number[]` uses original one-based page numbers. Omitted or empty selection means all pages. An explicit selection preserves caller order and takes the first occurrence of each number. Invalid page numbers raise a range error. An empty document yields an empty combined HTML document, or zero entry points for per-page output.

## Assets and rendering

Each bundle stores identical encoded assets once, under `assets/<sha256>.<ext>`. Paths depend on the bytes and media type and stay stable across changes in page order. HTML and SVG reference the emitted JPEG or PNG directly. Fixed HTML can also reference WOFF fonts and PNG backdrops, following the existing font embedding and backdrop options.

`patchDpi` controls the resolution of raster shading patches in SVG and fixed HTML vector backdrops. It defaults to 144 and accepts positive finite numbers. Native SVG gradients stay vector. For shadings supported by the raster renderer that lack native SVG output, render the shading on transparent pixels at the selected DPI and place the image at the original paint position. Preserve clip, opacity and paint order. SVG viewport, page geometry and source image dimensions are independent of patch DPI. Apply the document's canvas pixel limit before allocating patch pixels. The existing `backdropScale` continues to size full-page HTML backdrops.

## Links and outlines

Use original page numbers for anchor IDs. Resolve local explicit and named PDF destinations against the selected pages. Combined HTML targets `#page-N` and split HTML targets `page-N.html#page-N`. Missing or omitted destinations retain visible text. Fixed output keeps the underlying page content visible and adds clickable regions only for resolved links. URI links follow the existing export rules.

With `outlineNav: true`, add nested bookmark navigation to each HTML entry point. Preserve bookmark order and hierarchy, including linked children of an unlinked parent. Escape titles as text and use the same destination resolver for bookmark links. The existing inline HTML and SVG methods retain their output and defaults.

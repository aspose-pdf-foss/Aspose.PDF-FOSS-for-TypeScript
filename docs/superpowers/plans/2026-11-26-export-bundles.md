# HTML and SVG asset bundle implementation plan

Implement Beads `1t5g.3` against the [bundle design](../specs/2026-11-26-export-bundles-design.md). Track work in Beads. Exercise public document methods in each test group.

## Select pages and build entry points

1. In `test/export-bundle.test.ts`, export a three-page document in combined HTML, split HTML and SVG. Assert entry point names, original numbering, UTF-8 content, caller order and duplicate elimination for `[3, 1, 3]`. Exercise empty selection, an empty document, fractional, zero and out-of-range numbers. Run the focused test before adding the API.
2. Implement selection, file collection and both public bundle options in `src/exportbundle.ts`. Reuse `imageKey` for the SHA-256 digest and `imageExtension` for image content. Expose document methods in `src/document.ts` and types through `src/index.ts`. Use the existing operation context so cancellation and resource errors reach the caller.

## Emit external assets from renderers

1. Use two distinct image streams containing the same picture on different pages. For semantic HTML, fixed HTML and SVG, assert that both references resolve to one file with the expected encoded bytes. Check asset names on a second export with reversed pages. Include embedded fonts, restricted fonts using the fallback stack, and both PNG backdrop modes.
2. Reuse the semantic image sink in `src/htmlsemantic.ts`. Thread an optional asset writer through `src/html.ts`, `src/htmlfixed.ts`, `src/htmlfontembed.ts` and `src/svgrender.ts`. Register encoded bytes where each renderer would create a data URI. Keep the inline renderer path available when no writer was supplied. Scope SVG definition IDs per page in combined fixed HTML so clip and gradient references resolve to their own definitions.

## Rasterize individual shading operations

1. Add a small mesh fixture painted between two vector elements, with a clip and an offset page box. Compare the SVG bounds and PNG dimensions at 72 and 144 DPI, and inspect representative color and transparency samples. Assert surrounding vectors retain their relative paint order. Cover a native gradient, repeated identical patches, non-finite or non-positive DPI and the canvas pixel limit.
2. Reuse the shading painter in `src/raster.ts` to draw the current shading onto a transparent bounded surface in its transformed coordinate system. In the bundle path of `src/svgrender.ts`, register its PNG and emit the image at point-sized bounds with the current clip and alpha applied once. Check limit errors through the public HTML and SVG methods.

## Resolve HTML navigation

1. Test explicit and named local destinations, links back to an earlier selected page, omitted and missing targets, and URI links. Cover tagged and untagged semantic links and fixed-mode hit regions on a rotated CropBox. Exercise nested bookmarks, escaped titles and a non-exported parent with an exported child. Check that each generated local link resolves to a file and anchor.
2. Resolve destinations using the document's page and named-destination data. Pass the selected-page resolver into link handling in `src/docmodel.ts` and fixed rendering. Emit a stable page anchor for each selected page, including textless pages. Build optional navigation from `Document.GetOutlines()` and share the same link mapping with page annotations.

## Verify and publish

Document both methods, options and bundle path handling in `README.md`, update the changelog and module overview, and verify the public type exports. Run the focused bundle tests and existing HTML, SVG, raster shading and semantic image-sink suites. Exercise inline output for images, fonts and shading defaults. Run `npm run typecheck` and `npm test` on the integrated main branch before closing the issue, pushing main and syncing Beads.

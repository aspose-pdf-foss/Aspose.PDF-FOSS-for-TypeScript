# Document thumbnails

Issue: `aspose-pdf-foss-for-ts-nh1t.6`.

## Intent and API

Render every page as a small image for document previews, without requiring
callers to calculate dimensions for differently sized or rotated pages.

Proposed API:

```ts
const images = doc.ToThumbnails({ maxSize: 256 }); // Uint8Array[], PNG by default
const imagesAsync = await doc.ToThumbnailsAsync({ maxSize: 256 });
```

Export `ThumbnailOptions`, extending `Omit<ImageOptions, 'scale' | 'width' |
'height'>`, with a required `maxSize: number`. `maxSize` is a positive safe
integer in pixels. All pages are returned in document order, one encoded image
per page. An empty document returns `[]`.

Each image fits a square of `maxSize` pixels without padding or cropping, with
its longest edge equal to `maxSize`. Small pages can therefore be enlarged.
Preserve aspect ratio subject to rounding to whole pixels, with a one-pixel
minimum per dimension. Use the effective crop box by default, or the media
box when requested, and account for page rotation before fitting.

Forward the existing format, quality, compression, colour mode, background and
annotation options. PNG with an opaque white background is the default, as
for `page.ToImage`. No page selection, file-writing helper, embedded `/Thumb`
mutation, caching or streaming API is introduced.

These API details are the agent's proposal; the issue only specifies
`doc.ToThumbnails({ maxSize })` rendering every page within a bounding size.

## Approaches

Calculate fitted dimensions and reuse the existing raster pipeline (recommended).
This shares rotation, page boxes, annotations, format validation and encoders,
and allocates a thumbnail-sized canvas from the start.

Rendering full-size images and resizing them would add a resampler and allocate
large intermediate canvases. A separate renderer would duplicate drawing and
encoding behavior. Neither is warranted for this helper.

## Implementation constraints

Keep the helper in `raster.ts`, beside the existing multi-page TIFF helper,
with thin `Document` methods. Reuse `pagerender.ts`'s `baseMatrix` for viewport
dimensions rather than copying its rotation logic. Reuse the existing rendering
steps and encoders; add no runtime dependencies.

Validate `maxSize` and output-option combinations before rendering, including
for an empty document. Invalid sizing throws `TypeError`; existing unsupported
format and option combinations retain their existing error types. A viewport
with zero or non-finite dimensions is refused with `TypeError` rather than
silently falling back to an unbounded render. A viewport requiring a non-finite
device scale (such as subnormal point dimensions) is likewise refused with
`TypeError`; floating-point arithmetic cannot render it faithfully. This
additional refusal follows the implementation review's regression case.
Validate viewport dimensions and fitted scales for all pages before rendering.

Both entry points use one generator and the existing operation runners, with
operation name `ToThumbnails`, page numbers in progress events and cancellation
checks between rendering and encoding units. The async entry point yields to
the event loop. Errors and resource-limit refusals propagate; no page silently
disappears from the result. Rendering does not edit the document.

The fitted image uses explicit width and height, as existing `ToImage` does:
the caller states the canvas bound, so the renderer's documented explicit-size
exception to `maxCanvasPixels` applies. Decode and content limits still apply.
The result retains all encoded images, so aggregate output memory grows with
page count. Rendering or encoding one page remains a synchronous work unit.

## Verification and documentation

Use a programmatic fixture with differently sized, coloured pages to verify
page count, order and actual rendered pixels. Cover portrait, landscape,
rotations, nonzero crop origins, media-box selection, fractional dimensions,
one-pixel bounds, enlargement and an empty document. Compare selected output
against direct `ToImage` calls at independently calculated expected sizes.

Cover invalid sizing and output options, viewport refusal before any rendering,
forwarded JPEG/transparent PNG options, unchanged saved document bytes,
sync/async byte agreement, progress identity, pre-abort and cancellation between
pages. Confirm existing load-limit errors are not swallowed.

Update README capabilities, example, API/type rows and export counts, plus
CHANGELOG. Run targeted tests, then `npm run typecheck` and `npm test` before
integration. Follow the repository's merge, issue-close and push workflow.

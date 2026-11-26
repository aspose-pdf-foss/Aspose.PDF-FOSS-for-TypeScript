# Raster pixels and backdrop color implementation plan

Implement the [approved design](../specs/2026-11-26-raster-pixels-design.md) for Beads `1t5g.4`. Use the existing TypeScript renderer in `src/raster.ts`, Node.js 22+, ESM and Vitest. Keep runtime dependencies at zero. Use Beads for tracking. The tasks share one renderer and can be executed in order in the current session with a final branch review.

## Return an owned RGBA buffer

1. Add public-entry tests in `test/raster-pixels.test.ts`. Render a small asymmetric page. Assert width, height, top-left row order, RGBA channel order, `stride === 4 * width` and `data.length === stride * height`. Render the existing half-transparent red fixture over transparent and check its interior is straight red with alpha 128. Mutate one result and compare an independent result and a later render. Run `npm test -- test/raster-pixels.test.ts` and observe the missing methods.
2. In `src/raster.ts`, define `PixelOptions` using the existing geometry, annotation, background and operation-control fields. Define `RasterPixels` with numeric width, height and stride and `data: Uint8Array`. Delegate to `renderCanvas` and `Canvas.toRgba()` through one shared step generator. Drive the public methods in `src/page.ts` with the existing sync and async operation drivers. Export the types through `src/index.ts`.
3. Compare sync and async bytes. Cover rotated crop and media boxes, explicit target dimensions, annotation suppression, pre-abort and cancellation after rendering. Confirm that a page-derived allocation exceeding `maxCanvasPixels` fails before allocation. Preserve the existing policy for two caller-supplied dimensions. Run the focused tests and typecheck.

## Seed the page canvas with the backdrop

1. Extend the pixel tests to compare every pixel against decoded PNG for white, transparent, opaque RGB and fractional RGBA. On a blank page, `[0.2, 0.4, 0.6, 0.5]` must yield `[51, 102, 153, 128]`. Exercise a multiply blend over a nonwhite backdrop and assert the expected composited color. Run the tests before adding tuple support.
2. In `src/raster.ts`, define a shared `RasterBackground` type and normalize it once per render operation. Validate tuple length and all components before allocating a canvas. Reject invalid shapes and nonnumeric components with `TypeError` and out-of-range or nonfinite numeric components with `RangeError`. Initialize only the page canvas with the resolved color. Use its alpha when selecting RGB or RGBA samples and validating output formats and modes. Keep the existing fast paths for default white and transparent.
3. Exercise the separate frame path in `Document.ToTiff()` and the options passed through `Document.ToThumbnails()`. Check both pages of a multipage TIFF, one thumbnail, opaque RGB acceptance, and alpha rejection for JPEG, BMP, GIF and reduced-color output. Verify invalid backdrop input and combinations fail before painting. Run the focused pixel, transparency, format, mode, document TIFF and thumbnail tests.

## Publish the contract and verify

Document both methods, option and result types, byte layout and examples in `README.md`. Record the public capability in `CHANGELOG.md` and update the renderer description in `CLAUDE.md`. Run the README API check for export counts. Review the branch, integrate into `main`, run `npm run typecheck` and `npm test` there, then push and sync the verified issue closure.

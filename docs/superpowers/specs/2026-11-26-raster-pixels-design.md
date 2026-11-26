# Page raster pixels and backdrop color

Beads `1t5g.4` gives callers direct access to the pixels used by the page renderer. A caller can composite or edit those pixels in memory and choose the backdrop against which PDF paint and blend modes operate.

## Public contract

`Page.ToPixels(options?: PixelOptions): RasterPixels` and `Page.ToPixelsAsync(options?: PixelOptions): Promise<RasterPixels>` return `{ width, height, stride, data }`. Width and height are in pixels. Each result owns a fresh `Uint8Array` with four bytes per pixel in red, green, blue, alpha order. The origin is the top left. Rows run left to right with `stride = width * 4` bytes and no padding. Color channels use straight alpha, so half-transparent red has red 255 and alpha 128. Editing the result has no effect on the document or another result.

Pixel options share the existing crop/media box, scale, explicit dimensions, annotation, progress and cancellation controls. Sizing and canvas limits follow the existing raster path. Encoded output keeps its format and color-mode options.

`background` accepts `'white'` (default), `'transparent'`, a readonly RGB tuple, or a readonly RGBA tuple. Components are finite numbers from 0 to 1, inclusive. RGB implies alpha 1. The main page canvas starts at that color before painting. Transparency groups, masks and tiling cells keep their own initialization rules.

A backdrop with alpha below 1 requires an alpha-capable encoded output. The existing RGB-mode PNG and TIFF paths support it. JPEG, BMP, GIF, grayscale and bilevel output follow their existing transparency rejection rules. Page encoders, document TIFF and thumbnails use the same backdrop semantics.

## Approach and verification

Reuse the float canvas, page interpreter and existing conversion to 8-bit samples. Direct conversion avoids a PNG encode/decode round trip and gives raw and encoded exports the same rounding. Seeding the canvas lets multiply blends and non-isolated groups read the chosen color while painting. Compare raw bytes with decoded PNG pixels and check independent expected colors to verify both rendering and layout.

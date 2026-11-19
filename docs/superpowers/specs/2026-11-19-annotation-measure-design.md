# Rectilinear annotation measurements

Beads issue `k4h1.3` adds read and write support for PDF rectilinear `/Measure` metadata on line, polyline, and polygon annotations. The annotation builders accept `measure`, and their live handles expose writable `Measure`. `undefined` removes the dictionary. [PDF 32000-1, Tables 175, 178 and 261–263](https://opensource.adobe.com/dc-acrobat-sdk-docs/pdfstandards/PDF32000_2008.pdf).

`RectilinearMeasure` has a `scaleRatio` display string and the required `xAxis`, `distance`, and `area` number-format arrays. `yAxis`, `angle`, `slope`, `origin`, and `yToX` represent the optional PDF entries. Each `MeasureNumberFormat` carries a `unit` label and `conversionFactor` plus optional fractional formatting, separators, and label placement. Order matters when a value uses multiple units.

## Approach

The approved shape mirrors PDF’s ordered format arrays with named TypeScript properties. A single scale value would cover uniform drawings and would need extra conventions for distinct axes and mixed units. The full rectilinear fields let callers edit a calibration they read from an existing annotation. `LineAnnotation` and `PolyAnnotation` are exported so callers can narrow `Page.Annotations` handles after opening a PDF.

The codec reads indirect dictionaries and entries, accepts an omitted subtype as rectilinear, and decodes PDFDocEncoding or UTF-16BE text. A malformed or unsupported dictionary is still available through `Dict`. Read values are snapshots. Authoring validates the whole measurement before changing the annotation or attaching a new one. It declares PDF 1.7 in the catalog of an older document so incremental saves can preserve the original header. It preserves the annotation’s geometry, intent, and appearance.

The implementation uses strict TypeScript, ESM `.js` import specifiers, and zero runtime dependencies.

# Third-party notices

`@asposefoss/pdf` itself is MIT licensed (see `LICENSE`) and has no runtime
dependencies from npm. It does, however, **embed third-party font data** in the
published package, and those fonts carry their own licenses.

`dist/std14data.js` holds deflate-compressed, base64-encoded TrueType outlines
for the 14 Standard-14 substitute faces. They are what lets `page.ToImage()`
rasterize non-embedded text as real glyphs. The raw `.ttf` files are not
shipped; the generated data is. Provenance and checksums for every file live in
`fonts/SOURCES.md` in the source repository.

## Liberation 2.1.5 — SIL Open Font License 1.1

Metric-compatible substitutes for the Helvetica, Times and Courier families
(12 faces). Full license text: `fonts/LICENSE-OFL.txt`.

- Source: https://github.com/liberationfonts/liberation-fonts (release 2.1.5)

## URW base35 — AGPLv3 with font exception

Canonical Ghostscript substitutes for Symbol (`StandardSymbolsPS`) and
ZapfDingbats (`D050000L`). Full license text: `fonts/LICENSE-URW-AGPL.txt`.

- Source: https://github.com/ArtifexSoftware/urw-base35-fonts

The exception reads:

> As a special exception, permission is granted to include these font programs
> in a Postscript or PDF file that consists of a document that contains text to
> be displayed or printed using this font, regardless of the conditions or
> license applying to the document itself.

So a PDF you generate with this library that embeds Symbol or ZapfDingbats
outlines is unencumbered by the AGPL, whatever license that document carries.

If you would rather not distribute the URW data at all, drop the two
`StandardSymbolsPS`/`D050000L` entries from the `MAP` table in
`scripts/gen-std14-fonts.mjs` and re-run `npm run gen:fonts`. Editing the
table is the necessary step: the generator reads every file the map names with
no existence check, so merely deleting the `.ttf` files makes it throw.
Symbol and ZapfDingbats then fall back to a placeholder box when rasterized.

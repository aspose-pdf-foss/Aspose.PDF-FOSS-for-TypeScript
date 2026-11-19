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

## Adobe glyph-name mappings — BSD 3-clause

`src/encoding.ts` includes the subset of Adobe Glyph List 2.0 and ITC Zapf
Dingbats Glyph List 2.0 used by the supported standard name vectors.
Source: https://github.com/adobe-type-tools/agl-aglfn (`glyphlist.txt`,
`zapfdingbats.txt`; table version 2.0, September 20, 2002).

Copyright 2002-2019 Adobe (http://www.adobe.com/).

Redistribution and use in source and binary forms, with or
without modification, are permitted provided that the
following conditions are met:

Redistributions of source code must retain the above
copyright notice, this list of conditions and the following
disclaimer.

Redistributions in binary form must reproduce the above
copyright notice, this list of conditions and the following
disclaimer in the documentation and/or other materials
provided with the distribution.

Neither the name of Adobe nor the names of its contributors
may be used to endorse or promote products derived from this
software without specific prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND
CONTRIBUTORS "AS IS" AND ANY EXPRESS OR IMPLIED WARRANTIES,
INCLUDING, BUT NOT LIMITED TO, THE IMPLIED WARRANTIES OF
MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR
CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL,
SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT
NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES;
LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION)
HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN
CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR
OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF THIS
SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
# Ghostscript example test inputs

`test/fixtures/postscript-oracle/inputs/upstream-tiger.eps` and
`upstream-colorcir.ps` are unchanged examples from ArtifexSoftware/ghostpdl
commit `9a39d68ca934f8e9343f46a2803e765122a3b4a9` (10.07.1).
Upstream includes the examples under AGPL-3.0-or-later. The applicable
`LICENSE.ghostpdl` and `COPYING.ghostpdl` are retained beside the corpus.
These test inputs are excluded from the published package.


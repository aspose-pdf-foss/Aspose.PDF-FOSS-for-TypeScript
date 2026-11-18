# PostScript graphics fixtures

`composite.ps` is an original, hand-authored integration fixture for `lw8w.2`.
It combines a clipped cubic stroke, native CMYK, a two-pixel RGB image and a
colored tiling pattern inside a translated Form. No third-party artwork or
generated binary output is included.

The operator inventory follows the approved design, using the .NET converter
at commit `10a36383` as an inventory reference. Operand and EOF rules follow
Adobe's *PostScript Language Reference*, third edition, particularly chapters
3, 4 and 8: https://www.adobe.com/jp/print/postscript/pdfs/PLRM.pdf.
The reference converter's permissive fallbacks are not semantic oracles.

Tests assert literal geometry, matrices and image samples and separately use
this library's renderer for visual samples. Flattened geometry uses
`flatness * 72 / 250` device points; clip boundary keys use 1e-8-point tolerance.
Twelve-bit PostScript samples expand to sixteen-bit PDF components.
Device conversion uses identity black generation/UCR and additive-black CMYK.

qpdf 12.3.2 is used to check generated PDF structure. It is not a visual oracle.
Ghostscript and MuPDF were not executed; no independent visual conformance
claim is made.

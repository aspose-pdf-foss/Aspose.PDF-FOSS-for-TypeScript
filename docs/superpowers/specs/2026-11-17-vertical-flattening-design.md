# Vertical text in transparency flattening

Issue `aspose-pdf-foss-for-ts-izia`.

## Intent

Extend the existing opt-in PDF/A-1 transparency flattener to pages containing
vertical text. Preserve their extracted Unicode, reading order, font sizes,
pen spans and selection geometry while replacing visible page content with the
existing opaque raster. The current vertical-writing refusal protects those
properties and is removed only with regression coverage for the replacement.

## Existing path

`pdfaflatten.ts` collects `GlyphEvent` records before rendering. It builds an
invisible text layer through the embedded font in `glyphless.ts`, then installs
the complete page content and resources before yielding. The font is currently
`Identity-H`, and `GlyphlessCodes.encode` assigns one code per Unicode code point.
Horizontal reconstruction uses a font size of one and carries the source size
in its text matrix. Vertical extraction derives the selection cell width from
the font size and its advance from the writing mode and CIDFont metrics, so it
needs its own reconstruction path.

## Approaches

Use separate horizontal and vertical glyphless font resources on each flattened
page. A vertical code represents one source glyph's complete Unicode string and
effective vertical advance. This is the proposed implementation choice. It
allows identical Unicode strings with different advances to receive different
codes while sharing the existing empty TrueType glyph program.

Reusing the existing code-per-character assignment in a vertical font would
require distributing one source glyph across several selection cells when its
ToUnicode result contains several code points. Changing the font size to fit a
uniform vertical advance would also change cell width and ordering tolerances.
Those approaches conflict with the issue's geometry and font-size requirements.

## Font representation

Retain the current horizontal font and OCR code-assignment contract. Add an
internal vertical assignment path keyed by the full Unicode string and its
effective advance in em units. Repeated identical pairs reuse a code. The same
string with a different advance receives a distinct code. Codes start at one
and stay within the two-byte Identity range. Capacity and finite-number checks
run before an assignment mutates its tables.

The vertical Type0 font uses `Identity-V`, the embedded glyphless TrueType
program, a complete ToUnicode map and the existing CID-to-GID mapping to GID 1.
Its CIDFont declares `DW2 [880 -1000]` and explicit W2 triples for its codes.
Each triple contains the effective vertical advance multiplied by 1000, a
horizontal position vector of 250 and a vertical position vector of 880. The
position vector locates an empty outline. The advance determines the pen span.
Retain the horizontal width of 500 to match the embedded program.

Reuse the font builder, ToUnicode writer and font-program cache. Exact internal
method signatures and whether the code tables share an implementation are left
to the implementer. Allocate only font resources used by the page and finish
every installed font before the next cancellation checkpoint.

## Vertical reconstruction

Emit one show operation per source vertical glyph, mapping its complete Unicode
string to one CID. Set the source `tfSize` as the font size. Preserve the linear
part of `mul(g.tm, g.ctm)` in the new text matrix. This retains form transforms,
rotations, shear, reflection and the effective font size without dividing by
the glyph advance or inserting it into a matrix basis.

The rise-adjusted starting pen is recoverable from the existing event. Its X
coordinate is `(quad[0] + quad[2]) / 2`. Its Y coordinate is
`quad[1] + quad[3] - penEnd[1]`. Use that point as the text matrix translation.
This works for downward, upward and zero advances and for transformed forms.

For a nonzero source font size, W2 stores `1000 * g.advance`, with character
and word spacing already folded into that value by `emitGlyphs`. Reset Tc and
Tw for this show so spacing is applied once. Preserve the writing mode and
source font size even for zero or positive advances. A source size of zero
keeps size zero and carries its effective source spacing in Tc, since its
metric displacement is zero. Reuse the existing word-space semantics when
determining that spacing. Reject non-finite generated operands before page
replacement. Do not introduce a singular matrix for a nonsingular source.

Keep glyph emission in source traversal order, switching fonts and text state
as needed between writing modes. The existing extraction algorithms then apply
their own vertical-column and mixed-direction ordering. The horizontal path
continues to carry signed advances in Tz and resets spacing after a vertical
show. Glyphs with no extractable Unicode retain the existing skip behavior.

## Integration

Remove the vertical-writing page refusal after font and text-layer tests pass.
Keep the existing conversion option, raster placement, page atomicity,
reachability cleanup and preservation rules. Tagged content, signed documents,
conflicting preservation settings and annotation appearances that inherit page
resources continue through their established handling. This feature adds no
public option, package export or runtime dependency.

Update README's vertical-writing limitation, CHANGELOG's Added section and the
relevant CLAUDE.md architecture entries when implementation lands.

## Verification

Replace the existing vertical-refusal regression with a successful conversion
that preserves the same mixed-direction text and selection geometry. Add
focused fixtures with known source coordinates and advances covering repeated
Unicode at different W2 advances, defaults from DW2, character/word spacing,
TJ adjustments, zero and positive advances, different font sizes, rise,
multiple Unicode code points per glyph and astral characters.

Exercise nested Form XObjects, repeated form placement, nontrivial transforms,
page rotation and offset CropBox values. Use the existing embedded ink font
fixture to make the original vertical text visible. Compare rendering at the
chosen flattening resolution and check original glyph text, effective size,
writing mode, quads and pen ends within serialization precision. Verify both
live and saved/reopened documents, GetText ordering, Search geometry and PDF/A-1
validation. Check that matrices keep the source determinant when source font
size and pen advance are independent.

Keep existing horizontal, OCR and cancellation tests green. Verify a partial
async run leaves complete vertical font mappings on installed pages. Deliberate
regressions to Identity-H, uniform W2, code-point splitting or normalized font
sizes must fail the focused checks. Run the repository's typecheck and full
suite before delivery.

These fixtures establish agreement with known PDF coordinates and this
library's extraction and rendering. Independent viewer selection behavior is
an additional verification source if a suitable viewer is available.

## Reference

Adobe's font API documents DW2's default vertical metrics and W2's per-CID
position and displacement vectors. The per-source-glyph mapping and matrix
reconstruction above are implementation choices derived from this repository's
GlyphEvent contract. [Adobe Acrobat font reference](https://opensource.adobe.com/dc-acrobat-sdk-docs/acrobatsdk/apireference/PDFEdit_Layer/PDEFont.html).

# Lossless JBIG2 optimization

Issue: `aspose-pdf-foss-for-ts-nh1t.1`. The user delegated design and implementation.

## Intent and approach

Add `doc.Optimize({ jbig2: true })` as an explicit lossless concern. Promoting
the fixture encoder is the smallest useful approach: template-0 arithmetic
generic regions with typical-row prediction, without symbol matching or pixel
preprocessing. Default-on encoding would add work to existing calls; adding it
to `images` would mix lossless compression with the existing lossy JPEG API.
The opt-in choice is the implementer's decision, authorized by the user.

## Contract

`jbig2` defaults to false. It visits indirect image XObjects once, independently
of placements: no downsampling means no CTM or effective-DPI measurement is
needed. Support 1-bit DeviceGray images and 1-bit image-mask stencils (including
an omitted stencil bit depth), stored raw or through byte filters. Existing
image codecs (CCITT, JBIG2, JPEG and JPX), other color spaces, external streams,
invalid dimensions and incorrectly sized decoded planes are left unchanged with
a reason. TIFF predictor 2 is declined because the existing predictor decoder
reconstructs bytes rather than packed 1-bit components. Inline images are
outside this pass. A document declaring PDF/A-1 is
declined because its rules prohibit JBIG2. Retain any existing PDF version floor
by raising a catalog version below 1.4 only after a successful replacement.

Packed samples are MSB-first with byte-padded rows; zero is encoded as JBIG2
black. Ignore unused row-padding bits. The encoder consumes packed samples
directly, avoiding a width-times-height intermediate bitmap, and enforces the
document's image-pixel limit before encoding. The output has a page-information
segment and one immediate-lossless generic-region segment, associated with page
1, no standalone file header or end-of-page/file segments, and an arithmetic
termination marker. T.88 sections 6.2, 7.4.6, 7.4.8 and Annexes D/E define it.

Copy the source dictionary and replace only Filter, Length and old filter
parameters (DecodeParms/DP). Preserve Decode, ColorSpace, masks, metadata,
optional-content and every unrelated key. Install at the original object number
only when the complete JBIG2 payload is strictly smaller. Preserve the signed
document refusal. The existing JPEG report and `lossy` semantics do not change.

`OptimizeReport.jbig2` contains `images: ImageOptimization[]`,
`skippedImages: SkippedImage[]`, and `bytesSaved: number`, with empty arrays and
zero when disabled. Include its savings in the overall bytesSaved estimate.
Both Optimize and OptimizeAsync share the generator pass, which yields between
images; an image remains an atomic work unit as in the JPEG concern.

## Validation and limits

Use TDD for the encoder and integration. Check known bitmap samples, odd widths,
uniform and repeated rows, deterministic noisy inputs, small-image size refusal,
filter parameters and dictionary preservation, default-off and mixed JPEG use,
PDF/A-1 refusal, pixel-limit propagation, shared references, signed refusal and
cooperative cancellation. Pin fixture encoder arithmetic output as a promotion
fence, and cross-check emitted streams with an independent PDF.js decoder during
development. Keep that oracle outside runtime dependencies. Run typecheck and
the full suite on the feature branch and main before closing the issue.

Final review added regressions for namespace-equivalent PDF/A identification
(attribute, element and entity forms) and direct/indirect TIFF predictor
parameters. Both findings were reproduced red before the guard corrections.

## References

- [ITU-T T.88](https://www.itu.int/rec/dologin_pub.asp?id=T-REC-T.88-200002-S!!PDF-E&lang=e&type=items)
- [ISO 32000-1:2008, 7.4.7](https://opensource.adobe.com/dc-acrobat-sdk-docs/pdfstandards/PDF32000_2008.pdf)

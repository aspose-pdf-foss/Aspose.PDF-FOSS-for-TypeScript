# Brotli stream filter

**Issue:** nh1t.4. **Approved approach:** extend the existing `streamFilter`
option, with automatic bounded decoding and PDF 2.0 extension metadata.

## Intent and approach

Read `/BrotliDecode` streams through `node:zlib` under the existing
`LoadLimits` and `DecodeBudget`; write them only when explicitly requested by
`Save({ streamFilter: 'BrotliDecode' })` or `encodeStream(bytes, 'BrotliDecode')`.
Extending the current filter pass shares its eligibility, replacement and
filter-before-encryption rules. A separate boolean would duplicate that API;
changing the default compression would reduce compatibility. No dependencies
or default encoding changes are needed.

## Decoding

Use `brotliDecompressSync` with the chain's cap as `maxOutputLength` (one-byte
overshoot, as for Flate). Translate an output-cap refusal through the budget
so per-stream, ratio, total and page-content limits retain their public error
types and units. Apply TIFF/PNG predictors after decompression. Filter chains
keep the existing whole-chain input denominator and terminal image behavior.
Damaged Brotli remains a decode failure; `partial` enables Flate salvage only.

## Encoding and declaration

Add `BrotliDecode` to `StreamFilterName`, encoding and byte-filter eligibility.
The existing pass replaces eligible chains and clears their predictor parms;
ASCII armor can wrap Brotli without discarding parms. Metadata, structural and
image-codec streams retain existing exemptions.

On explicit Brotli save, the copied catalog declares `/Version /2.0` and
`/Extensions /PDFa` with `/BaseVersion /2.0`, `/ExtensionLevel 1`,
`/ExtensionRevision (2026)` and
`/URL (https://pdfa.org/resource/extension-brotli)`. Preserve other extension
entries, including indirect dictionaries, without mutating live objects.
Emit a PDF 2.0 header. Existing linearized, incremental and sign-on-save
restrictions for `streamFilter` continue to apply. Compression of writer-owned
xref/object streams remains unchanged.

## Validation and scope

Review integration: PDF/A and PDF/X validators report Brotli streams as
unsupported, including PDF/A inline images, so conversion cannot claim success
with an unhandled Brotli extension. Automatic conformance transcoding is outside
this change. Existing save-copy decode-policy loss is tracked separately as
`vhks` (it predates Brotli and affects LZW/RunLength replacement too).

Test plain and chained decoding, predictors, empty and damaged input, exact
limits, early refusal, total accounting and page content; verify encoding with
Node's independent decompressor. Test classic/compressed/encrypted save,
extension preservation, input immutability, defaults and exemptions.
Update README and CHANGELOG, run typecheck and the full suite before merging,
then run both gates on main, close the issue, push main and sync Beads.

## References

- [PDF Association extension registry](https://pdfa.org/extensions/)
- [Brotli specification page](https://pdfa.org/resource/extension-brotli/)
- [Node zlib API](https://nodejs.org/api/zlib.html)
- [PDFium predictor support](https://pdfium.googlesource.com/pdfium.git/+/c929c947c3e1c2b63e3d38a6224ab962be427dc9)

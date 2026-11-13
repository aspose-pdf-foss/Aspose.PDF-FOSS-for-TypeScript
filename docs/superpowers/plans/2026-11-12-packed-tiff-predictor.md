# Packed TIFF Predictor Implementation Plan

**Issue/spec:** 83me. Predictor 2 reverses horizontal differences per sample,
modulo `2^BitsPerComponent`, using the preceding pixel's same color component.
**Goal:** Correct packed 1/2/4-bit samples and 16-bit PDF samples without changing
PNG predictors, 8-bit results, input bytes or decode-budget behavior.
**Architecture:** Keep a byte fast path for 8 bits; reconstruct packed samples
in place on an output copy, and 16-bit samples as big-endian words with carry.
Resolve image DecodeParms scalar references before the shared byte-filter path.
Remove the JBIG2 guard whose sole reason was the old Predictor 2 defect.
**Tech stack:** TypeScript, existing filters/TIFF/JBIG2 modules, vitest.
**Execution:** Inline, systematic-debugging and TDD; progress in Beads.

## Constraints and review focus

Preserve row padding and incomplete-row suffixes. Process only complete rows
and actual components; allocate from input length, never declared dimensions.
Invalid TIFF predictor dimensions/bit depths refuse with public PdfParseError.
Keep all existing public error and LoadLimits propagation. The 16-bit correction
targets PDF filter samples; adding 16-bit TIFF-container support is outside scope.

## Task 1: Pin component semantics and fix the decoder

Files: src/predictor.ts, test/predictor.test.ts,
test/helpers/predictor-vectors.ts, test/predictor-filters.test.ts.

1. Add hand-derived literal delta/sample vectors at 1/2/4/8/16 bits, with RGB,
   carries, wraparound, padding, multiple rows and an incomplete final row.
2. Add direct filter tests for Flate/LZW/Brotli and image tests for direct and
   indirect DecodeParms (including scalar references), source immutability and
   existing per-stream bounds. Confirm failures before implementation.
3. Implement component arithmetic and shallow resolved parameter copies in
   src/imagedecode.ts. Run targeted tests, expecting all passing.

## Task 2: Integrate TIFF containers and bilevel optimization

Files: test/predictor-tiff.test.ts, src/bilevelopt.ts, test/optimize-jbig2.test.ts,
README.md, CHANGELOG.md.

1. Add standalone low-bit TIFF fixtures in both container byte orders. Change
   the explicit temporary skip tests to assert correct all-white samples before
   and after optimization and save/reopen. Observe failures before enabling.
2. Remove the obsolete guard; preserve all other eligibility and size checks.
3. Update docs, run typecheck and focused tests, obtain a fresh read-only review,
   and run the full suite. Merge and run both required main gates. Only then
   close 83me, push main, sync Beads and remove the merged fix branch.

## Reference

[TIFF 6.0 section 14](https://download.osgeo.org/geotiff/spec/tiff6.pdf)
describes unpacking components, differencing them and repacking them, including
separate color-channel strides and component widths above eight bits.

# Lossless JBIG2 Implementation Plan

Use superpowers:executing-plans inline, with test-driven-development.

**Goal:** Add opt-in, sample-preserving JBIG2 optimization for bilevel images.
**Architecture:** A packed-sample encoder (`jbig2encode.ts`) promotes only the
MQ and generic-region encoding needed from the dev codec. A separate
`bilevelopt.ts` pass owns eligibility, dictionary replacement and reporting.
`optimize.ts` delegates to it before dedup/recompression.
**Tech stack:** TypeScript, NodeNext ESM, vitest; zero runtime dependencies.
**Spec:** `docs/superpowers/specs/2026-11-11-jbig2-lossless-design.md`.

## Global constraints

Opt-in `jbig2?: boolean`; preserve existing JPEG behavior and signed refusal.
No lossy preprocessing or symbol substitution. Only smaller replacements.
Public errors and rethrowLimit first in every catch. Use bd for task tracking.
Leave unrelated user changes untouched. Merge to main and verify before closing.

## Review focus

Non-byte-aligned rows must not mix padding into the next row. Stencil polarity
and explicit Decode arrays must survive. Existing codecs and PDF/A-1 must be
declined. Tight pixel bounds must propagate rather than become skip reasons.
Async cancellation must leave a valid graph after any completed image.

## Task 1: Packed-sample encoder

Create `src/jbig2encode.ts` and `test/jbig2-encode.test.ts`.
Interface: `encodeJbig2(width: number, height: number, samples: Uint8Array,
limits?: LoadLimits): Uint8Array`, internal module export, not index.ts.

Write failing tests for known sample decoding, byte-padding independence,
uniform/repeated/noisy planes, invalid sizes and pixel limits. Pin the existing
arith_gb0 vector's region payload (plus the termination marker) to detect
promotion drift. Run `npx vitest run test/jbig2-encode.test.ts` and observe red.
Promote the MQ encoder using the existing jpxmq QE table. Encode template 0
directly over inverted packed samples; write page info and type-39 region
segments. Re-run the tests to green, then commit the encoder and tests.

## Task 2: Optimization concern

Create `src/bilevelopt.ts`, `test/optimize-jbig2.test.ts` and
`test/helpers/build-bilevelopt-pdf.ts`; modify `src/optimize.ts`.
Interface: `optimizeBilevelImagesSteps(doc, context)` returns
`OperationSteps<{ images: ImageOptimization[]; skippedImages: SkippedImage[];
bytesSaved: number }>`; OptimizeOptions adds jbig2 and OptimizeReport adds its
matching report. No changes to other exported function signatures.

Write integration tests exercising raw/Flate/LZW byte-filter sources, stencil
and Decode preservation, odd widths, small-image refusal, invalid metadata,
existing codec refusal, PDF/A-1, pixel limits, shared references, signed inputs,
mixed JPEG options, default-off behavior, sync/async equivalence and cancellation.
Run the file to observe red. Implement the generator, copy-then-replace dict
policy, catalog version floor and orchestration/report accounting. Run the
encoder, integration, imageopt, optimize and control-optimize tests to green.

## Task 3: Documentation, review and delivery

Update README's Optimize example, option table, report reference and scope;
update CLAUDE's module overview and CHANGELOG's Unreleased Added section.
Cross-check the encoder through independent PDF.js code without adding a runtime
dependency. Mutate the polarity and size-guard branches and confirm red tests,
then restore. Review the complete diff against the spec. Run
`npm run typecheck` and `npm test` (both exit 0), commit, merge to main, run both
again on main, close nh1t.1, push main, sync Beads, and remove the feature branch.

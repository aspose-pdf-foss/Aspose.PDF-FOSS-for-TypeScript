# Brotli Stream Filter Implementation Plan

**Goal:** Decode Brotli streams within load limits and add opt-in save encoding.
**Architecture:** Extend filters.ts and streamfilter.ts; serializer.ts declares
the PDF 2.0 extension on copied output objects.
**Tech Stack:** TypeScript, node:zlib, vitest; zero runtime dependencies.
**Spec:** ../specs/2026-11-12-brotli-stream-filter-design.md
**Execution:** Inline, using executing-plans and TDD. Progress tracked in Beads.

## Global constraints

Keep existing function signatures, `.js` imports, public limit errors and
whole-chain budgets. Never mutate live objects during save. Encoding is opt-in.

## Review focus

Predictor alignment in chains; early allocation bounds; exhausted total/content
budgets; indirect extension dictionaries; save/reopen without model mutation.
Each is included in the corresponding tests below.

## Task 1: Bounded codec

Files: src/filters.ts, test/brotli-filter.test.ts,
test/helpers/build-brotli-stream.ts.
Interfaces: existing decodeStream/applyDecodeFilters/encodeFilter/encodeStream.

1. Write tests for Node-authored Brotli, ASCII85 chains, PNG/TIFF predictors,
   empty/damaged payloads, independent decode of encoding, exact byte cap,
   early overshoot, ratio, total, content and unlimited policies.
2. Run `npx vitest run test/brotli-filter.test.ts`; expect unsupported-filter
   failures before implementation.
3. Add bounded Brotli decode and explicit encode branches with existing budget
   handling; run the same command, expecting all passing.

## Task 2: Save integration and documentation

Files: src/streamfilter.ts, src/serializer.ts,
test/brotli-save.test.ts, README.md, CHANGELOG.md.
Interfaces: StreamFilterName gains BrotliDecode; SerializeOptions unchanged.

1. Write save tests for all four classic/compressed/encrypted combinations,
   exemptions, ASCII wrapping and replacement of Brotli, preserved indirect
   extensions, output declarations, default encoding and immutable source.
2. Run `npx vitest run test/brotli-save.test.ts`; expect unsupported target and
   missing declaration failures.
3. Extend eligibility and add the declaration on the write plan. Update docs
   and changelog. Run both Brotli tests plus existing streamfilter/limit tests.
4. Run `npm run typecheck` and `npm test`; expect exit 0. Commit and review the
   complete branch, merge into main and rerun both gates. Close nh1t.4 only
   after main passes; push main and `bd dolt push`.

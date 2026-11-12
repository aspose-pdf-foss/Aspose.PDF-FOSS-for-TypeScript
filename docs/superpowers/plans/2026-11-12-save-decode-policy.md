# Save Decode Policy Implementation Plan

**Issue/spec:** vhks: save-plan stream copies must retain the source's decode
policy and share its once-per-logical-stream total accounting.
**Goal:** Preserve strict and explicitly relaxed LoadLimits during re-filtering.
**Architecture:** Register remapped streams as aliases of the source's registry
entry. DecodeBudget resolves accounting identity through that registration;
ordinary registration establishes a distinct stream in its receiving document.
**Tech stack:** TypeScript, node:zlib, vitest, no new dependencies.
**Execution:** Inline with systematic-debugging and TDD; progress in Beads.

## Constraints and review focus

No new public API; no live object or payload mutation. Unregistered streams
retain the existing default policy. Check strict per-stream/ratio/chain limits,
shared totals, source-first and copy-first reads, repeated save plans, async
save, explicit unlimited/null policies and re-registration in another budget.

## Task 1: Reproduce and preserve the registration

Files: test/helpers/build-save-budget-pdf.ts, test/limits-save.test.ts,
src/decodebudget.ts, src/serializer.ts.

1. Build Node-authored Flate fixtures with multiple streams and nested filters.
2. Add save regressions for LZWDecode, RunLengthDecode and BrotliDecode, plus
   accounting identity and budget-ownership tests through planDocument.
3. Run `npx vitest run test/limits-save.test.ts`; expect bypassed-limit,
   missing-accounting and default-policy failures.
4. Add internal `registerStreamCopy(copy: PdfStream, source: PdfStream): void`.
   Its registration inherits the source budget and accounting identity without
   creating a default registration for an unregistered source. Use this in
   remap's stream branch; use canonical identity in cap/check/charge.
5. Run the new tests and existing filter/acquisition/Brotli tests, expecting
   all passing. Update README and CHANGELOG in the fix commit.

## Task 2: Review and integrate

Run typecheck and the full suite on the branch. Review accounting identity,
policy ownership and save-copy behavior. Merge into main, rerun both required
gates there, then close vhks, push main and sync Beads. Preserve unrelated
workspace changes and remove the merged fix branch.

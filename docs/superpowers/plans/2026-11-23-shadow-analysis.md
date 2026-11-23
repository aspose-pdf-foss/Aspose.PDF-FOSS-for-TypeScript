# Signed-page appearance analysis implementation plan

Implement the [signed-page appearance design](../specs/2026-11-23-shadow-analysis-design.md) under `eent.2` using TypeScript, the existing raster renderer, and Vitest. Keep runtime dependencies at zero and use Beads to track the work.

1. In `test/shadowanalysis.test.ts`, exercise `classifyShadowAppearance` with synthetic RGB samples for suppression, substitution, overlay, and addition. Exercise the page comparison with independently rendered unsigned snapshots. In `test/verify.test.ts`, pin opt-in analysis for valid signed versions and absence for invalid signatures.
2. Implement the pixel and page comparison in `src/shadowanalysis.ts`. Reuse `renderPageRgb` and thread the optional base-content render through `src/raster.ts` and `src/pagerender.ts`. Keep failure and load-limit handling consistent with signature verification.
3. Type the option and result in `src/sigverify.ts`, wire the signed revision in `src/document.ts`, and update the package exports, README, changelog, and module overview.
4. Run the focused tests, `npm run typecheck`, and `npm test`. Integrate on `main`, repeat the full gates, and sync the code and issue.

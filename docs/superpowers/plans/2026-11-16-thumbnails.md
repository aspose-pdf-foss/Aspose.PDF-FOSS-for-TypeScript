# Document Thumbnails Implementation Plan

> Execute inline using superpowers:executing-plans. Track work in Beads;
> repository instructions override skill checklists and scratch ledgers.

**Goal:** Render every page within a caller-supplied pixel bound.

**Architecture:** Fit the rotated viewport from `baseMatrix`, then delegate to
the existing raster rendering steps. One generator powers sync and async
Document methods and preserves operation identity and cancellation.

**Tech Stack:** TypeScript, Node built-ins, vitest; zero runtime dependencies.

**Spec:** `docs/superpowers/specs/2026-11-16-thumbnails-design.md` (approved).

## Global Constraints

Use ESM `.js` imports. Required positive safe-integer `maxSize`; longest edge
equals the bound, including enlargement; other edge rounds to at least one.
Default crop viewport, PNG and white background. Validate all viewports before
rendering. Return images in page order, including `[]` for an empty document.
Reuse ImageOptions except scale/width/height. Never edit the PDF or swallow
resource-limit errors. Async yields between rendering/encoding units.

## Review Focus

1. Empty documents must still reject invalid sizing and format combinations.
2. A later invalid viewport must refuse before the first page renders.
3. Extremely narrow or fractional viewports must produce bounded nonzero images.
4. Runtime width/height/scale keys must not override thumbnail fitting.
5. Cancellation and progress callback errors must retain identity.

## Task 1: Thumbnail API and verification

**Files:** Modify `src/raster.ts`, `src/document.ts`, `src/index.ts`;
create `test/helpers/build-thumbnails.ts` and `test/thumbnails.test.ts`.

**Interfaces:** Export `ThumbnailOptions extends Omit<ImageOptions, 'scale' |
'width' | 'height'> { maxSize: number }`. Internal raster entry points:
`renderDocumentToThumbnails(doc: Document, opts: ThumbnailOptions): Uint8Array[]`
and `renderDocumentToThumbnailsAsync(...): Promise<Uint8Array[]>`.
Document methods: `ToThumbnails(options: ThumbnailOptions): Uint8Array[]` and
`ToThumbnailsAsync(options: ThumbnailOptions): Promise<Uint8Array[]>`.

1. Build coloured pages with literal geometry; write failing tests for page
   count/order/pixels, 120x240 -> 32x64, 240x120 -> 64x32, rotation, crop origin,
   media selection, 10x5 -> 64x32 enlargement, fractional sizing, maxSize=1,
   invalid bounds, empty document validation, invalid later viewport without
   progress, forwarded encoding/annotation options and unchanged Save bytes.
2. Write controls tests for sync/async bytes, operation/page identity, initial
   cancellation, between-page cancellation, real event-loop yielding, callback
   error identity and resource refusal. Test runtime sizing overrides.
3. Run `npx vitest run test/thumbnails.test.ts`; expect missing-method failures.
4. Implement fitting in `raster.ts` beside TIFF export, using `baseMatrix` and
   `renderPageSteps`. Preflight output options and every viewport. Calculate
   the minor edge as `(minor / major) * maxSize` to avoid intermediate overflow.
   Set both fitted dimensions explicitly after spreading caller options.
5. Run the thumbnail tests and typecheck; expect all green. Review all new
   signatures and consumers, including exports and test imports.

## Task 2: Documentation and integration

**Files:** Modify README and CHANGELOG; design/plan remain committed.

1. Add capability, usage example, sync/async API rows and ThumbnailOptions row;
   increment README public type count by one. Add an Unreleased changelog entry.
2. Run `npx vitest run test/thumbnails.test.ts test/readme-api.test.ts` and
   `npm run typecheck`, then `npm test`; expect all green.
3. Commit feature and documentation, obtain one whole-branch code review and
   address material findings with regression tests.
4. Merge into main, rerun both required quality gates there, close nh1t.6,
   push main, sync Beads and delete the merged local/remote feature branch.

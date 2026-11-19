# Annotation Reply Threads Implementation Plan

**Goal** Add `InReplyTo`, `ReplyType`, and `AddReply` to live annotations for `k4h1.1`.

**Architecture** Reuse the annotation model, page membership checks, and text-note builder. Store `/IRT` as an indirect reference and `/RT` as a PDF name.

**Tech stack** Strict TypeScript, ESM `.js` import specifiers, Vitest, and zero runtime dependencies.

**Spec** [Annotation reply threads](../specs/2026-11-19-annotation-replies-design.md).

## Implementation

1. Use `test/helpers/build-annot-roundtrip.ts` in `test/annotation.test.ts` to pin the default `/RT`, typed parent, and note creation on a page where the parent has no `/P`. Test explicit group links, clearing both keys, and a save/reopen round trip. Exercise rejection of cross-page and foreign-document links, loops, grouped primaries with a parent, detached annotations, and invalid reply input before mutation.
2. Run `npm test -- test/annotation.test.ts` and confirm failures identify the missing public API.
3. Add `ReplyType`, `AnnotationReplyOptions`, and the approved API in `src/annotation.ts`. Reuse indirect references from the live page arrays. Promote an inline parent from an older page copy in its current slot. Make setters mark the document modified after validation. Export the two new types from `src/index.ts`.
4. Assert that page copies retain annotation identity and exclude the other page’s bytes, and that removing, flattening, or sanitizing a parent clears surviving reply links. Add page-local annotation remapping for extraction, import, and repeated `Reorder` pages in `src/extractor.ts`. Test that a custom copy policy cannot mutate the source annotation dictionaries. Centralize cleanup of orphaned links in `src/annotlinks.ts`.
5. Run the focused annotation, page copy, FDF/XFDF and README API suites. Document the API in `README.md`, record the behavior in `CLAUDE.md`, and add a `CHANGELOG.md` entry under Unreleased.
6. Review the full diff, run `npm run typecheck` and `npm test`, and record the results in Beads.

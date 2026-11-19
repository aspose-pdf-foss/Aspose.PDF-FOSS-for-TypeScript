# Annotation Review States Implementation Plan

**Goal** Read, edit, and create PDF annotation state replies for `k4h1.2`.

**Spec** [Annotation review states](../specs/2026-11-19-annotation-review-states-design.md).

1. In `test/annotation-state.test.ts`, pin all seven state/model pairs, model-only defaults, damaged inputs, atomic validation, and an authored history after save and reopen.
2. Run `npm test -- test/annotation-state.test.ts` and verify that the new tests fail on the missing API.
3. In `src/annotation.ts`, add typed state/model accessors to `TextAnnotation` and add `Annotation.AddStateReply` using the existing same-page reply builder. Export the types from `src/index.ts`.
4. Update README API and examples, the architecture brief, and the Unreleased changelog. Run the focused annotation and public API tests and review the diff.
5. Merge to `main`, run `npm run typecheck` and `npm test`, then close `k4h1.2`, push `main`, and sync Beads.

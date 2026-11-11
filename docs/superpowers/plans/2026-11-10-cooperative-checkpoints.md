# Cooperative Checkpoints Implementation Plan

> **For agentic workers:** Use `superpowers:executing-plans` inline, as requested
> by the project's recorded workflow preference. Beads tracks task status; the
> numbered steps here describe implementation, not a second task tracker.

**Goal:** Supply the internal cooperative cancellation/progress primitive for
`aspose-pdf-foss-for-ts-u34c.1`, leaving operation integration to `u34c.2`.

**Architecture:** A leaf module captures control options once and exposes sync
and yielding checkpoints. It uses the existing caller-error marker to preserve
cancellation and callback failures across recovery boundaries.

**Tech Stack:** TypeScript, Node >=22, Vitest, Node built-ins only.

**Spec:** [Approved design](../specs/2026-11-10-cooperative-checkpoint-design.md).

## Global constraints

- Zero runtime dependencies; ESM/NodeNext imports use `.js` specifiers.
- Internal module only; do not change document methods or `src/index.ts`.
- Every source catch starts with `rethrowLimit(caught)`.
- Preserve object reasons/errors; wrap primitive reasons/errors with `cause`.
- Both `npm run typecheck` and `npm test` must pass on main before issue closure.
- Preserve the user's unrelated `_my/` files.

## Review focus

- An aborted signal suppresses progress and preserves its reason.
- Cancellation requested in a callback stops the same checkpoint.
- Async checkpoints service an event-loop turn and check cancellation afterward.
- Caller failures survive recovery boundaries, including primitive throws.
- Retained progress records are snapshots; async checks do not emit duplicates.

## Task 1: Shared checkpoint helper

**Files:** Create `src/checkpoint.ts`, `test/checkpoint.test.ts`; update the
architecture overview in `CLAUDE.md`.

**Interfaces:** Implement exactly `OperationProgress`, `OperationControlOptions`,
`OperationControl`, and `createOperationControl(options?)` from the approved
spec. Consumers will import the factory directly from `./checkpoint.js`.

1. Write failing sync tests importing the new module. Assert no-options and
   cancellation-only calls work, optional metadata and unknown/zero totals pass
   unchanged, callback records are distinct snapshots, and option references
   are captured at creation. Assert pre-aborted signals suppress progress,
   callback-triggered cancellation stops immediately, and native default abort
   reasons retain identity. Parameterize object and primitive reasons/throws,
   checking identity or `.cause` and that `rethrowLimit` rethrows the result.
2. Run `npx vitest run test/checkpoint.test.ts`; verify failure is the missing
   module. Implement the synchronous factory/checkpoint with captured references,
   abort checks surrounding progress, copied records only for callback calls,
   and `markCallerError` on failures. Run the focused tests until green.
3. Add failing async tests. Queue `setImmediate` work before the checkpoint to
   prove a real yield, both with and without options. Abort during that turn and
   assert rejection preserves the reason. Assert only one progress event, and
   that pre-abort/callback failure/callback cancellation reject before yielding
   (use an event-loop sentinel, with cleanup in `finally`). Run the focused suite
   and verify the new assertions fail for the missing async behavior.
4. Implement `checkpointAsync`: run the sync checkpoint, await Node's
   `setImmediate` from `node:timers/promises`, then check cancellation without
   emitting progress. Add JSDoc explaining counters, cooperative granularity,
   synchronous callbacks, and no rollback guarantee. Run
   `npx vitest run test/checkpoint.test.ts test/caller-error.test.ts test/limits-catch.test.ts`.
5. Add the module's architecture entry to `CLAUDE.md`. Review the diff against
   the spec, especially absence of public exports and operation changes. Run
   `npm run typecheck` and `npm test`. Commit the helper, tests, architecture
   entry, and any necessary spec/plan corrections with explicit paths.

## Integration and closure

Follow the recorded local merge preference: pull/rebase as needed, merge this
feature branch into main, run both quality gates on main, and only then close
`u34c.1`. Push main and synchronize Beads using `bd dolt push`. Delete the merged
feature branch locally and on origin, preserving `__dolt_remote_info__`. Verify
main tracks origin without pending commits and report that `u34c.2` is unblocked.

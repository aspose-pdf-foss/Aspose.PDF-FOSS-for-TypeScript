# Cooperative checkpoint helper

Issue: `aspose-pdf-foss-for-ts-u34c.1` (Long-operation control).

## Intent and scope

Provide one internal cancellation/progress primitive for future page and object
loops. The user chose both synchronous checkpoints and an async checkpoint that
yields between pages. This is a small foundation change; wiring document methods
belongs to `u34c.2`.

No document method changes, public exports, runtime dependencies, automatic
rollback, progress throttling, or promise of interrupting work inside a page.
Keep existing synchronous APIs synchronous. Target the project's Node >=22 and
ESM/NodeNext conventions.

## Approaches

1. Synchronous checks alone fit existing methods, but cannot service timer/UI
   cancellation while a synchronous operation blocks the event loop.
2. Both synchronous and yielding checkpoints share the cancellation/error
   contract while allowing async consumers to service event-loop work. Selected
   by the user; async consumers explicitly pay for yielding.
3. Making every operation async now would change existing APIs and exceed this
   issue's scope, so it is deferred to the integration design.

## Proposed interface (builder choices)

New internal module `src/checkpoint.ts`, imported directly by future consumers:

```ts
export interface OperationProgress {
  readonly operation: string;
  readonly phase?: string;
  readonly completed: number;
  readonly total?: number;
  readonly pageNumber?: number;
}
export interface OperationControlOptions {
  readonly signal?: AbortSignal;
  readonly onProgress?: (progress: OperationProgress) => void;
}
export interface OperationControl {
  checkpoint(progress?: OperationProgress): void;
  checkpointAsync(progress?: OperationProgress): Promise<void>;
}
export function createOperationControl(
  options?: OperationControlOptions,
): OperationControl;
```

These names and progress fields are my proposed internal contract. `completed`
counts finished units; `total` can be absent when unknown. `pageNumber`, when
supplied by a page consumer, is one-based. Operation/phase names and counter
validity belong to the calling loop; the helper does not infer percentages,
enforce monotonic counts, or invent start/completion events. A checkpoint without
a progress record only checks cancellation.

## Behavior

- Capture signal/callback once at creation. With neither supplied, synchronous
  checkpoints return without creating progress records.
- Check cancellation before progress, call the synchronous callback with a fresh
  shallow snapshot of the supplied record, then check cancellation again. An
  already-aborted signal never invokes the callback. A callback may abort its
  controller and stop work at that same checkpoint.
- The async form performs the same checkpoint, yields using Node's
  `setImmediate` (a real event-loop turn, not just a promise microtask), then checks
  cancellation again before resolving. It yields even with no options. It emits
  progress only once and schedules no yield after an immediate failure.
- Abort reasons and callback exceptions pass through `markCallerError` so
  existing `rethrowLimit` recovery boundaries cannot swallow them. Object error
  identity is preserved; primitive throws/reasons are wrapped with the original
  value as `Error.cause`, following the existing caller-error contract.
- Callbacks are synchronous; the helper does not await returned promises. No
  abort listeners or background work remain after the async checkpoint settles.
- Cancellation is cooperative, with no rollback guarantee. Existing operations
  gain no cancellation behavior until integrated in `u34c.2`.

## Verification

Use real `AbortController` instances and deterministic event-loop scheduling.
Cover progress snapshots and optional metadata, cancellation before/within a
callback and during a yield, default abort reasons, object/primitive callback
errors and reasons surviving `rethrowLimit`, no duplicate async notifications,
and a genuine yield even without options. Run the source catch guard plus both
mandatory quality gates. Add this module to the CLAUDE.md architecture overview;
no README API-count or changelog change is needed for an internal foundation.

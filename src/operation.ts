import { createOperationControl, type OperationControlOptions, type OperationProgress } from './checkpoint.js';

/** A resumable algorithm. Undefined is a cancellation/yield marker without
 *  allocating a progress record when nobody is listening. @internal */
export type OperationSteps<T> = Generator<OperationProgress | undefined, T, void>;

/** One operation's identity and optional progress, shared by delegated steps.
 *  No signal or mutable Document state is stored in this context. @internal */
export interface OperationContext {
  readonly operation: string;
  progress(phase: string, completed: number, total?: number, pageNumber?: number): OperationProgress | undefined;
  scope(prefix: string): OperationContext;
}

function contextFor(operation: string, report: boolean, prefix = ''): OperationContext {
  return {
    operation,
    progress(phase, completed, total, pageNumber) {
      if (!report) return undefined;
      return {
        operation, phase: prefix + phase, completed,
        ...(total === undefined ? {} : { total }),
        ...(pageNumber === undefined ? {} : { pageNumber }),
      };
    },
    scope(part) { return contextFor(operation, report, prefix + part + '.'); },
  };
}

/** Drive one algorithm without servicing the event loop. Controls are captured
 *  before the factory runs, and suspended delegates are closed on failure.
 *  Cleanup in a pipeline's finally blocks must not yield. @internal */
export function runOperation<T>(
  operation: string, options: OperationControlOptions | undefined,
  build: (context: OperationContext) => OperationSteps<T>,
): T {
  const captured = { signal: options?.signal, onProgress: options?.onProgress };
  const control = createOperationControl(captured);
  control.checkpoint();
  const steps = build(contextFor(operation, captured.onProgress !== undefined));
  let finished = false;
  try {
    for (;;) {
      control.checkpoint();
      const next = steps.next();
      if (next.done) {
        finished = true;
        control.checkpoint();
        return next.value;
      }
      control.checkpoint(next.value);
    }
  } finally { if (!finished) steps.return(undefined as T); }
}

/** Drive the same algorithm with real event-loop turns before starting and
 *  between completed work units, including when no controls were supplied.
 *  This is cooperative: a unit itself remains synchronous. @internal */
export async function runOperationAsync<T>(
  operation: string, options: OperationControlOptions | undefined,
  build: (context: OperationContext) => OperationSteps<T>,
): Promise<T> {
  const captured = { signal: options?.signal, onProgress: options?.onProgress };
  const control = createOperationControl(captured);
  await control.checkpointAsync();
  const steps = build(contextFor(operation, captured.onProgress !== undefined));
  let finished = false;
  try {
    for (;;) {
      control.checkpoint();
      const next = steps.next();
      if (next.done) {
        finished = true;
        control.checkpoint();
        return next.value;
      }
      await control.checkpointAsync(next.value);
    }
  } finally { if (!finished) steps.return(undefined as T); }
}

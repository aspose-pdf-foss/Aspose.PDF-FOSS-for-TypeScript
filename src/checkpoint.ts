import { setImmediate } from 'node:timers/promises';
import { markCallerError, rethrowLimit } from './errors.js';

/** A caller-supplied progress snapshot. Counts describe completed units in the
 *  current phase; omit total when unknown. Page numbers, when used, are one-based.
 *  The calling loop owns counter validity and operation/phase names. */
export interface OperationProgress {
  readonly operation: string;
  readonly phase?: string;
  readonly completed: number;
  readonly total?: number;
  readonly pageNumber?: number;
}

/** Shared controls for a cooperative loop. Progress callbacks are synchronous;
 *  a returned promise is not awaited. */
export interface OperationControlOptions {
  readonly signal?: AbortSignal;
  readonly onProgress?: (progress: OperationProgress) => void;
}

/** Cancellation is observed only at checkpoints, with no rollback of earlier
 *  work. A synchronous checkpoint cannot service timer-driven cancellation
 *  while the calling operation blocks the event loop. @internal */
export interface OperationControl {
  /** Check before and after an optional progress notification. */
  checkpoint(progress?: OperationProgress): void;
  /** Check and notify once, yield an event-loop turn, then check again. Even
   *  without options, this yields so timers and I/O can run between units. */
  checkpointAsync(progress?: OperationProgress): Promise<void>;
}

/** Capture controls once for one operation. Cancellation and callback failures
 *  are marked as caller errors so damage-recovery boundaries let them escape.
 *  Object reasons retain identity; primitives are wrapped with Error.cause.
 *  @internal */
export function createOperationControl(options?: OperationControlOptions): OperationControl {
  const signal = options?.signal, onProgress = options?.onProgress;

  function checkAbort(): void {
    if (signal?.aborted) throw markCallerError(signal.reason);
  }

  function checkpoint(progress?: OperationProgress): void {
    checkAbort();
    if (onProgress && progress !== undefined) {
      try { onProgress({ ...progress }); } catch (caught) {
        rethrowLimit(caught);
        throw markCallerError(caught);
      }
    }
    checkAbort();
  }

  async function checkpointAsync(progress?: OperationProgress): Promise<void> {
    checkpoint(progress);
    await setImmediate();
    checkAbort();
  }

  return { checkpoint, checkpointAsync };
}

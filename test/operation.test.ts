import { describe, it, expect } from 'vitest';
import { runOperation, runOperationAsync, type OperationContext, type OperationSteps } from '../src/operation.js';
import { type OperationControlOptions, type OperationProgress } from '../src/checkpoint.js';
import { rethrowLimit } from '../src/errors.js';

function caughtBy(run: () => unknown): unknown {
  try { run(); } catch (caught) { return caught; }
  throw new Error('Expected failure');
}

describe('operation runners', () => {
  it.each(['sync', 'async'])('checks pre-abort before building a %s pipeline', async (mode) => {
    const controller = new AbortController(), reason = new Error('stop');
    controller.abort(reason);
    let built = false;
    const build = (): OperationSteps<number> => { built = true; return (function* () { return 3; })(); };
    if (mode === 'sync') expect(caughtBy(() => runOperation('test', { signal: controller.signal }, build))).toBe(reason);
    else await expect(runOperationAsync('test', { signal: controller.signal }, build)).rejects.toBe(reason);
    expect(built).toBe(false);
  });

  it.each(['sync', 'async'])('returns the result and ordered snapshots in %s mode', async (mode) => {
    const events: OperationProgress[] = [];
    const options = { onProgress: (event: OperationProgress) => events.push(event) };
    function* work(c: OperationContext): OperationSteps<number> {
      yield c.progress('pages', 1, 2, 2);
      yield c.scope('validate').progress('rules', 2);
      return 42;
    }
    const result = mode === 'sync' ? runOperation('ToTiff', options, work) : await runOperationAsync('ToTiff', options, work);
    expect(result).toBe(42);
    expect(events).toEqual([
      { operation: 'ToTiff', phase: 'pages', completed: 1, total: 2, pageNumber: 2 },
      { operation: 'ToTiff', phase: 'validate.rules', completed: 2 },
    ]);
  });

  it.each(['sync', 'async'])('stops after a callback abort and closes the %s generator', async (mode) => {
    const controller = new AbortController(), reason = new Error('stop');
    const done: number[] = [];
    let cleanups = 0;
    function* work(c: OperationContext): OperationSteps<void> {
      try {
        done.push(1); yield c.progress('units', 1, 2);
        done.push(2); yield c.progress('units', 2, 2);
      } finally { cleanups++; }
    }
    const options = { signal: controller.signal, onProgress: () => controller.abort(reason) };
    if (mode === 'sync') expect(caughtBy(() => runOperation('test', options, work))).toBe(reason);
    else await expect(runOperationAsync('test', options, work)).rejects.toBe(reason);
    expect(done).toEqual([1]);
    expect(cleanups).toBe(1);
  });

  it('services immediates even without controls', async () => {
    let serviced = false;
    const handle = setImmediate(() => { serviced = true; });
    try {
      const value = await runOperationAsync('test', undefined, function* () {
        expect(serviced).toBe(true); yield; return 'done';
      });
      expect(value).toBe('done');
    } finally { clearImmediate(handle); }
  });

  it('observes cancellation during an intermediate yield before the next unit', async () => {
    const controller = new AbortController(), reason = new Error('during yield');
    const done: number[] = [];
    let handle: NodeJS.Immediate | undefined, cleanups = 0;
    try {
      await expect(runOperationAsync('test', {
        signal: controller.signal,
        onProgress: () => { handle = setImmediate(() => controller.abort(reason)); },
      }, function* (c) {
        try { done.push(1); yield c.progress('units', 1, 2); done.push(2); }
        finally { cleanups++; }
      })).rejects.toBe(reason);
      expect(done).toEqual([1]); expect(cleanups).toBe(1);
    } finally { if (handle) clearImmediate(handle); }
  });

  it('captures options before the initial async yield', async () => {
    const controller = new AbortController(), events: OperationProgress[] = [];
    const options: { signal?: AbortSignal; onProgress?: OperationControlOptions['onProgress'] } = {
      signal: controller.signal, onProgress: (event) => events.push(event),
    };
    const result = runOperationAsync('test', options, function* (c) { yield c.progress('units', 1); return 7; });
    options.signal = AbortSignal.abort(new Error('replacement'));
    options.onProgress = () => { throw new Error('replacement callback'); };
    expect(await result).toBe(7);
    expect(events).toEqual([{ operation: 'test', phase: 'units', completed: 1 }]);
  });

  it.each(['sync', 'async'])('checks abort before returning a %s result without any yields', async (mode) => {
    const controller = new AbortController(), reason = new Error('at return');
    function* work(): OperationSteps<number> { controller.abort(reason); return 3; }
    if (mode === 'sync') expect(caughtBy(() => runOperation('test', { signal: controller.signal }, work))).toBe(reason);
    else await expect(runOperationAsync('test', { signal: controller.signal }, work)).rejects.toBe(reason);
  });

  it('uses allocation-free markers when no callback is present', () => {
    runOperation('test', undefined, function* (c) {
      expect(c.progress('units', 1, 2)).toBeUndefined();
      expect(c.scope('nested').progress('units', 2)).toBeUndefined();
      yield;
    });
  });

  it.each([new Error('callback'), 'primitive', null])('preserves callback failure %# through recovery and cleanup', (reason) => {
    let cleaned = false;
    const failure = caughtBy(() => {
      try {
        runOperation('test', { onProgress: () => { throw reason; } }, function* (c) {
          try { yield c.progress('units', 1); } finally { cleaned = true; }
        });
      } catch (caught) { rethrowLimit(caught); }
    });
    if (reason instanceof Error) expect(failure).toBe(reason);
    else expect((failure as Error).cause).toBe(reason);
    expect(cleaned).toBe(true);
  });

  it.each(['sync', 'async'])('preserves a %s generator failure and runs cleanup once', async (mode) => {
    const reason = new Error('pipeline failure');
    let cleanups = 0;
    function* work(): OperationSteps<void> { try { yield; throw reason; } finally { cleanups++; } }
    if (mode === 'sync') expect(caughtBy(() => runOperation('test', undefined, work))).toBe(reason);
    else await expect(runOperationAsync('test', undefined, work)).rejects.toBe(reason);
    expect(cleanups).toBe(1);
  });
});

import { describe, it, expect } from 'vitest';
import { createOperationControl, type OperationProgress } from '../src/checkpoint.js';
import { rethrowLimit } from '../src/errors.js';

function thrownBy(run: () => void): unknown {
  try { run(); } catch (caught) { return caught; }
  throw new Error('Expected the checkpoint to throw');
}

// Model the damage-recovery boundary used throughout src/: caller failures
// must escape rather than letting the operation continue past "damage".
function recover(run: () => void): void {
  try { run(); } catch (caught) { rethrowLimit(caught); }
}

const progress: OperationProgress = {
  operation: 'ToImage', phase: 'render', completed: 1, total: 3, pageNumber: 2,
};

describe('synchronous cooperative checkpoints', () => {
  it('allows unchecked work when no control options are supplied', () => {
    const control = createOperationControl();
    expect(() => control.checkpoint()).not.toThrow();
    expect(() => control.checkpoint(progress)).not.toThrow();
  });

  it('emits supplied counts and optional metadata without inventing events', () => {
    const events: OperationProgress[] = [];
    const control = createOperationControl({ onProgress: (event) => events.push(event) });
    control.checkpoint();
    control.checkpoint(progress);
    control.checkpoint({ operation: 'Save', completed: 4 });
    control.checkpoint({ operation: 'Optimize', completed: 0, total: 0 });
    expect(events).toEqual([
      { operation: 'ToImage', phase: 'render', completed: 1, total: 3, pageNumber: 2 },
      { operation: 'Save', completed: 4 },
      { operation: 'Optimize', completed: 0, total: 0 },
    ]);
  });

  it('snapshots a reused progress record for every notification', () => {
    const events: OperationProgress[] = [];
    const control = createOperationControl({ onProgress: (event) => events.push(event) });
    const record = { operation: 'Save', completed: 0, total: 2 };
    control.checkpoint(record);
    record.completed = 1;
    control.checkpoint(record);
    record.completed = 2;
    expect(events).toEqual([
      { operation: 'Save', completed: 0, total: 2 },
      { operation: 'Save', completed: 1, total: 2 },
    ]);
    expect(events[0]).not.toBe(record);
    expect(events[1]).not.toBe(record);
    expect(events[0]).not.toBe(events[1]);
  });

  it('captures the signal and callback at creation', () => {
    const original = new AbortController(), replacement = new AbortController();
    const events: OperationProgress[] = [];
    const options = { signal: original.signal, onProgress: (event: OperationProgress) => { events.push(event); } };
    const control = createOperationControl(options);
    options.signal = replacement.signal;
    options.onProgress = () => { throw new Error('replacement callback'); };
    replacement.abort(new Error('replacement signal'));
    control.checkpoint(progress);
    expect(events).toHaveLength(1);
    const reason = new Error('original signal');
    original.abort(reason);
    expect(thrownBy(() => control.checkpoint())).toBe(reason);
  });

  it('checks cancellation even without a progress record or callback', () => {
    const controller = new AbortController();
    const control = createOperationControl({ signal: controller.signal });
    control.checkpoint();
    const reason = new Error('stop');
    controller.abort(reason);
    expect(thrownBy(() => recover(() => control.checkpoint()))).toBe(reason);
  });

  it('suppresses progress on pre-abort and preserves the native default reason', () => {
    const controller = new AbortController();
    controller.abort();
    let calls = 0;
    const control = createOperationControl({ signal: controller.signal, onProgress: () => { calls++; } });
    expect(thrownBy(() => recover(() => control.checkpoint(progress)))).toBe(controller.signal.reason);
    expect(calls).toBe(0);
  });

  it('stops at the same checkpoint when progress aborts the operation', () => {
    const controller = new AbortController(), reason = new Error('stop in progress');
    const events: OperationProgress[] = [];
    const control = createOperationControl({
      signal: controller.signal,
      onProgress: (event) => { events.push(event); controller.abort(reason); },
    });
    let continued = false;
    expect(thrownBy(() => recover(() => { control.checkpoint(progress); continued = true; }))).toBe(reason);
    expect(continued).toBe(false);
    expect(events).toHaveLength(1);
  });

  const failures = [new Error('caller failure'), { stop: true }, 'primitive failure', null, 0];
  it.each(failures)('preserves abort reason %# through recovery', (reason) => {
    const controller = new AbortController();
    controller.abort(reason);
    const control = createOperationControl({ signal: controller.signal });
    const caught = thrownBy(() => recover(() => control.checkpoint()));
    if (typeof reason === 'object' && reason !== null) expect(caught).toBe(reason);
    else { expect(caught).toBeInstanceOf(Error); expect((caught as Error).cause).toBe(reason); }
  });

  it.each([...failures, undefined])('preserves callback failure %# through recovery', (reason) => {
    const control = createOperationControl({ onProgress: () => { throw reason; } });
    const caught = thrownBy(() => recover(() => control.checkpoint(progress)));
    if (typeof reason === 'object' && reason !== null) expect(caught).toBe(reason);
    else { expect(caught).toBeInstanceOf(Error); expect((caught as Error).cause).toBe(reason); }
  });
});

describe('yielding cooperative checkpoints', () => {
  it.each([false, true])('services the event loop with progress enabled=%s', async (enabled) => {
    const events: OperationProgress[] = [];
    const control = createOperationControl(enabled ? { onProgress: (event) => events.push(event) } : undefined);
    let serviced = false;
    const pending = setImmediate(() => { serviced = true; });
    try {
      const result = control.checkpointAsync(progress);
      expect(serviced).toBe(false);
      await result;
      expect(serviced).toBe(true);
      expect(events).toEqual(enabled ? [
        { operation: 'ToImage', phase: 'render', completed: 1, total: 3, pageNumber: 2 },
      ] : []);
    } finally { clearImmediate(pending); }
  });

  it.each([new Error('during yield'), 'primitive during yield'])('observes abort reason %# after yielding', async (reason) => {
    const controller = new AbortController();
    const events: OperationProgress[] = [];
    const control = createOperationControl({ signal: controller.signal, onProgress: (event) => events.push(event) });
    const pending = setImmediate(() => controller.abort(reason));
    try {
      const caught: unknown = await control.checkpointAsync(progress).then(
        () => { throw new Error('Expected cancellation'); },
        (failure: unknown) => failure,
      );
      if (typeof reason === 'object') expect(caught).toBe(reason);
      else { expect(caught).toBeInstanceOf(Error); expect((caught as Error).cause).toBe(reason); }
      expect(thrownBy(() => rethrowLimit(caught))).toBe(caught);
      expect(events).toHaveLength(1);
    } finally { clearImmediate(pending); }
  });

  it('checks cancellation without progress after yielding', async () => {
    const controller = new AbortController(), reason = new Error('no progress');
    const control = createOperationControl({ signal: controller.signal });
    const pending = setImmediate(() => controller.abort(reason));
    try { await expect(control.checkpointAsync()).rejects.toBe(reason); }
    finally { clearImmediate(pending); }
  });

  it.each(['pre-abort', 'callback abort', 'callback throw'] as const)('rejects %s before yielding', async (mode) => {
    const controller = new AbortController(), reason = new Error(mode);
    let calls = 0, serviced = false;
    if (mode === 'pre-abort') controller.abort(reason);
    const control = createOperationControl({
      signal: controller.signal,
      onProgress: () => {
        calls++;
        if (mode === 'callback throw') throw reason;
        controller.abort(reason);
      },
    });
    const pending = setImmediate(() => { serviced = true; });
    try {
      await expect(control.checkpointAsync(progress)).rejects.toBe(reason);
      expect(serviced).toBe(false);
      expect(calls).toBe(mode === 'pre-abort' ? 0 : 1);
      expect(thrownBy(() => rethrowLimit(reason))).toBe(reason);
    } finally { clearImmediate(pending); }
  });
});

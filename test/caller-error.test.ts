import { describe, it, expect } from 'vitest';
import { markCallerError, rethrowLimit } from '../src/errors.js';

// A caller's own error (a font substitution handler throwing, g0ky.6) must
// pass every `catch` in `src/`, all of which call rethrowLimit first.
describe('markCallerError', () => {
  it('rethrowLimit rethrows a marked caller error, and only a marked one', () => {
    const mine = new Error('mine');
    expect(() => rethrowLimit(markCallerError(mine))).toThrow(mine);
    expect(() => rethrowLimit(new Error('other'))).not.toThrow();
  });

  it('wraps a non-object throw so it can be marked', () => {
    const w = markCallerError('boom') as Error;
    expect(w).toBeInstanceOf(Error);
    expect(w.cause).toBe('boom');
    expect(() => rethrowLimit(w)).toThrow(w);
  });
});

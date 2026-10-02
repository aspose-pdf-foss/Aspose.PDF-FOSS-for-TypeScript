import { describe, it, expect } from 'vitest';
import type { AiModel, AiRequest } from '../src/index.js';
import { AiServiceError } from '../src/index.js';

describe('AiModel seam (3ywf.2)', () => {
  it('is implementable with no HTTP at all', async () => {
    // The point of the interface: a caller plugs in any provider, a local
    // model or a test stub as a few-line object.
    const stub: AiModel = {
      complete: async (req: AiRequest) => ({ text: `saw ${req.messages.length}` }),
    };
    const r = await stub.complete({ messages: [{ role: 'user', content: 'hi' }] });
    expect(r).toEqual({ text: 'saw 1' });
  });
});

describe('AiServiceError (3ywf.2)', () => {
  it('names itself and carries the HTTP status', () => {
    const e = new AiServiceError('boom', 503);
    expect(e).toBeInstanceOf(Error);
    expect(e.name).toBe('AiServiceError');
    expect(e.message).toBe('boom');
    expect(e.status).toBe(503);
  });

  it('leaves status undefined when there was no response', () => {
    expect(new AiServiceError('unreachable').status).toBeUndefined();
  });
});

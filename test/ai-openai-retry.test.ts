import { describe, it, expect, afterEach } from 'vitest';
import { createOpenAiModel, type RetryTiming } from '../src/aiopenai.js';
import { AiServiceError } from '../src/errors.js';
import { startAiServer, completion, status, type AiServer } from './helpers/ai-server.js';

let srv: AiServer | undefined;
afterEach(async () => { await srv?.close(); srv = undefined; });

const ask = { messages: [{ role: 'user' as const, content: 'hi' }] };

/** Records each wait instead of sleeping. */
function recorder(maxDelayMs = 30_000): RetryTiming & { waits: number[] } {
  const waits: number[] = [];
  return { waits, baseDelayMs: 1000, maxDelayMs, sleep: async (ms) => { waits.push(ms); } };
}

describe('openAiModel retries (3ywf.2)', () => {
  it('retries a 503 and succeeds, backing off exponentially', async () => {
    srv = await startAiServer([status(503), status(503), completion('ok')]);
    const t = recorder();
    const r = await createOpenAiModel(srv.url, { model: 'm' }, t).complete(ask);
    expect(r.text).toBe('ok');
    expect(srv.hits).toHaveLength(3);
    expect(t.waits).toEqual([1000, 2000]);
  });

  for (const code of [429, 500, 502, 504]) {
    it(`retries HTTP ${code}`, async () => {
      srv = await startAiServer([status(code), completion('ok')]);
      await createOpenAiModel(srv.url, { model: 'm' }, recorder()).complete(ask);
      expect(srv.hits).toHaveLength(2);
    });
  }

  it('gives up after maxRetries further attempts with the last error', async () => {
    srv = await startAiServer(status(503, { error: { message: 'busy' } }));
    const p = createOpenAiModel(srv.url, { model: 'm', maxRetries: 2 }, recorder()).complete(ask);
    await expect(p).rejects.toMatchObject({ name: 'AiServiceError', status: 503 });
    expect(srv.hits).toHaveLength(3);
  });

  it('does not retry at all with maxRetries: 0', async () => {
    srv = await startAiServer([status(503), completion('ok')]);
    const t = recorder();
    await expect(createOpenAiModel(srv.url, { model: 'm', maxRetries: 0 }, t).complete(ask))
      .rejects.toBeInstanceOf(AiServiceError);
    expect(srv.hits).toHaveLength(1);
    expect(t.waits).toEqual([]);
  });

  it('never retries a 400', async () => {
    srv = await startAiServer([status(400), completion('ok')]);
    await expect(createOpenAiModel(srv.url, { model: 'm' }, recorder()).complete(ask))
      .rejects.toMatchObject({ status: 400 });
    expect(srv.hits).toHaveLength(1);
  });

  it('honours Retry-After in seconds', async () => {
    srv = await startAiServer([status(429, {}, { 'Retry-After': '3' }), completion('ok')]);
    const t = recorder();
    await createOpenAiModel(srv.url, { model: 'm' }, t).complete(ask);
    expect(t.waits).toEqual([3000]);
  });

  it('honours Retry-After: 0', async () => {
    srv = await startAiServer([status(429, {}, { 'Retry-After': '0' }), completion('ok')]);
    const t = recorder();
    await createOpenAiModel(srv.url, { model: 'm' }, t).complete(ask);
    expect(t.waits).toEqual([0]);
  });

  it('honours Retry-After as an HTTP-date (Review Focus 4)', async () => {
    const at = new Date(Date.now() + 5000).toUTCString();
    const past = new Date(Date.now() - 60_000).toUTCString();
    srv = await startAiServer([
      status(503, {}, { 'Retry-After': at }),
      status(503, {}, { 'Retry-After': past }),
      completion('ok'),
    ]);
    const t = recorder();
    await createOpenAiModel(srv.url, { model: 'm' }, t).complete(ask);
    expect(t.waits[0]).toBeGreaterThan(2000); // toUTCString drops milliseconds
    expect(t.waits[0]).toBeLessThanOrEqual(5000);
    expect(t.waits[1]).toBe(0);
  });

  it('fails at once on a Retry-After past the cap, without waiting', async () => {
    srv = await startAiServer([status(429, {}, { 'Retry-After': '60' }), completion('ok')]);
    const t = recorder(30_000);
    const p = createOpenAiModel(srv.url, { model: 'm' }, t).complete(ask);
    await expect(p).rejects.toThrow(/past the 30000 ms cap/);
    expect(t.waits).toEqual([]);
    expect(srv.hits).toHaveLength(1);
  });

  it('caps an exponential wait at maxDelayMs', async () => {
    srv = await startAiServer([status(503), status(503), status(503), completion('ok')]);
    const t = recorder(1500);
    await createOpenAiModel(srv.url, { model: 'm', maxRetries: 3 }, t).complete(ask);
    expect(t.waits).toEqual([1000, 1500, 1500]);
  });

  it('retries a network error and reports it when retries run out', async () => {
    srv = await startAiServer(completion('ok'));
    const url = srv.url;
    await srv.close(); srv = undefined; // nothing listens there now
    const t = recorder();
    await expect(createOpenAiModel(url, { model: 'm', maxRetries: 1 }, t).complete(ask))
      .rejects.toThrow(/could not be reached/);
    expect(t.waits).toEqual([1000]);
  });

  it('retries a per-attempt timeout', async () => {
    srv = await startAiServer([() => { /* never respond */ }, completion('ok')]);
    const r = await createOpenAiModel(srv.url, { model: 'm', timeoutMs: 100 }, recorder()).complete(ask);
    expect(r.text).toBe('ok');
    expect(srv.hits).toHaveLength(2);
  });
});

describe('openAiModel cancellation (3ywf.2)', () => {
  it('stops promptly when the caller aborts during a backoff wait, and is not retried', async () => {
    srv = await startAiServer(status(503));
    const ctrl = new AbortController();
    // Real sleeping here: a 10 s backoff the abort must cut short.
    const timing: RetryTiming = { baseDelayMs: 10_000, maxDelayMs: 30_000, sleep: realSleep };
    setTimeout(() => ctrl.abort(new Error('stop')), 100);
    const started = Date.now();
    await expect(createOpenAiModel(srv.url, { model: 'm' }, timing).complete({ ...ask, signal: ctrl.signal }))
      .rejects.toThrow('stop');
    expect(Date.now() - started).toBeLessThan(2000);
    expect(srv.hits).toHaveLength(1);
  });

  it('stops an in-flight request when the caller aborts', async () => {
    srv = await startAiServer(() => { /* never respond */ });
    const ctrl = new AbortController();
    setTimeout(() => ctrl.abort(new Error('stop')), 50);
    await expect(createOpenAiModel(srv.url, { model: 'm' }, recorder()).complete({ ...ask, signal: ctrl.signal }))
      .rejects.toThrow('stop');
    expect(srv.hits).toHaveLength(1);
  });
});

/** The abortable sleep the real client uses, reproduced so the test does not
 *  depend on an unexported helper. */
function realSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(signal.reason); return; }
    const onAbort = (): void => { clearTimeout(t); reject(signal!.reason); };
    const t = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve(); }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

import { describe, it, expect, afterEach } from 'vitest';
import { openAiModel } from '../src/aiopenai.js';
import { AiServiceError } from '../src/errors.js';
import { startAiServer, completion, status, type AiServer } from './helpers/ai-server.js';

let srv: AiServer | undefined;
afterEach(async () => { await srv?.close(); srv = undefined; });

const ask = { messages: [{ role: 'user' as const, content: 'hi' }] };

describe('openAiModel construction (3ywf.2)', () => {
  it('refuses a missing or non-http(s) baseUrl', () => {
    expect(() => openAiModel(undefined as unknown as string, { model: 'm' })).toThrow(TypeError);
    expect(() => openAiModel('ftp://x', { model: 'm' })).toThrow(RangeError);
  });

  it('refuses a baseUrl carrying credentials, a query or a fragment, without echoing it', () => {
    // Final review: Node's fetch rejects a URL with credentials, and that
    // message quoted the password back — twice — and was then retried.
    for (const u of ['https://user:pw-secret@proxy/v1', 'https://proxy/v1?api_key=pw-secret', 'https://proxy/v1#pw-secret']) {
      let e: unknown;
      try { openAiModel(u, { model: 'm' }); } catch (caught) { e = caught; }
      expect(e, u).toBeInstanceOf(RangeError);
      expect((e as Error).message, u).not.toContain('pw-secret');
    }
  });

  it('refuses a baseUrl that does not parse, without echoing it', () => {
    let e: unknown;
    try { openAiModel('http://', { model: 'm' }); } catch (caught) { e = caught; }
    expect(e).toBeInstanceOf(RangeError);
    let f: unknown;
    try { openAiModel('ftp://u:pw-secret@x', { model: 'm' }); } catch (caught) { f = caught; }
    expect((f as Error).message).not.toContain('pw-secret');
  });

  it('refuses a missing or empty model', () => {
    expect(() => openAiModel('http://x', {} as never)).toThrow(TypeError);
    expect(() => openAiModel('http://x', { model: '' })).toThrow(RangeError);
  });

  it('refuses bad numeric options by value', () => {
    expect(() => openAiModel('http://x', { model: 'm', timeoutMs: 0 })).toThrow(RangeError);
    expect(() => openAiModel('http://x', { model: 'm', maxResponseBytes: 1.5 })).toThrow(RangeError);
    expect(() => openAiModel('http://x', { model: 'm', maxRetries: -1 })).toThrow(RangeError);
    expect(() => openAiModel('http://x', { model: 'm', temperature: Number.NaN })).toThrow(RangeError);
  });

  it('refuses options of the wrong kind', () => {
    expect(() => openAiModel('http://x', { model: 'm', apiKey: 5 as never })).toThrow(TypeError);
    expect(() => openAiModel('http://x', { model: 'm', headers: 'x' as never })).toThrow(TypeError);
    expect(() => openAiModel('http://x', { model: 'm', timeoutMs: '5' as never })).toThrow(TypeError);
  });
});

describe('openAiModel request validation (3ywf.2)', () => {
  // Review Focus 1: refused before any byte is sent.
  const bad: Array<[string, unknown, ErrorConstructor]> = [
    ['messages not an array', { messages: 'hi' }, TypeError],
    ['empty messages', { messages: [] }, RangeError],
    ['unknown role', { messages: [{ role: 'tool', content: 'x' }] }, RangeError],
    ['content neither string nor array', { messages: [{ role: 'user', content: 5 }] }, TypeError],
    ['image bytes not a Uint8Array', { messages: [{ role: 'user', content: [{ type: 'image', bytes: [1], mediaType: 'image/png' }] }] }, TypeError],
    ['empty image', { messages: [{ role: 'user', content: [{ type: 'image', bytes: new Uint8Array(0), mediaType: 'image/png' }] }] }, RangeError],
    ['unknown mediaType', { messages: [{ role: 'user', content: [{ type: 'image', bytes: new Uint8Array(1), mediaType: 'image/gif' }] }] }, RangeError],
    ['unknown part type', { messages: [{ role: 'user', content: [{ type: 'audio' }] }] }, RangeError],
    ['bad schema name', { ...ask, schema: { name: 'has space', schema: {} } }, RangeError],
    ['schema not an object', { ...ask, schema: { name: 'ok', schema: 'x' } }, TypeError],
    ['maxTokens not a positive integer', { ...ask, maxTokens: 0 }, RangeError],
  ];
  for (const [what, req, type] of bad) {
    it(`refuses ${what} without a request`, async () => {
      srv = await startAiServer(completion('x'));
      const m = openAiModel(srv.url, { model: 'm' });
      await expect(m.complete(req as never)).rejects.toThrow(type);
      expect(srv.hits).toHaveLength(0);
    });
  }
});

describe('openAiModel wire mapping (3ywf.2)', () => {
  it('POSTs the chat-completions body the spec describes', async () => {
    srv = await startAiServer(completion('ok'));
    const m = openAiModel(srv.url + '/', { model: 'gpt-x', apiKey: 'sk-secret', temperature: 0.2 });
    await m.complete({
      messages: [
        { role: 'system', content: 'be brief' },
        { role: 'user', content: [
          { type: 'text', text: 'what is this?' },
          { type: 'image', bytes: new Uint8Array([1, 2, 3]), mediaType: 'image/png' },
        ] },
      ],
      schema: { name: 'words', schema: { type: 'object' } },
      maxTokens: 50,
    });
    const hit = srv.hits[0]!;
    expect(hit.method).toBe('POST');
    expect(hit.url).toBe('/v1/chat/completions'); // trailing slash trimmed
    expect(hit.headers['authorization']).toBe('Bearer sk-secret');
    expect(hit.headers['content-type']).toBe('application/json');
    expect(JSON.parse(hit.body)).toEqual({
      model: 'gpt-x',
      temperature: 0.2,
      max_tokens: 50,
      response_format: { type: 'json_schema', json_schema: { name: 'words', schema: { type: 'object' }, strict: true } },
      messages: [
        { role: 'system', content: 'be brief' },
        { role: 'user', content: [
          { type: 'text', text: 'what is this?' },
          { type: 'image_url', image_url: { url: 'data:image/png;base64,AQID' } },
        ] },
      ],
    });
  });

  it('omits what was not stated, and sends no Authorization without a key', async () => {
    srv = await startAiServer(completion('ok'));
    await openAiModel(srv.url, { model: 'm' }).complete(ask);
    const hit = srv.hits[0]!;
    expect(hit.headers['authorization']).toBeUndefined();
    expect(JSON.parse(hit.body)).toEqual({ model: 'm', messages: [{ role: 'user', content: 'hi' }] });
  });

  it('lets apiKey win over a caller-supplied Authorization header', async () => {
    srv = await startAiServer(completion('ok'));
    await openAiModel(srv.url, { model: 'm', apiKey: 'k', headers: { Authorization: 'other', 'X-Org': 'o' } }).complete(ask);
    expect(srv.hits[0]!.headers['authorization']).toBe('Bearer k');
    expect(srv.hits[0]!.headers['x-org']).toBe('o');
  });
});

describe('openAiModel reply handling (3ywf.2)', () => {
  it('returns the text and the usage', async () => {
    srv = await startAiServer(completion('hello'));
    const r = await openAiModel(srv.url, { model: 'm' }).complete(ask);
    expect(r).toEqual({ text: 'hello', usage: { inputTokens: 12, outputTokens: 3 } });
  });

  it('omits usage the provider did not report', async () => {
    srv = await startAiServer(status(200, { choices: [{ message: { content: 'x' }, finish_reason: 'stop' }] }));
    expect(await openAiModel(srv.url, { model: 'm' }).complete(ask)).toEqual({ text: 'x' });
  });

  it('throws on a refusal', async () => {
    srv = await startAiServer(completion(null, { message: { role: 'assistant', content: null, refusal: 'I cannot help' } }));
    await expect(openAiModel(srv.url, { model: 'm' }).complete(ask)).rejects.toThrow(/refused.*I cannot help/);
  });

  it('throws on a reply cut off at the token limit rather than returning it', async () => {
    srv = await startAiServer(completion('{"words": [', { finish_reason: 'length' }));
    const p = openAiModel(srv.url, { model: 'm' }).complete(ask);
    await expect(p).rejects.toBeInstanceOf(AiServiceError);
    await expect(p).rejects.toThrow(/token limit/);
  });

  it('throws when there is no string content', async () => {
    srv = await startAiServer(status(200, { choices: [] }));
    await expect(openAiModel(srv.url, { model: 'm' }).complete(ask)).rejects.toThrow(/no message content/);
  });

  it('throws on a body that is not JSON', async () => {
    srv = await startAiServer(status(200, '<html>gateway</html>'));
    await expect(openAiModel(srv.url, { model: 'm' }).complete(ask)).rejects.toThrow(/not JSON/);
  });

  it('reports an error object that arrived with a 200 (Review Focus 3)', async () => {
    srv = await startAiServer(status(200, { error: { message: 'model overloaded' } }));
    await expect(openAiModel(srv.url, { model: 'm' }).complete(ask)).rejects.toThrow(/model overloaded/);
  });

  it('throws a non-retryable 4xx at once, with status and provider message', async () => {
    srv = await startAiServer(status(400, { error: { message: 'bad schema' } }));
    const p = openAiModel(srv.url, { model: 'm' }).complete(ask);
    await expect(p).rejects.toMatchObject({ name: 'AiServiceError', status: 400 });
    await expect(p).rejects.toThrow(/HTTP 400: bad schema/);
    expect(srv.hits).toHaveLength(1);
  });

  it('truncates a long provider message to 500 characters', async () => {
    srv = await startAiServer(status(400, { error: { message: 'x'.repeat(2000) } }));
    const e = await openAiModel(srv.url, { model: 'm' }).complete(ask).catch((c: Error) => c);
    expect((e as Error).message.length).toBeLessThan(700);
  });

  it('never puts the API key in an error, even when the provider echoes it (Review Focus 2)', async () => {
    srv = await startAiServer(status(401, { error: { message: 'Incorrect API key provided: sk-top-secret-123.' } }));
    const e = await openAiModel(srv.url, { model: 'm', apiKey: 'sk-top-secret-123' }).complete(ask).catch((c: Error) => c);
    expect(e).toBeInstanceOf(AiServiceError);
    expect((e as Error).message).not.toContain('sk-top-secret-123');
    expect((e as Error).message).toContain('[redacted]');
  });

  it('serves two calls in flight on one client independently (Review Focus 5)', async () => {
    srv = await startAiServer((hit, res) => {
      const said = JSON.parse(hit.body).messages[0].content as string;
      setTimeout(() => completion(`echo ${said}`)(hit, res), said === 'a' ? 60 : 5);
    });
    const m = openAiModel(srv.url, { model: 'm' });
    const [a, b] = await Promise.all([
      m.complete({ messages: [{ role: 'user', content: 'a' }] }),
      m.complete({ messages: [{ role: 'user', content: 'b' }] }),
    ]);
    expect([a.text, b.text]).toEqual(['echo a', 'echo b']);
  });
});

describe('openAiModel bounds (3ywf.2)', () => {
  it('refuses a response whose Content-Length exceeds the cap', async () => {
    srv = await startAiServer((_h, res) => {
      res.writeHead(200, { 'Content-Length': '10000' });
      res.end('x'.repeat(10000));
    });
    await expect(openAiModel(srv.url, { model: 'm', maxResponseBytes: 4096 }).complete(ask))
      .rejects.toThrow(/exceeds 4096 bytes/);
  });

  it('refuses a chunked response that grows past the cap with no length stated', async () => {
    srv = await startAiServer((_h, res) => {
      res.writeHead(200); // no Content-Length: chunked
      for (let i = 0; i < 3; i++) res.write('y'.repeat(2000));
      res.end();
    });
    await expect(openAiModel(srv.url, { model: 'm', maxResponseBytes: 4096 }).complete(ask))
      .rejects.toThrow(/exceeds 4096 bytes/);
  });

  it('gives up on a server that never answers', async () => {
    srv = await startAiServer(() => { /* never respond */ });
    const p = openAiModel(srv.url, { model: 'm', timeoutMs: 100, maxRetries: 0 }).complete(ask);
    await expect(p).rejects.toBeInstanceOf(AiServiceError);
    await expect(p).rejects.toThrow(/did not answer within 100 ms/);
  });
});

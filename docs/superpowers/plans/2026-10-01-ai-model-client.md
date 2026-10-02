# AI Model Client Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An `AiModel` interface that later AI features (`3ywf.3`, `3ywf.4`) depend on, plus `openAiModel(baseUrl, opts)`, a bounded, retrying chat-completions client for OpenAI-compatible servers.

**Architecture:** `src/aimodel.ts` is a types-only leaf (the seam). `src/aiopenai.ts` is the only module that touches the network, over the runtime's built-in `fetch`, following `src/tsahttp.ts`. Failures are a new public `AiServiceError` in `src/errors.ts`. Tests run against local `node:http` servers; nothing reaches the internet.

**Tech Stack:** TypeScript (strict, ESM, NodeNext — import specifiers end in `.js`), Node >= 22 built-in `fetch`/`AbortSignal.any`, vitest.

**Spec:** `docs/superpowers/specs/2026-10-01-ai-model-client-design.md` — read it before Task 1.

## Global Constraints

- Zero runtime dependencies. No npm packages; `fetch`, `AbortSignal`, `Buffer`, `TextDecoder` are runtime built-ins.
- No default endpoint: `baseUrl` and `model` are required arguments.
- `timeoutMs` default `120_000` (per attempt); `maxResponseBytes` default `4 * 1024 * 1024`; `maxRetries` default `2`.
- Retryable: HTTP `429, 500, 502, 503, 504`, a network error, a per-attempt timeout. Backoff `1000 ms × 2^attempt`, every wait capped at `30_000 ms`; a `Retry-After` past the cap fails at once.
- `maxTokens` goes on the wire as `max_tokens` (never `max_completion_tokens`).
- `schema` goes on the wire as `response_format: { type: 'json_schema', json_schema: { name, schema, strict: true } }`. The library never validates a reply against it.
- `finish_reason === 'length'` throws. The API key never appears in an error message.
- Argument errors: `TypeError` for the wrong KIND of thing, `RangeError` for a value outside the allowed SET (the repo's split).
- **Every `catch` in `src/` calls `rethrowLimit(caught)` as its first statement** and binds the error (`catch (caught) {`, never a bare `catch {`). `test/limits-catch.test.ts` fails the build otherwise.
- Every name exported from `src/index.ts` needs a README API Reference row whose first cell opens with that name in backticks; the README count sentence must state the compiler's counts. `test/readme-api.test.ts` enforces both.
- Before claiming any task done: `npm run typecheck` and the task's tests green.

## Review Focus

1. **A malformed request from untyped JS** (empty `messages`, a bad `role`, an empty image, an unknown `mediaType`, a bad schema `name`) — expect an immediate `TypeError`/`RangeError` and **zero** HTTP requests, never a provider 400 that costs a round trip. Pinned in Task 2.
2. **A provider that echoes the key back** in its error message (OpenAI's own 401 says `Incorrect API key provided: sk-…`) — expect the key replaced by `[redacted]`. Pinned in Task 2.
3. **A proxy that answers 200 with an `{ error: { message } }` body** — expect `AiServiceError` carrying that message, not "no content". Pinned in Task 2.
4. **`Retry-After` as an HTTP-date** — expect the wait to be the time until that date (0 if already past), not a parse failure. Pinned in Task 3.
5. **Two `complete` calls in flight on one client** — expect both to succeed independently; the client holds no per-call mutable state. Pinned in Task 2.

---

## File Structure

| File | Responsibility |
|---|---|
| `src/aimodel.ts` (create) | The seam: `AiContentPart`, `AiMessage`, `AiRequest`, `AiResponse`, `AiModel`. Types only, imports nothing. |
| `src/errors.ts` (modify) | Add `AiServiceError`. |
| `src/aiopenai.ts` (create) | `openAiModel`, `OpenAiModelOptions`, and the internal `createOpenAiModel`/`RetryTiming` test seam. |
| `src/index.ts` (modify) | Export the above. |
| `test/helpers/ai-server.ts` (create) | Scripted local `node:http` server recording every hit. |
| `test/ai-model.test.ts` (create) | Seam and error type. |
| `test/ai-openai.test.ts` (create) | Construction, request validation, wire mapping, reply handling, bounds, redaction. |
| `test/ai-openai-retry.test.ts` (create) | Retry and cancellation behaviour. |
| `README.md`, `CLAUDE.md`, `CHANGELOG.md` (modify) | Docs, per the spec. |

---

### Task 1: The seam and the error type

**Files:**
- Create: `src/aimodel.ts`
- Modify: `src/errors.ts` (append after `SeedValueError`)
- Modify: `src/index.ts` (line 3 error export; new type export near line 229)
- Modify: `README.md` (new `### AI` table in API Reference; `Errors:` line; count sentence)
- Test: `test/ai-model.test.ts`

**Interfaces:**
- Produces (exact):
  ```ts
  // src/aimodel.ts
  export type AiContentPart =
    | { type: 'text'; text: string }
    | { type: 'image'; bytes: Uint8Array; mediaType: 'image/png' | 'image/jpeg' };
  export interface AiMessage { role: 'system' | 'user' | 'assistant'; content: string | AiContentPart[]; }
  export interface AiRequest {
    messages: AiMessage[];
    schema?: { name: string; schema: object };
    maxTokens?: number;
    signal?: AbortSignal;
  }
  export interface AiResponse { text: string; usage?: { inputTokens: number; outputTokens: number }; }
  export interface AiModel { complete(req: AiRequest): Promise<AiResponse>; }
  // src/errors.ts
  export class AiServiceError extends Error { constructor(message: string, readonly status?: number) }
  ```

- [ ] **Step 1: Write the failing test** — `test/ai-model.test.ts`

```ts
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
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run test/ai-model.test.ts`
Expected: FAIL — `AiServiceError` is not exported from `../src/index.js`.

- [ ] **Step 3: Create `src/aimodel.ts`**

```ts
/** The seam every AI feature is written against (`3ywf.2`).
 *
 *  Decision `3ywf.1`: this library reaches a host only through a client object
 *  the caller constructs. An {@link AiModel} is that object for AI features —
 *  `openAiModel` (aiopenai.ts) is one implementation, and any other provider,
 *  a local model or a test stub is a few lines on the caller's side.
 *
 *  **Invariant:** a LEAF importing nothing. No network, no `Document`.
 *
 *  **Invariant:** images are BYTES, never URLs. A URL would have the provider
 *  fetch something a document named — the ambient network call `3ywf.1`
 *  forbids, routed through a third party.
 *
 *  **Invariant:** no sampling knobs on {@link AiRequest}. Temperature and the
 *  like are configuration of the model the caller built, not something a
 *  feature decides per call. */

/** One part of a message: text, or an image as encoded PNG/JPEG bytes. */
export type AiContentPart =
  | { type: 'text'; text: string }
  | { type: 'image'; bytes: Uint8Array; mediaType: 'image/png' | 'image/jpeg' };

/** One chat message. */
export interface AiMessage {
  role: 'system' | 'user' | 'assistant';
  content: string | AiContentPart[];
}

/** What a feature asks the model. */
export interface AiRequest {
  messages: AiMessage[];
  /** A JSON Schema the reply should follow. Handed to the model; the library
   *  does NOT validate the reply against it — the caller parses `text` and
   *  checks the shape it needs, since model output is input we did not write.
   *  `name` is 1-64 characters of `[A-Za-z0-9_-]`. */
  schema?: { name: string; schema: object };
  /** Upper bound on generated tokens. A reply that reaches it is an error,
   *  never a silently truncated answer. */
  maxTokens?: number;
  /** Caller cancellation. */
  signal?: AbortSignal;
}

/** What the model answered. */
export interface AiResponse {
  text: string;
  /** Token counts, when the provider reports them. */
  usage?: { inputTokens: number; outputTokens: number };
}

/** A language model a caller has configured and handed to an AI feature. */
export interface AiModel {
  complete(req: AiRequest): Promise<AiResponse>;
}
```

- [ ] **Step 4: Append `AiServiceError` to `src/errors.ts`** (after the `SeedValueError` class, before `InvalidPasswordError`)

```ts
/** An AI model service (`3ywf.2`) failed, or answered with something unusable:
 *  a non-2xx status, a refusal, a reply cut off at the token limit, a body that
 *  is not a chat completion, a response past the size cap, or no answer in
 *  time. `status` is the HTTP status when a response arrived. The API key a
 *  client was built with never appears in the message. */
export class AiServiceError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message); this.name = 'AiServiceError';
  }
}
```

- [ ] **Step 5: Export from `src/index.ts`**

Change line 3 to:
```ts
export { PdfParseError, UnsupportedFeatureError, InvalidPasswordError, ResourceLimitError, SeedValueError, AiServiceError } from './errors.js';
```
After the two `tsahttp.js` lines (around line 229-230), add:
```ts
export type { AiContentPart, AiMessage, AiRequest, AiResponse, AiModel } from './aimodel.js';
```

- [ ] **Step 6: Run the new test**

Run: `npx vitest run test/ai-model.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 7: Add README API rows**

In `README.md`, immediately before the line `### Structure` inside the API Reference (currently around line 3438), insert:

```markdown
### AI

| Class | Description |
|---|---|
| `AiModel` | A language model a caller configured and hands to an AI feature: one `complete(req)` method. Implement it to plug in any provider. |
| `AiRequest` | What a feature asks an `AiModel`: `messages`, an optional JSON `schema` for the reply (not validated by the library), `maxTokens`, and a cancellation `signal`. |
| `AiResponse` | An `AiModel`'s answer: `text`, plus token `usage` when the provider reports it. |
| `AiMessage` | One chat message: a `role` (`system`, `user`, `assistant`) and string or part-list `content`. |
| `AiContentPart` | One part of a message: `{ type: 'text', text }`, or `{ type: 'image', bytes, mediaType }` with PNG or JPEG bytes — never a URL. |
| `AiServiceError` | An AI model service failed or answered unusably (status, refusal, truncation, malformed body, size cap, timeout); `status` is the HTTP status when one arrived. |
```

Change the line `Errors: \`PdfParseError\`, \`UnsupportedFeatureError\`, \`InvalidPasswordError\`, \`ResourceLimitError\`, \`SeedValueError\`.` to end `…, \`SeedValueError\`, \`AiServiceError\`.`

- [ ] **Step 8: Fix the count sentence**

Run: `npx vitest run test/readme-api.test.ts`
Expected: FAIL only in `states the counts the compiler reports`, showing `expected { types: 405, values: 147 } to equal { types: N, values: M }`. Edit the sentence near the top of `## API Reference` (`… — 405 public types plus 147\nfunctions, classes and constants …`) to the reported `N` and `M`. Re-run: all PASS.

- [ ] **Step 9: Typecheck and commit**

Run: `npm run typecheck` — expected: no errors.

```bash
git add src/aimodel.ts src/errors.ts src/index.ts test/ai-model.test.ts README.md
git commit -m "feat(3ywf.2): AiModel seam and AiServiceError"
```
(End the message with the `Co-Authored-By` trailer the session specifies.)

---

### Task 2: `openAiModel` — one attempt, end to end

Construction, request validation, wire mapping, reply handling, bounds and redaction. Retries are wired in the code but every test here passes `maxRetries: 0` or uses non-retryable outcomes; Task 3 tests retrying.

**Files:**
- Create: `test/helpers/ai-server.ts`
- Create: `src/aiopenai.ts`
- Modify: `src/index.ts`
- Modify: `README.md` (two rows in the `### AI` table; count sentence)
- Test: `test/ai-openai.test.ts`

**Interfaces:**
- Consumes: `AiModel`, `AiRequest`, `AiResponse`, `AiMessage`, `AiContentPart` from `src/aimodel.ts`; `AiServiceError`, `rethrowLimit` from `src/errors.ts`.
- Produces:
  ```ts
  export interface OpenAiModelOptions {
    model: string; apiKey?: string; headers?: Record<string, string>; temperature?: number;
    timeoutMs?: number; maxResponseBytes?: number; maxRetries?: number;
  }
  export function openAiModel(baseUrl: string, opts: OpenAiModelOptions): AiModel;
  /** @internal — not exported from index.ts; tests inject timing. */
  export interface RetryTiming {
    baseDelayMs: number; maxDelayMs: number;
    sleep(ms: number, signal?: AbortSignal): Promise<void>;
  }
  export function createOpenAiModel(baseUrl: string, opts: OpenAiModelOptions, timing: RetryTiming): AiModel;
  ```
- Produces (test helper, `test/helpers/ai-server.ts`):
  ```ts
  export interface Hit { method: string; url: string; headers: IncomingHttpHeaders; body: string }
  export type Reply = (hit: Hit, res: ServerResponse) => void;
  export interface AiServer { url: string; hits: Hit[]; close(): Promise<void> }
  export function startAiServer(replies: Reply | Reply[]): Promise<AiServer>;
  export function completion(content: string | null, extra?: Record<string, unknown>): Reply;
  export function status(code: number, body?: unknown, headers?: Record<string, string>): Reply;
  ```

- [ ] **Step 1: Create the test server helper** — `test/helpers/ai-server.ts`

```ts
import { createServer, type IncomingHttpHeaders, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

/** A scripted local chat-completions server (`3ywf.2`). Nothing in the suite
 *  reaches the internet — the arrangement `test/sign-seed.test.ts` uses for
 *  `httpTimestampProvider`. */

export interface Hit { method: string; url: string; headers: IncomingHttpHeaders; body: string }
export type Reply = (hit: Hit, res: ServerResponse) => void;
export interface AiServer { url: string; hits: Hit[]; close(): Promise<void> }

/** Start a server answering the n-th request with `replies[n]` (the last reply
 *  repeats), or every request with `replies` when it is one function. `url` is
 *  the BASE url — the client appends `/chat/completions`. */
export async function startAiServer(replies: Reply | Reply[]): Promise<AiServer> {
  const list = Array.isArray(replies) ? replies : [replies];
  const hits: Hit[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const hit: Hit = {
        method: req.method ?? '', url: req.url ?? '', headers: req.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      };
      hits.push(hit);
      list[Math.min(hits.length - 1, list.length - 1)]!(hit, res);
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
  return {
    url, hits,
    close: () => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); }),
  };
}

/** A 200 chat completion whose message content is `content`. `extra` is merged
 *  into `choices[0]` (e.g. `{ finish_reason: 'length' }`, or a `message`). */
export function completion(content: string | null, extra: Record<string, unknown> = {}): Reply {
  return (_hit, res) => {
    const body = {
      id: 'cmpl-1', object: 'chat.completion',
      choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop', ...extra }],
      usage: { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15 },
    };
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  };
}

/** A response with `code`, a JSON (or raw string) `body`, and `headers`. */
export function status(code: number, body: unknown = {}, headers: Record<string, string> = {}): Reply {
  return (_hit, res) => {
    res.writeHead(code, { 'Content-Type': 'application/json', ...headers });
    res.end(typeof body === 'string' ? body : JSON.stringify(body));
  };
}
```

- [ ] **Step 2: Write the failing tests** — `test/ai-openai.test.ts`

```ts
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
```

- [ ] **Step 3: Run them to verify they fail**

Run: `npx vitest run test/ai-openai.test.ts`
Expected: FAIL — cannot resolve `../src/aiopenai.js`.

- [ ] **Step 4: Create `src/aiopenai.ts`**

```ts
/** An OpenAI-compatible chat-completions client (`3ywf.2`): an {@link AiModel}
 *  over the runtime's built-in `fetch` (Node >= 22), so no dependency. Works
 *  against OpenAI, Ollama, vLLM and anything else serving
 *  `POST <baseUrl>/chat/completions`.
 *
 *  The ONLY module here that touches the network, and only through an object
 *  the caller built (`3ywf.1`). A model provider is a remote party, so every
 *  attempt is bounded by a timeout and a response-size cap checked both
 *  against `Content-Length` and while streaming — `tsahttp.ts`'s arrangement.
 *
 *  **Invariant:** `max_tokens`, never `max_completion_tokens`. OpenAI's
 *  reasoning models want the latter and reject the former, but Ollama, vLLM and
 *  older servers know only `max_tokens`; the widely compatible field wins.
 *
 *  **Invariant:** a reply that stopped at the token limit THROWS. A truncated
 *  answer read as whole is the silent failure this repo refuses, and for a
 *  schema request it is invalid JSON anyway.
 *
 *  **Invariant:** the API key never appears in an error — including inside a
 *  provider message that echoes it back, which OpenAI's own 401 does. */
import type { AiContentPart, AiMessage, AiModel, AiRequest, AiResponse } from './aimodel.js';
import { AiServiceError, rethrowLimit } from './errors.js';

/** Options for {@link openAiModel}. */
export interface OpenAiModelOptions {
  /** The model name the server knows, e.g. `gpt-4o-mini` or `llama3.2`. Required. */
  model: string;
  /** Sent as `Authorization: Bearer <apiKey>`. Omit for a server that needs none. */
  apiKey?: string;
  /** Extra request headers. `apiKey`, when given, wins over an `Authorization` here. */
  headers?: Record<string, string>;
  /** Sampling temperature, passed through unchanged. */
  temperature?: number;
  /** Give up on one attempt after this many milliseconds. Default 120,000. */
  timeoutMs?: number;
  /** Refuse a response larger than this many bytes. Default 4 MiB. */
  maxResponseBytes?: number;
  /** Further attempts after a 429, a 5xx, a network error or a timeout. Default 2; 0 disables. */
  maxRetries?: number;
}

/** How long retries wait. Internal: tests inject one so they never sleep;
 *  `index.ts` does not export it. */
export interface RetryTiming {
  baseDelayMs: number;
  maxDelayMs: number;
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
}

const REAL_TIMING: RetryTiming = { baseDelayMs: 1000, maxDelayMs: 30_000, sleep: abortableSleep };
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);
const ROLES = new Set(['system', 'user', 'assistant']);
const MEDIA_TYPES = new Set(['image/png', 'image/jpeg']);
const SCHEMA_NAME = /^[A-Za-z0-9_-]{1,64}$/;
const MESSAGE_LIMIT = 500;

/** An {@link AiModel} that POSTs to `<baseUrl>/chat/completions` (`http:` or
 *  `https:` only). Validates every option now, so a misconfigured client fails
 *  when built rather than mid-run. Retries 429/500/502/503/504, network errors
 *  and timeouts up to `maxRetries` times, honouring `Retry-After` and otherwise
 *  backing off 1 s, 2 s, 4 s, …, each wait capped at 30 s; a `Retry-After`
 *  beyond that cap fails at once. Throws {@link AiServiceError} on failure. */
export function openAiModel(baseUrl: string, opts: OpenAiModelOptions): AiModel {
  return createOpenAiModel(baseUrl, opts, REAL_TIMING);
}

/** {@link openAiModel} with injectable retry timing. Internal. */
export function createOpenAiModel(baseUrl: string, opts: OpenAiModelOptions, timing: RetryTiming): AiModel {
  if (typeof baseUrl !== 'string') throw new TypeError('baseUrl must be a string');
  if (!/^https?:\/\//i.test(baseUrl)) throw new RangeError(`baseUrl must be http(s): '${baseUrl}'`);
  if (opts === null || typeof opts !== 'object') throw new TypeError('options must be an object');
  if (typeof opts.model !== 'string') throw new TypeError('model must be a string');
  if (opts.model === '') throw new RangeError('model must not be empty');
  if (opts.apiKey !== undefined && typeof opts.apiKey !== 'string') throw new TypeError('apiKey must be a string');
  if (opts.headers !== undefined && (opts.headers === null || typeof opts.headers !== 'object'))
    throw new TypeError('headers must be an object');
  const timeoutMs = numberOpt('timeoutMs', opts.timeoutMs, 120_000, (n) => n > 0 && Number.isFinite(n));
  const maxBytes = numberOpt('maxResponseBytes', opts.maxResponseBytes, 4 * 1024 * 1024, (n) => Number.isInteger(n) && n >= 1);
  const maxRetries = numberOpt('maxRetries', opts.maxRetries, 2, (n) => Number.isInteger(n) && n >= 0);
  if (opts.temperature !== undefined) numberOpt('temperature', opts.temperature, 0, Number.isFinite);

  const endpoint = baseUrl.replace(/\/+$/, '') + '/chat/completions';
  const apiKey = opts.apiKey;
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'application/json',
    ...opts.headers,
  };
  if (apiKey !== undefined) {
    for (const k of Object.keys(headers)) if (k.toLowerCase() === 'authorization') delete headers[k];
    headers['Authorization'] = `Bearer ${apiKey}`;
  }

  /** The key replaced wherever it appears. */
  const redact = (s: string): string => (apiKey ? s.split(apiKey).join('[redacted]') : s);
  const fail = (message: string, status?: number): AiServiceError => new AiServiceError(redact(message), status);

  type Outcome =
    | { kind: 'done'; response: AiResponse }
    | { kind: 'retry'; error: AiServiceError; retryAfterMs?: number };

  async function attempt(body: string, caller: AbortSignal | undefined): Promise<Outcome> {
    const timeout = AbortSignal.timeout(timeoutMs);
    const signal = caller ? AbortSignal.any([caller, timeout]) : timeout;
    let res: Response;
    let text: string;
    try {
      res = await fetch(endpoint, { method: 'POST', headers, body, signal });
      text = await readBounded(res, maxBytes, fail);
    } catch (caught) {
      rethrowLimit(caught);
      if (caller?.aborted) throw caller.reason;
      if (caught instanceof AiServiceError) throw caught; // the size cap: not retryable
      if (timeout.aborted)
        return { kind: 'retry', error: fail(`${endpoint} did not answer within ${timeoutMs} ms`) };
      return { kind: 'retry', error: fail(`${endpoint} could not be reached: ${errorText(caught)}`) };
    }
    if (!res.ok) {
      const error = fail(`${endpoint} answered HTTP ${res.status}${providerMessage(text)}`, res.status);
      if (!RETRYABLE_STATUS.has(res.status)) throw error;
      return { kind: 'retry', error, retryAfterMs: parseRetryAfter(res.headers.get('retry-after')) };
    }
    return { kind: 'done', response: parseReply(text) };
  }

  function parseReply(text: string): AiResponse {
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch (caught) {
      rethrowLimit(caught);
      throw fail(`${endpoint} answered with a body that is not JSON`);
    }
    const root = asObject(json);
    const err = asObject(root?.['error']);
    if (err) throw fail(`${endpoint} answered with an error${providerMessage(text)}`);
    const choices = root?.['choices'];
    const choice = Array.isArray(choices) ? asObject(choices[0]) : undefined;
    const message = asObject(choice?.['message']);
    const refusal = message?.['refusal'];
    if (typeof refusal === 'string' && refusal !== '')
      throw fail(`model refused: ${truncate(refusal)}`);
    if (choice?.['finish_reason'] === 'length')
      throw fail('model reply stopped at the token limit; raise maxTokens or shorten the request');
    const content = message?.['content'];
    if (typeof content !== 'string') throw fail(`${endpoint} answered with no message content`);
    const usage = asObject(root?.['usage']);
    const inputTokens = usage?.['prompt_tokens'];
    const outputTokens = usage?.['completion_tokens'];
    return typeof inputTokens === 'number' && typeof outputTokens === 'number'
      ? { text: content, usage: { inputTokens, outputTokens } }
      : { text: content };
  }

  function providerMessage(text: string): string {
    try {
      const m = asObject(asObject(asObject(JSON.parse(text))?.['error']))?.['message'];
      return typeof m === 'string' && m !== '' ? `: ${truncate(m)}` : '';
    } catch (caught) {
      rethrowLimit(caught);
      return '';
    }
  }

  async function complete(req: AiRequest): Promise<AiResponse> {
    const body = JSON.stringify(buildBody(opts, req));
    for (let tries = 0; ; tries++) {
      const outcome = await attempt(body, req.signal);
      if (outcome.kind === 'done') return outcome.response;
      if (tries >= maxRetries) throw outcome.error;
      let wait = outcome.retryAfterMs ?? timing.baseDelayMs * 2 ** tries;
      if (wait > timing.maxDelayMs) {
        if (outcome.retryAfterMs !== undefined)
          throw fail(`${outcome.error.message} (server asked to retry after ${wait} ms, past the ${timing.maxDelayMs} ms cap)`,
            outcome.error.status);
        wait = timing.maxDelayMs;
      }
      await timing.sleep(wait, req.signal);
    }
  }

  return { complete };
}

/** Validate the request and build the wire body. Throws before any I/O. */
function buildBody(opts: OpenAiModelOptions, req: AiRequest): Record<string, unknown> {
  if (req === null || typeof req !== 'object') throw new TypeError('request must be an object');
  if (!Array.isArray(req.messages)) throw new TypeError('messages must be an array');
  if (req.messages.length === 0) throw new RangeError('messages must not be empty');
  const body: Record<string, unknown> = { model: opts.model, messages: req.messages.map(wireMessage) };
  if (opts.temperature !== undefined) body['temperature'] = opts.temperature;
  if (req.maxTokens !== undefined) {
    if (typeof req.maxTokens !== 'number') throw new TypeError('maxTokens must be a number');
    if (!Number.isInteger(req.maxTokens) || req.maxTokens < 1) throw new RangeError('maxTokens must be a positive integer');
    body['max_tokens'] = req.maxTokens;
  }
  if (req.schema !== undefined) {
    const { name, schema } = req.schema;
    if (typeof name !== 'string') throw new TypeError('schema.name must be a string');
    if (!SCHEMA_NAME.test(name)) throw new RangeError(`schema.name must be 1-64 of [A-Za-z0-9_-]: '${name}'`);
    if (schema === null || typeof schema !== 'object') throw new TypeError('schema.schema must be an object');
    body['response_format'] = { type: 'json_schema', json_schema: { name, schema, strict: true } };
  }
  return body;
}

function wireMessage(m: AiMessage): Record<string, unknown> {
  if (m === null || typeof m !== 'object') throw new TypeError('each message must be an object');
  if (!ROLES.has(m.role)) throw new RangeError(`unknown message role: '${String(m.role)}'`);
  if (typeof m.content === 'string') return { role: m.role, content: m.content };
  if (!Array.isArray(m.content)) throw new TypeError('message content must be a string or an array of parts');
  return { role: m.role, content: m.content.map(wirePart) };
}

function wirePart(p: AiContentPart): Record<string, unknown> {
  if (p === null || typeof p !== 'object') throw new TypeError('each content part must be an object');
  if (p.type === 'text') {
    if (typeof p.text !== 'string') throw new TypeError('a text part needs a string text');
    return { type: 'text', text: p.text };
  }
  if (p.type === 'image') {
    if (!(p.bytes instanceof Uint8Array)) throw new TypeError('an image part needs Uint8Array bytes');
    if (p.bytes.length === 0) throw new RangeError('an image part must not be empty');
    if (!MEDIA_TYPES.has(p.mediaType)) throw new RangeError(`image mediaType must be image/png or image/jpeg: '${String(p.mediaType)}'`);
    const b64 = Buffer.from(p.bytes.buffer, p.bytes.byteOffset, p.bytes.byteLength).toString('base64');
    return { type: 'image_url', image_url: { url: `data:${p.mediaType};base64,${b64}` } };
  }
  throw new RangeError(`unknown content part type: '${String((p as { type?: unknown }).type)}'`);
}

/** Read the body as UTF-8, refusing past `max` bytes by declared length AND
 *  while streaming, so a lying or absent `Content-Length` is bounded too. */
async function readBounded(res: Response, max: number, fail: (m: string) => AiServiceError): Promise<string> {
  const declared = Number(res.headers.get('content-length'));
  if (declared > max) throw fail(`response exceeds ${max} bytes`);
  const chunks: Uint8Array[] = [];
  let total = 0;
  if (res.body) {
    const reader = res.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > max) {
        await reader.cancel();
        throw fail(`response exceeds ${max} bytes`);
      }
      chunks.push(value);
    }
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) { out.set(c, at); at += c.length; }
  return new TextDecoder().decode(out);
}

/** `Retry-After` as milliseconds: delta-seconds or an HTTP-date (0 once past). */
function parseRetryAfter(v: string | null): number | undefined {
  if (v === null) return undefined;
  const s = v.trim();
  if (/^\d+$/.test(s)) return Number(s) * 1000;
  const at = Date.parse(s);
  return Number.isNaN(at) ? undefined : Math.max(0, at - Date.now());
}

function numberOpt(name: string, v: unknown, dflt: number, ok: (n: number) => boolean): number {
  if (v === undefined) return dflt;
  if (typeof v !== 'number') throw new TypeError(`${name} must be a number`);
  if (!ok(v)) throw new RangeError(`${name} is out of range: ${v}`);
  return v;
}

function asObject(v: unknown): Record<string, unknown> | undefined {
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
}

function truncate(s: string): string {
  return s.length > MESSAGE_LIMIT ? `${s.slice(0, MESSAGE_LIMIT)}…` : s;
}

function errorText(e: unknown): string {
  const cause = e instanceof Error && e.cause instanceof Error ? `: ${e.cause.message}` : '';
  return e instanceof Error ? `${e.message}${cause}` : String(e);
}

function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(signal.reason); return; }
    const onAbort = (): void => { clearTimeout(t); reject(signal!.reason); };
    const t = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve(); }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
```

- [ ] **Step 5: Run the tests**

Run: `npx vitest run test/ai-openai.test.ts`
Expected: PASS (all). If the "never answers" case leaves the run hanging, check that `close()` calls `server.closeAllConnections()`.

- [ ] **Step 6: Export from `src/index.ts`** — after the `aimodel.js` line from Task 1, add:

```ts
export { openAiModel } from './aiopenai.js';
export type { OpenAiModelOptions } from './aiopenai.js';
```
(Do NOT export `createOpenAiModel` or `RetryTiming`.)

- [ ] **Step 7: README rows and counts**

Add to the `### AI` table from Task 1, directly under the header row:
```markdown
| `openAiModel(baseUrl, opts)` | An `AiModel` for any OpenAI-compatible server (OpenAI, Ollama, vLLM): POSTs to `<baseUrl>/chat/completions` over the built-in `fetch`, bounded by a timeout and a response-size cap, retrying 429/5xx with `Retry-After`. No default endpoint. |
| `OpenAiModelOptions` | Options for `openAiModel`: required `model`; `apiKey`, `headers`, `temperature`, `timeoutMs` (default 120,000), `maxResponseBytes` (default 4 MiB), `maxRetries` (default 2). |
```
Then run `npx vitest run test/readme-api.test.ts` and update the count sentence to the reported numbers, as in Task 1 Step 8.

- [ ] **Step 8: Gates and commit**

Run: `npm run typecheck`, then `npx vitest run test/ai-openai.test.ts test/ai-model.test.ts test/readme-api.test.ts test/limits-catch.test.ts test/import-cycles.test.ts`
Expected: all PASS. (`limits-catch` proves every new `catch` calls `rethrowLimit`; `import-cycles` proves no new 2-cycle.)

```bash
git add src/aiopenai.ts src/index.ts test/helpers/ai-server.ts test/ai-openai.test.ts README.md
git commit -m "feat(3ywf.2): openAiModel, an OpenAI-compatible AiModel over fetch"
```

---

### Task 3: Retries and cancellation

The retry loop already exists from Task 2; this task pins it, through `createOpenAiModel` with a recording `RetryTiming` so no test sleeps for real (except the abort case, which must).

**Files:**
- Test: `test/ai-openai-retry.test.ts`
- Modify: `src/aiopenai.ts` only if a test exposes a defect

**Interfaces:**
- Consumes: `createOpenAiModel(baseUrl, opts, timing)`, `RetryTiming` from `src/aiopenai.ts`; `startAiServer`, `completion`, `status` from `test/helpers/ai-server.ts`.

- [ ] **Step 1: Write the tests** — `test/ai-openai-retry.test.ts`

```ts
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
```

- [ ] **Step 2: Run them**

Run: `npx vitest run test/ai-openai-retry.test.ts`
Expected: PASS. A failure here is a defect in Task 2's `complete`/`attempt`; fix `src/aiopenai.ts`, not the test, and re-run both `test/ai-openai*.test.ts` files.

- [ ] **Step 3: Commit**

```bash
git add test/ai-openai-retry.test.ts src/aiopenai.ts
git commit -m "test(3ywf.2): pin openAiModel retries and cancellation"
```

---

### Task 4: Docs, mutation checks, and gates

**Files:**
- Modify: `README.md` (example section; Scope and Limitations network paragraph)
- Modify: `CLAUDE.md` (Source list; Conventions error list)
- Modify: `CHANGELOG.md` (`## [Unreleased]` → `### Added`)

- [ ] **Step 1: README example** — insert immediately before the line `## API Reference`:

````markdown
### Connect an AI Model

AI features take a model you build and never call a default endpoint. `openAiModel` speaks the OpenAI chat-completions protocol, so it works with OpenAI and with local servers such as Ollama or vLLM:

```ts
import { openAiModel, type AiModel } from '@asposefoss/pdf';

const model: AiModel = openAiModel('https://api.openai.com/v1', {
  model: 'gpt-4o-mini',
  apiKey: process.env.OPENAI_API_KEY,
});
// A local server needs no key: openAiModel('http://localhost:11434/v1', { model: 'llama3.2' })

const { text, usage } = await model.complete({
  messages: [{ role: 'user', content: 'Summarize PDF/A in one sentence.' }],
  maxTokens: 200,
});
```

Each attempt is bounded by `timeoutMs` (default 120 s) and `maxResponseBytes` (default 4 MiB). Rate limits and server errors (429, 500, 502, 503, 504) are retried up to `maxRetries` times (default 2), honouring `Retry-After`. Failures raise `AiServiceError`, which never contains your API key. A reply that hit `maxTokens` is an error rather than a silently truncated answer. To use another provider, implement `AiModel`'s single `complete` method yourself.
````

- [ ] **Step 2: README Scope and Limitations** — in the `**Network calls only through a client you build, by decision**` bullet, replace

`Today that is \`httpTimestampProvider(url)\`, an RFC 3161 timestamp client over Node's built-in \`fetch\`, bounded by a timeout and a response-size cap.`

with

`Today there are two: \`httpTimestampProvider(url)\`, an RFC 3161 timestamp client, and \`openAiModel(baseUrl, opts)\`, a chat-completions client for OpenAI-compatible servers — both over Node's built-in \`fetch\`, bounded by a timeout and a response-size cap, with no default endpoint.`

- [ ] **Step 3: CHANGELOG** — under `## [Unreleased]`, in `### Added` (create the heading if absent), add:

```markdown
- **An AI model client, the seam for AI features.** `AiModel` is a one-method interface (`complete({ messages, schema?, maxTokens?, signal? })` → `{ text, usage? }`) that upcoming AI features — OCR into an invisible text layer, summarization, alt-text — take as an argument, so any provider, a local model or a test stub plugs in as a few-line object. `openAiModel(baseUrl, { model, apiKey?, … })` implements it for any OpenAI-compatible server (OpenAI, Ollama, vLLM) over Node's built-in `fetch`: still no runtime dependency, and no default endpoint, per the decision that this library reaches a host only through a client the caller builds. Messages carry text and PNG/JPEG bytes — never URLs, which would have the provider fetch something a document named. An optional JSON Schema is passed to the model as `response_format`; the library does not validate replies against it. Each attempt is bounded by a timeout (120 s) and a response cap (4 MiB, enforced while streaming, so a missing or false `Content-Length` cannot bypass it); 429 and 5xx are retried twice by default, honouring `Retry-After` and capping every wait at 30 s. A reply cut off at `maxTokens` throws `AiServiceError` instead of returning a truncated answer, and the API key is redacted even from provider messages that echo it, as OpenAI's 401 does. `maxTokens` is sent as `max_tokens`, which local servers understand; OpenAI's reasoning models reject it. (3ywf.2)
```

- [ ] **Step 4: CLAUDE.md** — in the Source list, directly after the `**tsahttp.ts**` entry, add:

```markdown
- **aimodel.ts**, **aiopenai.ts** — the AI model seam and its OpenAI-compatible
  client (`3ywf.2`). `aimodel.ts` is a types-only LEAF importing nothing:
  `AiModel` (one `complete` method), `AiRequest`, `AiResponse`, `AiMessage`,
  `AiContentPart`. AI features (`3ywf.3`, `3ywf.4`) depend on it and never on
  HTTP. `aiopenai.ts` is `openAiModel`, the second network client after
  `tsahttp.ts` and built the same way — built-in `fetch`, a per-attempt
  timeout, a response cap checked against `Content-Length` AND while
  streaming.
  **Invariant (`3ywf.1`):** no default endpoint — `baseUrl` and `model` are
  required — and images are BYTES, never URLs, since a URL would have the
  provider fetch what a document named.
  **Invariant:** the library does NOT validate a reply against `schema`. A
  general JSON Schema validator is a subsystem of its own; each feature
  parses `text` and checks the exact shape it needs.
  **Invariant:** `finish_reason: 'length'` THROWS — a truncated answer read as
  whole is the silent failure this repo refuses.
  **Invariant:** the API key is redacted from every message, including a
  provider message that echoes it (OpenAI's 401 does).
  **Invariant:** `max_tokens`, never `max_completion_tokens` — the widely
  compatible field, though OpenAI's reasoning models reject it.
  **Note:** retry timing is injectable through the internal
  `createOpenAiModel`/`RetryTiming`, which `index.ts` does not export, so the
  retry tests never sleep.
```

In the Conventions **Errors** bullet, change the list to read `` `PdfParseError`, `UnsupportedFeatureError`, `InvalidPasswordError`, `ResourceLimitError`, `SeedValueError` or `AiServiceError` `` and add after the `SeedValueError` sentence: `An \`AiServiceError\` is for an AI model service that failed or answered unusably (\`3ywf.2\`); \`status\` is the HTTP status when one arrived.`

Run the CLAUDE.md module sweep and confirm it prints nothing:
```bash
for f in src/*.ts; do b=$(basename "$f"); grep -q "[*\`]$b[*\`]" CLAUDE.md || echo "$b"; done
```

- [ ] **Step 5: Mutation checks** — for each row, apply the mutation with the Edit tool, **confirm with `git diff src/aiopenai.ts` that it applied**, run the named file, confirm it goes RED, then `git checkout -- src/aiopenai.ts`. If a run hangs, kill orphaned vitest node processes before the next run.

| Mutation in `src/aiopenai.ts` | Must redden |
|---|---|
| In `readBounded`, delete the `if (total > max) { … }` block | `test/ai-openai.test.ts` — "chunked response that grows past the cap" |
| In `parseReply`, delete the `finish_reason === 'length'` throw | `test/ai-openai.test.ts` — "cut off at the token limit" |
| In `attempt`, change `if (!RETRYABLE_STATUS.has(res.status)) throw error;` to `if (false) throw error;` | `test/ai-openai.test.ts` — "non-retryable 4xx at once"; `test/ai-openai-retry.test.ts` — "never retries a 400" |
| In `complete`, change `outcome.retryAfterMs ?? timing.baseDelayMs * 2 ** tries` to `timing.baseDelayMs * 2 ** tries` | `test/ai-openai-retry.test.ts` — the three `Retry-After` cases |
| Change `redact` to `(s: string): string => s` | `test/ai-openai.test.ts` — "never puts the API key in an error" |
| In `buildBody`, change `if (req.messages.length === 0)` to `if (false)` | `test/ai-openai.test.ts` — "refuses empty messages without a request" |

If any mutation leaves its test GREEN, stop: either the mutation did not apply, or the test does not pin the rule — fix the test and record it.

- [ ] **Step 6: Full gates**

Run: `npm run typecheck` — expected no errors.
Run: `npm test` — expected all green.

- [ ] **Step 7: Commit, close, push**

```bash
git add README.md CLAUDE.md CHANGELOG.md
git commit -m "docs(3ywf.2): AI model client — README, CLAUDE.md, CHANGELOG"
bd close aspose-pdf-foss-for-ts-3ywf.2 --reason "AiModel seam + openAiModel shipped; 3ywf.3/3ywf.4 can build on it"
git pull --rebase && git push && git status
```

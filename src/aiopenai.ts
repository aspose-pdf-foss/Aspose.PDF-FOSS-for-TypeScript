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
  checkBaseUrl(baseUrl);
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
      const m = asObject(asObject(JSON.parse(text))?.['error'])?.['message'];
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

/** `baseUrl` must parse as http(s) with a host, and carry no credentials, query
 *  or fragment. Every error message names `endpoint`, so a secret in the URL
 *  would be quoted back — Node's fetch even refuses a URL with credentials
 *  and repeats it in its own message. The refusals therefore never quote the
 *  URL. A query would also land BEFORE the appended `/chat/completions`. */
function checkBaseUrl(baseUrl: string): void {
  let u: URL;
  try {
    u = new URL(baseUrl);
  } catch (caught) {
    rethrowLimit(caught);
    throw new RangeError('baseUrl is not a valid URL');
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new RangeError('baseUrl must be http(s)');
  if (u.username !== '' || u.password !== '')
    throw new RangeError('baseUrl must not carry credentials; pass apiKey or headers instead');
  if (u.search !== '' || u.hash !== '') throw new RangeError('baseUrl must not carry a query or a fragment');
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

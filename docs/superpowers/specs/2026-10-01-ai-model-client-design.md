# AI model client — design (`3ywf.2`)

Epic `3ywf` (AI copilots). Decision `3ywf.1`: outbound network calls happen
only through a client object the caller constructs; no ambient calls, no
default endpoints. This issue supplies that client for `3ywf.3` (MakeSearchable
OCR) and `3ywf.4` (summarization, Q&A, alt-text).

## Goal

A seam that `3ywf.3` and `3ywf.4` are written against without touching HTTP,
plus one implementation of it for OpenAI-compatible servers (OpenAI, Ollama,
vLLM, …).

## Constraints

- Zero runtime dependencies: the runtime's built-in `fetch` (Node >= 22), as
  `tsahttp.ts` uses — not raw `node:https`, despite the issue title.
- A remote party is bounded: per-attempt timeout, response-size cap checked
  against `Content-Length` AND while streaming.
- No network in the test suite: local `node:http` servers only.
- The library never chooses an endpoint. `baseUrl` and `model` are required.

## Decisions taken in brainstorming

1. **An interface plus one implementation.** Features depend on `AiModel`; the
   OpenAI client merely implements it. Any other provider, a local model or a
   test stub is a few-line function on the caller's side.
2. **Structured output is an optional `schema` on the request**, sent to the
   model as a JSON Schema. The library does NOT validate replies against it —
   a general schema validator is a subsystem of its own. The client returns
   text; each feature parses it and checks the exact shape it needs with a
   typed guard, since model JSON is input we did not write.
3. **Bounded retry, on by default** for 429/5xx, honouring `Retry-After`.

## Units

### `src/aimodel.ts` — types only

A leaf importing nothing. No network, no `Document`.

```ts
export type AiContentPart =
  | { type: 'text'; text: string }
  | { type: 'image'; bytes: Uint8Array; mediaType: 'image/png' | 'image/jpeg' };

export interface AiMessage {
  role: 'system' | 'user' | 'assistant';
  content: string | AiContentPart[];
}

export interface AiRequest {
  messages: AiMessage[];
  /** JSON Schema handed to the model. Not validated by the library. */
  schema?: { name: string; schema: object };
  maxTokens?: number;
  /** Caller cancellation: aborts the in-flight request and any backoff wait. */
  signal?: AbortSignal;
}

export interface AiResponse {
  text: string;
  usage?: { inputTokens: number; outputTokens: number };
}

export interface AiModel {
  complete(req: AiRequest): Promise<AiResponse>;
}
```

- **Result object, not a bare string** — `usage` matters on a 300-page OCR
  run, and an object can grow without breaking every caller's adapter.
- **Images are bytes, never URLs.** A URL would make the provider fetch
  something a document named: the ambient call `3ywf.1` forbids, routed
  through a third party. Features render or extract pixels and hand over bytes.
- **No sampling knobs on the request.** `temperature` and the like are model
  configuration and belong to the client the caller builds.

### `src/aiopenai.ts` — `openAiModel(baseUrl, opts): AiModel`

The only module here that touches the network.

```ts
export interface OpenAiModelOptions {
  model: string;                 // required, non-empty
  apiKey?: string;               // sent as Authorization: Bearer
  headers?: Record<string, string>;
  temperature?: number;
  timeoutMs?: number;            // per attempt, default 120_000
  maxResponseBytes?: number;     // default 4 MiB
  maxRetries?: number;           // default 2; 0 disables
}
```

**Construction validates everything** — `baseUrl` is http(s), `model` is a
non-empty string, `timeoutMs` > 0, `maxResponseBytes` a positive integer,
`maxRetries` a non-negative integer, `temperature` finite — throwing
`TypeError`/`RangeError` by the repo's kind-versus-set split. A misconfigured
client fails when built, not on page 147.

**Endpoint.** `POST baseUrl + '/chat/completions'`, trailing slashes trimmed
from `baseUrl`.

**Wire mapping.**

| Request | Body |
|---|---|
| `messages[].content` string | passed through |
| text part | `{ type: 'text', text }` |
| image part | `{ type: 'image_url', image_url: { url: 'data:<mediaType>;base64,…' } }` |
| `schema` | `response_format: { type: 'json_schema', json_schema: { name, schema, strict: true } }` |
| `maxTokens` | `max_tokens` |
| `opts.temperature` | `temperature` |
| `opts.model` | `model` |

`max_tokens` is deliberate: OpenAI's reasoning models want
`max_completion_tokens` and reject `max_tokens`, but Ollama, vLLM and older
servers know only `max_tokens`. The widely compatible field wins and the
choice is documented.

**Reply.** `choices[0].message.content` becomes `text`;
`usage.prompt_tokens`/`completion_tokens` become `usage` when both are numbers.

**Failures — `AiServiceError`**, a new public error in `errors.ts`, carrying
`status?: number`:

- non-2xx, not retryable (or retries exhausted): status plus the provider's
  `error.message`, truncated to 500 characters;
- `message.refusal` present: refused;
- `finish_reason === 'length'`: truncated. A truncated answer read as whole is
  the silent failure this repo refuses, and for a schema request it is
  invalid JSON anyway;
- a body that is not JSON, or no string `choices[0].message.content`;
- response past `maxResponseBytes`; timeout after retries are exhausted.

The API key never appears in any message.

**Retries.** Retryable: HTTP 429, 500, 502, 503, 504, a network error, and a
per-attempt timeout. Up to `maxRetries` further attempts. The wait is
`Retry-After` (delta-seconds or HTTP-date) when present, else exponential
`1 s, 2 s, 4 s, …`; every wait is capped at 30 s, and a `Retry-After` past the
cap fails at once rather than waiting. The caller's `signal` aborts the
in-flight request (combined with the per-attempt timeout through
`AbortSignal.any`) and any backoff wait, and a caller abort is never retried.
The backoff base is injectable inside the module (not exported publicly) so
tests do not sleep.

## Testing

All against local `node:http` servers (the `tsahttp` test arrangement).

- **Wire:** a recording server asserts path, `Authorization`, the image data
  URI, `response_format`, `max_tokens`, `temperature`, `model`.
- **Reply:** success with `usage`; `refusal`; `finish_reason: 'length'`;
  missing content; a non-JSON body.
- **Key redaction:** a 401 whose body echoes the key; the thrown message must
  not contain it.
- **Bounds:** oversize by `Content-Length`; oversize chunked with no length
  (pins the streaming check); a server that never answers, short `timeoutMs`.
- **Retries:** 503 then 200 succeeds with two hits counted; 400 hit exactly
  once; `Retry-After: 0` honoured; `Retry-After` past the cap fails without
  waiting; `maxRetries: 0`; an abort during backoff returns promptly.
- **Construction:** each invalid option throws, by type.
- **Seam:** a three-line stub `AiModel` type-checks — the interface is
  implementable with no HTTP.
- **Mutation checks** (each must redden a case): the streaming cap, the
  truncation throw, the non-retryable 4xx, honouring `Retry-After`, the key
  redaction.

## Documentation

- README: a "Connect an AI Model" example (OpenAI, plus an Ollama line); API
  Reference rows for every new export (`test/readme-api.test.ts` enforces it);
  the network paragraph in Scope and Limitations names both clients.
- CLAUDE.md: Source-list entries for `aimodel.ts` and `aiopenai.ts`.
- CHANGELOG `[Unreleased]` **Added** entry.

## Out of scope

Streaming responses; tool/function calling; embeddings (`3ywf.4` adds them if
Q&A genuinely needs retrieval); concurrency control (the feature driving many
calls owns it); adapters for providers other than OpenAI-compatible ones.

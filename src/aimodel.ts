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

/** Token counts summed across the requests one feature made. */
export interface AiUsage { inputTokens: number; outputTokens: number }

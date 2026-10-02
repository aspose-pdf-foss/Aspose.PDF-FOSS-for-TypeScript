/** `doc.Ask` (`3ywf.4`): an answer drawn from the document, with the pages it
 *  came from, or an honest "not found".
 *
 *  The document is cut into page-anchored windows, ranked against the question
 *  locally with BM25 — no model call — and the best windows go in ONE request.
 *
 *  **Invariant:** a cited page that was not among the excerpts SENT is dropped.
 *  A model cannot cite what it was not shown, so such a citation is invented.
 *
 *  **Invariant:** with no shared term (every score 0) the windows go in
 *  DOCUMENT order, which serves "what is this document about?"; otherwise only
 *  windows that scored are candidates.
 *
 *  **Invariant (`u0ec`):** `found: false` cites NO pages, whatever the reply
 *  listed — an answer that was not found has no source to point at.
 *
 *  **Invariant (`u0ec`):** the request never exceeds `maxInputChars`. A
 *  question that leaves no room for even the best excerpt is a `RangeError`
 *  before any request, not an oversized request the provider refuses.
 *
 *  **Note the two orders, both deliberate:** the request lists excerpts in
 *  document order, which is how a reader follows them; the result lists them in
 *  rank order, which is what a caller showing evidence wants first. */
import type { Document } from './document.js';
import type { AiModel, AiUsage } from './aimodel.js';
import { AiServiceError } from './errors.js';
import { parseJsonReply } from './aijson.js';
import { rankBm25 } from './bm25.js';
import {
  checkModel, DEFAULT_INPUT_CHARS, intOption, MIN_INPUT_CHARS, pageTexts, PROMPT_RESERVE,
  requireText, windowPages,
} from './aichunk.js';

export interface AskOptions {
  /** Pages to search: `[1, 3]` or `"1-5,8"`. Default all. */
  pages?: number[] | string;
  /** Characters per request. Default 48,000; at least 4,000. */
  maxInputChars?: number;
  /** Most excerpts sent. Default 8. */
  maxChunks?: number;
  signal?: AbortSignal;
}
export interface AskExcerpt { page: number; text: string }
export interface AskResult {
  answer: string;
  /** False when the excerpts did not contain the answer. */
  found: boolean;
  /** Pages the answer cites, each among the excerpts sent. */
  pages: number[];
  /** What was sent, most relevant first. */
  excerpts: AskExcerpt[];
  usage?: AiUsage;
}

const SYSTEM =
  'You answer questions about a document using ONLY the excerpts given. Each excerpt starts with its page as [page N]. ' +
  'Cite in pages the page numbers your answer relies on. If the excerpts do not contain the answer, set found to false ' +
  'and say so in answer; do not guess. Reply with JSON only.';

const SCHEMA = {
  type: 'object', additionalProperties: false, required: ['answer', 'found', 'pages'],
  properties: {
    answer: { type: 'string' },
    found: { type: 'boolean' },
    pages: { type: 'array', items: { type: 'integer' } },
  },
};

export async function ask(doc: Document, model: AiModel, question: string, opts: AskOptions = {}): Promise<AskResult> {
  checkModel(model);
  if (typeof question !== 'string') throw new TypeError('question must be a string');
  if (!question.trim()) throw new RangeError('question must not be empty');
  if (opts === null || typeof opts !== 'object') throw new TypeError('options must be an object');
  const max = intOption('maxInputChars', opts.maxInputChars, DEFAULT_INPUT_CHARS, MIN_INPUT_CHARS);
  const maxChunks = intOption('maxChunks', opts.maxChunks, 8, 1);
  const windows = windowPages(requireText(pageTexts(doc, opts.pages)));

  const ranked = rankBm25(windows.map((w) => w.text), question);
  const order = ranked[0]!.score > 0
    ? ranked.filter((r) => r.score > 0).map((r) => r.index)
    : windows.map((_, i) => i);
  const budget = max - PROMPT_RESERVE - question.length;
  const chosen: number[] = [];
  let used = 0;
  for (const i of order) {
    if (chosen.length >= maxChunks) break;
    const len = windows[i]!.text.length;
    if (used + len > budget) break;
    chosen.push(i);
    used += len;
  }

  if (chosen.length === 0)
    throw new RangeError(`question is too long for maxInputChars ${max}: it leaves no room for an excerpt`);
  const docOrder = [...chosen].sort((a, b) => a - b);
  const body = docOrder.map((i) => `[page ${windows[i]!.page}]\n${windows[i]!.text}`).join('\n\n');
  if (opts.signal?.aborted) throw opts.signal.reason;
  const r = await model.complete({
    messages: [
      { role: 'system', content: SYSTEM },
      { role: 'user', content: `Excerpts:\n\n${body}\n\nQuestion: ${question}` },
    ],
    schema: { name: 'document_answer', schema: SCHEMA },
    signal: opts.signal,
  });

  const reply = parseReply(r.text);
  const sent = new Set(docOrder.map((i) => windows[i]!.page));
  const pages = !reply.found ? [] : [...new Set(reply.pages.filter((p) => Number.isInteger(p) && sent.has(p)))].sort((a, b) => a - b);
  return {
    answer: reply.answer,
    found: reply.found,
    pages,
    excerpts: chosen.map((i) => ({ page: windows[i]!.page, text: windows[i]!.text })),
    usage: r.usage,
  };
}

function parseReply(text: string): { answer: string; found: boolean; pages: number[] } {
  const bad = (): AiServiceError => new AiServiceError('answer reply is not the requested shape');
  const json = parseJsonReply(text, bad);
  if (json === null || typeof json !== 'object') throw bad();
  const { answer, found, pages } = json as { answer?: unknown; found?: unknown; pages?: unknown };
  if (typeof answer !== 'string' || typeof found !== 'boolean' || !Array.isArray(pages)) throw bad();
  if (!pages.every((p) => typeof p === 'number')) throw bad();
  return { answer, found, pages: pages as number[] };
}

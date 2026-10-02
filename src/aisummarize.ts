/** `doc.Summarize` (`3ywf.4`): a summary of a document of any length.
 *
 *  Fits one request: one request. Otherwise MAP-REDUCE — each chunk is
 *  summarized, then the partial summaries are packed and combined, repeating
 *  while more than one piece remains.
 *
 *  **Invariant:** `instructions` reach the FINAL request only, so "in German"
 *  does not translate every partial summary on the way.
 *
 *  **Invariant:** the reduce is bounded at {@link MAX_DEPTH} levels; past it the
 *  remaining summaries go in ONE final request whatever its size. A bound
 *  reached is then the model's error to report, never a silent truncation.
 *
 *  **Invariant (`u0ec`):** a reduce level that did not SHRINK the text ends
 *  the reduce there — the next level would only repeat it. The final request
 *  then goes as at the depth bound, so a model that answers at length costs
 *  one level, not six. */
import type { Document } from './document.js';
import type { AiModel, AiUsage } from './aimodel.js';
import { AiServiceError } from './errors.js';
import {
  addUsage, checkModel, DEFAULT_INPUT_CHARS, intOption, MIN_INPUT_CHARS, packPages, packTexts,
  pageTexts, PROMPT_RESERVE, requireText,
} from './aichunk.js';

export interface SummarizeOptions {
  /** Pages to summarize: `[1, 3]` or `"1-5,8"`. Default all. */
  pages?: number[] | string;
  /** How the summary should read, e.g. `"three bullet points, in German"`. */
  instructions?: string;
  /** Characters per request. Default 48,000; at least 4,000. */
  maxInputChars?: number;
  signal?: AbortSignal;
}

export interface SummarizeResult {
  text: string;
  /** Model calls made. */
  requests: number;
  /** Summed across requests; absent when no reply reported usage. */
  usage?: AiUsage;
}

const MAX_DEPTH = 6;
const SINGLE = 'Summarize this document faithfully and concisely, keeping names, numbers and conclusions. Reply with the summary only.';
const MAP = 'You summarize part of a longer document. Summarize this part faithfully and concisely, keeping names, numbers and conclusions. Reply with the summary only.';
const REDUCE = 'You combine partial summaries of one document, given in order, into one coherent summary. Reply with the summary only.';
const SEPARATOR = '\n\n---\n\n';

export async function summarize(doc: Document, model: AiModel, opts: SummarizeOptions = {}): Promise<SummarizeResult> {
  checkModel(model);
  if (opts === null || typeof opts !== 'object') throw new TypeError('options must be an object');
  if (opts.instructions !== undefined && typeof opts.instructions !== 'string')
    throw new TypeError('instructions must be a string');
  const max = intOption('maxInputChars', opts.maxInputChars, DEFAULT_INPUT_CHARS, MIN_INPUT_CHARS);
  const pages = requireText(pageTexts(doc, opts.pages));
  const budget = max - PROMPT_RESERVE;

  let requests = 0;
  let usage: AiUsage | undefined;
  const call = async (system: string, text: string): Promise<string> => {
    if (opts.signal?.aborted) throw opts.signal.reason;
    requests++;
    const r = await model.complete({
      messages: [{ role: 'system', content: system }, { role: 'user', content: text }],
      signal: opts.signal,
    });
    usage = addUsage(usage, r.usage);
    const out = r.text.trim();
    if (!out) throw new AiServiceError('summary reply is empty');
    return out;
  };
  const final = (system: string): string =>
    (opts.instructions ? `${system}\n\nInstructions: ${opts.instructions}` : system);

  const chunks = packPages(pages, budget);
  if (chunks.length === 1) return { text: await call(final(SINGLE), chunks[0]!.text), requests, usage };

  let parts: string[] = [];
  for (const c of chunks) parts.push(await call(MAP, c.text));
  for (let depth = 1; ; depth++) {
    const packed = packTexts(parts, budget);
    if (packed.length === 1 || depth >= MAX_DEPTH) {
      const text = packed.length === 1 ? packed[0]! : parts.join(SEPARATOR);
      return { text: await call(final(REDUCE), text), requests, usage };
    }
    const next: string[] = [];
    for (const p of packed) next.push(await call(REDUCE, p));
    const size = (xs: string[]): number => xs.reduce((s, x) => s + x.length, 0);
    const shrank = size(next) < size(parts);
    parts = next;
    if (!shrank) return { text: await call(final(REDUCE), parts.join(SEPARATOR)), requests, usage };
  }
}

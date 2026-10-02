/** Page text cut to fit a model request (`3ywf.4`): the text pipeline shared by
 *  `Summarize` and `Ask`.
 *
 *  Pure but for {@link pageTexts}, which reads `page.GetText()` — so the text is
 *  page-anchored and hidden optional content is already gone.
 *
 *  **Invariant:** budgets are CHARACTERS, not tokens. `AiModel` knows neither a
 *  model's tokenizer nor its context window; 48,000 characters is about 12k
 *  tokens of English and fits every current chat model with room to reply.
 *
 *  **Invariant:** one split rule, {@link splitOversized}, for both packers —
 *  so Summarize and Ask cannot disagree about where an oversized page breaks.
 *
 *  **Invariant (`u0ec`):** every hard cut goes through {@link cutAt}, so no
 *  piece, window or context begins or ends inside a surrogate pair. */
import type { Document } from './document.js';
import type { AiUsage } from './aimodel.js';
import { resolvePages } from './pagerange.js';

export const PROMPT_RESERVE = 2000;
export const MIN_INPUT_CHARS = 4000;
export const DEFAULT_INPUT_CHARS = 48_000;

export interface PageText { page: number; text: string }
export interface Chunk { pages: number[]; text: string }
export interface Window { page: number; text: string }

/** The text of each selected page that has any, in page order. */
export function pageTexts(doc: Document, pages: number[] | string | undefined): PageText[] {
  return resolvePages(pages, doc.Pages.length)
    .map((n) => ({ page: n, text: doc.Pages[n - 1]!.GetText() }))
    .filter((p) => p.text.trim() !== '');
}

/** `pages`, or a RangeError when there is nothing to send. */
export function requireText(pages: PageText[]): PageText[] {
  if (pages.length === 0)
    throw new RangeError('the document has no extractable text on the selected pages (scanned pages? see MakeSearchable)');
  return pages;
}

const isHigh = (c: number): boolean => c >= 0xd800 && c <= 0xdbff;
const isLow = (c: number): boolean => c >= 0xdc00 && c <= 0xdfff;
/** True when index `i` of `t` falls between the two halves of a surrogate pair. */
const splitsPair = (t: string, i: number): boolean =>
  i > 0 && i < t.length && isHigh(t.charCodeAt(i - 1)) && isLow(t.charCodeAt(i));

/** `i`, moved back one when it would split a surrogate pair — the one rule
 *  every hard cut here takes, so no cut leaves a lone half (`u0ec`). */
export function cutAt(t: string, i: number): number {
  return splitsPair(t, i) ? i - 1 : i;
}

/** Cut `text` into pieces of at most `max` characters, at the last blank line,
 *  else the last newline, else the last space, else hard — never inside a
 *  surrogate pair. Pieces are trimmed; blank pieces are dropped. */
export function splitOversized(text: string, max: number): string[] {
  const out: string[] = [];
  let rest = text.trim();
  while (rest.length > max) {
    const head = rest.slice(0, max + 1);
    let cut = head.lastIndexOf('\n\n');
    if (cut <= 0) cut = head.lastIndexOf('\n');
    if (cut <= 0) cut = head.lastIndexOf(' ');
    if (cut <= 0) {
      cut = cutAt(rest, max);
      if (cut <= 0) cut = max;
    }
    const piece = rest.slice(0, cut).trim();
    if (piece) out.push(piece);
    rest = rest.slice(cut).trim();
  }
  if (rest) out.push(rest);
  return out;
}

/** Consecutive pages packed into chunks of at most `budget` characters, each
 *  page's text labelled `[page N]`. An oversized page becomes several chunks. */
export function packPages(pages: PageText[], budget: number): Chunk[] {
  const chunks: Chunk[] = [];
  let cur: Chunk | undefined;
  for (const p of pages) {
    const label = `[page ${p.page}]\n`;
    for (const piece of splitOversized(p.text, budget - label.length)) {
      const part = label + piece;
      if (cur && cur.text.length + 2 + part.length <= budget) {
        cur.text += '\n\n' + part;
        if (!cur.pages.includes(p.page)) cur.pages.push(p.page);
      } else {
        cur = { pages: [p.page], text: part };
        chunks.push(cur);
      }
    }
  }
  return chunks;
}

/** Consecutive texts joined with a blank line into pieces of at most `budget`
 *  characters; an oversized text is split by {@link splitOversized}. */
export function packTexts(texts: string[], budget: number): string[] {
  const out: string[] = [];
  for (const t of texts) {
    for (const piece of splitOversized(t, budget)) {
      const last = out.length - 1;
      if (last >= 0 && out[last]!.length + 2 + piece.length <= budget) out[last] += '\n\n' + piece;
      else out.push(piece);
    }
  }
  return out;
}

/** Overlapping windows of at most `size` characters within each page — never
 *  across two, so a window's page is exact. A window ends at a newline or a
 *  space in its second half when it can; the next starts `overlap` characters
 *  back, at a word boundary. */
export function windowPages(pages: PageText[], size = 1500, overlap = 200): Window[] {
  const out: Window[] = [];
  for (const p of pages) {
    const t = p.text;
    let start = 0;
    while (start < t.length) {
      let end = Math.min(t.length, start + size);
      if (end < t.length) {
        const head = t.slice(start, end + 1);
        let cut = head.lastIndexOf('\n');
        if (cut < size / 2) cut = head.lastIndexOf(' ');
        if (cut < size / 2) cut = end - start;
        end = start + cut;
        if (cutAt(t, end) > start) end = cutAt(t, end);
      }
      const text = t.slice(start, end).trim();
      if (text) out.push({ page: p.page, text });
      if (end >= t.length) break;
      let next = Math.max(start + 1, end - overlap);
      const ws = t.slice(next, end).search(/\s/);
      if (ws >= 0) next += ws + 1;
      if (splitsPair(t, next)) next++;
      start = next;
    }
  }
  return out;
}

/** Usage summed; absent only when both are. */
export function addUsage(a: AiUsage | undefined, b: AiUsage | undefined): AiUsage | undefined {
  if (!a) return b;
  if (!b) return a;
  return { inputTokens: a.inputTokens + b.inputTokens, outputTokens: a.outputTokens + b.outputTokens };
}

/** An integer option: `dflt` when absent, else at least `min`. */
export function intOption(name: string, v: unknown, dflt: number, min: number): number {
  if (v === undefined) return dflt;
  if (typeof v !== 'number') throw new TypeError(`${name} must be a number`);
  if (!Number.isInteger(v) || v < min) throw new RangeError(`${name} must be an integer >= ${min}: ${v}`);
  return v;
}

/** TypeError unless `model` has a `complete` method. */
export function checkModel(model: unknown): void {
  if (model === null || typeof model !== 'object' || typeof (model as { complete?: unknown }).complete !== 'function')
    throw new TypeError('model must be an AiModel');
}

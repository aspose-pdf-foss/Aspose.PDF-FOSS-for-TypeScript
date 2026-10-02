# Summarize, Ask and GenerateAltText Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `doc.Summarize(model)`, `doc.Ask(model, question)` and `doc.GenerateAltText(model)` — three AI features over the existing `AiModel` seam that work on documents of any length and write `/Alt` into the structure tree.

**Architecture:** Two pure modules carry the reusable logic — `aichunk.ts` (page text → budgeted chunks and overlapping windows) and `bm25.ts` (local ranking). One module per feature holds the `Document`: `aisummarize.ts` (map-reduce), `aiask.ts` (rank → one request → citation filter), `aialttext.ts` (figures → images → `/Alt`, or describe-then-`AutoTag` for an untagged document). `figurecontent.ts` is extracted from `docmodel.ts` so the HTML export and alt-text share ONE figure → image mapping.

**Tech Stack:** TypeScript (strict, ESM, NodeNext — specifiers end in `.js`), `Intl.Segmenter`, vitest.

**Spec:** `docs/superpowers/specs/2026-10-01-ai-summarize-ask-alt-design.md` — read it before Task 1.

## Global Constraints

- Zero runtime dependencies. Work on branch `3ywf.4-ai-summarize-ask-alt`.
- `maxInputChars` default 48,000; `PROMPT_RESERVE` 2,000; **minimum `maxInputChars` 4,000** (refinement of the spec's 2,000: the budget left after the reserve must still hold a 1,500-character window).
- `maxChunks` default 8. Windows: size 1,500, overlap 200. Reduce depth bound 6. Alt-text context: page text trimmed to 2,000 characters. Crop render scale 2.
- Option validation happens before any model call: `TypeError` for the wrong kind of thing, `RangeError` outside the allowed set.
- An empty document (no extractable text on the selected pages) throws `RangeError` whose message contains `no extractable text`.
- Model replies are checked for shape in the feature; a malformed reply is `AiServiceError`.
- Signed documents (`hasSignatureField`) are refused by `GenerateAltText` with `UnsupportedFeatureError`.
- **Every `catch` in `src/` calls `rethrowLimit(caught)` as its first statement** and binds the error (`catch (caught) {`). `test/limits-catch.test.ts` enforces it.
- Every name exported from `src/index.ts` gets a README API Reference row and the README count sentence states the compiler's counts (`test/readme-api.test.ts` — run it and copy the counts it reports).
- `npm run typecheck` and the task's tests green before a task is done.
- **Refinement of the spec, deliberate:** in an UNTAGGED document `pages` is refused (`RangeError`), because `AutoTag` tags every page and would artifact the images on unselected pages. The untagged path reports one record per distinct image XObject; identical images in different objects share one request.
- **Refinement:** `rankBm25` returns `{ index, score }[]` rather than bare indices, so `Ask` can tell "no shared term" (every score 0) apart. When any score is positive, only positive-scoring windows are candidates.

## Review Focus

1. **A selection of pages that carry no text** (a scanned range, `pages: [3]` on a cover-only scan) — Summarize and Ask refuse with the `no extractable text` error, not a request about nothing. Pinned in Task 3.
2. **A model citing pages as strings** (`"pages": ["3"]`) — the shape check rejects it with `AiServiceError` rather than silently citing nothing. Pinned in Task 4.
3. **A figure on a `/Rotate 90` page with no image** — the cropped render covers the figure, not a rotated-wrong region. Pinned in Task 5 (region dimensions under rotation).
4. **A question and document in a non-Latin script** — Japanese text ranks and the right page is sent. Pinned in Task 4.
5. **Running `GenerateAltText` twice** — the second run makes no requests and changes nothing; and in an untagged document an image drawn on two pages is described once and both draws become `/Figure`s with `/Alt`. Pinned in Task 6.

---

## File Structure

| File | Responsibility |
|---|---|
| `src/aimodel.ts` (modify) | add exported `AiUsage` type |
| `src/aichunk.ts` (create) | `pageTexts`, `requireText`, `splitOversized`, `packPages`, `packTexts`, `windowPages`, `addUsage`, `intOption`, `checkModel`, constants |
| `src/bm25.ts` (create) | `tokenize`, `rankBm25` |
| `src/aisummarize.ts` (create) | `summarize`, `SummarizeOptions`, `SummarizeResult` |
| `src/aiask.ts` (create) | `ask`, `AskOptions`, `AskExcerpt`, `AskResult` |
| `src/figurecontent.ts` (create) | `FigureContent` (images and extent behind a structure element), `PlacedImage` |
| `src/docmodel.ts` (modify) | use `FigureContent` instead of its private `pageMcidImages`/`figureStreams` |
| `src/raster.ts` (modify) | `renderPageRegionToPng` |
| `src/aialttext.ts` (create) | `generateAltText`, `AltTextOptions`, `AltTextFigure`, `AltTextReport` |
| `src/document.ts`, `src/index.ts` (modify) | three methods; exports |
| `test/helpers/scripted-model.ts` (create) | an `AiModel` stub that records requests |
| `test/aichunk.test.ts`, `test/bm25.test.ts`, `test/ai-summarize.test.ts`, `test/ai-ask.test.ts`, `test/figure-content.test.ts`, `test/ai-alttext.test.ts` (create) | tests |
| `README.md`, `CLAUDE.md`, `CHANGELOG.md` (modify) | docs |

---

### Task 1: Text pipeline (`aichunk.ts`) and the scripted model

**Files:**
- Modify: `src/aimodel.ts`
- Create: `src/aichunk.ts`, `test/helpers/scripted-model.ts`
- Test: `test/aichunk.test.ts`

**Interfaces:**
- Produces:
  ```ts
  // aimodel.ts
  export interface AiUsage { inputTokens: number; outputTokens: number }
  // aichunk.ts
  export const PROMPT_RESERVE = 2000;
  export const MIN_INPUT_CHARS = 4000;
  export const DEFAULT_INPUT_CHARS = 48_000;
  export interface PageText { page: number; text: string }
  export interface Chunk { pages: number[]; text: string }
  export interface Window { page: number; text: string }
  export function pageTexts(doc: Document, pages: number[] | string | undefined): PageText[];
  export function requireText(pages: PageText[]): PageText[];
  export function splitOversized(text: string, max: number): string[];
  export function packPages(pages: PageText[], budget: number): Chunk[];
  export function packTexts(texts: string[], budget: number): string[];
  export function windowPages(pages: PageText[], size?: number, overlap?: number): Window[];
  export function addUsage(a: AiUsage | undefined, b: AiUsage | undefined): AiUsage | undefined;
  export function intOption(name: string, v: unknown, dflt: number, min: number): number;
  export function checkModel(model: unknown): void;
  // test/helpers/scripted-model.ts
  export function scriptedModel(answer: (req: AiRequest, n: number) => string | AiResponse | Promise<string | AiResponse>): AiModel & { requests: AiRequest[] };
  ```

- [ ] **Step 1: Write the scripted model helper** — `test/helpers/scripted-model.ts`

```ts
import type { AiModel, AiRequest, AiResponse } from '../../src/aimodel.js';

/** An AiModel stub: `answer(req, n)` replies to the n-th request (1-based). A
 *  string reply becomes `{ text }`. Every request is recorded in `requests`. */
export function scriptedModel(
  answer: (req: AiRequest, n: number) => string | AiResponse | Promise<string | AiResponse>,
): AiModel & { requests: AiRequest[] } {
  const requests: AiRequest[] = [];
  return {
    requests,
    async complete(req: AiRequest): Promise<AiResponse> {
      requests.push(req);
      const r = await answer(req, requests.length);
      return typeof r === 'string' ? { text: r } : r;
    },
  };
}

/** The system prompt and the user text of a recorded request. */
export function systemOf(req: AiRequest): string {
  const m = req.messages.find((x) => x.role === 'system');
  return typeof m?.content === 'string' ? m.content : '';
}
export function userTextOf(req: AiRequest): string {
  const m = req.messages.find((x) => x.role === 'user');
  if (!m) return '';
  if (typeof m.content === 'string') return m.content;
  return m.content.filter((p) => p.type === 'text').map((p) => (p as { text: string }).text).join('\n');
}
```

- [ ] **Step 2: Write the failing tests** — `test/aichunk.test.ts`

```ts
import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { PageFormat } from '../src/pageformat.js';
import {
  splitOversized, packPages, packTexts, windowPages, addUsage, intOption,
  pageTexts, requireText, checkModel,
} from '../src/aichunk.js';

describe('splitOversized (3ywf.4)', () => {
  it('prefers a blank line, then a newline, then a space, then a hard cut', () => {
    expect(splitOversized('aa\n\nbb\ncc', 8)).toEqual(['aa', 'bb\ncc']);
    expect(splitOversized('aaaa\nbbbb', 8)).toEqual(['aaaa', 'bbbb']);
    expect(splitOversized('aaaa bbbb', 8)).toEqual(['aaaa', 'bbbb']);
    expect(splitOversized('abcdefghij', 4)).toEqual(['abcd', 'efgh', 'ij']);
  });
  it('never splits a surrogate pair', () => {
    expect(splitOversized('a\u{1F600}b', 2)).toEqual(['a', '\u{1F600}', 'b']);
  });
  it('returns text that fits unchanged, and nothing for blank text', () => {
    expect(splitOversized('short', 100)).toEqual(['short']);
    expect(splitOversized('   ', 100)).toEqual([]);
  });
});

describe('packPages (3ywf.4)', () => {
  it('labels each page and packs consecutive pages under the budget', () => {
    const one = packPages([{ page: 1, text: 'alpha' }, { page: 2, text: 'beta' }], 100);
    expect(one).toEqual([{ pages: [1, 2], text: '[page 1]\nalpha\n\n[page 2]\nbeta' }]);
    const two = packPages([{ page: 1, text: 'alpha' }, { page: 2, text: 'beta' }], 20);
    expect(two.map((c) => c.pages)).toEqual([[1], [2]]);
  });
  it('splits an oversized page and keeps every chunk within the budget', () => {
    const chunks = packPages([{ page: 3, text: 'word '.repeat(50) }], 60);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) {
      expect(c.text.length).toBeLessThanOrEqual(60);
      expect(c.text.startsWith('[page 3]\n')).toBe(true);
    }
  });
});

describe('packTexts (3ywf.4)', () => {
  it('joins consecutive texts with a blank line under the budget', () => {
    expect(packTexts(['aaa', 'bbb', 'ccc'], 8)).toEqual(['aaa\n\nbbb', 'ccc']);
  });
});

describe('windowPages (3ywf.4)', () => {
  const words = Array.from({ length: 600 }, (_, i) => `w${String(i).padStart(4, '0')}`);
  const text = words.join(' ');

  it('makes bounded, overlapping windows of whole words that cover the page', () => {
    const w = windowPages([{ page: 1, text }]);
    expect(w.length).toBeGreaterThan(2);
    for (const x of w) {
      expect(x.text.length).toBeLessThanOrEqual(1500);
      for (const tok of x.text.split(/\s+/)) expect(tok).toMatch(/^w\d{4}$/);
    }
    for (let i = 1; i < w.length; i++) {
      const first = w[i]!.text.split(' ')[0]!;
      expect(w[i - 1]!.text.split(' ')).toContain(first);
    }
    const seen = new Set(w.flatMap((x) => x.text.split(' ')));
    for (const word of words) expect(seen.has(word)).toBe(true);
  });

  it('never lets a window span two pages', () => {
    const w = windowPages([{ page: 1, text: 'one '.repeat(10) }, { page: 2, text: 'two '.repeat(10) }]);
    for (const x of w) expect(x.text.includes('one') && x.text.includes('two')).toBe(false);
    expect(w.find((x) => x.text.includes('two'))!.page).toBe(2);
  });
});

describe('helpers (3ywf.4)', () => {
  it('addUsage sums, and stays absent only when both are', () => {
    expect(addUsage(undefined, undefined)).toBeUndefined();
    expect(addUsage({ inputTokens: 1, outputTokens: 2 }, undefined)).toEqual({ inputTokens: 1, outputTokens: 2 });
    expect(addUsage({ inputTokens: 1, outputTokens: 2 }, { inputTokens: 3, outputTokens: 4 }))
      .toEqual({ inputTokens: 4, outputTokens: 6 });
  });
  it('intOption defaults, and refuses the wrong kind and the out of range', () => {
    expect(intOption('n', undefined, 7, 1)).toBe(7);
    expect(intOption('n', 9, 7, 1)).toBe(9);
    expect(() => intOption('n', '9', 7, 1)).toThrow(TypeError);
    expect(() => intOption('n', 1.5, 7, 1)).toThrow(RangeError);
    expect(() => intOption('n', 0, 7, 1)).toThrow(RangeError);
  });
  it('checkModel refuses anything without complete()', () => {
    expect(() => checkModel({})).toThrow(TypeError);
    expect(() => checkModel(null)).toThrow(TypeError);
    expect(() => checkModel({ complete: async () => ({ text: '' }) })).not.toThrow();
  });
  it('pageTexts drops pages with no text, and requireText refuses an empty set', () => {
    const doc = Document.New(PageFormat.custom(300, 300));
    doc.AddPage(PageFormat.custom(300, 300)).page.AddText('Hello', 20, 150);
    const t = pageTexts(doc, undefined);
    expect(t.map((p) => p.page)).toEqual([2]);
    expect(t[0]!.text).toContain('Hello');
    expect(() => requireText(pageTexts(doc, [1]))).toThrow(/no extractable text/);
  });
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `npx vitest run test/aichunk.test.ts`
Expected: FAIL — cannot resolve `../src/aichunk.js`.

- [ ] **Step 4: Add `AiUsage` to `src/aimodel.ts`** — append after the `AiModel` interface:

```ts
/** Token counts summed across the requests one feature made. */
export interface AiUsage { inputTokens: number; outputTokens: number }
```

- [ ] **Step 5: Create `src/aichunk.ts`**

```ts
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
 *  so Summarize and Ask cannot disagree about where an oversized page breaks. */
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
      cut = max;
      if (isHigh(rest.charCodeAt(cut - 1)) && cut > 1) cut--;
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
      }
      const text = t.slice(start, end).trim();
      if (text) out.push({ page: p.page, text });
      if (end >= t.length) break;
      let next = Math.max(start + 1, end - overlap);
      const ws = t.slice(next, end).search(/\s/);
      if (ws >= 0) next += ws + 1;
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
```

- [ ] **Step 6: Run the tests**

Run: `npx vitest run test/aichunk.test.ts`
Expected: PASS (12 tests). If a `windowPages` overlap assertion fails, the fault is in the window cut, not the test: the first word of each window must lie inside the previous one because `next` starts `overlap` characters before `end`.

- [ ] **Step 7: Typecheck and commit**

Run: `npm run typecheck` — no errors.
```bash
git add src/aimodel.ts src/aichunk.ts test/aichunk.test.ts test/helpers/scripted-model.ts
git commit -m "feat(3ywf.4): the text pipeline shared by Summarize and Ask"
```

---

### Task 2: BM25 ranking (`bm25.ts`)

**Files:**
- Create: `src/bm25.ts`
- Test: `test/bm25.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export function tokenize(s: string): string[];
  export function rankBm25(docs: string[], query: string, k1?: number, b?: number): { index: number; score: number }[];
  ```

- [ ] **Step 1: Write the failing tests** — `test/bm25.test.ts`

```ts
import { describe, it, expect } from 'vitest';
import { tokenize, rankBm25 } from '../src/bm25.js';

describe('tokenize (3ywf.4)', () => {
  it('lowercases and keeps word-like segments only', () => {
    expect(tokenize('Hello, World! 42')).toEqual(['hello', 'world', '42']);
  });
  it('segments Cyrillic and CJK with no dictionary of ours', () => {
    expect(tokenize('Привет, мир')).toEqual(['привет', 'мир']);
    const ja = tokenize('東京に行きます');
    expect(ja.length).toBeGreaterThan(1);
    for (const t of ja) expect('東京に行きます').toContain(t);
  });
});

describe('rankBm25 (3ywf.4)', () => {
  it('ranks the document sharing the query terms first', () => {
    const r = rankBm25(['the cat sat', 'a dog barked loudly', 'cats and dogs'], 'dog barked');
    expect(r[0]!.index).toBe(1);
    expect(r[0]!.score).toBeGreaterThan(0);
  });

  it('lets a rare term outweigh repetitions of a common one (IDF)', () => {
    // alpha is in two of three documents, zeta in one. Without IDF the four
    // alphas of doc 0 win on term frequency alone; with it, zeta does.
    const docs = ['alpha alpha alpha alpha', 'zeta w w w', 'alpha w w w'];
    expect(rankBm25(docs, 'alpha zeta')[0]!.index).toBe(1);
  });

  it('scores 0 for a query sharing nothing, and breaks ties by index', () => {
    const r = rankBm25(['one', 'two', 'three'], 'nothing here');
    expect(r.map((x) => x.score)).toEqual([0, 0, 0]);
    expect(r.map((x) => x.index)).toEqual([0, 1, 2]);
  });

  it('counts a repeated query term once', () => {
    const docs = ['red apple', 'green pear'];
    expect(rankBm25(docs, 'red red red')[0]!.score).toBeCloseTo(rankBm25(docs, 'red')[0]!.score, 12);
  });

  it('handles an empty corpus', () => {
    expect(rankBm25([], 'x')).toEqual([]);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/bm25.test.ts`
Expected: FAIL — cannot resolve `../src/bm25.js`.

- [ ] **Step 3: Create `src/bm25.ts`**

```ts
/** Okapi BM25 over in-memory strings (`3ywf.4`), so `Ask` can choose which
 *  parts of a long document to send without a model call.
 *
 *  A pure leaf. Words come from `Intl.Segmenter`, which segments CJK, Thai and
 *  Cyrillic correctly with no dictionary of ours — zero dependencies.
 *
 *  **Invariant:** no stemming and no stop-word list. IDF already discounts a
 *  word every passage contains, and a per-language list is a judgement this
 *  library would then have to maintain. IDF uses the `+1` inside the log, so a
 *  term in every passage scores small but never negative. */

const SEGMENTER = new Intl.Segmenter(undefined, { granularity: 'word' });

/** Lowercased word-like segments of `s`. */
export function tokenize(s: string): string[] {
  const out: string[] = [];
  for (const seg of SEGMENTER.segment(s.toLowerCase())) if (seg.isWordLike) out.push(seg.segment);
  return out;
}

/** Every document's BM25 score against `query`, highest first, ties by index. */
export function rankBm25(docs: string[], query: string, k1 = 1.2, b = 0.75): { index: number; score: number }[] {
  const toks = docs.map(tokenize);
  const n = docs.length;
  const avg = toks.reduce((s, t) => s + t.length, 0) / Math.max(1, n) || 1;
  const df = new Map<string, number>();
  for (const t of toks) for (const w of new Set(t)) df.set(w, (df.get(w) ?? 0) + 1);
  const terms = [...new Set(tokenize(query))];
  const scored = toks.map((t, index) => {
    const tf = new Map<string, number>();
    for (const w of t) tf.set(w, (tf.get(w) ?? 0) + 1);
    let score = 0;
    for (const w of terms) {
      const f = tf.get(w);
      if (!f) continue;
      const d = df.get(w)!;
      const idf = Math.log(1 + (n - d + 0.5) / (d + 0.5));
      score += idf * (f * (k1 + 1)) / (f + k1 * (1 - b + (b * t.length) / avg));
    }
    return { index, score };
  });
  return scored.sort((x, y) => y.score - x.score || x.index - y.index);
}
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run test/bm25.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add src/bm25.ts test/bm25.test.ts
git commit -m "feat(3ywf.4): BM25 ranking over Intl.Segmenter words"
```

---

### Task 3: `Summarize`

**Files:**
- Create: `src/aisummarize.ts`
- Modify: `src/document.ts`, `src/index.ts`, `README.md`
- Test: `test/ai-summarize.test.ts`

**Interfaces:**
- Consumes: Task 1's `aichunk.ts` and `scriptedModel`, `systemOf`, `userTextOf`; `AiModel`, `AiUsage` (`src/aimodel.ts`); `AiServiceError` (`src/errors.ts`).
- Produces:
  ```ts
  export interface SummarizeOptions { pages?: number[] | string; instructions?: string; maxInputChars?: number; signal?: AbortSignal }
  export interface SummarizeResult { text: string; requests: number; usage?: AiUsage }
  export function summarize(doc: Document, model: AiModel, opts?: SummarizeOptions): Promise<SummarizeResult>;
  // Document
  Summarize(model: AiModel, opts?: SummarizeOptions): Promise<SummarizeResult>;
  ```

- [ ] **Step 1: Write the failing tests** — `test/ai-summarize.test.ts`

```ts
import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { PageFormat } from '../src/pageformat.js';
import { AiServiceError } from '../src/errors.js';
import { scriptedModel, systemOf, userTextOf } from './helpers/scripted-model.js';
import type { AiRequest } from '../src/aimodel.js';

/** `n` pages, each roughly `chars` characters of distinct words in 60-character lines. */
function docWithPages(n: number, chars: number): Document {
  const doc = Document.New(PageFormat.custom(600, 800));
  for (let p = 1; p <= n; p++) {
    const page = p === 1 ? doc.Pages[0]! : doc.AddPage(PageFormat.custom(600, 800)).page;
    const words: string[] = [];
    for (let i = 0; words.join(' ').length < chars; i++) words.push(`p${p}w${i}`);
    const lines: string[] = [];
    let line = '';
    for (const w of words) {
      if (line.length + w.length + 1 > 60) { lines.push(line); line = ''; }
      line = line ? `${line} ${w}` : w;
    }
    if (line) lines.push(line);
    lines.forEach((l, i) => page.AddText(l, 20, 780 - i * 10));
  }
  return doc;
}

const isMap = (r: AiRequest): boolean => systemOf(r).includes('part of a longer document');
const isReduce = (r: AiRequest): boolean => systemOf(r).includes('partial summaries');

describe('Summarize (3ywf.4)', () => {
  it('makes one request when the document fits', async () => {
    const m = scriptedModel(() => 'The summary.');
    const r = await docWithPages(2, 500).Summarize(m);
    expect(r).toEqual({ text: 'The summary.', requests: 1, usage: undefined });
    const user = userTextOf(m.requests[0]!);
    expect(user).toContain('[page 1]');
    expect(user).toContain('[page 2]');
  });

  it('maps every chunk, then reduces the partial summaries', async () => {
    const m = scriptedModel((req, n) => (isMap(req) ? `partial-${n}` : 'FINAL'));
    const r = await docWithPages(6, 3000).Summarize(m, { maxInputChars: 8000 });
    const maps = m.requests.filter(isMap);
    expect(maps.length).toBeGreaterThan(1);
    expect(r.text).toBe('FINAL');
    expect(r.requests).toBe(m.requests.length);
    const last = m.requests.at(-1)!;
    expect(isReduce(last)).toBe(true);
    for (let i = 1; i <= maps.length; i++) expect(userTextOf(last)).toContain(`partial-${i}`);
  });

  it('reduces again when the partial summaries do not fit one request', async () => {
    const m = scriptedModel((req, n) => (isMap(req) ? `p${n} ${'x'.repeat(2500)}` : `r${n}`));
    await docWithPages(6, 3000).Summarize(m, { maxInputChars: 8000 });
    expect(m.requests.filter(isReduce).length).toBeGreaterThan(1);
  });

  it('sends the instructions in the final request only', async () => {
    const m = scriptedModel((req, n) => (isMap(req) ? `partial-${n}` : 'FINAL'));
    await docWithPages(6, 3000).Summarize(m, { maxInputChars: 8000, instructions: 'in German' });
    const withInstr = m.requests.filter((r) => systemOf(r).includes('in German'));
    expect(withInstr).toEqual([m.requests.at(-1)]);
    const one = scriptedModel(() => 'S');
    await docWithPages(1, 200).Summarize(one, { instructions: 'in German' });
    expect(systemOf(one.requests[0]!)).toContain('in German');
  });

  it('sums usage across requests', async () => {
    const m = scriptedModel((req, n) => ({ text: isMap(req) ? `partial-${n}` : 'F', usage: { inputTokens: 10, outputTokens: 1 } }));
    const r = await docWithPages(6, 3000).Summarize(m, { maxInputChars: 8000 });
    expect(r.usage).toEqual({ inputTokens: 10 * r.requests, outputTokens: r.requests });
  });

  it('refuses a selection with no text before any request (Review Focus 1)', async () => {
    const m = scriptedModel(() => 'S');
    const doc = docWithPages(1, 200);
    doc.AddPage(PageFormat.custom(600, 800));
    await expect(doc.Summarize(m, { pages: [2] })).rejects.toThrow(/no extractable text/);
    await expect(Document.New(PageFormat.A4).Summarize(m)).rejects.toThrow(RangeError);
    expect(m.requests).toHaveLength(0);
  });

  it('throws AiServiceError on an empty reply', async () => {
    await expect(docWithPages(1, 200).Summarize(scriptedModel(() => '  '))).rejects.toBeInstanceOf(AiServiceError);
  });

  it('validates its options before any request', async () => {
    const m = scriptedModel(() => 'S');
    const doc = docWithPages(1, 200);
    await expect(doc.Summarize({} as never)).rejects.toThrow(TypeError);
    await expect(doc.Summarize(m, { maxInputChars: 100 })).rejects.toThrow(RangeError);
    await expect(doc.Summarize(m, { instructions: 5 as never })).rejects.toThrow(TypeError);
    expect(m.requests).toHaveLength(0);
  });

  it('honours an aborted signal', async () => {
    const m = scriptedModel(() => 'S');
    const ctrl = new AbortController();
    ctrl.abort(new Error('stop'));
    await expect(docWithPages(1, 200).Summarize(m, { signal: ctrl.signal })).rejects.toThrow('stop');
    expect(m.requests).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/ai-summarize.test.ts`
Expected: FAIL — `doc.Summarize is not a function`.

- [ ] **Step 3: Create `src/aisummarize.ts`**

```ts
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
 *  reached is then the model's error to report, never a silent truncation. */
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
    parts = next;
  }
}
```

- [ ] **Step 4: Add the `Document` method** — in `src/document.ts`, next to the `makesearchable.js` import add:

```ts
import { summarize, type SummarizeOptions, type SummarizeResult } from './aisummarize.js';
import type { AiModel } from './aimodel.js';
```
(If `AiModel` is already imported in `document.ts`, do not add it twice.) Directly after the `MakeSearchable` method add:

```ts
  /** A summary of the selected pages from `model`. A document larger than one
   *  request is summarized in parts and the parts combined. Throws on a
   *  selection with no extractable text. */
  Summarize(model: AiModel, opts?: SummarizeOptions): Promise<SummarizeResult> {
    return summarize(this, model, opts);
  }
```

- [ ] **Step 5: Exports and README rows** — in `src/index.ts`, after the `aiocr.js` export lines add:

```ts
export type { AiUsage } from './aimodel.js';
export type { SummarizeOptions, SummarizeResult } from './aisummarize.js';
```
In README's `### AI` table, after the `AiOcrOptions` row, add:

```markdown
| `AiUsage` | Token counts summed across the requests one AI feature made: `inputTokens`, `outputTokens`. |
| `SummarizeOptions` | Options for `Summarize`: `pages`, `instructions` (how the summary should read; sent in the final request only), `maxInputChars` (characters per request, default 48,000, at least 4,000), `signal`. |
| `SummarizeResult` | What `Summarize` returned: the summary `text`, the number of `requests` made, and summed `usage`. |
```
Run `npx vitest run test/readme-api.test.ts`; update the README count sentence (`… public types plus … values`, near line 2960) to the counts it reports.

- [ ] **Step 6: Run the tests**

Run: `npx vitest run test/ai-summarize.test.ts test/readme-api.test.ts test/limits-catch.test.ts test/import-cycles.test.ts` and `npm run typecheck`
Expected: PASS; no type errors.

- [ ] **Step 7: Commit**

```bash
git add src/aisummarize.ts src/document.ts src/index.ts test/ai-summarize.test.ts README.md
git commit -m "feat(3ywf.4): Document.Summarize, map-reduce over page chunks"
```

---

### Task 4: `Ask`

**Files:**
- Create: `src/aiask.ts`
- Modify: `src/document.ts`, `src/index.ts`, `README.md`
- Test: `test/ai-ask.test.ts`

**Interfaces:**
- Consumes: Task 1 (`aichunk.ts`, `scriptedModel`, `userTextOf`), Task 2 (`rankBm25`).
- Produces:
  ```ts
  export interface AskOptions { pages?: number[] | string; maxInputChars?: number; maxChunks?: number; signal?: AbortSignal }
  export interface AskExcerpt { page: number; text: string }
  export interface AskResult { answer: string; found: boolean; pages: number[]; excerpts: AskExcerpt[]; usage?: AiUsage }
  export function ask(doc: Document, model: AiModel, question: string, opts?: AskOptions): Promise<AskResult>;
  // Document
  Ask(model: AiModel, question: string, opts?: AskOptions): Promise<AskResult>;
  ```

- [ ] **Step 1: Write the failing tests** — `test/ai-ask.test.ts`

```ts
import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { PageFormat } from '../src/pageformat.js';
import { AiServiceError } from '../src/errors.js';
import { scriptedModel, userTextOf } from './helpers/scripted-model.js';
import { fakeOcr } from './helpers/fake-ocr.js';

/** One page per string, each drawn as one line. */
function docOf(...pages: string[]): Document {
  const doc = Document.New(PageFormat.custom(600, 200));
  pages.forEach((t, i) => {
    const page = i === 0 ? doc.Pages[0]! : doc.AddPage(PageFormat.custom(600, 200)).page;
    page.AddText(t, 20, 100);
  });
  return doc;
}
const reply = (o: object): string => JSON.stringify(o);
const DOC = (): Document => docOf(
  'The warranty lasts two years.',
  'Shipping takes five days.',
  'Returns: returns are accepted within thirty days.',
);

describe('Ask (3ywf.4)', () => {
  it('sends the best-ranked excerpt, labelled by page, with the answer schema', async () => {
    const m = scriptedModel(() => reply({ answer: 'Two years.', found: true, pages: [1] }));
    const r = await DOC().Ask(m, 'How long is the warranty?', { maxChunks: 1 });
    const user = userTextOf(m.requests[0]!);
    expect(user).toContain('[page 1]');
    expect(user).not.toContain('[page 2]');
    expect(user).toContain('How long is the warranty?');
    expect(m.requests[0]!.schema?.name).toBe('document_answer');
    expect(r).toMatchObject({ answer: 'Two years.', found: true, pages: [1] });
    expect(r.excerpts).toEqual([{ page: 1, text: 'The warranty lasts two years.' }]);
  });

  it('drops a cited page that was not among the excerpts sent', async () => {
    const m = scriptedModel(() => reply({ answer: 'Two years.', found: true, pages: [7, 1, 1] }));
    expect((await DOC().Ask(m, 'warranty', { maxChunks: 1 })).pages).toEqual([1]);
  });

  it('passes found: false through', async () => {
    const m = scriptedModel(() => reply({ answer: 'Not stated.', found: false, pages: [] }));
    expect(await DOC().Ask(m, 'warranty')).toMatchObject({ found: false, pages: [] });
  });

  it('returns excerpts by rank but sends them in document order', async () => {
    const m = scriptedModel(() => reply({ answer: 'x', found: true, pages: [] }));
    const r = await DOC().Ask(m, 'warranty returns');
    expect(r.excerpts.map((e) => e.page)).toEqual([3, 1]);
    const user = userTextOf(m.requests[0]!);
    expect(user.indexOf('[page 1]')).toBeLessThan(user.indexOf('[page 3]'));
  });

  it('falls back to document order when nothing shares a term with the question', async () => {
    const m = scriptedModel(() => reply({ answer: 'x', found: true, pages: [] }));
    const r = await DOC().Ask(m, 'What is this about?');
    expect(r.excerpts.map((e) => e.page)).toEqual([1, 2, 3]);
  });

  it('honours maxChunks and the character budget', async () => {
    const pages = Array.from({ length: 12 }, (_, i) => `topic ${'filler '.repeat(200)} item${i}`);
    const m = scriptedModel(() => reply({ answer: 'x', found: true, pages: [] }));
    const r = await docOf(...pages).Ask(m, 'topic', { maxChunks: 3 });
    expect(r.excerpts.length).toBe(3);
    const m2 = scriptedModel(() => reply({ answer: 'x', found: true, pages: [] }));
    const r2 = await docOf(...pages).Ask(m2, 'topic', { maxInputChars: 4000 });
    expect(r2.excerpts.reduce((s, e) => s + e.text.length, 0)).toBeLessThanOrEqual(2000);
    expect(r2.excerpts.length).toBeGreaterThan(0);
  });

  it('finds the right page in Japanese (Review Focus 4)', async () => {
    // AddText's Standard-14 faces cannot draw Japanese, so the pages get their
    // text the way a scan would: MakeSearchable's glyphless layer, any script.
    const lines = ['東京は日本の首都です。', '大阪は商業の町です。'];
    const doc = Document.New(PageFormat.custom(600, 200));
    doc.AddPage(PageFormat.custom(600, 200));
    await doc.MakeSearchable(fakeOcr((n) => [{ text: lines[n - 1]!, box: [10, 10, 500, 40] }]), { dpi: 72 });
    const m = scriptedModel(() => reply({ answer: 'x', found: true, pages: [] }));
    const r = await doc.Ask(m, '大阪', { maxChunks: 1 });
    expect(r.excerpts[0]!.page).toBe(2);
  });

  for (const [what, text] of [
    ['not JSON', 'sorry'],
    ['a non-string answer', reply({ answer: 1, found: true, pages: [] })],
    ['no found flag', reply({ answer: 'a', pages: [] })],
    ['pages as strings (Review Focus 2)', reply({ answer: 'a', found: true, pages: ['1'] })],
  ] as const) {
    it(`throws AiServiceError on ${what}`, async () => {
      await expect(DOC().Ask(scriptedModel(() => text), 'warranty')).rejects.toBeInstanceOf(AiServiceError);
    });
  }

  it('validates its arguments before any request', async () => {
    const m = scriptedModel(() => reply({ answer: 'a', found: true, pages: [] }));
    await expect(DOC().Ask(m, '   ')).rejects.toThrow(RangeError);
    await expect(DOC().Ask(m, 5 as never)).rejects.toThrow(TypeError);
    await expect(DOC().Ask(m, 'q', { maxChunks: 0 })).rejects.toThrow(RangeError);
    await expect(Document.New(PageFormat.A4).Ask(m, 'q')).rejects.toThrow(/no extractable text/);
    expect(m.requests).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/ai-ask.test.ts`
Expected: FAIL — `doc.Ask is not a function`.

- [ ] **Step 3: Create `src/aiask.ts`**

```ts
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
 *  **Note the two orders, both deliberate:** the request lists excerpts in
 *  document order, which is how a reader follows them; the result lists them in
 *  rank order, which is what a caller showing evidence wants first. */
import type { Document } from './document.js';
import type { AiModel, AiUsage } from './aimodel.js';
import { AiServiceError, rethrowLimit } from './errors.js';
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
    if (chosen.length > 0 && used + len > budget) break;
    chosen.push(i);
    used += len;
  }

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
  const pages = [...new Set(reply.pages.filter((p) => Number.isInteger(p) && sent.has(p)))].sort((a, b) => a - b);
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
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (caught) {
    rethrowLimit(caught);
    throw bad();
  }
  if (json === null || typeof json !== 'object') throw bad();
  const { answer, found, pages } = json as { answer?: unknown; found?: unknown; pages?: unknown };
  if (typeof answer !== 'string' || typeof found !== 'boolean' || !Array.isArray(pages)) throw bad();
  if (!pages.every((p) => typeof p === 'number')) throw bad();
  return { answer, found, pages: pages as number[] };
}
```

- [ ] **Step 4: Add the `Document` method** — import beside the Summarize import in `src/document.ts`:

```ts
import { ask, type AskOptions, type AskResult } from './aiask.js';
```
and after the `Summarize` method:

```ts
  /** An answer to `question` from `model`, drawn from the passages of the
   *  selected pages that best match it (ranked locally), with the pages it
   *  cites. `found` is false when those passages do not contain the answer. */
  Ask(model: AiModel, question: string, opts?: AskOptions): Promise<AskResult> {
    return ask(this, model, question, opts);
  }
```

- [ ] **Step 5: Exports and README rows** — in `src/index.ts`, after the `aisummarize.js` line:

```ts
export type { AskOptions, AskExcerpt, AskResult } from './aiask.js';
```
In README's `### AI` table, after the `SummarizeResult` row:

```markdown
| `AskOptions` | Options for `Ask`: `pages`, `maxInputChars` (default 48,000), `maxChunks` (most excerpts sent, default 8), `signal`. |
| `AskExcerpt` | One passage `Ask` sent to the model: its `page` and `text`. |
| `AskResult` | What `Ask` returned: the `answer`, `found` (false when the passages did not contain it), the cited `pages` (each among those sent), the `excerpts` sent (most relevant first) and `usage`. |
```
Run `npx vitest run test/readme-api.test.ts` and update the count sentence to what it reports.

- [ ] **Step 6: Run the tests**

Run: `npx vitest run test/ai-ask.test.ts test/readme-api.test.ts test/limits-catch.test.ts test/import-cycles.test.ts` and `npm run typecheck`
Expected: PASS (12 tests in `ai-ask`); no type errors. If the rank-order case returns `[1, 3]`, check the BM25 term frequency: page 3 holds `returns` twice and page 1 `warranty` once, at equal IDF, so page 3 must score higher.

- [ ] **Step 7: Commit**

```bash
git add src/aiask.ts src/document.ts src/index.ts test/ai-ask.test.ts README.md
git commit -m "feat(3ywf.4): Document.Ask, BM25-ranked excerpts with page citations"
```

---

### Task 5: Figure content and region rendering

**Files:**
- Create: `src/figurecontent.ts`
- Modify: `src/docmodel.ts`, `src/raster.ts`
- Test: `test/figure-content.test.ts`

**Interfaces:**
- Produces:
  ```ts
  // figurecontent.ts
  export interface PlacedImage { stream: PdfStream; width: number; height: number }
  export class FigureContent {
    constructor(doc: Document, only?: Page);
    imagesOf(el: StructElement): PlacedImage[];
    bboxOf(el: StructElement, page: Page): Rect | undefined;
  }
  export function figurePage(el: StructElement): Page | undefined;
  // raster.ts
  export function renderPageRegionToPng(doc: Document, page: Page, region: Rect, scale: number): Uint8Array | undefined;
  ```

- [ ] **Step 1: Write the failing tests** — `test/figure-content.test.ts`

```ts
import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { PageFormat } from '../src/pageformat.js';
import { FigureContent, figurePage } from '../src/figurecontent.js';
import { renderPageRegionToPng } from '../src/raster.js';
import { buildPngRgb } from './helpers/build-embed-images.js';

const ihdr = (png: Uint8Array): [number, number] => {
  const v = new DataView(png.buffer, png.byteOffset, png.byteLength);
  return [v.getUint32(16), v.getUint32(20)];
};

function taggedImageDoc(): { doc: Document; fig: ReturnType<Document['CreateStructTree']>['Children'][number] } {
  const doc = Document.New(PageFormat.custom(400, 400));
  const root = doc.CreateStructTree();
  const fig = root.Append('Figure');
  doc.Pages[0]!.AddImage(buildPngRgb(), [20, 20, 200, 100], { tag: fig });
  return { doc, fig };
}

describe('FigureContent (3ywf.4)', () => {
  it('finds the image a tagged figure draws, and its extent', () => {
    const { doc, fig } = taggedImageDoc();
    const fc = new FigureContent(doc);
    const imgs = fc.imagesOf(fig);
    expect(imgs).toHaveLength(1);
    expect(imgs[0]!.width).toBeCloseTo(200, 3);
    const box = fc.bboxOf(fig, doc.Pages[0]!)!;
    expect(box[0]).toBeCloseTo(20, 3); expect(box[1]).toBeCloseTo(20, 3);
    expect(box[2]).toBeCloseTo(220, 3); expect(box[3]).toBeCloseTo(120, 3);
    expect(figurePage(fig)).toBe(doc.Pages[0]);
  });

  it('gives a vector figure no image but an extent inside its drawing', () => {
    const doc = Document.New(PageFormat.custom(400, 400));
    const fig = doc.CreateStructTree().Append('Figure');
    doc.Pages[0]!.AddBarcode({ type: 'code128', data: 'ABC-123' }, [50, 100, 200, 60], { tag: fig });
    const fc = new FigureContent(doc);
    expect(fc.imagesOf(fig)).toEqual([]);
    const box = fc.bboxOf(fig, doc.Pages[0]!)!;
    expect(box[0]).toBeGreaterThanOrEqual(50 - 1e-6); expect(box[2]).toBeLessThanOrEqual(250 + 1e-6);
    expect(box[1]).toBeGreaterThanOrEqual(100 - 1e-6); expect(box[3]).toBeLessThanOrEqual(160 + 1e-6);
  });

  it('has no extent for a figure that marks nothing', () => {
    const doc = Document.New(PageFormat.custom(400, 400));
    const fig = doc.CreateStructTree().Append('Figure');
    expect(new FigureContent(doc).bboxOf(fig, doc.Pages[0]!)).toBeUndefined();
  });
});

describe('renderPageRegionToPng (3ywf.4)', () => {
  it('crops to the region at the given scale', () => {
    const { doc } = taggedImageDoc();
    expect(ihdr(renderPageRegionToPng(doc, doc.Pages[0]!, [20, 20, 220, 120], 2)!)).toEqual([400, 200]);
  });
  it('clamps to the page and refuses an empty region', () => {
    const { doc } = taggedImageDoc();
    expect(ihdr(renderPageRegionToPng(doc, doc.Pages[0]!, [-50, -50, 100, 100], 1)!)).toEqual([100, 100]);
    expect(renderPageRegionToPng(doc, doc.Pages[0]!, [500, 500, 600, 600], 1)).toBeUndefined();
  });
  it('maps the region through /Rotate (Review Focus 3)', () => {
    const doc = Document.New(PageFormat.custom(200, 100));
    doc.Pages[0]!.Rotate = 90;
    // 50 wide and 100 tall on the page is 100 wide and 50 tall once turned.
    expect(ihdr(renderPageRegionToPng(doc, doc.Pages[0]!, [0, 0, 50, 100], 1)!)).toEqual([100, 50]);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/figure-content.test.ts`
Expected: FAIL — cannot resolve `../src/figurecontent.js`.

- [ ] **Step 3: Record the fence before touching `docmodel.ts`**

Run: `npx vitest run test/html-identity.test.ts test/markdown-export.test.ts test/docx-flow-identity.test.ts test/docmodel-figure-size.test.ts test/epub-export.test.ts`
Expected: PASS. (If `test/epub-export.test.ts` does not exist, run `npx vitest run test/epub` instead.) These must stay green, unedited, after Step 5.

- [ ] **Step 4: Create `src/figurecontent.ts`**

```ts
/** What a structure element's marked content draws (`3ywf.4`): its image
 *  XObjects, and the page-space extent of everything it paints.
 *
 *  Extracted from `docmodel.ts`, whose HTML/Markdown/DOCX/EPUB exports and
 *  `aialttext.ts` both need "which images does this /Figure show" — one owner,
 *  so an export and alt-text generation cannot disagree about a figure.
 *
 *  **Invariant:** both maps are memoized per page and built LAZILY, each in one
 *  content walk — a page with N figures is walked once per map, not N times.
 *  The image map and the extent map are separate because the exports need only
 *  the first, and the extent walk subscribes to glyphs and paths as well.
 *
 *  **Invariant:** keyed by MCID, never by page position or resource order;
 *  `page.Images` is `/Resources` order and says nothing about which figure
 *  draws what. Inline images are absent: they live in no object.
 *
 *  **Invariant:** the walk recurses into child elements — a Figure's content is
 *  normally its own MCIDs, but nothing forbids nesting it deeper. */
import type { Document } from './document.js';
import type { Page } from './page.js';
import type { StructElement } from './struct.js';
import type { PdfStream } from './types.js';
import { visitContent, type Rect } from './text.js';

export interface PlacedImage { stream: PdfStream; width: number; height: number }

const SHOWN = { skipHidden: true } as const;

/** The page an element's first content item sits on, else its own `/Pg`. */
export function figurePage(el: StructElement): Page | undefined {
  for (const item of el.ContentItems) if (item.page) return item.page;
  for (const child of el.Children) {
    const p = figurePage(child);
    if (p) return p;
  }
  return el.Page;
}

export class FigureContent {
  private readonly images = new Map<Page, Map<number, PlacedImage[]>>();
  private readonly extents = new Map<Page, Map<number, Rect>>();

  /** `only`: ignore content on any other page (a page-filtered export). */
  constructor(private readonly doc: Document, private readonly only?: Page) {}

  /** Every image this element's marked content draws, in content order. */
  imagesOf(el: StructElement): PlacedImage[] {
    const out: PlacedImage[] = [];
    this.collectImages(el, out);
    return out;
  }

  /** The page-space union of every glyph, image and path this element's marked
   *  content paints on `page`, or undefined when it paints nothing there. */
  bboxOf(el: StructElement, page: Page): Rect | undefined {
    let box: Rect | undefined;
    this.collectExtent(el, page, (r) => {
      box = box ? [Math.min(box[0], r[0]), Math.min(box[1], r[1]), Math.max(box[2], r[2]), Math.max(box[3], r[3])] : [...r];
    });
    return box;
  }

  private collectImages(el: StructElement, out: PlacedImage[]): void {
    for (const item of el.ContentItems) {
      if (item.kind !== 'mcid' || !item.page) continue;
      if (this.only && item.page !== this.only) continue; // another page's half of a split figure
      for (const s of this.pageImages(item.page).get(item.mcid) ?? []) out.push(s);
    }
    for (const child of el.Children) this.collectImages(child, out);
  }

  private collectExtent(el: StructElement, page: Page, add: (r: Rect) => void): void {
    for (const item of el.ContentItems) {
      if (item.kind !== 'mcid' || item.page !== page) continue;
      const r = this.pageExtents(page).get(item.mcid);
      if (r) add(r);
    }
    for (const child of el.Children) this.collectExtent(child, page, add);
  }

  private pageImages(page: Page): Map<number, PlacedImage[]> {
    let map = this.images.get(page);
    if (map) return map;
    const m = new Map<number, PlacedImage[]>();
    visitContent(this.doc, page, {
      image: (e) => {
        if (e.mcid === undefined || !e.stream) return;
        const placed: PlacedImage = {
          stream: e.stream, width: Math.abs(e.quad[2] - e.quad[0]), height: Math.abs(e.quad[3] - e.quad[1]),
        };
        const list = m.get(e.mcid);
        if (list) list.push(placed); else m.set(e.mcid, [placed]);
      },
    }, SHOWN);
    this.images.set(page, m);
    map = m;
    return map;
  }

  private pageExtents(page: Page): Map<number, Rect> {
    let map = this.extents.get(page);
    if (map) return map;
    const m = new Map<number, Rect>();
    const grow = (mcid: number | undefined, x0: number, y0: number, x1: number, y1: number): void => {
      if (mcid === undefined) return;
      const lo: Rect = [Math.min(x0, x1), Math.min(y0, y1), Math.max(x0, x1), Math.max(y0, y1)];
      const cur = m.get(mcid);
      m.set(mcid, cur
        ? [Math.min(cur[0], lo[0]), Math.min(cur[1], lo[1]), Math.max(cur[2], lo[2]), Math.max(cur[3], lo[3])]
        : lo);
    };
    visitContent(this.doc, page, {
      glyph: (e) => grow(e.mcid, e.quad[0], e.quad[1], e.quad[2], e.quad[3]),
      image: (e) => grow(e.mcid, e.quad[0], e.quad[1], e.quad[2], e.quad[3]),
      path: (e) => { for (const s of e.segments) grow(e.mcid, s[0], s[1], s[2], s[3]); },
    }, SHOWN);
    this.extents.set(page, m);
    map = m;
    return map;
  }
}
```

(If `GlyphEvent` names its MCID field differently from `mcid`, use that field — check `src/text.ts`'s `GlyphEvent` interface; `ImageEvent` and `PathEvent` both carry `mcid`.)

- [ ] **Step 5: Point `docmodel.ts` at it** — in `src/docmodel.ts`:

1. Delete `interface PlacedImage …` (around line 93) and import it instead: `import { FigureContent, type PlacedImage } from './figurecontent.js';`
2. Replace the `Ctx` field `images: Map<Page, Map<number, PlacedImage[]>>;` with `figures: FigureContent;`.
3. Delete the functions `pageMcidImages` and `figureStreams` (around lines 201–233).
4. In `elementNode`'s `Figure` branch, replace `const placed: PlacedImage[] = []; figureStreams(ctx, el, placed);` with `const placed = ctx.figures.imagesOf(el);`.
5. Where the `Ctx` object is built (`grep -n "images: new Map" src/docmodel.ts`), replace `images: new Map()` with `figures: new FigureContent(doc, only)` — using that site's own document and page-filter variables.
6. If `placedSize` is now used only by the untagged path, keep it; if it is unused, delete it. `SHOWN` stays if the untagged walk still uses it (line ~690).

- [ ] **Step 6: Add `renderPageRegionToPng` to `src/raster.ts`** — after `renderPageGraphicsToPng`:

```ts
/** Render `page` at `scale` and crop to the page-space `region`, as an RGB PNG.
 *  Undefined when the region lies off the page.
 *
 *  For `aialttext.ts`, which describes a figure that draws no image (a vector
 *  chart) by showing the model the part of the page it occupies. The region is
 *  mapped through the SAME device matrix the canvas was drawn with, so `/Rotate`
 *  and an offset CropBox need no special case. */
export function renderPageRegionToPng(doc: Document, page: Page, region: Rect, scale: number): Uint8Array | undefined {
  const canvas = renderCanvas(doc, page, { scale }, { skipGlyphs: false });
  const device = mul(baseMatrix(page, 'crop').matrix, [scale, 0, 0, scale, 0, 0]);
  const pts = [
    apply(device, region[0], region[1]), apply(device, region[2], region[1]),
    apply(device, region[0], region[3]), apply(device, region[2], region[3]),
  ];
  const x0 = Math.max(0, Math.floor(Math.min(...pts.map((p) => p[0]))));
  const y0 = Math.max(0, Math.floor(Math.min(...pts.map((p) => p[1]))));
  const x1 = Math.min(canvas.w, Math.ceil(Math.max(...pts.map((p) => p[0]))));
  const y1 = Math.min(canvas.h, Math.ceil(Math.max(...pts.map((p) => p[1]))));
  if (x1 <= x0 || y1 <= y0) return undefined;
  const rgb = canvas.toRgb();
  const w = x1 - x0, h = y1 - y0;
  const out = new Uint8Array(w * h * 3);
  for (let y = 0; y < h; y++) out.set(rgb.subarray(((y0 + y) * canvas.w + x0) * 3, ((y0 + y) * canvas.w + x1) * 3), y * w * 3);
  return encodePng(w, h, out, 'rgb');
}
```
Add `type Rect` to raster.ts's existing `./text.js` import if absent (`import { Matrix, mul, apply, translate, invert, type Rect } from './text.js';`).

- [ ] **Step 7: Run the tests and the fence**

Run: `npx vitest run test/figure-content.test.ts test/html-identity.test.ts test/markdown-export.test.ts test/docx-flow-identity.test.ts test/docmodel-figure-size.test.ts test/epub` and `npm run typecheck`
Expected: all PASS, the fence files unedited. A red fence means the extraction changed behaviour — compare against `git show HEAD:src/docmodel.ts`, never edit the fence.

- [ ] **Step 8: Commit**

```bash
git add src/figurecontent.ts src/docmodel.ts src/raster.ts test/figure-content.test.ts
git commit -m "refactor(3ywf.4): FigureContent shared by the exports, plus a region render"
```

---

### Task 6: `GenerateAltText`

**Files:**
- Create: `src/aialttext.ts`
- Modify: `src/document.ts`, `src/index.ts`, `README.md`
- Test: `test/ai-alttext.test.ts`

**Interfaces:**
- Consumes: `FigureContent`, `figurePage` (Task 5); `renderPageRegionToPng` (Task 5); `addUsage`, `checkModel` (Task 1); `encodeImage`, `imageKey` (`src/imagehref.ts`); `hasSignatureField` (`src/signature.ts`); `resolvePages` (`src/pagerange.ts`); `visitContent` (`src/text.ts`); `doc.AutoTag`.
- Produces:
  ```ts
  export interface AltTextOptions { pages?: number[] | string; overwrite?: boolean; language?: string; autoTag?: boolean; signal?: AbortSignal; onFigure?: (r: AltTextFigure) => void }
  export interface AltTextFigure { page: number; status: 'described' | 'decorative' | 'skipped' | 'failed'; alt?: string; reason?: string }
  export interface AltTextReport { figures: AltTextFigure[]; requests: number; usage?: AiUsage }
  export function generateAltText(doc: Document, model: AiModel, opts?: AltTextOptions): Promise<AltTextReport>;
  // Document
  GenerateAltText(model: AiModel, opts?: AltTextOptions): Promise<AltTextReport>;
  ```

- [ ] **Step 1: Write the failing tests** — `test/ai-alttext.test.ts`

```ts
import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { PageFormat } from '../src/pageformat.js';
import type { StructElement } from '../src/struct.js';
import { UnsupportedFeatureError } from '../src/errors.js';
import { scriptedModel, userTextOf } from './helpers/scripted-model.js';
import { buildPng, buildPngRgb } from './helpers/build-embed-images.js';
import { buildTaggedPdf } from './helpers/build-tagged-pdf.js';
import type { AiRequest } from '../src/aimodel.js';

const RED = buildPngRgb();
const BLUE = buildPng(2, 1, 2, [0, 0, 255, 0, 0, 255]);
const alt = (s: string): string => JSON.stringify({ alt: s, decorative: false });
const imagesSent = (r: AiRequest): { bytes: Uint8Array; mediaType: string }[] => {
  const user = r.messages.find((m) => m.role === 'user')!;
  return Array.isArray(user.content)
    ? user.content.filter((p) => p.type === 'image') as { bytes: Uint8Array; mediaType: string }[]
    : [];
};

function figures(doc: Document): StructElement[] {
  const out: StructElement[] = [];
  const walk = (els: StructElement[]): void => {
    for (const e of els) { if (e.StandardType === 'Figure') out.push(e); else walk(e.Children); }
  };
  walk(doc.GetStructTree()!.Children);
  return out;
}

/** A tagged page per entry; each image is drawn into its own /Figure. */
function taggedDoc(...pages: Uint8Array[][]): Document {
  const doc = Document.New(PageFormat.custom(400, 400));
  const root = doc.CreateStructTree();
  pages.forEach((imgs, p) => {
    const page = p === 0 ? doc.Pages[0]! : doc.AddPage(PageFormat.custom(400, 400)).page;
    imgs.forEach((png, i) => page.AddImage(png, [20 + i * 150, 20, 100, 100], { tag: root.Append('Figure') }));
  });
  return doc;
}

describe('GenerateAltText, tagged (3ywf.4)', () => {
  it('fills a missing /Alt, clears IllustrationAlt, and survives Save/Open', async () => {
    const doc = taggedDoc([RED]);
    expect(doc.ValidatePdfUa(1).Issues.some((i) => i.rule === 'IllustrationAlt')).toBe(true);
    const r = await doc.GenerateAltText(scriptedModel(() => alt('A red square.')));
    expect(r.figures).toEqual([{ page: 1, status: 'described', alt: 'A red square.' }]);
    expect(doc.ValidatePdfUa(1).Issues.some((i) => i.rule === 'IllustrationAlt')).toBe(false);
    expect(figures(Document.Open(doc.Save()))[0]!.Alt).toBe('A red square.');
  });

  it('keeps an author\'s /Alt unless overwrite', async () => {
    const doc = taggedDoc([RED]);
    figures(doc)[0]!.Alt = 'Author text';
    const m = scriptedModel(() => alt('Model text'));
    expect((await doc.GenerateAltText(m)).figures).toEqual([]);
    expect(m.requests).toHaveLength(0);
    await doc.GenerateAltText(m, { overwrite: true });
    expect(figures(doc)[0]!.Alt).toBe('Model text');
  });

  it('describes one picture once however many figures show it', async () => {
    const doc = taggedDoc([RED, RED], [RED]);
    const m = scriptedModel(() => alt('A red square.'));
    const r = await doc.GenerateAltText(m);
    expect(m.requests).toHaveLength(1);
    expect(r.requests).toBe(1);
    expect(figures(doc).map((f) => f.Alt)).toEqual(['A red square.', 'A red square.', 'A red square.']);
  });

  it('makes one request per distinct picture', async () => {
    const m = scriptedModel((_, n) => alt(`Picture ${n}.`));
    await taggedDoc([RED, BLUE]).GenerateAltText(m);
    expect(m.requests).toHaveLength(2);
  });

  it('sends a cropped render for a figure that draws no image', async () => {
    const doc = Document.New(PageFormat.A4);
    const fig = doc.CreateStructTree().Append('Figure');
    doc.Pages[0]!.AddBarcode({ type: 'code128', data: 'ABC-123' }, [50, 300, 200, 60], { tag: fig });
    const m = scriptedModel(() => alt('A barcode.'));
    await doc.GenerateAltText(m);
    const sent = imagesSent(m.requests[0]!);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.mediaType).toBe('image/png');
    const v = new DataView(sent[0]!.bytes.buffer, sent[0]!.bytes.byteOffset);
    expect(v.getUint32(16)).toBeLessThan(600); // cropped: the full A4 page at scale 2 is 1190 wide
    expect(fig.Alt).toBe('A barcode.');
  });

  it('skips a figure with no image and no extent', async () => {
    const doc = Document.Open(buildTaggedPdf());
    const m = scriptedModel(() => alt('x'));
    const r = await doc.GenerateAltText(m, { overwrite: true });
    expect(r.figures).toEqual([{ page: 1, status: 'skipped', reason: 'no image and no bounding box' }]);
    expect(m.requests).toHaveLength(0);
  });

  it('reports a decorative picture and leaves its figure alone', async () => {
    const doc = taggedDoc([RED]);
    const r = await doc.GenerateAltText(scriptedModel(() => JSON.stringify({ alt: '', decorative: true })));
    expect(r.figures).toEqual([{ page: 1, status: 'decorative' }]);
    expect(figures(doc)[0]!.Alt).toBeUndefined();
  });

  it('records a failure and carries on', async () => {
    const r = await taggedDoc([RED, BLUE]).GenerateAltText(scriptedModel((_, n) => (n === 1 ? 'garbage' : alt('Blue.'))));
    expect(r.figures.map((f) => f.status)).toEqual(['failed', 'described']);
    expect(r.figures[0]!.reason).toMatch(/shape/);
  });

  it('sends the page text as context and asks in the document language', async () => {
    const doc = taggedDoc([RED]);
    doc.Pages[0]!.AddText('Figure 1: quarterly revenue', 20, 300);
    doc.Lang = 'de-DE';
    const m = scriptedModel(() => alt('x'));
    await doc.GenerateAltText(m);
    expect(userTextOf(m.requests[0]!)).toContain('quarterly revenue');
    expect(userTextOf(m.requests[0]!)).toContain('de-DE');
    const m2 = scriptedModel(() => alt('x'));
    await doc.GenerateAltText(m2, { overwrite: true, language: 'French' });
    expect(userTextOf(m2.requests[0]!)).toContain('French');
  });

  it('describes only the selected pages', async () => {
    const doc = taggedDoc([RED], [BLUE]);
    const r = await doc.GenerateAltText(scriptedModel(() => alt('x')), { pages: [2] });
    expect(r.figures.map((f) => f.page)).toEqual([2]);
    expect(figures(doc)[0]!.Alt).toBeUndefined();
  });

  it('makes no request on a second run (Review Focus 5)', async () => {
    const doc = taggedDoc([RED, BLUE]);
    await doc.GenerateAltText(scriptedModel(() => alt('x')));
    const m = scriptedModel(() => alt('y'));
    expect((await doc.GenerateAltText(m)).figures).toEqual([]);
    expect(m.requests).toHaveLength(0);
  });

  it('stops on abort, keeping what it finished', async () => {
    const ctrl = new AbortController();
    const seen: string[] = [];
    const doc = taggedDoc([RED, BLUE]);
    const m = scriptedModel((_, n) => { if (n === 1) ctrl.abort(new Error('stop')); return alt('Red.'); });
    await expect(doc.GenerateAltText(m, { signal: ctrl.signal, onFigure: (f) => seen.push(f.status) })).rejects.toThrow('stop');
    expect(seen).toEqual(['described']);
    expect(figures(doc)[0]!.Alt).toBe('Red.');
  });
});

describe('GenerateAltText, untagged (3ywf.4)', () => {
  function untagged(...imgs: Uint8Array[]): Document {
    const doc = Document.New(PageFormat.custom(400, 400));
    doc.Pages[0]!.AddText('Body text', 20, 300);
    imgs.forEach((png, i) => doc.Pages[0]!.AddImage(png, [20 + i * 150, 20, 100, 100]));
    return doc;
  }

  it('describes each picture and then auto-tags the document', async () => {
    const doc = untagged(RED);
    const r = await doc.GenerateAltText(scriptedModel(() => alt('A red square.')));
    expect(r.figures).toEqual([{ page: 1, status: 'described', alt: 'A red square.' }]);
    expect(figures(doc).map((f) => f.Alt)).toEqual(['A red square.']);
  });

  it('describes a picture drawn on two pages once, and tags both (Review Focus 5)', async () => {
    const doc = untagged(RED);
    doc.AddPage(PageFormat.custom(400, 400)).page.AddImage(RED, [20, 20, 100, 100]);
    const m = scriptedModel(() => alt('A red square.'));
    await doc.GenerateAltText(m);
    expect(m.requests).toHaveLength(1);
    expect(figures(doc).map((f) => f.Alt)).toEqual(['A red square.', 'A red square.']);
  });

  it('artifacts a decorative picture', async () => {
    const doc = untagged(RED);
    const r = await doc.GenerateAltText(scriptedModel(() => JSON.stringify({ alt: '', decorative: true })));
    expect(r.figures[0]!.status).toBe('decorative');
    expect(figures(doc)).toEqual([]);
    expect(doc.GetStructTree()).not.toBeNull();
  });

  it('refuses with autoTag false, and refuses a page selection', async () => {
    const m = scriptedModel(() => alt('x'));
    await expect(untagged(RED).GenerateAltText(m, { autoTag: false })).rejects.toBeInstanceOf(UnsupportedFeatureError);
    await expect(untagged(RED).GenerateAltText(m, { pages: [1] })).rejects.toThrow(RangeError);
    expect(m.requests).toHaveLength(0);
  });
});

describe('GenerateAltText, refusals (3ywf.4)', () => {
  it('refuses a document with signature fields', async () => {
    const doc = taggedDoc([RED]);
    doc.Form.AddSignatureField({ page: 1, rect: [300, 300, 380, 340], name: 'S' });
    await expect(doc.GenerateAltText(scriptedModel(() => alt('x')))).rejects.toBeInstanceOf(UnsupportedFeatureError);
  });
  it('validates its options before any request', async () => {
    const m = scriptedModel(() => alt('x'));
    const doc = taggedDoc([RED]);
    await expect(doc.GenerateAltText({} as never)).rejects.toThrow(TypeError);
    await expect(doc.GenerateAltText(m, { overwrite: 'yes' as never })).rejects.toThrow(TypeError);
    await expect(doc.GenerateAltText(m, { language: 5 as never })).rejects.toThrow(TypeError);
    await expect(doc.GenerateAltText(m, { onFigure: 5 as never })).rejects.toThrow(TypeError);
    expect(m.requests).toHaveLength(0);
  });
});
```

(`buildPng` must be exported from `test/helpers/build-embed-images.ts`; if it is not, add `export` to its declaration.)

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/ai-alttext.test.ts`
Expected: FAIL — `doc.GenerateAltText is not a function`.

- [ ] **Step 3: Create `src/aialttext.ts`**

```ts
/** `doc.GenerateAltText` (`3ywf.4`): `/Alt` for every figure that lacks one.
 *
 *  Tagged: each `/Figure` with no `/Alt` and no `/ActualText` (the predicate
 *  PDF/UA's `IllustrationAlt` applies) is described from the images it draws —
 *  or, drawing none, from a render of the page cropped to its extent.
 *  Untagged: every picture `AutoTag` would consider is described, then
 *  `AutoTag` runs with those descriptions, so each becomes a `/Figure` + `/Alt`.
 *
 *  **Invariant:** identical pictures, by `imageKey` on the ENCODED bytes, cost
 *  one request — never keyed by stream identity, since one logo imported twice
 *  is two objects with the same bytes.
 *
 *  **Invariant:** the untagged path describes EXACTLY the images `AutoTag`
 *  asks about — top-level draws, `addr.path.length === 0` — so no request is
 *  spent on an image inside a Form XObject that AutoTag never tags.
 *
 *  **Invariant:** a decorative verdict changes nothing in a TAGGED document —
 *  turning a `/Figure` into an artifact is the author's structural decision —
 *  while in the untagged path it is what AutoTag does with an undescribed
 *  image anyway.
 *
 *  **Invariant:** a failed figure is recorded and the run continues; an abort
 *  stops it, keeping what was written. In the untagged path an abort means
 *  AutoTag does not run at all. */
import type { Document } from './document.js';
import type { Page } from './page.js';
import type { PdfStream } from './types.js';
import type { AiContentPart, AiModel, AiUsage } from './aimodel.js';
import type { StructElement, StructTreeRoot } from './struct.js';
import { AiServiceError, UnsupportedFeatureError, rethrowLimit } from './errors.js';
import { addUsage, checkModel } from './aichunk.js';
import { FigureContent, figurePage } from './figurecontent.js';
import { encodeImage, imageKey, type EncodedImage } from './imagehref.js';
import { renderPageRegionToPng } from './raster.js';
import { hasSignatureField } from './signature.js';
import { resolvePages } from './pagerange.js';
import { visitContent } from './text.js';

export interface AltTextOptions {
  /** Pages to describe: `[1, 3]` or `"1-5,8"`. Default all. Tagged documents only. */
  pages?: number[] | string;
  /** Replace an existing `/Alt`. Default false. */
  overwrite?: boolean;
  /** Output language. Default the element's `/Lang`, else the document's. */
  language?: string;
  /** Untagged document: run `AutoTag` with the descriptions. Default true; false refuses. */
  autoTag?: boolean;
  signal?: AbortSignal;
  /** Called after each figure with its record. */
  onFigure?: (r: AltTextFigure) => void;
}
export interface AltTextFigure {
  /** 1-based. */
  page: number;
  status: 'described' | 'decorative' | 'skipped' | 'failed';
  alt?: string;
  reason?: string;
}
export interface AltTextReport { figures: AltTextFigure[]; requests: number; usage?: AiUsage }

const CONTEXT_CHARS = 2000;
const CROP_SCALE = 2;
const BLACK: [number, number, number] = [0, 0, 0];
const SYSTEM =
  'You write alternative text (PDF /Alt) for images in documents, for readers who cannot see them. ' +
  'Describe what the image conveys in one or two concise sentences; do not begin with "Image of" or "Picture of". ' +
  'If the image is purely decorative (a rule, a background, an ornament) and conveys nothing, set decorative to true ' +
  'and leave alt empty. Reply with JSON only.';
const SCHEMA = {
  type: 'object', additionalProperties: false, required: ['alt', 'decorative'],
  properties: { alt: { type: 'string' }, decorative: { type: 'boolean' } },
};

type Outcome = { kind: 'described'; alt: string } | { kind: 'decorative' } | { kind: 'failed'; reason: string };

/** One request per distinct (pictures, context language) — memoized, so a
 *  picture shown by several figures is described once. */
class Describer {
  requests = 0;
  usage: AiUsage | undefined;
  private readonly memo = new Map<string, Promise<Outcome>>();
  constructor(private readonly model: AiModel, private readonly signal: AbortSignal | undefined) {}

  describe(images: EncodedImage[], context: string, language: string | undefined): Promise<Outcome> {
    const key = `${images.map((i) => imageKey(i.bytes)).join(',')}\0${language ?? ''}`;
    let p = this.memo.get(key);
    if (!p) { p = this.ask(images, context, language); this.memo.set(key, p); }
    return p;
  }

  private async ask(images: EncodedImage[], context: string, language: string | undefined): Promise<Outcome> {
    if (this.signal?.aborted) throw this.signal.reason;
    const text = [
      context ? `Text on the same page, for context:\n${context}` : 'The page has no text.',
      language ? `Write the description in ${language}.` : '',
    ].filter(Boolean).join('\n\n');
    const content: AiContentPart[] = [
      { type: 'text', text },
      ...images.map((i): AiContentPart => ({ type: 'image', bytes: i.bytes, mediaType: i.mediaType as 'image/png' | 'image/jpeg' })),
    ];
    try {
      this.requests++;
      const r = await this.model.complete({
        messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content }],
        schema: { name: 'alt_text', schema: SCHEMA },
        signal: this.signal,
      });
      this.usage = addUsage(this.usage, r.usage);
      return parseReply(r.text);
    } catch (caught) {
      rethrowLimit(caught);
      if (this.signal?.aborted) throw this.signal.reason;
      return { kind: 'failed', reason: caught instanceof Error ? caught.message : String(caught) };
    }
  }
}

function parseReply(text: string): Outcome {
  const bad = (): AiServiceError => new AiServiceError('alt-text reply is not the requested shape');
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (caught) {
    rethrowLimit(caught);
    throw bad();
  }
  if (json === null || typeof json !== 'object') throw bad();
  const { alt, decorative } = json as { alt?: unknown; decorative?: unknown };
  if (typeof alt !== 'string' || typeof decorative !== 'boolean') throw bad();
  if (decorative) return { kind: 'decorative' };
  if (!alt.trim()) throw new AiServiceError('alt-text reply is empty');
  return { kind: 'described', alt: alt.trim() };
}

const trimmed = (s: string): string => (s.length > CONTEXT_CHARS ? s.slice(0, CONTEXT_CHARS) : s).trim();
const hasText = (s: string | undefined): boolean => s !== undefined && s.trim() !== '';

export async function generateAltText(doc: Document, model: AiModel, opts: AltTextOptions = {}): Promise<AltTextReport> {
  checkModel(model);
  if (opts === null || typeof opts !== 'object') throw new TypeError('options must be an object');
  for (const k of ['overwrite', 'autoTag'] as const)
    if (opts[k] !== undefined && typeof opts[k] !== 'boolean') throw new TypeError(`${k} must be a boolean`);
  if (opts.language !== undefined && typeof opts.language !== 'string') throw new TypeError('language must be a string');
  if (opts.onFigure !== undefined && typeof opts.onFigure !== 'function') throw new TypeError('onFigure must be a function');
  if (hasSignatureField(doc))
    throw new UnsupportedFeatureError('GenerateAltText: the document has signature fields; writing /Alt would invalidate them');

  const tree = doc.GetStructTree();
  if (tree) return tagged(doc, tree, model, opts);
  if (opts.autoTag === false)
    throw new UnsupportedFeatureError('GenerateAltText: the document is untagged; tag it first, or leave autoTag on');
  if (opts.pages !== undefined)
    throw new RangeError('GenerateAltText: pages cannot narrow an untagged run, because AutoTag tags every page');
  if (doc.IsTagged)
    throw new UnsupportedFeatureError('GenerateAltText: the document is marked tagged but has no structure tree');
  return untagged(doc, model, opts);
}

async function tagged(doc: Document, tree: StructTreeRoot, model: AiModel, opts: AltTextOptions): Promise<AltTextReport> {
  const selected = new Set(resolvePages(opts.pages, doc.Pages.length));
  const content = new FigureContent(doc);
  const describer = new Describer(model, opts.signal);
  const figures: AltTextFigure[] = [];
  const record = (r: AltTextFigure): void => { figures.push(r); opts.onFigure?.(r); };
  const pageText = new Map<Page, string>();
  const contextOf = (page: Page): string => {
    let t = pageText.get(page);
    if (t === undefined) { t = trimmed(page.GetText()); pageText.set(page, t); }
    return t;
  };

  const els: StructElement[] = [];
  const walk = (list: StructElement[]): void => {
    for (const e of list) { if (e.StandardType === 'Figure') els.push(e); else walk(e.Children); }
  };
  walk(tree.Children);

  for (const el of els) {
    const page = figurePage(el);
    if (!page) continue;
    const n = doc.Pages.indexOf(page) + 1;
    if (!selected.has(n)) continue;
    if (!opts.overwrite && (hasText(el.Alt) || hasText(el.ActualText))) continue;

    let images = content.imagesOf(el)
      .map((p) => encodeImage(doc, p.stream, BLACK))
      .filter((e): e is EncodedImage => e !== undefined);
    if (images.length === 0) {
      const box = content.bboxOf(el, page);
      const png = box ? renderPageRegionToPng(doc, page, box, CROP_SCALE) : undefined;
      if (png) images = [{ bytes: png, mediaType: 'image/png' }];
    }
    if (images.length === 0) { record({ page: n, status: 'skipped', reason: 'no image and no bounding box' }); continue; }

    const out = await describer.describe(images, contextOf(page), opts.language ?? el.EffectiveLang ?? doc.Lang);
    if (out.kind === 'described') { el.Alt = out.alt; record({ page: n, status: 'described', alt: out.alt }); }
    else if (out.kind === 'decorative') record({ page: n, status: 'decorative' });
    else record({ page: n, status: 'failed', reason: out.reason });
  }
  return { figures, requests: describer.requests, usage: describer.usage };
}

async function untagged(doc: Document, model: AiModel, opts: AltTextOptions): Promise<AltTextReport> {
  const describer = new Describer(model, opts.signal);
  const figures: AltTextFigure[] = [];
  const record = (r: AltTextFigure): void => { figures.push(r); opts.onFigure?.(r); };
  const altOf = new Map<PdfStream, string | undefined>();

  for (let n = 1; n <= doc.Pages.length; n++) {
    const page = doc.Pages[n - 1]!;
    const streams: PdfStream[] = [];
    visitContent(doc, page, {
      image: (e) => { if (e.addr.path.length === 0 && e.stream && !streams.includes(e.stream)) streams.push(e.stream); },
    });
    if (streams.length === 0) continue;
    const context = trimmed(page.GetText());
    for (const stream of streams) {
      if (altOf.has(stream)) continue;
      const enc = encodeImage(doc, stream, BLACK);
      if (!enc) {
        altOf.set(stream, undefined);
        record({ page: n, status: 'failed', reason: 'the image could not be decoded; marked as an artifact' });
        continue;
      }
      const out = await describer.describe([enc], context, opts.language ?? doc.Lang);
      if (out.kind === 'described') { altOf.set(stream, out.alt); record({ page: n, status: 'described', alt: out.alt }); }
      else if (out.kind === 'decorative') { altOf.set(stream, undefined); record({ page: n, status: 'decorative' }); }
      else { altOf.set(stream, undefined); record({ page: n, status: 'failed', reason: `${out.reason}; marked as an artifact` }); }
    }
  }
  doc.AutoTag({ alt: (img) => (img.stream ? altOf.get(img.stream) : undefined) });
  return { figures, requests: describer.requests, usage: describer.usage };
}
```

Notes for the implementer:
- `EncodedImage` must be exported from `src/imagehref.ts` (it is the return type of `encodeImage`). If it is not exported, add `export` to its declaration.
- If `encodeImage`'s `fill` parameter is typed as `Rgb` from `colorspace.ts`, `BLACK` satisfies it as a 3-tuple.
- The test "describes a picture drawn on two pages once, and tags both" depends on `AddImage` with the SAME bytes creating two XObjects: the memo in `Describer` (keyed by `imageKey`) is what makes one request — `altOf` alone is keyed by stream and would make two.

- [ ] **Step 4: Add the `Document` method** — import beside the others in `src/document.ts`:

```ts
import { generateAltText, type AltTextOptions, type AltTextReport } from './aialttext.js';
```
and after the `Ask` method:

```ts
  /** `/Alt` from `model` for every `/Figure` that lacks one. An untagged
   *  document has its pictures described and is then auto-tagged with those
   *  descriptions (`autoTag: false` refuses instead). A failing figure is
   *  reported and the run continues. Refuses a document with signature fields. */
  GenerateAltText(model: AiModel, opts?: AltTextOptions): Promise<AltTextReport> {
    return generateAltText(this, model, opts);
  }
```

- [ ] **Step 5: Exports and README rows** — in `src/index.ts`, after the `aiask.js` line:

```ts
export type { AltTextOptions, AltTextFigure, AltTextReport } from './aialttext.js';
```
In README's `### AI` table, after the `AskResult` row:

```markdown
| `AltTextOptions` | Options for `GenerateAltText`: `pages` (tagged documents only), `overwrite` (replace an existing `/Alt`), `language`, `autoTag` (untagged documents: auto-tag with the descriptions, default true), `signal`, `onFigure`. |
| `AltTextFigure` | One figure's outcome: its `page` and `status` — `described` (with the `alt` written), `decorative`, `skipped` or `failed` (with a `reason`). |
| `AltTextReport` | What `GenerateAltText` did: one `AltTextFigure` per figure considered, the number of `requests` and summed `usage`. |
```
Run `npx vitest run test/readme-api.test.ts` and update the count sentence to what it reports.

- [ ] **Step 6: Run the tests**

Run: `npx vitest run test/ai-alttext.test.ts test/readme-api.test.ts test/limits-catch.test.ts test/import-cycles.test.ts` and `npm run typecheck`
Expected: PASS; no type errors. If `import-cycles` reports a new 2-cycle (e.g. `aialttext.ts` ↔ something via `raster.ts`), stop and report it rather than editing the test.

- [ ] **Step 7: Commit**

```bash
git add src/aialttext.ts src/document.ts src/index.ts src/imagehref.ts test/ai-alttext.test.ts test/helpers/build-embed-images.ts README.md
git commit -m "feat(3ywf.4): Document.GenerateAltText, /Alt for figures and untagged pictures"
```

---

### Task 7: Docs, mutation checks, gates

**Files:**
- Modify: `README.md`, `CLAUDE.md`, `CHANGELOG.md`

- [ ] **Step 1: README example** — insert immediately before `## API Reference` (after the `### Make Scanned Pages Searchable` section):

````markdown
### Summarize, Ask and Describe Images

Three more features take any `AiModel`. `Summarize` handles a document of any length — one request when it fits, otherwise the parts are summarized and the summaries combined. `Ask` ranks the document's passages against the question locally (no extra model calls), sends the best few, and returns the answer with the pages it cites; `found` is false when those passages do not contain it. `GenerateAltText` writes `/Alt` for every figure that lacks one — in an untagged document it describes each picture and then auto-tags the document:

```ts
import { Document, openAiModel } from '@asposefoss/pdf';

const model = openAiModel('https://api.openai.com/v1', { model: 'gpt-4o', apiKey: process.env.OPENAI_API_KEY });
const doc = Document.Open(bytes);

const { text } = await doc.Summarize(model, { instructions: 'five bullet points' });
const a = await doc.Ask(model, 'What is the warranty period?');
console.log(a.found ? `${a.answer} (pages ${a.pages.join(', ')})` : 'not in the document');

const report = await doc.GenerateAltText(model);
for (const f of report.figures) console.log(f.page, f.status, f.alt ?? f.reason ?? '');
const out = doc.Save();
```

Budgets are in characters (`maxInputChars`, default 48,000 per request) because the library does not know your model's tokenizer; lower it for a small local model. `Ask` ranks by shared words, so a question phrased very differently from the text may miss the passage that answers it. Identical pictures are described once. An author's `/Alt` is kept unless `overwrite: true`, and in a tagged document a picture the model calls decorative is reported, not re-tagged.
````

- [ ] **Step 2: CHANGELOG** — first entry under `## [Unreleased]` → `### Added`:

```markdown
- **Summaries, document Q&A and image alt-text.** `doc.Summarize(model, opts?)`, `doc.Ask(model, question, opts?)` and `doc.GenerateAltText(model, opts?)` work with any `AiModel`. `Summarize` handles documents larger than one request by summarizing page-anchored chunks and combining the partial summaries, level by level; an `instructions` option shapes the final summary only, so "in German" does not translate every intermediate one. `Ask` cuts the document into overlapping passages, ranks them against the question locally with BM25 over `Intl.Segmenter` words — so CJK and Cyrillic rank correctly, with no extra model calls — and sends the best few in one request; the result carries the answer, a `found` flag that is false when the passages did not contain it rather than a guess, the cited pages (a page the model was not shown is dropped as invented), and the passages sent. `GenerateAltText` writes `/Alt` for every `/Figure` with neither `/Alt` nor `/ActualText`, so a tagged document stops failing PDF/UA's `IllustrationAlt`; it sends the figure's images, or a render cropped to its extent for a vector chart, with the page's text as context and the document's language. An untagged document has its pictures described and is then auto-tagged with those descriptions. Identical pictures are described once, an author's `/Alt` is kept unless `overwrite`, and a failing figure is reported while the run continues. Budgets are characters (default 48,000 per request), since the library does not know a model's tokenizer. (3ywf.4)
```

- [ ] **Step 3: CLAUDE.md** — in the Source list, directly after the `**ocr.ts**, **glyphless.ts**, …` entry, add:

```markdown
- **aichunk.ts**, **bm25.ts**, **aisummarize.ts**, **aiask.ts**,
  **aialttext.ts**, **figurecontent.ts** — `doc.Summarize`, `doc.Ask` and
  `doc.GenerateAltText` (`3ywf.4`). `aichunk.ts` is the text pipeline (page
  text → budgeted chunks and overlapping windows) and `bm25.ts` local ranking,
  both pure; each feature module holds the `Document`. `figurecontent.ts` is
  "which images and what extent does this structure element paint", extracted
  from `docmodel.ts`.
  **Invariant:** budgets are CHARACTERS — `AiModel` knows no tokenizer — and
  `splitOversized` is the one rule both packers cut an oversized page by.
  **Invariant:** `Summarize` sends `instructions` in the FINAL request only, and
  bounds the reduce at 6 levels; past it one oversized request goes and the
  model's refusal is the report, never a silent truncation.
  **Invariant:** `Ask` drops a cited page that was not among the excerpts SENT —
  a model cannot cite what it was not shown. It sends excerpts in document
  order and returns them in rank order, both deliberately.
  **Invariant:** `GenerateAltText` dedupes by `imageKey` on ENCODED bytes, never
  stream identity, and in an untagged document describes exactly the images
  `AutoTag` asks about (top-level draws), then runs `AutoTag` with them —
  which is also why `pages` is refused there: AutoTag tags every page and
  would artifact the rest. A decorative verdict changes nothing in a TAGGED
  document; re-tagging a `/Figure` as an artifact is the author's decision.
  **Invariant:** `figurecontent.ts` is the ONE owner of the figure → image
  mapping; the HTML/Markdown/DOCX/EPUB exports and alt-text read it.
  `test/html-identity.test.ts` and `test/docx-flow-identity.test.ts` are the
  fence that the extraction moved nothing.
```

Run the module sweep and confirm it prints nothing:
```bash
for f in src/*.ts; do b=$(basename "$f"); grep -q "[*\`]$b[*\`]" CLAUDE.md || echo "$b"; done
```

- [ ] **Step 4: Mutation checks** — apply each with a script that confirms the file actually changed, run the named test file, confirm RED, restore. Kill orphaned vitest workers if a run hangs; a timeout is a TIMEOUT, never a pass.

| File | Mutation | Must redden |
|---|---|---|
| `src/aiask.ts` | `Number.isInteger(p) && sent.has(p)` → `Number.isInteger(p)` | `ai-ask` — "drops a cited page …" |
| `src/aiask.ts` | `ranked[0]!.score > 0 ? … : windows.map((_, i) => i)` → `ranked.filter((r) => r.score > 0).map((r) => r.index)` | `ai-ask` — "falls back to document order …" |
| `src/aisummarize.ts` | `if (packed.length === 1 \|\| depth >= MAX_DEPTH)` → `if (true)` | `ai-summarize` — "reduces again …" |
| `src/aisummarize.ts` | in the map loop, `call(MAP, c.text)` → `call(final(MAP), c.text)` | `ai-summarize` — "sends the instructions in the final request only" |
| `src/bm25.ts` | `const idf = Math.log(1 + (n - d + 0.5) / (d + 0.5));` → `const idf = 1;` | `bm25` — "lets a rare term outweigh …" |
| `src/aialttext.ts` | `if (!opts.overwrite && (hasText(el.Alt) \|\| hasText(el.ActualText))) continue;` → `if (false) continue;` | `ai-alttext` — "keeps an author's /Alt unless overwrite" |
| `src/aialttext.ts` | in `Describer.describe`, `images.map((i) => imageKey(i.bytes)).join(',')` → `String(Math.random())` | `ai-alttext` — "describes one picture once …" and the two-pages case |
| `src/aialttext.ts` | `e.addr.path.length === 0 && ` → `` (removed) | none expected — record the result; if GREEN, note it in CLAUDE.md as held by AutoTag's own walk, not by this suite |

A mutation that leaves its case GREEN (other than the last, which is a measurement) means the mutation did not apply or the test does not pin the rule — stop, find out which, and fix the test.

- [ ] **Step 5: Full gates**

Run: `npm run typecheck` — no errors. Run: `npm test` — all green.

- [ ] **Step 6: Commit** (closing, merging and pushing follow the final review)

```bash
git add README.md CLAUDE.md CHANGELOG.md
git commit -m "docs(3ywf.4): Summarize, Ask and GenerateAltText in README, CHANGELOG and CLAUDE.md"
```

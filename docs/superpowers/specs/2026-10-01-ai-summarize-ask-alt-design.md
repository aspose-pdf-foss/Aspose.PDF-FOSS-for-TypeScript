# Summarize, Ask and GenerateAltText — design (`3ywf.4`)

Epic `3ywf` (AI copilots). Builds on `3ywf.2` (`AiModel`, `openAiModel`) and
the network decision `3ywf.1`: the library reaches a host only through an
object the caller constructs. `3ywf.3` (`MakeSearchable`, `aiOcrEngine`) is the
pattern followed for request shape, reply checking and reporting.

## Goal

Three features that work on real documents, long ones included:

- `doc.Summarize(model)` — a summary of a document of any length.
- `doc.Ask(model, question)` — an answer drawn from the document, with the
  pages it came from, or an honest "not found".
- `doc.GenerateAltText(model)` — `/Alt` for every figure that lacks one, so a
  tagged document stops failing PDF/UA's `IllustrationAlt`; an untagged
  document is described and then auto-tagged.

## Decisions taken in brainstorming

1. **Real use, not API parity.** Summarize and Ask handle documents larger than
   one model request; alt-text writes into the structure tree.
2. **Q&A ranks locally with BM25.** Page-anchored chunks are ranked against the
   question with no model call; the top chunks go in ONE request. Rejected:
   asking every chunk (N+1 requests per question), embeddings (widens the
   `AiModel` seam every provider adapter must implement, and not every
   OpenAI-compatible server offers them), whole-document-only (no long-document
   Q&A).
3. **Untagged alt-text: describe, then AutoTag.** Each distinct image is
   described, then the existing `AutoTag` runs with those descriptions through
   its `alt` callback. `autoTag: false` refuses instead.
4. **Three self-contained `Document` methods**, matching `MakeSearchable`.
   Rejected: a Q&A session object (saves a text extraction that is noise next
   to model latency, and silently answers from a stale document after an
   edit); free functions (splits the AI features into two conventions).

## Public API

```ts
// Document
Summarize(model: AiModel, opts?: SummarizeOptions): Promise<SummarizeResult>;
Ask(model: AiModel, question: string, opts?: AskOptions): Promise<AskResult>;
GenerateAltText(model: AiModel, opts?: AltTextOptions): Promise<AltTextReport>;

export interface AiUsage { inputTokens: number; outputTokens: number }

export interface SummarizeOptions {
  pages?: number[] | string;    // resolvePages syntax; default all
  instructions?: string;        // e.g. "three bullet points, in German"
  maxInputChars?: number;       // per request; default 48_000
  signal?: AbortSignal;
}
export interface SummarizeResult {
  text: string;
  requests: number;             // model calls made
  usage?: AiUsage;              // summed; absent when no reply reported usage
}

export interface AskOptions {
  pages?: number[] | string;
  maxInputChars?: number;       // default 48_000
  maxChunks?: number;           // default 8
  signal?: AbortSignal;
}
export interface AskExcerpt { page: number; text: string }
export interface AskResult {
  answer: string;
  found: boolean;               // false: the excerpts did not contain the answer
  pages: number[];              // cited pages, each among the excerpts sent
  excerpts: AskExcerpt[];       // what was sent, in rank order
  usage?: AiUsage;
}

export interface AltTextOptions {
  pages?: number[] | string;
  overwrite?: boolean;          // replace existing /Alt; default false
  language?: string;            // output language; default element /Lang, else doc /Lang
  autoTag?: boolean;            // untagged document: AutoTag after describing; default true
  signal?: AbortSignal;
  onFigure?: (r: AltTextFigure) => void;
}
export interface AltTextFigure {
  page: number;
  status: 'described' | 'decorative' | 'skipped' | 'failed';
  alt?: string;                 // when described
  reason?: string;              // when skipped or failed
}
export interface AltTextReport {
  figures: AltTextFigure[];
  requests: number;
  usage?: AiUsage;
}
```

`AiUsage` is exported because three results carry it; `AiResponse.usage` keeps
its inline type unchanged.

Every option is validated before any model call (`TypeError` for the wrong kind
of thing, `RangeError` outside the allowed set). `maxInputChars` must be an
integer ≥ 2,000 (the smallest budget that still holds a window plus the prompt);
`maxChunks` a positive integer; `question` a non-empty string.

## Shared text pipeline — `src/aichunk.ts` (pure)

Input is `{ page: number; text: string }[]`, one per selected page, from
`page.GetText()` — page-anchored, with hidden optional content already excluded.
Empty pages are dropped. If nothing is left the feature throws `RangeError`:
"the document has no extractable text (scanned pages? see MakeSearchable)".

- **`splitOversized(text, max)`** — splits one page's text at the last blank
  line, else the last newline, else the last space, else hard, at or below
  `max`. Shared by both packers so they agree on where a page breaks.
- **`packPages(pages, budget)`** (Summarize) — packs consecutive pages into
  chunks of at most `budget` characters, each labelled `[page N]` per page; an
  oversized page becomes several chunks.
- **`windowPages(pages, size = 1500, overlap = 200)`** (Ask) — overlapping
  windows within each page, cut by `splitOversized`'s rule; a window never
  spans two pages, so its page is exact.
- **`addUsage(a, b)`** — sums usage; absent stays absent only if both are.

Characters, not tokens: `AiModel` does not know a model's tokenizer or context
window. 48,000 characters is about 12k tokens for English and fits every
current OpenAI-compatible chat model with room for the reply; a caller with a
small local model lowers it.

## Summarize — `src/aisummarize.ts`

1. Pack pages under `maxInputChars − PROMPT_RESERVE` (reserve 2,000).
2. One chunk: one request, its reply is the summary.
3. Several: summarize each chunk ("summarize this part of a longer document"),
   then reduce — pack the partial summaries the same way and summarize them as
   one ("combine these partial summaries"); repeat while more than one chunk
   remains. Depth is bounded at 6; past it the remaining summaries are joined
   with blank lines and reduced once more as a single request regardless of
   budget, which the model may then refuse — a bound reached, reported as the
   model's error rather than a silent truncation.
4. `instructions` go into the FINAL request only (the single request, or the
   last reduce), so an "in German" instruction does not translate every partial
   summary twice.

No schema: the reply is free text. An empty reply throws `AiServiceError`.

## Ask — `src/aiask.ts`, `src/bm25.ts`

**`bm25.ts`** (pure leaf): `tokenize(s)` lowercases and segments with
`Intl.Segmenter(undefined, { granularity: 'word' })`, keeping `isWordLike`
segments — CJK and Cyrillic segment correctly with zero dependencies.
`rankBm25(docs, query, k1 = 1.2, b = 0.75)` returns indices by descending
score, ties by ascending index. Standard Okapi IDF with the `+1` inside the log
so it is never negative. No stemming and no stop-word list: IDF already
discounts common words, and a per-language list is a judgement we would have to
maintain.

**Flow:**
1. `windowPages` → windows; rank against the question.
2. Take windows in rank order until `maxChunks` or the budget
   (`maxInputChars − PROMPT_RESERVE`) is reached; at least one is always taken.
   If every score is zero (no shared term), take windows in DOCUMENT order
   instead, which serves "what is this document about?".
3. One request. System prompt: answer only from the excerpts; when they do not
   contain the answer, set `found` false and say so rather than guess. Excerpts
   are sent in document order, each prefixed `[page N]`. Schema:
   `{ answer: string, found: boolean, pages: integer[] }`.
4. Check the reply's shape; malformed → `AiServiceError`. Cited pages not among
   the excerpts sent are DROPPED — a model cannot cite what it was not shown,
   so such a citation is invented. Pages are deduped and sorted.

`excerpts` in the result are in RANK order (most relevant first), which is what
a caller showing evidence wants; the request uses document order, which is what
a reader of the excerpts wants. Both are deliberate.

## GenerateAltText — `src/aialttext.ts`

Refuses a signed document (`hasSignatureField`) with `UnsupportedFeatureError`,
as `MakeSearchable` does.

**Tagged document** (`doc.GetStructTree() !== null`):
1. Walk the tree for elements whose `StandardType` is `Figure` on selected pages
   with no `/Alt` and no `/ActualText` (or every Figure when `overwrite`).
2. For each, collect its image XObjects through the same MCID → image mapping
   `docmodel.ts` uses for the HTML export — extracted to a shared function, not
   copied. Encode each with `encodeImage` (PNG/JPEG).
3. No image (a vector chart): render the page and crop to the figure's
   `GetBBox`, as PNG. No bbox either: `skipped`, reason
   `'no image and no bounding box'`.
4. Dedupe: figures whose image set has the same `imageKey`s share one request
   and one answer.
5. Request: the image(s), plus context — the figure's page text trimmed to
   2,000 characters — and the language. Schema `{ alt: string, decorative:
   boolean }`; prompt asks for one or two concise sentences describing what
   the image conveys. Shape checked; an empty `alt` with `decorative` false is a
   failure.
6. `described` → set `el.Alt`. `decorative` → report, leave the element alone
   (turning a `/Figure` into an artifact is the author's structural decision).
   Failure → `failed` with the error message; the run continues. An abort
   rethrows after recording finished figures.

**Untagged document:**
1. `autoTag: false` → `UnsupportedFeatureError` ("untagged; tag it first or pass
   autoTag").
2. Walk selected pages' image draws exactly as `AutoTag` does — `visitContent`
   image events at page top level (`addr.path.length === 0`) — keeping those
   with a `stream`; dedupe by `imageKey`; describe each distinct image as above
   (context: its page text). Describing the SAME set AutoTag tags is what keeps
   a request from being spent on an image AutoTag never asks about (one inside
   a Form XObject).
3. Run `AutoTag` with `alt: (img) => described.get(key(img.stream))` —
   `undefined` for decorative or failed, which AutoTag already turns into an
   `/Artifact`. One record per distinct image; a failed one's reason says it
   was artifacted.

`language` defaults to the element's effective language
(`StructElement.EffectiveLang`), else `doc.Lang`, else unstated (the model
answers in the context's language).

## Error handling

- Option validation before any model call; a rejected call changes nothing.
- `AiServiceError` from the model or from a malformed reply: Summarize and Ask
  propagate it (one answer, nothing partial to keep); GenerateAltText records
  it per figure and continues.
- Abort: Summarize/Ask propagate `signal.reason`; GenerateAltText stops,
  writes nothing more, and rethrows after `onFigure` has seen every finished
  figure. In the untagged path an abort means AutoTag does not run.
- `rethrowLimit` first in every catch.

## Testing

- **`test/helpers/scripted-model.ts`** — an `AiModel` stub recording every
  request and answering from a script function.
- **`aichunk`**: budgets respected, page labels, oversized-page splitting at
  blank line / newline / space / hard, window overlap, no window crossing pages.
- **`bm25`**: a hand-built corpus with a known ranking; IDF (a term in every
  doc contributes nothing positive beyond rare terms); CJK and Cyrillic
  tokenization; ties by index.
- **Summarize**: one chunk → 1 request; many chunks → map + reduce counts;
  recursion when partial summaries overflow; `instructions` only in the final
  request; usage summed; empty document refused.
- **Ask**: the right windows reach the request (by page label); budget and
  `maxChunks` honoured; zero-score fallback to document order; invented
  citations dropped; `found: false` passes through; malformed reply throws.
- **GenerateAltText**: tagged fixture's `ValidatePdfUa` loses its
  `IllustrationAlt` issues and `/Alt` survives Save/Open; existing `/Alt` kept
  unless `overwrite`; a shared image described once; vector figure sends a
  crop; decorative left alone; untagged fixture comes out with `/Figure` +
  `/Alt`; `autoTag: false` refuses; signed refuses; abort keeps finished.
- **Mutations** that must redden: dropping the citation filter, reduce without
  recursion, IDF set to 1, `overwrite` ignored, dedup by stream identity instead
  of `imageKey`, the zero-score fallback removed, `instructions` sent to every
  map request.

## Out of scope

- Streaming replies, conversation history, multi-question sessions.
- Embeddings and semantic retrieval.
- Turning a tagged `/Figure` into an artifact when the model says decorative.
- Alt-text for inline (`BI … EI`) images — they have no XObject to dedupe or
  encode through `encodeImage`; in the untagged path AutoTag artifacts them, as
  it does today for any image its callback does not describe.
- Images drawn inside Form XObjects in an UNTAGGED document — AutoTag does not
  tag them, so there is nowhere to put an `/Alt`.

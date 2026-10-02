/** `aiOcrEngine` (`3ywf.3`): an {@link OcrEngine} over an {@link AiModel}.
 *
 *  One request per page: the image plus a JSON schema asking for LINES with a
 *  box each, on a 0–1000 grid over the image — the convention vision models
 *  localize best in — scaled to pixels here. Lines rather than words because
 *  models box whole lines far more reliably; the glyphless font's uniform
 *  advance then spreads a line's characters evenly across its box.
 *
 *  **Invariant:** the reply is parsed and its SHAPE checked here — `3ywf.2`
 *  validates no schema, and model output is input we did not write. One
 *  whole-reply markdown fence is stripped first (`aijson.ts`). A reply
 *  that is not `{ lines: [{ text, box: [4 finite numbers] }] }` throws
 *  `AiServiceError`, which `MakeSearchable` records as that page failing. */
import type { AiModel } from './aimodel.js';
import type { OcrEngine, OcrImage, OcrSpan } from './ocr.js';
import { AiServiceError } from './errors.js';
import { parseJsonReply } from './aijson.js';

/** Options for {@link aiOcrEngine}. */
export interface AiOcrOptions {
  /** The expected language, as a hint in the prompt (e.g. `'German'`, `'ja'`). */
  language?: string;
  /** Upper bound on the reply. Default 4096. */
  maxTokens?: number;
}

const GRID = 1000;
const PROMPT =
  'You are an OCR engine. Transcribe every line of visible text on the page image, in reading order. ' +
  'For each line give its exact text and its bounding box [x0, y0, x1, y1] on a 0-1000 grid over the image: ' +
  'origin top-left, x to the right, y downward. Reply with JSON only.';

const SCHEMA = {
  type: 'object', additionalProperties: false, required: ['lines'],
  properties: {
    lines: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false, required: ['text', 'box'],
        properties: {
          text: { type: 'string' },
          box: { type: 'array', items: { type: 'number' }, minItems: 4, maxItems: 4 },
        },
      },
    },
  },
};

/** An {@link OcrEngine} that asks `model` to read each page. */
export function aiOcrEngine(model: AiModel, opts: AiOcrOptions = {}): OcrEngine {
  if (model === null || typeof model !== 'object' || typeof model.complete !== 'function')
    throw new TypeError('model must be an AiModel');
  if (opts.language !== undefined && typeof opts.language !== 'string') throw new TypeError('language must be a string');
  const maxTokens = opts.maxTokens ?? 4096;
  if (typeof maxTokens !== 'number') throw new TypeError('maxTokens must be a number');
  if (!Number.isInteger(maxTokens) || maxTokens < 1) throw new RangeError('maxTokens must be a positive integer');
  const system = opts.language ? `${PROMPT} The text is expected to be in ${opts.language}.` : PROMPT;

  return {
    async recognize(image: OcrImage, { signal }: { signal?: AbortSignal } = {}): Promise<OcrSpan[]> {
      const r = await model.complete({
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: [
            { type: 'text', text: 'Transcribe this page.' },
            { type: 'image', bytes: image.bytes, mediaType: image.mediaType },
          ] },
        ],
        schema: { name: 'ocr_lines', schema: SCHEMA },
        maxTokens,
        signal,
      });
      return parseLines(r.text, image.width, image.height);
    },
  };
}

function bad(): AiServiceError {
  return new AiServiceError('OCR reply is not the requested shape');
}

function parseLines(text: string, width: number, height: number): OcrSpan[] {
  const json = parseJsonReply(text, bad);
  const lines = json !== null && typeof json === 'object' ? (json as { lines?: unknown }).lines : undefined;
  if (!Array.isArray(lines)) throw bad();
  return lines.map((l: unknown): OcrSpan => {
    if (l === null || typeof l !== 'object') throw bad();
    const { text: t, box } = l as { text?: unknown; box?: unknown };
    if (typeof t !== 'string' || !Array.isArray(box) || box.length !== 4) throw bad();
    if (!box.every((n) => typeof n === 'number' && Number.isFinite(n))) throw bad();
    const [a, b, c, d] = box as number[];
    const sx = width / GRID; const sy = height / GRID;
    return { text: t, box: [Math.min(a!, c!) * sx, Math.min(b!, d!) * sy, Math.max(a!, c!) * sx, Math.max(b!, d!) * sy] };
  });
}

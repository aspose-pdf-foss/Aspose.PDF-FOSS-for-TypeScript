import type { Document } from './document.js';
import type { Page } from './page.js';
import type { OcrEngine, OcrSpan } from './ocr.js';
import { positionOcrSpans, type PositionedOcrSpan } from './ocrlayer.js';
import { baseMatrix } from './pagerender.js';
import { mul, type Matrix } from './text.js';
import { resolvePages } from './pagerange.js';
import { rethrowLimit } from './errors.js';

export interface OcrOptions<PageRecord> {
  /** 1-based selection. Defaults to all pages. */
  pages?: number[] | string;
  /** Recognize pages that already have extractable text. Default false. */
  force?: boolean;
  /** Resolution of the engine input. Default 200, maximum 1200. */
  dpi?: number;
  signal?: AbortSignal;
  onPage?: (record: PageRecord) => void;
}

export type RecognizeTextOptions = OcrOptions<RecognizeTextPage>;

interface PositionedPage {
  page: number;
  status: 'ocr' | 'skipped' | 'failed';
  reason?: string;
  spans: PositionedOcrSpan[];
  dropped: number;
}

export interface RecognizeTextPage extends PositionedPage {
  /** NFC-normalized spans in engine order, separated by newlines. */
  text: string;
}

export interface RecognizeTextReport { pages: RecognizeTextPage[] }

/** Validate before either consumer starts work on the document. */
export function selectOcrPages<T>(doc: Document, engine: OcrEngine, opts: OcrOptions<T>) {
  if (engine === null || typeof engine !== 'object' || typeof engine.recognize !== 'function')
    throw new TypeError('engine must have a recognize(image, opts) method');
  if (opts === null || typeof opts !== 'object') throw new TypeError('options must be an object');
  const dpi = opts.dpi ?? 200;
  if (typeof dpi !== 'number') throw new TypeError('dpi must be a number');
  if (!(dpi > 0 && dpi <= 1200)) throw new RangeError(`dpi must be in (0, 1200]: ${dpi}`);
  if (opts.onPage !== undefined && typeof opts.onPage !== 'function') throw new TypeError('onPage must be a function');
  return { pages: resolvePages(opts.pages, doc.Pages.length), dpi };
}

function isSpans(value: unknown): value is OcrSpan[] {
  return Array.isArray(value) && Array.from(value).every(s =>
    s !== null && typeof s === 'object' && typeof s.text === 'string'
    && Array.isArray(s.box) && s.box.length === 4 && Array.from(s.box).every(n => typeof n === 'number'));
}

function ocrDeviceMatrix(page: Page, dpi: number): Matrix {
  const scale = dpi / 72;
  return mul(baseMatrix(page, 'crop').matrix, [scale, 0, 0, scale, 0, 0]);
}

async function recognizePage(
  page: Page, n: number, engine: OcrEngine, dpi: number, signal?: AbortSignal,
): Promise<PositionedPage> {
  try {
    const bytes = page.ToImage({ format: 'png', scale: dpi / 72, signal });
    const header = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const size = { width: header.getUint32(16), height: header.getUint32(20) };
    const device = ocrDeviceMatrix(page, dpi);
    const spans = await engine.recognize({ bytes, mediaType: 'image/png', ...size }, { signal });
    if (!isSpans(spans)) throw new TypeError('engine returned something other than an array of { text, box } spans');
    return { page: n, status: 'ocr', ...positionOcrSpans(spans, device, size) };
  } catch (caught) {
    rethrowLimit(caught);
    signal?.throwIfAborted();
    return { page: n, status: 'failed', reason: caught instanceof Error ? caught.message : String(caught), spans: [], dropped: 0 };
  }
}

export async function* ocrPages<T>(
  doc: Document, engine: OcrEngine, opts: OcrOptions<T>, selection: ReturnType<typeof selectOcrPages>,
): AsyncGenerator<{ page: Page; result: PositionedPage }> {
  for (const n of selection.pages) {
    opts.signal?.throwIfAborted();
    const page = doc.Pages[n - 1]!;
    if (!opts.force && page.GetText().trim() !== '') {
      yield { page, result: { page: n, status: 'skipped', reason: 'has-text', spans: [], dropped: 0 } };
    } else {
      yield { page, result: await recognizePage(page, n, engine, selection.dpi, opts.signal) };
    }
  }
  // A completed overlay page keeps its text when the engine aborts and returns.
  opts.signal?.throwIfAborted();
}

export async function recognizeText(doc: Document, engine: OcrEngine, opts: RecognizeTextOptions = {}): Promise<RecognizeTextReport> {
  const pages: RecognizeTextPage[] = [];
  for await (const { result: page } of ocrPages(doc, engine, opts, selectOcrPages(doc, engine, opts))) {
    const result = { ...page, text: page.spans.map(span => span.text).join('\n') };
    pages.push(result);
    opts.onPage?.(result);
  }
  return { pages };
}

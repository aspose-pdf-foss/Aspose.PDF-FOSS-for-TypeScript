/** `doc.MakeSearchable` (`3ywf.3`): an invisible, exactly placed text layer
 *  over image-only pages, from an {@link OcrEngine} the caller supplies.
 *
 *  The only module of the feature touching a `Document`. It renders each page,
 *  asks the engine, and splices `ocrlayer.ts`'s bytes in with `appendContent`,
 *  which wraps the existing content in `q … Q` so a CTM the page leaves changed
 *  cannot move the layer.
 *
 *  **Invariant:** the page→pixel matrix is {@link ocrDeviceMatrix}, which is
 *  `renderCanvas`'s own composition — the render and the layer cannot disagree
 *  about where a pixel is.
 *
 *  **Invariant:** a failing page is RECORDED and the run continues; a caller
 *  abort stops it and throws. Pages already written keep their layer, and the
 *  font is finished in a `finally`, so an aborted run leaves a complete
 *  `/ToUnicode` behind rather than a placeholder.
 *
 *  **Invariant:** the font is allocated LAZILY, on the first page that writes
 *  a span, so a run that writes nothing changes nothing. */
import type { Document } from './document.js';
import type { Page } from './page.js';
import type { OcrEngine, OcrSpan } from './ocr.js';
import { baseMatrix } from './pagerender.js';
import { mul, type Matrix } from './text.js';
import { resolvePages } from './pagerange.js';
import { appendContent, ensureOwnResources, ensureOwnSubdict, freshKey, wrapArtifact } from './pagecontent.js';
import { createGlyphlessFont, GlyphlessCodes, type GlyphlessFont } from './glyphless.js';
import { buildOcrLayer } from './ocrlayer.js';
import { hasSignatureField } from './signature.js';
import { UnsupportedFeatureError, rethrowLimit } from './errors.js';
import { isDict } from './types.js';

export interface MakeSearchableOptions {
  /** Pages to consider: `[1, 3]` or `"1-5,8"`. Default all. */
  pages?: number[] | string;
  /** OCR pages that already have text. Adds a layer; removes none. Default false. */
  force?: boolean;
  /** Render resolution handed to the engine. Default 200; at most 1200. */
  dpi?: number;
  signal?: AbortSignal;
  /** Called after each page with that page's record. */
  onPage?: (r: MakeSearchablePage) => void;
}

export interface MakeSearchablePage {
  /** 1-based. */
  page: number;
  status: 'ocr' | 'skipped' | 'failed';
  /** `'has-text'` for a skipped page; the error message for a failed one. */
  reason?: string;
  /** Spans written. */
  spans: number;
  /** Spans refused: a bad box, or empty text. */
  dropped: number;
}

export interface MakeSearchableReport { pages: MakeSearchablePage[] }

/** Page space → rendered pixels at `dpi`: `renderCanvas`'s composition. */
export function ocrDeviceMatrix(page: Page, dpi: number): Matrix {
  const s = dpi / 72;
  return mul(baseMatrix(page, 'crop').matrix, [s, 0, 0, s, 0, 0]);
}

/** Width and height from a PNG's IHDR. */
function pngSize(png: Uint8Array): { width: number; height: number } {
  const v = new DataView(png.buffer, png.byteOffset, png.byteLength);
  return { width: v.getUint32(16), height: v.getUint32(20) };
}

function isSpans(v: unknown): v is OcrSpan[] {
  return Array.isArray(v) && v.every((s) =>
    s !== null && typeof s === 'object' && typeof (s as OcrSpan).text === 'string'
    && Array.isArray((s as OcrSpan).box) && (s as OcrSpan).box.length === 4
    && (s as OcrSpan).box.every((n) => typeof n === 'number'));
}

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export async function makeSearchable(
  doc: Document, engine: OcrEngine, opts: MakeSearchableOptions = {},
): Promise<MakeSearchableReport> {
  if (engine === null || typeof engine !== 'object' || typeof engine.recognize !== 'function')
    throw new TypeError('engine must have a recognize(image, opts) method');
  if (opts === null || typeof opts !== 'object') throw new TypeError('options must be an object');
  const dpi = opts.dpi ?? 200;
  if (typeof dpi !== 'number') throw new TypeError('dpi must be a number');
  if (!(dpi > 0 && dpi <= 1200)) throw new RangeError(`dpi must be in (0, 1200]: ${dpi}`);
  if (opts.onPage !== undefined && typeof opts.onPage !== 'function') throw new TypeError('onPage must be a function');
  const selected = resolvePages(opts.pages, doc.Pages.length);
  if (hasSignatureField(doc))
    throw new UnsupportedFeatureError('MakeSearchable: the document has signature fields; a text layer on every page would invalidate them');

  const tagged = doc.GetStructTree() !== null;
  const codes = new GlyphlessCodes();
  const pages: MakeSearchablePage[] = [];
  let font: GlyphlessFont | undefined;
  const record = (r: MakeSearchablePage): void => { pages.push(r); opts.onPage?.(r); };

  try {
    for (const n of selected) {
      if (opts.signal?.aborted) throw opts.signal.reason;
      const page = doc.Pages[n - 1]!;
      if (!opts.force && page.GetText().trim() !== '') {
        record({ page: n, status: 'skipped', reason: 'has-text', spans: 0, dropped: 0 });
        continue;
      }
      const failed = (reason: string): void => record({ page: n, status: 'failed', reason, spans: 0, dropped: 0 });
      let spans: unknown;
      let size: { width: number; height: number };
      try {
        const png = page.ToImage({ format: 'png', scale: dpi / 72 });
        size = pngSize(png);
        spans = await engine.recognize({ bytes: png, mediaType: 'image/png', ...size }, { signal: opts.signal });
      } catch (caught) {
        rethrowLimit(caught);
        if (opts.signal?.aborted) throw opts.signal.reason;
        failed(message(caught));
        continue;
      }
      if (!isSpans(spans)) { failed('engine returned something other than an array of { text, box } spans'); continue; }

      const existing = doc.resolve(page.Resources?.get('Font'));
      const key = freshKey(isDict(existing) ? existing : new Map(), 'OCR');
      let layer;
      try {
        layer = buildOcrLayer(spans, ocrDeviceMatrix(page, dpi), size, codes, key);
      } catch (caught) {
        rethrowLimit(caught);
        failed(message(caught));
        continue;
      }
      if (layer.written > 0) {
        font ??= createGlyphlessFont((o) => doc.allocObject(o), (r, o) => doc.replaceObject(r.num, o));
        const fonts = ensureOwnSubdict(doc, ensureOwnResources(doc, page), 'Font');
        fonts.set(key, font.font);
        appendContent(doc, page, tagged ? wrapArtifact(layer.body) : layer.body);
      }
      record({ page: n, status: 'ocr', spans: layer.written, dropped: layer.dropped });
    }
  } finally {
    if (font) { font.finish(codes); doc.markModified(); }
  }
  return { pages };
}

/** `doc.MakeSearchable` (`3ywf.3`): an invisible, exactly placed text layer
 *  over image-only pages, from an {@link OcrEngine} the caller supplies.
 *
 *  Writes positioned OCR spans as invisible text. Page recognition and
 *  coordinate mapping are shared with the read-only workflow.
 *
 *  **Invariant:** a failing page is RECORDED and the run continues; a caller
 *  abort stops it and throws. Pages already written keep their layer, and the
 *  font is finished in a `finally`, so an aborted run leaves a complete
 *  `/ToUnicode` behind rather than a placeholder.
 *
 *  **Invariant:** the font is allocated LAZILY, on the first page that writes
 *  a span, so a run that writes nothing changes nothing. */
import type { Document } from './document.js';
import type { OcrEngine } from './ocr.js';
import { selectOcrPages, ocrPages, type OcrOptions } from './recognizetext.js';
import { appendContent, ensureOwnResources, ensureOwnSubdict, freshKey, wrapArtifact } from './pagecontent.js';
import { createGlyphlessFont, GlyphlessCodes, type GlyphlessFont } from './glyphless.js';
import { positionedLayerBody } from './ocrlayer.js';
import { hasSignatureField } from './signature.js';
import { UnsupportedFeatureError, rethrowLimit } from './errors.js';
import { isDict } from './types.js';

export interface MakeSearchableOptions extends OcrOptions<MakeSearchablePage> {}

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

export async function makeSearchable(
  doc: Document, engine: OcrEngine, opts: MakeSearchableOptions = {},
): Promise<MakeSearchableReport> {
  const selected = selectOcrPages(doc, engine, opts);
  if (hasSignatureField(doc))
    throw new UnsupportedFeatureError('MakeSearchable: the document has signature fields; a text layer on every page would invalidate them');

  const tagged = doc.GetStructTree() !== null;
  const codes = new GlyphlessCodes();
  const pages: MakeSearchablePage[] = [];
  let font: GlyphlessFont | undefined;
  const record = (r: MakeSearchablePage): void => { pages.push(r); opts.onPage?.(r); };

  try {
    for await (const { page, result } of ocrPages(doc, engine, opts, selected)) {
      const { page: n, status, spans, dropped } = result;
      if (status !== 'ocr') {
        record({ page: n, status, spans: 0, dropped, reason: result.reason });
        continue;
      }
      if (spans.length > 0) {
        const existing = doc.resolve(page.Resources?.get('Font'));
        const key = freshKey(isDict(existing) ? existing : new Map(), 'OCR');
        let body: Uint8Array;
        try {
          body = positionedLayerBody(spans, codes, key);
        } catch (caught) {
          rethrowLimit(caught);
          record({ page: n, status: 'failed', reason: caught instanceof Error ? caught.message : String(caught), spans: 0, dropped: 0 });
          continue;
        }
        font ??= createGlyphlessFont((o) => doc.allocObject(o), (r, o) => doc.replaceObject(r.num, o));
        const fonts = ensureOwnSubdict(doc, ensureOwnResources(doc, page), 'Font');
        fonts.set(key, font.font);
        appendContent(doc, page, tagged ? wrapArtifact(body) : body);
      }
      record({ page: n, status, spans: spans.length, dropped });
    }
  } finally {
    if (font) { font.finish(codes); doc.markModified(); }
  }
  return { pages };
}

/**
 * Expand an image file into PAGES — one per frame — behind
 * `doc.AddImagePages()`.
 *
 * Note the direction: `page.AddImage` draws an image INTO an existing page,
 * and this creates pages FROM one. A multi-frame TIFF is the case that needs
 * it (a scanned or faxed document arrives as one file of many pages), but a
 * single-frame JPEG, PNG or BMP goes through the same path and yields one
 * page, which is the ordinary image-to-PDF operation.
 *
 * **Invariant:** the expansion happens at ADD time, not at save. Java expands a
 * multi-frame TIFF when the document is written; this library's model is
 * parse-whole, mutate-live, serialize-on-save, and `Save()` is a pure function
 * of the live model. Creating pages during serialization would make the page
 * count depend on when you looked, and would put a decoder inside the writer.
 *
 * **Invariant:** a frame that will not decode costs ITS OWN page and nothing
 * else. A partly-corrupt fax should still yield the pages that survive, which
 * is why this reports `skipped` rather than throwing — the rule `svgdraw.ts`
 * sets for content it cannot render. It throws only when NO frame decoded,
 * where there is nothing to hand back and silence would look like success.
 *
 * **Invariant:** `frames` is a SELECTION, normalized ascending and deduped, as
 * every other page selection in this library is. A caller wanting a particular
 * order makes the calls in that order; a selection that silently reordered
 * pages would be a different feature wearing the same name.
 */

import type { Document } from './document.js';
import type { Page } from './page.js';
import { PageFormat } from './pageformat.js';
import { buildImageXObject, drawBuiltImage, imageFrameCount } from './imageembed.js';

export interface AddImagePagesOptions {
  /** Which frames, 0-based. Default every frame. Normalized ascending and
   *  deduped. */
  frames?: number[];
  /** Pixels per inch used to size each page. Default 72, i.e. one pixel per
   *  point. A 300-DPI scan at 300 sizes its pages in real inches. */
  dpi?: number;
  /** Override format auto-detection. Default: sniff magic bytes. */
  format?: 'jpeg' | 'png' | 'bmp' | 'tiff';
}

export interface SkippedFrame {
  /** 0-based index in the source file. */
  frame: number;
  /** The decoder's own message. */
  reason: string;
}

export interface AddImagePagesResult {
  /** The pages appended, in frame order. */
  pages: Page[];
  /** Frames that could not be decoded, in frame order. Empty on a clean run. */
  skipped: SkippedFrame[];
}

/** Normalize a frame selection, or every frame when none is given. */
function resolveFrames(frames: number[] | undefined, total: number): number[] {
  if (frames === undefined) return Array.from({ length: total }, (_, i) => i);
  if (frames.length === 0)
    throw new TypeError('AddImagePages: the frame selection is empty; at least one frame is required');
  for (const f of frames) {
    if (!Number.isInteger(f)) throw new TypeError(`AddImagePages: frame ${f} must be an integer`);
    if (f < 0 || f >= total)
      throw new RangeError(`AddImagePages: frame ${f} out of range (0..${total - 1})`);
  }
  return [...new Set(frames)].sort((a, b) => a - b);
}

const dimOf = (dict: Map<string, unknown>, key: string): number => {
  const v = dict.get(key);
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0;
};

export function addImagePages(
  doc: Document, data: Uint8Array, opts: AddImagePagesOptions = {},
): AddImagePagesResult {
  const dpi = opts.dpi ?? 72;
  if (!Number.isFinite(dpi) || dpi <= 0)
    throw new TypeError('AddImagePages: dpi must be a positive number');

  const total = imageFrameCount(data, opts.format);
  const wanted = resolveFrames(opts.frames, total);

  const pages: Page[] = [];
  const skipped: SkippedFrame[] = [];

  for (const frame of wanted) {
    let built;
    try {
      built = buildImageXObject(data, opts.format, frame);
    } catch (e) {
      skipped.push({ frame, reason: e instanceof Error ? e.message : String(e) });
      continue;
    }
    const px = dimOf(built.stream.dict, 'Width');
    const py = dimOf(built.stream.dict, 'Height');
    if (px === 0 || py === 0) {
      skipped.push({ frame, reason: 'image has no usable /Width or /Height' });
      continue;
    }
    const w = (px * 72) / dpi;
    const h = (py * 72) / dpi;
    const { page } = doc.AddPage(PageFormat.custom(w, h));
    drawBuiltImage(doc, page, built, [0, 0, w, h]);
    pages.push(page);
  }

  if (pages.length === 0) {
    const why = skipped.map((s) => `frame ${s.frame}: ${s.reason}`).join('; ');
    throw new Error(`AddImagePages: no frame could be decoded (${why})`);
  }
  return { pages, skipped };
}

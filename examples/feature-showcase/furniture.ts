import type { Document, Page } from '../../src/index.js';
import { pageHeight, pageWidth, xywh } from './theme.js';
import { asposeLogo } from './assets.js';

/** The Aspose wordmark in the top-right corner of every page but the skipped
 *  ones (cover and TOC carry their own branding). The logo's viewBox is 314x100,
 *  and the stamp rect keeps that aspect. There is no load-once SVG handle in
 *  this library, so the same bytes are parsed once per page — fine at this
 *  scale, and cheaper than hand-caching a Form XObject. */
export function stampLogoOnEveryPage(doc: Document, skip: Page[]): void {
  const svg = asposeLogo();
  const skipNumbers = new Set(skip.map((p) => p.Number));
  const stampW = 120;
  const stampH = 38; // 314/100 * 38 ~= 119.3
  const margin = 25;

  for (const p of doc.Pages) {
    if (skipNumbers.has(p.Number)) continue;
    const urx = pageWidth(p) - margin;
    const ury = pageHeight(p) - margin;
    p.AddSVGObject(svg, xywh([urx - stampW, ury - stampH, urx, ury]));
  }
}

/** "WATERMARK" across one page, diagonal and behind the content.
 *
 *  The Go original solved for a rect origin by hand so that a 45-degree
 *  rotation about the rect's bottom-left corner landed the text centre on the
 *  page centre. This library has the purpose-built API instead: the 'diagonal'
 *  preset centres, angles and auto-fits the text, and 'underlay' sinks it
 *  beneath existing content. */
export function addCenteredWatermark(doc: Document, page: Page, text: string): void {
  doc.AddWatermark({
    text,
    pages: [page.Number],
    position: 'diagonal',
    mode: 'underlay',
    font: 'Helvetica-Bold',
    color: [0.85, 0.85, 0.85],
    opacity: 0.4,
  });
}

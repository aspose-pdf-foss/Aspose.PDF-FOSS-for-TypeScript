import type { Document, Page } from '../../src/index.js';
import { pageHeight, pageWidth } from './theme.js';
import { asposeLogo } from './assets.js';

/** Stamp a shared Aspose wordmark in the top-right corner. The cover and TOC
 *  carry their own branding. */
export function stampLogoOnEveryPage(doc: Document, skip: Page[]): void {
  const skipNumbers = new Set(skip.map((p) => p.Number));
  const pages = doc.Pages.filter(p => !skipNumbers.has(p.Number));
  if (pages.length === 0) return;
  const stampW = 120;
  const stampH = 38; // 314/100 * 38 ~= 119.3
  const margin = 25;
  const logo = doc.NewTemplate(stampW, stampH);
  logo.page.AddSVGObject(asposeLogo(), [0, 0, stampW, stampH]);

  for (const page of pages) {
    const x = pageWidth(page) - margin - stampW;
    const y = pageHeight(page) - margin - stampH;
    logo.PlaceOn(page, [x, y, stampW, stampH]);
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

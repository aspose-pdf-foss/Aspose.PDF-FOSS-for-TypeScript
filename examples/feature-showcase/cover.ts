import type { Page } from '../../src/index.js';
import { addText, pageHeight, pageWidth, xywh, PRODUCT_NAME, MUTED, FAINT } from './theme.js';
import type { TextStyle } from './theme.js';
import { asposePinwheel, bookIcon, githubMark } from './assets.js';

const SOURCE_URL = 'https://github.com/aspose-pdf-foss/aspose-pdf-foss-for-ts';
const API_URL = 'https://github.com/aspose-pdf-foss/aspose-pdf-foss-for-ts#api-overview';

export function addCoverPage(page: Page): void {
  const w = pageWidth(page);
  const h = pageHeight(page);

  // Big pinwheel — square, centred, upper-middle of the page.
  const logoSize = 220;
  const logoX = (w - logoSize) / 2;
  const logoY = h - 100 - logoSize;
  page.AddSVGObject(asposePinwheel(), xywh([logoX, logoY, logoX + logoSize, logoY + logoSize]));

  const titleY = logoY - 80;
  addText(page, PRODUCT_NAME, [30, titleY, w - 30, titleY + 40], {
    font: 'Helvetica-Bold', size: 30, color: [0.1, 0.15, 0.4], align: 'center',
  });
  addText(page, 'Feature Showcase', [50, titleY - 38, w - 50, titleY - 8], {
    font: 'Helvetica-Oblique', size: 18, color: MUTED, align: 'center',
  });
  addText(page, 'An end-to-end tour of every library capability in one document.',
    [50, titleY - 70, w - 50, titleY - 48], { size: 12, color: FAINT, align: 'center' });

  // CTA row: [github mark] Source code  •  [book icon] API reference, laid out
  // symmetrically about the page centre.
  const iconH = 12;
  const githubAR = 1.0; // viewBox 16x16
  const bookAR = 1.0; // viewBox 24x24
  const textGap = 5;
  const bulletGap = 12;
  const linkY = 110;
  const srcW = 74; // "Source code" at Helvetica-Bold 12pt
  const apiW = 88; // "API reference"
  const bulletHW = 5;
  const centre = w / 2;

  const linkStyle: TextStyle = {
    font: 'Helvetica-Bold', size: 12, color: [0.1, 0.3, 0.7], underline: true,
  };

  // Left group.
  const ghW = iconH * githubAR;
  const srcEnd = centre - bulletHW - bulletGap;
  const srcStart = srcEnd - srcW;
  const ghEnd = srcStart - textGap;
  const ghStart = ghEnd - ghW;
  page.AddSVGObject(githubMark(), xywh([ghStart, linkY, ghEnd, linkY + iconH]));
  addText(page, 'Source code', [srcStart, linkY - 1, srcEnd, linkY + iconH], linkStyle);
  page.AddLink({
    rect: [ghStart - 2, linkY - 3, srcEnd + 2, linkY + iconH + 3],
    action: { type: 'uri', uri: SOURCE_URL },
  });

  // Centre bullet.
  addText(page, '•', [centre - bulletHW, linkY - 2, centre + bulletHW, linkY + iconH + 2], {
    font: 'Helvetica-Bold', size: 14, color: [0.3, 0.3, 0.35], align: 'center',
  });

  // Right group.
  const bookW = iconH * bookAR;
  const bookStart = centre + bulletHW + bulletGap;
  const bookEnd = bookStart + bookW;
  const apiStart = bookEnd + textGap;
  const apiEnd = apiStart + apiW;
  page.AddSVGObject(bookIcon(), xywh([bookStart, linkY, bookEnd, linkY + iconH]));
  addText(page, 'API reference', [apiStart, linkY - 1, apiEnd, linkY + iconH], linkStyle);
  page.AddLink({
    rect: [bookStart - 2, linkY - 3, apiEnd + 2, linkY + iconH + 3],
    action: { type: 'uri', uri: API_URL },
  });
}

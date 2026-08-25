import type { Page } from '../../src/index.js';
import { addText, pageWidth, pageHeight, sectionHeader, xywh, FAINT, MUTED } from './theme.js';
import { starryNight } from './assets.js';

export function addPageImage(page: Page): void {
  const w = pageWidth(page);
  const h = pageHeight(page);

  sectionHeader(page, 'Image Embedding',
    'JPEG / PNG raster images placed with pixel-precise Page.AddImage rectangles');

  addText(page,
    'Also available  ·  page.Images metadata-only inspection  ·  image.Decode() to samples  ·  Redact partial-image re-encode  ·  Optimize({ images }) downsample + JPEG re-encode',
    [40, h - 150, w - 40, h - 120],
    { size: 9, color: FAINT, align: 'center', lineSpacing: 1.3 });

  // Van Gogh's "The Starry Night" (1889) — public domain. Source is 1280x1014;
  // scaled to 60% of the page width, aspect preserved.
  const srcW = 1280;
  const srcH = 1014;
  const imgW = w * 0.6;
  const imgH = (imgW * srcH) / srcW;
  const x = (w - imgW) / 2;
  const y = (h - imgH) / 2;
  page.AddImage(starryNight(), xywh([x, y, x + imgW, y + imgH]));

  addText(page, 'Vincent van Gogh, The Starry Night (1889) — public domain',
    [50, y - 22, w - 50, y - 6],
    { font: 'Helvetica-Oblique', size: 10, color: MUTED, align: 'center' });
}

import type { Document, Page } from '../../src/index.js';
import type { Box } from './theme.js';
import { addText, sectionHeader, xywh } from './theme.js';

/** One pre-rendered thumbnail plus its source sheet's aspect, so portrait pages
 *  and the wide booklet spread share one tidy grid. */
export interface Thumb {
  img: Uint8Array;
  aspect: number;
  label: string;
}

/** Rasterize a finished page with the pure-TypeScript renderer at 96 DPI. */
export function renderPageThumb(page: Page, label: string): Thumb {
  const img = page.ToImage({ scale: 96 / 72 });
  const w = page.Rect[2] - page.Rect[0];
  const h = page.Rect[3] - page.Rect[1];
  return { img, aspect: w / h, label };
}

/** Rasterize the first sheet of an imposed document (the output of NUp/Booklet). */
export function imposedSheetThumb(doc: Document, label: string): Thumb {
  return renderPageThumb(doc.Pages[0], label);
}

/** A 2x2 grid of framed, captioned thumbnails. The top row is finished pages
 *  the renderer drew; the bottom row is an N-up sheet and a booklet spread the
 *  imposition API built from this document, which the renderer then drew. */
export function addRenderShowcase(page: Page, thumbs: Thumb[]): void {
  sectionHeader(page, 'Rendering & Imposition',
    'pages rasterized by the pure-TypeScript renderer  ·  N-up & booklet imposition sheets');

  const slotW = 232;
  const slotH = 210;
  const gapX = 40;
  const gapY = 34;
  const captionH = 15;
  const topY = 690;
  const pageW = page.Rect[2] - page.Rect[0];
  const leftX = (pageW - (2 * slotW + gapX)) / 2;

  // Images first, then their frames, then the captions — the frames are drawn
  // through PageGraphics, which buffers until apply(), so committing them after
  // the images keeps the rules on top of the artwork rather than under it.
  const placed: Box[] = [];
  thumbs.forEach((th, i) => {
    const col = i % 2;
    const row = Math.floor(i / 2);
    const sx = leftX + col * (slotW + gapX);
    const slotTop = topY - row * (slotH + captionH + gapY);

    // Fit inside the slot, aspect preserved, centred.
    let dw = slotW;
    let dh = slotH;
    if (th.aspect > slotW / slotH) dh = slotW / th.aspect;
    else dw = slotH * th.aspect;
    const ox = sx + (slotW - dw) / 2;
    const oy = slotTop - slotH + (slotH - dh) / 2;
    const rect: Box = [ox, oy, ox + dw, oy + dh];

    page.AddImage(th.img, xywh(rect));
    placed.push(rect);
  });

  const g = page.Graphics();
  for (const r of placed) {
    g.setStrokeColor([0.72, 0.72, 0.74]).setLineWidth(0.8)
      .rect(r[0], r[1], r[2] - r[0], r[3] - r[1]).stroke();
  }
  g.apply();

  thumbs.forEach((th, i) => {
    const col = i % 2;
    const row = Math.floor(i / 2);
    const sx = leftX + col * (slotW + gapX);
    const slotTop = topY - row * (slotH + captionH + gapY);
    addText(page, th.label,
      [sx, slotTop - slotH - captionH, sx + slotW, slotTop - slotH - 2],
      { size: 9, color: [0.3, 0.3, 0.3], align: 'center' });
  });
}

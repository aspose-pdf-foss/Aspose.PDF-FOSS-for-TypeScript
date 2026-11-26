/** The invisible text layer one page's OCR spans become (`3ywf.3`).
 *
 *  PURE: spans, the renderer's page→pixel matrix and the code assigner in;
 *  content-stream bytes out. No `Document`.
 *
 *  **Invariant:** the stretch lives in `Tm`, not `Tz`. With font size 1 and a
 *  uniform advance, each span's natural width is `0.5 × codes`; the text
 *  matrix maps that onto the box's along-vector, the box height onto its
 *  up-vector, and the box's bottom-left onto the origin — all through the
 *  INVERSE of the device matrix, so a rotated page needs no special case.
 *
 *  **Invariant:** a span is refused rather than guessed: non-finite, inverted,
 *  zero-area or wholly-outside boxes and whitespace-only text are dropped and
 *  counted; a box partly outside the image is clamped to it. */
import type { OcrSpan } from './ocr.js';
import { GLYPHLESS_ADVANCE, type GlyphlessCodes } from './glyphless.js';
import { apply, invert, type Matrix } from './text.js';
import { num } from './pagecontent.js';

export interface OcrLayer {
  /** `BT … ET`, or an empty text object when nothing was written. */
  body: Uint8Array;
  written: number;
  dropped: number;
}

/** Corners in PDF user space, clockwise from the rendered image's top left. */
export interface PositionedOcrSpan extends OcrSpan {
  quad: [number, number, number, number, number, number, number, number];
}

export function positionOcrSpans(
  spans: readonly OcrSpan[], device: Matrix, image: { width: number; height: number },
) {
  const inv = invert(device);
  const positioned: PositionedOcrSpan[] = [];
  for (const s of spans) {
    const text = typeof s.text === 'string' ? s.text.normalize('NFC') : '';
    const b = s.box;
    if (text.trim() === '' || !Array.isArray(b) || b.length !== 4 || !b.every(Number.isFinite)) continue;
    const x0 = Math.max(0, b[0]); const y0 = Math.max(0, b[1]);
    const x1 = Math.min(image.width, b[2]); const y1 = Math.min(image.height, b[3]);
    if (!(x1 > x0 && y1 > y0)) continue;
    positioned.push({
      text, box: [x0, y0, x1, y1],
      quad: [...apply(inv, x0, y0), ...apply(inv, x1, y0), ...apply(inv, x1, y1), ...apply(inv, x0, y1)],
    });
  }
  return { spans: positioned, dropped: spans.length - positioned.length };
}

export function buildOcrLayer(
  spans: readonly OcrSpan[], device: Matrix, image: { width: number; height: number },
  codes: GlyphlessCodes, fontKey: string,
): OcrLayer {
  const result = positionOcrSpans(spans, device, image);
  return { body: positionedLayerBody(result.spans, codes, fontKey), written: result.spans.length, dropped: result.dropped };
}

export function positionedLayerBody(spans: readonly PositionedOcrSpan[], codes: GlyphlessCodes, fontKey: string): Uint8Array {
  let out = `BT\n/${fontKey} 1 Tf\n3 Tr\n`;
  for (const { text, quad } of spans) {
    const cs = codes.encode(text);
    const natural = (GLYPHLESS_ADVANCE / 1000) * cs.length;
    const [left, top, , , rightX, rightY, px, py] = quad;
    const ax = (rightX - px) / natural, ay = (rightY - py) / natural;
    const ux = left - px, uy = top - py;
    const hex = cs.map((c) => c.toString(16).toUpperCase().padStart(4, '0')).join('');
    out += `${num(ax)} ${num(ay)} ${num(ux)} ${num(uy)} ${num(px)} ${num(py)} Tm\n<${hex}> Tj\n`;
  }
  out += 'ET';
  return new TextEncoder().encode(out);
}

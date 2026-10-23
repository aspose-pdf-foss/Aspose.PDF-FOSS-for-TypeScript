// The module geometry of a 2D barcode in a box, and the symbol a paper-barcode
// field's content makes (2srz.4). A leaf over the encoders and pmd.ts, shared
// by barcodeplace.ts (page.AddBarcode) and appearance.ts (a barcode field's
// /AP), so the two draw one symbol one way.
import { deflateSync } from 'node:zlib';
import type { MatrixBarcode } from './barcode.js';
import { makePdf417Bytes, pdf417Bytes } from './pdf417.js';
import { makeDataMatrixBytes, dataMatrixBytes } from './datamatrix.js';
import { makeQrBytes, type QrEcc } from './qr.js';
import { rethrowLimit } from './errors.js';
import type { PaperMetadata } from './pmd.js';

/** A dark rectangle in PDF user space. */
export interface Rect { x: number; y: number; w: number; h: number; }

/** Geometry of a matrix barcode centered in `rect`: the largest module size
 *  `u` at which the symbol, its quiet zone and its row height all fit. A row
 *  is `rowHeight` modules tall (PDF417's 3), so the drawn height is
 *  `rows * rowHeight * u`. */
export function matrixLayout(m: MatrixBarcode, x: number, y: number, w: number, h: number, quiet: boolean) {
  const cols = m.width ?? m.size, rows = m.height ?? m.size, rh = m.rowHeight ?? 1;
  const q = quiet ? (m.quiet ?? 4) : 0;
  const wq = cols + 2 * q, hq = rows * rh + 2 * q;
  const u = Math.min(w / wq, h / hq);
  const sw = wq * u, sh = hq * u;
  const x0 = x + (w - sw) / 2;
  const yTop = y + (h - sh) / 2 + sh; // top edge of the quiet-zone box
  return { q, cols, rows, rh, wq, hq, u, sw, sh, x0, yTop };
}

export function matrixRects(m: MatrixBarcode, x: number, y: number, w: number, h: number, quiet: boolean): Rect[] {
  const { q, cols, rows, rh, u, x0, yTop } = matrixLayout(m, x, y, w, h, quiet);
  const rects: Rect[] = [];
  for (let my = 0; my < rows; my++) for (let mx = 0; mx < cols; mx++) {
    if (!m.dark[my * cols + mx]) continue;
    rects.push({ x: x0 + (q + mx) * u, y: yTop - (q + (my + 1) * rh) * u, w: u, h: rh * u });
  }
  return rects;
}

const QR_ECC: readonly QrEcc[] = ['L', 'M', 'Q', 'H'];

/** The bytes a symbol carries for `content`, and the ECI they need: compressed
 *  UTF-8 under /DataPrep 1, else the encoder's own string conversion. */
function symbolBytes(content: string, pmd: PaperMetadata): { bytes: Uint8Array; eci?: number } {
  if (pmd.dataPrep === 1) return { bytes: new Uint8Array(deflateSync(new TextEncoder().encode(content))) };
  if (pmd.symbology === 'PDF417') return pdf417Bytes(content);
  if (pmd.symbology === 'DataMatrix') return dataMatrixBytes(content);
  return { bytes: new TextEncoder().encode(content) };
}

/** The symbol for a paper-barcode field's `content` under `pmd`, or undefined
 *  for empty content. Throws RangeError when the content does not fit. */
export function barcodeModel(content: string, pmd: PaperMetadata): MatrixBarcode | undefined {
  if (content === '') return undefined;
  const { bytes, eci } = symbolBytes(content, pmd);
  if (pmd.symbology === 'PDF417') return makePdf417Bytes(bytes, eci, { ecLevel: pmd.ecc, columns: pmd.nCodeWordCol });
  if (pmd.symbology === 'DataMatrix') return makeDataMatrixBytes(bytes, eci);
  try {
    return makeQrBytes(bytes, { ecc: pmd.ecc === undefined ? undefined : QR_ECC[pmd.ecc] });
  } catch (caught) {
    rethrowLimit(caught);
    // qr.ts reports an over-long payload as damage; here it is a size limit.
    throw new RangeError(`QR: ${(caught as Error).message}`);
  }
}

/** Content-stream operators painting `model` black, fitted with its quiet
 *  zone into a `w` x `h` box at the origin; '' for no model. */
export function barcodeBody(model: MatrixBarcode | undefined, w: number, h: number): string {
  if (model === undefined) return '';
  const r4 = (v: number) => String(Math.round(v * 1e4) / 1e4);
  const rects = matrixRects(model, 0, 0, w, h, true);
  return `0 g\n${rects.map((r) => `${r4(r.x)} ${r4(r.y)} ${r4(r.w)} ${r4(r.h)} re`).join('\n')}\nf`;
}

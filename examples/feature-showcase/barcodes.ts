import type { Page } from '../../src/index.js';
import type { Box } from './theme.js';
import { addText, cardGrid, sectionHeader, MUTED } from './theme.js';

/** [x, y, w, h] for a barcode inset into a card's inner box, leaving room for
 *  a one-line caption underneath. */
function slot(inner: Box, captionHeight: number): [number, number, number, number] {
  return [
    inner[0], inner[1] + captionHeight,
    inner[2] - inner[0], inner[3] - inner[1] - captionHeight,
  ];
}

/** A one-line caption pinned to the bottom of a card's inner box. */
function caption(page: Page, inner: Box, text: string): void {
  addText(page, text, [inner[0], inner[1], inner[2], inner[1] + 12], {
    size: 8, color: MUTED, align: 'center',
  });
}

export function addBarcodeShowcase(page: Page): void {
  sectionHeader(page, 'Barcodes & QR Codes',
    'Code 128  •  EAN-13  •  UPC-A  •  EAN-8  •  QR (ECC L / H)  •  vector vs raster stencil');

  const LABELS = [
    'Code 128 — alphanumeric',
    'EAN-13 — retail',
    'UPC-A — North America',
    'EAN-8 — short retail',
    'QR — ECC level L',
    'QR — ECC level H',
    'QR — raster stencil',
    'Code 128 — colour, no quiet zone',
  ];

  const inners = cardGrid(page, LABELS, {
    cols: 2, rows: 4, left: 50, right: 545, top: 705, bottom: 105,
  });

  // The check-digit symbologies get the canonical published payloads, so a
  // check-digit regression surfaces as a thrown error rather than a subtly
  // wrong symbol nobody scans.
  page.AddBarcode({ type: 'code128', data: 'ASPOSE-PDF-FOSS-TS' },
    slot(inners[0], 14), { text: true });
  caption(page, inners[0], 'variable length, three code sets');

  page.AddBarcode({ type: 'ean13', data: '5901234123457' }, slot(inners[1], 14));
  caption(page, inners[1], 'check digit 7, computed and verified');

  page.AddBarcode({ type: 'upca', data: '036000291452' }, slot(inners[2], 14));
  caption(page, inners[2], '12 digits — EAN-13 with a leading zero');

  page.AddBarcode({ type: 'ean8', data: '96385074' }, slot(inners[3], 14));
  caption(page, inners[3], '8 digits, for small packaging');

  // The same payload at two error-correction levels: ECC H reserves ~30% of the
  // codewords for recovery, so it needs a larger symbol for identical data.
  const QR_PAYLOAD = 'https://github.com/aspose-pdf-foss';
  page.AddBarcode({ type: 'qr', data: QR_PAYLOAD, ecc: 'L' }, slot(inners[4], 14));
  caption(page, inners[4], '~7% recovery — smallest symbol');

  page.AddBarcode({ type: 'qr', data: QR_PAYLOAD, ecc: 'H' }, slot(inners[5], 14));
  caption(page, inners[5], '~30% recovery — same payload, larger symbol');

  page.AddBarcode({ type: 'qr', data: QR_PAYLOAD, ecc: 'L' },
    slot(inners[6], 14), { render: 'raster' });
  caption(page, inners[6], 'one 1-bit /ImageMask, not one rect per module');

  page.AddBarcode({ type: 'code128', data: 'NO-QUIET-ZONE' },
    slot(inners[7], 14), { color: [0.15, 0.20, 0.55], quietZone: false, text: true });
  caption(page, inners[7], 'scanners need the quiet zone — off here for contrast');
}

import { Document } from '../../src/index.js';
import { buildPngRgb } from './build-embed-images.js';
import { buildTablePdf, buildTwoPageTablePdf, hline, text, vline } from './build-table-pdf.js';

/** Transcribe the text and positions from Go TestWriteXlsxFullPage. Add the
 * same raster on both pages to exercise workbook-wide image relationships. */
export function buildXlsxPageDoc(): Document {
  const doc = Document.Open(buildTwoPageTablePdf(
    text(60, 740, 'Report Title', 16) + text(60, 700, 'Revenue', 11) + text(300, 700, '1200', 11),
    text(60, 700, 'Second page', 11),
  ));
  for (const page of doc.Pages) {
    page.MediaBox = [0, 0, 595, 842];
    page.AddImage(buildPngRgb(), [60, 600, 36, 18]);
  }
  return doc;
}

/** Go TestWriteXlsxTablesOnly's three columns and merged total label. */
export function buildXlsxGoTable(): Document {
  const xs = [20, 160, 240, 340], ys = [260, 220, 180, 140, 100];
  let stream = ys.map(y => hline(20, 340, y)).join('')
    + xs.map((x, i) => vline(x, i === 1 ? 140 : 100, 260)).join('');
  const values = [['Item', 'Qty', 'Price'], ['Apples', '3', '€4.50'],
    ['Pears', '2', '€5.25'], ['Total', '', '€9.75']];
  values.forEach((row, r) => row.forEach((value, c) => {
    if (value) stream += text(xs[c] + 4, ys[r] - 18, value).replace('€', '\\200');
  }));
  const doc = Document.Open(buildTablePdf(stream));
  doc.Pages[0].MediaBox = [0, 0, 400, 300];
  return doc;
}

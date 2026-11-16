import { Document } from '../../src/document.js';
import { buildSvgPdf } from './build-svg-fixtures.js';

/** Different page shapes and ink make wrong ordering and blank renders visible. */
export function buildThumbnails(): Document {
  const doc = Document.New();
  for (const [width, height, color] of [
    [120, 240, '1 0 0'], [240, 120, '0 0 1'], [10, 5, '0 1 0'],
  ] as const) {
    doc.AddPage(Document.Open(buildSvgPdf({
      mediaBox: [0, 0, width, height],
      content: `${color} rg 0 0 ${width / 2} ${height} re f`,
    })).Pages[0]);
  }
  return doc;
}

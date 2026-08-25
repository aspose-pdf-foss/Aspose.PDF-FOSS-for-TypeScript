const enc = (s: string) => new TextEncoder().encode(s);
const byteLen = (s: string) => enc(s).length;

/** One page with all five boundary boxes distinct and simple text content
 *  ("(X) Tj"), for Resize/Scale geometry tests:
 *    MediaBox [0 0 200 100]  CropBox [10 10 190 90]
 *    BleedBox [5 5 195 95]   TrimBox [20 20 180 80]   ArtBox [25 25 175 75]
 *  Object layout: 1 Catalog, 2 Pages, 3 Page, 4 Contents, 5 Font. */
export function buildGeometryPdf(): Uint8Array {
  const content = `BT /F1 12 Tf 10 40 Td (X) Tj ET`;
  const objects: string[] = [];
  objects[1] = `<< /Type /Catalog /Pages 2 0 R >>`;
  objects[2] = `<< /Type /Pages /Count 1 /Kids [3 0 R] >>`;
  objects[3] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 100] /CropBox [10 10 190 90]` +
    ` /BleedBox [5 5 195 95] /TrimBox [20 20 180 80] /ArtBox [25 25 175 75]` +
    ` /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>`;
  objects[4] = `<< /Length ${byteLen(content)} >>\nstream\n${content}\nendstream`;
  objects[5] = `<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>`;
  const maxObj = 5;

  let body = '%PDF-1.7\n%\xE2\xE3\xCF\xD3\n';
  const offsets: number[] = new Array(maxObj + 1).fill(0);
  for (let n = 1; n <= maxObj; n++) {
    offsets[n] = byteLen(body);
    body += `${n} 0 obj\n${objects[n]}\nendobj\n`;
  }
  const xrefOffset = byteLen(body);
  let xref = `xref\n0 ${maxObj + 1}\n0000000000 65535 f \n`;
  for (let n = 1; n <= maxObj; n++) xref += `${String(offsets[n]).padStart(10, '0')} 00000 n \n`;
  const trailer = `trailer\n<< /Size ${maxObj + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return enc(body + xref + trailer);
}

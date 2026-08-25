const enc = (s: string) => new TextEncoder().encode(s);
const byteLen = (s: string) => enc(s).length;

function assemble(objects: string[], maxObj: number, rootNum: number): Uint8Array {
  let body = '%PDF-1.7\n%\xE2\xE3\xCF\xD3\n';
  const offsets: number[] = new Array(maxObj + 1).fill(0);
  for (let n = 1; n <= maxObj; n++) {
    offsets[n] = byteLen(body);
    body += `${n} 0 obj\n${objects[n]}\nendobj\n`;
  }
  const xrefOffset = byteLen(body);
  let xref = `xref\n0 ${maxObj + 1}\n0000000000 65535 f \n`;
  for (let n = 1; n <= maxObj; n++) xref += `${String(offsets[n]).padStart(10, '0')} 00000 n \n`;
  const trailer = `trailer\n<< /Size ${maxObj + 1} /Root ${rootNum} 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return enc(body + xref + trailer);
}

/** One page, MediaBox/CropBox [0 0 200 100], a /Font /F1 resource, content that
 *  shows "Hi". `rotate` (default 0) sets /Rotate on the page. */
export function buildComposeSource(rotate = 0): Uint8Array {
  const content = `BT /F1 12 Tf 10 40 Td (Hi) Tj ET`;
  const rot = rotate ? ` /Rotate ${rotate}` : '';
  const objects: string[] = [];
  objects[1] = `<< /Type /Catalog /Pages 2 0 R >>`;
  objects[2] = `<< /Type /Pages /Count 1 /Kids [3 0 R] >>`;
  objects[3] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 100] /CropBox [0 0 200 100]` +
    `${rot} /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>`;
  objects[4] = `<< /Length ${byteLen(content)} >>\nstream\n${content}\nendstream`;
  objects[5] = `<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>`;
  return assemble(objects, 5, 1);
}

/** One blank page (no /Contents), MediaBox [0 0 300 300] — an import target. */
export function buildComposeTarget(): Uint8Array {
  const objects: string[] = [];
  objects[1] = `<< /Type /Catalog /Pages 2 0 R >>`;
  objects[2] = `<< /Type /Pages /Count 1 /Kids [3 0 R] /MediaBox [0 0 300 300] >>`;
  objects[3] = `<< /Type /Page /Parent 2 0 R >>`;
  return assemble(objects, 3, 1);
}

/** One page with existing content showing "TARGET", MediaBox/CropBox
 *  [0 0 300 300] — a stamp target whose content must be preserved. */
export function buildComposeTargetWithContent(): Uint8Array {
  const content = `BT /F1 12 Tf 10 10 Td (TARGET) Tj ET`;
  const objects: string[] = [];
  objects[1] = `<< /Type /Catalog /Pages 2 0 R >>`;
  objects[2] = `<< /Type /Pages /Count 1 /Kids [3 0 R] >>`;
  objects[3] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 300] /CropBox [0 0 300 300]` +
    ` /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>`;
  objects[4] = `<< /Length ${byteLen(content)} >>\nstream\n${content}\nendstream`;
  objects[5] = `<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>`;
  return assemble(objects, 5, 1);
}

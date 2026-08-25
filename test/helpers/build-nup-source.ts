const enc = (s: string) => new TextEncoder().encode(s);
const byteLen = (s: string) => enc(s).length;

/** A classic-xref PDF of `n` pages, each MediaBox/CropBox [0 0 200 100], sharing
 *  one Helvetica font, whose content shows "P1".."Pn" — a source for N-up
 *  imposition tests. Object layout: 1 Catalog, 2 Pages, 3 Font, then per page i
 *  (0-based) a page dict at 4+2i and its content stream at 5+2i. */
export function buildNUpSource(n: number): Uint8Array {
  const objects: string[] = [];
  objects[1] = `<< /Type /Catalog /Pages 2 0 R >>`;
  const kids: string[] = [];
  for (let i = 0; i < n; i++) kids.push(`${4 + i * 2} 0 R`);
  objects[2] = `<< /Type /Pages /Count ${n} /Kids [${kids.join(' ')}] >>`;
  objects[3] = `<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>`;
  for (let i = 0; i < n; i++) {
    const content = `BT /F1 12 Tf 10 40 Td (P${i + 1}) Tj ET`;
    objects[4 + i * 2] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 100] /CropBox [0 0 200 100]` +
      ` /Resources << /Font << /F1 3 0 R >> >> /Contents ${5 + i * 2} 0 R >>`;
    objects[5 + i * 2] = `<< /Length ${byteLen(content)} >>\nstream\n${content}\nendstream`;
  }
  const maxObj = 3 + n * 2;

  let body = '%PDF-1.7\n%\xE2\xE3\xCF\xD3\n';
  const offsets: number[] = new Array(maxObj + 1).fill(0);
  for (let m = 1; m <= maxObj; m++) {
    offsets[m] = byteLen(body);
    body += `${m} 0 obj\n${objects[m]}\nendobj\n`;
  }
  const xrefOffset = byteLen(body);
  let xref = `xref\n0 ${maxObj + 1}\n0000000000 65535 f \n`;
  for (let m = 1; m <= maxObj; m++) xref += `${String(offsets[m]).padStart(10, '0')} 00000 n \n`;
  const trailer = `trailer\n<< /Size ${maxObj + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return enc(body + xref + trailer);
}

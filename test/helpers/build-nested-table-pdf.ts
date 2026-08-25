const enc = (s: string) => new TextEncoder().encode(s);
const byteLen = (s: string) => enc(s).length;

/** One-page tagged PDF: a 2×2 outer /Table whose bottom-right TD contains a
 *  2×2 nested /Table, whose bottom-left TD in turn contains a 1×1 /Table ("G")
 *  — two levels of nesting in one branch. Leaf cells carry MCIDs 0..6:
 *  0 A, 1 B, 2 C (outer); 3 D, 4 E, 5 F (nested); 6 G (deep). Container cells
 *  (outer bottom-right, nested bottom-left) have no MCID. */
export function buildNestedTablePdf(): Uint8Array {
  const cell = (mcid: number, x: number, y: number, text: string) =>
    `/TD <</MCID ${mcid}>> BDC\nBT /F1 12 Tf ${x} ${y} Td (${text}) Tj ET\nEMC\n`;
  const content =
    cell(0, 50, 340, 'A') +
    cell(1, 150, 340, 'B') +
    cell(2, 50, 300, 'C') +
    cell(3, 160, 280, 'D') +
    cell(4, 240, 280, 'E') +
    cell(5, 240, 250, 'F') +
    cell(6, 160, 250, 'G');

  const objects: string[] = [];
  objects[1] = `<< /Type /Catalog /Pages 2 0 R /StructTreeRoot 6 0 R /MarkInfo << /Marked true >> /Lang (en-US) >>`;
  objects[2] = `<< /Type /Pages /Count 1 /Kids [3 0 R] /MediaBox [0 0 400 400] >>`;
  objects[3] = `<< /Type /Page /Parent 2 0 R /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> /StructParents 0 >>`;
  objects[4] = `<< /Length ${byteLen(content)} >>\nstream\n${content}endstream`;
  objects[5] = `<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>`;
  objects[6] = `<< /Type /StructTreeRoot /K [7 0 R] /ParentTree 8 0 R >>`;
  // Outer table (2x2)
  objects[7] = `<< /Type /StructElem /S /Table /P 6 0 R /Pg 3 0 R /K [9 0 R 10 0 R] >>`;
  objects[8] = `<< /Nums [0 [11 0 R 12 0 R 13 0 R 18 0 R 19 0 R 21 0 R 24 0 R]] >>`;
  objects[9] = `<< /Type /StructElem /S /TR /P 7 0 R /K [11 0 R 12 0 R] >>`;
  objects[10] = `<< /Type /StructElem /S /TR /P 7 0 R /K [13 0 R 14 0 R] >>`;
  objects[11] = `<< /Type /StructElem /S /TD /P 9 0 R /Pg 3 0 R /K 0 >>`;
  objects[12] = `<< /Type /StructElem /S /TD /P 9 0 R /Pg 3 0 R /K 1 >>`;
  objects[13] = `<< /Type /StructElem /S /TD /P 10 0 R /Pg 3 0 R /K 2 >>`;
  objects[14] = `<< /Type /StructElem /S /TD /P 10 0 R /K [15 0 R] >>`;   // container
  // Nested table (inside TD 14)
  objects[15] = `<< /Type /StructElem /S /Table /P 14 0 R /Pg 3 0 R /K [16 0 R 17 0 R] >>`;
  objects[16] = `<< /Type /StructElem /S /TR /P 15 0 R /K [18 0 R 19 0 R] >>`;
  objects[17] = `<< /Type /StructElem /S /TR /P 15 0 R /K [20 0 R 21 0 R] >>`;
  objects[18] = `<< /Type /StructElem /S /TD /P 16 0 R /Pg 3 0 R /K 3 >>`;
  objects[19] = `<< /Type /StructElem /S /TD /P 16 0 R /Pg 3 0 R /K 4 >>`;
  objects[20] = `<< /Type /StructElem /S /TD /P 17 0 R /K [22 0 R] >>`;   // container
  objects[21] = `<< /Type /StructElem /S /TD /P 17 0 R /Pg 3 0 R /K 5 >>`;
  // Deep table (inside TD 20)
  objects[22] = `<< /Type /StructElem /S /Table /P 20 0 R /Pg 3 0 R /K [23 0 R] >>`;
  objects[23] = `<< /Type /StructElem /S /TR /P 22 0 R /K [24 0 R] >>`;
  objects[24] = `<< /Type /StructElem /S /TD /P 23 0 R /Pg 3 0 R /K 6 >>`;
  const maxObj = 24;

  let body = '%PDF-1.7\n%\xE2\xE3\xCF\xD3\n';
  const offsets: number[] = new Array(maxObj + 1).fill(0);
  for (let n = 1; n <= maxObj; n++) {
    if (objects[n] === undefined) continue;
    offsets[n] = byteLen(body);
    body += `${n} 0 obj\n${objects[n]}\nendobj\n`;
  }
  const xrefOffset = byteLen(body);
  let xref = `xref\n0 ${maxObj + 1}\n0000000000 65535 f \n`;
  for (let n = 1; n <= maxObj; n++) {
    xref += offsets[n]
      ? `${String(offsets[n]).padStart(10, '0')} 00000 n \n`
      : `0000000000 00000 f \n`;
  }
  const trailer = `trailer\n<< /Size ${maxObj + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return enc(body + xref + trailer);
}

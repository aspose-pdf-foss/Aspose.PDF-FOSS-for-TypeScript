// build-tagged-pdf.ts keeps these two as file-local consts rather than sharing
// a helper module; the idiom is copied rather than an import invented.
const enc = (s: string) => new TextEncoder().encode(s);
const byteLen = (s: string) => enc(s).length;

/** A tagged document whose structure tree root holds THREE top-level children
 *  and no /Document element.
 *
 *  `buildTaggedPdf` already has a single /Document child, so it satisfies
 *  ISO 14289-2 8.2.5.2-1 by accident and cannot see that rule or
 *  `documentElementPass`'s wrapping branch at all. This fixture is the only
 *  shape in the suite that does.
 *
 *  Its three paragraphs draw "One", "Two", "Three" in that order, so a
 *  re-parenting that permutes them is visible in GetText(). */
export function buildMultiRootPdf(): Uint8Array {
  const content =
    '/P <</MCID 0>> BDC\nBT /F1 12 Tf 50 350 Td (One) Tj ET\nEMC\n' +
    '/P <</MCID 1>> BDC\nBT /F1 12 Tf 50 320 Td (Two) Tj ET\nEMC\n' +
    '/P <</MCID 2>> BDC\nBT /F1 12 Tf 50 290 Td (Three) Tj ET\nEMC\n';

  const objects: string[] = [];
  objects[1] = `<< /Type /Catalog /Pages 2 0 R /StructTreeRoot 7 0 R /MarkInfo << /Marked true >> /Lang (en-US) >>`;
  objects[2] = `<< /Type /Pages /Count 1 /Kids [3 0 R] /MediaBox [0 0 400 400] >>`;
  objects[3] = `<< /Type /Page /Parent 2 0 R /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> /StructParents 0 >>`;
  objects[4] = `<< /Length ${byteLen(content)} >>\nstream\n${content}endstream`;
  objects[5] = `<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>`;
  objects[6] = `<< /Nums [0 [8 0 R 9 0 R 10 0 R]] >>`;
  objects[7] = `<< /Type /StructTreeRoot /K [8 0 R 9 0 R 10 0 R] /ParentTree 6 0 R >>`;
  objects[8] = `<< /Type /StructElem /S /P /P 7 0 R /Pg 3 0 R /K 0 >>`;
  objects[9] = `<< /Type /StructElem /S /P /P 7 0 R /Pg 3 0 R /K 1 >>`;
  objects[10] = `<< /Type /StructElem /S /P /P 7 0 R /Pg 3 0 R /K 2 >>`;
  const maxObj = 10;

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

const enc = (s: string) => new TextEncoder().encode(s);
const byteLen = (s: string) => enc(s).length;

/** One-page classic-xref tagged PDF.
 *
 *  Catalog carries /StructTreeRoot, /MarkInfo << /Marked true >>, /Lang (en-US).
 *  Page content has two marked-content sequences: MCID 0 ("Hello Heading"),
 *  MCID 1 ("Body paragraph"). Structure tree:
 *    Document (8)
 *      H1 via RoleMap MyHead->SubHead->H2 (9), /Pg 3, /K 0, /T, /Lang en-GB
 *      P (10), /Pg 3, /K 1, /ActualText
 *      Figure (11), /Pg 3, /Alt, /K << /Type /OBJR /Obj 6 >>
 *  RoleMap also has a Loop1<->Loop2 cycle to exercise the cycle guard.
 *  ParentTree maps page key 0 -> [9 10] (by MCID) and object key 1 -> 11. */
export function buildTaggedPdf(): Uint8Array {
  const content =
    '/P <</MCID 0>> BDC\nBT /F1 24 Tf 50 350 Td (Hello Heading) Tj ET\nEMC\n' +
    '/P <</MCID 1>> BDC\nBT /F1 12 Tf 50 300 Td (Body paragraph) Tj ET\nEMC\n';

  const objects: string[] = [];
  objects[1] = `<< /Type /Catalog /Pages 2 0 R /StructTreeRoot 7 0 R /MarkInfo << /Marked true >> /Lang (en-US) >>`;
  objects[2] = `<< /Type /Pages /Count 1 /Kids [3 0 R] /MediaBox [0 0 400 400] >>`;
  objects[3] = `<< /Type /Page /Parent 2 0 R /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> /StructParents 0 /Annots [6 0 R] >>`;
  objects[4] = `<< /Length ${byteLen(content)} >>\nstream\n${content}endstream`;
  objects[5] = `<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>`;
  objects[6] = `<< /Type /Annot /Subtype /Link /Rect [50 100 150 150] /StructParent 1 >>`;
  objects[7] = `<< /Type /StructTreeRoot /K [8 0 R] /RoleMap << /MyHead /SubHead /SubHead /H2 /Loop1 /Loop2 /Loop2 /Loop1 >> /ParentTree 12 0 R >>`;
  objects[8] = `<< /Type /StructElem /S /Document /P 7 0 R /K [9 0 R 10 0 R 11 0 R] >>`;
  objects[9] = `<< /Type /StructElem /S /MyHead /P 8 0 R /Pg 3 0 R /K 0 /T (Heading One) /Lang (en-GB) >>`;
  objects[10] = `<< /Type /StructElem /S /P /P 8 0 R /Pg 3 0 R /K 1 /ActualText (Body paragraph actual) >>`;
  objects[11] = `<< /Type /StructElem /S /Figure /P 8 0 R /Pg 3 0 R /Alt (A descriptive figure) /K << /Type /OBJR /Obj 6 0 R >> >>`;
  objects[12] = `<< /Nums [0 [9 0 R 10 0 R] 1 11 0 R] >>`;
  const maxObj = 12;

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

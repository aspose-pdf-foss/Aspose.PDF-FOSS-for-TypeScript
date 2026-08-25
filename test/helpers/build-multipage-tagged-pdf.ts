const enc = (s: string) => new TextEncoder().encode(s);
const byteLen = (s: string) => enc(s).length;

/** Two-page classic-xref tagged PDF. See the S2 plan (Task 1) for the full tree
 *  shape: Document(8) -> [Sect(13) spanning both pages, Figure(14) on page 1].
 *  Sect(13) -> [P(10) on page 1, P(11) on page 2]. Figure(14) has an OBJR to a
 *  Link annot(9) on page 1. RoleMap MyHead->H2; ParentTree 0->[10], 1->[11],
 *  2->14 (object key for the annot). */
export function buildMultiPageTaggedPdf(): Uint8Array {
  const page1 =
    '/P <</MCID 0>> BDC\nBT /F1 12 Tf 50 350 Td (Page one body) Tj ET\nEMC\n';
  const page2 =
    '/P <</MCID 0>> BDC\nBT /F1 12 Tf 50 350 Td (Page two body) Tj ET\nEMC\n';

  const o: string[] = [];
  o[1] = `<< /Type /Catalog /Pages 2 0 R /StructTreeRoot 7 0 R /MarkInfo << /Marked true >> /Lang (en-US) >>`;
  o[2] = `<< /Type /Pages /Count 2 /Kids [3 0 R 4 0 R] /MediaBox [0 0 400 400] >>`;
  o[3] = `<< /Type /Page /Parent 2 0 R /Contents 5 0 R /Resources << /Font << /F1 15 0 R >> >> /StructParents 0 /Annots [9 0 R] >>`;
  o[4] = `<< /Type /Page /Parent 2 0 R /Contents 6 0 R /Resources << /Font << /F1 15 0 R >> >> /StructParents 1 >>`;
  o[5] = `<< /Length ${byteLen(page1)} >>\nstream\n${page1}endstream`;
  o[6] = `<< /Length ${byteLen(page2)} >>\nstream\n${page2}endstream`;
  o[7] = `<< /Type /StructTreeRoot /K [8 0 R] /RoleMap << /MyHead /H2 >> /ParentTree 12 0 R >>`;
  o[8] = `<< /Type /StructElem /S /Document /P 7 0 R /K [13 0 R 14 0 R] >>`;
  o[9] = `<< /Type /Annot /Subtype /Link /Rect [50 100 150 150] /StructParent 2 >>`;
  o[10] = `<< /Type /StructElem /S /P /P 13 0 R /Pg 3 0 R /K 0 >>`;
  o[11] = `<< /Type /StructElem /S /P /P 13 0 R /Pg 4 0 R /K 0 >>`;
  o[12] = `<< /Nums [0 [10 0 R] 1 [11 0 R] 2 14 0 R] >>`;
  o[13] = `<< /Type /StructElem /S /Sect /P 8 0 R /K [10 0 R 11 0 R] >>`;
  o[14] = `<< /Type /StructElem /S /Figure /P 8 0 R /Pg 3 0 R /Alt (A figure) /K << /Type /OBJR /Obj 9 0 R >> >>`;
  o[15] = `<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>`;
  const maxObj = 15;

  let body = '%PDF-1.7\n%\xE2\xE3\xCF\xD3\n';
  const offsets: number[] = new Array(maxObj + 1).fill(0);
  for (let n = 1; n <= maxObj; n++) {
    offsets[n] = byteLen(body);
    body += `${n} 0 obj\n${o[n]}\nendobj\n`;
  }
  const xrefOffset = byteLen(body);
  let xref = `xref\n0 ${maxObj + 1}\n0000000000 65535 f \n`;
  for (let n = 1; n <= maxObj; n++) xref += `${String(offsets[n]).padStart(10, '0')} 00000 n \n`;
  const trailer = `trailer\n<< /Size ${maxObj + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return enc(body + xref + trailer);
}

/** One-page tagged PDF whose RoleMap maps MyHead -> H3 (conflicts with the
 *  multi-page fixture's MyHead -> H2) and has a MyHead element using it. */
export function buildRoleConflictTaggedPdf(): Uint8Array {
  const content = '/P <</MCID 0>> BDC\nBT /F1 12 Tf 50 350 Td (Conflict head) Tj ET\nEMC\n';
  const o: string[] = [];
  o[1] = `<< /Type /Catalog /Pages 2 0 R /StructTreeRoot 7 0 R /MarkInfo << /Marked true >> >>`;
  o[2] = `<< /Type /Pages /Count 1 /Kids [3 0 R] /MediaBox [0 0 400 400] >>`;
  o[3] = `<< /Type /Page /Parent 2 0 R /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> /StructParents 0 >>`;
  o[4] = `<< /Length ${byteLen(content)} >>\nstream\n${content}endstream`;
  o[5] = `<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>`;
  o[7] = `<< /Type /StructTreeRoot /K [8 0 R] /RoleMap << /MyHead /H3 >> /ParentTree 12 0 R >>`;
  o[8] = `<< /Type /StructElem /S /Document /P 7 0 R /K [9 0 R] >>`;
  o[9] = `<< /Type /StructElem /S /MyHead /P 8 0 R /Pg 3 0 R /K 0 >>`;
  o[12] = `<< /Nums [0 [9 0 R]] >>`;
  const maxObj = 12;

  let body = '%PDF-1.7\n%\xE2\xE3\xCF\xD3\n';
  const offsets: number[] = new Array(maxObj + 1).fill(0);
  for (let n = 1; n <= maxObj; n++) { if (!o[n]) continue; offsets[n] = byteLen(body); body += `${n} 0 obj\n${o[n]}\nendobj\n`; }
  const xrefOffset = byteLen(body);
  let xref = `xref\n0 ${maxObj + 1}\n0000000000 65535 f \n`;
  for (let n = 1; n <= maxObj; n++) xref += o[n] ? `${String(offsets[n]).padStart(10, '0')} 00000 n \n` : `0000000000 65535 f \n`;
  const trailer = `trailer\n<< /Size ${maxObj + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return enc(body + xref + trailer);
}

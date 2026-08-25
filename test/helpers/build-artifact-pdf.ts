const enc = (s: string) => new TextEncoder().encode(s);
const byteLen = (s: string) => enc(s).length;

/** One-page tagged PDF with three text runs in the content stream:
 *  - MCID 0 ("Tagged") inside /P <</MCID 0>> BDC … EMC
 *  - "Header" inside /Artifact BDC … EMC
 *  - "Loose" with no marked-content wrapper (untagged real content)
 *  Struct tree: Document(8) > P(9) /Pg 3 /K 0. ParentTree key 0 -> [9]. */
export function buildArtifactPdf(): Uint8Array {
  const content =
    '/P <</MCID 0>> BDC\nBT /F1 12 Tf 50 350 Td (Tagged) Tj ET\nEMC\n' +
    '/Artifact BDC\nBT /F1 12 Tf 50 320 Td (Header) Tj ET\nEMC\n' +
    'BT /F1 12 Tf 50 290 Td (Loose) Tj ET\n';

  const objects: string[] = [];
  objects[1] = `<< /Type /Catalog /Pages 2 0 R /StructTreeRoot 7 0 R /MarkInfo << /Marked true >> /Lang (en-US) /ViewerPreferences << /DisplayDocTitle true >> >>`;
  objects[2] = `<< /Type /Pages /Count 1 /Kids [3 0 R] /MediaBox [0 0 400 400] >>`;
  objects[3] = `<< /Type /Page /Parent 2 0 R /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> /StructParents 0 >>`;
  objects[4] = `<< /Length ${byteLen(content)} >>\nstream\n${content}endstream`;
  objects[5] = `<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>`;
  objects[6] = `<< /Title (Artifact Fixture) >>`;
  objects[7] = `<< /Type /StructTreeRoot /K [8 0 R] /ParentTree 12 0 R >>`;
  objects[8] = `<< /Type /StructElem /S /Document /P 7 0 R /K [9 0 R] >>`;
  objects[9] = `<< /Type /StructElem /S /P /P 8 0 R /Pg 3 0 R /K 0 >>`;
  objects[12] = `<< /Nums [0 [9 0 R]] >>`;
  const maxObj = 12;

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
    xref += objects[n] === undefined
      ? `0000000000 00000 f \n`
      : `${String(offsets[n]).padStart(10, '0')} 00000 n \n`;
  }
  const trailer = `trailer\n<< /Size ${maxObj + 1} /Root 1 0 R /Info 6 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return enc(body + xref + trailer);
}

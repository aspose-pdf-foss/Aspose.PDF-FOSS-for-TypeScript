// One tagged page carrying the three marked-content shapes nothing this library
// authors produces, each holding a paragraph of TEXT so a structure element's
// text can be read back:
//
//   P "named <word>"  — MCID 0 through a NAMED property list (/P /MC0 BDC)
//   P "nested <word>" — MCID 1 inside a nested Form XObject (/Fm0)
//   P "inline <word>" — MCID 2 inline, on an element with NO /Pg of its own:
//                       it inherits the page from its parent Sect
//
// Written for CompareSideBySide's tagged output (aq4a.7), which renumbers the
// right page's MCIDs: every one of these is a route an MCID can take that the
// renumbering has to reach, and AddMarkdown's output reaches none of them.

const enc = (s: string) => new TextEncoder().encode(s);
const byteLen = (s: string) => enc(s).length;

function assemble(objects: string[], maxObj: number): Uint8Array {
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

function streamObj(content: string, extra = ''): string {
  return `<< ${extra} /Length ${byteLen(content)} >>\nstream\n${content}\nendstream`;
}

export function buildTaggedMcShapesPdf(word: string): Uint8Array {
  const page = [
    `/P /MC0 BDC BT /F1 12 Tf 20 160 Td (named ${word}) Tj ET EMC`,
    'q 1 0 0 1 20 120 cm /Fm0 Do Q',
    `/P << /MCID 2 >> BDC BT /F1 12 Tf 20 80 Td (inline ${word}) Tj ET EMC`,
  ].join('\n');
  const form = `/P << /MCID 1 >> BDC BT /F1 12 Tf 0 0 Td (nested ${word}) Tj ET EMC`;
  const objects: string[] = [];
  objects[1] = '<< /Type /Catalog /Pages 2 0 R /StructTreeRoot 7 0 R /MarkInfo << /Marked true >> >>';
  objects[2] = '<< /Type /Pages /Count 1 /Kids [3 0 R] /MediaBox [0 0 200 200] >>';
  objects[3] = '<< /Type /Page /Parent 2 0 R /StructParents 0 /Resources << /Font << /F1 6 0 R >> '
    + '/XObject << /Fm0 5 0 R >> /Properties << /MC0 << /MCID 0 >> >> >> /Contents 4 0 R >>';
  objects[4] = streamObj(page);
  objects[5] = streamObj(form, '/Type /XObject /Subtype /Form /BBox [0 0 150 30] /Resources << /Font << /F1 6 0 R >> >>');
  objects[6] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>';
  objects[7] = '<< /Type /StructTreeRoot /K [8 0 R] /ParentTree 12 0 R /ParentTreeNextKey 1 >>';
  // The Sect owns the /Pg; none of its paragraphs states one.
  objects[8] = '<< /Type /StructElem /S /Sect /P 7 0 R /Pg 3 0 R /K [9 0 R 10 0 R 11 0 R] >>';
  objects[9] = '<< /Type /StructElem /S /P /P 8 0 R /K 0 >>';
  objects[10] = '<< /Type /StructElem /S /P /P 8 0 R /K 1 >>';
  objects[11] = '<< /Type /StructElem /S /P /P 8 0 R /K 2 >>';
  objects[12] = '<< /Nums [0 [9 0 R 10 0 R 11 0 R]] >>';
  return assemble(objects, 12);
}

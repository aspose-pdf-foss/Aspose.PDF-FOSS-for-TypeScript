const enc = (s: string) => new TextEncoder().encode(s);
const byteLen = (s: string) => enc(s).length;

/** One-page classic-xref tagged PDF containing a single /Table.
 *
 *  3 columns × 4 rows. THead has one row (TH "Name" id h1 scope Column;
 *  TH "Info" id h2 scope Column colSpan 2). TBody has three rows; "Bob" spans
 *  two rows. "Alice" has /Headers [h1]. The table carries /Summary. The "NYC"
 *  cell has a /Layout /BBox; every other cell's quad comes from glyph union.
 *  MCIDs 0..9 map to the ten cells in reading order via /ParentTree key 0. */
export function buildTaggedTablePdf(): Uint8Array {
  const cell = (mcid: number, tag: string, x: number, y: number, text: string) =>
    `/${tag} <</MCID ${mcid}>> BDC\nBT /F1 12 Tf ${x} ${y} Td (${text}) Tj ET\nEMC\n`;
  const content =
    cell(0, 'TH', 50, 340, 'Name') +
    cell(1, 'TH', 150, 340, 'Info') +
    cell(2, 'TD', 50, 315, 'Alice') +
    cell(3, 'TD', 150, 315, '30') +
    cell(4, 'TD', 250, 315, 'NYC') +
    cell(5, 'TD', 50, 290, 'Bob') +
    cell(6, 'TD', 150, 290, '25') +
    cell(7, 'TD', 250, 290, 'LA') +
    cell(8, 'TD', 150, 265, '40') +
    cell(9, 'TD', 250, 265, 'SF');

  const objects: string[] = [];
  objects[1] = `<< /Type /Catalog /Pages 2 0 R /StructTreeRoot 6 0 R /MarkInfo << /Marked true >> /Lang (en-US) >>`;
  objects[2] = `<< /Type /Pages /Count 1 /Kids [3 0 R] /MediaBox [0 0 400 400] >>`;
  objects[3] = `<< /Type /Page /Parent 2 0 R /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> /StructParents 0 >>`;
  objects[4] = `<< /Length ${byteLen(content)} >>\nstream\n${content}endstream`;
  objects[5] = `<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>`;
  objects[6] = `<< /Type /StructTreeRoot /K [7 0 R] /ParentTree 8 0 R >>`;
  // Table + sections
  objects[7] = `<< /Type /StructElem /S /Table /P 6 0 R /Pg 3 0 R /K [9 0 R 10 0 R] /A << /O /Table /Summary (Employee directory) >> >>`;
  objects[9] = `<< /Type /StructElem /S /THead /P 7 0 R /K [11 0 R] >>`;
  objects[10] = `<< /Type /StructElem /S /TBody /P 7 0 R /K [12 0 R 13 0 R 14 0 R] >>`;
  // Rows
  objects[11] = `<< /Type /StructElem /S /TR /P 9 0 R /K [15 0 R 16 0 R] >>`;
  objects[12] = `<< /Type /StructElem /S /TR /P 10 0 R /K [17 0 R 18 0 R 19 0 R] >>`;
  objects[13] = `<< /Type /StructElem /S /TR /P 10 0 R /K [20 0 R 21 0 R 22 0 R] >>`;
  objects[14] = `<< /Type /StructElem /S /TR /P 10 0 R /K [23 0 R 24 0 R] >>`;
  // Header cells
  objects[15] = `<< /Type /StructElem /S /TH /P 11 0 R /Pg 3 0 R /K 0 /ID (h1) /A << /O /Table /Scope /Column >> >>`;
  objects[16] = `<< /Type /StructElem /S /TH /P 11 0 R /Pg 3 0 R /K 1 /ID (h2) /A << /O /Table /Scope /Column /ColSpan 2 >> >>`;
  // Body row 1
  objects[17] = `<< /Type /StructElem /S /TD /P 12 0 R /Pg 3 0 R /K 2 /A << /O /Table /Headers [(h1)] >> >>`;
  objects[18] = `<< /Type /StructElem /S /TD /P 12 0 R /Pg 3 0 R /K 3 >>`;
  objects[19] = `<< /Type /StructElem /S /TD /P 12 0 R /Pg 3 0 R /K 4 /A << /O /Layout /BBox [250 312 285 328] >> >>`;
  // Body row 2 ("Bob" rowSpan 2)
  objects[20] = `<< /Type /StructElem /S /TD /P 13 0 R /Pg 3 0 R /K 5 /A << /O /Table /RowSpan 2 >> >>`;
  objects[21] = `<< /Type /StructElem /S /TD /P 13 0 R /Pg 3 0 R /K 6 >>`;
  objects[22] = `<< /Type /StructElem /S /TD /P 13 0 R /Pg 3 0 R /K 7 >>`;
  // Body row 3 (col 0 occupied by Bob's rowSpan)
  objects[23] = `<< /Type /StructElem /S /TD /P 14 0 R /Pg 3 0 R /K 8 >>`;
  objects[24] = `<< /Type /StructElem /S /TD /P 14 0 R /Pg 3 0 R /K 9 >>`;
  // ParentTree: page StructParents key 0 -> cell elems by MCID 0..9
  objects[8] = `<< /Nums [0 [15 0 R 16 0 R 17 0 R 18 0 R 19 0 R 20 0 R 21 0 R 22 0 R 23 0 R 24 0 R]] >>`;
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

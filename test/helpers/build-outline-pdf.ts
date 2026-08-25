const enc = (s: string) => new TextEncoder().encode(s);
const byteLen = (s: string) => enc(s).length;

/** Three-page classic-xref PDF with a nested outline exercising every
 *  destination form:
 *    Chapter 1 (explicit /Dest [page1 /XYZ null 780 null])
 *      Section 1.1 (/A /GoTo /D [page2 /Fit])
 *    Chapter 2 (/Dest (chap2) -> /Names /Dests name tree -> page3 /Fit)
 *    Chapter 3 (/Dest /chap3  -> legacy catalog /Dests dict -> page2 /Fit)
 *  Object layout: 1 Catalog, 2 Pages, 3-5 Pages, 6 /Outlines root,
 *  7 Chapter 1, 8 Section 1.1, 9 Chapter 2, 10 Chapter 3,
 *  11 /Names /Dests leaf, 12 legacy /Dests dict. */
export function buildOutlinePdf(): Uint8Array {
  const objects: string[] = [];
  objects[1] = `<< /Type /Catalog /Pages 2 0 R /Outlines 6 0 R /Names << /Dests 11 0 R >> /Dests 12 0 R >>`;
  objects[2] = `<< /Type /Pages /Count 3 /Kids [3 0 R 4 0 R 5 0 R] >>`;
  objects[3] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >>`;
  objects[4] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >>`;
  objects[5] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >>`;
  objects[6] = `<< /Type /Outlines /First 7 0 R /Last 10 0 R /Count 4 >>`;
  objects[7] = `<< /Title (Chapter 1) /Parent 6 0 R /Next 9 0 R /First 8 0 R /Last 8 0 R /Count 1 /Dest [3 0 R /XYZ null 780 null] >>`;
  objects[8] = `<< /Title (Section 1.1) /Parent 7 0 R /A << /S /GoTo /D [4 0 R /Fit] >> >>`;
  objects[9] = `<< /Title (Chapter 2) /Parent 6 0 R /Prev 7 0 R /Next 10 0 R /Dest (chap2) >>`;
  objects[10] = `<< /Title (Chapter 3) /Parent 6 0 R /Prev 9 0 R /Dest /chap3 >>`;
  objects[11] = `<< /Names [(chap2) [5 0 R /Fit]] >>`;
  objects[12] = `<< /chap3 [4 0 R /Fit] >>`;
  const maxObj = 12;

  let body = '%PDF-1.7\n%\xe2\xe3\xcf\xd3\n';
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

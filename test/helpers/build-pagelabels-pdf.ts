const enc = (s: string) => new TextEncoder().encode(s);
const byteLen = (s: string) => enc(s).length;

/** Seven-page classic-xref PDF whose /Root /PageLabels number tree carries three
 *  ascending ranges, exercising style/prefix/start:
 *    0 → << /S /r >>            lowercase roman  : i, ii, iii        (pages 0-2)
 *    3 → << /S /D /St 1 >>      decimal from 1   : 1, 2             (pages 3-4)
 *    5 → << /S /D /P (A-) >>    "A-" + decimal   : A-1, A-2         (pages 5-6)
 *  The number tree is a /Kids node over two leaves so the reader's recursion and
 *  /Limits handling are exercised too.
 *  Object layout: 1 Catalog, 2 Pages, 3-9 Pages, 10 /PageLabels root (/Kids),
 *  11 leaf [0,3], 12 leaf [5]. */
export function buildPageLabelsPdf(): Uint8Array {
  const objects: string[] = [];
  objects[1] = `<< /Type /Catalog /Pages 2 0 R /PageLabels 10 0 R >>`;
  objects[2] = `<< /Type /Pages /Count 7 /Kids [3 0 R 4 0 R 5 0 R 6 0 R 7 0 R 8 0 R 9 0 R] >>`;
  for (let n = 3; n <= 9; n++) objects[n] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >>`;
  objects[10] = `<< /Kids [11 0 R 12 0 R] >>`;
  objects[11] = `<< /Limits [0 3] /Nums [0 << /S /r >> 3 << /S /D /St 1 >>] >>`;
  objects[12] = `<< /Limits [5 5] /Nums [5 << /S /D /P (A-) >>] >>`;
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

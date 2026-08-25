import { deflateSync } from 'node:zlib';

const enc = (s: string) => new TextEncoder().encode(s);
const byteLen = (s: string) => enc(s).length;

/** Build a minimal classic-xref PDF with `pageCount` pages.
 *  Object layout: 1=Catalog, 2=Pages, then per page: Page dict + Contents stream. */
export function buildClassicPdf(
  pageCount: number,
  opts: { info?: Record<string, string>; mediaBox?: number[]; rotate?: number } = {},
): Uint8Array {
  const objects: string[] = []; // index 1 -> object 1
  const pageObjNums: number[] = [];
  const firstPage = 3;
  for (let i = 0; i < pageCount; i++) pageObjNums.push(firstPage + i * 2);
  const kids = pageObjNums.map(n => `${n} 0 R`).join(' ');

  objects[1] = `<< /Type /Catalog /Pages 2 0 R >>`;
  const mb = opts.mediaBox ?? [0, 0, 200, 200];
  const rot = opts.rotate !== undefined ? ` /Rotate ${opts.rotate}` : '';
  objects[2] = `<< /Type /Pages /Count ${pageCount} /Kids [${kids}] /MediaBox [${mb.join(' ')}]${rot} >>`;
  for (let i = 0; i < pageCount; i++) {
    const pageNum = pageObjNums[i];
    const contentNum = pageNum + 1;
    const stream = `BT /F1 24 Tf 20 100 Td (Page ${i + 1}) Tj ET`;
    objects[pageNum] = `<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> >> >> /Contents ${contentNum} 0 R >>`;
    objects[contentNum] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`;
  }
  let maxObj = 2 + pageCount * 2;
  let infoNum: number | undefined;
  if (opts.info) {
    infoNum = maxObj + 1;
    maxObj = infoNum;
    const body = Object.entries(opts.info)
      .map(([k, v]) => `/${k} (${v.replace(/([()\\])/g, '\\$1')})`)
      .join(' ');
    objects[infoNum] = `<< ${body} >>`;
  }

  // Serialize with offsets.
  let body = '%PDF-1.7\n%âãÏÓ\n';
  const offsets: number[] = new Array(maxObj + 1).fill(0);
  for (let n = 1; n <= maxObj; n++) {
    if (!objects[n]) continue;
    offsets[n] = byteLen(body);
    body += `${n} 0 obj\n${objects[n]}\nendobj\n`;
  }
  const xrefOffset = byteLen(body);
  let xref = `xref\n0 ${maxObj + 1}\n0000000000 65535 f \n`;
  for (let n = 1; n <= maxObj; n++) {
    xref += `${String(offsets[n]).padStart(10, '0')} 00000 n \n`;
  }
  const infoEntry = infoNum ? ` /Info ${infoNum} 0 R` : '';
  const trailer = `trailer\n<< /Size ${maxObj + 1} /Root 1 0 R${infoEntry} >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return enc(body + xref + trailer);
}

/** Build a 2-page classic PDF whose two pages share ONE indirect Font object
 *  (object 7), so a correct importer copies that font exactly once.
 *  Layout: 1=Catalog 2=Pages 3=Page 4=Page 5=Contents 6=Contents 7=Font. */
export function buildSharedFontPdf(): Uint8Array {
  const sA = `BT /F1 24 Tf 20 100 Td (A) Tj ET`;
  const sB = `BT /F1 24 Tf 20 100 Td (B) Tj ET`;
  const objects: string[] = [];
  objects[1] = `<< /Type /Catalog /Pages 2 0 R >>`;
  objects[2] = `<< /Type /Pages /Count 2 /Kids [3 0 R 4 0 R] /MediaBox [0 0 200 200] >>`;
  objects[3] = `<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 7 0 R >> >> /Contents 5 0 R >>`;
  objects[4] = `<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 7 0 R >> >> /Contents 6 0 R >>`;
  objects[5] = `<< /Length ${sA.length} >>\nstream\n${sA}\nendstream`;
  objects[6] = `<< /Length ${sB.length} >>\nstream\n${sB}\nendstream`;
  objects[7] = `<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>`;
  const maxObj = 7;

  let body = '%PDF-1.7\n%âãÏÓ\n';
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

/** Build a PDF whose cross-reference is an xref STREAM (PDF 1.5+), 1 page, no predictor. */
export function buildXrefStreamPdf(): Uint8Array {
  // objs: 1 Catalog, 2 Pages, 3 Page, 4 Contents, 5 = xref stream itself
  const stream = `BT /F1 24 Tf 20 100 Td (Hi) Tj ET`;
  const objs: Record<number, string> = {
    1: `<< /Type /Catalog /Pages 2 0 R >>`,
    2: `<< /Type /Pages /Count 1 /Kids [3 0 R] /MediaBox [0 0 200 200] >>`,
    3: `<< /Type /Page /Parent 2 0 R /Resources << >> /Contents 4 0 R >>`,
    4: `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
  };
  let body = '%PDF-1.5\n%âãÏÓ\n';
  const offsets: Record<number, number> = {};
  for (const n of [1, 2, 3, 4]) { offsets[n] = byteLen(body); body += `${n} 0 obj\n${objs[n]}\nendobj\n`; }
  const xrefObjNum = 5;
  const xrefOffset = byteLen(body);
  // Build W=[1 2 1] entries for objects 0..5
  const rows: number[][] = [];
  rows[0] = [0, 0, 255];                 // free head
  for (const n of [1, 2, 3, 4]) rows[n] = [1, offsets[n], 0];
  rows[xrefObjNum] = [1, xrefOffset, 0]; // the xref stream object points to itself
  const bytes: number[] = [];
  for (let n = 0; n <= xrefObjNum; n++) {
    const [a, b, c] = rows[n];
    bytes.push(a & 0xff);
    bytes.push((b >> 8) & 0xff, b & 0xff);
    bytes.push(c & 0xff);
  }
  const packed = deflateSync(Buffer.from(Uint8Array.from(bytes)));
  const dict = `<< /Type /XRef /Size ${xrefObjNum + 1} /Root 1 0 R /W [1 2 1] /Filter /FlateDecode /Length ${packed.length} >>`;
  body += `${xrefObjNum} 0 obj\n${dict}\nstream\n`;
  const head = enc(body);
  const tail = enc(`\nendstream\nendobj\nstartxref\n${xrefOffset}\n%%EOF\n`);
  const out = new Uint8Array(head.length + packed.length + tail.length);
  out.set(head, 0); out.set(packed, head.length); out.set(tail, head.length + packed.length);
  return out;
}

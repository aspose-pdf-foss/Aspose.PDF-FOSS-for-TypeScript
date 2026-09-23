/** Hand-built PDFs for page-tree structure tests (dmin.4). The object bodies
 *  are written raw, so a test can state a broken /Count, a stale /Parent or a
 *  shared kid exactly as a damaged file would carry it — which no Document
 *  API will produce. */

/** Object i (0-based) is written as `i+1 0 obj`; the trailer's /Root is 1. */
export function buildRawPdf(objects: string[]): Uint8Array {
  let s = '%PDF-1.7\n';
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(s.length);
    s += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = s.length;
  s += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const o of offsets) s += `${String(o).padStart(10, '0')} 00000 n \n`;
  s += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(s);
}

/** Root 2 lists intermediate node 3 (carrying /MediaBox [0 0 100 100], holding
 *  pages 4 and 5) and page 6 (its own 200x200 box). Structurally sound. */
export function buildNestedPageTreePdf(): Uint8Array {
  return buildRawPdf([
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R 6 0 R] /Count 3 >>',
    '<< /Type /Pages /Parent 2 0 R /Kids [4 0 R 5 0 R] /Count 2 /MediaBox [0 0 100 100] >>',
    '<< /Type /Page /Parent 3 0 R >>',
    '<< /Type /Page /Parent 3 0 R >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] >>',
  ]);
}

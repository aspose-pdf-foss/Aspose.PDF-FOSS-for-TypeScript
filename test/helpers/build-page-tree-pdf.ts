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

/** A nested tree with competing inherited values and an indirect MediaBox,
 *  font and image. Attributes come from one chosen level or from several levels;
 *  competing ancestors deliberately disagree with the effective values. */
export function buildInheritedPageCopyPdf(level: 'root' | 'nested' | 'page' | 'mixed'): Uint8Array {
  const wanted = '/MediaBox 10 0 R /CropBox [20 30 290 490] /Rotate 90 /Resources 7 0 R';
  const fallback = '/MediaBox [0 0 600 800] /CropBox [1 2 590 790] /Rotate 180 /Resources << /Font << /F1 9 0 R >> >>';
  const content = 'BT /F1 12 Tf 40 100 Td (Inherited page) Tj ET q 20 0 0 20 40 40 cm /Im0 Do Q';
  const root = level === 'root' ? wanted
    : level === 'mixed' ? '/MediaBox 10 0 R /Rotate 180 /Resources 7 0 R' : fallback;
  const nested = level === 'nested' ? wanted
    : level === 'mixed' ? '/CropBox [20 30 290 490]' : level === 'page' ? fallback : '';
  const page = level === 'page' ? wanted : level === 'mixed' ? '/Rotate 90' : '';
  return buildRawPdf([
    '<< /Type /Catalog /Pages 2 0 R >>',
    `<< /Type /Pages /Kids [3 0 R] /Count 1 ${root} >>`,
    `<< /Type /Pages /Parent 2 0 R /Kids [4 0 R] /Count 1 ${nested} >>`,
    `<< /Type /Page /Parent 3 0 R /Contents 5 0 R ${page} >>`,
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    '<< /Font << /F1 6 0 R >> /XObject << /Im0 8 0 R >> >>',
    '<< /Type /XObject /Subtype /Image /Width 1 /Height 1 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /ASCIIHexDecode /Length 7 >>\nstream\nFF0000>\nendstream',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Courier >>',
    '[10 20 310 520]',
  ]);
}

/** A shallow, default-limit-sized page graph with many independent objects. */
export function buildWidePageGraphPdf(count: number): Uint8Array {
  const refs = Array.from({ length: count }, (_, i) => `${i + 4} 0 R`).join(' ');
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 /MediaBox [0 0 200 200] >>',
    `<< /Type /Page /Parent 2 0 R /WideGraph [${refs}] >>`,
  ];
  for (let i = 0; i < count; i++) objects.push(String(i));
  return buildRawPdf(objects);
}

/** A wide, flat tree, with an optionally wrong count and legal null child. */
export function buildManyPagesPdf(count: number, wrongCount = false, nullChild = false): Uint8Array {
  const refs = Array.from({ length: count }, (_, i) => `${i + 3} 0 R`).join(' ');
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    `<< /Type /Pages /Kids [${refs}${nullChild ? ' null' : ''}] /Count ${wrongCount ? count - 1 : count} /MediaBox [0 0 200 200] >>`,
  ];
  for (let i = 0; i < count; i++) objects.push(`<< /Type /Page /Parent 2 0 R /Sequence ${i} >>`);
  return buildRawPdf(objects);
}

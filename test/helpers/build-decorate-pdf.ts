const enc = (s: string) => new TextEncoder().encode(s);
const byteLen = (s: string) => enc(s).length;

function assemble(objects: string[], maxObj: number, rootNum: number): Uint8Array {
  let body = '%PDF-1.7\n%\xE2\xE3\xCF\xD3\n';
  const offsets: number[] = new Array(maxObj + 1).fill(0);
  for (let n = 1; n <= maxObj; n++) {
    offsets[n] = byteLen(body);
    body += `${n} 0 obj\n${objects[n]}\nendobj\n`;
  }
  const xrefOffset = byteLen(body);
  let xref = `xref\n0 ${maxObj + 1}\n0000000000 65535 f \n`;
  for (let n = 1; n <= maxObj; n++) xref += `${String(offsets[n]).padStart(10, '0')} 00000 n \n`;
  const trailer = `trailer\n<< /Size ${maxObj + 1} /Root ${rootNum} 0 R >>\n` +
    `startxref\n${xrefOffset}\n%%EOF\n`;
  return enc(body + xref + trailer);
}

export interface DecorateTargetOptions {
  /** Number of pages. Default 3. */
  count?: number;
  /** /Rotate on every page. Default 0. */
  rotate?: number;
  /** MediaBox/CropBox origin [x0, y0]. Default [0, 0]. */
  origin?: [number, number];
  /** Page size [w, h]. Default [200, 100]. */
  size?: [number, number];
  /** Add /PageLabels: lowercase roman from page 1. Default false. */
  labels?: boolean;
}

/** `count` pages, each showing "P<n>" so existing content is observable.
 *  Object layout: 1 catalog, 2 pages node, 3 font, then per page a page dict and
 *  a content stream, then optionally the /PageLabels number tree. */
export function buildDecorateTarget(opts: DecorateTargetOptions = {}): Uint8Array {
  const count = opts.count ?? 3;
  const rotate = opts.rotate ?? 0;
  const [x0, y0] = opts.origin ?? [0, 0];
  const [w, h] = opts.size ?? [200, 100];
  const box = `[${x0} ${y0} ${x0 + w} ${y0 + h}]`;
  const rot = rotate ? ` /Rotate ${rotate}` : '';

  const objects: string[] = [];
  const kids: string[] = [];
  let next = 4; // 1 catalog, 2 pages, 3 font
  for (let i = 1; i <= count; i++) {
    const pageNum = next++;
    const contentNum = next++;
    kids.push(`${pageNum} 0 R`);
    const content = `BT /F1 12 Tf ${x0 + 10} ${y0 + 10} Td (P${i}) Tj ET`;
    objects[pageNum] = `<< /Type /Page /Parent 2 0 R /MediaBox ${box} /CropBox ${box}` +
      `${rot} /Resources << /Font << /F1 3 0 R >> >> /Contents ${contentNum} 0 R >>`;
    objects[contentNum] = `<< /Length ${byteLen(content)} >>\nstream\n${content}\nendstream`;
  }

  let labelsEntry = '';
  if (opts.labels) {
    const labelsNum = next++;
    objects[labelsNum] = `<< /Nums [0 << /S /r >>] >>`;
    labelsEntry = ` /PageLabels ${labelsNum} 0 R`;
  }

  objects[1] = `<< /Type /Catalog /Pages 2 0 R${labelsEntry} >>`;
  objects[2] = `<< /Type /Pages /Count ${count} /Kids [${kids.join(' ')}] >>`;
  objects[3] = `<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>`;
  return assemble(objects, next - 1, 1);
}

/** Two pages of different sizes (200x100 then 400x400), for per-page geometry. */
export function buildDecorateMixedSizes(): Uint8Array {
  const objects: string[] = [];
  objects[1] = `<< /Type /Catalog /Pages 2 0 R >>`;
  objects[2] = `<< /Type /Pages /Count 2 /Kids [3 0 R 4 0 R] >>`;
  objects[3] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 100] /CropBox [0 0 200 100] >>`;
  objects[4] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 400 400] /CropBox [0 0 400 400] >>`;
  return assemble(objects, 4, 1);
}

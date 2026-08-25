const enc = (s: string) => new TextEncoder().encode(s);
const byteLen = (s: string) => enc(s).length;

/** One page, one Helvetica font (F1), MediaBox 0 0 300 300, given content stream. */
export function buildTablePdf(stream: string): Uint8Array {
  const objs: Record<number, string> = {
    1: `<< /Type /Catalog /Pages 2 0 R >>`,
    2: `<< /Type /Pages /Count 1 /Kids [3 0 R] /MediaBox [0 0 300 300] >>`,
    3: `<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>`,
    4: `<< /Length ${byteLen(stream)} >>\nstream\n${stream}\nendstream`,
    5: `<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>`,
  };
  let body = '%PDF-1.7\n%\xE2\xE3\xCF\xD3\n';
  const off: number[] = new Array(6).fill(0);
  for (let n = 1; n <= 5; n++) { off[n] = byteLen(body); body += `${n} 0 obj\n${objs[n]}\nendobj\n`; }
  const xo = byteLen(body);
  let xref = `xref\n0 6\n0000000000 65535 f \n`;
  for (let n = 1; n <= 5; n++) xref += `${String(off[n]).padStart(10, '0')} 00000 n \n`;
  return enc(body + xref + `trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xo}\n%%EOF\n`);
}

/** Two pages, shared Helvetica font, MediaBox 0 0 300 300 each. */
export function buildTwoPageTablePdf(stream0: string, stream1: string): Uint8Array {
  const objs: Record<number, string> = {
    1: `<< /Type /Catalog /Pages 2 0 R >>`,
    2: `<< /Type /Pages /Count 2 /Kids [3 0 R 6 0 R] /MediaBox [0 0 300 300] >>`,
    3: `<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>`,
    4: `<< /Length ${byteLen(stream0)} >>\nstream\n${stream0}\nendstream`,
    5: `<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>`,
    6: `<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 5 0 R >> >> /Contents 7 0 R >>`,
    7: `<< /Length ${byteLen(stream1)} >>\nstream\n${stream1}\nendstream`,
  };
  let body = '%PDF-1.7\n%\xE2\xE3\xCF\xD3\n';
  const off: number[] = new Array(8).fill(0);
  for (let n = 1; n <= 7; n++) { off[n] = byteLen(body); body += `${n} 0 obj\n${objs[n]}\nendobj\n`; }
  const xo = byteLen(body);
  let xref = `xref\n0 8\n0000000000 65535 f \n`;
  for (let n = 1; n <= 7; n++) xref += `${String(off[n]).padStart(10, '0')} 00000 n \n`;
  return enc(body + xref + `trailer\n<< /Size 8 /Root 1 0 R >>\nstartxref\n${xo}\n%%EOF\n`);
}

/** Emit a `Tj` text-show block at (x,y), size 10 Helvetica. */
export function text(x: number, y: number, s: string, size = 10): string {
  return `BT /F1 ${size} Tf 1 0 0 1 ${x} ${y} Tm (${s.replace(/([()\\])/g, '\\$1')}) Tj ET\n`;
}

/** Stroked horizontal line. */
export function hline(x0: number, x1: number, y: number): string {
  return `${x0} ${y} m ${x1} ${y} l S\n`;
}

/** Stroked vertical line. */
export function vline(x: number, y0: number, y1: number): string {
  return `${x} ${y0} m ${x} ${y1} l S\n`;
}

/** Wrap content in a CTM that rotates by `deg` about the origin, then translates
 *  by (tx,ty). Glyphs/paths inside are emitted rotated in page space. */
export function rotate(deg: number, tx: number, ty: number, inner: string): string {
  const r = (deg * Math.PI) / 180, c = Math.cos(r), s = Math.sin(r);
  const f = (n: number) => n.toFixed(6);
  return `q ${f(c)} ${f(s)} ${f(-s)} ${f(c)} ${tx} ${ty} cm\n${inner}Q\n`;
}

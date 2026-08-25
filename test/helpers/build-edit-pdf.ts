const enc = (s: string) => new TextEncoder().encode(s);
const byteLen = (s: string) => enc(s).length;

function serialize(objects: Record<number, string>, maxObj: number): Uint8Array {
  let body = '%PDF-1.7\n%\xE2\xE3\xCF\xD3\n';
  const offsets: number[] = new Array(maxObj + 1).fill(0);
  for (let n = 1; n <= maxObj; n++) {
    if (!objects[n]) continue;
    offsets[n] = byteLen(body);
    body += `${n} 0 obj\n${objects[n]}\nendobj\n`;
  }
  const xrefOffset = byteLen(body);
  let xref = `xref\n0 ${maxObj + 1}\n0000000000 65535 f \n`;
  for (let n = 1; n <= maxObj; n++) xref += `${String(offsets[n]).padStart(10, '0')} 00000 n \n`;
  const trailer = `trailer\n<< /Size ${maxObj + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return enc(body + xref + trailer);
}

function streamObj(s: string): string {
  return `<< /Length ${byteLen(s)} >>\nstream\n${s}\nendstream`;
}

/** One page whose /Contents is an array of the given streams, with a Helvetica /F1. */
export function buildMultiStreamPage(streams: string[]): Uint8Array {
  const refs = streams.map((_, i) => `${5 + i} 0 R`).join(' ');
  const objects: Record<number, string> = {
    1: `<< /Type /Catalog /Pages 2 0 R >>`,
    2: `<< /Type /Pages /Count 1 /Kids [3 0 R] /MediaBox [0 0 300 300] >>`,
    3: `<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 4 0 R >> >> /Contents [${refs}] >>`,
    4: `<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>`,
  };
  streams.forEach((s, i) => { objects[5 + i] = streamObj(s); });
  return serialize(objects, 4 + streams.length);
}

/** One page whose /Resources declares two Helvetica fonts (/F1, /F2); the given
 *  content stream decides which are actually referenced via Tf. */
export function buildTwoFontPage(stream: string): Uint8Array {
  const objects: Record<number, string> = {
    1: `<< /Type /Catalog /Pages 2 0 R >>`,
    2: `<< /Type /Pages /Count 1 /Kids [3 0 R] /MediaBox [0 0 300 300] >>`,
    3: `<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 4 0 R /F2 5 0 R >> >> /Contents 6 0 R >>`,
    4: `<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>`,
    5: `<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>`,
    6: streamObj(stream),
  };
  return serialize(objects, 6);
}

/** One page whose single content stream both shows text via /F1 and draws an
 *  image XObject /Im0 (1x1) — exercises text + image edits in one stream. */
export function buildTextAndImagePage(stream: string): Uint8Array {
  const objects: Record<number, string> = {
    1: `<< /Type /Catalog /Pages 2 0 R >>`,
    2: `<< /Type /Pages /Count 1 /Kids [3 0 R] /MediaBox [0 0 300 300] >>`,
    3: `<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 4 0 R >> ` +
       `/XObject << /Im0 5 0 R >> >> /Contents 6 0 R >>`,
    4: `<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>`,
    5: `<< /Type /XObject /Subtype /Image /Width 1 /Height 1 ` +
       `/ColorSpace /DeviceGray /BitsPerComponent 8 /Length 1 >>\nstream\n\x00\nendstream`,
    6: streamObj(stream),
  };
  return serialize(objects, 6);
}

/** One page with TWO distinguishable 1x1 image XObjects: /Im0 is white, /Im1 is
 *  black. Different samples on purpose — a consumer that picks the wrong image
 *  produces a different data URI, which an identical pair would hide. */
export function buildTwoImagePage(stream: string): Uint8Array {
  const image = (sample: string) =>
    `<< /Type /XObject /Subtype /Image /Width 1 /Height 1 `
    + `/ColorSpace /DeviceGray /BitsPerComponent 8 /Length 1 >>\nstream\n${sample}\nendstream`;
  const objects: Record<number, string> = {
    1: `<< /Type /Catalog /Pages 2 0 R >>`,
    2: `<< /Type /Pages /Count 1 /Kids [3 0 R] /MediaBox [0 0 300 300] >>`,
    3: `<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 4 0 R >> `
       + `/XObject << /Im0 5 0 R /Im1 7 0 R >> >> /Contents 6 0 R >>`,
    4: `<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>`,
    5: image('\xFF'),
    6: streamObj(stream),
    7: image('\x00'),
  };
  return serialize(objects, 7);
}

/** Two pages that both draw the SAME Form XObject /Fm0, which shows text via /F1.
 *  Proves copy-on-write isolation: editing page 1 must not change page 2. */
export function buildSharedXObjectPages(): Uint8Array {
  const fm = 'BT /F1 12 Tf 0 0 Td (shared) Tj ET';
  const objects: Record<number, string> = {
    1: `<< /Type /Catalog /Pages 2 0 R >>`,
    2: `<< /Type /Pages /Count 2 /Kids [3 0 R 4 0 R] /MediaBox [0 0 300 300] >>`,
    3: `<< /Type /Page /Parent 2 0 R /Resources << /XObject << /Fm0 6 0 R >> >> /Contents 5 0 R >>`,
    4: `<< /Type /Page /Parent 2 0 R /Resources << /XObject << /Fm0 6 0 R >> >> /Contents 5 0 R >>`,
    5: streamObj('q 1 0 0 1 50 50 cm /Fm0 Do Q'),
    6: `<< /Type /XObject /Subtype /Form /BBox [0 0 100 20] ` +
       `/Resources << /Font << /F1 7 0 R >> >> /Length ${byteLen(fm)} >>\nstream\n${fm}\nendstream`,
    7: `<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>`,
  };
  return serialize(objects, 7);
}

const enc = (s: string) => new TextEncoder().encode(s);
const byteLen = (s: string) => enc(s).length;

/** Assemble a classic-xref PDF from a 1-based array of object bodies. */
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
  const trailer = `trailer\n<< /Size ${maxObj + 1} /Root ${rootNum} 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return enc(body + xref + trailer);
}

function streamObj(content: string): string {
  return `<< /Length ${byteLen(content)} >>\nstream\n${content}\nendstream`;
}

/** Single page with its OWN /Resources, existing content showing "Original"
 *  in Courier (a non-Helvetica font, so stamping adds a distinct Helvetica). */
export function buildStampTarget(): Uint8Array {
  const content = 'BT /F0 12 Tf 10 100 Td (Original) Tj ET';
  const objects: string[] = [];
  objects[1] = `<< /Type /Catalog /Pages 2 0 R >>`;
  objects[2] = `<< /Type /Pages /Count 1 /Kids [3 0 R] /MediaBox [0 0 300 200] >>`;
  objects[3] = `<< /Type /Page /Parent 2 0 R /Resources << /Font << /F0 5 0 R >> >> /Contents 4 0 R >>`;
  objects[4] = streamObj(content);
  objects[5] = `<< /Type /Font /Subtype /Type1 /BaseFont /Courier /Encoding /WinAnsiEncoding >>`;
  return assemble(objects, 5, 1);
}

/** Single page that INHERITS /Resources from the /Pages node (no own /Resources),
 *  existing content showing "Inherited" in Courier. */
export function buildInheritedResourcesTarget(): Uint8Array {
  const content = 'BT /F0 12 Tf 10 100 Td (Inherited) Tj ET';
  const objects: string[] = [];
  objects[1] = `<< /Type /Catalog /Pages 2 0 R >>`;
  objects[2] = `<< /Type /Pages /Count 1 /Kids [3 0 R] /MediaBox [0 0 300 200] /Resources << /Font << /F0 5 0 R >> >> >>`;
  objects[3] = `<< /Type /Page /Parent 2 0 R /Contents 4 0 R >>`;
  objects[4] = streamObj(content);
  objects[5] = `<< /Type /Font /Subtype /Type1 /BaseFont /Courier /Encoding /WinAnsiEncoding >>`;
  return assemble(objects, 5, 1);
}

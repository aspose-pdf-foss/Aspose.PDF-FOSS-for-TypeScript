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

/** An uncompressed stream object body with the given extra dict entries. */
function streamObj(s: string, extra = ''): string {
  return `<< ${extra} /Length ${byteLen(s)} >>\nstream\n${s}\nendstream`;
}

/** A page carrying one hand-written /Redact annotation with every key set —
 *  the shape another producer writes, which our reader must accept. */
export function buildRedactReadTarget(): Uint8Array {
  const objects: string[] = [];
  objects[1] = `<< /Type /Catalog /Pages 2 0 R >>`;
  objects[2] = `<< /Type /Pages /Count 1 /Kids [3 0 R] /MediaBox [0 0 300 300] >>`;
  objects[3] = `<< /Type /Page /Parent 2 0 R /Resources << >> /Annots [4 0 R] >>`;
  objects[4] = `<< /Type /Annot /Subtype /Redact /Rect [50 100 200 130] ` +
    `/QuadPoints [50 130 200 130 50 100 200 100] ` +
    `/IC [0 0 1] /C [1 0 0] /OverlayText (CLASSIFIED) /Repeat true /Q 1 ` +
    `/DA (/Helv 9 Tf 1 1 1 rg) /T (auditor) /Contents (why) >>`;
  return assemble(objects, 4, 1);
}

/** A page with text and a hand-written /Redact carrying an /RO overlay form —
 *  the shape a producer writes when the author drew custom overlay artwork. The
 *  form paints a green box, distinguishable from any /IC we would pick. */
export function buildRedactWithROTarget(): Uint8Array {
  const ro = `0 1 0 rg 0 0 160 20 re f`;
  const content = `BT /F1 10 Tf 50 100 Td (TopSecret) Tj ET`;
  const objects: string[] = [];
  objects[1] = `<< /Type /Catalog /Pages 2 0 R >>`;
  objects[2] = `<< /Type /Pages /Count 1 /Kids [3 0 R] /MediaBox [0 0 300 300] >>`;
  objects[3] = `<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 6 0 R >> >> ` +
    `/Contents 7 0 R /Annots [4 0 R] >>`;
  objects[4] = `<< /Type /Annot /Subtype /Redact /Rect [40 95 200 115] ` +
    `/QuadPoints [40 115 200 115 40 95 200 95] ` +
    `/IC [0 0 1] /OverlayText (SHOULD NOT APPEAR) /RO 5 0 R >>`;
  objects[5] = streamObj(ro, `/Type /XObject /Subtype /Form /BBox [0 0 160 20]`);
  objects[6] = `<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>`;
  objects[7] = streamObj(content);
  return assemble(objects, 7, 1);
}

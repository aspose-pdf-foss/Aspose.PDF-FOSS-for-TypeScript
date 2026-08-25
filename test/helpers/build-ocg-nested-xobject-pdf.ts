const enc = (s: string) => new TextEncoder().encode(s);
const byteLen = (s: string) => enc(s).length;

/** One-page PDF with a **nested** Form XObject bound to a layer by its dict
 *  `/OC`. The page draws outer form /Fm0 (obj 9) via `Do`; obj 9's content draws
 *  inner form /Inner (obj 10) via `Do`; obj 10 carries `/OC 7 0 R` binding the
 *  whole inner form to Layer B. Exercises RemoveLayer clearing `/OC` on Form
 *  XObjects nested inside other forms (not just page-level ones).
 *
 *  OCGs: 6=A, 7=B. /D: BaseState ON, Order [A B]. */
export function buildOcgNestedXObjectPdf(): Uint8Array {
  const page = `q /Fm0 Do Q\n`;
  const outer = `q /Inner Do Q\n`;
  const inner = `0 0 1 rg\n10 10 30 30 re f\n`;

  const objects: string[] = [];
  objects[1] = `<< /Type /Catalog /Pages 2 0 R /OCProperties 5 0 R >>`;
  objects[2] = `<< /Type /Pages /Count 1 /Kids [3 0 R] /MediaBox [0 0 400 400] >>`;
  objects[3] = `<< /Type /Page /Parent 2 0 R /Resources << /XObject << /Fm0 9 0 R >> >> /Contents 4 0 R >>`;
  objects[4] = `<< /Length ${byteLen(page)} >>\nstream\n${page}endstream`;
  objects[5] = `<< /OCGs [6 0 R 7 0 R] /D 8 0 R >>`;
  objects[6] = `<< /Type /OCG /Name (Layer A) >>`;
  objects[7] = `<< /Type /OCG /Name (Layer B) >>`;
  objects[8] = `<< /Name (Default) /BaseState /ON /Order [6 0 R 7 0 R] >>`;
  objects[9] = `<< /Type /XObject /Subtype /Form /BBox [0 0 400 400] /Resources << /XObject << /Inner 10 0 R >> >> /Length ${byteLen(outer)} >>\nstream\n${outer}endstream`;
  objects[10] = `<< /Type /XObject /Subtype /Form /BBox [0 0 50 50] /OC 7 0 R /Length ${byteLen(inner)} >>\nstream\n${inner}endstream`;
  const maxObj = 10;

  let body = '%PDF-1.7\n%\xE2\xE3\xCF\xD3\n';
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

const enc = (s: string) => new TextEncoder().encode(s);
const byteLen = (s: string) => enc(s).length;

/** One-page PDF with an OCMD whose visibility depends on layer A **only via
 *  /VE** (no /OCGs). The OCMD (obj 9) is bound to a page-content block (MC0), a
 *  Form XObject (obj 10, /OC), and an annotation (obj 11, /OC).
 *  OCGs: 6=A, 7=B. /D: BaseState ON, OFF=[B] => A visible, B hidden.
 *  OCMD /VE = [/And A [/Not B]]. */
export function buildOcmdVePdf(): Uint8Array {
  const content =
`/OC /MC0 BDC
1 0 0 RG
10 10 100 100 re
S
EMC
0 0 0 rg
`;
  const form = `0 0 50 50 re f\n`;

  const objects: string[] = [];
  objects[1] = `<< /Type /Catalog /Pages 2 0 R /OCProperties 5 0 R >>`;
  objects[2] = `<< /Type /Pages /Count 1 /Kids [3 0 R] /MediaBox [0 0 400 400] >>`;
  objects[3] = `<< /Type /Page /Parent 2 0 R /Resources << /Properties << /MC0 9 0 R >> /XObject << /Fm0 10 0 R >> >> /Contents 4 0 R /Annots [11 0 R] >>`;
  objects[4] = `<< /Length ${byteLen(content)} >>\nstream\n${content}endstream`;
  objects[5] = `<< /OCGs [6 0 R 7 0 R] /D 8 0 R >>`;
  objects[6] = `<< /Type /OCG /Name (Layer A) >>`;
  objects[7] = `<< /Type /OCG /Name (Layer B) >>`;
  objects[8] = `<< /Name (Default) /BaseState /ON /OFF [7 0 R] /Order [6 0 R 7 0 R] >>`;
  objects[9] = `<< /Type /OCMD /VE [/And 6 0 R [/Not 7 0 R]] >>`;
  objects[10] = `<< /Type /XObject /Subtype /Form /BBox [0 0 50 50] /OC 9 0 R /Length ${byteLen(form)} >>\nstream\n${form}endstream`;
  objects[11] = `<< /Type /Annot /Subtype /Square /Rect [0 0 20 20] /OC 9 0 R >>`;
  const maxObj = 11;

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

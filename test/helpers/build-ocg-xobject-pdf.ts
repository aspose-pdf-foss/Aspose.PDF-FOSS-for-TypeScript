const enc = (s: string) => new TextEncoder().encode(s);
const byteLen = (s: string) => enc(s).length;

/** One-page PDF whose page invokes a Form XObject (obj 9, /Fm0) via `Do`, where
 *  the **Form XObject's own content stream** carries two `/OC … BDC … EMC`
 *  blocks — one bound to Layer A, one to Layer B — resolved through the form's
 *  own /Resources /Properties. Exercises RemoveLayer recursing into Form XObject
 *  streams: removing a layer must excise its block *inside the form*, not just
 *  on the page /Contents.
 *
 *  OCGs: 6=A, 7=B. /D: BaseState ON, Order [A B]. The page /Contents has no /OC
 *  block of its own — the only optional content lives inside the form. */
export function buildOcgXObjectPdf(): Uint8Array {
  const page = `q 1 0 0 1 0 0 cm /Fm0 Do Q\n`;
  const form =
`/OC /OC0 BDC
1 0 0 rg
0 0 20 20 re f
EMC
/OC /OC1 BDC
0 0 1 rg
30 30 20 20 re f
EMC
`;

  const objects: string[] = [];
  objects[1] = `<< /Type /Catalog /Pages 2 0 R /OCProperties 5 0 R >>`;
  objects[2] = `<< /Type /Pages /Count 1 /Kids [3 0 R] /MediaBox [0 0 400 400] >>`;
  objects[3] = `<< /Type /Page /Parent 2 0 R /Resources << /XObject << /Fm0 9 0 R >> >> /Contents 4 0 R >>`;
  objects[4] = `<< /Length ${byteLen(page)} >>\nstream\n${page}endstream`;
  objects[5] = `<< /OCGs [6 0 R 7 0 R] /D 8 0 R >>`;
  objects[6] = `<< /Type /OCG /Name (Layer A) >>`;
  objects[7] = `<< /Type /OCG /Name (Layer B) >>`;
  objects[8] = `<< /Name (Default) /BaseState /ON /Order [6 0 R 7 0 R] >>`;
  objects[9] = `<< /Type /XObject /Subtype /Form /BBox [0 0 400 400] /Resources << /Properties << /OC0 6 0 R /OC1 7 0 R >> >> /Length ${byteLen(form)} >>\nstream\n${form}endstream`;
  const maxObj = 9;

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

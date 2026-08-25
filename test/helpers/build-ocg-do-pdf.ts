const enc = (s: string) => new TextEncoder().encode(s);
const byteLen = (s: string) => enc(s).length;

/** One-page PDF exercising deep XObject/Do excision on RemoveLayer. The page
 *  draws three Form XObjects:
 *   - Fm0 (obj 9): dict `/OC 7 0 R` binds it to Layer B; drawn unconditionally.
 *                  → sole purpose is Layer B ("case A") → removed with its Do.
 *   - Fm1 (obj 10): plain form, drawn *only* inside an `/OC /L0 BDC … EMC`
 *                  block bound to Layer B → invocation-orphaned ("case B") →
 *                  removed once the block is excised.
 *   - Fm2 (obj 11): plain form, drawn once unconditionally *and* once inside a
 *                  Layer B block → still invoked after excision → kept.
 *
 *  OCGs: 6=A, 7=B. /Properties /L0 -> Layer B. /D: BaseState ON, Order [A B]. */
export function buildOcgDoPdf(): Uint8Array {
  const page =
`/Fm0 Do
/OC /L0 BDC
/Fm1 Do
EMC
/Fm2 Do
/OC /L0 BDC
/Fm2 Do
EMC
`;
  const fm0 = `0 0 1 rg\n0 0 10 10 re f\n`;
  const fm1 = `1 0 0 rg\n5 5 10 10 re f\n`;
  const fm2 = `0 1 0 rg\n20 20 10 10 re f\n`;

  const objects: string[] = [];
  objects[1] = `<< /Type /Catalog /Pages 2 0 R /OCProperties 5 0 R >>`;
  objects[2] = `<< /Type /Pages /Count 1 /Kids [3 0 R] /MediaBox [0 0 400 400] >>`;
  objects[3] = `<< /Type /Page /Parent 2 0 R /Resources << /XObject << /Fm0 9 0 R /Fm1 10 0 R /Fm2 11 0 R >> /Properties << /L0 7 0 R >> >> /Contents 4 0 R >>`;
  objects[4] = `<< /Length ${byteLen(page)} >>\nstream\n${page}endstream`;
  objects[5] = `<< /OCGs [6 0 R 7 0 R] /D 8 0 R >>`;
  objects[6] = `<< /Type /OCG /Name (Layer A) >>`;
  objects[7] = `<< /Type /OCG /Name (Layer B) >>`;
  objects[8] = `<< /Name (Default) /BaseState /ON /Order [6 0 R 7 0 R] >>`;
  objects[9] = `<< /Type /XObject /Subtype /Form /BBox [0 0 50 50] /OC 7 0 R /Length ${byteLen(fm0)} >>\nstream\n${fm0}endstream`;
  objects[10] = `<< /Type /XObject /Subtype /Form /BBox [0 0 50 50] /Length ${byteLen(fm1)} >>\nstream\n${fm1}endstream`;
  objects[11] = `<< /Type /XObject /Subtype /Form /BBox [0 0 50 50] /Length ${byteLen(fm2)} >>\nstream\n${fm2}endstream`;
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

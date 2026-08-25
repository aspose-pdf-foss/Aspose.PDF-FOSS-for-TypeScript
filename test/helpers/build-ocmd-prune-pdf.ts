const enc = (s: string) => new TextEncoder().encode(s);
const byteLen = (s: string) => enc(s).length;

/** One-page PDF with two OCMDs bound to page content via /Properties, for
 *  exercising RemoveLayer's OCMD pruning:
 *
 *  - obj 9  OCMD-M: references A **and** B, via both /OCGs [A B] and /VE
 *           [/And A B]. When A is removed it must *survive* with A pruned out of
 *           both membership forms (still references B).
 *  - obj 10 OCMD-N: references A **only**, via /VE [/Not A]. When A is removed it
 *           becomes empty and must be dropped, along with its /Properties entry.
 *
 *  OCGs: 6=A, 7=B. /D: BaseState ON, Order [A B].
 *  Content: block /P1 (bound to M) and block /P2 (bound to N). */
export function buildOcmdPrunePdf(): Uint8Array {
  const content =
`/OC /P1 BDC
1 0 0 RG
10 10 100 100 re
S
EMC
/OC /P2 BDC
0 0 1 rg
20 20 30 30 re
f
EMC
0 0 0 rg
`;

  const objects: string[] = [];
  objects[1] = `<< /Type /Catalog /Pages 2 0 R /OCProperties 5 0 R >>`;
  objects[2] = `<< /Type /Pages /Count 1 /Kids [3 0 R] /MediaBox [0 0 400 400] >>`;
  objects[3] = `<< /Type /Page /Parent 2 0 R /Resources << /Properties << /P1 9 0 R /P2 10 0 R >> >> /Contents 4 0 R >>`;
  objects[4] = `<< /Length ${byteLen(content)} >>\nstream\n${content}endstream`;
  objects[5] = `<< /OCGs [6 0 R 7 0 R] /D 8 0 R >>`;
  objects[6] = `<< /Type /OCG /Name (Layer A) >>`;
  objects[7] = `<< /Type /OCG /Name (Layer B) >>`;
  objects[8] = `<< /Name (Default) /BaseState /ON /Order [6 0 R 7 0 R] >>`;
  objects[9] = `<< /Type /OCMD /OCGs [6 0 R 7 0 R] /VE [/And 6 0 R 7 0 R] >>`;
  objects[10] = `<< /Type /OCMD /VE [/Not 6 0 R] >>`;
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

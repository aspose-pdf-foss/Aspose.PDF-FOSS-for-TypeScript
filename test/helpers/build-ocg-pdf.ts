const enc = (s: string) => new TextEncoder().encode(s);
const byteLen = (s: string) => enc(s).length;

/** One-page classic-xref PDF exercising the OCG API.
 *  Objects: 1 Catalog, 2 Pages, 3 Page, 4 Contents (marked content),
 *  5 OCProperties, 6 OCG "Layer A", 7 OCG "Layer B", 8 OCG "Layer C",
 *  9 /D config, 10 Form XObject (/OC -> C), 11 Square annot (/OC -> B),
 *  12 named /Configs entry "Print".
 *  Content has an MC0 (Layer A) block enclosing a nested MC1 (Layer B) block.
 *  /D: BaseState ON, OFF=[B], Locked=[C], Order=[A B C]
 *      => A visible, B hidden, C visible & locked.
 *  Configs[0] "Print": BaseState OFF, ON=[A] => only A visible. */
export function buildOcgPdf(): Uint8Array {
  const content =
`/OC /MC0 BDC
1 0 0 RG
10 10 100 100 re
S
/OC /MC1 BDC
0 0 1 rg
20 20 50 50 re
f
EMC
EMC
0 0 0 rg
`;
  const form = `0 0 50 50 re f\n`;

  const objects: string[] = [];
  objects[1] = `<< /Type /Catalog /Pages 2 0 R /OCProperties 5 0 R >>`;
  objects[2] = `<< /Type /Pages /Count 1 /Kids [3 0 R] /MediaBox [0 0 400 400] >>`;
  objects[3] = `<< /Type /Page /Parent 2 0 R /Resources << /Properties << /MC0 6 0 R /MC1 7 0 R >> /XObject << /Fm0 10 0 R >> >> /Contents 4 0 R /Annots [11 0 R] >>`;
  objects[4] = `<< /Length ${byteLen(content)} >>\nstream\n${content}endstream`;
  objects[5] = `<< /OCGs [6 0 R 7 0 R 8 0 R] /D 9 0 R /Configs [12 0 R] >>`;
  objects[6] = `<< /Type /OCG /Name (Layer A) /Intent /View >>`;
  objects[7] = `<< /Type /OCG /Name (Layer B) >>`;
  objects[8] = `<< /Type /OCG /Name (Layer C) >>`;
  objects[9] = `<< /Name (Default) /BaseState /ON /OFF [7 0 R] /Locked [8 0 R] /Order [6 0 R 7 0 R 8 0 R] >>`;
  objects[10] = `<< /Type /XObject /Subtype /Form /BBox [0 0 50 50] /OC 8 0 R /Length ${byteLen(form)} >>\nstream\n${form}endstream`;
  objects[11] = `<< /Type /Annot /Subtype /Square /Rect [0 0 20 20] /OC 7 0 R >>`;
  objects[12] = `<< /Name (Print) /BaseState /OFF /ON [6 0 R] >>`;
  const maxObj = 12;

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

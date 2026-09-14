const enc = (s: string) => new TextEncoder().encode(s);
const byteLen = (s: string) => enc(s).length;

/** One-page classic-xref PDF exercising `/Usage` and a configuration's `/AS`.
 *  Objects: 1 Catalog, 2 Pages, 3 Page, 4 Contents, 5 OCProperties,
 *  6 OCG "Watermark", 7 OCG "Notes", 8 OCG "Stated", 9 OCG "Detail",
 *  10 /D config.
 *
 *  - "Watermark" carries `/Usage /Print /PrintState /OFF` and IS named by an
 *    `/AS` entry for the Print event, so it resolves OFF for Print and ON for
 *    View — the acceptance criterion's first half.
 *  - "Notes" carries `/Usage /View /ViewState /OFF` under a View `/AS` entry.
 *  - "Stated" carries `/Usage /Print /PrintState /OFF` and NO `/AS` entry
 *    names it, so it resolves unchanged for every event — the acceptance
 *    criterion's second half. It sits in `/OFF`, so "unchanged" is a state
 *    the usage would have moved had it been applied.
 *  - "Detail" carries `/Usage /Zoom` (min 2, no max) under a View `/AS` entry
 *    whose `/Category` names both /View and /Zoom.
 *
 *  /D: BaseState ON, OFF=[Stated]. */
export function buildOcgUsagePdf(): Uint8Array {
  const content =
`/OC /MC0 BDC
1 0 0 rg
10 10 100 100 re
f
EMC
`;

  const objects: string[] = [];
  objects[1] = `<< /Type /Catalog /Pages 2 0 R /OCProperties 5 0 R >>`;
  objects[2] = `<< /Type /Pages /Count 1 /Kids [3 0 R] /MediaBox [0 0 400 400] >>`;
  objects[3] = `<< /Type /Page /Parent 2 0 R /Resources << /Properties << /MC0 6 0 R >> >> /Contents 4 0 R >>`;
  objects[4] = `<< /Length ${byteLen(content)} >>\nstream\n${content}endstream`;
  objects[5] = `<< /OCGs [6 0 R 7 0 R 8 0 R 9 0 R] /D 10 0 R >>`;
  objects[6] = `<< /Type /OCG /Name (Watermark) /Usage << /Print << /PrintState /OFF /Subtype /Watermark >> >> >>`;
  objects[7] = `<< /Type /OCG /Name (Notes) /Usage << /View << /ViewState /OFF >> >> >>`;
  objects[8] = `<< /Type /OCG /Name (Stated) /Usage << /Print << /PrintState /OFF >> /View << /ViewState /ON >> >> >>`;
  objects[9] = `<< /Type /OCG /Name (Detail) /Usage << /Zoom << /min 2 >> >> >>`;
  objects[10] = `<< /Name (Default) /BaseState /ON /OFF [8 0 R] /Order [6 0 R 7 0 R 8 0 R 9 0 R] `
    + `/AS [`
    + `<< /Event /Print /Category [/Print] /OCGs [6 0 R] >> `
    + `<< /Event /View /Category [/View] /OCGs [7 0 R] >> `
    + `<< /Event /View /Category [/View /Zoom] /OCGs [9 0 R] >>`
    + `] >>`;
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

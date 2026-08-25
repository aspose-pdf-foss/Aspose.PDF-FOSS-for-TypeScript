const enc = (s: string) => new TextEncoder().encode(s);
const byteLen = (s: string) => enc(s).length;

/** One-page tagged PDF holding TWO chapters, each with a heading and a figure,
 *  where both figures draw the SAME image XObject /Im0.
 *
 *  `buildTaggedPdf` has one heading and a `/Figure` whose `/K` is an `/OBJR`,
 *  so it can never split into more than one chapter and never resolves an
 *  image; `AutoTag` ranks headings per block and clusters these into one. This
 *  is the shape the EPUB export's "ONE image sink spans every chapter"
 *  invariant needs: two chapters, one picture, so a per-chapter sink writes
 *  two package parts where the rule demands one.
 *
 *  Structure tree:
 *    Document (8)
 *      H1 (9),      /Pg 3, /K 0   -- "Chapter One"
 *      Figure (10), /Pg 3, /K 1, /Alt   -- draws /Im0
 *      H1 (11),     /Pg 3, /K 2   -- "Chapter Two"
 *      Figure (13), /Pg 3, /K 3, /Alt   -- draws /Im0 again
 *  ParentTree maps page key 0 -> [9 10 11 13], indexed by MCID. */
export function buildTaggedBookPdf(): Uint8Array {
  const content =
    '/H1 <</MCID 0>> BDC\nBT /F1 24 Tf 50 550 Td (Chapter One) Tj ET\nEMC\n'
    + '/Figure <</MCID 1>> BDC\nq 60 0 0 60 50 460 cm /Im0 Do Q\nEMC\n'
    + '/H1 <</MCID 2>> BDC\nBT /F1 24 Tf 50 400 Td (Chapter Two) Tj ET\nEMC\n'
    + '/Figure <</MCID 3>> BDC\nq 60 0 0 60 50 310 cm /Im0 Do Q\nEMC\n';

  const objects: string[] = [];
  objects[1] = `<< /Type /Catalog /Pages 2 0 R /StructTreeRoot 7 0 R /MarkInfo << /Marked true >> /Lang (en-US) >>`;
  objects[2] = `<< /Type /Pages /Count 1 /Kids [3 0 R] /MediaBox [0 0 400 600] >>`;
  objects[3] = `<< /Type /Page /Parent 2 0 R /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> /XObject << /Im0 6 0 R >> >> /StructParents 0 >>`;
  objects[4] = `<< /Length ${byteLen(content)} >>\nstream\n${content}endstream`;
  objects[5] = `<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>`;
  objects[6] = `<< /Type /XObject /Subtype /Image /Width 1 /Height 1 /ColorSpace /DeviceGray /BitsPerComponent 8 /Length 1 >>\nstream\n\x00\nendstream`;
  objects[7] = `<< /Type /StructTreeRoot /K [8 0 R] /ParentTree 12 0 R >>`;
  objects[8] = `<< /Type /StructElem /S /Document /P 7 0 R /K [9 0 R 10 0 R 11 0 R 13 0 R] >>`;
  objects[9] = `<< /Type /StructElem /S /H1 /P 8 0 R /Pg 3 0 R /K 0 >>`;
  objects[10] = `<< /Type /StructElem /S /Figure /P 8 0 R /Pg 3 0 R /K 1 /Alt (A shared picture) >>`;
  objects[11] = `<< /Type /StructElem /S /H1 /P 8 0 R /Pg 3 0 R /K 2 >>`;
  objects[12] = `<< /Nums [0 [9 0 R 10 0 R 11 0 R 13 0 R]] >>`;
  objects[13] = `<< /Type /StructElem /S /Figure /P 8 0 R /Pg 3 0 R /K 3 /Alt (A shared picture) >>`;
  const maxObj = 13;

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

// Two tagged pages. The element carrying the marked content has BARE-INTEGER
// /K entries and NO /Pg of its own — it inherits one from its parent Sect.
//
// Hand-built because nothing this library authors can produce that shape:
// `appendContentKid` writes /Pg onto the element the first time content is
// added, so every element we create already owns one. The inherited case is
// the third-party and hand-built population, which is exactly who
// StructElement.MoveTo has to be safe for.
//
// Tree:  root -> Sect  (/Pg page 1) -> P    (no /Pg, /K 0)
//        root -> Other (/Pg page 2) -> Span (no /Pg, /K [])
// Moving P under Other must NOT change which page its MCID resolves against.
// The Span is what reaches the bare-integer guard — see the test that names it.

const enc = (s: string) => new TextEncoder().encode(s);
const byteLen = (s: string) => enc(s).length;

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

export function buildInheritedPgPdf(): Uint8Array {
  const c1 = '/P << /MCID 0 >> BDC 0 0 0 rg 10 10 20 20 re f EMC';
  const c2 = '0 0 1 rg 30 30 20 20 re f';
  const objects: string[] = [];
  objects[1] = '<< /Type /Catalog /Pages 2 0 R /StructTreeRoot 8 0 R '
    + '/MarkInfo << /Marked true >> /Lang (en-US) >>';
  objects[2] = '<< /Type /Pages /Count 2 /Kids [3 0 R 4 0 R] /MediaBox [0 0 200 200] >>';
  objects[3] = '<< /Type /Page /Parent 2 0 R /StructParents 0 '
    + '/Resources << >> /Contents 5 0 R >>';
  objects[4] = '<< /Type /Page /Parent 2 0 R /StructParents 1 '
    + '/Resources << >> /Contents 6 0 R >>';
  objects[5] = streamObj(c1);
  objects[6] = streamObj(c2);
  objects[7] = '<< /Nums [0 [10 0 R] 1 []] >>';
  objects[8] = '<< /Type /StructTreeRoot /K [9 0 R 11 0 R] /ParentTree 7 0 R '
    + '/ParentTreeNextKey 2 >>';
  // Sect owns the /Pg; its child P does not.
  objects[9] = '<< /Type /StructElem /S /Sect /P 8 0 R /Pg 3 0 R /K [10 0 R] >>';
  objects[10] = '<< /Type /StructElem /S /P /P 9 0 R /K 0 >>';
  // A second top-level Sect, on the OTHER page, holding a Span that has
  // NEITHER a /Pg of its own NOR any bare-integer kid. That Span is the only
  // shape that reaches materializePg's bare-integer guard: `other` itself is
  // skipped by the earlier has('Pg') test, so without this element the guard
  // is unreachable and a mutation removing it measures nothing.
  objects[11] = '<< /Type /StructElem /S /Sect /P 8 0 R /Pg 4 0 R /K [12 0 R] >>';
  objects[12] = '<< /Type /StructElem /S /Span /P 11 0 R /K [] >>';
  return assemble(objects, 12, 1);
}

// A tagged page whose marked content names an MCID the /ParentTree does not
// map to any element.
//
// Hand-built because NOTHING this library authors can produce one: every MCID
// we write is wired to an element by allocContentMcid, and `Remove` deletes the
// BDC along with the mapping. So the widened UntaggedContent rule — which
// reports content whose MCID does not resolve — is reached by no fixture built
// the ordinary way, and is otherwise untested.

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

/** `dangling: true` nulls the /ParentTree slot the page's MCID 0 names, leaving
 *  a `BDC` that points at nothing. `false` builds the same page wired
 *  correctly, which is the control: the rule must stay silent for it. */
export function buildDanglingMcidPdf(dangling = true): Uint8Array {
  const content = '/P << /MCID 0 >> BDC 0 0 0 rg 10 10 20 20 re f EMC';
  const slot = dangling ? 'null' : '7 0 R';
  const objects: string[] = [];
  objects[1] = '<< /Type /Catalog /Pages 2 0 R /StructTreeRoot 6 0 R '
    + '/MarkInfo << /Marked true >> /Lang (en-US) >>';
  objects[2] = '<< /Type /Pages /Count 1 /Kids [3 0 R] /MediaBox [0 0 200 200] >>';
  objects[3] = '<< /Type /Page /Parent 2 0 R /StructParents 0 '
    + '/Resources << >> /Contents 4 0 R >>';
  objects[4] = streamObj(content);
  objects[5] = `<< /Nums [0 [${slot}]] >>`;
  objects[6] = '<< /Type /StructTreeRoot /K [7 0 R] /ParentTree 5 0 R /ParentTreeNextKey 1 >>';
  objects[7] = '<< /Type /StructElem /S /P /P 6 0 R /Pg 3 0 R /K 0 >>';
  return assemble(objects, 7, 1);
}

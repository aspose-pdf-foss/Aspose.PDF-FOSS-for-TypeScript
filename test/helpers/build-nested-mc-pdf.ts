// Tagged pages whose structure content item's BDC sits INSIDE a Form XObject.
//
// Raw content streams rather than the authoring API, because nothing this
// library writes puts an MCID-bearing BDC inside a form: markContentRegion
// wraps TOP-LEVEL spans, and flatten.ts appends its own BDC to page content
// rather than into the form it draws. So the nested path — and the
// copy-on-write it forces — is reached by no fixture built the ordinary way.

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

function streamObj(content: string, extra = ''): string {
  return `<< ${extra} /Length ${byteLen(content)} >>\nstream\n${content}\nendstream`;
}

const FORM_BODY = '/P << /MCID 0 >> BDC 0 0 1 rg 0 0 20 20 re f EMC';

/** One tagged page. Its only structure content item is an MCID-bearing BDC
 *  inside /Fm0, so retyping the element must reach into the form. */
export function buildNestedMcPdf(): Uint8Array {
  const objects: string[] = [];
  objects[1] = '<< /Type /Catalog /Pages 2 0 R /StructTreeRoot 6 0 R '
    + '/MarkInfo << /Marked true >> /Lang (en-US) >>';
  objects[2] = '<< /Type /Pages /Count 1 /Kids [3 0 R] /MediaBox [0 0 200 200] >>';
  objects[3] = '<< /Type /Page /Parent 2 0 R /StructParents 0 '
    + '/Resources << /XObject << /Fm0 5 0 R >> >> /Contents 4 0 R >>';
  objects[4] = streamObj('q 1 0 0 1 10 10 cm /Fm0 Do Q');
  objects[5] = streamObj(FORM_BODY, '/Type /XObject /Subtype /Form /BBox [0 0 20 20]');
  objects[6] = '<< /Type /StructTreeRoot /K [7 0 R] /ParentTree 8 0 R /ParentTreeNextKey 1 >>';
  objects[7] = '<< /Type /StructElem /S /P /P 6 0 R /Pg 3 0 R /K 0 >>';
  objects[8] = '<< /Nums [0 [7 0 R]] >>';
  return assemble(objects, 8, 1);
}

/** TWO tagged pages whose /Fm0 is the SAME form object, each with its own
 *  /StructParents key and its own element mapping MCID 0. Retyping page 0's
 *  element must copy-on-write the form and leave page 1 pointing at the
 *  original — the COW this feature forces, and the one shape where a rewrite
 *  in place would silently retag another page's content. */
export function buildSharedFormMcPdf(): Uint8Array {
  const objects: string[] = [];
  objects[1] = '<< /Type /Catalog /Pages 2 0 R /StructTreeRoot 7 0 R '
    + '/MarkInfo << /Marked true >> /Lang (en-US) >>';
  objects[2] = '<< /Type /Pages /Count 2 /Kids [3 0 R 4 0 R] /MediaBox [0 0 200 200] >>';
  objects[3] = '<< /Type /Page /Parent 2 0 R /StructParents 0 '
    + '/Resources << /XObject << /Fm0 6 0 R >> >> /Contents 5 0 R >>';
  objects[4] = '<< /Type /Page /Parent 2 0 R /StructParents 1 '
    + '/Resources << /XObject << /Fm0 6 0 R >> >> /Contents 5 0 R >>';
  objects[5] = streamObj('q 1 0 0 1 10 10 cm /Fm0 Do Q');
  objects[6] = streamObj(FORM_BODY, '/Type /XObject /Subtype /Form /BBox [0 0 20 20]');
  objects[7] = '<< /Type /StructTreeRoot /K [8 0 R 9 0 R] /ParentTree 10 0 R '
    + '/ParentTreeNextKey 2 >>';
  objects[8] = '<< /Type /StructElem /S /P /P 7 0 R /Pg 3 0 R /K 0 >>';
  objects[9] = '<< /Type /StructElem /S /P /P 7 0 R /Pg 4 0 R /K 0 >>';
  objects[10] = '<< /Nums [0 [8 0 R] 1 [9 0 R]] >>';
  return assemble(objects, 10, 1);
}

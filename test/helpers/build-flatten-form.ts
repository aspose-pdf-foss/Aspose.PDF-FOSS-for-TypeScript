const enc = (s: string) => new TextEncoder().encode(s);
const byteLen = (s: string) => enc(s).length;

/** Assemble a classic-xref PDF from a 1-based array of object bodies. */
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

function formXObject(extra: string, content: string): string {
  return `<< /Type /XObject /Subtype /Form ${extra} /Length ${byteLen(content)} >>\n` +
    `stream\n${content}\nendstream`;
}

/**
 * One-page form with two widgets to exercise flatten:
 *  - a text field `name` (V=Bob) with no /AP — GenerateAppearances synthesizes
 *    a single-stream appearance to bake.
 *  - a checkbox `agree` checked (/AS /Yes) with author-supplied /AP /N state
 *    streams (Yes = green box, Off = white box).
 * A non-widget /Text sticky note (obj 10) is also present to prove form-flatten
 * leaves non-widget annotations alone.
 */
export function buildFlattenFormTarget(): Uint8Array {
  const objects: string[] = [];
  objects[1] = `<< /Type /Catalog /Pages 2 0 R /AcroForm 5 0 R >>`;
  objects[2] = `<< /Type /Pages /Count 1 /Kids [3 0 R] /MediaBox [0 0 400 400] >>`;
  objects[3] = `<< /Type /Page /Parent 2 0 R /Resources << >> /Contents 4 0 R ` +
    `/Annots [6 0 R 7 0 R 10 0 R] >>`;
  objects[4] = `<< /Length 0 >>\nstream\n\nendstream`;
  objects[5] = `<< /Fields [6 0 R 7 0 R] /DA (/Helv 12 Tf 0 g) /NeedAppearances true >>`;
  objects[6] = `<< /FT /Tx /T (name) /V (Bob) /Type /Annot /Subtype /Widget /Rect [10 10 200 30] >>`;
  objects[7] = `<< /FT /Btn /T (agree) /V /Yes /AS /Yes /Type /Annot /Subtype /Widget ` +
    `/Rect [10 40 30 60] /AP << /N << /Yes 8 0 R /Off 9 0 R >> >> >>`;
  objects[8] = formXObject(`/BBox [0 0 20 20]`, `q 0 1 0 rg 0 0 20 20 re f Q`); // Yes: green
  objects[9] = formXObject(`/BBox [0 0 20 20]`, `q 1 1 1 rg 0 0 20 20 re f Q`); // Off: white
  objects[10] = `<< /Type /Annot /Subtype /Text /Rect [300 300 320 320] /Contents (note) /F 4 >>`;
  return assemble(objects, 10, 1);
}

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

/** Two pages exercising the annotation round-trip.
 *
 *  Page 0 carries a /Text note with a /Popup, a /Highlight that replies to the
 *  note (/IRT), a /Square, and a /Widget that must never be exported as an
 *  annotation. Page 1 carries a /Sound, which has no typed class in
 *  annotation.ts and no appearance generator. */
export function buildAnnotRoundtrip(): Uint8Array {
  const objects: string[] = [];
  objects[1] = `<< /Type /Catalog /Pages 2 0 R /AcroForm << /Fields [8 0 R] >> >>`;
  objects[2] = `<< /Type /Pages /Count 2 /Kids [3 0 R 4 0 R] /MediaBox [0 0 300 200] >>`;
  objects[3] = `<< /Type /Page /Parent 2 0 R /Annots [5 0 R 6 0 R 7 0 R 8 0 R] >>`;
  objects[4] = `<< /Type /Page /Parent 2 0 R /Annots [9 0 R] >>`;
  objects[5] = `<< /Type /Annot /Subtype /Text /NM (note-1) /Rect [10 20 30 40] ` +
               `/Contents (a note) /C [1 0 0] /T (Ada) /Popup 6 0 R /P 3 0 R >>`;
  objects[6] = `<< /Type /Annot /Subtype /Popup /NM (popup-1) /Rect [40 20 200 90] ` +
               `/Parent 5 0 R /Open true >>`;
  objects[7] = `<< /Type /Annot /Subtype /Highlight /NM (hi-1) /Rect [0 0 100 20] ` +
               `/QuadPoints [0 20 100 20 0 0 100 0] /C [1 1 0] /CA 0.4 /IRT 5 0 R ` +
               `/Contents (a reply) >>`;
  objects[8] = `<< /Type /Annot /Subtype /Widget /FT /Tx /T (field1) /V (v) /Rect [0 100 90 120] >>`;
  objects[9] = `<< /Type /Annot /Subtype /Sound /NM (snd-1) /Rect [5 5 25 25] >>`;
  return assemble(objects, 9, 1);
}

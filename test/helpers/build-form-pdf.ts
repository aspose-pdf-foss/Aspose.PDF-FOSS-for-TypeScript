const enc = (s: string) => new TextEncoder().encode(s);
const byteLen = (s: string) => enc(s).length;

/** One-page classic-xref PDF with an /AcroForm containing one of every field
 *  kind this library fills:
 *    text `name` (V=Bob), checkbox `agree` (Off, AP states Yes/Off),
 *    radio group `color` (V=Red, two kid widgets Red/Green),
 *    choice `size` (Opt S/M/L, V=M, stale /I), multiselect choice `tags`
 *    (Opt with an [export display] pair), hierarchical text `parent.child`
 *    (FT and V inherited from the parent), signature `sig`,
 *    editable combo `font` (combo+edit flags).
 *  Object layout: 1 Catalog, 2 Pages, 3 Page, 4 Contents, 5 AcroForm,
 *  6 text, 7 checkbox, 8 radio group, 9-10 radio kid widgets, 11 choice,
 *  12 parent field, 13 child field, 14 multiselect choice, 15 signature,
 *  16 dummy appearance stream, 17 editable combo. */
export function buildFormPdf(): Uint8Array {
  const objects: string[] = [];
  objects[1] = `<< /Type /Catalog /Pages 2 0 R /AcroForm 5 0 R >>`;
  objects[2] = `<< /Type /Pages /Count 1 /Kids [3 0 R] /MediaBox [0 0 400 400] >>`;
  objects[3] = `<< /Type /Page /Parent 2 0 R /Resources << >> /Contents 4 0 R /Annots [6 0 R 7 0 R 9 0 R 10 0 R 11 0 R 13 0 R] >>`;
  objects[4] = `<< /Length 0 >>\nstream\n\nendstream`;
  objects[5] = `<< /Fields [6 0 R 7 0 R 8 0 R 11 0 R 12 0 R 14 0 R 15 0 R 17 0 R] >>`;
  objects[6] = `<< /FT /Tx /T (name) /V (Bob) /Type /Annot /Subtype /Widget /Rect [10 10 200 30] >>`;
  objects[7] = `<< /FT /Btn /T (agree) /V /Off /AS /Off /Type /Annot /Subtype /Widget /Rect [10 40 30 60] /AP << /N << /Yes 16 0 R /Off 16 0 R >> >> >>`;
  objects[8] = `<< /FT /Btn /Ff 32768 /T (color) /V /Red /Kids [9 0 R 10 0 R] >>`;
  objects[9] = `<< /Parent 8 0 R /Type /Annot /Subtype /Widget /Rect [10 70 30 90] /AS /Red /AP << /N << /Red 16 0 R /Off 16 0 R >> >> >>`;
  objects[10] = `<< /Parent 8 0 R /Type /Annot /Subtype /Widget /Rect [40 70 60 90] /AS /Off /AP << /N << /Green 16 0 R /Off 16 0 R >> >> >>`;
  objects[11] = `<< /FT /Ch /T (size) /Opt [(S) (M) (L)] /V (M) /I [1] /Type /Annot /Subtype /Widget /Rect [10 100 100 120] >>`;
  objects[12] = `<< /FT /Tx /T (parent) /V (inherited) /Kids [13 0 R] >>`;
  objects[13] = `<< /T (child) /Parent 12 0 R /Type /Annot /Subtype /Widget /Rect [10 130 200 150] >>`;
  objects[14] = `<< /FT /Ch /Ff 2097152 /T (tags) /Opt [[(a) (Alpha)] (b) (c)] >>`;
  objects[15] = `<< /FT /Sig /T (sig) >>`;
  objects[16] = `<< /Length 0 >>\nstream\n\nendstream`;
  objects[17] = `<< /FT /Ch /Ff 393216 /T (font) /Opt [(Arial)] >>`;
  const maxObj = 17;

  let body = '%PDF-1.7\n%âãÏÓ\n';
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

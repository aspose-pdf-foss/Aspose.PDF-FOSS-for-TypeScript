const enc = (s: string) => new TextEncoder().encode(s);
const byteLen = (s: string) => enc(s).length;

/** One-page PDF whose /AcroForm holds the field kinds `build-form-pdf.ts` has
 *  no placeable widget for — push buttons and signatures.
 *
 *  Every widget here carries a /Rect AND sits in the page's /Annots, which the
 *  shared fixture's `tags` and `sig` do not: without both, `htmlforms.ts`
 *  correctly declines to place a control.
 *
 *    push button `submit`  — /A SubmitForm, /F a /FS /URL filespec, /MK /CA
 *    push button `reset`   — /A ResetForm
 *    push button `plain`   — no /A at all; must NOT convert
 *    signature   `signed`  — /V with /Name and /M
 *    signature   `unsigned`— no /V
 *
 *  Object layout: 1 Catalog, 2 Pages, 3 Page, 4 Contents, 5 AcroForm,
 *  6 submit, 7 reset, 8 plain, 9 signed sig, 10 unsigned sig,
 *  11 shared appearance stream, 12 signature value dict. */
export function buildFormButtonsPdf(): Uint8Array {
  const objects: string[] = [];
  objects[1] = `<< /Type /Catalog /Pages 2 0 R /AcroForm 5 0 R >>`;
  objects[2] = `<< /Type /Pages /Count 1 /Kids [3 0 R] /MediaBox [0 0 400 400] >>`;
  objects[3] = `<< /Type /Page /Parent 2 0 R /Resources << >> /Contents 4 0 R `
    + `/Annots [6 0 R 7 0 R 8 0 R 9 0 R 10 0 R] >>`;
  objects[4] = `<< /Length 0 >>\nstream\n\nendstream`;
  objects[5] = `<< /Fields [6 0 R 7 0 R 8 0 R 9 0 R 10 0 R] >>`;
  // /Ff 65536 is bit 17, Pushbutton.
  objects[6] = `<< /FT /Btn /Ff 65536 /T (submit) /Type /Annot /Subtype /Widget `
    + `/Rect [10 10 80 30] /AP << /N 11 0 R >> /MK << /CA (Send) >> `
    + `/A << /S /SubmitForm /F << /Type /Filespec /FS /URL /F (https://example.com/post) >> >> >>`;
  objects[7] = `<< /FT /Btn /Ff 65536 /T (reset) /Type /Annot /Subtype /Widget `
    + `/Rect [90 10 160 30] /AP << /N 11 0 R >> /A << /S /ResetForm >> >>`;
  objects[8] = `<< /FT /Btn /Ff 65536 /T (plain) /Type /Annot /Subtype /Widget `
    + `/Rect [170 10 240 30] /AP << /N 11 0 R >> >>`;
  objects[9] = `<< /FT /Sig /T (signed) /Type /Annot /Subtype /Widget `
    + `/Rect [10 50 200 80] /V 12 0 R >>`;
  objects[10] = `<< /FT /Sig /T (unsigned) /Type /Annot /Subtype /Widget `
    + `/Rect [10 90 200 120] >>`;
  // A real appearance, not an empty stream: suppression is only observable if
  // the widget actually draws something. A blue 70x20 fill.
  const ap = `0 0 1 rg 0 0 70 20 re f`;
  objects[11] = `<< /Type /XObject /Subtype /Form /BBox [0 0 70 20] `
    + `/Length ${byteLen(ap)} >>\nstream\n${ap}\nendstream`;
  objects[12] = `<< /Type /Sig /Name (Oleg Subachev) /M (D:20260818120000Z) >>`;
  const maxObj = 12;

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

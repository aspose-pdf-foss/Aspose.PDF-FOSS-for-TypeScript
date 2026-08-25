const enc = (s: string) => new TextEncoder().encode(s);
const byteLen = (s: string) => enc(s).length;

/** Single-page untagged PDF: one 24pt heading over 12pt body text, Helvetica.
 *  The body text dominates by character count, so headingRanks ranks 24pt as H1
 *  and leaves 12pt as body.
 *
 *  `gap` is the heading-to-body distance in points. The default of 30 clusters
 *  the two lines into ONE TextBlock, which is what exercises the per-line
 *  heading ranking in docmodel.ts. Pass a large gap to get two blocks — which
 *  is what `AutoTag` needs to see the heading at all, since it ranks per block
 *  (autotag.ts) and would otherwise emit a single P over both lines. */
export function buildUntaggedHtmlPdf(gap = 30): Uint8Array {
  const content = [
    'BT /F1 24 Tf 50 350 Td (Quarterly Report) Tj ET',
    `BT /F1 12 Tf 50 ${350 - gap} Td (Revenue grew twelve percent this year.) Tj ET`,
  ].join('\n');

  const o: string[] = [];
  o[1] = `<< /Type /Catalog /Pages 2 0 R >>`;
  o[2] = `<< /Type /Pages /Count 1 /Kids [3 0 R] /MediaBox [0 0 400 400] >>`;
  o[3] = `<< /Type /Page /Parent 2 0 R /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>`;
  o[4] = `<< /Length ${byteLen(content)} >>\nstream\n${content}\nendstream`;
  o[5] = `<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>`;
  const maxObj = 5;

  let body = '%PDF-1.7\n%\xE2\xE3\xCF\xD3\n';
  const offsets: number[] = new Array(maxObj + 1).fill(0);
  for (let n = 1; n <= maxObj; n++) {
    offsets[n] = byteLen(body);
    body += `${n} 0 obj\n${o[n]}\nendobj\n`;
  }
  const xrefOffset = byteLen(body);
  let xref = `xref\n0 ${maxObj + 1}\n0000000000 65535 f \n`;
  for (let n = 1; n <= maxObj; n++) xref += `${String(offsets[n]).padStart(10, '0')} 00000 n \n`;
  const trailer = `trailer\n<< /Size ${maxObj + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return enc(body + xref + trailer);
}

const enc = (s: string) => new TextEncoder().encode(s);
const byteLen = (s: string) => enc(s).length;

/** A one-page document whose page content is `content` verbatim, with /F1
 *  Helvetica and /F2 Courier in its resources.
 *
 *  Hand-assembled for `build-render-mode-pdf.ts`'s reason: the text state
 *  operators under test (`Tc`, `Tw`, `Tz`, `TL`, `Ts`, and `Tf` outside a text
 *  object) have no authoring option, and a fixture for g5x6 needs them set
 *  inside a `q` … `Q` that a caller spells out exactly. */
export function buildTextStatePdf(content: string, formContent?: string): Uint8Array {
  const stream = (s: string, dict = '') => `<< ${dict}/Length ${byteLen(s)} >>\nstream\n${s}\nendstream`;
  const objects: string[] = [];
  const xobj = formContent === undefined ? '' : ' /XObject << /Fm0 7 0 R >>';
  objects[1] = `<< /Type /Catalog /Pages 2 0 R >>`;
  objects[2] = `<< /Type /Pages /Count 1 /Kids [3 0 R] /MediaBox [0 0 612 792] >>`;
  objects[3] = `<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 5 0 R /F2 6 0 R >>${xobj} >> /Contents 4 0 R >>`;
  objects[4] = stream(content);
  objects[5] = `<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>`;
  objects[6] = `<< /Type /Font /Subtype /Type1 /BaseFont /Courier /Encoding /WinAnsiEncoding >>`;
  // A Form XObject with NO /Resources of its own, so its /F1 and /F2 resolve
  // through the page's — the fallback `walkScope` and 7.8.3 both allow.
  if (formContent !== undefined)
    objects[7] = stream(formContent, '/Type /XObject /Subtype /Form /BBox [0 0 612 792] ');

  const max = objects.length - 1;
  let body = '%PDF-1.7\n%\xE2\xE3\xCF\xD3\n';
  const offsets: number[] = [0];
  for (let n = 1; n <= max; n++) {
    offsets[n] = byteLen(body);
    body += `${n} 0 obj\n${objects[n]}\nendobj\n`;
  }
  const xrefOffset = byteLen(body);
  let xref = `xref\n0 ${max + 1}\n0000000000 65535 f \n`;
  for (let n = 1; n <= max; n++) xref += `${String(offsets[n]).padStart(10, '0')} 00000 n \n`;
  const trailer = `trailer\n<< /Size ${max + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return enc(body + xref + trailer);
}

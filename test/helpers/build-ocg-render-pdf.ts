// Optional-content RENDERING fixtures (q1g2.1). Distinct from build-ocg-pdf.ts,
// which exercises the OCG *API* — this one is built for pixels: a 200x200 page,
// two layers whose state the /D config fixes (Visible ON, Hidden OFF), and a
// caller-supplied content stream so each case writes exactly the marked content
// it means to test.
//
// The page resources name both layers in /Properties (/OCVis, /OCHid) and carry
// a form XObject (/Fm0, green), an image XObject (/Im0, magenta) and — when
// annotOc is given — a /Square annotation whose /AP paints cyan. Each of the
// three can be given an /OC of its own (q1g2.2); none has one by default, so
// the q1g2.1 cases that only mark content in the stream are unaffected.

const enc = (s: string) => new TextEncoder().encode(s);
const byteLen = (s: string) => enc(s).length;

/** The form's own ink: a 40x40 green square at the origin of its BBox. */
const FORM = '0 1 0 rg 0 0 40 40 re f\n';

export interface OcgRenderOpts {
  /** `/OC` written on the form XObject `/Fm0` — `7 0 R` is the Hidden layer. */
  formOc?: string;
  /** `/OC` written on the image XObject `/Im0`. */
  imageOc?: string;
  /** Add a `/Square` annotation with this `/OC` and an `/AP` that paints. */
  annotOc?: string;
  /** `/D /BaseState`. Default 'ON', so only `/OFF` hides. */
  baseState?: 'ON' | 'OFF';
  /** Refs put in `/D /ON`. Default none. */
  on?: number[];
  /** Refs put in `/D /OFF`. Default `[7]` — the Hidden layer. */
  off?: number[];
  /** Omit `/OCProperties` from the catalog entirely. */
  noOcProperties?: boolean;
}

/** One-page PDF with a Visible and a Hidden layer and the given content. */
export function buildOcgRenderPdf(content: string, opts: OcgRenderOpts = {}): Uint8Array {
  const refs = (ns: number[]) => ns.map((n) => `${n} 0 R`).join(' ');
  const on = opts.on ?? [];
  const off = opts.off ?? [7];

  const objects: string[] = [];
  objects[1] = `<< /Type /Catalog /Pages 2 0 R${opts.noOcProperties ? '' : ' /OCProperties 5 0 R'} >>`;
  objects[2] = `<< /Type /Pages /Count 1 /Kids [3 0 R] /MediaBox [0 0 200 200] >>`;
  objects[3] = `<< /Type /Page /Parent 2 0 R /Resources << /Properties << /OCVis 6 0 R /OCHid 7 0 R >> /XObject << /Fm0 8 0 R /Im0 10 0 R >> >> /Contents 4 0 R${opts.annotOc ? ' /Annots [13 0 R]' : ''} >>`;
  objects[4] = `<< /Length ${byteLen(content)} >>\nstream\n${content}endstream`;
  objects[5] = `<< /OCGs [6 0 R 7 0 R] /D 9 0 R >>`;
  objects[6] = `<< /Type /OCG /Name (Visible) >>`;
  objects[7] = `<< /Type /OCG /Name (Hidden) >>`;
  objects[8] = `<< /Type /XObject /Subtype /Form /BBox [0 0 40 40]`
    + `${opts.formOc ? ` /OC ${opts.formOc}` : ''} /Length ${byteLen(FORM)} >>\nstream\n${FORM}endstream`;
  objects[9] = `<< /Name (Default) /BaseState /${opts.baseState ?? 'ON'}`
    + `${on.length ? ` /ON [${refs(on)}]` : ''}`
    + `${off.length ? ` /OFF [${refs(off)}]` : ''}`
    + ` /Order [6 0 R 7 0 R] >>`;
  // 10: a 1x1 magenta image, scaled by the content stream's own `cm`.
  // ASCIIHex rather than raw bytes: this whole file is UTF-8 encoded at the end,
  // so a literal 0xFF would come out as two bytes and /Length would be a lie.
  const IMG = 'FF00FF>';
  objects[10] = `<< /Type /XObject /Subtype /Image /Width 1 /Height 1`
    + ` /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /ASCIIHexDecode`
    + `${opts.imageOc ? ` /OC ${opts.imageOc}` : ''} /Length ${IMG.length} >>\nstream\n${IMG}\nendstream`;
  // 11: the annotation's appearance — a 40x40 cyan square PLUS the word
  // `secretword` at its bottom-left, so ONE fixture serves both the pixel cases
  // and SearchAnnotations. The text sits well clear of the centre probe.
  const AP = '0 1 1 rg 0 0 40 40 re f\nBT /F1 8 Tf 2 3 Td (secretword) Tj ET\n';
  objects[11] = `<< /Type /XObject /Subtype /Form /BBox [0 0 40 40]`
    + ` /Resources << /Font << /F1 14 0 R >> >> /Length ${byteLen(AP)} >>\nstream\n${AP}endstream`;
  objects[12] = `<< /Type /OCMD /OCGs [7 0 R] >>`;
  objects[13] = `<< /Type /Annot /Subtype /Square /Rect [120 10 160 50]`
    + `${opts.annotOc ? ` /OC ${opts.annotOc}` : ''} /F 4`
    + ` /Contents (carried text) /AP << /N 11 0 R >> >>`;
  objects[14] = `<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>`;
  const maxObj = 14;

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

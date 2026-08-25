const enc = (s: string) => new TextEncoder().encode(s);
const byteLen = (s: string) => enc(s).length;

/** The /DR /Font /TiBo program: unreferenced, so the prune orphans it. */
export const DR_TIBO_PROGRAM_BYTES = 600;
/** The /DR /XObject /Im0 payload: unreferenced likewise. */
export const DR_IMAGE_BYTES = 300;

export interface DrPdfOptions {
  /** /AcroForm /XFA present — the hybrid-XFA veto. */
  xfa?: boolean;
  /** The widget's /AP /N claims /FlateDecode over garbage — the unreadable-appearance veto. */
  badAp?: boolean;
  /** The /AP names /GS0 through `gs`, but its own /Resources carries only /Font. */
  apUsesExtGState?: boolean;
  /** The /AP carries no /Resources at all and names /Helv2 through `Tf`. */
  apNoResources?: boolean;
  /** A FreeText annotation whose /DA names /TiIt. */
  freeText?: boolean;
}

/**
 * One-page form document whose /AcroForm /DR carries entries reached in every
 * way the pass must honour, plus entries nothing reaches:
 *
 *   /Font /Helv    <- the AcroForm-level /DA
 *   /Font /HeBo    <- the text field's /DA
 *   /Font /TiRo    <- a kid widget's own /DA
 *   /Font /TiIt    <- a FreeText annotation's /DA   (opts.freeText)
 *   /Font /Helv2   <- a /Resources-free /AP stream  (opts.apNoResources)
 *   /Font /TiBo    <- nothing; owns a font program of DR_TIBO_PROGRAM_BYTES
 *   /Font /Shared  <- nothing; its program is the page font's, so pruning it
 *                     orphans two dicts and no stream bytes
 *   /XObject /Im0  <- nothing; DR_IMAGE_BYTES of payload
 *   /ExtGState /GS0 <- an /AP that lacks it locally (opts.apUsesExtGState)
 */
export function buildDrPdf(opts: DrPdfOptions = {}): Uint8Array {
  const objects: string[] = [];
  const reserve = (): number => { objects.push(''); return objects.length; };
  const put = (n: number, body: string): number => { objects[n - 1] = body; return n; };
  const add = (body: string): number => put(reserve(), body);
  const stream = (dict: string, body: string): number =>
    add(`<< ${dict} /Length ${byteLen(body)} >>\nstream\n${body}\nendstream`);

  // Reserved up front: their bodies name objects allocated further down.
  const catalog = reserve(), pagesN = reserve(), pageN = reserve(), acroN = reserve();
  const textField = reserve(), noteField = reserve();

  const contents = stream('', 'BT /F1 12 Tf 20 200 Td (page text) Tj ET');

  // The page font and the program it shares with /DR /Font /Shared.
  const sharedProgram = stream('/Length1 400', 'S'.repeat(400));
  const sharedDescriptor = add(`<< /Type /FontDescriptor /FontName /PageFace /Flags 4 /FontFile2 ${sharedProgram} 0 R >>`);
  const pageFont = add(`<< /Type /Font /Subtype /TrueType /BaseFont /PageFace /FirstChar 32 /LastChar 32 /Widths [500] /FontDescriptor ${sharedDescriptor} 0 R >>`);

  const std = (base: string): number =>
    add(`<< /Type /Font /Subtype /Type1 /BaseFont /${base} /Encoding /WinAnsiEncoding >>`);
  const drHelv = std('Helvetica'), drHeBo = std('Helvetica-Bold');
  const drTiRo = std('Times-Roman'), drTiIt = std('Times-Italic');
  const drHelv2 = std('Helvetica');

  const tiboProgram = stream('/Length1 600', 'T'.repeat(DR_TIBO_PROGRAM_BYTES));
  const tiboDescriptor = add(`<< /Type /FontDescriptor /FontName /TiBoFace /Flags 4 /FontFile2 ${tiboProgram} 0 R >>`);
  const drTiBo = add(`<< /Type /Font /Subtype /TrueType /BaseFont /TiBoFace /FirstChar 32 /LastChar 32 /Widths [500] /FontDescriptor ${tiboDescriptor} 0 R >>`);
  const drShared = add(`<< /Type /Font /Subtype /TrueType /BaseFont /PageFace /FirstChar 32 /LastChar 32 /Widths [500] /FontDescriptor ${sharedDescriptor} 0 R >>`);

  const drImage = stream(
    '/Type /XObject /Subtype /Image /Width 10 /Height 10 /ColorSpace /DeviceGray /BitsPerComponent 8',
    'i'.repeat(DR_IMAGE_BYTES),
  );

  // The text field's appearance, in one of four shapes.
  const apBody = opts.apNoResources
    ? '/Tx BMC q BT /Helv2 9 Tf 2 5 Td (Bob) Tj ET Q EMC'
    : opts.apUsesExtGState
      ? '/Tx BMC q /GS0 gs BT /HeBo 9 Tf 2 5 Td (Bob) Tj ET Q EMC'
      : '/Tx BMC q BT /HeBo 9 Tf 2 5 Td (Bob) Tj ET Q EMC';
  const apResources = opts.apNoResources ? '' : `/Resources << /Font << /HeBo ${drHeBo} 0 R >> >>`;
  const apN = opts.badAp
    ? stream('/Type /XObject /Subtype /Form /BBox [0 0 190 20] /Filter /FlateDecode', 'not-deflate-data')
    : stream(`/Type /XObject /Subtype /Form /BBox [0 0 190 20] ${apResources}`, apBody);

  put(textField, `<< /FT /Tx /T (name) /V (Bob) /DA (/HeBo 9 Tf 0 g) /Type /Annot /Subtype /Widget /Rect [10 10 200 30] /AP << /N ${apN} 0 R >> >>`);
  const noteWidget = add(`<< /Parent ${noteField} 0 R /Type /Annot /Subtype /Widget /Rect [10 40 200 60] /DA (/TiRo 9 Tf 0 g) >>`);
  put(noteField, `<< /FT /Tx /T (note) /Kids [${noteWidget} 0 R] >>`);

  const freeText = opts.freeText
    ? add(`<< /Type /Annot /Subtype /FreeText /Rect [220 10 380 40] /Contents (memo) /DA (/TiIt 11 Tf 0 g) >>`)
    : 0;
  const xfa = opts.xfa ? stream('', '<xdp:xdp xmlns:xdp="http://ns.adobe.com/xdp/"></xdp:xdp>') : 0;

  const drFonts = [
    `/Helv ${drHelv} 0 R`, `/HeBo ${drHeBo} 0 R`, `/TiRo ${drTiRo} 0 R`,
    `/TiIt ${drTiIt} 0 R`, `/Helv2 ${drHelv2} 0 R`, `/TiBo ${drTiBo} 0 R`,
    `/Shared ${drShared} 0 R`,
  ].join(' ');
  const dr = `<< /Font << ${drFonts} >> /XObject << /Im0 ${drImage} 0 R >> /ExtGState << /GS0 << /Type /ExtGState /ca 0.5 >> >> >>`;

  put(acroN, `<< /Fields [${textField} 0 R ${noteField} 0 R] /DA (/Helv 0 Tf 0 g) /DR ${dr}${xfa ? ` /XFA ${xfa} 0 R` : ''} >>`);
  put(catalog, `<< /Type /Catalog /Pages ${pagesN} 0 R /AcroForm ${acroN} 0 R >>`);
  put(pagesN, `<< /Type /Pages /Count 1 /Kids [${pageN} 0 R] /MediaBox [0 0 400 400] >>`);
  const annots = [textField, noteWidget, freeText].filter((n) => n !== 0).map((n) => `${n} 0 R`).join(' ');
  put(pageN, `<< /Type /Page /Parent ${pagesN} 0 R /Resources << /Font << /F1 ${pageFont} 0 R >> >> /Contents ${contents} 0 R /Annots [${annots}] >>`);

  return assemble(objects);
}

/** An /AcroForm whose whole /DR is unreferenced: no /DA anywhere, no fields.
 *  The prune must take the /Font dict and /DR itself with it. */
export function buildBareDrPdf(): Uint8Array {
  const objects: string[] = [];
  const reserve = (): number => { objects.push(''); return objects.length; };
  const put = (n: number, body: string): number => { objects[n - 1] = body; return n; };
  const add = (body: string): number => put(reserve(), body);

  const catalog = reserve(), pagesN = reserve(), pageN = reserve(), acroN = reserve();
  const contents = add(`<< /Length 0 >>\nstream\n\nendstream`);
  const drTiBo = add(`<< /Type /Font /Subtype /Type1 /BaseFont /Times-Bold /Encoding /WinAnsiEncoding >>`);
  put(acroN, `<< /Fields [] /DR << /Font << /TiBo ${drTiBo} 0 R >> >> >>`);
  put(catalog, `<< /Type /Catalog /Pages ${pagesN} 0 R /AcroForm ${acroN} 0 R >>`);
  put(pagesN, `<< /Type /Pages /Count 1 /Kids [${pageN} 0 R] /MediaBox [0 0 400 400] >>`);
  put(pageN, `<< /Type /Page /Parent ${pagesN} 0 R /Resources << >> /Contents ${contents} 0 R >>`);
  return assemble(objects);
}

/** Wrap object bodies in a classic-xref file. */
function assemble(objects: string[]): Uint8Array {
  let body = '%PDF-1.7\n%âãÏÓ\n';
  const offsets: number[] = new Array(objects.length + 1).fill(0);
  for (let n = 1; n <= objects.length; n++) {
    offsets[n] = byteLen(body);
    body += `${n} 0 obj\n${objects[n - 1]}\nendobj\n`;
  }
  const xrefOffset = byteLen(body);
  let xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (let n = 1; n <= objects.length; n++) xref += `${String(offsets[n]).padStart(10, '0')} 00000 n \n`;
  const trailer = `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return enc(body + xref + trailer);
}

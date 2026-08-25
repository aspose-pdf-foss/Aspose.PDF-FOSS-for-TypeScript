const enc = (s: string) => new TextEncoder().encode(s);
const byteLen = (s: string) => enc(s).length;

/** Conformance target, mirroring src/pdfxvalidate.ts's PdfXLevel. */
export type PdfxBuildLevel = '1a' | '3' | '4' | '4p';

export interface PdfxOptions {
  // identification
  omitXmp?: boolean;            // drop /Root /Metadata
  pdfxVersion?: string;         // override pdfxid:GTS_PDFXVersion
  omitInfoVersion?: boolean;    // drop /Info /GTS_PDFXVersion (1a/3 only)
  // output intent
  omitOutputIntent?: boolean;   // drop /OutputIntents
  intentSubtype?: string;       // override /S (default GTS_PDFX)
  twoIntents?: boolean;         // two GTS_PDFX intents
  registeredNameOnly?: boolean; // /OutputConditionIdentifier, no /DestOutputProfile
  unregisteredNameOnly?: boolean; // an unregistered identifier and no profile
  conditionName?: string;       // override /OutputConditionIdentifier
  externalProfileRef?: boolean; // /DestOutputProfileRef instead (X-4p)
  iccN?: number;                // /DestOutputProfile /N (default 4)
  // structure
  omitTrapped?: boolean;        // drop /Info /Trapped
  trapped?: string;             // /Info /Trapped value (default 'False')
  omitTrimBox?: boolean;        // page has neither /TrimBox nor /ArtBox
  bothTrimAndArt?: boolean;     // page has both
  bleedOutsideMedia?: boolean;  // /BleedBox not inside /MediaBox
  headerVersion?: string;       // %PDF-x.y (default 1.4 for 1a/3, 1.6 for 4/4p)
  omitId?: boolean;             // omit trailer /ID
  // color
  contentColor?: 'k' | 'rg' | 'g';  // content color operator (default 'k')
  iccBasedSpace?: boolean;      // /Resources /ColorSpace with an /ICCBased array
  // fonts
  fontEmbedded?: boolean;       // default true: include /FontFile2
  // transparency / layers / files
  transparencyGroup?: boolean;  // page /Group /S /Transparency
  lowAlpha?: boolean;           // ExtGState /ca 0.5
  optionalContent?: boolean;    // catalog /OCProperties
  embeddedFile?: boolean;       // catalog /Names /EmbeddedFiles name tree
  // annotations / actions
  annotInsideTrim?: boolean;    // /Text annot whose /Rect overlaps the trim area
  movieAnnot?: boolean;         // /Movie annot, placed outside the trim area
  jsAction?: boolean;           // catalog /OpenAction /S /JavaScript
  // filters / halftone
  lzwStream?: boolean;          // an /LZWDecode-filtered stream object
  jpxImage?: boolean;           // image XObject with /JPXDecode
  transferFunction?: boolean;   // ExtGState /TR
  badHalftone?: boolean;        // ExtGState /HT of /HalftoneType 6
}

/** The GTS_PDFXVersion string a level declares. */
function versionString(level: PdfxBuildLevel): string {
  if (level === '1a') return 'PDF/X-1a:2003';
  if (level === '3') return 'PDF/X-3:2003';
  return 'PDF/X-4';
}

const isLegacy = (level: PdfxBuildLevel): boolean => level === '1a' || level === '3';

/** Build a PDF/X document. With no options the result is conformant at `level`. */
export function buildPdfxPdf(opts: PdfxOptions = {}, level: PdfxBuildLevel = '4'): Uint8Array {
  const header = opts.headerVersion ?? (isLegacy(level) ? '1.4' : '1.6');
  const version = opts.pdfxVersion ?? versionString(level);
  const external = opts.externalProfileRef ?? level === '4p';

  // --- content stream ---
  const colorOp = { k: '0 0 0 1 k\n', rg: '1 0 0 rg\n', g: '0 g\n' }[opts.contentColor ?? 'k'];
  const csOp = opts.iccBasedSpace ? '/CS0 cs 0 0 0 sc\n' : '';
  const content = `${colorOp}${csOp}BT /F1 12 Tf 50 50 Td (Hi) Tj ET\n`;

  const objects: string[] = [];

  // --- catalog ---
  const catParts = ['/Type /Catalog', '/Pages 2 0 R'];
  if (!opts.omitXmp) catParts.push('/Metadata 7 0 R');
  if (!opts.omitOutputIntent) {
    const subtype = opts.intentSubtype ?? 'GTS_PDFX';
    const condition = opts.conditionName
      ?? (opts.unregisteredNameOnly ? 'Bogus Condition' : 'CGATS TR 001');
    const tail = external
      ? '/DestOutputProfileRef << /Type /Filespec /FS /URL /F (http://example.com/profile.icc) >>'
      : opts.registeredNameOnly || opts.unregisteredNameOnly ? '' : '/DestOutputProfile 8 0 R';
    const oi = `<< /Type /OutputIntent /S /${subtype} /OutputConditionIdentifier (${condition}) `
      + `/OutputCondition (Commercial and specialty printing) /RegistryName (http://www.color.org) ${tail} >>`;
    const second = opts.twoIntents
      ? ' << /Type /OutputIntent /S /GTS_PDFX /OutputConditionIdentifier (FOGRA39) /DestOutputProfile 8 0 R >>'
      : '';
    catParts.push(`/OutputIntents [${oi}${second}]`);
  }
  if (opts.optionalContent) catParts.push('/OCProperties << /OCGs [] /D << >> >>');
  if (opts.jsAction) catParts.push('/OpenAction << /S /JavaScript /JS (app.alert\\(1\\);) >>');
  if (opts.embeddedFile) catParts.push('/Names << /EmbeddedFiles << /Names [(f) 16 0 R] >> >>');
  objects[1] = `<< ${catParts.join(' ')} >>`;

  objects[2] = '<< /Type /Pages /Count 1 /Kids [3 0 R] >>';

  // --- page ---
  const pageParts = ['/Type /Page', '/Parent 2 0 R', '/Contents 4 0 R', '/MediaBox [0 0 200 200]'];
  pageParts.push(opts.bleedOutsideMedia ? '/BleedBox [-10 -10 210 210]' : '/BleedBox [5 5 195 195]');
  if (!opts.omitTrimBox) pageParts.push('/TrimBox [10 10 190 190]');
  if (opts.bothTrimAndArt) pageParts.push('/ArtBox [10 10 190 190]');

  const res = ['/Font << /F1 5 0 R >>'];
  if (opts.iccBasedSpace) res.push('/ColorSpace << /CS0 [/ICCBased 8 0 R] >>');
  if (opts.jpxImage) res.push('/XObject << /Img 11 0 R >>');
  const egs: string[] = [];
  if (opts.lowAlpha) egs.push('/GSa << /Type /ExtGState /ca 0.5 >>');
  if (opts.transferFunction) egs.push('/GSt << /Type /ExtGState /TR /Identity >>');
  if (opts.badHalftone) egs.push('/GSh << /Type /ExtGState /HT << /HalftoneType 6 >> >>');
  if (egs.length) res.push(`/ExtGState << ${egs.join(' ')} >>`);
  pageParts.push(`/Resources << ${res.join(' ')} >>`);

  if (opts.transparencyGroup) pageParts.push('/Group << /S /Transparency >>');
  const annots: string[] = [];
  if (opts.annotInsideTrim) annots.push('14 0 R');
  if (opts.movieAnnot) annots.push('15 0 R');
  if (annots.length) pageParts.push(`/Annots [${annots.join(' ')}]`);
  objects[3] = `<< ${pageParts.join(' ')} >>`;

  objects[4] = `<< /Length ${byteLen(content)} >>\nstream\n${content}endstream`;

  // --- font ---
  const descParts = ['/Type /FontDescriptor', '/FontName /AAAAAA+Sub', '/Flags 32'];
  if (opts.fontEmbedded ?? true) descParts.push('/FontFile2 6 0 R');
  objects[5] = '<< /Type /Font /Subtype /TrueType /BaseFont /AAAAAA+Sub /FirstChar 32 /LastChar 32 '
    + '/Widths [500] /Encoding /WinAnsiEncoding /FontDescriptor 10 0 R >>';
  objects[10] = `<< ${descParts.join(' ')} >>`;
  if (opts.fontEmbedded ?? true) objects[6] = '<< /Length 4 /Length1 4 >>\nstream\ntrue\nendstream';

  // --- metadata ---
  if (!opts.omitXmp) {
    const xmp = xmpPacket(version);
    objects[7] = `<< /Type /Metadata /Subtype /XML /Length ${byteLen(xmp)} >>\nstream\n${xmp}endstream`;
  }

  // --- ICC output profile ---
  objects[8] = `<< /N ${opts.iccN ?? 4} /Length 4 >>\nstream\nICC \nendstream`;

  // --- optional extras ---
  if (opts.jpxImage) {
    objects[11] = '<< /Type /XObject /Subtype /Image /Width 1 /Height 1 /ColorSpace /DeviceGray '
      + '/BitsPerComponent 8 /Filter /JPXDecode /Length 1 >>\nstream\n\x00\nendstream';
  }
  if (opts.lzwStream) objects[12] = '<< /Length 1 /Filter /LZWDecode >>\nstream\n\x00\nendstream';
  if (opts.annotInsideTrim) objects[14] = '<< /Type /Annot /Subtype /Text /Rect [50 50 60 60] /F 4 >>';
  if (opts.movieAnnot) objects[15] = '<< /Type /Annot /Subtype /Movie /Rect [0 0 5 5] /F 4 >>';
  if (opts.embeddedFile) objects[16] = '<< /Type /Filespec /F (attach.txt) /EF << /F 17 0 R >> >>';
  if (opts.embeddedFile) objects[17] = '<< /Type /EmbeddedFile /Length 2 >>\nstream\nhi\nendstream';

  // --- info ---
  const infoParts = ['/Title (Clean)'];
  if (!opts.omitTrapped) infoParts.push(`/Trapped /${opts.trapped ?? 'False'}`);
  if (isLegacy(level) && !opts.omitInfoVersion) infoParts.push(`/GTS_PDFXVersion (${version})`);
  const infoNum = 9;
  objects[infoNum] = `<< ${infoParts.join(' ')} >>`;

  // --- assemble ---
  const maxObj = objects.reduce((m, _, i) => (objects[i] !== undefined ? i : m), 0);
  let body = `%PDF-${header}\n%\xE2\xE3\xCF\xD3\n`;
  const offsets: number[] = new Array(maxObj + 1).fill(0);
  for (let n = 1; n <= maxObj; n++) {
    if (objects[n] === undefined) continue;
    offsets[n] = byteLen(body);
    body += `${n} 0 obj\n${objects[n]}\nendobj\n`;
  }
  const xrefOffset = byteLen(body);
  let xref = `xref\n0 ${maxObj + 1}\n0000000000 65535 f \n`;
  for (let n = 1; n <= maxObj; n++) {
    xref += objects[n] === undefined
      ? '0000000000 00000 f \n'
      : `${String(offsets[n]).padStart(10, '0')} 00000 n \n`;
  }
  const trailerParts = [`/Size ${maxObj + 1}`, '/Root 1 0 R', `/Info ${infoNum} 0 R`];
  if (!opts.omitId) trailerParts.push('/ID [<00112233445566778899aabbccddeeff> <00112233445566778899aabbccddeeff>]');
  const trailer = `trailer\n<< ${trailerParts.join(' ')} >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return enc(body + xref + trailer);
}

function xmpPacket(version: string): string {
  return `<?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d"?>\n`
    + `<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">`
    + `<rdf:Description rdf:about="" xmlns:pdfxid="http://www.npes.org/pdfx/ns/id/" `
    + `pdfxid:GTS_PDFXVersion="${version}"/>`
    + `<rdf:Description rdf:about="" xmlns:dc="http://purl.org/dc/elements/1.1/">`
    + `<dc:title><rdf:Alt><rdf:li xml:lang="x-default">Clean</rdf:li></rdf:Alt></dc:title>`
    + `</rdf:Description></rdf:RDF></x:xmpmeta>\n<?xpacket end="w"?>`;
}

const enc = (s: string) => new TextEncoder().encode(s);
const byteLen = (s: string) => enc(s).length;

export interface PdfaOptions {
  // file / structure
  omitId?: boolean;           // omit trailer /ID
  headerVersion?: string;     // %PDF-x.y header (default '1.7')
  catalogVersion?: string;    // catalog /Version name (default omitted)
  externalStream?: boolean;   // give the content stream an /F external ref
  lzwStream?: boolean;        // filter the content stream with /LZWDecode
  psXObject?: boolean;        // add a /Subtype /PS XObject to resources
  refXObject?: boolean;       // add a Form XObject with /Ref
  optionalContent?: boolean;  // add catalog /OCProperties
  // metadata
  omitMetadata?: boolean;     // omit /Root /Metadata
  pdfaPart?: string;          // pdfaid:part value (default matches `part`)
  pdfaConformance?: string;   // pdfaid:conformance value (default 'B')
  infoTitle?: string | null;  // /Info /Title (default 'Clean'); null omits /Info
  xmpTitle?: string;          // dc:title (default 'Clean'); set ≠ infoTitle to break consistency
  // color / output intent
  omitOutputIntent?: boolean; // drop the /OutputIntents entry
  badIccN?: boolean;          // give /DestOutputProfile an /N of 2
  deviceColorContent?: boolean; // content uses `rg` device color (default true)
  // fonts
  fontEmbedded?: boolean;     // default true: include /FontFile2 in the descriptor
  symbolicWithEncoding?: boolean; // symbolic TrueType that wrongly has /Encoding
  omitCidSet?: boolean;       // (with type0 font) drop /CIDSet
  type0?: boolean;            // use a Type0/CIDFontType2 font instead of simple
  omitToUnicode?: boolean;    // drop /ToUnicode and use a non-standard encoding
  diffEncodingNoToUnicode?: boolean; // simple font: /Encoding dict with /Differences, no BaseEncoding, no /ToUnicode
  // transparency
  transparencyGroup?: boolean; // page /Group /S /Transparency
  lowAlpha?: boolean;          // ExtGState /ca 0.5
  nonStandardBlend?: boolean;  // ExtGState /BM /FunkyBlend
  // annotations / forms / actions
  annotNoAp?: boolean;         // add a /Text annot with no /AP
  movieAnnot?: boolean;        // add a /Movie annot
  hiddenAnnot?: boolean;       // add an annot with the Hidden flag
  jsAction?: boolean;          // catalog /OpenAction /S /JavaScript
  additionalAction?: boolean;  // catalog /AA
  needAppearances?: boolean;   // AcroForm /NeedAppearances true
  xfa?: boolean;               // AcroForm /XFA
  // images / content scan
  jpxImage?: boolean;          // image XObject with /JPXDecode
  interpolateImage?: boolean;  // image XObject with /Interpolate true
  badRenderingIntent?: boolean;// content `/Bogus ri`
  inlineLzwImage?: boolean;    // inline image with /LZW filter abbreviation
}

export function buildPdfaPdf(opts: PdfaOptions = {}, part: 1 | 2 | 3 = 2): Uint8Array {
  const header = opts.headerVersion ?? '1.7';
  const infoTitle = opts.infoTitle === undefined ? 'Clean' : opts.infoTitle;
  const xmpTitle = opts.xmpTitle ?? 'Clean';
  const pdfaPart = opts.pdfaPart ?? String(part);
  const pdfaConf = opts.pdfaConformance ?? 'B';

  // --- content stream ---
  const colorOp = (opts.deviceColorContent ?? true) ? '1 0 0 rg\n' : '';
  const riOp = opts.badRenderingIntent ? '/Bogus ri\n' : '';
  const inlineImg = opts.inlineLzwImage
    ? 'q 1 0 0 1 0 0 cm BI /W 1 /H 1 /CS /G /F /LZW ID \x00 EI Q\n' : '';
  const content = `${colorOp}${riOp}${inlineImg}BT /F1 12 Tf 50 50 Td (Hi) Tj ET\n`;

  // --- objects (raw PDF text, indices are object numbers) ---
  const objects: string[] = [];

  const catParts = ['/Type /Catalog', '/Pages 2 0 R', '/Metadata 7 0 R'];
  if (!opts.omitOutputIntent) catParts.push('/OutputIntents [<< /Type /OutputIntent /S /GTS_PDFA1 /OutputConditionIdentifier (sRGB) /DestOutputProfile 8 0 R >>]');
  if (opts.catalogVersion) catParts.push(`/Version /${opts.catalogVersion}`);
  if (opts.optionalContent) catParts.push('/OCProperties << /OCGs [] /D << >> >>');
  if (opts.jsAction) catParts.push('/OpenAction << /S /JavaScript /JS (app.alert\\(1\\);) >>');
  if (opts.additionalAction) catParts.push('/AA << /WC << /S /JavaScript /JS (x) >> >>');
  const acro: string[] = [];
  if (opts.needAppearances) acro.push('/NeedAppearances true');
  if (opts.xfa) acro.push('/XFA 9 0 R');
  if (acro.length) catParts.push(`/AcroForm << /Fields [] ${acro.join(' ')} >>`);
  if (opts.omitMetadata) {
    const i = catParts.indexOf('/Metadata 7 0 R');
    catParts.splice(i, 1);
  }
  objects[1] = `<< ${catParts.join(' ')} >>`;

  objects[2] = '<< /Type /Pages /Count 1 /Kids [3 0 R] /MediaBox [0 0 200 200] >>';

  // page
  const pageParts = ['/Type /Page', '/Parent 2 0 R', '/Contents 4 0 R'];
  const res = ['/Font << /F1 5 0 R >>'];
  const xobjs: string[] = [];
  if (opts.psXObject) xobjs.push('/PSX 10 0 R');
  if (opts.refXObject) xobjs.push('/RefX 11 0 R');
  if (opts.jpxImage) xobjs.push('/Img 12 0 R');
  if (opts.interpolateImage) xobjs.push('/ImgI 13 0 R');
  if (xobjs.length) res.push(`/XObject << ${xobjs.join(' ')} >>`);
  const egs: string[] = [];
  if (opts.lowAlpha) egs.push('/GSa << /Type /ExtGState /ca 0.5 >>');
  if (opts.nonStandardBlend) egs.push('/GSb << /Type /ExtGState /BM /FunkyBlend >>');
  if (egs.length) res.push(`/ExtGState << ${egs.join(' ')} >>`);
  pageParts.push(`/Resources << ${res.join(' ')} >>`);
  if (opts.transparencyGroup) pageParts.push('/Group << /S /Transparency >>');
  const annots: string[] = [];
  if (opts.annotNoAp) annots.push('14 0 R');
  if (opts.movieAnnot) annots.push('15 0 R');
  if (opts.hiddenAnnot) annots.push('16 0 R');
  if (annots.length) pageParts.push(`/Annots [${annots.join(' ')}]`);
  objects[3] = `<< ${pageParts.join(' ')} >>`;

  // content stream
  const streamFilter = opts.lzwStream ? ' /Filter /LZWDecode' : '';
  const streamExt = opts.externalStream ? ' /F (external.dat)' : '';
  objects[4] = `<< /Length ${byteLen(content)}${streamFilter}${streamExt} >>\nstream\n${content}endstream`;

  // font
  if (opts.type0) {
    const descParts = ['/Type /FontDescriptor', '/FontName /AAAAAA+Sub', '/Flags 4'];
    if (opts.fontEmbedded ?? true) descParts.push('/FontFile2 6 0 R');
    if (!opts.omitCidSet) descParts.push('/CIDSet 17 0 R');
    objects[5] = '<< /Type /Font /Subtype /Type0 /BaseFont /AAAAAA+Sub /Encoding /Identity-H /DescendantFonts [18 0 R]'
      + (opts.omitToUnicode ? '' : ' /ToUnicode 19 0 R') + ' >>';
    objects[18] = `<< /Type /Font /Subtype /CIDFontType2 /BaseFont /AAAAAA+Sub /CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> /FontDescriptor 20 0 R >>`;
    objects[20] = `<< ${descParts.join(' ')} >>`;
    if (!opts.omitCidSet) objects[17] = '<< /Length 1 >>\nstream\n\x00\nendstream';
    if (!opts.omitToUnicode) objects[19] = '<< /Length 0 >>\nstream\n\nendstream';
  } else if (opts.diffEncodingNoToUnicode) {
    // /Differences encoding with no BaseEncoding and no /ToUnicode: the validator
    // flags ToUnicode at level u; the named glyph is resolvable for synthesis.
    objects[5] = '<< /Type /Font /Subtype /TrueType /BaseFont /AAAAAA+Sub /FirstChar 65 /LastChar 65 /Widths [500] '
      + '/FontDescriptor 21 0 R /Encoding << /Type /Encoding /Differences [65 /Aacute] >> >>';
    objects[21] = '<< /Type /FontDescriptor /FontName /AAAAAA+Sub /Flags 32 /FontFile2 6 0 R >>';
  } else {
    const descParts = ['/Type /FontDescriptor', '/FontName /AAAAAA+Sub', '/Flags 32'];
    if (opts.fontEmbedded ?? true) descParts.push('/FontFile2 6 0 R');
    const fontParts = ['/Type /Font', '/Subtype /TrueType', '/BaseFont /AAAAAA+Sub',
      '/FirstChar 32', '/LastChar 32', '/Widths [500]', '/FontDescriptor 21 0 R'];
    if (opts.symbolicWithEncoding) { descParts[2] = '/Flags 4'; fontParts.push('/Encoding /WinAnsiEncoding'); }
    else if (!opts.omitToUnicode) fontParts.push('/Encoding /WinAnsiEncoding');
    else fontParts.push('/Encoding /MacExpertEncoding'); // non-standard for ToUnicode purposes
    objects[5] = `<< ${fontParts.join(' ')} >>`;
    objects[21] = `<< ${descParts.join(' ')} >>`;
  }
  if (opts.fontEmbedded ?? true) objects[6] = '<< /Length 4 /Length1 4 >>\nstream\ntrue\nendstream';

  // metadata (XMP with pdfaid)
  const xmp = xmpPacket(pdfaPart, pdfaConf, xmpTitle);
  objects[7] = `<< /Type /Metadata /Subtype /XML /Length ${byteLen(xmp)} >>\nstream\n${xmp}endstream`;

  // ICC output profile
  const iccN = opts.badIccN ? 2 : 3;
  objects[8] = `<< /N ${iccN} /Length 4 >>\nstream\nICC \nendstream`;

  if (opts.xfa) objects[9] = '<< /Length 4 >>\nstream\nxfa\nendstream';
  if (opts.psXObject) objects[10] = '<< /Type /XObject /Subtype /PS /Length 0 >>\nstream\n\nendstream';
  if (opts.refXObject) objects[11] = '<< /Type /XObject /Subtype /Form /Ref << /F << >> /Page 0 >> /BBox [0 0 1 1] /Length 0 >>\nstream\n\nendstream';
  if (opts.jpxImage) objects[12] = '<< /Type /XObject /Subtype /Image /Width 1 /Height 1 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /JPXDecode /Length 1 >>\nstream\n\x00\nendstream';
  if (opts.interpolateImage) objects[13] = '<< /Type /XObject /Subtype /Image /Width 1 /Height 1 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Interpolate true /Length 1 >>\nstream\n\x00\nendstream';
  if (opts.annotNoAp) objects[14] = '<< /Type /Annot /Subtype /Text /Rect [0 0 10 10] /F 4 >>';
  if (opts.movieAnnot) objects[15] = '<< /Type /Annot /Subtype /Movie /Rect [0 0 10 10] /F 4 >>';
  if (opts.hiddenAnnot) objects[16] = '<< /Type /Annot /Subtype /Text /Rect [0 0 10 10] /F 6 /AP << /N 22 0 R >> >>';
  if (opts.hiddenAnnot) objects[22] = '<< /Type /XObject /Subtype /Form /BBox [0 0 10 10] /Length 0 >>\nstream\n\nendstream';

  // info
  const infoNum = 23;
  if (infoTitle !== null) objects[infoNum] = `<< /Title (${infoTitle}) >>`;

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
  const trailerParts = [`/Size ${maxObj + 1}`, '/Root 1 0 R'];
  if (infoTitle !== null) trailerParts.push(`/Info ${infoNum} 0 R`);
  if (!opts.omitId) trailerParts.push('/ID [<00112233445566778899aabbccddeeff> <00112233445566778899aabbccddeeff>]');
  const trailer = `trailer\n<< ${trailerParts.join(' ')} >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return enc(body + xref + trailer);
}

function xmpPacket(part: string, conformance: string, title: string): string {
  return `<?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d"?>\n`
    + `<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">`
    + `<rdf:Description rdf:about="" xmlns:pdfaid="http://www.aiim.org/pdfa/ns/id/" `
    + `pdfaid:part="${part}" pdfaid:conformance="${conformance}"/>`
    + `<rdf:Description rdf:about="" xmlns:dc="http://purl.org/dc/elements/1.1/">`
    + `<dc:title><rdf:Alt><rdf:li xml:lang="x-default">${title}</rdf:li></rdf:Alt></dc:title>`
    + `</rdf:Description></rdf:RDF></x:xmpmeta>\n<?xpacket end="w"?>`;
}

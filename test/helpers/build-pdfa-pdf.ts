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
  perms?: 'ok' | 'bad';          // catalog /Perms with /DocMDP only, or with /UR3
  needsRendering?: boolean;      // catalog /NeedsRendering true
  requirements?: boolean;        // catalog /Requirements array
  alternatePresentations?: boolean; // /Names /AlternatePresentations
  presSteps?: boolean;           // page /PresSteps
  // /Names /EmbeddedFiles. 'bare' omits everything; 'noUf' and 'noMime' each
  // omit ONE thing, so the filespec-key and MIME branches can be pinned apart.
  embeddedFile?: 'full' | 'bare' | 'noUf' | 'noMime';
  // metadata
  omitMetadata?: boolean;     // omit /Root /Metadata
  pdfaPart?: string;          // pdfaid:part value (default matches `part`)
  pdfaConformance?: string;   // pdfaid:conformance value (default 'B')
  infoTitle?: string | null;  // /Info /Title (default 'Clean'); null omits /Info
  xmpTitle?: string;          // dc:title (default 'Clean'); set ≠ infoTitle to break consistency
  pdfaRev?: string | null;    // pdfaid:rev value; null omits it (part 4 defaults to '2020')
  omitConformance?: boolean;  // force pdfaid:conformance absent regardless of part
  pieceInfo?: boolean;        // catalog /PieceInfo (part 4: what makes /Info legal)
  infoModDateOnly?: boolean;  // /Info holds only /ModDate instead of /Title
  infoWithModDate?: boolean;  // /Info holds /Title AND /ModDate (part-4 conversion)
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
  badToUnicode?: boolean;     // ToUnicode CMap mapping a code to U+0000
  ocConfigNoName?: boolean;   // /OCProperties /D with no /Name
  diffEncodingNoToUnicode?: boolean; // simple font: /Encoding dict with /Differences, no BaseEncoding, no /ToUnicode
  // transparency
  transparencyGroup?: boolean; // page /Group /S /Transparency
  lowAlpha?: boolean;          // ExtGState /ca 0.5
  nonStandardBlend?: boolean;  // ExtGState /BM /FunkyBlend
  groupNoCs?: boolean;         // page /Group /S /Transparency with no /CS
  trExtGState?: boolean;        // ExtGState with /TR
  tr2ExtGState?: boolean;       // ExtGState with a /TR2 that is not /Default
  htoExtGState?: boolean;       // ExtGState with /HTO
  badHalftone?: boolean;        // ExtGState /HT with /HalftoneType 6 and NO name
  halftoneName?: boolean;       // ExtGState /HT type 1 carrying /HalftoneName
  imageAlternates?: boolean;    // image XObject with /Alternates
  imageOpi?: boolean;           // image XObject with /OPI
  badBitsPerComponent?: boolean;// image XObject with /BitsPerComponent 12
  bpc16Image?: boolean;         // image XObject with /BitsPerComponent 16
  formOpi?: boolean;            // Form XObject with /OPI
  destOutputProfileRef?: boolean; // OutputIntent with /DestOutputProfileRef
  twoPdfaOutputIntents?: boolean; // two GTS_PDFA1 intents sharing one profile
  pdfxIntentProfileRef?: boolean; // a GTS_PDFX intent carrying /DestOutputProfileRef
  // annotations / forms / actions
  annotNoAp?: boolean;         // add a /Text annot with no /AP
  movieAnnot?: boolean;        // add a /Movie annot
  hiddenAnnot?: boolean;       // add an annot with the Hidden flag
  jsAction?: boolean;          // catalog /OpenAction /S /JavaScript
  launchAction?: boolean;      // catalog /OpenAction /S /Launch (prohibited everywhere)
  setOcgStateAction?: boolean; // catalog /OpenAction /S /SetOCGState (permitted at 4e only)
  additionalAction?: boolean;  // catalog /AA
  needAppearances?: boolean;   // AcroForm /NeedAppearances true
  xfa?: boolean;               // AcroForm /XFA
  fileAttachAnnot?: boolean;   // add a /FileAttachment annot (part-4 prohibited)
  threeDAnnot?: boolean;       // add a /3D annot (prohibited at 4, allowed at 4e)
  toggleNoViewAnnot?: boolean; // annot with the ToggleNoView flag (bit 9)
  apWithDown?: boolean;        // annot whose /AP carries /D beside /N
  widgetWithAction?: boolean;  // a /Widget annot carrying /A
  widgetWithAA?: boolean;      // a /Widget annot carrying /AA (parts 1-3 ban it)
  extraStreamKeys?: boolean;   // content stream also carries /FFilter
  // images / content scan
  jpxImage?: boolean;          // image XObject with /JPXDecode
  interpolateImage?: boolean;  // image XObject with /Interpolate true
  badRenderingIntent?: boolean;// content `/Bogus ri`
  inlineLzwImage?: boolean;    // inline image with /LZW filter abbreviation
}

export function buildPdfaPdf(opts: PdfaOptions = {}, part: 1 | 2 | 3 | 4 = 2): Uint8Array {
  const header = opts.headerVersion ?? (part === 4 ? '2.0' : '1.7');
  // PDF/A-4 near-bans /Info, so the clean part-4 fixture has none.
  const defaultInfo = part === 4 ? null : 'Clean';
  const infoTitle = opts.infoTitle === undefined ? defaultInfo : opts.infoTitle;
  const xmpTitle = opts.xmpTitle ?? 'Clean';
  const pdfaPart = opts.pdfaPart ?? String(part);
  // Part 4's base conformance is ABSENT; 4e/4f pass 'E'/'F' explicitly.
  const pdfaConf = opts.omitConformance ? null
    : opts.pdfaConformance ?? (part === 4 ? null : 'B');
  const pdfaRev = opts.pdfaRev === undefined ? (part === 4 ? '2020' : null) : opts.pdfaRev;

  // --- content stream ---
  const colorOp = (opts.deviceColorContent ?? true) ? '1 0 0 rg\n' : '';
  const riOp = opts.badRenderingIntent ? '/Bogus ri\n' : '';
  const inlineImg = opts.inlineLzwImage
    ? 'q 1 0 0 1 0 0 cm BI /W 1 /H 1 /CS /G /F /LZW ID \x00 EI Q\n' : '';
  const content = `${colorOp}${riOp}${inlineImg}BT /F1 12 Tf 50 50 Td (Hi) Tj ET\n`;

  // --- objects (raw PDF text, indices are object numbers) ---
  const objects: string[] = [];

  const catParts = ['/Type /Catalog', '/Pages 2 0 R', '/Metadata 7 0 R'];
  if (!opts.omitOutputIntent) {
    const dopr = opts.destOutputProfileRef ? ' /DestOutputProfileRef << /DOS (x) >>' : '';
    const oi = `<< /Type /OutputIntent /S /GTS_PDFA1 /OutputConditionIdentifier (sRGB) /DestOutputProfile 8 0 R${dopr} >>`;
    // The two intents share ONE profile object, so pdfaOutputIntentProfile sees
    // a single distinct profile and only the count rule (6.2.3) can fire.
    const entries = opts.twoPdfaOutputIntents ? `${oi} ${oi}` : oi;
    // A PDF/X intent beside the PDF/A one: legal at every part, and the place
    // /DestOutputProfileRef is EXEMPT at parts 2/3 but not at part 4.
    const px = ' << /Type /OutputIntent /S /GTS_PDFX /OutputConditionIdentifier (none) /DestOutputProfileRef << /DOS (x) >> >>';
    catParts.push(`/OutputIntents [${entries}${opts.pdfxIntentProfileRef ? px : ''}]`);
  }
  if (opts.catalogVersion) catParts.push(`/Version /${opts.catalogVersion}`);
  if (opts.optionalContent) catParts.push('/OCProperties << /OCGs [] /D << /Name (Default) >> >>');
  if (opts.ocConfigNoName) catParts.push('/OCProperties << /OCGs [] /D << >> >>');
  if (opts.pieceInfo) catParts.push('/PieceInfo << /Test << /LastModified (D:20260904000000Z) /Private 0 >> >>');
  if (opts.perms === 'ok') catParts.push('/Perms << /DocMDP 29 0 R >>');
  if (opts.perms === 'bad') catParts.push('/Perms << /DocMDP 29 0 R /UR3 29 0 R >>');
  if (opts.needsRendering) catParts.push('/NeedsRendering true');
  if (opts.requirements) catParts.push('/Requirements [<< /Type /Requirement /S /EnableJavaScripts >>]');
  // One /Names dictionary, merged — Task 8 adds /EmbeddedFiles to the same key.
  const nameTree: string[] = [];
  if (opts.alternatePresentations) nameTree.push('/AlternatePresentations << /Names [] >>');
  if (opts.embeddedFile) nameTree.push('/EmbeddedFiles << /Names [(a) 33 0 R] >>');
  if (nameTree.length) catParts.push(`/Names << ${nameTree.join(' ')} >>`);
  if (opts.jsAction) catParts.push('/OpenAction << /S /JavaScript /JS (app.alert\\(1\\);) >>');
  // Each /OpenAction option is mutually exclusive with the others; a fixture
  // sets one, since the catalog has a single such key.
  if (opts.launchAction) catParts.push('/OpenAction << /S /Launch /F (x.exe) >>');
  if (opts.setOcgStateAction) catParts.push('/OpenAction << /S /SetOCGState /State [] >>');
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
  if (opts.imageAlternates) xobjs.push('/ImgA 30 0 R');
  if (opts.imageOpi) xobjs.push('/ImgO 35 0 R');
  if (opts.bpc16Image) xobjs.push('/Img16 36 0 R');
  if (opts.badBitsPerComponent) xobjs.push('/ImgB 31 0 R');
  if (opts.formOpi) xobjs.push('/FrmO 32 0 R');
  if (xobjs.length) res.push(`/XObject << ${xobjs.join(' ')} >>`);
  const egs: string[] = [];
  if (opts.lowAlpha) egs.push('/GSa << /Type /ExtGState /ca 0.5 >>');
  if (opts.nonStandardBlend) egs.push('/GSb << /Type /ExtGState /BM /FunkyBlend >>');
  if (opts.trExtGState) egs.push('/GSt << /Type /ExtGState /TR /Identity >>');
  if (opts.tr2ExtGState) egs.push('/GS2 << /Type /ExtGState /TR2 /Identity >>');
  if (opts.htoExtGState) egs.push('/GSh << /Type /ExtGState /HTO 1 >>');
  if (opts.badHalftone) egs.push('/GSn << /Type /ExtGState /HT << /Type /Halftone /HalftoneType 6 >> >>');
  if (opts.halftoneName) egs.push('/GSm << /Type /ExtGState /HT << /Type /Halftone /HalftoneType 1 /HalftoneName (x) >> >>');
  if (egs.length) res.push(`/ExtGState << ${egs.join(' ')} >>`);
  pageParts.push(`/Resources << ${res.join(' ')} >>`);
  if (opts.transparencyGroup || opts.groupNoCs) pageParts.push('/Group << /S /Transparency >>');
  if (opts.presSteps) pageParts.push('/PresSteps << /Type /NavNode >>');
  const annots: string[] = [];
  if (opts.annotNoAp) annots.push('14 0 R');
  if (opts.movieAnnot) annots.push('15 0 R');
  if (opts.hiddenAnnot) annots.push('16 0 R');
  if (opts.fileAttachAnnot) annots.push('24 0 R');
  if (opts.threeDAnnot) annots.push('25 0 R');
  if (opts.toggleNoViewAnnot) annots.push('26 0 R');
  if (opts.apWithDown) annots.push('27 0 R');
  if (opts.widgetWithAction) annots.push('28 0 R');
  if (opts.widgetWithAA) annots.push('37 0 R');
  if (annots.length) pageParts.push(`/Annots [${annots.join(' ')}]`);
  objects[3] = `<< ${pageParts.join(' ')} >>`;

  // content stream
  const streamFilter = opts.lzwStream ? ' /Filter /LZWDecode' : '';
  const streamExt = opts.externalStream ? ' /F (external.dat)' : '';
  const streamExtra = opts.extraStreamKeys ? ' /FFilter /FlateDecode' : '';
  objects[4] = `<< /Length ${byteLen(content)}${streamFilter}${streamExt}${streamExtra} >>\nstream\n${content}endstream`;

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
    if (!opts.omitToUnicode) {
      const uni = opts.badToUnicode ? '0000' : '0041';
      const cm = `/CIDInit /ProcSet findresource begin\n12 dict begin\nbegincmap\n`
        + `1 begincodespacerange\n<0000> <FFFF>\nendcodespacerange\n`
        + `1 beginbfchar\n<0001> <${uni}>\nendbfchar\n`
        + `endcmap\nCMapName currentdict /CMap defineresource pop\nend\nend\n`;
      objects[19] = `<< /Length ${byteLen(cm)} >>\nstream\n${cm}endstream`;
    }
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
  const xmp = xmpPacket(pdfaPart, pdfaConf, pdfaRev, xmpTitle);
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
  if (opts.perms) objects[29] = '<< /Type /Sig /Filter /Adobe.PPKLite >>';
  if (opts.imageAlternates) objects[30] = '<< /Type /XObject /Subtype /Image /Width 1 /Height 1 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Alternates [] /Length 1 >>\nstream\n\x00\nendstream';
  if (opts.badBitsPerComponent) objects[31] = '<< /Type /XObject /Subtype /Image /Width 1 /Height 1 /ColorSpace /DeviceRGB /BitsPerComponent 12 /Length 1 >>\nstream\n\x00\nendstream';
  if (opts.imageOpi) objects[35] = '<< /Type /XObject /Subtype /Image /Width 1 /Height 1 /ColorSpace /DeviceRGB /BitsPerComponent 8 /OPI << >> /Length 1 >>\nstream\n\x00\nendstream';
  // 16 bits per component: legal at parts 2/3/4, illegal at part 1 (PDF 1.4).
  if (opts.bpc16Image) objects[36] = '<< /Type /XObject /Subtype /Image /Width 1 /Height 1 /ColorSpace /DeviceRGB /BitsPerComponent 16 /Length 2 >>\nstream\n\x00\x00\nendstream';
  if (opts.formOpi) objects[32] = '<< /Type /XObject /Subtype /Form /BBox [0 0 1 1] /OPI << >> /Length 0 >>\nstream\n\nendstream';
  if (opts.embeddedFile === 'full') {
    objects[33] = '<< /Type /Filespec /F (a.txt) /UF (a.txt) /AFRelationship /Data /EF << /F 34 0 R >> >>';
    objects[34] = '<< /Type /EmbeddedFile /Subtype /text#2Fplain /Length 1 >>\nstream\na\nendstream';
  }
  if (opts.embeddedFile === 'bare') {
    objects[33] = '<< /Type /Filespec /F (a.txt) /EF << /F 34 0 R >> >>';
    objects[34] = '<< /Type /EmbeddedFile /Length 1 >>\nstream\na\nendstream';
  }
  if (opts.embeddedFile === 'noUf') {
    objects[33] = '<< /Type /Filespec /F (a.txt) /AFRelationship /Data /EF << /F 34 0 R >> >>';
    objects[34] = '<< /Type /EmbeddedFile /Subtype /text#2Fplain /Length 1 >>\nstream\na\nendstream';
  }
  if (opts.embeddedFile === 'noMime') {
    objects[33] = '<< /Type /Filespec /F (a.txt) /UF (a.txt) /AFRelationship /Data /EF << /F 34 0 R >> >>';
    objects[34] = '<< /Type /EmbeddedFile /Length 1 >>\nstream\na\nendstream';
  }
  const apRef = ' /AP << /N 22 0 R >>';
  const apForm = '<< /Type /XObject /Subtype /Form /BBox [0 0 10 10] /Length 0 >>\nstream\n\nendstream';
  if (opts.hiddenAnnot) objects[22] = apForm;
  if (opts.fileAttachAnnot) objects[24] = `<< /Type /Annot /Subtype /FileAttachment /Rect [0 0 10 10] /F 4${apRef} >>`;
  if (opts.threeDAnnot) objects[25] = `<< /Type /Annot /Subtype /3D /Rect [0 0 10 10] /F 4${apRef} >>`;
  if (opts.toggleNoViewAnnot) objects[26] = `<< /Type /Annot /Subtype /Text /Rect [0 0 10 10] /F 260${apRef} >>`;
  if (opts.apWithDown) objects[27] = '<< /Type /Annot /Subtype /Text /Rect [0 0 10 10] /F 4 /AP << /N 22 0 R /D 22 0 R >> >>';
  if (opts.widgetWithAction) objects[28] = `<< /Type /Annot /Subtype /Widget /Rect [0 0 10 10] /F 4${apRef} /A << /S /GoTo /D [3 0 R /Fit] >> >>`;
  // Parts 1-3 ban a Widget's /AA outright; ISO 19005-4 6.6.3-1 exempts it.
  // The trigger holds a /GoTo rather than JavaScript ON PURPOSE: with a
  // prohibited action inside, actionsPass empties the /AA and deletes it before
  // annotKeysPass ever sees it, so the fixture would measure the wrong pass.
  if (opts.widgetWithAA) objects[37] = `<< /Type /Annot /Subtype /Widget /Rect [0 0 10 10] /F 4${apRef} /AA << /K << /S /GoTo /D [3 0 R /Fit] >> >> >>`;
  if (opts.fileAttachAnnot || opts.threeDAnnot || opts.toggleNoViewAnnot
      || opts.apWithDown || opts.widgetWithAction || opts.widgetWithAA) objects[22] = apForm;

  // info
  const infoNum = 23;
  if (infoTitle !== null) {
    objects[infoNum] = opts.infoModDateOnly
      ? '<< /ModDate (D:20260904000000Z) >>'
      : opts.infoWithModDate
        ? `<< /Title (${infoTitle}) /ModDate (D:20260904000000Z) >>`
        : `<< /Title (${infoTitle}) >>`;
  }

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

function xmpPacket(
  part: string, conformance: string | null, rev: string | null, title: string,
): string {
  const idAttrs = [`pdfaid:part="${part}"`];
  if (conformance !== null) idAttrs.push(`pdfaid:conformance="${conformance}"`);
  if (rev !== null) idAttrs.push(`pdfaid:rev="${rev}"`);
  return `<?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d"?>\n`
    + `<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">`
    + `<rdf:Description rdf:about="" xmlns:pdfaid="http://www.aiim.org/pdfa/ns/id/" `
    + `${idAttrs.join(' ')}/>`
    + `<rdf:Description rdf:about="" xmlns:dc="http://purl.org/dc/elements/1.1/">`
    + `<dc:title><rdf:Alt><rdf:li xml:lang="x-default">${title}</rdf:li></rdf:Alt></dc:title>`
    + `</rdf:Description></rdf:RDF></x:xmpmeta>\n<?xpacket end="w"?>`;
}

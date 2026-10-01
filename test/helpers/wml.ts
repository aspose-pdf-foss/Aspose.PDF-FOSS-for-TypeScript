/** String builders for WordprocessingML test inputs (m2fp.3). */
export const W_NS = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
export const W_STRICT = 'http://purl.oclc.org/ooxml/wordprocessingml/main';
export const R_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
export const A_NS = 'http://schemas.openxmlformats.org/drawingml/2006/main';
export const WP_NS = 'http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing';
export const PIC_NS = 'http://schemas.openxmlformats.org/drawingml/2006/picture';
export const MC_NS = 'http://schemas.openxmlformats.org/markup-compatibility/2006';
export const W14_NS = 'http://schemas.microsoft.com/office/word/2010/wordml';

export const enc = (s: string): Uint8Array => new TextEncoder().encode(s);

const DECLS = `xmlns:w="${W_NS}" xmlns:r="${R_NS}" xmlns:a="${A_NS}" xmlns:wp="${WP_NS}" `
  + `xmlns:pic="${PIC_NS}" xmlns:mc="${MC_NS}" xmlns:w14="${W14_NS}"`;
export const docXml = (body: string): Uint8Array =>
  enc(`<?xml version="1.0"?><w:document ${DECLS}><w:body>${body}</w:body></w:document>`);
export const stylesXml = (inner: string, defaults = ''): Uint8Array =>
  enc(`<w:styles xmlns:w="${W_NS}">${defaults ? `<w:docDefaults>${defaults}</w:docDefaults>` : ''}${inner}</w:styles>`);
export const numberingXml = (inner: string): Uint8Array => enc(`<w:numbering xmlns:w="${W_NS}">${inner}</w:numbering>`);
export const themeXml = (minor: string, major: string, minorEa = ''): Uint8Array =>
  enc(`<a:theme xmlns:a="${A_NS}"><a:themeElements><a:fontScheme name="t">`
    + `<a:majorFont><a:latin typeface="${major}"/><a:ea typeface=""/></a:majorFont>`
    + `<a:minorFont><a:latin typeface="${minor}"/><a:ea typeface="${minorEa}"/></a:minorFont>`
    + '</a:fontScheme></a:themeElements></a:theme>');

export const style = (type: string, id: string, inner: string, extra = ''): string =>
  `<w:style w:type="${type}" w:styleId="${id}"${extra}>${inner}</w:style>`;
export const p = (inner: string, pPr = ''): string => `<w:p>${pPr ? `<w:pPr>${pPr}</w:pPr>` : ''}${inner}</w:p>`;
export const r = (text: string, rPr = ''): string =>
  `<w:r>${rPr ? `<w:rPr>${rPr}</w:rPr>` : ''}<w:t xml:space="preserve">${text}</w:t></w:r>`;
export const numPr = (numId: number, ilvl = 0): string =>
  `<w:numPr><w:ilvl w:val="${ilvl}"/><w:numId w:val="${numId}"/></w:numPr>`;
export const lvl = (ilvl: number, fmt: string, text: string, start = 1, extra = ''): string =>
  `<w:lvl w:ilvl="${ilvl}"><w:start w:val="${start}"/><w:numFmt w:val="${fmt}"/><w:lvlText w:val="${text}"/>${extra}</w:lvl>`;

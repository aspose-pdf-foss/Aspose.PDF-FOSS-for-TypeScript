/** The m2fp.3 oracle document: WordprocessingML WE author to exercise the
 *  resolution rules, which Microsoft Word opens through COM
 *  (scripts/gen-wml-oracle.ps1) and whose COMPUTED formatting is committed as
 *  ground truth (test/fixtures/docx/wml-oracle.json). Word cannot be made to
 *  WRITE several of these shapes — two w:num over one abstract num, a toggle
 *  restated down one basedOn chain — but it reads them, which is the question.
 *  Byte-reproducible: buildOoxmlPackage writes no clock. */
import { buildOoxmlPackage } from '../../src/ooxml.js';

const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const A = 'http://schemas.openxmlformats.org/drawingml/2006/main';
const MC = 'http://schemas.openxmlformats.org/markup-compatibility/2006';
const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
const DECL = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';

const style = (type: string, id: string, inner: string, extra = ''): string =>
  `<w:style w:type="${type}" w:styleId="${id}"${extra}>${inner}</w:style>`;
const p = (inner: string, pPr = ''): string => `<w:p>${pPr ? `<w:pPr>${pPr}</w:pPr>` : ''}${inner}</w:p>`;
const r = (text: string, rPr = ''): string =>
  `<w:r>${rPr ? `<w:rPr>${rPr}</w:rPr>` : ''}<w:t xml:space="preserve">${text}</w:t></w:r>`;
const num = (numId: number, ilvl: number): string =>
  `<w:numPr><w:ilvl w:val="${ilvl}"/><w:numId w:val="${numId}"/></w:numPr>`;
const lvl = (ilvl: number, fmt: string, text: string): string =>
  `<w:lvl w:ilvl="${ilvl}"><w:start w:val="1"/><w:numFmt w:val="${fmt}"/><w:lvlText w:val="${text}"/></w:lvl>`;

const STYLES = `${DECL}<w:styles xmlns:w="${W}"><w:docDefaults>`
  + '<w:rPrDefault><w:rPr><w:rFonts w:asciiTheme="minorHAnsi" w:hAnsiTheme="minorHAnsi"/></w:rPr></w:rPrDefault>'
  + '<w:pPrDefault><w:pPr/></w:pPrDefault></w:docDefaults>'
  + style('paragraph', 'Normal', '<w:name w:val="Normal"/>', ' w:default="1"')
  + style('character', 'DefaultParagraphFont', '<w:name w:val="Default Paragraph Font"/>', ' w:default="1"')
  + style('paragraph', 'PBold', '<w:name w:val="P Bold"/><w:basedOn w:val="Normal"/><w:rPr><w:b/></w:rPr>')
  + style('paragraph', 'PChild', '<w:name w:val="P Child"/><w:basedOn w:val="PBold"/><w:rPr><w:i/><w:sz w:val="28"/></w:rPr>')
  + style('paragraph', 'PBoldAgain', '<w:name w:val="P Bold Again"/><w:basedOn w:val="PBold"/><w:rPr><w:b/></w:rPr>')
  + style('character', 'CBold', '<w:name w:val="C Bold"/><w:rPr><w:b/></w:rPr>')
  + style('character', 'CRed', '<w:name w:val="C Red"/><w:basedOn w:val="CBold"/><w:rPr><w:color w:val="FF0000"/></w:rPr>')
  + style('paragraph', '1', '<w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:pPr><w:outlineLvl w:val="0"/></w:pPr><w:rPr><w:sz w:val="32"/></w:rPr>')
  + style('paragraph', 'Hx', '<w:name w:val="Fake Heading"/><w:basedOn w:val="Normal"/><w:rPr><w:sz w:val="32"/></w:rPr>')
  + style('paragraph', 'ListNum', '<w:name w:val="List Num"/><w:basedOn w:val="Normal"/><w:pPr><w:numPr><w:numId w:val="3"/></w:numPr></w:pPr>')
  + '</w:styles>';

const NUMBERING = `${DECL}<w:numbering xmlns:w="${W}">`
  + `<w:abstractNum w:abstractNumId="10">${lvl(0, 'decimal', '%1.')}${lvl(1, 'lowerLetter', '%1.%2)')}</w:abstractNum>`
  + `<w:abstractNum w:abstractNumId="11">${lvl(0, 'bullet', '•')}</w:abstractNum>`
  + `<w:abstractNum w:abstractNumId="12">${lvl(0, 'upperRoman', '%1.')}</w:abstractNum>`
  + '<w:num w:numId="1"><w:abstractNumId w:val="10"/></w:num>'
  + '<w:num w:numId="2"><w:abstractNumId w:val="10"/></w:num>'
  + '<w:num w:numId="3"><w:abstractNumId w:val="11"/></w:num>'
  + '<w:num w:numId="4"><w:abstractNumId w:val="10"/><w:lvlOverride w:ilvl="0"><w:startOverride w:val="5"/></w:lvlOverride></w:num>'
  + '<w:num w:numId="5"><w:abstractNumId w:val="12"/></w:num>'
  + '</w:numbering>';

const clr = (n: string, hex: string): string => `<a:${n}><a:srgbClr val="${hex}"/></a:${n}>`;
const solid = '<a:solidFill><a:schemeClr val="phClr"/></a:solidFill>';
const line = `<a:ln w="9525">${solid}</a:ln>`;
const THEME = `${DECL}<a:theme xmlns:a="${A}" name="Oracle"><a:themeElements><a:clrScheme name="Oracle">`
  + clr('dk1', '000000') + clr('lt1', 'FFFFFF') + clr('dk2', '1F497D') + clr('lt2', 'EEECE1')
  + clr('accent1', '4F81BD') + clr('accent2', 'C0504D') + clr('accent3', '9BBB59') + clr('accent4', '8064A2')
  + clr('accent5', '4BACC6') + clr('accent6', 'F79646') + clr('hlink', '0000FF') + clr('folHlink', '800080')
  + '</a:clrScheme><a:fontScheme name="Oracle">'
  + '<a:majorFont><a:latin typeface="Georgia"/><a:ea typeface=""/><a:cs typeface=""/></a:majorFont>'
  + '<a:minorFont><a:latin typeface="Cambria"/><a:ea typeface=""/><a:cs typeface=""/></a:minorFont>'
  + '</a:fontScheme><a:fmtScheme name="Oracle">'
  + `<a:fillStyleLst>${solid.repeat(3)}</a:fillStyleLst><a:lnStyleLst>${line.repeat(3)}</a:lnStyleLst>`
  + `<a:effectStyleLst>${'<a:effectStyle><a:effectLst/></a:effectStyle>'.repeat(3)}</a:effectStyleLst>`
  + `<a:bgFillStyleLst>${solid.repeat(3)}</a:bgFillStyleLst>`
  + '</a:fmtScheme></a:themeElements><a:objectDefaults/><a:extraClrSchemeLst/></a:theme>';

const BODY = [
  p(r('plain')),
  p(r('pb ') + r('xor ', '<w:rStyle w:val="CBold"/>') + r('direct ', '<w:rStyle w:val="CBold"/><w:b/>')
    + r('off', '<w:b w:val="0"/>'), '<w:pStyle w:val="PBold"/>'),
  p(r('child ') + r('red', '<w:rStyle w:val="CRed"/>'), '<w:pStyle w:val="PChild"/>'),
  p(r('again'), '<w:pStyle w:val="PBoldAgain"/>'),
  p(r('Heading'), '<w:pStyle w:val="1"/>'),
  p(r('Fake'), '<w:pStyle w:val="Hx"/>'),
  p(r('one'), num(1, 0)), p(r('onea'), num(1, 1)), p(r('oneb'), num(1, 1)),
  p(r('two'), num(1, 0)), p(r('twoa'), num(1, 1)),
  p(r('between')),
  p(r('three'), num(1, 0)),
  p(r('shared'), num(2, 0)),
  p(r('override'), num(4, 0)), p(r('overridden'), num(4, 0)),
  p(r('roman'), num(5, 0)),
  p(r('styled'), '<w:pStyle w:val="ListNum"/>'),
  p(r('optout'), '<w:pStyle w:val="ListNum"/><w:numPr><w:numId w:val="0"/></w:numPr>'),
  p(r('fmt ', '<w:rFonts w:ascii="Courier New" w:hAnsi="Courier New"/><w:strike/><w:color w:val="0000FF"/>'
    + '<w:sz w:val="24"/><w:u w:val="single"/>')
    + r('theme', '<w:rFonts w:asciiTheme="majorHAnsi" w:hAnsiTheme="majorHAnsi" w:ascii="Arial" w:hAnsi="Arial"/>')),
  p(r('hl ', '<w:highlight w:val="yellow"/>') + r('shd', '<w:shd w:val="clear" w:color="auto" w:fill="00FF00"/>')),
  p('<mc:AlternateContent><mc:Choice Requires="zz"><w:r><w:t>choice</w:t></w:r></mc:Choice>'
    + '<mc:Fallback><w:r><w:t>fallback</w:t></w:r></mc:Fallback></mc:AlternateContent>'),
  p('<w:sdt><w:sdtContent><w:r><w:t>sdt</w:t></w:r></w:sdtContent></w:sdt>'),
].join('');

const DOCUMENT = `${DECL}<w:document xmlns:w="${W}" xmlns:r="${REL}" xmlns:mc="${MC}" xmlns:zz="urn:example:unknown">`
  + `<w:body>${BODY}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/>`
  + '<w:pgMar w:top="1134" w:right="850" w:bottom="1134" w:left="1701" w:header="708" w:footer="708" w:gutter="0"/>'
  + '</w:sectPr></w:body></w:document>';

const CT = 'application/vnd.openxmlformats-officedocument';
export function buildWmlOracleDocx(): Uint8Array {
  return buildOoxmlPackage([
    { path: 'word/document.xml', bytes: enc(DOCUMENT), contentType: `${CT}.wordprocessingml.document.main+xml` },
    { path: 'word/styles.xml', bytes: enc(STYLES), contentType: `${CT}.wordprocessingml.styles+xml` },
    { path: 'word/numbering.xml', bytes: enc(NUMBERING), contentType: `${CT}.wordprocessingml.numbering+xml` },
    { path: 'word/theme/theme1.xml', bytes: enc(THEME), contentType: `${CT}.theme+xml` },
  ], [
    { source: '', id: 'rId1', type: `${REL}/officeDocument`, target: 'word/document.xml' },
    { source: 'word/document.xml', id: 'rId1', type: `${REL}/styles`, target: 'styles.xml' },
    { source: 'word/document.xml', id: 'rId2', type: `${REL}/numbering`, target: 'numbering.xml' },
    { source: 'word/document.xml', id: 'rId3', type: `${REL}/theme`, target: 'theme/theme1.xml' },
  ]);
}

/** m2fp.5's spacing oracle: three paragraphs with exact 20pt lines. P1 after=12,
 *  P2 before=18 after=6, P3 before=30. Additive spacing puts P2 at 20+12+18=50pt
 *  below P1 and P3 at 20+6+30=56pt below P2; collapsing puts them at 38 and 50.
 *  Byte-reproducible: buildOoxmlPackage writes no clock. */
import { buildOoxmlPackage } from '../../src/ooxml.js';

const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
const para = (text: string, before: number, after: number): string =>
  `<w:p><w:pPr><w:spacing w:before="${before * 20}" w:after="${after * 20}" w:line="400" w:lineRule="exact"/></w:pPr>`
  + `<w:r><w:rPr><w:rFonts w:ascii="Times New Roman" w:hAnsi="Times New Roman"/><w:sz w:val="24"/></w:rPr><w:t>${text}</w:t></w:r></w:p>`;
const DOCUMENT = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="${W}"><w:body>`
  + para('One', 0, 12) + para('Two', 18, 6) + para('Three', 30, 0)
  + '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="708" w:footer="708" w:gutter="0"/></w:sectPr>'
  + '</w:body></w:document>';

export function buildSpacingOracleDocx(): Uint8Array {
  return buildOoxmlPackage(
    [{ path: 'word/document.xml', bytes: enc(DOCUMENT), contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml' }],
    [{ source: '', id: 'rId1', type: `${REL}/officeDocument`, target: 'word/document.xml' }]);
}

/** m2fp.10's table spacing oracle: does Word collapse a paragraph's spacing
 *  across a TABLE the way it collapses it between two paragraphs? P1 (space
 *  after set by the script), a one-cell borderless table whose one paragraph
 *  has an exact 20pt line and no spacing, P2 (space before set by the script),
 *  and P3, the witness, which has no spacing at all. Exact 20pt lines
 *  throughout. Byte-reproducible: buildOoxmlPackage writes no clock. */
import { buildOoxmlPackage } from '../../src/ooxml.js';

const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
const run = (text: string): string =>
  `<w:r><w:rPr><w:rFonts w:ascii="Times New Roman" w:hAnsi="Times New Roman"/><w:sz w:val="24"/></w:rPr><w:t>${text}</w:t></w:r>`;
const para = (text: string, before = 0, after = 0): string =>
  `<w:p><w:pPr><w:spacing w:before="${before * 20}" w:after="${after * 20}" w:line="400" w:lineRule="exact"/></w:pPr>${run(text)}</w:p>`;
const NONE = '<w:top w:val="nil"/><w:left w:val="nil"/><w:bottom w:val="nil"/><w:right w:val="nil"/>'
  + '<w:insideH w:val="nil"/><w:insideV w:val="nil"/>';
const TABLE = `<w:tbl><w:tblPr><w:tblW w:w="4000" w:type="dxa"/><w:tblBorders>${NONE}</w:tblBorders>`
  + '<w:tblCellMar><w:top w:w="0" w:type="dxa"/><w:bottom w:w="0" w:type="dxa"/></w:tblCellMar></w:tblPr>'
  + '<w:tblGrid><w:gridCol w:w="4000"/></w:tblGrid>'
  + `<w:tr><w:tc><w:tcPr><w:tcW w:w="4000" w:type="dxa"/></w:tcPr>${para('Cell')}</w:tc></w:tr></w:tbl>`;
const document = (after: number, before: number): string => `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="${W}"><w:body>`
  + para('One', 0, after) + TABLE + para('Two', before, 0) + para('Three')
  + '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="708" w:footer="708" w:gutter="0"/></w:sectPr>'
  + '</w:body></w:document>';

/** With no arguments, the vendored fixture; with them, the same document with
 *  P1's space-after and P2's space-before stated, as the script sets them. */
export function buildTableSpacingOracleDocx(after = 0, before = 0): Uint8Array {
  return buildOoxmlPackage(
    [{ path: 'word/document.xml', bytes: enc(document(after, before)), contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml' }],
    [{ source: '', id: 'rId1', type: `${REL}/officeDocument`, target: 'word/document.xml' }]);
}

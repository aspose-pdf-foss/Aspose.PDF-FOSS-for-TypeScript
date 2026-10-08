/** v9j3.1's tab oracle: one paragraph per tab-stop case, set in Courier New 10pt
 *  (Word ships it; the importer substitutes Courier, whose 600-unit advance is
 *  Courier New's), so right, centre and decimal targets are metric-exact. Each
 *  case puts a unique upper-case MARKER after its tab; the filler is lower case
 *  and digits. A4, 1in margins, so the margin is at 72pt.
 *  Byte-reproducible: buildOoxmlPackage writes no clock. */
import { buildDocx } from './build-docx.js';

/** The cases, in document order: id, marker, the stops' XML, the text. */
export const TAB_ORACLE_CASES = [
  { id: 'left stop at 2in', marker: 'A', tabs: '<w:tab w:val="left" w:pos="2880"/>', text: 'aa\tA' },
  { id: 'right stop at 4in', marker: 'B', tabs: '<w:tab w:val="right" w:pos="5760"/>', text: 'aa\tB' },
  { id: 'centre stop at 3in', marker: 'C', tabs: '<w:tab w:val="center" w:pos="4320"/>', text: 'aa\tCcccc' },
  { id: 'decimal stop at 3in', marker: 'D', tabs: '<w:tab w:val="decimal" w:pos="4320"/>', text: 'aa\tD12.50' },
  { id: 'default stops, first', marker: 'E', tabs: '', text: 'a\tE\tF' },
  { id: 'default stops, second', marker: 'F', tabs: '', text: '' },
  { id: 'style chain with a cleared stop', marker: 'G', tabs: 'STYLE', text: 'a\tG' },
  { id: 'dot leader to a right stop at 5in', marker: 'H', tabs: '<w:tab w:val="right" w:leader="dot" w:pos="7200"/>', text: 'a\tH' },
] as const;

const RPR = '<w:rPr><w:rFonts w:ascii="Courier New" w:hAnsi="Courier New" w:cs="Courier New"/><w:sz w:val="20"/></w:rPr>';
const run = (t: string): string => t.split('\t').map((s, i) => (i > 0 ? `<w:r>${RPR}<w:tab/></w:r>` : '')
  + (s === '' ? '' : `<w:r>${RPR}<w:t xml:space="preserve">${s}</w:t></w:r>`)).join('');

const STYLES = '<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/>'
  + '<w:pPr><w:spacing w:after="0" w:line="240" w:lineRule="auto"/></w:pPr></w:style>'
  + '<w:style w:type="paragraph" w:styleId="Base"><w:name w:val="Base"/><w:basedOn w:val="Normal"/>'
  + '<w:pPr><w:tabs><w:tab w:val="left" w:pos="1440"/><w:tab w:val="left" w:pos="2880"/></w:tabs></w:pPr></w:style>'
  + '<w:style w:type="paragraph" w:styleId="Kid"><w:name w:val="Kid"/><w:basedOn w:val="Base"/>'
  + '<w:pPr><w:tabs><w:tab w:val="clear" w:pos="1440"/></w:tabs></w:pPr></w:style>';

export function buildTabOracleDocx(): Uint8Array {
  const body = TAB_ORACLE_CASES.filter((c) => c.text !== '').map((c) => {
    const ppr = c.tabs === 'STYLE' ? '<w:pPr><w:pStyle w:val="Kid"/></w:pPr>'
      : c.tabs === '' ? '' : `<w:pPr><w:tabs>${c.tabs}</w:tabs></w:pPr>`;
    return `<w:p>${ppr}${run(c.text)}</w:p>`;
  }).join('')
    + '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="708" w:footer="708" w:gutter="0"/></w:sectPr>';
  return buildDocx(body, {
    styles: STYLES,
    settings: '<w:defaultTabStop w:val="720"/>',
    fontTable: '<w:font w:name="Courier New"><w:family w:val="modern"/><w:pitch w:val="fixed"/></w:font>',
  });
}

import { escapeXml } from './xml.js';

const W_NS = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const DECL = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';

/** Points to English Metric Units, and to twips.
 *
 *  Here rather than in `docxflow.ts` because `docxtable.ts` needs them too and
 *  `docxflow.ts` imports `docxtable.ts` — defining them there and importing
 *  back would close a cycle. This module imports neither. */
export const EMU_PER_PT = 12700;
export const TWIPS_PER_PT = 20;

/** The style ids the mapper may name.
 *
 *  **Invariant:** the mapper cannot name a style this module does not define,
 *  so the ids live here and the two are one decision. A `w:pStyle` pointing at
 *  an undefined style is not an error a reader reports — Word falls back to
 *  body text, so a document of headings arrives looking like one long paragraph
 *  and nothing says why. */
export const STYLE = {
  normal: 'Normal',
  quote: 'Quote',
  code: 'SourceCode',
  listParagraph: 'ListParagraph',
  hyperlink: 'Hyperlink',
  /** Clamped: Word defines six heading styles, and a /H7 in a tagged tree must
   *  land on one of them rather than name a style nothing defines. */
  heading: (level: number): string => `Heading${Math.min(6, Math.max(1, Math.round(level)))}`,
} as const;

/** One list the body emitted: its id, its kind, and its first ordinal. */
export interface DocxNumbering { numId: number; ordered: boolean; start?: number }

/** **Invariant:** real bullet characters in the document font, not Word's
 *  conventional U+F0B7 in Symbol. That codepoint is private use and means a
 *  bullet only in a font present on Windows and frequently not elsewhere; where
 *  the font is missing, so is the glyph. */
export const BULLETS = ['•', '◦', '▪'] as const;

/** Heading sizes in points, level 1..6. */
const HEADING_PT = [16, 14, 13, 12, 11, 10];

function headingStyle(level: number): string {
  const half = HEADING_PT[level - 1] * 2;     // w:sz is in half-points
  return `<w:style w:type="paragraph" w:styleId="${STYLE.heading(level)}">`
    + `<w:name w:val="heading ${level}"/><w:basedOn w:val="${STYLE.normal}"/>`
    + `<w:pPr><w:keepNext/><w:outlineLvl w:val="${level - 1}"/>`
    + '<w:spacing w:before="240" w:after="120"/></w:pPr>'
    + `<w:rPr><w:b/><w:sz w:val="${half}"/></w:rPr></w:style>`;
}

/** The `word/styles.xml` part. */
export function docxStylesXml(): string {
  const styles = [
    '<w:docDefaults><w:rPrDefault><w:rPr>'
      + '<w:rFonts w:ascii="Calibri" w:hAnsi="Calibri"/><w:sz w:val="22"/>'
      + '</w:rPr></w:rPrDefault></w:docDefaults>',
    `<w:style w:type="paragraph" w:default="1" w:styleId="${STYLE.normal}">`
      + '<w:name w:val="Normal"/></w:style>',
    ...[1, 2, 3, 4, 5, 6].map(headingStyle),
    `<w:style w:type="paragraph" w:styleId="${STYLE.quote}">`
      + `<w:name w:val="Quote"/><w:basedOn w:val="${STYLE.normal}"/>`
      + '<w:pPr><w:ind w:left="720"/></w:pPr><w:rPr><w:i/></w:rPr></w:style>',
    `<w:style w:type="paragraph" w:styleId="${STYLE.code}">`
      + `<w:name w:val="Source Code"/><w:basedOn w:val="${STYLE.normal}"/>`
      + '<w:pPr><w:spacing w:after="0"/></w:pPr>'
      + '<w:rPr><w:rFonts w:ascii="Consolas" w:hAnsi="Consolas"/></w:rPr></w:style>',
    `<w:style w:type="paragraph" w:styleId="${STYLE.listParagraph}">`
      + `<w:name w:val="List Paragraph"/><w:basedOn w:val="${STYLE.normal}"/>`
      + '<w:pPr><w:contextualSpacing/></w:pPr></w:style>',
    `<w:style w:type="character" w:styleId="${STYLE.hyperlink}">`
      + '<w:name w:val="Hyperlink"/>'
      + '<w:rPr><w:color w:val="0563C1"/><w:u w:val="single"/></w:rPr></w:style>',
  ].join('');
  return `${DECL}<w:styles xmlns:w="${W_NS}">${styles}</w:styles>\n`;
}

/** Nine levels of one list kind. Nine because that is what Word's own list
 *  definitions carry, and a `w:ilvl` past the last defined level is undefined
 *  behaviour rather than a deeper indent. */
function abstractNum(id: number, ordered: boolean): string {
  const levels = Array.from({ length: 9 }, (_, i) => {
    const fmt = ordered ? 'decimal' : 'bullet';
    const text = ordered ? `%${i + 1}.` : BULLETS[i % BULLETS.length];
    const indent = 720 * (i + 1);
    return `<w:lvl w:ilvl="${i}"><w:start w:val="1"/>`
      + `<w:numFmt w:val="${fmt}"/><w:lvlText w:val="${escapeXml(text)}"/>`
      + '<w:lvlJc w:val="left"/>'
      + `<w:pPr><w:ind w:left="${indent}" w:hanging="360"/></w:pPr></w:lvl>`;
  }).join('');
  return `<w:abstractNum w:abstractNumId="${id}">`
    + '<w:multiLevelType w:val="hybridMultilevel"/>' + levels + '</w:abstractNum>';
}

/** The `word/numbering.xml` part: two abstract definitions — bullet and
 *  decimal — and one `w:num` per list the body emitted.
 *
 *  **Invariant:** `w:startOverride` goes on the `w:num`, never on the abstract
 *  definition. The abstract one is shared by every list of its kind, so an
 *  override there renumbers all of them. */
export function docxNumberingXml(nums: DocxNumbering[]): string {
  const body = abstractNum(0, false) + abstractNum(1, true)
    + nums.map((n) => {
      const override = n.ordered && n.start !== undefined && n.start !== 1
        ? `<w:lvlOverride w:ilvl="0"><w:startOverride w:val="${n.start}"/></w:lvlOverride>`
        : '';
      return `<w:num w:numId="${n.numId}">`
        + `<w:abstractNumId w:val="${n.ordered ? 1 : 0}"/>${override}</w:num>`;
    }).join('');
  return `${DECL}<w:numbering xmlns:w="${W_NS}">${body}</w:numbering>\n`;
}

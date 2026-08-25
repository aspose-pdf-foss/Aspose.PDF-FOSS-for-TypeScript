import { describe, it, expect } from 'vitest';
import { docxStylesXml, docxNumberingXml, STYLE, BULLETS } from '../src/docxstyles.js';
import { parseXml } from '../src/xml.js';

const parse = (s: string) => parseXml(new TextEncoder().encode(s));

describe('docxStylesXml', () => {
  it('parses as XML', () => {
    expect(() => parse(docxStylesXml())).not.toThrow();
  });

  // The mapper cannot name a style this module does not define: a w:pStyle
  // pointing at an undefined style is not an error any reader reports -- Word
  // falls back to body text, so a document of headings arrives looking like one
  // long paragraph and nothing anywhere says why.
  it('defines every style the mapper can name', () => {
    const xml = docxStylesXml();
    for (let n = 1; n <= 6; n++) expect(xml).toContain(`w:styleId="${STYLE.heading(n)}"`);
    for (const id of [STYLE.normal, STYLE.quote, STYLE.code, STYLE.listParagraph, STYLE.hyperlink])
      expect(xml).toContain(`w:styleId="${id}"`);
  });

  it('gives the hyperlink style character type', () => {
    expect(docxStylesXml()).toContain(`<w:style w:type="character" w:styleId="${STYLE.hyperlink}"`);
  });

  it('clamps a heading level to the six Word defines', () => {
    expect(STYLE.heading(9)).toBe('Heading6');
    expect(STYLE.heading(0)).toBe('Heading1');
  });
});

describe('docxNumberingXml', () => {
  it('emits one w:num per list', () => {
    const xml = docxNumberingXml([
      { numId: 1, ordered: false },
      { numId: 2, ordered: true, start: 5 },
    ]);
    expect(() => parse(xml)).not.toThrow();
    expect(xml).toContain('<w:num w:numId="1">');
    expect(xml).toContain('<w:num w:numId="2">');
  });

  it('points each list at the abstract definition for its kind', () => {
    const xml = docxNumberingXml([{ numId: 1, ordered: false }, { numId: 2, ordered: true }]);
    const numOf = (id: number) => {
      const at = xml.indexOf(`<w:num w:numId="${id}">`);
      return xml.slice(at, xml.indexOf('</w:num>', at));
    };
    expect(numOf(1)).toContain('<w:abstractNumId w:val="0"/>');
    expect(numOf(2)).toContain('<w:abstractNumId w:val="1"/>');
  });

  // On the w:num, never on the abstract definition: the abstract one is shared
  // by every list of its kind, so an override there renumbers all of them.
  it('puts a start override on the num, not the abstract definition', () => {
    const xml = docxNumberingXml([{ numId: 2, ordered: true, start: 5 }]);
    const num = xml.slice(xml.indexOf('<w:num w:numId="2">'));
    expect(num).toContain('<w:startOverride w:val="5"/>');
    expect(xml.slice(0, xml.indexOf('<w:num '))).not.toContain('startOverride');
  });

  it('omits the override when a list starts at one', () => {
    expect(docxNumberingXml([{ numId: 1, ordered: true }])).not.toContain('startOverride');
  });

  // The private use area is a Windows-font dependency: where Symbol is missing,
  // so is the glyph.
  it('uses real bullet characters, not Symbol private use', () => {
    const xml = docxNumberingXml([{ numId: 1, ordered: false }]);
    expect(xml).toContain(BULLETS[0]);
    expect(xml).not.toContain('');
  });

  it('defines nine levels for each kind', () => {
    const xml = docxNumberingXml([]);
    expect(xml.match(/<w:lvl w:ilvl="8">/g)?.length).toBe(2);
  });
});

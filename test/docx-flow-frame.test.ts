import { describe, it, expect } from 'vitest';
import { paragraphXml, runXml } from '../src/docxflow.js';

describe('docxflow vocabulary', () => {
  it('emits nothing new when the new fields are unset', () => {
    // The whole point of extending the vocabulary rather than forking the
    // emitter: every existing call site must produce the bytes it does today.
    expect(runXml('hi')).toBe('<w:r><w:t xml:space="preserve">hi</w:t></w:r>');
    expect(paragraphXml('<w:r/>')).toBe('<w:p><w:r/></w:p>');
  });

  it('emits w:sz in half-points', () => {
    const xml = runXml('hi', { size: 10.5 });
    expect(xml).toContain('<w:sz w:val="21"/>');
    // w:szCs states the same for complex scripts; omitting it leaves a
    // mixed-script run at Word's default size.
    expect(xml).toContain('<w:szCs w:val="21"/>');
  });

  it('emits w:color as bare uppercase hex, no leading hash', () => {
    expect(runXml('hi', { color: [255, 0, 0] })).toContain('<w:color w:val="FF0000"/>');
    expect(runXml('hi', { color: [0, 128, 255] })).toContain('<w:color w:val="0080FF"/>');
  });

  it('emits w:framePr anchored to the page', () => {
    const xml = paragraphXml('<w:r/>', { frame: { x: 1440, y: 2160, w: 2880, h: 240 } });
    expect(xml).toContain(
      '<w:framePr w:w="2880" w:h="240" w:hRule="atLeast"'
      + ' w:x="1440" w:y="2160" w:hAnchor="page" w:vAnchor="page" w:wrap="none"/>',
    );
  });

  it('puts w:framePr first inside w:pPr', () => {
    // w:pPr's children are schema-ORDERED: w:framePr precedes w:pStyle, which
    // precedes w:numPr, which precedes w:ind. Wrong order is a file Word
    // refuses outright — the same class of rule as w:tcPr's children.
    const xml = paragraphXml('<w:r/>', {
      frame: { x: 0, y: 0, w: 100, h: 100 }, style: 'Quote', numId: 1, indent: 720,
    });
    expect(xml.indexOf('w:framePr')).toBeLessThan(xml.indexOf('w:pStyle'));
    expect(xml.indexOf('w:pStyle')).toBeLessThan(xml.indexOf('w:numPr'));
    expect(xml.indexOf('w:numPr')).toBeLessThan(xml.indexOf('w:ind '));
  });

  it('combines the run properties in one w:rPr', () => {
    const xml = runXml('hi', { size: 12, color: [255, 0, 0], bold: true, italic: true });
    expect((xml.match(/<w:rPr>/g) ?? [])).toHaveLength(1);
    expect(xml).toContain('<w:b/>');
    expect(xml).toContain('<w:i/>');
  });
});

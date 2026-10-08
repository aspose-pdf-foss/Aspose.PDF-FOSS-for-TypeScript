// test/wml-tabs.test.ts
import { describe, it, expect } from 'vitest';
import { readParaLayer, resolveParagraph, emptyStyles, parseStyles, EMPTY_THEME, parseDefaultTabStop } from '../src/wmlstyles.js';
import { parseWml, wChild } from '../src/wmlns.js';
import { Document } from '../src/document.js';
import { visitContent, type GlyphEvent } from '../src/text.js';
import { buildDocx } from './helpers/build-docx.js';

const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
/** A4 with 1in margins, so the left text edge is at 72pt. */
const SECT = '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="708" w:footer="708" w:gutter="0"/></w:sectPr>';
const ppr = (inner: string) => wChild(parseWml(new TextEncoder().encode(`<w:p ${W}><w:pPr>${inner}</w:pPr></w:p>`)), 'pPr');

const xOf = (bytes: Uint8Array, ch: string): number | undefined => {
  const doc = Document.Open(bytes);
  let x: number | undefined;
  for (const p of doc.Pages) visitContent(doc, p, { glyph: (g: GlyphEvent) => { if (x === undefined && g.text === ch) x = g.quad[0]; } });
  return x;
};

describe('w:tabs (v9j3.1)', () => {
  it('reads stops: twips to points, alignment and leader mapped', () => {
    const l = readParaLayer(ppr('<w:tabs><w:tab w:val="right" w:leader="dot" w:pos="4320"/><w:tab w:val="start" w:pos="720"/></w:tabs>'));
    expect(l.tabs).toEqual([{ posPt: 216, val: 'right', leader: 'dot' }, { posPt: 36, val: 'left' }]);
    expect(l.unmodelled).not.toContain('w:tabs');
  });
  it('accumulates down the style chain and a clear removes an inherited stop', () => {
    const styles = parseStyles(new TextEncoder().encode(
      `<w:styles ${W}><w:style w:type="paragraph" w:styleId="Base"><w:pPr><w:tabs><w:tab w:val="left" w:pos="1440"/><w:tab w:val="left" w:pos="2880"/></w:tabs></w:pPr></w:style>`
      + `<w:style w:type="paragraph" w:styleId="Kid"><w:basedOn w:val="Base"/><w:pPr><w:tabs><w:tab w:val="clear" w:pos="1440"/><w:tab w:val="center" w:pos="4320"/></w:tabs></w:pPr></w:style></w:styles>`), EMPTY_THEME);
    const r = resolveParagraph(styles, 'Kid', readParaLayer(ppr('<w:tabs><w:tab w:val="decimal" w:pos="5760"/></w:tabs>')));
    expect(r.props.tabs).toEqual([
      { posPt: 144, align: 'left', leader: 'none' },
      { posPt: 216, align: 'center', leader: 'none' },
      { posPt: 288, align: 'decimal', leader: 'none' },
    ]);
  });
  it('a nearer layer restating a position replaces the inherited stop there', () => {
    const styles = parseStyles(new TextEncoder().encode(
      `<w:styles ${W}><w:style w:type="paragraph" w:styleId="Base"><w:pPr><w:tabs><w:tab w:val="left" w:pos="1440"/></w:tabs></w:pPr></w:style></w:styles>`), EMPTY_THEME);
    const r = resolveParagraph(styles, 'Base', readParaLayer(ppr('<w:tabs><w:tab w:val="right" w:leader="dot" w:pos="1440"/></w:tabs>')));
    expect(r.props.tabs).toEqual([{ posPt: 72, align: 'right', leader: 'dot' }]);
  });
  it('maps leaders: heavy -> line, middleDot; bar and num are reported', () => {
    const r = resolveParagraph(emptyStyles(EMPTY_THEME), undefined, readParaLayer(ppr(
      '<w:tabs><w:tab w:val="left" w:leader="heavy" w:pos="720"/><w:tab w:val="left" w:leader="middleDot" w:pos="1440"/>'
      + '<w:tab w:val="bar" w:pos="2160"/><w:tab w:val="num" w:pos="2880"/></w:tabs>')));
    expect(r.props.tabs!.map((t) => t.leader)).toEqual(['line', 'middleDot']);
    expect(r.unmodelled).toEqual(expect.arrayContaining(['w:tab@val=bar', 'w:tab@val=num']));
  });
  it('a negative stop is dropped and reported', () => {
    const r = resolveParagraph(emptyStyles(EMPTY_THEME), undefined, readParaLayer(ppr(
      '<w:tabs><w:tab w:val="left" w:pos="-720"/><w:tab w:val="left" w:pos="720"/></w:tabs>')));
    expect(r.props.tabs).toEqual([{ posPt: 36, align: 'left', leader: 'none' }]);
    expect(r.unmodelled).toContain('w:tab (negative position)');
  });
  it('reads w:defaultTabStop from settings.xml', () => {
    expect(parseDefaultTabStop(new TextEncoder().encode(`<w:settings ${W}><w:defaultTabStop w:val="1440"/></w:settings>`))).toBe(72);
    expect(parseDefaultTabStop(new TextEncoder().encode(`<w:settings ${W}/>`))).toBeUndefined();
  });
  it('renders: a w:tab lands on its stop and is no longer reported', () => {
    const docx = buildDocx(`<w:p><w:pPr><w:tabs><w:tab w:val="left" w:pos="2880"/></w:tabs></w:pPr>`
      + `<w:r><w:t>ab</w:t></w:r><w:r><w:tab/><w:t>Z</w:t></w:r></w:p>` + SECT);
    const d = Document.New();
    const { skipped } = d.AddDocx(docx);
    expect(xOf(d.Save(), 'Z')).toBeCloseTo(72 + 144, 1);             // SECT's w:left 1440 twips
    expect(skipped.map((s) => s.name)).not.toContain('w:tab');
  });
  it('renders: with no stops stated a tab takes the 36pt default', () => {
    const docx = buildDocx(`<w:p><w:r><w:t>ab</w:t></w:r><w:r><w:tab/><w:t>Z</w:t></w:r></w:p>` + SECT);
    const d = Document.New(); d.AddDocx(docx);
    expect(xOf(d.Save(), 'Z')).toBeCloseTo(72 + 36, 1);
  });
  it('renders: settings.xml\'s w:defaultTabStop sets the default interval', () => {
    // 1440 twips, not the 720 every Word file states — which is also our own
    // fallback, so a 720 fixture cannot tell reading the setting from ignoring it.
    const docx = buildDocx(`<w:p><w:r><w:t>ab</w:t></w:r><w:r><w:tab/><w:t>Z</w:t></w:r></w:p>` + SECT,
      { settings: '<w:defaultTabStop w:val="1440"/>' });
    const d = Document.New(); d.AddDocx(docx);
    expect(xOf(d.Save(), 'Z')).toBeCloseTo(72 + 72, 1);
  });
  it('a tab in a table cell is still reported', () => {
    const docx = buildDocx('<w:tbl><w:tr><w:tc><w:p><w:r><w:t>a</w:t><w:tab/><w:t>b</w:t></w:r></w:p></w:tc></w:tr></w:tbl>' + SECT);
    const { skipped } = Document.New().AddDocx(docx);
    expect(skipped.map((s) => s.name)).toContain('w:tab (in a table cell)');
  });
});

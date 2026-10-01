import { describe, it, expect } from 'vitest';
import { Document } from '../src/index.js';
import { buildDocx, type DocxParts } from './helpers/build-docx.js';
import { p, r, numPr, lvl, style } from './helpers/wml.js';

const NUM = `<w:abstractNum w:abstractNumId="0">${lvl(0, 'decimal', '%1.')}${lvl(1, 'lowerLetter', '%1.%2)')}</w:abstractNum>`
  + '<w:abstractNum w:abstractNumId="1"><w:lvl w:ilvl="0"><w:numFmt w:val="bullet"/><w:lvlText w:val=""/></w:lvl></w:abstractNum>'
  + '<w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num><w:num w:numId="2"><w:abstractNumId w:val="1"/></w:num>';
const li = (text: string, numId: number, ilvl = 0, pPr = '') => p(r(text), numPr(numId, ilvl) + pPr);

const render = (body: string, parts: DocxParts = {}) => {
  const doc = Document.New();
  const res = doc.AddDocx(buildDocx(body, { numbering: NUM, ...parts }), { tagged: true });
  return { doc, res, text: doc.Pages[0].GetText() };
};
const types = (doc: Document): string[] => {
  const walk = (els: { Type: string; Children: unknown[] }[]): string[] => els.flatMap((e) => [e.Type, ...walk(e.Children as never)]);
  return walk(doc.GetStructTree()!.Children as never);
};
const at = (doc: Document, t: string) => doc.Pages[0].GetTextFragments().find((x) => x.text.includes(t))!.quad;

describe('AddDocx: lists', () => {
  it('draws Word\'s own labels, nested', () => {
    const { text } = render(li('one', 1) + li('sub', 1, 1) + li('two', 1));
    expect(text).toMatch(/1\.\s*one[\s\S]*1\.a\)\s*sub[\s\S]*2\.\s*two/);
  });

  it('tags a list as /L > /LI, nested', () => {
    const { doc } = render(li('one', 1) + li('sub', 1, 1));
    expect(types(doc).filter((t) => t === 'L').length).toBe(2);
    expect(types(doc).filter((t) => t === 'LI').length).toBe(2);
  });

  it('continues numbering across an interrupting paragraph (Review Focus 3)', () => {
    const { text, doc } = render(li('a', 1) + li('b', 1) + p(r('interrupt')) + li('c', 1));
    expect(text).toMatch(/3\.\s*c/);
    expect(types(doc).filter((t) => t === 'L').length).toBe(2);
  });

  it('draws a Symbol-font bullet as U+2022 and reports it', () => {
    const { text, res } = render(li('dot', 2));
    expect(text).toContain('•');
    expect(res.skipped).toContainEqual({ name: 'w:lvlText (bullet glyph)', count: 1, kind: 'degraded' });
  });

  it('puts an item\'s body at its left indent', () => {
    const { doc } = render(p(r('base')) + li('body', 1, 0, '<w:ind w:left="720" w:hanging="360"/>'));
    expect(at(doc, 'body')[0] - at(doc, 'base')[0]).toBeCloseTo(36, 1);
  });

  it('collapses spacing between items and around the list as between paragraphs', () => {
    const gapAB = (body: string) => { const { doc } = render(body); return at(doc, 'A')[1] - at(doc, 'B')[1]; };
    const base = gapAB(li('A', 1) + li('B', 1));
    expect(gapAB(li('A', 1, 0, '<w:spacing w:after="240"/>') + li('B', 1, 0, '<w:spacing w:before="360"/>')) - base).toBeCloseTo(18, 0);
    const pl = gapAB(p(r('A'), '<w:spacing w:after="480"/>') + li('B', 1, 0, '<w:spacing w:before="120"/>'))
      - gapAB(p(r('A')) + li('B', 1));
    expect(pl).toBeCloseTo(24, 0);
    const lp = gapAB(li('A', 1, 0, '<w:spacing w:after="480"/>') + p(r('B'), '<w:spacing w:before="120"/>'))
      - gapAB(li('A', 1) + p(r('B')));
    expect(lp).toBeCloseTo(24, 0);
  });

  it('reads an item\'s negative spacing as none rather than throwing', () => {
    const { text } = render(li('neg', 1, 0, '<w:spacing w:after="-200"/>') + li('next', 1));
    expect(text).toMatch(/1\.\s*neg[\s\S]*2\.\s*next/);
  });

  it('keeps a numbered heading a heading, its label drawn in front (Review Focus 4)', () => {
    const styles = style('paragraph', 'H', '<w:pPr><w:outlineLvl w:val="1"/></w:pPr>');
    const { doc, text } = render(p(r('Scope'), '<w:pStyle w:val="H"/>' + numPr(1, 0)), { styles });
    expect(types(doc)).toContain('H2');
    expect(types(doc)).not.toContain('L');
    expect(text).toMatch(/1\.\s*Scope/);
  });
});

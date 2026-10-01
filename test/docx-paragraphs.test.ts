import { describe, it, expect } from 'vitest';
import { Document } from '../src/index.js';
import { buildDocx, type DocxParts } from './helpers/build-docx.js';
import { p, r, style } from './helpers/wml.js';

const first = (body: string, parts: DocxParts = {}) => {
  const doc = Document.New();
  const res = doc.AddDocx(buildDocx(body, parts));
  return { doc, res, f: doc.Pages[0].GetTextFragments() };
};
const yOf = (doc: Document, t: string) => doc.Pages[0].GetTextFragments().find((x) => x.text.includes(t))!.quad[1];
const xOf = (doc: Document, t: string) => doc.Pages[0].GetTextFragments().find((x) => x.text.includes(t))!.quad[0];
const gap = (body: string) => { const { doc } = first(body); return yOf(doc, 'A') - yOf(doc, 'B'); };

describe('AddDocx: paragraph layout', () => {
  it('centres and right-aligns', () => {
    const { doc } = first(p(r('mid'), '<w:jc w:val="center"/>') + p(r('end'), '<w:jc w:val="right"/>') + p(r('lft')));
    expect(xOf(doc, 'mid')).toBeGreaterThan(xOf(doc, 'lft') + 100);
    expect(xOf(doc, 'end')).toBeGreaterThan(xOf(doc, 'mid'));
  });

  it('collapses space-after and the next space-before to the larger (the Word oracle\'s rule)', () => {
    const base = gap(p(r('A')) + p(r('B')));
    const spaced = gap(p(r('A'), '<w:spacing w:after="240"/>') + p(r('B'), '<w:spacing w:before="360"/>'));
    expect(spaced - base).toBeCloseTo(18, 0);
    const afterWins = gap(p(r('A'), '<w:spacing w:after="480"/>') + p(r('B'), '<w:spacing w:before="120"/>'));
    expect(afterWins - base).toBeCloseTo(24, 0);
  });

  it('gives an empty paragraph its line, collapsing its spacing with both neighbours', () => {
    const base = gap(p(r('A')) + p(r('B')));
    const withEmpty = gap(p(r('A'), '<w:spacing w:after="240"/>') + p('', '<w:spacing w:before="120" w:after="120"/>')
      + p(r('B'), '<w:spacing w:before="360"/>'));
    // max(12, 6) above the empty line, its 12pt line, max(6, 18) below.
    expect(withEmpty - base).toBeCloseTo(12 + 12 + 18, 0);
  });

  it('honours exact line spacing', () => {
    const lines = (pPr: string) => {
      const { doc } = first(p(r('word '.repeat(80)), pPr));
      const ys = [...new Set(doc.Pages[0].GetTextFragments().map((x) => Math.round(x.quad[1] * 100) / 100))].sort((a, b) => b - a);
      return ys[0] - ys[1];
    };
    expect(lines('<w:spacing w:line="480" w:lineRule="exact"/>')).toBeCloseTo(24, 1);
    // auto is in 240ths of a line: 480 doubles single spacing.
    expect(lines('<w:spacing w:line="480" w:lineRule="auto"/>')).toBeCloseTo(2 * lines(''), 1);
    // at-least never goes below single spacing.
    expect(lines('<w:spacing w:line="20" w:lineRule="atLeast"/>')).toBeCloseTo(lines(''), 1);
  });

  it('renders a paragraph whose stated line spacing is zero, at single spacing, rather than throwing', () => {
    for (const rule of ['exact', 'auto', 'atLeast']) {
      const { doc } = first(p(r('still here')) + p(r('B'), `<w:spacing w:line="0" w:lineRule="${rule}"/>`));
      expect(doc.Pages[0].GetText()).toContain('still here');
      expect(doc.Pages[0].GetText()).toContain('B');
    }
  });

  it('reads negative spacing as none rather than throwing', () => {
    const { doc } = first(p(r('A'), '<w:spacing w:before="-200" w:after="-200"/>') + p(r('B')));
    expect(yOf(doc, 'A') - yOf(doc, 'B')).toBeCloseTo(gap(p(r('A')) + p(r('B'))), 1);
  });

  it('indents left and first-line, and hangs', () => {
    const { doc } = first(p(r('base')) + p(r('ind'), '<w:ind w:left="720"/>')
      + p(r('fl ' + 'word '.repeat(60)), '<w:ind w:firstLine="720"/>')
      + p(r('hg ' + 'term '.repeat(60)), '<w:ind w:left="720" w:hanging="360"/>'));
    const base = xOf(doc, 'base');
    expect(xOf(doc, 'ind') - base).toBeCloseTo(36, 1);
    const f = doc.Pages[0].GetTextFragments();
    expect(xOf(doc, 'fl') - base).toBeCloseTo(36, 1);
    expect(Math.min(...f.filter((x) => x.text.includes('word')).map((x) => x.quad[0])) - base).toBeCloseTo(0, 1);
    expect(xOf(doc, 'hg') - base).toBeCloseTo(18, 1);
    expect(Math.max(...f.filter((x) => x.text.startsWith('term')).map((x) => x.quad[0])) - base).toBeCloseTo(36, 1);
  });

  it('clamps a hanging indent past the left margin and reports it', () => {
    const { res, doc } = first(p(r('base')) + p(r('h'), '<w:ind w:left="0" w:hanging="360"/>'));
    expect(res.skipped).toContainEqual({ name: 'w:ind (hanging past margin)', count: 1, kind: 'degraded' });
    expect(xOf(doc, 'h')).toBeCloseTo(xOf(doc, 'base'), 1);
  });

  it('makes an outline-level paragraph a heading, with Word\'s own face and size', () => {
    const styles = style('paragraph', 'H1', '<w:pPr><w:outlineLvl w:val="0"/></w:pPr><w:rPr><w:sz w:val="32"/></w:rPr>');
    const doc = Document.New();
    doc.AddDocx(buildDocx(p(r('Title'), '<w:pStyle w:val="H1"/>') + p(r('body')), { styles }), { tagged: true });
    const types = (el: { Type: string; Children: unknown[] }[]): string[] =>
      el.flatMap((e) => [e.Type, ...types(e.Children as never)]);
    expect(types(doc.GetStructTree()!.Children as never)).toContain('H1');
    const title = doc.Pages[0].GetTextFragments().find((x) => x.text.includes('Title'))!;
    expect(title.fontSize).toBeCloseTo(16, 3);
    expect(title.fontName).toMatch(/Times/);
  });

  it('renders outline levels 7-9 as H6 and reports it', () => {
    const doc = Document.New();
    const { skipped } = doc.AddDocx(buildDocx(p(r('deep'), '<w:outlineLvl w:val="7"/>')), { tagged: true });
    expect(skipped).toContainEqual({ name: 'w:outlineLvl=7', count: 1, kind: 'degraded' });
    expect(doc.Pages[0].GetText()).toContain('deep');
  });
});

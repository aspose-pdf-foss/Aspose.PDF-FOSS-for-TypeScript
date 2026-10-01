import { describe, it, expect } from 'vitest';
import { Document } from '../src/index.js';
import { buildDocx } from './helpers/build-docx.js';
import { p, r } from './helpers/wml.js';

const tc = (text: string, tcPr = '') => `<w:tc>${tcPr ? `<w:tcPr>${tcPr}</w:tcPr>` : ''}${p(text === '' ? '' : r(text))}</w:tc>`;
const tbl = (grid: number[], rows: string[]) => `<w:tbl><w:tblGrid>${grid.map((g) => `<w:gridCol w:w="${g * 20}"/>`).join('')}</w:tblGrid>`
  + rows.join('') + '</w:tbl>';
const tr = (cells: string, trPr = '') => `<w:tr>${trPr ? `<w:trPr>${trPr}</w:trPr>` : ''}${cells}</w:tr>`;

const render = (body: string) => {
  const doc = Document.New();
  const res = doc.AddDocx(buildDocx(body), { tagged: true });
  return { doc, res, text: doc.Pages[0].GetText() };
};
interface El { Type: string; Children: El[]; TableAttributes?: { colSpan?: number; rowSpan?: number } }
const all = (els: El[]): El[] => els.flatMap((e) => [e, ...all(e.Children)]);
const els = (doc: Document): El[] => all(doc.GetStructTree()!.Children as never);
const xOf = (doc: Document, t: string) => doc.Pages[0].GetTextFragments().find((x) => x.text.includes(t))!.quad[0];

describe('AddDocx: tables', () => {
  it('draws cells in grid order and tags /Table > /TR > /TD', () => {
    const { doc, text } = render(tbl([100, 100], [tr(tc('a1') + tc('b1')), tr(tc('a2') + tc('b2'))]));
    expect(text).toMatch(/a1[\s\S]*b1[\s\S]*a2[\s\S]*b2/);
    const types = els(doc).map((e) => e.Type);
    expect(types.filter((t) => t === 'Table')).toHaveLength(1);
    expect(types.filter((t) => t === 'TR')).toHaveLength(2);
    expect(types.filter((t) => t === 'TD')).toHaveLength(4);
  });

  it('gives each column its grid width', () => {
    const { doc } = render(tbl([100, 200, 100], [tr(tc('a') + tc('b') + tc('c'))]));
    expect(xOf(doc, 'b') - xOf(doc, 'a')).toBeCloseTo(100, 0);
    expect(xOf(doc, 'c') - xOf(doc, 'b')).toBeCloseTo(200, 0);
  });

  it('spans columns and merges rows', () => {
    const { doc } = render(tbl([100, 100], [
      tr(tc('wide', '<w:gridSpan w:val="2"/>')),
      tr(tc('tall', '<w:vMerge w:val="restart"/>') + tc('x')),
      tr(tc('', '<w:vMerge/>') + tc('y')),
    ]));
    const tds = els(doc).filter((e) => e.Type === 'TD');
    expect(tds).toHaveLength(4);
    expect(tds.some((e) => e.TableAttributes?.colSpan === 2)).toBe(true);
    expect(tds.some((e) => e.TableAttributes?.rowSpan === 2)).toBe(true);
    expect(xOf(doc, 'y')).toBeCloseTo(xOf(doc, 'x'), 1);
  });

  it('ends a vertical merge where the continuation spans differently, and reports it', () => {
    const { doc, res } = render(tbl([100, 100, 100], [
      tr(tc('wide', '<w:gridSpan w:val="2"/><w:vMerge w:val="restart"/>') + tc('c')),
      tr(tc('', '<w:vMerge/>') + tc('y') + tc('z')),
    ]));
    expect(res.skipped).toContainEqual({ name: 'w:vMerge (span mismatch)', count: 1, kind: 'degraded' });
    expect(els(doc).some((e) => e.TableAttributes?.rowSpan === 2)).toBe(false);
    // Every grid column of the second row is filled: z sits under c, y in between.
    expect(xOf(doc, 'z')).toBeCloseTo(xOf(doc, 'c'), 1);
    expect(xOf(doc, 'y')).toBeLessThan(xOf(doc, 'z'));
    expect(els(doc).filter((e) => e.Type === 'TD')).toHaveLength(5);
  });

  it('counts a vertical merge down the GRID column in a row shifted by gridBefore (Review Focus 5)', () => {
    const { doc } = render(tbl([100, 100, 100], [
      tr(tc('a') + tc('m', '<w:vMerge w:val="restart"/>') + tc('c')),
      tr(tc('', '<w:vMerge/>') + tc('z'), '<w:gridBefore w:val="1"/>'),
    ]));
    expect(els(doc).some((e) => e.TableAttributes?.rowSpan === 2)).toBe(true);
    expect(xOf(doc, 'z')).toBeCloseTo(xOf(doc, 'c'), 1);
  });

  it('keeps a merge continuation with no restart above it as a cell of its own', () => {
    const { doc, text } = render(tbl([100, 100], [tr(tc('a') + tc('b')), tr(tc('c', '<w:vMerge/>') + tc('d'))]));
    expect(text).toMatch(/c[\s\S]*d/);
    expect(xOf(doc, 'd')).toBeCloseTo(xOf(doc, 'b'), 1);
  });

  it('repeats header rows and marks them /TH', () => {
    const { doc } = render(tbl([100], [tr(tc('Head'), '<w:tblHeader/>'), tr(tc('body'))]));
    const types = els(doc).map((e) => e.Type);
    expect(types.filter((t) => t === 'TH')).toHaveLength(1);
    expect(types.filter((t) => t === 'TD')).toHaveLength(1);
  });

  it('scales a grid wider than the column instead of overflowing (Review Focus 1)', () => {
    const { doc } = render(tbl([400, 400], [tr(tc('left') + tc('right'))]));
    const f = doc.Pages[0].GetTextFragments().find((x) => x.text.includes('right'))!;
    expect(f.quad[2]).toBeLessThan(doc.Pages[0].CropBox[2] - 72 + 1);
    // Two equal columns of the 451pt column, not two 400pt ones.
    expect(f.quad[0] - xOf(doc, 'left')).toBeCloseTo((doc.Pages[0].CropBox[2] - 144) / 2, 0);
  });

  it('renders a table whose rows disagree with its grid rather than throwing', () => {
    const { text } = render(tbl([100], [tr(tc('a') + tc('b') + tc('c'))]));
    expect(text).toMatch(/a[\s\S]*b[\s\S]*c/);
  });

  it('fills a shaded cell with its colour', () => {
    const { doc } = render(tbl([100], [tr(tc('s', '<w:shd w:val="clear" w:fill="FF0000"/>'))]));
    const fills = doc.Pages[0].GetPaths().map((x) => JSON.stringify(x.fill));
    expect(fills.some((f) => /\[1,0,0\]/.test(f))).toBe(true);
  });

  it('flattens a nested table into its cell and reports it', () => {
    const inner = tbl([50], [tr(tc('inner'))]);
    const { text, res } = render(tbl([200], [tr(`<w:tc>${p(r('outer'))}${inner}${p('')}</w:tc>`)]));
    expect(text).toMatch(/outer[\s\S]*inner/);
    expect(res.skipped).toContainEqual({ name: 'w:tbl (nested)', count: 1, kind: 'degraded' });
  });

  it('separates a cell\'s paragraphs with a line break', () => {
    const { doc } = render(tbl([200], [tr(`<w:tc>${p(r('alpha'))}${p(r('beta'))}</w:tc>`)]));
    const f = doc.Pages[0].GetTextFragments();
    const a = f.find((x) => x.text.includes('alpha'))!;
    const b = f.find((x) => x.text.includes('beta'))!;
    expect(a.quad[1]).toBeGreaterThan(b.quad[1] + 5);
  });

  it('does not carry a paragraph\'s space-after past the table', () => {
    const y = (after: string) => {
      const { doc } = render(p(r('A'), after) + tbl([100], [tr(tc('T'))]) + p(r('B'), '<w:spacing w:before="240"/>'));
      const f = doc.Pages[0].GetTextFragments();
      return f.find((x) => x.text.includes('T'))!.quad[1] - f.find((x) => x.text.includes('B'))!.quad[1];
    };
    expect(y('<w:spacing w:after="480"/>')).toBeCloseTo(y(''), 1);
  });
});

import { describe, expect, it } from 'vitest';
import { Document } from '../src/document.js';
import { visitContent } from '../src/text.js';
import { buildMultiStreamPage } from './helpers/build-edit-pdf.js';
import { buildType0Pdf } from './helpers/build-text-pdf.js';

const line = (x: number, y: number, show: string) => `BT /F1 10 Tf ${x} ${y} Td ${show} ET`;
const draw = (x: number, y: number, value: string) => line(x, y, `(${value}) Tj`);

describe('AutoTag lists', () => {
  it('separates the painted labels and bodies, including a kerned TJ, in logical order', () => {
    const doc = Document.Open(buildMultiStreamPage([
      [draw(40, 260, 'Introduction.'), line(40, 246, '[(1.) -400 (First)] TJ'),
        draw(52, 232, '- Nested'), draw(52, 218, '- Next'),
        draw(58, 204, 'continued'), draw(40, 190, '2. Second'),
        draw(40, 176, '3. Third'), draw(40, 162, 'Conclusion.')].join('\n'),
    ]));
    const page = doc.Pages[0];
    const positioned = (d: Document) => {
      const glyphs: unknown[] = [];
      visitContent(d, d.Pages[0], { glyph: g => glyphs.push([g.text, g.quad]) });
      return glyphs;
    };
    const original = positioned(doc);
    page.AddLink({ rect: [54, 189, 90, 201], action: { type: 'uri', uri: 'https://example.org' } });
    expect(doc.AutoTag({ tables: false }).lists).toBe(2);
    const saved = Document.Open(doc.Save());
    const tree = saved.GetStructTree()!;
    expect(tree.Children.map(e => e.Type)).toEqual(['P', 'L', 'P']);
    const [intro, list, outro] = tree.Children;
    expect([intro.GetText(), outro.GetText()]).toEqual(['Introduction.', 'Conclusion.']);
    expect(list.Children.map(e => e.Type)).toEqual(['LI', 'LI', 'LI']);
    const [first, second, third] = list.Children;
    expect(first.Children.map(e => e.Type)).toEqual(['Lbl', 'LBody']);
    const [label, body] = first.Children;
    expect(label.GetText().trim()).toBe('1.');
    expect(body.GetText(e => e.Type === 'L').trim()).toBe('First');
    expect(body.GetText().split('\n')[0]).toBe('First');
    const [nested] = body.Children;
    expect(nested.Type).toBe('L');
    expect(nested.Children.map(item => item.Children.map(e => e.GetText().trim()))).toEqual([
      ['-', 'Nested'], ['-', 'Next\ncontinued'],
    ]);
    expect(second.Children.map(e => e.GetText().trim())).toEqual(['2.', 'Second']);
    expect(third.Children.map(e => e.GetText().trim())).toEqual(['3.', 'Third']);
    expect(second.Children[1].Children[0].Type).toBe('Link');
    expect(positioned(saved)).toEqual(original);
    expect(list.ListAttributes?.listNumbering).toBe('Decimal');
    expect(nested.ListAttributes?.listNumbering).toBe('Disc');
    visitContent(saved, saved.Pages[0], { glyph: g => {
      expect(tree.ElementFor(saved.Pages[0].Dict.get('StructParents') as number, g.mcid!)?.Type)
        .toMatch(/^(P|Lbl|LBody)$/);
    } });
  });

  it('accepts labels and bodies drawn by separate page streams', () => {
    const doc = Document.Open(buildMultiStreamPage([
      draw(20, 240, '-'), draw(32, 240, 'one'), draw(20, 226, '-'), draw(32, 226, 'two'),
    ]));
    expect(doc.AutoTag({ tables: false }).lists).toBe(1);
    const list = Document.Open(doc.Save()).GetStructTree()!.Children[0];
    expect(list.Children.map(li => li.Children.map(el => el.GetText()))).toEqual([['-', 'one'], ['-', 'two']]);
  });

  it('keeps the next numbered item after a hanging continuation', () => {
    const doc = Document.Open(buildMultiStreamPage([[
      draw(20, 210, '1. First'), draw(31, 196, 'wrapped'), draw(20, 182, '2. Second'),
    ].join('\n')]));
    expect(doc.AutoTag({ tables: false }).lists).toBe(1);
    const [list] = Document.Open(doc.Save()).GetStructTree()!.Children;
    expect(list.Children.map(li => li.Children[1].GetText())).toEqual(['First\nwrapped', 'Second']);
  });

  it('joins wide nested indents across text blocks and stops at a vertical gap', () => {
    const doc = Document.Open(buildMultiStreamPage([[
      draw(20, 250, '1. First'), draw(44, 236, 'a. Nested'), draw(44, 222, 'b. Next'),
      draw(20, 208, '2. Second'), draw(44, 176, '1. Separate'), draw(44, 162, '2. List'),
    ].join('\n')]));
    expect(doc.AutoTag({ tables: false }).lists).toBe(3);
    const [outer, separate] = Document.Open(doc.Save()).GetStructTree()!.Children;
    expect(outer.Children.map(li => li.Children[1].GetText(e => e.Type === 'L'))).toEqual(['First', 'Second']);
    expect(outer.Children[0].Children[1].Children[0].Children.map(li => li.Children[1].GetText()))
      .toEqual(['Nested', 'Next']);
    expect(separate.Children.map(li => li.Children[1].GetText())).toEqual(['Separate', 'List']);
  });

  it('starts a sibling list on a change of numbering and keeps split words together', () => {
    const doc = Document.Open(buildMultiStreamPage([[
      line(20, 240, '(- W) Tj /F1 10 Tf (ord) Tj'), draw(20, 226, '- two'),
      draw(20, 212, 'A. First'), draw(20, 198, 'B. Second'), draw(20, 184, 'C. Third'),
    ].join('\n')]));
    expect(doc.AutoTag({ tables: false }).lists).toBe(2);
    const [bullets, letters] = Document.Open(doc.Save()).GetStructTree()!.Children;
    expect(bullets.Children[0].Children[1].GetText()).toBe('Word');
    expect(letters.ListAttributes?.listNumbering).toBe('UpperAlpha');
    expect(letters.Children).toHaveLength(3);
  });

  it('keeps an overlapping artifact outside both the label and body', () => {
    const doc = Document.Open(buildMultiStreamPage([[
      draw(20, 240, '- one'), draw(20, 226, '- two'),
      '/Artifact BMC', draw(20, 240, 'mark'), 'EMC',
    ].join('\n')]));
    expect(doc.AutoTag({ tables: false }).lists).toBe(1);
    const re = Document.Open(doc.Save());
    const items = re.GetStructTree()!.Children[0].Children;
    expect(items.map(li => li.Children.map(e => e.GetText()))).toEqual([['-', 'one'], ['-', 'two']]);
    visitContent(re, re.Pages[0], { glyph: g => { if (g.artifact) expect(g.mcid).toBeUndefined(); } });
  });

  it('splits two-byte glyph codes and applies a quote operator’s line move only once', () => {
    const cmap = '1 begincodespacerange <0000> <FFFF> endcodespacerange '
      + '4 beginbfchar <0001> <2022> <0002> <0020> <0003> <7532> <0004> <4E59> endbfchar';
    const doc = Document.Open(buildType0Pdf(
      'BT /F1 10 Tf 14 TL 20 240 Td <000100020003> Tj 0 0 <000100020004> " ET', cmap));
    const original = doc.Pages[0].GetTextFragments();
    expect(doc.AutoTag({ tables: false }).lists).toBe(1);
    const saved = Document.Open(doc.Save());
    expect(saved.Pages[0].GetTextFragments()).toEqual(original);
    expect(saved.GetStructTree()!.Children[0].Children.map(li => li.Children.map(e => e.GetText())))
      .toEqual([['•', '甲'], ['•', '乙']]);
  });

  it('keeps a line whose label and body come from one indivisible glyph as prose', () => {
    const cmap = '1 begincodespacerange <0000> <FFFF> endcodespacerange '
      + '2 beginbfchar <0001> <002D00200041> <0002> <002D00200042> endbfchar';
    const doc = Document.Open(buildType0Pdf('BT /F1 10 Tf 20 240 Td <0001> Tj 0 -14 Td <0002> Tj ET', cmap));
    expect(doc.Pages[0].GetText()).toBe('- A\n- B');
    expect(doc.AutoTag({ tables: false }).lists).toBe(0);
    const [para] = Document.Open(doc.Save()).GetStructTree()!.Children;
    expect(para.Type).toBe('P');
    expect(para.GetText()).toBe('- A\n- B');
  });

  it('retains ordinary prose for an isolated marker and when inference is disabled', () => {
    const doc = Document.Open(buildMultiStreamPage([draw(20, 240, '1990. A year in review.')]));
    expect(doc.AutoTag().lists).toBe(0);
    expect(doc.GetStructTree()!.Children.map(e => e.Type)).toEqual(['P']);
    const off = Document.Open(buildMultiStreamPage([[draw(20, 240, '- one'), draw(20, 226, '- two')].join('\n')]));
    expect(off.AutoTag({ lists: false }).lists).toBe(0);
    expect(off.GetStructTree()!.Children.map(e => e.Type)).toEqual(['P']);
  });
});

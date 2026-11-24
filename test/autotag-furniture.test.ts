import { describe, expect, it } from 'vitest';
import { Document } from '../src/document.js';
import { prepareFurniture } from '../src/autotagfurniture.js';
import { extractStructured, visitContent } from '../src/text.js';
import { streamOf } from '../src/pagecontent.js';
import { isDict } from '../src/types.js';
import { buildMultiStreamPage } from './helpers/build-edit-pdf.js';
import { hline, vline } from './helpers/build-table-pdf.js';

function documentOf(...contents: string[]): Document {
  const doc = Document.New();
  for (const source of contents)
    doc.AddPage(Document.Open(buildMultiStreamPage([source])).Pages[0]);
  return doc;
}

const text = (s: string, y: number, x = 20) => `BT /F1 10 Tf ${x} ${y} Td (${s}) Tj ET\n`;

describe('recurring furniture', () => {
  it('marks only matching top-level shows, leaving ink and the adjacent body in their original positions', () => {
    const page = (body: string) => text('Running', 280) + text(body, 266) +
      '0 0 m 100 100 l S\n' + text('Head', 280, 60);
    const doc = documentOf(page('Apples'), page('Pears'));
    const original = doc.Pages.map(p => p.GetText());
    const render = doc.Pages[0].ToImage();
    const mark = prepareFurniture(doc, true);
    expect(doc.Pages.map(p => mark(p))).toEqual([1, 1]);
    const saved = Document.Open(doc.Save());
    expect(saved.Pages.map(p => p.GetText())).toEqual(original);
    expect(saved.Pages[0].ToImage()).toEqual(render);
    for (const [i, p] of saved.Pages.entries()) {
      expect(extractStructured(saved, p, undefined, g => !g.artifact).map(b => b.text)).toEqual([i ? 'Pears' : 'Apples']);
      expect(p.Artifacts.map(a => [a.type, a.subtype])).toEqual([
        ['Pagination', 'Header'], ['Pagination', 'Header'],
      ]);
      let strokeInArtifact: boolean | undefined;
      visitContent(saved, p, { path: e => { strokeInArtifact = !!e.artifact; } });
      expect(strokeInArtifact).toBe(false);
    }
  });

  it('recognizes a changing folio through two digits, preserving unrelated changing numbers and central text', () => {
    const pages = Array.from({ length: 11 }, (_, i) =>
      text(`Page ${i + 1} of 11`, 6) + text(`Invoice ${i + 1}`, 280) + text('Ordinary recurring content', 140));
    const doc = documentOf(...pages);
    const mark = prepareFurniture(doc, true);
    expect(doc.Pages.map(p => mark(p))).toEqual(pages.map(() => 1));
    for (const [i, p] of doc.Pages.entries()) {
      expect(p.Artifacts.map(a => a.subtype)).toEqual(['Footer']);
      expect(extractStructured(doc, p, undefined, g => !g.artifact).map(b => b.text)).toEqual([
        `Invoice ${i + 1}`, 'Ordinary recurring content',
      ]);
    }
  });

  it('requires recurrence and caller confirmation for central text, including rotated watermarks crossing prose', () => {
    const doc = documentOf(text('Original body', 150) + text('ONLY HERE', 80), text('Other body', 150));
    doc.AddWatermark({ text: 'DRAFT', rotate: 45 });
    const implicit = prepareFurniture(doc, true);
    expect(doc.Pages.map(p => implicit(p))).toEqual([0, 0]);
    const confirmed = prepareFurniture(doc, false, t => t === 'DRAFT' || t === 'ONLY HERE');
    expect(doc.Pages.map(p => confirmed(p))).toEqual([1, 1]);
    for (const [i, p] of doc.Pages.entries()) {
      expect(p.Artifacts.map(a => a.subtype)).toEqual(['Watermark']);
      expect(extractStructured(doc, p, undefined, g => !g.artifact).map(b => b.text))
        .toEqual(i ? ['Other body'] : ['Original body', 'ONLY HERE']);
    }
  });

  it('leaves a show intact when one glyph also supplies text outside the matched line', () => {
    const doc = documentOf(text('X', 150), text('X', 150));
    // ToUnicode can map a single painted glyph to several Unicode characters.
    // A caller confirming the first line cannot claim the rest of that glyph.
    const cmap = '1 beginbfchar <58> <0041000A0042> endbfchar';
    for (const p of doc.Pages) {
      const fonts = doc.resolve(p.Resources!.get('Font'));
      const font = isDict(fonts) && doc.resolve(fonts.get('F1'));
      if (!isDict(font)) throw new Error('missing fixture font');
      font.set('ToUnicode', doc.allocObject(streamOf(new TextEncoder().encode(cmap))));
    }
    expect(doc.FindWatermarks().map(c => c.kind === 'text' && c.text)).toEqual(['A', 'B']);
    const mark = prepareFurniture(doc, false, t => t === 'A');
    expect(doc.Pages.map(p => mark(p))).toEqual([0, 0]);
    expect(doc.Pages[0].Artifacts).toEqual([]);
  });

  it('preserves repeated column titles in a table that starts in the upper margin', () => {
    const grid = [295, 270, 245].map(y => hline(10, 210, y)).join('') +
      [10, 110, 210].map(x => vline(x, 245, 295)).join('') +
      text('Fruit', 280) + text('Qty', 280, 120) + text('Mango', 252) + text('5', 252, 120);
    const doc = documentOf(grid, grid);
    const report = doc.AutoTag({ furniture: true });
    expect(report.tables).toBe(2);
    expect(report.artifacts).toBe(0);
    const saved = Document.Open(doc.Save());
    for (const table of saved.GetStructTree()!.Children.filter(el => el.Type === 'Table'))
      expect(table.Children[0].Children.map(cell => cell.GetText())).toEqual(['Fruit', 'Qty']);
  });
});

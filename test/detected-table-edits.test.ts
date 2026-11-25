import { expect, it } from 'vitest';
import { createTable, Document, UnsupportedFeatureError } from '../src/index.js';
import { buildTablePdf, hline, text, vline } from './helpers/build-table-pdf.js';
import { buildTaggedTablePdf } from './helpers/build-tagged-table-pdf.js';
import { appendContent } from '../src/pagecontent.js';

const grid = [hline(20, 180, 120), hline(20, 180, 160), hline(20, 180, 200),
  vline(20, 120, 200), vline(100, 120, 200), vline(180, 120, 200),
  text(30, 180, 'left'), text(110, 180, 'right'), text(30, 140, 'lower')].join('');
const open = (extra = '') => Document.Open(buildTablePdf(grid + text(20, 80, 'neighbor') + extra));
function replacement() {
  const builder = createTable({ border: { width: 1, color: [0, 0, 0] } });
  builder.addRow(['new', 'cells']);
  return builder;
}

it('removes only the detected table from a page with shared streams and resources', () => {
  const d = open();
  d.Reorder([1, 1]);
  const [handle] = d.Pages[0].GetTables();
  handle.quad[0] = -100;
  handle.Remove();
  expect(() => handle.Remove()).toThrow(/stale/i);
  const [first, second] = Document.Open(d.Save()).Pages;
  expect(first.GetText()).toBe('neighbor');
  expect(first.GetPaths()).toHaveLength(0);
  expect(second.GetTables()[0].rows[0].cells[0].text).toBe('left');
});

it('replaces at the original top-left and width and preserves the other drawing of a Form', () => {
  const source = Document.Open(buildTablePdf(grid));
  const d = Document.New();
  const p = d.AddPage().page;
  p.StampWith(source.Pages[0], { rect: [0, 0, 300, 300] });
  const repeat = 'q 1 0 0 1 300 0 cm\n' + new TextDecoder().decode(p.Contents) + '\nQ';
  appendContent(d, p, new TextEncoder().encode(repeat));
  p.GetTables()[0].Replace(replacement());
  const [changed, other] = Document.Open(d.Save()).Pages[0].GetTables();
  expect(changed.quad).toEqual([20, expect.any(Number), 180, 200]);
  expect(changed.rows[0].cells.map(c => c.text)).toEqual(['new', 'cells']);
  expect(other.rows[0].cells[0].text).toBe('left');
  changed.Remove();
});

it('rejects an oversized replacement before changing any PDF objects', () => {
  const d = open(), p = d.Pages[0], before = d.Save();
  const builder = replacement();
  builder.addRow(['extra'], { minHeight: 100 });
  expect(() => p.GetTables()[0].Replace(builder)).toThrow(/fit/i);
  expect(d.Save()).toEqual(before);
});

it('leaves shared content and resources intact when drawing a later cell fails', () => {
  const d = open();
  d.Reorder([1, 1]);
  const p = d.Pages[0], before = d.Save(), contents = p.Dict.get('Contents'), resources = p.Resources;
  const builder = createTable({ background: [1, 0, 0] });
  builder.addRow(['first', [{ text: 'invalid', color: [2, 0, 0] }]]);
  const [table] = p.GetTables();
  expect(() => table.Replace(builder)).toThrow(/color/i);
  expect(p.Dict.get('Contents')).toBe(contents);
  expect(p.Resources).toBe(resources);
  expect(d.Save()).toEqual(before);
  table.Replace(replacement());
  expect(p.GetText()).toContain('new');
});

it('rejects a short replacement whose unbreakable text would overpaint its neighbor', () => {
  const d = open(), before = d.Save();
  const t = createTable();
  t.addRow(['A', 'W'.repeat(32)]);
  expect(() => d.Pages[0].GetTables()[0].Replace(t)).toThrow(/fit/i);
  expect(d.Save()).toEqual(before);
});

it('removes an upright borderless table reconstructed from text', () => {
  const stream = [200, 180, 160].map(y => text(50, y, 'left') + text(160, y, 'right')).join('');
  const d = Document.Open(buildTablePdf(stream));
  d.Pages[0].GetTables()[0].Remove();
  expect(Document.Open(d.Save()).Pages[0].GetText()).toBe('');
});

it('rejects an overlapping drawing and a glyph run crossing the boundary atomically', () => {
  for (const overlay of ['0 110 m 70 150 l S', text(170, 140, 'over the edge')]) {
    const d = open(overlay), before = d.Save();
    expect(() => d.Pages[0].GetTables()[0].Remove()).toThrow(UnsupportedFeatureError);
    expect(d.Save()).toEqual(before);
  }
});

it('refuses edits through a tagged table result', () => {
  const d = Document.Open(buildTaggedTablePdf());
  expect(() => d.Pages[0].GetTables()[0].Remove()).toThrow(UnsupportedFeatureError);
});

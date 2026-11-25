import { expect, it } from 'vitest';
import { createTable, Document, UnsupportedFeatureError } from '../src/index.js';
import { buildTablePdf, hline, rotate, text, vline } from './helpers/build-table-pdf.js';
import { buildTaggedTablePdf } from './helpers/build-tagged-table-pdf.js';
import { appendContent } from '../src/pagecontent.js';
import { lookupNameTree } from '../src/nametree.js';

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

it('removes a tagged table and releases its MCIDs while preserving the following paragraph', () => {
  const d = Document.Open(buildTaggedTablePdf());
  d.Pages[0].AddText('neighbor', 50, 80, { tag: d.GetStructTree()!.Append('P') });
  const [table] = d.Pages[0].GetTables();
  table.Remove();
  expect(() => table.Remove()).toThrow(/stale/i);
  const saved = Document.Open(d.Save()), root = saved.GetStructTree()!;
  expect(saved.Pages[0].GetText()).toBe('neighbor');
  expect(root.Children.map(e => e.Type)).toEqual(['P']);
  for (let i = 0; i < 10; i++) expect(root.ElementFor(0, i)).toBeUndefined();
  expect(root.ElementFor(0, 10)?.GetText()).toBe('neighbor');
});

it('rebuilds tagged cells in reading order and rolls back an unsuccessful redraw', () => {
  const d = Document.Open(buildTaggedTablePdf()), p = d.Pages[0];
  p.AddText('neighbor', 50, 80, { tag: d.GetStructTree()!.Append('P') });
  const [table] = p.GetTables(), before = d.Save();
  const bad = createTable({ background: [1, 0, 0] });
  bad.addRow(['first', [{ text: 'bad', color: [2, 0, 0] }]]);
  expect(() => table.Replace(bad)).toThrow(/color/i);
  expect(d.Save()).toEqual(before);
  const good = createTable({ border: { color: [0, 0, 0], width: 1 } });
  good.addRow().addCell('Heading', { header: 'column' });
  good.addRow(['Value']);
  table.Replace(good);
  const saved = Document.Open(d.Save()), root = saved.GetStructTree()!;
  expect(root.Children.map(e => e.Type)).toEqual(['Table', 'P']);
  const [edited] = saved.Pages[0].GetTables();
  expect(edited.rows.map(r => r.cells[0].text)).toEqual(['Heading', 'Value']);
  expect(edited.rows[0].cells[0].scope).toBe('Column');
  expect(root.ElementFor(0, 0)).toBeUndefined();
  edited.Remove();
  expect(saved.Pages[0].GetPaths()).toHaveLength(0);
  expect(saved.Pages[0].GetText()).toBe('neighbor');
});

it('rejects an external reference to a disappearing tagged header before writing', () => {
  const d = Document.Open(buildTaggedTablePdf()), root = d.GetStructTree()!;
  const cell = root.Children[0].Children[0].Children[0].Children[0];
  root.Append('P').Dict.set('Ref', [cell.Ref!]);
  const before = d.Save(), [table] = d.Pages[0].GetTables();
  expect(() => table.Remove()).toThrow(/external reference/i);
  expect(() => table.Replace(replacement())).toThrow(/external reference/i);
  expect(d.Save()).toEqual(before);
});

it('recovers the ruled cell boxes in older tagged files that omit layout attributes', () => {
  const d = Document.New(), p = d.AddPage().page;
  const old = replacement();
  old.addRow(['a', 'b']);
  const { struct } = p.AddTable(old, 20, 180, { tagged: true, width: 200 });
  for (const row of struct!.Children) for (const cell of row.Children) cell.Dict.delete('A');
  const reopened = Document.Open(d.Save()), pg = reopened.Pages[0];
  pg.GetTables()[0].Replace(replacement());
  expect(pg.GetTables()[0].quad).toEqual([20, expect.any(Number), 220, 180]);
  pg.GetTables()[0].Remove();
  expect(pg.GetPaths().filter(p => p.fill || p.stroke)).toHaveLength(0);
});

it('allows removal under a separate tagged paragraph but blocks painting a replacement over it', () => {
  const d = Document.Open(buildTaggedTablePdf()), p = d.Pages[0];
  p.AddText('survivor', 70, 310, { tag: d.GetStructTree()!.Append('P') });
  const before = d.Save(), [table] = p.GetTables();
  expect(() => table.Replace(replacement())).toThrow(/overlap/i);
  expect(d.Save()).toEqual(before);
  table.Remove();
  expect(Document.Open(d.Save()).Pages[0].GetText()).toBe('survivor');
});

it('preserves unrelated ID-tree entries and blocks a surviving header association', () => {
  const d = Document.Open(buildTaggedTablePdf()), p = d.Pages[0], root = d.GetStructTree()!;
  const cell = root.Children[0].Children[0].Children[0].Children[0];
  const sibling = root.Append('TD');
  sibling.SetTableAttributes({ headers: ['h1'] });
  const key = { kind: 'string' as const, bytes: new TextEncoder().encode('other') };
  sibling.Dict.set('ID', key);
  root.Dict.set('IDTree', new Map([['Names', [cell.Dict.get('ID')!, cell.Ref!, key, sibling.Ref!]]]));
  const before = d.Save();
  expect(() => p.GetTables()[0].Remove()).toThrow(/external reference/i);
  expect(d.Save()).toEqual(before);
  sibling.SetTableAttributes({ headers: [] });
  p.GetTables()[0].Remove();
  const saved = Document.Open(d.Save()), r = saved.GetStructTree()!, tree = r.Dict.get('IDTree')!;
  expect(lookupNameTree(saved, tree, 'h1')).toBeUndefined();
  expect(saved.resolve(lookupNameTree(saved, tree, 'other'))).toBe(r.Children[0].Dict);
});

it('clears superseded table-level ActualText when replacing the cell contents', () => {
  const d = Document.Open(buildTaggedTablePdf());
  d.GetStructTree()!.Children[0].ActualText = 'obsolete';
  d.Pages[0].GetTables()[0].Replace(replacement());
  expect(Document.Open(d.Save()).GetStructTree()!.Children[0].ActualText).toBeUndefined();
});

it.each([30, 90, -30, 180])('replaces a %i-degree table at its original angle and anchor after reopen', degrees => {
  const d = Document.Open(buildTablePdf(rotate(degrees, 200, 80, grid)));
  const [t] = d.Pages[0].GetTables(), [left, , right, top] = t.quad, angle = t.angle;
  expect(Math.abs(angle)).toBeGreaterThan(0.1);
  t.angle = 0;
  t.Replace(replacement());
  const reopened = Document.Open(d.Save()), [changed] = reopened.Pages[0].GetTables();
  expect(Math.sin(changed.angle)).toBeCloseTo(Math.sin(angle), 5);
  expect(Math.cos(changed.angle)).toBeCloseTo(Math.cos(angle), 5);
  expect(changed.quad[0]).toBeCloseTo(left, 3);
  expect(changed.quad[2]).toBeCloseTo(right, 3);
  expect(changed.quad[3]).toBeCloseTo(top, 3);
  expect(changed.rows[0].cells.map(c => c.text)).toEqual(['new', 'cells']);
  changed.Remove();
  expect(Document.Open(reopened.Save()).Pages[0].GetText()).toBe('');
});

it('keeps text and artwork in a corner outside the tilted grid and isolates the shared page', () => {
  // At 30 degrees this grid occupies x=17..196, y=114..263.
  // The small marks at (24,122) are inside that bounding box but outside the grid.
  const neighbor = text(24, 122, 'keep') + '24 121 4 2 re f\nq 2 0 0 2 24 124 cm BI /W 1 /H 1 /BPC 8 /CS /G ID X EI Q';
  const d = Document.Open(buildTablePdf(rotate(30, 100, 0, grid) + neighbor));
  d.Pages[0].AddLink({ rect: [24, 122, 40, 132], action: { type: 'uri', uri: 'https://example.org' } });
  d.Reorder([1, 1]);
  d.Pages[0].GetTables()[0].Remove();
  const [edited, other] = Document.Open(d.Save()).Pages;
  expect(edited.GetText()).toBe('keep');
  expect(edited.GetPaths().map(p => p.bbox)).toEqual([[24, 121, 28, 123]]);
  expect(edited.Annotations[0].Rect).toEqual([24, 122, 40, 132]);
  expect(new TextDecoder().decode(edited.Contents)).toContain('/G ID X EI');
  expect(other.GetTables()[0].rows[0].cells[0].text).toBe('left');
});

it('isolates a rotated Form occurrence on replacement and on a failed redraw', () => {
  const src = Document.Open(buildTablePdf(rotate(-18, 0, 38, grid)));
  const d = Document.New(), page = d.AddPage().page;
  page.StampWith(src.Pages[0], { rect: [0, 0, 300, 300] });
  const repeat = 'q 1 0 0 1 300 0 cm\n' + new TextDecoder().decode(page.Contents) + '\nQ';
  appendContent(d, page, new TextEncoder().encode(repeat));
  const handle = page.GetTables()[0], before = d.Save(), bad = replacement();
  bad.addRow(['too tall'], { minHeight: 150 });
  expect(() => handle.Replace(bad)).toThrow(/fit/i);
  expect(d.Save()).toEqual(before);
  const good = createTable({ background: [0.8, 0.8, 0.8], border: { color: [0, 0, 0], width: 1 } });
  good.addRow(['redrawn', 'cell']);
  handle.Replace(good);
  const saved = Document.Open(d.Save()), both = saved.Pages[0].GetTables();
  expect(both.map(t => t.rows[0].cells[0].text).sort()).toEqual(['left', 'redrawn']);
  both.find(t => t.rows[0].cells[0].text === 'redrawn')!.Remove();
  expect(saved.Pages[0].GetTables()[0].rows[0].cells[0].text).toBe('left');
});

it('rotates a replacement link hit area with its text', () => {
  const linked = createTable();
  linked.addRow([[{ text: 'link', link: 'https://example.org' }], 'value']);
  const plain = open();
  plain.Pages[0].GetTables()[0].Replace(linked);
  const [x, y, u, v] = plain.Pages[0].Annotations[0].Rect!;
  const d = Document.Open(buildTablePdf(rotate(90, 220, 18, grid)));
  d.Pages[0].GetTables()[0].Replace(linked);
  const link = Document.Open(d.Save()).Pages[0].Annotations[0];
  const expected = [220 - y, 18 + x, 220 - y, 18 + u, 220 - v, 18 + u, 220 - v, 18 + x];
  const quad = link.Dict.get('QuadPoints') as number[];
  expected.forEach((n, i) => expect(quad[i]).toBeCloseTo(n, 4));
  [220 - v, 18 + x, 220 - y, 18 + u].forEach((n, i) => expect(link.Rect![i]).toBeCloseTo(n, 4));
});

it('removes a rotated borderless table reconstructed from glyphs', () => {
  const rows = [200, 180, 160].map(y => text(50, y, 'left') + text(160, y, 'right')).join('');
  const d = Document.Open(buildTablePdf(rotate(35, 100, 0, rows)));
  const [table] = d.Pages[0].GetTables();
  expect(table.rowCount).toBe(3);
  table.Remove();
  expect(Document.Open(d.Save()).Pages[0].GetText()).toBe('');
});

it('rejects a crossing path or an oversized redraw on a rotated grid before publication', () => {
  for (const crossing of [true, false]) {
    const d = Document.Open(buildTablePdf(rotate(30, 100, 0, grid + (crossing ? '0 110 m 70 150 l S\n' : ''))));
    const t = d.Pages[0].GetTables()[0], before = d.Save(), builder = replacement();
    builder.addRow(['extra'], { minHeight: 100 });
    if (crossing) expect(() => t.Remove()).toThrow(UnsupportedFeatureError);
    else expect(() => t.Replace(builder)).toThrow(/fit/i);
    expect(d.Save()).toEqual(before);
  }
});

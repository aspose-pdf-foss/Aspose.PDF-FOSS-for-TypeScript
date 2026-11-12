import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { PageFormat } from '../src/pageformat.js';
import { createTable } from '../src/tableauthor.js';
import { buildOtFontFor, buildGsub, singleSubstDelta } from './helpers/build-sfnt.js';

function fontBytes() {
  return buildOtFontFor({ cmap: [[0x41, 5], [0x20, 3]],
    gsub: buildGsub([singleSubstDelta('onum', 5, 7)]) });
}

describe('feature-aware table measurement', () => {
  it('wraps using the selected advances and draws exactly those lines', () => {
    const doc = Document.New();
    const font = doc.AddFont(fontBytes(), { shape: true });
    const table = createTable({ font, fontSize: 10, leading: 12, padding: 0 });
    table.addRow().addCell([{ text: 'A A', features: { onum: true } }]);
    // Nominal 5+3+5 fits 20pt, selected 12+3+12 does not.
    expect(table.measure([20]).cellLines[0][0]).toEqual(['A', 'A']);
    expect(table.measure([20]).rowHeights).toEqual([24]);
    expect(font.usedGids.size).toBe(0);
    const page = doc.AddPage(PageFormat.A4).page;
    page.AddTable(table, 20, 200, { width: 20 });
    const body = new TextDecoder().decode(page.Contents);
    expect(body.match(/<000c> Tj/g)).toHaveLength(2);
    expect(Document.Open(doc.Save()).Pages[0].GetText().replace(/\s/g, '')).toBe('AA');
  });

  it('uses selected glyph widths for auto-fit without recording glyphs', () => {
    const doc = Document.New();
    const font = doc.AddFont(fontBytes(), { shape: true });
    const table = createTable({ font, fontSize: 10, padding: 0 });
    table.addRow([[{ text: 'A', features: { onum: true } }], [{ text: 'A' }]]);
    table.autoFitColumns();
    const widths = table.resolveColumnWidths(100);
    expect(widths[0]).toBeCloseTo(1200 / 17);
    expect(widths[1]).toBeCloseTo(500 / 17);
    expect(font.usedGids.size).toBe(0);
  });

  it('rejects invalid later maps during measurement and auto-fit', () => {
    const doc = Document.New();
    const font = doc.AddFont(fontBytes(), { shape: true });
    const table = createTable({ font });
    table.addRow([[{ text: 'A' }, { text: 'A', features: { nope: 2 as never } }]]);
    expect(() => table.measure([200])).toThrow(TypeError);
    table.autoFitColumns();
    expect(() => table.resolveColumnWidths(200)).toThrow(TypeError);
    expect(font.usedGids.size).toBe(0);
  });
});

describe('feature-aware Flow and TOC', () => {
  it('retains run feature selections after a page break', () => {
    const doc = Document.New();
    const font = doc.AddFont(fontBytes(), { shape: true });
    const flow = doc.NewFlow({ format: PageFormat.custom(60, 32),
      marginLeft: 20, marginRight: 20, marginTop: 10, marginBottom: 10 });
    flow.AddParagraph([{ text: 'A A', font, features: { onum: true } }],
      { fontSize: 10, leading: 12 });
    const pages = flow.Render();
    expect(pages).toHaveLength(2);
    for (const p of pages) expect(new TextDecoder().decode(p.Contents)).toContain('<000c> Tj');
  });

  it('uses feature selections for TOC labels and title wrapping', () => {
    const doc = Document.New();
    const font = doc.AddFont(fontBytes(), { shape: true });
    const page = doc.AddPage(PageFormat.A4).page;
    page.AddTOC([{ title: 'A', page: 1, label: 'A' }], [20, 20, 100, 100],
      { font, fontSize: 10, features: { onum: true }, leader: 'none' });
    const body = new TextDecoder().decode(page.Contents);
    expect(body.match(/<000c> Tj/g)).toHaveLength(2);
    // Right-aligned label's left edge = 20 + 100 - its selected 12pt advance.
    expect(body).toMatch(/1 0 0 1 108 [\d.-]+ Tm/);
  });
});

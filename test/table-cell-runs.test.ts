import { describe, it, expect } from 'vitest';
import { createTable } from '../src/tableauthor.js';
import type { TextRun } from '../src/textdecor.js';
import { Document } from '../src/document.js';
import { PageFormat } from '../src/pageformat.js';

describe('table cells holding runs', () => {
  it('measures a run cell the same as the equivalent string', () => {
    const asString = createTable({ fontSize: 12 });
    asString.addRow(['hello world']);
    const asRuns = createTable({ fontSize: 12 });
    asRuns.addRow().addCell([{ text: 'hello ' }, { text: 'world' }] as TextRun[]);
    expect(asRuns.measure([200]).rowHeights).toEqual(asString.measure([200]).rowHeights);
  });

  it('reports the wrapped line texts of a run cell', () => {
    const t = createTable({ fontSize: 12 });
    t.addRow().addCell([{ text: 'alpha ' }, { text: 'beta' }] as TextRun[]);
    expect(t.measure([200]).cellLines[0][0]).toEqual(['alpha beta']);
  });

  it('accounts for a larger run when computing the row height', () => {
    const small = createTable({ fontSize: 12 });
    small.addRow().addCell([{ text: 'x' }] as TextRun[]);
    const wrapped = createTable({ fontSize: 12 });
    // A long bold run in a narrow column must wrap to more lines.
    wrapped.addRow().addCell(
      [{ text: 'a rather long stretch of text ', font: 'Helvetica-Bold' as const },
       { text: 'and more still' }] as TextRun[]);
    expect(wrapped.measure([80]).rowHeights[0])
      .toBeGreaterThan(small.measure([80]).rowHeights[0]);
  });

  it('rejects a malformed run before measuring', () => {
    const t = createTable();
    t.addRow().addCell([{ text: 'ok' }, { text: 'bad', link: '' }] as TextRun[]);
    expect(() => t.measure([200])).toThrow(TypeError);
  });
});

describe('rendering a run cell', () => {
  const draw = (cell: TextRun[]) => {
    const doc = Document.New();
    const { page } = doc.AddPage(PageFormat.A4);
    const t = createTable({ fontSize: 12 });
    t.addRow().addCell(cell);
    page.AddTable(t, 50, 700, { width: 300 });
    return { doc, page };
  };

  it('draws the cell text', () => {
    const { page } = draw([{ text: 'hello ' }, { text: 'world' }]);
    expect(page.GetText()).toContain('hello world');
  });

  it("uses each run's own font", () => {
    const { page } = draw([
      { text: 'plain ' }, { text: 'bold', font: 'Helvetica-Bold' },
    ]);
    const names = new Set(page.GetTextFragments().map((f) => f.fontName));
    expect([...names].some((n) => n?.includes('Bold'))).toBe(true);
    expect([...names].some((n) => n && !n.includes('Bold'))).toBe(true);
  });

  it('places a /Link for a linked cell run', () => {
    const { page } = draw([
      { text: 'see ' }, { text: 'docs', link: 'https://example.com' },
    ]);
    const links = page.Annotations.filter((a) => a.Subtype === 'Link');
    expect(links.length).toBe(1);
    expect((links[0] as { Action?: { uri?: string } }).Action?.uri).toBe('https://example.com');
  });

  it('leaves a string cell free of marked content', () => {
    const a = Document.New();
    const pa = a.AddPage(PageFormat.A4).page;
    const ta = createTable({ fontSize: 12 });
    ta.addRow(['plain text']);
    pa.AddTable(ta, 50, 700, { width: 300 });
    // A string cell must not take the runs branch anywhere.
    expect(Buffer.from(a.Save()).toString('latin1')).not.toContain('BDC');
  });
});

describe('a cell holding an oversized run', () => {
  it('makes its row tall enough for the big glyphs', () => {
    const flat = createTable({ fontSize: 10, leading: 12 });
    flat.addRow().addCell([{ text: 'alpha beta' }] as TextRun[]);

    const tall = createTable({ fontSize: 10, leading: 12 });
    tall.addRow().addCell(
      [{ text: 'alpha ' }, { text: 'BETA', fontSize: 24 }] as TextRun[]);

    // A row sized by lineCount * leading would report these as equal, and the
    // 24pt glyphs would spill into whatever sits above the row.
    expect(tall.measure([300]).rowHeights[0])
      .toBeGreaterThan(flat.measure([300]).rowHeights[0]);
  });
});

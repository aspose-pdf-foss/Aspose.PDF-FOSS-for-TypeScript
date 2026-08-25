import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { createTable, extractTaggedTables } from '../src/index.js';
import { buildBlankPage } from './helpers/build-blank-page.js';
import { buildPngRgbWith } from './helpers/build-embed-images.js';
import { TableTagger, headerScope, validateTableTagging } from '../src/tabletag.js';

/** A 2x1 RGB PNG, the same fixture the other table tests use. */
const png2x1 = () => buildPngRgbWith(2, 1, [255, 0, 0, 0, 255, 0], 0);

describe('headerScope', () => {
  const cellWith = (header?: boolean | 'row' | 'column') =>
    createTable().addRow().addCell('x', header === undefined ? {} : { header });

  it('infers a column header inside the repeating-header rows', () => {
    expect(headerScope(cellWith(), 0, 1)).toBe('Column');
    expect(headerScope(cellWith(), 1, 1)).toBeUndefined();
    expect(headerScope(cellWith(), 0, 0)).toBeUndefined();
  });

  it('lets an explicit header win over the inference', () => {
    expect(headerScope(cellWith('row'), 5, 0)).toBe('Row');
    expect(headerScope(cellWith('column'), 5, 0)).toBe('Column');
    expect(headerScope(cellWith(true), 5, 0)).toBe('Column');
  });

  it('lets header:false opt a cell out of the inference', () => {
    expect(headerScope(cellWith(false), 0, 1)).toBeUndefined();
  });
});

describe('validateTableTagging', () => {
  const doc = () => Document.Open(buildBlankPage());

  it('accepts an absent or boolean tagged', () => {
    expect(() => validateTableTagging(doc(), {})).not.toThrow();
    expect(() => validateTableTagging(doc(), { tagged: true })).not.toThrow();
  });

  it('rejects a non-boolean tagged', () => {
    expect(() => validateTableTagging(doc(), { tagged: 'yes' as never })).toThrow(TypeError);
  });
});

describe('TableTagger', () => {
  const doc = () => Document.Open(buildBlankPage());

  it('appends a /Table under the structure tree root', () => {
    const d = doc();
    const tagger = new TableTagger(d);
    expect(tagger.table.Type).toBe('Table');
    expect(d.GetStructTree()!.Children.map((c) => c.Type)).toEqual(['Table']);
  });

  it('builds /TR > /TD in call order', () => {
    const d = doc();
    const t = createTable();
    const r0 = t.addRow(['a', 'b']);
    const tagger = new TableTagger(d);
    tagger.beginRow();
    tagger.cell(r0.cells[0], 0, 0);
    tagger.cell(r0.cells[1], 0, 0);
    const rows = tagger.table.Children;
    expect(rows.map((r) => r.Type)).toEqual(['TR']);
    expect(rows[0].Children.map((c) => c.Type)).toEqual(['TD', 'TD']);
  });

  it('emits /TH with a /Scope for a header cell', () => {
    const d = doc();
    const t = createTable();
    const row = t.addRow();
    row.addCell('H');
    row.addCell('R', { header: 'row' });
    t.setRepeatingRowsCount(1);
    const tagger = new TableTagger(d);
    tagger.beginRow();
    const a = tagger.cell(row.cells[0], 0, 1);
    const b = tagger.cell(row.cells[1], 0, 1);
    expect(a.Type).toBe('TH');
    expect(a.TableAttributes!.scope).toBe('Column');
    expect(b.Type).toBe('TH');
    expect(b.TableAttributes!.scope).toBe('Row');
  });

  it('writes ColSpan only for a spanning cell', () => {
    const d = doc();
    const row = createTable().addRow();
    row.addCell('wide', { colSpan: 3 });
    row.addCell('narrow');
    const tagger = new TableTagger(d);
    tagger.beginRow();
    const wide = tagger.cell(row.cells[0], 0, 0);
    const narrow = tagger.cell(row.cells[1], 0, 0);
    expect(wide.TableAttributes!.colSpan).toBe(3);
    // readTable defaults an absent ColSpan to 1, so assert on the raw dict:
    // a plain cell must carry no /A at all.
    expect(narrow.Dict.has('A')).toBe(false);
  });

  it('writes RowSpan only for a spanning cell', () => {
    const d = doc();
    const row = createTable().addRow();
    row.addCell('tall', { rowSpan: 2 });
    row.addCell('plain');
    const tagger = new TableTagger(d);
    tagger.beginRow();
    const tall = tagger.cell(row.cells[0], 0, 0, 2);
    const plain = tagger.cell(row.cells[1], 0, 0, 1);
    expect(tall.TableAttributes!.rowSpan).toBe(2);
    // readTable defaults an absent RowSpan to 1, so assert on the raw dict:
    // a plain cell must carry no /A at all.
    expect(plain.Dict.has('A')).toBe(false);
  });

  it('states the span it is GIVEN, not the one the cell declared', () => {
    // The clamped value arrives from the placement. This is the one place the
    // two differ observably, and it is why the clamp lives in the grid rather
    // than at paint time.
    const d = doc();
    const row = createTable().addRow();
    row.addCell('tall', { rowSpan: 9 });
    const tagger = new TableTagger(d);
    tagger.beginRow();
    expect(tagger.cell(row.cells[0], 0, 0, 2).TableAttributes!.rowSpan).toBe(2);
  });

  it('appends a /Figure to a cell, carrying /Alt when given', () => {
    const d = doc();
    const row = createTable().addRow();
    row.addCell('x');
    const tagger = new TableTagger(d);
    tagger.beginRow();
    const cell = tagger.cell(row.cells[0], 0, 0);
    const fig = tagger.figure(cell, 'a chart');
    expect(fig.Type).toBe('Figure');
    expect(cell.Children.map((c) => c.Type)).toEqual(['Figure']);
    expect(fig.Alt).toBe('a chart');
  });

  it('throws when a cell is added before a row is opened', () => {
    const row = createTable().addRow(['a']);
    const tagger = new TableTagger(doc());
    expect(() => tagger.cell(row.cells[0], 0, 0)).toThrow();
  });
});

describe('page.AddTable({ tagged: true })', () => {
  const taggedTable = () => {
    const doc = Document.Open(buildBlankPage());
    const t = createTable({ font: 'Helvetica', fontSize: 10, leading: 12 });
    t.addRow(['Name', 'Qty']);
    t.addRow(['Bolt', '12']);
    t.setRepeatingRowsCount(1);
    const res = doc.Pages[0].AddTable(t, 72, 720, { width: 300, tagged: true });
    return { doc, res };
  };

  it('returns the /Table element and builds one /TR per row', () => {
    const { doc, res } = taggedTable();
    expect(res.struct!.Type).toBe('Table');
    expect(doc.GetStructTree()!.Children.map((c) => c.Type)).toEqual(['Table']);
    expect(res.struct!.Children.map((r) => r.Type)).toEqual(['TR', 'TR']);
  });

  it('emits /TH for the repeating-header row and /TD below it', () => {
    const { res } = taggedTable();
    const [head, body] = res.struct!.Children;
    expect(head.Children.map((c) => c.Type)).toEqual(['TH', 'TH']);
    expect(head.Children[0].TableAttributes!.scope).toBe('Column');
    expect(body.Children.map((c) => c.Type)).toEqual(['TD', 'TD']);
  });

  it('tags each cell text into its own cell element', () => {
    const { res } = taggedTable();
    const [head, body] = res.struct!.Children;
    expect(head.Children[0].GetText()).toContain('Name');
    expect(head.Children[1].GetText()).toContain('Qty');
    expect(body.Children[0].GetText()).toContain('Bolt');
    expect(body.Children[1].GetText()).toContain('12');
  });

  it('writes ColSpan for a spanning cell', () => {
    const doc = Document.Open(buildBlankPage());
    const t = createTable({ font: 'Helvetica', fontSize: 10, leading: 12 });
    t.addRow().addCell('Summary', { colSpan: 2 });
    t.addRow(['L', 'R']);
    const res = doc.Pages[0].AddTable(t, 72, 720, { width: 300, tagged: true });
    expect(res.struct!.Children[0].Children[0].TableAttributes!.colSpan).toBe(2);
  });

  it('marks cell backgrounds and borders as artifacts', () => {
    const doc = Document.Open(buildBlankPage());
    const t = createTable({
      font: 'Helvetica', fontSize: 10, leading: 12,
      background: [0.9, 0.9, 0.9],
      border: { width: 0.5, color: [0, 0, 0] },
      outerBorder: { width: 1, color: [0, 0, 0] },
    });
    t.addRow(['a', 'b']);
    doc.Pages[0].AddTable(t, 72, 720, { width: 300, tagged: true });
    const text = new TextDecoder().decode(doc.Pages[0].Contents);
    // Two artifact sequences: the background pass and the border pass.
    expect(text.split('/Artifact BMC').length - 1).toBe(2);
  });

  it('opens no artifact sequence for a pass that draws nothing', () => {
    // No background and no border anywhere: an unconditional BeginArtifact
    // would emit a bare /Artifact BMC EMC with no content between.
    const doc = Document.Open(buildBlankPage());
    const t = createTable({ font: 'Helvetica', fontSize: 10, leading: 12 });
    t.addRow(['a', 'b']);
    doc.Pages[0].AddTable(t, 72, 720, { width: 300, tagged: true });
    expect(new TextDecoder().decode(doc.Pages[0].Contents)).not.toContain('/Artifact BMC');
  });

  it('gives a cell image a /Figure under its cell, before the text', () => {
    const doc = Document.Open(buildBlankPage());
    const t = createTable({ font: 'Helvetica', fontSize: 10, leading: 12 });
    t.addRow().addCell('caption').setImage(png2x1(), { height: 20, alt: 'a red square' });
    const res = doc.Pages[0].AddTable(t, 72, 720, { width: 300, tagged: true });
    const cell = res.struct!.Children[0].Children[0];
    expect(cell.Children.map((c) => c.Type)).toEqual(['Figure']);
    // /K = [Figure, textMcid]: the figure is appended at cell-creation time, so
    // it precedes the text MCID in reading order as well as in paint order.
    const kids = cell.Dict.get('K') as unknown[];
    expect(kids.length).toBe(2);
  });

  it('artifacts a decorative cell image instead of giving it a /Figure', () => {
    const doc = Document.Open(buildBlankPage());
    const t = createTable({ font: 'Helvetica', fontSize: 10, leading: 12 });
    t.addRow().addCell('caption').setImage(png2x1(), { height: 20, artifact: true });
    const res = doc.Pages[0].AddTable(t, 72, 720, { width: 300, tagged: true });
    expect(res.struct!.Children[0].Children[0].Children).toEqual([]);
    expect(new TextDecoder().decode(doc.Pages[0].Contents)).toContain('/Artifact BMC');
  });

  it('builds no structure tree when a tagged call draws nothing', () => {
    const doc = Document.Open(buildBlankPage());
    const res = doc.Pages[0].AddTable(createTable(), 72, 720, { width: 300, tagged: true });
    expect(res.struct).toBeUndefined();
    expect(doc.GetStructTree()).toBeNull();
  });

  it('rejects a non-boolean tagged before painting anything', () => {
    const doc = Document.Open(buildBlankPage());
    const t = createTable({ font: 'Helvetica', fontSize: 10, leading: 12 });
    t.addRow(['a', 'b']);
    const before = doc.Pages[0].Contents.length;
    expect(() => doc.Pages[0].AddTable(t, 72, 720, { width: 300, tagged: 'yes' as never }))
      .toThrow(TypeError);
    expect(doc.Pages[0].Contents.length).toBe(before);
    expect(doc.GetStructTree()).toBeNull();
  });
});

describe('a tagged table continued across pages', () => {
  /** Enough rows that the table must break under a tall bottom margin. */
  const tallTable = () => {
    const t = createTable({ font: 'Helvetica', fontSize: 10, leading: 12 });
    t.addRow(['Name', 'Qty']);
    for (let i = 0; i < 40; i++) t.addRow([`item ${i}`, String(i)]);
    t.setRepeatingRowsCount(1);
    return t;
  };

  it('auto-pagination produces one /Table with the header repeated as a /TR', () => {
    const doc = Document.Open(buildBlankPage());
    const res = doc.Pages[0].AddTable(tallTable(), 72, 760, {
      width: 300, tagged: true, autoPaginate: true, bottomMargin: 600,
    });
    expect(res.pages.length).toBeGreaterThan(1);
    expect(doc.GetStructTree()!.Children.map((c) => c.Type)).toEqual(['Table']);

    const rows = res.struct!.Children;
    // 41 authored rows + one reprinted header per continuation page.
    expect(rows.length).toBe(41 + (res.pages.length - 1));
    // Every reprint is a real /TR of /TH cells, in draw order.
    const headerRows = rows.filter((r) => r.Children.every((c) => c.Type === 'TH'));
    expect(headerRows.length).toBe(res.pages.length);
  });

  it('binds each row to the page it was actually drawn on', () => {
    const doc = Document.Open(buildBlankPage());
    const res = doc.Pages[0].AddTable(tallTable(), 72, 760, {
      width: 300, tagged: true, autoPaginate: true, bottomMargin: 600,
    });
    const rows = res.struct!.Children;
    const firstCellPage = (r: (typeof rows)[number]) => r.Children[0].Page?.Number;
    expect(firstCellPage(rows[0])).toBe(res.pages[0].Number);
    expect(firstCellPage(rows[rows.length - 1])).toBe(res.pages[res.pages.length - 1].Number);
  });

  it('manual pagination stays one /Table when struct is passed back', () => {
    const doc = Document.Open(buildBlankPage());
    const first = doc.Pages[0].AddTable(tallTable(), 72, 760, {
      width: 300, tagged: true, bottomMargin: 600,
    });
    expect(first.remainder).toBeDefined();

    const page2 = doc.AddPage().page;
    const second = page2.AddTable(first.remainder!, 72, 760, {
      width: 300, tagged: true, structParent: first.struct,
    });
    expect(second.struct!.Dict).toBe(first.struct!.Dict);   // reused, not nested
    expect(doc.GetStructTree()!.Children.map((c) => c.Type)).toEqual(['Table']);
  });

  it('nests the /Table under a non-/Table structParent', () => {
    const doc = Document.Open(buildBlankPage());
    const sect = doc.CreateStructTree().Append('Sect');
    const t = createTable({ font: 'Helvetica', fontSize: 10, leading: 12 });
    t.addRow(['a', 'b']);
    const res = doc.Pages[0].AddTable(t, 72, 720, { width: 300, tagged: true, structParent: sect });
    expect(sect.Children.map((c) => c.Type)).toEqual(['Table']);
    expect(res.struct!.Dict).toBe(sect.Children[0].Dict);
    expect(doc.GetStructTree()!.Children.map((c) => c.Type)).toEqual(['Sect']);
  });

  it('rejects structParent without tagged, and a foreign structParent', () => {
    const doc = Document.Open(buildBlankPage());
    const t = createTable({ font: 'Helvetica', fontSize: 10, leading: 12 });
    t.addRow(['a', 'b']);
    const sect = doc.CreateStructTree().Append('Sect');

    expect(() => doc.Pages[0].AddTable(t, 72, 720, { width: 300, structParent: sect }))
      .toThrow(TypeError);

    const other = Document.Open(buildBlankPage());
    const foreign = other.CreateStructTree().Append('Sect');
    const before = doc.Pages[0].Contents.length;
    expect(() => doc.Pages[0].AddTable(t, 72, 720, { width: 300, tagged: true, structParent: foreign }))
      .toThrow(TypeError);
    expect(doc.Pages[0].Contents.length).toBe(before);
  });
});

describe('the UntaggedContent guarantee', () => {
  const fires = (doc: Document) =>
    doc.ValidatePdfUa().Issues.some((i) => i.rule === 'UntaggedContent');

  const styledTable = () => {
    const t = createTable({
      font: 'Helvetica', fontSize: 10, leading: 12,
      background: [0.9, 0.9, 0.9],
      border: { width: 0.5, color: [0, 0, 0] },
      outerBorder: { width: 1, color: [0, 0, 0] },
    });
    t.addRow(['Name', 'Qty']);
    t.addRow(['Bolt', '12']);
    t.setRepeatingRowsCount(1);
    return t;
  };

  it('fires for a table drawn untagged into a tagged document', () => {
    const doc = Document.Open(buildBlankPage());
    doc.CreateStructTree();                       // the document is tagged
    doc.Pages[0].AddTable(styledTable(), 72, 720, { width: 300 });
    expect(fires(doc)).toBe(true);                // the bug 7efj is about
  });

  it('stays silent for the same table drawn tagged', () => {
    const doc = Document.Open(buildBlankPage());
    doc.Pages[0].AddTable(styledTable(), 72, 720, { width: 300, tagged: true });
    expect(fires(doc)).toBe(false);
  });
});

describe('untagged output is unchanged', () => {
  const build = (tagged: boolean) => {
    const doc = Document.Open(buildBlankPage());
    const t = createTable({
      font: 'Helvetica', fontSize: 10, leading: 12,
      background: [0.9, 0.9, 0.9],
      border: { width: 0.5, color: [0, 0, 0] },
    });
    t.addRow(['Name', 'Qty']);
    t.addRow(['Bolt', '12']);
    doc.Pages[0].AddTable(t, 72, 720, tagged ? { width: 300, tagged: true } : { width: 300 });
    return doc;
  };

  it('draws byte-identical content with tagged absent and tagged: false', () => {
    const absent = Document.Open(buildBlankPage());
    const explicit = Document.Open(buildBlankPage());
    for (const [doc, opts] of [
      [absent, { width: 300 }],
      [explicit, { width: 300, tagged: false }],
    ] as const) {
      const t = createTable({ font: 'Helvetica', fontSize: 10, leading: 12 });
      t.addRow(['Name', 'Qty']);
      doc.Pages[0].AddTable(t, 72, 720, opts);
    }
    expect(explicit.Pages[0].Contents).toEqual(absent.Pages[0].Contents);
  });

  it('adds only marked-content operators when tagged', () => {
    const plain = new TextDecoder().decode(build(false).Pages[0].Contents);
    const tagged = new TextDecoder().decode(build(true).Pages[0].Contents);
    expect(plain).not.toContain('BDC');
    expect(plain).not.toContain('BMC');
    // Strip the marking and the two streams must agree operator for operator.
    const strip = (s: string) => s
      .split('\n')
      .filter((l) => !/(BDC|BMC|EMC)\s*$/.test(l.trim()))
      .join('\n');
    expect(strip(tagged)).toBe(plain);
  });
});

describe('the authored tree reads back through the extraction stack', () => {
  it('extractTaggedTables recovers the rows, columns and header flags', () => {
    const doc = Document.Open(buildBlankPage());
    const t = createTable({ font: 'Helvetica', fontSize: 10, leading: 12 });
    t.addRow(['Name', 'Qty']);
    t.addRow(['Bolt', '12']);
    t.setRepeatingRowsCount(1);
    doc.Pages[0].AddTable(t, 72, 720, { width: 300, tagged: true });

    const [table] = extractTaggedTables(doc, doc.Pages[0]);
    expect(table.rowCount).toBe(2);
    expect(table.colCount).toBe(2);
    expect(table.rows[0].cells[0].isHeader).toBe(true);
    expect(table.rows[0].cells[0].scope).toBe('Column');
    expect(table.rows[1].cells[0].isHeader).toBeUndefined();
    expect(table.rows[1].cells[0].text).toContain('Bolt');
  });
});

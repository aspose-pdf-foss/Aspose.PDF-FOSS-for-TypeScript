import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { PageFormat } from '../src/pageformat.js';
import { createTable } from '../src/tableauthor.js';
import type { StructElement } from '../src/struct.js';

const build = (rows: number) => {
  const t = createTable({ fontSize: 10, border: { width: 0.5, color: [0, 0, 0] } });
  t.addRow(['head A', 'head B']);
  for (let i = 0; i < rows; i++) t.addRow([`a${i}`, `b${i}`]);
  t.setRepeatingRowsCount(1);
  return t;
};

const collect = (doc: Document, type: string): StructElement[] => {
  const out: StructElement[] = [];
  const walk = (e: StructElement): void => {
    if (e.Type === type) out.push(e);
    for (const k of e.Children) walk(k);
  };
  for (const k of doc.GetStructTree()!.Children) walk(k);
  return out;
};

describe('Flow.AddTable', () => {
  it('draws a short table in the flow', () => {
    const doc = Document.New();
    const flow = doc.NewFlow({ format: PageFormat.A4 });
    flow.AddParagraph('before');
    flow.AddTable(build(3));
    flow.AddParagraph('after');
    const text = flow.Render()[0].GetText();
    expect(text).toContain('before');
    expect(text).toContain('head A');
    expect(text).toContain('a2');
    expect(text).toContain('after');
  });

  it('splits across pages and repeats the header', () => {
    const doc = Document.New();
    const flow = doc.NewFlow({ format: PageFormat.A4 });
    flow.AddTable(build(200));
    const pages = flow.Render();
    expect(pages.length).toBeGreaterThan(1);
    // Every page carrying table rows carries the header too.
    for (const p of pages) {
      const t = p.GetText();
      if (/\ba\d+\b/.test(t)) expect(t).toContain('head A');
    }
  });

  it('splits across columns', () => {
    const doc = Document.New();
    const flow = doc.NewFlow({ format: PageFormat.A4, columns: 2 });
    flow.AddTable(build(120));
    const pages = flow.Render();
    expect(pages[0].GetText()).toContain('head A');
    expect(pages.length).toBeGreaterThanOrEqual(1);
  });

  it('emits one /Table for a table split across pages', () => {
    const doc = Document.New();
    const flow = doc.NewFlow({ format: PageFormat.A4, tagged: true });
    flow.AddTable(build(200));
    const pages = flow.Render();
    expect(pages.length).toBeGreaterThan(1);
    expect(collect(doc, 'Table').length).toBe(1);
    expect(collect(doc, 'TH').length).toBeGreaterThan(0);
    expect(collect(doc, 'TD').length).toBeGreaterThan(0);
  });

  it('honours spaceBefore and spaceAfter', () => {
    const doc = Document.New();
    const flow = doc.NewFlow({ format: PageFormat.A4 });
    flow.AddTable(build(1), { spaceBefore: 40, spaceAfter: 40 });
    flow.AddParagraph('after');
    const frags = flow.Render()[0].GetTextFragments();
    const head = frags.find((f) => f.text.includes('head A'))!;
    const after = frags.find((f) => f.text.includes('after'))!;
    expect(head.quad[1] - after.quad[1]).toBeGreaterThan(60);
  });

  it('rejects a bad option before drawing', () => {
    const doc = Document.New();
    const flow = doc.NewFlow({ format: PageFormat.A4 });
    expect(() => flow.AddTable(build(1), { spaceBefore: -1 })).toThrow(TypeError);
    expect(() => flow.AddTable(build(1), { width: 0 })).toThrow(TypeError);
  });
});

describe('Flow.AddTable with a rowSpan', () => {
  /** 60 rows of exactly 12pt. Column 0 always carries the label `r{i}`, so a
   *  row is findable in the rendered text whether or not its column-1 cell is
   *  inherited from the span above. */
  const rowsWithSpan = (spanAt?: number) => {
    const t = createTable({ font: 'Helvetica', fontSize: 10, leading: 12, padding: 0 });
    const covered = spanAt === undefined ? -1 : spanAt + 1;
    for (let i = 0; i < 60; i++) {
      const row = t.addRow();
      row.addCell(`r${i}`);
      if (i === spanAt) row.addCell('joined', { rowSpan: 2 });
      else if (i !== covered) row.addCell('x');
    }
    return t;
  };

  /** Render one table into a single-column flow on a 400x500 page with 50pt
   *  margins — a 400pt tall column. */
  const render = (t: ReturnType<typeof rowsWithSpan>) => {
    const doc = Document.New();
    const flow = doc.NewFlow({
      format: PageFormat.custom(400, 500),
      marginLeft: 50, marginRight: 50, marginTop: 50, marginBottom: 50,
    });
    flow.AddTable(t);
    return flow.Render();
  };

  /** The row labels present on `page`, as whole tokens. Token equality rather
   *  than a substring test: `r1` is a prefix of `r10`. */
  const labels = (page: { GetText(): string }): Set<string> =>
    new Set(page.GetText().split(/[\s\n]+/));

  /** The index of the first row NOT on page 1. */
  const firstOverflowRow = (pages: ReturnType<typeof render>): number => {
    const seen = labels(pages[0]);
    for (let i = 0; i < 60; i++) if (!seen.has(`r${i}`)) return i;
    return 60;
  };

  it('splits a spanless table at some row (calibration)', () => {
    const k = firstOverflowRow(render(rowsWithSpan()));
    expect(k).toBeGreaterThan(1);
    expect(k).toBeLessThan(60);
  });

  it('does not cut a rowSpan group across a column break', () => {
    // Put the span across (k-1, k): the natural cut at k is then unsafe, and
    // the element must back off to k-1. Row heights are identical between the
    // two tables, so k is the same for both.
    const k = firstOverflowRow(render(rowsWithSpan()));
    const pages = render(rowsWithSpan(k - 1));
    // Asserting merely that two pages exist is satisfied with the back-off
    // removed: assert WHICH row opened the second page.
    expect(firstOverflowRow(pages)).toBe(k - 1);
    expect(labels(pages[1]).has(`r${k - 1}`)).toBe(true);
  });
});

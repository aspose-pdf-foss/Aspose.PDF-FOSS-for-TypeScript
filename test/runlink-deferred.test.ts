// test/runlink-deferred.test.ts
import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { createTable } from '../src/tableauthor.js';
import type { DeferredLink } from '../src/runlink.js';
import type { StructElement } from '../src/struct.js';

function deferred() {
  const got: Array<{ page: number; rect: [number, number, number, number]; elem?: StructElement }> = [];
  const link: DeferredLink = {
    deferred: true,
    onBox: (page, rect, elem) => { got.push({ page: page.Number, rect, ...(elem ? { elem } : {}) }); },
  };
  return { link: link as unknown as string, got };
}

describe('deferred run links', () => {
  it('report their box and make no annotation (untagged)', () => {
    const doc = Document.New();
    const page = doc.AddPage().page;
    const { link, got } = deferred();
    page.AddTextBlock([{ text: 'see ' }, { text: 'HERE', link }, { text: ' now' }], [72, 600, 300, 100], { fontSize: 12 });
    expect(page.Annotations).toHaveLength(0);
    expect(got).toHaveLength(1);
    expect(got[0].page).toBe(page.Number);
    expect(got[0].elem).toBeUndefined();
    const [x0, y0, x1, y1] = got[0].rect;
    expect(x0).toBeCloseTo(72 + page.MeasureText('see ', 12), 1);
    expect(x1 - x0).toBeCloseTo(page.MeasureText('HERE', 12), 1);
    expect(y1).toBeGreaterThan(y0);
  });

  it('a tagged block gives the run a /Link element holding its glyphs', () => {
    const doc = Document.New();
    const page = doc.AddPage().page;
    const p = doc.CreateStructTree().Append('P');
    const { link, got } = deferred();
    page.AddTextBlock([{ text: 'see ' }, { text: 'HERE', link }], [72, 600, 300, 100], { fontSize: 12, tag: p });
    expect(page.Annotations).toHaveLength(0);
    expect(got).toHaveLength(1);
    const el = got[0].elem!;
    expect(el.Type).toBe('Link');
    expect(el.Parent!.Dict).toBe(p.Dict);
    expect(el.GetText()).toContain('HERE');
  });

  it('a URI link beside it still makes its annotation', () => {
    const doc = Document.New();
    const page = doc.AddPage().page;
    const { link, got } = deferred();
    page.AddTextBlock([{ text: 'web', link: 'https://example.com/' }, { text: ' and ' }, { text: 'mark', link }], [72, 600, 300, 100]);
    expect(page.Annotations).toHaveLength(1);
    expect(got).toHaveLength(1);
  });

  it('a table cell accepts a deferred link', () => {
    const { link, got } = deferred();
    const t = createTable();
    t.addRow().addCell([{ text: 'cell ' }, { text: 'M', link }]);
    const flow = Document.New().NewFlow();
    flow.AddTable(t);
    flow.Render();
    expect(got).toHaveLength(1);
  });
});

import { describe, it, expect } from 'vitest';
import { tableColumnWidths, type LayoutNode, type XfaMeasure } from '../src/xfaflow.js';
import { layoutHooks, memoMeasure } from '../src/xfapage.js';

const fld = (label: string, w: number, h: number): LayoutNode =>
  ({ kind: 'field', label, field: label, geom: { w: `${String(w)}pt`, h: `${String(h)}pt` }, children: [] });
const drw = (label: string, w: number, h: number): LayoutNode =>
  ({ kind: 'draw', label, geom: { w: `${String(w)}pt`, h: `${String(h)}pt` }, children: [] });
const row = (label: string, cells: LayoutNode[]): LayoutNode =>
  ({ kind: 'subform', label, layout: 'row', geom: {}, children: cells });
const table = (label: string, cols: string, rows: LayoutNode[]): LayoutNode =>
  ({ kind: 'subform', label, layout: 'table', columnWidths: cols, geom: {}, children: rows });

describe('tableColumnWidths (164g.12, rule 4)', () => {
  it('resolves -1 columns from every row and keeps stated ones', () => {
    const t = table('T', '-1 30pt', [row('r1', [fld('c1', 40, 10), fld('c2', 10, 10)]), row('r2', [fld('c3', 80, 10), fld('c4', 10, 10)])]);
    expect(tableColumnWidths(t)).toEqual([80, 30]);
  });
  it('names why a -1 column cannot be sized', () => {
    // A leaf stating no width is the one cell a -1 column cannot be sized by.
    const t = table('T', '-1', [row('r1', [{ kind: 'field', label: 'u', field: 'u', geom: { h: '10pt' }, children: [] }])]);
    const w = tableColumnWidths(t);
    expect('reason' in w ? w.reason : '').toMatch(/column 1 has width -1 and no single-column cell/);
  });
});

describe('layoutHooks (164g.12)', () => {
  it('topOf: an lr-tb item on the second line sits below the first line', () => {
    const items = ['d1', 'd2', 'd3', 'd4'].map((n, i) => drw(n, 100, i === 1 ? 40 : 30));
    const flow: LayoutNode = { kind: 'subform', label: 'L', layout: 'lr-tb', geom: { w: '300pt' }, children: items,
      margin: { topInset: '5pt' } };
    expect(layoutHooks().topOf!(flow, items[3])).toBe(45);
    expect(layoutHooks().topOf!(flow, items[0])).toBe(5);
  });
  it('topOf: undefined for a node not under the root', () => {
    const flow: LayoutNode = { kind: 'subform', label: 'L', layout: 'lr-tb', geom: { w: '300pt' }, children: [drw('a', 10, 10)] };
    expect(layoutHooks().topOf!(flow, drw('b', 10, 10))).toBeUndefined();
  });
  it('columns: the same answer as tableColumnWidths', () => {
    const t = table('T', '-1', [row('r1', [fld('c1', 40, 10)]), row('r2', [fld('c2', 70, 10)])]);
    expect(layoutHooks().columns!(t)).toEqual([70]);
  });
});

describe('memoMeasure', () => {
  it('measures a node once per box', () => {
    let calls = 0;
    const m: XfaMeasure = () => { calls += 1; return { w: 1, h: 2 }; };
    const mm = memoMeasure(m);
    const n = drw('a', 1, 1);
    mm(n, { width: 10 }); mm(n, { width: 10 }); mm(n, { width: 20 });
    expect(calls).toBe(2);
  });
});

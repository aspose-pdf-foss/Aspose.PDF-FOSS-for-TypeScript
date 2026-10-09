// test/xfaflow-table-measure.test.ts
import { describe, it, expect } from 'vitest';
import { layoutPage, type LayoutNode, type Placed, type XfaMeasure } from '../src/xfaflow.js';
import type { XfaRawGeom } from '../src/xfageom.js';

const fld = (label: string, geom: XfaRawGeom, extra: Partial<LayoutNode> = {}): LayoutNode =>
  ({ kind: 'field', label, field: label, geom, children: [], ...extra });
const sub = (label: string, layout: string, geom: XfaRawGeom, children: LayoutNode[], extra: Partial<LayoutNode> = {}): LayoutNode =>
  ({ kind: 'subform', label, layout, geom, children, ...extra });
const row = (label: string, cells: LayoutNode[]) => sub(label, 'row', {}, cells);
const table = (cols: string | undefined, rows: LayoutNode[]) =>
  sub('T', 'table', {}, rows, cols === undefined ? {} : { columnWidths: cols });
const page = (children: LayoutNode[]): LayoutNode =>
  ({ kind: 'page', label: 'contentArea', layout: 'position', geom: { h: '10000pt' }, children });
const box = (m: Map<string, Placed>, n: string) => {
  const p = m.get(n);
  if (!p || 'reason' in p) throw new Error(`${n}: ${p && 'reason' in p ? p.reason : 'none'}`);
  return p.box;
};
const why = (m: Map<string, Placed>, n: string) => {
  const p = m.get(n);
  if (!p || 'box' in p) throw new Error(`${n}: placed`);
  return p.reason;
};
/** 5pt a character, 10pt a line. */
const text = (n: number): XfaMeasure => (_node, b) => {
  const lineW = 'width' in b ? b.width : b.maxWidth ?? Infinity;
  const per = Math.max(1, Math.floor(lineW / 5));
  return { w: 'width' in b ? b.width : Math.min(n, per) * 5, h: Math.ceil(n / Math.min(per, n)) * 10 };
};

describe('tables: p. 329, a stated column width is the cell box', () => {
  it('narrows a stated-size leaf to its column, with or without a measurer', () => {
    const m = layoutPage(page([table('20pt', [row('r', [fld('a', { w: '30pt', h: '10pt' })])])]));
    expect(box(m, 'a')).toEqual({ x: 0, y: 0, w: 20, h: 10 });
  });

  it('narrows a positioned subform cell, keeping its children at their offsets', () => {
    const m = layoutPage(page([table('20pt', [row('r', [
      sub('C', 'position', { w: '30pt', h: '10pt' }, [fld('a', { x: '2pt', y: '1pt', w: '5pt', h: '5pt' })]),
    ])])]));
    expect(box(m, 'a')).toEqual({ x: 2, y: 1, w: 5, h: 5 });
  });

  // A tb or a nested table keeps its children's own sizes in any box, so it
  // narrows like a leaf and draws past the cell (p. 329). OPM 1644's
  // Table2SecII is 0.003pt wider than its cell by mm rounding alone.
  it('narrows a tb container or a nested table, keeping its children as laid out', () => {
    const tb = layoutPage(page([table('20pt', [row('r', [
      sub('C', 'tb', { w: '30pt' }, [fld('a', { w: '30pt', h: '10pt' })]),
    ])])]));
    expect(box(tb, 'a')).toEqual({ x: 0, y: 0, w: 30, h: 10 });
    const nested = layoutPage(page([table('20pt', [row('r', [
      sub('N', 'table', {}, [row('nr', [fld('b', { h: '10pt' })])], { columnWidths: '20.01pt' }),
    ])])]));
    expect(box(nested, 'b')).toEqual({ x: 0, y: 0, w: 20.01, h: 10 });
  });

  // Only a width-growable lr-tb's layout depends on the width it is given.
  it('still refuses a one-line lr-tb wider than its column, which would re-wrap', () => {
    const m = layoutPage(page([table('20pt', [row('r', [
      sub('C', 'lr-tb', {}, [fld('a', { w: '15pt', h: '10pt' }), fld('b', { w: '15pt', h: '10pt' })]),
    ])])]));
    expect(why(m, 'a')).toMatch(/one line wider than its column/);
  });
});

describe('tables: measured cells', () => {
  it('measures a height-growable cell at its column width, then sizes the row', () => {
    const m = layoutPage(page([table('20pt 30pt', [row('r', [
      fld('a', {}), fld('b', { w: '30pt', h: '5pt' }),
    ])])]), text(10));
    // 10 chars at 5pt in a 20pt column: 4 a line, 3 lines.
    expect(box(m, 'a')).toEqual({ x: 0, y: 0, w: 20, h: 30 });
    expect(box(m, 'b')).toEqual({ x: 20, y: 0, w: 30, h: 30 });
  });

  it('re-measures a narrowed text leaf at its column width', () => {
    const m = layoutPage(page([table('20pt', [row('r', [fld('a', { w: '40pt' })])])]), text(8));
    expect(box(m, 'a')).toEqual({ x: 0, y: 0, w: 20, h: 20 });
  });

  // Review Focus 5.
  it('sizes a -1 column from a measured cell width, and still refuses without a measurer', () => {
    const t = page([table('-1', [row('r', [fld('a', { h: '10pt' })])])]);
    expect(box(layoutPage(t, text(3)), 'a')).toEqual({ x: 0, y: 0, w: 15, h: 10 });
    expect(why(layoutPage(t), 'a')).toMatch(/column 1 has width -1/);
  });

  it('applies minH to a measured cell', () => {
    const m = layoutPage(page([table('20pt', [row('r', [fld('a', {}, { minMax: { minH: '25pt' } })])])]), text(2));
    expect(box(m, 'a').h).toBe(25);
  });
});

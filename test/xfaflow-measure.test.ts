// test/xfaflow-measure.test.ts
import { describe, it, expect } from 'vitest';
import { layoutPage, type LayoutNode, type Placed, type XfaMeasure } from '../src/xfaflow.js';
import type { XfaRawGeom } from '../src/xfageom.js';

const fld = (label: string, geom: XfaRawGeom, extra: Partial<LayoutNode> = {}): LayoutNode =>
  ({ kind: 'field', label, field: label, geom, children: [], ...extra });
const sub = (label: string, layout: string, geom: XfaRawGeom, children: LayoutNode[], extra: Partial<LayoutNode> = {}): LayoutNode =>
  ({ kind: 'subform', label, layout, geom, children, ...extra });
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
/** Text of N characters at 5pt each, 10pt a line, wrapping at the given width. */
const text = (n: number): XfaMeasure => (_node, b) => {
  const lineW = 'width' in b ? b.width : b.maxWidth ?? Infinity;
  const per = Math.max(1, Math.floor(lineW / 5));
  const lines = Math.ceil(n / Math.min(per, n));
  return { w: 'width' in b ? b.width : Math.min(n, per) * 5, h: lines * 10 };
};

describe('layoutPage with a measurer', () => {
  it('without one, refuses exactly as 164g.1 did', () => {
    const m = layoutPage(page([fld('a', { w: '10pt' })]));
    expect(why(m, 'a')).toMatch(/states no h, so its size comes from its content, which needs text measurement \(164g\.7\)/);
  });

  it('measures a height-growable leaf at its stated width', () => {
    const m = layoutPage(page([fld('a', { w: '20pt' })]), text(10));
    expect(box(m, 'a')).toEqual({ x: 0, y: 0, w: 20, h: 30 });
  });

  it('measures a width-growable leaf, wrapping at maxW', () => {
    const m = layoutPage(page([fld('a', { h: '10pt' }, { minMax: { maxW: '15pt' } })]), text(3));
    expect(box(m, 'a').w).toBe(15);
  });

  it('applies minH and minW as floors under tb and row parents too', () => {
    const m = layoutPage(page([sub('T', 'tb', {}, [
      fld('a', { w: '20pt' }, { minMax: { minH: '25pt' } }),
      fld('b', { w: '20pt' }),
    ])]), text(2));
    expect(box(m, 'a').h).toBe(25);
    expect(box(m, 'b').y).toBe(25);
  });

  it('treats maxH of 0 as absent and refuses content past a non-zero maxH', () => {
    expect(box(layoutPage(page([fld('a', { w: '20pt' }, { minMax: { maxH: '0' } })]), text(10)), 'a').h).toBe(30);
    expect(why(layoutPage(page([fld('a', { w: '20pt' }, { minMax: { maxH: '15pt' } })]), text(10)), 'a')).toMatch(/exceeds maxH/);
  });

  it('swaps min > max, with a warning', () => {
    const warnings: string[] = [];
    const m = layoutPage(page([fld('a', { w: '20pt' }, { minMax: { minH: '40pt', maxH: '30pt' } })]), text(2), warnings);
    expect(box(m, 'a').h).toBe(30);
    expect(warnings).toEqual(['a: minH exceeds maxH, so the two are swapped (XFA 3.3 p. 277)']);
  });

  it('passes the measurer\'s reason through and fails the rest of the flow', () => {
    const no: XfaMeasure = () => ({ reason: 'a: no face' });
    const m = layoutPage(page([sub('T', 'tb', {}, [fld('a', { w: '20pt' }), fld('b', { w: '20pt', h: '5pt' })])]), no);
    expect(why(m, 'a')).toBe('a: no face');
    expect(why(m, 'b')).toMatch(/an earlier item in its flow could not be laid out \(a: no face\)/);
  });

  it('ignores min and max on a leaf that states both w and h (p. 276)', () => {
    const m = layoutPage(page([fld('a', { w: '20pt', h: '5pt' }, { minMax: { minH: '40pt' } })]), text(2));
    expect(box(m, 'a').h).toBe(5);
  });
});

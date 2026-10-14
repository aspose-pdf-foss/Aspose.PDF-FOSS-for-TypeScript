// test/xfaflow-positioned-boxes.test.ts
import { describe, it, expect } from 'vitest';
import { positionedChildBoxes, type LayoutNode } from '../src/xfaflow.js';

const f = (label: string, y: string, h: number, extra: Partial<LayoutNode> = {}): LayoutNode =>
  ({ kind: 'field', label, geom: { x: '0pt', y, w: '50pt', h: `${String(h)}pt` }, children: [], ...extra });
const pos = (children: LayoutNode[], extra: Partial<LayoutNode> = {}): LayoutNode =>
  ({ kind: 'subform', label: 'pos', layout: 'position', geom: { w: '500pt', h: '300pt' }, children, ...extra });

describe('positionedChildBoxes (164g.11)', () => {
  it('reports each visible child, top in the content box, with its height', () => {
    const n = pos([f('a', '36pt', 20), f('h', '10pt', 10, { presence: 'hidden' }), f('b', '100pt', 30)],
      { margin: { topInset: '18pt', leftInset: '6pt' } });
    expect(positionedChildBoxes(n)).toEqual([
      { node: n.children[0], top: 36, h: 20 },
      { node: n.children[2], top: 100, h: 30 },
    ]);
  });

  it('applies an anchor shift to the top', () => {
    const n = pos([f('a', '100pt', 20, { geom: { x: '0pt', y: '100pt', w: '50pt', h: '20pt', anchorType: 'bottomLeft' } })]);
    expect(positionedChildBoxes(n)).toEqual([{ node: n.children[0], top: 80, h: 20 }]);
  });

  it('carries a child it cannot place as a reason', () => {
    expect(positionedChildBoxes(pos([f('a', 'abc', 20)]))).toEqual({ reason: 'a: y="abc" could not be read as a measurement' });
  });
});

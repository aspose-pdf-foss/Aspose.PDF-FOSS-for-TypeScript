// test/xfaflow-placed.test.ts
import { describe, it, expect } from 'vitest';
import { layoutPage, type LayoutNode, type PlacedNode } from '../src/xfaflow.js';

const leaf = (label: string, geom: Record<string, string>, extra: Partial<LayoutNode> = {}): LayoutNode =>
  ({ kind: 'draw', label, geom, children: [], ...extra });
const page = (children: LayoutNode[], geom: Record<string, string> = { w: '612pt', h: '792pt' }): LayoutNode =>
  ({ kind: 'page', label: 'contentArea', layout: 'tb', geom, children });

const run = (root: LayoutNode) => { const nodes: PlacedNode[] = []; layoutPage(root, undefined, [], nodes); return nodes; };
const boxes = (ns: PlacedNode[]) => ns.map((n) => ('box' in n ? `${n.node.label}@${n.box.x},${n.box.y},${n.box.w},${n.box.h}` : `${n.node.label}!`));

describe('layoutPage: placed nodes (164g.4)', () => {
  it('reports draws, which have no SOM name, with their boxes', () => {
    const ns = run(page([leaf('d1', { w: '10pt', h: '5pt' }), leaf('d2', { w: '10pt', h: '7pt' })]));
    expect(boxes(ns)).toEqual(['d1@0,0,10,5', 'd2@0,5,10,7']);
  });

  it('reports a container BEFORE its children, in document order', () => {
    const s: LayoutNode = { kind: 'subform', label: 'S', layout: 'position', geom: { w: '50pt', h: '40pt' },
      children: [leaf('a', { x: '5pt', y: '6pt', w: '1pt', h: '1pt' })] };
    expect(boxes(run(page([s])))).toEqual(['S@0,0,50,40', 'a@5,6,1,1']);
  });

  it('marks a node invisible when an ancestor is, and records nothing for a hidden one', () => {
    const s: LayoutNode = { kind: 'subform', label: 'S', layout: 'position', presence: 'invisible',
      geom: { w: '10pt', h: '10pt' }, children: [leaf('a', { w: '1pt', h: '1pt' })] };
    const h = leaf('h', { w: '1pt', h: '1pt' }, { presence: 'hidden' });
    const ns = run(page([s, h]));
    expect(ns.map((n) => ('box' in n ? `${n.node.label}:${String(n.invisible)}` : '?'))).toEqual(['S:true', 'a:true']);
  });

  // The bottom check applies under a FLOWED container: the content area's own
  // children are pagination's to place (xfapage.ts), so the root bounds nothing.
  const flowed = (c: LayoutNode): LayoutNode => ({ kind: 'subform', label: 'T', layout: 'tb', geom: {}, children: [c] });

  it('reports a draw that overflows its contentArea as refused, with a reason', () => {
    const ns = run(page([flowed(leaf('big', { w: '10pt', h: '900pt' }))]));
    const big = ns.find((n) => n.node.label === 'big')!;
    expect('reason' in big && big.reason).toMatch(/overflows its contentArea/);
  });

  // DoD DD 1494's Line1 ends at 17.463mm + 236.538mm = 254.001mm in a 254mm
  // content area: 0.0028pt over, from three-decimal mm values alone. pdf.js
  // draws it; refusing it would drop the line.
  it('places a draw that ends past its contentArea by mm rounding alone', () => {
    const ns = run(page([flowed(leaf('Line1', { w: '0in', h: '254.001mm' }))], { w: '190.5mm', h: '254mm' }));
    const l = ns.find((n) => n.node.label === 'Line1')!;
    expect('box' in l).toBe(true);
  });

  it('still refuses a draw that ends past its contentArea by more than rounding', () => {
    const ns = run(page([flowed(leaf('big', { w: '1pt', h: '720.05pt' }))], { w: '612pt', h: '720pt' }));
    expect('reason' in ns.find((n) => n.node.label === 'big')!).toBe(true);
  });

  it('does not report a refused NAMED field as a placed node (it is reported as a field)', () => {
    const f = leaf('f', { w: '10pt', h: '900pt' }, { kind: 'field', field: 'form1[0].f[0]' });
    expect(run(page([flowed(f)])).filter((n) => n.node.label === 'f')).toEqual([]);
  });

  it('uses a table cell size for the leaf it forces', () => {
    const row: LayoutNode = { kind: 'subform', label: 'R', layout: 'row', geom: {},
      children: [leaf('c1', { w: '10pt', h: '5pt' }), leaf('c2', { w: '10pt', h: '9pt' })] };
    const t: LayoutNode = { kind: 'subform', label: 'T', layout: 'table', columnWidths: '20pt 20pt', geom: {}, children: [row] };
    const ns = run(page([t]));
    expect(boxes(ns)).toContain('c1@0,0,20,9');
  });

  it('leaves the field map unchanged', () => {
    const f = leaf('f', { w: '10pt', h: '5pt' }, { kind: 'field', field: 'form1[0].f[0]' });
    const nodes: PlacedNode[] = [];
    const m = layoutPage(page([f]), undefined, [], nodes);
    expect(m.get('form1[0].f[0]')).toEqual({ box: { x: 0, y: 0, w: 10, h: 5 } });
  });
});

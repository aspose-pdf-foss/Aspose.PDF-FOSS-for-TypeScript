// test/xfachrome-border.test.ts
import { describe, it, expect } from 'vitest';
import { parseXml } from '../src/xml.js';
import { parseBorder, parseGeometry } from '../src/xfaborder.js';
import { chromeOps, type ChromeOp } from '../src/xfachrome.js';
import type { LayoutNode, PlacedNode } from '../src/xfaflow.js';

const xml = (s: string) => parseXml(new TextEncoder().encode(s));
const node = (chrome: LayoutNode['chrome'], kind: LayoutNode['kind'] = 'subform'): LayoutNode =>
  ({ kind, label: 'N', geom: {}, children: [], chrome });
const at = (n: LayoutNode, box = { x: 10, y: 20, w: 100, h: 50 }, invisible = false): PlacedNode => ({ node: n, box, invisible });
const ops = (p: PlacedNode[]) => chromeOps(p).ops;
const strokes = (o: ChromeOp[]) => o.filter((x) => x.kind === 'stroke');

describe('chromeOps: borders (XFA 3.3 p. 38, 629-630, 663-665, 687-689)', () => {
  it('strokes a uniform border as one closed path on the rectangle (hand even)', () => {
    const o = ops([at(node({ border: parseBorder(xml('<border><edge thickness="2pt"/></border>')) }))]);
    expect(o).toEqual([{ kind: 'stroke', width: 2, color: [0, 0, 0], cap: 'butt', join: 'miter',
      path: [['M', 10, 20], ['L', 110, 20], ['L', 110, 70], ['L', 10, 70], ['Z']] }]);
  });

  it('moves the centreline half a thickness INSIDE for hand right, OUTSIDE for left', () => {
    const r = strokes(ops([at(node({ border: parseBorder(xml('<border hand="right"><edge thickness="2pt"/></border>')) }))]))[0];
    expect(r.kind === 'stroke' && r.path[0]).toEqual(['M', 11, 21]);
    const l = strokes(ops([at(node({ border: parseBorder(xml('<border hand="left"><edge thickness="2pt"/></border>')) }))]))[0];
    expect(l.kind === 'stroke' && l.path[0]).toEqual(['M', 9, 19]);
  });

  it('insets the rectangle by the border margin', () => {
    const o = strokes(ops([at(node({ border: parseBorder(xml('<border><edge/><margin leftInset="5pt" topInset="4pt"/></border>')) }))]))[0];
    expect(o.kind === 'stroke' && o.path[0]).toEqual(['M', 15, 24]);
  });

  it('fills BEFORE stroking, over the border rectangle', () => {
    const o = ops([at(node({ border: parseBorder(xml('<border><edge/><fill><color value="255,0,0"/></fill></border>')) }))]);
    expect(o.map((x) => x.kind)).toEqual(['fill', 'stroke']);
    expect(o[0]).toMatchObject({ color: [1, 0, 0] });
  });

  it('fills but does not stroke a border with no <edge> (p. 38)', () => {
    const o = ops([at(node({ border: parseBorder(xml('<border><fill/></border>')) }))]);
    expect(o.map((x) => x.kind)).toEqual(['fill']);
  });

  it('strokes each visible edge separately, with square caps, when the edges differ', () => {
    const b = parseBorder(xml('<border><edge presence="hidden"/><edge presence="hidden"/><edge thickness="1pt"/><edge presence="hidden"/></border>'));
    const o = strokes(ops([at(node({ border: b }))]));
    expect(o).toHaveLength(1);
    expect(o[0]).toMatchObject({ cap: 'square', path: [['M', 10, 70], ['L', 110, 70]] });
  });

  it('trims each edge by the corner radius and draws round corners as arcs', () => {
    const b = parseBorder(xml('<border><edge/><corner radius="5pt" join="round"/></border>'));
    const s = strokes(ops([at(node({ border: b }))]))[0];
    if (s.kind !== 'stroke') throw new Error();
    expect(s.join).toBe('round');
    expect(s.path[0]).toEqual(['M', 15, 20]);
    expect(s.path.filter((c) => c[0] === 'C')).toHaveLength(4);
  });

  it('gives each dash stroke its dash array', () => {
    const d = (s: string) => strokes(ops([at(node({ border: parseBorder(xml(`<border><edge stroke="${s}" thickness="1pt"/></border>`)) }))]))[0];
    expect(d('dashed')).toMatchObject({ dash: [3, 3], cap: 'butt' });
    expect(d('dotted')).toMatchObject({ dash: [0, 2], cap: 'round' });
    expect(d('dashDot')).toMatchObject({ dash: [3, 2, 0, 2] });
    expect(d('dashDotDot')).toMatchObject({ dash: [3, 2, 0, 2, 0, 2] });
  });

  it('paints a 3-D page-content edge solid and reports it', () => {
    const r = chromeOps([at(node({ border: parseBorder(xml('<border><edge stroke="lowered"/></border>')) }))]);
    expect(r.ops[0]).not.toHaveProperty('dash');
    expect(r.skipped).toEqual([{ name: 'N', reason: 'a lowered border edge is painted solid' }]);
  });

  it('reports an unsupported fill and an open break', () => {
    const r = chromeOps([at(node({ border: parseBorder(xml('<border break="open"><edge/><fill><linear/></fill></border>')) }))]);
    expect(r.skipped.map((s) => s.reason)).toEqual(['a linear fill is not painted', 'a break="open" border is drawn closed']);
  });

  it('paints nothing for an invisible node or an invisible border', () => {
    expect(ops([at(node({ border: parseBorder(xml('<border><edge/></border>')) }), undefined, true)])).toEqual([]);
    expect(ops([at(node({ border: parseBorder(xml('<border presence="invisible"><edge/></border>')) }))])).toEqual([]);
  });

  it('reports a refused node that has chrome, and stays silent for one that has none', () => {
    const r = chromeOps([{ node: node({ border: parseBorder(xml('<border><edge/></border>')) }), reason: 'too tall' },
      { node: node(undefined), reason: 'too tall' }]);
    expect(r.skipped).toEqual([{ name: 'N', reason: 'too tall, so its chrome is not painted' }]);
  });

  // Review Focus 5: a degenerate box never puts NaN into a content stream.
  it('paints nothing for a zero-size box and stays finite for an edge thicker than the box', () => {
    expect(ops([at(node({ border: parseBorder(xml('<border><edge/></border>')) }), { x: 0, y: 0, w: 0, h: 10 })])).toEqual([]);
    const o = ops([at(node({ border: parseBorder(xml('<border hand="right"><edge thickness="50pt"/></border>')) }), { x: 0, y: 0, w: 4, h: 4 })]);
    const nums = JSON.stringify(o).match(/-?\d+(\.\d+)?(e-?\d+)?|null|NaN/g) ?? [];
    expect(nums).not.toContain('null');
    expect(nums).not.toContain('NaN');
  });
});

describe('chromeOps: draw geometry (p. 768, 824)', () => {
  const draw = (v: string) => node({ geometry: parseGeometry(xml(`<value>${v}</value>`))! }, 'draw');

  it('draws a \\ line top-left to bottom-right and a / line bottom-left to top-right', () => {
    expect(ops([at(draw('<line/>'))])[0]).toMatchObject({ path: [['M', 10, 20], ['L', 110, 70]], cap: 'square' });
    expect(ops([at(draw('<line slope="/"/>'))])[0]).toMatchObject({ path: [['M', 10, 70], ['L', 110, 20]] });
  });

  it('draws a zero-height line as a horizontal rule', () => {
    expect(ops([at(draw('<line/>'), { x: 0, y: 5, w: 30, h: 0 })])[0]).toMatchObject({ path: [['M', 0, 5], ['L', 30, 5]] });
  });

  it('draws a rectangle through the border engine', () => {
    const o = ops([at(draw('<rectangle><edge thickness="2pt"/></rectangle>'))]);
    expect(o[0]).toMatchObject({ kind: 'stroke', width: 2, path: [['M', 10, 20], ['L', 110, 20], ['L', 110, 70], ['L', 10, 70], ['Z']] });
  });

  it('reports an arc and paints nothing for it', () => {
    const r = chromeOps([at(draw('<arc/>'))]);
    expect(r.ops).toEqual([]);
    expect(r.skipped).toEqual([{ name: 'N', reason: 'an <arc> draw is not painted' }]);
  });

  it('paints a node\'s fill and border before its geometry', () => {
    const n: LayoutNode = { kind: 'draw', label: 'N', geom: {}, children: [], chrome: {
      border: parseBorder(xml('<border><fill/></border>')), geometry: parseGeometry(xml('<value><line/></value>'))! } };
    expect(ops([at(n)]).map((x) => x.kind)).toEqual(['fill', 'stroke']);
  });
});

// test/xfasplitpos.test.ts
import { describe, it, expect } from 'vitest';
import { positionedCut, positionedFragment, positionedSplittable, type XfaChildBoxes } from '../src/xfasplitpos.js';
import type { LayoutNode } from '../src/xfaflow.js';
import type { LeafText } from '../src/xfarich.js';

const pt = (s: string | undefined): number => Number((s ?? '0pt').replace('pt', ''));
const fld = (label: string, y: number, h: number, size = 10): LayoutNode => ({
  kind: 'field', label, geom: { x: '0pt', y: `${String(y)}pt`, w: '100pt', h: `${String(h)}pt` }, children: [],
  text: { paras: [{ base: { size } }] } as unknown as LeafText,
});
const drw = (label: string, y: number, h: number): LayoutNode =>
  ({ kind: 'draw', label, geom: { x: '0pt', y: `${String(y)}pt`, w: '100pt', h: `${String(h)}pt` }, children: [] });
const pos = (label: string, h: number, children: LayoutNode[], extra: Partial<LayoutNode> = {}): LayoutNode =>
  ({ kind: 'subform', label, layout: 'position', geom: { w: '540pt', h: `${String(h)}pt` }, keep: { intact: 'none' }, children, ...extra });
const at = (y: number, h: number, w = 216) => ({ geom: { x: '0pt', y: `${String(y)}pt`, w: `${String(w)}pt`, h: `${String(h)}pt` } });
const boxes: XfaChildBoxes = (n) => n.children
  .filter((k) => k.presence !== 'hidden' && k.presence !== 'inactive')
  .map((k) => ({ node: k, top: pt(k.geom.y), h: pt(k.geom.h) }));

describe('positionedSplittable (R1)', () => {
  it('is true only for a positioned subform stating keep intact="none"', () => {
    expect(positionedSplittable(pos('p', 288, []))).toBe(true);
    expect(positionedSplittable(pos('p', 288, [], { keep: undefined }))).toBe(false);      // t3
    expect(positionedSplittable(pos('p', 288, [], { keep: { intact: 'contentArea' } }))).toBe(false);
    expect(positionedSplittable(pos('p', 288, [], { layout: 'tb' }))).toBe(false);
    expect(positionedSplittable(pos('p', 288, [], { refusal: 'x' }))).toBe(false);
    expect(positionedSplittable({ ...drw('d', 0, 10), keep: { intact: 'none' } })).toBe(false);
  });
});

describe('positionedCut (R2-R8)', () => {
  it('cuts at the room left when nothing straddles it (t5)', () => {
    expect(positionedCut(pos('p', 288, [fld('a', 36, 21.6), fld('b', 108, 21.6), fld('c', 216, 21.6)]), 144, boxes)).toBe(144);
  });
  it('does not count a child whose top is exactly on the cut as straddling', () => {
    expect(positionedCut(pos('p', 288, [fld('c', 144, 21.6)]), 144, boxes)).toBe(144);
  });
  it('moves the cut to a straddling draw (t12)', () => {
    expect(positionedCut(pos('p', 288, [drw('dr', 120, 48)]), 144, boxes)).toBe(120);
  });
  it('moves the cut to a straddling subform that does not split (t13)', () => {
    const inner = pos('inner', 48, [fld('g', 0, 20)], { keep: undefined, ...at(120, 48) });
    expect(positionedCut(pos('p', 288, [inner]), 144, boxes)).toBe(120);
  });
  it('moves the cut to a field whose top piece is below its font size (t8, t19, t22)', () => {
    expect(positionedCut(pos('p', 288, [fld('f', 138, 48)]), 144, boxes)).toBe(138);
    expect(positionedCut(pos('p', 288, [fld('f', 135, 48)]), 144, boxes)).toBe(135);
    expect(positionedCut(pos('p', 288, [fld('f', 129, 60, 20)]), 144, boxes)).toBe(129);
  });
  it('refuses a field whose top piece reaches its font size (t20, t6), naming 164g.13', () => {
    for (const k of [fld('f', 134, 48), fld('b', 108, 72)]) {
      const r = positionedCut(pos('p', 288, [k]), 144, boxes);
      expect(r).toEqual({ refusal: `${k.label}: Adobe splits a field straddling a content-area break between its lines, which is not implemented (164g.13)` });
    }
  });
  it('repeats until nothing straddles (t7)', () => {
    // f clears the first cut (135 < 144) and straddles only the one d makes
    // (130): a single pass returns 130. Keep f FIRST or the case measures nothing.
    expect(positionedCut(pos('p', 864, [fld('f', 125, 10), drw('d', 130, 20)]), 144, boxes)).toBe(125);
    expect(positionedCut(pos('p', 864, [fld('c', 496.8, 21.6)]), 504, boxes)).toBeCloseTo(496.8, 9);
  });
  it('splits a straddling keep-none positioned child at the same cut (t24)', () => {
    const inner = pos('inner', 120, [fld('g', 0, 20), fld('k', 80, 20)], at(100, 120));
    expect(positionedCut(pos('p', 288, [inner]), 144, boxes)).toBe(144);
  });
  it('moves the cut by what a nested split decides', () => {
    const inner = pos('inner', 120, [drw('d', 30, 30)], at(100, 120));
    expect(positionedCut(pos('p', 288, [inner]), 144, boxes)).toBe(130);
  });
  it('returns 0 when a child covers the top (t25)', () => {
    expect(positionedCut(pos('p', 288, [drw('dr', 0, 200)]), 144, boxes)).toBe(0);
  });
  it('refuses a top or bottom margin, naming 164g.20, and allows left/right ones (t14)', () => {
    const want = { refusal: 'p: a positioned subform with a top or bottom margin is not split across content areas (164g.20)' };
    expect(positionedCut(pos('p', 288, [], { margin: { topInset: '18pt' } }), 144, boxes)).toEqual(want);
    expect(positionedCut(pos('p', 288, [], { margin: { bottomInset: '12pt' } }), 144, boxes)).toEqual(want);
    expect(positionedCut(pos('p', 288, [], { margin: { leftInset: '6pt', rightInset: '6pt' } }), 144, boxes)).toBe(144);
  });
  it('refuses a child anchored other than topLeft (R8)', () => {
    const k: LayoutNode = { ...fld('a', 36, 20), geom: { x: '0pt', y: '36pt', w: '100pt', h: '20pt', anchorType: 'bottomLeft' } };
    expect(positionedCut(pos('p', 288, [k]), 144, boxes))
      .toEqual({ refusal: 'a: a child anchored bottomLeft is not split with its positioned parent' });
  });
  it("carries the boxes callback's reason as a refusal", () => {
    expect(positionedCut(pos('p', 288, []), 144, () => ({ reason: 'nope' }))).toEqual({ refusal: 'nope' });
  });
});

describe('positionedFragment (R6)', () => {
  const frag = (n: LayoutNode, from: number, to: number) => {
    const f = positionedFragment(n, from, to, boxes);
    if ('refusal' in f) throw new Error(f.refusal);
    return f;
  };
  const show = (f: LayoutNode): string =>
    `${f.label}@${f.geom.y ?? '-'}:${f.geom.h ?? '-'}(${f.children.map(show).join(',')})`;

  it('keeps each child in the fragment holding its top, shifted (t5)', () => {
    const p = pos('p', 288, [fld('a', 36, 21.6), fld('b', 108, 21.6), fld('c', 216, 21.6)]);
    expect(show(frag(p, 0, 144))).toBe('p@-:144pt(a@36pt:21.6pt(),b@108pt:21.6pt())');
    expect(show(frag(p, 144, 288))).toBe('p@-:144pt(c@72pt:21.6pt())');
  });
  it('puts a child whose top is on the cut in the later fragment', () => {
    const p = pos('p', 288, [fld('c', 144, 21.6)]);
    expect(frag(p, 0, 144).children).toEqual([]);
    expect(frag(p, 144, 288).children.map((k) => k.geom.y)).toEqual(['0pt']);
  });
  it('allows an empty fragment (t26)', () => {
    expect(show(frag(pos('p', 288, [fld('g', 200, 20)]), 0, 144))).toBe('p@-:144pt()');
  });
  it('splits a keep-none positioned child into its own fragments (t24)', () => {
    const p = pos('p', 288, [pos('inner', 120, [fld('g', 0, 20), fld('k', 80, 20)], at(100, 120))]);
    expect(show(frag(p, 0, 144))).toBe('p@-:144pt(inner@100pt:44pt(g@0pt:20pt()))');
    expect(show(frag(p, 144, 288))).toBe('p@-:144pt(inner@0pt:76pt(k@36pt:20pt()))');
  });
  it('keeps hidden children in the first fragment, in document order', () => {
    const h: LayoutNode = { ...fld('h', 250, 10), presence: 'hidden' };
    const p = pos('p', 288, [fld('a', 36, 20), h, fld('c', 216, 20)]);
    expect(frag(p, 0, 144).children.map((k) => k.label)).toEqual(['a', 'h']);
    expect(frag(p, 144, 288).children.map((k) => k.label)).toEqual(['c']);
  });
  it('states h on a growable subform and drops its minMax', () => {
    const p = { ...pos('p', 288, [fld('a', 36, 20)]), geom: { w: '540pt' }, minMax: { minH: '100pt' } };
    const f = frag(p, 0, 144);
    expect([f.geom.h, f.minMax]).toEqual(['144pt', undefined]);
  });
});

// Final review fixes (164g.11).
describe('final review fixes', () => {
  it('writes a near-zero shifted y as plain 0pt, never in exponent notation (mm templates)', () => {
    // 254 - 127 - 50.8 leaves a room that differs from 76.2 by ~1e-14.
    const room = 254 * 72 / 25.4 - 127 * 72 / 25.4 - 50.8 * 72 / 25.4;
    const c = { ...fld('c', 0, 10), geom: { x: '0pt', y: `${String(76.2 * 72 / 25.4)}pt`, w: '100pt', h: '10pt' } };
    const p = pos('p', 101.6 * 72 / 25.4, [c]);
    const tail = positionedFragment(p, room, 101.6 * 72 / 25.4, boxes);
    if ('refusal' in tail) throw new Error(tail.refusal);
    for (const k of tail.children) expect(k.geom.y).not.toMatch(/e/);
    expect(tail.geom.h).not.toMatch(/e/);
  });
  it('refuses a split when a child lies above the top or at or below the stated h', () => {
    expect(positionedCut(pos('p', 288, [fld('a', -10, 20), fld('b', 36, 20)]), 144, boxes))
      .toEqual({ refusal: 'a: a child outside its positioned parent\'s height is not split with it' });
    expect(positionedCut(pos('p', 288, [fld('b', 36, 20), fld('z', 300, 20)]), 144, boxes))
      .toEqual({ refusal: 'z: a child outside its positioned parent\'s height is not split with it' });
  });
  it('refuses a nested keep-none child that runs past its parent\'s height', () => {
    const inner = pos('inner', 200, [fld('g', 0, 20), fld('k', 180, 20)], at(100, 200));
    expect(positionedCut(pos('p', 288, [inner]), 144, boxes))
      .toEqual({ refusal: 'inner: a child outside its positioned parent\'s height is not split with it' });
  });
  it('refuses a nested keep-none child with an <overflow> that the cut would continue (164g.15)', () => {
    const inner = pos('inner', 120, [fld('g', 0, 20), fld('k', 80, 20)], { ...at(100, 120), overflow: true });
    expect(positionedCut(pos('p', 288, [inner]), 144, boxes))
      .toEqual({ refusal: 'inner: its <overflow> leader or trailer would be inserted as it continues into the next region, which is not implemented (164g.15)' });
  });
});

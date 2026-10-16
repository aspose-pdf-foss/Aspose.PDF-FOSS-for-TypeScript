import { describe, it, expect } from 'vitest';
import {
  paginate, layoutPages, layoutHooks,
  type XfaBody, type XfaPageAreaModel, type XfaContentArea, type XfaHeight,
} from '../src/xfapage.js';
import type { LayoutNode, XfaBreak, Placed } from '../src/xfaflow.js';
import { SPLIT_LATER, measureExtent } from '../src/xfaflow.js';
import type { XfaRawGeom } from '../src/xfageom.js';
import type { XfaChildBoxes } from '../src/xfasplitpos.js';
import type { LeafText } from '../src/xfarich.js';

/** A root child of stated height. A label ending in '!' has ink past any limit. */
const kid = (label: string, h: number, extra: Partial<LayoutNode> = {}): LayoutNode =>
  ({ kind: 'subform', label, layout: 'position', geom: { w: '100pt', h: `${String(h)}pt` }, children: [], ...extra });
const ca = (h: number | undefined, extra: { name?: string; id?: string } = {}): XfaContentArea => ({
  ...extra,
  node: {
    kind: 'page', label: 'contentArea', layout: 'tb',
    geom: h === undefined ? {} : { w: '500pt', h: `${String(h)}pt` }, children: [],
  },
});
const area = (cas: XfaContentArea[], extra: Partial<XfaPageAreaModel> = {}): XfaPageAreaModel =>
  ({ max: -1, contentAreas: cas, ...extra });
const body = (
  pageAreas: XfaPageAreaModel[], kids: LayoutNode[],
  o: { relation?: string; max?: number; refusal?: string; rootLayout?: string; rootBreak?: XfaBreak } = {},
): XfaBody => ({
  root: {
    kind: 'subform', label: 'root[0]', layout: o.rootLayout ?? 'tb', geom: {}, children: kids,
    ...(o.rootBreak ? { breakBefore: o.rootBreak } : {}),
  },
  pageSet: {
    relation: o.relation ?? 'orderedOccurrence', max: o.max ?? -1, pageAreas,
    ...(o.refusal !== undefined ? { refusal: o.refusal } : {}),
  },
});
const height: XfaHeight = (n) => ({ h: Number((n.geom.h ?? '0pt').replace('pt', '')), past: n.label.endsWith('!') });
const pages = (b: XfaBody) => paginate(b, height).pages.map((p) =>
  [p.pageArea, ...p.contentAreas.map((c) => `${String(c.index)}:${c.children.map((k) => k.label).join(',')}`)]);
const refusals = (b: XfaBody) => [...paginate(b, height).refused].map(([n, why]) => [n.label, why]);
const pb = (extra: Partial<XfaBreak> = {}): XfaBreak => ({ targetType: 'pageArea', startNew: false, ...extra });
const cb = (extra: Partial<XfaBreak> = {}): XfaBreak => ({ targetType: 'contentArea', startNew: false, ...extra });
const AFTER = /^an earlier item in its flow could not be laid out \(/;

/** A splittable tb subform (no stated h). */
const tb = (label: string, children: LayoutNode[], extra: Partial<LayoutNode> = {}): LayoutNode =>
  ({ kind: 'subform', label, layout: 'tb', geom: { w: '100pt' }, children, ...extra });
const pt = (s: string | undefined): number => Number((s ?? '0pt').replace('pt', ''));
/** A node's height: a stated h, else its margins plus its children's heights. */
const hOf = (n: LayoutNode): number => (n.geom.h !== undefined ? pt(n.geom.h)
  : pt(n.margin?.topInset) + pt(n.margin?.bottomInset)
    + n.children.filter((k) => k.presence !== 'hidden').reduce((s, k) => s + hOf(k), 0));
/** A node with a label ending in '!' anywhere below it draws past any limit
 *  (a fragment copies its container's label, so a leaf's '!' must show through). */
const bang = (n: LayoutNode): boolean => n.label.endsWith('!') || n.children.some(bang);
const flowHeight: XfaHeight = (n) => ({ h: hOf(n), past: bang(n) });
/** A region's children as nested labels: a fragment shows what it holds. */
const SPLITS = new Set(['tb', 'lr-tb', 'table']);
const shape = (n: LayoutNode): string =>
  (SPLITS.has(n.layout ?? '') && n.geom.h === undefined ? `${n.label}(${n.children.map(shape).join(',')})` : n.label);
const split = (b: XfaBody) => paginate(b, flowHeight).pages.map((p) =>
  p.contentAreas.map((c) => `${String(c.index)}:${c.children.map(shape).join(',')}`).join(' '));
const splitRefusals = (b: XfaBody) => [...paginate(b, flowHeight).refused].map(([n, w]) => [n.label, w]);
// 164g.12: lr-tb and table fragments are measured by the real engine.
const real: XfaHeight = (n, limit) => measureExtent(n, limit, undefined, [], 'tb');
const realRun = (b: XfaBody) => paginate(b, real, layoutHooks());
const realSplit = (b: XfaBody) => realRun(b).pages.map((p) =>
  p.contentAreas.map((c) => `${String(c.index)}:${c.children.map(shape).join(',')}`).join(' '));
const realRefusals = (b: XfaBody) => [...realRun(b).refused].map(([n, w]) => [n.label, w]);
const EMPTY_TEXT = {
  kind: 'text', paras: [{ runs: [], base: { family: ['Courier'], size: 10, bold: false, italic: false },
    marginLeft: 0, marginRight: 0, textIndent: 0, lineHeight: 0, spaceAbove: 0, spaceBelow: 0 }],
  insets: { l: 0, r: 0, t: 0, b: 0 }, password: false, picture: false,
} as unknown as LeafText;
const fldN = (label: string, w: number, h: number, extra: Partial<LayoutNode> = {}): LayoutNode =>
  ({ kind: 'field', label, field: label, ui: 'textEdit', geom: { w: `${String(w)}pt`, h: `${String(h)}pt` }, children: [], text: EMPTY_TEXT, ...extra });
const drwN = (label: string, w: number, h: number, extra: Partial<LayoutNode> = {}): LayoutNode =>
  ({ kind: 'draw', label, geom: { w: `${String(w)}pt`, h: `${String(h)}pt` }, children: [], ...extra });
const lrtb = (label: string, children: LayoutNode[], extra: Partial<LayoutNode> = {}): LayoutNode =>
  ({ kind: 'subform', label, layout: 'lr-tb', geom: { w: '300pt' }, children, ...extra });
const rowN = (label: string, cells: LayoutNode[]): LayoutNode =>
  ({ kind: 'subform', label, layout: 'row', geom: {}, children: cells });
const tableN = (label: string, cols: string, rows: LayoutNode[], extra: Partial<LayoutNode> = {}): LayoutNode =>
  ({ kind: 'subform', label, layout: 'table', columnWidths: cols, geom: {}, children: rows, ...extra });
const draws = (n: number, w = 100, h = 30): LayoutNode[] =>
  Array.from({ length: n }, (_, i) => drwN(`d${String(i + 1)}`, w, h));

// 164g.8: a tb subform with no stated h splits BETWEEN its children (XFA 3.3
// p. 290-292). DD 1494's TopForm > P1..P6 > front/back is the oracle.
describe('paginate: splitting a tb subform between its children (164g.8)', () => {
  // p. 290: "putting the top of it into the current region". T (90) would fit an
  // empty page whole, which is what separates splitting here from moving first.
  it('puts the top into the room left, then continues on the next page', () => {
    expect(split(body([area([ca(100)])], [kid('A', 50), tb('T', [kid('a', 30), kid('b', 30), kid('c', 30)])])))
      .toEqual(['0:A,T(a)', '0:T(b,c)']);
  });

  it('places a splittable child that fits whole, unflattened', () => {
    const t = tb('T', [kid('a', 30), kid('b', 30)]);
    const r = paginate(body([area([ca(100)])], [kid('A', 20), t]), flowHeight);
    expect(r.pages[0].contentAreas[0].children[1]).toBe(t);
  });

  it('splits a splittable child in turn', () => {
    expect(split(body([area([ca(100)])], [tb('T', [tb('U', [kid('a', 40), kid('b', 40), kid('c', 40)]), kid('d', 10)])])))
      .toEqual(['0:T(U(a,b))', '0:T(U(c),d)']);
  });

  // 164g.12, rule 3 (Adobe t35, t36, t39): every fragment carries BOTH margins.
  it('gives every fragment both margins', () => {
    const t = tb('T', [kid('a', 40), kid('b', 40), kid('c', 10)], { margin: { topInset: '10pt', bottomInset: '10pt' } });
    const r = paginate(body([area([ca(100)])], [t]), flowHeight);
    expect(split(body([area([ca(100)])], [t]))).toEqual(['0:T(a,b)', '0:T(c)']);
    const [f1, f2] = r.pages.map((p) => p.contentAreas[0].children[0]);
    expect([f1.margin?.topInset, f1.margin?.bottomInset]).toEqual(['10pt', '10pt']);
    expect([f2.margin?.topInset, f2.margin?.bottomInset]).toEqual(['10pt', '10pt']);
  });

  // 164g.8 checked page 1's room without the bottom margin, so b fitted there.
  it('reserves the bottom margin on the first page (t39)', () => {
    const t = tb('T', [kid('a', 40), kid('b', 45), kid('c', 10)], { margin: { topInset: '10pt', bottomInset: '10pt' } });
    expect(split(body([area([ca(100)])], [t]))).toEqual(['0:T(a)', '0:T(b,c)']);
  });

  it('never leaves a fragment holding only a top margin', () => {
    expect(split(body([area([ca(100)])], [kid('A', 50), tb('T', [kid('a', 80)], { margin: { topInset: '30pt' } })])))
      .toEqual(['0:A', '0:T(a)']);
  });

  it('places whole a subform that states h, and one kept intact', () => {
    const c3 = [kid('a', 30), kid('b', 30), kid('c', 30)];
    expect(split(body([area([ca(100)])], [kid('A', 50), tb('S', c3, { geom: { w: '100pt', h: '90pt' } })])))
      .toEqual(['0:A', '0:S']);
    expect(split(body([area([ca(100)])], [kid('A', 50), tb('K', c3, { keep: { intact: 'contentArea' } })])))
      .toEqual(['0:A', '0:K(a,b,c)']);
  });

  it('carries a concealed child at no height', () => {
    expect(split(body([area([ca(100)])], [tb('T', [kid('a', 60), kid('h', 60, { presence: 'hidden' }), kid('b', 60)])])))
      .toEqual(['0:T(a,h)', '0:T(b)']);
  });

  // p. 295 on one atom: placed past the boundary when its ink fits, refused otherwise.
  it('overrides the boundary for a whole child whose ink fits, and refuses one whose ink does not', () => {
    expect(split(body([area([ca(100)])], [tb('T', [kid('a', 50), kid('b', 150), kid('c', 10)])])))
      .toEqual(['0:T(a)', '0:T(b)', '0:T(c)']);
    const r = splitRefusals(body([area([ca(100)])], [tb('T', [kid('a', 50), kid('b!', 150), kid('c', 10)]), kid('Z', 10)]));
    expect(r[0]).toEqual(['b!', `b!: does not fit an empty content area and would need ${SPLIT_LATER}`]);
    expect(r.slice(1).map(([n]) => n)).toEqual(['c', 'Z']);
    for (const [, w] of r.slice(1)) expect(w).toMatch(AFTER);
  });

  it('runs past every occur max: what is placed stays, the rest is discarded', () => {
    const b = body([area([ca(100)], { max: 1 })], [tb('T', [kid('a', 60), kid('b', 60)])], { max: 1 });
    expect(split(b)).toEqual(['0:T(a)']);
    expect(splitRefusals(b)).toEqual([['b', "content past every pageArea's occur max is discarded (XFA 3.3 p. 300)"]]);
  });

  // A child that cannot be split falls back to whole placement (final review),
  // so these reach a refusal only when the whole child does not fit an empty
  // region either -- 'T!' draws past it -- and then the chain reason is named.
  it('refuses what it cannot do in a split chain, naming the child issue', () => {
    const big = (k: LayoutNode, t: Partial<LayoutNode> = {}) => body([area([ca(100)])], [tb('T!', [kid('a', 60), k], t)]);
    expect(splitRefusals(big(kid('B', 60, { breakAfter: pb() })))[0][1]).toMatch(/breakAfter inside a split subform .*\(164g\.16\)/);
    // An <overflow> container that continues into a second region needs its
    // leader or trailer inserted there.
    const r = splitRefusals(big(kid('O', 60), { overflow: true }));
    expect(r[0]).toEqual(['O', expect.stringMatching(/T!: its <overflow> leader or trailer .*\(164g\.15\)/) as unknown as string]);
  });

  // 164g.14 R8: a flowed subform's keep intact="pageArea" splits like none (t66-t68).
  it('splits a tb stating keep intact="pageArea", as none', () => {
    const b = body([area([ca(100)])], [tb('T', [kid('a', 60), kid('b', 60)], { keep: { intact: 'pageArea' } })]);
    expect(split(b)).toEqual(['0:T(a)', '0:T(b)']);
  });

  // Final review, Important 1: before 164g.8 a child that did not fit the room
  // left moved whole to the next region. A chain 164g.8 cannot split (here a
  // breakAfter, 164g.16) must still do that, not be
  // refused with every root child after it.
  it('places whole, as before, a child whose chain it cannot split but which fits an empty region', () => {
    const b = body([area([ca(100)])], [kid('A', 50), tb('T', [kid('a', 30, { breakAfter: pb() }), kid('b', 30)])]);
    expect(split(b)).toEqual(['0:A', '0:T(a,b)']);
    expect(splitRefusals(b)).toEqual([]);
  });

  // Final review, Important 2: a hidden child takes no part in layout (p. 67),
  // so its break and its refusals do not apply -- as at the root.
  it('ignores the break and the refusals of a hidden child in the chain', () => {
    const kids = (h: LayoutNode) => [kid('A', 10), tb('T', [kid('a', 30), h, kid('b', 30), kid('c', 50)])];
    expect(split(body([area([ca(100)])], kids(kid('h', 30, { presence: 'hidden', breakBefore: pb() })))))
      .toEqual(['0:A,T(a,h,b)', '0:T(c)']);
    expect(split(body([area([ca(100)])], kids(kid('h', 30, { presence: 'hidden', breakAfter: pb() })))))
      .toEqual(['0:A,T(a,h,b)', '0:T(c)']);
  });

  // Amendment (spec decision #3): DD 1494's P5/P6 lineDiagramPg start a new page
  // through their own breakBefore, inside the subform being split.
  it('applies a breakBefore inside the chain, even when the root child would fit whole', () => {
    expect(split(body([area([ca(100)])], [tb('T', [kid('a', 30), kid('b', 30, { breakBefore: pb() })])])))
      .toEqual(['0:T(a)', '0:T(b)']);
  });

  it('places an <overflow> container that stays in one region', () => {
    expect(split(body([area([ca(100)])], [tb('T', [tb('O', [kid('a', 30)], { overflow: true }), kid('b', 90)])])))
      .toEqual(['0:T(O(a))', '0:T(b)']);
  });
});

// 164g.12: an lr-tb splits between its items and a table between its rows,
// from the room left, as Adobe Reader does (probes t27-t39).
describe('paginate: splitting an lr-tb between items and a table between rows (164g.12)', () => {
  // t37: b3 would fit beside b1, but the first item that does not fit ends the
  // fragment; the rest re-packs from the left on the next page.
  it('cuts at the first item that does not fit and re-packs the rest from x = 0', () => {
    const L = lrtb('L', [drwN('a1', 100, 20), drwN('a2', 100, 40), drwN('a3', 100, 20),
      drwN('b1', 100, 5), drwN('b2', 100, 30), drwN('b3', 100, 5), drwN('c1', 100, 10)]);
    const b = body([area([ca(100)])], [kid('A', 50), L]);
    expect(realSplit(b)).toEqual(['0:A,L(a1,a2,a3,b1)', '0:L(b2,b3,c1)']);
    const p2 = layoutPages(b).pages[1].nodes;
    const at = (label: string) => p2.find((x) => x.node.label === label && 'box' in x) as { box: { x: number; y: number } };
    expect([at('b3').box.x, at('b3').box.y]).toEqual([100, 0]);
    expect([at('c1').box.x, at('c1').box.y]).toEqual([200, 0]);
  });

  // t27, t28, t31 against t35: Adobe splits a straddling field once its piece
  // above the cut reaches its font size (164g.13), and moves it otherwise.
  it('splits a straddling field whose piece reaches its font size, and moves one whose piece does not', () => {
    const fields = () => ['f1', 'f2', 'f3', 'f4', 'f5', 'f6'].map((n) => fldN(n, 100, 30));
    const b = body([area([ca(100)])], [kid('A', 50), lrtb('L', fields())]);
    expect(realSplit(b)).toEqual(['0:A,L(f1,f2,f3,f4)', '0:L(f4,f5,f6)']);
    const r = layoutPages(b);
    expect(r.pages[0].placed.get('f4')).toMatchObject({ box: { h: 20 }, piece: { offset: 0 } });
    expect(r.pages[1].placed.get('f4')).toMatchObject({ box: { h: 10, x: 0, y: 0 }, piece: { offset: 20 } });
    // A 62: room 38, f4's piece 8 < 10 -> it moves.
    expect(realSplit(body([area([ca(100)])], [kid('A', 62), lrtb('L', fields())])))
      .toEqual(['0:A,L(f1,f2,f3)', '0:L(f4,f5,f6)']);
  });
  // t47: a field in a tb splits too; t48: a draw there still moves.
  it('splits a field in a tb, and moves a draw', () => {
    expect(realSplit(body([area([ca(100)])], [kid('A', 50), tb('T', [fldN('f', 100, 80)])])))
      .toEqual(['0:A,T(f)', '0:T(f)']);
    const r = layoutPages(body([area([ca(100)])], [kid('A', 50), tb('T', [fldN('f', 100, 80)])]));
    expect([r.pages[0].placed.get('f'), r.pages[1].placed.get('f')])
      .toMatchObject([{ box: { h: 50 } }, { box: { h: 30 } }]);
    expect(realSplit(body([area([ca(100)])], [kid('A', 50), tb('T', [drwN('d', 100, 80)])])))
      .toEqual(['0:A', '0:T(d)']);
  });

  // Rule 7: a field taller than two content areas splits again.
  it('splits a field twice', () => {
    const r = layoutPages(body([area([ca(100)])], [kid('A', 50), tb('T', [fldN('f', 100, 230)])]));
    expect(r.pages.map((p) => (p.placed.get('f') as { box: { h: number } }).box.h)).toEqual([50, 100, 80]);
  });

  // Review Focus 2: in a tb a field the rules refuse moves whole, as under 164g.8.
  it('moves, rather than refuses, a field in a tb that would split and may not', () => {
    const box = fldN('c', 100, 80, { ui: 'checkButton' });
    const b = body([area([ca(100)])], [kid('A', 50), tb('T', [box])]);
    expect(realSplit(b)).toEqual(['0:A', '0:T(c)']);
    expect(realRefusals(b)).toEqual([]);
  });

  it('refuses, in an lr-tb, a field that would split and may not, naming 164g.26', () => {
    const f = fldN('f4', 100, 30, { ui: 'checkButton' });
    const r = realRefusals(body([area([ca(100)])], [kid('A', 50), lrtb('L', [...draws(3), f])]));
    expect(r[0]).toEqual(['f4', expect.stringMatching(/^f4: a <checkButton> field would split .*\(164g\.26\)$/) as unknown as string]);
  });

  // t38: a draw never splits -- it moves however much of it would fit.
  it('moves a straddling draw', () => {
    expect(realSplit(body([area([ca(100)])], [kid('A', 50), lrtb('L', draws(6))])))
      .toEqual(['0:A,L(d1,d2,d3)', '0:L(d4,d5,d6)']);
  });

  // t29: rows never straddle, even when a cell's field piece would reach its font size.
  it('splits a table between rows, moving a row whole', () => {
    const T = tableN('T', '100pt', [1, 2, 3].map((i) => rowN(`r${String(i)}`, [fldN(`c${String(i)}`, 100, 30)])));
    expect(realSplit(body([area([ca(100)])], [kid('A', 50), T]))).toEqual(['0:A,T(r1)', '0:T(r2,r3)']);
    expect(realRefusals(body([area([ca(100)])], [kid('A', 50), T]))).toEqual([]);
  });

  // t30: a -1 column is sized from the WHOLE table, on every page.
  it('keeps the whole table\'s -1 column width on every fragment', () => {
    const T = tableN('T', '-1', [rowN('r1', [fldN('c1', 40, 30)]), rowN('r2', [fldN('c2', 80, 30)])]);
    const r = layoutPages(body([area([ca(100)])], [kid('A', 60), T]));
    expect(r.pages.length).toBe(2);
    expect(r.pages[0].placed.get('c1')).toMatchObject({ box: { w: 80 } });
    expect(r.pages[1].placed.get('c2')).toMatchObject({ box: { w: 80 } });
  });

  // t31, t32: an lr-tb or table reached in a split tb chain splits too.
  it('splits an lr-tb nested in a split tb', () => {
    const T = tb('T', [drwN('top', 100, 30), lrtb('L', draws(6))]);
    expect(realSplit(body([area([ca(100)])], [kid('A', 40), T])))
      .toEqual(['0:A,T(top,L(d1,d2,d3))', '0:T(L(d4,d5,d6))']);
  });

  // Rule 7: a straddling item that is itself a splittable subform is not split yet.
  it('refuses a straddling lr-tb item that is a splittable subform, naming 164g.25', () => {
    const S = tb('S', [drwN('s1', 100, 20), drwN('s2', 100, 20)]);
    const r = realRefusals(body([area([ca(100)])], [kid('A', 50), lrtb('L', [...draws(3), S])]));
    expect(r[0]).toEqual(['S', 'S: an lr-tb item that is itself a splittable subform is not split across content areas (164g.25)']);
  });

  // p. 295 on a row: placed past the boundary when nothing it draws lies past,
  // refused otherwise.
  it('takes the p. 295 rule for a row taller than an empty region', () => {
    const empty: LayoutNode = { kind: 'subform', label: 'E', layout: 'position', geom: { w: '100pt', h: '150pt' }, children: [] };
    const T = tableN('T', '100pt', [rowN('r1', [drwN('a', 100, 50)]), rowN('r2', [empty])]);
    expect(realSplit(body([area([ca(100)])], [T]))).toEqual(['0:T(r1)', '0:T(r2)']);
    const U = tableN('U', '100pt', [rowN('r1', [drwN('a', 100, 50)]), rowN('r2', [drwN('b', 100, 150)])]);
    expect(realRefusals(body([area([ca(100)])], [U]))[0])
      .toEqual(['r2', `r2: does not fit an empty content area and would need ${SPLIT_LATER}`]);
  });

  it('refuses an <overflow> lr-tb or table that would continue (164g.15)', () => {
    const L = lrtb('L', draws(6), { overflow: true });
    const r = realRefusals(body([area([ca(100)])], [kid('A', 50), L]));
    expect(r[0]).toEqual(['d4', expect.stringMatching(/^L: its <overflow> leader or trailer .*\(164g\.15\)$/) as unknown as string]);
    const T = tableN('T', '100pt', [1, 2, 3].map((i) => rowN(`r${String(i)}`, [drwN(`c${String(i)}`, 100, 30)])), { overflow: true });
    expect(realRefusals(body([area([ca(100)])], [kid('A', 50), T]))[0][1]).toMatch(/^T: its <overflow> .*\(164g\.15\)$/);
  });

  it('places an lr-tb or table kept intact whole', () => {
    expect(realSplit(body([area([ca(100)])], [kid('A', 50), lrtb('L', draws(6), { keep: { intact: 'contentArea' } })])))
      .toEqual(['0:A', '0:L(d1,d2,d3,d4,d5,d6)']);
    const T = tableN('T', '100pt', [1, 2, 3].map((i) => rowN(`r${String(i)}`, [drwN(`c${String(i)}`, 100, 30)])),
      { keep: { intact: 'contentArea' } });
    expect(realSplit(body([area([ca(100)])], [kid('A', 50), T]))).toEqual(['0:A', '0:T(r1,r2,r3)']);
  });

  // Review Focus 2: neither a margin nor a hidden item makes a fragment alone.
  it('never leaves a fragment holding only margins or a hidden item', () => {
    const L = lrtb('L', [drwN('h', 100, 30, { presence: 'hidden' }), ...draws(3)], { margin: { topInset: '30pt' } });
    expect(realSplit(body([area([ca(100)])], [kid('A', 50), L]))).toEqual(['0:A', '0:L(h,d1,d2,d3)']);
    const M = lrtb('M', [...draws(3), drwN('h', 100, 30, { presence: 'hidden' }), ...draws(3).map((d) => ({ ...d, label: `e${d.label}` }))]);
    // A hidden item AFTER visible ones joins their region, as in 164g.8.
    expect(realSplit(body([area([ca(100)])], [kid('A', 50), M]))).toEqual(['0:A,M(d1,d2,d3,h)', '0:M(ed1,ed2,ed3)']);
  });

  // Final review, Important 1: a hidden leaf leading a NESTED container rides
  // (since 164g.13 the 60pt v2 then splits, 40 + 20, where it overflowed before)
  // with the next visible leaf, so the container never becomes a fragment
  // holding only margins past the content-area bottom.
  it('carries a hidden leaf leading a nested container into the region of its next visible leaf', () => {
    const T = tb('T', [fldN('h', 50, 30, { presence: 'hidden' }), fldN('v2', 50, 60)], { margin: { topInset: '30pt', bottomInset: '30pt' } });
    const R = tb('R', [fldN('v1', 50, 60), T]);
    expect(realSplit(body([area([ca(100)])], [fldN('A', 50, 10), R]))).toEqual(['0:A,R(v1)', '0:R(T(h,v2))', '0:R(T(v2))']);
  });

  // Final review, Important 2: a hidden leaf pending when the split fails is
  // reported with its own presence reason, not left on no page.
  it('reports a pending hidden leaf with its presence reason when the split fails', () => {
    const R = tb('R', [kid('h', 30, { presence: 'hidden' }),
      kid('v', 30, { breakBefore: { targetType: 'pageArea', startNew: true, target: '#nope' } })]);
    const r = paginate(body([area([ca(100)])], [kid('A', 90), R]), flowHeight);
    const h = R.children[0];
    expect(r.refused.get(h)).toBe('presence="hidden" takes no space in the layout');
  });

  // Review Focus 3: re-measuring per leaf stays linear in calls.
  it('measures a long table a bounded number of times', () => {
    let calls = 0;
    const counted: XfaHeight = (n, limit) => { calls += 1; return real(n, limit); };
    const rows = Array.from({ length: 400 }, (_, i) => rowN(`r${String(i)}`, [drwN(`c${String(i)}`, 100, 10)]));
    const r = paginate(body([area([ca(720)])], [kid('A', 50), tableN('T', '100pt', rows)]), counted, layoutHooks());
    expect(r.pages.length).toBe(6);
    expect(calls).toBeLessThan(400 * 2 + 20);
  });
});

describe('paginate: filling content areas (XFA 3.3 p. 288, 294)', () => {
  it('stacks children into one content area while they fit', () => {
    expect(pages(body([area([ca(100)])], [kid('A', 40), kid('B', 40)]))).toEqual([[0, '0:A,B']]);
  });

  it('moves a child that does not fit WHOLE to a new page', () => {
    expect(pages(body([area([ca(100)])], [kid('A', 60), kid('B', 60)]))).toEqual([[0, '0:A'], [0, '0:B']]);
  });

  it('fills the next content area before starting a page', () => {
    expect(pages(body([area([ca(100), ca(100)])], [kid('A', 60), kid('B', 60), kid('C', 60)])))
      .toEqual([[0, '0:A', '1:B'], [0, '0:C']]);
  });

  it('takes a presence="hidden" child, which takes no space, where it stands', () => {
    expect(pages(body([area([ca(100)])], [kid('H', 1000, { presence: 'hidden' }), kid('A', 40)])))
      .toEqual([[0, '0:H,A']]);
  });
});

describe('paginate: the p. 295 override', () => {
  // fw9: a page subform 0.003pt taller than its content area, nothing drawn past it.
  it('places a child too tall for an EMPTY content area when nothing it draws lies past it', () => {
    expect(pages(body([area([ca(100)])], [kid('A', 110), kid('B', 10)]))).toEqual([[0, '0:A'], [0, '0:B']]);
  });

  it('refuses one whose content lies past the boundary, and every child after it', () => {
    const b = body([area([ca(100)])], [kid('A!', 110), kid('B', 10)]);
    const r = refusals(b);
    expect(r[0]).toEqual(['A!', 'A!: does not fit an empty content area and would need splitting a field between its lines or a subform beyond its children (164g.13, 164g.19)']);
    expect(r[1][0]).toBe('B');
    expect(r[1][1]).toMatch(AFTER);
  });

  // Review Focus 5: p. 295 overrides only when the NEXT region cannot hold it either.
  it('moves on to a taller next content area rather than overriding a short one', () => {
    expect(pages(body([area([ca(100), ca(200)])], [kid('A', 150)]))).toEqual([[0, '1:A']]);
  });

  it('overrides when the next content area is no taller', () => {
    expect(pages(body([area([ca(200), ca(100)])], [kid('A', 250)]))).toEqual([[0, '0:A']]);
  });
});

describe('paginate: the start point (p. 296) and breaks (p. 269-270, 360-365)', () => {
  // The recorded spec conflict: Example 9.22 shows a blank first page; the
  // start-point rule and both oracles do not.
  it('opens no blank first page for the first child\'s startNew break', () => {
    const b = body([area([ca(100)])], [kid('A', 10, { breakBefore: pb({ startNew: true }) }),
      kid('B', 10, { breakBefore: pb({ startNew: true }) })]);
    expect(pages(b)).toEqual([[0, '0:A'], [0, '0:B']]);
  });

  it('starts on the page area the first child\'s break targets', () => {
    const b = body([area([ca(100)], { name: 'P1' }), area([ca(100)], { name: 'P2' })],
      [kid('A', 10, { breakBefore: pb({ target: 'P2' }) })]);
    expect(pages(b)).toEqual([[1, '0:A']]);
  });

  it('lets the ROOT\'s own break choose the start, over the first child\'s', () => {
    const b = body([area([ca(100)], { name: 'P1' }), area([ca(100)], { name: 'P2' })],
      [kid('A', 10)], { rootBreak: pb({ target: 'P2' }) });
    expect(pages(b)).toEqual([[1, '0:A']]);
  });

  // p. 296 rule 2 applies only "Else": when the ROOT's break chose the start,
  // the first child's break is an ordinary break on entry and still runs.
  // Dropping it puts A on the root's page area, the wrong one, in silence.
  it('still applies the first child\'s break when the root\'s chose the start', () => {
    const b = body([area([ca(100)], { name: 'P1' }), area([ca(100)], { name: 'P2' })],
      [kid('A', 10, { breakBefore: pb({ target: 'P2' }) }), kid('B', 10)], { rootBreak: pb({ target: 'P1' }) });
    expect(pages(b)).toEqual([[0], [1, '0:A,B']]);
  });

  it('resolves a #target by XML id', () => {
    const b = body([area([ca(100)], { name: 'P1' }), area([ca(100)], { id: 'pa2' })],
      [kid('A', 10, { breakBefore: pb({ target: '#pa2' }) })]);
    expect(pages(b)).toEqual([[1, '0:A']]);
  });

  // f1040's shape.
  it('breaks to each named page area in turn', () => {
    const b = body([area([ca(792)], { name: 'P1' }), area([ca(792)], { name: 'P2' })],
      [kid('A', 792, { breakBefore: pb({ target: 'P1' }) }), kid('B', 792, { breakBefore: pb({ target: 'P2' }) })]);
    expect(pages(b)).toEqual([[0, '0:A'], [1, '0:B']]);
  });

  it('stays in the current page area when startNew is 0 and it already matches', () => {
    const b = body([area([ca(100)], { name: 'P1' })],
      [kid('A', 40, { breakBefore: pb({ target: 'P1' }) }), kid('B', 40, { breakBefore: pb({ target: 'P1' }) })]);
    expect(pages(b)).toEqual([[0, '0:A,B']]);
  });

  it('starts a new instance when startNew is 1', () => {
    const b = body([area([ca(100)], { name: 'P1' })],
      [kid('A', 40), kid('B', 40, { breakBefore: pb({ target: 'P1', startNew: true }) })]);
    expect(pages(b)).toEqual([[0, '0:A'], [0, '0:B']]);
  });

  it('honours a breakAfter', () => {
    const b = body([area([ca(100)])], [kid('A', 10, { breakAfter: pb() }), kid('B', 10)]);
    expect(pages(b)).toEqual([[0, '0:A'], [0, '0:B']]);
  });

  it('moves to the next content area on a contentArea break', () => {
    const b = body([area([ca(100), ca(100)])], [kid('A', 10), kid('B', 10, { breakBefore: cb() })]);
    expect(pages(b)).toEqual([[0, '0:A', '1:B']]);
  });

  it('moves to a named content area, on a new page when it lies behind', () => {
    const b = body([area([ca(100, { name: 'L' }), ca(100, { name: 'R' })])], [
      kid('A', 10), kid('B', 10, { breakBefore: cb({ target: 'R' }) }), kid('C', 10, { breakBefore: cb({ target: 'L' }) }),
    ]);
    expect(pages(b)).toEqual([[0, '0:A', '1:B'], [0, '0:C']]);
  });
});

describe('paginate: occurrence limits (p. 296-300)', () => {
  it('moves to the next page area once one\'s max is spent', () => {
    const b = body([area([ca(100)], { max: 1 }), area([ca(100)])], [kid('A', 60), kid('B', 60), kid('C', 60)]);
    expect(pages(b)).toEqual([[0, '0:A'], [1, '0:B'], [1, '0:C']]);
  });

  it('discards what lies past every limit, and says so', () => {
    const b = body([area([ca(100)], { max: 2 })], [kid('A', 60), kid('B', 60), kid('C', 60)], { max: 1 });
    expect(pages(b)).toEqual([[0, '0:A'], [0, '0:B']]);
    expect(refusals(b)).toEqual([['C', "content past every pageArea's occur max is discarded (XFA 3.3 p. 300)"]]);
  });

  it('reuses the current page area before opening a new page-set instance', () => {
    const b = body([area([ca(100)])], [kid('A', 60), kid('B', 60)], { max: 1 });
    expect(pages(b)).toEqual([[0, '0:A'], [0, '0:B']]);
  });

  // Ordered occurrence moves FORWARD: P1 still has an instance to spare, but
  // reaching it again needs a new page-set instance, which max 1 forbids.
  it('never moves backward within a page-set instance', () => {
    const b = body([area([ca(100)], { name: 'P1', max: 2 }), area([ca(100)], { name: 'P2', max: 1 })], [
      kid('A', 10, { breakBefore: pb({ target: 'P1' }) }), kid('B', 10, { breakBefore: pb({ target: 'P2' }) }),
      kid('C', 10, { breakBefore: pb({ target: 'P1' }) }),
    ], { max: 1 });
    expect(refusals(b)).toEqual([['C', "content past every pageArea's occur max is discarded (XFA 3.3 p. 300)"]]);
  });

  it('opens a new page-set instance to reach an EARLIER page area', () => {
    const b = body([area([ca(100)], { name: 'P1', max: 1 }), area([ca(100)], { name: 'P2', max: 1 })], [
      kid('A', 10, { breakBefore: pb({ target: 'P1' }) }), kid('B', 10, { breakBefore: pb({ target: 'P2' }) }),
      kid('C', 10, { breakBefore: pb({ target: 'P1' }) }),
    ]);
    expect(pages(b)).toEqual([[0, '0:A'], [1, '0:B'], [0, '0:C']]);
  });

  it('reports each page\'s page-set instance (d3mq)', () => {
    const b = body([area([ca(100)], { name: 'P1', max: 1 }), area([ca(100)], { name: 'P2', max: 1 })], [
      kid('A', 10, { breakBefore: pb({ target: 'P1' }) }), kid('B', 10, { breakBefore: pb({ target: 'P2' }) }),
      kid('C', 10, { breakBefore: pb({ target: 'P1' }) }),
    ]);
    expect(paginate(b, height).pages.map((p) => [p.pageArea, p.pageSet])).toEqual([[0, 0], [1, 0], [0, 1]]);
    expect(layoutPages(b).pages.map((p) => [p.pageArea, p.pageSet])).toEqual([[0, 0], [1, 0], [0, 1]]);
  });

  it('emits a page area with no content area as an empty page, reading its max -1 as 1', () => {
    const b = body([area([], { name: 'Cover' }), area([ca(100)])], [kid('A', 10)]);
    const r = paginate(b, height);
    expect(pages(b)).toEqual([[0], [1, '0:A']]);
    expect(r.warnings).toEqual([expect.stringMatching(/Cover.*p\. 298/) as unknown as string]);
  });
});

describe('paginate: refusals, by name', () => {
  const two = [kid('A', 10), kid('B', 10)];
  const all = (b: XfaBody) => refusals(b).map(([, w]) => w);

  it('refuses a body with no pageSet', () => {
    const b: XfaBody = { root: { kind: 'subform', label: 'r', layout: 'tb', geom: {}, children: two } };
    expect(all(b)).toEqual([expect.stringMatching(/declares no <pageSet>/), expect.stringMatching(/declares no <pageSet>/)]);
  });

  it('refuses a root that is not tb', () => {
    expect(all(body([area([ca(100)])], two, { rootLayout: 'position' }))[0]).toMatch(/layout "position" is not paginated \(only tb\)/);
  });

  it('paginates a qualified pagination relation rather than refusing it (164g.9)', () => {
    expect(all(body([area([ca(100)])], two, { relation: 'simplexPaginated' }))).toEqual([]);
  });

  it('passes the page set\'s own refusal through', () => {
    expect(all(body([area([ca(100)])], two, { refusal: 'X' }))).toEqual(['X', 'X']);
  });

  it('refuses a page set with no content area at all', () => {
    expect(all(body([area([])], two))[0]).toMatch(/no pageArea declares a contentArea/);
  });

  it('refuses a content area that states no height', () => {
    expect(all(body([area([ca(undefined, { name: 'C1' })])], two))[0]).toMatch(/contentArea C1 states no readable h/);
  });

  it('refuses a break the template could not model, and every child after it', () => {
    const r = refusals(body([area([ca(100)])], [kid('A', 10), kid('B', 10, { breakBefore: pb({ refusal: 'B: no' }) }), kid('C', 10)]));
    expect(r.map(([l]) => l)).toEqual(['B', 'C']);
    expect(r[0][1]).toBe('B: no');
    expect(r[1][1]).toMatch(AFTER);
  });

  it('refuses a target naming nothing, or more than one', () => {
    const none = body([area([ca(100)], { name: 'P1' })], [kid('A', 10), kid('B', 10, { breakBefore: pb({ target: 'Nowhere' }) })]);
    expect(refusals(none)[0]).toEqual(['B', 'break target "Nowhere" names no pageArea']);
    const twice = body([area([ca(100)], { name: 'P' }), area([ca(100)], { name: 'P' })],
      [kid('A', 10), kid('B', 10, { breakBefore: pb({ target: 'P' }) })]);
    expect(refusals(twice)[0]).toEqual(['B', 'break target "P" names more than one pageArea']);
  });

  // Review Focus 4.
  it('refuses a target written as a SOM expression rather than resolving it', () => {
    for (const t of ['$form.P1', 'a.b', 'P1[0]']) {
      const b = body([area([ca(100)], { name: 'P1' })], [kid('A', 10), kid('B', 10, { breakBefore: pb({ target: t }) })]);
      expect(refusals(b)[0], t).toEqual(['B', `break target "${t}" is a SOM expression, which is not resolved`]);
    }
  });

  it('refuses a child whose height cannot be measured, and every child after it', () => {
    const h: XfaHeight = (n) => (n.label === 'A' ? { reason: 'A: no size' } : { h: 10, past: false });
    const r = [...paginate(body([area([ca(100)])], [kid('A', 10), kid('B', 10)]), h).refused].map(([n, w]) => [n.label, w]);
    expect(r[0]).toEqual(['A', 'A: no size']);
    expect(r[1][1]).toMatch(AFTER);
  });
});

describe('layoutPages', () => {
  const S: XfaRawGeom = { w: '10pt', h: '10pt' };
  const fld = (label: string, geom: XfaRawGeom): LayoutNode => ({ kind: 'field', label, field: label, geom, children: [] });
  const placedBox = (m: Map<string, Placed>, n: string) => {
    const p = m.get(n);
    if (!p || 'reason' in p) throw new Error(`${n}: ${p ? p.reason : 'none'}`);
    return p.box;
  };
  const caAt = (h: number): XfaContentArea => ({
    node: { kind: 'page', label: 'contentArea', layout: 'tb', geom: { x: '10pt', y: '20pt', w: '500pt', h: `${String(h)}pt` }, children: [] },
  });

  it('lays each page out from its content area\'s origin', () => {
    const r = layoutPages(body([area([caAt(100)])], [
      kid('P', 60, { children: [fld('a', { x: '1pt', y: '2pt', ...S })] }),
      kid('Q', 60, { children: [fld('b', { x: '1pt', y: '2pt', ...S })] }),
    ]));
    expect(r.pages.map((p) => p.pageArea)).toEqual([0, 0]);
    expect(placedBox(r.pages[0].placed, 'a')).toEqual({ x: 11, y: 22, w: 10, h: 10 });
    expect(placedBox(r.pages[1].placed, 'b')).toEqual({ x: 11, y: 22, w: 10, h: 10 });
    expect(r.refused.size).toBe(0);
  });

  it('gives every field under a refused child that child\'s reason', () => {
    const r = layoutPages(body([area([caAt(100)])], [kid('P', 150, { children: [fld('c', { y: '120pt', ...S })] })]));
    expect(r.refused.get('c')).toMatch(/would need splitting a field between its lines or a subform beyond its children/);
  });

  // bkdi: a root child is laid out in the content area's tb flow, so its
  // container min* does not apply -- and pagination must measure it the same
  // way, or it moves Q to a second page that layout never needed.
  it('measures a root child as the content area tb flow lays it out', () => {
    const g: LayoutNode = {
      kind: 'subform', label: 'G', layout: 'tb', geom: { w: '100pt' },
      children: [fld('a', { w: '10pt', h: '30pt' })], minMax: { minH: '300pt' },
    };
    const r = layoutPages(body([area([caAt(100)])], [g, kid('Q', 20, { children: [fld('b', S)] })]));
    expect(r.refused.size).toBe(0);
    expect(r.pages.map((p) => p.pageArea)).toEqual([0]);
    expect(placedBox(r.pages[0].placed, 'b')).toEqual({ x: 10, y: 50, w: 10, h: 10 });
  });

  // 164g.8: fragments carry their fields; a refusal mid-split keeps what was
  // placed and places nothing it refuses.
  it('lays out the fragments of a split, and refuses only from the failure on', () => {
    const t: LayoutNode = {
      kind: 'subform', label: 'T', layout: 'tb', geom: { w: '100pt' }, children: [
        kid('P', 60, { children: [fld('a', S)] }),
        kid('Q', 60, { children: [fld('b', S)] }),
        kid('R', 150, { children: [fld('c', { y: '120pt', ...S })] }),
      ],
    };
    // R is refused at an empty third page, which advancing has already opened.
    const r = layoutPages(body([area([caAt(100)])], [t]));
    expect(placedBox(r.pages[0].placed, 'a')).toEqual({ x: 10, y: 20, w: 10, h: 10 });
    expect(placedBox(r.pages[1].placed, 'b')).toEqual({ x: 10, y: 20, w: 10, h: 10 });
    expect(r.refused.get('c')).toMatch(/would need splitting a field between its lines or a subform beyond its children/);
    expect(r.refused.has('a') || r.refused.has('b')).toBe(false);
  });

  // Review Focus 3.
  it('refuses two fields of one name in two content areas of one page', () => {
    const r = layoutPages(body([area([caAt(100), caAt(100)])], [
      kid('P', 60, { children: [fld('d', S)] }), kid('Q', 60, { children: [fld('d', S)] }),
    ]));
    const p = r.pages[0].placed.get('d');
    expect(p && 'reason' in p ? p.reason : '').toMatch(/two fields share the SOM name d/);
  });
});

// 164g.11: a positioned subform stating keep intact="none" splits where Adobe
// Reader does (test/fixtures/xfa-adobe/). Content area 720 tall; O + F leave 144.
describe('paginate: splitting a keep-none positioned root child (164g.11)', () => {
  const fld = (label: string, y: number, h: number): LayoutNode => ({
    kind: 'field', label, field: `pos.${label}`, geom: { x: '0pt', y: `${String(y)}pt`, w: '100pt', h: `${String(h)}pt` },
    children: [], text: { paras: [{ base: { size: 10 } }] } as unknown as LeafText,
  });
  const drw = (label: string, y: number, h: number): LayoutNode =>
    ({ kind: 'draw', label, geom: { x: '0pt', y: `${String(y)}pt`, w: '100pt', h: `${String(h)}pt` }, children: [] });
  const P = (h: number | undefined, children: LayoutNode[], extra: Partial<LayoutNode> = {}): LayoutNode => ({
    kind: 'subform', label: 'P', layout: 'position', geom: h === undefined ? { w: '540pt' } : { w: '540pt', h: `${String(h)}pt` },
    keep: { intact: 'none' }, children, ...extra,
  });
  const posBoxes: XfaChildBoxes = (n) => n.children
    .filter((k) => k.presence !== 'hidden' && k.presence !== 'inactive')
    .map((k) => ({ node: k, top: pt(k.geom.y), h: hOf(k) }));
  // A growable positioned subform's height is its lowest child's bottom.
  const posHeight: XfaHeight = (n) => (n.layout === 'position' && n.geom.h === undefined
    ? { h: Math.max(0, ...n.children.map((k) => pt(k.geom.y) + hOf(k))), past: false } : flowHeight(n, Infinity));
  const lead = [kid('O', 216), kid('F', 360)];
  const run = (kids: LayoutNode[], b = body([area([ca(720)])], kids)) => paginate(b, posHeight, { boxes: posBoxes });
  const regions = (kids: LayoutNode[], b?: XfaBody) => run(kids, b).pages.map((p) => p.contentAreas.map((c) => c.children
    .map((k) => (k.label === 'P' ? `P:${k.geom.h ?? ''}(${k.children.map((x) => `${x.label}@${x.geom.y ?? ''}`).join(',')})` : k.label))
    .join(' ')).join('|'));

  it('puts the top into the room left and the rest on the next page (t5)', () => {
    expect(regions([...lead, P(288, [fld('a', 36, 21.6), fld('b', 108, 21.6), fld('c', 216, 21.6)])]))
      .toEqual(['O F P:144pt(a@36pt,b@108pt)', 'P:144pt(c@72pt)']);
  });
  it('moves a default positioned subform whole, as before (t3)', () => {
    expect(regions([...lead, P(288, [fld('a', 36, 21.6)], { keep: undefined })])).toEqual(['O F', 'P:288pt(a@36pt)']);
  });
  it('does not split without the boxes callback', () => {
    const r = paginate(body([area([ca(720)])], [...lead, P(288, [fld('a', 36, 21.6)])]), posHeight);
    expect(r.pages.map((p) => p.contentAreas[0].children.map((k) => k.label).join(' '))).toEqual(['O F', 'P']);
  });
  it('splits again while the rest is taller than a page (t15)', () => {
    expect(regions([...lead, P(1800, [fld('f', 100, 20), fld('h', 900, 20), fld('k', 1700, 20)])]))
      .toEqual(['O F P:144pt(f@100pt)', 'P:720pt()', 'P:720pt(h@36pt)', 'P:216pt(k@116pt)']);
  });
  it('moves it whole when the cut reaches the top (t25)', () => {
    expect(regions([...lead, P(288, [drw('dr', 0, 200), fld('g', 250, 20)])])).toEqual(['O F', 'P:288pt(dr@0pt,g@250pt)']);
  });
  it('splits a growable keep-none subform, stating h on each fragment', () => {
    expect(regions([...lead, P(undefined, [fld('a', 36, 20), fld('c', 216, 20)])]))
      .toEqual(['O F P:144pt(a@36pt)', 'P:92pt(c@72pt)']);
  });
  it('splits a field it can split, one piece per fragment (t6)', () => {
    const p = P(288, [fld('a', 36, 21.6), fld('b', 108, 72)]);
    const b = body([area([ca(720)])], [...lead, p, kid('Z', 10)]);
    const r = paginate(b, posHeight, { boxes: posBoxes, fieldLines: () => 0 });
    expect(r.refused.size).toBe(0);
    expect(r.pages.map((pg) => pg.contentAreas[0].children
      .map((k) => (k.label === 'P' ? `P:${k.geom.h ?? ''}(${k.children.map((x) => `${x.label}@${x.geom.y ?? ''}/${x.geom.h ?? ''}`).join(',')})` : k.label))
      .join(' '))).toEqual(['O F P:144pt(a@36pt/21.6pt,b@108pt/36pt)', 'P:144pt(b@0pt/36pt) Z']);
  });
  it('refuses a field split it cannot count the lines of, placing nothing of the subform', () => {
    const p = P(288, [fld('a', 36, 21.6), fld('b', 108, 72)]);
    const r = run([...lead, p, kid('Z', 10)]);
    expect(r.refused.get(p)).toMatch(/^b: its value's wrapped line count is not known/);
    expect(r.pages.map((pg) => pg.contentAreas[0].children.map((k) => k.label).join(' '))).toEqual(['O F']);
  });
  it('refuses a split whose rest has no page left, placing nothing (occur max)', () => {
    const p = P(1000, [fld('a', 36, 20)]);
    const b = body([area([ca(720)], { max: 1 })], [...lead, p], { max: 1 });
    const r = run([], b);
    expect(r.refused.get(p)).toMatch(/discarded/);
    expect(r.pages[0].contentAreas[0].children.map((k) => k.label)).toEqual(['O', 'F']);
  });
  it('refuses a keep-none subform with an <overflow> that would continue (164g.15)', () => {
    const p = P(288, [fld('a', 36, 21.6)], { overflow: true });
    expect(run([...lead, p]).refused.get(p)).toMatch(/164g\.15/);
  });
  it('names 164g.19 when a default positioned subform is taller than an empty page', () => {
    expect(SPLIT_LATER).toMatch(/164g\.19/);
    expect(SPLIT_LATER).not.toMatch(/164g\.11/);
  });
});

describe('layoutPages: a split positioned subform (164g.11)', () => {
  const fld = (label: string, y: number, h: number): LayoutNode => ({
    kind: 'field', label, field: label, geom: { x: '0pt', y: `${String(y)}pt`, w: '100pt', h: `${String(h)}pt` }, children: [],
  });
  it("lays each fragment's fields out on its own page (t24's nesting)", () => {
    const inner: LayoutNode = { kind: 'subform', label: 'inner', layout: 'position', keep: { intact: 'none' },
      geom: { x: '0pt', y: '100pt', w: '216pt', h: '120pt' }, children: [fld('g', 0, 20), fld('k', 80, 20)] };
    const p: LayoutNode = { kind: 'subform', label: 'P', layout: 'position', keep: { intact: 'none' },
      geom: { w: '540pt', h: '288pt' }, children: [inner] };
    const r = layoutPages(body([area([ca(720)])], [kid('O', 216), kid('F', 360), p]));
    expect(r.pages.length).toBe(2);
    expect(r.pages[0].placed.get('g')).toEqual({ box: { x: 0, y: 676, w: 100, h: 20 } });
    expect(r.pages[1].placed.get('k')).toEqual({ box: { x: 0, y: 36, w: 100, h: 20 } });
  });
});

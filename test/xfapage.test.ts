import { describe, it, expect } from 'vitest';
import {
  paginate, layoutPages,
  type XfaBody, type XfaPageAreaModel, type XfaContentArea, type XfaHeight,
} from '../src/xfapage.js';
import type { LayoutNode, XfaBreak, Placed } from '../src/xfaflow.js';
import { SPLIT_LATER } from '../src/xfaflow.js';
import type { XfaRawGeom } from '../src/xfageom.js';

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
/** A node's height: a stated h, else its margins plus its children's heights.
 *  A label ending in '!' draws past any limit. */
const hOf = (n: LayoutNode): number => (n.geom.h !== undefined ? pt(n.geom.h)
  : pt(n.margin?.topInset) + pt(n.margin?.bottomInset)
    + n.children.filter((k) => k.presence !== 'hidden').reduce((s, k) => s + hOf(k), 0));
const flowHeight: XfaHeight = (n) => ({ h: hOf(n), past: n.label.endsWith('!') });
/** A region's children as nested labels: a fragment shows what it holds. */
const shape = (n: LayoutNode): string =>
  (n.layout === 'tb' && n.geom.h === undefined ? `${n.label}(${n.children.map(shape).join(',')})` : n.label);
const split = (b: XfaBody) => paginate(b, flowHeight).pages.map((p) =>
  p.contentAreas.map((c) => `${String(c.index)}:${c.children.map(shape).join(',')}`).join(' '));
const splitRefusals = (b: XfaBody) => [...paginate(b, flowHeight).refused].map(([n, w]) => [n.label, w]);

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

  // p. 291: no split inside a margin. The bottom margin travels with c.
  it('keeps the bottom margin with the last child', () => {
    const t = tb('T', [kid('a', 40), kid('b', 40), kid('c', 10)], { margin: { topInset: '10pt', bottomInset: '10pt' } });
    const r = paginate(body([area([ca(100)])], [t]), flowHeight);
    expect(split(body([area([ca(100)])], [t]))).toEqual(['0:T(a,b)', '0:T(c)']);
    const [f1, f2] = r.pages.map((p) => p.contentAreas[0].children[0]);
    expect([f1.margin?.topInset, f1.margin?.bottomInset]).toEqual(['10pt', undefined]);
    expect([f2.margin?.topInset, f2.margin?.bottomInset]).toEqual([undefined, '10pt']);
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
    expect(splitRefusals(big(kid('K', 60, { keep: { intact: 'pageArea' } })))[0][1]).toMatch(/keep intact="pageArea" .*\(164g\.14\)/);
    expect(splitRefusals(big(kid('N', 60, { keep: { next: 'contentArea' } })))[0][1]).toMatch(/adhesion.*\(164g\.14\)/);
    // An <overflow> container that continues into a second region needs its
    // leader or trailer inserted there.
    const r = splitRefusals(big(kid('O', 60), { overflow: true }));
    expect(r[0]).toEqual(['O', expect.stringMatching(/T!: its <overflow> leader or trailer .*\(164g\.15\)/) as unknown as string]);
  });

  // Final review, Important 1: before 164g.8 a child that did not fit the room
  // left moved whole to the next region. A chain 164g.8 cannot split (here a
  // keep-with-next, which Designer writes routinely) must still do that, not be
  // refused with every root child after it.
  it('places whole, as before, a child whose chain it cannot split but which fits an empty region', () => {
    const b = body([area([ca(100)])], [kid('A', 50), tb('T', [kid('a', 30, { keep: { next: 'contentArea' } }), kid('b', 30)])]);
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
    expect(r[0]).toEqual(['A!', 'A!: does not fit an empty content area and would need splitting beyond a tb subform between its children (164g.11, 164g.12, 164g.13)']);
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

  it('refuses a qualified pagination relation', () => {
    expect(all(body([area([ca(100)])], two, { relation: 'simplexPaginated' }))[0]).toMatch(/simplexPaginated.*164g\.9/);
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
    expect(r.refused.get('c')).toMatch(/would need splitting beyond a tb subform/);
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
    expect(r.refused.get('c')).toMatch(/would need splitting beyond a tb subform/);
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

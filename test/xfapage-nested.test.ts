import { describe, it, expect } from 'vitest';
import { paginate, type XfaBody, type XfaHeight, type XfaPageAreaModel, type XfaPageSetNode } from '../src/xfapage.js';
import type { LayoutNode, XfaBreak } from '../src/xfaflow.js';

/**
 * Nested page sets (164g.22), hand-built: the set tree beside the flat page-area
 * list. Adobe Reader is the oracle for the shapes `test/fixtures/xfa-adobe/`
 * n1-n10 cover; these cases pin rules no probe reaches on its own.
 */
const kid = (label: string, h: number, extra: Partial<LayoutNode> = {}): LayoutNode =>
  ({ kind: 'subform', label, layout: 'position', geom: { w: '10pt', h: `${String(h)}pt` }, children: [], ...extra });
const area = (name: string, set: number, extra: Partial<XfaPageAreaModel> = {}): XfaPageAreaModel => ({
  name, id: name, max: -1, set,
  contentAreas: [{ node: { kind: 'page', label: 'ca', layout: 'tb', geom: { w: '100pt', h: '100pt' }, children: [] } }],
  ...extra,
});
const brk = (target: string): XfaBreak => ({ targetType: 'pageArea', target: `#${target}`, startNew: true });
const body = (areas: XfaPageAreaModel[], sets: XfaPageSetNode[], kids: LayoutNode[]): XfaBody => ({
  root: { kind: 'subform', label: 'root', layout: 'tb', geom: {}, children: kids },
  pageSet: { relation: sets[0].relation, max: sets[0].max, pageAreas: areas, sets },
});
const height: XfaHeight = (n) => ({ h: Number((n.geom.h ?? '0pt').replace('pt', '')), past: false });
const run = (b: XfaBody) => paginate(b, height);
const seq = (b: XfaBody) => run(b).pages.map((p) => `${b.pageSet!.pageAreas[p.pageArea].name!}${p.blank ? '*' : ''}`);
const pages = (n: number) => Array.from({ length: n }, (_, i) => kid(`k${String(i)}`, 100));
const O = 'orderedOccurrence';
const S = 'simplexPaginated';

describe('paginate: nested ordered page sets (164g.22)', () => {
  // n1 (Example 8.31), from hand-built nodes.
  it('ascends through occurrence limits and discards past the root', () => {
    const areas = [area('A', 0, { max: 1 }), area('B', 1, { max: 1 }), area('C', 1, { max: 2 })];
    const sets: XfaPageSetNode[] = [
      { relation: O, max: 1, children: [{ area: 0 }, { set: 1 }] },
      { relation: O, max: 2, parent: 0, children: [{ area: 1 }, { area: 2 }] },
    ];
    const b = body(areas, sets, pages(9));
    expect(seq(b)).toEqual(['A', 'B', 'C', 'C', 'B', 'C', 'C']);
    expect([...run(b).refused.values()][0]).toBe("content past every pageArea's occur max is discarded (XFA 3.3 p. 300)");
    // Only the first instance of every set on a page's path is instance 0.
    expect(run(b).pages.map((p) => p.pageSet)).toEqual([0, 0, 0, 0, 1, 1, 1]);
  });
  // A break INTO a nested set enters it as a fresh instance: once its own max
  // is spent, overflow ascends rather than starting it again.
  it('enters a set a forward break reaches as a fresh instance', () => {
    const areas = [area('A', 0), area('B', 1, { max: 1 }), area('C', 0)];
    const sets: XfaPageSetNode[] = [
      { relation: O, max: 1, children: [{ area: 0 }, { set: 1 }, { area: 2 }] },
      { relation: O, max: 1, parent: 0, children: [{ area: 1 }] },
    ];
    const b = body(areas, sets, [kid('s', 100), kid('t', 100, { breakBefore: brk('B') }), kid('u', 100)]);
    expect(seq(b)).toEqual(['A', 'B', 'C']);
  });
  // n7's second half: a break BEHIND the current page area takes a new
  // instance of the lowest common set that has one left.
  it('reaches a page area behind the current one through a new instance', () => {
    const areas = [area('A', 0), area('B', 1)];
    const sets: XfaPageSetNode[] = [
      { relation: O, max: 2, children: [{ area: 0 }, { set: 1 }] },
      { relation: O, max: -1, parent: 0, children: [{ area: 1 }] },
    ];
    const kids = [kid('s', 10), kid('t', 10, { breakBefore: brk('B') }), kid('u', 10, { breakBefore: brk('A') })];
    expect(seq(body(areas, sets, kids))).toEqual(['A', 'B', 'A']);
    const once = body(areas, [{ ...sets[0], max: 1 }, sets[1]], kids);
    expect(seq(once)).toEqual(['A', 'B']);
    expect(run(once).refused.get(kids[2])).toBe("content past every pageArea's occur max is discarded (XFA 3.3 p. 300)");
  });
});

describe('paginate: nested qualified page sets (164g.22)', () => {
  const areas = [
    area('A', 0, { pagePosition: 'first' }), area('B', 0, { pagePosition: 'rest' }), area('C', 0, { pagePosition: 'last' }),
    area('D', 1, { pagePosition: 'first' }), area('E', 1, { pagePosition: 'rest' }), area('F', 1, { pagePosition: 'last' }),
  ];
  const sets: XfaPageSetNode[] = [
    { relation: S, max: -1, children: [{ area: 0 }, { area: 1 }, { area: 2 }, { set: 1 }] },
    { relation: S, max: -1, parent: 0, children: [{ area: 3 }, { area: 4 }, { area: 5 }] },
  ];
  it('terminates the set a break leaves, and the one the document ends in (n4)', () => {
    const b = body(areas, sets, [...pages(2), kid('t0', 100, { breakBefore: brk('D') }), kid('t1', 100)]);
    expect(seq(b)).toEqual(['A', 'C', 'D', 'F']);
  });
  // n8: the inner set is left on its `first` page, so `last` cannot replace it.
  it('appends a blank last page when the left page cannot be redone', () => {
    const b = body(areas, sets, [kid('s', 100), kid('t', 100, { breakBefore: brk('D') }), kid('u', 10, { breakBefore: brk('B') })]);
    // Page 1 is the outer set's `first` page, so it cannot be redone either.
    expect(seq(b)).toEqual(['A', 'C*', 'D', 'F*', 'C']);
  });
  it('chooses a natural page among the current set alone', () => {
    const b = body(areas, sets, [kid('s', 100), kid('t', 100, { breakBefore: brk('D') }), ...pages(2)]);
    expect(seq(b)).toEqual(['A', 'C*', 'D', 'E', 'F']);
  });
});

import { describe, it, expect } from 'vitest';
import {
  paginate, chooseArea,
  type XfaBody, type XfaPageAreaModel, type XfaContentArea, type XfaHeight, type PageState,
} from '../src/xfapage.js';
import type { LayoutNode, XfaBreak } from '../src/xfaflow.js';

// Qualified pagination (164g.9): XFA 3.3 p. 302-308, with the rules the
// specification leaves open settled by Adobe Reader probes in
// test/fixtures/xfa-adobe/adobe-qualified.json.

const kid = (label: string, h: number, extra: Partial<LayoutNode> = {}): LayoutNode =>
  ({ kind: 'subform', label, layout: 'position', geom: { w: '100pt', h: `${String(h)}pt` }, children: [], ...extra });
const ca = (h: number): XfaContentArea => ({
  node: { kind: 'page', label: 'contentArea', layout: 'tb', geom: { w: '500pt', h: `${String(h)}pt` }, children: [] },
});
const area = (name: string, extra: Partial<XfaPageAreaModel> = {}, cas: XfaContentArea[] = [ca(100)]): XfaPageAreaModel =>
  ({ name, max: -1, contentAreas: cas, ...extra });
const body = (relation: string, pageAreas: XfaPageAreaModel[], kids: LayoutNode[], rootBreak?: XfaBreak): XfaBody => ({
  root: { kind: 'subform', label: 'root[0]', layout: 'tb', geom: {}, children: kids, ...(rootBreak ? { breakBefore: rootBreak } : {}) },
  pageSet: { relation, max: -1, pageAreas },
});
const height: XfaHeight = (n) => ({ h: Number((n.geom.h ?? '0pt').replace('pt', '')), past: n.label.endsWith('!') });
/** Page-area names per page; a blank page is suffixed '*'. */
const seq = (b: XfaBody) => paginate(b, height).pages.map((p) => `${b.pageSet!.pageAreas[p.pageArea].name!}${p.blank ? '*' : ''}`);
const refusals = (b: XfaBody) => [...paginate(b, height).refused].map(([n, why]) => [n.label, why]);
const three = () => [kid('a', 100), kid('b', 100), kid('c', 100)];
const S = 'simplexPaginated';
const D = 'duplexPaginated';
const st = (position: 'first' | 'rest', parity: 'odd' | 'even', blank = false): PageState => ({ position, parity, blank });

describe('chooseArea (XFA 3.3 p. 302-304)', () => {
  it('takes the first page area in document order whose pagePosition fits', () => {
    const areas = [area('A', { pagePosition: 'rest' }), area('B', { pagePosition: 'first' }), area('C')];
    expect(chooseArea(areas, st('first', 'odd'), 'simplex')).toBe(1);
    expect(chooseArea(areas, st('rest', 'odd'), 'simplex')).toBe(0);
  });
  it('never matches last or only in normal layout (p. 308)', () => {
    const areas = [area('L', { pagePosition: 'last' }), area('O', { pagePosition: 'only' })];
    expect(chooseArea(areas, st('first', 'odd'), 'duplex')).toBeUndefined();
    expect(chooseArea(areas, st('rest', 'even'), 'duplex')).toBeUndefined();
  });
  it('matches oddOrEven against the parity under duplex', () => {
    const areas = [area('O', { oddOrEven: 'odd' }), area('E', { oddOrEven: 'even' })];
    expect(chooseArea(areas, st('rest', 'even'), 'duplex')).toBe(1);
    expect(chooseArea(areas, st('rest', 'odd'), 'duplex')).toBe(0);
  });
  it('matches blankOrNotBlank against the reason under duplex (p. 303)', () => {
    const areas = [area('N', { blankOrNotBlank: 'notBlank' }), area('B', { blankOrNotBlank: 'blank' })];
    expect(chooseArea(areas, st('rest', 'odd', true), 'duplex')).toBe(1);
    expect(chooseArea(areas, st('rest', 'odd', false), 'duplex')).toBe(0);
  });
  it('ignores blankOrNotBlank under simplex (p. 798)', () => {
    expect(chooseArea([area('B', { blankOrNotBlank: 'blank' })], st('rest', 'odd', false), 'simplex')).toBe(0);
  });
  it('never matches an even-only page area under simplex, every page being odd (probe q3)', () => {
    const areas = [area('E', { oddOrEven: 'even' }), area('C')];
    expect(chooseArea(areas, st('rest', 'odd'), 'simplex')).toBe(1);
  });
});

describe('paginate: qualified selection', () => {
  it('uses the first-qualified area on page 1, then rest (Example 8.25, probe q1)', () => {
    expect(seq(body(S, [area('A', { pagePosition: 'rest' }), area('B', { pagePosition: 'first' })], three()))).toEqual(['B', 'A', 'A']);
  });
  it('alternates odd and even under duplex (Example 8.26, probe q2)', () => {
    const areas = [area('A', { oddOrEven: 'odd', pagePosition: 'rest' }), area('B', { oddOrEven: 'even', pagePosition: 'rest' }), area('C', { pagePosition: 'first' })];
    expect(seq(body(D, areas, [...three(), kid('d', 100)]))).toEqual(['C', 'B', 'A', 'B']);
  });
  it('ignores occur max under qualified pagination (p. 296, probe q14)', () => {
    expect(seq(body(S, [area('A', { max: 1 })], three()))).toEqual(['A', 'A', 'A']);
  });
  it('refuses every child, naming the state, when no page area matches (p. 304, probe q10)', () => {
    expect(refusals(body(S, [area('A', { pagePosition: 'rest' })], [kid('a', 50)]))).toEqual([
      ['a', 'no pageArea matches position=first parity=odd blank=false (XFA 3.3 p. 304)'],
    ]);
  });
  it('starts on a break target whatever its qualifiers (p. 296, 310)', () => {
    const b = body(S, [area('A', { pagePosition: 'rest' }), area('B', { pagePosition: 'first' })],
      [kid('a', 100)], { targetType: 'pageArea', target: 'A', startNew: false });
    expect(seq(b)).toEqual(['A']);
  });
  it('emits a qualified boilerplate cover page, then continues (p. 296)', () => {
    expect(seq(body(S, [area('C', { pagePosition: 'first' }, []), area('A', { pagePosition: 'rest' })], [kid('a', 100)]))).toEqual(['C', 'A']);
  });
  it('refuses a boilerplate page area that would repeat forever', () => {
    const r = refusals(body(S, [area('B', { pagePosition: 'first' }), area('X', { pagePosition: 'rest' }, [])], [kid('a', 100), kid('b', 100)]));
    expect(r[0]).toEqual(['b', 'pageArea X has no contentArea and qualifies for every later page, so it would repeat without end (XFA 3.3 p. 296)']);
  });
  it('leaves the ordered relation exactly as it was', () => {
    expect(seq(body('orderedOccurrence', [area('A', { pagePosition: 'rest', max: 1 }), area('B')], three()))).toEqual(['A', 'B', 'B']);
  });
});

const brk = (targetType: string, extra: Partial<XfaBreak> = {}): XfaBreak => ({ targetType, startNew: false, ...extra });
const NEVER_EVEN = 'a pageEven break can never be met: outside duplexPaginated every page is a front (odd) surface (Adobe probes q12, q15)';

describe('paginate: pageEven and pageOdd breaks (XFA 3.3 p. 296, 305)', () => {
  it('under ordered pagination takes the very next page for pageOdd, every page being odd (probe q11)', () => {
    const b = body('orderedOccurrence', [area('A')], [kid('a', 20), kid('b', 20, { breakBefore: brk('pageOdd', { startNew: true }) })]);
    expect(seq(b)).toEqual(['A', 'A']);
  });
  it('stays on a page of the right parity when startNew is 0', () => {
    const b = body('orderedOccurrence', [area('A')], [kid('a', 20), kid('b', 20, { breakBefore: brk('pageOdd') })]);
    expect(seq(b)).toEqual(['A']);
    expect(refusals(b)).toEqual([]);
  });
  it('refuses pageEven under ordered pagination, where no page is even (probe q15)', () => {
    const b = body('orderedOccurrence', [area('A')], [kid('a', 20), kid('b', 20, { breakBefore: brk('pageEven') })]);
    expect(refusals(b)).toEqual([['b', NEVER_EVEN]]);
  });
  it('refuses pageEven under simplex, where no page is even (probe q12)', () => {
    const b = body(S, [area('A')], [kid('a', 20), kid('b', 20, { breakBefore: brk('pageEven') })]);
    expect(refusals(b)).toEqual([['b', NEVER_EVEN]]);
  });
  it('under duplex reaches the next even page without a filler', () => {
    const b = body(D, [area('A')], [kid('a', 20), kid('b', 20, { breakBefore: brk('pageEven') })]);
    expect(seq(b)).toEqual(['A', 'A']);
  });
  it('under duplex takes the filler from a blank-qualified area (probe q13)', () => {
    const areas = [area('C', { pagePosition: 'first' }), area('A', { pagePosition: 'rest', blankOrNotBlank: 'notBlank' }), area('F', { pagePosition: 'rest', blankOrNotBlank: 'blank' })];
    expect(seq(body(D, areas, [kid('a', 20), kid('b', 20, { breakBefore: brk('pageOdd', { startNew: true }) })]))).toEqual(['C', 'F*', 'A']);
  });
  it('under duplex breakAfter pageOdd fills an even page (Example 8.27, probe q4)', () => {
    const areas = [area('C', { pagePosition: 'first' }), area('A', { oddOrEven: 'odd', pagePosition: 'rest' }), area('B', { oddOrEven: 'even', pagePosition: 'rest' })];
    const b = body(D, areas, [kid('o', 100), kid('y0', 100), kid('y1', 100, { breakAfter: brk('pageOdd', { startNew: true }) }), kid('z', 100)]);
    expect(seq(b)).toEqual(['C', 'B', 'A', 'B*', 'A']);
  });
  it('under duplex inserts a filler before a break target of the other parity (p. 305)', () => {
    const areas = [area('C', { pagePosition: 'first' }), area('O', { oddOrEven: 'odd', pagePosition: 'rest' }), area('E', { oddOrEven: 'even', pagePosition: 'rest' })];
    const b = body(D, areas, [kid('a', 20), kid('b', 20, { breakBefore: brk('pageArea', { target: 'O' }) })]);
    expect(seq(b)).toEqual(['C', 'E*', 'O']);
  });
  it('refuses a break to a page area qualified blank (p. 310)', () => {
    const areas = [area('C', { pagePosition: 'first' }), area('F', { pagePosition: 'rest', blankOrNotBlank: 'blank' })];
    expect(refusals(body(D, areas, [kid('a', 20), kid('b', 20, { breakBefore: brk('pageArea', { target: 'F' }) })]))).toEqual([
      ['b', 'break target "F" is a pageArea qualified blankOrNotBlank="blank", which no break may name (XFA 3.3 p. 310)'],
    ]);
  });
  it('refuses a start on a page area qualified blank (p. 310)', () => {
    const areas = [area('C', { pagePosition: 'first' }), area('F', { blankOrNotBlank: 'blank' })];
    expect(refusals(body(D, areas, [kid('a', 20)], brk('pageArea', { target: 'F' })))).toEqual([
      ['a', 'break target "F" is a pageArea qualified blankOrNotBlank="blank", which no break may name (XFA 3.3 p. 310)'],
    ]);
  });
});

describe('paginate: termination (XFA 3.3 p. 306-308)', () => {
  it('redoes the final page on the last area when it fits (Example 8.28, probe q5)', () => {
    expect(seq(body(S, [area('A'), area('B', { pagePosition: 'last' })], three()))).toEqual(['A', 'A', 'B']);
  });
  it('prefers only over first for a single page (Example 8.29, probe q6)', () => {
    const areas = [area('A', { pagePosition: 'first' }), area('B'), area('C', { pagePosition: 'last' }), area('D', { pagePosition: 'only' })];
    expect(seq(body(S, areas, [kid('a', 60)]))).toEqual(['D']);
  });
  it('uses first, rest and last across several pages (probe q7)', () => {
    const areas = [area('A', { pagePosition: 'first' }), area('B'), area('C', { pagePosition: 'last' }), area('D', { pagePosition: 'only' })];
    expect(seq(body(S, areas, three()))).toEqual(['A', 'B', 'C']);
  });
  it('appends a blank last page when the content does not fit it (probe q8)', () => {
    expect(seq(body(S, [area('A'), area('B', { pagePosition: 'last' }, [ca(50)])], three()))).toEqual(['A', 'A', 'A', 'B*']);
  });
  it('appends a blank last page when the content-area counts differ (p. 306)', () => {
    expect(seq(body(S, [area('A'), area('B', { pagePosition: 'last' }, [ca(100), ca(100)])], three()))).toEqual(['A', 'A', 'A', 'B*']);
  });
  it('does not redo a final page qualified first (p. 306)', () => {
    expect(seq(body(S, [area('A', { pagePosition: 'first' }), area('B'), area('L', { pagePosition: 'last' })], [kid('a', 60)]))).toEqual(['A', 'L*']);
  });
  it('keeps the page when the only redo does not fit (p. 307)', () => {
    expect(seq(body(S, [area('A'), area('O', { pagePosition: 'only' }, [ca(50)])], [kid('a', 60)]))).toEqual(['A']);
  });
  it('does not redo a final page that holds no content, and still appends last', () => {
    const areas = [area('C', { pagePosition: 'first' }), area('A', { pagePosition: 'rest' }), area('L', { pagePosition: 'last' })];
    const b = body(S, areas, [kid('a', 20, { breakAfter: brk('pageArea', { startNew: true }) })]);
    expect(seq(b)).toEqual(['C', 'A', 'L*']);
  });
  it('does not end a duplex document on a blank back page (probes q4, q9)', () => {
    const areas = [area('A', { oddOrEven: 'odd' }), area('B', { oddOrEven: 'even' })];
    expect(seq(body(D, areas, three()))).toEqual(['A', 'B', 'A']);
  });
  it('rejects a redo that keeps the page count but refuses what the first run placed', () => {
    // Forced onto L (60pt), k1 cannot advance: page 3 would be odd and only R
    // (even) is a rest page. The rerun keeps two pages and refuses k1.
    const areas = [area('F', { pagePosition: 'first' }), area('R', { pagePosition: 'rest', oddOrEven: 'even' }), area('L', { pagePosition: 'last' }, [ca(60)])];
    const b = body(D, areas, [kid('k0', 100), kid('k1!', 100)]);
    expect(seq(b)).toEqual(['F', 'R', 'L*']);
    expect(refusals(b)).toEqual([]);
  });
  it('runs no termination under the ordered relation', () => {
    expect(seq(body('orderedOccurrence', [area('A'), area('B', { pagePosition: 'last' })], three()))).toEqual(['A', 'A', 'A']);
  });
});

describe('paginate: final review fixes (164g.9)', () => {
  it('appends last when the final page was opened by a page-area break, which no forced rerun can replace', () => {
    const b = body(S, [area('A'), area('X'), area('L', { pagePosition: 'last' })],
      [kid('a', 100), kid('b', 20, { breakBefore: brk('pageArea', { target: 'X', startNew: true }) })]);
    expect(seq(b)).toEqual(['A', 'X', 'L*']);
  });
  it('appends last when the only page was chosen by the start break', () => {
    const b = body(S, [area('A'), area('L', { pagePosition: 'last' })], [kid('a', 50)], brk('pageArea', { target: 'A' }));
    expect(seq(b)).toEqual(['A', 'L*']);
  });
  it('starts on an even page under duplex for a first child pageEven break, through a filler', () => {
    const b = body(D, [area('A')], [kid('a', 20, { breakBefore: brk('pageEven') })]);
    expect(seq(b)).toEqual(['A*', 'A']);
  });
  it('refuses a first child pageEven break outside duplex, as mid-document', () => {
    const b = body(S, [area('A')], [kid('a', 20, { breakBefore: brk('pageEven') })]);
    expect(refusals(b)).toEqual([['a', NEVER_EVEN]]);
    const o = body('orderedOccurrence', [area('A')], [kid('a', 20, { breakBefore: brk('pageEven') })]);
    expect(refusals(o)).toEqual([['a', NEVER_EVEN]]);
  });
  it('starts on page 1 for a first child pageOdd break', () => {
    expect(seq(body(D, [area('A')], [kid('a', 20, { breakBefore: brk('pageOdd', { startNew: true }) })]))).toEqual(['A']);
  });
});

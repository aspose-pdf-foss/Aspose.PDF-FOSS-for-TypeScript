// test/layout-tabs.test.ts
import { describe, it, expect } from 'vitest';
import { layoutRuns, winAnsiDriver, lastTabIndex, type LaidLine } from '../src/layout.js';
import { resolveTabStops, type TabStop, type TabLayout } from '../src/tabstops.js';

const CR = winAnsiDriver('Courier');           // 6pt per glyph at 10pt
const tabs = (stops: TabStop[], interval?: number, origin = 0): TabLayout => ({ ...resolveTabStops(stops, interval), origin });
const lay = (text: string, t: TabLayout | undefined, w = 300, indent = 0) =>
  layoutRuns([{ text, driver: CR, fontSize: 10 }], w, 1000, 12, 10, indent, undefined, t).lines;
/** Each segment's start x on the line, from the line start. */
const xs = (l: LaidLine) => { let x = 0; return l.segments.map((s) => { const at = x; x += s.width; return [s.tab ? 'TAB' : s.text, at] as const; }); };

describe('layoutRuns with tab stops (v9j3.1)', () => {
  it('is unchanged without tabs: the tab stays inside its word at zero width', () => {
    const a = layoutRuns([{ text: 'ab\tcd', driver: CR, fontSize: 10 }], 300, 1000, 12, 10);
    const b = layoutRuns([{ text: 'ab\tcd', driver: CR, fontSize: 10 }], 300, 1000, 12, 10, 0, undefined, undefined);
    expect(b).toEqual(a);
    expect(a.lines[0].width).toBe(24);
  });
  it('left stop: the text after the tab starts at the stop', () => {
    const [l] = lay('ab\tcd', tabs([{ position: 60 }]));
    expect(xs(l)).toEqual([['ab', 0], ['TAB', 12], ['cd', 60]]);
    expect(l.width).toBe(72);
  });
  it('right, center and decimal stops place the segment', () => {
    expect(xs(lay('a\tbcd', tabs([{ position: 60, align: 'right' }]))[0])).toEqual([['a', 0], ['TAB', 6], ['bcd', 42]]);
    expect(xs(lay('a\tbcd', tabs([{ position: 60, align: 'center' }]))[0])).toEqual([['a', 0], ['TAB', 6], ['bcd', 51]]);
    expect(xs(lay('a\t12.50', tabs([{ position: 60, align: 'decimal' }]))[0])).toEqual([['a', 0], ['TAB', 6], ['12.50', 48]]);
    // No decimalChar in the segment: right-aligned.
    expect(xs(lay('a\t1250', tabs([{ position: 60, align: 'decimal' }]))[0])).toEqual([['a', 0], ['TAB', 6], ['1250', 36]]);
  });
  it('a right segment wider than its room starts at the pen: pushed, never overprinting', () => {
    const [l] = lay('abcdef\tghijkl', tabs([{ position: 60, align: 'right' }]));
    expect(xs(l)).toEqual([['abcdef', 0], ['TAB', 36], ['ghijkl', 36]]);
    expect(l.segments[1].width).toBe(0);
  });
  it('a stop AT the pen is skipped; past the last explicit stop, default stops', () => {
    expect(xs(lay('\tx', tabs([{ position: 0 }, { position: 30 }]))[0])).toEqual([['TAB', 0], ['x', 30]]);
    expect(xs(lay('a\tb\tc', tabs([{ position: 30 }], 36))[0])).toEqual([['a', 0], ['TAB', 6], ['b', 30], ['TAB', 36], ['c', 72]]);
  });
  it('[] means default stops only', () => {
    expect(xs(lay('a\tb', tabs([], 36))[0])).toEqual([['a', 0], ['TAB', 6], ['b', 36]]);
  });
  it('no stop within the line: the tab ends the line (both sides of the edge)', () => {
    const fits = lay('ab\tcd', tabs([{ position: 100 }]), 112);           // 100 + 12 = 112: fits exactly
    expect(fits).toHaveLength(1);
    const breaks = lay('ab\tcd', tabs([{ position: 100 }]), 99);          // stop past the right edge
    expect(breaks.map((l) => l.text)).toEqual(['ab', 'cd']);
  });
  it('a long tab segment wraps at its spaces and continues at the margin', () => {
    const lines = lay('a\tbb cc dd ee', tabs([{ position: 60 }]), 90);   // 60 + "bb cc" 30 = 90
    expect(lines.map((l) => l.text)).toEqual(['abb cc', 'dd ee']);
    expect(xs(lines[1])[0]).toEqual(['dd ee', 0]);
  });
  it('the line fit counts the resolved tab width', () => {
    // "a" 6 + tab to 60 + "bbbb" 24 = 84: fits 84, not 83.
    expect(lay('a\tbbbb', tabs([{ position: 60 }]), 84)).toHaveLength(1);
    expect(lay('a\tbbbb', tabs([{ position: 60 }]), 83).map((l) => l.text)).toEqual(['a', 'bbbb']);
  });
  it('stops are measured from the tab origin, before the first-line indent and the box shift', () => {
    // Indent 18: the pen starts at 18 from the edge, so a stop at 60 is 42 into the line.
    expect(xs(lay('ab\tcd', tabs([{ position: 60 }]), 300, 18)[0])).toEqual([['ab', 0], ['TAB', 12], ['cd', 42]]);
    // origin 20 (the box sits 20pt right of the origin): a stop at 60 is 40 into it.
    expect(xs(lay('ab\tcd', tabs([{ position: 60 }], 36, 20))[0])).toEqual([['ab', 0], ['TAB', 12], ['cd', 40]]);
    // An indent past a stop skips it.
    expect(xs(lay('a\tb', tabs([{ position: 10 }, { position: 60 }]), 300, 30)[0])).toEqual([['a', 0], ['TAB', 6], ['b', 30]]);
  });
  it('a tab is its own segment, never merged into text; lastTabIndex finds the last', () => {
    const [l] = lay('a b\tc d\te', tabs([{ position: 60 }, { position: 120 }]));
    expect(l.segments.map((s) => (s.tab ? 'TAB' : s.text))).toEqual(['a b', 'TAB', 'c d', 'TAB', 'e']);
    expect(lastTabIndex(l)).toBe(3);
    expect(lastTabIndex(lay('abc', tabs([]))[0])).toBe(-1);
  });
  it('the remainder keeps its tabs raw, for the next page to re-resolve', () => {
    const r = layoutRuns([{ text: 'a\tb\nc\td', driver: CR, fontSize: 10 }], 300, 12, 12, 10, 0, undefined, tabs([{ position: 60 }]));
    expect(r.lines).toHaveLength(1);
    expect(r.remainder.map((s) => s.text).join('')).toBe('c\td');
  });
});

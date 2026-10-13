// test/xfatext-layout.test.ts
import { describe, it, expect } from 'vitest';
import { layoutLeaf, measureLeaf, type FaceLookup } from '../src/xfatext.js';
import type { LeafText } from '../src/xfarich.js';

// Every glyph 500 units wide, ascent 800, descent 200, 1000/em.
const faces: FaceLookup = () => ({ unitsPerEm: 1000, ascent: 800, descent: 200, advance: () => 500 });
const base = { family: ['X'], size: 10, bold: false, italic: false };
const para = (text: string, extra = {}) => ({
  runs: [{ ...base, text }], base, marginLeft: 0, marginRight: 0, textIndent: 0,
  lineHeight: 0, spaceAbove: 0, spaceBelow: 0, ...extra,
});
const leaf = (paras: ReturnType<typeof para>[], extra: Partial<LeafText> = {}): LeafText =>
  ({ kind: 'text', paras, insets: { l: 0, r: 0, t: 0, b: 0 }, password: false, picture: false, ...extra });

describe('layoutLeaf (164g.4): the lines measureLeaf breaks', () => {
  it('agrees with measureLeaf on the extent', () => {
    const t = leaf([para('aaaa bbbb cccc'), para('dd')]);
    const l = layoutLeaf(t, { width: 40 }, faces);
    const m = measureLeaf(t, { width: 40 }, faces);
    if ('reason' in l || 'reason' in m) throw new Error('refused');
    expect({ w: l.w, h: l.h }).toEqual(m);
  });

  it('puts the baseline the ascent below each line band', () => {
    const l = layoutLeaf(leaf([para('aaaa bbbb')]), { width: 25 }, faces);
    if ('reason' in l) throw new Error(l.reason);
    expect(l.lines.map((x) => x.baseline)).toEqual([8, 18]);
  });

  it('marks the last line of each paragraph', () => {
    const l = layoutLeaf(leaf([para('aaaa bbbb'), para('c')]), { width: 25 }, faces);
    if ('reason' in l) throw new Error(l.reason);
    expect(l.lines.map((x) => `${String(x.para)}:${String(x.last)}`)).toEqual(['0:false', '0:true', '1:true']);
  });

  it('adds max(spaceBelow, spaceAbove) between paragraphs', () => {
    const l = layoutLeaf(leaf([para('a', { spaceBelow: 3 }), para('b', { spaceAbove: 5 })]), { width: 100 }, faces);
    if ('reason' in l) throw new Error(l.reason);
    expect(l.lines[1].baseline).toBe(10 + 5 + 8);
  });

  it('starts a first line at marginLeft + textIndent and gives it the room left', () => {
    const l = layoutLeaf(leaf([para('aaaa bbbb', { marginLeft: 4, textIndent: 6 })]), { width: 100 }, faces);
    if ('reason' in l) throw new Error(l.reason);
    expect(l.lines[0]).toMatchObject({ left: 10, room: 90 });
  });

  it('carries each segment\'s run and width', () => {
    const l = layoutLeaf(leaf([para('ab')]), { width: 100 }, faces);
    if ('reason' in l) throw new Error(l.reason);
    expect(l.lines[0].segments).toEqual([{ run: 0, text: 'ab', width: 10 }]);
  });

  it('refuses exactly as measureLeaf does', () => {
    const t = leaf([para('a')], { refusal: 'nope' });
    expect(layoutLeaf(t, { width: 10 }, faces)).toEqual({ reason: 'nope' });
  });
});

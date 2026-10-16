import { describe, it, expect } from 'vitest';
import { fieldCut, pieceOf, fontSizeOf } from '../src/xfafieldsplit.js';
import type { LayoutNode } from '../src/xfaflow.js';
import type { LeafText } from '../src/xfarich.js';

/** A text field of height `h`, font `size`, with `extra` on its node or text. */
const fld = (h: number, size = 10, extra: Partial<LayoutNode> = {}, text: Partial<LeafText> = {}): LayoutNode => ({
  kind: 'field', label: 'f', field: 'f', ui: 'textEdit', geom: { w: '144pt', h: `${String(h)}pt` }, children: [],
  text: {
    kind: 'text', paras: [{ runs: [], base: { family: ['Courier New'], size, bold: false, italic: false },
      marginLeft: 0, marginRight: 0, textIndent: 0, lineHeight: 0, spaceAbove: 0, spaceBelow: 0 }],
    insets: { l: 0, r: 0, t: 0, b: 0 }, password: false, picture: false, ...text,
  } as LeafText,
  ...extra,
});

describe('fieldCut: an empty field (spec rules 3, 4)', () => {
  it('cuts at the room left once the top piece reaches the font size (t9, t10, t11, t20)', () => {
    expect(fieldCut(fld(48), 11, 0, 48)).toEqual({ cut: 11 });
    expect(fieldCut(fld(48), 12, 0, 48)).toEqual({ cut: 12 });
    expect(fieldCut(fld(48), 24, 0, 48)).toEqual({ cut: 24 });
    expect(fieldCut(fld(48), 10, 0, 48)).toEqual({ cut: 10 });
  });
  it('moves the field when the top piece is below the font size (t8, t19, t22)', () => {
    expect(fieldCut(fld(48), 9, 0, 48)).toBe('move');
  });
  it('accepts a bottom piece of exactly the font size (t42)', () => {
    expect(fieldCut(fld(48), 38, 0, 48)).toEqual({ cut: 38 });
  });
  it('moves the cut up by exactly one font size when the bottom is smaller (t21, t40, t41)', () => {
    expect(fieldCut(fld(46), 40, 0, 46)).toEqual({ cut: 30 });
    expect(fieldCut(fld(48), 46, 0, 48)).toEqual({ cut: 36 });   // not 38: "by", not "to"
    expect(fieldCut(fld(48), 42, 0, 48)).toEqual({ cut: 32 });
  });
  it('scales the floor with the font size (t44)', () => {
    expect(fieldCut(fld(48, 20), 42, 0, 48)).toEqual({ cut: 22 });
  });
  it('moves the field when the floor leaves less than one font size on top', () => {
    expect(fieldCut(fld(20), 15, 0, 20)).toBe('move');
  });
});

describe('fieldCut: a field with text (spec rules 1, 2)', () => {
  it('snaps to the last whole line on a 1.2 x size grid (t45, t46, t50)', () => {
    expect(fieldCut(fld(130), 64, 10, 130)).toEqual({ cut: 60 });
    expect(fieldCut(fld(130), 60, 10, 130)).toEqual({ cut: 60 });
  });
  it('uses the grid at 20pt too (t51)', () => {
    expect(fieldCut(fld(260, 20), 64, 10, 260)).toEqual({ cut: 48 });
  });
  it('keeps one line on top: no orphan control (t52)', () => {
    expect(fieldCut(fld(130), 14, 10, 130)).toEqual({ cut: 12 });
  });
  it('carries one line alone: no widow control (t53)', () => {
    expect(fieldCut(fld(120), 110, 10, 120)).toEqual({ cut: 108 });
  });
  it('cuts freely below the text (t54)', () => {
    expect(fieldCut(fld(130), 64, 3, 130)).toEqual({ cut: 64 });
  });
  it('moves the field when no whole line fits', () => {
    expect(fieldCut(fld(130, 10), 11, 10, 130)).toBe('move');
  });
  it('snaps a tail piece on the FIELD\'s grid, from its offset (rule 7)', () => {
    const tail = pieceOf(fld(130), 60, 70);
    expect(fieldCut(tail, 30, 10, 70)).toEqual({ cut: 24 });     // lines 6-7: offset 60 + 24 = 84 = 7 x 12
  });
  it('refuses a field whose line count is unknown', () => {
    expect(fieldCut(fld(130), 64, undefined, 130)).toEqual({ refusal: expect.stringMatching(/^f: its value's wrapped line count is not known/) as unknown as string });
  });
});

describe('fieldCut: rule 6, refused by name (164g.26)', () => {
  const refused = (n: LayoutNode): string => {
    const r = fieldCut(n, 30, 0, 48);
    return typeof r === 'object' && 'refusal' in r ? r.refusal : '';
  };
  it.each([
    ['a checkButton', fld(48, 10, { ui: 'checkButton' }), /a <checkButton> field/],
    ['a comb', fld(48, 10, { comb: true }), /a comb field/],
    ['a caption', fld(48, 10, {}, { caption: { placement: 'left', reserve: 20 } }), /a captioned field/],
    ['a top inset', fld(48, 10, {}, { insets: { l: 0, r: 0, t: 2, b: 0 } }), /a top or bottom inset/],
    ['a bottom inset', fld(48, 10, {}, { insets: { l: 0, r: 0, t: 0, b: 2 } }), /a top or bottom inset/],
    ['vAlign', fld(48, 10, {}, { vAlign: 'middle' }), /vAlign="middle"/],
    ['orphans/widows', fld(48, 10, { lineKeep: true }), /orphans or widows/],
  ])('refuses %s', (_w, n, re) => {
    expect(refused(n)).toMatch(re);
    expect(refused(n)).toMatch(/\(164g\.26\)$/);
  });
  it('refuses a stated lineHeight and mixed sizes', () => {
    const lh = fld(48);
    lh.text!.paras[0].lineHeight = 14;
    expect(refused(lh)).toMatch(/a stated lineHeight/);
    const mixed = fld(48);
    mixed.text!.paras[0].runs = [{ text: 'a', family: ['Courier New'], size: 14, bold: false, italic: false }];
    expect(refused(mixed)).toMatch(/mixed font sizes/);
  });
  it('lets a field that would move anyway move, whatever it states', () => {
    expect(fieldCut(fld(48, 10, { ui: 'checkButton' }), 5, 0, 48)).toBe('move');
  });
  it('accepts left and right insets', () => {
    expect(fieldCut(fld(48, 10, {}, { insets: { l: 3, r: 3, t: 0, b: 0 } }), 30, 0, 48)).toEqual({ cut: 30 });
  });
});

describe('pieceOf', () => {
  it('states the piece height, drops min/max, and records offset and line range', () => {
    const n = fld(130, 10, { minMax: { minH: '10pt' } });
    const head = pieceOf(n, 0, 60);
    expect(head.geom.h).toBe('60pt');
    expect(head.minMax).toBeUndefined();
    expect(head.piece).toEqual({ offset: 0, lines: [0, 5] });
    const tail = pieceOf(n, 60, 70);
    expect(tail.piece).toEqual({ offset: 60, lines: [5, 11] });
  });
  it('composes offsets for a piece of a piece', () => {
    expect(pieceOf(pieceOf(fld(200), 60, 140), 24, 116).piece).toEqual({ offset: 84, lines: [7, 17] });
  });
  it('keeps the field name, so every piece places under one SOM name', () => {
    expect(pieceOf(fld(48), 0, 20).field).toBe('f');
  });
});

describe('fontSizeOf', () => {
  it('reads the base size, else XFA\'s 10pt default', () => {
    expect(fontSizeOf(fld(48, 14))).toBe(14);
    expect(fontSizeOf({ kind: 'field', label: 'x', geom: {}, children: [] })).toBe(10);
  });
});

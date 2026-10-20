// test/xfachrome-text.test.ts
import { describe, it, expect } from 'vitest';
import { chromeOps, type ChromeOp } from '../src/xfachrome.js';
import type { LayoutNode, PlacedNode } from '../src/xfaflow.js';
import type { FaceLookup } from '../src/xfatext.js';
import type { LeafText, ParaSpec } from '../src/xfarich.js';
import { parseXml } from '../src/xml.js';
import { parseBorder } from '../src/xfaborder.js';

const faces: FaceLookup = (s) => (s.family[0] === 'Missing' ? { reason: 'no face named "Missing"' }
  : { unitsPerEm: 1000, ascent: 800, descent: 200, advance: () => 500 });
const base = { family: ['X'], size: 10, bold: false, italic: false };
const para = (text: string, extra: Partial<ParaSpec> = {}): ParaSpec => ({
  runs: [{ ...base, text }], base, marginLeft: 0, marginRight: 0, textIndent: 0,
  lineHeight: 0, spaceAbove: 0, spaceBelow: 0, ...extra,
});
const text = (paras: ParaSpec[], extra: Partial<LeafText> = {}): LeafText =>
  ({ kind: 'text', paras, insets: { l: 0, r: 0, t: 0, b: 0 }, password: false, picture: false, ...extra });
const draw = (t: LeafText): LayoutNode => ({ kind: 'draw', label: 'D', geom: {}, children: [], text: t });
const at = (n: LayoutNode, box = { x: 0, y: 0, w: 100, h: 40 }): PlacedNode => ({ node: n, box, invisible: false });
const texts = (o: ChromeOp[]) => o.filter((x): x is Extract<ChromeOp, { kind: 'text' }> => x.kind === 'text');

describe('chromeOps: a draw\'s text (164g.4)', () => {
  it('writes each line at its baseline, from the box top-left plus insets', () => {
    const o = texts(chromeOps([at(draw(text([para('ab')], { insets: { l: 2, r: 0, t: 3, b: 0 } })))], faces).ops);
    expect(o).toEqual([{ kind: 'text', x: 2, y: 11, text: 'ab', style: base, color: [0, 0, 0], underline: false, lineThrough: false }]);
  });

  it('centres and right-aligns per line within the room (p. 800)', () => {
    const c = texts(chromeOps([at(draw(text([para('ab', { hAlign: 'center' })])))], faces).ops)[0];
    expect(c.x).toBe(45);
    const r = texts(chromeOps([at(draw(text([para('ab', { hAlign: 'right' })])))], faces).ops)[0];
    expect(r.x).toBe(90);
  });

  it('aligns the block vertically by vAlign', () => {
    const m = texts(chromeOps([at(draw(text([para('ab')], { vAlign: 'middle' })))], faces).ops)[0];
    expect(m.y).toBe(15 + 8);
    const b = texts(chromeOps([at(draw(text([para('ab')], { vAlign: 'bottom' })))], faces).ops)[0];
    expect(b.y).toBe(30 + 8);
  });

  it('justifies by spreading words, leaving the last line of a paragraph ragged', () => {
    const o = texts(chromeOps([at(draw(text([para('aa bb cc dd', { hAlign: 'justify' })])), { x: 0, y: 0, w: 32, h: 40 })], faces).ops);
    // Line 1 "aa bb " -> words at 0 and 32-10=22; line 2 "cc dd" is last: left.
    expect(o.filter((t) => t.y === 8).map((t) => [t.text.trim(), t.x])).toEqual([['aa', 0], ['bb', 22]]);
    // Line 2's top is 1.2 x 10 down (164g.32), its baseline one ascent below.
    expect(o.filter((t) => t.y === 20).map((t) => t.x)).toEqual([0]);
  });

  it('carries run colour and decoration', () => {
    const p = para('ab');
    p.runs[0] = { ...p.runs[0], color: [1, 0, 0], underline: true };
    expect(texts(chromeOps([at(draw(text([p])))], faces).ops)[0]).toMatchObject({ color: [1, 0, 0], underline: true, lineThrough: false });
  });

  // 164g.17: a spacerun's protected U+00A0 is painted as the space it stands
  // for, so a face lacking U+00A0 draws it and a copy reads as real spaces.
  it('paints a protected spacerun space as U+0020', () => {
    const o = texts(chromeOps([at(draw(text([para('a  b')])))], faces).ops);
    expect(o.map((t) => t.text).join('')).toBe('a  b');
  });

  // Review Focus 1: a face nothing resolves.
  it('reports text in a face nothing resolves, and paints none of it', () => {
    const t = text([{ ...para('ab'), runs: [{ ...base, family: ['Missing'], text: 'ab' }], base: { ...base, family: ['Missing'] } }]);
    const r = chromeOps([at(draw(t))], faces);
    expect(texts(r.ops)).toEqual([]);
    expect(r.skipped).toEqual([{ name: 'D', reason: 'no face named "Missing", so its text is not painted' }]);
  });

  // Found by the pdf.js oracle: a refused leaf's runs are EMPTY, so a
  // blank-text check before the refusal dropped OPM 1644's instructions
  // paragraph with nothing reported.
  it('reports a refused leaf even when the refusal left it no runs', () => {
    const t = text([{ ...para(''), runs: [] }], { refusal: 'two or more spaces in an xfa-spacerun span are not measured' });
    const r = chromeOps([at(draw(t))], faces);
    expect(texts(r.ops)).toEqual([]);
    expect(r.skipped).toEqual([{ name: 'D', reason: 'two or more spaces in an xfa-spacerun span are not measured, so its text is not painted' }]);
  });

  // A border's fill is the text's background (p. 38): painted after it, the
  // fill covers the words. Every other case here has no border, so none sees it.
  it('writes a draw\'s text AFTER its own border fill and stroke', () => {
    const b = parseBorder(parseXml(new TextEncoder().encode('<border><edge/><fill><color value="200,200,200"/></fill></border>')));
    const n: LayoutNode = { ...draw(text([para('ab')])), chrome: { border: b } };
    expect(chromeOps([at(n)], faces).ops.map((o) => o.kind)).toEqual(['fill', 'stroke', 'text']);
  });

  it('passes a leaf\'s notes to warnings', () => {
    const r = chromeOps([at(draw(text([para('ab')], { notes: ['font color value="x" could not be read, so black is used'] })))], faces);
    expect(r.warnings).toEqual(['D: font color value="x" could not be read, so black is used']);
  });
});

describe('chromeOps: a field\'s caption', () => {
  const field = (extra: Partial<NonNullable<LayoutNode['chrome']>> = {}): LayoutNode => ({
    kind: 'field', label: 'f[0]', field: 'form1[0].f[0]', geom: {}, children: [],
    text: text([para('THE VALUE')]),
    chrome: { caption: text([para('Cap')]), fieldCaption: { reserve: '40pt', placement: 'left' }, ...extra },
  });

  it('writes the caption in the caption region, never the field value', () => {
    const o = texts(chromeOps([at(field(), { x: 10, y: 20, w: 200, h: 20 })], faces).ops);
    expect(o.map((t) => [t.text, t.x, t.y])).toEqual([['Cap', 10, 28]]);
  });

  it('insets the caption region by the field margin', () => {
    const o = texts(chromeOps([at(field({ fieldMargin: { leftInset: '3pt', topInset: '2pt' } }), { x: 10, y: 20, w: 200, h: 20 })], faces).ops);
    expect([o[0].x, o[0].y]).toEqual([13, 30]);
  });

  // Review Focus 4: an invisible caption keeps its reserve and paints nothing.
  it('paints nothing for a caption with presence="invisible"', () => {
    expect(texts(chromeOps([at(field({ captionPresence: 'invisible' }))], faces).ops)).toEqual([]);
  });

  it('paints no caption without a caption region (no reserve)', () => {
    expect(texts(chromeOps([at(field({ fieldCaption: { placement: 'left' } }))], faces).ops)).toEqual([]);
  });
});

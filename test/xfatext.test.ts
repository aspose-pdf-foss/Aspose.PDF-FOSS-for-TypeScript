// test/xfatext.test.ts
import { describe, it, expect } from 'vitest';
import { parseXml } from '../src/xml.js';
import { leafText, withValue, type RunStyle } from '../src/xfarich.js';
import { layoutLeaf, measureLeaf, splitGrid, type FaceLookup, type FaceMetrics } from '../src/xfatext.js';

const el = (xml: string) => leafText(parseXml(new TextEncoder().encode(xml)));
/** 'Mono': every glyph 500/1000 wide, ascent 800, descent 200 -> a 10pt line is
 *  10pt tall and each character 5pt wide. 'Tall' doubles the ascent. The bullet
 *  U+2022 is missing from 'Mono'. */
const MONO: FaceMetrics = { unitsPerEm: 1000, ascent: 800, descent: 200, advance: (cp) => (cp === 0x2022 ? undefined : 500) };
const TALL: FaceMetrics = { unitsPerEm: 1000, ascent: 1600, descent: 200, advance: () => 500 };
const faces: FaceLookup = (s: RunStyle, text: string) => {
  const m = s.family[0] === 'Tall' ? TALL : s.family[0] === 'Mono' ? MONO : undefined;
  if (!m) return { reason: `no face for ${s.family.join(',')}` };
  for (const ch of text) if (ch !== '\n' && m.advance(ch.codePointAt(0)!) === undefined) return { reason: 'uncovered' };
  return m;
};
const draw = (text: string, extra = '') => el(`<draw><font typeface="Mono" size="10pt"/>${extra}<value><text>${text}</text></value></draw>`);

describe('measureLeaf', () => {
  it('wraps at a fixed width and grows in height', () => {
    // 'aaaa bbbb' = 45pt; a 30pt box holds one word per line: 1.2 x 10 + 10.
    expect(measureLeaf(draw('aaaa bbbb'), { width: 30 }, faces)).toEqual({ w: 30, h: 22 });
    expect(measureLeaf(draw('aaaa bbbb'), { width: 100 }, faces)).toEqual({ w: 100, h: 10 });
  });

  it('grows in width to the longest line, breaking only at newlines', () => {
    expect(measureLeaf(draw('aa\naaaa'), {}, faces)).toEqual({ w: 20, h: 22 });
  });

  // 164g.17: a spacerun's spaces are each measured, and the break stays after them.
  it('measures every space of a spacerun and breaks after the run', () => {
    const sr = (w: number | undefined) => measureLeaf(el('<draw><font typeface="Mono" size="10pt"/><value><exData contentType="text/html">'
      + '<body><p>aa<span style="xfa-spacerun:yes">   </span>bb</p></body></exData></value></draw>'),
    w === undefined ? {} : { width: w }, faces);
    expect(sr(undefined)).toEqual({ w: 35, h: 10 });
    // 'aa' plus two protected spaces is 20pt; 'bb' wraps to the next line.
    expect(sr(25)).toEqual({ w: 25, h: 22 });
  });

  it('wraps a width-growable leaf at maxWidth', () => {
    expect(measureLeaf(draw('aaaa bbbb'), { maxWidth: 30 }, faces)).toEqual({ w: 20, h: 22 });
  });

  it('adds insets, paragraph margins, first-line indent and a caption reserve', () => {
    const t = draw('aa', '<margin leftInset="1pt" rightInset="2pt" topInset="3pt" bottomInset="4pt"/>'
      + '<para marginLeft="5pt" marginRight="6pt" textIndent="7pt"/>');
    expect(measureLeaf(t, {}, faces)).toEqual({ w: 1 + 2 + 5 + 6 + 7 + 10, h: 3 + 4 + 10 });
    const f = el('<field><ui><textEdit/></ui><font typeface="Mono"/><caption reserve="15pt"/><value><text>aa</text></value></field>');
    expect(measureLeaf(f, {}, faces)).toEqual({ w: 25, h: 10 });
    const top = el('<field><ui><textEdit/></ui><font typeface="Mono"/><caption placement="top" reserve="6pt"/><value><text>aa</text></value></field>');
    expect(measureLeaf(top, {}, faces)).toEqual({ w: 10, h: 16 });
  });

  // 164g.36: a caption that states no reserve takes its MEASURED text -- one
  // 10pt line above is 10pt (Adobe t114, t121), its own margins add, and its own
  // font size counts. With no text it takes nothing (DD 3183).
  it('sizes a reserve-less top caption from its text', () => {
    const f = (cap: string) => el(`<field><ui><textEdit/></ui><font typeface="Mono" size="10pt"/>${cap}<value><text>a</text></value></field>`);
    expect(measureLeaf(f('<caption/>'), { width: 50 }, faces)).toEqual({ w: 50, h: 10 });
    expect(measureLeaf(f('<caption placement="top"><value><text>c</text></value></caption>'), { width: 50 }, faces))
      .toEqual({ w: 50, h: 10 + 10 });
    expect(measureLeaf(f('<caption placement="top"><margin topInset="2pt" bottomInset="3pt"/><value><text>c</text></value></caption>'), { width: 50 }, faces))
      .toEqual({ w: 50, h: 2 + 10 + 3 + 10 });
    expect(measureLeaf(f('<caption placement="top"><font typeface="Mono" size="12pt"/><value><text>c</text></value></caption>'), { width: 50 }, faces))
      .toEqual({ w: 50, h: 12 + 10 });
    // 'aaaa bbbb' is 45pt at 10pt Mono, so it wraps in a 30pt field: 12 + 10.
    expect(measureLeaf(f('<caption placement="bottom"><value><text>aaaa bbbb</text></value></caption>'), { width: 30 }, faces))
      .toEqual({ w: 30, h: 22 + 10 });
  });

  it('refuses a reserve-less caption it cannot measure', () => {
    const f = (cap: string, box = { width: 50 }) => measureLeaf(el(`<field><ui><textEdit/></ui><font typeface="Mono"/>${cap}<value><text>a</text></value></field>`), box, faces);
    // Beside the field it would size the WIDTH, which no probe has settled.
    expect(f('<caption><value><text>c</text></value></caption>')).toMatchObject({ reason: expect.stringMatching(/left caption states no reserve/) });
    // No face to wrap with: a word too wide WRAPS (t121), so no line count is known.
    expect(f('<caption placement="top"><font typeface="Nope"/><value><text>c</text></value></caption>'))
      .toMatchObject({ reason: expect.stringMatching(/caption states no reserve and/) });
    // A width-growable field whose width would depend on the caption.
    expect(f('<caption placement="top"><value><text>c</text></value></caption>', {} as never))
      .toMatchObject({ reason: expect.stringMatching(/width depends on the caption/) });
  });

  // 164g.32, Adobe probes t111-t117: a line is measured off its font SIZE, never
  // its face -- 'Tall' has twice Mono's ascent and changes nothing. Every line
  // but the last steps 1.2s; the last is s.
  it('takes the line height from the font size, not the face', () => {
    const rich = el('<draw><font typeface="Mono"/><value><exData contentType="text/html"><body>'
      + '<p>a<span style="font-family:Tall">b</span></p><p>c</p></body></exData></value></draw>');
    expect(measureLeaf(rich, { width: 100 }, faces)).toEqual({ w: 100, h: 12 + 10 });
    expect(measureLeaf(draw('a\nb\nc'), { width: 100 }, faces)).toEqual({ w: 100, h: 12 + 12 + 10 });
  });

  // t115 mixA/mixB/mixC: the line's LARGEST size, and the last-line trim is the
  // leaf's, across paragraphs.
  it('measures a line by its largest size, trimming only the leaf\'s last line', () => {
    const rich = (body: string) => el('<draw><font typeface="Mono" size="10pt"/><value><exData contentType="text/html">'
      + `<body>${body}</body></exData></value></draw>`);
    expect(measureLeaf(rich('<p>a<span style="font-size:20pt">B</span></p>'), { width: 100 }, faces)).toMatchObject({ h: 20 });
    expect(measureLeaf(rich('<p>a<span style="font-size:20pt">B</span></p><p>c</p>'), { width: 100 }, faces)).toMatchObject({ h: 24 + 10 });
    expect(measureLeaf(rich('<p>a</p><p style="font-size:20pt">B</p>'), { width: 100 }, faces)).toMatchObject({ h: 12 + 20 });
  });

  // t116, t117: a stated lineHeight L below 1.2s is every line's height; at or
  // above it, a lone line is s and a longer leaf ends on 1.2s.
  it('applies a stated lineHeight as Adobe does, on both sides of 1.2s', () => {
    const lh = (L: number, text: string) => measureLeaf(draw(text, `<para lineHeight="${String(L)}pt"/>`), { width: 100 }, faces);
    expect([lh(5, 'a'), lh(5, 'a\nb'), lh(5, 'a\nb\nc')].map((x) => 'h' in x && x.h)).toEqual([5, 10, 15]);
    expect([lh(11, 'a'), lh(11, 'a\nb')].map((x) => 'h' in x && x.h)).toEqual([11, 22]);
    expect([lh(12, 'a'), lh(12, 'a\nb'), lh(12, 'a\nb\nc')].map((x) => 'h' in x && x.h)).toEqual([10, 24, 36]);
    expect([lh(20, 'a'), lh(20, 'a\nb'), lh(20, 'a\nb\nc')].map((x) => 'h' in x && x.h)).toEqual([10, 32, 52]);
  });

  // t116 pAb, pA1: spaceAbove and spaceBelow are SUMMED, once around the leaf --
  // a plain newline is a line break, not a paragraph Adobe spaces apart.
  it('adds spaceAbove before the text and spaceBelow after it, once', () => {
    const sp = '<para spaceAbove="5pt" spaceBelow="7pt"/>';
    expect(measureLeaf(draw('a\nb', sp), { width: 100 }, faces)).toEqual({ w: 100, h: 5 + 12 + 10 + 7 });
    expect(measureLeaf(draw('a', sp), { width: 100 }, faces)).toEqual({ w: 100, h: 5 + 10 + 7 });
  });

  it('measures an empty field as one empty line in its own font', () => {
    const f = el('<field><ui><textEdit/></ui><font typeface="Mono" size="12pt"/></field>');
    expect(measureLeaf(f, { width: 50 }, faces)).toEqual({ w: 50, h: 12 });
  });

  it('measures a password by its mask, falling back to * where the face has no bullet', () => {
    const f = withValue(el('<field><ui><passwordEdit/></ui><font typeface="Mono"/></field>'), 'secret');
    expect(measureLeaf(f, {}, faces)).toEqual({ w: 30, h: 10 });
  });

  it('refuses a face that will not resolve, and a box with no room', () => {
    expect(measureLeaf(el('<draw><font typeface="Nope"/><value><text>a</text></value></draw>'), {}, faces))
      .toMatchObject({ reason: expect.stringMatching(/Nope/) });
    expect(measureLeaf(draw('a', '<margin leftInset="30pt"/>'), { width: 20 }, faces))
      .toMatchObject({ reason: expect.stringMatching(/no room/) });
  });

  it('refuses edge whitespace on a width-growable leaf only', () => {
    const t = withValue(el('<field><ui><textEdit/></ui><font typeface="Mono"/></field>'), ' a');
    expect(measureLeaf(t, {}, faces)).toMatchObject({ reason: expect.stringMatching(/whitespace/) });
    expect(measureLeaf(t, { width: 50 }, faces)).toEqual({ w: 50, h: 10 });
  });

  it('passes a refusal through and sizes geometry at zero', () => {
    expect(measureLeaf(el('<draw><font letterSpacing="1pt"/><value><text>a</text></value></draw>'), {}, faces))
      .toMatchObject({ reason: expect.stringMatching(/letterSpacing/) });
    expect(measureLeaf(el('<draw><value><rectangle/></value></draw>'), {}, faces)).toEqual({ w: 0, h: 0 });
  });
});

// 164g.26: where Adobe Reader cuts a field across a break -- each line's bottom
// from the field's top (probes t128-t131, t137-t140).
describe('splitGrid', () => {
  const lines10 = Array.from({ length: 10 }, (_, i) => `l${String(i)}`).join('\n');
  const fieldOf = (extra: string, value = `<value><text>${lines10}</text></value>`) =>
    el(`<field><font typeface="Mono" size="10pt"/>${extra}<ui><textEdit multiLine="1"/></ui>${value}</field>`);
  const grid = (extra: string, h: number, value?: string) => {
    const l = layoutLeaf(fieldOf(extra, value), { width: 144 }, faces);
    if ('reason' in l) throw new Error(l.reason);
    return splitGrid(l, h).bottoms;
  };
  it('steps 1.2 x the size from the top', () => {
    expect(grid('', 130).slice(0, 3)).toEqual([12, 24, 36]);
  });
  it('starts below a top caption and the top inset, not a left caption (t127-t129)', () => {
    expect(grid('<caption placement="top" reserve="20pt"><value><text>C</text></value></caption>', 150)[0]).toBe(32);
    expect(grid('<margin topInset="10pt" bottomInset="10pt"/>', 150)[0]).toBe(22);
    expect(grid('<caption placement="left" reserve="1in"><value><text>C</text></value></caption>', 130)[0]).toBe(12);
  });
  it('moves vAligned text down by the room beside its 118pt block (t130, t140)', () => {
    expect(grid('<para vAlign="bottom"/>', 160)[0]).toBe(54);
    expect(grid('<para vAlign="middle"/>', 160)[0]).toBe(33);
    // A bottom caption takes from that room.
    expect(grid('<para vAlign="bottom"/><caption placement="bottom" reserve="20pt"><value><text>C</text></value></caption>', 160)[0]).toBe(34);
  });
  it('steps a stated lineHeight: L under 1.2s throughout, else 1.2s first (t131, t138, t139)', () => {
    expect(grid('<para lineHeight="15pt"/>', 160).slice(0, 4)).toEqual([12, 27, 42, 57]);
    expect(grid('<para lineHeight="20pt"/>', 160).slice(0, 3)).toEqual([12, 32, 52]);
    expect(grid('<para lineHeight="9pt"/>', 160).slice(0, 3)).toEqual([9, 18, 27]);
  });
  it('steps each line by its own largest size (t137)', () => {
    const rich = '<value><exData contentType="text/html"><body xmlns="http://www.w3.org/1999/xhtml">'
      + '<p>a</p><p>b</p><p style="font-size:20pt">c</p><p>d</p></body></exData></value>';
    expect(grid('', 160, rich)).toEqual([12, 24, 48, 60]);
  });
});

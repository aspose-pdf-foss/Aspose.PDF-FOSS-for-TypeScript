// test/xfatext.test.ts
import { describe, it, expect } from 'vitest';
import { parseXml } from '../src/xml.js';
import { leafText, withValue, type RunStyle } from '../src/xfarich.js';
import { measureLeaf, type FaceLookup, type FaceMetrics } from '../src/xfatext.js';

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
    // 'aaaa bbbb' = 45pt; a 30pt box holds one word per line.
    expect(measureLeaf(draw('aaaa bbbb'), { width: 30 }, faces)).toEqual({ w: 30, h: 20 });
    expect(measureLeaf(draw('aaaa bbbb'), { width: 100 }, faces)).toEqual({ w: 100, h: 10 });
  });

  it('grows in width to the longest line, breaking only at newlines', () => {
    expect(measureLeaf(draw('aa\naaaa'), {}, faces)).toEqual({ w: 20, h: 20 });
  });

  it('wraps a width-growable leaf at maxWidth', () => {
    expect(measureLeaf(draw('aaaa bbbb'), { maxWidth: 30 }, faces)).toEqual({ w: 20, h: 20 });
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

  it('refuses a measured caption that states no reserve', () => {
    const f = el('<field><ui><textEdit/></ui><font typeface="Mono"/><caption/><value><text>a</text></value></field>');
    expect(measureLeaf(f, { width: 50 }, faces)).toMatchObject({ reason: expect.stringMatching(/caption.*reserve/) });
  });

  it('takes the line height from the tallest face on the line, and lineHeight when greater', () => {
    const rich = el('<draw><font typeface="Mono"/><value><exData contentType="text/html"><body>'
      + '<p>a<span style="font-family:Tall">b</span></p><p>c</p></body></exData></value></draw>');
    expect(measureLeaf(rich, { width: 100 }, faces)).toEqual({ w: 100, h: 18 + 10 });
    expect(measureLeaf(draw('a', '<para lineHeight="14pt"/>'), { width: 100 }, faces)).toEqual({ w: 100, h: 14 });
  });

  it('adds the larger of spaceBelow and spaceAbove between paragraphs only', () => {
    const t = draw('a\nb', '<para spaceAbove="2pt" spaceBelow="5pt"/>');
    expect(measureLeaf(t, { width: 100 }, faces)).toEqual({ w: 100, h: 10 + 5 + 10 });
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

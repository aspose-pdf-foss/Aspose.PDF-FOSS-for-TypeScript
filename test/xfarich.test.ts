// test/xfarich.test.ts
import { describe, it, expect } from 'vitest';
import { parseXml } from '../src/xml.js';
import { leafText, withValue } from '../src/xfarich.js';

const el = (xml: string) => parseXml(new TextEncoder().encode(xml));

describe('leafText: plain text', () => {
  it('applies the template-reference font defaults (size 10, Courier, normal)', () => {
    const t = leafText(el('<draw><value><text>hi</text></value></draw>'));
    expect(t.kind).toBe('text');
    expect(t.paras).toHaveLength(1);
    expect(t.paras[0].runs).toEqual([{ text: 'hi', family: ['Courier'], size: 10, bold: false, italic: false }]);
  });

  it('reads <font>, <para>, <margin> and splits records on newlines', () => {
    const t = leafText(el(
      '<draw><font typeface="Arial" size="9pt" weight="bold" posture="italic"/>'
      + '<para marginLeft="2pt" marginRight="3pt" textIndent="4pt" lineHeight="12pt" spaceAbove="1pt" spaceBelow="5pt"/>'
      + '<margin leftInset="1pt" rightInset="2pt" topInset="3pt" bottomInset="4pt"/>'
      + '<value><text>a\nb</text></value></draw>'));
    expect(t.paras.map((p) => p.runs.map((r) => r.text).join(''))).toEqual(['a', 'b']);
    expect(t.paras[0].runs[0]).toMatchObject({ family: ['Arial'], size: 9, bold: true, italic: true });
    expect(t.paras[0]).toMatchObject({ marginLeft: 2, marginRight: 3, textIndent: 4, lineHeight: 12, spaceAbove: 1, spaceBelow: 5 });
    expect(t.insets).toEqual({ l: 1, r: 2, t: 3, b: 4 });
  });

  it('gives an empty value one empty paragraph, which measures one line', () => {
    const t = leafText(el('<field><ui><textEdit/></ui><font typeface="Arial"/></field>'));
    expect(t.paras).toHaveLength(1);
    expect(t.paras[0].runs).toEqual([]);
    expect(t.paras[0].base).toEqual({ family: ['Arial'], size: 10, bold: false, italic: false });
  });

  it('withValue replaces the default with a bound value', () => {
    const t = withValue(leafText(el('<field><ui><textEdit/></ui><value><text>x</text></value></field>')), 'p\nq');
    expect(t.paras.map((p) => p.runs.map((r) => r.text).join(''))).toEqual(['p', 'q']);
  });

  it('withValue keeps a refusal that is not about the value', () => {
    const t = leafText(el('<field><ui><textEdit/></ui><font letterSpacing="1pt"/></field>'));
    expect(withValue(t, 'x').refusal).toMatch(/letterSpacing/);
  });

  it('marks a password field and a picture clause', () => {
    expect(leafText(el('<field><ui><passwordEdit/></ui></field>')).password).toBe(true);
    const pic = leafText(el('<field><ui><textEdit/></ui><format><picture>999</picture></format></field>'));
    expect(pic.picture).toBe(true);
    expect(withValue(pic, '12').refusal).toMatch(/display picture/);
    expect(withValue(pic, '').refusal).toBeUndefined();
  });
});

describe('leafText: captions', () => {
  it('reads placement (default left) and reserve', () => {
    expect(leafText(el('<field><ui><textEdit/></ui><caption reserve="20mm"/></field>')).caption)
      .toEqual({ placement: 'left', reserve: 20 * 72 / 25.4 });
    expect(leafText(el('<field><ui><textEdit/></ui><caption placement="top"/></field>')).caption)
      .toEqual({ placement: 'top' });
  });

  // Review Focus 4: a hidden caption takes no space, so its missing reserve is
  // not a reason to refuse.
  it('ignores a hidden or inactive caption', () => {
    expect(leafText(el('<field><ui><textEdit/></ui><caption presence="hidden"/></field>')).caption).toBeUndefined();
    expect(leafText(el('<field><ui><textEdit/></ui><caption presence="inactive"/></field>')).caption).toBeUndefined();
  });
});

describe('leafText: rich text (XFA 3.3 ch. 27)', () => {
  const rich = (body: string, font = '<font typeface="Arial"/>') => leafText(el(
    `<draw>${font}<value><exData contentType="text/html"><body xmlns="http://www.w3.org/1999/xhtml">${body}</body></exData></value></draw>`));

  it('reads OPM 1644 Q1: spans inherit, a 9pt italic span, spacerun spaces', () => {
    const t = rich('<p>1. Type of provider<span style="xfa-spacerun:yes"> </span>'
      + '<span style="font-size:9pt;font-style:italic">(Check one)<span style="xfa-spacerun:yes"> </span></span></p>');
    expect(t.paras).toHaveLength(1);
    const runs = t.paras[0].runs;
    expect(runs.map((r) => r.text).join('')).toBe('1. Type of provider (Check one) ');
    expect(runs[0]).toMatchObject({ family: ['Arial'], size: 10, italic: false });
    expect(runs.find((r) => r.text.includes('Check'))).toMatchObject({ size: 9, italic: true });
  });

  it('reads b, i, br, font-family lists and paragraph margins', () => {
    const t = rich('<p style="margin-top:2pt;margin-bottom:3pt;margin-left:4pt;text-indent:1pt">a<b>b</b><i>c</i><br/>d</p>'
      + '<p style="font-family:\'Times New Roman\', serif;font-weight:bold">e</p>');
    expect(t.paras).toHaveLength(2);
    expect(t.paras[0]).toMatchObject({ spaceAbove: 2, spaceBelow: 3, marginLeft: 4, textIndent: 1 });
    expect(t.paras[0].runs.map((r) => [r.text, r.bold, r.italic])).toEqual([['a', false, false], ['b', true, false], ['c', false, true], ['\nd', false, false]]);
    expect(t.paras[1].runs[0]).toMatchObject({ family: ['Times New Roman', 'serif'], bold: true });
  });

  it('collapses whitespace outside a spacerun', () => {
    const t = rich('<p>a   b\n  c</p>');
    expect(t.paras[0].runs.map((r) => r.text).join('')).toBe('a b c');
  });

  // Review Focus 2: p. 1187 -- an unrecognised element is ignored WITH its content.
  it('drops an unrecognised element and its content', () => {
    const t = rich('<p>a<script>evil</script><div>gone</div>b</p>');
    expect(t.paras[0].runs.map((r) => r.text).join('')).toBe('ab');
  });

  it('refuses what changes a size and is not modelled', () => {
    expect(rich('<p>a<sub>2</sub></p>').refusal).toMatch(/sub/);
    expect(rich('<p style="letter-spacing:1pt">a</p>').refusal).toMatch(/letter-spacing/);
    expect(rich('<ul><li>a</li></ul>').refusal).toMatch(/list/);
    expect(rich('<p style="font-size:12px">a</p>').refusal).toMatch(/font-size/);
    expect(rich('<p>a<span style="xfa-spacerun:yes">  </span>b</p>').refusal).toMatch(/spacerun/);
  });
});

describe('leafText: refusals and geometry', () => {
  it('refuses non-default font and para features', () => {
    expect(leafText(el('<draw><font letterSpacing="1pt"/><value><text>a</text></value></draw>')).refusal).toMatch(/letterSpacing/);
    expect(leafText(el('<draw><font kerningMode="pair"/><value><text>a</text></value></draw>')).refusal).toMatch(/kerningMode/);
    expect(leafText(el('<draw><font fontHorizontalScale="90%"/><value><text>a</text></value></draw>')).refusal).toMatch(/fontHorizontalScale/);
    expect(leafText(el('<draw><font baselineShift="2pt"/><value><text>a</text></value></draw>')).refusal).toMatch(/baselineShift/);
    expect(leafText(el('<draw><para hAlign="radix"/><value><text>a</text></value></draw>')).refusal).toMatch(/radix/);
    expect(leafText(el('<draw><value><text>a\tb</text></value></draw>')).refusal).toMatch(/tab/);
    expect(leafText(el('<draw><para><hyphenation hyphenate="1"/></para><value><text>a</text></value></draw>')).refusal).toMatch(/hyphenat/);
  });

  it('refuses a growable field whose ui is not text-like', () => {
    expect(leafText(el('<field><ui><checkButton/></ui></field>')).refusal).toMatch(/checkButton/);
    expect(leafText(el('<field><ui><choiceList/></ui></field>')).refusal).toMatch(/choiceList/);
  });

  it('treats a rectangle, line or arc draw as geometry and refuses an image', () => {
    expect(leafText(el('<draw><value><rectangle/></value></draw>')).kind).toBe('geometry');
    expect(leafText(el('<draw><value><line/></value></draw>')).kind).toBe('geometry');
    expect(leafText(el('<draw><value><image/></value></draw>')).refusal).toMatch(/image/);
  });

  it('never throws on junk', () => {
    expect(() => leafText(el('<draw><font size="huge"/><value><text>a</text></value></draw>'))).not.toThrow();
    expect(leafText(el('<draw><font size="huge"/><value><text>a</text></value></draw>')).refusal).toMatch(/size/);
  });
});

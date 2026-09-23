import { describe, it, expect } from 'vitest';
import { applyStyle, parseRichText, faceOf, richTextBody, styleFromFace, type RichStyle } from '../src/richlayout.js';

const BASE: RichStyle = styleFromFace('Helvetica', 12, [0, 0, 0], 'left');
const runs = (markup: string, ds?: string) =>
  (parseRichText(markup, ds, BASE) ?? []).map((p) => p.runs.map((r) => ({ t: r.text, f: r.face, s: r.size, c: r.color, u: r.underline, x: r.strike })));
const texts = (markup: string) => (parseRichText(markup, undefined, BASE) ?? []).map((p) => p.runs.map((r) => r.text).join(''));

describe('faces', () => {
  it('maps family and style to the 12 Standard-14 text faces', () => {
    expect(faceOf({ ...BASE, family: 'Times', bold: true, italic: true })).toBe('Times-BoldItalic');
    expect(faceOf({ ...BASE, family: 'Courier', italic: true })).toBe('Courier-Oblique');
    expect(faceOf({ ...BASE, bold: true })).toBe('Helvetica-Bold');
  });
  it('styleFromFace reads family and style back out of a face', () => {
    const s = styleFromFace('Times-Italic', 9, [1, 0, 0], 'center');
    expect([s.family, s.bold, s.italic, s.size, s.align]).toEqual(['Times', false, true, 9, 'center']);
    expect(styleFromFace('Symbol', 9, [0, 0, 0], 'left').family).toBe('Helvetica');
  });
});

describe('applyStyle', () => {
  it('font-size in pt, px, em, percent and unitless', () => {
    expect(applyStyle('font-size: 10pt', BASE).size).toBe(10);
    expect(applyStyle('font-size: 16px', BASE).size).toBe(12);
    expect(applyStyle('font-size: 2em', BASE).size).toBe(24);
    expect(applyStyle('font-size: 50%', BASE).size).toBe(6);
    expect(applyStyle('font-size: 9', BASE).size).toBe(9);
  });
  it('ignores a size it cannot read, keeping the inherited one', () => {
    expect(applyStyle('font-size: large', BASE).size).toBe(12);
    expect(applyStyle('font-size: -3pt', BASE).size).toBe(12);
  });
  it('font-weight and font-style', () => {
    expect(applyStyle('font-weight: bold', BASE).bold).toBe(true);
    expect(applyStyle('font-weight: 700', BASE).bold).toBe(true);
    expect(applyStyle('font-weight: 500', BASE).bold).toBe(false);
    expect(applyStyle('font-weight: normal', { ...BASE, bold: true }).bold).toBe(false);
    expect(applyStyle('font-style: oblique', BASE).italic).toBe(true);
  });
  it('font-family takes the FIRST name it recognises', () => {
    expect(applyStyle('font-family: Garamond, "Times New Roman", Courier', BASE).family).toBe('Times');
    expect(applyStyle('font-family: monospace', BASE).family).toBe('Courier');
    expect(applyStyle('font-family: Arial', { ...BASE, family: 'Times' }).family).toBe('Helvetica');
  });
  it('a family named after an Object.prototype member is unrecognised, not a lookup', () => {
    // A family name comes from the document; `in` would find `constructor`.
    expect(applyStyle('font-family: constructor', { ...BASE, family: 'Courier' }).family).toBe('Courier');
  });
  it('an unrecognised family list keeps what the run inherited', () => {
    expect(applyStyle('font-family: Garamond, Palatino', { ...BASE, family: 'Courier' }).family).toBe('Courier');
  });
  it('the font shorthand, including Acrobat\'s family-before-size order', () => {
    const a = applyStyle('font: italic bold 14pt Times', BASE);
    expect([a.italic, a.bold, a.size, a.family]).toEqual([true, true, 14, 'Times']);
    const b = applyStyle('font: Courier,monospace 9.0pt', BASE);
    expect([b.family, b.size]).toEqual(['Courier', 9]);
  });
  it('color in hex, rgb() and names; transparent is ignored', () => {
    expect(applyStyle('color: #FF0000', BASE).color).toEqual([1, 0, 0]);
    expect(applyStyle('color: rgb(0, 0, 255)', BASE).color).toEqual([0, 0, 1]);
    expect(applyStyle('color: green', BASE).color[1]).toBeGreaterThan(0.4);
    expect(applyStyle('color: transparent', BASE).color).toEqual([0, 0, 0]);
  });
  it('text-align and text-decoration', () => {
    expect(applyStyle('text-align: right', BASE).align).toBe('right');
    expect(applyStyle('text-align: end', BASE).align).toBe('right');
    const d = applyStyle('text-decoration: underline line-through', BASE);
    expect([d.underline, d.strike]).toEqual([true, true]);
    expect(applyStyle('text-decoration: none', d).underline).toBe(false);
  });
  it('a malformed declaration list costs only what it broke', () => {
    const s = applyStyle('font-size: ; color: #00F; nonsense', BASE);
    expect(s.color).toEqual([0, 0, 1]);
    expect(s.size).toBe(12);
  });
});

describe('parseRichText', () => {
  it('b and i set weight and style; span styles a run', () => {
    expect(runs('<p>a <b>b</b> <i>c</i> <span style="color:#FF0000">d</span></p>')).toEqual([[
      { t: 'a ', f: 'Helvetica', s: 12, c: [0, 0, 0], u: false, x: false },
      { t: 'b', f: 'Helvetica-Bold', s: 12, c: [0, 0, 0], u: false, x: false },
      { t: ' ', f: 'Helvetica', s: 12, c: [0, 0, 0], u: false, x: false },
      { t: 'c', f: 'Helvetica-Oblique', s: 12, c: [0, 0, 0], u: false, x: false },
      { t: ' ', f: 'Helvetica', s: 12, c: [0, 0, 0], u: false, x: false },
      { t: 'd', f: 'Helvetica', s: 12, c: [1, 0, 0], u: false, x: false },
    ]]);
  });
  it('each <p> is a paragraph; <br> is a line break inside one', () => {
    expect(texts('<p>one</p><p>two<br/>three</p>')).toEqual(['one', 'two\nthree']);
  });
  it('several top-level elements all survive (the synthetic root)', () => {
    expect(texts('<p>a</p><p>b</p><p>c</p>')).toEqual(['a', 'b', 'c']);
  });
  it('collapses whitespace like XHTML, never doubling a space across runs', () => {
    expect(texts('<p>\n  a   <b> b </b>  c\n</p>')).toEqual(['a b c']);
  });
  it('an unknown element is transparent: its text is kept', () => {
    expect(texts('<p>x<font color="red">y</font>z</p>')).toEqual(['xyz']);
  });
  it('/DS applies beneath everything, and element style beats it', () => {
    const r = runs('<p>a<span style="font-size:20pt">b</span></p>', 'font: Times 10pt; color:#0000FF');
    expect(r[0][0]).toMatchObject({ f: 'Times-Roman', s: 10, c: [0, 0, 1] });
    expect(r[0][1]).toMatchObject({ f: 'Times-Roman', s: 20, c: [0, 0, 1] });
  });
  it('inherits down the tree', () => {
    const r = runs('<body style="font-family:Courier"><p style="font-weight:bold">a<i>b</i></p></body>');
    expect(r[0].map((x) => x.f)).toEqual(['Courier-Bold', 'Courier-BoldOblique']);
  });
  it('a paragraph takes its own text-align', () => {
    const p = parseRichText('<p style="text-align:center">a</p><p>b</p>', undefined, BASE)!;
    expect(p.map((x) => x.align)).toEqual(['center', 'left']);
  });
  it('an unknown family on a span keeps what it inherited', () => {
    const r = runs('<p style="font-family:Times">a<span style="font-family:Wingdings">b</span></p>');
    expect(r[0].map((x) => x.f)).toEqual(['Times-Roman']); // merged: same style
    expect(texts('<p style="font-family:Times">a<span style="font-family:Wingdings">b</span></p>')).toEqual(['ab']);
  });
  it('drops empty paragraphs', () => {
    expect(texts('<p>a</p><p>  </p><p>b</p>')).toEqual(['a', 'b']);
  });
  it('markup that will not parse is undefined, never a regex strip', () => {
    expect(parseRichText('<p>unclosed', undefined, BASE)).toBeUndefined();
    expect(parseRichText('<p><b>x</p></b>', undefined, BASE)).toBeUndefined();
  });
  it('markup with no text is an empty list', () => {
    expect(parseRichText('<p></p>', undefined, BASE)).toEqual([]);
  });
});


// `inset` is the WHOLE inset since v0tz.5 — richTextBody no longer adds the
// appearance PAD itself, so that appearance.ts may import this module without
// closing a 2-cycle. Passing 1 + PAD keeps every expectation below measuring
// exactly what it measured before, which is what makes that a pure refactor.
const body = (markup: string, w = 200, h = 100) => richTextBody(parseRichText(markup, undefined, BASE)!, w, h, 1 + 2);

describe('richTextBody', () => {
  it('names each face once, F0 upward in order of first use', () => {
    const r = body('<p>a <b>b</b> <i>c</i> d <b>e</b></p>');
    expect([...r.faces]).toEqual([['F0', 'Helvetica'], ['F1', 'Helvetica-Bold'], ['F2', 'Helvetica-Oblique']]);
    for (const k of ['F0', 'F1', 'F2']) expect(r.body).toContain(`/${k} 12 Tf`);
  });
  it('shows each run in its own colour', () => {
    const r = body('<p>a <span style="color:#FF0000">b</span></p>');
    expect(r.body).toMatch(/1 0 0 rg\s+\(b\) Tj/);
  });
  it('starts each paragraph on a new line, top-anchored', () => {
    const r = body('<p>one</p><p>two</p>');
    const ys = [...r.body.matchAll(/1 0 0 1 [\d.]+ ([\d.]+) Tm/g)].map((m) => Number(m[1]));
    expect(ys.length).toBe(2);
    expect(ys[0]).toBeGreaterThan(ys[1]);
    expect(ys[0]).toBeLessThan(100);
  });
  it('a larger run makes its line taller', () => {
    const plain = body('<p>a</p><p>b</p>');
    const big = body('<p>a<span style="font-size:30pt">A</span></p><p>b</p>');
    const gap = (r: { body: string }) => {
      const ys = [...r.body.matchAll(/1 0 0 1 [\d.]+ ([\d.]+) Tm/g)].map((m) => Number(m[1]));
      return ys[0] - ys[1];
    };
    expect(gap(big)).toBeGreaterThan(gap(plain));
  });
  it('aligns each paragraph by its own text-align', () => {
    const xs = (m: string) => [...body(m).body.matchAll(/1 0 0 1 ([\d.]+) [\d.]+ Tm/g)].map((x) => Number(x[1]));
    const left = xs('<p>ab</p>')[0], centre = xs('<p style="text-align:center">ab</p>')[0], right = xs('<p style="text-align:right">ab</p>')[0];
    expect(left).toBeLessThan(centre);
    expect(centre).toBeLessThan(right);
  });
  it('the Tw in force when a justified paragraph shows its LAST line is 0', () => {
    // Walk the body tracking Tw; the trailing reset is after the last Tj, so a
    // check on the last Tw operator alone cannot see a justified last line.
    const words = 'lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor';
    const lines = body(`<p style="text-align:justify">${words}</p>`, 120, 200).body.split('\n');
    let tw = 0, atLastTj = -1;
    for (const l of lines) {
      const m = /^([\d.]+) Tw$/.exec(l);
      if (m) tw = Number(m[1]);
      if (/ Tj$/.test(l)) atLastTj = tw;
    }
    expect(atLastTj).toBe(0);
  });

  it('a line\'s baseline sits its largest run size below the band top', () => {
    // Box 200x100, inset 1, PAD 2: the first band top is 97, so a 30pt run
    // puts the first baseline at 67 — not at 97 minus the paragraph's 12pt.
    const r = body('<p>a<span style="font-size:30pt">A</span></p>');
    const y = Number(/1 0 0 1 [\d.]+ ([\d.]+) Tm/.exec(r.body)![1]);
    expect(y).toBe(67);
  });

  it('justifies with Tw, and never the last line of a paragraph', () => {
    const words = 'lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor';
    const r = body(`<p style="text-align:justify">${words}</p>`, 120, 200);
    const tws = [...r.body.matchAll(/([\d.]+) Tw/g)].map((m) => Number(m[1]));
    expect(tws.some((t) => t > 0)).toBe(true);
    expect(r.body.trimEnd().split('\n').filter((l) => / Tw$/.test(l)).pop()).toBe('0 Tw');
  });
  it('underline and line-through are filled rects in the run colour', () => {
    const u = body('<p><span style="text-decoration:underline;color:#0000FF">x</span></p>');
    expect(u.body).toMatch(/0 0 1 rg [\d.-]+ [\d.-]+ [\d.]+ [\d.]+ re f/);
    const plainBody = body('<p>x</p>');
    expect(plainBody.body).not.toContain(' re f');
  });
  it('wraps a paragraph wider than the box', () => {
    const r = body('<p>aaaa bbbb cccc dddd eeee ffff gggg hhhh</p>', 60, 200);
    expect([...r.body.matchAll(/ Tm/g)].length).toBeGreaterThan(2);
  });
});

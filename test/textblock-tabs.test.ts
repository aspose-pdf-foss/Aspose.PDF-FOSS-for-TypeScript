// test/textblock-tabs.test.ts
import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { PageFormat } from '../src/pageformat.js';
import { visitContent, type GlyphEvent } from '../src/text.js';
import { parseContentStream } from '../src/content.js';

const glyphs = (d: Document) => { const out: GlyphEvent[] = []; visitContent(d, d.Pages[0], { glyph: (g) => out.push(g) }); return out; };
const xOf = (d: Document, ch: string) => glyphs(d).find((g) => g.text === ch)!.quad[0];
const block = (text: string, o: object = {}, rect: [number, number, number, number] = [72, 600, 300, 100]) => {
  const d = Document.New(PageFormat.A4);
  d.Pages[0].AddTextBlock(text, rect, { font: 'Courier', fontSize: 10, ...o });
  return Document.Open(d.Save());
};

describe('AddTextBlock tab stops (v9j3.1)', () => {
  it('places the text after a tab on its stop', () => {
    const d = block('ab\tZ', { tabStops: [{ position: 100 }] });
    expect(xOf(d, 'Z')).toBeCloseTo(172, 3);
  });
  it('right, center and decimal stops, measured from the rect edge', () => {
    expect(xOf(block('a\tXYZ', { tabStops: [{ position: 100, align: 'right' }] }), 'Z')).toBeCloseTo(72 + 100 - 6, 3);
    expect(xOf(block('a\t12.5', { tabStops: [{ position: 100, align: 'decimal' }] }), '.')).toBeCloseTo(172, 3);
  });
  it('without tabStops, a tab is unchanged: byte-identical to before', () => {
    const d1 = Document.New(PageFormat.A4); d1.Pages[0].AddTextBlock('ab\tcd', [72, 600, 300, 100], { fontSize: 10 });
    const d2 = Document.New(PageFormat.A4); d2.Pages[0].AddTextBlock('ab\tcd', [72, 600, 300, 100], { fontSize: 10, tabStops: undefined });
    expect(d2.Pages[0].Contents).toEqual(d1.Pages[0].Contents);
  });
  it('a dot leader fills the gap, right-aligned against the next text', () => {
    const d = block('ab\tZ', { tabStops: [{ position: 100, leader: 'dot' }] });
    const dots = glyphs(d).filter((g) => g.text === '.');
    expect(dots.length).toBeGreaterThan(5);
    const last = dots[dots.length - 1];
    expect(last.penEnd[0]).toBeCloseTo(172 - 2.5, 3);              // a quarter-em clear before 'Z'
  });
  it('a line leader draws a rule and no glyphs', () => {
    const d = block('ab\tZ', { tabStops: [{ position: 100, leader: 'line' }] });
    expect(glyphs(d).map((g) => g.text).join('')).toBe('abZ');
    expect(parseContentStream(d.Pages[0].Contents).some((o) => o.operator === 're')).toBe(true);
  });
  it('leaders are /Artifact in a tagged block, outside its structure sequence', () => {
    const d = Document.New(PageFormat.A4);
    d.Lang = 'en';
    const p = d.CreateStructTree().Append('P');
    d.Pages[0].AddTextBlock('ab\tZ', [72, 600, 300, 100], { font: 'Courier', fontSize: 10, tag: p, tabStops: [{ position: 100, leader: 'dot' }] });
    const doc = Document.Open(d.Save());
    const s = new TextDecoder('latin1').decode(doc.Pages[0].Contents);
    expect(s).toMatch(/\/Artifact BMC[^]*\(\.+\) Tj[^]*EMC/);
    expect(doc.ValidatePdfUa().Issues.filter((i) => i.rule === 'UntaggedContent')).toEqual([]);
  });
  it('GetText reads a tab gap as a space', () => {
    expect(block('Name\tValue', { tabStops: [{ position: 100 }] }).Pages[0].GetText()).toBe('Name Value');
  });
  it('justified text spreads Tw only after the last tab', () => {
    // A space BEFORE the tab: Tw in force there would push the stop's text right.
    const t = 'a b\tx y z w v u t s r q p o n m l k j i h g f e d c b a z y x w';
    const d = block(t, { align: 'justify', tabStops: [{ position: 100 }] }, [72, 600, 200, 100]);
    // 'x' after the tab stays on the stop, however much Tw the line gets.
    expect(xOf(d, 'x')).toBeCloseTo(172, 3);
    // …and the slack is taken by the spaces AFTER the tab alone, so the line
    // still ends on the right edge: counting the space before the tab too
    // spreads too little and leaves the line short.
    const gs = glyphs(d);
    const base = gs.find((g) => g.text === 'x')!.quad[1];
    const last = Math.max(...gs.filter((g) => Math.abs(g.quad[1] - base) < 0.01).map((g) => g.quad[2]));
    expect(last).toBeCloseTo(272, 1);
  });
  it('an underline spans the tab gap; a link rect stops at its last glyph', () => {
    const d = Document.New(PageFormat.A4);
    d.Pages[0].AddTextBlock([{ text: 'ab\tcd', underline: true, link: 'https://example.com' }], [72, 600, 300, 100],
      { font: 'Courier', fontSize: 10, tabStops: [{ position: 100 }] });
    const doc = Document.Open(d.Save());
    // One `re` per segment box, so the underline is their union: 72 to the
    // end of 'cd', with no hole over the tab gap.
    const rules = parseContentStream(doc.Pages[0].Contents).filter((o) => o.operator === 're')
      .map((o) => o.operands as number[]).sort((a, b) => a[0] - b[0]);
    expect(rules[0][0]).toBeCloseTo(72, 3);
    for (let i = 1; i < rules.length; i++) expect(rules[i][0]).toBeCloseTo(rules[i - 1][0] + rules[i - 1][2], 3);
    expect(rules[rules.length - 1][0] + rules[rules.length - 1][2]).toBeCloseTo(184, 3);
    // The link reaches the end of 'cd'; no rect is made for the tab gap alone.
    const links = doc.Pages[0].Annotations.filter((a) => a.Subtype === 'Link').map((a) => a.Dict.get('Rect') as number[]);
    expect(Math.max(...links.map((r) => r[2]))).toBeCloseTo(184, 3);
    expect(links.every((r) => r[2] - r[0] < 100)).toBe(true);
  });
  it('a remainder carries its tabs to the next block and re-resolves them', () => {
    const d = Document.New(PageFormat.A4);
    const rest = d.Pages[0].AddTextBlock('a\tb\nc\tZ', [72, 600, 300, 12], { font: 'Courier', fontSize: 10, leading: 12, tabStops: [{ position: 100 }] });
    expect(rest).not.toBeNull();
    d.Pages[0].AddTextBlock(rest as string, [72, 400, 300, 100], { font: 'Courier', fontSize: 10, tabStops: [{ position: 100 }] });
    expect(xOf(Document.Open(d.Save()), 'Z')).toBeCloseTo(172, 3);
  });
  it('refuses bad options before drawing, and refuses shaping', () => {
    const d = Document.New(PageFormat.A4);
    const before = d.Pages[0].Contents;
    expect(() => d.Pages[0].AddTextBlock('a\tb', [72, 600, 300, 100], { tabStops: [{ position: -1 }] })).toThrow(RangeError);
    expect(() => d.Pages[0].AddTextBlock('a\tb', [72, 600, 300, 100], { tabStops: [{ position: 1 }], shape: true })).toThrow(TypeError);
    expect(d.Pages[0].Contents).toEqual(before);
  });
});

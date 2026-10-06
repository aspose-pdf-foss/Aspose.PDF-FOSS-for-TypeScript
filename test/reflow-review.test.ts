// Shapes the final review of u3l5.5 found that no producer fixture had built.
import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { PageFormat } from '../src/pageformat.js';
import { visitContent, type GlyphEvent } from '../src/text.js';
import type { UnreflowableText } from '../src/replacefont.js';
import { isDict, isStream } from '../src/types.js';
import { buildSimpleTextPdf, buildFormTextPdf } from './helpers/build-text-pdf.js';

const glyphs = (doc: Document): GlyphEvent[] => {
  const out: GlyphEvent[] = [];
  visitContent(doc, doc.Pages[0], { glyph: (g) => out.push(g) });
  return out;
};
/** [text, x, baseline] of each glyph drawing text, in content order. */
const at = (doc: Document) => glyphs(doc).filter((g) => g.text.trim()).map((g) => [g.text, +g.quad[0].toFixed(3), +g.quad[1].toFixed(3)] as const);

describe('reflow review findings (u3l5.5)', () => {
  it('keeps the TJ kerns of lines it does not move (C1)', () => {
    const s = 'BT /F1 12 Tf 20 280 Td [(alpha) -250 (beta) -250 (gamma)] TJ 0 -14 Td [(delta) -250 (epsilon) -250 (zeta)] TJ '
      + '0 -14 Td [(eta) -250 (theta)] TJ ET';
    const before = at(Document.Open(buildSimpleTextPdf(s)));
    const doc = Document.Open(buildSimpleTextPdf(s));
    doc.Pages[0].ReplaceText('zeta', 'ZZ', { adjust: 'reflow' });
    const after = at(doc);
    // "ZZ" is narrower and moves no break: the lines above and below it, and
    // the edited line up to the edit, stay exactly where they were.
    const line = (xs: typeof before, y: number) => xs.filter(([, , b]) => b === y);
    expect(line(after, 280)).toEqual(line(before, 280));
    expect(line(after, 252)).toEqual(line(before, 252));
    expect(line(after, 266).slice(0, 12)).toEqual(line(before, 266).slice(0, 12));
  });

  it('keeps kerning INSIDE a word that moves to another line (C1)', () => {
    const s = 'BT /F1 12 Tf 20 280 Td [(aaaa bbbb cccc dddd)] TJ 0 -14 Td [(eeee T) 80 (oy gg)] TJ 0 -14 Td (hhhh) Tj ET';
    const doc = Document.Open(buildSimpleTextPdf(s));
    const T0 = glyphs(doc).find((g) => g.text === 'T')!, o0 = glyphs(doc).find((g) => g.text === 'o')!;
    const kerned = o0.quad[0] - T0.quad[0];
    doc.Pages[0].ReplaceText('eeee', 'eeeeeeeeeeeeeeee', { adjust: 'reflow' });
    const T1 = glyphs(doc).find((g) => g.text === 'T')!, o1 = glyphs(doc).find((g) => g.text === 'o')!;
    expect(T1.quad[1]).toBeCloseTo(280 - 28, 3);   // "Toy" moved down a line
    expect(o1.quad[0] - T1.quad[0]).toBeCloseTo(kerned, 3);
  });

  it('refuses two columns sharing baselines rather than merging them (C2)', () => {
    const left = 'BT /F1 12 Tf 10 280 Td (one two) Tj 0 -14 Td (three alpha) Tj 0 -14 Td (beta four) Tj ET';
    const right = 'BT /F1 12 Tf 160 280 Td (five six) Tj 0 -14 Td (seven eight) Tj 0 -14 Td (nine ten) Tj ET';
    const doc = Document.Open(buildSimpleTextPdf(`${left} ${right}`));
    const rightBefore = at(doc).filter(([, x]) => x >= 160);
    const seen: UnreflowableText[] = [];
    doc.Pages[0].ReplaceText('beta', 'betabetabeta', { adjust: 'reflow', onUnreflowable: (r) => seen.push(r) });
    expect(seen.map((r) => r.reason)).toEqual(['foreign-ink']);
    expect(at(doc).filter(([, x]) => x >= 160)).toEqual(rightBefore);
  });

  it('refuses unequal axis scale (C3)', () => {
    const doc = Document.Open(buildSimpleTextPdf('BT /F1 12 Tf 2 0 0 1 20 280 Tm (alpha beta gamma) Tj 0 -14 Td (delta epsilon) Tj ET'));
    const seen: UnreflowableText[] = [];
    doc.Pages[0].ReplaceText('beta', 'BBBBBBBBBB', { adjust: 'reflow', onUnreflowable: (r) => seen.push(r) });
    expect(seen.map((r) => r.reason)).toEqual(['rotated']);
  });

  it('reflows a form drawn twice once, so both drawings agree (I1)', () => {
    const doc = Document.Open(buildFormTextPdf('q 1 0 0 1 0 150 cm /Fm0 Do Q q /Fm0 Do Q',
      'BT /F1 12 Tf 10 100 Td (alpha beta gamma) Tj 0 -14 Td (delta epsilon) Tj ET'));
    doc.Pages[0].ReplaceText('beta', 'betabetabetabeta', { adjust: 'reflow' });
    const gs = at(doc);
    const top = gs.filter(([, , y]) => y > 150).map(([t, x, y]) => [t, x, +(y - 150).toFixed(3)]);
    const bottom = gs.filter(([, , y]) => y <= 150);
    expect(top).toEqual(bottom);
    // Every line still starts at the form's own margin.
    const lineStarts = new Map<number, number>();
    for (const [, x, y] of bottom) lineStarts.set(y, Math.min(lineStarts.get(y) ?? Infinity, x));
    for (const x of lineStarts.values()) expect(x).toBeCloseTo(10, 3);
  });

  it('regenerates a moved highlight appearance to its new rect (I2)', () => {
    const d = Document.New(PageFormat.A4);
    d.Pages[0].AddTextBlock('The quick brown fox jumps over the lazy dog and then keeps running far away into the woods', [72, 400, 200, 300], { fontSize: 12 });
    const doc = Document.Open(d.Save());
    const m = doc.Pages[0].Search('lazy dog')[0];
    doc.Pages[0].AddHighlight({ quads: m.quads.flatMap(([x0, y0, x1, y1]) => [x0, y1, x1, y1, x0, y0, x1, y0]) });
    // lazy|dog now wrap apart, so the rect becomes two lines tall.
    doc.Pages[0].ReplaceText('jumps', 'jumps and jumps and', { adjust: 'reflow' });
    const hl = doc.Pages[0].Annotations.find((a) => a.Subtype === 'Highlight')!;
    const rect = hl.Rect!;
    const ap = doc.resolve(hl.Dict.get('AP'));
    const n = isDict(ap) ? doc.resolve(ap.get('N')) : undefined;
    expect(isStream(n)).toBe(true);
    const bbox = doc.resolve((n as { dict: Map<string, unknown> }).dict.get('BBox') as never) as number[];
    // The appearance is drawn over the new rect, not stretched from the old one.
    expect(bbox[2] - bbox[0]).toBeCloseTo(rect[2] - rect[0], 3);
    expect(bbox[3] - bbox[1]).toBeCloseTo(rect[3] - rect[1], 3);
  });
});

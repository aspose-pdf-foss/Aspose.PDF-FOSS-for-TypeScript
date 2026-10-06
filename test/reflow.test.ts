import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { PageFormat } from '../src/pageformat.js';
import { UnsupportedFeatureError } from '../src/errors.js';
import { pageLayout } from '../src/textedit.js';
import { visitContent, type GlyphEvent } from '../src/text.js';
import type { UnreflowableText } from '../src/replacefont.js';
import { parseContentStream } from '../src/content.js';
import { buildSimpleTextPdf, buildFormTextPdf } from './helpers/build-text-pdf.js';

const BOX: [number, number, number, number] = [72, 400, 200, 300];
const T = 'The quick brown fox jumps over the lazy dog and then keeps running far away into the woods';
type Align = 'left' | 'justify' | 'center' | 'right';
const block = (text: string, opts: { align?: Align; width?: number } = {}) => {
  const d = Document.New(PageFormat.A4);
  const { width, ...rest } = opts;
  d.Pages[0].AddTextBlock(text, [BOX[0], BOX[1], width ?? BOX[2], BOX[3]], { fontSize: 12, ...rest });
  return Document.Open(d.Save());
};
/** The box a reflow can know: as wide as the paragraph's widest line. A
 *  ragged producer box wider than that is not on the page; a justified one
 *  is, since its lines reach it. */
const measured = (doc: Document): number =>
  Math.max(...doc.Pages[0].GetStructuredText().flatMap((b) => b.lines.map((l) => l.quad[2]))) - BOX[0] + 1e-3;
/** A replacement is ONE unbreakable unit whose own spaces are not stretched
 *  (the spec); in a fresh block that is the same text with U+00A0 for its
 *  spaces — the same advance, never a break, never given Tw. */
const unit = (s: string) => s.replace(/ /g, '\u00a0');
/** A fresh block of `text` in the box `original`'s paragraph shows. */
const oracle = (original: Document, text: string, align: Align = 'left') =>
  block(text, { align, ...(align === 'justify' ? {} : { width: measured(original) }) });
/** Non-space glyph origins in reading order, as [char, x, baseline]. */
const origins = (doc: Document) => {
  const { text, refs } = pageLayout(doc, doc.Pages[0], {});
  const out: [string, number, number][] = [];
  let last;
  for (let i = 0; i < text.length; i++) {
    const g = refs[i];
    if (!g || g === last || g.text.trim() === '') continue;
    last = g;
    out.push([g.text, g.quad[0], g.quad[1]]);
  }
  return out;
};
const same = (a: [string, number, number][], b: [string, number, number][]) => {
  expect(a.map((x) => x[0]).join('')).toBe(b.map((x) => x[0]).join(''));
  a.forEach((x, i) => { expect(x[1]).toBeCloseTo(b[i][1], 3); expect(x[2]).toBeCloseTo(b[i][2], 3); });
};

describe("adjust: 'reflow' — the AddTextBlock oracle (u3l5.5)", () => {
  for (const align of ['left', 'justify'] as const) {
    it(`a longer replacement re-wraps like a fresh block (${align})`, () => {
      // Justified: a replacement's OWN space keeps the Tw in force where it
      // was written (reflow never rewrites Tw), so the oracle there uses one
      // with no space in it.
      const R = align === 'justify' ? 'remarkablyquick' : 'remarkably quick';
      const doc = block(T, { align });
      doc.Pages[0].ReplaceText('quick', R, { adjust: 'reflow' });
      same(origins(doc), origins(oracle(block(T, { align }), T.replace('quick', unit(R)), align)));
    });
    it(`a shorter replacement pulls later lines up (${align})`, () => {
      const doc = block(T, { align });
      doc.Pages[0].ReplaceText('quick brown fox jumps over the', 'cat', { adjust: 'reflow' });
      same(origins(doc), origins(oracle(block(T, { align }), T.replace('quick brown fox jumps over the', 'cat'), align)));
    });
  }
  it('reflows after a match on the last line too', () => {
    const doc = block(T);
    doc.Pages[0].ReplaceText('woods', 'woods and over the hills', { adjust: 'reflow' });
    same(origins(doc), origins(oracle(block(T), T.replace('woods', unit('woods and over the hills')))));
  });
});

describe("adjust: 'reflow' — producer shapes (u3l5.5)", () => {
  const LINES = 'BT /F1 12 Tf 20 280 Td (alpha beta gamma) Tj 0 -14 Td (delta epsilon zeta) Tj 0 -14 Td (eta theta iota) Tj ET';
  it('re-wraps lines placed by Td, keeping the box width', () => {
    const doc = Document.Open(buildSimpleTextPdf(LINES));
    doc.Pages[0].ReplaceText('beta', 'betabetabetabeta', { adjust: 'reflow' });
    const t = doc.Pages[0].GetText().split('\n');
    expect(t[0]).toBe('alpha');
    expect(t.join(' ')).toBe('alpha betabetabetabeta gamma delta epsilon zeta eta theta iota');
  });
  it("re-wraps lines placed by ' and by T*", () => {
    for (const s of [
      "BT /F1 12 Tf 14 TL 20 280 Td (alpha beta gamma) Tj (delta epsilon zeta) ' (eta theta iota) ' ET",
      'BT /F1 12 Tf 14 TL 20 280 Td (alpha beta gamma) Tj T* (delta epsilon zeta) Tj T* (eta theta iota) Tj ET',
    ]) {
      const doc = Document.Open(buildSimpleTextPdf(s));
      doc.Pages[0].ReplaceText('beta', 'betabetabetabeta', { adjust: 'reflow' });
      expect(doc.Pages[0].GetText().split(/\s+/).join(' ')).toBe('alpha betabetabetabeta gamma delta epsilon zeta eta theta iota');
      // The re-wrap itself: without it "alpha betabetabetabeta gamma" stays
      // one over-wide line, and the word order above reads the same.
      expect(doc.Pages[0].GetText().split('\n')[0]).toBe('alpha');
    }
  });
  it('leaves the next paragraph in the text object where it was', () => {
    const s = `${LINES.replace(' ET', '')} 0 -60 Td (next paragraph here) Tj ET`;
    const before = Document.Open(buildSimpleTextPdf(s));
    const n0 = before.Pages[0].Search('next')[0].quads[0];
    const doc = Document.Open(buildSimpleTextPdf(s));
    doc.Pages[0].ReplaceText('beta', 'betabetabetabeta', { adjust: 'reflow' });
    expect(doc.Pages[0].Search('next')[0].quads[0]).toEqual(n0);
  });
  it('keeps a raised word raised on the line it moves to', () => {
    // "ffff" is drawn 4pt up (Ts 4). Growing "eeee" pushes it to START the
    // next line, where it gets a Tm of its own — solved from a quad that
    // includes the rise, so the target must include it too. A raised glyph
    // that only FOLLOWS in a chain keeps its Ts and cannot see this.
    const doc = Document.Open(buildSimpleTextPdf('BT /F1 12 Tf 20 280 Td (aaaa bbbb cccc dddd) Tj 0 -14 Td (eeee ) Tj '
      + '4 Ts (ffff) Tj 0 Ts ( gg) Tj 0 -14 Td (hhhh) Tj ET'));
    doc.Pages[0].ReplaceText('eeee', 'eeeeeeeeeeeeeeee', { adjust: 'reflow' });
    const gs: GlyphEvent[] = [];
    visitContent(doc, doc.Pages[0], { glyph: (g) => gs.push(g) });
    const f = gs.find((g) => g.text === 'f')!, g0 = gs.find((g) => g.text === 'g')!;
    expect(f.quad[0]).toBeCloseTo(20, 3);
    expect(g0.quad[1]).toBeCloseTo(280 - 2 * 14, 3);
    expect(f.quad[1]).toBeCloseTo(g0.quad[1] + 4, 3);
  });

  it('writes no Tm for a converged line its own BT already places', () => {
    // One BT per line, each placed by an absolute Tm. "ffff" moves down a
    // line (our Tm), "gg hh" joins it, and the long word converges on its own
    // line with no shift: after its BT, nothing of ours is in force, so it
    // needs nothing.
    const doc = Document.Open(buildSimpleTextPdf([
      'BT /F1 12 Tf 1 0 0 1 20 280 Tm (aaaa bbbb cccc dddd) Tj ET',
      'BT /F1 12 Tf 1 0 0 1 20 266 Tm (eeee ffff) Tj ET',
      'BT /F1 12 Tf 1 0 0 1 20 252 Tm (gg hh) Tj ET',
      'BT /F1 12 Tf 1 0 0 1 20 238 Tm (gggggggggggggggg) Tj ET',
    ].join(' ')));
    doc.Pages[0].ReplaceText('eeee', 'eeeeeeeeeeeeeeee', { adjust: 'reflow' });
    expect(doc.Pages[0].GetText().split('\n')).toEqual(['aaaa bbbb cccc dddd', 'eeeeeeeeeeeeeeee', 'ffff gg hh', 'gggggggggggggggg']);
    const ops = parseContentStream(doc.Pages[0].Contents);
    const at = ops.findIndex((o) => o.operator === 'Tj' && new TextDecoder().decode((o.operands[0] as { bytes: Uint8Array }).bytes) === 'gggggggggggggggg');
    let bt = at;
    while (ops[bt].operator !== 'BT') bt--;
    expect(ops.slice(bt).map((o) => o.operator)).toEqual(['BT', 'Tf', 'Tm', 'Tj', 'ET']);
  });

  it('writes nothing when no break moves', () => {
    const a = Document.Open(buildSimpleTextPdf(LINES));
    const b = Document.Open(buildSimpleTextPdf(LINES));
    a.Pages[0].ReplaceText('beta', 'bet');
    b.Pages[0].ReplaceText('beta', 'bet', { adjust: 'reflow' });
    // Only kerns/Tm where a word must move; "bet" moves nothing across a line.
    expect(b.Pages[0].GetText()).toBe(a.Pages[0].GetText());
  });
});

describe("adjust: 'reflow' — refusals (u3l5.5)", () => {
  // "below" sits 26pt under the paragraph's last baseline: past the 1.6-line
  // block split (so it is NOT a member) but inside the line the growth needs.
  const roomless = 'BT /F1 12 Tf 20 280 Td (alpha beta gamma) Tj 0 -14 Td (delta epsilon zeta) Tj ET BT /F1 12 Tf 20 240 Td (below) Tj ET';
  it('refuses when the paragraph cannot grow into free space, changing nothing', () => {
    const doc = Document.Open(buildSimpleTextPdf(roomless));
    const before = doc.Save();
    expect(() => doc.Pages[0].ReplaceText('beta', 'betabetabetabetabetabeta', { adjust: 'reflow' }))
      .toThrow(UnsupportedFeatureError);
    expect(doc.Save()).toEqual(before);
  });
  it('reports with onUnreflowable and replaces without reflow', () => {
    const doc = Document.Open(buildSimpleTextPdf(roomless));
    const seen: UnreflowableText[] = [];
    doc.Pages[0].ReplaceText('beta', 'bet', { adjust: 'reflow', onUnreflowable: (r) => seen.push(r) });
    // Narrower: no line is added, so no room is needed and nothing is refused.
    expect(seen).toEqual([]);
    doc.Pages[0].ReplaceText('bet', 'betabetabetabetabetabeta', { adjust: 'reflow', onUnreflowable: (r) => seen.push(r) });
    expect(seen).toEqual([{ page: 1, match: 'bet', reason: 'no-room' }]);
    expect(doc.Pages[0].GetText()).toContain('betabetabetabetabetabeta');
  });
  it('reports one paragraph and reflows the other', () => {
    const s = 'BT /F1 12 Tf 20 280 Td (alpha beta gamma) Tj 0 -14 Td (delta epsilon zeta) Tj ET ' +
      'BT /F1 12 Tf 0 1 -1 0 250 20 Tm (beta) Tj ET';
    const doc = Document.Open(buildSimpleTextPdf(s));
    const seen: UnreflowableText[] = [];
    expect(doc.Pages[0].ReplaceText('beta', 'betabetabetabeta', { adjust: 'reflow', onUnreflowable: (r) => seen.push(r) })).toBe(2);
    expect(seen.map((r) => r.reason)).toEqual(['rotated']);
    expect(doc.Pages[0].GetText().split('\n')[0]).toBe('alpha');
  });
  it('refuses a paragraph spanning the page and a form', () => {
    const doc = Document.Open(buildFormTextPdf('BT /F1 12 Tf 20 250 Td (alpha beta) Tj ET /Fm0 Do', 'BT /F1 12 Tf 20 236 Td (gamma delta) Tj ET'));
    expect(() => doc.Pages[0].ReplaceText('beta', 'betabetabetabetabetabetabetabeta', { adjust: 'reflow' }))
      .toThrow(/scopes/);
  });
  it('doc.ReplaceText refuses before changing any page', () => {
    const d = Document.New(PageFormat.A4);
    d.Pages[0].AddTextBlock(T, BOX, { fontSize: 12 });
    d.AddPage();
    // One line at the page foot: the replacement pushes "gamma" below it.
    d.Pages[1].AddTextBlock('beta gamma', [72, 0, 300, 20], { fontSize: 12 });
    const doc = Document.Open(d.Save());
    const before = doc.Save();
    expect(() => doc.ReplaceText(/quick|beta/, 'remarkably long replacement words', { adjust: 'reflow' }))
      .toThrow(UnsupportedFeatureError);
    expect(doc.Save()).toEqual(before);
  });
});

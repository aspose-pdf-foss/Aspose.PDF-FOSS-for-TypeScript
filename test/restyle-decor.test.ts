import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { PageFormat } from '../src/pageformat.js';
import { UnsupportedFeatureError } from '../src/errors.js';
import { visitContent, type GlyphEvent } from '../src/text.js';
import { parseContentStream } from '../src/content.js';
import { isArray, isString } from '../src/types.js';
import { buildSimpleTextPdf, buildFormTextPdf, buildType0Pdf } from './helpers/build-text-pdf.js';
import { buildMultiStreamPage } from './helpers/build-edit-pdf.js';

const glyphs = (doc: Document): GlyphEvent[] => {
  const out: GlyphEvent[] = [];
  visitContent(doc, doc.Pages[0], { glyph: (g) => out.push(g) });
  return out;
};
/** Filled paths as [x0, y0, x1, y1, "r,g,b"], sorted. */
const fills = (doc: Document) => doc.Pages[0].GetPaths().filter((p) => p.fill)
  .map((p) => [...p.bbox.map((v) => +v.toFixed(3)), p.fill!.rgb.map((c) => +c.toFixed(3)).join(',')] as const)
  .sort((a, b) => (a[1] as number) - (b[1] as number) || (a[0] as number) - (b[0] as number));
const ops = (doc: Document) => parseContentStream(doc.Pages[0].Contents).map((o) => o.operator);
const shown = (doc: Document): string => parseContentStream(doc.Pages[0].Contents)
  .flatMap((o) => (o.operator === 'TJ' && isArray(o.operands[0]) ? o.operands[0] : o.operands))
  .filter(isString).map((s) => String.fromCharCode(...s.bytes)).join('|');
const DECOR = { underline: true, strikethrough: true, background: [1, 1, 0] as [number, number, number] };

describe('RestyleText decorations (u3l5.6)', () => {
  it('matches AddText decorating the same word', () => {
    const a = Document.New(PageFormat.A4);
    a.Pages[0].AddText('word', 72, 700, DECOR);
    const b = Document.New(PageFormat.A4);
    b.Pages[0].AddText('word', 72, 700);
    const doc = Document.Open(b.Save());
    expect(doc.Pages[0].RestyleText('word', DECOR)).toBe(1);
    const want = fills(Document.Open(a.Save())), got = fills(doc);
    expect(got.length).toBe(3);
    got.forEach((r, i) => {
      for (let k = 0; k < 4; k++) expect(r[k]).toBeCloseTo(want[i][k] as number, 3);
      expect(r[4]).toBe(want[i][4]);
    });
  });

  it('paints the background before BT and the rules after ET', () => {
    const doc = Document.Open(buildSimpleTextPdf('BT /F1 12 Tf 20 250 Td (alpha beta) Tj ET'));
    doc.Pages[0].RestyleText('beta', DECOR);
    const o = ops(doc);
    const bt = o.indexOf('BT'), et = o.indexOf('ET');
    expect(o.slice(0, bt)).toContain('re');
    expect(o.slice(et + 1).filter((x) => x === 're').length).toBe(2);
    expect(o.slice(bt, et).filter((x) => x === 're').length).toBe(0);
  });

  it('decoration only leaves every show string as it was', () => {
    const doc = Document.Open(buildSimpleTextPdf('BT /F1 12 Tf 20 250 Td (alpha beta) Tj ET'));
    const before = shown(doc);
    doc.Pages[0].RestyleText('beta', { underline: true });
    expect(shown(doc)).toBe(before);
  });

  it('decoration only never re-encodes, so it works where the text could not be', () => {
    // A Type0 font under a non-Identity CMap, which ReplaceText cannot encode into: rewriting
    // "AB" would refuse it as undrawable. A decoration rewrites nothing.
    const cmap = '1 begincodespacerange <0000> <FFFF> endcodespacerange\n2 beginbfchar <0041> <0041> <0042> <0042> endbfchar\n';
    const doc = Document.Open(buildType0Pdf('BT /F1 12 Tf 100 250 Td <00410042> Tj ET', cmap, { encoding: 'UniJIS-UCS2-H' }));
    expect(() => doc.Pages[0].RestyleText('AB', { color: [1, 0, 0] })).toThrow(UnsupportedFeatureError);
    expect(doc.Pages[0].RestyleText('AB', { underline: true })).toBe(1);
    expect(fills(doc).length).toBe(1);
  });

  it('decorates at the restyled width', () => {
    const doc = Document.Open(buildSimpleTextPdf('BT /F1 12 Tf 20 250 Td (alpha beta gamma) Tj ET'));
    doc.Pages[0].RestyleText('beta', { fontSize: 24, underline: true });
    const beta = glyphs(doc).filter((g) => 'beta'.includes(g.text) && g.fontSize > 20);
    const width = beta[beta.length - 1].penEnd[0] - beta[0].quad[0];
    const [r] = fills(doc);
    expect(r[0]).toBeCloseTo(beta[0].quad[0], 3);
    expect((r[2] as number) - (r[0] as number)).toBeCloseTo(width, 3);
  });

  it('a TJ-kerned word gets a rule under each piece', () => {
    const doc = Document.Open(buildSimpleTextPdf('BT /F1 12 Tf 20 250 Td [(wo) -150 (rd)] TJ ET'));
    doc.Pages[0].RestyleText('word', { underline: true });
    const gs = glyphs(doc);
    const rules = fills(doc);
    expect(rules.length).toBe(2);
    expect(rules[0][0]).toBeCloseTo(gs[0].quad[0], 3);
    expect(rules[1][0]).toBeCloseTo(gs[2].quad[0], 3);
  });

  it('a raised match is decorated on its baseline', () => {
    const doc = Document.Open(buildSimpleTextPdf('BT /F1 12 Tf 20 250 Td 6 Ts (sup) Tj ET'));
    doc.Pages[0].RestyleText('sup', { underline: true });
    const [r] = fills(doc);
    expect(r[3]).toBeLessThan(250);   // under the baseline, not under the raised glyphs (256)
  });

  it('decorates scaled text in rendered points', () => {
    // A 2x CTM: the frame takes the scale out, so the rule spans exactly the
    // drawn glyphs and is as thick as 24pt text's, not twice that.
    const doc = Document.Open(buildSimpleTextPdf('2 0 0 2 0 0 cm BT /F1 12 Tf 10 100 Td (abc) Tj ET'));
    doc.Pages[0].RestyleText('abc', { underline: true });
    const gs = glyphs(doc);
    const [r] = fills(doc);
    expect(r[0]).toBeCloseTo(gs[0].quad[0], 3);
    expect(r[2]).toBeCloseTo(gs[2].penEnd[0], 3);
    expect((r[3] as number) - (r[1] as number)).toBeCloseTo(24 * 0.05, 3);   // Helvetica's 50/1000 em
  });

  it('decorates rotated text along its own baseline', () => {
    const doc = Document.Open(buildSimpleTextPdf('BT /F1 12 Tf 0 1 -1 0 100 100 Tm (abc) Tj ET'));
    doc.Pages[0].RestyleText('abc', { underline: true });
    const [r] = fills(doc);
    expect((r[3] as number) - (r[1] as number)).toBeGreaterThan(10);   // runs up the page
    expect((r[2] as number) - (r[0] as number)).toBeLessThan(2);        // thin across it
  });

  it('decorates text in a form inside the form', () => {
    const doc = Document.Open(buildFormTextPdf('q 1 0 0 1 50 0 cm /Fm0 Do Q', 'BT /F1 12 Tf 10 100 Td (alpha beta) Tj ET'));
    doc.Pages[0].RestyleText('beta', { underline: true });
    const p = doc.Pages[0].GetPaths().filter((x) => x.fill);
    expect(p.length).toBe(1);
    expect(p[0].addr.path).toEqual(['Fm0']);
    const b = glyphs(doc).find((g) => g.text === 'b')!;
    expect(p[0].bbox[0]).toBeCloseTo(b.quad[0], 3);
  });

  it('a form drawn twice is decorated once, and both drawings show it', () => {
    const doc = Document.Open(buildFormTextPdf('q 1 0 0 1 0 150 cm /Fm0 Do Q q /Fm0 Do Q', 'BT /F1 12 Tf 10 100 Td (alpha beta) Tj ET'));
    doc.Pages[0].RestyleText('beta', { underline: true });
    const rules = fills(doc);
    expect(rules.length).toBe(2);
    expect((rules[1][1] as number) - (rules[0][1] as number)).toBeCloseTo(150, 3);
  });

  it('a second call adds a second rule', () => {
    const doc = Document.Open(buildSimpleTextPdf('BT /F1 12 Tf 20 250 Td (alpha beta) Tj ET'));
    doc.Pages[0].RestyleText('beta', { underline: true });
    doc.Pages[0].RestyleText('beta', { underline: true });
    expect(fills(doc).length).toBe(2);
  });

  it('marks decorations as artifacts in a tagged document', () => {
    const d = Document.New();
    d.AddMarkdown('Some words to decorate here.', { tagged: true });
    const doc = Document.Open(d.Save());
    const rules0 = doc.ValidatePdfUa().Issues.map((i) => i.rule).sort();
    doc.Pages[0].RestyleText('words', { underline: true, background: [1, 1, 0] });
    const p = doc.Pages[0].GetPaths().filter((x) => x.fill);
    expect(p.length).toBe(2);
    expect(p.every((x) => x.artifact)).toBe(true);
    expect(doc.ValidatePdfUa().Issues.map((i) => i.rule).sort()).toEqual(rules0);
  });

  it('refuses a decoration on vertical text, changing nothing', () => {
    const cmap = '1 begincodespacerange <0000> <FFFF> endcodespacerange\n1 beginbfchar <0041> <0041> endbfchar\n';
    const doc = Document.Open(buildType0Pdf('BT /F1 12 Tf 100 250 Td <00410041> Tj ET', cmap, { encoding: 'Identity-V' }));
    const before = doc.Save();
    expect(() => doc.Pages[0].RestyleText('A', { underline: true })).toThrow(UnsupportedFeatureError);
    expect(doc.Save()).toEqual(before);
  });

  it('refuses when the text object is split across content streams', () => {
    // The text object opens in one /Contents stream and closes in the next.
    const doc = Document.Open(buildMultiStreamPage(['BT /F1 12 Tf 20 250 Td (alpha beta) Tj', 'ET']));
    const before = doc.Save();
    expect(() => doc.Pages[0].RestyleText('beta', { underline: true })).toThrow(/content streams/);
    expect(doc.Save()).toEqual(before);
  });
});

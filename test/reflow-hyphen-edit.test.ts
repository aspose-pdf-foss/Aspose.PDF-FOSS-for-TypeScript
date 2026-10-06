import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { PageFormat } from '../src/pageformat.js';
import { buildType0Pdf } from './helpers/build-text-pdf.js';
import { parseContentStream } from '../src/content.js';
import { isArray, isString } from '../src/types.js';
import { pageLayout } from '../src/textedit.js';

const BOX: [number, number, number, number] = [72, 400, 200, 300];
const T = 'The quick brown fox jumps over the lazy dog and then keeps running far away into the woods';
const block = () => {
  const d = Document.New(PageFormat.A4);
  d.Pages[0].AddTextBlock(T, BOX, { fontSize: 12 });
  return Document.Open(d.Save());
};
const HY = { adjust: 'reflow' as const, hyphenate: { lang: 'en' } };

describe('a replacement hyphenates across lines (6y39)', () => {
  it('splits a long replacement at a pattern point with a Tm between', () => {
    const doc = block();
    doc.Pages[0].ReplaceText('fox', 'internationalization', HY);
    const text = doc.Pages[0].GetText();
    expect(text).toMatch(/-\n/);
    expect(text.replace(/-\n/g, '')).toContain('internationalization');
    // The pen leaves the edit where its TAIL ends, so the word after it on
    // that line chains on with no Tm of its own.
    const s = new TextDecoder('latin1').decode(doc.Pages[0].Contents);
    expect(s.match(/\(tion[^]*?jumps/)![0]).not.toContain('Tm');
  });
  it('matches AddTextBlock of the new text', () => {
    // Same oracle shape as test/reflow-hyphen.test.ts: edit on line 0.
    const doc = block();
    // The replacement itself overflows line 0 and must split (internationaliza-).
    doc.Pages[0].ReplaceText('fox', 'internationalization', HY);
    expect(doc.Pages[0].GetText()).toMatch(/internationaliza-\n/);
    const d = Document.New(PageFormat.A4);
    const w = Math.max(...block().Pages[0].GetStructuredText().flatMap((b) => b.lines.map((l) => l.quad[2]))) - BOX[0] + 1e-3;
    d.Pages[0].AddTextBlock(T.replace('fox', 'internationalization'), [BOX[0], BOX[1], w, BOX[3]], { fontSize: 12, hyphenate: { lang: 'en' } });
    const want = Document.Open(d.Save());
    expect(doc.Pages[0].GetText()).toBe(want.Pages[0].GetText());
    const origins = (x: Document) => pageLayout(x, x.Pages[0], {}).all.filter((g) => g.text.trim() !== '').map((g) => [g.text, g.quad[0], g.quad[1]] as const);
    const a = origins(doc), b = origins(want);
    expect(a.map((g) => g[0]).join('')).toBe(b.map((g) => g[0]).join(''));
    a.forEach((g, i) => { expect(g[1]).toBeCloseTo(b[i][1], 3); expect(g[2]).toBeCloseTo(b[i][2], 3); });
  });
  it('a styled replacement keeps its style on both halves and on the hyphen', () => {
    const doc = block();
    doc.Pages[0].ReplaceText('fox', 'internationalization', { ...HY, color: [1, 0, 0] });
    const s = new TextDecoder('latin1').decode(doc.Pages[0].Contents);
    // Red set before the head, before the hyphen and before the tail.
    expect(s).toMatch(/1 0 0 rg\s*\(internationaliza\) Tj/);
    expect(s).toMatch(/1 0 0 rg\s*\(-\) Tj/);
    expect(s).toMatch(/1 0 0 rg\s*\(tion\) Tj/);
    expect(doc.Pages[0].GetText().replace(/-\n/g, '')).toContain('internationalization');
  });
  // Review Focus 5: an Identity-H Type0 font, two-byte codes. drawCode answers
  // through /ToUnicode for an /Identity-H font, so the CMap maps every letter,
  // the space and the hyphen.
  it('splits a replacement in an Identity-H font at a character boundary', () => {
    const letters = 'abcdefghijklmnopqrstuvwxyz';
    const cid = (c: string) => (c === ' ' ? 3 : c === '-' ? 0x2d : 0x10 + letters.indexOf(c));
    const h4 = (n: number) => n.toString(16).padStart(4, '0');
    const hex = (s: string) => `<${[...s].map((c) => h4(cid(c))).join('')}>`;
    const chars = [...letters, ' ', '-'];
    const cmap = '1 begincodespacerange <0000> <FFFF> endcodespacerange\n'
      + `${chars.length} beginbfchar ${chars.map((c) => `<${h4(cid(c))}> <${h4(c.charCodeAt(0))}>`).join(' ')} endbfchar\n`;
    const s = `BT /F1 12 Tf 20 250 Td ${hex('alpha beta')} Tj 0 -14 Td ${hex('gamma delta')} Tj 0 -14 Td ${hex('zeta eta')} Tj ET`;
    const doc = Document.Open(buildType0Pdf(s, cmap));
    doc.Pages[0].ReplaceText('beta', 'internationalization', HY);
    const text = doc.Pages[0].GetText();
    expect(text).toMatch(/-\n/);
    expect(text.replace(/-\n/g, '')).toContain('internationalization');
    for (const op of parseContentStream(doc.Pages[0].Contents)) {
      const strs = op.operator === 'TJ' && isArray(op.operands[0]) ? op.operands[0] : op.operator === 'Tj' ? [op.operands[0]] : [];
      for (const x of strs) if (isString(x)) expect(x.bytes.length % 2).toBe(0);
    }
  });
});

import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { PageFormat } from '../src/pageformat.js';
import { parseContentStream } from '../src/content.js';
import { measureTextBlock } from '../src/stamp.js';

const T = 'Hyphenation keeps documentation of extraordinary responsibility readable in narrow columns';
const lines = (doc: Document) => Document.Open(doc.Save()).Pages[0].GetText().split('\n');

describe('AddTextBlock({ hyphenate }) (v9j3.2)', () => {
  it('draws hyphens at line ends and keeps every line in the box', () => {
    const d = Document.New(PageFormat.A4);
    d.Pages[0].AddTextBlock(T, [72, 500, 90, 300], { fontSize: 12, hyphenate: { lang: 'en' } });
    const ls = lines(d);
    expect(ls.some((l) => l.endsWith('\u00AD'))).toBe(true);   // rhud: written as 0xAD
    for (const f of Document.Open(d.Save()).Pages[0].GetTextFragments()) expect(f.quad[2]).toBeLessThanOrEqual(72 + 90 + 0.01);
  });

  it('measures exactly as it paints', () => {
    const o = { fontSize: 12, hyphenate: { lang: 'en' } } as const;
    const m = measureTextBlock(T, 90, 1000, o);
    const off = measureTextBlock(T, 90, 1000, { fontSize: 12 });
    const d = Document.New(PageFormat.A4);
    d.Pages[0].AddTextBlock(T, [72, 300, 90, 500], o);
    expect(m.usedHeight).not.toBe(off.usedHeight);
    // Every line is one leading tall here, so the drawn line count is the measure.
    expect(lines(d).length).toBe(Math.round(m.usedHeight / (12 * 1.2)));
  });

  it('is byte-identical without the option, soft hyphens included', () => {
    const src = 'hy­phen­ation and more words here';
    const a = Document.New(PageFormat.A4), b = Document.New(PageFormat.A4);
    a.Pages[0].AddTextBlock(src, [72, 500, 60, 300], { fontSize: 12 });
    b.Pages[0].AddTextBlock(src, [72, 500, 60, 300], { fontSize: 12, hyphenate: undefined });
    expect(b.Pages[0].Contents).toEqual(a.Pages[0].Contents);
    const tj = parseContentStream(a.Pages[0].Contents).filter((op) => op.operator === 'Tj')
      .map((op) => Buffer.from((op.operands[0] as { bytes: Uint8Array }).bytes).toString('latin1')).join('');
    expect(tj).toContain('\xAD');   // OFF keeps today's visible soft hyphen
  });

  it('hides soft hyphens in manual mode', () => {
    const d = Document.New(PageFormat.A4);
    d.Pages[0].AddTextBlock('hy­phen', [72, 500, 300, 100], { fontSize: 12, hyphenate: { mode: 'manual' } });
    expect(Document.Open(d.Save()).Pages[0].GetText()).toBe('hyphen');
  });

  it('refuses bad options before drawing anything', () => {
    const d = Document.New(PageFormat.A4);
    const before = d.Pages[0].Contents;
    expect(() => d.Pages[0].AddTextBlock(T, [72, 500, 90, 300], { hyphenate: { lang: 'ru' } })).toThrow(RangeError);
    expect(() => d.Pages[0].AddTextBlock(T, [72, 500, 90, 300], { hyphenate: 'en' as never })).toThrow(TypeError);
    expect(d.Pages[0].Contents).toEqual(before);
  });
});

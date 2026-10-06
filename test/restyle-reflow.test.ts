import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { visitContent, type GlyphEvent } from '../src/text.js';
import { buildSimpleTextPdf } from './helpers/build-text-pdf.js';

const glyphs = (doc: Document): GlyphEvent[] => {
  const out: GlyphEvent[] = [];
  visitContent(doc, doc.Pages[0], { glyph: (g) => out.push(g) });
  return out;
};

describe('RestyleText with adjust: reflow (u3l5.6)', () => {
  it('moves a decorated word to its new line with its rule', () => {
    // Four producer lines. "ffff" at 80pt no longer fits beside "eeee", so the
    // reflow moves it to the start of the next line — and its underline,
    // planned in the same call, goes with it.
    const doc = Document.Open(buildSimpleTextPdf('BT /F1 12 Tf 20 280 Td (aaaa bbbb cccc dddd) Tj 0 -14 Td (eeee ffff) Tj '
      + '0 -14 Td (gggggggggggggggg) Tj 0 -14 Td (i jj) Tj ET'));
    doc.Pages[0].RestyleText('ffff', { fontSize: 80, underline: true }, { adjust: 'reflow' });
    const f = glyphs(doc).find((g) => g.text === 'f')!;
    expect(f.quad[0]).toBeCloseTo(20, 3);
    expect(f.quad[1]).toBeCloseTo(280 - 2 * 14, 3);
    const rules = doc.Pages[0].GetPaths().filter((p) => p.fill).map((p) => p.bbox);
    expect(rules.length).toBe(1);
    expect(rules[0][0]).toBeCloseTo(20, 3);
    expect(rules[0][3]).toBeLessThan(f.quad[1]);
    expect(rules[0][3]).toBeGreaterThan(f.quad[1] - 15);   // 80pt: offset 8pt, thickness 4pt
  });
});

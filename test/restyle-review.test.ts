// Shapes the final review of u3l5.6 found that no fixture had built.
import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { visitContent, type GlyphEvent } from '../src/text.js';
import { parseContentStream } from '../src/content.js';
import { isName } from '../src/types.js';
import { buildSimpleTextPdf, buildSharedFormPagesPdf } from './helpers/build-text-pdf.js';
import { buildTaggedPdf } from './helpers/build-tagged-pdf.js';

const glyphs = (doc: Document, page = 0): GlyphEvent[] => {
  const out: GlyphEvent[] = [];
  visitContent(doc, doc.Pages[page], { glyph: (g) => out.push(g) });
  return out;
};
const rules = (doc: Document, page = 0) => doc.Pages[page].GetPaths().filter((p) => p.fill).map((p) => p.bbox)
  .sort((a, b) => a[0] - b[0]);

describe('RestyleText review findings (u3l5.6)', () => {
  it('decorates a later piece where an earlier resize moved it (I1)', () => {
    const doc = Document.Open(buildSimpleTextPdf('BT /F1 12 Tf 20 250 Td (a word and word) Tj ET'));
    doc.Pages[0].RestyleText('word', { fontSize: 24, underline: true });
    const ws = glyphs(doc).filter((g) => g.text === 'w');
    const r = rules(doc);
    expect(r.length).toBe(2);
    expect(r[0][0]).toBeCloseTo(ws[0].quad[0], 3);
    expect(r[1][0]).toBeCloseTo(ws[1].quad[0], 3);
  });

  it('decorates a piece a shiftRest kern moved (I1)', () => {
    const doc = Document.Open(buildSimpleTextPdf('BT /F1 12 Tf 20 250 Td (alpha) Tj 40 0 Td (beta) Tj ET'));
    doc.Pages[0].RestyleText(/alpha|beta/, { fontSize: 24, underline: true }, { adjust: 'shiftRest' });
    const a = glyphs(doc).find((g) => g.text === 'a')!, b = glyphs(doc).find((g) => g.text === 'b')!;
    const r = rules(doc);
    expect(r.length).toBe(2);
    expect(r[0][0]).toBeCloseTo(a.quad[0], 3);
    expect(r[1][0]).toBeCloseTo(b.quad[0], 3);
  });

  it('doc.RestyleText restyles a form shared by two pages once (I2)', () => {
    const doc = Document.Open(buildSharedFormPagesPdf('BT /F1 12 Tf 20 250 Td (alpha beta) Tj ET'));
    expect(doc.RestyleText('beta', { underline: true, fontSize: 18 })).toBe(2);
    expect(rules(doc, 0).length).toBe(1);
    expect(rules(doc, 1).length).toBe(1);
    const b = glyphs(doc, 1).find((g) => g.text === 'b')!;
    expect(b.fontSize).toBeCloseTo(18, 6);
  });

  it('puts a tagged decoration outside the structure content it decorates (I3)', () => {
    const doc = Document.Open(buildTaggedPdf());
    const word = doc.Pages[0].GetText().match(/[A-Za-z]{4,}/)![0];
    doc.Pages[0].RestyleText(word, { underline: true, background: [1, 1, 0] });
    const stack: string[] = [];
    let artifacts = 0;
    for (const op of parseContentStream(doc.Pages[0].Contents)) {
      if (op.operator === 'BDC' || op.operator === 'BMC') {
        const tag = isName(op.operands[0]) ? op.operands[0].name : '?';
        if (tag === 'Artifact') {
          artifacts++;
          expect(stack.filter((t) => t !== 'OC' && t !== 'Artifact')).toEqual([]);
        }
        stack.push(tag);
      } else if (op.operator === 'EMC') stack.pop();
    }
    expect(artifacts).toBe(2);
    expect(stack).toEqual([]);
  });
});

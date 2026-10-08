import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { PageFormat } from '../src/pageformat.js';
import { parseContentStream } from '../src/content.js';
import { buildSimpleTextPdf } from './helpers/build-text-pdf.js';

const BOX: [number, number, number, number] = [72, 400, 200, 300];
const T = 'The quick brown fox jumps over the lazy internationalization dog and then keeps running far away into the woods';
const block = () => {
  const d = Document.New(PageFormat.A4);
  d.Pages[0].AddTextBlock(T, BOX, { fontSize: 12 });
  return Document.Open(d.Save());
};
const HY = { adjust: 'reflow' as const, hyphenate: { lang: 'en' } };

describe('annotations and decorations over a split word (6y39)', () => {
  it('a highlight over a split word gets one quad per line, the head over its hyphen', () => {
    const doc = block();
    const m = doc.Pages[0].Search('internationalization')[0];
    doc.Pages[0].AddHighlight({ quads: m.quads.flatMap(([x0, y0, x1, y1]) => [x0, y1, x1, y1, x0, y0, x1, y0]) });
    doc.Pages[0].ReplaceText('quick', 'remarkably quick', HY);
    expect(doc.Pages[0].GetText()).toMatch(/inter[a-z]*\u00AD\n/);   // the word WAS split
    const hl = doc.Pages[0].Annotations.find((a) => a.Subtype === 'Highlight')!;
    const qp = hl.Dict.get('QuadPoints') as number[];
    expect(qp.length).toBe(16);
    // Top line first, [x0 y1 x1 y1 x0 y0 x1 y0]: the head's x1 reaches the
    // hyphen's end, which Search reports as the end of the head's quad.
    const head = doc.Pages[0].Search(/inter[a-z]*\u00AD/)[0].quads[0];
    expect(qp[2]).toBeCloseTo(head[2], 1);
  });
  it('a highlight over a rejoined word becomes one quad, with no box for the removed hyphen', () => {
    // Only a SOFT hyphen rejoins (a drawn '-' may be a compound's own), so the
    // source line ends in WinAnsi 0xAD.
    const doc = Document.Open(buildSimpleTextPdf('BT /F1 12 Tf 20 280 Td (alpha beta gamma delta docu\\255) Tj '
      + '0 -14 Td (mentation results follow here) Tj 0 -14 Td (and then some more) Tj ET'));
    const quads = [...doc.Pages[0].Search('docu­')[0].quads, ...doc.Pages[0].Search('mentation')[0].quads];
    doc.Pages[0].AddHighlight({ quads: quads.flatMap(([x0, y0, x1, y1]) => [x0, y1, x1, y1, x0, y0, x1, y0]) });
    doc.Pages[0].ReplaceText('beta gamma', 'b', HY);
    expect(doc.Pages[0].GetText()).toContain('documentation');   // rejoined
    const qp = doc.Pages[0].Annotations.find((a) => a.Subtype === 'Highlight')!.Dict.get('QuadPoints') as number[];
    expect(qp.length).toBe(8);
    const word = doc.Pages[0].Search('documentation')[0].quads[0];
    expect(qp[0]).toBeCloseTo(word[0], 1);
    expect(qp[2]).toBeCloseTo(word[2], 1);
  });
  it('RestyleText underlines both halves of a split match, the head through its hyphen', () => {
    const doc = block();
    // At 22pt the restyled word no longer fits after 'lazy' and must split.
    doc.Pages[0].RestyleText('internationalization', { fontSize: 22, underline: true }, HY);
    expect(doc.Pages[0].GetText()).toMatch(/internationaliza\u00AD\ntion/);
    const ops = parseContentStream(doc.Pages[0].Contents);
    const rects = ops.filter((o) => o.operator === 're');
    expect(rects.length).toBe(2);   // one underline is one 're'; one per line
    // The head's rule runs through its hyphen: as wide as Search's quad for it.
    const head = doc.Pages[0].Search('internationaliza\u00AD')[0].quads[0];
    expect(rects[0].operands[2] as number).toBeCloseTo(head[2] - head[0], 1);
  });
});

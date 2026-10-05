import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { visitContent, type GlyphEvent } from '../src/text.js';
import { buildSimpleTextPdf, buildFormTextPdf } from './helpers/build-text-pdf.js';

const glyphs = (doc: Document): GlyphEvent[] => {
  const out: GlyphEvent[] = [];
  visitContent(doc, doc.Pages[0], { glyph: (e) => { out.push(e); } });
  return out;
};

describe('GlyphEvent tfKey and tfSize', () => {
  it('reports the resource name and size Tf selected', () => {
    const doc = Document.Open(buildSimpleTextPdf('BT /F1 12 Tf 20 250 Td (Hi) Tj ET'));
    const [g] = glyphs(doc);
    expect(g.tfKey).toBe('F1');
    expect(g.tfSize).toBe(12);
  });

  it('scopes the size by q/Q like the rest of the text state', () => {
    const doc = Document.Open(buildSimpleTextPdf('BT /F1 12 Tf 20 250 Td q /F1 20 Tf (a) Tj Q (b) Tj ET'));
    expect(glyphs(doc).map((g) => g.tfSize)).toEqual([20, 12]);
  });

  it('reports the key a form inherited from the page text state', () => {
    const doc = Document.Open(buildFormTextPdf(
      'BT /F1 9 Tf ET /Fm0 Do', 'BT 20 250 Td (x) Tj ET', { formFont: false }));
    const [g] = glyphs(doc);
    expect(g.text).toBe('x');
    expect(g.tfKey).toBe('F1');
    expect(g.tfSize).toBe(9);
  });
});

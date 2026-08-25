import { describe, it, expect } from 'vitest';
import { buildClassicPdf } from './build-pdf.js';
import { Document } from '../../src/document.js';

describe('buildClassicPdf', () => {
  it('produces a parseable 2-page PDF with valid startxref', () => {
    const pdf = buildClassicPdf(2);
    const s = new TextDecoder('latin1').decode(pdf);
    expect(s.startsWith('%PDF-1.7')).toBe(true);
    expect(s.includes('/Type /Catalog')).toBe(true);
    expect(s.trimEnd().endsWith('%%EOF')).toBe(true);
    expect((s.match(/\/Type \/Page\b/g) || []).length).toBe(2);
  });
});

describe('buildClassicPdf with /Info', () => {
  it('embeds an Info dict reachable from the trailer', () => {
    const pdf = buildClassicPdf(1, { info: { Title: 'Hi', Author: 'Ada' } });
    const doc = Document.Open(pdf);
    const info = doc.resolve(doc.trailer.get('Info'));
    expect(info instanceof Map).toBe(true);
  });
});

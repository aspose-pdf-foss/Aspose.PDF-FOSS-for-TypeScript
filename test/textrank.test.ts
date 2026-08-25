import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { buildSvgPdf, HELV_RESOURCES } from './helpers/build-svg-fixtures.js';
import { headingRanks, roundSize } from '../src/textrank.js';

describe('textrank', () => {
  it('rounds sizes to the nearest half point', () => {
    expect(roundSize(12)).toBe(12);
    expect(roundSize(12.2)).toBe(12);
    expect(roundSize(12.3)).toBe(12.5);
  });

  it('ranks larger sizes as headings and omits body text', () => {
    // Body text at 12pt dominates by character count; 24pt and 18pt are headings.
    const content = [
      'BT /F1 24 Tf 50 350 Td (Big) Tj ET',
      'BT /F1 18 Tf 50 320 Td (Med) Tj ET',
      'BT /F1 12 Tf 50 290 Td (body body body body body body) Tj ET',
    ].join('\n');
    const doc = Document.Open(buildSvgPdf({ mediaBox: [0, 0, 400, 400], content, resources: HELV_RESOURCES }));
    const ranks = headingRanks(doc);
    expect(ranks.get(24)).toBe(1);
    expect(ranks.get(18)).toBe(2);
    expect(ranks.has(12)).toBe(false); // body text is not a heading
  });
});

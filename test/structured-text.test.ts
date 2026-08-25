import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { buildSimpleTextPdf, buildImageOnlyPdf } from './helpers/build-text-pdf.js';

const blocks = (bytes: Uint8Array) => Document.Open(bytes).Pages[0].GetStructuredText();

describe('Page.GetStructuredText', () => {
  it('groups closely-spaced lines into one block', () => {
    // Two single-spaced lines (14u leading at 12pt) -> one paragraph.
    const pdf = buildSimpleTextPdf('BT /F1 12 Tf 20 250 Td (line one) Tj 0 -14 Td (line two) Tj ET');
    const bs = blocks(pdf);
    expect(bs).toHaveLength(1);
    expect(bs[0].lines.map((l) => l.text)).toEqual(['line one', 'line two']);
    expect(bs[0].text).toBe('line one\nline two');
  });

  it('splits widely-spaced lines into separate blocks', () => {
    // 60u gap between baselines -> a paragraph break.
    const pdf = buildSimpleTextPdf('BT /F1 12 Tf 20 250 Td (para one) Tj 0 -60 Td (para two) Tj ET');
    const bs = blocks(pdf);
    expect(bs.map((b) => b.text)).toEqual(['para one', 'para two']);
  });

  it('exposes per-line and per-block page-space quads ordered top-to-bottom', () => {
    const pdf = buildSimpleTextPdf('BT /F1 12 Tf 20 250 Td (top) Tj 0 -14 Td (bottom) Tj ET');
    const [b] = blocks(pdf);
    expect(b.lines[0].quad[1]).toBeCloseTo(250, 5);   // first line baseline higher
    expect(b.lines[1].quad[1]).toBeCloseTo(236, 5);
    // Block box spans both lines.
    expect(b.quad[1]).toBeCloseTo(236, 5);
    expect(b.quad[3]).toBeGreaterThanOrEqual(250 + 12 - 0.01);
  });

  it('splits a sharply different left edge into a separate block', () => {
    // Close vertically (14u) but the second line jumps right by 120u -> distinct
    // column/block despite the small vertical gap.
    const pdf = buildSimpleTextPdf('BT /F1 12 Tf 20 250 Td (left col) Tj 120 -14 Td (right col) Tj ET');
    const bs = blocks(pdf);
    expect(bs.map((b) => b.text)).toEqual(['left col', 'right col']);
  });

  it('returns no blocks for an image-only page', () => {
    expect(blocks(buildImageOnlyPdf())).toEqual([]);
  });
});

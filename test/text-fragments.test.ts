import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { buildSimpleTextPdf, buildImageOnlyPdf } from './helpers/build-text-pdf.js';

const fragments = (bytes: Uint8Array) => Document.Open(bytes).Pages[0].GetTextFragments();

describe('Page.GetTextFragments', () => {
  it('returns a single positioned fragment for one Tj run', () => {
    const pdf = buildSimpleTextPdf('BT /F1 12 Tf 20 250 Td (Hello World) Tj ET');
    const frags = fragments(pdf);
    expect(frags).toHaveLength(1);
    const f = frags[0];
    expect(f.text).toBe('Hello World');
    expect(f.fontSize).toBe(12);
    expect(f.fontName).toBe('Helvetica');
    // No cm transform -> device space == page space; baseline y=250, size=12.
    expect(f.quad[0]).toBeCloseTo(20, 5);
    expect(f.quad[1]).toBeCloseTo(250, 5);
    expect(f.quad[3]).toBeCloseTo(262, 5);
    expect(f.quad[2]).toBeGreaterThan(f.quad[0]);
  });

  it('splits into separate fragments when the font size changes', () => {
    const pdf = buildSimpleTextPdf('BT /F1 12 Tf 20 250 Td (Big) Tj /F1 8 Tf (small) Tj ET');
    const frags = fragments(pdf);
    expect(frags.map((f) => f.text)).toEqual(['Big', 'small']);
    expect(frags.map((f) => f.fontSize)).toEqual([12, 8]);
  });

  it('splits into separate fragments across a line break', () => {
    const pdf = buildSimpleTextPdf('BT /F1 12 Tf 20 250 Td (first) Tj 0 -20 Td (second) Tj ET');
    const frags = fragments(pdf);
    expect(frags.map((f) => f.text)).toEqual(['first', 'second']);
    expect(frags[0].quad[1]).toBeCloseTo(250, 5);
    expect(frags[1].quad[1]).toBeCloseTo(230, 5);
  });

  it('returns no fragments for an image-only page', () => {
    expect(fragments(buildImageOnlyPdf())).toEqual([]);
  });

  // A fragment runs ALONG its writing direction, so a glyph landing before the
  // previous one ended starts a new one. The gap test used to bound the gap only
  // from above, which merged a backwards jump of any size: a right-aligned list
  // marker painted after its body (what flow.ts emits) came back as one fragment
  // reading 'body3.' whose quad excluded the marker it contained — violating
  // TextFragment's own "x from the pen span" contract, and losing both the
  // marker text and its x before any consumer saw them.
  it('splits when a run is painted backwards of the previous one', () => {
    // '3.' is drawn AFTER 'three' and to its left, exactly as a list marker is.
    const pdf = buildSimpleTextPdf(
      'BT /F1 12 Tf 100 250 Td (three) Tj 1 0 0 1 60 250 Tm (3.) Tj ET');
    const frags = fragments(pdf);
    expect(frags.map((f) => f.text)).toEqual(['three', '3.']);
    // Each quad spans only its own glyphs — the marker's starts left of the body.
    expect(frags[0].quad[0]).toBeCloseTo(100, 5);
    expect(frags[1].quad[0]).toBeCloseTo(60, 5);
    expect(frags[1].quad[2]).toBeLessThan(frags[0].quad[0]);
  });

  it('still merges a kerned or slightly overlapping run', () => {
    // A small negative step is ordinary kerning, not a new run: the TJ number is
    // in thousandths of an em, so 200 at 12pt pulls the next glyph back 2.4pt —
    // well inside the half-em tolerance, and it must NOT split.
    const pdf = buildSimpleTextPdf('BT /F1 12 Tf 20 250 Td [(A) 200 (V)] TJ ET');
    expect(fragments(pdf).map((f) => f.text)).toEqual(['AV']);
  });
});

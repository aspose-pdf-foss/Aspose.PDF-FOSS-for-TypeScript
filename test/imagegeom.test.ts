import { describe, it, expect } from 'vitest';
import { invert, apply, Matrix, visitContent, ImageEvent } from '../src/text.js';
import { Document } from '../src/document.js';
import { buildImageOnlyPdf } from './helpers/build-text-pdf.js';

describe('invert', () => {
  it('round-trips a point through a scaled+flipped+translated matrix', () => {
    const m: Matrix = [2, 0, 0, -3, 10, 20];
    const mi = invert(m);
    const [x, y] = apply(m, 4, 5);
    const [bx, by] = apply(mi, x, y);
    expect(bx).toBeCloseTo(4);
    expect(by).toBeCloseTo(5);
  });

  it('throws on a singular matrix', () => {
    expect(() => invert([0, 0, 0, 0, 1, 1])).toThrow();
  });
});

describe('ImageEvent.ctm', () => {
  it('carries the placement matrix', () => {
    const doc = Document.Open(buildImageOnlyPdf()); // q 100 0 0 100 50 50 cm /Im0 Do Q
    const evs: ImageEvent[] = [];
    visitContent(doc, doc.Pages[0], { image: (e) => evs.push(e) });
    expect(evs).toHaveLength(1);
    expect(evs[0].ctm).toEqual([100, 0, 0, 100, 50, 50]);
  });
});

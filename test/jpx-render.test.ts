import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { buildSingleImagePdfWithCm } from './helpers/build-image-pdf.js';
import { decodePng } from './helpers/decode-png.js';
import { lossless_gray_j2k, lossless_gray_rgb } from './helpers/jpx-fixtures.js';

// The lossless_gray fixture is a 16x16 horizontal ramp: column 0 = 0 (black),
// column 15 = 255 (white). Rendering it must reproduce that gradient rather than
// skip the image (which would leave the page background).
describe('JPX rendering', () => {
  const pdf = buildSingleImagePdfWithCm({
    width: lossless_gray_rgb.width, height: lossless_gray_rgb.height,
    colorSpace: 'DeviceGray', bits: 8, filter: 'JPXDecode', raw: lossless_gray_j2k,
    cm: '100 0 0 100 0 0', mediaBox: '0 0 100 100',
  });

  it('ToImage renders the JPX gray ramp (dark left, bright right)', () => {
    const png = decodePng(Document.Open(pdf).Pages[0].ToImage());
    const left = png.at(6, 50);
    const right = png.at(94, 50);
    expect(left[0]).toBeLessThan(64);   // near-black at the left edge
    expect(right[0]).toBeGreaterThan(192); // near-white at the right edge
    expect(right[0] - left[0]).toBeGreaterThan(128); // a genuine gradient, not flat background
  });
});

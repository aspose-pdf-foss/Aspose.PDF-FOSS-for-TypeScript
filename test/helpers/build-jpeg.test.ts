import { describe, it, expect } from 'vitest';
import { encodeBaselineJpeg, encodeProgressiveJpeg } from './build-jpeg.js';

describe('encodeBaselineJpeg (fixture builder)', () => {
  it('emits a baseline JPEG with SOI/EOI, SOF0, and the given dimensions', () => {
    const w = 8, h = 8;
    const pixels = new Uint8Array(w * h); // grayscale flat
    pixels.fill(120);
    const jpg = encodeBaselineJpeg({ width: w, height: h, comps: 1, pixels });

    expect(jpg[0]).toBe(0xff); expect(jpg[1]).toBe(0xd8);            // SOI
    expect(jpg[jpg.length - 2]).toBe(0xff); expect(jpg[jpg.length - 1]).toBe(0xd9); // EOI

    // Find SOF0 (FF C0) and read its 16-bit height/width.
    let sof = -1;
    for (let i = 2; i + 1 < jpg.length; i++) if (jpg[i] === 0xff && jpg[i + 1] === 0xc0) { sof = i; break; }
    expect(sof).toBeGreaterThan(0);
    const height = (jpg[sof + 5] << 8) | jpg[sof + 6];
    const width  = (jpg[sof + 7] << 8) | jpg[sof + 8];
    expect(height).toBe(h); expect(width).toBe(w);
    expect(jpg[sof + 9]).toBe(1); // component count
  });

  it('encodeProgressiveJpeg emits SOF2 and at least one SOS scan', () => {
    const w = 16, h = 16; const px = new Uint8Array(w * h * 3);
    for (let i = 0; i < w * h; i++) { px[i * 3] = (i * 3) % 256; px[i * 3 + 1] = (i * 5) % 256; px[i * 3 + 2] = (i * 7) % 256; }
    const b = encodeProgressiveJpeg({ width: w, height: h, comps: 3, pixels: px });
    expect(b[0]).toBe(0xff); expect(b[1]).toBe(0xd8); // SOI
    let sof2 = false, sos = 0, p = 2;
    while (p < b.length - 1) {
      if (b[p] !== 0xff) { p++; continue; }
      const m = b[p + 1];
      if (m === 0xc2) sof2 = true;
      if (m === 0xda) { sos++; break; } // stop at first scan (entropy follows)
      if (m === 0xd9) break;
      if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7)) { p += 2; continue; }
      p += 2 + ((b[p + 2] << 8) | b[p + 3]);
    }
    expect(sof2).toBe(true); expect(sos).toBeGreaterThanOrEqual(1);
  });
});

import { describe, it, expect } from 'vitest';
import { decodeJpeg, parseDAC } from '../src/jpeg.js';
import { encodeBaselineJpeg, encodeProgressiveJpeg } from './helpers/build-jpeg.js';
import { encodeSequentialArithJpeg, encodeProgressiveArithJpeg } from './helpers/build-jpeg-arith.js';
import { encodeLosslessJpeg } from './helpers/build-jpeg-lossless.js';
import { encodeHierarchicalJpeg } from './helpers/build-jpeg-hier.js';
import { UnsupportedFeatureError, PdfParseError } from '../src/errors.js';
import { Document } from '../src/document.js';
import { decodeImageRgba } from '../src/raster.js';
import { isStream, PdfDict } from '../src/types.js';
import { buildSingleImagePdf } from './helpers/build-image-pdf.js';

const near = (a: number, b: number, tol = 3) => expect(Math.abs(a - b)).toBeLessThanOrEqual(tol);

describe('decodeJpeg — baseline', () => {
  it('round-trips a grayscale image (flat blocks exact)', () => {
    const w = 16, h = 16;
    const px = new Uint8Array(w * h);
    for (let i = 0; i < w * h; i++) px[i] = (i * 7) % 256;
    const dec = decodeJpeg(encodeBaselineJpeg({ width: w, height: h, comps: 1, pixels: px }));
    expect(dec.width).toBe(w); expect(dec.height).toBe(h); expect(dec.comps).toBe(1);
    for (let i = 0; i < w * h; i++) near(dec.data[i], px[i]);
  });

  it('round-trips an RGB image via YCbCr (4:4:4)', () => {
    const w = 16, h = 16;
    const px = new Uint8Array(w * h * 3);
    for (let i = 0; i < w * h; i++) { px[i * 3] = (i * 3) % 256; px[i * 3 + 1] = (i * 5) % 256; px[i * 3 + 2] = (i * 11) % 256; }
    const dec = decodeJpeg(encodeBaselineJpeg({ width: w, height: h, comps: 3, pixels: px }));
    expect(dec.comps).toBe(3);
    for (let i = 0; i < w * h * 3; i++) near(dec.data[i], px[i], 4);
  });

  it('round-trips a subsampled (4:2:0) flat RGB image', () => {
    const w = 16, h = 16;
    const px = new Uint8Array(w * h * 3);
    for (let i = 0; i < w * h; i++) { px[i * 3] = 200; px[i * 3 + 1] = 80; px[i * 3 + 2] = 40; } // flat → exact after up/down-sample
    const dec = decodeJpeg(encodeBaselineJpeg({ width: w, height: h, comps: 3, pixels: px, subsample: true }));
    expect(dec.width).toBe(w); expect(dec.height).toBe(h);
    near(dec.data[0], 200, 4); near(dec.data[1], 80, 4); near(dec.data[2], 40, 4);
    const last = (w * h - 1) * 3; near(dec.data[last], 200, 4); near(dec.data[last + 1], 80, 4);
  });

  it('round-trips a flat CMYK (Adobe) image', () => {
    const w = 8, h = 8;
    const px = new Uint8Array(w * h * 4);
    for (let i = 0; i < w * h; i++) { px[i * 4] = 30; px[i * 4 + 1] = 60; px[i * 4 + 2] = 90; px[i * 4 + 3] = 120; }
    const dec = decodeJpeg(encodeBaselineJpeg({ width: w, height: h, comps: 4, pixels: px }));
    expect(dec.comps).toBe(4);
    near(dec.data[0], 30, 3); near(dec.data[1], 60, 3); near(dec.data[2], 90, 3); near(dec.data[3], 120, 3);
  });

  it('decodes identically with a restart interval', () => {
    const w = 24, h = 24;
    const px = new Uint8Array(w * h);
    for (let i = 0; i < w * h; i++) px[i] = (i * 13) % 256;
    const plain = decodeJpeg(encodeBaselineJpeg({ width: w, height: h, comps: 1, pixels: px }));
    const rst = decodeJpeg(encodeBaselineJpeg({ width: w, height: h, comps: 1, pixels: px, restartInterval: 2 }));
    for (let i = 0; i < w * h; i++) expect(rst.data[i]).toBe(plain.data[i]);
  });

  it('round-trips a 12-bit grayscale image, downscaled to 8-bit output', () => {
    const w = 16, h = 16;
    const px = new Uint16Array(w * h);
    for (let i = 0; i < w * h; i++) px[i] = (i * 251) % 4096; // full 0..4095 range
    const dec = decodeJpeg(encodeBaselineJpeg({ width: w, height: h, comps: 1, pixels: px, precision: 12 }));
    expect(dec.width).toBe(w); expect(dec.height).toBe(h); expect(dec.comps).toBe(1);
    for (let i = 0; i < w * h; i++) near(dec.data[i], px[i] >> 4); // 12→8 bit (>>4), within DCT tolerance
  });

  it('decodes a progressive (SOF2) stream instead of throwing', () => {
    const w = 8, h = 8; const px = new Uint8Array(w * h); for (let i = 0; i < w * h; i++) px[i] = (i * 9) % 256;
    const dec = decodeJpeg(encodeProgressiveJpeg({ width: w, height: h, comps: 1, pixels: px }));
    expect(dec.width).toBe(w); expect(dec.height).toBe(h); expect(dec.comps).toBe(1);
  });

  it('throws UnsupportedFeatureError for unsupported sample precision (16-bit)', () => {
    const b = Uint8Array.from([0xff, 0xd8, 0xff, 0xc0, 0, 11, 16, 0, 8, 0, 8, 1, 1, 0x11, 0, 0xff, 0xd9]);
    expect(() => decodeJpeg(b)).toThrow(UnsupportedFeatureError);
  });

  it('throws PdfParseError for a truncated stream with no frame', () => {
    expect(() => decodeJpeg(Uint8Array.from([0xff, 0xd8, 0xff, 0xd9]))).toThrow(PdfParseError);
  });
});

describe('decodeJpeg — arithmetic (SOF9), sequential', () => {
  it('round-trips grayscale and matches the baseline decode', () => {
    const w = 16, h = 16; const px = new Uint8Array(w * h);
    for (let i = 0; i < w * h; i++) px[i] = (i * 7) % 256;
    const base = decodeJpeg(encodeBaselineJpeg({ width: w, height: h, comps: 1, pixels: px }));
    const ari = decodeJpeg(encodeSequentialArithJpeg({ width: w, height: h, comps: 1, pixels: px }));
    expect(ari.width).toBe(w); expect(ari.comps).toBe(1);
    for (let i = 0; i < w * h; i++) expect(ari.data[i]).toBe(base.data[i]);
  });

  it('round-trips RGB (interleaved) and matches baseline', () => {
    const w = 16, h = 16; const px = new Uint8Array(w * h * 3);
    for (let i = 0; i < w * h; i++) { px[i * 3] = (i * 3) % 256; px[i * 3 + 1] = (i * 5) % 256; px[i * 3 + 2] = (i * 11) % 256; }
    const base = decodeJpeg(encodeBaselineJpeg({ width: w, height: h, comps: 3, pixels: px }));
    const ari = decodeJpeg(encodeSequentialArithJpeg({ width: w, height: h, comps: 3, pixels: px }));
    for (let i = 0; i < w * h * 3; i++) expect(ari.data[i]).toBe(base.data[i]);
  });

  it('round-trips a subsampled (4:2:0) flat RGB image matching baseline', () => {
    const w = 16, h = 16; const px = new Uint8Array(w * h * 3);
    for (let i = 0; i < w * h; i++) { px[i * 3] = 200; px[i * 3 + 1] = 80; px[i * 3 + 2] = 40; }
    const base = decodeJpeg(encodeBaselineJpeg({ width: w, height: h, comps: 3, pixels: px, subsample: true }));
    const ari = decodeJpeg(encodeSequentialArithJpeg({ width: w, height: h, comps: 3, pixels: px, subsample: true }));
    for (let i = 0; i < w * h * 3; i++) expect(Math.abs(ari.data[i] - base.data[i])).toBeLessThanOrEqual(1);
  });

  it('round-trips a flat CMYK (Adobe) image matching baseline', () => {
    const w = 8, h = 8; const px = new Uint8Array(w * h * 4);
    for (let i = 0; i < w * h; i++) { px[i * 4] = 30; px[i * 4 + 1] = 60; px[i * 4 + 2] = 90; px[i * 4 + 3] = 120; }
    const base = decodeJpeg(encodeBaselineJpeg({ width: w, height: h, comps: 4, pixels: px }));
    const ari = decodeJpeg(encodeSequentialArithJpeg({ width: w, height: h, comps: 4, pixels: px }));
    for (let i = 0; i < w * h * 4; i++) expect(Math.abs(ari.data[i] - base.data[i])).toBeLessThanOrEqual(1);
  });

  it('decodes an arithmetic stream with a restart interval identically', () => {
    const w = 24, h = 24; const px = new Uint8Array(w * h);
    for (let i = 0; i < w * h; i++) px[i] = (i * 13) % 256;
    const rstBytes = encodeSequentialArithJpeg({ width: w, height: h, comps: 1, pixels: px, restartInterval: 3 });
    let hasDri = false, hasRst = false;
    for (let i = 0; i + 1 < rstBytes.length; i++) { if (rstBytes[i] === 0xff) { const m = rstBytes[i + 1]; if (m === 0xdd) hasDri = true; if (m >= 0xd0 && m <= 0xd7) hasRst = true; } }
    expect(hasDri).toBe(true); expect(hasRst).toBe(true);
    const plain = decodeJpeg(encodeSequentialArithJpeg({ width: w, height: h, comps: 1, pixels: px }));
    const rst = decodeJpeg(rstBytes);
    for (let i = 0; i < w * h; i++) expect(rst.data[i]).toBe(plain.data[i]);
  });

  // The DC data here is chosen, not arbitrary: L/U only select which DC context
  // the *next* block uses, so data whose DC differences all land on the same side
  // of both the real and a swapped boundary round-trips fine either way. With an
  // all-ones quant table a flat block at level p has DC = 8*(p-128), so stepping
  // the per-block level gives exact control of the DC difference. F.1.4.4.1 keys
  // off m = the highest power of two <= |diff|-1; under L=1/U=3 the boundaries sit
  // at m<1 and m>4, under a swapped L=3/U=1 at m<4 and m>1. |diff|=8 (m=4) is the
  // magnitude those two disagree on, so the level-1 steps below are what make a
  // parser/writer disagreement desync the decoder instead of passing silently.
  // The zero-sum checkerboard rides on top for AC coverage (Kx) without moving DC.
  it('round-trips non-default DAC conditioning (L/U/Kx) matching baseline', () => {
    const levels = [100, 101, 102, 102, 104, 100]; // DC diffs: -224, +8, +8, 0, +16, -32
    const w = levels.length * 8, h = 8; const px = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) px[y * w + x] = levels[x >> 3] + ((x + y) & 1 ? 12 : -12);
    const base = decodeJpeg(encodeBaselineJpeg({ width: w, height: h, comps: 1, pixels: px }));
    const ari = decodeJpeg(encodeSequentialArithJpeg({ width: w, height: h, comps: 1, pixels: px, dac: { L: 1, U: 3, Kx: 6 } }));
    for (let i = 0; i < w * h; i++) expect(ari.data[i]).toBe(base.data[i]);
  });

  // Pinned against the wire format itself, not against our own writer: a
  // round-trip cannot see a swapped nibble that both sides agree on, which is
  // exactly how L/U stayed reversed here until a real libjpeg file showed up.
  it('parses the DAC conditioning byte with L low and U high (T.81 B.2.4.3)', () => {
    const dcCond: { L: number; U: number }[] = [];
    const acCond: { Kx: number }[] = [];
    // Tc=0/Tb=0 -> 0x10: the T.81 default pair libjpeg writes for every
    // arithmetic frame; Tc=0/Tb=1 -> 0x31 is an asymmetric L/U that cannot
    // read the same in either order. Tc=1/Tb=1 -> Kx=6.
    const seg = Uint8Array.from([0x00, 0x10, 0x01, 0x31, 0x11, 0x06]);
    parseDAC(seg, 0, seg.length, dcCond, acCond);
    expect(dcCond[0]).toEqual({ L: 0, U: 1 });
    expect(dcCond[1]).toEqual({ L: 1, U: 3 });
    expect(acCond[1]).toEqual({ Kx: 6 });
  });
});

describe('decodeJpeg — arithmetic progressive (SOF10)', () => {
  it('round-trips grayscale (spectral selection) matching baseline', () => {
    const w = 16, h = 16; const px = new Uint8Array(w * h);
    for (let i = 0; i < w * h; i++) px[i] = (i * 7) % 256;
    const base = decodeJpeg(encodeBaselineJpeg({ width: w, height: h, comps: 1, pixels: px }));
    const ari = decodeJpeg(encodeProgressiveArithJpeg({ width: w, height: h, comps: 1, pixels: px }));
    for (let i = 0; i < w * h; i++) expect(ari.data[i]).toBe(base.data[i]);
  });

  it('round-trips RGB with successive approximation matching baseline', () => {
    const w = 16, h = 16; const px = new Uint8Array(w * h * 3);
    for (let i = 0; i < w * h; i++) { px[i * 3] = (i * 17) % 256; px[i * 3 + 1] = (i * 31) % 256; px[i * 3 + 2] = (i * 47) % 256; }
    const base = decodeJpeg(encodeBaselineJpeg({ width: w, height: h, comps: 3, pixels: px }));
    const ari = decodeJpeg(encodeProgressiveArithJpeg({ width: w, height: h, comps: 3, pixels: px, successive: true }));
    for (let i = 0; i < w * h * 3; i++) expect(Math.abs(ari.data[i] - base.data[i])).toBeLessThanOrEqual(1);
  });
});

describe('decodeJpeg — lossless (SOF3 Huffman)', () => {
  it('decodes grayscale exactly (predictor 1)', () => {
    const w = 9, h = 7; const px = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) px[y * w + x] = (x * 13 + y * 7) & 0xff;
    const dec = decodeJpeg(encodeLosslessJpeg({ width: w, height: h, comps: 1, pixels: px }));
    expect(dec.width).toBe(w); expect(dec.height).toBe(h); expect(dec.comps).toBe(1);
    expect(Array.from(dec.data)).toEqual(Array.from(px)); // exact — lossless
  });

  it('decodes RGB (4:4:4) exactly', () => {
    const w = 8, h = 8; const px = new Uint8Array(w * h * 3);
    for (let i = 0; i < w * h; i++) { px[i * 3] = (i * 3) & 0xff; px[i * 3 + 1] = (i * 5 + 17) & 0xff; px[i * 3 + 2] = (i * 7 + 40) & 0xff; }
    const dec = decodeJpeg(encodeLosslessJpeg({ width: w, height: h, comps: 3, pixels: px }));
    expect(dec.comps).toBe(3); expect(Array.from(dec.data)).toEqual(Array.from(px));
  });

  it('decodes CMYK exactly', () => {
    const w = 6, h = 5; const px = new Uint8Array(w * h * 4);
    for (let i = 0; i < w * h; i++) { px[i * 4] = (i * 2) & 0xff; px[i * 4 + 1] = (i * 9) & 0xff; px[i * 4 + 2] = (i * 4 + 3) & 0xff; px[i * 4 + 3] = (i * 6 + 1) & 0xff; }
    const dec = decodeJpeg(encodeLosslessJpeg({ width: w, height: h, comps: 4, pixels: px }));
    expect(dec.comps).toBe(4); expect(Array.from(dec.data)).toEqual(Array.from(px));
  });

  it('decodes exactly under every predictor (1..7)', () => {
    const w = 10, h = 8; const px = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) px[y * w + x] = (x * 11 + y * 19 + x * y) & 0xff;
    for (let psv = 1 as 1 | 2 | 3 | 4 | 5 | 6 | 7; psv <= 7; psv++) {
      const dec = decodeJpeg(encodeLosslessJpeg({ width: w, height: h, comps: 1, pixels: px, predictor: psv }));
      expect(Array.from(dec.data), `predictor ${psv}`).toEqual(Array.from(px));
    }
  });
});

describe('decodeJpeg — lossless (SOF11 arithmetic)', () => {
  const A = 'arithmetic' as const;
  it('decodes grayscale exactly', () => {
    const w = 9, h = 7; const px = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) px[y * w + x] = (x * 13 + y * 7) & 0xff;
    const dec = decodeJpeg(encodeLosslessJpeg({ width: w, height: h, comps: 1, pixels: px, mode: A }));
    expect(Array.from(dec.data)).toEqual(Array.from(px));
  });

  it('decodes RGB exactly', () => {
    const w = 8, h = 8; const px = new Uint8Array(w * h * 3);
    for (let i = 0; i < w * h; i++) { px[i * 3] = (i * 3) & 0xff; px[i * 3 + 1] = (i * 5 + 17) & 0xff; px[i * 3 + 2] = (i * 7 + 40) & 0xff; }
    const dec = decodeJpeg(encodeLosslessJpeg({ width: w, height: h, comps: 3, pixels: px, mode: A }));
    expect(dec.comps).toBe(3); expect(Array.from(dec.data)).toEqual(Array.from(px));
  });

  it('decodes CMYK exactly', () => {
    const w = 6, h = 5; const px = new Uint8Array(w * h * 4);
    for (let i = 0; i < w * h; i++) { px[i * 4] = (i * 2) & 0xff; px[i * 4 + 1] = (i * 9) & 0xff; px[i * 4 + 2] = (i * 4 + 3) & 0xff; px[i * 4 + 3] = (i * 6 + 1) & 0xff; }
    const dec = decodeJpeg(encodeLosslessJpeg({ width: w, height: h, comps: 4, pixels: px, mode: A }));
    expect(dec.comps).toBe(4); expect(Array.from(dec.data)).toEqual(Array.from(px));
  });

  it('decodes exactly under every predictor (1..7)', () => {
    const w = 10, h = 8; const px = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) px[y * w + x] = (x * 11 + y * 19 + x * y) & 0xff;
    for (let psv = 1 as 1 | 2 | 3 | 4 | 5 | 6 | 7; psv <= 7; psv++) {
      const dec = decodeJpeg(encodeLosslessJpeg({ width: w, height: h, comps: 1, pixels: px, mode: A, predictor: psv }));
      expect(Array.from(dec.data), `predictor ${psv}`).toEqual(Array.from(px));
    }
  });

  it('round-trips custom DAC conditioning', () => {
    const w = 12, h = 9; const px = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) px[y * w + x] = (x * 21 + y * 5) & 0xff;
    const dec = decodeJpeg(encodeLosslessJpeg({ width: w, height: h, comps: 1, pixels: px, mode: A, dac: { L: 1, U: 3 } }));
    expect(Array.from(dec.data)).toEqual(Array.from(px));
  });
});

describe('decodeJpeg — hierarchical (differential lossless)', () => {
  it('SOF7 Huffman: two-frame hierarchical recovers grayscale exactly', () => {
    const w = 32, h = 32; const px = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) px[y * w + x] = (x * 5 + y * 3) & 0xff;
    const dec = decodeJpeg(encodeHierarchicalJpeg({ width: w, height: h, comps: 1, pixels: px, residual: 'lossless', expand: 'hv' }));
    expect(dec.width).toBe(w); expect(dec.height).toBe(h); expect(dec.comps).toBe(1);
    expect(Array.from(dec.data)).toEqual(Array.from(px)); // exact
  });

  it('SOF15 arithmetic: two-frame hierarchical recovers grayscale exactly', () => {
    const w = 32, h = 32; const px = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) px[y * w + x] = (x * 5 + y * 3) & 0xff;
    const dec = decodeJpeg(encodeHierarchicalJpeg({ width: w, height: h, comps: 1, pixels: px, residual: 'lossless', mode: 'arithmetic', expand: 'hv' }));
    expect(Array.from(dec.data)).toEqual(Array.from(px));
  });

  it('recovers RGB exactly (SOF7 lossless differential)', () => {
    const w = 32, h = 16; const px = new Uint8Array(w * h * 3);
    for (let i = 0; i < w * h; i++) { px[i * 3] = (i * 3) & 0xff; px[i * 3 + 1] = (i * 5 + 17) & 0xff; px[i * 3 + 2] = (i * 7 + 40) & 0xff; }
    const dec = decodeJpeg(encodeHierarchicalJpeg({ width: w, height: h, comps: 3, pixels: px, residual: 'lossless', expand: 'hv' }));
    expect(dec.comps).toBe(3); expect(Array.from(dec.data)).toEqual(Array.from(px));
  });

  it('SOF5 Huffman: differential sequential-DCT residual recovers grayscale within tolerance', () => {
    const w = 32, h = 32; const px = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) px[y * w + x] = (x * 5 + y * 3) & 0xff;
    const dec = decodeJpeg(encodeHierarchicalJpeg({ width: w, height: h, comps: 1, pixels: px, residual: 'seq-dct', expand: 'hv' }));
    expect(dec.width).toBe(w);
    for (let i = 0; i < w * h; i++) expect(Math.abs(dec.data[i] - px[i])).toBeLessThanOrEqual(2);
  });

  it('SOF13 arithmetic: differential sequential-DCT residual recovers grayscale within tolerance', () => {
    const w = 32, h = 32; const px = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) px[y * w + x] = (x * 5 + y * 3) & 0xff;
    const dec = decodeJpeg(encodeHierarchicalJpeg({ width: w, height: h, comps: 1, pixels: px, residual: 'seq-dct', mode: 'arithmetic', expand: 'hv' }));
    for (let i = 0; i < w * h; i++) expect(Math.abs(dec.data[i] - px[i])).toBeLessThanOrEqual(2);
  });

  it('SOF6 Huffman: differential progressive-DCT residual recovers grayscale within tolerance', () => {
    const w = 32, h = 32; const px = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) px[y * w + x] = (x * 5 + y * 3) & 0xff;
    const dec = decodeJpeg(encodeHierarchicalJpeg({ width: w, height: h, comps: 1, pixels: px, residual: 'prog-dct', expand: 'hv' }));
    for (let i = 0; i < w * h; i++) expect(Math.abs(dec.data[i] - px[i])).toBeLessThanOrEqual(2);
  });

  it('SOF14 arithmetic: differential progressive-DCT residual recovers grayscale within tolerance', () => {
    const w = 32, h = 32; const px = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) px[y * w + x] = (x * 5 + y * 3) & 0xff;
    const dec = decodeJpeg(encodeHierarchicalJpeg({ width: w, height: h, comps: 1, pixels: px, residual: 'prog-dct', mode: 'arithmetic', expand: 'hv' }));
    for (let i = 0; i < w * h; i++) expect(Math.abs(dec.data[i] - px[i])).toBeLessThanOrEqual(2);
  });

  it('recovers exactly under horizontal-only expansion', () => {
    const w = 32, h = 16; const px = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) px[y * w + x] = (x * 9 + y * 2) & 0xff;
    const dec = decodeJpeg(encodeHierarchicalJpeg({ width: w, height: h, comps: 1, pixels: px, residual: 'lossless', expand: 'h' }));
    expect(Array.from(dec.data)).toEqual(Array.from(px));
  });

  it('recovers exactly under vertical-only expansion', () => {
    const w = 16, h = 32; const px = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) px[y * w + x] = (x * 2 + y * 9) & 0xff;
    const dec = decodeJpeg(encodeHierarchicalJpeg({ width: w, height: h, comps: 1, pixels: px, residual: 'lossless', expand: 'v' }));
    expect(Array.from(dec.data)).toEqual(Array.from(px));
  });
});

describe('decodeJpeg — lossless restart intervals', () => {
  const contains = (b: Uint8Array, m: number) => { for (let i = 0; i + 1 < b.length; i++) if (b[i] === 0xff && b[i + 1] === m) return true; return false; };
  const gradient = (w: number, h: number) => { const px = new Uint8Array(w * h); for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) px[y * w + x] = (x * 7 + y * 3) & 0xff; return px; };

  it('Huffman: restart stream decodes identically to no-restart (row-aligned)', () => {
    const w = 8, h = 6; const px = gradient(w, h);
    const rst = encodeLosslessJpeg({ width: w, height: h, comps: 1, pixels: px, restartInterval: w * 2 }); // every 2 rows
    expect(contains(rst, 0xdd)).toBe(true);           // DRI present
    expect(contains(rst, 0xd0)).toBe(true);           // at least one RST0
    const a = decodeJpeg(rst);
    const b = decodeJpeg(encodeLosslessJpeg({ width: w, height: h, comps: 1, pixels: px }));
    expect(Array.from(a.data)).toEqual(Array.from(px)); // exact
    expect(Array.from(a.data)).toEqual(Array.from(b.data));
  });

  it('arithmetic: restart stream decodes identically to no-restart (row-aligned)', () => {
    const w = 8, h = 6; const px = gradient(w, h);
    const rst = encodeLosslessJpeg({ width: w, height: h, comps: 1, pixels: px, mode: 'arithmetic', restartInterval: w * 2 });
    expect(contains(rst, 0xdd)).toBe(true);
    expect(contains(rst, 0xd0)).toBe(true);
    const a = decodeJpeg(rst);
    const b = decodeJpeg(encodeLosslessJpeg({ width: w, height: h, comps: 1, pixels: px, mode: 'arithmetic' }));
    expect(Array.from(a.data)).toEqual(Array.from(px));
    expect(Array.from(a.data)).toEqual(Array.from(b.data));
  });
});

describe('decodeJpeg — progressive (SOF2), spectral selection', () => {
  it('round-trips a grayscale image and matches the baseline decode', () => {
    const w = 16, h = 16; const px = new Uint8Array(w * h);
    for (let i = 0; i < w * h; i++) px[i] = (i * 7) % 256;
    const base = decodeJpeg(encodeBaselineJpeg({ width: w, height: h, comps: 1, pixels: px }));
    const prog = decodeJpeg(encodeProgressiveJpeg({ width: w, height: h, comps: 1, pixels: px }));
    expect(prog.width).toBe(w); expect(prog.height).toBe(h); expect(prog.comps).toBe(1);
    for (let i = 0; i < w * h; i++) expect(prog.data[i]).toBe(base.data[i]); // exact: same coeffs
  });

  it('round-trips an RGB image (interleaved DC scan) and matches baseline', () => {
    const w = 16, h = 16; const px = new Uint8Array(w * h * 3);
    for (let i = 0; i < w * h; i++) { px[i * 3] = (i * 3) % 256; px[i * 3 + 1] = (i * 5) % 256; px[i * 3 + 2] = (i * 11) % 256; }
    const base = decodeJpeg(encodeBaselineJpeg({ width: w, height: h, comps: 3, pixels: px }));
    const prog = decodeJpeg(encodeProgressiveJpeg({ width: w, height: h, comps: 3, pixels: px }));
    expect(prog.comps).toBe(3);
    for (let i = 0; i < w * h * 3; i++) expect(prog.data[i]).toBe(base.data[i]);
  });

  it('handles an EOB run across flat blocks (matches baseline)', () => {
    const w = 16, h = 16; const px = new Uint8Array(w * h).fill(120); // flat → all-zero AC → one big EOB run
    const base = decodeJpeg(encodeBaselineJpeg({ width: w, height: h, comps: 1, pixels: px }));
    const prog = decodeJpeg(encodeProgressiveJpeg({ width: w, height: h, comps: 1, pixels: px }));
    for (let i = 0; i < w * h; i++) expect(prog.data[i]).toBe(base.data[i]);
  });

  it('round-trips grayscale with successive approximation (DC/AC refine) matching baseline', () => {
    const w = 16, h = 16; const px = new Uint8Array(w * h);
    for (let i = 0; i < w * h; i++) px[i] = (i * 37 + (i % 5) * 13) % 256; // varied coeffs incl. negatives
    const base = decodeJpeg(encodeBaselineJpeg({ width: w, height: h, comps: 1, pixels: px }));
    const prog = decodeJpeg(encodeProgressiveJpeg({ width: w, height: h, comps: 1, pixels: px, successive: true }));
    for (let i = 0; i < w * h; i++) expect(prog.data[i]).toBe(base.data[i]);
  });

  it('round-trips RGB with successive approximation matching baseline', () => {
    const w = 16, h = 16; const px = new Uint8Array(w * h * 3);
    for (let i = 0; i < w * h; i++) { px[i * 3] = (i * 17) % 256; px[i * 3 + 1] = (i * 31) % 256; px[i * 3 + 2] = (i * 47) % 256; }
    const base = decodeJpeg(encodeBaselineJpeg({ width: w, height: h, comps: 3, pixels: px }));
    const prog = decodeJpeg(encodeProgressiveJpeg({ width: w, height: h, comps: 3, pixels: px, successive: true }));
    for (let i = 0; i < w * h * 3; i++) expect(prog.data[i]).toBe(base.data[i]);
  });

  it('round-trips a subsampled (4:2:0) flat RGB image matching baseline', () => {
    const w = 16, h = 16; const px = new Uint8Array(w * h * 3);
    for (let i = 0; i < w * h; i++) { px[i * 3] = 200; px[i * 3 + 1] = 80; px[i * 3 + 2] = 40; }
    const base = decodeJpeg(encodeBaselineJpeg({ width: w, height: h, comps: 3, pixels: px, subsample: true }));
    const prog = decodeJpeg(encodeProgressiveJpeg({ width: w, height: h, comps: 3, pixels: px, subsample: true, successive: true }));
    expect(prog.width).toBe(w); expect(prog.height).toBe(h);
    for (let i = 0; i < w * h * 3; i++) expect(Math.abs(prog.data[i] - base.data[i])).toBeLessThanOrEqual(1);
  });

  it('decodes a progressive stream with a restart interval identically', () => {
    const w = 24, h = 24; const px = new Uint8Array(w * h);
    for (let i = 0; i < w * h; i++) px[i] = (i * 13) % 256;
    const rstBytes = encodeProgressiveJpeg({ width: w, height: h, comps: 1, pixels: px, successive: true, restartInterval: 3 });
    // Guard: the restart stream must actually contain a DRI segment and RSTn markers.
    let hasDri = false, hasRst = false;
    for (let i = 0; i + 1 < rstBytes.length; i++) { if (rstBytes[i] === 0xff) { const m = rstBytes[i + 1]; if (m === 0xdd) hasDri = true; if (m >= 0xd0 && m <= 0xd7) hasRst = true; } }
    expect(hasDri).toBe(true); expect(hasRst).toBe(true);
    const plain = decodeJpeg(encodeProgressiveJpeg({ width: w, height: h, comps: 1, pixels: px, successive: true }));
    const rst = decodeJpeg(rstBytes);
    for (let i = 0; i < w * h; i++) expect(rst.data[i]).toBe(plain.data[i]);
  });

  // Hybrid fixture slot: drop a real, externally-generated progressive JPEG here to
  // guard against an encoder/decoder shared bug (the in-repo encoder validates only
  // against the baseline decode). Provenance recipe:
  //   ImageMagick:  magick input.png -interlace JPEG -sampling-factor 4:4:4 ref.jpg
  //   libjpeg:      cjpeg -progressive -sample 1x1 -outfile ref.jpg input.pgm
  // Commit the bytes as a Uint8Array constant + the known source pixels, then assert
  // decodeJpeg(REF) matches the source within DCT tolerance.
  it.skip('decodes a real (externally-generated) progressive JPEG reference stream', () => {
    // const REF = Uint8Array.from([/* paste bytes */]);
    // const dec = decodeJpeg(REF);
    // expect(dec.width).toBe(/* known */); // ...compare dec.data to known source pixels
  });
});

describe('decodeImageRgba — DCTDecode', () => {
  it('decodes a baseline JPEG image XObject to RGBA', () => {
    const w = 8, h = 8;
    const px = new Uint8Array(w * h * 3);
    for (let i = 0; i < w * h; i++) { px[i * 3] = 200; px[i * 3 + 1] = 100; px[i * 3 + 2] = 50; }
    const jpg = encodeBaselineJpeg({ width: w, height: h, comps: 3, pixels: px });
    const doc = Document.Open(buildSingleImagePdf({
      width: w, height: h, colorSpace: 'DeviceRGB', bits: 8, filter: 'DCTDecode', raw: jpg,
    }));
    // Find the Im0 image stream.
    const page = doc.Pages[0];
    const res = page.Resources!;
    const xobj = doc.resolve(res.get('XObject')) as PdfDict;
    const stream = doc.resolve(xobj.get('Im0'));
    if (!isStream(stream)) throw new Error('expected image stream');
    const img = decodeImageRgba(doc, stream, [0, 0, 0]);
    expect(img).toBeDefined();
    expect(img!.w).toBe(w); expect(img!.h).toBe(h);
    near(img!.data[0], 200, 5); near(img!.data[1], 100, 5); near(img!.data[2], 50, 5);
    expect(img!.data[3]).toBe(255); // opaque (no SMask)
  });

  it('decodes an arithmetic (SOF9) JPEG image XObject to RGBA', () => {
    const w = 8, h = 8; const px = new Uint8Array(w * h * 3);
    for (let i = 0; i < w * h; i++) { px[i * 3] = 200; px[i * 3 + 1] = 100; px[i * 3 + 2] = 50; }
    const jpg = encodeSequentialArithJpeg({ width: w, height: h, comps: 3, pixels: px });
    const doc = Document.Open(buildSingleImagePdf({ width: w, height: h, colorSpace: 'DeviceRGB', bits: 8, filter: 'DCTDecode', raw: jpg }));
    const res = doc.Pages[0].Resources!;
    const xobj = doc.resolve(res.get('XObject')) as PdfDict;
    const stream = doc.resolve(xobj.get('Im0'));
    if (!isStream(stream)) throw new Error('expected image stream');
    const img = decodeImageRgba(doc, stream, [0, 0, 0]);
    expect(img).toBeDefined();
    near(img!.data[0], 200, 5); near(img!.data[1], 100, 5); near(img!.data[2], 50, 5);
  });

  it('decodes a lossless (SOF3) JPEG image XObject to RGBA', () => {
    const w = 8, h = 8; const px = new Uint8Array(w * h * 3);
    for (let i = 0; i < w * h; i++) { px[i * 3] = 200; px[i * 3 + 1] = 100; px[i * 3 + 2] = 50; }
    const jpg = encodeLosslessJpeg({ width: w, height: h, comps: 3, pixels: px });
    const doc = Document.Open(buildSingleImagePdf({ width: w, height: h, colorSpace: 'DeviceRGB', bits: 8, filter: 'DCTDecode', raw: jpg }));
    const res = doc.Pages[0].Resources!;
    const xobj = doc.resolve(res.get('XObject')) as PdfDict;
    const stream = doc.resolve(xobj.get('Im0'));
    if (!isStream(stream)) throw new Error('expected image stream');
    const img = decodeImageRgba(doc, stream, [0, 0, 0]);
    expect(img).toBeDefined();
    expect(img!.data[0]).toBe(200); expect(img!.data[1]).toBe(100); expect(img!.data[2]).toBe(50); // exact
  });

  it('decodes a hierarchical (SOF7 differential) JPEG image XObject to RGBA', () => {
    const w = 16, h = 16; const px = new Uint8Array(w * h * 3);
    for (let i = 0; i < w * h; i++) { px[i * 3] = 200; px[i * 3 + 1] = 100; px[i * 3 + 2] = 50; }
    const jpg = encodeHierarchicalJpeg({ width: w, height: h, comps: 3, pixels: px, residual: 'lossless', expand: 'hv' });
    const doc = Document.Open(buildSingleImagePdf({ width: w, height: h, colorSpace: 'DeviceRGB', bits: 8, filter: 'DCTDecode', raw: jpg }));
    const res = doc.Pages[0].Resources!;
    const xobj = doc.resolve(res.get('XObject')) as PdfDict;
    const stream = doc.resolve(xobj.get('Im0'));
    if (!isStream(stream)) throw new Error('expected image stream');
    const img = decodeImageRgba(doc, stream, [0, 0, 0]);
    expect(img).toBeDefined();
    expect(img!.data[0]).toBe(200); expect(img!.data[1]).toBe(100); expect(img!.data[2]).toBe(50);
  });

  // Hybrid fixture slot: drop a real, externally-generated arithmetic JPEG here to
  // guard against an encoder/decoder shared bug (the in-repo encoder validates only
  // against the baseline decode). Provenance recipe:
  //   libjpeg:  cjpeg -arithmetic -sample 1x1 -outfile ref.jpg input.ppm
  // Commit the bytes as a Uint8Array constant + the known source pixels, then assert
  // decodeJpeg(REF) matches the source within DCT tolerance.
  it.skip('decodes a real (externally-generated) arithmetic JPEG reference stream', () => {
    // const REF = Uint8Array.from([/* paste bytes */]);
    // const dec = decodeJpeg(REF); // ...compare dec.data to known source pixels
  });
});

// Hybrid fixture slot: drop a real, externally-generated lossless JPEG here to
// guard against a shared encoder/decoder bug (the in-repo encoder validates only
// against the known input pixels — a strong oracle since lossless is exact, but it
// cannot catch a symmetric restart/predictor-reset bug). libjpeg's cjpeg cannot
// emit lossless; provenance recipe:
//   jpeg-9:   cjpeg (jpeg-9 supports lossless via its lossless mode)
//   PVRG:     pvrg-jpeg -l -s ref.jpg -ci 0 input.raw
// Commit the bytes as a Uint8Array + the known source pixels, then assert
// decodeJpeg(REF) equals the source exactly.
describe('decodeJpeg — lossless real-file reference', () => {
  it.skip('decodes a real (externally-generated) lossless JPEG reference stream', () => {
    // const REF = Uint8Array.from([/* paste bytes */]);
    // const dec = decodeJpeg(REF); // ...compare dec.data to known source pixels exactly
  });
});

// Hybrid fixture slot: drop a real, externally-generated hierarchical JPEG here to
// guard the EXP upsampling filter + composition against a shared encoder/decoder
// bug (the in-repo encoder validates against the known original, but uses the same
// upsample2x on both sides). libjpeg's cjpeg cannot emit hierarchical; provenance:
//   jpeg-9:  a hierarchical progression script, or PVRG pvrg-jpeg.
// Commit the bytes + known source pixels, then assert decodeJpeg(REF) matches.
describe('decodeJpeg — hierarchical real-file reference', () => {
  it.skip('decodes a real (externally-generated) hierarchical JPEG reference stream', () => {
    // const REF = Uint8Array.from([/* paste bytes */]);
    // const dec = decodeJpeg(REF); // ...compare to known source pixels
  });
});

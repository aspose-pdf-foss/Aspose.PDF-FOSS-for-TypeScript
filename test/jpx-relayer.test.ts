import { describe, it, expect } from 'vitest';
import { Bio, TagTree } from '../src/jpxt2.js';
import { decodeJpx, parseCodestream } from '../src/jpx.js';
import { BioWriter, TagTreeEnc, writePassCount, relayer } from '../scripts/jpx-relayer.mjs';
import * as F from './helpers/jpx-fixtures.js';

/** Read bits back out of a written buffer using the real decoder's Bio. */
const reader = (bytes: Uint8Array) => new Bio(bytes, 0, bytes.length);

describe('BioWriter', () => {
  it('round-trips a bit pattern through the decoder Bio', () => {
    const bits = [1, 0, 1, 1, 0, 0, 0, 1, 1, 0, 1];
    const bw = new BioWriter();
    for (const b of bits) bw.putbit(b);
    const bio = reader(bw.flush());
    expect(bits.map(() => bio.getbit())).toEqual(bits);
  });

  it('round-trips multi-bit values MSB-first', () => {
    const bw = new BioWriter();
    bw.write(0b1011, 4);
    bw.write(0b0110010, 7);
    const bio = reader(bw.flush());
    expect(bio.read(4)).toBe(0b1011);
    expect(bio.read(7)).toBe(0b0110010);
  });

  it('applies 0xFF bit-stuffing that the decoder unstuffs', () => {
    // Eight 1-bits emit an 0xFF byte; the next byte must carry only 7 bits.
    const bw = new BioWriter();
    for (let i = 0; i < 8; i++) bw.putbit(1);
    for (let i = 0; i < 7; i++) bw.putbit(1);
    const out = bw.flush();
    expect(out[0]).toBe(0xff);
    expect(out[1] & 0x80).toBe(0); // stuffed byte's top bit is not a data bit
    const bio = reader(out);
    for (let i = 0; i < 15; i++) expect(bio.getbit()).toBe(1);
  });
});

describe('writePassCount', () => {
  // Mirrors readPassCount (src/jpxt2.ts:112): 1, 2, 3-5, 6-36, 37+.
  it.each([1, 2, 3, 5, 6, 36, 37, 164])('round-trips a count of %i', (n) => {
    const bw = new BioWriter();
    writePassCount(bw, n);
    const bio = reader(bw.flush());
    const readPassCount = (): number => {
      if (bio.getbit() === 0) return 1;
      if (bio.getbit() === 0) return 2;
      const b = bio.read(2);
      if (b < 3) return 3 + b;
      const c = bio.read(5);
      if (c < 31) return 6 + c;
      return 37 + bio.read(7);
    };
    expect(readPassCount()).toBe(n);
  });
});

describe('TagTreeEnc', () => {
  it('round-trips leaf values through the decoder TagTree', () => {
    const w = 3, h = 2;
    const values = [0, 2, 1, 3, 0, 2]; // row-major
    const enc = new TagTreeEnc(w, h);
    for (let i = 0; i < h; i++) for (let j = 0; j < w; j++) enc.setLeaf(i, j, values[i * w + j]);
    enc.build();

    // Encode every leaf at rising thresholds, exactly as the zero-bit-plane
    // loop in readPacket does (src/jpxt2.ts:146-148).
    const bw = new BioWriter();
    for (let i = 0; i < h; i++) for (let j = 0; j < w; j++) {
      for (let t = 1; t <= values[i * w + j] + 1; t++) enc.encode(bw, i, j, t);
    }

    const bio = reader(bw.flush());
    const dec = new TagTree(w, h);
    const got: number[] = [];
    for (let i = 0; i < h; i++) for (let j = 0; j < w; j++) {
      let t = 1, v = 0;
      for (;;) { const r = dec.decode(bio, i, j, t); if (r < t) { v = r; break; } t++; }
      got.push(v);
    }
    expect(got).toEqual(values);
  });

  it('signals non-inclusion when a leaf value exceeds the threshold', () => {
    // Inclusion coding: leaf = first layer of inclusion; nLayers means "never".
    const nLayers = 3;
    const enc = new TagTreeEnc(1, 1);
    enc.setLeaf(0, 0, nLayers);
    enc.build();
    const bw = new BioWriter();
    for (let l = 0; l < nLayers; l++) enc.encode(bw, 0, 0, l + 1);

    const bio = reader(bw.flush());
    const dec = new TagTree(1, 1);
    for (let l = 0; l < nLayers; l++) expect(dec.decode(bio, 0, 0, l + 1) <= l).toBe(false);
  });
});

describe('relayer', () => {
  it('re-layers a single-layer codestream to 3 layers, sample-preserving', () => {
    const out = relayer(F.lossless_gray_j2k, 3);
    expect(parseCodestream(out).cod.layers).toBe(3);
    const img = decodeJpx(out);
    expect(img.comps).toBe(1);
    expect(Array.from(img.data)).toEqual(Array.from(F.lossless_gray_rgb.data));
  });

  it('preserves samples for a 3-component source', () => {
    // rpcl_j2k is RPCL; the relayer must re-emit in the source's own
    // progression order, not assume LRCP.
    const out = relayer(F.rpcl_j2k, 3);
    expect(parseCodestream(out).cod.layers).toBe(3);
    expect(Array.from(decodeJpx(out).data)).toEqual(Array.from(F.rpcl_rgb.data));
  });

  it('is stable across layer counts', () => {
    for (const n of [2, 3, 5]) {
      expect(Array.from(decodeJpx(relayer(F.lossless_gray_j2k, n)).data))
        .toEqual(Array.from(F.lossless_gray_rgb.data));
    }
  });

  it('refuses a source that already has multiple layers', () => {
    expect(() => relayer(relayer(F.lossless_gray_j2k, 3), 2)).toThrow(/already has 3 layers/);
  });

  it('refuses a layer count below 2', () => {
    expect(() => relayer(F.lossless_gray_j2k, 1)).toThrow(/nLayers/);
  });
});

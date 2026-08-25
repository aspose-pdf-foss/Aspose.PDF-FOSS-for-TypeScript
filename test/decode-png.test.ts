import { describe, it, expect } from 'vitest';
import { deflateSync } from 'node:zlib';
import { decodePng } from './helpers/decode-png.js';

/** Assemble a minimal 8-bit RGB PNG from pre-filtered rows. Built by hand so
 *  the test depends on no external encoder. */
function makePng(width: number, height: number, filteredRows: number[][]): Uint8Array {
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  const be32 = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (b: number[]) => {
    let c = 0xffffffff;
    for (const x of b) c = crcTable[(c ^ x) & 255] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: number[]) => {
    const t = [...type].map((c) => c.charCodeAt(0));
    return [...be32(data.length), ...t, ...data, ...be32(crc([...t, ...data]))];
  };
  const ihdr = [...be32(width), ...be32(height), 8, 2, 0, 0, 0];  // 8-bit, colorType 2 (RGB)
  const idat = [...deflateSync(Buffer.from(filteredRows.flat()))];
  return new Uint8Array([...sig, ...chunk('IHDR', ihdr), ...chunk('IDAT', idat), ...chunk('IEND', [])]);
}

describe('decodePng — adaptive filter types', () => {
  it('decodes filter 0 (None)', () => {
    const png = makePng(2, 1, [[0, 10, 20, 30, 40, 50, 60]]);
    const p = decodePng(png);
    expect(p.at(0, 0)).toEqual([10, 20, 30, 255]);
    expect(p.at(1, 0)).toEqual([40, 50, 60, 255]);
  });

  it('decodes filter 1 (Sub): each byte is a delta from the pixel to its left', () => {
    // Row: filter 1, then raw deltas. Pixel 0 has no left neighbour (a=0).
    const png = makePng(2, 1, [[1, 10, 20, 30, 5, 5, 5]]);
    const p = decodePng(png);
    expect(p.at(0, 0)).toEqual([10, 20, 30, 255]);
    expect(p.at(1, 0)).toEqual([15, 25, 35, 255]);   // 10+5, 20+5, 30+5
  });

  it('decodes filter 2 (Up): each byte is a delta from the pixel above', () => {
    const png = makePng(1, 2, [[0, 10, 20, 30], [2, 1, 2, 3]]);
    const p = decodePng(png);
    expect(p.at(0, 0)).toEqual([10, 20, 30, 255]);
    expect(p.at(0, 1)).toEqual([11, 22, 33, 255]);
  });

  it('decodes filter 3 (Average): delta from floor((left + above) / 2)', () => {
    const png = makePng(2, 2, [[0, 10, 20, 30, 40, 50, 60], [3, 0, 0, 0, 0, 0, 0]]);
    const p = decodePng(png);
    // Row 1 pixel 0: a=0, b=10 → floor(10/2)=5. Pixel 1: a=5, b=40 → floor(45/2)=22.
    expect(p.at(0, 1)).toEqual([5, 10, 15, 255]);
    expect(p.at(1, 1)).toEqual([22, 30, 37, 255]);
  });

  it('decodes filter 4 (Paeth)', () => {
    const png = makePng(2, 2, [[0, 10, 20, 30, 40, 50, 60], [4, 0, 0, 0, 0, 0, 0]]);
    const p = decodePng(png);
    // Row 1 pixel 0: a=0, b=10, c=0 → Paeth picks b=10. Pixel 1: a=10, b=40, c=10 → 40.
    expect(p.at(0, 1)).toEqual([10, 20, 30, 255]);
    expect(p.at(1, 1)).toEqual([40, 50, 60, 255]);
  });

  it('rejects an unknown filter type', () => {
    const png = makePng(1, 1, [[9, 1, 2, 3]]);
    expect(() => decodePng(png)).toThrow(/filter/);
  });
});

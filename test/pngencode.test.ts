import { describe, it, expect } from 'vitest';
import { inflateSync } from 'node:zlib';
import { encodePng } from '../src/pngencode.js';

const SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function chunks(png: Uint8Array): { type: string; data: Uint8Array }[] {
  const out: { type: string; data: Uint8Array }[] = [];
  let p = 8;
  while (p < png.length) {
    const len = (png[p] << 24) | (png[p + 1] << 16) | (png[p + 2] << 8) | png[p + 3];
    const type = String.fromCharCode(png[p + 4], png[p + 5], png[p + 6], png[p + 7]);
    out.push({ type, data: png.slice(p + 8, p + 8 + len) });
    p += 12 + len;
  }
  return out;
}

describe('encodePng', () => {
  it('emits a valid signature, IHDR, and round-trippable IDAT for RGB', () => {
    const samples = Uint8Array.from([255, 0, 0, 0, 255, 0, 0, 0, 255, 255, 255, 0]); // 2x2 RGB
    const png = encodePng(2, 2, samples, 'rgb');
    expect([...png.slice(0, 8)]).toEqual(SIG);
    const cs = chunks(png);
    expect(cs.map((c) => c.type)).toEqual(['IHDR', 'IDAT', 'IEND']);
    const ihdr = cs[0].data;
    expect((ihdr[0] << 24) | (ihdr[1] << 16) | (ihdr[2] << 8) | ihdr[3]).toBe(2); // width
    expect(ihdr[8]).toBe(8);  // bit depth
    expect(ihdr[9]).toBe(2);  // color type 2 = RGB
    // IDAT inflates to per-row (filter byte 0 + row bytes)
    const raw = inflateSync(Buffer.from(cs[1].data));
    expect(raw[0]).toBe(0); // row 0 filter byte
    expect([...raw.slice(1, 7)]).toEqual([255, 0, 0, 0, 255, 0]);
  });

  it('supports rgba and gray color types', () => {
    expect(chunks(encodePng(1, 1, Uint8Array.from([9, 9, 9, 128]), 'rgba'))[0].data[9].toString()).toBe('6');
    expect(chunks(encodePng(1, 1, Uint8Array.from([42]), 'gray'))[0].data[9].toString()).toBe('0');
  });
});

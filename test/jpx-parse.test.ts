import { describe, it, expect } from 'vitest';
import { parseCodestream, extractCodestream } from '../src/jpx.js';
import { lossless_gray_j2k, jp2box_j2k } from './helpers/jpx-fixtures.js';

describe('JPEG 2000 codestream parse', () => {
  it('unwraps a JP2 box container to a bare codestream (SOC)', () => {
    const cs = extractCodestream(jp2box_j2k);
    expect(cs[0]).toBe(0xff);
    expect(cs[1]).toBe(0x4f);
  });

  it('passes through a bare codestream unchanged', () => {
    expect(extractCodestream(lossless_gray_j2k)).toBe(lossless_gray_j2k);
  });

  it('parses SIZ/COD/QCD of the lossless-gray fixture', () => {
    const c = parseCodestream(extractCodestream(lossless_gray_j2k));
    expect(c.xsiz - c.xosiz).toBe(16);
    expect(c.ysiz - c.yosiz).toBe(16);
    expect(c.comps.length).toBe(1);
    expect(c.comps[0].precision).toBe(8);
    expect(c.comps[0].signed).toBe(false);
    expect(c.cod.reversible).toBe(true);
    expect(c.cod.levels).toBeGreaterThanOrEqual(1);
    expect(c.tileData.length).toBeGreaterThan(0);
  });

  it('throws UnsupportedFeatureError on a multi-tile SIZ', () => {
    const siz = buildSiz({ xsiz: 32, ysiz: 32, xtsiz: 16, ytsiz: 16, comps: 1 });
    expect(() => parseCodestream(siz)).toThrow(/tile/i);
  });

  it('throws on component sub-sampling', () => {
    const siz = buildSiz({ xsiz: 16, ysiz: 16, xtsiz: 16, ytsiz: 16, comps: 1, xr: 2 });
    expect(() => parseCodestream(siz)).toThrow(/sub-sampl/i);
  });
});

// Minimal SOC+SIZ+EOC builder for the negative tests.
function buildSiz(o: { xsiz: number; ysiz: number; xtsiz: number; ytsiz: number; comps: number; xr?: number }): Uint8Array {
  const n = o.comps;
  const len = 38 + 3 * n;
  const b: number[] = [0xff, 0x4f, 0xff, 0x51, (len >> 8) & 0xff, len & 0xff, 0, 0];
  const u32 = (v: number) => b.push((v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff);
  u32(o.xsiz); u32(o.ysiz); u32(0); u32(0);
  u32(o.xtsiz); u32(o.ytsiz); u32(0); u32(0);
  b.push((n >> 8) & 0xff, n & 0xff);
  for (let i = 0; i < n; i++) b.push(7, o.xr ?? 1, 1); // 8-bit unsigned, xr:1
  b.push(0xff, 0xd9);
  return Uint8Array.from(b);
}

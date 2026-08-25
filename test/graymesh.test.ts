import { describe, it, expect } from 'vitest';
import { respliceMesh, type MeshLayout } from '../src/graymesh.js';

/** Take the red component, so a test asserts the SPLICE rather than the luma. */
const red = (comps: number[]): number => comps[0] ?? 0;

const rgb8 = (type: number, extra: Partial<MeshLayout> = {}): MeshLayout => ({
  type,
  bitsPerCoordinate: 16,
  bitsPerComponent: 8,
  bitsPerFlag: 8,
  components: 3,
  colorDecode: [0, 1, 0, 1, 0, 1],
  ...extra,
});

describe('respliceMesh — type 4 free-form triangles', () => {
  it('replaces a vertex colour with one component and keeps the geometry bytes', () => {
    // flag 0, x = 0x0102, y = 0x0304, rgb = ff 00 00
    const data = new Uint8Array([0, 0x01, 0x02, 0x03, 0x04, 0xff, 0x00, 0x00]);

    const r = respliceMesh(data, rgb8(4), red);

    expect(r).toEqual({
      kind: 'ok',
      data: new Uint8Array([0, 0x01, 0x02, 0x03, 0x04, 0xff]),
    });
  });
});

describe('respliceMesh — the per-record padding rule', () => {
  // 2-bit flag + two 12-bit coordinates + three 4-bit components = 38 bits,
  // which 32000-1 pads to 40. Get that wrong and every LATER record is read
  // two bits early, so the second vertex is what this fixture is for.
  const nibble: MeshLayout = {
    type: 4,
    bitsPerCoordinate: 12,
    bitsPerComponent: 4,
    bitsPerFlag: 2,
    components: 3,
    colorDecode: [0, 1, 0, 1, 0, 1],
  };

  it('byte-aligns each type 4 vertex, so a sub-byte record does not drift', () => {
    const data = new Uint8Array([
      // flag 0, x = 0xABC, y = 0x123, rgb = 0, F, 0
      0x2a, 0xf0, 0x48, 0xc3, 0xc0,
      // flag 1, x = 0x001, y = 0x002, rgb = F, 0, 0
      0x40, 0x04, 0x00, 0xbc, 0x00,
    ]);

    const r = respliceMesh(data, nibble, red);

    // 2 + 12 + 12 + 4 = 30 bits per vertex out, padded to 32.
    expect(r).toEqual({
      kind: 'ok',
      data: new Uint8Array([0x2a, 0xf0, 0x48, 0xc0, 0x40, 0x04, 0x00, 0xbc]),
    });
  });
});

describe('respliceMesh — type 5 lattice-form triangles', () => {
  // No flag, and no per-vertex padding: 12 + 12 + 4*3 = 36 bits runs straight
  // into the next vertex. Aligning here instead would read vertex 2 four bits
  // late, which is why both coordinates are sub-byte.
  const nibble: MeshLayout = {
    type: 5,
    bitsPerCoordinate: 12,
    bitsPerComponent: 4,
    bitsPerFlag: 0,
    components: 3,
    colorDecode: [0, 1, 0, 1, 0, 1],
  };

  it('reads vertices as one continuous bit stream, with no flag', () => {
    const data = new Uint8Array([
      // x = 0xABC, y = 0x123, rgb = 0, F, 0 | x = 0x001, y = 0x002, rgb = F, 0, 0
      0xab, 0xc1, 0x23, 0x0f, 0x00, 0x01, 0x00, 0x2f, 0x00,
    ]);

    const r = respliceMesh(data, nibble, red);

    expect(r).toEqual({
      kind: 'ok',
      data: new Uint8Array([0xab, 0xc1, 0x23, 0x00, 0x01, 0x00, 0x2f]),
    });
  });
});

describe('respliceMesh — type 6 and 7 patch meshes', () => {
  /** `count` ascending bytes, standing in for coordinates whose values do not
   *  matter as long as every one of them survives. */
  const seq = (count: number, from = 1): number[] =>
    Array.from({ length: count }, (_, i) => from + i);

  const byteCoords = (type: number): MeshLayout =>
    rgb8(type, { bitsPerCoordinate: 8 });

  const CORNERS = [0xff, 0, 0, 0, 0xff, 0, 0, 0, 0xff, 0x40, 0x40, 0x40];

  it('reads 12 point pairs and 4 corner colours from a flag 0 type 6 patch', () => {
    const data = new Uint8Array([0, ...seq(24), ...CORNERS]);

    const r = respliceMesh(data, byteCoords(6), red);

    expect(r).toEqual({
      kind: 'ok',
      data: new Uint8Array([0, ...seq(24), 0xff, 0, 0, 0x40]),
    });
  });

  it('reads 8 pairs and 2 colours from a flag 1 patch, whose edge is shared', () => {
    const data = new Uint8Array([1, ...seq(16), 0xff, 0, 0, 0, 0, 0xff]);

    const r = respliceMesh(data, byteCoords(6), red);

    expect(r).toEqual({
      kind: 'ok',
      data: new Uint8Array([1, ...seq(16), 0xff, 0]),
    });
  });

  it('reads 16 point pairs from a type 7 patch, the tensor form', () => {
    const data = new Uint8Array([0, ...seq(32), ...CORNERS]);

    const r = respliceMesh(data, byteCoords(7), red);

    expect(r).toEqual({
      kind: 'ok',
      data: new Uint8Array([0, ...seq(32), 0xff, 0, 0, 0x40]),
    });
  });
});

describe('respliceMesh — component decoding and damaged data', () => {
  it('maps each component through its own /Decode range before recolouring', () => {
    const seen: number[][] = [];
    // Not all [0, 1]: a Lab a* runs -100..100 and an Indexed component runs
    // 0..2^bpc-1, so a splicer that hands the raw integer on greys them wrongly
    // while every DeviceRGB mesh still converts.
    const layout = rgb8(4, { colorDecode: [0, 1, -100, 100, 0, 255] });
    const data = new Uint8Array([0, 0, 0, 0, 0, 0xff, 0x00, 0x80]);

    respliceMesh(data, layout, (comps) => { seen.push(comps); return 0; });

    expect(seen).toEqual([[1, -100, 128]]);
  });

  it('writes the grey at the source component width, over the range 0..1', () => {
    const data = new Uint8Array([0, 0, 0, 0, 0, 0, 0, 0]);

    const r = respliceMesh(data, rgb8(4), () => 0.5);

    if (r.kind !== 'ok') throw new Error(r.reason);
    expect(r.data[5]).toBe(128);                      // round(0.5 * 255)
  });

  it('refuses data that ends mid-record rather than emitting a short mesh', () => {
    // One byte short of the 8 a 16-bit-coordinate RGB vertex needs.
    const data = new Uint8Array([0, 0, 0, 0, 0, 0xff, 0x00]);

    expect(respliceMesh(data, rgb8(4), red)).toEqual({
      kind: 'error',
      reason: 'data ends mid-record',
    });
  });

  it('accepts the stream\u2019s own final-byte padding', () => {
    // Two 36-bit type 5 vertices are 72 bits, which is a whole 9 bytes; one is
    // 36 and leaves 4 bits of padding that are not a record.
    const layout: MeshLayout = {
      type: 5, bitsPerCoordinate: 12, bitsPerComponent: 4, bitsPerFlag: 0,
      components: 3, colorDecode: [0, 1, 0, 1, 0, 1],
    };
    const data = new Uint8Array([0xab, 0xc1, 0x23, 0x0f, 0x00]);

    expect(respliceMesh(data, layout, red).kind).toBe('ok');
  });
});

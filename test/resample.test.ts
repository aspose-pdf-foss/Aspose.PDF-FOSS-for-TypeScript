import { describe, it, expect } from 'vitest';
import { resampleBox } from '../src/resample.js';

describe('resampleBox', () => {
  it('averages a 4x1 ramp down to 2x1', () => {
    // Each destination pixel box-averages exactly two source pixels.
    const src = Uint8Array.from([0, 10, 20, 30]);
    expect([...resampleBox(src, 4, 1, 1, 2, 1)]).toEqual([5, 25]);
  });

  it('keeps a flat plane flat', () => {
    const src = new Uint8Array(64).fill(200);
    const out = resampleBox(src, 8, 8, 1, 4, 4);
    expect([...out]).toEqual(new Array(16).fill(200));
  });

  it('preserves channel interleaving', () => {
    // 2x1 RGB: red then blue -> 1x1 averages each channel independently.
    const src = Uint8Array.from([255, 0, 0, 0, 0, 255]);
    expect([...resampleBox(src, 2, 1, 3, 1, 1)]).toEqual([128, 0, 128]);
  });

  it('collapses a full row to one pixel without dividing by zero', () => {
    const src = Uint8Array.from([0, 30, 60]);
    expect([...resampleBox(src, 3, 1, 1, 1, 1)]).toEqual([30]);
  });

  it('returns a copy, not the input, when dimensions are unchanged', () => {
    const src = Uint8Array.from([1, 2, 3, 4]);
    const out = resampleBox(src, 4, 1, 1, 4, 1);
    expect([...out]).toEqual([1, 2, 3, 4]);
    expect(out).not.toBe(src);
  });

  it('rejects a sample count that does not match the geometry', () => {
    expect(() => resampleBox(new Uint8Array(3), 2, 2, 1, 1, 1)).toThrow(TypeError);
  });

  it('rejects a destination smaller than one pixel', () => {
    expect(() => resampleBox(new Uint8Array(4), 4, 1, 1, 0, 1)).toThrow(TypeError);
  });
});

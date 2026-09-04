import { describe, it, expect } from 'vitest';
import { luma, grayOf, grayNum, componentsOf, type GraySpace } from '../src/colorrule.js';
import type { ColorConverter } from '../src/colorspace.js';

const GRAY: GraySpace = { kind: 'gray' };
const RGB: GraySpace = { kind: 'rgb' };
const CMYK: GraySpace = { kind: 'cmyk' };

describe('luma', () => {
  it('is Rec. 601 on the primaries', () => {
    expect(luma(1, 0, 0)).toBeCloseTo(0.299, 10);
    expect(luma(0, 1, 0)).toBeCloseTo(0.587, 10);
    expect(luma(0, 0, 1)).toBeCloseTo(0.114, 10);
  });

  // The weights sum to 0.9999999999999999 in IEEE754, so white does NOT come
  // back exactly 1 -- and it must not be special-cased into doing so, which
  // would be a lie about the arithmetic. grayNum is where exactness lives: it
  // is what every emitted operand goes through, so `1 1 1 rg` still becomes
  // `1 g`. Measured, not assumed.
  it('maps black to exactly 0 and white to within an ulp of 1', () => {
    expect(luma(0, 0, 0)).toBe(0);
    expect(luma(1, 1, 1)).toBeCloseTo(1, 10);
    expect(grayNum(luma(1, 1, 1))).toBe(1);
  });

  it('clamps out-of-range input rather than emitting an invalid operand', () => {
    expect(luma(2, 2, 2)).toBe(1);
    expect(luma(-1, -1, -1)).toBe(0);
  });
});

describe('grayOf', () => {
  it('passes DeviceGray through unchanged', () => {
    expect(grayOf([0.5], GRAY)).toBe(0.5);
  });

  // The three weights sum to 0.9999999999999999 in IEEE754, so a neutral RGB
  // grey comes back 1 ulp low. grayNum's 4-decimal rounding is what makes an
  // already-neutral colour survive conversion byte-identically -- measured,
  // not assumed: without the rounding this asserts 0.49999999999999994.
  it('rounds a neutral RGB grey back to itself', () => {
    expect(grayNum(grayOf([0.5, 0.5, 0.5], RGB))).toBe(0.5);
  });

  it('converts CMYK through its RGB equivalent', () => {
    // Pure cyan -> rgb(0,1,1) -> 0.587 + 0.114.
    expect(grayOf([1, 0, 0, 0], CMYK)).toBeCloseTo(0.701, 10);
    // Any colour at K=1 is black.
    expect(grayOf([0.3, 0.4, 0.5, 1], CMYK)).toBe(0);
  });

  it('routes a non-device space through its ColorConverter', () => {
    const converter: ColorConverter = {
      components: 1,
      toRgb: () => [255, 0, 0],   // 0..255, as colorspace.ts emits
      initial: () => [0, 0, 0],
    };
    expect(grayOf([0.7], { kind: 'other', converter })).toBeCloseTo(0.299, 10);
  });

  it('reads a pattern space through its base', () => {
    expect(grayOf([1, 0, 0], { kind: 'pattern', base: RGB })).toBeCloseTo(0.299, 10);
  });

  it('treats missing components as zero rather than NaN', () => {
    expect(grayOf([], RGB)).toBe(0);
  });
});

describe('componentsOf', () => {
  it('reports the operand count each space takes', () => {
    expect(componentsOf(GRAY)).toBe(1);
    expect(componentsOf(RGB)).toBe(3);
    expect(componentsOf(CMYK)).toBe(4);
    expect(componentsOf({ kind: 'pattern' })).toBe(0);
    expect(componentsOf({ kind: 'pattern', base: RGB })).toBe(3);
  });
});

import { describe, it, expect } from 'vitest';
import { resolveColorSpace, cmykToRgb, rgbHex } from '../src/colorspace.js';
import { PdfObject, name } from '../src/types.js';

const id = (o: PdfObject | undefined): PdfObject => o ?? null;
const inflate = (s: { raw: Uint8Array }) => s.raw;

describe('resolveColorSpace', () => {
  it('DeviceRGB maps components straight through', () => {
    const cv = resolveColorSpace(name('DeviceRGB'), id, inflate);
    expect(cv.components).toBe(3);
    expect(cv.toRgb([1, 0, 0])).toEqual([255, 0, 0]);
  });

  it('DeviceGray expands to gray', () => {
    const cv = resolveColorSpace(name('DeviceGray'), id, inflate);
    expect(cv.components).toBe(1);
    expect(cv.toRgb([0.5])).toEqual([128, 128, 128]);
  });

  it('DeviceCMYK uses the naive conversion', () => {
    const cv = resolveColorSpace(name('DeviceCMYK'), id, inflate);
    expect(cv.toRgb([0, 0, 0, 0])).toEqual([255, 255, 255]);
    expect(cv.toRgb([0, 0, 0, 1])).toEqual([0, 0, 0]);
  });

  it('Indexed looks up a palette', () => {
    // [/Indexed /DeviceRGB 1 <hival lookup>] palette: index0=red index1=green
    const lookup: PdfObject = { kind: 'string', bytes: Uint8Array.from([255, 0, 0, 0, 255, 0]) };
    const cs: PdfObject = [name('Indexed'), name('DeviceRGB'), 1, lookup];
    const cv = resolveColorSpace(cs, id, inflate);
    expect(cv.components).toBe(1);
    expect(cv.toRgb([0])).toEqual([255, 0, 0]);
    expect(cv.toRgb([1])).toEqual([0, 255, 0]);
  });

  it('unknown colorspace falls back to gray-capable converter', () => {
    const cv = resolveColorSpace(name('Weird'), id, inflate);
    expect(cv.toRgb([0.5])).toEqual([128, 128, 128]);
  });
});

describe('helpers', () => {
  it('cmykToRgb and rgbHex', () => {
    expect(cmykToRgb(0, 0, 0, 0)).toEqual([255, 255, 255]);
    expect(rgbHex([255, 0, 16])).toBe('#ff0010');
  });
});

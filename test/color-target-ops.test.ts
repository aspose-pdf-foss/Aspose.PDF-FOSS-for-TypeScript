import { describe, it, expect } from 'vitest';
import { colorOps, grayscaleOps, type SpaceLookup } from '../src/colorops.js';
import type { GraySpace } from '../src/colorrule.js';
import type { ContentOp } from '../src/content.js';
import { name } from '../src/types.js';

const op = (operator: string, ...operands: unknown[]): ContentOp =>
  ({ operator, operands: operands as ContentOp['operands'] });

const none: SpaceLookup = () => undefined;
const rgbLookup: SpaceLookup = (n) =>
  n === 'CS0' ? ({ kind: 'rgb' } as GraySpace) : undefined;

/**
 * `colorOps` -- the content rewriter generalized to a target (85l8.1).
 *
 * `grayscaleOps` stays as the gray specialization, so `grayops.test.ts` keeps
 * asserting the gray path unedited and this file only has to cover what is
 * new: the other two targets, and the operators that STOP being no-ops once
 * the target is not gray.
 */
describe('colorOps — the target selects the operator', () => {
  it('rewrites rg to k for a cmyk target', () => {
    const r = colorOps([op('rg', 1, 0, 0)], none, 'cmyk');
    expect(r.ops).toEqual([op('k', 0, 1, 1, 0)]);
    expect(r.changed).toBe(1);
  });

  it('rewrites RG to K, keeping the stroke/fill distinction', () => {
    const r = colorOps([op('RG', 1, 0, 0)], none, 'cmyk');
    expect(r.ops).toEqual([op('K', 0, 1, 1, 0)]);
  });

  it('rewrites k to rg for an rgb target', () => {
    const r = colorOps([op('k', 1, 0, 0, 0)], none, 'rgb');
    expect(r.ops).toEqual([op('rg', 0, 1, 1)]);
  });

  // `g` is a no-op only when gray IS the target. This is the operator most
  // likely to be left behind by a gray-shaped rewrite, and a document keeping
  // its `g` operators under `to: 'cmyk'` is one that did not convert.
  it('rewrites g to k for a cmyk target, where gray-to-gray leaves it alone', () => {
    expect(colorOps([op('g', 0.25)], none, 'cmyk').ops).toEqual([op('k', 0, 0, 0, 0.75)]);
    expect(colorOps([op('g', 0.25)], none, 'gray').ops).toEqual([op('g', 0.25)]);
  });

  it('rewrites G to RG for an rgb target', () => {
    expect(colorOps([op('G', 0.5)], none, 'rgb').ops).toEqual([op('RG', 0.5, 0.5, 0.5)]);
  });

  it('counts no change when the operator is already in the target space', () => {
    expect(colorOps([op('k', 0, 0, 0, 1)], none, 'cmyk').changed).toBe(0);
    expect(colorOps([op('rg', 1, 0, 0)], none, 'rgb').changed).toBe(0);
  });
});

describe('colorOps — colour space operators', () => {
  it('retargets cs to the target space name', () => {
    expect(colorOps([op('cs', name('DeviceRGB'))], none, 'cmyk').ops)
      .toEqual([op('cs', name('DeviceCMYK'))]);
    expect(colorOps([op('CS', name('DeviceGray'))], none, 'rgb').ops)
      .toEqual([op('CS', name('DeviceRGB'))]);
  });

  it('leaves cs alone when it already names the target', () => {
    const r = colorOps([op('cs', name('DeviceCMYK'))], none, 'cmyk');
    expect(r.ops).toEqual([op('cs', name('DeviceCMYK'))]);
    expect(r.changed).toBe(0);
  });

  it('converts sc in a named space to the target operator', () => {
    const r = colorOps([op('cs', name('CS0')), op('sc', 0, 0, 1)], rgbLookup, 'cmyk');
    expect(r.ops[1]).toEqual(op('k', 1, 1, 0, 0));
  });

  it('keeps a pattern scn s trailing name and converts only its numbers', () => {
    const lookup: SpaceLookup = (n) =>
      n === 'P0' ? ({ kind: 'pattern', base: { kind: 'rgb' }, resourceName: 'P0' } as GraySpace)
                 : undefined;
    const r = colorOps([op('cs', name('P0')), op('scn', 1, 0, 0, name('Pat'))], lookup, 'cmyk');
    expect(r.ops[1]).toEqual(op('scn', 0, 1, 1, 0, name('Pat')));
  });
});

describe('colorOps — inline images', () => {
  const inline = (cs: string, nc: number, data: number[]): ContentOp => ({
    operator: 'BI',
    operands: [],
    inlineImage: {
      dict: new Map<string, unknown>([
        ['W', 2], ['H', 1], ['BPC', 8], ['CS', name(cs)],
      ]) as ContentOp['inlineImage'] extends undefined ? never : any,
      data: new Uint8Array(data),
    },
  }) as ContentOp;

  it('converts samples to the target component count', () => {
    // Two pixels, red then blue, in DeviceRGB -> DeviceCMYK.
    const r = colorOps([inline('RGB', 3, [255, 0, 0, 0, 0, 255])], none, 'cmyk');
    const img = r.ops[0]?.inlineImage;
    expect(img?.data).toHaveLength(8);                 // 2 pixels x 4 components
    expect(img?.dict.get('CS')).toEqual(name('CMYK'));
    expect(Array.from(img?.data ?? [])).toEqual([0, 255, 255, 0, 255, 255, 0, 0]);
  });

  it('leaves an inline image alone when it is already in the target space', () => {
    const r = colorOps([inline('RGB', 3, [255, 0, 0, 0, 0, 255])], none, 'rgb');
    expect(r.changed).toBe(0);
  });
});

describe('grayscaleOps is the gray specialization of colorOps', () => {
  it('agrees with colorOps at to: gray', () => {
    const ops = [op('rg', 1, 0, 0), op('cs', name('CS0')), op('sc', 0, 0, 1), op('g', 0.5)];
    expect(grayscaleOps(ops, rgbLookup)).toEqual(colorOps(ops, rgbLookup, 'gray'));
  });
});

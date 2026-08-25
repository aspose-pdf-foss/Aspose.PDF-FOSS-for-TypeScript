import { describe, it, expect } from 'vitest';
import { fitBox, parseTransform, parseViewBox, placementMatrix } from '../src/svgtransform.js';
import { apply, type Matrix } from '../src/text.js';

const at = (m: Matrix, x: number, y: number) =>
  apply(m, x, y).map((n) => Math.round(n * 1e6) / 1e6);

describe('parseTransform', () => {
  it('is the identity for an absent or empty value', () => {
    expect(parseTransform(undefined)).toEqual([1, 0, 0, 1, 0, 0]);
    expect(parseTransform('')).toEqual([1, 0, 0, 1, 0, 0]);
  });

  it('translates, with a defaulted y', () => {
    expect(at(parseTransform('translate(10, 20)'), 0, 0)).toEqual([10, 20]);
    expect(at(parseTransform('translate(10)'), 0, 0)).toEqual([10, 0]);
  });

  it('scales, with a defaulted uniform y', () => {
    expect(at(parseTransform('scale(2, 3)'), 1, 1)).toEqual([2, 3]);
    expect(at(parseTransform('scale(2)'), 1, 1)).toEqual([2, 2]);
  });

  it('rotates about the origin', () => {
    expect(at(parseTransform('rotate(90)'), 1, 0)).toEqual([0, 1]);
  });

  it('rotates about an explicit centre', () => {
    expect(at(parseTransform('rotate(90, 10, 10)'), 10, 10)).toEqual([10, 10]);
    expect(at(parseTransform('rotate(90, 10, 10)'), 20, 10)).toEqual([10, 20]);
  });

  it('skews on each axis', () => {
    expect(at(parseTransform('skewX(45)'), 0, 1)).toEqual([1, 1]);
    expect(at(parseTransform('skewY(45)'), 1, 0)).toEqual([1, 1]);
  });

  it('takes a raw matrix', () => {
    expect(parseTransform('matrix(1 2 3 4 5 6)')).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it('composes a list left to right, outermost first', () => {
    // translate then scale: the translation is NOT scaled.
    expect(at(parseTransform('translate(10 0) scale(2)'), 1, 0)).toEqual([12, 0]);
    // scale then translate: the translation IS scaled.
    expect(at(parseTransform('scale(2) translate(10 0)'), 1, 0)).toEqual([22, 0]);
  });

  it('tolerates commas, extra space and unknown functions', () => {
    expect(at(parseTransform('  translate( 10 , 20 )  '), 0, 0)).toEqual([10, 20]);
    expect(at(parseTransform('translate(10 0) bogus(1) scale(2)'), 1, 0)).toEqual([12, 0]);
  });
});

describe('parseViewBox', () => {
  it('parses four numbers', () => {
    expect(parseViewBox('0 0 100 50')).toEqual({ minX: 0, minY: 0, w: 100, h: 50 });
    expect(parseViewBox('-10,-20,30,40')).toEqual({ minX: -10, minY: -20, w: 30, h: 40 });
  });

  it('rejects a malformed or non-positive box', () => {
    expect(parseViewBox(undefined)).toBeUndefined();
    expect(parseViewBox('0 0 100')).toBeUndefined();
    expect(parseViewBox('0 0 0 50')).toBeUndefined();
    expect(parseViewBox('0 0 -5 50')).toBeUndefined();
  });
});

describe('placementMatrix', () => {
  const vb = { minX: 0, minY: 0, w: 100, h: 50 };
  const rect: [number, number, number, number] = [0, 0, 200, 200];

  it('flips the y axis: the viewBox top maps to the rect top', () => {
    // 'none' fills the rect exactly, so the mapping is easy to read.
    const m = placementMatrix(vb, rect, 'none');
    expect(at(m, 0, 0)).toEqual([0, 200]);       // SVG top-left  -> PDF top-left
    expect(at(m, 100, 50)).toEqual([200, 0]);    // SVG bottom-right -> PDF bottom-right
  });

  it('meet fits inside and centres on the short axis', () => {
    const m = placementMatrix(vb, rect, 'xMidYMid meet');
    // scale = min(200/100, 200/50) = 2 -> drawn 200x100, centred vertically.
    expect(at(m, 0, 0)).toEqual([0, 150]);
    expect(at(m, 100, 50)).toEqual([200, 50]);
  });

  it('slice covers the rect and overflows', () => {
    const m = placementMatrix(vb, rect, 'xMidYMid slice');
    // scale = max(200/100, 200/50) = 4 -> drawn 400x200, centred horizontally.
    expect(at(m, 0, 0)).toEqual([-100, 200]);
    expect(at(m, 100, 50)).toEqual([300, 0]);
  });

  it('honours each alignment corner', () => {
    expect(at(placementMatrix(vb, rect, 'xMinYMin meet'), 0, 0)).toEqual([0, 200]);
    expect(at(placementMatrix(vb, rect, 'xMaxYMax meet'), 0, 0)).toEqual([0, 100]);
    expect(at(placementMatrix(vb, rect, 'xMaxYMin meet'), 100, 0)).toEqual([200, 200]);
  });

  it('defaults to xMidYMid meet when preserveAspectRatio is absent', () => {
    expect(placementMatrix(vb, rect, undefined)).toEqual(placementMatrix(vb, rect, 'xMidYMid meet'));
  });

  it('lets fit override the file', () => {
    expect(placementMatrix(vb, rect, 'xMinYMin slice', 'meet'))
      .toEqual(placementMatrix(vb, rect, 'xMidYMid meet'));
    expect(placementMatrix(vb, rect, 'xMidYMid meet', 'fill'))
      .toEqual(placementMatrix(vb, rect, 'none'));
    expect(placementMatrix(vb, rect, 'none', 'slice'))
      .toEqual(placementMatrix(vb, rect, 'xMidYMid slice'));
  });

  it('offsets a viewBox whose origin is not zero', () => {
    const m = placementMatrix({ minX: 10, minY: 20, w: 100, h: 50 }, rect, 'none');
    expect(at(m, 10, 20)).toEqual([0, 200]);
  });

  it('honours a rect that is not at the origin', () => {
    const m = placementMatrix(vb, [50, 100, 200, 200], 'none');
    expect(at(m, 0, 0)).toEqual([50, 300]);
  });
});

describe('fitBox', () => {
  const src = { w: 200, h: 100 };            // 2:1
  const dest = { w: 100, h: 100 };           // 1:1

  it('meet fits inside and centres on the short axis', () => {
    expect(fitBox(src, dest, undefined)).toEqual({ sx: 0.5, sy: 0.5, tx: 0, ty: 25 });
  });

  it('slice covers and centres the overflow', () => {
    expect(fitBox(src, dest, 'xMidYMid slice')).toEqual({ sx: 1, sy: 1, tx: -50, ty: 0 });
  });

  it('none stretches each axis independently with no offset', () => {
    expect(fitBox(src, dest, 'none')).toEqual({ sx: 0.5, sy: 1, tx: 0, ty: 0 });
  });

  it('aligns to the min and max edges', () => {
    expect(fitBox(src, dest, 'xMinYMin meet').ty).toBe(0);
    expect(fitBox(src, dest, 'xMinYMax meet').ty).toBe(50);
  });

  it('lets an explicit fit override the attribute', () => {
    expect(fitBox(src, dest, 'xMinYMin slice', 'meet'))
      .toEqual({ sx: 0.5, sy: 0.5, tx: 0, ty: 25 });
    expect(fitBox(src, dest, 'xMidYMid meet', 'fill'))
      .toEqual({ sx: 0.5, sy: 1, tx: 0, ty: 0 });
  });

  it('honours the defer keyword by reading the align that follows it', () => {
    expect(fitBox(src, dest, 'defer xMinYMax meet').ty).toBe(50);
  });
});

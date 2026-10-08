// test/cssbackground.test.ts
import { describe, it, expect } from 'vitest';
import { cascadeStyleOf } from './helpers/css-style.js';

describe('CSS backgrounds and radii (v9j3.4)', () => {
  const s = (decl: string) => cascadeStyleOf(`<div style="${decl}"></div>`, 'div');

  it('border-radius: 1 to 4 values and the slash form', () => {
    const a = s('border-radius: 10px 20px / 5px');
    expect(a.borderTopLeftRadius).toEqual([{ px: 10, pct: 0 }, { px: 5, pct: 0 }]);
    expect(a.borderTopRightRadius).toEqual([{ px: 20, pct: 0 }, { px: 5, pct: 0 }]);
    expect(a.borderBottomRightRadius[0]).toEqual({ px: 10, pct: 0 });
    expect(s('border-top-left-radius: 50%').borderTopLeftRadius).toEqual([{ px: 0, pct: 50 }, { px: 0, pct: 50 }]);
  });
  it('a negative radius is invalid', () => {
    expect(s('border-radius: -4px').borderTopLeftRadius).toEqual([{ px: 0, pct: 0 }, { px: 0, pct: 0 }]);
  });
  it('background-image: url, linear and radial', () => {
    expect(s('background-image: url(x.png)').backgroundImage).toEqual({ kind: 'url', url: 'x.png' });
    expect(s("background-image: url('y.png')").backgroundImage).toEqual({ kind: 'url', url: 'y.png' });
    const lin = s('background-image: linear-gradient(to top right, red, blue 80%)').backgroundImage;
    expect(lin).toMatchObject({ kind: 'linear', to: [1, -1] });
    expect((lin as { stops: unknown[] }).stops).toHaveLength(2);
    expect(s('background-image: linear-gradient(0.25turn, red, blue)').backgroundImage).toMatchObject({ angle: 90 });
    expect(s('background-image: radial-gradient(circle closest-side at 10px 50%, red, blue)').backgroundImage)
      .toMatchObject({ kind: 'radial', shape: 'circle', extent: 'closest-side', at: [{ px: 10, pct: 0 }, { px: 0, pct: 50 }] });
    expect(s('background-image: radial-gradient(red, blue)').backgroundImage)
      .toMatchObject({ shape: 'ellipse', extent: 'farthest-corner', at: [{ pct: 50 }, { pct: 50 }] });
  });
  it('refuses what is out of scope: layers, repeating, conic, colour hints', () => {
    for (const v of ['url(a.png), url(b.png)', 'repeating-linear-gradient(red, blue)', 'conic-gradient(red, blue)',
      'linear-gradient(red, 30%, blue)'])
      expect(s(`background-image: ${v}`).backgroundImage).toEqual({ kind: 'none' });
  });
  it('size, repeat and position', () => {
    expect(s('background-size: cover').backgroundSize).toBe('cover');
    expect(s('background-size: 50% auto').backgroundSize).toEqual([{ px: 0, pct: 50 }, 'auto']);
    expect(s('background-repeat: repeat-x').backgroundRepeat).toEqual(['repeat', 'no-repeat']);
    expect(s('background-repeat: space').backgroundRepeat).toEqual(['repeat', 'repeat']);   // refused -> initial
    const p = s('background-position: right 10px bottom');
    expect(p.backgroundPositionX).toEqual({ px: -10, pct: 100 });
    expect(p.backgroundPositionY).toEqual({ px: 0, pct: 100 });
    expect(s('background-position: center').backgroundPositionX).toEqual({ px: 0, pct: 50 });
  });
  it('a position written vertical first is swapped, in both the pair and the edge-offset forms', () => {
    // `top right` and `bottom 10px right 20px` name y before x; read in order
    // they would put `top` on the x axis, which CSS refuses, or misplace the image.
    const a = s('background-position: top right');
    expect(a.backgroundPositionX).toEqual({ px: 0, pct: 100 });
    expect(a.backgroundPositionY).toEqual({ px: 0, pct: 0 });
    const b = s('background-position: bottom 10px right 20px');
    expect(b.backgroundPositionX).toEqual({ px: -20, pct: 100 });
    expect(b.backgroundPositionY).toEqual({ px: -10, pct: 100 });
  });
  it('the background shorthand carries colour, image, position / size and repeat', () => {
    const b = s('background: #00ff00 url(x.png) center / contain no-repeat');
    expect(b.backgroundColor.rgb).toEqual([0, 1, 0]);
    expect(b.backgroundImage).toEqual({ kind: 'url', url: 'x.png' });
    expect(b.backgroundSize).toBe('contain');
    expect(b.backgroundRepeat).toEqual(['no-repeat', 'no-repeat']);
    expect(b.backgroundPositionY).toEqual({ px: 0, pct: 50 });
  });
  it('the shorthand resets what it does not mention', () => {
    const b = cascadeStyleOf('<div style="background-size: cover; background: red"></div>', 'div');
    expect(b.backgroundSize).toEqual(['auto', 'auto']);
  });
});

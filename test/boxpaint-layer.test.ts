// test/boxpaint-layer.test.ts
import { describe, it, expect } from 'vitest';
import {
  tileSize, tileOrigin, cornerAngle, linearLine, radialRadii, placeStops, fitStops, premultiplyTransparent, type BgLayer,
} from '../src/boxpaint.js';

const L = (abs: number, frac = 0) => ({ abs, frac });
const layer = (o: Partial<BgLayer> = {}): BgLayer =>
  ({ size: ['auto', 'auto'], posX: L(0), posY: L(0), repeatX: true, repeatY: true, ...o });

describe('tileSize (CSS Backgrounds 3 §3.9)', () => {
  const nat = { w: 40, h: 20 };
  it('auto is the natural size; a gradient (no natural size) fills the area', () => {
    expect(tileSize(['auto', 'auto'], 200, 100, nat)).toEqual({ w: 40, h: 20 });
    expect(tileSize(['auto', 'auto'], 200, 100)).toEqual({ w: 200, h: 100 });
  });
  it('one auto keeps the aspect ratio', () => {
    expect(tileSize([L(80), 'auto'], 200, 100, nat)).toEqual({ w: 80, h: 40 });
    expect(tileSize(['auto', L(0, 0.5)], 200, 100, nat)).toEqual({ w: 100, h: 50 });
  });
  it('cover scales to cover the area, contain to fit it', () => {
    expect(tileSize('cover', 200, 300, nat)).toEqual({ w: 600, h: 300 });
    expect(tileSize('contain', 200, 300, nat)).toEqual({ w: 200, h: 100 });
  });
});

describe('tileOrigin', () => {
  it('a percentage places the tile p point on the area p point', () => {
    expect(tileOrigin(layer({ posX: L(0, 0.5), posY: L(0, 1) }), 200, 100, 40, 20)).toEqual({ x: 80, y: 80 });
  });
  it('the 4-value form `right 10px` is 100% less 10', () => {
    expect(tileOrigin(layer({ posX: L(-10, 1) }), 200, 100, 40, 20).x).toBe(150);
  });
});

describe('linear gradient geometry (CSS Images 3 §3.1)', () => {
  it('corner keywords take the box aspect', () => {
    expect(cornerAngle(1, -1, 100, 100)).toBeCloseTo(45, 9);                      // to top right, square
    expect(cornerAngle(1, 1, 200, 100)).toBeCloseTo(180 - Math.atan(100 / 200) * 180 / Math.PI, 9);
  });
  it('the line passes through the centre with length |w sin a| + |h cos a|', () => {
    const l = linearLine(180, 200, 100);                                          // to bottom
    expect(l).toEqual({ x1: 100, y1: 0, x2: 100, y2: 100 });
    const d = linearLine(45, 200, 100);
    const len = Math.hypot(d.x2 - d.x1, d.y2 - d.y1);
    expect(len).toBeCloseTo(200 * Math.sin(Math.PI / 4) + 100 * Math.cos(Math.PI / 4), 9);
  });
});

describe('radial extents (CSS Images 3 §3.2)', () => {
  it('circle closest-side / farthest-corner', () => {
    expect(radialRadii('circle', 'closest-side', 30, 20, 200, 100)).toEqual({ rx: 20, ry: 20 });
    const fc = radialRadii('circle', 'farthest-corner', 30, 20, 200, 100);
    expect(fc.rx).toBeCloseTo(Math.hypot(170, 80), 9);
  });
  it('ellipse farthest-corner keeps the farthest-side aspect and passes through the corner', () => {
    const e = radialRadii('ellipse', 'farthest-corner', 100, 50, 200, 100);
    expect(e.ry / e.rx).toBeCloseTo(50 / 100, 9);
    expect((100 / e.rx) ** 2 + (50 / e.ry) ** 2).toBeCloseTo(1, 9);
  });
  it('an explicit ellipse size resolves against the box', () => {
    expect(radialRadii('ellipse', { rx: L(0, 0.5), ry: L(10) }, 0, 0, 200, 100)).toEqual({ rx: 100, ry: 10 });
  });
});

describe('stops', () => {
  const red: [number, number, number] = [1, 0, 0], blue: [number, number, number] = [0, 0, 1];
  it('first defaults to 0, last to 1, the rest spread evenly; a stop behind an earlier one is clamped up', () => {
    const s = placeStops([{ color: red, alpha: 1 }, { color: red, alpha: 1 }, { color: blue, alpha: 1, pos: L(0, 0.9) },
      { color: blue, alpha: 1, pos: L(0, 0.2) }, { color: red, alpha: 1 }], 100);
    expect(s.map((x) => x.t)).toEqual([0, 0.45, 0.9, 0.9, 1]);
  });
  it('fitStops renormalizes stops outside 0..1 and returns the line extent', () => {
    const f = fitStops([{ t: -0.2, color: red, alpha: 1 }, { t: 1.2, color: blue, alpha: 0 }]);
    expect(f.t0).toBeCloseTo(-0.2, 9); expect(f.t1).toBeCloseTo(1.2, 9);
    expect(f.stops.map((x) => x.offset)).toEqual([0, 1]);
    expect(f.stops[1].opacity).toBe(0);
  });
});

describe('premultiplied stops (CSS Images 4 §3.4.3)', () => {
  const red: [number, number, number] = [0.8, 0, 0], blue: [number, number, number] = [0, 0, 1];
  it('a fully transparent end stop takes its neighbour colour, so the ramp fades rather than darkens', () => {
    const s = premultiplyTransparent([{ t: 0, color: red, alpha: 1 }, { t: 1, color: [0, 0, 0], alpha: 0 }]);
    expect(s).toEqual([{ t: 0, color: red, alpha: 1 }, { t: 1, color: red, alpha: 0 }]);
  });
  it('a transparent stop between two colours splits into two coincident stops', () => {
    const s = premultiplyTransparent([{ t: 0, color: red, alpha: 1 }, { t: 0.5, color: [0, 0, 0], alpha: 0 }, { t: 1, color: blue, alpha: 1 }]);
    expect(s).toEqual([{ t: 0, color: red, alpha: 1 }, { t: 0.5, color: red, alpha: 0 }, { t: 0.5, color: blue, alpha: 0 }, { t: 1, color: blue, alpha: 1 }]);
  });
  it('leaves opaque and partially transparent stops alone', () => {
    const s = [{ t: 0, color: red, alpha: 1 }, { t: 1, color: blue, alpha: 0.5 }];
    expect(premultiplyTransparent(s)).toEqual(s);
  });
});

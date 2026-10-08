// test/boxdraw.test.ts
import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { paintBox, type BoxPaintSpec } from '../src/boxdraw.js';
import { resolveRadii, ZERO_RADII } from '../src/boxpaint.js';
import { buildImageXObject } from '../src/imageembed.js';
import { solidPng } from './helpers/solid-png.js';
import { decodePng } from './helpers/decode-png.js';

const L = (abs: number, frac = 0) => ({ abs, frac });
const r8 = resolveRadii(Array.from({ length: 4 }, () => ({ x: L(20), y: L(20) })), 100, 100);
const render = (spec: Partial<BoxPaintSpec>, artifact = false) => {
  const d = Document.New(); const { page: p } = d.AddPage();
  paintBox(d, p, { x: 100, y: 500, w: 100, h: 100, radii: ZERO_RADII, edges: {}, ...spec }, artifact);
  const png = decodePng(Document.Open(d.Save()).Pages[0].ToImage({ scale: 1 }));
  return { d, at: (x: number, y: number) => png.at(x, png.height - y) };
};
const RED: [number, number, number] = [1, 0, 0];

describe('paintBox (v9j3.4)', () => {
  it('a rounded box leaves its corner unpainted and its middle filled', () => {
    const { at } = render({ radii: r8, color: RED });
    expect(at(150, 550)).toEqual([255, 0, 0, 255]);
    expect(at(101, 599)).toEqual([255, 255, 255, 255]);              // inside the bbox, outside the curve
  });
  it('a uniform rounded border is one even-odd ring: the curve is inked, the middle is not', () => {
    const { at } = render({ radii: r8, edges: { top: { width: 4, color: RED }, right: { width: 4, color: RED },
      bottom: { width: 4, color: RED }, left: { width: 4, color: RED } } });
    expect(at(150, 598)).toEqual([255, 0, 0, 255]);
    expect(at(150, 550)).toEqual([255, 255, 255, 255]);
  });
  it('differing edge colours meet on the diagonal', () => {
    const { at } = render({ radii: r8, edges: { top: { width: 10, color: RED }, left: { width: 10, color: [0, 0, 1] },
      right: { width: 10, color: RED }, bottom: { width: 10, color: RED } } });
    expect(at(150, 596)[0]).toBe(255);                              // top: red
    expect(at(103, 550)[2]).toBe(255);                              // left: blue
  });
  it('a no-repeat image draws once at its tile; repeat fills the clip', () => {
    const built = buildImageXObject(solidPng(2, 2, [0, 255, 0]));
    const one = render({ layer: { source: { kind: 'image', built, width: 20, height: 20 },
      layer: { size: ['auto', 'auto'], posX: L(0), posY: L(0), repeatX: false, repeatY: false },
      area: { x: 100, top: 600, w: 100, h: 100 } } });
    expect(one.at(110, 590)).toEqual([0, 255, 0, 255]);
    expect(one.at(150, 550)).toEqual([255, 255, 255, 255]);
    const tiled = render({ layer: { source: { kind: 'image', built, width: 20, height: 20 },
      layer: { size: ['auto', 'auto'], posX: L(0), posY: L(0), repeatX: true, repeatY: true },
      area: { x: 100, top: 600, w: 100, h: 100 } } });
    expect(tiled.at(150, 550)).toEqual([0, 255, 0, 255]);
  });
  it('a linear gradient to the right runs red to blue across the box', () => {
    const { at } = render({ layer: { source: { kind: 'gradient', g: { kind: 'linear', angle: 90,
      stops: [{ color: RED, alpha: 1 }, { color: [0, 0, 1], alpha: 1 }] } },
      layer: { size: ['auto', 'auto'], posX: L(0), posY: L(0), repeatX: true, repeatY: true },
      area: { x: 100, top: 600, w: 100, h: 100 } } });
    expect(at(102, 550)[0]).toBeGreaterThan(240);
    expect(at(198, 550)[2]).toBeGreaterThan(240);
  });
  it('an ellipse radial gradient is wider than tall', () => {
    const { at } = render({ w: 200, layer: { source: { kind: 'gradient', g: { kind: 'radial', shape: 'ellipse',
      extent: 'closest-side', at: [L(0, 0.5), L(0, 0.5)],
      stops: [{ color: RED, alpha: 1 }, { color: [1, 1, 1], alpha: 1 }] } },
      layer: { size: ['auto', 'auto'], posX: L(0), posY: L(0), repeatX: true, repeatY: true },
      area: { x: 100, top: 600, w: 200, h: 100 } } });
    // 40pt right of centre is redder than 40pt above it: the ellipse is 2:1.
    expect(at(240, 550)[1]).toBeLessThan(at(200, 590)[1]);
  });
  it('wraps everything in an /Artifact when asked', () => {
    const { d } = render({ color: RED, radii: r8 }, true);
    expect(new TextDecoder().decode(d.Pages[0].Contents)).toMatch(/\/Artifact BMC/);
  });
  it('stops outside 0..100% extend the line rather than clamping colours', () => {
    const L2 = (abs: number, frac = 0) => ({ abs, frac });
    const { at } = render({ layer: { source: { kind: 'gradient', g: { kind: 'linear', angle: 90,
      stops: [{ color: RED, alpha: 1, pos: L2(0, -0.2) }, { color: [0, 0, 1], alpha: 1, pos: L2(0, 1.2) }] } },
      layer: { size: ['auto', 'auto'], posX: L2(0), posY: L2(0), repeatX: true, repeatY: true },
      area: { x: 100, top: 600, w: 100, h: 100 } } });
    // At the box's left edge the ramp is already 20/140 of the way to blue.
    const [r, , b] = at(101, 550);
    expect(r).toBeLessThan(250); expect(b).toBeGreaterThan(10);
  });
  it('a transparent stop fades to the page (soft mask)', () => {
    const { at } = render({ layer: { source: { kind: 'gradient', g: { kind: 'linear', angle: 90,
      stops: [{ color: RED, alpha: 1 }, { color: RED, alpha: 0 }] } },
      layer: { size: ['auto', 'auto'], posX: L(0), posY: L(0), repeatX: true, repeatY: true },
      area: { x: 100, top: 600, w: 100, h: 100 } } });
    const [, g, b] = at(198, 550);
    expect(g).toBeGreaterThan(240); expect(b).toBeGreaterThan(240);
  });
});

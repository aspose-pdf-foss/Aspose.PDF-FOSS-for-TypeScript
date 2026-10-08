// test/floatbox-decor.test.ts
import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { decodePng } from './helpers/decode-png.js';
import { solidPng } from './helpers/solid-png.js';

const place = (opts: object) => {
  const d = Document.New(); const { page } = d.AddPage();
  const box = d.NewFloatingBox({ width: 200, padding: 10, ...opts });
  box.AddParagraph(' ');
  box.paintAt(page, 100, 700);
  return { d, png: decodePng(Document.Open(d.Save()).Pages[0].ToImage({ scale: 1 })) };
};
const at = (png: ReturnType<typeof decodePng>, x: number, y: number) => png.at(x, png.height - y);

describe('FloatingBox decoration (v9j3.4)', () => {
  it('radius rounds the background', () => {
    const { png } = place({ background: [1, 0, 0], radius: 15 });
    expect(at(png, 200, 690)).toEqual([255, 0, 0, 255]);
    expect(at(png, 101, 699)).toEqual([255, 255, 255, 255]);
  });
  it('per-corner and [rx, ry] corners', () => {
    const { png } = place({ background: [1, 0, 0], radius: { topLeft: 0, topRight: [30, 10] } });
    expect(at(png, 101, 699)).toEqual([255, 0, 0, 255]);              // square top-left
    expect(at(png, 299, 699)).toEqual([255, 255, 255, 255]);          // [30, 10] top-right is cut
  });
  it('a box-relative linear gradient, 180deg runs top to bottom', () => {
    const { png } = place({ background: { kind: 'linear', angle: 180,
      stops: [{ offset: 0, color: [1, 0, 0], opacity: 1 }, { offset: 1, color: [0, 0, 1], opacity: 1 }] } });
    const top = at(png, 200, 698), bottom = at(png, 200, 682);
    expect(top[0]).toBeGreaterThan(bottom[0]);
  });
  it('backgroundImage stretches by default', () => {
    const { png } = place({ backgroundImage: { data: solidPng(2, 2, [0, 200, 0]) } });
    const [r, g] = at(png, 290, 682);
    expect(r).toBeLessThan(100); expect(g).toBeGreaterThan(150);        // green, not the white page
  });
  it('validates before drawing', () => {
    const d = Document.New();
    expect(() => d.NewFloatingBox({ width: 100, radius: -1 })).toThrow(RangeError);
    expect(() => d.NewFloatingBox({ width: 100, radius: Number.NaN })).toThrow(TypeError);
    expect(() => d.NewFloatingBox({ width: 100, backgroundImage: { data: solidPng(1, 1, [0, 0, 0]), fit: 'x' as never } })).toThrow(RangeError);
    expect(() => d.NewFloatingBox({ width: 100, backgroundImage: { data: new Uint8Array([1, 2, 3]) } })).toThrow();
  });
  it('TypeError for the wrong kind of value, RangeError for one outside its set (v9j3.7)', () => {
    const d = Document.New();
    const stop = (o: object) => ({ kind: 'linear' as const, stops: [{ offset: 0, color: [0, 0, 0] as [number, number, number] }, { offset: 1, color: [1, 1, 1] as [number, number, number], ...o }] });
    const box = (o: object) => () => d.NewFloatingBox({ width: 100, ...o } as never);
    // offset and opacity
    expect(box({ background: stop({ offset: 1.5 }) })).toThrow(RangeError);
    expect(box({ background: stop({ offset: -0.1 }) })).toThrow(RangeError);
    expect(box({ background: stop({ opacity: -0.1 }) })).toThrow(RangeError);
    expect(box({ background: stop({ opacity: 2 }) })).toThrow(RangeError);
    expect(box({ background: stop({ offset: Number.NaN }) })).toThrow(TypeError);
    expect(box({ background: stop({ offset: '0.5' }) })).toThrow(TypeError);
    expect(box({ background: stop({ opacity: Number.POSITIVE_INFINITY }) })).toThrow(TypeError);
    // keywords
    const g = { stops: stop({}).stops };
    expect(box({ background: { ...g, kind: 'conic' } })).toThrow(RangeError);
    expect(box({ background: { ...g, kind: 7 } })).toThrow(TypeError);
    expect(box({ background: { ...g, kind: 'radial', shape: 'square' } })).toThrow(RangeError);
    expect(box({ background: { ...g, kind: 'radial', shape: 1 } })).toThrow(TypeError);
    expect(box({ background: { ...g, kind: 'radial', size: 'huge' } })).toThrow(RangeError);
    expect(box({ background: { ...g, kind: 'radial', size: 5 } })).toThrow(TypeError);
    expect(box({ backgroundImage: { data: solidPng(1, 1, [0, 0, 0]), fit: 'x' } })).toThrow(RangeError);
    expect(box({ backgroundImage: { data: solidPng(1, 1, [0, 0, 0]), fit: 3 } })).toThrow(TypeError);
    // a name inherited from Object.prototype is not a fit
    expect(box({ backgroundImage: { data: solidPng(1, 1, [0, 0, 0]), fit: 'constructor' } })).toThrow(RangeError);
  });
  it('a box with none of these options paints byte-identically to before', () => {
    const d1 = Document.New(); const { page: p1 } = d1.AddPage(); const b1 = d1.NewFloatingBox({ width: 100, background: [1, 0, 0], border: { width: 1, color: [0, 0, 0] } });
    b1.AddParagraph('x'); b1.paintAt(p1, 100, 700);
    expect(new TextDecoder().decode(d1.Pages[0].Contents)).toMatch(/1 0 0 rg\n[\d. ]+ re\nf/);
  });
});

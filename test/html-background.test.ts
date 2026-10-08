// test/html-background.test.ts
import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { decodePng } from './helpers/decode-png.js';
import { solidPng } from './helpers/solid-png.js';

const PNG = solidPng(4, 4, [0, 200, 0]);
const uri = `data:image/png;base64,${Buffer.from(PNG).toString('base64')}`;
// At scale 1 a PDF point is a pixel: 72pt flow margin + 6pt body margin puts a
// 200x100px (150x75pt) div at x 78..228, y 72..147 (the root drops body's top margin).
const green = (p: [number, number, number, number]) => p[0] < 100 && p[1] > 150;
const shot = (html: string, o: object = {}) => {
  const d = Document.New(); const r = d.AddHtml(html, o);
  return { r, png: decodePng(d.Pages[d.Pages.length - 1].ToImage({ scale: 1 })) };
};

describe('HTML backgrounds (v9j3.4)', () => {
  it('a data: URI background tiles over the box', () => {
    const { png } = shot(`<div style="width:200px;height:100px;background:url(${uri})"></div>`);
    expect(green(png.at(120, 100))).toBe(true);
  });
  it('resolveImage supplies a relative src', () => {
    const { png } = shot('<div style="width:200px;height:100px;background-image:url(tile.png)"></div>',
      { resolveImage: (src: string) => (src === 'tile.png' ? PNG : undefined) });
    expect(green(png.at(120, 100))).toBe(true);
  });
  it('an unresolvable image is reported once and the colour still paints', () => {
    const { r, png } = shot('<div style="width:200px;height:100px;background:#ff0000 url(missing.png)"></div>');
    expect(png.at(120, 100)).toEqual([255, 0, 0, 255]);
    const recs = r.skipped.filter((s) => s.construct === 'image' && s.detail === 'background-image: missing.png');
    expect(recs).toHaveLength(1);
    expect(recs[0].kind).toBe('dropped');
  });
  it('border-radius in px is converted to points', () => {
    const { png } = shot('<div style="width:200px;height:100px;background:#ff0000;border-radius:40px"></div>');
    // 40px = 30pt. The box's left edge is x 78. 3pt into the corner diagonally
    // is outside the curve; 30pt along the top edge the curve has reached it.
    // A radius left in px (40) would still be curving there.
    const top = [...Array(png.height).keys()].find((y) => png.at(150, y)[1] < 80)!;
    expect(top).toBe(72);
    expect(png.at(81, top + 3)[1]).toBeGreaterThan(200);
    expect(png.at(78 + 31, top + 1)[1]).toBeLessThan(80);
  });
});

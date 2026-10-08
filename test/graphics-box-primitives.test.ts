// test/graphics-box-primitives.test.ts
import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { PageGraphics } from '../src/graphics.js';
import { buildImageXObject } from '../src/imageembed.js';
import { solidPng } from './helpers/solid-png.js';
import { decodePng } from './helpers/decode-png.js';

const page = () => { const d = Document.New(); const { page: p } = d.AddPage(); return { d, p }; };
const content = (d: Document) => new TextDecoder().decode(d.Pages[0].Contents);

describe('VectorGraphics internal primitives (v9j3.4)', () => {
  it('clipPath writes W n, and W* n for even-odd', () => {
    const { d, p } = page();
    new PageGraphics(d, p).rect(0, 0, 10, 10).clipPath().rect(0, 0, 5, 5).clipPath(true).apply();
    expect(content(d)).toMatch(/re\nW n\n[\s\S]*re\nW\* n/);
  });
  it('placeImage registers the image once per call and draws it into the rect', () => {
    const { d, p } = page();
    const built = buildImageXObject(solidPng(2, 2, [255, 0, 0]));
    new PageGraphics(d, p).placeImage(built, 10, 20, 30, 40).apply();
    expect(content(d)).toMatch(/30 0 0 40 10 20 cm\n\/Im\d* Do/);
    const png = decodePng(Document.Open(d.Save()).Pages[0].ToImage({ scale: 1 }));
    const h = png.height;
    expect(png.at(25, h - 40)).toEqual([255, 0, 0, 255]);
  });
  it('setFillGradientMatrix puts the matrix on the pattern, and on the alpha twin', () => {
    const { d, p } = page();
    new PageGraphics(d, p).setFillGradientMatrix({ kind: 'radial', cx: 0, cy: 0, r: 10,
      stops: [{ offset: 0, color: [1, 0, 0], opacity: 1 }, { offset: 1, color: [0, 0, 1], opacity: 0 }] },
      [2, 0, 0, 1, 50, 50]).rect(0, 0, 100, 100).fill().apply();
    const saved = new TextDecoder('latin1').decode(d.Save());
    expect((saved.match(/\/Matrix \[2 0 0 1 50 50\]/g) ?? []).length).toBeGreaterThanOrEqual(2);
  });
});

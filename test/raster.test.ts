import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { buildSvgPdf } from './helpers/build-svg-fixtures.js';
import { decodePng } from './helpers/decode-png.js';

const near = (v: number, target: number, tol = 6) => Math.abs(v - target) <= tol;

describe('Page.ToImage — solid fill', () => {
  // A red rectangle at user (20,20)-(80,80) on a 200x200 page.
  const doc = () => Document.Open(buildSvgPdf({
    mediaBox: [0, 0, 200, 200], content: '1 0 0 rg 20 20 60 60 re f',
  }));

  it('returns a valid opaque RGB PNG sized to the page', () => {
    const png = decodePng(doc().Pages[0].ToImage());
    expect(png.width).toBe(200);
    expect(png.height).toBe(200);
    expect(png.colorType).toBe(2);       // RGB
  });

  it('paints the interior the fill color and leaves the exterior white', () => {
    const png = decodePng(doc().Pages[0].ToImage());
    // user (50,50) → device (50, 150): inside the rect
    const [r, g, b] = png.at(50, 150);
    expect(near(r, 255)).toBe(true);
    expect(near(g, 0)).toBe(true);
    expect(near(b, 0)).toBe(true);
    // user (5,5) → device (5,195): outside → white background
    expect(png.at(5, 195)).toEqual([255, 255, 255, 255]);
  });
});

describe('Page.ToImage — anti-aliasing', () => {
  it('produces partial edge coverage on a sloped edge', () => {
    // Red triangle with two sloped edges (apex + base), guaranteeing AA edges.
    const doc = Document.Open(buildSvgPdf({
      mediaBox: [0, 0, 200, 200], content: '1 0 0 rg 100 20 m 180 180 l 20 180 l h f',
    }));
    const png = decodePng(doc.Pages[0].ToImage());
    // Red over white: the green channel is 255 outside, 0 inside, partial on edges.
    let partial = false;
    for (let i = 0; i < png.width * png.height && !partial; i++) {
      const g = png.data[i * 3 + 1];
      if (g > 10 && g < 245) partial = true;
    }
    expect(partial).toBe(true);
  });
});

describe('Page.ToImage — even-odd fill', () => {
  it('leaves a hole where two subpaths overlap under the even-odd rule', () => {
    // Outer 20..180 rect with an inner 60..140 rect, filled even-odd → ring.
    const doc = Document.Open(buildSvgPdf({
      mediaBox: [0, 0, 200, 200],
      content: '1 0 0 rg 20 20 160 160 re 60 60 80 80 re f*',
    }));
    const png = decodePng(doc.Pages[0].ToImage());
    // ring: user (30,30) → device (30,170), inside outer & outside inner
    const [r, g, b] = png.at(30, 170);
    expect(near(r, 255)).toBe(true);
    expect(near(g, 0)).toBe(true);
    expect(near(b, 0)).toBe(true);
    // hole: page center → device (100,100), inside inner rect → background
    expect(png.at(100, 100)).toEqual([255, 255, 255, 255]);
  });
});

describe('Page.ToImage — options', () => {
  const src = (content = '1 0 0 rg 20 20 60 60 re f') =>
    Document.Open(buildSvgPdf({ mediaBox: [0, 0, 200, 200], content }));

  it('honors scale (2 → 144 DPI, doubled dimensions)', () => {
    const png = decodePng(src().Pages[0].ToImage({ scale: 2 }));
    expect(png.width).toBe(400);
    expect(png.height).toBe(400);
    // user (50,50) → device (100,300) at scale 2 → still red
    const [r, g] = png.at(100, 300);
    expect(near(r, 255)).toBe(true);
    expect(near(g, 0)).toBe(true);
  });

  it('derives height from width aspect-preserving', () => {
    const png = decodePng(src().Pages[0].ToImage({ width: 100 }));
    expect(png.width).toBe(100);
    expect(png.height).toBe(100);
  });

  it('fits both width and height when both are given', () => {
    const png = decodePng(src().Pages[0].ToImage({ width: 100, height: 50 }));
    expect(png.width).toBe(100);
    expect(png.height).toBe(50);
  });

  it('emits an RGBA PNG with transparent unpainted area', () => {
    const png = decodePng(src().Pages[0].ToImage({ background: 'transparent' }));
    expect(png.colorType).toBe(6);       // RGBA
    // painted interior: opaque red
    expect(png.at(50, 150)).toEqual([255, 0, 0, 255]);
    // unpainted exterior: fully transparent
    expect(png.at(5, 195)[3]).toBe(0);
  });

  it('selects the MediaBox with box: media', () => {
    const doc = Document.Open(buildSvgPdf({
      mediaBox: [0, 0, 300, 400], cropBox: [50, 60, 250, 360], content: '',
    }));
    const png = decodePng(doc.Pages[0].ToImage({ box: 'media' }));
    expect(png.width).toBe(300);
    expect(png.height).toBe(400);
  });
});

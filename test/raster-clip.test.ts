import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { buildSvgPdf } from './helpers/build-svg-fixtures.js';
import { decodePng } from './helpers/decode-png.js';

const near = (v: number, target: number, tol = 12) => Math.abs(v - target) <= tol;
const isRed = (px: [number, number, number, number]) =>
  near(px[0], 255) && near(px[1], 0) && near(px[2], 0);
const isWhite = (px: [number, number, number, number]) =>
  near(px[0], 255) && near(px[1], 255) && near(px[2], 255);
const render = (content: string, w = 200, h = 200) =>
  decodePng(Document.Open(buildSvgPdf({ mediaBox: [0, 0, w, h], content })).Pages[0].ToImage());

describe('Page.ToImage — clipping', () => {
  it('clips a fill to the clip rectangle', () => {
    // Clip to user (60,60)-(140,140), then fill the whole page red.
    const png = render('60 60 80 80 re W n 1 0 0 rg 0 0 200 200 re f');
    // user (100,100) → device (100,100): inside clip → red
    expect(isRed(png.at(100, 100))).toBe(true);
    // user (30,30) → device (30,170): outside clip → background
    expect(isWhite(png.at(30, 170))).toBe(true);
    // user (100,30) → device (100,170): outside clip (below) → background
    expect(isWhite(png.at(100, 170))).toBe(true);
  });

  it('composes nested clips to their intersection', () => {
    // Outer clip (40,40)-(160,160); inner clip (100,40)-(160,160) inside a q/Q.
    // Fill red inside inner clip, then after Q fill blue over the left half of outer.
    const png = render(
      '40 40 120 120 re W n ' +
      'q 100 40 60 120 re W n 1 0 0 rg 0 0 200 200 re f Q ' +
      '0 0 1 rg 0 0 90 200 re f',
    );
    // user (130,100) → device (130,100): inside both clips → red
    expect(isRed(png.at(130, 100))).toBe(true);
    // user (70,100) → device (70,100): inside outer, OUTSIDE inner → not red.
    // After Q the inner clip is gone; blue fill covers x<90 → this pixel is blue.
    const px = png.at(70, 100);
    expect(near(px[2], 255) && near(px[0], 0)).toBe(true);   // blue
    // user (20,100) → device (20,100): outside the outer clip → background (blue fill clipped out)
    expect(isWhite(png.at(20, 100))).toBe(true);
  });

  it('honors an even-odd clip path (ring)', () => {
    // Even-odd clip: outer 20..180 rect minus inner 60..140 rect → ring; fill red.
    const png = render('20 20 160 160 re 60 60 80 80 re W* n 1 0 0 rg 0 0 200 200 re f');
    // user (30,30) → device (30,170): inside the ring → red
    expect(isRed(png.at(30, 170))).toBe(true);
    // page center → device (100,100): inside the even-odd hole → background
    expect(isWhite(png.at(100, 100))).toBe(true);
    // user (10,10) → device (10,190): outside the outer rect → background
    expect(isWhite(png.at(10, 190))).toBe(true);
  });

  it('clips a stroke to the active clip region', () => {
    // Clip to vertical strip x 80..120; stroke a full-width horizontal line.
    const png = render('80 0 40 200 re W n 1 0 0 RG 10 w 0 100 m 200 100 l S');
    // user (100,100) → device (100,100): on the line, inside the strip → red
    expect(isRed(png.at(100, 100))).toBe(true);
    // user (50,100) → device (50,100): on the line but outside the strip → background
    expect(isWhite(png.at(50, 100))).toBe(true);
  });
});

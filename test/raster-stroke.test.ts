import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { buildSvgPdf } from './helpers/build-svg-fixtures.js';
import { decodePng } from './helpers/decode-png.js';

const near = (v: number, target: number, tol = 12) => Math.abs(v - target) <= tol;
const isRed = (px: [number, number, number, number]) =>
  near(px[0], 255) && near(px[1], 0) && near(px[2], 0);
const isWhite = (px: [number, number, number, number]) =>
  near(px[0], 255) && near(px[1], 255) && near(px[2], 255);

describe('Page.ToImage — basic stroke', () => {
  // A red-stroked rectangle (width 10) at user (50,50)-(150,150) on a 200x200 page.
  const doc = () => Document.Open(buildSvgPdf({
    mediaBox: [0, 0, 200, 200], content: '1 0 0 RG 10 w 50 50 100 100 re S',
  }));

  it('paints the stroked border the stroke color', () => {
    const png = decodePng(doc().Pages[0].ToImage());
    // user (50,100) is on the left edge → device (50,100)
    expect(isRed(png.at(50, 100))).toBe(true);
    // user (100,50) is on the bottom edge → device (100,150)
    expect(isRed(png.at(100, 150))).toBe(true);
  });

  it('leaves the unstroked interior as background', () => {
    const png = decodePng(doc().Pages[0].ToImage());
    // page center user (100,100) → device (100,100): inside the box, far from edges
    expect(isWhite(png.at(100, 100))).toBe(true);
  });
});

const render = (content: string, w = 200, h = 200) =>
  decodePng(Document.Open(buildSvgPdf({ mediaBox: [0, 0, w, h], content })).Pages[0].ToImage());

describe('Page.ToImage — line caps', () => {
  // Blue horizontal line user (50,100)→(150,100), width 20 (hw 10).
  // user (155,100) → device (155,100) is 5 units past the right endpoint.
  const beyond = (cap: number) => render(`0 0 1 RG 20 w ${cap} J 50 100 m 150 100 l S`).at(155, 100);
  const isBlue = (px: [number, number, number, number]) => near(px[0], 0) && near(px[1], 0) && near(px[2], 255);

  it('butt cap does not paint past the endpoint', () => {
    expect(isWhite(beyond(0))).toBe(true);
  });
  it('square cap extends half a width past the endpoint', () => {
    expect(isBlue(beyond(2))).toBe(true);
  });
  it('round cap paints within the radius but not the square corner', () => {
    // (155,100) is 5 units from the endpoint → inside the round cap.
    expect(isBlue(render('0 0 1 RG 20 w 1 J 50 100 m 150 100 l S').at(155, 100))).toBe(true);
    // (158,108) is ~11.3 units away → outside the round cap (a square cap would paint it).
    expect(isWhite(render('0 0 1 RG 20 w 1 J 50 100 m 150 100 l S').at(158, 108))).toBe(true);
  });
});

describe('Page.ToImage — line joins', () => {
  // L-shape: up (40,40)→(40,100) then right →(100,100), width 10 (hw 5).
  // Outer miter apex is user (35,105) → device (35,95); test near it.
  const corner = (join: number) => render(`1 0 0 RG 10 w ${join} j 40 40 m 40 100 l 100 100 l S`).at(36, 96);

  it('miter join fills the outer corner tip', () => {
    expect(isRed(corner(0))).toBe(true);
  });
  it('bevel join cuts the outer corner tip', () => {
    expect(isWhite(corner(2))).toBe(true);
  });
});

describe('Page.ToImage — dashes', () => {
  it('splits the line into painted dashes and background gaps', () => {
    // Dashed horizontal line, pattern [10 10] from x=20: on 20–30, off 30–40, on 40–50…
    const png = render('1 0 0 RG 10 w [10 10] 0 d 20 100 m 180 100 l S');
    expect(isRed(png.at(25, 100))).toBe(true);   // inside first dash
    expect(isWhite(png.at(35, 100))).toBe(true); // inside first gap
    expect(isRed(png.at(45, 100))).toBe(true);   // inside second dash
  });
});

describe('Page.ToImage — CTM correctness', () => {
  it('scales stroke width anisotropically with the CTM', () => {
    // CTM scales x by 3; a vertical line at user x=20 → device x=60. Its width runs
    // along x, so device half-width is 3×2 = 6 (device x 54–66), not 2.
    const png = render('3 0 0 1 0 0 cm 1 0 0 RG 4 w 20 50 m 20 150 l S');
    expect(isRed(png.at(60, 100))).toBe(true);   // line center
    expect(isRed(png.at(64, 100))).toBe(true);   // 4px out: only painted if width scaled by CTM
    expect(isWhite(png.at(70, 100))).toBe(true); // 10px out: beyond the scaled width
  });

  it('renders a zero-width hairline about one device pixel wide', () => {
    const png = render('1 0 0 RG 0 w 50 100 m 150 100 l S');
    // Some pixel on the line is painted (not left white).
    let painted = false;
    for (let x = 60; x < 140 && !painted; x++) if (!isWhite(png.at(x, 100))) painted = true;
    expect(painted).toBe(true);
  });
});

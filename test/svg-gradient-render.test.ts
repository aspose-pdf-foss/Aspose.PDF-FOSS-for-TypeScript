import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { buildSvgPdf } from './helpers/build-svg-fixtures.js';
import { decodePng } from './helpers/decode-png.js';

const svg = (s: string) => new TextEncoder().encode(s);
const near = (v: number, target: number, tol = 14) => Math.abs(v - target) <= tol;

/** Place `src` over the whole of a 200x200 page whose existing content is
 *  `content`, save, reopen, rasterize at 1 px per point — so a device pixel
 *  (x, y) is user (x, 200 - y).
 *
 *  This is the cross-implementation check: raster.ts is an independently written
 *  READER of shadings and of luminosity soft masks, so these assertions are not
 *  a round trip through one body of code. */
function render(src: string, content = '') {
  const p = Document.Open(buildSvgPdf({ mediaBox: [0, 0, 200, 200], content })).Pages[0];
  const r = p.AddSVGObject(svg(src), [0, 0, 200, 200], { fit: 'fill' });
  const rt = Document.Open(p.Document.Save());
  return { png: decodePng(rt.Pages[0].ToImage()), skipped: r.skipped };
}

/** An opaque blue page, so a transparent pixel is distinguishable from a white
 *  one and from the gradient's own red. */
const BLUE_PAGE = '0 0 1 rg 0 0 200 200 re f';

describe('AddSVGObject — gradients through Save/Open/ToImage', () => {
  it('ramps a linear objectBoundingBox gradient red → blue across the shape', () => {
    const { png, skipped } = render(
      '<svg viewBox="0 0 100 100"><defs><linearGradient id="g">' +
      '<stop offset="0" stop-color="#f00"/><stop offset="1" stop-color="#00f"/>' +
      '</linearGradient></defs>' +
      '<rect width="100" height="100" fill="url(#g)"/></svg>');
    expect(skipped).toEqual([]);
    const [lr, , lb] = png.at(4, 100);
    expect(lr).toBeGreaterThan(215);
    expect(lb).toBeLessThan(45);
    const [rr, , rb] = png.at(196, 100);
    expect(rr).toBeLessThan(45);
    expect(rb).toBeGreaterThan(215);
    const [cr, cg, cb] = png.at(100, 100);          // the N=1 midpoint
    expect(near(cr, 128)).toBe(true);
    expect(near(cg, 0)).toBe(true);
    expect(near(cb, 128)).toBe(true);
  });

  it('runs a vertical gradient the right way up (the y flip is not applied twice)', () => {
    // y1=0 is the TOP of the SVG, which is the TOP of the page in device pixels.
    const { png } = render(
      '<svg viewBox="0 0 100 100"><defs>' +
      '<linearGradient id="g" x1="0" y1="0" x2="0" y2="1">' +
      '<stop offset="0" stop-color="#f00"/><stop offset="1" stop-color="#00f"/>' +
      '</linearGradient></defs>' +
      '<rect width="100" height="100" fill="url(#g)"/></svg>');
    expect(png.at(100, 4)[0]).toBeGreaterThan(215);     // top is red
    expect(png.at(100, 196)[2]).toBeGreaterThan(215);   // bottom is blue
  });

  it('centres a radial gradient on the shape and reaches the rim colour', () => {
    const { png, skipped } = render(
      '<svg viewBox="0 0 100 100"><defs><radialGradient id="g">' +
      '<stop offset="0" stop-color="#f00"/><stop offset="1" stop-color="#00f"/>' +
      '</radialGradient></defs>' +
      '<circle cx="50" cy="50" r="50" fill="url(#g)"/></svg>');
    expect(skipped).toEqual([]);
    const [cr, cg, cb] = png.at(100, 100);
    expect(cr).toBeGreaterThan(215);
    expect(cg).toBeLessThan(45);
    expect(cb).toBeLessThan(45);
    const [mr, , mb] = png.at(150, 100);              // half way to the rim
    expect(near(mr, 128)).toBe(true);
    expect(near(mb, 128)).toBe(true);
  });

  it('positions an objectBoundingBox gradient on the SHAPE, not the viewport', () => {
    // The rect occupies the right half only; the ramp must complete inside it.
    const { png } = render(
      '<svg viewBox="0 0 100 100"><defs><linearGradient id="g">' +
      '<stop offset="0" stop-color="#f00"/><stop offset="1" stop-color="#00f"/>' +
      '</linearGradient></defs>' +
      '<rect x="50" y="0" width="50" height="100" fill="url(#g)"/></svg>');
    expect(png.at(198, 100)[2]).toBeGreaterThan(215);   // right edge: blue
    expect(png.at(104, 100)[0]).toBeGreaterThan(215);   // left edge of the rect: red
    expect(png.at(10, 100)).toEqual([255, 255, 255, 255]);   // outside: untouched
  });

  it('strokes with a gradient', () => {
    const { png, skipped } = render(
      '<svg viewBox="0 0 100 100"><defs><linearGradient id="g">' +
      '<stop offset="0" stop-color="#f00"/><stop offset="1" stop-color="#00f"/>' +
      '</linearGradient></defs>' +
      '<rect x="10" y="10" width="80" height="80" fill="none" ' +
      'stroke="url(#g)" stroke-width="20"/></svg>');
    expect(skipped).toEqual([]);
    expect(png.at(24, 100)[0]).toBeGreaterThan(180);    // left band: mostly red
    expect(png.at(176, 100)[2]).toBeGreaterThan(180);   // right band: mostly blue
  });

  it('repeats a linear gradient across the shape', () => {
    // userSpaceOnUse axis 0..25 over a 100-wide viewBox: four bands, each 50
    // device px. Sample the start of the second band, which must be red again.
    const { png } = render(
      '<svg viewBox="0 0 100 100"><defs>' +
      '<linearGradient id="g" gradientUnits="userSpaceOnUse" spreadMethod="repeat" ' +
      'x1="0" y1="0" x2="25" y2="0">' +
      '<stop offset="0" stop-color="#f00"/><stop offset="1" stop-color="#00f"/>' +
      '</linearGradient></defs>' +
      '<rect width="100" height="100" fill="url(#g)"/></svg>');
    expect(png.at(4, 100)[0]).toBeGreaterThan(200);      // band 0 start: red
    expect(png.at(46, 100)[2]).toBeGreaterThan(200);     // band 0 end: blue
    expect(png.at(54, 100)[0]).toBeGreaterThan(200);     // band 1 start: red again
  });

  it('repeats a radial gradient outward in rings', () => {
    // userSpaceOnUse r = 12.5 over a 100-unit viewBox rendered at 2x, so a ring
    // is 25 device px. Sampling the centre row means the y flip cannot confuse
    // the reading: device (x, 100) is viewBox (x/2, 50), the gradient's centre row.
    // k works out to 6, which the 257-entry LUT in raster.ts resolves comfortably.
    const { png, skipped } = render(
      '<svg viewBox="0 0 100 100"><defs>' +
      '<radialGradient id="g" gradientUnits="userSpaceOnUse" spreadMethod="repeat" ' +
      'cx="50" cy="50" r="12.5">' +
      '<stop offset="0" stop-color="#f00"/><stop offset="1" stop-color="#00f"/>' +
      '</radialGradient></defs>' +
      '<rect width="100" height="100" fill="url(#g)"/></svg>');
    expect(skipped).toEqual([]);
    expect(png.at(100, 100)[0]).toBeGreaterThan(215);    // centre: red
    expect(png.at(124, 100)[2]).toBeGreaterThan(200);    // ring 0 end: blue
    expect(png.at(128, 100)[0]).toBeGreaterThan(200);    // ring 1 start: red again
    expect(png.at(152, 100)[0]).toBeGreaterThan(200);    // ring 2 start: red again
  });

  it('honours a uniform stop-opacity against the white page', () => {
    const { png } = render(
      '<svg viewBox="0 0 100 100"><defs><linearGradient id="g">' +
      '<stop offset="0" stop-color="#f00" stop-opacity="0.5"/>' +
      '<stop offset="1" stop-color="#f00" stop-opacity="0.5"/>' +
      '</linearGradient></defs>' +
      '<rect width="100" height="100" fill="url(#g)"/></svg>');
    // 50% red over white -> (255, 128, 128)
    const [r, g, b] = png.at(100, 100);
    expect(near(r, 255)).toBe(true);
    expect(near(g, 128)).toBe(true);
    expect(near(b, 128)).toBe(true);
  });
});

describe('AddSVGObject — varying stop-opacity through Save/Open/ToImage', () => {
  it('ramps alpha 0 → 1 over an opaque backdrop', () => {
    // Constant red, ramping alpha: the colour is held still so only the mask
    // can produce the change across the shape.
    const { png, skipped } = render(
      '<svg viewBox="0 0 100 100"><defs><linearGradient id="g">' +
      '<stop offset="0" stop-color="#f00" stop-opacity="0"/>' +
      '<stop offset="1" stop-color="#f00" stop-opacity="1"/>' +
      '</linearGradient></defs>' +
      '<rect width="100" height="100" fill="url(#g)"/></svg>', BLUE_PAGE);
    expect(skipped).toEqual([]);
    const [lr, , lb] = png.at(4, 100);
    expect(near(lr, 0)).toBe(true);        // fully transparent: pure backdrop
    expect(near(lb, 255)).toBe(true);
    const [rr, , rb] = png.at(196, 100);
    expect(near(rr, 255)).toBe(true);      // fully opaque: pure red
    expect(near(rb, 0)).toBe(true);
    const [mr, , mb] = png.at(100, 100);
    expect(near(mr, 128)).toBe(true);      // half: an even blend
    expect(near(mb, 128)).toBe(true);
  });

  it('places the alpha ramp under a nested transform (the CTM cancels once)', () => {
    // The rect covers element x 0..100 under translate(50)+scale(0.5), i.e.
    // viewBox x 50..100 and device x 100..200. Device x=150 is the ramp's
    // midpoint. If the mask pattern /Matrix wrongly kept the element CTM the
    // ramp compresses into device 150..200 and this pixel reads pure backdrop.
    const { png } = render(
      '<svg viewBox="0 0 100 100"><defs><linearGradient id="g">' +
      '<stop offset="0" stop-color="#f00" stop-opacity="0"/>' +
      '<stop offset="1" stop-color="#f00" stop-opacity="1"/>' +
      '</linearGradient></defs>' +
      '<g transform="translate(50 0) scale(0.5 1)">' +
      '<rect width="100" height="100" fill="url(#g)"/></g></svg>', BLUE_PAGE);
    const [mr, , mb] = png.at(150, 100);
    expect(near(mr, 128)).toBe(true);
    expect(near(mb, 128)).toBe(true);
  });

  it('leaves a solid stroke fully opaque beside a masked fill', () => {
    // The fill's ramp is ~0 at the left edge. A single mask over the whole
    // painting operation would make the green stroke nearly vanish there.
    const { png, skipped } = render(
      '<svg viewBox="0 0 100 100"><defs><linearGradient id="g">' +
      '<stop offset="0" stop-color="#f00" stop-opacity="0"/>' +
      '<stop offset="1" stop-color="#f00" stop-opacity="1"/>' +
      '</linearGradient></defs>' +
      '<rect x="10" y="10" width="80" height="80" fill="url(#g)" ' +
      'stroke="#0f0" stroke-width="20"/></svg>', BLUE_PAGE);
    expect(skipped).toEqual([]);
    const [sr, sg2, sb] = png.at(20, 100);     // centre of the left stroke band
    expect(near(sr, 0)).toBe(true);
    expect(near(sg2, 255)).toBe(true);
    expect(near(sb, 0)).toBe(true);
  });

  it('fades a radial gradient outward', () => {
    const { png, skipped } = render(
      '<svg viewBox="0 0 100 100"><defs><radialGradient id="g">' +
      '<stop offset="0" stop-color="#f00" stop-opacity="1"/>' +
      '<stop offset="1" stop-color="#f00" stop-opacity="0"/>' +
      '</radialGradient></defs>' +
      '<circle cx="50" cy="50" r="50" fill="url(#g)"/></svg>', BLUE_PAGE);
    expect(skipped).toEqual([]);
    expect(near(png.at(100, 100)[0], 255)).toBe(true);   // centre: opaque red
    const [er, , eb] = png.at(198, 100);                 // rim: transparent
    expect(near(er, 0)).toBe(true);
    expect(near(eb, 255)).toBe(true);
  });
});

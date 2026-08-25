import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { buildSvgPdf } from './helpers/build-svg-fixtures.js';
import { decodePng, type DecodedPng } from './helpers/decode-png.js';

const svg = (s: string) => new TextEncoder().encode(s);

/** Place `src` over a 200x200 page at 1 px per point, so an SVG unit in a
 *  200-unit viewBox is one device pixel and SVG y maps 1:1 onto device y.
 *
 *  raster.ts resolves /SMask and transparency groups with its own logic, so
 *  these assertions do not round-trip through the code that produced them —
 *  the writer-versus-reader check CLAUDE.md's differential rule asks for. */
function render(src: string) {
  const p = Document.Open(buildSvgPdf({ mediaBox: [0, 0, 200, 200], content: '' })).Pages[0];
  const r = p.AddSVGObject(svg(src), [0, 0, 200, 200], { fit: 'fill' });
  const rt = Document.Open(p.Document.Save());
  return { png: decodePng(rt.Pages[0].ToImage()), skipped: r.skipped };
}

const isRed = (png: DecodedPng, x: number, y: number): boolean => {
  const [r, g, b] = png.at(x, y);
  return r > 200 && g < 80 && b < 80;
};
const isWhite = (png: DecodedPng, x: number, y: number): boolean => {
  const [r, g, b] = png.at(x, y);
  return r > 240 && g > 240 && b > 240;
};

/** A red square over the whole viewBox, masked by a white rect covering only
 *  its left half: the right half must vanish.
 *
 *  The mask REGION deliberately covers the whole viewBox, so the group /BBox
 *  cannot produce this result on its own — only the soft mask can. A region
 *  narrowed to the left half would clip identically and let a dropped /SMask
 *  pass unnoticed, which is what region clipping is tested separately for. */
const HALF =
  '<svg viewBox="0 0 200 200"><defs>' +
  '<mask id="m" maskUnits="userSpaceOnUse" x="0" y="0" width="200" height="200">' +
  '<rect width="100" height="200" fill="#ffffff"/></mask></defs>' +
  '<rect width="200" height="200" fill="#ff0000" mask="url(#m)"/></svg>';

describe('AddSVGObject — masks through Save/Open/ToImage', () => {
  it('shows the element only where the mask is white', () => {
    const { png, skipped } = render(HALF);
    expect(skipped).toEqual([]);
    expect(isRed(png, 50, 100)).toBe(true);      // inside the mask
    expect(isWhite(png, 150, 100)).toBe(true);   // outside it: page shows through
  });

  it('scales the element by a mid-gray mask rather than hiding it', () => {
    // 50% gray luminance ~ 0.5 alpha, so red over white lands near (255,128,128).
    const { png } = render(HALF.replace('fill="#ffffff"', 'fill="#808080"'));
    const [r, g, b] = png.at(50, 100);
    expect(r).toBeGreaterThan(200);
    expect(g).toBeGreaterThan(80);
    expect(g).toBeLessThan(190);
    expect(Math.abs(g - b)).toBeLessThan(12);
  });

  it('hides the element under a black mask', () => {
    const { png } = render(HALF.replace('fill="#ffffff"', 'fill="#000000"'));
    expect(isWhite(png, 50, 100)).toBe(true);
  });

  it('masks by alpha, not luminance, under mask-type="alpha"', () => {
    // A BLACK mask rect at full alpha: luminance says hide, alpha says show.
    // Only an /S /Alpha soft mask keeps the element visible here.
    const { png, skipped } = render(
      HALF.replace('<mask id="m"', '<mask id="m" mask-type="alpha"')
          .replace('fill="#ffffff"', 'fill="#000000"'));
    expect(skipped).toEqual([]);
    expect(isRed(png, 50, 100)).toBe(true);
    expect(isWhite(png, 150, 100)).toBe(true);
  });

  it('clips the element to the mask region', () => {
    // The mask content covers everything, but the REGION is the left half, so
    // the right half must still vanish (SVG 1.1 s14.4).
    const { png } = render(
      '<svg viewBox="0 0 200 200"><defs>' +
      '<mask id="m" maskUnits="userSpaceOnUse" x="0" y="0" width="100" height="200">' +
      '<rect width="200" height="200" fill="#ffffff"/></mask></defs>' +
      '<rect width="200" height="200" fill="#ff0000" mask="url(#m)"/></svg>');
    expect(isRed(png, 50, 100)).toBe(true);
    expect(isWhite(png, 150, 100)).toBe(true);
  });

  it('masks a group as a unit', () => {
    const { png, skipped } = render(
      '<svg viewBox="0 0 200 200"><defs>' +
      '<mask id="m" maskUnits="userSpaceOnUse" x="0" y="0" width="100" height="200">' +
      '<rect width="100" height="200" fill="#ffffff"/></mask></defs>' +
      '<g mask="url(#m)"><rect width="200" height="100" fill="#ff0000"/>' +
      '<rect y="100" width="200" height="100" fill="#ff0000"/></g></svg>');
    expect(skipped).toEqual([]);
    expect(isRed(png, 50, 50)).toBe(true);
    expect(isRed(png, 50, 150)).toBe(true);
    expect(isWhite(png, 150, 50)).toBe(true);
    expect(isWhite(png, 150, 150)).toBe(true);
  });

  it('resolves the default objectBoundingBox region against the element box', () => {
    // No maskUnits: the region is the box plus a 10% bleed, and the mask's own
    // white rect covers the left half of the box in user units.
    const { png, skipped } = render(
      '<svg viewBox="0 0 200 200"><defs>' +
      '<mask id="m"><rect width="100" height="200" fill="#ffffff"/></mask></defs>' +
      '<rect width="200" height="200" fill="#ff0000" mask="url(#m)"/></svg>');
    expect(skipped).toEqual([]);
    expect(isRed(png, 50, 100)).toBe(true);
    expect(isWhite(png, 150, 100)).toBe(true);
  });

  it('honours maskContentUnits="objectBoundingBox"', () => {
    // The mask rect is 0.5 x 1 of the box: the left half again, expressed as
    // fractions rather than user units.
    const { png, skipped } = render(
      '<svg viewBox="0 0 200 200"><defs>' +
      '<mask id="m" maskContentUnits="objectBoundingBox">' +
      '<rect width="0.5" height="1" fill="#ffffff"/></mask></defs>' +
      '<rect width="200" height="200" fill="#ff0000" mask="url(#m)"/></svg>');
    expect(skipped).toEqual([]);
    expect(isRed(png, 50, 100)).toBe(true);
    expect(isWhite(png, 150, 100)).toBe(true);
  });

  it('keeps a gradient alpha ramp working inside a masked element', () => {
    // The element's fill carries its own varying-alpha /SMask; the mask claims
    // the OUTER gs. Both must survive — this is why the group exists.
    const { png, skipped } = render(
      '<svg viewBox="0 0 200 200"><defs>' +
      '<mask id="m" maskUnits="userSpaceOnUse" x="0" y="0" width="100" height="200">' +
      '<rect width="100" height="200" fill="#ffffff"/></mask>' +
      '<linearGradient id="g"><stop offset="0" stop-color="#ff0000" stop-opacity="1"/>' +
      '<stop offset="1" stop-color="#ff0000" stop-opacity="0"/></linearGradient></defs>' +
      '<rect width="200" height="200" fill="url(#g)" mask="url(#m)"/></svg>');
    expect(skipped).toEqual([]);
    expect(isRed(png, 5, 100)).toBe(true);        // opaque end, inside the mask
    expect(isWhite(png, 150, 100)).toBe(true);    // outside the mask
  });
});

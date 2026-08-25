import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { buildSvgPdf } from './helpers/build-svg-fixtures.js';
import { decodePng, type DecodedPng } from './helpers/decode-png.js';

const svg = (s: string) => new TextEncoder().encode(s);

/** Place `src` over a 200x200 page at 1 px per point, so an SVG unit in a
 *  200-unit viewBox is one device pixel and SVG y maps 1:1 onto device y.
 *
 *  raster.ts rasterizes tiling patterns with its own reading of /Matrix,
 *  /XStep and /YStep (blitTile replicates a cell across the clip bbox), so
 *  these assertions do not round-trip through the code that produced them.
 *  That makes this the writer-versus-reader check CLAUDE.md's differential
 *  rule asks for -- which the CSS work in 1gg0.11 had no way to obtain. */
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

/** A 100x100 cell with a red square in its top-left quadrant only. */
const CHECKER =
  '<svg viewBox="0 0 200 200"><defs>' +
  '<pattern id="p" width="100" height="100" patternUnits="userSpaceOnUse">' +
  '<rect width="50" height="50" fill="#ff0000"/></pattern></defs>' +
  '<rect width="200" height="200" fill="url(#p)"/></svg>';

describe('AddSVGObject — patterns through Save/Open/ToImage', () => {
  it('tiles the cell across the shape on the XStep/YStep lattice', () => {
    const { png, skipped } = render(CHECKER);
    expect(skipped).toEqual([]);
    // Four cells at 100pt spacing. Sampling all four proves the lattice; one
    // alone passes on a broken /XStep.
    for (const [cx, cy] of [[0, 0], [100, 0], [0, 100], [100, 100]]) {
      expect(isRed(png, cx + 25, cy + 25)).toBe(true);    // inside the square
      expect(isRed(png, cx + 75, cy + 75)).toBe(false);   // the empty quadrant
    }
  });

  it('places the tile origin where x and y ask', () => {
    const { png } = render(
      '<svg viewBox="0 0 200 200"><defs>' +
      '<pattern id="p" x="50" y="50" width="100" height="100" patternUnits="userSpaceOnUse">' +
      '<rect width="50" height="50" fill="#ff0000"/></pattern></defs>' +
      '<rect width="200" height="200" fill="url(#p)"/></svg>');
    // Shifting the tile by (50,50) moves the red square with it.
    expect(isRed(png, 75, 75)).toBe(true);
    expect(isRed(png, 25, 25)).toBe(false);
  });

  it('scales the tile under objectBoundingBox units', () => {
    // Default patternUnits: width 0.5 of a 200-wide box = a 100pt cell.
    const { png, skipped } = render(
      '<svg viewBox="0 0 200 200"><defs>' +
      '<pattern id="p" width="0.5" height="0.5">' +
      '<rect width="50" height="50" fill="#ff0000"/></pattern></defs>' +
      '<rect width="200" height="200" fill="url(#p)"/></svg>');
    expect(skipped).toEqual([]);
    expect(isRed(png, 25, 25)).toBe(true);
    expect(isRed(png, 125, 25)).toBe(true);
    expect(isRed(png, 75, 75)).toBe(false);
  });

  it('spills across cell boundaries under overflow visible', () => {
    // The bar is wider than the cell, so with overflow:visible it reaches into
    // the neighbouring cell; clipped to /BBox it could not.
    const { png } = render(
      '<svg viewBox="0 0 200 200"><defs>' +
      '<pattern id="p" width="100" height="100" patternUnits="userSpaceOnUse" ' +
      'overflow="visible"><rect width="150" height="20" fill="#ff0000"/></pattern>' +
      '</defs><rect width="200" height="200" fill="url(#p)"/></svg>');
    expect(isRed(png, 120, 10)).toBe(true);     // past the 100pt cell edge
  });
});

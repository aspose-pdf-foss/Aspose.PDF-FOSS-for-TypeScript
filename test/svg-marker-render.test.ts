import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { buildSvgPdf } from './helpers/build-svg-fixtures.js';
import { decodePng, type DecodedPng } from './helpers/decode-png.js';

const svg = (s: string) => new TextEncoder().encode(s);

/** Place `src` over a 200x200 page at 1 px per point, so an SVG unit in a
 *  200-unit viewBox is one device pixel and SVG y maps 1:1 onto device y.
 *
 *  raster.ts resolves a Form XObject's /Matrix and /BBox with its own logic, so
 *  these assertions do not round-trip through the code that produced them. */
function render(src: string) {
  const p = Document.Open(buildSvgPdf({ mediaBox: [0, 0, 200, 200], content: '' })).Pages[0];
  const r = p.AddSVGObject(svg(src), [0, 0, 200, 200], { fit: 'fill' });
  const rt = Document.Open(p.Document.Save());
  return { png: decodePng(rt.Pages[0].ToImage()), skipped: r.skipped };
}

const isBlue = (png: DecodedPng, x: number, y: number): boolean => {
  const [r, g, b] = png.at(x, y);
  return b > 200 && r < 80 && g < 80;
};

/** A 20x20 blue square, referenced at its centre. */
const SQUARE =
  '<defs><marker id="mk" markerWidth="20" markerHeight="20" refX="10" refY="10" ' +
  'markerUnits="userSpaceOnUse"><rect width="20" height="20" fill="#0000ff"/>' +
  '</marker></defs>';

/** A 20-wide right-pointing triangle, referenced at its tip. */
const ARROW =
  '<defs><marker id="mk" markerWidth="20" markerHeight="20" refX="20" refY="10" ' +
  'orient="auto" markerUnits="userSpaceOnUse">' +
  '<path d="M 0 0 L 20 10 L 0 20 Z" fill="#0000ff"/></marker></defs>';

describe('AddSVGObject — markers through Save/Open/ToImage', () => {
  it('centres a marker on each vertex', () => {
    const { png, skipped } = render(
      `<svg viewBox="0 0 200 200">${SQUARE}` +
      '<path d="M 50 100 L 150 100" stroke="#000000" marker="url(#mk)"/></svg>');
    expect(skipped).toEqual([]);
    expect(isBlue(png, 50, 100)).toBe(true);      // start
    expect(isBlue(png, 150, 100)).toBe(true);     // end
    expect(isBlue(png, 100, 100)).toBe(false);    // no mid vertex on a 2-point path
  });

  it('paints a mid marker at the interior vertex only', () => {
    const { png } = render(
      `<svg viewBox="0 0 200 200">${SQUARE}` +
      '<path d="M 20 100 L 100 100 L 180 100" stroke="#000000" marker-mid="url(#mk)"/></svg>');
    expect(isBlue(png, 100, 100)).toBe(true);
    expect(isBlue(png, 20, 100)).toBe(false);
    expect(isBlue(png, 180, 100)).toBe(false);
  });

  it('rotates to the tangent under orient="auto"', () => {
    // The arrow's tip is its reference point and sits on the end vertex; its
    // body trails BACK along the path. On a leftward path the body is to the
    // RIGHT of the tip.
    const { png, skipped } = render(
      `<svg viewBox="0 0 200 200">${ARROW}` +
      '<path d="M 150 100 L 50 100" stroke="#000000" marker-end="url(#mk)"/></svg>');
    expect(skipped).toEqual([]);
    expect(isBlue(png, 60, 100)).toBe(true);      // body, trailing to the right
    expect(isBlue(png, 40, 100)).toBe(false);     // nothing past the tip
  });

  it('reverses the start marker under auto-start-reverse', () => {
    const { png } = render(
      `<svg viewBox="0 0 200 200">${ARROW.replace('orient="auto"', 'orient="auto-start-reverse"')}` +
      '<path d="M 100 100 L 180 100" stroke="#000000" marker-start="url(#mk)"/></svg>');
    // Reversed, the arrow points back down the path, so its body is to the RIGHT
    // of the vertex. Without the reversal it would be to the left.
    expect(isBlue(png, 110, 100)).toBe(true);
    expect(isBlue(png, 90, 100)).toBe(false);
  });

  it('scales the marker by stroke-width under the default markerUnits', () => {
    // markerWidth 4 at stroke-width 10 covers 40 units; at stroke-width 1 it
    // would cover 4 and miss the sample point entirely.
    const { png } = render(
      '<svg viewBox="0 0 200 200"><defs>' +
      '<marker id="mk" markerWidth="4" markerHeight="4" refX="2" refY="2">' +
      '<rect width="4" height="4" fill="#0000ff"/></marker></defs>' +
      '<path d="M 100 100 L 180 100" stroke="#000000" stroke-width="10" ' +
      'marker-start="url(#mk)"/></svg>');
    expect(isBlue(png, 115, 100)).toBe(true);
  });

  it('maps content through the marker viewBox', () => {
    // A 10x10 viewBox into a 40x40 viewport scales 4x: the 5x5 rect covers 20x20
    // device units from the reference point.
    const { png, skipped } = render(
      '<svg viewBox="0 0 200 200"><defs>' +
      '<marker id="mk" viewBox="0 0 10 10" markerWidth="40" markerHeight="40" ' +
      'refX="0" refY="0" markerUnits="userSpaceOnUse">' +
      '<rect width="5" height="5" fill="#0000ff"/></marker></defs>' +
      '<path d="M 50 50 L 150 50" stroke="#000000" marker-start="url(#mk)"/></svg>');
    expect(skipped).toEqual([]);
    expect(isBlue(png, 65, 65)).toBe(true);       // inside the scaled 20x20
    expect(isBlue(png, 85, 85)).toBe(false);      // past it
  });

  it('clips content to the viewport by default', () => {
    // The rect is twice the viewport; overflow defaults to hidden, so the
    // overspill must not paint.
    const { png } = render(
      '<svg viewBox="0 0 200 200"><defs>' +
      '<marker id="mk" markerWidth="20" markerHeight="20" refX="0" refY="0" ' +
      'markerUnits="userSpaceOnUse"><rect width="40" height="40" fill="#0000ff"/>' +
      '</marker></defs>' +
      '<path d="M 50 50 L 150 50" stroke="#000000" marker-start="url(#mk)"/></svg>');
    expect(isBlue(png, 60, 60)).toBe(true);       // inside the 20x20 viewport
    expect(isBlue(png, 80, 80)).toBe(false);      // clipped away
  });

  it('clips in viewBox units, not viewport units', () => {
    // A 10x10 viewBox into a 40x40 viewport (scale 4) holding a 20x20 rect: the
    // rect is twice the viewBox, so half of it must be clipped, leaving 40x40
    // device units painted rather than 80x80. Taking the clip rect in VIEWPORT
    // units instead would make the /BBox 40 wide in a space where the content is
    // only 10 across, clipping nothing at all.
    const { png } = render(
      '<svg viewBox="0 0 200 200"><defs>' +
      '<marker id="mk" viewBox="0 0 10 10" markerWidth="40" markerHeight="40" ' +
      'refX="0" refY="0" markerUnits="userSpaceOnUse">' +
      '<rect width="20" height="20" fill="#0000ff"/></marker></defs>' +
      '<path d="M 50 50 L 150 50" stroke="#000000" marker-start="url(#mk)"/></svg>');
    expect(isBlue(png, 70, 70)).toBe(true);       // inside the 40x40 clipped area
    expect(isBlue(png, 110, 110)).toBe(false);    // would paint if unclipped
  });

  it('lets overflow visible paint outside the viewport', () => {
    const { png } = render(
      '<svg viewBox="0 0 200 200"><defs>' +
      '<marker id="mk" markerWidth="20" markerHeight="20" refX="0" refY="0" ' +
      'overflow="visible" markerUnits="userSpaceOnUse">' +
      '<rect width="40" height="40" fill="#0000ff"/></marker></defs>' +
      '<path d="M 50 50 L 150 50" stroke="#000000" marker-start="url(#mk)"/></svg>');
    expect(isBlue(png, 80, 80)).toBe(true);
  });

  it('follows the element transform', () => {
    const { png } = render(
      `<svg viewBox="0 0 200 200">${SQUARE}` +
      '<g transform="translate(0,60)">' +
      '<path d="M 50 40 L 150 40" stroke="#000000" marker-start="url(#mk)"/></g></svg>');
    expect(isBlue(png, 50, 100)).toBe(true);
    expect(isBlue(png, 50, 40)).toBe(false);
  });

  it('marks every vertex of a closed polygon', () => {
    const { png, skipped } = render(
      `<svg viewBox="0 0 200 200">${SQUARE}` +
      '<polygon points="50,50 150,50 150,150" fill="none" stroke="#000000" ' +
      'marker="url(#mk)"/></svg>');
    expect(skipped).toEqual([]);
    for (const [x, y] of [[50, 50], [150, 50], [150, 150]])
      expect(isBlue(png, x, y)).toBe(true);
  });
});

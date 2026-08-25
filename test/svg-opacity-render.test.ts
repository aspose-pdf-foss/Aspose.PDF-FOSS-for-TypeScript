import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { buildSvgPdf } from './helpers/build-svg-fixtures.js';
import { decodePng, type DecodedPng } from './helpers/decode-png.js';

const svg = (s: string) => new TextEncoder().encode(s);

/** Place `src` over a 200x200 page at 1 px per point, so an SVG unit in a
 *  200-unit viewBox is one device pixel and SVG y maps 1:1 onto device y.
 *
 *  raster.ts resolves transparency groups with its own logic, so these
 *  assertions do not round-trip through the code that produced them — the
 *  writer-versus-reader check CLAUDE.md's differential rule asks for. */
function render(src: string) {
  const p = Document.Open(buildSvgPdf({ mediaBox: [0, 0, 200, 200], content: '' })).Pages[0];
  const r = p.AddSVGObject(svg(src), [0, 0, 200, 200], { fit: 'fill' });
  const rt = Document.Open(p.Document.Save());
  return { png: decodePng(rt.Pages[0].ToImage()), skipped: r.skipped };
}

const near = (png: DecodedPng, x: number, y: number, rgb: [number, number, number]) => {
  const [r, g, b] = png.at(x, y);
  expect([r, g, b].map((v) => Math.round(v / 4) * 4))
    .toEqual(rgb.map((v) => Math.round(v / 4) * 4));
};

/** A red bar and a blue bar overlapping between x=80 and x=120, inside a group
 *  at half opacity. Blue is painted second, so INSIDE the group it fully covers
 *  red in the overlap — the group is flat blue there, and fading the group once
 *  must give the same pixel as the blue-only region.
 *
 *  That is an INTERNAL identity (overlap equals blue-only), not a diff against
 *  our own producer, so it cannot cancel out the way CLAUDE.md warns a
 *  differential test can. Folding the alpha into each child instead composites
 *  blue-at-50% over red-at-50% and lands near (128, 64, 191). */
const OVERLAP =
  '<svg viewBox="0 0 200 200"><g opacity="0.5">' +
  '<rect x="0" y="0" width="120" height="200" fill="#ff0000"/>' +
  '<rect x="80" y="0" width="120" height="200" fill="#0000ff"/>' +
  '</g></svg>';

describe('AddSVGObject — group opacity through Save/Open/ToImage', () => {
  it('composites the subtree as a unit, so the overlap is not darkened', () => {
    const { png, skipped } = render(OVERLAP);
    expect(skipped).toEqual([]);
    // Blue over white at 50%.
    near(png, 160, 100, [128, 128, 255]);
    // The overlap must be the SAME pixel, not blue over faded red.
    near(png, 100, 100, [128, 128, 255]);
    // And red-only stays red over white at 50%.
    near(png, 40, 100, [255, 128, 128]);
  });

  it('multiplies nested group opacities', () => {
    const { png } = render(
      '<svg viewBox="0 0 200 200"><g opacity="0.5"><g opacity="0.5">' +
      '<rect x="0" y="0" width="120" height="200" fill="#000000"/>' +
      '<rect x="80" y="0" width="120" height="200" fill="#000000"/>' +
      '</g></g></svg>');
    // Black at 0.25 over white.
    near(png, 100, 100, [191, 191, 191]);
    near(png, 160, 100, [191, 191, 191]);
  });

  it('keeps a fill-only shape identical to the folded result', () => {
    const { png } = render(
      '<svg viewBox="0 0 200 200">' +
      '<rect x="0" y="0" width="200" height="200" fill="#ff0000" opacity="0.5"/></svg>');
    near(png, 100, 100, [255, 128, 128]);
  });

  it('does not crop the group at its /BBox under a transform', () => {
    // The group's /BBox lives in the ELEMENT's user space, so it must be the
    // viewport mapped back through the CTM. Here the translate puts half the
    // content at NEGATIVE element coordinates — using the raw viewport
    // rectangle (0..200) as the box would crop everything left of device x=100
    // while still looking correct for a positive-only fixture.
    const { png } = render(
      '<svg viewBox="0 0 200 200"><g transform="translate(100 0)">' +
      '<g opacity="0.5">' +
      '<rect x="-100" y="0" width="120" height="200" fill="#ff0000"/>' +
      '<rect x="-20" y="0" width="120" height="200" fill="#ff0000"/>' +
      '</g></g></svg>');
    near(png, 20, 100, [255, 128, 128]);    // element x = -80, the cropped half
    near(png, 180, 100, [255, 128, 128]);   // element x = +80
  });
});

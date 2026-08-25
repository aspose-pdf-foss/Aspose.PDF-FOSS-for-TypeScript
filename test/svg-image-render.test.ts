import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { buildSvgPdf } from './helpers/build-svg-fixtures.js';
import { buildPngRgbWith } from './helpers/build-embed-images.js';
import { decodePng, type DecodedPng } from './helpers/decode-png.js';

const svg = (s: string) => new TextEncoder().encode(s);

/** A 2x2 RGB PNG: red top-left, green top-right, blue bottom-left, yellow
 *  bottom-right. Every quadrant differs, so orientation is pinned in both axes at
 *  once — a horizontally symmetric image would hide a mirror — and none of them
 *  is white, so "white" always means the page showing through. */
const QUADRANTS = `data:image/png;base64,${Buffer.from(buildPngRgbWith(2, 2, [
  255, 0, 0, 0, 255, 0,
  0, 0, 255, 255, 255, 0,
], 0)).toString('base64')}`;

/** Place `src` over a 200x200 page at 1 px per point, so an SVG unit in a
 *  200-unit viewBox is one device pixel and SVG y maps 1:1 onto device y.
 *
 *  raster.ts decodes the Image XObject and inverse-maps device pixels to image
 *  UV with its own local Y-flip — code written separately from svgimage.ts's
 *  cm — so these assertions do not round-trip through the writer under test.
 *  That makes this the writer-versus-reader check CLAUDE.md's differential rule
 *  asks for, and the only assertion that can catch a mirrored image. */
function render(src: string) {
  const p = Document.Open(buildSvgPdf({ mediaBox: [0, 0, 200, 200], content: '' })).Pages[0];
  const r = p.AddSVGObject(svg(src), [0, 0, 200, 200], { fit: 'fill' });
  const rt = Document.Open(p.Document.Save());
  return { png: decodePng(rt.Pages[0].ToImage()), skipped: r.skipped };
}

/** Which of the four sample colours pixel (x, y) is closest to. */
function hue(png: DecodedPng, x: number, y: number): string {
  const [r, g, b] = png.at(x, y);
  if (r > 200 && g < 80 && b < 80) return 'red';
  if (g > 200 && r < 80 && b < 80) return 'green';
  if (b > 200 && r < 80 && g < 80) return 'blue';
  if (r > 200 && g > 200 && b < 80) return 'yellow';
  if (r > 200 && g > 200 && b > 200) return 'white';   // the page, never the image
  return `other(${r},${g},${b})`;
}

describe('AddSVGObject — <image> through Save/Open/ToImage', () => {
  it('draws the image upright and in place', () => {
    // The image fills the top-left 100x100 of a 200x200 viewBox, so in device
    // space its quadrants are 50x50 blocks at (0,0), (50,0), (0,50), (50,50).
    const { png, skipped } = render(
      `<svg viewBox="0 0 200 200"><image width="100" height="100" ` +
      `preserveAspectRatio="none" href="${QUADRANTS}"/></svg>`);
    expect(skipped).toEqual([]);
    expect(hue(png, 25, 25)).toBe('red');      // top-left stays top-left
    expect(hue(png, 75, 25)).toBe('green');    // no horizontal mirror
    expect(hue(png, 25, 75)).toBe('blue');     // no vertical mirror
    expect(hue(png, 75, 75)).toBe('yellow');
    // Nothing painted outside the element rect.
    expect(hue(png, 150, 150)).toBe('white');
  });

  it('honours x and y', () => {
    const { png } = render(
      `<svg viewBox="0 0 200 200"><image x="100" y="100" width="100" height="100" ` +
      `preserveAspectRatio="none" href="${QUADRANTS}"/></svg>`);
    expect(hue(png, 125, 125)).toBe('red');
    expect(hue(png, 175, 125)).toBe('green');
    expect(hue(png, 125, 175)).toBe('blue');
  });

  it('letterboxes under the default meet fit', () => {
    // A square image in a 200x100 box: fitted to 100x100 and centred, so the
    // left and right margins stay page-white.
    const { png } = render(
      `<svg viewBox="0 0 200 200"><image width="200" height="100" href="${QUADRANTS}"/></svg>`);
    expect(hue(png, 75, 25)).toBe('red');
    expect(hue(png, 125, 25)).toBe('green');
    expect(hue(png, 10, 50)).toBe('white');    // letterbox margin
  });

  it('applies a transform from an enclosing group', () => {
    const { png } = render(
      `<svg viewBox="0 0 200 200"><g transform="translate(100,0)">` +
      `<image width="100" height="100" preserveAspectRatio="none" ` +
      `href="${QUADRANTS}"/></g></svg>`);
    expect(hue(png, 125, 25)).toBe('red');
    expect(hue(png, 25, 25)).toBe('white');
  });
});

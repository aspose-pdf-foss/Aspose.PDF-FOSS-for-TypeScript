import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { buildSvgPdf } from './helpers/build-svg-fixtures.js';
import { decodePng, type DecodedPng } from './helpers/decode-png.js';

const svg = (s: string) => new TextEncoder().encode(s);

/** Place `src` over a 200x200 page at 1 px per point, so an SVG unit in a
 *  200-unit viewBox is one device pixel and SVG y maps 1:1 onto device y. */
function render(src: string) {
  const p = Document.Open(buildSvgPdf({ mediaBox: [0, 0, 200, 200], content: '' })).Pages[0];
  const r = p.AddSVGObject(svg(src), [0, 0, 200, 200], { fit: 'fill' });
  const rt = Document.Open(p.Document.Save());
  return { png: decodePng(rt.Pages[0].ToImage()), skipped: r.skipped };
}

/** Whether any pixel in the box is reddish. Regions rather than exact pixels:
 *  the assertion is about WHERE the run went, and predicting a Standard-14
 *  glyph's exact coverage would test the rasterizer instead.
 *
 *  "Red dominates" rather than "red saturates": a 1-unit-wide underline lands
 *  as half-covered pixels around (255, 128, 128), which a `g < 100` threshold
 *  rejects. This still excludes white, grey and black. */
function anyRed(png: DecodedPng, x0: number, y0: number, x1: number, y1: number): boolean {
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
    const [r, g, b] = png.at(x, y);
    if (r - g > 40 && r - b > 40) return true;
  }
  return false;
}

/** A vertical path down the middle, so mapped text forms a VERTICAL band at
 *  x~100 — geometry predictable in closed form rather than compared against our
 *  own producer, which is what keeps this from cancelling out the way CLAUDE.md
 *  warns a differential test can.
 *
 *  The leading "A" sits OUTSIDE the textPath and is the control. It is not
 *  decoration: absolute x/y do not apply to path text, so an unmapped run lands
 *  at the origin and falls off the top of the page entirely. Without a glyph
 *  that renders either way, "no ink in the band" would be satisfied by the SVG
 *  failing to draw at all, and the test would pass for the wrong reason. */
const VERTICAL =
  '<svg viewBox="0 0 200 200">' +
  '<defs><path id="p" d="M100 20 L100 180"/></defs>' +
  '<text x="10" y="150" font-size="20" fill="#ff0000">A' +
  '<textPath href="#p">HHHHHHHH</textPath></text></svg>';

describe('AddSVGObject — textPath through Save/Open/ToImage', () => {
  it('lays the run along the path, not along the baseline', () => {
    const { png, skipped } = render(VERTICAL);
    expect(skipped).toEqual([]);
    expect(anyRed(png, 90, 30, 110, 170)).toBe(true);    // the mapped band
    // The control: proves the page drew something, so the assertion above is
    // about WHERE the run went and not about whether anything rendered.
    expect(anyRed(png, 8, 136, 28, 152)).toBe(true);
  });

  it('turns the run with the path', () => {
    // A semicircle: the run starts heading down-right and ends heading up-right,
    // so ink must appear on BOTH limbs as well as over the top.
    const { png } = render(
      '<svg viewBox="0 0 200 200">' +
      '<defs><path id="c" d="M30 100 C30 30 170 30 170 100"/></defs>' +
      '<text font-size="18" fill="#ff0000">' +
      '<textPath href="#c">HHHHHHHHHHHH</textPath></text></svg>');
    expect(anyRed(png, 25, 55, 60, 100)).toBe(true);     // left limb
    expect(anyRed(png, 140, 55, 175, 100)).toBe(true);   // right limb
    expect(anyRed(png, 80, 30, 120, 70)).toBe(true);     // over the top
  });

  it('draws an underline that follows the path rather than lying flat', () => {
    const { png } = render(VERTICAL.replace(
      'font-size="20"', 'font-size="20" text-decoration="underline"'));
    // Under textMatrix(x, y, 90) a local (lx, ly) lands at user (x + ly, y + lx).
    // The rule's local y is the underline offset, about -2.5 at 20pt, so rotated
    // it is a VERTICAL bar at x ~= 97.5 — strictly left of the path, while glyph
    // ink runs from x = 100 rightwards. An unrotated rect would instead be
    // horizontal bars spanning x = 100..114, leaving this strip empty. That is
    // the whole discrimination: sampling anywhere at x >= 100 catches both.
    expect(anyRed(png, 95, 40, 99, 160)).toBe(true);
  });

  it('warps the outlines when the face can supply them', () => {
    // Standard-14 faces resolve to the bundled substitutes, which have
    // outlines, so this path stretches for real and reports nothing.
    const { png, skipped } = render(
      '<svg viewBox="0 0 200 200">' +
      '<defs><path id="p" d="M100 20 L100 180"/></defs>' +
      '<text font-size="20" fill="#ff0000">' +
      '<textPath href="#p" method="stretch">HHHHHHHH</textPath></text></svg>');
    expect(skipped).toEqual([]);
    expect(anyRed(png, 90, 30, 120, 170)).toBe(true);
  });

  it('keeps a stretched run extractable', () => {
    // The whole point of the invisible overlay: vector art that is still text.
    const p = Document.Open(buildSvgPdf({ mediaBox: [0, 0, 200, 200], content: '' })).Pages[0];
    p.AddSVGObject(svg(
      '<svg viewBox="0 0 200 200">' +
      '<defs><path id="p" d="M20 100 L180 100"/></defs>' +
      '<text font-size="20"><textPath href="#p" method="stretch">STRETCH</textPath></text></svg>'),
      [0, 0, 200, 200], { fit: 'fill' });
    const rt = Document.Open(p.Document.Save());
    expect(rt.Pages[0].GetText().replace(/\s+/g, '')).toContain('STRETCH');
  });
});

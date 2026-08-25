import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { buildSvgPdf } from './helpers/build-svg-fixtures.js';
import { decodePng, type DecodedPng } from './helpers/decode-png.js';
import type { PdfDict, PdfStream } from '../src/types.js';

const svg = (s: string) => new TextEncoder().encode(s);

/** Place `src` over the whole of an empty 200x200 page, save, reopen, rasterize
 *  at 1 px per point — so a device pixel (x, y) is user (x, 200 - y), and with
 *  a 200-unit viewBox an SVG y maps 1:1 onto a device y.
 *
 *  raster.ts is an independently written READER, so these assertions do not
 *  round-trip through the same understanding that produced the content. This is
 *  the only place the y-flip is checked by something that could disagree with
 *  it: a matrix-versus-matrix test passes just as happily on mirrored output. */
function render(src: string) {
  const p = Document.Open(buildSvgPdf({ mediaBox: [0, 0, 200, 200], content: '' })).Pages[0];
  const r = p.AddSVGObject(svg(src), [0, 0, 200, 200], { fit: 'fill' });
  const rt = Document.Open(p.Document.Save());
  return { png: decodePng(rt.Pages[0].ToImage()), skipped: r.skipped };
}

/** Fraction of dark pixels in a device-space box. */
function ink(png: DecodedPng, x0: number, y0: number, x1: number, y1: number): number {
  let n = 0, dark = 0;
  for (let y = y0; y < y1; y++)
    for (let x = x0; x < x1; x++) { n++; if (png.at(x, y)[0] < 128) dark++; }
  return dark / n;
}

describe('AddSVGObject — text through Save/Open/ToImage', () => {
  it('draws an L the right way up, not mirrored', () => {
    // THE test for the y-flip. An 'L' is ink down the left and along the
    // bottom. Mirrored, the bar lands at the TOP instead.
    const { png, skipped } = render(
      '<svg viewBox="0 0 200 200"><text x="20" y="180" font-size="160" ' +
      'font-family="Helvetica">L</text></svg>');
    expect(skipped).toEqual([]);
    const bottom = ink(png, 20, 150, 120, 180);
    const top = ink(png, 20, 40, 120, 70);
    expect(bottom).toBeGreaterThan(0.05);
    expect(bottom).toBeGreaterThan(top * 3);
  });

  it('puts text where the SVG asked, in SVG y-down coordinates', () => {
    // y=40 in a 200-unit viewBox is near the TOP of the page, which is a small
    // device y. Getting the flip wrong once puts it near the bottom.
    const { png } = render(
      '<svg viewBox="0 0 200 200"><text x="10" y="40" font-size="30">HHHH</text></svg>');
    expect(ink(png, 10, 15, 110, 45)).toBeGreaterThan(ink(png, 10, 155, 110, 185));
  });

  it('shifts each anchor by the right fraction of the string width', () => {
    // Compared against each other rather than against an absolute position: we
    // emit no /Widths for a Standard-14 face (as stamp.ts does), so the
    // RENDERER advances by its bundled substitute face's metrics, which need
    // not match the AFM. Only the first glyph's left side bearing enters the
    // leftmost-ink measurement, and it cancels across the three anchors -- so
    // the differences isolate our own shift.
    const at = (anchor: string): number => {
      const { png } = render('<svg viewBox="0 0 200 200"><text x="150" y="120" ' +
        `font-size="40" text-anchor="${anchor}">HHHH</text></svg>`);
      for (let x = 0; x < 200; x++)
        for (let y = 60; y < 130; y++) if (png.at(x, y)[0] < 128) return x;
      return -1;
    };
    const start = at('start'), middle = at('middle'), end = at('end');
    expect(end).toBeGreaterThan(0);              // not clipped off the page
    expect(start).toBeGreaterThan(middle);
    expect(middle).toBeGreaterThan(end);
    // middle is exactly half of end: the two gaps must match.
    expect(Math.abs((start - middle) - (middle - end))).toBeLessThanOrEqual(2);
    // 4 x Helvetica 'H' at 40pt = 4 x 0.722 x 40 = 115.5.
    expect(start - end).toBeGreaterThan(112);
    expect(start - end).toBeLessThan(119);
  });

  it('paints text with a gradient through the shading pattern path', () => {
    // Asserted on the content stream, not the pixels: ToImage resolves a fill
    // to one flat Rgb before drawing glyphs (TextRunInfo.color), so it renders
    // pattern-filled TEXT as a solid colour. That is a renderer gap affecting
    // any such PDF, filed separately -- the bytes we produce are correct.
    const p = Document.Open(buildSvgPdf({ mediaBox: [0, 0, 200, 200], content: '' })).Pages[0];
    const r = p.AddSVGObject(svg(
      '<svg viewBox="0 0 200 200"><defs><linearGradient id="g">' +
      '<stop offset="0" stop-color="#f00"/><stop offset="1" stop-color="#00f"/>' +
      '</linearGradient></defs>' +
      '<text x="0" y="140" font-size="150" fill="url(#g)">HH</text></svg>'),
      [0, 0, 200, 200], { fit: 'fill' });
    expect(r.skipped).toEqual([]);
    const res = p.Document.resolve(p.Dict.get('Resources')) as PdfDict;
    const xo = p.Document.resolve(res.get('XObject')) as PdfDict;
    const form = p.Document.resolve([...xo.values()][0]) as PdfStream;
    const content = new TextDecoder('latin1').decode(form.raw);
    expect(content).toContain('/Pattern cs');
    expect(content).toMatch(/\/P\d+ scn[\s\S]*BT/);
    expect(form.dict.get('Resources')).toBeDefined();
  });

  it('draws an underline just below the baseline and nowhere else', () => {
    const { png } = render(
      '<svg viewBox="0 0 200 200"><text x="20" y="100" font-size="60" ' +
      'text-decoration="underline">HHH</text></svg>');
    // Helvetica's underline sits at -0.1 em, 0.05 em thick: at 60pt that is
    // 6 below the baseline, 3 tall, so 104.5..107.5 in device rows. The
    // baseline is SVG y=100, which is device y=100 here.
    expect(ink(png, 20, 105, 140, 107)).toBeGreaterThan(0.9);
    expect(ink(png, 20, 100, 140, 104)).toBe(0);      // clear of the baseline
    expect(ink(png, 20, 110, 140, 125)).toBe(0);      // and nothing below
  });

  it('rotates a glyph without mirroring it', () => {
    const { png, skipped } = render(
      '<svg viewBox="0 0 200 200"><text x="100" y="20" font-size="120" ' +
      'rotate="90">L</text></svg>');
    expect(skipped).toEqual([]);
    // rotate(90) makes the text read downward, so the L's stem runs from the
    // anchor towards larger y. There must be ink well below the start point.
    expect(ink(png, 60, 20, 200, 160)).toBeGreaterThan(0.02);
  });
});

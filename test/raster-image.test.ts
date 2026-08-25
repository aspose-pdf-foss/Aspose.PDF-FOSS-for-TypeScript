import { describe, it, expect } from 'vitest';
import { deflateSync } from 'node:zlib';
import { Document } from '../src/document.js';
import { buildSvgPdf } from './helpers/build-svg-fixtures.js';
import { decodePng } from './helpers/decode-png.js';

const near = (v: number, t: number, tol = 16) => Math.abs(v - t) <= tol;
const isColor = (px: [number, number, number, number], r: number, g: number, b: number) =>
  near(px[0], r) && near(px[1], g) && near(px[2], b);
const isWhite = (px: [number, number, number, number]) => isColor(px, 255, 255, 255);

// A 2×2 RGB image: TL red, TR green, BL blue, BR yellow (row 0 = top).
const rgb2x2 = deflateSync(Buffer.from([
  255, 0, 0, /**/ 0, 255, 0,
  0, 0, 255, /**/ 255, 255, 0,
]));

function imagePdf(content: string, xobjDict: string, raw: Uint8Array) {
  return buildSvgPdf({
    mediaBox: [0, 0, 200, 200],
    resources: '<< /XObject << /Im0 5 0 R >> >>',
    content,
    extra: { 5: { dict: xobjDict, raw } },
  });
}

describe('Page.ToImage — image affine sampling', () => {
  // Place the 2×2 image scaled to a 100×100 box at user (50,50)-(150,150).
  const doc = () => Document.Open(imagePdf(
    'q 100 0 0 100 50 50 cm /Im0 Do Q',
    `<< /Type /XObject /Subtype /Image /Width 2 /Height 2 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode /Length ${rgb2x2.length} >>`,
    rgb2x2,
  ));

  it('samples each source texel into its device quadrant (with Y-flip)', () => {
    const png = decodePng(doc().Pages[0].ToImage());
    expect(isColor(png.at(70, 70), 255, 0, 0)).toBe(true);     // top-left → red
    expect(isColor(png.at(130, 70), 0, 255, 0)).toBe(true);    // top-right → green
    expect(isColor(png.at(70, 130), 0, 0, 255)).toBe(true);    // bottom-left → blue
    expect(isColor(png.at(130, 130), 255, 255, 0)).toBe(true); // bottom-right → yellow
  });

  it('leaves area outside the image square as background', () => {
    const png = decodePng(doc().Pages[0].ToImage());
    expect(isWhite(png.at(20, 20))).toBe(true);
    expect(isWhite(png.at(180, 180))).toBe(true);
  });
});

describe('Page.ToImage — image mask stencil', () => {
  // 2×2 stencil, 1 bpc: bit 0 = paint (default /Decode). Paint TL and BR only.
  // Row bytes: col0=bit7, col1=bit6. Row0: paint col0, skip col1 → 0b01000000.
  // Row1: skip col0, paint col1 → 0b10000000.
  const maskBits = deflateSync(Buffer.from([0b01000000, 0b10000000]));

  it('paints the fill color where the mask samples paint, transparent elsewhere', () => {
    const doc = Document.Open(imagePdf(
      '0 0 1 rg q 100 0 0 100 50 50 cm /Im0 Do Q',   // blue fill
      `<< /Type /XObject /Subtype /Image /Width 2 /Height 2 /ImageMask true /BitsPerComponent 1 /Filter /FlateDecode /Length ${maskBits.length} >>`,
      maskBits,
    ));
    const png = decodePng(doc.Pages[0].ToImage());
    expect(isColor(png.at(70, 70), 0, 0, 255)).toBe(true);   // TL painted → blue
    expect(isWhite(png.at(130, 70))).toBe(true);             // TR not painted → background
    expect(isWhite(png.at(70, 130))).toBe(true);             // BL not painted → background
    expect(isColor(png.at(130, 130), 0, 0, 255)).toBe(true); // BR painted → blue
  });
});

describe('Page.ToImage — image /SMask alpha', () => {
  it('applies the soft mask so transparent texels reveal the background', () => {
    const red2x2 = deflateSync(Buffer.from([255, 0, 0, 255, 0, 0, 255, 0, 0, 255, 0, 0]));
    // SMask: opaque TL & BR, transparent TR & BL.
    const smask = deflateSync(Buffer.from([255, 0, 0, 255]));
    const doc = Document.Open(buildSvgPdf({
      mediaBox: [0, 0, 200, 200],
      resources: '<< /XObject << /Im0 5 0 R >> >>',
      content: 'q 100 0 0 100 50 50 cm /Im0 Do Q',
      extra: {
        5: {
          dict: `<< /Type /XObject /Subtype /Image /Width 2 /Height 2 /ColorSpace /DeviceRGB /BitsPerComponent 8 /SMask 6 0 R /Filter /FlateDecode /Length ${red2x2.length} >>`,
          raw: red2x2,
        },
        6: {
          dict: `<< /Type /XObject /Subtype /Image /Width 2 /Height 2 /ColorSpace /DeviceGray /BitsPerComponent 8 /Filter /FlateDecode /Length ${smask.length} >>`,
          raw: smask,
        },
      },
    }));
    const png = decodePng(doc.Pages[0].ToImage());
    expect(isColor(png.at(70, 70), 255, 0, 0)).toBe(true);   // opaque → red
    expect(isWhite(png.at(130, 70))).toBe(true);             // transparent → background
    expect(isWhite(png.at(70, 130))).toBe(true);             // transparent → background
    expect(isColor(png.at(130, 130), 255, 0, 0)).toBe(true); // opaque → red
  });
});

describe('Page.ToImage — image under clip', () => {
  it('composites the sampled image through the active clip', () => {
    const doc = Document.Open(imagePdf(
      '0 0 90 200 re W n q 100 0 0 100 50 50 cm /Im0 Do Q',   // clip to left of x=90
      `<< /Type /XObject /Subtype /Image /Width 2 /Height 2 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode /Length ${rgb2x2.length} >>`,
      rgb2x2,
    ));
    const png = decodePng(doc.Pages[0].ToImage());
    expect(isColor(png.at(70, 70), 255, 0, 0)).toBe(true);   // inside clip → red texel
    expect(isWhite(png.at(130, 70))).toBe(true);             // right of clip → background
  });
});

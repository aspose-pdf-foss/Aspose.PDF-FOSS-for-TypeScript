import { describe, it, expect } from 'vitest';
import { deflateSync } from 'node:zlib';
import { Document } from '../src/document.js';
import { buildSvgPdf } from './helpers/build-svg-fixtures.js';
import { buildInkTtf, buildHoleTtf } from './helpers/build-sfnt.js';
import { buildCffOtto } from './helpers/build-cff.js';
import { decodePng } from './helpers/decode-png.js';

const near = (v: number, t: number, tol = 20) => Math.abs(v - t) <= tol;
const isRed = (px: [number, number, number, number]) => near(px[0], 255) && near(px[1], 0) && near(px[2], 0);
const isWhite = (px: [number, number, number, number]) => near(px[0], 255) && near(px[1], 255) && near(px[2], 255);

describe('Page.ToImage — embedded TrueType glyphs', () => {
  // Type0/CIDFontType2, Identity-H, Identity CIDToGIDMap; FontFile2 = ink font whose
  // glyph 1 is a solid box (100,0)-(900,700). Show code <0001> at size 100, origin (50,50).
  const ttf = buildInkTtf();
  const ff2 = deflateSync(Buffer.from(ttf));
  const doc = () => Document.Open(buildSvgPdf({
    mediaBox: [0, 0, 200, 200],
    resources: '<< /Font << /F0 5 0 R >> >>',
    content: 'BT /F0 100 Tf 1 0 0 rg 50 50 Td <0001> Tj ET',
    extra: {
      5: '<< /Type /Font /Subtype /Type0 /BaseFont /Ink /Encoding /Identity-H /DescendantFonts [6 0 R] >>',
      6: '<< /Type /Font /Subtype /CIDFontType2 /BaseFont /Ink /CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> /FontDescriptor 7 0 R /CIDToGIDMap /Identity /DW 1000 >>',
      7: '<< /Type /FontDescriptor /FontName /Ink /Flags 4 /FontBBox [0 -200 1000 800] /ItalicAngle 0 /Ascent 800 /Descent -200 /StemV 80 /FontFile2 8 0 R >>',
      8: { dict: `<< /Filter /FlateDecode /Length ${ff2.length} /Length1 ${ttf.length} >>`, raw: ff2 },
    },
  }));

  it('rasterizes glyph ink where the outline fills, background elsewhere', () => {
    const png = decodePng(doc().Pages[0].ToImage());
    // Glyph box → user (60,50)-(140,120) → device x 60..140, y 80..150.
    expect(isRed(png.at(100, 115))).toBe(true);   // center of the glyph box → red ink
    expect(isRed(png.at(70, 90))).toBe(true);      // upper-left of the box → red
    expect(isWhite(png.at(30, 30))).toBe(true);    // outside the glyph → background
    expect(isWhite(png.at(170, 170))).toBe(true);  // outside the glyph → background
  });
});

describe('Page.ToImage — simple TrueType via cmap', () => {
  it('maps a WinAnsi code through the font cmap to a glyph outline', () => {
    // Subtype /TrueType (simple) with a cmap mapping 'A'(0x41)→gid 1 (the box).
    const ttf = buildInkTtf();
    const ff2 = deflateSync(Buffer.from(ttf));
    const doc = Document.Open(buildSvgPdf({
      mediaBox: [0, 0, 200, 200],
      resources: '<< /Font << /F0 5 0 R >> >>',
      content: 'BT /F0 100 Tf 1 0 0 rg 50 50 Td (A) Tj ET',
      extra: {
        5: '<< /Type /Font /Subtype /TrueType /BaseFont /Ink /FirstChar 65 /Widths [1000] /Encoding /WinAnsiEncoding /FontDescriptor 6 0 R >>',
        6: '<< /Type /FontDescriptor /FontName /Ink /Flags 4 /FontBBox [0 -200 1000 800] /ItalicAngle 0 /Ascent 800 /Descent -200 /StemV 80 /FontFile2 7 0 R >>',
        7: { dict: `<< /Filter /FlateDecode /Length ${ff2.length} /Length1 ${ttf.length} >>`, raw: ff2 },
      },
    }));
    const png = decodePng(doc.Pages[0].ToImage());
    expect(isRed(png.at(100, 115))).toBe(true);    // box ink → red
    expect(isWhite(png.at(30, 30))).toBe(true);    // background
  });
});

describe('Page.ToImage — embedded CFF (OpenType-CFF) glyphs', () => {
  it('rasterizes a Type2 charstring outline via FontFile3', () => {
    const otto = buildCffOtto();
    const ff3 = deflateSync(Buffer.from(otto));
    const doc = Document.Open(buildSvgPdf({
      mediaBox: [0, 0, 200, 200],
      resources: '<< /Font << /F0 5 0 R >> >>',
      content: 'BT /F0 100 Tf 1 0 0 rg 50 50 Td (A) Tj ET',
      extra: {
        5: '<< /Type /Font /Subtype /Type1 /BaseFont /Box /FirstChar 65 /Widths [1000] /Encoding /WinAnsiEncoding /FontDescriptor 6 0 R >>',
        6: '<< /Type /FontDescriptor /FontName /Box /Flags 4 /FontBBox [0 -200 1000 800] /ItalicAngle 0 /Ascent 800 /Descent -200 /StemV 80 /FontFile3 7 0 R >>',
        7: { dict: `<< /Filter /FlateDecode /Subtype /OpenType /Length ${ff3.length} /Length1 ${otto.length} >>`, raw: ff3 },
      },
    }));
    const png = decodePng(doc.Pages[0].ToImage());
    expect(isRed(png.at(100, 115))).toBe(true);    // box charstring ink → red
    expect(isRed(png.at(70, 90))).toBe(true);       // upper-left of the box → red
    expect(isWhite(png.at(30, 30))).toBe(true);     // background
  });
});

describe('Page.ToImage — glyph with a hole (nonzero winding)', () => {
  it('leaves the counter empty where the inner contour reverses winding', () => {
    const ttf = buildHoleTtf();
    const ff2 = deflateSync(Buffer.from(ttf));
    const doc = Document.Open(buildSvgPdf({
      mediaBox: [0, 0, 200, 200],
      resources: '<< /Font << /F0 5 0 R >> >>',
      content: 'BT /F0 100 Tf 1 0 0 rg 50 50 Td <0001> Tj ET',
      extra: {
        5: '<< /Type /Font /Subtype /Type0 /BaseFont /Hole /Encoding /Identity-H /DescendantFonts [6 0 R] >>',
        6: '<< /Type /Font /Subtype /CIDFontType2 /BaseFont /Hole /CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> /FontDescriptor 7 0 R /CIDToGIDMap /Identity /DW 1000 >>',
        7: '<< /Type /FontDescriptor /FontName /Hole /Flags 4 /FontBBox [0 -200 1000 800] /ItalicAngle 0 /Ascent 800 /Descent -200 /StemV 80 /FontFile2 8 0 R >>',
        8: { dict: `<< /Filter /FlateDecode /Length ${ff2.length} /Length1 ${ttf.length} >>`, raw: ff2 },
      },
    }));
    const png = decodePng(doc.Pages[0].ToImage());
    // Outer box user (50,50)-(150,120); inner hole user (85,70)-(115,100).
    // Ink band between them, e.g. user (60,55) → device (60,145): red.
    expect(isRed(png.at(60, 145))).toBe(true);
    // Counter center user (100,85) → device (100,115): inside the hole → background.
    expect(isWhite(png.at(100, 115))).toBe(true);
  });
});

describe('Page.ToImage — Standard-14 placeholder', () => {
  it('draws placeholder boxes for a non-embedded font (no ink, but visible marks)', () => {
    const doc = Document.Open(buildSvgPdf({
      mediaBox: [0, 0, 200, 200],
      resources: '<< /Font << /F0 5 0 R >> >>',
      content: 'BT /F0 40 Tf 1 0 0 rg 20 100 Td (Hi) Tj ET',
      extra: { 5: '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>' },
    }));
    const png = decodePng(doc.Pages[0].ToImage());
    // Text sits around user x 20..60, y 100..125 → device x 20..60, y 75..100.
    let mark = false;
    for (let y = 70; y <= 105 && !mark; y++)
      for (let x = 18; x <= 62 && !mark; x++)
        if (!isWhite(png.at(x, y))) mark = true;
    expect(mark).toBe(true);                        // placeholder boxes leave visible marks
    expect(isWhite(png.at(150, 40))).toBe(true);    // far from text → background
  });
});

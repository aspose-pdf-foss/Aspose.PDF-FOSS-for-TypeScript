import { describe, it, expect } from 'vitest';
import { deflateSync } from 'node:zlib';
import { Document } from '../src/document.js';
import { buildSvgPdf } from './helpers/build-svg-fixtures.js';
import { buildInkTtf } from './helpers/build-sfnt.js';
import { decodePng } from './helpers/decode-png.js';

const near = (v: number, t: number, tol = 20) => Math.abs(v - t) <= tol;
const isRed = (px: [number, number, number, number]) => near(px[0], 255) && near(px[1], 0) && near(px[2], 0);
const isWhite = (px: [number, number, number, number]) => near(px[0], 255) && near(px[1], 255) && near(px[2], 255);

/** `/CIDToGIDMap` stream: two big-endian bytes per CID, `cid` alone → gid 1. */
function cidToGidMap(cid: number): Uint8Array {
  const map = new Uint8Array((cid + 1) * 2);
  map[cid * 2] = 0;
  map[cid * 2 + 1] = 1;
  return map;
}

describe('Page.ToImage — a composite font whose code is not its CID', () => {
  // The whole point of the fixture: /Encoding /UniJIS-UCS2-H maps the code
  // <3042> to CID 843, and /CIDToGIDMap sends CID 843 (and nothing else) to the
  // ink box at gid 1. Selecting the glyph with the code instead of the CID
  // lands on entry 0x3042 of the map, which is past its end — no ink at all.
  const CODE = 0x3042;
  const CID = 843;
  const ttf = buildInkTtf();
  const ff2 = deflateSync(Buffer.from(ttf));
  const c2g = deflateSync(Buffer.from(cidToGidMap(CID)));

  const build = (encoding: string) => Document.Open(buildSvgPdf({
    mediaBox: [0, 0, 200, 200],
    resources: '<< /Font << /F0 5 0 R >> >>',
    content: 'BT /F0 100 Tf 1 0 0 rg 50 50 Td <3042> Tj ET',
    extra: {
      5: `<< /Type /Font /Subtype /Type0 /BaseFont /Ink /Encoding ${encoding} /DescendantFonts [6 0 R] >>`,
      6: '<< /Type /Font /Subtype /CIDFontType2 /BaseFont /Ink /CIDSystemInfo << /Registry (Adobe) /Ordering (Japan1) /Supplement 6 >> /FontDescriptor 7 0 R /CIDToGIDMap 9 0 R /DW 1000 >>',
      7: '<< /Type /FontDescriptor /FontName /Ink /Flags 4 /FontBBox [0 -200 1000 800] /ItalicAngle 0 /Ascent 800 /Descent -200 /StemV 80 /FontFile2 8 0 R >>',
      8: { dict: `<< /Filter /FlateDecode /Length ${ff2.length} /Length1 ${ttf.length} >>`, raw: ff2 },
      9: { dict: `<< /Filter /FlateDecode /Length ${c2g.length} >>`, raw: c2g },
    },
  }));

  it('draws the glyph the CMap selects', () => {
    const png = decodePng(build('/UniJIS-UCS2-H').Pages[0].ToImage());
    expect(isRed(png.at(100, 115))).toBe(true);   // centre of the ink box
    expect(isRed(png.at(70, 90))).toBe(true);      // upper-left of the box
    expect(isWhite(png.at(30, 30))).toBe(true);    // background
    expect(isWhite(png.at(170, 170))).toBe(true);
  });

  it('draws nothing for the same bytes under Identity, where the CID is the code', () => {
    // The control: Identity-H makes the CID 0x3042, which the map does not
    // reach, so the page stays blank. This is what the file above would render
    // as if the code were used to select the glyph.
    const png = decodePng(build('/Identity-H').Pages[0].ToImage());
    expect(isWhite(png.at(100, 115))).toBe(true);
    expect(isWhite(png.at(70, 90))).toBe(true);
  });

  it('embeds one HTML glyph for two codes that share a CID', () => {
    // The HTML font embedder assigns a rendering codepoint per *glyph id*, so
    // two codes that the CMap sends to one CID must come out as one character
    // repeated. Selecting by code instead gives them two different glyph ids
    // and two different characters — a difference invisible in the rendered
    // page but baked into the subset font and the markup.
    const cmap =
      '/CIDInit /ProcSet findresource begin 12 dict begin begincmap\n' +
      '/CMapName /Two-To-One def /CMapType 1 def\n' +
      '1 begincodespacerange\n<00> <FF>\nendcodespacerange\n' +
      '2 begincidrange\n<41> <41> 5\n<42> <42> 5\nendcidrange\n' +
      'endcmap end end\n';
    // Distinct gids at CIDs 0x41/0x42, so the buggy lookup lands somewhere real
    // and produces two characters rather than collapsing by accident.
    const map = new Uint8Array(0x43 * 2);
    map[5 * 2 + 1] = 1;
    map[0x41 * 2 + 1] = 2;
    map[0x42 * 2 + 1] = 3;
    const c2gWide = deflateSync(Buffer.from(map));
    const cm = deflateSync(Buffer.from(new TextEncoder().encode(cmap)));

    const html = Document.Open(buildSvgPdf({
      mediaBox: [0, 0, 200, 200],
      resources: '<< /Font << /F0 5 0 R >> >>',
      content: 'BT /F0 100 Tf 1 0 0 rg 50 50 Td <4142> Tj ET',
      extra: {
        5: '<< /Type /Font /Subtype /Type0 /BaseFont /Ink /Encoding 10 0 R /DescendantFonts [6 0 R] >>',
        // Ordering Identity, so no CID->Unicode table applies and every glyph
        // renders from a Private-Use codepoint. What is under test is glyph
        // *selection*, and PUA assignment is per glyph id, which is what makes
        // "two codes, one CID" observable in the markup at all.
        6: '<< /Type /Font /Subtype /CIDFontType2 /BaseFont /Ink /CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> /FontDescriptor 7 0 R /CIDToGIDMap 9 0 R /DW 1000 >>',
        7: '<< /Type /FontDescriptor /FontName /Ink /Flags 4 /FontBBox [0 -200 1000 800] /ItalicAngle 0 /Ascent 800 /Descent -200 /StemV 80 /FontFile2 8 0 R >>',
        8: { dict: `<< /Filter /FlateDecode /Length ${ff2.length} /Length1 ${ttf.length} >>`, raw: ff2 },
        9: { dict: `<< /Filter /FlateDecode /Length ${c2gWide.length} >>`, raw: c2gWide },
        10: { dict: `<< /Type /CMap /CMapName /Two-To-One /Filter /FlateDecode /Length ${cm.length} >>`, raw: cm },
      },
    })).Pages[0].ToHtml({ mode: 'fixed', fonts: 'embed' });

    expect(html).toContain('@font-face');
    // The font has no /ToUnicode, so every glyph renders from a Private-Use
    // codepoint. One CID must mean one such codepoint.
    const pua = new Set([...html].map((c) => c.codePointAt(0) ?? 0)
      .filter((c) => c >= 0xe000 && c <= 0xf8ff));
    expect([...pua].length).toBe(1);
  });

  it('extracts the character with no /ToUnicode, via /CIDSystemInfo', () => {
    // This font has no /ToUnicode at all. The /Encoding CMap turns the code
    // <3042> into Adobe-Japan1 CID 843, and Adobe's table for that collection
    // turns 843 back into あ — the two halves meeting.
    expect(build('/UniJIS-UCS2-H').Pages[0].GetText()).toBe('あ');
  });
});

import { describe, it, expect } from 'vitest';
import { deflateSync } from 'node:zlib';
import { Document } from '../src/document.js';
import { buildSvgPdf } from './helpers/build-svg-fixtures.js';
import { buildInkTtf } from './helpers/build-sfnt.js';
import { decodePng } from './helpers/decode-png.js';

/**
 * The epic's acceptance check (z6wd): a CJK document whose fonts name a
 * predefined `/Encoding` and carry no `/ToUnicode` must extract its text and
 * render its glyphs, for at least one CMap from each of Adobe-Japan1,
 * Adobe-GB1, Adobe-CNS1 and Adobe-Korea1.
 *
 * Three separately-built things have to agree for one of these to pass: the
 * bundled predefined CMap (code -> CID), the `/CIDToGIDMap` (CID -> glyph), and
 * Adobe's collection table (CID -> Unicode). Getting the character out means
 * the first and third agree; getting ink on the page means the first and second
 * do. A test that only extracted could pass with the CMap wrong in a way that
 * cancelled out against the table, since both are keyed by CID.
 */

const near = (v: number, t: number, tol = 20) => Math.abs(v - t) <= tol;
const isRed = (px: [number, number, number, number]) => near(px[0], 255) && near(px[1], 0) && near(px[2], 0);
const isWhite = (px: [number, number, number, number]) => near(px[0], 255) && near(px[1], 255) && near(px[2], 255);

const ttf = buildInkTtf();
const ff2 = deflateSync(Buffer.from(ttf));

/** `/CIDToGIDMap` sending exactly `cid` to the ink glyph at gid 1. */
function cidToGidMap(cid: number): Buffer {
  const map = new Uint8Array((cid + 1) * 2);
  map[cid * 2 + 1] = 1;
  return deflateSync(Buffer.from(map));
}

interface Case {
  collection: string;
  ordering: string;
  supplement: number;
  cmap: string;
  /** The show-string bytes, as PDF hex-string content. */
  hex: string;
  cid: number;
  text: string;
}

/** One CMap per collection, with ground truth taken from the Adobe resources. */
const CASES: Case[] = [
  { collection: 'Adobe-Japan1', ordering: 'Japan1', supplement: 6, cmap: 'UniJIS-UCS2-H', hex: '3042', cid: 843, text: 'あ' },
  { collection: 'Adobe-Japan1 (Shift-JIS)', ordering: 'Japan1', supplement: 6, cmap: '90ms-RKSJ-H', hex: '82a0', cid: 843, text: 'あ' },
  { collection: 'Adobe-GB1', ordering: 'GB1', supplement: 5, cmap: 'UniGB-UCS2-H', hex: '4e00', cid: 4162, text: '一' },
  { collection: 'Adobe-CNS1', ordering: 'CNS1', supplement: 7, cmap: 'UniCNS-UCS2-H', hex: '4e00', cid: 595, text: '一' },
  { collection: 'Adobe-CNS1 (Big5)', ordering: 'CNS1', supplement: 7, cmap: 'ETen-B5-H', hex: 'a440', cid: 595, text: '一' },
  { collection: 'Adobe-Korea1', ordering: 'Korea1', supplement: 2, cmap: 'UniKS-UCS2-H', hex: 'ac00', cid: 1086, text: '가' },
];

function build(c: Case): Document {
  const c2g = cidToGidMap(c.cid);
  return Document.Open(buildSvgPdf({
    mediaBox: [0, 0, 200, 200],
    resources: '<< /Font << /F0 5 0 R >> >>',
    content: `BT /F0 100 Tf 1 0 0 rg 50 50 Td <${c.hex}> Tj ET`,
    extra: {
      // No /ToUnicode anywhere: the collection table is the only route to text.
      5: `<< /Type /Font /Subtype /Type0 /BaseFont /Ink /Encoding /${c.cmap} /DescendantFonts [6 0 R] >>`,
      6: `<< /Type /Font /Subtype /CIDFontType2 /BaseFont /Ink /CIDSystemInfo << /Registry (Adobe) /Ordering (${c.ordering}) /Supplement ${c.supplement} >> /FontDescriptor 7 0 R /CIDToGIDMap 9 0 R /DW 1000 >>`,
      7: '<< /Type /FontDescriptor /FontName /Ink /Flags 4 /FontBBox [0 -200 1000 800] /ItalicAngle 0 /Ascent 800 /Descent -200 /StemV 80 /FontFile2 8 0 R >>',
      8: { dict: `<< /Filter /FlateDecode /Length ${ff2.length} /Length1 ${ttf.length} >>`, raw: ff2 },
      9: { dict: `<< /Filter /FlateDecode /Length ${c2g.length} >>`, raw: c2g },
    },
  }));
}

describe('a CJK document with a predefined /Encoding and no /ToUnicode', () => {
  for (const c of CASES) {
    it(`extracts and renders through ${c.cmap} (${c.collection})`, () => {
      const doc = build(c);

      // Extraction: code -> CID -> Unicode.
      expect(doc.Pages[0].GetText()).toBe(c.text);

      // Rendering: code -> CID -> glyph. The map sends only this CID to the ink
      // glyph, so ink on the page means the CMap produced the CID we expect.
      const png = decodePng(doc.Pages[0].ToImage());
      expect(isRed(png.at(100, 115)), 'centre of the glyph box').toBe(true);
      expect(isWhite(png.at(20, 20)), 'background').toBe(true);
    });
  }

  it('puts the same character on every surface', () => {
    // GetText, the positioned fragments and the SVG text all read the same.
    const doc = build(CASES[0]);
    expect(doc.Pages[0].GetTextFragments().map((f) => f.text)).toEqual(['あ']);
    expect(doc.Pages[0].ToSvg()).toContain('あ');
  });

  it('finds the text by search', () => {
    expect(build(CASES[2]).Pages[0].Search('一').length).toBe(1);
  });
});

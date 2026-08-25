import { describe, it, expect } from 'vitest';
import { parseSfnt } from '../src/sfnt.js';
import { buildMinimalTtf, makeOttoWithCff, buildCompositeTtf } from './helpers/build-sfnt.js';
import { wrapWoff1, wrapWoff2Null, wrapWoff2Transformed } from './helpers/build-woff.js';
import { reconstructGlyfForTest, reconstructHmtxForTest } from '../src/woff.js';
import { Document } from '../src/document.js';
import { UnsupportedFeatureError, PdfParseError } from '../src/errors.js';
import { buildStampTarget } from './helpers/build-stamp-target.js';
import { brotliCompressSync } from 'node:zlib';

/** Assert two fonts agree on glyph count, cmap, advances, and every outline. */
function expectSameFont(a: ReturnType<typeof parseSfnt>, b: ReturnType<typeof parseSfnt>) {
  expect(a.numGlyphs).toBe(b.numGlyphs);
  expect([...a.cmap.entries()].sort()).toEqual([...b.cmap.entries()].sort());
  for (let g = 0; g < b.numGlyphs; g++) {
    expect(a.advanceWidth(g)).toBe(b.advanceWidth(g));
    expect(a.glyphOutline(g)).toEqual(b.glyphOutline(g));
  }
}

describe('WOFF (v1) ingestion', () => {
  it('round-trips a glyf TrueType font', () => {
    const ttf = buildMinimalTtf();
    const src = parseSfnt(ttf);
    const back = parseSfnt(wrapWoff1(ttf));
    expect(back.outlines).toBe('glyf');
    expectSameFont(back, src);
  });

  it('round-trips a CFF (OTTO) font', () => {
    const otto = makeOttoWithCff();
    const back = parseSfnt(wrapWoff1(otto));
    expect(back.outlines).toBe('cff');
    expect(back.numGlyphs).toBe(parseSfnt(otto).numGlyphs);
  });
});

describe('WOFF2 ingestion — null transform', () => {
  it('round-trips a glyf font (verbatim glyf/loca)', () => {
    const ttf = buildMinimalTtf();
    const src = parseSfnt(ttf);
    const back = parseSfnt(wrapWoff2Null(ttf));
    expect(back.outlines).toBe('glyf');
    expectSameFont(back, src);
  });

  it('round-trips a CFF (OTTO) font', () => {
    const otto = makeOttoWithCff();
    const back = parseSfnt(wrapWoff2Null(otto));
    expect(back.outlines).toBe('cff');
    expect(back.numGlyphs).toBe(parseSfnt(otto).numGlyphs);
  });
});

describe('WOFF2 ingestion — glyf transform', () => {
  it('reconstructs transformed glyf equal to source and to null decode', () => {
    const ttf = buildCompositeTtf();        // gid0 empty, gid1 real simple, gid2 real composite->1
    const src = parseSfnt(ttf);
    const viaTransform = parseSfnt(wrapWoff2Transformed(ttf));
    const viaNull = parseSfnt(wrapWoff2Null(ttf));
    expect(viaTransform.outlines).toBe('glyf');
    expectSameFont(viaTransform, src);
    for (let g = 0; g < src.numGlyphs; g++) {
      expect(viaTransform.glyphOutline(g)).toEqual(viaNull.glyphOutline(g));
    }
  });

  it('golden: reconstructs a hand-built simple + composite sub-stream to exact glyf bytes', () => {
    // numGlyphs=3: gid0 empty, gid1 simple 1-contour 1-point at (10,20) on-curve,
    // gid2 composite -> gid1 (flags ARGS_XY, dx=0 dy=0, no MORE, no instructions).
    const nContour = Uint8Array.from([0x00, 0x00, 0x00, 0x01, 0xff, 0xff]); // 0, 1, -1
    const nPoints = Uint8Array.from([0x01]);                                // gid1: 1 point in its single contour
    // Triplet 4-byte form: flag = 124 | xSign(1) | ySign(2) = 127; on-curve (bit7 clear).
    const flagStream = Uint8Array.from([127]);
    const glyphStream = Uint8Array.from([0x00, 0x0a, 0x00, 0x14, 0x00]);    // dx=10, dy=20 + instrLen(255UShort)=0
    // composite component record: flags=0x0002 (ARGS_XY), glyphIndex=1, dx=0,dy=0 (bytes since ARG_WORDS unset)
    const composite = Uint8Array.from([0x00, 0x02, 0x00, 0x01, 0x00, 0x00]);
    // bbox bitmap: 3 glyphs -> 1 byte. Set bit for gid1 and gid2 (0x40|0x20 = 0x60). Values follow.
    const bboxBitmap = Uint8Array.from([0x60]);
    const bboxValues = Uint8Array.from([
      0x00, 0x0a, 0x00, 0x14, 0x00, 0x0a, 0x00, 0x14, // gid1 bbox 10,20,10,20
      0x00, 0x00, 0x00, 0x00, 0x00, 0x0a, 0x00, 0x14, // gid2 bbox 0,0,10,20
    ]);
    const bbox = new Uint8Array(bboxBitmap.length + bboxValues.length);
    bbox.set(bboxBitmap); bbox.set(bboxValues, bboxBitmap.length);
    const instr = new Uint8Array(0);

    const header = new Uint8Array(36);
    const hv = new DataView(header.buffer);
    hv.setUint16(0, 0);   // reserved
    hv.setUint16(2, 0);   // optionFlags
    hv.setUint16(4, 3);   // numGlyphs
    hv.setUint16(6, 0);   // indexFormat (short)
    hv.setUint32(8, nContour.length);
    hv.setUint32(12, nPoints.length);
    hv.setUint32(16, flagStream.length);
    hv.setUint32(20, glyphStream.length);
    hv.setUint32(24, composite.length);
    hv.setUint32(28, bbox.length);
    hv.setUint32(32, instr.length);
    const data = new Uint8Array(
      header.length + nContour.length + nPoints.length + flagStream.length +
      glyphStream.length + composite.length + bbox.length + instr.length);
    let o = 0;
    for (const part of [header, nContour, nPoints, flagStream, glyphStream, composite, bbox, instr]) { data.set(part, o); o += part.length; }

    const { glyf, loca, indexFormat } = reconstructGlyfForTest(data);
    expect(indexFormat).toBe(0);

    // Expected gid1 simple glyph: numContours=1, bbox 10,20,10,20, endPts[0]=0,
    // instrLen=0, then the compact encoding of the single point — both deltas fit
    // a byte, so the flag carries ON_CURVE|SHORT_X|SAME_X|SHORT_Y|SAME_Y.
    const g1 = Uint8Array.from([
      0x00, 0x01, 0x00, 0x0a, 0x00, 0x14, 0x00, 0x0a, 0x00, 0x14,
      0x00, 0x00,             // endPts[0]=0
      0x00, 0x00,             // instrLen=0
      0x37,                   // flag: 0x01|0x02|0x10|0x04|0x20
      0x0a,                   // x=+10
      0x14,                   // y=+20
    ]);
    // Expected gid2 composite: numContours=-1, bbox 0,0,10,20, then component verbatim.
    const g2 = Uint8Array.from([
      0xff, 0xff, 0x00, 0x00, 0x00, 0x00, 0x00, 0x0a, 0x00, 0x14,
      0x00, 0x02, 0x00, 0x01, 0x00, 0x00, // component (no MORE, no instructions)
    ]);
    const pad = (b: Uint8Array): Uint8Array => { if (b.length % 2 === 0) return b; const p = new Uint8Array(b.length + 1); p.set(b); return p; };
    const g1p = pad(g1), g2p = pad(g2);
    const expectedGlyf = new Uint8Array(g1p.length + g2p.length);
    expectedGlyf.set(g1p, 0); expectedGlyf.set(g2p, g1p.length);
    expect([...glyf]).toEqual([...expectedGlyf]);

    // loca (short): [0, 0, len(g1p), len(g1p)+len(g2p)] / 2
    const lv = new DataView(loca.buffer, loca.byteOffset, loca.byteLength);
    expect(lv.getUint16(0)).toBe(0);
    expect(lv.getUint16(2)).toBe(0);
    expect(lv.getUint16(4)).toBe(g1p.length / 2);
    expect(lv.getUint16(6)).toBe((g1p.length + g2p.length) / 2);
  });
});

describe('WOFF2 ingestion — errors, hmtx, end-to-end', () => {
  it('throws UnsupportedFeatureError for a transformed non-glyf table', () => {
    // Hand-forge a minimal WOFF2 whose single table is a transformed 'cmap'
    // (transformVersion 1 on a non-glyf/loca table => transformed => unsupported).
    const stream = Uint8Array.from([1, 2, 3, 4]);
    const comp = new Uint8Array(brotliCompressSync(Buffer.from(stream)));
    const header = new Uint8Array(48);
    const hv = new DataView(header.buffer);
    hv.setUint32(0, 0x774f4632); // 'wOF2'
    hv.setUint32(4, 0x00010000); // flavor
    hv.setUint16(12, 1);         // numTables
    hv.setUint32(20, comp.length); // totalCompressedSize (header offset 20)
    // directory: flags = (1<<6)|0 (cmap index 0, transformVersion 1), origLen=4, transformLen=4
    const dir = Uint8Array.from([(1 << 6) | 0, 4, 4]);
    const woff2 = new Uint8Array(header.length + dir.length + comp.length);
    woff2.set(header); woff2.set(dir, header.length); woff2.set(comp, header.length + dir.length);
    expect(() => parseSfnt(woff2)).toThrow(UnsupportedFeatureError);
  });

  it('throws PdfParseError on a truncated WOFF2 stream', () => {
    const good = wrapWoff2Null(buildCompositeTtf());
    const truncated = good.subarray(0, good.length - 5); // chop the brotli tail
    expect(() => parseSfnt(truncated)).toThrow(PdfParseError);
  });

  it('golden: reconstructs hmtx (lsb absent) from glyph xMins', () => {
    // numGlyphs=3, numHMetrics=3, flags bit0 set (lsb absent) -> lsb = xMin.
    // advances 500,600,700; xMins from glyf: 10, 0, -5.
    const transformed = Uint8Array.from([
      0x01,                   // flags: bit0 lsb absent
      0x01, 0xf4,             // advance 500
      0x02, 0x58,             // advance 600
      0x02, 0xbc,             // advance 700
    ]);
    const hmtx = reconstructHmtxForTest(transformed, 3, 3, [10, 0, -5]);
    const v = new DataView(hmtx.buffer, hmtx.byteOffset, hmtx.byteLength);
    expect(v.getUint16(0)).toBe(500); expect(v.getInt16(2)).toBe(10);
    expect(v.getUint16(4)).toBe(600); expect(v.getInt16(6)).toBe(0);
    expect(v.getUint16(8)).toBe(700); expect(v.getInt16(10)).toBe(-5);
  });

  it('AddFont accepts a WOFF2 (transformed) end-to-end through Save/Open', () => {
    const doc = Document.Open(buildStampTarget());
    const font = doc.AddFont(wrapWoff2Transformed(buildCompositeTtf()));
    doc.Pages[0].AddText('AB', 20, 50, { font }); // cmap: A->gid1, B->gid2
    const reopened = Document.Open(doc.Save());
    expect(reopened.Pages[0].GetText()).toContain('AB');
  });
});

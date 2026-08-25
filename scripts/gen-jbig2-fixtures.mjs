// Dev-only tool: mints the JBIG2 end-to-end PDF fixtures for test/jbig2.test.ts.
// NOT shipped, NOT imported by src/ or tests. Run: `node scripts/gen-jbig2-fixtures.mjs`.
//
// Builds tiny 1-page PDFs whose single image XObject is JBIG2-coded, from known
// bitmaps, using the encoder in jbig2-codec.mjs. `jbig2enc` would be an
// independent reference; when it is not on PATH this built-in encoder keeps the
// suite self-contained. Expected `*_samples` are computed straight from the
// known bitmap (packInvert), so the test is a real known-bitmap round-trip.

import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  MqEncoder, MqDecoder, encodeGeneric, encodeSymbolDict, encodeTextRegion,
  decodeTextRegion, packInvert, encodeRefinement,
  encodePatternDict, encodeGrayscale,
} from './jbig2-codec.mjs';

const u32 = (n) => [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
const u16 = (n) => [(n >> 8) & 0xff, n & 0xff];

// ---- JBIG2 segment / region serialization ------------------------------------
function segHeader(segNum, type, referred, pageAssoc, dataLen) {
  const out = [...u32(segNum), type & 0x3f, (referred.length << 5) & 0xff];
  const refSize = segNum <= 256 ? 1 : segNum <= 65536 ? 2 : 4;
  for (const r of referred) out.push(...(refSize === 1 ? [r & 0xff] : refSize === 2 ? u16(r) : u32(r)));
  out.push(pageAssoc & 0xff, ...u32(dataLen));
  return out;
}
function genericRegionData(w, h, x, y, combOp, template, at, tpgdon, arith) {
  const flags = (tpgdon ? 8 : 0) | ((template & 3) << 1); // mmr=0
  const out = [...u32(w), ...u32(h), ...u32(x), ...u32(y), combOp & 7, flags];
  for (const a of at) out.push(a.x & 0xff, a.y & 0xff);
  out.push(...arith);
  return out;
}
function symbolDictData(at, numEx, numNew, arith) {
  const out = [...u16(0)]; // flags: huffman0 refagg0 template0
  for (const a of at) out.push(a.x & 0xff, a.y & 0xff);
  out.push(...u32(numEx), ...u32(numNew), ...arith);
  return out;
}
function textRegionData(w, h, x, y, combOp, sbFlags, numInstances, arith) {
  return [...u32(w), ...u32(h), ...u32(x), ...u32(y), combOp & 7, ...u16(sbFlags), ...u32(numInstances), ...arith];
}
function refinementRegionData(w, h, x, y, combOp, template, at, tpgron, arith) {
  const flags = (template & 1) | (tpgron ? 2 : 0);
  const out = [...u32(w), ...u32(h), ...u32(x), ...u32(y), combOp & 7, flags];
  if ((template & 1) === 0) for (const a of at) out.push(a.x & 0xff, a.y & 0xff);
  out.push(...arith);
  return out;
}
const seg = (segNum, type, referred, data) => [...segHeader(segNum, type, referred, 1, data.length), ...data];

const AT0 = [{ x: 3, y: -1 }, { x: -3, y: -1 }, { x: 2, y: -2 }, { x: -2, y: -2 }];

// ---- known bitmaps -----------------------------------------------------------
const GW = 16, GH = 16;
const gbm = new Uint8Array(GW * GH);
for (let y = 0; y < GH; y++) for (let x = 0; x < GW; x++)
  gbm[y * GW + x] = (x === 0 || y === 0 || x === GW - 1 || y === GH - 1 || x === y) ? 1 : 0;
gbm.copyWithin(8 * GW, 7 * GW, 8 * GW);
gbm.copyWithin(9 * GW, 8 * GW, 9 * GW);

// Symbols exported by the dictionary come out in ascending height order: id0=bar, id1=plus.
const bar = { w: 4, h: 2, data: Uint8Array.from([1,1,1,1, 1,1,1,1]) };
const plus = { w: 3, h: 3, data: Uint8Array.from([0,1,0, 1,1,1, 0,1,0]) };
const TW = 12, TH = 6, SYM_CODE_LEN = 1;
// bar(id0) at S=1,T=1; plus(id1) at S=7,T=1 (curS advances 1->4 after bar; ids=3 -> 7).
const trStrips = [{ dt: 1, dfs: 1, syms: [{ id: 0, curt: 0 }, { id: 1, curt: 0, ids: 3 }] }];

// ---- encode JBIG2 payloads ---------------------------------------------------
function genGenericArith() { const e = new MqEncoder(); encodeGeneric(e, new Int8Array(1 << 16), gbm, GW, GH, 0, AT0, true); return Array.from(e.flush()); }
function genSymbolArith() { const e = new MqEncoder(); encodeSymbolDict(e, [bar, plus], 0, AT0); return Array.from(e.flush()); }
function genTextArith() { const e = new MqEncoder(); encodeTextRegion(e, trStrips, SYM_CODE_LEN, 1, 0); return Array.from(e.flush()); }

// region-info combOp default 0 (OR); text region flags: REFCORNER=1 (TOPLEFT) -> 0x10.
const genericArith = genGenericArith();
const genericRegion = genericRegionData(GW, GH, 0, 0, 0, 0, AT0, true, genericArith);
const genericStream = Uint8Array.from(seg(0, 38, [], genericRegion));
// The same region body under the INTERMEDIATE type (T.88 7.4): decoded and held
// for a later segment to consume, never composited onto the page.
const intermediateGenericStream = Uint8Array.from(seg(0, 36, [], genericRegion));
const sdData = symbolDictData(AT0, 2, 2, genSymbolArith());
const trData = textRegionData(TW, TH, 0, 0, 0, 0x10, 2, genTextArith());
const symtextStream = Uint8Array.from([...seg(0, 0, [], sdData), ...seg(1, 6, [0], trData)]);
// The same text region under the INTERMEDIATE type (T.88 7.4). The symbol
// dictionary is unchanged and still contributes no ink of its own.
const intermediateTextStream = Uint8Array.from([...seg(0, 0, [], sdData), ...seg(1, 4, [0], trData)]);
const globalsStream = Uint8Array.from(seg(0, 0, [], sdData));
const globalsImageStream = Uint8Array.from(seg(1, 6, [0], trData));

// Refinement fixtures. The target CLEARS two pixels the reference had set as
// well as adding two, so a decoder that combined instead of replacing cannot
// produce it — the cleared pixels would stay black.
const RFW = 16, RFH = 16;
const rfRef = new Uint8Array(RFW * RFH);
for (let y = 5; y <= 10; y++) for (let x = 5; x <= 10; x++) rfRef[y * RFW + x] = 1;
const rfTarget = Uint8Array.from(rfRef);
rfTarget[4 * RFW + 4] = 1; rfTarget[11 * RFW + 11] = 1; // added ink
rfTarget[5 * RFW + 5] = 0; rfTarget[10 * RFW + 10] = 0; // cleared ink
const REF_AT = [{ x: -1, y: -1 }, { x: -1, y: -1 }];
const refineArith = (() => {
  const e = new MqEncoder();
  encodeRefinement(e, new Int8Array(1 << 13), rfTarget, RFW, RFH, rfRef, RFW, RFH, 0, 0, 0, REF_AT, false);
  return Array.from(e.flush());
})();
const refineRefRegion = genericRegionData(RFW, RFH, 0, 0, 0, 0, AT0, true, (() => {
  const e = new MqEncoder(); encodeGeneric(e, new Int8Array(1 << 16), rfRef, RFW, RFH, 0, AT0, true); return Array.from(e.flush());
})());
// The reference is drawn onto the PAGE by an immediate generic region, then
// refined in place by a type-42 segment referring to nothing.
const refinePageStream = Uint8Array.from([
  ...seg(0, 38, [], refineRefRegion),
  ...seg(1, 42, [], refinementRegionData(RFW, RFH, 0, 0, 0, 0, REF_AT, false, refineArith)),
]);
// The reference is an INTERMEDIATE generic region (type 36), invisible to the
// page, consumed by a type-42 segment that refers to it.
const refineBufferStream = Uint8Array.from([
  ...seg(0, 36, [], refineRefRegion),
  ...seg(1, 42, [0], refinementRegionData(RFW, RFH, 0, 0, 0, 0, REF_AT, false, refineArith)),
]);
const refineSamples = packInvert(rfTarget, RFW, RFH);
const refineRefSamples = packInvert(rfRef, RFW, RFH);
// A text region with SBREFINE genuinely set: one plain instance of a 4x4 box
// and one refined into a solid 5x5. This is the only fixture that exercises the
// SBRAT header ordering — SBRAT sits between the text-region flags and
// SBNUMINSTANCES, so reading it late shifts the instance count by four bytes.
function textRegionRefineData(w, h, x, y, combOp, sbFlags, at, numInstances, arith) {
  const out = [...u32(w), ...u32(h), ...u32(x), ...u32(y), combOp & 7, ...u16(sbFlags)];
  for (const a of at) out.push(a.x & 0xff, a.y & 0xff); // SBRAT, BEFORE SBNUMINSTANCES
  out.push(...u32(numInstances), ...arith);
  return out;
}
const sbrBox = { w: 4, h: 4, data: Uint8Array.from([1,1,1,1, 1,0,0,1, 1,0,0,1, 1,1,1,1]) };
const sbrRefined = new Uint8Array(25).fill(1);
const SBRW = 16, SBRH = 8;
const sbrStrips = [{ dt: 1, dfs: 1, syms: [
  { id: 0, curt: 0 },
  { id: 0, curt: 0, ids: 4, refine: {
    rdw: 1, rdh: 1, rdx: 0, rdy: 0, w: 5, h: 5,
    target: sbrRefined, ref: sbrBox.data, refW: sbrBox.w, refH: sbrBox.h,
  } },
] }];
const sbrSdData = symbolDictData(AT0, 1, 1, (() => {
  const e = new MqEncoder(); encodeSymbolDict(e, [sbrBox], 0, AT0); return Array.from(e.flush());
})());
const sbrefineArith = (() => {
  const e = new MqEncoder(); encodeTextRegion(e, sbrStrips, 1, 1, 0, true, 0, REF_AT); return Array.from(e.flush());
})();
const sbrefineStream = Uint8Array.from([
  ...seg(0, 0, [], sbrSdData),
  ...seg(1, 6, [0], textRegionRefineData(SBRW, SBRH, 0, 0, 0, 0x12, REF_AT, 2, sbrefineArith)),
]);
const sbrefineSamples = packInvert(
  decodeTextRegion(new MqDecoder(Uint8Array.from(sbrefineArith), 0, sbrefineArith.length),
    SBRW, SBRH, 2, [sbrBox], 1, 1, 1, 0, 0, true, 0, REF_AT),
  SBRW, SBRH);

// Halftone: a pattern dictionary (type 16) followed by a halftone region.
// The grid vectors TILE EXACTLY (HRX = 256*HDPW, HRY = 0, origin 0), so the
// expected page is the value grid with each cell replaced by its pattern —
// derivable without a second copy of T.88's placement formula.
const HT_PW = 2, HT_PH = 2, HT_GW = 4, HT_GH = 4;
const htPatterns = [
  Uint8Array.from([0, 0, 0, 0]),
  Uint8Array.from([1, 0, 0, 0]),
  Uint8Array.from([1, 0, 0, 1]),
  Uint8Array.from([1, 1, 1, 1]),
];
const htValues = Int32Array.from([
  0, 1, 2, 3,
  3, 2, 1, 0,
  1, 3, 0, 2,
  2, 0, 3, 1,
]);
const HTW = HT_GW * HT_PW, HTH = HT_GH * HT_PH;
function patternDictData(mmr, template, pw, ph, grayMax, arith) {
  return [(mmr ? 1 : 0) | ((template & 3) << 1), pw & 0xff, ph & 0xff, ...u32(grayMax), ...arith];
}
function halftoneRegionData(w, h, x, y, combOp, flags, gw, gh, gx, gy, rx, ry, arith) {
  return [...u32(w), ...u32(h), ...u32(x), ...u32(y), combOp & 7, flags,
    ...u32(gw), ...u32(gh), ...u32(gx >>> 0), ...u32(gy >>> 0), ...u16(rx), ...u16(ry), ...arith];
}
const htPatternArith = (() => {
  const e = new MqEncoder();
  encodePatternDict(e, new Int8Array(1 << 16), htPatterns, HT_PW, HT_PH, 0);
  return Array.from(e.flush());
})();
const htGrayArith = (() => {
  const e = new MqEncoder();
  encodeGrayscale(e, new Int8Array(1 << 16), htValues, HT_GW, HT_GH, 2, 0, undefined);
  return Array.from(e.flush());
})();
const htPatternSeg = patternDictData(false, 0, HT_PW, HT_PH, htPatterns.length - 1, htPatternArith);
const htRegion = halftoneRegionData(HTW, HTH, 0, 0, 0, 0 /* HMMR=0, HTEMPLATE=0, no skip, OR, def 0 */,
  HT_GW, HT_GH, 0, 0, 256 * HT_PW, 0, htGrayArith);
const halftoneStream = Uint8Array.from([...seg(0, 16, [], htPatternSeg), ...seg(1, 22, [0], htRegion)]);
// The same region body under the INTERMEDIATE type (T.88 7.4): decoded and held
// for a later segment to consume, never composited onto the page.
const intermediateHalftoneStream = Uint8Array.from([...seg(0, 16, [], htPatternSeg), ...seg(1, 20, [0], htRegion)]);
const halftoneBitmap = (() => {
  const bm = new Uint8Array(HTW * HTH);
  for (let y = 0; y < HTH; y++) {
    for (let x = 0; x < HTW; x++) {
      const p = htPatterns[htValues[Math.floor(y / HT_PH) * HT_GW + Math.floor(x / HT_PW)]];
      bm[y * HTW + x] = p[(y % HT_PH) * HT_PW + (x % HT_PW)];
    }
  }
  return bm;
})();
const halftoneSamples = packInvert(halftoneBitmap, HTW, HTH);

// ---- expected decoded samples (known bitmap -> packInvert) --------------------
const genericSamples = packInvert(gbm, GW, GH);
// text-region page bitmap: decode our own text stream to the region, then pack.
const trReg = decodeTextRegion(new MqDecoder(Uint8Array.from(genTextArith()), 0, genTextArith().length), TW, TH, 2, [bar, plus], SYM_CODE_LEN, 1, 1, 0, 0);
const symtextSamples = packInvert(trReg, TW, TH);

// ---- PDF assembly (classic xref) ---------------------------------------------
const enc = (s) => new TextEncoder().encode(s);
function buildPdf(objs, maxObj) {
  const parts = []; let length = 0; const offsets = new Array(maxObj + 1).fill(0);
  const push = (u) => { parts.push(u); length += u.length; };
  push(enc('%PDF-1.7\n%\xE2\xE3\xCF\xD3\n'));
  for (let n = 1; n <= maxObj; n++) {
    const o = objs[n]; if (o === undefined) continue;
    offsets[n] = length;
    if (typeof o === 'string') push(enc(`${n} 0 obj\n${o}\nendobj\n`));
    else { push(enc(`${n} 0 obj\n${o.dict}\nstream\n`)); push(o.raw); push(enc('\nendstream\nendobj\n')); }
  }
  const xrefStart = length;
  let xref = `xref\n0 ${maxObj + 1}\n0000000000 65535 f \n`;
  for (let n = 1; n <= maxObj; n++) xref += `${String(offsets[n]).padStart(10, '0')} 00000 n \n`;
  push(enc(xref));
  push(enc(`trailer\n<< /Size ${maxObj + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`));
  const out = new Uint8Array(length); let off = 0; for (const p of parts) { out.set(p, off); off += p.length; }
  return out;
}

function simplePdf(w, h, jbig2) {
  const objs = [];
  objs[1] = '<< /Type /Catalog /Pages 2 0 R >>';
  objs[2] = `<< /Type /Pages /Count 1 /Kids [3 0 R] /MediaBox [0 0 ${w} ${h}] >>`;
  objs[3] = `<< /Type /Page /Parent 2 0 R /Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R /MediaBox [0 0 ${w} ${h}] >>`;
  objs[4] = { dict: `<< /Type /XObject /Subtype /Image /Width ${w} /Height ${h} /ColorSpace /DeviceGray /BitsPerComponent 1 /Filter /JBIG2Decode /Length ${jbig2.length} >>`, raw: jbig2 };
  const content = enc(`q ${w} 0 0 ${h} 0 0 cm /Im0 Do Q`);
  objs[5] = { dict: `<< /Length ${content.length} >>`, raw: content };
  return buildPdf(objs, 5);
}
function globalsPdf(w, h, image, globals) {
  const objs = [];
  objs[1] = '<< /Type /Catalog /Pages 2 0 R >>';
  objs[2] = `<< /Type /Pages /Count 1 /Kids [3 0 R] /MediaBox [0 0 ${w} ${h}] >>`;
  objs[3] = `<< /Type /Page /Parent 2 0 R /Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R /MediaBox [0 0 ${w} ${h}] >>`;
  objs[4] = { dict: `<< /Type /XObject /Subtype /Image /Width ${w} /Height ${h} /ColorSpace /DeviceGray /BitsPerComponent 1 /Filter /JBIG2Decode /DecodeParms << /JBIG2Globals 6 0 R >> /Length ${image.length} >>`, raw: image };
  const content = enc(`q ${w} 0 0 ${h} 0 0 cm /Im0 Do Q`);
  objs[5] = { dict: `<< /Length ${content.length} >>`, raw: content };
  objs[6] = { dict: `<< /Length ${globals.length} >>`, raw: globals };
  return buildPdf(objs, 6);
}

const generic_pdf = simplePdf(GW, GH, genericStream);
const symtext_pdf = simplePdf(TW, TH, symtextStream);
const globals_pdf = globalsPdf(TW, TH, globalsImageStream, globalsStream);

const b64 = (u8) => Buffer.from(u8).toString('base64');
const out = `// GENERATED by scripts/gen-jbig2-fixtures.mjs — do not edit by hand.
// Regenerate: node scripts/gen-jbig2-fixtures.mjs
/* eslint-disable */
function b64(s: string): Uint8Array { return Uint8Array.from(Buffer.from(s, "base64")); }
export const generic_pdf: Uint8Array = b64(${JSON.stringify(b64(generic_pdf))});
export const generic_samples: Uint8Array = b64(${JSON.stringify(b64(genericSamples))});
export const generic_stream: Uint8Array = b64(${JSON.stringify(b64(genericStream))});
export const intermediate_generic_stream: Uint8Array = b64(${JSON.stringify(b64(intermediateGenericStream))});
export const symtext_pdf: Uint8Array = b64(${JSON.stringify(b64(symtext_pdf))});
export const symtext_samples: Uint8Array = b64(${JSON.stringify(b64(symtextSamples))});
export const symtext_stream: Uint8Array = b64(${JSON.stringify(b64(symtextStream))});
export const intermediate_text_stream: Uint8Array = b64(${JSON.stringify(b64(intermediateTextStream))});
export const refine_page_stream: Uint8Array = b64(${JSON.stringify(b64(refinePageStream))});
export const refine_buffer_stream: Uint8Array = b64(${JSON.stringify(b64(refineBufferStream))});
export const refine_samples: Uint8Array = b64(${JSON.stringify(b64(refineSamples))});
export const refine_ref_samples: Uint8Array = b64(${JSON.stringify(b64(refineRefSamples))});
export const sbrefine_stream: Uint8Array = b64(${JSON.stringify(b64(sbrefineStream))});
export const sbrefine_samples: Uint8Array = b64(${JSON.stringify(b64(sbrefineSamples))});
export const halftone_stream: Uint8Array = b64(${JSON.stringify(b64(halftoneStream))});
export const intermediate_halftone_stream: Uint8Array = b64(${JSON.stringify(b64(intermediateHalftoneStream))});
export const halftone_samples: Uint8Array = b64(${JSON.stringify(b64(halftoneSamples))});
export const globals_pdf: Uint8Array = b64(${JSON.stringify(b64(globals_pdf))});
export const globals_samples: Uint8Array = b64(${JSON.stringify(b64(symtextSamples))});
export const dims = { generic: [${GW}, ${GH}], symtext: [${TW}, ${TH}], globals: [${TW}, ${TH}], halftone: [${HTW}, ${HTH}] } as const;
`;

const dir = dirname(fileURLToPath(import.meta.url));
const target = join(dir, '..', 'test', 'helpers', 'jbig2-fixtures.ts');
writeFileSync(target, out);
console.log('wrote', target);

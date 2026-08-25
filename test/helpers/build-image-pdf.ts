import { deflateSync } from 'node:zlib';

const enc = (s: string) => new TextEncoder().encode(s);

export type Obj = string | { dict: string; raw: Uint8Array };

function concat(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) { out.set(p, off); off += p.length; }
  return out;
}

/** Build a 1-page classic-xref PDF carrying several image XObjects:
 *  Im0 (2x2 DeviceRGB Flate), Dct0 (DCTDecode + SMask), Fm0 (Form containing
 *  ImF, a 2x2 DeviceGray Flate image), Msk0 (/ImageMask Flate), Jb0 (an 8x8
 *  JBIG2Decode arithmetic generic region). Object 10 is Dct0's SMask (only
 *  reachable via the image dict, so it must NOT be enumerated). */
export function buildImagePdf(): {
  bytes: Uint8Array;
  rgbSamples: Uint8Array; // expected Im0 decoded samples
  jpegBytes: Uint8Array;  // Dct0 raw == decode (passthrough)
  jbig2Samples: Uint8Array; // expected Jb0 decoded 1-bpp samples
} {
  const rgbSamples = Uint8Array.from([255, 0, 0, 0, 255, 0, 0, 0, 255, 255, 255, 0]);
  const rgbRaw = new Uint8Array(deflateSync(Buffer.from(rgbSamples)));
  const graySamples = Uint8Array.from([0, 128, 255, 64]);
  const grayRaw = new Uint8Array(deflateSync(Buffer.from(graySamples)));
  const jpegBytes = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 0xff, 0xd9]);
  const maskRaw = new Uint8Array(deflateSync(Buffer.from(Uint8Array.from([0b10000000, 0b01000000]))));
  const smaskRaw = new Uint8Array(deflateSync(Buffer.from(Uint8Array.from([10, 20, 30, 40]))));
  // Jb0: an 8x8 JBIG2 arithmetic generic region (one immediate-generic segment),
  // minted offline by scripts/gen-jbig2-fixtures.mjs' codec. jbig2Samples is the
  // expected decoded 1-bpp output (MSB-first, bit-inverted).
  const jbig2Raw = Uint8Array.from([0,0,0,0,38,0,1,0,0,0,34,0,0,0,8,0,0,0,8,0,0,0,0,0,0,0,0,0,0,3,255,253,255,2,254,254,254,222,49,15,16,208,221,99,85]);
  const jbig2Samples = Uint8Array.from([42, 21, 138, 69, 162, 81, 168, 84]);
  const contentRaw = enc('q 1 0 0 1 0 0 cm /Im0 Do Q');

  const objs: Obj[] = [];
  objs[1] = `<< /Type /Catalog /Pages 2 0 R >>`;
  objs[2] = `<< /Type /Pages /Count 1 /Kids [3 0 R] /MediaBox [0 0 200 200] >>`;
  objs[3] = `<< /Type /Page /Parent 2 0 R /Resources << /XObject << /Im0 4 0 R /Dct0 5 0 R /Fm0 6 0 R /Msk0 8 0 R /Jb0 9 0 R >> >> /Contents 11 0 R >>`;
  objs[4] = { dict: `<< /Type /XObject /Subtype /Image /Width 2 /Height 2 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode /Length ${rgbRaw.length} >>`, raw: rgbRaw };
  objs[5] = { dict: `<< /Type /XObject /Subtype /Image /Width 4 /Height 4 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /SMask 10 0 R /Length ${jpegBytes.length} >>`, raw: jpegBytes };
  objs[6] = { dict: `<< /Type /XObject /Subtype /Form /BBox [0 0 1 1] /Resources << /XObject << /ImF 7 0 R >> >> /Length 0 >>`, raw: new Uint8Array(0) };
  objs[7] = { dict: `<< /Type /XObject /Subtype /Image /Width 2 /Height 2 /ColorSpace /DeviceGray /BitsPerComponent 8 /Filter /FlateDecode /Length ${grayRaw.length} >>`, raw: grayRaw };
  objs[8] = { dict: `<< /Type /XObject /Subtype /Image /Width 2 /Height 2 /ImageMask true /Filter /FlateDecode /Length ${maskRaw.length} >>`, raw: maskRaw };
  objs[9] = { dict: `<< /Type /XObject /Subtype /Image /Width 8 /Height 8 /ColorSpace /DeviceGray /BitsPerComponent 1 /Filter /JBIG2Decode /Length ${jbig2Raw.length} >>`, raw: jbig2Raw };
  objs[10] = { dict: `<< /Type /XObject /Subtype /Image /Width 4 /Height 4 /ColorSpace /DeviceGray /BitsPerComponent 8 /Filter /FlateDecode /Length ${smaskRaw.length} >>`, raw: smaskRaw };
  objs[11] = { dict: `<< /Length ${contentRaw.length} >>`, raw: contentRaw };
  const maxObj = 11;

  const parts: Uint8Array[] = [];
  let length = 0;
  const push = (u: Uint8Array) => { parts.push(u); length += u.length; };
  const offsets: number[] = new Array(maxObj + 1).fill(0);

  push(enc('%PDF-1.7\n%âãÏÓ\n'));
  for (let n = 1; n <= maxObj; n++) {
    const o = objs[n];
    if (o === undefined) continue;
    offsets[n] = length;
    if (typeof o === 'string') {
      push(enc(`${n} 0 obj\n${o}\nendobj\n`));
    } else {
      push(enc(`${n} 0 obj\n${o.dict}\nstream\n`));
      push(o.raw);
      push(enc(`\nendstream\nendobj\n`));
    }
  }
  const xrefOffset = length;
  let xref = `xref\n0 ${maxObj + 1}\n0000000000 65535 f \n`;
  for (let n = 1; n <= maxObj; n++) xref += `${String(offsets[n]).padStart(10, '0')} 00000 n \n`;
  push(enc(xref));
  push(enc(`trailer\n<< /Size ${maxObj + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`));

  return { bytes: concat(parts), rgbSamples, jpegBytes, jbig2Samples };
}

/** Build a 1-page PDF carrying a single image XObject named `Im0`. `extra`
 *  supplies additional image-dict entries (verbatim PDF syntax, e.g.
 *  `/DecodeParms << /K -1 /Columns 8 >>`). */
export function buildSingleImagePdf(opts: {
  width: number; height: number; colorSpace: string; bits: number;
  filter: string; raw: Uint8Array; extra?: string;
}): Uint8Array {
  const { width, height, colorSpace, bits, filter, raw, extra = '' } = opts;
  const content = enc('q 1 0 0 1 0 0 cm /Im0 Do Q');
  const objs: Obj[] = [];
  objs[1] = `<< /Type /Catalog /Pages 2 0 R >>`;
  objs[2] = `<< /Type /Pages /Count 1 /Kids [3 0 R] /MediaBox [0 0 100 100] >>`;
  objs[3] = `<< /Type /Page /Parent 2 0 R /Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>`;
  objs[4] = { dict: `<< /Type /XObject /Subtype /Image /Width ${width} /Height ${height} /ColorSpace /${colorSpace} /BitsPerComponent ${bits} /Filter /${filter} ${extra} /Length ${raw.length} >>`, raw };
  objs[5] = { dict: `<< /Length ${content.length} >>`, raw: content };
  const maxObj = 5;

  const parts: Uint8Array[] = [];
  let length = 0;
  const push = (u: Uint8Array) => { parts.push(u); length += u.length; };
  const offsets: number[] = new Array(maxObj + 1).fill(0);
  push(enc('%PDF-1.7\n%âãÏÓ\n'));
  for (let n = 1; n <= maxObj; n++) {
    const o = objs[n];
    if (o === undefined) continue;
    offsets[n] = length;
    if (typeof o === 'string') push(enc(`${n} 0 obj\n${o}\nendobj\n`));
    else { push(enc(`${n} 0 obj\n${o.dict}\nstream\n`)); push(o.raw); push(enc(`\nendstream\nendobj\n`)); }
  }
  const xrefOffset = length;
  let xref = `xref\n0 ${maxObj + 1}\n0000000000 65535 f \n`;
  for (let n = 1; n <= maxObj; n++) xref += `${String(offsets[n]).padStart(10, '0')} 00000 n \n`;
  push(enc(xref));
  push(enc(`trailer\n<< /Size ${maxObj + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`));
  return concat(parts);
}

/** Build a 1-page PDF with a `width`×`height` DeviceRGB 8bpc Flate image `Im0`
 *  drawn once per entry in `placements` (each a `cm` operand string). */
export function buildPlacedImagePdf(opts: {
  width: number; height: number; samples: Uint8Array; // length width*height*3
  placements: string[]; mediaBox?: string;
}): Uint8Array {
  const { width, height, samples, placements, mediaBox = '0 0 100 100' } = opts;
  const rgbRaw = new Uint8Array(deflateSync(Buffer.from(samples)));
  const stream = placements.map((cm) => `q ${cm} cm /Im0 Do Q`).join(' ');
  const content = enc(stream);
  const objs: Obj[] = [];
  objs[1] = `<< /Type /Catalog /Pages 2 0 R >>`;
  objs[2] = `<< /Type /Pages /Count 1 /Kids [3 0 R] /MediaBox [${mediaBox}] >>`;
  objs[3] = `<< /Type /Page /Parent 2 0 R /Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>`;
  objs[4] = { dict: `<< /Type /XObject /Subtype /Image /Width ${width} /Height ${height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode /Length ${rgbRaw.length} >>`, raw: rgbRaw };
  objs[5] = { dict: `<< /Length ${content.length} >>`, raw: content };
  return emitObjs(objs, 5);
}

/** Build a 1-page PDF with a `width`×`height` DeviceRGB 8bpc Flate base image
 *  `Im0` carrying an /SMask soft mask (its own filter/raw/dims), drawn once per
 *  `placements` entry. Lets tests exercise DCT-encoded soft masks under redaction. */
export function buildPlacedImageWithSMaskPdf(opts: {
  width: number; height: number; samples: Uint8Array; // base RGB, length width*height*3
  smask: { width: number; height: number; filter: string; raw: Uint8Array; bits?: number };
  placements: string[]; mediaBox?: string;
}): Uint8Array {
  const { width, height, samples, smask, placements, mediaBox = '0 0 100 100' } = opts;
  const rgbRaw = new Uint8Array(deflateSync(Buffer.from(samples)));
  const content = enc(placements.map((cm) => `q ${cm} cm /Im0 Do Q`).join(' '));
  const bits = smask.bits ?? 8;
  const objs: Obj[] = [];
  objs[1] = `<< /Type /Catalog /Pages 2 0 R >>`;
  objs[2] = `<< /Type /Pages /Count 1 /Kids [3 0 R] /MediaBox [${mediaBox}] >>`;
  objs[3] = `<< /Type /Page /Parent 2 0 R /Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>`;
  objs[4] = { dict: `<< /Type /XObject /Subtype /Image /Width ${width} /Height ${height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode /SMask 6 0 R /Length ${rgbRaw.length} >>`, raw: rgbRaw };
  objs[5] = { dict: `<< /Length ${content.length} >>`, raw: content };
  objs[6] = { dict: `<< /Type /XObject /Subtype /Image /Width ${smask.width} /Height ${smask.height} /ColorSpace /DeviceGray /BitsPerComponent ${bits} /Filter /${smask.filter} /Length ${smask.raw.length} >>`, raw: smask.raw };
  return emitObjs(objs, 6);
}

/** Like buildSingleImagePdf but with an explicit placement `cm` and MediaBox. */
export function buildSingleImagePdfWithCm(opts: {
  width: number; height: number; colorSpace: string; bits: number;
  filter: string; raw: Uint8Array; extra?: string; cm: string; mediaBox?: string;
}): Uint8Array {
  const { width, height, colorSpace, bits, filter, raw, extra = '', cm, mediaBox = '0 0 100 100' } = opts;
  const content = enc(`q ${cm} cm /Im0 Do Q`);
  const objs: Obj[] = [];
  objs[1] = `<< /Type /Catalog /Pages 2 0 R >>`;
  objs[2] = `<< /Type /Pages /Count 1 /Kids [3 0 R] /MediaBox [${mediaBox}] >>`;
  objs[3] = `<< /Type /Page /Parent 2 0 R /Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>`;
  objs[4] = { dict: `<< /Type /XObject /Subtype /Image /Width ${width} /Height ${height} /ColorSpace /${colorSpace} /BitsPerComponent ${bits} /Filter /${filter} ${extra} /Length ${raw.length} >>`, raw };
  objs[5] = { dict: `<< /Length ${content.length} >>`, raw: content };
  return emitObjs(objs, 5);
}

/** Build a 1-page PDF placing a single image `Im0` whose `/ColorSpace` is an
 *  arbitrary verbatim token (name WITH leading slash, e.g. `/DeviceCMYK`, or an
 *  array literal, e.g. `[/Indexed /DeviceRGB 2 <000000ff000000ff00>]`). `samples`
 *  is the raw sample stream; the builder wraps it in FlateDecode. */
export function buildPlacedRawImagePdf(opts: {
  width: number; height: number; colorSpace: string; bits: number;
  samples: Uint8Array; cm: string; mediaBox?: string; extra?: string;
}): Uint8Array {
  const { width, height, colorSpace, bits, samples, cm, mediaBox = '0 0 100 100', extra = '' } = opts;
  const raw = new Uint8Array(deflateSync(Buffer.from(samples)));
  const content = enc(`q ${cm} cm /Im0 Do Q`);
  const objs: Obj[] = [];
  objs[1] = `<< /Type /Catalog /Pages 2 0 R >>`;
  objs[2] = `<< /Type /Pages /Count 1 /Kids [3 0 R] /MediaBox [${mediaBox}] >>`;
  objs[3] = `<< /Type /Page /Parent 2 0 R /Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>`;
  objs[4] = { dict: `<< /Type /XObject /Subtype /Image /Width ${width} /Height ${height} /ColorSpace ${colorSpace} /BitsPerComponent ${bits} /Filter /FlateDecode ${extra} /Length ${raw.length} >>`, raw };
  objs[5] = { dict: `<< /Length ${content.length} >>`, raw: content };
  return emitObjs(objs, 5);
}

/** Serialize a classic-xref single-page PDF from an object table (1..maxObj). */
export function emitObjs(objs: Obj[], maxObj: number): Uint8Array {
  const parts: Uint8Array[] = [];
  let length = 0;
  const push = (u: Uint8Array) => { parts.push(u); length += u.length; };
  const offsets: number[] = new Array(maxObj + 1).fill(0);
  push(enc('%PDF-1.7\n%âãÏÓ\n'));
  for (let n = 1; n <= maxObj; n++) {
    const o = objs[n];
    if (o === undefined) continue;
    offsets[n] = length;
    if (typeof o === 'string') push(enc(`${n} 0 obj\n${o}\nendobj\n`));
    else { push(enc(`${n} 0 obj\n${o.dict}\nstream\n`)); push(o.raw); push(enc(`\nendstream\nendobj\n`)); }
  }
  const xrefOffset = length;
  let xref = `xref\n0 ${maxObj + 1}\n0000000000 65535 f \n`;
  for (let n = 1; n <= maxObj; n++) xref += `${String(offsets[n]).padStart(10, '0')} 00000 n \n`;
  push(enc(xref));
  push(enc(`trailer\n<< /Size ${maxObj + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`));
  return concat(parts);
}

/** Minimal 9..12-bit LZW encoder (EarlyChange=1) for fixtures. */
export function lzwEncode(data: Uint8Array): Uint8Array {
  const out: number[] = [];
  let bitBuf = 0, bitCnt = 0, width = 9, next = 258;
  const dict = new Map<string, number>();
  for (let i = 0; i < 256; i++) dict.set(String.fromCharCode(i), i);
  const emit = (code: number) => {
    bitBuf = (bitBuf << width) | code; bitCnt += width;
    while (bitCnt >= 8) { bitCnt -= 8; out.push((bitBuf >> bitCnt) & 0xff); }
  };
  emit(256);
  let w = '';
  for (const b of data) {
    const c = String.fromCharCode(b);
    const wc = w + c;
    if (dict.has(wc)) { w = wc; }
    else { emit(dict.get(w)!); dict.set(wc, next++); w = c; if (next === (1 << width) - 1 && width < 12) width++; }
  }
  if (w !== '') emit(dict.get(w)!);
  emit(257);
  if (bitCnt > 0) out.push((bitBuf << (8 - bitCnt)) & 0xff);
  return Uint8Array.from(out);
}
